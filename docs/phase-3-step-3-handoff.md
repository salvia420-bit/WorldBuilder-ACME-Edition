# Phase 3 Step 3 — Handoff Brief

> Use this prompt to brief the next agent picking up Phase 3 of
> `emit-dynamic-site`. Step 3 is **replace the height-ramp colour
> with the AC 32-terrain-type texture atlas, sampled per-fragment by
> a custom PixiJS shader using a per-vertex terrain code threaded
> through `LandblockMesh`**. This is the biggest single visual jump
> toward static-site fidelity; everything geometry + camera that
> step 2 shipped now needs *recognisable AC terrain* on top.
>
> Structure: **Context → Intent → Objectives → Why → Specs.**
> Read in order. Don't start coding before you've finished §Why.
> The "Decisions to NOT re-litigate" section in §Specs lists
> commitments that were made in steps 1-2 and §4.5 of the design
> doc — do not reopen them without explicit ask.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to
run an Asheron's Call client in the browser, top-down view, against
a live ACE server. As of 2026-05-04 the renderer can fetch a 3×3
landblock neighbourhood around Holtburg and PixiJS draws the heightmap
geometry on a `<canvas>` with mouse-wheel zoom + drag-to-pan. The
colour today is a **height-ramp gradient** (deep blue → green → tan
→ white, normalised against aggregate min/max across the 9 landblocks).
Step 3 replaces that height-ramp with **actual AC terrain**:
recognisable grass / sand / dirt / snow / water / etc. composited
per-cell using AC's surface table.

### Where the project is right now (as of `e00175b`, 2026-05-04)

| Phase | What landed | Commit(s) |
|---|---|---|
| Groundwork | License, design doc, hard-fork of holtburger, decision log | `4987c59` |
| Phase 1 | `holtburger-wsbridge` (WS↔UDP) + `holtburger-wsshim`; 21 tests; full `cli ↔ shim ↔ bridge ↔ echo` round-trip | `d00770a`, `0945b7f` |
| Phase 1 follow-on | Live-ACE round-trip closed; cli reaches Selection page through bridge against real ACE | `b082cc9` |
| Phase 2 opener | `Session::new_with_transport` seam, RC4→ISAAC doc fix, wasm32 inventory | `f3d9a1c` |
| Phase 2 floor | All 7 library crates cross-compile to wasm32 | `50003ae`..`868c3ac` |
| §8 step 1 | `wasm-pack` picked; `apps/holtburger-web` cdylib bundle | `3025834` |
| §8 step 3 | `web_time::Instant` swap | `d23f5d3` |
| §8 step 2 | `crates/holtburger-transport-ws` (WsTransport over `web_sys::WebSocket`) | `e151003`, `2364277` |
| §8 step 2 browser | `try_ws_handshake_smoke` ran live in Chromium against bridge → ACE | `e00175b` |
| §8 step 4 | `HbaReader<R = File>` generic + `crates/holtburger-resource-http` | `b4da651`, `ac7f92d`, `5b6fefd` |
| Phase 3 step 1 | `fetch_landblock_heightmap` wasm export + PixiJS Mesh render of one landblock | `a5e0a91`, `c4e1538`, `590fc95` |
| Phase 3 step 2 | 3×3 neighbourhood + pan/zoom camera + 192 m unit-fix | `38afb1c`..`79818ac` |

**Working tree:** clean. **Branch:** `master`, pushed to `origin/master`.
**Native invariant:** `cargo test --workspace --lib` is **1086 passed
/ 0 failed** across 13 crates and is the merge-gate at every commit
boundary. **Smoke test:** `apps/holtburger-web/smoke_test.cjs` is at
**17/17 PASS**. **Browser-side validation:**
- Phase 3 step 2 deliverable at `docs/images/phase-3-step-2-multi-landblock.png`
  shows the 3×3 grid rendering correctly.
- Phase 2 §8 step 2 `try_ws_handshake_smoke` ran live through bridge
  → ACE; harness at `apps/holtburger-web/handshake_smoke.html`.
- ACE local-setup recipe at `docs/ace-local-setup.md` is the
  authoritative "bring ACE up locally" reference.

### What's already in place (from step 2)

- **Two wasm-bindgen export shapes for terrain:**
  - `fetch_landblock_heightmap(asset_url, cell_id) -> Promise<LandblockMesh>` —
    single-landblock convenience wrapper.
  - `fetch_landblock_heightmaps(asset_url, cell_ids: Vec<u32>) -> Promise<Vec<LandblockMesh>>` —
    batch fetch, one HBA open per call. The plural form is what step 2's
    multi-landblock loop calls. Both share `fn build_mesh(&CellLandblock)
    -> LandblockMesh` internally so unit changes land in one place.
- **`LandblockMesh` struct** with four getters: `positions`
  (Float32Array, 243 floats — 81 verts × 3D), `indices`
  (Uint16Array, 384 — 64 quads × 6), `heightMin`, `heightMax`
  (metres). Step 3 will need to add a fifth getter for per-vertex
  terrain codes (see Objectives §1).
- **PixiJS scene graph:** `app.stage → cameraContainer (zoom + pan)
  → worldContainer (one-time AC y-flip) → landblockContainer × 9
  (each at lbX*192, lbY*192 world metres)`. Mouse-wheel zoom around
  cursor (factor 1.1, scale clamped `[0.05, 5.0]`); pointerdown/move/up
  drag-to-pan; CSS toggles `cursor: grab → grabbing` via `.dragging`
  class.
