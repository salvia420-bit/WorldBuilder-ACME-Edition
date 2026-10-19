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

## 2026-10-19 update — VTank panel v2, the buff scroll ladder, melee re-target, the route in the world

Owner report: the VTank section had redundancy and low information density (Vitals), the buff list
offered spells players can't normally cast, routes being laid out could not be seen in the world,
and melee "would wait maybe 10 seconds before attacking the next thing". Code only (the 1070 was
down); every item below is covered by node tests, none is live-verified yet.

- **Panel v2** (`plugins/rynth-vt/`): a command bar on every tab (RUN · COMBAT BUFF NAV LOOT META ·
  profile ▾ · ⋯ Save As / Delete / presets / Import HUD) over ONE row of 8 tabs — Main (Options +
  Vitals, with live HP/Stam/Mana bars marked at the top-off and in-combat levels) · Monsters ·
  Items (+ Consumables, one Add that routes by kind) · Buffs (grouped, folding, tier + time left,
  item-bane matrix, Force Buff) · Route (Add here + one kind picker, distances, Show path) · Loot
  (from the old Profiles tab; its own rule-editor picker) · Meta · Advanced (only what no other tab
  shows; the search finds every option). Each control has one home (navigation could be switched
  on from three tabs before). `/rs ui` keeps the v1 names. `rynth_vt_preview.html` runs the real
  panel on a scripted world with no client.
- **Buff scroll ladder** (`rynth/buff_families.js`, `spell_ladders.json` flag 4/8, `rynth/buff_loop.js`,
  `rynth/hud_bridge.js`): a developer character (`@addallspells`) got Zongo's Fist, Ketnan's Eye,
  Combat Medication (60 s) … because they out-ranked the scroll spell of the same family. Buffs now
  resolve only to each family's scroll ladder I–VIII (checked against the ACE world DB's 2,513 scroll
  items), in the VT Buffs tab, the HUD picker and the bot's casting; Missile Weapon Mastery is a
  family now (archers); stored VT lists are moved onto the ladder (`rynth/vt/index.js` 12c).
- **Melee re-target** (`rynth/combat_loop.js`): after a kill the bot requested the next swing while
  ACE was still in the killing swing (`Attacking`), which ACE drops silently (`Player_Melee.cs`
  :98-100), so the bot waited out its 9 s silence fallback. It now waits for that loop's AttackDone
  (≤ 3 s); the same on a mid-swing re-target. `rynth_melee_retarget_test.cjs`: 3-monster fight
  32.5 s → 16.9 s, kill→next swing 9.1 s → 1.3 s. Archers had the same stall.
- **The route in the world** (`scene3d/route_overlay.js`): rings at the walked waypoints (arrival
  radius), the path with chevrons, in-place waypoints as gems, the current waypoint pulsing green
  with a line from your feet; on the Route tab or always with Show path; VTank's
  `NavLineThickness` / `NavRingThickness` are live. 6 draw calls shown, 0 hidden, no boot cost.

Gate (alone, capped-build, 2026-10-19 08:40-08:51): JS gate **817 passed / 0 failed / 0 skipped**
(new rows `rynthBuffCanonical`, `rynthVtBuffSpecMigration`, `rynthRouteOverlay`); node runner **69 passed /
0 failed / 32 skipped** (+ `rynth_melee_retarget_test.cjs`); `gen-modulepreload --check` up to date (434
modules — nothing new in the boot graph); `lint-url-flags` 0 undocumented readers. Logs:
`/mnt/wbterminal1/tmp/vt-panel-v2/`. A report-only review (v1→v2 parity table + 20 findings) was
fixed in full before the gate.

### Live checklist for the next 1070 session (2026-10-19 items)

| # | Check | Pass looks like |
|---|---|---|
| V1 | Melee character, 3+ monsters clustered, bot running | next swing within ~1-2 s of each kill; console `[combat] kill confirmed …` then the swing; `__bot.combat.status.state` is `ENGAGE` < 1 s, then `ATTACK`; never `the killed loop's attack end never came` |
| V2 | V1 with a bow, and with the next monster 5-12 m away | same, plus the charge |
| V3 | Casters, HUD STOP / Restart mid-fight, looting the last corpse | as before |
| B1 | Developer character: VT Buffs tab and HUD Settings › Self-buffs | only scroll names (Might of the Lugians / Incantation of …), no Zongo's Fist / Combat Medication; archers see Missile Weapon Mastery |
| B2 | A profile saved before today with a buff list | chat line "buff list: N off-ladder spell(s) moved…" once; the list then shows ladder spells |
| P1 | Open the panel (HUD **VT**), click through every tab | one tab row; switches reflect the HUD's toggles; no console errors |
| P2 | Main: let HP drop in a fight | the HP bar falls past the white (in-combat) mark and the bot heals |
| R1 | Route tab open, add 3-4 points with **Add here** | azure rings at foot level, legs with chevrons, green current ring + arrow + label, a line from your feet |
| R2 | `/rs nav setcurrent 3`, `/rs nav type linear`, `/rs nav stop`, nav off | marker moves (no rebuild), closing leg and chevrons drop, marker amber, then grey |
| R3 | Indoors (a dungeon route), and behind a hill | rings on the floor (not 192 m off); faint path through terrain, marker solid |
| R4 | Advanced › Route line/ring thickness 16 then 1 | ~0.32 m wide, then a hairline |
| R5 | Perf: `liveScene3d.renderer.info.autoReset=false`, toggle Show path | +5-6 draw calls; no frame-time change; first enable compile spike < 16 ms |

