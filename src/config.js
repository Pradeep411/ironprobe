// Loads and validates ironprobe.config.yaml and the suites it references.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { importPostman } from './importers/postman.js';
import { importHar } from './importers/har.js';
import { importOpenApi } from './importers/openapi.js';
import { SafetyError, isHostAllowed, safeRegex } from './safety.js';

const LOGIN_LIKE = /log ?in|sign ?in|auth|token|session/i;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const STEP_ACTIONS = new Set(['goto', 'reload', 'request', 'click', 'fill', 'press', 'select', 'check', 'hover', 'waitFor', 'wait',
  'expectVisible', 'expectHidden', 'expectText', 'expectUrl', 'expectTitle', 'screenshot']);

function readStructured(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read ${file}: ${e.code === 'ENOENT' ? 'file not found' : e.message}`);
  }
  try {
    return /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`${path.basename(file)} is not valid ${/\.json$/i.test(file) ? 'JSON' : 'YAML'}: ${String(e.message).split('\n')[0]}`);
  }
}

function within(baseDir, rel) {
  const full = path.resolve(baseDir, String(rel));
  if (!fs.existsSync(full)) throw new ConfigError(`File not found: ${rel}`);
  return full;
}

// Paths the config can write to must stay inside the project folder.
export function insideProject(baseDir, rel, label) {
  const full = path.resolve(baseDir, String(rel));
  const relative = path.relative(baseDir, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SafetyError(`${label} must be inside the project folder: ${rel}`);
  return full;
}

function checkUiSuite(s, file) {
  if (!s || typeof s !== 'object') throw new ConfigError(`${file}: suite is empty or not a mapping`);
  for (const [ti, t] of (s.tests || []).entries()) {
    if (!t || typeof t !== 'object') throw new ConfigError(`${file}: test #${ti + 1} is empty`);
    if (!Array.isArray(t.steps)) throw new ConfigError(`${file}: test "${t.name || ti + 1}" needs a steps list`);
    for (const [si, step] of t.steps.entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).length !== 1) {
        throw new ConfigError(`${file}: test "${t.name || ti + 1}" step ${si + 1} must be one action, e.g. "- click: '#save'"`);
      }
      const action = Object.keys(step)[0];
      if (!STEP_ACTIONS.has(action)) throw new ConfigError(`${file}: test "${t.name || ti + 1}" step ${si + 1}: unknown action "${action}". Allowed: ${[...STEP_ACTIONS].join(', ')}`);
    }
  }
}

function checkApiSuite(s, file) {
  if (!s || typeof s !== 'object') throw new ConfigError(`${file}: suite is empty or not a mapping`);
  for (const list of ['setup', 'tests', 'teardown']) {
    if (s[list] !== undefined && !Array.isArray(s[list])) throw new ConfigError(`${file}: "${list}" must be a list`);
    for (const [i, t] of (s[list] || []).entries()) {
      if (!t || typeof t !== 'object' || !t.request || !t.request.url) throw new ConfigError(`${file}: ${list} item ${i + 1} needs request.url`);
    }
  }
}

