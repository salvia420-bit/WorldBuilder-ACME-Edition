# A10 render-state-materials — unification survey

Date: 2026-06-11 · Agent: A10 · Scope: Surface (0x08) render-state bits → three.js material
mapping, per-part render flags, degrade/quality ladder. 3D path (`scene3d/`) only.

## 1. Retail map

Retail funnels EVERY drawn surface through **one** decision function:
`D3DPolyRender::SetSurface(CSurface*, stippled, singlePassDetailing, overrideClipmap)`
(acclient.c:454385–454565). It is invoked from the mesh-subset draw path
(acclient.c:454676, passing `isStippledOrAlphaedMask[subsetNum] & 1` as `stippled`). There is no
second materials codepath — paletted/dyed, recoloured, static, building, and entity surfaces all
hit this same function.

Responsibilities and exact rules inside `SetSurface`:

- **State capture**: `Render::curr_surface_type = surface->type | GOURAUD(0x10000000)`
  (acclient.c:454408); stippled additionally ORs `STIPPLED 0x40000000` (acclient.c:454437).
- **Texture sampler**: address mode `TEXADDRESS_CLAMP(3)` for normal object surfaces,
  `TEXADDRESS_WRAP(1)` when stippled (acclient.c:454437; enum values acclient.h:5257–5263);
  filtering always LINEAR.
- **Solid (untextured) surfaces**: solid-color texture from `color_value & 0xFFFFFF` with
  `alpha = (1 − translucency) × 255` (acclient.c:454447–454449).
- **Luminosity float** → `Render::luminosity` (acclient.c:454452–454455); consumed at draw as a
  grayscale `D3DMATERIAL9.Emissive` (`Emissive.r=g=b=surface->luminosity`,
  acclient.c:454691–454697) which the fixed-function combiner MODULATES with the diffuse texture
  (TEXOP_MODULATE stage 0, acclient.c:454429–454432).
- **Diffuse float** → `Render::diffuse = sunlight_color × surface->diffuse` when
  `Render::useSunlight`, else the raw float (acclient.c:454458–454467).
- **Blend-state ladder** (BlendMode enum acclient.h:5193–5204: 1=ZERO 2=ONE 5=SRCALPHA
  6=INVSRCALPHA):
  - `ALPHA 0x100` (BYTE1 & 1): src=SRCALPHA, dst=ONE if `ADDITIVE 0x10000` else INVSRCALPHA,
    blend ON (acclient.c:454470–454477).
  - `INVALPHA 0x200` (BYTE1 & 2): src=INVSRCALPHA, dst=ONE if ADDITIVE else SRCALPHA, blend ON
    (acclient.c:454478–454485).
  - `ADDITIVE 0x10000` alone: src=ONE, dst=ONE, blend ON (acclient.c:454486–454494).
  - default: src=ONE, dst=ZERO, blend OFF (acclient.c:454495–454496).
  - `BASE1_CLIPMAP 0x4`: alpha-test ON, func GREATEREQUAL, ref = `s_256AlphaTestRef = 100` when
    the texture is paletted else `s_ddsAlphaTestRef = 200` (acclient.c:454499–454511; constants
    acclient.c:45764–45765); if not already blending, src=ONE dst=INVSRCALPHA.
  - `TRANSLUCENT 0x10`: `curr_alpha = (1 − translucency) × 255`, and if not already blending,
    src=SRCALPHA dst=INVSRCALPHA blend ON (acclient.c:454513–454528).
- **Depth**: `SetDepthBufferMode(zfuncVal, write)` with write disabled for blended non-alpha-test
  surfaces (acclient.c:454542–454549 via `curr_texturea = singlePassDetailing || !blended`).
- **Fog**: `SetFFFogAlphaDisabled(1)` when fog is off OR the surface is `ADDITIVE`
  (acclient.c:454551–454560) — additive surfaces are exempted from fog-alpha.
