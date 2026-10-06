const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Paise → "24,012.35". */
export const price = (paise: number) => inr.format(paise / 100);

/** Paise → "₹1,234.50" / "−₹12.00". */
export function money(paise: number, opts: { sign?: boolean; whole?: boolean } = {}): string {
  const abs = (opts.whole ? inr0 : inr).format(Math.abs(paise) / 100);
  const sign = paise < 0 ? '−' : opts.sign && paise > 0 ? '+' : '';
  return `${sign}₹${abs}`;
}

export const qty = (units: number) => inr0.format(units);

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
