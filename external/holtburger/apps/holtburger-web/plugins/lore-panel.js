// Personal Library panel — HUD rec #181 (2026-06-16).
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
// Honest limitations: discovery is per-machine (localStorage, not server-side);
// page text is only available while the item is actually held (bookData needs a
// live guid); there is no way to show lore the player has never held.

import { setAcText } from "../ui/ac_font.js";

const LS_KEY = "hb.lore.discovered.v1";
const ITEM_TYPE_WRITABLE = 0x2000;

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
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.id = "hb-lore-panel-style";
  s.textContent = `
    .hb-lore-root { position: absolute; inset: 0; display: flex; flex-direction: column;
      font-family: var(--hb-font-serif, serif); color: var(--hb-text-cream, #e8d8b0); padding: 6px; box-sizing: border-box; }
    .hb-lore-title { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37); text-align: center; margin-bottom: 6px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176,138,74,0.4)); padding-bottom: 4px; }
    .hb-lore-search { width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 3px 6px;
      background: rgba(20,14,8,0.8); border: 1px solid var(--hb-border-brass-dim, rgba(176,138,74,0.4));
      color: var(--hb-text-cream, #e8d8b0); font-family: inherit; font-size: 11px; }
    .hb-lore-list { flex: 1 1 50%; overflow-y: auto; border: 1px solid var(--hb-border-brass-dim, rgba(176,138,74,0.4)); }
    .hb-lore-row { padding: 3px 6px; cursor: pointer; font-size: 11px; border-bottom: 1px solid rgba(176,138,74,0.15);
      display: flex; justify-content: space-between; gap: 6px; }
    .hb-lore-row:hover { background: rgba(80,60,30,0.5); }
    .hb-lore-row.selected { background: rgba(100,76,38,0.6); color: var(--hb-text-gold, #d4af37); }
    .hb-lore-row-when { color: var(--hb-text-muted-3, #a08868); font-size: 9px; white-space: nowrap; }
    .hb-lore-detail { flex: 1 1 50%; overflow-y: auto; margin-top: 6px; padding: 6px;
      background: rgba(20,14,8,0.6); border: 1px solid var(--hb-border-brass-dim, rgba(176,138,74,0.4)); font-size: 11px; line-height: 1.35; }
    .hb-lore-detail-h { color: var(--hb-text-gold, #d4af37); margin-bottom: 4px; }
    .hb-lore-detail-meta { color: var(--hb-text-muted-3, #a08868); font-style: italic; font-size: 10px; margin-bottom: 6px; }
    .hb-lore-empty { color: var(--hb-text-muted-3, #a08868); font-style: italic; text-align: center; padding: 10px; font-size: 11px; }
    .hb-lore-foot { color: var(--hb-text-muted-3, #a08868); font-size: 9px; text-align: center; margin-top: 4px; }
  `;
  document.head.appendChild(s);
}

