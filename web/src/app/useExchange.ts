import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FeedBook, type TapeTrade } from '../core/feed';
import { Account } from '../core/session';
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
        case 'private':
          account.current.apply(msg.events, msg.fair);
          break;
        case 'status':
          setStatus(msg);
          break;
        case 'replay':
          setReplay(msg);
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
    (s: number) => {
      book.current = new FeedBook();
      account.current = new Account();
      tape.current = [];
      prices.current = [];
      setReplay(null);
      setEnded(null);
      send({ type: 'start', seed: s });
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
      speed: (stepsPerTick: number) => send({ type: 'speed', stepsPerTick }),
      chaos: (dropRate: number) => send({ type: 'chaos', dropRate }),
      replay: (upto: number) => send({ type: 'replay', upto }),
      end: () => send({ type: 'end' }),
      journal: () =>
        (worker.current as Worker & { requestJournal: () => Promise<Extract<FromExchange, { type: 'journal' }>> }).requestJournal(),
    }),
    [send, start],
  );

  return { book: book.current, account: account.current, tape: tape.current, prices: prices.current, status, replayView: replay, ended, seed, ...actions };
}

export type Exchange = ReturnType<typeof useExchange>;
