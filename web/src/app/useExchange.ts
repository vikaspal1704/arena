import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FeedBook, type TapeTrade } from '../core/feed';
import { Account, spreadPnl, type Fill } from '../core/session';
import { money, price as fmtPrice, qty as fmtQty } from '../core/format';
import type { JournalRow, Level, Side } from '../core/types';
import type { FromExchange, ToExchange } from '../worker/protocol';

export interface Status {
  seq: number;
  fingerprint: string;
  nowMs: number;
  paused: boolean;
  queue: Record<number, [number, number]>;
  feedSeq: number;
  dropped: number;
}

export interface ReplayView {
  upto: number;
  fingerprint: string;
  matches: boolean;
  bids: Level[];
  asks: Level[];
  rows: JournalRow[];
}

export interface Ended {
  fair: number;
  seq: number;
  fingerprint: string;
  nowMs: number;
  verified: boolean;
}

export interface CoachNote {
  id: number;
  tone: 'good' | 'bad' | 'info';
  text: string;
}

/** One sentence about a fill, in plain words. */
export function describeFill(f: Fill): CoachNote['text'] {
  const verb = f.side === 'BUY' ? 'Bought' : 'Sold';
  const what = `${verb} ${fmtQty(f.qty)} @ ${fmtPrice(f.price)}`;
  const pnl = spreadPnl(f);
  if (f.liquidity === 'TAKER') {
    return pnl === null ? `${what}: you crossed the spread.` : `${what}: crossing the spread cost ${money(Math.max(0, -pnl))} against the mid.`;
  }
  return pnl !== null && pnl > 0
    ? `${what}: your resting order was hit. You earned ${money(pnl)} against the mid.`
    : `${what}: your resting order was hit, so someone else paid the spread.`;
}

const NOTE_MS = 6000;
const MAX_NOTES = 3;

const TAPE = 40;
const PRICES = 240;

/**
 * Owns the exchange worker and the client-side state built from its two
 * channels. Mutable models (feed book, account) live in refs; a version
 * counter re-renders at most once per animation frame.
 */
export function useExchange() {
  const worker = useRef<Worker | null>(null);
  const book = useRef(new FeedBook());
  const account = useRef(new Account());
  const tape = useRef<TapeTrade[]>([]);
  const prices = useRef<number[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
  const [notes, setNotes] = useState<CoachNote[]>([]);
  const [replayVerified, setReplayVerified] = useState(false);
  const noteId = useRef(0);
  const [, setVersion] = useState(0);
  const frame = useRef(0);

  const render = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setVersion((v) => v + 1);
    });
  }, []);

  const send = useCallback((msg: ToExchange) => worker.current?.postMessage(msg), []);

  useEffect(() => {
    const w = new Worker(new URL('../worker/exchange.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    let journalWaiter: ((m: Extract<FromExchange, { type: 'journal' }>) => void) | null = null;
    w.onmessage = (e: MessageEvent<FromExchange>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          setSeed(msg.seed);
          break;
        case 'snapshot':
          book.current.applySnapshot(msg);
          break;
        case 'delta': {
          if (book.current.applyDelta(msg) === 'gap') w.postMessage({ type: 'resync' } satisfies ToExchange);
          // Trades arrive on the market-data feed, so a dropped packet loses them from the tape too.
          for (const t of msg.trades) {
            tape.current.unshift(t);
            prices.current.push(t.price);
          }
          tape.current.length = Math.min(tape.current.length, TAPE);
          if (prices.current.length > PRICES) prices.current.splice(0, prices.current.length - PRICES);
          break;
        }
        case 'private': {
          const before = account.current.fills.length;
          account.current.apply(msg.events, msg.fair, msg.mid);
          const fresh = account.current.fills.slice(before).map((f): CoachNote => {
            const pnl = spreadPnl(f);
            return { id: ++noteId.current, tone: pnl === null ? 'info' : pnl > 0 ? 'good' : 'bad', text: describeFill(f) };
          });
          if (msg.events.some((e) => e.kind === 'rejected')) {
            fresh.push({ id: ++noteId.current, tone: 'bad', text: 'Order rejected: check the price is on the ₹0.05 tick and the order is still live.' });
          }
          if (fresh.length) {
            setNotes((n) => [...n, ...fresh].slice(-MAX_NOTES));
            for (const note of fresh) setTimeout(() => setNotes((n) => n.filter((x) => x.id !== note.id)), NOTE_MS);
          }
          break;
        }
        case 'status':
          setStatus(msg);
          break;
        case 'replay':
          setReplay(msg);
          if (msg.matches) setReplayVerified(true);
          break;
        case 'journal':
          journalWaiter?.(msg);
          journalWaiter = null;
          break;
        case 'ended':
          setEnded(msg);
          break;
      }
      render();
    };
    (w as Worker & { requestJournal?: () => Promise<Extract<FromExchange, { type: 'journal' }>> }).requestJournal = () =>
      new Promise((resolve) => {
        journalWaiter = resolve;
        w.postMessage({ type: 'journal' } satisfies ToExchange);
      });
    return () => {
      w.terminate();
      cancelAnimationFrame(frame.current);
    };
  }, [render]);

  const start = useCallback(
    (s: number, instrument?: { tick: number; startPrice: number; lot: number }) => {
      book.current = new FeedBook();
      account.current = new Account();
      tape.current = [];
      prices.current = [];
      setReplay(null);
      setEnded(null);
      setNotes([]);
      send({ type: 'start', seed: s, instrument });
    },
    [send],
  );

  const actions = useMemo(
    () => ({
      start,
      limit: (side: Side, price: number, qty: number) => send({ type: 'limit', side, price, qty }),
      market: (side: Side, qty: number) => send({ type: 'market', side, qty }),
      cancel: (orderId: number) => send({ type: 'cancel', orderId }),
      pause: (paused: boolean) => {
        if (!paused) setReplay(null);
        send({ type: 'pause', paused });
      },
      speed: (speed: number) => send({ type: 'speed', speed }),
      chaos: (dropRate: number) => send({ type: 'chaos', dropRate }),
      dismissNote: (id: number) => setNotes((n) => n.filter((x) => x.id !== id)),
      anchor: (price: number) => send({ type: 'anchor', price }),
      replay: (upto: number) => send({ type: 'replay', upto }),
      end: () => send({ type: 'end' }),
      journal: () =>
        (worker.current as Worker & { requestJournal: () => Promise<Extract<FromExchange, { type: 'journal' }>> }).requestJournal(),
    }),
    [send, start],
  );

  return { book: book.current, account: account.current, tape: tape.current, prices: prices.current, status, replayView: replay, ended, seed, notes, replayVerified, ...actions };
}

export type Exchange = ReturnType<typeof useExchange>;
