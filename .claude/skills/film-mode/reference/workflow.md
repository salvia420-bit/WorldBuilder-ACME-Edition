# Workflow — one film project, end to end

`FILM="node /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/tools/film/film.mjs"`.
Every command below is real (`$FILM <command> --help` prints its flags). Options are `--key=value` only.

## 0. Decide what kind of turn this is

| The owner asked for… | You do |
|---|---|
| a plan, a beat sheet, "what would you shoot" | Offline only: steps 1–6. Never boot or shoot. |
| footage, and said to shoot now (a session) | Steps 1–6, then the session (§3) on the 1070 — reference/1070.md. |
| a retake / a re-cut of an existing project | Read `reports/*.json` and the contact sheets first; §5 and §6. |

`$FILM doctor --offline` checks node ≥ 20, ffmpeg (libx264 + the raw h264 demuxer; libvpx-vp9 optional),
playwright-core, the JEV key setup (no key is fine — the pilot flies its code policy), the gazetteer and ≥ 20 GB
free under the project root, without touching CDP. Without `--offline` it also probes CDP (`http://127.0.0.1:9333`)
and, when nothing answers, prints the full film tunnel (all three forwards — reference/1070.md §3):
`ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75`
(`--host=<user@ip>` or env `FILM_1070_HOST` for another box; `--json` → `result.tunnel`). `--ping` spends one tiny
JEV decision (≈ $0.000003) to prove the key.

## 1. Project layout (`tools/film/lib/project.mjs`)

`$FILM project init <name> [--root=/mnt/wbterminal2/film-projects]` creates the tree and refuses (exit 2,
`PROJECT_EXISTS`) when the directory exists. Names: letters, digits, `_ . -`, ≤ 64 chars.

| Path | Written by | What |
|---|---|---|
| `project.json` | `project init` | `{name, created, version: 1}` |
| `script.txt` | you | the pasted script / lyrics, then your beat sheet |
| `plan.json` | you (skeleton from `project init`) | Plan JSON v1 (reference/plan-format.md) |
| `timeline.json` | `plan compile` | edit times, takes with handles, the shooting schedule |
| `song/` | you + `song analyze` | `song.mp3`, `lyrics.lrc`, `song.json` (SongAnalysis v1) |
| `stills/<shot>/` | `scout` | `cand-<i>.jpg` + `metrics.json` (candidates, intent, and `warnings`: the page's scout warnings, e.g. an `intent.light` ignored without a usable sun, which `scout` also prints as `warning: scout <shot>: …`) |
| `takes/` | `shoot` | raw drain (`<shot>.h264`, `.ivf` or `.frames/`), `<shot>.mp4` (ALWAYS the kept take), `<shot>.retake<k>.mp4`, `<shot>.contact.jpg` |
| `reports/` | `rehearse`, `shoot` | `<shot>.json` (kept take report + verdict; also `issues` — the page's findings `{code, message, t, stages, preset?, vmax?, peakSpeed?, lengthM?, limitedBy?, minDurationSec?, minDurationVerified?, durationHelps?, maxGapM?, endGapM?}` (incl. the CLI's `tracking-gap`; `minDurationVerified` true = dry-flown within 1 m at `minDurationSec`, null = not verified, so a `minDurationSec` is an estimate, false = no duration helps; `maxGapM` on an `overspeed` is the gap DRY-flown at prepare — sampled at 10 Hz, so the run itself can trail further: typically up to ~30 % more, nearly twice as far on a fast fpv dive (0.65 m dry, 1.24 m flown at 60 fps) — and on a `tracking-gap` the gap this run REALLY trailed) —, `validation` `{ok, counts, error?}` and `flight` — the page's flight check `{preset, vmax, peakSpeed, lengthM, overspeed, minDurationSec, …}` or null), `shoot-log.jsonl` (every attempt, failed ones `ok:false`, each with `issues`, plus `stage:"prewarm"` / `"site"` / `"busy"` rows), `<shot>.jev.jsonl` (that shot's broker telemetry only: its rehearsal + attempts), `jev-client.jsonl`, `<shot>.rehearsal.json` (realised table, `issues`, `flight`), `<shot>.pilot.jsonl` (per-tick pilot telemetry), `<shot>.rehearsal.jev.jsonl` |
| `edit/` | `assemble`, `contact-sheet` | `final.mp4`, `final.edl` (CMX3600), `final.contact.jpg` |

## 2. Intake → plan (offline)

