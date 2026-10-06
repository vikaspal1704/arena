import { duration, money, price as fmtPrice, qty as fmtQty } from '../core/format';
import type { WrappedSummary } from '../core/session';
import { LESSONS, nextSteps } from '../core/lessons';
import { lessonFacts } from './Coach';
import type { Ended, Exchange } from './useExchange';

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** End of session: the player's trading, Wrapped (after vikaspal1704/fo-wrapped). */
export function Wrapped({
  ex,
  ended,
  previousNet,
  onRestart,
}: {
  ex: Exchange;
  ended: Ended;
  /** Net P&L of the previous session in this visit, if any. */
  previousNet: number | null;
  onRestart: (sameMarket: boolean, net: number) => void;
}) {
  const { bids, asks } = ex.book.depth(1);
  const mark = bids[0] && asks[0] ? Math.round((bids[0].price + asks[0].price) / 2) : (ex.prices.at(-1) ?? ended.fair);
  const w: WrappedSummary = ex.account.wrapped(mark, ended.nowMs);
  const c = w.charges;
  const noTrades = w.fills === 0;
  const facts = lessonFacts(ex);
  const lessonsDone = LESSONS.filter((l) => l.done(facts)).length;
  const steps = nextSteps(w);
  return (
    <main className="wrapped" aria-labelledby="wrapped-h">
      <p className="eyebrow">Your session, Wrapped</p>
      <h1 id="wrapped-h">
        {noTrades ? 'You watched the market. Fair.' : w.netPnl >= 0 ? 'You left with more than you brought.' : 'The market charged you for the lesson.'}
      </h1>
      <p className="muted">
        {duration(ended.nowMs)} of market time · {fmtQty(w.ordersSent)} orders · {fmtQty(w.fills)} fills · lessons {lessonsDone}/{LESSONS.length}
      </p>
      {previousNet !== null && (
        <p className={`versus ${w.netPnl >= previousNet ? 'up' : 'down'}`} data-testid="versus">
          {w.netPnl >= previousNet ? '▲' : '▼'} {money(Math.abs(w.netPnl - previousNet))} {w.netPnl >= previousNet ? 'better' : 'worse'} than your last session (
          {money(previousNet, { sign: true })})
        </p>
      )}

      <section className="next" aria-labelledby="next-h">
        <h2 id="next-h">Try this next</h2>
        <ol>
          {steps.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
      </section>

      <div className="cards">
        <article className="card">
          <h2>The number</h2>
          <p className={`big ${w.netPnl >= 0 ? 'up' : 'down'}`} data-testid="wrapped-net">
            {money(w.netPnl, { sign: true })}
          </p>
          <p className="small">
            {money(w.grossPnl, { sign: true })} from closed trades, minus {money(c.total)} in charges.
          </p>
          {w.openQty !== 0 && (
            <p className="small muted">
              Still open: {fmtQty(w.openQty)} units, worth {money(Math.round(w.openPnl), { sign: true })} at the last mid (not counted).
            </p>
          )}
        </article>

        <article className="card">
          <h2>Where the money went</h2>
          <ul className="breakdown small">
            <li>Brokerage {money(c.brokerage)}</li>
            <li>STT {money(c.stt)}</li>
            <li>Exchange {money(c.exchange)}</li>
            <li>GST {money(c.gst)}</li>
            <li>Stamp duty {money(c.stamp)}</li>
            <li>SEBI {money(c.sebi)}</li>
          </ul>
          <p className="small">
            {w.chargesPctOfGross === null
              ? 'Real Indian index-futures charges (2026 rates), the same table F&O Wrapped uses.'
              : w.chargesPctOfGross > 100
                ? `Charges were ${(w.chargesPctOfGross / 100).toFixed(w.chargesPctOfGross >= 1000 ? 0 : 1)}× your gross profit. STT alone is 0.05% of every sale.`
                : `Charges took ${Math.round(w.chargesPctOfGross)}% of your gross profit.`}
          </p>
        </article>

        <article className="card">
          <h2>Right but broke?</h2>
          {w.roundTrips === 0 ? (
            <p className="small">No round trips closed: a trade counts once your position goes back to flat.</p>
          ) : (
            <>
              <p className="big">{pct(w.winRate!)}</p>
              <p className="small">
                of {w.roundTrips} round trip{w.roundTrips === 1 ? '' : 's'} won. Best {money(w.best!, { sign: true })}, worst {money(w.worst!, { sign: true })}.
              </p>
            </>
          )}
        </article>

        <article className="card">
          <h2>Against fair value</h2>
          <p className={`big ${w.edgeVsFair >= 0 ? 'up' : 'down'}`}>{money(w.edgeVsFair, { sign: true })}</p>
          <p className="small">
            The bots priced around a hidden fair value; at the end it was ₹{fmtPrice(ended.fair)}. Compared with it at the moment of each fill, this is what
            your entries and exits gained or gave away: mostly the spread you crossed, and how well you timed it.
          </p>
        </article>

        <article className="card">
          <h2>Maker or taker</h2>
          {w.makerShare === null ? (
            <p className="small">No fills yet.</p>
          ) : (
            <>
              <p className="big">{pct(w.makerShare)}</p>
              <p className="small">
                of your volume rested in the book and was hit (you earned the spread); the rest crossed it.
                {w.medianRestMs !== null && ` Your passive orders waited ${duration(w.medianRestMs)} (median) in the queue.`}
              </p>
            </>
          )}
        </article>

        <article className="card audit">
          <h2>Audit trail</h2>
          <p className="small">
            Your session is journal entries 1 to {fmtQty(ended.seq)}. Replayed from scratch, the exchange reached fingerprint{' '}
            <span className="mono">{ended.fingerprint}</span>:
          </p>
          <p className={`verify ${ended.verified ? 'ok' : 'bad'}`} data-testid="wrapped-verified">
            {ended.verified ? '✓ identical to the live session, event for event' : '✕ replay differs'}
          </p>
          <p className="small muted">Seed {ex.seed}: the bots will make exactly the same moves again, until you trade differently.</p>
        </article>
      </div>

      <div className="actions">
        <button type="button" className="primary" onClick={() => onRestart(true, w.netPnl)}>
          Replay this market (seed {ex.seed})
        </button>
        <button type="button" onClick={() => onRestart(false, w.netPnl)}>
          New market
        </button>
      </div>
    </main>
  );
}
