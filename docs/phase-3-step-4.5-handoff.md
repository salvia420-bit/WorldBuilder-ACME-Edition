# Phase 3 Step 4.5 — Handoff Brief

> Use this prompt to brief the next agent picking up Phase 3 of
> `emit-dynamic-site`. Step 4.5 is **replace the 2-bucket category
> tint on object/building sprites with per-model real colours
> derived from each model's Surface (0x08) record**. This is the
> visual-polish follow-on to step 4: the sprites already render at
> their correct positions and silhouettes, but every 0x01 model
> reads as the same brown and every 0x02 reads as the same tan-
> green. AC's actual per-model colour is one Surface lookup away.
>
> Structure: **Context → Intent → Objectives → Why → Specs.**
> Read in order. Don't start coding before you've finished §Why.
> The "Decisions to NOT re-litigate" section in §Specs lists
> commitments that were made in steps 1-4 — do not reopen them
> without explicit ask.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to
run an Asheron's Call client in the browser, top-down view, against
a live ACE server. As of 2026-05-04 commit `19c4727` the renderer:

- Fetches a 3×3 landblock neighbourhood around Holtburg in one
  batch HTTP fetch (~605 MB `assets.hba`).
- Decodes and renders **real retail terrain textures** per cell
  (grass with mottling, water with waves, stone road tile),
  sampled per-cell from a 6×6 = 1536×1536 GPU atlas via a custom
  GLSL ES 3.00 PixiJS Mesh shader.
- Overlays the **stone-road network** wherever `road_type ≥ 1`
  in the cell's SW corner.
- Places **239 object/building sprites** on top — Holtburg's
  brown houses clustered at the road junction, smaller props
  scattered through the grass — by reading `LandblockInfo`
  records from `XXYYFFFE` cells and looking up each placed
  object in the static-site sprite atlas.
- Mouse-wheel zooms around the cursor; click-and-drag pans.

The current colour pipeline for objects has one weakness that
this brief fixes: **every sprite is tinted by a 2-bucket category
palette** (model_id top byte: `0x01` → `#8b6442` warm brown,
`0x02` → `#6f7a4a` tan-green). Real AC has one specific colour
per model — the brown houses are not the same brown as the dirt
road; the green pyramid lifestone in Holtburg's town centre would
glow distinctly green in retail. Step 4.5 replaces the category
tint with each model's actual colour, derived from its
GfxObj/SetupModel → Surface (0x08) chain.

### Where the project is right now (as of `19c4727`, 2026-05-04)

| Phase | What landed | Commit(s) |
|---|---|---|
| Groundwork | License, design doc, hard-fork of holtburger, decision log | `4987c59` |
| Phase 1 | `holtburger-wsbridge` (WS↔UDP) + `holtburger-wsshim`; 21 tests; full `cli ↔ shim ↔ bridge ↔ echo` round-trip | `d00770a`, `0945b7f` |
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
| **Phase 3 step 4.5 — per-model real colours** | **▶ this brief** | — |

**Working tree:** clean. **Branch:** `master`, pushed to
`origin/master`. **Native invariant:** `cargo test --workspace
--lib` is **1096 passed / 0 failed** across 13 crates and is the
merge-gate at every commit boundary. **Smoke test:**
`apps/holtburger-web/smoke_test.cjs` is at **32/32 PASS**.

### What's already in place (from steps 3.5 + 4)

- **Wasm exports.** `fetch_landblock_heightmaps` (terrain mesh per
  cell), `fetch_terrain_textures` (33 retail terrain RGBA8 blobs),
  `fetch_landblock_objects` (object/building placements with
  model_id + frame).
- **Object placement struct.** `ObjectPlacement` carries
  `landblockId, modelId, x, y, z, rotationZ` per placed object or
  building. JS already consumes 239 of these per Holtburg session.
- **Sprite atlas.** `apps/holtburger-web/sprites/atlas.{png,js}`
  copied from the static-site sample (4096×1296 RGBA, 108 model
  IDs). Atlas tiles are pure greyscale silhouettes (verified:
  R == G == B for every pixel). Tinted at runtime via
  `PIXI.Sprite.tint` in the JS render layer.
- **Existing tint.** Two-bucket category palette by model_id top
  byte: `0x01 → #8b6442`, `0x02 → #6f7a4a`. Lives in
  `index.html:buildObjectsContainer`.
