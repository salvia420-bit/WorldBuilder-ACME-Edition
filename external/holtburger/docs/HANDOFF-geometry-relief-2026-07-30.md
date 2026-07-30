# HANDOFF — breaking the flat-texture look (session of 2026-07-30)

**Bottom line:** the goal is to stop AC buildings reading as year-2000 boxes with
paint on them. Three approaches were built and measured. **One works and ships
(structural rails). One is dead with a proven cause (per-texel displacement). One
is unbuilt and is the strongest remaining lead (window recesses).** A separate,
possibly larger win landed almost by accident: the normal map every lit static
uses was derived by an operator that *inverts on half-timber*, and is now
seam-derived at every quality tier.

Commits: `d0da9a92` `fdd9d0b6` `8cfb0802` `0c23fd66` `79884e1b` `649af238`
`09d3633d` `45c1eda0` `1e07eadf` (+ `ab56d786` `6d1ffe91` `494b1aea` `656e1542`
`272d67c3` from the texture half of the session).

---

## 1. THE ONE PARAGRAPH THAT MATTERS

A `MeshStandardMaterial` fragment's radiance is a function of
**(normal, albedo, uv, light)**. `position` reaches the image *only* via
silhouette, shadow map and aerial perspective. So **displacing vertices without
recomputing normals is a bit-exact no-op on the lit image** — measured RMS
against a flat wall was `0.00000` on brick, stone and timber, at every depth and
every subdivision level. 91 million displaced vertices produced the flat wall
they came from. The 4-triangle rails read as convincingly 3D for exactly one
reason: they emit a **fresh facet normal**.

