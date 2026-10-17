# Benchmarks

```bash
cargo run --release -p arena-bench -- 2000000            # both scenarios
cargo run --release -p arena-bench -- 2000000 deep       # one scenario
BY_KIND=1 cargo run --release -p arena-bench -- 2000000  # adds percentiles per command type
NO_PREALLOC=1 cargo run --release -p arena-bench -- 2000000  # without start-of-day preallocation
```

Each scenario sends a seeded mix through `Exchange::submit` (sequence, journal, match, fingerprint): 60% limit orders around a slowly moving mid, 25% cancels, 15% market orders (`crates/engine/src/workload.rs`).

- **Cancels target live orders.** The mix is generated against a shadow engine: the generator applies each command as it emits it and tracks resting orders from the engine's own events (an accepted limit order rests until a `Done` event names it). Every cancel therefore hits an order that is genuinely resting. The benchmark counts rejected cancels from the measured exchange's events and **fails if 2% or more are rejected**; CI runs it on every push.
- **Generation is not timed.** The mix, and a scenario's starting book, are built before timing starts.
- **Memory is preallocated.** The journal and order archive are allocated and touched up front (`Exchange::with_capacity`), as an exchange does at start of day. `NO_PREALLOC=1` turns this off.
- **Three passes over identical commands.** One pass is timed as a whole (throughput), one times each `submit` call (latency, so each sample also includes reading the clock), and one, untimed, collects the book statistics. All three must reach the same fingerprint.

| Scenario | Starting book | Limit order prices |
|----------|---------------|--------------------|
| `standard` | empty | −2 … +17 ticks from the mid on the order's own side (negative = aggressive) |
| `deep` | 1,000,000 orders on 50,000 levels (25,000 a side, 20 orders each) | half as in `standard`, half anywhere 1 … 25,000 ticks from the mid |

## Results

Measured on 2026-10-17: one core of an Intel Xeon @ 2.10 GHz (4-vCPU shared cloud VM, no core isolation), rustc 1.97.0, release profile (`opt-level = 3`, LTO, `codegen-units = 1`). Five runs of `cargo run --release -p arena-bench -- 2000000`; ranges are min–max across the runs. Counts are identical in every run (the workload is seeded).

| | `standard` | `deep` |
|---|---|---|
| Commands | 2,000,000 | 2,000,000 |
| Trades | 986,325 | 836,421 |
| Cancels (rejected) | 499,474 (0, 0.00%) | 499,692 (0, 0.00%) |
| Book levels, average / max | 109.5 / 165 | 50,145.1 / 50,383 |
| Resting orders at the end | 3,215 | 1,154,386 |
| Throughput | 2.5–3.3 M commands/s | 1.45–1.73 M commands/s |
| Latency p50 | 278–342 ns | 615–687 ns |
| Latency p99 | 1.15–1.38 µs | 1.60–1.79 µs |
| Latency p99.9 | 5.3–8.9 µs | 15–38 µs |
| Fingerprint | `e23f832f942290da` | `4e63e48c88c947ef` |

The deep book is roughly twice as slow at the median. It has not been profiled; the likely causes are a deeper `BTreeMap` (50,000 levels instead of ~110) and cache misses across more than a million live orders. Its p99.9 is wide and noisy across runs.

### WebAssembly

The browser benchmark runs the `standard` mix (`workload::commands`, seed 7) through the same code compiled to `wasm32-unknown-unknown` (81 KB module).

| Runtime | Commands | Trades | Throughput |
|---------|----------|--------|-----------|
| Node v22.22.0 | 2,000,000 | 986,325 (same as native) | 1.70–2.71 M commands/s (5 runs) |
| Headless Chromium 141 | 1,000,000 | 490,828 (same as native for 1M) | 2.21–2.72 M commands/s (3 runs) |

The Chromium figure was taken on a test page that instantiates the module and calls `arena_bench_prepare` / `arena_bench_run` on the main thread; the app's **Run 1M commands** button calls the same two exports from a Web Worker.

## What preallocation buys

Same machine, three runs each with `NO_PREALLOC=1` (vectors grow on demand):

| | `standard` | `deep` |
|---|---|---|
| Throughput | 2.1–2.7 M commands/s | 0.96–1.59 M commands/s |
| Latency p99 | 2.1–18.8 µs | 18.4–22.1 µs |
| Latency p99.9 | 6.5–39.2 µs | 39.9–56.1 µs |

Compared with the preallocated runs above, the median barely moves while p99 grows by up to an order of magnitude: the tail comes from growing and first-touching the journal and order archive (reallocation and page faults), not from matching.

## Next

The remaining p99.9 comes from allocation inside levels (`VecDeque` growth, `BTreeMap` nodes), cache misses in the deep book, and VM jitter. Options, in order: a flat price-indexed level array around the mid, an intrusive linked list of orders per level backed by the existing order `Vec`, and pinning the benchmark to an isolated core.
