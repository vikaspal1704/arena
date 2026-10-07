import { useCallback, useEffect, useRef, useState } from 'react';
import { setInstrument, type Side } from '../core/types';
import { CoachNotes, LessonStrip } from './Coach';
import { Intro, REPO } from './Intro';
import { Header, Ladder, MyOrders, PositionPanel, Tape, Ticket } from './Trading';
import { UnderTheHood } from './UnderTheHood';
import { RealBook, RealSetup } from './RealMarket';
import { useExchange } from './useExchange';
import { REAL_MODE, useRealMarket } from './useRealMarket';
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

  // Real-market mode: the live contract's settings, once the bridge has sent them.
  const realInstrument = useRef<{ tick: number; startPrice: number; lot: number } | null>(null);
  const real = useRealMarket((t) => {
    if (realInstrument.current) ex.anchor(t.ltp);
  });

  const begin = useCallback(
    (seed: number) => {
      const url = new URL(location.href);
      url.searchParams.set('seed', String(seed));
      history.replaceState(null, '', url);
      ex.start(seed, realInstrument.current ?? undefined);
      setStarted(true);
    },
    [ex],
  );

  // Start the market behind the intro, so it is already moving when the dialog closes.
  // In real-market mode, wait for the bridge to say which contract it is streaming.
  useEffect(() => {
    if (!REAL_MODE) ex.start(initialSeed());
  }, [ex.start]);

  const hello = real.hello;
  useEffect(() => {
    if (!REAL_MODE || realInstrument.current || !hello?.loggedIn || !hello.instrument) return;
    const startPrice = real.tick?.ltp ?? hello.lastPrice;
    if (!startPrice) return; // wait for a price
    const { symbol, tickPaise, lot } = hello.instrument;
    const name = hello.mode === 'mock' ? 'NIFTY FUT (mock prices)' : `${symbol} (live prices)`;
    setInstrument({ name, tick: tickPaise, lot, startPrice });
    realInstrument.current = { tick: tickPaise, startPrice, lot };
    ex.start(initialSeed(), realInstrument.current);
    ex.anchor(startPrice);
  }, [hello, real.tick, ex]);

  if (REAL_MODE && !realInstrument.current) return <RealSetup real={real} />;

  if (ex.ended) {
    return (
      <Wrapped
        ex={ex}
        ended={ex.ended}
        previousNet={previousNet}
        realMode={REAL_MODE}
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
          {REAL_MODE && <RealBook real={real} />}
          <Tape ex={ex} />
        </div>
      </main>
      <UnderTheHood ex={ex} />
      <footer className="foot">
        {REAL_MODE ? 'Real NSE prices from your Kite account; simulated fills and play money.' : 'Simulated market with play money.'}{' '}
        <a href={REPO}>Source on GitHub</a>. Built by Vikas Pal.
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
