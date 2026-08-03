// R9 — the ui/ DAT-runtime loaders must not latch "wasm isn't ready yet".
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_dat_runtime_no_latch.mjs
//
// ui/ac_lod.js, ui/ac_palette.js, ui/ac_palette_set.js, ui/ac_clothing.js,
// ui/ac_combat_maneuver.js and ui/ac_font.js all shipped the identical
// loader skeleton:
//
//     const promise = (async () => {
//       const wasm = window.__hbWasm ?? window.__wasm ?? null;
//       if (!wasm?.fetch_x) { runtimes.set(id, null); return null; }   // (A)
//       try { ... } catch { runtimes.set(id, null); return null; }     // (B)
//       finally { inFlight.delete(id); }                               // (C)
//     })();
//     inFlight.set(id, promise);                                       // (D)
//
// Two defects, both already written down elsewhere in this repo:
//
//   1. (A) and (B) memoise an UNPROVEN failure. `runtimes.get(id) !== undefined`
//      then short-circuits every later call, so one early call (or one shard
//      blip inside `ensure_walk_prefetched`) kills that record for the rest of
//      the session. ui/ac_icon_cache.js §P0.4/LEAK-03 ("no authoritative
//      'this does not exist' proof … failures go into a SEPARATE TTL'd map")
//      and ui/ac_layout.js §loadLayout ("**Failures are NOT cached.**") both
//      already reached the opposite conclusion.
//   2. (A) is a SYNCHRONOUS early return inside the async IIFE, so (C) runs
//      before (D) — the delete happens before the set and (D) then pins a
//      settled promise under that id forever.
//
// An AUTHORITATIVE answer (wasm resolved and said "empty"/"no such record")
// is still cached — that is a proof, and re-fetching it would be a retry
// storm. This test locks both halves.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

globalThis.window = { __hbWasm: {} };
globalThis.document = {
  createElement: () => ({ style: {}, getContext: () => null, width: 0, height: 0 }),
};

const u = (f) => "file://" + resolvePath(__dirname, "ui/" + f);
const lod = await import(u("ac_lod.js"));
const pal = await import(u("ac_palette.js"));
const palSet = await import(u("ac_palette_set.js"));
const cloth = await import(u("ac_clothing.js"));
const cmt = await import(u("ac_combat_maneuver.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}

console.log("===========================================================");
console.log("R9 — DAT-runtime loaders: wasm-not-ready stays retryable");
console.log("===========================================================");

// [loader label, load fn, wasm export name, id, success JSON, assert(runtime)]
const CASES = [
  ["ac_lod.loadDegradeInfo", lod.loadDegradeInfo, "fetch_gfx_obj_degrade_info", 0x11000001,
    JSON.stringify({ id: 0x11000001, degrades: [{ gfx_obj_id: 1, degrade_mode: 0, min_dist: 0, ideal_dist: 5, max_dist: 10 }] }),
    (r) => r?.bands?.length === 1],
  ["ac_palette.loadPalette", pal.loadPalette, "fetch_palette", 0x04000001,
    JSON.stringify({ id: 0x04000001, colors: [0xFF112233, 0xFF445566] }),
    (r) => r?.colors?.length === 2],
  ["ac_palette_set.loadPaletteSet", palSet.loadPaletteSet, "fetch_palette_set", 0x0F000001,
    JSON.stringify({ id: 0x0F000001, palettes: [0x04000001, 0x04000002] }),
    (r) => r?.palettes?.length === 2],
  ["ac_clothing.loadClothingTable", cloth.loadClothingTable, "fetch_clothing_table", 0x10000001,
    JSON.stringify({ id: 0x10000001, clothing_base_effects: { "33555000": { clo_object_effects: [] } }, clothing_sub_pal_effects: {} }),
    (r) => r?.clothingBaseEffects?.size === 1],
  ["ac_combat_maneuver.loadCombatManeuverTable", cmt.loadCombatManeuverTable, "fetch_combat_maneuver_table", 0x30000000,
    JSON.stringify({ id: 0x30000000, maneuvers: [{ style: 0x8000003E, attack_height: 2, attack_type: 4, motion: 0x10000001 }] }),
    (r) => r?.maneuvers?.length === 1],
];

for (const [label, loadFn, exportName, id, okJson, assertOk] of CASES) {
  // 1. wasm bridge present but the export missing — the early-boot condition.
  window.__hbWasm = {};
  const first = await loadFn(id);
  check(`${label}: pre-wasm resolves null`, first === null, `got=${first}`);

  // 2. wasm arrives. The loader MUST retry rather than serve the latched null.
  window.__hbWasm = { [exportName]: async () => okJson };
  const second = await loadFn(id);
  check(`${label}: RETRIES once the wasm export lands`, assertOk(second),
    second === null ? "still null (LATCHED)" : JSON.stringify(Object.keys(second ?? {})));

  // 3. and the successful result IS cached — no second wasm call.
  let calls = 0;
  window.__hbWasm = { [exportName]: async () => { calls += 1; return okJson; } };
  await loadFn(id);
  check(`${label}: success is memoised (0 further wasm calls)`, calls === 0, `calls=${calls}`);
}

// 4. Authoritative empty answers are still cached (no retry storm). A palette
//    record that decodes to zero colours is a real DAT answer, not a failure.
{
  let calls = 0;
  window.__hbWasm = {
    fetch_palette: async () => { calls += 1; return JSON.stringify({ id: 0x04009999, colors: [] }); },
  };
  await pal.loadPalette(0x04009999);
  await pal.loadPalette(0x04009999);
  check("authoritative empty palette is cached — exactly one wasm call",
    calls === 1, `calls=${calls}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
