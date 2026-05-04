# Phase 3 Step 2 — Handoff Brief

> Use this prompt to brief the next agent picking up Phase 3 of
> `emit-dynamic-site`. Step 2 is **render a 3×3 grid of landblocks
> around Holtburg with mouse-wheel zoom and drag-to-pan**, fixing the
> coordinate-unit error step 1 shipped on the way in. Smallest next
> slice that takes the renderer from "single static heightmap" to
> "explorable terrain neighbourhood" without depending on the texture
> atlas (which is a separate, larger piece of work that becomes step 3).
>
> Structure: **Context → Intent → Objectives → Why → Specs.**
> Read in order. Don't start coding before you've finished §Why.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to run
an Asheron's Call client in the browser, top-down view, against a
live ACE server. Holtburger (a vendored Rust AC client at
`external/holtburger/`) has been ported to `wasm32-unknown-unknown`
and now renders a single landblock heightmap end-to-end.

### Where the project is right now (as of `590fc95`, 2026-05-04)

| Phase | What landed | Commit(s) |
|---|---|---|
| Groundwork | License, design doc, hard-fork of holtburger, decision log | `4987c59` |
| Phase 1 | `holtburger-wsbridge` (WS↔UDP) + `holtburger-wsshim`; 21 tests; full `cli ↔ shim ↔ bridge ↔ echo` round-trip | `d00770a`, `0945b7f` |
| Phase 2 opener | `Session::new_with_transport` seam, RC4→ISAAC doc fix, wasm32 inventory | `f3d9a1c` |
| Phase 2 floor | All 7 library crates cross-compile to wasm32 | `50003ae`..`868c3ac` |
| §8 step 1 | `wasm-pack` picked; `apps/holtburger-web` cdylib bundle | `3025834` |
| §8 step 3 | `web_time::Instant` swap | `d23f5d3` |
| §8 step 2 | `crates/holtburger-transport-ws` (WsTransport over `web_sys::WebSocket`) | `e151003`, `2364277` |
| §8 step 4 | `HbaReader<R = File>` generic + `crates/holtburger-resource-http` (HttpResourceSource over `fetch()`) | `b4da651`, `ac7f92d`, `5b6fefd` |
| **Phase 3 step 1** | **`fetch_landblock_heightmap` wasm export + PixiJS Mesh render of one landblock** | `a5e0a91`, `c4e1538`, `590fc95` |

**Working tree:** clean. **Branch:** `master`, pushed to `origin/master`.
**Native invariant:** `cargo test --workspace --lib` is **1086 passed
/ 0 failed** across 13 crates and is the merge-gate at every commit
boundary. **Smoke test:** `apps/holtburger-web/smoke_test.cjs` is at
**14/14 PASS**, including end-to-end heightmap fetch + parse + shape
checks against the Holtburg `eor/cell:0xA9B4FFFF` `CellLandblock`.

### What's already in place (from step 1)

- **Wasm-bindgen render bridge.** `apps/holtburger-web/src/lib.rs`
  exposes `fetch_landblock_heightmap(asset_url, cell_id)
  -> Promise<LandblockMesh>` and the `LandblockMesh` struct with
  `positions` (Float32Array, 243 floats: 81 verts × 3D), `indices`
  (Uint16Array, 384), `heightMin` / `heightMax`. Crosses the
  wasm-bindgen boundary exactly once per landblock; per-frame work
  stays in JS.
- **PixiJS scaffolding.** `apps/holtburger-web/index.html` imports
  `pixi.js@8.18.1` from jsdelivr via an importmap (no JS bundler).
  Builds a `MeshGeometry` with 2D positions + height-encoded UVs,
  textures it with a 256×1 gradient canvas, overlays a thin black
  Graphics wireframe. `container.scale.set(scale, -scale)` maps world
  units to pixels and flips y so AC north is canvas-up.
- **Browser-side validation path.** Headless screenshot via
  Playwright + Chromium (`--use-gl=swiftshader`) captured at
  `docs/images/phase-3-step-1-landblock.png`. Manual validation in
  real Chrome / Firefox produces identical output.
- **Dev fixture.** `dat2hba --profile pruned` (~230 MB) regenerates
  `dats/assets.hba` with the `eor/cell` namespace. The pruned profile
  is the renderer baseline; `--profile micro` is still fine for the
  §8-step-4 fetch round-trip but excludes everything the renderer
  needs.

