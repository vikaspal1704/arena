//! The matching engine: price-time priority, single instrument, no floats.

use crate::book::BookSide;
use crate::types::{
    BookLevel, Command, DoneReason, Event, Order, OrderId, OrderStatus, Owner, Price, Qty,
    RejectReason, Side,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineConfig {
    /// Prices must be a multiple of this (1 = any integer price).
    pub tick: Price,
    /// Largest quantity a single order may have.
    pub max_qty: Qty,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            tick: 1,
            max_qty: 1_000_000_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Engine {
    config: EngineConfig,
    bids: BookSide,
    asks: BookSide,
    /// Every order ever accepted; `orders[id - 1]`. Ids are dense, so this is
    /// both the index and the archive (no hash map, no iteration-order risk).
    orders: Vec<Order>,
    next_trade_id: u64,
    /// Levels changed by the current command, in first-touched order.
    touched: Vec<(Side, Price)>,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Self {
        assert!(config.tick >= 1, "tick must be >= 1");
        Engine {
            config,
            bids: BookSide::new(Side::Buy),
            asks: BookSide::new(Side::Sell),
            orders: Vec::new(),
            next_trade_id: 1,
            touched: Vec::new(),
        }
    }

    /// Like `new`, with room for `orders` orders allocated and touched up
    /// front, so the hot path never grows a vector or takes a page fault.
    pub fn with_capacity(config: EngineConfig, orders: usize) -> Self {
        let mut e = Engine::new(config);
        let blank = Order {
            id: 0,
            owner: 0,
            side: Side::Buy,
            price: 0,
            original_qty: 0,
            remaining_qty: 0,
            status: OrderStatus::Cancelled,
        };
        e.orders.resize(orders, blank);
        e.orders.clear();
        e.touched.reserve(64);
        e
    }

    pub fn config(&self) -> EngineConfig {
        self.config
    }

    /// Applies one command and appends what happened to `out`. Never panics
    /// on bad input: invalid commands produce a `Rejected` event and change
    /// nothing.
    pub fn apply(&mut self, cmd: Command, out: &mut Vec<Event>) {
        self.touched.clear();
        match cmd {
            Command::Limit {
                owner,
                side,
                price,
                qty,
            } => {
                if let Some(reason) = self.validate_price(price).or(self.validate_qty(qty)) {
                    out.push(Event::Rejected { owner, reason });
                    return;
                }
                let id = self.accept(owner, side, price, qty, false, out);
                self.match_order(id, out);
                let order = &self.orders[(id - 1) as usize];
                if order.remaining_qty > 0 {
                    let (side, price, rem) = (order.side, order.price, order.remaining_qty);
                    self.side_mut(side).push(price, id, rem);
                    self.touch(side, price);
                }
            }
            Command::Market { owner, side, qty } => {
                if let Some(reason) = self.validate_qty(qty) {
                    out.push(Event::Rejected { owner, reason });
                    return;
                }
                // A market order is a limit at the worst possible price, and
                // whatever doesn't fill immediately expires.
                let price = match side {
                    Side::Buy => Price::MAX,
                    Side::Sell => 1,
                };
                let id = self.accept(owner, side, price, qty, true, out);
                self.match_order(id, out);
                let order = &mut self.orders[(id - 1) as usize];
                if order.remaining_qty > 0 {
                    order.status = OrderStatus::Cancelled;
                    out.push(Event::Done {
                        order_id: id,
                        owner,
                        reason: DoneReason::Expired,
                        remaining_qty: order.remaining_qty,
                    });
                }
            }
            Command::Cancel { owner, order_id } => {
                if let Err(reason) = self.cancel(owner, order_id, out) {
                    out.push(Event::Rejected { owner, reason });
                    return;
                }
            }
        }
        self.emit_levels(out);
    }

    fn validate_price(&self, price: Price) -> Option<RejectReason> {
        (price < 1 || price % self.config.tick != 0).then_some(RejectReason::BadPrice)
    }

    fn validate_qty(&self, qty: Qty) -> Option<RejectReason> {
        (qty == 0 || qty > self.config.max_qty).then_some(RejectReason::BadQty)
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
        let id = self.orders.len() as OrderId + 1;
        self.orders.push(Order {
            id,
            owner,
            side,
            price,
            original_qty: qty,
            remaining_qty: qty,
            status: OrderStatus::Open,
        });
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

    fn match_order(&mut self, taker_id: OrderId, out: &mut Vec<Event>) {
        let Engine {
            bids,
            asks,
            orders,
            next_trade_id,
            touched,
            ..
        } = self;
        let (taker_side, limit) = {
            let t = &orders[(taker_id - 1) as usize];
            (t.side, t.price)
        };
        let book = match taker_side {
            Side::Buy => asks,
            Side::Sell => bids,
        };
        loop {
            let taker_rem = orders[(taker_id - 1) as usize].remaining_qty;
            if taker_rem == 0 {
                break;
            }
            let Some(best) = book.best_price() else { break };
            let crosses = match taker_side {
                Side::Buy => best <= limit,
                Side::Sell => best >= limit,
            };
            if !crosses {
                break;
            }
            let level = book.level_mut(best).expect("best level exists");
            let maker_id = *level.queue.front().expect("a live level has a queue");
            let maker = &mut orders[(maker_id - 1) as usize];
            if !maker.status.is_live() {
                level.queue.pop_front(); // tombstone of a cancelled order
                continue;
            }
            let qty = taker_rem.min(maker.remaining_qty);
            maker.remaining_qty -= qty;
            level.qty -= qty;
            let maker_owner = maker.owner;
            let maker_done = maker.remaining_qty == 0;
            if maker_done {
                maker.status = OrderStatus::Filled;
                level.queue.pop_front();
                level.live -= 1;
            } else {
                maker.status = OrderStatus::Partial;
            }
            let taker = &mut orders[(taker_id - 1) as usize];
            taker.remaining_qty -= qty;
            taker.status = if taker.remaining_qty == 0 {
                OrderStatus::Filled
            } else {
                OrderStatus::Partial
            };
            let taker_owner = taker.owner;

            out.push(Event::Trade {
                trade_id: *next_trade_id,
                price: best,
                qty,
                maker_order_id: maker_id,
                taker_order_id: taker_id,
                maker_owner,
                taker_owner,
                aggressor: taker_side,
            });
            *next_trade_id += 1;
            if maker_done {
                out.push(Event::Done {
                    order_id: maker_id,
                    owner: maker_owner,
                    reason: DoneReason::Filled,
                    remaining_qty: 0,
                });
            }
            if !touched.contains(&(taker_side.opposite(), best)) {
                touched.push((taker_side.opposite(), best));
            }
            book.prune(best);
        }
        let taker = &orders[(taker_id - 1) as usize];
        if taker.status == OrderStatus::Filled {
            out.push(Event::Done {
                order_id: taker_id,
                owner: taker.owner,
                reason: DoneReason::Filled,
                remaining_qty: 0,
            });
        }
    }

    fn cancel(
        &mut self,
        owner: Owner,
        order_id: OrderId,
        out: &mut Vec<Event>,
    ) -> Result<(), RejectReason> {
        let idx = order_id.checked_sub(1).ok_or(RejectReason::UnknownOrder)? as usize;
        let order = self.orders.get_mut(idx).ok_or(RejectReason::UnknownOrder)?;
        if !order.status.is_live() {
            return Err(RejectReason::NotCancellable);
        }
        if order.owner != owner {
            return Err(RejectReason::NotOwner);
        }
        order.status = OrderStatus::Cancelled;
        let (side, price, rem) = (order.side, order.price, order.remaining_qty);
        out.push(Event::Done {
            order_id,
            owner,
            reason: DoneReason::Cancelled,
            remaining_qty: rem,
        });
        let book = self.side_mut(side);
        let level = book.level_mut(price).expect("a live order's level exists");
        level.qty -= rem;
        level.live -= 1;
        book.prune(price);
        self.touch(side, price);
        Ok(())
    }

    fn touch(&mut self, side: Side, price: Price) {
        if !self.touched.contains(&(side, price)) {
            self.touched.push((side, price));
        }
    }

    fn emit_levels(&mut self, out: &mut Vec<Event>) {
        for &(side, price) in &self.touched {
            let (qty, orders) = self
                .side(side)
                .level(price)
                .map_or((0, 0), |l| (l.qty, l.live));
            out.push(Event::Level {
                side,
                price,
                qty,
                orders,
            });
        }
    }

    fn side(&self, side: Side) -> &BookSide {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    fn side_mut(&mut self, side: Side) -> &mut BookSide {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    pub fn order(&self, id: OrderId) -> Option<&Order> {
        id.checked_sub(1).and_then(|i| self.orders.get(i as usize))
    }

    pub fn order_count(&self) -> usize {
        self.orders.len()
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.best_price()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.best_price()
    }

    /// Aggregated book, best levels first.
    pub fn depth(&self, levels: usize) -> (Vec<BookLevel>, Vec<BookLevel>) {
        (self.bids.levels(levels), self.asks.levels(levels))
    }

    /// Live orders in a level, front of the queue first (for showing queue position).
    pub fn queue(&self, side: Side, price: Price) -> Vec<&Order> {
        self.side(side)
            .level(price)
            .map(|l| {
                l.queue
                    .iter()
                    .map(|id| &self.orders[(*id - 1) as usize])
                    .filter(|o| o.status.is_live())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// For a live resting order: how many live orders, and how much
    /// quantity, are ahead of it in its level's queue.
    pub fn queue_ahead(&self, id: OrderId) -> Option<(u32, Qty)> {
        let order = self.order(id).filter(|o| o.status.is_live())?;
        let level = self.side(order.side).level(order.price)?;
        let (mut n, mut qty) = (0u32, 0);
        for other in level.queue.iter().take_while(|o| **o != id) {
            let o = &self.orders[(*other - 1) as usize];
            if o.status.is_live() {
                n += 1;
                qty += o.remaining_qty;
            }
        }
        Some((n, qty))
    }

    /// Structural hash of the resting book: every live order, by side,
    /// price and queue position. Two engines with equal hashes have the
    /// same book, order for order.
    pub fn book_hash(&self) -> u64 {
        let mut h = crate::hash::Fnv::new();
        for (tag, side) in [(1u64, &self.bids), (2, &self.asks)] {
            for (price, level) in side.iter() {
                h.write(tag);
                h.write(*price as u64);
                for id in &level.queue {
                    let o = &self.orders[(*id - 1) as usize];
                    if o.status.is_live() {
                        h.write(o.id);
                        h.write(o.remaining_qty);
                    }
                }
            }
        }
        h.finish()
    }

    /// Checks the invariants the tests rely on; returns the first violation.
    pub fn check_invariants(&self) -> Result<(), String> {
        if let (Some(b), Some(a)) = (self.best_bid(), self.best_ask()) {
            if b >= a {
                return Err(format!("crossed book: bid {b} >= ask {a}"));
            }
        }
        for side in [&self.bids, &self.asks] {
            for (price, level) in side.iter() {
                let live: Vec<_> = level
                    .queue
                    .iter()
                    .map(|id| &self.orders[(*id - 1) as usize])
                    .filter(|o| o.status.is_live())
                    .collect();
                if live.is_empty() {
                    return Err(format!("empty level kept at {price}"));
                }
                let qty: Qty = live.iter().map(|o| o.remaining_qty).sum();
                if qty != level.qty || live.len() as u32 != level.live {
                    return Err(format!(
                        "level {price}: tracked {}/{} vs actual {}/{}",
                        level.qty,
                        level.live,
                        qty,
                        live.len()
                    ));
                }
                if live.windows(2).any(|w| w[0].id > w[1].id) {
                    return Err(format!("level {price}: queue out of time priority"));
                }
            }
        }
        for o in &self.orders {
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
}
