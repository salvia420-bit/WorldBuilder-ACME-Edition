---
name: film-mode
description: Direct Asheron's Call "film mode" footage in the holtburger web client — turn a pasted script, idea or song (with lyrics) into a filming plan, map lyric imagery and beats to sites in Dereth, then scout, rehearse and shoot JEV-piloted cinematic, drone, flythrough and FPV shots off-screen on the GTX-1070 and assemble the edit with ffmpeg. Use when the user wants AC footage, a music video, a cinematic, a trailer, drone or flythrough shots, a camera move in a dungeon, mentions film mode / ?filmMode / holtburger film, or wants to film or record anything in Dereth.
---

# Film mode — the director's playbook

You are the **director** (System Two) of AC Film Mode in holtburger-web (`?filmMode=on`, default OFF). You run in
Claude Code on the owner's subscription: you plan, choose, judge and review. You never call the Anthropic API, and
no film code does. **JEV** (TypeSafe's System-One typed-decision model on OpenRouter — the ONLY metered API, its
key only in Node) is the camera's **reflexes** during a take: the page measures distances to trees, walls, rocks,
creatures and particle clouds, turns them into bucketed words and asks JEV for bounded maneuvers (hold, drift,
rise, sink, slow, back off; ignore/fade/reroute an occluder; framing nudges) a few times a second. A code safety
clamp runs after JEV and always wins. Your per-shot **standing order** is the one sentence JEV reads with every
decision — write it well (reference/pilot.md).

Everything goes through one Node CLI:

```bash
HB=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
FILM="node $HB/tools/film/film.mjs"
$FILM --help                 # all subcommands; `$FILM <command> --help` for each one's flags
```

- Options are **`--key=value` only**. `--shot s010` (with a space) makes `s010` a positional and `--shot` true.
  Booleans: `--stills`, `--no-rehearse`.
- Exit codes: **0** ok · **1** finding (invalid plan, site not ready, take not kept, check failed) · **2** usage or
  environment. `--json` prints one machine envelope `{ok, command, exitCode, result|error}` on stdout; logs go to
  stderr.
- Projects live in `/mnt/wbterminal2/film-projects/<name>/` (never the system disk).

## Hard rules (read every time)

### Laptop rules — `~/CLAUDE.md`, verbatim

<!-- BEGIN verbatim copy of /home/wbterminal/CLAUDE.md (2026-10-14) -->
# Laptop resource rules — read before running anything heavy

This laptop has 8 GB RAM. On 2026-10-05 it froze for ~20 min and rebooted: four
parallel agents each ran the full JS test gate alongside ACE, serve.py and the
Claude session itself. Follow these rules in every session and copy them into
every agent/subagent prompt.

## One heavy job at a time
- Heavy = wasm-pack / cargo build / cargo test, the full JS gate
  (`node harness/run-js-headless.mjs`), any headless Chrome, dotnet builds.
- Run at most ONE heavy job on the laptop at a time, across this session AND
  all agents. Check `free -m` first: need ≥ 2.5 GB "available".
- Run every heavy job inside the memory cap: `capped-build <cmd>` (cgroup
  `builds`, 3.5 GB hard cap; a runaway is OOM-killed inside the cap instead of
  freezing the box). This includes node test gates, not only Rust builds.
- Kill rust-analyzer before Rust builds: `pgrep -x rust-analyzer | xargs -r kill`.
  (Never `kill $(pgrep -f rust-analyzer)` — it matches its own shell.)
- Never `cargo build/test --workspace` locally.

## Parallel agents
- Parallel agents may read, edit and run TARGETED single tests only
  (`node test_x.mjs`). They must NOT run the full JS gate, cargo, wasm-pack or
  browsers. The orchestrator runs the full gate and builds ONCE, after merging,
  one at a time.
- Put this rule verbatim in every agent prompt.
- Headless Chrome: at most one tab of a real (non-wireframe) world at a time;
  close tabs when done.

## OOM protection (system side, fixed 2026-10-05)
- `/usr/local/sbin/oom-protect.sh --loop` (every 3 s, started @reboot from
  /etc/cron.d/oom-protect) pins infra -1000, claude -900, interactive shells
  -800, desktop -700, and sets every NON-claude descendant of claude (tool
  shells, node, cargo, MCP chrome) to +300 so the workload dies first.
  oom_score_adj is inherited by children — that is why this is needed.
- earlyoom (/etc/default/earlyoom) prefers chrome/node/cargo/rustc; claude is
  no longer in --avoid (its -900 makes it the last resort, not immune).
- Logs: /var/log/earlyoom.log (world-readable), /var/log/kern.log (adm/sudo).
<!-- END verbatim copy of /home/wbterminal/CLAUDE.md -->