## 2026-10-13 update — the VTank feature set

Goal: every feature in the VTank guide (`/mnt/wbterminal1/rynth-vtank-2026-10-12/vtank_guide.txt`,
cited `G:<line>`) on the web RynthSuite bot, all working together, **without breaking anything
the bot already did**. The plan is the contract: `/mnt/wbterminal1/rynth-vtank-2026-10-12/design/PLAN.md`
(§1 decisions D1-D39, §2 feature matrix, §2.11 not deliverable client-side, §7 tests and the
live checklist, §8 invariants, §9.2 owner questions). Every package, review and gate report
sits next to it (`impl/`, `review/`, `ORCHESTRATOR_LOG.md`). Base `a33dcb16`; the first eight
Wave-1 modules landed as `008a22ae`. The reviewed tree after the final gate is snapshotted in
`snapshots/review-final-*` (tracked patch, untracked tar, SHA256SUMS). User docs:
`apps/holtburger-web/rynth/vt/README.md`.

**How it is layered.**

- All new bot code is the **VT layer**, `apps/holtburger-web/rynth/vt/` (68 `.js` files), plus
  the VTank panel `apps/holtburger-web/plugins/rynth-vt/` (13 files). `createGrindBot` imports
  `vt/index.js` dynamically (`rynth/bot.js:52`) and attaches `createVtLayer()` after the bot is
  built, bounded to 3 s: a slow or failing layer never blocks the boot.
- **Default-on, with an escape hatch.** `?botVt=off` (`rynth/boot.js:108` → `cfg.vt = false`)
  boots the bot without the layer: no `bot.vt`, no kernel `aux` slots, the literal grind
  ladder (`docs/url-flags.md` `botVt` row).
- **The Default profile is today's behaviour, byte for byte.** Every new option defaults to
  what the bot did before (D3). The parity oracle T-P1 (`tests/rynth_vt_parity.test.mjs`) runs
  one scripted world with and without the layer and compares every kernel action and every
  host action call: zero divergence. VTank's own defaults are one action away (Profiles →
  Apply VTank defaults, or `/rs settings preset vtank`, on a user profile).
- The layer reaches the bot only through hooks that are absent or inert at Default: the
  kernel's `aux` slots (Supplies, JumpNow, Pets, Doors, Navigate, BuffItems, IdleRebuff, and
  the PeaceMode idle hook), `combat.vt` / `combat.acquireRangeFn`, `loot.classify`,
  `buff.setItemBuffs`, `unwedge.allowEscalation`. It runs off the host Worker heartbeat (a
  pre-tick before the kernel, a 2 Hz post-tick after it), never page timers.
- Existing files edited (19 code files): `rynth/{kernel,combat_loop,buff_loop,loot_loop,
  router,goto_compose,webhost,bot,boot,hud_bridge,unwedge,control_channel}.js`,
  `rynth/ai/operator_stop.js`, `app/{slash_commands,client_events}.js`,
  `plugins/{rynth-hud,api,inventory,vendor-ui}.js` (`API_VERSION` 1.2.0); plus the gate
  registry `harness/run-js-headless.mjs` and the docs. All additive; three changes also apply
  without the layer: the legacy untargeted `CastSpell(0, id)` refuses a spell that is not
  SelfTargeted (D12, the ACE crash class), the control channel reads tells only from the TELL
  chat category (2, or 0 from a host without the category; review safety-5), and the kernel
  installs its tick closure on a held boot too (review wiring-2; inert while held). The HUD's
  grind | explorer selector is now labelled "Persona" instead of "Profile".

