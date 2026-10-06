import { useEffect, useState } from 'react';
import { INSTRUMENT, type Level, type Side } from '../core/types';
import { clock, money, price as fmtPrice, qty as fmtQty } from '../core/format';
import type { Exchange } from './useExchange';

const LEVELS = 8;

/** Prices the player has resting, per side: price → qty. */
function myResting(ex: Exchange): { BUY: Map<number, number>; SELL: Map<number, number> } {
  const out = { BUY: new Map<number, number>(), SELL: new Map<number, number>() };
  for (const o of ex.account.liveOrders()) {
    if (o.price === null) continue;
    out[o.side].set(o.price, (out[o.side].get(o.price) ?? 0) + o.remaining);
  }
  return out;
}

export function Header({ ex, onEnd }: { ex: Exchange; onEnd: () => void }) {
  const { bids, asks } = ex.book.depth(1);
  const last = ex.prices.at(-1) ?? null;
  const first = ex.prices[0] ?? null;
  const change = last !== null && first !== null ? last - first : 0;
  const paused = ex.status?.paused ?? false;
  return (
    <header className="topbar">
      <h1 className="brand">
        <span className="logo" aria-hidden="true">◆</span> Arena
      </h1>
      <div className="instrument">
        <span className="muted">{INSTRUMENT.name}</span>
        <strong className="last" data-testid="last-price">{last === null ? '—' : fmtPrice(last)}</strong>
        <span className={change >= 0 ? 'up' : 'down'}>{change === 0 ? '' : `${change > 0 ? '▲' : '▼'} ${fmtPrice(Math.abs(change))}`}</span>
      </div>
      <Sparkline prices={ex.prices} />
      <dl className="quick">
        <div>
          <dt>Spread</dt>
          <dd>{bids[0] && asks[0] ? fmtPrice(asks[0].price - bids[0].price) : '—'}</dd>
        </div>
        <div>
          <dt>Clock</dt>
          <dd data-testid="clock">{clock(ex.status?.nowMs ?? 0)}</dd>
        </div>
      </dl>
      <div className="controls">
        <button type="button" onClick={() => ex.pause(!paused)} aria-pressed={paused}>
          <span aria-hidden="true">{paused ? '▶' : '❚❚'}</span> {paused ? 'Resume' : 'Pause'}
        </button>
        <label className="speed">
          <span className="sr-only">Speed</span>
          <select defaultValue="1" onChange={(e) => ex.speed(Number(e.target.value))}>
            <option value="1">1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
          </select>
        </label>
        <button type="button" className="primary" onClick={onEnd}>
          End session
        </button>
      </div>
    </header>
  );
}

function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) return <div className="spark" aria-hidden="true" />;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const w = 220;
  const h = 40;
  const pts = prices.map((p, i) => `${((i / (prices.length - 1)) * w).toFixed(1)},${(h - 2 - ((p - lo) / Math.max(hi - lo, 1)) * (h - 4)).toFixed(1)}`).join(' ');
  const up = prices.at(-1)! >= prices[0]!;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Last ${prices.length} trade prices`}>
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" />
    </svg>
  );
}

export function Ladder({ ex, onPick }: { ex: Exchange; onPick: (side: Side, price: number) => void }) {
  const replay = ex.replayView;
  const live = ex.book.depth(LEVELS);
  const { bids, asks } = replay ? { bids: replay.bids.slice(0, LEVELS), asks: replay.asks.slice(0, LEVELS) } : live;
  const mine = myResting(ex);
  const max = Math.max(1, ...bids.map((l) => l.qty), ...asks.map((l) => l.qty));
  const row = (side: Side, l: Level) => {
    const my = replay ? 0 : (mine[side].get(l.price) ?? 0);
    return (
      <li key={`${side}${l.price}`} className={`row ${side === 'BUY' ? 'bid' : 'ask'}${my ? ' mine' : ''}`}>
        <button type="button" onClick={() => onPick(side === 'BUY' ? 'SELL' : 'BUY', l.price)} title={`${side === 'BUY' ? 'Sell' : 'Buy'} at ${fmtPrice(l.price)}`}>
          <span className="bar" style={{ width: `${(l.qty / max) * 100}%` }} aria-hidden="true" />
          <span className="you">{my ? `● ${fmtQty(my)}` : ''}</span>
          <span className="px">{fmtPrice(l.price)}</span>
          <span className="sz">{fmtQty(l.qty)}</span>
          <span className="n">{l.orders}</span>
        </button>
      </li>
    );
  };
  return (
    <section className="panel ladder" aria-labelledby="book-h">
      <h2 id="book-h">
        Order book <span className="muted">{replay ? `· replay at #${replay.upto}` : `· L2, ${ex.book.status === 'live' ? 'live' : 'recovering…'}`}</span>
      </h2>
      <div className="ladder-head" aria-hidden="true">
        <span>You</span>
        <span>Price</span>
        <span>Qty</span>
        <span>Orders</span>
      </div>
      <ol className="asks" aria-label="Asks (sellers), best last">
        {[...asks].reverse().map((l) => row('SELL', l))}
      </ol>
      <div className="mid">
        {bids[0] && asks[0] ? (
          <>
            spread <strong>{fmtPrice(asks[0].price - bids[0].price)}</strong>
          </>
        ) : (
          'one-sided'
        )}
      </div>
      <ol className="bids" aria-label="Bids (buyers), best first">
        {bids.map((l) => row('BUY', l))}
      </ol>
      <p className="hint">Tap a price to load it into the ticket.</p>
    </section>
  );
}

