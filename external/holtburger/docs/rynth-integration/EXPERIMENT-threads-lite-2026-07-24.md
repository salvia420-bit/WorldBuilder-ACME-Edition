# EXPERIMENT — "threads-lite": shared wasm memory between main + bake worker

**Verdict: DO NOT SHIP. Negative result, but a decisive one.**
Measured 2026-07-24 on the 8 GB no-GPU laptop (SwiftShader), headless, `nullRender=1`,
against local ACE. All arms are DEV builds — see *Limits*.

## Hypothesis

Skip rayon entirely. Have the EXISTING bake web-worker join the main thread's linear memory via
`initSync({module, memory})` instead of minting its own. Both already run decode; today they are
two wasm instances with two memories. Predicted: halves the RSS high-water and activates the
§2.2/2.2b/2.2c shared-container work, which is inert while the instances are separate.

## What was built (flag-gated, default OFF: `?sharedWasm=on`)

- `index.html` — compiles the module on the page (`WebAssembly.compileStreaming`), passes it to
  `init({module_or_path})`, publishes `{module, memory}` from `InitOutput` on `window.__hbSharedWasm`.
  The glue keeps its own `wasmModule` private, and reading `memory` back out of `InitOutput`
  avoids hardcoding the module's minimum page count.
- `scene3d/bake_worker_client.js` — forwards `{sharedModule, sharedMemory}` in the worker init msg.
- `scene3d/bake_worker.js` — `initSync({module, memory})` when present, else the unchanged path.

## Results

### Sharing works
Short probe (~30 s): main and worker report IDENTICAL `surfaceDecodeTotal`, `surfaceCacheEntries`,
`surfaceCacheBytes`, `wasmMemoryBytes`. Baseline discriminator: main=0 decodes / worker=74.
Boots to in-world, zero console errors. The mechanism is real.

### Memory — the hypothesis is WRONG

| arm | build | sharing | memory | outcome |
|---|---|---|---|---|
| A | normal | off | main 690 MB + worker 227 MB = **917 MB** | 24 hops, no crash |
| B | atomics | **on** | **732 MB** (retry 777 MB), flat from hop 1 | **crash hop 6 / hop 7** |
| C | atomics | off | main 690 MB + worker 215 MB | crash hop 24 |

- **A vs C: the threaded BUILD costs nothing.** Atomics + `-Z build-std` + 25 MB dev wasm lands
  within noise of the normal build. An earlier claim that a ~180 MB regression was "build
  overhead" is **refuted** by arm C.
- **The regression is the SHARING.** One never-shrinking memory absorbs both threads' cold-load
  peaks coincidentally, so the high-water floor is set early and stays (flat at 732 MB from hop 1).
  Two separate memories reach the same total more gradually and can be sized independently.
- **Sharing reaches the OOM ceiling ~4× sooner** (hop 6 vs hop 24).

### The crash is renderer OOM, not a wasm trap
Instrumented capture (streamed live, so a page death still leaves a reason):
```
!!! WORKER CLOSED: keepalive_worker.js
!!! WORKER CLOSED: bake_worker.js
!!! PAGE CRASHED (renderer gone)
```
**Zero** JS-level errors preceded it — no `RuntimeError`, no `PAGEERROR`, only benign 404s. A
`memory.atomic.wait32`-on-main-thread trap (a plausible hypothesis given §2.2 introduced real
lock contention) would surface as a JS exception first. It did not. This is the renderer PROCESS
being killed: ~900 MB of wasm + JS heap + SwiftShader on a box with ~4 GB available.

### The duplication IS real (arm A) — sharing just doesn't bank it
Both instances saturate their OWN 96 MiB surface budget: **201 MB of surface cache where the
design documents 96 MiB**. A 30 s probe misses this entirely (worker 23 MB, main 0) — session
length is a hidden variable in any measurement here.

### Settle vs instance age — evidence AGAINST the accumulation theory
Same town (Holtburg) revisited as the session ages, arm C:

| visit | settle |
|---|---|
| hop 1 (cold) | 84,654 ms |
| hop 8 | 9,318 ms |
| hop 16 | 8,330 ms |

Revisits get FASTER and stay fast; novel towns kept hitting 20–28 s (several capped at the 25 s
probe cap). On this evidence settle cost tracks **cold decode volume for new content**, not
session age. That weakens the argument that A15 options (b)/(c) alone would fix settle, and
supports the original premise that decode THROUGHPUT (the real pool, §2.1c) is the settle lever.
n=1, crude time-to-quiet metric, hop-24 probe lost to the crash.

## Consequences for Path A

1. **Threads-lite is not a shortcut.** It buys coherence (one cache, one diag, closes the
   `MISSING_SURFACES` cross-instance trap, removes the alias split-back round-trip) but on the
   target rig it hits OOM ~4× sooner. Do not ship it as a memory fix.
2. **The threaded toolchain is FREE** (arm A vs C). Good news for §2.1c — the opposite of what the
   build-overhead theory predicted.
3. **The binding constraint is total footprint, not topology.** ~900 MB of wasm on a ~4 GB-available
   box. A15 options (a) bound concurrent decode + backpressure and (b) reuse decode scratch
   buffers attack that directly and remain unstarted.
4. **New blocker class, now fixed once:** Web APIs that reject SAB-backed views (see
   `transport.rs` `send_to`). Audit `fetch` bodies and `postMessage` before the pool lands.
5. **Still unwired:** `seed_url_flag_search` is called from no JS, so under shared memory the flag
   `OnceLock`s race (whichever thread reads first wins, and a worker reads `""`). The shared arm
   measured here did NOT deterministically honour Rust-side URL flags. Fix before any further
   shared-memory measurement.
6. **Still duplicated under sharing:** the worker calls `init_resource_source` unconditionally, so
   one memory holds TWO `ManifestResourceSource`s — two shard byte caches, two boot readers. The
   dedup was only ever partial.

## Limits

- All arms DEV builds. Release + `wasm-opt --enable-threads` untested; per house rules no
  quantitative verdict here is final.
- Crashes: n=2 (arm B), n=1 (arm C). Memory levels are stable across samples.
- Settle metric is time-to-quiet on decode counters, not the real `portal-settle-probe`
  chatReady/input-lag definition. Two attempts to run that rig failed for unrelated harness
  reasons (it leaves `nullRender` unset unless `--render 1` is passed, so it ran full SwiftShader
  and crashed the baseline too).

## Reproduce

Scripts in the session scratchpad: `threads-lite-probe.mjs` (shared-state discriminator),
`soak2.mjs` (hop soak + crash capture + age probe), `wasm-memcheck.py` (committed as
`scripts/wasm-memcheck.py`). Threaded build recipe: `SCOPE-2.5b`. Serve with `serve.py --coi`.
