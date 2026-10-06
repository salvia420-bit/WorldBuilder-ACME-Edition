// book-panel — the Book reader / editor (retail gmBookUI, layout 0x21000019).
//
// HUD overhaul 2026-10-05 — rebuilt as the retail parchment book.
//
// Retail RootBook_Field is a 300×362 window: the 276×30 title bar sprite
// (0x06001279) carrying the book's name with the 24×30 close (0x0600126C /
// hover 0x0600126D) beside it, a parchment page (0x0600126F tiled) with the
// green "previous" corner at the top-left (0x06001269 / hover 126A /
// ghosted 126B, 54×33) and "next" at the bottom-right (0x06001266 / 1267 /
// 1268, 65×32), the page text in a 262×240 box with the rope scrollbar,
// and a page pull-down along the bottom (BookPagePullDownList over the
// 0x0600126E filler + 0x06001265 bottom edge).
//
// Ours is that window, draggable (attachWindowPosition id 0x1000010D =
// RootBook_Field), with the text in a readable serif ink on the parchment
// (prose wraps, so it is CSS text, not the bitmap font), "by <author>" under
// the title, "Page N of M", Left/Right arrow keys to turn pages, and the
// writing controls (Edit / Add Page / Delete / Inscribe) as small kit
// buttons on the bottom strip. Editing happens in place on the parchment
// with a live character count against maxCharsPerPage; Esc cancels an edit
// before it closes the book. Deletes confirm through the kit modal.
//
// Wire (unchanged): `bookUpdated` / `kind:24` → handle.playerBook();
// bookModifyPage / bookAddPage / bookDeletePage / setInscription, each
// followed by bookData(guid) to refresh (the page-response arms don't carry
// text). Debug: window.__openBookFor(guid).

import { setAcText } from "../ui/ac_font.js";
import { modalConfirmCallback } from "./modal-dialog.js";
import {
  createKitWindow, COMMERCE_WINDOW_ID, objectDisplayName, devHex,
} from "./commerce_window.js";
import { clampPage } from "./commerce_logic.js";

const OVERLAY_ID = "hb-book-panel";
const STYLE_ID = "hb-book-panel-style";
const SP = "./data/ui-sprites";

let win = null;
let refs = null;

