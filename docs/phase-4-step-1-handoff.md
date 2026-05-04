# Phase 4 Step 1 — Handoff Brief

> Use this prompt to brief the next agent picking up
> `emit-dynamic-site` work. Step 1 of Phase 4 is **drive the AC login
> handshake from the WASM bundle through the WS bridge to a live
> ACE, and surface the resulting `CharacterList` to JS so the browser
> can display the Selection screen**. This is the smallest possible
> end-to-end "the browser is talking to ACE for real" deliverable —
> the same milestone Phase 1 hit on the native side
> (`holtburger-cli` reached its Selection page) but now via the
> in-browser wasm bundle.
>
> Structure: **Context → Intent → Objectives → Why → Specs.** Read
> in order. Don't start coding before you've finished §Why. The
> "Decisions to NOT re-litigate" section in §Specs lists commitments
> that were made in earlier phases — do not reopen them without
> explicit ask.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to
run an Asheron's Call client in the browser, top-down view, against
a live ACE server. As of 2026-05-04 commit `bce626a` the renderer:

- Fetches a 3×3 landblock neighbourhood around Holtburg in one
  batch HTTP fetch (~605 MB `assets.hba`).
- Decodes and renders **real retail terrain textures** per cell
  (grass, water, stone road) sampled per-cell from a 1536×1536 GPU
  atlas via a custom GLSL ES 3.00 PixiJS Mesh shader.
- Overlays the **stone-road network** wherever `road_type ≥ 1` in
  the cell's SW corner.
- Renders **239 object/building sprites in-browser at runtime** via
  `fetch_model_meshes` + `fetch_surfaces_pixels` + a per-poly
  UV-mapped textured fragment shader (Phase 3 step 6) — the same
  pipeline as the static-site emitter's
  `WorldBuilder.Terminal/ObjectSpriteGenerator.cs::DrawTriangle` but
  at runtime, so user-imported custom models render without a
  re-bake step. **80 of 81 unique Holtburg models live-render**;
  the 1 outlier is an engine-internal light-source anchor (correctly
  invisible — confirmed via weenie index, atlas absence, and
  geometry inspection).
- Mouse-wheel zooms around the cursor; click-and-drag pans.

The current renderer is Phase 3's deliverable. Phase 4's deliverable
is the **playable** part — connecting the wasm bundle's existing
`Session::new_with_transport` + `WsTransport` wiring (landed in Phase
2 §8 step 2, validated in browser via `try_ws_handshake_smoke`) to
ACE's actual login → CharacterList → spawn flow, and surfacing the
results to the JS side.

### Where the project is right now (as of `bce626a`, 2026-05-04)

| Phase | What landed | Commit(s) |
|---|---|---|
| Groundwork | License, design doc, hard-fork of holtburger, decision log | `4987c59` |
| Phase 1 | `holtburger-wsbridge` (WS↔UDP) + `holtburger-wsshim`; full `cli ↔ shim ↔ bridge ↔ echo` round-trip | `d00770a`, `0945b7f` |
| Phase 1 follow-on | Live-ACE round-trip closed; cli reaches Selection page through bridge against real ACE | `b082cc9` |
| Phase 2 opener | `Session::new_with_transport` seam, RC4→ISAAC doc fix, wasm32 inventory | `f3d9a1c` |
| Phase 2 floor | All 7 library crates cross-compile to wasm32 | `50003ae`..`868c3ac` |
| §8 step 1 | `wasm-pack` + `apps/holtburger-web` cdylib | `3025834` |
| §8 step 2 | `holtburger-transport-ws` (WsTransport over `web_sys::WebSocket`) | `e151003`..`e00175b` |
| §8 step 3 | `web_time::Instant` swap | `d23f5d3` |
| §8 step 4 | `HbaReader<R = File>` + `holtburger-resource-http` | `b4da651`..`5b6fefd` |
| Phase 3 step 1 | `fetch_landblock_heightmap` + PixiJS Mesh render of one landblock | `a5e0a91`..`590fc95` |
| Phase 3 step 2 | 3×3 neighbourhood + pan/zoom + 192 m unit-fix | `38afb1c`..`79818ac` |
| Phase 3 step 3 | Per-vertex `terrainCodes` + custom Mesh shader + 32-colour placeholder atlas | `06597eb`..`471d02a` |
| Phase 3 step 5 partial | Per-vertex `roadCodes` + road overlay layer | `0a2e0a3`..`166bc2c` |
| Phase 3 step 3.5 | Palette / SurfaceTexture / Texture parsers + `fetch_terrain_textures` + real retail tiles | `0e47306`..`6fbc15f` |
| Phase 3 step 4 | `fetch_landblock_objects` + sprite-atlas reuse + 239 placements | `5eb5736`..`19c4727` |
| Phase 3 step 4.5 | Surface (0x08) parser + textured-mean walk + JS tint | `6d1b9e8`..`bcf4d2f` |
| Phase 3 step 4.5 fix | Surface→SurfaceTexture chain + DXT decoder | `17143e2`..`9afb1d7` |
| Phase 3 step 4.5c | Production atlas swap | `197369a` |
| Phase 3 step 6 | GfxObj polygon parser fix + `fetch_model_meshes` + `fetch_surfaces_pixels` + in-browser rasterizer | `8c41045`..`bce626a` |
| **Phase 4 step 1 — WASM-driven AC login** | **▶ this brief** | — |

