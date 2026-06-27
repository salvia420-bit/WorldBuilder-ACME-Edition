# Per-Landblock Faithful World Method (2026-06-26)

**Supersedes the "Holtburg ring" framing. Does NOT replace — and does NOT edit — the
original method docs.** The original contract was right and is preserved verbatim:
- [`world-completeness-method.md`](world-completeness-method.md) — the 3-source placement contract (KEEP)
- [`entity-completeness-method.md`](entity-completeness-method.md) — typed classification (KEEP)
- [`event-completeness-method.md`](event-completeness-method.md) — sounds/particles (KEEP)
- [`cell-portal-method.md`](cell-portal-method.md) — interior PVS/visibility (KEEP)
- [`ring-expansion-method.md`](ring-expansion-method.md) — the ring orchestration (RETIRED as a *framing*; the CLIs it documents stay)

This doc is the **diagnosis of why every world bake since the original regressed**, plus a
**new, location-agnostic, retail-faithful per-landblock method** that restores the world we
had in May 2026 and lost. Operating mode: **"if it's not broke, don't fix it."** The runtime
render pipeline is largely intact — we fix the *data*, a handful of *Holtburg-specific hacks*,
the *June rendering regressions*, and the *verify blindness* that let it all hide.

> **One-line thesis.** The good world was lost not because the renderer changed shape, but
> because (1) **server-side generator children were never staged** (dungeon/town interior
> monsters & NPCs vanished), (2) **entity orientation was dropped**, (3) **events were never
> world-baked**, (4) several **Holtburg-specific shortcuts** (boot-ring center, a globally
> *disabled* depth-clear, per-LB LRU eviction) degraded every non-Holtburg landblock, (5) a
> wave of **post-2D-retirement rendering regressions** (barren-poison, white-box monsters,
> a 24 s cold-load freeze) went in during June and were never validated live, and (6) the
> **completeness verify is interior-blind and self-consistent**, so none of it surfaced.

---

## 0. How this doc was produced (provenance)

A 2026-06-26 research sweep over the five sources, with two deepening passes + adversarial
red-team, all citation-backed:

- **Decomp / acclient** (`~/ac-headers/acclient.{c,h,txt}`, `acclient.map`) — the canonical
  retail per-LB load order + struct layouts.
- **holtburger-web** (`external/holtburger/apps/holtburger-web/`) — the live runtime pipeline.
- **WorldBuilder.Terminal** (`WorldBuilder.Terminal/`) — the per-LB oracle + reference renderer.
- **chorizite** (`Chorizite.ACProtocol`, `ACBindings`, DRW `dats.xml`) — DAT field shapes,
  retail offsets, wire object-create fields.
- **Discord archive** (gold channels: worldbuilder/chorizite/sourcecode/alt-clients) —
  community truth (gmriggs, trevis, Vanquish420, z-z, OptimShi).
- **On-disk live evidence** (eyetest screenshots, handoffs, `_health.json`, git log) — what
  actually rendered (and what didn't) after the June refactors.

Every claim below cites a file:line, a commit, a decomp line, or a dated artifact.

---

## 1. The baseline we lost — the "good" May-2026 world

Per the preserved method docs + the May screenshots, the world that worked rendered each
landblock from a **3-source placement contract** plus an **interior pipeline**:

1. **DAT-explicit** — `LandblockInfo.objects` (buildings + outdoor statics), read live from
   `client_cell_1.dat` via wasm `fetch_landblock_objects`.
2. **DAT-baked** — scenery/trees from a deterministic Rust port of ACE `Scenery.Load`,
   fetched per-LB from `dist/scenery/0xLLLL.scenery.jsonl`.
3. **ACE-explicit** — NPCs, monsters, **portals** (incl. Town Network), lifestones, chests,
   replayed per-LB from `dist/spawns/0xLLLL.spawns.jsonl` through the real wire path.
4. **Interiors** — EnvCells loaded via wasm `fetchEnvCellsInLandblock` → `cells.js`, made
   visible by the cell-portal-method's PVS (inside: `getRenderSetWithPView` Sutherland–Hodgman
   portal clip; outside: AABB-vs-frustum cull of `SeenOutside` cottage cells) **plus an
   indoor depth-clear render-layer split** so cottage floors win over terrain.

That world had: buildings, interior **walls** (EnvCell geometry), interior **furniture**
(EnvCell stabs), interior **NPCs**, **portals**, and town-network portals. The user remembers
it correctly. It worked because the May ring had a *small, fully-staged, fully-verified*
dataset and the depth-clear was *enabled*.

