# Plan JSON v1 — the format of `plan.json`

Source of truth: `tools/film/plan/schema.mjs` (`PLAN_FIELDS`, `normalizePlan`, `validatePlan`) and
`tools/film/plan/compile.mjs` (Timeline, schedule, Take). This page restates them; when they disagree, the code wins.
Check a plan with `$FILM plan validate plan.json [--song=song/song.json]` (exit 0 = valid; 1 = errors).

Conventions: positions are **AC world metres** `[x east, y north, z up]` (`wx = lbX·192 + localX`); headings are
compass radians (clockwise from north); landblock/cell ids are hex strings like `"0xA9B40019"`; song indices
(`beat`, `bar`, `section`) are **0-based SONG indices**. Shots are listed in **EDIT order**; the compiler makes
the shooting schedule (grouped by site).

## 1. Top level

| Field | Type | Default | Notes |
|---|---|---|---|
| `version` | `1` | 1 | missing → 1 with a warning; anything else → error |
| `title` | string | `""` | names the timeline/EDL and seeds every shot's RNG; missing → warning |
| `kind` | `"music-video"` \| `"story"` \| `"reel"` | null | informational; another value → warning |
| `format.width` / `format.height` | even integer, 16…7680 / 16…4320 | 1920 / 1080 | output and capture size (odd → error: H.264 4:2:0) |
| `format.fps` | integer 1…120 | 30 | film frame rate; EDL timecodes are non-drop at this rate |
| `format.capture` | `"stepped"` \| `"realtime"` | `"stepped"` | default capture mode (stepped = film clock, smooth at any quality; realtime = wall clock, recorded on the fps grid — a frame is held when the page renders slower than fps — and muxed at true speed) |
| `song.file` | path | null | audio for `assemble` (relative to the project dir) |
| `song.analysis` | path | null | `song.json` from `song analyze` (relative to the plan); the CLI loads it for compile |
| `song.offsetSec` | seconds 0…3600 | 0 | song time at edit t = 0 (assembly seeks the audio); for `{bars}`, a value within half a beat of a downbeat counts as on it |
| `defaults.transition` | transition | `"cut"` | transition INTO each shot unless the shot sets one |
| `defaults.pilot` | `{mode, …}` | `{mode: "jev"}` | pilot config merged under every shot's `pilot` |
| `defaults.look` | look | `{}` | plan-wide look (merged under site and shot looks) |
| `defaults.framing` / `defaults.ease` | framing / easing name | null | fallbacks for shots |
| `edit.fadeInSec` / `edit.fadeOutSec` | seconds 0…10 | 0 / 0 | fade from / to black at the very start / end (with `edit.tail`: `fadeOutSec` fades the last MUSIC shot instead, element-local) |
| `edit.tail` | `{from, gapSec?, fadeOutSec?}` or the `from` shot id | absent; `gapSec` 1.5, `fadeOutSec` 3 | a **silent tail** appended after the music (§5): the shots from `from` (never the first shot) to the end; `gapSec` 0…10 of black after the music's fade-out; `fadeOutSec` 0…10 = the program fade-out on the last tail shot. Unknown tail keys are errors; any other `edit` key warns |
| `sites` | array, ≥ 1 | — | each site = one teleport |
| `shots` | array, ≥ 1 | — | in EDIT order |
| `notes`, `script`, `meta` | any | — | accepted, ignored. Any other top-level key → warning ("did you mean") |

## 2. Sites (`sites[]`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | id `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` | **required** | unique; referenced by `shots[].site` |
| `teleport` | `"@…"` admin command | **required** | single line, ≤ 200 chars; `@teleloc`/`@telepoi`/`@tele`/`@teledungeon`/`@teleto` (others warn). Copy `teleport.best` from `sites show`. |
| `anchor` | `[x,y,z]` world metres or `{cell, local:[x,y,z]}` (or `{cell, x, y, z}`) | **required** | site centre: orders the schedule, seeds `ShotContext.anchor` and prewarm. `{cell, local}` is converted to world (and fills `cell`). |
| `cell` | cell id | null (from `anchor.cell`) | dungeons: the EnvCell that seeds the film viewer cell on cuts |
| `indoor` | boolean | from the cell (`(id & 0xFFFF) ≥ 0x100`) | dungeon/interior site; indoor without `cell` → warning |
| `lbKeys` | landblock ids | `[landblock of cell]`, else of the anchor | readiness targets (`world.ready`) |
| `interiorLb` | landblock id \| null | the cell's landblock when indoor | readiness: wait for that landblock's EnvCells |
| `settleSec` | seconds 0…60 | 0 | extra pre-roll before EVERY take here (particles/foliage warm-up) |
| `ready` | `{settleSec 0…120, timeoutSec 1…600}` | `{3, 90}` | the readiness gate after the teleport |
| `prime` | `["@…", …]` ≤ 12 | none | admin commands `film shoot` sends BEFORE the site teleport, each followed by its own readiness gate (`ready` settle/timeout + the `@teleloc` cell). Use it to walk the hidden player down a dungeon so the server streams every creature on the route: ACE only sends the creatures in the player's current cell's visible set (PVS), so a run filmed far from the player shows empty halls. The site `teleport` then stands the player where it should stay (e.g. near the bottom of the run, ≥ 6 m from portals). Each command is checked like `teleport` (`@…`, one line, ≤ 200 chars; a non-teleport verb warns). A refused or not-ready prime only warns; each is an `event: "prime"` row in `reports/shoot-log.jsonl` and the site's take reports get `prime: {sent, ready, failed}`. `estimateShootTime` counts each as a teleport + settle |
| `look` | look | `{}` | applies to every shot at this site |
| `name`, `gazetteerId`, `notes`, `tags` | strings | name = id | informational. Other keys → warning. |

