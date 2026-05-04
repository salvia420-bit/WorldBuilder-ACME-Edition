# Phase 3 Step 1 — Handoff Brief

> Use this prompt to brief the next agent (or a returning human) picking
> up Phase 3 of `emit-dynamic-site`. Step 1 is **render a single
> Asheron's Call landblock terrain in the browser via PixiJS, fed by
> the §8-step-4 `HttpResourceSource`** — the smallest visible artefact
> that proves the wasm bundle, the HTTP fetcher, and a real WebGL
> renderer all line up end-to-end.
>
> Structure: **Context → Intent → Objectives → Why → Specs.**
> Read in order. Don't start coding before you've finished §Why.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to run an
Asheron's Call client in the browser, top-down view, against a live ACE
server. The end-state is a tab in a browser that talks to ACE through a
WebSocket bridge and renders the live world. Holtburger (a vendored
Rust AC client at `external/holtburger/`) has been ported to
`wasm32-unknown-unknown` to reach this end-state.

### Where the project is right now (as of `5b6fefd`, 2026-05-04)

| Phase | What landed | Commit(s) |
|---|---|---|
| Groundwork | License, design doc, hard-fork of holtburger, decision log | `4987c59` |
| Phase 1 | `holtburger-wsbridge` (WS↔UDP) + `holtburger-wsshim`; 21 tests; full `cli ↔ shim ↔ bridge ↔ echo` round-trip | `d00770a`, `0945b7f` |
| Phase 2 opener | `Session::new_with_transport` seam, RC4→ISAAC doc fix, wasm32 inventory | `f3d9a1c` |
| Phase 2 floor | All 7 library crates cross-compile to wasm32 | `50003ae`..`868c3ac` |
| §8 step 1 | `wasm-pack` picked; `apps/holtburger-web` cdylib bundle | `3025834` |
| §8 step 3 | `web_time::Instant` swap | `d23f5d3` |
| §8 step 2 | `crates/holtburger-transport-ws` (WsTransport over `web_sys::WebSocket`) | `e151003`, `2364277` |
| §8 step 4 | **`HbaReader<R = File>` generic refactor + `crates/holtburger-resource-http` (HttpResourceSource over `fetch()`)** | `b4da651`, `ac7f92d`, `5b6fefd` |

**Working tree:** clean. **Branch:** `master`, pushed to `origin/master`.
**Native invariant:** `cargo test --workspace --lib` is **1086 passed
/ 0 failed** across 13 crates and is the merge-gate at every commit
boundary. **Smoke test:** `apps/holtburger-web/smoke_test.cjs` is at
**8/8 PASS**, including end-to-end HTTP round-trip
(`http.createServer` → wasm `fetch()` → HBA parse → key lookup → 5876
bytes for `eor/portal:0x0E000004`).

### What's already in place, end-to-end-verified, in the wasm bundle

- **WS transport.** `holtburger_transport_ws::WsTransport::connect(url,
  ip)` opens a real `web_sys::WebSocket`, plugs into
  `Session::new_with_transport`, and gives the bundle a working
  `Box<dyn Transport>` (verified compile-time + symbol-presence; live
  bridge round-trip deferred to browser-side validation).
- **HTTP resource source.** `holtburger_resource_http::HttpResourceSource::connect(url)`
  fetches an HBA via global `fetch()`, parses it with
  `HbaReader::<Vec<u8>>::from_bytes`, and serves the existing
  synchronous `holtburger_dat::ResourceSource` trait from in-memory
  state. End-to-end-verified by Node smoke check #8.
- **Session construction.** `Session::new_test()` runs in the wasm
  bundle (verified by `session_smoke_test_packet_sequence`).

### What's NOT in place yet

- **Renderer.** Zero rendering code exists. `apps/holtburger-web` is
  a smoke-test bundle; its `index.html` shows OK/FAIL text checks,
  not pixels. There is no PixiJS, no canvas, no scene graph.
- **Cell-namespace data in the dev fixture.** `dats/assets.hba` was
  materialized with `dat2hba --profile micro` against `eor/portal=...`
  and `eor/cell=...`, but the `micro` profile excluded all `eor/cell`
  entries (`dat-tool meta dats/assets.hba` shows only
  `eor/portal -> 5 entries`, `holtburger/core -> 1 entries`). You'll
  need to regenerate the fixture with a profile that includes at
  least one landblock — see §Specs for the exact command.
