# Geometry lanes — feasibility + method design (RESEARCH, 2026-08-20)

Turnkey design doc for the remaining PORTAL/GEOMETRY Phase-4 lanes of
PLAN-2026-08-18-hedonic-allocation.md §4: **4.P4** (creature/animated-GfxObj
subdiv spike), **4.P3** (env-variant re-cut), and TODO-#4 dungeon + creature
GEOMETRY enumeration. This is research only — no code, no dats, no lane runs
were touched. Every mechanism below was read in a primary source; file:line
citations throughout. Where a claim could not be verified from source it is
flagged **UNVERIFIED** with the exact check a later session must run.

Current state going in (reports/phase4-fill-RESULTS.md:50-60,
TASKLIST-2026-08-20-phase4-fill.md §Session 2): 4.P1 scenery and the static
statics-tranche are shipped; 4.P2 band-object lane closed as a clean negative;
4.P3 is parked "not turnkey — needs a staged portal-lineage session"; 4.P4 was
never attempted.

Primary sources used (reach order):
- decomp `~/ac-headers/acclient.c`, `acclient.h`
- ACE DatLoader `~/ace-server/Source/ACE.DatLoader/FileTypes|Entity/`
- lane code `tools/dat-patch/{tranche,pilot,relief3d,env_geo,gfxlib,datlib,matlib}.py`,
  `variant_release.sh`, `audit_carve_orientation.py`
- dossiers `docs/dat-patch/reports/client-headroom-dossier.md`,
  `HANDOFF-env-variant-design-2026-08-16.md`

---

## 1. 4.P4 — creature / animated-GfxObj subdiv spike

**Verdict: FEASIBLE.** AC creature animation is rigid part-hierarchy animation
with **no per-vertex skinning**, so subdividing a part's render mesh cannot
break animation as long as (i) the part's GfxObj id and its slot in the Setup
part list are preserved, and (ii) physics/collision data is left verbatim — both
of which the *existing* `obj-import` path already guarantees. The one genuinely
new guard for creatures vs. the static tranche is that a creature Setup resolves
to many part GfxObjs, and the per-GfxObj degrade guard (§1c) must run on **each
part**, not on the Setup.

### 1a. Skinning: how AC creatures deform — rigid parts, not bone weights

The animation format carries no per-vertex weights or bone-influence data. Read
end to end:

- **Setup (0x02)** — `SetupModel.cs:23-42,46-106`. A Setup is a list of part
  GfxObj ids (`Parts`, all 0x01-types — comment line 55-58), an optional
  `ParentIndex` hierarchy (`SetupFlags.HasParent`, 60-64), optional
  `DefaultScale` per part (66-70), and `PlacementFrames` — a dict of
  `PlacementType`, each holding **one Frame per part** (75-85, comment
  "there is a frame for each Part"). No vertex arrays, no weights.
- **Animation (0x03)** — `Animation.cs:16-38`. Fields are `NumParts`,
  `NumFrames`, and `PartFrames` = a `List<AnimationFrame>` (one per keyframe).
- **AnimationFrame** — `AnimationFrame.cs`: `Frames.Unpack(reader, numParts)` →
  **one `Frame` per part** per keyframe, plus animation hooks.
- **Frame** — `Frame.cs:6-11`: `Vector3 Origin` + `Quaternion Orientation`. A
  rigid transform. That is the entire per-part animation payload.

So a keyframe assigns each part a rigid (position, orientation). The part's mesh
is a whole GfxObj that is transformed as a unit; individual vertices within a
part are never moved by animation.

Decomp confirms the runtime applies exactly this:
- `CPhysicsPart` holds `CGfxObj **gfxobj; unsigned deg_level; ...` and draws
  `gfxobj[deg_level]` (`acclient.h:31155-31159`, quoted in
  reports/client-headroom-dossier.md:438-449).
- `CPhysicsPart::calc_draw_frame` (`acclient.c:315066`) works on
  `this->draw_pos.frame` via `Frame::operator=` / `Frame::set_vector_heading` /
  `Frame::rotate_around_axis_to_vector` — a rigid per-part frame; it never
  touches vertex data. `CPhysicsPart::Draw` at `acclient.c:314587`.

