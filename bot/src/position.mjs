// Managing one open long option: stop, breakeven, trailing stop, target and
// time stop, all measured in R (the money at risk per unit at entry).

import { hm, ist } from './time.mjs';

export function openPosition({ market, side, option, qty, entry, stop, openedAt, fees, cfg }) {
  // Breakeven covers the round trip's charges, rounded up to a tick.
  const perUnitFees = Math.ceil(fees / qty / option.tickPaise) * option.tickPaise;
  return { market, side, option, qty, entry, stop, initialStop: stop, risk: entry - stop, peak: entry, openedAt, breakeven: entry + perUnitFees, exits: cfg.exits, squareOff: cfg.session.squareOff };
}

const floorTo = (x, tick) => Math.floor(x / tick) * tick;

/**
 * Looks at the latest best bid. Mutates `p.peak`; returns
 * { exit: reason } | { moveStop: price } | null. The caller applies a stop move.
 */
export function review(p, now, bid) {
  const x = p.exits;
  const R = p.risk;
  if (ist(now).minute >= hm(p.squareOff)) return { exit: 'square-off time' };
  if (bid === null || bid === undefined) return null;
  if (bid <= p.stop) return { exit: 'stop' };
  p.peak = Math.max(p.peak, bid);
  if (bid >= p.entry + x.targetR * R) return { exit: 'target' };
  const minutes = (now - p.openedAt) / 60_000;
  if (minutes >= x.timeStopMinutes && p.peak < p.entry + x.timeStopMinR * R) return { exit: 'time stop' };
  let next = p.stop;
  if (p.peak >= p.entry + x.breakevenAtR * R) next = Math.max(next, p.breakeven);
  if (p.peak >= p.entry + x.trailFromR * R) next = Math.max(next, floorTo(p.peak - x.trailR * R, p.option.tickPaise));
  // The stop only moves up, in steps big enough to be worth an order change.
  // Never at or above the bid: that would fire at once.
  next = Math.min(next, floorTo(bid - p.option.tickPaise, p.option.tickPaise));
  if (next > p.stop && (next - p.stop >= x.minStopMoveR * R || next === p.breakeven)) return { moveStop: next };
  return null;
}