- **Coordinate convention (correct, post step 2's unit-fix):** Rust
  speaks metres, `(x = east, y = north, z = elevation)`. Landblock is
  192 m × 192 m (`holtburger_common::position::METERS_PER_LANDBLOCK
  = 192.0`); 8×8 = 64 cells of 24 m each; 9×9 vertex grid covers the
  whole landblock so vertices are 24 m apart. Heights are `u8 × 2.0`
  → `[0, 510]` m. JS y-flip lives at the world container.
- **Render data flow:** PixiJS `MeshGeometry` built from the wasm
  `LandblockMesh` — `positions` flattened to 2D + per-vertex
  height-encoded UVs (u = (h - hmin) / range, v = 0.5), indexed by
  `Uint32Array.from(mesh.indices)`. Colour comes from a 256×1
  gradient canvas wrapped as `PIXI.Texture.from(canvas)`, sampled by
  the default Mesh `TextureShader` using the height-encoded `u`.
- **Browser-side validation path:** Playwright + Chromium with
  `--use-gl=swiftshader`. Both `index.html` (renderer) and
  `handshake_smoke.html` (Phase 2 step 2 live smoke) work the same way.
  Real Chrome / Firefox manual validation produces identical output.

### What's NOT in place yet — and what step 3 fixes

- **Colour is height, not terrain.** Today's gradient maps elevation
  to colour. AC's actual terrain types — ~32 base textures (grass,
  rolling hills, sand, dirt, road, snow, water variants, lava,
  forest floor, etc.) — are completely ignored. Holtburg looks like
  a topographic map, not a town. **Step 3 wires the surface info
  through and replaces the gradient with the atlas.**
- **No Texture (DatFileType `0x06`) parser.** `holtburger-dat` has
  parsers for many types (skill table, spell table, motion tables,
  setup model, env cell, animation, gfx_obj, char gen, xp table,
  chat pose table, motion kinematics) but **no terrain-texture
  parser yet**. The texture surface IDs are referenced in
  `CellLandblock.terrain[i]`'s u16 packing, but the actual pixel
  data lives in `eor/portal:` records of file-type `0x06` (and
  Surface records `0x08`) that nobody has written a parser for.
  This is the bulk of step 3's work.
- **No custom shader.** The default PixiJS `MeshShader` does
  one-texture-per-mesh. Per-cell texture indexing needs a custom
  GLSL fragment shader.
- **No surface table.** AC has a 256-entry "surface table" in
  `eor/portal:` that maps terrain codes → texture IDs and blend
  parameters. Step 3 must either parse it or hardcode the parts
  that matter.

### What's left in §8 + Phase 3 (current priority list)

| Step | Status | Owner / blocker |
|---|---|---|
| §8.1 wasm-pack pipeline | ✅ done (`3025834`) | — |
| §8.2 WsTransport (compile + symbol) | ✅ done (`e151003`) | — |
| §8.2 WsTransport (live browser run) | ✅ done (`e00175b`) | — |
| §8.3 web_time::Instant swap | ✅ done (`d23f5d3`) | — |
| §8.4 HttpResourceSource + DAT shard format | ✅ done (`ac7f92d`) | — |
| §8.5 scripting "exclude from WASM" | open, **deferred** | no script-driven feature has surfaced a need |
| §8.6 / Phase 3 step 1 single-landblock render | ✅ done (`a5e0a91`..`590fc95`) | — |
| Phase 3 step 2 multi-landblock view + pan/zoom | ✅ done (`38afb1c`..`79818ac`) | — |
| **Phase 3 step 3 terrain texture atlas + custom shader** | **▶ this brief** | — |
| Phase 3 step 4 (likely) sprite-atlas + LandblockInfo objects | open | reuses static-site `projects/<slug>/sprites/atlas.{png,js}` per design doc §4.5 |
| Phase 3 step 5 (likely) road overlays + atmospherics | open | — |
| Phase 4 wiring (`ClientViewEvent` → entity sprites) | open | needs a wasm-side AC handshake export + character/world state surface — gated on §4.5 quality ladder progress and the next entity-rendering pass |

The Phase 3 step 1 + step 2 renderer doc at
[`docs/phase-3-renderer.md`](phase-3-renderer.md) is the authoritative
as-built reference. The §4.5 quality ladder in
[`docs/emit-dynamic-site.md`](emit-dynamic-site.md) lists step 3 as
the **biggest single delta** toward static-site visual fidelity.

---

## Intent

You are turning the renderer from "topographic-map heightmap" into
"recognisable AC terrain". Today, the 3×3 grid around Holtburg
reads as elevation; nothing distinguishes a road from a forest from
a beach. Step 3 closes this gap by:

1. Threading the per-vertex `terrain[81]` u16 codes from
   `CellLandblock` through to the wasm/JS boundary.
2. Building a packed texture atlas (in JS) of AC's terrain
   textures.