**Working tree:** clean. **Branch:** `master`, pushed to
`origin/master`. **Native invariant:** `cargo test --workspace
--lib` is **1106 passed / 0 failed** across 13 crates and is the
merge-gate at every commit boundary. **Smoke test:**
`apps/holtburger-web/smoke_test.cjs` is at **41/41 PASS**.

### What's already in place

- **WS transport.** `WsTransport: Transport` in
  `crates/holtburger-transport-ws` (wasm32-only). Validated end-to-end
  in the browser via `try_ws_handshake_smoke` — Chromium → WS → bridge
  → UDP → ACE round-trips cleanly, returns `packet_sequence=0`. The
  Session is constructed with the transport plugged in; protocol
  negotiation is what's missing.
- **Session constructor.** `Session::new_with_transport(transport,
  server_addr)` lives in
  `crates/holtburger-session/src/session/api.rs`. Same shape as
  `Session::new()` (the native UDP path) — the cli already uses this
  surface against the bridge and reaches Selection.
- **Bridge.** `holtburger-wsbridge` listens on `ws://127.0.0.1:8080/`
  by default; for each WS connection it opens an ephemeral UDP socket
  to ACE's login + world ports. One WS binary frame == one AC packet
  in either direction. WS frame protocol:
  `[port:u16 BE][ac_packet_bytes]`.
- **Native cli reference.** `holtburger-cli` performs the exact
  login → CharacterList → spawn flow we need to drive from wasm. Its
  main loop in `external/holtburger/apps/holtburger-cli/src/main.rs`
  + `src/tui.rs` is the canonical reference for which Session methods
  to call in which order.
- **ACE setup recipe.** `docs/ace-local-setup.md` brings up a local
  ACE instance: MariaDB 11.8 + three DBs (auth/shard/world) with the
  upstream base SQL loaded explicitly + .NET 10.0.203 SDK + the
  `~/ace-server/` clone. Headless launch via
  `ACE_NONINTERACTIVE_CONSOLE=true ... < /dev/null`. Without these
  the live round-trip can't run; with them it does.

### What's NOT in place yet — and what step 1 fixes

- **No wasm-side login driver.** `try_ws_handshake_smoke` constructs
  a Session and immediately drops it. There's no export that does the
  actual `Session.connect()` / `Session.login(username, password)`
  flow holtburger-cli executes. Step 1 ships that export.
- **No event drain to JS.** The Session's
  `ClientViewEvent` / `LoginEvent` / `CharacterListReceived` stream
  is internal to the wasm bundle. JS has no way to observe it. Step 1
  ships an export that drains queued events to JS as typed
  structures.
- **No login UI.** `index.html` boots straight into the renderer.
  Step 1 adds a minimal username/password form that gates the render
  on a successful login (or, on failure, surfaces the AC error).
