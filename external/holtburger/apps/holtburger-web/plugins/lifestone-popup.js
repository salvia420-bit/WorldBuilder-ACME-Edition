// Wave 6.B (2026-05-28) — Lifestone bind/recall popup.
//
// Wave 1.C (commit 52292249) shipped the typed `Lifestone` subclass
// (`plugins/world-objects/lifestone.js` extending Static with `tie()`),
// but no UI consumer branched on `instanceof Lifestone`. Lifestone-
// click flowed through generic `examine() → client.player.useObject(guid)`
// — same path as doors and portals, which silently triggers ACE's
// bind without giving the player a chance to choose between bind /
// recall / cancel.
//
// This plugin adds a tiny popup with two actions:
//   - **Bind here** — `useObject(lifestoneGuid)`. ACE wires this to
//     `Lifestone.ActOnUse` (Lifestone.cs:44) → `MotionCommand.Sanctuary`
//     animation → sets `player.Sanctuary` to current Location.
//   - **Recall to bound location** — `teleToLifestone()`. ACE wires to
//     `Player_Location.cs:132#HandleActionTeleToLifestone` →
//     `MotionCommand.LifestoneRecall` → teleport to Sanctuary. Requires
//     Sanctuary already set (server-side check, returns "Your spirit
//     has not been attuned to a sanctuary location." if not).
//
// **Trigger wiring**: scene3d/picking.js fires `lifestoneClicked`
// {guid, x, y} on the `__pluginClient.events` bus when a click lands
// on a guid whose worldObjectManager entry has constructor.name ===
// "Lifestone". The branch is taken BEFORE the generic `useObject`
// fall-through so typed click wins over generic interact (the
// visibility-blocker the task brief flagged).
//
// State machine (decideLifestoneAction):
//   { kind: "idle" }                    no popup open
//   { kind: "open", guid }              popup visible, awaiting action
//
// Action dispatch:
//   bind                                → emits { kind: "bind", guid }
//   recall                              → emits { kind: "recall" }
//   cancel / outside-click / Escape     → emits { kind: "cancel" }
//
// **Tests** (test_lifestone_popup.mjs): the pure helpers
// `decideLifestoneAction` + `nextStateForAction` cover all 5
// transitions without DOM. Manifest shape is also asserted.

// HUD overhaul 2026-10-05 — wears the shared retail DialogBox chrome
// (`.hb-dlg`, plugins/modal-dialog.js) with kit buttons; keyboard: Esc
// cancels, ↑/↓ walk Bind / Recall / Cancel, Enter activates the
// highlighted choice (the first Enter just highlights "Bind" — nothing is
// pre-focused, so Space-to-jump can never bind by accident).
import { ensureDialogChromeStyles } from "./modal-dialog.js";

const OVERLAY_ID = "hb-lifestone-popup";
const STYLE_ID = "hb-lifestone-popup-style";

// ─── Pure state-machine helpers ──────────────────────────────────
// Exported separately so test_lifestone_popup.mjs can drive them
// without booting the DOM or wasm. Mirrors the
// decideFireAction/nextState pattern from hotbar.js (Wave 3.A).

/**
 * Compute the next popup state given an incoming event.
 * Used by the DOM-side `mount()` to update its closure state.
 *
 * @param {{ kind: "idle" }|{ kind: "open", guid: number }} prev
 * @param {{ type: "lifestoneClicked", guid: number }|{ type: "bind" }|
 *         { type: "recall" }|{ type: "cancel" }} event
 * @returns {{ state: { kind: "idle" }|{ kind: "open", guid: number },
 *            action: { kind: "bind", guid: number }|{ kind: "recall" }|
 *                    { kind: "cancel" }|{ kind: "none" } }}
 */
export function nextStateForAction(prev, event) {
  if (event.type === "lifestoneClicked") {
    return {
      state: { kind: "open", guid: event.guid >>> 0 },
      action: { kind: "none" },
    };
  }
  if (prev.kind !== "open") {
    // Spurious bind/recall/cancel with no popup open — drop.
    return { state: prev, action: { kind: "none" } };
  }
  if (event.type === "bind") {
    return { state: { kind: "idle" }, action: { kind: "bind", guid: prev.guid } };
  }
  if (event.type === "recall") {
    return { state: { kind: "idle" }, action: { kind: "recall" } };
  }
  if (event.type === "cancel") {
    return { state: { kind: "idle" }, action: { kind: "cancel" } };
  }
  return { state: prev, action: { kind: "none" } };
}

/**
 * Pure dispatch helper — given an action descriptor + a client facade,
 * compute the calls to perform. Returns the names of the methods
 * invoked (as strings) for test assertions. Real dispatch happens
 * inside the DOM-side mount() to keep the helper side-effect-free.
 *
 * @param {{ kind: "bind", guid: number }|{ kind: "recall" }|
 *         { kind: "cancel" }|{ kind: "none" }} action
 * @param {{ player?: { useObject?: Function, recallToLifestone?: Function } }} client
 * @returns {{ called: string|null, args: any[] }}
 */
