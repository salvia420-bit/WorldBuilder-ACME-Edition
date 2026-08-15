# dat-patch round 2 — texture-aware triangles at ~4x

**Artist:** Opus 5 · **Date:** 2026-08-15 · **Brief:** round 1's verdict was *"if you add
triangles to a flat wall it's still a flat wall — we have to ACTUALLY USE the triangles, and the
placement has to be texture-aware, at 4x not 10x."* This is the assembled method, the ten boards
redone as real A/Bs, and the honest arithmetic of what 4x buys.

Everything is measured off read-only copies of `~/ac_base_dats/`. Nothing was written to a DAT,
nothing pushed, nothing committed. Working code: `/mnt/wbterminal2/dpc-work/`.

---

## 1. The streamlined method

One pipeline, five stages, no per-object authoring. Every routing decision below comes from data
already in the record or in the texture.

```
   Surface(0x08)                      polygon flags                 texture pixels
        |                                  |                              |
        v                                  v                              v
 +-----------------+              +------------------+          +-------------------+
 | 1. GATE         |  refuse ---> |  silhouette ops  |          | 2. HEIGHT FIELD   |
 | class + vetoes  |              |  PN / facet      |          | seam  or  ML      |
 +--------+--------+              +------------------+          +---------+---------+
          | pass                                                          |
          v                                                               v
 +-------------------------------------------------------------------------------+
 | 3. SUBDIVIDE + DISPLACE   outward along the AUTHORED normal, amp*height(uv),   |
 |    boundary-clamped so per-face UV seams cannot tear   (gfx_subdiv doctrine)   |
 +---------------------------------------+---------------------------------------+
                                         v
 +-------------------------------------------------------------------------------+
 | 4. QEM DECIMATE to the budget - original vertices LOCKED, boundary chains may  |
 |    only collapse along themselves. Flat areas collapse back to 1x; carved      |
 |    areas keep their triangles. THIS is the texture-aware placement.            |
 +---------------------------------------+---------------------------------------+
                                         v
 +-------------------------------------------------------------------------------+
 | 5. ATTRIBUTES FROM POSITION - uv and authored normal are recomputed in the     |
 |    SOURCE TRIANGLE's own affine frame, so the Remacri texture lands registered |
 |    with the carving by construction, and decimation carries no attributes.     |
 +-------------------------------------------------------------------------------+
```

### 1.1 The gate (WHETHER) — never optional

Order: Surface-field vetoes -> curated table -> SigLIP kNN corpus
(`tex-relief-classes.compact.json`, 20,684 textures) -> artist override.

| Veto | Source | Why |
|---|---|---|
| `Base1ClipMap` | Surface.type & 0x4 | alpha cutout card — foliage, fences |
| `Base1Solid` (no texture) | Surface.type & 0x2 == 0 | nothing to read |
| translucency > 0 | Surface.Translucency | sorts through the drawing BSP |
| luminosity > 0 | Surface.Luminosity | emissive decal |
| `CullMode.None` polygon | Polygon.SidesType == 1 | two-sided sheet: thickening splits it |
| `CullMode.Clockwise` polygon | Polygon.SidesType == 2 | back face has its own surface |
| `NoPos` polygon | Polygon.Stippling & 0x4 | invisible opening filler |

Classes that may carve: **Stone, Brick, Timber, Plank, Shingle**. Everything else (Flush, Cloth,
Foliage, Unknown) is refused and falls through to a silhouette op. **Board 10 is the proof this is
not optional**: the seam operator's response on the book's page texture is the *handwriting*, and
the ungated render on that board turns the lettering into geometry.

Three artist overrides were needed across ten objects, each made by looking at the texture:

| Surface | was | now | why |
|---|---|---|---|
| `0x08000742` | Flush (kNN) | Shingle | thatch — coursed straw with a hard course line |
| `0x0800017A` | Flush (curated) | Stone | cave cobble/boulder wall |
| `0x0800017C` | Flush (curated) | Stone | cave cracked rock face |

