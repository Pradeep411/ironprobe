// Self-contained HTML report. No scripts, strict CSP, all content escaped, light + dark themes.
import { escapeHtml as e, round } from '../util.js';
import { niceAxis, lines, legend } from './charts.js';
import { gaugeSvg } from './gauge.js';
import { CONDENSED_WOFF2, SANS_400_WOFF2, SANS_600_WOFF2 } from './font.js';
import { AREAS, CAUSES, plainProblem, a11yRuleName, friendlyWarnings } from '../plain.js';

const CSS = `
/* Design: the same precision instrument as the dashboard. Steel grid, graphite ink, one signal-yellow
   accent, IBM Plex, the calibrated gauge and inspection tags. Status colour always comes with an icon and a word.
   The reader's task is "what do I fix?", so the verdict and the fix list come first. */
@font-face{font-family:"Plex Sans";src:url(data:font/woff2;base64,${SANS_400_WOFF2}) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Plex Sans";src:url(data:font/woff2;base64,${SANS_600_WOFF2}) format("woff2");font-weight:600;font-display:swap}
@font-face{font-family:"Plex Condensed";src:url(data:font/woff2;base64,${CONDENSED_WOFF2}) format("woff2");font-weight:600;font-display:swap}
:root{color-scheme:light;--surface-0:#e9edf0;--surface-1:#ffffff;--border:#d3d9de;--text-primary:#1c2329;--text-secondary:#3a444d;--text-muted:#56616b;--signal:#f5c518;--face:#f7f9fa;--tick:#8a959e;--edge:#7a858f;--hole-shade:#bac3ca;--hole-ring:#f1f4f6;
--good-arc:#2a9d5c;--warn-arc:#e0a100;--bad-arc:#d64035;--good-text:#1e7a46;--warn-text:#8a5a00;--bad-text:#b3261e;
--grid:#e3e8ec;--grid-line:rgba(28,35,41,.045);--series-1:#3a444d;--series-2:#8a959e;
--status-good:var(--good-arc);--status-warning:var(--warn-arc);--status-serious:var(--warn-arc);--status-critical:var(--bad-arc);--status-neutral:var(--tick);
--font-body:"Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-display:"Plex Condensed","Plex Sans",ui-sans-serif,system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--surface-0:#12171b;--surface-1:#1b2228;--border:#2d363e;--text-primary:#e8ecef;--text-secondary:#c3ccd3;--text-muted:#9aa6b0;--face:#161c21;--tick:#6e7a84;--edge:#7d8994;--hole-shade:#0a0e11;--hole-ring:#222a31;
--good-arc:#4cc27c;--warn-arc:#e8a93a;--bad-arc:#ff6b5f;--good-text:#5cc98a;--warn-text:#f0b552;--bad-text:#ff7a70;
--grid:#2a333a;--grid-line:rgba(232,236,239,.035);--series-1:#c3ccd3;--series-2:#6e7a84}}
*{box-sizing:border-box}html,body{overflow-x:clip}html{-webkit-text-size-adjust:100%}
body{margin:0;background-color:var(--surface-0);color:var(--text-primary);font-family:var(--font-body);font-size:15px;line-height:1.55;
background-image:linear-gradient(var(--grid-line) 1px,transparent 1px),linear-gradient(90deg,var(--grid-line) 1px,transparent 1px);background-size:24px 24px}
:focus-visible{outline:3px solid var(--text-primary);outline-offset:2px;border-radius:4px}
main{max-width:1080px;margin:0 auto;padding:36px 20px 64px}
h1,h2{font-family:var(--font-display);font-weight:600;letter-spacing:-.01em}
h1{font-size:44px;line-height:1.05;margin:0 0 10px;overflow-wrap:anywhere}h2{font-size:24px;line-height:1.1;margin:44px 0 14px}h3{font-size:15px;font-weight:600;margin:20px 0 8px;color:var(--text-secondary)}
b,strong,th{font-weight:600}p{margin:0}
.g{width:100%;height:auto;display:block}.g-face{fill:var(--face);stroke:var(--border)}.g-band{fill:none;stroke-width:8}.g-bad{stroke:var(--bad-arc)}.g-warn{stroke:var(--warn-arc)}.g-good{stroke:var(--good-arc)}.g-tick{stroke:var(--tick);stroke-width:1.2}.g-major{stroke:var(--text-primary);stroke-width:2}.g-num{fill:var(--text-muted);font-size:11px;text-anchor:middle}.g-needle,.g-hub{fill:var(--text-primary)}.g-cap{fill:var(--signal)}.g-read{fill:var(--text-primary);font-family:var(--font-display);font-weight:600;font-size:46px;text-anchor:middle}.g-unit{fill:var(--text-muted);font-size:12px;text-anchor:middle}
.head{display:flex;gap:32px;align-items:center;justify-content:space-between}.head-text{min-width:0}
.dialbox{width:232px;flex:none;background:var(--surface-1);border:1px solid var(--border);border-radius:18px;padding:12px;box-shadow:0 1px 0 rgba(28,35,41,.06),0 10px 30px -12px rgba(28,35,41,.25)}
.eyebrow{font-family:var(--font-display);font-weight:600;font-size:18px;color:var(--text-secondary);margin:0 0 6px;overflow-wrap:anywhere}
.verdict-line{font-size:18px;color:var(--text-secondary);margin:0 0 6px}
.sub{color:var(--text-muted);margin:0}
.ok{color:var(--good-text)}.warn{color:var(--warn-text)}.bad{color:var(--bad-text)}.muted{color:var(--text-muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:28px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.tile b{display:block;font-family:var(--font-display);font-size:30px;line-height:1.2;font-variant-numeric:tabular-nums}.tile span{color:var(--text-muted);font-size:14px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:last-child>*{border-bottom:0}
th{color:var(--text-secondary)}td.num,th.num{font-variant-numeric:tabular-nums;text-align:right}td.num,.pill{white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:5px;font-size:12px;font-weight:600;border:1px solid var(--border)}
.pill.ok{border-color:color-mix(in srgb,var(--good-text) 40%,var(--border))}.pill.bad{border-color:color-mix(in srgb,var(--bad-text) 40%,var(--border))}
.cell{display:flex;align-items:center;gap:6px}
/* bar charts are plain HTML so labels keep their size and nothing is clipped on a phone */
.bars{list-style:none;margin:4px 0 14px;padding:0;display:grid;grid-template-columns:fit-content(240px) minmax(80px,1fr) max-content;column-gap:12px;font-size:14px;max-width:760px}
.bars li{display:grid;grid-template-columns:subgrid;grid-column:1/-1;align-items:center;min-height:30px;border-radius:6px}
.bars li:hover{background:color-mix(in srgb,var(--grid) 45%,transparent)}
.b-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.b-track{position:relative;align-self:stretch;min-width:0;border-right:1px solid var(--grid);background:linear-gradient(90deg,var(--grid) 1px,transparent 1px) 0 0/calc(100%/var(--n,4)) 100%}
.b-fill{position:absolute;left:0;top:50%;height:12px;margin-top:-6px;min-width:2px;border-radius:0 3px 3px 0;background:var(--series-1)}
.b-limit{position:absolute;top:0;bottom:0;border-left:1.5px dashed var(--text-primary)}
.b-val{font-variant-numeric:tabular-nums;color:var(--text-secondary);white-space:nowrap}
.bars .b-axis{min-height:22px;color:var(--text-muted);font-size:12px}.bars .b-axis:hover{background:none}
.b-axis .b-track{background:none;border:0}.b-axis i{position:absolute;top:4px;transform:translateX(-50%);font-style:normal;white-space:nowrap;font-variant-numeric:tabular-nums}
.b-axis i:last-child{transform:translateX(-100%)}.b-axis i:first-child{transform:none}
@supports not (grid-template-columns:subgrid){.bars{display:block}.bars li{grid-template-columns:minmax(0,220px) minmax(80px,1fr) 132px;column-gap:12px}}
.chart{width:100%;max-width:720px;height:auto;display:block}.chart text{fill:var(--text-secondary);font-size:12px}.chart .label{fill:var(--text-primary)}
.chart .value,.chart .direct{fill:var(--text-primary);font-size:12px}.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .hit{fill:transparent}.chart .mark:hover circle:not(.hit){opacity:.8}.chart .mark:hover .hit{fill:var(--grid)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary);margin:4px 0 8px}.legend i{display:inline-block;width:12px;height:4px;border-radius:2px;margin-right:6px;vertical-align:middle}
ul.fails{margin:6px 0 0;padding-left:18px}ul.fails li{margin:2px 0}
code,pre{font-family:var(--font-mono);font-size:12.5px}td code,p code{overflow-wrap:anywhere}pre{white-space:pre-wrap;word-break:break-word;background:var(--surface-0);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:240px;overflow:auto;margin:0 0 8px}
summary{cursor:pointer;color:var(--text-secondary);font-weight:600;padding:11px 2px;min-height:44px;width:max-content;max-width:100%}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--signal);text-decoration-thickness:2px;text-underline-offset:4px}
img.shot{max-width:100%;border:1px solid var(--border);border-radius:8px;margin-top:8px}
footer{margin-top:48px;color:var(--text-muted);font-size:13px}
.note{margin:0 0 10px;color:var(--text-secondary);font-size:14px}
/* fix list: the dashboard's inspection tags (cut end corners with drawn edges, a real punched hole with a rim) */
.fix{list-style:none;padding:0;margin:0;display:grid;gap:12px;max-width:760px}
.fix li{--cut:16px;--hole-x:calc(100% - 25px);position:relative;background:var(--surface-1);border:1px solid var(--border);border-left:6px solid var(--bad-arc);border-radius:10px 0 0 10px;padding:14px 56px 14px 18px;min-height:68px;
clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% calc(100% - var(--cut)),calc(100% - var(--cut)) 100%,0 100%);}
.fix li::before{content:"";position:absolute;top:-1px;bottom:-1px;right:-1px;width:var(--cut);pointer-events:none;background:
linear-gradient(to top right,transparent calc(50% - 1.6px),var(--border) calc(50% - 1.2px),var(--border) 100%) top/var(--cut) var(--cut) no-repeat,
linear-gradient(to bottom right,transparent calc(50% - 1.6px),var(--border) calc(50% - 1.2px),var(--border) 100%) bottom/var(--cut) var(--cut) no-repeat}
.fix li::after{content:"";position:absolute;left:var(--hole-x);top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;pointer-events:none;border-radius:50%;background:
radial-gradient(circle at 50% 58%,var(--surface-0) 5px,transparent 6.5px),
radial-gradient(circle,var(--hole-shade) 6px,var(--edge) 6.4px,var(--edge) 7px,var(--hole-ring) 7.6px,var(--hole-ring) 12px,var(--border) 12.5px,var(--border) 13px)}
.fix li.test,.fix li.infrastructure,.fix li.login,.fix li.more{border-left-color:var(--warn-arc)}.fix li.more{border-left-color:var(--tick)}
.fix .what{font-weight:600;font-size:17px;overflow-wrap:anywhere}.fix .why{color:var(--text-secondary);margin-top:4px;overflow-wrap:anywhere}.fix .meta{color:var(--text-muted);font-size:14px;margin-top:6px;overflow-wrap:anywhere}
.fix a{text-decoration:none;display:inline-block;padding:11px 0;margin:-11px 0}.fix a:hover{text-decoration:underline}
.tag{display:inline-block;font-size:12px;font-weight:600;border-radius:5px;padding:1px 8px;margin-right:8px;vertical-align:2px;background:color-mix(in srgb,var(--bad-text) 10%,transparent);color:var(--bad-text)}
.test .tag,.infrastructure .tag,.login .tag{background:color-mix(in srgb,var(--warn-text) 12%,transparent);color:var(--warn-text)}
@media (max-width:900px){h1{font-size:38px}.dialbox{width:200px}.head{gap:24px}}
@media (max-width:600px){main{padding:24px 16px 48px}h1{font-size:32px}h2{font-size:22px;margin-top:36px}.tile b{font-size:26px}
.head{flex-direction:column;align-items:stretch;gap:20px}.dialbox{width:100%}.dialbox .g{max-width:220px;margin:0 auto}
.col-req,.col-extra{display:none}td code{word-break:break-all}table{font-size:13.5px}th,td{padding:8px 6px}
.bars{display:block;font-size:14px}.bars li{grid-template-columns:minmax(0,1fr) max-content;column-gap:10px;padding:4px 0}.b-label{grid-column:1/-1;white-space:normal;overflow-wrap:anywhere}.b-track{height:20px}.bars .b-axis{display:none}
.chart text,.chart .value,.chart .direct{font-size:26px}.fix li{padding-right:48px}}
@media print{body{background:#fff}.dialbox{box-shadow:none}}
`;

