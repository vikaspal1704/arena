# Agent notes

- Read `README.md`, then `docs/ARCHITECTURE.md` and `docs/TEST_PLAN.md`.
- The engine must stay deterministic: no floats, clocks, randomness outside `sim::Rng`, or hash-map iteration in `crates/engine`. `web/src/core` follows the same rule (lint enforced).
- Matching rules are defined by mini-matching-engine; any change must keep `difftest/compare.py` passing.
- Changing anything that affects events changes fingerprints: update the expected value in CI (`ci.yml`) and in `web/tests/unit/core.test.ts` together, and say why in the commit.
- Before pushing: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --release`, then in `web/`: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e`.
