# HANDOFF — dat-patch release roadmap: terrain, props/doors, dungeons, creatures, shipping to users (2026-08-15 late)

Owner verdict on the combined dat, in-client on the 1070: **"the textures on buildings look
amazing and i can see the triangles too, no one has been able to do this before."** Expected
adoption on release: ~500–1000 players. This handoff is the plan to finish the world and ship.

## 0. WHAT IS PROVEN AND WHERE IT LIVES (tonight's state)

- **The deliverable**: `/mnt/wbterminal2/dat-patch-texture-remacri/export/` —
  `client_portal.dat` sha256 `7d2745e9…`, **1114.9 MiB** (ceiling 2048): 4× displaced
  geometry (447 architecture GfxObjs, physics byte-identical) + Remacri 4× textures with
  the legibility bake (571/768 surfaces; 196 palettized-source sids still base-res bake)
  + collapsed single-entry SurfaceTextures. Cell dat = content-identical to base.
  **In-client proven**: world entry, 310s+ stability, 5-town tour, daylight close-ups
  (videos in `/mnt/wbterminal2/dat-patch-texture-lane/gate-1070/`, A/B boards in
  `…texture-remacri/boards/`).
- **Three crash/correctness classes found by the in-client gate and fixed forever**:
  (1) DRW b-tree leaf sentinels (`texture_lane.py fixup`, runs in the driver package phase);
  (2) appended polys sides=2/neg=-1/stip=9 → ConstructMesh AV (`polyfix.py` +
  `ObjSingleMeshImporter.cs` now writes Landblock(0)/None/neg=0);
  (3) base-res bake (`--remacri` flag; box has no corpus — Remacri passes run on the laptop).
  Lesson burned in: **tooling round-trips prove structure, only the retail client proves
  render semantics — the in-client gate is mandatory per lane.**
- **Automation**: full 1070 driving stack (`docs/dat-patch/1070-acclient-driving.md`) —
  isolated client at `D:\ac-dat-test`, schtasks tasks `acdtgate/acdtclick1/acdttour4/5`,
  OBS profile `acdt`, idle-guard + mid-tour human detection. ACE currently serves the
  remacri export (`Config.js`; vanilla restore = `Config.js.pre-texture-gate-bak`).
- Commits through `8d2213d2` on `integ/all-20260813` (pushed).

## 1. LANE: TERRAIN (owner's top gap; SMALL and fully covered — do first)

Recon done tonight: Region `0x13000000` → `terrainInfo.landSurfaces.texMerge.terrainDesc`
(33 entries, 30 unique SurfaceTextures) → **29 unique RenderSurfaces; corpus coverage
29/29** across `upscale-corpus/out/terrain-{remacri,ultrasharp,x4plus,hat-l}`. Plus 8
blend maps (cornerTerrainMaps 4, sideTerrainMaps 1, roadMaps 3) — **those are alpha/blend
MASKS: import untouched or up-res WITHOUT the legibility bake; never emboss a mask.**

Recipe: the texture-lane machinery applies verbatim — build a terrain surfaces.json
(ST→RS from the Region record), bake with `--remacri` (consider `terrain-ultrasharp` vs
`remacri` A/B on one texture first — pick per-texture winner by eyeball board), import +
collapse, fixup, in-client gate. Client side already handled: `LandscapeTextureDetail=0`
is in the test INI (ship-config item, §5). Watch: terrain tiles 2×–4× (`texTiling`), so
seams matter more than on buildings — the bake's tanh-limited emboss is seam-safe by
construction, but eyeball a tiled grass expanse for grid artifacts. Budget: trivially
small (~30 textures ≈ 15–30 MB).

## 2. LANE: DOORS / PROPS / BARRELS (weenie objects — high visibility, medium size)

These are server-spawned WorldObjects; the client renders their Setups/GfxObjs from
portal.dat, so **DAT patches reach them for free** (r1 decomp-proved). Two sub-lanes:

- **Textures** (the big visible win, do first): census = enumerate the GfxObjs/surfaces
  actually spawned near players: (a) ACE world DB `landblock_instances` → weenie →
  `PropertyDataId.Setup` → Setup parts → GfxObjs → surfaces → RS (WBT `ace-db-*` connects;
  creds in `$ACERT/Config.js`), or (b) LSD `spawnMaps/` + `weenie_summary.jsonl` setupDid
  column for the same offline. Then diff the RS set against the PNG corpora
  (statics-remacri + tranche1 = 4,041 RS) and the holtburger BC7 archive (owner: complete
  coverage incl. monsters — use it as the authority for what CAN be covered; transcode
  BC7→PNG only where no PNG exists, it's a lossy-source fallback). Missing ones: the
  upscale runner is proven (`upscale-corpus/corpus-ledger.jsonl` format) — batch what's
  missing. Then the standard bake→import→collapse→fixup→gate.
  **Doors first**: small id set, the owner specifically noticed them next to patched
  walls; likely a handful of Setups shared world-wide — outsized win per byte.
- **Geometry**: 1,040 statics were skip-small (≤50 tris) and ~434 candidates cleared the
  cut but weren't in the 447 displace set — re-run the tranche with the budget planner
  targeting the next tier (hero props: wells, carts, signs, barrels). The importer fix
  means new imports are retail-safe out of the box; `polyfix.py audit` is the regression
  net. Also close out `degrade_deferred.json` (the 5–9 band-object records).

Palettized trap for props/creatures: many object textures are INDEX16 + palette because
**the palette-swap system (clothing/skin recolor) depends on them** — naive de-palettizing
to RGB breaks recoloring. For STATIC props with fixed palettes an RGB conversion is safe;
for clothing/creature-tint textures it is NOT. The 196 skipped sids from the building lane
are the same family. An INDEX16-aware converter (resolve palette → RGBA → bake → DXT)
covers statics; recolorables need a design decision (skip, or up-res the index map +
palette-resolution at bake per DEFAULT palette only).

## 3. LANE: DUNGEONS (Environment 0x0D — players live indoors; the Academy was the
owner's first frame)

Main-handoff TODO #4, unchanged and next after props: build `environment-import` on the
fixed obj-import template (772 Environment records = 6 MiB source, 735k EnvCell instances,
best value-per-byte; CellPortal polys stay pinned; DRW packs Environment/CellStruct;
`PortalDatDocument.SetEntry<T>` stages). Interior surfaces mostly SHARE the building
texture corpus — run the census first; a big fraction of dungeon walls may already be
covered by tonight's 571. The r2 cave A/B was the owner's standout — expect this lane to
be the most visible after terrain.

## 4. LANE: CREATURES/MONSTERS (last; hardest)

Textures: same census→corpus→bake pipeline (BC7 archive says coverage exists), but the
palette/recolor trap above applies at full force (creature tinting). Geometry: PN-tess
with max-deviation guard was gate-refused in r2 — revisit only after everything else ships.

## 5. RELEASE ENGINEERING (500–1000 users will not run WBT)

1. **Package** = `client_portal.dat` (+`client_cell_1.dat` when it starts differing) +
   README + sha256 + version tag. Bump the iteration on every release (DDD uses it).
2. **The texture-detail pref is NOT optional**: boot default `EnvironmentTextureDetail=2`
   halves every upload and **no in-game preset reaches 0** (dossier §3/§4). Ship a
   `UserPreferences.ini` **snippet + one-paragraph instruction** (merge `[Render]
   EnvironmentTextureDetail=0` + `LandscapeTextureDetail=0` into the install-dir or
   Documents INI) — or a 20-line installer script that does the merge. Do NOT ship a whole
   INI (it would clobber user keybinds/audio).
3. **Server story**: ACE servers must run the same dats (`Config.js DatFilesDirectory`)
   or clients get booted by DDD ("newer DATs than server"). Document both paths for server
   ops: adopt the dats server-side (also gives servers the correct physics view — ours is
   byte-identical to retail so nothing changes for them) or leave DDD default and require
   matched versions. ACE.DatLoader reads the patched dat clean (validated) — no server
   code changes needed.
4. **Headroom**: 1114.9 of 2048 MiB used. Terrain+doors fit easily; props+dungeons+
   creatures at 4× will approach the ceiling → **trevis's DAT-compression client patch**
   (author-measured 40.2% whole-set) graduates from optional to scheduled: derive by
   byte-signature (never quoted addresses — build drift), zlib 1.2.2, soak-test, and note
   paradox's "may be a deliberate workaround" caveat. Harness at
   `/mnt/wbterminal2/ac-eor-patch/`. Fallback: per-class resolution caps (512² tier for
   low-importance surfaces).
5. **Repeatable pipeline**: everything is now scripted — enumerate→geometry
   tranche→`--remacri` texture pass→`fixup`→`polyfix audit`→3-family validation→in-client
   gate→package. Fold into ONE driver (`tools/dat-patch/release.sh`) so a release is one
   command + one 1070 eyeball. Fold the ConstructMesh 10-invariant checklist (polyfix.py
   docstring) into `validate.py` so it exits non-zero on any of them.
6. **Known-open QA items**: mip-cap check (client caps 4 mip levels — verify no distant
   shimmer on 1024² textures in a slow pan; if bad, 512² cap per class), z-fighting soak
   on the 6mm shell at distance (tour5 showed none; do one deliberate far-pan pass), the
   8 weak-seam DeepBump records, 2 corpus-missing RS, forced 800×600 window (fine for
   automation; for the showcase investigate whether in-game res options apply post-boot).
7. **Distribution note**: AI-upscaled derivatives of Turbine assets — same community
   status as the dats themselves; follow prevailing emu-community norms (no retail
   assets beyond what players already have; ship as a patch requiring an existing install).

## 6. SHOWCASE VIDEO (the announcement asset)

OBS pipeline is ready. Next day-window (Dereth day = ~79 real min per 2.1h cycle; poll
`time` via the ACE console FIFO): scripted shot list — sunrise grazing light on the
Holtburg cottage row, 45° step-turns with 2.5s pauses, walk-ins to walls, then an
**intercut before/after**: run the identical teleloc+scan path once on base dats and once
on patched (two client sessions; ACE must serve matching dats per arm — or use the
`retailvanquish` spare dat folder trick client-side with `-rodat` while ACE keeps DDD off
for one arm). 800×600 is acceptable for Reddit if upscaled 2×; try the res-options
investigation first. Deliver via taildrop for owner cut/approval before posting.

## 7. ENVIRONMENT STATE (as left tonight)

- ACE on this laptop serves `/mnt/wbterminal2/dat-patch-texture-remacri/export/`
  (restore: `Config.js.pre-texture-gate-bak`, then `stop-now` → relaunch per
  memory/ace-live.md).
- 1070: test kit `D:\ac-dat-test` (remacri portal sha-verified), tasks + scripts in
  `C:\Temp`, watcher auto-kills the test client at lifetime end. Original install and the
  user's own files untouched.
- buildbox: STOPPED, n1-standard-4 (no cost accruing).
- Leftover to delete at leisure: `/mnt/wbterminal2/tmp-fixup-test/` (946 MB, rm was
  permission-blocked in-session).
- The pre-remacri gate artifacts (fixed base-res portal, sha `9fb73e1b…`) remain in
  `/mnt/wbterminal2/dat-patch-texture-lane/export/` as the rollback tier.

---
## ADDENDUM 2026-08-16 — LANE 1 (TERRAIN) BUILT + TOOLING-VALIDATED; in-client gate in progress

- **Decomp recon changed the lane's shape.** TexMerge::FillTempTexBuffer allocates its merge
  buffer once as `4*Region.baseTexSize²` (acclient.c:305935) and ImgTex::TileCSI (:365513)
  raw-DWORD-copies with `src_width == composite/texTiling` assumed EXACTLY, from a LOCKED
  surface (32-bit uncompressed assumed — DXT sources would be read as garbage). With retail
  Region (baseTexSize 1024, tiling 2) terrain sources are **structurally pinned to 512²
  A8R8G8B8**. A 4× terrain up-res requires Region.baseTexSize=4096 → composite land
  surfaces upload UNCOMPRESSED per terrain-combo (CreateLScapeTexture) → quadratic
  address-space cost on a 32-bit client. That is a separately-gated EXPERIMENT (baseTexSize
  2048 + 1024² sources is the plausible middle step), NOT the ship lane.
- **Shipped design**: 29 base terrain RS rebuilt as Remacri 2048² supersampled → 512²
  Lanczos + exposure anchor (1.15×; water STs kept 1.0×), format-preserving A8R8G8B8,
  alpha verbatim, size unchanged. **Emboss OFF for terrain — board-proven**: the low-band+AO
  paints broad diagonal blotches that repeat with the tile (boards 0x06006D3F/42/6F).
  Blend masks + 3 detail textures untouched. Base terrain STs are single-entry (verified) —
  no collapse step exists in this lane.
- **Tooling committed** (2ea956f8): `tools/dat-patch/terrain_lane.py` (derive/bake/board/run)
  + `tools/dat-patch/AceDatWalk` (durable ACE.DatLoader full-walk + byte-diff validator).
- **Export**: `/mnt/wbterminal2/dat-patch-terrain/export/client_portal.dat` sha `c9ba5061…`
  (1114.9 MiB, same size as remacri tier — in-place). 3-family validation ALL CLEAN:
  ACE 79,694/79,694 read + diff vs retail base exactly 1,730 changed (1,701 prior + 29
  terrain), strict python walk CLEAN, WBT roundtrip 29/29 formatPreserved. fixup zeroed 4
  fresh DRW sentinel leaves (load-bearing every run, again).
- **DDD iteration byte-identical (2073)** between remacri and terrain exports — ACE can
  serve the terrain export with zero disruption to remacri-dat clients.
- **State as of this addendum**: laptop ACE serves the terrain export
  (`Config.js.pre-terrain-gate-bak` = restore to remacri). 1070 test kit portal swapped
  (remacri tier kept as `client_portal.dat.remacri.bak`). In-client gate: world entry OK,
  DDD accepted, stability soak + daylight terrain tour (`acdttour6`, Holtburg/Eastham/
  Yaraq ground pans) pending Dereth dawn.

## ADDENDUM 2026-08-16 ~01:00 — TERRAIN GATE PASSED; DOORS BUILT+VALIDATED; PROPS WAVE-1 IN FLIGHT

- **TERRAIN IN-CLIENT GATE: PASSED** (1070, daylight 3-town tour Holtburg/Eastham/Yaraq,
  session held, no crash; stills in `dat-patch-terrain/gate-1070/shots/`). Terrain tier
  (`c9ba5061…`) is now the gated rollback tier above remacri. ACE serves it.
  Two operational finds: (a) **watcher PrintWindow shots WORK** (1030×797, full color —
  the runbook's "PrintWindow is black" no longer holds; OBS WGC records black for
  RE-launched clients, cause unknown — use shots for eyeballs); (b) mid-gate the laptop
  MariaDB died from memory pressure (a runaway `bfs`/find of mine; earlyoom) → ACE
  "connection lost" mid-tour once — restart: `sudo /etc/init.d/mariadb start`. Char-select:
  slot order did NOT drift; stale sessions were the real cause of failed entries —
  fresh acdtgate (schtasks /end first! /run on a live task no-ops) then click ladder.
- **DOORS LANE (lane 2, doors-first) BUILT + 3-FAMILY VALIDATED, gate pending**:
  census 423 wcids/26,348 instances → 53 setups → 104 RS. 30 already patched; 59 baked
  (44 plain + 15 INDEX16 palette-converted to DXT); 14 deferred (no corpus → buildbox
  batch); 1 EXCLUDED (0x060037A3 palettized+ClothingTable-recolored house doors 0x02000C07–0D).
  Recolor safety = ClothingTable raw byte scan + ACE weenie palette/texture rows (all zero
  for doors). Export `dat-patch-doors/export/` sha `96f89e37…` 1136.4 MiB, ACE walk
  79,694/0 fail (1,825 changed = 1,730 + 59 RS + 36 collapses), strict walk CLEAN,
  polyfix audit clean. Staged on the 1070 as `client_portal.dat.doors`; gate at next
  Dereth dawn (~02:05): swap box portal + ACE DatFilesDirectory → doors export, tour5
  (building close-ups show doors) + tour6.
  NOTE the A/B board renderer draws the PATCHED door as flat grey — board-tooling
  artifact only (dat readback of 0x06006DF9 verified correct DXT1 1024² wood); don't
  chase it as a dat bug.
- **Tooling landed** (75bda16d): `pallib.py` (P8/INDEX16 palette decode per
  holtburger-dat texture.rs semantics: override-else-default palette, clipmap idx<8
  transparent per ImgTex::CopyIntoData :365958); texture_lane PFID fix (real ids 41/101,
  old {1,65} was hex/decimal confusion — its palette skip never fired); **base-alpha
  transplant in the bake** (corpus upscales of palettized sources are opaque; door
  0x06003966's transparent window would have shipped opaque red); ConstructMesh
  10-invariant checklist as `polyfix.constructmesh_check` + validate.py check K (flags
  the historical sides=2/neg=-1 AV on the pre-polyfix export 50/50, clean on shipped).
- **PROPS CENSUS (full)**: 788 placed non-creature setups → 1,378 GfxObjs → 1,109 unique
  RS; 195 already patched; TODO 914 = 260 plain corpus-covered + 6 plain missing +
  648 palettized. ClothingTable scan: 224 prop setups recolor-live → 396 palettized RS
  UNSAFE (skip; refinement: check placed weenies' PaletteTemplate to reclaim some),
  252 safe (174 corpus-covered, 78 need upscale). **Wave-1 bake+import RUNNING** (434 RS =
  260+174) into `dat-patch-props/export/` (copy of doors export — tier: terrain(gated) →
  doors(candidate) → props-wave1(candidate)). **Buildbox micro-batch needed: 98 textures**
  (78 pal + 6 plain + 14 doors) — lists in scratchpad `props_wave1.json` (copy into the
  lane dir!) — then wave-2.
- Scratchpad census artifacts copied to `/mnt/wbterminal2/dat-patch-props/` and
  `/mnt/wbterminal2/dat-patch-doors/` (door_census, props_todo, props_pal_safety,
  props_wave1, door_p8_plan) — do that copy if missing.

## ADDENDUM 2026-08-16 ~01:15 — DOORS GATE PASSED; PROPS WAVE-1 BUILT, GATE PENDING

- **DOORS IN-CLIENT GATE: PASSED** (~01:05, tour5 building close-ups, session held,
  no crash; `dat-patch-doors/gate-1070/door_60.png` = patched plank+iron-strap door
  crisp at 1024² beside remacri masonry; video tour5-doors.mkv). Tier ladder now:
  remacri → terrain(GATED) → doors(GATED) → props-wave1(candidate). ACE serves doors.
- **PROPS WAVE-1 BUILT + TOOLING-VALIDATED** (sha `d37cda9a…`, 1283.8 MiB): 434 RS
  (260 plain + 174 recolor-safe palettized→DXT; clipmap alpha verified in-dat).
  2,470 total changed vs retail. Staged on the 1070 as `client_portal.dat.props`;
  gate next Dereth dawn per `dat-patch-props/GATE-STATUS.md`.
- OBS note: the black-capture was transient — later tours recorded fine (102 MB
  daylight terrain video `dat-patch-terrain/gate-1070/tour6-daylight.mkv` is
  SHOWCASE-GRADE raw material: 3 towns, ground pans, step-turns, daylight).
- Remaining for lane 2 completion: buildbox 98-texture upscale micro-batch, wave-2
  bake, PaletteTemplate refinement to reclaim some of the 396 recolor-live RS.
  Then dungeons (lane 3).

## ADDENDUM 2026-08-16 ~02:05 — PROPS WAVE-1+2 GATED. THREE LANES SHIPPED IN ONE NIGHT.

- **PROPS IN-CLIENT GATE: PASSED** (tour5 + tour6 on the props dat, session held, zero
  crashes). Tier ladder: remacri → terrain(GATED) → doors(GATED) → **props-wave1+2(GATED,
  sha `095c8ea9…`, 1289.6 MiB, 2,644 records changed vs retail)**. ACE + the 1070 kit
  both run it. Evidence + per-tier notes: GATE-STATUS.md in each lane dir.
- **`/day` kills the dawn-scheduling problem** (owner's tip): client chat command →
  DoDay → LScape::SetDay(AlwaysDaylight). Lights the landscape (sky stays night —
  fine for gates; the SHOWCASE should still film in real daylight for the sky). Both
  tour scripts send it on start now.
- **Buildbox 98-texture Remacri batch DONE** (T4, ~40s of GPU): corpus dir
  `upscale-corpus/out/batch2-remacri/` + ledger. Runner rebuilt at box
  `~/upscale-batch2/upscale_batch2.py` (spandrel; ⚠ pin torch==2.5.1+cu121 — bare
  `pip install spandrel` drags in torch cu130 which the 550 driver refuses; also
  `--no-cache-dir`, the 128 GB disk is ~90% full). Box is STOPPED again.
- **`tools/dat-patch/release.sh` landed** (4aa27336): one command = fixup → polyfix
  audit → ACE walk+diff → strict walk → ceiling check → tgz + sha + user README
  (with the mandatory UserPreferences.ini merge note). Smoke-proven on both gated
  tiers: `acme-dats-r1-doors.tgz` (dat-patch-doors/) and `acme-dats-r2-props.tgz`
  (dat-patch-props/) exist and are the first release-shaped artifacts.
- **Remaining, in order**: (1) dungeons lane (Environment 0x0D — the census machinery
  is all reusable; interior surfaces largely covered by the 571 building corpus);
  (2) PaletteTemplate refinement to reclaim part of the 396 recolor-live prop RS;
  (3) creatures (last); (4) showcase video in real daylight + before/after intercut;
  (5) distribution (r2-props package is the current best candidate).

## ADDENDUM 2026-08-16 — DUNGEONS LANE (lane 3)

### Census (2 min of laptop time — datlib parses EnvCell/Environment/Setup directly, no WBT needed)
734,976 EnvCells walked (cell dat b-tree walk = 5s): **804 unique Surfaces → 712 unique RS,
769 Environments**. 237 RS already patched by prior tiers (28% of the 3.1M cell-surface
refs). TODO was 475 = 460 plain corpus-covered + 15 palettized (ALL corpus-covered, ALL
recolor-safe) + 0 missing. Recolor safety now uses a GLOBAL clothing-reachable RS set
(1,975 setups extracted from all 1,917 ClothingTables → 1,624 RS, `clothing_rs_global.json`)
— reuse this for creatures. Dungeon interiors keep the FULL legibility bake including
emboss (walls are seen like building walls, not tiled like ground).

### Geometry sub-lane (environment-import) — SCOPED, not built
- Template confirmed: ObjSingleMeshImporter carries original physics/drawing BSPs
  VERBATIM while appending displaced render polys (in-client proven on 447 buildings);
  the same append pattern applies to CellStruct (physics polys + CellPortal polys pinned,
  polyfix-safe defaults for appended polys).
- ⚠ THE WRINKLE the building lane didn't have: CellStruct polygon surface indices index
  into EACH EnvCell's OWN surface array — the same Environment renders as stone in one
  dungeon and ice in another. Per-texture displacement heights therefore CANNOT be baked
  into shared geometry from one cell's textures. Options: (a) dominant-texture per
  (environment, surface-index) across the 735k-cell census; (b) conservative
  class-agnostic amplitude; (c) skip polys with high texture diversity. Decide with a
  single-dungeon pilot + in-client A/B before any tranche.
- Dungeon-specific gate risks: z-fighting of the displaced shell in tight corridors,
  portal-opening flicker — soak inside small rooms, not just big halls.

### DUNGEON TEXTURE LANE: BUILT + GATED (same night, ~03:19)
475 RS imported (460 plain + 15 pal-safe, full legibility bake WITH emboss),
365 collapses, portal 1449.4 MiB, all structural gates clean (3,482 changed vs
retail), **in-client gate PASSED** — tour7 through undead catacomb / olthoi
tunnels / drudge dungeon via exact creature-spawn @teleloc + @attackable off;
mossy stone, brick, and carved-panel interiors all read dramatically sharper,
zero crashes. Details + the tiny-source-hallucination watch item:
`dat-patch-dungeons/GATE-STATUS.md`. Package: `acme-dats-r3-dungeons.tgz`.
Tier ladder now: remacri → terrain → doors → props → **dungeons (GATED, ACE
serves it)**. Census artifacts copied into the lane dir. tour7 script deployed
on the 1070 (acdttour7). Remaining in lane 3: the geometry sub-lane (scoped
above). Then creatures (lane 4) — reuse `clothing_rs_global.json` as the
recolor wall, expect most creature textures recolor-live.