### What's NOT in place yet — and the bug step 1 shipped

- **Coordinate-unit error.** Step 1 used `x as f32 * 3.0` for vertex
  spacing, on the framing assumption "each cell is 24 m × 24 m, 9×9
  vertices means 3 m spacing". **This is wrong.** The canonical AC
  constant lives at
  [`crates/holtburger-common/src/position.rs:5`](../external/holtburger/crates/holtburger-common/src/position.rs):
  ```rust
  pub const METERS_PER_LANDBLOCK: f32 = 192.0;
  ```
  with `cell_length = METERS_PER_LANDBLOCK / 8.0 = 24.0` at the same
  file, line 98. So:
  - A landblock is **192 m × 192 m** (NOT 24 m × 24 m).
  - It contains 8×8 = 64 cells; each *cell* is 24 m × 24 m.
  - The 9×9 vertex heightmap covers the whole landblock, so vertices
    are **24 m apart** (NOT 3 m).
  - A `CellLandblock` is the *landblock*-level surface terrain record
    (despite the misleading "Cell" prefix in the type name); it is
    NOT a single cell.

  Step 1 still renders correctly because the PixiJS container scale
  absorbs the unit error: `scale = canvas_size / bounding_box_size`
  works whether the bounding box is 24 m or 192 m. The render is
  geometrically valid, just labelled wrong. Once step 2 puts
  multiple landblocks side-by-side, each offset by its `XX/YY`
  index, the spacing matters. **Fix this on the way in.**
- **Renderer state.** `index.html` calls `renderLandblock` once on
  load and never again. There's no scene-graph state, no camera,
  no input handling, no streaming.
- **Multi-landblock view.** Zero. Step 1 hardcodes one cell id.
- **Pan/zoom.** Zero. The mesh is fixed in canvas coordinates.
- **Texture atlas.** Zero. Colour comes from a height-ramp gradient,
  not the AC terrain palette.
- **Live session integration.** Still blocked on the ACE backend
  (three MySQL DBs + DAT files for ACE). Step 1's framing — "static
  asset only, no live session" — carries over to step 2.

### What's left in §8 + Phase 3 (current priority list)

| Step | Status | Owner / blocker |
|---|---|---|
| §8.1 wasm-pack pipeline | ✅ done (`3025834`) | — |
| §8.2 WsTransport | ✅ done (`e151003`) | — |
| §8.3 web_time::Instant swap | ✅ done (`d23f5d3`) | — |
| §8.4 HttpResourceSource + DAT shard format | ✅ done (`ac7f92d`) | — |
| §8.5 scripting "exclude from WASM" | open, **deferred** | no script-driven feature has surfaced a need |
| §8.6 / Phase 3 step 1 single-landblock render | ✅ done (`a5e0a91`..`590fc95`) | — |
| **Phase 3 step 2** multi-landblock view + pan/zoom | **▶ this brief** | — |
| Phase 3 step 3 (likely) texture-atlas terrain palette | open | — |
| Phase 3 step 4 (likely) `ClientViewEvent` → entity sprites | open | needs live ACE session |

The Phase 3 step 1 renderer doc at
[`docs/phase-3-renderer.md`](phase-3-renderer.md) is the
authoritative as-built reference for what shipped in step 1, plus
its triage of step-2 candidates. The §8 step 4 → Phase 3 step 1
handoff at [`docs/phase-3-step-1-handoff.md`](phase-3-step-1-handoff.md)
is the format template for *this* brief.

---

## Intent

You are turning the renderer from "one static landblock" into "an
explorable terrain neighbourhood you can drag around and zoom into".
Today, opening `index.html` shows a fixed 9×9 heightmap of Holtburg
and that's it. Step 2 closes this gap by:

1. Fetching 9 landblocks (Holtburg + 8 neighbours) and laying them
   out at correct world offsets.
2. Wiring mouse-wheel zoom and drag-to-pan to a camera container so
   the user can navigate the rendered area.
3. Fixing the coordinate-unit error step 1 shipped on the way in,
   so world-offsets are correct.

What "done" looks like at the end of this step:

1. Open `index.html` in a browser.
2. The page fetches `dats/assets.hba` once via the existing
   `HttpResourceSource`, looks up 9 hardcoded landblock cell IDs
   (Holtburg + 8 neighbours), parses each into a `CellLandblock`,
   and feeds each into the PixiJS scene at its world offset
   (`landblock_x * 192 m`, `landblock_y * 192 m`).
