// First-run browser setup: if a test browser is missing, download it once (no terminal steps).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// IronProbe's private folder. Read on every call, so IRONPROBE_HOME set after import still counts.
export function ironprobeHome() {
  return path.resolve(process.env.IRONPROBE_HOME || path.join(os.homedir(), '.ironprobe'));
}

function readOk(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function executableOf(pw, n) {
  try {
    return pw[n].executablePath();
  } catch {
    return '';
  }
}

// Is the browser still on disk? For Chromium the small headless shell (all IronProbe needs) also counts.
function onDisk(n, exe) {
  if (!exe) return false;
  if (fs.existsSync(exe)) return true;
  const m = n === 'chromium' && /^(.*[\\/])chromium-(\d+)[\\/]/.exec(exe);
  return Boolean(m) && fs.existsSync(path.join(m[1], `chromium_headless_shell-${m[2]}`, 'INSTALLATION_COMPLETE'));
}

// A browser counts as present if it actually starts headless (for Chromium that is the small
// "headless shell", which is all IronProbe needs).
// Remembers browsers that started fine, per Playwright version, so later runs skip the check; a
// remembered browser that has since been deleted from disk is checked again.
// Kept in IronProbe's private folder (never a shared temp folder, where a planted link could redirect it).
export async function missingBrowsers(pw, names, log, home = ironprobeHome()) {
  const okFile = path.join(home, 'browsers-ok.json');
  const missing = [];
  const ok = readOk(okFile);
  for (const n of names) {
    const exe = executableOf(pw, n);
    const key = `${n}@${exe}@${process.env.PLAYWRIGHT_BROWSERS_PATH || ''}`;
    if (ok[key] && onDisk(n, exe)) continue;
    delete ok[key];
    try {
      const b = await pw[n].launch();
      await b.close();
      ok[key] = true;
    } catch (e) {
      if (/Executable doesn't exist/i.test(String(e.message))) missing.push(n);
      else log?.(`${n} is installed but cannot start: ${String(e.message).split('\n')[0]}. On Linux, run: npx playwright install-deps ${n}`);
    }
  }
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${okFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ok), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, okFile); // atomic, and replaces a planted link instead of following it
  } catch {
    /* cache is optional */
  }
  return missing;
}

// Downloads the given browsers with Playwright's own installer. Resolves to the names still missing.
export async function installBrowsers(names, log = console.log, signal, home) {
  if (!names.length) return [];
  // playwright's package exports hide cli.js, so locate it next to the package entry point.
  const cli = path.join(path.dirname(require.resolve('playwright')), 'cli.js');
  log(`Downloading the test browser${names.length > 1 ? 's' : ''} (${names.join(', ')}). This happens once and takes about a minute.`);
  await new Promise((resolve) => {
    // --only-shell: Chromium's headless shell is about a third of the full browser download.
    const child = spawn(process.execPath, [cli, 'install', ...(names.includes('chromium') ? ['--only-shell'] : []), ...names], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let last = 0;
    const onData = (buf) => {
      const pct = /(\d{1,3})%/.exec(String(buf));
      if (pct && Number(pct[1]) >= last + 25) {
        last = Number(pct[1]);
        log(`Downloading… ${last}%`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    // Never hang: give up after 10 minutes, or as soon as the run is stopped.
    const stop = () => {
      // Stop the installer and any download helper it started.
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        child.kill();
      }
    };
    const timer = setTimeout(stop, 10 * 60 * 1000);
    signal?.addEventListener('abort', stop);
    process.once('exit', stop); // never leave a download running after IronProbe exits
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      process.off('exit', stop);
      resolve();
    };
    child.on('error', done);
    child.on('close', done);
  });
  const pw = await import('playwright');
  const still = await missingBrowsers(pw, names, undefined, home);
  if (still.length) log(`Couldn't download ${still.join(', ')}. Check your internet connection, or run: npx playwright install ${still.join(' ')}`);
  else log('Test browser ready.');
  return still;
}

export async function ensureBrowsers(names, log, signal, home) {
  const pw = await import('playwright');
  return installBrowsers(await missingBrowsers(pw, names, log, home), log, signal, home);
}
