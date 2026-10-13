// ui/selection_keys.js — input-options-7 (2026-10-13): the rest of retail's
// keyboard selection commands.
//
// CPlayerSystem::OnAction (acclient.c:399450) runs about twenty actions of
// the Selection input map (0x10000007). This client dispatched only the
// monster cycle (Tab / Shift+Tab / T, index.html `__gameplayKeyDown`) and the
// unopened-corpse keys. These are the others. Each is a rebindable action on
// the ONE input funnel keyed by its retail ClientAction id ("0x1000002E" …),
// so its Options → Controls "Game actions" row goes live through
// ui/keymap.js `retailActionStatus` with no table edit.
//
//   id          action                         default here (retail)
//   0x1000002A  Select Self                    unbound   (unbound)
//   0x1000002E  Select Previous Selection      P
//   0x1000002F  Select Closest Compass Item    Backspace
//   0x10000030  Select Previous Compass Item   -
//   0x10000031  Select Next Compass Item       =
//   0x10000032  Select Closest Item            \
//   0x10000033  Select Previous Item           [  (not in magic stance)
//   0x10000034  Select Next Item               ]  (not in magic stance)
//   0x10000038  Select Last Attacker           Home
//   0x10000039  Select Closest Player          /
//   0x1000003A  Select Previous Player         ,
//   0x1000003B  Select Next Player             .
//   0x1000003C  Select Previous Fellow         N
//   0x1000003D  Select Next Fellow             unbound   (M — the world map here)
//
// The defaults are retail's gmDefaultMap keys (portal.dat 0x14000000) where
// this client leaves them free. In magic stance [ and ] stand down: the raw
// spell-tab aliases in plugins/combat-bar.js own them there, and raw
// subscribers and actions both run on the same keydown.
//
// Every key also stands down while a focused HUD control or the open radial
// menu owns it (ui/hud_focus.js `hudOwnsKey`, review I-ui-input-R2): the
// funnel's capture listener runs first, so Backspace on a focused tinker
// slot, Home in the Options tabs / Spell Research list, or radial type-ahead
// would otherwise ALSO move the selection. Retail panels never take focus,
// so there the conflict cannot arise.
//
// The handlers call EntityManager (scene3d/entities.js): `cycleTarget` with
// the player / item / compass-item SELECTION_TYPE (SelectNext,
// acclient.c:397944), `selectPrevious`, `selectLastAttacker`, `selectFellow`
// and `selectSelf`. The same `?targetCycle` flag gates them: `=off` binds
// nothing and the keys pass through. index.html installs them only under the
// input funnel (`?inputFunnelV2=off` keeps the legacy listeners unchanged).
//
// No DOM / three.js dependency at import time — unit-testable under node.

import { retailActionBindingId } from "./keymap.js";
import { hudOwnsKey as defaultHudOwnsKey } from "./hud_focus.js";

/** `?targetCycle` — DEFAULT-ON; only `=off` disables it, like scene3d/entities.js. */
export function targetCycleOn(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    return (new URLSearchParams(s).get("targetCycle") ?? "").toLowerCase() !== "off";
  } catch (_) {
    return true;
  }
}

/** Magic stance (combat-bar.js `inMagicStance`, stance low byte 0x49). */
function defaultInMagicStance() {
  try {
    return globalThis.window?.__getCurrentStanceLow?.() === 0x49;
  } catch (_) {
    return false;
  }
}

const cycle = (mode, type) => (em) =>
  (typeof em.cycleTarget === "function" ? em.cycleTarget(mode, type) : 0);
const call = (method, ...args) => (em) =>
  (typeof em[method] === "function" ? em[method](...args) : 0);
const notInMagicStance = (env) => !env.inMagicStance();

/**
 * The selection actions. `run(em, env)` receives the live EntityManager;
 * `when(env)`, if set, is the action's scope predicate (the funnel's `when`).
 * SELECTION_TYPE values are spelled out ("item", "compassItem", "player") so
 * this table stays free of the scene3d import.
 */