---

## 2. Retail truth — the canonical per-landblock inventory (the contract)

Retail loads **every landblock identically** (no Holtburg special-case). Established from the
decomp; this is the contract every LB must satisfy.

**Load order** (`LScape::grab_visible_cells` acclient.c:306571):
`CLandBlock::InitLoad` (352063, reads the `0xLLLLFFFE` LandblockInfo) →
`init_buildings` (352114) → `grab_visible_cells` (351601) →
`init_static_objs` (352787, outdoor stabs) → `init_dyn_objs` (351559).

**Authoritative records** (decomp `acclient.h` + DRW `dats.xml` + ACBindings):

| Record | Key fields | Holds |
|---|---|---|
| `LandblockInfo` (acclient.h:31893; dats.xml:4192) | `num_objects`→`Objects[]` (Stab), `num_buildings`→`Buildings[]` (BuildInfo), `num_cells`→`cell_ids[]`→`cells[]` (CEnvCell) | outdoor statics + buildings + the count/list of interior cells |
| `BuildInfo` (dats.xml:2581) | `ModelId`, `Frame`, `Portals[]` (CBldPortal) | building shell + portals linking to interior cells |
| `CBldPortal` (acclient.h:32094; dats.xml:2588) | `other_cell_id`, `StabList[]` | which interior cell a building doorway opens to + that cell's PVS stab list |
| `CEnvCell` (acclient.h:32072; dats.xml:4210) | `Surfaces[]`, `EnvironmentId`(0x0D)+`CellStructure`, `Position`, `CellPortals[]`, `VisibleCells[]`, `StaticObjects[]` (gated by `EnvCellFlags.HasStaticObjs` 0x2) | interior **walls/geometry** (via Environment 0x0D → CellStruct) + **furniture stabs** + doorways + PVS |
| `Stab` (dats.xml:2573) | `Id`, `Frame` (origin + **quaternion**) | one static-object placement (outdoor or interior) |
| `CCellPortal` (acclient.h:32300; dats.xml:2596) | `PolygonId`, `OtherCellId`, `OtherPortalId` | cell↔cell doorway for PVS (NOT clickable) |