- **Per-part lighting overrides**: `CPhysicsPart::SetLighting` writes the floats back into the
  part's `CMaterial` via `CMaterial::SetLuminositySimple/SetDiffuseSimple`
  (acclient.c:315325–315356); `CMaterial::SetTranslucencySimple` clamps via `CheckAlphaValues`
  (acclient.c:360594–360604). Anim hooks `LUMINOUS_HOOK=0x8 / LUMINOUS_PART_HOOK=0x9`
  (acclient.h:7288–7289; structs acclient.h:57483, 57492) drive these ramps over time.
- **Degrade/quality ladder**: `CPhysicsPart::UpdateViewerDistance` recomputes viewer distance
  (`CYpt`) per frame and reselects the gfxobj from the `GfxObjDegradeInfo` chain
  (declaration acclient.c:6280; body computes `CYpt = |viewer_pos − part_pos|` then indexes the
  degrade table); global kill-switch `degrades_disabled` (acclient.c:54820, 143203).

## 2. Ours map

| concern | Rust side | JS side |
|---|---|---|
| Surface (0x08) parse incl. trailing T/L/D floats + `color_value` | `crates/holtburger-dat/src/file_type/surface.rs:46–141` | — |
| Solid color → 1×1 RGBA texture | `apps/holtburger-web/src/lib.rs:6478–6482` (per unsurfaced-audit cite) | consumed via `SurfacePixels` getters (materials.js:2688–2699) |
| **Canonical flag decoder** (cache path: statics, buildings, cells, plain entities) | — | `MaterialCache._materialFromFlags`, materials.js:1816–2090 |
| **Duplicate decoder** (paletted/dyed gear + appearance hotswap) | — | `EntityManager._applyPalettedSurfaceRenderState`, entities.js:3405–3480; call sites entities.js:2682, 6716 |
| **No-decode path** (F.41 entity-owned recolour) | — | `MaterialCache._buildEntityOwnedFromPixels`, materials.js:2580–2640 (plain opaque material, materials.js:2606–2612) |
| Intentional VFX one-off (portal donut) | — | portal_space.js:147–155 (`MeshBasicMaterial`, energy tint, fog:false) |
| Texture wrap (clamp vs stipple) | — | materials.js:2110–2113 (cache path), materials.js:2635–2638 (entity-owned path G2 fix) |
| Shadow-cast gate (no retail analogue) | — | `materialCanCastShadow`, materials.js:93–103 |
| Lighting law (linear falloff + per-RGB clamp) | — | materials.js:1083–1222, flag read materials.js:985–1006; default-ON 2026-06-09 per docs/url-flags.md:121 (pending 1070 eye-test) |
| Per-part lighting ramps (Luminous/Diffuse/Transparent hooks 7–11, 20) | hook decode in wasm | animation.js:693–701 (ramp fields), applied via `_applyRampValueToMaterial` (entities.js, reads `__baseTranslucency` stashed at entities.js:3448–3455) |
| Degrade/LOD | `fetch_entity_degrade_for_distance` (lib.rs:7811 per unsurfaced-audit cite) | spawn-time pick entities.js:2343–2347; throttled dynamic recheck `_tickDynamicLod` (`?dynLod`, entities.js:585–604); statics use only `bands[0]` (statics.js:598) |
| PBR enhancements (category roughness/metalness, normal maps, POM, detail tiles) | classifier `crates/holtburger-dat/src/surface_classify.rs` (mirrored materials.js:105–122) | materials.js:160–169, 1992–2077 |

