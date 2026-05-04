# Phase 2 — WASM port spike (inventory)

> **Status:** Phase 2 §8 in-scope work closed (2026-05-04). **Phase 3
> steps 1, 2, 3, 3.5, 4, 4.5, 5 (partial — roads), and 6 (live runtime
> per-model rendering) landed (2026-05-04)** — the wasm bundle fetches
> a 3×3 neighbourhood of real AC landblocks around Holtburg in one
> batch call and PixiJS draws AC terrain with real retail textures,
> stone-road network, and 239 placed object/building sprites with
> per-poly UV-mapped textures rendered in-browser at runtime.
> **Phase 4 steps 1 + 2a (wasm-driven AC login + spawn handshake)
> landed (2026-05-04)** — `apps/holtburger-web/index.html` boots a
> login form, drives `start_session` through the WS bridge to a
> live ACE, shows the Selection screen, and on Spawn click walks
> `CharacterEnterWorldRequest` → `ServerReady` → `CharacterEnterWorld`
> → `PlayerCreate` and surfaces a kind=1 PlayerSpawned event so the
> status flips to Spawned. See
> [`phase-4-renderer.md`](phase-4-renderer.md) for the Phase 4
> as-built and `docs/images/phase-4-step-2a-spawned.png` for the
> latest deliverable. Phase 3 as-built remains at
> [`phase-3-renderer.md`](phase-3-renderer.md); the step 6 deliverable
> is `docs/images/phase-3-step-6-live-render.png`.
>
> All seven library crates needed by the browser client cross-compile
> to `wasm32-unknown-unknown`: `holtburger-common`,
> `holtburger-protocol`, `holtburger-session`, `holtburger-dat`,
> `holtburger-world`, `holtburger-content`, `holtburger-core`. Native
> invariant held — the 1096 existing lib tests stay green at every
> commit (1086 + 4 from step-3 bit-decode tests + 6 from step-3.5
> Palette/SurfaceTexture/Texture parser tests).
> `holtburger-scripting` remains wasm32-incompatible (deno_core / V8)
> and is reclassified from "port" to "exclude from WASM build" —
> see §8.
>
> §8 steps 1 (build pipeline, `3025834`), 3 (`web_time::Instant`
> swap, `d23f5d3`), 2 (WsTransport, `e151003`), and 4 (HttpResourceSource,
> `ac7f92d`) are all done. **Step 6 (renderer wiring) is closed via
> Phase 3 steps 1, 2, 3, 3.5, 4, and step 5 (partial).** Step 1
> added `fetch_landblock_heightmap` for one landblock; step 2
> added `fetch_landblock_heightmaps` (batch) + multi-landblock
> scene graph + pan/zoom camera; step 3 added the per-vertex
> `terrainCodes` stream + custom Mesh shader for AC terrain
> rendering; step 5 partial added `roadCodes` + road overlay; step
> 3.5 added Palette / SurfaceTexture / Texture parsers +
> `fetch_terrain_textures` export, replacing the placeholder atlas
> with **real retail AC tiles**; step 4 added `fetch_landblock_objects`
> + sprite-atlas reuse, placing **239 object/building silhouettes**
> on top. Smoke checks grew 8 → 14 (step 1) → 17 (step 2) → 20
> (step 3) → 24 (step 5 partial) → 28 (step 3.5) → 32 (step 4).
>
> Step 5 of *§8* (scripting JS interop) remains open but doesn't
> block character-login → world-entry. Phase 3 step 4.5 picks up
> next: per-model sprite colours (real GfxObj/SetupModel material
> walks instead of category-tinted greyscale silhouettes). Per-
> cell terrain blending (AC's CornerTerrainMaps), atmospheric
> polish (fog, day/night), multi-landblock streaming, and Phase 4
> (`ClientViewEvent` → entity sprites) remain independent
> candidates.
>
> **Audience:** anyone picking up Phase 2/3 implementation. Read §8
> (what's left) first; §3 (the per-crate matrix) is the as-built
> reference. For Phase 3 specifics, jump to
> [`phase-3-renderer.md`](phase-3-renderer.md).

---

## 1. What landed in this opener

These three changes ship before the WASM-specific work begins because they're
small, contained, and useful regardless of how Phase 2 plays out.

- **`Session::new_with_transport`**
  ([`crates/holtburger-session/src/session/api.rs`](../external/holtburger/crates/holtburger-session/src/session/api.rs))
  — accepts a caller-built `Box<dyn Transport>` plus a `server_addr`, with
  initial state identical to `Session::new`. `new` and `new_test` now both
  delegate to it. **This is the seam the WASM client will use** to plug in a
  `WsTransport` when the time comes; it's also useful today for any test
  wanting to inject behaviour into the transport. Backwards-compatible — no
  existing call site changes.

- **RC4 → ISAAC doc fix**
  ([`external/holtburger/ARCHITECTURE.md:75`](../external/holtburger/ARCHITECTURE.md),
  [`external/holtburger/crates/holtburger-session/ARCHITECTURE.md:19`](../external/holtburger/crates/holtburger-session/ARCHITECTURE.md))
  — both stale references replaced with what the code actually does:
  per-direction ISAAC streams seeded from the server's `ConnectRequest`, used
  as keyed packet checksums (one ISAAC key consumed per `ENCRYPTED_CHECKSUM`
  packet — see `session/auth.rs` and `session/receive.rs`). **There is no
  RC4. There is no RSA.** The protocol's `crypto.rs` exports only `Hash32`
  and `Isaac`.

- **This document**, replacing the design doc's §5.2 speculative checklist
  with what cargo actually reports below.

## 2. The good news (less than the design doc feared)

Two crates **already cross-compile to `wasm32-unknown-unknown` clean, no
changes required**:

| Crate                 | wasm32 status | Significance |
|-----------------------|---------------|--------------|
| `holtburger-common`   | ✅ clean      | trivial — pure data types and small helpers. |
| `holtburger-protocol` | ✅ clean      | **Big deal.** This is the AC packet codec, opcode tables, ISAAC crypto, and the wire format. The substantive AC-protocol layer is WASM-portable as-is. |

That means the WASM client gets the AC protocol "for free" — the porting
work is contained to the *I/O*, *file*, and *async-runtime* edges, exactly
as the design doc predicted but with one nice surprise: the protocol crate
has no hidden dependencies that pull in WASM-incompatible transitive
crates.

## 3. The per-crate cross-compile matrix

`cargo check --target wasm32-unknown-unknown -p <crate>` from
`external/holtburger/`. **Original** column was the inventory taken at
spike open (2026-05-04, working tree before any fixes). **As-built**
reflects the state after commits `50003ae`..`868c3ac` (workspace tokio
split, session UDP gating, dat zstd→ruzstd, core connect() gating +
getrandom):

| Crate                  | Original | As-built | Notes                                                                                       |
|------------------------|----------|----------|---------------------------------------------------------------------------------------------|
| `holtburger-common`    | ✅       | ✅       | Pure data types — no work needed.                                                           |
| `holtburger-protocol`  | ✅       | ✅       | AC packet codec, opcode tables, ISAAC, wire format — WASM-portable as-is.                   |
| `holtburger-session`   | ❌       | ✅       | Step 1 (workspace tokio split) + step 2 (cfg-gate `Session::new` UDP path & `socket2`).     |
| `holtburger-dat`       | ❌       | ✅       | Step 3 (zstd → ruzstd for wasm32 decompress-only; native keeps zstd for dat2hba compress).  |
| `holtburger-world`     | ❌       | ✅       | Cascaded clean once `dat` was unblocked. No source changes.                                 |
| `holtburger-content`   | ❌       | ✅       | Cascaded clean. The async `ResourceSource` swap the design doc §5.2 calls out is still TBD — runtime use of `std::fs::File` will panic on wasm, but it compiles. |
| `holtburger-core`      | ❌       | ⚠️ (warns) | Step 4: cfg-gated `ClientRuntimeBuilder::connect` (DNS + UDP `Session::new`); split `tokio = ["net"]` to a native-only target table; added wasm32-only `getrandom = { features = ["wasm_js"] }`. Compiles with 6 dead-code warnings on wasm32 — `connect()` is the only currently-defined chain into the runtime/builder subgraph. They lift when Phase 2 lands a wasm32-specific builder entry point. |
| `holtburger-scripting` | ❌       | ❌       | Reclassified — see §8. `deno_core` is V8 (C++) and not portable; `reqwest` with `blocking` pulls tokio-net (mio). Path forward is "exclude from WASM build", not "make compile". |

## 4. The two real blockers (everything else cascades from these)

### 4.1 `tokio = ["full"]` → `mio` → wasm32-incompatible

Workspace `Cargo.toml` line 34:

```toml
tokio = { version = "1", features = ["full"] }
```

`features = ["full"]` includes `net`, which depends on `mio`, which needs
POSIX file descriptors that don't exist on `wasm32-unknown-unknown`.

The error message is canonical and points the way: *"This wasm target is
unsupported by mio. If using Tokio, disable the net feature."*

**Recommended approach:**

- Add a workspace-level `wasm-friendly-deps` (or similar) profile / feature
  that strips Tokio to `["rt", "sync", "macros", "time"]` for crates being
  WASM-targeted (session, protocol, dat, content, world, core, scripting).
- The bridge + shim binaries continue using `["full"]` because they're
  native-only and need the `net` (TCP listener, UDP socket) features. The
  workspace dep stays as-is; the WASM crates override it via feature
  selection.

Concretely the simplest mechanism is to **switch workspace `tokio` to no
default features and have each crate declare what it needs**:

```toml
# workspace
tokio = { version = "1", default-features = false }

# holtburger-wsbridge (and similar native-only crates)
tokio = { workspace = true, features = ["full"] }

# holtburger-session
tokio = { workspace = true, features = ["rt", "sync", "macros", "time"] }
# native-only feature gate for the UDP path in api.rs (to be added):
#   [target.'cfg(not(target_arch = "wasm32"))'.dependencies]
#   tokio = { workspace = true, features = ["net"] }
#   socket2 = { workspace = true }
```

Then `Session::new` (the UDP path) becomes `cfg(not(target_arch =
"wasm32"))`, while `Session::new_with_transport` (already landed) stays
unconditionally available.

### 4.2 `zstd-sys` needs C compiler for wasm32

`zstd = "0.13"` (workspace dep line 47) pulls `zstd-sys` which uses
`cc-rs` to compile the bundled C zstd source. For `wasm32-unknown-unknown`
that means `cc` invokes a C compiler with `--target=wasm32`, which only
clang knows how to do (gcc cannot). The tool isn't installed in the dev
environment so the build dies before reaching any actual Rust.

**Three viable paths:**

1. **Install clang + cross-compile zstd C source.** Cheapest path for
   continuing the spike *if* Phase 2 commits to keeping `zstd-sys`. Adds a
   non-Rust dev-environment dependency though.
2. **Replace `zstd` (zstd-sys-backed) with `ruzstd`** — pure-Rust zstd
   *decompression* (no compression). DAT/HBA files are decompress-only at
   client runtime, so this is sufficient. Cleanest end state. Requires
   patching `holtburger-dat`'s decompress path.
3. **Use `zstd` with custom features that skip `cc` build** — `zstd` has a
   `pkg-config` feature that links against system zstd instead of building
   it. Doesn't help wasm32 (no system zstd in the browser).

**Recommendation:** path (2). It's the right end state for a browser
target, and `ruzstd` is mature. Path (1) is a fine intermediate if path
(2) reveals API friction.

## 5. The path through Phase 2 the spike narrows to

Given §4, the order of operations that minimizes wasted work:

1. ~~**Land the workspace Tokio split**~~ — **Done** in `50003ae`.
2. ~~**Cfg-gate `Session::new` (UDP path) and `socket2` import**~~ —
   **Done** in `3583f2c`. Session cross-compiles cleanly.
3. ~~**Spike `holtburger-dat` on the `ruzstd` swap.**~~ — **Done** in
   `3a4259a`. Native keeps `zstd` (decompress + compress for dat2hba);
   wasm32 uses `ruzstd::decoding::StreamingDecoder` for decompress only,
   via a `decompress_zstd(buffer, expected_size)` cfg-split helper in
   `archive.rs`.
4. ~~**Cascade-recheck**~~ — **Done** in `868c3ac`. `world` and
   `content` were free riders; `core` needed `connect()` gated and a
   `getrandom = ["wasm_js"]` opt-in; `scripting` reclassified (§8).
5. **Now** start the actual WASM build pipeline: pick `wasm-pack` or `trunk`
   (design doc §7.4 leans `wasm-pack`); write the `WsTransport` impl in a
   new `holtburger-transport-ws` crate (so non-WASM consumers don't pull
   `web-sys`); write `HttpResourceSource` for DAT-over-HTTP.

Steps 1–4 are the *cross-compile floor* and have landed. Step 5 is the
priority list for whoever picks up next — see §8 for the ordered backlog.

## 6. Open questions the spike does **not** resolve

These remain exactly as the design doc framed them; the spike just narrowed
the surface.

- ~~**`getrandom` `js` feature.**~~ **Resolved** in `868c3ac`: added
  `getrandom = { version = "0.4", features = ["wasm_js"] }` under
  `holtburger-core`'s wasm32 target table. The transitive chain is
  `rand v0.10 → getrandom v0.4`; the `wasm_js` feature opts in to the
  `crypto.getRandomValues` JS shim.
- ~~**`tokio::spawn` Send/Sync audit (§5.2).**~~ **Partially resolved**
  in §8 step 2. `holtburger-session::Transport` is now cfg-split:
  native is `: Send + Sync` + `#[async_trait]`; wasm32 is bound-free +
  `#[async_trait(?Send)]`. Survey of session/core call sites confirms
  no `tokio::spawn` holding a Session across threads — the bound was
  structural, not load-bearing. Native callers keep the contract; the
  WS path no longer hits unimplementable bounds. A broader audit is
  still due if the WASM runtime grows beyond a single-task receive
  loop.
- **`wasm-pack` vs `trunk`** (§7.4 in the design doc). Decide when step 5
  starts.
- ~~**`tokio::time::Instant` / `std::time::Instant` on wasm32.**~~
  **Resolved** in `d23f5d3` (§8 step 3). Swapped
  `std::time::Instant` → `web_time::Instant` across `holtburger-session`
  (drop-in on native, `performance.now()`-backed shim on wasm32). The
  one `tokio::time::Instant::from_std(deadline)` call in
  `receive.rs:253` is cfg-split: native still uses `from_std`; wasm32
  uses duration-based `tokio::time::sleep`. End-to-end-verified by
  `Session::new_test()` running successfully inside the
  `holtburger-web` bundle (`session_smoke_test_packet_sequence()`
  returns 1 instead of panicking).

## 7. References

- Design doc: [`docs/emit-dynamic-site.md`](emit-dynamic-site.md), §3.1, §4.1, §5.2, §7.4
- Bridge / shim ARCHITECTURE: [`external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md`](../external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md)
- Transport trait: [`external/holtburger/crates/holtburger-session/src/session/types.rs:17-21`](../external/holtburger/crates/holtburger-session/src/session/types.rs)
- Session constructors (post-refactor): [`external/holtburger/crates/holtburger-session/src/session/api.rs`](../external/holtburger/crates/holtburger-session/src/session/api.rs)
- Workspace deps (post-floor) — `tokio = default-features = false` plus `ruzstd` workspace pin: [`external/holtburger/Cargo.toml`](../external/holtburger/Cargo.toml)

## 8. What's left, in priority order

The cross-compile floor (§5 steps 1–4) is laid. The next session picks
up Phase 2 implementation. Order is chosen so each step produces a
demonstrable artifact and keeps blast radius small.

1. ~~**Pick `wasm-pack` vs `trunk` and stand up a minimal
   browser-loadable crate.**~~ — **Done** in `3025834`. wasm-pack picked
   over trunk; reasoning logged in that commit. New crate at
   `apps/holtburger-web` exposes three `wasm-bindgen` functions
   (`start`, `build_info`, `hash32`) over `holtburger-protocol` +
   `holtburger-session`, builds with `wasm-pack build --target web` to
   `pkg/` (18 KB `.wasm`, 8 KB JS glue), and verifies via two paths:
   `node smoke_test.cjs` runs four deterministic assertions against
   `pkg-node/` (Node-target build); `python3 -m http.server` plus
   `index.html` serves the `pkg/` bundle with `application/wasm` MIME
   correctly set (final browser-side execution is manual). See
   `apps/holtburger-web/README.md` for the dev-loop commands.

2. ~~**Implement `WsTransport`.**~~ — **Done.** New crate
   `crates/holtburger-transport-ws/` (lib body `cfg(target_arch =
   "wasm32")`-gated, browser-only deps target-gated) implements
   `holtburger_session::Transport` over `web_sys::WebSocket`.
   `WsTransport::connect(url, server_ip)` opens the WS, awaits the
   OPEN event, and wires `onmessage` to push decoded
   `(port, payload)` pairs into a `futures::channel::mpsc::unbounded`
   queue; `send_to` encodes `[port:u16 BE][bytes]` and ships via
   `ws.send_with_u8_array`; `recv_from` `.await`s the next queue
   entry and synthesizes `SocketAddr` from the configured server_ip
   plus the per-frame port tag, so the session's
   `server_source_addr` / `pending_server_source_addr` allowlist in
   `receive.rs` accepts the packet exactly as it would a UDP
   datagram.
   - **Send + Sync friction (resolved).** The native `Transport`
     trait is `: Send + Sync` with `#[async_trait]`; wasm-bindgen
     futures are `!Send`, so the trait is now cfg-split — wasm32
     gets `pub trait Transport` with `#[async_trait(?Send)]` and a
     matching `MockTransport` impl. Native sessions retain the full
     bound (no caller spawns Session today, but keeping the contract
     avoids quietly weakening it). Session/`Box<dyn Transport>`
     storage works under both halves.
   - **Wire-up.** `apps/holtburger-web` got a wasm32-only
     `try_ws_handshake_smoke(bridge_url, server_ip, server_port) ->
     Promise<u32>` export that constructs a real WsTransport, plugs
     it into `Session::new_with_transport`, and returns the
     session's initial `packet_sequence`. The bundle's Node smoke
     test grew a 6th check verifying the symbol is present.
   - **Browser-side validation closed (2026-05-04).** Once Phase 1's
     live-ACE bring-up landed (see `docs/ace-local-setup.md`), the
     handshake smoke ran for real:
     `apps/holtburger-web/handshake_smoke.html` is a small harness
     that imports the wasm bundle and exposes `runHandshake(...)` on
     `window`. Driven via Playwright + Chromium with
     `--use-gl=swiftshader`, the call
     `try_ws_handshake_smoke('ws://127.0.0.1:8080/', '127.0.0.1', 9000)`
     returned `packet_sequence=0` (the expected initial value for a
     fresh `Session::new_with_transport`). The bridge log
     corroborated the path: `accepted; upgrading to ws` →
     `udp socket bound to Some(0.0.0.0:40559)` →
     `connection closed` (clean shutdown when the Session was
     dropped). This proves Chromium → WS → bridge → UDP → ACE is
     functional end-to-end through the wasm bundle. The session's
     AC handshake itself isn't exercised yet — that's a separate
     export not yet wired in (the smoke confirms WsTransport
     plumbing, not protocol negotiation).
   - **Reference frame.** Wire format matches
     `apps/holtburger-wsbridge/src/frame.rs`; the codec is duplicated
     into `holtburger-transport-ws/src/frame.rs` rather than depended
     on, because the bridge crate is native-only (pulls tokio with
     the `net` feature) and dragging it into wasm32 would re-introduce
     the `mio` blocker that step 1 of this spike split out.
   - **Native invariant.** All 1084 workspace lib tests still green.

3. ~~**Address the runtime-only `std::time::Instant` issue.**~~ —
   **Done** in `d23f5d3`. Reordered ahead of step 2 because the smoke
   test could exercise the fix without needing WS plumbing — making
   `Session::new_test()` callable from wasm-bindgen is enough.
   `holtburger-session` now uses `web_time::Instant` everywhere; the
   one `tokio::time::sleep_until` call site in `receive.rs` is
   cfg-split (native: `Instant::from_std(deadline)`; wasm32:
   duration-based `sleep`). The `holtburger-web` bundle now exposes
   `session_smoke_test_packet_sequence()`, which constructs a real
   `Session::new_test()` and returns 1 — proves the fix works at
   runtime, not just compile time.

4. ~~**Implement `HttpResourceSource` and decide DAT shard format.**~~
   — **Done** in `ac7f92d` (with the `HbaReader<R = File>` generic
   refactor in `b4da651` as the prerequisite). Two design decisions
   landed:
   - **Trait shape: sync pre-load (option b).** `ResourceSource` stays
     synchronous; `HttpResourceSource::connect(url)` `await`s the bytes
     once at construction time and serves them sync from in-memory
     state. The other two viable shapes — async trait (refactors ~6
     call sites in 4 crates) or hybrid — were rejected for the spike
     because sync pre-load ships fastest and the refactor to async is
     mechanical once the rest of the loop exists. `Vec<u8>`-backed
     `HbaReader` is `Send + Sync`, so `LayeredResourceResolver`'s
     `Vec<Arc<dyn ResourceSource>>` storage accepts the new source
     without any trait-level changes.
   - **Shard format: HBA-of-HBAs (single file).** The existing `dat2hba`
     tool already produces exactly the right artefact — a namespaced
     HBA with `eor/portal`, `eor/cell`, `holtburger/core` content. The
     parsing path is identical to native `HbaReader<File>` (so the
     1084-test suite covers it transitively, plus 2 new direct
     bytes-reader tests bringing the count to 1086), and a single
     fetch maps perfectly to "pre-load everything once" without
     needing any shard manifest. Byte-range over a monolithic DAT and
     manifest-of-pre-split-files were rejected because they each need
     new infrastructure (random-access-over-HTTP reader / new manifest
     format). Larger-asset shapes can revisit either in a future step
     once the spike loop closes.
   - **Wire-up.** New crate `crates/holtburger-resource-http/`
     (wasm32-only, `cfg(target_arch = "wasm32")`-gated; mirrors
     `holtburger-transport-ws`'s layout so `web-sys` and
     `wasm-bindgen-futures` stay out of native graphs).
     `HttpResourceSource::connect(url)` resolves `fetch` from
     `Window`, `WorkerGlobalScope`, or `Reflect::get(globalThis,
     "fetch")` — the third path is the Node 18+ fallback, without
     which the smoke test could only do symbol-presence checks.
   - **`HbaReader<R = File>` refactor.** `R` defaults to `File` so all
     existing native call sites compile unchanged; new
     `HbaReader::<Vec<u8>>::from_bytes(bytes)` is the wasm32 entry
     point. `FileExtPolyfill` gained `len_compat() -> io::Result<u64>`
     and an `impl FileExtPolyfill for Vec<u8>` (bounds-checked
     positional read). The header parse swapped from sequential
     `HbaHeader::read(&mut file)` to a positional read of the first
     24 bytes followed by `HbaHeader::read(&mut Cursor::new(...))`,
     matching how the namespace metadata block was already read.
   - **Drive-by §8 step 3 leftover.** `holtburger-core::client::runtime`
     still used `std::time::Instant` for the keepalive /
     connection-timeout comparisons against `Session::last_*_time`,
     which became `web_time::Instant` in `d23f5d3`. Native compiled
     because `web_time` re-exports `std::time` there; wasm32 failed
     with a type mismatch. Fixed by switching to
     `Session::last_*_time.elapsed()`, which works on both targets.
   - **Smoke test.** `apps/holtburger-web` got a wasm32-only
     `try_http_resource_source_smoke(asset_url, namespace, file_id)
     -> Promise<u32>` export (returns the decompressed byte length).
     `smoke_test.cjs` grew to 8/8 checks, the last of which serves
     `dats/assets.hba` from an in-process `http.createServer` and
     verifies the wasm bundle resolves `eor/portal:0x0E000004` to
     5876 bytes. The check degrades to SKIP (not FAIL) if the fixture
     is absent — `dats/assets.hba` is git-ignored (retail-derived
     bytes), so the smoke test stays green in environments without
     dat access. Generation: `dat2hba --profile micro
     eor/portal=client_portal.dat eor/cell=client_cell_1.dat
     dats/assets.hba`.
   - **Native invariant.** All 1086 workspace lib tests still green.

5. **Decide what to do about `holtburger-scripting`.** `deno_core`/V8 is
   C++ and won't run inside a `wasm32-unknown-unknown` bundle. The right
   move is to *exclude scripting from the WASM build entirely* — the
   browser already has a JS engine (the host page's), so scripts that
   today run in deno_core can run in the host page directly via
   `wasm-bindgen` interop. Concretely: don't include
   `holtburger-scripting` in the WASM crate's deps; expose the
   script-effects API surface (whatever `holtburger-core` calls into
   scripting for) as a `wasm-bindgen`-imported JS callback that the host
   page implements. Don't try to make `holtburger-scripting` cross-compile
   — that's a much harder problem (V8 port) for no clear gain. ~½ day
   for the decision + interface sketch; longer for actual JS-side
   handler implementation, which can be deferred until a script-driven
   feature actually needs the browser.

6. **PixiJS / WebGL rendering wiring.** Phase 3 territory; the spike
   doc tracks it here for completeness. **Phase 3 step 1 landed
   (2026-05-04)** — see [`phase-3-renderer.md`](phase-3-renderer.md)
   for as-built notes. The first slice fetches a real Holtburg
   `CellLandblock` (`eor/cell:0xA9B4FFFF`) over the §8-step-4
   `HttpResourceSource`, parses it into the 9×9 height grid, and hands
   the mesh to PixiJS as a 128-triangle textured + wireframed render
   on a `<canvas>`. The wasm bundle gained one new export,
   `fetch_landblock_heightmap(asset_url, cell_id) -> Promise<LandblockMesh>`
   (and the `LandblockMesh` struct with `positions` /
   `indices` / `heightMin` / `heightMax` getters); PixiJS 8.18.1 is
   pulled from jsdelivr via an import map — no JS bundler. Smoke test
   grew to 14 checks (geometry shape + height bounds + corner
   vertices + max-index guard). Live ACE session feed is still
   blocked on the ACE backend, so step 1 stays static-asset-only.
   Phase 3 step 2 picks up texture-atlas terrain or pan/zoom or
   entity sprites, by user priority.

Two things to *not* re-litigate (committed in groundwork — see project
memory):

- **WASM-port vs server-side per-player.** WASM-port is committed.
- **PixiJS / WebGL vs Leaflet hybrid.** PixiJS is committed.

If your work surfaces evidence that bears on either, flag it in this doc
but don't decide unilaterally. The other open architectural questions
(login UX, basemap renderer specifics, `wasm-pack` vs `trunk`, DAT shard
format) are genuinely open and step 1 / step 4 are where they should be
decided.
