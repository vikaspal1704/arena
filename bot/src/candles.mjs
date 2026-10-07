// Builds N-minute candles from ticks, aligned to the 09:15 open, in India time.

import { hm, ist } from './time.mjs';

export class CandleBuilder {
  constructor(minutes, { from = '09:15', to = '15:30' } = {}) {
    this.minutes = minutes;
    this.from = hm(from);
    this.to = hm(to);
    this.current = null;
  }

  /** Adds a price at `ms`. Returns the candles this tick closed (zero or one). */
  update(ms, price) {
    const t = ist(ms);
    const closed = this.closeDue(ms);
    if (t.minute < this.from || t.minute >= this.to) return closed;
    const bucket = this.from + Math.floor((t.minute - this.from) / this.minutes) * this.minutes;
    const c = this.current;
    if (!c) this.current = { date: t.date, minute: bucket, o: price, h: price, l: price, c: price };
    else {
      c.h = Math.max(c.h, price);
      c.l = Math.min(c.l, price);
      c.c = price;
    }
    return closed;
  }

  /** Closes the current candle if its time is up, even without a new tick. */
  closeDue(ms) {
    const c = this.current;
    if (!c) return [];
    const t = ist(ms);
    if (t.date === c.date && t.minute < c.minute + this.minutes) return [];
    this.current = null;
    return [c];
  }
}

/** Historical candles ({ at, o, h, l, c }) to the builder's shape. */
export function fromHistorical(rows) {
  return rows.map((r) => {
    const t = ist(r.at);
    return { date: t.date, minute: t.minute, o: r.o, h: r.h, l: r.l, c: r.c };
  });
}
