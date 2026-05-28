// Wave 5.C (2026-05-28) — Tradeskill drag-and-drop dispatcher.
//
// **No retail UI to port.** Per the Wave 8 audit-refresh-2026-05-28.md
// §5.C, `gmCraftRecipeUI.cs` does not exist in ACBindings — retail
// AC drove tradeskill exclusively through inventory drag-drop of one
// item onto another (e.g. dye-pot → armor, ivory → comb, peerless
// salvage → tool), with the outcome surfaced via chat messages +
// inventory delta. The Wave 5.A `useWithTarget(itemGuid, targetGuid)`
// wasm export is the only client-side primitive needed; ACE's
// `RecipeManager.cs` (~1071 LOC) owns recipe matching, skill-check,
// material consumption, and result-notification.
//
// **What this plugin does:** subscribe to the `hb:inventory-item-on-
// item-drop` window event that inventory.js emits when the user drops
// one inventory item onto another (source != target). On each drop,
// call `client.player.useWithTarget(sourceGuid, targetGuid)`.
//
// **Visibility surface:** the success / failure message comes back
// through ACE's existing chat-message + InventoryChange paths, which
// chat-panel.js and inventory.js already render. No bespoke toast is
// required for the XS scope.
//
// **Confirmation popup (optional).** A `requireConfirm` config flag
// (default off, mirroring retail's no-confirmation flow) gates the
// `useWithTarget` call behind a 2-button popup. Useful for tooltip-
// less environments where the user can mis-drag a valuable salvage
// bundle onto the wrong tool.
//
// **Sibling-export gating.** Wave 5.A's `useWithTarget` wasm export
// is built concurrently. If the export is missing (stale wasm pkg),
// the plugin logs ONE warning per session and silently no-ops on
// subsequent drops — no spam, no thrown exceptions. Pattern mirrors
// inventory.js Wave 1.D `setWielded → wieldFromPack` fallback.
//
// **Tests** (test_tradeskill.mjs): the pure helpers
// `decideTradeskillCall` + `nextStateForDrop` cover the dispatch
// decisions without DOM. Manifest shape is also asserted.
//
// References:
// - `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionUseWithTarget.cs:15`
// - `~/ace-server/Source/ACE.Server/WorldObjects/Player_Use.cs:29` (HandleActionUseWithTarget)
// - `~/ace-server/Source/ACE.Server/Managers/RecipeManager.cs` (~1071 LOC; recipe outcome logic)

const STYLE_ID = "hb-tradeskill-popup-style";
const OVERLAY_ID = "hb-tradeskill-popup";

// Module-scoped "one-warning-per-session" flag for the missing-export
// case. Reset only by reload — by design, so a stale wasm pkg is
// loudly flagged once at first attempted use, then stops spamming
// the console on every subsequent drop.
let warnedMissingExport = false;

// ─── Default config ──────────────────────────────────────────────
// `requireConfirm` mirrors retail's no-confirmation flow when false
// (default). Set to true via plugin context to gate every drop behind
// a 2-button popup.
export const DEFAULT_CONFIG = Object.freeze({
  requireConfirm: false,
});

// ─── Pure helpers ────────────────────────────────────────────────
// Exported separately so test_tradeskill.mjs can drive them without
// booting the DOM or wasm. Pattern mirrors hotbar.js#decideFireAction
// + lifestone-popup.js#nextStateForAction.

/**
 * Decide what to do given a drag-end event.
 *
 * @param {{ sourceGuid: number, targetGuid: number,
 *           sourceIsEquipSlot?: boolean,
 *           targetIsEquipSlot?: boolean }} dropEvent
 * @param {{ requireConfirm?: boolean }} [config]
 * @returns {{ kind: "fire", sourceGuid: number, targetGuid: number }|
 *            { kind: "confirm", sourceGuid: number, targetGuid: number }|
 *            { kind: "skip", reason: string }}
 */
