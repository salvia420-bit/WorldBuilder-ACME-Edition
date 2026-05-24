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
      return map;
    } catch (err) {
      console.warn(`[ac-strings] table 0x${tableId.toString(16)} load failed:`, err);
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
  return t.get(hashId >>> 0) ?? null;
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
      return text;
    } catch (err) {
      console.warn(`[ac-strings] language string 0x${stringId.toString(16)} load failed:`, err);
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
