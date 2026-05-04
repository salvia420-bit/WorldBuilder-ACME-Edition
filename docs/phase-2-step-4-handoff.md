# Phase 2 §8 Step 4 — Handoff Brief

> Use this prompt to brief the next agent (or a returning human) picking
> up Phase 2 of `emit-dynamic-site`. Step 4 is `HttpResourceSource` +
> the DAT shard format decision — the largest remaining unknown before a
> browser-loaded `holtburger-web` bundle can take a freshly-logged-in
> character into the world.
>
> Structure: **Context → Intent → Objectives → Why → Specs.**
> Read in order. Don't start coding before you've finished §Why.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to run an
Asheron's Call client in the browser, top-down view, against a live ACE
server. The end-state is a tab in a browser that talks to ACE through a
WebSocket bridge and renders the live world. Holtburger (a vendored
Rust AC client at `external/holtburger/`) is being ported to
`wasm32-unknown-unknown` to reach this end-state.

### Where the project is right now (as of `2364277`, 2026-05-04)

| Phase | What landed | Commit(s) |
|---|---|---|
| Groundwork | License, design doc, hard-fork of holtburger into `external/holtburger/`, decision log | `4987c59` |
| Phase 1 | `holtburger-wsbridge` (server-side WS↔UDP) + `holtburger-wsshim` (client-side, mirror); 21 tests green; full `cli ↔ shim ↔ bridge ↔ echo` round-trip | `d00770a`, `0945b7f` |
| Phase 2 opener | `Session::new_with_transport` seam, RC4→ISAAC doc fix, wasm32 cross-compile inventory | `f3d9a1c` |
| Phase 2 floor | All 7 library crates cross-compile to wasm32 (workspace tokio split, session UDP gating, dat zstd→ruzstd, core connect/getrandom gating); scripting reclassified "exclude from WASM" | `50003ae`..`868c3ac` |
| §8 step 1 | `wasm-pack` picked over `trunk`; `apps/holtburger-web` cdylib bundle, 5/5 Node smoke checks | `3025834` |
| §8 step 3 | `web_time::Instant` swap so `Session::new_test()` runs in the wasm bundle | `d23f5d3` |
| §8 step 2 | `crates/holtburger-transport-ws` (WsTransport over `web_sys::WebSocket`) + Transport trait cfg-split for Send+Sync; smoke test grew to 6/6 | `e151003`, `2364277` |

**Working tree:** clean. **Branch:** `master`, pushed to `origin/master`.
**Native invariant:** `cargo test --workspace --lib` is 1084 passed / 0
failed across 13 crates and is the merge-gate at every commit boundary.

### What's left in §8 (the spike doc's priority list)

| Step | Status | Owner / blocker |
|---|---|---|
| 1. Build pipeline (wasm-pack) | ✅ done (`3025834`) | — |
| 2. WsTransport | ✅ done (`e151003`) | — |
| 3. `web_time::Instant` swap | ✅ done (`d23f5d3`) | — |
| **4. HttpResourceSource + DAT shard format** | **▶ THIS BRIEF** | the wasm32 `FileExtPolyfill` stub returns `io::Unsupported`; nothing usefully reads DAT data on wasm32 yet |
| 5. Scripting "exclude from WASM" interface | open | wasm-bindgen JS interop API surface still TBD |
| 6. PixiJS / WebGL renderer wiring | Phase 3 (do not start) | needs steps 1–4 working end-to-end |

The spike doc at `docs/phase-2-wasm-spike.md` (read it!) is the
authoritative reference for what cross-compiles, what doesn't, and why
the cross-compile fixes were chosen the way they were.

---

## Intent

You are unblocking the **first byte of in-world content** in the browser.
Today, a `holtburger-web` bundle can:

1. Construct a `Session::new_with_transport(WsTransport, addr)` — verified
   by `apps/holtburger-web/smoke_test.cjs` check #6.
2. Open a WebSocket to `holtburger-wsbridge` and exchange AC packets —
   verified by Phase 1's bridge / shim e2e tests, will be verified
   browser-side once steps 4 actually have something to render.

