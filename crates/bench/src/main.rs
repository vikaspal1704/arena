//! `cargo run --release -p arena-bench [-- <commands> [standard|deep]]`
//!
//! Replays seeded, exchange-like command mixes (60% limit orders around a
//! moving mid, 25% cancels of live orders, 15% market orders; see
//! `arena_engine::workload`) through the sequencer, and reports throughput,
//! per-command latency percentiles and what the book looked like.
//!
//! Two scenarios, both run by default:
//! * `standard`: from an empty book;
//! * `deep`: from a book of 1,000,000 resting orders on 50,000 levels.
//!
//! Latency is measured around each `submit` call (sequence, journal, match,
//! fingerprint), so it includes everything the exchange does per command.
//! Memory is preallocated and touched first (`Exchange::with_capacity`), as
//! an exchange does at start of day (`NO_PREALLOC=1` turns this off, to
//! show what it buys). A scenario's starting book is built
//! before timing starts.
//!
//! Book statistics come from a third, untimed pass that inspects every
//! command's events. The run fails if 2% or more of the cancels are
//! rejected: a cancel of an order that is no longer live is a cheap no-op
//! and would flatter the numbers.

use std::process::ExitCode;
use std::time::Instant;

use arena_engine::workload::{self, Workload};
use arena_engine::*;

const MAX_REJECTED_CANCEL_PCT: f64 = 2.0;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let n: usize = args
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2_000_000);
    let only = args.next();
    let mut ok = true;
    for (name, build) in [
        ("standard", workload::standard as fn(usize, u64) -> Workload),
        ("deep", workload::deep_book),
    ] {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        ok &= run(name, &build(n, 7));
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// A fresh exchange with room for the whole workload (unless `NO_PREALLOC`
/// is set) and its starting book applied.
fn prepared(w: &Workload) -> Exchange {
    let mut ex = if std::env::var("NO_PREALLOC").is_ok() {
        Exchange::new(EngineConfig::default())
    } else {
        Exchange::with_capacity(EngineConfig::default(), w.setup.len() + w.commands.len())
    };
    for cmd in &w.setup {
        ex.submit(0, *cmd);
    }
    ex
}

/// Runs one scenario and prints its report; false if the workload is not honest.
fn run(name: &str, w: &Workload) -> bool {
    let commands = &w.commands;
    let n = commands.len();

    // Throughput: one pass, no per-command timing.
    let mut ex = prepared(w);
    let start = Instant::now();
    for (i, cmd) in commands.iter().enumerate() {
        ex.submit(i as u64, *cmd);
    }
    let secs = start.elapsed().as_secs_f64();

    // Latency: a second pass, timing each command.
    let mut ex = prepared(w);
    let mut lat: Vec<u64> = Vec::with_capacity(n);
    for (i, cmd) in commands.iter().enumerate() {
        let t = Instant::now();
        ex.submit(i as u64, *cmd);
        lat.push(t.elapsed().as_nanos() as u64);
    }
    let fingerprint = ex.fingerprint();
    if std::env::var("BY_KIND").is_ok() {
        for (kind_name, k) in [("limit", 0u8), ("market", 1), ("cancel", 2)] {
            let mut v: Vec<u64> = lat
                .iter()
                .zip(commands)
                .filter(|(_, c)| kind(c) == k)
                .map(|(l, _)| *l)
                .collect();
            v.sort_unstable();
            println!(
                "{kind_name:7} n={} p50={} p99={} p99.9={}",
                v.len(),
                v[v.len() / 2],
                v[v.len() * 99 / 100],
                v[v.len() * 999 / 1000]
            );
        }
    }
    lat.sort_unstable();
    let pct = |p: f64| lat[((lat.len() as f64 * p) as usize).min(lat.len() - 1)];

    // Statistics: a third, untimed pass.
    let mut ex = prepared(w);
    let start_orders = ex.engine().resting_orders();
    let (mut trades, mut cancels, mut rejected_cancels, mut other_rejects) =
        (0u64, 0u64, 0u64, 0u64);
    let (mut level_sum, mut level_max) = (0u128, 0usize);
    for (i, cmd) in commands.iter().enumerate() {
        let events = ex.submit(i as u64, *cmd);
        let rejected = events.iter().any(|e| matches!(e, Event::Rejected { .. }));
        trades += events
            .iter()
            .filter(|e| matches!(e, Event::Trade { .. }))
            .count() as u64;
        if matches!(cmd, Command::Cancel { .. }) {
            cancels += 1;
            rejected_cancels += rejected as u64;
        } else {
            other_rejects += rejected as u64;
        }
        let (b, a) = ex.engine().level_counts();
        level_sum += (b + a) as u128;
        level_max = level_max.max(b + a);
    }
    assert_eq!(ex.fingerprint(), fingerprint, "passes must agree");
    let rejected_pct = 100.0 * rejected_cancels as f64 / cancels.max(1) as f64;

    println!("scenario            {name}");
    println!("starting orders     {start_orders}");
    println!("commands            {n}");
    println!("trades              {trades}");
    println!("cancels             {cancels}");
    println!("cancels rejected    {rejected_cancels} ({rejected_pct:.2}%)");
    println!("other rejects       {other_rejects}");
    println!(
        "book levels         avg {:.1}, max {level_max}",
        level_sum as f64 / n.max(1) as f64
    );
    println!("final resting       {}", ex.engine().resting_orders());
    println!(
        "throughput          {:.2} M commands/s",
        n as f64 / secs / 1e6
    );
    println!("latency p50         {} ns", pct(0.50));
    println!("latency p99         {} ns", pct(0.99));
    println!("latency p99.9       {} ns", pct(0.999));
    println!("fingerprint         {fingerprint:016x}");
    println!();

    if rejected_pct >= MAX_REJECTED_CANCEL_PCT {
        eprintln!(
            "{name}: {rejected_pct:.2}% of cancels were rejected (limit {MAX_REJECTED_CANCEL_PCT}%): \
             the workload is cancelling orders that are no longer live"
        );
        return false;
    }
    true
}

fn kind(c: &Command) -> u8 {
    match c {
        Command::Limit { .. } => 0,
        Command::Market { .. } => 1,
        Command::Cancel { .. } => 2,
    }
}
