//! A seeded, exchange-like command mix for benchmarks: 60% limit orders
//! around a slowly moving mid, 25% cancels of live orders, 15% market orders.
//! Shared by the native benchmark and the in-browser one, so both measure
//! the same thing.

use crate::sim::Rng;
use crate::types::{Command, Side};

/// Generates the command mix up front so generation isn't timed.
pub fn commands(n: usize, seed: u64) -> Vec<Command> {
    let mut rng = Rng::new(seed);
    let mut mid: i64 = 10_000;
    let mut next_id: u64 = 1;
    let mut live: Vec<u64> = Vec::new();
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if rng.chance(20) {
            mid += rng.below(5) as i64 - 2;
        }
        let side = if rng.chance(500) {
            Side::Buy
        } else {
            Side::Sell
        };
        match rng.below(100) {
            0..=59 => {
                let off = rng.below(20) as i64 - 2;
                let price = if side == Side::Buy {
                    mid - off
                } else {
                    mid + off
                };
                out.push(Command::Limit {
                    owner: 1,
                    side,
                    price,
                    qty: 1 + rng.below(100),
                });
                live.push(next_id);
                next_id += 1;
            }
            60..=84 if !live.is_empty() => {
                let i = rng.below(live.len() as u64) as usize;
                out.push(Command::Cancel {
                    owner: 1,
                    order_id: live.swap_remove(i),
                });
            }
            _ => {
                out.push(Command::Market {
                    owner: 1,
                    side,
                    qty: 1 + rng.below(50),
                });
                next_id += 1;
            }
        }
    }
    out
}