// Local UI state — what's not in the snapshot.
let currentPageIndex = 0;
let mode = "read"; // "read" | "edit" | "inscribe"
let lastSnapshotGuid = 0;
// After Add Page: jump to the new last page once a snapshot with at least
// this many pages lands (the add-page ack and the bookData refetch can
// arrive in either order).
let jumpToCount = 0;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      width: 300px; height: 362px;
      color: #2b1a0a;
      font-family: var(--hbk-font, serif);
      background: #1a140c;
      box-shadow: 0 0 0 1px #000, 0 10px 28px rgba(0, 0, 0, 0.7);
      user-select: none;
      pointer-events: auto;
    }
    /* Title — TitleBackground 0x06001279 + CloseBookPanelButton 0x0600126C. */
    #${OVERLAY_ID} .hbo-titlebar {
      position: relative; flex: 0 0 30px; height: 30px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 34px 0 14px; box-sizing: border-box;
      background: url("${SP}/0x06001279.png") left top / 276px 30px no-repeat, #2a1d10;
      cursor: move; touch-action: none; overflow: hidden;
    }
    #${OVERLAY_ID} .hbo-title { max-width: 100%; overflow: hidden; }
    #${OVERLAY_ID} .hbo-close {
      position: absolute; top: 0; right: 0; width: 24px; height: 30px;
      border: 0; padding: 0; cursor: pointer;
      background: url("${SP}/0x0600126C.png") center / 100% 100% no-repeat;
    }
    #${OVERLAY_ID} .hbo-close:hover, #${OVERLAY_ID} .hbo-close:focus-visible {
      background-image: url("${SP}/0x0600126D.png");
    }
    /* Page — BookPage_Background 0x0600126F. */
    #${OVERLAY_ID} .hbo-page {
      position: relative; flex: 1 1 auto; min-height: 0;
      background: url("${SP}/0x0600126F.png") left top / 265px 100px repeat;
      box-shadow: inset 0 0 18px rgba(60, 35, 10, 0.45);
    }
    #${OVERLAY_ID} .hbo-author {
      position: absolute; left: 58px; right: 8px; top: 6px; height: 18px;
      text-align: center; font-style: italic; font-size: 12px; color: #5a3c1c;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${OVERLAY_ID} .hbo-text, #${OVERLAY_ID} .hbo-edit {
      position: absolute; left: 18px; right: 4px; top: 30px; bottom: 36px;
      box-sizing: border-box; margin: 0; padding: 2px 8px 2px 4px;
      font-family: var(--hbk-font, serif); font-size: 13px; line-height: 1.38;
      color: #2b1a0a; white-space: pre-wrap; overflow-wrap: anywhere;
      user-select: text;
    }
    #${OVERLAY_ID} .hbo-text.is-empty { color: #7a5a34; font-style: italic; }
    #${OVERLAY_ID} .hbo-edit {
      resize: none; outline: none;
      background: rgba(255, 245, 220, 0.35);
      border: 1px solid rgba(90, 60, 28, 0.6);
      box-shadow: inset 0 1px 4px rgba(60, 35, 10, 0.35);
    }
    #${OVERLAY_ID} .hbo-edit:focus { border-color: #8a5a20; }
    #${OVERLAY_ID} .hbo-edit[hidden], #${OVERLAY_ID} .hbo-text[hidden] { display: none; }
    #${OVERLAY_ID} .hbo-edit-label {
      position: absolute; left: 22px; top: 12px; font-size: 11px; color: #5a3c1c; font-style: italic;
    }
    /* Retail BookPreviousButton / BookNextButton corner sprites. */
    #${OVERLAY_ID} .hbo-prev, #${OVERLAY_ID} .hbo-next {
      position: absolute; border: 0; padding: 0; cursor: pointer; background-color: transparent;
    }
    #${OVERLAY_ID} .hbo-prev { left: 0; top: 0; width: 54px; height: 33px; background: url("${SP}/0x06001269.png") center / 100% 100% no-repeat; }
    #${OVERLAY_ID} .hbo-prev:hover:not(:disabled) { background-image: url("${SP}/0x0600126A.png"); }
    #${OVERLAY_ID} .hbo-prev:disabled { background-image: url("${SP}/0x0600126B.png"); cursor: default; }
    #${OVERLAY_ID} .hbo-next { right: 0; bottom: 0; width: 65px; height: 32px; background: url("${SP}/0x06001266.png") center / 100% 100% no-repeat; }
    #${OVERLAY_ID} .hbo-next:hover:not(:disabled) { background-image: url("${SP}/0x06001267.png"); }
    #${OVERLAY_ID} .hbo-next:disabled { background-image: url("${SP}/0x06001268.png"); cursor: default; }
    #${OVERLAY_ID} .hbo-pageno { position: absolute; left: 12px; bottom: 9px; }
    /* Bottom strip — BookFiller_Left 0x0600126E + BookAbs_Bottom 0x06001265. */
    #${OVERLAY_ID} .hbo-bottom {
      flex: 0 0 auto; display: flex; align-items: center; gap: 3px;
      padding: 4px 4px 8px 6px;
      background:
        url("${SP}/0x06001265.png") left bottom / 300px 6px no-repeat,
        url("${SP}/0x06004CC2.png") repeat, #0b0c10;
      color: var(--hbk-text);
    }
    #${OVERLAY_ID} .hbo-bottom select.hbk-select { width: 74px; min-height: 18px; padding: 0 2px; font-size: 11px; }
    #${OVERLAY_ID} .hbo-bottom .hbk-btn-small { min-width: 0; padding: 0 5px; height: 16px; }
    #${OVERLAY_ID} .hbo-bottom .hbo-spacer { flex: 1 1 auto; }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function smallBtn(label, onClick, title = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "hbk-btn-small";
  if (title) b.title = title;
  setAcText(b, label, { color: "#f0e0c0" });
  b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
  return b;
}

