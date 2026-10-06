import { useEffect, useState } from 'react';
import { CaretDown, CaretUp, Pause, Play } from '@phosphor-icons/react';
import { INSTRUMENT, type Level, type Side } from '../core/types';
import { clock, money, price as fmtPrice, qty as fmtQty } from '../core/format';
import type { Exchange } from './useExchange';
import { Tip } from './Coach';

const LEVELS = 8;
/** The tape box shows exactly this many rows (fixed height). */
const TAPE_ROWS = 12;

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
  // Last trade, or the mid until the first trade happens.
  const last = ex.prices.at(-1) ?? (bids[0] && asks[0] ? Math.round((bids[0].price + asks[0].price) / 2 / INSTRUMENT.tick) * INSTRUMENT.tick : null);
  const first = ex.prices[0] ?? null;
  const change = last !== null && first !== null ? last - first : 0;
  const paused = ex.status?.paused ?? false;
  return (
    <header className="topbar">
      <h1 className="brand">Arena</h1>
      <div className="instrument">
        <span className="name">{INSTRUMENT.name}</span>
        <strong className="last" data-testid="last-price">
          {last === null ? '' : fmtPrice(last)}
        </strong>
        <span className={`change ${change >= 0 ? 'up' : 'down'}`}>
          {change !== 0 && (
            <>
              {change > 0 ? <CaretUp size={12} weight="bold" aria-label="up" /> : <CaretDown size={12} weight="bold" aria-label="down" />}
              {fmtPrice(Math.abs(change))}
            </>
          )}
        </span>
      </div>
      <Sparkline prices={ex.prices} />
      <dl className="quick">
        <div>
          <dt>
            Spread{' '}
            <Tip label="the spread">The gap between the best price to buy (ask) and the best price to sell (bid). Crossing it is the cost of trading now.</Tip>
          </dt>
          <dd>{bids[0] && asks[0] ? fmtPrice(asks[0].price - bids[0].price) : ''}</dd>
        </div>
        <div>
          <dt>Clock</dt>
          <dd data-testid="clock">{clock(ex.status?.nowMs ?? 0)}</dd>
        </div>
      </dl>
      <div className="controls">
        <button type="button" onClick={() => ex.pause(!paused)} aria-pressed={paused}>
          {paused ? <Play size={14} weight="fill" aria-hidden="true" /> : <Pause size={14} weight="fill" aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <label className="speed">
          <span className="sr-only">Market speed</span>
          <select defaultValue="0.5" onChange={(e) => ex.speed(Number(e.target.value))}>
            <option value="0.25">Slow</option>
            <option value="0.5">Calm</option>
            <option value="1">Normal</option>
            <option value="2">Fast</option>
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
  const w = 160;
  const h = 32;
  const pts = prices.map((p, i) => `${((i / (prices.length - 1)) * w).toFixed(1)},${(h - 2 - ((p - lo) / Math.max(hi - lo, 1)) * (h - 4)).toFixed(1)}`).join(' ');
  const up = prices.at(-1)! >= prices[0]!;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Last ${prices.length} trade prices`}>
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.25" />
    </svg>
  );
}

/** Always `n` slots, so the ladder never changes height and the spread row never moves. */
function slots(levels: Level[], n: number): (Level | null)[] {
  return Array.from({ length: n }, (_, i) => levels[i] ?? null);
}

export function Ladder({ ex, onPick }: { ex: Exchange; onPick: (side: Side, price: number) => void }) {
  const replay = ex.replayView;
  const live = ex.book.depth(LEVELS);
  const { bids, asks } = replay ? { bids: replay.bids.slice(0, LEVELS), asks: replay.asks.slice(0, LEVELS) } : live;
  const mine = myResting(ex);
  const max = Math.max(1, ...bids.map((l) => l.qty), ...asks.map((l) => l.qty));
  const recovering = ex.book.status !== 'live';
  const row = (side: Side, l: Level | null, slot: number) => {
    // Rows are keyed by slot, not price: the DOM stays put and only the numbers change.
    const key = `${side}${slot}`;
    if (!l) {
      return (
        <li key={key} className="row empty" aria-hidden="true">
          <span />
        </li>
      );
    }
    const my = replay ? 0 : (mine[side].get(l.price) ?? 0);
    return (
      <li key={key} className={`row ${side === 'BUY' ? 'bid' : 'ask'}${my ? ' mine' : ''}`}>
        <button
          type="button"
          onClick={() => onPick(side === 'BUY' ? 'SELL' : 'BUY', l.price)}
          aria-label={`${side === 'BUY' ? 'Sell' : 'Buy'} at ${fmtPrice(l.price)}, ${fmtQty(l.qty)} ${side === 'BUY' ? 'bid' : 'offered'}`}
        >
          <span className="bar" style={{ transform: `scaleX(${l.qty / max})` }} aria-hidden="true" />
          <span className="you">{my ? fmtQty(my) : ''}</span>
          <span className="px">{fmtPrice(l.price)}</span>
          {/* Keyed by value: a change remounts the cell, which plays a brief tint. */}
          <span className="sz flash" key={`${l.price}-${l.qty}`}>
            {fmtQty(l.qty)}
          </span>
          <span className="n">{l.orders}</span>
        </button>
      </li>
    );
  };
  return (
    <section className="pane ladder" aria-labelledby="book-h">
      <div className="pane-head">
        <h2 id="book-h">Order book</h2>
        <Tip label="the order book">
          Every resting order, grouped by price. Sellers (asks, red) above, buyers (bids, green) below. At each price, earlier orders fill first.
        </Tip>
        <span className={`pane-meta${replay ? '' : recovering ? ' warn' : ' live'}`} data-testid="book-status">
          {replay ? `Replay at #${replay.upto}` : recovering ? 'Recovering' : 'Live'}
        </span>
      </div>
      <div className="ladder-head" aria-hidden="true">
        <span>Yours</span>
        <span>Price</span>
        <span>Qty</span>
        <span>Orders</span>
      </div>
      <ol className="asks" aria-label="Asks (sellers), best last">
        {slots(asks, LEVELS)
          .map((l, i) => row('SELL', l, i))
          .reverse()}
      </ol>
      <div className="mid">
        <span>Spread</span>
        <span className="mono">{bids[0] && asks[0] ? fmtPrice(asks[0].price - bids[0].price) : 'one side empty'}</span>
      </div>
      <ol className="bids" aria-label="Bids (buyers), best first">
        {slots(bids, LEVELS).map((l, i) => row('BUY', l, i))}
      </ol>
      <p className="hint">Click a price to load it into the ticket.</p>
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
    <section className="pane ticket" aria-labelledby="ticket-h">
      <div className="pane-head">
        <h2 id="ticket-h">Order ticket</h2>
        <Tip label="limit and market orders">
          Limit: you set the worst price you accept, and if it can’t trade now it waits in the book. Market: trade now at whatever the book offers; anything left over expires.
        </Tip>
      </div>
      <div className="seg" role="group" aria-label="Side">
        <button type="button" className="buy" aria-pressed={side === 'BUY'} onClick={() => setSide('BUY')}>
          Buy
        </button>
        <button type="button" className="sell" aria-pressed={side === 'SELL'} onClick={() => setSide('SELL')}>
          Sell
        </button>
      </div>
      <div className="seg" role="group" aria-label="Order type">
        <button type="button" aria-pressed={kind === 'LIMIT'} onClick={() => setKind('LIMIT')}>
          Limit
        </button>
        <button type="button" aria-pressed={kind === 'MARKET'} onClick={() => setKind('MARKET')}>
          Market
        </button>
      </div>
      <label className="field">
        <span>Lots ({INSTRUMENT.lot} units each)</span>
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
      {kind === 'LIMIT' && (
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
      )}
      <button type="button" className={`submit ${side === 'BUY' ? 'buy' : 'sell'}`} onClick={submit} disabled={disabled}>
        {side === 'BUY' ? 'Buy' : 'Sell'} {fmtQty(qty)} {kind === 'MARKET' ? 'at market' : `@ ${fmtPrice(price)}`}
      </button>
      <p className="hint">
        {kind === 'MARKET'
          ? 'Trades now. You pay the spread, and any part that can’t fill expires.'
          : 'Waits behind earlier orders at the same price until someone trades with it.'}
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
    <section className="pane position" aria-labelledby="pos-h">
      <div className="pane-head">
        <h2 id="pos-h">Position</h2>
        <Tip label="charges">
          Real Indian index-futures charges: ₹20 brokerage per order, STT of 0.05% on every sale, exchange and SEBI fees, stamp duty on buys, and 18% GST.
        </Tip>
      </div>
      <dl className="stats">
        <div>
          <dt>Net quantity</dt>
          <dd data-testid="position" className={a.position > 0 ? 'up' : a.position < 0 ? 'down' : ''}>
            {a.position > 0 ? '+' : ''}
            {fmtQty(a.position)}
          </dd>
        </div>
        <div>
          <dt>Average price</dt>
          <dd>{avg === null ? 'Flat' : fmtPrice(Math.round(avg))}</dd>
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
          <dt>Net if closed at the mid</dt>
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
  const fills = ex.account.fills.slice(-8).reverse();
  const queue = ex.status?.queue ?? {};
  return (
    <section className="pane orders" aria-labelledby="orders-h">
      <div className="pane-head">
        <h2 id="orders-h">Your orders</h2>
        <Tip label="queue position">Resting orders wait in line at their price. “2 ahead” means two earlier orders must fill or cancel before yours can trade.</Tip>
      </div>
      <div className="box">
        {live.length === 0 ? (
          <p className="muted small">No resting orders. A limit order that doesn’t fill at once waits here.</p>
        ) : (
          <ul className="list">
            {live.map((o) => {
              const q = queue[o.orderId];
              return (
                <li key={o.orderId}>
                  <span className={o.side === 'BUY' ? 'up' : 'down'}>{o.side === 'BUY' ? 'Buy' : 'Sell'}</span>{' '}
                  <span className="mono">
                    {fmtQty(o.remaining)} @ {fmtPrice(o.price!)}
                  </span>{' '}
                  <span className="muted small">{q ? (q[0] === 0 ? 'front of queue' : `${q[0]} ahead (${fmtQty(q[1])})`) : ''}</span>{' '}
                  <button type="button" className="link" onClick={() => ex.cancel(o.orderId)} aria-label={`Cancel order ${o.orderId}`}>
                    Cancel
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="pane-head">
        <h3>Fills</h3>
        <Tip label="maker and taker">
          Taker: your order crossed the spread and traded at once. Maker: your resting order was hit by someone else, so they paid the spread.
        </Tip>
      </div>
      <div className="box">
        {fills.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <ul className="list small" data-testid="fills">
            {fills.map((f, i) => (
              <li key={`${f.seq}-${i}`}>
                <span className={f.side === 'BUY' ? 'up' : 'down'}>{f.side === 'BUY' ? 'Bought' : 'Sold'}</span>{' '}
                <span className="mono">
                  {fmtQty(f.qty)} @ {fmtPrice(f.price)}
                </span>{' '}
                <span className="tag">{f.liquidity === 'MAKER' ? 'maker' : 'taker'}</span>{' '}
                <span className="muted mono">#{f.seq}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function Tape({ ex }: { ex: Exchange }) {
  const rows = ex.tape.slice(0, TAPE_ROWS);
  return (
    <section className="pane tape" aria-labelledby="tape-h">
      <div className="pane-head">
        <h2 id="tape-h">Trades</h2>
      </div>
      <ol className="list tape-rows" aria-live="off">
        {rows.map((t) => (
          <li key={t.tradeId} className={`flash${t.mine ? ' mine' : ''}`}>
            <span className="muted">{clock(t.ts)}</span>
            <span className={t.aggressor === 'BUY' ? 'up' : 'down'}>{fmtPrice(t.price)}</span>
            <span>{fmtQty(t.qty)}</span>
            <span className="muted">{t.mine ? 'you' : ''}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
