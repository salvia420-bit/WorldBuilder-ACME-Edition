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
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      left: 50%;
      top: 38%;
      transform: translate(-50%, -50%);
      z-index: 60;
      min-width: 240px;
      padding: 14px 18px 12px 18px;
      background: rgba(20, 14, 8, 0.96);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
      font-family: var(--hb-font-serif, serif);
      color: var(--hb-text-cream, #e8d8b0);
      pointer-events: auto;
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-lifestone-title {
      font-size: 13px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      margin: 0 0 8px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      text-align: center;
    }
    #${OVERLAY_ID} .hb-lifestone-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
    }
    #${OVERLAY_ID} button.hb-lifestone-btn {
      display: block;
      width: 100%;
      padding: 6px 10px;
      background: linear-gradient(180deg, rgba(60, 44, 24, 0.9) 0%, rgba(40, 28, 16, 0.9) 100%);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      color: var(--hb-text-cream, #e8d8b0);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      text-align: left;
    }
    #${OVERLAY_ID} button.hb-lifestone-btn:hover {
      background: linear-gradient(180deg, rgba(80, 60, 30, 0.95) 0%, rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold, #d4af37);
    }
    #${OVERLAY_ID} button.hb-lifestone-btn .hb-lifestone-hint {
      display: block;
      font-size: 10px;
      color: var(--hb-text-muted-3, #a08868);
      margin-top: 2px;
    }
    #${OVERLAY_ID} .hb-lifestone-cancel {
      display: block;
      width: 100%;
      padding: 4px 8px;
      background: rgba(40, 30, 18, 0.7);
      border: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      color: var(--hb-text-muted-3, #a08868);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
    }
    #${OVERLAY_ID} .hb-lifestone-cancel:hover {
      color: var(--hb-text-cream, #e8d8b0);
      border-color: var(--hb-border-brass, #b08a4a);
    }
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
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Lifestone actions");
  overlay.setAttribute("data-open", "0");

  const title = document.createElement("div");
  title.className = "hb-lifestone-title";
  title.textContent = "Lifestone";
  overlay.appendChild(title);

  const row = document.createElement("div");
  row.className = "hb-lifestone-row";

  const bindBtn = document.createElement("button");
  bindBtn.type = "button";
  bindBtn.className = "hb-lifestone-btn";
  bindBtn.dataset.action = "bind";
  bindBtn.innerHTML =
    `Bind here<span class="hb-lifestone-hint">Set this lifestone as your Sanctuary</span>`;

  const recallBtn = document.createElement("button");
  recallBtn.type = "button";
  recallBtn.className = "hb-lifestone-btn";
  recallBtn.dataset.action = "recall";
  recallBtn.innerHTML =
    `Recall to bound location<span class="hb-lifestone-hint">Teleport to your attuned Sanctuary</span>`;

  row.appendChild(bindBtn);
  row.appendChild(recallBtn);
  overlay.appendChild(row);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hb-lifestone-cancel";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";
  overlay.appendChild(cancelBtn);

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

  function applyState(next) {
    state = next;
    overlay.setAttribute("data-open", state.kind === "open" ? "1" : "0");
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
    handle({ type: "lifestoneClicked", guid });
  }

  // Button clicks → state transitions.
  bindBtn.addEventListener("click", () => handle({ type: "bind" }));
  recallBtn.addEventListener("click", () => handle({ type: "recall" }));
  cancelBtn.addEventListener("click", () => handle({ type: "cancel" }));

  // Escape key → cancel.
  function onKeyDown(ev) {
    if (state.kind === "open" && ev.key === "Escape") {
      ev.preventDefault();
      handle({ type: "cancel" });
    }
  }
  document.addEventListener("keydown", onKeyDown);

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
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("click", onDocClick, true);
    overlay.remove();
  };
}
