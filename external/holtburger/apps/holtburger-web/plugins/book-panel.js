// book-panel — floating book reader / editor.
//
// AC Books (2026-05-25). Subscribes to `bookUpdated` (kind=24) and
// renders the snapshot returned by `handle.playerBook()`. Wires the
// 5 book primitives (bookData / bookAddPage / bookModifyPage /
// bookDeletePage / setInscription) to UI controls.
//
// Retail Book UI (mirrored loosely):
//   - Title bar + close X
//   - Inscription strip (display + "Set Inscription" button)
//   - Page navigator: ◀ / Page N of M / ▶
//   - Page content (textarea, read-only by default; "Edit" toggles)
//   - Footer: Add Page / Delete Page
//
// Snapshot lifecycle:
//   - null pre-open → panel hidden
//   - first BookDataResponse → panel shown
//   - any BookModifyPageResponse / AddPageResponse / DeletePageResponse
//     → JS re-fires bookData(guid) to refresh page text
//
// Debug entry: window.__openBookFor(guid) fires bookData(guid).

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-book-panel";
const STYLE_ID = "hb-book-panel-style";

let overlayEl = null;
let onKeyDownHandler = null;

// Local UI state — what's not in the snapshot.
let currentPageIndex = 0;
let editMode = false;
let lastSnapshotGuid = 0;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 90px;
      left: calc(50% + 200px);
      width: 320px;
      height: 340px;
      z-index: 70;
      display: none;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(20, 14, 8, 0.94);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
      user-select: none;
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; flex-direction: column; }
    #${OVERLAY_ID} .hbk-header {
      flex: 0 0 22px;
      display: flex;
      align-items: center;
      padding: 0 6px 0 8px;
      background: var(--hb-overlay-active);
      border-bottom: 1px solid var(--hb-border-brass);
      color: var(--hb-text-gold);
      font-size: 12px;
      letter-spacing: 0.02em;
    }
    #${OVERLAY_ID} .hbk-title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 0 rgba(0,0,0,.85);
    }
    #${OVERLAY_ID} .hbk-close {
      flex: 0 0 auto;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 10px;
      line-height: 1;
      padding: 1px 6px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hbk-close:hover {
      background: var(--hb-overlay-hover);
      color: var(--hb-text-cream-bright);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hbk-inscription-strip {
      flex: 0 0 26px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      background: rgba(0,0,0,0.25);
    }
    #${OVERLAY_ID} .hbk-inscription-text {
      flex: 1 1 auto;
      font-size: 10px;
      color: var(--hb-text-cream);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-style: italic;
      opacity: 0.85;
    }
    #${OVERLAY_ID} .hbk-nav {
      flex: 0 0 22px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 6px;
      background: rgba(0,0,0,0.18);
    }
    #${OVERLAY_ID} .hbk-nav-label {
      flex: 1 1 auto;
      text-align: center;
      font-size: 11px;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .hbk-page-content {
      flex: 1 1 auto;
      display: flex;
      padding: 6px;
      overflow: hidden;
    }
    #${OVERLAY_ID} .hbk-page-textarea {
      flex: 1 1 auto;
      width: 100%;
      box-sizing: border-box;
      background: #2a1f15;
      color: #f0e8d0;
      border: 1px solid var(--hb-border-brass-dim);
      font-family: var(--hb-font-serif);
      font-size: 11px;
      line-height: 1.4;
      padding: 6px;
      resize: none;
      outline: none;
    }
    #${OVERLAY_ID} .hbk-page-textarea:focus {
      border-color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hbk-page-textarea[readonly] {
      cursor: default;
    }
    #${OVERLAY_ID} .hbk-footer {
      flex: 0 0 28px;
      display: flex;
      gap: 4px;
      padding: 0 6px 6px;
    }
    #${OVERLAY_ID} .hbk-btn {
      flex: 1 1 0;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 10px;
      padding: 3px 0;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hbk-btn:hover {
      background: var(--hb-overlay-hover);
      border-color: var(--hb-border-brass);
      color: var(--hb-text-cream-bright);
    }
    #${OVERLAY_ID} .hbk-btn:disabled {
      opacity: 0.35;
      cursor: default;
      background: transparent;
    }
    #${OVERLAY_ID} .hbk-btn-edit[data-on="1"] {
      background: rgba(120, 90, 20, 0.5);
      border-color: var(--hb-text-gold);
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hbk-btn-delete {
      color: #d09898;
    }
  `;
  document.head.appendChild(s);
}

function fmtGuid(guid) {
  return `0x${(guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function buildOverlay() {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Header
  const header = document.createElement("div");
  header.className = "hbk-header";
  const title = document.createElement("div");
  title.className = "hbk-title";
  setAcText(title, "Book", { color: "#f0c87c" });
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hbk-close";
  closeBtn.title = "Close (Esc)";
  setAcText(closeBtn, "X");
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hidePanel();
  });
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  // Inscription strip
  const inscStrip = document.createElement("div");
  inscStrip.className = "hbk-inscription-strip";
  const inscText = document.createElement("div");
  inscText.className = "hbk-inscription-text";
  setAcText(inscText, "(no inscription)");
  inscStrip.appendChild(inscText);
  const setInscBtn = document.createElement("button");
  setInscBtn.type = "button";
  setInscBtn.className = "hbk-btn";
  setInscBtn.style.flex = "0 0 auto";
  setInscBtn.style.padding = "2px 6px";
  setAcText(setInscBtn, "Set");
  setInscBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onSetInscription();
  });
  inscStrip.appendChild(setInscBtn);
  overlay.appendChild(inscStrip);

  // Page navigator
  const nav = document.createElement("div");
  nav.className = "hbk-nav";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "hbk-btn";
  prevBtn.style.flex = "0 0 30px";
  prevBtn.style.padding = "2px 0";
  setAcText(prevBtn, "<");
  prevBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (currentPageIndex > 0) {
      currentPageIndex--;
      editMode = false;
      rerender();
    }
  });
  nav.appendChild(prevBtn);
  const navLabel = document.createElement("div");
  navLabel.className = "hbk-nav-label";
  setAcText(navLabel, "Page 0 of 0");
  nav.appendChild(navLabel);
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "hbk-btn";
  nextBtn.style.flex = "0 0 30px";
  nextBtn.style.padding = "2px 0";
  setAcText(nextBtn, ">");
  nextBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const snap = readSnapshot();
    if (snap && currentPageIndex < (snap.pages?.length ?? 0) - 1) {
      currentPageIndex++;
      editMode = false;
      rerender();
    }
  });
  nav.appendChild(nextBtn);
  overlay.appendChild(nav);

  // Page content
  const content = document.createElement("div");
  content.className = "hbk-page-content";
  const textarea = document.createElement("textarea");
  textarea.className = "hbk-page-textarea";
  textarea.readOnly = true;
  textarea.spellcheck = false;
  content.appendChild(textarea);
  overlay.appendChild(content);

  // Footer: Edit/Save, Add Page, Delete Page
  const footer = document.createElement("div");
  footer.className = "hbk-footer";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "hbk-btn hbk-btn-edit";
  setAcText(editBtn, "Edit");
  editBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (editMode) {
      onSavePage();
    } else {
      editMode = true;
      rerender();
      textarea.focus();
    }
  });
  footer.appendChild(editBtn);
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "hbk-btn";
  setAcText(addBtn, "Add Page");
  addBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onAddPage();
  });
  footer.appendChild(addBtn);
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "hbk-btn hbk-btn-delete";
  setAcText(delBtn, "Delete", { color: "#d09898" });
  delBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onDeletePage();
  });
  footer.appendChild(delBtn);
  overlay.appendChild(footer);

  overlay._titleEl = title;
  overlay._inscTextEl = inscText;
  overlay._navLabelEl = navLabel;
  overlay._textareaEl = textarea;
  overlay._editBtnEl = editBtn;
  overlay._prevBtnEl = prevBtn;
  overlay._nextBtnEl = nextBtn;
  overlay._delBtnEl = delBtn;
  overlay._addBtnEl = addBtn;

  document.body.appendChild(overlay);
  return overlay;
}

