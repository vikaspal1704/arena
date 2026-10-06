# Benchmarks

`cargo run --release -p arena-bench -- 2000000` sends a seeded, exchange-like mix through `Exchange::submit` (sequence, journal, match, fingerprint): 60% limit orders around a slowly moving mid, 25% cancels of live orders, 15% market orders. The mix is generated before timing starts. Memory for the journal and order archive is allocated and touched up front (`Exchange::with_capacity`), as an exchange does at start of day.

## Results

Measured on 2026-10-06, one core of an Intel Xeon @ 2.10 GHz (shared cloud VM), Rust 1.94, `opt-level = 3`, LTO:

| | Value |
|---|---|
| Commands | 2,000,000 (1,305,809 trades) |
| Throughput | 2.0–2.5 M commands/s |
| Latency p50 | ≈ 350 ns |
| Latency p99 | ≈ 1.6 µs |
| Latency p99.9 | ≈ 14–22 µs |

The same workload compiled to WebAssembly: **1.9 M commands/s** under Node 22 (identical trade count), and **1.9–2.0 M commands/s** in headless Chromium for the 1M-command browser run (three runs: 528, 499 and 500 ms). The live demo's **Run 1M commands** button runs it in your browser.

## What changed the numbers

| Change | p99 | Throughput |
|--------|-----|-----------|
| Baseline (vectors grow on demand) | 16.8 µs | 1.45 M/s |
| Preallocate and pre-touch the journal and order archive | 1.6 µs | 2.1–2.5 M/s |

The tail was uniform across command types and grew with the run's length: page faults on first touch of freshly grown vectors, not the matching logic. Preallocating removed it.

## Next

The remaining p99.9 comes from allocation inside levels (`VecDeque` growth, `BTreeMap` nodes) and VM jitter. Options, in order: a flat price-indexed level array around the mid, an intrusive linked list of orders per level backed by the existing order `Vec`, and pinning the benchmark to an isolated core.
