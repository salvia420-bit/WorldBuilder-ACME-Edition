// scene3d/mem_census.js
//
// 2026-08-05 (renderer-OOM attribution) — the page-side half of the wasm
// memory census. The Rust half (`src/lib.rs::hb_mem_census`) reports ONE wasm
// instance; this rolls the page's TWO instances (main thread + bake worker)
// into a single reading.
//
// Why the sum matters: the two linear memories are independent allocations
// against ONE renderer-process cap (4,192 MB on the 1070, where the tab was
// OOM-crashing). A store holding 200 MB on each half costs the tab 400 MB,
// and the per-instance numbers never say that out loud.
//
// Kept in its own module — instead of inline in `index.js` where the rest of
// `__diag` lives — so the arithmetic is exercised by `test_mem_census.mjs`
// without standing up a scene. A mis-summing memory probe does not fail
// loudly; it just points the next fix at the wrong store.

/**
 * Roll two `hb_mem_census()` results into a page-wide reading.
 *
 * A half that is `null` (worker inactive) or that lacks `allocLive` (a `pkg/`
 * predating the export — the stale-build case the whole repo trips over) is
 * NOT counted as zero: it is named in `missing`, so an un-rebuilt bundle reads
 * as UNKNOWN rather than as "the worker holds nothing".
 *
 * @param {object|null} main   parsed census from the main-thread instance
 * @param {object|null} worker parsed census from the bake worker's instance
 * @returns {{page: object, missing: string[]}}
 */
export function summarizeMemCensus(main, worker) {
  const SCALARS = [
    "memoryBytes",
    "allocLive",
    "allocPeak",
    "storeBytes",
    "unattributed",
    "slackBytes",
    "decodePeakLiveBytes",
  ];
  const page = { stores: {}, top: [] };
  for (const k of SCALARS) page[k] = 0;
  const missing = [];

  for (const [name, half] of [
    ["main", main],
    ["worker", worker],
  ]) {
    if (!half || typeof half.allocLive !== "number") {
      missing.push(name);
      continue;
    }
    for (const k of SCALARS) page[k] += half[k] ?? 0;
    for (const [store, row] of Object.entries(half.stores ?? {})) {
      const acc = (page.stores[store] ??= { bytes: 0, entries: 0 });
      acc.bytes += row?.bytes ?? 0;
      acc.entries += row?.entries ?? 0;
    }
  }

  // Biggest rows first — the entire question this instrument answers is
  // "what is holding it", so the answer should be the first thing printed.
  page.top = Object.entries(page.stores)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 5)
    .map(([k, v]) => `${k} ${(v.bytes / 1048576).toFixed(1)}MB`);
  return { page, missing };
}

/**
 * One-line verdict for the reading, in the terms the OOM investigation is
 * stuck between (see `src/lib.rs`'s `hb_mem_census` header).
 *
 * This is a POINTER, not a proof: a single poll cannot see a trend, so
 * "retention" here means "live bytes dominate what the process holds right
 * now", which is the hypothesis to test across a route — not a verdict on its
 * own. `unattributed` is called out separately because a large residual means
 * the census itself is incomplete, and no amount of budgeting a named store
 * will move it.
 */
export function memCensusVerdict(page) {
  if (!page || !page.memoryBytes) return "no reading";
  const mb = (n) => (n / 1048576).toFixed(0) + "MB";
  const liveShare = page.allocLive / page.memoryBytes;
  const unattributedShare = page.storeBytes > 0
    ? page.unattributed / Math.max(1, page.allocLive)
    : 1;
  const parts = [
    `${mb(page.memoryBytes)} linear, ${mb(page.allocLive)} live (${(liveShare * 100).toFixed(0)}%)`,
  ];
  parts.push(
    liveShare >= 0.5
      ? "RETENTION-shaped: most of the memory is still owned — chase the top store"
      : "HIGH-WATER-shaped: most of the memory is allocator slack — a cache budget cannot return it, bound the decode",
  );
  if (unattributedShare > 0.5) {
    parts.push(
      `WARNING: ${mb(page.unattributed)} unattributed — no census row claims it, so the census is missing a store`,
    );
  }
  return parts.join(" | ");
}
