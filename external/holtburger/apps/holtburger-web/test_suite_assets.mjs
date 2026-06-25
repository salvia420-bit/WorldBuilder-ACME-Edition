// P4.0b — the per-DID binary-sidecar transport (scene3d/suite_assets.js).
// Locks: INERT-when-unreferenced (the off-trace L-OFF guard); decode-via-registry;
// absent==off/default; fail-soft (a broken endpoint is never re-hammered).

import { SuiteAssetSource, registerSuiteDecoder, _hasSuiteDecoder } from "./scene3d/suite_assets.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0)); // let a resolved fetch promise settle

// ---- INERT when never asked (the off-trace L-OFF invariant) ----
{
  const src = new SuiteAssetSource(); // no wasm, no stub
  check("inert: fetchCount 0 + cacheSize 0 when get() never called",
    src.fetchCount === 0 && src.cacheSize === 0 && src.stats().fetchCount === 0);
}

// ---- decode via the per-type registry ----
await (async () => {
  // a fake codec — never assumes the real windclip byte layout (A01 owns that).
  registerSuiteDecoder("testclip", (bytes) => ({ n: bytes.length, first: bytes[0] }));
  check("registerSuiteDecoder + _hasSuiteDecoder", _hasSuiteDecoder("testclip"));
  const src = new SuiteAssetSource({ fetchImpl: () => Promise.resolve(new Uint8Array([7, 8, 9])) });
  check("first get() returns null (kicks fetch) + counts once",
    src.get(0x02000724, "testclip") === null && src.fetchCount === 1);
  await tick();
  const got = src.get(0x02000724, "testclip");
  check("after settle: decoded artifact cached (decoder ran)", got && got.n === 3 && got.first === 7);
  check("hit accounted; no extra fetch on 2nd get", src.hits === 1 && src.fetchCount === 1);
})();

// ---- no decoder registered ⇒ raw bytes cached ----
await (async () => {
  const src = new SuiteAssetSource({ fetchImpl: () => Promise.resolve(new Uint8Array([1, 2])) });
  src.get(1, "rawtype"); await tick();
  const got = src.get(1, "rawtype");
  check("no decoder ⇒ raw Uint8Array cached", got instanceof Uint8Array && got.length === 2);
})();

// ---- absent (404-equivalent: empty/null bytes) ⇒ off/default, no re-hammer ----
await (async () => {
  const src = new SuiteAssetSource({ fetchImpl: () => Promise.resolve(null) });
  src.get(2, "testclip"); await tick();
  check("absent: get() null + absent counted", src.get(2, "testclip") === null && src.absent === 1);
  src.get(2, "testclip"); await tick();
  check("absent: cached → no re-fetch (fetchCount stays 1)", src.fetchCount === 1);
})();

// ---- fail-soft: a throwing/rejecting fetch caches null, counts an error, never re-hammers ----
await (async () => {
  const src = new SuiteAssetSource({ fetchImpl: () => Promise.reject(new Error("boom")) });
  src.get(3, "testclip"); await tick();
  check("error: get() null + error counted + lastError set",
    src.get(3, "testclip") === null && src.errors === 1 && /boom/.test(src.lastError || ""));
  src.get(3, "testclip"); await tick();
  check("error: cached null → no re-hammer (fetchCount stays 1)", src.fetchCount === 1);
})();

console.log(`\nsuite_assets transport: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
