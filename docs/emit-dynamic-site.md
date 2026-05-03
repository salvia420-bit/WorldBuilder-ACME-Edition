# emit-dynamic-site — Design

> **Status:** Phase 1 partial — WS↔UDP bridge crate landed (2026-05-03). Live
> ACE round-trip pending the client-side shim. See §8 for the phase ledger.
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
2. **`coordSystem` is asserted at boot** (`app.js:387-412`). Our renderer
   inherits the same constants — `worldExtentWu = 49152`, `tilePx = 256`,
   `lbWu = 192`, `pxPerWuAtZ0 = 256/49152` — and asserts them too. Drift
   becomes a red banner, not a silently-misplaced sprite.

The static-site tile pyramid (z=3..12, four layer sets `terrain/`, `objects/`,
`object/`, `floor/`) becomes the *basemap* for the dynamic site. We do not
re-emit it. We point Leaflet (or whatever 2D tile renderer survives §4.2) at
the same `dist/projects/<slug>/tiles/` URL.

### 3.4 The new layer — UDP↔WS bridge

There is no code for this yet. Recommended shape:

- One process, listens on a WebSocket port (e.g. `:8080/ws`).
- Per WS connection, opens a UDP socket toward ACE on `:9000`, listens on a
  ephemeral port for `:9001` replies.
- One WS binary frame == one AC packet, both directions.
- No knowledge of AC encryption — bytes are passed through. Holtburger's
  session layer does crypto on whichever side it ends up running.
- Stateless w.r.t. game logic; stateful only for the WS↔UDP socket pairing.

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
alternative. To be concrete about the cost — a non-exhaustive checklist:

- [ ] `Cargo.toml`: add a `wasm` feature that disables `tokio = "full"`,
      enables `getrandom = { version = "0.2", features = ["js"] }`, and gates
      the `socket2` dependency.
- [ ] `holtburger-session::Session::new`: split into `new_native(addr)` and
      `new_with_transport(transport)`. `new_native` stays UDP-only.
- [ ] Implement `WsTransport: Transport` for browsers — WASM-only target.
      Probably lives in a new crate `holtburger-transport-ws` so native
      consumers don't pull `web-sys` deps.
- [ ] `holtburger-dat`: prove `ResourceSource` is the only path to bytes;
      audit `File::open` references. Make `ResourceSource` async.
- [ ] Implement `HttpResourceSource: ResourceSource` for browsers — uses
      `web-sys::fetch` with `Range:` headers.
- [ ] Audit every `tokio::spawn` for `Send` requirements; WASM has only
      `LocalSet`-style execution.
- [ ] Audit RC4 vs ISAAC (§5.5).
- [ ] Build pipeline: `wasm-pack` or `trunk`. Static bundle plus a small
      JS shim that wires `ClientViewEvent` -> PixiJS state.

Treat the first ten items as an exploratory spike before committing to the
schedule. Several will surface non-obvious dependencies (proc-macros on the
"right" side of compilation, etc.).

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

### 5.5 Encryption: a discrepancy worth chasing

Holtburger's `ARCHITECTURE.md` line 75 says the session crate provides "RC4
stream encryption/decryption". ACE's protocol is documented to use ISAAC, not
RC4. Possible causes:

- Documentation drift: holtburger's docs are stale; the actual code uses
  ISAAC.
- Holtburger has historically targeted retail or a different emulator and
  retains an unused RC4 path.
- AC's wire protocol uses RC4 for one phase (e.g., login) and ISAAC for
  another, and `ARCHITECTURE.md` is naming one of them.

This is a 30-minute investigation in `holtburger-session/src/`. It does not
block design but it absolutely blocks the first time bytes flow.

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

Each is a real fork in the road. Listed in the order they need answers.

### 7.1 WS bridge: external proxy or ACE patch?

**Lean: external proxy.** Validate by writing a 200-line Rust proxy that
echoes UDP↔WS for one ACE session. If it works end-to-end without ISAAC
state confusion, we are done. If session state turns out to be sockaddr-coupled
in some surprising way (Explore agent says not, but the source isn't fully
visible), revisit.

### 7.2 DAT delivery format: per-asset, or pre-sharded HBA?

**Lean: pre-sharded HBA per region/landblock-cluster.** AC's data has natural
spatial locality; serving per-asset means thousands of HTTP requests per
zone. Pre-sharded means a manifest + bundle-per-region. Use holtburger's
`dat2hba` as the build tool; emit one bundle per landblock-region (probably
~100 regions) plus a bootstrap bundle.

### 7.3 Tile basemap: keep Leaflet, or replace?

**Genuinely open.** Leaflet brings pan/zoom/tile-cache/CRS for free; the
static site already uses it well. PixiJS-only buys us one rendering pipeline
but we re-implement pan/zoom and tile loading. There's a third option: replace
Leaflet with `MapLibre GL` (vector tiles, GPU-accelerated, integrates with
WebGL overlays). MapLibre might be the right answer if we ever want tilt or
true 3D — but we explicitly said no 3D in §2.

Spike: try Leaflet basemap + PixiJS overlay first. If pan/zoom event
coordination becomes painful, swap to a unified WebGL approach.

### 7.4 WASM build pipeline: `wasm-pack` or `trunk`?

`trunk` is friendlier for "the whole app is Rust"; `wasm-pack` is friendlier
for "Rust crate consumed by JS". We are the latter (PixiJS is JS). Lean:
`wasm-pack` + a small JS/TS layer that owns the renderer and instantiates
the WASM module. Decide when scaffolding starts.

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

