//! Property tests: arbitrary configurations and command streams, including
//! extreme values, checked against properties computed independently of the
//! engine's own bookkeeping (and of `check_invariants`).
//!
//! Sums are taken in `u128`, so a wrapped `u64` inside the engine shows up
//! as a mismatch even in release builds, where overflow checks are off.

use std::collections::BTreeMap;

use arena_engine::*;
use proptest::prelude::*;

fn config() -> impl Strategy<Value = EngineConfig> {
    (
        prop_oneof![Just(1i64), 1i64..=10, Just(i64::MAX)],
        prop_oneof![
            Just(1u64),
            1u64..=200,
            Just(1_000_000_000),
            Just(MAX_ORDER_QTY)
        ],
        prop_oneof![
            Just(SelfTradePrevention::Off),
            Just(SelfTradePrevention::CancelNewest)
        ],
    )
        .prop_map(|(tick, max_qty, self_trade)| EngineConfig {
            tick,
            max_qty,
            self_trade,
        })
}

fn side() -> impl Strategy<Value = Side> {
    prop_oneof![Just(Side::Buy), Just(Side::Sell)]
}

/// Mostly a few owners (so cancels and self-trade prevention meet), sometimes any.
fn owner() -> impl Strategy<Value = Owner> {
    prop_oneof![8 => 0u32..4, 1 => any::<u32>(), 1 => Just(u32::MAX)]
}

/// Mostly prices on the tick grid in a narrow band (so orders cross),
/// sometimes anything, including the extremes.
fn price(tick: i64) -> impl Strategy<Value = Price> {
    prop_oneof![
        12 => (1i64..=12).prop_map(move |k| tick.saturating_mul(k)),
        1 => any::<i64>(),
        1 => prop_oneof![Just(i64::MIN), Just(i64::MAX), Just(0), Just(-1), Just(1)],
    ]
}

fn qty(max_qty: Qty) -> impl Strategy<Value = Qty> {
    prop_oneof![
        12 => 1u64..=50,
        1 => any::<u64>(),
        1 => prop_oneof![Just(0), Just(u64::MAX), Just(max_qty), Just(max_qty.saturating_add(1))],
    ]
}

fn order_id() -> impl Strategy<Value = OrderId> {
    prop_oneof![
        12 => 1u64..=120,
        1 => any::<u64>(),
        1 => prop_oneof![Just(0), Just(u64::MAX)],
    ]
}

fn command(c: EngineConfig) -> impl Strategy<Value = Command> {
    prop_oneof![
        5 => (owner(), side(), price(c.tick), qty(c.max_qty)).prop_map(|(owner, side, price, qty)| {
            Command::Limit { owner, side, price, qty }
        }),
        2 => (owner(), side(), qty(c.max_qty))
            .prop_map(|(owner, side, qty)| Command::Market { owner, side, qty }),
        3 => (owner(), order_id()).prop_map(|(owner, order_id)| Command::Cancel { owner, order_id }),
    ]
}

/// A configuration and a stream of commands with arbitrary timestamps.
fn scenario() -> impl Strategy<Value = (EngineConfig, Vec<(u64, Command)>)> {
    config().prop_flat_map(|c| {
        (
            Just(c),
            prop::collection::vec((any::<u64>(), command(c)), 1..300),
        )
    })
}