What it cannot do today: read any DAT-resident artefact (textures,
weenies, motion data, landblock geometry, spell tables, …). Every call
chain that ends in `holtburger_dat::ResourceSource::get_file_by_key`
goes through `HbaReader` → `FileExtPolyfill::read_exact_at_compat`,
which on wasm32 unconditionally returns
`io::ErrorKind::Unsupported` (`crates/holtburger-dat/src/utils.rs:243-250`).
Once the world server hands the client an `EOR_PORTAL_NAMESPACE` lookup,
everything downstream of that fails — character creation, motion, spell
data, terrain.

Step 4 closes that gap by introducing an HTTP-backed `ResourceSource`
the browser bundle can use, plus deciding how DAT contents are sharded
on the static-hosting side so the client can fetch only what it needs.

---

## Objectives

In rough dependency order. Each objective ships its own commit; do not
batch.

1. **Decide the trait shape.** `ResourceSource` is currently *synchronous*
   (`crates/holtburger-dat/src/lib.rs:138-148`) and `: Send + Sync`. The
   browser cannot synchronously block on `fetch()` — there is no
   `wasm32` analogue of `block_on` that works on the main thread. You
   must pick one of:
     - **(a) Make `ResourceSource` async.** Right end state. Wide blast
       radius — propagates `async` through `holtburger-content`,
       `holtburger-world`, `holtburger-core` call sites (see §Specs for
       the call-site inventory).
     - **(b) Pre-load synchronously at `HttpResourceSource::connect`.**
       `await` all relevant HBA fetches up-front (Promise-chain in JS;
       `wasm-bindgen-futures` on the Rust side), serve from in-memory
       maps via the existing sync trait. Memory-heavy. Workable if
       step 4's shard format trims aggressively.
     - **(c) Hybrid.** Sync trait for hot paths, separate async loader
       called from a dedicated bootstrap step that pre-stages content
       before the world handshake completes.
   Document the decision in the spike doc with a one-paragraph rationale
   like step 1's wasm-pack pick (`3025834`'s commit body is the format).

2. **Decide the shard format.** AC's portal.dat is ~4 GB monolithic;
   player.dat ~1 GB; cell.dat varies. Three viable shapes the spike doc
   §8 step 4 names:
     - **Byte-range over a single big DAT.** One static file, the client
       issues `Range:` requests against it. CDN-friendly. Index has to
       be loaded first (the DAT internal directory).
     - **Index of pre-split files.** A manifest file maps `(namespace,
       file_id)` → `https://.../shard_NNN.bin`. Many small files; HTTP/2
       handles concurrency. CDN-friendly.
     - **HBA-of-HBAs.** The existing HBA format used by the `dat2hba`
       tool (see `apps/holtburger-tools/src/dat2hba.rs`) sliced into
       multiple HBA shards. Re-uses code paths that already work on
       native.
   Pick one. Write a one-time tool (probably a new bin in
   `apps/holtburger-tools/`) to materialize the chosen format from an
   existing portal.dat so the rest of the work has real bytes to test
   against.

3. **Implement `HttpResourceSource`.** Lives in either a new crate
   `crates/holtburger-resource-http/` (mirroring how `holtburger-transport-ws`
   isolates `web-sys` from native consumers) or as a wasm32-only module
   inside `holtburger-dat`. **Recommendation: new crate** — same reasoning
   as `holtburger-transport-ws`: keeps `web-sys` and `wasm-bindgen-futures`
   out of native graphs. Implements whichever trait shape you picked in
   objective 1.

4. **Replace the wasm32 `FileExtPolyfill` stub callers.** The stub in
   `crates/holtburger-dat/src/utils.rs:243-250` is a compile-time placeholder.
   Either route wasm32 callers through `HttpResourceSource` directly
   (bypassing `HbaReader`/`FileExtPolyfill` entirely) or make
   `HttpResourceSource` adapt into the existing `HbaReader` shape. The
   spike doc §8 step 4 calls this out as the deletion target.

5. **Wire into `apps/holtburger-web` smoke test.** Mirror what step 2
   did: add a `try_http_resource_source_smoke(base_url, namespace,
   file_id) -> Promise<u32>` (or similar — return the file's CRC,
   length, anything deterministic) export. Update `smoke_test.cjs` with
   at least a symbol-presence check and, if the harness can spin up a
   `python3 -m http.server` against a small fixture shard, an actual
   round-trip check.

6. **Native invariant + workspace check.** `cargo test --workspace
   --lib` must remain 1084+/0 at every commit boundary. `cargo check
   --target wasm32-unknown-unknown -p holtburger-{dat,content,world,core,web}`
   must remain clean.