The `skin`/`bone`/`weight` symbols in the decomp are **not** the creature model
path and must not be mistaken for it:
- `skin` in AC = character skin *palette* recolour (`GetSkinShadeFromID`,
  `_skin_palette`, `skinShade`) — a texture/palette operation, not geometry.
- The true GPU-skinning symbols (`m_IBTrickVertexSkinningID`,
  `m_InfluencedBoneIndexArray`, `SetMatrixWeight`, `NumDestWeights`) are owned by
  **`RenderMeshBatch`** (`acclient.c:140525-140536` — `RenderMeshBatch::
  RenderMeshBatch` sets `m_IBTrickVertexSkinningID = 0`), a low-level D3DX
  index-buffer-trick render batch. `init_D3DXPSGPUpdateSkinnedMesh`
  (`acclient.c:11561`) is a weak D3DX library thunk (`acclient.c:45988`
  `// weak`). None of this is fed by the Setup/GfxObj/Animation DAT format,
  which has no weight or influence fields (loaders above). Conclusion: the
  D3DX skinned-mesh helpers are dead-ish library scaffolding w.r.t. AC content;
  the shipped creature path is part-frame rigid animation.

**Consequence for subdivision:** subdividing a part GfxObj's *render* mesh
(exactly what `relief3d`/`pilot` already do for building GfxObjs) changes only
that part's drawn triangles. Because the part is transformed rigidly as a unit,
a denser mesh follows the animation frame identically — there is no weight
re-binding to get wrong. This is the crux of the FEASIBLE verdict.

### 1b. The physics-untouched invariant — what must NOT change

Physics/collision data that rides a creature and must be preserved bit-for-bit:

- **Per-GfxObj physics polygons + physics BSP.** `gfxlib.parse_gfxobj`
  (`gfxlib.py:180-197`) reads the `phys` polygon list and a separate physics
  BSP, distinct from the drawing polys/BSP. The static importer already carries
  these verbatim: `obj-import ... preservePhysics=True, gfxObjOnly=True`
  (`pilot.py:292-295`, `tranche.py:606-609`), i.e. it replaces only the drawn
  shell and re-appends every original polygon + the drawing BSP unchanged
  (`pilot.py:211-215`, importer contract). The same flags apply unchanged to a
  creature part.
- **Setup-level collision + sort/select volumes.** `CylSpheres`, `Spheres`,
  `SortingSphere`, `SelectionSphere`, `Height`, `Radius`, `StepUpHeight`,
  `StepDownHeight` (`SetupModel.cs:29-36,87-94`) live on the **Setup**, not the
  part GfxObj. A part-only `gfxObjOnly` patch never opens the Setup record, so
  these are structurally untouched. **Do not** rewrite the Setup.
- **The GfxObj DID graph.** The GfxObj's `degrade` DID (`gfxlib.py:194`), its
  surface DIDs, and its physics references must survive. `gfxObjOnly=True`
  keeps the record identity (same 0x01 id) so every Setup part slot,
  MotionTable/Animation part index, and `CObjMaint`/DBOCache reference resolves
  to the same object — only the drawn geometry inside it changes.

Net: the creature spike needs **no new preservation machinery** beyond what the
static tranche already ships. The invariant is "patch the drawn shell of one
part GfxObj, leave physics polys, physics BSP, and the whole Setup alone."

### 1c. The degrade-band guard, applied to Setups

The guard is a **per-GfxObj** rule (dossier §5a, decomp-verified): when a GfxObj
carries a `GfxObjDegradeInfo` (0x11) record, `CPhysicsPart::LoadGfxObjArray`
(`acclient.c:314892`) fills the draw array **exclusively** from the degrade
bands (`acclient.c:314920-314951`); the root GfxObj is inserted at no index,
including 0 — the root is used only in the no-degrade `else` branch
(`acclient.c:314955-314962`). Band 0 is frequently a *different* GfxObj (worked
example `0x0100226A` → band0 `0x010022B8`, dossier:467-471). Patching a carrier
whose band 0 is not itself is invisible at every distance.

The static tranche implements this as: no degrade → patch; degrade & band0==self
→ patch; degrade & band0!=self → **exclude + defer** (`tranche.py:39-67`
policy, `309-330` enumerate impl, re-checked at build `459-463`). Portal
mechanics: `parse_degrade_info` (`gfxlib.py:235-253`), `Portal.degrade`
(`gfxlib.py:294-306`).

