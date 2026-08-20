# Phase-4 4.P4 — creature-subdiv PROOF OF CONCEPT (RESULTS, 2026-08-20)

Executes the POC designed in `docs/dat-patch/research/geometry-lanes-research.md`
§1 (creature/animated-GfxObj subdiv spike, verdict GREEN). **Result: the
animation-preservation invariant is PROVEN offline (9/9 checks PASS).** The one
mandatory step this session could NOT run is the in-client 1070 spawn+animate
eye-test (the 1070/T4 are in use — §1070 rule); it is queued below.

New code (all NEW files in `tools/dat-patch/`, no core lane file touched):
- `creature_enum.py` — weenie→setup→part-GfxObj enumerator + spawn-exposure rank.
- `creature_tranche.py` — drives `relief3d.pn_tessellate`/`facet_op` +
  `pilot.write_obj` + the degrade guard; emits an `obj-import` job.
- `dungeon_coverage.py` — read-only coverage census (§3 deliverable).

Scratch outputs (never in `~/ac_base_dats`): `/mnt/wbterminal2/dat-patch-creature-subdiv/`.

---

## 1. What was built and run

### Enumeration (`creature_enum.py`)
Reused as black boxes: `pilot.resolve_gfx` (0x02→parts), `datlib.parse_setup`,
`gfxlib.Portal.degrade`, `pipeline.P`. Source: LSD `weenie_summary.jsonl`
(weenieType==10 + setupDid) and LSD `spawnMaps/` (per-wcid placement count =
exposure proxy — creatures have no dat placement list).

```
creatureWeeniesWithSetup   6057
spawnMapsRead              1162
distinctSetups (base dat)   693   (0 missing from the retail portal, 0 parse errors)
distinctPartGfxObjs        2237
  -> candidates            2155   (route=candidate: 0x01 GfxObj, degrade OK)
  -> degradeDeferred         82   (band0-not-self — excluded, exactly like statics)
partsSharedAcrossSlots       92   (a shared part is subdivided once, appears denser
                                   in every slot it occupies — acceptable, noted)
```
Output: `creature-candidates.json` (ranked by summed spawn exposure, then tris).
The top-exposure parts are tiny (eyes/shadow blobs, tris 1–30); the iconic classic
creatures are very low-poly (Banderling body 78 tris, Drudge 68, Olthoi 66) — which
is exactly why they are the highest-value subdiv targets.

### Subdiv + import (`creature_tranche.py`)
POC target: **Banderling body `0x01002C00`** (part of Setup `0x02000E08` "Banderling
Scout", the canonical AC creature). Op: `pn_tessellate(level=1)` (crack-free PN
triangles), `orientation="off"` (no floor-sink veto — a creature part has no world
"up"; research §1d). Imported into a **COPY** of the retail portal via
`obj-import gfxObjOnly=True preservePhysics=True overwrite=True`.

WBT importer self-report (authoritative):
`triangleCount=312, preservedPhysics=true, sortCenterPreserved=true,
didDegradePreserved=true, drawingCarried=true, gfxObjOnly=true`.

---

## 2. THE animation-invariant proof (offline, 9/9 PASS)

`report/verify_poc.py` parses the patched export portal and compares every
animation-load-bearing record against the retail base. Full log in
`report/verify_result.json`.

| # | invariant | result |
|---|---|---|
| 1 | part GfxObj id unchanged (`0x01002C00`) → every Setup slot + Animation part index still resolves | **PASS** |
| 2 | drawn tris increased (additive: 78 orig + 312 tessellated = 390) | **PASS** |
| 3 | physics polys byte-identical (`preservePhysics`) — this part has 0 per-GfxObj phys | **PASS** |
| 4 | degrade DID preserved (`0x11000618`) | **PASS** |
| 5 | degrade band0==self preserved (`0x01002C00`) | **PASS** |
| 6 | sort center preserved | **PASS** |
| 7 | surfaces unchanged (`0x080009B6`,`0x080009B7`) | **PASS** |
| 8 | **Setup `0x02000E08` BYTE-IDENTICAL** (sha `67b7026fdd3c`, 792 B) — every `PlacementFrame` (the rigid per-part animation transform), CylSpheres, Height, Radius untouched | **PASS** |
| 9 | degrade `0x11000618` byte-identical; part record changed vs base (patch landed) | **PASS** |

**Why this is the proof.** AC creature animation is rigid part-hierarchy animation
with no per-vertex skinning (research §1a: Setup PlacementFrames + Animation
PartFrames are `(Origin, Orientation)` rigid transforms, one per part per keyframe).
The animation payload lives entirely in the **Setup (0x02)** and **Animation (0x03)**
records, keyed by **part index / GfxObj id** — none of which a `gfxObjOnly` part
patch opens. Check #8 shows the Setup is byte-identical; check #1 shows the part id
is unchanged; so every keyframe still assigns the same rigid frame to the same
part. Only the drawn triangles inside that part changed. A denser mesh transformed
by an unchanged rigid frame animates identically. **Detachment is structurally
impossible here.**

