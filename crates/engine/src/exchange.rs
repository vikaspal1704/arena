//! The sequencer: the single entry point to the engine.
//!
//! Every command gets the next sequence number and a timestamp and is
//! appended to the journal *before* it is applied. The exchange's state is
//! a pure function of the journal, so:
//!
//! * replaying the journal (or any prefix of it) on a fresh exchange gives
//!   the same book and the same events, byte for byte;
//! * a running fingerprint, `chain[n] = H(chain[n-1], seq, ts, events of n)`,
//!   lets anyone check that a replay matches the original at every step.

use crate::engine::{Engine, EngineConfig};
use crate::hash::Fnv;
use crate::types::{Command, DoneReason, Event, RejectReason, Side};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JournalEntry {
    /// 1-based, gap-free.
    pub seq: u64,
    /// Exchange clock, milliseconds since the session started.
    pub ts_ms: u64,
    pub cmd: Command,
}

#[derive(Debug, Clone)]
pub struct Exchange {
    engine: Engine,
    journal: Vec<JournalEntry>,
    /// `chain[i]` is the fingerprint after journal entry `i + 1`.
    chain: Vec<u64>,
    /// Events of the last command.
    events: Vec<Event>,
}

impl Exchange {
    pub fn new(config: EngineConfig) -> Self {
        Exchange {
            engine: Engine::new(config),
            journal: Vec::new(),
            chain: Vec::new(),
            events: Vec::new(),
        }
    }

    /// Preallocates (and touches) room for `commands` journal entries and
    /// orders, as a production engine would at start of day.
    pub fn with_capacity(config: EngineConfig, commands: usize) -> Self {
        let blank = JournalEntry {
            seq: 0,
            ts_ms: 0,
            cmd: Command::Cancel {
                owner: 0,
                order_id: 0,
            },
        };
        let mut journal = Vec::new();
        journal.resize(commands, blank);
        journal.clear();
        let mut chain = vec![0u64; commands];
        chain.clear();
        Exchange {
            engine: Engine::with_capacity(config, commands),
            journal,
            chain,
            events: Vec::with_capacity(256),
        }
    }

    /// Sequences, journals and applies one command; returns its events.
    pub fn submit(&mut self, ts_ms: u64, cmd: Command) -> &[Event] {
        let seq = self.journal.len() as u64 + 1;
        let entry = JournalEntry { seq, ts_ms, cmd };
        self.journal.push(entry);
        self.events.clear();
        self.engine.apply(cmd, &mut self.events);
        let prev = self.chain.last().copied().unwrap_or(0);
        self.chain.push(fingerprint(prev, &entry, &self.events));
        &self.events
    }

    /// A fresh exchange with the first `upto` journal entries applied.
    pub fn replay(config: EngineConfig, journal: &[JournalEntry], upto: usize) -> Exchange {
        let mut ex = Exchange::new(config);
        for entry in &journal[..upto.min(journal.len())] {
            ex.submit(entry.ts_ms, entry.cmd);
        }
        ex
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn journal(&self) -> &[JournalEntry] {
        &self.journal
    }

    pub fn last_events(&self) -> &[Event] {
        &self.events
    }

    /// Fingerprint after journal entry `seq` (0 = before anything).
    pub fn fingerprint_at(&self, seq: u64) -> u64 {
        if seq == 0 {
            0
        } else {
            self.chain[(seq - 1) as usize]
        }
    }

    pub fn fingerprint(&self) -> u64 {
        self.chain.last().copied().unwrap_or(0)
    }

    pub fn seq(&self) -> u64 {
        self.journal.len() as u64
    }
}

fn fingerprint(prev: u64, entry: &JournalEntry, events: &[Event]) -> u64 {
    let mut h = Fnv::with_seed(prev);
    h.write(entry.seq);
    h.write(entry.ts_ms);
    write_command(&mut h, &entry.cmd);
    for e in events {
        write_event(&mut h, e);
    }
    h.finish()
}

fn side_word(s: Side) -> u64 {
    match s {
        Side::Buy => 1,
        Side::Sell => 2,
    }
}

fn write_command(h: &mut Fnv, cmd: &Command) {
    match *cmd {
        Command::Limit {
            owner,
            side,
            price,
            qty,
        } => {
            for w in [10, owner as u64, side_word(side), price as u64, qty] {
                h.write(w);
            }
        }
        Command::Market { owner, side, qty } => {
            for w in [11, owner as u64, side_word(side), qty] {
                h.write(w);
            }
        }
        Command::Cancel { owner, order_id } => {
            for w in [12, owner as u64, order_id] {
                h.write(w);
            }
        }
    }
}

/// Every event as a fixed list of words. The WebAssembly bindings use the
/// same layout, so this is also the wire format.
pub fn event_words(e: &Event) -> [u64; 9] {
    match *e {
        Event::Accepted {
            order_id,
            owner,
            side,
            price,
            qty,
            market,
        } => [
            1,
            order_id,
            owner as u64,
            side_word(side),
            price as u64,
            qty,
            market as u64,
            0,
            0,
        ],
        Event::Rejected { owner, reason } => {
            [2, owner as u64, reject_word(reason), 0, 0, 0, 0, 0, 0]
        }
        Event::Trade {
            trade_id,
            price,
            qty,
            maker_order_id,
            taker_order_id,
            maker_owner,
            taker_owner,
            aggressor,
        } => [
            3,
            trade_id,
            price as u64,
            qty,
            maker_order_id,
            taker_order_id,
            maker_owner as u64,
            taker_owner as u64,
            side_word(aggressor),
        ],
        Event::Done {
            order_id,
            owner,
            reason,
            remaining_qty,
        } => [
            4,
            order_id,
            owner as u64,
            done_word(reason),
            remaining_qty,
            0,
            0,
            0,
            0,
        ],
        Event::Level {
            side,
            price,
            qty,
            orders,
        } => [
            5,
            side_word(side),
            price as u64,
            qty,
            orders as u64,
            0,
            0,
            0,
            0,
        ],
    }
}

fn write_event(h: &mut Fnv, e: &Event) {
    for w in event_words(e) {
        h.write(w);
    }
}

pub fn reject_word(r: RejectReason) -> u64 {
    match r {
        RejectReason::BadPrice => 1,
        RejectReason::BadQty => 2,
        RejectReason::UnknownOrder => 3,
        RejectReason::NotCancellable => 4,
        RejectReason::NotOwner => 5,
    }
}

pub fn done_word(r: DoneReason) -> u64 {
    match r {
        DoneReason::Filled => 1,
        DoneReason::Cancelled => 2,
        DoneReason::Expired => 3,
    }
}