3. Mouse wheel zooms in and out; click-and-drag pans. The 9
   landblocks read as a contiguous terrain map, each visibly
   joining its neighbours at the shared edge.
4. The whole loop runs in any modern browser without devtools open.
   A screenshot of the 3×3 grid replaces (or sits alongside) the
   step 1 single-landblock screenshot.

What this step deliberately does NOT do:

- No texture atlas. Colour stays the height-ramp; replacing it is
  step 3.
- No live session, no `WsTransport` invocation. Static asset only.
- No streaming / eviction / LOD. The 9 landblocks load once and
  stay. Going wider needs a real cache, which is a separate problem.
- No entities, no sprites, no DOM panels. Terrain only.
- No keyboard input, no minimap, no inertia. Mouse-wheel + drag is
  enough to prove input integration without growing scope.
- No re-litigation of step 1 decisions (CDN PixiJS, parsing in Rust,
  one wasm-bindgen crossing per landblock). Same scaffolding,
  extended.

This is the smallest possible Phase 3 step 2 vertical slice:
**proves multi-landblock spatial layout, the wasm-side fetch loop
scales to N landblocks, and PixiJS event handling integrates with
the existing scene graph.** Texture atlas (step 3) builds on this
foundation; so does eventual streaming and entity rendering.

---

## Objectives

In rough dependency order. Each objective ships its own commit; do
not batch.

1. **Fix the coordinate-unit error in `fetch_landblock_heightmap`.**
   Replace the `x as f32 * 3.0` / `y as f32 * 3.0` constants in the
   tessellation loop with `x as f32 * 24.0` / `y as f32 * 24.0`
   (vertices are 24 m apart, not 3 m, because the 9×9 grid covers
   the whole 192 m × 192 m landblock — see §Context).

   Update the `LandblockMesh` rust-doc to reflect the correct
   convention. Update the smoke test's corner-vertex check from
   `(0, 0)` and `(24, 24)` to `(0, 0)` and `(192, 192)`. Update
   `docs/phase-3-renderer.md`'s coordinate-convention section
   (currently wrong on the same point) and add a one-line
   correction note linking back to step 1.

   This is a refactor commit by itself — no new features in it. The
   browser render in step 1 was geometrically valid because the
   container scale absorbs the unit; after this commit the JS side
   needs `scale = drawSize / METERS_PER_LANDBLOCK`
   (`drawSize / 192.0`) instead of `drawSize / 24.0`. Bump the JS
   constant in the same commit so the existing single-landblock
   render still works.

2. **Add a wasm-bindgen helper for batch landblock fetches.** Two
   shapes — pick by what fits the API better:
   - **(a)** A new `fetch_landblock_heightmaps(asset_url: String,
     cell_ids: Vec<u32>) -> Promise<Vec<LandblockMesh>>` export that
     opens `HttpResourceSource` once, then loops over the IDs in
     Rust. Saves N-1 fetch + parse passes over the same ~230 MB
     archive.
   - **(b)** Keep `fetch_landblock_heightmap` as the only export
     and call it 9 times from JS, accepting that the bundle re-fetches
     and re-parses the HBA on each call (or wraps `HttpResourceSource`
     in a JS-side cache).

   **Recommended: (a).** Re-fetching ~230 MB of HBA 9 times is
   absurd; a JS-side cache leaks the lifecycle into JS. The
   wasm-bindgen surface for `Vec<LandblockMesh>` is just
   `Box<[JsValue]>` under the hood — `wasm-bindgen` lifts a
   `Vec<T: JsCast>` to a JS array automatically. This also gives
   you a clean place to short-circuit when a cell id is missing
   (e.g. ocean landblocks beyond the world edge): return an empty
   mesh entry or surface a per-id error rather than failing the
   whole batch.