For creatures the Setup itself has **no degrade field** (`SetupModel.cs` has no
such member — Setup ends at the Default* DIDs, 101-105). Degrade is purely a
GfxObj (0x01) property. Therefore the guard is applied to the **parts**: resolve
the Setup to its part GfxObjs (`pilot.resolve_gfx` already does this for 0x02 —
`pilot.py:94-101`, via `datlib.parse_setup` `datlib.py:108-128`), then run the
identical band0-not-self guard on each part id. A part that is a non-self
degrade carrier is excluded exactly as a static record would be; its band
objects go to the deferred lane. **band-0-not-self must be excluded for the same
reason as statics: the client would draw the band object, never the root you
patched.** (Note 4.P2 closed the static deferred tail as a negative — all band-0
objects were gate-refused, RESULTS.md:44-47 — so expect the creature deferred
tail to be small and possibly also all gate-refused.)

**UNVERIFIED / to check on the POC:** whether creature part GfxObjs commonly
carry degrade records at all, and whether animated parts ever share a GfxObj id
across multiple part slots of one Setup (a shared part would be subdivided once
and appear denser in every slot — acceptable, but note it). Both are cheap to
census with `Portal.degrade` + `parse_setup` over the enumerated part set.

### 1d. Additional watch-items specific to animated parts

- **UV-frame / normal machinery is position-based and animation-agnostic.** The
  subdiv recipe recomputes UV and authored normal as pure functions of the
  undisplaced source-triangle frame (`relief3d.finalize`/`TriFrame`
  `relief3d.py:906-1013`, `vbary` provenance), and the decimator locks original
  source vertices (silhouette + physics footprint) and forbids cross-frame
  collapses (`Decimator` docstring `relief3d.py:519-556`). Nothing there reads
  world placement, so it is unaffected by the part being animated. Good.
- **Zero-normal substitution** (`relief3d.py:213-245`) already exists; creature
  parts that ship zero SWVertex normals get the smooth facet substitute like any
  record.
- **Orientation veto (§2) is a floor-sink guard for walkable surfaces.** It is
  driven by world-up facet normals (`relief3d.py:171-211`). For a creature part
  in its *authored* space, "up" is not the world floor, and the player does not
  stand on a creature. The spike should build creature parts with
  `orientation="off"` (the `SourceMesh.from_record` override exists,
  `relief3d.py:127-168`) — otherwise the veto silently deletes any up-facing
  shell for no benefit. This is a one-argument change, but it must be made.
- **Silhouette op choice.** Buildings carve wall-textured planes (recipe C). A
  creature limb is a curved organic silhouette, not a masonry plane; the texture
  gate (`matlib.classify`) will refuse most creature surfaces as
  `Flush`/`Organic` (`matlib.py:83-103`, `MACRO_OK` at `62`). The right op for
  creatures is therefore **PN-triangle silhouette tessellation** or the **facet
  op**, both already in `relief3d` and explicitly documented as "the SILHOUETTE
  op for everything the texture gate refuses: creature limbs, tree trunks,
  crystals" (`relief3d.pn_tessellate` `relief3d.py:1016-1027`; `facet_op`
  `1140-1152`). PN tessellation is crack-free by construction (edge control
  points depend only on endpoint positions + authored normals) and skips
  two-sided alpha cards. **This is the material difference from the building
  lane: creatures are a silhouette-subdivision problem, not a
  displacement-carving problem.** The subdiv itself is still safe under §1a; only
  the op that spends the triangles changes.

### 1e. Minimal proof-of-concept a later session runs

1. **Pick one creature part.** From `LSD/weenie_summary.jsonl` take a
   high-exposure creature `setupDid` (e.g. a Banderling / Drudge), resolve to
   parts via `datlib.parse_setup`, pick the largest-tri part GfxObj (torso).
2. **Guard it.** Run the band0-not-self degrade guard (`Portal.degrade`); confirm
   band0==self or no degrade. Skip/defer if not.
3. **Subdivide** the part with `relief3d.pn_tessellate(level=2)` (or `facet_op`),
   `orientation="off"`; write OBJ; import into a **COPY** of the portal with
   `obj-import ... preservePhysics=True, gfxObjOnly=True, overwrite=True`.
