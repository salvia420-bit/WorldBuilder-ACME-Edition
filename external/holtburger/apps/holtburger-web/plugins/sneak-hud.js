// Wave 7 / Phase 20 — Sneak Attack HUD overlay plugin.
//
// Subscribes to the `sneakAttackPredicted` event that
// `scene3d/picking.js` emits when the local-player attacker is in the
// defender's 90° rear hemisphere (Phase 9 melee/missile, Phase 16
// magic). Computes the predicted Sneak DR component via
// `ui/ac_damage_rating.js`'s rollup and flashes a transient overlay
// "Sneak Attack +N DR" near the top-center of the screen.
//
// Why ONLY the sneak component (not the full rollup)? The Recklessness
// band already lives in the combat-bar (Wave 4 Phase 8) — replicating
// the +10/+20 reckless number here would be redundant noise. The
// purpose of THIS overlay is the *positional* feedback: "you got
// behind your target, here's the bonus you just unlocked".
//
// Lifecycle pattern mirrors `plugins/vitals-hud.js`:
//   - `iconHidden: true` so mountBar() runs `mount()` without claiming
//     a bar-slot button.
//   - Overlay div appended to `document.body` on mount, removed on
//     teardown (return value).
//   - Poll for `__pluginClient` since bar-mount runs before login.

const OVERLAY_ID = "hb-sneak-hud";
const STYLE_ID = "hb-sneak-hud-style";

// How long the message stays at full opacity before the fade animation
// kicks in (ms). The CSS transition handles the actual fade timing.
const VISIBLE_MS = 900;
// Total time on screen (visible + fade-out). Used to gate the removal
// of the .hb-sneak-show class so the fade plays before reset.
const TOTAL_MS = 1500;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // AC red-accent aesthetic — matches the Recklessness band overlay in
  // `plugins/combat-bar.js` (`.hb-cb-power-band` rgba(220,80,40,*) +
  // `.hb-cb-power-band-spec` rgba(240,100,60,*)). The text uses the
  // brighter "spec" border-orange so it pops against typical world
  // backgrounds while still reading as the same colour family.
  //
  // Positioned top-center: 84px from top so it clears the vitals HUD
  // (which sits at ~6px top in `plugins/vitals-hud.js`); transform
  // centers horizontally. Pointer-events: none so it never blocks
  // mouse interaction with the combat HUD beneath.
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 84px;
      left: 50%;
      transform: translate(-50%, -6px);
      z-index: 60;
      pointer-events: none;
      padding: 6px 14px;
      font-family: var(--hb-font-serif, serif);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: rgb(255, 220, 200);
      background: linear-gradient(
        180deg,
        rgba(60, 18, 6, 0.85) 0%,
        rgba(35, 10, 4, 0.85) 100%
      );
      border: 1px solid rgba(240, 100, 60, 0.55);
      border-radius: 3px;
      box-shadow:
        0 0 12px rgba(220, 80, 40, 0.45),
        inset 0 0 4px rgba(255, 180, 140, 0.18);
      text-shadow: 0 0 4px rgba(255, 100, 40, 0.6),
                   0 1px 2px rgba(0, 0, 0, 0.95);
      opacity: 0;
      transition: opacity 220ms ease-out, transform 220ms ease-out;
      white-space: nowrap;
    }
    #${OVERLAY_ID}.hb-sneak-show {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  `;
  document.head.appendChild(style);
}

export const manifest = {
  id: "sneak-hud",
  name: "Sneak Attack HUD",
  icon: "🗡",
  // No bar icon — the overlay IS the presentation. iconHidden tells
  // `mountBar` to skip the bar-button render but still call `mount`.
  iconHidden: true,
  version: "0.1.0",
  description: "Transient 'Sneak Attack +N DR' overlay on facing-gated swings",
};

