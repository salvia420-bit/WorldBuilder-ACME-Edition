# RynthSuite → holtburger-web — delivery status

Reconciliation of what was **built and live-verified** against the 16-agent synthesis
roadmap (`workflow-reports/16-synthesis.md` — NOTE the corrected path: this file lives
under `docs/rynth-integration/workflow-reports/`, not bare `16-synthesis.md`; the old
pointer here and in `rynth/README.md` was wrong by one directory + the missing
`workflow-reports/` segment, rynth-review 2026-07-23 finding 16 B2). The synthesis said
*what to build*; this says *what exists*. Every "done" row has a smoke test under
`apps/holtburger-web/rynth_*_smoke.cjs` that exercises it against local ACE (serve.py +
wsbridge). Run the suite with `apps/holtburger-web/rynth_test_all.cjs`.

> ## ⚠ 2026-07-23 REFRESH — this doc was frozen ~5 sessions (since 2026-07-17) and had
> drifted badly: it said "9 modules," said nothing about the AI director, the stream rig,
> NavAtlas, or the omnibus, and presented the readiness gate as settled after two later
> soaks reversed it. A 16-agent code review (`/mnt/wbterminal1/rynth-review-2026-07-23/`)
> flagged this doc itself as one of its findings (16 D1: "the most dangerous file in the
> set... 5 sessions stale and silent about the director/stream"). This refresh brings the
> module counts, phase table, and verdict up to HEAD and adds the sections that were
> missing outright (§Director/LLM stack, §Stream rig, §NavAtlas, §Omnibus waves,
> §2026-07-23 remediation below); existing rows are marked stale in place, not deleted,
> per this project's doc-debt convention (see `HANDOFF-omnibus-2026-07-21.md`'s own
> banner for the sibling case).

Bot code: `apps/holtburger-web/rynth/` — **22 top-level modules** (verified `ls
rynth/*.js` 2026-07-23, up from the "9" this doc said through 2026-07-17: atlas, bot,
buff_loop, combat_loop, control_channel, global_router, goto_compose, indoor_router,
kernel, loot_loop, loot_policy, nav_file, nav_frame, nav_guard, nav_import, netbrain,
route_flags, route_recorder, router, sweep_probe, vitals, webhost) plus the **AI
director stack** under `rynth/ai/` — **17 top-level `.js` + 10 `ai/tools/*.js` + 1
`ai/eval/*.js`** (28 files; see §Director/LLM stack) **+ 1 `rynth/suit/suit_solver.js`**
(one of the 5 still-dark omnibus Wave-D modules, §Omnibus waves). Entry point:
`createGrindBot()` in `bot.js`.

## Synthesis phases

| Phase | Synthesis exit criteria | Status | Evidence |
|---|---|---|---|
| **1 — stub host + walking skeleton** | login → world model → one attack | ✅ DONE | `rynth_phase1_smoke`, `rynth_combat_smoke` (first seam-driven kill) |
| **2 — combat loop** | full debugged combat behavior | ✅ DONE | `rynth_loop_smoke` (2 autonomous kills); report-11 contract below |
| **3 — buff / loot / nav** | buff maintain, corpse loot, point-to-point nav | ✅ DONE | `rynth_buff_smoke`, `rynth_loot_smoke`, `rynth_router_smoke` |
| **4 — parity** | beyond the four loops | 🟡 PARTIAL | vitals, fleet, control, fellowship done; meta-scripting deferred |

## Report-by-report