const pl = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;

// Horizontal bars as plain HTML (inline styles only; the CSP allows them). rows: [{label, value, title, status?, display?}].
function bars(rows, { unit = '', budget = null, max = null, integer = false } = {}) {
  if (!rows.length) return '';
  const axis = niceAxis(max ?? Math.max(...rows.map((r) => r.value), budget ?? 0), { integer });
  const pct = (v) => round(Math.max(0, Math.min(1, v / axis.top)) * 100, 2);
  let s = `<ul class="bars" style="--n:${axis.values.length - 1}">`;
  for (const r of rows) {
    const fill = r.status ? `;background:var(--status-${r.status})` : '';
    s += `<li title="${e(r.title || `${r.label}: ${r.value}${unit}`)}"><span class="b-label">${e(r.label)}</span><span class="b-track">`;
    if (r.value > 0) s += `<i class="b-fill" style="width:${pct(r.value)}%${fill}"></i>`;
    if (budget != null) s += `<i class="b-limit" style="left:${pct(budget)}%"></i>`;
    s += `</span><span class="b-val">${e(r.display ?? `${r.value}${unit}`)}</span></li>`;
  }
  s += `<li class="b-axis" aria-hidden="true"><span></span><span class="b-track">${axis.values.map((v) => `<i style="left:${pct(v)}%">${e(v)}${e(unit)}</i>`).join('')}</span><span></span></li></ul>`;
  if (budget != null) s += `<p class="note">The dashed line is the limit: ${e(budget)}${e(unit)}.</p>`;
  return s;
}

