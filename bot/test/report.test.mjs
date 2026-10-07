import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_ACKNOWLEDGEMENT, loadConfig } from '../src/config.mjs';
import { liveGate, stats } from '../src/report.mjs';
import { freshDay } from '../src/risk.mjs';

const day = (date, nets) => ({ ...freshDay(date), trades: nets.map((net) => ({ net, fees: 6_000 })), realized: nets.reduce((a, b) => a + b, 0) });

test('stats: win rate, expectancy, profit factor and drawdown after charges', () => {
  const s = stats([day('2026-10-01', [100_000, -50_000]), day('2026-10-02', [-50_000, -20_000, 90_000])]);
  assert.equal(s.trades, 5);
  assert.equal(s.wins, 2);
  assert.equal(s.net, 70_000);
  assert.equal(s.expectancy, 14_000);
  assert.equal(s.profitFactor, 190_000 / 120_000);
  assert.equal(s.maxDrawdown, 120_000);
});

test('live stays locked until it is switched on, acknowledged, earned on paper and confirmed at a terminal', () => {
  const locked = loadConfig();
  assert.equal(liveGate(locked, [], { interactive: false }).length, 5);

  const on = loadConfig({ live: { enabled: true, acknowledge: LIVE_ACKNOWLEDGEMENT } });
  const days = Array.from({ length: 20 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, '0')}`, [30_000]));
  assert.deepEqual(liveGate(on, days, { interactive: true }), []);
  assert.equal(liveGate(on, days, { interactive: false }).length, 1);
  assert.match(liveGate(on, days.slice(5), { interactive: true })[0], /15 of 20 trading days/);
  const losing = days.map((d) => day(d.date, [-10_000]));
  assert.match(liveGate(on, losing, { interactive: true }).join(), /loses money after charges/);
  assert.equal(liveGate(loadConfig({ live: { enabled: true, acknowledge: 'yes' } }), days, { interactive: true }).length, 1);
});
