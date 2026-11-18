// Inline-SVG charts (no scripts, no external assets). Every mark carries a <title> tooltip.
// Colors come from CSS custom properties defined in html.js (light + dark).
// Design decision: ticks sit on "nice" steps (1/2/5 x 10^n) so every label is a real gridline value.
import { escapeHtml as e, round } from '../util.js';

const W = 720;

// Nice axis: step from 1/2/5 x 10^n, max rounded up to a whole step. integer=true forces whole-number steps.
export function niceAxis(rawMax, { ticks = 4, integer = false } = {}) {
  const max = rawMax > 0 ? rawMax : 1;
  const rough = max / ticks;
  const p = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= rough) || 10 * p;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  const values = [];
  for (let v = 0; v <= top + step / 2; v += step) values.push(round(v, decimals));
  return { top, step, values, decimals };
}

// Horizontal bars, one series. rows: [{label, value, title, status?, display?}], optional budget line.
export function hBars(rows, { unit = '', budget = null, colorVar = '--series-1', max = null, integer = false } = {}) {
  if (!rows.length) return '';
  const labelW = 230;
  const rowH = 26;
  const plotW = W - labelW - 90;
  const top = 18;
  const axis = niceAxis(max ?? Math.max(...rows.map((r) => r.value), budget ?? 0), { integer });
  const h = top + rows.length * rowH + 26;
  const x = (v) => labelW + (Math.max(0, v) / axis.top) * plotW;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="bar chart">`;
  for (const v of axis.values) {
    s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${top}" y2="${h - 22}"/>`;
    s += `<text class="tick" x="${x(v)}" y="${h - 6}" text-anchor="middle">${e(v)}${e(unit)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const fill = r.status ? `var(--status-${r.status})` : `var(${colorVar})`;
    const w = r.value > 0 ? Math.max(2, x(r.value) - labelW) : 0;
    s += `<g class="mark"><title>${e(r.title || `${r.label}: ${r.value}${unit}`)}</title>`;
    s += `<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/>`;
    s += `<text class="label" x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${e(r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label)}</text>`;
    if (w) s += `<rect x="${labelW}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="4" fill="${fill}"/>`;
    s += `<text class="value" x="${labelW + w + 6}" y="${y + rowH / 2 + 4}">${e(r.display ?? `${r.value}${unit}`)}</text></g>`;
  });
  if (budget != null) {
    const bx = x(budget);
    const end = bx > W - 110;
    s += `<line class="budget" x1="${bx}" x2="${bx}" y1="${top - 6}" y2="${h - 22}"><title>Budget ${budget}${e(unit)}</title></line>`;
    s += `<text class="budget-label" x="${end ? bx - 4 : bx + 4}" y="${top - 6}" text-anchor="${end ? 'end' : 'start'}">budget ${e(budget)}${e(unit)}</text>`;
  }
  return `${s}</svg>`;
}

// Line chart over an index (time/run). series: [{name, colorVar, points:[{x, y, title}]}]. One axis only.
export function lines(series, { unit = '', xLabel = '', yMax = null, height = 220, integer = false } = {}) {
  const pts = series.flatMap((sr) => sr.points);
  if (!pts.length) return '';
  const left = 56;
  const right = 110;
  const top = 12;
  const bottom = 30;
  const plotW = W - left - right;
  const plotH = height - top - bottom;
  const xs = pts.map((p) => p.x);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs, xmin + 1);
  const axis = niceAxis(yMax ?? Math.max(...pts.map((p) => p.y)), { integer });
  const X = (v) => left + ((v - xmin) / (xmax - xmin)) * plotW;
  const Y = (v) => top + plotH - (v / axis.top) * plotH;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="line chart">`;
  for (const v of axis.values) {
    s += `<line class="grid" x1="${left}" x2="${left + plotW}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    s += `<text class="tick" x="${left - 6}" y="${Y(v) + 4}" text-anchor="end">${e(v)}${e(unit)}</text>`;
  }
  s += `<text class="tick" x="${left}" y="${height - 8}">${e(xmin)}</text><text class="tick" x="${left + plotW}" y="${height - 8}" text-anchor="end">${e(xmax)}</text>`;
  if (xLabel) s += `<text class="tick" x="${left + plotW / 2}" y="${height - 8}" text-anchor="middle">${e(xLabel)}</text>`;
  for (const sr of series) {
    if (!sr.points.length) continue;
    const d = sr.points.map((p, i) => `${i ? 'L' : 'M'}${round(X(p.x), 1)},${round(Y(p.y), 1)}`).join(' ');
    s += `<path d="${d}" fill="none" stroke="var(${sr.colorVar})" stroke-width="2" stroke-linejoin="round"/>`;
    for (const p of sr.points) {
      s += `<g class="mark"><title>${e(p.title || `${sr.name}: ${p.y}${unit} at ${p.x}`)}</title><circle class="hit" cx="${X(p.x)}" cy="${Y(p.y)}" r="9"/><circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${sr.points.length > 40 ? 0 : 4}" fill="var(${sr.colorVar})" stroke="var(--surface-1)" stroke-width="2"/></g>`;
    }
    const last = sr.points[sr.points.length - 1];
    s += `<text class="direct" x="${X(last.x) + 8}" y="${Y(last.y) + 4}">${e(sr.name)}</text>`;
  }
  return `${s}</svg>`;
}

export function legend(items) {
  return `<div class="legend">${items.map((i) => `<span><i style="background:var(${i.colorVar})"></i>${e(i.name)}</span>`).join('')}</div>`;
}
