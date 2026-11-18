// Command-line interface. Exit codes: 0 all passed, 1 failures (or nothing ran), 2 config/safety/usage error.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { run, ENGINES } from './runner.js';
import { STARTER_CONFIG, STARTER_API, STARTER_UI, ConfigError, loadConfig } from './config.js';
import { importPostman } from './importers/postman.js';
import { importOpenApi } from './importers/openapi.js';
import { importHar } from './importers/har.js';
import { SafetyError } from './safety.js';
import { scanPaths } from './secrets.js';
import { exportPlaywright } from './export/playwright.js';
import { startMock } from './mock.js';
import { doctor } from './doctor.js';
import { VERSION } from './util.js';

const HELP = `IronProbe ${VERSION}: local-first testing agent

Easiest:
  ironprobe                               Open the dashboard: paste a link, drop files, press Test
      --port <n>                          Dashboard port (default 4777)   --no-open  Don't open a browser
  ironprobe <url> [api files...]          Test a site from just its address (also: ironprobe test <url>)
      --all-browsers                      Also test the Firefox and Safari (WebKit) engines
      --network <3g-india|slow-4g|4g>     Simulate a slower connection
      --open                              Open the report when done
      --token <value>                     API token for your API files (safer: set IRONPROBE_TOKEN instead,
                                          so it stays out of shell history and the process list)
      --allow-writes                      Also run Postman requests that change data (test servers only)

Full control (config file in your project):
  ironprobe init                          Create ironprobe.config.yaml and starter tests
  ironprobe doctor                        Check Node, Playwright, browsers, config and app
  ironprobe run [options]                 Run tests and write the report
      -c, --config <file>                 Config file (default: ironprobe.config.yaml)
      --only <list>                       Comma list of: ${ENGINES.join(', ')}
      -o, --out <dir>                     Output folder (default: ironprobe-report)
      --headed                            Show the browser windows
      --update-baselines                  Accept current screenshots as the new visual baselines
      --fail-on-skip                      Exit 1 if any browser/device combination could not run
  ironprobe import postman <file> [-o out.yaml]
  ironprobe import openapi <file> [-o out.yaml] [--include-writes] [--fuzz]
  ironprobe import har <file> [-o out.yaml] [--host example.com]   Turn a browser recording into API checks
  ironprobe mock <openapi file> [--port 4020]   Serve a local mock API from a spec
  ironprobe scan [paths]                  Find hard-coded secrets in tests and collections
  ironprobe export playwright [-c file] [-o dir]   Export UI tests as plain Playwright code
  ironprobe --version | --help           Add --debug to any command for full error details

Outputs: report.html (charts), results.json, junit.xml, history.jsonl
Safety: only hosts in allowedHosts are contacted; load tests need iOwnThisTarget: true.`;

// Smallest number of single-character edits between two words (for "did you mean" hints).
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// Parses "--name value", "--name=value" and boolean flags. Flags the command does not know are an error.
function parseArgs(args, valueFlags, boolFlags = []) {
  const opts = {};
  const rest = [];
  const known = [...valueFlags, ...boolFlags];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('-') ? (eq > 0 ? a.slice(0, eq) : a) : null;
    if (name && valueFlags.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      // A value may start with "-" (tokens do); only another option in its place means it was left out.
      if (v === undefined || (eq < 0 && known.includes(v.split('=')[0]))) throw new ConfigError(`${name} needs a value`);
      opts[name] = v;
    } else if (name && boolFlags.includes(name) && eq < 0) {
      opts[name] = true;
    } else if (name && boolFlags.includes(name)) {
      throw new ConfigError(`${name} does not take a value.`);
    } else if (name) {
      const close = known.filter((k) => editDistance(name, k) <= 2).sort((x, y) => editDistance(name, x) - editDistance(name, y))[0];
      throw new ConfigError(`Unknown option "${name}".${close ? ` Did you mean ${close}?` : ''} Run "ironprobe --help" for the full list.`);
    } else {
      rest.push(a);
    }
  }
  return { opts, rest };
}

const pick = (opts, ...names) => names.map((n) => opts[n]).find((v) => v !== undefined);