- **Live session integration.** Phase 3's design-doc framing assumes
  a logged-in session feeding `ClientViewEvent`s. **This step does NOT
  take that on.** Step 1 renders a hardcoded landblock fetched
  directly from the static HBA. Live-session-driven dynamic rendering
  is step 2 of Phase 3.

### What's left in §8 (the spike doc's priority list)

| Step | Status | Owner / blocker |
|---|---|---|
| 1. Build pipeline (wasm-pack) | ✅ done (`3025834`) | — |
| 2. WsTransport | ✅ done (`e151003`) | — |
| 3. `web_time::Instant` swap | ✅ done (`d23f5d3`) | — |
| 4. HttpResourceSource + DAT shard format | ✅ done (`ac7f92d`) | — |
| 5. Scripting "exclude from WASM" interface | open, **deferred** | spike doc says "longer for actual JS-side handler implementation, which can be deferred until a script-driven feature actually needs the browser" |
| 6. Renderer wiring | **▶ this brief is the first slice (Phase 3 step 1)** | — |

Step 5 is intentionally skipped. The spike doc explicitly authorizes
deferral until a script-driven feature surfaces a need; rendering a
landblock does not, so step 5 stays open and step 1 of Phase 3 starts
now. If you find a script-driven dependency mid-task, escalate rather
than expand scope.

The spike doc at `docs/phase-2-wasm-spike.md` is the authoritative
reference for what cross-compiles, what doesn't, and what the as-built
§8 entries look like. The Phase 2 §8 step 4 handoff at
`docs/phase-2-step-4-handoff.md` is the format template for *this*
brief.

---

## Intent

You are landing the **first visible pixel** of in-world Asheron's Call
content in the browser. Today, the bundle can fetch an HBA over HTTP
and read bytes out of it; nothing draws those bytes anywhere. Step 1
of Phase 3 closes that gap by rendering one landblock's terrain
heightmap as a PixiJS-driven triangle grid.

What "done" looks like at the end of this step:

1. Open `index.html` in a browser.
2. The page fetches `dats/assets.hba` via the existing
   `try_http_resource_source_smoke` machinery (or a dedicated new
   export), looks up a hardcoded landblock cell ID in `eor/cell`,
   parses it into a `CellLandblock` (the existing
   `holtburger_dat::landblock::CellLandblock::unpack` works), and
   feeds the 9×9 height grid into a PixiJS `Mesh` that draws a
   coloured 81-triangle terrain patch on a `<canvas>`.
3. Color ramps by elevation so the terrain reads as a recognizable
   contour, not a flat blob.
4. The whole loop — fetch, parse, render — runs in any modern browser
   without devtools open. A screenshot of the rendered landblock is
   the deliverable artefact.

What this step deliberately does NOT do:

- No live ACE session. No `WsTransport` invocation. The bundle stays
  static-asset-only for this step.
- No interactivity. No pan/zoom, no input, no animation.
- No multi-landblock world. One landblock, hardcoded ID.
- No entities, no sprites, no DOM panels. Terrain only.
- No texturing. The 256-tile terrain palette comes later; for now,
  height-based color ramp is enough to prove the geometry.

This is the smallest possible Phase 3 vertical slice: **proves the
PixiJS scene graph integrates with the wasm bundle, the terrain DAT
parser produces sensible numbers, and the coordinate system math
works.** Everything else in Phase 3 (entities, sprites, panning,
live-session feed) builds on this foundation.

---

## Objectives

In rough dependency order. Each objective ships its own commit; do not
batch.

1. **Regenerate the dev fixture to include cell content.** The current
   `dats/assets.hba` has zero `eor/cell` entries because
   `--profile micro` strips them. Regenerate with a profile that
   includes at least one landblock cell record (`pruned` or `full`).
   Land a `dats/README.md` update or a build-script pointer that
   makes the regeneration command obvious. Target: pick a known
   well-populated landblock (Holtburg town centre is `0xA9B40000`
   per the static-site-emitter convention) and confirm both the
   `0xA9B40000` cell-info record and the `0xA9B4FFFE` landblock-info
   record are reachable through the `HbaReader` in `dats/assets.hba`
   via `dat-tool list dats/assets.hba | grep -i a9b4`. **Do not commit
   the regenerated `dats/assets.hba`** — it stays git-ignored.