export function loadConfig(configPath) {
  const file = path.resolve(configPath);
  if (!fs.existsSync(file)) throw new ConfigError(`Config not found: ${configPath}. Run "ironprobe init" to create one.`);
  const config = readStructured(file);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError(`${path.basename(file)} is empty or not a mapping.`);
  const dir = path.dirname(file);
  if (!config.name) config.name = path.basename(dir);
  if (!Array.isArray(config.allowedHosts) || !config.allowedHosts.length) {
    throw new SafetyError('allowedHosts is required: list the hosts you own or are authorised to test (e.g. [localhost, staging.myapp.com]).');
  }
  if (config.baseUrl) {
    config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    if (!isHostAllowed(config.baseUrl, config.allowedHosts)) throw new SafetyError(`baseUrl host is not in allowedHosts: ${config.baseUrl}`);
  }
  if (config.output) insideProject(dir, config.output, 'output');
  if (config.ui) {
    const browsers = config.ui.browsers ?? ['chromium'];
    if (!Array.isArray(browsers) || !browsers.length) throw new ConfigError('ui.browsers must be a list, e.g. [chromium, firefox, webkit].');
    for (const b of browsers) if (!['chromium', 'firefox', 'webkit'].includes(b)) throw new ConfigError(`Unknown browser "${b}" in ui.browsers (use chromium, firefox, webkit).`);
    if (config.ui.devices !== undefined && (!Array.isArray(config.ui.devices) || !config.ui.devices.length)) throw new ConfigError('ui.devices must be a list, e.g. [Desktop, "iPhone 15"].');
    if (config.ui.storageState && !fs.existsSync(path.resolve(dir, String(config.ui.storageState)))) throw new ConfigError(`ui.storageState file not found: ${config.ui.storageState}`);
    if (config.ui.extension && !fs.existsSync(path.join(path.resolve(dir, String(config.ui.extension)), 'manifest.json'))) throw new ConfigError(`ui.extension folder has no manifest.json: ${config.ui.extension}`);
    if (config.ui.network && !['3g-india', 'slow-4g', '4g', 'offline'].includes(config.ui.network)) throw new ConfigError(`Unknown ui.network "${config.ui.network}" (use 3g-india, slow-4g, 4g, offline).`);
  }
  if (config.crawl) {
    const mp = config.crawl.maxPages;
    if (mp !== undefined && !(Number.isInteger(Number(mp)) && Number(mp) >= 1)) throw new ConfigError('crawl.maxPages must be a whole number of at least 1.');
    for (const p of config.crawl.exclude || []) {
      try {
        safeRegex(p);
      } catch (e) {
        throw new ConfigError(`crawl.exclude pattern "${p}" is not usable: ${e.message}`);
      }
    }
  }
  if (config.ui?.baselineDir) insideProject(dir, config.ui.baselineDir, 'ui.baselineDir');
  const warnings = [];

  const apiSuites = [];
  const secrets = [];
  for (const entry of config.api || []) {
    if (entry?.file) {
      const s = readStructured(within(dir, entry.file));
      checkApiSuite(s, entry.file);
      apiSuites.push({ name: s.name || entry.file, vars: s.vars, setup: s.setup || [], tests: s.tests || [], teardown: s.teardown || [] });
    } else if (entry?.postman) {
      const s = importPostman(readStructured(within(dir, entry.postman)));
      warnings.push(...s.warnings.map((w) => `Postman import: ${w}`));
      secrets.push(...(s.secrets || []));
      if (entry.safeOnly) {
        // Quick mode: never replay requests that change data, except a login so later steps can chain.
        const keep = (t) => ['GET', 'HEAD'].includes(String(t.request?.method || 'GET').toUpperCase()) || LOGIN_LIKE.test(`${t.name} ${t.request?.url}`);
        s.setup ||= [];
        s.teardown ||= [];
        const before = [...s.setup, ...s.tests, ...s.teardown].length;
        s.setup = s.setup.filter(keep);
        s.tests = s.tests.filter(keep);
        s.teardown = s.teardown.filter(keep);
        const dropped = before - [...s.setup, ...s.tests, ...s.teardown].length;
        if (dropped) warnings.push(`${dropped} Postman request(s) that change data (POST, PUT, DELETE...) were not run. Tick "Also run requests that change data" to include them, on test servers only.`);
      }
      apiSuites.push(s);
    } else if (entry?.openapi) {
      const s = importOpenApi(readStructured(within(dir, entry.openapi)), { includeWrites: entry.includeWrites === true, fuzz: entry.fuzz === true, baseUrl: config.baseUrl });
      warnings.push(...s.warnings.map((w) => `OpenAPI import: ${w}`));
      apiSuites.push(s);
    } else if (entry?.har) {
      let s;
      try {
        s = importHar(readStructured(within(dir, entry.har)), { allowedHosts: config.allowedHosts });
      } catch (e) {
        throw new ConfigError(`${entry.har}: ${e.message}`);
      }
      warnings.push(...s.warnings.map((w) => `HAR import: ${w}`));
      secrets.push(...(s.secrets || []));
      apiSuites.push(s);
    } else {
      throw new ConfigError('Each api entry needs one of: file, postman, openapi, har.');
    }
  }

  // Extra headers on an api entry (e.g. a login token) apply to every request it produces.
  (config.api || []).forEach((entry, i) => {
    const suite = apiSuites[i];
    if (!entry?.headers || !suite) return;
    for (const t of [...(suite.setup || []), ...(suite.tests || []), ...(suite.teardown || [])]) {
      if (t.request) t.request.headers = { ...entry.headers, ...(t.request.headers || {}) };
    }
  });

  const uiSuites = [];
  if (config.ui) {
    for (const f of config.ui.suites || []) {
      const s = readStructured(within(dir, f));
      checkUiSuite(s, f);
      uiSuites.push({ name: s.name || f, tests: s.tests || [], pages: s.pages || [] });
    }
  }
  if ((config.ui || config.crawl || config.load) && !config.baseUrl) throw new ConfigError('baseUrl is required for ui, crawl and load.');
  return { config, configDir: dir, apiSuites, uiSuites, warnings, secrets };
}

export const STARTER_CONFIG = `# IronProbe config
name: My App
baseUrl: http://localhost:3000
# Safety: IronProbe only talks to these hosts. Add only hosts you own or may test.
allowedHosts: [localhost, 127.0.0.1]
# Load tests stay off until you confirm you own the target:
# iOwnThisTarget: true

api:
  - file: tests/api.yaml          # IronProbe API suite
  # - postman: my.postman_collection.json
  # - openapi: openapi.yaml

ui:
  browsers: [chromium, firefox, webkit]
  devices: [Desktop, "iPhone 15", "Pixel 7"]
  suites: [tests/ui.yaml]
  pages: [/]
  a11y: true
  visual: true
  perf:
    budgets: { LCP: 2500, CLS: 0.1, FCP: 1800, TTFB: 800 }
  # extension: ./my-chrome-extension   # unpacked folder with manifest.json
  # network: 3g-india                    # 3g-india, slow-4g, 4g, offline
  # locale: en-IN
  # timezone: Asia/Kolkata
  # allowAssetHosts: [fonts.googleapis.com, fonts.gstatic.com]   # files only, never visited
  # visualPages: [/]          # pages to compare by screenshot (default: all pages)
  # visualMask: ["#clock"]    # areas that change on purpose
  # visualMaxDiffPixels: 25

crawl:
  start: /
  maxPages: 25

# load:
#   url: /api/health
#   concurrency: 10
#   durationSec: 15
#   maxRps: 50
#   thresholds: { p95: 300, errorRate: 0.01 }
`;

export const STARTER_API = `name: Smoke API
tests:
  - name: Home responds
    request: { method: GET, url: / }
    expect:
      status: 200
      maxMs: 800
`;

export const STARTER_UI = `name: Smoke UI
tests:
  - name: Home page loads
    steps:
      - goto: /
      - expectVisible: body
      - screenshot: home
`;
