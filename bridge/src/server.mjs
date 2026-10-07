// Arena's local bridge: Kite Connect on one side, Arena in your browser on
// the other. It listens on 127.0.0.1 only. The API secret stays in this
// process: it is read from the environment (or bridge/.env), used once a day
// to create a session, and never logged or sent to the browser.
//
//   node src/server.mjs          # real Kite data (needs KITE_API_KEY, KITE_API_SECRET)
//   node src/server.mjs --mock   # synthetic ticks, no Kite needed

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { KiteFeed, MockFeed } from './feeds.mjs';
import { frontMonthFuture, istDate, KiteClient, loginUrl } from './kite.mjs';
import { ENV_FILE, loadDotEnv, readSession, SESSION_FILE, writeSession } from './session.mjs';

export { loadDotEnv };

const here = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DIST = resolve(here, '../../web/dist');
const DEFAULT_SESSION = SESSION_FILE;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Starts the bridge. Options are injectable for tests.
 * Resolves to { url, close }.
 */
export async function createBridge({
  mode = 'kite',
  port = 8765,
  host = '127.0.0.1',
  apiKey = process.env.KITE_API_KEY,
  apiSecret = process.env.KITE_API_SECRET,
  underlying = process.env.ARENA_UNDERLYING || 'NIFTY',
  distDir = DEFAULT_DIST,
  sessionFile = DEFAULT_SESSION,
  makeClient = (opts) => new KiteClient(opts),
  makeKiteFeed = (opts) => new KiteFeed(opts),
  makeMockFeed = () => new MockFeed(),
  log = (...a) => console.log('[bridge]', ...a),
} = {}) {
  const state = {
    mode,
    configured: mode === 'mock' || Boolean(apiKey && apiSecret),
    loggedIn: mode === 'mock',
    instrument: null,
    lastPrice: null,
    status: { state: 'idle' },
    seq: 0,
    lastTick: null,
  };
  const pendingLogins = new Map(); // state → expiry
  let feed = null;
  let actualPort = port;
  const clients = new Set();

  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);

  const hello = () => ({
    type: 'hello',
    mode: state.mode,
    configured: state.configured,
    loggedIn: state.loggedIn,
    instrument: state.instrument,
    lastPrice: state.lastPrice,
    status: state.status,
  });

  const broadcast = (msg) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      // A slow browser tab drops ticks rather than growing memory; the next tick is a full picture anyway.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) ws.send(text);
    }
  };

  const startFeed = (f) => {
    feed?.stop();
    feed = f;
    f.on('status', (s) => {
      state.status = s;
      broadcast({ type: 'status', status: s });
    });
    f.on('tick', (t) => {
      state.lastPrice = t.ltp;
      state.lastTick = { type: 'tick', seq: ++state.seq, ...t };
      broadcast(state.lastTick);
    });
    f.start();
  };

  /** After login (or with a saved session): find the contract and start streaming. */
  const startKite = async (accessToken) => {
    const client = makeClient({ apiKey, accessToken });
    await client.profile(); // throws if the token is no longer valid
    const rows = await client.instruments('NFO');
    const fut = frontMonthFuture(rows, underlying, istDate());
    if (!fut) throw new Error(`No ${underlying} future found in the NFO instrument list.`);
    const key = `${fut.exchange}:${fut.symbol}`;
    const ltp = (await client.ltpPaise([key]))[key] ?? null;
    state.instrument = { symbol: fut.symbol, name: fut.name, expiry: fut.expiry, tickPaise: fut.tickPaise, lot: fut.lot };
    state.lastPrice = ltp;
    state.loggedIn = true;
    log(`streaming ${fut.symbol} (lot ${fut.lot}, expiry ${fut.expiry})`);
    broadcast(hello());
    startFeed(makeKiteFeed({ apiKey, accessToken, token: fut.token }));
  };

  const serveStatic = async (res, urlPath) => {
    let rel = decodeURIComponent(urlPath.replace(/^\/arena\/?/, '')) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(distDir, rel);
    if (!file.startsWith(resolve(distDir) + sep)) return send(res, 403, 'Forbidden');
    if (!existsSync(distDir)) return send(res, 503, 'Arena is not built yet. Run `npm run build` in web/ first.');
    const target = existsSync(file) && statSync(file).isFile() ? file : join(distDir, 'index.html');
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };

  const send = (res, code, text, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(text);
  };

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer requests addressed to this machine by name.
      if (!allowedHosts().has(req.headers.host ?? '')) return send(res, 421, 'Misdirected request');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/' || url.pathname === '/arena') return send(res, 302, '', { Location: '/arena/?real=1' });
      if (url.pathname === '/kite/login') {
        if (mode !== 'kite' || !state.configured) return send(res, 400, 'Set KITE_API_KEY and KITE_API_SECRET first (see docs/REAL_MARKET.md).');
        const s = randomBytes(16).toString('hex');
        pendingLogins.set(s, Date.now() + 10 * 60_000);
        return send(res, 302, '', { Location: loginUrl(apiKey, s) });
      }
      if (url.pathname === '/kite/callback') {
        const s = url.searchParams.get('state') ?? '';
        const valid = [...pendingLogins].some(([k, exp]) => exp > Date.now() && same(k, s));
        pendingLogins.delete(s);
        if (!valid) return send(res, 400, 'Login link expired or not started here. Start again from Arena.');
        if (url.searchParams.get('status') !== 'success') return send(res, 400, 'Kite login was not completed.');
        const requestToken = url.searchParams.get('request_token') ?? '';
        const client = makeClient({ apiKey });
        const session = await client.createSession(requestToken, apiSecret);
        writeSession(sessionFile, apiKey, session.access_token);
        await startKite(session.access_token);
        return send(res, 302, '', { Location: '/arena/?real=1' });
      }
      if (url.pathname.startsWith('/arena/')) return await serveStatic(res, url.pathname);
      return send(res, 404, 'Not found');
    } catch (err) {
      log('error:', err.message);
      state.status = { state: 'error', message: err.message };
      broadcast({ type: 'status', status: state.status });
      return send(res, 502, `Kite error: ${err.message}`);
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    // Only Arena, served from this bridge, may read the feed: other sites can open sockets to 127.0.0.1 too.
    if (url.pathname !== '/feed' || !allowedHosts().has(req.headers.host ?? '') || !allowedOrigins().has(req.headers.origin ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify(hello()));
      if (state.lastTick) ws.send(JSON.stringify(state.lastTick));
    });
  });

  await new Promise((ok) => server.listen(port, host, ok));
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;

  if (mode === 'mock') {
    const mock = makeMockFeed();
    state.instrument = { symbol: 'NIFTY FUT (mock)', name: 'NIFTY', expiry: null, tickPaise: mock.tickPaise, lot: mock.lot };
    state.lastPrice = mock.price;
    startFeed(mock);
  } else if (state.configured) {
    const saved = readSession(sessionFile, apiKey);
    if (saved) {
      await startKite(saved).catch((err) => log(`saved session not usable (${err.message}); log in again`));
    }
  } else {
    log('KITE_API_KEY / KITE_API_SECRET not set: Arena will show setup steps.');
  }

  return {
    url,
    port: actualPort,
    state,
    close: () =>
      new Promise((ok) => {
        feed?.stop();
        for (const ws of clients) ws.terminate();
        wss.close();
        server.close(() => ok());
      }),
  };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv(ENV_FILE);
  const mock = process.argv.includes('--mock');
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const bridge = await createBridge({ mode: mock ? 'mock' : 'kite', port: portArg ? Number(portArg.slice(7)) : Number(process.env.ARENA_PORT || 8765) });
  console.log(`[bridge] Arena real-market mode: ${bridge.url}/arena/?real=1${mock ? '  (mock ticks)' : ''}`);
  if (!mock) console.log(`[bridge] Kite app redirect URL must be: ${bridge.url}/kite/callback`);
  const stop = () => bridge.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
