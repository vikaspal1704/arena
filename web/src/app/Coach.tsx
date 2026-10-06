import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { currentLesson, LESSONS, type LessonFacts } from '../core/lessons';
import type { Exchange } from './useExchange';

export function lessonFacts(ex: Exchange): LessonFacts {
  return {
    account: ex.account,
    gaps: ex.book.stats.gaps,
    feedLive: ex.book.status === 'live',
    replayVerified: ex.replayVerified,
    ended: ex.ended !== null,
  };
}

/**
 * Guided lessons along the top of the desk. Fixed height on wide screens,
 * so finishing a lesson never moves the trading panels.
 */
export function LessonStrip({ ex }: { ex: Exchange }) {
  const facts = lessonFacts(ex);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState(false);
  const current = currentLesson(facts);
  // The earliest finished lesson the player hasn't read yet.
  const fresh = LESSONS.find((l) => l.done(facts) && !acknowledged.has(l.id));
  const doneCount = LESSONS.filter((l) => l.done(facts)).length;

  if (hidden) {
    return (
      <div className="lessons collapsed">
        <span className="muted small">
          Lessons {doneCount}/{LESSONS.length}
        </span>
        <button type="button" className="link" onClick={() => setHidden(false)}>
          Show lessons
        </button>
      </div>
    );
  }

  const lesson = LESSONS[current];
  return (
    <section className="lessons" aria-labelledby="lessons-h" data-testid="lessons">
      <div className="lessons-head">
        <h2 id="lessons-h">
          Lessons <span className="muted">{doneCount}/{LESSONS.length}</span>
        </h2>
        <ol className="dots" aria-label="Lesson progress">
          {LESSONS.map((l, i) => (
            <li key={l.id} className={l.done(facts) ? 'done' : i === current ? 'now' : ''} title={l.title}>
              <span className="sr-only">
                {l.title}: {l.done(facts) ? 'done' : i === current ? 'current' : 'to do'}
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="link small" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
      {fresh ? (
        <div className="lesson-body learned" role="status">
          <p>
            <strong>✓ {fresh.title}.</strong> {fresh.learned(facts)}
          </p>
          <button type="button" className="primary" onClick={() => setAcknowledged((a) => new Set(a).add(fresh.id))}>
            {current < LESSONS.length ? 'Next lesson →' : 'Done'}
          </button>
        </div>
      ) : lesson ? (
        <div className="lesson-body">
          <p>
            <strong>
              {current + 1}. {lesson.title}:
            </strong>{' '}
            {lesson.task} <span className="where">{lesson.where}</span>
          </p>
        </div>
      ) : (
        <div className="lesson-body">
          <p>
            <strong>All lessons done.</strong> Now try to finish a session with positive P&amp;L after charges. It's harder than it looks.
          </p>
        </div>
      )}
    </section>
  );
}

/** Short notes about your fills, in a fixed corner so they never move the layout. */
export function CoachNotes({ ex }: { ex: Exchange }) {
  return (
    <div className="notes" aria-live="polite" aria-atomic="false">
      {ex.notes.map((n) => (
        <div key={n.id} className={`note-card ${n.tone}`}>
          <span>{n.text}</span>
          <button type="button" className="link" aria-label="Dismiss" onClick={() => ex.dismissNote(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** A "?" that explains a term. The bubble floats, so opening it moves nothing. */
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);
  return (
    <span className="tip" ref={ref}>
      <button type="button" className="tip-btn" aria-expanded={open} aria-controls={id} aria-label={`What is ${label}?`} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open && (
        <span id={id} role="note" className="tip-bubble">
          {children}
        </span>
      )}
    </span>
  );
}