Both cave overrides are the same bug: the curated table was seeded on *exterior building* surfaces
and mislabels dungeon rock. That is a two-line table fix, not a method problem.

### 1.2 The height field (WHERE) — two complementary operators, routed automatically

* **seam** (port of `height_seam.rs`: multi-scale sign-agnostic tophat -> speckle suppression ->
  pillow). Answers to **thin-line structure**: mortar joints, plank gaps, beam/plaster shadow
  lines, thatch courses.
* **DeepBump** (`deepbump256.onnx` -> normals -> Frankot-Chellappa). Answers to **broad form
  shading**: creature hide, rock faces, bark grain, muscle lobes.

**Routing rule (new, and it generalises):** run seam; if its carved fraction is below 0.08 the
texture has no line network, so fall through to the ML field. The class gate still decides whether
either runs at all, so the ML operator can never reach a painted banner.

Measured side by side (`dpc-work/test_db.png`): on the Lugian torso seam finds *nothing* and
DeepBump recovers the muscle lobes exactly; on cave rock seam finds specks and DeepBump reads the
fissures; on brick it inverts — DeepBump inherits albedo polarity and makes dark bricks sink,
which is the precise trap seam was built to avoid. **They are complementary, and the class is the
router.**

### 1.3 Two operator bugs found and fixed this round

1. **`PRE_BLUR` must scale with the tile.** Every constant in the seam operator is a *fraction* of
   the tile except `PRE_BLUR = 0.6`, which is absolute texels calibrated on 128-pixel art. On a
   512-pixel texture — or any Remacri 4x upscale — 0.6 texels no longer removes the sub-structure
   it exists to remove, the tophat answers to noise instead of joints, and the field saturates.
   Measured on the gate wall: carved fraction **1.00** with mean height **0.06**, i.e. the whole
   face recedes rigidly and displacement is a no-op *again*. Fix: `sigma = 0.6 * min(w,h)/128`.
   **This is also the entire explanation of the Remacri over-carve** (section 3).
2. **Plateau normalisation after the gate.** Even with (1), a high-contrast masonry texture can
   push its p90 well below 1, leaving no proud face to carve *from*. Rescaling by p90 *after the
   gate has already said yes* restores the plateau. It cannot reintroduce the forbidden
   per-texture-normalisation trap, because a flat texture returns "no relief" before this point.

### 1.4 Displacement + decimation

Straight port of `gfx_subdiv.rs` to Python (`relief3d.py`), with its invariants kept:
outward-only, <= `MAX_AMPLITUDE_M` 0.10, welded per-source-vertex amplitudes, excluded polygons
pin their vertices, a boundary-edge ramp of `BOUNDARY_RAMP_M` 0.03 so per-face UV seams cannot
tear, and the emitted normal is `authored + (displaced_geometric - original_facet)` — without that
last term displacement is a bit-exact no-op on a Gouraud image.

The decimator (`relief3d.Decimator`) is quadric edge collapse with three constraints that make it
safe on DAT geometry:

* **original source vertices are LOCKED** — the silhouette corners and the footprint are identical
  to the retail record, which is what keeps the render mesh compatible with the unmoved physics
  hull;
* **boundary-chain vertices may only collapse along their own chain**, so both sides of a shared
  polygon edge simplify to the same polyline and no crack can open;
* **UV and normal are recomputed from position** in the source triangle's affine frame, so
  decimation carries no attributes and the texture stays registered with the carving.