For film work this means: `browser check`, `boot`, `status`, `go`, `scout`, `rehearse`, `shoot`, `run` and the
encode in `assemble` hold the shared heavy-job lock (`harness/lib/heavy_lock.mjs`) and wait for ≥ 2.5 GB available,
so never start one next to the JS gate, a build or another film command. Pass `--capped` to `shoot`/`assemble` to
run ffmpeg inside `capped-build`. If you are one of several parallel agents you may only plan (song, sites, plan,
validate, compile, techniques) — never boot or shoot.

### Film-session rules

- **Git:** never push; never commit unless the owner asks; never arm background git automation (cron, hooks,
  loops, schedulers).
- **No browser on the laptop.** Never open, launch or drive one here. The CLI only *attaches* over CDP to the 1070's
  test Chrome through the SSH tunnel; it never launches anything.
- **Shoot only when asked.** Shooting happens ONLY on the 1070's off-screen, MUTED test Chrome, and only in a
  session the owner explicitly requested (memory rule: no agent eye-tests). Planning needs no session.
- **A person uses the 1070.** Never kill or close their Chrome — only the test Chrome matched by its
  `--user-data-dir` (`cdpwb-wls`). No sound may reach them: `boot` refuses unless `--mute-audio` is verified (or you
  pass `--assume-muted` because the launch script has it); never OS-mute the box. The film window stays off-screen
  (`browser check` exits 1 when it is on screen).
- **Film account = `phase4demo`** (owner decision, ACE Admin). The password is a run-time input only: pass it as
  `FILM_PASSWORD=…` in the environment. Avoid `--password=…`: a command-line argument is visible to every local user
  (`ps`, `/proc/<pid>/cmdline`) while the command runs (the CLI never writes it; the heavy-lock record shows
  `--password=[redacted]`). Never write it into a plan, note, doc, log, memory or commit. It is single-login: one
  film tab at a time; after a disconnect wait ~25–65 s ("Account In Use").
- **Teleports take ≈10 s → shoot by location.** `shoot` walks the compiled schedule (one teleport per site, then
  every take at that site, hopping the hidden player to any outdoor shot more than `--hop` = 40 m away so grass and
  nearby server objects are there); never record across a teleport. `scout` and `rehearse` do NOT teleport — `go` there first.
- **JEV costs money.** Caps `--jev-max-usd-per-hour=2` and `--jev-max-calls-per-min=600` are the defaults on every
  command that talks to JEV; `=0` refuses every call before the network (the pilot flies its code policy). For
  rehearsals prefer `pilot.mode: "code"` (free) or `"shadow"` (JEV is asked and its agreement logged, but it never
  steers — costs the same as `jev`). Never print the key or put it in the page, a URL or a file you write.

## The pipeline

Offline (any time):

1. **Intake** — `$FILM project init <name>` → `/mnt/wbterminal2/film-projects/<name>/` with `script.txt`,
   `plan.json` (skeleton), `song/`, `takes/`, `stills/`, `reports/`, `edit/`. Paste the script/lyrics into
   `script.txt`; copy the audio to `song/song.mp3` and lyrics to `song/lyrics.lrc` (LRC best, plain text works).
2. **Song** (music videos) — `$FILM song analyze song/song.mp3 --lyrics=song/lyrics.lrc` → `song/song.json`. Read
   tempo, sections (role, energy, repeats) and which lyric lines fall in which section (reference/music-video.md).
3. **Beat sheet** — one line per section or beat group: feeling, image, site, technique, camera speed. Note it in
   `script.txt` below the paste.
4. **Sites** — `$FILM sites search "<imagery>"` per lyric concept or script scene (`--kind=town,dungeon`,
   `--indoor`/`--no-indoor`, `--near=<ns>,<ew>,<km>`), then `$FILM sites show <id>` for the teleport and landblock.
   The gazetteer must exist (`$FILM sites build` once). Few sites: each costs a ≈10 s teleport + settle.
   Torn between two hits for a lyric? `$FILM jev task site-fit --input='{"line":"…","mood":"…","site":"<id>"}'`
   (JEV, or a free lexical hint without a key — reference/workflow.md "JEV planning helpers").
5. **Plan** — write `plan.json` (reference/plan-format.md): sites, then shots in EDIT order, each with a technique
   (`$FILM techniques [--family=drone]`, reference/techniques.md), a duration in bars/beats/seconds and a standing
   order. A first guess per section: `$FILM jev task family --input='{"role":"chorus","energy":0.8,"bpm":128}'`.
6. **Validate + compile** — `$FILM plan validate plan.json --song=song/song.json` until 0 errors; read every
   warning. `$FILM plan compile plan.json` → `timeline.json` (beat-snapped cuts, handles, the shooting schedule)
   and a wall-clock estimate.

Session (only when the owner asked for one — reference/1070.md):

