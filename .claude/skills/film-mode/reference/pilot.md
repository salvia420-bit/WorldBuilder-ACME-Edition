# The JEV pilot — standing orders, modes, telemetry, cost

Code: `scene3d/film/pilot/` (pure: `sense_words.js`, `scene_state.js`, `questions.js`, `policy_code.js`,
`fingerprint.js`, `mapper.js`, `pilot.js`), the page bridge `scene3d/film/runtime/jev_bridge_page.js`, the Node end
`tools/film/lib/{jev,jev_broker,jev_tasks}.mjs`. Background: `docs/film-mode-2026-10-13/research_jev.md` and
`recon/pilot_design.md`.

## 1. Who decides what

| Layer | Who | Rate | Owns |
|---|---|---|---|
| Director | you (Claude Code) | between takes | the plan, sites, the standing order of every shot, reviews |
| Pilot (System One) | JEV `typesafe/jev-1.13` via OpenRouter `POST /api/alpha/decisions` | ≈ 3–8 decisions/s, only when needed | hold / drift / rise / sink / slow / back off; subject lost?; ignore / fade / reroute / wait for an occluder; framing nudges |
| Reflexes + flight | page code | every frame | trajectory → drone dynamics → pilot residual → **safety clamp (always wins)** → camera |
| Perception | page code | ≈ 10–20 Hz | sphere sweeps, ray fans, particle queries → numbers → bucketed words |

JEV never sees pixels or raw numbers. Each consult sends a **words-only state** and up to five typed questions;
code turns the answers into small bounded offsets around the planned shot.

**The state** (`buildPilotState`): `standing_order`, `shot:{technique, goal}`, `camera:{speed}`,
`obstacles:{far_left, left, ahead, right, far_right, above, below, left_side, right_side, behind}` (each
`"<distance word> <kind>"` or `"clear"`), `free_space:{level_ahead, above_ahead, below_ahead}`,
`nearest:{kind, range, side}`, `path_ahead:{contact_in, blocker}`, `subject:{visibility, unseen_for, in_frame,
size, occluded_by}`, `particles:{on_lens, in_view}`, `limits:{can_rise, can_sink, can_drift_left,
can_drift_right, room_left, room_right, ceiling}`, `current:{maneuver, since}`. `room_left`/`room_right` are the free
space the sensors see beside the camera, never shrunk by the shot; the shot's **pilot bounds** show up only as the
yes/no gates — `can_rise`/`can_sink` (sensed room above/below AND `maxRise`/`maxSink` not yet spent) and
`can_drift_left`/`can_drift_right` (`maxLateral` not yet spent on that side), so even a 0.15 m `maxLateral` can drift.

**The words** (`WORD_BOUNDS`): distance `touching` < 0.75 m · `very close` < 2 · `close` < 4 · `near` < 8 ·
`medium` < 16 · `far` < 40 · `clear`. Time to contact `imminent` < 0.75 s · `soon` < 2 · `later` < 5 · `none`.
Visibility `fully hidden` < 10 % · `mostly hidden` < 40 % · `partly hidden` < 80 % · `clear`. Unseen `not hidden`
· `brief` < 1 s · `a while` < 3 s · `long`. Room `none` < 0.75 m · `little` < 2 · `some` < 4 · `plenty`. Size vs the
intended framing `much too small` < 0.5× · `too small` < 0.8× · `right` ≤ 1.25× · `too large` ≤ 2× ·
`much too large`. Kinds: tree, rock, wall, building, prop, door, creature, player, terrain, particles.

**The questions** (`PILOT_QUESTIONS`, conservative default first — JEV has a first-option bias):

