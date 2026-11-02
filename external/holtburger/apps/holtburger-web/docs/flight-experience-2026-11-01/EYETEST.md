# Flight experience — owner eye test (one sitting, ~20 min)

What the agent runs could not judge: how it LOOKS and FEELS on your screen at your frame rate. The structural checks
(flips, holes, lead times, coverage, corrections) are in `HANDOFF.md` with the 1070 numbers.

## Setup

- ACE (already set on the laptop's live server, 2026-11-01 22:02): the vehicles fork as before, plus the high band:
  - `vehicle_ceiling_agl 5000` and `vehicle_climb_max 40`;
  - `vehicle_derelict_high_agl 600`: an empty Hellcat high up despawns 30 s after you bail out;
  - `vehicle_high_band_agl 600`: above it, no ground objects are sent to the pilot.

  Each one reverts to today's behaviour with `modifydouble <name> 0`. The ceiling and climb apply to Hellcats spawned
  after the change (`@vehicle despawn all`, `@vehicle spawn`).
- URL: your usual play URL + `&vehicles=on` (+ `&nosw=1` on dev URLs).
  - The flight view is now DEFAULT ON. It bundles the world tier, the far forests and the presence field, plus the
    one-centre flight residency.
  - Escapes, each for an A/B: `&flightView=off` (everything back to the pre-flight-view client), `&worldTier=off`,
    `&farForest=off`, `&lbFade=off`, `&flightResidency=off`.
- Keys as before: R/F throttle, Shift boost, W/S nose, A/D roll, L land, X exit / X X bail, Tab cockpit.

## Checklist (✓ / ✗ / note)

| # | What | Look for |
|---|---|---|
| 1 | Take off at Holtburg, cruise SW (heading ~225°) at 300 km/h, 80-120 m | Trees everywhere to the horizon: real trees near, the far forest beyond (cards); hills and ridges past the forest, no white fog wall at 1.5 km |
| 2 | The near / far tree handover | Watch a hill ~1 km ahead: trees should change from far cards to real trees without popping in from nothing; any visible "card" look at the handover? Any trees blinking while you fly straight? |
| 2b | Far trees AWAY from Holtburg (log in in the desert, or fly 10 km out) | The far-forest cards carry their trees' textures (palms, pines, cacti); before 2026-11-02 a login away from Holtburg baked most of them as grey cards, white specks along the desert horizon (FAR-FORESTS.md, fixed) |
| 3 | 400 km/h (Shift) | The world keeps up: terrain and trees ahead, no landblock flicker, no holes at the edge of the world ahead |
| 4 | Banked turns | No trees flashing at the sides; the horizon stays continuous |
| 5 | Climb to 1.5 km, then to the ceiling (5 km) | The view opens: the whole continent, the inner sea, islands, ocean to the horizon; haze that deepens with distance; clouds BELOW you once above the deck (from the deck base up they used to vanish completely — fixed: `cloudTrueHeight`) |
| 6 | Climb THROUGH the cloud deck (a storm day shows it best) | Clouds around and below. On a storm day the cumulonimbus fades out as you climb past ~900 m, so you fly among the storm's cumulus deck and see it from above as separate rounded clouds with gaps (the tall tower layer made a murk with vertical streaks; HIGH-BAND.md §4); from the ground the storm is unchanged. Console A/B: `__setWeather({ is_storm: true })`. Above ~1.8 km the clouds switch to an every-pixel half-res march (`cloudHighBand`): is the switch visible? Are the tops smooth now? A/B: `&cloudHighBand=off` |
| 6b | Fair weather, above ~2 km (the usual day; console `__setWeather({ is_storm: false })`) | From 2.6 km a sea of cumulus; at 4-5 km a bright cloud field to the horizon with gaps onto the ground. The thin alto veil at 3.5 km now thins while you are up (it used to lie over the whole view from above as one grey sheet); from the ground it is unchanged. Is anything missing that you liked? |
| 6c | Frame rate above the deck | The high band's march no longer pays for light shafts (invisible from above) or ground bounce (`cloudHighBandMarch`): the 1070 at 5 km went 39 → 52 fps over a storm, 33 → 44 fps in fair weather. A/B: `&cloudHighBandMarch=off` — do you see any difference in the look? |
| 6d | The terrain grid (your "green lines in square shape") | Gone at Holtburg on foot and in low flight (`lbBand`, HANDOFF.md). Any lime / flat strip left along landblock edges anywhere? A/B: `&lbBand=all` brings the old lines back |
| 7 | Above the clouds at noon, then `&skytime=18` (dusk) | The deck from above; sun glint on lakes and sea toward the sun; colour at dusk |
| 8 | Dive back to 100 m | Detail returns without pops (trees fade in from cards, terrain detail under you) |
| 9 | Look straight down from 2-5 km | The ground below reads as terrain (rivers, roads as lines, forests darker); the patch under you (near ring with real trees) should not look like a pasted square |
| 10 | Land, exit, walk around Holtburg | On foot nothing changed (fog, fps, look) |
| 11 | Frame rate | fps at cruise over forest, over Holtburg, and above the clouds. The 1070 on screen, vsync on (its 120 Hz screen), no recording: ~42-45 fps low cruise, ~80 fps at 0.5-1.8 km, ~37 fps climbing through 1.8-4.5 km, 44-53 fps at 5 km (HANDOFF.md, the night's last runs) |
| 12 | Bail from altitude (X X), best from 5 km | Free fall in retail's Falling pose (arms out) with a parachute pack on the back, fitted per heritage / gender; under the canopy a calmer variant with the hands up on the risers; the pack gone at touchdown (`?vehicleFallAnim`, details: `../vehicles-2026-11-01/EYETEST.md` 10b). From 5 km: ~100 s of free fall with the whole continent below, the chute at 150 m. The view stays open during the fall and eases back to the on-foot look below 35 m. The empty Hellcat flies on and vanishes after 30 s (`vehicle_derelict_high_agl`). |

## Questions for you

- How far should the near trees reach before the cards take over (today the object window, 4 landblocks ≈ 0.8 km)?
- Ceiling: 5,000 m above ground (the AGL model; set live), or a level sea-level ceiling (that needs a flight-model
  change)?
- Climb: 40 m/s (≈ 2 min to 5 km) — steeper near the ground than today's 20; acceptable, or the altitude ramp instead?
- The look above the clouds: time of day, coverage; storms (the cumulonimbus reaches 6.6 km — inside the cruise band).
- The flags already went default-ON under the project rule (validated on the 1070, arms D-H). Is any of them wrong
  on your screen? Each has its `=off` escape for the A/B.
