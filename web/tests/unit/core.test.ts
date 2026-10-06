import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArenaCore } from '../../src/core/wasm';
import { FeedBook, FeedPublisher, type Delta } from '../../src/core/feed';
import { Account } from '../../src/core/session';
import { chargesFor } from '../../src/core/charges';
import type { ArenaEvent } from '../../src/core/types';

const wasm = readFileSync(new URL('../../public/arena.wasm', import.meta.url));
let core: ArenaCore;

beforeAll(async () => {
  core = await ArenaCore.load(wasm);
});

describe('engine in WebAssembly', () => {
  it('wasm_fingerprint_matches_native_build', () => {
    // Same seed and steps as `cargo run --example fingerprint -- 42 2000`; CI checks both.
    core.start(42);
    for (let i = 0; i < 2000; i++) core.step(100);
    expect(core.seq()).toBe(4181);
    expect(core.fingerprint()).toBe('8d44c209bd24be3e');
  });

  it('replay_verifies_every_prefix', () => {
    core.start(7);
    for (let i = 0; i < 300; i++) core.step(100);
    const seq = core.seq();
    for (const upto of [0, 1, Math.floor(seq / 2), seq]) {
      const r = core.replay(upto);
      expect(r.matches).toBe(true);
      expect(r.fingerprint).toBe(upto === 0 ? '0000000000000000' : core.fingerprint(upto));
    }
    expect(core.depth(10, true)).toEqual(core.depth(10));
  });

  it('player_orders_trade_and_the_journal_records_them', () => {
    core.start(3);
    for (let i = 0; i < 20; i++) core.step(100);
    const before = core.seq();
    const events = core.market('BUY', 75);
    expect(events.some((e) => e.kind === 'trade' && e.takerOwner === 0)).toBe(true);
    const [row] = core.journal(before + 1, before + 1);
    expect(row).toMatchObject({ seq: before + 1, kind: 'MARKET', owner: 0, side: 'BUY', qty: 75 });
  });

  it('shows_queue_position_of_a_resting_order', () => {
    core.start(5);
    const bestBid = core.depth(1).bids[0]!;
    const [accepted] = core.limit('BUY', bestBid.price, 75);
    expect(accepted!.kind).toBe('accepted');
    const id = (accepted as Extract<ArenaEvent, { kind: 'accepted' }>).orderId;
    expect(core.queueAhead(id)).toEqual({ orders: bestBid.orders, qty: bestBid.qty });
  });

  it('rejects_off_tick_prices', () => {
    core.start(1);
    expect(core.limit('BUY', 2_400_003, 75)).toEqual([expect.objectContaining({ kind: 'rejected', reason: 'BAD_PRICE' })]);
  });
});

describe('market-data feed', () => {
  const levelsOf = (events: ArenaEvent[]) =>
    events.flatMap((e) => (e.kind === 'level' ? [{ side: e.side, price: e.price, qty: e.qty, orders: e.orders }] : []));

  it('feed_detects_gaps_and_recovers_from_snapshots_under_packet_loss', () => {
    core.start(11);
    const pub = new FeedPublisher(99);
    pub.dropRate = 0.2;
    const client = new FeedBook();
    client.applySnapshot({ type: 'snapshot', feedSeq: 0, ...core.depth(1000) });
    for (let i = 0; i < 2000; i++) {
      const d = pub.publish(levelsOf(core.step(100)), []);
      if (d && client.applyDelta(d) === 'gap') {
        client.applySnapshot({ type: 'snapshot', feedSeq: pub.feedSeq, ...core.depth(1000) });
      }
    }
    // Catch up after the last delta, as a live client eventually does.
    if (client.lastSeq !== pub.feedSeq) client.applySnapshot({ type: 'snapshot', feedSeq: pub.feedSeq, ...core.depth(1000) });
    expect(pub.dropped).toBeGreaterThan(100);
    expect(client.stats.gaps).toBeGreaterThan(50);
    expect(client.depth(1000)).toEqual(core.depth(1000));
  });

  it('ignores_deltas_already_in_the_snapshot', () => {
    const client = new FeedBook();
    client.applySnapshot({ type: 'snapshot', feedSeq: 5, bids: [], asks: [] });
    const stale: Delta = { type: 'delta', feedSeq: 5, levels: [{ side: 'BUY', price: 100, qty: 1, orders: 1 }], trades: [] };
    expect(client.applyDelta(stale)).toBe('ignored');
    expect(client.applyDelta({ ...stale, feedSeq: 6 })).toBe('ok');
    expect(client.depth(5).bids).toEqual([{ price: 100, qty: 1, orders: 1 }]);
  });
});

