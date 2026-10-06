// Builds the Rust engine for WebAssembly and copies it to public/arena.wasm.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, 'target');
execFileSync('cargo', ['build', '--release', '-p', 'arena-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' });
// public/ holds only the built module, which isn't committed, so a fresh checkout has no such folder.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
mkdirSync(publicDir, { recursive: true });
copyFileSync(resolve(targetDir, 'wasm32-unknown-unknown/release/arena_wasm.wasm'), resolve(publicDir, 'arena.wasm'));
