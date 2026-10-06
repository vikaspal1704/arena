/**
 * The player's account, built only from their own exchange events: orders,
 * fills, position, FIFO P&L, charges, and the end-of-session "Wrapped"
 * numbers. Pure and deterministic, like everything in core/.
 */
import { chargesFor, type Charges } from './charges';
import { PLAYER, type ArenaEvent, type Side } from './types';

export type MyOrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'EXPIRED';

export interface MyOrder {
  orderId: number;
  side: Side;
  /** null for market orders. */
  price: number | null;
  qty: number;
  remaining: number;
  status: MyOrderStatus;
  acceptedTs: number;
  /** Σ fill price × qty. */
  filledValue: number;
}

export interface Fill {
  seq: number;
  ts: number;
  orderId: number;
  side: Side;
  price: number;
  qty: number;
  /** MAKER: your resting order was hit. TAKER: you crossed the spread. */
  liquidity: 'MAKER' | 'TAKER';
  /** The hidden fair value at the time (revealed in Wrapped). */
  fair: number;
  /** Mid price just before the command that caused the fill, or null if the book was one-sided. */
  mid: number | null;
}

export interface RoundTrip {
  side: 'LONG' | 'SHORT';
  openTs: number;
  closeTs: number;
  /** Largest absolute position during the trip. */
  maxQty: number;
  pnl: number;
}

interface Lot {
  qty: number;
  price: number;
}

export interface WrappedSummary {
  grossPnl: number;
  charges: Charges;
  netPnl: number;
  /** Open position at the end, marked at `mark` (not in net P&L). */
  openQty: number;
  openPnl: number;
  roundTrips: number;
  wins: number;
  winRate: number | null;
  best: number | null;
  worst: number | null;
  ordersSent: number;
  cancels: number;
  rejects: number;
  fills: number;
  /** Share of filled quantity that was passive (you provided liquidity). */
  makerShare: number | null;
  /** Σ (fair − price) × qty on buys and (price − fair) × qty on sells. Negative = you paid away edge. */
  edgeVsFair: number;
  /** Median time a passive order rested before its fill, ms. */
  medianRestMs: number | null;
  /** Charges as a share of gross profit, when there was a gross profit. */
  chargesPctOfGross: number | null;
  durationMs: number;
}

export class Account {
  readonly orders = new Map<number, MyOrder>();
  readonly fills: Fill[] = [];
  readonly roundTrips: RoundTrip[] = [];
  rejects = 0;
  cancels = 0;
  /** Signed position in units. */
  position = 0;
  realized = 0;
  private lots: Lot[] = [];
  private tripStart: { ts: number; side: 'LONG' | 'SHORT'; pnl: number; maxQty: number } | null = null;

  /**
   * Applies the player's events (others are ignored). `fair` is the fair value
   * right now; `mid` is the mid price just before the command, if known.
   */
  apply(events: readonly ArenaEvent[], fair: number, mid: number | null = null): void {
    for (const e of events) {
      switch (e.kind) {
        case 'accepted':
          if (e.owner === PLAYER) {
            this.orders.set(e.orderId, {
              orderId: e.orderId,
              side: e.side,
              price: e.market ? null : e.price,
              qty: e.qty,
              remaining: e.qty,
              status: 'OPEN',
              acceptedTs: e.ts,
              filledValue: 0,
            });
          }
          break;
        case 'rejected':
          if (e.owner === PLAYER) this.rejects++;
          break;
        case 'trade': {
          for (const [owner, orderId, liquidity] of [
            [e.makerOwner, e.makerOrderId, 'MAKER'],
            [e.takerOwner, e.takerOrderId, 'TAKER'],
          ] as const) {
            if (owner !== PLAYER) continue;
            const order = this.orders.get(orderId);
            if (!order) continue;
            order.remaining -= e.qty;
            order.filledValue += e.price * e.qty;
            order.status = order.remaining === 0 ? 'FILLED' : 'PARTIAL';
            this.fills.push({ seq: e.seq, ts: e.ts, orderId, side: order.side, price: e.price, qty: e.qty, liquidity, fair, mid });
            this.book(order.side, e.price, e.qty, e.ts);
          }
          break;
        }
        case 'done':
          if (e.owner === PLAYER) {
            const order = this.orders.get(e.orderId);
            if (order) {
              order.status = e.reason;
              if (e.reason === 'CANCELLED') this.cancels++;
            }
          }
          break;
        case 'level':
          break;
      }
    }
  }

