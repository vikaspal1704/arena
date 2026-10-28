//! The matching engine: price-time priority, single instrument, no floats.
//!
//! `Engine` coordinates three parts that each keep their own invariants:
//! the `Book` (price levels and their totals), the `OrderStore` (every
//! accepted order, by id) and `LevelChanges` (which levels to publish after
//! a command). It validates commands, runs the matching loop and emits
//! events; it never edits a level's or an order's fields directly.

use crate::book::Book;
use crate::orders::OrderStore;
use crate::types::{
    BookLevel, Command, DoneReason, Event, Order, OrderId, OrderStatus, Owner, Price, Qty,
    RejectReason, Side,
};

/// Largest `max_qty` an engine accepts: 2^32.
///
/// A level's total quantity is a `u64` and its order count a `u32`. With
/// orders of at most 2^32 units, the total can only overflow once a single
/// price holds 2^32 orders, which the order count cannot represent either
/// (and which would need over 200 GB of order archive). Above this bound a
/// handful of large orders could wrap the total, so `Engine::new` refuses it.
pub const MAX_ORDER_QTY: Qty = 1 << 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineConfig {
    /// Prices must be a multiple of this (1 = any integer price).
    pub tick: Price,
    /// Largest quantity a single order may have (at most `MAX_ORDER_QTY`).
    pub max_qty: Qty,
    /// What happens when an incoming order would trade with a resting order
    /// of the same owner. Off by default, which is the reference behaviour.
    pub self_trade: SelfTradePrevention,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            tick: 1,
            max_qty: 1_000_000_000,
            self_trade: SelfTradePrevention::Off,
        }
    }
}

/// Self-trade prevention policy. Owners are identified by `Owner`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelfTradePrevention {
    /// Orders of the same owner trade with each other like any others
    /// (the reference engine's behaviour).
    #[default]
    Off,
    /// Cancel newest: when the next resting order an incoming order would
    /// trade with (best price, then time priority, skipping cancelled
    /// orders) has the same owner, the incoming order stops matching and
    /// its remaining quantity is cancelled with `DoneReason::SelfTrade`.
    /// The resting order is left untouched, trades already made with other
    /// owners stand, and the incoming order never rests. A market order's
    /// remainder is reported as `SelfTrade`, not `Expired`.
    CancelNewest,
}

impl SelfTradePrevention {
    /// Whether matching must stop before a trade between these owners.
    fn blocks(self, maker: Owner, taker: Owner) -> bool {
        self == SelfTradePrevention::CancelNewest && maker == taker
    }
}

/// Levels changed by the current command, in first-touched order, so that
/// each is published once as an `Event::Level`.
#[derive(Debug, Clone, Default)]
struct LevelChanges(Vec<(Side, Price)>);

impl LevelChanges {
    fn touch(&mut self, side: Side, price: Price) {
        if !self.0.contains(&(side, price)) {
            self.0.push((side, price));
        }
    }

    fn clear(&mut self) {
        self.0.clear();
    }
}

/// Why matching stopped, when the incoming order may still have quantity left.
#[derive(PartialEq, Eq)]
enum MatchEnd {
    /// Filled, or nothing left on the other side that it crosses.
    Exhausted,
    /// Self-trade prevention stopped it.
    SelfTrade,
}

#[derive(Debug, Clone)]
pub struct Engine {
    config: EngineConfig,
    book: Book,
    orders: OrderStore,
    next_trade_id: u64,
    changes: LevelChanges,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Self {
        assert!(config.tick >= 1, "tick must be >= 1");
        assert!(
            config.max_qty <= MAX_ORDER_QTY,
            "max_qty must be <= MAX_ORDER_QTY (2^32)"
        );
        Engine {
            config,
            book: Book::default(),
            orders: OrderStore::default(),
            next_trade_id: 1,
            changes: LevelChanges::default(),
        }
    }

    /// Like `new`, with room for `orders` orders allocated and touched up
    /// front, so the hot path never grows a vector or takes a page fault.
    pub fn with_capacity(config: EngineConfig, orders: usize) -> Self {
        let mut e = Engine::new(config);
        e.orders.preallocate(orders);
        e.changes.0.reserve(64);
        e
    }

    pub fn config(&self) -> EngineConfig {
        self.config
    }

