// Quick mode: test a site from nothing but its URL (and any files you drop in).
// Each site gets a workspace under ~/.ironprobe/sites/<host>, so visual baselines, history and the
// health-score trend build up run after run without any setup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { run } from './runner.js';
import { ConfigError } from './config.js';
import { detectKind } from './importers/har.js';
import { ensureBrowsers, ironprobeHome } from './browsers.js';

export { ironprobeHome };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOADS = 10;
const KEEP_RUNS = 20;

// Clean-up for runs in flight: Ctrl+C must not leave dropped files or a site lock behind.
const activeCleanups = new Set();
export function cleanupActiveRuns() {
  for (const fn of [...activeCleanups]) fn();
}

export function parseTarget(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new ConfigError('Paste the address of the site or app to test, for example https://myapp.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = /^(localhost|127\.|\[::1\])/i.test(text) ? `http://${text}` : `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new ConfigError(`"${String(raw).slice(0, 80)}" is not a web address.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('Only http and https addresses can be tested.');
  if (u.username || u.password) throw new ConfigError('Remove the user name and password from the address; IronProbe does not send them.');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost' && !u.hostname.startsWith('[')) throw new ConfigError(`Can't find "${u.hostname}". Check the spelling of the address (for example: example.com or localhost:3000).`);
  return u;
}

// The host you typed, plus its www / bare twin, because most sites redirect between the two.
export function hostsFor(u) {
  const hosts = [u.host];
  const labels = u.hostname.split('.');
  const apex = labels.length === 2 || (labels.length === 3 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[1]) && labels[2].length === 2);
  if (!/^(localhost|\d+\.\d+\.\d+\.\d+|\[)/.test(u.hostname) && (apex || u.hostname.startsWith('www.'))) {
    const twin = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    if (twin.includes('.')) hosts.push(u.port ? `${twin}:${u.port}` : twin);
  }
  return hosts;
}

export function siteSlug(u) {
  return u.host.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').slice(0, 80) || 'site';
}

// Deepest bracket nesting outside strings; a cheap guard before parsing untrusted files.
export function nestingDepth(text) {
  let depth = 0;
  let max = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') max = Math.max(max, ++depth);
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
  }
  return max;
}

// Postman files often point at another server (staging, an old port). In quick mode, variables that
// hold a full web address on another host are switched to the address you typed, and we say so.
function rebaseVars(list, vars, target, notes, fileName) {
  for (const v of list || []) {
    if (!v || typeof v.key !== 'string' || typeof v.value !== 'string') continue;
    let u;
    try {
      u = new URL(v.value);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.host === target.host) continue;
    const rebased = `${target.origin}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
    vars[v.key] = rebased;
    notes.push(`${fileName}: {{${v.key}}} pointed at ${u.host}, switched to ${target.host}`);
  }
}

function safeName(name, i) {
  const base = path.basename(String(name || `upload-${i}`)).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return base || `upload-${i}`;
}

// Saves dropped files and works out what each one is. Returns config entries and notes.
export function placeUploads(files, uploadDir, { allowWrites = false, target = null } = {}) {
  const vars = {};
  const api = [];
  const uiSuites = [];
  const notes = [];
  if (!files?.length) return { api, uiSuites, notes, vars };
  if (files.length > MAX_UPLOADS) throw new ConfigError(`Drop up to ${MAX_UPLOADS} files at a time.`);
  fs.mkdirSync(uploadDir, { recursive: true });
  files.forEach((f, i) => {
    const content = String(f.content ?? '');
    if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) throw new ConfigError(`${f.name} is over 10 MB.`);
    if (nestingDepth(content) > 200) throw new ConfigError(`${f.name} is nested too deeply to be a real collection or spec.`);
    let doc;
    try {
      doc = JSON.parse(content);
    } catch {
      try {
        doc = YAML.parse(content, { maxAliasCount: 100 });
      } catch {
        throw new ConfigError(`${f.name} is not JSON or YAML, so IronProbe cannot read it.`);
      }
    }
    const kind = detectKind(doc);
    if (kind === 'postman-env') {
      // Postman environment: its values feed {{variables}} in memory only; the file is not saved.
      for (const v of doc.values) if (v && v.enabled !== false && typeof v.key === 'string') vars[v.key] = String(v.value ?? '');
      if (target) rebaseVars(doc.values, vars, target, notes, f.name);
      notes.push(`${f.name}: Postman environment (${Object.keys(vars).length} values, kept in memory)`);
      return;
    }
    if (!kind) throw new ConfigError(`${f.name} is not a Postman collection, OpenAPI/Swagger spec, HAR recording or IronProbe test file.`);
    const name = `${String(i + 1).padStart(2, '0')}-${safeName(f.name, i)}`;
    fs.writeFileSync(path.join(uploadDir, name), content);
    const rel = `uploads/${name}`;
    if (kind === 'postman' && target) rebaseVars(doc.variable, vars, target, notes, f.name);
    if (kind === 'postman') api.push(allowWrites ? { postman: rel } : { postman: rel, safeOnly: true });
    else if (kind === 'openapi') api.push({ openapi: rel, fuzz: true });
    else if (kind === 'har') {
      if (!doc.log.entries.length) throw new ConfigError(`${f.name} is a browser recording with no requests in it. Record again with the Network tab open while you use the site.`);
      api.push({ har: rel });
    }
    else if (doc.tests?.some?.((t) => Array.isArray(t?.steps))) uiSuites.push(rel);
    else api.push({ file: rel });
    notes.push(`${f.name}: ${kind === 'suite' ? 'IronProbe tests' : kind === 'har' ? 'browser recording (HAR)' : kind === 'openapi' ? 'API spec (also tries unusual inputs)' : 'Postman collection'}`);
  });
  return { api, uiSuites, notes, vars };
}

