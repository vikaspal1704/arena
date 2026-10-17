# Test plan

Every test below runs in CI (`.github/workflows/ci.yml`).

## Rust engine (`cargo test --release`)

| Test | Checks |
|------|--------|
| `ids_start_at_one_and_rest_without_a_cross` | First id is 1; a non-crossing order rests and emits its level |
| `trades_at_the_resting_price` | Execution price is the maker's |
| `price_priority_then_time_priority` | Better price first, then earlier order; partial maker stays |
| `partial_fill_rests_the_remainder` | Remainder of a limit order rests |
| `cancel_skips_the_order_and_keeps_queue_order` | Lazy cancel: level updated at once, tombstone skipped, FIFO kept |
| `cancelling_the_last_order_removes_the_level` | Empty levels are dropped and reported as qty 0 |
| `market_order_sweeps_and_the_rest_expires` | IOC: sweeps levels, remainder `Expired`, never rests |
| `rejects_change_nothing` | Bad price, off-tick, zero / oversized qty, unknown order: `Rejected`, no id used |
| `only_the_owner_can_cancel_and_only_once` | `NotOwner`, `NotCancellable` |
| `queue_shows_live_orders_front_first` | Queue view and `queue_ahead` ignore cancelled orders |
| `without_stp_an_owner_trades_with_itself` | Default config: same-owner orders trade (reference behaviour) |
| `stp_cancels_the_incoming_order_and_keeps_the_resting_one` | Cancel-newest: no trade, incoming `Done(SelfTrade)`, resting order and book untouched |
| `stp_keeps_trades_made_before_reaching_the_own_order` | Trades with other owners first stand; orders behind the own order are not reached |
| `stp_skips_the_owners_cancelled_orders` | A cancelled own order (tombstone) does not trigger prevention |
| `stp_reports_a_market_orders_remainder_as_self_trade` | Market remainder is `SelfTrade`, not `Expired` |
| `stp_lets_different_owners_trade` | Prevention only applies to the same owner |
| `invariants_hold_over_random_streams` | 20 seeds × 10,000 random commands from 4 owners, with and without self-trade prevention; `check_invariants` after each; with prevention, no trade has the same owner on both sides |
| `book_is_never_crossed_and_levels_equal_their_live_orders` | Property (proptest, 512 cases × up to 300 commands, random tick / max qty / self-trade mode): after every command best bid < best ask, each level's qty and order count equal the sum over its live queued orders (summed in `u128`), and every `Level` event equals the level as it now is |
| `traded_quantity_is_conserved` | Property: buy fills = sell fills = traded qty; each order's original qty = remaining + traded; trades print at the maker's price, within the taker's limit |
| `replaying_the_journal_reproduces_every_fingerprint` | Property: a fresh exchange fed the journal reproduces each command's events, the fingerprint after every entry, and the book hash |
| `arbitrary_commands_never_panic` | Property: every field of every command drawn from its full range (any `u32` owner, `i64` price, `u64` qty and order id, `u64` timestamp); no panic, invariants hold |
| `extreme_values_are_rejected_or_handled` | `i64::MIN/MAX` prices, `0` and `u64::MAX` quantities and ids, `u32::MAX` owners, in both configurations |
| `a_max_qty_that_could_overflow_a_level_is_refused` | `Engine::new` refuses `max_qty` above `MAX_ORDER_QTY` (2^32); found by the properties above, where `u64::MAX` orders wrapped a level total |
| `tombstones_accumulate_until_the_level_empties` | A level with one live order keeps all 1,000 cancelled ids in its queue, and drops them with the level (the documented tombstone limit) |
| `memory_per_order_and_journal_entry_is_as_documented` | `Order` and `JournalEntry` are 40 bytes each, a queue slot 8 (the documented memory figures) |
| `every_cancel_targets_a_live_order` | Benchmark workload: 0 rejected cancels over 3 seeds × 50,000 commands |
| `deep_book_starts_with_a_million_orders_on_50k_levels` | Deep-book scenario's starting book; 0 rejected cancels |
| `same_seed_same_commands` | Workload is seeded |
| `replaying_any_prefix_gives_the_same_fingerprint_and_book` | Prefixes 0, 1, 17, 500, all |
| `same_seed_same_market_different_seed_different_market` | Determinism of the simulation |
| `a_changed_command_changes_every_later_fingerprint` | Replaying a journal with one changed command diverges from the recorded chain at that entry and after it (accidental divergence; FNV-1a is not tamper-proof) |
| `the_simulated_market_stays_healthy` | 20,000 steps: trades happen, both sides quoted, tight spread, book tracks fair value |
| `player_orders_trade_with_bots` | A market buy fills against the bots |
| `anchored_market_follows_the_external_price_and_still_replays` | Book tracks an external price path; the journal alone replays it |
| `anchor_rounds_to_the_tick_and_can_be_released` | Anchor alignment and release |
| CI step: native = wasm | `fingerprint` example prints `seq 4181 fingerprint 8d44c209bd24be3e`; the Vitest test expects the same from the WebAssembly build |