| Report | Subject | Status | Where |
|---|---|---|---|
| 02 | Seam mapping matrix | ✅ | `webhost.js` (~45 members); ~20 new wasm getters landed |
| 03 | Minimal viable host / loot tier-4 | ✅ | `loot_loop.js` |
| 04 | Tick adapter + push-event plane | ✅ | `webhost.js` frozen snapshot + Web-Worker heartbeat + `onEvent` |
| 05 | Bridge architecture | ✅ (in-page variant) | in-page WebHost — no external bridge needed for the JS brain |
| 06 | Bot-harness / multi-account | ✅ | `supervisor.cjs` (login-retry, health, auto-relogin) |
| 07 | FellowshipTracker rewrite | ✅ | `webhost.js` `TryGetFellowship` (~30-line adapter) |
| 08 | Win32 excision | n/a for JS brain | islands never compiled; relevant only to the .NET-wasm path |
| 09 | RynthNav integration | ✅ (Holtburg region) | `router.js` (leg executor) + `global_router.js` + `apps/rynthnav-sidecar` (Detour + portal Dijkstra + statics/scenery bake); `rynth_globalroute_smoke` walked 9 legs around Holtburg live |
| 11 | Combat/buff behavioral contract | ✅ substantially | see the contract table below |
| 12 | God-class decomposition → BotKernel | ✅ | `kernel.js` |
| 13 | Chorizite prior-art / readiness gate | 🟡 STALE — see reversal note below | `__bootState`/`in-world` gating in every harness (AS ORIGINALLY SHIPPED — since overturned, do not follow this row) |
| 14 | SessionHandle read backlog | ✅ | full S-effort backlog + busy trio + property getters |
| 15 | Language-strategy scorecard (D1) | ✅ RESOLVED | JS ships now; `.NET-wasm` A′ de-risked (`netwasm-spike/`) |
| 16 | Synthesis roadmap | — | this delivery |

### ⚠ Readiness-gate reversal (2026-07-23 addition — was previously unmarked, rynth-review 16 D2)

Report 13's row above ("readiness gate ✅ applied — `__bootState`/`in-world` gating in
every harness") described the state as of ~2026-06/07-17 and was never revisited in this
doc. Two later soaks overturned it in the field:

- `HANDOFF-playtester-soak-11.md` §2 / `:96-97` and `HANDOFF-playtester-soak-12.md` §1.6
  (`:47`) found that `__bootState` conflates the `ready` and `in-world` states into one
  scalar AND **false-latches `error`** on a slow-but-fine boot (the 90s scene-ready
  watchdog fires while the session is actually healthy).
