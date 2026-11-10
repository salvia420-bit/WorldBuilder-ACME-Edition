# Techniques — the shot grammar (64 ids)

Source: `scene3d/film/shots/{classic,drone}.js` registered by `scene3d/film/shots/index.js`. The catalog in §3–§4
is generated from `$FILM techniques --json` (2026-10-14); when in doubt run `$FILM techniques [--family=classic|drone|fpv]`
— the live registry wins. Ids are API: write them exactly in `shots[].technique`. To read one entry without loading
this whole file: `rg -n -A40 '^#### `drone.pass-over`' <this file>`.

## 1. How techniques behave

- Every technique honours `duration`, is continuous and NaN-free, keeps 0.7 m above the ground outdoors and inside
  floor/ceiling indoors, and (with `needs.subject`) keeps the subject in frame for ≥ 95 % of samples unless it is a
  **reveal** (the subject may start hidden or out of frame).
- `framing` (`EWS` 8.0 · `WS` 2.5 · `FS` 1.15 · `MWS` 0.75 · `MS` 0.5 · `MCU` 0.33 · `CU` 0.2 · `ECU` 0.1 × subject
  height = frame height) and `fov` set the distance when a `distance` param is 0 ("derived from the framing").
- `azimuthRef: "front"` measures angles from the subject's facing (its heading, else the side facing the site anchor,
  else the sun side, else north); `"compass"` uses compass bearings. `relativeToSubject` does the same for drone
  headings/bearings. Keep the same side across consecutive shots for the 180° rule.
- `drone.*` and `fpv.*` takes are flown through the drone flight model ("real drone feel": jerk/accel limits, body
  tilt, a lagged stabilised gimbal for drone, a hard-mounted uptilted camera for fpv). `pilot.flightPreset`
  (`cinema` ≤ 12 m/s · `heavy` ≤ 7 · `fpv` ≤ 25 · `indoor` ≤ 4) overrides the automatic choice (`fpv` for fpv,
  `indoor` indoors, else `cinema`). A path the flying preset cannot follow gets a page issue **`overspeed`**
  (`rehearse` / `shoot` print it as a warning) with a `minDurationSec`: lengthen the shot to at least that, shorten or
  straighten the path, or use `pilot.flightPreset: "fpv"`. Prepare checks the speed against the preset's cap and
  dry-flies the shot through the flight model, so it fires for a path faster than the cap and for a move within it
  that turns or brakes harder than the preset can follow (`limitedBy: "acceleration"`, e.g. a short boomerang or
  boom-rise the craft would trail by metres). The suggested duration is verified only when the shot was dry-flown
  within 1 m at it; otherwise the message calls it an estimate. It also fires for unprofiled moves (orbit-poi, helix,
  dronie, boomerang, spiral-descent, hyperlapse-orbit, top-down-rise…) shortened below their natural duration, and for
  non-linear eases on path moves (the ease speeds the middle up). When it says "a longer duration does not slow this
  move", lower `params.speed`, use ease `linear`, give a shorter path or use `fpv`. In a rehearsal report,
  `flight.tracking.maxGapM` / `endGapM` say how far the craft really trailed the plan; above 2 m `rehearse` / `shoot`
  print a **`tracking-gap`** warning. Read it even without an `overspeed`: it is the measured gap of the run, the
  safety net behind the prepare-time prediction (a moving subject the take re-anchors to, or the pilot's speed
  changes, can still leave the craft behind). The stabilised gimbal (cinema / heavy / indoor) turns at most
  120 / 80 / 90 °/s and keeps the horizon within 45° of the shot's own roll (a deliberate Dutch angle, barrel roll or
  inverted pass-over is carried, never clamped); a faster turn lags and catches up, never snaps (see `fpv.fpv-flip`).
- **Pilot bounds** (per technique, below) cap how far JEV may push the shot: lateral/rise/sink metres, speed and
  subject-distance scales. A shot may override any of them with `bounds: {maxLateral, maxRise, maxSink,
  minSpeedScale, maxSpeedScale, maxDistanceScale}` (reference/plan-format.md); unset keys keep the defaults below.
- **Capture hint**: `classic.tracking-*`, `drone.chase`, `drone.lead`, `drone.side-track` and `drone.top-down-track`
  are catalogued `realtime` (moving server-driven subjects). With the real registry (the CLI always passes it) such a
  shot defaults to `capture: realtime` for an entity or player subject and warns when it stays stepped on a point or
  path subject; `subject.moving: true`, an actor `moveTo`, or an explicit `capture` also decide it. A realtime take is
  recorded on the fps grid (frames held when the page draws slower) and the camera follows the moving subject live.
- **Turning subjects** (flown `drone.chase`, `drone.lead`, `drone.side-track`): the craft swings round a turning
  subject only as hard as its preset allows, so a sharp turn stretches or shrinks the camera–subject distance. Measured
  with a 3 m/s subject turning at 90°/s: on `cinema` a quarter turn stays within about ±15 % (side-track turning one
  way reaches 1.155×); a 180° U-turn takes chase to 0.74× and lead to 1.28× (26–28 % off) with the craft 2.2–2.3 m
  behind its path; `heavy` leaves the band on a quarter turn (0.76–1.31×, about 3 m behind). Above 2 m the run prints
  a `tracking-gap` warning that names the live subject's turn: shoot again with a gentler move — a slower or wider
  turn, no U-turn under a chase / lead / side-track, `cinema` rather than `heavy`; a retake of the same plan repeats
  it. The `classic.tracking-*` rigs are not flown and follow the turn directly.
- **Indoor/outdoor**: an outdoor-only technique at an indoor site, or an indoor technique at an outdoor site without
  a shot `route`, is a validation ERROR (the take could only fail after the teleport).
- Time-lapse techniques (`classic.time-lapse`, `classic.hyperlapse`, `drone.hyperlapse-orbit`) advance the sky clock
  during the take; use static subjects (moving NPCs blur). Units differ: the classic ones take `rate` in game-days per
  film second (default 0.02 ≈ 29 game-minutes); `drone.hyperlapse-orbit` takes `timeRate` in seconds of the live sky
  clock per film second (one Dereth day = 7620 s; default 150 ≈ 0.02 game-days ≈ 28 game-minutes; 1 = real time).