7. **Document.** Update `docs/phase-2-wasm-spike.md` §8 step 4 with
   what landed (use the §8 step 2 update in this commit's `2364277` as
   the format template). Update the `MEMORY.md` index entry and the
   `project_emit_dynamic_site.md` body to reflect step 4 done.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why is this the right next step?** Because every other Phase 2
  thread is either done (steps 1/2/3) or out of scope (step 5 needs a
  real script-driven feature to motivate the JS interop API; step 6 is
  Phase 3). Without DAT data the bundle can hold a session open against
  ACE and not render a single tile. Step 4 is the only outstanding
  Phase 2 unblock for character-login → world-entry.

- **Why is the trait-shape decision load-bearing?** Because `fetch()` is
  asynchronous in the browser and Rust-side wasm32 has no `block_on`
  that works on the main thread. Picking sync (option b) forces the
  decision "what subset can fit in memory at startup"; picking async
  (option a) forces a refactor across 4 crates. The right call depends
  on whether Phase 2's deliverable is "load a small starter zone and
  prove the loop" (b is fine) or "feature parity with native client"
  (a is required eventually anyway). Default to (b) for the spike if
  the choice isn't obvious — it's the one that ships fastest and the
  refactor to (a) is mechanical once the rest of the loop exists.

- **Why a new crate and not extending `holtburger-dat`?** Because
  `holtburger-dat` cross-compiles cleanly today and is consumed by
  `holtburger-tools`'s native `dat2hba`. Adding `web-sys` /
  `wasm-bindgen-futures` deps to it (even gated) adds maintenance load
  to a crate that has nothing to do with browsers. The
  `holtburger-transport-ws` precedent is the right model: a dedicated
  wasm32-only crate that bolts in via a trait the consuming crate
  already exposes. (Same Send + Sync split applies — see §Specs.)

- **Why ship the materialization tool first?** Because shard-format
  decisions look right on paper and wrong on disk. AC DAT internals
  (block sizing, fragment chains, the `DatHeader` magic bytes) are
  decades-old and the only ground truth is what `holtburger-dat`
  actually parses. Materialize before you implement the fetcher; the
  fetcher needs concrete bytes to test against.

- **Why is the `Send + Sync` cfg-split likely to repeat?** Because
  `ResourceSource: Send + Sync` is structurally identical to the
  `Transport: Send + Sync` problem step 2 just resolved. wasm-bindgen
  futures are `!Send`. If you make the trait async, you'll cfg-split it
  the same way (`#[async_trait]` on native, `#[async_trait(?Send)]` on
  wasm32). If you go sync (option b), the bound is fine because the
  blocking happens at construction time before the trait object is
  exposed. Plan for the split if you pick (a).

- **Why preserve the native invariant?** Because `holtburger-cli` is
  the upstream's actual client and is in active use; the browser port
  must not regress it. The 1084-test gate has caught real bugs already
  (the workspace tokio split, the `Session::new_with_transport`
  refactor) — keep it green at every commit and the regressions stay
  small.

---

## Specs

### Read these files first (in order)

1. `docs/phase-2-wasm-spike.md` — full per-crate cross-compile matrix
   (§3), as-built fix history (§4–5), and the §8 step list with
   step-2's "as-built" entry as the template you'll mirror.
2. `docs/emit-dynamic-site.md` — the Phase 2 design doc; §3.1 (porting
   strategy) and §7.4 (build harness) are the highest-signal sections.
3. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches this brief.
4. `external/holtburger/crates/holtburger-dat/src/lib.rs:138-160` —
   the existing `ResourceSource` and `ResourceProvider` traits.
5. `external/holtburger/crates/holtburger-dat/src/utils.rs:209-251` —
   `FileExtPolyfill` and the wasm32 `io::Unsupported` stub you're
   replacing.
6. `external/holtburger/crates/holtburger-dat/src/archive.rs:430-442` —
   `impl ResourceSource for HbaReader`, the existing native impl.
7. `external/holtburger/crates/holtburger-dat/ARCHITECTURE.md` — DAT
   format, HBA layout, namespace conventions.
8. `external/holtburger/crates/holtburger-transport-ws/src/transport.rs`
   — the precedent for a wasm32-only crate that bolts into a session
   trait. Its `Cargo.toml` is the pattern for target-gated deps; its
   `lib.rs` is the pattern for the `#![cfg(target_arch = "wasm32")]`
   crate-level gate.
