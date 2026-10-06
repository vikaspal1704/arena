/**
 * Market data as a lossy, sequenced feed, the way exchanges publish it.
 *
 * The publisher sends incremental updates ("deltas") with a gap-free feed
 * sequence number. A client applies them in order; when it sees a gap it
 * knows its book is wrong, stops trusting it, asks for a snapshot, and
 * resumes from the snapshot's sequence. Deltas at or below the snapshot's
 * sequence are already included in it and are ignored.
 *
 * (Protocol from vikaspal1704/live-orderbook-feed, here in the browser.)
 */
import type { Level, Side } from './types';

export interface TapeTrade {
  tradeId: number;
  ts: number;
  price: number;
  qty: number;
  aggressor: Side;
  /** True when the player was on either side (shown highlighted). */
  mine: boolean;
}

export interface Delta {
  type: 'delta';
  feedSeq: number;
  levels: { side: Side; price: number; qty: number; orders: number }[];
  trades: TapeTrade[];
}

export interface Snapshot {
  type: 'snapshot';
  feedSeq: number;
  bids: Level[];
  asks: Level[];
}

export type FeedStatus = 'live' | 'recovering';

export interface FeedStats {
  received: number;
  gaps: number;
  resyncs: number;
  ignoredStale: number;
}

/** Client-side L2 book built from the feed. */
export class FeedBook {
  readonly bids = new Map<number, Level>();
  readonly asks = new Map<number, Level>();
  status: FeedStatus = 'recovering';
  lastSeq = 0;
  stats: FeedStats = { received: 0, gaps: 0, resyncs: 0, ignoredStale: 0 };

  /**
   * Applies a delta. Returns 'gap' the first time a missing sequence is seen
   * (the caller should request a snapshot), otherwise 'ok' or 'ignored'.
   */
  applyDelta(d: Delta): 'ok' | 'gap' | 'ignored' {
    this.stats.received++;
    if (this.status === 'recovering' || d.feedSeq <= this.lastSeq) {
      if (d.feedSeq <= this.lastSeq) this.stats.ignoredStale++;
      return 'ignored';
    }
    if (d.feedSeq !== this.lastSeq + 1) {
      this.stats.gaps++;
      this.status = 'recovering';
      return 'gap';
    }
    for (const l of d.levels) {
      const side = l.side === 'BUY' ? this.bids : this.asks;
      if (l.qty === 0) side.delete(l.price);
      else side.set(l.price, { price: l.price, qty: l.qty, orders: l.orders });
    }
    this.lastSeq = d.feedSeq;
    return 'ok';
  }

  applySnapshot(s: Snapshot): void {
    if (this.status === 'live' && s.feedSeq <= this.lastSeq) return;
    this.bids.clear();
    this.asks.clear();
    for (const l of s.bids) this.bids.set(l.price, l);
    for (const l of s.asks) this.asks.set(l.price, l);
    if (this.lastSeq > 0) this.stats.resyncs++;
    this.lastSeq = s.feedSeq;
    this.status = 'live';
  }

  /** Best levels first. */
  depth(levels: number): { bids: Level[]; asks: Level[] } {
    const bids = [...this.bids.values()].sort((a, b) => b.price - a.price).slice(0, levels);
    const asks = [...this.asks.values()].sort((a, b) => a.price - b.price).slice(0, levels);
    return { bids, asks };
  }
}

/** Seeded generator for the chaos switch, so a dropped-packet run is reproducible. */
export class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 2 ** 32;
  }
}

/** Publisher side: numbers deltas and, when chaos is on, drops some of them. */
export class FeedPublisher {
  private seq = 0;
  dropRate = 0;
  dropped = 0;
  private readonly rng: Lcg;

  constructor(seed: number) {
    this.rng = new Lcg(seed);
  }

  get feedSeq(): number {
    return this.seq;
  }

  /** Returns the delta to send, or null if chaos "lost" it in transit. */
  publish(levels: Delta['levels'], trades: TapeTrade[]): Delta | null {
    if (levels.length === 0 && trades.length === 0) return null;
    this.seq++;
    const delta: Delta = { type: 'delta', feedSeq: this.seq, levels, trades };
    if (this.dropRate > 0 && this.rng.next() < this.dropRate) {
      this.dropped++;
      return null;
    }
    return delta;
  }
}
