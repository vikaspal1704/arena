import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TradingBot } from '../src/bot.mjs';
import { PaperBroker } from '../src/brokers/paper.mjs';
import { loadConfig } from '../src/config.mjs';
import { QuoteBook } from '../src/quotes.mjs';
import { replay } from '../src/replay.mjs';
import { freshDay } from '../src/risk.mjs';
import { Journal, MemoryStore } from '../src/store.mjs';
import { synthDay } from '../src/synth.mjs';
import { istMs } from '../src/time.mjs';

const config = loadConfig({ underlyings: ['NIFTY'] });
const of = (j, type) => j.entries.filter((e) => e.type === type);

test('trend day: one call bought on the breakout, stop raised, sold at target', async () => {
  const journal = new Journal();
  const bot = await replay(synthDay({ pattern: 'trend-up' }), { config, journal });
  const [entry] = of(journal, 'entry');
  assert.equal(entry.side, 'CE');
  assert.ok(entry.why.length >= 7, 'every strategy rule is recorded with the entry');
  assert.ok(entry.risk <= 80_000, 'risk with charges within ₹800');
  assert.ok(of(journal, 'stop moved').some((e) => e.why === 'breakeven'));
  const [exit] = of(journal, 'exit');
  assert.equal(exit.reason, 'target');
  assert.ok(exit.net > 0);
  assert.equal(bot.summary().trades, 1);
  assert.equal(bot.day.open, null);
});

test('falling day: a put, by the same rules', async () => {
  const journal = new Journal();
  await replay(synthDay({ pattern: 'trend-down' }), { config, journal });
  assert.equal(of(journal, 'entry')[0].side, 'PE');
});

test('failed breakout: out when the index is back in the range, losing less than the risk limit', async () => {
  const journal = new Journal();
  const bot = await replay(synthDay({ pattern: 'fakeout' }), { config, journal });
  const [exit] = of(journal, 'exit');
  assert.equal(exit.reason, 'index back inside the opening range');
  assert.ok(exit.net < 0 && exit.net >= -80_000);
  assert.ok(bot.summary().trades <= config.risk.maxTradesPerDay);
});

test('replays are deterministic', async () => {
  const a = new Journal();
  const b = new Journal();
  await replay(synthDay({ pattern: 'fakeout', seed: 9 }), { config, journal: a });
  await replay(synthDay({ pattern: 'fakeout', seed: 9 }), { config, journal: b });
  assert.deepEqual(a.entries, b.entries);
});

test('the STOP file flattens the position and halts the day', async () => {
  const journal = new Journal();
  let stop = false;
  const records = synthDay({ pattern: 'trend-up' });
  const switchAt = istMs('2026-10-07', '09:45');
  // Flip the kill switch once the clock passes 09:45.
  const bot = await replay(
    (function* () {
      for (const r of records) {
        if (r.k === 'tick' && r.at >= switchAt) stop = true;
        yield r;
      }
    })(),
    { config, journal, killSwitch: () => stop },
  );
  assert.equal(of(journal, 'exit')[0].reason, 'kill switch');
  assert.equal(bot.day.halted, 'kill switch');
  assert.equal(of(journal, 'entry').length, 1, 'nothing new after the switch');
});

test('event days and an earlier losing streak keep the bot out', async () => {
  const j1 = new Journal();
  await replay(synthDay({ pattern: 'trend-up' }), { config: loadConfig({ underlyings: ['NIFTY'], risk: { eventDays: ['2026-10-07'] } }), journal: j1 });
  assert.equal(of(j1, 'entry').length, 0);
  assert.match(of(j1, 'skip')[0].why.join(), /event day/);

  const day = { ...freshDay('2026-10-07'), consecutiveLosses: 2, halted: '2 losses in a row' };
  const j2 = new Journal();
  await replay(synthDay({ pattern: 'trend-up' }), { config, journal: j2, store: new MemoryStore([day]) });
  assert.equal(of(j2, 'entry').length, 0);
});

test('equity carries across days: the capital floor uses earlier losses', () => {
  const store = new MemoryStore([{ ...freshDay('2026-10-05'), realized: -310_000 }]);
  const quotes = new QuoteBook();
  const bot = new TradingBot({ config, markets: { NIFTY: [] }, broker: new PaperBroker({ quotes }), quotes, store, journal: new Journal(), now: () => istMs('2026-10-07', '10:00') });
  assert.equal(bot.risk.equity, 690_000);
  assert.equal(bot.risk.canEnter(istMs('2026-10-07', '10:00'), { vix: 1_400 }).checks.find((c) => c.rule === 'capital floor').pass, false);
});

test('restart with a position: paper re-arms its stop; live hands over and stops trading', async () => {
  const option = { token: 7, exchange: 'NFO', symbol: 'X', tickPaise: 5, lot: 65 };
  const open = { market: 'NIFTY', side: 'CE', option, qty: 65, entry: 6_000, stop: 5_000, initialStop: 5_000, risk: 1_000, peak: 6_000, openedAt: 0, breakeven: 6_100, exits: config.exits, squareOff: '15:15' };
  const day = { ...freshDay('2026-10-07'), open };
  const make = (broker, quotes) => new TradingBot({ config, markets: { NIFTY: [] }, broker, quotes, store: new MemoryStore([day]), journal: new Journal(), now: () => istMs('2026-10-07', '10:00') });

  const quotes = new QuoteBook();
  const paper = new PaperBroker({ quotes });
  await make(paper, quotes).resume();
  assert.equal(paper.stop.trigger, 5_000);

  const liveStub = { mode: 'live', protect: () => assert.fail('must not place orders') };
  const bot = make(liveStub, quotes);
  await bot.resume();
  assert.equal(bot.day.halted, 'restarted with a live position open');
  assert.match(of(bot.journal, 'alert')[0].message, /manage or close it/);
});