| Id | Type | Options | The rule the criteria spell out |
|---|---|---|---|
| `maneuver` | choice | `hold_path`, `drift_left`, `drift_right`, `rise`, `sink`, `slow_down`, `back_off` | BLOCKED = left/ahead/right or level-ahead is `close` or nearer, or contact `soon`/`imminent`. Rise only when the air above is ≥ 2 distance steps farther and `can_rise` is yes (preferred escape); sink likewise; drift needs that side ≥ `near`, sensed room ≥ `some` and `can_drift_<side>` yes (both open → the roomier sensed side, a tie goes left); boxed in → `slow_down`; `touching` or `imminent` with no escape → `back_off` (unless something is `very close` behind → `slow_down`). |
| `risk` | score (3) | open / tight but manageable / about to hit | from `contact_in` and `nearest.range` |
| `subject_lost` | noul | true / false | lost only when `unseen_for` is `long` (≥ 3 s); partly or mostly hidden is never lost |
| `occluder_action` | choice | `ignore`, `fade`, `reroute`, `wait` | subject HIDDEN (mostly/fully, not brief): **soft** (tree, prop, particles) → fade; **solid** (wall, building, rock, terrain, door) → reroute; **moving** (creature, player) → wait. A `fade` with nothing the runtime can fade (§2, recipe item 3 — e.g. any procedural terrain tree) becomes the reroute bias (take report `faded.fallbackFrames`) |
| `framing` | choice | `keep`, `recenter`, `widen`, `tighten` | near the edge / out of frame → recenter; too large → widen; too small → tighten |

`subject_lost`, `occluder_action` and `framing` are asked only when the shot has a subject.

**Answers → motion** (`mapper.js`): bounded offsets in the path frame — lateral (+ right), vertical (+ up), a
progress-rate `speedScale`, a subject `distanceScale`, small framing yaw/pitch/fov nudges, `fadeIds`, `reroute`.
A committed maneuver is held ≥ 1 s (only risk ≥ 1.6 may switch it), answers below 0.45 confidence decay to neutral,
answers about a scene older than 0.6 s freeze the setpoint (a stale answer can never move the camera), every
channel is rate-limited and clamped to the technique's **pilot bounds** (reference/techniques.md lists them per
technique, e.g. pass-over lateral ±3 m, rise 4 m). Then the **safety clamp** sweeps the camera sphere through every
collision layer, slides along hit normals, keeps 0.7 m above terrain outdoors, clips to cell space indoors and
hides particles on the lens. It always wins.

## 2. Writing standing orders

The validator enforces: a string, one line, no control characters, ≤ 300 characters, ONE sentence (a `.`/`!`/`?`
followed by a space and a capital letter is a sentence break — join clauses with `;` or `,`). Missing → warning, and
the pilot uses "Fly the planned shot smoothly, keep clear of obstacles and keep the subject in frame."

How it is used, honestly: the standing order goes into the state of every consult; the `maneuver` instructions tell
JEV it is "the director's intent for the shot and never overrides" the rules. The code policy ignores it. So the
standing order steers JEV's judgment inside the rules — it cannot make the camera fly closer than the rules or the
safety clamp allow, and it cannot make a wall fadeable (fade is only for soft kinds). Write it in the same vocabulary
the state uses.

Recipe — one sentence that says, in priority order:
1. the move in plain words (the trajectory already flies it: "rise over the rooftops toward the lifestone");
2. distances in metres that line up with the distance words (1, 2, 4, 8 m): "keep 4 m from roofs";
3. what may be **faded** (foliage, branches, banners, smoke, fire, small props) and what must be **avoided**
   (walls, buildings, roofs, rocks, trunks, terrain). What the runtime can really fade: PLACED trees (the
   landblock's static placements, not the terrain's procedural scenery) when the client's VFX catalog marks them
   (trunk-canopy / foliage-pollen); small placed props only at a known size of 2 m or less (barrels, crates; never
   fountains, statues, bridges, or props with no DAT size); entity rigs the sensors name as props; smoke and fire
   particles. Procedural (terrain) trees, bushes and rocks are NEVER faded in v1 — the runtime cannot tell which
   placement a ray hit (SPEC §3.1) — so the camera takes the reroute bias around them by itself; still name foliage
   as fadeable, the pilot's `fade` answer becomes that reroute. Overlapping placed trees, and hits where two
   placements are about equally likely, reroute too. When the client has not loaded its VFX catalog — under
   `?visual=off` unless `?windGeo=on` (which still loads it), or with every client VFX path off (SPEC §1.1) — placed
   trees read as props and fade only when small. A `classic.reveal-from-occluder` shot's own occluder is never faded;
4. what must stay in frame and for how long it may be lost ("never lose the lifestone for more than a second");
5. the preferred escape when blocked ("climb rather than swerve", "slow rather than scrape").

