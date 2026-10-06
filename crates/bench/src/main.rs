//! `cargo run --release -p arena-bench [-- <commands>]`
//!
//! Replays a seeded, exchange-like command mix (60% limit orders around a
//! moving mid, 25% cancels of live orders, 15% market orders) through the
//! sequencer, and reports throughput and per-command latency percentiles.
//! Latency is measured around each `submit` call (sequence, journal, match,
//! fingerprint), so it includes everything the exchange does per command.
//! Memory is preallocated and touched first (`Exchange::with_capacity`), as
//! an exchange does at start of day.

use std::time::Instant;

use arena_engine::*;

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(2_000_000);
    let commands = arena_engine::workload::commands(n, 7);

    // Throughput: one pass, no per-command timing.
    let mut ex = Exchange::with_capacity(EngineConfig::default(), n);
    let start = Instant::now();
    let mut trades = 0usize;
    for (i, cmd) in commands.iter().enumerate() {
        trades += ex
            .submit(i as u64, *cmd)
            .iter()
            .filter(|e| matches!(e, Event::Trade { .. }))
            .count();
    }
    let secs = start.elapsed().as_secs_f64();

    // Latency: a second pass, timing each command.
    let mut ex = Exchange::with_capacity(EngineConfig::default(), n);
    let mut lat: Vec<u64> = Vec::with_capacity(n);
    for (i, cmd) in commands.iter().enumerate() {
        let t = Instant::now();
        ex.submit(i as u64, *cmd);
        lat.push(t.elapsed().as_nanos() as u64);
    }
    if std::env::var("BY_KIND").is_ok() {
        for (name, k) in [("limit", 0u8), ("market", 1), ("cancel", 2)] {
            let mut v: Vec<u64> = lat
                .iter()
                .zip(&commands)
                .filter(|(_, c)| kind(c) == k)
                .map(|(l, _)| *l)
                .collect();
            v.sort_unstable();
            println!(
                "{name:7} n={} p50={} p99={} p99.9={}",
                v.len(),
                v[v.len() / 2],
                v[v.len() * 99 / 100],
                v[v.len() * 999 / 1000]
            );
        }
    }
    lat.sort_unstable();
    let pct = |p: f64| lat[((lat.len() as f64 * p) as usize).min(lat.len() - 1)];

    println!("commands        {n}");
    println!("trades          {trades}");
    println!("throughput      {:.2} M commands/s", n as f64 / secs / 1e6);
    println!("latency p50     {} ns", pct(0.50));
    println!("latency p99     {} ns", pct(0.99));
    println!("latency p99.9   {} ns", pct(0.999));
    println!("fingerprint     {:016x}", ex.fingerprint());
}

fn kind(c: &Command) -> u8 {
    match c {
        Command::Limit { .. } => 0,
        Command::Market { .. } => 1,
        Command::Cancel { .. } => 2,
    }
}
