// scene3d/diag/strings.js — AC string-lookup diagnostic slice
//
// Pain point this addresses: the AC string pipeline (StringTable 0x23
// + LanguageString 0x31 + ActionMap 0x26 → in-game text lookups)
// silently substitutes empty strings or nulls whenever (a) the wasm
// fetch export is missing, (b) the DAT bytes parse but produce no
// rows, (c) the JSON parse throws, or (d) a hashId lookup hits a
// table that exists but doesn't carry that key. The HUD then renders
// blank labels with no log signal of "the table loaded but the key
// resolved to null."
//
// This surface exposes:
//
//   __diag.strings.tablesLoaded         — Map<tableId, {entryCount, loadedAt}>
//   __diag.strings.tablesFailed         — ring [{tableId, error, ts}]
//   __diag.strings.languageStringsLoaded — Map<stringId, {textLength, loadedAt}>
//   __diag.strings.languageStringsFailed — ring [{stringId, error, ts}]
//   __diag.strings.actionMap            — {stringTableId, actionCount,
//                                          labelResolveFails, loadedAt}|null
//   __diag.strings.lookupMisses         — Map<tableId, Set<hashId>>
//   __diag.strings.summary()            — aggregate counters
//   __diag.strings.snapshot()           — full picture for report.json
//
// Hooks fire from `ui/ac_strings.js` at the existing
// success/fail/lookup-miss branches.

import { getStringsDiagSnapshot } from "../../ui/ac_strings.js";

const DEFAULT_MAX_FAILURES = 50;
const DEFAULT_MAX_MISSES_PER_TABLE = 256;

function errStr(e) {
  if (e == null) return "(null)";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try { return String(e); } catch (_) { return "(unstringifiable)"; }
}

function hexId(d) {
  return "0x" + ((d >>> 0).toString(16).padStart(8, "0"));
}

function pushCapped(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) arr.shift();
}

export function attachStrings(diag) {
  const strings = {
    tablesLoaded: new Map(),
    tablesFailed: [],
    languageStringsLoaded: new Map(),
    languageStringsFailed: [],
    actionMap: null,
    lookupMisses: new Map(),
    maxFailures: DEFAULT_MAX_FAILURES,
    maxMissesPerTable: DEFAULT_MAX_MISSES_PER_TABLE,

    /**
     * Fired from `ui/ac_strings.js::loadStringTable` after tables.set.
     * Meta: {tableId, entryCount}.
     */
    onTableLoaded(meta) {
      try {
        const m = meta || {};
        const id = (m.tableId ?? 0) >>> 0;
        strings.tablesLoaded.set(id, {
          tableId: hexId(id),
          entryCount: (m.entryCount ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_strings.js::loadStringTable` catch site.
     * Meta: {tableId, error}.
     */
    onTableFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(strings.tablesFailed, {
          tableId: hexId(m.tableId ?? 0),
          error: errStr(m.error),
          ts: performance.now(),
        }, strings.maxFailures);
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_strings.js::loadLanguageString` after
     * languageStrings.set. Meta: {stringId, textLength}.
     */
    onLanguageStringLoaded(meta) {
      try {
        const m = meta || {};
        const id = (m.stringId ?? 0) >>> 0;
        strings.languageStringsLoaded.set(id, {
          stringId: hexId(id),
          textLength: (m.textLength ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_strings.js::loadLanguageString` catch site.
     * Meta: {stringId, error}.
     */
    onLanguageStringFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(strings.languageStringsFailed, {
          stringId: hexId(m.stringId ?? 0),
          error: errStr(m.error),
          ts: performance.now(),
        }, strings.maxFailures);
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_strings.js::loadActionMap` after resolution.
     * Meta: {stringTableId, actionCount, labelResolveFails}.
     */
    onActionMapLoaded(meta) {
      try {
        const m = meta || {};
        strings.actionMap = {
          stringTableId: hexId(m.stringTableId ?? 0),
          actionCount: (m.actionCount ?? 0) | 0,
          labelResolveFails: (m.labelResolveFails ?? 0) | 0,
          loadedAt: performance.now(),
        };
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_strings.js::loadActionMap` catch site.
     * Meta: {mapId, error}.
     */
    onActionMapFailed(meta) {
      try {
        const m = meta || {};
        strings.actionMap = {
          stringTableId: null,
          actionCount: 0,
          labelResolveFails: 0,
          loadedAt: performance.now(),
          error: errStr(m.error),
          mapId: hexId(m.mapId ?? 0),
        };
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_strings.js::acString` when a hashId returns
     * `null` against a loaded table. Meta: {tableId, hashId}.
     * Deduped per-table via Set.
     */
    onLookupMiss(meta) {
      try {
        const m = meta || {};
        const tid = (m.tableId ?? 0) >>> 0;
        const hid = (m.hashId ?? 0) >>> 0;
        let set = strings.lookupMisses.get(tid);
        if (!set) {
          set = new Set();
          strings.lookupMisses.set(tid, set);
        }
        if (set.size >= strings.maxMissesPerTable) return;
        set.add(hid);
      } catch (_) {}
    },

    /**
     * Read-through to `ui/ac_strings.js::getStringsDiagSnapshot()`.
     * Reports cached tables / language-strings / action-map state
     * regardless of whether the load fired during diag's installed
     * window — closes the gap for pre-diag-install boot loads.
     */
    cached() {
      try { return getStringsDiagSnapshot(); }
      catch (_) { return { tables: [], languageStrings: [], actionMapLoaded: false }; }
    },

    summary() {
      let totalMisses = 0;
      for (const s of strings.lookupMisses.values()) totalMisses += s.size;
      const cached = strings.cached();
      return {
        tablesLoaded: strings.tablesLoaded.size,
        tablesCached: cached.tables.length,
        tablesFailed: strings.tablesFailed.length,
        languageStringsLoaded: strings.languageStringsLoaded.size,
        languageStringsCached: cached.languageStrings.length,
        languageStringsFailed: strings.languageStringsFailed.length,
        actionMapReady: !!(strings.actionMap && strings.actionMap.actionCount)
          || cached.actionMapLoaded,
        lookupMissesUnique: totalMisses,
      };
    },

    snapshot() {
      const cached = strings.cached();
      return {
        ts: new Date().toISOString(),
        tables: Array.from(strings.tablesLoaded.values()),
        tablesCached: cached.tables.map((t) => ({ tableId: hexId(t.tableId), entryCount: t.entryCount })),
        tableFailures: [...strings.tablesFailed],
        languageStrings: Array.from(strings.languageStringsLoaded.values()),
        languageStringsCached: cached.languageStrings.map((l) => ({ stringId: hexId(l.stringId), textLength: l.textLength })),
        languageStringFailures: [...strings.languageStringsFailed],
        actionMap: strings.actionMap ? { ...strings.actionMap } : null,
        actionMapCached: cached.actionMapLoaded,
        lookupMisses: Array.from(strings.lookupMisses.entries()).map(
          ([tid, set]) => ({
            tableId: hexId(tid),
            missCount: set.size,
            hashes: Array.from(set).map(hexId),
          }),
        ),
      };
    },

    reset() {
      strings.tablesFailed.length = 0;
      strings.languageStringsFailed.length = 0;
      strings.lookupMisses.clear();
    },
  };

  diag.strings = strings;
}
