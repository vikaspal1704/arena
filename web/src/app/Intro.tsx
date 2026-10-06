export const REPO = 'https://github.com/vikaspal1704/arena';

export function Intro({ onStart }: { onStart: () => void }) {
  return (
    <div className="intro-backdrop">
      <section className="intro" role="dialog" aria-modal="true" aria-labelledby="intro-h">
        <p className="eyebrow">A stock exchange in your browser</p>
        <h1 id="intro-h">
          <span className="logo" aria-hidden="true">◆</span> Arena
        </h1>
        <p className="lede">
          Trade index futures against a market of bots. Watch your order wait in the queue, pay the spread, pay real Indian charges. Then rewind the whole
          exchange and check every order.
        </p>
        <p className="lede small-lede">
          New to order books? Seven short hands-on lessons guide you through it, with every result explained in your own numbers.
        </p>
        <ul className="pitch">
          <li>
            <strong>Matching engine in Rust</strong>, compiled to a 79 KB WebAssembly module with no JavaScript glue. Price-time priority, about 2 million
            orders a second.
          </li>
          <li>
            <strong>Proven against a second implementation</strong>: millions of random orders give identical trades in this engine and an independent
            Python one.
          </li>
          <li>
            <strong>Deterministic and replayable</strong>: every order is journalled and fingerprinted, so any moment of your session can be rebuilt and
            verified.
          </li>
          <li>
            <strong>A real market-data feed</strong>: sequenced deltas, gap detection and snapshot recovery. Turn on chaos and watch it heal.
          </li>
        </ul>
        <div className="actions">
          <button type="button" className="primary" onClick={onStart} autoFocus>
            Start the lessons
          </button>
          <a className="button" href={REPO} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </div>
        <p className="small muted">Simulated market, play money. Nothing leaves your browser. Not investment advice.</p>
      </section>
    </div>
  );
}
