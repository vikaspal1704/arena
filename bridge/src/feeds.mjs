// Tick sources. Both emit the same shape:
//   { ltp, bids: [{price, qty, orders}], asks: [...], volume, ts }   (prices in paise)

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { parseTicks, WS_ROOT } from './kite.mjs';

/** Live ticks for one instrument from the Kite ticker, with reconnect. */
export class KiteFeed extends EventEmitter {
  constructor({ apiKey, accessToken, token, root = WS_ROOT, WebSocketImpl = WebSocket }) {
    super();
    Object.assign(this, { apiKey, accessToken, token, root, WebSocketImpl });
    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.lastRead = 0;
    this.watchdog = null;
  }

  start() {
    this.stopped = false;
    this.connect();
    // Kite sends a heartbeat every second; silence for 5 s means a dead socket.
    this.watchdog = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastRead > 5000) this.ws.terminate();
    }, 2000);
    return this;
  }

  connect() {
    const url = `${this.root}?api_key=${encodeURIComponent(this.apiKey)}&access_token=${encodeURIComponent(this.accessToken)}`;
    const ws = new this.WebSocketImpl(url, { headers: { 'X-Kite-Version': '3' } });
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.emit('status', { state: 'connecting' });
    ws.on('open', () => {
      this.attempt = 0;
      this.lastRead = Date.now();
      ws.send(JSON.stringify({ a: 'subscribe', v: [this.token] }));
      ws.send(JSON.stringify({ a: 'mode', v: ['full', [this.token]] }));
      this.emit('status', { state: 'live' });
    });
    ws.on('message', (data, isBinary) => {
      this.lastRead = Date.now();
      if (!isBinary) {
        // Text frames carry errors and order updates.
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'error') this.emit('status', { state: 'error', message: String(msg.data) });
        } catch {
          /* ignore */
        }
        return;
      }
      for (const tick of parseTicks(data)) if (tick.token === this.token) this.emit('tick', tick);
    });
    ws.on('close', (code) => {
      this.emit('status', { state: 'closed', message: `Kite connection closed (${code})` });
      if (this.stopped) return;
      // 403 on connect means the access token is no longer valid; don't hammer.
      const delay = Math.min(60_000, 2000 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.connect(), delay);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.emit('status', { state: 'error', message: `Kite refused the connection (HTTP ${res.statusCode}). Log in again.` });
      if (res.statusCode === 403) this.stopped = true;
    });
    ws.on('error', () => {
      /* 'close' follows and handles the retry */
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.ws?.terminate();
  }
}

/**
 * Synthetic ticks with the same shape, for trying Arena's real-market mode
 * without Kite and for tests. Seeded, so runs are reproducible.
 */
export class MockFeed extends EventEmitter {
  constructor({ startPaise = 2_450_000, tickPaise = 5, lot = 65, intervalMs = 250, seed = 7 } = {}) {
    super();
    Object.assign(this, { price: startPaise, tickPaise, lot, intervalMs });
    this.s = seed >>> 0 || 1;
    this.volume = 0;
  }

  rand() {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 2 ** 32;
  }

  next() {
    const r = this.rand();
    this.price += (r < 0.45 ? -1 : r > 0.55 ? 1 : 0) * this.tickPaise * (1 + Math.floor(this.rand() * 3));
    const qty = () => this.lot * (1 + Math.floor(this.rand() * 12));
    const level = (i, side) => ({ price: this.price + side * (i + 1) * this.tickPaise, qty: qty(), orders: 1 + Math.floor(this.rand() * 9) });
    this.volume += qty();
    return {
      ltp: this.price,
      bids: [0, 1, 2, 3, 4].map((i) => level(i, -1)),
      asks: [0, 1, 2, 3, 4].map((i) => level(i, 1)),
      volume: this.volume,
      ts: Date.now(),
    };
  }

  start() {
    this.emit('status', { state: 'live' });
    this.timer = setInterval(() => this.emit('tick', this.next()), this.intervalMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }
}