function readSnapshot() {
  const handle = window.__sessionHandle;
  if (!handle?.playerBook) return null;
  try {
    return handle.playerBook();
  } catch (e) {
    console.warn("[book-panel] playerBook getter failed:", e);
    return null;
  }
}

function rerender() {
  if (!overlayEl) return;
  const snap = readSnapshot();
  if (!snap) {
    hidePanel();
    return;
  }

  // If we got a snapshot for a different book, reset page index + mode.
  const snapGuid = snap.objectGuid >>> 0;
  if (snapGuid !== lastSnapshotGuid) {
    currentPageIndex = 0;
    editMode = false;
    lastSnapshotGuid = snapGuid;
  }

  let pages = [];
  try {
    pages = Array.from(snap.pages || []);
  } catch (_) {}

  const total = pages.length;
  const idx = Math.min(currentPageIndex, Math.max(0, total - 1));
  currentPageIndex = idx;

  const titleStr = `Book ${fmtGuid(snapGuid)}`;
  setAcText(overlayEl._titleEl, titleStr, { color: "#f0c87c" });

  const inscription = snap.inscription || "";
  setAcText(
    overlayEl._inscTextEl,
    inscription.length > 0 ? inscription : "(no inscription)",
  );

  setAcText(
    overlayEl._navLabelEl,
    total > 0 ? `Page ${idx + 1} of ${total}` : "(no pages)",
  );

  const page = pages[idx];
  const text = page?.text ?? "";
  // Only overwrite the textarea when not in edit mode — preserves
  // in-flight typing if a snapshot arrives mid-edit.
  if (!editMode) {
    overlayEl._textareaEl.value = text;
  }
  overlayEl._textareaEl.readOnly = !editMode;
  overlayEl._editBtnEl.dataset.on = editMode ? "1" : "0";
  setAcText(
    overlayEl._editBtnEl,
    editMode ? "Save" : "Edit",
    { color: editMode ? "#f0c87c" : "#f0e8d0" },
  );

  overlayEl._prevBtnEl.disabled = idx <= 0;
  overlayEl._nextBtnEl.disabled = idx >= total - 1;
  overlayEl._delBtnEl.disabled = total <= 0;

  showPanel();
}

