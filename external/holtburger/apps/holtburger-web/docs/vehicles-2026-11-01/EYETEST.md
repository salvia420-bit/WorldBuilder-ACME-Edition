# Vehicles — queued 1070 eye test (owner; written 2026-11-01)

Everything here is about look and feel, which the laptop (SwiftShader, headless) cannot judge. The structural checks
(prediction, streaming, kills, bail-out, compatibility) are in `HANDOFF.md`. One sitting; ~20 minutes.

## Agent pass on the 1070 (2026-11-01 evening, owner-directed; MODE T off-screen + muted, 30 fps cap)

Tours `bench/vehicle-1070.mjs` (A before the fixes, B/C after) — stills + video on the owner's phone (Taildrop) and in
`/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-tour-{a,b,c}/`. What the pictures settled and what stays the owner's call:

| # | Status after the agent pass |
|---|---|
| 1 Board | B boards; now a 0.6-1.2 s hop up into the seat (decision 42, `?vehicleBoardAnim=off`). The stand-in's FIRST rig build after `@vehicle spawn` takes 16-20 s on a fresh client ("Press B" shows before the balloon) — open |
| 2 Takeoff | works (vertical to 30 m); style = owner's call |
| 3 Feel | chase camera now aims at the seat: the balloon is framed centre (it banks with the aircraft) — feel = owner |
| 4 Corrections | tour A 0 at RTT 83 ms; B 2 (0.06 m) at 400 km/h despite a Wi-Fi stall (46 substituted inputs); C 2 (0.02 m) |
| 5 Cockpit | was broken (the eye inside the pilot's head, then inside the envelope) → the pilot and the vehicle are hidden in cockpit view (decision 41); now a clean first-person view from basket height |
| 6 400 km/h | world keeps up; the balloon used to VANISH ~30 s into a flight (the entity reaper, decision 40) — fixed (tour B/C keep it through 400 km/h) |
| 7 Guns | tracers fire but read as thin 1-px lines; the muzzle was under the balloon (moved into the basket, server profile) — thicker tracers = open |
| 9 Landing | lands, parks, exits beside (exit hop back down) |
| 10 Bail | 450 m → free fall → chute at ~140 m → 5 m/s → unhurt; the camera now follows the fall (decision 49 — it used to stay on the ground), the canopy is drawn (decision 43, `?vehicleChute=off`), and the avatar is visible under it (decision 52) |
| 12 Stand-in | it is a drudge-faced HOT-AIR BALLOON (Setup 0x020016F1: envelope + basket from 19 m up; at 0.3 = 5.7-12 m above the vehicle origin) — keep or replace = owner |
| 13 Seat | was ~5 m below the basket (for retail too) → (0, 0, 5.75) = in the basket; from behind the basket wall hides the seated pilot |
| — | owner: few trees in flight → `?objRefire=on` (1070: 0.63 → 0.96 of the object window baked in flight); halo around the balloon against clouds → `?cloudEdgeResolve=on` (1070 live A/B: fringe gone). Both DEFAULT ON since the owner's flip (2026-11-01); `=off` escapes |

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
| 10b | Fall pose (`?vehicleFallAnim`, decisions 54-61) | free fall: the retail Falling pose (arms out) with a packed olive parachute pack on the back; under the canopy: calmer, hands up on the risers beside the head, the canopy's lines running to the hands, the pack flatter; touchdown: the landing crouch, pack gone. Check a male and a female human, a Lugian (bigger pack, 1.3x), a Gear Knight (pack outside its back structure), a Tumerok (hands clear of the snout); a second capable client watching sees the same on the faller. `bench/vehicle-fall-pose.eval.js` |
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

## Session 3 (2026-11-02): the Hellcat built from AC items + its armament

Default URL as above (`?vehicles=on`). `?vehicleAirframe=off` shows the old stand-in for comparison.

| # | What | Look for |
|---|---|---|
| 16 | The airframe parked | a WW2 fighter silhouette of AC items (barrel fuselage, steel-keg cowling, bucket cockpit, tower-shield wings, kite-shield tail, Spadone prop, crossbows, purple wands, keg bombs, round-shield wheels); sitting 11° tail-down on its wheels, the tail wheel on the ground, the prop clear of it; the pilot's head and shoulders above the bucket's rim. Textures / light / shadows as statics |
| 17 | Take-off / landing | the tail lifts as it takes off, the gear vanishes in flight, comes back and the tail settles on landing; the prop spins faster with the throttle |
| 18 | Cockpit (Tab) | you see the cowling, the wings and the crossbows ahead (an open cockpit: no windscreen part), your own body is not in the view; the gunsight ring sits where the quarrels converge (110 m) |
| 19 | Guns (Space) | six crossbows fire together: quarrel models with a golden streak, a small flash at each muzzle, converging ahead; hits on a monster arrive when the quarrel would; 2,400 quarrels on the OSD, counting down |
| 20 | Lightning rails (G) | each press launches one Lightning Bolt (the retail bolt, also seen by retail clients) from the next wand (inboard first), the wand disappears; held, one every 0.3 s; a monster within 5° of the nose is the target (bolts track) |
| 21 | Bombs (V) | the dashed pipper on the ground (lb + seconds to impact) — release on it: the keg leaves the rack, falls nose-down along its arc, bursts on the pipper: a soft billowing fireball (yellow core, orange / red rim), a brief flash, a faint dust skirt racing out ~70 m, dark clods thrown up, a soft smoke column for ~10 s; no hard-edged balls or solid rings (reworked 2026-11-02 after the 1070 stills); the camera shakes if you are close; retail clients see the retail fire bursts. 2,000 lb first, then the two 1,000 lb |
| 22 | Rearm | land and wait 6 s: "Rearmed" — quarrels, wands and kegs back |
| 23 | Retail stand-in | retail clients now see a flying bucket (the cockpit tub at 2x) with the pilot sitting in it — acceptable? |

## Questions for the owner (session 3)

- The parts chosen for the airframe (airframe/README.md) — any to swap (the crystal windscreen was dropped: the cockpit is open)?
- Damage numbers: quarrel 9 (Pierce), bolt = Incantation of Lightning Bolt via a 400-spellcraft launcher, 2,000 lb 1,200 at the centre / 45 m radius, 1,000 lb 700 / 32 m. Bombs and bolts kill most low-level monsters outright.
- Rearm only on the ground after 6 s parked (no more infinite 2-s reload) — keep?
- GC launch settings (`~/ace-server/run-ace-live.sh`) on this laptop: keep, or back to ACE's defaults?

## Session 4 (2026-11-10): Procedural F6F-5/F6F-6 airframe, R-2800 soundscape, Mouse-Aim & Fighter HUD

Default URL: `?vehicles=on` (procedural Hellcat model, R-2800 audio, and AeroFX are all default **on**). Comparison escapes: `?vehicleModel=retail` (reverts to the AC-item composite airframe), `?vehicleAeroFx=off`, `?vehicleAudio=off`, `?vehicleDebug=on`.

Updated keys while seated:
- `M`: toggle Pointer-Lock Mouse-Aim Instructor (move mouse to place aim ring; aircraft banks/pitches smoothly onto cursor; `LMB` fire `.50 cal`, `MMB` HVAR rocket, `RMB` or `C` freelook, mouse wheel throttle `±4%`)
- `[` / `]` / `\`: nose-down / nose-up / reset elevator pitch trim
- `1` / `2` / `3`: drop specific bomb station (`V` drops heaviest remaining)
- `Tab`: cycle `chase` → `cockpit` (through Mk 8 reflector sight) → `hood` (gun-camera over cowling)

| # | What | Look & listen for |
|---|---|---|
| 24 | Procedural F6F-5 parked | USN WWII tricolor finish (Non-Specular Sea Blue spine, Intermediate Blue flanks, Insignia White belly), US star-and-bar insignia, "smiling" lower cowling intake with 18-cylinder R-2800 radial visible inside, canopy slid open while parked, 11° tail-down stance on oleo main struts + tailwheel, HVAR rockets & AN-M65/M66 bombs slung cleanly under gull-break wings |
| 25 | Control surfaces, gear & prop | On ground/flight: `A/D`, `W/S`, `Q/E` visibly deflect ailerons (differential), elevators, and rudder; `L` lowers landing flaps; takeoff slides the canopy shut and twists the main gear 90° backward flush into the wing wells; 3-blade Hamilton Standard prop transitions smoothly into a translucent motion-blur disc with yellow tip ring as RPM rises; cowling exhaust stacks glow orange/blue at high throttle / `Shift` WEP |
| 26 | 3-mode camera & cockpit sight (`Tab`) | `Chase`: banks 48% with aircraft, pulls back slightly on WEP surge, looks into banked turns, subtle gun/G-buffet shake. `Cockpit`: framed cleanly behind the armored windscreen looking through the glowing amber Mk 8 reflector sight reticle over the cowling (no pilot head clipping). `Hood`: dramatic over-the-cowling gun-camera view |
| 27 | Mouse-Aim (`M`) & Fighter HUD | Press `M` to lock pointer and fly one-handed with the mouse; pitch ladder + horizon bar tilt/scroll cleanly, compass tape tracks heading, velocity vector (`—o—`) shows true flight path, dive-bomb fall-line connects velocity vector to ground CCIP pipper, `EventKind.Hit` flashes a crisp center hitmarker `X` + damage pop, sustained `>4.2 G` dims peripheral G-vignette |
| 28 | AeroFX (`?vehicleAeroFx`) | Hard `>3 G` banked pull draws white wingtip condensation vortex ribbons trailing behind both wingtips; engine startup and `Shift` WEP emit subtle dark radial exhaust puffs; flying `< 34 m` AGL kicks up tan dust swirls over land and white spray over water |
| 29 | R-2800 soundscape (`?vehicleAudio`) | Cold-start crank/cough on board; lumpy 18-cylinder radial idle lope opening into a throaty R-2800 roar + 3-blade prop chop + supercharger whine with throttle/WEP; rising slipstream + dive howl above 280 km/h; AoA buffet rumble near stall; punchy 6× `.50 BMG` burst + metallic link-chute clatter; rocket ignition whoosh; bomb whistle + speed-of-sound delayed distant boom (`~1 s` delay per `343 m` slant range); gear/canopy foley; wind rush + silk snap on bailout |
| 30 | Observer flyby Doppler | Second client on foot watching a low pass at 350–400 km/h: spatialized radial roar pitches up on approach and drops cleanly (`computeDoppler`) past the listener |