| Shot | Good standing order |
|---|---|
| tree-line drone | "Glide low along the tree line toward the lifestone; keep 2 m from trunks; branches may cross the frame, walls may not; never lose the lifestone for more than a second." |
| rising reveal | "Rise slowly over the rooftops toward the lifestone; keep 3 m from every roof and chimney; never lose the lifestone for more than a second." |
| pass-over | "Pass straight over the meeting hall at 25 m with the gimbal tracking it through vertical; climb rather than swerve if a tree top comes within 5 m." |
| orbit | "Orbit the hall at a steady 30 m; foliage may be faded, never cut through a trunk or roof." |
| dungeon FPV | "Thread the corridor at speed and bank through the turns; walls at least 1 m away; torch smoke may be faded; slow rather than scrape." |
| locked / rack focus | "Hold still and keep the avatar centred; nothing may pass between the lens and the avatar." |
| creature follow (realtime) | "Track the drudge from 6 m at shoulder height; let passing creatures go by rather than swerving; walls and rocks stay 2 m away." |

| Bad | Why |
|---|---|
| "Make it look epic." | no distances, nothing to weigh |
| "Fly fast. Avoid the trees." | two sentences → validation error |
| "Fade the walls if they block the view." | walls are solid: the pilot reroutes, never fades them |
| "Go to 32532, 34567 and turn 45° left." | coordinates and angles are the technique's job (params); JEV only adjusts around the path |
| "Stay 10 m from everything." | impossible in a corridor or a town; ask for what the space allows |
| "Avoid trees, rocks, walls, players, creatures, smoke, fire, roofs…" | a list without priorities; say what matters most |

## 3. Pilot modes (`pilot.mode` in the plan)

| Mode | Who steers | JEV calls | Use for |
|---|---|---|---|
| `jev` (default) | JEV; the code policy on any error, timeout, budget refusal or malformed answer that tick | yes | final takes where judgment near obstacles matters |
| `code` | the deterministic code policy — the same rules and answer shape | none (free, reproducible) | rehearsals, no-key runs, open-sky shots, the baseline |
| `shadow` | the code policy | yes — asked and logged for agreement, never acted on | deciding whether to trust JEV on a shot before a `jev` take |

No key (or no broker) → every mode flies code. `shoot --locked` replays a rehearsal's realised table with no pilot
at all (`pilot.mode: "off"` in the report).

Consults happen only when needed: an obstacle within `consult.withinM` (6 m) — nearest, any forward sector or level
ahead —, contact in < 2 s, the subject unseen ≥ `consult.unseenSec` (1 s) or < 40 % visible, or framing off. With
nothing to decide the answers are neutral (the mapper relaxes back onto the planned shot). An unchanged bucketed
scene (fingerprint) with an answer younger than `reuseSec` (2 s) reuses it.

Stepped takes (the default capture) pause film time and await JEV when a decision is due — deterministic, and slow
(broker limit 4 s × up to 2 retries, the page waits up to 15 s). Realtime takes pipeline (≤ `maxInFlight` 2, ≥ 0.12 s
apart, ≤ `decisionHz` 5); only an answer about a NEWER scene replaces the current one; the page gives up after
1.5 s, the broker after 1.2 s with no retry.

## 4. Telemetry — where and what it means

| File | Rows |
|---|---|
| `reports/<shot>.pilot.jsonl` (`rehearse`, and the auto-rehearsal of `shoot`) | one per pilot tick: `{seq, scene, t, source, fingerprint, answers, latencyMs, costUsd, agreeWithCode, newDecision, consulted, reasons, dispatched, inFlight, status, fallback?}` |
| `reports/<shot>.json` (`shoot`) | `pilot:{mode, decisions, sources:{jev, code, reuse, none}, agreement:{compared, agreed, rate, perQuestion}, consults, errors, fallbacks, costUsd, telemetryRows, telemetryDropped}` + `safety` + `obstruction`; also `issues`, `validation` and `flight` (the prepare-time flight check: preset, vmax, peakSpeed, lengthM, overspeed, limitedBy, minDurationSec, minDurationCheck, dryFlight, …) |
| `reports/<shot>.jev.jsonl`, `<shot>.rehearsal.jev.jsonl` | broker: one row per request (seq, outcome, error kind, question ids, normalised answers, ms, cost, bytes, in-flight) — never the state. One broker serves the whole shoot; `<shot>.jev.jsonl` holds only that shot's requests (its rehearsal plus its attempts: `telemetryMark()` at the shot start, then a dump `{since}` that mark) |
| `reports/jev-client.jsonl` (`shoot`) | client events `jev`, `jev-retry`, `jev-error`, `jev-budget` |
| page | `window.__film.status().pilot` (last take), `window.__film.logs({limit})` |