1. **Read the brief.** Story: list scenes → beats (establish, approach, detail, reaction). Music video: get the
   audio + lyrics into `song/`, then `$FILM song analyze song/song.mp3 --lyrics=song/lyrics.lrc`
   (writes `song/song.json` next to the audio; `--out=` to change). Read the printed section table
   (reference/music-video.md).
2. **Beat sheet** (append to `script.txt`), one line per section / beat group:
   `#2 chorus (bars 12–19, energy 0.81) "carry me over" → wide, fast, over the meeting hall → glenden ·
   drone.pass-over · 4 bars`.
3. **Sites.** `$FILM sites search "<imagery words>"` per concept (results show score, id, kind, map position, why,
   and the lexicon's suggested look + techniques), then `$FILM sites show <id>` (paragraph, words, the `go` line and
   the readiness landblocks). If the gazetteer is missing (exit 2 "run `film sites build` first") build it once with
   `$FILM sites build` (`--spawns` adds life stones, portals, statues, shrines…). Group shots so each site is
   visited once; every site costs ≈ 12 s teleport + 5 s settle in the estimate, plus prewarm.
4. **Write `plan.json`** in EDIT order (reference/plan-format.md). Copy each site's `teleport` from
   `sites show` (`teleport.best`) and its anchor as `{cell, local}` from the gazetteer row. Every shot gets a
   standing order (reference/pilot.md).
5. **Validate** until clean: `$FILM plan validate plan.json --song=song/song.json`. Without `--song` it validates
   only; with it, it also compiles in memory and prints the shoot-time estimate. Each issue prints as
   `path: message` (e.g. `shots[3].params.radius: radius = 900 is above the maximum 500`). Fix every error; read
   every warning (a missing standing order, a moving subject captured stepped and an unused site are warnings).
   `--no-dry-build` skips the offline trial build of each `{sec}` shot.
6. **Compile:** `$FILM plan compile plan.json` (song = `--song`, else `plan.song.analysis` relative to the plan)
   → `timeline.json` next to the plan. It prints the shot count, duration, frames, the schedule
   (`holtburg [s010 s030 s080] → glenden [s020 s060 s070] → holtburg-dungeon [s040 s050]`) and an estimate
   (`≈ 4 min 22 s wall-clock: 3 teleport(s) × (12 s + 5 s settle), 8 take(s) / 1684 frames (8 stepped at 8 fps, 0
   realtime)` — rehearsals, retakes, muxing and boot are not included). Read its warnings (beat-snap changes, gaps,
   trimmed shots, a transition turned into a cut).

Stop here unless the owner asked for a shooting session.

### JEV planning helpers — `$FILM jev task <pick|keep|site-fit|family> --input=<file|json>`

Four fast, bounded judgements (`tools/film/lib/jev_tasks.mjs`) you can ask instead of deliberating yourself. With a
JEV key the real client decides (≈ $0.000003 each, under the usual `--jev-max-usd-per-hour` /
`--jev-max-calls-per-min` caps); with no key, or with `--code`, the deterministic code verdict answers for free
(`source: 'code'`). The code verdict always comes back as `result.code` so you can compare; a JEV failure other
than config/auth falls back to it with a warning (`result.jevError`). Every answer carries a band: `act` (go),
`confirm` (glance first), `escalate` (decide yourself).

| Task | `--input` (a JSON object, inline or a file) | Answer |
|---|---|---|
| `site-fit` | `{"line": "lanterns over the hill", "mood": "warm", "site": "holtburg"}` — `site` is a gazetteer id/name (`--gazetteer=`) or `{name, kind?, words?}` | `fit: level 0–4 (no … perfect fit)`; without a key only a lexical hint (always `escalate`) |
| `family` | `{"role": "chorus", "energy": 0.81, "bpm": 128, "lyric": "carry me over"}` (or `energyWord` / `tempoWord`) — numbers from `song.json` | a technique family (`static-slow`, `tracking`, `orbit`, `drone-reveal`, `fpv-kinetic`, `top-down`) + its technique ids |
| `pick` | `{"intent": {"framing": "MS", "angle": "eye"}, "candidates": [{"id": "a", "words": "…"}, …]}` best first, or a scout `stills/<shot>/metrics.json` as is (worded exactly as `scout --pick` words it) | the chosen candidate id (no key: the first) |
| `keep` | a take report — `reports/<shot>.json` (judged exactly as `shoot` judges) or the facts `{frames, droppedFrames, safetyAdjustedFrames, subjectMinVisibleFrac, subjectMaxUnseenSec, popInEvents, reveal}` | `keep` or `RETAKE` (exit 1) with the retake triggers and borderline facts. A saved report also passes its `issues` / `flight` (via `judgeInput`), but the verdict words and criteria ignore them: a plan problem is not fixed by a retake |

