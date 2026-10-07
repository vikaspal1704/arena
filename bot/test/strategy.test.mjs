import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { OrbTrend } from '../src/strategy.mjs';

const cfg = loadConfig();

/** A strategy warmed on a steady uptrend, then today's opening range 100.00–101.00. */
function warmed(slope = 10) {
  const s = new OrbTrend({ ...cfg.signal, emaFast: 3, emaSlow: 6, atrPeriod: 3 }, cfg.session);
  let px = slope > 0 ? 9_000 : 11_600;
  for (let i = 0; i < 10; i++) {
    s.onCandle({ date: '2026-10-06', minute: 555 + i * 5, o: px, h: px + 60, l: px - 60, c: px + slope });
    px += slope;
  }
  for (const [m, c] of [[555, 10_050], [560, 10_000], [565, 10_080]]) s.onCandle({ date: '2026-10-07', minute: m, o: c, h: Math.min(10_100, c + 20), l: Math.max(10_000, c - 20), c });
  return s;
}

test('a fresh close above the opening range in an uptrend is a call signal', () => {
  const s = warmed(150);
  const r = s.onCandle({ date: '2026-10-07', minute: 570, o: 10_090, h: 10_150, l: 10_080, c: 10_140 });
  assert.equal(r.signal, 'CE', JSON.stringify(r.checks));
  // The next close beyond the range is not fresh.
  const again = s.onCandle({ date: '2026-10-07', minute: 575, o: 10_140, h: 10_170, l: 10_130, c: 10_160 });
  assert.equal(again.signal, null);
  assert.equal(again.checks.find((k) => k.rule === 'fresh').pass, false);
});

test('the trend filter blocks a breakout against the trend', () => {
  const s = warmed(-150); // a falling market: EMA fast < slow
  const r = s.onCandle({ date: '2026-10-07', minute: 570, o: 10_090, h: 10_150, l: 10_080, c: 10_140 });
  assert.equal(r.signal, null);
  assert.equal(r.checks.find((k) => k.rule === 'trend').pass, false);
});

test('a direction is used once a day; failed breakouts are detected', () => {
  const s = warmed(150);
  s.markTaken('CE');
  const r = s.onCandle({ date: '2026-10-07', minute: 570, o: 10_090, h: 10_150, l: 10_080, c: 10_140 });
  assert.equal(r.checks.find((k) => k.rule === 'first today').pass, false);
  assert.equal(s.failedBreakout('CE', { c: 10_090 }), true);
  assert.equal(s.failedBreakout('CE', { c: 10_110 }), false);
  assert.equal(s.failedBreakout('PE', { c: 9_990 }), false);
});

test('no history means no trade, with the reason', () => {
  const s = new OrbTrend(cfg.signal, cfg.session);
  const r = s.onCandle({ date: '2026-10-07', minute: 600, o: 1, h: 2, l: 1, c: 2 });
  assert.equal(r.signal, null);
  assert.equal(r.checks[0].rule, 'indicators ready');
});