- **dat-format parsers in holtburger-dat:** `Palette` (0x04),
  `SurfaceTexture` (0x05), `Texture` (0x06), `GfxObj` (0x01),
  `SetupModel` (0x02). The Surface (0x08) parser does NOT yet
  exist — this is the only new parser step 4.5 needs.
- **HbaReader / HttpResourceSource.** The full HBA fetch + lookup
  path is wasm-bindgen-clean and reused by every fetch_* export.
- **Atlas coverage.** 44% of Holtburg's 239 placements have a
  sprite tile; the rest fall back to coloured 1.5 m circles.
- **PixiJS scene graph:** `app.stage → cameraContainer (zoom +
  pan) → worldContainer (one-time AC y-flip) → landblockContainer
  × 9 + objectsContainer (sprites/dots)`. Mouse-wheel zoom,
  drag-to-pan unchanged from steps 2-4.

### What's NOT in place yet — and what step 4.5 fixes

- **No Surface (0x08) parser.** AC's Surface record carries the
  per-model colour info: either a solid `ColorValue` (ARGB) or a
  reference to an `OrigTextureId` (palettized texture) +
  `OrigPaletteId`. Without this parser we can't extract per-model
  colours.
- **No model→colour walk.** GfxObj has a `surfaces: Vec<u32>`
  (sometimes called `surface_ids` in field naming); SetupModel has
  `parts: Vec<u32>` of GfxObj IDs each with their own surfaces.
  Walking model → surfaces → first/dominant ARGB colour is the
  load-bearing utility step 4.5 needs.
- **No `fetch_object_colours` wasm export.** JS currently looks up
  one tint per model based on top-byte heuristic. Step 4.5 ships a
  per-model lookup; the boundary call is small (`Vec<u32>` of
  model IDs in, `Vec<u32>` of ARGB out) and the result fits in
  the existing `Map<modelId, ...>` JS-side cache.
- **2-bucket tint kills detail.** The current render's brown
  cluster of buildings is one shade of brown for ALL of them,
  including signs, doors, fences. Real AC has different woods,
  stones, metals — the static-site reference shows brown houses
  with grey roofs and yellow signs. Step 4.5 brings this back.

### What's left in Phase 3 + Phase 4 (current priority list)

| Step | Status | Owner / blocker |
|---|---|---|
| §8.5 scripting "exclude from WASM" | open, **deferred** | no script-driven feature has surfaced a need |
| Phase 3 steps 1-4 | ✅ done | — |
| **Phase 3 step 4.5 per-model real colours** | **▶ this brief** | — |
| Phase 3 step 5 atmospherics (fog, day/night) | open | independent polish |
| Phase 3 step 5 per-cell terrain blending (CornerTerrainMaps) | open | multi-pass renderer, ~150 lines GLSL |
| Phase 3 step 6 multi-landblock streaming | open | needs landblock cache + camera-driven prefetch |
| Phase 3 step 7 renderer-profile bake | open | extend `is_essential()` to land 605 MB → ~280 MB |
| Phase 4 live ACE session | open | needs wasm-side AC handshake export |

The Phase 3 as-built reference at
[`docs/phase-3-renderer.md`](phase-3-renderer.md) is the
authoritative as-built reference for every shipped step. The §4.5
quality ladder in [`docs/emit-dynamic-site.md`](emit-dynamic-site.md)
shows all 4 rows ✅ landed in some form after step 4 — step 4.5
sharpens row 3 (sprite atlas) from "category tint" to "per-model
real colours".

---

## Intent

You are upgrading the per-object colour fidelity from "category
heuristic" to "per-model truth". Today, every brown silhouette in
Holtburg is the same brown. Real AC has distinct browns, greys,
greens, yellows — the green pyramid (lifestone) and the brown
houses are visibly different colours in the static-site reference,
but identical in our render. Step 4.5 closes this specific gap.

What "done" looks like at the end of this step:

1. Open `index.html` in a browser; the 3×3 grid pans/zooms exactly
   as before, all 239 object placements still render at the same
   positions.
2. **Building cluster at Holtburg's road junction shows
   distinguishable per-model colours** — at least 5 visibly
   different tints across the brown structures, not one uniform
   brown wash. Compare side-by-side with the step 4 deliverable
   at `docs/images/phase-3-step-4-objects.png`: you should see
   variation that wasn't there before.