function showPanel() {
  if (!overlayEl) return;
  overlayEl.dataset.open = "1";
  if (!onKeyDownHandler) {
    onKeyDownHandler = (ev) => {
      if (overlayEl?.dataset.open !== "1") return;
      // Ignore textarea-targeted keystrokes so editing isn't hijacked.
      if (ev.target === overlayEl._textareaEl) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        hidePanel();
      }
    };
    document.addEventListener("keydown", onKeyDownHandler, true);
  }
}

function hidePanel() {
  if (!overlayEl) return;
  overlayEl.dataset.open = "0";
  editMode = false;
  if (onKeyDownHandler) {
    document.removeEventListener("keydown", onKeyDownHandler, true);
    onKeyDownHandler = null;
  }
}

function onSetInscription() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const current = snap.inscription || "";
  const next = window.prompt("Set inscription (empty to clear):", current);
  if (next === null) return; // cancel
  const handle = window.__sessionHandle;
  if (!handle?.setInscription) {
    console.warn("[book-panel] setInscription not available");
    return;
  }
  try {
    handle.setInscription(guid, next);
  } catch (e) {
    console.warn("[book-panel] setInscription failed:", e);
  }
}

function onSavePage() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const text = overlayEl._textareaEl.value;
  const handle = window.__sessionHandle;
  if (!handle?.bookModifyPage) {
    console.warn("[book-panel] bookModifyPage not available");
    return;
  }
  try {
    // ignore_author=false; ACE ignores this field on the wire.
    handle.bookModifyPage(guid, currentPageIndex, false, text);
    editMode = false;
    rerender();
    // Re-fetch fresh book contents post-ack — the page-response arms
    // don't carry the new text, so we re-pull via bookData.
    setTimeout(() => {
      try {
        handle.bookData(guid);
      } catch (_) {}
    }, 200);
  } catch (e) {
    console.warn("[book-panel] bookModifyPage failed:", e);
  }
}

function onAddPage() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const handle = window.__sessionHandle;
  if (!handle?.bookAddPage) {
    console.warn("[book-panel] bookAddPage not available");
    return;
  }
  try {
    handle.bookAddPage(guid);
    setTimeout(() => {
      try {
        handle.bookData(guid);
      } catch (_) {}
    }, 200);
  } catch (e) {
    console.warn("[book-panel] bookAddPage failed:", e);
  }
}

function onDeletePage() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  if (!window.confirm(`Delete page ${currentPageIndex + 1}?`)) return;
  const handle = window.__sessionHandle;
  if (!handle?.bookDeletePage) {
    console.warn("[book-panel] bookDeletePage not available");
    return;
  }
  try {
    handle.bookDeletePage(guid, currentPageIndex);
    // Re-fetch — server reshuffles indices on delete.
    setTimeout(() => {
      try {
        handle.bookData(guid);
      } catch (_) {}
    }, 200);
  } catch (e) {
    console.warn("[book-panel] bookDeletePage failed:", e);
  }
}

function onBookUpdated() {
  if (!overlayEl) overlayEl = buildOverlay();
  rerender();
}

// Subscribe at module-load; poll for the bus until login wires it.
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("bookUpdated", onBookUpdated);
  client.events.on("kind:24", onBookUpdated);
  return true;
}
if (typeof window !== "undefined") {
  // P3-41 — replace bootstrap poll with one-shot await on the global
  // pluginClient bootstrap promise (installed by index.html). Falls
  // back to the poll if the promise isn't installed (older host / tests).
  if (!trySubscribe()) {
    if (window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { trySubscribe(); });
    } else {
      _subscribeTimer = setInterval(() => {
        if (trySubscribe()) {
          clearInterval(_subscribeTimer);
          _subscribeTimer = null;
        }
      }, 500);
    }
  }

  // Debug entry — open a book by guid.
  window.__openBookFor = (objectGuid) => {
    const guid = (objectGuid >>> 0);
    const handle = window.__sessionHandle;
    if (!handle?.bookData) {
      console.warn("[book-panel] no session handle / bookData missing");
      return;
    }
    try {
      handle.bookData(guid);
      console.log(`[book-panel] bookData(${fmtGuid(guid)}) requested`);
    } catch (e) {
      console.warn("[book-panel] bookData failed:", e);
    }
  };
}

export const manifest = {
  id: "book-panel",
  name: "Book",
  icon: "B",
  iconHidden: true,
  version: "0.1.0",
  description:
    "Book reader / editor — auto-opens on kind=24 BookUpdated, wires Use/Edit/Add/Delete + Set Inscription",
};
