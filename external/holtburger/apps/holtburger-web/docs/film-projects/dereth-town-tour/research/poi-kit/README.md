# poi-kit — offline world kit for the Dereth tour expansion (2026-10-15)

Built from WorldBuilder.Terminal dumps (describe-landblock with footprints, list-objects, get-terrain-data,
get-object-detail) of the 3×3 landblocks around all 184 acpedia Major POIs and around every existing tour shot,
plus the served dist's default procedural scenery (what the film client draws), the opt-in retail scenery bake and
the ACE outdoor spawns. 2,197 landblocks in `world/0xXXYY.json`. Verified against the original town research: the
checker reproduces its numbers (holtburg.01 min clearance 4.5 m vs 4.53, LOS 41/58 vs 40/57; holtburg.04 bank 31.5 m).
**No WorldBuilder.Terminal, no browser needed.** Seven landblocks WBT cannot load are missing (e.g. Fort Tethana's).

```bash
KIT=/mnt/wbterminal2/film-projects/dereth-town-tour/research/poi-kit
python3 $KIT/area.py <x> <y> [radius=250] [--map] [--cell=12] [--statics=40]   # what is there
node $KIT/check.mjs <plan.json> [shotId …] [--verbose] [--step=1] [--json]       # does the shot fly clean
```

Coordinates: AC world metres `[x east, y north, z up]`; `wx = lbX·192 + localX`; acpedia map coords →
`wx = (EW + 101.95)·240`, `wy = (NS + 101.95)·240` (S and W negative). Headings are compass (0 = north, 90 = east).

## area.py
Landblock summaries (region, town, architecture, terrain, z range), water vertices, every **building** (type,
origin, floor..top z, roof), **statics grouped by model** (ontology category, tags like `tower,stone`, size, top z,
nearest positions, weenie names such as Life Stone / Portal), **outdoor spawns** (portals, fountains, braziers,
generators; creatures summarised), **gazetteer entries with teleports** within the radius, and `--map`: an ASCII map
(north up; digits = ground height above the centre in 10 m steps, `-` lower, `~` water, `B` building, `o` static,
`t` tree of the default bake, `*` spawn/FX, `@` centre).

## check.mjs
Builds every shot of a plan file with the REAL technique registry (`scene3d/film/shots`) at its take length
(`trim.takeSec` when set, else `duration.sec`) against the real terrain and samples it at the plan fps:
- `AGL min..max` terrain clearance under the lens,
- `nearest` drawn obstacle (statics as rotated model boxes, building prisms floor..top, default-bake trees, outdoor
  spawn boxes) — the subject's own body (an object whose footprint holds the subject axis, point radius ≤ 8 m) is
  excluded, like the runtime does; the retail-bake tree distance is shown for information only,
- `vmax` nominal camera speed; `flight` = the shot dry-flown through the real flight model (preset cinema 12 m/s,
  heavy 7, fpv 25, indoor 4): peak speed and the max tracking gap (> 1 m means the craft cannot follow — the page
  would flag `overspeed`),
- `water` share of samples over water terrain, `LOS blocked k/n` (every 6th frame, terrain + obstacles between lens
  and subject centre) with the first blocker, `subject in frame` share (projected inside the 16:9 frame).
With `trim`, a second line `edit` gives the same numbers for the edit window `[inSec, inSec + duration.sec]`.
`--verbose` prints one row per second: t, pos, AGL, heading h, pitch p, fov, speed v, subject distance, subject NDC
(x right, y up, ±1 = frame edge), LOS, nearest obstacle — use it to find a shot's best moment.

Limits (be honest in notes): buildings are footprint prisms (an arch/gate opening reads as solid unless its parts
are separate statics); terrain trees outside the default bake are not modelled; ACE creatures are not obstacles
(the runtime fades entities); a missing landblock means `groundZ` null (AGL NaN) — avoid those areas.

## Tool cost
Each command is a short single node/python process (≈ 100–200 MB). Run them one at a time; check `free -m` shows
≥ 1500 MB available first.
