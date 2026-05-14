# World-expand step 1 — demonstration screenshots (2026-05-14)

Ten 1920x1080 PNGs proving the world-expand step 1 (13x13 LB ring around
Holtburg, ~2.4 km x 2.4 km) renders end-to-end in the 3D path.

**Re-shot 2026-05-14 after Phase C.3 + C.4** wired the baked scenery
into the renderer (per `docs/hypotheticalmethod.md` §"The renderer's
view"). Captured against the v2 production bake at
`/mnt/wbterminal1/holtburger-dist-v2/` (terrain + LandblockInfo +
**scenery**) with the renderer at the C.3+C.4 commit (parent
`65c11a1` Phase C.1+C.2 close).

The post-C.3 staticsGroup now contains:

| metric | value |
|---|---|
| total placements rendered | **15,252** |
| from scenery bake (Phase B) | **14,523** |
| from LandblockInfo (DAT explicit) | 729 |
| InstancedMesh groups (≥2 instances) | 114 |
| of those, groups containing ≥1 scenery | 31 |
| singleton meshes (1 instance) | 47 |

Pre-C.3 totals: ~729 placements (LandblockInfo only), zero from the
scenery channel. **Phase C.3 yields a 21× increase** in rendered
placements (729 → 15,252) at one new HTTP round-trip per LB (cached
on first hit). The InstancedMesh collapse jumps from a handful of
groups (most LandblockInfo statics are singletons — props, signs)
to 114 — every tree modelId shared across ≥2 LBs becomes a single
draw call.

Bootstrap: `?renderer=3d&quality=high&shadows=off` against a self-hosted
http.Server. The page-context script drives `init3D` directly (the
renderHoltburg login flow gates on a live ACE session), waits for
`liveScene3d.terrainGroup.children.length === 169` AND
`liveScene3d.terrain.lbCount === 169` to confirm the full ring bake
completed (cold init ~16-19 s post-C.3 vs ~13-15 s pre-C.3 — scenery
fetch adds a few seconds of HTTP per LB), then hides the page chrome,
resizes the canvas to fill the viewport, monkey-patches
`cameraSwitcher.positionCamera` to a no-op so the per-rAF tick doesn't
clobber the manual pose, sets `activeCamera.position` + `lookAt` from
AC coords via `acToThree(ax, ay, az) = [ax, az, -ay]`, then snaps the
screenshot after 3 rAF ticks.

## Shots

| # | File | Camera (AC) | LookAt (AC) | Caption |
|---|------|-------------|-------------|---------|
| 1 | `01-holtburg-overview.png` | (32544, 34656, 250) | (32544, 34656, 85) | Establishment shot of Holtburg from 250 m above, showing the town and the new ring fanning out in every direction. |
| 2 | `02-old-perimeter-east-blend.png` | (32800, 34656, 90) | (33500, 34656, 50) | Standing just inside the east edge of the old 3x3 Holtburg ring, looking out across new LBs - smooth terrain stitching. |
| 3 | `03-old-perimeter-south-blend.png` | (32544, 34400, 144) | (32544, 33700, 86.7) | Standing just inside the south edge of the old 3x3 ring, looking south across the new countryside. |
| 4 | `04-old-perimeter-nw-blend.png` | (32300, 34900, 90) | (31600, 35500, 96.4) | NW corner of the old 3x3 ring looking diagonally NW into the newly-baked ring tiles. |
| 5 | `05-south-holtburg-outpost.png` | (32544, 33700, 131.7) | (32544, 33900, 70) | Eye-level approach to South Holtburg Outpost (LB 0xA9B0, home of Hardunna and Hudriffa) - looking north into Holtburg. |
| 6 | `06-outpost-overview.png` | (32544, 33700, 160) | (32544, 33900, 70) | South Holtburg Outpost from elevated angle - settlement laid out below the camera, looking north toward Holtburg. |
| 7 | `07-lumberjacks-camp.png` | (32450, 34200, 112.2) | (32350, 34250, 43.2) | Lumberjack's Camp at LB 0xA8B2 - one of the new POI tiles in the 13x13 ring. |
| 8 | `08-standing-stones.png` | (33150, 34200, 116) | (33050, 34250, 58.2) | Standing Stones at LB 0xACB2 - another POI surfaced by the world-expand step. |
| 9 | `09-ring-ne-distant.png` | (33700, 33500, 200) | (32544, 34656, 85) | NE corner of the new ring looking back SW toward Holtburg - proves the ~2.4 km ring extent. |
| 10 | `10-ring-sw-distant.png` | (31400, 35700, 200) | (32544, 34656, 85) | SW corner of the new ring looking back NE toward Holtburg - the opposite vantage. |

## Scenery placement counts per shot

For each shot, the staged bake's per-LB scenery counts at the camera
LB, the look-at target LB, and the 3×3 LB window around each (a
rough proxy for foreground frustum coverage — fog far is 2500 m so
the actual frustum reaches well beyond 3×3). Values are LandblockInfo-
collision-rejected procedural-scenery placements emitted by
`holtburger-scenery-bake` (Phase B.3 → B.4 ace-compat output).

| # | shot | camLB | tgtLB | cam LB scenery | tgt LB scenery | 3×3 around cam | 3×3 around tgt |
|---|------|-------|-------|----------------|----------------|----------------|----------------|
| 1 | holtburg-overview | 0xA9B4 | 0xA9B4 | 0 | 0 | 246 | 246 |
| 2 | east blend | 0xAAB4 | 0xAEB4 | 8 | 212 | 364 | 1281 |
| 3 | south blend | 0xA9B3 | 0xA9AF | 51 | 66 | 379 | 514 |
| 4 | NW blend | 0xA8B5 | 0xA4B8 | 60 | 40 | 436 | 331 |
| 5 | south outpost | 0xA9AF | 0xA9B0 | 66 | 90 | 514 | 513 |
| 6 | outpost overview | 0xA9AF | 0xA9B0 | 66 | 90 | 514 | 513 |
| 7 | lumberjack's camp | 0xA9B2 | 0xA8B2 | 101 | 86 | 494 | 495 |
| 8 | standing stones | 0xACB2 | 0xACB2 | 142 | 142 | 1029 | 1029 |
| 9 | NE ring distant | 0xAFAE | 0xA9B4 | 114 | 0 | 441 | 246 |
| 10 | SW ring distant | 0xA3B9 | 0xA9B4 | 45 | 0 | 241 | 246 |

Density totals: **14,523 scenery placements across 169 LBs** (~86
per LB average; the 13×13 ring is overwhelmingly grassland which
seeds trees + foliage densely). The densest single LBs are 0xAEB4
(212), 0xABB7 (203), 0xABB6 (198); the sparsest are 0xA9B4 = 0
(Holtburg town centre, all candidates collision-rejected by the 12
buildings), 0xAAB4 = 8, 0xAAB5 = 12.

## Shot-by-shot honest assessment (visible C.3 win?)

- **Shot 01 (Holtburg overview):** ChangedSlightly. Holtburg town
  (camera LB 0xA9B4) is still 0 scenery — buildings collision-reject
  everything. The DARK PATCHES at bottom-left + right of the frame
  are **tree clusters from the surrounding ring LBs** (0xA8B3,
  0xAAB3, 0xA8B4, 0xAAB4, etc.) — 246 placements in the 3×3 window
  around Holtburg. Pre-C.3 those areas were bare grass with a
  handful of LandblockInfo statics. Honest call: **the town centre is
  unchanged because it's literally empty in the bake; the perimeter
  is the win.**

- **Shot 02 (east blend):** Clear win. Trees visible across the
  receding hillside, water/lake in the foreground (terrain code 16
  WaterRunning). Pre-C.3 was a flat-grass view.

- **Shot 03 (south blend):** Massive win. Camera now in a forest
  scene — trees dense throughout the frame. The southern LBs
  (0xA9AF–0xA9B2) have moderate-to-high scenery density (66–101
  placements each).

- **Shot 04 (NW blend):** Clear win. Tree-covered ridge in the upper
  third + water/marsh tiles in the foreground.

- **Shot 05 (south Holtburg outpost):** Changed — but **the brief
  predicted this would be unchanged because "LB 0xA9B0 has 0
  scenery"**. The brief was incorrect: LB 0xA9AF (camera) has 66
  scenery placements, LB 0xA9B0 (target/outpost) has 90 placements,
  and the 3×3 window around the camera totals 514 placements. The
  shot now shows a dense pine forest. **The outpost building itself
  (the brief's "Hardunna and Hudriffa home") is hidden behind the
  trees — only the camp-marker mesh in the middle distance is
  visible.** This is honest scenery placement; the outpost is in a
  forested area in retail too. If a clear shot of the outpost
  structure is needed, the camera needs to be raised or moved closer
  (left as a follow-on; not faking the shot).

- **Shot 06 (outpost overview):** Same as 05 — pine forest dominates,
  outpost not clearly visible. Brief prediction of "unchanged" was
  wrong for the same reason.

- **Shot 07 (lumberjack's camp):** Moderate-to-large win. Camera LB
  0xA9B2 has 101 placements; the frame shows scattered pines + dark
  patches (deciduous trees / rocks) consistent with a working
  lumberjack site. Pre-C.3 was bare grass with one LandblockInfo
  "camp" prop.

- **Shot 08 (standing stones):** Clear win. LB 0xACB2 (the densest
  scenery LB in the 13×13 ring at 142 placements) — frame shows
  trees + small rock-shape statics. The "standing stones" themselves
  are LandblockInfo placements (probably 0x01-prefix GfxObjs); they
  blend with the new tree cover. Pre-C.3 the standing stones were
  visible in isolation against bare grass.

- **Shot 09 (NE ring distant):** **BIGGEST VISIBLE WIN.** Camera at
  the ring's NE corner (LB 0xAFAE, 114 placements) looking SW
  toward Holtburg. The frame is a sea of trees across rolling hills,
  with a river/water tile running diagonally. Pre-C.3 was solid
  green-grass terrain with no scenery. This is the post-card shot
  the C.3 wire-up makes possible.

- **Shot 10 (SW ring distant):** **Second-biggest win.** Camera at
  ring SW corner (LB 0xA3B9, 45 placements) looking NE toward
  Holtburg. Countless trees scattered across the green countryside,
  river / water tile in the middle distance. Pre-C.3 was bare
  grassland. Confirms scenery reaches every corner of the 13×13
  ring.

## Z-adjustments from handoff defaults

The handoff brief's suggested camera Z values were sea-level approximations.
The terrain height under each camera was sampled from the oracle
`heightmaps_13x13.json` and the camera lifted to terrain + 50 m when the
suggested Z would have placed the camera at or below ground:

| File | Suggested camZ | Terrain h at cam xy | Adjusted camZ |
|------|----------------|---------------------|---------------|
| 03-old-perimeter-south-blend | 90 | 94 | 144 |
| 05-south-holtburg-outpost | 85 (rewritten by author) | 81.7 | 131.7 |
| 07-lumberjacks-camp | 40 | 62.2 | 112.2 |
| 08-standing-stones | 50 | 66 | 116 |

Shots 5 and 6 also had their lookAt direction flipped from "south" (the
brief's default) to "north" - the original target Z=20 sat below
terrain and the camera was inside a hillside, so the shot was
re-framed to stand SOUTH of the outpost (in LB 0xA9AF) at terrain+50 m
and look NORTH back into the outpost / toward Holtburg.

The lookAt target Z was also lifted to terrain+5 m when the original
target Z sat below ground (e.g. shots 1, 3, 4, 7, 8, 9, 10). This
keeps the camera focal point above the terrain mesh.

## How to reproduce

```
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node /mnt/wbterminal1/tmp/claude-scratch/world-expand/screenshots/capture_screenshots.cjs
```

(Capture script lives in scratch space - not committed; the artifact is
the screenshots + this README.)

## Visual notes — post-C.3 scenery wire-up

These PNGs were re-shot 2026-05-14 against the C.3+C.4 commit which
landed the second placement stream (DAT-baked procedural scenery)
into `scene3d/statics.js`. The renderer now consumes BOTH
`fetch_landblock_objects` (LandblockInfo, signs/props/named statics)
AND `fetch_landblock_scenery` (baked trees/rocks/bushes) per LB,
concatenates them BEFORE the unique-modelId pass, and routes both
streams through the same InstancedMesh collapse — preserving the
F#5+6 win. Each emitted Three.js node carries
`userData.source = "scenery" | "landblockinfo" | "mixed"` so
post-bake queries can distinguish.

Pre-C.3 baseline (kept here for diff): commit `42c71bf` showed only
the LandblockInfo statics (small dark prop shapes scattered through
Holtburg + named POI props at the lumberjack camp / standing stones).
The 13×13 ring's outer LBs were uniformly green-grass-only — no
trees, no rocks, no foliage.

The previous round of screenshots (commit `8269e4b` / `dbea563`
upstream) also fixed the `CanvasTexture.flipY=true` default for the
terrain atlas + road overlay. The corrected paint matches the
WorldBuilder.Terminal oracle (`terrain_paint_ring.jsonl`): the 13×13
ring is 83 % grass (codes 1 Grassland, 3 LushGrass, 9
PatchyGrassland), 9 % water (codes 16 WaterRunning + 17
WaterStandingFresh), 7 % dirt/marsh/forestfloor (codes 4 / 5 / 21),
0.6 % rock (codes 6 / 13 / 14), and **0 % snow/ice/sand/packed-dirt**
— none of those tile types appear in Aluvian Heartlands.

Buildings render as per-part GfxObj geometry via the Phase 6A
`fetchBuildingPlacement` path; statics (barrels, signs, NPC anchors)
appear as small dark shapes in the overview shots; scenery (trees,
rocks, bushes) renders as collapsed InstancedMeshes (114 groups,
~127 instances/group on average). Fog far is 2500 m per Objective 9,
which is why the ring extent is visible from the elevated cameras
in shots 1, 9, 10.
