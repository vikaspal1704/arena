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
        ..EngineConfig::default()
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

fn stp_engine() -> Engine {
    Engine::new(EngineConfig {
        self_trade: SelfTradePrevention::CancelNewest,
        ..EngineConfig::default()
    })
}

#[test]
fn without_stp_an_owner_trades_with_itself() {
    let mut e = engine();
    run(&mut e, limit(1, Side::Sell, 100, 5));
    let ev = run(&mut e, limit(1, Side::Buy, 100, 5));
    assert!(ev.contains(&Event::Trade {
        trade_id: 1,
        price: 100,
        qty: 5,
        maker_order_id: 1,
        taker_order_id: 2,
        maker_owner: 1,
        taker_owner: 1,
        aggressor: Side::Buy,
    }));
}

#[test]
fn stp_cancels_the_incoming_order_and_keeps_the_resting_one() {
    let mut e = stp_engine();
    run(&mut e, limit(1, Side::Sell, 100, 5));
    let ev = run(&mut e, limit(1, Side::Buy, 101, 8));
    assert_eq!(
        ev,
        vec![
            Event::Accepted {
                order_id: 2,
                owner: 1,
                side: Side::Buy,
                price: 101,
                qty: 8,
                market: false
            },
            Event::Done {
                order_id: 2,
                owner: 1,
                reason: DoneReason::SelfTrade,
                remaining_qty: 8
            },
        ],
        "no trade, no level change"
    );
    assert_eq!(e.order(1).unwrap().status, OrderStatus::Open);
    assert_eq!(e.order(2).unwrap().status, OrderStatus::Cancelled);
    assert_eq!(e.best_bid(), None, "the incoming order never rests");
    assert_eq!(
        e.depth(5).1,
        vec![BookLevel {
            price: 100,
            qty: 5,
            orders: 1
        }]
    );
}

#[test]
fn stp_keeps_trades_made_before_reaching_the_own_order() {
    let mut e = stp_engine();
    run(&mut e, limit(2, Side::Sell, 100, 3)); // 1: someone else, best
    run(&mut e, limit(1, Side::Sell, 100, 4)); // 2: own, same level, behind
    run(&mut e, limit(3, Side::Sell, 100, 4)); // 3: behind the own order
    let ev = run(&mut e, limit(1, Side::Buy, 100, 10)); // 4
    assert_eq!(trades(&ev), vec![(100, 3, 1, 4)]);
    assert!(ev.contains(&Event::Done {
        order_id: 4,
        owner: 1,
        reason: DoneReason::SelfTrade,
        remaining_qty: 7
    }));
    assert!(ev.contains(&Event::Level {
        side: Side::Sell,
        price: 100,
        qty: 8,
        orders: 2
    }));
    assert_eq!(e.best_bid(), None);
    let q: Vec<_> = e.queue(Side::Sell, 100).iter().map(|o| o.id).collect();
    assert_eq!(q, vec![2, 3], "order 3 is not reached past the own order");
}

#[test]
fn stp_skips_the_owners_cancelled_orders() {
    let mut e = stp_engine();
    run(&mut e, limit(1, Side::Sell, 100, 5)); // 1: own, then cancelled
    run(&mut e, limit(2, Side::Sell, 100, 5)); // 2
    run(
        &mut e,
        Command::Cancel {
            owner: 1,
            order_id: 1,
        },
    );
    let ev = run(&mut e, limit(1, Side::Buy, 100, 5));
    assert_eq!(trades(&ev), vec![(100, 5, 2, 3)]);
    assert_eq!(e.order(3).unwrap().status, OrderStatus::Filled);
}

#[test]
fn stp_reports_a_market_orders_remainder_as_self_trade() {
    let mut e = stp_engine();
    run(&mut e, limit(2, Side::Sell, 100, 3)); // 1
    run(&mut e, limit(1, Side::Sell, 101, 3)); // 2: own
    let ev = run(
        &mut e,
        Command::Market {
            owner: 1,
            side: Side::Buy,
            qty: 10,
        },
    );
    assert_eq!(trades(&ev), vec![(100, 3, 1, 3)]);
    assert!(ev.contains(&Event::Done {
        order_id: 3,
        owner: 1,
        reason: DoneReason::SelfTrade,
        remaining_qty: 7
    }));
    assert!(!ev.iter().any(|e| matches!(
        e,
        Event::Done {
            reason: DoneReason::Expired,
            ..
        }
    )));
}

#[test]
fn stp_lets_different_owners_trade() {
    let mut e = stp_engine();
    run(&mut e, limit(1, Side::Sell, 100, 5));
    let ev = run(&mut e, limit(2, Side::Buy, 100, 5));
    assert_eq!(trades(&ev), vec![(100, 5, 1, 2)]);
}

/// Seeded random commands; invariants hold after every one, with and
/// without self-trade prevention, and with it no owner trades with itself.
#[test]
fn invariants_hold_over_random_streams() {
    for (seed, self_trade) in (1..=20).flat_map(|s| {
        [
            (s, SelfTradePrevention::Off),
            (s, SelfTradePrevention::CancelNewest),
        ]
    }) {
        let mut rng = sim::Rng::new(seed);
        let mut e = Engine::new(EngineConfig {
            self_trade,
            ..EngineConfig::default()
        });
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
                panic!("seed {seed} {self_trade:?}: {msg}");
            }
            if self_trade == SelfTradePrevention::CancelNewest {
                assert!(!out.iter().any(|ev| matches!(
                    ev,
                    Event::Trade { maker_owner, taker_owner, .. } if maker_owner == taker_owner
                )));
            }
        }
    }
}

/// The memory figures in docs/ARCHITECTURE.md ("Known limits").
#[test]
fn memory_per_order_and_journal_entry_is_as_documented() {
    assert_eq!(std::mem::size_of::<Order>(), 40);
    assert_eq!(std::mem::size_of::<JournalEntry>(), 40);
    assert_eq!(std::mem::size_of::<OrderId>(), 8, "one queue slot");
}