    /// Applies one command and appends what happened to `out`. Never panics
    /// on bad input: invalid commands produce a `Rejected` event and change
    /// nothing.
    pub fn apply(&mut self, cmd: Command, out: &mut Vec<Event>) {
        self.changes.clear();
        let result = match cmd {
            Command::Limit {
                owner,
                side,
                price,
                qty,
            } => self.limit(owner, side, price, qty, out),
            Command::Market { owner, side, qty } => self.market(owner, side, qty, out),
            Command::Cancel { owner, order_id } => self.cancel(owner, order_id, out),
        };
        match result {
            Ok(()) => self.publish_levels(out),
            Err(reason) => out.push(Event::Rejected {
                owner: cmd_owner(&cmd),
                reason,
            }),
        }
    }

    /// Matches what crosses, then rests whatever is left at the limit price.
    fn limit(
        &mut self,
        owner: Owner,
        side: Side,
        price: Price,
        qty: Qty,
        out: &mut Vec<Event>,
    ) -> Result<(), RejectReason> {
        self.validate_price(price)?;
        self.validate_qty(qty)?;
        let id = self.accept(owner, side, price, qty, false, out);
        self.match_and_report(id, out);
        let order = self.orders.issued(id);
        if order.is_live() {
            let remaining = order.remaining_qty;
            self.book.side_mut(side).add(price, id, remaining);
            self.changes.touch(side, price);
        }
        Ok(())
    }

    /// A limit at the worst possible price whose unfilled part expires
    /// (immediate-or-cancel).
    fn market(
        &mut self,
        owner: Owner,
        side: Side,
        qty: Qty,
        out: &mut Vec<Event>,
    ) -> Result<(), RejectReason> {
        self.validate_qty(qty)?;
        let worst = match side {
            Side::Buy => Price::MAX,
            Side::Sell => 1,
        };
        let id = self.accept(owner, side, worst, qty, true, out);
        self.match_and_report(id, out);
        let order = self.orders.issued_mut(id);
        if order.is_live() {
            order.cancel();
            out.push(Event::Done {
                order_id: id,
                owner,
                reason: DoneReason::Expired,
                remaining_qty: order.remaining_qty,
            });
        }
        Ok(())
    }

    /// Cancels a live order of `owner`. Lazy: the order's id stays in its
    /// level's queue as a tombstone (see `book`).
    fn cancel(
        &mut self,
        owner: Owner,
        order_id: OrderId,
        out: &mut Vec<Event>,
    ) -> Result<(), RejectReason> {
        let order = self
            .orders
            .get_mut(order_id)
            .ok_or(RejectReason::UnknownOrder)?;
        if !order.is_live() {
            return Err(RejectReason::NotCancellable);
        }
        if order.owner != owner {
            return Err(RejectReason::NotOwner);
        }
        order.cancel();
        let (side, price, remaining) = (order.side, order.price, order.remaining_qty);
        out.push(Event::Done {
            order_id,
            owner,
            reason: DoneReason::Cancelled,
            remaining_qty: remaining,
        });
        self.book.side_mut(side).cancel(price, remaining);
        self.changes.touch(side, price);
        Ok(())
    }

    fn validate_price(&self, price: Price) -> Result<(), RejectReason> {
        if price < 1 || price % self.config.tick != 0 {
            Err(RejectReason::BadPrice)
        } else {
            Ok(())
        }
    }

    fn validate_qty(&self, qty: Qty) -> Result<(), RejectReason> {
        if qty == 0 || qty > self.config.max_qty {
            Err(RejectReason::BadQty)
        } else {
            Ok(())
        }
    }

    fn accept(
        &mut self,
        owner: Owner,
        side: Side,
        price: Price,
        qty: Qty,
        market: bool,
        out: &mut Vec<Event>,
    ) -> OrderId {
        let id = self.orders.next_id();
        self.orders.insert(Order::new(id, owner, side, price, qty));
        out.push(Event::Accepted {
            order_id: id,
            owner,
            side,
            price,
            qty,
            market,
        });
        id
    }