3. Writing a custom PixiJS Mesh shader that samples the atlas
   using the per-vertex terrain code + UV interpolation, blending
   smoothly across triangle edges (so adjacent cells with different
   terrain don't look like Minecraft).

What "done" looks like at the end of this step:

1. Open `index.html` in a browser; the 3×3 grid still pans/zooms
   exactly as before.
2. Holtburg's town centre is visibly "town-grass-with-stone-roads",
   not a green-with-tan-peak gradient. The cell that holds the
   building footprint reads recognisably; the surrounding fields
   read as rolling hills / grass; whatever water/coast the
   neighbourhood includes reads as water.
3. At max zoom-in, individual 24 m cells show their textured
   surface (one of ~32 base types). At normal 3×3-fits-canvas zoom,
   the textures blend smoothly enough that landblock seams stay
   invisible (already true for the height ramp; must still be true
   for textures).
4. The full loop runs in any modern browser without devtools open.
   A new browser screenshot at
   `docs/images/phase-3-step-3-textured.png` replaces (or sits
   alongside) the step 2 height-ramp screenshot.
5. Comparing side-by-side with the static-site Holtburg z=12 PNG
   at [`docs/images/DerethMapsEnhanced_zoom.png`](images/DerethMapsEnhanced_zoom.png),
   the live render reads as the same place — colour palette, town
   layout texture cues — even though our render lacks the
   pre-baked sprite-atlas objects (those land in step 4).

What this step deliberately does NOT do:

- **No object/sprite rendering.** Buildings, trees, NPCs, items —
  none. That's step 4's static-site sprite atlas reuse (§4.5).
- **No road overlays as a separate pass.** AC's road-tile types in
  the surface table are part of the 32-ish terrain types and SHOULD
  shade correctly when the atlas is wired through. A dedicated
  road-blending pass (the step 5 polish) is out of scope.
- **No live ACE session integration.** The renderer's data feed
  stays "from static HBA". Live ACE handshake unlocks Phase 4.
- **No streaming / N×N expansion.** Still hardcoded 3×3 around
  Holtburg. Streaming + cache is a step 4-or-later problem.
- **No re-litigation of step 1/2 decisions** (PixiJS, parsing in
  Rust, batch fetch, height-normalised colour math, AC y-flip at
  world container). Same scaffolding, extended.

This is the smallest possible Phase 3 step 3 vertical slice:
**proves the per-vertex terrain code threads through wasm-bindgen,
the AC terrain textures load + pack into a GPU atlas, and a custom
PixiJS shader samples them per-fragment**. Sprite-atlas reuse (step
4) builds on this foundation; so does road-overlay polish (step 5).

---

## Objectives

In rough dependency order. Each objective ships its own commit; do
not batch.

1. **Decode the `CellLandblock.terrain[81]` u16 packing.** Each entry
   in the 81-element terrain vector is a packed u16 with three
   semantic fields. The exact bit layout is in the AC client / ACE
   source — the Phase 3 step 3 agent's first task is to **find and
   document it** so the wasm export can split out the parts the
   renderer needs (terrain type + roads + scenery) versus the parts
   it doesn't (compass-rotation, scenery flags). Search hits to
   start with:
   - `external/ACE/Source/ACE.Server/Physics/Common/CellLandblock.cs`
     and adjacent files in the cloned ACE upstream at `~/ace-server/`.
   - `external/holtburger/crates/holtburger-dat/src/landblock.rs:54`
     where `terrain: Vec<u16>` is declared but not currently
     interpreted.
   - The `dat-tool` binary for spot-printing landblock content
     to confirm the bit interpretation against known landblocks
     (Holtburg `A9B4FFFF` should be predominantly grass/town tiles;
     ocean cells like `0x6B6B FFFF` should be water-only).
   Add helper methods on `CellLandblock` like `pub fn
   terrain_type(&self, x, y) -> u8`, `pub fn road_type(&self, x, y)
   -> u8` so consumers don't have to redo the bit math.

   This is a refactor commit by itself — pure parsing, no new
   features, plus 2-4 unit tests that pin the bit layout against
   real AC fixtures.

2. **Extend `LandblockMesh` with a per-vertex terrain code stream.**
   Add a `terrain_codes: Vec<u8>` field (81 entries, one byte per
   vertex giving the base terrain type after roads / scenery are
   stripped to the most-relevant value the shader will consume).
   Add a `#[wasm_bindgen(getter, js_name = terrainCodes)] pub fn
   terrain_codes(&self) -> Vec<u8>` so JS sees a `Uint8Array(81)`
   alongside `positions`/`indices`/`heightMin`/`heightMax`.

   The encoding choice (just terrain type vs. terrain+road bits
   packed together vs. terrain+road as two separate streams) is the
   load-bearing decision in this objective. Recommendation:
   **return one byte per vertex carrying the dominant terrain type**
   (grass / sand / road / etc.) and defer road overlays to step 5.
   If you find that one byte isn't enough — e.g. you want both
   terrain type AND road bit for the shader's blend logic —
   document the choice in the rust-doc on `LandblockMesh` and use
   `terrain_codes: Vec<u16>` with a `Uint16Array` getter instead.

   Smoke test grows with a check that `terrainCodes` is
   `Uint8Array(81)` and that the centre Holtburg landblock has a
   known mix of types (e.g. ≥5 distinct values, all in `[0, 31]`
   for the 32-type design).

3. **Inventory the 32 (or so) AC terrain types + their texture IDs.**
   AC's surface table is a 256-entry array in `eor/portal:` (look
   for it in `external/ACE/Source/ACE.DatLoader/FileTypes/` or in
   the cloned ACE upstream). Each entry maps a terrain code to a
   texture ID for the four corners (NW/NE/SW/SE) plus blend bias.
   For step 3's first pass, you can simplify: pick the **most
   representative texture** per terrain type and skip the
   four-corner blend logic. List them as a constant in JS:
   ```js
   const TERRAIN_TYPES = [
     { code: 0x00, name: "BarrenRock",     textureId: 0x0600XXXX },
     { code: 0x01, name: "Grasslands",     textureId: 0x0600XXXX },
     // ...
     { code: 0x1F, name: "Snow",           textureId: 0x0600XXXX },
   ];
   ```
   The list of types + texture IDs lives in the AC client; some are
   in ACE's source (search for `LandSurfMaterial`, `TerrainType`,
   `LandSurfaceType`, or `surface_info`). Anything you can't find,
   leave as a TODO with a placeholder colour and revisit in step 5.