export function Ticket({ ex, picked }: { ex: Exchange; picked: { side: Side; price: number; n: number } | null }) {
  const [side, setSide] = useState<Side>('BUY');
  const [kind, setKind] = useState<'LIMIT' | 'MARKET'>('LIMIT');
  const [lots, setLots] = useState(1);
  const [px, setPx] = useState<number | null>(null);
  const { bids, asks } = ex.book.depth(1);
  const disabled = ex.status?.paused ?? true;

  useEffect(() => {
    if (picked) {
      setSide(picked.side);
      setKind('LIMIT');
      setPx(picked.price);
    }
  }, [picked]);

  // Default: join your side of the book.
  const price = px ?? (side === 'BUY' ? bids[0]?.price : asks[0]?.price) ?? INSTRUMENT.startPrice;
  const qty = lots * INSTRUMENT.lot;
  const nudge = (ticks: number) => setPx(Math.max(INSTRUMENT.tick, price + ticks * INSTRUMENT.tick));
  const submit = () => {
    if (kind === 'MARKET') ex.market(side, qty);
    else ex.limit(side, price, qty);
  };
  return (
    <section className="panel ticket" aria-labelledby="ticket-h">
      <h2 id="ticket-h">Order ticket</h2>
      <div className="seg" role="group" aria-label="Side">
        <button type="button" className={side === 'BUY' ? 'on buy' : ''} aria-pressed={side === 'BUY'} onClick={() => setSide('BUY')}>
          Buy
        </button>
        <button type="button" className={side === 'SELL' ? 'on sell' : ''} aria-pressed={side === 'SELL'} onClick={() => setSide('SELL')}>
          Sell
        </button>
      </div>
      <div className="seg small" role="group" aria-label="Order type">
        <button type="button" className={kind === 'LIMIT' ? 'on' : ''} aria-pressed={kind === 'LIMIT'} onClick={() => setKind('LIMIT')}>
          Limit
        </button>
        <button type="button" className={kind === 'MARKET' ? 'on' : ''} aria-pressed={kind === 'MARKET'} onClick={() => setKind('MARKET')}>
          Market
        </button>
      </div>
      <label className="field">
        <span>Lots ({INSTRUMENT.lot} each)</span>
        <span className="stepper">
          <button type="button" aria-label="Fewer lots" onClick={() => setLots((n) => Math.max(1, n - 1))}>
            −
          </button>
          <output aria-live="polite">{lots}</output>
          <button type="button" aria-label="More lots" onClick={() => setLots((n) => Math.min(20, n + 1))}>
            +
          </button>
        </span>
      </label>
      {kind === 'LIMIT' && (
        <label className="field">
          <span>Limit price (₹, tick 0.05)</span>
          <span className="stepper">
            <button type="button" aria-label="Lower price" onClick={() => nudge(-1)}>
              −
            </button>
            <output data-testid="ticket-price">{fmtPrice(price)}</output>
            <button type="button" aria-label="Higher price" onClick={() => nudge(1)}>
              +
            </button>
          </span>
        </label>
      )}
      <div className="quickpx">
        <button type="button" onClick={() => setPx(bids[0]?.price ?? null)}>
          Bid
        </button>
        <button type="button" onClick={() => setPx(asks[0]?.price ?? null)}>
          Ask
        </button>
        <button type="button" onClick={() => setPx(null)}>
          Join
        </button>
      </div>
      <button type="button" className={`submit ${side === 'BUY' ? 'buy' : 'sell'}`} onClick={submit} disabled={disabled}>
        {side === 'BUY' ? 'Buy' : 'Sell'} {fmtQty(qty)} {kind === 'MARKET' ? 'at market' : `@ ${fmtPrice(price)}`}
      </button>
      <p className="hint">
        {kind === 'MARKET'
          ? 'Takes liquidity now: you pay the spread, and whatever can’t fill expires.'
          : 'Rests in the queue behind earlier orders at the same price (price-time priority).'}
      </p>
    </section>
  );
}

