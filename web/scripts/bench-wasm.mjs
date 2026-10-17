// Times the engine's WebAssembly build on the benchmark workload, in Node or
// headless Chromium, the way docs/BENCHMARKS.md reports it:
//
//   npm run wasm
//   node scripts/bench-wasm.mjs node 2000000 5
//   node scripts/bench-wasm.mjs chromium 1000000 3
//
// Each run calls arena_bench_prepare (generates the workload, untimed) and
// then times arena_bench_run, the same two exports the app's benchmark
// button calls from a Web Worker. Here Chromium runs them on the page's main
// thread. Set PW_CHROMIUM_PATH to use a Chromium other than Playwright's own.
import { readFileSync } from 'node:fs';

const [runtime = 'node', n = '2000000', runs = '5'] = process.argv.slice(2);
const wasm = readFileSync(new URL('../public/arena.wasm', import.meta.url));

/** Runs in Node or in the page: instantiate, then prepare and time each run. */
async function bench(bytes, n, runs) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const out = [];
  for (let i = 0; i < runs; i++) {
    x.arena_bench_prepare(n);
    const t = performance.now();
    const trades = x.arena_bench_run();
    out.push({ trades, ms: performance.now() - t });
  }
  return out;
}

let label;
let results;
if (runtime === 'node') {
  label = `Node ${process.version}`;
  results = await bench(wasm, Number(n), Number(runs));
} else if (runtime === 'chromium') {
  const { chromium } = await import('@playwright/test');
  const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ executablePath });
  try {
    label = `Chromium ${browser.version()}`;
    const page = await browser.newPage();
    results = await page.evaluate(
      async ([src, b64, n, runs]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return (0, eval)(`(${src})`)(bytes, n, runs);
      },
      [bench.toString(), wasm.toString('base64'), Number(n), Number(runs)],
    );
  } finally {
    await browser.close();
  }
} else {
  console.error(`unknown runtime ${runtime}: use node or chromium`);
  process.exit(2);
}

for (const r of results) {
  const mps = Number(n) / r.ms / 1000;
  console.log(`${label}: ${n} commands, ${r.trades} trades, ${r.ms.toFixed(0)} ms, ${mps.toFixed(2)} M commands/s`);
}
