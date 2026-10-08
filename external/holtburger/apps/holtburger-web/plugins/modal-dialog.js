// Modal dialog component — retail-chrome Are-You-Sure prompt that
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
//   - plugins/salvage-confirm.js (sibling confirm modal; modal-dialog
//     supersedes it for free-form confirms — it keeps its domain-specific
//     state machine)
//
// HUD overhaul 2026-10-05 — retail dialog chrome + keyboard:
//   - frame = retail DialogBox (layout 0x21000042, element 0x100002AF):
//     13×13 brass corner caps 0x06005D39/3A/3B/3C, silver edges
//     0x06005D3D (top/bottom) / 0x06005D3E (left/right) over the navy
//     field 0x06005DDB. Exposed as the shared `.hb-dlg` class
//     (`ensureDialogChromeStyles()`) so salvage-confirm / options-panel
//     prompts all wear the same chrome.
//   - kit `hbk-btn` buttons (confirm first, like retail's Yes / No),
//     gold `hbk-divider` under the title, CSS-text message that wraps
//     (the old single-line <ac-text> canvas ran off the dialog edge).
//   - Enter confirms (or activates the focused button), Esc cancels,
//     Tab / ←→ cycle the two buttons, focus returns where it was.
//   - no ui/ac_font.js import, so node tests can import the siblings
//     that share the chrome.

const OVERLAY_ID = "hb-modal-dialog";
const STYLE_ID = "hb-modal-dialog-style";
const CHROME_STYLE_ID = "hb-dialog-chrome-style";
const SP = "./data/ui-sprites";

let _activeQueue = [];
let _processing = false;
let _domRefs = null;
let _keyHandler = null;
let _restoreFocusEl = null;
let _currentEntry = null; // the entry whose dialog is open (crafting-1 dismiss)

/** Retail DialogBox 8-piece frame + navy field as one multi-background
 *  declaration. Exported for tests / ad-hoc reuse. */
export const DIALOG_FRAME_BACKGROUND = [
  `url("${SP}/0x06005D39.png") left top / 13px 13px no-repeat`,
  `url("${SP}/0x06005D3A.png") right top / 13px 13px no-repeat`,
  `url("${SP}/0x06005D3B.png") left bottom / 13px 14px no-repeat`,
  `url("${SP}/0x06005D3C.png") right bottom / 13px 14px no-repeat`,
  `url("${SP}/0x06005D3D.png") 13px top / calc(100% - 26px) 6px no-repeat`,
  `url("${SP}/0x06005D3D.png") 13px bottom / calc(100% - 26px) 6px no-repeat`,
  `url("${SP}/0x06005D3E.png") left 13px / 4px calc(100% - 27px) no-repeat`,
  `url("${SP}/0x06005D3E.png") right 13px / 4px calc(100% - 27px) no-repeat`,
  `url("${SP}/0x06005DDB.png") 0 0 / 297px 65px repeat`,
  "#070a14",
].join(",\n    ");