function writeNew(file, content) {
  if (fs.existsSync(file)) {
    console.log(`  exists, kept: ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`  created: ${file}`);
}

function readSpec(file) {
  if (!fs.existsSync(file)) throw new ConfigError(`File not found: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  try {
    return /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid ${/\.json$/i.test(file) ? 'JSON' : 'YAML'}: ${String(e.message).split('\n')[0]}`);
  }
}

// Exit code for a finished run: a run that was stopped part-way (time limit or Stop) never counts as a pass.
export function exitCode(summary, { failOnSkip = false } = {}) {
  if (summary.nothingRan || summary.uiNothingRan || summary.stopped) return 1;
  if (failOnSkip && summary.skippedCombos) return 1;
  return summary.failed ? 1 : 0;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

export async function main(argv) {
  const debug = argv.includes('--debug');
  const [rawCmd, ...args] = argv.filter((a) => a !== '--debug');
  const cmd = typeof rawCmd === 'string' ? rawCmd.trim() : rawCmd; // pasted addresses often carry spaces
  try {
    if (args.includes('--help') || args.includes('-h')) {
      console.log(HELP);
      return 0;
    }
    // No command, or only options (ironprobe --port 5000, ironprobe --debug): open the dashboard.
    const optionFirst = Boolean(cmd) && cmd.startsWith('-') && !['--help', '-h', '--version', '-v'].includes(cmd);
    if (!cmd || cmd === 'ui' || cmd === 'app' || cmd === 'dashboard' || optionFirst) {
      const { opts } = parseArgs(optionFirst ? [cmd, ...args] : args, ['--port'], ['--no-open']);
      const port = opts['--port'] === undefined ? 4777 : Number(opts['--port']);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError('--port must be a number between 1024 and 65535.');
      const { startDashboard } = await import('./dashboard/server.js');
      const { cleanupActiveRuns } = await import('./quick.js');
      const dashboard = await startDashboard({ port, open: !opts['--no-open'] });
      // Keep serving until Ctrl+C, then stop any run in flight and leave no dropped files or lock behind.
      return await new Promise((resolve) => {
        const stop = () => {
          dashboard.close();
          cleanupActiveRuns();
          resolve(130);
        };
        for (const s of STOP_SIGNALS) process.once(s, stop);
      });
    }
    if (cmd === 'test' || /^(https?:\/\/|localhost|127\.|\[::1\])/i.test(cmd) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(cmd) && !/\.(ya?ml|json|har|js|mjs|ts|md|txt|html?|zip|csv|xml|lock|log)$/i.test(cmd) && !fs.existsSync(cmd))) {
      const { opts, rest } = parseArgs(cmd === 'test' ? args : [cmd, ...args], ['--network', '--token'], ['--all-browsers', '--open', '--allow-writes']);
      const [target, ...fileArgs] = rest;
      if (!target) throw new ConfigError('Give the address to test, for example: ironprobe https://myapp.com');
      const network = opts['--network'];
      if (network && !['3g-india', 'slow-4g', '4g'].includes(network)) throw new ConfigError('--network must be 3g-india, slow-4g or 4g.');
      const files = fileArgs.map((f) => {
        if (!fs.existsSync(f)) throw new ConfigError(`File not found: ${f}`);
        return { name: path.basename(f), content: fs.readFileSync(f, 'utf8') };
      });
      const { quickRun, cleanupActiveRuns } = await import('./quick.js');
      const token = opts['--token'] ?? process.env.IRONPROBE_TOKEN ?? '';
      // Ctrl+C: stop the run, delete the dropped files and free the site lock before exiting.
      const controller = new AbortController();
      let onSignal;
      const interrupted = new Promise((resolve) => {
        onSignal = () => {
          controller.abort();
          cleanupActiveRuns();
          resolve(null);
        };
      });
      for (const s of STOP_SIGNALS) process.once(s, onSignal);
      let r;
      try {
        r = await Promise.race([
          quickRun({ url: target, files, browsers: opts['--all-browsers'] ? 'all' : 'fast', network, auth: token, allowWrites: Boolean(opts['--allow-writes']), signal: controller.signal }),
          interrupted,
        ]);
      } finally {
        for (const s of STOP_SIGNALS) process.off(s, onSignal);
      }
      if (!r) {
        console.error('Stopped. Nothing was saved for this run.');
        return 130;
      }
      const report = path.join(r.workspace, 'runs', r.runId, 'report.html');
      console.log(`Saved run: ${report}`);
      console.log('Tip: run "ironprobe" for the dashboard with your full history.');
      if (opts['--open']) {
        const { spawn } = await import('node:child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
        try {
          spawn(opener, [report], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        } catch {
          /* path is printed */
        }
      }
      return exitCode(r.results.summary);
    }
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      console.log(HELP);
      return 0;
    }
    if (cmd === '--version' || cmd === '-v') {
      console.log(VERSION);
      return 0;
    }
    if (cmd === 'init') {
      writeNew('ironprobe.config.yaml', STARTER_CONFIG);
      writeNew('tests/api.yaml', STARTER_API);
      writeNew('tests/ui.yaml', STARTER_UI);
      console.log('Next: set baseUrl and allowedHosts in ironprobe.config.yaml, then run "ironprobe doctor" and "ironprobe run".');
      return 0;
    }
    if (cmd === 'doctor') {
      const { opts } = parseArgs(args, ['-c', '--config']);
      return await doctor({ configPath: pick(opts, '-c', '--config') || 'ironprobe.config.yaml' });
    }
    if (cmd === 'import') {
      const { opts, rest } = parseArgs(args, ['-o', '--out', '--host'], ['--include-writes', '--fuzz']);
      const [kind, file] = rest;
      if (!kind || !file) throw new ConfigError('Usage: ironprobe import <postman|openapi|har> <file> [-o out.yaml] [--host example.com]');
      if (!['postman', 'openapi', 'har'].includes(kind)) throw new ConfigError(`Unknown import type "${kind}" (use postman, openapi or har).`);
      const data = readSpec(file);
      let suite;
      try {
        if (kind === 'har') {
          const hosts = opts['--host'] ? [String(opts['--host'])] : [...new Set((data?.log?.entries || []).map((x) => { try { return new URL(x.request.url).host; } catch { return null; } }).filter(Boolean))].slice(0, 1);
          suite = importHar(data, { allowedHosts: hosts });
          if (!opts['--host'] && hosts.length) suite.warnings.unshift(`Imported requests to ${hosts[0]} (use --host to pick another).`);
        } else {
          suite = kind === 'postman' ? importPostman(data) : importOpenApi(data, { includeWrites: Boolean(opts['--include-writes']), fuzz: Boolean(opts['--fuzz']) });
        }
      } catch (e) {
        throw new ConfigError(`Could not import ${file}: ${e.message}`);
      }
      const { warnings, secrets: found = [], ...rest2 } = suite;
      // Never write secrets into a file meant for git: swap them for environment variables.
      const envNames = [];
      if (found.length) {
        let text = JSON.stringify(rest2);
        // Longest first, so a raw value is replaced before any shorter decoded form inside it.
        for (const v of [...found].sort((a, b) => b.length - a.length)) {
          const name = `HAR_SECRET_${envNames.length + 1}`;
          const before = text;
          for (const form of new Set([v, encodeURIComponent(v)])) text = text.split(JSON.stringify(form).slice(1, -1)).join(`{{env.${name}}}`);
          if (text !== before) envNames.push(name); // count only real replacements
        }
        Object.assign(rest2, JSON.parse(text));
      }
      const out = pick(opts, '-o', '--out') || `${path.basename(file).replace(/\.(json|ya?ml|har)$/i, '')}.ironprobe.yaml`;
      fs.writeFileSync(out, YAML.stringify(rest2));
      console.log(`Imported ${rest2.tests.length} test(s) -> ${out}`);
      for (const w of warnings) console.log(`  ! ${w}`);
      if (envNames.length) console.log(`  ! ${envNames.length} secret value(s) were replaced with {{env.${envNames[0]}}}${envNames.length > 1 ? ' and similar' : ''}. Set ${envNames.join(', ')} before running, using the values exactly as they appear in the recorded addresses.`);
      const untranslated = rest2.tests.filter((t) => t.untranslated?.length).length;
      if (untranslated) console.log(`  ! ${untranslated} test(s) have Postman script lines that were not translated (scripts are never run). Review them.`);
      return 0;
    }
    if (cmd === 'mock') {
      const { opts, rest } = parseArgs(args, ['--port', '-p']);
      if (!rest[0]) throw new ConfigError('Usage: ironprobe mock <openapi file> [--port 4020]');
      const spec = readSpec(rest[0]);
      if (!String(spec?.openapi || '').startsWith('3')) throw new ConfigError('Mock needs an OpenAPI 3.x document.');
      const port = Number(pick(opts, '--port', '-p') || 4020);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('--port must be a number between 1 and 65535');
      try {
        await startMock(spec, { port });
      } catch (e) {
        throw new ConfigError(e.message);
      }
      console.log(`Mock API for "${spec.info?.title || rest[0]}" on http://127.0.0.1:${port} (Ctrl+C to stop)`);
      return new Promise(() => {}); // keep serving
    }
    if (cmd === 'scan') {
      const { rest } = parseArgs(args, []);
      let findings;
      try {
        findings = scanPaths(rest.length ? rest : ['.'], { strict: true });
      } catch (e) {
        throw new ConfigError(e.message);
      }
      if (!findings.length) {
        console.log('✓ No hard-coded secrets found.');
        return 0;
      }
      console.log(`✕ ${findings.length} possible secret(s) found. Move them to environment variables and use {{env.NAME}}:`);
      for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.kind}  ${f.preview}`);
      return 1;
    }
    if (cmd === 'export') {
      const { opts, rest } = parseArgs(args, ['-c', '--config', '-o', '--out']);
      if (rest[0] !== 'playwright') throw new ConfigError('Usage: ironprobe export playwright [-c config] [-o folder]');
      const loaded = loadConfig(pick(opts, '-c', '--config') || 'ironprobe.config.yaml');
      const files = exportPlaywright(loaded.uiSuites, loaded.config, path.resolve(pick(opts, '-o', '--out') || 'playwright-tests'));
      console.log(`Exported ${files.length} file(s):`);
      for (const f of files) console.log(`  ${f}`);
      console.log('Run them with: npx playwright test -c <folder>/playwright.config.ts');
      return 0;
    }
    if (cmd === 'run') {
      const { opts } = parseArgs(args, ['-c', '--config', '-o', '--out', '--only'], ['--headed', '--update-baselines', '--fail-on-skip']);
      const only = String(opts['--only'] || ENGINES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = only.filter((o) => !ENGINES.includes(o));
      if (unknown.length) throw new ConfigError(`Unknown --only value(s): ${unknown.join(', ')}. Use: ${ENGINES.join(', ')}`);
      const { results } = await run({
        configPath: pick(opts, '-c', '--config') || 'ironprobe.config.yaml',
        only,
        outDir: pick(opts, '-o', '--out'),
        headed: Boolean(opts['--headed']),
        updateBaselines: Boolean(opts['--update-baselines']),
      });
      return exitCode(results.summary, { failOnSkip: Boolean(opts['--fail-on-skip']) });
    }
    if (/^[a-z]{2,6}:\/{0,2}\S+/i.test(cmd) || /^[a-z0-9-]+[a-z0-9]+(com|net|org|io|app|dev|in)$/i.test(cmd)) {
      console.error(`"${cmd}" doesn't look like a web address IronProbe can test. Try: ironprobe https://example.com  or  ironprobe localhost:3000`);
      return 2;
    }
    const cmds = ['init', 'doctor', 'run', 'test', 'import', 'mock', 'scan', 'export'];
    const near = cmds.find((c) => editDistance(cmd, c) <= 2);
    if (!near && /^[a-z0-9.-]+(:\d+)?$/i.test(cmd)) {
      // A bare word that is not a command is most likely a mistyped address (localhsot, mysite).
      const fix = editDistance(cmd.split(':')[0].toLowerCase(), 'localhost') <= 2 ? ` Did you mean localhost${cmd.includes(':') ? cmd.slice(cmd.indexOf(':')) : ':3000'}?` : '';
      console.error(`Can't find "${cmd}". Check the spelling of the address.${fix} Examples: ironprobe example.com  or  ironprobe localhost:3000`);
      return 2;
    }
    console.error(`Unknown command "${cmd}".${near ? ` Did you mean "${near}"?` : ''}\n\n${HELP}`);
    return 2;
  } catch (e) {
    if (e instanceof SafetyError || e instanceof ConfigError) {
      console.error(`✕ ${e.message}`);
      return 2;
    }
    console.error(`✕ ${e.message}${debug ? `\n${e.stack}` : '\n  (add --debug for details)'}`);
    return 2;
  }
}