Statics/buildings/cells are unified on the cache: statics.js:20, 550, 930 paint via
`materialCache.getCached(surfaceDid)` — no independent decode there.

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | One surface→render-state decision point for ALL surfaces | acclient.c:454385 (sole funnel, called from draw acclient.c:454676) | materials.js:1816 (canonical) + entities.js:3405 (duplicate) + materials.js:2606 (no decode) | SPLIT-BRAIN (3 decode sites) | any future Surface fix must land 2–3 times; sites 1↔2 have already diverged (row 2) | untracked |
| 2 | Luminous emissive is texture-modulated (FF combiner: texture × (lighting + Emissive)) | acclient.c:454691–454697 + 454429–454432 | materials.js:1962–1964 attaches `emissiveMap=texture`; entities.js:3462–3465 explicitly does NOT ("NO emissiveMap"), citing the same retail line with the opposite reading | SPLIT-BRAIN (2 sites, contradictory) | a dyed luminous item (lifestone-blue gear, glowy dyed robe) washes to white while its undyed twin glows correctly | untracked |
| 3 | Recoloured/entity-owned surfaces get the same render-state as everything else | acclient.c:454385 (no special path exists) | materials.js:2601–2612 — plain opaque `MeshStandardMaterial`, comment "Future polish: thread surface_type flags through" | MISSING | F.41 recoloured NPC/gear surfaces with Translucent/Additive/ClipMap/luminosity render flat-opaque | untracked |
| 4 | ClipMap alpha-test ref is 100/255≈0.392 (paletted) or 200/255≈0.784 (DDS) | acclient.c:454506–454511; constants acclient.c:45764–45765 | materials.js:1941 and entities.js:3457 hardcode `alphaTest = 0.5` | DIFF-ALGO | foliage/fence cutout fringe width wrong, most visibly on DDS-sourced clipmaps (0.5 vs 0.784) | untracked |
| 5 | Additive surfaces are exempted from fog-alpha | acclient.c:454551–454560 (`SetFFFogAlphaDisabled(1)` when ADDITIVE) | materials.js:1863–1922 — `opts` carries no `fog` key, three.js default fogs additive materials (world fog applied loop.js:724–735 per audit) | DIFF-ALGO | distant flames/spell glows haze toward fog color instead of fading additively | untracked |
| 6 | INVALPHA blends INVSRCALPHA/SRCALPHA (inverse factors) | acclient.c:454478–454485 | materials.js:1878–1887, 1923–1929 routes 0x200 through the standard SRCALPHA/INVSRCALPHA branch | DIFF-ALGO | low — census-zero in retail base DAT | tracked: unsurfaced-render-audit 2026-06-09, "InvAlpha (0x200) true inverse blend" row (doc line 116) |
| 7 | Solid surfaces honour sub-255 alpha (`(1−translucency)×255` on `color_value`) | acclient.c:454447–454449 | alpha baked into the 1×1 RGBA (lib.rs:6478–6482) but material stays `transparent:false` (materials.js:1868) unless a transparency bit is set | DIFF-ALGO | low — solid surfaces ~3%, almost always alpha=0xFF | tracked: unsurfaced-render-audit 2026-06-09 (doc line 117) |
| 8 | Point/spot lighting law (linear falloff + per-channel clamp) feeding the material | (per G15: retail FF lighting law) | materials.js:1083–1222; flag default-ON since 2026-06-09 (url-flags.md:121), pending 1070 eye-test | DIFF-ALGO (gated) | colored torches wash to white when flag off | tracked: G15 |
| 9 | Degrade ladder: per-frame `UpdateViewerDistance` reselect + ALL bands | acclient.c:6280 (+ body: per-frame `CYpt` recompute and degrade-table index) | entities: throttled `_tickDynamicLod` behind `?dynLod` (entities.js:585–604); statics: only `bands[0]` (statics.js:598), instanced path hardcodes 100 m (statics.js:1049–1052) | DIFF-ALGO | LOD pop-in / wrong band on statics | tracked: G2 |
| 10 | Retail FF pipeline has no specular/PBR/normal-map/POM/detail-tile stack | acclient.c:454385–454565 (FF combiner only; Detail-flagged surfaces census-zero, materials.js:2017) | materials.js:160–169 (category roughness/metalness), 1992–2012 (normal maps), 2044–2077 (POM), 2014–2043 (detail tiles); `?flatDiffuse=retail` opt-out materials.js:1839–1851 | EXTRA (intentional enhance, partially flag-gated) | none (enhancement); gauge rule applies | tracked: L4 / port-enhance gauge |