### Real finding that refines the research — the importer is ADDITIVE
The research assumed `pn_tessellate` is a clean in-place 4× replacement. It is not,
under the existing `obj-import` contract: `CommandEngine.CarryOriginalDrawingGeometry`
(CommandEngine.cs:11882) SEEDS the merged mesh with all original drawn polys, then
appends imported faces that don't exactly match an original fan triangle. The 312
PN sub-triangles are all new (they subdivide, they don't reproduce originals), so
the stored mesh is **78 original + 312 shell = 390 drawn tris (5.0×)** — the same
additive shell-over-original model the building lane ships (pilot emits shell-only,
importer carries originals). For a convex part PN bulges outward and the original is
buried inside (fine, like a wall under its relief shell); on a **concave** part the
shell dips inward and the original low-poly facets could poke through. This is the
one open geometry risk and is exactly what the in-client eye-test must check.

**Left as a proposal (no core-lane edit made):** add an `obj-import` mode
`replaceDrawing:true` — same as `gfxObjOnly + preservePhysics` but DROP the original
drawn polys (keep physics polys + physics BSP, rebuild the drawing BSP from the
imported mesh) — so a replacement-style silhouette op stores a clean N× mesh instead
of original+shell. This is a ~1-method change in `CarryOriginalDrawingGeometry`
(skip the `SeedMergedFromOriginal` of drawn polys when the flag is set) and is the
recommended follow-up before a creature scale-out. Until then the additive model is
usable (proven safe for buildings) but expect ~5× not 4× bytes and eye-test concave
parts for poke-through.

---

## 3. Mandatory remaining step (could not run — 1070/T4 in use)
Per research §1e.4 and the §1070 rule, the load-bearing visual confirmation is an
in-client spawn+animate at close range:
```
# on the live ACE laptop, via window.__sessionHandle.sendChat:
@create <a Banderling wcid, e.g. 6 Banderling Scout>       # spawns the creature
# watch a full motion cycle (walk + one attack) at close range on 1070/T4.
# PASS iff the denser body tracks the skeleton identically to retail — no part
# detaches, lags, or inverts (expected, since parts are rigid). Also check the
# concave-region poke-through noted in §2.
```
Stage: point the client at the verified scratch portal
`/mnt/wbterminal2/dat-patch-creature-subdiv/export/client_portal.dat`.

---

## 4. Scale-out (what a full run would do — for the orchestrator, not run here)
- **Which creatures:** the 2,155 `route=candidate` part GfxObjs in
  `creature-candidates.json`, spent top-down by summed spawn exposure (mirrors
  `tranche`'s instance-ordered budget). Exclude the 82 degrade-deferred (band0-not-self)
  exactly as statics do; route their band objects to the deferred lane.
- **Op:** `pn_tessellate` for parts with authored curvature; `facet_op` fallback for
  flat-shaded parts where PN is a visual no-op (research §1d). `orientation="off"`.
- **Est. bytes (additive model, level-1 ≈ +4× drawn tris):** the 2,155 candidate
  parts carry on the order of a few hundred thousand source tris; at the measured
  ~5,944→18,077 B for a 78-tri part the top-exposure few hundred parts (the ones a
  player actually fights at close range) land well inside the 1.27 GiB portal runway.
  Budget top-down and stop at the runway line; do NOT subdivide the 1–30-tri
  eyes/shadow parts (no silhouette to win). With the `replaceDrawing` proposal the
  byte cost drops from ~5× to ~4×.
- **Command shape (per part), driven exactly as this POC:**
  ```
  DATPATCH_PORTAL=<base portal copy> python3 creature_tranche.py build \
      --gid <part> --workdir <run> --op pn --level 1
  dotnet WorldBuilder.Terminal.dll --stdin --project <run>/proj/creature.wbproj \
      < <run>/imports.jsonl        # obj-import ... + export
  ```
  Batch the obj-import jobs into one `imports.jsonl` + a single `export` (as
  `tranche`/`pilot` do) so the 927 MB portal is written once, not per part.

---

## 5. Coverage census (§3 deliverable) — `coverage.json`

### Dungeon geometry (env_geo.py IS the dungeon lane; r5 shipped)
| metric | value |
|---|---|
| total indoor EnvCells (cell dat) | 734,976 |
| total dungeon LandBlocks | 3,409 |
| total Environments 0x0D (retail) | 772 |
| r5 wall-eligible cells | 569,694 |
| r5 covered wall cells | 553,108 (**97.09 %** of wall-eligible) |
| r5 uncovered wall cells | 16,586 |
| indoor cells never displaced (non-wall-class + below cutoff) | 181,868 (**24.74 %** of all indoor cells) |
| dungeon LBs fully covered / touched / total | 2,193 / 3,049 / 3,409 |
| LBs touched-but-partial (all-or-none → shipped nothing) | 856 |
| dungeon LBs never touched | 360 |
| **surviving clusters left unbuilt by `--top=1000` cap** | **6,236** (of 7,236 surviving) |

The headline un-built dungeon lever is the `--top` cap: 6,236 surviving wall-slot
clusters were never minted. Raising `--top` (and optionally lowering `--min-cells`,
adding `Shingle` per research §2c) is a coverage-expansion **re-run** of the existing
lane — gated on the same pre-envgeo portal staging as 4.P3 (see the prep doc).

### Creature geometry (this lane)
2,155 candidate part GfxObjs across 693 creature setups / 6,057 weenies; 82
degrade-deferred. Ranked list in `creature-candidates.json`.

---

## 6. Files
- `tools/dat-patch/creature_enum.py`, `creature_tranche.py`, `dungeon_coverage.py`
- `/mnt/wbterminal2/dat-patch-creature-subdiv/creature-candidates.json`
- `/mnt/wbterminal2/dat-patch-creature-subdiv/coverage.json`
- `/mnt/wbterminal2/dat-patch-creature-subdiv/report/{before.json,verify_poc.py,verify_result.json,build_stats.json}`
- `/mnt/wbterminal2/dat-patch-creature-subdiv/export/client_portal.dat` (patched scratch portal; 0x01002C00 subdivided)
- `/mnt/wbterminal2/dat-patch-creature-subdiv/obj/0x01002C00.obj`
