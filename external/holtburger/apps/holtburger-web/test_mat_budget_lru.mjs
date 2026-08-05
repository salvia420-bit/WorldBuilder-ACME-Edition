// `?matBudgetMB=N` — MaterialCache byte-budget LRU + dispose policy, and the
// adapter's proof-gated defensive-copy elision (2026-07-25,
// RESULTS-validation-battery-2026-07-25 next-move 1 / DESIGN-first-bake-
// batches-2026-07-25 §6).
//
// WHY THE LEVER EXISTS. `MaterialCache.materials/textures/normalTextures/
// heightTextures` were keyed by surface DID and never deleted — a monotone
// retainer over "distinct DIDs ever seen", i.e. a function of ROUTE LENGTH.
// Each entry pins ~9 B/px of JS heap through `DataTexture.image.data`
// (RGBA8 + RGBA-padded normal + R8 height). armLong measured `mats` 6 → 479
// → 1,117 → 1,777 → 1,802 with `usedJSHeapSize` stepping to 3,586 MB — a
// renderer OOM against Chrome's ~4 GB limit.
//
// This suite pins, in order:
//   1. the flag grammar (positive-number-only; `off`/`0`/garbage ⇒ unbounded)
//   2. the NEGATIVE CONTROL — absent param ⇒ unbounded ⇒ not one entry ever
//      evicted or disposed, asserted three ways (no param, unrelated params,
//      garbage value) plus a live 200-entry install run
//   3. LRU order and touch-on-get (recency, not insertion order)
//   4. evict-to-budget on BYTES, and the protect-the-just-installed guard
//   5. the dispose policy: never-handed-out ⇒ disposed inline; handed-out ⇒
//      refs dropped but NOT disposed, deferred to `releaseEvictedGpu()`
//   6. byte accounting (image.data byteLength + per-entry overhead, plus the
//      asynchronously-installed animated-frame set)
//   7. the adapter copy elision: unregistered ⇒ copies (bit-for-bit default),
//      registered ⇒ wasm-backed copies, JS-owned passes through
//
//   node apps/holtburger-web/test_mat_budget_lru.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- minimal THREE stub ---------------------------------------------------
// materials.js + adapter.js are loaded as source with their bare imports
// stripped and their dependencies injected, so the suite needs no npm `three`
// (the pattern test_f7_8_surface_bitfield.mjs uses, minus the npm lookup).
class StubMaterial {
  constructor(opts = {}) { Object.assign(this, opts); this.userData = {}; this.disposed = 0; }
  clone() { const c = new StubMaterial(); Object.assign(c, this); c.userData = { ...this.userData }; c.disposed = 0; return c; }
  dispose() { this.disposed += 1; }
}
class StubTexture {
  constructor(data, width, height) { this.image = { data, width, height }; this.userData = {}; this.disposed = 0; }
  dispose() { this.disposed += 1; }
}
const THREE = {
  MeshStandardMaterial: StubMaterial,
  MeshBasicMaterial: StubMaterial,
  DataTexture: StubTexture,
  Color: class { constructor() {} getHSL(o) { return o; } setHSL() { return this; } },
  Vector2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } },
  Vector4: class { constructor() {} },
  Matrix3: class { constructor() {} },
  Matrix4: class { constructor() {} },
  Texture: StubTexture,
  DataArrayTexture: StubTexture,
  CanvasTexture: StubTexture,
  ShaderMaterial: StubMaterial,
  MeshLambertMaterial: StubMaterial,
  MeshPhongMaterial: StubMaterial,
  SpriteMaterial: StubMaterial,
  BufferGeometry: class { constructor() {} setAttribute() {} computeBoundingSphere() {} dispose() {} },
  BufferAttribute: class { constructor(a) { this.array = a; } },
  Group: class { constructor() { this.children = []; } add() {} },
  DoubleSide: 2, FrontSide: 0, BackSide: 1,
  RGBAFormat: 1023, RedFormat: 6403, UnsignedByteType: 1009,
  SRGBColorSpace: "srgb", NoColorSpace: "", LinearFilter: 1006,
  LinearMipmapLinearFilter: 1008, RepeatWrapping: 1000, ClampToEdgeWrapping: 1001,
  NormalBlending: 1, AdditiveBlending: 2, CustomBlending: 5,
  AddEquation: 100, SrcAlphaFactor: 204, OneMinusSrcAlphaFactor: 205, OneFactor: 201,
};

