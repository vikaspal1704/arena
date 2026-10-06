//! One side of the order book: price levels in a BTreeMap, each a FIFO queue.
//!
//! Cancels are lazy: a cancelled order stays in its level's queue as a
//! tombstone and is skipped when it reaches the front. The level's quantity
//! and live-order count are updated immediately, so market data is always
//! exact, and cancelling costs O(log levels) instead of a queue scan. A
//! level is dropped (with its tombstones) as soon as it has no live orders.

use std::collections::{BTreeMap, VecDeque};

use crate::types::{BookLevel, OrderId, Price, Qty, Side};

#[derive(Debug, Default, Clone)]
pub struct Level {
    pub queue: VecDeque<OrderId>,
    pub qty: Qty,
    pub live: u32,
}

#[derive(Debug, Clone)]
pub struct BookSide {
    side: Side,
    levels: BTreeMap<Price, Level>,
}

impl BookSide {
    pub fn new(side: Side) -> Self {
        BookSide {
            side,
            levels: BTreeMap::new(),
        }
    }

    /// Highest bid or lowest ask.
    pub fn best_price(&self) -> Option<Price> {
        match self.side {
            Side::Buy => self.levels.keys().next_back().copied(),
            Side::Sell => self.levels.keys().next().copied(),
        }
    }

    pub fn level(&self, price: Price) -> Option<&Level> {
        self.levels.get(&price)
    }

    pub fn level_mut(&mut self, price: Price) -> Option<&mut Level> {
        self.levels.get_mut(&price)
    }

    pub fn push(&mut self, price: Price, id: OrderId, qty: Qty) {
        let level = self.levels.entry(price).or_default();
        level.queue.push_back(id);
        level.qty += qty;
        level.live += 1;
    }

    /// Drops the level if it has no live orders left.
    pub fn prune(&mut self, price: Price) {
        if self.levels.get(&price).is_some_and(|l| l.live == 0) {
            self.levels.remove(&price);
        }
    }

    /// Aggregated levels, best first.
    pub fn levels(&self, depth: usize) -> Vec<BookLevel> {
        let view = |(p, l): (&Price, &Level)| BookLevel {
            price: *p,
            qty: l.qty,
            orders: l.live,
        };
        match self.side {
            Side::Buy => self.levels.iter().rev().take(depth).map(view).collect(),
            Side::Sell => self.levels.iter().take(depth).map(view).collect(),
        }
    }

    pub fn level_count(&self) -> usize {
        self.levels.len()
    }

    /// Every (price, level) in ascending price order (for hashing and checks).
    pub fn iter(&self) -> impl Iterator<Item = (&Price, &Level)> {
        self.levels.iter()
    }
}
