import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandleBuilder } from '../src/candles.mjs';
import { candidates, chooseOption, optionsFor, pickExpiry } from '../src/chain.mjs';
import { optionCharges } from '../src/charges.mjs';
import { DEFAULTS, loadConfig } from '../src/config.mjs';
import { Atr, Ema } from '../src/indicators.mjs';
import { openPosition, review } from '../src/position.mjs';
import { QuoteBook } from '../src/quotes.mjs';
import { freshDay, RiskManager } from '../src/risk.mjs';
import { istMs } from '../src/time.mjs';

const D = '2026-10-07';
const at = (hhmm, sec = 0) => istMs(D, hhmm) + sec * 1000;

test('ema is seeded with a simple average, then smooths', () => {
  const e = new Ema(3);
  assert.equal(e.update(1), null);
  assert.equal(e.update(2), null);
  assert.equal(e.update(3), 2);
  assert.equal(e.update(6), 4); // 2 + 0.5 × (6 − 2)
});

test('atr uses true range and Wilder smoothing', () => {
  const a = new Atr(2);
  a.update({ h: 10, l: 8, c: 9 }); // TR 2
  assert.equal(a.update({ h: 12, l: 11, c: 11 }), 2.5); // TR max(1, 3, 2) = 3 → (2 + 3) / 2
  assert.equal(a.update({ h: 11, l: 10, c: 10 }), 1.75); // TR 1 → (2.5 + 1) / 2
});

test('candles align to 09:15, ignore pre-open, and close on time without a tick', () => {
  const b = new CandleBuilder(5);
  assert.deepEqual(b.update(at('09:10'), 100), []); // pre-open
  b.update(at('09:15', 1), 100);
  b.update(at('09:17'), 110);
  b.update(at('09:19', 59), 90);
  const [c] = b.update(at('09:20', 0), 95);
  assert.deepEqual(c, { date: D, minute: 555, o: 100, h: 110, l: 90, c: 90 });
  assert.deepEqual(b.closeDue(at('09:24', 59)), []);
  assert.equal(b.closeDue(at('09:25')).at(0).c, 95);
});

test('config: defaults are valid; unsafe or unknown settings are refused', () => {
  assert.equal(loadConfig().capital, DEFAULTS.capital);
  assert.throws(() => loadConfig({ risk: { riskPerTrade: 1_500 } }), /10% of capital/);
  assert.throws(() => loadConfig({ risk: { dailyLossCap: 5_000 } }), /20% of capital/);
  assert.throws(() => loadConfig({ risk: { stopLoss: 1 } }), /Unknown setting config.risk.stopLoss/);
  assert.throws(() => loadConfig({ session: { squareOff: '15:29' } }), /session times/);
  assert.throws(() => loadConfig({ underlyings: ['BANKNIFTY'] }), /underlyings/);
  assert.equal(loadConfig({ capital: 50_000, risk: { riskPerTrade: 1_000, dailyLossCap: 2_000, capitalFloor: 40_000 } }).risk.riskPerTrade, 1_000);
});

test('option charges match a hand calculation (NFO, 2026 rates)', () => {
  // Buy 65 @ ₹61.75, sell 65 @ ₹84.60.
  const c = optionCharges({ exchange: 'NFO', buyValue: 401_375, sellValue: 549_900, orders: 2 });
  assert.deepEqual(c, { brokerage: 4000, stt: 825, exchange: 333, sebi: 1, stamp: 12, gst: 780, total: 5951 });
  assert.equal(optionCharges({ exchange: 'BFO', buyValue: 1_000_000, sellValue: 0, orders: 1 }).exchange, 325);
});

const ROWS = [];
for (const expiry of ['2026-10-07', '2026-10-13']) {
  for (let k = 24_400; k <= 24_800; k += 50) {
    for (const t of ['CE', 'PE']) {
      ROWS.push({ instrument_token: String(ROWS.length + 1), exchange: 'NFO', tradingsymbol: `N${expiry.slice(8)}${k}${t}`, name: 'NIFTY', strike: String(k), expiry, lot_size: '65', tick_size: '0.05', instrument_type: t, segment: 'NFO-OPT' });
    }
  }
}
ROWS.push({ ...ROWS[0], name: 'BANKNIFTY', instrument_token: '999' });
const OPTS = optionsFor(ROWS, { name: 'NIFTY', segment: 'NFO-OPT' });

test('chain: expiry choice skips expiry day when asked', () => {
  assert.equal(OPTS.length, 36);
  assert.equal(pickExpiry(OPTS, D, false), '2026-10-07');
  assert.equal(pickExpiry(OPTS, D, true), '2026-10-13');
  assert.equal(pickExpiry(OPTS, '2026-10-14', true), null);
});

test('chain: candidates run ATM first, then out of the money', () => {
  const ce = candidates(OPTS, { expiry: '2026-10-13', type: 'CE', spot: 2_461_000, maxOtmSteps: 2 }).map((o) => o.strike / 100);
  const pe = candidates(OPTS, { expiry: '2026-10-13', type: 'PE', spot: 2_461_000, maxOtmSteps: 2 }).map((o) => o.strike / 100);
  assert.deepEqual(ce, [24_600, 24_650, 24_700]);
  assert.deepEqual(pe, [24_600, 24_550, 24_500]);
});

function book(quotes, o, { bid, ask, qty = 650, t = 0 }) {
  quotes.update({ token: o.token, ltp: bid, bids: [{ price: bid, qty, orders: 3 }], asks: [{ price: ask, qty, orders: 3 }] }, t);
}

