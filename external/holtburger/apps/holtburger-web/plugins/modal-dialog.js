// Modal dialog component — brass-themed Are-You-Sure prompt that
// replaces window.confirm() in HUD code. Provides two surfaces:
//
//   await modalConfirm({title, message, confirmLabel?, cancelLabel?})
//     → Promise<boolean>
//   modalConfirmCallback({title, message, onConfirm?, onCancel?, ...})
//     → fire-and-forget; runs the callback on the player's decision
//
// The callback form exists so legacy `if (!window.confirm()) return;`
// sites can migrate by wrapping their post-confirm code in `onConfirm`
// without making the calling function async. Both forms route through
// the same DOM so visual + keyboard behaviour is identical.
//
// Window-event entry for plugins that can't import:
//   window.dispatchEvent(new CustomEvent("hb:modal-confirm-request", {
//     detail: { title, message, onConfirm, onCancel }
//   }));
//
// Programmatic API:
//   window.__modalConfirm        — Promise-based
//   window.__modalConfirmCallback — callback-based
//
// References:
//   - plugins/main-panel.js (panel.png border-image source)
//   - plugins/lifestone-popup.js / salvage-confirm.js (sibling
//     confirm modals; modal-dialog supersedes them for free-form
//     confirms — they keep their domain-specific state machines)

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-modal-dialog";
const STYLE_ID = "hb-modal-dialog-style";