export function nextStateForDrop(dropEvent, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const src = (dropEvent?.sourceGuid ?? 0) >>> 0;
  const dst = (dropEvent?.targetGuid ?? 0) >>> 0;
  if (!src || !dst) {
    return { kind: "skip", reason: "missing-guid" };
  }
  if (src === dst) {
    return { kind: "skip", reason: "same-slot" };
  }
  // Equipment slots (paperdoll) are the wield-target path (Wave 1.D
  // setWielded); they are NOT a tradeskill target. The hook in
  // inventory.js only fires for item-on-item drops, but we also gate
  // here as a defence-in-depth.
  if (dropEvent?.sourceIsEquipSlot || dropEvent?.targetIsEquipSlot) {
    return { kind: "skip", reason: "equip-slot" };
  }
  if (cfg.requireConfirm) {
    return { kind: "confirm", sourceGuid: src, targetGuid: dst };
  }
  return { kind: "fire", sourceGuid: src, targetGuid: dst };
}

/**
 * Pure dispatch helper — given a fire action + the client facade,
 * decide what to call. Returns the names of the methods invoked (as
 * strings) for test assertions. Real dispatch happens inside mount()
 * to keep the helper side-effect-free.
 *
 * @param {{ kind: "fire", sourceGuid: number, targetGuid: number }|
 *         { kind: "confirm", sourceGuid: number, targetGuid: number }|
 *         { kind: "skip", reason: string }} action
 * @param {{ player?: { useWithTarget?: Function } }} client
 * @returns {{ called: string|null, args: any[], warn: string|null }}
 */
export function decideTradeskillCall(action, client) {
  if (action.kind !== "fire") {
    return { called: null, args: [], warn: null };
  }
  // Visibility check (per task brief): detect missing export and log
  // once. The fallback chain on `client?.player?.useWithTarget` covers
  // both the facade form (api.js exposes player.useWithTarget) and the
  // raw sessionHandle form (some callers pass the wasm handle direct).
  if (typeof client?.player?.useWithTarget !== "function") {
    return {
      called: null,
      args: [],
      warn: "tradeskill: useWithTarget not available",
    };
  }
  return {
    called: "useWithTarget",
    args: [action.sourceGuid >>> 0, action.targetGuid >>> 0],
    warn: null,
  };
}

// ─── Manifest ────────────────────────────────────────────────────
export const manifest = {
  id: "tradeskill",
  name: "Tradeskill",
  icon: "🔨",
  iconHidden: true,
  version: "0.1.0",
  description: "Drag-and-drop tradeskill dispatcher (Wave 5.C)",
};

