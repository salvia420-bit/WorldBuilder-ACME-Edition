# emit-dynamic-site — Design

> **Status (2026-05-04):** Phases 0, 1, and 2 are DONE. **Phase 3
> closed enough to start Phase 4** — every renderer step the design
> doc anticipated has shipped, plus several quality follow-ons that
> emerged in flight. The wasm bundle now fetches a 3×3 Holtburg
> neighbourhood, draws real retail terrain + roads + 239 placed
> objects, and **renders each unique model in-browser at runtime via
> per-poly UV-mapped textures** (Phase 3 step 6 — same pipeline as
> the static-site emitter's `ObjectSpriteGenerator.cs::DrawTriangle`
> but live, so user-imported custom models render with no re-bake
> step). **Phase 4 steps 1 + 2a + 2a.5 landed (2026-05-04)** — the
> wasm bundle now drives the full AC login → CharacterList →
> CharacterCreate → spawn handshake from the browser through
> `holtburger-wsbridge` to a live ACE end-to-end. Open
> `apps/holtburger-web/index.html`, log in (the bundle eagerly
> fetches `CharGen` (`0x0E000002`) + `SkillTable` (`0x0E000004`)
> and builds a CharacterGenCatalog for offline validation), use
> the in-browser Create-test-character form on a fresh account
> (Aluvian / Male / Adventurer / Holtburg defaults built in the
> wasm bundle via `holtburger_core::CharacterGenBuilder`), then
> click Spawn — the recv loop walks
> `CharacterEnterWorldRequest` → `CharacterEnterWorldServerReady`
> → `CharacterEnterWorld` → `PlayerCreate` and surfaces a
> `kind=1 PlayerSpawned` event so the status line flips to
> "Spawned". The renderer boots as a backdrop. See
> [`docs/phase-4-renderer.md`](phase-4-renderer.md) for the as-built
> and [`docs/phase-3-renderer.md`](phase-3-renderer.md) for the
> renderer reference. Step 2b (position rendering + entity buffer)
> is the next active rail.
>
> **Phase 1 closed (2026-05-04).** The live-ACE round-trip ran:
> `holtburger-cli ↔ wsshim ↔ wsbridge ↔ ACE` reached the character
> Selection page with full handshake. ACE was brought up locally per
> `docs/ace-local-setup.md` (MariaDB + 3 DBs + .NET 10 SDK + upstream
> ACE clone). The vendored `external/ACE/Source/` is partial — the
> upstream clone at `~/ace-server/` is the build root.
>
> **Decisions answered since the original draft (do not re-litigate):**
> §7.1 external proxy, §7.2 single namespaced HBA-of-HBAs, §7.3
> Leaflet replaced by PixiJS-only, §7.4 wasm-pack picked. Recorded
> inline in §7. The direct-DAT rendering decision in Phase 3 is new
> and is recorded in §4.5 below; it walks away from the static-site
> tile pyramid (the part that's cumbersome to re-bake every time
> WorldBuilder edits a world) while keeping the static-site sprite
> atlas as the visual-continuity bridge between the static gallery
> and the live client.
>
> **Audience:** anyone picking up the next phase. Read this end-to-end before
> writing a line of code; several of the seams below are not what they appear to
> be at a glance.

---

## 1. TL;DR

`emit-dynamic-site` turns the static, snapshot-style Leaflet world map produced by
`emit-static-site` into a *playable* one: the browser becomes a real Asheron's
Call client, connected to a live ACE server, with player movement, chat, combat,
and creature/NPC behavior visible in real time. The view stays top-down — this
is not a 3D-engine port — but the entities under that view are alive.

Three vendored stacks meet here:

```
       ┌─────────────────────────────────────────────────────┐
       │                       browser                       │
       │  ┌────────────────────┐    ┌────────────────────┐   │
       │  │ holtburger (WASM)  │    │ PixiJS / WebGL +   │   │
       │  │  – session         │◄──►│ Leaflet basemap    │   │
       │  │  – world authority │    │ – terrain tiles    │   │
       │  │  – ClientView ev.  │    │ – live entities    │   │
       │  └────────┬───────────┘    └────────────────────┘   │
       └───────────┼─────────────────────────────────────────┘
                   │ WebSocket (one frame == one AC packet)
       ┌───────────▼─────────────────────────────────────────┐
       │                UDP ↔ WS bridge (TBD)                │
       └───────────┬─────────────────────────────────────────┘
                   │ UDP
       ┌───────────▼─────────────────────────────────────────┐
       │                ACE — :9000 / :9001                  │
       └─────────────────────────────────────────────────────┘
```

Plus an HTTP origin serving DAT/HBA assets to holtburger via a custom
`ResourceSource` impl that does range requests over `fetch()`.

## 2. Goals and non-goals

### Goals

- A browser URL where a player logs in and plays AC against a live ACE server.
- Top-down view (Leaflet-style pan/zoom for terrain; WebGL overlay for entities).
- Multi-project: vanilla AC and AI-generated worlds coexist via the existing
  emit-static-site project picker.
- The retail UI surfaces holtburger already implements (chat, vitals, inventory,
  spellbook, vendors) ride along, rendered in DOM panels next to the map.
- Reuse `emit-static-site`'s coordinate system, tile pyramid, and project
  manifest. Drift is a load-time error (`coordSystem` assertion already exists).

### Non-goals

- 3D rendering. (Holtburger's own roadmap pushes a Tauri 3D client as Phase 4;
  that is a different project. We ship the 2D top-down view first.)
- GDLE compatibility. Holtburger is ACE-only; we are too.
- Replacing the static site. emit-static-site keeps shipping and remains the
  zero-dependency, file://-friendly *snapshot* tool. emit-dynamic-site is the
  live-server *cousin*, not a replacement.
- Hosting. We design the stack so a deployment is possible; running a public
  server is a separate concern (and triggers AGPL §13 obligations — see §6.4).

## 3. Surfaces

### 3.1 holtburger — `external/holtburger/`

Hard-forked from upstream commit `629695a2` on 2026-04-23. AGPL v3.

Holtburger is a Rust workspace. The crates relevant to us:

| Crate | Role | Why we care |
|---|---|---|
| `holtburger-protocol` | AC packet structs, opcodes, pack/unpack | Transport-agnostic. We can run it as-is. |
| `holtburger-session` | UDP socket + fragment reassembly + crypto | This is the swap site. |
| `holtburger-content` | HBA discovery, `ContentRepository`, asset access | This is where DAT-over-HTTP plugs in. |
| `holtburger-world` | Authoritative world state | Runs unchanged. |
| `holtburger-core` | Orchestrator; emits `ClientViewEvent` deltas | Runs unchanged; this is the seam our renderer consumes. |

The README's architectural claim is real, not aspirational:

- **`Transport` trait** at `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21`:
  ```rust
  #[async_trait]
  pub trait Transport: Send + Sync {
      async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize>;
      async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)>;
  }
  ```
  `Session` already holds `transport: Box<dyn Transport>`. The catch: `Session::new()`
  hardcodes a `UdpSocket`; there is no public builder for injecting a custom
  transport. **Patch needed:** add `Session::new_with_transport(...)`.
- **`ResourceSource` trait** at `external/holtburger/crates/holtburger-dat/src/lib.rs:138-148`.
  Three methods (`get_file_by_key`, `get_metadata_by_key`, `has_namespace`),
  return type `Vec<u8>`. **Two patches needed:** make it `async`, and add a
  streaming variant for large assets. (Today it's blocking-`Vec<u8>` — workable
  for small DAT chunks, painful for the 200MB+ landscape blob.)
