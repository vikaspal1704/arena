// Track record from the bot's day files, and the paper-first gate for live.
//
//   node src/report.mjs           # paper record
//   node src/report.mjs --live    # live record

import { fileURLToPath } from 'node:url';
import { LIVE_ACKNOWLEDGEMENT } from './config.mjs';
import { rupees } from './time.mjs';

/** Statistics over closed trades, oldest first. Amounts in paise. */
export function stats(days) {
  const trades = days.flatMap((d) => d.trades);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sum = (xs) => xs.reduce((s, t) => s + t.net, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    equity += t.net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    days: days.length,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    net: sum(trades),
    fees: trades.reduce((s, t) => s + t.fees, 0),
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    expectancy: trades.length ? sum(trades) / trades.length : 0,
    profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / -sum(losses) : null,
    maxDrawdown,
  };
}

/**
 * Everything that must be true before real orders are allowed.
 * Returns a list of unmet conditions; empty means the gate is open.
 */
export function liveGate(config, paperDays, { interactive }) {
  const problems = [];
  if (config.live.enabled !== true) problems.push('Set "live": { "enabled": true } in bot/config.json.');
  if (config.live.acknowledge !== LIVE_ACKNOWLEDGEMENT) problems.push(`Set "live": { "acknowledge": "${LIVE_ACKNOWLEDGEMENT}" } in bot/config.json.`);
  const s = stats(paperDays);
  if (s.days < config.live.minPaperDays) problems.push(`Paper trade first: ${s.days} of ${config.live.minPaperDays} trading days recorded.`);
  if (s.trades < config.live.minPaperTrades) problems.push(`Paper trade first: ${s.trades} of ${config.live.minPaperTrades} trades recorded.`);
  if (s.trades > 0 && s.expectancy <= 0) problems.push(`The paper record loses money after charges (${rupees(s.expectancy)} a trade). Fix the rules before risking money.`);
  if (!interactive) problems.push('Live mode must be started from a terminal, so you can confirm it.');
  return problems;
}

export function formatStats(s, label) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  return [
    `${label}: ${s.days} days, ${s.trades} trades`,
    `  net after charges  ${rupees(s.net)}  (charges ${rupees(s.fees)})`,
    `  win rate           ${pct(s.winRate)}  (${s.wins} of ${s.trades})`,
    `  average win/loss   ${rupees(s.avgWin)} / ${rupees(s.avgLoss)}`,
    `  per trade          ${rupees(s.expectancy)}`,
    `  profit factor      ${s.profitFactor === null ? 'n/a' : s.profitFactor.toFixed(2)}`,
    `  worst drawdown     ${rupees(s.maxDrawdown)}`,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { FileStore } = await import('./store.mjs');
  const live = process.argv.includes('--live');
  const store = new FileStore(fileURLToPath(new URL(`../state/${live ? 'live' : 'paper'}`, import.meta.url)));
  console.log(formatStats(stats(store.days()), live ? 'Live' : 'Paper'));
}
