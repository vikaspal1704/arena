# Roadmap

## Phase 1 ✅ (this release)

Rust engine with lazy cancels and a fingerprinted journal; differential test against the Python engine; benchmark; WebAssembly with no glue; trading desk with queue position; market-data feed with chaos and recovery; time travel; in-browser benchmark; session Wrapped; CI and Pages.

## Phase 2: depth

| Item | Why |
|------|-----|
| Flat price-indexed levels and an intrusive order list | Bring p99.9 under 2 µs ([BENCHMARKS](BENCHMARKS.md)) |
| Property tests with `proptest` and a `cargo fuzz` target on the command decoder | Shrinking counterexamples; fuzzed input handling |
| Self-trade prevention, post-only and stop orders | Order types exchanges actually offer |
| Opening auction (uniform-price call) | The other half of exchange matching |
| Drills: "make 5 passive fills", "flat by the close", "no market orders" | Turns the sandbox into deliberate practice |
| Import a journal file and replay it | Share a session; audit someone else's |

## Phase 3: multiplayer

A small server (FastAPI, reusing the auth and deployment patterns of [recruiter-backend](https://github.com/vikaspal1704/recruiter-backend) and the WebSocket fan-out of [live-orderbook-feed](https://github.com/vikaspal1704/live-orderbook-feed)) running the same engine natively: several people in one market, a leaderboard by net P&L after charges, and the journal published at the end so anyone can verify the results.
