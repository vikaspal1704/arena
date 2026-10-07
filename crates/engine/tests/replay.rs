use arena_engine::*;

#[test]
fn replaying_any_prefix_gives_the_same_fingerprint_and_book() {
    let mut sim = Sim::new(SimConfig::default());
    for _ in 0..3_000 {
        sim.step(100);
    }
    let ex = sim.exchange();
    let config = ex.engine().config();
    for upto in [0usize, 1, 17, 500, ex.journal().len()] {
        let replayed = Exchange::replay(config, ex.journal(), upto);
        assert_eq!(
            replayed.fingerprint(),
            ex.fingerprint_at(upto as u64),
            "prefix {upto}"
        );
    }
    let full = Exchange::replay(config, ex.journal(), usize::MAX);
    assert_eq!(full.engine().book_hash(), ex.engine().book_hash());
    assert_eq!(full.engine().depth(10), ex.engine().depth(10));
}

#[test]
fn same_seed_same_market_different_seed_different_market() {
    let run = |seed| {
        let mut sim = Sim::new(SimConfig {
            seed,
            ..SimConfig::default()
        });
        for _ in 0..2_000 {
            sim.step(100);
        }
        sim.exchange().fingerprint()
    };
    assert_eq!(run(7), run(7));
    assert_ne!(run(7), run(8));
}

#[test]
fn a_changed_command_changes_every_later_fingerprint() {
    let mut sim = Sim::new(SimConfig::default());
    for _ in 0..500 {
        sim.step(100);
    }
    let ex = sim.exchange();
    let mut tampered = ex.journal().to_vec();
    let at = tampered
        .iter()
        .position(|e| matches!(e.cmd, Command::Limit { .. }))
        .unwrap()
        + 10;
    if let Command::Limit { qty, .. } = &mut tampered[at].cmd {
        *qty += 75;
    }
    let other = Exchange::replay(ex.engine().config(), &tampered, usize::MAX);
    assert_eq!(
        other.fingerprint_at(at as u64),
        ex.fingerprint_at(at as u64),
        "before the change"
    );
    assert_ne!(
        other.fingerprint_at(at as u64 + 1),
        ex.fingerprint_at(at as u64 + 1),
        "at the change"
    );
    assert_ne!(other.fingerprint(), ex.fingerprint(), "after it");
}

#[test]
fn the_simulated_market_stays_healthy() {
    let mut sim = Sim::new(SimConfig::default());
    let mut trades = 0;
    for _ in 0..20_000 {
        for e in sim.step(100) {
            if matches!(e.event, Event::Trade { .. }) {
                trades += 1;
            }
        }
        sim.exchange().engine().check_invariants().unwrap();
    }
    let e = sim.exchange().engine();
    assert!(trades > 1_000, "the market trades ({trades})");
    assert!(
        e.best_bid().is_some() && e.best_ask().is_some(),
        "both sides quoted"
    );
    let spread = e.best_ask().unwrap() - e.best_bid().unwrap();
    assert!(
        spread <= 20 * sim.config().tick,
        "spread stays tight ({spread})"
    );
    let drift = (sim.fair_price() - e.best_bid().unwrap()).abs();
    assert!(
        drift <= 50 * sim.config().tick,
        "book follows fair value ({drift})"
    );
}

#[test]
fn player_orders_trade_with_bots() {
    let mut sim = Sim::new(SimConfig::default());
    for _ in 0..50 {
        sim.step(100);
    }
    let ev = sim.player(Command::Market {
        owner: sim::PLAYER,
        side: Side::Buy,
        qty: 75,
    });
    assert!(ev
        .iter()
        .any(|e| matches!(e.event, Event::Trade { taker_owner: 0, .. })));
}

#[test]
fn anchored_market_follows_the_external_price_and_still_replays() {
    let config = SimConfig {
        start_price: 2_500_000,
        lot: 65,
        ..SimConfig::default()
    };
    let mut sim = Sim::new(config);
    // An external price path: up 40 rupees, then down 25, in 5-paise ticks.
    let path = (0..400).map(|i| {
        2_500_000
            + 5 * if i < 200 {
                4 * i
            } else {
                800 - 5 * (i - 200) / 2
            }
    });
    for p in path {
        sim.anchor(Some(p));
        sim.step(100);
        sim.exchange().engine().check_invariants().unwrap();
    }
    assert!(sim.anchored());
    let last = 2_500_000 + 5 * (800 - 5 * 199 / 2);
    assert_eq!(sim.fair_price(), last, "fair value is the anchor");
    let e = sim.exchange().engine();
    let mid = (e.best_bid().unwrap() + e.best_ask().unwrap()) / 2;
    assert!(
        (mid - last).abs() <= 20 * config.tick,
        "book tracks the external price (mid {mid}, anchor {last})"
    );
    // The journal alone replays it: no feed and no bot logic needed.
    let replayed = Exchange::replay(e.config(), sim.exchange().journal(), usize::MAX);
    assert_eq!(replayed.fingerprint(), sim.exchange().fingerprint());
}

#[test]
fn anchor_rounds_to_the_tick_and_can_be_released() {
    let mut sim = Sim::new(SimConfig::default());
    sim.anchor(Some(2_400_003)); // between ticks: rounds to 2,400,005
    sim.step(100);
    assert_eq!(sim.fair_price(), 2_400_005);
    sim.anchor(None);
    assert!(!sim.anchored());
}
