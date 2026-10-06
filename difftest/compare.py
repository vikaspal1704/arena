"""Differential test, Python side.

Runs the Rust engine's command stream through the reference Python engine
(https://github.com/vikaspal1704/mini-matching-engine) and fails on the first
difference in order ids, trades, rejections, remaining quantity or the
aggregated book.

    pip install git+https://github.com/vikaspal1704/mini-matching-engine
    python difftest/compare.py --seeds 1-50 --count 5000
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from matching_engine import (
    MatchingEngine,
    OrderNotCancellableError,
    OrderNotFoundError,
    OrderSide,
    ValidationError,
)

# A market order, expressed as a limit the reference engine will always cross.
MARKET_BUY_PRICE = 2**63 - 1
MARKET_SELL_PRICE = 1


def reference(cmd: dict, engine: MatchingEngine) -> dict:
    """The reference engine's result for one command, in the Rust line's shape."""
    order_id = remaining = None
    rejected = None
    trades: list[list[int]] = []
    try:
        if cmd["type"] == "cancel":
            engine.cancel(cmd["order_id"])
        else:
            side = OrderSide(cmd["side"])
            if cmd["type"] == "market":
                price = MARKET_BUY_PRICE if side is OrderSide.BUY else MARKET_SELL_PRICE
                result = engine.submit_limit(side, price, cmd["qty"])
                if result.order.remaining_quantity > 0:
                    engine.cancel(result.order.order_id)
            else:
                result = engine.submit_limit(side, cmd["price"], cmd["qty"])
            order_id = result.order.order_id
            remaining = result.order.remaining_quantity
            for t in result.trades:
                maker, taker = (t.sell_order_id, t.buy_order_id) if side is OrderSide.BUY else (t.buy_order_id, t.sell_order_id)
                trades.append([t.price, t.quantity, maker, taker])
    except ValidationError as e:
        rejected = "BadQty" if "quantity" in str(e) else "BadPrice"
    except OrderNotFoundError:
        rejected = "UnknownOrder"
    except OrderNotCancellableError:
        rejected = "NotCancellable"
    book = engine.get_book()
    return {
        "order_id": order_id,
        "remaining": remaining,
        "rejected": rejected,
        "trades": trades,
        "bids": [[lv.price, lv.quantity, lv.order_count] for lv in book.bids],
        "asks": [[lv.price, lv.quantity, lv.order_count] for lv in book.asks],
    }


def run(binary: list[str], seed: int, count: int) -> int:
    lines = subprocess.run([*binary, str(seed), str(count)], check=True, capture_output=True, text=True).stdout.splitlines()
    engine = MatchingEngine("ARENA")
    trades = 0
    for n, raw in enumerate(lines, 1):
        rust = json.loads(raw)
        cmd = rust.pop("cmd")
        ref = reference(cmd, engine)
        if ref != rust:
            diff = {k: (rust[k], ref[k]) for k in rust if rust[k] != ref[k]}
            sys.exit(f"seed {seed}, command {n} {cmd}: rust vs python differ: {diff}")
        trades += len(ref["trades"])
    return trades


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--seeds", default="1-20", help="e.g. 1-50")
    p.add_argument("--count", type=int, default=5000)
    p.add_argument("--binary", default="target/release/arena-difftest")
    a = p.parse_args()
    lo, _, hi = a.seeds.partition("-")
    seeds = range(int(lo), int(hi or lo) + 1)
    total_cmds = total_trades = 0
    for seed in seeds:
        total_trades += run([a.binary], seed, a.count)
        total_cmds += a.count
    print(f"OK: {len(seeds)} seeds, {total_cmds:,} commands, {total_trades:,} trades; Rust and Python agree on every one")


if __name__ == "__main__":
    main()