2. **Add the PixiJS dependency to `apps/holtburger-web`.** Two paths:
   load PixiJS from a CDN in `index.html` (zero build-step changes;
   PixiJS becomes a `window.PIXI` global the wasm bundle calls into
   via `wasm-bindgen`), or bundle it via `npm` + a JS bundler
   (esbuild, Rollup, Vite). **Recommended: CDN.** The `apps/holtburger-web`
   crate has no JS-side build pipeline today; introducing one is
   scope creep this step doesn't earn. The ESM build of PixiJS
   (`https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.mjs` or
   equivalent) is one `<script type="module">` away. Document the
   pinned version in `index.html` and `apps/holtburger-web/README.md`
   so the choice is reproducible.

3. **Add a wasm-bindgen export that drives the render.** Either:
   - **(a)** A new `try_render_landblock_smoke(canvas_id, asset_url,
     landblock_id) -> Promise<()>` export that owns the entire loop
     (fetch HBA → parse cell → compute mesh vertices → call PixiJS
     via `wasm-bindgen` JS interop), OR
   - **(b)** A pair of exports: `fetch_landblock_heightmap(asset_url,
     landblock_id) -> Promise<Uint8Array>` (returns the 81-byte raw
     height grid) plus a JS-side `renderLandblock(canvas_id, heights)`
     in `index.html` that turns it into PixiJS mesh calls.
   **Recommended: (b).** The Rust side stays focused on parsing what
   it already knows how to parse; PixiJS API calls live in JS where
   they're idiomatic. The handoff between Rust and JS is a single
   typed array. `wasm-bindgen` interop overhead vanishes compared to
   the per-frame draw cost (which is zero in this step — single
   draw, no animation).

4. **Render the heightmap as a triangle grid.** The 9×9 vertex
   layout is documented at
   `crates/holtburger-dat/src/landblock.rs:48-76`:
   ```rust
   pub struct CellLandblock {
       pub id: u32,
       pub has_objects: u32,
       #[br(count = 81)] pub terrain: Vec<u16>,  // tile types — ignore for step 1
       #[br(count = 81)] pub height: Vec<u8>,    // 9×9 grid of u8 elevations
       ...
   }
   impl CellLandblock {
       pub fn get_height(&self, x: usize, y: usize) -> f32 {
           self.height[x * 9 + y] as f32 * 2.0  // multiply by 2.0 = AC convention
       }
   }
   ```
   That gives 81 vertices arranged as a 9×9 grid. Each grid cell
   becomes 2 triangles (128 triangles total per landblock). PixiJS
   `Mesh` with `MeshGeometry` accepts a `positions: Float32Array`
   (3D vertex coords), `indices: Uint16Array` (triangle vertex
   indices), and either a fragment colour or a texture. Use
   per-vertex colour ramped from elevation min→max; pass it via the
   shader uniform path (PixiJS's `MeshMaterial` supports custom
   shaders).

5. **Wire it into `index.html` and update the smoke test.** The
   existing `index.html` runs the same checks as `smoke_test.cjs`
   plus shows OK/FAIL text. Extend it with a `<canvas>` element
   below the text checks; the new render export draws into it once
   `init()` resolves. The Node smoke test (`smoke_test.cjs`) gets a
   9th check: symbol-presence for whichever new export(s) you add.
   Round-trip rendering itself is browser-only (Node has no canvas);
   that's fine — a Node-side bytes-only check that the heightmap
   has 81 entries and a sane elevation range is the deterministic
   floor.

6. **Native invariant + workspace check.** `cargo test --workspace
   --lib` must remain ≥1086/0 at every commit boundary. `cargo check
   --target wasm32-unknown-unknown -p holtburger-{dat,content,world,core,web,resource-http}`
   must remain clean.

7. **Document.** Update `docs/phase-2-wasm-spike.md` (lift the
   §8 step 6 mention into a "Phase 3 step 1 landed" note in the
   status block at the top), and create a new
   `docs/phase-3-renderer.md` (or extend the existing
   `docs/emit-dynamic-site.md` §4.2 PixiJS section) with the as-built
   notes: which PixiJS version, where the mesh code lives, what the
   coordinate convention is, what the next renderer step
   (entities? pan/zoom? texture atlas?) should pick up.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why is rendering the right next step?** Because the bundle has
  bytes it cannot show, and a session it cannot connect to a real
  ACE (the live-bridge ACE backend is still blocked on three MySQL
  DBs + DAT files for ACE). Step 1 of Phase 3 doesn't need the live
  backend — it only needs `HttpResourceSource`, which works today.
  This unlocks visible progress without unblocking ACE first.

