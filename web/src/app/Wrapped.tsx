import { Check, X } from '@phosphor-icons/react';
import { duration, money, price as fmtPrice, qty as fmtQty } from '../core/format';
import { LESSONS, nextSteps } from '../core/lessons';
import type { WrappedSummary } from '../core/session';
import { lessonFacts, Tip } from './Coach';
import type { Ended, Exchange } from './useExchange';

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** End of session: the result first, then what to try next, then the detail. */
export function Wrapped({
  ex,
  ended,
  previousNet,
  realMode = false,
  onRestart,
}: {
  ex: Exchange;
  ended: Ended;
  /** Net result of the previous session in this visit, if any. */
  previousNet: number | null;
  /** Bots followed real prices, so the seed alone doesn't reproduce the market. */
  realMode?: boolean;
  onRestart: (sameMarket: boolean, net: number) => void;
}) {
  const { bids, asks } = ex.book.depth(1);
  const mark = bids[0] && asks[0] ? Math.round((bids[0].price + asks[0].price) / 2) : (ex.prices.at(-1) ?? ended.fair);
  const w: WrappedSummary = ex.account.wrapped(mark, ended.nowMs);
  const c = w.charges;
  const facts = lessonFacts(ex);
  const lessonsDone = LESSONS.filter((l) => l.done(facts)).length;
  const steps = nextSteps(w);
  const delta = previousNet === null ? null : w.netPnl - previousNet;

  return (
    <main className="wrapped" aria-labelledby="wrapped-h">
      <div className="result">
        <div>
          <h1 id="wrapped-h">Session result after charges</h1>
          <p className={`big ${w.netPnl >= 0 ? 'up' : 'down'}`} data-testid="wrapped-net">
            {money(w.netPnl, { sign: true })}
          </p>
          <p>
            {money(w.grossPnl, { sign: true })} from closed trades, less {money(c.total)} in charges.
          </p>
          {w.openQty !== 0 && (
            <p className="muted">
              You ended with {fmtQty(Math.abs(w.openQty))} units {w.openQty > 0 ? 'long' : 'short'}, worth {money(Math.round(w.openPnl), { sign: true })} at the
              last mid. That is not counted above.
            </p>
          )}
          {delta !== null && (
            <p className={delta >= 0 ? 'up' : 'down'} data-testid="versus">
              {money(Math.abs(delta))} {delta >= 0 ? 'better' : 'worse'} than your last session ({money(previousNet!, { sign: true })}).
            </p>
          )}
          <p className="muted small">
            {duration(ended.nowMs)} of market time, {fmtQty(w.ordersSent)} orders, {fmtQty(w.fills)} fills. Lessons done: {lessonsDone} of {LESSONS.length}.
          </p>
        </div>
        <section className="next" aria-labelledby="next-h">
          <h2 id="next-h">Try this next</h2>
          <ol>
            {steps.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </section>
      </div>

      <dl className="figures">
        <div>
          <dt>Round trips won</dt>
          <dd>{w.roundTrips === 0 ? '0' : `${w.wins} of ${w.roundTrips}`}</dd>
        </div>
        <div>
          <dt>Best trip</dt>
          <dd className={w.best !== null && w.best >= 0 ? 'up' : 'down'}>{w.best === null ? 'None' : money(w.best, { sign: true })}</dd>
        </div>
        <div>
          <dt>
            Maker share
            <Tip label="maker share">The share of your volume that rested in the book and was hit by someone else. Makers earn the spread; takers pay it.</Tip>
          </dt>
          <dd>{w.makerShare === null ? 'None' : pct(w.makerShare)}</dd>
        </div>
        <div>
          <dt>
            Against fair value
            <Tip label="against fair value">
              The bots priced around a hidden fair value (₹{fmtPrice(ended.fair)} at the end). This adds up how far each of your fills was from it at the time: mostly the spread you crossed, plus timing.
            </Tip>
          </dt>
          <dd className={w.edgeVsFair >= 0 ? 'up' : 'down'}>{money(w.edgeVsFair, { sign: true })}</dd>
        </div>
        <div>
          <dt>Median wait</dt>
          <dd>{w.medianRestMs === null ? 'None' : duration(w.medianRestMs)}</dd>
        </div>
      </dl>

      <div className="lower">
        <section aria-labelledby="charges-h">
          <h2 id="charges-h">Charges</h2>
          <dl className="receipt">
            {(
              [
                ['Brokerage', c.brokerage],
                ['Securities transaction tax', c.stt],
                ['Exchange fees', c.exchange],
                ['GST', c.gst],
                ['Stamp duty', c.stamp],
                ['SEBI fees', c.sebi],
              ] as const
            ).map(([label, v]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{money(v)}</dd>
              </div>
            ))}
            <div className="sum">
              <dt>Total</dt>
              <dd>{money(c.total)}</dd>
            </div>
          </dl>
          {w.chargesPctOfGross !== null && w.chargesPctOfGross > 100 && (
            <p className="muted small">Charges were {Math.round(w.chargesPctOfGross / 100)} times your gross profit.</p>
          )}
        </section>
        <section className="audit" aria-labelledby="audit-h">
          <h2 id="audit-h">Audit trail</h2>
          <p>
            Your session is journal entries 1 to {fmtQty(ended.seq)}. Replayed from scratch, the exchange reached fingerprint{' '}
            <span className="mono">{ended.fingerprint}</span>.
          </p>
          <p className={`verify ${ended.verified ? 'ok' : 'bad'}`} data-testid="wrapped-verified">
            {ended.verified ? <Check size={16} weight="bold" aria-hidden="true" /> : <X size={16} weight="bold" aria-hidden="true" />}
            <span>{ended.verified ? 'Identical to the live session, event for event.' : 'The replay differs from the live session.'}</span>
          </p>
          <p className="muted small">
            {realMode
              ? 'The bots followed live NSE prices, so this market cannot be rebuilt from the seed. The journal still replays it exactly.'
              : `With seed ${ex.seed}, the bots repeat exactly the same moves until you trade differently.`}
          </p>
        </section>
      </div>

      <div className="actions">
        {realMode ? (
          <button type="button" className="primary" onClick={() => onRestart(false, w.netPnl)}>
            New session
          </button>
        ) : (
          <>
            <button type="button" className="primary" onClick={() => onRestart(true, w.netPnl)}>
              Replay this market
            </button>
            <button type="button" onClick={() => onRestart(false, w.netPnl)}>
              New market
            </button>
          </>
        )}
      </div>
    </main>
  );
}