## Differential test (`difftest/compare.py`)

300 seeds × 5,000 commands against [mini-matching-engine](https://github.com/vikaspal1704/mini-matching-engine), with the Rust engine in its default configuration (no self-trade prevention). Per command it compares order id, remaining quantity, rejection reason, every trade (price, qty, maker id, taker id, maker owner, taker owner) and the full aggregated book. The stream comes from three owners and includes market orders, same-owner trades, cancels of live, filled, cancelled and unknown orders, cancels by someone other than the owner, and invalid prices and quantities. The reference engine has no owners, so `compare.py` records each order's owner and applies the only-the-owner-may-cancel rule itself.

## Web core (`npm test`, Vitest, against the real WebAssembly build)

| Test | Checks |
|------|--------|
| `wasm_fingerprint_matches_native_build` | Same seed and steps as the native example, same fingerprint |
| `replay_verifies_every_prefix` | `replay(n)` matches the live fingerprint; replay depth equals live depth |
| `player_orders_trade_and_the_journal_records_them` | Fill events and the journal row |
| `shows_queue_position_of_a_resting_order` | Orders and quantity ahead |
| `rejects_off_tick_prices` | Tick grid |
| `feed_detects_gaps_and_recovers_from_snapshots_under_packet_loss` | 20% loss over 2,000 steps; client book ends equal to the engine's |
| `ignores_deltas_already_in_the_snapshot` | Stale deltas skipped |
| `fifo_round_trips_and_flips` | FIFO P&L, a flip from long to short, unrealised P&L |
| `wrapped_counts_maker_share_and_edge_vs_fair` | Maker share, edge against fair value, median rest time |
| `index_futures_round_trip_charges` | Every charge component, worked by hand |
| `lesson_one_completes_on_a_taker_fill_and_explains_the_spread_cost` | Lesson progress and its explanation in the player's numbers |
| `lessons_follow_feed_and_audit_activity` | Chaos lesson needs a gap *and* recovery; audit needs a verified replay |
| `coach_note_describes_a_fill_in_plain_words` | Spread cost against the mid before the command |
| `next_steps_are_personal` | "Try this next" advice follows the session's numbers |

## Kite bridge (`npm test` in `bridge/`, node:test)

| Test | Checks |
|------|--------|
| `tick_parser_matches_the_official_kite_parser_byte_for_byte` | Our parser vs Zerodha's on a full-mode frame: price, depth, volume, timestamp, in exact paise |
| `tick_parser_skips_heartbeats_and_partial_frames` | Robust to 1-byte heartbeats and truncated frames |
| `front_month_future_skips_expired_contracts_options_and_other_underlyings` | Contract selection, including expiry day |
| `client sends the documented headers and form, and maps Kite errors` | `X-Kite-Version`, checksum (never the secret), `TokenException` |
| `kite login: CSRF state checked, session saved privately, contract resolved, secret never leaves` | Forged callback refused, state single-use, session file 0600, secret absent from every response and message |
| `rejects other websites: wrong Host (DNS rebinding) and wrong Origin` | 421 and 403 |
| `static files cannot escape the build folder` | Encoded-slash traversal refused |
| `mock bridge serves Arena and streams sequenced ticks to its own origin` | Gap-free sequence, 5 levels a side |
| `without credentials the bridge still runs and says how to set up` | Setup state |
| `index_packets_match_the_official_parser` | 32-byte index packets (NIFTY 50, SENSEX, India VIX) vs Zerodha's parser |
| `paise_to_rupees_is_exact_and_rejects_bad_prices` | Order prices go out as exact rupee strings; negatives and fractions refused |
| `order calls send the documented form and read the latest order state` | Place, modify (SL trigger), cancel, latest status and average price |

## Options bot (`npm test` in `bot/`, node:test)

| Area | Checks |
|------|--------|
| Indicators and candles | EMA and Wilder ATR against hand values; 5-minute candles aligned to 09:15, pre-open ignored, closed on time without a tick |
| Config | Defaults valid; risk per trade above 10% of capital, daily cap above 20%, unknown keys and bad session times refused |
| Charges | A NIFTY round trip against a hand calculation (2026 STT); BSE exchange rate |
| Strategy | Fresh breakout with trend is a signal; second close is not fresh; counter-trend blocked; one trade per direction; failed breakout detected; no history, no trade |
| Option choice | Expiry-day skip; ATM then OTM order; spread, depth, stale quote, stop-too-tight and budget each rejected with a reason |
| Risk | Every gate (window, expiry cutoff, VIX, kill switch, event day, cooldown, streak, daily cap, capital floor); equity carries across days |
| Exits | Breakeven, trailing (never down), target, stop, time stop, square-off |
| Paper broker | Fills walk the real depth within the limit; SL-limit stop triggers and gaps like the exchange's |
| Live broker (scripted Kite) | Entry timeout cancels and keeps a partial fill; exit cancels the exchange stop before selling, never oversells; repricing then hand-over; rejected or outside-cancelled stops raise alerts |
| Ticker | Full-mode subscribe, token changes as unsubscribe/subscribe, parsed ticks, against a local WebSocket server |
| Live gate | Locked until enabled, acknowledged, 20 paper days and trades, profitable after charges, and confirmed at a terminal |
| Whole days (replay) | Trend up buys a call and exits at target; trend down buys a put; a failed breakout loses less than the risk limit; replays identical; the STOP file flattens and halts; event days and a losing streak keep it out; restart re-arms a paper stop and hands a live position to you |

## End to end (`npm run test:e2e`, Playwright, Chromium)

| Test | Flow |
|------|------|
| `e2e_trade_then_wrapped_with_verified_audit` | Buy and sell at market, end the session; Wrapped shows net P&L and a verified replay |
| `e2e_resting_order_shows_queue_and_cancels` | Rest an order at the bid, see its queue position, cancel it |
| `e2e_time_travel_replays_and_verifies` | Pause, replay to entry 20, verified; back to live |
| `e2e_chaos_drops_packets_and_the_book_heals` | 30% drop finds gaps; with chaos off the feed is live again |
| `e2e_same_seed_same_market` | Two pages, seed 7: same fingerprint at the same journal entry |
| `e2e_benchmark_runs_in_the_browser` | The 1M-command benchmark completes |
| `e2e_no_third_party_requests` | Only the page's own origin is contacted |
| `a11y_intro_desk_and_wrapped` | axe-core, no violations on the intro, the desk and Wrapped |
| `e2e_lessons_guide_and_explain_with_coach_notes` | Lesson 1 completes on a market buy, explains it, coach note appears, lesson 2 starts |
| `e2e_glossary_tip_opens_and_closes` | "?" opens a note; Escape closes it |
| `e2e_trade_freely_skips_the_lessons` | "Trade freely" starts with the lessons collapsed |
| `e2e_no_dashes_or_symbol_glyphs_in_visible_text` | No em/en dashes or text glyphs standing in for icons, on the desk and in Wrapped ([DESIGN](DESIGN.md)) |
| `a11y_dark_theme_desk_and_wrapped` | axe-core passes in the dark theme too |
| `e2e_real_mode_trades_around_bridge_prices` | Against the mock bridge: NSE book shown, lot from the contract, fill near the real price, Wrapped explains the seed caveat |
| `e2e_real_mode_without_credentials_shows_setup_steps` | Setup screen with the exact redirect URL |
| `e2e_public_site_is_unchanged_without_real_flag` | No real-market UI on the public site |
| `e2e_layout_stays_still_while_the_market_moves` | 6 s of live market at normal speed: no watched panel moves, cumulative layout shift < 0.05 |
