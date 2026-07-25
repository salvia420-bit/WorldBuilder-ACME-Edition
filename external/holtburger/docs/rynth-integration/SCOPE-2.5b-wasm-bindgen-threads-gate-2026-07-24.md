# SCOPE — wasm-bindgen threads gate: **PASSES** (2026-07-24)

> Branch: `perf/wasm-threads-sab`. Follows `SCOPE-2.5-atomics-toolchain` — that doc proved a raw
> `cargo build` links a shared-memory module, and explicitly listed this as the untested next gate:
> the real pipeline is `wasm-pack` → `wasm-bindgen` post-processing, which must handle a
> shared-memory module and emit thread-aware glue.

## Verdict

`wasm-bindgen` **0.2.108** post-processes a shared-memory module correctly — but **only with the
complete flag set below.** The widely-cited `wasm-bindgen-rayon` recipe (three target features and
nothing else) is NOT sufficient on rustc 1.99-nightly: it silently produces a **non-threaded**
package. CLI/crate version skew was ruled out (both exactly 0.2.108).

## The working recipe

```sh
cd apps/holtburger-web
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals \
 -C link-arg=--shared-memory \
 -C link-arg=--import-memory \
 -C link-arg=--max-memory=2147483648 \
 -C link-arg=--export=__heap_base \
 -C link-arg=--export=__tls_base \
 -C link-arg=--export=__tls_size \
 -C link-arg=--export=__tls_align \
 -C link-arg=--export=__wasm_init_tls" \
rustup run nightly wasm-pack build . --target web --out-dir pkg-threads --dev \
  -- -Z build-std=std,panic_abort
```

Notes: the `.` path positional is REQUIRED — without it wasm-pack parses `-Z` as the crate
directory and dies with "crate directory is missing a `Cargo.toml`". `--dev` avoids `wasm-opt`,
which is a separate (untested) threads question. ~5 min warm, longer cold.

## Verification — do NOT trust wasm-pack's exit code

```
IMPORTED memory ./holtburger_web_bg.js.memory:
  flags=0x03  shared=True  min=34 pages  max=32768 pages (2 GiB)
```
JS glue (`holtburger_web.js:21317`):
```js
memory: memory || new WebAssembly.Memory({initial:34,maximum:32768,shared:true}),
```

Check both with `python3 scripts/wasm-memcheck.py <pkg>/holtburger_web_bg.wasm` plus a
`rg 'shared:true' <pkg>/holtburger_web.js`. **This matters** — see attempt 2 below, which exits 0,
prints `✨ Done` / `📦 Your wasm pkg is ready`, and hands you a perfectly valid SINGLE-THREADED
package. A zero exit code is not evidence of a threaded artifact.

## How we got there (each failure named exactly one missing thing)

| # | Flags | Outcome |
|---|---|---|
| 1 | atomics + `--shared-memory` + `--max-memory` | shared ✓ but `failed to find __heap_base for injecting thread id` |
| 2 | atomics only (the published rayon recipe) | **exit 0, silently NOT shared** — the dangerous one |
| 3 | \+ `--export=__heap_base` + TLS exports | `threads/mod.rs:74: assertion failed: mem.import.is_some()` |
| 4 | \+ `--import-memory` | `failed to find __wasm_init_tls` |
| 5 | \+ `--export=__wasm_init_tls` | **PASS** |

(An attempt with a speculative `--export=__wasm_init_memory` fails at link: that symbol does not
exist in this configuration.)

Root cause of the pattern: `wasm-ld` GCs the symbols wasm-bindgen's thread transform needs, and
the transform requires the memory to be **imported** rather than module-defined.

The export set has NOT been minimised — `__tls_size` / `__tls_align` may be unnecessary; each
trial is a ~5 min rebuild, so this is the known-good set, not the minimal one.

## What this does NOT establish

- **No thread has been spawned.** `wasm-bindgen-rayon` is still not a dependency (and is not in the
  local registry cache — adding it needs network). No pool, no worker, nothing executed.
- **Nothing ran in a browser.** §2.4 proved the page can be cross-origin isolated and this proves a
  threaded package can be built; the two have never been combined.
- **The app's own loader does not pass a shared memory.** `index.html` and `bake_worker.js` both
  import `pkg/holtburger_web.js` and would need to share ONE memory across both entry points.
- **Debug profile only** (26 MB). Release + `wasm-opt` under threads is untested — `wasm-opt` needs
  `--enable-threads` and is a known separate failure mode.
- `wasm-pack` is 0.14.0 (0.15.0 available); unknown whether the newer version changes any of this.

## Artifact

`apps/holtburger-web/pkg-threads5/` retained as the first known-good threaded build (gitignored,
26 MB dev). Production `pkg/` verified byte-identical throughout — all trials used separate
out-dirs, so the running client was never touched.