function buildOverlay() {
  ensureStyles();
  // Parchment chrome — the retail title bar sprite is the drag handle.
  const bar = el("div", "hbo-titlebar");
  const title = el("span", "hbo-title", bar);
  const close = el("button", "hbo-close", bar);
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", (ev) => { ev.stopPropagation(); win?.requestClose("button"); });

  win = createKitWindow({
    id: OVERLAY_ID,
    title: "Book",
    windowId: COMMERCE_WINDOW_ID.BOOK,
    kitChrome: false,
    titlebar: { bar, title, close },
    // Retail opens the book in the floaty-panel slot; we sit just left of
    // the main panel so both stay readable.
    defaultPos: {
      left: "auto", bottom: "auto",
      right: `max(4px, min(316px, calc(100 * var(--hb-hud-vw, 1vw) - 308px)))`,
      top: `max(4px, min(160px, calc(100 * var(--hb-hud-vh, 1vh) - 366px)))`,
    },
    className: "hb-book",
    onHide: () => { mode = "read"; },
    // Esc while editing cancels the edit; a second Esc closes the book.
    onEscape: () => {
      if (mode !== "read") {
        mode = "read";
        rerender();
        return true;
      }
      return false;
    },
  });
  // Dark-ink title on the salmon title sprite.
  win.setTitle = (text) => {
    win.root.setAttribute("aria-label", String(text ?? ""));
    setAcText(title, String(text ?? ""), { color: "#2b1a0a", fit: true });
  };

  const page = el("div", "hbo-page", win.body);
  const author = el("div", "hbo-author", page);
  const editLabel = el("div", "hbo-edit-label", page);
  editLabel.hidden = true;
  const text = el("div", "hbo-text hbk-scroll", page);
  const edit = el("textarea", "hbo-edit hbk-scroll", page);
  edit.hidden = true;
  edit.spellcheck = true;
  edit.addEventListener("input", () => updateCounter());
  const prev = el("button", "hbo-prev", page);
  prev.type = "button";
  prev.title = "Previous page (←)";
  prev.addEventListener("click", (ev) => { ev.stopPropagation(); turnPage(-1); });
  const next = el("button", "hbo-next", page);
  next.type = "button";
  next.title = "Next page (→)";
  next.addEventListener("click", (ev) => { ev.stopPropagation(); turnPage(1); });
  const pageNo = el("div", "hbo-pageno", page);

  const bottom = el("div", "hbo-bottom", win.body);
  const pageSel = el("select", "hbk-select", bottom);
  pageSel.title = "Go to page";
  pageSel.addEventListener("change", () => {
    currentPageIndex = parseInt(pageSel.value, 10) || 0;
    mode = "read";
    rerender();
  });
  pageSel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); pageSel.blur(); } });
  el("div", "hbo-spacer", bottom);
  const editBtn = smallBtn("Edit", () => onEditButton(), "Write on this page");
  const cancelBtn = smallBtn("Cancel", () => { mode = "read"; rerender(); });
  const addBtn = smallBtn("Add Page", () => onAddPage(), "Add a blank page at the end");
  const delBtn = smallBtn("Delete", () => onDeletePage(), "Remove this page");
  const inscBtn = smallBtn("Inscribe", () => { mode = "inscribe"; rerender(); edit.focus(); }, "Set the book's inscription");
  bottom.append(editBtn, cancelBtn, addBtn, delBtn, inscBtn);

  // Page turning from the keyboard while the book (not a field) has focus.
  win.root.addEventListener("keydown", (ev) => {
    if (mode !== "read" || ev.target === edit || ev.target === pageSel) return;
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") { ev.preventDefault(); turnPage(-1); }
    else if (ev.key === "ArrowRight" || ev.key === "PageDown") { ev.preventDefault(); turnPage(1); }
  });
  win.root.addEventListener("pointerdown", (ev) => {
    if (!ev.target?.closest?.("button, select, textarea, input")) {
      try { win.root.focus({ preventScroll: true }); } catch (_) {}
    }
  });

  refs = { author, editLabel, text, edit, prev, next, pageNo, pageSel, editBtn, cancelBtn, addBtn, delBtn, inscBtn };
}

// Verifier hook (window.__bookPanelDebug) — a synthetic snapshot so the
// parchment can be screenshotted without a real book in the pack.
let _debugSnap = null;

function readSnapshot() {
  if (_debugSnap) return _debugSnap;
  const handle = window.__sessionHandle;
  if (!handle?.playerBook) return null;
  try {
    return handle.playerBook();
  } catch (e) {
    console.warn("[book-panel] playerBook getter failed:", e);
    return null;
  }
}