**PARITY (verified, no work):**
- Blend ladder for Alpha / Alpha+Additive / pure-Additive / Translucent: acclient.c:454470–454528
  ↔ materials.js:1896–1943 (incl. the Wave-3 M1 SRCALPHA/ONE CustomBlending for
  Alpha+Additive) and the mirrored entities.js:3420–3455.
- Texture wrap CLAMP-unless-Stippled: acclient.c:454437 (+ acclient.h:5257) ↔
  materials.js:2110–2113 and 2635–2638.
- Depth-write off on blended surfaces: acclient.c:454542–454549 ↔ `depthWrite:false` in every
  blended branch (materials.js:1913, 1922, 1929).
- Luminosity/diffuse driven by the FLOATS, not the 0x40/0x20 bits: acclient.c:454452–454467 ↔
  materials.js:1888–1894, 1944–1977 (census-confirmed 2026-05-28).
- Solid `color_value` → 1×1 texture: acclient.c:454447 ↔ lib.rs:6478–6482 (modulo row 7 alpha).
- Per-part lighting hook ramps (Luminous/Diffuse/Transparent + Part variants): acclient.h:7288–7289,
  acclient.c:315325–315356 ↔ animation.js:693–701 + entities.js:3448–3455 (`__baseTranslucency`
  floor, mirroring acclient.c:316947–316956 per DIM7-5/W4.2).

## 4. Staged unification plan

Target shape: **one exported `applySurfaceRenderState(material, surfaceState, opts)` in
materials.js** — the JS analogue of `D3DPolyRender::SetSurface` — with `_materialFromFlags`,
`_applyPalettedSurfaceRenderState`, and `_buildEntityOwnedFromPixels` all reduced to callers.
Parser/cache split (Rust bakes pixels, JS owns three.js state) stays as-is; only the
flag→material decision unifies.

### Stage M1 — extract the single decoder (rows 1, 2)
- Scope: move the branch ladder of materials.js:1816–1977 into a standalone
  `applySurfaceRenderState(mat, {flags, translucency, luminosity, diffuse}, {texture})`;
  `_materialFromFlags` calls it on its fresh opts; entities.js:3405 becomes a one-line delegate.
  Resolve the row-2 contradiction INSIDE the one function (adopt the materials.js
  emissiveMap-attached reading — it is the one consistent with the FF-modulate combiner,
  acclient.c:454429–454432).
- Files: materials.js, entities.js. New module shape: export from materials.js (no new file).
- Flag: `surfaceUnified` (default-off; off = legacy dual-path). JS-live.
- Tests: headless-now — extend `test_f7_8_surface_bitfield.mjs` to assert byte-identical material
  props from both call paths for all flag×float combos; 1070-gated — dyed-luminous eye-test
  (lifestone, dyed glow gear).
- Rollback: flag off.

### Stage M2 — thread flags through the entity-owned path (row 3)
- Scope: `_buildEntityOwnedFromPixels` (materials.js:2580–2640) snapshots
  `surfaceType/translucency/luminosity/diffuse` before `sp.free()` (pattern already proven at
  entities.js:6707–6713) and calls the Stage-M1 function.
- Files: materials.js only. Flag: same `surfaceUnified`. JS-live.
- Tests: headless-now — unit test recolour path emits transparent/additive/emissive props;
  1070-gated — recoloured NPC with translucent robe.
- Rollback: flag off.