4. **Add a wasm-bindgen helper `fetch_terrain_textures(asset_url:
   String, texture_ids: Vec<u32>) -> Promise<Vec<TextureBlob>>`.**
   Where `TextureBlob` is a wasm-bindgen struct exposing
   `width: u32`, `height: u32`, `pixels: Vec<u8>` (RGBA8). This
   needs:
   - A new file_type parser at
     `crates/holtburger-dat/src/file_type/texture.rs` that decodes
     AC's Texture (`0x06`) record format. The format is
     palette-based with a header (width, height, pixel-format,
     palette-id pointing to a Palette `0x04` record). The agent
     will need to write the parser; reference is the AC client
     source (or community decompiles), and ACE has reference
     impls at `external/ACE/Source/ACE.DatLoader/FileTypes/Texture.cs`
     in the cloned upstream.
   - The export opens `HttpResourceSource` once, fetches each
     `eor/portal:texture_id`, decodes via the new parser, and
     returns the RGBA8 bytes.

   The `Vec<u8>` for pixels crosses the wasm-bindgen boundary as a
   `Uint8Array`. JS then stitches them into a packed atlas (next
   objective). This is the heaviest objective by far — budget at
   least half the step's work for the parser alone.

   **Scope reducer** if the parser proves too painful: ship a
   first pass with **32 hardcoded RGBA colours** (one per terrain
   type) instead of real textures. The shader still does the
   per-fragment lookup; the visual is "32-colour terrain" rather
   than "textured AC terrain". This buys time to validate the
   shader pipeline before sinking weeks into the texture parser.
   Document the placeholder explicitly so step 3.5 can be a
   "real textures replace placeholder" follow-up.

5. **JS-side: pack the textures into a single GPU atlas.** PixiJS
   has no built-in atlas packer; either bring in a lightweight one
   (e.g. `@pixi/spritesheet` via the same importmap pattern step 1
   used for `pixi.js`) or write a simple shelf-pack inline (the
   textures are all small — likely 64×64 or 128×128 — so naive
   row-packing into a 1024×1024 canvas is fine). Each terrain type
   gets a (u, v, w, h) entry in a `TERRAIN_ATLAS_REGIONS`
   lookup table keyed by terrain code. Build the atlas as a
   `PIXI.Texture` from an offscreen `<canvas>`.

6. **Write a custom PixiJS Mesh shader.** PixiJS 8 uses WebGL/WGSL
   under the hood; the v8 Mesh API takes a `Shader` you can
   construct from custom GLSL. The fragment shader needs:
   - The packed atlas texture as a uniform sampler.
   - A per-vertex `aTerrainCode: float` attribute (varying as
     `vTerrainCode` to fragment).
   - A per-vertex `aLocalUv: vec2` attribute (the 24 m × 24 m
     cell-local UV — already implicitly in the position data, but
     pass it explicitly).
   - A small `uniform vec4 atlasRegions[N]` array (or texture
     lookup) keyed by terrain code → (u, v, w, h) in atlas units.
   - The fragment computes `atlas_uv = atlasRegions[int(round(
     vTerrainCode))].xy + atlasRegions[...].zw * fract(vLocalUv)`
     and samples.

   **Smoothing across cell boundaries** is the visual quality knob.
   Two approaches:
   - **Hard edges** (simplest): each triangle samples one terrain
     type. Ships fast, looks Minecraft-y at zoom-in. Good enough as
     a first commit.
   - **Soft blend** (better): use `flat` on the terrain code from
     the provoking vertex of each triangle, OR blend two terrain
     types per fragment using a triangle barycentric. PixiJS v8's
     Mesh attribute API supports both.
   
   Recommendation: ship hard-edges first, then add soft blend in a
   follow-up commit if the visual quality needs it.

7. **Wire the new attribute into `buildLandblockChildren` in
   `index.html`.** The MeshGeometry currently has `positions` (2D)
   + `uvs` (height-encoded) + `indices`. Replace the height-encoded
   `uvs` with **cell-local UVs** (each vertex's position within its
   24 m cell, modulo 24 m → [0, 1]) and add a `terrainCodes`
   attribute. The mesh now uses the custom shader instead of the
   default `MeshShader`. The wireframe overlay stays, but its
   stroke alpha may need bumping since textured terrain is busier
   than flat colour.

   The aggregate-min/max height range from step 2 stops being a
   colour input (the shader doesn't read height for shading any
   more) but keep computing it — it's still useful for the
   stage-info panel.

