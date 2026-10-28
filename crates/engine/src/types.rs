//! Plain data types shared by the engine, the sequencer and the bindings.
//!
//! Prices are integer ticks of the instrument's currency (paise for the
//! default instrument) and quantities are integer units. There are no floats
//! anywhere in the engine, so results are bit-for-bit reproducible.

/// Engine-assigned order id. Dense, starting at 1.
pub type OrderId = u64;
/// Price in the smallest currency unit (e.g. paise).
pub type Price = i64;
/// Quantity in units.
pub type Qty = u64;
/// Who sent an order (0 = the human player; bots use 1..).
pub type Owner = u32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    Open,
    Partial,
    Filled,
    Cancelled,
}

impl OrderStatus {
    pub fn is_live(self) -> bool {
        matches!(self, OrderStatus::Open | OrderStatus::Partial)
    }
}

/// An accepted order. The engine only hands out shared references, so
/// outside the crate an `Order` is a read-only view; its state changes only
/// through `fill` and `cancel`, which keep `status` and `remaining_qty`
/// consistent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: OrderId,
    pub owner: Owner,
    pub side: Side,
    pub price: Price,
    pub original_qty: Qty,
    pub remaining_qty: Qty,
    pub status: OrderStatus,
}

impl Order {
    pub(crate) fn new(id: OrderId, owner: Owner, side: Side, price: Price, qty: Qty) -> Self {
        Order {
            id,
            owner,
            side,
            price,
            original_qty: qty,
            remaining_qty: qty,
            status: OrderStatus::Open,
        }
    }

    /// Open or partly filled: it can still trade.
    pub fn is_live(&self) -> bool {
        self.status.is_live()
    }

    /// Whether a resting order on the other side at `price` would trade
    /// with this one: a buy takes asks at or below its limit, a sell takes
    /// bids at or above it.
    pub fn crosses(&self, price: Price) -> bool {
        match self.side {
            Side::Buy => price <= self.price,
            Side::Sell => price >= self.price,
        }
    }

    /// Records a fill of `qty` (at most what remains).
    pub(crate) fn fill(&mut self, qty: Qty) {
        self.remaining_qty -= qty;
        self.status = if self.remaining_qty == 0 {
            OrderStatus::Filled
        } else {
            OrderStatus::Partial
        };
    }

    /// Ends a live order; whatever is unfilled stays in `remaining_qty`.
    pub(crate) fn cancel(&mut self) {
        self.status = OrderStatus::Cancelled;
    }
}

/// An instruction to the exchange. Every command is sequenced and journalled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Rests whatever does not match immediately.
    Limit {
        owner: Owner,
        side: Side,
        price: Price,
        qty: Qty,
    },
    /// Immediate-or-cancel at any price: matches what it can, the rest expires.
    Market { owner: Owner, side: Side, qty: Qty },
    /// Cancels a live order. Only its owner may cancel it.
    Cancel { owner: Owner, order_id: OrderId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RejectReason {
    /// Price below 1 or not on the tick grid.
    BadPrice,
    /// Quantity of 0 or above the per-order maximum.
    BadQty,
    UnknownOrder,
    /// The order is already filled or cancelled.
    NotCancellable,
    /// Someone other than the owner tried to cancel.
    NotOwner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DoneReason {
    Filled,
    Cancelled,
    /// The unfilled part of a market order.
    Expired,
    /// The remainder of an incoming order, cancelled by self-trade
    /// prevention (`SelfTradePrevention::CancelNewest`).
    SelfTrade,
}

/// What the exchange says happened. Events are the only output: the book,
/// the market-data feed and every client view are derived from them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Event {
    Accepted {
        order_id: OrderId,
        owner: Owner,
        side: Side,
        price: Price,
        qty: Qty,
        market: bool,
    },
    Rejected {
        owner: Owner,
        reason: RejectReason,
    },
    /// Executed at the resting (maker) order's price.
    Trade {
        trade_id: u64,
        price: Price,
        qty: Qty,
        maker_order_id: OrderId,
        taker_order_id: OrderId,
        maker_owner: Owner,
        taker_owner: Owner,
        /// The taker's side.
        aggressor: Side,
    },
    Done {
        order_id: OrderId,
        owner: Owner,
        reason: DoneReason,
        remaining_qty: Qty,
    },
    /// L2 market data: the total quantity now resting at a level (0 = level gone).
    Level {
        side: Side,
        price: Price,
        qty: Qty,
        orders: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BookLevel {
    pub price: Price,
    pub qty: Qty,
    pub orders: u32,
}