4. **Verify animation is intact** — this is the load-bearing check:
   - Offline: `validate.py`-style physDrift == 0 (physics polys/BSP
     byte-identical), drawing BSP carried, part id unchanged, Setup record
     byte-identical.
   - **In-client (mandatory, per §1070 rule):** spawn the creature on the live
     ACE laptop (`@create <wcid>` via `sendChat`, memory §ace-admin-cmds) and
     watch a full motion cycle (walk + an attack) at close range. Animation is
     "not broken" iff the denser part tracks the skeleton identically to retail —
     no part detaches, lags, or inverts. Because parts are rigid (§1a) the
     expected result is a visually denser but identically-moving creature.
5. **Negative-result exit:** if any part detaches or the Setup refuses the
   part-only patch, write the negative result and stop (PLAN §4 fork). Given the
   format evidence, detachment is not expected; the realistic failure mode is
   "no visible improvement because PN tessellation is a no-op on flat-shaded
   parts" — for which `facet_op` is the documented fallback (`relief3d.py:1140`).

---

## 2. 4.P3 — environment-variant re-cut

The env-variant lane (`env_geo.py`) mints one variant Environment per
texture-cluster, clones the source env verbatim, appends a displaced shell built
with that cluster's textures, and retargets the cluster's EnvCells to the variant
(`env_geo.py:1-28` module doc; `cluster` `329-470`, `variant_build` `489-557`,
`variant_apply` `560-614`). r5 shipped 3,924 variants / 306,010 retargets and
passed the 1070 gate (HANDOFF-env-variant-design-2026-08-16.md:3-6).

### 2a. The orientation veto (C2) is already wired

The floor-sink veto lives **in the displacement machinery**, not in eligibility,
because stone/brick *floors* wear wall textures and pass the texture gate
(`relief3d.py:35-61` rationale; `pilot.py:41-47`). Mechanism:
`SourceMesh.apply_orientation_gate` (`relief3d.py:171-211`) computes each carving
poly's area-weighted **facet** normal (`facet_area_nz` `79-98`) and, when
`nz > UP_NZ` (default 0.7), either vetoes the poly (default `UP_MODE="veto"` →
`amp=0, h=None`, no shell emitted) or clamps it to `UP_CLAMP_M`. It runs on the
record in its own space; the C1 audit confirmed dungeon EnvCells place yaw-only
(11,133/11,133), so env-local z == world z (`relief3d.py:56-58`).
`env_geo._shell` already builds through `SourceMesh.from_record` and reports the
gate per variant (`env_geo.py:147-151,172,220`). The measured exposure that
justified it: `audit_carve_orientation.py` found 28.0 % of shipped variant shell
**area** and 22.9 % of its polys up-facing (`relief3d.py:41-42`;
audit script `audit_carve_orientation.py:1-9,100-124`).

So the veto is code-complete and default-on. **The re-cut is a re-run, not new
code** — its only blocker is portal lineage (§2b).

### 2b. The PRE-envgeo portal lineage problem (why a re-cut needs staging)

`variant_release.sh` requires the release `client_portal.dat` to be the
**PRE-envgeo** portal (`variant_release.sh:8-11`, verbatim):

> `client_portal.dat = the PRE-envgeo portal (variants supersede the r4 7-shell
> pilot — cloning pilot-appended sources would double-shell; use
> client_portal.dat.pre-envgeo)`

Why double-shelling happens: `variant_apply` does **environment-clone →
environment-append-geometry → envcell-retarget** (`env_geo.py:566-580`). The
clone copies the *source* Environment 0x0D record byte-for-byte, then appends a
fresh displaced shell (`env_geo._shell`, `_write_obj` grouped by surface index
`env_geo.py:257-296`). If the source env you clone **already carries an appended
shell** from a prior env-geo run (the r4 7-shell pilot, or a previous variant
pass), the clone inherits that shell and the new append lays a *second* shell on
top — two coplanar displaced skins, z-fighting and doubled bytes. The invariant
is: **variants must always be cloned from a portal whose Environment records are
retail-original (never env-geo-appended).**

reports/phase4-fill-RESULTS.md:52-55 and TASKLIST-2026-08-20 §Session 2 confirm
this is exactly why 4.P3 is "not turnkey": the shipped r8/r9 portal already has
env-geo shells, so re-cutting on it would double-shell.

