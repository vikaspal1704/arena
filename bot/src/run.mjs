// Runs the bot for one trading day on live Kite prices.
//
//   npm run paper              paper trading (default): real prices, simulated fills
//   npm run paper -- --record  ...and save the day's ticks for replay (personal use only)
//   npm run live               real orders, only if every gate in report.mjs passes
//
// Needs today's Kite session: start the bridge (cd ../bridge && npm start)
// and log in once at http://127.0.0.1:8765 first. Create bot/STOP to close
// any position and stop trading for the day.

import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { istDate, KiteClient } from '../../bridge/src/kite.mjs';
import { ENV_FILE, loadDotEnv, readSession, SESSION_FILE } from '../../bridge/src/session.mjs';
import { TradingBot } from './bot.mjs';
import { KiteBroker } from './brokers/kite.mjs';
import { PaperBroker } from './brokers/paper.mjs';
import { fromHistorical } from './candles.mjs';
import { optionsFor } from './chain.mjs';
import { loadConfig, MARKETS, paise } from './config.mjs';
import { printEntry } from './print.mjs';
import { QuoteBook } from './quotes.mjs';
import { formatStats, liveGate, stats } from './report.mjs';
import { FileStore, Journal } from './store.mjs';
import { Ticker } from './ticker.mjs';
import { clock, ist, rupees } from './time.mjs';

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const RECORD = args.has('--record');
const STOP_FILE = path('STOP');

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

loadDotEnv(ENV_FILE);
const configFile = path('config.json');
let config;
try {
  config = loadConfig(existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {});
} catch (err) {
  die(err.message);
}
const apiKey = process.env.KITE_API_KEY;
const accessToken = apiKey ? readSession(SESSION_FILE, apiKey) : null;
if (!accessToken) die('No Kite session for today. Start the bridge (cd bridge && npm start), open http://127.0.0.1:8765 and log in with Kite, then run the bot again.');

const today = istDate();
const mode = LIVE ? 'live' : 'paper';
const store = new FileStore(path(`state/${mode}`));
mkdirSync(path('logs'), { recursive: true });
const journal = new Journal(path(`logs/${mode}-${today}.jsonl`), printEntry);
const client = new KiteClient({ apiKey, accessToken });
const profile = await client.profile().catch((err) => die(`Kite refused the session (${err.message}). Log in again through the bridge.`));

