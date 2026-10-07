import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { KiteTicker } from 'kiteconnect';
import { checksum, frontMonthFuture, KiteClient, KiteError, loginUrl, paiseToRupees, parseInstrumentsCsv, parseTicks } from '../src/kite.mjs';

test('checksum is sha256 of key + request token + secret', () => {
  const expected = createHash('sha256').update('keyREQsecret').digest('hex');
  assert.equal(checksum('key', 'REQ', 'secret'), expected);
});

test('login url carries the key, version 3 and the CSRF state', () => {
  const u = new URL(loginUrl('abc123', 'f00d'));
  assert.equal(u.origin + u.pathname, 'https://kite.zerodha.com/connect/login');
  assert.equal(u.searchParams.get('api_key'), 'abc123');
  assert.equal(u.searchParams.get('v'), '3');
  assert.equal(u.searchParams.get('redirect_params'), 'state=f00d');
});

const CSV = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '1,1,NIFTY26SEPFUT,NIFTY,0,2026-09-29,0,0.05,65,FUT,NFO-FUT,NFO', // expired
  '2,2,NIFTY26NOVFUT,NIFTY,0,2026-11-24,0,0.05,65,FUT,NFO-FUT,NFO',
  '3,3,NIFTY26OCTFUT,NIFTY,0,2026-10-27,0,0.05,65,FUT,NFO-FUT,NFO', // front month
  '4,4,BANKNIFTY26OCTFUT,BANKNIFTY,0,2026-10-27,0,0.05,30,FUT,NFO-FUT,NFO',
  '5,5,NIFTY26OCT24500CE,NIFTY,0,2026-10-27,24500,0.05,65,CE,NFO-OPT,NFO',
  '6,6,TEST,"ACME, LTD ""A""",0,,0,0.05,1,EQ,NSE,NSE',
].join('\n');

test('parses the instruments CSV, including quoted fields', () => {
  const rows = parseInstrumentsCsv(CSV);
  assert.equal(rows.length, 6);
  assert.equal(rows[5].name, 'ACME, LTD "A"');
});

test('front_month_future_skips_expired_contracts_options_and_other_underlyings', () => {
  const fut = frontMonthFuture(parseInstrumentsCsv(CSV), 'NIFTY', '2026-10-07');
  assert.deepEqual(fut, { token: 3, exchange: 'NFO', symbol: 'NIFTY26OCTFUT', name: 'NIFTY', expiry: '2026-10-27', tickPaise: 5, lot: 65 });
  // On expiry day the contract still trades.
  assert.equal(frontMonthFuture(parseInstrumentsCsv(CSV), 'NIFTY', '2026-10-27').symbol, 'NIFTY26OCTFUT');
  assert.equal(frontMonthFuture(parseInstrumentsCsv(CSV), 'NIFTY', '2027-01-01'), null);
});

/** A Kite frame: [u16 count] then [u16 len][packet] each. Big-endian. */
function frame(packets) {
  const size = 2 + packets.reduce((s, p) => s + 2 + p.byteLength, 0);
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint16(0, packets.length);
  let o = 2;
  for (const p of packets) {
    v.setUint16(o, p.byteLength);
    new Uint8Array(buf, o + 2, p.byteLength).set(new Uint8Array(p));
    o += 2 + p.byteLength;
  }
  return buf;
}

/** A 184-byte full-mode F&O packet. Prices are rupees × 100 on the wire. */
function fullPacket({ token, ltp, close, ts, bids, asks }) {
  const p = new ArrayBuffer(184);
  const v = new DataView(p);
  v.setUint32(0, token);
  v.setUint32(4, ltp);
  v.setUint32(8, 65); // last traded qty
  v.setUint32(12, ltp - 3); // average price
  v.setUint32(16, 1_234_567); // volume
  v.setUint32(20, 50_000);
  v.setUint32(24, 60_000);
  v.setUint32(28, close + 100); // open
  v.setUint32(32, close + 900); // high
  v.setUint32(36, close - 700); // low
  v.setUint32(40, close);
  v.setUint32(44, ts - 1); // last trade time
  v.setUint32(48, 9_000_000); // OI
  v.setUint32(60, ts);
  [...bids, ...asks].forEach((l, i) => {
    v.setUint32(64 + i * 12, l.qty);
    v.setUint32(64 + i * 12 + 4, l.price);
    v.setUint16(64 + i * 12 + 8, l.orders);
  });
  return p;
}

test('tick_parser_matches_the_official_kite_parser_byte_for_byte', () => {
  // NFO token: low byte 2 (NseFO), so the official parser divides by 100.
  const token = (12345 << 8) | 2;
  const bids = [0, 1, 2, 3, 4].map((i) => ({ qty: 65 * (i + 2), price: 2_450_000 - 5 * i, orders: i + 1 }));
  const asks = [0, 1, 2, 3, 4].map((i) => ({ qty: 65 * (i + 3), price: 2_450_005 + 5 * i, orders: i + 2 }));
  const ltpOnly = new ArrayBuffer(8);
  new DataView(ltpOnly).setUint32(0, 256 + 2);
  const buf = frame([ltpOnly, fullPacket({ token, ltp: 2_450_005, close: 2_430_000, ts: 1_791_350_000, bids, asks })]);

  const official = new KiteTicker({ api_key: 'k', access_token: 't' }).parseBinary(buf).find((t) => t.mode === 'full');
  const [ours] = parseTicks(buf);

  assert.equal(ours.token, official.instrument_token);
  assert.equal(ours.ltp, Math.round(official.last_price * 100));
  assert.equal(ours.close, Math.round(official.ohlc.close * 100));
  assert.equal(ours.volume, official.volume_traded);
  assert.equal(ours.ts, official.exchange_timestamp.getTime());
  const map = (side) => side.map((d) => ({ qty: d.quantity, price: Math.round(d.price * 100), orders: d.orders }));
  assert.deepEqual(ours.bids, map(official.depth.buy));
  assert.deepEqual(ours.asks, map(official.depth.sell));
  // Exact paise from the start: no float ever touches our prices.
  assert.deepEqual(ours.bids.map((b) => b.price), bids.map((b) => b.price));
});

