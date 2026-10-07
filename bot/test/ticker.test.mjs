import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Ticker } from '../src/ticker.mjs';

test('ticker subscribes in full mode, follows token changes and emits parsed ticks', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const got = [];
  wss.on('connection', (ws, req) => {
    assert.match(req.url, /api_key=K&access_token=T/);
    ws.on('message', (m) => {
      got.push(JSON.parse(m.toString()));
      if (got.length === 2) {
        // One index packet: NIFTY 50 at ₹24,612.45.
        const buf = Buffer.alloc(2 + 2 + 32);
        buf.writeUInt16BE(1, 0);
        buf.writeUInt16BE(32, 2);
        buf.writeUInt32BE(256265, 4);
        buf.writeUInt32BE(2_461_245, 8);
        ws.send(buf, { binary: true });
      }
    });
  });
  const t = new Ticker({ apiKey: 'K', accessToken: 'T', root: `ws://127.0.0.1:${wss.address().port}/` });
  t.setTokens([256265, 264969]);
  t.start();
  const [tick] = await once(t, 'tick');
  assert.deepEqual(got, [{ a: 'subscribe', v: [256265, 264969] }, { a: 'mode', v: ['full', [256265, 264969]] }]);
  assert.equal(tick.ltp, 2_461_245);
  assert.equal(tick.index, true);
  t.setTokens([256265, 77]);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got.slice(2), [{ a: 'unsubscribe', v: [264969] }, { a: 'subscribe', v: [77] }, { a: 'mode', v: ['full', [77]] }]);
  t.stop();
  wss.close();
});