- **Why one landblock and not the whole world?** Because a 256×256
  landblock grid is hundreds of MB of cell data, and the renderer
  scaffolding is what's actually unknown. One landblock proves the
  pipeline; multi-landblock streaming is an optimization on a working
  system. Picking a known, populated landblock (Holtburg) means the
  rendered result is visually checkable against existing static-site
  outputs — anyone reviewing the screenshot can confirm "yes, that's
  the Holtburg terrain."

- **Why CDN PixiJS instead of bundling?** Because every JS bundler
  introduced into `apps/holtburger-web` becomes maintenance load
  forever. The bundle has zero JS today; adding esbuild or Vite for
  one library is the wrong shape. CDN script imports work in every
  modern browser, take one line in `index.html`, and pin to a
  specific version through the URL itself. When Phase 3 grows
  enough JS to need a bundler, that's the right time to introduce
  one — not before.

- **Why split parsing (Rust) from drawing (JS)?** Because PixiJS is
  a JS-native API and `wasm-bindgen` interop has a per-call cost
  that adds up over hundreds of mesh calls. The single
  `Float32Array` handoff is exactly one wasm-bindgen boundary cross
  per landblock. Future work that animates entities will follow the
  same pattern: Rust computes the entity buffer (id, x, y, rot per
  entity), JS reads it once per frame and tells PixiJS what to draw.
  Doing PixiJS calls from Rust now teaches the wrong pattern.

- **Why height-ramp colour and not the actual texture atlas?** Because
  the AC terrain palette is 32 textured tile types resolved against
  a 256-entry surface table, and threading that into PixiJS as a
  texture atlas is a separate (significant) piece of work. Height
  ramp is one shader uniform and proves the mesh geometry independent
  of texture pipeline questions. Texture atlas is the obvious next
  Phase-3 step but doesn't gate this one.

- **Why no live session, no entities, no input?** Because each of
  those introduces independent failure modes. Live session needs the
  ACE backend (blocked). Entities need `ClientViewEvent` plumbing
  through `wasm-bindgen`. Input needs DOM event handlers feeding
  `holtburger-core` commands. Each one is a step on its own. Step 1
  needs to land *one thing* — the renderer scaffold — and prove it
  works. Adding any of the others bundles risk that doesn't need to
  be coupled.

- **Why preserve the native invariant?** Because `holtburger-cli` is
  the upstream's actual client and is in active use; the browser
  port must not regress it. The 1086-test gate has caught real bugs
  already (the workspace tokio split, the `Session::new_with_transport`
  refactor, the `HbaReader<R = File>` generic refactor, the §8 step 3
  Instant leftover). Keep it green at every commit and the
  regressions stay small.

---

## Specs

### Read these files first (in order)

1. `docs/phase-2-wasm-spike.md` — full per-crate cross-compile matrix
   (§3), as-built fix history including the just-landed §8 step 4
   entry. The "Phase 2 §8 in-scope work closed" status banner at the
   top is the most current ground-truth.
2. `docs/emit-dynamic-site.md` — the design doc; §4.2 (PixiJS choice)
   and §3.1 (porting strategy) are the highest-signal sections.
3. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches this brief.
4. `~/.claude/projects/-home-wbterminal/memory/feedback_test_fixtures_real_data.md`
   — the user's preference for real `~/ac_base_dats/` over synthetic
   test fixtures. Applies to everything that needs DAT bytes.
5. `external/holtburger/crates/holtburger-dat/src/landblock.rs:1-103`
   — `CellLandblock` and `LandblockInfo` parsers. `CellLandblock`
   is what you'll call `unpack` on; the 9×9 height grid plus
   `get_height(x, y) -> f32` (the `* 2.0` is the AC convention) is
   the core of the rendering.
6. `external/holtburger/crates/holtburger-resource-http/src/source.rs`
   — `HttpResourceSource` you're consuming. Note the three-path
   `fetch` resolution (Window / WorkerGlobalScope / `globalThis`-via-
   `Reflect`). For a browser-only render, only the Window path
   matters.
