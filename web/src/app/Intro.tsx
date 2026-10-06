export const REPO = 'https://github.com/vikaspal1704/arena';

export function Intro({ onStart }: { onStart: (withLessons: boolean) => void }) {
  return (
    <div className="intro-backdrop">
      <section className="intro" role="dialog" aria-modal="true" aria-labelledby="intro-h">
        <h1 id="intro-h">Arena</h1>
        <p className="lede">A working stock exchange in your browser. Trade against bots, then rewind and verify every order.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => onStart(true)} autoFocus>
            Start the lessons
          </button>
          <button type="button" onClick={() => onStart(false)}>
            Trade freely
          </button>
        </div>
        <p className="fineprint">Simulated market and play money. Nothing you do leaves your browser.</p>
      </section>
    </div>
  );
}