/// The book is never crossed, and every level's quantity and order count
/// equal the sum over the live orders queued in it.
fn check_book(e: &Engine) -> Result<(), TestCaseError> {
    if let (Some(b), Some(a)) = (e.best_bid(), e.best_ask()) {
        prop_assert!(b < a, "crossed: bid {} >= ask {}", b, a);
    }
    let (bids, asks) = e.depth(usize::MAX);
    for (side, levels) in [(Side::Buy, &bids), (Side::Sell, &asks)] {
        for l in levels {
            let queue = e.queue(side, l.price);
            prop_assert!(!queue.is_empty(), "empty level {:?} {}", side, l.price);
            let sum: u128 = queue.iter().map(|o| o.remaining_qty as u128).sum();
            prop_assert_eq!(sum, l.qty as u128, "level {:?} {} qty", side, l.price);
            prop_assert_eq!(queue.len(), l.orders as usize);
            for o in queue {
                prop_assert!(o.status.is_live() && o.side == side && o.price == l.price);
                prop_assert!(o.remaining_qty > 0);
            }
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

    /// Never crossed and level totals exact after every command; every
    /// `Level` event reports the level as it now is.
    #[test]
    fn book_is_never_crossed_and_levels_equal_their_live_orders((c, cmds) in scenario()) {
        let mut e = Engine::new(c);
        let mut out = Vec::new();
        for (_, cmd) in cmds {
            out.clear();
            e.apply(cmd, &mut out);
            check_book(&e)?;
            let (bids, asks) = e.depth(usize::MAX);
            for ev in &out {
                if let Event::Level { side, price, qty, orders } = *ev {
                    let levels = if side == Side::Buy { &bids } else { &asks };
                    let now = levels.iter().find(|l| l.price == price);
                    prop_assert_eq!(now.map_or((0, 0), |l| (l.qty, l.orders)), (qty, orders));
                }
            }
        }
    }

    /// Every unit traded is bought by one order and sold by another: buy
    /// fills = sell fills = traded quantity, and each order's original
    /// quantity equals what remains plus what it traded. Trades print at
    /// the maker's price, within the taker's limit.
    #[test]
    fn traded_quantity_is_conserved((c, cmds) in scenario()) {
        let mut e = Engine::new(c);
        let mut out = Vec::new();
        let mut filled: BTreeMap<OrderId, u128> = BTreeMap::new();
        let mut traded = 0u128;
        for (_, cmd) in cmds {
            out.clear();
            e.apply(cmd, &mut out);
            for ev in &out {
                if let Event::Trade { price, qty, maker_order_id, taker_order_id, aggressor, .. } = *ev {
                    prop_assert!(qty > 0);
                    let maker = e.order(maker_order_id).unwrap();
                    let taker = e.order(taker_order_id).unwrap();
                    prop_assert_eq!(price, maker.price, "prints at the maker's price");
                    prop_assert_eq!(taker.side, aggressor);
                    prop_assert_ne!(maker.side, taker.side);
                    match taker.side {
                        Side::Buy => prop_assert!(price <= taker.price),
                        Side::Sell => prop_assert!(price >= taker.price),
                    }
                    traded += qty as u128;
                    *filled.entry(maker_order_id).or_default() += qty as u128;
                    *filled.entry(taker_order_id).or_default() += qty as u128;
                }
            }
        }
        let (mut buy_fills, mut sell_fills) = (0u128, 0u128);
        for id in 1..=e.order_count() as OrderId {
            let o = e.order(id).unwrap();
            let f = filled.get(&id).copied().unwrap_or(0);
            prop_assert_eq!(o.original_qty as u128, o.remaining_qty as u128 + f, "order {}", id);
            prop_assert_eq!(o.status == OrderStatus::Filled, o.remaining_qty == 0 && o.status != OrderStatus::Cancelled);
            match o.side {
                Side::Buy => buy_fills += f,
                Side::Sell => sell_fills += f,
            }
        }
        prop_assert_eq!(buy_fills, traded);
        prop_assert_eq!(sell_fills, traded);
    }

    /// Replaying the journal on a fresh exchange reproduces the fingerprint
    /// after every entry, the final book, and the events of every command.
    #[test]
    fn replaying_the_journal_reproduces_every_fingerprint((c, cmds) in scenario()) {
        let mut live = Exchange::new(c);
        let mut events = Vec::new();
        for (ts, cmd) in cmds {
            events.push(live.submit(ts, cmd).to_vec());
        }
        let mut replay = Exchange::new(c);
        for (i, entry) in live.journal().iter().enumerate() {
            prop_assert_eq!(entry.seq, i as u64 + 1);
            let ev = replay.submit(entry.ts_ms, entry.cmd);
            prop_assert_eq!(ev, &events[i][..]);
            prop_assert_eq!(Some(replay.fingerprint()), live.fingerprint_at(entry.seq));
        }
        let full = Exchange::replay(c, live.journal(), usize::MAX);
        prop_assert_eq!(full.fingerprint(), live.fingerprint());
        prop_assert_eq!(full.engine().book_hash(), live.engine().book_hash());
    }

    /// Fully arbitrary commands (every field any value) and timestamps never
    /// panic, and leave a consistent engine.
    #[test]
    fn arbitrary_commands_never_panic(
        c in config(),
        cmds in prop::collection::vec(
            (any::<u64>(), prop_oneof![
                (any::<u32>(), side(), any::<i64>(), any::<u64>())
                    .prop_map(|(owner, side, price, qty)| Command::Limit { owner, side, price, qty }),
                (any::<u32>(), side(), any::<u64>())
                    .prop_map(|(owner, side, qty)| Command::Market { owner, side, qty }),
                (any::<u32>(), any::<u64>())
                    .prop_map(|(owner, order_id)| Command::Cancel { owner, order_id }),
            ]),
            1..300,
        ),
    ) {
        let mut ex = Exchange::new(c);
        for (ts, cmd) in cmds {
            ex.submit(ts, cmd);
        }
        prop_assert!(ex.engine().check_invariants().is_ok());
        check_book(ex.engine())?;
    }
}

/// Explicit extremes, so they run every time rather than by chance.
#[test]
fn extreme_values_are_rejected_or_handled() {
    for c in [
        EngineConfig::default(),
        EngineConfig {
            tick: i64::MAX,
            max_qty: MAX_ORDER_QTY,
            self_trade: SelfTradePrevention::CancelNewest,
        },
    ] {
        let mut ex = Exchange::new(c);
        for cmd in [
            Command::Limit {
                owner: u32::MAX,
                side: Side::Sell,
                price: i64::MAX,
                qty: c.max_qty,
            },
            Command::Limit {
                owner: 0,
                side: Side::Sell,
                price: i64::MAX,
                qty: c.max_qty,
            },
            Command::Limit {
                owner: 0,
                side: Side::Buy,
                price: i64::MIN,
                qty: 1,
            },
            Command::Limit {
                owner: 0,
                side: Side::Buy,
                price: 0,
                qty: 1,
            },
            Command::Limit {
                owner: 0,
                side: Side::Buy,
                price: i64::MAX,
                qty: u64::MAX,
            },
            Command::Limit {
                owner: 0,
                side: Side::Buy,
                price: i64::MAX,
                qty: 0,
            },
            Command::Market {
                owner: 1,
                side: Side::Buy,
                qty: c.max_qty,
            },
            Command::Market {
                owner: 1,
                side: Side::Sell,
                qty: u64::MAX,
            },
            Command::Cancel {
                owner: 0,
                order_id: 0,
            },
            Command::Cancel {
                owner: 0,
                order_id: u64::MAX,
            },
            Command::Cancel {
                owner: u32::MAX,
                order_id: 1,
            },
        ] {
            ex.submit(u64::MAX, cmd);
            ex.engine().check_invariants().unwrap();
            check_book(ex.engine()).unwrap();
        }
        let replay = Exchange::replay(c, ex.journal(), usize::MAX);
        assert_eq!(replay.fingerprint(), ex.fingerprint());
    }
}

#[test]
#[should_panic(expected = "max_qty")]
fn a_max_qty_that_could_overflow_a_level_is_refused() {
    Engine::new(EngineConfig {
        max_qty: MAX_ORDER_QTY + 1,
        ..EngineConfig::default()
    });
}
