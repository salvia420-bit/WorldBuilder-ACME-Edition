# rynth/ — RynthSuite bot brain, ported to holtburger-web

The RynthAi bot (RynthSuite, ~51.5k C# lines driving the retail acclient) reimplemented
against holtburger-web through the reimplemented `RynthCoreHost` seam.

Strategy, evidence, and phase plan (corrected 2026-07-23, rynth-review 16 B2: the old
`../../docs/rynth-integration/` pointer resolved to `apps/holtburger-web/docs/rynth-
integration/`, which does not exist — off by one directory AND missing the
`workflow-reports/` subdir):
- **Current state, start here** — `../../../docs/rynth-integration/STATUS.md` (delivery
  status, refreshed 2026-07-23: module counts, the AI director/stream/NavAtlas/omnibus
  sections, and a pointer into the 2026-07-23 remediation review below; newest sections at
  the top — 2026-10-12 the October client + HUD, 2026-10-13 the VTank feature set in `vt/`).
- **Original porting-strategy synthesis** (the "16-synthesis.md" this pointer used to
  mean) — `../../../docs/rynth-integration/workflow-reports/16-synthesis.md`, plus the
  full 15-report fan-out in that same `workflow-reports/` directory.
- **2026-07-23 coherence review** (16-agent code review of the whole current rynth/AI-
  director/stream stack — arbitration gaps, doc drift, dead config) — evidence and
  per-report findings at `/mnt/wbterminal1/rynth-review-2026-07-23/rynth-review/parts/`
  (`17-SYNTHESIS.md` is the entry point); the fix wave this spawned is tracked inline in
  `STATUS.md`'s "2026-07-23 remediation" section above.
- **Omnibus buildbox fan-out** (nav guards, wasm survival, dark Mag cores, observation
  budget) — `../../../docs/rynth-integration/HANDOFF-omnibus-2026-07-21.md` (read the
  ✅ STATUS UPDATE banner at its top FIRST — the title says "PENDING" but it's applied)
  and its evidence archive at `/mnt/wbterminal1/omnibus/p1/` (Phase-1 research, 16
  reports) and `/mnt/wbterminal1/omnibus/p2/` (Phase-2 implementation, per-package
  reports + diffs).

Every module is independently live-verified against local ACE — the harnesses are the
`../rynth_*_smoke.cjs` files (run with `NODE_PATH=<playwright> node rynth_<x>_smoke.cjs`
against serve.py + wsbridge + ACE; boot via `rynth_boot_helper.cjs`).

## One-call entrypoint

```js
import { createGrindBot } from "/apps/holtburger-web/rynth/bot.js";
const bot = await createGrindBot(window.__sessionHandle, {
  buffs: [2, 24],              // self-buff spell ids (family names: B4 upgrades to the best known SELF tier), or "auto"
  priorities: { olthoi: 10 },  // T8 monster-name -> priority
  loot: { minValue: 0 },       // Value(19) loot threshold
  vitals: { healAtCombat: 60 },// B16 threshold overrides
  combat: { magicRangeM: 15 }, // RynthCombatLoop tuning (ranges, height/power, blacklist)
  control: { prefix: "!bot" }, // in-game tell control
  // vt: false,                // no VTank layer (default: loaded; ?botVt=off) — vt/README.md
});
bot.status();            // { action, kills, looted, buffs, vitals, router }
bot.control.stop();      // the ONE operator stop (durable per character) — HUD / !bot pause use it
bot.control.resume();
await bot.setBuffs("auto"); // replace the self-buff set at runtime ([] = none)
bot.vt?.statusLine();    // the VTank layer (vt/README.md): "VT · profile Default · …"
bot.stop();              // tear the bot down (disposes the AI layer and the VTank layer too)
```

Normally you don't call this yourself: `?bot=1` boots it at first in-world, and the
**RynthSuite HUD** (⚒ beside the toolbar, or Shift+F12) boots it on demand with START —
both through `boot.js`.

## Modules

| File | Role | Contract source |
|---|---|---|
| `webhost.js` | The **seam** — `RynthCoreHost` reimplemented in-page: frozen per-tick snapshot on a Web-Worker heartbeat, `has()` capability plane, per-decision reads pass-through, actions fire-and-forget, the push-event plane (`onEvent`). ~45 members. | synthesis §2, reports 04/05 |
| `combat_loop.js` | Target select (T9 lock+stickiness, T10 scan-grace, T2 filter incl. `ObjectIsAttackable`), cast serializer (P2/P5/E4), P3 magic face-settle, T8 priorities, P12 damage-learning + kill prediction, equipment-derived mode. | report 11 T/P/E rules |
| `buff_loop.js` | Self-buff maintenance — B1 login gate, B2 family-keyed registry truth, B3 rebuff 300s, B4/B5 tier ladders, B6 permanent, B8 confirm, B9 no-show valve, B13 re-sync, B14 pacing. A lower tier standing at login only delays the upgrade to its rebuff window (registry tiers guard the upgrade test, as C# IsBuffActive; the ladder cap comes only from our own cast landing below its tier); an upgrade is confirmed only by a new entry (under a lower tier that outlives it, by the cast's own row or ACE's clean UseDone), and a tier walked down after 3 fizzles is retried after 10 min. Opt-in `opts.skillCap` / `setSkillCap(fn)` (off by default; the VT option `BuffTierSkillCap` sets it, `vt/index.js`): each family resolves to the best known tier its school's buffed skill reaches (`skill_cap.js`). | report 11 B-rules; rynth-macro-nav-1, -4 |
| `vitals.js` | B15 emergency HP override + B16 in-combat/idle heal/mana/stam thresholds. Recovery spells resolve to the highest known tier; a tier demoted after 3 fizzles comes back after 10 min. Opt-in `opts.skillCap` / `setSkillCap(fn)` (the VT option `BuffTierSkillCap`) caps every axis (B15 included) at the buffed Life Magic tier. | report 11 B15/B16; rynth-macro-nav-4 |
| `skill_cap.js` | The buffed-skill tier rule (RynthAi ComputeTier, thresholds 35..435): `createHostSkillCap(host, {tiers})` → `fn(school)`, shared by the VT attack planner and the opt-in buff/vitals cap. | rynth-macro-nav-4 |
| `loot_loop.js` | Corpse scan → approach (MoveToPosition + progress watchdog) → open → Value-rule → moveItem → confirm. ACE's corpse refusals (transient strings: no loot rights yet / rare or PK kill / already in use) end the corpse at once — parked, parked while in view, or skipped 10 s (parked on the 3rd). | report 03 Tier-4; rynth-macro-nav-2 |
| `kernel.js` | **BotKernel** — one loop-tick per kernel-tick (gates never contended), priority Vitals > Combat > Loot > Buff, ownership pinning + combat preemption. | report 12 |
| `router.js` | Local leg executor — walk a route ([{lb,x,y,z,portal?}]) as `moveToPosition` legs with world-frame arrival detection; distinguishes on-foot seam crossings (<30 m world jump on a landblock change → keep walking) from real portals/teleports (≥30 m → settle + advance). The in-page half of report 09's nav. |
| `global_router.js` | **GlobalRouter** — JS client for the RynthNav sidecar (`../../rynthnav-sidecar`, :8767): `route(from,to)` HTTP contract + the plan→walk→replan loop over `router.js` (fresh route from current pose on a FAILED leg). | report 09 Option A |
| `control_channel.js` | Remote control over in-game tells (`!bot status\|pause\|resume\|come\|goto <ns> <ew>`), parsed off the push-event plane, replies via `InvokeChatParser`. `goto` needs `config.nav`. | report 04 push plane |
| `bot.js` | `createGrindBot()` — wires all of the above on a SessionHandle. `config.nav = { endpoint }` adds `bot.goto(to)` (pauses the grind, plans+walks via the sidecar, restarts the kernel on completion — unlike `travel()`, which leaves it stopped). Also `bot.control` (below), `bot.setBuffs()`, `config.startHeld` (boot under a persisted operator stop). | — |
| `portal_gate.js` | `portalSpaceActive(host)` — every mover and caster holds while the client shows portal space (teleport tunnel + destination build hold, up to ~80 s); the router parks in PORTAL instead of walking the body through cells whose collision hasn't landed. | 2026-10-12 |
| `portal_hazards.js` | Portal avoidance for `goto_compose.js`'s indoor graph walks (indoor goto, dungeon entry, portal transit, egress, wedge re-path). **Default off** (`?botPortalAvoid=on` / `opts.portalAvoid`). Every portal within 80 m except the walk's own becomes a disk of reach + clearance (2.3 m), and a leg segment that enters one gets a rim side-step. With no clear detour the legs stay unchanged. Recorded routes and the sidecar's requests are untouched; `sidecarAvoidCircles` is the outdoor half, not wired yet. | rynth-macro-nav-6 (after WebAC `agent/portalAvoid.ts`) |
| `indoor_router.js` doorways | Real-doorway routing for the same graph walks. **Default off** (`?indoorDoorways=on` / `opts.indoorDoorways`). The wasm `takePortalDoorways()` gives each cell's CellPortal polygons (centroid, outward normal, height, floor), stored as `node.doors`. Flag on: the cell search goes through body-sized openings first (an upright opening under 1.83 m — a window, the tavern's bar counter — is used only when nothing else connects), each transition is walked a step before and a step past the real doorway at its floor, and egress leaves through the exit doorway to a point 4 m out along its normal instead of the 9 m projection. A stale pkg (no getter) walks the legacy legs. | rynth-macro-nav-5 (after WebAC `agent/cellPath.ts`) |
| `ai/operator_stop.js` | `OperatorControl` (`bot.control`) — the ONE stop/resume/state authority: kernel operator hold + director stop + travel cancel; a durable per-character latch (`rynthBotOperatorStop:<guid>`) makes a STOP survive reloads/reconnects. | 2026-10-12 |
| `boot.js` | The `?bot=1` auto-boot (URL → createGrindBot config, operator-stop latch, takeover rebind with live-settings carry-over) as one function the HUD's START shares. | 2026-10-12 |
| `hud_bridge.js` | The only file that knows the bot API for the HUD: a pure view-model snapshot + the HUD's commands. | 2026-10-12 |
| `../plugins/rynth-hud.js` | **The RynthSuite HUD** — see below. | RynthAi dashboard |
| `vt/` | **The VTank layer** (2026-10-13): settings profiles, the VTank monster list + expressions, items, consumables, buffs, routes, metas, loot profiles and the `/rs` `/vt` `/ra` `/mt` `/ub` commands, added to the kernel as optional `aux` slots and loop hooks that are inert at the Default profile. `?botVt=off` boots without it. See `vt/README.md`. | PLAN (`/mnt/wbterminal1/rynth-vtank-2026-10-12/design/PLAN.md`) |
| `../plugins/rynth-vt/` | The VTank panel (command bar + 8 tabs; opened by the HUD's **VT** button or `/rs ui`), loaded lazily. | VTank / RynthAi windows |

## The RynthSuite HUD (2026-10-12)

A web port of the RynthAi ImGui dashboard (`LegacyUi/LegacyDashboardRenderer.cs`) in our
retail look: a draggable framed window opened by the **⚒ button beside the toolbar**
(`plugins/hotbar.js` add-on column, outside the retail frame), **Shift+F12**, or the
plugin-bar ⚒ slot. `?rynthHud=off` disables it.

- **RUNNING / STOPPED / START** — START boots the bot on the current character when the page
  wasn't loaded with `?bot=1`; STOP is `bot.control.stop()` (persisted per character: a
  reload boots the bot held until RUNNING is pressed again).
- State / Activity lines, Persona (grind | explorer), Route (atlas routes ▶ follow), Loot ≥,
  and **VT** — opens the VTank panel (its tooltip carries the layer's status line).
- Combat / Buff / Nav / Loot / AI toggles, **FR** force-rebuff (right-click cancels). With a
  VTank route loaded, **Nav** is that route's navigation (Stop moving pauses it until Nav is
  clicked again); otherwise it follows the selected atlas route.
- Target name + health bar, player HP/ST/MN, kills, kills/hr, looted, buffs, uptime.
- Tabs: Monsters (priorities), Settings (vitals thresholds, self-buff list, Auto),
  Navigation (routes, /loc goto, exit building, stop moving), AI (the director panel), Log.

It refreshes at ≤ 4 Hz only while open and visible; the launcher dot (green = running)
polls at 1 Hz.

With a VTank **user** profile selected, START / Restart boot with that profile's values (plus the
HUD persona), and the HUD's own edits (priorities, loot floor, vitals, buff list) are also saved
into the profile; on the Default profile the HUD behaves exactly as before, and on a
`?botVt=off` page START / Restart always use the HUD's own saved settings (`vt/README.md`).

## Regression suite

`../rynth_test_all.cjs` runs the smokes in sequence with reap-window pacing:
`NODE_PATH=<playwright> node rynth_test_all.cjs` (fast set) or `--full` (adds the
long grind/loot/kernel/fullstack runs); `--only=a,b` for a subset. Prereqs: ACE +
serve.py + wsbridge + the rynthnav sidecar (:8767, `../../rynthnav-sidecar`) + a
**release** wasm build in `pkg/`.

**Never run the smokes' local headless Chromium on the 8 GB laptop.** Run them on the 1070's
off-screen, muted test Chrome instead: `NODE_PATH=../../scripts/perf-worker/coldboot/pw1070
node rynth_test_all.cjs …` — the shim answers `require("playwright")`, checks the owner
presence gate (`gate1070.sh`, needs `watch1070.sh` running), and rewrites the smokes'
`127.0.0.1:8765` URLs to the laptop's tailnet front. Node-only unit tests:
`node rynth_test_all_node.cjs`.

## Live-verified traps (all encoded)

- ACE silently reverts a Melee-mode request when a bow/wand is wielded → use the
  equipment-derived suggested-mode toggle, never a blind `setCombatMode`.
- Untargeted (self-buff) casts also require Magic mode (`Player_Magic.cs:279`).
- Enchantment `startTime` is **relative seconds, ≤ 0** — NOT a Derethian-epoch timestamp (this
  note said so until 2026-10-13; `pkg/holtburger_web.d.ts` `PlayerEnchantmentJs.startTime`).
  ACE sends 0 at cast and counts it down per 5 s heartbeat, so a relog re-send arrives as
  `-age`. Remaining = `receivedAt + duration + startTime` with `receivedAt` stamped on OUR clock
  when the row is first seen (`buff_loop.js`, `webhost.js` `TryGetSelfEnchantments`) — never
  a `Date.now()` / `serverTime` diff.
- `?autoLogin=1` is single-shot; the Account-In-Use kick dance needs reload-retry.
- Release wasm (`--release`) before headless campaigns — the 18 MB dev wasm's memory
  tax destabilizes the tab.
- Pose for the brain comes from wasm world state (AC Z-up, landblock-local) — never
  three.js render coords.
- The MoveTo servo has **no obstacle avoidance** — a route through un-baked geometry
  grinds on walls forever with `pursuitStatus` stuck ACTIVE (live-proven at Holtburg).
  Avoidance comes from the sidecar's navmesh: bake with `--geom` (statics+scenery),
  never trust terrain-only tiles in towns.

Added by the 2026-10-12 update (the October client):

- **NEVER send an untargeted cast for a spell that isn't SelfTargeted — it crashes vanilla
  ACE.** The untargeted path keeps a NULL cast target and only `HandleCastSpell`'s
  `IsSelfTargeted` branch substitutes the caster; any other enchantment reaches
  `WorldObject.CreateEnchantment(null)` (WorldObject_Magic.cs:406) and the unhandled
  NullReferenceException on the world thread takes the whole server down. Live-hit twice:
  a B4 tier upgrade resolved "Strength Self I" to "Incantation of Strength Other". Now
  every bot buff/heal is cast TARGETED at the player's own guid, no guid = no cast, and
  B4 never picks a non-self spell for a self buff.
- Every cast and attack queues a retail stop first and is sent on the NEXT movement tick,
  which only the page frame pump drives — a hidden tab sends nothing unless the host pumps
  (`RynthWebHost._pumpIfStale`).
- ACE now charges and auto-repeats melee: send ONE attack per engagement (a request while
  the target lives is ignored), stay within 12 m (the charge fails after 15 m), cancel the
  loop with `CancelAttack` on a re-target. Missile/magic range refusals never walk you closer.
- A server MoveTo/TurnTo (targeted-cast turn, melee charge, use-approach) replaces an
  in-flight client `moveToPosition` — `pursuitStatus === 2` can be someone else's arrival.
- Level-7/8 casts take ~7 s at ACE's CastSpeed 2 — resolve casts on UseDone / the
  registry / a kind=13 refusal, never on a fixed 2.5 s clock.
- A target that takes no damage (e.g. a bolt-transparent admin `@create`) is blacklisted
  after 3 no-damage casts (RynthAi `BlacklistAttempts`) or 20 s of no-damage melee.
- Doors collide inside the movement step now (`?objCollideInTransition`): egress waits for
  the door's Ethereal bit before walking through.
- Tells to yourself read `You think, "…"` — the control channel accepts self-tells. Since
  2026-10-13 it reads a tell only from a chat line of the TELL category (2), or category 0,
  which a host without the category reports: another player's emote (category 4) can print the
  same text (`control_channel.js` `CHAT_CATEGORY_TELL`).

Added by the VTank layer (2026-10-13; `vt/README.md`):

- **`/rs` `/vt` `/ra` `/mt` `/ub` never reach ACE.** `app/slash_commands.js` hands them (the
  chat bar and every `host.InvokeChatParser` line) to `window.__rynthVt`; meta Chat actions and
  nav Chat points run them through the same dispatcher. An unknown verb is a local error, not
  `@verb`. `@rs …` is still sent to the server as typed.
- **VT code casts only through `host.CastSpellAt` / `CastSelf` / `CastUntargetedSafe`** (the
  last refuses anything that is not SelfTargeted — the crash class above — except a War/Void
  ring behind the off-by-default `AllowUntargetedRings` gate), and writes chat only
  with `WriteToChatWindow` — a grep test (T-S1) keeps `CastSpell(` / `WriteToChat(` out of
  `rynth/vt/**` and `plugins/rynth-vt/**`. Item actions take the item-action token.
- The layer runs off the host Worker heartbeat, not page timers (a hidden tab keeps ticking —
  but see the portal-space note below; the only timers are the Jump waypoint's wrapped jump
  and the 3 s boot race), and nothing in it acts while the operator has the bot STOPPED
  (except Mana Charges When Off refills). STOP, portal space and `bot.stop()` also let go of
  any movement key a meta's `setmotion[]` pressed.
- A hidden tab does NOT end portal space after a teleport: `scene3d/portal_space.js` advances
  only on the page's frame loop, so VT nav and the base combat / loot / buff / vitals loops hold
  until the tab is shown (only `router.js` has its own 90 s cap) — pre-existing, an owner
  follow-up (STATUS.md 2026-10-13, gap 2). The VT signals synthesize one `portalOut` 90 s
  after the arrival so metas see the exit.
- With the layer absent (`?botVt=off`), `!bot rs …` runs on the page-level `/rs` dispatcher
  when the page has one, else answers "rs unavailable — the VTank layer is not loaded". That
  dispatcher handles settings and profiles, runs the item / cast / face verbs through the bot's
  host, answers "start the bot first" for route / meta / jump / follow verbs and refuses verbs
  that queue work.

## Dark modules (quarantined)

Five modules are written, unit-tested, and **NOT wired into any live path**:
`loot_policy.js`, `ai/combat_memory.js`, `ai/heal_reflex.js`,
`ai/confirm_reflex.js`, `suit/suit_solver.js`. There is no build system to
exclude them from — this is plain ES modules, loaded only on demand — so
"quarantine" here means two things: (1) this section, and (2) the **absence
of imports**. Verified by `rg` across the live tree (production `.js`/`.html`,
excluding each module's own file and its own `rynth_*_test.cjs`): **zero**
hits for any of the five module names outside their own files and tests (one
harmless comment in `ai/tools/memory.js` that only *mentions*
`combat_memory.js` by name, doesn't import it). No live module imports any of
the five. Do not add one without resolving that module's blocker below first.

| Module | Status | Wiring blocker | Review |
|---|---|---|---|
| `loot_policy.js` | Pre-wiring fixes landed 2026-07-23 | Was 3 unsound seams vs `loot_loop.js`: (1) the appraisal gate only covers `Value(19)`, so tier/armor/rating rules silently read 0 on unstreamed items — **fixed**: non-`valueGE` rules now report `pending:true` (defer/re-appraise) instead of a false 0-comparison when the bag isn't yet appraised (see `isAppraised`/`APPRAISAL_GATED_TYPES` in the file). (2) the verdict vocabulary's only existing precedent dropped `sell` — **fixed**: `VERDICT_ACTION_MAP`/`actionForVerdict()` is now the canonical, exported verdict→action map (`keep\|salvage\|sell → pickup`, `leave → skip`) a wire must consume. (3) `greedy`'s `\|0` truncation diverged from `loot_loop`'s fractional min handling despite a "byte-for-byte" claim — **fixed**: `valueGE` now compares the raw `Number(c.min)`, matching `loot_loop.js`'s plain float compare exactly (comment corrected). Still unwired: nothing in `loot_loop.js`/`bot.js` calls into this module yet — that integration is the next step, now that the three seams above are sound. | rynth-review parts/03.md, 17-SYNTHESIS.md |
| `ai/combat_memory.js` | Hygiene-only fixes landed 2026-07-23; **still parked** | Kill-truth conflict unresolved: `combat_loop.js`'s kernel-driven P12 polls `TryGetTargetHealthFraction===0` against a guid-locked target (authoritative, guid-keyed); `CombatMemory`'s kill count is a `KILL_SEVERITY`-crossing estimate keyed by creature **name** (approximate by the module's own admission). Wiring `attach(host)` today would make it a **second** `host.onEvent` subscriber for the same kind=19 stream, with no reconciliation between the two kill counts. (2026-10-12: kind=19 DOES have a live consumer now — `combat_loop` subscribes lazily from `tick()` because the kernel never calls `startOn()` — so wiring `combat_memory` would make it a SECOND subscriber; it now also treats ACE's `attackDone(ActionCancelled)` as a loop end, not a swing error.) **Added this pass:** an LRU cap (`MAX_TRACKED_NAMES=512`, same Map-insertion-order convention as `indoor_router.js`'s `_floorPlaneByCell`) on the previously-unbounded `byTarget`/`byAttacker` maps, and a header PARKED banner spelling out the conflict above. **Do not wire** until one kill-truth is picked (almost certainly `combat_loop`'s) and the `startOn()`/kernel event-subscription seam itself is reconciled. | rynth-review parts/11.md, parts/12.md §1.1, 17-SYNTHESIS.md |
| `ai/heal_reflex.js` | Pre-wiring fixes landed 2026-07-23 | Was: a diverged vitals accessor, no give-up valve, no shared cast-token claim — **all fixed**: `_hpPct()`/`_defaultSkillOk()` now read `host.s.playerStats()`'s raw stride arrays directly, the same path `vitals.js`'s own `_fractions()` uses (not the separate `TryGetPlayerStats()` normalization it read before); a give-up valve mirroring `vitals.js`'s `NO_PROGRESS_LIMIT`/park pattern now stops it from burning the whole kit/food stack when HP isn't actually improving; it now calls `host.tryClaimCast("heal_reflex")` before using a kit/food item, so it can't stomp an in-flight vitals/buff cast (or vice versa). It is item-based (`UseItemOnTarget`/`UseObject`), so it is NOT subject to the wasm's Magic-mode/caster-item gate the way `vitals.js`/`buff_loop.js` are — but it has its own hard limit (no kit or food in the pack ⇒ it cannot heal, same shape as a true non-caster being unhealable by a spell) and must stay consumable-only; do not extend it toward spellcasting, that walks back into the exact caster-mode refusal `vitals.js` already had to build a valve around. Still `enabled:false` by default and not registered in the kernel — remains a deliberate, gated wiring decision. | rynth-review parts/02.md, 17-SYNTHESIS.md |
| `ai/confirm_reflex.js` | Boundary re-verified and documented 2026-07-23; **2026-10-12: the UI's `plugins/server-confirm.js` now answers the same dialogs — wiring this would double-answer** | Review 02 raised (then itself resolved) a suspicion that this double-confirms what `buff_loop.js`'s B8 already confirms. Re-verified here by `rg` against the live tree: `buff_loop.js` never calls `TryGetPendingConfirmations`/`SendConfirmationResponse` anywhere — B8 confirms a landed self-buff purely by re-reading the enchantment registry ~600 ms after casting; this module answers actual server confirmation **dialogs** (allegiance/skill/attribute/augmentation/fellowship/craft/yes-no) over a disjoint host API. **No overlap, no double-confirm** — now stated directly in the module's own header (not just a review doc) as the scope boundary future changes must respect. No wiring blocker beyond the general "not yet gated into the kernel" default; kept dark. | rynth-review parts/02.md ("VERIFIED NON-ISSUE") |
| `suit/suit_solver.js` | **READY** — assessed exemplary dark code | No blocker found. Pure, host-free, ~0-token (`TryGetPlayerInventory()`'s `equipMask`/`validLocations` only — no appraisal surface touched), self-consistent (`IS_BODY_ARMOR` is derived from and asserted against `ARMOR_SLOTS`, so it can't silently drift), fully covered by its own test. The only caveat: the DEFERRED roadmap's next step ("suit-upgrades DFS") is **not written** — only `coverageGaps()` exists — so that follow-on is unbuilt, not merely unwired; don't assume it's a small step. | rynth-review parts/03.md ("exemplary dark code"), 17-SYNTHESIS.md |

**Reconcile-then-wire order** (17-SYNTHESIS.md's "Dark-core wiring-order
sanity check" — do NOT follow the old DEFERRED plan verbatim, it wires
`loot_policy` into `loot_loop` before the seams above were sound):

1. `suit/suit_solver.js` — wire now; no blocker.
2. `loot_policy.js` — seams fixed this pass; wire `loot_loop.js` to call
   `evaluate()`/consume `VERDICT_ACTION_MAP`, honoring `pending` as a hold
   (same discipline as the existing `Value(19)` appraisal gate).
3. `ai/heal_reflex.js` — accessor/valve/token fixed this pass; wire behind an
   explicit flag once C1 (`vitals.js`'s `ChangeCombatMode(8)` fix — already
   landed) has soaked, since heal_reflex is the non-caster case's rescue path.
4. `ai/confirm_reflex.js` — boundary documented, no functional blocker; wire
   whenever a confirm-dialog need arises.
5. `ai/combat_memory.js` — **last**, and only after the kill-truth conflict
   and the `startOn()`/kernel event-subscription seam (both above) are
   resolved. Wiring it before that just adds a second, disagreeing kill
   counter to a push-event plane that doesn't even reach the live combat
   loop yet.

## Language-fork note (D1)

The bot ships as JS today (this directory). The `.NET-wasm` path (compile the
island-excised C# brain in-page behind this same seam) is de-risked — see
`../../docs/rynth-integration/netwasm-spike/`. Either way `webhost.js` is the seam.
