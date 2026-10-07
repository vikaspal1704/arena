import { useEffect, useRef, useState } from 'react';

/** Arena is in real-market mode when served by the local bridge with ?real=1. */
export const REAL_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('real') === '1';

export interface RealLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface RealTick {
  seq: number;
  /** Last traded price, paise. */
  ltp: number;
  bids: RealLevel[];
  asks: RealLevel[];
  volume: number;
  /** Exchange time, ms; null if Kite didn't send one. */
  ts: number | null;
}

export interface RealHello {
  mode: 'kite' | 'mock';
  configured: boolean;
  loggedIn: boolean;
  instrument: { symbol: string; name: string; expiry: string | null; tickPaise: number; lot: number } | null;
  lastPrice: number | null;
  status: { state: string; message?: string };
}

export interface RealMarket {
  connection: 'connecting' | 'open' | 'closed';
  hello: RealHello | null;
  tick: RealTick | null;
  /** When the last tick arrived (browser clock), for "no ticks: market closed?". */
  receivedAt: number | null;
}

/**
 * Connects to the bridge's /feed (same origin). Reconnects if the bridge
 * restarts. Does nothing outside real-market mode.
 */
export function useRealMarket(onTick: (t: RealTick) => void): RealMarket {
  const [state, setState] = useState<RealMarket>({ connection: 'connecting', hello: null, tick: null, receivedAt: null });
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    if (!REAL_MODE) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer = 0;
    let closed = false;
    const connect = () => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/feed`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, connection: 'open' }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'hello') setState((s) => ({ ...s, hello: msg }));
        else if (msg.type === 'status') setState((s) => (s.hello ? { ...s, hello: { ...s.hello, status: msg.status } } : s));
        else if (msg.type === 'tick') {
          tickRef.current(msg);
          setState((s) => ({ ...s, tick: msg, receivedAt: Date.now() }));
        }
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connection: 'closed' }));
        if (!closed) timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return state;
}