if (LIVE) {
  const problems = liveGate(config, new FileStore(path('state/paper')).days(), { interactive: process.stdin.isTTY });
  if (problems.length) die(`Live trading is locked:\n- ${problems.join('\n- ')}\n\nRun "npm run paper" in the meantime.`);
  const cash = await client.availableCash();
  if (cash < paise(config.capital)) die(`Kite shows ${rupees(cash)} available, less than the configured capital of ₹${config.capital}. Lower "capital" in bot/config.json or add funds.`);
  const held = (await client.positions()).filter((p) => p.qty !== 0 && config.underlyings.some((u) => p.symbol.startsWith(u)));
  if (held.length) console.log(`Note: you already hold ${held.map((p) => `${p.qty} ${p.symbol}`).join(', ')}. The bot ignores positions it did not open.`);
  console.log(`\n${formatStats(stats(new FileStore(path('state/paper')).days()), 'Paper record')}\n`);
  console.log(`LIVE TRADING for ${profile.user_name ?? profile.user_id}: real orders, up to ₹${config.risk.riskPerTrade} at risk per trade and ₹${config.risk.dailyLossCap} a day.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type LIVE to start: ');
  rl.close();
  if (answer.trim() !== 'LIVE') die('Not started.');
}

// Option chains, and the index history the averages need.
const markets = {};
const byExchange = new Map();
for (const name of config.underlyings) {
  const def = MARKETS[name];
  if (!byExchange.has(def.exchange)) byExchange.set(def.exchange, await client.instruments(def.exchange));
  markets[name] = optionsFor(byExchange.get(def.exchange), def);
}

const quotes = new QuoteBook();
const broker = LIVE
  ? new KiteBroker({ client, quotes, orders: config.orders, log: (type, data) => journal.write(Date.now(), `broker ${type}`, data) })
  : new PaperBroker({ quotes, slippageTicks: config.orders.paperSlippageTicks });
const ticker = new Ticker({ apiKey, accessToken });
const bot = new TradingBot({ config, markets, broker, quotes, store, journal, killSwitch: () => existsSync(STOP_FILE), subscribe: (tokens) => ticker.setTokens(tokens) });

let recorder = null;
if (RECORD) {
  mkdirSync(path('recordings'), { recursive: true });
  recorder = createGzip();
  recorder.pipe(createWriteStream(path(`recordings/${today}.jsonl.gz`), { flags: 'a' }));
  recorder.write(`${JSON.stringify({ k: 'meta', date: today, markets })}\n`);
}

const nowIst = ist(Date.now());
for (const name of config.underlyings) {
  const from = new Date(Date.now() - 7 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  try {
    const rows = await client.historical(MARKETS[name].spotToken, `${config.candleMinutes}minute`, `${from} 09:15:00`, `${today} ${clock(nowIst.minute)}:00`);
    // Leave out the candle still forming: the live feed builds it.
    const candles = fromHistorical(rows).filter((c) => c.date < today || c.minute + config.candleMinutes <= nowIst.minute);
    bot.warm(name, candles);
    recorder?.write(`${JSON.stringify({ k: 'warm', market: name, candles })}\n`);
  } catch (err) {
    journal.write(Date.now(), 'alert', { message: `No ${name} history (${err.message}). The averages need about ${config.signal.emaSlow} candles of live data before the first trade.` });
  }
}
await bot.resume();

ticker.on('tick', (tick) => {
  recorder?.write(`${JSON.stringify({ k: 'tick', at: Date.now(), tick })}\n`);
  bot.onTick(tick).catch((err) => journal.write(Date.now(), 'alert', { message: err.message }));
});
ticker.on('status', (s) => {
  journal.write(Date.now(), 'info', { feed: s });
  if (s.includes('HTTP 403')) {
    journal.write(Date.now(), 'alert', { message: 'Kite refused the price feed: the session has expired. Log in again through the bridge and restart the bot.' });
    finish('price feed lost');
  }
});
ticker.setTokens(bot.tokens());
ticker.start();
console.log(`Arena bot, ${mode.toUpperCase()} mode, ${today}. ${config.underlyings.join(' and ')} options; capital ₹${config.capital}. Create bot/STOP to close out and stop.`);

let finishing = false;
async function finish(reason) {
  if (finishing) return;
  finishing = true;
  if (bot.day.open) {
    console.log(`Closing ${bot.day.open.option.symbol} before stopping...`);
    await bot.act(() => bot.exit(reason));
  }
  ticker.stop();
  clearInterval(timer);
  clearInterval(status);
  printEntry({ type: 'summary', ...bot.summary() });
  if (bot.day.open) console.log(`STILL OPEN: ${bot.day.open.option.symbol}. Close it in Kite.`);
  await new Promise((r) => (recorder ? recorder.end(r) : r()));
  process.exit(bot.day.open ? 1 : 0);
}

const timer = setInterval(() => {
  bot.onTimer().catch((err) => journal.write(Date.now(), 'alert', { message: err.message }));
  if (ist(Date.now()).minute >= 15 * 60 + 31) finish('market closed');
}, 1000);
const status = setInterval(() => {
  const spots = [...bot.markets.values()].map((m) => `${m.name} ${m.spot === null ? '-' : rupees(m.spot)}`).join('  ');
  const p = bot.day.open;
  console.log(`${clock(ist(Date.now()).minute)}  ${spots}  VIX ${bot.vix === null ? '-' : (bot.vix / 100).toFixed(2)}  ${p ? `holding ${p.qty} ${p.option.symbol}, stop ${rupees(p.stop)}` : 'flat'}  day ${rupees(bot.day.realized)}`);
}, 5 * 60_000);
process.on('SIGINT', () => finish('stopped by you'));
process.on('SIGTERM', () => finish('stopped by you'));
