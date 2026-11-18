// Local dashboard: `ironprobe` opens it in the browser. Paste a URL, drop files, press Test.
// Security: listens on 127.0.0.1 only, checks the Host header (DNS rebinding), and every request
// needs a random per-launch token (header for writes, SameSite=Strict cookie for reads).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quickRun, listRuns, ironprobeHome } from '../quick.js';
import { VERSION } from '../util.js';
import { plainProblem, friendlyWarnings } from '../plain.js';

export { friendlyWarnings };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 60 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

const ENGINE_NAMES = { api: 'API checks', ui: 'Browser checks', crawl: 'Whole-site scan', load: 'Load test' };

// Turns results into the short "fix these first" list: app bugs first, devices grouped, plain words.
export function topFailures(results, limit = 8) {
  const items = [
    ...(results.api || []).map((x) => ({ ...x, area: 'API' })),
    ...(results.ui?.tests || []).map((x) => ({ ...x, area: 'User flow' })),
    ...(results.ui?.pages || []).map((x) => ({ ...x, area: 'Page' })),
    ...(results.crawl?.pages || []).map((x) => ({ ...x, area: 'Other pages' })),
    ...(results.engineErrors || []).map((x) => ({ ...x, area: 'Setup' })),
  ].filter((x) => x.passed === false && !x.skipped);
  const order = { app: 0, test: 1, infrastructure: 2 };
  const out = [];
  for (const x of items) {
    // Setup errors have no page or test of their own: say which part of the run could not start.
    let where = x.name || x.url || x.path || (x.engine ? ENGINE_NAMES[x.engine] || `${x.engine} checks` : '');
    try {
      if (!x.name && x.url) where = new URL(x.url).pathname;
    } catch {
      /* keep raw */
    }
    const raw = String((x.failures || [])[0] || 'failed').slice(0, 300);
    let cause = x.category || 'app';
    if (x.area === 'API' && /got 40[13]\b/.test(raw)) cause = 'login';
    // A page can fail for more than one reason (accessibility and a console error): say them all.
    const more = (x.failures || []).slice(1, 3).map((f) => plainProblem(String(f).slice(0, 300)));
    let problem = [plainProblem(raw), ...more].join(' Also: ').slice(0, 320);
    // Edge-case (fuzz) checks: one card per endpoint, listing the inputs that broke it.
    const fuzz = /^fuzz (\S+) (.+)$/.exec(where);
    let input = null;
    if (fuzz) {
      where = fuzz[1];
      input = fuzz[2];
      problem = problem.replace('on an unusual input', 'on unusual inputs');
    }
    const key = `${where}|${problem.replace(/\d+/g, '#')}`;
    const device = [x.browser, x.device].filter(Boolean).join(' ').replace(/^chromium /, '');
    const dup = out.find((o) => o.key === key);
    if (dup) {
      if (device && !dup.devices.includes(device)) dup.devices.push(device);
      if (input && dup.inputs.length < 6) dup.inputs.push(input);
      continue;
    }
    out.push({ key, area: x.area, where: String(where).slice(0, 120), problem, cause, devices: device ? [device] : [], inputs: input ? [input] : [] });
  }
  out.sort((a, c) => (order[a.cause] ?? 3) - (order[c.cause] ?? 3));
  return out.slice(0, limit).map(({ key, ...rest }) => rest);
}