**Control (the regression `gfx_subdiv`'s own tests care about):** at amplitude 0, subdivide (256x)
+ decimate (to 4x) is a **0.0000 grey-level** change on the rendered image. The pipeline only
changes the picture when the height field does.

### 1.5 The silhouette ops, for everything the gate refuses

| op | fires on | cost | what it does |
|---|---|---|---|
| **PN tessellation** | smooth-shaded organic parts (creatures, trunks) | exactly 4x at level 1 | curves each triangle onto the surface its authored normals imply; crack-free by construction. **Needs a max-deviation guard**: it is unbounded, and on the lifestone (a faceted gem with a few smoothed normals) it deviates 0.18 m — nearly 2x the displacement ceiling — and inflates the crystal into a blob. On the Lugian the same op stays at 0.055 m. |
| **facet** | flat-shaded props (crystals, gems, hewn stone, books) | exactly 3x | raises each triangle's centroid into a shallow pyramid; no edge moves, every silhouette corner exact |

Round 1's `plinth` / `opening_surround` / `belt_course` / `edge_frame` / `voussoir` remain valid
and compose on top — they spend different triangles (edges) than these do (faces).

**Why round 1's 10x looked like nothing, in one line:** midpoint subdivision puts new vertices *on*
the existing flat face and changes no normal, so under Gouraud the image is bit-identical. PN moves
them onto the implied curved surface; facet changes every facet normal; displacement moves them
along the normal by a *field*. All three change the picture; plain subdivision cannot.

---

## 2. Per-object routing and measured multipliers

| # | object | record | gate result | height source | subdiv | final | mult | max dev |
|---|---|---|---|---|---|---|---|---|
| 01 | cottage | GfxObj `0x0100082E` | 5 of 11 surfaces carve | seam (base) | 16 seg = 256x | 90 -> 360 | **4.00x** | 0.074 m |
| 02 | Lugian | Setup `0x02000A0B` | **all 14 refused** | — (PN op) | PN level 1 | 586 -> 2,344 | **4.00x** | 0.055 m |
| 03 | bridge | 4 GfxObjs `0x01000D72/6F/70/71` | both surfaces carve | seam (base) | 16 seg | 100 -> 399 | **3.99x** | 0.060 m |
| 04 | tree | Setup `0x0200062C` | canopy refused, bark passes | **ML** (seam < 0.08) | 14 seg = 196x | 158 -> 632 | **4.00x** | 0.055 m |
| 05 | sign | Setup `0x02000290` | both carve | seam (base) | 16 seg | 24 -> 96 | **4.00x** | 0.075 m |
| 06 | wall | GfxObj `0x01004706` | both carve at 1.00 | seam (base) | 16 seg | 88 -> 352 | **4.00x** | 0.069 m |
| 07 | cave | LB `0x018B`, 70 EnvCells | 5 rock surfaces carve (2 overrides) | **ML** | 12 seg = 144x | 1,203 -> 4,811 | **4.00x** | 0.070 m |
| 08 | lifestone | Setup `0x020002EE` | **all 3 refused** | — (facet op) | facet | 118 -> 354 | **3.00x** | 0.035 m |
| 09 | door | Setup `0x0200024F` | 1 of 4 carries relief | **ML** | 16 seg | 56 -> 224 | **4.00x** | 0.036 m |
| 10 | book | GfxObj `0x010006CD` | **both refused** | — (facet, 4 mm) | facet | 24 -> 72 | **3.00x** | 0.004 m |

Displacement-lane multipliers are exact by construction (the decimator is given a target). The
silhouette ops have fixed ratios: PN level 1 = 4x, facet = 3x (a second facet round would be 9x).

Where the triangles landed on the cottage — the number that answers *"are they texture-aware?"*:

```
Brick   22 ->  77  (3.5x)      Shingle 14 ->  65  (4.6x)
Plank    2 ->   2  (1.0x)      Stone   28 ->  91  (3.2x)
Timber  24 -> 125  (5.2x)      Flush        collapsed back to 1x
```

Timber — the surface whose height field has the most structure — took 5.2x while the refused
surfaces returned to their original triangle count. Nobody told it to.

---

## 3. seam on Remacri vs seam on base — the verdict

Carved fraction (fraction of texels displaced by more than 15% of full amplitude), same operator,
same physical scale; only the texture source differs:

| texture | kind | **base** | **Remacri** | base (old blur) | Remacri (old blur) |
|---|---|---:|---:|---:|---:|
| brick `0x080000DA` | relief | 0.04 | 0.03 | 0.04 | **0.36** |
| gate-wall stone | relief | 0.55 | 0.56 | 0.89 | 0.89 |
| gate-wall brick | relief | 0.55 | 0.51 | 0.86 | 1.00 |
| cottage stone | relief | 0.37 | 0.26 | 0.37 | 0.74 |
| half-timber | relief | 0.78 | 0.77 | 0.78 | 0.87 |
| thatch | relief | 0.40 | 0.30 | 0.40 | 0.88 |
| plank | relief | 0.10 | 0.19 | 0.10 | 0.89 |
| **stucco (must stay flat)** | FLAT | **0.02** | **0.24** | 0.02 | **0.89** |
| **pennant (must stay flat)** | FLAT | 0.22 | 0.23 | 0.22 | 0.24 |

**Verdict: run the height field on the BASE dat texture; render with Remacri.**

* With the absolute `PRE_BLUR` (as shipped) the upscale is unusable as a height source: it carves
  a *blank stucco wall* at 0.89 and a plank at 0.89. ESRGAN invents micro-contrast, and the
  operator's dead zone is an absolute luminance threshold, so invented contrast reads as joints.
* With the round-2 proportional pre-blur the two sources agree within ~0.1 on every real material —
  Remacri becomes *usable*, and on the plank it is arguably better (0.19 vs 0.10: it resolves a gap
  the 128-pixel base blurs away).
* But it still inflates a flat surface 12x (0.02 -> 0.24). The only thing standing between that and
  an embossed banner is the class gate, so there is no reason to spend the risk: **base for height,
  Remacri for pixels.** UV registration is identical either way (Remacri is a pure 4x upscale), so
  the carving and the shipped texture line up by construction.

---

## 4. Where the method fails, and why

1. **Creatures (board 02).** Every hide surface classes as painted, and correctly — seam's response
   on the Lugian face texture *is* the painted eye outline. Texture-driven displacement is
   unavailable. PN tessellation delivers the win instead (rounder shoulders, head dome, limb
   barrels) and DeepBump adds real muscle form that the 10-40-triangle parts cannot resolve at any
   sane budget. **Silhouette beats displacement on creatures.**
2. **Painted flats (board 10, the book; the lifestone crystal).** Nothing to carve, and carving
   would emboss content. Facet op, or nothing. The lifestone also exposed the PN guard above: on
   faceted geometry PN does not do nothing, it does something *wrong* (0.18 m of inflation), so the
   flat-shaded/smooth-shaded split between `facet` and `pn_tess` is load-bearing, not stylistic.
3. **Big buildings at texel scale (boards 01, 03, 06).** See section 5 — the arithmetic does not
   close.
4. **T-junctions.** Retail render meshes contain them, so a boundary edge of one polygon can be
   split by a vertex of its neighbour. Displacement pins boundary chains, but two chains describing
   the *same* edge with different vertex counts can differ by the welded-amplitude difference
   (a few mm here). A T-junction weld pass before displacement removes the class of bug entirely;
   it did not bite on these ten.
5. **Zero authored normals.** 6% of GfxObj records carry some zero SWVertex normals and a few — the
   Rithwic causeway modules among them — are 100% zero. `gfx_subdiv` correctly refuses to displace
   along a degenerate normal, so those records cannot be relieved at all until normals are
   computed; a Gouraud renderer also shades them ambient-only, so an uncorrected A/B compares
   *unlit* with *lit*. Both panels here substitute the area-weighted smooth facet normal, and the
   production writer must **store** those normals in the patched record.
6. **The signboard (board 05) is a near-miss worth flagging.** Surface `0x08000CF3` classes as
   Timber, but the texture is a board *with painted notices*, and the seam field outlines the
   notices. Here that happens to be physically right — paper on wood — but it is the same mechanism
   as the banner failure. Marginal class calls are where the gate needs human review.

---

## 5. The arithmetic that actually governs this project

**Relief has a cost per square metre, not per record.** To carve a 15 cm masonry joint you need a
vertex every ~7-10 cm, i.e. 200-400 triangles per square metre. Measured on the ten:

| object | surface area | source tris | vertex spacing at 4x | multiplier needed for 10 cm |
|---|---:|---:|---:|---:|
| cottage | 566 m2 | 90 | 1.77 m | **1,258x** |
| gate wall | 506 m2 | 88 | 1.70 m | **1,150x** |
| bridge module | 966 m2 | 24 | 4.49 m | **8,051x** |
| tree (bark only) | 14 m2 carved | 158 | 0.81 m | 18x |
| door (leaf only) | 4.8 m2 carved | 56 | 0.53 m | 17x |
| signpost | 2.1 m2 | 24 | 0.21 m | **17x** |
| book | 0.3 m2 | 24 | 0.08 m | already there |

So: on a *building*, 4x cannot resolve a mortar joint and never will — round 1's instinct to
subdivide harder was chasing a number three orders of magnitude away. On *small props* and on the
*carved subset* of a mixed object, 4x is within one order of the texel scale and sometimes already
at it.

**But the visual return saturates far earlier than the texel scale.** Image change vs multiplier on
the best masonry case (gate wall, identical camera and light, mean |after - before| in grey levels):

| multiplier | 2x | 4x | 8x | 16x | 32x | 64x |
|---|---|---|---|---|---|---|
| final tris | 176 | 352 | 704 | 1,408 | 2,816 | 5,632 |
| change vs original | 25.6 | 25.2 | 25.2 | 24.7 | 24.7 | 24.8 |

The aggregate deviation from the retail record is **flat from 2x to 64x**. Extra triangles do
change the picture (16x differs from 4x by 15.9 grey levels) — they redistribute relief into finer
detail — but they do not add *more* relief, because the low-frequency content of the height field
is what the eye reads, and 2-4x already carries it.

**That is the answer to "why 4x": 4x is not a compromise on this method, it is the knee.**

---

## 6. What the engineer must build to productionise

### 6.1 Ops for the registry

| op | status | notes |
|---|---|---|
| `displace_height` | prototyped here (`relief3d.build_displaced` + `Decimator`) | the main lane. The Rust `gfx_subdiv` already has the displacement half; what it never had is a real height source and a decimator. |
| `pn_tess` | prototyped (`relief3d.pn_tessellate`) | replaces the `organic_tess` prototype; crack-free without clamping, level 1 = 4x. **Two guards required**: skip `CullMode.None` cards, and clamp per-vertex deviation to `MAX_AMPLITUDE_M` — measured 0.18 m unclamped on the lifestone. |
| `facet` | prototyped (`relief3d.facet_op`) | 3x, silhouette corners exact, the right answer for every flat-shaded prop. |
| `edge_frame`, `voussoir`, `plinth+inset`, `module_link` | round 1's list, still needed | edge-cost ops; compose with the above. |
| **T-junction weld** | not built | pre-pass; removes failure mode 4.4. |
| **normal synthesis** | not built | compute + store smooth normals for the 6% of records with degenerate ones (failure mode 4.5). Must be written into the patched record. |

### 6.2 Plan schema (extends round 1's)

```jsonc
{ "record": "0x0100082E",
  "budget":  { "mult": 4.0, "mode": "decimate" },   // or "tris": 360
  "surfaces": {                                     // one entry per Surface id
    "0x08000742": { "class": "Shingle",             // override; else table/kNN
                    "why":  "thatch, coursed straw",
                    "op":   "seam",                 // seam | deepbump | auto
                    "amp_m": 0.07 } },
  "fallback": { "op": "pn_tess", "level": 1 },      // when the gate refuses all
  "invariants": { "lock_source_vertices": true,
                  "chain_collapse_only": true,
                  "pin_portal_polys": true,
                  "max_amplitude_m": 0.10 } }
```

The gate must emit its reasons (`why`) into the plan so a refusal is auditable, exactly as
`relief-plan-apply` emits `planErrors`.

### 6.3 Batch strategy over the 15,318-record catalog

1. **Classify once, catalog-wide.** The kNN corpus already covers all 20,684 textures. Spend artist
   time only on the ~200 surfaces with the highest placement counts *and* a marginal class call —
   that is where a wrong label is expensive (the two cave overrides here covered 330 of the sample
   dungeon's polygons).
2. **Cache height fields per RenderSurface, not per record.** 91 curated relief surfaces already
   cover 23% of all placements; the whole relief-allowed set is a few thousand fields. One field
   serves every record that uses it.
3. **Spend by lane, not by record count** (revising round 1's tiers with the section 5 arithmetic):

   | lane | scope | op | budget |
   |---|---|---|---|
   | **Dungeons** | 772 Environments, instanced 734,976 times | displace (ML on rock) | 4-8x — best value per byte in the project, and the source meshes are coarse enough for 4x to bite |
   | **Architecture** | ~2,000 large statics | displace (seam) + edge ops | 4x, plus round 1's edge ops where the silhouette needs it |
   | **Creatures** | 3,909 live SetupDIDs | `pn_tess` level 1 | 4x, fully automatic, no texture needed |
   | **Flat-shaded props** | crystals, gems, hewn rock | `facet` | 3x |
   | **Long tail <= 50 tris** | ~10,700 records | none | 1x — texture only |
   | **Foliage / banners / painted** | gate-refused | none | 1x — texture only |

4. **Byte budget.** At round 1's measured 111 B per added triangle and this shape of spend, geometry
   lands near 100-150 MiB of the 1,164 MiB headroom — comfortably inside it, and leaving the texture
   lane the room it needs. The 10x-everything plan (828 MiB) is off the table and, per section 5,
   would not have looked better.
5. **Verification.** The gate and the zero-amplitude control are machine-checkable; the eyeball pass
   is per-*Environment* and per-*surface class*, not per record — a bad height field shows up
   identically in every record that uses the surface.
6. **Still open from round 1:** the cell-dat export bloat (1.81 GB `client_cell_1.dat` with
   byte-identical content) must be fixed before any bulk dungeon patch, because the dungeon lane is
   the one that touches that file.

---

## 7. Reproduction

`/mnt/wbterminal2/dpc-work/` — all new this round:

| file | what |
|---|---|
| `gfxlib.py` | GfxObj / Environment / Surface parsing **that keeps per-face UVs and the surface table** (round 1's `datlib.py` discarded both). Also fixes round 1's `CullMode` bug — it read NegUVIndices on `CullMode.None` (=1) instead of `Clockwise` (=2), which is why 84 of 772 Environments failed to parse; all 772 parse now. Also: `SurfaceTexture.Textures` is a resolution chain whose leading entries live in `client_highres.dat` and are absent from a base install, so the rsId is the first entry that actually exists in the dat. |
| `matlib.py` | the gate (vetoes + curated table + kNN corpus) and the height field (seam port, speckle suppression, pillow, plateau normalisation, proportional pre-blur) + the DeepBump lane + the routing rule |
| `relief3d.py` | SourceMesh, welded amplitudes, subdivide+displace, QEM decimator, PN tessellation, facet op, attribute recompute, zero-normal substitution |
| `render3.py` | **textured Gouraud** software renderer (per-vertex light, per-pixel texture, alpha test, backface cull) — round 1 rendered untextured and flat-shaded, which is exactly why nothing was visible |
| `pipeline.py` | glue + artist overrides + the EnvCell/dungeon assembler |
| `r2lib.py`, `r01.py` ... `r10.py` | the boards |
| `measure_r2.py` | every table in sections 2, 3 and 5 |
| `db_height.py` | DeepBump height, run under the eval venv |

Boards: `/mnt/wbterminal2/dat-patch-concepts-r2-2026-08-14/01-cottage.png` ... `10-book.png`.
