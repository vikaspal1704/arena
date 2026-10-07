/** Prices are integer paise; quantities are integer units. Never floats. */
export type Side = 'BUY' | 'SELL';

export const PLAYER = 0;
export const MARKET_MAKER = 1;
export const MOMENTUM = 2;

export type RejectReason = 'BAD_PRICE' | 'BAD_QTY' | 'UNKNOWN_ORDER' | 'NOT_CANCELLABLE' | 'NOT_OWNER';
export type DoneReason = 'FILLED' | 'CANCELLED' | 'EXPIRED';

interface Stamp {
  /** Journal sequence number of the command that caused this event. */
  seq: number;
  /** Exchange clock, ms since the session started. */
  ts: number;
}

export type ArenaEvent =
  | (Stamp & { kind: 'accepted'; orderId: number; owner: number; side: Side; price: number; qty: number; market: boolean })
  | (Stamp & { kind: 'rejected'; owner: number; reason: RejectReason })
  | (Stamp & {
      kind: 'trade';
      tradeId: number;
      price: number;
      qty: number;
      makerOrderId: number;
      takerOrderId: number;
      makerOwner: number;
      takerOwner: number;
      /** The taker's side. */
      aggressor: Side;
    })
  | (Stamp & { kind: 'done'; orderId: number; owner: number; reason: DoneReason; remaining: number })
  | (Stamp & { kind: 'level'; side: Side; price: number; qty: number; orders: number });

export interface Level {
  price: number;
  qty: number;
  orders: number;
}

export interface JournalRow {
  seq: number;
  ts: number;
  kind: 'LIMIT' | 'MARKET' | 'CANCEL';
  owner: number;
  side: Side | null;
  price: number | null;
  qty: number | null;
  orderId: number | null;
}

export interface InstrumentConfig {
  name: string;
  /** Price step in paise. */
  tick: number;
  /** Units per lot. */
  lot: number;
  /** Starting fair value in paise. */
  startPrice: number;
}

/**
 * The instrument being traded. Defaults mirror SimConfig::default in Rust; in
 * real-market mode the local bridge replaces them with the live contract's
 * (see setInstrument). Read it at render time, never cache it.
 */
export const INSTRUMENT: InstrumentConfig = {
  name: 'NIFTY FUT (simulated)',
  tick: 5,
  lot: 75,
  startPrice: 2_400_000,
};

export function setInstrument(next: InstrumentConfig): void {
  Object.assign(INSTRUMENT, next);
}

export function ownerName(owner: number): string {
  if (owner === PLAYER) return 'You';
  if (owner === MARKET_MAKER) return 'Market maker';
  if (owner === MOMENTUM) return 'Momentum bot';
  return `Noise trader ${owner - 9}`;
}
