import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KiteBroker, ManualActionNeeded } from '../src/brokers/kite.mjs';
import { PaperBroker } from '../src/brokers/paper.mjs';
import { loadConfig } from '../src/config.mjs';
import { QuoteBook } from '../src/quotes.mjs';

const OPT = { token: 7, exchange: 'NFO', symbol: 'NIFTY26OCT24800CE', tickPaise: 5, lot: 65 };
const lv = (price, qty) => ({ price, qty, orders: 1 });

function quotes(bids, asks) {
  const q = new QuoteBook();
  q.update({ token: 7, ltp: bids[0]?.price ?? 0, bids, asks }, 0);
  return q;
}

test('paper: buys walk the offers up to the limit, never better than quoted', async () => {
  const q = quotes([lv(6_000, 65)], [lv(6_010, 65), lv(6_015, 65), lv(6_030, 650)]);
  const b = new PaperBroker({ quotes: q, slippageTicks: 1 });
  // 130 fills on the first two levels (+1 tick slippage each); the third is above the limit.
  assert.deepEqual(await b.enter({ option: OPT, qty: 195, limit: 6_020 }), { filledQty: 130, avgPrice: 6_018 });
  assert.deepEqual(await b.enter({ option: OPT, qty: 65, limit: 6_000 }), { filledQty: 0, avgPrice: 0 });
});

test('paper: the stop acts like an SL-limit order, including gaps through the limit', async () => {
  const q = quotes([lv(6_000, 650)], [lv(6_010, 650)]);
  const b = new PaperBroker({ quotes: q, slippageTicks: 1 });
  await b.protect({ option: OPT, qty: 65, trigger: 5_000, limit: 4_950 });
  assert.equal(b.onQuote(7), null);
  q.update({ token: 7, bids: [lv(4_900, 650)], asks: [lv(4_920, 650)] }, 1);
  assert.equal(b.onQuote(7), null, 'gapped below the limit: still open, like the exchange');
  q.update({ token: 7, bids: [lv(4_990, 650)], asks: [lv(5_000, 650)] }, 2);
  assert.deepEqual(b.onQuote(7), { filledQty: 65, avgPrice: 4_985 });
  assert.deepEqual(await b.checkStop(), { filledQty: 65, avgPrice: 4_985 });
  assert.equal(await b.checkStop(), null);
});

test('paper: exits sell into the bids', async () => {
  const q = quotes([lv(6_000, 65), lv(5_990, 650)], [lv(6_010, 650)]);
  const b = new PaperBroker({ quotes: q, slippageTicks: 0 });
  assert.deepEqual(await b.exit({ option: OPT, qty: 130 }), { filledQty: 130, avgPrice: 5_995 });
});

/** A pretend Kite order book: scripted states per order, and a log of calls. */
function fakeKite(script) {
  const calls = [];
  const orders = new Map();
  let n = 0;
  return {
    calls,
    async placeOrder(o) {
      const id = `O${++n}`;
      calls.push(['place', id, o]);
      orders.set(id, [...(script[id] ?? [{ status: 'OPEN', filledQty: 0, avgPrice: 0 }])]);
      return id;
    },
    async modifyOrder(id, o) {
      calls.push(['modify', id, o]);
    },
    async cancelOrder(id) {
      calls.push(['cancel', id]);
      const s = orders.get(id);
      const last = s.at(-1);
      if (last.status !== 'COMPLETE') s.push({ ...last, status: 'CANCELLED' });
    },
    async orderStatus(id) {
      const s = orders.get(id);
      return s.length > 1 ? s.shift() : s[0];
    },
  };
}

function live(client, q = quotes([lv(6_000, 650)], [lv(6_010, 650)])) {
  let t = 0;
  return new KiteBroker({ client, quotes: q, orders: loadConfig().orders, sleep: async (ms) => void (t += ms), now: () => t });
}

test('live: an entry that is not filled in time is cancelled; a partial fill is kept', async () => {
  const client = fakeKite({ O1: [{ status: 'OPEN', filledQty: 0, avgPrice: 0 }, { status: 'OPEN', filledQty: 0, avgPrice: 0 }, { status: 'OPEN', filledQty: 65, avgPrice: 6_010 }] });
  const b = live(client);
  const fill = await b.enter({ option: OPT, qty: 130, limit: 6_020 });
  assert.deepEqual(fill, { filledQty: 65, avgPrice: 6_010 });
  assert.equal(client.calls[0][2].orderType, 'LIMIT');
  assert.equal(client.calls[0][2].product, 'MIS');
  assert.deepEqual(client.calls.at(-1), ['cancel', 'O1']);
});

test('live: exiting cancels the exchange stop first and never sells more than held', async () => {
  // The stop (O1) had filled 25 of 65 by the time it was cancelled.
  const client = fakeKite({
    O1: [{ status: 'TRIGGER PENDING', filledQty: 0, avgPrice: 0 }, { status: 'OPEN', filledQty: 25, avgPrice: 5_000 }],
    O2: [{ status: 'COMPLETE', filledQty: 40, avgPrice: 5_990 }],
  });
  const b = live(client);
  await b.protect({ option: OPT, qty: 65, trigger: 5_000, limit: 4_950 });
  const fill = await b.exit({ option: OPT, qty: 65 });
  const sells = client.calls.filter((c) => c[0] === 'place' && c[2].side === 'SELL');
  assert.deepEqual(sells.map((c) => [c[2].orderType, c[2].qty]), [['SL', 65], ['LIMIT', 40]]);
  assert.ok(client.calls.findIndex((c) => c[0] === 'cancel' && c[1] === 'O1') < client.calls.findIndex((c) => c[1] === 'O2'));
  assert.deepEqual(fill, { filledQty: 65, avgPrice: Math.round((25 * 5_000 + 40 * 5_990) / 65) });
});

test('live: an unfilled exit is repriced lower each time, then handed to you', async () => {
  const client = fakeKite({});
  const b = live(client);
  await assert.rejects(b.exit({ option: OPT, qty: 65 }), ManualActionNeeded);
  const prices = client.calls.filter((c) => c[0] === 'modify').map((c) => c[2].price);
  assert.equal(prices.length, loadConfig().orders.maxExitAttempts - 1);
  assert.ok(prices.every((p, i) => i === 0 || p < prices[i - 1]));
});

test('live: a stop that fills at the exchange is reported; one cancelled outside the bot is an alert', async () => {
  const done = fakeKite({ O1: [{ status: 'TRIGGER PENDING', filledQty: 0, avgPrice: 0 }, { status: 'COMPLETE', filledQty: 65, avgPrice: 4_990 }] });
  const b = live(done);
  await b.protect({ option: OPT, qty: 65, trigger: 5_000, limit: 4_950 });
  assert.deepEqual(await b.checkStop(), { filledQty: 65, avgPrice: 4_990 });

  const gone = fakeKite({ O1: [{ status: 'TRIGGER PENDING', filledQty: 0, avgPrice: 0 }, { status: 'CANCELLED', filledQty: 0, avgPrice: 0 }] });
  const b2 = live(gone);
  await b2.protect({ option: OPT, qty: 65, trigger: 5_000, limit: 4_950 });
  await assert.rejects(b2.checkStop(), ManualActionNeeded);
});

test('live: a rejected exchange stop is an alert', async () => {
  const client = fakeKite({ O1: [{ status: 'REJECTED', filledQty: 0, avgPrice: 0, message: 'Insufficient funds' }] });
  await assert.rejects(live(client).protect({ option: OPT, qty: 65, trigger: 5_000, limit: 4_950 }), /rejected/);
});