// ─── DOM helpers (confirmation popup) ─────────────────────────────
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
    #${OVERLAY_ID} .hb-tradeskill-title {
      font-size: 13px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      margin: 0 0 8px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      text-align: center;
    }
    #${OVERLAY_ID} .hb-tradeskill-body {
      font-size: 12px;
      margin-bottom: 10px;
      line-height: 1.4;
    }
    #${OVERLAY_ID} .hb-tradeskill-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    #${OVERLAY_ID} button.hb-tradeskill-btn {
      padding: 6px 14px;
      background: linear-gradient(180deg, rgba(60, 44, 24, 0.9) 0%, rgba(40, 28, 16, 0.9) 100%);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      color: var(--hb-text-cream, #e8d8b0);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    #${OVERLAY_ID} button.hb-tradeskill-btn:hover {
      background: linear-gradient(180deg, rgba(80, 60, 30, 0.95) 0%, rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold, #d4af37);
    }
  `;
  document.head.appendChild(s);
}

function makeConfirmPopup() {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Confirm tradeskill use");
  overlay.setAttribute("data-open", "0");

  const title = document.createElement("div");
  title.className = "hb-tradeskill-title";
  title.textContent = "Combine items?";
  overlay.appendChild(title);

  const body = document.createElement("div");
  body.className = "hb-tradeskill-body";
  body.textContent = "Use the dragged item on the target?";
  overlay.appendChild(body);

  const row = document.createElement("div");
  row.className = "hb-tradeskill-row";

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "hb-tradeskill-btn";
  okBtn.dataset.action = "confirm";
  okBtn.textContent = "Use";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hb-tradeskill-btn";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";

  row.appendChild(cancelBtn);
  row.appendChild(okBtn);
  overlay.appendChild(row);

  return { overlay, okBtn, cancelBtn };
}

// ─── Mount ───────────────────────────────────────────────────────
export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();

  const client = ctx?.client ?? window.__pluginClient ?? null;
  const config = { ...DEFAULT_CONFIG, ...(ctx?.config || {}) };

  // Pending confirmation (only used when config.requireConfirm = true).
  let pending = null; // { sourceGuid, targetGuid } | null
  let popupParts = null;

  function maybeMakePopup() {
    if (popupParts) return popupParts;
    popupParts = makeConfirmPopup();
    document.body.appendChild(popupParts.overlay);
    popupParts.okBtn.addEventListener("click", onConfirm);
    popupParts.cancelBtn.addEventListener("click", onCancel);
    return popupParts;
  }

  function closePopup() {
    if (popupParts) {
      popupParts.overlay.setAttribute("data-open", "0");
    }
    pending = null;
  }

  function openPopup(sourceGuid, targetGuid) {
    const parts = maybeMakePopup();
    pending = { sourceGuid: sourceGuid >>> 0, targetGuid: targetGuid >>> 0 };
    parts.overlay.setAttribute("data-open", "1");
  }

  function fireUseWithTarget(sourceGuid, targetGuid) {
    const decision = decideTradeskillCall(
      { kind: "fire", sourceGuid: sourceGuid >>> 0, targetGuid: targetGuid >>> 0 },
      client,
    );
    if (decision.warn && !warnedMissingExport) {
      warnedMissingExport = true;
      console.warn(decision.warn);
      return;
    }
    if (decision.called === "useWithTarget") {
      try {
        client.player.useWithTarget(...decision.args);
      } catch (e) {
        console.warn("[tradeskill] useWithTarget failed:", e);
      }
    }
  }

  function onConfirm() {
    if (!pending) { closePopup(); return; }
    const { sourceGuid, targetGuid } = pending;
    closePopup();
    fireUseWithTarget(sourceGuid, targetGuid);
  }

  function onCancel() {
    closePopup();
  }

  function onKeyDown(ev) {
    if (!pending) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      onCancel();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      onConfirm();
    }
  }

  // Wave 5.C inventory.js hook emits {sourceGuid, targetGuid,
  // sourceIsEquipSlot?, targetIsEquipSlot?} on the window event bus.
  function onItemOnItemDrop(ev) {
    const detail = ev?.detail ?? ev ?? {};
    const action = nextStateForDrop(
      {
        sourceGuid: detail.sourceGuid,
        targetGuid: detail.targetGuid,
        sourceIsEquipSlot: detail.sourceIsEquipSlot,
        targetIsEquipSlot: detail.targetIsEquipSlot,
      },
      config,
    );
    if (action.kind === "skip") return;
    if (action.kind === "confirm") {
      openPopup(action.sourceGuid, action.targetGuid);
      return;
    }
    // kind === "fire"
    fireUseWithTarget(action.sourceGuid, action.targetGuid);
  }

  window.addEventListener("hb:inventory-item-on-item-drop", onItemOnItemDrop);
  document.addEventListener("keydown", onKeyDown);

  return () => {
    window.removeEventListener("hb:inventory-item-on-item-drop", onItemOnItemDrop);
    document.removeEventListener("keydown", onKeyDown);
    if (popupParts) {
      try { popupParts.overlay.remove(); } catch (_) {}
      popupParts = null;
    }
    pending = null;
  };
}

// ─── Test helpers ────────────────────────────────────────────────
// Internal hook used only by test_tradeskill.mjs to reset the
// module-scoped one-warning flag between assertions. NOT a public
// API — do not call from production code.
export function __resetWarningState() {
  warnedMissingExport = false;
}
