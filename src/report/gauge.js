// The same calibrated 0-100 gauge as the dashboard, drawn as static SVG for the report.
const CX = 120;
const CY = 128;
const R = 93;
const ang = (v) => 150 + (240 * Math.max(0, Math.min(100, v))) / 100;
const pt = (a, r) => [CX + r * Math.cos((a * Math.PI) / 180), CY + r * Math.sin((a * Math.PI) / 180)];
const f = (n) => n.toFixed(2);
function arc(v0, v1, r) {
  const [x0, y0] = pt(ang(v0), r);
  const [x1, y1] = pt(ang(v1), r);
  return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${ang(v1) - ang(v0) > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}

export function gaugeSvg(score) {
  let s = `<svg class="g" viewBox="4 12 232 232" aria-hidden="true"><circle class="g-face" cx="${CX}" cy="${CY}" r="114"/>`;
  s += `<path class="g-band g-bad" d="${arc(0, 69.4, R)}"/><path class="g-band g-warn" d="${arc(70.6, 89.4, R)}"/><path class="g-band g-good" d="${arc(90.6, 100, R)}"/>`;
  for (let v = 0; v <= 100; v += 5) {
    const major = v % 10 === 0;
    const [x0, y0] = pt(ang(v), major ? 76 : 80);
    const [x1, y1] = pt(ang(v), 88);
    s += `<line class="g-tick${major ? ' g-major' : ''}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}"/>`;
    if (v % 20 === 0) {
      const [lx, ly] = pt(ang(v), 104);
      s += `<text class="g-num" x="${f(lx)}" y="${f(ly + 4)}">${v}</text>`;
    }
  }
  const a = ang(score ?? 0);
  s += `<g transform="rotate(${f(a)} ${CX} ${CY})"><path class="g-needle" d="M${CX} ${CY - 4.5} L${CX + 84} ${CY} L${CX} ${CY + 4.5} L${CX - 14} ${CY} Z"/></g>`;
  s += `<circle class="g-hub" cx="${CX}" cy="${CY}" r="9"/><circle class="g-cap" cx="${CX}" cy="${CY}" r="3.5"/>`;
  s += `<text class="g-read" x="${CX}" y="196">${score ?? '–'}</text><text class="g-unit" x="${CX}" y="214">${score == null ? 'no score' : 'out of 100'}</text></svg>`;
  return s;
}
