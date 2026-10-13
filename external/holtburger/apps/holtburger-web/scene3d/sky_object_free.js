// scene3d/sky_object_free.js — free the wasm SkyObjectState wrappers that a
// `getSkyObjectStates()` call returns (sky-fog-time-5, 2026-10-13).
//
// Each call evaluates the sky again in wasm and returns one fresh
// wasm-bindgen object per SkyObject in the active DayGroup (7 for retail
// Dereth's "Sunny" group). Each wrapper owns a wasm-heap allocation that is
// released only by `.free()` or, later, by the FinalizationRegistry after a
// JS GC. At the ~10 Hz sky tick that is about 70 registrations a second of
// pure churn. The weather tick (loop.js `tickWeatherState`) is the per-tick
// caller. It and everything it feeds (the storm scan, the sky-dome billboard
// and particle-chain hosts) read the fields synchronously and keep none of
// the wrappers, so the tick frees the array when it is done.
//
// `?skyObjFree=off` leaves the wrappers to the GC again (the pre-2026-10-13
// behaviour). Pure (no DOM / three / wasm imports).

function params(search) {
  try { return new URLSearchParams(search ?? globalThis.location?.search ?? ""); }
  catch (_) { return new URLSearchParams(""); }
}
const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?skyObjFree` — default on; `off` / `0` / `false` disable it. */
export function skyObjectFreeEnabled(search) {
  return !isOff(params(search).get("skyObjFree"));
}

/** Read once at module load (the page URL does not change mid-session). */
export const SKY_OBJECT_FREE_ENABLED = skyObjectFreeEnabled();

/**
 * Free every wrapper in a `getSkyObjectStates()` array and return how many
 * were freed. Entries without a `free` method (plain objects, a stale pkg)
 * are skipped, and a throwing free (a wrapper that was already freed) never
 * escapes. Pass the ORIGINAL array: a filtered copy (visual_options.js
 * `dropWeatherSkyObjects`) holds the same wrappers, so freeing both arrays
 * would free some wrappers twice.
 */
export function freeSkyObjectStates(skyObjects) {
  if (!Array.isArray(skyObjects)) return 0;
  let freed = 0;
  for (const o of skyObjects) {
    if (!o || typeof o.free !== "function") continue;
    try {
      o.free();
      freed += 1;
    } catch (_) {
      /* already freed: nothing left to release */
    }
  }
  return freed;
}