export function mount(ctx) {
  ensureStyles();

  // Idempotent — wipe any pre-existing overlay from a stale mount.
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.textContent = "";
  document.body.appendChild(overlay);

  // Timer management: a new event clears the prior timers and restarts
  // the cycle so rapid-fire swings (e.g. auto-repeat in the rear cone)
  // keep the overlay visible instead of jittering.
  let visibleTimer = null;
  let totalTimer = null;

  // Dynamically import the rollup helper so the plugin module itself
  // stays load-cheap when `?plugins=none` skips bar mount. The first
  // event pays the import cost; subsequent events reuse the cached
  // module promise. Falls back to a constant if the import ever fails
  // (defensive — should never happen with the helper committed).
  let rollupModulePromise = null;
  function getRollupModule() {
    if (!rollupModulePromise) {
      rollupModulePromise = import("../ui/ac_damage_rating.js");
    }
    return rollupModulePromise;
  }

  function show(text) {
    overlay.textContent = text;
    // Force layout flush so the transition picks up the class add
    // even when timers fire back-to-back within a single frame.
    overlay.offsetHeight;
    overlay.classList.add("hb-sneak-show");
    if (visibleTimer) clearTimeout(visibleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    // After VISIBLE_MS, drop the .hb-sneak-show class so the CSS
    // opacity transition kicks in (fade-out).
    visibleTimer = setTimeout(() => {
      overlay.classList.remove("hb-sneak-show");
    }, VISIBLE_MS);
    // After TOTAL_MS, clear the textContent so a stale message
    // doesn't briefly flash on the next show() before the new text
    // lands. (offsetHeight flush above re-triggers the transition.)
    totalTimer = setTimeout(() => {
      overlay.textContent = "";
    }, TOTAL_MS);
  }

  async function onSneakEvent(_payload) {
    try {
      const mod = await getRollupModule();
      const rollup = mod.computeDamageRatingRollup({
        // The slider value lives on window.__combatBarState — same
        // global the combat-bar plugin syncs (see combat-bar.js:80).
        // Default to 1.0 (full power) when the bar hasn't initialized
        // yet so the predictor doesn't silently zero out.
        powerLevel: (typeof window !== "undefined")
          ? (window.__combatBarState?.powerLevel ?? 1.0)
          : 1.0,
        hasSneak: true,
      });
      // Skip the flash if training-level lookup returned 0 (Unusable /
      // Untrained Sneak Attack — no DR bonus actually accrues). The
      // upstream predicate ran on facing alone; this is the place we
      // gate on actual skill state.
      if (rollup.sneak <= 0) return;
      show(`Sneak Attack +${rollup.sneak} DR`);
    } catch (e) {
      // Never let a prediction fault leak to the console as an
      // unhandled rejection. The overlay simply stays hidden.
      try { console.warn(`[sneak-hud] rollup failed: ${e?.message ?? e}`); } catch (_) {}
    }
  }

  // The plugin-client is created post-login (window.__pluginClient is
  // set inside the loginForm submit handler in index.html). Bar mount
  // runs at page load, BEFORE login — same situation vitals-hud.js
  // handles. Poll for the client, then subscribe.
  let pollTimer = null;
  let unsubscribe = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (!client?.events?.on) return false;
    client.events.on("sneakAttackPredicted", onSneakEvent);
    unsubscribe = () => {
      try { client.events.off("sneakAttackPredicted", onSneakEvent); } catch (_) {}
    };
    return true;
  }

  // P3-41 — replace 500ms client-discovery poll with one-shot await
  // on the pluginClient bootstrap promise.
  if (!tryHook()) {
    if (typeof window !== "undefined" && window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { tryHook(); });
    } else {
      pollTimer = setInterval(() => {
        if (tryHook()) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 500);
    }
  }

  // Debug helper — fire a fake event so the overlay is visible without
  // a real swing. Useful for visual tuning. No-op when window is
  // undefined (Node import for tests).
  if (typeof window !== "undefined") {
    window.__sneakHudDebug = function (n = 10) {
      show(`Sneak Attack +${n} DR`);
    };
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (visibleTimer) clearTimeout(visibleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (unsubscribe) unsubscribe();
    overlay.remove();
    if (typeof window !== "undefined") {
      try { delete window.__sneakHudDebug; } catch (_) {}
    }
  };
}
