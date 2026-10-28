//! Realistic matching scenarios, each checked against the complete event
//! stream or the resulting book. They show the engine matches the way a
//! price-time priority exchange does: one order can trade with many resting
//! orders across many price levels, both sides can fill partially, trades
//! print at the resting order's price, a partly filled order keeps its place
//! in the queue, and the book never ends crossed.

use arena_engine::*;

const MAKER: Owner = 1;
const OTHER_MAKER: Owner = 2;
const TAKER: Owner = 3;

fn run(e: &mut Engine, cmd: Command) -> Vec<Event> {
    let mut out = Vec::new();
    e.apply(cmd, &mut out);
    e.check_invariants().unwrap();
    out
}

fn limit(owner: Owner, side: Side, price: Price, qty: Qty) -> Command {
    Command::Limit {
        owner,
        side,
        price,
        qty,
    }
}

/// (price, qty, maker id, taker id) for every trade, in order.
fn trades(events: &[Event]) -> Vec<(Price, Qty, OrderId, OrderId)> {
    events
        .iter()
        .filter_map(|e| match *e {
            Event::Trade {
                price,
                qty,
                maker_order_id,
                taker_order_id,
                ..
            } => Some((price, qty, maker_order_id, taker_order_id)),
            _ => None,
        })
        .collect()
}

fn level(price: Price, qty: Qty, orders: u32) -> BookLevel {
    BookLevel { price, qty, orders }
}

/// One aggressive buy trades with three resting sells on two price levels,
/// skips nothing, stops at its limit, and rests the remainder at its own
/// limit price (not at the last trade price). The whole event stream,
/// including market data, is checked.
#[test]
fn one_order_sweeps_several_levels_and_rests_the_remainder_at_its_limit() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Sell, 100, 5)); // 1
    run(&mut e, limit(OTHER_MAKER, Side::Sell, 100, 5)); // 2: same price, later
    run(&mut e, limit(MAKER, Side::Sell, 101, 3)); // 3
    run(&mut e, limit(MAKER, Side::Sell, 103, 10)); // 4: beyond the buyer's limit

    let ev = run(&mut e, limit(TAKER, Side::Buy, 102, 20)); // 5
    let trade = |trade_id, price, qty, maker_order_id, maker_owner| Event::Trade {
        trade_id,
        price,
        qty,
        maker_order_id,
        taker_order_id: 5,
        maker_owner,
        taker_owner: TAKER,
        aggressor: Side::Buy,
    };
    let filled = |order_id, owner| Event::Done {
        order_id,
        owner,
        reason: DoneReason::Filled,
        remaining_qty: 0,
    };
    assert_eq!(
        ev,
        vec![
            Event::Accepted {
                order_id: 5,
                owner: TAKER,
                side: Side::Buy,
                price: 102,
                qty: 20,
                market: false
            },
            trade(1, 100, 5, 1, MAKER),
            filled(1, MAKER),
            trade(2, 100, 5, 2, OTHER_MAKER),
            filled(2, OTHER_MAKER),
            trade(3, 101, 3, 3, MAKER),
            filled(3, MAKER),
            Event::Level {
                side: Side::Sell,
                price: 100,
                qty: 0,
                orders: 0
            },
            Event::Level {
                side: Side::Sell,
                price: 101,
                qty: 0,
                orders: 0
            },
            Event::Level {
                side: Side::Buy,
                price: 102,
                qty: 7,
                orders: 1
            },
        ]
    );
    assert_eq!(e.order(5).unwrap().status, OrderStatus::Partial);
    assert_eq!(
        e.depth(5),
        (vec![level(102, 7, 1)], vec![level(103, 10, 1)]),
        "remainder rests at 102; 103 untouched; book not crossed"
    );
}

/// The mirror image: a sell trades with the highest bids first, splits the
/// last fill, and the partly filled bid stays at the front of its level.
#[test]
fn a_sell_takes_the_highest_bids_first() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Buy, 98, 5)); // 1
    run(&mut e, limit(MAKER, Side::Buy, 99, 5)); // 2
    run(&mut e, limit(OTHER_MAKER, Side::Buy, 99, 5)); // 3
    run(&mut e, limit(MAKER, Side::Buy, 100, 5)); // 4
    let ev = run(&mut e, limit(TAKER, Side::Sell, 99, 12)); // 5
    assert_eq!(
        trades(&ev),
        vec![(100, 5, 4, 5), (99, 5, 2, 5), (99, 2, 3, 5)]
    );
    assert_eq!(e.order(3).unwrap().remaining_qty, 3);
    assert_eq!(
        e.depth(5).0,
        vec![level(99, 3, 1), level(98, 5, 1)],
        "98 is below the seller's limit and untouched"
    );
}