// Common analytics and ad hosts: skipped in quick mode so test runs do not count as real visits.
export const ANALYTICS_HOSTS = ['*.google-analytics.com', '*.googletagmanager.com', '*.doubleclick.net', '*.googlesyndication.com', 'connect.facebook.net', '*.hotjar.com', '*.segment.io', '*.segment.com', '*.mixpanel.com', '*.amplitude.com', '*.clarity.ms', 'static.ads-twitter.com', 'snap.licdn.com', '*.intercom.io', '*.fullstory.com'];

export function buildQuickConfig(u, { api = [], uiSuites = [], browsers = 'fast', network, maxPages = 20, auth = false } = {}) {
  const start = `${u.pathname}${u.search}` || '/';
  const config = {
    name: u.host,
    baseUrl: u.origin,
    allowedHosts: hostsFor(u),
    output: 'report',
    ui: {
      browsers: browsers === 'all' ? ['chromium', 'firefox', 'webkit'] : ['chromium'],
      // Chromium can only pretend to be an Android phone honestly; iPhone needs the Safari engine.
      devices: browsers === 'all' ? ['Desktop', 'Pixel 7', 'iPhone 15'] : ['Desktop', 'Pixel 7'],
      pages: [start],
      suites: uiSuites,
      a11y: true,
      visual: true,
      visualPages: [start],
      visualFullPage: false, // first screen only: long pages with live content change too often
      visualThreshold: 0.01,
      visualInfoOnly: true,
      visualMask: ['video', 'iframe', '[aria-live]', '[class*="cookie" i]', '[id*="cookie" i]', '[class*="carousel" i]'],
      blockHosts: ANALYTICS_HOSTS,
      // Own files from any public host; the typed host on any port (e.g. a local API on another port).
      allowAssetHosts: ['*', u.hostname.replace(/^\[|\]$/g, '')],
      ...(network ? { network } : {}),
    },
    crawl: { start, maxPages },
  };
  if (api.length) {
    // A token typed in the dashboard is passed in memory to every API file, never written to disk.
    config.api = auth ? api.map((e) => ({ ...e, headers: { Authorization: '{{__ironprobe_auth}}' } })) : api;
  }
  return config;
}

