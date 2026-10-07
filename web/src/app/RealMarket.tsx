import { useEffect, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { price as fmtPrice, qty as fmtQty } from '../core/format';
import { REPO } from './Intro';
import type { RealMarket } from './useRealMarket';

const STALE_MS = 15_000;

/** Exchange time as HH:MM:SS in India. */
function istTime(ms: number): string {
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 19);
}

/** The real NSE order book, read-only, next to the simulated one. */
export function RealBook({ real }: { real: RealMarket }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const t = real.tick;
  const stale = real.receivedAt === null || now - real.receivedAt > STALE_MS;
  const rows = (side: 'bids' | 'asks') =>
    Array.from({ length: 5 }, (_, i) => t?.[side][i] ?? null).map((l, i) => (
      <li key={`${side}${i}`} className={side === 'bids' ? 'bid' : 'ask'}>
        <span className="px">{l ? fmtPrice(l.price) : ''}</span>
        <span className="sz">{l ? fmtQty(l.qty) : ''}</span>
        <span className="n">{l ? l.orders : ''}</span>
      </li>
    ));
  return (
    <section className="pane realbook" aria-labelledby="real-h" data-testid="real-book">
      <div className="pane-head">
        <h2 id="real-h">NSE order book</h2>
        <span className={`pane-meta${stale ? '' : ' live'}`}>{stale ? 'No recent ticks' : t?.ts ? istTime(t.ts) : 'Live'}</span>
      </div>
      <div className="realbook-cols">
        <ol className="list" aria-label="Real bids">
          {rows('bids')}
        </ol>
        <ol className="list" aria-label="Real asks">
          {rows('asks')}
        </ol>
      </div>
      <p className="hint">
        {stale
          ? 'Outside market hours the bots trade around the last real price.'
          : `Last ${t ? fmtPrice(t.ltp) : ''}. Bots in Arena quote around the real price; your orders never reach the exchange.`}
      </p>
    </section>
  );
}

/** Shown instead of the desk until the bridge has a Kite session. */
export function RealSetup({ real }: { real: RealMarket }) {
  const h = real.hello;
  let body;
  if (real.connection !== 'open' || !h) {
    body = <p>Connecting to the local bridge. Is it running? Start it with <code>npm start</code> in <code>bridge/</code>.</p>;
  } else if (!h.configured) {
    body = (
      <>
        <p>The bridge is running but has no Kite Connect credentials.</p>
        <ol>
          <li>
            Put <code>KITE_API_KEY</code> and <code>KITE_API_SECRET</code> in <code>bridge/.env</code> (it is gitignored).
          </li>
          <li>
            In your Kite Connect app, set the redirect URL to <code>{location.origin}/kite/callback</code>.
          </li>
          <li>Restart the bridge and reload this page.</li>
        </ol>
      </>
    );
  } else {
    body = (
      <>
        <p>Log in with Kite once a day. The bridge keeps the session on this computer; your API secret never reaches the browser.</p>
        <div className="actions">
          <a className="button primary" href="/kite/login">
            Log in with Kite
          </a>
        </div>
      </>
    );
  }
  return (
    <main className="realsetup" aria-labelledby="realsetup-h">
      <h1 id="realsetup-h">Real-market mode</h1>
      {h?.status.state === 'error' && (
        <p className="verify bad" role="alert">
          <WarningCircle size={16} weight="bold" aria-hidden="true" />
          <span>{h.status.message}</span>
        </p>
      )}
      {body}
      <p className="muted small">
        Setup guide: <a href={`${REPO}/blob/main/docs/REAL_MARKET.md`}>docs/REAL_MARKET.md</a>
      </p>
    </main>
  );
}
