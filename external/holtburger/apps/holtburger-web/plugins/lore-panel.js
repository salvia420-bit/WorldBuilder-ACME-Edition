// Personal Library panel — HUD rec #181 (2026-06-16); restyled on the
// hud_kit vocabulary in the HUD overhaul 2026-10-05 (Shift+F8).
//
// SPEC PREMISE WAS BROKEN: the rec cited gmPageListUI (acclient.h:56020) as a
// "lore entry catalog", but gmPageListUI is the journal page-LIST UI
// (label/title/notes/timer/coords), and the cited layout 0x21000070 dumps as
// RootFloatyToolbar_Field — there is no retail "lore database" UI to port 1:1.
// The closest in-fiction equivalent is the player's personal collection of
// WRITABLE items (books / scrolls / parchment — ItemType bit 13 = 0x2000).
//
// So this synthesizes a NEW client-side concept: a "Personal Library" that
// catalogs every writable item the player has ever held. The catalog is built
// from the existing playerInventory() stream (filtered by itemType & 0x2000),
// the discovery set is persisted to localStorage so it survives logout and is
// cross-character on the same machine, and page text is lazy-fetched via the
// already-wired book pipeline (handle.bookData(guid) → bookUpdated →
// handle.playerBook()). JS-only — every wasm surface used here already ships.
//
// Layout (2026-10-05): kit search field, a rope-scroll title list, the
// retail gold spacer, and the selected book's pages on the same parchment
// (0x0600126F) the journal uses — reading a book reads like the book panel.
//
// Honest limitations: discovery is per-machine (localStorage, not server-side);
// page text is only available while the item is actually held (bookData needs a
// live guid); there is no way to show lore the player has never held.

import {
  ensureSocialStyles, el, makeSpacer, makeColHead, makeListRow, setRowSelected, onBus,
} from "./social-panel.js";

const LS_KEY = "hb.lore.discovered.v1";
const ITEM_TYPE_WRITABLE = 0x2000;
const SP = "./data/ui-sprites";

// ─── Pure library accumulation (exported for tests) ──────────────────────
/**
 * Merge the WRITABLE items from a playerInventory() snapshot into the
 * persisted library map. Pure (no DOM / wasm / localStorage): mutates
 * `library` (Map<wcid, entry>) in place and reports whether anything changed.
 * Items without the WRITABLE bit (0x2000) are ignored; new writables seed an
 * entry stamped with `nowIso`; existing entries backfill a name/icon that was
 * previously unknown.
 *
 * @param {Map<number, object>} library — wcid → { wcid, name, iconId, firstSeenIso }
 * @param {Array<{wcid?:number, name?:string, iconId?:number, itemType?:number}>} items
 * @param {string} nowIso — ISO timestamp to stamp newly-discovered entries
 * @returns {{ changed: boolean }}
 */
export function mergeInventoryWritables(library, items, nowIso) {
  let changed = false;
  for (const it of (items || [])) {
    const itemType = (it?.itemType ?? 0) >>> 0;
    if ((itemType & ITEM_TYPE_WRITABLE) === 0) continue;
    const wcid = (it?.wcid ?? 0) >>> 0;
    if (!wcid) continue;
    const icon = (it?.iconId ?? 0) >>> 0;
    const name = it?.name || "";
    const existing = library.get(wcid);
    if (!existing) {
      library.set(wcid, {
        wcid,
        name: name || `Item ${wcid}`,
        iconId: icon,
        firstSeenIso: nowIso,
      });
      changed = true;
    } else {
      if (name && (!existing.name || existing.name.startsWith("Item "))) { existing.name = name; changed = true; }
      if (icon && !existing.iconId) { existing.iconId = icon; changed = true; }
    }
  }
  return { changed };
}