test('chain: picks the first contract that is liquid and fits risk and money, and says why others failed', () => {
  const cfg = loadConfig().option;
  const cands = candidates(OPTS, { expiry: '2026-10-13', type: 'CE', spot: 2_460_000, maxOtmSteps: 4 });
  const q = new QuoteBook();
  book(q, cands[0], { bid: 14_000, ask: 14_020 }); // ATM ₹140: a 15% stop would risk too much
  book(q, cands[1], { bid: 10_000, ask: 10_400 }); // spread 3.8%
  book(q, cands[2], { bid: 8_000, ask: 8_010, qty: 65 }); // only one lot offered
  // cands[3] has no quote
  book(q, cands[4], { bid: 6_000, ask: 6_010 });
  const { choice, reasons } = chooseOption(cands, q, 1000, { riskPaise: 80_000, budgetPaise: 1_000_000, option: cfg });
  assert.match(reasons[0].why, /stop of only/);
  assert.match(reasons[1].why, /spread/);
  assert.match(reasons[2].why, /only 65 offered/);
  assert.match(reasons[3].why, /no fresh quote/);
  assert.equal(choice.option, cands[4]);
  assert.equal(choice.qty, 65);
  // ₹800 less charges over 65 units allows ₹11.40 (19%), inside the 15–30% band.
  assert.equal(choice.stopDistance, 1_140);
  assert.ok(choice.risk <= 80_000);
  // Stale quotes are refused.
  assert.equal(chooseOption(cands, q, 60_000, { riskPaise: 80_000, budgetPaise: 1_000_000, option: cfg }).choice, null);
  // Not enough money.
  assert.match(chooseOption([cands[4]], q, 1000, { riskPaise: 80_000, budgetPaise: 300_000, option: cfg }).reasons[0].why, /more than/);
});

test('risk: each gate blocks with a reason', () => {
  const cfg = loadConfig({ risk: { eventDays: ['2026-10-08'] } });
  const day = freshDay(D);
  const r = new RiskManager(cfg, day);
  const ok = (t, ctx = {}) => r.canEnter(t, { vix: 1_400, ...ctx });
  const failed = (res) => res.checks.filter((c) => !c.pass).map((c) => c.rule);
  assert.equal(ok(at('10:00')).ok, true);
  assert.deepEqual(failed(ok(at('09:20'))), ['entry window']);
  assert.deepEqual(failed(ok(at('14:30'))), ['entry window']);
  assert.deepEqual(failed(ok(at('13:05'), { expiryIsToday: true })), ['expiry-day cutoff']);
  assert.deepEqual(failed(ok(at('10:00'), { vix: 2_500 })), ['volatility']);
  assert.deepEqual(failed(ok(at('10:00'), { vix: null })), ['volatility']);
  assert.deepEqual(failed(ok(at('10:00'), { killSwitch: true })), ['kill switch']);
  assert.deepEqual(failed(r.canEnter(istMs('2026-10-08', '10:00'), { vix: 1_400 })), ['not an event day']);

  r.onClose({ net: -50_000 }, at('10:00'));
  assert.deepEqual(failed(ok(at('10:10'))), ['cooldown after a loss']);
  assert.equal(ok(at('10:15')).ok, true);
  assert.equal(r.riskBudget(), 70_000); // ₹1,200 cap − ₹500 lost
  r.onClose({ net: -30_000 }, at('10:30'));
  assert.equal(day.halted, '2 losses in a row');
  assert.ok(failed(ok(at('11:00'))).includes('not halted'));
});

test('risk: the daily loss cap halts, and the capital floor stops trading', () => {
  const cfg = loadConfig();
  const day = freshDay(D);
  const r = new RiskManager(cfg, day);
  r.onClose({ net: -125_000 }, at('10:00'));
  assert.equal(day.halted, 'daily loss cap reached');
  const poor = new RiskManager(cfg, freshDay(D), { equity: 690_000 });
  assert.ok(poor.canEnter(at('10:00'), { vix: 1_400 }).checks.find((c) => c.rule === 'capital floor').pass === false);
});

function pos(overrides = {}) {
  const cfg = loadConfig();
  return openPosition({ market: 'NIFTY', side: 'CE', option: { token: 1, tickPaise: 5, symbol: 'X' }, qty: 65, entry: 6_000, stop: 4_800, openedAt: at('10:00'), fees: 6_000, cfg, ...overrides });
}

test('position: breakeven at 1R, trailing from 1.5R, target at 2R', () => {
  const p = pos(); // R = ₹12; breakeven = entry + ₹0.95 of charges per unit (rounded up to a tick)
  assert.equal(p.breakeven, 6_095);
  assert.equal(review(p, at('10:01'), 6_500), null);
  assert.deepEqual(review(p, at('10:02'), 7_200), { moveStop: 6_095 });
  p.stop = 6_095;
  assert.deepEqual(review(p, at('10:03'), 7_900), { moveStop: 6_700 }); // peak 79 − 1R
  p.stop = 6_700;
  assert.equal(review(p, at('10:04'), 7_000), null); // never moves down
  assert.deepEqual(review(p, at('10:05'), 8_400), { exit: 'target' });
});

test('position: stop, time stop and square-off', () => {
  assert.deepEqual(review(pos(), at('10:01'), 4_800), { exit: 'stop' });
  assert.deepEqual(review(pos(), at('10:30'), 6_100), { exit: 'time stop' });
  assert.equal(review(pos(), at('10:29'), 6_100), null);
  const runner = pos();
  review(runner, at('10:10'), 6_700); // reached 0.58R: no time stop later
  assert.equal(review(runner, at('10:40'), 6_100), null);
  assert.deepEqual(review(pos(), at('15:15'), 7_000), { exit: 'square-off time' });
});
