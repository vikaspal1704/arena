#!/usr/bin/env bash
# Checks the engine claims made in README.md and docs/BENCHMARKS.md, one by
# one, and prints PASS / FAIL / SKIP for each. Exact values (counts,
# fingerprints, sizes) are asserted; timings depend on the host, so they are
# printed, not asserted. See docs/REVIEWING.md.
#
#   scripts/verify-claims.sh              # engine claims (~3-5 min)
#   scripts/verify-claims.sh --mutations  # also: break the engine on purpose
#                                         # in a throwaway copy and check the
#                                         # tests catch it (~5 more min)
#   scripts/verify-claims.sh --web        # also: the web app's own checks
#
# Needs cargo. Optional: the wasm32-unknown-unknown target and node (wasm
# claims), python3 with mini-matching-engine (difftest):
#   rustup target add wasm32-unknown-unknown
#   pip install git+https://github.com/vikaspal1704/mini-matching-engine

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)

MUTATIONS=0
WEB=0
for arg in "$@"; do
  case "$arg" in
    --mutations) MUTATIONS=1 ;;
    --web) WEB=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

pass=0 fail=0 skip=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
no() { echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; fail=$((fail + 1)); }
na() { echo "SKIP  $1 ($2)"; skip=$((skip + 1)); }
# expect <claim> <expected substring> <actual output>
expect() { case "$3" in *"$2"*) ok "$1" ;; *) no "$1" "expected '$2'" ;; esac; }

echo "== Build and test gates"
cargo fmt --check >/dev/null 2>&1 && ok "cargo fmt --check" || no "cargo fmt --check"
cargo clippy -q --all-targets -- -D warnings >/dev/null 2>&1 && ok "cargo clippy -D warnings" || no "cargo clippy -D warnings"
tests=$(cargo test -q --release 2>&1)
if echo "$tests" | grep -q "FAILED\|panicked\|error"; then
  no "cargo test --release" "$(echo "$tests" | grep -m3 'FAILED\|panicked\|error')"
else
  n=$(echo "$tests" | grep -o '[0-9]* passed' | awk '{s += $1} END {print s}')
  ok "cargo test --release ($n tests)"
fi

