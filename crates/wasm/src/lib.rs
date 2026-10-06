//! WebAssembly bindings with no glue code.
//!
//! The browser calls plain exported functions with number arguments. Results
//! go into one output buffer of `f64`s that JavaScript reads straight out of
//! the module's memory (`arena_out_ptr` / the returned record count). Every
//! integer the engine uses here stays far below 2^53, so `f64` carries it
//! exactly and JavaScript gets ordinary numbers, not BigInts.
//!
//! Event record layout (11 numbers): `[seq, ts_ms, w0 .. w8]`, where `w` is
//! `exchange::event_words` (w0 is the kind: 1 accepted, 2 rejected, 3 trade,
//! 4 done, 5 level).

use std::cell::RefCell;

use arena_engine::exchange::event_words;
use arena_engine::sim::{Stamped, PLAYER};
use arena_engine::{Command, Exchange, Side, Sim, SimConfig};

pub const EVENT_WORDS: usize = 11;

struct State {
    sim: Sim,
    /// A replay of the journal up to some point (the time-travel view).
    replay: Option<Exchange>,
    out: Vec<f64>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| {
        f(s.borrow_mut()
            .as_mut()
            .expect("arena_new must be called first"))
    })
}

fn side(s: u32) -> Side {
    if s == 1 {
        Side::Buy
    } else {
        Side::Sell
    }
}

fn write_events(out: &mut Vec<f64>, events: &[Stamped]) -> u32 {
    out.clear();
    for e in events {
        out.push(e.seq as f64);
        out.push(e.ts_ms as f64);
        out.extend(event_words(&e.event).iter().map(|w| *w as f64));
    }
    events.len() as u32
}

/// Starts a new session. Returns the number of setup events (bots seeding the book).
#[no_mangle]
pub extern "C" fn arena_new(seed: u32) -> u32 {
    let sim = Sim::new(SimConfig {
        seed: seed as u64,
        ..SimConfig::default()
    });
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            sim,
            replay: None,
            out: Vec::with_capacity(4096),
        })
    });
    with(|st| st.sim.exchange().seq() as u32)
}

#[no_mangle]
pub extern "C" fn arena_out_ptr() -> *const f64 {
    with(|st| st.out.as_ptr())
}

/// Advances the market by `dt_ms`. Returns the number of event records written.
#[no_mangle]
pub extern "C" fn arena_step(dt_ms: u32) -> u32 {
    with(|st| {
        let events = st.sim.step(dt_ms as u64);
        write_events(&mut st.out, &events)
    })
}

/// side: 1 buy, 2 sell.
#[no_mangle]
pub extern "C" fn arena_limit(side_: u32, price: f64, qty: f64) -> u32 {
    with(|st| {
        let events = st.sim.player(Command::Limit {
            owner: PLAYER,
            side: side(side_),
            price: price as i64,
            qty: qty as u64,
        });
        write_events(&mut st.out, &events)
    })
}

#[no_mangle]
pub extern "C" fn arena_market(side_: u32, qty: f64) -> u32 {
    with(|st| {
        let events = st.sim.player(Command::Market {
            owner: PLAYER,
            side: side(side_),
            qty: qty as u64,
        });
        write_events(&mut st.out, &events)
    })
}

#[no_mangle]
pub extern "C" fn arena_cancel(order_id: f64) -> u32 {
    with(|st| {
        let events = st.sim.player(Command::Cancel {
            owner: PLAYER,
            order_id: order_id as u64,
        });
        write_events(&mut st.out, &events)
    })
}

/// Writes up to `levels` bids then asks as `[side, price, qty, orders]`
/// records, from the live book (`replay` = 0) or the replay view (1).
/// Returns the record count.
#[no_mangle]
pub extern "C" fn arena_depth(levels: u32, replay: u32) -> u32 {
    with(|st| {
        let engine = if replay == 1 {
            st.replay.as_ref().map(|r| r.engine())
        } else {
            None
        }
        .unwrap_or(st.sim.exchange().engine());
        let (bids, asks) = engine.depth(levels as usize);
        st.out.clear();
        for (s, side) in [(1.0, &bids), (2.0, &asks)] {
            for l in side {
                st.out
                    .extend([s, l.price as f64, l.qty as f64, l.orders as f64]);
            }
        }
        (bids.len() + asks.len()) as u32
    })
}

