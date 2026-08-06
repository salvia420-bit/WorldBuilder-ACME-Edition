// 2026-08-05 — `?bc7RecordsMB`, the byte budget over `Bc7RecordSource`'s parsed
// -payload caches (`_cache` / `_preCache`).
//
// Those two maps were UNBOUNDED and keyed by RenderSurface id, so they grew with
// route length. The texture census (§9 of the 08-05 handoff) measured 553 + 476
// records after six towns, holding ~297 MB gross and 60 MB that no live texture
// accounts for.
//
// What must hold:
//   PART 1 — the flag grammar. Absent/garbage ⇒ the armed default; only an
//            explicit off-form disarms. A typo must never silently uncap memory.
//   PART 2 — byte accounting dedupes by ArrayBuffer, because `parseHbc7` hands
//            out mip levels as subarrays of ONE payload.
//   PART 3 — eviction trims to budget, oldest first, and NEVER evicts a
//            proven-absent (`null`) verdict: those are what stop a re-fetch
//            storm and they cost no bytes.
//   PART 4 — a hit bumps recency, so the working set survives and the cold tail
//            is what goes.
//   PART 5 — disarmed behaves exactly like the old unbounded map.
//
// Run:
//   cd apps/holtburger-web/
//   node test_bc7_record_budget.mjs

import { Bc7RecordSource, bc7RecordBudgetBytes, bc7RecordCacheBytes } from "./scene3d/bc7_textures.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const MB = 1024 * 1024;

/** A parsed record shaped like `parseHbc7`'s output: mip levels as subarray
 *  views over ONE payload buffer. */
function fakeParsed(bytes, levels = 3) {
  const payload = new Uint8Array(bytes);
  const out = [];
  let off = 0;
  for (let i = 0; i < levels; i++) {
    const n = Math.max(1, Math.floor(bytes / (levels * 2)));
    out.push({ data: payload.subarray(off, Math.min(bytes, off + n)), width: 4, height: 4 });
    off += n;
  }
  return { width: 64, height: 64, blocksX: 16, blocksY: 16, levels: out };
}

console.log("PART 1 — flag grammar");
{
  check("absent ⇒ armed default 256 MB", bc7RecordBudgetBytes("") === 256 * MB);
  check("garbage ⇒ the default, never 0", bc7RecordBudgetBytes("?bc7RecordsMB=banana") === 256 * MB);
  check("below 1 ⇒ the default", bc7RecordBudgetBytes("?bc7RecordsMB=0.5") === 256 * MB);
  check("explicit N", bc7RecordBudgetBytes("?bc7RecordsMB=64") === 64 * MB);
  for (const off of ["off", "0", "false", "no"]) {
    check(`?bc7RecordsMB=${off} disarms`, bc7RecordBudgetBytes(`?bc7RecordsMB=${off}`) === Infinity);
  }
}

console.log("PART 2 — byte accounting dedupes by buffer");
{
  const src = new Bc7RecordSource({ budgetBytes: Infinity });
  src._put(src._cache, 1, fakeParsed(1000));
  check(
    "one record charges its payload once, not once per mip level",
    src._recordBytes === 1000,
    `${src._recordBytes} (summing 3 level views would differ)`,
  );
  src._put(src._cache, 2, null);
  check("a proven-absent entry charges nothing", src._recordBytes === 1000);
  check("...but still occupies the map (no re-fetch storm)", src._cache.size === 2);
  src._put(src._cache, 1, fakeParsed(500));
  check("re-inserting a key discharges the old bytes first", src._recordBytes === 500,
        String(src._recordBytes));
}

console.log("PART 3 — eviction trims to budget and spares the negatives");
{
  const src = new Bc7RecordSource({ budgetBytes: 3000 });
  for (let i = 1; i <= 4; i++) src._put(src._cache, i, fakeParsed(1000));
  const st = src.recordCacheStats();
  check("held at or under budget", st.bytes <= 3000, `${st.bytes} / 3000`);
  check("something was evicted", st.evictions > 0, `evictions=${st.evictions}`);
  check("the OLDEST went first", !src._cache.has(1) && src._cache.has(4),
        `has(1)=${src._cache.has(1)} has(4)=${src._cache.has(4)}`);

  const neg = new Bc7RecordSource({ budgetBytes: 1500 });
  neg._put(neg._cache, 10, null);           // oldest, and a negative verdict
  neg._put(neg._cache, 11, fakeParsed(1000));
  neg._put(neg._cache, 12, fakeParsed(1000));
  check("a proven-absent verdict survives eviction pressure", neg._cache.has(10));
  check("...and a positive entry was taken instead", !neg._cache.has(11));

  const pre = new Bc7RecordSource({ budgetBytes: 1200 });
  pre._put(pre._preCache, 20, fakeParsed(1000));
  pre._put(pre._cache, 21, fakeParsed(1000));
  check("the quarter-res PRE twin is dropped before the full record",
        !pre._preCache.has(20) && pre._cache.has(21),
        `pre=${pre._preCache.has(20)} full=${pre._cache.has(21)}`);
}

console.log("PART 4 — recency");
{
  const src = new Bc7RecordSource({ budgetBytes: 3000 });
  src._put(src._cache, 1, fakeParsed(1000));
  src._put(src._cache, 2, fakeParsed(1000));
  src._put(src._cache, 3, fakeParsed(1000));
  src._touch(src._cache, 1);                  // 1 is now the youngest
  src._put(src._cache, 4, fakeParsed(1000));  // forces one eviction
  check("a touched entry survives; the untouched-oldest goes",
        src._cache.has(1) && !src._cache.has(2),
        `has(1)=${src._cache.has(1)} has(2)=${src._cache.has(2)}`);
}

console.log("PART 5 — disarmed is the old unbounded map");
{
  const src = new Bc7RecordSource({ budgetBytes: Infinity });
  for (let i = 0; i < 200; i++) src._put(src._cache, i, fakeParsed(10000));
  const st = src.recordCacheStats();
  check("nothing is ever evicted", st.evictions === 0 && src._cache.size === 200,
        `evictions=${st.evictions} size=${src._cache.size}`);
  check("budget reports -1 when disarmed", st.budget === -1, String(st.budget));
}

console.log("PART 6 — the census accessor still reports independent hold");
{
  // `bc7RecordCacheBytes` reads the module-level installed source, which these
  // tests never install, so it must degrade to zeros rather than throw.
  const out = bc7RecordCacheBytes(new Set());
  check("degrades cleanly with no installed source", out && out.bytes === 0, JSON.stringify(out));
  check("...and reports that it was given a shared dedupe set", out.shared === true);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
