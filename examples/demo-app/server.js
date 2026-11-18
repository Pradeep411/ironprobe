// Tiny demo app for trying IronProbe.
// By default it is the fixed version: every IronProbe check passes.
// Start it with DEMO_BUGS=1 to bring back the planted bugs, so the report has something to show:
// - /about has an image without alt text and low-contrast text (accessibility)
// - GET /api/slow takes ~600 ms (latency budget)
// - GET /api/items/<missing id> returns 500 instead of 404
// - items added on /items are only shown in the browser and are gone after a reload
import http from 'node:http';

const PORT = Number(process.env.PORT || 4010);
const BUGS = process.env.DEMO_BUGS === '1';
const items = [{ id: 1, name: 'Kinetic wall' }, { id: 2, name: 'Holo fan' }];
const TOKEN = 'demo-token-123';
const MAX_ITEMS = 500;
const MAX_BODY = 64 * 1024;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="icon" href="data:,">
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;max-width:720px;color:#1a1a1a;background:#fff}nav a{margin-right:12px}.faint{color:${BUGS ? '#c8c8c8' : '#595959'}}</style></head>
<body><nav><a href="/">Home</a><a href="/items">Items</a><a href="/about">About</a></nav><main>${body}</main></body></html>`;

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#1a1a1a"/><path d="M12 28V12h4v16zm8 0V12h8v4h-4v12z" fill="#fff"/></svg>';

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function addItem(name) {
  const clean = String(name ?? '').trim().slice(0, 100);
  if (!clean) return null;
  if (items.length >= MAX_ITEMS) items.splice(2, 1); // keep memory bounded on long demo runs
  const item = { id: Math.max(0, ...items.map((i) => i.id)) + 1, name: clean };
  items.push(item);
  return item;
}

const itemsPage = () =>
  page('Items', `<h1>Items</h1>
<form method="post" action="/items">
<label for="name">New item</label> <input id="name" name="name" maxlength="100" required> <button id="add" type="${BUGS ? 'button' : 'submit'}">Add</button>
</form>
<ul id="list">${items.map((i) => `<li>${esc(i.name)}</li>`).join('')}</ul>
${BUGS ? `<script>document.getElementById('add').onclick=()=>{const v=document.getElementById('name').value;if(!v)return;const li=document.createElement('li');li.textContent=v;document.getElementById('list').appendChild(li);};</script>` : ''}`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length; // bytes, not characters
    if (size > MAX_BODY) return json(res, 413, { error: 'body too large' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const isForm = /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '');
  const body = !raw ? null : isForm ? Object.fromEntries(new URLSearchParams(raw)) : (() => { try { return JSON.parse(raw); } catch { return null; } })();

  if (p === '/') return html(res, 200, page('Demo home', '<h1>Demo app</h1><p>IronProbe test target.</p>'));
  if (p === '/items' && req.method === 'POST') {
    // Saved on the server, then redirect so a reload shows the list and never re-submits.
    addItem(body?.name);
    res.writeHead(303, { location: '/items' });
    return res.end();
  }
  if (p === '/items') return html(res, 200, itemsPage());
  if (p === '/about') {
    const img = BUGS ? '<img src="/logo.png" width="40" height="40">' : '<img src="/logo.svg" width="40" height="40" alt="Demo app logo">';
    return html(res, 200, page('About', `<h1>About</h1>${img}<p class="faint">Secondary text that is still easy to read.</p>`));
  }
  if (p === '/logo.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
    return res.end(LOGO);
  }

  if (p === '/api/health') return json(res, 200, { ok: true });
  if (p === '/api/login' && req.method === 'POST') {
    if (body?.user === 'demo' && body?.pass === 'secret-pass') return json(res, 200, { token: TOKEN, user: { id: 1, name: 'demo' } });
    return json(res, 401, { error: 'bad credentials' });
  }
  if (p.startsWith('/api/items')) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorised' });
    if (p === '/api/items' && req.method === 'GET') return json(res, 200, { items, count: items.length });
    if (p === '/api/items' && req.method === 'POST') {
      const item = addItem(body?.name);
      return item ? json(res, 201, item) : json(res, 400, { error: 'name required' });
    }
    const m = /^\/api\/items\/([^/]+)$/.exec(p);
    if (m) {
      // Any id that is not a positive whole number, or does not exist, is "not found".
      const id = /^\d{1,9}$/.test(m[1]) ? Number(m[1]) : NaN;
      const item = items.find((i) => i.id === id);
      if (item) return json(res, 200, item);
      return BUGS ? json(res, 500, { error: 'internal' }) : json(res, 404, { error: `item ${m[1].slice(0, 20)} not found` });
    }
  }
  if (p === '/api/slow') {
    if (BUGS) await new Promise((r) => setTimeout(r, 600));
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is the demo already running? Or try PORT=4011 node examples/demo-app/server.js` : e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Demo app on http://localhost:${PORT}${BUGS ? ' (planted bugs ON)' : ''}`));
