# SCOPE — §2.4 cross-origin isolation gate: **PASSED** (2026-07-24)

> Branch: `perf/wasm-threads-sab`. Settles `HANDOFF-wasm-threads-SAB-2026-07-20.md` §2.4 — the
> "gate item zero" that could have blocked Path A at the infra layer regardless of Rust work.
> Everything below was **measured**, not reasoned about (headless chromium, SwiftShader).

## Verdict

Cross-origin isolation works on our serving stack. With COOP/COEP set:

```
crossOriginIsolated: true
SharedArrayBuffer:   available
new WebAssembly.Memory({initial:1, maximum:2, shared:true}):  constructs
```

That last line is the capability wasm-threads actually needs. **Path A is not infra-blocked.**

## Implementation

`scripts/serve.py` gains `--coi` (default **off**), sending
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`.
Default-off because `require-corp` changes how every cross-origin subresource loads; the daily
loop keeps today's behaviour until the threaded build needs it.

## Three handoff §2.4 claims that did NOT survive testing

1. **"Vendor the jsdelivr importmap — under COEP they will otherwise fail to load"** — **false.**
   Forced all importmap specifiers through the real module loader under `require-corp`:
   `three` (441 exports, + `three.core.js` + 5 addon modules), `postprocessing` (127 exports),
   `three/addons/postprocessing/EffectComposer.js`, and the
   `raw.githubusercontent.com/acresources/serverslist` `Servers.xml` fetch — **every request HTTP
   200**, zero `ERR_BLOCKED_BY_RESPONSE`. ES module fetches are always CORS-mode and jsdelivr
   sends `Access-Control-Allow-Origin: *`, which satisfies `require-corp`. Vendoring may still be
   worth doing for offline resilience, but it is **not a COEP blocker** and is off the critical path.

2. **"Bump `CONTENT_CACHE` v2→v3 or pre-header cached index.html replays un-isolated"** — **false,
   and the code says why.** `service-worker.js:120-137` `isCacheable()` returns true only for
   `/shards/`, `/manifest/*.bin`, and `boot.hba`; the fetch handler bails on everything else
   (`:149` `if (!isCacheable(url)) return;`). **index.html is never cached or served by the SW**,
   and the install prefetch (`:44-60`) is boot shards only. Cached shards are same-origin
   `type: "basic"` responses, which need no CORP.
   Verified same-origin (`:8792`): cache primed by a **no-header** server → server restarted
   **with `--coi`** → revisited on a persistent profile → `crossOriginIsolated: true`, SW
   controlling, `holtburger-content-v2` intact. **No v3 bump required for isolation.**
   (A first attempt using two different ports was invalid — different ports are different origins,
   so that cache was populated *after* the headers existed. Redone same-origin.)

3. **"`proxy.cjs` sets no COOP/COEP — add the headers there too"** — unnecessary.
   `proxy.cjs:85` spreads all upstream headers (`{...proxyRes.headers}`) and overrides only
   `cache-control`. Verified end-to-end through a copy on `:7081 → :8790 --coi`: both headers
   arrive intact. Running `serve.py --coi` suffices for the tunnel path.

## Unrelated pre-existing bug found

`tiny-invariant@1.3.3` throws `ReferenceError: process is not defined` on import — **identically
with COI on and off**, so it is not COEP-related. Its ESM build references `process.env.NODE_ENV`
with no shim. Worth checking separately whether anything depends on it at runtime.

## Note

`serve.py` warns the current `pkg/` wasm (4.8 MB, release-shaped) **predates the last
Rust-touching commit**. It did not affect this gate — isolation is a document property needing no
wasm — but rebuild before any measurement.

## Reproduction

Probes under the session scratchpad: `coi-gate-probe.mjs` (isolation + console/network errors),
`coi-cdn-probe.mjs` (forces importmap module loads), `coi-sw-step.mjs` (persistent-profile
single visit, for the same-origin stale-SW sequence). Serve with
`python3 scripts/serve.py --port 8790 --coi`.