- **No Selection-screen rendering.** Once `CharacterList` arrives, JS
  needs to display the available characters. Step 1 ships a minimal
  list (character name + level + class), not the full retail
  Selection UI.

### What's left in Phase 3 + Phase 4 (current priority list)

| Step | Status | Owner / blocker |
|---|---|---|
| §8.5 scripting "exclude from WASM" | open, **deferred** | no script-driven feature has surfaced a need |
| Phase 3 steps 1-6 | ✅ done | — |
| Phase 3 atmospherics (rest of step 5) | open, deferred | independent polish, not gating Phase 4 |
| Phase 3 per-cell terrain blending (CornerTerrainMaps) | open, deferred | multi-pass renderer, ~150 lines GLSL |
| Phase 3 multi-landblock streaming | open, deferred | needs landblock cache + camera-driven prefetch |
| Phase 3 renderer-profile bake | open, deferred | extend `is_essential()` to land 605 MB → ~280 MB |
| Phase 3 coordSystem boot assertion | open, deferred | tie Phase 3 to Phase 4's gameplay coords |
| **Phase 4 step 1 — wasm-driven AC login** | **▶ this brief** | — |
| Phase 4 step 2 — ClientViewEvent → PIXI entities | open | gated on step 1 (need a live world stream) |
| Phase 4 step 3 — input (WASD/click) → AC movement packets | open | gated on step 2 |
| Phase 4 step 4 — DOM panels (chat, vitals, inventory) | open | parallel to step 2/3 |

Phase 4 step 1 is the **gating step** for everything in Phase 4. The
renderer is mature enough; what's missing is the live data loop.

The design doc's authoritative reference is at
[`docs/emit-dynamic-site.md`](emit-dynamic-site.md); the as-built
renderer record at [`docs/phase-3-renderer.md`](phase-3-renderer.md).
The phase-2 wasm-spike at [`docs/phase-2-wasm-spike.md`](phase-2-wasm-spike.md)
is where the trait surfaces for Transport + ResourceSource were
established.

---

## Intent

You are turning the wasm bundle from "a renderer that can fetch and
draw assets" into "an AC client that logs in to a live ACE and
surfaces its game state to the browser." This is the inflection
point — after step 1 the bundle is no longer just a static viewer;
it's a real network-connected client.

What "done" looks like at the end of this step:

1. Open `index.html` in a browser. A minimal login form appears
   (username + password fields, "Connect" button, status line).
2. Enter the credentials of a test ACE account. Click Connect.
3. The form replaces itself with a "Selecting character…" status,
   then a list of the account's characters: each row shows
   `{name} — level {N} {class}`.