function pagesOf(snap) {
  try { return Array.from(snap?.pages || []).map((p) => ({ text: p.text ?? "", authorName: p.authorName ?? "" })); }
  catch (_) { return []; }
}

function turnPage(delta) {
  const snap = readSnapshot();
  const total = pagesOf(snap).length;
  const next = clampPage(currentPageIndex + delta, total);
  if (next === currentPageIndex) return;
  currentPageIndex = next;
  mode = "read";
  rerender();
}

function updateCounter() {
  if (!refs || mode === "read") return;
  const snap = readSnapshot();
  if (mode === "edit") {
    const max = snap?.maxCharsPerPage | 0;
    const n = refs.edit.value.length;
    setAcText(refs.pageNo, max ? `${n} / ${max} characters` : `${n} characters`, {
      color: max && n > max ? "#a01c0c" : "#3a2410",
    });
  }
}

function rerender() {
  if (!refs) return;
  const snap = readSnapshot();
  if (!snap) {
    win?.close();
    return;
  }
  const snapGuid = snap.objectGuid >>> 0;
  if (snapGuid !== lastSnapshotGuid) {
    currentPageIndex = 0;
    mode = "read";
    jumpToCount = 0;
    lastSnapshotGuid = snapGuid;
  }
  const pages = pagesOf(snap);
  const total = pages.length;
  if (jumpToCount && total >= jumpToCount) {
    currentPageIndex = total - 1;
    jumpToCount = 0;
  }
  currentPageIndex = clampPage(currentPageIndex, total);
  const page = pages[currentPageIndex];

  const bookName = objectDisplayName(snapGuid, "Book");
  win.setTitle(bookName);
  win.bar.title = bookName;
  const author = (page?.authorName || snap.authorName || "").trim();
  refs.author.textContent = author ? `by ${author}` : "";

  // Page select.
  refs.pageSel.replaceChildren();
  if (total === 0) {
    const o = document.createElement("option");
    o.value = "0";
    o.textContent = "No pages";
    refs.pageSel.appendChild(o);
  } else {
    for (let i = 0; i < total; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `Page ${i + 1}`;
      refs.pageSel.appendChild(o);
    }
  }
  refs.pageSel.value = String(currentPageIndex);
  refs.pageSel.disabled = total <= 1 || mode !== "read";

  const reading = mode === "read";
  refs.text.hidden = !reading;
  refs.edit.hidden = reading;
  refs.editLabel.hidden = reading;
  refs.prev.disabled = !reading || currentPageIndex <= 0;
  refs.next.disabled = !reading || currentPageIndex >= total - 1;

  if (reading) {
    const body = page?.text ?? "";
    refs.text.textContent = total === 0
      ? "This book has no pages yet."
      : (body.trim() ? body : "This page is blank.");
    refs.text.classList.toggle("is-empty", total === 0 || !body.trim());
    refs.text.scrollTop = 0;
    setAcText(refs.pageNo, total > 0 ? `Page ${currentPageIndex + 1} of ${total}` : "", { color: "#3a2410" });
  } else if (mode === "edit") {
    refs.editLabel.textContent = total > 0 ? `Writing on page ${currentPageIndex + 1}` : "Writing";
    if (refs.edit.dataset.mode !== "edit" || refs.edit.dataset.page !== String(currentPageIndex)) {
      refs.edit.value = page?.text ?? "";
    }
    const max = snap.maxCharsPerPage | 0;
    if (max > 0) refs.edit.maxLength = max; else refs.edit.removeAttribute("maxlength");
    updateCounter();
  } else {
    refs.editLabel.textContent = "Inscription";
    if (refs.edit.dataset.mode !== "inscribe") refs.edit.value = snap.inscription || "";
    refs.edit.removeAttribute("maxlength");
    setAcText(refs.pageNo, "Leave empty to clear it", { color: "#3a2410" });
  }
  refs.edit.dataset.mode = mode;
  refs.edit.dataset.page = String(currentPageIndex);

  // Writing controls.
  setAcText(refs.editBtn, reading ? "Edit" : "Save", { color: reading ? "#f0e0c0" : "#f3d27a" });
  refs.editBtn.title = reading ? "Write on this page" : "Save your changes";
  refs.editBtn.disabled = reading && total === 0;
  refs.cancelBtn.hidden = reading;
  refs.addBtn.hidden = !reading;
  refs.delBtn.hidden = !reading;
  refs.inscBtn.hidden = !reading;
  const maxPages = snap.maxNumPages | 0;
  refs.addBtn.disabled = maxPages > 0 && total >= maxPages;
  refs.addBtn.title = refs.addBtn.disabled ? `This book holds at most ${maxPages} pages` : "Add a blank page at the end";
  refs.delBtn.disabled = total <= 0;

  win.open();
}