function loadModule(relPath, extraInject = {}) {
  const src = readFileSync(resolvePath(__dirname, relPath), "utf8");
  const patched = src
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    .replace(
      /^\s*import\s+(?:\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+["']\.\/[^"']+["'];?\s*$/gm,
      "",
    )
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\.\/[^"']+["'];?\s*$/gms, "")
    .replace(/^export\s+(?=(?:async\s+function|function|class|const|let|var)\b)/gm, "");
  const names = Object.keys(extraInject);
  const exportsList = (
    patched.match(/^(?:async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm) || []
  ).map((m) => m.replace(/^(?:async\s+function|function|class|const|let|var)\s+/, ""));
  const uniq = [...new Set(exportsList)];
  const factory = new Function(
    "THREE",
    ...names,
    `${patched}\n; return { ${uniq.join(", ")} };`,
  );
  return factory(THREE, ...names.map((n) => extraInject[n]));
}

// adapter.js first — materials.js's surface→texture helpers are injected from it.
const adapter = loadModule("scene3d/adapter.js");
const materials = loadModule("scene3d/materials.js", {
  surfacePixelsToTexture: adapter.surfacePixelsToTexture,
  surfacePixelsToNormalTexture: adapter.surfacePixelsToNormalTexture,
  surfacePixelsToHeightTexture: adapter.surfacePixelsToHeightTexture,
  surfacePixelsToRoughnessTexture: () => null,
  surfacePixelsToAoTexture: () => null,
  materialBakeEnabled: () => false,
  SuiteAssetSource: function SuiteAssetSourceStub() {},
  loadTexchanManifest: async () => null,
  // 2026-08-05: the bc7_textures.js import is stripped like every other relative
  // import, but these three were never injected — so `estimateTextureBytes` blew
  // up with "bc7TextureBytes is not defined" and killed the suite at the byte-
  // accounting section, taking sections 6 and 7 with it. Reproduced on an
  // unmodified checkout, so it predates the budget arming. Stubs return the
  // no-BC7 answers, which is the regime these byte-accounting cases assert.
  bc7Available: () => false,
  bc7TextureBytes: () => 0,
  upgradeMaterialToBc7: () => false,
});

const {
  MaterialCache,
  parseMatBudgetMB,
  resolveMatBudgetBytes,
  estimateTextureBytes,
  estimateMatEntryBytes,
  MAT_ENTRY_OVERHEAD_BYTES,
  MAT_BUDGET_DEFAULT_MB,
} = materials;

console.log("?matBudgetMB — MaterialCache byte-budget LRU");
console.log("=========================================");

// ---- 1. flag grammar ------------------------------------------------------
console.log("\n[grammar]");
check("plain integer parses", parseMatBudgetMB("512") === 512);
check("whitespace tolerated", parseMatBudgetMB("  512 ") === 512);
check("fractional MB kept (0.5 = 512 KiB)", parseMatBudgetMB("0.5") === 0.5);
check("1 is a legal (degenerate) budget", parseMatBudgetMB("1") === 1);
for (const off of [null, undefined, "", " ", "off", "OFF", "false", "0", "0.0",
                   "-4", "abc", "1e6", "NaN", "Infinity", "512MB", "24:64", "+8"]) {
  check(`${JSON.stringify(off)} => 0 (unbounded)`, parseMatBudgetMB(off) === 0,
    String(parseMatBudgetMB(off)));
}
check("resolve: MB → bytes", resolveMatBudgetBytes("?matBudgetMB=8") === 8 * 1024 * 1024);
check("resolve: fractional floors to bytes",
  resolveMatBudgetBytes("?matBudgetMB=0.5") === 512 * 1024);
check("resolve: sub-byte budget floors to 1, never 0",
  resolveMatBudgetBytes("?matBudgetMB=0.0000001") === 1);
check("resolve: leading ? optional",
  resolveMatBudgetBytes("matBudgetMB=4") === 4 * 1024 * 1024);
check("resolve: co-existing flags don't confuse it",
  resolveMatBudgetBytes("?nosw=1&matBudgetMB=16&nullRender=1") === 16 * 1024 * 1024);

// ---- 2. DEFAULT ARMED 2026-08-05 + the explicit unbounded escape ----------
// Was "absent ⇒ unbounded". The default is now ARMED (see MAT_BUDGET_DEFAULT_MB
// in materials.js for the crash + heap-snapshot evidence), so absent means the
// default and ONLY `off`/`0` disarms it.
const DEFAULT_BYTES = MAT_BUDGET_DEFAULT_MB * 1024 * 1024;
console.log("\n[default armed — absent ⇒ default, explicit off ⇒ unbounded]");
check("no query string => default", resolveMatBudgetBytes("") === DEFAULT_BYTES);
check("undefined search => default", resolveMatBudgetBytes(undefined) === DEFAULT_BYTES);
check("unrelated params => default",
  resolveMatBudgetBytes("?nosw=1&agent=1&nullRender=1&surfaceBudgetMB=24:64") === DEFAULT_BYTES);
// Deliberate change of grammar: a typo must NOT silently uncap memory.
check("garbage value => default (a typo must not disarm the cap)",
  resolveMatBudgetBytes("?matBudgetMB=lots") === DEFAULT_BYTES);
check("=off => 0 (unbounded escape)", resolveMatBudgetBytes("?matBudgetMB=off") === 0);
check("=OFF is case-insensitive", resolveMatBudgetBytes("?matBudgetMB=OFF") === 0);
check("=0 => 0 (unbounded escape)", resolveMatBudgetBytes("?matBudgetMB=0") === 0);
// The footgun this guards: a reader coded `!== "off"` reads ON when absent.
check("a similarly-named param does NOT override the default",
  resolveMatBudgetBytes("?matBudget=64&matBudgetMBx=64") === DEFAULT_BYTES);
// The pure token parser keeps its original grammar (0 = "no explicit budget").
check("parser itself still maps absent/off/garbage to 0",
  parseMatBudgetMB(null) === 0 && parseMatBudgetMB("off") === 0 && parseMatBudgetMB("lots") === 0);

/** Build a stub entry: mat + three planes of the given pixel dimensions. */
function makeEntry(px) {
  return {
    mat: new StubMaterial(),
    tex: new StubTexture(new Uint8Array(px * 4), 1, px),
    normalTex: new StubTexture(new Uint8Array(px * 4), 1, px),
    heightTex: new StubTexture(new Uint8Array(px), 1, px),
  };
}
const ENTRY_PX = 1024; // 1024*(4+4+1) = 9216 B + 64 overhead = 9280 B/entry
const ENTRY_BYTES = ENTRY_PX * 9 + MAT_ENTRY_OVERHEAD_BYTES;

function install(mc, did, px = ENTRY_PX) {
  const e = makeEntry(px);
  mc._installCacheEntry(did, e.mat, e.tex, e.normalTex, e.heightTex);
  return e;
}

// A cache with NO location at all (node) and one under an unrelated query.
{
  const mc = new MaterialCache();
  check("no window => unbounded", mc.matBudgetArmed() === false);
  const entries = [];
  for (let i = 0; i < 200; i += 1) entries.push(install(mc, 0x08000000 + i));
  const st = mc.materialCacheStats();
  check("unbounded: every entry stays resident", st.entries === 200, String(st.entries));
  check("unbounded: zero evictions", st.evictions === 0, String(st.evictions));
  check("unbounded: zero disposals",
    st.disposedImmediate === 0 && st.deferredDisposals === 0);
  check("unbounded: nothing was disposed for real",
    entries.every((e) => e.mat.disposed === 0 && e.tex.disposed === 0));
  check("unbounded: budgetBytes 0 / budgetMB null",
    st.budgetBytes === 0 && st.budgetMB === null && st.armed === false);
  // Unarmed also short-circuits the hot-path bookkeeping (perf-neutral, not
  // just behaviour-neutral): no recency shuffling, no hand-out set growth.
  const orderBefore = JSON.stringify([...mc._matLru.keys()]);
  mc.getCached(0x08000000);
  mc._touchMatEntry(0x08000005);
  check("unbounded: getCached/touch do not reorder the LRU",
    JSON.stringify([...mc._matLru.keys()]) === orderBefore);
  check("unbounded: the hand-out set stays empty",
    mc.materialCacheStats().handedOut === 0);
  check("unbounded: bytes are still accounted (sizing data for the arm)",
    st.bytes === 200 * ENTRY_BYTES, String(st.bytes));
}
{
  const prevWindow = globalThis.window;
  globalThis.window = { location: { search: "?nosw=1&nullRender=1&agent=1" } };
  const mc = new MaterialCache();
  // Was "unrelated query string => unbounded". Since the 2026-08-05 arming an
  // unrelated query string arms the DEFAULT; only the explicit escape disarms.
  check("unrelated query string => armed at the default",
    mc.matBudgetArmed() === true
    && mc._matBudgetBytes === MAT_BUDGET_DEFAULT_MB * 1024 * 1024);
  globalThis.window = { location: { search: "?matBudgetMB=off" } };
  check("?matBudgetMB=off => unbounded", new MaterialCache().matBudgetArmed() === false);
  globalThis.window = { location: { search: "?matBudgetMB=2" } };
  const armed = new MaterialCache();
  check("?matBudgetMB=2 arms from the URL",
    armed.matBudgetArmed() === true && armed._matBudgetBytes === 2 * 1024 * 1024);
  if (prevWindow === undefined) delete globalThis.window;
  else globalThis.window = prevWindow;
}

// ---- 3. LRU order + touch-on-get -----------------------------------------
console.log("\n[LRU order + touch]");
{
  const mc = new MaterialCache({ matBudgetBytes: 1 << 30 }); // armed but roomy
  for (const did of [1, 2, 3, 4]) install(mc, did);
  check("insert order is the initial LRU order",
    JSON.stringify([...mc._matLru.keys()]) === "[1,2,3,4]");
  mc.getCached(1);
  check("getCached(1) moves 1 to most-recent",
    JSON.stringify([...mc._matLru.keys()]) === "[2,3,4,1]");
  mc._touchMatEntry(3);
  check("touch(3) moves 3 to most-recent",
    JSON.stringify([...mc._matLru.keys()]) === "[2,4,1,3]");
  mc._touchMatEntry(999);
  check("touch of a non-resident DID is a no-op",
    JSON.stringify([...mc._matLru.keys()]) === "[2,4,1,3]");
  install(mc, 2); // re-install of an existing DID
  check("re-install moves the DID to most-recent",
    JSON.stringify([...mc._matLru.keys()]) === "[4,1,3,2]");
  check("re-install does not double-count its bytes",
    mc._matLruBytes === 4 * ENTRY_BYTES, String(mc._matLruBytes));
}

// ---- 4. evict-to-budget (bytes) ------------------------------------------
console.log("\n[evict to budget]");
{
  // Budget = 3.5 entries. Installing 10 must leave ≤ 3 resident.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 3.5) });
  for (let i = 1; i <= 10; i += 1) install(mc, i);
  const st = mc.materialCacheStats();
  check("bytes held <= budget", st.bytes <= st.budgetBytes, `${st.bytes} > ${st.budgetBytes}`);
  check("evictions fired", st.evictions === 7, String(st.evictions));
  check("the newest DIDs survive (recency, not insertion order)",
    JSON.stringify([...mc._matLru.keys()]) === "[8,9,10]");
  check("all four base maps shrank together",
    mc.materials.size === 3 && mc.textures.size === 3 &&
    mc.normalTextures.size === 3 && mc.heightTextures.size === 3);
  check("evictedBytes accounts for what left", st.evictedBytes === 7 * ENTRY_BYTES);
}
{
  // Touch changes WHO gets evicted.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 2.5) });
  install(mc, 1); install(mc, 2);
  mc.getCached(1);            // 1 is now newer than 2
  install(mc, 3);             // over budget → evicts the LRU, which is 2
  check("touch-on-get protects the touched DID",
    mc.materials.has(1) && !mc.materials.has(2) && mc.materials.has(3));
}
{
  // A single entry larger than the whole budget must not evict itself into
  // an empty cache (the `size > 1` floor) — it stays resident and over.
  const mc = new MaterialCache({ matBudgetBytes: 1024 });
  install(mc, 42);
  check("a lone over-budget entry stays resident (advisory cap)",
    mc.materials.has(42) && mc.materialCacheStats().bytes > 1024);
  install(mc, 43);
  check("the just-installed entry is never the one evicted",
    mc.materials.has(43), "protect-guard broke");
}
{
  // Budget bigger than the working set never evicts.
  const mc = new MaterialCache({ matBudgetBytes: ENTRY_BYTES * 100 });
  for (let i = 0; i < 50; i += 1) install(mc, i);
  check("budget above the working set => zero evictions",
    mc.materialCacheStats().evictions === 0);
}

// ---- 5. dispose policy ----------------------------------------------------
console.log("\n[dispose policy]");
{
  // Never handed out ⇒ provably unreferenced ⇒ disposed inline.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 1.5) });
  const a = install(mc, 1);
  install(mc, 2); // evicts 1
  check("never-handed-out entry is evicted", !mc.materials.has(1));
  check("never-handed-out material disposed inline", a.mat.disposed === 1);
  check("never-handed-out planes disposed inline",
    a.tex.disposed === 1 && a.normalTex.disposed === 1 && a.heightTex.disposed === 1);
  check("counted as an immediate disposal",
    mc.materialCacheStats().disposedImmediate === 1);
  check("graveyard stays empty", mc.materialCacheStats().graveyard === 0);
}
{
  // Handed out ⇒ a live mesh may hold it ⇒ refs dropped, dispose DEFERRED.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 1.5) });
  const a = install(mc, 1);
  const handed = mc.getCached(1);           // the render path took it
  check("getCached handed back the cached material", handed === a.mat);
  install(mc, 2);                           // still over budget → evicts 1
  check("handed-out entry is still evicted (refs dropped)", !mc.materials.has(1));
  check("handed-out material NOT disposed inline", a.mat.disposed === 0);
  check("handed-out planes NOT disposed inline",
    a.tex.disposed === 0 && a.normalTex.disposed === 0 && a.heightTex.disposed === 0);
  const st = mc.materialCacheStats();
  check("counted as a deferred disposal",
    st.deferredDisposals === 1 && st.disposedImmediate === 0);
  check("graveyard holds the four objects weakly", st.graveyard === 4, String(st.graveyard));
  const n = mc.releaseEvictedGpu();
  check("releaseEvictedGpu disposes them", n === 4, String(n));
  check("…and they really were disposed",
    a.mat.disposed === 1 && a.tex.disposed === 1 &&
    a.normalTex.disposed === 1 && a.heightTex.disposed === 1);
  check("graveyard drained", mc.materialCacheStats().graveyard === 0);
  check("second release is a no-op", mc.releaseEvictedGpu() === 0);
}
{
  // Derived per-DID clones must go with their base.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 1.5) });
  install(mc, 1);
  mc.getCached(1, false);          // mints a FrontSide clone
  mc.getCachedFloorBias(1);        // mints a floor-bias clone
  mc.getCachedStaticBias(1);       // mints a static-bias clone
  check("clones exist before eviction",
    mc.frontSideMaterials.has(1) && mc.floorBiasMaterials.has(1) &&
    mc.staticBiasMaterials.has(1));
  install(mc, 2);
  check("evicting the base drops every derived clone",
    !mc.frontSideMaterials.has(1) && !mc.floorBiasMaterials.has(1) &&
    !mc.staticBiasMaterials.has(1));
}
{
  // A throwing dispose() must never abort the eviction.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 1.5) });
  const e = makeEntry(ENTRY_PX);
  e.mat.dispose = () => { throw new Error("boom"); };
  mc._installCacheEntry(1, e.mat, e.tex, e.normalTex, e.heightTex);
  let threw = false;
  try { install(mc, 2); } catch (_) { threw = true; }
  check("a throwing dispose is fail-soft", !threw && !mc.materials.has(1));
  check("…and the siblings still got disposed", e.tex.disposed === 1);
}
{
  // Page teardown still disposes everything and drains the deferred list.
  const mc = new MaterialCache({ matBudgetBytes: Math.floor(ENTRY_BYTES * 1.5) });
  const a = install(mc, 1);
  mc.getCached(1);
  install(mc, 2);                  // 1 → graveyard
  mc.dispose();
  check("dispose() drains the graveyard", a.mat.disposed === 1);
  check("dispose() resets the byte accounting",
    mc._matLruBytes === 0 && mc._matLru.size === 0);
  check("dispose() keeps the cumulative counters",
    mc.materialCacheStats().evictions === 1);
}

// ---- 6. byte accounting ---------------------------------------------------
console.log("\n[byte accounting]");
{
  check("estimateTextureBytes reads image.data.byteLength",
    estimateTextureBytes(new StubTexture(new Uint8Array(4096), 32, 32)) === 4096);
  check("estimateTextureBytes(null) === 0", estimateTextureBytes(null) === 0);
  check("estimateTextureBytes of a texture with no image === 0",
    estimateTextureBytes({}) === 0);
  const t = new StubTexture(new Uint8Array(100), 1, 1);
  const n = new StubTexture(new Uint8Array(100), 1, 1);
  const h = new StubTexture(new Uint8Array(25), 1, 1);
  check("entry bytes = albedo + normal + height + overhead",
    estimateMatEntryBytes(t, n, h) === 225 + MAT_ENTRY_OVERHEAD_BYTES);
  check("missing normal/height planes are simply 0",
    estimateMatEntryBytes(t, null, null) === 100 + MAT_ENTRY_OVERHEAD_BYTES);
  // A 512² surface: RGBA8 + RGBA-padded normal + R8 height = 9 B/px.
  const px = 512 * 512;
  const big = estimateMatEntryBytes(
    new StubTexture(new Uint8Array(px * 4), 512, 512),
    new StubTexture(new Uint8Array(px * 4), 512, 512),
    new StubTexture(new Uint8Array(px), 512, 512),
  );
  check("512² surface ≈ 2.25 MiB (the 9 B/px shape)",
    Math.abs(big / (1024 * 1024) - 2.25) < 0.001, (big / 1048576).toFixed(3));
}
{
  // Asynchronously-installed animated frames are charged to their DID.
  const mc = new MaterialCache({ matBudgetBytes: 1 << 30 });
  install(mc, 7);
  const before = mc.materialCacheStats().bytes;
  mc._addMatEntryBytes(7, 4 * 4096);
  check("animated frames add to the entry's size",
    mc.materialCacheStats().bytes === before + 16384);
  check("…without changing recency", [...mc._matLru.keys()].at(-1) === 7);
  mc._addMatEntryBytes(7, 0);
  mc._addMatEntryBytes(7, -5);
  mc._addMatEntryBytes(404, 9999);
  check("non-positive deltas and unknown DIDs are ignored",
    mc.materialCacheStats().bytes === before + 16384);
}
{
  // The stats surface the falsifier rerun reads.
  const mc = new MaterialCache({ matBudgetBytes: ENTRY_BYTES * 4 });
  for (let i = 0; i < 10; i += 1) install(mc, i);
  const st = mc.materialCacheStats();
  for (const k of ["entries", "bytes", "bytesMB", "budgetBytes", "budgetMB",
                   "armed", "evictions", "evictedBytes", "disposedImmediate",
                   "deferredDisposals", "graveyard", "handedOut", "lruEntries",
                   "textures", "normalTextures", "heightTextures"]) {
    check(`__diag.materialCache() exposes ${k}`, k in st);
  }
  check("entries == lruEntries (maps and LRU never drift)",
    st.entries === st.lruEntries && st.entries === st.textures);
  check("stats report the armed cap", st.armed === true && st.budgetBytes === ENTRY_BYTES * 4);
  check("mats bounded at the cap", st.entries <= 4, String(st.entries));
}

// ---- 7. adapter defensive-copy elision -----------------------------------
console.log("\n[adapter copy elision]");
{
  const { surfacePixelsToTexture, setAdapterWasmMemory, isWasmBackedBuffer } = adapter;
  const px = new Uint8Array(4 * 4 * 4); px[0] = 7;

  // Unregistered: cannot prove anything ⇒ copy, exactly as before.
  setAdapterWasmMemory(null);
  check("unregistered => every buffer is treated as wasm-backed",
    isWasmBackedBuffer(px.buffer) === true);
  const t0 = surfacePixelsToTexture(px, 4, 4);
  check("unregistered => texture owns a COPY (default-neutral)",
    t0.image.data !== px && t0.image.data[0] === 7);

  // Registered: a view into the registered memory still copies…
  const mem = new WebAssembly.Memory({ initial: 1 });
  setAdapterWasmMemory(mem);
  const wasmView = new Uint8Array(mem.buffer, 0, 4 * 4 * 4);
  wasmView[0] = 9;
  check("registered => a view into wasm memory IS wasm-backed",
    isWasmBackedBuffer(mem.buffer) === true);
  const t1 = surfacePixelsToTexture(wasmView, 4, 4);
  check("registered => a wasm-backed view is still copied",
    t1.image.data !== wasmView && t1.image.data[0] === 9);

  // …while a JS-owned buffer (worker-transferred, or a `.slice()`d getter)
  // passes straight through — the elision this follow-on buys.
  check("registered => a JS-owned buffer is provably not wasm-backed",
    isWasmBackedBuffer(px.buffer) === false);
  const t2 = surfacePixelsToTexture(px, 4, 4);
  check("registered => JS-owned pixels are NOT copied", t2.image.data === px);

  // Partial views never elide (they would alias bytes another view owns).
  const shared = new Uint8Array(256);
  const partial = shared.subarray(0, 64);
  const t3 = surfacePixelsToTexture(partial, 4, 4);
  check("a partial view is copied even when JS-owned", t3.image.data !== partial);

  // SharedArrayBuffer (threaded pkg) always counts as unsafe.
  if (typeof SharedArrayBuffer !== "undefined") {
    const sab = new SharedArrayBuffer(64);
    check("SharedArrayBuffer is always treated as wasm-backed",
      isWasmBackedBuffer(sab) === true);
  }

  // Height plane: same gate, and the exact-length requirement.
  const h = new Uint8Array(16);
  const t4 = adapter.surfacePixelsToHeightTexture(h, 4, 4);
  check("registered => JS-owned height plane is not copied", t4.image.data === h);
  const hLong = new Uint8Array(64);
  const t5 = adapter.surfacePixelsToHeightTexture(hLong, 4, 4);
  check("an over-long height plane is copied and trimmed",
    t5.image.data !== hLong && t5.image.data.byteLength === 16);

  setAdapterWasmMemory(null);
  const t6 = surfacePixelsToTexture(px, 4, 4);
  check("un-registering restores unconditional copying", t6.image.data !== px);
}

console.log("\n=========================================");
console.log(`passed: ${passed}  failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