export function decideLifestoneAction(action, client) {
  if (action.kind === "bind") {
    if (typeof client?.player?.useObject !== "function") {
      return { called: null, args: [] };
    }
    return { called: "useObject", args: [action.guid >>> 0] };
  }
  if (action.kind === "recall") {
    if (typeof client?.player?.recallToLifestone !== "function") {
      return { called: null, args: [] };
    }
    return { called: "recallToLifestone", args: [] };
  }
  return { called: null, args: [] };
}

/**
 * HUD rec #56 — format the Sanctuary bind status line from a
 * `playerSanctuary()` snapshot (or null/undefined). Pure (no DOM/wasm) so it
 * is unit-testable; the DOM-side `refreshSanctuaryStatus()` in mount() just
 * assigns the result to textContent.
 *
 * @param {{ isBound?: boolean, formatted?: string, townName?: (string|null) }|null|undefined} sanc
 * @returns {string}
 */
export function formatSanctuaryStatus(sanc) {
  if (!sanc || !sanc.isBound) return "Not yet bound to any sanctuary";
  const coords = sanc.formatted ?? "";
  const town = sanc.townName;
  if (town) return `Currently bound to: ${town} (${coords})`;
  return coords
    ? `Currently bound to: ${coords}`
    : "Currently bound to your sanctuary";
}

// ─── Manifest ────────────────────────────────────────────────────
export const manifest = {
  id: "lifestone-popup",
  name: "Lifestone Popup",
  icon: "💎",
  iconHidden: true,
  version: "0.1.0",
  description: "Bind/recall popup for clicked Lifestones (Wave 6.B)",
};

