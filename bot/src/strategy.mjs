// Opening-range breakout, in the direction of the trend, on 5-minute closes
// of the index. Every rule is reported with pass/fail and the numbers behind
// it, so each decision in the log can be checked by hand.
//
// Buy a call (CE) when, on a candle close after the opening range:
//   breakout     close > opening-range high + 0.1 ATR
//   fresh        the previous candle had not already broken out
//   trend        EMA20 > EMA50 and close > EMA20
//   not chasing  close at most 1.5 ATR past the range (entry near the level)
//   calm candle  candle range ≤ 2 ATR (no news spikes)
//   moving       ATR ≥ 0.03% of price (no dead markets)
//   first        no call trade yet today
// Puts (PE) mirror this below the opening-range low.

import { Atr, Ema } from './indicators.mjs';
import { hm } from './time.mjs';

const fmt = (p) => (p / 100).toFixed(2);

export class OrbTrend {
  constructor(signal, session) {
    this.cfg = signal;
    this.orEnd = hm(session.openingRangeEnd);
    this.open = hm(session.open);
    this.fast = new Ema(signal.emaFast);
    this.slow = new Ema(signal.emaSlow);
    this.atr = new Atr(signal.atrPeriod);
    this.day = null;
  }

  startDay(date) {
    this.day = date;
    this.range = { high: -Infinity, low: Infinity, candles: 0 };
    this.prev = null;
    this.taken = new Set();
  }

  /** Feeds a closed candle. Returns { signal: 'CE' | 'PE' | null, checks }. */
  onCandle(c) {
    if (c.date !== this.day) this.startDay(c.date);
    this.fast.update(c.c);
    this.slow.update(c.c);
    this.atr.update(c);
    if (c.minute < this.orEnd) {
      if (c.minute >= this.open) {
        this.range.high = Math.max(this.range.high, c.h);
        this.range.low = Math.min(this.range.low, c.l);
        this.range.candles++;
      }
      this.prev = c;
      return { signal: null, checks: [{ rule: 'opening range', pass: false, detail: 'still forming' }] };
    }
    const result = this.evaluate(c);
    this.prev = c;
    return result;
  }

  evaluate(c) {
    const { cfg, range } = this;
    const atr = this.atr.value;
    const fast = this.fast.value;
    const slow = this.slow.value;
    const checks = [];
    const add = (rule, pass, detail) => checks.push({ rule, pass, detail });

    add('indicators ready', this.fast.ready && this.slow.ready && this.atr.ready, 'needs history for EMA and ATR');
    if (!checks[0].pass) return { signal: null, checks };
    add('opening range', range.candles > 0, range.candles > 0 ? `${fmt(range.low)}–${fmt(range.high)}` : 'missed the opening range');
    if (!checks[1].pass) return { signal: null, checks };

    const buffer = cfg.breakoutAtr * atr;
    const side = c.c > range.high + buffer ? 'CE' : c.c < range.low - buffer ? 'PE' : null;
    add('breakout', side !== null, side ? `${side === 'CE' ? 'above' : 'below'} the range at ${fmt(c.c)}` : `${fmt(c.c)} inside ${fmt(range.low)}–${fmt(range.high)} (± ${fmt(buffer)})`);
    if (!side) return { signal: null, checks };

    const s = side === 'CE' ? 1 : -1;
    const level = side === 'CE' ? range.high : range.low;
    const prevBeyond = this.prev && this.prev.date === c.date && this.prev.minute >= this.orEnd && s * (this.prev.c - level) > buffer;
    add('fresh', !prevBeyond, prevBeyond ? 'previous candle had already broken out' : 'first close beyond the range');
    add('trend', s * (fast - slow) > 0 && s * (c.c - fast) > 0, `EMA${cfg.emaFast} ${fmt(fast)}, EMA${cfg.emaSlow} ${fmt(slow)}`);
    const stretch = s * (c.c - level);
    add('not chasing', stretch <= cfg.maxStretchAtr * atr, `${(stretch / atr).toFixed(2)} ATR past the range (max ${cfg.maxStretchAtr})`);
    add('calm candle', c.h - c.l <= cfg.maxCandleAtr * atr, `range ${((c.h - c.l) / atr).toFixed(2)} ATR (max ${cfg.maxCandleAtr})`);
    const atrPct = (atr / c.c) * 100;
    add('moving', atrPct >= cfg.minAtrPct, `ATR ${atrPct.toFixed(3)}% of price (min ${cfg.minAtrPct}%)`);
    add('first today', !this.taken.has(side), this.taken.has(side) ? `already traded ${side} today` : `no ${side} trade yet`);

    return { signal: checks.every((k) => k.pass) ? side : null, side, checks };
  }

  /** Called when an entry actually fills: one trade per direction per day. */
  markTaken(side) {
    this.taken.add(side);
  }

  /** A long call fails when the index closes back inside the range (mirror for puts). */
  failedBreakout(side, c) {
    if (!this.range || this.range.candles === 0) return false;
    return side === 'CE' ? c.c < this.range.high : c.c > this.range.low;
  }
}
