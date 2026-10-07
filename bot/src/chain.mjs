// Option chain handling: which expiry, which strikes, and which single
// contract is liquid enough and fits the money and risk limits.

import { rupeesToPaise } from '../../bridge/src/kite.mjs';
import { roundTripCharges } from './charges.mjs';
import { rupees } from './time.mjs';

/** Options on one underlying from Kite's instrument list. */
export function optionsFor(rows, { name, segment }) {
  return rows
    .filter((r) => r.name === name && r.segment === segment && (r.instrument_type === 'CE' || r.instrument_type === 'PE'))
    .map((r) => ({
      token: Number(r.instrument_token),
      exchange: r.exchange,
      symbol: r.tradingsymbol,
      type: r.instrument_type,
      strike: rupeesToPaise(r.strike),
      expiry: r.expiry,
      lot: Number.parseInt(r.lot_size, 10),
      tickPaise: rupeesToPaise(r.tick_size),
    }));
}

/** Nearest expiry on or after today; the next one instead if today is expiry day and we avoid it. */
export function pickExpiry(options, today, avoidExpiryDay) {
  const expiries = [...new Set(options.map((o) => o.expiry))].filter((e) => e >= today).sort();
  if (avoidExpiryDay && expiries[0] === today) return expiries[1] ?? null;
  return expiries[0] ?? null;
}

/** Strikes ordered ATM first, then further out of the money. */
export function candidates(options, { expiry, type, spot, maxOtmSteps }) {
  const list = options.filter((o) => o.expiry === expiry && o.type === type).sort((a, b) => a.strike - b.strike);
  if (list.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i].strike - spot) < Math.abs(list[atm].strike - spot)) atm = i;
  const dir = type === 'CE' ? 1 : -1; // out of the money: higher strikes for calls, lower for puts
  const out = [];
  for (let k = 0; k <= maxOtmSteps; k++) {
    const o = list[atm + dir * k];
    if (o) out.push(o);
  }
  return out;
}

/** Calls and puts within `width` strikes either side of the money, for streaming quotes. */
export function band(options, { expiry, spot, width }) {
  const strikes = [...new Set(options.filter((o) => o.expiry === expiry).map((o) => o.strike))].sort((a, b) => a - b);
  if (strikes.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i] - spot) < Math.abs(strikes[atm] - spot)) atm = i;
  const keep = new Set(strikes.slice(Math.max(0, atm - width), atm + width + 1));
  return options.filter((o) => o.expiry === expiry && keep.has(o.strike));
}

const floorTo = (x, tick) => Math.floor(x / tick) * tick;

/**
 * Picks the first candidate that passes every check. Returns
 * { choice: { option, qty, ask, stopDistance, risk, cost } | null, reasons }.
 */
export function chooseOption(cands, quotes, now, { riskPaise, budgetPaise, option: cfg }) {
  const reasons = [];
  for (const o of cands) {
    const reject = (why) => reasons.push({ symbol: o.symbol, ok: false, why });
    const q = quotes.get(o.token);
    if (!q || now - q.at > cfg.maxQuoteAgeSec * 1000) {
      reject('no fresh quote');
      continue;
    }
    if (!q.bid || !q.ask) {
      reject('no two-sided quote');
      continue;
    }
    const spreadPct = ((q.ask - q.bid) / q.ask) * 100;
    if (spreadPct > cfg.maxSpreadPct) {
      reject(`spread ${spreadPct.toFixed(2)}% (max ${cfg.maxSpreadPct}%)`);
      continue;
    }
    if (q.askQty < o.lot * cfg.minTopQtyLots) {
      reject(`only ${q.askQty} offered at best (need ${o.lot * cfg.minTopQtyLots})`);
      continue;
    }
    let picked = null;
    let why = '';
    for (let lots = cfg.maxLots; lots >= 1 && !picked; lots--) {
      const qty = lots * o.lot;
      const fees = roundTripCharges(o.exchange, qty, q.ask);
      const maxStop = floorTo((q.ask * cfg.maxStopPct) / 100, o.tickPaise);
      // The stop must also pay for the round trip's charges within the risk limit.
      const affordable = floorTo((riskPaise - fees) / qty, o.tickPaise);
      const stopDistance = Math.min(maxStop, affordable);
      const cost = q.ask * qty + fees;
      if (stopDistance < (q.ask * cfg.minStopPct) / 100) {
        why = `${lots} lot${lots > 1 ? 's' : ''}: the risk limit allows a stop of only ${rupees(Math.max(0, affordable))} on a ${rupees(q.ask)} premium (min ${cfg.minStopPct}%)`;
      } else if (cost > budgetPaise) {
        why = `${lots} lot${lots > 1 ? 's' : ''} cost ${rupees(cost)}, more than ${rupees(budgetPaise)}`;
      } else {
        picked = { option: o, qty, ask: q.ask, stopDistance, risk: stopDistance * qty + fees, cost };
      }
    }
    if (picked) {
      reasons.push({ symbol: o.symbol, ok: true, why: `${picked.qty} @ ${rupees(q.ask)}, stop ${rupees(picked.stopDistance)} below, risk ${rupees(picked.risk)}` });
      return { choice: picked, reasons };
    }
    reject(why);
  }
  return { choice: null, reasons };
}