/// Many small orders fill one large resting order over time. The large
/// order keeps its place at the front of the queue while partly filled, so
/// an order that arrived later at the same price waits until it is done.
#[test]
fn many_small_orders_fill_one_large_order_which_keeps_its_place() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Buy, 100, 100)); // 1: large, first
    run(&mut e, limit(OTHER_MAKER, Side::Buy, 100, 50)); // 2: same price, later
    for (taker_id, expected_remaining) in [(3, 70), (4, 40), (5, 10)] {
        let ev = run(&mut e, limit(TAKER, Side::Sell, 100, 30));
        assert_eq!(trades(&ev), vec![(100, 30, 1, taker_id)]);
        assert_eq!(e.order(1).unwrap().remaining_qty, expected_remaining);
        assert_eq!(
            e.queue_ahead(2),
            Some((1, expected_remaining)),
            "order 2 still waits behind order 1"
        );
    }
    // The fourth sell finishes order 1, then moves on to order 2.
    let ev = run(&mut e, limit(TAKER, Side::Sell, 100, 30)); // 6
    assert_eq!(trades(&ev), vec![(100, 10, 1, 6), (100, 20, 2, 6)]);
    assert_eq!(e.order(1).unwrap().status, OrderStatus::Filled);
    assert_eq!(e.order(2).unwrap().remaining_qty, 30);
    assert_eq!(e.depth(5).0, vec![level(100, 30, 1)]);
}

/// A buy at a better price than the best ask is filled at the ask: the
/// buyer gets the price improvement, the trade prints at the maker's price.
#[test]
fn an_aggressive_order_gets_the_resting_price() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Sell, 100, 5));
    let ev = run(&mut e, limit(TAKER, Side::Buy, 110, 5));
    assert_eq!(trades(&ev), vec![(100, 5, 1, 2)]);
}

/// Orders on the same side never trade with each other, and orders that
/// only touch (buy at exactly the best ask) do trade.
#[test]
fn same_side_orders_never_trade_and_touching_orders_do() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Buy, 100, 5));
    let ev = run(&mut e, limit(TAKER, Side::Buy, 101, 5));
    assert!(trades(&ev).is_empty());
    assert_eq!(e.depth(5).0, vec![level(101, 5, 1), level(100, 5, 1)]);

    run(&mut e, limit(MAKER, Side::Sell, 102, 5)); // 3
    let ev = run(&mut e, limit(TAKER, Side::Buy, 102, 5)); // 4
    assert_eq!(trades(&ev), vec![(102, 5, 3, 4)]);
}

/// Cancelling a partly filled order cancels only what is left; what already
/// traded stays traded.
#[test]
fn cancelling_a_partly_filled_order_cancels_only_the_remainder() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Buy, 100, 10)); // 1
    run(&mut e, limit(TAKER, Side::Sell, 100, 4)); // 2
    let ev = run(
        &mut e,
        Command::Cancel {
            owner: MAKER,
            order_id: 1,
        },
    );
    assert_eq!(
        ev,
        vec![
            Event::Done {
                order_id: 1,
                owner: MAKER,
                reason: DoneReason::Cancelled,
                remaining_qty: 6
            },
            Event::Level {
                side: Side::Buy,
                price: 100,
                qty: 0,
                orders: 0
            },
        ]
    );
    let o = e.order(1).unwrap();
    assert_eq!(
        (o.original_qty, o.remaining_qty),
        (10, 6),
        "4 stayed traded"
    );
}

/// A market order with nothing on the other side is accepted and expires
/// in full: no trade, nothing rests, and the id is used.
#[test]
fn a_market_order_into_an_empty_book_expires() {
    let mut e = Engine::new(EngineConfig::default());
    run(&mut e, limit(MAKER, Side::Buy, 100, 5)); // 1: same side, irrelevant
    let ev = run(
        &mut e,
        Command::Market {
            owner: TAKER,
            side: Side::Buy,
            qty: 7,
        },
    );
    assert_eq!(
        ev,
        vec![
            Event::Accepted {
                order_id: 2,
                owner: TAKER,
                side: Side::Buy,
                price: Price::MAX,
                qty: 7,
                market: true
            },
            Event::Done {
                order_id: 2,
                owner: TAKER,
                reason: DoneReason::Expired,
                remaining_qty: 7
            },
        ]
    );
    assert_eq!(e.depth(5).0, vec![level(100, 5, 1)]);
}
