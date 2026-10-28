//! The order book: two sides, each a `BTreeMap` of price levels, each level a
//! FIFO queue of order ids.
//!
//! Cancels are lazy: a cancelled order stays in its level's queue as a
//! tombstone and is skipped when it reaches the front. The level's quantity
//! and live-order count are updated immediately, so market data is always
//! exact, and cancelling costs O(log levels) instead of a queue scan. A
//! level is dropped (with its tombstones) as soon as it has no live orders.
//!
//! The book stores ids, not orders: order state lives in the engine's order
//! store. Each type here keeps its own invariants, and only this crate can
//! change a book.

use std::collections::{BTreeMap, VecDeque};

use crate::types::{BookLevel, OrderId, Price, Qty, Side};

/// One price level: the queue in time priority, and running totals over its
/// live orders (`qty` is their remaining quantity, `live` their number).
#[derive(Debug, Default, Clone)]
pub struct Level {
    queue: VecDeque<OrderId>,
    qty: Qty,
    live: u32,
}

impl Level {
    /// Remaining quantity of the live orders here.
    pub fn qty(&self) -> Qty {
        self.qty
    }

    /// Number of live orders here.
    pub fn live_orders(&self) -> u32 {
        self.live
    }

    /// Every id queued here, front first, including cancelled orders not yet
    /// removed (callers check each order's status).
    pub fn ids(&self) -> impl Iterator<Item = OrderId> + '_ {
        self.queue.iter().copied()
    }

    fn view(&self, price: Price) -> BookLevel {
        BookLevel {
            price,
            qty: self.qty,
            orders: self.live,
        }
    }

    fn add(&mut self, id: OrderId, qty: Qty) {
        self.queue.push_back(id);
        self.qty += qty;
        self.live += 1;
    }

    fn is_empty(&self) -> bool {
        self.live == 0
    }
}

/// One side of the book.
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

    /// Aggregated levels, best first.
    pub fn levels(&self, depth: usize) -> Vec<BookLevel> {
        let view = |(p, l): (&Price, &Level)| l.view(*p);
        match self.side {
            Side::Buy => self.levels.iter().rev().take(depth).map(view).collect(),
            Side::Sell => self.levels.iter().take(depth).map(view).collect(),
        }
    }

    pub fn level_count(&self) -> usize {
        self.levels.len()
    }

    /// Number of live orders on this side.
    pub fn resting_orders(&self) -> u64 {
        self.levels.values().map(|l| u64::from(l.live)).sum()
    }

    /// Every (price, level) in ascending price order (for hashing and checks).
    pub fn iter(&self) -> impl Iterator<Item = (&Price, &Level)> {
        self.levels.iter()
    }

    /// Queues a live order at the back of its level.
    pub(crate) fn add(&mut self, price: Price, id: OrderId, qty: Qty) {
        self.levels.entry(price).or_default().add(id, qty);
    }

    /// The id at the front of a level's queue (it may be a tombstone).
    pub(crate) fn front(&self, price: Price) -> Option<OrderId> {
        self.levels.get(&price)?.queue.front().copied()
    }

    /// Removes the tombstone of a cancelled order from the front of a level.
    pub(crate) fn drop_tombstone(&mut self, price: Price) {
        self.level_mut(price).queue.pop_front();
    }

    /// The live order at the front of a level traded `qty`; `filled` if
    /// that finished it, in which case it leaves the queue. Drops the level
    /// once it has no live orders.
    pub(crate) fn fill_front(&mut self, price: Price, qty: Qty, filled: bool) {
        let level = self.level_mut(price);
        level.qty -= qty;
        if filled {
            level.queue.pop_front();
            level.live -= 1;
        }
        if level.is_empty() {
            self.levels.remove(&price);
        }
    }

    /// A live order with `remaining` unfilled was cancelled. Its id stays
    /// queued as a tombstone; the totals change now. Drops the level once
    /// it has no live orders.
    pub(crate) fn cancel(&mut self, price: Price, remaining: Qty) {
        let level = self.level_mut(price);
        level.qty -= remaining;
        level.live -= 1;
        if level.is_empty() {
            self.levels.remove(&price);
        }
    }

    /// A level that a live order rests in. Its absence is an engine bug,
    /// not bad input, so it panics rather than being skipped.
    fn level_mut(&mut self, price: Price) -> &mut Level {
        self.levels
            .get_mut(&price)
            .expect("a level with live orders exists")
    }
}

/// Both sides of the book.
#[derive(Debug, Clone)]
pub struct Book {
    bids: BookSide,
    asks: BookSide,
}

impl Default for Book {
    fn default() -> Self {
        Book {
            bids: BookSide::new(Side::Buy),
            asks: BookSide::new(Side::Sell),
        }
    }
}

impl Book {
    pub fn side(&self, side: Side) -> &BookSide {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    pub(crate) fn side_mut(&mut self, side: Side) -> &mut BookSide {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    /// Bids then asks.
    pub fn sides(&self) -> [&BookSide; 2] {
        [&self.bids, &self.asks]
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.best_price()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.best_price()
    }

    /// Number of price levels: (bids, asks).
    pub fn level_counts(&self) -> (usize, usize) {
        (self.bids.level_count(), self.asks.level_count())
    }

    /// Number of live orders resting in the book (O(levels)).
    pub fn resting_orders(&self) -> u64 {
        self.bids.resting_orders() + self.asks.resting_orders()
    }

    /// Aggregated book, best levels first: (bids, asks).
    pub fn depth(&self, levels: usize) -> (Vec<BookLevel>, Vec<BookLevel>) {
        (self.bids.levels(levels), self.asks.levels(levels))
    }

    /// Current totals of a level as market data (zero once it is gone).
    pub fn level_view(&self, side: Side, price: Price) -> BookLevel {
        self.side(side).level(price).map_or(
            BookLevel {
                price,
                qty: 0,
                orders: 0,
            },
            |l| l.view(price),
        )
    }
}
