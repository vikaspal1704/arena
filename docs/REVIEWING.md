# Reviewing Arena's engine

This guide is for someone who wants to check, not trust, what the README says about the Rust matching engine. It gives a reading order, every engine claim with the code behind it and the command that proves it, ways to try to break it yourself, and the weak spots we already know about.

## 1. Verify everything in one command

```bash
scripts/verify-claims.sh              # every engine claim, ~3–5 min
scripts/verify-claims.sh --mutations  # also break the engine on purpose and check the tests notice
scripts/verify-claims.sh --web        # also the web app's lint, types, unit and browser tests
```

It prints `PASS` / `FAIL` / `SKIP` per claim and exits non-zero on any failure. Exact values (trade counts, fingerprints, module size, book statistics) are asserted. Timings are printed, not asserted, because they depend on the machine (see §5).

Optional prerequisites: `rustup target add wasm32-unknown-unknown` and `node` for the WebAssembly claims, and `pip install git+https://github.com/vikaspal1704/mini-matching-engine` for the differential test. Without them those checks show `SKIP`, never `PASS`.

The mutation mode copies the last commit into a temporary git worktree (commit before running it), applies one deliberate bug at a time, and requires the relevant tests to fail: naive one-to-one matching (an order stops after its first trade), a cancel that leaves the level total unchanged, trades printed at the taker's price, newest-first queues, a fingerprint that ignores timestamps, a missing owner check, and self-trade prevention on by default. Your working tree is not touched.

## 2. Reading order

About 1,900 lines of engine code (including its unit tests), then about 900 lines of integration tests.

| # | File | Lines | What to look at |
|---|------|-------|-----------------|
| 1 | `crates/engine/src/types.rs` | 192 | Integer prices and quantities, `Command`, `Event`. Events are the only output. `Order::crosses` (l. 81), `fill` (l. 89) and `cancel` (l. 99) are the only ways an order changes. |
| 2 | `crates/engine/src/book.rs` | 234 | `Level` (l. 21, private totals), `BookSide` (l. 65): `add`, `fill_front` (l. 131) and `cancel` (l. 146) update a level and drop it once empty; `Book` (l. 166) holds both sides. |
| 2a | `crates/engine/src/orders.rs` | 79 | `OrderStore`: the archive by dense id; `get` is checked for ids from outside, `issued` is for ids the engine created. |
| 3 | `crates/engine/src/engine.rs` | 556 | The coordinator. `apply` (l. 137) dispatches to `limit` (l. 159), `market` (l. 182) and `cancel` (l. 211); `match_order` (l. 305) is the matching loop; `publish_levels` (l. 367) emits L2. `check_invariants` (l. 456) recomputes every level from the orders. |
| 4 | `crates/engine/src/exchange.rs` | 272 | The sequencer: journal before apply (`submit`, l. 74), the fingerprint chain (`fingerprint`, l. 126), `replay` (l. 86). `event_words` (l. 171) is also the wasm wire format. |
| 5 | `crates/engine/src/hash.rs` | 38 | FNV-1a over 64-bit words. Not cryptographic, and the docs say so. |
| 6 | `crates/engine/src/workload.rs` | 244 | Benchmark mixes, generated against a shadow engine so cancels target live orders. |
| 7 | `crates/engine/src/sim.rs` | 394 | Seeded bots; only matters for the web demo and the CI fingerprint. |
| 8 | `crates/wasm/src/lib.rs` | 311 | `extern "C"` exports and an `f64` output buffer. |

Tests: `crates/engine/tests/scenarios.rs` (realistic matching scenarios with full event streams; start here), `matching.rs` (rules, self-trade prevention, invariants over random streams), `properties.rs` (proptest), `replay.rs` (journal and simulation), and unit tests inside `engine.rs` and `workload.rs`. Differential test: `crates/difftest/src/main.rs` emits commands and results; `difftest/compare.py` replays them through the Python reference.

## 3. Claims, code and proof

