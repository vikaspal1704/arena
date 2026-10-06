import { describe, expect, it } from 'vitest';
import { currentLesson, LESSONS, nextSteps, type LessonFacts } from '../../src/core/lessons';
import { Account, spreadPnl } from '../../src/core/session';
import { describeFill } from '../../src/app/useExchange';
import type { ArenaEvent } from '../../src/core/types';

const ev = (e: Partial<ArenaEvent> & { kind: ArenaEvent['kind'] }) => ({ seq: 1, ts: 0, ...e }) as ArenaEvent;
const facts = (account: Account, extra: Partial<LessonFacts> = {}): LessonFacts => ({ account, gaps: 0, feedLive: true, replayVerified: false, ended: false, ...extra });

/** A market buy of 75 at ₹100.10 when the mid was ₹100.00. */
function takerBuy(a: Account) {
  a.apply(
    [
      ev({ kind: 'accepted', orderId: 1, owner: 0, side: 'BUY', price: 0, qty: 75, market: true }),
      ev({ kind: 'trade', tradeId: 1, price: 10_010, qty: 75, makerOwner: 1, makerOrderId: 9, takerOwner: 0, takerOrderId: 1, aggressor: 'BUY' }),
    ],
    10_000,
    10_000,
  );
}

describe('lessons', () => {
  it('lesson_one_completes_on_a_taker_fill_and_explains_the_spread_cost', () => {
    const a = new Account();
    expect(currentLesson(facts(a))).toBe(0);
    takerBuy(a);
    expect(spreadPnl(a.fills[0]!)).toBe(-750);
    expect(LESSONS[0]!.done(facts(a))).toBe(true);
    expect(LESSONS[0]!.learned(facts(a))).toContain('₹7.50 worse than the mid');
    expect(currentLesson(facts(a))).toBe(1);
  });

  it('lessons_follow_feed_and_audit_activity', () => {
    const a = new Account();
    const chaos = LESSONS.find((l) => l.id === 'chaos')!;
    expect(chaos.done(facts(a, { gaps: 3, feedLive: false }))).toBe(false); // still recovering
    expect(chaos.done(facts(a, { gaps: 3, feedLive: true }))).toBe(true);
    expect(LESSONS.find((l) => l.id === 'audit')!.done(facts(a, { replayVerified: true }))).toBe(true);
  });

  it('coach_note_describes_a_fill_in_plain_words', () => {
    const a = new Account();
    takerBuy(a);
    expect(describeFill(a.fills[0]!)).toBe('Bought 75 @ 100.10: crossing the spread cost ₹7.50 against the mid.');
  });

  it('next_steps_are_personal', () => {
    const a = new Account();
    takerBuy(a);
    const w = a.wrapped(10_000, 60_000);
    const steps = nextSteps(w);
    expect(steps[0]).toContain('crossed the spread');
    expect(steps.some((s) => s.includes('open position'))).toBe(true);
    expect(nextSteps(new Account().wrapped(0, 1000))).toEqual(['Start with lesson 1: buy one lot at market and see what the spread costs.']);
  });
});