  /** FIFO position keeping; a round trip runs from flat to flat. */
  private book(side: Side, price: number, qty: number, ts: number): void {
    const sign = side === 'BUY' ? 1 : -1;
    let left = qty;
    if (this.position === 0) {
      this.tripStart = { ts, side: side === 'BUY' ? 'LONG' : 'SHORT', pnl: 0, maxQty: 0 };
    }
    // Close against open lots of the opposite sign first.
    while (left > 0 && this.position !== 0 && Math.sign(this.position) !== sign) {
      const lot = this.lots[0]!;
      const q = Math.min(lot.qty, left);
      const pnl = (price - lot.price) * q * (this.position > 0 ? 1 : -1);
      this.realized += pnl;
      this.tripStart!.pnl += pnl;
      lot.qty -= q;
      left -= q;
      this.position += sign * q;
      if (lot.qty === 0) this.lots.shift();
      if (this.position === 0) {
        const t = this.tripStart!;
        this.roundTrips.push({ side: t.side, openTs: t.ts, closeTs: ts, maxQty: t.maxQty, pnl: t.pnl });
        this.tripStart = left > 0 ? { ts, side: side === 'BUY' ? 'LONG' : 'SHORT', pnl: 0, maxQty: 0 } : null;
      }
    }
    if (left > 0) {
      this.lots.push({ qty: left, price });
      this.position += sign * left;
    }
    if (this.tripStart) this.tripStart.maxQty = Math.max(this.tripStart.maxQty, Math.abs(this.position));
  }

  /** Average price of the open position, or null when flat. */
  avgOpenPrice(): number | null {
    const qty = this.lots.reduce((s, l) => s + l.qty, 0);
    return qty === 0 ? null : this.lots.reduce((s, l) => s + l.price * l.qty, 0) / qty;
  }

  /** P&L of the open position if closed at `mark`. */
  unrealized(mark: number): number {
    const dir = this.position > 0 ? 1 : -1;
    return this.lots.reduce((s, l) => s + (mark - l.price) * l.qty * dir, 0);
  }

  charges(): Charges {
    return chargesFor([...this.orders.values()].filter((o) => o.filledValue > 0).map((o) => ({ side: o.side, value: o.filledValue })));
  }

  liveOrders(): MyOrder[] {
    return [...this.orders.values()].filter((o) => o.status === 'OPEN' || o.status === 'PARTIAL');
  }

  wrapped(mark: number, durationMs: number): WrappedSummary {
    const charges = this.charges();
    const wins = this.roundTrips.filter((r) => r.pnl > 0).length;
    const filledQty = this.fills.reduce((s, f) => s + f.qty, 0);
    const makerQty = this.fills.filter((f) => f.liquidity === 'MAKER').reduce((s, f) => s + f.qty, 0);
    const rests = this.fills
      .filter((f) => f.liquidity === 'MAKER')
      .map((f) => f.ts - this.orders.get(f.orderId)!.acceptedTs)
      .sort((a, b) => a - b);
    const pnls = this.roundTrips.map((r) => r.pnl);
    return {
      grossPnl: this.realized,
      charges,
      netPnl: this.realized - charges.total,
      openQty: this.position,
      openPnl: this.unrealized(mark),
      roundTrips: this.roundTrips.length,
      wins,
      winRate: this.roundTrips.length ? wins / this.roundTrips.length : null,
      best: pnls.length ? Math.max(...pnls) : null,
      worst: pnls.length ? Math.min(...pnls) : null,
      ordersSent: this.orders.size + this.rejects,
      cancels: this.cancels,
      rejects: this.rejects,
      fills: this.fills.length,
      makerShare: filledQty ? makerQty / filledQty : null,
      edgeVsFair: this.fills.reduce((s, f) => s + (f.side === 'BUY' ? f.fair - f.price : f.price - f.fair) * f.qty, 0),
      medianRestMs: rests.length ? rests[Math.floor(rests.length / 2)]! : null,
      chargesPctOfGross: this.realized > 0 ? (charges.total / this.realized) * 100 : null,
      durationMs,
    };
  }
}

/**
 * What a fill cost or earned against the mid before it: positive = earned
 * (a passive fill inside the old mid), negative = paid (crossing the spread).
 */
export function spreadPnl(f: Fill): number | null {
  if (f.mid === null) return null;
  return Math.round((f.side === 'BUY' ? f.mid - f.price : f.price - f.mid) * f.qty);
}
