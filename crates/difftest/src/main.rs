//! Differential test, Rust side.
//!
//! `arena-difftest <seed> <count>` generates a seeded random command stream
//! (including invalid commands), runs it through the Rust engine, and prints
//! one JSON line per command: the command and everything that resulted from
//! it. `difftest/compare.py` replays the same commands through the Python
//! reference engine (vikaspal1704/mini-matching-engine) and requires
//! identical results, line by line.
//!
//! The reference engine has limit orders and cancels only, so a market order
//! is expressed there as a limit at an extreme price followed by a cancel of
//! whatever is left; the Rust engine must agree with that too.

use std::fmt::Write as _;
use std::io::{self, BufWriter, Write};

use arena_engine::sim::Rng;
use arena_engine::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1000);

    let mut rng = Rng::new(seed);
    let mut engine = Engine::new(EngineConfig::default());
    let mut events = Vec::new();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    for _ in 0..count {
        let side = if rng.chance(500) {
            Side::Buy
        } else {
            Side::Sell
        };
        let cmd = match rng.below(100) {
            0..=59 => Command::Limit {
                owner: 0,
                side,
                price: 95 + rng.below(11) as Price,
                qty: 1 + rng.below(20),
            },
            60..=69 => Command::Market {
                owner: 0,
                side,
                qty: 1 + rng.below(40),
            },
            70..=94 => Command::Cancel {
                owner: 0,
                order_id: 1 + rng.below(engine.order_count() as u64 + 2),
            },
            95..=97 => Command::Limit {
                owner: 0,
                side,
                price: rng.below(2) as Price - 1,
                qty: 5,
            }, // price 0 or -1
            _ => Command::Limit {
                owner: 0,
                side,
                price: 100,
                qty: 0,
            },
        };
        events.clear();
        engine.apply(cmd, &mut events);
        writeln!(out, "{}", line(&cmd, &events, &engine)).expect("write");
    }
}

fn side(s: Side) -> &'static str {
    match s {
        Side::Buy => "BUY",
        Side::Sell => "SELL",
    }
}

fn line(cmd: &Command, events: &[Event], engine: &Engine) -> String {
    let mut s = String::from("{\"cmd\":");
    match *cmd {
        Command::Limit {
            side: sd,
            price,
            qty,
            ..
        } => write!(
            s,
            "{{\"type\":\"limit\",\"side\":\"{}\",\"price\":{price},\"qty\":{qty}}}",
            side(sd)
        )
        .unwrap(),
        Command::Market { side: sd, qty, .. } => write!(
            s,
            "{{\"type\":\"market\",\"side\":\"{}\",\"qty\":{qty}}}",
            side(sd)
        )
        .unwrap(),
        Command::Cancel { order_id, .. } => {
            write!(s, "{{\"type\":\"cancel\",\"order_id\":{order_id}}}").unwrap()
        }
    }
    let mut order_id = None;
    let mut rejected = "null".to_string();
    let mut trades = Vec::new();
    for e in events {
        match *e {
            Event::Accepted { order_id: id, .. } => order_id = Some(id),
            Event::Rejected { reason, .. } => rejected = format!("\"{reason:?}\""),
            Event::Trade {
                price,
                qty,
                maker_order_id,
                taker_order_id,
                ..
            } => trades.push(format!("[{price},{qty},{maker_order_id},{taker_order_id}]")),
            _ => {}
        }
    }
    let order = order_id.and_then(|id| engine.order(id));
    let remaining = order.map_or("null".to_string(), |o| o.remaining_qty.to_string());
    let (bids, asks) = engine.depth(usize::MAX);
    let levels = |v: &[BookLevel]| {
        v.iter()
            .map(|l| format!("[{},{},{}]", l.price, l.qty, l.orders))
            .collect::<Vec<_>>()
            .join(",")
    };
    write!(
        s,
        ",\"order_id\":{},\"remaining\":{remaining},\"rejected\":{rejected},\"trades\":[{}],\"bids\":[{}],\"asks\":[{}]}}",
        order_id.map_or("null".to_string(), |id| id.to_string()),
        trades.join(","),
        levels(&bids),
        levels(&asks)
    )
    .unwrap();
    s
}
