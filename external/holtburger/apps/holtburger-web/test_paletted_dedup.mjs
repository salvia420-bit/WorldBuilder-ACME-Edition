// `?palDedup` — paletted-material single-flight (2026-08-06).
//
// THE BUG. `palettedMaterials` has deduped by VALUE key since 2026-05-28
// (`did|paletteId|subPalettes`), and a cache HIT is already shared across
// entities — but the lookup is synchronous and the install is ~897 ms of
// `await fetchEntitySurfacesPixels` later, while spawns.js dispatches a
// landblock's spawns in one un-awaited loop. Every rig that missed inside
// another rig's decode window minted its own copy. Measured at Nanto: FOUR
// material objects for ONE `__paletteKey` on four guids.
//
// THE FIX. The paletted twin of the plain path's `pendingFetches` single-flight:
// the first misser CLAIMS the key, later missers JOIN its promise.
//
// WHAT THIS SUITE PINS
//   1. POSITIVE — two concurrent "spawns" with the SAME signature end up
//      holding the SAME material object, and only ONE decode ran.
//   2. NEGATIVE — two genuinely different palettes (different paletteId, and
//      same paletteId with different subPalettes) never join and never share.
//      This is the safety property: the key IS the full recolor signature, so
//      differently-dyed characters cannot be handed each other's material.
//   3. The settle CONTRACT — idempotent, self-deleting, null-settle puts the
//      joiner back on the "decode it yourself / fallback" branch, and
//      `dispose()` settles rather than strands outstanding claims.
//   4. `?palDedup=off` is a byte-identical escape (both APIs return null).
//   5. entities.js actually routes through the API, and url-flags.md has a row.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_paletted_dedup.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

import { locateThree, requireThree } from "./harness/lib/locate_three.mjs";
import { spliceModule } from "./harness/lib/splice_module.mjs";
import { MATERIALS_JS_STUBS } from "./harness/lib/scene3d_stubs.mjs";

const threePath = locateThree();
const THREE = await requireThree("paletted-dedup ESM test");

console.log("`?palDedup` — paletted-material single-flight");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

const matsSrc = readFileSync(resolvePath(__dirname, "scene3d/materials.js"), "utf8");
const matsFactory = new Function(
  "THREE",
  spliceModule(matsSrc, { stubs: MATERIALS_JS_STUBS, label: "scene3d/materials.js" }) +
    "\n; return { MaterialCache, palettedDedupEnabled, __setPalettedDedupForTest };"
);
const { MaterialCache, palettedDedupEnabled, __setPalettedDedupForTest } = matsFactory(THREE);

// The flag is lazy+memoised and there is no `location` here, so it reads its
// DEFAULT-ON value. Pin it explicitly anyway — a later suite in the same
// process must not depend on read order.
__setPalettedDedupForTest(true);
check("flag defaults ON with no location (Node)", palettedDedupEnabled() === true);

/** Spy material/texture: a dispose counter, as in test_materials_paletted_lru. */
function spy(tag) {
  return { __tag: tag, disposed: 0, userData: {}, dispose() { this.disposed += 1; } };
}
function freshCache() { return new MaterialCache({ palBudgetBytes: 0 }); }

// The three signatures used throughout. Same DID + same paletteId, DIFFERENT
// sub-palette tuples = two different dyes of the same garment — the case that
// must NEVER share.
const DID = 0x0800_0015;
const PAL = 0x0400_007e;
const DYE_A = new Uint32Array([0, 8, 12]);
const DYE_B = new Uint32Array([0, 8, 47]);

