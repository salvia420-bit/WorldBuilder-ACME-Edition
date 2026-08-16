# HANDOFF — meaningful dungeon relief via WorldBuilder.Terminal (environment-variant design) + all open items (2026-08-16)

## 0. THE QUESTION THIS ANSWERS
Can the worldbuilder-terminal skill + WBT's JSON command surface carry the
environment-variant design (real per-texture dungeon relief despite shared
prefabs)? **Yes — the pipeline below is ~90% existing commands; exactly two
small commands are missing, both trivial on DRW's proven write support.**
The pilot (r4 tier) already proved the hard part in-client: appended CellStruct
render geometry draws correctly with physics/portals/BSPs carried verbatim.

## 1. WHY VARIANTS (recap of the blocker)
CellStruct polygon surface indices resolve through EACH EnvCell's own surface
array — one prefab renders as stone here, ice there. Only ~36% of cell-slot
usage has a ≥90%-dominant texture, so relief baked into the SHARED record
mismatches the albedo in most cells (r4 shipped the honest 7-shell subset).
Fix: mint variant Environment records per texture-cluster and retarget the
EnvCells of each cluster to the variant whose relief matches their textures.

## 2. SIZING (measured tonight over all 734,976 EnvCells)
Clustering on WALL-CLASS slots only (the ones that carve; 420 of 804 cell
surfaces classify wall — floors/ceilings/water don't carve and don't need
variants):

| coverage target | variant envs to mint | EnvCells to retarget | wall-cell coverage |
|---|---|---|---|
| 80% per pair | 4,262 | 248,423 | 69% of all wall-cells |
| 90% per pair | 6,189 | 296,003 | 76% |
| 95% per pair | 7,698 | 320,490 | 79% |

- Environment id space is 16-bit; 769 used, **63,944 free** — no ceiling issue.
- Retargets are IN-PLACE u16 rewrites (EnvironmentId, same record size) — the
  cell dat grows zero bytes; only the b-tree churns (fixup handles it, proven).
- Further reduction available: cluster on the slot's **RenderSurface** rather
  than Surface id (surfaces sharing one RS need identical relief → merge).
- v1 recommendation: TOP-300 (env,cs) pairs by cell count → roughly 1–2k
  variants / ~150k retargets, covering the dungeons players actually see.
  Scale after the first gate.

## 3. THE PIPELINE (skill-driven; per the worldbuilder-terminal agent loop)
Python planning (exists): `tools/dat-patch/env_geo.py` extended with a
`cluster` mode — key per (env,cs) on wall-slot surface tuples, pick clusters,
emit a variant plan {newEnvId, sourceEnvId, cs, slot→sid map, cell list}.
Shell builds reuse the existing `build` machinery per-cluster (each variant's
shell is displaced with ITS OWN textures' height fields — the same honest
per-texture relief the 447 buildings shipped).

WBT commands, in order per release copy:
1. `clone-dat` — snapshot portal + cell copies (exists).
2. **`environment-clone` (TO BUILD #1)** — copy Environment 0x0D00XXXX to a
   free id. Trivial: DRW read + SetEntry under the new id. (Could be folded
   into environment-append-geometry as `cloneToIdHex`.)
3. `environment-append-geometry` (exists, in-client proven, r4) — append each
   variant's displaced shell; `usemtl surfN` = cell-local slot index.
4. **`envcell-retarget` (TO BUILD #2)** — batch [{cellIdHex, environmentIdHex,
   cellStructure?}] against a CELL-dat copy; rewrite EnvCell.EnvironmentId
   (u16 at offset 16+2*numSurfaces). DRW CellDatabase has write access and
   EnvCell round-trip tests (external/DatReaderWriter/DatReaderWriter.Tests/
   DBObjs/EnvCellTests.cs) — same SetEntry pattern as every other lane write.
