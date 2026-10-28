//! The order archive: every order the engine has accepted.
//!
//! Ids are dense, starting at 1, so the store is a `Vec` indexed by
//! `id - 1`: O(1) lookup with no hashing and no iteration order to leak into
//! results. Nothing is ever removed (see "Known limits" in
//! docs/ARCHITECTURE.md).

use crate::types::{Order, OrderId, OrderStatus, Side};

#[derive(Debug, Clone, Default)]
pub(crate) struct OrderStore {
    orders: Vec<Order>,
}

impl OrderStore {
    /// Allocates and touches room for `n` orders up front, so the hot path
    /// never grows the vector or takes a page fault.
    pub fn preallocate(&mut self, n: usize) {
        let blank = Order {
            id: 0,
            owner: 0,
            side: Side::Buy,
            price: 0,
            original_qty: 0,
            remaining_qty: 0,
            status: OrderStatus::Cancelled,
        };
        self.orders.resize(n, blank);
        self.orders.clear();
    }

    pub fn len(&self) -> usize {
        self.orders.len()
    }

    /// The id the next accepted order gets.
    pub fn next_id(&self) -> OrderId {
        self.orders.len() as OrderId + 1
    }

    /// Stores an order built with `next_id`.
    pub fn insert(&mut self, order: Order) {
        debug_assert_eq!(order.id, self.next_id());
        self.orders.push(order);
    }

    /// Looks up an id that came from outside the engine, which may not
    /// exist. Uses `try_from`, not `as`: `usize` is 32 bits on wasm32, where
    /// a cast would wrap a large id onto a real order.
    pub fn get(&self, id: OrderId) -> Option<&Order> {
        self.orders.get(Self::index(id)?)
    }

    pub fn get_mut(&mut self, id: OrderId) -> Option<&mut Order> {
        self.orders.get_mut(Self::index(id)?)
    }

    /// An order this engine issued, which always exists.
    pub fn issued(&self, id: OrderId) -> &Order {
        &self.orders[Self::issued_index(id)]
    }

    pub fn issued_mut(&mut self, id: OrderId) -> &mut Order {
        &mut self.orders[Self::issued_index(id)]
    }

    pub fn iter(&self) -> impl Iterator<Item = &Order> {
        self.orders.iter()
    }

    fn index(id: OrderId) -> Option<usize> {
        usize::try_from(id.checked_sub(1)?).ok()
    }

    /// Issued ids are at most the number of stored orders, so they fit.
    fn issued_index(id: OrderId) -> usize {
        (id - 1) as usize
    }
}
