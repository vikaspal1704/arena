import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Question, X } from '@phosphor-icons/react';
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
 * Guided lessons in a flat bar under the top bar. Finishing a lesson changes
 * text inside the bar, never its position, so the desk below does not move.
 */
export function LessonStrip({ ex, startHidden = false }: { ex: Exchange; startHidden?: boolean }) {
  const facts = lessonFacts(ex);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState(startHidden);
  const current = currentLesson(facts);
  // The earliest finished lesson the player hasn't read yet.
  const fresh = LESSONS.find((l) => l.done(facts) && !acknowledged.has(l.id));
  const doneCount = LESSONS.filter((l) => l.done(facts)).length;

  if (hidden) {
    return (
      <div className="lessons collapsed">
        <span className="muted small">
          Lessons {doneCount} of {LESSONS.length} done
        </span>
        <button type="button" className="link small" onClick={() => setHidden(false)}>
          Show lessons
        </button>
      </div>
    );
  }

  const lesson = LESSONS[current];
  return (
    <section className="lessons" aria-label="Lessons" data-testid="lessons">
      {fresh ? (
        <div className="learned" role="status">
          <Check size={18} weight="bold" aria-hidden="true" />
          <p>
            <strong>{fresh.title}.</strong> {fresh.learned(facts)}
          </p>
        </div>
      ) : lesson ? (
        <p>
          <span className="count">
            {current + 1}/{LESSONS.length}
          </span>
          <strong>{lesson.title}.</strong> {lesson.task}
          <span className="where">{lesson.where}</span>
        </p>
      ) : (
        <p>
          <strong>All seven lessons done.</strong> Next goal: finish a session with a positive result after charges.
        </p>
      )}
      <div className="lessons-side">
        {fresh && (
          <button type="button" className="primary" onClick={() => setAcknowledged((a) => new Set(a).add(fresh.id))}>
            {current < LESSONS.length ? 'Next lesson' : 'Done'}
            <ArrowRight size={14} weight="bold" aria-hidden="true" />
          </button>
        )}
        <ol className="progress" aria-label={`Lessons: ${doneCount} of ${LESSONS.length} done`}>
          {LESSONS.map((l, i) => (
            <li key={l.id} className={l.done(facts) ? 'done' : i === current ? 'now' : ''} title={l.title} />
          ))}
        </ol>
        <button type="button" className="link small" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
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
          <button type="button" aria-label="Dismiss" onClick={() => ex.dismissNote(n.id)}>
            <X size={14} aria-hidden="true" />
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
        <Question size={15} aria-hidden="true" />
      </button>
      {open && (
        <span id={id} role="note" className="tip-bubble">
          {children}
        </span>
      )}
    </span>
  );
}