echo "== Engine is dependency-free and deterministic"
deps=$(cargo tree -q -p arena-engine -e normal 2>/dev/null | wc -l)
[ "$deps" -eq 1 ] && ok "arena-engine has no normal dependencies" || no "arena-engine has no normal dependencies" "cargo tree shows $deps lines"
hits=$(grep -nE '\bf32\b|\bf64\b|HashMap|HashSet|Instant|SystemTime|unsafe' crates/engine/src/*.rs)
[ -z "$hits" ] && ok "no floats, clocks, hash maps or unsafe in crates/engine/src" || no "no floats, clocks, hash maps or unsafe in crates/engine/src" "$hits"
fp=$(cargo run -q --release -p arena-engine --example fingerprint -- 42 2000)
expect "simulation fingerprint (ci.yml, core.test.ts)" "seq 4181 fingerprint 8d44c209bd24be3e" "$fp"

echo "== WebAssembly build"
if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown && command -v node >/dev/null; then
  cargo build -q --release -p arena-wasm --target wasm32-unknown-unknown
  wasm=target/wasm32-unknown-unknown/release/arena_wasm.wasm
  bytes=$(wc -c <"$wasm")
  # The exact size depends on the Rust version (83,292 bytes with rustc
  # 1.97.0, 84,332 with a newer stable), so the claim is a bound.
  rustc_v=$(rustc --version | cut -d' ' -f2)
  if [ "$bytes" -lt $((90 * 1024)) ]; then
    ok "module is under 90 KB ($bytes bytes, rustc $rustc_v)"
  else
    no "module is under 90 KB" "it is $bytes bytes with rustc $rustc_v: update README and docs"
  fi
  imports=$(node -e "console.log(JSON.stringify(WebAssembly.Module.imports(new WebAssembly.Module(require('fs').readFileSync('$wasm')))))")
  [ "$imports" = "[]" ] && ok "module has zero imports (no JavaScript glue)" || no "module has zero imports" "$imports"
else
  na "WebAssembly claims" "needs the wasm32-unknown-unknown target and node"
fi

echo "== Differential test against the Python reference"
if python3 -c "import matching_engine" 2>/dev/null; then
  cargo build -q --release -p arena-difftest
  out=$(python3 difftest/compare.py --seeds 1-300 --count 5000 2>&1)
  expect "300 seeds x 5,000 commands agree with mini-matching-engine" "OK: 300 seeds, 1,500,000 commands, 963,654 trades" "$out"
else
  na "differential test" "pip install git+https://github.com/vikaspal1704/mini-matching-engine"
fi

echo "== Benchmark workload (exact values; timings printed only)"
bench=$(cargo run -q --release -p arena-bench -- 2000000)
std=$(echo "$bench" | awk '/scenario +standard/,/^$/')
deep=$(echo "$bench" | awk '/scenario +deep/,/^$/')
expect "standard: 986,325 trades" "trades              986325" "$std"
expect "standard: 0 cancels rejected" "cancels rejected    0 (0.00%)" "$std"
expect "standard: book levels avg 109.5, max 165" "avg 109.5, max 165" "$std"
expect "standard: 3,215 orders resting at the end" "final resting       3215" "$std"
expect "standard: fingerprint e23f832f942290da" "e23f832f942290da" "$std"
expect "deep: starts from 1,000,000 orders" "starting orders     1000000" "$deep"
expect "deep: 836,421 trades" "trades              836421" "$deep"
expect "deep: 0 cancels rejected" "cancels rejected    0 (0.00%)" "$deep"
expect "deep: book levels avg 50145.1, max 50383" "avg 50145.1, max 50383" "$deep"
expect "deep: 1,154,386 orders resting at the end" "final resting       1154386" "$deep"
expect "deep: fingerprint 4e63e48c88c947ef" "4e63e48c88c947ef" "$deep"
echo "      timings on this host (compare with docs/BENCHMARKS.md, not asserted):"
echo "$bench" | grep -E 'scenario|throughput|latency' | sed 's/^/        /'

if [ "$MUTATIONS" -eq 1 ]; then
  echo "== Mutations: the tests must catch a deliberately broken engine"
  tmp=$(mktemp -d)
  git worktree add -q --detach "$tmp/tree" HEAD
  export CARGO_TARGET_DIR="$tmp/target"
  # mutate <claim> <sed expression> <file> <command that must FAIL>
  mutate() {
    (cd "$tmp/tree" && git checkout -q -- . && sed -i "$2" "$3")
    if (cd "$tmp/tree" && git diff --quiet); then
      no "$1" "the mutation did not apply: update this script"
      return
    fi
    if (cd "$tmp/tree" && eval "$4") >/dev/null 2>&1; then
      no "$1" "the tests still pass with the engine broken"
    else
      ok "$1"
    fi
  }
  props="cargo test -q --release -p arena-engine --test properties"
  mutate "proptest catches a cancel that leaves the level total unchanged" \
    's/        level.qty -= remaining;/        let _ = remaining;/' crates/engine/src/book.rs "$props"
  mutate "proptest catches trades printed at the taker's price" \
    '/trade_id: \*next_trade_id,/{n;s/                price,/                price: orders.issued(taker_id).price,/}' \
    crates/engine/src/engine.rs "$props"
  mutate "scenario tests catch naive one-to-one matching (an order stops after its first trade)" \
    's/^            changes.touch(maker_side, price);$/            changes.touch(maker_side, price);\n            return MatchEnd::Exhausted;/' crates/engine/src/engine.rs \
    "cargo test -q --release -p arena-engine --test scenarios"
  mutate "unit tests catch time priority broken (newest first)" \
    's/        self.queue.push_back(id);/        self.queue.push_front(id);/' crates/engine/src/book.rs \
    "cargo test -q --release -p arena-engine --test matching"
  mutate "pinned fingerprint catches a chain that ignores timestamps" \
    's/    h.write(entry.ts_ms);/    let _ = entry.ts_ms;/' crates/engine/src/exchange.rs \
    "cargo run -q --release -p arena-engine --example fingerprint -- 42 2000 | grep -q 8d44c209bd24be3e"
  if python3 -c "import matching_engine" 2>/dev/null; then
    diff="cargo build -q --release -p arena-difftest && python3 $ROOT/difftest/compare.py --seeds 1-20 --count 5000 --binary $CARGO_TARGET_DIR/release/arena-difftest"
    mutate "difftest catches a missing owner check on cancel" \
      's/        if order.owner != owner {/        if false \&\& order.owner != owner {/' crates/engine/src/engine.rs "$diff"
    mutate "difftest catches self-trade prevention turned on by default" \
      's/            self_trade: SelfTradePrevention::Off,/            self_trade: SelfTradePrevention::CancelNewest,/' \
      crates/engine/src/engine.rs "$diff"
  else
    na "difftest mutations" "needs mini-matching-engine"
  fi
  unset CARGO_TARGET_DIR
  git worktree remove --force "$tmp/tree"
  rm -rf "$tmp"
fi

if [ "$WEB" -eq 1 ]; then
  echo "== Web app (its own checks, incl. the browser e2e suite)"
  (cd web && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run lint >/dev/null 2>&1) && ok "web: lint" || no "web: lint"
  (cd web && npm run typecheck >/dev/null 2>&1) && ok "web: typecheck" || no "web: typecheck"
  (cd web && npm test >/dev/null 2>&1) && ok "web: unit tests (incl. wasm fingerprint = native)" || no "web: unit tests"
  (cd web && npm run build >/dev/null 2>&1) && ok "web: build" || no "web: build"
  e2e=$(cd web && npm ci --prefix ../bridge --no-audit --no-fund >/dev/null 2>&1; npm run test:e2e 2>&1)
  if echo "$e2e" | grep -q " passed" && ! echo "$e2e" | grep -q " failed"; then
    ok "web: e2e ($(echo "$e2e" | grep -o '[0-9]* passed'))"
    echo "$e2e" | grep -o 'cumulative layout shift over 6 s: [0-9.]*' | sed 's/^/      /'
  else
    no "web: e2e" "set PW_CHROMIUM_PATH if Playwright's browser is missing"
  fi
fi

echo
echo "$pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ]
