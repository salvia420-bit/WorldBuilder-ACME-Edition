# World-expand step 1 — demonstration screenshots (2026-05-14)

Ten 1920x1080 PNGs proving the world-expand step 1 (13x13 LB ring around
Holtburg, ~2.4 km x 2.4 km) renders end-to-end in the 3D path. Captured
against the v2 production bake at `/mnt/wbterminal1/holtburger-dist-v2/`
with the renderer at commit `42c71bf` (aliasing fix; tip of world-expand
step 1 wave).

Bootstrap: `?renderer=3d&quality=high&shadows=off` against a self-hosted
http.Server. The page-context script drives `init3D` directly (the
renderHoltburg login flow gates on a live ACE session), waits for
`liveScene3d.terrainGroup.children.length === 169` AND
`liveScene3d.terrain.lbCount === 169` to confirm the full ring bake
completed (cold init ~13 s, full ring bake settled within ~17 s of
page load), then hides the page chrome, resizes the canvas to fill the
viewport, monkey-patches `cameraSwitcher.positionCamera` to a no-op so
the per-rAF tick doesn't clobber the manual pose, sets
`activeCamera.position` + `lookAt` from AC coords via
`acToThree(ax, ay, az) = [ax, az, -ay]`, then snaps the screenshot
after 3 rAF ticks.

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

## Visual notes

The renderer at `quality=high` uses the AC-DAT terrain texture atlas
with Region 0x13 32-terrain-code mapping (grass / dirt / sand / stone /
snow). The bright-blue and white-streaked patches across some LBs
(visible in 01, 05, 06, 07) are the renderer's snow/stone terrain
codes, not artifacts. Buildings are rendered as per-part GfxObj
geometry via the Phase 6A fetchBuildingPlacement path; statics
(barrels, signs, NPC anchors) appear as small dark sprites in the
overview shots. Fog far is 2500 m per Objective 9, which is why the
ring is visible from the elevated cameras in shots 1, 9, 10.
