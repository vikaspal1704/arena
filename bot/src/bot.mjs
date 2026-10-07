// The trading loop. Index ticks build 5-minute candles; a closed candle can
// produce a signal; the risk manager and option selection decide whether and
// what to buy; the broker fills it; every option quote then reviews the stop,
// target and time limits. Every decision is written to the journal.
//
// Time comes from `now()`, so a recorded day replays exactly (src/replay.mjs).

import { ManualActionNeeded } from './brokers/kite.mjs';
import { CandleBuilder } from './candles.mjs';
import { band, candidates, chooseOption, pickExpiry } from './chain.mjs';
import { optionCharges, roundTripCharges } from './charges.mjs';
import { MARKETS, paise, VIX_TOKEN } from './config.mjs';
import { openPosition, review } from './position.mjs';
import { freshDay, RiskManager } from './risk.mjs';
import { OrbTrend } from './strategy.mjs';
import { clock, ist } from './time.mjs';

const BAND_WIDTH = 4; // strikes either side of the money to stream
const STOP_POLL_MS = 2000;

const floorTo = (x, tick) => Math.floor(x / tick) * tick;

export class TradingBot {
  /**
   * markets: { NIFTY: [options...], SENSEX: [...] } from chain.optionsFor
   * broker: PaperBroker | KiteBroker; quotes: QuoteBook shared with the broker
   * store: FileStore | MemoryStore; journal: Journal
   * subscribe(tokens): keeps the ticker on exactly these tokens
   */
  constructor({ config, markets, broker, quotes, store, journal, now = Date.now, killSwitch = () => false, subscribe = () => {} }) {
    Object.assign(this, { cfg: config, broker, quotes, store, journal, now, killSwitch, subscribe });
    this.date = ist(now()).date;
    this.day = store.loadDay(this.date) ?? freshDay(this.date);
    this.risk = new RiskManager(config, this.day, { equity: paise(config.capital) + store.realizedBefore(this.date) });
    this.vix = null;
    this.busy = false;
    this.lastStopPoll = 0;
    this.markets = new Map();
    this.bySpot = new Map();
    for (const name of config.underlyings) {
      const def = MARKETS[name];
      const options = markets[name] ?? [];
      const m = {
        ...def,
        options,
        expiry: pickExpiry(options, this.date, config.option.avoidExpiryDay),
        candles: new CandleBuilder(config.candleMinutes, { from: config.session.open }),
        strategy: new OrbTrend(config.signal, config.session),
        spot: null,
        bandKey: '',
        band: [],
      };
      this.markets.set(name, m);
      this.bySpot.set(def.spotToken, m);
    }
  }

  log(type, data) {
    return this.journal.write(this.now(), type, data);
  }

  save() {
    this.store.saveDay(this.day);
  }

  /** Earlier candles (previous days and today so far) to seed the indicators and the opening range. */
  warm(name, candles) {
    const m = this.markets.get(name);
    for (const c of candles) m.strategy.onCandle(c);
    // Directions already traded today stay used after a restart.
    for (const t of this.day.trades) if (t.market === name) m.strategy.markTaken(t.side);
    if (this.day.open?.market === name) m.strategy.markTaken(this.day.open.side);
    this.log('warm', { market: name, candles: candles.length, expiry: m.expiry, ready: m.strategy.slow.ready && m.strategy.atr.ready });
    if (!m.expiry) this.log('alert', { message: `No ${name} options found in the instrument list: ${name} will not trade today.` });
  }

  /** After a restart with a position open. Paper re-arms its stop; live hands over to you. */
  async resume() {
    const p = this.day.open;
    if (!p) return;
    if (this.broker.mode === 'live') {
      this.risk.halt('restarted with a live position open');
      this.log('alert', { message: `Restarted while holding ${p.qty} ${p.option.symbol}. Its exchange stop is still at Kite; manage or close it there. The bot will not trade today.` });
      this.save();
      return;
    }
    await this.broker.protect({ option: p.option, qty: p.qty, trigger: p.stop, limit: this.stopLimit(p.option, p.stop) });
    this.log('resume', { symbol: p.option.symbol, qty: p.qty, stop: p.stop });
  }