// ----------------------------------------------------------------------
// 1. POSITIVE — one instance per value key across a concurrent race.
//
// Models the entities.js spawn order exactly: sync `getCachedPaletted` →
// sync `getPalettedInflight` → sync `claimPalettedInflight` → await decode →
// mint → `installPaletted` → settle. Two "spawns" are interleaved with the
// decode still in flight, which is the exact window the bug lived in.
// ----------------------------------------------------------------------
{
  const cache = freshCache();
  let decodes = 0;

  async function spawnLike(cache, did, paletteId, subs, mintTag) {
    const hit = cache.getCachedPaletted(did, paletteId, subs);
    if (hit) return { material: hit, minted: false };
    const pending = cache.getPalettedInflight(did, paletteId, subs);
    if (pending) return { material: await pending, minted: false };
    const settle = cache.claimPalettedInflight(did, paletteId, subs);
    try {
      decodes += 1;
      await new Promise((r) => setTimeout(r, 5)); // stands in for the wasm decode
      const mat = spy(mintTag);
      cache.installPaletted(did, paletteId, subs, mat, spy(mintTag + "-tex"));
      settle?.(mat);
      return { material: mat, minted: true };
    } finally {
      settle?.(null); // idempotent sweep — the entities.js `finally`
    }
  }

  // Four rigs in the same outfit, dispatched WITHOUT awaiting (spawns.js shape).
  const rigs = await Promise.all([
    spawnLike(cache, DID, PAL, DYE_A, "m0"),
    spawnLike(cache, DID, PAL, DYE_A, "m1"),
    spawnLike(cache, DID, PAL, DYE_A, "m2"),
    spawnLike(cache, DID, PAL, DYE_A, "m3"),
  ]);

  const distinct = new Set(rigs.map((r) => r.material));
  check("4 concurrent same-signature spawns hold ONE material object",
    distinct.size === 1, `distinct=${distinct.size}`);
  check("exactly one decode ran (3 avoided)", decodes === 1, `decodes=${decodes}`);
  check("exactly one rig minted", rigs.filter((r) => r.minted).length === 1);
  check("the shared object IS the cached one",
    cache.getCachedPaletted(DID, PAL, DYE_A) === rigs[0].material);
  check("cache holds ONE signature, not four",
    cache.palettedMaterials.size === 1, `size=${cache.palettedMaterials.size}`);
  check("installPaletted tagged it cache-owned + keyed",
    rigs[0].material.userData.__cacheOwned === true &&
    rigs[0].material.userData.__paletteKey === `${DID}|${PAL}|0,8,12`,
    `key=${rigs[0].material.userData.__paletteKey}`);
  check("in-flight map drained back to empty",
    cache.palettedInflight.size === 0, `inflight=${cache.palettedInflight.size}`);
  const st = cache.palettedCacheStats();
  check("stats report the avoided decodes", st.claims === 1 && st.joins === 3 && st.inflight === 0,
    `claims=${st.claims} joins=${st.joins} inflight=${st.inflight}`);
  check("stats report the flag", st.dedupEnabled === true);
}

// ----------------------------------------------------------------------
// 2. NEGATIVE — different palettes NEVER share. This is the safety test:
//    two players in differently-dyed armour must keep separate materials.
// ----------------------------------------------------------------------
{
  const cache = freshCache();
  // Claim dye A, then ask about dye B and a different paletteId while A is
  // still in flight. Neither may be offered A's promise.
  const settleA = cache.claimPalettedInflight(DID, PAL, DYE_A);
  check("a claim is handed out for dye A", typeof settleA === "function");
  check("SAME did+palette, DIFFERENT subPalettes ⇒ no join offered",
    cache.getPalettedInflight(DID, PAL, DYE_B) === null);
  check("SAME did+subPalettes, DIFFERENT paletteId ⇒ no join offered",
    cache.getPalettedInflight(DID, PAL + 1, DYE_A) === null);
  check("DIFFERENT did ⇒ no join offered",
    cache.getPalettedInflight(DID + 1, PAL, DYE_A) === null);
  check("re-asking for dye A DOES offer the join",
    cache.getPalettedInflight(DID, PAL, DYE_A) !== null);

  const matA = spy("dyeA");
  cache.installPaletted(DID, PAL, DYE_A, matA, spy("dyeA-tex"));
  settleA(matA);
  const matB = spy("dyeB");
  cache.installPaletted(DID, PAL, DYE_B, matB, spy("dyeB-tex"));

  check("two dyes ⇒ two distinct cached materials",
    cache.getCachedPaletted(DID, PAL, DYE_A) === matA &&
    cache.getCachedPaletted(DID, PAL, DYE_B) === matB &&
    matA !== matB);
  check("two dyes ⇒ two signatures in the cache",
    cache.palettedMaterials.size === 2, `size=${cache.palettedMaterials.size}`);
  // An empty subPalettes tuple is its own signature, not a wildcard.
  check("empty subPalettes is a distinct key, not a match-all",
    cache.getCachedPaletted(DID, PAL, new Uint32Array(0)) === null);
  // …and the key really is built from the VALUES: an equal-valued but
  // different Uint32Array object must hit, or the whole dedup would be
  // identity-keyed and silently useless.
  check("an equal-VALUED distinct subPalettes array still hits",
    cache.getCachedPaletted(DID, PAL, new Uint32Array([0, 8, 12])) === matA);
}

