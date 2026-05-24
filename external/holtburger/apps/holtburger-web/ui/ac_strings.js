/**
 * AC string-table lookup runtime.
 *
 * Wraps the wasm `fetch_string_table(id)` / `fetch_language_string(id)`
 * exports with a small JS layer:
 *
 *  - `loadStringTable(id) -> Promise<Map<number, string>>` — fetches
 *    a retail StringTable (DAT type 0x23) and returns a Map keyed by
 *    the FNV-style hash the retail UI uses for lookups (e.g.
 *    0x014152D5 → "Left Alt" in table 0x2300000A).
 *  - `acString(tableId, hashId)` — sync accessor; returns the cached
 *    string or `null`. Caller is responsible for ensuring the table
 *    is loaded first.
 *  - `loadLanguageString(id) -> Promise<string>` — fetches one
 *    free-form locale text record (DAT type 0x31).
 *
 * Tables are cached module-scoped; concurrent loaders share a single
 * fetch via the in-flight Promise map.
 */

// Cache of loaded string tables. Map<tableId, Map<hashId, text>>.
const tables = new Map();
const tableInFlight = new Map();

// Cache of loaded language strings. Map<stringId, text>.
const languageStrings = new Map();
const lsInFlight = new Map();

/**
 * Fetch + cache a retail StringTable by DataID. Subsequent calls
 * return the same Map instance.
 *
 * @param {number} tableId — DataID of the StringTable record (0x23xxxxxx).
 * @returns {Promise<Map<number, string>>}
 */
export async function loadStringTable(tableId) {
  const cached = tables.get(tableId);
  if (cached !== undefined) return cached;

  const pending = tableInFlight.get(tableId);
  if (pending) return pending;

  const promise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_string_table) {
      tables.set(tableId, new Map());
      return tables.get(tableId);
    }
    try {
      const json = await wasm.fetch_string_table(tableId >>> 0);
      const arr = JSON.parse(json);
      const map = new Map();
      for (const [key, text] of arr) {
        map.set(key >>> 0, text);
      }
      tables.set(tableId, map);
      try { window.__diag?.strings?.onTableLoaded?.({ tableId, entryCount: map.size }); } catch (_) {}
      return map;
    } catch (err) {
      console.warn(`[ac-strings] table 0x${tableId.toString(16)} load failed:`, err);
      try { window.__diag?.strings?.onTableFailed?.({ tableId, error: err }); } catch (_) {}
      tables.set(tableId, new Map());
      return tables.get(tableId);
    } finally {
      tableInFlight.delete(tableId);
    }
  })();
  tableInFlight.set(tableId, promise);
  return promise;
}

/**
 * Sync accessor for an already-loaded string. Returns `null` if the
 * table isn't loaded yet OR if the hashId isn't in the table.
 *
 * @param {number} tableId
 * @param {number} hashId
 * @returns {string | null}
 */
export function acString(tableId, hashId) {
  const t = tables.get(tableId);
  if (!t) return null;
  const v = t.get(hashId >>> 0);
  if (v === undefined) {
    try { window.__diag?.strings?.onLookupMiss?.({ tableId, hashId }); } catch (_) {}
    return null;
  }
  return v ?? null;
}

/**
 * Fetch + cache a LanguageString by DataID. Returns the decoded text.
 *
 * @param {number} stringId — DataID of the LanguageString record (0x31xxxxxx).
 * @returns {Promise<string>}
 */
export async function loadLanguageString(stringId) {
  const cached = languageStrings.get(stringId);
  if (cached !== undefined) return cached;

  const pending = lsInFlight.get(stringId);
  if (pending) return pending;

  const promise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_language_string) {
      languageStrings.set(stringId, "");
      return "";
    }
    try {
      const text = await wasm.fetch_language_string(stringId >>> 0);
      languageStrings.set(stringId, text);
      try { window.__diag?.strings?.onLanguageStringLoaded?.({ stringId, textLength: (text ?? "").length }); } catch (_) {}
      return text;
    } catch (err) {
      console.warn(`[ac-strings] language string 0x${stringId.toString(16)} load failed:`, err);
      try { window.__diag?.strings?.onLanguageStringFailed?.({ stringId, error: err }); } catch (_) {}
      languageStrings.set(stringId, "");
      return "";
    } finally {
      lsInFlight.delete(stringId);
    }
  })();
  lsInFlight.set(stringId, promise);
  return promise;
}