  tokens() {
    const out = new Set([VIX_TOKEN]);
    for (const m of this.markets.values()) {
      out.add(m.spotToken);
      for (const o of m.band) out.add(o.token);
    }
    if (this.day.open) out.add(this.day.open.option.token);
    return [...out];
  }

  recenter(m) {
    if (!m.expiry || m.spot === null) return;
    const b = band(m.options, { expiry: m.expiry, spot: m.spot, width: BAND_WIDTH });
    const key = b.map((o) => o.token).join(',');
    if (key === m.bandKey) return;
    m.bandKey = key;
    m.band = b;
    this.subscribe(this.tokens());
  }

  async onTick(tick) {
    const now = this.now();
    if (tick.token === VIX_TOKEN) {
      this.vix = tick.ltp;
      return;
    }
    const m = this.bySpot.get(tick.token);
    if (m) {
      m.spot = tick.ltp;
      this.recenter(m);
      for (const c of m.candles.update(now, tick.ltp)) await this.onCandle(m, c);
      return;
    }
    this.quotes.update(tick, now);
    this.broker.onQuote?.(tick.token);
    if (this.day.open?.option.token === tick.token) await this.manage(now, this.broker.mode === 'paper');
  }

  /** Once a second: close candles without waiting for a tick, time exits, kill switch, stop polling. */
  async onTimer() {
    const now = this.now();
    for (const m of this.markets.values()) for (const c of m.candles.closeDue(now)) await this.onCandle(m, c);
    if (this.killSwitch()) {
      if (this.day.halted !== 'kill switch') {
        this.risk.halt('kill switch');
        this.log('halt', { reason: 'kill switch (STOP file)', previously: this.day.halted ?? undefined });
        this.save();
      }
      // Retried every second until flat.
      if (this.day.open) await this.act(() => this.exit('kill switch'));
    }
    const poll = now - this.lastStopPoll >= STOP_POLL_MS;
    if (poll) this.lastStopPoll = now;
    if (this.day.open) await this.manage(now, poll);
  }

  async onCandle(m, c) {
    const res = m.strategy.onCandle(c);
    const failed = res.checks.filter((k) => !k.pass);
    this.log('candle', {
      market: m.name,
      time: clock(c.minute),
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      signal: res.signal,
      blocked: res.signal ? undefined : failed.map((k) => `${k.rule}: ${k.detail}`),
    });
    const p = this.day.open;
    if (p && p.market === m.name && this.cfg.exits.exitOnFailedBreakout && m.strategy.failedBreakout(p.side, c)) {
      await this.act(() => this.exit('index back inside the opening range'));
    } else if (res.signal) {
      await this.act(() => this.tryEnter(m, res.signal, res.checks));
    }
  }

