# Egg Orchard FPV run: racing line, passes, zones, tricks (agent D, phase 1)

Status 2026-10-15: DONE. Phase 1 (agent D) built the racing line, pass inputs, zones, tricks and site; phase 2 (orchestrator) ran the real JEV pass plan (42 JEV picks + 1 squeeze decided by the measured room — the pass-plan task now lets geometry decide every squeeze), re-baked the line, and built + dry-flew the shot: `tools/make_shot.mjs` → `run-shot.json` (fpv.fpv-run, 184.5 s, 12 tricks, smoothing pre-compensated so the flown line lands on the authored one) and `verify.json` (flown take: nothing outside the cells, no crossings, tracking 0.25 m; accepted near-misses listed). Eye-test owed on the 1070.

All data is in world metres: x east, y north, z up. Landblock-local = world − (0, 8256, 0).
Landblock 0x002B, Mid copy.

## Pipeline (rerun in this order, one process at a time)
| step | command | output |
|---|---|---|
| meshes (one WBT session, done) | `python3 tools/fetch_meshes.py` | data/meshes.json (28 setups/gfxobjs: vents, columns, mushroom props, eggs, hive, creatures) |
| base line (~6 min) | `python3 tools/build_line.py` | data/racing_line.base.json |
| creature gaps | `python3 tools/passes.py inputs` | data/pass_input.json |
| pass plan (code rule) | `node tools/pass_plan.mjs --code` | data/passes.code.json |
| pass plan (JEV, orchestrator) | `node tools/pass_plan.mjs --out=data/passes.json` | data/passes.json + .log.jsonl |
| bake (~1.5 min) | `python3 tools/passes.py bake [--passes=data/passes.json]` | data/racing_line.json |
| zones + tricks | `python3 tools/plan_run.py` | data/zones.json, data/tricks.json |
| site | `python3 tools/site.py` | site.json |
| check any trajectory | `python3 tools/check_clearance.py <traj.json> --out=r.json [--rows]` | per-sample report |
| shot + dry flight (orchestrator) | `node tools/make_shot.mjs` | run-shot.json, data/flown.json, data/nominal.json, data/build.json |
| verify the flown take | `python3 tools/check_clearance.py data/flown.json --out=data/check.flown.json` | data/check.flown.json → verify.json |

Tools: eogeo.py (the geometry kit: retail BSP point-in-cell, point–triangle distances, floor and ceiling rays, props, creature cylinders and boxes), render.py (PIL section drawings), research_orig/ (the research scripts this work started from).
Inputs are copied to data/src/ so nothing depends on /tmp.

## Racing line (data/racing_line.json)
- 755.5 m and 1429 points at 0.5 m spacing. It runs from the drop to the Surface portal through 164 cells and 11 segments (A–K).
- Forced features:
  - the trench groove 0x375 and the five other burrows
  - the floor chute 0x2C3→0x2C2
  - chimney A, flown along y 8136 under its centre
  - the pit 0x1D4→0x1A9 (nose-over, then pull out heading south)
  - the ramp hall
  - the egg-chamber rise-and-carve over the hive
  - the end: 0.5 m past the portal disc, heading north
- The tunnel band is 1.5–2.6 m above the floor. The line goes round the vent column in 0x163 and passes between the entry mushroom caps.
- Start is the drop xy at z = 2.755. A drawn but non-solid 2 m marker (0x02000C39) stands exactly on the drop point, so the hover starts 0.75 m above it.
- Clearances (check.line.json):

  | check | result | rule |
  |---|---|---|
  | samples outside the cells | 0 | — |
  | wall crossings | 0 | — |
  | tunnel walls | 0.84 m min; only 0x306/0x307 are below the rule | 0.9 m |
  | room walls | ≥ 1.29 m | 1.2 m |
  | props | ≥ 0.75 m | 0.6 m |

- Curvature: minimum radius 1.9 m, typical (p90) 3–12 m.
- Creature rule (radius + 0.8 m) misses at 4 spots:
  - **0x307 Slasher** (0.59 m) and **0x1E4 Slayer** (0.52 m): geometrically infeasible. The best gap is 1.60 m, but the rules need 1.7 m. The line is balanced between the creature and the wall.
  - **0x35D Slasher** (0.60 m, one sample) and **0x101 Ripper** (0.798 m): the tunnel bends at the creature.