| Package | Path | Delivers | Guide |
|---|---|---|---|
| W1-1 EXPR | `rynth/vt/expr/` | One expression language for the Monsters list and metas: lexer, parser, values, .NET→JS regex, vars (session / persistent / global), pure function library | G:101-150, G:226-319 |
| W1-2 SET | `rynth/vt/settings/` | `VtOptions`, the one settings authority: schema rows (Advanced Options), live cells over the loop fields, profiles (Default, `[By char]`, shared, `[Char]`), named stores, the page session | G:1-42, G:44-58, G:60-66 |
| W1-3 FMT | `rynth/vt/formats/` | VTank `.met`, metaf `.af`, view XML, VT Classic Looter `.utl` (parse + write, round trip) | G:57, G:226-319 |
| W1-4 META | `rynth/vt/meta/` | The meta engine: states, rules, conditions, actions, call stack, watchdog, views | G:226-319 |
| W1-5 CMD | `rynth/vt/cmd/` | The `/rs` (= `/vt`) dispatcher, the `/ra` `/mt` `/ub` compat tables, world/inventory actions, meta host functions, quest tracker | G:7-11, G:123, G:214-224 |
| W1-6 NAV | `rynth/vt/nav/` (+ `router.js` per-leg arrival, `goto_compose.js` exports) | Circular / Linear / Follow / Once routes, `.nav` profiles, `ActiveNav` as the kernel's Navigate slot, one tick-driven executor per waypoint type (10 types) | G:17, G:56, G:185-224 |
| W1-7 CMB | `rynth/vt/combat/` (+ `data/combat_spells.json`, `creature_species.json`) | Monster list (P −1..4, debuff and attack columns, expressions), monster variables, spell tables, debuff ledger, attack planner, Items, creature profiles | G:14-16, G:68-166, G:183 |
| W1-8 SEAM | `rynth/webhost.js` (new members), `rynth/vt/host_signals.js`, `plugins/{api,inventory,vendor-ui}.js` | Safe casts (`CastSpellAt`, `CastSelf`, `CastUntargetedSafe`), selection / vendor / enchantment reads, one `host.onEvent` → typed signals | G:156 and every tab |
| W1-9 SUP | `rynth/vt/support/` (+ `data/{pet_essences,dispel_items,harmful_families}.json`) | Supplies (kits, food, potions, grenades), dispel, mana stones, autostack / autocram / peas, pets, fellowship, doors, buff items, peace mode, idle rebuff | G:24-31, G:36-42, G:168-181 |
| W1-10 UI | `rynth/vt/bridge/`, `plugins/rynth-vt/` | The 9-tab VTank panel and the meta view renderer | every tab |
| INT-1 | `rynth/kernel.js`, `combat_loop.js`, `buff_loop.js`, `loot_loop.js` | Kernel `aux` slots and ranks, loop hooks (all inert at Default) | G:34-37 |
| INT-2 | `rynth/vt/index.js`, `rs_entry.js`, `glue/`; `bot.js`, `ai/operator_stop.js`, `unwedge.js`, `control_channel.js` | Composition root (`createVtLayer`), the page entry `window.__rynthVt`, `!bot rs` / `!bot vt` | — |
| INT-3 | `app/slash_commands.js`, `app/client_events.js`, `rynth/boot.js`, `rynth/hud_bridge.js`, `plugins/rynth-hud.js` | The `/rs /vt /ra /mt /ub` chat branch, the HUD VT button, `?botVt=off`, docs | — |

**How a user reaches it.**

- **Chat commands** — `/rs …` and `/vt …` (the VTank verbs), `/ra`, `/mt`, `/ub` (RynthAi /
  Mag-Tools / UtilityBelt subsets). `app/slash_commands.js:429` (`RS_PREFIX_SET`, `:175`) hands
  all five prefixes to `window.__rynthVt`; they are **never sent to ACE**, and an unknown verb is
  a local error line.
  `@rs …` still goes to the server as typed. Meta Chat actions, nav Chat points and
  `host.InvokeChatParser` lines use the same dispatcher; `!bot rs|vt <line>` tells reply with
  the first 3 result lines. `/rs help` lists every verb.
- **The HUD** — the **VT** button in the selectors row (`plugins/rynth-hud.js:340`) or
  `/rs ui [tab]` opens the VTank panel (v2 layout 2026-10-19: command bar + Main · Monsters · Items · Buffs · Route · Loot · Meta · Advanced; the v1 names below still open the matching tab). v1 tabs: Options (+ Advanced) · Profiles · Vitals · Monsters ·
  Items · Consumables · Buffs · Route · Meta. With a VTank route loaded the HUD **Nav** toggle
  drives that route.
- **Profiles** — Default is read-only: edits live in a page overlay, lost on reload or when
  you switch to a user profile and back. Save As (no spaces, G:54), Mine Only, `[By char]`. A
  user profile saves on every edit and, when selected, loads its route, meta and loot
  profile; HUD START / Restart then boot with its values.
- Settings and profiles work without a bot (the page session). Route, jump, follow, meta and
  `/rs loot` verbs need the bot with the layer ("start the bot first"); item, cast and face
  verbs need a bot (they use its host, so they also work on a `?botVt=off` page); verbs that
  queue work (`/ub delay`, a multi-stack `/ra give…`, a `/mt loot` retry) need the layer.

**Not deliverable client-side** (PLAN §2.11), and what ships instead:

