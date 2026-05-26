/**
 * AC PhysicsScriptTable (DAT 0x34) JS facade.
 *
 * Wave 16 / Phase 49 — wraps the `fetchPhysicsScriptTable(did)` wasm
 * export added at `apps/holtburger-web/src/lib.rs:27533+` with a
 * module-scoped Promise cache so the per-entity resolver in Wave 17
 * can call `fetchPhysicsScriptTable(entity.physicsScriptTableDid)`
 * once per table without re-paying the prefetch + parse cost.
 *
 * ## Shape
 *
 * The wasm export emits JSON of the form:
 * ```json
 * {
 *   "id": 872415236,
 *   "scripts": {
 *     "4":  [{"mod": 0.5, "scriptDid": 855638307},
 *            {"mod": 1.0, "scriptDid": 855638308}],
 *     "5":  [{"mod": 1.0, "scriptDid": 855638400}]
 *   }
 * }
 * ```
 *
 * Outer keys are decimal `PScriptType` enum values (JSON object keys
 * must be strings — this facade exposes them via `scripts[String(key)]`
 * the way `JSON.parse` returns them; the Wave 17 resolver will likely
 * re-index into a `Map<number, …>` once for the picker hot-path).
 *
 * Inner entries are in DAT byte order, ascending by `mod`. The
 * retail picker (`acclient.c:336552 PhysicsScriptTableData::GetScript`,
 * see `external/holtburger/docs/physicsscript-bridge-research-2026-05-26.md`
 * §1.5) walks the list top-down and returns the first row where
 * `incoming_mod <= entry.mod`.
 *
 * ## Cache semantics
 *
 * - `Map<did, Promise<table | null>>` — both successful tables AND
 *   misses (null) are cached so repeated lookups against a missing
 *   DID don't re-pay the wasm round-trip.
 * - Concurrent callers for the same `did` share one in-flight
 *   Promise; the wasm export itself is idempotent + prefetch-cached
 *   on the Rust side, but the JS-side cache avoids creating multiple
 *   wasm bindings + duplicate JSON parses.
 * - `null` is the sentinel for both "DAT miss" (no such record) and
 *   "parse error" — callers should treat them identically (fall back
 *   to placeholder visuals; the Wave 17 resolver in
 *   `scene3d/play_effect_vfx.js` handles both paths).
 *
 * ## Errors NEVER thrown
 *
 * Per the Wave 16 P49 contract: every failure mode (no wasm, bad DID,
 * parse error, fetch failure) resolves to `null`. Callers can rely on
 * `if (table) { … }` for the fast path without try/catch.
 *
 * @example
 *   import { fetchPhysicsScriptTable } from "./ui/ac_physics_script_table.js";
 *   const tbl = await fetchPhysicsScriptTable(0x34000004);
 *   if (tbl) {
 *     // PScriptType.Launch = 0x04 = "4"
 *     const launchEntries = tbl.scripts["4"];
 *     // launchEntries[0] = {mod: 0.0, scriptDid: 855638138}
 *   }
 */

/**
 * @typedef {Object} PstEntry
 * @property {number} mod        — weight / selection threshold (f32)
 * @property {number} scriptDid  — PhysicsScript DID (0x33xxxxxx)
 */

/**
 * @typedef {Object} Pst
 * @property {number} id                                 — table DID (0x34xxxxxx)
 * @property {Record<string, PstEntry[]>} scripts        — PScriptType → ordered entries
 */

// Module-scoped cache: Map<did, Promise<Pst | null>>. We cache the
// Promise itself (not the resolved value) so concurrent callers for
// the same DID share one fetch + parse. The Promise resolves to
// either the parsed table or `null` — never rejects (per contract).
const _cache = new Map();

/**
 * Resolve a PhysicsScriptTable DID to its parsed `{ id, scripts }`
 * shape, caching the Promise per-DID. Returns `null` on miss or
 * parse failure — never throws.
 *
 * @param {number} did — DAT ID (0x34000000..=0x3400FFFF)
 * @returns {Promise<Pst | null>}
 */
export function fetchPhysicsScriptTable(did) {
  const key = (did >>> 0);
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;

  const promise = (async () => {
    const wasm = (typeof window !== "undefined")
      ? (window.__hbWasm ?? window.__wasm ?? null)
      : null;
    if (!wasm || typeof wasm.fetchPhysicsScriptTable !== "function") {
      return null;
    }
    let json;
    try {
      json = await wasm.fetchPhysicsScriptTable(key);
    } catch (err) {
      // wasm-side fetch / prefetch error — the Rust path already
      // returns `"null"` for DAT misses, so reaching this catch
      // means an unexpected JS/wasm boundary failure. Log + cache
      // null per the "never throw" contract.
      console.warn(`[ac-pst] fetchPhysicsScriptTable(0x${key.toString(16)}) wasm threw:`, err);
      return null;
    }
    if (typeof json !== "string" || json === "null") {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      console.warn(`[ac-pst] fetchPhysicsScriptTable(0x${key.toString(16)}) JSON parse failed:`, err);
      return null;
    }
    // Shape validation. We accept anything with both `id` (u32) and
    // `scripts` (object) and let the resolver tolerate empty
    // `scripts` (a real edge case — see DAT 0x34000004 keys 116, 117,
    // 118 which carry single-entry rows). Anything else is a parse
    // bug on our side and should drop to the placeholder path.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "number" ||
      typeof parsed.scripts !== "object" ||
      parsed.scripts === null
    ) {
      return null;
    }
    return parsed;
  })();

  _cache.set(key, promise);
  return promise;
}

