import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createBridge } from '../src/server.mjs';

const SECRET = 'SUPER-SECRET-VALUE-123';

function tempDist() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Arena</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

/** Raw HTTP so the Host header can be set freely. */
function get(port, path, headers = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

function openFeed(port, origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/feed`, { headers: { origin } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  return { ws, messages, opened: new Promise((ok, fail) => (ws.on('open', ok), ws.on('error', fail), ws.on('unexpected-response', (_q, r) => fail(new Error(`HTTP ${r.statusCode}`))))) };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

test('mock bridge serves Arena and streams sequenced ticks to its own origin', async () => {
  const b = await createBridge({ mode: 'mock', port: 0, distDir: tempDist(), log: () => {} });
  try {
    const root = await get(b.port, '/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, '/arena/?real=1');
    const page = await get(b.port, '/arena/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Arena/);
    assert.equal((await get(b.port, '/arena/assets/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');

    const feed = openFeed(b.port, `http://127.0.0.1:${b.port}`);
    await feed.opened;
    await until(() => feed.messages.filter((m) => m.type === 'tick').length >= 3);
    const [hello] = feed.messages;
    assert.equal(hello.type, 'hello');
    assert.equal(hello.mode, 'mock');
    assert.equal(hello.instrument.lot, 65);
    const ticks = feed.messages.filter((m) => m.type === 'tick');
    assert.ok(ticks.every((t, i) => i === 0 || t.seq === ticks[i - 1].seq + 1), 'gap-free sequence');
    assert.ok(Number.isInteger(ticks[0].ltp) && ticks[0].bids.length === 5 && ticks[0].asks.length === 5);
    feed.ws.close();
  } finally {
    await b.close();
  }
});

test('rejects other websites: wrong Host (DNS rebinding) and wrong Origin', async () => {
  const b = await createBridge({ mode: 'mock', port: 0, distDir: tempDist(), log: () => {} });
  try {
    assert.equal((await get(b.port, '/arena/', { host: 'evil.example:80' })).status, 421);
    await assert.rejects(openFeed(b.port, 'https://evil.example').opened, /403/);
    await assert.rejects(openFeed(b.port, 'null').opened, /403/);
  } finally {
    await b.close();
  }
});

test('static files cannot escape the build folder', async () => {
  const b = await createBridge({ mode: 'mock', port: 0, distDir: tempDist(), log: () => {} });
  try {
    // An encoded slash survives URL parsing and reaches the file handler: refused.
    const r = await get(b.port, '/arena/..%2f..%2fpackage.json');
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /arena-bridge/);
    // Dot segments are normalised away by the URL parser before routing: nothing leaks either.
    const dots = await get(b.port, '/arena/%2e%2e/%2e%2e/package.json');
    assert.doesNotMatch(dots.body, /arena-bridge/);
  } finally {
    await b.close();
  }
});

/** A fake Kite: records calls, returns a session, instruments and an LTP. */
function fakeKite(calls) {
  return ({ apiKey, accessToken }) => ({
    async createSession(requestToken, secret) {
      calls.push({ op: 'createSession', apiKey, requestToken, secret });
      return { access_token: 'ACCESS-1' };
    },
    async profile() {
      calls.push({ op: 'profile', accessToken });
      return { user_id: 'AB1234' };
    },
    async instruments(exchange) {
      calls.push({ op: 'instruments', exchange });
      return [
        { instrument_token: '3', tradingsymbol: 'NIFTY26OCTFUT', name: 'NIFTY', expiry: '2099-10-27', tick_size: '0.05', lot_size: '65', instrument_type: 'FUT', segment: 'NFO-FUT', exchange: 'NFO' },
      ];
    },
    async ltpPaise(keys) {
      calls.push({ op: 'ltp', keys });
      return { 'NFO:NIFTY26OCTFUT': 2_451_230 };
    },
  });
}

test('kite login: CSRF state checked, session saved privately, contract resolved, secret never leaves', async () => {
  const calls = [];
  const feeds = [];
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'arena-session-')), 'session.json');
  const b = await createBridge({
    mode: 'kite',
    port: 0,
    apiKey: 'KEY',
    apiSecret: SECRET,
    distDir: tempDist(),
    sessionFile,
    makeClient: fakeKite(calls),
    makeKiteFeed: (opts) => {
      const f = Object.assign(new EventEmitter(), { opts, start() {}, stop() {} });
      feeds.push(f);
      return f;
    },
    log: () => {},
  });
  const seen = [];
  try {
    const feed = openFeed(b.port, `http://localhost:${b.port}`);
    await feed.opened;
    await until(() => feed.messages.length >= 1);
    assert.equal(feed.messages[0].loggedIn, false);
    assert.equal(feed.messages[0].configured, true);

    const login = await get(b.port, '/kite/login');
    seen.push(login.body, JSON.stringify(login.headers));
    assert.equal(login.status, 302);
    const state = new URL(login.headers.location).searchParams.get('redirect_params').replace('state=', '');
    assert.match(state, /^[0-9a-f]{32}$/);

    // A callback that didn't start here (login CSRF) is refused before anything is exchanged.
    const forged = await get(b.port, '/kite/callback?status=success&request_token=ATTACKER&state=deadbeef');
    assert.equal(forged.status, 400);
    assert.equal(calls.length, 0);

    const ok = await get(b.port, `/kite/callback?status=success&action=login&request_token=REQ-9&state=${state}`);
    seen.push(ok.body, JSON.stringify(ok.headers));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/arena/?real=1');
    assert.deepEqual(calls[0], { op: 'createSession', apiKey: 'KEY', requestToken: 'REQ-9', secret: SECRET });
    // The state is single-use.
    assert.equal((await get(b.port, `/kite/callback?status=success&request_token=REQ-9&state=${state}`)).status, 400);

    const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(saved.accessToken, 'ACCESS-1');
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600, 'session file readable by you only');

    await until(() => feed.messages.some((m) => m.type === 'hello' && m.loggedIn));
    const hello = feed.messages.findLast((m) => m.type === 'hello');
    assert.deepEqual(hello.instrument, { symbol: 'NIFTY26OCTFUT', name: 'NIFTY', expiry: '2099-10-27', tickPaise: 5, lot: 65 });
    assert.equal(hello.lastPrice, 2_451_230);
    assert.equal(feeds[0].opts.token, 3);

    feeds[0].emit('tick', { ltp: 2_451_235, bids: [{ price: 2_451_230, qty: 130, orders: 2 }], asks: [{ price: 2_451_240, qty: 65, orders: 1 }], volume: 10, ts: 1 });
    await until(() => feed.messages.some((m) => m.type === 'tick'));
    seen.push(...feed.messages.map((m) => JSON.stringify(m)));
    feed.ws.close();
  } finally {
    await b.close();
  }
  for (const text of seen) assert.ok(!text.includes(SECRET), 'the API secret never appears in a response or feed message');
});

test('without credentials the bridge still runs and says how to set up', async () => {
  const b = await createBridge({ mode: 'kite', port: 0, apiKey: '', apiSecret: '', distDir: tempDist(), log: () => {} });
  try {
    const feed = openFeed(b.port, `http://127.0.0.1:${b.port}`);
    await feed.opened;
    await until(() => feed.messages.length >= 1);
    assert.equal(feed.messages[0].configured, false);
    assert.equal((await get(b.port, '/kite/login')).status, 400);
    feed.ws.close();
  } finally {
    await b.close();
  }
});
