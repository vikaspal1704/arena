// India time without a timezone database: IST is UTC+05:30 all year.

const IST_OFFSET_MS = 330 * 60_000;

/** { date: 'YYYY-MM-DD', minute: minutes since midnight, second } in India. */
export function ist(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), second: d.getUTCSeconds() };
}

/** '09:30' → 570 */
export function hm(text) {
  const m = /^(\d\d):(\d\d)$/.exec(text);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Bad time "${text}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 570 → '09:30' */
export function clock(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Epoch ms of HH:MM on an India date. */
export function istMs(date, hhmm) {
  return Date.parse(`${date}T${hhmm}:00+05:30`);
}

/** '₹1,234.50' from paise, for logs. */
export function rupees(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  const whole = Math.floor(abs / 100).toLocaleString('en-IN');
  return `${sign}₹${whole}.${String(abs % 100).padStart(2, '0')}`;
}
