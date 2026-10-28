# Architecture

The design in one sentence: **the exchange's state is a pure function of a journal of sequenced commands**, and everything else (the book, market data, each trader's view, the audit trail) is derived from that journal's events.

---

## 1. Components

| Component | Where | Responsibility |
|-----------|-------|----------------|
| `Engine` | `crates/engine/src/engine.rs` | Validates commands, runs the matching loop (price-time priority; limit / market (IOC) / cancel) and emits events. Never panics on bad input. Coordinates the types below; never edits their fields directly. |
| `Book`, `BookSide`, `Level` | `book.rs` | Both sides of the book; each side a `BTreeMap<Price, Level>`, each level a FIFO `VecDeque` of order ids with running totals. A level's totals change only through `BookSide` methods, which also drop a level once it is empty. |
| `OrderStore` | `orders.rs` | Every accepted order, by dense id. Checked lookup for ids from outside (wasm32-safe), direct access for ids the engine issued. |
| `Order` | `types.rs` | Changes state only through `fill` and `cancel`; callers get read-only `&Order`. |
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

Arena adds market orders, a tick grid, a per-order quantity cap, owners (only the owner may cancel), optional self-trade prevention and L2 `Level` events. A market order is defined as a limit at the worst possible price whose remainder is cancelled, which is also how the differential test expresses it to the reference engine.

### Self-trade prevention

`EngineConfig::self_trade` selects the policy. The default, `Off`, is the reference behaviour: orders of the same owner trade with each other, and the differential test checks that. `CancelNewest` works as follows:

- While matching, the incoming order looks at the next resting order it would trade with (best price, then time priority, skipping cancelled orders). If that order has the same owner, matching stops.
- The incoming order's remaining quantity is cancelled with `Done { reason: SelfTrade }`. It never rests, and for a market order this replaces `Expired`.
- The resting order is not touched. Trades already made with other owners' orders, earlier in the same command, stand.
- Orders queued behind the owner's resting order at the same level are not reached.

The reference engine has no owners, so this mode is covered by the Rust unit tests and the random-stream invariant test only, not by the differential test. The simulation and the browser run with the default, so fingerprints are unchanged.

## 3. Decisions and trade-offs

### 3.1 Orders in a dense `Vec`, not a `HashMap`

