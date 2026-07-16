# rynth/ — RynthSuite bot brain, ported to holtburger-web

The RynthAi bot (RynthSuite, ~51.5k C# lines driving the retail acclient) reimplemented
against holtburger-web through the reimplemented `RynthCoreHost` seam. Strategy, evidence,
and phase plan: `../../docs/rynth-integration/` (start with `16-synthesis.md`).

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
| `combat_loop.js` | Target select (T9 lock+stickiness, T10 scan-grace, T2 filter incl. `ObjectIsAttackable`), cast serializer (P2/P5/E4), T8 priorities, P12 damage-learning + kill prediction, equipment-derived mode. | report 11 T/P/E rules |
| `buff_loop.js` | Self-buff maintenance — B1 login gate, B2 family-keyed registry truth, B3 rebuff 300s, B6 permanent, B8 confirm, B9 no-show valve, B13 re-sync, B14 pacing. | report 11 B-rules |
| `vitals.js` | B15 emergency HP override + B16 in-combat/idle heal/mana/stam thresholds. | report 11 B15/B16 |
| `loot_loop.js` | Corpse scan → approach (MoveToPosition + progress watchdog) → open → Value-rule → moveItem → confirm. | report 03 Tier-4 |
| `kernel.js` | **BotKernel** — one loop-tick per kernel-tick (gates never contended), priority Vitals > Combat > Loot > Buff, ownership pinning + combat preemption. | report 12 |
| `router.js` | Local leg executor — walk a route ([{lb,x,y,z}]) as `moveToPosition` legs with arrival detection + portal (landblock-change) recognition. The in-page half of report 09's nav; the global navmesh router is the deferred sidecar. |
| `control_channel.js` | Remote control over in-game tells (`!bot status\|pause\|resume\|come`), parsed off the push-event plane, replies via `InvokeChatParser`. | report 04 push plane |
| `bot.js` | `createGrindBot()` — wires all of the above on a SessionHandle. | — |

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

## Language-fork note (D1)

The bot ships as JS today (this directory). The `.NET-wasm` path (compile the
island-excised C# brain in-page behind this same seam) is de-risked — see
`../../docs/rynth-integration/netwasm-spike/`. Either way `webhost.js` is the seam.