3. **Lifestone (or whatever Holtburg's notable green-pyramid
   model is — model_id likely `0x02000118` or `0x020019E3` based
   on the atlas worldBounds [6.04, 6.04]) renders as a green tile,
   not the default 0x02 tan-green.** This is a sentinel object;
   if it's still uniform tan-green, the colour walk isn't
   finding the right Surface.
4. **Smoke test grows from 32 → 35 checks**:
   - Symbol-presence for `fetch_object_colours`.
   - Round-trip: 67 unique Holtburg model IDs → 67 ARGB colours,
     all with non-zero alpha.
   - Sentinel pin: at least one model returns a colour with
     `green_byte > red_byte AND green_byte > blue_byte` (proves
     non-brown colours come through).
5. The full loop runs in any modern browser without devtools open.
   New screenshot at `docs/images/phase-3-step-4.5-real-colours.png`
   replaces the step 4 deliverable as the title image of
   `phase-3-renderer.md`.
6. Comparing side-by-side with the static-site z=12 reference at
   [`docs/images/DerethMapsEnhanced_zoom.png`](images/DerethMapsEnhanced_zoom.png),
   the building palette now reads as comparable variety. Roofs
   may not match (those are SetupModel sub-parts that step 4.5
   could either flatten or punt to step 5).

What this step deliberately does NOT do:

- **No 3D model rendering.** We're still using the static-site
  greyscale silhouettes; we're just tinting them more accurately.
  Generating new sprites from scratch (rendering AC 3D models top-
  down to fill the 56% atlas-miss gap) is its own multi-week
  project — defer to step 5+ if ever.
- **No multi-surface-per-model blending.** Models like buildings
  have many surfaces (walls, roof, floor). Step 4.5 picks ONE
  representative colour per model — typically the first surface
  or a dominant-colour heuristic. Per-vertex / per-poly real
  rendering is rendering the 3D model, which is out of scope.
- **No atlas regeneration.** Atlas tiles stay greyscale; we do not
  re-bake them with real colours pre-applied. The runtime tint is
  the cleanest extension point and lets the tint live next to the
  model_id (which the per-cell instance carries) rather than
  baked into the texture.
- **No live ACE session integration.** Phase 4 still gates on a
  wasm-side handshake export.
- **No streaming / N×N expansion.** Still hardcoded 3×3 around
  Holtburg.
- **No re-litigation of step 1-4 decisions** (PixiJS, parsing in
  Rust, real-textures atlas, sprite-atlas reuse, sprite-layer
  scene-graph slot). Same scaffolding, extended.

This is the smallest possible Phase 3 step 4.5 vertical slice:
**proves the GfxObj/SetupModel → Surface → ARGB walk works, the
wasm-bindgen boundary stays one-call-per-model-batch, and the JS
sprite tint upgrades from category heuristic to per-model real
colour**. The existing 2-bucket tint stays as a fallback for any
model whose surface chain can't be resolved (so the renderer
degrades gracefully on incomplete bundles or new content).

---

## Objectives

In rough dependency order. Each objective ships its own commit; do
not batch.

