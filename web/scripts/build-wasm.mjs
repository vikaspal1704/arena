// Builds the Rust engine for WebAssembly and copies it to public/arena.wasm.
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
execFileSync('cargo', ['build', '--release', '-p', 'arena-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' });
copyFileSync(`${root}/target/wasm32-unknown-unknown/release/arena_wasm.wasm`, fileURLToPath(new URL('../public/arena.wasm', import.meta.url)));