function onEditButton() {
  if (mode === "read") {
    mode = "edit";
    rerender();
    try { refs.edit.focus(); } catch (_) {}
    return;
  }
  if (mode === "edit") onSavePage();
  else onSaveInscription();
}

function refetch(handle, guid) {
  setTimeout(() => { try { handle.bookData(guid); } catch (_) {} }, 200);
}

function onSaveInscription() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const handle = window.__sessionHandle;
  if (!handle?.setInscription) {
    win?.toast("Inscribing is not available", "err");
    return;
  }
  try {
    handle.setInscription(guid, refs.edit.value);
    mode = "read";
    rerender();
    win?.toast("Inscription saved");
  } catch (e) {
    console.warn("[book-panel] setInscription failed:", e);
  }
}

function onSavePage() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const text = refs.edit.value;
  const handle = window.__sessionHandle;
  if (!handle?.bookModifyPage) {
    win?.toast("Writing is not available", "err");
    return;
  }
  try {
    // ignore_author=false; ACE ignores this field on the wire.
    handle.bookModifyPage(guid, currentPageIndex, false, text);
    mode = "read";
    rerender();
    refetch(handle, guid);
  } catch (e) {
    console.warn("[book-panel] bookModifyPage failed:", e);
  }
}

function onAddPage() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const handle = window.__sessionHandle;
  if (!handle?.bookAddPage) return;
  try {
    handle.bookAddPage(guid);
    jumpToCount = pagesOf(snap).length + 1; // jump to the new page once it lands
    refetch(handle, guid);
  } catch (e) {
    console.warn("[book-panel] bookAddPage failed:", e);
  }
}

function onDeletePage() {
  const snap = readSnapshot();
  if (!snap) return;
  const guid = snap.objectGuid >>> 0;
  const pageIdx = currentPageIndex;
  modalConfirmCallback({
    title: "Delete Page",
    message: `Remove page ${pageIdx + 1} from this book? This cannot be undone.`,
    confirmLabel: "Delete",
    onConfirm: () => {
      const handle = window.__sessionHandle;
      if (!handle?.bookDeletePage) return;
      try {
        handle.bookDeletePage(guid, pageIdx);
        refetch(handle, guid); // server reshuffles indices on delete
      } catch (e) {
        console.warn("[book-panel] bookDeletePage failed:", e);
      }
    },
  });
}

function onBookUpdated() {
  if (!win) buildOverlay();
  rerender();
}

// Subscribe at module-load; wait for the plugin bus.
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("bookUpdated", onBookUpdated);
  client.events.on("kind:24", onBookUpdated);
  return true;
}
if (typeof window !== "undefined") {
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

  window.__bookPanelDebug = {
    render: (snap) => {
      _debugSnap = snap ?? {
        objectGuid: 0x7FFF0B00, authorName: "Gaerlan", inscription: "", maxCharsPerPage: 1000, maxNumPages: 20,
        pages: [
          { authorName: "Gaerlan", text: "Being an account of the founding of Holtburg.\n\nIn the early days after the portal storms, the settlers of Holtburg raised a palisade against the drudges of the eastern hills, and the lifestone was consecrated beside the meeting hall." },
          { authorName: "Gaerlan", text: "The second page of the account continues the tale." },
        ],
      };
      onBookUpdated();
    },
    clear: () => { _debugSnap = null; win?.close(); },
  };

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
      console.log(`[book-panel] bookData(${devHex(guid)}) requested`);
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
  version: "0.2.0",
  description:
    "Parchment book reader / editor — auto-opens on kind=24 BookUpdated, wires Edit/Add/Delete + Inscription",
};
