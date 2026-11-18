// JUnit XML for CI systems.
function x(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function suite(name, cases) {
  const failures = cases.filter((c) => !c.passed && !c.skipped).length;
  const skipped = cases.filter((c) => c.skipped).length;
  let out = `  <testsuite name="${x(name)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">\n`;
  for (const c of cases) {
    out += `    <testcase classname="${x(c.classname)}" name="${x(c.name)}" time="${((c.ms || 0) / 1000).toFixed(3)}">`;
    if (c.skipped) out += '<skipped/>';
    else if (!c.passed) out += `<failure message="${x((c.failures || [])[0] || 'failed')}">${x((c.failures || []).join('\n'))}</failure>`;
    out += '</testcase>\n';
  }
  return `${out}  </testsuite>\n`;
}

export function renderJunit(r) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="IronProbe">\n';
  if (r.api.length) out += suite('API', r.api.map((a) => ({ ...a, classname: a.suite })));
  if (r.ui.tests.length) out += suite('UI', r.ui.tests.map((t) => ({ ...t, classname: `${t.browser}.${t.device}`, ms: t.durationMs })));
  if (r.ui.pages.length) out += suite('Pages', r.ui.pages.map((p) => ({ ...p, name: p.url, classname: `${p.browser}.${p.device}` })));
  if (r.crawl?.pages?.length) out += suite('Crawl', r.crawl.pages.map((p) => ({ ...p, name: p.url, classname: 'crawl' })));
  if (r.load) out += suite('Load', [{ ...r.load, name: `${r.load.method} ${r.load.url}`, classname: 'load' }]);
  return `${out}</testsuites>\n`;
}
