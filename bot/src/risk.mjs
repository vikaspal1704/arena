// Account-level limits. The strategy proposes; this says yes or no, and why.

import { paise } from './config.mjs';
import { hm, ist } from './time.mjs';

export function freshDay(date) {
  return { date, trades: [], realized: 0, consecutiveLosses: 0, lastLossAt: null, halted: null, open: null };
}

export class RiskManager {
  /** `day` is persisted state; `equity` is capital plus realized P&L before today, in paise. */
  constructor(config, day, { equity = paise(config.capital) } = {}) {
    this.cfg = config;
    this.day = day;
    this.startEquity = equity;
    this.s = Object.fromEntries(Object.entries(config.session).map(([k, v]) => [k, hm(v)]));
  }

  get equity() {
    return this.startEquity + this.day.realized;
  }

  /** Money one trade may lose: the per-trade limit, or what is left of today's cap if less. */
  riskBudget() {
    return Math.max(0, Math.min(paise(this.cfg.risk.riskPerTrade), paise(this.cfg.risk.dailyLossCap) + this.day.realized));
  }

  /** Money one trade may spend on premium and charges. */
  spendBudget() {
    return Math.max(0, Math.min(paise(this.cfg.capital), this.equity));
  }

  /** { ok, checks: [{ rule, pass, detail }] } for opening a new position now. */
  canEnter(now, { expiryIsToday = false, vix = null, killSwitch = false } = {}) {
    const r = this.cfg.risk;
    const d = this.day;
    const t = ist(now);
    const checks = [];
    const add = (rule, pass, detail) => checks.push({ rule, pass, detail });
    add('not halted', !d.halted, d.halted ?? 'trading');
    add('kill switch', !killSwitch, killSwitch ? 'STOP file present' : 'off');
    add('not an event day', !r.eventDays.includes(t.date), r.eventDays.includes(t.date) ? `${t.date} is listed in risk.eventDays` : 'normal day');
    add('entry window', t.minute >= this.s.firstEntry && t.minute < this.s.lastEntry, `${this.cfg.session.firstEntry}–${this.cfg.session.lastEntry}`);
    if (expiryIsToday) add('expiry-day cutoff', t.minute < this.s.expiryDayLastEntry, `no new trades in an expiring contract after ${this.cfg.session.expiryDayLastEntry}`);
    add('trades today', d.trades.length < r.maxTradesPerDay, `${d.trades.length} of ${r.maxTradesPerDay}`);
    add('one position at a time', !d.open, d.open ? `holding ${d.open.option.symbol}` : 'flat');
    add('losing streak', d.consecutiveLosses < r.maxConsecutiveLosses, `${d.consecutiveLosses} losses in a row (max ${r.maxConsecutiveLosses - 1})`);
    const waited = d.lastLossAt === null ? Infinity : (now - d.lastLossAt) / 60_000;
    add('cooldown after a loss', waited >= r.cooldownMinutes, d.lastLossAt === null ? 'no loss today' : `${Math.floor(waited)} of ${r.cooldownMinutes} minutes`);
    add('daily loss cap', d.realized > -paise(r.dailyLossCap), `today ${(d.realized / 100).toFixed(2)} (cap -${r.dailyLossCap})`);
    add('capital floor', this.equity >= paise(r.capitalFloor), `equity ${(this.equity / 100).toFixed(2)} (floor ${r.capitalFloor})`);
    add('volatility', vix !== null && vix <= r.maxVix * 100, vix === null ? 'India VIX unknown' : `India VIX ${(vix / 100).toFixed(2)} (max ${r.maxVix})`);
    add('risk budget left', this.riskBudget() > 0, `${(this.riskBudget() / 100).toFixed(2)}`);
    return { ok: checks.every((c) => c.pass), checks };
  }

  onOpen(position) {
    this.day.open = position;
  }

  /** Books a closed trade and applies the stop-for-the-day rules. */
  onClose(trade, now) {
    this.day.open = null;
    this.day.trades.push(trade);
    this.day.realized += trade.net;
    if (trade.net < 0) {
      this.day.consecutiveLosses++;
      this.day.lastLossAt = now;
    } else {
      this.day.consecutiveLosses = 0;
    }
    const r = this.cfg.risk;
    if (this.day.realized <= -paise(r.dailyLossCap)) this.halt('daily loss cap reached');
    else if (this.day.consecutiveLosses >= r.maxConsecutiveLosses) this.halt(`${this.day.consecutiveLosses} losses in a row`);
    else if (this.equity < paise(r.capitalFloor)) this.halt('equity below the capital floor');
  }

  halt(reason) {
    // The kill switch always wins, so it can't be masked by an earlier reason.
    if (reason === 'kill switch' || !this.day.halted) this.day.halted = reason;
  }
}