describe('account', () => {
  const ev = (e: Partial<ArenaEvent> & { kind: ArenaEvent['kind'] }) => ({ seq: 1, ts: 0, ...e }) as ArenaEvent;
  const accept = (orderId: number, side: 'BUY' | 'SELL', price: number, qty: number, ts = 0) =>
    ev({ kind: 'accepted', orderId, owner: 0, side, price, qty, market: false, ts });
  const trade = (tradeId: number, price: number, qty: number, maker: [number, number], taker: [number, number], ts = 0) =>
    ev({ kind: 'trade', tradeId, price, qty, makerOwner: maker[0], makerOrderId: maker[1], takerOwner: taker[0], takerOrderId: taker[1], aggressor: 'BUY', ts });

  it('fifo_round_trips_and_flips', () => {
    const a = new Account();
    a.apply([accept(1, 'BUY', 10_000, 150), trade(1, 10_000, 150, [9, 50], [0, 1])], 10_000);
    a.apply([accept(2, 'SELL', 10_200, 225), trade(2, 10_200, 225, [9, 51], [0, 2])], 10_000);
    // Long 150 closed at +200 paise each, then short 75 opened.
    expect(a.roundTrips).toEqual([{ side: 'LONG', openTs: 0, closeTs: 0, maxQty: 150, pnl: 30_000 }]);
    expect(a.position).toBe(-75);
    expect(a.realized).toBe(30_000);
    expect(a.unrealized(10_100)).toBe(7_500);
  });

  it('wrapped_counts_maker_share_and_edge_vs_fair', () => {
    const a = new Account();
    a.apply([accept(1, 'BUY', 9_900, 75, 0)], 10_000);
    a.apply([trade(1, 9_900, 75, [0, 1], [9, 60], 4_000)], 10_000); // passive buy, 100 below fair
    a.apply([accept(2, 'SELL', 9_800, 75, 5_000), trade(2, 9_850, 75, [9, 61], [0, 2], 5_000)], 10_000); // crossed, 150 below fair
    const w = a.wrapped(9_850, 60_000);
    expect(w.makerShare).toBe(0.5);
    expect(w.edgeVsFair).toBe(75 * 100 - 75 * 150);
    expect(w.medianRestMs).toBe(4_000);
    expect(w.grossPnl).toBe(-50 * 75);
    expect(w.winRate).toBe(0);
  });
});

describe('charges', () => {
  it('index_futures_round_trip_charges', () => {
    // Buy and sell 75 NIFTY futures at ₹24,000 (₹18 lakh each side).
    const c = chargesFor([
      { side: 'BUY', value: 180_000_000 },
      { side: 'SELL', value: 180_000_000 },
    ]);
    expect(c).toEqual({
      brokerage: 4_000, // 2 × ₹20 (0.03% would be ₹540)
      stt: 90_000, // 0.05% of ₹18 lakh
      exchange: 6_228, // ₹1.73 per lakh of ₹36 lakh
      sebi: 360, // ₹10 per crore
      stamp: 3_600, // 0.002% of ₹18 lakh
      gst: 1_906, // 18% of (4,000 + 6,228 + 360)
      total: 106_094,
    });
  });
});