- `source`: `jev` (a JEV answer in effect) · `code` (code policy: mode `code`/`shadow`, or a JEV failure) · `reuse`
  (unchanged scene) · `none` (no consult needed, or the answer in effect went stale → neutral).
- `reasons`: why the tick consulted — `obstacle-near`, `sector-blocked`, `level-blocked`, `contact-soon`,
  `subject-unseen`, `subject-occluded`, `framing`.
- `seq` = scene sequence of the decision in effect, `scene` = this tick's; `fingerprint` = 8-hex hash of the
  bucketed scene.
- **Agreement**: every JEV answer is compared with the code policy on the same state — choice: same option; score:
  same rounded level; noul: same side of 0.5. `agreement.rate = agreed / compared`, also per question. High overall
  agreement means JEV adds little over the free code policy on this shot; disagreement concentrated on `maneuver` in
  tight spots is where JEV's judgment is doing the work — read those rows (`reasons`, both answers) before trusting it.
- Also read `safety.adjustedFrames` / `layerHits` (the clamp had to push the camera out of geometry — the path or the
  pilot is too close) and `obstruction.minVisibleFrac` / `maxUnseenSec` (how hidden the subject got).

## 5. Cost and budget

- Price: $0.042 per 1M input tokens, output free. A camera pilot at ≈ 5 decisions/s with ≈ 500-token states is
  ≈ $0.30–0.60 per hour of continuous piloting (research estimate); stepped takes consult only when needed.
- Caps on every command that talks to JEV (`boot`, `rehearse`, `shoot`, `scout --pick`, `run`, `jev ping|decide`,
  `doctor --ping`): `--jev-max-usd-per-hour=2` and `--jev-max-calls-per-min=600` (defaults; rolling windows). A
  refused call never touches the network; the pilot flies code that tick and a `jev-budget` event is logged.
- A $0 rehearsal: `pilot.mode: "code"` in the plan (cleanest), or `--jev-max-usd-per-hour=0` on the command.
- What a shoot cost: sum `pilot.costUsd` over `reports/*.json`. `$FILM jev ping` costs ≈ $0.000003.
- The key: `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`), else `~/.config/holtburger-film/openrouter.key` (mode 600; a
  group/other-readable file is refused). The CLI redacts it (`sk-or-…`), scrubs it from every file it writes, and
  exposes JEV to the page only as `window.__filmJev` (Playwright `exposeFunction`) — the key never enters the page.

## 6. Other JEV decisions in the CLI

- `scout --pick` → `pickCandidate`: chooses a scouted candidate; band `act` (confidence ≥ 0.8), `confirm` (≥ 0.5),
  `escalate` (look yourself). The options are the solver's words ("clear view, nearest tree near (5.5 m), subject on
  left third"): visibility and the nearest obstacle's distance word from `WORD_BOUNDS`, metres only as a detail. An
  option whose subject is `fully hidden`/`mostly hidden` or whose nearest obstacle is `touching`/`very close` is
  picked only when every option has that problem.
- `shoot` → `keepOrRetake` after each take (noul; act when max(p, 1−p) ≥ 0.8, confirm ≥ 0.65); without a key a code
  verdict from the same take facts (frames dropped, safety adjustments, subject visibility, pop-in, reveal).
- `$FILM jev decide --state=<file|json> --questions=<file|json> [--dry-run]` — an ad-hoc typed decision. Write
  questions like the pilot's: one judgment per question, conservative option first, criteria with explicit
  boundaries that quote the state's words, words not numbers, and never integer-like option keys (`"0"`, `"12"` —
  JS reorders them and the first-option default is lost). `--dry-run` only validates.