**Exact staging a later session must set up:**

1. **Source portal = a pristine, pre-env-geo portal.** Either the retail base
   `~/ac_base_dats/client_portal.dat` (READ-only per constraints — copy it) or a
   preserved `client_portal.dat.pre-envgeo` snapshot. This portal must contain
   the r8/r9 **texture + statics** work but **no env-geo Environment appends**.
   **UNVERIFIED — the single highest-risk staging question:** does such a
   snapshot exist? The HIFI split (PLAN §3) moved textures to `client_highres.dat`
   and geometry stays portal-side; the statics-tranche + scenery collapses are
   *portal* edits, but the env-geo variants are also portal edits layered on the
   same file. A later session MUST confirm whether a portal exists that has
   statics/scenery but not env-geo variants. If not, the env-geo variants must be
   re-derived onto a statics/scenery portal from scratch (clone/append/retarget
   is deterministic from `variants.json`, so this is a re-run, not re-authoring).
   Locate candidates with `ls -la` over the dat-patch work dirs
   (`/mnt/wbterminal2/dat-patch-*`) and check each with a
   `cell-portal-graph`/env-record census before trusting it. Do **not** write to
   base dats.
2. **The clone→append→retarget flow** (unchanged, `env_geo.variant_apply`):
   stage `<export-dir>/client_portal.dat` = the pre-envgeo portal copy,
   `<export-dir>/client_cell_1.dat` = base cell copy (`variant_release.sh:19-24`).
   `variant_release.sh` then: preps a free arena (`texture_lane.prep_dat`,
   DRW allocator workaround, `28-33`) → `variant-apply` → `fixup_dat` both dats
   (`39-46`) → `variant_verify.py` (strict parses, source-prefix match, retargets
   landed, `48-49`) → `cell-portal-graph-sweep` gated equal-to-base
   (`51-89`) → `release.sh` (`91-92`). The EnvCell retargets are u16 in-place
   rewrites in the cell dat and are independent of portal lineage, so only the
   *portal* needs the pre-envgeo source.
3. **Re-run `cluster` + `variant-build` first** if `variants.json` is stale or if
   WALL_CLASSES is being widened (§2c) — the cluster signatures depend on which
   classes count as wall-eligible (`env_geo.py:355-363,392-403`), so widening
   changes the cluster set and every downstream file.

### 2c. Wider WALL_CLASSES coverage (C4) — what it is, what it buys/costs

`WALL_CLASSES = {"Brick", "Stone", "Plank", "Timber"}` (`pilot.py:48`). It is the
single eligibility knob shared by both geometry lanes: the building recipe
(`pilot.recipe_c_source` `pilot.py:244`) and the dungeon lane
(`env_geo.py:92,145,360`) both gate on `m["cls"] in WALL_CLASSES and
m.get("h") is not None`.

The class taxonomy is defined in `matlib.py`:
- `MACRO_OK = ("Stone", "Brick", "Timber", "Plank", "Shingle")`
  (`matlib.py:62`) — the classes that even get a height field.
- `CLASS_AMP` gives per-class amplitude incl. `"Shingle": 0.070`
  (`matlib.py:66-68`).
- `classify` (`matlib.py:83-103`) returns one of Stone/Brick/Timber/Plank/
  Shingle/Flush/Cloth/Foliage/Unknown, with `Flush` vetoing translucent,
  luminous, clipmap, or textureless surfaces.

**What is currently in vs out:** `Shingle` is the one class that has a height
field and a real amplitude but is **excluded from WALL_CLASSES**. Everything else
outside WALL_CLASSES (`Cloth`, `Foliage`, `Flush`, `Unknown`) has `CLASS_AMP == 0`
and/or is vetoed by `classify`, so it cannot carve regardless. Therefore
"widening WALL_CLASSES" concretely means **adding `Shingle`** (roof/tile
surfaces).

**What it buys:** shingle roofs and tiled surfaces start carving, extending the
proven 4–6× relief to a visible outdoor class (PLAN §2 rank-5 logic: widen the
lane to uncovered high-exposure classes).

