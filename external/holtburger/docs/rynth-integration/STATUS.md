# RynthSuite → holtburger-web — delivery status

Reconciliation of what was **built and live-verified** against the 16-agent synthesis
roadmap (`16-synthesis.md`). The synthesis said *what to build*; this says *what exists*.
Every "done" row has a smoke test under `apps/holtburger-web/rynth_*_smoke.cjs` that
exercises it against local ACE (serve.py + wsbridge). Run the suite with
`apps/holtburger-web/rynth_test_all.cjs`.

Bot code: `apps/holtburger-web/rynth/` (9 modules). Entry point:
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
| 13 | Chorizite prior-art / readiness gate | ✅ applied | `__bootState`/`in-world` gating in every harness |
| 14 | SessionHandle read backlog | ✅ | full S-effort backlog + busy trio + property getters |
| 15 | Language-strategy scorecard (D1) | ✅ RESOLVED | JS ships now; `.NET-wasm` A′ de-risked (`netwasm-spike/`) |
| 16 | Synthesis roadmap | — | this delivery |

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

## Open work (feasibility proven; remaining is depth)

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
additive depth, not open feasibility questions.
