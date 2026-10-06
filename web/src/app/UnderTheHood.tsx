import { useEffect, useRef, useState } from 'react';
import { clock, price as fmtPrice, qty as fmtQty } from '../core/format';
import { ownerName, type JournalRow } from '../core/types';
import type { Exchange } from './useExchange';

/** The parts of the system a reviewer wants to poke at. */
export function UnderTheHood({ ex }: { ex: Exchange }) {
  return (
    <section className="hood" aria-labelledby="hood-h">
      <h2 id="hood-h" className="section-title">
        Under the hood
      </h2>
      <div className="hood-grid">
        <FeedPanel ex={ex} />
        <JournalPanel ex={ex} />
        <BenchPanel />
      </div>
    </section>
  );
}

function FeedPanel({ ex }: { ex: Exchange }) {
  const [drop, setDrop] = useState(0);
  const s = ex.book.stats;
  const recovering = ex.book.status === 'recovering';
  return (
    <section className="panel" aria-labelledby="feed-h">
      <h3 id="feed-h">Market-data feed</h3>
      <p className="small muted">
        The book you see is rebuilt from a sequenced stream of deltas. A gap in the sequence means a lost packet: the client stops trusting its book, asks
        for a snapshot and carries on.
      </p>
      <label className="field">
        <span>
          Chaos: drop <strong>{Math.round(drop * 100)}%</strong> of packets
        </span>
        <input
          type="range"
          min={0}
          max={0.3}
          step={0.05}
          value={drop}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDrop(v);
            ex.chaos(v);
          }}
          aria-label="Packet drop rate"
        />
      </label>
      <dl className="stats compact" data-testid="feed-stats">
        <div>
          <dt>Status</dt>
          <dd className={recovering ? 'down' : 'up'}>{recovering ? 'RECOVERING' : 'LIVE'}</dd>
        </div>
        <div>
          <dt>Feed seq</dt>
          <dd>{ex.book.lastSeq}</dd>
        </div>
        <div>
          <dt>Dropped</dt>
          <dd>{ex.status?.dropped ?? 0}</dd>
        </div>
        <div>
          <dt>Gaps found</dt>
          <dd data-testid="gaps">{s.gaps}</dd>
        </div>
        <div>
          <dt>Resyncs</dt>
          <dd>{s.resyncs}</dd>
        </div>
        <div>
          <dt>Stale skipped</dt>
          <dd>{s.ignoredStale}</dd>
        </div>
      </dl>
      <p className="small muted">Your own fills use a separate, reliable channel, so chaos never loses them (it can lose trades from the public tape).</p>
    </section>
  );
}

function rowText(r: JournalRow): string {
  if (r.kind === 'CANCEL') return `cancel #${r.orderId}`;
  const side = r.side === 'BUY' ? 'buy' : 'sell';
  return r.kind === 'MARKET' ? `${side} ${fmtQty(r.qty!)} at market` : `${side} ${fmtQty(r.qty!)} @ ${fmtPrice(r.price!)}`;
}

function JournalPanel({ ex }: { ex: Exchange }) {
  const seq = ex.status?.seq ?? 0;
  const paused = ex.status?.paused ?? false;
  const [upto, setUpto] = useState(0);
  const view = ex.replayView;
  const pending = useRef(0);

  // Debounce slider moves into replay requests.
  const go = (n: number) => {
    setUpto(n);
    clearTimeout(pending.current);
    pending.current = window.setTimeout(() => ex.replay(n), 60);
  };
  useEffect(() => () => clearTimeout(pending.current), []);

  const download = async () => {
    const j = await ex.journal();
    const body = JSON.stringify({ format: 'arena-journal/1', seed: j.seed, fingerprint: j.fingerprint, entries: j.rows }, null, 1);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = `arena-journal-seed-${j.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="panel" aria-labelledby="journal-h">
      <h3 id="journal-h">Journal &amp; time travel</h3>
      <p className="small muted">
        Every order, bot or human, is sequenced and written to a journal before it reaches the engine. The exchange is a pure function of that journal, so
        any point in the session can be rebuilt from scratch and checked against the fingerprint recorded live.
      </p>
      <dl className="stats compact">
        <div>
          <dt>Journal</dt>
          <dd data-testid="seq">#{seq}</dd>
        </div>
        <div className="wide">
          <dt>Fingerprint</dt>
          <dd className="mono" data-testid="fingerprint">
            {ex.status?.fingerprint ?? '—'}
          </dd>
        </div>
      </dl>
      {!paused ? (
        <button type="button" onClick={() => { ex.pause(true); go(seq); }}>
          <span aria-hidden="true">⏸</span> Pause and time-travel
        </button>
      ) : (
        <>
          <label className="field">
            <span>
              Rebuild the book after entry <strong>#{upto}</strong> of {seq}
            </span>
            <input type="range" min={0} max={seq} value={upto} onChange={(e) => go(Number(e.target.value))} aria-label="Journal position" />
          </label>
          {view && (
            <div className={`verify ${view.matches ? 'ok' : 'bad'}`} role="status" data-testid="replay-verify">
              {view.matches ? '✓' : '✕'} Replayed {view.upto} entries from scratch: <span className="mono">{view.fingerprint}</span>{' '}
              {view.matches ? 'matches the live fingerprint' : 'does NOT match'}
            </div>
          )}
          {view && view.rows.length > 0 && (
            <ol className="list mono small journal">
              {view.rows.map((r) => (
                <li key={r.seq} className={r.seq === view.upto ? 'current' : ''}>
                  <span className="muted">#{r.seq}</span> <span className="muted">{clock(r.ts)}</span> {ownerName(r.owner)}: {rowText(r)}
                </li>
              ))}
            </ol>
          )}
          <button type="button" onClick={() => ex.pause(false)}>
            <span aria-hidden="true">▶</span> Back to live
          </button>
        </>
      )}
      <button type="button" className="link" onClick={download}>
        Download the journal (JSON)
      </button>
    </section>
  );
}

function BenchPanel() {
  const [result, setResult] = useState<{ n: number; trades: number; ms: number } | null>(null);
  const [running, setRunning] = useState(false);
  const run = () => {
    setRunning(true);
    const w = new Worker(new URL('../worker/bench.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      setResult(e.data);
      setRunning(false);
      w.terminate();
    };
    w.postMessage({ n: 1_000_000 });
  };
  return (
    <section className="panel" aria-labelledby="bench-h">
      <h3 id="bench-h">Benchmark it in your browser</h3>
      <p className="small muted">
        Pushes 1,000,000 commands (60% limit orders, 25% cancels, 15% market orders) through a fresh exchange: sequencing, journalling, matching and
        fingerprinting, the full path. Native Rust on a 2.1 GHz Xeon core: about 2 million per second.
      </p>
      <button type="button" onClick={run} disabled={running}>
        {running ? 'Running…' : 'Run 1M commands'}
      </button>
      {result && (
        <p className="bench-result" role="status" data-testid="bench-result">
          <strong>{((result.n / result.ms) * 1000).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong> commands/s in your browser ·{' '}
          {result.ms.toFixed(0)} ms · {result.trades.toLocaleString('en-IN')} trades
        </p>
      )}
    </section>
  );
}
