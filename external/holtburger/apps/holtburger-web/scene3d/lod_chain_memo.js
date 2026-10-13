// render-perf-2 (2026-10-13): per-setup memo of the wasm export
// `entity_degrade_chain_id(setupId)` (src/lib.rs) — the setup's
// GfxObjDegradeInfo chain DID, 0 when it has none. 0 also covers every
// MULTI-part setup (resolve_did_degrade's `parts.len() != 1` bail, i.e. most
// creatures): `fetch_entity_degrade_for_distance` can only ever answer 0 for
// those, yet the T9 dynamic-LOD tick (entities.js `_tickDynamicLod`) sent one
// async wasm band query per entity twice a second. entities.js
// `_gateLodChain` zeroes `_lodOriginalSetup` for a chainless setup so the
// tick's existing "no degrade chain" skip finally fires.
//
// Pure perf layer: a miss, a stale pkg/ (no export) or a rejected query
// (the export rejects when a record is not resident) leaves the entity on the
// per-tick query path it always had. A chain id is a pure function of the
// setup id against the immutable DAT, so a resolved answer never goes stale
// within a session.

// Bounded like lod_prewarm.js: distinct setups a session meets are far fewer.
const MAX_ENTRIES = 4096;

const memo = new Map(); // setupId (u32) -> chain id (u32; 0 = no chain)
const inflight = new Map(); // setupId (u32) -> Promise<number | undefined>

/** The memoised chain id (u32; 0 = no chain), or undefined when unknown. */
export function lodChainGet(setupId) {
  return memo.get(setupId >>> 0);
}

/**
 * Resolve (and memoise) a setup's chain id through `chainFn`
 * (`wasmExports.entity_degrade_chain_id`). Concurrent callers for one setup
 * share a single query. Resolves `undefined` — and memoises nothing — when
 * `chainFn` is missing, rejects/throws, or returns a non-number.
 * @param {number} setupId
 * @param {(setupId: number) => number | Promise<number>} chainFn
 * @returns {Promise<number | undefined>}
 */
export function lodChainResolve(setupId, chainFn) {
  const sid = setupId >>> 0;
  const known = memo.get(sid);
  if (known !== undefined) return Promise.resolve(known);
  if (typeof chainFn !== "function") return Promise.resolve(undefined);
  let pending = inflight.get(sid);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => chainFn(sid))
      .then(
        (chain) => {
          if (typeof chain !== "number" || !Number.isFinite(chain)) return undefined;
          const v = chain >>> 0;
          if (memo.size >= MAX_ENTRIES) memo.clear();
          memo.set(sid, v);
          return v;
        },
        () => undefined
      )
      .finally(() => {
        if (inflight.get(sid) === pending) inflight.delete(sid);
      });
    inflight.set(sid, pending);
  }
  return pending;
}

/** Test/diag hook. */
export function lodChainStats() {
  return { size: memo.size, inflight: inflight.size };
}

export function lodChainClear() {
  memo.clear();
  inflight.clear();
}
