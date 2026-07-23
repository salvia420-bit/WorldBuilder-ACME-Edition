# rynth/ — RynthSuite bot brain, ported to holtburger-web

The RynthAi bot (RynthSuite, ~51.5k C# lines driving the retail acclient) reimplemented
against holtburger-web through the reimplemented `RynthCoreHost` seam.

Strategy, evidence, and phase plan (corrected 2026-07-23, rynth-review 16 B2: the old
`../../docs/rynth-integration/` pointer resolved to `apps/holtburger-web/docs/rynth-
integration/`, which does not exist — off by one directory AND missing the
`workflow-reports/` subdir):
- **Current state, start here** — `../../../docs/rynth-integration/STATUS.md` (delivery
  status, refreshed 2026-07-23: module counts, the AI director/stream/NavAtlas/omnibus
  sections, and a pointer into the 2026-07-23 remediation review below).
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
  buffs: [2, 24],              // self-buff spell ids to maintain
  priorities: { olthoi: 10 },  // T8 monster-name -> priority
  loot: { minValue: 0 },       // Value(19) loot threshold
  vitals: { healAtCombat: 60 },// B16 threshold overrides
  control: { prefix: "!bot" }, // in-game tell control
});
bot.status();  // { action, kills, looted, buffs, vitals }
bot.stop();
```

## Modules

| File | Role | Contract source |
|---|---|---|
| `webhost.js` | The **seam** — `RynthCoreHost` reimplemented in-page: frozen per-tick snapshot on a Web-Worker heartbeat, `has()` capability plane, per-decision reads pass-through, actions fire-and-forget, the push-event plane (`onEvent`). ~45 members. | synthesis §2, reports 04/05 |
| `combat_loop.js` | Target select (T9 lock+stickiness, T10 scan-grace, T2 filter incl. `ObjectIsAttackable`), cast serializer (P2/P5/E4), P3 magic face-settle, T8 priorities, P12 damage-learning + kill prediction, equipment-derived mode. | report 11 T/P/E rules |
| `buff_loop.js` | Self-buff maintenance — B1 login gate, B2 family-keyed registry truth, B3 rebuff 300s, B6 permanent, B8 confirm, B9 no-show valve, B13 re-sync, B14 pacing. | report 11 B-rules |
| `vitals.js` | B15 emergency HP override + B16 in-combat/idle heal/mana/stam thresholds. | report 11 B15/B16 |
| `loot_loop.js` | Corpse scan → approach (MoveToPosition + progress watchdog) → open → Value-rule → moveItem → confirm. | report 03 Tier-4 |
| `kernel.js` | **BotKernel** — one loop-tick per kernel-tick (gates never contended), priority Vitals > Combat > Loot > Buff, ownership pinning + combat preemption. | report 12 |
| `router.js` | Local leg executor — walk a route ([{lb,x,y,z,portal?}]) as `moveToPosition` legs with world-frame arrival detection; distinguishes on-foot seam crossings (<30 m world jump on a landblock change → keep walking) from real portals/teleports (≥30 m → settle + advance). The in-page half of report 09's nav. |
| `global_router.js` | **GlobalRouter** — JS client for the RynthNav sidecar (`../../rynthnav-sidecar`, :8767): `route(from,to)` HTTP contract + the plan→walk→replan loop over `router.js` (fresh route from current pose on a FAILED leg). | report 09 Option A |
| `control_channel.js` | Remote control over in-game tells (`!bot status\|pause\|resume\|come\|goto <ns> <ew>`), parsed off the push-event plane, replies via `InvokeChatParser`. `goto` needs `config.nav`. | report 04 push plane |
| `bot.js` | `createGrindBot()` — wires all of the above on a SessionHandle. `config.nav = { endpoint }` adds `bot.goto(to)` (pauses the grind, plans+walks via the sidecar, restarts the kernel on completion — unlike `travel()`, which leaves it stopped). | — |

## Regression suite

`../rynth_test_all.cjs` runs the smokes in sequence with reap-window pacing:
`NODE_PATH=<playwright> node rynth_test_all.cjs` (fast set) or `--full` (adds the
long grind/loot/kernel/fullstack runs); `--only=a,b` for a subset. Prereqs: ACE +
serve.py + wsbridge + the rynthnav sidecar (:8767, `../../rynthnav-sidecar`) + a
**release** wasm build in `pkg/`.

## Live-verified traps (all encoded)

- ACE silently reverts a Melee-mode request when a bow/wand is wielded → use the
  equipment-derived suggested-mode toggle, never a blind `setCombatMode`.
- Untargeted (self-buff) casts also require Magic mode (`Player_Magic.cs:279`).
- Enchantment `start_time`/`duration` are **Derethian-epoch** seconds → remaining time via
  the `Enchantment.cs:100-104` receivedAt formula, not `serverTime` diffs.
- `?autoLogin=1` is single-shot; the Account-In-Use kick dance needs reload-retry.
- Release wasm (`--release`) before headless campaigns — the 18 MB dev wasm's memory
  tax destabilizes the tab.
- Pose for the brain comes from wasm world state (AC Z-up, landblock-local) — never
  three.js render coords.
- The MoveTo servo has **no obstacle avoidance** — a route through un-baked geometry
  grinds on walls forever with `pursuitStatus` stuck ACTIVE (live-proven at Holtburg).
  Avoidance comes from the sidecar's navmesh: bake with `--geom` (statics+scenery),
  never trust terrain-only tiles in towns.

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
| `ai/combat_memory.js` | Hygiene-only fixes landed 2026-07-23; **still parked** | Kill-truth conflict unresolved: `combat_loop.js`'s kernel-driven P12 polls `TryGetTargetHealthFraction===0` against a guid-locked target (authoritative, guid-keyed); `CombatMemory`'s kill count is a `KILL_SEVERITY`-crossing estimate keyed by creature **name** (approximate by the module's own admission). Wiring `attach(host)` today would make it a **second** `host.onEvent` subscriber for the same kind=19 stream, with no reconciliation between the two kill counts. Separately, kind=19 currently has **zero** live consumers at all — the kernel drives loops via `.tick()` and never calls the `startOn()` that subscribes `combat_loop`'s own `_onCombatEvent`, so even the "existing" consumer is dormant. **Added this pass:** an LRU cap (`MAX_TRACKED_NAMES=512`, same Map-insertion-order convention as `indoor_router.js`'s `_floorPlaneByCell`) on the previously-unbounded `byTarget`/`byAttacker` maps, and a header PARKED banner spelling out the conflict above. **Do not wire** until one kill-truth is picked (almost certainly `combat_loop`'s) and the `startOn()`/kernel event-subscription seam itself is reconciled. | rynth-review parts/11.md, parts/12.md §1.1, 17-SYNTHESIS.md |
| `ai/heal_reflex.js` | Pre-wiring fixes landed 2026-07-23 | Was: a diverged vitals accessor, no give-up valve, no shared cast-token claim — **all fixed**: `_hpPct()`/`_defaultSkillOk()` now read `host.s.playerStats()`'s raw stride arrays directly, the same path `vitals.js`'s own `_fractions()` uses (not the separate `TryGetPlayerStats()` normalization it read before); a give-up valve mirroring `vitals.js`'s `NO_PROGRESS_LIMIT`/park pattern now stops it from burning the whole kit/food stack when HP isn't actually improving; it now calls `host.tryClaimCast("heal_reflex")` before using a kit/food item, so it can't stomp an in-flight vitals/buff cast (or vice versa). It is item-based (`UseItemOnTarget`/`UseObject`), so it is NOT subject to the wasm's Magic-mode/caster-item gate the way `vitals.js`/`buff_loop.js` are — but it has its own hard limit (no kit or food in the pack ⇒ it cannot heal, same shape as a true non-caster being unhealable by a spell) and must stay consumable-only; do not extend it toward spellcasting, that walks back into the exact caster-mode refusal `vitals.js` already had to build a valve around. Still `enabled:false` by default and not registered in the kernel — remains a deliberate, gated wiring decision. | rynth-review parts/02.md, 17-SYNTHESIS.md |
| `ai/confirm_reflex.js` | Boundary re-verified and documented 2026-07-23 | Review 02 raised (then itself resolved) a suspicion that this double-confirms what `buff_loop.js`'s B8 already confirms. Re-verified here by `rg` against the live tree: `buff_loop.js` never calls `TryGetPendingConfirmations`/`SendConfirmationResponse` anywhere — B8 confirms a landed self-buff purely by re-reading the enchantment registry ~600 ms after casting; this module answers actual server confirmation **dialogs** (allegiance/skill/attribute/augmentation/fellowship/craft/yes-no) over a disjoint host API. **No overlap, no double-confirm** — now stated directly in the module's own header (not just a review doc) as the scope boundary future changes must respect. No wiring blocker beyond the general "not yet gated into the kernel" default; kept dark. | rynth-review parts/02.md ("VERIFIED NON-ISSUE") |
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