Outdoor anchor sanity warnings: outside the 0…49152 m world square, in a different landblock than its `cell`, or in
landblock 0x0000 (local coordinates pasted as world — use `{cell, local}`); `z` outside −200…2000.

## 3. Shots (`shots[]`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | id (as sites) | **required** | unique; names `takes/<id>.mp4` |
| `site` | site id | **required** | where the take is shot |
| `technique` | `classic.*` \| `drone.*` \| `fpv.*` id | **required** | unknown id → error with "did you mean" (`$FILM techniques`) |
| `duration` | `{sec}` \| `{beats}` \| `{bars}` | **required** | EDIT length (§5). Shorthand: `4`, `"3.5s"`, `"8 beats"`, `"2 bars"` |
| `start` | `{sec}` \| `{beat}` \| `{bar}` \| `{section}` or a number (sec) | null = right after the previous shot | explicit edit position (§5) |
| `params` | object | `{}` | technique params, checked against the registry (unknown name, type, min/max, enum values, vec3) |
| `framing` | `EWS` `WS` `FS` `MWS` `MS` `MCU` `CU` `ECU` | `defaults.framing` | shot size (frame height = k·subject height) |
| `fov` | vertical degrees 5…150 | technique default | |
| `roll` | radians −π…π | null | |
| `ease` | easing name | `defaults.ease` | `linear, sineIn, sineOut, sineInOut, quadIn, quadOut, quadInOut, cubicIn, cubicOut, cubicInOut, quintInOut, expoInOut, smoothstep, smootherstep` |
| `seed` | uint32 | `hashString(title + "\|" + id)` | deterministic shake/noise |
| `bounds` | `{maxLateral?, maxRise?, maxSink?, minSpeedScale?, maxSpeedScale?, maxDistanceScale?}` | null = the technique's `defaultBounds` | override of how far JEV may push this shot (`ShotSpec.bounds`, below) |
| `trim` | `{takeSec, inSec}` | null | fly the move as a take of `takeSec` s (0 < s ≤ 600; the technique builds it at that length) and cut the edit from `inSec` into it — a shorter edit that keeps the move's speed and shows its best stretch (§5) |
| `subject` | §4 or `"player"` | null | what the camera frames |
| `path` | `[[x,y,z], …]` ≥ 2 | null | `ShotContext.path` (canyon-run, flyover routes…); allowed at an indoor site too — an explicit, offline-verified racing line instead of a planned `route` |
| `route` | `{fromCell, toCell}` EnvCell ids | null | indoor route: the page plans a doorway-to-doorway path (`planIndoorPath`) → `ctx.indoor.route`; on an outdoor site → warning |
| `transition` | §6 | `defaults.transition` | INTO this shot |
| `standingOrder` | one sentence, one line, ≤ 300 chars | null | read by JEV every decision; missing → warning; two sentences / newline / control chars / too long → error |
| `goal` | string | null | optional short goal passed to the pilot state (`shot.goal`) |
| `pilot` | `{mode, fade?, …}` | `defaults.pilot` | §7 |
| `overlay` | `{props: {style, opacity?, tint?}}` | null | the page's **lens overlay**: FPV propellers at the top of the frame (hard-mounted, drawn after every post effect, spun from the drone's throttle on the film clock). `style` `"freestyle"` \| `"cinewhoop"` (required), `opacity` 0…1, `tint` `"#rrggbb"`. Reaches the page as `take.overlay` (null when absent) and draws only on a page booted with `?filmProps=on` (`film boot` always adds it). Unknown keys warn |
| `capture` | `{mode}` or `"stepped"`/`"realtime"` | realtime (`auto: true`) when the actor moves, an entity/player subject is `moving`, or the technique's capture hint is `realtime` and the subject is an entity or the player; else `format.capture` | explicit always wins; stepped + moving subject → warning; a realtime-hint technique left stepped on a point subject → warning |
| `actor` | §8 | null | player-as-actor cue (shows the avatar for the take) |
| `look` | look (§9) | `{}` | merged: defaults ← site ← shot |
| `cell` | cell id | site cell when indoor | seed of the film viewer cell for this shot |
| `lyric`, `notes` | strings | null | carried into the timeline (and your review) |
| `family` | derived | from the technique prefix | do not set |

