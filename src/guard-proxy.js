// Local allow-list proxy. Each browser IronProbe starts sends all of its traffic through one of
// these, including localhost traffic. Every connection is checked against the allow-list, so a
// redirect chain of any length, a WebSocket or a request the page makes later can only reach
// allowed hosts. HTTPS is tunnelled untouched (no certificates are replaced or read).
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isHostAllowed } from './safety.js';

// Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved addresses.
export function isPrivateAddress(ip) {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [x, y, z] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 198 && (y === 18 || y === 19)) ||
      (x === 192 && y === 0 && (z === 0 || z === 2)) || (x === 198 && y === 51 && z === 100) || (x === 203 && y === 0 && z === 113);
  }
  if (!net.isIPv6(a)) return true; // not an IP address: treat as unsafe
  const words = expandV6(a);
  if (!words) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv6 forms that carry an IPv4 address inside: check that address too.
  if (words.slice(0, 6).every((w) => w === 0)) return isPrivateAddress(v4(words[6], words[7])); // ::a.b.c.d
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) return isPrivateAddress(v4(words[6], words[7]));
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0xffff && words[5] === 0) return isPrivateAddress(v4(words[6], words[7])); // IPv4-translated (::ffff:0:a.b.c.d)
  if (words[0] === 0x64 && words[1] === 0xff9b) return isPrivateAddress(v4(words[6], words[7])); // NAT64 (64:ff9b::/96 and /48)
  if (words[0] === 0x2002) return isPrivateAddress(v4(words[1], words[2])); // 6to4
  if (words[0] === 0x2001 && words[1] === 0) return isPrivateAddress(v4(words[6] ^ 0xffff, words[7] ^ 0xffff)); // Teredo client
  const w0 = words[0];
  return (w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0 || (w0 & 0xff00) === 0xff00 || (w0 === 0x2001 && words[1] === 0xdb8);
}

function expandV6(a) {
  let s = a;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [p, q, r, t] = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : null;
  const parts = r === null ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  if (parts.length !== 8) return null;
  return parts.map((x) => parseInt(x || '0', 16));
}

export async function startGuardProxy({ allowedHosts, assetHosts = [], onBlocked = () => {} }) {
  const anyAsset = assetHosts.includes('*');
  // Decides one connection. Returns the address to connect to, or null to refuse.
  // Listed hosts connect by name. In quick mode ('*'), other hosts are resolved once, refused if any
  // address is private (so a tested page cannot reach your router, LAN or cloud metadata), and the
  // connection goes to the checked address so DNS cannot change in between. Off-list page loads
  // (documents, frames) are refused whenever the proxy can see them.
  const decide = async (url, hostname, dest) => {
    if (isHostAllowed(url, allowedHosts)) return hostname;
    if (!anyAsset) return isHostAllowed(url, assetHosts) ? hostname : null;
    if (isHostAllowed(url, assetHosts.filter((h) => h !== '*'))) return hostname;
    if (dest && /^(document|iframe|frame|embed|object)$/i.test(dest)) return null;
    const bare = hostname.replace(/^\[|\]$/g, '');
    let addrs;
    try {
      addrs = net.isIP(bare) ? [{ address: bare }] : await dns.lookup(bare, { all: true });
    } catch {
      return null;
    }
    if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) return null;
    return addrs[0].address;
  };
  const sockets = new Set();
  const upstreams = new Set(); // outgoing connections, closed with the proxy
  const track = (s) => {
    if (upstreams.has(s)) return s; // keep-alive sockets are reused; listen for close only once
    upstreams.add(s);
    s.once('close', () => upstreams.delete(s));
    return s;
  };

  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    req.pause();
    const connectTo = target.protocol === 'http:' ? await decide(target.toString(), target.hostname, req.headers['sec-fetch-dest']) : null;
    if (!connectTo) {
      onBlocked({ url: target.toString() });
      req.socket.destroy(); // the browser sees a failed load, never a page from the proxy
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    headers.host = target.host; // the Host header always names the checked host
    const upstream = http.request(
      { host: connectTo.replace(/^\[|\]$/g, ''), port: target.port || 80, method: req.method, path: target.pathname + target.search, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.rawHeaders);
        up.pipe(res);
      },
    );
    upstream.on('socket', track);
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on('error', () => req.socket.destroy());
    // When the browser gives up (page closed, run ended), drop the upstream request too.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
    req.resume();
  });

  const tunnel = async (req, clientSocket, head, scheme) => {
    clientSocket.on('error', () => clientSocket.destroy());
    const [host, port] = splitHostPort(req.url, scheme === 'https' ? 443 : 80);
    const url = `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}/`;
    const connectTo = host ? await decide(url, host.includes(':') ? `[${host}]` : host) : null;
    if (!connectTo) {
      onBlocked({ url });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = track(net.connect(Number(port), connectTo.replace(/^\[|\]$/g, ''), () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }));
    const kill = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', kill);
    clientSocket.on('error', kill);
    clientSocket.on('close', kill);
    upstream.setTimeout(300000, kill);
  };
  // CONNECT carries https and wss. Plain ws:// arrives as an HTTP upgrade with an absolute URL.
  server.on('connect', (req, socket, head) => tunnel(req, socket, head, 'https'));
  server.on('upgrade', async (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    let target;
    try {
      target = new URL(req.url);
    } catch {
      clientSocket.destroy();
      return;
    }
    const connectTo = /^(ws|http):$/.test(target.protocol) ? await decide(target.toString().replace(/^ws/, 'http'), target.hostname) : null;
    if (!connectTo) {
      onBlocked({ url: target.toString() });
      clientSocket.destroy();
      return;
    }
    const upstream = track(net.connect(Number(target.port || 80), connectTo.replace(/^\[|\]$/g, ''), () => {
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }));
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('clientError', (_e, s) => s.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        for (const s of upstreams) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function splitHostPort(authority, defaultPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) || /^([^:]+)(?::(\d+))?$/.exec(authority);
  return m ? [m[1], m[2] || String(defaultPort)] : ['', ''];
}

// Launch options that route a browser through the guard proxy and stop WebRTC from sending UDP
// around it. "<-loopback>" makes Chromium proxy localhost too, so other local ports are checked.
export function proxyLaunchOptions(browserName, proxy) {
  const opts = { proxy: { server: proxy.server, bypass: '<-loopback>' } };
  if (browserName === 'chromium') {
    opts.args = ['--dns-prefetch-disable', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];
  } else if (browserName === 'firefox') {
    opts.firefoxUserPrefs = {
      'network.proxy.allow_hijacking_localhost': true,
      'network.proxy.no_proxies_on': '',
      'media.peerconnection.enabled': false,
      'network.dns.disablePrefetch': true,
      'network.prefetch-next': false,
    };
  }
  return opts;
}