| Item | Why | Substitute |
|---|---|---|
| Debuffs on monsters (incl. other players' casts) | ACE sends enchantment updates to player targets only | Our own debuff ledger from "You cast X on Y" / resist / fail lines + DAT durations |
| Live item mana | ACE never pushes it | Re-appraisal (≤ 3 `RequestId` / 30 s, worn items first), extrapolated with ManaRate between appraisals |
| Species / max HP without an assess | Not in CreateObject | One `RequestId` per guid; offline wcid → CreatureType table |
| Vendor-close packet | None exists | Client vendor session (panel hide, range > 8 m, portal, another container, 300 s) |
| Tell sender guid | Dropped by the wasm | Name → guid among visible players; "come closer" reply |
| Checkpoint "server verified position" | No seam | Pose stable ≥ 750 ms, 10 s cap |
| `/mp`, `/hr` in chat waypoints | No SessionHandle export | Fall through to ACE `@mp` / `@hr` |
| Alinco3 loot connector | No format reference | `.utl` + the Value floor |
| Show Editor | Deprecated in VTank | Not drawn (v2 panel); the option still round-trips through `/rs opt` |
| Client-renderer advanced options (FPS, radar, nav line width) | No retail renderer | Inert schema rows, round-tripped, greyed |
| Jump strafe direction in `.nav` | No known encoding | Web extension field, dropped on export with a warning |
| Meta functions needing client memory (Dereth clock) or monster enchantments | Not readable | An error value (`unsupported: <name>`), logged once per name — never a silent `""` |

**Verification.**

- **Wave 1** (10 parallel packages): each implemented, then adversarially verified by a
  separate agent against the plan and the real sibling modules — all ten PASS_WITH_FIXES
  (83 verifier fixes; the items they left open were owner decisions, live-only checks or
  documented `.met` / `.af` format limits).
  **Wave 2** (INT-1 → INT-2 → INT-3, strictly sequential): each verified PASS_WITH_FIXES.
  INT-3's verifier caught a V-1 break (HUD START on a `?botVt=off` page booted with the VTank
  profile's values; it now uses the HUD blob, as before the layer).
- **Whole-diff review**, 6 lenses (regressions, ACE safety, guide fidelity, runtime /
  hidden tab, logic, wiring), every finding adversarially verified: **30 findings → 27
  confirmed and fixed, 2 refuted** (safety-2, safety-4: hardening only, same as C#), **1
  uncertain** (guide-7, waits for live L-H1). A fix audit read every fix, re-ran every
  check against the pre-fix file (each new check fails without its fix) and found 0
  regressions (24 fixes correct, 3 incomplete). Two of the incomplete ones (guide-3,
  runtime-3: wiring in `rynth/vt/index.js`) were finished by a follow-up fix + verify; that
  verifier's one residual (`nav save` left `navreversed` at 1) was fixed in `active_nav.js`
  `save()`. The third (runtime-4) keeps the plan's VT-only stopgap; its root cause is
  pre-existing (gap 2). Reports: `/mnt/wbterminal1/rynth-vtank-2026-10-12/review/` (`find-*`,
  `verify-*`, `fix-A.md`, `fix-B.md`, `audit.md`, `followup-*.md`).
  `review/fix-A-bside-rs_commands.patch` is superseded (fixer B landed that change): do not
  apply it.
- **Gate after the review** (alone, under `capped-build`): JS gate **563 passed / 0 failed**
  = 532 before + the 31 new TIER5 rows (`rynthVt*`, `rynthWebhostVtSeam`,
  `harness/run-js-headless.mjs:852-886`); plain-node runner **68 passed / 0 failed / 32
  skipped** = 66 + `rynth_vt_corpus_test.cjs` and `rynth_vt_spell_tables_test.cjs`;
  modulepreload up to date (392 modules); url-flags lint 0 undocumented readers. Logs:
  `final2_jsgate.log`, `final2_rynth_node.log`, `final2_lints.log` in the project folder.
- **Zero pre-existing test files edited**: `git diff --diff-filter=M a33dcb16` lists no test
  file (the orchestrator log counts 609 pre-existing test files, 0 edited).

**Decisions taken after the plan** (`ORCHESTRATOR_LOG.md`, `review/fix-A.md`, `review/fix-B.md`):

| Topic | Rule now | Anchor |
|---|---|---|
| `/rs reverseroute` | Reverses the points and the index but no longer flips `linearDir` (C# `MetaManager.cs:1012-1023`), so the walk turns around on Circular and Linear routes. PLAN R21 / Q4 said "flip". | `rynth/vt/nav/route_model.js:349` |
| Profile names | Keep the no-spaces rule (G:54). The corpus line `/vt settings loadchar Quest Profile` errors locally. | `rynth/vt/settings/profile_store.js:37` |
| Selected item | `GetSelectedItemId` = the most recent selection, inventory or world. | `rynth/webhost.js:527` |
| `!bot rs` without the layer | Runs on the page-level dispatcher when the page has one; otherwise replies "rs unavailable — the VTank layer is not loaded" instead of the generic help. | `rynth/bot.js:566-574`, `rynth/control_channel.js:259` |
| `pinnedFirst` | While a VT-nav step that cannot be cancelled is in flight (recall cast, portal / NPC use, a jump) Navigate keeps the tick ahead of Combat, below only Vitals / Unwedge. Never true at Default. | `rynth/vt/index.js:852` |
| Boost Nav vs loot (D39 / O17 narrowed) | Boost outranks a corpse not yet started; a loot already in flight (approach / open / pickup) finishes first, gentle and strict. | `rynth/vt/nav/active_nav.js:871` |
| Gentle Boost Nav under attack | Declines only when there is a fight or the after-kill corpse to run; with nothing to fight it keeps walking. | `rynth/vt/nav/active_nav.js:875` |
| Doors under boost | An in-progress door yields whatever boosted nav yields to and is dropped, not failed, when nav steps aside; its 5 s cooldown never holds the tick. | `rynth/vt/support/doors.js:293`, `:308` |
| Buff items vs a route | Navigate, boosted or not, declines while a Consumables buff item (beer, food) is due, unless a nav step is in flight (V-23 extended). | `rynth/vt/index.js:555-561` |
| Re-selecting Default | Entering Default from a user profile starts a fresh overlay (schema defaults, G:48). | `rynth/vt/settings/profile_store.js:197` |
| `host.nearbyRangeM` | Raised only for MonsterRange > 40 m or ApproachRange > 4 m (to that range + 5 m), never below the configured base; Default never moves it. PLAN O5 still says `max(60, …)`. | `rynth/vt/settings/cells.js:173` |
| `weakest()` / `creaturegetweakest` | The element with the HIGHEST ACE damage multiplier (deliberately not C# GetWeakest, which picks the most resisted one). | `rynth/vt/combat/creature_profiles.js:195` |
| `/rs jump <n>`, `/vt jump <n>` | `<n>` is the heading (G:220, like `/rs addnavjump <n>`); `/ra`, `/ub` and `jump[swzxc]` keep the UB hold-time reading. PLAN R18 updated. | `rynth/vt/cmd/rs_commands.js:158` |
| Give-all stop | `/ra givea… stop` (`givea`, `giveap`, `giveaxp`, `giveapp` / `gap`, `givear`) cancels the queued gives (C# CancelGiveQueue). | `rynth/vt/cmd/compat_commands.js:156` |
| Legacy WarSpellMode | The bot's own war pick runs only while the DEFAULT row's S / arc / Damage Type are unedited; an edit is honoured. PLAN §3.9 step 5 updated. | `rynth/vt/combat/attack_planner.js:593` |
| Rebuff When Idle | The idle window is capped at `duration/2 − RebuffSecondsRemaining` per landed buff, so large settings never recast fresh buffs in a loop. | `rynth/buff_loop.js:774` |
| Tells | A chat line of any known category other than TELL (2) is not read as a tell (an emote can print `You think, "…"`); category 0 is still accepted (hosts without the category, the read-only self-tell test). | `rynth/control_channel.js:207-208` |
| Profile switch vs the running meta | A profile that names the meta already running leaves it running (state, call stack, timers); a different meta still loads. | `rynth/vt/index.js:721-725` |

Other review fixes that change what a user sees: a meta `setmotion[]` cannot press a key
while the bot is STOPPED or in portal space, and every pressed key is released on STOP, on
entering portal space and on `bot.stop()` (`rynth/vt/cmd/stdlib_host.js:580-583`); the
page-level dispatcher (no bot, or `?botVt=off`) refuses `/ub delay`, a multi-stack
`/ra give…` and a `/mt loot` retry, because nothing pumps its queue (`rynth/vt/rs_entry.js:185`);
the SwitchWandsToDebuff pre-swap weapon lives in the page session, so a rebind mid-debuff
still puts it back (`rynth/vt/index.js:372`); metas see `getvar[navreversed]` and
`getvar[navlastresult]` (`rynth/vt/index.js:416-417`; `nav save` clears the reversed flag and
the var, `rynth/vt/nav/active_nav.js:420-422`); `delayexec[]` is an error in a monster
expression (`rynth/vt/index.js:194-198`); global meta variables merge across tabs.
Kept at the plan's behaviour, owner may flip (HANDOFF §4): `&&` / `||` yield a Bool;
bitwise operators bind below comparisons; the meta watchdog distance is 3-D; `GetOpt` of an
unknown option stores 0; `'' < 5` is true; `/ub opt set VTank.PatchExpressionEngine true` is an
unknown option.

**Known gaps and owner follow-ups.**

1. **Pre-existing B11 buff stall** (`impl/int2-review.md` R6; the same code is at `a33dcb16`):
   after the login batch rebuff lands, the kernel stops selecting Buffing before the pass
   ends, so `_forceRebuffing` stays set and a desired buff no longer rebuffs on its timer
   until `setBuffs` / `forceRebuff` / `cancelForceRebuff`. Owner: `buff_loop.js`.
2. **Hidden tab after a teleport** (review runtime-4): `scene3d/portal_space.js` advances
   only on the page's frame loop (rAF, or the opt-in `?netDrainHz` interval), so on a hidden
   tab the portal-space flag stays up after the arrival and the combat, loot, buff and vitals
   loops and VT nav hold until the tab is shown (only the base router has its own 90 s cap,
   `rynth/portal_gate.js` `PORTAL_SPACE_MAX_HOLD_MS`). VT-only stopgap: one synthesized
   `portalOut` 90 s after the arrival (`rynth/vt/host_signals.js:59`), so metas see the exit;
   movers still hold. Root fix (tick the sequencer from the hidden-tab pump) is outside
   `rynth/vt`.
3. **Inventory re-click**: clicking the same inventory item again after a world click emits
   no selection event (`plugins/inventory.js` early return, pinned by
   `tests/rynth_vt_page_seams.test.mjs`), so `/mt cast` without "on" keeps the world
   selection. Fix: a separate per-click event.
4. **Decal synthetic `.utl` keys** are only partly mapped (`rynth/vt/glue/loot_ctx.js`); an
   unknown one reads as unknown (logged once).
5. **IdleRebuff starts a full B11 batch**: one windowed buff tick that finds a buff inside
   the window starts the existing batch rule, which recasts every desired buff to align
   timers (`impl/int1.md` open issue 2; live L-O5).
6. **Jump heading** (guide-7, uncertain): jumps turn with the raw `TurnToHeading` in
   `goto_compose.js` `attemptJumpLeg` (`:840`, `:877`), outside `webhost.js`
   `HEADING_CONVENTION` (`:487`). Identical while the convention is the identity; if L-H1
   changes the constant, switch `attemptJumpLeg` to `TurnToCompassHeading`.
7. **Live-only questions** (HANDOFF §5): the heading convention and whether wasm
   `turnToEntity` works without `?wasmPursuit=on` (L-H1); the recall cast form (Q19, L-N2);
   jump shift = walk or run (Q2); the vendor window on both laps; ACE's "You cast" line for
   Corruption / Corrosion only on a hit; the stance after wand swaps (L-M5); buffed vs base
   skill for the school cap; the empty mana-stone appraisal and destroy text (L-O9); pet
   strings and PetOwner (L-O10); enchantment `level` populated and Eradicate removing the
   vuln (L-O7); the door Ethereal flip, lockpicks, grenades and peas on vanilla ACE (L-C2);
   peace-mode thrash (L-O4); indoor routes (L-N4); untargeted rings (L-R1; off by default
   because an untargeted non-SelfTargeted cast crashes vanilla ACE).
8. Smaller: the gitignored `shell/` bundle predates the `webhost.js` edits — run live checks
   through serve.py or with `?shell=off`; every HUD page now lazily imports `rs_entry.js` and
   the `cmd/` and `settings/` modules after mount (measure in L-PERF); a category-0 chat line
   that starts `You think, "` is still read as a self-tell (no ACE path found).

### Live verification (PLAN §7.4)

**PENDING.** The 1070 was offline on the night of 2026-10-12/13 (tailscale "offline", ssh
timeout; `watch1070.sh` reported UNREACHABLE and `gate1070.sh` refused), so nothing was
launched. The run uses the 1070's off-screen, muted test Chrome behind the presence gate,
local ACE with `ACE_Log.txt` tailed for the whole campaign (any unhandled exception fails
the item and stops the run), L0 first and L-R1 last. Runbook: `live/LIVE_PLAN.md` in the
project folder (results go to `live/RESULTS.md`, not written yet). The orchestrator fills in
this table after the live run.

| ID | Check → pass criterion | Result |
|---|---|---|
| L0 | `rynth_test_all.cjs` fast set on the 1070, then 10 min grind with the default layer vs `?botVt=off` → smokes green, action histograms within noise, no new console errors | pending |
| L-H1 | `TurnToCompassHeading(0/90/180/270)`, then step forward → bearing within 10°; confirms or corrects `HEADING_CONVENTION` (and `attemptJumpLeg`, gap 6) | pending |
| L-CMD | `/rs help`, `/vt opt get AttackDistance`, `/rs opt set AttackDistance 0.0833` from the chat bar, a nav Chat point, a meta Chat action and `!bot rs …`; `/mt foo` → no `@rs`/`@vt`/`@mt`/`@ub`/`@ra` in the ACE log; MonsterRange 20 takes effect | pending |
| L-O1 | Run Macro from the panel, the HUD and `!bot pause`; Force Buff, pause mid-sequence, resume → resumes where it left off (G:10) | pending |
| L-O2 | Boost Loot, two mobs, kill one → its corpse is looted before the second is engaged (G:35) | pending |
| L-O3 | Boost Nav gentle, then strict, on a Circular route through a spawn; a buff drops below threshold mid-lap; HUD "stop moving" mid-leg → gentle walks past unlocked mobs and fights back when hit, strict walks; both stop to rebuff and let a loot already started finish, then resume the lap; "stop moving" leaves VT nav paused until Nav / `nav start` | pending |
| L-O4 | Peace Mode When Idle → NonCombat after the kill; ≤ 1 stance change per idle period with top-off and buffs pending | pending |
| L-O5 | Rebuff When Idle (window 600 s) → batch recasts while idle when < 15 min remain | pending |
| L-O6 | Autostack / Autocram with test stacks → merges respect max stack; items go to the emptiest side pack; Items-tab items stay | pending |
| L-O7 | A second account casts a level-7 vuln on us → gem used / Eradicate Life Magic Self cast targeted at self; ACE log clean | pending |
| L-O8 | A second account tells `xp` → recruited when visible; "come closer" when not | pending |
| L-O9 | Bot held, a worn item < 25 % mana, a charged stone in the pack → refilled while held; empty stones never used on gear | pending |
| L-O10 | Summon Pets with two essence elements and the PetDmg column → summons at ≥ PetMinMonsters within pet range; element matches | pending |
| L-P1 | Edit on Default (banner; lost on reload); Save As; `[By char]`; Mine Only; reload with `?bot=1` and with HUD START; two characters in two tabs → values persist and apply; per-character isolation; Default never written | pending |
| L-V1 | Melee alt with kits, TopOffHP 95 → kits used when spells are unavailable; the valve stops on no progress | pending |
| L-M1 | P −1 on one mob; P 4 vs a closer P 1; expression `range>5` switching entries → never engages the P −1 mob (nor counts it as "in combat"); P 4 first; the entry switches with range (G:109) | pending |
| L-M2 | Caster: I, V(Fire), F, B, G, Y, WC / FC / DC + Cp / Cs → debuffs land in order, all targeted; no 30 s blacklist after 3 debuffs; recast after expiry; ACE log clean | pending |
| L-M3 | A off (debuff-only) → the kernel unpins after the debuffs; target revisited after expiry | pending |
| L-M4 | S streak, Damage Type Cold, Ex. Vuln Acid, WarSpellMode vtank → correct spell names in chat | pending |
| L-M5 | Weapon / Offhand per monster; SwitchWandsToDebuff on the melee alt → wand → debuffs → weapon back; ≥ 3 s between swaps; no mode-toggle stand-down | pending |
| L-R1 | **Crash risk, run LAST, ACE restart procedure ready:** `AllowUntargetedRings=true`, WR with ≥ 4 mobs in RingRange → the ring casts and ACE stays up; on any ACE exception keep the default off and record the stack | pending |
| L-I1 | Items: Add from the inventory selection; Add (No Buffs); the re-click order (gap 3) → entry has kind / element; no item buffs on the No-Buffs item | pending |
| L-C1 | A buff item < 5 min; a ≥ 5 min item when its family runs low → rejected / used | pending |
| L-C2 | Grenades, pea splitting, a lockpick door (OpenDoors + AutoUnlockDoors) → each works or is recorded as unverified on vanilla ACE | pending |
| L-N1 | Circular, Linear (A B C B A), Once (route empties, nav stays enabled), Follow (second account) → per PLAN §2.8 | pending |
| L-N2 | Pause, Chat (`/rs echo hi`, `/ls`, plain text), Open Vendor on a Circular route (same vendor, two laps), Portal/NPC, NPC Talk, Recall (fires without walking), Checkpoint, Jump (+ strafe) → each completes; the vendor window really opens on both laps; Pause never triggers unwedge; no `@rs` in the ACE log | pending |
| L-N3 | Vitals and combat while walking a VT route → heals and fights mid-route, resumes at the same index | pending |
| L-N4 | Insert Above / Below, green arrow, ▲▼, delete the active row; nav save / load overwrite; a corpus `.nav` with `jmp` + `chk`; an indoor dungeon route → correct; indoor arrival works or is recorded as a known gap | pending |
| L-ME1 | The guide runback meta (G:296-319) built in the panel; die to an `@create` mob → full cycle Default → dead → back → Default | pending |
| L-ME2 | Corpus metas (BGAugGem, ColRings, blodetetdict3) → start in Default; CallState returns to `ret`; ChatCapture vars; ColRings view buttons work; DestroyAllViews closes | pending |
| L-ME3 | Watchdog during a portal tunnel and while held → no false fire | pending |
| L-S1 | Operator STOP mid-route and mid-meta; reload ⇒ held; RESUME; takeover rebind mid-route → nothing moves while held; SecsInState resets, (P) does not; same nav index and meta state after the rebind | pending |
| L-S2 | Hidden tab 10 min with a meta and a route running → cadence and progress continue (Worker heartbeat; after a teleport see gap 2) | pending |
| L-PERF | Bot off / panel closed, then bot on at Default → rAF frame time unchanged; host tick handler < 1 ms at Default; the HUD's lazy `rs_entry.js` import measured | pending |

## 2026-10-12 update — RynthSuite on the October client, code review, and the HUD

The bot code had barely moved since 2026-07-24 while ~70 client commits reworked movement
(per-object MoveTo spine, portal space, doors in the movement step), melee (ACE charge +
auto-repeat), casting (stop-before-cast, retail cast lock, ~7 s level-8 windups) and loot.
Six parallel slices (movement/nav, combat, magic/buffs/vitals, host/loot/economy/control,
AI director, HUD) re-verified every seam against the current Rust/JS, fixed the drift, and
code-reviewed their files; a `/code-review` pass over the combined diff found 17 more
issues (all fixed except one design note). Highlights:

- **Movement**: routes hold through portal space instead of walking the body into
  unbuilt cells (`portal_gate.js`); recall enters Magic mode first; egress waits for a door
  to really open; a hung nav sidecar can no longer freeze `goto()` (20 s timeout).
- **Combat**: one attack per engagement on ACE's auto-repeat loop, engage ranges inside
  the 15 m charge limit, `CancelAttack` on re-target, the combat event plane actually
  subscribed (it was dead on the kernel path), `hunt_stop` honoured under netBrain, and a
  RynthAi-style **no-damage blacklist** (3 casts / 20 s melee → 30 s park).
- **Magic**: cast resolution on UseDone / registry / kind=13 refusals (no false tier walks
  on 7 s Incantations), real tier-7/8 ladders, best-tier heals, refusal classes
  (components / mana / place), and casts targeted at self.
- **Host / loot / economy / control**: a hidden tab now sends casts and attacks (host
  pump), confirmations are no longer eaten by the observation, retail vendor prices,
  whole-stack sells, true free-slot math, loot retries on YoureTooBusy and closes corpses,
  self-tells accepted, relogins disconnect cleanly.
- **One operator authority**: `bot.control` (stop / resume / setAi / setEnabled /
  state) behind the HUD, `!bot pause` and `rynthAI.start/stop`; the stop latch is per
  character and survives reloads; a reconnect carries the live settings over and no
  longer leaves the old director spending on a dead session.
- **HUD**: `plugins/rynth-hud.js` — the RynthAi dashboard in our GUI, launched from the
  ⚒ beside the toolbar (rynth/README.md §HUD).
- **P0 found live**: a buff tier upgrade picked an "…Other" spell and sent it untargeted,
  which crashes vanilla ACE (`CreateEnchantment(null)`); fixed in the bot (targeted-at-self
  only, no non-self upgrades) — ACE itself is unchanged (keep-ACE-vanilla).

A second `/code-review` pass over the post-review delta found 14 more (11 fixed: the
no-damage blacklist now judges RESOLVED casts and counts evades/resists as contact and
never parks a creature that is attacking you; STOP during an AI approach resumes
correctly; an AI-paused kernel stays paused across STOP/RESUME; no origin-wide stop key
is ever written; "auto" buffs survive a reconnect; recall honours STOP; three smaller
ones). Live testing also found the combat scan's July same-landblock gate (a mob 5 m
away across a seam was invisible) and a stale bound-method cache in the
`rejection_feedback.js` handle proxy (monkeypatched handle methods were ignored) — both
fixed with tests.

Verification: rynth node suite **66/66** (baseline before the update: 54 pass, 1 fail);
full JS gate **532/532** (incl. 4 newly registered rynth/HUD tests); live on the 1070
(off-screen, muted, presence-gated) — 20 rynth smokes pass (webhost, phase1, trio, combat,
loot, buff, bot_boot, p12, giveup, vitals, control, router, supervisor, loop, kernel,
batch, item, ladder, melee, p3; three needed stale-smoke fixes: the control channel's
owner allowlist, a never-started host's guid, the proxy cache), and a final recheck of
combat/loop/buff/bot_boot/control on the finished code passes 5/5; plus HUD sessions
(toolbar ⚒ → open → START → fight + loot → Buff → STOP → reload boots held → RUNNING)
— screenshots + run logs in `/mnt/wbterminal1/rynth-update-2026-10-12/`.

Open: the portal-space gate is still repeated per mover (a kernel-level hold would cover
them all); `_pumpIfStale` works around a wasm send path that should flush its own queued
stop+action; housing barriers and server-MoveTo ownership need small wasm exports
(move-slice requests R1/R2); a non-cast UseDone landing inside a buff's pending window
can still be credited to the buff; a HUD Restart whose createGrindBot throws leaves no
bot (the old one is already retired, by design); vitals/buff duplicate their Magic-entry
valve (refactor candidate); contact-by-name counts damage on a same-named creature.

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
| **4 — parity** | beyond the four loops | 🟡 PARTIAL | vitals, fleet, control, fellowship done; meta-scripting deferred — STALE 2026-10-13: meta scripting and the rest of the VTank guide are built in `rynth/vt/` (gate green, live checklist pending; §2026-10-13 update) |

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
   **STALE 2026-10-13:** built — the expression engine (`rynth/vt/expr/`) and the meta
   engine (`rynth/vt/meta/`) are part of the VTank layer; the live meta checks (L-ME1..3)
   are pending (§2026-10-13 update).
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