// ----------------------------------------------------------------------
// 3. The settle contract.
// ----------------------------------------------------------------------
{
  const cache = freshCache();
  const settle = cache.claimPalettedInflight(DID, PAL, DYE_A);
  const joined = cache.getPalettedInflight(DID, PAL, DYE_A);
  check("claiming an already-claimed key returns null (one owner)",
    cache.claimPalettedInflight(DID, PAL, DYE_A) === null);
  settle(null);
  check("settle deletes its own in-flight entry", cache.palettedInflight.size === 0);
  check("a null settle resolves the joiner with null", (await joined) === null);
  // Idempotent: a second settle (the entities.js `finally` sweep) must not
  // throw, and must not clobber a LATER claim for the same key.
  const settle2 = cache.claimPalettedInflight(DID, PAL, DYE_A);
  settle(null);
  check("a repeat settle does not evict a LATER owner's claim",
    cache.palettedInflight.size === 1);
  settle2(null);
  check("the later owner's settle drains it", cache.palettedInflight.size === 0);

  // dispose() must SETTLE outstanding claims, not merely drop them: a spawn
  // continuation parked on a joined promise would otherwise await forever.
  const cache2 = freshCache();
  cache2.claimPalettedInflight(DID, PAL, DYE_A);
  const orphanJoin = cache2.getPalettedInflight(DID, PAL, DYE_A);
  cache2.dispose();
  check("dispose() settles (not strands) outstanding claims",
    (await orphanJoin) === null);
  check("dispose() empties the in-flight map", cache2.palettedInflight.size === 0);
}

// ----------------------------------------------------------------------
// 4. `?palDedup=off` — byte-identical escape.
// ----------------------------------------------------------------------
{
  __setPalettedDedupForTest(false);
  const cache = freshCache();
  check("off ⇒ claim returns null (no claim taken)",
    cache.claimPalettedInflight(DID, PAL, DYE_A) === null);
  check("off ⇒ in-flight lookup returns null",
    cache.getPalettedInflight(DID, PAL, DYE_A) === null);
  check("off ⇒ nothing is registered", cache.palettedInflight.size === 0);
  const mat = spy("off");
  cache.installPaletted(DID, PAL, DYE_A, mat, spy("off-tex"));
  check("off ⇒ the value-keyed cache itself is untouched",
    cache.getCachedPaletted(DID, PAL, DYE_A) === mat);
  check("off ⇒ stats say so", cache.palettedCacheStats().dedupEnabled === false);
  __setPalettedDedupForTest(true);
}

// ----------------------------------------------------------------------
// 5. Wiring — the production caller and the docs row.
// ----------------------------------------------------------------------
{
  const ent = readFileSync(resolvePath(__dirname, "scene3d/entities.js"), "utf8");
  check("entities.js spawn path consults the in-flight map before fetching",
    /getPalettedInflight\(did, paletteId, subPalettes\)/.test(ent));
  check("entities.js claims the key it is about to fetch",
    /claimPalettedInflight\(did, paletteId, subPalettes\)/.test(ent));
  check("entities.js settles the claim after installPaletted",
    /installPaletted\(did, paletteId, subPalettes, mat, tex\);[\s\S]{0,600}?_palSettle\(did, mat\)/.test(ent));
  check("entities.js sweeps leftover claims BEFORE awaiting joins (deadlock argument)",
    /_palSweepClaims\(\);\s*\n\s*if \(palJoins\.length > 0\) \{/.test(ent));
  check("entities.js sweeps again in a finally (every-exit-path contract)",
    /\} finally \{[\s\S]{0,600}?_palSweepClaims\(\);/.test(ent));
  check("entities.js bounds the join wait",
    /PALETTED_JOIN_TIMEOUT_MS = \d+/.test(ent) && /Promise\.race\(\[all, timeout\]\)/.test(ent));

  const doc = readFileSync(resolvePath(__dirname, "docs/url-flags.md"), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("| `palDedup` |"));
  check("url-flags.md documents ?palDedup", !!row);
  check("…as DEFAULT-ON with an `off` escape",
    !!row && /\*\*on\*\*/.test(row) && /`off`/.test(row));
  check("…and names the reader + call sites",
    !!row && /palettedDedupEnabled/.test(row) && /entities\.js/.test(row));
  check("…and records the safety argument (the key is the full recolor signature)",
    !!row && /subPalettes/.test(row) && /_getOrCloneEntityMaterial/.test(row));
}

console.log("=========================");
console.log(`${failed === 0 ? "PASS" : "FAIL"}: ${passed}/${passed + failed} palDedup checks green.`);
process.exit(failed === 0 ? 0 : 1);