That was a mistake documented as a design decision in a comment (*"the displaced
surface is shaded as the original smooth surface … avoids a normal recompute the
JS side does not do"*). It is fixed. If you add geometry to this renderer, emit
its normal.

---

## 2. WHAT SHIPS AND IS ON

| feature | flag | default | state |
|---|---|---|---|
| **Structural rails** OP1 convex-edge + OP3 material-boundary | `?gfxRelief` | **ON** mid/high/ultra | works; user-confirmed "complete success" |
| Per-texel displacement | `?gfxSubdivLevel` | **0 = off** | retired, see §4 |
| Seam-derived **normal map + height** | — | always | replaces the inverting luminance operator |
| BC7 textures | `?texBc7` | **ON** | measured *faster* than off |
| statics atlas normal/roughness/AO | `?statNra` | **ON** | was off; carried no cavity AO to atlased statics at all |
| procedural normal maps | `?normalMaps` | **ON** all tiers | was off on low/mid |
| cavity AO strength | `?aoIntensity` | 0.6 | new knob |

Measured on a GTX 1070 at Dryreach, quality=mid, 400 frames/arm: bare default
went **36.7 ms → 34.3 ms (27.2 → 29.2 fps)** while turning all of the above ON.
Compressed textures pay for the extra fragment work. Escapes verified live.

---

## 3. WHAT WORKS — the rails (`crates/holtburger-dat/src/gfx_remodel.rs`)

Purely additive geometry along mesh edges. **No existing vertex moves**, so
crack-freeness is a theorem rather than a test.

- **OP1** — chamfer cap on hard convex edges (60–165°, ≥1 m, manifold). 4 tris.
  Town: 1,970 fires / 8,229 m for +7,880 tris.
- **OP3** — proud strip where two *nearly coplanar* polygons carry **different**
  `pos_surface`. 4 tris. This is the one that works **indoors**: cellstructs have
  719 convex edges against 12,949 concave, so OP1 does nothing in a dungeon.
- Disjoint by construction (OP1 ≥60°, OP3 <60°), so no edge grows two rails.
- `pos_surface` is compared for **equality only** — never "what does this material
  look like". That is what makes it immune to the painted-banner false positives
  that killed every pixel-based approach.
- Live measurement: +24,258 verts (+4.2%), **395 atlas buckets in every arm** —
  zero added draw calls.

**Why it reads and displacement did not:** the rail is **6 cm wide** and emits a
facet normal. At 8 m a 6 cm feature is 7.7 px; a 1 cm mortar joint is 1.4 px.
*Both are 5 cm deep.* **Width, not depth, is what carried it.**

---

## 4. WHAT IS DEAD, AND WHY (do not re-litigate)

### 4a. Per-texel displacement — killed by sampling, not tuning

| | |
|---|---|
| carved joint width | 0.7–1.1 cm (~1 texel) |
| vertex spacing, level 4, 2.5 m edge | ~15 cm |
| vertex spacing, level 5 (ceiling) | ~4–8 cm |
| needed for 3 verts across a joint | ~0.2 cm ⇒ **level 9–11** |

Level 9–11 is 250k–1M triangles **per source triangle**. The band where vertex
geometry can represent detail and the band where AC's painted detail lives **do
not overlap** — a 5–10× Nyquist gap. Final measurement with normals fixed:
**0.211 mean-abs** on the plaster panel, pixel std 22.08 → 22.15. Nothing.

The code stays (`gfx_subdiv.rs`, `height_seam.rs`, the `SURFACE_HEIGHT` fetch
join) because `height_seam` now feeds the normal map. Only the default changed.

### 4b. Every pixel-derived way of deciding WHERE relief belongs

Four independent attempts, all failed:

- **luminance-as-height** — Tudor timber is DARK, plaster LIGHT, so it sinks the
  beams. Inversion −0.270.
- **2D Poisson (Frankot-Chellappa)** — fixes the row banding, **not** the
  polarity (integrating ∇L reconstructs L). Inversion −0.248.
- **colour segmentation** — fired on a red-and-white *banner* and a shield boss.
- **periodicity / rectangularity** — AUC **0.264** and **0.345**, i.e. *inverted*:
  flat textures are more periodic than AC masonry.

Stacking every gate: **3 of 91 relief textures pass, 4 of 79 flat ones do.** More
false positives than true. **A per-Surface gate is mandatory and must not come
from pixels.** The cheap version is Surface fields (`Base1ClipMap` / translucent /
luminous / `Base1Solid` → never).

### 4c. Discretising textures into per-brick solids

Rendering premise **confirmed** (proud slabs with chamfered edges on flat grey
read unmistakably as masonry) but segmentation fails: 64% of textures return the
whole tile as one connected component; watershed gives blobs (rectangularity 0.51
vs ~0.9); a lattice gives exact rectangles but locks onto harmonics (3–4 of 14).
Worst failure mode is **two brick patterns at different frequencies on one wall —
worse than flat**. Report: `/mnt/wbterminal2/read3d-agent-b/`.

### 4d. POM on statics — broken three independent ways

1. No geometry has tangents, so it fabricates one from the view direction; the
   parallax direction **rotates with the camera**.
2. It is fed the `height_from_luminance` operator (worst of ten).
3. Self-shadow uses a fake sun derived from the view dir.

Also the statics atlas mints a fresh material (`static_atlas.js:330`), discarding
the POM patch entirely — which is why it renders nothing on atlased statics.

---

## 5. THE STRONGEST REMAINING LEAD — window recesses

Not built. Scoped and measured; report at `/mnt/wbterminal2/remodel-approach-a/`.

The reframing that makes it work: **AC walls are not billboards with windows
painted inside them.** They are tiling material *plus a separate class of framed
panels and glazed windows that already are their own polygons with their own
Surface DID*. The most-placed building in the world (`0x01002228`) has 15
leaded-glass window quads distinct from its 124 brick polys. So the job is
"classify ~1,000 enumerable Surfaces", not "find rectangles in a facade".

- detection AUC **0.848**; at threshold 0.70, precision **0.952**
- **18 tris per opening**, net +16. Worst landblock **+3.2%** of a frame.
- 0.8 × 1.2 m openings recessed 10–20 cm sit **comfortably inside** the band
  geometry can represent — unlike mortar — and they break the **silhouette**,
  which is the thing POM and normal maps can never do.
- **Its own kill criterion, which I endorse:** hand-build ten openings on
  `0x01002228` and look at them on the 1070 *before* writing any detector.

Two corrections it produced that will bite silently otherwise:
- the "exact affine UV→world" result is a **tautology on triangles** (3 pts, 3
  unknowns); **13.1% of quads exceed 1 mm, max 4.48 m**. **Solve per triangle.**
- **tiling does NOT land on integers** — Δu near-integer only 9.5%. The tile
  phase is arbitrary in 85–95% of faces.

---

## 6. HARD CONSTRAINTS (all verified this session)

- **Never mutate `vertex_array`.** It is the single datum physics and rendering
  share. `GfxObj`/`CellStruct` carry `physics_polygons` + `physics_bsp` separately
  from render `polygons` + `drawing_bsp`, and no collision path reads the render
  triangle list — verified at every call site, and matching retail
  (`CGfxObj::find_obj_collisions`, acclient.c:356515). Adding render triangles is
  free; moving shared vertices moves collision.
- **Two insertion points**, or interiors are silently skipped:
  `append_gfx_tris_with_tex_swaps` (statics, building exteriors, indoor furniture,
  entities) and `append_environment_tris` (EnvCell interiors, dungeons).
- **No new draw calls.** Emitted tris must inherit the parent polygon's
  `surface_did` / `sides_type` / `stippling`. Verified: 395 atlas buckets in every
  arm of every experiment.
- **No custom vertex attributes.** `static_atlas.js normalizeForMerge` deletes
  everything except `{position, normal, uv}`. This is exactly how POM died.
- **Normals must be emitted from Rust.** JS never recomputes them on model
  geometry (`computeVertexNormals` has one caller, terrain-only).
- **Shadows cannot exclude added geometry** — baked positions are the same buffer
  the depth pass reads, and three.js has no per-pass geometry override. Extra tris
  are paid twice at quality ≥ mid.
- Exclusions that must never be relaxed: `sides_type == 1` (CullMode::None — the
  real alpha-card marker, 65,508 polys; `0x2` is only 1 poly and was the wrong
  constant until this session), `stippling & 0x04`, and CellStruct
  `portal_poly_ids`.
- Amplitude ceiling `MAX_AMPLITUDE_M = 0.10` bounds how far render geometry
  protrudes past the unmoved collision hull.

---

## 7. MEASUREMENT TRAPS THAT COST REAL TIME TODAY

- **ACE is single-login.** Reusing `tailnet1` within ~60 s fails as
  `no CharacterList within 30s`, which **reads exactly like a network fault**. I
  misdiagnosed it three times (blamed QUIC, then my own flag code, then a full
  disk). The driver waits 70 s *between* arms but needed a gap **before the
  first** one too.
- **Frame-to-frame noise exceeds the effect.** Two arms with byte-identical
  output drifted 5.25 mean-abs while the arm that genuinely differed drifted 2.66.
  **Always include a scale-0 / flag-off control that runs the same code path**,
  and a negative-control *region* (sky, or terrain for a statics-only change).
  A sky crop reading +43% is what caught one bogus measurement.
- **Vertex counts are trustworthy where pixels are not** —
  `__diag.geometry.relief().sampleVertexCounts`. Deterministic, immune to pose and
  lighting drift.
- **Read the flag back from the client, never infer it.** One whole 1070 session
  measured a no-op because `statNra` was on but `normalMaps` was gated off at
  `mid` — the carrier was armed and the source was closed.
- **A GTX 1070 matches no GPU allowlist** (RTX 20/30/40xx, RX 6/7xxx, Apple M) so
  it abstains to **`mid`**. Anything gated at `high` is invisible on the dev box.
- **At `mid` there are no shadows at all** — `shadowsEnabled` needs a literal
  `?shadows=on`, and `PRESETS.mid.csm` is false. `PRESETS.mid.shadows` is dead
  code.
- **A 38 GB ACE console log** in a `/tmp` session scratchpad filled the 117 GB
  system disk to 100% and killed the server. Restart script now at
  `/mnt/wbterminal2/ace-logs/start-ace.sh`, logging to external.

---

## 8. STALE DOCS FOUND EN ROUTE (worth fixing)

- `static_atlas.js:87-93` and `docs/url-flags.md:555` still call `?statNra`
  DEFAULT-OFF; the body is `let on = true`.
- `docs/url-flags.md:210` still says `gfxRelief` is off on every tier.
- `docs/url-flags.md:190` cites `index.js:970` for `?forcePom`; the real reader is
  `index.js:1621`.
- `memory/ace-live.md` restart recipe is now tested, and its log path changed.

---

## 9. ARTIFACTS

| what | where |
|---|---|
| rail-vs-groove analysis + rendered ablations | `/mnt/wbterminal2/read3d-agent-a/` |
| per-brick discretisation (no-go, with previews) | `/mnt/wbterminal2/read3d-agent-b/` |
| shader-side status table + renders | `/mnt/wbterminal2/read3d-agent-c/` |
| window-recess scoping (the live lead) | `/mnt/wbterminal2/remodel-approach-a/` |
| structural census, per-op trigger counts | `/mnt/wbterminal2/remodel-approach-b/` |
| seam operator reference + 10-way comparison | `/mnt/wbterminal2/gfx-material-agent/relief_op.py` |
| 1070 shot sets (rails, ladders, post-fix) | `/mnt/wbterminal2/{relief-shots,relief3,relief-ladder,amp-ladder,fixed-shots}/` |
| corrected texture corpus (20,684 PNGs) | `/mnt/wbterminal2/tex-reexport-2026-07-30/` |

**To resume:** serve `scratchpad/serve-bc7m.sh` → :8767, always `?nosw=1`; 1070
via `schtasks` + `launch-bc7.bat` (interactive session only — SSH-launched Chrome
gets no GL context), tunnel `-L 9333 -R 8767`. A person uses that box: offscreen
only, and match test Chrome by `--user-data-dir`, never `taskkill /IM chrome.exe`.

---

## 10. ADDENDUM (same day, follow-on session) — §4d overturned: POM ships

§4d called POM "broken three independent ways"; all three were implementation
bugs, not physics, and are now fixed. The per-texture per-texel treatment ships
as **`?statPom`** (ON at mid/high/ultra):

- the seam-height field rides the atlas **nra ALPHA channel** (`packNraLayer`
  prefers `mat.userData.heightTex` over texchan AO; 0 extra bytes/samplers/
  draw calls) — so height finally survives `makeArrayMaterial`'s wholesale
  material replacement, the exact mechanism §4d(3) died on;
- the bucket shader marches it with three's own **derivative tangent frame**
  (`getTangentFrame` — UV-correct, camera-stable; the legacy patch's
  view-space fabrication was the "rotates with the camera" bug), self-shadows
  toward the **real sun** (`directionalLights[0]`), and derives cavity AO from
  the same texel applied to indirect **and direct** light;
- the legacy singleton POM (EnvCells/dungeons, high/ultra) got the same S4
  fixes in place (`materials.js`), plus a real secant refinement (the old
  denominator clamp degenerated the weight to 0 on every crossing).

Verified live on the 1070 (mid, 8/4 steps, depth 0.04): 39/39 packed layers
carried height, 0 shader errors, statics-crop mean |dRGB| 2.26 vs terrain
control 0.000; uniform toggle `window.__statPom({on,depth,steps})` A/Bs live.
Shots: `/mnt/wbterminal2/statpom-shots/`. §5 (window recesses) remains the
strongest GEOMETRY lead — statPom is its per-texel complement, not a rival.
