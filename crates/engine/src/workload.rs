//! Seeded, exchange-like command mixes for benchmarks, shared by the native
//! benchmark and the in-browser one so both measure the same thing.
//!
//! Every mix is 60% limit orders around a slowly moving mid, 25% cancels and
//! 15% market orders. Commands are generated against a shadow [`Engine`]:
//! the generator applies each command as it emits it and tracks which orders
//! are resting from the engine's own events (an accepted limit order rests
//! until a `Done` event names it). So every cancel targets an order that is
//! genuinely live when the cancel arrives, and the measured exchange, which
//! replays the same commands from the same empty state, sees the same book.

use crate::engine::{Engine, EngineConfig};
use crate::sim::Rng;
use crate::types::{Command, Event, OrderId, Owner, Price, Side};

/// Levels on each side of the deep-book scenario's starting book.
pub const DEEP_LEVELS_PER_SIDE: i64 = 25_000;
/// Orders in each level of the deep-book scenario's starting book.
pub const DEEP_ORDERS_PER_LEVEL: usize = 20;

const OWNER: Owner = 1;

/// A benchmark scenario.
pub struct Workload {
    /// Applied before measuring (untimed): builds the starting book.
    pub setup: Vec<Command>,
    /// The measured commands.
    pub commands: Vec<Command>,
}

/// The standard mix from an empty book, generated up front so generation
/// isn't timed.
pub fn commands(n: usize, seed: u64) -> Vec<Command> {
    standard(n, seed).commands
}

/// The standard mix: an empty book, limit orders within a few ticks of the mid.
pub fn standard(n: usize, seed: u64) -> Workload {
    let mut gen = Generator::new(seed, 10_000);
    gen.mix(n, |rng| rng.below(20) as i64 - 2);
    gen.finish(0)
}

/// A deep book: starts from 1,000,000 resting orders on 50,000 levels
/// (25,000 a side, 20 orders each), then runs the standard mix with half of
/// the limit orders placed anywhere in the book's depth, so cancels and new
/// orders land on levels far from the touch.
pub fn deep_book(n: usize, seed: u64) -> Workload {
    let mid = 1_000_000;
    let mut gen = Generator::new(seed, mid);
    for _ in 0..DEEP_ORDERS_PER_LEVEL {
        for i in 1..=DEEP_LEVELS_PER_SIDE {
            for (side, price) in [(Side::Buy, mid - i), (Side::Sell, mid + i)] {
                let qty = 1 + gen.rng.below(100);
                gen.push(Command::Limit {
                    owner: OWNER,
                    side,
                    price,
                    qty,
                });
            }
        }
    }
    let setup_len = gen.out.len();
    gen.mix(n, |rng| {
        if rng.chance(500) {
            rng.below(20) as i64 - 2
        } else {
            1 + rng.below(DEEP_LEVELS_PER_SIDE as u64) as i64
        }
    });
    gen.finish(setup_len)
}

/// Not part of `live`.
const NOT_LIVE: u32 = u32::MAX;

struct Generator {
    rng: Rng,
    mid: Price,
    engine: Engine,
    events: Vec<Event>,
    /// Ids of the orders resting in the shadow engine, in no particular order.
    live: Vec<OrderId>,
    /// `pos[id - 1]` is the order's index in `live`, or `NOT_LIVE`.
    pos: Vec<u32>,
    out: Vec<Command>,
}

impl Generator {
    fn new(seed: u64, mid: Price) -> Self {
        Generator {
            rng: Rng::new(seed),
            mid,
            engine: Engine::new(EngineConfig::default()),
            events: Vec::new(),
            live: Vec::new(),
            pos: Vec::new(),
            out: Vec::new(),
        }
    }