4. Picking a character (or, for step 1, just clicking a "spawn
   placeholder" button) spawns the character and starts the
   ClientView event stream — but step 1's deliverable ENDS at the
   character list. Spawn behaviour is step 2.
5. Smoke test grows from 41 → 44 checks:
   - Symbol-presence for `start_session` + `poll_events` + the new
     event-type accessors.
   - The bundle's `start_session` resolves to a connected Session
     against a smoke harness simulating a CharacterList response —
     no live ACE needed for the smoke. Live-ACE coverage is manual
     via `docs/ace-local-setup.md` per the existing pattern.
6. The full loop runs against `holtburger-wsbridge` + a real ACE
   (validated manually), end-to-end:
   `Chromium → WsTransport → wsbridge → UDP → ACE` →
   `LoginRequest → ConnectRequestData → DddInterrogation/Response →
   CharacterList(N entries)` → JS displays N characters. Same
   sequence the cli already validates.
7. New screenshot at `docs/images/phase-4-step-1-character-list.png`
   replaces the step 6 deliverable as the title image of
   `phase-3-renderer.md` (or starts a new `phase-4.md`, your call).

What this step deliberately does NOT do:

- **No spawn / world enter.** Selecting a character returns a
  placeholder stub; the actual `EnterWorldRequest` packet flow is
  step 2 scope.
- **No movement input.** WASD / click-to-move are step 3.
- **No DOM panels.** Chat, vitals, inventory render is step 4.
- **No retail-faithful Selection UI.** The character list is a
  basic `<ul>` for step 1. Replicating the in-game selection UI
  (portraits, character preview, slot ordering) is later polish.
- **No password security pass.** For the spike, we send credentials
  over the WS (the bridge is local); production-ready login flow
  (TLS, password hashing, OAuth gate) is §7.5 in the design doc and
  out of scope here.
- **No re-litigation of Phase 0-3 decisions** (PixiJS, parsing in
  Rust, WS bridge, sprite atlas reuse, runtime per-model rendering,
  etc.). Same scaffolding, extended.
- **No multi-character / multi-account state.** One session at a
  time; reload the page to switch accounts.

This is the smallest possible Phase 4 step 1 vertical slice:
**proves the Session's real protocol negotiation works through the
wasm bundle, the event-drain boundary stays one-call-per-frame from
JS, and the browser shows actual ACE-sourced game state**. The
existing renderer stays as the visual backdrop; once a character
spawns (step 2), the renderer's world-coords already match the AC
coordinate system (`METERS_PER_LANDBLOCK = 192.0` on both sides).

---

## Objectives

In rough dependency order. Each objective ships its own commit; do
not batch.

1. **Audit `holtburger-cli`'s login flow.** Read `apps/holtburger-cli/src/main.rs`
   + `src/tui.rs` end-to-end. Note: which Session methods are called
   in which order; how the cli waits for `LoginEvent::CharacterList`
   vs polling; how errors propagate. Write the findings as a comment
   block at the top of the new wasm-side login driver — this is the
   contract step 1 honours.

   **Verification:** the comment captures the call sequence and any
   `tokio::time::sleep` / `select!` shapes the cli uses, so the wasm
   port can match.

2. **Add `start_session` wasm-bindgen export.** Single async function
   in `apps/holtburger-web/src/lib.rs`:

   ```rust
   #[wasm_bindgen]
   pub async fn start_session(
       bridge_url: String,
       server_ip: String,
       server_port: u16,
       username: String,
       password: String,
   ) -> Result<SessionHandle, JsValue> { ... }
   ```

   Steps internally:
   1. `WsTransport::connect(bridge_url, server_ip)` — await OPEN.
   2. `Session::new_with_transport(transport, SocketAddr::new(server_ip,
      server_port))`.
   3. Drive the login handshake — call whichever Session method the
      cli uses (`session.connect(username, password).await`?
      `session.login(...)`? Audit will tell you).
   4. Wait for `LoginEvent::CharacterListReceived`.
   5. Return a `SessionHandle` proxy that JS holds onto; the
      handle keeps the Session alive on the Rust side.

   On any error path, return a `JsValue` carrying the AC error
   string. (`JsValue::from_str` is fine; structured errors are
   step 1 follow-on.)

   **Verification:** `cargo check --target wasm32-unknown-unknown -p
   holtburger-web` clean. `wasm-pack build` both targets green.

3. **Add `SessionHandle` proxy + `poll_events()`.** The handle's job:
   own the `Session` and expose a JS-callable event drain.

   ```rust
   #[wasm_bindgen]
   pub struct SessionHandle { /* Box<Session> + a queued-events buffer */ }

   #[wasm_bindgen]
   impl SessionHandle {
       /// Drain queued `ClientEvent`s. JS calls per animation frame
       /// (or per setTimeout tick) and renders accordingly.
       pub fn poll_events(&mut self) -> Vec<ClientEvent> { ... }

       /// Returns the connected character list. Returns an empty Vec
       /// before login completes; non-empty after.
       pub fn character_list(&self) -> Vec<CharacterSummary> { ... }
   }
   ```

   `ClientEvent` is a wasm-bindgen-friendly enum (use a tag-byte +
   payload struct because wasm-bindgen doesn't directly support Rust
   enums with data). One event per LoginEvent / ClientViewEvent the
   Session emits. For step 1 only `CharacterListReceived` matters;
   leave a TODO for future event types.

   `CharacterSummary { id: u64, name: String, level: u32, class:
   String }` — the four fields the JS Selection UI displays.

   **Verification:** `wasm-pack build` clean; the bundle exports
   `SessionHandle.poll_events()` and `SessionHandle.character_list()`
   per `pkg-node/holtburger_web.d.ts`.

4. **JS-side login form + Selection display.** In `index.html`:
   - Replace the renderer-first boot with a `<form>` gating the
     render. Username, password, "Connect" button, status line.
   - On submit: call `start_session(...)`. While the Promise is
     pending, show "Connecting…" / "Logging in…" status updates.
   - On resolve: read `handle.character_list()`. Render a
     `<ul>` of characters; each entry has a "Spawn (placeholder)"
     button that, in step 1, just logs to console — step 2 will
     wire the actual spawn.
   - On reject: show the error string in the status line; don't
     enter the renderer.

5. **Smoke test additions (41 → 44).** Three new checks:
   - **Symbol presence** for `start_session` + `SessionHandle` +
     `SessionHandle.poll_events`.
   - **Round-trip against a Node-side mock bridge.** Spin up a
     minimal `ws` server in Node that simulates the AC login →
     CharacterList exchange (returns 1 hardcoded character).
     `start_session` against that; expect `character_list().length
     === 1`. Skip if `ws` isn't installed (Node has no built-in WS
     server).
   - **Error path coverage.** Connect against a port that's not
     listening; expect `start_session` to reject with an AC error
     string, not panic.