- **Fragment reassembly** at `external/holtburger/crates/holtburger-session/src/session/receive.rs:405-423`
  assumes one transport-layer message == one complete AC packet (with N fragments
  embedded). This is fine over WebSocket as long as the bridge sends one WS
  frame per AC packet — not one frame per fragment. Document that contract.

### 3.2 ACE — `external/ACE/`

AGPL v3. Listens on UDP `:9000` and `:9001` (login + world replies). The
network/session layer (the `ACE.Adapter` assembly with `SocketManager` and
`Session`) is referenced from the vendored source but the assembly itself is
not present in this tree — the project links it as a NuGet/DLL dependency.
That is *fine* for our purposes: we only need the public game-logic seam, not
the socket internals. Game code talks to `Session.Network.EnqueueSend(...)`,
not raw bytes.

For `emit-dynamic-site` ACE is a black box. We do not patch it. We put a
bridge in front.

### 3.3 emit-static-site — `WorldBuilder.Terminal/StaticSiteEmitter.cs`

Already understood — see the existing emit-static-site section in the top-level
README. Two facts that matter for `emit-dynamic-site`:

1. **The frontend has a forward-compatibility hook for live overlays**:
   `app.js:85-90` calls `loadScript('overlays/dynamic_players.js')` and
   silently no-ops if the file is missing. This is the documented seam we
   *would* use if we kept Leaflet for entities. We are not (see §4.2), but it
   confirms the static-site author considered this future.
2. **`coordSystem` is asserted at boot** (`app.js:387-412`). The dynamic
   client inherits the same constants — `worldExtentWu = 49152`,
   `tilePx = 256`, `lbWu = 192`, `pxPerWuAtZ0 = 256/49152`. The current
   live-client bundle does NOT yet assert them programmatically (TODO; see
   §4.5). The constant `METERS_PER_LANDBLOCK = 192.0` lives in
   `holtburger-common::position` and is the load-bearing source for the
   wasm side; both the live and static stacks have to agree on the 49152 m
   world extent (256 landblocks × 192 m).

**Sprite atlas — yes; tile pyramid — no.** The original draft of this doc
treated the static-site tile pyramid (`projects/<slug>/tiles/{terrain,
objects,object,floor}/z{N}/...`) as the live-client basemap. Phase 3
walks away from that — see §4.5 for the rationale. What we DO reuse is
the static-site **sprite atlas** at `projects/<slug>/sprites/atlas.{png,
js}`: hand-tuned, top-down-baked object art with world-bounds metadata,
already in PixiJS-ready shape. That gives visual continuity between the
static gallery and the live client without re-baking pyramids on every
WorldBuilder world change.

### 3.4 The new layer — UDP↔WS bridge (and shim)

This layer landed in Phase 1 (see §8). Two binaries in
`external/holtburger/apps/holtburger-wsbridge/`:

- **`holtburger-wsbridge`** — server-side. One process, listens on a WebSocket
  port (default `:8080`). Per WS connection, opens an ephemeral UDP socket
  toward the configured ACE host (login + world ports). One WS binary frame
  == one AC packet, both directions. Stateless w.r.t. game logic; stateful
  only for the WS↔UDP socket pairing.
- **`holtburger-wsshim`** — client-side mirror, optional. Binds the UDP ports
  an unmodified `holtburger-cli` already dials and tunnels them to a remote
  bridge. Only needed for the native cli; the WASM client (Phase 2) skips
  this binary and speaks WS to the bridge directly.

Neither knows AC encryption — bytes are passed through. Holtburger's session
layer does crypto on whichever side it ends up running.

**Why an external proxy** rather than patching ACE: the Explore agent verified
the network layer is fully abstracted (`Session.Network.EnqueueSend`, no
direct socket calls in game code) — a proxy is transparent. ACE patches mean
forking AGPL code, taking on permanent merge debt, and re-implementing fragment
reassembly inside ACE. The proxy is 1–2 weeks; the patch is multi-month.

The decision is provisional. See open questions §7.

## 4. Decisions taken in this pass

These are the answers we committed to in groundwork. Each is rebuttable, but
each is what the rest of the plan assumes.

### 4.1 Holtburger compiles to WASM and runs in the browser

The other path was "server-side holtburger per player": each session is a
backend process or task, the browser holds only renderer + input. That is
cheaper to build (no WASM port) and equivalent in latency, but pushes server
cost up linearly with concurrent players and concentrates AGPL §13 exposure on
the operator.

Picking WASM means **the browser is the AC client** — same posture as a
desktop install, same AGPL §13 footprint as serving any other browser app, no
per-player backend session brain. The cost is the port:

- **Tokio:** Holtburger's `Cargo.toml` line 33 sets `tokio = { ..., features = ["full"] }`.
  `full` includes native I/O (epoll/kqueue/IOCP). On WASM we need
  `wasm-bindgen-futures` + a feature-trimmed Tokio (`rt`, `sync`, `macros`,
  `time`) or a swap to a different async executor. Audit and rework every
  Tokio call site.
- **`socket2`:** `external/holtburger/crates/holtburger-session/src/session/api.rs:11`
  uses `socket2` to set UDP receive buffer size. Not portable. Either
  feature-gate it off WASM, or reconsider whether the buffer tuning matters
  for a WS-fronted Transport (probably not — flow control is different).
- **`std::fs`:** `holtburger-dat` opens DAT files via `File::open()`. On WASM,
  there is no filesystem. Replace with `ResourceSource` everywhere — which is
  the abstraction holtburger already exposes; the work is making sure no
  internal helper bypasses it.
- **`getrandom`:** crypto needs entropy. `getrandom` has a `js` feature that
  routes to `crypto.getRandomValues` in browsers. Add the feature; verify the
  RC4/ISAAC seed flow doesn't assume `/dev/urandom`.
- **No `wasm32` story today:** the codebase has zero `cfg(target_arch =
  "wasm32")` guards. We add them as we go; the discipline is *fail-stop on
  WASM* for any code path that doesn't yet have a WASM impl, not silent
  best-effort.

This is real work — call it a quarter of engineering effort, not a weekend.
The payoff is a single deployment artifact: a static bundle (HTML + JS + WASM)
behind a CDN.

### 4.2 PixiJS / WebGL renderer, not Leaflet markers

The Explore agent confirmed: at z=11–12 the static site bakes objects into
*tiles*, not markers. There is no marker layer at all today. Leaflet's marker
performance ceiling (DOM-element-per-entity, hitbox per pan/zoom) tops out
around 1k entities; AC has thousands of dynamic creatures and players in a
populated zone. Leaflet markers are a non-starter.

The chosen path: **PixiJS over WebGL for the live entity layer, plus a separate
2D tile basemap** (we keep Leaflet *only* if it earns its keep as the tile
pan/zoom plumbing; otherwise reach for a thinner tile renderer or write our
own — open question §7.3).

PixiJS gets us:

- 10k+ sprites at 60fps under one draw call's worth of overhead.
- The same `coordSystem` math we already have (world-units → tile-pixels →
  screen-pixels is a linear transform; PixiJS containers invert cleanly).
- A clean entity buffer abstraction: each `ClientViewEvent` mutates a flat
  array of {id, x, y, rot, modelKey, animFrame}; render reads the array each
  frame; no per-entity DOM.

The static-site sprite atlas (`projects/<slug>/sprites/atlas.{png,js}`) is
already in the right shape for PixiJS — top-down baked sprites with world
bounds metadata. We reuse it.