**What it costs / the catch:** shingle surfaces are predominantly **up-facing**
(roofs). With the orientation veto on (§2a, default), up-facing polys emit no
shell (`relief3d.py:200-208`) — so on outdoor buildings, adding Shingle buys
little net geometry (most of it is vetoed) and any that survives is on
steep/vertical roof faces only. In **dungeons** (the env-geo lane) shingle is
rare, so the buy there is near-zero. Net assessment: widening to Shingle is
cheap to try but expect a small yield under the veto; it is not the headline of
4.P3 — the headline is the veto re-cut itself (fixing the feet-sink debt and
recovering the wasted up-facing triangles measured at 28 % of shell area).

**Beyond Shingle**, "wider coverage" would require lowering `classify`'s veto
bars (translucent/luminous/clipmap) or adding new class→amp entries — out of
scope and risky (those vetoes exist for correctness). Recommend: widen to Shingle
only, and measure the surviving (non-vetoed) shell before committing.

### 2d. Re-cut recipe (turnkey)

Inputs: a **pre-envgeo portal** (§2b step 1 — the gating unknown), a base cell
dat copy, the `WALL_CLASSES` decision (§2c).

```
# 0. stage a clean run root + export dir (copies only; never base dats)
#    <root> gets variants.json/retargets.jsonl/obj/; <export> gets the two dat copies
# 1. (only if widening) edit WALL_CLASSES in pilot.py to add "Shingle", then:
env_geo.py cluster       --root <root> [--top N] [--min-cells M]   # -> variants.json
env_geo.py variant-build --root <root> [--skip-existing]           # -> obj/, variant_imports.jsonl, retargets.jsonl
# 2. one-command release (uses the PRE-envgeo portal in <export>):
WBT=<...WorldBuilder.Terminal.dll> variant_release.sh <root> <export> <tag>
#    = prep arena -> variant-apply(clone->append->retarget) -> fixup both dats
#      -> variant_verify -> cell-portal-graph-sweep(==base) -> release.sh
# 3. audit the veto actually saved the up-facing shell:
audit_carve_orientation.py <patched_portal> <retail_portal> <retail_cell> <root>/variants.json --out report.json
#    expect up-facing shell fraction ~0 (was 28% pre-veto)
# 4. mandatory 1070 in-client gate (feet-sink gone; no relief seams at cell edges)
```

The orientation veto needs no flag — it is default-on in `relief3d`
(`UP_MODE="veto"`, `relief3d.py:60`). If a lane ever wants up-facing relief back
(e.g. ceilings are already kept; roofs are not walkable) it passes
`orientation="clamp"` to `from_record` (`relief3d.py:127-168`), but the re-cut's
whole purpose is the veto, so leave it default.

---

## 3. Un-built dungeon + creature GEOMETRY lanes (enumeration/coverage)

### 3a. What tranche.py's static-architecture approach does NOT cover

`tranche.py` enumerates **outdoor static placements only**: it walks every
`LandBlockInfo` (`0x____FFFE`) record in `client_cell_1.dat` and takes its
`buildings[]` and `objects[]` placement lists (`tranche.py:18-29`,
`_collect_placements` `187-201`, `pilot.parse_lbinfo` `pilot.py:62-91`). Each
placement names a model id (0x01 GfxObj or 0x02 Setup) resolved to GfxObjs
(`pilot.resolve_gfx` `pilot.py:94-101`). This covers the ~1,921 outdoor
architecture GfxObjs and nothing else.

**Dungeon interior geometry does not live in LandBlockInfo placements.** It lives
in the **Environment (0x0D) / CellStruct + EnvCell** path:

- An **EnvCell** (indoor cell record, id `0x____0100`–`0x____FFFD` in the cell
  dat) carries a per-cell **surface array**, an Environment id, and a CellStruct
  index. Parsed by `env_geo._cell_walk` (`env_geo.py:52-61`): `ns` surfaces at
  offset 16, then `(env, cs)` immediately after. Full parse:
  `datlib.parse_envcell` (`datlib.py:254`).
- The **Environment (0x0D)** record holds the actual **CellStruct meshes** —
  vertices, normals, UVs, polys, physics polys, portals, and drawing/cell/
  physics BSPs — the same primitives as a GfxObj (`datlib.parse_environment`
  `datlib.py:218-231`; `gfxlib.parse_environment` `gfxlib.py:200-231`).
