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
| 09 | RynthNav integration | 🟡 in-page half done | `router.js` (local leg executor); global navmesh sidecar deferred |
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
- **RynthRouter** waypoint follower with portal recognition — `router.js`.
- **Vitals give-up valve** — resolves the weak-heal/huge-HP livelock.
- **Regression suite** — `rynth_test_all.cjs`.

## Open work (feasibility proven; remaining is depth)

1. Missile ammo-out fallback (mode auto-reverts to Melee server-side; a bot-side pre-check is a nicety).
2. VTank meta-scripting (ExpressionEngine) — deferred by report 03; gate on real need.
3. RynthNav global router **sidecar** (offline navmesh bake + Detour + portal Dijkstra) —
   report 09's XL endgame; the `router.js` local half consumes its output.
4. Incremental **.NET-wasm lift** of RynthAi's pure-tier C# behind the same WebHost seam
   (D1 path A′ — de-risked, `netwasm-spike/`), if preserving the C# investment is
   prioritized over the JS reimplementation.

## Verdict

The synthesis's core thesis — *reimplement the one `RynthCoreHost` contract as an in-page
WebHost and the 51.5k-line brain can't tell the difference* — is **proven**: an autonomous,
multi-account, remotely-controllable grind bot (combat + buff + loot + nav + survival) runs
on holtburger-web entirely through that seam, live-verified end to end. What remains is
additive depth, not open feasibility questions.
