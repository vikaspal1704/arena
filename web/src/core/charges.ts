/**
 * Charges on an index-futures trade in India, from F&O Wrapped's dated rate
 * table (vikaspal1704/fo-wrapped, src/engine/charges/rates.ts), as of 2026-04-01:
 *
 *   brokerage   min(₹20, 0.03% of order value) per executed order (discount broker)
 *   STT         0.05% of sell value (Union Budget 2026)
 *   exchange    NSE ₹1.73 per lakh of turnover
 *   SEBI        ₹10 per crore of turnover
 *   stamp duty  0.002% of buy value
 *   GST         18% on brokerage + exchange + SEBI
 *
 * All amounts are integer paise; each component is rounded once, at the end.
 */
import type { Side } from './types';

export interface ExecutedOrder {
  side: Side;
  /** Σ price × qty of the order's fills, in paise. */
  value: number;
}

export interface Charges {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

export const ZERO_CHARGES: Charges = { brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, total: 0 };

export function chargesFor(orders: readonly ExecutedOrder[]): Charges {
  if (orders.length === 0) return ZERO_CHARGES;
  let brokerage = 0;
  let buy = 0;
  let sell = 0;
  for (const o of orders) {
    brokerage += Math.min(2000, Math.round((o.value * 3) / 10_000));
    if (o.side === 'BUY') buy += o.value;
    else sell += o.value;
  }
  const turnover = buy + sell;
  const stt = Math.round((sell * 5) / 10_000);
  const exchange = Math.round((turnover * 173) / 10_000_000);
  const sebi = Math.round(turnover / 1_000_000);
  const stamp = Math.round((buy * 2) / 100_000);
  const gst = Math.round(((brokerage + exchange + sebi) * 18) / 100);
  return { brokerage, stt, exchange, sebi, stamp, gst, total: brokerage + stt + exchange + sebi + stamp + gst };
}