/**
 * Test-only: clear the module cache. Exported so test fixtures can
 * reset between runs without churning the module loader. Production
 * code should NEVER call this — there's no invalidation story since
 * DAT records are immutable across a session.
 */
export function _clearPhysicsScriptTableCache() {
  _cache.clear();
}

/**
 * Test-only: cache size, for assertions.
 */
export function _physicsScriptTableCacheSize() {
  return _cache.size;
}

// ---------------------------------------------------------------------
// Inline unit tests
//
// Run with: node --input-type=module --eval "await import('./ui/ac_physics_script_table.js').then(m => m._runSelfTests())"
//
// These tests stub `window.__hbWasm.fetchPhysicsScriptTable` to
// exercise the cache + null-on-miss paths WITHOUT a real wasm build.
// They're intentionally minimal — the JSON shape itself is covered by
// the Rust side's parity tests (`PhysicsScriptTable::unpack` against
// retail `0x34000004`).
// ---------------------------------------------------------------------

/**
 * Self-test runner. Returns `{ passed, failed, total }` and throws on
 * any failure (so `node --check` style smoke runs can pipe to exit
 * status).
 *
 * @returns {Promise<{ passed: number, failed: number, total: number }>}
 */
export async function _runSelfTests() {
  /** @type {Array<[string, () => Promise<void> | void]>} */
  const cases = [
    [
      "test 1: cache hit returns the same Promise instance",
      async () => {
        _clearPhysicsScriptTableCache();
        const fakeJson = JSON.stringify({
          id: 0x34000004,
          scripts: { "4": [{ mod: 1.0, scriptDid: 0x33000100 }] },
        });
        globalThis.window = globalThis.window ?? {};
        globalThis.window.__hbWasm = {
          fetchPhysicsScriptTable: async () => fakeJson,
        };
        const p1 = fetchPhysicsScriptTable(0x34000004);
        const p2 = fetchPhysicsScriptTable(0x34000004);
        if (p1 !== p2) throw new Error("expected identical Promise from cache hit");
        const t = await p1;
        if (t?.id !== 0x34000004) throw new Error(`expected id=0x34000004, got ${t?.id}`);
        if (t?.scripts?.["4"]?.[0]?.scriptDid !== 0x33000100) {
          throw new Error("expected scripts['4'][0].scriptDid=0x33000100");
        }
        if (_physicsScriptTableCacheSize() !== 1) {
          throw new Error(`expected cache size 1, got ${_physicsScriptTableCacheSize()}`);
        }
      },
    ],
    [
      "test 2: wasm returning 'null' string resolves to null and caches",
      async () => {
        _clearPhysicsScriptTableCache();
        globalThis.window = globalThis.window ?? {};
        let callCount = 0;
        globalThis.window.__hbWasm = {
          fetchPhysicsScriptTable: async () => { callCount += 1; return "null"; },
        };
        const t1 = await fetchPhysicsScriptTable(0x34999999);
        const t2 = await fetchPhysicsScriptTable(0x34999999);
        if (t1 !== null || t2 !== null) throw new Error("expected null on DAT miss");
        if (callCount !== 1) throw new Error(`expected 1 wasm call (cache hit on 2nd), got ${callCount}`);
      },
    ],
    [
      "test 3: missing wasm export resolves to null without throwing",
      async () => {
        _clearPhysicsScriptTableCache();
        globalThis.window = globalThis.window ?? {};
        globalThis.window.__hbWasm = { /* no fetchPhysicsScriptTable */ };
        const t = await fetchPhysicsScriptTable(0x34000004);
        if (t !== null) throw new Error("expected null when wasm export missing");
      },
    ],
    [
      "test 4: invalid JSON / wrong shape resolves to null",
      async () => {
        _clearPhysicsScriptTableCache();
        globalThis.window = globalThis.window ?? {};
        globalThis.window.__hbWasm = {
          fetchPhysicsScriptTable: async () => "{not valid json",
        };
        const t1 = await fetchPhysicsScriptTable(0x34000001);
        if (t1 !== null) throw new Error("expected null on JSON.parse failure");

        _clearPhysicsScriptTableCache();
        globalThis.window.__hbWasm = {
          fetchPhysicsScriptTable: async () => JSON.stringify({ wrong: "shape" }),
        };
        const t2 = await fetchPhysicsScriptTable(0x34000002);
        if (t2 !== null) throw new Error("expected null on shape mismatch (no id/scripts)");
      },
    ],
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name}: ${err?.message ?? err}`);
    }
  }
  const total = cases.length;
  console.log(`[ac-pst self-tests] ${passed}/${total} pass, ${failed} fail`);
  if (failed > 0) throw new Error(`${failed} self-test(s) failed`);
  return { passed, failed, total };
}
