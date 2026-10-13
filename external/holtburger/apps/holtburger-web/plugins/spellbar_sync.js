// plugins/spellbar_sync.js — server spell bars + spellbook filter
// (input-options-2 / hud-ui-2, 2026-10-13). Pure helpers, no DOM; the
// storage and wire glue lives in plugins/spellbook.js.
//
// Retail keeps each character's 8 spell-bar tabs and its spellbook filter
// word in the server-side PlayerModule:
//   * SpellCastSubMenu::AddSpellToPlayerModule (acclient.c:247988) →
//     CM_Character::Event_AddSpellFavorite(spell, pos, tab); the remove twin
//     RemoveSpellFromPlayerModule (:247949) → Event_RemoveSpellFavorite.
//   * PlayerModule::AddSpellFavorite (:512742) is PackableList::InsertPos —
//     each tab is an ORDERED list with no gaps.
//   * SpellCastSubMenu::AddFavorite (:248597): a move is
//     RemoveSpellFromMenu then an insert, the index one lower when the old
//     place came before the new one.
//   * SpellCastSubMenu::UpdateFromPlayerModule (:248027) drops (and sends
//     RemoveSpellFavorite for) every favourite the character no longer
//     knows (!CACQualities::IsSpellKnown); gmSpellcastingUI runs it on all 8
//     tabs on RecvNotice_PlayerDescReceived and RecvNotice_SpellRemoved.
//   * gmSpellbookUI::UpdateFilter (:198845) sends Event_SpellbookFilterEvent
//     with the whole word on every change.
// ACE stores the lists (CharacterExtensions.AddSpellToBar inserts at
// min(index, count) and ignores a spell already on that bar;
// TryRemoveSpellFromBar closes the gap), refuses a spell the character does
// not know, never prunes them itself, and echoes all 8 lists plus the
// filter word in every PlayerDescription.
//
// Holtburger's tabs are 18 cells that may have gaps. The server copy is the
// cells in order with the gaps dropped (compactTab); the cached layout keeps
// its gaps only while its order matches the server's.
//
// `?serverSpellBars=off` keeps the old per-browser, wire-silent spell bars.

