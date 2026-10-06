use arena_engine::*;

fn engine() -> Engine {
    Engine::new(EngineConfig::default())
}

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

#[test]
fn ids_start_at_one_and_rest_without_a_cross() {
    let mut e = engine();
    let ev = run(&mut e, limit(1, Side::Buy, 100, 10));
    assert!(matches!(ev[0], Event::Accepted { order_id: 1, .. }));
    assert_eq!(
        ev.last(),
        Some(&Event::Level {
            side: Side::Buy,
            price: 100,
            qty: 10,
            orders: 1
        })
    );
    assert_eq!(e.best_bid(), Some(100));
}

#[test]
fn trades_at_the_resting_price() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Sell, 101, 5));
    let ev = run(&mut e, limit(2, Side::Buy, 105, 5));
    assert_eq!(trades(&ev), vec![(101, 5, 1, 2)]);
}

#[test]
fn price_priority_then_time_priority() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Sell, 102, 5)); // 1
    run(&mut e, limit(1, Side::Sell, 101, 5)); // 2: better price
    run(&mut e, limit(1, Side::Sell, 101, 5)); // 3: same price, later
    let ev = run(&mut e, limit(2, Side::Buy, 102, 12));
    assert_eq!(
        trades(&ev),
        vec![(101, 5, 2, 4), (101, 5, 3, 4), (102, 2, 1, 4)]
    );
    assert_eq!(e.order(1).unwrap().status, OrderStatus::Partial);
    assert_eq!(e.order(4).unwrap().status, OrderStatus::Filled);
}

#[test]
fn partial_fill_rests_the_remainder() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Sell, 100, 3));
    let ev = run(&mut e, limit(2, Side::Buy, 100, 10));
    assert_eq!(trades(&ev), vec![(100, 3, 1, 2)]);
    assert_eq!(
        e.depth(5).0[0],
        BookLevel {
            price: 100,
            qty: 7,
            orders: 1
        }
    );
    assert!(e.depth(5).1.is_empty());
}

#[test]
fn cancel_skips_the_order_and_keeps_queue_order() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Buy, 100, 5)); // 1
    run(&mut e, limit(2, Side::Buy, 100, 5)); // 2
    run(&mut e, limit(3, Side::Buy, 100, 5)); // 3
    let ev = run(
        &mut e,
        Command::Cancel {
            owner: 1,
            order_id: 1,
        },
    );
    assert!(ev.contains(&Event::Level {
        side: Side::Buy,
        price: 100,
        qty: 10,
        orders: 2
    }));
    let ev = run(&mut e, limit(4, Side::Sell, 100, 7));
    assert_eq!(trades(&ev), vec![(100, 5, 2, 4), (100, 2, 3, 4)]);
}

#[test]
fn cancelling_the_last_order_removes_the_level() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Sell, 100, 5));
    let ev = run(
        &mut e,
        Command::Cancel {
            owner: 1,
            order_id: 1,
        },
    );
    assert!(ev.contains(&Event::Level {
        side: Side::Sell,
        price: 100,
        qty: 0,
        orders: 0
    }));
    assert_eq!(e.best_ask(), None);
}

#[test]
fn market_order_sweeps_and_the_rest_expires() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Sell, 100, 3));
    run(&mut e, limit(1, Side::Sell, 103, 3));
    let ev = run(
        &mut e,
        Command::Market {
            owner: 2,
            side: Side::Buy,
            qty: 10,
        },
    );
    assert_eq!(trades(&ev), vec![(100, 3, 1, 3), (103, 3, 2, 3)]);
    assert!(ev.contains(&Event::Done {
        order_id: 3,
        owner: 2,
        reason: DoneReason::Expired,
        remaining_qty: 4
    }));
    assert_eq!(e.best_ask(), None);
    assert_eq!(e.best_bid(), None, "a market order never rests");
}

#[test]
fn rejects_change_nothing() {
    let mut e = Engine::new(EngineConfig {
        tick: 5,
        max_qty: 1000,
    });
    for (cmd, reason) in [
        (limit(1, Side::Buy, 0, 5), RejectReason::BadPrice),
        (limit(1, Side::Buy, 102, 5), RejectReason::BadPrice),
        (limit(1, Side::Buy, 100, 0), RejectReason::BadQty),
        (limit(1, Side::Buy, 100, 1001), RejectReason::BadQty),
        (
            Command::Cancel {
                owner: 1,
                order_id: 9,
            },
            RejectReason::UnknownOrder,
        ),
    ] {
        assert_eq!(run(&mut e, cmd), vec![Event::Rejected { owner: 1, reason }]);
    }
    assert_eq!(e.order_count(), 0);
}

#[test]
fn only_the_owner_can_cancel_and_only_once() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Buy, 100, 5));
    assert_eq!(
        run(
            &mut e,
            Command::Cancel {
                owner: 2,
                order_id: 1
            }
        ),
        vec![Event::Rejected {
            owner: 2,
            reason: RejectReason::NotOwner
        }]
    );
    run(
        &mut e,
        Command::Cancel {
            owner: 1,
            order_id: 1,
        },
    );
    assert_eq!(
        run(
            &mut e,
            Command::Cancel {
                owner: 1,
                order_id: 1
            }
        ),
        vec![Event::Rejected {
            owner: 1,
            reason: RejectReason::NotCancellable
        }]
    );
}

#[test]
fn queue_shows_live_orders_front_first() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Buy, 100, 5));
    run(&mut e, limit(0, Side::Buy, 100, 5));
    run(
        &mut e,
        Command::Cancel {
            owner: 1,
            order_id: 1,
        },
    );
    let q: Vec<_> = e.queue(Side::Buy, 100).iter().map(|o| o.id).collect();
    assert_eq!(q, vec![2]);
    run(&mut e, limit(3, Side::Buy, 100, 7));
    assert_eq!(e.queue_ahead(3), Some((1, 5)), "behind order 2 only");
    assert_eq!(e.queue_ahead(1), None, "cancelled");
}

/// Seeded random commands; invariants hold after every one, and quantity is
/// conserved across every trade.
#[test]
fn invariants_hold_over_random_streams() {
    for seed in 1..=20 {
        let mut rng = sim::Rng::new(seed);
        let mut e = Engine::new(EngineConfig::default());
        let mut out = Vec::new();
        for _ in 0..10_000 {
            let owner = rng.below(4) as Owner;
            let side = if rng.chance(500) {
                Side::Buy
            } else {
                Side::Sell
            };
            let cmd = match rng.below(10) {
                0..=5 => Command::Limit {
                    owner,
                    side,
                    price: 90 + rng.below(21) as Price,
                    qty: 1 + rng.below(50),
                },
                6 => Command::Market {
                    owner,
                    side,
                    qty: 1 + rng.below(80),
                },
                _ => Command::Cancel {
                    owner,
                    order_id: 1 + rng.below(e.order_count() as u64 + 1),
                },
            };
            out.clear();
            e.apply(cmd, &mut out);
            if let Err(msg) = e.check_invariants() {
                panic!("seed {seed}: {msg}");
            }
        }
    }
}