7. `$FILM doctor` (prints the full three-forward ssh tunnel when CDP is down) → owner/you bring up the tunnel and
   the 1070 test Chrome → `$FILM browser check` → `FILM_PASSWORD=… $FILM boot --assume-muted`. `$FILM status`
   shows the page state any time (the `__film.status()` JSON + camera mode, avatar, canvas) without changing it.
8. `$FILM go <siteId> --timeline=timeline.json` (teleport + readiness gate) before scouting or rehearsing there.
9. **Scout** hero shots: `$FILM scout timeline.json --shot=s010 --stills [--pick]` → Read
   `stills/s010/cand-*.jpg` (+ `metrics.json`) and adjust the plan. A `warning: scout s010: …` (also in
   `metrics.json` `warnings`) means the page could not honour part of the intent, e.g. `intent.light` without a usable
   sun (night, indoors, sky not ready).
10. **Rehearse** risky shots (dungeons, FPV, tree lines, low drone moves): `$FILM rehearse timeline.json
    --shot=s040` → read `reports/s040.rehearsal.json` and `reports/s040.pilot.jsonl` (reference/pilot.md); for a
    drone/fpv shot `flight.tracking.maxGapM` / `endGapM` say how far the flown craft trailed the planned path. When
    it trailed by more than 2 m the CLI prints a `tracking-gap` warning (`warning: shot s040: rehearse issue
    tracking-gap at t=<maxGapT> s: …`), even when there is no `overspeed` issue.
11. **Shoot**: `$FILM shoot timeline.json --site=<id>` (or `--shot=a,b` / `--all`) → `takes/<shot>.mp4` +
    `reports/<shot>.json`. It auto-rehearses fpv/indoor/low drone shots and retakes up to `--retakes=1`; a retake
    that fails keeps the earlier take (`reports/<shot>.json` `failedAttempts`), and an incomplete prewarm only warns.
    `rehearse` and `shoot` print the page's validation / flight-check issues as warnings
    (`warning: shot s040: prepare issue overspeed: … use duration ≥ 6.4 s`), plus a `tracking-gap` warning (stage
    rehearse / shoot, at t = the worst gap) when a flown run trailed the plan by more than 2 m — with or without an
    `overspeed` — and save them as `issues` in `reports/<shot>.rehearsal.json` / `reports/<shot>.json`. They never
    fail or retake a take: fix the plan (duration, ease, path, `pilot.flightPreset`) and recompile rather than retake
    (reference/workflow.md §5). On a live (moving) subject a tracking-gap usually means the subject turned harder
    than the rig can follow: choose a gentler move or film the turn from a static/orbiting position.
12. **Review**: `$FILM contact-sheet takes/s010.mp4` → Read `takes/s010.contact.jpg`. Retake what fails
    (`$FILM shoot timeline.json --shot=s010 --retakes=2`, or fix the plan, recompile, re-shoot that shot).
    `$FILM jev task keep --input=reports/s010.json` re-judges a take the way `shoot` did (exit 1 = RETAKE).
13. **Assemble**: `$FILM assemble timeline.json --edl` → `edit/final.mp4` (+ `edit/final.edl`); contact-sheet it,
    Read it, report to the owner with the paths.
14. **Hand back** (when the owner keeps the tab): `$FILM status --release` → camera back in follow mode, HUD and
    input back, avatar shown (exit 1 if any is not); `$FILM status --own --clean=on --avatar=off` re-owns.

`$FILM run <project-dir>` chains validate → compile → browser check → boot (if needed) → shoot --all → assemble
(+EDL) → contact sheet; use it only when the owner wants the whole shoot in one go. Song files are split by step:
`--song-analysis=<song.json>` (plan validate/compile; default `plan.song.analysis`) and `--song-audio=<audio>`
(assemble; default `timeline.song.file`) — plain `--song` is refused.

## Cinematography rules of thumb

