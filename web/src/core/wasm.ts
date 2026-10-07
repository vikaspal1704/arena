import type { ArenaEvent, DoneReason, JournalRow, Level, RejectReason, Side } from './types';

/** Numbers per event record: [seq, ts, w0..w8] (see crates/wasm/src/lib.rs). */
const EVENT_WORDS = 11;
const JOURNAL_WORDS = 8;

interface Exports {
  memory: WebAssembly.Memory;
  arena_new(seed: number): number;
  arena_new_with(seed: number, tick: number, startPrice: number, lot: number): number;
  arena_anchor(price: number): void;
  arena_out_ptr(): number;
  arena_step(dtMs: number): number;
  arena_limit(side: number, price: number, qty: number): number;
  arena_market(side: number, qty: number): number;
  arena_cancel(orderId: number): number;
  arena_depth(levels: number, replay: number): number;
  arena_queue_ahead(orderId: number): number;
  arena_seq(): number;
  arena_now_ms(): number;
  arena_fair(): number;
  arena_fingerprint(seq: number): number;
  arena_replay(upto: number): number;
  arena_journal(from: number, to: number): number;
  arena_bench_prepare(n: number): number;
  arena_bench_run(): number;
}

const SIDE: Record<number, Side> = { 1: 'BUY', 2: 'SELL' };
const REJECT: Record<number, RejectReason> = { 1: 'BAD_PRICE', 2: 'BAD_QTY', 3: 'UNKNOWN_ORDER', 4: 'NOT_CANCELLABLE', 5: 'NOT_OWNER' };
const DONE: Record<number, DoneReason> = { 1: 'FILLED', 2: 'CANCELLED', 3: 'EXPIRED' };
const sideCode = (s: Side) => (s === 'BUY' ? 1 : 2);

const hex = (hi: number, lo: number) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');

/** Decodes event records written by the engine. */
export function decodeEvents(buf: Float64Array, count: number): ArenaEvent[] {
  const out: ArenaEvent[] = [];
  for (let i = 0; i < count; i++) {
    const r = buf.subarray(i * EVENT_WORDS, (i + 1) * EVENT_WORDS);
    const [seq, ts, kind, a, b, c, d, e, f, g, h] = r as unknown as number[];
    const stamp = { seq: seq!, ts: ts! };
    switch (kind) {
      case 1:
        out.push({ ...stamp, kind: 'accepted', orderId: a!, owner: b!, side: SIDE[c!]!, price: d!, qty: e!, market: f === 1 });
        break;
      case 2:
        out.push({ ...stamp, kind: 'rejected', owner: a!, reason: REJECT[b!]! });
        break;
      case 3:
        out.push({
          ...stamp,
          kind: 'trade',
          tradeId: a!,
          price: b!,
          qty: c!,
          makerOrderId: d!,
          takerOrderId: e!,
          makerOwner: f!,
          takerOwner: g!,
          aggressor: SIDE[h!]!,
        });
        break;
      case 4:
        out.push({ ...stamp, kind: 'done', orderId: a!, owner: b!, reason: DONE[c!]!, remaining: d! });
        break;
      case 5:
        out.push({ ...stamp, kind: 'level', side: SIDE[a!]!, price: b!, qty: c!, orders: d! });
        break;
      default:
        throw new Error(`unknown event kind ${kind}`);
    }
  }
  return out;
}

/**
 * Typed access to the Rust engine compiled to WebAssembly. The module has
 * no imports and no JavaScript glue: results are read straight out of its
 * memory.
 */
export class ArenaCore {
  private readonly x: Exports;

  constructor(instance: WebAssembly.Instance) {
    this.x = instance.exports as unknown as Exports;
  }

