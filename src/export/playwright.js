// Export IronProbe UI suites to standard Playwright Test files, so tests stay plain code you own.
import fs from 'node:fs';
import path from 'node:path';
import { slug } from '../util.js';

const q = (s) => JSON.stringify(String(s));
// Text placed inside // comments: no line breaks, so it can never become code.
const commentSafe = (s) => String(s).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 200);

// Turns a string that may contain {{env.X}} / {{name}} into a JS expression.
function expr(value, baseUrl, used) {
  const s = String(value ?? '');
  if (!/\{\{/.test(s)) return q(s);
  const parts = s.split(/(\{\{\s*[^}\s]+\s*\}\})/g).filter((p) => p !== '');
  const js = parts.map((p) => {
    const m = /^\{\{\s*([^}\s]+)\s*\}\}$/.exec(p);
    if (!m) return p.replace(/[`\\$]/g, (c) => `\\${c}`);
    const key = m[1];
    if (key === 'baseUrl') return '${BASE_URL}';
    if (key.startsWith('env.')) return `\${process.env[${q(key.slice(4))}] ?? ''}`;
    used.add(key);
    return `\${vars[${q(key)}]}`;
  });
  return `\`${js.join('')}\``;
}

function urlExpr(u, baseUrl, used) {
  const s = String(u);
  return /^https?:\/\/|^chrome-extension:|^\{\{/.test(s) ? expr(s, baseUrl, used) : expr(`{{baseUrl}}${s}`, baseUrl, used);
}

function stepToCode(step, baseUrl, used) {
  const [action, arg] = Object.entries(step)[0];
  const x = (v) => expr(v, baseUrl, used);
  switch (action) {
    case 'goto': return `await page.goto(${urlExpr(arg, baseUrl, used)});`;
    case 'reload': return 'await page.reload();';
    case 'click': return `await page.locator(${x(arg)}).first().click();`;
    case 'fill': return `await page.locator(${x(arg.selector)}).first().fill(${x(arg.value ?? '')});`;
    case 'press': return typeof arg === 'string' ? `await page.keyboard.press(${x(arg)});` : `await page.locator(${x(arg.selector)}).first().press(${x(arg.key)});`;
    case 'select': return `await page.locator(${x(arg.selector)}).first().selectOption(${x(arg.value)});`;
    case 'check': return `await page.locator(${x(arg)}).first().check();`;
    case 'hover': return `await page.locator(${x(arg)}).first().hover();`;
    case 'waitFor':
    case 'expectVisible': return `await expect(page.locator(${x(arg)}).first()).toBeVisible();`;
    case 'expectHidden': return `await expect(page.locator(${x(arg)}).first()).toBeHidden();`;
    case 'expectText': return `await expect(page.locator(${x(arg.selector || 'body')}).first()).toContainText(${x(arg.text)});`;
    case 'expectUrl': return `await expect(page).toHaveURL(new RegExp(${q(arg)}));`;
    case 'expectTitle': return `await expect(page).toHaveTitle(new RegExp(${q(String(arg).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}));`;
    case 'wait': return `await page.waitForTimeout(${Math.min(Number(arg) || 0, 10000)});`;
    case 'screenshot': return `await page.screenshot({ path: ${q(`screenshots/${slug(arg || 'shot')}.png`)}, fullPage: true });`;
    case 'request': {
      const opts = [`method: ${q(arg.method || 'GET')}`];
      if (arg.headers) opts.push(`headers: { ${Object.entries(arg.headers).map(([k, v]) => `${q(k)}: ${x(v)}`).join(', ')} }`);
      if (arg.json !== undefined) opts.push(`data: ${JSON.stringify(arg.json)}`);
      const status = arg.expect?.status ?? 200;
      const check = Array.isArray(status) ? `expect(${JSON.stringify(status.map(Number))}).toContain(res.status());` : `expect(res.status()).toBe(${Number(status)});`;
      const extra = arg.expect?.body ? ' // body checks: see the IronProbe suite' : '';
      return `{ const res = await page.request.fetch(${urlExpr(arg.url, baseUrl, used)}, { ${opts.join(', ')} }); ${check} }${extra}`;
    }
    default: return `// Not exported: IronProbe step "${commentSafe(action)}"`;
  }
}

export function exportPlaywright(uiSuites, config, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const taken = new Set();
  for (const suite of uiSuites) {
    const used = new Set();
    let body = '';
    for (const t of suite.tests || []) {
      if (JSON.stringify(t.steps || []).includes('extensionId')) {
        body += `  // Needs the Chrome extension loaded in a persistent context; see https://playwright.dev/docs/chrome-extensions\n`;
        body += `  test.skip(${q(t.name)}, async () => {});\n\n`;
        continue;
      }
      body += `  test(${q(t.name)}, async ({ page }) => {\n`;
      for (const s of t.steps || []) body += `    ${stepToCode(s, config.baseUrl || '', used)}\n`;
      body += '  });\n\n';
    }
    let head = `// From the IronProbe suite "${commentSafe(suite.name)}". Plain Playwright Test: edit freely.\nimport { test, expect } from '@playwright/test';\n\n`;
    head += `const BASE_URL = process.env.BASE_URL ?? ${q(config.baseUrl || '')};\n`;
    if (used.size) head += `// Values IronProbe captured at run time. Fill these in or load them in a beforeAll hook.\nconst vars = { ${[...used].map((k) => `${q(k)}: ''`).join(', ')} };\n`;
    const code = `${head}\ntest.describe(${q(suite.name)}, () => {\n${body}});\n`;
    let base = slug(suite.name);
    for (let n = 2; taken.has(base); n++) base = `${slug(suite.name)}-${n}`;
    taken.add(base);
    const file = path.join(outDir, `${base}.spec.ts`);
    fs.writeFileSync(file, code);
    files.push(file);
  }
  const browsers = config.ui?.browsers || ['chromium'];
  const devices = config.ui?.devices || ['Desktop'];
  const projects = browsers.flatMap((b) => devices.map((d) => {
    const name = `${b} ${d}`;
    const use = d === 'Desktop' ? `{ browserName: ${q(b)} }` : `{ ...devices[${q(d)}], browserName: ${q(b)}${b === 'firefox' ? ', isMobile: false' : ''} }`;
    return `    { name: ${q(name)}, use: ${use} },`;
  }));
  const retries = Math.max(0, Math.min(5, Number(config.ui?.retries ?? 1) || 0));
  const cfg = `import { defineConfig, devices } from '@playwright/test';\n\nexport default defineConfig({\n  testDir: '.',\n  retries: ${retries},\n  use: { trace: 'retain-on-failure' },\n  reporter: [['html'], ['junit', { outputFile: 'junit.xml' }]],\n  projects: [\n${projects.join('\n')}\n  ],\n});\n`;
  fs.writeFileSync(path.join(outDir, 'playwright.config.ts'), cfg);
  files.push(path.join(outDir, 'playwright.config.ts'));
  return files;
}