1. **Surface (0x08) parser.** New file at
   `crates/holtburger-dat/src/file_type/surface.rs`. Mirrors the
   pattern of `palette.rs`, `surface_texture.rs`, `texture.rs`
   from step 3.5. ACE reference is at
   `~/ace-server/Source/ACE.DatLoader/FileTypes/Surface.cs`
   (already inspected in step 3.5's scoping work — see
   `docs/phase-3-renderer.md`'s step 3.5 section).

   Format:
   ```
   [u32 id][SurfaceType u32][optional texture/palette refs][f32 translucency][f32 luminosity][f32 diffuse]
   ```
   The `SurfaceType` enum has `Base1Image` and `Base1ClipMap`
   flag bits. If either is set, the next two u32s are
   `OrigTextureId` and `OrigPaletteId`. Otherwise the next u32 is
   a solid `ColorValue` (ARGB).

   Add 2-3 unit tests pinning the format against synthetic byte
   arrays — solid-colour surface, image+palette surface,
   round-trip of ID / luminosity fields.

   **Verification:** `cargo test --workspace --lib` ≥1096 → ~1099
   (likely +3). Surface parser exposes `Surface::unpack(data:
   &[u8]) -> Result<Surface>` and getters for `id`, `surface_type`,
   `texture_id` / `palette_id` / `color_value` (Option-wrapped per
   the type-flag check), and the three float properties.

2. **`Surface::dominant_color()` helper + GfxObj/SetupModel walk.**
   Add a method on `Surface` that returns the surface's
   representative ARGB:
   - If `surface_type` flags `Base1Image | Base1ClipMap` and a
     palette is present: fetch the Texture, decode, average its
     pixels, return mean ARGB. (You already have `Texture::to_rgba8`
     from step 3.5 — pixel-mean over the result.)
   - If solid colour: return `color_value` directly (already ARGB).
   - Edge case: missing texture/palette ID → return `0x00000000`
     (alpha 0; caller treats as miss).

   Add a free function (probably in
   `apps/holtburger-web/src/lib.rs`, since it's wasm-only) that
   takes a `model_id: u32` and a `&dyn ResourceSource`, walks the
   model → surfaces chain, and returns the FIRST resolvable ARGB:

   ```rust
   fn resolve_model_color(source: &impl ResourceSource, model_id: u32) -> Option<u32> {
       match (model_id >> 24) as u8 {
           0x01 => walk_gfx_obj(source, model_id),
           0x02 => walk_setup_model(source, model_id),
           _ => None,
       }
   }
   ```
   `walk_gfx_obj` reads the GfxObj record (parser already exists
   in `crates/holtburger-dat/src/file_type/gfx_obj.rs`), iterates
   `surfaces: Vec<u32>`, and returns the first surface whose
   `dominant_color()` resolves.

   `walk_setup_model` reads the SetupModel record (parser already
   exists), iterates its parts (each part is a GfxObj ID), and
   recurses via `walk_gfx_obj` until one returns Some.

   No new wasm-bindgen surface yet — that's objective 3.

3. **`fetch_object_colours(asset_url, model_ids: Vec<u32>) ->
   Promise<Vec<u32>>` wasm export.** Returns one ARGB per input
   model_id, in input order. `0x00000000` means "could not
   resolve" — the JS caller falls back to the existing 2-bucket
   tint for those.

   Implementation: opens `HttpResourceSource` once, calls
   `resolve_model_color` per id. The cost is bounded by the
   number of UNIQUE model IDs in the visible neighbourhood (67
   for Holtburg's 3×3); JS dedupes the input list before calling.

4. **JS-side per-model tint lookup.** In `index.html`'s render
   trigger, add the colour fetch alongside the existing object +
   atlas fetch:

   ```js
   const uniqueModels = [...new Set(objects.map((o) => o.modelId))];
   const colours = await fetch_object_colours(ASSET_URL, new Uint32Array(uniqueModels));
   const colourMap = new Map();
   for (let i = 0; i < uniqueModels.length; i++) {
     if (colours[i] !== 0) colourMap.set(uniqueModels[i], colours[i]);
   }
   ```

   In `buildObjectsContainer`, replace the 2-bucket lookup:
   ```js
   const realColour = colourMap.get(obj.modelId);
   sprite.tint = realColour ?? (prefix === 0x01 ? 0x8b6442 : 0x6f7a4a);
   ```

   ARGB → RGB conversion: PixiJS tint takes 0xRRGGBB. AC's
   ColorValue is 0xAARRGGBB. Drop the alpha byte:
   `realColour & 0x00FFFFFF`.

5. **Update fallback colour for missing-from-atlas objects too.**
   The same `colourMap.get(obj.modelId)` lookup applies to the
   coloured-circle fallback. So a missing-sprite, real-colour
   model gets a small dot in its real colour rather than the
   2-bucket fallback.

6. **Smoke test additions (32 → 35).**
   - Symbol-presence for `fetch_object_colours`.
   - Round-trip: pass the 67 unique Holtburg model IDs, expect
     67 ARGB outputs, expect ≥80% non-zero (the static-site sample
     atlas covers 44% but the Surface walk should resolve more —
     models with a Surface but no atlas tile still get a colour).
   - Sentinel diversity: collect the resolved colours, verify ≥5
     distinct hue buckets (where "bucket" = which RGB channel is
     dominant). Pins that we're not collapsing every model to one
     colour.

7. **Native invariant + workspace check.** `cargo test --workspace
   --lib` must remain ≥1096 / 0 (probably grows by 2-3 from the
   Surface parser tests). `cargo check --target
   wasm32-unknown-unknown -p holtburger-{dat,web}` must remain
   clean. `wasm-pack build --target {nodejs,web}` both green.

8. **Document.** Update `docs/phase-3-renderer.md` (lift step 4.5
   out of the "What's next" candidates list and into a new "Phase
   3 step 4.5 landed" section in the same as-built style as steps
   3.5 + 4). Capture a new browser screenshot at
   `docs/images/phase-3-step-4.5-real-colours.png` and reference it
   from the renderer doc. Update `docs/phase-2-wasm-spike.md`'s
   status banner to say "step 4.5 landed". Update
   `docs/emit-dynamic-site.md` §4.5's quality ladder annotation on
   row 3 from "step 4 silhouettes + category tint" to "step 4.5
   real per-model colours". Bump the auto-memory entry at
   `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why parse Surface (0x08) first (objective 1)?** Because every
  downstream objective walks through it. Without the parser,
  `dominant_color()` is impossible, the model walk is impossible,
  and the wasm export has nothing to call. It's also the smallest,
  most contained piece (parallels palette.rs / texture.rs from
  step 3.5 — same shape). Pinning the parser with unit tests first
  means the rest of the pipeline has a stable contract to build
  against.

- **Why the model walk in Rust, not JS (objective 2)?** Because
  walking model → surfaces requires parsing GfxObj + SetupModel +
  Surface — all already in `holtburger-dat`. Doing the walk in JS
  would require crossing the wasm boundary three times per model
  (one per type lookup) plus parsing the binary bytes manually in
  JS. Doing it in Rust keeps the boundary cost flat:
  one `fetch_object_colours` call returns the resolved colour
  directly. Same architectural pattern as
  `fetch_terrain_textures` in step 3.5.

- **Why one colour per model, not multi-surface (objective 2 +
  3)?** Because PIXI.Sprite.tint is a SINGLE COLOUR multiplied
  per-channel against the sprite's greyscale silhouette. The
  silhouette has no per-region detail to differentiate "wall vs
  roof". To render multi-surface, we'd need either (a) per-poly
  meshes (rendering the 3D model), or (b) multi-layer atlas tiles
  (a roof layer over a wall layer). Both are step 5+ scope. Step
  4.5 ships the visible improvement (per-model variety) without
  the structural shift.

- **Why solid-colour surfaces over textured ones in
  `dominant_color()`?** Because `ColorValue` is one word — no
  fetch needed. For textured surfaces we have to fetch the
  Texture + Palette and average pixels, which is roughly an order
  of magnitude more work per model. The implementation handles
  both, but the textured path is hot only for a fraction of
  models. Bench / budget if needed; my expectation is total cost
  < 200 ms for Holtburg's 67 models.

- **Why graceful fallback (objective 4 + 5)?** Because the
  Surface walk WILL fail for some models — incomplete bundles,
  formats we haven't handled, edge cases. Falling back to the
  existing 2-bucket tint means the worst case after step 4.5 is
  "looks like step 4" — not "completely broken render". The
  bisection invariant is that step 4.5 is a strict improvement
  on visible quality.

- **Why no multi-surface-per-model in step 4.5?** Because step 4.5
  is supposed to be a contained polish step. Multi-surface
  rendering needs the actual 3D model rendered top-down, which is
  step 5+ scope and probably warrants its own multi-week effort.
  The visual win from per-model real colours is large enough to
  ship on its own.

- **Why no atlas regeneration?** Because the atlas tiles are baked
  greyscale silhouettes — re-baking them with colour would have
  to happen offline and would couple the asset pipeline to the
  renderer. Runtime tint is the right separation: atlas =
  silhouettes, model_id = colour, multiplied at draw time.

- **Why preserve the native invariant?** Same as before — the
  1096-test gate has caught real bugs at every prior step. Keep
  it green at every commit boundary. Step 4.5 will likely add
  2-3 native tests for the Surface parser; total going up to
  ~1099 is fine.

---

## Specs

### Read these files first (in order)

1. [`docs/phase-3-renderer.md`](phase-3-renderer.md) — the
   as-built reference for what's shipped. The "Phase 3 step 4
   landed" section (and the smaller "step 3.5 landed" before it)
   show the same pattern step 4.5 follows: new dat parser → new
   wasm export → new JS render-layer hook. Use the same prose
   style for the new "step 4.5 landed" section.
2. [`docs/phase-3-step-3-handoff.md`](phase-3-step-3-handoff.md)
   — the brief that framed step 3 (texture atlas). The §Why's
   bullets for that step walk through the same trade-offs that
   apply to step 4.5: scope reduction, fallback graceful
   degradation, runtime cost flat-lining.
3. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches this
   brief's status block.
4. [`external/holtburger/crates/holtburger-dat/src/file_type/texture.rs`](../external/holtburger/crates/holtburger-dat/src/file_type/texture.rs)
   — the pattern for objective 1's parser. Copy the binread
   struct shape, the `unpack(&[u8])` helper, the `to_rgba8`-style
   computed method, the unit-test layout.
5. [`external/holtburger/crates/holtburger-dat/src/file_type/gfx_obj.rs`](../external/holtburger/crates/holtburger-dat/src/file_type/gfx_obj.rs)
   — already exposes `surfaces: Vec<u32>` (or whatever the field
   is called). Confirm the field name; objective 2's `walk_gfx_obj`
   iterates it.
6. [`external/holtburger/crates/holtburger-dat/src/file_type/setup_model.rs`](../external/holtburger/crates/holtburger-dat/src/file_type/setup_model.rs)
   — confirm the parts list field name; objective 2's
   `walk_setup_model` iterates it.
7. [`external/holtburger/apps/holtburger-web/src/lib.rs`](../external/holtburger/apps/holtburger-web/src/lib.rs)
   — `fetch_terrain_textures` (step 3.5) and
   `fetch_landblock_objects` (step 4) are the templates for
   `fetch_object_colours`. Same async-fn shape, same
   HttpResourceSource open-once pattern, same per-id failure
   semantics (silent skip vs hard fail).
8. [`external/holtburger/apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
   — `buildObjectsContainer` is where the 2-bucket tint lives.
   Objective 4 + 5 modify this single function plus the render
   trigger that feeds it.
9. [`external/holtburger/apps/holtburger-web/smoke_test.cjs`](../external/holtburger/apps/holtburger-web/smoke_test.cjs)
   — the 32-check baseline. Objective 6 adds 3 more.
10. **Reference implementation to crib from:**
    [`~/ace-server/Source/ACE.DatLoader/FileTypes/Surface.cs`](file:///home/wbterminal/ace-server/Source/ACE.DatLoader/FileTypes/Surface.cs)
    — already inspected during step 3.5. Top-level format is in
    the file's `Unpack` method. The `SurfaceType` enum is in
    `~/ace-server/Source/ACE.Entity/Enum/SurfaceType.cs`
    (or look up the bit-flag values inline).

### Surface (0x08) layout (from upstream ACE)

```
[u32 id]
[u32 SurfaceType bitfield]   // see SurfaceType enum
if (type & (Base1Image | Base1ClipMap)) {
    [u32 OrigTextureId]
    [u32 OrigPaletteId]
} else {
    [u32 ColorValue]   // ARGB
}
[f32 Translucency]
[f32 Luminosity]
[f32 Diffuse]
```

`SurfaceType` flag bits to handle:
- `Base1Image = 0x01`
- `Base1ClipMap = 0x04` (or similar — confirm from ACE enum)

If neither flag is set, the surface is solid-colour. Otherwise
it's textured + palettized.

### `Surface` parser shape (sketch)

```rust
// crates/holtburger-dat/src/file_type/surface.rs

use binrw::{binread, BinRead};
use std::io::Cursor;

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct Surface {
    pub id: u32,
    pub surface_type_raw: u32,
    // Conditional read based on the type bits.
    #[br(if((surface_type_raw & 0x05) != 0))]
    pub texture_refs: Option<TextureRefs>,
    #[br(if((surface_type_raw & 0x05) == 0))]
    pub color_value: Option<u32>,
    pub translucency: f32,
    pub luminosity: f32,
    pub diffuse: f32,
}

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct TextureRefs {
    pub orig_texture_id: u32,
    pub orig_palette_id: u32,
}

impl Surface {
    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        Self::read(&mut Cursor::new(data))
    }

    /// Returns the surface's representative ARGB. For solid-colour
    /// surfaces this is the `color_value` directly. For textured
    /// surfaces, callers fetch the referenced Texture + Palette
    /// and pixel-mean. `None` if the surface has no resolvable
    /// colour.
    pub fn solid_color(&self) -> Option<u32> {
        self.color_value
    }
}
```

The double-`if` for the conditional fields is a binrw idiom; check
how `landblock.rs:RestrictionTable` uses `#[br(if(...))]` for a
working pattern in this codebase.

### `fetch_object_colours` shape (sketch)

```rust
// apps/holtburger-web/src/lib.rs

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_object_colours(
    asset_url: String,
    model_ids: Vec<u32>,
) -> Result<Vec<u32>, JsValue> {
    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut out = Vec::with_capacity(model_ids.len());
    for &id in &model_ids {
        out.push(resolve_model_color(&source, id).unwrap_or(0));
    }
    Ok(out)
}

fn resolve_model_color<S: ResourceSource>(source: &S, model_id: u32) -> Option<u32> {
    match (model_id >> 24) as u8 {
        0x01 => walk_gfx_obj(source, model_id),
        0x02 => walk_setup_model(source, model_id, 0),
        _ => None,
    }
}

fn walk_gfx_obj<S: ResourceSource>(source: &S, gfx_obj_id: u32) -> Option<u32> {
    let bytes = source.get_file_by_key(ResourceKey::new("eor/portal", gfx_obj_id)).ok()?;
    let gfx = GfxObj::unpack(&bytes).ok()?;
    for surface_id in gfx.surfaces {
        if let Some(c) = lookup_surface_color(source, surface_id) { return Some(c); }
    }
    None
}

fn walk_setup_model<S: ResourceSource>(source: &S, setup_id: u32, depth: usize) -> Option<u32> {
    if depth > 4 { return None; }   // recursion guard
    let bytes = source.get_file_by_key(ResourceKey::new("eor/portal", setup_id)).ok()?;
    let setup = SetupModel::unpack(&bytes).ok()?;
    for part_id in setup.parts {
        if let Some(c) = walk_gfx_obj(source, part_id) { return Some(c); }
    }
    None
}

fn lookup_surface_color<S: ResourceSource>(source: &S, surface_id: u32) -> Option<u32> {
    let bytes = source.get_file_by_key(ResourceKey::new("eor/portal", surface_id)).ok()?;
    let surface = Surface::unpack(&bytes).ok()?;
    surface.solid_color()  // skip textured for v1
}
```

**Scope reducer if textured surfaces eat too much time:** ship v1
with `lookup_surface_color` returning `None` for textured surfaces
(only solid-colour surfaces resolve). Atlas-miss models fall back
to the 2-bucket tint as before. Step 4.5b can add the textured-
surface pixel-mean path later.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      ≥1096 passed / 0 failed (likely 1099 after the new tests).
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,content,world,core,web,resource-http}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — 35/35
      PASS after objective 6 lands.
- [ ] **Browser screenshot.** Open `index.html` in a real browser
      (Chrome or Firefox) — or capture via Playwright + Chromium
      with `--use-gl=swiftshader` like prior steps. Verify:
      - Holtburg town centre shows ≥5 visibly distinct building
        tints, not a uniform brown wash.
      - One model renders distinctly green-dominant (the
        lifestone or whatever Holtburg's notable green-pyramid
        landmark is).
      - Mouse-wheel zoom + drag-to-pan still work.
      Save at `docs/images/phase-3-step-4.5-real-colours.png` and
      reference from the renderer doc update.

### Decisions to NOT re-litigate

These have been settled in prior steps. Do not re-open without
explicit ask from the user:

- **WASM-port over server-side per-player rendering.**
- **Direct-DAT terrain rendering, not Leaflet basemap reuse**
  (design doc §4.5).
- **PixiJS / WebGL over Leaflet hybrid.**
- **`wasm-pack` over `trunk` for the build pipeline.**
- **Real retail AC textures via Texture (0x06) parser** (step
  3.5 — `RETAIL_TERRAIN_SURFACE_TEXTURES` constant pinned by
  signature scan).
- **Sprite atlas reuse via static-site `atlas.{png,js}` rather
  than baking new ones** (step 4 — atlas tiles ARE greyscale
  silhouettes, tinted at runtime).
- **Atlas-miss → 1.5 m fallback dot** (step 4 — keep the visual
  signal that "an object exists here" even without a sprite).
- **AGPL-3.0 license.**
- **Real `~/ac_base_dats/` dats over synthetic fixtures.**
- **`dat2hba --profile full`** as the renderer baseline (605 MB
  bundle is OK for dev; tightening profile is a separate step).
- **CDN PixiJS via importmap, no JS bundler.**
- **Parsing in Rust, drawing in JS — one wasm-bindgen crossing
  per per-call boundary.**
- **y-flip at the world-container level, not per-mesh.**
- **`flat in int` shading from SW corner for terrain + roads**
  (step 5 partial — provoking-vertex contract).
- **Hard edges per cell, no per-cell terrain blending** (step 5
  follow-on; needs CornerTerrainMaps + multi-pass).
- **`fetch_landblock_objects` covers both Stab (objects) and
  BuildInfo (buildings)** (step 4 — same `(model_id, frame)`
  shape, no need to distinguish at the boundary).

### Decisions still legitimately open after Phase 3 step 4.5

- **Multi-surface-per-model rendering.** Beyond step 4.5's "one
  representative colour per model" — would need per-poly meshes
  (rendering 3D) or multi-layer atlas. Step 5+ scope.
- **Atlas augmentation** for the 56% of Holtburg's models with no
  sprite tile. Currently they fall back to 1.5 m dots; step 4.5
  improves the dot's colour but doesn't add silhouettes. Step 5+
  scope.
- **Per-cell terrain blending** (CornerTerrainMaps).
- **Atmospheric polish** (fog of war, day/night gradient).
- **Multi-landblock streaming** with prefetch + eviction.
- **Renderer-profile bake** (605 MB → ~280 MB).
- **Live ACE session + bridge wired into the wasm bundle** (Phase
  4 — gated on a wasm-side AC handshake export).
- **WebGL2 vs WebGL1 fallback shader** (step 3.5 deferred a WGSL
  pair; if a target browser hits WebGL1 today it crashes on the
  GLSL ES 3.00 atlas shader).
- **`ClientViewEvent` → entity sprites.** Phase 4.

### Commit conventions (match prior session)

- `feat(emit-dynamic-site): <subject>` for the parser commit, the
  wasm export commit, the JS-side tint upgrade.
- `test(emit-dynamic-site): <subject>` for the smoke-test
  additions in objective 6.
- `docs(emit-dynamic-site): <subject>` for renderer-doc / spike-
  doc updates and the new screenshot.
- Commit body: section-headed paragraphs explaining **what** +
  **why**, with verification stats (test counts, smoke-check
  counts). See `0e47306`, `5eb5736`, `19c4727` for format examples
  from steps 3.5 + 4.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 3 step 4.5 landed**" paragraph in the same
  style as the existing step-3.5 + step-4 entries, and bump the
  `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18.
- `python3` for serving the bundle locally.
- Real browser (Chrome / Firefox) for manual validation, or
  `npx playwright install chromium` (already run) for scripted
  screenshots. Chromium with `--use-gl=swiftshader` is the
  reliable headless WebGL path on Linux.
- `~/ace-server/` — full upstream ACE clone for cross-referencing
  Surface.cs, SurfaceType.cs, etc.

### What done looks like

- `index.html` opened in a browser shows the 3×3 Holtburg grid
  with **per-model real colours** on the building cluster — at
  least 5 distinct hues across the brown structures, plus a
  green-dominant tile for the lifestone landmark. Compare against
  `docs/images/phase-3-step-4-objects.png` for the before-state.
- 35/35 smoke checks green.
- All ≥1096 (likely 1099-ish) workspace lib tests still pass.
- A new screenshot at
  `docs/images/phase-3-step-4.5-real-colours.png` is committed; the
  renderer doc references it; design doc §4.5 row 3 annotation
  flips to "step 4.5 real per-model colours".
- The next session can either (a) tackle multi-surface-per-model
  rendering (step 5+, multi-week — actual 3D model rendering),
  (b) add per-cell terrain blending via AC CornerTerrainMaps,
  (c) ship atmospheric polish (fog, day/night), (d) ship a
  renderer-profile bake to shrink the asset bundle, (e) extend
  to N×N streaming, or (f) start Phase 4 (live ACE session
  handshake). Step 4.5 closes one specific visual gap without
  blocking any of these.