3. **Hardcode the 9-landblock neighbourhood around Holtburg.**
   Holtburg landblock id is `0xA9B4`. Surface terrain is
   `0xA9B4FFFF`. AC's id encoding is `XXYYNNNN` where `XX` is east-west
   (00..FE), `YY` is north-south (00..FE), and `NNNN = FFFF` selects
   the `CellLandblock` (terrain). The 3×3 around Holtburg:

   | Direction | XX | YY | id |
   |---|---|---|---|
   | NW | 0xA8 | 0xB5 | 0xA8B5FFFF |
   | N  | 0xA9 | 0xB5 | 0xA9B5FFFF |
   | NE | 0xAA | 0xB5 | 0xAAB5FFFF |
   | W  | 0xA8 | 0xB4 | 0xA8B4FFFF |
   | C  | 0xA9 | 0xB4 | 0xA9B4FFFF |
   | E  | 0xAA | 0xB4 | 0xAAB4FFFF |
   | SW | 0xA8 | 0xB3 | 0xA8B3FFFF |
   | S  | 0xA9 | 0xB3 | 0xA9B3FFFF |
   | SE | 0xAA | 0xB3 | 0xAAB3FFFF |

   AC convention (verified empirically by the static-site emitter
   work in this repo): +XX is **east**, +YY is **north**. Confirm
   this with one experiment in step 2: if the 3×3 grid renders
   "upside down" (Holtburg's known northward landmarks face the
   wrong way), flip YY's sign. Document whichever assumption holds.

   Verify the neighbours exist in the regenerated `dats/assets.hba`
   before hardcoding all 9: `dat-tool list dats/assets.hba | grep
   -E "eor/cell:A[89A]B[345]FFFF"`. If any are missing (e.g. the
   landblock is empty ocean and the DAT doesn't store it), gracefully
   render a flat placeholder at that offset — don't fail the load.
   Pruned-profile assets typically include all populated landblocks
   but may omit pure-ocean ones.

4. **Lay out landblocks at correct world offsets in PixiJS.** Each
   landblock at `(XX, YY)` goes into a sub-`PIXI.Container` positioned
   at `(XX * METERS_PER_LANDBLOCK, YY * METERS_PER_LANDBLOCK)` in
   the world container's local space — i.e.
   `(XX * 192, YY * 192)` metres. The world container itself sits
   inside a camera container that scales + translates to map world
   metres to canvas pixels.

   Scene-graph layout:
   ```
   app.stage
   └── cameraContainer  (world-units → canvas-pixels mapping)
       └── worldContainer  (one-time AC-axis setup; y-flip lives here)
           ├── landblockContainer[A8B5FFFF]  position (0,   192) world m
           ├── landblockContainer[A9B5FFFF]  position (192, 192)
           ├── landblockContainer[AAB5FFFF]  position (384, 192)
           ├── landblockContainer[A8B4FFFF]  position (0,   0)
           ├── landblockContainer[A9B4FFFF]  position (192, 0)   ← Holtburg
           ├── ...
           └── landblockContainer[AAB3FFFF]  position (384, -192)
   ```
   Holtburg's bottom-left corner sits at `(192, 0)` so the visible
   3×3 grid spans world-x `[0, 576]` and world-y `[-192, 384]`. The
   camera initially centres on Holtburg's centre `(192 + 96, 0 + 96)
   = (288, 96)` at a scale that fits the full grid in the canvas.

   Each landblock's mesh / wireframe pair from step 1 becomes the
   children of its `landblockContainer`. The y-flip
   (`scale.set(s, -s)`) stays at the world-container level; per-landblock
   containers do not flip again.

5. **Add mouse-wheel zoom and drag-to-pan to the camera container.**
   PixiJS 8 input is the v8-revised `eventMode = "static"` API:

   ```js
   app.stage.eventMode = "static";
   app.stage.hitArea = app.screen;

   app.stage.on("wheel", (e) => {
     // e.deltaY > 0 means scroll-down (zoom out)
     const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
     // Zoom around the cursor: keep the world point under the cursor stationary.
     const localBefore = cameraContainer.toLocal({ x: e.global.x, y: e.global.y });
     cameraContainer.scale.x *= factor;
     cameraContainer.scale.y *= factor;  // both, the y-flip is in worldContainer
     const localAfter = cameraContainer.toLocal({ x: e.global.x, y: e.global.y });
     cameraContainer.position.x += (localAfter.x - localBefore.x) * cameraContainer.scale.x;
     cameraContainer.position.y += (localAfter.y - localBefore.y) * cameraContainer.scale.y;
   });

   let dragging = false;
   let lastPointer = null;
   app.stage.on("pointerdown",  (e) => { dragging = true; lastPointer = { x: e.global.x, y: e.global.y }; });
   app.stage.on("pointerup",    () => { dragging = false; lastPointer = null; });
   app.stage.on("pointerleave", () => { dragging = false; lastPointer = null; });
   app.stage.on("pointermove",  (e) => {
     if (!dragging) return;
     cameraContainer.position.x += e.global.x - lastPointer.x;
     cameraContainer.position.y += e.global.y - lastPointer.y;
     lastPointer = { x: e.global.x, y: e.global.y };
   });
   ```

   Clamp zoom to a reasonable range (`scale ∈ [0.05, 5.0]`-ish in
   pixels-per-metre — needs experiment; initial value is roughly
   `canvas.width / (3 * METERS_PER_LANDBLOCK)` to fit the 3×3 grid).
   Don't bother clamping pan; the user can scroll into empty space
   and zoom back out.

   Show the cursor as `grab`/`grabbing` via canvas CSS for affordance.

6. **Update the smoke test for the multi-landblock fetch.** If you
   chose objective 2(a), add 3 more checks:
   - symbol-presence for `fetch_landblock_heightmaps`,
   - calling it with the 9 Holtburg-neighbourhood IDs returns 9
     mesh entries (or 9 results with mixed success/failure if you
     used per-id errors),
   - verifying at least one neighbour mesh has a sane height range
     (the ocean cells south of Holtburg may have heightMin = heightMax
     = some sea-level constant — that's fine; just check it's finite
     and in `[0, 510]`).

   The Node smoke test stays browser-free; per-frame camera math is
   browser-only. Don't try to test pan/zoom in Node — it's the wrong
   tool. Browser screenshot is the deliverable.

7. **Native invariant + workspace check.** `cargo test --workspace
   --lib` must remain ≥1086 / 0. `cargo check --target
   wasm32-unknown-unknown -p holtburger-{dat,content,world,core,web,resource-http}`
   must remain clean. `wasm-pack build --target {nodejs,web}` both
   green.

8. **Document.** Update `docs/phase-3-renderer.md` (lift step 2 out
   of the "What's next" candidates list and into a new
   "Phase 3 step 2 landed" section in the same as-built style as
   step 1's). Capture a new browser screenshot of the 3×3 grid at
   `docs/images/phase-3-step-2-multi-landblock.png` and reference
   it from the renderer doc. Update
   `docs/phase-2-wasm-spike.md`'s status banner to say "Phase 3
   step 2 landed" alongside step 1.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why fix the coordinate-unit error first?** Because step 2 depends
  on landblocks being *exactly* 192 m wide so the offsets in
  objective 4 (`XX * 192`, `YY * 192`) line up against per-landblock
  meshes that internally span `[0, 192]`. If you carry forward
  step 1's "vertices spaced 3 m" convention, neighbouring landblocks
  will have an `8 × (24 − 3) = 168 m` gap between them. Fixing this
  on the way in means objective 4 doesn't need to fight the units.

- **Why batch fetch in Rust (objective 2(a))?** Because the §8-step-4
  `HttpResourceSource` opens with `connect(url)` that fetches and
  parses the entire HBA archive; calling that 9 times means
  re-fetching ~2 GB total just to read 9 different 252-byte records
  out of it. The parse cost is also non-trivial — `HbaReader::from_bytes`
  walks the index. One open, nine lookups, one return value is the
  shape of the data: model the API after the data.

- **Why a 3×3 grid and not a 5×5 or 9×9?** Because 9 landblocks is
  the smallest neighbourhood that proves spatial layout works in
  every direction (N/E/S/W/diagonals) without growing into the
  streaming problem. A 5×5 (25 landblocks) starts to test memory
  pressure and load time; that's a separate concern best addressed
  by a real streaming / cache step rather than slipping it in here.
  A 3×3 also fits comfortably in a 512 px canvas at a useful zoom
  level — wider grids are too zoomed-out to actually see the
  heightmap detail step 1 already proves we can render.

- **Why pan/zoom now and not after texture atlas (step 3)?** Because
  pan/zoom is trivially testable on heightmap geometry alone — you
  see the camera move, that's it — whereas texture atlas needs a
  static, framed view to validate (ramp colours look the same at
  all zoom levels; texture atlas tile size will be sensitive to
  pixel density and filter mode). Better to get input plumbing
  done on simple geometry, then add textures on top of a known-good
  camera.

- **Why mouse-wheel + drag and not keyboard (WASD)?** Because the
  next-most-obvious step after step 2 is "click on terrain to do
  something" (e.g. show the cell ID under the cursor, or eventually
  click-to-walk in step N). Mouse handlers are already on the table
  for that; adding keyboard now duplicates input plumbing without
  unlocking new functionality. Keyboard zoom can be a one-paragraph
  follow-up if a user actually asks.

- **Why no streaming / eviction in step 2?** Because the cache
  shape — keyed by what? evicted when? prefetched on what trigger?
  — is genuinely open and depends on the camera UX, which step 2
  is just establishing. Picking a cache strategy now risks rebuild
  later. Step 2 loads 9 landblocks once into memory (~9 × 252 B
  for the cell records, ~9 × 81 × 8 B = 6 KB for the meshes — call
  it 10 KB total, trivial) and stops. Streaming is a deliberate
  step 4-or-later problem.

- **Why hardcode the 9 cell IDs and not derive them from a
  "landblock around (X, Y)" function?** Because the AC world is
  256×256 landblocks and most are empty ocean; the practical view
  is "a known town's neighbourhood". Hardcoding makes step 2's
  scope unambiguous. A `landblock_neighbourhood(center, radius)`
  helper is correct shape for streaming (objective for step 4-or-later)
  but premature today — same logic as the `eor/cell` profile choice
  in step 1: the smaller, less-flexible shape ships first.

- **Why preserve the native invariant?** Same as before — the
  1086-test gate has caught real bugs at every prior step. Keep it
  green at every commit boundary. Phase 3 step 2 will likely add a
  small number of tests for the coordinate-unit fix (worth doing —
  there's now a constant the code reads from); native test count
  going up by ~2-3 is fine.

---

## Specs

### Read these files first (in order)

1. [`docs/phase-3-renderer.md`](phase-3-renderer.md) — the as-built
   reference for what step 1 shipped. The "What's next" section's
   step-2 candidates triage is the rationale for picking
   "multi-landblock + camera" over "texture atlas" as step 2.
2. [`docs/phase-3-step-1-handoff.md`](phase-3-step-1-handoff.md) —
   the brief that framed step 1; format template for *this* brief.
3. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches this
   brief's status block.
4. [`external/holtburger/crates/holtburger-common/src/position.rs:1-110`](../external/holtburger/crates/holtburger-common/src/position.rs)
   — `METERS_PER_LANDBLOCK = 192.0`, `landblock_coords`,
   `cell_length = METERS_PER_LANDBLOCK / 8.0 = 24.0`. The
   authoritative source for the fix in objective 1.
5. [`external/holtburger/apps/holtburger-web/src/lib.rs`](../external/holtburger/apps/holtburger-web/src/lib.rs)
   — `fetch_landblock_heightmap` and `LandblockMesh`. The tessellation
   loop you'll fix the units in (objective 1) and the export you'll
   plural-ize (objective 2).
6. [`external/holtburger/apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
   — step 1's render path. You'll restructure it: the `renderLandblock`
   function becomes `addLandblockToScene(worldContainer, mesh, x, y)`
   plus a one-shot scene-graph + camera setup at the top.
7. [`external/holtburger/apps/holtburger-web/smoke_test.cjs`](../external/holtburger/apps/holtburger-web/smoke_test.cjs)
   — step 1's 14 checks. Objective 6 adds 3 more.

### The 3×3 around Holtburg (canonical IDs)

The `XX/YY` byte order in `XXYYNNNN` is **big-endian** (XX is the
high byte). Holtburg = `0xA9B4` means `XX = 0xA9 = 169`,
`YY = 0xB4 = 180`. The AC world's origin is the south-west corner
(landblock `0x0000`); +XX moves east, +YY moves north.

```
NW (A8B5)  N (A9B5)  NE (AAB5)
W  (A8B4)  C (A9B4)  E  (AAB4)
SW (A8B3)  S (A9B3)  SE (AAB3)
```

For each, the surface terrain is `XXYYFFFF`. `LandblockInfo` (objects
within the landblock) is at `XXYYFFFE` — out of step 2 scope but
mentioned here for orientation: each `LandblockInfo` references the
1..N populated cells `XXYYNNNN` for `NNNN < FFFE`, which is interior
geometry (dungeons, town buildings) and is a separate rendering pass.

### Coordinate convention (correct version, post-fix)

- `METERS_PER_LANDBLOCK = 192.0` — one landblock side.
- A landblock contains 8×8 = 64 cells; each cell is 24 m × 24 m.
- A landblock has a 9×9 vertex heightmap; vertices are 24 m apart.
- Heights are `u8 × 2.0` so the elevation range is `[0, 510]` metres.
- World axes: `+x` east, `+y` north, `+z` up.
- AC origin is the south-west corner; landblock `(XX, YY)` occupies
  the 192 m × 192 m square `[XX*192, (XX+1)*192] × [YY*192, (YY+1)*192]`.
- Canvas y-flip is at the world container level (`scale.set(s, -s)`)
  so AC north points to canvas-up. Don't double-flip.
- Pixel-per-metre `scale` is the camera container's job.

### Scene graph + camera (sketch)

```js
// One-time setup
const app = new PIXI.Application();
await app.init({ canvas, width: 800, height: 800, antialias: true });

const cameraContainer = new PIXI.Container();
app.stage.addChild(cameraContainer);

const worldContainer = new PIXI.Container();
worldContainer.scale.set(1, -1);  // flip y once; camera scale stays positive
cameraContainer.addChild(worldContainer);

// Initial camera: centre on Holtburg, fit 3×3 grid in the canvas.
const halfWorld = 1.5 * METERS_PER_LANDBLOCK;       // half of 3 landblocks
const initialScale = Math.min(canvas.width, canvas.height) / (2 * halfWorld);
cameraContainer.scale.set(initialScale);
const holtburgCentre = { x: 0xA9 * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
                          y: 0xB4 * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2 };
cameraContainer.position.set(
    canvas.width / 2 - holtburgCentre.x * initialScale,
    canvas.height / 2 + holtburgCentre.y * initialScale  // + because y is flipped
);

// Per-landblock
function addLandblockToScene(mesh, landblockX, landblockY) {
    const lbContainer = new PIXI.Container();
    lbContainer.position.set(
        landblockX * METERS_PER_LANDBLOCK,
        landblockY * METERS_PER_LANDBLOCK
    );
    lbContainer.addChild(buildPixiMesh(mesh));
    lbContainer.addChild(buildWireframe(mesh));
    worldContainer.addChild(lbContainer);
}
```

The `holtburgCentre` calculation uses the absolute world position
(`0xA9 * 192`, `0xB4 * 192`) — that's where Holtburg is in AC's
global coordinate frame. If the rendered area looks "displaced into
the negative octant" because the world container's positive-y axis
exceeded the canvas, double-check the y-sign in `holtburgCentre.y`
and the `+ y * initialScale` term.

### Multi-landblock fetch (option (a) sketch)

```rust
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_landblock_heightmaps(
    asset_url: String,
    cell_ids: Vec<u32>,
) -> Result<Vec<LandblockMesh>, JsValue> {
    use holtburger_dat::landblock::CellLandblock;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut out = Vec::with_capacity(cell_ids.len());
    for &id in &cell_ids {
        let bytes = source
            .get_file_by_key(ResourceKey::new("eor/cell", id))
            .map_err(|e| JsValue::from_str(&format!("get_file_by_key {id:#x}: {e}")))?;
        let cell = CellLandblock::unpack(&bytes)
            .map_err(|e| JsValue::from_str(&format!("CellLandblock::unpack {id:#x}: {e}")))?;
        out.push(build_mesh(&cell));
    }
    Ok(out)
}
```

`build_mesh` is the existing tessellation logic factored out of
`fetch_landblock_heightmap` (which becomes a one-line wrapper that
calls `fetch_landblock_heightmaps` with `vec![cell_id]` and indexes
`[0]`). This keeps both exports in sync without code duplication.

If you'd rather surface per-id failures instead of failing the whole
batch, return `Vec<Result<LandblockMesh, String>>` — wasm-bindgen
will lift it to a JS array of `{ Ok: mesh } | { Err: msg }`-shaped
objects via serde-wasm-bindgen, but that's an extra dep. Simpler
option: continue on `get_file_by_key` errors by pushing a
"sentinel empty mesh" (positions = 81 zeroes, indices = 384 zeroes,
heightMin = heightMax = 0) and let JS detect that shape. Pick one
and document it.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      ≥1086 passed / 0 failed.
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,content,world,core,web,resource-http}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — 17/17 PASS
      after objective 6 lands.