export function PositionPanel({ ex }: { ex: Exchange }) {
  const a = ex.account;
  const { bids, asks } = ex.book.depth(1);
  const mark = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : (ex.prices.at(-1) ?? 0);
  const charges = a.charges();
  const unreal = a.unrealized(mark);
  const net = a.realized + unreal - charges.total;
  const avg = a.avgOpenPrice();
  return (
    <section className="panel position" aria-labelledby="pos-h">
      <h2 id="pos-h">Position</h2>
      <dl className="stats">
        <div>
          <dt>Net qty</dt>
          <dd data-testid="position" className={a.position > 0 ? 'up' : a.position < 0 ? 'down' : ''}>
            {a.position > 0 ? '+' : ''}
            {fmtQty(a.position)}
          </dd>
        </div>
        <div>
          <dt>Avg price</dt>
          <dd>{avg === null ? '—' : fmtPrice(Math.round(avg))}</dd>
        </div>
        <div>
          <dt>Realised</dt>
          <dd className={a.realized >= 0 ? 'up' : 'down'}>{money(a.realized, { sign: true })}</dd>
        </div>
        <div>
          <dt>Open P&amp;L</dt>
          <dd className={unreal >= 0 ? 'up' : 'down'}>{money(Math.round(unreal), { sign: true })}</dd>
        </div>
        <div>
          <dt>Charges</dt>
          <dd className="down">{money(-charges.total)}</dd>
        </div>
        <div className="total">
          <dt>Net, if closed at mid</dt>
          <dd data-testid="net" className={net >= 0 ? 'up' : 'down'}>
            {money(Math.round(net), { sign: true })}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function MyOrders({ ex }: { ex: Exchange }) {
  const live = ex.account.liveOrders();
  const fills = ex.account.fills.slice(-6).reverse();
  const queue = ex.status?.queue ?? {};
  return (
    <section className="panel orders" aria-labelledby="orders-h">
      <h2 id="orders-h">Your orders</h2>
      {live.length === 0 ? (
        <p className="muted small">No resting orders.</p>
      ) : (
        <ul className="list">
          {live.map((o) => {
            const q = queue[o.orderId];
            return (
              <li key={o.orderId}>
                <span className={o.side === 'BUY' ? 'up' : 'down'}>{o.side === 'BUY' ? 'Buy' : 'Sell'}</span> {fmtQty(o.remaining)} @ {fmtPrice(o.price!)}
                <span className="muted small">{q ? (q[0] === 0 ? ' · front of queue' : ` · ${q[0]} ahead (${fmtQty(q[1])})`) : ''}</span>
                <button type="button" className="link" onClick={() => ex.cancel(o.orderId)} aria-label={`Cancel order ${o.orderId}`}>
                  Cancel
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <h3>Fills</h3>
      {fills.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="list small" data-testid="fills">
          {fills.map((f, i) => (
            <li key={`${f.seq}-${i}`}>
              <span className={f.side === 'BUY' ? 'up' : 'down'}>{f.side === 'BUY' ? 'Bought' : 'Sold'}</span> {fmtQty(f.qty)} @ {fmtPrice(f.price)}{' '}
              <span className="tag">{f.liquidity === 'MAKER' ? 'maker' : 'taker'}</span> <span className="muted">#{f.seq}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Tape({ ex }: { ex: Exchange }) {
  const rows = ex.tape.slice(0, 18);
  return (
    <section className="panel tape" aria-labelledby="tape-h">
      <h2 id="tape-h">Trades</h2>
      <ol className="list mono small" aria-live="off">
        {rows.map((t) => (
          <li key={t.tradeId} className={t.mine ? 'mine' : ''}>
            <span className="muted">{clock(t.ts)}</span>
            <span className={t.aggressor === 'BUY' ? 'up' : 'down'}>{fmtPrice(t.price)}</span>
            <span>{fmtQty(t.qty)}</span>
            {t.mine && <span className="tag">you</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
