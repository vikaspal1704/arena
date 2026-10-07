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
| `invariants_hold_over_random_streams` | 20 seeds × 10,000 random commands; `check_invariants` after each |
| `replaying_any_prefix_gives_the_same_fingerprint_and_book` | Prefixes 0, 1, 17, 500, all |
| `same_seed_same_market_different_seed_different_market` | Determinism of the simulation |
| `a_changed_command_changes_every_later_fingerprint` | Fingerprint chain detects an edited journal |
| `the_simulated_market_stays_healthy` | 20,000 steps: trades happen, both sides quoted, tight spread, book tracks fair value |
| `player_orders_trade_with_bots` | A market buy fills against the bots |
| `anchored_market_follows_the_external_price_and_still_replays` | Book tracks an external price path; the journal alone replays it |
| `anchor_rounds_to_the_tick_and_can_be_released` | Anchor alignment and release |
| CI step: native = wasm | `fingerprint` example prints `seq 4181 fingerprint 8d44c209bd24be3e`; the Vitest test expects the same from the WebAssembly build |

## Differential test (`difftest/compare.py`)

300 seeds × 5,000 commands against [mini-matching-engine](https://github.com/vikaspal1704/mini-matching-engine). Per command it compares order id, remaining quantity, rejection reason, every trade (price, qty, maker id, taker id) and the full aggregated book. The stream includes market orders, cancels of live, filled, cancelled and unknown orders, and invalid prices and quantities.

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
