// Replays a recorded (or synthetic) day through the real bot with the paper
// broker and a simulated clock. Same code path as live, so a replay shows
// exactly what the bot would have done.
//
//   node src/replay.mjs recordings/2026-10-07.jsonl.gz
//   node src/replay.mjs --synthetic=trend-up        # or trend-down, fakeout, chop

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { TradingBot } from './bot.mjs';
import { PaperBroker } from './brokers/paper.mjs';
import { loadConfig } from './config.mjs';
import { QuoteBook } from './quotes.mjs';
import { Journal, MemoryStore } from './store.mjs';
import { istMs } from './time.mjs';

/** Drives the bot through `records` (an iterable or async iterable). Resolves to the bot. */
export async function replay(records, { config = loadConfig(), journal = new Journal(), store = new MemoryStore(), killSwitch } = {}) {
  let bot = null;
  let t = 0;
  let lastTimer = 0;
  const pendingWarm = [];
  for await (const r of records) {
    if (r.k === 'meta') {
      t = istMs(r.date, '09:00');
      lastTimer = t;
      const quotes = new QuoteBook();
      const broker = new PaperBroker({ quotes, slippageTicks: config.orders.paperSlippageTicks });
      bot = new TradingBot({ config, markets: r.markets, broker, quotes, store, journal, now: () => t, killSwitch });
    } else if (r.k === 'warm') {
      pendingWarm.push(r);
      bot.warm(r.market, r.candles);
    } else if (r.k === 'tick') {
      while (lastTimer + 1000 <= r.at) {
        lastTimer += 1000;
        t = lastTimer;
        await bot.onTimer();
      }
      t = r.at;
      await bot.onTick(r.tick);
    }
  }
  if (!bot) throw new Error('No meta record: not a bot recording');
  // Run the clock to the close so time-based exits happen.
  const close = istMs(bot.date, '15:31');
  while (lastTimer + 1000 <= close) {
    lastTimer += 1000;
    t = lastTimer;
    await bot.onTimer();
  }
  return bot;
}

/** Records from a .jsonl or .jsonl.gz recording. */
export async function* readRecording(file) {
  const input = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { printEntry } = await import('./print.mjs');
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node src/replay.mjs <recording.jsonl[.gz]> | --synthetic=trend-up|trend-down|fakeout|chop');
    process.exit(2);
  }
  let records;
  if (arg.startsWith('--synthetic')) {
    const { synthDay } = await import('./synth.mjs');
    records = synthDay({ pattern: arg.split('=')[1] || 'trend-up' });
  } else records = readRecording(arg);
  const bot = await replay(records, { journal: new Journal(null, printEntry) });
  printEntry({ type: 'summary', ...bot.summary() });
}