- [ ] **Browser screenshot.** Open `index.html` in a real browser
      (Chrome or Firefox) — or capture via Playwright + Chromium
      with `--use-gl=swiftshader` like step 1 did. Verify:
      - All 9 landblocks visible at initial zoom, contiguous (no
        gaps, no overlaps).
      - Mouse-wheel zooms around the cursor (not just the canvas
        centre).
      - Click-and-drag pans the world.
      - At maximum zoom-in, an individual landblock is still
        recognisable as the step-1 heightmap.
      Save at `docs/images/phase-3-step-2-multi-landblock.png` and
      reference it from the renderer doc update.

### Decisions to NOT re-litigate

These have been settled in groundwork or prior steps. Do not re-open
without explicit ask from the user:

- WASM-port over server-side per-player rendering.
- PixiJS / WebGL over Leaflet hybrid for the entity layer.
- `wasm-pack` over `trunk` for the build pipeline.
- `[port:u16 BE][bytes]` framing for the WS bridge.
- `ruzstd` for wasm32 zstd decompression (native keeps `zstd`).
- `HbaReader<R = File>` generic with `Vec<u8>` for wasm32.
- `HttpResourceSource` is sync pre-load (option b), not async trait.
- HBA-of-HBAs as the shard format.
- AGPL-3.0 license.
- Real `~/ac_base_dats/` dats over synthetic fixtures.
- CDN PixiJS via importmap, no JS bundler.
- Parsing in Rust, drawing in JS — one wasm-bindgen crossing per
  landblock (or per batch of landblocks, with objective 2(a)).