8. **Update the smoke test for the new export + getter.** Three
   new checks (smoke total grows 17 → 20):
   - Symbol-presence for `fetch_terrain_textures`.
   - `LandblockMesh.terrainCodes` is a `Uint8Array(81)`, all values
     in `[0, 31]` for the 32-type design (or `[0, 255]` if you
     widened to u8 with no reserved-bits validation).
   - Calling `fetch_terrain_textures` with the 32-or-fewer canonical
     texture IDs returns an array of `TextureBlob` entries each
     with `width > 0 && height > 0 && pixels.length === width *
     height * 4`. (If you used the placeholder-colour scope
     reducer, instead check that the placeholder array has 32
     entries.)

   Browser-side rendering quality is the deliverable, not a Node
   smoke; per-fragment shader output is impractical to assert from
   Node. Keep that part as the screenshot.

9. **Native invariant + workspace check.** `cargo test --workspace
   --lib` must remain ≥1086 / 0 (probably grows by 2-4 from the
   terrain-bit-decode tests in objective 1 + texture-parser tests in
   objective 4). `cargo check --target wasm32-unknown-unknown -p
   holtburger-{dat,content,world,core,web,resource-http}` must
   remain clean. `wasm-pack build --target {nodejs,web}` both green.

10. **Document.** Update `docs/phase-3-renderer.md` (lift step 3 out
    of the "What's next" candidates list and into a new "Phase 3
    step 3 landed" section in the same as-built style as steps 1+2).
    Capture a new browser screenshot of the textured 3×3 grid at
    `docs/images/phase-3-step-3-textured.png` and reference it from
    the renderer doc. Update `docs/phase-2-wasm-spike.md`'s status
    banner to say "Phase 3 step 3 landed" alongside steps 1+2.
    Update `docs/emit-dynamic-site.md` §4.5's quality ladder table
    to flip the "Texture atlas + surface table" row from `open` to
    `✅ landed`. Bump the auto-memory entry at
    `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why bit-decode `terrain[81]` first (objective 1)?** Because
  every downstream objective depends on it. If you guess the
  bit layout wrong, the shader picks the wrong atlas tile and the
  whole render reads as garbled. Pinning it with unit tests against
  Holtburg + an ocean cell first means the rest of the pipeline
  has a stable contract to build against. The static-site emitter's
  C# code in `WorldBuilder.Shared/` likely already does this decode
  somewhere — start by grepping for `terrain[`, `TerrainType`,
  `surface_info` in `WorldBuilder.Shared/Lib/Terrain/` to find
  the existing reference implementation rather than re-inventing.

- **Why thread the codes through `LandblockMesh` rather than parse
  them client-side (objective 2)?** Because the wasm side already
  has the parsed `CellLandblock` in hand from the existing
  `build_mesh` path, and the wasm-bindgen boundary is already
  crossed exactly once per landblock. Parsing once on the wasm side
  and shipping the `Uint8Array(81)` over with the existing
  positions/indices keeps the boundary cost flat. Re-fetching the
  raw `CellLandblock` in JS to re-decode means a second wasm crossing
  per landblock for no gain.

- **Why a custom shader instead of one mesh per terrain type (objective 6)?**
  Because each landblock has 81 vertices touching potentially many
  terrain types. Splitting into N meshes per landblock means N
  draw calls per landblock × 9 landblocks = up to 9N draw calls per
  frame. A single textured mesh per landblock with a per-vertex
  attribute is one draw call per landblock = 9 total. PixiJS Mesh
  + custom shader is the same primitive count we already use, plus
  one custom GLSL pass.

- **Why JS-side atlas packing instead of pre-computing (objective 5)?**
  Because the shape of the atlas (which textures, what dimensions)
  is closely coupled to the terrain types we end up supporting —
  and that list will grow during step 3 implementation. Building
  the atlas at runtime in JS keeps the iteration loop tight (edit
  `TERRAIN_TYPES`, reload). Pre-computing means a separate
  build-time step every time you tweak the type list. We can move
  to pre-computed once the list stabilises in a future hardening pass.

- **Why placeholder colours as a scope reducer (objective 4)?**
  Because the AC Texture (`0x06`) parser is a non-trivial graphics
  format reverse-engineering job and could eat the entire step 3
  budget without unblocking the visual goal. 32 hardcoded colours
  ship the *shader pipeline* — the load-bearing piece that step 4
  and step 5 build on — and let the texture parser be a separate
  step (3.5) when you have more time. The visual jump from
  "height ramp" to "32-colour terrain" is already half the
  perceptual delta toward "recognisable AC".

- **Why hard edges before soft blends (objective 6)?** Because hard
  edges are 5 lines of GLSL; soft blends are 50 lines and need
  triangle-barycentric reasoning. Ship the simple version, see
  what it looks like, decide if blending is worth it. Maxis's
  "first make it correct, then make it pretty" applies.

- **Why no road overlays in step 3?** Because road tiles are part
  of the same `CellLandblock.terrain[]` u16 packing — the road bits
  are 3-4 of the 16 bits — so once objective 1 pins the layout, the
  shader CAN sample road textures. But correctly blending road
  tiles requires either a separate pass (the static-site approach)
  or a dual-texture-per-fragment shader that's substantially more
  complex than the basic atlas sampler. Step 5 is the natural home
  for that polish; step 3 stays focused on the terrain layer.

- **Why no streaming / 5×5 in step 3?** Same as step 2: streaming
  is gated on the camera UX (which step 2 established) AND on
  having a stable visual baseline (which step 3 establishes).
  Doing both at once means rebuilding the cache strategy if step 3
  changes the per-landblock memory footprint. Step 3 first; figure
  out streaming step 4-or-later.

- **Why preserve the native invariant?** Same as before — the
  1086-test gate has caught real bugs at every prior step. Keep it
  green at every commit boundary. Step 3 will likely add
  2-4 native tests for the bit-decode + texture-parser; total
  going up to ~1090 is fine.

---

## Specs

### Read these files first (in order)

1. [`docs/emit-dynamic-site.md`](emit-dynamic-site.md) — §4.5
   "Direct-DAT rendering — terrain live, sprite atlas reused" is
   the load-bearing decision step 3 implements. The quality ladder
   table at the bottom of §4.5 is the roadmap; step 3 is row 2.
   Step 4's sprite-atlas reuse is a SEPARATE concern — do not
   conflate "terrain texture atlas" (this step) with "object sprite
   atlas" (next step). They are different bundles of art with
   different load paths.
2. [`docs/phase-3-renderer.md`](phase-3-renderer.md) — the as-built
   reference for what steps 1+2 shipped. The "Phase 3 step 2
   landed" section's before/after table tells you what's already
   in place; the "What's next" section's candidates triage tells
   you why texture-atlas was picked over multi-landblock streaming.
3. [`docs/phase-3-step-2-handoff.md`](phase-3-step-2-handoff.md) —
   the brief that framed step 2; format template for *this* brief.
   §Why's bullets walk through the trade-offs that landed the unit
   fix and the camera architecture; same logic applies to step 3.
4. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches this
   brief's status block.
5. [`external/holtburger/crates/holtburger-dat/src/landblock.rs:50-76`](../external/holtburger/crates/holtburger-dat/src/landblock.rs)
   — `CellLandblock` struct including `terrain: Vec<u16>` and
   `height: Vec<u8>`. The natural home for the bit-decode helpers
   in objective 1.
6. [`external/holtburger/apps/holtburger-web/src/lib.rs`](../external/holtburger/apps/holtburger-web/src/lib.rs)
   — `LandblockMesh`, `build_mesh`, the two `fetch_landblock_*`
   exports. Objective 2 extends this; objective 4 adds a new export.
7. [`external/holtburger/apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
   — step 2's render path. Objectives 5-7 restructure the
   `buildLandblockChildren` function and add the atlas + custom
   shader on top.
8. [`external/holtburger/apps/holtburger-web/smoke_test.cjs`](../external/holtburger/apps/holtburger-web/smoke_test.cjs)
   — step 2's 17 checks. Objective 8 adds 3 more.
9. **Reference implementations to crib from:**
   - The cloned upstream ACE at `~/ace-server/`:
     `Source/ACE.DatLoader/FileTypes/{Texture,Surface,LandSurf}.cs`
     (whatever exists there — file names may vary). This is the
     authoritative AC texture/surface format reference in code.
   - `WorldBuilder.Shared/Lib/Terrain/TerrainAverageColorBuilder.cs`
     and adjacent files — the static-site pipeline already does
     terrain-type colour mapping; the constants there are reusable.
   - `WorldBuilder.Shared/Lib/Texture/RenderSurfaceImporter.cs` —
     texture I/O the static site uses; may be a starting point for
     the holtburger-dat parser.
   - The static-site z=12 deliverable at
     [`docs/images/DerethMapsEnhanced_zoom.png`](images/DerethMapsEnhanced_zoom.png)
     is the visual target for "what good looks like" — step 3
     should look closer to this than to today's height ramp.

### `CellLandblock.terrain[81]` u16 packing (TO CONFIRM in objective 1)

A working hypothesis based on AC client / ACE source convention:

```
Bits 0-4   (5)  : scenery type (0..31, 0 = no scenery)
Bits 5-12  (8)  : terrain type — but actually the lower bits give
                  the terrain type (0..31 fits in 5 bits) plus
                  the upper bits encode rotation / flip.
                  Concrete layout differs across AC engine versions;
                  CONFIRM from `ACE.DatLoader/FileTypes/CellLandblock.cs`
                  in the cloned upstream.
Bits 13-15 (3)  : road bits (0 = no road; 1, 2, 3 = road type 1, 2, 3
                  in different orientations). The retail AC client
                  draws the road overlay as a separate pass on top
                  of the base terrain.
```

Pin this exactly with a unit test or two against known landblocks
before building anything else on top.

### Atlas region table shape (sketch)

```js
// Built once at module load from TERRAIN_TYPES[].
// Each entry: [u, v, w, h] in atlas units (0..1).
// Indexed by terrain code (0..31).
const TERRAIN_ATLAS_REGIONS = new Float32Array(32 * 4);

// Terrain code → (u, v, w, h)
TERRAIN_ATLAS_REGIONS[0 * 4 + 0] = 0.000;   // u
TERRAIN_ATLAS_REGIONS[0 * 4 + 1] = 0.000;   // v
TERRAIN_ATLAS_REGIONS[0 * 4 + 2] = 0.125;   // w (each tile 128/1024)
TERRAIN_ATLAS_REGIONS[0 * 4 + 3] = 0.125;   // h
// ...
```

Pass to the shader as a `uniform vec4 uAtlasRegions[32]`. WebGL
limits the number of `vec4` uniforms to ~256, so 32 fits with room
to spare for road tiles in step 5.

### Custom shader (sketch — GLSL ES 3.00 for WebGL2)

```glsl
// VERTEX SHADER
#version 300 es
precision mediump float;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

in vec2 aPosition;        // 2D (already flattened from positions[i*3..i*3+1])
in vec2 aLocalUv;         // [0, 1] within the cell (each vertex's frac of 24 m)
in float aTerrainCode;    // 0..31, passed flat to fragment

out vec2 vLocalUv;
flat out int vTerrainCode;

void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vLocalUv = aLocalUv;
    vTerrainCode = int(round(aTerrainCode));
}

// FRAGMENT SHADER
#version 300 es
precision mediump float;

uniform sampler2D uAtlas;
uniform vec4 uAtlasRegions[32];

in vec2 vLocalUv;
flat in int vTerrainCode;

out vec4 fragColor;

void main() {
    vec4 region = uAtlasRegions[vTerrainCode];
    vec2 atlasUv = region.xy + region.zw * fract(vLocalUv);
    fragColor = texture(uAtlas, atlasUv);
}
```

The `fract(vLocalUv)` lets each cell tile the texture if `vLocalUv`
exceeds 1.0 — useful if the cell-local UV math differs from your
mental model. Drop the `fract` if you bake [0, 1] cell-local UVs
on the wasm side already.

### `fetch_terrain_textures` shape (sketch)

```rust
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct TextureBlob {
    width: u32,
    height: u32,
    pixels: Vec<u8>,    // RGBA8, length = width * height * 4
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl TextureBlob {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> { self.pixels.clone() }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_terrain_textures(
    asset_url: String,
    texture_ids: Vec<u32>,
) -> Result<Vec<TextureBlob>, JsValue> {
    let source = HttpResourceSource::connect(&asset_url).await?;
    let mut out = Vec::with_capacity(texture_ids.len());
    for id in &texture_ids {
        let bytes = source.get_file_by_key(ResourceKey::new("eor/portal", *id))?;
        let texture = holtburger_dat::file_type::Texture::unpack(&bytes)?;
        let rgba = texture.to_rgba8(/* needs palette resolution */)?;
        out.push(TextureBlob {
            width: texture.width,
            height: texture.height,
            pixels: rgba,
        });
    }
    Ok(out)
}
```

The `Texture::unpack` + `to_rgba8` are the parts you'll need to
write. Reference the cloned ACE upstream for format details. If
you go the placeholder-colour scope-reducer route, this whole export
becomes "build 32 1×1 RGBA8 blobs from a hardcoded colour table"
— a 30-line function.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      ≥1086 passed / 0 failed (likely 1088-1092 after the new tests).
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,content,world,core,web,resource-http}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — 20/20 PASS
      after objective 8 lands.
- [ ] **Browser screenshot.** Open `index.html` in a real browser
      (Chrome or Firefox) — or capture via Playwright + Chromium
      with `--use-gl=swiftshader` like step 1+2 did. Verify:
      - All 9 landblocks visible at initial zoom, contiguous (no
        gaps, no overlaps).
      - Holtburg's town centre shows visibly different texture from
        surrounding fields (compare to existing static-site z=12
        screenshot at `docs/images/DerethMapsEnhanced_zoom.png`).
      - At maximum zoom-in, individual cell textures are
        recognisable (or recognisably-distinct colour blocks if you
        used the placeholder-colour scope reducer).
      - Mouse-wheel zoom + drag-to-pan still work (shader shouldn't
        break input plumbing).
      Save at `docs/images/phase-3-step-3-textured.png` and
      reference it from the renderer doc update.

### Decisions to NOT re-litigate

These have been settled in groundwork or prior steps. Do not re-open
without explicit ask from the user:

- **WASM-port over server-side per-player rendering.**
- **Direct-DAT terrain rendering, not Leaflet basemap reuse**
  (design doc §4.5; closed by Phase 3 step 1's first-pass landing).
- **Static-site sprite atlas reuse for OBJECT art (step 4),
  NOT terrain.** The sprite atlas at
  `dist/projects/<slug>/sprites/atlas.{png,js}` is for buildings,
  trees, NPCs, items — not terrain. Step 3's atlas is built from
  AC's `eor/portal:` Texture records.
- **PixiJS / WebGL over Leaflet hybrid for the entity layer.**
- **`wasm-pack` over `trunk` for the build pipeline.**
- **`[port:u16 BE][bytes]` framing for the WS bridge.**
- **`ruzstd` for wasm32 zstd decompression (native keeps `zstd`).**
- **`HbaReader<R = File>` generic with `Vec<u8>` for wasm32.**
- **`HttpResourceSource` is sync pre-load (option b), not async trait.**
- **HBA-of-HBAs as the shard format.**
- **AGPL-3.0 license.**
- **Real `~/ac_base_dats/` dats over synthetic fixtures.** Note: this
  is the canonical ACE-master-compatible set; the `client_highres.dat`
  copies under `/home/wbterminal/projects/*/dats/base/` are
  world-specific WorldBuilder outputs and **must not be reused**
  for ACE-compatible work. (Step 3 reads textures from the holtburger
  HBA bundle at `external/holtburger/dats/assets.hba`, not from raw
  retail DATs — same access pattern step 1+2 used.)
- **CDN PixiJS via importmap, no JS bundler.**
- **Parsing in Rust, drawing in JS — one wasm-bindgen crossing per
  landblock (or per batch).**
- **y-flip at the world-container level, not per-mesh.**
- **Aggregate height-min/max across the 9 landblocks for stage-info
  display** (no longer for shading after step 3, but still for the
  panel readout).

### Decisions still legitimately open after Phase 3 step 3

- **AC Texture (`0x06`) parser specifics.** Format details live in
  the cloned ACE upstream; the agent picking this up makes the
  trade-off between writing a full parser vs. shipping the
  placeholder-colour scope-reducer first.
- **Hard-edge vs. soft-blend cell boundaries.** Recommendation is
  hard first; soft is a follow-up commit if quality demands it.
- **Road-overlay strategy.** Step 5 polish; do not bake into step 3.
- **Sprite-atlas pipeline for objects.** Step 4 — gates on step 3's
  shader pipeline being in place.
- **Multi-landblock streaming with prefetch / eviction.** Phase 3
  step 4-or-later — gates on having a useful camera UX (step 2)
  and a stable visual baseline (step 3).
- **`ClientViewEvent` → entity sprites.** Phase 4 — gates on a
  wasm-side AC handshake export (which doesn't exist yet — the
  native cli does the handshake today, the wasm bundle has only
  `try_ws_handshake_smoke` which constructs a Session but doesn't
  drive login).
- **`coordSystem` boot assertion.** Mentioned in design doc §3.3 as
  a TODO before Phase 4. Not strictly part of step 3 but worth
  doing inline if it falls out of the type-table work. The constants
  to assert: `worldExtentWu = 49152`, `tilePx = 256`, `lbWu = 192`,
  `pxPerWuAtZ0 = 256/49152`. Confirm against
  `holtburger_common::position::METERS_PER_LANDBLOCK`.
- **WebGL1 vs. WebGL2 shader version.** PixiJS 8 picks at runtime;
  shader written above is GLSL ES 3.00 (WebGL2). If a target browser
  forces WebGL1, fall back to GLSL ES 1.00 with `varying` / `attribute`
  / `gl_FragColor`. Check `app.renderer.context.webGLVersion` at
  init time to pick.
- **Whether keyboard input (WASD pan, +/- zoom) ships before or
  after click-on-terrain interactions.**
- **Live ACE session + bridge wired into the wasm bundle.** Phase 4
  problem; the live infra is now in place (Phase 1 closed; Phase 2
  step 2 browser validation closed) but the bundle's session-driver
  export doesn't exist yet.

### Commit conventions (match prior session)

- `refactor(emit-dynamic-site): <subject>` for the bit-decode in
  objective 1 (no new export, just helpers + tests).
- `feat(emit-dynamic-site): <subject>` for code that ships the
  feature (the new `terrainCodes` getter, the
  `fetch_terrain_textures` export, the JS atlas builder, the
  custom shader wiring).
- `test(emit-dynamic-site): <subject>` for the smoke-test additions
  in objective 8.
- `docs(emit-dynamic-site): <subject>` for renderer-doc / spike-doc
  updates and the new screenshot.
- Commit body: section-headed paragraphs explaining **what** +
  **why**, with verification stats (test counts, smoke-check
  counts). See `38afb1c`, `708f3ac`, `04d997c`, `f04b1f5`,
  `79818ac` for format examples from step 2.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 3 step 3 landed**" paragraph in the same style
  as the existing "step 1 landed" + "step 2 landed" entries, and
  bump the `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18.
- `python3` for serving the bundle locally.
- A real browser (Chrome / Firefox) for manual validation, or
  `npx playwright install chromium` (already run during step 1+2)
  for scripted screenshots. Chromium with `--use-gl=swiftshader` is
  the reliable headless WebGL path on Linux.
- `.NET 10 SDK` at `~/.dotnet/dotnet` (installed during Phase 1
  follow-on closure for the live-ACE bring-up). Not needed for step
  3 itself, but the cloned ACE upstream at `~/ace-server/` is the
  reference for the texture/surface format spec.

### Live-ACE infrastructure (informational; step 3 doesn't need it)

For step 3's static-asset rendering, you do NOT need ACE running.
The full live-ACE setup (MariaDB + ACE + bridge + shim + cli) is
documented at [`docs/ace-local-setup.md`](ace-local-setup.md) for
when Phase 4's wasm-side handshake export needs validation. The
texture atlas work is purely "fetch HBA assets, parse, render" —
the same data flow steps 1+2 used.

### What done looks like

- `index.html` opened in a browser shows a 3×3 grid of contiguous,
  textured landblocks centred on Holtburg. Town centre reads as
  town texture; surrounding fields read as grass/hills; whatever
  water is nearby reads as water.
- Mouse-wheel zooms around the cursor; click-drag pans the camera
  (no regression from step 2). At maximum zoom-in, individual 24 m
  cells show their texture (or distinct placeholder colour).
- The 20th smoke check is green.
- All ≥1086 (likely 1090ish) workspace lib tests still pass.
- A new screenshot at `docs/images/phase-3-step-3-textured.png`
  is committed; the renderer doc references it; design doc §4.5
  quality-ladder row 2 flips to ✅.
- The next session can either (a) layer object sprites + LandblockInfo
  on top by reusing the static-site sprite atlas (step 4),
  (b) add road overlays + atmospheric polish (step 5),
  (c) extend to streaming with prefetch/eviction so the camera can
  roam beyond the 3×3 hardcode, or (d) start Phase 4 wiring (a
  wasm-side AC handshake export, gated on an interactive renderer
  to display character/world state). None of these blocks the
  others; pick by user priority.