export const SELECTION_KEY_ACTIONS = Object.freeze([
  { action: 0x1000002A, label: "Select Self", defaultBinding: null, run: call("selectSelf") },
  { action: 0x1000002E, label: "Select Previous Selection", defaultBinding: "KeyP", run: call("selectPrevious") },
  { action: 0x1000002F, label: "Select Closest Compass Item", defaultBinding: "Backspace", run: cycle("closest", "compassItem") },
  { action: 0x10000030, label: "Select Previous Compass Item", defaultBinding: "Minus", run: cycle("previous", "compassItem") },
  { action: 0x10000031, label: "Select Next Compass Item", defaultBinding: "Equal", run: cycle("next", "compassItem") },
  { action: 0x10000032, label: "Select Closest Item", defaultBinding: "Backslash", run: cycle("closest", "item") },
  { action: 0x10000033, label: "Select Previous Item", defaultBinding: "BracketLeft", run: cycle("previous", "item"), when: notInMagicStance },
  { action: 0x10000034, label: "Select Next Item", defaultBinding: "BracketRight", run: cycle("next", "item"), when: notInMagicStance },
  { action: 0x10000038, label: "Select Last Attacker", defaultBinding: "Home", run: call("selectLastAttacker") },
  { action: 0x10000039, label: "Select Closest Player", defaultBinding: "Slash", run: cycle("closest", "player") },
  { action: 0x1000003A, label: "Select Previous Player", defaultBinding: "Comma", run: cycle("previous", "player") },
  { action: 0x1000003B, label: "Select Next Player", defaultBinding: "Period", run: cycle("next", "player") },
  { action: 0x1000003C, label: "Select Previous Fellow", defaultBinding: "KeyN", run: call("selectFellow", false) },
  { action: 0x1000003D, label: "Select Next Fellow", defaultBinding: null, run: call("selectFellow", true) },
]);

/**
 * Bind every SELECTION_KEY_ACTIONS row on `funnel` under its retail id.
 *
 * @param {{bindAction: Function}} funnel  ui/input-funnel.js InputFunnel
 * @param {{getEntityManager?: () => object|null, inMagicStance?: () => boolean,
 *   hudOwnsKey?: (ev?: KeyboardEvent) => boolean, search?: string}} [opts]
 *   `getEntityManager` defaults to `window.liveScene3d.entityManager`;
 *   `hudOwnsKey` defaults to ui/hud_focus.js; `search` overrides
 *   location.search.
 * @returns {() => void} unbind all
 */
export function installSelectionKeys(funnel, opts = {}) {
  if (!funnel || typeof funnel.bindAction !== "function") return () => {};
  if (!targetCycleOn(opts.search)) return () => {};
  const getEm = typeof opts.getEntityManager === "function"
    ? opts.getEntityManager
    : () => globalThis.window?.liveScene3d?.entityManager ?? null;
  const env = {
    inMagicStance: typeof opts.inMagicStance === "function" ? opts.inMagicStance : defaultInMagicStance,
  };
  const hudOwns = typeof opts.hudOwnsKey === "function" ? opts.hudOwnsKey : defaultHudOwnsKey;
  const unbinds = [];
  for (const row of SELECTION_KEY_ACTIONS) {
    const id = retailActionBindingId(row.action);
    unbinds.push(funnel.bindAction(id, row.defaultBinding, () => {
      const em = getEm();
      if (!em) return;
      try {
        row.run(em, env);
      } catch (e) {
        console.warn(`[targetCycle] ${row.label} failed:`, e);
      }
    }, {
      // Yield first to a focused HUD control / the radial menu (the key is
      // then left unclaimed for it), then the row's own scope.
      when: (ev) => !hudOwns(ev) && (!row.when || !!row.when(env)),
      source: "selection",
    }));
  }
  return () => {
    for (const off of unbinds) {
      try { off?.(); } catch (_) { /* keep unbinding the rest */ }
    }
    unbinds.length = 0;
  };
}
