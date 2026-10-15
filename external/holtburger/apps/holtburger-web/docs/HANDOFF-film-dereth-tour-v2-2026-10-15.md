# HANDOFF — "Dereth Town Tour" v2.2: double the shots + a silent Egg Orchard FPV tail (2026-10-15)

**Status:** plan DONE, validated (0 errors / 0 warnings), compiled (0 warnings), verified offline, installed as the live
plan. Nothing was shot, no browser was opened, the 1070 was not touched, nothing is committed. Resume shooting with
the commands of the 2026-10-14 handoff (§4 there); they read `plan.json` / `timeline.json` and need no change.

## 1. The owner's brief (binding)
1. "Enhance the plan so there are double the number of shots, in areas we haven't covered" (acpedia's
   **Category:Major POI**). "The quality of our current shots can't be disturbed, e.g. can't be sped up just to cram
   more shots in the 57 minutes. They should instead just be shorter, capturing the best part of the existing idea
   for those 250-ish shots."
2. The Egg Orchard: a full FPV-drone run with JEV "from the entrance drop to the exit portal at the bottom", every
   monster spawned, passing over / left / right of them, the in-ground tunnel entrances and the pit, FPV tricks
   (floats: lift and drop), propellers visible at the top, no fake low-quality-link effects, no music. It is moved out
   of the music and appended after it, and other shots lengthen to fill the gap.
3. "All legitimately nice effects should be operant during filming" (the water looked flat in the last test video).

## 2. What v2.2 is
| | v1 (2026-10-14) | v2.2 (now) |
|---|---|---|
| Shots | 273 | **546** = 270 v1 shots in the music + **274 new POI shots** + the Egg Orchard portal shot and the FPV run in the tail |
| Sites | 57 | **212** = 57 v1 sites (Egg Orchard now a tail site) + **155 Major POI sites** |
| Music edit | 3431.75 s | 3431.75 s (same music, same 82,362 frames) |
| Silent tail | — | 1.5 s black → `egg-orchard-portal.01` 8.5 s (from 1.5 s of its unchanged take, 2 s fade in) → fade-to-white 0.8 s → `egg-orchard.run` 184.5 s → 3 s fade out. Total **3626.25 s**. |
| Mean edit length | 12.6 s | v1 shots 6.55 s, new shots 6.07 s; median 6.25 s, range 3.5–11.9 s |
| Movement starts | — | each opens a site: Eroica I 539.81 s Obsidian Span (in the silence before the two hammer chords), II 1454.45 Plateau Village, III 2380.58 Samsur, IV 2729.09 Burun Fortress (hard cut on the fortissimo) |
| Shoot estimate | ≈ 3.5–4 h | ≈ **7 h 18 min** (`plan compile`: 219 teleports incl. 7 `site.prime` hops, 180,469 rendered frames) |
| JEV | 8 hero shots | 7 v1 heroes (unchanged) + `egg-orchard.run`; every new POI shot is pilot "code" (free) |

**How "shorter but not sped up" works: the new plan field `trim: {takeSec, inSec}`** (tools/film/plan/schema.mjs +
compile.mjs, documented in `.claude/skills/film-mode/reference/plan-format.md` §3/§5 and `scene3d/film/SPEC.md`).
The move is built and flown as a take of `takeSec`; the edit is the window from `inSec`
(`handleIn = inSec`, `handleOut = takeSec − inSec − edit`), so `assemble` and the EDL cut that window, plus any
dissolve material, out of the one take. **Every kept v1 shot keeps its exact v1 take.** Compiled v2.2 vs v1: all 271
kept takes (270 + the portal) are byte-identical in canonical JSON except `editOffsetSec` (where the window starts) and
the new `overlay: null` key. So ShotSpecs, subjects, paths, pilots, looks and take frame counts are all unchanged; the
edit only shows less of each move. The v1 plan restated with `trim` equal to its own takes compiles to the identical v1
timeline. Cost: the full take is still rendered, so shoot time follows `takeSec`, not the edit length.

## 3. How it was made (all research offline, reproducible)
1. **Major POIs:** 184 acpedia pages in Category:Major POI; coordinates from each page's `{{Map Point}}` (157), the
   index (26) or the wikitext (1). 14 were excluded up front (already in v1 shots < 250 m, or not a place).
2. **Offline world kit** `research/poi-kit/` (data on the live drive only: 2,197 landblocks, 62 MB). One
   WorldBuilder.Terminal session dumped describe-landblock + list-objects + terrain for the 3×3 around every POI and
   v1 shot; the dist's scenery and ACE spawns were merged in. `area.py` (what is there + ASCII map) and `check.mjs`
   (flies a plan's shots with the real technique registry on real terrain: clearance, obstacles, flight-model tracking
   gap, LOS, subject-in-frame, for the take AND the trim window).
3. **Best windows for the v1 shots** (`research/windows/windows-{0,1,2}.json`): for each shot, the stretch that carries
   the idea (`keep`), where a shorter window sits (`anchor`), `minSec`/`idealSec`, and a one-line reason.
