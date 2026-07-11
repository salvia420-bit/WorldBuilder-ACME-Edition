// A12 (S14 2026-07-11, 1120-appendix): shared memo between spawns.js's
// wave-level LOD degrade pre-warm and entities.js::_spawnImpl's per-entity
// consult. _spawnImpl's `await fetch_entity_degrade_for_distance` escaped
// the F.40/F.41 spawns batches (one wasm await per entity on the spawn
// path); spawns.js now warms a whole wave in ONE
// `fetch_entity_degrade_for_distance_batch` call and _spawnImpl reads the
// result synchronously.
//
// Keying: `(setupId, 25 m distance bucket)`. Distance moves between the
// pre-warm and the spawn (camera drift, dispatch latency), so exact-metre
// keys would never hit; a 25 m bucket is far finer than retail degrade
// bands (~100 m). A bucket mismatch or memo miss falls back to the
// per-entity wasm call — the memo is a pure perf layer, never a
// correctness gate. Slightly-stale band picks self-correct via the T9
// dynamic-LOD tick recheck (entities.js), same as before.
//
// `?lodPrewarm=off` disables the spawns-side pre-warm (documented in
// docs/url-flags.md); the memo itself stays inert when nothing writes it.

const BUCKET_METERS = 25;
// Bounded: `(setupId, bucket)` pairs are few (unique setups × a handful of
// rings), but a long teleport-hopping session shouldn't grow unbounded.
const MAX_ENTRIES = 4096;

const memo = new Map();

function key(setupId, distance) {
  return `${setupId >>> 0}|${Math.floor(distance / BUCKET_METERS)}`;
}

export function lodPrewarmEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("lodPrewarm") !== "off";
  } catch (_) {
    return true;
  }
}

export function lodPrewarmHas(setupId, distance) {
  return memo.has(key(setupId, distance));
}

/** Returns the memoised substitute (u32; 0 = "no LOD"), or undefined on miss. */
export function lodPrewarmGet(setupId, distance) {
  return memo.get(key(setupId, distance));
}

export function lodPrewarmSet(setupId, distance, substitute) {
  if (memo.size >= MAX_ENTRIES) memo.clear();
  memo.set(key(setupId, distance), substitute >>> 0);
}

/** Test/diag hook. */
export function lodPrewarmStats() {
  return { size: memo.size, bucketMeters: BUCKET_METERS };
}

export function lodPrewarmClear() {
  memo.clear();
}