- Texture-mapped colour ramp for terrain shading (height ramp now;
  texture atlas is step 3).
- y-flip at the world-container level, not per-mesh.

### Decisions still legitimately open after Phase 3 step 2

- Texture-atlas pipeline for terrain palette (Phase 3 step 3 — the
  obvious next visual upgrade).
- Multi-landblock streaming with prefetch / eviction (Phase 3 step 4
  or later — gates on having a useful camera UX, which step 2
  establishes).
- Entity layer wiring from `ClientViewEvent` to PixiJS sprites
  (Phase 3 step 5 or Phase 4 — gated on live ACE session).
- LandblockInfo (object placement) rendering — interior cells,
  buildings, dungeon entrances. Phase 3 step 6 or later.
- Whether keyboard input (WASD pan, +/- zoom) ships before or after
  click-on-terrain interactions.
- Live ACE session + bridge (still blocked on three MySQL DBs +
  DAT files for ACE).
- Login UX (Phase 5).
- Scripting wasm-bindgen interop API surface — §8 step 5's problem.

### Commit conventions (match prior session)

- `refactor(emit-dynamic-site): <subject>` for the unit-fix in
  objective 1 and any tessellation refactor that supports
  objective 2.
- `feat(emit-dynamic-site): <subject>` for code that ships the
  feature (the new `fetch_landblock_heightmaps` export, the JS
  multi-landblock loop, the camera).
