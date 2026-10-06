# Architecture

The design in one sentence: **the exchange's state is a pure function of a journal of sequenced commands**, and everything else (the book, market data, each trader's view, the audit trail) is derived from that journal's events.

---

## 1. Components

| Component | Where | Responsibility |
|-----------|-------|----------------|
| `Engine` | `crates/engine/src/engine.rs` | Matching: price-time priority, limit / market (IOC) / cancel. Emits events; never panics on bad input. |
| `BookSide` | `book.rs` | One side of the book: `BTreeMap<Price, Level>`, each level a FIFO `VecDeque` of order ids. |
| `Exchange` | `exchange.rs` | Sequencer: numbers, timestamps and journals each command, applies it, extends the fingerprint chain. Replays any prefix. |
| `Sim` | `sim.rs` | Hidden fair value plus bots, driven by one seeded generator. |
| wasm bindings | `crates/wasm` | Plain `extern "C"` exports and a shared output buffer. |
| exchange worker | `web/src/worker/exchange.worker.ts` | Runs the market clock; publishes market data and private events. |
| `FeedBook` | `web/src/core/feed.ts` | Client book from numbered deltas; gap detection and snapshot recovery. |
| `Account` | `web/src/core/session.ts` | The player's orders, fills, FIFO round trips, charges, Wrapped. |

## 2. Matching rules

Identical to [mini-matching-engine](https://github.com/vikaspal1704/mini-matching-engine), which is the reference implementation:

- Order ids start at 1 and increase by 1 per **accepted** order; rejected commands consume no id.
- An incoming order matches the best opposite level while it crosses (buy: ask ≤ limit; sell: bid ≥ limit).
- Within a level, earlier orders fill first. A trade executes at the **resting** order's price.
- Whatever remains of a limit order rests; whatever remains of a market order expires (IOC).
- After every command the book is not crossed: best bid < best ask.

Arena adds market orders, a tick grid, a per-order quantity cap, owners (only the owner may cancel) and L2 `Level` events. A market order is defined as a limit at the worst possible price whose remainder is cancelled, which is also how the differential test expresses it to the reference engine.

## 3. Decisions and trade-offs

### 3.1 Orders in a dense `Vec`, not a `HashMap`

Ids are dense, so `orders[id - 1]` is both the index and the archive: O(1) lookup with no hashing, and no `HashMap` iteration order to leak into results. The cost is memory proportional to all orders ever accepted (≈ 48 bytes each), which is fine for a session, and the same trade-off exchanges make with a per-day order store.

### 3.2 Lazy cancels

A cancel marks the order cancelled and adjusts its level's quantity and live count at once, but leaves the id in the level's queue. Matching pops such tombstones when they reach the front; a level is removed (with its tombstones) as soon as it has no live orders. So cancel is O(log levels), market data is always exact, and queue order is never disturbed. The worst case is a level holding many tombstones, which are cleared in one pass the next time it trades or empties.

### 3.3 `BTreeMap` price levels

Ordered iteration for depth, O(log n) best-price and insert. A flat array indexed by price tick would be faster for a band of active prices (the classic exchange layout), at the cost of a fixed price range; that is the next optimisation (see [ROADMAP](ROADMAP.md)).

### 3.4 Determinism by construction

No floats, no clocks, no randomness outside the seeded generator, no hash-map iteration. Time is the exchange's own clock, advanced by the simulation step, and is part of each journal entry. This is what makes three things possible: replay, the fingerprint chain, and identical results natively and in WebAssembly.

### 3.5 The fingerprint chain

After command *n*: `chain[n] = FNV-1a(chain[n−1], seq, ts, command, every event it produced)`. A replay that matches at step *n* matched at every earlier step too, and a single changed command changes every later fingerprint (tested). FNV-1a is used because it is tiny and portable; it is a consistency check, not a security control. A tamper-evident log would use a cryptographic hash instead.

### 3.6 No `wasm-bindgen`

The module exports plain functions taking and returning numbers. Results (events, depth, journal rows) go into a `Vec<f64>` whose pointer TypeScript reads as a `Float64Array`. Every integer involved stays below 2^53, so `f64` carries it exactly, and JavaScript gets ordinary numbers rather than BigInts. Result: a 79 KB module with zero imports, no generated glue and no build tool beyond `cargo`.

### 3.7 The exchange runs in a Web Worker

The market keeps its 100 ms clock even when the UI is busy, and the boundary between the "exchange" and the "client" is a real message channel. That boundary carries two channels with different guarantees, as at a real venue:

| Channel | Carries | Guarantee |
|---------|---------|-----------|
| Market data | L2 level changes and trades, as numbered deltas | Lossy; the chaos switch drops a share of them on purpose |
| Private | The player's own accepts, fills, cancels, rejects | Reliable, never dropped |

### 3.8 Market-data recovery

The client applies deltas strictly in sequence. On a gap it marks its book **recovering**, ignores further deltas and requests a snapshot. A snapshot carries the feed sequence it reflects; deltas at or below it are already included and are skipped. This is the protocol of [live-orderbook-feed](https://github.com/vikaspal1704/live-orderbook-feed), moved into the browser. Tested by running the real engine with 20% loss and checking the client's book equals the engine's.

### 3.9 Bots are clients, not part of the engine

Bot commands go through the sequencer like the player's. Their logic lives outside the journal, so a replay needs only the journal, and a recorded session can be audited without trusting the bot code.

## 4. Session Wrapped

Charges use F&O Wrapped's dated rate table for index futures (2026): brokerage min(₹20, 0.03%) per executed order, STT 0.05% of sells, NSE ₹1.73 per lakh, SEBI ₹10 per crore, stamp duty 0.002% of buys, GST 18% on brokerage + exchange + SEBI. "Against fair value" sums, over every fill, how far the price was from the hidden fair value at that moment, signed so that negative means edge given away: mostly the spread, plus timing.

## 5. Limits

Single instrument, single process, in-memory. No self-trade prevention, no auctions, no circuit breakers. The p99.9 latency (≈15–20 µs on a shared VM) comes from allocation inside price levels and is the next thing to fix ([BENCHMARKS](BENCHMARKS.md)).
