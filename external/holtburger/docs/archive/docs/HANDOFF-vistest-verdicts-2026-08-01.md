# HANDOFF — 1070 in-person vistest VERDICTS (2026-08-01, evening)

Owner judged the terrain-VFX families and today's fixes AT the 1070 (real GPU,
BC7 arm :8769, `quality=high`, all families force-flagged per
`HANDOFF-1070-vistest-2026-08-01.md` §D). This file records the verdicts, what
shipped because of them, and the open bugs for the next session. Probe
evidence (per-family diag counters + screenshots, real-GPU eyetest1 runs) is
in the laptop session's scratchpad (`probe-*.png`, `p2-*.png`, task outputs
`b0324hfkb` / `bt1ztyizn`).

## 1. SHIPPED from this vistest (all in this commit)

- **ICE PROMOTED** — `TERRAIN_VFX_PROMOTED.ice = true` (quality.js): owner
  verdict "ice effect works". high/ultra light the family per the ladder;
  ultra also lights `terrainIceRefraction` (its tier intent). NOTE the
  refraction sub-effect was judged via `&terrainIceRefraction=on` at high —
  it defaults OFF at high, ON at ultra only.
- **vitalsOrbs DEFAULT-ON** — `isVitalsOrbsActive()` is now `!== "off"`
  (was `=== "on"`). `?vitalsOrbs=off` restores the bars; vitals-hud.js
  exclusion is two-sided through the same reader. Owner verdict: default it.
- **Heat-haze "mirage follows you" FIX** (owner-found bug, live-repro'd,
  verdict after fix: "mirage works") — `_hazeLbs` residency is LRU-driven
  (capacity, NOT distance): after a teleport a volcanic LB stayed cached and
  the min-screen-radius clamp (`hazeMinScreenRadiusUv: 0.02`) pinned a
  full-strength shimmer from ANYWHERE (repro: lbKey 0xC8ED0000 driving haze
  from Holtburg, 10 km out). Fix: `VOLCANO_TUNING.hazeMaxEngageM = 1536`
  hard ceiling in `updateHeatHazeState`. Pinned by H6 ×3 (volcano suite
  150/0).
- **Cloud coverage dead-knob FIX** — coverage is TOP-LEVEL
  `effect.coverage`; `effect.clouds.coverage` is a no-op write (the
  cloud_volume.js 2026-07-06 finding — never swept to the other sites).
  Fixed 4 sites: index.js `?cloudCoverage=` boot knob, index.js
  `__setCloudCoverage`, cloud_overlay.js default 0.3→0.5 bump (was behind an
  always-false guard — DEFAULT CLOUDS HAVE BEEN THINNER THAN DESIGNED since
  it landed), cloud_volume.js `__resetCloudLayers`. Verified live on the
  1070: boot prints `coverage=0.5`, weather-storm sets 0.7,
  `__setCloudCoverage` sticks. NOTE the ownership rule: with `cloudWeather`
  on (default under `?clouds=on`), the WEATHER path re-writes coverage on
  every weather revision — a hand-set value survives only until the next
  DayGroup/storm change; `&cloudWeather=off` for hand-tuning.

## 2. VERDICTS — no ship change

- **SWAMP: "not really impressed"** — stays ship-OFF. Not a bug report; a
  look problem. Next step is a design pass, not promotion: fireflies/midges
  are one emitter per swamp LB (wave-3 known caveat "may read sparse"),
  ground fog competes with the P6 depth-share question. Re-queue after a
  tuning round, don't re-eye-test as-is.
- **Sand, grass, snow, volcano, dirt, rock, olthoi glow: no verdict given**
  ("nothing else noted") — remain ship-OFF, still owed an explicit
  pass/fail. Probe counters say all are mechanically live on the 1070
  (streamers/devils/sparkle, ~5k pebbles, 150 spindrift ribbons, vents +
  crack-glow, 397 dust-haze sprites), so the next eye-test is pure look
  judgement.

## 3. OPEN BUGS for the next session (owner-reported, unfixed)

### 3a. Grass loads inconsistently while running around ("maybe fighting texmerge")
Owner observation at speed: grass presence stutters — patches pop late or
miss while traversing. Suspicion (owner's words): contention with texmerge.
Leads for the investigating agent:
- `terrain_grass.js` scatter rebuild cadence vs the statics-atlas per-layer
  upload path (`TRACK`/synthesis "statics atlas per-layer uploads" landed
  TODAY — grass may be queuing behind atlas uploads on the same frames).
- The scatter pool's rescatter budget while the camera crosses LB
  boundaries at run speed (compare `terrain_rock.js` pebble pool, which the
  probe showed rescattering cleanly: `fullRescatters` / `teleports`
  counters exist on both pools — diff their behavior at run speed).
- Reproduce with `__terrainGrass` pool stats while running Holtburg fields;
  look for `lastScanned`/`rescatters` stalls coinciding with
  `[statics-atlas]` upload logs.

### 3b. Water: long vertical/horizontal white bars
Seen by the owner tonight AND independently noted by a previous vistest
agent — treat as CONFIRMED twice. Long axis-aligned white bars on water.
Not yet root-caused. Leads:
- W1 sheen streaks (wave-1 water: "sheen streaks real?") — the §D open
  question; the bars may BE the sheen mis-projecting (axis-aligned ⇒ UV or
  texel-space artifact, not a world-space streak).
- Storm was ACTIVE during tonight's session (region-driven) — check the
  rain-streak precip mesh vs water interaction (`weather/rain.js` streak
  DID selection) before blaming the water shader: bars may be precip
  streaks scaled wrong over water cells.
- Repro spot: open ocean `@teleloc 0x01AE0001 100 100 6`, daylight
  (`?skytime=accel`), storm on AND off (`__setWeather({is_storm:false})`)
  to separate the two hypotheses.

### 3c. BC7 arm (:8769) entity palettes broken (agent-found, logged tonight)
`[entity-surface-decode] … base-palette 0x04000000 … palette fetch failed …
ManifestR…` spam → entities render grey-fallback on the BC7 arm only.
Missing base-palette payloads in the `holtburger-dist-hires-bc7m` manifest.
Terrain BC7 unaffected. Skews creature/item colour judgements on :8769 —
re-bake or route palette fetches to the base dist before the next colour
pass.

## 4. Vistest logistics that bit tonight (for the next driver)
- eyetest1 (accessLevel 4) is the probe account; phase4demo/smoketest1 are
  the owner's. 25 s single-login linger applies per account.
- The BlueIce shelf teleloc (`0x4AF20025 96 96 46.5`) DROWNED the probe
  char — use `@telepoi Eastwatch` for ice judging (verified land, ice belt).
- `setSkyTimeOverride(t)`'s t→time-of-day mapping is unintuitive (0.5 was
  NIGHT in one session); don't assume 0.5=noon, sweep.
- Volcano field teleloc that works: `@teleloc 0xC8ED0025 96 96 57`.
  Best-dirt LB: `@teleloc 0x0D650025 96 96 78.5`. Desert (owner's spot):
  `@teleloc 0x81670012 64.1 24.5 14.0`.