/// Live orders and quantity ahead of the player's order in its queue, as
/// `[orders, qty]` in the buffer. Returns 0 if the order isn't resting.
#[no_mangle]
pub extern "C" fn arena_queue_ahead(order_id: f64) -> u32 {
    with(
        |st| match st.sim.exchange().engine().queue_ahead(order_id as u64) {
            Some((n, q)) => {
                st.out.clear();
                st.out.extend([n as f64, q as f64]);
                1
            }
            None => 0,
        },
    )
}

#[no_mangle]
pub extern "C" fn arena_seq() -> f64 {
    with(|st| st.sim.exchange().seq() as f64)
}

#[no_mangle]
pub extern "C" fn arena_now_ms() -> f64 {
    with(|st| st.sim.now_ms() as f64)
}

/// Hidden fair value (shown only after the session, to keep it honest).
#[no_mangle]
pub extern "C" fn arena_fair() -> f64 {
    with(|st| st.sim.fair_price() as f64)
}

/// Fingerprint after journal entry `seq` as two 32-bit halves in the buffer.
#[no_mangle]
pub extern "C" fn arena_fingerprint(seq: f64) -> u32 {
    with(|st| {
        let f = st.sim.exchange().fingerprint_at(seq as u64);
        st.out.clear();
        st.out.extend([(f >> 32) as f64, (f & 0xffff_ffff) as f64]);
        1
    })
}

/// Rebuilds the exchange from scratch by replaying the first `upto` journal
/// entries, and writes `[hi, lo, matches]`: the replay's fingerprint and
/// whether it equals the live fingerprint recorded at that point.
#[no_mangle]
pub extern "C" fn arena_replay(upto: f64) -> u32 {
    with(|st| {
        let ex = st.sim.exchange();
        let upto = (upto as u64).min(ex.seq());
        let replay = Exchange::replay(ex.engine().config(), ex.journal(), upto as usize);
        let f = replay.fingerprint();
        let matches = f == ex.fingerprint_at(upto);
        st.replay = Some(replay);
        st.out.clear();
        st.out.extend([
            (f >> 32) as f64,
            (f & 0xffff_ffff) as f64,
            matches as u32 as f64,
        ]);
        1
    })
}

/// Journal entries `from..to` (1-based, inclusive) as
/// `[seq, ts_ms, kind, owner, side, price, qty, order_id]` records
/// (kind 1 limit, 2 market, 3 cancel). Returns the record count.
#[no_mangle]
pub extern "C" fn arena_journal(from: f64, to: f64) -> u32 {
    with(|st| {
        let journal = st.sim.exchange().journal();
        let (from, to) = ((from as usize).max(1), (to as usize).min(journal.len()));
        st.out.clear();
        if from > to {
            return 0;
        }
        for e in &journal[from - 1..to] {
            let s = |x: Side| if x == Side::Buy { 1.0 } else { 2.0 };
            let rec = match e.cmd {
                Command::Limit {
                    owner,
                    side,
                    price,
                    qty,
                } => [1.0, owner as f64, s(side), price as f64, qty as f64, 0.0],
                Command::Market { owner, side, qty } => {
                    [2.0, owner as f64, s(side), 0.0, qty as f64, 0.0]
                }
                Command::Cancel { owner, order_id } => {
                    [3.0, owner as f64, 0.0, 0.0, 0.0, order_id as f64]
                }
            };
            st.out.extend([e.seq as f64, e.ts_ms as f64]);
            st.out.extend(rec);
        }
        (to + 1 - from) as u32
    })
}

/// The command mix is generated outside the timed region in the native
/// benchmark; this lets the browser do the same.
#[no_mangle]
pub extern "C" fn arena_bench_prepare(n: u32) -> u32 {
    BENCH.with(|b| *b.borrow_mut() = arena_engine::workload::commands(n as usize, 7));
    n
}

/// Runs the prepared commands; returns the number of trades.
#[no_mangle]
pub extern "C" fn arena_bench_run() -> u32 {
    BENCH.with(|b| {
        let commands = b.borrow();
        let mut ex = Exchange::with_capacity(arena_engine::EngineConfig::default(), commands.len());
        let mut trades = 0u32;
        for (i, cmd) in commands.iter().enumerate() {
            trades += ex
                .submit(i as u64, *cmd)
                .iter()
                .filter(|e| matches!(e, arena_engine::Event::Trade { .. }))
                .count() as u32;
        }
        trades
    })
}

thread_local! {
    static BENCH: RefCell<Vec<Command>> = const { RefCell::new(Vec::new()) };
}