Keys like `section`, `bar`, `beat`, `at`, `startSec` on a shot are ignored with a warning pointing at `start`.

**`bounds`** (passed to the page as `take.spec.bounds`; the registry's `buildShot` applies it): how far the JEV pilot
may push the shot off its planned trajectory. `maxLateral` / `maxRise` / `maxSink` are metres ≥ 0 of offset from the
path; `minSpeedScale` 0…1 and `maxSpeedScale` ≥ 1 limit the progress-rate multiplier; `maxDistanceScale` ≥ 1 keeps the
subject distance within ×[1/s, s]. Set only the keys you want to change (a key set to `null` = technique default):
the missing keys come from the technique's `defaultBounds` (reference/techniques.md), NOT from bounds a technique
computes for itself, so any override replaces those. An unknown key or out-of-range value is an error (the page would
refuse the shot). Tighten for corridors and close passes (`{"maxLateral": 0.3, "maxSink": 0.1}`); loosen only with a
standing order that says where the extra room is.

**Capture hint** (needs the technique registry — `plan validate` / `plan compile` always load it):
`classic.tracking-follow` / `-lead` / `-side`, `drone.chase`, `drone.lead`, `drone.side-track` and
`drone.top-down-track` are catalogued `capture: "realtime"`. Following an entity or the player, such a shot defaults
to realtime (`capture.auto: true`) — no `moving: true` needed. On a point subject it stays stepped with a warning
(a point never moves; follow `{kind:"entity"}` / `{kind:"player"}` or set `capture: "realtime"`). An explicit
`capture` wins silently (stepped on a player who stands still is fine) — except stepped with `moving: true` or an
actor `moveTo`, which still warns.

## 4. Subjects

| Kind | Shape | Resolved in the page as |
|---|---|---|
| point | `{kind:"point", pos:[x,y,z], radius?, height?, heading?}` | a static subject (radius 0.6 m, height 1.8 m by default). Aimed at an object (a Life Stone, statue, brazier), that object is the subject's BODY: never faded as an occluder, and a ray stopped by it sees the subject (take report `subjectBody`) — only while the point's radius ≤ 8 m (a wider point is a place) |
| entity | `{kind:"entity", ref, moving=false, radius?, height?}` — `ref` = guid number, `"0x…"` guid or a name | `query.subject(ref)` at prepare; `moving: true` follows it live every frame (and makes the shot realtime, as does a realtime-hint technique) |
| player | `{kind:"player", moving?}` or `"player"` | the local player (the avatar is shown for the take; a realtime-hint technique makes the shot realtime). `moving` defaults to `true` when the shot's actor walks (`actor.moveTo` / `actor.moves`): the page then follows the avatar live every frame (framing, sensors, take metrics), like a `moving` entity. A realtime take also follows the player live unless `moving: false`. An explicit `moving: false` with a walking actor wins but warns |
| path | `{kind:"path", points:[[x,y,z]…≥ 2]}` | `ctx.path` (not a framing subject: techniques that need a subject reject it) |

`radius`/`height` 0 < x ≤ 500. A technique with `needs.subject` errors without a point/entity/player subject; with
`needs.path` it errors without `path`, a path subject or a `route`.

## 5. Durations, starts and the beat grid (compile)

- `{sec: s}` 0 < s ≤ 600 · `{beats: n}` 0 < n ≤ 2048 · `{bars: n}` 0 < n ≤ 512. Beats/bars need a song analysis at
  compile time (`SONG_REQUIRED` otherwise; `validate` only warns when `plan.song` is missing).
- `start`: `{sec}` (≥ 0), `{beat}`, `{bar}`, `{section}` (non-negative integers, 0-based song indices). Without a
  start a shot follows the previous one.
- With a song, every cut lands on the grid: `{beats}` cuts on the nearest beat; `{bars}` on a downbeat when the shot
  starts on one, or within half a beat of one: it then counts from that downbeat, so an edit 0 a few ms past a
  downbeat (e.g. `song.offsetSec` 15.0 copied from `song analyze` for a downbeat at 14.98 s) still makes
  `{bars: 4}` exactly 4 bars, not 5. A shot that starts more than half a beat before the first downbeat (the pickup:
  the first shot at edit 0 whenever the song's `bars[0]` is later than that, e.g. 0.51 s) counts its bars from that
  downbeat, so the pickup joins it and `{bars: 4}` ends exactly on bar 4. An intro longer than a bar counts from the
  next downbeat of the bar grid extended backwards. The same holds when edit 0 falls more than half a beat inside a
  bar because of `song.offsetSec`: it is counted from the next downbeat. Any other mid-bar start (after a
  `{beats}`/`{sec}` shot, an explicit `{sec}`/`{beat}` start) keeps its length and cuts on the nearest beat; a
  fractional `{bars}` always cuts on the nearest beat.
  `{sec}` snaps to the nearest beat, or to a section start when one lies within ½ bar (the next shot then "starts
  the section"). A `{sec}` length that moves by > 30 % warns. Without a song, seconds are used as written.
- An explicit `start` after the previous shot's end leaves a black gap (warning); before it trims the previous shot
  (warning); at or before the previous shot's START is an error (shots must be in edit order).
- Every take is longer than its edit length: `takeDuration = editDuration + handleIn + handleOut`. Each take is
  preceded by `preRollSec = max(6/fps, 0.25) + site.settleSec` of rendered, never-recorded frames.
- **Trim** (`trim: {takeSec, inSec}`): to shorten a shot WITHOUT speeding up its move, keep the move's length in
  `takeSec` and give the shorter edit length in `duration`; the take is flown at `takeSec` (so every frame matches
  the full-length move) and the edit is the window from `inSec`: `handleIn = inSec`,
  `handleOut = takeSec − inSec − edit`, and `assemble`/the EDL cut that window — plus any dissolve material around
  it — out of the one take. A window that would leave too little head or tail for a dissolve is moved inside the
  take (warning `trim.inSec moved from … to …`); an edit + transition handles longer than `takeSec` is an error
  (`PLAN_INVALID`: shorten the edit — a longer take would slow the move). Validation errors: not an object, an
  unknown key, `takeSec` outside (0, 600], `inSec` < 0 or ≥ `takeSec`, a `{sec}` duration longer than `takeSec` (a warning
  when the plan has a song: the beat grid may still snap the edit inside the take — compile decides).
  The dry build and the page build the trajectory at `takeSec`. The rendered take is `takeSec` long, so shooting
  time follows `takeSec`, not the edit length. The timeline item reports `trim: {takeSec, inSec, requestedInSec}`.
- **Silent tail** (`edit.tail: {from, gapSec = 1.5, fadeOutSec = 3}`): to append footage AFTER the song (an
  epilogue, a long FPV run) without moving a single cut of the music video. The shots before `from` are the MUSIC
  PART and compile exactly as they would without the tail (same items, frames and handles). Then:
  `edit.fadeOutSec` becomes an element-local fade-out on the last music shot (`items[k−1].fadeOut`); `gapSec` of
  black follows (frame-quantised); the tail starts at `musicEnd + gapSec`. Tail shots are **exact seconds** (`snap:
  "none"`, no section; `{beats}`/`{bars}` or a `start` there is an error; a trimmed tail shot's `{sec}` longer than
  its `takeSec` is an error even with a song). A non-cut transition INTO `from` is an element-local fade-in from
  black (`fadewhite`: white), `items[k].fadeIn`, with no handles — the finale's `trim` window never moves.
  Transitions between tail shots are ordinary. The program fade-out is `tail.fadeOutSec` on the last shot. The
  timeline gains `musicEnd: {sec, frame, fadeOutSec}`; the "past the end of the song" warning compares `musicEnd`.
  `assemble` cuts the song at `musicEnd`, fades it there and pads it with silence to the program length
  (`atrim → afade → apad=whole_dur`, `-shortest` kept); the EDL's audio event ends at `musicEnd`. Without
  `edit.tail`, shots after the song are beat-snapped to an imaginary grid, the music fade moves to the program end,
  a fade into them steals the finale's handles, and the picture is cut off where the audio ends — always use the tail.
- The schedule groups shots by site, orders sites greedily by nearest anchor starting with the first site in edit
  order, and keeps edit order inside a site. A site's `prime` commands ride on its schedule entry. Prewarm points = the anchor (+ point/path subjects, `path` and
  `actor.moveTo` outdoors), radius 96 m.

## 6. Transitions (INTO a shot)

`"cut"` · `"dissolve"` (cross-dissolve, ffmpeg xfade `fade`) · `"fade"` (dip to black, `fadeblack`) · `"fadewhite"`
(dip to white) · or `{type, durationSec (0 < d ≤ 5, default 0.5), xfade?}` where `xfade` is one of ffmpeg's xfade
names: `fade fadeblack fadewhite fadegrays dissolve distance wipeleft wiperight wipeup wipedown slideleft slideright
slideup slidedown smoothleft smoothright smoothup smoothdown circlecrop rectcrop circleclose circleopen horzclose
horzopen vertclose vertopen diagbl diagbr diagtl diagtr hlslice hrslice vuslice vdslice pixelize radial hblur
zoomin`. A non-cut transition adds handles (= its duration) to both neighbouring takes and is centred on the cut; on
the first shot it is a fade-in from black/white. Too little room → shortened, or turned into a cut (warning).

## 7. Pilot (`defaults.pilot`, `shots[].pilot`)

`mode`: `"jev"` (JEV steers; code policy on any error), `"code"` (deterministic code policy, no JEV calls),
`"shadow"` (code steers, JEV is asked too and agreement is logged). `mode` and `fade` are validated; these optional
keys pass through to the page pilot (`createPilot`, `createResidualMapper`, the take player):

| Key | Default | Meaning |
|---|---|---|
| `fade` | the pilot's own rules | `"never"`: the pilot may fade nothing in this take (the mapper's `maxFadeIds` = 0 — use it for a monster run: creatures must stay visible); `"auto"`: the default rules (the page never fades creatures, NPCs or players). Any other value is an error |
| `decisionHz` | 5 | max decision rate (realtime takes) |
| `maxInFlight` | 2 | pipelined JEV requests (realtime) |
| `minDispatchSec` | 0.12 | min gap between dispatches |
| `consult` | `{withinM: 6, unseenSec: 1.0, framing: true}` | when to consult: obstacle within `withinM`, subject unseen ≥ `unseenSec`, framing off |
| `reuseSec` | 2.0 | reuse the last answer while the bucketed scene is unchanged and younger than this |
| `commitSec` / `overrideRisk` / `staleSec` / `minConfidence` | 1.0 / 1.6 / 0.6 / 0.45 | mapper: commit window, risk score that may break it, stale-answer age, confidence floor |
| `flightPreset` | auto (`fpv` for fpv, `indoor` indoors, else `cinema`) | drone dynamics for drone/fpv shots: `cinema` (≤ 12 m/s), `heavy` (≤ 7 m/s), `fpv` (≤ 25 m/s, hard-mounted camera), `indoor` (≤ 4 m/s). A path the preset cannot follow gets a page issue `overspeed` (`rehearse` / `shoot` print it) with a `minDurationSec`: set the duration at least that long, shorten or straighten the path, or use `fpv`. Prepare checks the speed against the preset's cap and dry-flies the shot through the flight model, so the issue also fires for a move within the cap that turns or brakes harder than the preset can follow (`limitedBy: "acceleration"`, e.g. a short boomerang or boom-rise); `minDurationSec` is verified only when the shot was dry-flown within 1 m at it, otherwise the message calls it an estimate. It also fires for unprofiled moves (orbit-poi, helix, dronie, boomerang, spiral-descent, hyperlapse-orbit, top-down-rise…) shortened below their natural duration, and for non-linear eases on path moves; when it says a longer duration does not slow the move, lower `params.speed`, use ease `linear`, give a shorter path or use `fpv`. A rehearsal's `flight.tracking.maxGapM` / `endGapM` say how far the craft trailed; above 2 m `rehearse` / `shoot` print a `tracking-gap` warning, which can appear without an `overspeed` (the measured gap of that run: a moving subject or the pilot's speed changes can still leave the craft behind). Overriding an fpv shot onto a stabilised-gimbal preset (`cinema` / `heavy` / `indoor` turn at most 120 / 80 / 90 °/s): the default 3 s `fpv.fpv-flip` peaks near 190 °/s, so the image lags the flip by up to ≈ 80° / ≈ 165° / ≈ 140° (measured at 30 fps) — it never snaps and catches up afterwards; for a crisp flip (`axis` `"roll"` only) set `flipDuration` ≥ ≈ 570·`turns`/maxRateDeg s (≈ 4.8 s cinema, 6.3 s indoor, 7.1 s heavy) with a shot of at least `flipDuration`/0.8 (the flip is cut to 80% of the shot: ≥ ≈ 9 s for heavy), or keep the automatic `fpv`. A pitch flip (`axis` `"pitch"`) cannot loop past the gimbal's +30° pitch stop at any duration: fly it on `fpv` |

## 8. Actor (`shots[].actor`) — the player as actor

`{emote?: "/wave", motion?: string, face?: compass radians, moveTo?: [x,y,z], moves?: boolean, at?: seconds ≥ 0}`.
`moves` defaults to `true` when `moveTo` is set, which makes the shot realtime — and a `{kind:"player"}` subject of
that shot `moving: true`, so the camera follows the walking avatar rather than its start point. An actor (or a
player subject) makes the avatar visible for the take. Emotes must be real soul emotes (the page refuses unknown tokens).

## 9. Look (`defaults.look`, `sites[].look`, `shots[].look`)

| Key | Values |
|---|---|
| `timeOfDay` | 0…1, or `night` 0.0 · `dawn` 0.21 · `morning` 0.33 · `noon` 0.5 · `golden` 0.82 · `dusk` 0.89 |
| `dayGroup` | `{day, year}` non-negative integers (AC weather sky set) |
| `fog` | `none` `white` `red` `blue` `green` `black` (AdminEnvirons fog presets). The first take after a fog change waits ≈ 20 s (≤ 30 s) for the retail fog to roll in before it records; a fog that changes between shots at one site pays that wait on every change, so keep one fog per site where possible. Check `environ.settled` in the take report (`page.environ` in `reports/<shot>.json`) |
| `exposure` | 0 < x ≤ 16 |
| `grade` | `neutral` `warm` `cool` `bleach` `night` |
| `bloom` | number (intensity) or `{intensity, threshold}` — no-op below quality mid |
| `vignette` | number (darkness) or `{darkness, offset}` — no-op below quality high |
| `dof` | `{focusDistance?, focusRange?, bokehScale?, enabled?, target?}` — the `window.__dof` setters' rules: `focusDistance` metres ≥ 0, `focusRange` **> 0** (0 is an error: the seam throws), `bokehScale` ≥ 0, all finite (`null` = leave as is); `enabled` boolean (default true: a `dof` look turns DoF on for that take); `target` null or THREE-world `[x, y, z]` / `{x, y, z}` (an AC point `[x, y, z]` is `[x, z, −y]`; autofocus, overrides `focusDistance`). Needs `?filmDof=on` (the CLI boot always adds it). Seam defaults: focus 10 m, range 5, bokeh 1 |

Each take applies its WHOLE merged look; keys a previous take set and this one omits go back to the boot values.
Unknown look keys warn, and so do unknown `dof` keys (the runtime ignores them) and a `dof.target` whose THREE `y`
(height) is outside −200…2000 m (AC world coordinates pasted).

## 10. Validation in one list

Errors (exit 1): bad `version`; `format` numbers out of range or odd; bad `capture`/`pilot.mode`/`framing`/`ease`;
`song.offsetSec` out of 0…3600; fades out of 0…10; empty `sites`/`shots`; bad or duplicate ids; unknown site
reference; bad teleport (not `@…`, multi-line, > 200 chars); bad anchor/cell/lbKeys/interiorLb; settle/timeout out of
range; malformed technique id or unknown technique; bad params; missing subject/path for a technique that needs one;
an outdoor-only technique at an indoor site, or an indoor technique at an outdoor site without a shot `route` (the
page's build would throw MISSING_CONTEXT after the teleport); bad duration/start; bad subject/path/route; bad `bounds` (unknown key, value out of its range); bad transition/xfade;
bad `trim` (§5); invalid standing order; bad actor fields; bad look values (incl. `dof.focusRange` ≤ 0, a negative
`dof.focusDistance`/`bokehScale`, non-boolean `dof.enabled`, malformed `dof.target`); `edit.tail` not an object, an
unknown tail key, `from` not a shot id / the first shot, `gapSec`/`fadeOutSec` outside 0…10, a `{beats}`/`{bars}`
duration or a `start` on a tail shot; `site.prime` not an array, > 12 commands, a command that is not `@…` / multi-line
/ > 200 chars; `overlay` not an object, `props` not an object, `props.style` not `freestyle`/`cinewhoop`,
`props.opacity` outside 0…1, `props.tint` not `#rrggbb`; `pilot.fade` not `never`/`auto`; a param of a type the
schema does not check itself (a technique's `list`, e.g. zones / tricks) that the registry's own param check rejects
(the error is at `shots[i].params.<name>` with the registry's message).

Warnings (exit 0, read them): missing `version`/`title`; unknown keys anywhere (incl. `look.dof`, `edit`,
`overlay`, `overlay.props`); unusual teleport or prime verb; suspicious outdoor anchor; indoor site without `cell`; an indoor technique on an outdoor site whose shot carries
its own `route`; route on an outdoor site; beats/bars/musical start without `plan.song`; missing standing order; stepped capture for a
moving actor/entity/player; a player subject with `moving: false` whose actor walks; a realtime-hint technique (tracking/chase/lead/side-track/top-down-track) captured stepped
because its subject is a point; a `dof.target` that looks like AC world coordinates; an unused site; a failed
offline dry build.

The **dry build** (on by default in `plan validate`; `--no-dry-build` skips it) builds every `{sec}` shot with the
real technique code against a flat offline context shaped like the page's: subject at its point (entity/player → the
site anchor), `path` / path subject, and `ctx.indoor` = `{route}` for a shot with a `route` — a synthetic 2-leg L
(10 m west of the anchor → the anchor → 10 m north) standing in for the route the page plans — or `{}` at an indoor
site. A failure therefore means the params/duration/context really do not build; it is not expected for indoor
`route` shots (`fpv.fpv-corridor`). Shots in beats/bars are not dry-built (no song grid offline), nor is a shot that
already failed the indoor/outdoor technique check (the page refuses that build the same way).

Compile adds: `SONG_REQUIRED`, `SONG_INVALID`, a start before the edit begins, a start at/before the previous
shot's start, a shot rounding to 0 frames (errors); beat-snap changes, gaps, overlaps/trims, transitions shortened or
turned into cuts, `start.beat`/`start.bar` past the song (extrapolated), the edit — with a tail, the music part —
running past the song's end, fade-out (or music fade-out) shortened (warnings).

## 11. What compile produces (`timeline.json`)

`{version:1, title, kind, fps, width, height, duration, frames, song:{file, analysis, offsetSec, bpm, durationSec},
fadeIn, fadeOut, musicEnd?, items:[…], schedule:[…], warnings, source:{planHash}}`. `musicEnd: {sec, frame,
fadeOutSec}` exists only with `edit.tail` (where the music part ends; `duration`/`frames` include the gap and the
tail). A plan without a tail, prime or overlay compiles to the same timeline as before these existed (plus
`take.overlay: null`).

- `items[]` (edit order): `shotId, siteId, editIn, editOut, editDuration, editInFrame, editOutFrame, takeDuration,
  takeFrames, handleIn, handleOut, transitionIn, [fadeIn | fadeOut: {durationSec, color}, element-local, only on
  the first tail shot / the last music shot], preRollSec, technique, family, captureMode, snap
  (none|beat|bar|section), explicitStart, requested, trim ({takeSec, inSec, requestedInSec} | null), section:{i,
  label, role}, lyric, notes, take`.
- `item.take` is exactly what `window.__film.prepare(take)` receives: `shotId, siteId, technique, family, spec
  (ShotSpec with duration = takeDuration, + `bounds` with the shot's non-null override keys when set), subject, path,
  route, standingOrder, goal, pilot, capture:{mode, fps, width, height} (the mode after the capture-hint default),
  look (merged), actor, cell, indoor, anchor (world), editOffsetSec (= handleIn), preRollSec, showAvatar, overlay
  (the shot's `overlay` or null)`. `pilot.fade` reaches the page inside `pilot`.
- `schedule[]` (shooting order): `siteId, name, teleport, prime? (only when the site has one), anchor, cell, indoor,
  travelM, ready:{lbKeys (uint32), interiorLb, settleSec, timeoutSec}, prewarm:{points, radius}, shots:[ids],
  takeSec`.

## 12. A complete, verified example

Music video, 3 sites, 8 shots — including a dungeon `fpv.fpv-corridor`, a `drone.pass-over` and a
`classic.rack-focus`. Verified 2026-10-14: `$FILM plan validate` → `valid: 0 error(s), 0 warning(s)` (exit 0); with
a 120 BPM beat grid `plan compile` gives 8 shots, 44 s, 1320 frames and the schedule
`holtburg [s010 s030 s080] → glenden [s020 s060 s070] → holtburg-dungeon [s040 s050]`. Coordinates come from
`WorldBuilder/Data/Locations.txt`. The dungeon route cells are illustrative: `prepare` (or a rehearsal) reports the
planned route, so rehearse indoor shots before shooting them.

```json
{
  "version": 1,
  "title": "Ember Road",
  "kind": "music-video",
  "format": { "width": 1920, "height": 1080, "fps": 30, "capture": "stepped" },
  "song": { "file": "song/ember_road.mp3", "analysis": "song/song.json", "offsetSec": 0 },
  "defaults": { "transition": "cut", "pilot": { "mode": "jev" }, "look": { "timeOfDay": "golden", "grade": "warm" } },
  "edit": { "fadeInSec": 1, "fadeOutSec": 2 },
  "sites": [
    {
      "id": "holtburg",
      "name": "Holtburg town square",
      "gazetteerId": "town-holtburg",
      "teleport": "@telepoi Holtburg",
      "anchor": { "cell": "0xA9B40019", "local": [84, 7.1, 94] },
      "settleSec": 1
    },
    {
      "id": "glenden",
      "name": "Glenden Wood",
      "teleport": "@telepoi Glenden Wood",
      "anchor": { "cell": "0xA0A40025", "local": [96.302, 119.847, 59.955] },
      "look": { "timeOfDay": "dusk" }
    },
    {
      "id": "holtburg-dungeon",
      "name": "Holtburg Dungeon",
      "indoor": true,
      "cell": "0x01F60289",
      "teleport": "@teleloc 0x01F60289 96.70 -10.00 0.00 -0.7193 0.0000 0.0000 -0.6947",
      "anchor": { "cell": "0x01F60289", "local": [96.7, -10, 0] },
      "settleSec": 2,
      "ready": { "settleSec": 4, "timeoutSec": 120 },
      "look": { "grade": "cool" }
    }
  ],
  "shots": [
    {
      "id": "s010",
      "site": "holtburg",
      "technique": "drone.tilt-reveal",
      "duration": { "bars": 4 },
      "framing": "EWS",
      "subject": { "kind": "point", "pos": [32532, 34567.1, 96] },
      "params": { "heightAGL": 30, "distance": 80, "startPitchDeg": -85, "endPitchDeg": -8 },
      "standingOrder": "Tilt up from the cobbles to the skyline while easing forward; keep 4 m from every roof and chimney; banners and chimney smoke may be faded.",
      "lyric": "(intro)"
    },
    {
      "id": "s020",
      "site": "glenden",
      "technique": "classic.establishing",
      "duration": { "bars": 2 },
      "transition": "dissolve",
      "subject": { "kind": "point", "pos": [30816.3, 31607.8, 61] },
      "params": { "distance": 60, "heightM": 12, "driftDeg": 8 },
      "standingOrder": "Drift wide and slow past the treeline; branches may cross the frame, trunks never closer than 4 m.",
      "lyric": "the lanterns burn along the ember road"
    },
    {
      "id": "s030",
      "site": "holtburg",
      "technique": "classic.rack-focus",
      "duration": { "beats": 8 },
      "framing": "MCU",
      "subject": { "kind": "player" },
      "actor": { "emote": "/bow", "at": 0.5 },
      "params": { "fromTarget": "foreground", "toTarget": "subject", "at": 0.5, "pullSec": 1.5 },
      "look": { "dof": { "focusRange": 3, "bokehScale": 2 } },
      "standingOrder": "Hold still and keep the avatar centred; nothing may pass between the lens and the avatar; stay 2 m from the well.",
      "lyric": "and I bow to the road that brought me home"
    },
    {
      "id": "s040",
      "site": "holtburg-dungeon",
      "technique": "fpv.fpv-corridor",
      "duration": { "bars": 2 },
      "route": { "fromCell": "0x01F60289", "toCell": "0x01F6027A" },
      "params": { "cornerRadius": 1.2, "speed": 5, "maxBankDeg": 30 },
      "pilot": { "mode": "shadow", "consult": { "withinM": 3 } },
      "standingOrder": "Thread the corridor at speed and bank through the turns; walls at least 1 m away; torch smoke may be faded.",
      "lyric": "down where the old stones sleep"
    },
    {
      "id": "s050",
      "site": "holtburg-dungeon",
      "technique": "classic.pov",
      "duration": { "sec": 3.5 },
      "subject": { "kind": "point", "pos": [288.7, 47222, 1.5] },
      "params": { "advanceM": 3 },
      "standingOrder": "Creep forward at walking pace with the doorway centred; stop short of anything within 1.5 m."
    },
    {
      "id": "s060",
      "site": "glenden",
      "technique": "drone.pass-over",
      "duration": { "bars": 4 },
      "start": { "section": 2 },
      "transition": { "type": "fade", "durationSec": 0.5 },
      "subject": { "kind": "point", "pos": [30816.3, 31607.8, 61] },
      "params": { "heightAGL": 25, "speed": 5, "nadirMode": "yaw-slew", "maxYawRateDeg": 60 },
      "standingOrder": "Pass straight over the meeting hall at 25 m with the gimbal tracking it through vertical; climb rather than swerve if a tree top comes within 5 m.",
      "lyric": "(chorus) carry me over"
    },
    {
      "id": "s070",
      "site": "glenden",
      "technique": "drone.orbit-poi",
      "duration": { "bars": 2 },
      "subject": { "kind": "point", "pos": [30816.3, 31607.8, 61] },
      "params": { "radius": 30, "heightAGL": 15, "revolutions": 0.5, "direction": "ccw" },
      "standingOrder": "Orbit the hall at a steady 30 m; foliage may be faded, never cut through a trunk or roof."
    },
    {
      "id": "s080",
      "site": "holtburg",
      "technique": "drone.dronie",
      "duration": { "bars": 4 },
      "transition": "dissolve",
      "subject": { "kind": "player" },
      "params": { "endDistance": 70, "endHeight": 40 },
      "standingOrder": "Pull back and up away from the avatar in one smooth line; keep 3 m from rooftops and keep the avatar in frame.",
      "lyric": "(outro)"
    }
  ]
}
```

What the compiler did with it (120 BPM grid): `s010` 0–8 s (take 8.5 s: 0.5 s handle for the dissolve into
`s020`), `s050` snapped from 3.5 s to end on the chorus section start at 24 s (`snap: section`), `s060` starts the
chorus (`start:{section:2}`), dungeon takes get 2.25 s pre-roll (0.25 + `settleSec` 2), fades 1 s in / 2 s out.

## 13. Common mistakes

- Landblock-local coordinates pasted as a world anchor → use `{cell, local:[x,y,z]}` (validate warns).
- A dungeon subject/point taken from the outdoor map: dungeon cells sit far outside their landblock square; use the
  cell's world position (`worldFromLocal(cell, local)`), e.g. Holtburg Dungeon `0x01F60289 [96.7 -10 0]` →
  `[288.7, 47222, 0]`.
- Shots out of edit order with explicit starts → compile error.
- Two sentences in a standing order ("Fly low. Avoid trees.") → join with `;`.
- A moving NPC subject without `moving: true` in a technique WITHOUT a realtime hint (e.g. `classic.orbit`) →
  captured stepped, it stutters. (Tracking/chase/lead techniques on an entity/player are realtime automatically.)
- A tracking/chase technique pointed at a `{kind:"point"}` → stepped, warning: a point never moves; follow the entity.
- `look.dof` without a `classic.rack-focus` shot: DoF turns on at a fixed `focusDistance` (default 10 m) — set it.
- `"dof": {"focusRange": 0}` for "razor thin" → error; use a small positive value such as `0.5`.
- `bounds` keys copied from techniques.md prose (`lateral`, `rise`) → error; the keys are `maxLateral`, `maxRise`,
  `maxSink`, `minSpeedScale`, `maxSpeedScale`, `maxDistanceScale`.
- Shots appended after the song WITHOUT `edit.tail` → beat-snapped past the song, the music fade lands on the last
  shot, a fade into them moves the finale's window, and `assemble` truncates the picture at the end of the audio.
  Use `edit.tail` (§5).
- A dungeon run filmed hundreds of metres from the hidden player → the creatures there are never sent (ACE PVS).
  Give the site a `prime` list (§2) and make its `teleport` the place the player should stand during the take.
