/**
 * Guided lessons: hands-on missions checked against the player's own
 * activity, each ending with an explanation in their own numbers.
 * Pure: everything comes from the facts passed in.
 */
import { money } from './format';
import { spreadPnl, type Account } from './session';

export interface LessonFacts {
  account: Account;
  /** Packet gaps the feed client has detected. */
  gaps: number;
  feedLive: boolean;
  /** A time-travel replay matched the live fingerprint. */
  replayVerified: boolean;
  ended: boolean;
}

export interface Lesson {
  id: string;
  title: string;
  /** What to do, one line. */
  task: string;
  /** Where in the UI to do it. */
  where: string;
  done(f: LessonFacts): boolean;
  /** What it taught, using the player's numbers. */
  learned(f: LessonFacts): string;
}

const firstFill = (f: LessonFacts, liquidity: 'MAKER' | 'TAKER') => f.account.fills.find((x) => x.liquidity === liquidity);

export const LESSONS: Lesson[] = [
  {
    id: 'take',
    title: 'Take liquidity',
    task: 'Buy or sell 1 lot at market.',
    where: 'Order ticket › Market',
    done: (f) => f.account.fills.some((x) => x.liquidity === 'TAKER'),
    learned: (f) => {
      const fill = firstFill(f, 'TAKER')!;
      const pnl = spreadPnl(fill);
      return pnl === null
        ? 'Your order filled at once against orders already in the book. Trading immediately means paying the spread.'
        : `Filled at once, ${money(-pnl)} worse than the mid price just before. That difference is the spread, the cost of trading immediately.`;
    },
  },
  {
    id: 'make',
    title: 'Make liquidity',
    task: 'Rest a limit order at the best bid or ask and get it filled.',
    where: 'Order ticket › Limit › Bid or Ask',
    done: (f) => f.account.fills.some((x) => x.liquidity === 'MAKER'),
    learned: (f) => {
      const fill = firstFill(f, 'MAKER')!;
      const pnl = spreadPnl(fill);
      const earned = pnl !== null && pnl > 0 ? `, ${money(pnl)} better than the mid` : '';
      return `Another trader crossed the spread to fill your order${earned}. You earned the spread instead of paying it, at the cost of waiting and the risk of not filling.`;
    },
  },
  {
    id: 'cancel',
    title: 'Change your mind',
    task: 'Place a limit order away from the market, then cancel it.',
    where: 'Your orders › Cancel',
    done: (f) => f.account.cancels > 0,
    learned: () =>
      'Cancelling is free here, and on real exchanges most orders end cancelled rather than filled. Your place in the queue is gone: a new order joins at the back.',
  },
  {
    id: 'trip',
    title: 'Close a round trip',
    task: 'Open a position, then trade back to flat.',
    where: 'Position › Net quantity back to 0',
    done: (f) => f.account.roundTrips.length > 0,
    learned: (f) => {
      const trip = f.account.roundTrips[0]!;
      const charges = f.account.charges().total;
      return `First round trip: ${money(trip.pnl, { sign: true })} before costs, with ${money(charges)} in charges so far. STT alone is 0.05% of every sale.`;
    },
  },
  {
    id: 'chaos',
    title: 'Break the feed',
    task: 'Set chaos to 20% or more and watch gaps get detected.',
    where: 'Under the hood › Market-data feed',
    done: (f) => f.gaps > 0 && f.feedLive,
    learned: (f) =>
      `${f.gaps} lost packet${f.gaps === 1 ? '' : 's'} detected by sequence number and repaired with snapshots. Your own fills use a separate channel and were never lost.`,
  },
  {
    id: 'audit',
    title: 'Audit the exchange',
    task: 'Pause, replay to any point and check the fingerprint.',
    where: 'Under the hood › Journal and replay',
    done: (f) => f.replayVerified,
    learned: () =>
      'The exchange was rebuilt from its journal and matched the fingerprint recorded live. Same inputs give the same result, which is how an exchange can prove what happened.',
  },
  {
    id: 'wrapped',
    title: 'Read your session',
    task: 'End the session and see your Wrapped.',
    where: 'Top bar › End session',
    done: (f) => f.ended,
    learned: () => 'Every number in Wrapped comes from your own fills and the journal.',
  },
];

/** Index of the first unfinished lesson, or LESSONS.length when all are done. */
export function currentLesson(f: LessonFacts): number {
  const i = LESSONS.findIndex((l) => !l.done(f));
  return i === -1 ? LESSONS.length : i;
}

/** Up to three concrete things to try next session, from this session's numbers. */
export function nextSteps(w: import('./session').WrappedSummary): string[] {
  const out: string[] = [];
  if (w.fills === 0) return ['Start with lesson 1: buy one lot at market and see what the spread costs.'];
  if (w.makerShare !== null && w.makerShare < 0.3) {
    out.push('Most of your volume crossed the spread. Rest limit orders at the bid or ask and let others pay it to you.');
  }
  if (w.grossPnl > 0 && w.netPnl < 0) {
    out.push(`You were right on price (${money(w.grossPnl, { sign: true })}) but charges took more than that. Trade less often, and only when the expected move is well above the costs.`);
  } else if (w.chargesPctOfGross === null && w.charges.total > 0 && w.roundTrips > 0) {
    out.push(`Charges were ${money(w.charges.total)} on top of the trading loss. Each extra order costs ₹20 plus taxes before the market moves at all.`);
  }
  if (w.winRate !== null && w.winRate >= 0.5 && w.grossPnl < 0) {
    out.push('You won more trades than you lost, but the losers were bigger. Decide your exit before you enter, and keep losers smaller than winners.');
  }
  if (w.openQty !== 0) out.push('You finished with an open position. Practise ending flat: open risk is not a result yet.');
  if (out.length === 0) out.push('Replay the same market and try to beat this result: the bots will make the same moves.');
  return out.slice(0, 3);
}
