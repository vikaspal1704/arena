// Kite ticker for many instruments at once (index spots, India VIX and a band
// of option strikes), full mode, with reconnect and a heartbeat watchdog.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { parseTicks, WS_ROOT } from '../../bridge/src/kite.mjs';

export class Ticker extends EventEmitter {
  constructor({ apiKey, accessToken, root = WS_ROOT, WebSocketImpl = WebSocket }) {
    super();
    Object.assign(this, { apiKey, accessToken, root, WebSocketImpl });
    this.tokens = new Set();
    this.attempt = 0;
    this.lastRead = 0;
    this.stopped = false;
  }

  start() {
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastRead > 5000) this.ws.terminate();
    }, 2000);
    return this;
  }

  /** Makes the subscription exactly `tokens`. */
  setTokens(tokens) {
    const next = new Set(tokens);
    const add = [...next].filter((t) => !this.tokens.has(t));
    const remove = [...this.tokens].filter((t) => !next.has(t));
    this.tokens = next;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (remove.length) this.ws.send(JSON.stringify({ a: 'unsubscribe', v: remove }));
    if (add.length) this.subscribe(add);
  }

  subscribe(tokens) {
    this.ws.send(JSON.stringify({ a: 'subscribe', v: tokens }));
    this.ws.send(JSON.stringify({ a: 'mode', v: ['full', tokens] }));
  }

  connect() {
    const url = `${this.root}?api_key=${encodeURIComponent(this.apiKey)}&access_token=${encodeURIComponent(this.accessToken)}`;
    const ws = new this.WebSocketImpl(url, { headers: { 'X-Kite-Version': '3' } });
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => {
      this.attempt = 0;
      this.lastRead = Date.now();
      if (this.tokens.size) this.subscribe([...this.tokens]);
      this.emit('status', 'live');
    });
    ws.on('message', (data, isBinary) => {
      this.lastRead = Date.now();
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'error') this.emit('status', `error: ${msg.data}`);
        } catch {
          /* not JSON */
        }
        return;
      }
      for (const tick of parseTicks(data)) this.emit('tick', tick);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.emit('status', `refused (HTTP ${res.statusCode})`);
      if (res.statusCode === 403) this.stopped = true;
    });
    ws.on('close', () => {
      this.emit('status', 'disconnected');
      if (this.stopped) return;
      this.retry = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.attempt++));
    });
    ws.on('error', () => {});
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.ws?.terminate();
  }
}
