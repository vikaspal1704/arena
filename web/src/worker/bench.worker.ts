/// <reference lib="webworker" />
/**
 * Runs the engine benchmark in its own short-lived worker so the market
 * keeps ticking. The workload is generated first, outside the timed region,
 * exactly as the native benchmark does.
 */
import { ArenaCore } from '../core/wasm';

self.onmessage = async (e: MessageEvent<{ n: number }>) => {
  const url = new URL(`${import.meta.env.BASE_URL}arena.wasm`, self.location.href);
  const core = await ArenaCore.load(await (await fetch(url)).arrayBuffer());
  core.prepareBench(e.data.n);
  const t = performance.now();
  const trades = core.runBench();
  const ms = performance.now() - t;
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ n: e.data.n, trades, ms });
};