const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?serverSpellBars` (default on; `off`/`0`/`false` = per-browser bars). */
export function serverSpellBarsEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("serverSpellBars");
    return !isOff(v);
  } catch (_) {
    return true;
  }
}

const spellIdOf = (v) => (typeof v === "number" && v > 0 ? v >>> 0 : 0);

/** One tab's spells in cell order: gaps dropped, first copy of a spell wins.
 *  This is the retail ordered list the server holds for the tab. */
export function compactTab(tab) {
  const out = [];
  const seen = new Set();
  for (const v of tab ?? []) {
    const id = spellIdOf(v);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Retail list position of cell `slot`: the number of filled cells before
 *  it. The index an Add for that cell carries. */
export function compactIndex(tab, slot) {
  let n = 0;
  for (let i = 0; i < slot && i < (tab?.length ?? 0); i++) {
    if (spellIdOf(tab[i])) n++;
  }
  return n;
}

/** A tab padded / cut to `slots` cells, duplicates cleared (first copy
 *  wins), cells keep their place. */
export function padTab(tab, slots = 18) {
  const out = new Array(slots).fill(0);
  const seen = new Set();
  for (let i = 0; i < slots; i++) {
    const id = spellIdOf(tab?.[i]);
    if (id && !seen.has(id)) {
      seen.add(id);
      out[i] = id;
    }
  }
  return out;
}

/** The server's lists as `tabs` tabs of `slots` cells, each filled from cell
 *  0. Entries past the last cell come back in `overflow` (they stay on the
 *  server, the strip just cannot show them). */
export function serverListsToTabs(lists, slots = 18, tabs = 8) {
  const out = [];
  const overflow = [];
  for (let t = 0; t < tabs; t++) {
    const ids = compactTab(lists?.[t]);
    const tab = new Array(slots).fill(0);
    for (let i = 0; i < Math.min(slots, ids.length); i++) tab[i] = ids[i];
    out.push(tab);
    overflow.push(ids.slice(slots));
  }
  return { tabs: out, overflow };
}

/** One server-side edit applied to an ordered list with ACE's rules
 *  (AddSpellToBar / TryRemoveSpellFromBar). Returns a new list. */
export function applySpellBarOp(list, op) {
  const out = Array.from(list ?? []);
  if (op?.op === "remove") {
    const i = out.indexOf(op.spell);
    if (i !== -1) out.splice(i, 1);
  } else if (op?.op === "add" && !out.includes(op.spell)) {
    out.splice(Math.min(op.index, out.length), 0, op.spell);
  }
  return out;
}

// Indices (into `seq`) of one longest strictly increasing run; the earliest
// such run wins ties.
function longestIncreasingRun(seq) {
  const n = seq.length;
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (best === -1 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i !== -1; i = prev[i]) keep.add(i);
  return keep;
}

/** Wire edits that turn the server list `from` into `to` for tab `list`:
 *  `{op:"remove", spell, list}` / `{op:"add", spell, index, list}`. Spells
 *  that are gone are removed; of the rest, the longest run already in the
 *  new order stays and every other spell is removed and re-added — so a
 *  move is [Remove, Add] (retail SpellCastSubMenu::AddFavorite). Adds go
 *  out in ascending final index, so each lands where `to` has it. */
export function diffSpellBarOps(from, to, list) {
  const target = compactTab(to);
  const targetPos = new Map(target.map((id, i) => [id, i]));
  const ops = [];
  const kept = [];
  for (const id of compactTab(from)) {
    if (targetPos.has(id)) kept.push(id);
    else ops.push({ op: "remove", spell: id, list });
  }
  const stay = longestIncreasingRun(kept.map((id) => targetPos.get(id)));
  const present = new Set();
  kept.forEach((id, i) => {
    if (stay.has(i)) present.add(id);
    else ops.push({ op: "remove", spell: id, list });
  });
  target.forEach((id, index) => {
    if (!present.has(id)) ops.push({ op: "add", spell: id, index, list });
  });
  return ops;
}

/** Retail UpdateFromPlayerModule's prune: clear every cell holding a spell
 *  the character does not know; other cells keep their place. Returns the
 *  new tabs and one `{op:"remove", spell, list}` per cleared cell. An empty
 *  `known` prunes nothing (the known list has not arrived). */
export function pruneUnknownSpells(tabs, known) {
  const removed = [];
  const can = known instanceof Set && known.size > 0;
  const out = (tabs ?? []).map((tab, list) => Array.from(tab ?? [], (v) => {
    const id = spellIdOf(v);
    if (id && can && !known.has(id)) {
      removed.push({ op: "remove", spell: id, list });
      return 0;
    }
    return id;
  }));
  return { tabs: out, removed };
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The first PlayerDescription of a character (retail RecvNotice_
 * PlayerDescReceived → UpdateFromPlayerModule on all 8 tabs).
 *   serverLists — the 8 SpellLists8 lists;
 *   record      — this character's cached `{ tabs, synced }`, or null;
 *   legacyTabs  — the old per-browser bars (before input-options-2), or null;
 *   known       — Set of the spells the character knows.
 * The server wins when it has any favourite, or when this character has
 * synced before (the bars were emptied elsewhere): unknown spells are pruned
 * with a Remove each, and the cached layout (with its gaps) is kept for a tab
 * whose order matches. Otherwise the cached (or legacy) bars are uploaded
 * once, minus unknown spells (ACE refuses those).
 * Returns `{ tabs, overflow, mirror, ops }`: the tabs to show, server entries
 * past the last cell, the lists the server holds once `ops` are sent, and the
 * wire edits to send now.
 */
export function planSpellBarHydration({
  serverLists, record = null, legacyTabs = null, known = null, slots = 18, tabs: tabCount = 8,
}) {
  const server = [];
  for (let t = 0; t < tabCount; t++) server.push(compactTab(serverLists?.[t]));
  const canPrune = known instanceof Set && known.size > 0;
  const ops = [];
  if (server.some((l) => l.length > 0) || record?.synced) {
    const mirror = server.map((l, list) => l.filter((id) => {
      if (!canPrune || known.has(id)) return true;
      ops.push({ op: "remove", spell: id, list });
      return false;
    }));
    const { tabs: fromServer, overflow } = serverListsToTabs(mirror, slots, tabCount);
    const tabs = fromServer.map((tab, t) => {
      const cached = record?.tabs?.[t];
      return cached && sameList(compactTab(cached), mirror[t]) ? padTab(cached, slots) : tab;
    });
    return { tabs, overflow, mirror, ops };
  }
  const source = record?.tabs ?? legacyTabs ?? [];
  const padded = [];
  for (let t = 0; t < tabCount; t++) padded.push(padTab(source[t], slots));
  const { tabs } = pruneUnknownSpells(padded, known);
  const mirror = tabs.map((tab, list) => {
    ops.push(...diffSpellBarOps([], tab, list));
    return compactTab(tab);
  });
  return { tabs, overflow: tabs.map(() => []), mirror, ops };
}

/**
 * Wire edits that bring the server (`mirror`, what it holds now) in line
 * with `tabs` after a local edit. Spells the character does not know are
 * left off (ACE refuses them); server entries the cells cannot show
 * (`overflow`) stay at the end of their tab until the player files one on a
 * cell. A tab missing from `tabs` is left as it is.
 * Returns `{ ops, mirror, overflow }`.
 */
export function planSpellBarFlush(mirror, tabs, overflow = [], known = null) {
  const canFilter = known instanceof Set && known.size > 0;
  const ops = [];
  const nextMirror = [];
  const nextOverflow = [];
  (mirror ?? []).forEach((held, t) => {
    if (!Array.isArray(tabs?.[t])) {
      nextMirror.push(Array.from(held ?? []));
      nextOverflow.push(Array.from(overflow?.[t] ?? []));
      return;
    }
    let target = compactTab(tabs[t]);
    if (canFilter) target = target.filter((id) => known.has(id));
    const shown = new Set(target);
    const rest = (overflow?.[t] ?? []).filter((id) => !shown.has(id) && (!canFilter || known.has(id)));
    target = target.concat(rest);
    ops.push(...diffSpellBarOps(held ?? [], target, t));
    nextMirror.push(target);
    nextOverflow.push(rest);
  });
  return { ops, mirror: nextMirror, overflow: nextOverflow };
}

/** The filter word to send: the FilterBox bits from `mask`, every other bit
 *  (retail Level_9 0x1000 has no button) as the server last sent it. */
export function spellbookFilterWord(mask, serverWord, buttonBits = 0x2FFF) {
  return (((mask >>> 0) & buttonBits) | ((serverWord >>> 0) & ~buttonBits)) >>> 0;
}

/** localStorage key of the per-character tab cache:
 *  `{ [guidHex]: { tabs, synced } }`. It is its own key, NOT a field of
 *  `holtburger_combat_bar_v1`: combat-bar.js loads that blob once when its
 *  panel opens and writes the whole (stale) copy back on every power-slider,
 *  attack-height, checkbox and spell-picker change. A cache inside it was
 *  reverted or deleted that way, and the next flush then sent
 *  RemoveSpellFavorite for every favourite missing from the reverted copy. */
export const SPELL_BARS_BY_CHAR_KEY = "holtburger_spell_bars_by_char_v1";

/** This character's cached tabs out of the per-character store
 *  (`SPELL_BARS_BY_CHAR_KEY`, parsed), or null. */
export function readCharSpellBars(store, key) {
  const rec = store && typeof store === "object" ? store[key] : null;
  return rec && Array.isArray(rec.tabs) ? { tabs: rec.tabs, synced: rec.synced === true } : null;
}

/** Store this character's tabs in the per-character store; other characters'
 *  records are kept. `synced` undefined keeps the stored flag. Returns the
 *  store. */
export function writeCharSpellBars(store, key, tabs, synced) {
  const all = store && typeof store === "object" && !Array.isArray(store) ? store : {};
  const prev = all[key];
  all[key] = { tabs, synced: synced === undefined ? prev?.synced === true : synced === true };
  return all;
}

/** Defensive guard for a reconciled character: tabs the cached record lacks
 *  (the record is missing, has no tabs or is cut short — cleared site data,
 *  a hand edit) are rebuilt from `mirror`, the lists the server holds, so a
 *  flush never diffs an empty layout against the server (which would remove
 *  every favourite). Tabs the record has are kept as they are.
 *  Returns `{ tabs, rebuilt }`. */
export function fillTabsFromMirror(tabs, mirror, slots = 18, tabCount = 8) {
  const out = Array.from(tabs ?? []);
  if (!Array.isArray(mirror)) return { tabs: out, rebuilt: false };
  const fromServer = serverListsToTabs(mirror, slots, tabCount).tabs;
  let rebuilt = false;
  for (let t = 0; t < tabCount; t++) {
    if (!Array.isArray(out[t])) {
      out[t] = fromServer[t];
      rebuilt = true;
    }
  }
  return { tabs: out, rebuilt };
}

/** Per-character store key for a character GUID. */
export function spellBarCharKey(guid) {
  return (guid >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