- **The structural difference:** a CellStruct polygon's surface index resolves
  through **each EnvCell's own surface array**, not through the mesh record. So
  one prefab CellStruct renders as stone in one dungeon and ice in another
  (`env_geo.py:5-8`). Cell-weighted, only ~36 % of slot usages have a
  ≥90 %-dominant texture (`env_geo.py:6-8`). This is precisely why the dungeon
  lane needs the **variant** mechanism (§2): you cannot displace the shared
  CellStruct once, because its texture — and therefore its correct relief height
  field — differs per EnvCell. `tranche.py` has no concept of this indirection.

So the "un-built dungeon lane" is not un-designed — `env_geo.py` **is** the
dungeon geometry lane, and it shipped in r5. What remains un-built for dungeons
is **coverage beyond the clustered wall-cells**:

- `env_geo.cluster` only mints variants for the `--top` (env,cs) pairs whose
  wall-cells cluster to ≥`--min-cells`, and only ships a landblock when **every**
  wall-cell in it lands in a surviving cluster (all-or-none, to avoid relief
  seams at cell boundaries — `env_geo.py:329-339,405-423`;
  HANDOFF-env-variant-design §4 lines 99-101). Cells below the cutoff, and
  non-wall-class cells, are never displaced. Widening coverage = raising `--top`,
  lowering `--min-cells`, and/or adding Shingle (§2c) — bounded by the env-id
  space (`0x0D00FFFF`, `env_geo.py:439-441`) and the byte budget.

**Enumeration strategy (dungeons):** it already exists — walk EnvCells
(`_cell_walk`), census per-(env,cs,slot) dominant surface + wall-eligibility
(`cluster` pass 1/1.5/2, `env_geo.py:347-403`), cluster by exact wall-slot
signature, apply all-or-none per landblock, mint one variant per surviving
cluster. The un-built work is a **coverage-expansion re-run** with looser
cluster params, gated on the same portal-lineage staging as §2b (it is the same
`variant_release.sh` path). No new enumeration code is needed; the lever is the
`cluster` parameters + WALL_CLASSES.

### 3b. Creature geometry enumeration (coverage side, distinct from §1's animation question)

§1 answers "can a creature part be subdivided without breaking animation." This
section answers "how do you find the creature GfxObjs and rank their exposure" —
the enumeration problem, which is **structurally different from every other lane
because creatures have no LandBlockInfo placements at all.** Creatures are not
placed in the cell dat; they **spawn from weenies** at runtime. So the outdoor
`tranche.py` LBInfo walk and the dungeon `env_geo` EnvCell walk both miss them
entirely — there is no dat-side placement list to enumerate.

**Enumeration path:**

1. **Weenie → Setup.** Every creature weenie carries a `setupDid` (Setup 0x02).
   `LSD/weenie_summary.jsonl` exposes it directly per row:
   `{wcid, name, weenieType, setupDid, level, creatureType, itemType}`
   (verified — e.g. `{"wcid":6,"name":"Banderling Scout","setupDid":33558024,
   "weenieType":10,"creatureType":2,...}`; `33558024 = 0x02001408`). Filter to
   creatures via `weenieType==10` (Creature) and/or `creatureType != null`.
   Memory §lsd: `weenie_summary.jsonl` line 1 has a BOM; max wcid 73663; 0-hit ≠
   absent (partial dump). For completeness beyond LSD, the live ACE world DB
   (`ace_world.weenie_properties_did`, PropertyDataId `Setup`) is the
   authoritative source (memory §ace-db-probe / §live-ace).
2. **Setup → part GfxObjs.** `datlib.parse_setup` (`datlib.py:108-128`) returns
   `parts` (the 0x01 GfxObj ids); `pilot.resolve_gfx(mid, P)` already handles a
   0x02 model by returning its parts (`pilot.py:94-101`). Dedupe GfxObjs across
   all creature Setups (parts are heavily shared — a "banderling body" GfxObj
   serves many weenies), exactly as `tranche` dedupes building parts
   (`tranche.py:272-284`).
3. **Apply the per-part degrade guard** (§1c) and the op choice (§1d: PN/facet,
   not the wall-texture displacement gate).