5. Validators — this is where the skill earns its keep (its "recommended
   agent loop": act → validate → inspect the three observation channels):
   - `validate-dungeon` per affected landblock (cell connectivity, portal
     integrity, unreachable cells) — catches a bad retarget without a client;
   - `cell-portal-graph-sweep` — world-scale portal DAG re-check;
   - `chorizite-parse-dat-record` roundtrips on minted envs + edited cells;
   - python: datlib.parse_environment strict + parse_envcell over edits;
   - `tools/dat-patch/release.sh` (fixup — MANDATORY, env writes taint ~2k
     b-tree leaves per record — polyfix audit, AceDatWalk on BOTH dats,
     strict walk, package).
6. 1070 in-client gate: tour7/tour8 pattern + one NEW stop per top-5 variant
   cluster (spawn positions from landblock_instance, @attackable off, /day).

DDD note: cell dat now DIFFERS from base for the first time (the geometry
lane's cell exports were content-identical). Ship portal+cell together;
iterations stay matched because both sides serve the same files. Bump the
iteration pair at release per roadmap §5.1.

## 4. RISKS / WATCH ITEMS SPECIFIC TO THIS LANE
- A retargeted cell's variant env must keep IDENTICAL physics/portals (clone
  guarantees it) or player movement desyncs vs ACE (server reads its own copy
  of the dats — adopt server-side per roadmap §5.3 and physics stays exact).
- Client memory: +1–2k demand-loaded Environment records is nothing; the
  appended shells are the same budget class as the building tranche.
- Mixed rooms: a dungeon where SOME cells retargeted and neighbors didn't
  (below coverage cutoff) shows relief seams at cell boundaries. Mitigate by
  retargeting per-DUNGEON-cluster (all-or-none per landblock) in v1.
- The two new commands must refuse writes to ~/ac_base_dats (house rule).

## 5. EVERYTHING ELSE OPEN (consolidated, in priority order)
1. **Owner decisions pending**: (a) go/no-go on this variant lane; (b) eyeball
   the r4 tier tiny-source Remacri hallucination watch item
   (dat-patch-dungeons/GATE-STATUS.md) — fallback = milder 2× for sub-128px
   sources, one rebake; (c) showcase timing/cut.
2. **QA passes (roadmap §5.6)** — batch into ONE 1070 window: mip-cap slow pan
   on 1024² textures (distant shimmer check), z-fight far-pan on the 6mm
   shell, and the in-game res-options investigation (800×600 → higher for the
   showcase).
3. **Showcase video (§6)**: REAL daylight (the /day trick lights terrain but
   the sky stays on the game clock — fine for gates, wrong for the trailer);
   next Dereth day window; scripted shot list + before/after intercut (ACE
   must serve matching dats per arm, or -rodat + spare dat dir client-side);
   deliver via taildrop for owner cut. Raw material already good:
   dat-patch-terrain/gate-1070/tour6-daylight.mkv (102 MB, 3 towns).
4. **Monster textures (the 811 recolor-live wall)**: needs a
   palette-composition-aware design — options: (i) up-res the INDEX16 index
   map and palette-resolve at runtime-equivalent quality (changes index width
   — research); (ii) per-PaletteTemplate baked variants via ObjDesc rewrite
   (explodes texture count); (iii) leave tinted monsters at retail res
   (current state, owner-visible only on close inspection). Census + global
   clothing-reachable set ready: dat-patch-creatures/census/.
5. **Distribution (§5.7)**: r4 package exists (acme-dats-r4-creatures-envgeo.tgz
   + per-tier rollbacks r1–r3). Remaining: iteration bump at release, the
   community-norms note (patch-over-existing-install), server-ops doc (§5.3).
6. **Headroom**: portal at 1540 MiB of 2048. Monsters/dungeon-variants will
   push toward the ceiling → trevis's DAT-compression client patch
   (/mnt/wbterminal2/ac-eor-patch/, byte-signature derivation, zlib 1.2.2,
   soak) or per-class 512² caps, per roadmap §5.4.
7. **Small opens**: texture_lane board renderer draws patched records as grey
   (tooling-only; dat readback proven correct — fix when convenient);
   ~/tmp-fixup-test kept deliberately as the polyfix negative-test fixture;
   ACE currently serves r4 (restore chain via Config.js.pre-*-bak files);
   1070 kit: r4 live, dungeons tier as .bak; tours acdttour4–8 deployed;
   skill.md updated with environment-append-geometry (this commit) — add the
   two new commands to it when built.

## 6. STATE POINTERS
Tier ladder + shas: see GATE-STATUS.md in each dat-patch-* lane dir
(terrain c9ba5061 → doors 96f89e37 → props 095c8ea9 → dungeons 22baf1f7 →
r4 af470f32). Machinery commits: 2ea956f8 (terrain lane), 75bda16d (pallib +
checklist), 966e50cc (env geometry), 4aa27336 (release.sh). All pushed on
integ/all-20260813.
