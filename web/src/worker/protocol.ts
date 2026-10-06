import type { Delta, Snapshot } from '../core/feed';
import type { ArenaEvent, JournalRow, Level, Side } from '../core/types';

/** UI → exchange worker. */
export type ToExchange =
  | { type: 'start'; seed: number }
  | { type: 'limit'; side: Side; price: number; qty: number }
  | { type: 'market'; side: Side; qty: number }
  | { type: 'cancel'; orderId: number }
  | { type: 'pause'; paused: boolean }
  /** Market steps per real 100 ms (0.5 = half speed). */
  | { type: 'speed'; speed: number }
  | { type: 'chaos'; dropRate: number }
  | { type: 'resync' }
  | { type: 'replay'; upto: number }
  | { type: 'journal' }
  | { type: 'end' };

/** Exchange worker → UI. Market data (delta/snapshot) and private events are separate channels. */
export type FromExchange =
  | { type: 'ready'; seed: number }
  | Delta
  | Snapshot
  /** The player's own order events. Reliable: never dropped by chaos mode. */
  | { type: 'private'; events: ArenaEvent[]; fair: number; mid: number | null }
  | {
      type: 'status';
      seq: number;
      fingerprint: string;
      nowMs: number;
      paused: boolean;
      /** Your resting orders: order id → [orders ahead, qty ahead]. */
      queue: Record<number, [number, number]>;
      feedSeq: number;
      dropped: number;
    }
  | {
      type: 'replay';
      upto: number;
      fingerprint: string;
      /** The replay's fingerprint equals the one recorded live at that point. */
      matches: boolean;
      bids: Level[];
      asks: Level[];
      rows: JournalRow[];
    }
  | { type: 'journal'; seed: number; rows: JournalRow[]; fingerprint: string }
  | { type: 'ended'; fair: number; seq: number; fingerprint: string; nowMs: number; verified: boolean };