    /// `n` commands of the 60/25/15 mix; `offset` draws a limit order's
    /// distance from the mid (negative = aggressive).
    fn mix(&mut self, n: usize, offset: impl Fn(&mut Rng) -> i64) {
        for _ in 0..n {
            if self.rng.chance(20) {
                self.mid += self.rng.below(5) as i64 - 2;
            }
            let side = if self.rng.chance(500) {
                Side::Buy
            } else {
                Side::Sell
            };
            let cmd = match self.rng.below(100) {
                0..=59 => {
                    let off = offset(&mut self.rng);
                    let price = match side {
                        Side::Buy => self.mid - off,
                        Side::Sell => self.mid + off,
                    };
                    Command::Limit {
                        owner: OWNER,
                        side,
                        price,
                        qty: 1 + self.rng.below(100),
                    }
                }
                60..=84 if !self.live.is_empty() => {
                    let i = self.rng.below(self.live.len() as u64) as usize;
                    Command::Cancel {
                        owner: OWNER,
                        order_id: self.live[i],
                    }
                }
                _ => Command::Market {
                    owner: OWNER,
                    side,
                    qty: 1 + self.rng.below(50),
                },
            };
            self.push(cmd);
        }
    }

    /// Applies `cmd` to the shadow engine, updates `live` from the events it
    /// produced, and emits it.
    fn push(&mut self, cmd: Command) {
        self.events.clear();
        self.engine.apply(cmd, &mut self.events);
        for e in &self.events {
            match *e {
                Event::Accepted {
                    order_id,
                    market: false,
                    ..
                } => {
                    debug_assert_eq!(order_id as usize, self.pos.len() + 1);
                    self.pos.push(self.live.len() as u32);
                    self.live.push(order_id);
                }
                Event::Accepted { .. } => self.pos.push(NOT_LIVE),
                Event::Done { order_id, .. } => {
                    let i = std::mem::replace(&mut self.pos[(order_id - 1) as usize], NOT_LIVE);
                    if i != NOT_LIVE {
                        self.live.swap_remove(i as usize);
                        if let Some(&moved) = self.live.get(i as usize) {
                            self.pos[(moved - 1) as usize] = i;
                        }
                    }
                }
                _ => {}
            }
        }
        self.out.push(cmd);
    }

    fn finish(mut self, setup_len: usize) -> Workload {
        let commands = self.out.split_off(setup_len);
        Workload {
            setup: self.out,
            commands,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a workload on a fresh engine: (cancels, rejected cancels, any
    /// other rejection).
    fn replay(w: &Workload) -> (usize, usize, usize) {
        let mut e = Engine::new(EngineConfig::default());
        let mut out = Vec::new();
        for cmd in &w.setup {
            out.clear();
            e.apply(*cmd, &mut out);
            assert!(!out.iter().any(|ev| matches!(ev, Event::Rejected { .. })));
        }
        let (mut cancels, mut rejected, mut other) = (0, 0, 0);
        for cmd in &w.commands {
            out.clear();
            e.apply(*cmd, &mut out);
            let rej = out.iter().any(|ev| matches!(ev, Event::Rejected { .. }));
            if matches!(cmd, Command::Cancel { .. }) {
                cancels += 1;
                rejected += rej as usize;
            } else {
                other += rej as usize;
            }
        }
        (cancels, rejected, other)
    }

    #[test]
    fn every_cancel_targets_a_live_order() {
        for seed in [1, 7, 99] {
            let (cancels, rejected, other) = replay(&standard(50_000, seed));
            assert!(cancels > 10_000, "the mix has cancels ({cancels})");
            assert_eq!(rejected, 0, "seed {seed}");
            assert_eq!(other, 0, "seed {seed}");
        }
    }

    #[test]
    fn deep_book_starts_with_a_million_orders_on_50k_levels() {
        let w = deep_book(20_000, 7);
        let mut e = Engine::new(EngineConfig::default());
        let mut out = Vec::new();
        for cmd in &w.setup {
            e.apply(*cmd, &mut out);
        }
        assert_eq!(e.resting_orders(), 1_000_000);
        assert_eq!(e.level_counts(), (25_000, 25_000));
        assert_eq!(replay(&w).1, 0, "no rejected cancels");
    }

    #[test]
    fn same_seed_same_commands() {
        assert_eq!(commands(10_000, 7), commands(10_000, 7));
        assert_ne!(commands(10_000, 7), commands(10_000, 8));
    }
}