  /** Runs one order action at a time; an error halts trading for the day. */
  async act(fn) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } catch (err) {
      this.risk.halt(err instanceof ManualActionNeeded ? 'manual action needed' : 'unexpected error');
      this.log('alert', { message: err.message });
      this.save();
    } finally {
      this.busy = false;
    }
  }

  stopLimit(option, trigger) {
    return Math.max(option.tickPaise, trigger - this.cfg.orders.stopLimitTicks * option.tickPaise);
  }

  async tryEnter(m, side, signalChecks) {
    const now = this.now();
    const gate = this.risk.canEnter(now, { expiryIsToday: m.expiry === this.date, vix: this.vix, killSwitch: this.killSwitch() });
    if (!gate.ok) {
      this.log('skip', { market: m.name, side, why: gate.checks.filter((k) => !k.pass).map((k) => `${k.rule}: ${k.detail}`) });
      return;
    }
    const cands = candidates(m.options, { expiry: m.expiry, type: side, spot: m.spot, maxOtmSteps: this.cfg.option.maxOtmSteps });
    const { choice, reasons } = chooseOption(cands, this.quotes, now, { riskPaise: this.risk.riskBudget(), budgetPaise: this.risk.spendBudget(), option: this.cfg.option });
    if (!choice) {
      this.log('skip', { market: m.name, side, why: reasons.map((r) => `${r.symbol}: ${r.why}`) });
      return;
    }
    const { option } = choice;
    const limit = choice.ask + this.cfg.orders.entryBufferTicks * option.tickPaise;
    const fill = await this.broker.enter({ option, qty: choice.qty, limit });
    if (fill.filledQty === 0) {
      this.log('missed', { market: m.name, side, symbol: option.symbol, limit, why: 'not filled at the limit price' });
      return;
    }
    m.strategy.markTaken(side);
    const entry = fill.avgPrice;
    const stop = Math.max(option.tickPaise, floorTo(entry - choice.stopDistance, option.tickPaise));
    const fees = roundTripCharges(option.exchange, fill.filledQty, entry);
    const p = openPosition({ market: m.name, side, option, qty: fill.filledQty, entry, stop, openedAt: now, fees, cfg: this.cfg });
    this.risk.onOpen(p);
    this.save();
    this.subscribe(this.tokens());
    this.log('entry', {
      market: m.name,
      side,
      symbol: option.symbol,
      qty: p.qty,
      price: entry,
      stop,
      target: entry + this.cfg.exits.targetR * p.risk,
      risk: p.risk * p.qty + fees,
      spot: m.spot,
      vix: this.vix,
      why: signalChecks.map((k) => `${k.rule}: ${k.detail}`),
      chain: reasons.map((r) => `${r.symbol}: ${r.why}`),
    });
    try {
      await this.broker.protect({ option, qty: p.qty, trigger: stop, limit: this.stopLimit(option, stop) });
    } catch (err) {
      this.log('alert', { message: err.message });
      await this.exit('could not place the exchange stop');
      throw err;
    }
  }

  async manage(now, pollStop) {
    const p = this.day.open;
    if (!p || this.busy) return;
    await this.act(async () => {
      if (pollStop) {
        const filled = await this.broker.checkStop();
        if (filled) return this.close(filled, p.stop > p.initialStop ? 'trailing stop' : 'stop');
      }
      const q = this.quotes.get(p.option.token);
      const action = review(p, now, q?.bid);
      if (action?.exit) return this.exit(action.exit);
      if (action?.moveStop) {
        await this.broker.moveStop(action.moveStop, this.stopLimit(p.option, action.moveStop));
        const from = p.stop;
        p.stop = action.moveStop;
        this.save();
        this.log('stop moved', { symbol: p.option.symbol, from, to: p.stop, why: p.stop >= p.breakeven && from < p.breakeven ? 'breakeven' : 'trailing' });
      }
    });
  }

  async exit(reason) {
    const p = this.day.open;
    if (!p) return;
    const fill = await this.broker.exit({ option: p.option, qty: p.qty });
    this.close(fill, reason);
  }

  close(fill, reason) {
    const p = this.day.open;
    const now = this.now();
    const fees = optionCharges({ exchange: p.option.exchange, buyValue: p.entry * p.qty, sellValue: fill.avgPrice * p.qty, orders: 2 }).total;
    const gross = (fill.avgPrice - p.entry) * p.qty;
    const trade = {
      market: p.market,
      side: p.side,
      symbol: p.option.symbol,
      qty: p.qty,
      entry: p.entry,
      exit: fill.avgPrice,
      openedAt: p.openedAt,
      closedAt: now,
      reason,
      gross,
      fees,
      net: gross - fees,
      r: Number(((fill.avgPrice - p.entry) / p.risk).toFixed(2)),
    };
    this.risk.onClose(trade, now);
    this.save();
    this.subscribe(this.tokens());
    this.log('exit', { ...trade, dayNet: this.day.realized, halted: this.day.halted ?? undefined });
  }

  summary() {
    const d = this.day;
    const wins = d.trades.filter((t) => t.net > 0).length;
    return { date: d.date, trades: d.trades.length, wins, net: d.realized, fees: d.trades.reduce((s, t) => s + t.fees, 0), halted: d.halted, open: d.open?.option.symbol ?? null };
  }
}