7. `external/holtburger/apps/holtburger-web/src/lib.rs` — the wasm
   bundle's existing exports. The `try_http_resource_source_smoke`
   export from §8 step 4 is the precedent for the pattern your new
   render export will follow.
8. `external/holtburger/apps/holtburger-web/index.html` — what's
   already there for browser-side validation. You'll extend this
   file directly.

### Hardcoded landblock pick (recommended)

**Holtburg town centre — landblock id `0xA9B4`** (cell ids
`0xA9B40000`–`0xA9B40FFE` for cells, `0xA9B4FFFE` for
`LandblockInfo`).

- Why Holtburg: it's the project's namesake and matches the existing
  static-site-emitter "Holtburg test landblock" convention; the
  rendered patch will be visually recognizable from existing
  WorldBuilder screenshots.
- Why this id range: AC landblock ids are `XXYY0000` where `XX` is
  east-west and `YY` is north-south within the world grid. The
  per-cell records are stored at `XXYY00CC` where `CC` is
  `((x_in_landblock * 8) + y_in_landblock)`; the
  `LandblockInfo` (object placements) is at `XXYYFFFE`. For step 1
  you only need one cell record (any `0xA9B400CC`) to render its
  9×9 height grid. Multi-cell rendering is a follow-up.

If `0xA9B4` is not in the regenerated `dats/assets.hba` for some
reason (the profile filtered it), pick any cell id present in the
`eor/cell` namespace and document the choice. The point is
deterministic, not specifically Holtburg.

### Coordinate system