4. **Rank exposure.** Creatures have no placement count, so substitute
   **spawn frequency**: `LSD/spawnMaps/` reverse-lookup gives which landblocks
   spawn a wcid (memory §lsd: `rg -l '"wcid":14520,' "$LSD/spawnMaps/"`), and
   `creatureType`/`level` proxy how often a player fights it at close range
   (PLAN §2 rank-4/5: highest-exposure surfaces are the things you fight). Rank
   the deduped creature GfxObjs by summed spawn exposure of the weenies that use
   them, then spend the budget top-down (mirroring `tranche`'s
   instance-ordered budget, `tranche.py:531-557`).

**Enumeration strategy summary (creatures):** LSD/ACE-DB weenie census →
`setupDid` filter (creatureType) → `parse_setup` to parts → dedupe GfxObjs →
degrade guard per part → PN/facet subdiv (`orientation="off"`) → rank by
spawnMap exposure → budgeted build → `obj-import gfxObjOnly preservePhysics`.
This reuses `resolve_gfx`, `parse_setup`, `Portal.degrade`, the `relief3d`
silhouette ops, and the `obj-import` contract wholesale; the only genuinely new
piece is the **weenie-driven enumerator** (there is no existing code that walks
weenies for setups — every current lane starts from a cell-dat placement list).

---

## 4. Per-lane execution-readiness summary

| lane | readiness | why | concrete next action |
|---|---|---|---|
| **4.P4 creature subdiv spike** | 🟢 GREEN | Format + decomp prove rigid part-frame animation, no vertex skinning (§1a); physics-untouched invariant is already delivered by `obj-import gfxObjOnly preservePhysics` (§1b); degrade guard reuses `resolve_gfx`+`Portal.degrade` per part (§1c); silhouette op (`pn_tessellate`/`facet_op`) already in `relief3d`. No new preservation machinery. | Run the §1e POC on ONE part (Setup→largest part, degrade-guard, `pn_tessellate` level 2, `orientation="off"`, import into a portal COPY), then the mandatory 1070 in-client spawn+animate check. Expected: denser, identically-moving creature. If PN is a visual no-op, fall back to `facet_op`. |
| **4.P3 env re-cut** | 🟡 YELLOW | Veto code is complete + default-on (§2a); the flow is one command (`variant_release.sh`). The **only** blocker is portal lineage: must clone from a PRE-envgeo portal or double-shell (§2b). WALL_CLASSES widening is a small, well-understood tweak (§2c). | FIRST resolve the lineage unknown: confirm (or reconstruct) a portal that has r8/r9 statics+scenery but NO env-geo variant appends — census candidates under `/mnt/wbterminal2/dat-patch-*`, verify with an Environment-record/graph sweep, never touch base dats. Then re-run `cluster`→`variant-build`→`variant_release.sh` and audit up-facing shell → ~0. |
| **dungeon coverage expansion** (TODO #4) | 🟡 YELLOW | Not un-designed — `env_geo.py` IS the dungeon lane and shipped in r5 (§3a). Enumeration (EnvCell→Environment CellStruct, per-cell surface indirection) is fully built. Remaining work = looser cluster params (`--top`/`--min-cells`) for coverage beyond clustered wall-cells; gated on the SAME §2b portal-lineage staging. | Bundle with 4.P3: once the pre-envgeo portal is staged, re-run `cluster` with wider params (measure the byte cost against the 1.27–1.48 GiB portal runway) and ship in the same variant release. |
| **creature geometry enumeration** (coverage side) | 🟡 YELLOW | Reuses `resolve_gfx`/`parse_setup`/`Portal.degrade`/`relief3d`/`obj-import` wholesale (§3b). The one new piece is a weenie-driven enumerator — no existing lane walks weenies (creatures have no cell-dat placements). Depends on 4.P4 proving the subdiv is safe. | AFTER 4.P4 goes green: write the enumerator (LSD `weenie_summary.jsonl` setupDid + creatureType filter → dedupe part GfxObjs), rank by `spawnMaps` exposure, wire the §1c guard + §1d silhouette op into a `tranche`-shaped budgeted build. |

**One cross-cutting UNVERIFIED item gating both 4.P3 and dungeon expansion:** the
existence/whereabouts of a usable pre-envgeo portal snapshot (§2b step 1). If
none exists, the variant re-cut must be re-derived deterministically from
`variants.json` onto a fresh statics/scenery portal — still a re-run, not
re-authoring, but a session's worth of staging. Resolve this before promising a
turnkey 4.P3.