- The mandated pattern since soak-12 is **pose-based readiness, NOT `__bootState`** —
  poll `getLocalPlayerPose()` / a real position update, not the boot-state scalar.
  `STREAM-RIG-OPS.md` §"Duplicate-login boot dance" already documents this as the live
  operational rule ("Boot scripts must reload-retry on pose-based readiness, NOT
  `__bootState`").

**If you are writing a new harness or boot script: use pose-based readiness. Any code
still gating on `__bootState==='ready'`/`'in-world'` as the sole signal is running the
superseded pattern.**

## Report 11 combat/buff contract coverage

| Rule group | Implemented | Module |
|---|---|---|
| T2 filter (player / recently-killed / creature / **attackable** / dead / dist) | ✅ | `combat_loop.js` |
| T8 monster priorities `(prio-1)*5` | ✅ | `combat_loop.js` |
| T9 lock + stickiness(25), T10 scan-grace(1500) | ✅ | `combat_loop.js` |
| P2/P5/E4 cast serializer (UseDoneSeq + 2500ms self-clear) | ✅ | `combat_loop.js` + busy trio |
| P3 magic face-settle (15°/140ms/2500ms cap) | ✅ | `combat_loop.js` |
| P12 kill prediction (learn MaxHP, 0.80 confidence, ≥3 samples) | ✅ | `combat_loop.js` (dual-source: severity + hf-delta) |
| Melee / missile / magic attack branches | ✅ | `combat_loop.js` (melee live-verified via unwield) |
| B1/B2/B3/B6/B8/B9/B13/B14 self-buff | ✅ | `buff_loop.js` |
| B4 tier-upgrade + B5 incantation cap | ✅ | `buff_loop.js` + `spell_ladders.json` |
| B7 item enchants (chat-confirmed) + B10-B12 batch rebuff | ✅ | `buff_loop.js` |
| B15 emergency HP + B16 in-combat/idle thresholds + give-up valve | ✅ | `vitals.js` |

## Beyond the reports (built because it was needed)

- **BotKernel** priority arbitration (Vitals > Combat > Loot > Buff) — `kernel.js`.
- **Remote control channel** over in-game tells — `control_channel.js`.
- **RynthRouter** waypoint follower with seam-vs-portal recognition — `router.js`.
- **GlobalRouter + RynthNav sidecar** — sidecar-planned `bot.goto(to)` / `!bot goto`
  (`global_router.js` + `apps/rynthnav-sidecar`: Recast bake with real collision
  geometry, Detour query, portal Dijkstra over 817 GoArrow edges).
- **Vitals give-up valve** — resolves the weak-heal/huge-HP livelock.
- **Regression suite** — `rynth_test_all.cjs`.
- **WorldBuilder oracle + playtest tickets + persona** (2026-07-17) —
  `apps/wbt-sidecar` (Node, :8768; owns a long-lived `WorldBuilder.Terminal
  --stdin`, read-only allowlist over the 216-command REPL, `POST /ticket`
  playtest-ticket store) + `rynth/ai/tools/wbt.js` (`wbt_query` /
  `wbt_catalog` / `file_ticket` director actions, results journaled back to
  the LLM) wired default-on through `extensions.js` (`config.ai.wbt`;
  degrades to ok:false when the sidecar is down). New `config.ai.persona =
  {name, background, goals}` prepends the playtester's WHO-YOU-ARE block to
  the system prompt. Gates: `rynth_ai_wbt_test.cjs` 46/46 +
  `apps/wbt-sidecar/wbt_sidecar_test.cjs` 28/28 (mock WBT, incl.
  timeout→respawn) + live `rynth_ai_wbt_smoke.cjs` **9/9** (persona + wbt
  actions in the live prompt; in-page wbt_query → sidecar → real WBT over
  CORS; ticket persisted with the character's position). Lifecycle:
  `scripts/wbt-sidecar-boot.sh` (cron @reboot, rynthnav pattern);
  `WBT_PROJECT` env loads a .wbproj at boot for project-scoped reads.
- **Playtester-readiness session** (2026-07-17, evening) — four deliveries:
  (1) **Parity reconciliation**: code re-read of the netwasm-spike findings
  vs current loops ruled nearly everything already FIXED (T9/T10/T12/T4/
  kill-TTL; B11/B4/B8/B9/B16/B15 + kernel starvation); the two real
  survivors were both loot — the **appraisal gate** (unappraised items were
  shifted out and skipped forever when `minValue>0`; fixed in loot_loop.js
  with a held-head + one RequestId + 2.5 s window; `rynth_loot_gate_test`
  10/10) and the loot-everything default (ruled by-design now that trash
  can be vendored; documented in-code). T8 max-vs-first-match stays an
  open ruling (only bites overlapping priority rules).
  (2) **Two-speed fix**: `?bot=1` boots the grind bot on the live client
  session at first in-world (index.html EnteredWorld handler; `?botAi=off`
  skips the director) — the client-side wire that previously existed only
  in Node harnesses. Bar-panel stub text replaced. Live gate:
  `rynth_bot_boot_smoke.cjs` 9/9.
  (3) **Economy hands**: RynthWebHost economy plane (inventory/coins/
  burden%/free-slots/vendor-state reads + buy/sell/wield/unwield actions
  over the existing wasm exports — no Rust changes needed) + seven
  director actions in `ai/tools/economy.js`, default-on via extensions.
  `rynth_ai_economy_test.cjs` 33/33; burden/free-slots live-probed (the
  entity int-store does NOT answer for the local player — stats-plane
  getters `playerBurden`/`playerItemsCapacity` are the working source;
  every InventoryItem.containerId is 0 in the current wasm snapshot, so
  free-slots is an aggregate estimate).
  (4) **Sidecar write-hardening** (full code audit of all 62 allowlisted
  WBT commands): 7 commands accepted attacker-chosen output paths
  (arbitrary-file-overwrite) — output-path args (`out`/`outputPath`/…) are
  now refused on EVERY /command; input-path args (`datPath`/`otherDat`/…)
  must resolve under `WBT_DAT_ROOTS` (default `~/ac_base_dats`);
  `compute-vanilla-baseline`, `dump-lb-expectations`, `difficulty-gradient`
  dropped from the allowlist (unsafe by construction). `WBT_UNSAFE_ARGS=1`
  is the operator-only escape. Sidecar suite now 34/34; refusals verified
  against the live sidecar.

## Director/LLM stack (missing from this doc entirely through 2026-07-17 — added 2026-07-23)

An LLM "director" checks in on the grind bot every few minutes, reads a compact
observation, and adjusts it (priorities, loot threshold, travel, pause, notes) — never in
the per-tick path. Code: `rynth/ai/` (17 top-level modules + `ai/tools/` (10) +
`ai/eval/` (1)); frozen interface + addenda: `rynth/ai/SPEC.md`; operator guide:
`rynth/ai/README.md`.

- **Provider/model**: any OpenAI-compatible `/chat/completions` endpoint, default
  OpenRouter. `DEFAULT_MODEL = openai/gpt-oss-120b`; the LIVE stream rig currently pins
  `minimax/minimax-m3` via `?botModel=` (history: z-ai/glm-5.2 → microsoft/phi-4 →
  minimax-m3 — see `STREAM-RIG-OPS.md`).
- **Cost surface**: SPEC/README document `maxCallsPerHour: 12` and "cents per day," but
  the live `?bot=1&botInterval=0.5` boot path overrides to `maxCallsPerHour =
  min(70, ceil(70/botInterval))` — **70/hr on the live rig, ~6× the documented rate**
  (rynth-review 16 C3 / 09; url-flags.md `botInterval`/`ai` rows now cross-reference
  this). `director.js` also carries a `maxSpendPerHourUsd` cap (default $1/hr) and, as of
  a 2026-07-23 fix, a real enforced minimum inter-call spacing floor
  (`3600/maxCallsPerHour` seconds — ~51.4s at 70/hr) on top of the rolling-hour count.
- **netBrain**: `?netBrain=on` (DEFAULT — absent resolves to `"on"` via a `!== "off"`
  reader, by design, see url-flags.md's idiom note) puts the .NET-wasm C# brain
  (`netbrain/AppBundle`, ~4.3 MB) in the combat-target-selection driver seat on the LIVE
  stream by default; `shadow` compares without driving; `off` costs nothing. This means
  the 24/7 stream currently runs C#-driven target selection, not JS, whenever the bundle
  is present (it silently degrades to JS if the gitignored bundle is missing — no visible
  signal in-game either way).
- **Sender/owner safety (P0, fixed 2026-07-23)**: the in-game control channel
  (`rynth/control_channel.js`, `!bot ...` tells) now refuses every command unless the
  sender resolves as an owner — default is the logged-in character, explicit override via
  `?botCtlOwner=`, **refuse-everyone if unresolvable** (never fail-open). Before this fix,
  ANY player on the ACE server could drive the live-stream bot via
  `/tell <botname> !bot pause|goto|ai off` (rynth-review 13 #1, the review's one P0).
- **Stop/pause arbitration** (open risk, not yet fully resolved as of 2026-07-23): there
  are three stop-ish mechanisms — `!bot pause` (kernel operator-hold), `rynthAI.stop()`/
  `!bot ai off`, and the durable operator-stop latch (`rynth/ai/operator_stop.js`,
  survives a session-takeover reconnect) — plus at least eight writers to character
  movement. `checkNow()` now refuses while the operator-stop latch is set (a 2026-07-2x
  fix), closing one real gap, but the review's broader finding (no single mechanism is
  authoritative over "who owns the character right now") is still open.
- **Memory**: a durable, model-editable scratchpad (`rynth/ai/tools/memory.js`) is
  carried in every observation. As of a 2026-07-2x fix it is a genuinely `pinned: true`
  section in `observe_assemble.js`'s salience/quota system (`extensions.js`
  `OBS_PINNED_SECTIONS`) — never shed by the observation budget — closing what was
  previously a doc-vs-code gap (the module's own comment claimed "never dropped" before
  the code actually enforced it).

## Stream rig (missing from this doc entirely through 2026-07-17 — added 2026-07-23)

The 24/7 YouTube livestream (Dell `:0`, VAAPI GPU chromium) runs the `?bot=1` director
against local ACE, full ops runbook in `STREAM-RIG-OPS.md` (kept in sync with
`launch.sh` as a matter of project discipline — the one doc rynth-review 16 called
consistently accurate). Current flag set: wireframe render, `targetFps=20`, autoLogin,
`botModel=minimax/minimax-m3`, `botInterval=0.5`, `botPersona=explorer`,
`explorePressure=1`, `thoughtOverlay=1` (stream teleprompter), `streamHud=1`. Six
hard-won ops traps (DPMS killing vsync, chromium session-restore tab wars, the
duplicate-login boot dance, HTTP-cache-vs-edited-JS, occlusion throttling, fps
expectations) are catalogued there, not repeated here.

## NavAtlas (missing from this doc entirely through 2026-07-17 — added 2026-07-23)

A perception-grounded navigation layer for the AI playtester — the bot builds its own
map from what it has actually seen/walked rather than being handed ground truth.
Spec: `SPEC-navatlas-2026-07-18.md` + `appendix-navatlas-{A-navmachinery,B-physics}.md`.
Delivered across `HANDOFF-navatlas-soak-15.md` / `RESULTS-navatlas-soak-15-pickup-
2026-07-19.md`: W1 (coverage tracking), W2 (the atlas — route recording/replay/naming),
W3 (director economy: `follow_route`/`list_routes`/`name_route` actions, auto-record,
mission-line observation) all landed and green; a pose-corruption tail fix was the one
item still in flight at that session's close (root-caused, first-round fix merged, a
read-chokepoint second round written but not yet rig-verified at the time — check
current `rynth/atlas.js` / `nav_guard.js` history for whether it's since landed).
`ExplorePressureController` (`rynth/bot.js`) is the ambient idle-motion consumer that
rides the atlas + `exploreMemory` frontier data between director check-ins.

## Omnibus waves

2026-07-21 buildbox fan-out — missing from this doc through 2026-07-17, added 2026-07-23;
see `HANDOFF-omnibus-2026-07-21.md` for full detail.

16-package buildbox fan-out, applied `4118bf9d`, soaked `39aacc79` (4/5 deploy-gate
criteria PASS — see that handoff's ✅ STATUS UPDATE banner for what's done vs still open):

- **Wave A (wasm survival)** — arrival z-clamp, last-known-good landblock retention,
  raw-pose shadow retention (`getLocalPlayerPose` no longer regresses to cell 0).
- **Wave B (harness survival)** — explorer combat-off boot mode, public director
  `isBusy()` accessor, frontier/loopVerdict memoization, an anti-drift contract test.
- **Wave C (nav guards)** — `nav_frame.js` (one frame/taxonomy math module, 6 dupes
  replaced — though rynth-review 04/05/06 found ≥11 *other* surviving private copies
  elsewhere, so "ONE copy" is aspirational, not yet true system-wide), `nav_guard.js`
  sub-floor-z + landblock-legality leg filter, straight-line fallback removed from the
  pressure ladder.
- **Wave D (DARK Mag cores — flag-off, NOT wired to the director)** — `loot_policy.js`,
  `ai/combat_memory.js`, `suit/suit_solver.js`, `ai/heal_reflex.js`,
  `ai/confirm_reflex.js`. **Still unwired as of 2026-07-23** (~1,175 lines, zero
  importers outside their own files/tests, re-confirmed by rynth-review 17-SYNTHESIS
  S1) — this is documented-as-deferred, not accidental drift, but flag it as dead weight
  in the shipped client until step 8 of the omnibus handoff lands.
- **Wave E (observation budget)** — `ai/observe_assemble.js` salience/quota assembler,
  wired into `extensions.js`; goal-gated steady-state lines; journal tail trim.

Coverage-stall caveat (rynth-review 16 C1, still open 2026-07-23): the omnibus deploy-gate
soak's one failing criterion (coverage stopped growing) has **two different claimed root
causes in sibling docs** — a `nav_guard.js` z=0 false-park fixed in code (`8935e576`,
unit-tests-only, never re-soaked) and, in a LATER trial after that fix, `STREAM-RIG-OPS.md`
crediting the `minimax-m3` model swap alone. The two are confounded (the model trial ran
*after* the code fix landed); nobody has yet run one soak that isolates which one actually
restored coverage growth. Treat both as live until that soak happens.

## 2026-07-23 remediation (16-agent code review → 12-package fix wave)

A 16-agent coherence review (`/mnt/wbterminal1/rynth-review-2026-07-23/`) audited the
whole rynth/AI-director/stream stack for internal consistency (code-vs-code, doc-vs-code,
flag-vs-doc) and found one P0 (the control-channel sender allowlist, now fixed — see
§Director/LLM stack above), several P1/P2 arbitration and truth-store gaps (stop/pause
ownership, pose-truth vs the `objCellId==0` sentinel, memory salience vs the "never
dropped" scratchpad claim, config tuned for a model family no longer live), and a long
documentation-drift ledger (this file being the single worst offender — see the banner at
the top). The findings were split into a 12-package remediation fix wave (this doc's
2026-07-23 refresh is one of those packages — the "documentation drift batch"); several
packages ran concurrently against the same working tree, so cross-check `git log` for
what has actually landed rather than trusting any one section's "done" claim at face
value going forward. Full review corpus, part-by-part reports, and the synthesis/drift
ledger: `/mnt/wbterminal1/rynth-review-2026-07-23/rynth-review/parts/` (`17-SYNTHESIS.md`
is the top-level entry point; `16.md` is the docs/handoffs audit this refresh implements).

## Open work (feasibility proven; remaining is depth)

⚠ STALE FRAMING (2026-07-23): the line below ("none load-bearing") predates the AI
director, the stream rig, and the 16-agent review above, all of which found real open
arbitration/consistency gaps that ARE load-bearing for the live 24/7 stream (see
§Director/LLM stack "Stop/pause arbitration" and §2026-07-23 remediation). Kept
verbatim below as the original combat/buff/nav "delivered" claim, which is still
accurate on its own narrow terms (the four core loops); it is not a current complete
picture of open work.

(none load-bearing — the combat + buff contracts are complete)
2. VTank meta-scripting (ExpressionEngine) — deferred by report 03; gate on real need.
3. ~~RynthNav global router sidecar~~ **DONE 2026-07-16** (`apps/rynthnav-sidecar`,
   live-verified end to end). Remaining nav depth: full-map bake (only the 5×5
   Holtburg region A7–AB×B2–B6 is baked; buildbox fan-out job), indoor cell-graph
   A* (dungeon walls aren't baked — upstream gap), portal-arrival re-validation
   vs our ACE, sidecar lifecycle (manual setsid-nohup today).
4. ~~Incremental **.NET-wasm lift**~~ **DELIVERED 2026-07-16** (D1 path A′): the three
   pure slices (CombatScoring TargetScoring, BuffScoring BuffScheduling, LootScoring —
   the last authored + parity-run this session, 94 fixtures, 8 genuine cross-evaluator
   findings) consolidate into ONE production AppBundle (`apps/holtburger-web/netbrain/`,
   4.3 MB, ICU-free, unified replay gate **269/269** vs native C#) loaded in-page behind
   the same seam via `rynth/netbrain.js` + `?netBrain=shadow|on` (url-flags.md).
   `shadow` runs the C# brain beside JS at each decision point with divergence
   accounting on `__diag.netbrain` (live-verified headless: `rynth_netbrain_smoke` —
   the C#-vs-JS T7 scoring-formula divergence is now *measured live*); `on` lets the
   C# selection drive the combat lock. Node gate: `rynth_netbrain_test.cjs` (18
   checks, real loops + real bundle). Remaining A′ depth: buff/loot live soak (their
   shadows are node-pinned but saw no live kernel routing yet), the P-rule cast
   serializer slice, and an `on`-mode ruling once shadow data accumulates.

## Verdict

The synthesis's core thesis — *reimplement the one `RynthCoreHost` contract as an in-page
WebHost and the 51.5k-line brain can't tell the difference* — is **proven**: an autonomous,
multi-account, remotely-controllable grind bot (combat + buff + loot + nav + survival) runs
on holtburger-web entirely through that seam, live-verified end to end. What remains is
additive depth, not open feasibility questions. **[This paragraph describes the 2026-07-17
combat/buff/nav delivery and is still true on those terms.]**

**2026-07-23 addendum:** the system has grown well past that verdict's scope since — an AI
director, a 24/7 stream rig, NavAtlas, and a 16-package omnibus fan-out (see the sections
above) — and a 16-agent review of the *whole* current stack reached a narrower verdict for
the system as it stands today: **"works, but only along the exact groove the live stream
runs in"** — a caster explorer, kernel-off, minimax director, sidecar up, no viewer
hostile; step one config off that groove and coherent-looking layers start fighting (the
stop/pause arbitration and truth-store gaps in §Director/LLM stack are the concrete
version of that). The one P0 from that review (control-channel sender allowlist) is fixed;
the rest are tracked P1/P2 depth work, not a regression of the original feasibility proof.