### 4.3 Holtburger hard-forked into `external/holtburger`

The submodule path was discarded because §4.1 and §3.1 require non-trivial
patches (Transport builder, async ResourceSource, WASM cfg gates). Submodule
+ patch directory is more ceremony than benefit when we already plan to
upstream nothing for several months. `external/holtburger/VENDORED.md` records
the upstream commit and the resync procedure.

### 4.4 The bridge is external (provisional)

Both Explore agents converged. The patch path is open if a specific need
forces it (e.g., we end up needing ACE-side awareness of WS clients for tick
batching). Default: external proxy.

### 4.5 Direct-DAT rendering — terrain live, sprite atlas reused (NEW, 2026-05-04)

The original draft framed Phase 3 as "Leaflet basemap built from the
emit-static-site tile pyramid + PixiJS entity overlay on top". Phase 3
step 1 walked away from that and rendered terrain *directly* from the
AC `eor/cell:XXYYFFFF` `CellLandblock` records via WASM. Phase 3 step 2
extended that to a 3×3 neighbourhood with PixiJS-owned pan/zoom — no
Leaflet anywhere in the live client.

**Why direct-DAT for terrain:**

- **WorldBuilder workflow.** Re-baking the tile pyramid every time
  WorldBuilder edits a world is the cumbersome part of the static
  pipeline. Direct-DAT means: change the world in WorldBuilder →
  HBA regenerates → reload the browser → terrain re-renders. Zero
  bake step in the inner loop.
- **One source of truth.** AC's DATs already contain heightmap +
  surface-tile-types + textures + object placements. The static
  site's tile pyramid is itself a pre-bake of the same data via the
  WorldBuilder pipeline. Reading the DATs directly removes a layer
  of indirection.
- **Live-only wins are reachable.** Time-of-day, dynamic lighting,
  entity animation — things the pre-baked tile pyramid structurally
  cannot do — become natural extensions of a live render path. They
  are awkward bolt-ons to a Leaflet basemap.

**Why we keep the sprite atlas:**

- The static-site `projects/<slug>/sprites/atlas.{png,js}` is
  hand-tuned, top-down-baked object art with world-bounds metadata,
  already in PixiJS-ready shape. Re-baking it from 3D models at
  runtime in WASM is theoretically possible but slow + complex.
- Visual continuity. The live client and the static gallery should
  read as the same game; sharing the sprite atlas is the cheapest
  way to guarantee that.
- WorldBuilder regenerates the sprite atlas in the same pipeline
  step as the rest of the project's assets, so the "edit world →
  reload browser" loop covers it without extra bake work.

**Practical quality ladder** for the live client to reach
static-site visual fidelity, in order of impact:

| Step | Visual jump | Status |
|---|---|---|
| Heightmap render | topographic relief, recognisable shapes | ✅ landed (step 1+2) |
| Texture atlas + surface table | recognisable AC terrain — biggest delta | ✅ landed (step 3 placeholder, step 3.5 real retail tiles) |
| Sprite atlas consumption | buildings/trees/decorations in the right spots | ✅ landed (step 4 silhouettes → step 4.5 per-model real colours from Surface chain → step 4.5c production atlas swap) |
| Live runtime per-poly rendering | stone walls + wood beams + roof tiles per pixel; custom-model-import-ready | ✅ landed (step 6) — every unique placed model triangulates + UV-maps in the browser at runtime |
| Road overlays + atmospheric polish | matches the README static screenshot | ✅ landed partial (step 5: roads only; atmospherics still open) |

Step 3 first shipped 32 placeholder solid colours per the brief's
scope-reducer guidance, getting the shader pipeline in place. Step
3.5 followed up with **real retail AC textures** by porting the
Palette (`0x04`), SurfaceTexture (`0x05`), and Texture (`0x06`)
parsers from upstream ACE and signature-scanning the Region binary
to extract the canonical 33-entry terrain → SurfaceTexture mapping
(skipping a runtime Region parser as multi-week scope). Each cell
now tiles a 256×256 sample of its real AC tile across its 24m face.

**Step 6 — live runtime per-model rendering** is the most recent
shift in the rail. The original assumption (recorded earlier in
this section) was "reuse the static-site sprite atlas at runtime."
That works for shipped retail content where the atlas already
covers the model, but fails the project's whole purpose for *custom*
models — users importing new content would need to re-bake the
atlas every change. Step 6 walks the same chain the static-site
emitter walks (`GfxObj/SetupModel → polygons → Surface →
SurfaceTexture → RenderSurface → RGBA8`), triangulates the model in
Rust, and rasterizes top-down via a per-poly UV-mapped fragment
shader in PIXI — at runtime, in the browser. Output goes to a
PIXI.RenderTexture cached by model_id. The static atlas remains as
a warm-start fallback for models the live walk fails on (rare —
Phase 3 step 6 reports 80 of 81 unique Holtburg models live-render;
the 1 outlier is an engine-internal light-source anchor with
NoPos-stippled geometry, correctly invisible). Custom models now
render immediately on the next page load with no rebake step,
which unblocks the WorldBuilder edit-and-reload loop §4.5 was
designed around.

**What's deliberately NOT in this rail:**

- Leaflet, MapLibre, or any 2D tile renderer (§7.3 answered:
  PixiJS-only).
- The `dist/projects/<slug>/tiles/` pyramid as live-client input
  (the bake-once cost is the cumbersome part being avoided).
- A separate "basemap vs. entity layer" architecture; everything is
  PixiJS scene-graph children, separable but unified.

This decision is recorded here so future readers don't re-litigate
"shouldn't we just use Leaflet" without an explicit reason.

## 5. Critical assessment

### 5.1 Leaflet at scale — what we're not using it for

Leaflet is excellent at three things: a tile pan/zoom UI, a tile cache, and
projection math. It is bad at a fourth: rendering many moving DOM elements.

The static site uses Leaflet at strengths #1 and #3 and works around #4 by
*pre-rendering entities into tiles*. The dynamic site cannot pre-render moving
entities, so we cannot use Leaflet for them. That is a structural fact, not
an optimization tradeoff.

The remaining question is whether we keep Leaflet for the basemap and overlay
PixiJS, or replace Leaflet entirely. Open question §7.3.

### 5.2 WASM-porting holtburger — eyes-open

The user picked the WASM path knowing it is harder than the server-side
alternative. The original cost-of-the-port checklist below was speculative;
**the empirical inventory now lives at
[`phase-2-wasm-spike.md`](phase-2-wasm-spike.md)** and replaces it as the
authoritative starting point. Read that first. Highlights:

- `holtburger-protocol` and `holtburger-common` already cross-compile to
  `wasm32-unknown-unknown` clean. The AC packet codec, opcode tables, and
  ISAAC crypto are WASM-portable as-is.
- The two real blockers are `tokio = ["full"]` (pulls in `mio`) and
  `zstd-sys` (pulls in a C compiler). Everything else cascades from these.
- The `Session::new_with_transport` constructor that the WS transport will
  plug into has landed (`crates/holtburger-session/src/session/api.rs`).
  Backwards-compatible with all existing call sites.
- The RC4 doc lie called out in §5.5 has been corrected.

The original speculative checklist, all closed:

- [x] `holtburger-session::Session::new`: split into `new(addr)` (native) and
      `new_with_transport(transport, addr)` (any-transport). Done as
      `new` + `new_with_transport`; backwards-compatible. (`f3d9a1c`)