    /// Runs the matching loop for an accepted order, then reports how it
    /// ended if it is finished (filled, or stopped by self-trade prevention).
    fn match_and_report(&mut self, taker_id: OrderId, out: &mut Vec<Event>) {
        let end = self.match_order(taker_id, out);
        let taker = self.orders.issued_mut(taker_id);
        if end == MatchEnd::SelfTrade {
            taker.cancel();
            out.push(Event::Done {
                order_id: taker_id,
                owner: taker.owner,
                reason: DoneReason::SelfTrade,
                remaining_qty: taker.remaining_qty,
            });
        } else if taker.status == OrderStatus::Filled {
            out.push(Event::Done {
                order_id: taker_id,
                owner: taker.owner,
                reason: DoneReason::Filled,
                remaining_qty: 0,
            });
        }
    }

    /// Trades the incoming order against the best opposite level, front of
    /// the queue first, for as long as it has quantity and crosses: one
    /// order can trade with many resting orders across many levels. Every
    /// trade prints at the resting (maker) order's price.
    fn match_order(&mut self, taker_id: OrderId, out: &mut Vec<Event>) -> MatchEnd {
        let Engine {
            config,
            book,
            orders,
            next_trade_id,
            changes,
        } = self;
        let (taker_side, taker_owner) = {
            let t = orders.issued(taker_id);
            (t.side, t.owner)
        };
        let maker_side = taker_side.opposite();
        let makers = book.side_mut(maker_side);
        loop {
            let taker = orders.issued(taker_id);
            if taker.remaining_qty == 0 {
                return MatchEnd::Exhausted;
            }
            let Some(price) = makers.best_price().filter(|&p| taker.crosses(p)) else {
                return MatchEnd::Exhausted;
            };
            let wanted = taker.remaining_qty;
            let maker_id = makers.front(price).expect("a level is never empty");
            let maker = orders.issued_mut(maker_id);
            if !maker.is_live() {
                makers.drop_tombstone(price);
                continue;
            }
            if config.self_trade.blocks(maker.owner, taker_owner) {
                return MatchEnd::SelfTrade;
            }
            let qty = wanted.min(maker.remaining_qty);
            maker.fill(qty);
            let (maker_owner, maker_filled) = (maker.owner, maker.remaining_qty == 0);
            makers.fill_front(price, qty, maker_filled);
            orders.issued_mut(taker_id).fill(qty);

            out.push(Event::Trade {
                trade_id: *next_trade_id,
                price,
                qty,
                maker_order_id: maker_id,
                taker_order_id: taker_id,
                maker_owner,
                taker_owner,
                aggressor: taker_side,
            });
            *next_trade_id += 1;
            if maker_filled {
                out.push(Event::Done {
                    order_id: maker_id,
                    owner: maker_owner,
                    reason: DoneReason::Filled,
                    remaining_qty: 0,
                });
            }
            changes.touch(maker_side, price);
        }
    }

    /// One `Level` event per level the command changed, with its new totals.
    fn publish_levels(&self, out: &mut Vec<Event>) {
        for &(side, price) in &self.changes.0 {
            let level = self.book.level_view(side, price);
            out.push(Event::Level {
                side,
                price,
                qty: level.qty,
                orders: level.orders,
            });
        }
    }

    pub fn book(&self) -> &Book {
        &self.book
    }

    pub fn order(&self, id: OrderId) -> Option<&Order> {
        self.orders.get(id)
    }

    pub fn order_count(&self) -> usize {
        self.orders.len()
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.book.best_bid()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.book.best_ask()
    }

    /// Number of price levels: (bids, asks).
    pub fn level_counts(&self) -> (usize, usize) {
        self.book.level_counts()
    }

    /// Number of live orders resting in the book (O(levels)).
    pub fn resting_orders(&self) -> u64 {
        self.book.resting_orders()
    }

    /// Aggregated book, best levels first.
    pub fn depth(&self, levels: usize) -> (Vec<BookLevel>, Vec<BookLevel>) {
        self.book.depth(levels)
    }

    /// Live orders in a level, front of the queue first (for showing queue position).
    pub fn queue(&self, side: Side, price: Price) -> Vec<&Order> {
        self.book
            .side(side)
            .level(price)
            .map(|l| self.live_orders(l.ids()).collect())
            .unwrap_or_default()
    }