**Source attribution — where each visible thing comes from** (the spine of "implement each
landblock retail-faithful"):

| Thing rendered | Source | How we get it |
|---|---|---|
| Terrain | DAT (cell.dat landblock) | wasm, live |
| Outdoor statics + building shells | DAT `LandblockInfo.Objects`/`Buildings` | wasm `fetch_landblock_objects` (0xFFFE), live |
| Scenery (trees/rocks/grass) | **procedural** from terrain type (ACE `Scenery.Load`) | baked → `dist/scenery/` |
| Interior **walls/geometry** | DAT `EnvCell` → Environment(0x0D)+CellStruct | wasm `fetchEnvCellsInLandblock`, live |
| Interior **furniture (stabs)** | DAT `EnvCell.StaticObjects` | wasm `fetchEnvCellsInLandblock`, live |
| Cell↔cell portals (PVS) | DAT `EnvCell.CellPortals` + `VisibleCells` | wasm, live |
| **NPCs / monsters** | **server** (ACE `landblock_instance` + **generators**) | staged → `dist/spawns/` |
| **Clickable portals** (swirly, Town Network) | **server** weenies (ItemType Portal=7 / HousePortal=59) | staged → `dist/spawns/` |
| Lifestones / chests / doors | **server** weenies | staged → `dist/spawns/` |

Two truths that drive the whole diagnosis:
- **Interior walls + furniture are DAT-baked** (`CEnvCell::init_static_objects` acclient.c:347955;
  confirmed by Discord — the literal DAT type is `Stab`). They come live from the cell.dat; we
  do **not** stage them. So "missing interior walls/objects" is a *visibility/render/streaming*
  problem, not a data problem — **except** that the interior is empty of life if its NPCs/monsters
  (server) are missing.
- **Interior monsters are overwhelmingly generator-spawned.** gmriggs: *"almost every dungeon
  spawn was tied to a gen."* Empirically confirmed below (dungeon `0x00B4` is 94.6% generators).
  If we don't stage generator children, dungeons render structurally present but **lifeless**.

**Cross-LB rule (gmriggs, 2026-02-13):** *"in the AC data format it's impossible for an
EnvCell to connect directly to another landblock."* Multi-landblock dungeons are stitched with
**swirly (server) portals**, never cell-portals. So a per-LB streaming model is *correct*, but
the renderer must not evict an in-use dungeon LB's cells (see Regression B3).

---

## 3. What is CONFIRMED INTACT — do **not** rewrite (the "not broke" list)

The per-LB runtime pipeline still fires all sources on a bare-default boot, routed through the
post-unification `world_stream.js` streamer. The 2026-06-11/12 unification refactor
(`?singleDriver`/`?unifiedDispatch`, both default-on) **dropped no sources** (parity test
`test_a15_q4_renderer_neutral_core.mjs`). Leave these alone:

- **Per-LB load sequence** — `world_stream.js::onPositionUpdate` fires terrain (3×3),
  building AABBs, EnvCell containers, EnvCell meshes (`loadEnvCellsForLandblock`→
  `cells.js:218 buildEnvCellsForLandblock`), buildings (`fetch_landblock_objects`,
  buildings.js:663), statics + scenery (`fetch_landblock_scenery`, statics.js:616),
  spawns (`fetch_landblock_spawns`, spawns.js:564). All default-on, none gated off.
- **Interior geometry construction** — cells.js builds wall meshes (`pl.takeMesh()` :348,
  per-surface Mesh :710-728) and **interior stab meshes** (`pl.takeStaticObjects()` :355,
  `fetch_model_meshes` :432, placed :757-786). The code reads + places interior furniture.
- **PVS visibility** — `getRenderSetWithFrustum` (outdoor cottage-from-outside, with the
  Phase-6 outdoor-exit filter, `scene.rs:1695-1762`) + `getRenderSetWithPView` (indoor
  Sutherland–Hodgman portal clip, `scene.rs:1792-1849`); both location-agnostic, no Holtburg
  constant, default-on. `cell_portal_graph` built from CellPortals **and** DAT VisibleCells.
- **Spawn replay** — spawns.js replays per-LB JSONL (incl. interior cells, packed
  `(lbId | cell&0xffff)` :393) through the real `__scene3dEntityHook`; quaternion application
  is correct (`setPose`→`acQuatToThree` entities.js:2249/adapter.js:1122). No entity filter.
- **Player-centered streaming machinery** — `tickPvsLoadExpansion` expands a ring around the
  player's LB (`scene3d.pvsRingRadius`, default 5 = 11×11 ≈ 960 m; `cells.js:1222-1261`).
  The mechanism is correct (the open question is live validation, §4-B1).
- **Entity typed classification** (entity-completeness-method) and **scenery bake**
  (100% ACE-parity, whole-world, byte-stable) — both intact; do not touch.

**Implication:** the new method is mostly *data + a few targeted fixes + a real verify*, NOT a
renderer rewrite. That is exactly "if it's not broke, don't fix it."

---

## 4. The regression ledger — what actually broke (with evidence)

Grouped A–D. Severity: 🔴 world-breaking · 🟡 degrades · 🟢 cosmetic-ish.

### A. Data / staging regressions

**A1 🔴 Generator children never staged → dungeon/town interior monsters & NPCs absent.**
The staging path deliberately skips generator expansion for the `landblock_instance` layer —
`CommandEngine.SiteIngest.cs:263-268`: *"town generator expansion is deferred … Do NOT pass
generator dicts here."* `BuildFromAceLandblockInstances` (SpawnGazetteerBuilder.cs:130) only
expands when generator dicts are passed (`:188`), and staging passes none. Only the *encounter*
(wilderness) layer expands. **The oracle is blind the same way** (`dump-lb-expectations` reads
the same generator-deferred `ace_spawn_records.jsonl` via a plain deserialize,
`CommandEngine.cs:1296` — no expansion), so the divergence is *symmetric* and invisible to
bake-vs-oracle verify. Measured impact (faithful `ExpandGeneratorChildren` replay vs the live
staged files):

| LB | Staged today | What's missing |
|---|---|---|
| Holtburg `0xA9B4` | 106 (all `Static`) | +13 generator children → 119 |
| Dungeon `0x00B4` | **331, ALL invisible weenieType-1 anchors, 0 visible monsters** | **+810 monsters** |
| Dungeon `0x0116` | 496 (117 direct creatures) | +26 |
| **World-wide** | 365,183 rows | **+25,624 (~17,789 creatures)** |

This is the single biggest cause of "lacked interior objects, npcs." gmriggs's *"almost every
dungeon spawn was tied to a gen"* — empirically 94.6% at `0x00B4`.

**A2 🟡 Entity orientation quaternions dropped.** The live `dist/spawns` (the "wildernessfill",
2026-06-17) was re-staged from `ace_spawn_records.jsonl` which carries **0** quaternions; the
better snapshot `spawns.bak-2026-06-17` has 313,134 real quats. `spawns.js:404` defaults
missing `qw→1` → every NPC/portal faces identity. **Not "missing" — "mis-rotated."** Portals,
signs, NPCs all face the wrong way. Confirmed by jq: current `0xA9B4` records have no
`qw/qx/qy/qz`; the backup has e.g. Town-Network portal `qw:-0.724, qz:0.689`.

**A3 🔴 Events never world-baked.** `dist/events` has **340 files** = the 169-ring only.
Ambient terrain sounds, animation-hook sounds, and the sky chain are absent for ~99.5% of the
world. The event-bake CLI exists and works; it was simply never run world-wide.

**A4 🟡 Wilderness-fill noise.** The fill added ~245k invisible weenieType-1 `Generic` anchors
(encounter/generator markers without setups). They litter the world as nothing-renders nodes;
the stager's drop-gate only discards `Encounter`/`Respawn` markers, not `Static` ones
(`stage-ring-spawns.py:158-163`). Fixing A1 mostly resolves this (anchors flip to `Respawn` and
get dropped, replaced by real children).

### B. Holtburg-specific shortcuts that degrade every other landblock (the "ring" disease)

**B1 🟡 Boot/streaming ring hardcoded to Holtburg — fix shipped, never validated live.**
The radius-6 boot ring centered on `HOLTBURG_X/Y` (statics.js, buildings.js, terrain.js); away
from Holtburg only the immediate LB + a 3×3 streamed → *"empty wilderness past ~480 m"*
(`docs/.../2026-06-20-empty-world-statics-investigation-handoff.md`). Fix `d5dda216`
(player-centered `pvsRingRadius`, default 5) is **JS-only, default-on, but "AWAITING LIVE A/B"**
— never confirmed at a dense inland town/dungeon. Every June live capture spawns at the
Holtburg lifestone.

**B2 🟡 Depth-clear render-layer split disabled — CORRECTED 2026-06-26: this is a reasoned
tradeoff, not a clear regression.** Commit `a575df28` (2026-05-29) disabled the indoor
depth-clear pass (`atmosphere_pipeline.js:394-415`, `depthClearPass.enabled=false`). Reading the
actual code + its rationale: the old Phase-5 depth-clear *wiped terrain depth* and redrew every
frustum-visible EnvCell on top whenever the current cell was classified indoor — and Holtburg
building plots/basements *are* EnvCells, so it fired while standing outside, drawing
interiors/basements **through** the terrain (the see-through bug). The author replaced it with a
**single shared-depth world pass** so the GPU depth buffer correctly occludes EnvCells
behind/below terrain — which is *more* correct in general and is itself an "abandon the
Holtburg-specific hack" move (the destructive clear *was* the hack). The only given-back tradeoff
is cottage-floor-vs-terrain **Z-fighting**, to be cured with a **targeted polygon-offset on the
cell floor**, never by re-enabling the global clear. So Fix 4 is **re-scoped**: do NOT blindly
re-enable the clear; validate interiors under single-shared-depth on the GPU and add the targeted
polygon-offset only if Z-fight is observed. (This is the kind of render-side item that needs the
1070, not a blind edit.)

**B3 🟡 Per-LB LRU eviction orphans cross-LB dungeon cells.** `landblock_lru.js:260-271` evicts
EnvCell containers by landblock key; the wasm portal graph (`scene.rs:1015`) correctly cleans
cross-LB edges, but JS `cellContainers3d` evicts per-LB. A multi-LB dungeon (stitched by swirly
portals per gmriggs) can lose the cells of an evicted neighbor LB the player can still reach →
invisible interior. *(Lower confidence — code-read inference; confirm with a multi-LB dungeon
before fixing.)*

### C. Post-2D-retirement / unification rendering regressions (June, unvalidated)

**C1 🔴 "Permanent-barren poison."** `5957fd55` ("post-2D-retire busted world"): four bakers
marked an LB *baked before* their fetch resolved, so one throw under boot load permanently
stripped that LB from ever re-baking. Fix shipped; **never confirmed live**. Plus a diagnosed
**~24 s cold-load shader-compile freeze** that starves entity spawns ("victims of the frozen
main thread") — **still open**. This explains the intermittent "scene graph says 169 LBs/47
buildings but render shows an empty green field" (`docs/eyetest-2026-06-24/01-holtburg-barren-render.png`).

**C2 🔴 White-box monsters + missing particle effects.** Live 1070, combat area `0xAB94`:
monsters render as solid glowing **white boxes** (luminous-surface flat-emissive bug) and
**portals/particle effects don't render** ("effect enqueued for not-yet-spawned guid").
`docs/.../2026-06-20-white-box-monsters-particle-effects-handoff.md` — **"PENDING DECISION — do
NOT implement until settled."** Directly corroborates "portals never appeared." This is a
material/effect-attach regression from the 2D-retirement + visual-suite default-on churn, not a
placement problem.

### D. Why none of it was caught — the verify is blind

**D1 🔴 Interior-blind, self-consistent verify.** `dump-lb-expectations.interior` is **count-only**
(`cellCount`, `staticObjectCount` — no stab/portal/entity list; LandblockDescriber.cs:427-441).
`verify-sweep.mjs` checks interiors **structurally** (poll until `cellContainers3d` count reaches
`interior.cellCount`; "we verify the cell graph loaded, not every entity") and **filters interior
NPCs out** of surface checks. Worse, it compares **bake vs oracle, both derived from the same
generator-deferred file** → self-consistent by construction; the gap is identical on both sides
and can never surface as DRIFT. No per-LB visual PASS/DRIFT matrix exists for any post-June build.
**This is why the world silently rotted.**

---

## 5. The new method — principles (abandon the ring; implement each LB faithfully)

1. **Location-agnostic, per-landblock.** No landblock is special. The renderer already loads
   every LB identically (§3); the *data* and *verify* must too. Delete Holtburg-centric
   assumptions (B1 done-pending-validation, B2, B3). The only Holtburg-shaped thing that may
   remain is an *optional* boot warm-spawn location — never a load/visibility/verify center.
2. **Source-faithful by the §2 attribution table.** Every visible thing traces to exactly one
   canonical source. DAT content (terrain, statics, buildings, interior walls/stabs, cell
   portals) stays **live from the DAT** — do not bake it. Server content (NPCs, monsters,
   **generator children**, clickable portals, lifestones, chests) is staged per-LB **with
   orientation**. Procedural scenery stays baked (already 100% ACE-parity).
3. **Complete server data for every LB.** Stage generator children (A1) + orientation (A2) for
   all 40k LBs, and world-bake events (A3). The encounter layer already covers wilderness;
   re-enable the `landblock_instance` generator path so towns/dungeons match retail.
4. **Re-enable retail-correct visibility.** Restore the conditional depth-clear via correct
   indoor detection (B2); make LRU eviction dungeon-aware (B3).
5. **Land or revert the June rendering fixes, then prove them.** Confirm barren-poison +
   shader-freeze (C1) and resolve white-box/particle (C2) — these are render regressions, fixed
   in the renderer, not the data.
6. **A falsifiable, interior-complete, INDEPENDENT-ground-truth verify.** The verify compares the
   **rendered scene** against **two independent truths**: the **DAT** (via `get-dungeon-info` for
   interior cells/stabs/portals; `fetch_landblock_objects` for outdoor) and the **ACE DB with
   generators expanded** (for spawns). Never bake-vs-oracle from one file. Per-LB, any LB, with a
   real visual+structural matrix.
7. **"If it's not broke, don't fix it."** Touch only the broken items A–D. The render pipeline,
   typed classification, scenery bake, and PVS algorithms stay.

---

## 6. The fix-set (concrete, minimal, ordered)

Each fix names the file:line, the change, the cost, and the determinism note. Ordered so each
step is independently shippable and verifiable.

### Fix 1 — Stage generator children for `landblock_instance` (A1, 🔴 biggest win)
- **Change:** in `CommandEngine.SiteIngest.cs` `IngestAceSpawnsAsync` (~:243-286), mirror
  `IngestAceEncountersAsync` (:306-313, :332-334): fetch `generatorProfiles`, `generatorRadii`,
  `generatorMaxObjects`, `childWeenieTypes` and pass them into
  `SpawnGazetteerBuilder.BuildFromAceLandblockInstances(rows, weenieDescriptors, …)` at :268.
  Delete the "Do NOT pass generator dicts here" comment. (`JsonCommandProcessor.cs:2688` help
  already promises this.)
- **Determinism:** `ExpandGeneratorChildren` (SpawnGazetteerBuilder.cs:374) is a pure FNV-1a
  function of `(ownerWcid, objCellId, profiles)` mirroring ACE `SelectAProfile`
  (`WorldObject_Generators.cs:108-178`): all `Probability==-1` init-create children always
  emitted; one deterministic weighted pick for random pools; treasure/wield/contain excluded.
  Byte-stable across re-stages. Works for interior cells (uses the anchor's own cell).
- **Cost:** Holtburg 106→119; world `landblock_instance` +25,624 (+7%), concentrated in dungeons.
  Net staged size grows less (invisible anchors flip to `Respawn` and the drop-gate removes them).

### Fix 2 — Preserve entity orientation end-to-end (A2, 🟡)
- **Change:** re-stage spawns from the **oriented** source (`ace_spawn_records_oriented.jsonl`,
  313,134 quats — or re-dump ACE merging `landblock_instance.angles_*` for the wilderness layer
  too). The stager `normalise_record` and `spawns.js::buildUpd` already pass `qw/qx/qy/qz`
  through; `spawns.js:404` only defaults to identity when the field is absent.
- **Verify:** sampled `0xA9B4` + a dungeon must carry non-identity quats; rendered NPC headings
  match ACE `landblock_instance` angles.

### Fix 3 — World-bake events (A3, 🔴)
- **Change:** run `event-bake --landblocks 0x0000..0xFFFF` (parallelized — see §8) to
  `$HOLTBURGER_DIST/events/`, replacing the 169-ring-only set. Emit `event-bake-source.sha256`.
- **Note:** ambient/anim-hook/sky channels are deterministic from DAT (event-completeness-method);
  base-DATs-only pre-flight applies.

### Fix 4 — Validate interiors under single-shared-depth; targeted Z-fight cure only if needed (B2, 🟡 — RE-SCOPED 2026-06-26)
- **Do NOT blindly re-enable the depth-clear.** The current single-shared-depth world pass
  (`atmosphere_pipeline.js:394-415`) is a reasoned, more-correct replacement for the destructive
  Phase-5 clear (see B2). Re-enabling the clear re-introduces the Holtburg see-through bug.
- **Change (GPU-gated):** validate on the 1070 that interiors render correctly under
  single-shared-depth (walls occlude properly, no see-through). IF — and only if —
  cottage-floor-vs-terrain Z-fighting is observed, add a **targeted `polygonOffset` on the cell
  floor material** (cells.js / the EnvCell material), never a global depth wipe.
- **Why this is GPU-gated, not a blind edit:** depth/occlusion correctness is a pixel property;
  it cannot be validated from a static code read or a scene-graph walk. Needs the 1070.

### Fix 5 — Make LRU eviction dungeon-aware (B3, 🟡, confirm first)
- **Change:** in `landblock_lru.js:260-271`, do not evict an EnvCell container while it is
  reachable in the current `cell_portal_graph` (or while the player is inside any cell of a
  multi-LB dungeon set). Alternatively bump `lbCap` so an active large dungeon's LBs stay
  resident. Confirm on a real multi-LB dungeon before changing eviction policy.

### Fix 6 — Land + prove the June render regressions (C1/C2)
- **C1:** confirm `5957fd55` fully removed the barren-poison (re-bake recovers after a throw);
  fix the ~24 s cold-load shader freeze (pre-warm / async compile) so entity spawns aren't
  starved. These are the cause of intermittent barren renders even with complete data.
- **C2:** resolve the white-box monster material (luminous flat-emissive) + the
  "effect enqueued for not-yet-spawned guid" particle/portal-glow attach. These sit in the
  visual-suite/entities path; coordinate with the Phase-4 bake migration but treat as a
  correctness fix, not a feature.

### Fix 7 — Validate player-centered streaming live (B1)
- Already shipped (`d5dda216`, default-on). Just **prove it**: roam a dense inland town +
  wilderness far from Holtburg; the horizon must fill to ~960 m (`?pvsRingRadius=1` is the old
  barren 3×3 A/B control). Watch frame-time (wide-ring baking is heavier).

**Deliberately NOT changing:** the per-LB render pipeline, scenery bake, typed classification,
PVS algorithms, the DAT-live load of interior walls/stabs (those are correct).

---

## 7. The completeness verify — the guarantee mechanism

The old verify failed because it was interior-blind and self-consistent (D1). The new verify is
**per-LB, location-agnostic, interior-complete, and grounded in INDEPENDENT truth.**

**Three independent ground-truth sources** (never compare a bake to an oracle built from the
same file):
- **DAT truth** for baked/live content: `get-dungeon-info <lb>` returns per-cell
  `{cellId, environmentId, portals[{otherCellId,polygonId}], staticObjects[{id,x,y,z}]}`
  (JsonCommandProcessor.cs:2206) → the exhaustive interior manifest (walls via cell count +
  environmentId, **stabs**, **cell portals**). `fetch_landblock_objects` / `list-objects` →
  outdoor statics + buildings. `fetch_landblock_scenery` → baked scenery.
- **ACE-DB truth** for server content: `landblock_instance` **with `ExpandGeneratorChildren`
  applied** (the same code as Fix 1) → the full NPC/monster/portal/lifestone/chest roster with
  orientation, per cell.
- **RENDER truth**: a `__diag` walk of the live scene — `staticsGroup`, `buildingsGroup`,
  `cellsGroup` (per-cell stab meshes), `entitiesGroup` (per-cell spawns) — at the actual LB.

**Per-LB checks** (any LB; pick the cohort by census, not by ring):
1. **Outdoor placements** — render `staticsGroup`/`buildingsGroup` ≡ DAT `fetch_landblock_objects`
   + baked scenery (the original `validate_landblock_completeness.cjs`, kept).
2. **Interior structure** — for each EnvCell from `get-dungeon-info`: the cell renders (mesh in
   `cellsGroup`), its **stabs** render (per-cell furniture count + positions match), and its
   **cell-portal graph** matches. *(New — closes the count-only blindness.)*
3. **Interior + outdoor entities** — render `entitiesGroup` ≡ ACE-DB roster **with generators
   expanded**, per cell, including portals (ItemType 7/59) and **orientation** within tolerance.
   *(New — closes the generator + orientation blindness.)*
4. **Visibility** — from inside a cell, `getRenderSetWithPView` ⊆ DAT `VisibleCells`; from the
   town square, `SeenOutside` cottage cells render (cell-portal-method PVS spot-checks).
5. **Render-health** — zero `__diag.assets.{material,animation,mesh}Errors`; no white-box
   fallback materials; no "enqueued-for-not-yet-spawned-guid" leftovers; no permanent-barren LBs.

**Extend `dump-lb-expectations.interior`** to include `stabs[]` + `portals[]` (it already has the
data via `get-dungeon-info`/DungeonDocument) so the oracle is itself interior-complete and the
verify can run from one command.

**Output:** a per-LB PASS/DRIFT **matrix** (`matrix.json`) for the verified cohort, with the
DRIFT classified (missing-stab / missing-portal / missing-entity / missing-generator-child /
wrong-orientation / cell-not-visible / render-error). The matrix is the shipping gate; it
**must** be regenerated for the current build (none exists post-June).

---

## 8. Execution plan (the ordered runbook — nearly ready to run)

See the companion [`per-landblock-faithful-EXECUTION-2026-06-26.md`](per-landblock-faithful-EXECUTION-2026-06-26.md)
for the copy-pasteable commands. Summary order (each step gated by its verify before the next):

0. **Establish the live baseline (do this FIRST).** Spawn into three non-Holtburg locations on
   the real GPU (1070) and capture the scene: (a) a dense inland town, (b) a dungeon interior,
   (c) combat area `0xAB94`. This converts the "code says it works / user says it's broken"
   conflict into evidence. Expected per the ledger: barren/white-box/empty interiors. This is the
   pre-fix control for every later A/B.
1. **Fix 1 (generators)** → re-run `ace-db-ingest-spawns` (+ encounters append) →
   `stage-ring-spawns.py --all-world` from the **oriented** source (folds in **Fix 2**).
2. **Fix 3 (events world-bake)** → `event-bake 0x0000..0xFFFF` (parallel).
3. **Fixes 4–5 (depth-clear, LRU)** → JS/wasm; `off=byte-identical` proof for the outdoor case.
4. **Fix 6 (C1/C2 render regressions)** → confirm barren-poison/freeze; resolve white-box/particle.
5. **Fix 7 / B1** → live A/B of player-centered streaming on a dense inland LB.
6. **Build the new verify (§7)** → run the per-LB matrix over a census-sampled cohort
   (towns + dungeons + wilderness + coast), **not** a ring.
7. **Re-capture the three baseline locations** → diff against Step 0; interiors full of walls +
   furniture + oriented NPCs + monsters + working portals.

Run heavy bakes/verify on the **buildbox** (18 cores; `scenery-bake`/`event-bake` need the
`--parallel N` flag from `ring-expansion-method.md` §6). The laptop OOMs on workspace builds.

---

## 9. Acceptance gate (the world is "restored" when)

1. **Generator children staged** for all LBs; dungeon `0x00B4` renders its ~810 monsters (not 0).
2. **Orientation present**: sampled NPCs/portals carry real quaternions; headings match ACE.
3. **Events world-wide**: `dist/events` covers ~40k LBs (not 340 files).
4. **Depth-clear conditional**: interiors win over terrain when indoors; outdoor render
   byte-identical to pre-fix; no interiors-over-terrain at any town.
5. **Streaming proven live** at a dense inland town + wilderness (filled horizon, not barren 3×3).
6. **No render regressions**: zero white-box monsters, portal glows render, no permanent-barren
   LBs, cold-load doesn't starve spawns.
7. **The per-LB matrix is green** across a census cohort (towns/dungeons/wilderness/coast) under
   the §7 INDEPENDENT-truth checks — interior stabs/portals/entities/orientation all verified,
   not just cell counts.
8. **No Holtburg special-casing** remains in load/visibility/verify (an optional boot warm-spawn
   is allowed; a load/cull/verify *center* is not).

---

## 10. Open questions / risks

- **Live state is the one unverified link.** Every conclusion about rendering is from code +
  on-disk artifacts; the last interior screenshot is May 13. Step 0 must run before trusting any
  "it works." (The data regressions A1/A2/A3 are proven from data and stand regardless.)
- **B3 (LRU)** is a code-read inference; confirm on a real multi-LB dungeon before changing
  eviction.
- **C2 (white-box/particle)** is "PENDING DECISION" upstream — settle the material/attach policy
  before implementing; it intersects the Phase-4 visual-suite bake migration.
- **Generator faithfulness**: random-respawn pools are sampled to one deterministic pick (a
  snapshot, not the live rotating population). This matches "what's there on a fresh server
  tick," which is the right target for a static world; document it so it isn't mistaken for a bug.
- **DRW parse traps**: DRW throws on some valid setups (e.g. `0x0100473A`) and mislabels widths
  (Vanquish420's stab-deletion bug; gmriggs's envcell `0x7d64010d`). Never treat a parse failure
  as "delete the object." Prefer ACE.DatLoader / acclient widths per the three-source rule.

---

## 11. Cross-references

- Preserved contracts: world/entity/event-completeness + cell-portal methods (§0).
- Retail oracle: `~/ac-headers/acclient.c:306571` (grab_visible_cells), `:352063/:352114/:352787`
  (load order), `:347955` (interior stab init), `:362347` (CCellPortal); `acclient.h:31893/32072/32094`.
- Runtime: `world_stream.js`, `cells.js`, `statics.js`, `buildings.js`, `spawns.js`,
  `atmosphere_pipeline.js:394`, `landblock_lru.js:260`, `crates/holtburger-world/src/spatial/scene.rs`.
- Staging: `CommandEngine.SiteIngest.cs:263`, `SpawnGazetteerBuilder.cs:130/374`,
  `stage-ring-spawns.py`, `WorldObject_Generators.cs:108`.
- Oracle/verify: `JsonCommandProcessor.cs:1785` (dump-lb-expectations), `:2206` (get-dungeon-info),
  `verify-sweep.mjs`, `validate_landblock_completeness.cjs`.
- Live evidence: `docs/eyetest-2026-06-24/01-holtburg-barren-render.png`,
  `docs/.../2026-06-20-{empty-world-statics,white-box-monsters,busted-world-load-freeze}-handoff.md`,
  `docs/fix-loop-2026-06-17/HANDOFF.md`, `/mnt/wbterminal2/holtburger-dist/_health.json`.
- Regression commits: `a575df28` (depth-clear disable), `d5dda216` (player-centered streaming),
  `5957fd55` (barren-poison), the 2026-06-11/12 unification.

**Use this doc as the diagnosis + contract. The render pipeline is mostly intact; restore the
world by completing the server data (generators + orientation + events), removing the three
Holtburg-shaped shortcuts, landing the June render fixes, and replacing the blind verify with an
independent-truth, interior-complete, per-landblock matrix.**