/** Install the shared `.hb-dlg` chrome classes once. */
export function ensureDialogChromeStyles() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById?.(CHROME_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = CHROME_STYLE_ID;
  s.textContent = `
  .hb-dlg {
    position: fixed;
    left: 50%;
    top: 40%;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    display: none;
    flex-direction: column;
    min-width: 260px;
    max-width: min(400px, calc(94 * var(--hb-hud-vw, 1vw)));
    max-height: calc(90 * var(--hb-hud-vh, 1vh));
    padding: 12px 16px 13px;
    color: var(--hbk-text, #e8dfc8);
    font-family: var(--hbk-font, serif);
    font-size: 12px;
    background:
    ${DIALOG_FRAME_BACKGROUND};
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.75);
    pointer-events: auto;
    user-select: none;
  }
  .hb-dlg[data-open="1"] { display: flex; }
  .hb-dlg:focus { outline: none; }
  .hb-dlg-title {
    flex: 0 0 auto;
    color: var(--hbk-gold-bright, #f3d27a);
    font-size: 13px;
    letter-spacing: 0.06em;
    text-align: center;
    text-shadow: 0 1px 0 #000;
    padding: 0 6px;
  }
  .hb-dlg > .hbk-divider { flex: 0 0 auto; margin: 4px -4px 8px; }
  .hb-dlg-msg {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    line-height: 1.4;
    white-space: pre-line;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .hb-dlg-sub {
    color: var(--hbk-text-dim, #a8a090);
    font-size: 11px;
    font-style: italic;
    text-align: center;
    margin: 0 0 8px;
  }
  .hb-dlg-actions {
    flex: 0 0 auto;
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .hb-dlg-actions .hbk-btn { min-width: 76px; }
  .hb-dlg-actions .hbk-btn:focus-visible { outline: 1px solid var(--hbk-gold-bright, #f3d27a); outline-offset: 1px; }
  .hb-dlg-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: none;
  }
  .hb-dlg-backdrop[data-open="1"] { display: block; }
  `;
  document.head.appendChild(s);
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  ensureDialogChromeStyles();
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID}-backdrop { z-index: 78; }
    #${OVERLAY_ID} { z-index: 79; }
  `;
  document.head.appendChild(s);
}

function ensureDom() {
  if (_domRefs) return _domRefs;
  ensureStyles();

  const backdrop = document.createElement("div");
  backdrop.id = `${OVERLAY_ID}-backdrop`;
  backdrop.className = "hb-dlg-backdrop";
  backdrop.setAttribute("data-open", "0");

  const dialog = document.createElement("div");
  dialog.id = OVERLAY_ID;
  dialog.className = "hb-dlg";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("data-open", "0");
  dialog.tabIndex = -1;

  const titleEl = document.createElement("div");
  titleEl.className = "hb-dlg-title";
  titleEl.id = `${OVERLAY_ID}-title`;
  dialog.appendChild(titleEl);
  dialog.setAttribute("aria-labelledby", titleEl.id);

  const divider = document.createElement("div");
  divider.className = "hbk-divider";
  dialog.appendChild(divider);

  const msgEl = document.createElement("div");
  msgEl.className = "hb-dlg-msg hbk-scroll";
  msgEl.id = `${OVERLAY_ID}-msg`;
  dialog.appendChild(msgEl);
  dialog.setAttribute("aria-describedby", msgEl.id);

  const row = document.createElement("div");
  row.className = "hb-dlg-actions";

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "hbk-btn";
  okBtn.dataset.action = "confirm";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hbk-btn";
  cancelBtn.dataset.action = "cancel";

  row.appendChild(okBtn);
  row.appendChild(cancelBtn);
  dialog.appendChild(row);

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  _domRefs = { backdrop, dialog, titleEl, msgEl, okBtn, cancelBtn };
  return _domRefs;
}

function openCurrent(entry) {
  const refs = ensureDom();
  _currentEntry = entry;
  refs.titleEl.textContent = entry.title || "Confirm";
  refs.msgEl.textContent = entry.message || "";
  refs.msgEl.scrollTop = 0;
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
        ev.stopPropagation();
        resolve(entry, false);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        // Enter confirms — unless the player tabbed onto Cancel.
        resolve(entry, document.activeElement !== refs.cancelBtn);
      } else if (ev.key === "Tab" || ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        // Keep focus inside the dialog: cycle the two buttons.
        ev.preventDefault();
        ev.stopPropagation();
        const next = document.activeElement === refs.okBtn ? refs.cancelBtn : refs.okBtn;
        try { next.focus({ preventScroll: true }); } catch (_) {}
      }
    };
    document.addEventListener("keydown", _keyHandler, true);
  }
  try {
    const ae = document.activeElement;
    _restoreFocusEl = (ae && ae !== document.body && !refs.dialog.contains(ae)) ? ae : null;
  } catch (_) { _restoreFocusEl = null; }
  try { refs.okBtn.focus({ preventScroll: true }); } catch (_) {}
}

// Tear the open dialog down (DOM, key handler, focus) without deciding it.
function closeDom() {
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
  const restore = _restoreFocusEl;
  _restoreFocusEl = null;
  try {
    if (restore && restore.isConnected) restore.focus({ preventScroll: true });
    else if (refs.dialog.contains(document.activeElement)) document.activeElement.blur();
  } catch (_) {}
}

/**
 * crafting-1 (2026-10-08): close an entry WITHOUT a decision — retail's
 * DialogFactory::CloseDialog on a server ConfirmationDone. A queued entry is
 * dropped; the open one is closed and `onDismiss` (not onConfirm/onCancel)
 * runs. No dialog-result event fires. Returns true when the entry was found.
 */
function dismissEntry(entry) {
  if (!entry) return false;
  const qi = _activeQueue.indexOf(entry);
  if (qi >= 0) {
    _activeQueue.splice(qi, 1);
    try { entry.onDismiss?.(); } catch (e) { console.warn("[modal-dialog] onDismiss threw:", e); }
    return true;
  }
  if (_currentEntry !== entry) return false;
  _currentEntry = null;
  closeDom();
  try { entry.onDismiss?.(); } catch (e) { console.warn("[modal-dialog] onDismiss threw:", e); }
  try { entry.resolvePromise?.(false); } catch (_) {}
  _processing = false;
  setTimeout(processNext, 0);
  return true;
}

function resolve(entry, accepted) {
  const refs = _domRefs;
  if (!refs) return;
  if (_currentEntry === entry) _currentEntry = null;
  refs.backdrop.setAttribute("data-open", "0");
  refs.dialog.setAttribute("data-open", "0");
  refs.okBtn.onclick = null;
  refs.cancelBtn.onclick = null;
  refs.backdrop.onclick = null;
  if (_keyHandler) {
    document.removeEventListener("keydown", _keyHandler, true);
    _keyHandler = null;
  }
  const restore = _restoreFocusEl;
  _restoreFocusEl = null;
  try {
    if (restore && restore.isConnected) restore.focus({ preventScroll: true });
    else if (refs.dialog.contains(document.activeElement)) document.activeElement.blur();
  } catch (_) {}
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
  const entry = {
    title: opts?.title,
    message: opts?.message,
    confirmLabel: opts?.confirmLabel,
    cancelLabel: opts?.cancelLabel,
    dialogId: opts?.dialogId,
    action: opts?.action,
    onConfirm: opts?.onConfirm,
    onCancel: opts?.onCancel,
    onDismiss: opts?.onDismiss,
  };
  enqueue(entry);
  // crafting-1 (2026-10-08): a handle so a caller can close the dialog
  // without an answer (server ConfirmationDone). Callers that ignore the
  // return value are unaffected.
  return {
    dismiss: () => dismissEntry(entry),
    isOpen: () => _currentEntry === entry,
    isPending: () => _currentEntry === entry || _activeQueue.includes(entry),
  };
}

export const manifest = {
  id: "modal-dialog",
  name: "Modal Dialog",
  icon: "◆",
  iconHidden: true,
  version: "0.2.0",
  description: "Retail-chrome modal confirm replacement for window.confirm — both Promise + callback APIs.",
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