Phase 1 — **WS↔UDP bridge spike.** ~1–2 weeks.
- Standalone Rust binary in `external/holtburger/apps/holtburger-wsbridge/`
  (or a new top-level if cleaner). Listens on WS, pairs each connection to
  a UDP socket toward ACE.
- Proves the proxy is transparent: a *native* holtburger TUI client routed
  through the bridge can log in, walk around, and chat against a real ACE.
- No browser involvement yet. This is the "is the architecture even right"
  test.

**Phase 1 status (2026-05-03):**
- ✅ Bridge crate at `external/holtburger/apps/holtburger-wsbridge/` (registered
  in workspace; AGPL).
- ✅ WS frame protocol: `[port:u16 BE][ac_packet]` — see the crate's
  [`ARCHITECTURE.md`](../external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md)
  for the rationale (login + world multiplex on one WS connection).
- ✅ End-to-end smoke tests with paired UDP echo servers prove WS↔UDP
  forwarding in both directions, with login + world ports.
- ✅ Allowlist guards: only the configured login / world ports are forwarded;
  datagrams from other source IPs/ports are dropped.
- ⏳ Client-side UDP→WS shim (so unmodified `holtburger-cli` can route through
  the bridge) — not landed; documented as a follow-on in the crate's
  ARCHITECTURE.md.
- ⏳ Live-ACE round-trip — blocked on standing up ACE locally (requires three
  MySQL DBs + AC client DAT files; see Explore-agent notes from the
  groundwork pass).

Phase 2 — **WASM port spike.** ~3–4 weeks.
- `holtburger-session` cfg-gates UDP-native code; adds `Session::new_with_transport`.
- New crate `holtburger-transport-ws` with `WsTransport: Transport`,
  WASM-only.
- `holtburger-dat::ResourceSource` becomes async.
- New `HttpResourceSource` impl, browser-only.
- `wasm-pack`-built bundle that, headlessly, can complete the AC handshake
  against ACE through the bridge from §Phase 1, surfacing a `ClientViewEvent`
  stream into JS console logs.
- This is the deepest-risk phase. If WASM porting unblocks at acceptable
  cost, the rest is product work.

Phase 3 — **Renderer scaffold.** ~2–3 weeks, parallelizable with late Phase 2.
- PixiJS scene graph: tile basemap (Leaflet for now, see §7.3), entity
  overlay layer, sprite-atlas reuse from emit-static-site.
- Coordinate-system assertion against `coordSystem` block, mirrored from
  emit-static-site's pattern.
- Deck-out the existing emit-static-site `dist/` so it can be served as
  *either* the static site (no `?live=1`) or the dynamic site (with
  `?live=1`); reuse 95% of the existing assets.

Phase 4 — **Wiring.** ~2 weeks.
- Connect WASM holtburger's `ClientViewEvent` stream to the PixiJS entity
  buffer.
- DOM panels for chat, vitals, inventory — surfaces holtburger already
  drives.
- Input: WASD + click-to-target, fed back as movement commands through
  holtburger-core's existing input surface.

Phase 5 — **Hardening.** Indefinite.
- DAT-over-HTTP shard layout (§7.2).
- IndexedDB asset caching.
- Login flow UX (§7.5).
- Performance: 100 concurrent entities, 1000, 5000.
- Multi-project / multi-world picker.

Each phase ends with a working artifact. We do not start the next phase until
the current one demonstrably works against ACE.

## 9. Reference index

File:line citations from the groundwork exploration, kept here so future work
can jump directly without re-discovering them.

| What | Where |
|---|---|
| `Transport` trait definition | `external/holtburger/crates/holtburger-session/src/session/types.rs:17-21` |
| `Session.transport` field | `external/holtburger/crates/holtburger-session/src/session/types.rs:90` |
| Hardcoded `UdpSocket::bind` (the patch site) | `external/holtburger/crates/holtburger-session/src/session/api.rs:9-11` |
| Fragment reassembly (assumes whole-packet recv) | `external/holtburger/crates/holtburger-session/src/session/receive.rs:405-423` |
| `ResourceSource` trait | `external/holtburger/crates/holtburger-dat/src/lib.rs:138-148` |
| `ContentRepository::from_mounts` | `external/holtburger/crates/holtburger-content/src/repository.rs:75-80` |
| ClientRuntime asset loading | `external/holtburger/crates/holtburger-core/src/client/builder.rs:54-80` |
| `emit-static-site` orchestrator | `WorldBuilder.Terminal/StaticSiteEmitter.cs:41-128` |
| `coordSystem` emission | `WorldBuilder.Terminal/StaticSiteEmitter.cs:741-746` |
| `coordSystem` boot assertion | (emitted) `app.js:387-412` |
| Forward-compat live overlay hook | (emitted) `app.js:85-90` |
| Tile pyramid emitter | `WorldBuilder.Terminal/TilePyramidEmitter.cs:54-91, 101-134` |
| ACE network port config | `external/ACE/Source/ACE.Server/Config.js.example:5-26` |
| ACE socket initialization | `external/ACE/Source/ACE.Server/Program.cs:311-312` |
| ACE game-logic seam (`Session.Network.EnqueueSend`) | `external/ACE/Source/ACE.Server/WorldObjects/Player.cs:43, 114-117` |

---

*Maintainers: when you change one of the decisions in §4, update §8 and §9 in
the same change.*
