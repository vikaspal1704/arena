/// <reference lib="webworker" />
/**
 * The exchange process. It owns the engine (Rust, as WebAssembly), runs the
 * market clock, and talks to the UI over two channels, like a real venue:
 * a sequenced, lossy market-data feed, and a reliable private channel for
 * the player's own order events.
 */
import { FeedPublisher, type TapeTrade } from '../core/feed';
import { ArenaCore } from '../core/wasm';
import { PLAYER, type ArenaEvent } from '../core/types';
import type { FromExchange, ToExchange } from './protocol';

const TICK_MS = 100;
const SNAPSHOT_LEVELS = 50;
const post = (msg: FromExchange) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

let core: ArenaCore | null = null;
let feed = new FeedPublisher(1);
let seed = 0;
let paused = false;
let stepsPerTick = 1;
let timer: ReturnType<typeof setInterval> | null = null;
const myLive = new Set<number>();

const corePromise = (async () => {
  const url = new URL(`${import.meta.env.BASE_URL}arena.wasm`, self.location.href);
  const bytes = await (await fetch(url)).arrayBuffer();
  return ArenaCore.load(bytes);
})();

function isMine(e: ArenaEvent): boolean {
  if (e.kind === 'trade') return e.makerOwner === PLAYER || e.takerOwner === PLAYER;
  if (e.kind === 'level') return false;
  return e.owner === PLAYER;
}

/** Fans one batch of engine events out to the two channels. */
function publish(events: ArenaEvent[]): void {
  const c = core!;
  const levels: { side: 'BUY' | 'SELL'; price: number; qty: number; orders: number }[] = [];
  const trades: TapeTrade[] = [];
  const mine: ArenaEvent[] = [];
  for (const e of events) {
    if (e.kind === 'level') levels.push({ side: e.side, price: e.price, qty: e.qty, orders: e.orders });
    if (e.kind === 'trade') {
      trades.push({ tradeId: e.tradeId, ts: e.ts, price: e.price, qty: e.qty, aggressor: e.aggressor, mine: isMine(e) });
    }
    if (isMine(e)) {
      mine.push(e);
      if (e.kind === 'accepted' && !e.market) myLive.add(e.orderId);
      if (e.kind === 'done') myLive.delete(e.orderId);
    }
  }
  const delta = feed.publish(levels, trades);
  if (delta) post(delta);
  if (mine.length) post({ type: 'private', events: mine, fair: c.fairPrice() });
}

function status(): void {
  const c = core!;
  const queue: Record<number, [number, number]> = {};
  for (const id of myLive) {
    const q = c.queueAhead(id);
    if (q) queue[id] = [q.orders, q.qty];
  }
  post({ type: 'status', seq: c.seq(), fingerprint: c.fingerprint(), nowMs: c.nowMs(), paused, queue, feedSeq: feed.feedSeq, dropped: feed.dropped });
}

function tick(): void {
  if (!core || paused) return;
  const events: ArenaEvent[] = [];
  for (let i = 0; i < stepsPerTick; i++) events.push(...core.step(TICK_MS));
  publish(events);
  status();
}

function snapshot(): void {
  post({ type: 'snapshot', feedSeq: feed.feedSeq, ...core!.depth(SNAPSHOT_LEVELS) });
}

self.onmessage = async (event: MessageEvent<ToExchange>) => {
  const msg = event.data;
  if (msg.type === 'start') {
    core = await corePromise;
    seed = msg.seed;
    core.start(seed);
    const dropRate = feed.dropRate;
    feed = new FeedPublisher(seed ^ 0x5eed);
    feed.dropRate = dropRate;
    myLive.clear();
    paused = false;
    post({ type: 'ready', seed });
    snapshot();
    status();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    return;
  }
  if (!core) return;
  switch (msg.type) {
    case 'limit':
      if (!paused) publish(core.limit(msg.side, msg.price, msg.qty));
      break;
    case 'market':
      if (!paused) publish(core.market(msg.side, msg.qty));
      break;
    case 'cancel':
      if (!paused) publish(core.cancel(msg.orderId));
      break;
    case 'pause':
      paused = msg.paused;
      if (!paused) snapshot(); // the replay view may have been shown; resume from the live book
      break;
    case 'speed':
      stepsPerTick = Math.max(1, Math.min(8, Math.round(msg.stepsPerTick)));
      break;
    case 'chaos':
      feed.dropRate = Math.max(0, Math.min(0.5, msg.dropRate));
      break;
    case 'resync':
      snapshot();
      break;
    case 'replay': {
      const upto = Math.max(0, Math.min(core.seq(), Math.round(msg.upto)));
      const r = core.replay(upto);
      post({ type: 'replay', upto, ...r, ...core.depth(10, true), rows: core.journal(upto - 7, upto) });
      break;
    }
    case 'journal':
      post({ type: 'journal', seed, rows: core.journal(1, core.seq()), fingerprint: core.fingerprint() });
      break;
    case 'end': {
      paused = true;
      if (timer) clearInterval(timer);
      timer = null;
      const seq = core.seq();
      post({ type: 'ended', fair: core.fairPrice(), seq, fingerprint: core.fingerprint(), nowMs: core.nowMs(), verified: core.replay(seq).matches });
      break;
    }
  }
  status();
};