// Runs a quick test. `files` are [{ name, content }]. Returns the runner result plus the workspace.
export async function quickRun(opts) {
  const old = process.umask(0o077); // everything quick mode writes is readable by you only
  try {
    return await quickRunInner(opts);
  } finally {
    process.umask(old);
  }
}

async function quickRunInner({ url, files = [], browsers, network, auth = '', allowWrites = false, log = console.log, home = ironprobeHome(), signal, deadlineMs = 4 * 60 * 1000 }) {
  const u = parseTarget(url);
  const workspace = path.join(home, 'sites', siteSlug(u));
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const release = takeLock(workspace);
  const cleanup = () => {
    if (!activeCleanups.delete(cleanup)) return;
    fs.rmSync(path.join(workspace, 'uploads'), { recursive: true, force: true }); // dropped files are never kept
    release();
  };
  activeCleanups.add(cleanup);
  try {
    await checkReachable(u, 10000, signal);
    const uploadDir = path.join(workspace, 'uploads');
    fs.rmSync(uploadDir, { recursive: true, force: true }); // each run uses only the files given to it
    const { api, uiSuites, notes, vars } = placeUploads(files, uploadDir, { allowWrites, target: u });
    const token = String(auth || '').trim();
    const config = buildQuickConfig(u, { api, uiSuites, browsers, network, auth: Boolean(token) });
    const configPath = path.join(workspace, 'ironprobe.config.yaml');
    fs.writeFileSync(configPath, `# Written by IronProbe quick mode. Copy it into your project to customise.\n${YAML.stringify(config)}`);
    for (const n of notes) log(`  using ${n}`);

    const header = token ? (/^\S+\s+\S/.test(token) ? token : `Bearer ${token}`) : '';
    // Mask the token in every form an API might echo back, plus every Postman environment value.
    const extraSecrets = [...(token ? [header, header.replace(/^\S+\s+/, ''), token] : []), ...Object.entries(vars).filter(([k, v]) => v.length >= 4 && (/key|token|secret|pass|auth|pin|cred|session|cookie|jwt/i.test(k) || v.length >= 24)).map(([, v]) => v)];
    const extraVars = { ...vars, ...(token ? { __ironprobe_auth: header } : {}) };
    const fingerprint = fingerprintOf(u, files, browsers, network, Boolean(token), allowWrites);

    // Stop is honoured from here on, including during the one-time browser download.
    const controller = new AbortController();
    const onCancel = () => controller.abort();
    signal?.addEventListener('abort', onCancel);
    if (signal?.aborted) controller.abort();
    let result;
    let timer;
    try {
      const missing = await ensureBrowsers(config.ui.browsers, log, controller.signal, home);
      if (controller.signal.aborted) throw new ConfigError('Stopped before the test started.');
      if (missing.length === config.ui.browsers.length) throw new ConfigError('The test browser could not be downloaded. Check your internet connection and try again.');
      timer = setTimeout(() => controller.abort(), deadlineMs); // the time limit counts testing only
      result = await run({
        configPath, outDir: path.join(workspace, 'report'), log, only: ['api', 'ui', 'crawl'],
        extraSecrets, extraVars, loginAsSkip: !token, signal: controller.signal, navTimeout: 15000, fingerprint,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
    const runId = snapshot(workspace, result.outDir, result.results);
    return { ...result, workspace, site: siteSlug(u), runId, target: u.toString() };
  } finally {
    cleanup();
  }
}

// One run per site at a time, across the dashboard and the command line.
function takeLock(workspace) {
  const file = path.join(workspace, '.lock');
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(file, 'utf8')) || 0;
    } catch {
      /* removed meanwhile */
    }
    let alive = pid > 0;
    try {
      if (pid) process.kill(pid, 0);
    } catch (e) {
      alive = e.code === 'EPERM';
    }
    if (alive) throw new ConfigError('This site is already being tested. Wait for that run to finish.');
    // Stale lock from a crashed run: replace it atomically with rename, then confirm we own it.
    const tmp = `${file}.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, String(process.pid));
    fs.renameSync(tmp, file);
    if (Number(fs.readFileSync(file, 'utf8')) !== process.pid) throw new ConfigError('This site is already being tested. Wait for that run to finish.');
  }
  return () => {
    // Only remove the lock if it is still ours.
    try {
      if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}

// Before opening any browser: can we reach the site at all? Plain words if not.
export async function checkReachable(u, timeoutMs = 10000, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onStop = () => controller.abort();
  signal?.addEventListener('abort', onStop);
  try {
    if (signal?.aborted) controller.abort();
    const res = await fetch(u, { method: 'GET', redirect: 'manual', signal: controller.signal });
    await res.body?.cancel().catch(() => {}); // only the answer matters: do not download the page
  } catch (e) {
    if (signal?.aborted) throw new ConfigError('Stopped before the test started.');
    const code = timedOut ? 'TimeoutError' : e.cause?.code || e.name || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new ConfigError(`Can't find ${u.host}. Check the address for typos.`);
    if (code === 'ECONNREFUSED') throw new ConfigError(`Can't reach ${u.host}. Is your app running?`);
    if (code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') throw new ConfigError(`${u.host} did not answer within ${timeoutMs / 1000} seconds. Is it running and reachable from this computer?`);
    if (/CERT|SSL|TLS/i.test(code)) throw new ConfigError(`${u.host} has a security certificate problem, so browsers would refuse it too.`);
    if (/bad port/i.test(String(e.cause?.message || e.message))) throw new ConfigError(`Port ${u.port} is one that browsers refuse to open, so ${u.host} can't be tested. Run your app on another port (for example 3000 or 8080).`);
    throw new ConfigError(`Can't reach ${u.host} (${code || 'connection failed'}).`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onStop);
  }
}

// What was tested and how, so scores are only compared with like-for-like runs.
function fingerprintOf(u, files, browsers, network, auth, allowWrites) {
  const h = crypto.createHash('sha1');
  h.update([u.toString(), browsers || 'fast', network || '', auth ? 'auth' : '', allowWrites ? 'writes' : ''].join('|'));
  for (const f of files || []) h.update(`|${f.name}|${crypto.createHash('sha1').update(String(f.content ?? '')).digest('hex')}`);
  return h.digest('hex').slice(0, 12);
}

// Keeps a copy of each report so past runs can be opened later (last 20 per site).
function snapshot(workspace, outDir, results) {
  const runId = new Date(results.meta.startedAt).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(workspace, 'runs', runId);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(outDir, 'report.html'), path.join(dest, 'report.html'));
  fs.copyFileSync(path.join(outDir, 'results.json'), path.join(dest, 'results.json'));
  const art = path.join(outDir, 'artifacts');
  if (fs.existsSync(art)) fs.cpSync(art, path.join(dest, 'artifacts'), { recursive: true });
  const runs = fs.readdirSync(path.join(workspace, 'runs')).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) fs.rmSync(path.join(workspace, 'runs', old), { recursive: true, force: true });
  return runId;
}

// Every past run, newest first, across all sites.
export function listRuns(home = ironprobeHome()) {
  const sitesDir = path.join(home, 'sites');
  if (!fs.existsSync(sitesDir)) return [];
  const out = [];
  for (const site of fs.readdirSync(sitesDir)) {
    const runsDir = path.join(sitesDir, site, 'runs');
    if (!fs.existsSync(runsDir)) continue;
    for (const id of fs.readdirSync(runsDir)) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(runsDir, id, 'results.json'), 'utf8'));
        out.push({
          site, id, startedAt: r.meta?.startedAt, target: r.meta?.name,
          score: r.summary?.stopped || (r.warnings || []).some((w) => /^Stopped early/.test(w)) ? null : r.summary?.score ?? null,
          passed: r.summary?.passed ?? 0, failed: r.summary?.failed ?? 0, durationMs: r.meta?.durationMs ?? 0,
          areas: (r.health?.parts || []).map((p) => p.name), skipped: r.summary?.skipped ?? 0,
          fingerprint: r.meta?.fingerprint || null,
        });
      } catch {
        /* unreadable run: skip */
      }
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
