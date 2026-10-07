// Real orders through Kite Connect. Only reachable through `run.mjs --live`
// after its gates pass (see docs/TRADING_BOT.md). Limit orders only, a real
// SL-limit order at the exchange from the moment a position exists, and
// every exit cancels that stop first so the bot can never sell twice.

const DONE = new Set(['COMPLETE', 'REJECTED', 'CANCELLED']);

export class ManualActionNeeded extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManualActionNeeded';
  }
}

export class KiteBroker {
  constructor({ client, quotes, orders, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
    Object.assign(this, { client, quotes, cfg: orders, log, sleep, now });
    this.stop = null;
    this.mode = 'live';
  }

  place(option, side, qty, orderType, price, trigger) {
    return this.client.placeOrder({ exchange: option.exchange, symbol: option.symbol, side, qty, orderType, price, trigger, product: this.cfg.product, tag: this.cfg.tag });
  }

  /** Polls until the order is finished or `ms` pass. */
  async waitDone(id, ms) {
    const end = this.now() + ms;
    for (;;) {
      const st = await this.client.orderStatus(id);
      if (DONE.has(st.status) || this.now() >= end) return st;
      await this.sleep(500);
    }
  }

  /** Cancels (ignoring "already done" errors) and returns the final state. */
  async cancelAndSettle(id) {
    await this.client.cancelOrder(id).catch((err) => this.log('cancel', { id, error: err.message }));
    const st = await this.waitDone(id, 10_000);
    if (!DONE.has(st.status)) throw new ManualActionNeeded(`Order ${id} is still ${st.status} after cancelling. Check Kite now.`);
    return st;
  }

  async enter({ option, qty, limit }) {
    const id = await this.place(option, 'BUY', qty, 'LIMIT', limit);
    this.log('order', { id, side: 'BUY', symbol: option.symbol, qty, limit });
    let st = await this.waitDone(id, this.cfg.entryTimeoutSec * 1000);
    if (!DONE.has(st.status)) st = await this.cancelAndSettle(id);
    if (st.status === 'REJECTED') this.log('rejected', { id, message: st.message });
    return { filledQty: st.filledQty, avgPrice: st.avgPrice };
  }

  async protect({ option, qty, trigger, limit }) {
    const id = await this.place(option, 'SELL', qty, 'SL', limit, trigger);
    this.stop = { id, option, qty, trigger, limit };
    this.log('order', { id, side: 'SELL', type: 'SL', symbol: option.symbol, qty, trigger, limit });
    const st = await this.client.orderStatus(id);
    if (st.status === 'REJECTED') {
      this.stop = null;
      throw new ManualActionNeeded(`The exchange stop for ${option.symbol} was rejected (${st.message}). The bot will exit the position.`);
    }
  }

  async moveStop(trigger, limit) {
    const s = this.stop;
    if (!s) return;
    await this.client.modifyOrder(s.id, { qty: s.qty, orderType: 'SL', price: limit, trigger });
    Object.assign(s, { trigger, limit });
  }

  /** The stop's fill if it executed at the exchange. */
  async checkStop() {
    const s = this.stop;
    if (!s) return null;
    const st = await this.client.orderStatus(s.id);
    if (st.status === 'COMPLETE') {
      this.stop = null;
      return { filledQty: st.filledQty, avgPrice: st.avgPrice };
    }
    if (st.status === 'CANCELLED' || st.status === 'REJECTED') {
      this.stop = null;
      throw new ManualActionNeeded(`The exchange stop ${s.id} was ${st.status.toLowerCase()} outside the bot. Check Kite now.`);
    }
    return null;
  }

  /** Sells `qty`, repricing down to the bid until filled. Returns { filledQty, avgPrice }. */
  async exit({ option, qty }) {
    let left = qty;
    let value = 0;
    if (this.stop) {
      const st = await this.cancelAndSettle(this.stop.id);
      this.stop = null;
      left -= st.filledQty;
      value += st.filledQty * st.avgPrice;
    }
    // The working sell order, and how much of it is already counted above.
    let id = null;
    let orderQty = 0;
    let counted = 0;
    let countedValue = 0;
    for (let attempt = 0; left > 0; attempt++) {
      if (attempt >= this.cfg.maxExitAttempts) throw new ManualActionNeeded(`Could not sell ${left} ${option.symbol} after ${attempt} tries. Close it in Kite now.`);
      const q = this.quotes.get(option.token);
      const ref = q?.bid ?? q?.ltp;
      if (!ref) {
        await this.sleep(1000);
        continue;
      }
      // Each try reaches two ticks further below the bid.
      const price = Math.max(option.tickPaise, ref - (this.cfg.exitBufferTicks + 2 * attempt) * option.tickPaise);
      if (id === null) {
        id = await this.place(option, 'SELL', left, 'LIMIT', price);
        orderQty = left;
        counted = 0;
        countedValue = 0;
      } else {
        await this.client.modifyOrder(id, { qty: orderQty, orderType: 'LIMIT', price }).catch((err) => this.log('modify', { id, error: err.message }));
      }
      this.log('order', { id, side: 'SELL', symbol: option.symbol, qty: left, price, attempt });
      const st = await this.waitDone(id, this.cfg.exitRepriceSec * 1000);
      // Kite reports the order's cumulative fill and average price.
      left -= st.filledQty - counted;
      value += st.filledQty * st.avgPrice - countedValue;
      counted = st.filledQty;
      countedValue = st.filledQty * st.avgPrice;
      if (st.status === 'REJECTED') this.log('rejected', { id, message: st.message });
      if (DONE.has(st.status)) id = null;
    }
    return { filledQty: qty, avgPrice: Math.round(value / qty) };
  }
}