4. **New shots** (8 route batches): `research/poi-dossiers/poi-<site>.json` (summary, landmarks, site, 1–4 ranked
   shots designed at natural speed as 6–11 s takes with an edit window, each verified with check.mjs); decisions in
   `research/poi-batches/decisions-N.json`. Adversarial critics fixed teleports (one stood on the Colosseum portal),
   drops near portals, a cell index, duplicates and reveal windows.
5. **Builder** `research/final-plan-build/build2.py` (deterministic). It applies the curation table (8 sites left out
   for repetition), a quota of 274 new shots by rank, POI units after the v1 site they follow on the route, the energy
   pass, no technique twice across a cut, a beat/section-grid DP per movement segment (per-segment λ), pinned movement
   starts, and the Egg Orchard move to the tail (`TAIL_SITES`; `BUILD2_KEEP_EO=1` rebuilds the v2.1 comparison).
   `verify2.py` re-flies all 546 shots.

## 4. The Egg Orchard FPV run (`egg-orchard.run`, technique `fpv.fpv-run`)
Everything is in `research/egg-orchard-run/`: README.md (pipeline), DESIGN.md, run-shot.json, verify.json, site.json.
- **Line:** 755 m through 164 cells, from the entrance drop (0x002B0371) to the Surface exit portal (0x002B0100). It
  takes in the in-ground burrows/trench groove, the floor chute, chimney A, the pit (nose-over, pull out south), the
  ramp hall, and a rise-and-carve over the hive in the egg chamber, ending 0.5 m past the portal disc.
- **Passes:** 43 creatures within 6 m of the line, 10 over / 19 left / 14 right. JEV chose 42; the code rule chose 1
  (0x1E4 Slayer, a squeeze where the measured room decides). Cost: 43 calls, ≈ $0.0016. New CLI task:
  `film jev task pass-plan`.
- **Tricks (12 flown):** floats (lift and drop) at the drop, the chute, a 13 m float up chimney A (flown at 1.5 m/s so
  it stays inside the shaft), the ramp pop-up, and the egg reveal with a 1.2 s hang looking down. Also a yaw-spin into
  the pit, dives (−80° nose-over into the pit, −40/−35° elsewhere), a roll in the ramp hall, and a left roll at the
  portal. Split-S skipped (the pit lid is only ≈ 3.4 m above the edge).
- **Flight:** 184.5 s at natural speed (peak 10.8 m/s); offline dry flight tracking error 0.25 m max; fov 100; the
  camera follows the body attitude (bank, pitch, prop-wash wobble, throttle bob).
- **Look:** `overlay.props: {style: "freestyle"}` draws propeller tips at the top of frame (`runtime/lens_overlay.js`,
  boot flag `filmProps=on`). No fake low-link artefacts.
- **Creatures:** `site.prime` walks the hidden avatar through 7 PVS anchors top to bottom (82/82 creatures on the
  line seen), then parks it at 0x002B0119 (42 m from the portal, 6.6 m off the line). `pilot.fade: "never"`: creatures
  are never faded.
- **Verify (flown take):** 0 samples outside the cells, 0 wall crossings. Accepted near-misses: tunnel walls ≥ 0.75 m,
  rooms ≥ 0.89 m, props ≥ 0.69 m (a non-solid marker at the drop), creature cylinders 0.44–0.80 m at the 3 squeezes
  and 2 bends.

## 5. Effects during filming (why the water looked flat, and the fixes)
- **Storm look every day:** the client's default "legacy" storm scan reports a storm on every day. That forced the
  rain sheen and storm wind and turned pollen and fireflies off. The film boot now adds `stormScan=retail`.
- **Water ripples and glint only within 30–160 m:** new flag `?waterSheenFade=near,far` (scene3d/terrain.js,
  `uWaterSheenFade`; default unchanged 30,160). The film boot uses `40,500`. The glint still needs the sun in front of
  the lens (a look/time-of-day choice per shot).
- **Quality:** the film booted at `quality=high`; it now boots at `ultra`.
- **Wall-clock FX in stepped takes:** distortion, decals, showcase, lights, ribbons, the lifestone and particles now
  read `scene3d/fx_clock.js` (`fxNowMs`), which film drives from the take clock. The terrain VFX tick uses frame time
  under `film.holdLoop`.
- **Fair-weather clouds:** `cloudCoverage=0.3` unless `film … --coverage=0..1` says otherwise.
- Boot URL now: `…filmMode=on&filmDof=on&filmProps=on…&quality=ultra…&cloudCoverage=0.3&stormScan=retail&waterSheenFade=40,500`
  (tools/film/lib/session.mjs `buildFilmUrl`). Take reports record the page env.

## 6. Verification (final plan)
- `film plan validate plan.json` 0/0; `plan compile`: 546 shots, 3626.25 s (music ends at 3431.75 s), **0 warnings**.
  v1 takes identical (see §2). All windows lie inside their keep ranges. All 4 movement starts are site cuts.
- build2 notes: the first shots of Castle of Baron Nuvillus and Ithaenc Cathedral had their `minSec` relaxed by 1.0 /
  0.5 s to fit the beat grid (edits 3.9 s and 4.2 s).