    /// For a live resting order: how many live orders, and how much
    /// quantity, are ahead of it in its level's queue.
    pub fn queue_ahead(&self, id: OrderId) -> Option<(u32, Qty)> {
        let order = self.order(id).filter(|o| o.is_live())?;
        let level = self.book.side(order.side).level(order.price)?;
        let ahead = level.ids().take_while(|&other| other != id);
        Some(
            self.live_orders(ahead)
                .fold((0, 0), |(n, qty), o| (n + 1, qty + o.remaining_qty)),
        )
    }

    /// Structural hash of the resting book: every live order, by side,
    /// price and queue position. Two engines with equal hashes have the
    /// same book, order for order.
    pub fn book_hash(&self) -> u64 {
        let mut h = crate::hash::Fnv::new();
        for (tag, side) in [1u64, 2].into_iter().zip(self.book.sides()) {
            for (price, level) in side.iter() {
                h.write(tag);
                h.write(*price as u64);
                for o in self.live_orders(level.ids()) {
                    h.write(o.id);
                    h.write(o.remaining_qty);
                }
            }
        }
        h.finish()
    }

    /// Checks the invariants the tests rely on; returns the first violation.
    /// It recomputes every level from the orders themselves, so it does not
    /// trust the totals it is checking.
    pub fn check_invariants(&self) -> Result<(), String> {
        if let (Some(b), Some(a)) = (self.best_bid(), self.best_ask()) {
            if b >= a {
                return Err(format!("crossed book: bid {b} >= ask {a}"));
            }
        }
        for side in self.book.sides() {
            for (price, level) in side.iter() {
                let live: Vec<_> = self.live_orders(level.ids()).collect();
                if live.is_empty() {
                    return Err(format!("empty level kept at {price}"));
                }
                let qty: Qty = live.iter().map(|o| o.remaining_qty).sum();
                if qty != level.qty() || live.len() as u32 != level.live_orders() {
                    return Err(format!(
                        "level {price}: tracked {}/{} vs actual {}/{}",
                        level.qty(),
                        level.live_orders(),
                        qty,
                        live.len()
                    ));
                }
                if live.windows(2).any(|w| w[0].id > w[1].id) {
                    return Err(format!("level {price}: queue out of time priority"));
                }
            }
        }
        for o in self.orders.iter() {
            if o.remaining_qty > o.original_qty
                || (o.status == OrderStatus::Filled)
                    != (o.remaining_qty == 0 && o.status != OrderStatus::Cancelled)
            {
                return Err(format!(
                    "order {} has inconsistent state {:?}",
                    o.id, o.status
                ));
            }
        }
        Ok(())
    }

    /// The live orders among queued ids (skipping cancelled tombstones).
    fn live_orders<'a>(
        &'a self,
        ids: impl Iterator<Item = OrderId> + 'a,
    ) -> impl Iterator<Item = &'a Order> + 'a {
        ids.map(|id| self.orders.issued(id)).filter(|o| o.is_live())
    }
}

fn cmd_owner(cmd: &Command) -> Owner {
    match *cmd {
        Command::Limit { owner, .. }
        | Command::Market { owner, .. }
        | Command::Cancel { owner, .. } => owner,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tombstone limit in docs/ARCHITECTURE.md ("Known limits"): a level
    /// that keeps one live order and never trades keeps every cancelled id,
    /// and drops them all when its last live order goes.
    #[test]
    fn tombstones_accumulate_until_the_level_empties() {
        let mut e = Engine::new(EngineConfig::default());
        let mut out = Vec::new();
        let limit = |qty| Command::Limit {
            owner: 1,
            side: Side::Buy,
            price: 100,
            qty,
        };
        e.apply(limit(5), &mut out); // order 1 stays live
        for id in 2..=1_001 {
            e.apply(limit(1), &mut out);
            e.apply(
                Command::Cancel {
                    owner: 1,
                    order_id: id,
                },
                &mut out,
            );
        }
        let level = e.book.side(Side::Buy).level(100).unwrap();
        assert_eq!((level.live_orders(), level.ids().count()), (1, 1_001));
        e.apply(
            Command::Cancel {
                owner: 1,
                order_id: 1,
            },
            &mut out,
        );
        assert!(
            e.book.side(Side::Buy).level(100).is_none(),
            "level and tombstones dropped"
        );
    }
}