- **Occluders**: the pilot fades soft occluders that block the subject and reroutes around solid ones. What can really
  fade: PLACED trees (the landblock's static placements) the client's VFX catalog marks (trunk-canopy /
  foliage-pollen), small placed props of a known size ≤ 2 m (barrels, crates), entity rigs that read as props, smoke
  and fire particles. Procedural (terrain) trees, bushes and rocks never fade in v1 (the runtime cannot tell which
  placement a ray hit, SPEC §3.1), so a tree-line or forest shot reroutes around them — frame the subject clear of
  trunks rather than counting on a fade. Overlapping placed trees, ambiguous hits, rocks, buildings, big or unsized
  props get the reroute bias too. When the client has not loaded its VFX catalog — under `?visual=off` unless
  `?windGeo=on` (which still loads it), or with every client VFX path off (SPEC §1.1) — placed trees read as props
  and fade only when small. A `classic.reveal-from-occluder` shot's own occluder is never faded.
- `classic.rack-focus` is the only technique that writes the focus channel; it needs `?filmDof=on` (always in the
  film boot URL) to show.
- `fpv.fpv-corridor` (and other indoor moves) take an indoor `route: {fromCell, toCell}`: the page plans a
  doorway-to-doorway path with filleted corners. `drone.canyon-run` needs `path` points along the valley floor.
- `vec3` params (`secondary`, `occluder`, `gapPos`, `gapNormal`) are AC world metres `[x, y, z]`; `[0,0,0]` means
  "not given" (the technique derives one).

## 2. Which technique for which beat (cheat-sheet)

| Beat / section | Intent | Reach for |
|---|---|---|
| Intro / cold open | establish place and mood, slow | `drone.tilt-reveal`, `drone.rising-reveal`, `classic.establishing`, `drone.flyover` (slow), `classic.crane`, `classic.tilt` (sky → subject) |
| Verse | intimate, story, closer, slower | `classic.dolly-in`, `classic.push-in`, `classic.steadicam`, `classic.arc`, `classic.over-the-shoulder`, `classic.two-shot`, `classic.rack-focus`, `classic.static`, `drone.parallax-slide` |
| Pre-chorus | build tension | `classic.push-in`, `drone.boom-rise`, `drone.helix`, `classic.pedestal`, `classic.dolly-zoom` |
| Chorus / drop | the biggest moves and reveals | `drone.pass-over`, `drone.orbit-poi` (0.5–1 rev), `drone.flyover`, `drone.fly-by`, `drone.terrain-skim`, `drone.canyon-run`, `fpv.fpv-dive`, `drone.boomerang`, `classic.pull-out-reveal` |
| Beat-drop punctuation | a hit on the downbeat | `fpv.fpv-flip`, `classic.whip-pan` (cut on the blur), `classic.zoom` (crash zoom, `expoInOut`) |
| Bridge | contrast in scale, angle or light | `drone.top-down`, `drone.top-down-track`, `fpv.fpv-corridor` in a dungeon, `classic.worms-eye`, `classic.birds-eye`, `drone.vertigo-drone`, `classic.time-lapse` (day → night) |
| Instrumental / solo | kinetic energy | `fpv.fpv-proximity`, `fpv.fpv-gap`, `drone.flythrough`, `drone.chase`, `classic.handheld`, `classic.snorricam` |
| Outro | release, distance, ending | `drone.dronie`, `drone.top-down-rise`, `classic.pull-out-reveal`, `classic.dolly-out`, `drone.pano-360`, `drone.hyperlapse-orbit` |
| Story: establish → approach → detail → reaction | coverage | `classic.establishing` → `classic.tracking-lead` / `classic.dolly-in` → `classic.rack-focus` / `classic.static` (CU) → `classic.over-the-shoulder` / `classic.static` (MCU) |
| Dialogue / two characters | relationship, 180° rule | `classic.two-shot`, `classic.over-the-shoulder` (`secondary`), `classic.static` |
| Power / menace / vulnerability | angle psychology | `classic.low-angle`, `classic.worms-eye` / `classic.high-angle`, `classic.birds-eye`, `classic.roll` (unease) |
| Dungeons and interiors | walls close, turns | `fpv.fpv-corridor` (route), `classic.steadicam`, `classic.pov`, `classic.reveal-from-occluder`, `classic.static` |
| Moving subject (realtime) | follow motion | `classic.tracking-follow/-lead/-side`, `drone.chase`, `drone.lead`, `drone.side-track`, `drone.top-down-track` |
| Passing time | compress time | `classic.time-lapse`, `classic.hyperlapse`, `drone.hyperlapse-orbit` |
| Transitions in / out of places | through an opening | `drone.flythrough` (slow, level), `fpv.fpv-gap` (fast, banked), `drone.spiral-descent` (arrive), `drone.dronie` (leave) |

Energy → speed: low-energy sections favour `classic.*` with `ease: sineInOut` and drone speeds 2–5 m/s; high
energy favours drone/fpv at 8–14 m/s (`drone.terrain-skim` says keep it believable at 8–14), `ease: linear`, and
shorter shots (1–2 bars).

<!-- GENERATED SECTION BELOW from `node tools/film/film.mjs techniques --json` (63 techniques, 2026-10-14; fpv.fpv-run added 2026-10-15). -->
<!-- Regenerate the catalog when scene3d/film/shots/{classic,drone}.js change; the cheat-sheet above is hand-written, and so are the "Director note" quotes inside entries (keep them when regenerating). -->

## 3. Index (all 64 techniques)

Needs: `subject` = the shot must have a point/entity/player subject; `path` = `shot.path`, a `{kind:'path'}` subject or an indoor `route`; `outdoor only` = an ERROR on an indoor site (§1). Capture `realtime` is a hint for moving server-driven subjects: with the registry (the CLI always loads it) the compiler makes such a shot realtime for an entity / player subject and warns when it stays stepped on a point or path subject (see §1).

### Classic (`classic.*`) — 34

| id | name | needs | default dur · framing | capture | when to use |
|---|---|---|---|---|---|
| `classic.static` | Static (locked-off) | — | 5 s · MS | stepped | Dialogue, contemplation, letting the action play inside the frame; the default neutral coverage shot. |
| `classic.pan` | Pan | — | 5 s · WS | stepped | Following action across a scene, connecting two points of interest, a slow survey of a vista ending on the subject. |
| `classic.tilt` | Tilt | — | 5 s · FS | stepped | Revealing height (a tower, a creature), tilting down from the sky onto the subject, or tilting to look straight down a shaft. |
| `classic.roll` | Roll (dutch angle) | — | 5 s · MS | stepped | Unease, disorientation, menace, a world off balance. |
| `classic.zoom` | Zoom | — | 4 s · WS | stepped | Isolating a detail without moving, the 70s crash zoom (ease expoInOut), compressing perspective; contrast with dolly-in. |
| `classic.dolly-in` | Dolly in | subject | 6 s · MS | stepped | Building intensity, drawing the audience into a character's moment, moving from context to detail. |
| `classic.dolly-out` | Dolly out | subject | 6 s · MS | stepped | Revealing context around a character, isolation, ending a scene. |
| `classic.truck` | Truck | — | 6 s · FS | stepped | Parallax past foreground objects, moving alongside a scene, revealing depth. |
| `classic.pedestal` | Pedestal | — | 5 s · FS | stepped | Rising from a low vantage to eye level, sinking below a ledge, revealing over a foreground edge. |
| `classic.crane` | Crane (jib arc) | — | 7 s · WS | stepped | Grand openings and endings, rising above a crowd or a wall to reveal the scene, swooping down to a character. |
| `classic.arc` | Arc | — | 7 s · MWS | stepped | Adding dimension to a static moment, revealing a character against a changing background, heroic emphasis. |
| `classic.orbit` | Orbit | — | 12 s · FS | stepped | Showcasing a hero or a landmark, a moment frozen in time, loopable footage (ease linear). |
| `classic.tracking-follow` | Tracking — follow | subject | 8 s · WS | realtime | Following a character into the unknown, journeys, chases from behind. Shoot with capture realtime when the subject is server-driven. |
| `classic.tracking-lead` | Tracking — lead | subject | 8 s · FS | realtime | Walk-and-talk, a character striding toward the audience, determination, pursuit seen from the front. |
| `classic.tracking-side` | Tracking — side | subject | 8 s · FS | realtime | Running, riding, marching; showing speed against a passing background. |
| `classic.push-in` | Push-in | subject | 6 s · MCU | stepped | A realisation, a decision, rising emotion; the audience leans in with the character. |
| `classic.pull-out-reveal` | Pull-out reveal | subject | 8 s · CU | stepped · reveal | Revealing where a character is (alone in a vast place, surrounded), endings, scale reveals. |
| `classic.dolly-zoom` | Dolly zoom (vertigo) | subject | 5 s · MS | stepped | Vertigo, shock, a sudden realisation, the world shifting around a character. |
| `classic.whip-pan` | Whip pan | — | 3 s · MS | stepped · reveal | Energetic transitions, sudden attention shifts, comedic beats; cut on the blur. |
| `classic.rack-focus` | Rack focus | subject | 5 s · MS | stepped | Shifting attention between foreground and subject, revealing a second element, a character noticing something. Needs ?filmDof=on to show. |
| `classic.over-the-shoulder` | Over the shoulder | subject | 5 s · MCU | stepped | Dialogue coverage, confrontation, establishing the relationship between two characters. |
| `classic.pov` | Point of view | subject | 5 s · — | stepped | Subjective experience, horror, discovery, entering a dungeon through a character's eyes. Hide the avatar for player POV. |
| `classic.two-shot` | Two-shot | subject | 6 s · MWS | stepped | Conversations, partnerships, two characters sharing a moment or a confrontation. |
| `classic.establishing` | Establishing | — | 8 s · EWS | stepped | Opening a scene or a new location, showing geography and scale. |
| `classic.high-angle` | High angle | subject | 5 s · MWS | stepped | Vulnerability, smallness, being watched or overwhelmed; overview of a situation. |
| `classic.low-angle` | Low angle | subject | 5 s · MWS | stepped | Power, dominance, heroism, menace; making a character or creature loom. |
| `classic.birds-eye` | Bird's-eye | — | 6 s · WS | stepped | Patterns, maps, god's-eye detachment, choreography seen from above. |
| `classic.worms-eye` | Worm's-eye | subject | 5 s · MS | stepped | Towering figures and architecture, awe, threat, a fallen character's view of an attacker. |
| `classic.handheld` | Handheld | — | 5 s · MS | stepped | Urgency, documentary realism, chaos, combat. |
| `classic.steadicam` | Steadicam | subject | 8 s · MWS | stepped | Long fluid takes, walk-and-talks, immersive movement through spaces. |
| `classic.snorricam` | Snorricam | subject | 6 s · MCU | stepped | Intoxication, panic, disorientation, intense subjective focus on a moving character. |
| `classic.reveal-from-occluder` | Reveal from occluder | subject | 6 s · MS | stepped · reveal | Discovering a character, suspense, a slow reveal from behind foreground scenery. |
| `classic.time-lapse` | Time-lapse | — | 8 s · WS | stepped | Passage of time, day turning to night, clouds racing over a landmark. |
| `classic.hyperlapse` | Hyperlapse | — | 8 s · WS | stepped | Time and space passing together: approaching a city as the day ends, circling a landmark through dusk. |

### Drone (`drone.*`) — 24

| id | name | needs | default dur · framing | capture | when to use |
|---|---|---|---|---|---|
| `drone.flyover` | Flyover | outdoor only | 10 s · WS | stepped | Opening or transition shots that cross a town, landmark or landscape. Use gimbal 'fixed' for a travelling vista. Use 'track' to keep a landmark in view until you pass over it. For a pass-over that keeps the subject in frame through vertical and beyond, use drone.pass-over. |
| `drone.flythrough` | Fly-through | — | 8 s · WS | stepped | Transitions from outside to inside (through a town gate, a ruin's arch) and reveals of what lies behind an opening. Use fpv.fpv-gap for the fast, banked FPV version. |
| `drone.orbit-poi` | Orbit (point of interest) | — | 10 s · WS | stepped | Hero shots of a landmark, lifestone, statue or a standing character. A quarter turn over 8–10 s reads as calm; a full turn is a showcase. Use drone.helix to climb while orbiting, or drone.hyperlapse-orbit for time-lapse sky. |
| `drone.helix` | Helix | — | 14 s · WS | stepped | Rising hero shots: a tower, a statue, a character on a hilltop. Climbing while widening gives an ending that reveals the surroundings. For the descending version use drone.spiral-descent. |
| `drone.dronie` | Dronie | subject, outdoor only | 10 s · FS | stepped | Endings and big reveals of where a character is: a player on a cliff, in a town square or by a portal. Works best when there is open sky behind the camera's line. |
| `drone.boom-rise` | Boom rise | — | 8 s · WS | stepped | Pedestal-style reveals: rising from behind a wall or hedge or up a tower face, or lifting off from a character to show the town. Use drone.rising-reveal when there is a foreground obstacle to clear. |
| `drone.rising-reveal` | Rising reveal | outdoor only | 9 s · EWS | stepped · reveal | The classic opener: rise over the rooftops toward a lifestone, or over a ridge to a valley town. Place the anchor or subject at what should be revealed and set the obstacle's height. |
| `drone.tilt-reveal` | Tilt reveal | outdoor only | 8 s · EWS | stepped · reveal | Openers that start on a texture (a path, water, a rooftop) and reveal a town or landmark ahead. The camera starts `distance` metres from the subject on bearingDeg, facing it. |
| `drone.top-down` | Top-down | — | 8 s · WS | stepped | Graphic, map-like shots of town squares, patterns, crowds, roads and water, and as a transition. Rotate 30–90° for motion. Use pitchDeg ≈ −88 when fire, portal or smoke particles sit directly below (billboards spin at exact nadir). |
| `drone.top-down-rise` | Top-down rise (god's-eye pull-up) | outdoor only | 10 s · WS | stepped | Endings and scale reveals: a lone character in a big landscape, a camp in a forest, a dungeon entrance in the wilds. |
| `drone.top-down-track` | Top-down track | subject, outdoor only | 10 s · WS | realtime | Overhead follows of a running character, a caravan or a creature on the move. Moving server-driven subjects need realtime capture. |
| `drone.pass-over` | Pass-over (gimbal through vertical) | outdoor only | 12 s · WS | stepped | The flagship crossing shot: pass over a meeting hall, a portal or a character and keep it in frame the whole way. Slow speeds and a higher pass make the slew gentler. |
| `drone.parallax-slide` | Parallax slide | — | 8 s · WS | stepped | Adding depth to a static scene: sliding past a tree line, a statue or a gate with something in the foreground. Lower heights and closer foregrounds give stronger parallax. |
| `drone.terrain-skim` | Terrain skim | outdoor only | 10 s · WS | stepped | Energy and speed: racing over fields, across water, along a road into town. Keep the speed believable (8–14 m/s). Use drone.canyon-run for valleys and fpv.fpv-proximity to hug a wall. |
| `drone.canyon-run` | Canyon run | path, outdoor only | 12 s · EWS | stepped | Flowing journeys through valleys, gorges, riverbeds or along a town's main street. Give the path as points along the valley floor. |
| `drone.chase` | Chase | subject | 10 s · FS | realtime | Following a running character, a mount or a fleeing creature. Use realtime capture for server-driven motion. |
| `drone.lead` | Lead | subject | 10 s · FS | realtime | Heroic advances (an army marching, a character striding toward the camera) and showing who follows the subject. |
| `drone.side-track` | Side track | subject | 10 s · FS | realtime | Showing speed and the landscape a subject travels through: riders on a road, a creature along a shore. |
| `drone.boomerang` | Boomerang | subject | 10 s · FS | stepped | Rhythmic, music-video beats (in on the verse, out on the hook) and showing a subject twice at different scales. |
| `drone.fly-by` | Fly-by | subject | 6 s · FS | stepped | Energetic beats and transitions: whipping past a character, a banner or a guard tower. Peak yaw rate ≈ speed / offset (keep it under ≈ 3 rad/s). |
| `drone.spiral-descent` | Spiral descent | — | 14 s · WS | stepped | Arriving at a place: from above a town down to its square, from the sky down to a character, into a crater or a courtyard. |
| `drone.pano-360` | Panorama 360 | — | 14 s · EWS | stepped | Showing the whole surroundings of a place from above: a town's skyline, a mountain top, a lake. The subject itself is not kept in frame. |
| `drone.hyperlapse-orbit` | Hyperlapse orbit | outdoor only | 15 s · WS | stepped | Passage of time over a landmark or town: sunset into night, a storm rolling in. Use a static subject; moving NPCs would blur. |
| `drone.vertigo-drone` | Vertigo (drone dolly-zoom) | subject | 8 s · MS | stepped | Unease, epiphany or dread: a character realising the scale of what is behind them, a tower looming. Needs open space along the bearing behind the camera. |

### FPV (`fpv.*`) — 6

| id | name | needs | default dur · framing | capture | when to use |
|---|---|---|---|---|---|
| `fpv.fpv-dive` | FPV dive | outdoor only | 7 s · WS | stepped | Adrenaline moments: diving off a tower, down a cliff or a waterfall. The subject or anchor is the base of the face. The dive heads along headingDeg. |
| `fpv.fpv-proximity` | FPV proximity | — | 8 s · WS | stepped | Intimate speed: skimming a town wall, a cliff face, a row of trees or a ship's hull. Keep offset ≥ 1 m; the safety layer and the pilot own the last metre. |
| `fpv.fpv-gap` | FPV gap | — | 6 s · WS | stepped | Through arches, between tree trunks, under bridges, through a window. Use drone.flythrough for the slow, level cinematic version. |
| `fpv.fpv-flip` | FPV flip | — | 8 s · WS | stepped | Punctuation on a beat drop, celebration moments and transitions: barrel-roll past a banner or flip over a gate. Roll flips keep the horizon in view longer than pitch flips. |
| `fpv.fpv-corridor` | FPV corridor | — | 10 s · WS | stepped | Dungeon and interior fly-throughs: down a hallway, round corners, through doorways into a hall. The route's z should already be at camera height (doorway control points at ≈55% of door height). |
| `fpv.fpv-run` | FPV run | — (racing line: `path` or route) | 30 s · WS | stepped | The long FPV piece: a dungeon run from the entrance drop to the bottom portal, a canyon or town run, with a speed plan (`zones`) and tricks (`tricks`: float, roll, yaw-spin, power-loop, split-s, dive, dip) at the big spaces. |

## 4. Full catalog

Each entry: description, when to use, defaults, the pilot bounds (how far JEV may push the shot), and every param (`params` in plan.json; unknown names and out-of-range numbers are `plan validate` errors).

### Classic (`classic.*`)

#### `classic.static` — Static (locked-off)

*needs: — · default 5 s · framing MS · ease linear · capture stepped · tags locked*

A locked-off frame: the camera does not move. Placed by azimuth/elevation and the framing distance; the head follows the subject only if it moves.

**When:** Dialogue, contemplation, letting the action play inside the frame; the default neutral coverage shot.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |

#### `classic.pan` — Pan

*needs: — · default 5 s · framing WS · ease sineInOut · capture stepped · tags locked-position, pan*

Fixed camera position, the head turns horizontally. Relative mode pans from fromDeg to toDeg around the subject's bearing (default: drifts onto the subject); absolute mode sweeps compass headings at pitchDeg.

**When:** Following action across a scene, connecting two points of interest, a slow survey of a vista ending on the subject.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `fromDeg` | number | `-30` | -720 … 720 deg | Start heading: offset from the subject's bearing (relative) or a compass heading (absolute). + = clockwise (to the right). |
| `toDeg` | number | `0` | -720 … 720 deg | End heading, same convention as fromDeg. |
| `relative` | boolean | `true` | `true` / `false` | true: headings are offsets from the bearing to the (live) subject and pitch holds the subject; false: absolute compass headings at pitchDeg. |
| `pitchDeg` | number | `0` | -90 … 90 deg | Camera pitch in absolute mode (+ up). |

#### `classic.tilt` — Tilt

*needs: — · default 5 s · framing FS · ease sineInOut · capture stepped · tags locked-position, tilt, vertical-90*

Fixed camera position, the head tilts vertically with the heading held, so it can reach exactly −90° (straight down) or +90° (straight up) with no gimbal flip. Relative mode offsets from the pitch that centres the subject.

**When:** Revealing height (a tower, a creature), tilting down from the sky onto the subject, or tilting to look straight down a shaft.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `fromDeg` | number | `20` | -180 … 180 deg | Start pitch: offset above (+) / below (−) the subject (relative) or absolute pitch in [−90, 90] (−90 = straight down). |
| `toDeg` | number | `0` | -180 … 180 deg | End pitch, same convention as fromDeg. |
| `relative` | boolean | `true` | `true` / `false` | true: pitches are offsets from the pitch that centres the (live) subject; false: absolute camera pitches (±90 reachable exactly). |

#### `classic.roll` — Roll (dutch angle)

*needs: — · default 5 s · framing MS · ease sineInOut · capture stepped · tags dutch, roll*

A framed shot with the horizon tilted: static (fromDeg = toDeg) or rolling from fromDeg to toDeg, with an optional slow push. + = top of frame moves right.

**When:** Unease, disorientation, menace, a world off balance.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `fromDeg` | number | `0` | -90 … 90 deg | Roll at the start (added to the shot roll). |
| `toDeg` | number | `15` | -90 … 90 deg | Roll at the end (equal to fromDeg for a static dutch). |
| `pushM` | number | `0` | 0 … 50 m | Optional slow push toward the subject over the shot. |

#### `classic.zoom` — Zoom

*needs: — · default 4 s · framing WS · ease sineInOut · capture stepped · tags locked-position, fov*

Locked camera; only the field of view changes, from the shot fov (framing at the start) to the fov that frames toFraming (or toFovDeg), at an even rate of magnification. The aim eases to the new framing's height.

**When:** Isolating a detail without moving, the 70s crash zoom (ease expoInOut), compressing perspective; contrast with dolly-in.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `toFraming` | enum | `"MCU"` | `"EWS"` · `"WS"` · `"FS"` · `"MWS"` · `"MS"` · `"MCU"` · `"CU"` · `"ECU"` | Framing the zoom ends on (the shot framing is the start). |
| `toFovDeg` | number | `0` | 0 … 170 deg | Explicit end fov; 0 = derived from toFraming. |

#### `classic.dolly-in` — Dolly in

*needs: subject · default 6 s · framing MS · fov 50° · ease sineInOut · capture stepped · tags move, dolly*

The camera travels along the view axis toward the subject, from the fromFraming distance to the shot framing distance; the aim eases between the two framings' aim heights.

**When:** Building intensity, drawing the audience into a character's moment, moving from context to detail.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `fromFraming` | enum | `"WS"` | `"EWS"` · `"WS"` · `"FS"` · `"MWS"` · `"MS"` · `"MCU"` · `"CU"` · `"ECU"` | Framing at the start of the move (the shot framing is where it lands). |
| `profile` | enum | `"linear"` | `"linear"` · `"perceptual"` | linear: the distance changes at the eased dolly speed (screen size accelerates near the subject). perceptual: the distance changes geometrically, so the subject's screen size changes at an even rate (best for big CU↔EWS moves). |

#### `classic.dolly-out` — Dolly out

*needs: subject · default 6 s · framing MS · fov 50° · ease sineInOut · capture stepped · tags move, dolly*

The camera travels back along the view axis, from the shot framing distance to the toFraming distance.

**When:** Revealing context around a character, isolation, ending a scene.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `toFraming` | enum | `"WS"` | `"EWS"` · `"WS"` · `"FS"` · `"MWS"` · `"MS"` · `"MCU"` · `"CU"` · `"ECU"` | Framing at the end of the move (the shot framing is the start). |
| `profile` | enum | `"linear"` | `"linear"` · `"perceptual"` | linear: the distance changes at the eased dolly speed (screen size accelerates near the subject). perceptual: the distance changes geometrically, so the subject's screen size changes at an even rate (best for big CU↔EWS moves). |

#### `classic.truck` — Truck

*needs: — · default 6 s · framing FS · ease sineInOut · capture stepped · tags move, lateral*

Lateral move across the view axis (travelM, centred on the framed position). keepAim pans to hold the subject (an arcing feel); keepAim false keeps the head fixed so the subject crosses the frame with parallax.

**When:** Parallax past foreground objects, moving alongside a scene, revealing depth.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `travelM` | number | `3` | 0.1 … 500 m | Total lateral travel. |
| `direction` | enum | `"right"` | `"right"` · `"left"` | Direction of travel as seen by the camera. |
| `keepAim` | boolean | `true` | `true` / `false` | true: pan to keep the subject framed; false: fixed head (subject crosses the frame, centred mid-move). |

#### `classic.pedestal` — Pedestal

*needs: — · default 5 s · framing FS · ease sineInOut · capture stepped · tags move, vertical*

Vertical camera move (riseM up, negative down) from the framed position; keepAim tilts to hold the subject.

**When:** Rising from a low vantage to eye level, sinking below a ledge, revealing over a foreground edge.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `riseM` | number | `1.5` | -100 … 100 m | Vertical travel (+ up, − down; the ground clamp still applies). |
| `keepAim` | boolean | `true` | `true` / `false` | true: tilt to keep the subject framed; false: fixed head. |

#### `classic.crane` — Crane (jib arc)

*needs: — · default 7 s · framing WS · ease sineInOut · capture stepped · tags move, vertical, jib*

The camera rides the tip of a jib arm: it rises riseM through a symmetric arc of the arm while swinging swingDeg about the jib base, always aimed at the subject. Arms too short for the rise are lengthened (rise ≤ 1.9 × arm).

**When:** Grand openings and endings, rising above a crowd or a wall to reveal the scene, swooping down to a character.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `0` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `riseM` | number | `3` | -40 … 40 m | Height gained by the camera (negative = crane down). |
| `swingDeg` | number | `25` | -150 … 150 deg | Swing of the arm about the jib base (+ = clockwise seen from above). |
| `armM` | number | `4` | 1 … 30 m | Jib arm length (longer = flatter arc). |

#### `classic.arc` — Arc

*needs: — · default 7 s · framing MWS · ease sineInOut · capture stepped · tags move, orbit*

Partial orbit: the camera sweeps arcDeg around the (live) subject at constant distance and elevation, centred on azimuthDeg, always aimed.

**When:** Adding dimension to a static moment, revealing a character against a changing background, heroic emphasis.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `8` | -60 … 80 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `arcDeg` | number | `45` | 5 … 350 deg | Angle swept around the subject. |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | cw = clockwise seen from above (camera bearing increases), ccw = counter-clockwise. |

#### `classic.orbit` — Orbit

*needs: — · default 12 s · framing FS · ease linear · capture stepped · tags move, orbit*

Full circle(s) around the (live) subject at constant distance and elevation, starting at azimuthDeg; one revolution returns exactly to the start.

**When:** Showcasing a hero or a landmark, a moment frozen in time, loopable footage (ease linear).

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `12` | -60 … 80 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `revolutions` | number | `1` | 0.25 … 10 | Number of revolutions. |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | cw = clockwise seen from above (camera bearing increases), ccw = counter-clockwise. |

#### `classic.tracking-follow` — Tracking — follow

*needs: subject · default 8 s · framing WS · capture realtime · tags move, tracking, moving-subject*

The camera follows behind the moving subject (ctx.subjectAt) on a spring rig keyed to its smoothed travel heading; constant speed is tracked without lag, starts/stops/turns are felt a beat late.

**When:** Following a character into the unknown, journeys, chases from behind. Shoot with capture realtime when the subject is server-driven.

**Pilot bounds:** lateral ±2 m · rise 1.5 m · sink 0.8 m · speed ×1–1 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `elevationDeg` | number | `8` | -45 … 75 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `offsetDeg` | number | `0` | -90 … 90 deg | Extra angle added to the technique's base angle around the subject's travel heading (e.g. 30 = a three-quarter angle). |
| `lag` | number | `0.6` | 0 … 5 s | Operator spring smooth time: how softly the camera reacts to starts, stops and turns (0 = rigid). |
| `feedForward` | number | `1` | 0 … 1 | How much of the subject's velocity the operator anticipates: 1 = holds the framing distance at any constant speed (lag only on starts, stops, turns); lower = trails its spot by (1 − ff)·speed·lag (a lead/side camera then drifts closer to the subject). |
| `turnLag` | number | `0.9` | 0.05 … 10 s | Smooth time of the travel-heading spring (how late the rig swings round when the subject turns). |
| `aimLag` | number | `0.12` | 0 … 2 s | Smooth time of the aim point (filters jitter in the subject position; no steady lag). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |

#### `classic.tracking-lead` — Tracking — lead

*needs: subject · default 8 s · framing FS · capture realtime · tags move, tracking, moving-subject*

The camera travels ahead of the moving subject, facing it, on a spring rig keyed to its smoothed travel heading.

**When:** Walk-and-talk, a character striding toward the audience, determination, pursuit seen from the front.

**Pilot bounds:** lateral ±2 m · rise 1.5 m · sink 0.8 m · speed ×1–1 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `elevationDeg` | number | `8` | -45 … 75 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `offsetDeg` | number | `0` | -90 … 90 deg | Extra angle added to the technique's base angle around the subject's travel heading (e.g. 30 = a three-quarter angle). |
| `lag` | number | `0.6` | 0 … 5 s | Operator spring smooth time: how softly the camera reacts to starts, stops and turns (0 = rigid). |
| `feedForward` | number | `1` | 0 … 1 | How much of the subject's velocity the operator anticipates: 1 = holds the framing distance at any constant speed (lag only on starts, stops, turns); lower = trails its spot by (1 − ff)·speed·lag (a lead/side camera then drifts closer to the subject). |
| `turnLag` | number | `0.9` | 0.05 … 10 s | Smooth time of the travel-heading spring (how late the rig swings round when the subject turns). |
| `aimLag` | number | `0.12` | 0 … 2 s | Smooth time of the aim point (filters jitter in the subject position; no steady lag). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |

#### `classic.tracking-side` — Tracking — side

*needs: subject · default 8 s · framing FS · capture realtime · tags move, tracking, moving-subject*

The camera travels beside the moving subject (its left or right), profile view, spring-lagged; lead room places the subject on the trailing third while it moves.

**When:** Running, riding, marching; showing speed against a passing background.

**Pilot bounds:** lateral ±2 m · rise 1.5 m · sink 0.8 m · speed ×1–1 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `elevationDeg` | number | `8` | -45 … 75 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `offsetDeg` | number | `0` | -90 … 90 deg | Extra angle added to the technique's base angle around the subject's travel heading (e.g. 30 = a three-quarter angle). |
| `lag` | number | `0.6` | 0 … 5 s | Operator spring smooth time: how softly the camera reacts to starts, stops and turns (0 = rigid). |
| `feedForward` | number | `1` | 0 … 1 | How much of the subject's velocity the operator anticipates: 1 = holds the framing distance at any constant speed (lag only on starts, stops, turns); lower = trails its spot by (1 − ff)·speed·lag (a lead/side camera then drifts closer to the subject). |
| `turnLag` | number | `0.9` | 0.05 … 10 s | Smooth time of the travel-heading spring (how late the rig swings round when the subject turns). |
| `aimLag` | number | `0.12` | 0 … 2 s | Smooth time of the aim point (filters jitter in the subject position; no steady lag). |
| `side` | enum | `"right"` | `"right"` · `"left"` | Which side of the subject the camera travels on (relative to its travel direction). |
| `leadRoom` | boolean | `true` | `true` / `false` | Shift the subject to the trailing third (space ahead of it) in proportion to its speed. |

#### `classic.push-in` — Push-in

*needs: subject · default 6 s · framing MCU · fov 40° · ease sineInOut · capture stepped · tags move, dolly, emotional*

A slow, emotional dolly along the view axis between two close framings (fromFraming → shot framing), eased sineInOut on a longer lens.

**When:** A realisation, a decision, rising emotion; the audience leans in with the character.

**Pilot bounds:** lateral ±0.6 m · rise 0.5 m · sink 0.3 m · speed ×0.25–1.25 · distance ×1.15

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `fromFraming` | enum | `"MWS"` | `"EWS"` · `"WS"` · `"FS"` · `"MWS"` · `"MS"` · `"MCU"` · `"CU"` · `"ECU"` | Framing at the start of the push (the shot framing is where it lands). |
| `profile` | enum | `"linear"` | `"linear"` · `"perceptual"` | linear: the distance changes at the eased dolly speed (screen size accelerates near the subject). perceptual: the distance changes geometrically, so the subject's screen size changes at an even rate (best for big CU↔EWS moves). |

#### `classic.pull-out-reveal` — Pull-out reveal

*needs: subject · default 8 s · framing CU · fov 35° · ease sineInOut · capture stepped · reveal (subject may start out of frame) · tags move, dolly, reveal*

Starts tight on the subject (shot framing, default CU) and pulls back along the view axis to toFraming (default EWS), optionally rising to endElevationDeg, at a perceptually even rate.

**When:** Revealing where a character is (alone in a vast place, surrounded), endings, scale reveals.

**Pilot bounds:** lateral ±6 m · rise 6 m · sink 3 m · speed ×0.25–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `toFraming` | enum | `"EWS"` | `"EWS"` · `"WS"` · `"FS"` · `"MWS"` · `"MS"` · `"MCU"` · `"CU"` · `"ECU"` | Framing the pull-out ends on (the shot framing is the start). |
| `rise` | boolean | `true` | `true` / `false` | Rise while pulling out (elevation eases from elevationDeg to endElevationDeg). |
| `endElevationDeg` | number | `25` | -30 … 85 deg | Elevation at the end of the move when rise is true. |
| `profile` | enum | `"perceptual"` | `"linear"` · `"perceptual"` | linear: the distance changes at the eased dolly speed (screen size accelerates near the subject). perceptual: the distance changes geometrically, so the subject's screen size changes at an even rate (best for big CU↔EWS moves). |

#### `classic.dolly-zoom` — Dolly zoom (vertigo)

*needs: subject · default 5 s · framing MS · fov 60° · ease sineInOut · capture stepped · tags move, fov, vertigo*

The camera dollies along the view axis while the fov changes so the subject's frame height stays constant (fov(t) from the framing math); the background stretches or compresses. Shot fov → toFovDeg (narrowing fov = dolly out). The lens never enters the subject's standoff, which caps how wide a tight framing can end (use a wider framing for very wide end fovs).

**When:** Vertigo, shock, a sudden realisation, the world shifting around a character.

**Pilot bounds:** lateral ±0.6 m · rise 0.5 m · sink 0.3 m · speed ×0.25–1.25 · distance ×1.15

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `0` | -30 … 30 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `toFovDeg` | number | `25` | 5 … 120 deg | fov at the end (the shot fov is the start); smaller = dolly out + zoom in, larger = dolly in + zoom out. |

#### `classic.whip-pan` — Whip pan

*needs: — · default 3 s · framing MS · ease sineInOut · capture stepped · reveal (subject may start out of frame) · tags locked-position, pan, fast, transition*

Hold, then a very fast continuous pan of angleDeg in whipSec (≤ 0.35 s) centred at `at`, then hold. land 'subject' whips ONTO the subject; 'away' whips off it. Peak angular speed is reported in meta.motionLimits.

**When:** Energetic transitions, sudden attention shifts, comedic beats; cut on the blur.

**Pilot bounds:** lateral ±0.3 m · rise 0.3 m · sink 0.2 m · speed ×1–1 · distance ×1.05

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `angleDeg` | number | `90` | 20 … 180 deg | Angle of the whip. |
| `direction` | enum | `"right"` | `"right"` · `"left"` | Direction of the whip as seen by the camera. |
| `whipSec` | number | `0.25` | 0.12 … 0.35 s | Duration of the whip itself. |
| `at` | number | `0.5` | 0 … 1 | Centre of the whip as a fraction of the shot. |
| `land` | enum | `"subject"` | `"subject"` · `"away"` | subject: start off-subject and whip onto it; away: start on the subject and whip off. |

#### `classic.rack-focus` — Rack focus

*needs: subject · default 5 s · framing MS · fov 40° · ease sineInOut · capture stepped · tags locked, focus*

A locked (or slowly drifting) frame whose focus channel pulls from one distance to another over pullSec around `at`. Targets: foreground (0.35 × subject distance), subject (live distance), background (3 × subject distance), or explicit metres.

**When:** Shifting attention between foreground and subject, revealing a second element, a character noticing something. Needs ?filmDof=on to show.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `fromTarget` | enum | `"foreground"` | `"foreground"` · `"subject"` · `"background"` · `"metres"` | Focus target at the start. |
| `toTarget` | enum | `"subject"` | `"foreground"` · `"subject"` · `"background"` · `"metres"` | Focus target at the end. |
| `fromM` | number | `2` | 0.1 … 5000 m | Start focus distance when fromTarget is 'metres'. |
| `toM` | number | `20` | 0.1 … 5000 m | End focus distance when toTarget is 'metres'. |
| `at` | number | `0.5` | 0 … 1 | Centre of the focus pull as a fraction of the shot. |
| `pullSec` | number | `1.2` | 0.05 … 60 s | Duration of the focus pull. |
| `driftM` | number | `0` | 0 … 20 m | Optional slow push toward the subject over the shot (the 'subject' focus target follows it). |

#### `classic.over-the-shoulder` — Over the shoulder

*needs: subject · default 5 s · framing MCU · ease sineInOut · capture stepped · tags dialogue, coverage*

Camera just behind the second character's shoulder, framing the subject on the shoulder-side third (a long lens by default: fov from the framing). The second character comes from params.secondary / ctx.secondary, else a virtual partner in front of the subject.

**When:** Dialogue coverage, confrontation, establishing the relationship between two characters.

**Pilot bounds:** lateral ±0.6 m · rise 0.5 m · sink 0.3 m · speed ×0.25–1.25 · distance ×1.15

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `secondary` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | World position of the SECOND character's base (feet). [0,0,0] = not given: use ctx.secondary, else a virtual partner partnerM in front of the subject. |
| `secondaryHeight` | number | `1.8` | 0.3 … 50 m | Height of the second character. |
| `partnerM` | number | `1.6` | 0.5 … 30 m | Distance of the virtual partner in front of the subject when no secondary is given. |
| `shoulder` | enum | `"right"` | `"right"` · `"left"` | Which of the second character's shoulders the camera looks over. |
| `shoulderM` | number | `0.3` | 0 … 2 m | Lateral offset from the second character's centre line. |
| `backM` | number | `0.45` | 0.1 … 5 m | Distance behind the second character. |
| `raiseM` | number | `0.12` | -1 … 2 m | Height above the second character's shoulder (≈ 0.82 × height). |
| `composeThirds` | boolean | `true` | `true` / `false` | Place the subject on the third on the shoulder side (the shoulder fills the other side). |
| `autoFov` | boolean | `true` | `true` / `false` | Derive the fov from the shot framing and the resulting distance (long lens); false = use the shot fov. |
| `pushM` | number | `0.15` | 0 … 5 m | Subtle push toward the subject over the shot. |

#### `classic.pov` — Point of view

*needs: subject · default 5 s · framing — · fov 75° · ease sineInOut · capture stepped · tags subjective, body-rig, subject-is-camera*

The camera IS the subject's eyes: eye height, travel/facing heading (spring-smoothed), a walking bob and sway while it moves, a breathing drift at rest, optional creep forward (advanceM). The subject itself is not in frame.

**When:** Subjective experience, horror, discovery, entering a dungeon through a character's eyes. Hide the avatar for player POV.

**Pilot bounds:** lateral ±0.15 m · rise 0.15 m · sink 0.1 m · speed ×1–1 · distance ×1.05

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `eyeFrac` | number | `0.92` | 0.3 … 1.2 | Eye height as a fraction of the subject height. |
| `pitchDeg` | number | `-4` | -80 … 80 deg | Look pitch (+ up). |
| `lookYawDeg` | number | `0` | -180 … 180 deg | Look direction relative to the subject's heading (+ = right). |
| `advanceM` | number | `0` | 0 … 200 m | Creep forward along the heading over the shot (eased). |
| `bobM` | number | `0.025` | 0 … 0.2 m | Walking bob amplitude (scaled by the subject's speed). |
| `stepHz` | number | `1.8` | 0.5 … 4 Hz | Step frequency of the walking bob. |
| `turnLag` | number | `0.35` | 0.05 … 5 s | Smooth time of the head turning with the subject's heading. |

#### `classic.two-shot` — Two-shot

*needs: subject · default 6 s · framing MWS · ease sineInOut · capture stepped · tags dialogue, coverage*

Frames the subject and a second character together: camera perpendicular to the line between them (side auto/left/right), far enough that both fit in 85% of the frame width, with a slow drift.

**When:** Conversations, partnerships, two characters sharing a moment or a confrontation.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `secondary` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | World position of the SECOND character's base (feet). [0,0,0] = not given: use ctx.secondary, else a virtual partner partnerM in front of the subject. |
| `secondaryHeight` | number | `1.8` | 0.3 … 50 m | Height of the second character. |
| `partnerM` | number | `1.6` | 0.5 … 30 m | Distance of the virtual partner in front of the subject when no secondary is given. |
| `side` | enum | `"auto"` | `"auto"` · `"left"` · `"right"` | Side of the subject→secondary line for the camera (auto = the side facing ctx.anchor, else the sun, else left). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `elevationDeg` | number | `5` | -30 … 60 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `driftDeg` | number | `6` | -90 … 90 deg | Slow arc drift around the pair over the shot (centred). |

#### `classic.establishing` — Establishing

*needs: — · default 8 s · framing EWS · fov 50° · ease sineInOut · capture stepped · tags wide, aerial, slow*

Wide, high and slow: the camera hangs distance metres out and heightM up from the subject (or the anchor), drifting driftDeg around it and pushing pushPct closer.

**When:** Opening a scene or a new location, showing geography and scale.

**Pilot bounds:** lateral ±6 m · rise 6 m · sink 3 m · speed ×0.25–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `distance` | number | `80` | 5 … 5000 m | Horizontal distance from the subject / anchor. |
| `heightM` | number | `25` | 0 … 2000 m | Camera height above the subject's base. |
| `driftDeg` | number | `10` | -180 … 180 deg | Slow arc drift around the subject over the shot (centred; + = clockwise). |
| `pushPct` | number | `8` | -50 … 90 % | Percentage of the distance closed over the shot (negative = pull back). |

#### `classic.high-angle` — High angle

*needs: subject · default 5 s · framing MWS · ease sineInOut · capture stepped · tags angle*

Camera above the subject looking down at elevationDeg (default 40°), with a slow push.

**When:** Vulnerability, smallness, being watched or overwhelmed; overview of a situation.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `40` | 10 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `pushM` | number | `0.3` | 0 … 50 m | Slow push toward the subject over the shot. |

#### `classic.low-angle` — Low angle

*needs: subject · default 5 s · framing MWS · fov 55° · ease sineInOut · capture stepped · tags angle*

Camera below the subject's eye line looking up at it (elevationDeg default −25°), with a slow push; the ground clamp lifts it if needed.

**When:** Power, dominance, heroism, menace; making a character or creature loom.

**Pilot bounds:** lateral ±0.6 m · rise 0.5 m · sink 0.3 m · speed ×0.25–1.25 · distance ×1.15

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `-25` | -75 … -3 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `pushM` | number | `0.2` | 0 … 50 m | Slow push toward the subject over the shot. |

#### `classic.birds-eye` — Bird's-eye

*needs: — · default 6 s · framing WS · ease sineInOut · capture stepped · tags overhead, vertical-90*

Straight down from directly above the subject (pitch exactly −90°). The heading sets which way is image-up (azimuthDeg, default the subject's front); rotateDeg turns the image continuously; riseM climbs or descends.

**When:** Patterns, maps, god's-eye detachment, choreography seen from above.

**Pilot bounds:** lateral ±2 m · rise 4 m · sink 2 m · speed ×0.25–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Compass direction that is UP in the image, measured from azimuthRef (0 = the subject's front at the top of the frame). |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `heightM` | number | `0` | 0 … 3000 m | Camera height above the subject's base; 0 = from the framing (ground area framed = framing × subject height). |
| `rotateDeg` | number | `0` | -1440 … 1440 deg | Image rotation over the shot (heading change at nadir; + = clockwise heading). |
| `riseM` | number | `0` | -2000 … 2000 m | Height change over the shot (+ up). |

#### `classic.worms-eye` — Worm's-eye

*needs: subject · default 5 s · framing MS · fov 75° · ease sineInOut · capture stepped · tags angle, ground*

Lens just above the ground (heightM), close to the subject (horizontalM), looking up steeply at it on a wide lens; spinDeg optionally rolls the sky around.

**When:** Towering figures and architecture, awe, threat, a fallen character's view of an attacker.

**Pilot bounds:** lateral ±0.8 m · rise 0.4 m · sink 0 m · speed ×0.5–1 · distance ×1.15

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `heightM` | number | `0.75` | 0 … 3 m | Lens height above the ground (never below the 0.7 m clearance outdoors). |
| `horizontalM` | number | `0` | 0 … 100 m | Horizontal distance from the subject; 0 = just outside its radius (≥ 0.9 m). |
| `spinDeg` | number | `0` | -720 … 720 deg | Roll rotation over the shot. |

#### `classic.handheld` — Handheld

*needs: — · default 5 s · framing MS · ease sineInOut · capture stepped · tags handheld, shake, seeded*

A static or push-in base with seeded, bounded, organic camera shake (createShake); the same seed always reproduces the same shake.

**When:** Urgency, documentary realism, chaos, combat.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×0.5–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `base` | enum | `"static"` | `"static"` · `"push-in"` | Underlying move. |
| `pushM` | number | `0.5` | 0 … 20 m | Push distance for the push-in base. |
| `amplitudeDeg` | number | `0.6` | 0 … 5 deg | Angular shake amplitude (heading/pitch; roll is half). |
| `frequencyHz` | number | `1.2` | 0.05 … 10 Hz | Base shake frequency. |
| `posAmplitude` | number | `0.03` | 0 … 0.5 m | Positional shake amplitude per axis. |
| `roughness` | number | `0.5` | 0 … 1 | 0 = one smooth octave, 1 = jittery. |

#### `classic.steadicam` — Steadicam

*needs: subject · default 8 s · framing MWS · ease sineInOut · capture stepped · tags move, body-rig, moving-subject*

A floating walk with the subject: spring rig leading, following or beside it (smoothed travel heading), a slow glide closer, and the operator's gentle gait bob and sway while walking.

**When:** Long fluid takes, walk-and-talks, immersive movement through spaces.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `mode` | enum | `"lead"` | `"lead"` · `"follow"` · `"side-left"` · `"side-right"` | Where the operator walks relative to the subject's travel direction. |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `elevationDeg` | number | `3` | -30 … 60 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `glideM` | number | `0.8` | 0 … 50 m | Distance the operator closes over the shot. |
| `lag` | number | `1` | 0.05 … 5 s | Spring smooth time (floatiness). |
| `feedForward` | number | `1` | 0 … 1 | Velocity anticipation (see tracking-*): 1 holds the distance at constant speed; lower trails the spot by (1 − ff)·speed·lag. |
| `turnLag` | number | `1.2` | 0.05 … 10 s | Smooth time of the travel-heading spring. |
| `bobM` | number | `0.012` | 0 … 0.1 m | Gait bob amplitude while walking. |
| `stepHz` | number | `1.8` | 0.5 … 4 Hz | Operator step frequency. |
| `swayDeg` | number | `0.35` | 0 … 5 deg | Roll sway amplitude while walking. |

#### `classic.snorricam` — Snorricam

*needs: subject · default 6 s · framing MCU · fov 70° · ease sineInOut · capture stepped · tags body-rig, moving-subject*

Camera rigidly mounted on the subject's body at arm's length, facing them: the subject stays locked in frame while the world moves and sways around them.

**When:** Intoxication, panic, disorientation, intense subjective focus on a moving character.

**Pilot bounds:** lateral ±0.15 m · rise 0.15 m · sink 0.1 m · speed ×1–1 · distance ×1.05

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `armM` | number | `0.7` | 0.3 … 3 m | Rig arm length (lens distance in front of the subject). |
| `heightFrac` | number | `0.85` | 0.3 … 1.2 | Lens height as a fraction of the subject height. |
| `bobM` | number | `0.02` | 0 … 0.2 m | Body bob amplitude while the subject walks. |
| `swayDeg` | number | `1` | 0 … 10 deg | Body roll sway while the subject walks. |
| `stepHz` | number | `1.8` | 0.5 … 4 Hz | Step frequency. |
| `turnLag` | number | `0.2` | 0.02 … 5 s | Smoothing of the subject's body heading. |

#### `classic.reveal-from-occluder` — Reveal from occluder

*needs: subject · default 6 s · framing MS · ease sineInOut · capture stepped · reveal (subject may start out of frame) · tags move, reveal*

Starts with the occluder (params.occluder: tree, pillar, wall end; radius occluderRadius) between camera and subject, holds, then trucks sideways just far enough that the subject clears it, aimed throughout. meta.revealOccluder tells the runtime not to fade it.

**When:** Discovering a character, suspense, a slow reveal from behind foreground scenery.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×0.25–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `3` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `occluder` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | World position of the occluder's base/centre; [0,0,0] = a virtual occluder between camera and subject (≈45% of the way, clear of the subject) — the move without a real blocker. A real occluder hugging the subject caps the truck at 3× the camera distance. |
| `occluderRadius` | number | `0.6` | 0.05 … 50 m | Radius of the occluder. |
| `direction` | enum | `"right"` | `"right"` · `"left"` | Direction of the reveal truck as seen by the camera. |
| `holdFrac` | number | `0.2` | 0 … 0.6 | Fraction of the shot held hidden before moving. |
| `settleFrac` | number | `0.15` | 0 … 0.6 | Fraction of the shot held revealed at the end. |
| `marginM` | number | `0.25` | 0 … 20 m | Extra clearance between the occluder and the line of sight at the end. |

#### `classic.time-lapse` — Time-lapse

*needs: — · default 8 s · framing WS · ease linear · capture stepped · tags locked, time-lapse*

A locked-off frame while the runtime advances sky time at meta.timeLapse.rate game-days per film second.

**When:** Passage of time, day turning to night, clouds racing over a landmark.

**Pilot bounds:** lateral ±0.5 m · rise 0.5 m · sink 0.3 m · speed ×1–1 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `5` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `rate` | number | `0.02` | 0 … 5 game-days/s | Sky time advanced per film second (0.02 ≈ 29 game-minutes per second). |

#### `classic.hyperlapse` — Hyperlapse

*needs: — · default 8 s · framing WS · ease linear · capture stepped · tags move, time-lapse*

A slow, steady move (truck, push or arc of moveM metres) while the runtime advances sky time at meta.timeLapse.rate game-days per film second.

**When:** Time and space passing together: approaching a city as the day ends, circling a landmark through dusk.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.8 m · speed ×1–1 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `azimuthDeg` | number | `0` | -360 … 360 deg | Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it. |
| `azimuthRef` | enum | `"front"` | `"front"` · `"compass"` | front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject). |
| `elevationDeg` | number | `8` | -60 … 85 deg | Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up). |
| `distance` | number | `0` | 0 … 5000 m | Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming). |
| `thirds` | enum | `"center"` | `"center"` · `"left"` · `"right"` | Where the subject sits horizontally: centred, or on the left / right third line. |
| `move` | enum | `"truck"` | `"truck"` · `"push"` · `"arc"` | Type of move. |
| `moveM` | number | `12` | 0.5 … 2000 m | Distance travelled (arc: arc length around the subject). |
| `direction` | enum | `"right"` | `"right"` · `"left"` | Direction of the truck / arc as seen by the camera. |
| `rate` | number | `0.02` | 0 … 5 game-days/s | Sky time advanced per film second. |

### Drone (`drone.*`)

#### `drone.flyover` — Flyover

*needs: outdoor only · default 10 s · framing WS · ease linear · capture stepped · tags aerial, establishing, travel*

Straight, level pass over the subject or anchor at a fixed height above it, rising smoothly over high terrain. The gimbal either holds a fixed tilt along the direction of travel, or tracks the subject down to straight-down as the drone crosses it and then holds the top-down view.

**When:** Opening or transition shots that cross a town, landmark or landscape. Use gimbal 'fixed' for a travelling vista. Use 'track' to keep a landmark in view until you pass over it. For a pass-over that keeps the subject in frame through vertical and beyond, use drone.pass-over.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `30` | 2 … 300 m | Flight height above the subject's base (or the ground at the anchor). |
| `speed` | number | `8` | 0.5 … 30 m/s | Average ground speed; the pass covers speed × duration metres, centred on the subject. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `gimbal` | enum | `"fixed"` | `"fixed"` · `"track"` | fixed = constant tilt along the travel direction; track = pitch follows the subject until it is straight below, then holds top-down. |
| `tiltDeg` | number | `-35` | -90 … 30 deg | Gimbal pitch in 'fixed' mode (negative looks down). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.flythrough` — Fly-through

*needs: — · default 8 s · framing WS · ease linear · capture stepped · tags aerial, transition, gap*

Flies through an opening (an arch, a doorway, a gap between trees or towers), slowing as it threads the gap and lined up with the gap's normal. Give the gap as gapPos/gapNormal/gapWidth/gapHeight (or ctx.gap), or a ctx.path that threads it; with neither, the gap is heightAGL above the anchor, crossed along headingDeg.

**When:** Transitions from outside to inside (through a town gate, a ruin's arch) and reveals of what lies behind an opening. Use fpv.fpv-gap for the fast, banked FPV version.

**Pilot bounds:** lateral ±0.3 m · rise 0.3 m · sink 0.3 m · speed ×0.4–1.1 · distance ×1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `gapPos` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | World centre of the gap (AC metres). [0,0,0] = the anchor raised by heightAGL. |
| `gapNormal` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | Direction of travel through the gap (need not be unit). [0,0,0] = no explicit gap (use ctx.gap, ctx.path or the anchor + headingDeg). |
| `gapWidth` | number | `3` | 0.3 … 100 m | Gap width (reported to the runtime in meta.gap for clearance checks). |
| `gapHeight` | number | `3` | 0.3 … 100 m | Gap height (reported in meta.gap). |
| `heightAGL` | number | `2` | 0.5 … 200 m | Gap centre height above the reference ground when the gap comes from the anchor. |
| `speed` | number | `5` | 0.5 … 20 m/s | Cruise speed; without a path the move covers speed × duration metres centred on the gap (the fitted profile keeps the duration exact). |
| `gapSpeed` | number | `0.5` | 0.1 … 1 | Speed at the gap as a fraction of the cruise speed. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `cornerRadius` | number | `6` | 0 … 100 m | Fillet radius applied to the corners of ctx.path. |
| `lookAhead` | number | `6` | 0.5 … 50 m | How far ahead along the path the camera looks. |
| `tiltDeg` | number | `0` | -45 … 30 deg | Pitch added to the look-ahead direction. |
| `ends` | enum | `"cruise"` | `"cruise"` · `"rest"` | cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering. |

#### `drone.orbit-poi` — Orbit (point of interest)

*needs: — · default 10 s · framing WS · ease linear · capture stepped · tags aerial, orbit, hero*

Circles the subject (or anchor) at a constant radius and height, always looking at it. The orbit is centred on the subject's start position and rises smoothly where the terrain under the orbit is high.

**When:** Hero shots of a landmark, lifestone, statue or a standing character. A quarter turn over 8–10 s reads as calm; a full turn is a showcase. Use drone.helix to climb while orbiting, or drone.hyperlapse-orbit for time-lapse sky.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.2 · distance ×1.35

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `radius` | number | `30` | 2 … 500 m | Horizontal orbit radius. |
| `heightAGL` | number | `15` | 1 … 300 m | Orbit height above the subject's base. |
| `revolutions` | number | `0.25` | 0.01 … 10 | Turns completed over the shot (0.25 = a quarter orbit). |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | Orbit direction seen from above: cw (clockwise) or ccw. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.helix` — Helix

*needs: — · default 14 s · framing WS · ease sineInOut · capture stepped · tags aerial, orbit, rise*

Orbits the subject while climbing, and optionally widening, along a corkscrew. Radius and height move from their start to their end values over the shot while the camera keeps looking at the subject.

**When:** Rising hero shots: a tower, a statue, a character on a hilltop. Climbing while widening gives an ending that reveals the surroundings. For the descending version use drone.spiral-descent.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.2 · distance ×1.35

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `radiusStart` | number | `15` | 2 … 500 m | Orbit radius at the start. |
| `radiusEnd` | number | `30` | 2 … 500 m | Orbit radius at the end. |
| `heightStart` | number | `4` | 0.5 … 300 m | Height above the subject's base at the start. |
| `heightEnd` | number | `40` | 0.5 … 300 m | Height above the subject's base at the end. |
| `revolutions` | number | `0.5` | 0.05 … 10 | Turns completed over the shot. |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | Orbit direction seen from above: cw (clockwise) or ccw. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.dronie` — Dronie

*needs: subject, outdoor only · default 10 s · framing FS · ease sineInOut · capture stepped · tags aerial, reveal, character*

Starts close on the subject and flies back and up in one straight line, keeping the subject centred, so the subject shrinks while the world opens up around it. When startDistance is 0 the start distance comes from the shot's framing.

**When:** Endings and big reveals of where a character is: a player on a cliff, in a town square or by a portal. Works best when there is open sky behind the camera's line.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `startDistance` | number | `0` | 0 … 100 m | Horizontal start distance from the subject; 0 = the distance that frames it at the shot framing (≥ 2.5 m). |
| `endDistance` | number | `60` | 2 … 1000 m | Horizontal distance at the end. |
| `startHeight` | number | `1.5` | 0.3 … 100 m | Camera height above the subject's base at the start. |
| `endHeight` | number | `35` | 0.5 … 500 m | Camera height above the subject's base at the end. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.boom-rise` — Boom rise

*needs: — · default 8 s · framing WS · ease sineInOut · capture stepped · tags aerial, rise, pedestal*

Rises straight up at a fixed spot. With keepAim the camera keeps looking at the subject and tilts down as it climbs; without it the gimbal holds a fixed tilt toward the subject's direction, so the horizon drops through the frame.

**When:** Pedestal-style reveals: rising from behind a wall or hedge or up a tower face, or lifting off from a character to show the town. Use drone.rising-reveal when there is a foreground obstacle to clear.

**Pilot bounds:** lateral ±2 m · rise 3 m · sink 1 m · speed ×0.5–1.2 · distance ×1.2

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `10` | 0.5 … 300 m | Horizontal distance from the subject. |
| `heightStart` | number | `1.5` | 0.3 … 300 m | Start height above the subject's base. |
| `heightEnd` | number | `25` | 0.5 … 500 m | End height above the subject's base. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `keepAim` | boolean | `true` | `true` / `false` | true = keep looking at the subject; false = hold tiltDeg (level boom). |
| `tiltDeg` | number | `0` | -90 … 30 deg | Gimbal pitch when keepAim is false. |
| `minClearance` | number | `0.7` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.rising-reveal` — Rising reveal

*needs: outdoor only · default 9 s · framing EWS · ease sineInOut · capture stepped · reveal (subject may start out of frame) · tags aerial, reveal, opener*

Starts low behind a foreground obstacle (a wall, roofline, hedge or ridge) looking at its face, then rises over it while pitching from the obstacle toward the horizon to reveal the vista and the subject beyond. The obstacle sits obstacleDistance ahead of the camera on its line to the subject.

**When:** The classic opener: rise over the rooftops toward a lifestone, or over a ridge to a valley town. Place the anchor or subject at what should be revealed and set the obstacle's height.

**Pilot bounds:** lateral ±2 m · rise 3 m · sink 1 m · speed ×0.5–1.2 · distance ×1.2

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `40` | 2 … 1000 m | Horizontal distance from the camera's start to the subject/anchor being revealed. |
| `obstacleDistance` | number | `6` | 0.5 … 100 m | How far ahead of the camera the obstacle stands. |
| `obstacleHeight` | number | `8` | 0.5 … 200 m | Obstacle top above the ground at the camera's start. |
| `heightStart` | number | `1.5` | 0.3 … 100 m | Start height above the ground. |
| `clearance` | number | `5` | 0.5 … 100 m | End height above the obstacle top. |
| `forward` | number | `4` | 0 … 100 m | Forward drift toward the subject during the rise. |
| `endPitchDeg` | number | `-8` | -60 … 20 deg | Pitch at the end (near the horizon reveals the vista). |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.tilt-reveal` — Tilt reveal

*needs: outdoor only · default 8 s · framing EWS · ease sineInOut · capture stepped · reveal (subject may start out of frame) · tags aerial, reveal, tilt*

Hovers at height looking almost straight down at the ground, then tilts up toward the horizon while drifting slightly forward, revealing the subject and the landscape beyond.

**When:** Openers that start on a texture (a path, water, a rooftop) and reveal a town or landmark ahead. The camera starts `distance` metres from the subject on bearingDeg, facing it.

**Pilot bounds:** lateral ±2 m · rise 3 m · sink 1 m · speed ×0.5–1.2 · distance ×1.2

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `startPitchDeg` | number | `-80` | -90 … 0 deg | Pitch at the start (−90 = straight down). |
| `endPitchDeg` | number | `-10` | -60 … 30 deg | Pitch at the end. |
| `heightAGL` | number | `20` | 1 … 300 m | Hover height above the subject's base. |
| `distance` | number | `60` | 1 … 2000 m | Horizontal distance from the subject at the start. |
| `drift` | number | `4` | 0 … 100 m | Forward drift toward the subject over the shot. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `2` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.top-down` — Top-down

*needs: — · default 8 s · framing WS · ease linear · capture stepped · tags aerial, nadir, 90-degree*

Looks straight down (nadir) from a hover above the subject's start position. It can rotate the image (rotateDeg) or drift across the ground. The image never flips: the heading only rotates the image. pitchDeg slightly above −90 tilts the view off nadir while the subject stays centred.

**When:** Graphic, map-like shots of town squares, patterns, crowds, roads and water, and as a transition. Rotate 30–90° for motion. Use pitchDeg ≈ −88 when fire, portal or smoke particles sit directly below (billboards spin at exact nadir).

**Pilot bounds:** lateral ±3 m · rise 6 m · sink 2 m · speed ×0.4–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `40` | 3 … 500 m | Height above the subject's base. |
| `rotateDeg` | number | `0` | -1080 … 1080 deg | Image rotation over the shot (+ = clockwise heading change). |
| `headingDeg` | number | `0` | -360 … 360 deg | Image 'up' direction at the start, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `pitchDeg` | number | `-90` | -90 … -60 deg | Gimbal pitch (−90 = exact nadir). |
| `drift` | number | `0` | 0 … 300 m | Ground distance drifted along driftHeadingDeg, centred on the subject. |
| `driftHeadingDeg` | number | `0` | -360 … 360 deg | Drift direction, compass degrees (see relativeToSubject). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.top-down-rise` — Top-down rise (god's-eye pull-up)

*needs: outdoor only · default 10 s · framing WS · ease sineInOut · capture stepped · tags aerial, nadir, rise, 90-degree*

Looks straight down at the subject and climbs vertically, optionally rotating the image. The subject shrinks to a dot in its surroundings.

**When:** Endings and scale reveals: a lone character in a big landscape, a camp in a forest, a dungeon entrance in the wilds.

**Pilot bounds:** lateral ±3 m · rise 6 m · sink 2 m · speed ×0.4–1.25 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightStart` | number | `6` | 1 … 300 m | Start height above the subject's base (raised to at least 1.5 m over the subject's top). |
| `heightEnd` | number | `80` | 2 … 1000 m | End height above the subject's base. |
| `rotateDeg` | number | `0` | -1080 … 1080 deg | Image rotation over the shot. |
| `headingDeg` | number | `0` | -360 … 360 deg | Image 'up' direction at the start, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `pitchDeg` | number | `-90` | -90 … -60 deg | Gimbal pitch (−90 = exact nadir). |
| `minClearance` | number | `2` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.top-down-track` — Top-down track

*needs: subject, outdoor only · default 10 s · framing WS · ease linear · capture realtime · tags aerial, nadir, follow, 90-degree*

Flies straight down over a moving subject and follows it (subjectAt). The subject's track is smoothed so server jitter never shakes the frame. The image 'up' follows the subject's direction of travel ('travel') or stays fixed.

**When:** Overhead follows of a running character, a caravan or a creature on the move. Moving server-driven subjects need realtime capture.

**Pilot bounds:** lateral ±2.5 m · rise 3 m · sink 1 m · speed ×0.5–1.5 · distance ×1.4

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `25` | 3 … 300 m | Height above the subject's base. |
| `headingMode` | enum | `"travel"` | `"travel"` · `"fixed"` | travel = image up follows the subject's travel direction; fixed = constant headingDeg. |
| `headingDeg` | number | `0` | -360 … 360 deg | Fixed image-up heading (fixed mode) or an offset added to the travel heading (travel mode). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `smoothSec` | number | `0.6` | 0 … 5 s | Smoothing window of the subject track. |
| `pitchDeg` | number | `-90` | -90 … -60 deg | Gimbal pitch (−90 = exact nadir). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.pass-over` — Pass-over (gimbal through vertical)

*needs: outdoor only · default 12 s · framing WS · ease linear · capture stepped · tags aerial, nadir, 90-degree, flagship*

Flies forward straight over the subject while the gimbal tracks it all the way down through −90° and back up behind. A pre-simulated look controller handles the overhead moment. With 'yaw-slew' (default) the heading holds while the subject is straight below and then slews round at ≤ maxYawRateDeg: a smooth image rotation (the drone 'gimbal flip'), never a snap. 'pitch-through' keeps pitching past vertical (the image inverts, FPV style); 'hold' freezes the heading while overhead.

**When:** The flagship crossing shot: pass over a meeting hall, a portal or a character and keep it in frame the whole way. Slow speeds and a higher pass make the slew gentler.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `25` | 3 … 300 m | Pass height above the subject's base. |
| `speed` | number | `6` | 0.5 … 25 m/s | Ground speed; the pass covers speed × duration metres centred on the subject. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `nadirMode` | enum | `"yaw-slew"` | `"yaw-slew"` · `"pitch-through"` · `"hold"` | What the gimbal does when the subject is straight below (see description). |
| `maxYawRateDeg` | number | `90` | 10 … 720 deg/s | Heading slew-rate limit of the gimbal. |
| `maxPitchRateDeg` | number | `90` | 10 … 720 deg/s | Pitch rate limit of the gimbal. |
| `smoothTime` | number | `0.25` | 0 … 2 s | Gimbal smoothing time (critically damped). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.parallax-slide` — Parallax slide

*needs: — · default 8 s · framing WS · ease sineInOut · capture stepped · tags aerial, parallax, truck*

Trucks sideways past the subject at low height, facing it. A partial counter-pan (panAmount) keeps the subject in frame while foreground and background slide past at different speeds.

**When:** Adding depth to a static scene: sliding past a tree line, a statue or a gate with something in the foreground. Lower heights and closer foregrounds give stronger parallax.

**Pilot bounds:** lateral ±1.5 m · rise 2 m · sink 0.75 m · speed ×0.5–1.2 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `15` | 1 … 500 m | Horizontal distance from the subject (camera line centre). |
| `heightAGL` | number | `3` | 0.5 … 200 m | Height above the subject's base. |
| `slide` | number | `12` | 0.5 … 500 m | Total sideways travel, centred on the subject's bearing. |
| `panAmount` | number | `0.35` | 0 … 1 | Share of the subject's bearing change the camera follows (0 = pure truck, 1 = full pan). |
| `direction` | enum | `"right"` | `"right"` · `"left"` | Slide direction relative to the camera. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.terrain-skim` — Terrain skim

*needs: outdoor only · default 10 s · framing WS · ease linear · capture stepped · tags aerial, low, speed, terrain*

Flies fast and low (1.5–4 m) over the ground, following ctx.groundZ. The terrain is max-filtered ahead and smoothed, so the drone rises before a bump rather than after it. The camera looks ahead along the flight, pitching with the slope and banking gently into turns. It follows ctx.path when given, else a straight line through the anchor along headingDeg.

**When:** Energy and speed: racing over fields, across water, along a road into town. Keep the speed believable (8–14 m/s). Use drone.canyon-run for valleys and fpv.fpv-proximity to hug a wall.

**Pilot bounds:** lateral ±2 m · rise 2.5 m · sink 0.5 m · speed ×0.3–1.2 · distance ×1.2

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `2.5` | 1.5 … 4 m | Height above the smoothed terrain. |
| `speed` | number | `10` | 1 … 25 m/s | Ground speed without a path (covers speed × duration metres centred on the anchor); with a path the fitted profile sets the speed. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `lookAhead` | number | `12` | 1 … 100 m | How far ahead along the flight the camera looks (also the terrain look-ahead). |
| `tiltDeg` | number | `-4` | -45 … 20 deg | Pitch added to the look-ahead direction. |
| `cornerRadius` | number | `10` | 0 … 200 m | Fillet radius applied to the corners of ctx.path. |
| `alat` | number | `3` | 0.5 … 20 m/s² | Lateral acceleration limit (slows into curves). |
| `maxBankDeg` | number | `15` | 0 … 45 deg | Largest bank into turns. |
| `ends` | enum | `"cruise"` | `"cruise"` · `"rest"` | cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering. |

#### `drone.canyon-run` — Canyon run

*needs: path, outdoor only · default 12 s · framing EWS · ease linear · capture stepped · tags aerial, path, speed, terrain*

Follows a valley, river or canyon floor polyline (ctx.path) at a height above it. Corners are filleted into curves, the drone slows into tight bends, banks with the turn and looks ahead along the valley. It rises over the smoothed terrain wherever the ground climbs above the path.

**When:** Flowing journeys through valleys, gorges, riverbeds or along a town's main street. Give the path as points along the valley floor.

**Pilot bounds:** lateral ±2 m · rise 2.5 m · sink 0.5 m · speed ×0.3–1.2 · distance ×1.2

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `8` | 1 … 200 m | Height above the path points. |
| `speed` | number | `12` | 1 … 30 m/s | Nominal cruise speed; the fitted profile scales it so the run lasts exactly the shot duration. |
| `alat` | number | `4` | 0.5 … 20 m/s² | Lateral acceleration limit (slows into bends). |
| `cornerRadius` | number | `15` | 0 … 300 m | Fillet radius of the path corners. |
| `lookAhead` | number | `20` | 1 … 200 m | How far ahead along the valley the camera looks. |
| `tiltDeg` | number | `-3` | -45 … 20 deg | Pitch added to the look-ahead direction. |
| `maxBankDeg` | number | `25` | 0 … 60 deg | Largest bank into bends. |
| `bankGain` | number | `1` | 0 … 3 | Bank multiplier (0 = level horizon). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |
| `ends` | enum | `"cruise"` | `"cruise"` · `"rest"` | cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering. |

#### `drone.chase` — Chase

*needs: subject · default 10 s · framing FS · ease linear · capture realtime · tags aerial, follow, moving-subject*

Follows a moving subject from behind (relative to its direction of travel) at a set distance and height and looks at it. The subject's track is smoothed. The camera swings smoothly behind the subject when it turns. A static subject is framed from behind its facing.

**When:** Following a running character, a mount or a fleeing creature. Use realtime capture for server-driven motion.

**Turns:** a U-turn of the subject at 90°/s pulls the flown camera about 2.3 m off its path and in to 0.74× its distance; a `tracking-gap` warning means shoot again with a gentler turn (§1 Turning subjects).

**Pilot bounds:** lateral ±2.5 m · rise 3 m · sink 1 m · speed ×0.5–1.5 · distance ×1.4

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `8` | 1 … 200 m | Horizontal distance from the subject. |
| `heightAGL` | number | `3` | 0.5 … 200 m | Height above the subject's base. |
| `offsetAngleDeg` | number | `0` | -180 … 180 deg | Rotate the camera's placement around the subject (+ = clockwise seen from above). |
| `smoothSec` | number | `0.6` | 0 … 5 s | Smoothing window of the subject track (removes server jitter). |
| `minClearance` | number | `1.5` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.lead` — Lead

*needs: subject · default 10 s · framing FS · ease linear · capture realtime · tags aerial, follow, moving-subject*

Flies ahead of a moving subject, backwards, facing it, so the subject walks or runs toward the lens with its path behind it.

**When:** Heroic advances (an army marching, a character striding toward the camera) and showing who follows the subject.

**Turns:** a U-turn of the subject at 90°/s pulls the flown camera about 2.3 m off its path and out to 1.28× its distance; a `tracking-gap` warning means shoot again with a gentler turn (§1 Turning subjects).

**Pilot bounds:** lateral ±2.5 m · rise 3 m · sink 1 m · speed ×0.5–1.5 · distance ×1.4

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `8` | 1 … 200 m | Horizontal distance from the subject. |
| `heightAGL` | number | `2.5` | 0.5 … 200 m | Height above the subject's base. |
| `offsetAngleDeg` | number | `0` | -180 … 180 deg | Rotate the camera's placement around the subject (+ = clockwise seen from above). |
| `smoothSec` | number | `0.6` | 0 … 5 s | Smoothing window of the subject track (removes server jitter). |
| `minClearance` | number | `1.5` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.side-track` — Side track

*needs: subject · default 10 s · framing FS · ease linear · capture realtime · tags aerial, follow, moving-subject*

Flies parallel to a moving subject on its left or right side and looks at it. The background streams past behind the subject.

**When:** Showing speed and the landscape a subject travels through: riders on a road, a creature along a shore.

**Turns:** a U-turn of the subject at 90°/s pulls the flown camera about 2.3 m off its path (distance 0.87–1.04×); a quarter turn one way stretches the distance to 1.155×; a `tracking-gap` warning means shoot again with a gentler turn (§1 Turning subjects).

**Pilot bounds:** lateral ±2.5 m · rise 3 m · sink 1 m · speed ×0.5–1.5 · distance ×1.4

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `distance` | number | `8` | 1 … 200 m | Horizontal distance from the subject. |
| `heightAGL` | number | `2` | 0.5 … 200 m | Height above the subject's base. |
| `offsetAngleDeg` | number | `0` | -180 … 180 deg | Rotate the camera's placement around the subject (+ = clockwise seen from above). |
| `smoothSec` | number | `0.6` | 0 … 5 s | Smoothing window of the subject track (removes server jitter). |
| `minClearance` | number | `1.5` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |
| `side` | enum | `"right"` | `"right"` · `"left"` | Which side of the subject (relative to its travel) the camera flies on. |

#### `drone.boomerang` — Boomerang

*needs: subject · default 10 s · framing FS · ease linear · capture stepped · tags aerial, rhythm, music-video*

Flies in toward the subject along bearingDeg, eases to a stop at the near distance, then retreats back out while climbing by `rise`. The turnaround has zero velocity, so it reads as one continuous gesture.

**When:** Rhythmic, music-video beats (in on the verse, out on the hook) and showing a subject twice at different scales.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.25 · distance ×1.3

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `far` | number | `30` | 2 … 1000 m | Horizontal start/end distance. |
| `near` | number | `8` | 1 … 500 m | Horizontal distance at the turnaround. |
| `heightStart` | number | `6` | 0.5 … 300 m | Height above the subject's base at the start. |
| `heightNear` | number | `3` | 0.5 … 300 m | Height at the turnaround. |
| `rise` | number | `8` | 0 … 300 m | Extra height gained on the way out. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1.5` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.fly-by` — Fly-by

*needs: subject · default 6 s · framing FS · ease linear · capture stepped · tags aerial, speed, whip*

Flies a straight line past the subject at speed, offset to one side, while the camera yaws to keep it centred. The fastest pan happens at the closest point, so the subject whips through the frame's centre and the background streaks.

**When:** Energetic beats and transitions: whipping past a character, a banner or a guard tower. Peak yaw rate ≈ speed / offset (keep it under ≈ 3 rad/s).

**Pilot bounds:** lateral ±1.5 m · rise 2 m · sink 0.75 m · speed ×0.5–1.2 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `offset` | number | `6` | 1 … 200 m | Closest horizontal distance to the subject. |
| `heightAGL` | number | `3` | 0.5 … 200 m | Height above the subject's base. |
| `speed` | number | `12` | 1 … 30 m/s | Ground speed; the line is speed × duration long, closest approach at mid-shot. |
| `side` | enum | `"left"` | `"left"` · `"right"` | Side of the camera the subject passes on. |
| `headingDeg` | number | `90` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.spiral-descent` — Spiral descent

*needs: — · default 14 s · framing WS · ease sineInOut · capture stepped · tags aerial, orbit, descend*

Descends in a tightening spiral around the subject while looking at it. The reverse of a helix: a high, wide establishing view becomes a close one.

**When:** Arriving at a place: from above a town down to its square, from the sky down to a character, into a crater or a courtyard.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.2 · distance ×1.35

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `radiusStart` | number | `40` | 2 … 500 m | Orbit radius at the start. |
| `radiusEnd` | number | `12` | 2 … 500 m | Orbit radius at the end. |
| `heightStart` | number | `50` | 0.5 … 500 m | Height above the subject's base at the start. |
| `heightEnd` | number | `6` | 0.5 … 300 m | Height above the subject's base at the end. |
| `revolutions` | number | `0.5` | 0.05 … 10 | Turns completed over the shot. |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | Orbit direction seen from above: cw (clockwise) or ccw. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.pano-360` — Panorama 360

*needs: — · default 14 s · framing EWS · ease sineInOut · capture stepped · tags aerial, pan, vista*

Hovers above the subject's position (or the anchor) with the gimbal level and yaws through a full turn (yawDeg), easing in and out.

**When:** Showing the whole surroundings of a place from above: a town's skyline, a mountain top, a lake. The subject itself is not kept in frame.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 2 m · speed ×0.5–1.2 · distance ×1.2

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightAGL` | number | `30` | 1 … 500 m | Hover height above the subject's base. |
| `yawDeg` | number | `360` | 10 … 1080 deg | Total yaw over the shot. |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | Orbit direction seen from above: cw (clockwise) or ccw. |
| `startHeadingDeg` | number | `0` | -360 … 360 deg | Heading at the start, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `tiltDeg` | number | `0` | -60 … 30 deg | Gimbal pitch (0 = level horizon). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.hyperlapse-orbit` — Hyperlapse orbit

*needs: outdoor only · default 15 s · framing WS · ease linear · capture stepped · tags aerial, orbit, time-lapse*

A slow orbit around the subject while the runtime speeds the sky up `timeRate`× (meta.timeLapse, in game-days per film second like classic.time-lapse). Clouds race and the light sweeps around the landmark.

**When:** Passage of time over a landmark or town: sunset into night, a storm rolling in. Use a static subject; moving NPCs would blur.

**Pilot bounds:** lateral ±3 m · rise 4 m · sink 1.5 m · speed ×0.4–1.2 · distance ×1.35

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `radius` | number | `40` | 2 … 500 m | Orbit radius. |
| `heightAGL` | number | `25` | 1 … 300 m | Orbit height above the subject's base. |
| `revolutions` | number | `0.5` | 0.01 … 10 | Turns completed over the shot. |
| `timeRate` | number | `150` | 1 … 3600 sky-s/s | Sky speed-up: seconds of the live sky clock (one Dereth day = 7620 s) per film second. 1 = real time; 150 ≈ 0.02 game-days (≈ 28 game-minutes) per film second, so the default 15 s shot spans ≈ 7 game-hours; 3600 ≈ 0.47 game-days per second. |
| `direction` | enum | `"cw"` | `"cw"` · `"ccw"` | Orbit direction seen from above: cw (clockwise) or ccw. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `3` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `drone.vertigo-drone` — Vertigo (drone dolly-zoom)

*needs: subject · default 8 s · framing MS · ease sineInOut · capture stepped · tags aerial, zoom, dolly-zoom*

A drone dolly-zoom. The drone flies away from the subject (or toward it, direction 'in') while the fov narrows (or widens) so the subject keeps exactly the same size on screen and the background stretches or compresses behind it. The shot fov applies at the near end: 'out' starts at it and narrows, 'in' starts narrow and widens to it.

**When:** Unease, epiphany or dread: a character realising the scale of what is behind them, a tower looming. Needs open space along the bearing behind the camera.

**Pilot bounds:** lateral ±1.5 m · rise 2 m · sink 0.75 m · speed ×0.5–1.2 · distance ×1.25

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `nearDistance` | number | `0` | 0 … 200 m | Horizontal near distance; 0 = the distance that frames the subject at the shot framing and fov (≥ 3 m). |
| `farDistance` | number | `18` | 2 … 1000 m | Horizontal far distance. |
| `direction` | enum | `"out"` | `"out"` · `"in"` | out = fly away while zooming in (background grows); in = push in while zooming out. |
| `heightAGL` | number | `1.8` | 0.3 … 200 m | Camera height above the subject's base. |
| `minFovDeg` | number | `6` | 1 … 60 deg | Narrowest fov allowed. |
| `maxFovDeg` | number | `110` | 30 … 160 deg | Widest fov allowed. |
| `bearingDeg` | number | `0` | -360 … 360 deg | Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

### FPV (`fpv.*`)

#### `fpv.fpv-dive` — FPV dive

*needs: outdoor only · default 7 s · framing WS · fov 75° · ease linear · capture stepped · tags fpv, dive, 90-degree*

Comes in level over the top of a face (cliff, tower, waterfall, wall), crests the edge and dives down it at diveAngleDeg (−60…−90°), then pulls out in a smooth arc into level flight near the ground. The view is a hard-mounted FPV camera looking along the flight. On the steep part the uptilt shows: the camera looks uptiltDeg·sin²(dive) above the dive line, as on a real FPV quad.

**When:** Adrenaline moments: diving off a tower, down a cliff or a waterfall. The subject or anchor is the base of the face. The dive heads along headingDeg.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.75 m · speed ×0.4–1.15 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `heightStart` | number | `30` | 3 … 500 m | Height of the face top (crest) above its base. |
| `bottomAGL` | number | `2.5` | 0.8 … 50 m | Pull-out height above the base. |
| `diveAngleDeg` | number | `-80` | -90 … -60 deg | Dive line pitch. |
| `approach` | number | `12` | 2 … 200 m | Level run-up before the edge. |
| `standoff` | number | `3` | 0.5 … 50 m | Horizontal distance from the face's base point to the dive line. |
| `exitLength` | number | `25` | 2 … 500 m | Level flight after the pull-out. |
| `pullOutRadius` | number | `8` | 1 … 100 m | Radius of the crest and pull-out arcs. |
| `speed` | number | `16` | 2 … 30 m/s | Nominal cruise speed (the fitted profile keeps the duration exact). |
| `alat` | number | `11` | 1 … 40 m/s² | Lateral (centripetal) acceleration limit in the arcs. |
| `uptiltDeg` | number | `20` | 0 … 45 deg | FPV camera uptilt shown on steep dives. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `1.5` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

#### `fpv.fpv-proximity` — FPV proximity

*needs: — · default 8 s · framing WS · fov 75° · ease linear · capture stepped · tags fpv, proximity, speed*

Hugs a surface at close range: it follows ctx.path (the line of a wall, cliff, tree line or hull) offset `offset` metres away with the surface on `side`, low over the smoothed terrain. It banks into curves and leans toward the surface. Without a path it flies a straight line through the anchor along headingDeg, with the surface along that line.

**When:** Intimate speed: skimming a town wall, a cliff face, a row of trees or a ship's hull. Keep offset ≥ 1 m; the safety layer and the pilot own the last metre.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.75 m · speed ×0.4–1.15 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `offset` | number | `1.5` | 0.5 … 10 m | Distance kept from the surface line. |
| `side` | enum | `"right"` | `"right"` · `"left"` | Side of the camera the surface is on. |
| `heightAGL` | number | `2.5` | 0.8 … 50 m | Height above the smoothed terrain. |
| `speed` | number | `12` | 1 … 30 m/s | Ground speed without a path (speed × duration metres centred on the anchor); with a path the fitted profile sets it. |
| `cornerRadius` | number | `5` | 0 … 100 m | Fillet radius of the path corners. |
| `alat` | number | `10` | 1 … 40 m/s² | Lateral acceleration limit. |
| `lookAhead` | number | `8` | 1 … 100 m | How far ahead the camera looks. |
| `leanDeg` | number | `8` | 0 … 45 deg | Constant bank toward the surface. |
| `maxBankDeg` | number | `40` | 0 … 80 deg | Largest bank into curves. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `ends` | enum | `"cruise"` | `"cruise"` · `"rest"` | cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering. |

#### `fpv.fpv-gap` — FPV gap

*needs: — · default 6 s · framing WS · fov 75° · ease linear · capture stepped · tags fpv, gap, speed*

Threads a gap fast. It approaches at an angle from one side, carves a banked turn onto the gap's axis alignDistance before it, shoots through the exact gap centre along the gap normal and exits straight. The gap comes from gapPos/gapNormal (or ctx.gap). Without a gap it follows ctx.path (filleted); with neither, the gap is heightAGL above the anchor, crossed along headingDeg.

**When:** Through arches, between tree trunks, under bridges, through a window. Use drone.flythrough for the slow, level cinematic version.

**Pilot bounds:** lateral ±0.3 m · rise 0.3 m · sink 0.3 m · speed ×0.4–1.1 · distance ×1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `gapPos` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | World centre of the gap. [0,0,0] = the anchor raised by heightAGL. |
| `gapNormal` | vec3 | `[0, 0, 0]` | `[x, y, z]` AC world m | Direction of travel through the gap; [0,0,0] = no explicit gap (ctx.gap / ctx.path / anchor + headingDeg). |
| `gapWidth` | number | `2.5` | 0.3 … 50 m | Gap width (meta.gap, for the runtime's clearance checks). |
| `gapHeight` | number | `2.5` | 0.3 … 50 m | Gap height (meta.gap). |
| `heightAGL` | number | `2` | 0.5 … 200 m | Gap centre height above the reference ground when the gap comes from the anchor. |
| `approachAngleDeg` | number | `25` | 0 … 80 deg | Angle between the approach leg and the gap axis. |
| `approachFrom` | enum | `"left"` | `"left"` · `"right"` | Side of the gap axis the approach comes from. |
| `approachDistance` | number | `30` | 2 … 500 m | Length of the angled approach leg. |
| `alignDistance` | number | `10` | 1 … 100 m | Straight, aligned run before the gap. |
| `exitDistance` | number | `25` | 1 … 500 m | Straight run after the gap. |
| `cornerRadius` | number | `10` | 0 … 100 m | Fillet radius of the approach turn (and of ctx.path corners). |
| `speed` | number | `16` | 1 … 30 m/s | Nominal cruise speed (the fitted profile keeps the duration exact). |
| `alat` | number | `10` | 1 … 40 m/s² | Lateral acceleration limit. |
| `lookAhead` | number | `6` | 0.5 … 50 m | How far ahead the camera looks. |
| `maxBankDeg` | number | `45` | 0 … 80 deg | Largest bank in the approach turn. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `ends` | enum | `"cruise"` | `"cruise"` · `"rest"` | cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering. |

#### `fpv.fpv-flip` — FPV flip

*needs: — · default 8 s · framing WS · fov 75° · ease linear · capture stepped · tags fpv, flip, trick, 90-degree*

Flies forward (or hovers, speed 0) and performs a full 360° roll or pitch flip mid-shot, popping up by `rise` metres during the flip. The orientation is a quaternion path (base orientation ⊗ axis-angle), so the camera passes through inverted and vertical with no gimbal-angle singularity and no flip artefacts. The default 3 s flip peaks near 190°/s and is readable on film. Shorter flips are allowed: validate the take with a higher angular limit.

**When:** Punctuation on a beat drop, celebration moments and transitions: barrel-roll past a banner or flip over a gate. Roll flips keep the horizon in view longer than pitch flips.

**Pilot bounds:** lateral ±1.5 m · rise 1.5 m · sink 0.75 m · speed ×0.4–1.15 · distance ×1.1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `axis` | enum | `"roll"` | `"roll"` · `"pitch"` | roll = barrel roll about the view axis; pitch = loop about the camera's right axis. |
| `direction` | enum | `"positive"` | `"positive"` · `"negative"` | positive = roll right / pitch up (backflip); negative = roll left / pitch down (front flip). |
| `turns` | number | `1` | 1 … 3 (integer) | Number of full rotations. |
| `flipDuration` | number | `3` | 0.3 … 20 s | Duration of the flip (shortened to 80% of the shot when longer). |
| `flipAt` | number | `0.5` | 0.1 … 0.9 | Centre of the flip as a fraction of the shot. |
| `speed` | number | `6` | 0 … 25 m/s | Forward speed (0 = hover flip). |
| `heightAGL` | number | `6` | 1 … 200 m | Height above the reference ground. |
| `rise` | number | `2` | 0 … 30 m | Pop-up height during the flip. |
| `tiltDeg` | number | `0` | -45 … 30 deg | Base camera pitch. |
| `headingDeg` | number | `0` | -360 … 360 deg | Direction of travel, compass degrees (see relativeToSubject). |
| `relativeToSubject` | boolean | `true` | `true` / `false` | Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east). |
| `minClearance` | number | `2` | 0.7 … 50 m | Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only). |

> **Director note** (hand-written): flown with the automatic `fpv` preset the hard-mounted camera follows the flip exactly. Overridden onto a stabilised-gimbal preset (`pilot.flightPreset` `cinema` / `heavy` / `indoor`, which turn at most 120 / 80 / 90 °/s), the default 3 s roll flip (peak ≈ 190 °/s) makes the image lag the flip by up to ≈ 80° / ≈ 165° / ≈ 140° (measured at 30 fps); it never snaps and catches up afterwards. For a crisp flip on a gimbal preset (`axis` `"roll"` only) set `flipDuration` ≥ ≈ 570·`turns` / maxRateDeg s (≈ 4.8 s cinema, 6.3 s indoor, 7.1 s heavy) AND make the shot at least `flipDuration` / 0.8 long, because the flip is cut to 80% of the shot: heavy needs a shot of ≥ ≈ 9 s (the default 8 s shot caps its flip at 6.4 s, which still lags ≈ 11°); or keep the automatic `fpv` preset. A pitch flip (`axis` `"pitch"`) cannot loop on a gimbal preset at any duration: the gimbal stops at +30° pitch, so the image lags the loop by ≈ 90–180° (still ≈ 107° with a 7 s flip on cinema, ≈ 94° with 12 s) and rolls while it catches up. Fly pitch loops on the `fpv` preset.

#### `fpv.fpv-corridor` — FPV corridor

*needs: — · default 10 s · framing WS · fov 75° · ease linear · capture stepped · tags fpv, indoor, dungeon, corridor, 90-degree*

Flies a dungeon or building route (ctx.indoor.route, e.g. from planIndoorPath, else ctx.path) like an FPV through corridors. Every corner is filleted into an arc (90° turns become quarter circles). A curvature-limited speed profile slows into each turn. The heading looks ahead along the route, so it swings smoothly through the turn, and the craft banks into it. Height stays at the route's height, bounded by indoor floor and ceiling.

**When:** Dungeon and interior fly-throughs: down a hallway, round corners, through doorways into a hall. The route's z should already be at camera height (doorway control points at ≈55% of door height).

**Pilot bounds:** lateral ±0.5 m · rise 0.4 m · sink 0.3 m · speed ×0.3–1.1 · distance ×1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `cornerRadius` | number | `1.5` | 0.2 … 20 m | Fillet radius of the route corners (capped at 45% of the adjacent legs). |
| `speed` | number | `6` | 0.5 … 25 m/s | Nominal straight-line speed (the fitted profile keeps the duration exact). |
| `amax` | number | `4` | 0.5 … 30 m/s² | Nominal acceleration limit along the route. |
| `alat` | number | `3` | 0.5 … 30 m/s² | Lateral acceleration limit in turns (sets turn speed: v ≤ √(alat·r)). |
| `lookAhead` | number | `3` | 0.3 … 30 m | How far ahead along the route the camera looks (leads the turns). |
| `heightOffset` | number | `0` | -3 … 3 m | Added to the route's height. |
| `tiltDeg` | number | `0` | -30 … 30 deg | Pitch added to the look-ahead direction. |
| `bankGain` | number | `1.5` | 0 … 4 | Bank multiplier (0 = level horizon). |
| `maxBankDeg` | number | `35` | 0 … 70 deg | Largest bank into turns. |
| `ends` | enum | `"cruise"` | `"cruise"` · `"rest"` | cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering. |

#### `fpv.fpv-run` — FPV run

*needs: a racing line (`path`, else the indoor route) · default 30 s · framing WS · fov 75° · ease ignored (physics-timed) · capture stepped · tags fpv, run, trick, indoor, dungeon, speed, 90-degree*

A long FPV run along a racing line (ctx.path = `shot.path`, else ctx.indoor.route). The line's corners are filleted (`cornerRadius`) and curvature-smoothed over 0.6·cornerRadius + 0.8 m, then flown as a C² curve. Outdoors it is also lifted `minClearance` above the smoothed terrain. A **speed plan** sets the pace by arc length:
- cruise `speed` on straights; the duration fit scales it, up to `speedMax`, so the run lasts exactly the shot;
- `zones` cap the speed between two arc lengths (absolute caps);
- corners are slowed to v ≤ √(alat·r), and also where the curvature changes fast (a hairpin, a chute);
- punch and brake at `amax`, jerk-smoothed to ≤ 45 m/s³;
- a `dive` builds speed at ≈ g down the steep part of the line.

With `ends: "rest"` the run hovers for `startHoldSec` (idle bob), spools up and punches off, and ends settled; with `"cruise"` it cuts in and out at speed.

The camera is a hard-mounted, up-tilted FPV body:
- the pitch comes from the thrust vector (a punch dips the view, braking flares it, tilt ≤ 60°), plus `uptiltDeg`, mixed with the path's own pitch by `lookAlongPath`;
- the heading looks `lookAhead` m along the line and turns smoothly through vertical shafts;
- the bank is coordinated with the turn;
- seeded throttle bob (`throttleBobM` at `bobHz`, vertical, faded out around tricks), fine wobble (`wobbleDeg`) and prop-wash (`propwashDeg`, when sinking through the craft's own wash and on hard catches) come from the shot seed.

`tricks` are spliced in deterministically with C²-continuous joins (position, velocity and acceleration match the line at both ends) and quaternion-continuous attitude.

**When:** The long FPV piece: racing through a dungeon from its entrance drop to the bottom portal, a canyon or town run with tricks at the big spaces. Give an explicit, offline-verified racing line in `shot.path`, with pass lanes around monsters already baked in. Place tricks only where there is room: a float needs ≥ rise + 1 m of headroom, a loop ≈ 2.1·radius above the line. Slow the tight parts with `zones`. Use `fpv.fpv-corridor` for a short, simple corridor move.

**Pilot bounds:** lateral ±1 m · rise 0.8 m · sink 0.5 m · speed ×0.6–1.1 · distance ×1

| param | type | default | range / values | meaning |
|---|---|---|---|---|
| `speed` | number | `8` | 1 … 25 m/s | Cruise speed on straights (outside zones). The duration fit scales it (up to speedMax) so the run lasts exactly the shot. |
| `speedMax` | number | `16` | 1 … 25 m/s | Highest cruise speed the duration fit may use; a run that still does not fit is time-compressed and reports meta.overspeed. |
| `amax` | number | `9` | 1 … 13 m/s² | Punch / brake acceleration along the line (the speed profile is jerk-smoothed to ≤ 45 m/s³). |
| `alat` | number | `12` | 1 … 14 m/s² | Lateral acceleration limit in turns: v ≤ √(alat·r). |
| `cornerRadius` | number | `2` | 0 … 30 m | Fillet radius of the line's corners (capped at 45% of the adjacent legs); the line is also curvature-smoothed over 0.6·cornerRadius + 0.8 m. |
| `lookAhead` | number | `5` | 0.5 … 40 m | How far along the line the heading (and the path pitch) looks. |
| `uptiltDeg` | number | `25` | 0 … 50 deg | FPV camera uptilt above the body's nose: visible on punches, in dives and floats. |
| `lookAlongPath` | number | `0.55` | 0 … 1 | Camera pitch mix: 0 = pure body attitude + uptilt (thrust-derived), 1 = looks along the path's pitch. |
| `bankGain` | number | `1.2` | 0 … 3 | Bank multiplier on the coordinated-turn roll (0 = level horizon). |
| `maxBankDeg` | number | `60` | 0 … 85 deg | Largest bank into turns (smooth tanh saturation). |
| `throttleBobM` | number | `0.1` | 0 … 0.5 m | Seeded throttle bob amplitude (vertical; faded out around tricks). |
| `bobHz` | number | `1.1` | 0.1 … 4 Hz | Throttle bob rate. |
| `wobbleDeg` | number | `0.4` | 0 … 5 deg | Seeded fine attitude wobble (always on). |
| `propwashDeg` | number | `0.8` | 0 … 8 deg | Prop-wash oscillation amplitude when descending through the craft's own wash and on hard catches. |
| `startHoldSec` | number | `0.8` | 0 … 30 s | Hover at the start before the punch (ends 'rest'; ≈ 0.4 s of spool-up follows it). |
| `ends` | enum | `"rest"` | `"rest"` · `"cruise"` | rest = starts hovering (startHoldSec) and ends settled; cruise = starts and ends at speed (cut in on motion). |
| `minClearance` | number | `1.5` | 0.7 … 50 m | Outdoors only: the line is lifted to stay this high above the smoothed terrain. |
| `zones` | list | `[]` | ≤ 64 items `{s0, s1, speed}` | Speed plan: caps the speed between arc lengths s0 < s1 (m along the line); outside the zones `speed` (fitted) applies. Zones are absolute caps: the duration fit never raises them. |
| `tricks` | list | `[]` | ≤ 32 items `{type, s, …}` | Tricks at arc length `s` (m along the line), per type below. Each lands in meta.tricks with its time window, or is skipped with a reason, and in meta.lockWindows. |

**`tricks[]` by type** (common fields: `type`, `s` — required):

| type | fields (default) | what it does |
|---|---|---|
| `float` | `rise` (2.5 m; optional), `punchAccel` 8, `catchAccel` 12 (m/s², 7.2…13), `hangSec` (optional), `lookDownDeg` 30 | Punch up, cut the throttle, **true free fall** (a = −g exactly), catch back onto the line (net Δz = 0). Every phase ramps at 45 m/s³. Apex = exactly `rise`. With `hangSec` alone the apex is solved for the hang (≈ 0.6 s at 2.5 m, ≈ 1.4 s at ≈ 8 m). The nose tips `lookDownDeg` toward the landing at the apex. Forward motion continues along the line. A low ceiling (`indoor.ceiling`, checked at s and at the apex) lowers the rise. |
| `roll` | `turns` 1, `dir` right\|left, `durationSec` 1.1, `rise` 0.3 m | Barrel roll(s) about the view axis while flying the line, with a small pop-up. Stretched so the peak rate stays ≤ 700°/s. |
| `yaw-spin` | `turns` 1, `dir` right\|left, `durationSec` 1.6 | 360° yaw spin(s) while the craft keeps flying the line (pit tornado). |
| `power-loop` | `radius` 3 m (1.5…15) | Leaves the line into a vertical loop in the travel plane and re-joins it ≈ 1.56·radius further on. It **adds its time**. Flown at √(1.1·g·radius) (5.7 m/s at 3 m) with clothoid curvature ramps; climbs ≈ 2.05·radius. Needs a near-straight, not-steep stretch and headroom. |
| `split-s` | `radius` 2.5 m, `dir` right\|left, `rollSec` 0.5 | Half roll to inverted, then a half loop down: it comes out ≈ 2.05·radius lower heading the other way, and **adds its time**. Only where the line itself comes back that way at that spot (within max(0.75, 0.3·radius) m and ≈ 20°), else skipped with the distance found. |
| `dive` | `pitchDeg` −80 (−90…−30) | Put it at the top of a drop: the nose goes to `pitchDeg` (the camera shows pitchDeg + uptiltDeg) and the speed builds at ≈ g down the steep part after s. The run's corners at the top and bottom of the drop still cap the speed at √(alat·r), so give them a larger radius for a faster drop. |
| `dip` | `depth` 1 m, `durationSec` 1.6 | Skims `depth` below the line (C² bump), lengthened so its jerk stays flyable; shallower when the floor (`indoor.floor` / ground) is close. |

> **Director note** (hand-written):
> - Arc lengths are measured on the smoothed line the technique flies, not on the raw polyline (each 90° fillet of radius r shortens it by ≈ 0.43·r). Compute them with `fpvRunLine(points, params).nearestS([x, y, z])` from `scene3d/film/shots/drone.js` (pure, offline).
> - `meta.tricks[i]` = `{type, s, t0, t1, …}`, or `{skipped: true, reason}` with `t0 = t1 = null`. `meta.lockWindows` = the merged trick windows: the take player freezes the pilot residual and pins speedScale = 1 inside them.
> - `meta.validate = {maxAngularSpeedDeg: 900}`: validateTrajectory honours it by default, because loops and rolls exceed the default 240°/s.
> - `meta.throttleAt(t)` gives |thrust|/g: ≈ 1 hovering, ≈ 0 in free fall, > 1 on punches and catches.
> - Also in meta: `overspeed`, `cruiseSpeed`, `peakSpeed`, `lengthM`, `startHoldSec`.
> - Flown through the `fpv` preset, the synthetic test runs with every trick track within ≈ 0.1 m (`tests/film_fpv_tricks.test.mjs`, `tests/film_shots_fpv_run.test.mjs`).
