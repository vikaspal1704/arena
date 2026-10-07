// Every rule the bot follows, in one place. Amounts are rupees here (easy to
// edit) and paise everywhere else. bot/config.json overrides any of these;
// config.example.json lists them with explanations.

import { hm } from './time.mjs';

/** Index spot tokens on the Kite ticker and where their options trade. */
export const MARKETS = Object.freeze({
  NIFTY: { name: 'NIFTY', spotToken: 256265, spotKey: 'NSE:NIFTY 50', exchange: 'NFO', segment: 'NFO-OPT' },
  SENSEX: { name: 'SENSEX', spotToken: 265, spotKey: 'BSE:SENSEX', exchange: 'BFO', segment: 'BFO-OPT' },
});
export const VIX_TOKEN = 264969; // NSE:INDIA VIX

export const DEFAULTS = Object.freeze({
  capital: 10_000,
  underlyings: ['NIFTY', 'SENSEX'],
  candleMinutes: 5,
  session: {
    open: '09:15',
    openingRangeEnd: '09:30',
    firstEntry: '09:30',
    lastEntry: '14:30',
    expiryDayLastEntry: '13:00',
    squareOff: '15:15',
  },
  signal: {
    emaFast: 20,
    emaSlow: 50,
    atrPeriod: 14,
    breakoutAtr: 0.1, // close must clear the opening range by this many ATRs
    maxStretchAtr: 1.5, // ...but not this far past it (chasing)
    maxCandleAtr: 2.0, // skip breakouts on one huge candle (news spikes)
    minAtrPct: 0.03, // skip dead markets: ATR below this % of price
  },
  option: {
    avoidExpiryDay: true, // trade next week's contract on expiry day
    maxOtmSteps: 4, // try ATM first, then up to this many strikes out of the money
    maxLots: 1,
    maxSpreadPct: 1.5,
    minTopQtyLots: 2, // at least this many lots waiting at the best price
    minStopPct: 15, // a stop tighter than this % of premium is noise: skip the strike
    maxStopPct: 30,
    maxQuoteAgeSec: 5,
  },
  risk: {
    riskPerTrade: 800,
    dailyLossCap: 1_200,
    maxTradesPerDay: 2,
    maxConsecutiveLosses: 2,
    cooldownMinutes: 15,
    capitalFloor: 7_000, // stop trading altogether below this equity
    maxVix: 22,
    eventDays: [], // 'YYYY-MM-DD': budget, RBI policy, election results...
  },
  exits: {
    targetR: 2,
    breakevenAtR: 1,
    trailFromR: 1.5,
    trailR: 1,
    minStopMoveR: 0.25, // move the exchange stop only in steps this big
    timeStopMinutes: 30,
    timeStopMinR: 0.5, // ...if the trade hasn't reached this by then
    exitOnFailedBreakout: true,
  },
  orders: {
    product: 'MIS',
    entryBufferTicks: 2,
    entryTimeoutSec: 10,
    exitBufferTicks: 2,
    exitRepriceSec: 3,
    maxExitAttempts: 20,
    stopLimitTicks: 10, // SL-limit price this far below the trigger
    paperSlippageTicks: 1,
    tag: 'arenabot',
  },
  live: {
    enabled: false,
    acknowledge: '', // must equal LIVE_ACKNOWLEDGEMENT
    minPaperDays: 20,
    minPaperTrades: 20,
  },
});

export const LIVE_ACKNOWLEDGEMENT = 'I understand this places real orders and I can lose money';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over, path = '') {
  if (!isObject(over)) throw new Error(`config${path} must be an object`);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) throw new Error(`Unknown setting config${path}.${k}`);
    out[k] = isObject(base[k]) ? merge(base[k], v, `${path}.${k}`) : v;
  }
  return out;
}

/** Defaults overridden by `overrides`, validated. Throws with a readable message. */
export function loadConfig(overrides = {}) {
  const c = merge(DEFAULTS, overrides);
  const fail = (msg) => {
    throw new Error(`Config: ${msg}`);
  };
  const positive = (v, name) => (typeof v === 'number' && v > 0) || fail(`${name} must be a positive number`);
  positive(c.capital, 'capital');
  positive(c.risk.riskPerTrade, 'risk.riskPerTrade');
  positive(c.risk.dailyLossCap, 'risk.dailyLossCap');
  if (c.risk.riskPerTrade > c.capital * 0.1) fail('risk.riskPerTrade may not exceed 10% of capital');
  if (c.risk.dailyLossCap < c.risk.riskPerTrade) fail('risk.dailyLossCap must be at least risk.riskPerTrade');
  if (c.risk.dailyLossCap > c.capital * 0.2) fail('risk.dailyLossCap may not exceed 20% of capital');
  if (!(c.risk.capitalFloor >= 0 && c.risk.capitalFloor < c.capital)) fail('risk.capitalFloor must be below capital');
  if (!Number.isInteger(c.risk.maxTradesPerDay) || c.risk.maxTradesPerDay < 1 || c.risk.maxTradesPerDay > 5) fail('risk.maxTradesPerDay must be 1 to 5');
  if (!Number.isInteger(c.risk.maxConsecutiveLosses) || c.risk.maxConsecutiveLosses < 1) fail('risk.maxConsecutiveLosses must be at least 1');
  if (!Array.isArray(c.risk.eventDays) || !c.risk.eventDays.every((d) => /^\d{4}-\d\d-\d\d$/.test(d))) fail('risk.eventDays must be YYYY-MM-DD dates');
  if (!(c.option.minStopPct > 0 && c.option.minStopPct < c.option.maxStopPct && c.option.maxStopPct <= 50)) fail('need 0 < option.minStopPct < option.maxStopPct ≤ 50');
  if (!Number.isInteger(c.option.maxLots) || c.option.maxLots < 1) fail('option.maxLots must be a whole number ≥ 1');
  if (!(c.exits.targetR >= 1)) fail('exits.targetR must be at least 1');
  if (!Array.isArray(c.underlyings) || c.underlyings.length === 0 || !c.underlyings.every((u) => u in MARKETS)) {
    fail(`underlyings must be a list from ${Object.keys(MARKETS).join(', ')}`);
  }
  if (![1, 3, 5, 15].includes(c.candleMinutes)) fail('candleMinutes must be 1, 3, 5 or 15');
  const s = Object.fromEntries(Object.entries(c.session).map(([k, v]) => [k, hm(v)]));
  if (!(s.open < s.openingRangeEnd && s.openingRangeEnd <= s.firstEntry && s.firstEntry < s.lastEntry && s.lastEntry < s.squareOff && s.squareOff <= hm('15:20'))) {
    fail('session times must run open < openingRangeEnd ≤ firstEntry < lastEntry < squareOff ≤ 15:20');
  }
  if (!['MIS', 'NRML'].includes(c.orders.product)) fail('orders.product must be MIS or NRML');
  return Object.freeze(c);
}

/** Rupees (config) to paise (everything else). */
export const paise = (rupees) => Math.round(rupees * 100);