## Passes (data/passes.code.json)
- 43 creatures within 6 m of the line: over 10, left 19, right 14 (phase 1: all 43 from the code rule).
- **Final (phase 2) = data/passes.json:** the same split, 42 picked by JEV + 1 by the code rule (0x1E4 Slayer, a squeeze —
  the pass-plan task now lets the measured room decide every squeeze); 43 calls, ≈ $0.0016. data/passes.code.json is the
  code-rule comparison, data/passes.jev1.* the first JEV run (before the squeeze guard).
- 3 creatures are squeezes, meaning every option is blocked: 0x307, 0x1E4 and 0x15E (0x15E is flown over at the midpoint of the headroom).
- left/right is the side of the creature the drone flies on, seen in the direction of travel.

**Deviation from DESIGN §4.** The input passes needs that match the verify rules plus 0.1 m: side 1.8 m (tunnels) or 2.1 m (rooms), and over the same.
- DESIGN's side 1.9 m cannot be met in the 5.3 m tunnels: a centred Slasher leaves about 1.7 m on each side.
- DESIGN's 0.4 m below the ceiling fails the 0.9 m tunnel verify.
- The task's defaults are still DESIGN's numbers (`PASS_RULES`). Drop `needs` from the input to use them.

How the gaps are measured:
- Corridor-bounded: a creature standing in an alcove or branch cell cannot be passed on its far side.
- Side passes are limited to a 3.5 m swing in tunnels and 5 m in rooms.
- An over pass needs the creature to be inside the corridor and at most 4.5 m off the line.

## Zones and tricks
- zones.json: 18 caps from the research speed plan, with sub-zones for the chimney float (2.6 m/s), the pit edge, dive and pull-out, the egg chamber (4 m/s) and the portal (3.5 m/s).
- Estimated duration: **117.7 s**.
- tricks.json: 14 tricks, with parameters matching agent B's `FPV_TRICK_VARIANTS`:

| trick | s (m) | about t (s) | trick | s (m) | about t (s) |
|---|---|---|---|---|---|
| float | 4.6 | 2.0 | roll | 434.5 | 65.4 |
| dive | 15.6 | 4.2 | dive (−80) | 439.0 | 66.3 |
| float (chute) | 202.2 | 30.7 | roll (ramp hall) | 618.0 | 90.1 |
| dive (−40) | 208.2 | 31.8 | dive | 640.2 | 93.6 |
| float 13 m (chimney A) | 398.5 | 57.0 | float (pop-up) | 661.7 | 97.3 |
| yaw-spin | 421.0 | 63.0 | dive | 682.4 | 100.9 |
| | | | float (egg reveal) | 715.4 | 107.5 |
| | | | roll (portal) | 749.9 | 116.0 |

- Skipped and documented: split-S (the pit lid is only about 3.4 m above the edge) and power-loop (not requested).

## Site (site.json)
- The avatar stands in cell 0x002B0119 at (50, −100, −59.995) local.
  - It is ≥ 10 m from both Surface portals and ≥ 4 m off the line.
  - It sees 33/33 of the creatures past segment J.
- Prime: research-2's 7 PVS anchors, top to bottom. Ramp cell 0x28E is replaced by its neighbour 0x24B. Each hop is a validated floor point.
- Together the hops see 82/82 creatures within 15 m of the line.
- Risk: ACE drops objects about 25 s after they leave the avatar's PVS.

## Phase 2 result (closed 2026-10-15)
- run-shot.json is the shot the live plan carries as `egg-orchard.run` (appended after the music, `plan.edit.tail`).
- It flies 184.5 s, not the 117.7 s zone estimate: make_shot slows the chimney-A float to 1.5 m/s so the 13 m float stays
  inside the shaft, holds 1.2 s at the drop, and the flight model's corner/lateral limits (cornerRadius 0.4, alat 12)
  shave the tight bends. Speed is natural throughout: peak 10.8 m/s, nothing sped up.
- make_shot's rule-based adjustments (listed in verify.json → shot.adjustments): the entry dive dropped (the entry float
  already ends nose-down), the chute float moved to land before the chute dive, the chimney float centred on the shaft, the
  pit-edge roll dropped (the chimney-B yaw spin flows straight into the pit nose-over). 12 tricks flown, 0 skipped.
- Accepted near-misses (verify.json): tunnel walls ≥ 0.75 m, rooms ≥ 0.89 m, props ≥ 0.69 m (the non-solid 2 m marker at
  the drop), creature cylinders 0.44–0.80 m at the 3 squeezes and the 2 bends noted above. Eye-test them on the 1070.
- The film.mjs registration is done (`film jev task pass-plan`).
