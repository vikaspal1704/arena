import { useCallback, useEffect, useState } from 'react';
import type { Side } from '../core/types';
import { CoachNotes, LessonStrip } from './Coach';
import { Intro, REPO } from './Intro';
import { Header, Ladder, MyOrders, PositionPanel, Tape, Ticket } from './Trading';
import { UnderTheHood } from './UnderTheHood';
import { useExchange } from './useExchange';
import { Wrapped } from './Wrapped';

/** `?seed=123` replays a specific market; otherwise a fresh one. */
function initialSeed(): number {
  const s = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isInteger(s) && s > 0 ? s : 1 + Math.floor(Math.random() * 1_000_000);
}

export function App() {
  const ex = useExchange();
  const [started, setStarted] = useState(false);
  const [lessonsOn, setLessonsOn] = useState(true);
  const [picked, setPicked] = useState<{ side: Side; price: number; n: number } | null>(null);
  /** Net P&L of the last finished session in this visit (kept in memory only). */
  const [previousNet, setPreviousNet] = useState<number | null>(null);

  const begin = useCallback(
    (seed: number) => {
      const url = new URL(location.href);
      url.searchParams.set('seed', String(seed));
      history.replaceState(null, '', url);
      ex.start(seed);
      setStarted(true);
    },
    [ex],
  );

  // Start the market behind the intro, so it is already moving when the dialog closes.
  useEffect(() => {
    ex.start(initialSeed());
  }, [ex.start]);

  if (ex.ended) {
    return (
      <Wrapped
        ex={ex}
        ended={ex.ended}
        previousNet={previousNet}
        onRestart={(same, net) => {
          setPreviousNet(net);
          begin(same ? ex.seed! : 1 + Math.floor(Math.random() * 1_000_000));
        }}
      />
    );
  }

  return (
    <>
      <Header ex={ex} onEnd={ex.end} />
      <LessonStrip ex={ex} startHidden={!lessonsOn} key={lessonsOn ? 'on' : 'off'} />
      <main className="desk">
        <Ladder ex={ex} onPick={(side, price) => setPicked((p) => ({ side, price, n: (p?.n ?? 0) + 1 }))} />
        <div className="middle">
          <Ticket ex={ex} picked={picked} />
          <PositionPanel ex={ex} />
        </div>
        <div className="right">
          <MyOrders ex={ex} />
          <Tape ex={ex} />
        </div>
      </main>
      <UnderTheHood ex={ex} />
      <footer className="foot">
        Simulated market with play money. <a href={REPO}>Source on GitHub</a>. Built by Vikas Pal.
      </footer>
      <CoachNotes ex={ex} />
      {!started && (
        <Intro
          onStart={(withLessons) => {
            setLessonsOn(withLessons);
            setStarted(true);
          }}
        />
      )}
    </>
  );
}