export async function startDashboard({ port = 4777, open = true, home: homeIn = ironprobeHome(), log = console.log } = {}) {
  const home = path.resolve(homeIn);
  const token = crypto.randomBytes(24).toString('base64url');
  let current = null; // { id, events: [], listeners: Set, done }
  let boundPort = port;
  const cookieName = () => `ironprobe_${boundPort}`;

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request.' }));
    });
  });
  async function handle(req, res) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      res.writeHead(421).end('Wrong host');
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) {
      res.writeHead(403).end('Cross-site request refused');
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;
    const security = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };

    // Static app shell (no data in it, so no token needed).
    const font = /^\/fonts\/(plex-(?:sans-400|sans-600|condensed-600)\.woff2)$/.exec(p);
    if (req.method === 'GET' && font) {
      res.writeHead(200, { ...security, 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
      res.end(fs.readFileSync(path.join(HERE, 'fonts', font[1])));
      return;
    }
    if (req.method === 'GET' && (p === '/' || p === '/app.js' || p === '/app.css')) {
      const file = p === '/' ? 'app.html' : p.slice(1);
      res.writeHead(200, { ...security, 'content-type': TYPES[path.extname(file)], 'content-security-policy': APP_CSP, 'x-frame-options': 'DENY' });
      res.end(fs.readFileSync(path.join(HERE, file)));
      return;
    }

    const headerOk = sameToken(req.headers['x-ironprobe-token'], token);
    const cookieOk = sameToken(cookieValue(req, cookieName()), token);
    const json = (status, data, extra = {}) => {
      res.writeHead(status, { ...security, 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(data));
    };

    // The page trades the token from its URL for a cookie, so reports and live events can load.
    if (p === '/api/session' && req.method === 'POST') {
      if (!headerOk) return json(401, { error: 'This dashboard link has expired. Run "ironprobe" again.' });
      return json(200, { version: VERSION, home }, { 'set-cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!(headerOk || (req.method === 'GET' && cookieOk))) return json(401, { error: 'Not signed in to this dashboard. Run "ironprobe" again.' });

    if (p === '/api/history' && req.method === 'GET') return json(200, { runs: listRuns(home).slice(0, 50), running: current && !current.done && current.request ? { id: current.id, request: current.request } : null });

    const cancel = /^\/api\/run\/([a-f0-9]{12})\/cancel$/.exec(p);
    if (cancel && req.method === 'POST') {
      if (!headerOk) return json(401, { error: 'Not allowed.' });
      if (current && current.id === cancel[1] && !current.done) current.controller.abort();
      return json(200, { ok: true });
    }

    if (p === '/api/run' && req.method === 'POST') {
      if (current && !current.done) return json(409, { error: 'A test is already running. Wait for it to finish.' });
      // Claim the slot before reading the body, so two clicks can never start two runs.
      current = { id: crypto.randomBytes(6).toString('hex'), events: [], listeners: new Set(), done: false, controller: new AbortController() };
      const claimed = current;
      const giveBack = () => {
        claimed.done = true;
      };
      let body;
      try {
        let size = 0;
        const chunks = [];
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) {
            giveBack();
            return json(413, { error: 'Those files are too big (60 MB in total at most).' });
          }
          chunks.push(c);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not a JSON object');
      } catch {
        giveBack(); // upload cancelled or not a JSON object: free the slot so the next run can start
        if (!res.headersSent && !res.destroyed) return json(400, { error: 'Bad request.' });
        return undefined;
      }
      const { id } = claimed;
      try {
        claimed.target = String(body.url || '').slice(0, 300);
        claimed.request = { hadFiles: Array.isArray(body.files) && body.files.length > 0, hadToken: Boolean(body.auth), url: claimed.target, browsers: body.browsers === 'all' ? 'all' : 'fast', network: ['3g-india', 'slow-4g', '4g'].includes(body.network) ? body.network : '', allowWrites: body.allowWrites === true };
        const run = claimed;
        let counter = 0;
        const emit = (type, data) => {
          const n = ++counter;
          run.events.push({ type, data, n });
          if (run.events.length > 3000) run.events.splice(1, 1000);
          for (const l of run.listeners) l(type, data, n);
        };
        const files = Array.isArray(body.files) ? body.files.map((f) => ({ name: String(f?.name || ''), content: String(f?.content || '') })) : [];
        quickRun({
          url: body.url, files, home,
          browsers: body.browsers === 'all' ? 'all' : 'fast',
          network: ['3g-india', 'slow-4g', '4g'].includes(body.network) ? body.network : undefined,
          auth: typeof body.auth === 'string' ? body.auth.slice(0, 4000) : '',
          allowWrites: body.allowWrites === true,
          signal: run.controller.signal,
          log: (line) => emit('log', { line: String(line) }),
        })
          .then((r) => {
            // Compare only with a run of the same kind (same address, files and options), so testing
            // less never looks like an improvement.
            const fp = r.results.meta.fingerprint;
            const prev = listRuns(home).find((x) => x.site === r.site && x.id !== r.runId && x.fingerprint === fp && x.score != null);
            const loginNeeded = r.results.api.filter((x) => x.category === 'login' && x.skipped).length;
            emit('done', {
              site: r.site, runId: r.runId, target: r.target, score: r.results.summary.score, label: r.results.health.label,
              previous: prev?.score ?? null, comparable: Boolean(prev) || !listRuns(home).some((x) => x.site === r.site && x.id !== r.runId && x.score != null), loginNeeded, summary: r.results.summary, parts: r.results.health.parts,
              fixFirst: topFailures(r.results), warnings: friendlyWarnings(r.results.warnings), durationMs: r.results.meta.durationMs,
            });
          })
          .catch((e) => emit('failed', { message: String(e.message || e).split('\n')[0] }))
          .finally(() => {
            run.done = true;
            for (const l of run.listeners) l('end', {}, ++counter);
          });
      } catch (e) {
        giveBack(); // whatever went wrong before the run started, the slot is never left taken
        throw e;
      }
      return json(202, { id });
    }

    const ev = /^\/api\/run\/([a-f0-9]{12})\/events$/.exec(p);
    if (ev && req.method === 'GET') {
      if (!current || current.id !== ev[1]) return json(404, { error: 'That run is not active.' });
      const run = current;
      res.writeHead(200, { ...security, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      const send = (type, data, n) => res.write(`id: ${n}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      // On a reconnect the browser says which events it already has; only send newer ones.
      const seen = Number(req.headers['last-event-id']);
      run.events.forEach((e) => {
        if (!(Number.isInteger(seen) && e.n <= seen)) send(e.type, e.data, e.n);
      });
      if (run.done) {
        send('end', {}, Number.MAX_SAFE_INTEGER);
        res.end();
        return undefined;
      }
      const listener = (type, data, n) => {
        send(type, data, n);
        if (type === 'end') res.end();
      };
      run.listeners.add(listener);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        run.listeners.delete(listener);
      });
      return undefined;
    }

    // Saved reports: /r/<site>/<runId>/<file>
    const rep = /^\/r\/([a-z0-9._-]{1,80})\/([0-9TZ-]{10,40})\/(.+)$/i.exec(p);
    if (rep && req.method === 'GET') {
      const base = path.join(home, 'sites', rep[1], 'runs', rep[2]);
      let rel;
      try {
        rel = decodeURIComponent(rep[3]);
      } catch {
        return json(400, { error: 'Bad address.' });
      }
      const file = path.resolve(base, rel);
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(404, { error: 'Not found.' });
      const type = TYPES[path.extname(file).toLowerCase()];
      if (!type) return json(404, { error: 'Not found.' });
      res.writeHead(200, {
        ...security, 'content-type': type,
        'content-security-policy': "default-src 'none'; img-src 'self' data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        ...(type === 'application/zip' ? { 'content-disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"` } : {}),
      });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return undefined;
    }
    return json(404, { error: 'Not found.' });
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(boundPort, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || attempt === 19) throw e;
      boundPort++;
    }
  }
  const link = `http://127.0.0.1:${boundPort}/#t=${token}`;
  log(`IronProbe dashboard: ${link}`);
  log('Runs on this computer only. Press Ctrl+C to stop.');
  if (open) openBrowser(link);
  return { server, port: boundPort, token, link, close: () => new Promise((r) => {
    if (current && !current.done) current.controller.abort();
    server.closeAllConnections?.();
    server.close(r);
  }) };
}

function openBrowser(link) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    const child = spawn(cmd, [link], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the link is printed anyway */
  }
}