6. **Native invariant + workspace check.** `cargo test --workspace
   --lib` must remain ≥1106 / 0. `cargo check --target
   wasm32-unknown-unknown` clean for `holtburger-{dat,web,session,
   transport-ws,resource-http}`. `wasm-pack build --target
   {nodejs,web}` both green.

7. **Live-ACE manual validation.** With `~/ace-server/` running per
   `ace-local-setup.md` and `holtburger-wsbridge` on `:8080`:
   - Open `index.html` in Chromium (`--use-gl=swiftshader` for
     headless — though Selection display doesn't need WebGL).
   - Enter ACE test account credentials.
   - Click Connect.
   - Verify the Selection screen shows the characters that exist on
     that ACE account.
   - Capture screenshot at
     `docs/images/phase-4-step-1-character-list.png`.

8. **Document.** Update `docs/phase-3-renderer.md` with a "Phase 4
   step 1 landed" note (or start a new
   `docs/phase-4-renderer.md` — your judgment on which carries the
   weight). Update `docs/phase-2-wasm-spike.md`'s status banner to
   mention Phase 4 step 1. Update
   `docs/emit-dynamic-site.md` §8 Phase 4's step ledger from
   "✅ done — step 1 wasm-driven login" through to step 4. Bump the
   auto-memory entry at
   `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   with a "Phase 4 step 1 landed" paragraph.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why audit the cli first (objective 1)?** Because the cli is the
  reference implementation. It already drives the same login flow
  successfully; whatever shape its main loop has is the contract the
  wasm side must honour. Skipping the audit leads to guessing at
  Session method names + ordering, which produces silent bugs
  (e.g. forgetting to call `session.tick()` per the cli's main loop
  → packets queue forever).

- **Why a single `start_session` export instead of step-by-step
  exposed primitives?** Because the AC login handshake is a
  **stateful sequence**: open transport → connect → login → wait for
  CharacterList. If we expose each step as its own export, JS has
  to drive the sequence in JS, multiplying the wasm-boundary cost
  and putting protocol-state machinery in JS where it doesn't
  belong. One async function with one Promise is the cleanest API.
  Same shape as `try_ws_handshake_smoke` (which proved the boundary
  works) but with the actual login completed.

- **Why `poll_events` instead of a callback / EventTarget?** Because
  wasm-bindgen's callback story has historical pitfalls (closures,
  forget(), leaks). A pull-style drain is more JS-idiomatic for a
  per-frame loop (`requestAnimationFrame(() => handle.poll_events())`),
  matches PIXI's existing render-loop pattern, and avoids leaked
  closures. The cli's main loop ALSO polls (via tokio's `select!`);
  we mirror that.

- **Why `CharacterSummary` and not the full `Character` struct?**
  Because step 1 only needs to display the list. The full
  `Character` carries inventory snapshots, equipment, etc. — fields
  the spawn step (step 2) reads. Returning a smaller struct keeps
  the wasm-boundary cost flat and the JS side honest about what
  data step 1 owns.

- **Why a login UI in step 1?** Because the bundle has to collect
  credentials *somehow*. The alternatives — embedding test credentials
  in the bundle, hardcoding an account in `index.html` — leak into
  builds and demos. A real form is the simplest contract; if §7.5
  later replaces it with OAuth that's a contained refactor.

- **Why Selection display, not "click character → spawn"?** Because
  spawn is a bigger flow (EnterWorldRequest → ServerSpawn → first
  ClientViewEvent) and step 2's scope. Step 1 ends at "we have data
  from the server" — a hard boundary. Going one step further pulls
  in the entity-buffer wiring and the input loop, which expand the
  scope past one PR.

- **Why mock-bridge smoke instead of live-ACE smoke?** Because the
  smoke test runs without ACE (the canonical fixture is just
  `dats/assets.hba`, no MySQL). Live-ACE is the manual-verification
  step. Same contract as the existing 41 smoke checks: the smoke
  doesn't need a live game server; the manual screenshot does.

- **Why preserve the native invariant?** Same as before — the
  1106-test gate has caught real bugs at every prior step. Keep
  it green at every commit boundary. Step 1 will likely add 0
  native tests (the new code is wasm-only) or 1-2 if you decide to
  exercise the new ClientEvent enum's serialization shape.

- **Why is now the right time to start Phase 4?** Because Phase 3 is
  closed enough — the renderer renders a 3×3 Holtburg neighbourhood
  with terrain, roads, objects, and live-rendered per-poly textures.
  Continuing to polish render quality (atmospherics, terrain blending,
  streaming) returns diminishing visual gains. The bigger missing
  thing is the gameplay loop. Phase 4 step 1 is the smallest
  contained step in that direction.

---

## Specs

### Read these files first (in order)

1. [`docs/emit-dynamic-site.md`](emit-dynamic-site.md) — the
   long-lived design intent for the whole project. §3.1 + §6 + §7.5
   + §8 Phase 4 are the load-bearing parts for this step.
2. [`docs/phase-3-renderer.md`](phase-3-renderer.md) — the as-built
   reference for the renderer state Phase 4 builds on top of.
   Step 6's "live runtime per-model rendering" section in particular
   shows the most-recent wasm export pattern; mirror it.
3. [`docs/phase-2-wasm-spike.md`](phase-2-wasm-spike.md) — the
   per-crate cross-compile matrix and the WsTransport / Session
   wiring that already exists.
4. [`docs/ace-local-setup.md`](ace-local-setup.md) — bring up a
   local ACE for manual validation.
5. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches this
   brief's status block.
6. [`external/holtburger/apps/holtburger-cli/src/main.rs`](../external/holtburger/apps/holtburger-cli/src/main.rs)
   + [`src/tui.rs`](../external/holtburger/apps/holtburger-cli/src/tui.rs)
   — the canonical reference for the login → CharacterList flow.
   The wasm side mirrors whichever Session methods the cli's main
   loop calls.
7. [`external/holtburger/crates/holtburger-session/src/session/api.rs`](../external/holtburger/crates/holtburger-session/src/session/api.rs)
   — `Session::new_with_transport` is here. Read the surrounding
   `Session` impl to find the login / character-list methods to
   call. Likely candidates: `Session::login`, `Session::poll_event`,
   `Session::events()` — confirm by reading the source, not by
   guessing.
8. [`external/holtburger/apps/holtburger-web/src/lib.rs`](../external/holtburger/apps/holtburger-web/src/lib.rs)
   — `try_ws_handshake_smoke` and `fetch_model_meshes` are the
   templates for the new export. Same async-fn shape, same
   `JsValue` error semantics, same wasm-bindgen `pub struct` +
   `#[wasm_bindgen]` impl pattern.
