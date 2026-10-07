// A synthetic trading day: NIFTY spot, India VIX and an option chain priced
// with a simple normal (Bachelier) model, 5-level books included. For the
// demo and the tests: no exchange data is stored in this repository.

const DAY_OPEN = '09:15';
const STRIKE_STEP = 5_000; // ₹50 in paise
const LOT = 65;
const TICK = 5;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
function normCdf(x) {
  // Abramowitz and Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Option value in paise under a normal model; `sd` is the spread of the index at expiry. */
export function optionValue(type, spot, strike, sd) {
  const d = (spot - strike) / sd;
  const call = (spot - strike) * normCdf(d) + sd * normPdf(d);
  return type === 'CE' ? call : call - (spot - strike);
}

/** Spot offset (paise) from the open at `min` minutes after 09:15, for each kind of day. */
const PATHS = {
  // Quiet first 15 minutes, a clean break up around 10:00, a steady climb to midday.
  'trend-up': (min) => (min < 15 ? 0 : min < 120 ? (min - 15) * 250 : 105 * 250 + (min - 120) * 40),
  'trend-down': (min) => -PATHS['trend-up'](min),
  // Breaks up, then falls back through the range.
  fakeout: (min) => (min < 15 ? 0 : min < 25 ? (min - 15) * 400 : min < 60 ? 10 * 400 - (min - 25) * 200 : 10 * 400 - 35 * 200),
  // Never leaves the opening range.
  chop: () => 0,
};

function istMs(date, hhmm) {
  return Date.parse(`${date}T${hhmm}:00+05:30`);
}

/**
 * Records for src/replay.mjs:
 *   { k: 'meta', date, markets: { NIFTY: options } }
 *   { k: 'warm', market, candles }   two earlier days of 5-minute candles
 *   { k: 'tick', at, tick }          index every second, options every 2 s
 */
export function synthDay({ date = '2026-10-07', pattern = 'trend-up', seed = 1, open = 2_460_000, vix = 1_350, expiry = '2026-10-13' } = {}) {
  if (!PATHS[pattern]) throw new Error(`Unknown pattern ${pattern}`);
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const options = [];
  let token = 10_000;
  for (let k = open - 30 * STRIKE_STEP; k <= open + 30 * STRIKE_STEP; k += STRIKE_STEP) {
    for (const type of ['CE', 'PE']) {
      options.push({ token: token++, exchange: 'NFO', symbol: `NIFTY26OCT${k / 100}${type}`, type, strike: k, expiry, lot: LOT, tickPaise: TICK });
    }
  }
  const records = [{ k: 'meta', date, markets: { NIFTY: options } }];

  // Two calm days before, drifting the way today goes, so the averages have history.
  const drift = pattern === 'trend-down' ? -150 : 150;
  const candles = [];
  let px = open - 75 * drift * 2;
  for (const back of [2, 1]) {
    const d = new Date(Date.parse(date) - back * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 75; i++) {
      const o = px;
      const c = o + Math.round((gauss() * 1_000 + drift) / TICK) * TICK;
      const h = Math.max(o, c) + Math.round((rand() * 800) / TICK) * TICK;
      const l = Math.min(o, c) - Math.round((rand() * 800) / TICK) * TICK;
      candles.push({ date: d, minute: 555 + i * 5, o, h, l, c });
      px = c;
    }
  }
  // Shift so the last close sits just under today's open.
  const shift = open - Math.sign(drift) * 3_000 - px;
  records.push({ k: 'warm', market: 'NIFTY', candles: candles.map((c) => ({ ...c, o: c.o + shift, h: c.h + shift, l: c.l + shift, c: c.c + shift })) });

  const start = istMs(date, DAY_OPEN);
  const end = istMs(date, '15:30');
  let noise = 0;
  let spot = open;
  const sdAt = (at) => 30_000 * Math.sqrt(Math.max(0.2, (Date.parse(`${expiry}T15:30:00+05:30`) - at) / (5 * 86_400_000)));
  for (let at = start; at < end; at += 1000) {
    const min = (at - start) / 60_000;
    noise = 0.97 * noise + gauss() * 120;
    spot = Math.round((open + PATHS[pattern](min) + noise) / TICK) * TICK;
    records.push({ k: 'tick', at, tick: { token: 256265, index: true, ltp: spot } });
    if ((at - start) % 60_000 === 0) records.push({ k: 'tick', at, tick: { token: 264969, index: true, ltp: vix } });
    if ((at - start) % 2000 !== 0) continue;
    const sd = sdAt(at);
    for (const o of options) {
      if (Math.abs(o.strike - spot) > 8 * STRIKE_STEP) continue;
      const fair = Math.max(TICK, optionValue(o.type, spot, o.strike, sd));
      const half = Math.max(TICK, Math.round((fair * 0.002) / TICK) * TICK);
      const mid = Math.round(fair / TICK) * TICK;
      const bid = Math.max(TICK, mid - half);
      const ask = bid + 2 * half;
      const level = (i, side) => ({ price: side > 0 ? ask + i * TICK : Math.max(TICK, bid - i * TICK), qty: LOT * (3 + Math.floor(rand() * 8)), orders: 1 + Math.floor(rand() * 6) });
      records.push({
        k: 'tick',
        at,
        tick: { token: o.token, ltp: mid, bids: [0, 1, 2, 3, 4].map((i) => level(i, -1)), asks: [0, 1, 2, 3, 4].map((i) => level(i, 1)) },
      });
    }
  }
  return records;
}