- `docs(emit-dynamic-site): <subject>` for renderer-doc / spike-doc
  updates and the new screenshot.
- Commit body: section-headed paragraphs explaining **what** +
  **why**, with verification stats (test counts, smoke-check
  counts). See `a5e0a91`, `c4e1538`, `590fc95` for format examples
  from step 1.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 3 step 2 landed**" paragraph in the same style
  as the existing "step 1 landed" entry, and bump the
  `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18.
- `python3` for serving the bundle locally.
- A real browser (Chrome / Firefox) for manual validation, or
  `npx playwright install chromium` (already run during step 1) for
  scripted screenshots. Chromium with `--use-gl=swiftshader` is the
  reliable headless WebGL path on Linux; Firefox headless on Linux
  has WebGL disabled by default.

### What done looks like

- `index.html` opened in a browser shows a 3×3 grid of contiguous,
  height-ramped landblocks centred on Holtburg.
- Mouse-wheel zooms around the cursor; click-drag pans the camera.
  At maximum zoom-in, individual landblocks are still visibly the
  step-1 heightmap shape.
- The 17th smoke check (or whatever count objective 6 brings) is
  green.
- All ≥1086 workspace lib tests still pass.
- A new screenshot at `docs/images/phase-3-step-2-multi-landblock.png`
  is committed; the renderer doc references it.
- The next session can either (a) layer the AC terrain texture atlas
  on top of the height-ramp render (the obvious step 3),
  (b) extend to streaming with prefetch/eviction so the camera can
  roam beyond the 3×3 hardcode, or (c) pick up a non-renderer task
  (e.g. §8 step 5 scripting interop) when a script-driven feature
  surfaces a need. None of these blocks the others; pick by user
  priority.