- [x] Audit RC4 vs ISAAC (§5.5). Code was always ISAAC; the two stale doc
      references at `external/holtburger/ARCHITECTURE.md:75` and
      `crates/holtburger-session/ARCHITECTURE.md:19` are corrected.
      (`f3d9a1c`)
- [x] `Cargo.toml`: workspace `tokio = { default-features = false }`, with
      per-crate feature opt-ins. Native-only crates pick `["full"]`;
      WASM-target crates pick `["rt", "sync", "macros", "time"]`. Landed
      in the Phase 2 floor commits `50003ae`..`868c3ac`.
- [x] Cfg-gate the UDP path in `holtburger-session` to
      `cfg(not(target_arch = "wasm32"))`; cfg-gate `socket2` likewise.
      Landed in the same Phase 2 floor range.
- [x] `holtburger-dat`: replace `zstd-sys` with `ruzstd` for wasm32 (kept
      `zstd` natively for the dat2hba tool). `decompress_zstd(buffer,
      expected_size)` cfg-split helper in `archive.rs`. Phase 2 floor.
- [x] **Reversed:** `ResourceSource` stays sync. `HttpResourceSource::connect`
      `await`s the bytes once at construction time and serves them sync from
      in-memory state. The async-trait refactor would have propagated `.await`
      through ~6 call sites in 4 crates plus a `#[async_trait(?Send)]`
      cfg-split mirroring `Transport`; not worth the spike cost. `Vec<u8>`-
      backed `HbaReader` is `Send + Sync`, so `LayeredResourceResolver`'s
      `Vec<Arc<dyn ResourceSource>>` storage accepts `HttpResourceSource`
      without trait-level changes. Reconsider only if memory pressure forces
      streaming. (`b4da651`, `ac7f92d`)
- [x] `WsTransport: Transport` for browsers — landed in
      `crates/holtburger-transport-ws`, wasm32-gated so native graphs don't
      pull `web-sys`. (`e151003`, `2364277`)
- [x] `HttpResourceSource: ResourceSource` — landed in
      `crates/holtburger-resource-http`. Three cascaded fetch paths
      (`Window`, `WorkerGlobalScope`, `Reflect::get(globalThis, "fetch")`)
      so the same bundle works in browser tabs, workers, and Node ≥ 18.
      (`ac7f92d`)
- [x] `tokio::spawn` Send audit — handled implicitly by the `Transport`
      trait cfg-split: native trait keeps `Send + Sync` + `#[async_trait]`,
      wasm32 trait drops them + uses `#[async_trait(?Send)]`. Survey of
      session/core call sites confirmed nothing actually spawns a `Session`
      across threads today. (`e151003`)
