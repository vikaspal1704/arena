// Indicators used by the strategy. Each is seeded with a simple average, so a
// value appears only after `period` inputs: no guessing on thin history.

export class Ema {
  constructor(period) {
    this.period = period;
    this.k = 2 / (period + 1);
    this.value = null;
    this.seed = [];
  }

  update(x) {
    if (this.value === null) {
      this.seed.push(x);
      if (this.seed.length === this.period) this.value = this.seed.reduce((a, b) => a + b, 0) / this.period;
    } else {
      this.value += this.k * (x - this.value);
    }
    return this.value;
  }

  get ready() {
    return this.value !== null;
  }
}

/** Average true range, Wilder's smoothing. Takes candles { h, l, c }. */
export class Atr {
  constructor(period) {
    this.period = period;
    this.value = null;
    this.prevClose = null;
    this.seed = [];
  }

  update({ h, l, c }) {
    const tr = this.prevClose === null ? h - l : Math.max(h - l, Math.abs(h - this.prevClose), Math.abs(l - this.prevClose));
    this.prevClose = c;
    if (this.value === null) {
      this.seed.push(tr);
      if (this.seed.length === this.period) this.value = this.seed.reduce((a, b) => a + b, 0) / this.period;
    } else {
      this.value = (this.value * (this.period - 1) + tr) / this.period;
    }
    return this.value;
  }

  get ready() {
    return this.value !== null;
  }
}