// ─── localStorage persistence ────────────────────────────────────────────
function loadLibrary() {
  const map = new Map();
  try {
    const raw = (typeof localStorage !== "undefined") ? localStorage.getItem(LS_KEY) : null;
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (e && e.wcid != null) map.set((e.wcid >>> 0), e);
        }
      }
    }
  } catch (_) { /* corrupt cache → start empty */ }
  return map;
}
function saveLibrary(library) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LS_KEY, JSON.stringify([...library.values()]));
  } catch (_) { /* quota / disabled → in-memory only this session */ }
}

function getHandle() {
  return (typeof window !== "undefined")
    ? (window.__sessionHandle ?? window.__pluginClient?._handle ?? null)
    : null;
}
function fetchInventory() {
  const handle = getHandle();
  if (typeof handle?.playerInventory !== "function") return [];
  try { return handle.playerInventory() ?? []; } catch (_) { return []; }
}

let stylesInjected = false;
function ensureStyles() {
  ensureSocialStyles();
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.id = "hb-lore-panel-style";
  s.textContent = `
    .hb-lore-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; gap: 3px;
      padding: 6px 6px 5px; box-sizing: border-box;
      font-family: var(--hbk-font); font-size: 12px; color: var(--hbk-text);
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    }
    .hb-lore-search { flex: 0 0 auto; width: 100%; height: 22px; }
    .hb-lore-list { flex: 1 1 42%; min-height: 60px; }
    .hb-lore-detail {
      flex: 1 1 58%; min-height: 60px;
      padding: 6px 9px; box-sizing: border-box;
      color: #2a1a08; line-height: 1.35;
      background: url("${SP}/0x0600126F.png") center / 265px 100px repeat;
      border: 1px solid #000;
      box-shadow: inset 0 0 6px rgba(60, 35, 10, 0.55);
      scrollbar-color: rgba(90, 58, 24, 0.7) transparent;
      user-select: text;
    }
    .hb-lore-detail-h { font-size: 13px; font-weight: 600; color: #6b3a0a; margin-bottom: 2px; }
    .hb-lore-detail-meta { color: #5a3a18; font-style: italic; font-size: 11px; margin-bottom: 6px; }
    .hb-lore-page { white-space: pre-wrap; margin-bottom: 8px; }
    .hb-lore-page + .hb-lore-page { border-top: 1px solid rgba(80, 50, 20, 0.25); padding-top: 6px; }
    .hb-lore-note { color: #5a3a18; font-style: italic; text-align: center; padding: 12px 6px; }
    .hb-lore-foot { flex: 0 0 auto; text-align: center; font-size: 11px; color: var(--hbk-text-dim); }
  `;
  document.head.appendChild(s);
}