  static async load(bytes: BufferSource): Promise<ArenaCore> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new ArenaCore(instance);
  }

  private view(words: number): Float64Array {
    // Re-created on every read: the buffer moves when wasm memory grows.
    return new Float64Array(this.x.memory.buffer, this.x.arena_out_ptr(), words);
  }

  private events(count: number): ArenaEvent[] {
    return decodeEvents(this.view(count * EVENT_WORDS), count);
  }

  /** Starts a new session; returns the setup events' journal length. */
  start(seed: number, instrument?: { tick: number; startPrice: number; lot: number }): number {
    if (!instrument) return this.x.arena_new(seed >>> 0);
    return this.x.arena_new_with(seed >>> 0, instrument.tick, instrument.startPrice, instrument.lot);
  }

  /** Pins the hidden fair value to an external price in paise (real-market mode); null releases it. */
  anchor(price: number | null): void {
    this.x.arena_anchor(price ?? 0);
  }

  step(dtMs: number): ArenaEvent[] {
    return this.events(this.x.arena_step(dtMs));
  }

  limit(side: Side, price: number, qty: number): ArenaEvent[] {
    return this.events(this.x.arena_limit(sideCode(side), price, qty));
  }

  market(side: Side, qty: number): ArenaEvent[] {
    return this.events(this.x.arena_market(sideCode(side), qty));
  }

  cancel(orderId: number): ArenaEvent[] {
    return this.events(this.x.arena_cancel(orderId));
  }

  /** Aggregated book, best first. `replay` reads the time-travel view. */
  depth(levels: number, replay = false): { bids: Level[]; asks: Level[] } {
    const n = this.x.arena_depth(levels, replay ? 1 : 0);
    const v = this.view(n * 4);
    const bids: Level[] = [];
    const asks: Level[] = [];
    for (let i = 0; i < n; i++) {
      const level = { price: v[i * 4 + 1]!, qty: v[i * 4 + 2]!, orders: v[i * 4 + 3]! };
      (v[i * 4] === 1 ? bids : asks).push(level);
    }
    return { bids, asks };
  }

  /** Live orders and quantity ahead of a resting order, or null. */
  queueAhead(orderId: number): { orders: number; qty: number } | null {
    if (this.x.arena_queue_ahead(orderId) === 0) return null;
    const v = this.view(2);
    return { orders: v[0]!, qty: v[1]! };
  }

  seq(): number {
    return this.x.arena_seq();
  }

  nowMs(): number {
    return this.x.arena_now_ms();
  }

  fairPrice(): number {
    return this.x.arena_fair();
  }

  /** Fingerprint after journal entry `seq`, as 16 hex digits. */
  fingerprint(seq = this.seq()): string {
    this.x.arena_fingerprint(seq);
    const v = this.view(2);
    return hex(v[0]!, v[1]!);
  }

  /** Rebuilds the exchange from the first `upto` journal entries. */
  replay(upto: number): { fingerprint: string; matches: boolean } {
    this.x.arena_replay(upto);
    const v = this.view(3);
    return { fingerprint: hex(v[0]!, v[1]!), matches: v[2] === 1 };
  }

  journal(from: number, to: number): JournalRow[] {
    const n = this.x.arena_journal(from, to);
    const v = this.view(n * JOURNAL_WORDS);
    const rows: JournalRow[] = [];
    for (let i = 0; i < n; i++) {
      const [seq, ts, kind, owner, side, price, qty, orderId] = v.subarray(i * JOURNAL_WORDS, (i + 1) * JOURNAL_WORDS) as unknown as number[];
      rows.push({
        seq: seq!,
        ts: ts!,
        kind: kind === 1 ? 'LIMIT' : kind === 2 ? 'MARKET' : 'CANCEL',
        owner: owner!,
        side: kind === 3 ? null : SIDE[side!]!,
        price: kind === 1 ? price! : null,
        qty: kind === 3 ? null : qty!,
        orderId: kind === 3 ? orderId! : null,
      });
    }
    return rows;
  }

  /** Prepares `n` benchmark commands (not timed); `runBench` then runs them. */
  prepareBench(n: number): void {
    this.x.arena_bench_prepare(n);
  }

  /** Runs the prepared workload through a fresh exchange; returns the trade count. */
  runBench(): number {
    return this.x.arena_bench_run();
  }
}