### Stage M3 — parity details (rows 4, 5, 6)
- Scope: (a) alphaTest ref 100/200 — needs a `hasPalette` boolean on `SurfacePixels`
  (**wasm-rebuild**; batch with other Rust work) then `alphaTest = hasPalette ? 100/255 : 200/255`;
  (b) `fog:false` on ADDITIVE-bit materials (JS-live) — closest three.js analogue of
  `SetFFFogAlphaDisabled`; (c) optional: true INVALPHA via
  `CustomBlending(OneMinusSrcAlphaFactor, SrcAlphaFactor)` — census-zero, do only if free.
- Flag: `surfaceParityV2` (default-off). Tests: headless-now unit asserts; 1070-gated foliage
  fringe + foggy-night flame eye-test.
- Rollback: flag off.

### Stage M4 — deferred (do NOT bundle)
- Row 7 (solid sub-255 alpha) and row 9 (statics multi-band degrade, G2): already tracked in the
  unsurfaced audit's wave plan; row 9's owner is the statics renderer, not the material mapper.
  Row 8 (G15) is its own default-ON-pending-eye-test item. Listing here only for the seam record.

## 5. Scores

- Leverage: subsumes/centralizes — unsurfaced-audit InvAlpha row, solid-ColorValue-alpha row
  (both become one-line cases inside the single decoder), the C1 follow-on note
  (entities.js:2676–2682), and the F.41 "future polish" debt (materials.js:2601–2605). Ends the
  class of "fix lands in plain path but not paletted path" regressions (row 2 is a live instance).
- Regression-risk reduction: **M-H** — three decode sites collapse to one; the two existing sites
  have already drifted once.
- Implementation risk: **L** (Stages M1/M2: pure JS refactor, flag-gated, prop-equality unit
  testable). Stage M3a: L but wasm-rebuild-batched.
- 1070-dependency: **Y** for final eye-tests (dyed-luminous, fog/flame, foliage fringe); N for
  the refactor + unit tests themselves.
- Depends-on: none of movement Stage 1. Seams: A9 owns setup→Object3D construction and polygon
  sides (the `CullMode` set at acclient.c:454683 is geometry-side, not surface-side); A11 owns
  particle materials; A5 owns the hook-ramp clock that mutates these materials (clone-on-write
  `__cacheOwned` strip at entities.js:7649–7655 must keep working after M1 — the unified function
  must be re-applicable to a cloned material).

## 6. SPECULATIVE / UNRESOLVED

- **Row 5 symptom severity**: I verified retail's `SetFFFogAlphaDisabled(1)` for ADDITIVE
  (acclient.c:454551–454560) and our absence of any `fog` handling in `_materialFromFlags`, but
  the exact D3D FF "fog alpha disabled" semantics (fog-to-black vs fog-skip for additive) were
  not traced into `RenderDeviceD3D::SetFFFogAlphaDisabled`'s body — the three.js `fog:false`
  proposed in M3 is the standard additive-particle treatment, not a verified 1:1 mapping.
- **Stippled rendering**: retail ORs `STIPPLED 0x40000000` and switches wrap mode
  (acclient.c:454437); whether retail ALSO does screen-door alpha stippling elsewhere
  (D3DPolyRender stipple pattern) was not located. Greps tried: `stipple`, `Stippled`,
  `isStippledOrAlphaedMask` — only the SetSurface wrap-mode use and the draw-call mask
  (acclient.c:454676) found. Our wrap-mode handling cites both sides; any additional stipple
  behavior is unresolved.
- **lib.rs line numbers** for the solid 1×1 bake (6478–6482) and `fetch_entity_degrade_for_distance`
  (7811) are carried from the unsurfaced-render-audit 2026-06-09 doc, not re-verified against the
  current lib.rs (file is ~10k lines; audit is 2 days old).
- **`gmPaperDollUI::ApplyPartSelectionLighting`** (acclient.c:220082) — UI paper-doll part
  highlight via SetPartLighting; UI/HUD is an excluded scope, noted only as a consumer of the
  per-part lighting API.