Ids are dense, so `orders[id - 1]` is both the index and the archive: O(1) lookup with no hashing, and no `HashMap` iteration order to leak into results. The cost is memory proportional to all orders ever accepted (40 bytes each), which is fine for a session, and the same trade-off exchanges make with a per-day order store (see [Known limits](#5-known-limits)).

### 3.2 Lazy cancels

A cancel marks the order cancelled and adjusts its level's quantity and live count at once, but leaves the id in the level's queue. Matching pops such tombstones when they reach the front; a level is removed (with its tombstones) as soon as it has no live orders. So cancel is O(log levels), market data is always exact, and queue order is never disturbed. The worst case is a level holding many tombstones, which are cleared in one pass the next time it trades or empties.

### 3.2a Each type owns its invariants

The engine never edits a level's totals or an order's status by hand: `Level` keeps its quantity and live count private and `BookSide` changes them (and removes empty levels) in one place; `Order::fill` and `Order::cancel` keep status and remaining quantity consistent. There are no traits: each concept has exactly one implementation, and a trait would add indirection with no second user. Self-trade prevention is an enum with a method (`blocks`) rather than a trait object, so the configuration stays `Copy` and deterministic.

### 3.3 `BTreeMap` price levels

Ordered iteration for depth, O(log n) best-price and insert. A flat array indexed by price tick would be faster for a band of active prices (the classic exchange layout), at the cost of a fixed price range; that is the next optimisation (see [ROADMAP](ROADMAP.md)).

### 3.4 Determinism by construction

No floats, no clocks, no randomness outside the seeded generator, no hash-map iteration. Time is the exchange's own clock, advanced by the simulation step, and is part of each journal entry. This is what makes three things possible: replay, the fingerprint chain, and identical results natively and in WebAssembly.

### 3.5 The fingerprint chain

After command *n*: `chain[n] = FNV-1a(chain[n−1], seq, ts, command, every event it produced)`. A replay that matches at step *n* matched at every earlier step too, and a single changed command changes every later fingerprint (tested). FNV-1a is used because it is tiny, portable and identical natively and in WebAssembly.

What it detects: **accidental divergence**. A replay on another platform, a newer build, a dropped or reordered command, or a bug that changes any event changes the fingerprint at that step and every step after it.

What it does not detect: **tampering**. FNV-1a is not collision-resistant, so a determined editor could craft a different journal with the same 64-bit value; more simply, anyone who can edit the journal can recompute the whole chain. Swapping in SHA-256 would fix the first problem only. A tamper-evident log also needs the head of the chain published or signed somewhere the editor cannot change it. Arena does neither, and its "verified" means "this replay reproduced the live run", not "this journal is authentic".

### 3.6 No `wasm-bindgen`

The module exports plain functions taking and returning numbers. Results (events, depth, journal rows) go into a `Vec<f64>` whose pointer TypeScript reads as a `Float64Array`. Prices, quantities, ids, owners and timestamps in a session stay below 2^53, so `f64` carries them exactly, and JavaScript gets ordinary numbers rather than BigInts. One exception: a market buy is accepted at the sentinel price `Price::MAX`, which `f64` cannot represent exactly; the app ignores the price of market orders (`web/src/core/session.ts`). The fingerprint is a 64-bit value, so it is passed as two 32-bit halves. Result: a module under 90 KB (the exact size depends on the Rust version) with zero imports, no generated glue and no build tool beyond `cargo`.

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

## 3A. Real-market mode

`Sim::anchor(price)` pins the hidden fair value to an external price; the unanchored random walk is untouched, so every seed still gives the same market (the cross-platform fingerprint test proves it). In real-market mode the local bridge (`bridge/`) streams the front-month NIFTY future from Kite Connect and the browser anchors the simulator to each tick. Bot commands still go through the sequencer, so the journal replays a real-market session exactly without the feed or the bots. Details and the security model: [REAL_MARKET.md](REAL_MARKET.md).

## 4. Session Wrapped

Charges use F&O Wrapped's dated rate table for index futures (2026): brokerage min(₹20, 0.03%) per executed order, STT 0.05% of sells, NSE ₹1.73 per lakh, SEBI ₹10 per crore, stamp duty 0.002% of buys, GST 18% on brokerage + exchange + SEBI. "Against fair value" sums, over every fill, how far the price was from the hidden fair value at that moment, signed so that negative means edge given away: mostly the spread, plus timing.

## 5. Known limits

| Limit | Detail |
|-------|--------|
| **Unbounded order archive** | Every accepted order stays in `Engine::orders` for the life of the engine, 40 bytes each, because the dense id is its index. Nothing is evicted. |
| **Unbounded journal** | Every command stays in the journal (40 bytes) with its fingerprint (8 bytes). With the archive, that is up to 88 bytes per command: about 88 MB per million commands, all in memory. There is no snapshot-and-truncate. |
| **Cancelled-order tombstones** | A cancel leaves the order's id (8 bytes) in its level's queue (§3.2). Tombstones are removed only when matching reaches them at the front of the queue or when the level's last live order goes. A level that always keeps one live order and never trades collects tombstones without bound, and `queue`, `queue_ahead`, `book_hash` and `check_invariants` walk them. |
| **Single instrument, single thread** | One book per engine; the engine is not shared across threads. |
| **No persistence** | State lives in process memory. The browser can download the journal as a JSON file, but nothing is saved automatically and there is no import or restore yet ([ROADMAP](ROADMAP.md)). |
| **No self-trade prevention by default** | `SelfTradePrevention::Off` is the default, to match the reference engine. `CancelNewest` is the only other policy, and the differential test does not cover it (§2). |
| **Quantity bounds** | `max_qty` is at most 2^32 (`MAX_ORDER_QTY`, checked by `Engine::new`), and a level counts its orders in a `u32`, so a single price can hold fewer than 2^32 orders. |
| **Fingerprint is not tamper-evident** | FNV-1a detects accidental divergence only (§3.5). |
| **Order types** | Limit (rests until filled or cancelled), market (immediate-or-cancel) and cancel only. No amend, no other time-in-force, no auctions, no circuit breakers. |
| **Latency tail** | p99.9 is about 3–7 µs from an empty book and 7–15 µs on a book of a million orders, on a shared VM ([BENCHMARKS](BENCHMARKS.md)). |