9. `external/holtburger/crates/holtburger-session/src/session/types.rs:23-46`
   — the cfg-split `Transport` trait. If you go async, you'll do the
   same split for `ResourceSource`.

### `ResourceSource` call-site inventory (blast radius for option a)

```
crates/holtburger-content/src/repository.rs:124      get_file_by_key
crates/holtburger-content/src/repository.rs:128      get_file_by_key
crates/holtburger-content/src/repository.rs:335      get_file_in_namespace
crates/holtburger-world/src/state/tests.rs:77        get_file_in_namespace (test only)
crates/holtburger-world/src/state/tests.rs:1066+     get_file_in_namespace (test only)
crates/holtburger-core/src/client/builder.rs:312     get_file_in_namespace
```

If you pick option (a), you propagate `.await` through `repository.rs`
and `client/builder.rs`. `holtburger-world` test calls live in `cfg(test)`
and probably stay sync (the test mocks should remain sync). The
`LayeredResourceResolver` (`crates/holtburger-dat/src/lib.rs:418-440`)
holds `Vec<Arc<dyn ResourceSource>>` and must split with the trait.

### Decisions to NOT re-litigate

These have been settled in groundwork or prior steps. Do not re-open
without explicit ask from the user:

- WASM-port over server-side per-player rendering.
- PixiJS / WebGL over Leaflet hybrid for the entity layer.
- `wasm-pack` over `trunk` for the build pipeline.
- `[port:u16 BE][bytes]` framing for the WS bridge.
- `ruzstd` for wasm32 zstd decompression (native keeps `zstd`).
- Transport trait cfg-split (`Send + Sync` on native, bound-free on
  wasm32) — applies as precedent if you cfg-split `ResourceSource`.
- AGPL-3.0 license (inherited from ACE + holtburger).

### Decisions still legitimately open after step 4

- Login UX (real ACE accounts vs. OAuth gate) — not your problem.
- Basemap renderer (Leaflet vs. MapLibre vs. PixiJS-only) — Phase 3.
- Scripting wasm-bindgen interop API surface — step 5's problem.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      must report ≥1084 passed / 0 failed.
- [ ] `cargo check --target wasm32-unknown-unknown` for at least
      `holtburger-dat`, `holtburger-content`, `holtburger-world`,
      `holtburger-core`, `holtburger-web`, and the new HTTP-source
      crate. Each must finish clean.
- [ ] `wasm-pack build --target nodejs` and `--target web` from
      `apps/holtburger-web/` — both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — all checks
      including the new HTTP-source one PASS.
- [ ] If you added a materialization tool, run it once against a real
      portal.dat and check the output is loadable by the
      `HttpResourceSource` you wrote.

### Commit conventions (match prior session)

- `feat(emit-dynamic-site): <subject>` for code that ships the feature.
- `refactor(emit-dynamic-site): <subject>` for trait/cfg-split that
  enables the feature without shipping it (e.g. an async-ResourceSource
  refactor that doesn't yet add HTTP fetching).
- `docs(emit-dynamic-site): <subject>` for the spike-doc update at the
  end.
- Commit body: section-headed paragraphs explaining **what** + **why**,
  including verification stats (test counts, smoke-check counts) and
  what the change unblocks. See `e151003` and `3025834` for examples.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 2 §8 step 4 landed**" paragraph in the same style
  as the existing "step 2 landed" entry, and bump the
  `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0` (`cargo install wasm-pack`).
- `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`).
- `node` (≥18 ok for smoke test; ≥21 if you want a `WebSocket` global
  for actual handshake testing — not needed for step 4).
- `python3` (for `python3 -m http.server` when you need to serve
  shards locally).

### What done looks like

A `holtburger-web` bundle in the browser can:

1. Open a WS to `holtburger-wsbridge` (step 2 — already works).
2. Construct a `Session` (step 3 — already works).
3. **Fetch arbitrary DAT artefacts via HTTP and decode them through
   `holtburger_dat`/`holtburger_content`** (step 4 — your job).

End-to-end-verified by either: (a) a Node smoke check that fetches a
deterministic file from a static fixture and asserts the right CRC, or
(b) a manual `python3 -m http.server` + browser console screenshot, or
both. The next session after yours will be able to start step 5
(scripting interop) or jump straight to Phase 3 (PixiJS rendering of
the data your fetcher just made available).