export const view = {
  name: "Library",
  nameFor: () => "Personal Library",
  mount: (parentEl, _ctx) => {
    if (typeof document === "undefined") return () => {};
    ensureStyles();

    const root = el("div", "hb-lore-root");
    const search = document.createElement("input");
    search.type = "text";
    search.className = "hbk-input hb-lore-search";
    search.placeholder = "Search your books & scrolls…";
    search.setAttribute("aria-label", "Search your library");
    root.appendChild(search);
    root.appendChild(makeColHead("Title", "First Seen"));
    const list = el("div", "hbk-scroll hbk-list hb-soc-list hb-lore-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Books and scrolls");
    root.appendChild(list);
    root.appendChild(makeSpacer());
    const detail = el("div", "hbk-scroll hb-lore-detail");
    root.appendChild(detail);
    const foot = el("div", "hb-lore-foot");
    root.appendChild(foot);
    parentEl.appendChild(root);

    let library = loadLibrary();
    let filterText = "";
    let selectedWcid = 0;
    let pendingBookGuid = 0;

    // Pull writables from the current inventory into the persisted library.
    function syncFromInventory() {
      const { changed } = mergeInventoryWritables(library, fetchInventory(), new Date().toISOString());
      if (changed) saveLibrary(library);
    }

    // Find a currently-held guid for a wcid (book page text needs a live guid).
    function heldGuidFor(wcid) {
      for (const it of fetchInventory()) {
        if (((it?.wcid ?? 0) >>> 0) === (wcid >>> 0)) {
          const itemType = (it?.itemType ?? 0) >>> 0;
          if ((itemType & ITEM_TYPE_WRITABLE) !== 0) return (it?.guid ?? 0) >>> 0;
        }
      }
      return 0;
    }

    function renderDetail() {
      detail.textContent = "";
      if (!selectedWcid) {
        detail.appendChild(el("div", "hb-lore-note", library.size ? "Select a book to read it." : "Books and scrolls you carry are added here automatically."));
        return;
      }
      const entry = library.get(selectedWcid >>> 0);
      if (!entry) return;
      detail.appendChild(el("div", "hb-lore-detail-h", entry.name || `Item ${entry.wcid}`));

      const handle = getHandle();
      let book = null;
      try { book = typeof handle?.playerBook === "function" ? handle.playerBook() : null; } catch (_) {}
      const haveBook = !!(book && pendingBookGuid && (book.objectGuid >>> 0) === (pendingBookGuid >>> 0));

      const bits = [];
      if (haveBook && book.inscription) bits.push(`Inscription: ${book.inscription}`);
      if (haveBook && book.authorName) bits.push(`Scribe: ${book.authorName}`);
      if (!bits.length) bits.push(`First seen ${(entry.firstSeenIso || "").slice(0, 10) || "—"}`);
      detail.appendChild(el("div", "hb-lore-detail-meta", bits.join("  ·  ")));

      if (haveBook && Array.isArray(book.pages) && book.pages.length) {
        for (const p of book.pages) detail.appendChild(el("div", "hb-lore-page", p.text || ""));
      } else {
        detail.appendChild(el("div", "hb-lore-note", heldGuidFor(selectedWcid)
          ? "Opening the book…"
          : "You can read this book's pages while you carry it."));
      }
    }

    function renderList() {
      list.textContent = "";
      const q = filterText.trim().toLowerCase();
      const entries = [...library.values()]
        .filter((e) => !q || (e.name || "").toLowerCase().includes(q))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      if (!entries.length) {
        list.appendChild(el("div", "hbk-empty", q
          ? "No books match your search."
          : "Your library is empty. Pick up a book or scroll to add it."));
      }
      for (const entry of entries) {
        const row = makeListRow(entry.name || `Item ${entry.wcid}`, (entry.firstSeenIso || "").slice(0, 10), {
          selected: (entry.wcid >>> 0) === (selectedWcid >>> 0),
        });
        row.addEventListener("click", () => {
          selectedWcid = entry.wcid >>> 0;
          setRowSelected(list, row);
          // If the item is currently held, request its pages.
          const guid = heldGuidFor(selectedWcid);
          const handle = getHandle();
          if (guid && typeof handle?.bookData === "function") {
            pendingBookGuid = guid;
            try { handle.bookData(guid); } catch (_) { /* fetch failed → metadata only */ }
          } else {
            pendingBookGuid = 0;
          }
          renderDetail();
        });
        list.appendChild(row);
      }
      const total = library.size;
      foot.textContent = total ? `${total} book${total === 1 ? "" : "s"} and scroll${total === 1 ? "" : "s"} collected` : "";
    }

    function rerender() { renderList(); renderDetail(); }

    search.addEventListener("input", () => { filterText = search.value || ""; renderList(); });

    syncFromInventory();
    rerender();

    // Refresh on inventory changes (new writables) + book responses.
    const offs = [
      onBus("playerInventoryChanged", () => { syncFromInventory(); rerender(); }),
      onBus("bookUpdated", () => { renderDetail(); }),
    ];

    return () => {
      for (const off of offs) { try { off(); } catch (_) {} }
      root.remove();
    };
  },
};

export const manifest = {
  id: "lore-panel",
  name: "Library",
  icon: "📚",
  iconHidden: true,
  version: "0.2.0",
  description: "Personal Library (synthesized client-side writable-item catalog — HUD rec #181)",
};