// ─── DOM helpers ─────────────────────────────────────────────────
function ensureStyles() {
  if (typeof document === "undefined") return;
  ensureDialogChromeStyles();
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { z-index: 60; min-width: 250px; max-width: min(300px, calc(94 * var(--hb-hud-vw, 1vw))); }
    #${OVERLAY_ID} .hb-lifestone-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }
    #${OVERLAY_ID} .hb-lifestone-btn { width: 100%; justify-content: center; }
    #${OVERLAY_ID} .hb-lifestone-btn:focus-visible { outline: 1px solid var(--hbk-gold-bright, #f3d27a); outline-offset: 1px; }
    #${OVERLAY_ID} .hb-lifestone-hint {
      margin: 0 0 6px;
      color: var(--hbk-text-dim, #a8a090);
      font-size: 11px;
      text-align: center;
    }
    #${OVERLAY_ID} .hb-dlg-actions { margin-top: 4px; }
    #${OVERLAY_ID} .hb-lifestone-cancel:focus-visible { outline: 1px solid var(--hbk-gold-bright, #f3d27a); outline-offset: 1px; }
    /* HUD rec #56 — Sanctuary bind status line. */
    #${OVERLAY_ID} .hb-lifestone-sanctuary-status { line-height: 1.3; }
  `;
  document.head.appendChild(s);
}

// ─── Mount ───────────────────────────────────────────────────────
export function mount(ctx) {
  if (typeof document === "undefined") return () => {};
  ensureStyles();

  const client = ctx?.client ?? (typeof window !== "undefined" ? window.__pluginClient : null) ?? null;
  const bus = client?.events ?? null;

  // Build the popup DOM lazily — only insert when first lifestone is
  // clicked, to avoid an extra <div> on every page-load.
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "hb-dlg";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Lifestone actions");
  overlay.setAttribute("data-open", "0");

  const title = document.createElement("div");
  title.className = "hb-dlg-title hb-lifestone-title";
  title.textContent = "Lifestone";
  overlay.appendChild(title);

  const divider = document.createElement("div");
  divider.className = "hbk-divider";
  overlay.appendChild(divider);

  // HUD rec #56 — Sanctuary bind status line. Reads the SessionHandle's
  // playerSanctuary() snapshot (refreshed by the recv loop on each Sanctuary
  // PrivateUpdatePosition) and shows the bound town + coords, or a
  // not-yet-bound fallback. Refreshed on mount and on every lifestone click.
  const sanctuaryStatus = document.createElement("div");
  sanctuaryStatus.className = "hb-dlg-sub hb-lifestone-sanctuary-status";
  overlay.appendChild(sanctuaryStatus);

  function refreshSanctuaryStatus() {
    const sh = (typeof window !== "undefined" ? window.__sessionHandle : null) ?? null;
    let sanc = null;
    try {
      sanc = (sh && typeof sh.playerSanctuary === "function")
        ? sh.playerSanctuary() : null;
    } catch (_) {
      // Stale pkg without playerSanctuary — fall through to the fallback.
    }
    sanctuaryStatus.textContent = formatSanctuaryStatus(sanc);
  }
  refreshSanctuaryStatus();

  const row = document.createElement("div");
  row.className = "hb-lifestone-row";

  const mkChoice = (action, label, hint) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hbk-btn hb-lifestone-btn";
    btn.dataset.action = action;
    btn.textContent = label;
    const h = document.createElement("div");
    h.className = "hb-lifestone-hint";
    h.textContent = hint;
    row.appendChild(btn);
    row.appendChild(h);
    return btn;
  };
  const bindBtn = mkChoice("bind", "Bind here", "Set this lifestone as your sanctuary.");
  const recallBtn = mkChoice("recall", "Recall to lifestone", "Return to the lifestone you are bound to.");
  overlay.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "hb-dlg-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hbk-btn-small hbk-brown hb-lifestone-cancel";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";
  actions.appendChild(cancelBtn);
  overlay.appendChild(actions);

  document.body.appendChild(overlay);

  // Closure-scoped state machine (driven by nextStateForAction).
  let state = { kind: "idle" };

  function applyAction(action) {
    const decision = decideLifestoneAction(action, client);
    if (decision.called === "useObject") {
      try { client.player.useObject(...decision.args); }
      catch (e) { console.warn("[lifestone-popup] bind failed:", e); }
    } else if (decision.called === "recallToLifestone") {
      try { client.player.recallToLifestone(...decision.args); }
      catch (e) { console.warn("[lifestone-popup] recall failed:", e); }
    }
  }

  let restoreFocusEl = null;
  function applyState(next) {
    const wasOpen = state.kind === "open";
    state = next;
    const open = state.kind === "open";
    overlay.setAttribute("data-open", open ? "1" : "0");
    if (wasOpen && !open) {
      // Hand focus back (or drop it) so game keys work again.
      const r = restoreFocusEl;
      restoreFocusEl = null;
      try {
        if (r && r.isConnected) r.focus({ preventScroll: true });
        else if (overlay.contains(document.activeElement)) document.activeElement.blur();
      } catch (_) {}
    } else if (!wasOpen && open) {
      try {
        const ae = document.activeElement;
        restoreFocusEl = (ae && ae !== document.body && !overlay.contains(ae)) ? ae : null;
      } catch (_) { restoreFocusEl = null; }
    }
  }

  function handle(event) {
    const { state: nextState, action } = nextStateForAction(state, event);
    applyState(nextState);
    if (action.kind !== "none") applyAction(action);
  }

  // Bus subscription: scene3d/picking.js emits "lifestoneClicked"
  // BEFORE the generic useObject branch when the clicked guid is a
  // Lifestone per worldObjectManager.
  function onLifestoneClicked(payload) {
    const detail = payload?.detail ?? payload ?? {};
    const guid = (detail.guid ?? 0) >>> 0;
    if (!guid) return;
    refreshSanctuaryStatus();
    handle({ type: "lifestoneClicked", guid });
  }

  // Button clicks → state transitions.
  bindBtn.addEventListener("click", () => handle({ type: "bind" }));
  recallBtn.addEventListener("click", () => handle({ type: "recall" }));
  cancelBtn.addEventListener("click", () => handle({ type: "cancel" }));

  // Keyboard (capture phase so these keys don't also drive the game):
  // Esc → cancel; ↑/↓ walk the three buttons; Enter activates the focused
  // one, or highlights "Bind here" first when nothing is focused yet.
  const choices = [bindBtn, recallBtn, cancelBtn];
  function onKeyDown(ev) {
    if (state.kind !== "open") return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      handle({ type: "cancel" });
      return;
    }
    const idx = choices.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      ev.stopPropagation();
      const step = ev.key === "ArrowDown" ? 1 : -1;
      const next = idx < 0 ? (step > 0 ? 0 : choices.length - 1) : (idx + step + choices.length) % choices.length;
      try { choices[next].focus({ preventScroll: true }); } catch (_) {}
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      if (idx < 0) { try { bindBtn.focus({ preventScroll: true }); } catch (_) {} return; }
      choices[idx].click();
    }
  }
  document.addEventListener("keydown", onKeyDown, true);

  // Outside-click → cancel. Attached to document but only acts when
  // open and the click was outside the popup.
  function onDocClick(ev) {
    if (state.kind !== "open") return;
    if (overlay.contains(ev.target)) return;
    handle({ type: "cancel" });
  }
  // capture phase so the click that closes us doesn't double-fire on a
  // sibling overlay that opened in response to the same click.
  document.addEventListener("click", onDocClick, true);

  // Bar boot runs mount() BEFORE window.__pluginClient is published
  // (login publishes it). When that happens `bus` is null at this
  // point and the subscription silently no-ops, leaving the popup
  // permanently dead. Late-bind via __pluginClientReady so the
  // subscription survives the pre-login mount path. `busForCleanup`
  // captures whichever bus actually got the listener for the disposer.
  let busForCleanup = bus;
  if (bus?.on) {
    bus.on("lifestoneClicked", onLifestoneClicked);
  } else if (typeof window !== "undefined" && window.__pluginClientReady?.then) {
    window.__pluginClientReady.then(() => {
      const lateBus = window.__pluginClient?.events ?? null;
      if (lateBus?.on) {
        lateBus.on("lifestoneClicked", onLifestoneClicked);
        busForCleanup = lateBus;
      }
    });
  }

  // Cleanup.
  return () => {
    if (busForCleanup?.off) try { busForCleanup.off("lifestoneClicked", onLifestoneClicked); } catch (_) {}
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onDocClick, true);
    overlay.remove();
  };
}
