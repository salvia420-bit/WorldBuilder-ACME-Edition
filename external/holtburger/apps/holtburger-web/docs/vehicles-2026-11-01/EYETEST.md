# Vehicles — queued 1070 eye test (owner; written 2026-11-01)

Everything here is about look and feel, which the laptop (SwiftShader, headless) cannot judge. The structural checks
(prediction, streaming, kills, bail-out, compatibility) are in `HANDOFF.md`. One sitting; ~20 minutes.

## Setup

- ACE: the vehicles fork (`~/ace-server`, branch `vehicles-2026-11-01`) with `vehicles_enabled` and
  `landblock_wake_on_entry` on (both default off). For 400 km/h also `vehicle_speed_cap 111`, `vehicle_preload`,
  `vehicle_preload_offthread`, `vehicle_sight_radius 350`, `vehicle_short_retention`, `vehicle_landblock_budget`; for the retail chat line
  `vehicle_retail_chat` (console: `modifybool <name> true`, `modifydouble vehicle_speed_cap 111`).
- Client: the usual 1070 play URL plus `&vehicles=on` (and `&nosw=1`). `?vehicleAudio=off` silences the engine.
- In game: `@vehicle spawn` parks a Hellcat 6 m ahead; `@vehicle despawn` removes the nearest; `@vehicles` prints
  the costs. A prompt "Press B to board the Hellcat" appears within 8 m.

## Keys

W/S nose down/up · A/D roll · Q/E rudder · R/F throttle lever · Shift boost · Space fire · L (hold) land ·
X exit on the ground / X twice in the air = bail (while falling: X opens the parachute) · Tab chase ↔ cockpit ·
H hides the OSD. Gamepad: left stick roll/pitch, right stick X rudder, RT fire, LB/RB throttle, B boost, X land,
Y camera, Back exit.

## Checklist (mark ✓ / ✗ / note)

| # | What | Look for |
|---|---|---|
| 1 | Board | B boards instantly; the pilot sits (retail Sitting) where the Hellcat is; the camera cuts to the chase view |
| 2 | Takeoff | R to ~30 %+: vertical rise to 30 m, then flight at 108 km/h. Arcade enough, or do you want a runway roll? |
| 3 | Flight feel at 250 km/h | roll 90°/s to 60°, pitch 45°/s to 25°, coordinated turns (radius ≈ 280 m at 250 km/h); chase camera smoothing (0.25 s heading lag) — too floaty / too stiff? |
| 4 | Corrections | the OSD's "corr N (last x m)": any visible snap or jitter in flight? (headless at localhost: 0 corrections over 11 km) |
| 5 | Cockpit view (Tab) | eye height / position inside the stand-in; horizon tilt with bank |
| 6 | 400 km/h (cap 111) | Shift = boost to 400 km/h: does the world keep up (terrain ahead, objects popping in)? Any hitch every landblock (~1.7 s)? Monsters appear a moment after their landblock (spawns are spread over ticks); chests in landblocks only vehicles visited fill when you land |
| 7 | Low pass + gun | Space fires 8 bolts/s: tracers visible, aligned with the nose? Hits on a monster: splatter / sound / health bar? Kill at a low pass |
| 8 | Engine hum | pitch follows the throttle; in-ear in the cockpit, panned at the aircraft in chase view; level vs the effects slider |
| 9 | Landing | hold L: slows to 90 km/h, descends at 8 m/s, parks; X exits beside it |
| 10 | Bail-out | climb to ~450 m, X twice: the camera follows the falling body; the chute opens at 150 m (there is no canopy model yet — the body just slows to 5 m/s and glides 8 m/s); lands unhurt; the empty aircraft glides away and crashes, gone 10 s later |
| 11 | Frame rate | fps at cruise over open country and over a town (chase camera) — note both |
| 12 | Retail stand-in | the Drudge Balloon (Setup 0x020016F1) at 0.3 scale is what EVERY client draws today (the capable client too, at the predicted pose). Acceptable as the "something in the sky" for retail, or pick another Setup? (Profile data: `VehicleProfile.HellcatDemo` `StandInSetup` / `StandInScale`) |
| 13 | Seat offset | the pilot sits at (0, −0.5, 0.6) m in the vehicle frame — inside the balloon's basket or floating? |
| 14 | Observer view | a second client watching the flight: smooth (capable clients interpolate 120 ms behind; standard clients see 10 Hz UpdatePositions with velocity) |
| 15 | Retail client (if one is available) | sees the balloon and the seated pilot move, monsters die from the bolts, and with `vehicle_retail_chat` the line "A Hellcat roars overhead." once a minute within 250 m |

## Questions for the owner

- The stand-in Setup (#12) and the seat offset (#13).
- Takeoff style (#2): keep the short vertical takeoff, or runways later?
- Ammo: the demo magazine (200) refills 2 s after it empties (effectively unlimited) — keep for demos?
- The seated pilot takes no damage in the demo — keep until hull HP exists?