Use `site-fit` to break a tie between two `sites search` hits for a lyric, `family` for a first technique guess
per section (then pick the technique yourself from reference/techniques.md), `keep` to re-judge a take after you
read its contact sheet. Bad input exits 2 before any API call.

## 3. The session (owner-requested, on the 1070 — setup in reference/1070.md)

1. `$FILM browser check` — pages, the film page, mute, window position, GPU. Exit 1 = Chrome without
   `--mute-audio` or the film window on screen: fix before anything else.
2. `FILM_PASSWORD=… $FILM boot --assume-muted` (1920×1080, `quality=high` by default; `--width`/`--height` must
   be even; `--reuse` adopts an open film tab). Pass the password through `FILM_PASSWORD`, not `--password=…`: a
   command-line argument is visible to every local user (`ps`, `/proc/<pid>/cmdline`) while the command runs.
   It opens the film URL, installs the JEV broker, waits for in-world + ready + scene-ready + `liveScene3d` +
   `__film`, mutes the page, then `clean(true)` · `own()` · `world.avatar(false)` · `@cloak on` · `@attackable off`.
   Allow up to `--boot-timeout=180` s (`liveScene3d` alone arrives ≈ 35 s after in-world).
   `$FILM status` prints `__film.status()` plus a probe (camera mode, avatar film-hidden or not, canvas size) —
   use it whenever you want to see the page's state without changing it (it holds the heavy lock like every
   Chrome-driving command, never navigates).
3. Per site, in schedule order:
   - `$FILM go <siteId> --timeline=timeline.json` → e.g. "ready after 11.8 s (portal 4.6 s) at 42.1N, 33.6E" + the
     readiness checks (exit 1 "NOT READY" → read the checks; raise `sites[].ready.timeoutSec` / `settleSec`).
   - Optional `$FILM scout timeline.json --shot=<id> --stills [--count=8] [--pick]` → Read the stills. `--pick`
     asks JEV (or the code fallback) to choose a candidate and prints a band: `act` (go), `confirm` (glance at the
     still first), `escalate` (you decide from the stills).
   - Optional `$FILM rehearse timeline.json --shot=<id> [--fps=8]` for anything risky.
   - `$FILM shoot timeline.json --site=<siteId>` (it teleports as the first step of the site even when you are
     already there — another ≈ 10 s — then shoots every take of the site).
4. Or the whole schedule: `$FILM shoot timeline.json --all`.
5. End of session: `$FILM status --release` hands the client back (`__film.release()` → `clean(false)` →
   `world.avatar(true)`, then checks follow mode, HUD/input and avatar are restored; exit 1 if not, `FILM_BUSY`
   while a take, prepare, shoot, rehearse or scout runs). `$FILM status --own --clean=on --avatar=off` re-owns the camera with the frame `boot` leaves.

`$FILM run <project-dir>` does validate → compile → browser check → boot (if needed) → shoot --all → assemble
(+ EDL) → contact sheet in one go, only when the owner wants the whole shoot at once. Its song flags are split
because the steps read different files: `--song-analysis=<song.json>` goes to plan validate/compile (default
`plan.song.analysis`), `--song-audio=<audio>` goes to assemble (default `timeline.song.file`); relative paths resolve
against the cwd, else the project; a missing file exits 2; plain `--song` is refused (exit 2).