export const view = {
  name: "Library",
  nameFor: () => "Personal Library",
  mount: (parentEl, ctx) => {
    if (typeof document === "undefined") return () => {};
    ensureStyles();

    const root = document.createElement("div");
    root.className = "hb-lore-root";

    const title = document.createElement("div");
    title.className = "hb-lore-title";
    setAcText(title, "Personal Library");
    root.appendChild(title);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "hb-lore-search";
    search.placeholder = "Search your books & scrolls…";
    root.appendChild(search);

    const list = document.createElement("div");
    list.className = "hb-lore-list";
    root.appendChild(list);

    const detail = document.createElement("div");
    detail.className = "hb-lore-detail";
    root.appendChild(detail);

    const foot = document.createElement("div");
    foot.className = "hb-lore-foot";
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
      detail.innerHTML = "";
      if (!selectedWcid) {
        const e = document.createElement("div");
        e.className = "hb-lore-empty";
        setAcText(e, "Select a book to read it.");
        detail.appendChild(e);
        return;
      }
      const entry = library.get(selectedWcid >>> 0);
      if (!entry) return;
      const h = document.createElement("div");
      h.className = "hb-lore-detail-h";
      setAcText(h, entry.name || `Item ${entry.wcid}`);
      detail.appendChild(h);

      const handle = getHandle();
      const book = (typeof handle?.playerBook === "function") ? (() => { try { return handle.playerBook(); } catch (_) { return null; } })() : null;
      const haveBook = book && (book.objectGuid >>> 0) === (pendingBookGuid >>> 0) && pendingBookGuid;

      const meta = document.createElement("div");
      meta.className = "hb-lore-detail-meta";
      if (haveBook && (book.authorName || book.inscription)) {
        const bits = [];
        if (book.inscription) bits.push(`Inscription: ${book.inscription}`);
        if (book.authorName) bits.push(`Scribe: ${book.authorName}`);
        setAcText(meta, bits.join("  ·  "));
      } else {
        setAcText(meta, `First seen ${(entry.firstSeenIso || "").slice(0, 10) || "—"}`);
      }
      detail.appendChild(meta);

      if (haveBook && Array.isArray(book.pages) && book.pages.length) {
        for (const p of book.pages) {
          const pg = document.createElement("div");
          pg.style.marginBottom = "8px";
          pg.style.whiteSpace = "pre-wrap";
          pg.textContent = p.text || "";
          detail.appendChild(pg);
        }
      } else {
        const note = document.createElement("div");
        note.className = "hb-lore-empty";
        const held = heldGuidFor(selectedWcid);
        setAcText(note, held
          ? "Opening… (fetching pages from the server)"
          : "Page text is only available while you are holding this item.");
        detail.appendChild(note);
      }
    }

    function renderList() {
      list.innerHTML = "";
      const q = filterText.trim().toLowerCase();
      const entries = [...library.values()]
        .filter((e) => !q || (e.name || "").toLowerCase().includes(q))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      if (!entries.length) {
        const e = document.createElement("div");
        e.className = "hb-lore-empty";
        setAcText(e, q ? "No books match your search."
          : "Your library is empty. Pick up a book or scroll to add it.");
        list.appendChild(e);
      } else {
        for (const entry of entries) {
          const row = document.createElement("div");
          row.className = "hb-lore-row";
          if ((entry.wcid >>> 0) === (selectedWcid >>> 0)) row.classList.add("selected");
          const nameEl = document.createElement("span");
          setAcText(nameEl, entry.name || `Item ${entry.wcid}`);
          const whenEl = document.createElement("span");
          whenEl.className = "hb-lore-row-when";
          setAcText(whenEl, (entry.firstSeenIso || "").slice(0, 10));
          row.appendChild(nameEl);
          row.appendChild(whenEl);
          row.addEventListener("click", () => {
            selectedWcid = entry.wcid >>> 0;
            // If the item is currently held, request its pages.
            const guid = heldGuidFor(selectedWcid);
            const handle = getHandle();
            if (guid && typeof handle?.bookData === "function") {
              pendingBookGuid = guid;
              try { handle.bookData(guid); } catch (_) { /* fetch failed → metadata only */ }
            } else {
              pendingBookGuid = 0;
            }
            renderList();
            renderDetail();
          });
          list.appendChild(row);
        }
      }
      const total = library.size;
      setAcText(foot, `${total} item${total === 1 ? "" : "s"} · synthesized client-side catalog (per-machine)`);
    }

    function rerender() { renderList(); renderDetail(); }

    search.addEventListener("input", () => { filterText = search.value || ""; renderList(); });

    syncFromInventory();
    rerender();

    // Refresh on inventory changes (new writables) + book responses.
    const bus = ctx?.client?.events
      ?? (typeof window !== "undefined" ? window.__pluginClient?.events : null)
      ?? null;
    const onInventory = () => { syncFromInventory(); rerender(); };
    const onBook = () => { renderDetail(); };
    if (bus && typeof bus.on === "function") {
      bus.on("playerInventoryChanged", onInventory);
      bus.on("bookUpdated", onBook);
    }

    return () => {
      if (bus && typeof bus.off === "function") {
        try { bus.off("playerInventoryChanged", onInventory); } catch (_) {}
        try { bus.off("bookUpdated", onBook); } catch (_) {}
      }
      root.remove();
    };
  },
};

export const manifest = {
  id: "lore-panel",
  name: "Library",
  icon: "📚",
  iconHidden: true,
  version: "0.1.0",
  description: "Personal Library (synthesized client-side writable-item catalog — HUD rec #181)",
};