let _activeQueue = [];
let _processing = false;
let _domRefs = null;
let _keyHandler = null;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID}-backdrop {
      position: fixed;
      inset: 0;
      z-index: 78;
      background: rgba(0, 0, 0, 0.5);
      display: none;
    }
    #${OVERLAY_ID}-backdrop[data-open="1"] { display: block; }
    #${OVERLAY_ID} {
      position: fixed;
      left: 50%;
      top: 38%;
      transform: translate(-50%, -50%);
      z-index: 79;
      min-width: 280px;
      max-width: 420px;
      padding: 16px 22px 14px 22px;
      box-sizing: border-box;
      background: linear-gradient(180deg,
        var(--hb-bg-stone-top, rgba(38, 26, 14, 0.97)) 0%,
        var(--hb-bg-stone-bottom, rgba(20, 14, 8, 0.97)) 100%);
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.75);
      font-family: var(--hb-font-serif, serif);
      color: var(--hb-text-cream, #e8d8b0);
      pointer-events: auto;
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-md-title {
      font-size: 13px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      margin: 0 0 8px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      text-align: center;
    }
    #${OVERLAY_ID} .hb-md-msg {
      font-size: 12px;
      margin-bottom: 12px;
      line-height: 1.4;
      white-space: pre-line;
    }
    #${OVERLAY_ID} .hb-md-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    #${OVERLAY_ID} button.hb-md-btn {
      padding: 6px 16px;
      background: linear-gradient(180deg, rgba(60, 44, 24, 0.92) 0%, rgba(40, 28, 16, 0.92) 100%);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      color: var(--hb-text-cream, #e8d8b0);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    #${OVERLAY_ID} button.hb-md-btn:hover {
      background: linear-gradient(180deg, rgba(80, 60, 30, 0.95) 0%, rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold, #d4af37);
    }
    #${OVERLAY_ID} button.hb-md-btn[data-action="confirm"] {
      border-color: var(--hb-text-gold, #d4af37);
    }
  `;
  document.head.appendChild(s);
}

function ensureDom() {
  if (_domRefs) return _domRefs;
  ensureStyles();

  const backdrop = document.createElement("div");
  backdrop.id = `${OVERLAY_ID}-backdrop`;
  backdrop.setAttribute("data-open", "0");

  const dialog = document.createElement("div");
  dialog.id = OVERLAY_ID;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("data-open", "0");
  dialog.tabIndex = -1;

  const titleEl = document.createElement("div");
  titleEl.className = "hb-md-title";
  dialog.appendChild(titleEl);

  const msgEl = document.createElement("div");
  msgEl.className = "hb-md-msg";
  dialog.appendChild(msgEl);

  const row = document.createElement("div");
  row.className = "hb-md-row";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hb-md-btn";
  cancelBtn.dataset.action = "cancel";

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "hb-md-btn";
  okBtn.dataset.action = "confirm";

  row.appendChild(cancelBtn);
  row.appendChild(okBtn);
  dialog.appendChild(row);

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  _domRefs = { backdrop, dialog, titleEl, msgEl, okBtn, cancelBtn };
  return _domRefs;
}

function openCurrent(entry) {
  const refs = ensureDom();
  setAcText(refs.titleEl, entry.title || "Confirm");
  setAcText(refs.msgEl, entry.message || "");
  refs.okBtn.textContent = entry.confirmLabel || "OK";
  refs.cancelBtn.textContent = entry.cancelLabel || "Cancel";
  refs.backdrop.setAttribute("data-open", "1");
  refs.dialog.setAttribute("data-open", "1");
  refs.okBtn.onclick = () => resolve(entry, true);
  refs.cancelBtn.onclick = () => resolve(entry, false);
  refs.backdrop.onclick = () => resolve(entry, false);
  if (!_keyHandler) {
    _keyHandler = (ev) => {
      if (refs.dialog.dataset.open !== "1") return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        resolve(entry, false);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        resolve(entry, true);
      }
    };
    document.addEventListener("keydown", _keyHandler, true);
  }
  try { refs.okBtn.focus({ preventScroll: true }); } catch (_) {}
}

function resolve(entry, accepted) {
  const refs = _domRefs;
  if (!refs) return;
  refs.backdrop.setAttribute("data-open", "0");
  refs.dialog.setAttribute("data-open", "0");
  refs.okBtn.onclick = null;
  refs.cancelBtn.onclick = null;
  refs.backdrop.onclick = null;
  if (_keyHandler) {
    document.removeEventListener("keydown", _keyHandler, true);
    _keyHandler = null;
  }
  try {
    if (accepted) entry.onConfirm?.();
    else entry.onCancel?.();
  } catch (e) {
    console.warn("[modal-dialog] handler threw:", e);
  }
  if (typeof entry.dialogId === "string") {
    emitDialogResult({
      dialogId: entry.dialogId,
      action: entry.action,
      result: accepted,
    });
  }
  try { entry.resolvePromise?.(accepted); } catch (_) {}
  _processing = false;
  // Drain queue (in case a callback enqueued another confirm).
  setTimeout(processNext, 0);
}

function processNext() {
  if (_processing) return;
  if (_activeQueue.length === 0) return;
  _processing = true;
  const entry = _activeQueue.shift();
  openCurrent(entry);
}

function enqueue(entry) {
  _activeQueue.push(entry);
  processNext();
}

/**
 * Promise-based confirm. Returns true on confirm, false on cancel /
 * Escape / backdrop click. Drop-in for `await modalConfirm({...})`
 * replacements of `window.confirm()`.
 *
 * Pass `opts.dialogId` to also fire the rec #77 dispatcher with
 * { dialogId, action, result } so out-of-band consumers (e.g. the
 * eventual server-side ConfirmationResponse 0x0275 wiring) can react
 * without each dialog having to direct-call client.player.* methods.
 */
export function modalConfirm(opts) {
  return new Promise((resolvePromise) => {
    enqueue({
      title: opts?.title,
      message: opts?.message,
      confirmLabel: opts?.confirmLabel,
      cancelLabel: opts?.cancelLabel,
      dialogId: opts?.dialogId,
      action: opts?.action,
      resolvePromise,
    });
  });
}

// ─── Rec #77 — DialogFactory result protocol ──────────────────
// Dispatcher routing `{dialogId, action, result}` to handlers
// registered by id. Decouples dialog UI from its downstream
// effects so a server-side ConfirmationResponse opcode (0x0275)
// can be wired later without each dialog flipping its direct
// `client.player.*` send calls. Each modal resolve emits one
// event when `opts.dialogId` is set; per-id handlers fire first,
// then a window-level `hb:dialog-result` for anything that can't
// import this module.

/** @type {Map<string, Set<(detail: {dialogId:string, action?:string, result:boolean}) => void>>} */
const _dialogHandlers = new Map();

/**
 * Subscribe to a `dialogId`. Multiple handlers per id stack; the
 * unsubscribe lets a plugin clean up on dispose.
 *
 * @param {string} dialogId
 * @param {(detail:{dialogId:string, action?:string, result:boolean}) => void} handler
 * @returns {() => void}
 */
export function registerDialogHandler(dialogId, handler) {
  if (typeof dialogId !== "string" || typeof handler !== "function") {
    return () => {};
  }
  let set = _dialogHandlers.get(dialogId);
  if (!set) {
    set = new Set();
    _dialogHandlers.set(dialogId, set);
  }
  set.add(handler);
  return () => {
    const s = _dialogHandlers.get(dialogId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) _dialogHandlers.delete(dialogId);
  };
}

/**
 * Dispatch a dialog result. Per-id handlers fire first (in
 * registration order), then a window `hb:dialog-result` event
 * fires for module-less consumers. Safe to call when no handler
 * is registered — drops a window event only.
 *
 * @param {{dialogId:string, action?:string, result:boolean}} detail
 */
export function emitDialogResult(detail) {
  if (!detail || typeof detail.dialogId !== "string") return;
  const set = _dialogHandlers.get(detail.dialogId);
  if (set) {
    for (const fn of set) {
      try { fn(detail); }
      catch (e) { console.warn(`[modal-dialog] handler for ${detail.dialogId} threw:`, e); }
    }
  }
  try {
    window.dispatchEvent(new CustomEvent("hb:dialog-result", { detail }));
  } catch (_) {}
}

/**
 * Callback-based confirm — fires onConfirm/onCancel based on the
 * player's choice and returns synchronously so the calling function
 * doesn't need to be async. Use this when porting legacy
 * `if (!window.confirm()) return;` sites without rippling async up
 * the call stack: wrap the post-confirm work in onConfirm and pair
 * with an `return;` after the call. Optional `dialogId` + `action`
 * forward to the rec #77 dispatcher.
 */
export function modalConfirmCallback(opts) {
  enqueue({
    title: opts?.title,
    message: opts?.message,
    confirmLabel: opts?.confirmLabel,
    cancelLabel: opts?.cancelLabel,
    dialogId: opts?.dialogId,
    action: opts?.action,
    onConfirm: opts?.onConfirm,
    onCancel: opts?.onCancel,
  });
}

export const manifest = {
  id: "modal-dialog",
  name: "Modal Dialog",
  icon: "◆",
  iconHidden: true,
  version: "0.1.0",
  description: "Brass-themed modal confirm replacement for window.confirm — both Promise + callback APIs.",
};

export function mount() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  function onRequest(ev) {
    const d = ev?.detail ?? {};
    modalConfirmCallback({
      title: d.title,
      message: d.message,
      confirmLabel: d.confirmLabel,
      cancelLabel: d.cancelLabel,
      onConfirm: d.onConfirm,
      onCancel: d.onCancel,
    });
  }
  window.addEventListener("hb:modal-confirm-request", onRequest);
  return () => {
    window.removeEventListener("hb:modal-confirm-request", onRequest);
  };
}

if (typeof window !== "undefined") {
  window.__modalConfirm = modalConfirm;
  window.__modalConfirmCallback = modalConfirmCallback;
  window.__registerDialogHandler = registerDialogHandler;
  window.__emitDialogResult = emitDialogResult;
}