- Each cell spans 24 metres × 24 metres in world units.
- The 9×9 vertex grid means vertices are 3 metres apart in each axis.
- Heights are `u8` × 2.0 = 0–510 metres (AC's vertical range).
- World-unit → screen-pixel transform is a linear map; PixiJS
  `Container.scale.set(scale)` handles it. Pick a scale that makes
  one landblock fit in a ~512×512 canvas (so 24m → ~512px → scale
  factor ~21px/metre).
- Y axis convention: AC's world-y increases northward; PixiJS canvas
  y increases downward. Flip sign at the container level
  (`container.scale.y = -scale`) once and forget.

### Mesh generation (sketch)

```rust
// Pseudocode in your new export
let bytes = source.get_file_by_key(ResourceKey::new("eor/cell", cell_id))?;
let cell = CellLandblock::unpack(&bytes)?;

// 81 vertices, 3 floats each: x, y, height
let mut positions = Vec::with_capacity(81 * 3);
for x in 0..9 {
    for y in 0..9 {
        positions.push(x as f32 * 3.0);     // metres east
        positions.push(y as f32 * 3.0);     // metres north
        positions.push(cell.get_height(x, y));
    }
}

// 64 quads × 2 triangles × 3 indices = 384 indices
let mut indices = Vec::with_capacity(64 * 6);
for x in 0..8 {
    for y in 0..8 {
        let v00 = (x * 9 + y) as u16;
        let v10 = (x * 9 + y + 1) as u16;
        let v01 = ((x + 1) * 9 + y) as u16;
        let v11 = ((x + 1) * 9 + y + 1) as u16;
        indices.extend_from_slice(&[v00, v10, v11,  v00, v11, v01]);
    }
}
```

Hand `positions` and `indices` to JS as two `Float32Array` /
`Uint16Array` returns; JS instantiates `new PIXI.MeshGeometry()` and
constructs the `Mesh` with a height-ramp shader. PixiJS 8 docs:
<https://pixijs.com/8.x/guides/components/scene-objects/mesh>.

### Fixture regeneration

The current `dats/assets.hba` has no `eor/cell` entries. Regenerate
with a profile that keeps cell data:

```bash
cd external/holtburger
cargo run --release -p holtburger-tools --bin dat2hba -- \
    --profile pruned \
    eor/portal=$HOME/ac_base_dats/client_portal.dat \
    eor/cell=$HOME/ac_base_dats/client_cell_1.dat \
    dats/assets.hba
```

`pruned` is the right call (small but keeps the cell namespace);
`full` produces a multi-GB bundle. Confirm the cell namespace is
present:

```bash
./target/release/dat-tool meta dats/assets.hba   # should show eor/cell with N entries
./target/release/dat-tool list dats/assets.hba | grep -i a9b4 | head
```

If neither `0xA9B40000` nor any `0xA9B400CC` shows up, run the
materializer with `--profile full` once to confirm the entry
exists in retail (it does), then narrow the profile downward until
you find the smallest one that includes it. **Don't commit
`dats/assets.hba` either way** — it's gitignored.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      must report ≥1086 passed / 0 failed.
- [ ] `cargo check --target wasm32-unknown-unknown` for at least
      `holtburger-dat`, `holtburger-content`, `holtburger-world`,
      `holtburger-core`, `holtburger-web`, `holtburger-resource-http`.
      Each must finish clean.
- [ ] `wasm-pack build --target nodejs` and `--target web` from
      `apps/holtburger-web/` — both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — all 9+
      checks PASS (the Node-side check for the new export is
      symbol-presence + bytes shape; the actual render is browser-only).
- [ ] **Browser screenshot.** Open `index.html` in a real browser
      (Chrome or Firefox), reload, watch a coloured terrain mesh
      appear in the canvas. Capture the screenshot at
      `docs/images/phase-3-step-1-landblock.png` (or wherever the
      project conventionally stores screenshots) and reference it
      from the spike-doc / renderer-doc update.

### Decisions to NOT re-litigate

These have been settled in groundwork or prior steps. Do not re-open
without explicit ask from the user:

- WASM-port over server-side per-player rendering.
- PixiJS / WebGL over Leaflet hybrid for the entity layer (this step
  doesn't touch the basemap question — that's §7.3 in the design doc
  and stays open).
- `wasm-pack` over `trunk` for the build pipeline.
- `[port:u16 BE][bytes]` framing for the WS bridge.
- `ruzstd` for wasm32 zstd decompression (native keeps `zstd`).
- `HbaReader<R = File>` generic with `Vec<u8>` for wasm32.
- `HttpResourceSource` is sync pre-load (option b), not async trait.
- HBA-of-HBAs as the shard format.
- AGPL-3.0 license.
- Real `~/ac_base_dats/` dats over synthetic fixtures (per user
  feedback during step 4).

### Decisions still legitimately open after Phase 3 step 1

- Texture atlas pipeline for terrain palette (Phase 3 step 2 or 3).
- Pan/zoom / camera control (Phase 3 step 2 or 3).
- Multi-landblock streaming (Phase 3 step 3 or 4).
- Entity layer wiring from `ClientViewEvent` to PixiJS sprites
  (Phase 3 step 4 or Phase 4 — the design doc puts the
  ClientViewEvent → entity buffer wiring in Phase 4).
- Live ACE session + bridge (still blocked on three MySQL DBs + DAT
  files for ACE).
- Login UX (Phase 5).
- Scripting wasm-bindgen interop API surface — §8 step 5's problem.

### Commit conventions (match prior session)

- `feat(emit-dynamic-site): <subject>` for code that ships the feature.
- `refactor(emit-dynamic-site): <subject>` for trait/cfg-split / API
  reshuffles that enable the feature without shipping it.
- `docs(emit-dynamic-site): <subject>` for spike-doc / renderer-doc
  updates.
- Commit body: section-headed paragraphs explaining **what** + **why**,
  including verification stats (test counts, smoke-check counts) and
  what the change unblocks. See `ac7f92d`, `e151003`, `3025834` for
  format examples.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 3 step 1 landed**" paragraph in the same style
  as the existing "step 4 landed" entry, and bump the
  `MEMORY.md` index line to reflect "Phase 3 starts."

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0` (`cargo install wasm-pack`).
- `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`).
- `node` (≥18 ok for smoke test; the new render export only needs
  symbol-presence on the Node side, so no version bump).
- `python3` (for `python3 -m http.server` when serving the bundle
  + fixture for browser-side validation).
- A real browser (Chrome or Firefox) for the final screenshot.

### What done looks like

- `index.html` opened in a browser shows a coloured 9×9 triangle
  grid in a `<canvas>` element, ramped by elevation, that visually
  matches Holtburg's terrain (or the alternate landblock you picked).
- The 9th smoke check is green; total smoke checks 9+/9+.
- All 1086+ workspace lib tests still pass.
- A screenshot of the rendered landblock is committed to the docs
  tree.
- The next session can either (a) layer texture-atlas rendering on
  top of the height mesh, (b) add pan/zoom controls, (c) extend to
  multi-landblock streaming, or (d) start wiring `ClientViewEvent`
  → PixiJS entity sprites once a live session is reachable. None of
  these blocks the others; pick by user priority.