What `shoot` does (`tools/film/lib/shoot.mjs`) — per site: (a take still running on the page is aborted first —
`shoot` never teleports under a running take) → teleport → readiness gate → prewarm (collision, heightmap corridor,
statics/buildings/EnvCells around the anchor and the subjects) → per shot, a HOP when the shot's camera path is more
than `--hop` metres (default 40; `--hop=0` = never) from the hidden player: grass is drawn only around the player
(dense to 48 m) and the server only sends the objects near it (NPCs, Life Stones, portals), so `shoot` moves it
with `@teleloc` to the camera path's centre (built offline from the plan) and runs the readiness gate again — between
takes, never for actor / visible-avatar or indoor shots; a hop costs ≈ 15–20 s, a failed one only warns
(`event:"hop"` in `shoot-log.jsonl`, `hop` in the shot's report). Prewarm is best-effort: an incomplete one prints
`prewarm incomplete … missing terrain: 0x…; shooting anyway`, adds a `stage:"prewarm"` row to `shoot-log.jsonl` and
a `prewarm` note to the site's take reports — expect pop-in there and check the contact sheet. A site whose teleport
or readiness check throws becomes a failure for its shots (stage `site`) and the next site still runs. Per shot and
attempt: `prepare(take)` → first attempt only, a stepped rehearsal when needed (`--rehearse` always, `--no-rehearse`
never; default auto = fpv shots, indoor sites, and drone canyon-run, flythrough, terrain-skim, fly-by, chase, lead,
side-track, pass-over) → `shoot` while draining the WebCodecs recorder → ffmpeg mux to `takes/<shot>.mp4` → take
report → `keepOrRetake` (JEV noul, or the code verdict without a key) → retake while the verdict is not
keep + `act`, up to `--retakes` (default 1, max 5). The kept attempt becomes `takes/<shot>.mp4` and
`reports/<shot>.json`. When a take fails inside the page (a drain or disk error, an evaluate timeout) the CLI calls
`__film.abort()` and waits (≈ 90 s at most) until `__film.status()` is idle before the next shot, re-sending
`__film.abort()` on every status poll that still finds the page busy (at most 30: an abort that lands before the
page's take has started is lost); if the page never goes idle, nothing more is sent to it and every remaining shot
fails at stage `busy`. A retake that fails keeps the attempt already recorded (`reports/<shot>.json` lists it under
`failedAttempts`); only a failed first attempt fails the shot. The page's validation / flight-check issues (prepare,
rehearsal, take report — e.g. `overspeed` with the shortest feasible duration — plus the CLI's own `tracking-gap`
when a flown rehearsal or take trailed its planned path by more than 2 m) print once per shot (a `tracking-gap` once
per run with a different gap) as
`warning: shot <id>: <stages> issue <code>[ at t=… s]: …` and are recorded (`issues` in `reports/<shot>.json`, every
`shoot-log.jsonl` row and `<shot>.rehearsal.json`); they never fail or retake a take. Exit 1 when a site is not ready
or fails, or a shot has no kept take.

Useful `shoot` flags: `--shot=s010,s040` (subset, still grouped by site), `--hop=40` (in-site hop distance, 0 = off),
`--codec=avc|vp9|frames` (the page may
fall back avc → vp9 → JPEG frames; the sink follows), `--bitrate=40000000`, `--locked` (replay the rehearsal's
realised table with no pilot — a bit-identical path), `--rehearse-fps=8`, `--capped` (ffmpeg under
`capped-build`). JEV broker limits are set per take: realtime `{timeoutMs: 1200, maxRetries: 0}`, stepped
`{timeoutMs: 4000, maxRetries: 2}`; a rehearsal is always stepped, so it always runs with the stepped limits (also
when it follows a realtime take). JPEG-frames and VP9→mp4 takes are re-encoded with an even top-left crop
(libx264 4:2:0 needs even dimensions), so an odd window-sized canvas still muxes.

## 4. Review every take

`$FILM contact-sheet takes/<shot>.mp4` → `takes/<shot>.contact.jpg` (4×4 grid, 1920 wide; `--cols`, `--rows`,
`--width`, `--out`, `--frames=N` when ffprobe is missing). Read the JPEG. Look for:

- HUD remnants (toolbar, chat, radar, selection brackets, speech bubbles, cursor), a visible avatar when it should be
  hidden, a black or frozen frame, pop-in in the first frames;
- clipping into walls/roofs/trees, particles smeared on the lens, the horizon tilting when it should not;
- the subject in frame with sensible headroom; a reveal that actually reveals; a rack focus that visibly pulls.

Then read `reports/<shot>.json`: `frames` vs `plannedFrames` (`overrunFrames`), `droppedFrames`,
`safety.adjustedFrames` and `safety.layerHits` (how often the clamp had to push the camera out of geometry),
`obstruction.minVisibleFrac` / `maxUnseenSec`, `popInEvents`, `pilot.sources` / `pilot.agreement.rate` /
`pilot.costUsd`, `dof` (used, writes, enabled), `verdict` and `attempts`. Also `issues` / `flight` / `validation`
(the page's findings about the plan: an `overspeed` issue means the flown drone camera cannot follow the planned
path — too fast, or turning / braking harder than the preset can; a `tracking-gap` issue means it really trailed the
plan by more than 2 m in this run — §5), and in the page report (`page`): `flight.tracking.maxGapM` / `endGapM` (how
far the craft trailed the plan), `liveSubject` (a moving subject: `maxOffsetM` from the reference track, `maxLagM` of the follower), `faded`
(what the pilot faded; `fallbackFrames` = fades that hid nothing and rerouted) and, when a fog look was used,
`environ` — `settled` (the AdminEnvirons fog finished rolling in before recording), `timedOut` (still rolling in
after 30 s: the fog thickens during the take) or `stalled`.

## 5. Fixes and retakes

| Symptom | Fix |
|---|---|
| Subject hidden behind a solid occluder | Change the angle (`azimuthDeg`/`bearingDeg`, `elevationDeg`, `heightAGL`, `distance`), or scout and translate the chosen candidate's bearing/distance/height into the params. |
| Foliage/smoke in front of the subject | Say in the standing order that it may be faded; the pilot fades soft occluders when the subject is mostly hidden. PLACED trees (the landblock's static placements) fade when the client's VFX catalog marks them (trunk-canopy / foliage-pollen); small placed props fade only at a known size of 2 m or less (barrels, crates; never fountains, statues, bridges, or props with no DAT size); entity rigs read as props and smoke / fire particles fade. Procedural (terrain) trees, bushes and rocks never fade in v1 (the runtime cannot tell which placement a ray hit, SPEC §3.1): the camera takes the reroute bias around them by itself, and the take report counts it in `faded.fallbackFrames`. Overlapping placed trees and hits where two placements are about equally likely reroute too. When the client has not loaded its VFX catalog — under `?visual=off` unless `?windGeo=on` (which still loads it), or with every client VFX path off (SPEC §1.1) — placed trees read as props and fade only when small. A `classic.reveal-from-occluder` shot's own occluder is never faded. If it still blocks: change the angle (row above). |
| `shot <id>: … issue overspeed` warning | The drone preset cannot fly the path: it is faster than the preset's top speed (`limitedBy` `'speed'`), or it is within that speed but turns or brakes harder than the preset can follow, so the prepare-time dry flight trailed by more than 1 m (`limitedBy` `'acceleration'`: a shortened boomerang or boom-rise). Set the shot duration ≥ the printed minimum (`minDurationSec`; verified only when dry-flown within 1 m there — a message that calls it "an estimate" was not, so rehearse again after changing it), shorten or straighten the path, or use `pilot.flightPreset` `'fpv'`; a retake will NOT fix it (same plan). When it says a longer duration does not slow this move, lower `params.speed`, use `ease: "linear"` or give a shorter path. |
| `shot <id>: … issue tracking-gap` warning | The flown camera really trailed its planned path by more than 2 m in that rehearsal or take (`maxGapM` / `endGapM`; t = the worst moment), with or without an `overspeed` issue: the shot is framed off the plan. Lengthen the shot, use `ease: "linear"`, shorten or straighten the path, or use `pilot.flightPreset` `'fpv'` (when it says a longer duration will not help, lower `params.speed` instead). When it says the craft followed a live subject (a flown chase / lead / side-track), the subject's turn is the cause: give it a gentler move — a slower or wider turn, no U-turn — or use `cinema` rather than `heavy` (techniques.md §1 Turning subjects). A retake will NOT fix it (same plan). |
| Many safety adjustments, a grazing feel | More clearance (`minClearance`, `heightAGL`, `offset`), lower `speed`; rehearse and read the pilot reasons. |
| Pop-in at the start | Raise `sites[].settleSec` (extra pre-roll per take) or `sites[].ready.settleSec`. |
| Fog thickening during a take; slow takes after a fog change | The first take after a `look.fog` change waits ≈ 20 s (≤ 30 s) for the retail fog to roll in before recording; read `page.environ` in `reports/<shot>.json` (`settled`, `timedOut`, `stalled`). Keep one fog per site where possible: a fog that changes between shots at a site pays the wait on every change. |
| `go`/`shoot` NOT READY | Read the readiness checks; raise `ready.timeoutSec`; check `lbKeys` / `interiorLb` / `cell` of the site (`film sites show <id>` prints them; a destination EnvCell always gets the interior gate, whatever the site's kind or map position). |
| `FAILED <shot> at busy` | The page did not go idle after `__film.abort()` (a take may still be recording): `$FILM status` (busy, take), `browser check`; once idle, re-shoot the skipped shots with `--shot=…`. |
| `prewarm incomplete` warning | Shot anyway; check that site's contact sheets for pop-in, raise `sites[].settleSec` or re-shoot it. |
| Moving NPC/avatar stutters | The shot needs `capture: "realtime"` (`subject.moving: true`, an actor `moveTo`, or explicit `capture`). |
| JEV dithers or disagrees with code a lot | Tighten the standing order; rehearse in `shadow` and read `pilot.agreement`; fly `code` if it does not improve. |
| Dungeon route errors (`FILM_NO_ROUTE_GRAPH`, empty rooms) | Check `route.fromCell`/`toCell` are EnvCells of the site's landblock and `sites[].cell` seeds the viewer cell. |

Retake one shot: `$FILM shoot timeline.json --shot=s040 --retakes=2`. After editing the plan, recompile, then
re-shoot only the changed shots — `assemble` reads whatever takes exist.

## 6. Assemble and deliver

`$FILM assemble timeline.json --edl` → `edit/final.mp4` (+ `edit/final.edl`). Takes come from `reports/<shot>.json`
(`file`, `fps`, `frames`) or `takes/<shot>.mp4`; the song from `--song=<audio>`, else `timeline.song.file` resolved
against the project (missing → no audio, with a warning). `--missing=black` fills absent takes with black
(preview cuts); `--dry-run` prints the ffmpeg command; `--no-audio`; `--crf=16`; `--out=`. Then
`$FILM contact-sheet edit/final.mp4`, Read it, and report to the owner: the final path, duration, the shot list
with kept attempts and verdicts, total JEV cost (sum of `pilot.costUsd` over the reports), and anything you would
reshoot.

## 7. Exit codes and error codes you will meet

| Code (exit) | Meaning → action |
|---|---|
| `CDP_UNREACHABLE` (2) | No Chrome at `--cdp` (default `http://127.0.0.1:9333`) → tunnel / test Chrome down (reference/1070.md). |
| `NOT_MUTED` (2) / `MUTE_UNVERIFIED` (2) | Chrome lacks `--mute-audio` → relaunch it; unverifiable (no `--enable-automation`) → `--assume-muted` if the launch script has it. |
| `FILM_PAGE_OPEN` (2) | A film tab exists → `--reuse` (single-login account) or close that tab. |
| `NO_PASSWORD` (2) | Set `FILM_PASSWORD` (preferred: `--password=…` is visible in `ps` / `/proc/<pid>/cmdline` while the command runs; the CLI never writes it, the heavy-lock record gets `--password=[redacted]`). |
| `ACCOUNT_IN_USE` (1) | Wait ~25–65 s and boot again. |
| `BOOT_FAILED` (1), `NAVIGATION_FAILED` (2) | Read the printed gate checks; `browser check`; boot again. |
| `EVAL_TIMEOUT` / `EVAL_FAILED` (1) | The page did not answer → `browser check`; the test Chrome may have died (relaunch). |
| `HEAVY_LOCK` (2) | Another heavy job holds the machine lock or memory stayed < 2.5 GB → wait. |
| `PLAN_INVALID` (1), `SONG_REQUIRED` (1), `SONG_INVALID` (1) | Fix the plan / pass `--song` (`--song-analysis` for `run`) / re-run `song analyze`. |
| `NO_SITE`, `NO_TELEPORT` (1) | Site id not in the gazetteer → `sites search`. |
| `FFMPEG_MISSING` (2), `DECODE_FAILED` (1) | ffmpeg at `--ffmpeg`, `FILM_FFMPEG` or `/home/wbterminal/bin/ffmpeg`. |
| page `FILM_BUSY` | Another long page operation (prepare/rehearse/shoot/scout) is running. While a take, prepare, shoot, rehearse or scout runs the page also refuses `world.teleport` / `world.command` (so `go` cannot teleport) and `pose` / `status --release`: `__film.abort()` (shoot does it for you) and wait for `__film.status().active === false` (`$FILM status`). |
| `jev task keep` exit 1 | The verdict is RETAKE (read the retake triggers it prints). |
| page `FILM_SUBJECT_NOT_FOUND` | The entity/player subject is not streamed in → `go` closer, check the `ref`. |
| page `FILM_NO_CANDIDATES` | `scout` found no legal camera position → another angle/framing. |
| page `FILM_NO_ROUTE_GRAPH` | No EnvCell graph for the route (stale wasm pkg or wrong cells). |