9. [`external/holtburger/apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
   — the JS render trigger lives at the bottom. Wrap it in the new
   login flow; renderer doesn't run until login resolves.
10. [`external/holtburger/apps/holtburger-web/smoke_test.cjs`](../external/holtburger/apps/holtburger-web/smoke_test.cjs)
    — the 41-check baseline. Objective 5 adds 3 more.
11. **Reference for AC's login packets:** the cli source is
    authoritative. If you need the wire format,
    [`external/holtburger/crates/holtburger-protocol/src/`](../external/holtburger/crates/holtburger-protocol/src/)
    has the packet structs (`LoginRequest`, `ConnectRequestData`,
    `CharacterList`, etc.) — but the cli already orchestrates them
    correctly, so you shouldn't need to drop this low.

### Sketch — `start_session` shape

```rust
// apps/holtburger-web/src/lib.rs

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct SessionHandle {
    session: holtburger_session::Session,
    queued_events: Vec<ClientEvent>,
    character_list: Vec<CharacterSummary>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn start_session(
    bridge_url: String,
    server_ip: String,
    server_port: u16,
    username: String,
    password: String,
) -> Result<SessionHandle, JsValue> {
    use std::net::{IpAddr, SocketAddr};
    let ip: IpAddr = server_ip
        .parse()
        .map_err(|e| JsValue::from_str(&format!("server_ip: {e}")))?;
    let transport = holtburger_transport_ws::WsTransport::connect(&bridge_url, ip)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut session = holtburger_session::Session::new_with_transport(
        Box::new(transport),
        SocketAddr::new(ip, server_port),
    );

    // Audit the cli to find the right method name + signature.
    // Likely: session.login(username, password).await?
    session
        .login(username, password)
        .await
        .map_err(|e| JsValue::from_str(&format!("login: {e}")))?;

    // Pump session until CharacterList arrives.
    // Audit cli for the right shape — likely a select! over
    // session.poll_event() / sleep, or session.next_event().await.
    let mut handle = SessionHandle {
        session,
        queued_events: Vec::new(),
        character_list: Vec::new(),
    };
    loop {
        let evt = handle.session.next_event().await
            .map_err(|e| JsValue::from_str(&format!("next_event: {e}")))?;
        match &evt {
            holtburger_session::SessionEvent::CharacterList(chars) => {
                handle.character_list = chars.iter().map(|c| CharacterSummary {
                    id: c.id,
                    name: c.name.clone(),
                    level: c.level,
                    class: format!("{:?}", c.class),
                }).collect();
                handle.queued_events.push(ClientEvent::character_list_received());
                break;
            }
            _ => {
                // Forward other events to the JS-drained queue.
                handle.queued_events.push(ClientEvent::from_session_event(&evt));
            }
        }
    }

    Ok(handle)
}
```

The exact method names and event-type names depend on what the cli
uses — DO NOT trust the names above. Audit first.

### `ClientEvent` enum shape

wasm-bindgen doesn't directly serialize Rust enums with data, so use
a tag struct:

```rust
#[wasm_bindgen]
pub struct ClientEvent {
    kind: u32,
    // Per-kind payload; populated lazily on the JS side via getters.
    string_payload: Option<String>,
    u32_payload: Option<u32>,
}

#[wasm_bindgen]
impl ClientEvent {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> u32 { self.kind }
    #[wasm_bindgen(getter, js_name = stringPayload)]
    pub fn string_payload(&self) -> Option<String> { self.string_payload.clone() }
    #[wasm_bindgen(getter, js_name = u32Payload)]
    pub fn u32_payload(&self) -> Option<u32> { self.u32_payload }
}
```

`kind` constants on the JS side:
- `0` = CharacterListReceived
- `1` = CharacterListUpdated (future)
- `2` = ChatReceived (future)
- `3` = ClientViewEvent (future)

For step 1 only kind 0 fires. Document the others as TODO with a
matching comment in the Rust enum.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      ≥1106 passed / 0 failed.
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,session,transport-ws,resource-http,web}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — 44/44 PASS
      after objective 5 lands.
- [ ] **Live-ACE manual validation.** With ACE running locally:
      - Open `index.html` in Chromium / Firefox.
      - Enter test ACE credentials.
      - Verify the Selection screen lists the account's characters.
      - Save screenshot at
        `docs/images/phase-4-step-1-character-list.png`.

### Decisions to NOT re-litigate

These have been settled in prior phases. Do not re-open without
explicit ask from the user:

- **WASM-port over server-side per-player rendering.**
- **External WS proxy over ACE patch.**
- **PixiJS-only renderer (no Leaflet).**
- **`wasm-pack` over `trunk` for the build pipeline.**
- **WS frame protocol `[port:u16 BE][ac_packet]`.**
- **Sync `ResourceSource` (not async-trait).**
- **`Transport` trait cfg-split: `Send + Sync` on native, `?Send`
  on wasm32.**
- **Direct-DAT terrain rendering, not Leaflet basemap reuse.**
- **Real retail textures via Texture (0x06) parser.**
- **Sprite atlas reuse via static-site `atlas.{png,js}`.**
- **Live runtime per-model rendering as the canonical sprite path
  (step 6).**
- **AGPL-3.0 license.**
- **Real `~/ac_base_dats/` dats over synthetic fixtures.**
- **`dat2hba --profile full` as the renderer baseline.**
- **CDN PixiJS via importmap, no JS bundler.**

### Decisions still legitimately open after Phase 4 step 1

- **§7.5 login UX.** The form in step 1 is utilitarian. Production
  needs OAuth, password hashing, session persistence — design doc
  §7.5.
- **§7.6 server count.** One bridge per ACE world or multi-world
  picker — defer to operator concerns.
- **Multi-character flow.** Step 1 lets the user PICK a character
  but step 1 doesn't act on the pick (step 2's scope).
- **Idle-pose animation in renderer.** Step-6 follow-on.
- **0x07/0x15/0x17/0x18 RenderSurface wrapper walks.** For EOR
  custom content; step-6 follow-on.
- **Atmospherics / streaming / renderer-profile bake.** Phase 3
  deferred items, independent of Phase 4.

### Commit conventions (match prior session)

- `feat(emit-dynamic-site): <subject>` for the login driver +
  SessionHandle commits.
- `test(emit-dynamic-site): <subject>` for the smoke-test
  additions in objective 5.
- `docs(emit-dynamic-site): <subject>` for renderer-doc / spike-
  doc updates and the new screenshot.
- Commit body: section-headed paragraphs explaining **what** +
  **why**, with verification stats (test counts, smoke-check
  counts). See `bce626a`, `0ab948d`, `0449d38` for format examples
  from step 6.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 4 step 1 landed**" paragraph in the same style
  as the existing step-6 entry, and bump the `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18.
- `python3` for serving the bundle locally.
- `npm install ws` (one-time) for the smoke-test mock bridge — or
  fall back to skip-on-missing same as the live-bridge gate.
- Real browser (Chrome / Firefox) for manual validation, or
  `npx playwright install chromium` for scripted screenshots.
- `~/ace-server/` — full upstream ACE clone, brought up per
  `docs/ace-local-setup.md`.
- MariaDB 11.8 + the three ACE DBs provisioned per
  `docs/ace-local-setup.md`.

### What done looks like

- `index.html` opened in a browser shows a username/password form.
  Submit → "Connecting…" → Selection screen lists the account's
  characters.
- 44/44 smoke checks green.
- All ≥1106 workspace lib tests still pass.
- A new screenshot at
  `docs/images/phase-4-step-1-character-list.png` is committed; the
  renderer doc references it; the design doc §8 Phase 4 step 1
  ledger flips to ✅ done.
- The next session can either (a) tackle Phase 4 step 2
  (`ClientViewEvent` → PIXI entity buffer — actual gameplay
  rendering), (b) ship Phase 4 step 4 (DOM panels for chat /
  vitals / inventory) in parallel, (c) close the Phase 3
  follow-ons (atmospherics, terrain blending, streaming,
  renderer-profile bake, coordSystem assertion) before
  continuing Phase 4. Step 1 closes one specific gap without
  blocking any of these.
