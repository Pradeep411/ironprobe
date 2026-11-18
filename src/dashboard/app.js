// IronProbe dashboard. No frameworks, no network calls except to this local server.
(() => {
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || store('session', 'ipt');
  const state = { files: [], lastRequest: null, timer: null, started: 0, runId: null };

  function store(kind, k, v) {
    try {
      const s = kind === 'session' ? sessionStorage : localStorage;
      if (v === undefined) return s.getItem(k);
      s.setItem(k, v);
    } catch { /* storage blocked: fine */ }
    return null;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-ironprobe-token': token || '', ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function show(which) {
    for (const id of ['locked', 'start', 'running', 'result']) $(id).hidden = id !== which;
    $('bench').hidden = which === 'locked';
    $('resultMore').hidden = which !== 'result';
    for (const id of ['start', 'running', 'result']) $('bench').classList.toggle(`is-${id}`, which === id);
    $('historySec').hidden = which === 'locked';
    if (which === 'start') gauge.idle();
  }

  // ---- the gauge: a calibrated 0-100 dial whose needle sweeps while testing ----
  const gauge = (() => {
    const NS = 'http://www.w3.org/2000/svg';
    const CX = 120;
    const CY = 128;
    const R = 93;
    const START = 150; // degrees, lower left
    const SWEEP = 240;
    const ang = (v) => START + (SWEEP * Math.max(0, Math.min(100, v))) / 100;
    const pt = (a, r) => [CX + r * Math.cos((a * Math.PI) / 180), CY + r * Math.sin((a * Math.PI) / 180)];
    const mk = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      parent?.append(n);
      return n;
    };
    const arc = (v0, v1, r) => {
      const [x0, y0] = pt(ang(v0), r);
      const [x1, y1] = pt(ang(v1), r);
      const large = ang(v1) - ang(v0) > 180 ? 1 : 0;
      return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const svg = mk('svg', { viewBox: '4 12 232 232', 'aria-hidden': 'true' });
    mk('circle', { class: 'face', cx: CX, cy: CY, r: 114 }, svg);
    mk('path', { class: 'band bad', d: arc(0, 69.4, R) }, svg);
    mk('path', { class: 'band warn', d: arc(70.6, 89.4, R) }, svg);
    mk('path', { class: 'band good', d: arc(90.6, 100, R) }, svg);
    for (let v = 0; v <= 100; v += 5) {
      const major = v % 10 === 0;
      const [x0, y0] = pt(ang(v), major ? 76 : 80);
      const [x1, y1] = pt(ang(v), 88);
      mk('line', { class: `tick${major ? ' major' : ''}`, x1: x0, y1: y0, x2: x1, y2: y1 }, svg);
      if (v % 20 === 0) {
        const [lx, ly] = pt(ang(v), 104);
        mk('text', { class: 'num-label', x: lx, y: ly + 4 }, svg).textContent = String(v);
      }
    }
    const needle = mk('g', { class: 'needle' }, svg);
    mk('path', { d: `M${CX} ${CY - 4.5} L${CX + 84} ${CY} L${CX} ${CY + 4.5} L${CX - 14} ${CY} Z` }, needle);
    mk('circle', { class: 'hub', cx: CX, cy: CY, r: 9 }, svg);
    mk('circle', { class: 'hub-cap', cx: CX, cy: CY, r: 3.5 }, svg);
    const readout = mk('text', { class: 'readout', x: CX, y: 196 }, svg);
    const unit = mk('text', { class: 'readout-unit', x: CX, y: 214 }, svg);
    const box = $('gauge');
    box.append(svg);
    const caption = $('gaugeCaption');
    const point = (v) => { needle.style.transform = `rotate(${ang(v)}deg)`; };
    let counter = 0;
    const count = (to) => {
      cancelAnimationFrame(counter);
      if (reduceMotion) { readout.textContent = String(to); return; }
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 1300);
        readout.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
        if (k < 1) counter = requestAnimationFrame(step);
      };
      counter = requestAnimationFrame(step);
    };
    return {
      idle() {
        box.className = 'gauge idle';
        point(0);
        readout.textContent = '–';
        unit.textContent = 'health score';
        caption.className = 'gauge-caption';
        caption.textContent = 'No reading yet';
        box.setAttribute('aria-label', 'No reading yet');
      },
      scan(progress) {
        box.className = 'gauge scanning';
        point(progress);
        readout.textContent = '…';
        unit.textContent = 'measuring';
        caption.className = 'gauge-caption';
        caption.textContent = 'Measuring';
        box.setAttribute('aria-label', 'Measuring');
      },
      settle(score, label) {
        box.className = 'gauge';
        if (score == null) {
          box.className = 'gauge noscore';
          point(0);
          readout.textContent = '–';
          unit.textContent = 'no score this time';
          caption.className = 'gauge-caption';
          caption.textContent = label;
          box.setAttribute('aria-label', `${label}. No score this time.`);
          return;
        }
        point(0);
        requestAnimationFrame(() => requestAnimationFrame(() => point(score)));
        count(score);
        unit.textContent = 'out of 100';
        caption.className = `gauge-caption ${score >= 90 ? 'good' : score >= 70 ? 'warn' : 'bad'}`;
        caption.textContent = label;
        box.setAttribute('aria-label', `Health score ${score} out of 100: ${label}`);
      },
    };
  })();
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const band = (s) => (s == null ? 'low' : s >= 90 ? '' : s >= 70 ? 'mid' : 'low');
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host; } catch { return u; } };

  // ---- files ----
  const drop = $('drop');
  const picker = $('file');
  drop.addEventListener('click', (e) => { if (!e.target.closest('button')) picker.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
  picker.addEventListener('change', () => { const picked = [...picker.files]; picker.value = ''; addFiles(picked); });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!$('start').hidden && e.dataTransfer?.files?.length && !drop.contains(e.target)) addFiles(e.dataTransfer.files); });

  async function addFiles(list) {
    for (const f of list) {
      if (state.files.length >= 10) { showError('Up to 10 files at a time.'); break; }
      if (f.size > 10 * 1024 * 1024) { showError(`${f.name} is over 10 MB.`); continue; }
      if (!/\.(json|ya?ml|har)$/i.test(f.name)) { showError(`${f.name} is not a Postman, OpenAPI or HAR file (.json, .yaml or .har).`); continue; }
      state.files.push({ name: f.name, content: await f.text() });
    }
    renderFiles();
  }
  function renderFiles() {
    const ul = $('files');
    ul.replaceChildren();
    state.files.forEach((f, i) => {
      const li = el('li', '', f.name);
      const x = el('button', '', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${f.name}`);
      x.addEventListener('click', () => { state.files.splice(i, 1); renderFiles(); });
      li.append(x);
      ul.append(li);
    });
  }
  function showError(msg) {
    const e = $('formError');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  // ---- run ----
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('url').value.trim();
    if (!url) { showError('Paste the address of your site or app first.'); $('url').focus(); return; }
    start({ url, files: state.files, browsers: $('allBrowsers').checked ? 'all' : 'fast', network: $('network').value, auth: $('auth').value, allowWrites: $('allowWrites').checked });
  });
  $('again').addEventListener('click', () => state.lastRequest && start(state.lastRequest));
  $('cancel').addEventListener('click', async () => {
    if (!state.runId) return;
    $('cancel').disabled = true;
    $('stage').textContent = 'Stopping…';
    try { await api(`/api/run/${state.runId}/cancel`, { method: 'POST', body: '{}' }); } catch { /* the run ends anyway */ }
  });
  $('newTest').addEventListener('click', () => { show('start'); $('url').focus(); $('url').select(); });

  async function start(req) {
    showError('');
    $('go').disabled = true;
    try {
      const { id } = await api('/api/run', { method: 'POST', body: JSON.stringify(req) });
      state.lastRequest = req;
      store('local', 'ironprobe:lastUrl', req.url);
      watch(id, req.url);
    } catch (err) {
      show('start');
      showError(err.message);
    } finally {
      $('go').disabled = false;
    }
  }

  // Engine log lines -> short sentences for the live list.
  function plainLine(t) {
    let m;
    if ((m = /^(PASS|FAIL)\s+API\s+(\S+)\s+\S+\s+(\S+)\s+\S+\s+(.+?)(?:\s+\(asked for a login\))?$/.exec(t))) {
      if (/^40[13]$/.test(m[3])) return ['login', ''];
      return [m[1] === 'PASS', `API: ${m[4].replace(/^fuzz (\S+) (.+)$/, 'unusual input for $1 ($2)')}`];
    }
    if ((m = /^SKIP\s+API\s+(.+?)\s+\((.+)\)$/.exec(t))) return [null, `API: ${m[1]} skipped`];
    if ((m = /^(PASS|FAIL)\s+UI\s+\S+\s+(.+?)\s{2,}(.+)$/.exec(t))) return [m[1] === 'PASS', `${m[3]} on ${m[2]}`];
    if ((m = /^(PASS|FAIL)\s+PAGE\s+\S+\s+(.+?)\s{2,}(.+)$/.exec(t))) return [m[1] === 'PASS', `Page ${m[3]} on ${m[2]}`];
    if ((m = /^(PASS|FAIL)\s+CRAWL\s+(\S+)/.exec(t))) return [m[1] === 'PASS', `Page ${m[2]}`];
    if ((m = /^using (.+)$/.exec(t))) return [null, `Using ${m[1]}`];
    if ((m = /^(FAIL|ERROR|SKIP)\s+(.+)$/.exec(t))) return [m[1] === 'SKIP' ? null : false, m[2].replace(/^\w+\s+/, '')];
    if ((m = /^(Downloading|Installing|Checking|Can't|Stopped).*/.exec(t))) return [null, t];
    return null;
  }

  function watch(id, url) {
    state.runId = id;
    $('cancel').disabled = false;
    show('running');
    $('runTitle').textContent = `Testing ${hostOf(url)}`;
    $('stage').textContent = 'Getting ready…';
    $('feed').replaceChildren();
    $('counts').hidden = true;
    let pass = 0;
    let fail = 0;
    let logins = 0;
    let loginLi = null;
    let progress = 3;
    let ceil = 30;
    $('cPass').textContent = '0';
    $('cFail').textContent = '0';
    $('cFail').classList.remove('has-fails');
    setBar(progress);
    state.started = Date.now();
    clearInterval(state.timer);
    state.timer = setInterval(() => { $('cTime').textContent = `${Math.round((Date.now() - state.started) / 1000)}s`; }, 500);

    const src = new EventSource(`/api/run/${id}/events`);
    src.addEventListener('log', (ev) => {
      const t = JSON.parse(ev.data).line.trim();
      const stages = { API: ['Checking your API', 30], UI: ['Opening pages on a laptop and a phone', 72], Crawl: ['Walking through the whole site', 96] };
      if (stages[t]) {
        [$('stage').textContent, ceil] = stages[t];
        return;
      }
      const p = plainLine(t);
      if (!p) return;
      if (p[0] === 'login') {
        logins += 1;
        loginLi = loginLi || el('li');
        const label = `${logins} API check${logins === 1 ? '' : 's'} need a login (skipped)`;
        loginLi.replaceChildren(el('span', 'muted', '–'), el('span', '', label));
        if (!loginLi.isConnected) $('feed').append(loginLi);
        return;
      }
      const [ok, text] = p;
      if (/^(Downloading|Installing|Checking)/.test(text)) $('stage').textContent = text;
      const li = el('li');
      const mk = el('span', ok === true ? 'mark-ok' : ok === false ? 'mark-bad' : 'muted', ok === true ? '✓' : ok === false ? '✕' : '–');
      mk.setAttribute('aria-label', ok === true ? 'passed' : ok === false ? 'needs fixing' : 'note');
      li.append(mk, el('span', '', text));
      if (ok !== null) {
        $('counts').hidden = false;
        if (ok) $('cPass').textContent = String(++pass);
        else { $('cFail').textContent = String(++fail); $('cFail').classList.add('has-fails'); }
      }
      const feed = $('feed');
      feed.append(li);
      while (feed.children.length > 200) feed.firstChild.remove();
      feed.scrollTop = feed.scrollHeight;
      progress = Math.min(ceil, progress + (ceil - progress) * 0.1);
      setBar(progress);
    });
    src.addEventListener('done', (ev) => { setBar(100); renderResult(JSON.parse(ev.data)); });
    src.addEventListener('failed', (ev) => { show('start'); showError(JSON.parse(ev.data).message); });
    src.addEventListener('end', () => { src.close(); clearInterval(state.timer); loadHistory(); });
    let failures = 0;
    src.addEventListener('open', () => { failures = 0; });
    src.onerror = () => {
      failures += 1;
      // The browser retries on its own; after a few misses IronProbe has stopped (e.g. Ctrl+C).
      if (src.readyState === EventSource.CLOSED || failures >= 4) {
        src.close();
        clearInterval(state.timer);
        show('start');
        showError('Lost contact with IronProbe. If you closed it, open your terminal and run npx ironprobe again.');
      }
    };
  }
  function setBar(v) {
    $('barFill').style.width = `${Math.round(v)}%`;
    document.querySelector('.bar').setAttribute('aria-valuenow', String(Math.round(v)));
    if (v < 100) gauge.scan(v);
  }

  // Plain name for the pages IronProbe found by following links.
  const areaName = (n) => (n === 'Whole site' ? 'Other pages' : n);

  function renderResult(r) {
    show('result');
    $('again').hidden = !state.lastRequest;
    const s = r.score;
    $('resLabel').textContent = s == null ? (r.label === 'Stopped early' ? 'Stopped early' : "Couldn't finish") : r.label;
    $('resSite').textContent = hostOf(r.target);
    gauge.settle(s, $('resLabel').textContent);
    const sum = r.summary;
    const counted = sum.passed + sum.failed;
    $('resLine').textContent = `${sum.passed} of ${counted} checks passed in ${Math.round(r.durationMs / 1000)} seconds.`;
    const d = $('delta');
    d.className = 'delta';
    if (s != null && r.previous != null) {
      const delta = s - r.previous;
      d.textContent = delta === 0 ? 'Same as last time' : delta > 0 ? `↑ ${delta} since last time` : `↓ ${-delta} since last time`;
      if (delta > 0) d.classList.add('up');
      if (delta < 0) d.classList.add('down');
      d.hidden = false;
    } else if (s != null && !r.comparable) {
      d.textContent = 'Different checks than last time, so no comparison';
      d.hidden = false;
    } else {
      d.hidden = true;
    }
    $('openReport').href = `/r/${encodeURIComponent(r.site)}/${encodeURIComponent(r.runId)}/report.html`;

    const pc = $('parts');
    pc.replaceChildren();
    for (const p of r.parts || []) {
      const card = el('div', 'readout-card');
      const ratio = p.total ? p.passed / p.total : 0;
      const bar = el('div', `rc-bar${ratio === 1 ? '' : ratio === 0 ? ' none' : ' partial'}`);
      const fill = el('span');
      fill.style.width = `${Math.round(ratio * 100)}%`;
      bar.append(fill);
      card.append(el('p', 'rc-value', `${p.passed}/${p.total}`), el('p', 'rc-name', `${areaName(p.name)} passed`), bar);
      pc.append(card);
    }
    const ln = $('loginNote');
    ln.hidden = !r.loginNeeded;
    ln.textContent = r.loginNeeded ? `${r.loginNeeded} API check${r.loginNeeded === 1 ? '' : 's'} need a login, so ${r.loginNeeded === 1 ? 'it was' : 'they were'} skipped. Add an API token under Options and run again.` : '';

    const fix = $('fix');
    fix.replaceChildren();
    const causes = { app: 'App bug', test: 'Test issue', infrastructure: 'Setup', login: 'Needs login' };
    for (const f of r.fixFirst || []) {
      const li = el('li', f.cause);
      const what = el('p', 'what');
      what.append(el('span', 'tag', causes[f.cause] || 'App bug'), document.createTextNode(`${areaName(f.area)}: ${f.where}`));
      li.append(what, el('p', 'why', f.problem));
      if (f.devices.length) li.append(el('p', 'meta', `Seen on ${f.devices.join(', ')}`));
      if (f.inputs?.length) li.append(el('p', 'meta', `Inputs that broke it: ${f.inputs.join(', ')}`));
      fix.append(li);
    }
    const none = !(r.fixFirst || []).length;
    $('fixTitle').hidden = none;
    $('allGood').hidden = !none || s == null;
    $('allGood').textContent = r.loginNeeded ? 'Nothing to fix. Every check that ran passed.' : 'Nothing to fix. Every check passed.';
    $('warnings').replaceChildren(...(r.warnings || []).map((t) => el('li', '', t)));
    $('resLabel').focus({ preventScroll: true });
  }

  function sparkline(scores) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 96 24');
    svg.setAttribute('aria-hidden', 'true');
    const pts = scores.map((v, i) => `${scores.length === 1 ? 48 : (i / (scores.length - 1)) * 92 + 2},${22 - (v / 100) * 20}`).join(' ');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts);
    svg.append(line);
    return svg;
  }

  async function loadHistory() {
    try {
      const { runs, running } = await api('/api/history');
      const bySite = new Map();
      for (const r of runs) {
        if (!bySite.has(r.site)) bySite.set(r.site, []);
        bySite.get(r.site).push(r);
      }
      const ol = $('history');
      ol.replaceChildren();
      $('histEmpty').hidden = bySite.size > 0;
      for (const [site, list] of [...bySite.entries()].slice(0, 12)) {
        const newest = list[0];
        const latest = list.find((x) => x.score != null) || newest; // last run that has a score
        const li = el('li');
        li.append(el('span', `pill ${latest.score == null ? 'none' : band(latest.score)}`, latest.score ?? '–'));
        const mid = el('div');
        mid.append(el('p', 'name', latest.target || site));
        // Trend line: only runs of the same kind as the latest scored one.
        const scored = list.filter((x) => x.score != null && x.fingerprint === latest.fingerprint).slice(0, 10).reverse().map((x) => x.score);
        if (scored.length > 1) {
          const row = el('div', 'spark-row');
          const sp = sparkline(scored);
          sp.setAttribute('aria-hidden', 'false');
          sp.setAttribute('role', 'img');
          sp.setAttribute('aria-label', `Scores of the last ${scored.length} comparable runs: ${scored.join(', ')}`);
          row.append(el('span', '', String(scored[0])), sp, el('span', '', String(scored[scored.length - 1])));
          mid.append(row);
        }
        const status = latest.score == null ? 'No score yet.' : latest.failed ? `${latest.failed} check${latest.failed === 1 ? '' : 's'} failed.` : 'Nothing to fix.';
        mid.append(el('p', 'muted small', `Last checked ${ago(newest.startedAt)}. ${status}${newest.score == null && newest !== latest ? ' Last run stopped early.' : ''} ${list.length} run${list.length === 1 ? '' : 's'} saved.`));
        const a = el('a', '', 'Report');
        a.href = `/r/${encodeURIComponent(latest.site)}/${encodeURIComponent(latest.id)}/report.html`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.setAttribute('aria-label', `Open the latest report for ${latest.target || site}`);
        li.append(mid, a);
        ol.append(li);
      }
      return running;
    } catch {
      return null;
    }
  }

  // ---- boot ----
  (async () => {
    if (!token) { show('locked'); return; }
    store('session', 'ipt', token);
    history.replaceState(null, '', '/'); // keep the token out of the address bar and bookmarks
    try {
      const s = await api('/api/session', { method: 'POST', body: '{}' });
      $('ver').textContent = `IronProbe ${s.version}.`;
      const home = $('home');
      home.textContent = 'History is saved on this computer.';
      home.title = s.home;
    } catch {
      show('locked');
      return;
    }
    show('start');
    const prev = store('local', 'ironprobe:lastUrl');
    if (prev) $('url').value = prev;
    $('url').focus();
    const running = await loadHistory();
    if (running) {
      // Page was refreshed during a run: pick it up again with its address and options.
      // Files and tokens are never sent back to the page, so a rerun after refresh needs them again.
      state.lastRequest = running.request.hadFiles || running.request.hadToken ? null : { ...running.request, files: [], auth: '' };
      watch(running.id, running.request.url || 'your site');
    }
  })();
})();
