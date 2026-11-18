// `ironprobe doctor`: checks the setup and says exactly how to fix each problem.
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { send } from './http.js';

export async function doctor({ configPath = 'ironprobe.config.yaml', log = console.log } = {}) {
  let problems = 0;
  const ok = (m) => log(`  ✓ ${m}`);
  const bad = (m, fix) => {
    problems++;
    log(`  ✕ ${m}\n      Fix: ${fix}`);
  };

  log('IronProbe doctor\n');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node} is too old`, 'install Node.js 20 or newer from nodejs.org');

  let pw = null;
  try {
    pw = await import('playwright');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    let version = 'unknown';
    try {
      version = require('playwright/package.json').version;
    } catch {
      /* version not readable */
    }
    const [maj, min] = version.split('.').map(Number);
    if (maj > 1 || (maj === 1 && min >= 49)) ok(`Playwright ${version}`);
    else bad(`Playwright ${version} is older than 1.49`, 'reinstall IronProbe so it brings its own Playwright: npm install');
  } catch {
    bad('Playwright is not installed (needed for UI, crawl and extension tests)', 'Playwright comes with IronProbe. Run: npm install, then npx playwright install');
  }
  // Only the browsers the config uses are required; the others are reported as optional.
  let wanted = ['chromium'];
  try {
    if (fs.existsSync(configPath)) wanted = loadConfig(configPath).config.ui?.browsers || ['chromium'];
  } catch {
    /* config problems are reported below */
  }
  if (pw) {
    for (const name of ['chromium', 'firefox', 'webkit']) {
      const needed = wanted.includes(name);
      try {
        const b = await pw[name].launch();
        await b.close();
        ok(`${name} browser works`);
      } catch (e) {
        const msg = String(e.message || '');
        if (!needed) {
          log(`  - ${name} not installed (optional; your config does not use it)`);
          continue;
        }
        if (/Executable doesn't exist/i.test(msg)) bad(`${name} browser is not installed`, `run: npx playwright install ${name}`);
        else bad(`${name} browser failed to start: ${msg.split('\n')[0].slice(0, 160)}`, `run: npx playwright install --with-deps ${name}`);
      }
    }
  }

  if (!fs.existsSync(configPath)) {
    bad(`No ${configPath} here`, 'run: ironprobe init');
  } else {
    try {
      const { config, apiSuites, uiSuites } = loadConfig(configPath);
      ok(`Config is valid (${apiSuites.length} API suite(s), ${uiSuites.length} UI suite(s))`);
      if (config.baseUrl) {
        try {
          const res = await send({ method: 'GET', url: config.baseUrl }, { allowedHosts: config.allowedHosts, timeoutMs: 5000 });
          ok(`App answers at ${config.baseUrl} (HTTP ${res.status})`);
        } catch (e) {
          bad(`App does not answer at ${config.baseUrl} (${e.cause?.code || e.message})`, 'start your app, or fix baseUrl in the config');
        }
      }
    } catch (e) {
      bad(`Config problem: ${e.message}`, 'edit the config file as described');
    }
  }
  log(problems ? `\n${problems} problem(s) found.` : '\nEverything looks ready. Run: ironprobe run');
  return problems ? 1 : 0;
}