- **Music:** cut on beats, big changes on downbeats/section starts (durations in `bars`/`beats`; `start:{section}`).
  Energy → camera speed (`song.json` section energy). **Intro** = establishing / tilt-reveal / rising-reveal.
  **Verse** = intimate, slower, closer (dolly-in, steadicam, rack-focus, over-the-shoulder). **Pre-chorus** = build
  (push-in, boom-rise, helix). **Chorus** = the biggest moves and reveals (pass-over, orbit-poi, flyover,
  terrain-skim, fpv-dive). **Bridge** = contrast (top-down, a dungeon fpv-corridor, night look, worm's-eye).
  **Outro** = dronie / pull-out-reveal / top-down-rise. Repeated sections (same label) can reuse a site with a new angle.
- **Story:** establish → approach → detail → reaction. Keep the 180° rule (stay on one side of the line between two
  subjects across cuts: same `azimuthRef`/`bearingDeg` side). Motivated movement only — the camera moves because
  something moves or is revealed. Vary framing between consecutive shots (WS → MS → CU, not MS → MS).
- **Shortening a shot never speeds it up:** keep the move's length in `trim: {takeSec, inSec}` and give the shorter
  edit length in `duration` — the take is flown at `takeSec` (every frame as designed) and the edit is the window from
  `inSec` (reference/plan-format.md §5). Use it to tighten an edit or fit the music without touching a verified move.
- **Long FPV runs** (`fpv.fpv-run`, techniques.md): fly an offline-verified racing line (`path`) with speed `zones` and
  tricks (`float` with true free fall, `roll`, `yaw-spin`, `power-loop`, `split-s`, `dive`, `dip`) in tall spaces only;
  `overlay: {props: {style: 'freestyle'}}` shows the props at the top of the frame (boot adds `filmProps=on`);
  `pilot: {mode: 'jev', fade: 'never'}` so monsters are never hidden. A dungeon run needs `site.prime` hops
  (creatures only stream inside the hidden player's PVS). Something that does not fit the music goes in a silent
  `edit.tail` after it (plan-format.md).
- **Drone:** reveal over obstacles (rising-reveal, boom-rise), orbit points of interest at 0.5–1 revolution
  (`revolutions`), pass-over for the 90° gimbal moment, terrain-skim for speed, top-down for pattern and map-like
  graphics. **FPV** for kinetic energy and dungeon corridors (fpv-corridor with an indoor `route`).
- **Drone speed:** the drone presets cap speed (cinema 12 m/s, heavy 7, indoor 4, fpv 25). A path faster than that
  (a long path in a short shot; an orbit, helix, dronie, boomerang, spiral-descent, hyperlapse-orbit or top-down-rise
  shortened below its natural duration; a non-linear `ease` on a path move) gets a page issue `overspeed` with the
  shortest duration that flies it. It also fires for a move within the speed cap that turns or brakes harder than
  the preset can follow (a shortened boomerang or boom-rise): prepare dry-flies every drone/fpv shot through the
  flight model and flags a craft that trails the plan by more than 1 m (`limitedBy: "acceleration"`). Set the shot at
  least that long, shorten or straighten the path, or use `pilot.flightPreset: "fpv"`. The suggested duration is
  verified only when the shot was dry-flown within 1 m at it; otherwise the message calls it an estimate (rehearse
  again after changing it). When it says "a longer duration does not slow this move", lower `params.speed`, use
  `ease: "linear"`, give a shorter path or use the `fpv` preset.
- Moving server-driven subjects (an NPC walking, the avatar as actor with `moveTo`) need `capture: realtime` —
  set `subject.moving: true` or an actor `moveTo`. Tracking/chase techniques catalogued `realtime` default to
  realtime for entity/player subjects (validation warns when such a shot stays stepped); an explicit `capture` wins.
  The camera follows the moving subject live (a player-as-actor shot follows the walking avatar, not its start
  point).

## Standing orders (JEV reads one sentence with every decision)

One sentence, one line, ≤ 300 characters (validated), concrete distances and priorities, naming what may be **faded**
(foliage, branches, banners, particle smoke/fire) and what must be **avoided** (walls, buildings, rocks, trunks,
roofs) — and what must stay in frame. The runtime fades only placed trees and small props, entities and particle
smoke; procedural (terrain) trees and rocks are rerouted around (reference/pilot.md), so frame tree-line shots with
the subject clear of trunks.

- Good: "Glide low along the tree line toward the lifestone; keep 2 m from trunks; branches may cross the frame,
  walls may not; never lose the lifestone for more than a second."
- Bad: "Make it look epic." (no distances, nothing to weigh) · "Fly fast. Avoid trees." (two sentences — rejected).

The standing order frames intent; it never overrides the pilot's rules or the safety clamp (reference/pilot.md).

## Reference — read when you need it

| File | Read when |
|---|---|
| `reference/workflow.md` | Running a project end to end: files produced, exit codes, failure handling, review and retakes, the report to the owner. |
| `reference/plan-format.md` | Writing or fixing `plan.json`: every field, defaults, validation messages, compile rules, a verified example. |
| `reference/techniques.md` | Choosing a technique for a beat; the full catalog of 64 ids with params (grep `#### \`<id>\``). |
| `reference/music-video.md` | Song analysis output, lyric → concept → site search, look presets (time of day, fog, grade, DoF). |
| `reference/pilot.md` | Standing orders, pilot modes jev/code/shadow, telemetry, agreement rate, JEV cost and budget flags. |
| `reference/1070.md` | An owner-requested shooting session: tunnel, test Chrome launch, boot URL, readiness, the eye-test checklist, cleanup. |

Contracts behind all of this: `$HB/scene3d/film/SPEC.md`; developer map: `$HB/scene3d/film/README.md`.