- [x] Build pipeline: `wasm-pack` picked over `trunk` (we're "Rust crate
      consumed by JS"). New crate `apps/holtburger-web` is the cdylib bundle.
      Two verification paths: `node smoke_test.cjs` against the
      `--target nodejs` build and a real browser against `--target web`.
      (`3025834`)

The empirical record is in `docs/phase-2-wasm-spike.md` and the as-built
crate matrix at §3 of that file. The auto-memory entry
`project_emit_dynamic_site.md` carries the same information for future
sessions.

### 5.3 DAT-over-HTTP — feasible, but thoughtful

The `ResourceSource` trait makes this trivial *to wire up* and non-trivial *to
do well*. Three things to settle:

1. **Granularity.** Holtburger's `dat2hba` tool produces "namespaced HBA v2
   bundles" — already a step toward shardable assets. But an HBA bundle today
   is one big file. The browser cannot afford to download the full bundle
   before starting; we need either per-asset HTTP fetches (high request count)
   or pre-sharded bundles by zone/region (better cache locality, more
   tooling). Pick a pattern early; it's easier than retrofitting.
2. **Caching.** Once an asset is fetched it should sit in IndexedDB (or the
   browser's HTTP cache, if we set headers correctly), not re-fetched per
   session. Adds a `CachedResourceSource` wrapper around the HTTP one.
3. **Security/integrity.** AGPL §13 doesn't require us to keep the DATs
   private — but if we serve them publicly we are arguably distributing AC
   client assets, which has its own legal posture independent of AGPL.
   Operator concern, not architectural; flag it loudly in deployment docs.

### 5.4 AGPL v3 §13 — a real obligation, not a footnote

AGPL §13 ("Remote Network Interaction") says: if a hosted service lets users
interact with our modified version, we must offer the source. For
`emit-dynamic-site`, this means an operator running the dynamic site at, say,
`example.com/play` has to:

- Publish their fork (including patches to holtburger, the WS bridge, the
  PixiJS frontend, the WASM build pipeline) at a URL the running service
  points users to.
- Keep that URL in sync as patches roll forward.

This is not a problem for the project itself — we publish under AGPL. It *is*
a problem for some downstream operators who may not realize they have a
publication obligation. We document it in the README's License section and
in the deployment docs (when those exist).

### 5.5 Encryption: a discrepancy worth chasing — RESOLVED

> Resolved in the Phase 2 opener (commit `f3d9a1c`). The Explore-agent
> verdict during the groundwork pass was: holtburger crypto is **ISAAC
> only**, used as a per-packet keyed checksum (not a stream cipher over
> the body — see `session/receive.rs` and `session/reliability.rs`).
> The two stale "RC4" doc references were corrected. No RSA either —
> the substring `*ServerSave*` was the only `RSA` grep hit and it is
> coincidental.

## 6. Holtburger's modular network/session stack — a closer look

Restating the README claim with citations so future work can move directly:

> "Asheron's Call clients require a UDP↔WebSocket bridge and holtburger's
> network/session stack is modular so it technically can be swapped out for a
> WS layer if needed."

Verified, with one footnote:

- `Transport` trait: `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21`.
- `Session` field: `transport: Box<dyn Transport>` at `types.rs:90`.
- Construction site that hardcodes UDP: `external/holtburger/crates/holtburger-session/src/session/api.rs:9-11`.
- Test transport (`MockTransport`) implementation already exists, proving the
  abstraction has more than one implementer.

**The footnote:** the trait exists; the *constructor that injects an
arbitrary transport* does not. Adding `Session::new_with_transport(...)` is a
small, contained patch. It is not a "no swap is possible" finding — but
neither is this a "one-line change."

## 7. Open questions

Each is a real fork in the road. Items 7.1-7.4 have been answered as
of 2026-05-04 and are kept here annotated; items 7.5-7.6 are still
genuinely open.

### 7.1 WS bridge: external proxy or ACE patch? — ANSWERED: external proxy

> Resolved by Phase 1 (2026-05-03 + 2026-05-04). The
> `holtburger-wsbridge` + `holtburger-wsshim` pair landed; 21 tests
> green including a full `cli ↔ shim ↔ bridge ↔ echo` loop with login
> + world traffic interleaved (`d00770a`, `0945b7f`). Validates the
> proxy is transparent: an unmodified `holtburger-cli` reaches the
> echo server entirely over WebSocket. Live-ACE round-trip is the
> only Phase 1 follow-on, blocked on three MySQL DBs + ACE DAT files.
>
> The patch path stays open if ACE-side awareness of WS clients ever
> becomes load-bearing, but no force has appeared yet.

### 7.2 DAT delivery format: per-asset, or pre-sharded HBA? — ANSWERED: single namespaced HBA-of-HBAs

> Resolved by Phase 2 §8 step 4 (commit `ac7f92d`). The existing
> `dat2hba` tool produces a "namespaced HBA v2 bundle" — already
> shardable by namespace. We ship a single bundle (`dats/assets.hba`,
> ~230 MB at `--profile pruned`) with `eor/portal`, `eor/cell`, and
> `holtburger/core` namespaces inside; the wasm bundle's
> `HttpResourceSource::connect(url)` fetches it once at session start
> and serves entries sync from in-memory state.
>
> The "one bundle per landblock-region (~100 regions)" sharding was
> rejected for the spike — the simpler shape ships first; revisit if
> the single-bundle's pre-load cost becomes a UX problem (it does
> not today). The brief at §8 lays out the migration path if needed.
>
> See `docs/phase-2-wasm-spike.md` §8.4 for the full rationale.

### 7.3 Tile basemap: keep Leaflet, or replace? — ANSWERED: replaced (PixiJS-only)

> Resolved by Phase 3 step 2 (commit `f04b1f5`). The current bundle
> has no Leaflet — PixiJS owns pan, zoom, and the camera container.
> The third option (MapLibre GL) was not pursued; we are not doing
> tilt or 3D, so MapLibre's strengths don't apply.
>
> The deeper rationale lives in §4.5 — direct-DAT terrain rendering
> walks away from the static-site tile pyramid (the "cumbersome to
> re-bake on every WorldBuilder world change" part) while keeping
> the sprite atlas as visual continuity. PixiJS-only is the simplest
> way to express that: one rendering pipeline, one scene graph, one
> set of input handlers.
>
> The "spike Leaflet first, fall back to WebGL if event coordination
> becomes painful" plan from the original draft was overtaken by
> the Phase 3 step 1 work, where the simplest path turned out to be
> "just use PixiJS for everything from the start".

### 7.4 WASM build pipeline: `wasm-pack` or `trunk`? — ANSWERED: wasm-pack

> Resolved by Phase 2 §8 step 1 (commit `3025834`). `wasm-pack 0.14.0`
> picked over `trunk` because we are "Rust crate consumed by JS"
> rather than "the whole app is Rust" (PixiJS owns the renderer
> JS-side). Two verification paths land alongside the bundle: `node
> smoke_test.cjs` against the `--target nodejs` build (currently 17
> checks) and a real browser against the `--target web` build via
> Playwright + Chromium with `--use-gl=swiftshader`.

### 7.5 Login flow: real ACE accounts, or a transient guest path?

ACE expects username + password. The browser-playable client must collect
them. UX question: do we proxy directly (browser sends creds over WS, bridge
forwards UDP login packets), or does emit-dynamic-site sit behind an OAuth
gate that maps web identities to ACE accounts? Defer; the proxy path works
for the spike.

### 7.6 Server count: where does the bridge live?

One bridge per ACE world (operator-deployed alongside ACE) is the obvious
shape, but a single bridge could front many ACE worlds (multi-server picker
in the browser). Defer; either works.

## 8. Phased plan

Phase 0 — **Groundwork (DONE in this pass).**
- LICENSE.md (AGPL v3) at project root.
- holtburger hard-forked into `external/holtburger/`.
- README License + emit-dynamic-site sections.
- This design doc.

Phase 1 — **WS↔UDP loop spike.** ~1–2 weeks.
- Two standalone Rust binaries in `external/holtburger/apps/holtburger-wsbridge/`:
  the **bridge** (WS-side, in front of ACE) and the **shim** (UDP-side, in
  front of an unmodified cli). Together they let an existing
  `holtburger-cli` reach a real ACE entirely over WebSocket.
- Proves the proxy is transparent: the cli can log in, walk around, and
  chat against ACE without modification.
- No browser involvement yet. This is the "is the architecture even right"
  test, validated in software before the WASM port is attempted.

**Phase 1 status (2026-05-03):**
- ✅ Bridge binary `holtburger-wsbridge` at
  `external/holtburger/apps/holtburger-wsbridge/` (registered in workspace; AGPL).
- ✅ Client-side shim binary `holtburger-wsshim` in the same crate
  (`src/bin/wsshim.rs`). Mirror of the bridge: binds the UDP ports an
  unmodified `holtburger-cli` already dials and tunnels them over WS.
- ✅ Shared library (`src/lib.rs`) exposes the frame codec to both binaries
  so the wire-format contract changes in lockstep.
- ✅ WS frame protocol: `[port:u16 BE][ac_packet]` — see the crate's
  [`ARCHITECTURE.md`](../external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md)
  for the rationale (login + world multiplex on one WS connection).
- ✅ End-to-end smoke tests cover both halves on their own *and* the full
  loop: `cli ↔ shim ↔ bridge ↔ echo` with login and world traffic
  interleaved. 21 tests total; all green.
- ✅ Allowlist guards on both binaries: only the configured login / world
  ports are forwarded; datagrams from other source IPs/ports are dropped.
- ✅ Listen-vs-ACE port split on the shim, so ACE-on-non-standard-ports
  works without retraining `holtburger-cli`.
- ✅ **Live-ACE round-trip — DONE (2026-05-04).** ACE brought up locally
  (`~/ace-server/` clone of upstream `ACEmulator/ACE`, MariaDB +
  three-DB provisioning, .NET 10.0.203 SDK, `Config.js` drop-in,
  `ACE_NONINTERACTIVE_CONSOLE=true` headless launch). Two validation
  paths both reached the cli's Selection page on a real ACE instance:
  (a) `holtburger-cli → UDP 9000 → ACE` direct, (b) full Phase 1 loop
  `cli → wsshim → wsbridge → ACE`. Login + handshake + DddInterrogation
  response + CharacterList + ServerName "ACEmulator-local" all received.
  See `docs/ace-local-setup.md` for the recipe + lessons learned.

Phase 2 — **WASM port spike (DONE, 2026-05-04).** ~3–4 weeks budgeted; landed
inside that window.
- ✅ `holtburger-session` cfg-gates UDP-native code; adds
  `Session::new_with_transport` (`f3d9a1c`).
- ✅ All seven library crates cross-compile to `wasm32-unknown-unknown`
  (`50003ae`..`868c3ac`). Native invariant held: 1086 lib tests across 13
  crates pass at every commit boundary.
- ✅ New crate `holtburger-transport-ws` with `WsTransport: Transport`,
  wasm32-only (`e151003`, `2364277`).
- ✅ `holtburger-dat::ResourceSource` stays sync (the async refactor was
  deliberately rejected — see §5.2). `HttpResourceSource::connect` does
  one async fetch at construction time and serves entries sync from
  in-memory state.
- ✅ New `HttpResourceSource` impl in `holtburger-resource-http`,
  wasm32-only, with three cascaded fetch resolution paths covering
  browser tabs, Web Workers, and Node ≥ 18 (`ac7f92d`, `5b6fefd`).
- ✅ `wasm-pack`-built bundle (`apps/holtburger-web`) loads in browser +
  Node smoke test; deterministic checks 17/17 PASS.
- ⏳ End-to-end bundle handshake against ACE through the bridge —
  blocked on the same Phase 1 follow-on (live ACE backend). The bundle
  has all the wiring (`try_ws_handshake_smoke`); the round-trip waits on
  the ACE backend unblock.

The "deepest-risk phase" framing held — Phase 2 was where the cross-
compile floor decisions could have caved. They didn't; the rest is now
product work.

Phase 3 — **Renderer scaffold (in flight, on direct-DAT rail; see §4.5).**
The original "Leaflet basemap + PixiJS entity overlay + reuse 95% of
emit-static-site's tile pyramid" framing was replaced in Phase 3 step 1.
The current rail is: render terrain directly from `eor/cell` HBA records
in WASM, keep the static-site **sprite atlas** for object art, walk away
from the tile pyramid. See §4.5 for the rationale and quality ladder.

Step ledger:
- ✅ **Step 1** (`a5e0a91`..`590fc95`) — `fetch_landblock_heightmap`
  wasm-bindgen export + PixiJS Mesh render of one Holtburg landblock.
  256×1 height-ramp gradient texture, wireframe overlay, single static
  view. Smoke test 8 → 14 checks. Deliverable:
  [`docs/images/phase-3-step-1-landblock.png`](images/phase-3-step-1-landblock.png).
- ✅ **Step 2** (`38afb1c`..`79818ac`) — 3×3 Holtburg neighbourhood,
  batch-fetched via `fetch_landblock_heightmaps`. PixiJS-only camera
  (mouse-wheel zoom around the cursor, drag-to-pan). Coordinate-unit
  fix landed on the way in (vertices are 24 m apart, not 3 m;
  landblock is 192 m, not 24 m — see the correction note in
  `docs/phase-3-renderer.md`). Smoke test 14 → 17 checks. Deliverable:
  [`docs/images/phase-3-step-2-multi-landblock.png`](images/phase-3-step-2-multi-landblock.png).
- ✅ **Step 3** (`06597eb`..`471d02a`) — per-vertex `terrainCodes` +
  custom GLSL ES 3.00 Mesh shader + 32-colour placeholder atlas.
  `flat in int vTerrainCode` from the SW provoking vertex so each
  cell shades as one terrain type. Shipped placeholder colours per
  the brief's scope-reducer; real retail tiles followed in step 3.5.
  Smoke test 17 → 20 checks. Deliverable:
  [`docs/images/phase-3-step-3-textured.png`](images/phase-3-step-3-textured.png).
- ✅ **Step 5 (partial — roads)** (`0a2e0a3`..`166bc2c`) — per-vertex
  `roadCodes` + road-overlay layer. Holtburg's stone-road network
  now renders as light-grey paths through the centre, matching the
  static-site z=12 reference. Atmospherics (fog, day/night) still
  open. Smoke 20 → 24 checks. Deliverable:
  [`docs/images/phase-3-step-5-roads.png`](images/phase-3-step-5-roads.png).
- ✅ **Step 3.5** (`0e47306`..`6fbc15f`) — Palette (0x04),
  SurfaceTexture (0x05), Texture (0x06) parsers landed in
  `holtburger-dat`. New `fetch_terrain_textures` wasm export decodes
  all 33 retail terrain tiles (signature-scanned from the
  `eor/portal:0x13000000` Region binary at bake time, not parsed at
  runtime — multi-week scope deferred). JS atlas builder downscales
  512×512 source → 256×256 atlas, custom shader switches from a
  32-column lookup to per-region UV math. Bumped fixture profile
  from `pruned` to `full` (605 MB) since pruned excludes the texture
  pipeline. Smoke 24 → 28 checks. Deliverable:
  [`docs/images/phase-3-step-3.5-real-textures.png`](images/phase-3-step-3.5-real-textures.png).
- ✅ **Step 4** (`5eb5736`..`19c4727`) — `fetch_landblock_objects`
  wasm export reads `LandblockInfo` Stab + BuildInfo lists, returns
  239 placements for Holtburg's 3×3. Static-site sprite atlas reused
  via PIXI sprite-tinting (atlas tiles were greyscale silhouettes at
  this point — see step 4.5c for the production-atlas correction).
  Drive-by fix: `BuildInfo.num_portals` was `u16` but ACE writes
  `u32`; mismatch only triggered when buildings had any portals
  (Holtburg's first interior building hits it). Smoke 28 → 32 checks.
  Deliverable:
  [`docs/images/phase-3-step-4-objects.png`](images/phase-3-step-4-objects.png).
- ✅ **Step 4.5** (`6d1b9e8`..`bcf4d2f`) — Surface (0x08) parser +
  `fetch_object_colours` wasm export. Walks each placed model's
  GfxObj/SetupModel surface chain in Rust, returns one ARGB per
  unique model_id. Two key footguns surfaced: Surface (0x08)
  records have **no leading `id` field** (unlike Texture / Palette /
  SurfaceTexture); `Surface.OrigTextureId` actually holds a
  **SurfaceTexture (0x05) ID**, not a Texture (0x06) ID — the walk
  needs an extra `SurfaceTexture::highest_res()` hop, mirroring the
  chain `WorldBuilder.Shared/Lib/Texture/RenderSurfaceImporter.cs`'s
  `CreateSurface` builder uses. Smoke 32 → 36 checks. After step
  4.5b's DXT decoder + step 4.5c's atlas swap, the resolve rate is
  **81/81 Holtburg unique models with 54 distinct ARGB values**.
- ✅ **Step 4.5b** (`5842d5a`..`9afb1d7`) — DXT1/DXT3/DXT5 decoder
  ported from upstream ACE `DxtUtil.cs` (Ms-PL, notice retained).
  Closes the last 27 of 81 Holtburg models that bottomed out at
  `Texture::to_rgba8: UnsupportedFormat(Dxt1|Dxt5)` in step 4.5.
  6 new unit tests (workspace lib total 1100 → 1106).
- ✅ **Step 4.5c** (`197369a`) — production atlas swap. The atlas
  step 4 copied from `docs/sample-dist/projects/vanilla/sprites/`
  was a 4096×1296 greyscale-silhouette build (R=G=B for every
  pixel verified across 3.7M opaque samples). Swapped in the
  fresh production atlas from `~/dist-regen/projects/vanilla/sprites/`:
  8192×4088 with 169 model entries and full per-pixel chroma
  (stone, wood, roof tiles in real AC colours). Removed the
  runtime sprite tint (it was destroying per-poly variety on a
  greyscale silhouette but multiplied destructively against
  colour-baked atlas tiles); fallback dot still uses the resolved
  per-model ARGB.
- ✅ **Step 6** (`8c41045`..`bce626a`) — **live runtime per-model
  rendering**. `fetch_model_meshes` + `fetch_surfaces_pixels` wasm
  exports (port of the static-site emitter's `TriangulateModel` +
  `AppendGfxTris` to Rust). JS-side rasterizer
  (`buildLiveSpriteMap` + `renderModelTile` + custom textured GLSL
  fragment shader) renders each unique model to a
  PIXI.RenderTexture cached by model_id. Mirrors
  `ObjectSpriteGenerator.cs::DrawTriangle` (per-poly UV-mapped
  texture sampling × per-vertex Lambert shade) at runtime —
  **custom models now render without a re-bake step**, which is
  the design's whole point per §4.5. Prereq fix: GfxObj polygon
  parser stipple/cull bit-mask bug (`0x01`/`0x02` should have been
  `0x04`/`0x08`; CullMode `1`/`None` should have been `2`/Clockwise)
  — was silently failing on ~50% of retail records, causing
  `failed to fill whole buffer` deeper in the parse. After the fix:
  15,318 / 15,318 retail GfxObjs parse successfully across the
  full bundle. **80 of 81 unique Holtburg models live-render**;
  the 1 outlier is `0x02000364`, an engine-internal light-source
  anchor (single 8cm × 6cm vertical triangle with NoPos stippling,
  no weenie binding across 43,911 retail weenies, correctly
  invisible — fallback dot suppressed via `bce626a`). Smoke 36 →
  41 checks. Deliverable:
  [`docs/images/phase-3-step-6-live-render-zoomed.png`](images/phase-3-step-6-live-render-zoomed.png)
  (3× zoom on Holtburg town centre showing wooden doors, reddish
  roof tile, plank-textured cart, stone walls + paths).
- ⏳ **Atmospherics (rest of step 5)** — fog of war, day/night
  gradient, post-process bloom on water tiles. Independent polish;
  not gating Phase 4.
- ⏳ **Per-cell terrain blending (CornerTerrainMaps)** — AC's
  actual surface table uses corner/side blend maps for proper
  transitions across cell boundaries. Currently each cell renders
  one terrain type uniformly; with corner blends, a grass-to-water
  boundary fades smoothly. Multi-pass rendering, ~150 lines of
  additional shader work. Step 5+ scope.
- ⏳ **Multi-landblock streaming** — extend beyond the 3×3
  hardcode to N×N visible landblocks driven by the camera. Needs
  a landblock-id → `LandblockMesh` cache, camera-driven prefetch,
  eviction, LOD/culling. Step 5+ scope.
- ⏳ **Renderer-profile bake (asset-bundle size)** — step 3.5
  forced `dat2hba --profile full` because the existing `pruned`
  profile excludes Texture / SurfaceTexture / Palette types via
  `is_essential()`. Bundle grew 233 MB → 605 MB. A new `renderer`
  profile that's `pruned` + the texture-pipeline types would land
  in the ~280 MB range. Mechanical change in
  `crates/holtburger-dat/src/file_type/mod.rs` (extend
  `is_essential` or add a parallel filter). Step 5+ scope.
- ⏳ **`coordSystem` assertion** — the live bundle should assert
  `worldExtentWu = 49152, tilePx = 256, lbWu = 192, pxPerWuAtZ0 =
  256/49152` against the project's coord block at boot, mirroring
  `app.js:387-412`. Currently the wasm side reads
  `holtburger-common::position::METERS_PER_LANDBLOCK = 192.0` directly;
  the JS side hard-codes the same constant. Lift this to an explicit
  load-time check before Phase 4 wiring depends on it.

Phase 4 — **Wiring.** ~2 weeks. Gated on the live ACE backend unblock.

Step ledger:
- ✅ **Step 1 — wasm-driven AC login → CharacterList in browser.**
  Landed 2026-05-04 (see
  [`docs/phase-4-renderer.md`](phase-4-renderer.md) for the as-built;
  briefing at [`docs/phase-4-step-1-handoff.md`](phase-4-step-1-handoff.md)).
  Adds `start_session` + `SessionHandle` (with `poll_events()` /
  `characterList()` / `accountName`) + `ClientEvent` (kind=0
  CharacterListReceived) + `CharacterSummary` exports to
  `apps/holtburger-web/src/lib.rs`. JS-side login form gates the
  renderer; Selection screen renders the account's characters as a
  `<ul>` with a placeholder Spawn button (logs to console — step 2
  wires the actual `ClientCommand::SelectCharacter` flow). Side
  fix: `tokio::time::sleep` on wasm32 swapped for
  `gloo_timers::future::TimeoutFuture` in
  `crates/holtburger-session/src/session/receive.rs` — without it,
  the receive loop's CONNECT_RESPONSE deadline panics on
  `wasm32-unknown-unknown` ("time not implemented on this
  platform"). Smoke 41 → 44 checks. Manual live-ACE validation
  against `~/ace-server/` per `docs/ace-local-setup.md`; Playwright
  capture at `apps/holtburger-web/capture_phase4_step1.cjs`,
  deliverable at `docs/images/phase-4-step-1-character-list.png`.
- ✅ **Step 2a — spawn handshake → "Spawned" status.** Landed
  2026-05-04 (see [`docs/phase-4-renderer.md`](phase-4-renderer.md)
  step 2a section). Refactors `SessionHandle` to spawn a persistent
  recv loop via `wasm_bindgen_futures::spawn_local`; the loop
  `tokio::select!`s between `session.recv_message()` and an
  `mpsc::UnboundedReceiver<SessionCommand>` driven by JS. Adds
  `SessionHandle.selectCharacter(guid)` which sends
  `CharacterEnterWorldRequest`, auto-chains `CharacterEnterWorld`
  on receiving `CharacterEnterWorldServerReady`, and surfaces
  `PlayerCreate(guid)` as a `kind=1 PlayerSpawned` event. JS-side
  Spawn button click → `requestAnimationFrame` event drain → status
  flips to "Spawned <name> (GUID 0xN)". `kind=4 Disconnected` lands
  on session error. Smoke 44 → 45 (selectCharacter symbol).
  Playwright capture at
  `apps/holtburger-web/capture_phase4_step2a.cjs`. Position
  rendering of the local player + multi-entity buffer is step 2b.
- ✅ **Step 2a.5 — character creation in the browser.** Landed
  2026-05-04 (see [`docs/phase-4-renderer.md`](phase-4-renderer.md)
  step 2a.5 section). Closes the empty-list gap that step 2a's
  screenshot demo hit by exposing character creation through the
  wasm bundle. `start_session` now takes an `asset_url` 6th param,
  fetches the HBA via `HttpResourceSource`, parses `CharGen`
  (`0x0E000002`) + `SkillTable` (`0x0E000004`), and builds a
  `holtburger_content::CharacterGenCatalog` for offline validation.
  Adds `SessionHandle.createTestCharacter(name)` which constructs
  an Aluvian / Male / Adventurer / Holtburg
  `CharacterCreateRequestData` via
  `holtburger_core::CharacterGenBuilder::build_request`, and
  `SessionHandle.canCreateCharacter` getter for JS feature
  detection. Recv loop handles `SessionCommand::CreateCharacter`
  outbound + `GameMessage::CharacterCreateResponse` inbound;
  on Ok, locally pushes the new entry into `character_list`
  (mirrors cli's `handle_create_response` since ACE doesn't
  re-fire CharacterList after Create) and queues a `kind=5
  CharacterCreated` event. JS-side Create form auto-shows when
  the catalog loaded; submit → `kind=5` drain → list re-render
  with Spawn button. Smoke 45 → 47 (createTestCharacter +
  canCreateCharacter symbols). Deliverable at
  `docs/images/phase-4-step-2a-spawned.png` re-captured against
  the full create + spawn flow.
- ⏳ **Step 2b — `ClientViewEvent` → PIXI entity buffer.**
  Position-driven rendering for the local player + NPCs / monsters
  via `ObjectCreate` + `UpdatePosition` / `VectorUpdate`. Reuses
  Phase 3 step 6's per-model render cache. Allows switching
  characters mid-session.
- ⏳ **Step 2 — `ClientViewEvent` → PIXI entity buffer.** Once a
  character is selected in step 1 and spawned, AC's server starts
  pushing world state (entity positions, animations, chat). Wire
  the Session's event stream into the renderer's per-frame loop.
  Reuses step 6's per-model render cache for entity sprites.
- ⏳ **Step 3 — input (WASD / click-to-target) → AC movement
  packets.** Translate browser input events through
  `holtburger-core`'s existing input surface to AC
  `CharacterPositionUpdate` packets. Closes the gameplay loop.
- ⏳ **Step 4 — DOM panels (chat, vitals, inventory).** Render
  the retail UI surfaces holtburger already drives, in DOM panels
  next to the PIXI canvas. Parallel to step 2/3.

Phase 5 — **Hardening.** Indefinite.
- DAT-over-HTTP shard layout if single-bundle pre-load becomes a UX
  problem (§7.2 currently answered: single bundle, OK for the spike).
- IndexedDB asset caching.
- Login flow UX (§7.5).
- Performance: 100 concurrent entities, 1000, 5000.
- Multi-project / multi-world picker.

Each phase ends with a working artifact. We do not start the next phase until
the current one demonstrably works against ACE.

## 9. Reference index

File:line citations from the groundwork exploration + as-built docs from
later phases, kept here so future work can jump directly without
re-discovering them.

### Holtburger source seams (groundwork-pass citations)

| What | Where |
|---|---|
| `Transport` trait definition | `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21` |
| `Session.transport` field | `external/holtburger/crates/holtburger-session/src/session/types.rs:90` |
| Hardcoded `UdpSocket::bind` (the patch site) | `external/holtburger/crates/holtburger-session/src/session/api.rs:9-11` |
| `Session::new_with_transport` (the seam that landed) | `external/holtburger/crates/holtburger-session/src/session/api.rs` |
| Fragment reassembly (assumes whole-packet recv) | `external/holtburger/crates/holtburger-session/src/session/receive.rs:405-423` |
| `ResourceSource` trait | `external/holtburger/crates/holtburger-dat/src/lib.rs:138-148` |
| `ContentRepository::from_mounts` | `external/holtburger/crates/holtburger-content/src/repository.rs:75-80` |
| ClientRuntime asset loading | `external/holtburger/crates/holtburger-core/src/client/builder.rs:54-80` |
| `METERS_PER_LANDBLOCK = 192.0` (canonical AC constant) | `external/holtburger/crates/holtburger-common/src/position.rs:5` |

### emit-static-site seams

| What | Where |
|---|---|
| `emit-static-site` orchestrator | `WorldBuilder.Terminal/StaticSiteEmitter.cs:41-128` |
| `coordSystem` emission | `WorldBuilder.Terminal/StaticSiteEmitter.cs:741-746` |
| `coordSystem` boot assertion | (emitted) `app.js:387-412` |
| Forward-compat live overlay hook (unused on current rail) | (emitted) `app.js:85-90` |
| Tile pyramid emitter (NOT consumed by the live client; see §4.5) | `WorldBuilder.Terminal/TilePyramidEmitter.cs:54-91, 101-134` |
| Sprite atlas (consumed by the live client at Phase 3 step 4) | `projects/<slug>/sprites/atlas.{png,js}` |

### ACE seams

| What | Where |
|---|---|
| ACE network port config | `external/ACE/Source/ACE.Server/Config.js.example:5-26` |
| ACE socket initialization | `external/ACE/Source/ACE.Server/Program.cs:311-312` |
| ACE game-logic seam (`Session.Network.EnqueueSend`) | `external/ACE/Source/ACE.Server/WorldObjects/Player.cs:43, 114-117` |

### As-built docs from later phases

| Doc | Covers |
|---|---|
| [`phase-2-wasm-spike.md`](phase-2-wasm-spike.md) | Phase 2 §3 per-crate cross-compile matrix, §8 step ledger, status banner |
| [`phase-3-renderer.md`](phase-3-renderer.md) | Phase 3 steps 1, 2, 3, 3.5, 4, 4.5, 5 partial, 6 as-built reference + screenshots |
| [`phase-3-step-1-handoff.md`](phase-3-step-1-handoff.md) | Brief that framed step 1 (single-landblock render) |
| [`phase-3-step-2-handoff.md`](phase-3-step-2-handoff.md) | Brief that framed step 2 (3×3 + camera + unit fix) |
| [`phase-3-step-3-handoff.md`](phase-3-step-3-handoff.md) | Brief that framed step 3 (per-vertex terrain code + custom shader) |
| [`phase-3-step-4.5-handoff.md`](phase-3-step-4.5-handoff.md) | Brief that framed step 4.5 (Surface chain + per-model real colours) |
| [`phase-4-step-1-handoff.md`](phase-4-step-1-handoff.md) | Brief framing the next step (wasm-driven AC login → CharacterList) |

### Live-client wasm-bindgen surface (`apps/holtburger-web`)

| Export | Phase | Purpose |
|---|---|---|
| `build_info() -> String` | 2 | Bundle identification |
| `hash32(&[u8]) -> u32` | 2 | Deterministic AC packet checksum (smoke) |
| `session_smoke_test_packet_sequence() -> u32` | 2 | `Session::new_test` runs on wasm32 |
| `try_ws_handshake_smoke(bridge_url, ip, port) -> Promise<u32>` | 2 §8.2 | WsTransport ↔ Session wiring (browser-only validation needs live bridge) |
| `try_http_resource_source_smoke(url, ns, id) -> Promise<u32>` | 2 §8.4 | HttpResourceSource end-to-end (smoke) |
| `fetch_landblock_heightmap(url, cell_id) -> Promise<LandblockMesh>` | 3 step 1 | Single-landblock terrain mesh (one-line wrapper around the plural form) |
| `fetch_landblock_heightmaps(url, cell_ids) -> Promise<Vec<LandblockMesh>>` | 3 step 2 | Batch terrain meshes + per-vertex `terrainCodes` + `roadCodes` — one HBA open per call |
| `fetch_terrain_textures(url) -> Promise<Vec<TerrainTexture>>` | 3 step 3.5 | All 33 retail terrain textures decoded to RGBA8 (Palette + SurfaceTexture + Texture chain) |
| `fetch_landblock_objects(url, cell_ids) -> Promise<Vec<ObjectPlacement>>` | 3 step 4 | LandblockInfo Stab + BuildInfo lists — `(model_id, x, y, z, rotation_z)` per placement |
| `fetch_object_colours(url, model_ids) -> Promise<Vec<u32>>` | 3 step 4.5 | Per-model representative ARGB from each model's GfxObj/SetupModel → Surface chain (textured-mean walk + DXT decode) |
| `fetch_model_mesh(url, model_id) -> Promise<ModelMesh>` | 3 step 6 | Single-model triangulation (positions, uvs, normals, surfaceIndices, surfaces, bbox, worldBounds) |
| `fetch_model_meshes(url, model_ids) -> Promise<Vec<ModelMesh>>` | 3 step 6 | Batch model triangulation — one HBA open per call |
| `fetch_surface_pixels(url, surface_did) -> Promise<SurfacePixels>` | 3 step 6 | Single surface decoded to RGBA8 (Surface → SurfaceTexture → Texture chain). Solid-colour surfaces synthesize a 1×1 ARGB tile. |
| `fetch_surfaces_pixels(url, surface_dids) -> Promise<Vec<SurfacePixels>>` | 3 step 6 | Batch surface decode — feeds the in-browser per-poly rasterizer |
| `start_session(bridge_url, ip, port, username, password) -> Promise<SessionHandle>` | 4 step 1 (planned) | Drive AC login → CharacterList through wasm + WS bridge |
| `SessionHandle.poll_events() -> Vec<ClientEvent>` | 4 step 1 (planned) | Pull-style event drain — JS calls per animation frame |
| `SessionHandle.character_list() -> Vec<CharacterSummary>` | 4 step 1 (planned) | Account's characters once login resolves |

---

*Maintainers: when you change one of the decisions in §4, update §8 and §9 in
the same change. The as-built status of §5.2 and §7.1-7.4 lives inline in
those sections; the step-by-step record for Phase 2 lives in
`phase-2-wasm-spike.md`, Phase 3 in `phase-3-renderer.md`, Phase 4 will
land its own `phase-4.md` once step 1 lands. This file is the long-lived
design intent; the spike + renderer docs are the short-lived as-built
records, and the per-step handoff briefs at `phase-{N}-step-{M}-handoff.md`
are the per-step framing briefs (deletable once their step is closed and
captured in the as-built doc).*