/**
 * Sync accessor — returns the cached LanguageString or `null`.
 */
export function languageString(stringId) {
  return languageStrings.get(stringId) ?? null;
}

// ---------------------------------------------------------------------
// ActionMap loader — resolves action hash → label by chaining through
// the referenced StringTable (string_table_data_id, usually 0x23000005).
// Output of `loadActionMap()` is an array of resolved {inputMap,
// actionHash, label, toggle} tuples.

let actionMapPromise = null;
let actionMapCache = null;

/**
 * Load + chain-resolve the retail ActionMap. The ActionMap itself
 * lives at the supplied `mapId` (default 0x26000001 — the only
 * record in the retail DAT). Loading also auto-loads the referenced
 * StringTable so labels resolve immediately.
 *
 * @param {number} [mapId=0x26000001]
 * @returns {Promise<{stringTableId: number, actions: Array<{inputMap: number, actionHash: number, label: string, labelHash: number, toggle: number}>}>}
 */
export async function loadActionMap(mapId = 0x26000000) {
  if (actionMapCache) return actionMapCache;
  if (actionMapPromise) return actionMapPromise;
  actionMapPromise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_action_map) {
      const empty = { stringTableId: 0, actions: [] };
      actionMapCache = empty;
      return empty;
    }
    try {
      const json = await wasm.fetch_action_map(mapId >>> 0);
      const data = JSON.parse(json);
      if (!data) {
        actionMapCache = { stringTableId: 0, actions: [] };
        return actionMapCache;
      }
      const tableId = data.string_table_data_id >>> 0;
      const table = await loadStringTable(tableId);
      let labelResolveFails = 0;
      const actions = data.actions.map((a) => {
        const label = table.get((a.label_hash >>> 0)) ?? null;
        if (label === null) labelResolveFails += 1;
        return {
          inputMap: a.input_map >>> 0,
          actionHash: a.action_hash >>> 0,
          labelHash: a.label_hash >>> 0,
          toggle: a.toggle >>> 0,
          label,
        };
      });
      actionMapCache = { stringTableId: tableId, actions };
      try { window.__diag?.strings?.onActionMapLoaded?.({ stringTableId: tableId, actionCount: actions.length, labelResolveFails }); } catch (_) {}
      return actionMapCache;
    } catch (err) {
      console.warn(`[ac-strings] action map 0x${mapId.toString(16)} load failed:`, err);
      try { window.__diag?.strings?.onActionMapFailed?.({ mapId, error: err }); } catch (_) {}
      const empty = { stringTableId: 0, actions: [] };
      actionMapCache = empty;
      return empty;
    } finally {
      actionMapPromise = null;
    }
  })();
  return actionMapPromise;
}

/**
 * Sync accessor — returns the resolved ActionMap if loaded, else null.
 */
export function getActionMap() {
  return actionMapCache;
}

/**
 * Diag-layer accessor — returns a snapshot of currently-cached state
 * without triggering loads. Used by `scene3d/diag/strings.js` to
 * read through cache contents that pre-date diag's install (e.g.
 * tables loaded by index.html's dynamic-import boot path).
 *
 * @returns {{
 *   tables: Array<{tableId: number, entryCount: number}>,
 *   languageStrings: Array<{stringId: number, textLength: number}>,
 *   actionMapLoaded: boolean,
 * }}
 */
export function getStringsDiagSnapshot() {
  return {
    tables: Array.from(tables.entries()).map(([tableId, map]) => ({
      tableId,
      entryCount: map?.size ?? 0,
    })),
    languageStrings: Array.from(languageStrings.entries()).map(([stringId, text]) => ({
      stringId,
      textLength: (text ?? "").length,
    })),
    actionMapLoaded: !!actionMapCache,
  };
}
