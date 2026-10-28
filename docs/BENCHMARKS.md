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

Measured on 2026-10-17 at commit `1f2171c`: one core of an Intel Xeon @ 2.10 GHz (4-vCPU shared cloud VM, no core isolation), rustc 1.97.0, release profile (`opt-level = 3`, LTO, `codegen-units = 1`). Five runs of `cargo run --release -p arena-bench -- 2000000`; ranges are min–max across the runs. Counts and fingerprints are identical in every run (the workload is seeded); timings are not. On this shared VM, repeated sets of runs on the same code moved by up to about 25%, so read the ranges, not any single number.

| | `standard` | `deep` |
|---|---|---|
| Commands | 2,000,000 | 2,000,000 |
| Trades | 986,325 | 836,421 |
| Cancels (rejected) | 499,474 (0, 0.00%) | 499,692 (0, 0.00%) |
| Book levels, average / max | 109.5 / 165 | 50,145.1 / 50,383 |
| Resting orders at the end | 3,215 | 1,154,386 |
| Throughput | 2.38–3.74 M commands/s | 1.44–1.92 M commands/s |
| Latency p50 | 220–323 ns | 600–688 ns |
| Latency p99 | 0.92–1.31 µs | 1.52–1.81 µs |
| Latency p99.9 | 3.4–6.6 µs | 7.1–15.1 µs |
| Fingerprint | `e23f832f942290da` | `4e63e48c88c947ef` |

The deep book is roughly twice as slow at the median. It has not been profiled; the likely causes are a deeper `BTreeMap` (50,000 levels instead of ~110) and cache misses across more than a million live orders.

### WebAssembly

The browser benchmark runs the `standard` mix (`workload::commands`, seed 7) through the same code compiled to `wasm32-unknown-unknown` (83,292 bytes with rustc 1.97.0; the size varies with the Rust version).

| Runtime | Commands | Trades | Throughput |
|---------|----------|--------|-----------|
| Node v22.22.0 | 2,000,000 | 986,325 (same as native) | 2.06–2.49 M commands/s (5 runs) |
| Chromium 141 (headless, Playwright) | 1,000,000 | 490,828 (same as native for 1M) | 2.21–2.36 M commands/s (3 runs) |

Reproduce with `web/scripts/bench-wasm.mjs` (after `npm run wasm` in `web/`):

```bash
node scripts/bench-wasm.mjs node 2000000 5
node scripts/bench-wasm.mjs chromium 1000000 3   # PW_CHROMIUM_PATH=... to pick a browser
```

It instantiates the module and times `arena_bench_run` after `arena_bench_prepare`. In Chromium it runs on the page's main thread; the app's **Run 1M commands** button calls the same two exports from a Web Worker.

## On a different host

Absolute timings depend on the host; counts, rejected cancels and fingerprints do not. After the container moved to another shared VM (Intel Xeon @ 2.80 GHz, 4 vCPU, same toolchain, same commit), the same commands measured lower:

| | Throughput |
|---|---|
| Native, `standard` (2 runs) | 1.80–2.27 M commands/s, p50 398–423 ns |
| Node v22.22.0, `bench-wasm.mjs node 2000000` (8 runs) | 1.71–1.92 M commands/s |
| Chromium 141, `bench-wasm.mjs chromium 1000000` (8 runs) | 1.48–2.05 M commands/s |

Trade counts were identical (986,325 and 490,828). Compare runs taken on the same host, not against the tables above.

## What preallocation buys

Same machine and code, three runs each with `NO_PREALLOC=1` (vectors grow on demand):

| | `standard` | `deep` |
|---|---|---|
| Throughput | 2.39–2.66 M commands/s | 1.52–1.61 M commands/s |
| Latency p50 | 297–328 ns | 625–666 ns |
| Latency p99 | 2.07–2.25 µs | 2.44–2.57 µs |
| Latency p99.9 | 6.1–8.7 µs | 13.6–15.8 µs |

Against the preallocated runs above, the median and throughput ranges overlap, while p99 is about 1.5–2× higher without preallocation: part of the tail is growing and first-touching the journal and order archive (reallocation and page faults). Earlier, unrepeatable runs showed much larger no-preallocation spikes (p99 near 20 µs); they did not reproduce, so they are not claimed here.

## Next

The remaining p99.9 is unprofiled; the likely sources are allocation inside levels (`VecDeque` growth, `BTreeMap` nodes), cache misses in the deep book, and VM jitter. Options, in order: a flat price-indexed level array around the mid, an intrusive linked list of orders per level backed by the existing order `Vec`, and pinning the benchmark to an isolated core.
