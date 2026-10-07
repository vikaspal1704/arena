// Paper trading on live quotes. Orders fill against the real 5-level book as
// it stands, never better than the quoted prices, plus a tick of slippage,
// and the stop behaves like an exchange SL-limit order.

export class PaperBroker {
  constructor({ quotes, slippageTicks = 1 }) {
    this.quotes = quotes;
    this.slip = slippageTicks;
    this.stop = null;
    this.stopFill = null;
    this.mode = 'paper';
  }

  /** Buys up to `qty` at prices ≤ `limit`. Returns { filledQty, avgPrice }. */
  async enter({ option, qty, limit }) {
    const q = this.quotes.get(option.token);
    let left = qty;
    let value = 0;
    for (const level of q?.asks ?? []) {
      if (left === 0 || level.price > limit) break;
      const take = Math.min(left, level.qty);
      value += take * Math.min(limit, level.price + this.slip * option.tickPaise);
      left -= take;
    }
    const filledQty = qty - left;
    return { filledQty, avgPrice: filledQty ? Math.round(value / filledQty) : 0 };
  }

  async protect({ option, qty, trigger, limit }) {
    this.stop = { option, qty, trigger, limit };
    this.stopFill = null;
  }

  async moveStop(trigger, limit) {
    if (this.stop) Object.assign(this.stop, { trigger, limit });
  }

  /** Called on every quote: an SL-limit sell triggers at the trigger and fills down to its limit. */
  onQuote(token) {
    const s = this.stop;
    if (!s || s.option.token !== token) return null;
    const q = this.quotes.get(token);
    if (q?.bid === null || q?.bid === undefined || q.bid > s.trigger || q.bid < s.limit) return null;
    const price = Math.max(s.limit, q.bid - this.slip * s.option.tickPaise);
    this.stopFill = { filledQty: s.qty, avgPrice: price };
    this.stop = null;
    return this.stopFill;
  }

  /** The stop's fill, if it has executed and not been collected yet. */
  async checkStop() {
    const f = this.stopFill;
    this.stopFill = null;
    return f;
  }

  /** Sells `qty` now: cancels the stop, then hits the bids. Returns { filledQty, avgPrice }. */
  async exit({ option, qty }) {
    this.stop = null;
    if (this.stopFill) return this.checkStop();
    const q = this.quotes.get(option.token);
    const levels = q?.bids?.length ? q.bids : [{ price: q?.ltp ?? 0, qty }];
    let left = qty;
    let value = 0;
    let last = levels[0].price;
    for (const level of levels) {
      if (left === 0) break;
      const take = Math.min(left, level.qty);
      last = level.price;
      value += take * Math.max(option.tickPaise, level.price - this.slip * option.tickPaise);
      left -= take;
    }
    // Deeper than the visible book: assume the rest goes a few ticks lower.
    if (left > 0) value += left * Math.max(option.tickPaise, last - 5 * option.tickPaise);
    return { filledQty: qty, avgPrice: Math.round(value / qty) };
  }
}
