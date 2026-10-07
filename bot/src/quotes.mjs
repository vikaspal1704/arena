// The latest quote per option contract, from full-mode ticks.

export class QuoteBook {
  constructor() {
    this.map = new Map();
  }

  update(tick, at) {
    const bids = tick.bids ?? [];
    const asks = tick.asks ?? [];
    this.map.set(tick.token, {
      at,
      ltp: tick.ltp,
      bid: bids[0]?.price ?? null,
      bidQty: bids[0]?.qty ?? 0,
      ask: asks[0]?.price ?? null,
      askQty: asks[0]?.qty ?? 0,
      bids,
      asks,
    });
  }

  get(token) {
    return this.map.get(token) ?? null;
  }
}
