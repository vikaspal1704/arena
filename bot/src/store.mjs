// What the bot remembers: one state file per trading day (so a restart picks
// up where it left off) and an append-only JSONL journal of every decision.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  file(date) {
    return join(this.dir, `${date}.json`);
  }

  loadDay(date) {
    const f = this.file(date);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  }

  saveDay(day) {
    // Write then rename, so a crash never leaves half a file.
    const tmp = `${this.file(day.date)}.tmp`;
    writeFileSync(tmp, JSON.stringify(day, null, 2));
    renameSync(tmp, this.file(day.date));
  }

  days() {
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
  }

  /** Realized P&L of all days before `date`, in paise. */
  realizedBefore(date) {
    return this.days()
      .filter((d) => d.date < date)
      .reduce((s, d) => s + d.realized, 0);
  }
}

export class MemoryStore {
  constructor(days = []) {
    this.map = new Map(days.map((d) => [d.date, structuredClone(d)]));
  }

  loadDay(date) {
    return this.map.has(date) ? structuredClone(this.map.get(date)) : null;
  }

  saveDay(day) {
    this.map.set(day.date, structuredClone(day));
  }

  days() {
    return [...this.map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  realizedBefore(date) {
    return this.days()
      .filter((d) => d.date < date)
      .reduce((s, d) => s + d.realized, 0);
  }
}

export class Journal {
  /** `file` null keeps entries in memory only; `print` gets each entry for the console. */
  constructor(file = null, print = null) {
    this.file = file;
    this.print = print;
    this.entries = [];
  }

  write(at, type, data = {}) {
    const entry = { at: new Date(at).toISOString(), type, ...data };
    this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.shift();
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.print?.(entry);
    return entry;
  }
}