- `verify2.py`: 546 shots flown offline, 7 flagged, all by design (the same as v2.1 minus egg-orchard.01):
  - v1 flyovers and boom-rises whose point subject passes under the drone while the real target grows ahead
    (hoshino-fortress.03, hebian-to.01, mayoi.02, sawato.01, oolutangas-refuge.05, lin.05). Each window's written
    reason says so.
  - tufa.03 keeps the tight end of the zoom.
  - poi-precarious-sojourn.02: the bridge leaves the frame as the FPV passes under it (83 %).
- JS gate: see §9.

## 7. Eye-tests owed (1070, one batched session)
1. **egg-orchard.run**:
   - floats (chute, chimney A, egg reveal hang)
   - the pit nose-over
   - the creature squeezes (0x307 Slasher, 0x1E4 Slayer, 0x15E Ripper)
   - the propeller overlay look
   - whether the primed creatures are all still there when the run passes (ACE drops objects ≈ 25 s after they leave
     the avatar's PVS; the avatar parks at the bottom)
2. **Water** with `waterSheenFade=40,500` and `stormScan=retail`: ripples and glint at distance, no rain sheen.
3. **Floating Spire** and **Festival Stone of Gloaming**: their landblocks (0x287A, 0x277A) don't load in
   WorldBuilder.Terminal; sizes are estimated.
4. Runtime-only effects the kit cannot see: Festival Stone glows, portal swirls, Caulcano vents, the Aerbax beam.
5. Pre-existing v1 notes (unchanged moves): danbys-outpost.04, qalabar.02 and uziz.03 show a tracking gap in the
   offline dry flight.

## 8. JEV key
A new OpenRouter key is installed only at `~/.config/holtburger-film/openrouter.key` (mode 600; the old one is kept
as `openrouter.key.2026-10-14`). Cap $5, expires 2026-10-16 12:03 UTC; ≈ $0.002 used so far. After it expires, the
JEV shots need a fresh key or `pilot.mode: "code"`.

## 9. Where everything is
| What | Where |
|---|---|
| Live plan / timeline | `/mnt/wbterminal2/film-projects/dereth-town-tour/plan.json`, `timeline.json` (backups in `research/final-plan-build/`: `plan-v1-273shots.json`, `timeline-v1-273shots.json`, `plan-live-backup-2026-10-15-v21.json`, `timeline-live-backup-2026-10-15-v21.json`) |
| Preserved copy (this repo) | `docs/film-projects/dereth-town-tour/plan.json` + `research/{windows,poi-dossiers,poi-batches,poi-kit,final-plan-build,egg-orchard-run}/` |
| Rebuild | `python3 research/final-plan-build/build2.py <out-plan.json>` on the live drive, then `film plan validate` / `plan compile`, then `python3 research/final-plan-build/verify2.py <plan>` |
| Rebuild the run | `research/egg-orchard-run/README.md` pipeline table (one process at a time) |
| Kit data, acpedia extracts, batch scratch plans | live drive only: `research/poi-kit/world/`, `research/poi-wiki/`, `research/poi-scratch/` |

Code changes (uncommitted; the owner decides). For the exact list run
`git status --short apps/holtburger-web .claude/skills/film-mode`:
- plan `trim` (schema/compile/edl)
- `edit.tail` / `site.prime` / `shot.overlay` / `pilot.fade` and audio tail (tools/film)
- `fpv.fpv-run` + `shots/fpv_tricks.js`
- `runtime/lens_overlay.js`
- `scene3d/fx_clock.js` and the FX callers
- terrain `waterSheenFade` (+ the sheen-band regex in test_terrain_{ice,sand_sparkle,volcano_shader}, a footprint check in test_terrain_water)
- camera_owner light ranking
- new tests: film_fx_clock, film_fpv_tricks, film_shots_fpv_run, film_runtime_overlay, film_jev_pass_plan
- skill and docs (SKILL.md, plan-format, workflow, 1070, techniques, url-flags, SPEC)

Full JS gate (in `capped-build`, after all edits): **729 passed, 4 failed** of 733. All 4 were mine:
- `test_terrain_ice`, `test_terrain_sand_sparkle` and `test_terrain_volcano_shader` asserted the literal
  `smoothstep(30.0, 160.0, …)` sheen band, which is now the `uWaterSheenFade` uniform. Their regex now matches the
  uniform form; the default band stays 30,160.
- `test_terrain_micro` allows exactly one `dFdx`/`dFdy` pair in the program, and the new footprint fade had added a
  second. The footprint now reuses `gTerrainGridDx/Dy` (only `?terrainGradUv=off` takes its own pair), and
  `test_terrain_water` checks that.

After the fix, those 4 plus every other test that reads terrain.js (23 in all: terrain_*, far_bake_*, look_pass,
radial_fog, shader_logdepth, visual_ground, alpha_mask_slice, particle_fx_tier1, film_fx_clock) pass one by one.

A second full-gate run could not start: other sessions held available memory at 2.3–2.4 GB, below capped-build's
2.56 GB lock. Run it once before committing. The terrain shader change has not been compiled by a real GPU yet: the
GLSL smoke tests need a browser, so it rides the 1070 water eye-test (§7.2).