const ICON = { pass: '✓', fail: '✕', skip: '–', warn: '!' };
const cap = (s) => { const t = String(s ?? ''); return ({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' })[t] || t; };

function status(passed, skipped) {
  if (skipped) return `<span class="pill muted">${ICON.skip} Skipped</span>`;
  return passed ? `<span class="pill ok">${ICON.pass} Pass</span>` : `<span class="pill bad">${ICON.fail} Fail</span>`;
}

function fails(list, category) {
  const cause = category ? `<span class="pill">${e(CAUSES[category] || category)}</span> ` : '';
  if (!list?.length) return '';
  const plain = list.map((f) => plainProblem(f));
  const changed = plain.some((p, i) => p !== String(list[i]));
  return `<ul class="fails">${plain.map((f, i) => `<li>${i === 0 ? cause : ''}${e(f)}</li>`).join('')}</ul>${changed ? `<details><summary>Technical details</summary><pre>${e(list.join('\n'))}</pre></details>` : ''}`;
}

function flakyTag(x) {
  return x.flaky ? ' <span class="pill muted">flaky</span>' : '';
}

function img(name) {
  return name ? `<details><summary>Screenshot</summary><img class="shot" src="artifacts/${encodeURIComponent(name)}" alt="Screenshot ${e(name)}"></details>` : '';
}

function areaRows(r) {
  const area = (name, items, isPass = (x) => x.passed, isSkip = (x) => x.skipped) => {
    const total = items.length;
    const skipped = items.filter(isSkip).length;
    const passed = items.filter((x) => !isSkip(x) && isPass(x)).length;
    return { name, total, passed, failed: total - passed - skipped, skipped };
  };
  return [
    area(AREAS.api, r.api),
    area(AREAS.ui, r.ui.tests),
    area(AREAS.pages, r.ui.pages),
    area(AREAS.crawl, r.crawl?.pages || []),
    area(AREAS.load, r.load ? [r.load] : []),
  ].filter((a) => a.total);
}

function matrix(r) {
  const everything = [...r.ui.tests, ...r.ui.pages, ...r.ui.skippedCombos];
  const browsers = [...new Set(everything.map((x) => x.browser))];
  const devices = [...new Set(everything.map((x) => x.device))];
  if (!browsers.length) return '';
  let h = '<table><thead><tr><th>Device</th>';
  for (const b of browsers) h += `<th>${e(cap(b))}</th>`;
  h += '</tr></thead><tbody>';
  for (const d of devices) {
    h += `<tr><th>${e(d)}</th>`;
    for (const b of browsers) {
      const items = [...r.ui.tests, ...r.ui.pages].filter((x) => x.browser === b && x.device === d);
      const skip = r.ui.skippedCombos.find((x) => x.browser === b && x.device === d);
      if (skip) {
        h += `<td><div class="cell" title="${e(skip.reason)}"><span class="muted">${ICON.skip} not run</span></div></td>`;
        continue;
      }
      const ok = items.filter((x) => x.passed).length;
      const st = !items.length ? 'neutral' : ok === items.length ? 'good' : ok === 0 ? 'critical' : 'serious';
      const label = !items.length ? 'no checks' : `${ok}/${items.length} passed`;
      h += `<td><div class="cell ${st === 'good' ? 'ok' : st === 'neutral' ? 'muted' : 'bad'}" title="${e(`${b} on ${d}: ${label}`)}">${st === 'good' ? ICON.pass : st === 'neutral' ? ICON.skip : ICON.fail} ${e(label)}</div></td>`;
    }
    h += '</tr>';
  }
  const notes = [...new Set(r.ui.skippedCombos.map((x) => x.reason))];
  return `${notes.map((n) => `<p class="note">${ICON.skip} ${e(n)}</p>`).join('')}${h}</tbody></table>`;
}

export function renderHtml(r, history = []) {
  const areas = areaRows(r);
  const total = areas.reduce((a, x) => a + x.total, 0);
  const failed = areas.reduce((a, x) => a + x.failed, 0);
  const skipped = areas.reduce((a, x) => a + x.skipped, 0);
  const passed = total - failed - skipped;
  const rate = total - skipped ? round(((passed) / (total - skipped)) * 100, 1) : 0;
  const ok = failed === 0;
  let b = '';

  const health = r.health || { score: null, label: 'Nothing ran' };
  const score = health.score;
  const ring = `<div class="dialbox" role="img" aria-label="${score == null ? 'No score' : `Health score ${score} out of 100`}">${gaugeSvg(score)}</div>`;
  const nothing = total - skipped === 0;
  const headline = nothing ? 'Nothing ran' : score == null ? health.label || "Couldn't finish" : health.label;
  const when = new Date(r.meta.startedAt).toLocaleString('en-GB');
  b += `<header class="head"><div class="head-text"><p class="eyebrow">${e(r.meta.name)} test report</p><h1>${e(headline)}</h1><p class="verdict-line">${nothing ? 'Check the config and the --only option.' : `${passed} of ${total - skipped} checks passed${failed ? `, ${failed} to fix` : ''}.`}</p><p class="sub">Tested ${e(when)} in ${e(round(r.meta.durationMs / 1000, 1))} seconds with IronProbe ${e(r.meta.version)}.</p></div>${ring}</header>`;
  b += `<section class="tiles"><div class="tile"><b>${rate}%</b><span>checks passed</span></div><div class="tile"><b class="${failed ? 'bad' : ''}">${failed}</b><span>to fix</span></div>${skipped ? `<div class="tile"><b>${skipped}</b><span>skipped</span></div>` : ''}`;
  if (r.api.length) {
    const ms = r.api.filter((x) => x.ms != null).map((x) => x.ms).sort((a, c) => a - c);
    if (ms.length) b += `<div class="tile"><b>${ms[Math.max(0, Math.ceil(ms.length * 0.95) - 1)]} ms</b><span>95% of API answers came back within this time</span></div>`;
  }
  b += '</section>';

  // Fix these first: every failure in one list, app bugs first, linked to its section.
  const order = { app: 0, test: 1, infrastructure: 2 };
  const todo = [
    ...r.api.filter((x) => !x.passed && !x.skipped).map((x) => ({ x, where: 'api', label: x.name })),
    ...r.ui.tests.filter((x) => !x.passed).map((x) => ({ x, where: 'ui', label: `${x.name} on ${cap(x.browser)} ${x.device}` })),
    ...r.ui.pages.filter((x) => !x.passed).map((x) => ({ x: { ...x, category: x.category || 'app' }, where: 'pages', label: `Page ${new URL(x.url).pathname} on ${cap(x.browser)} ${x.device}` })),
    ...(r.crawl?.pages || []).filter((x) => !x.passed).map((x) => ({ x: { ...x, category: 'app' }, where: 'crawl', label: `${AREAS.crawl}: ${new URL(x.url).pathname}` })),
    ...(r.load && !r.load.passed ? [{ x: { ...r.load, category: 'app' }, where: 'load', label: `Load ${r.load.method} ${r.load.url}` }] : []),
  ].sort((a, c) => (order[a.x.category] ?? 3) - (order[c.x.category] ?? 3));
  // Same grouping as the dashboard: one line per endpoint for unusual-input (fuzz) crashes.
  for (let i = 0; i < todo.length; i++) {
    const m = /^fuzz (\S+) (.+)$/.exec(todo[i].label);
    if (!m) continue;
    const inputs = [m[2]];
    for (let j = todo.length - 1; j > i; j--) {
      const n = /^fuzz (\S+) (.+)$/.exec(todo[j].label);
      if (n && n[1] === m[1]) {
        inputs.unshift(n[2]);
        todo.splice(j, 1);
      }
    }
    todo[i] = { ...todo[i], label: `API: ${m[1]}`, inputs: inputs.reverse() };
  }
  if (todo.length) {
    b += '<h2 id="fix">Fix these first</h2><ol class="fix">';
    for (const t of todo.slice(0, 25)) {
      const cause = t.x.category in CAUSES ? t.x.category : 'app';
      const also = (t.x.failures || []).slice(1, 3).map((f) => plainProblem(f));
      const why = [plainProblem(t.x.failures?.[0] || 'failed'), ...also].join(' Also: ').replace('on an unusual input', t.inputs ? 'on unusual inputs' : 'on an unusual input');
      b += `<li class="${cause}"><p class="what"><span class="tag">${e(CAUSES[cause])}</span><a href="#${t.where}">${e(t.label)}</a></p><p class="why">${e(why)}</p>${t.inputs ? `<p class="meta">Inputs that broke it: ${e(t.inputs.join(', '))}</p>` : ''}</li>`;
    }
    if (todo.length > 25) b += `<li class="more"><p class="why">…and ${todo.length - 25} more in the sections below.</p></li>`;
    b += '</ol>';
  }

  const logins = r.api.filter((x) => x.category === 'login' && x.skipped).length;
  if (logins) b += `<p class="note" style="margin-top:16px">${logins} API check${logins === 1 ? '' : 's'} needed a login and ${logins === 1 ? 'was' : 'were'} skipped. Add an API token and run again.</p>`;

  // Results by area
  b += '<h2>Results by area</h2><div class="card">';
  b += bars(areas.map((a) => ({ label: a.name, value: a.total - a.skipped ? round((a.passed / (a.total - a.skipped)) * 100, 1) : 0, display: `${a.passed}/${a.total - a.skipped} passed`, status: a.failed ? (a.passed ? 'warning' : 'critical') : 'good', title: `${a.name}: ${a.passed} passed, ${a.failed} failed, ${a.skipped} skipped` })), { unit: '%', max: 100 });
  b += '<table><thead><tr><th>Area</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Skipped</th></tr></thead><tbody>';
  for (const a of areas) b += `<tr><td>${e(a.name)}</td><td class="num">${a.passed}</td><td class="num ${a.failed ? 'bad' : ''}">${a.failed}</td><td class="num">${a.skipped}</td></tr>`;
  b += '</tbody></table></div>';

  // Failures by cause + flaky
  // Same counting as the fix list: page and crawl failures are app bugs unless marked otherwise.
  const failedItems = [...r.api, ...r.ui.tests, ...r.ui.pages, ...(r.crawl?.pages || []), ...(r.engineErrors || [])]
    .filter((x) => !x.passed && !x.skipped)
    .map((x) => ({ ...x, category: x.category || 'app' }));
  const flaky = [...r.api, ...r.ui.tests].filter((x) => x.flaky);
  if (failedItems.length || flaky.length) {
    const causes = { app: CAUSES.app, test: CAUSES.test, infrastructure: CAUSES.infrastructure };
    b += '<h2>Why things failed</h2><div class="card">';
    if (failedItems.length) {
      b += bars(Object.entries(causes).map(([k, label]) => ({ label, value: failedItems.filter((x) => x.category === k).length, title: `${label}: ${failedItems.filter((x) => x.category === k).length}` })), { unit: '', integer: true });
      b += '<p class="muted">App bugs need a fix in your product, test issues need a fix in the test, setup problems need a fix in how it was run. The cause is a best guess from the error message.</p>';
    }
    if (flaky.length) {
      b += `<h3>${pl(flaky.length, 'flaky test')}: failed first, passed on retry</h3><ul class="fails">${flaky.map((x) => `<li>${e(x.name)}${x.browser ? ` on ${e(cap(x.browser))} ${e(x.device)}` : ''}${x.flakyReason ? ` <span class="muted">(first failure: ${e(x.flakyReason)})</span>` : ''}</li>`).join('')}</ul>`;
    }
    b += '</div>';
  }

  // Trend
  // Trend of the health score (older runs without a score fall back to their pass rate).
  const safeHistory = history.map((h) => ({ startedAt: String(h?.startedAt ?? ''), value: Number.isFinite(Number(h?.score)) && h?.score !== null ? Number(h.score) : Number(h?.passRate) || 0 }));
  const runs = score == null ? [] : [...safeHistory.slice(-19), { startedAt: r.meta.startedAt, value: score }];
  if (runs.length === 2) {
    b += `<p class="note" style="margin-top:16px">Health score ${e(runs[1].value)} (last run ${e(runs[0].value)}). A trend chart appears from the third run.</p>`;
  } else if (runs.length > 2) {
    b += '<h2>Health score over recent runs</h2><div class="card">';
    b += lines([{ name: 'Score', colorVar: '--series-1', points: runs.map((h, i) => ({ x: i + 1, y: h.value, title: `Run ${i + 1} (${new Date(h.startedAt).toLocaleString('en-GB')}): ${h.value}` })) }], { unit: '', yMax: 100, xLabel: 'run' });
    b += '</div>';
  }

  // Cross-browser matrix
  if (r.ui.tests.length || r.ui.pages.length || r.ui.skippedCombos.length) {
    b += `<h2>Browsers and devices</h2><div class="card">${matrix(r)}</div>`;
  }

  // API
  if (r.api.length) {
    const timed = r.api.filter((x) => x.ms != null);
    b += '<h2 id="api">API tests</h2><div class="card"><h3>Response time per request</h3>';
    b += bars(timed.map((x) => ({ label: `${x.skipped ? ICON.skip : x.passed ? ICON.pass : ICON.fail} ${x.name}`, value: x.ms, display: x.budgetMs != null ? `${x.ms} ms (limit ${x.budgetMs})` : `${x.ms} ms`, status: x.skipped ? 'neutral' : x.passed ? null : 'critical', title: `${x.method} ${x.url}: ${x.status}, ${x.ms} ms, ${x.passed ? 'passed' : 'failed'}` })), { unit: ' ms' });
    b += '<p class="note">Red bars are failed requests. Grey bars were skipped.</p>';
    b += '<table><thead><tr><th>Result</th><th>Test</th><th class="col-req">Request</th><th class="num">Status</th><th class="num">Time</th></tr></thead><tbody>';
    for (const x of r.api) {
      b += `<tr><td>${status(x.passed, x.skipped)}</td><td>${e(x.name)}${flakyTag(x)}${x.phase ? ` <span class="pill muted">${e(x.phase)}</span>` : ''}${x.skipped ? `<div class="muted">${e(x.reason)}</div>${x.failures?.length ? `<details><summary>Technical details</summary><pre>${e(x.failures.join('\n'))}</pre></details>` : ''}` : fails(x.failures, x.category)}${(x.warnings || []).map((w) => `<div class="muted">! ${e(w)}</div>`).join('')}`;
      if (!x.passed && x.responseSnippet) b += `<details><summary>Response</summary><pre>${e(x.responseSnippet)}</pre></details>`;
      b += `</td><td class="col-req"><code>${e(x.method || '')} ${e(x.url || '')}</code></td><td class="num">${e(x.status ?? '–')}</td><td class="num">${x.ms != null ? `${x.ms} ms` : '–'}</td></tr>`;
    }
    b += '</tbody></table></div>';
  }

  // UI tests
  if (r.ui.tests.length) {
    b += '<h2 id="ui">UI tests</h2><div class="card"><table><thead><tr><th>Result</th><th>Test</th><th>Browser</th><th>Device</th><th class="num">Time</th></tr></thead><tbody>';
    for (const x of r.ui.tests) {
      b += `<tr><td>${status(x.passed)}</td><td>${e(x.name)}${flakyTag(x)}${fails(x.failures, x.category)}${x.console?.length ? `<details><summary>${pl(x.console.length, 'console error')}</summary><pre>${e(x.console.join('\n'))}</pre></details>` : ''}${img(x.screenshot)}${x.trace ? `<div><a href="artifacts/${encodeURIComponent(x.trace)}">Download trace</a> <span class="muted">(open at trace.playwright.dev or with npx playwright show-trace)</span></div>` : ''}${x.blockedAssets?.length ? `<details><summary>${e(pl(x.blockedAssets.length, 'off-list resource'))} blocked</summary><pre>${e(x.blockedAssets.join('\n'))}</pre></details>` : ''}</td><td>${e(cap(x.browser))}</td><td>${e(x.device)}</td><td class="num">${e(x.durationMs)} ms</td></tr>`;
    }
    b += '</tbody></table></div>';
  }

  // Web Vitals
  const withVitals = r.ui.pages.filter((p) => p.vitals);
  if (withVitals.length) {
    b += '<h2 id="speed">Speed (Core Web Vitals)</h2><div class="card">';
    const budgets = r.meta.budgets || {};
    const metrics = [['LCP', ' ms'], ['FCP', ' ms'], ['TTFB', ' ms'], ['CLS', '']];
    b += '<table><thead><tr><th>Metric</th><th class="num">Worst</th><th class="num col-extra">Limit</th><th>Result</th><th class="col-extra">Worst page</th></tr></thead><tbody>';
    let anyOver = false;
    for (const [m, u] of metrics) {
      const vals = withVitals.filter((p) => p.vitals[m] != null);
      if (!vals.length) continue;
      const worst = vals.reduce((a, c) => (c.vitals[m] > a.vitals[m] ? c : a));
      const over = budgets[m] != null && worst.vitals[m] > budgets[m];
      anyOver ||= over;
      const plainName = { LCP: 'Main content shows', FCP: 'First paint', TTFB: 'Server answers', CLS: 'Page jumps while loading' }[m];
      b += `<tr><td>${plainName} <span class="muted">(${m})</span></td><td class="num">${e(worst.vitals[m])}${u}</td><td class="num col-extra">${e(budgets[m] ?? '–')}${u}</td><td>${over ? `<span class="pill bad">${ICON.fail} Over limit</span>` : `<span class="pill ok">${ICON.pass} Within limit</span>`}</td><td class="col-extra">${e(new URL(worst.url).pathname)} on ${e(cap(worst.browser))} ${e(worst.device)}</td></tr>`;
    }
    b += '</tbody></table>';
    b += anyOver ? '<div>' : '<details><summary>Per-page charts</summary>';
    for (const [metric, unit, desc] of [['LCP', ' ms', 'Largest Contentful Paint, when the main content shows'], ['FCP', ' ms', 'First Contentful Paint, when anything first shows'], ['TTFB', ' ms', 'Time to first byte, how fast the server answers'], ['CLS', '', 'Cumulative Layout Shift, how much the page jumps']]) {
      const rows = withVitals.filter((p) => p.vitals[metric] != null).map((p) => {
        const label = `${new URL(p.url).pathname} on ${cap(p.browser)} ${p.device}`;
        return { label, value: p.vitals[metric], title: `${label}: ${p.vitals[metric]}${unit} (budget ${budgets[metric] ?? '–'}${unit})` };
      });
      if (!rows.length) continue;
      b += `<h3>${metric}: ${e(desc)}</h3>${bars(rows, { unit, budget: budgets[metric] ?? null })}`;
    }
    b += anyOver ? '</div>' : '</details>';
    const unsupported = withVitals.filter((p) => p.vitals.LCP == null).map((p) => cap(p.browser));
    if (unsupported.length) b += `<p class="muted">LCP/CLS are not reported by ${e([...new Set(unsupported)].join(', '))} (browser limitation).</p>`;
    b += '</div>';
  }

  // Accessibility
  const a11yPages = r.ui.pages.filter((p) => p.a11y);
  if (a11yPages.length) {
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const byRule = new Map();
    for (const p of a11yPages) {
      for (const v of p.a11y) {
        if (!(v.impact in counts)) continue;
        counts[v.impact] += Number(v.nodes) || 0;
        const k = v.id;
        const cur = byRule.get(k) || { ...v, pages: 0, nodes: 0 };
        cur.pages++;
        cur.nodes += Number(v.nodes) || 0;
        byRule.set(k, cur);
      }
    }
    b += '<h2 id="pages">Accessibility</h2><p class="note">Checked against WCAG 2.2 A and AA with axe-core.</p><div class="card">';
    const statusFor = { critical: 'critical', serious: 'serious', moderate: 'neutral', minor: 'neutral' };
    // Nothing found means nothing to chart: an all-zero chart only adds noise.
    if (byRule.size) b += bars(Object.entries(counts).map(([k, v]) => ({ label: `${k[0].toUpperCase()}${k.slice(1)}`, value: v, status: statusFor[k], title: `${k}: ${pl(v, 'element')} affected` })), { unit: '', integer: true });
    if (byRule.size) {
      b += '<table><thead><tr><th>Impact</th><th>Issue</th><th class="num">Elements</th><th class="num">Page runs</th><th>Example</th></tr></thead><tbody>';
      for (const v of [...byRule.values()].sort((a, c) => ['critical', 'serious', 'moderate', 'minor'].indexOf(a.impact) - ['critical', 'serious', 'moderate', 'minor'].indexOf(c.impact))) {
        b += `<tr><td><span class="pill">${e(v.impact)}</span></td><td>${e(a11yRuleName(v.id))} <span class="muted">(${e(v.id)})</span></td><td class="num">${e(v.nodes)}</td><td class="num">${e(v.pages)}</td><td><code>${e(v.sample || '')}</code></td></tr>`;
      }
      b += '</tbody></table>';
    } else {
      const crawlHits = (r.crawl?.pages || []).reduce((n, p) => n + (Number(p.a11yCritical) || 0), 0);
      b += crawlHits
        ? `<p>${ICON.pass} No problems on the pages tested in browsers. Following the site's links found ${e(pl(crawlHits, 'serious problem'))} on other pages, listed under <a href="#crawl">${e(AREAS.crawl)}</a>.</p>`
        : `<p class="ok">${ICON.pass} No accessibility problems found.</p>`;
    }
    b += '</div>';
  }

  // Visual
  const visual = r.ui.pages.filter((p) => p.visual);
  for (const p of visual) if (p.visual.status === 'changed-accepted') p.visual = { ...p.visual, status: 'match', note: 'Looked different from last time; saved as the new look.' };
  const changedOrMatched = visual.filter((p) => p.visual.status !== 'new-baseline');
  const anyChanged = visual.some((p) => p.visual.status === 'changed');
  if (visual.length && changedOrMatched.length && !anyChanged) {
    b += `<h2>Looks the same as last time</h2><div class="card"><p class="ok">${ICON.pass} ${changedOrMatched.length} of ${pl(visual.length, 'page screenshot')} ${changedOrMatched.length === 1 ? 'looks' : 'look'} the same as last time${visual.length > changedOrMatched.length ? `; ${visual.length - changedOrMatched.length} saved for the first time` : ''}.</p></div>`;
  } else if (visual.length && !changedOrMatched.length) {
    b += `<h2>How pages look</h2><div class="card"><p>${ICON.skip} ${pl(visual.length, 'page screenshot')} saved. From the next run, IronProbe tells you when a page looks different.</p></div>`;
  } else if (visual.length) {
    b += '<h2>How pages look</h2><div class="card"><table><thead><tr><th>Result</th><th>Page</th><th>Browser</th><th>Device</th><th class="num">Pixels changed</th></tr></thead><tbody>';
    for (const p of visual) {
      const st = p.visual.status === 'changed' ? `<span class="pill bad">${ICON.fail} Changed</span>` : p.visual.status === 'new-baseline' ? `<span class="pill muted">${ICON.skip} New baseline</span>` : `<span class="pill ok">${ICON.pass} Match</span>`;
      b += `<tr><td>${st}</td><td>${e(new URL(p.url).pathname)}${p.visual.note ? `<div class="muted">${e(p.visual.note)}</div>` : ''}${p.visual.diff ? img(p.visual.diff) : ''}</td><td>${e(cap(p.browser))}</td><td>${e(p.device)}</td><td class="num">${e(p.visual.changedPixels ?? 0)} (${e(round((p.visual.diffRatio || 0) * 100, 3))}%)</td></tr>`;
    }
    b += '</tbody></table></div>';
  }

  // Load
  if (r.load) {
    const L = r.load;
    b += `<h2 id="load">Load test</h2><p class="sub"><code>${e(L.method)} ${e(L.url)}</code> with ${e(L.concurrency)} workers for ${e(L.durationSec)} seconds.</p>`;
    b += `<section class="tiles"><div class="tile"><b>${e(L.requests)}</b><span>requests</span></div><div class="tile"><b>${e(L.rps)}</b><span>requests / second</span></div><div class="tile"><b>${e(L.p50)} ms</b><span>typical answer (p50)</span></div><div class="tile"><b>${e(L.p95)} ms</b><span>slowest 5% (p95)</span></div><div class="tile"><b>${e(L.p99)} ms</b><span>slowest 1% (p99)</span></div><div class="tile"><b class="${L.errorRate ? 'bad' : ''}">${e(round(L.errorRate * 100, 2))}%</b><span>errors</span></div></section>`;
    b += '<div class="card"><h3>Latency over time</h3>';
    b += legend([{ name: 'p50', colorVar: '--series-1' }, { name: 'p95', colorVar: '--series-2' }]);
    b += lines([
      { name: 'p50', colorVar: '--series-1', points: L.timeline.map((t) => ({ x: t.sec + 1, y: t.p50, title: `Second ${t.sec + 1}: p50 ${t.p50} ms` })) },
      { name: 'p95', colorVar: '--series-2', points: L.timeline.map((t) => ({ x: t.sec + 1, y: t.p95, title: `Second ${t.sec + 1}: p95 ${t.p95} ms` })) },
    ], { unit: ' ms', xLabel: 'second' });
    b += '<h3>Throughput over time</h3>';
    b += lines([{ name: 'req/s', colorVar: '--series-1', points: L.timeline.map((t) => ({ x: t.sec + 1, y: t.rps, title: `Second ${t.sec + 1}: ${t.rps} req/s, ${t.errors} errors` })) }], { unit: '', xLabel: 'second' });
    b += `<p>Status codes: ${Object.entries(L.statusCounts).map(([k, v]) => `<code>${e(k)}</code> × ${e(v)}`).join(', ')}</p>${fails(L.failures)}</div>`;
  }

  // Crawl
  if (r.crawl?.pages?.length) {
    b += `<h2 id="crawl">${e(AREAS.crawl)}</h2><p class="note">Pages IronProbe found by following the links on your site.</p><div class="card"><p class="sub">${pl(r.crawl.pages.length, 'page')} checked${r.crawl.capped ? ` of ${r.crawl.discovered} found (page cap reached)` : ''}.</p><table><thead><tr><th>Result</th><th>Page</th><th class="num">HTTP</th><th class="num col-extra">Serious accessibility problems</th></tr></thead><tbody>`;
    for (const p of r.crawl.pages) b += `<tr><td>${status(p.passed)}</td><td><code>${e(new URL(p.url).pathname)}</code>${fails(p.failures)}${p.consoleErrors?.length ? `<details><summary>Console errors</summary><pre>${e(p.consoleErrors.join('\n'))}</pre></details>` : ''}</td><td class="num">${e(p.status ?? '–')}</td><td class="num col-extra">${e(p.a11yCritical ?? '–')}</td></tr>`;
    b += '</tbody></table></div>';
  }

  if (r.warnings?.length) {
    const friendly = friendlyWarnings(r.warnings);
    b += '<h2>Notes</h2><div class="card">';
    if (friendly.length) b += `<ul class="fails">${friendly.map((w) => `<li>${e(w)}</li>`).join('')}</ul>`;
    b += `<details><summary>Technical details</summary><pre>${e(r.warnings.join('\n'))}</pre></details></div>`;
  }

  b += '<footer>Generated locally by IronProbe. No telemetry; nothing was sent anywhere except the targets you listed. Machine-readable results are in <code>results.json</code>, and CI results in <code>junit.xml</code>.</footer>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>${e(r.meta.name)} test report</title><style>${CSS}</style></head><body><main>${b}</main></body></html>`;
}