test('tick_parser_skips_heartbeats_and_partial_frames', () => {
  assert.deepEqual(parseTicks(new ArrayBuffer(1)), []);
  const truncated = frame([fullPacket({ token: 2, ltp: 1, close: 1, ts: 1, bids: [], asks: [] })]).slice(0, 100);
  assert.deepEqual(parseTicks(truncated), []);
});

test('client sends the documented headers and form, and maps Kite errors', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/session/token')) {
      return new Response(JSON.stringify({ status: 'success', data: { access_token: 'AT' } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 'error', error_type: 'TokenException', message: 'Token is invalid or has expired.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  };
  const c = new KiteClient({ apiKey: 'KEY', fetchImpl: fakeFetch });
  await c.createSession('REQ', 'SECRET');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.kite.trade/session/token');
  assert.equal(calls[0].init.headers['X-Kite-Version'], '3');
  assert.equal(form.get('checksum'), checksum('KEY', 'REQ', 'SECRET'));
  assert.equal(form.has('api_secret'), false, 'the secret itself is never sent');
  await assert.rejects(c.profile(), (e) => e instanceof KiteError && e.type === 'TokenException' && e.status === 403);
  assert.equal(calls[1].init.headers.Authorization, 'token KEY:AT');
});

test('index_packets_match_the_official_parser', () => {
  // NIFTY 50 is token 256265; its low byte (9) is the indices segment.
  const p = new ArrayBuffer(32);
  const v = new DataView(p);
  v.setUint32(0, 256265);
  v.setUint32(4, 2_461_245); // ₹24,612.45
  v.setUint32(8, 2_470_000);
  v.setUint32(12, 2_440_000);
  v.setUint32(16, 2_450_000);
  v.setUint32(20, 2_445_500); // previous close
  v.setUint32(24, 0);
  v.setUint32(28, 1_791_350_000);
  const buf = frame([p]);
  const official = new KiteTicker({ api_key: 'k', access_token: 't' }).parseBinary(buf)[0];
  const [ours] = parseTicks(buf);
  assert.equal(ours.index, true);
  assert.equal(ours.token, official.instrument_token);
  assert.equal(ours.ltp, Math.round(official.last_price * 100));
  assert.equal(ours.close, Math.round(official.ohlc.close * 100));
  assert.equal(ours.ts, official.exchange_timestamp.getTime());
});

test('paise_to_rupees_is_exact_and_rejects_bad_prices', () => {
  assert.equal(paiseToRupees(12_305), '123.05');
  assert.equal(paiseToRupees(5), '0.05');
  assert.equal(paiseToRupees(10_000), '100.00');
  assert.throws(() => paiseToRupees(-5));
  assert.throws(() => paiseToRupees(1.5));
});

test('order calls send the documented form and read the latest order state', async () => {
  const calls = [];
  const json = (data) => new Response(JSON.stringify({ status: 'success', data }), { headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, form: Object.fromEntries(new URLSearchParams(init.body ?? '')) });
    if (String(url).includes('/orders/regular') && init.method === 'POST') return json({ order_id: '2610070001' });
    if (/\/orders\/2610070001$/.test(String(url))) {
      return json([
        { status: 'OPEN', filled_quantity: 0, average_price: 0 },
        { status: 'COMPLETE', filled_quantity: 65, average_price: 101.35 },
      ]);
    }
    return json({});
  };
  const c = new KiteClient({ apiKey: 'KEY', accessToken: 'AT', fetchImpl: fakeFetch });
  const id = await c.placeOrder({ exchange: 'NFO', symbol: 'NIFTY26OCT24600CE', side: 'BUY', qty: 65, orderType: 'LIMIT', price: 10_140, product: 'MIS', tag: 'arenabot' });
  assert.equal(id, '2610070001');
  assert.deepEqual(calls[0].form, {
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCT24600CE',
    transaction_type: 'BUY',
    quantity: '65',
    product: 'MIS',
    order_type: 'LIMIT',
    validity: 'DAY',
    price: '101.40',
    tag: 'arenabot',
  });
  await c.modifyOrder(id, { qty: 65, orderType: 'SL', price: 7_000, trigger: 7_100 });
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].form.trigger_price, '71.00');
  await c.cancelOrder(id);
  assert.equal(calls[2].method, 'DELETE');
  assert.deepEqual(await c.orderStatus(id), { status: 'COMPLETE', filledQty: 65, avgPrice: 10_135, message: null });
});
