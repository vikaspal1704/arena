// Charges on an index-option trade at a discount broker, from F&O Wrapped's
// dated rate table (vikaspal1704/fo-wrapped, src/engine/charges/rates.ts),
// in force from 2026-04-01:
//
//   brokerage   ₹20 per executed order
//   STT         0.15% of sell premium (Union Budget 2026)
//   exchange    NSE ₹35.03 per lakh of premium; BSE (SENSEX) ₹32.50 per lakh
//   SEBI        ₹10 per crore
//   stamp duty  0.003% of buy premium
//   GST         18% on brokerage + exchange + SEBI
//
// Integer paise; each component rounded once.

const EXCHANGE_RATE = { NFO: [3503, 10_000_000], BFO: [325, 1_000_000] };

export function optionCharges({ exchange, buyValue = 0, sellValue = 0, orders }) {
  const rate = EXCHANGE_RATE[exchange];
  if (!rate) throw new Error(`No charges table for ${exchange}`);
  const turnover = buyValue + sellValue;
  const brokerage = 2000 * orders;
  const stt = Math.round((sellValue * 15) / 10_000);
  const exch = Math.round((turnover * rate[0]) / rate[1]);
  const sebi = Math.round(turnover / 1_000_000);
  const stamp = Math.round((buyValue * 3) / 100_000);
  const gst = Math.round(((brokerage + exch + sebi) * 18) / 100);
  return { brokerage, stt, exchange: exch, sebi, stamp, gst, total: brokerage + stt + exch + sebi + stamp + gst };
}

/** Round-trip charges if `qty` is bought at `entry` and sold at `exit`. */
export function roundTripCharges(exchange, qty, entry, exit = entry) {
  return optionCharges({ exchange, buyValue: entry * qty, sellValue: exit * qty, orders: 2 }).total;
}
