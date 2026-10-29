/**
 * Proxy support verification (native engine + CLI)
 *
 * Spins up a local target site, an authenticating HTTP proxy (CONNECT + absolute-form)
 * and a minimal SOCKS5 proxy, then checks that every request path goes where it should.
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { MemoraBrowser } from '../src/engine/browser.js';
import { NetworkFetcher } from '../src/network/fetcher.js';
import { shouldBypassProxy } from '../src/network/proxy.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, detail ?? '');
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

// ---------------------------------------------------------------- target site
const targetHits: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
const target = http.createServer((req, res) => {
  targetHits.push({ path: req.url || '', headers: req.headers });
  if (req.url === '/login-redirect') {
    res.writeHead(302, { Location: '/home', 'Set-Cookie': 'session=abc123; Path=/; HttpOnly' });
    return res.end();
  }
  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.url === '/fetcher') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<html><head><title>Fetcher</title></head><body><div id="out"></div>
      <script>fetch('/api/data').then(r => r.json()).then(d => { document.getElementById('out').textContent = 'loaded:' + d.ok; });</script>
      </body></html>`);
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<html><head><title>Target ${req.url}</title></head><body><h1>Hello from target</h1><p id="cookie">${req.headers.cookie || ''}</p></body></html>`);
});

// ---------------------------------------------------------------- HTTP proxy
type ProxyLog = { kind: 'connect' | 'forward'; target: string; auth?: string };
function makeHttpProxy(requiredAuth?: string) {
  const log: ProxyLog[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers['proxy-authorization'];
    log.push({ kind: 'forward', target: req.url || '', auth });
    if (requiredAuth && auth !== requiredAuth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const url = new URL(req.url!);
    const upstream = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers: req.headers }, up => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket: net.Socket, head) => {
    const auth = req.headers['proxy-authorization'];
    log.push({ kind: 'connect', target: req.url || '', auth });
    if (requiredAuth && auth !== requiredAuth) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    const [host, port] = (req.url || '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return { server, log };
}

// ---------------------------------------------------------------- SOCKS5 proxy (RFC 1928 + RFC 1929)
function makeSocksProxy(user?: string, pass?: string) {
  const log: string[] = [];
  const server = net.createServer(client => {
    let stage: 'greet' | 'auth' | 'request' = 'greet';
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = buf.subarray(2, 2 + buf[1]);
        buf = buf.subarray(2 + buf[1]);
        if (user) {
          if (!methods.includes(0x02)) return client.end(Buffer.from([0x05, 0xff]));
          client.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
      }
      if (stage === 'auth' && buf.length >= 2) {
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const u = buf.subarray(2, 2 + ulen).toString();
        const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const ok = u === user && p === pass;
        log.push(`auth:${u}:${ok ? 'ok' : 'bad'}`);
        client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) return client.end();
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 7) {
        const atyp = buf[3];
        let host: string;
        let offset: number;
        if (atyp === 0x01) { host = Array.from(buf.subarray(4, 8)).join('.'); offset = 8; }
        else if (atyp === 0x03) { const len = buf[4]; host = buf.subarray(5, 5 + len).toString(); offset = 5 + len; }
        else return client.end();
        if (buf.length < offset + 2) return;
        const port = buf.readUInt16BE(offset);
        const rest = buf.subarray(offset + 2);
        client.removeListener('data', onData);
        log.push(`connect:${host}:${port}`);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      }
    };
    client.on('data', onData);
  });
  return { server, log };
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function main() {
  console.log('================================================================');
  console.log('🌐 MEMORA PROXY SUPPORT VERIFICATION');
  console.log('================================================================\n');

  const targetPort = await listen(target);
  const base = `http://127.0.0.1:${targetPort}`;
  const basicAuth = 'Basic ' + Buffer.from('agent:s3cret').toString('base64');

  const open = makeHttpProxy();
  const openPort = await listen(open.server);
  const authed = makeHttpProxy(basicAuth);
  const authedPort = await listen(authed.server);
  const bearer = makeHttpProxy('Bearer MY-TOKEN');
  const bearerPort = await listen(bearer.server);
  const socks = makeSocksProxy('sockuser', 'sockpass');
  const socksPort = await listen(socks.server);

  try {
    console.log('▶ Direct connection (no proxy)');
    {
      const browser = new MemoraBrowser();
      const page = browser.newPage();
      const r = await page.goto(`${base}/direct`);
      check('page loads directly', r.status === 200 && page.title() === 'Target /direct');
      check('no proxy traffic', open.log.length === 0 && authed.log.length === 0);
      browser.close();
    }

    console.log('▶ HTTP proxy');
    {
      const browser = new MemoraBrowser({ network: { proxy: `http://127.0.0.1:${openPort}` } });
      const page = browser.newPage();
      const r = await page.goto(`${base}/via-proxy`);
      check('page loads through proxy', r.status === 200 && page.title() === 'Target /via-proxy');
      check('proxy saw the request', open.log.some(l => l.target.includes(`127.0.0.1:${targetPort}`)), open.log);
      browser.close();
    }

    console.log('▶ HTTP proxy with basic auth (user:pass@ in URL)');
    {
      const browser = new MemoraBrowser({ network: { proxy: `http://agent:s3cret@127.0.0.1:${authedPort}` } });
      const page = browser.newPage();
      const r = await page.goto(`${base}/basic`);
      check('authenticated request succeeds', r.status === 200 && page.title() === 'Target /basic');
      check('proxy received Basic credentials', authed.log.some(l => l.auth === basicAuth), authed.log);
      browser.close();
    }

    console.log('▶ Wrong proxy credentials surface a clear error');
    {
      const browser = new MemoraBrowser({ network: { proxy: `http://agent:wrong@127.0.0.1:${authedPort}` } });
      const page = browser.newPage();
      let message = '';
      try { await page.goto(`${base}/denied`); } catch (e: any) { message = e.message; }
      check('navigation rejected', message.length > 0, message);
      check('error mentions proxy auth (407)', /407|proxy/i.test(message), message);
      browser.close();
    }

    console.log('▶ Bearer token (--proxy-bearer-token)');
    {
      const browser = new MemoraBrowser({ network: { proxy: `http://127.0.0.1:${bearerPort}`, proxyBearerToken: 'MY-TOKEN' } });
      const page = browser.newPage();
      const r = await page.goto(`${base}/bearer`);
      check('bearer-authenticated request succeeds', r.status === 200);
      check('proxy received Bearer token', bearer.log.some(l => l.auth === 'Bearer MY-TOKEN'), bearer.log);
      browser.close();
    }

    console.log('▶ SOCKS5 proxy with username/password');
    {
      const browser = new MemoraBrowser({ network: { proxy: `socks5://sockuser:sockpass@127.0.0.1:${socksPort}` } });
      const page = browser.newPage();
      const r = await page.goto(`${base}/socks`);
      check('page loads through SOCKS5', r.status === 200 && page.title() === 'Target /socks');
      check('SOCKS5 auth + CONNECT seen', socks.log.includes('auth:sockuser:ok') && socks.log.some(l => l.startsWith('connect:')), socks.log);
      browser.close();
    }

    console.log('▶ Proxy bypass list');
    {
      check('exact host', shouldBypassProxy('http://localhost:3000/x', ['localhost']));
      check('subdomain via leading dot', shouldBypassProxy('https://api.internal.corp/', ['.internal.corp']));
      check('wildcard', shouldBypassProxy('https://a.b.example.com/', ['*.example.com']));
      check('port-specific rule', shouldBypassProxy('http://127.0.0.1:8080/', ['127.0.0.1:8080']) && !shouldBypassProxy('http://127.0.0.1:9090/', ['127.0.0.1:8080']));
      check('non-matching host is proxied', !shouldBypassProxy('https://example.org/', ['example.com']));

      const before = open.log.length;
      const browser = new MemoraBrowser({ network: { proxy: `http://127.0.0.1:${openPort}`, noProxy: ['127.0.0.1'] } });
      const page = browser.newPage();
      await page.goto(`${base}/bypassed`);
      check('bypassed host skips the proxy', open.log.length === before && page.title() === 'Target /bypassed');
      browser.close();
    }

    console.log('▶ Page fetch() inherits the proxy');
    {
      const before = open.log.length;
      const browser = new MemoraBrowser({ network: { proxy: `http://127.0.0.1:${openPort}` } });
      const page = browser.newPage();
      await page.goto(`${base}/fetcher`);
      await new Promise(r => setTimeout(r, 300));
      check('in-page fetch() resolved', page.querySelector('#out')?.textContent === 'loaded:true', page.querySelector('#out')?.textContent);
      check('in-page fetch() went through proxy', open.log.length >= before + 2, open.log.slice(before));
      browser.close();
    }

    console.log('▶ Custom headers + cookies across redirects');
    {
      const fetcher = new NetworkFetcher({ headers: { 'X-Test-Run': 'memora' }, userAgent: 'MemoraTest/1.0' });
      const r = await fetcher.get(`${base}/login-redirect`);
      const last = targetHits[targetHits.length - 1];
      check('redirect followed', r.url.endsWith('/home') && r.status === 200);
      check('cookie from 302 hop sent to the next hop', String(last.headers.cookie).includes('session=abc123'), last.headers.cookie);
      check('custom header sent', last.headers['x-test-run'] === 'memora');
      check('user agent override', last.headers['user-agent'] === 'MemoraTest/1.0');
      await fetcher.close();
    }

    console.log('▶ CLI: memora-browser fetch --http-proxy');
    {
      const before = authed.log.length;
      const r = await runCli(['fetch', `${base}/cli`, '--dump', 'html', '--http-proxy', `http://agent:s3cret@127.0.0.1:${authedPort}`]);
      check('CLI exits 0', r.code === 0, r.stderr);
      check('CLI output came from target', r.stdout.includes('Hello from target'), r.stdout.slice(0, 200));
      check('CLI request went through proxy', authed.log.length > before);

      const bad = await runCli(['fetch', `${base}/cli`, '--http-proxy', 'ftp://nope:21']);
      check('CLI rejects unsupported proxy scheme', bad.code !== 0 && /Unsupported proxy protocol/.test(bad.stderr), bad.stderr);
    }
  } finally {
    for (const s of [target, open.server, authed.server, bearer.server, socks.server]) {
      (s as any).closeAllConnections?.();
      s.close();
    }
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} Proxy checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
