// Plain-language wording shared by the dashboard and the report, so both tell the same story.

const A11Y = {
  'color-contrast': 'text is too faint to read',
  'image-alt': 'an image has no description',
  'link-name': 'a link has no readable name',
  'button-name': 'a button has no readable name',
  label: 'a form field has no label',
  'html-has-lang': 'the page does not say its language',
  'document-title': 'the page has no title',
  'target-size': 'a tap target is too small',
  'aria-required-attr': 'an element is missing required accessibility details',
  'heading-order': 'headings skip a level',
  region: 'some content is outside the page landmarks',
  'meta-viewport': 'zooming is blocked on phones',
  'frame-title': 'an embedded frame has no title',
  'select-name': 'a dropdown has no label',
  'duplicate-id-aria': 'two elements share the same id',
};

// Area names used everywhere.
export const AREAS = { api: 'API', ui: 'User flows', pages: 'Pages', crawl: 'Other pages', load: 'Load' };

export const CAUSES = { app: 'App bug', test: 'Test issue', infrastructure: 'Setup', login: 'Needs login' };

export function a11yRuleName(id) {
  return A11Y[id] || String(id).replace(/-/g, ' ');
}

// Turns one technical failure message into a sentence a non-developer understands.
export function plainProblem(message) {
  const m = String(message ?? '');
  let x;
  if ((x = /^status: expected (\[?[\d, ]+\]?), got (\d+)/.exec(m))) {
    const got = Number(x[2]);
    if (got === 401 || got === 403) return 'Needs a login. Add an API token and run again.';
    if (got >= 500) return `The server crashed (error ${got}) instead of answering ${x[1].replace(/[[\]]/g, '')}.`;
    return `Answered ${got} instead of ${x[1].replace(/[[\]]/g, '')}.`;
  }
  if ((x = /^status: (\d+) is a server error for an edge-case input/.exec(m))) return `The server crashed (error ${x[1]}) on an unusual input.`;
  if ((x = /^time: (\d+) ms is over the (\d+) ms budget/.exec(m))) return `Too slow: ${x[1]} ms, the limit is ${x[2]} ms.`;
  if ((x = /^(\d+) critical\/serious accessibility issue\(s\)(?::\s*(.+))?/.exec(m))) {
    const rules = (x[2] || '').split(',').map((s) => s.trim()).filter(Boolean).map(a11yRuleName);
    const n = Number(x[1]);
    return `${n} serious accessibility problem${n === 1 ? '' : 's'}${rules.length ? `: ${rules.join('; ')}` : ''}.`;
  }
  if ((x = /^step (\d+) \(expectText\): text "(.+)" not found/.exec(m))) return `Step ${x[1]}: expected to see "${x[2]}" on the page, but it is not there.`;
  if ((x = /^step (\d+) \((\w+)\): (.+)/.exec(m))) return `Step ${x[1]} (${x[2]}) failed: ${x[3]}`;
  if ((x = /^visual change: (\d+) pixels/.exec(m))) return `The page looks different from last time (${x[1]} pixels changed).`;
  if ((x = /^HTTP (\d+)/.exec(m))) return `The page returned error ${x[1]}.`;
  if ((x = /^(\d+) console error/.exec(m))) return `${x[1]} error message${Number(x[1]) === 1 ? '' : 's'} in the browser console.`;
  if ((x = /^(LCP|FCP|TTFB|CLS) ([\d.]+) over budget ([\d.]+)/.exec(m))) {
    const names = { LCP: 'Main content shows late', FCP: 'First paint is late', TTFB: 'Server answers slowly', CLS: 'The page jumps around while loading' };
    return `${names[x[1]]}: ${x[2]}${x[1] === 'CLS' ? '' : ' ms'} (limit ${x[3]}${x[1] === 'CLS' ? '' : ' ms'}).`;
  }
  if (/navigation to a host outside allowedHosts was blocked/.test(m)) return 'The page tried to send you to another website, so IronProbe stopped it.';
  if (/^schema:/.test(m)) return 'The response is missing data the spec promises.';
  if (/extract .+ not found/.test(m)) return 'A value needed by later checks was missing from the response.';
  return m;
}

// Keeps only warnings a person can act on, in plain words.
export function friendlyWarnings(list = []) {
  const out = [];
  for (const w of list) {
    if (/needs auth|only GET\/HEAD|Fuzz tests check|includeWrites|\{\{env\./i.test(w)) continue;
    if (/browser\/device combination|No browser could run/i.test(w)) out.push('Some browsers are not installed yet. Run "npx playwright install" once.');
    else if (/hard-coded secret/i.test(w)) out.push(w.replace(/Use \{\{env\.NAME\}\} instead\./, 'Remove it from the file before sharing it.'));
    else out.push(w);
  }
  return [...new Set(out)].slice(0, 5);
}