| Claim (README / docs) | Where it lives | Checked by |
|---|---|---|
| Real matching, not one-to-one: one order trades with many resting orders across levels, both sides fill partially | `match_order`, `engine.rs` l. 305 | `scenarios.rs` (complete event streams); `--mutations` makes the engine stop after one trade and requires the scenarios to fail |
| Price-time priority; trades at the resting price; partly filled orders keep their place | `match_order` | `many_small_orders_fill_one_large_order_which_keeps_its_place`, `price_priority_then_time_priority`; property `traded_quantity_is_conserved`; difftest |
| Lazy cancels: O(log levels), queue order kept | `Engine::cancel`, l. 211; `BookSide::cancel`, `book.rs` l. 146; tombstone skip in `match_order` | `cancel_skips_the_order_and_keeps_queue_order`; `tombstones_accumulate_until_the_level_empties` |
| Never panics on bad input; ids from outside never alias another order | `validate_price` / `validate_qty` in `engine.rs`; `OrderStore::get` (checked `try_from`, so a large id cannot wrap on 32-bit wasm) | property `arbitrary_commands_never_panic` (any value in every field), `extreme_values_are_rejected_or_handled` |
| Book never crossed; level totals exact | `check_invariants`, l. 456 | `invariants_hold_over_random_streams` (400k commands); property `book_is_never_crossed_and_levels_equal_their_live_orders`, which recomputes from the public API in `u128` |
| Matches the reference engine | `difftest/` | `python difftest/compare.py --seeds 1-300 --count 5000` → `963,654 trades`, every command equal |
| Deterministic; replays are exact | no floats, clocks, hash maps or `unsafe` in `crates/engine/src` (the script greps for them) | property `replaying_the_journal_reproduces_every_fingerprint`; `replay.rs`; pinned fingerprint `8d44c209bd24be3e` native (CI) and wasm (`web/tests/unit/core.test.ts`) |
| No dependencies | `crates/engine/Cargo.toml` (proptest is dev-only) | `cargo tree -p arena-engine -e normal` |
| wasm module under 90 KB, no JavaScript glue | `crates/wasm` | the script: size, and `WebAssembly.Module.imports` is `[]` |
| Self-trade prevention, off by default | `SelfTradePrevention`, l. 48; `blocks`, l. 65 | six `stp_*` tests; random invariants in both modes; difftest confirms the default |
| Benchmark cancels hit live orders | `workload.rs` `Generator::push`, l. 148 | `every_cancel_targets_a_live_order`; the benchmark fails at ≥2% rejected |
| Benchmark numbers | `crates/bench`, `web/scripts/bench-wasm.mjs` | counts and fingerprints asserted by the script; timings in `docs/BENCHMARKS.md`, host-dependent |
| Memory per order / command | `Order`, `JournalEntry` | `memory_per_order_and_journal_entry_is_as_documented` |

## 4. Try to break it yourself

- **Property tests at a larger scale:** `PROPTEST_CASES=20000 cargo test --release -p arena-engine --test properties`. Also run them without `--release`, which turns on overflow checks.
- **A different differential stream:** `python difftest/compare.py --seeds 1000-1300 --count 20000`.
- **Your own mutation:** change any comparison in `match_order` or `cancel` and run `cargo test --release`. If something you break is not caught, that is a gap worth reporting.
- **Edge configurations:** `EngineConfig { tick: i64::MAX, max_qty: MAX_ORDER_QTY, .. }` is already in the property tests; `Engine::new` refuses `max_qty > 2^32` (see §5).

## 5. Known weak spots

These are stated in the README and ARCHITECTURE ("Known limits"), collected here so a review can start from them.

1. **The reference engine has the same author.** mini-matching-engine is a separate Python implementation written from the same rules. The differential test catches implementation bugs, not a rule both engines read the same wrong way.
2. **The differential stream is narrow:** prices 95–105, quantities 1–40, tick 1, three owners. Wider prices, ticks and extremes are covered by the property tests, not by the comparison.
3. **Self-trade prevention is only checked by Rust tests.** The reference has no owners, so `CancelNewest` has no second implementation to compare against.
4. **Timings are from shared cloud VMs** with no core isolation, and each latency sample includes reading the clock. Two VMs of the same class differed by 20–35%; the GitHub runner was faster than both. Counts and fingerprints were identical everywhere.
5. **The benchmark mix is synthetic:** one owner, uniform random choices. It shows the engine's cost per command, not behaviour under a real exchange's order flow.
6. **Memory grows for the whole session.** The order archive, journal and tombstones are never trimmed (about 88 MB per million commands, plus 8 bytes per tombstone).
7. **The fingerprint detects accidental divergence, not tampering** (FNV-1a, and the chain can be recomputed by anyone who edits the journal).
8. **Configuration limits panic by design.** `Engine::new` asserts `tick >= 1` and `max_qty <= 2^32`. The 2^32 bound exists because the property tests found that larger orders could wrap a level's `u64` total.
9. **One wasm value is not exact:** a market buy's accepted price is the sentinel `Price::MAX`, which `f64` cannot represent exactly. The app ignores market-order prices.
