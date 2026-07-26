// `?palBudgetMB=N` — the paletted (recolored) surface cache's BYTE budget
// (2026-07-26, retail-palette research #1; sibling to test_mat_budget_lru.mjs).
//
// WHY THE LEVER EXISTS. `MaterialCache.palettedMaterials` / `palettedTextures`
// are keyed by outfit SIGNATURE (`did|paletteId|subPalettes`) and were bounded
// by `PALETTED_CACHE_CAP = 256` — a COUNT. They are the one per-surface pool
// `matBudgetMB` structurally cannot see (`_matLru` charges only the four
// per-DID maps), which is why the 2026-07-26 falsifier's `?matBudgetMB=64`
// intervention pinned the wrong maps and the 3.6 GB Swank step survived it.
// A count is the wrong instrument: a dyed 256² surface pins 256 KiB of
// `DataTexture.image.data`, a 512² one 1 MiB, a 64² one 16 KiB — so 256
// signatures is anywhere from 4 MiB to 256 MiB, and the cap both thrashed
// below the byte ceiling and failed to bound the big-surface tail.
//
// This suite pins, in order:
//   1. the flag grammar (absent ⇒ 64 MiB default; `off` ⇒ legacy COUNT cap;
//      garbage/`0`/negative ⇒ the default — a typo must never unbound it)
//   2. evict-to-byte-budget arithmetic: bytes, eviction count, evictedBytes,
//      the one-entry high-water overshoot, and the variable-evictions-per-
//      install behaviour a count cap structurally cannot express
//   3. the invariants that must NOT change: oldest-by-insertion order, the
//      `oldestKey === key` protect-the-just-installed guard, material+paired-
//      owned-texture dispose pairing, and every tally
//   4. LEGACY mode (`off`) preserved bit-for-bit — 256 signatures regardless
//      of bytes
//   5. the uncharged-signature valve (texture-less installs stay bounded)
//   6. `palettedCacheStats()` / relay-column field integrity
//
//   node apps/holtburger-web/test_pal_budget_bytes.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- minimal THREE stub (same shape as test_mat_budget_lru.mjs) -----------
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
});

const {
  MaterialCache,
  parsePalBudgetMB,
  resolvePalBudgetBytes,
  PAL_BUDGET_DEFAULT_MB,
} = materials;

const MB = 1024 * 1024;
const LEGACY_COUNT_CAP = 256;

console.log("?palBudgetMB — paletted-cache byte budget");
console.log("========================================");

// ===========================================================================
// 1. FLAG GRAMMAR
// ===========================================================================
console.log("\n[grammar]");
check("the default is 64 MiB", PAL_BUDGET_DEFAULT_MB === 64, String(PAL_BUDGET_DEFAULT_MB));
check("plain integer parses", parsePalBudgetMB("128") === 128);
check("whitespace tolerated", parsePalBudgetMB("  128 ") === 128);
check("fractional MB kept (0.5 = 512 KiB)", parsePalBudgetMB("0.5") === 0.5);
check("1 is a legal (degenerate) budget", parsePalBudgetMB("1") === 1);

// `off` is the ONE escape — and the ONLY way back to count semantics.
for (const off of ["off", "OFF", "Off", "  off  "]) {
  check(`${JSON.stringify(off)} => legacy count mode`, parsePalBudgetMB(off) === "off",
    String(parsePalBudgetMB(off)));
}
// Absent ⇒ the default. NOT unbounded: this pool was ALWAYS bounded, so
// unbounded-by-default would be a regression.
for (const dflt of [null, undefined]) {
  check(`${String(dflt)} => the ${PAL_BUDGET_DEFAULT_MB} MiB default`,
    parsePalBudgetMB(dflt) === PAL_BUDGET_DEFAULT_MB, String(parsePalBudgetMB(dflt)));
}
// Garbage / zero / negative ⇒ the default. A typo must never silently
// unbound the cache, nor silently drop it back to count semantics.
for (const junk of ["", " ", "0", "0.0", "-4", "abc", "1e6", "NaN", "Infinity",
                    "64MB", "24:64", "+8", "false", "on"]) {
  check(`${JSON.stringify(junk)} => the ${PAL_BUDGET_DEFAULT_MB} MiB default`,
    parsePalBudgetMB(junk) === PAL_BUDGET_DEFAULT_MB, String(parsePalBudgetMB(junk)));
}

console.log("\n[resolve → bytes]");
check("absent => 64 MiB (the default, NOT unbounded, NOT legacy)",
  resolvePalBudgetBytes("") === PAL_BUDGET_DEFAULT_MB * MB,
  String(resolvePalBudgetBytes("")));
check("undefined search => the default",
  resolvePalBudgetBytes(undefined) === PAL_BUDGET_DEFAULT_MB * MB);
check("unrelated params => the default",
  resolvePalBudgetBytes("?nosw=1&agent=1&matBudgetMB=64") === PAL_BUDGET_DEFAULT_MB * MB);
check("resolve: MB → bytes", resolvePalBudgetBytes("?palBudgetMB=8") === 8 * MB);
check("resolve: fractional floors to bytes",
  resolvePalBudgetBytes("?palBudgetMB=0.5") === 512 * 1024);
check("resolve: sub-byte budget floors to 1, never 0 (0 means LEGACY here)",
  resolvePalBudgetBytes("?palBudgetMB=0.0000001") === 1);
check("resolve: leading ? optional", resolvePalBudgetBytes("palBudgetMB=4") === 4 * MB);
check("resolve: co-existing flags don't confuse it",
  resolvePalBudgetBytes("?nosw=1&palBudgetMB=16&nullRender=1") === 16 * MB);
check("=off => 0 (the legacy count-cap sentinel)",
  resolvePalBudgetBytes("?palBudgetMB=off") === 0);
check("garbage value => the default (NOT legacy, NOT unbounded)",
  resolvePalBudgetBytes("?palBudgetMB=lots") === PAL_BUDGET_DEFAULT_MB * MB);
check("=0 => the default", resolvePalBudgetBytes("?palBudgetMB=0") === PAL_BUDGET_DEFAULT_MB * MB);
// The standing footgun: a reader coded `!== "off"` reads ON when absent.
// This reader is an explicit parse, so a near-miss param name cannot arm it.
check("a similarly-named param does NOT change the budget",
  resolvePalBudgetBytes("?palBudget=8&palBudgetMBx=8") === PAL_BUDGET_DEFAULT_MB * MB);

// ===========================================================================
// Harness: install N distinct signatures of a given texture size.
// ===========================================================================
function fakeTex(bytes) { return new StubTexture(new Uint8Array(bytes), 1, bytes); }
function fakeMat() { return new StubMaterial(); }

/** installPaletted(did, paletteId, subPalettes, material, texture). */
function installSig(mc, i, bytes) {
  const mat = fakeMat();
  const tex = bytes === null ? null : fakeTex(bytes);
  mc.installPaletted(i, 0x0400_0000 + i, null, mat, tex);
  return { mat, tex };
}

// ===========================================================================
// 2. EVICT TO THE BYTE BUDGET
// ===========================================================================
console.log("\n[byte budget — arithmetic]");
{
  // 4 MiB budget, 1 MiB per signature. Under budget nothing moves.
  const mc = new MaterialCache({ palBudgetBytes: 4 * MB });
  check("armed in byte mode", mc.palBudgetArmed() === true);
  const e = [];
  for (let i = 0; i < 4; i += 1) e.push(installSig(mc, i, 1 * MB));
  let st = mc.palettedCacheStats();
  check("under budget: nothing evicted", st.evictions === 0 && st.signatures === 4,
    `${st.evictions}/${st.signatures}`);
  check("under budget: bytes are the exact sum", st.bytes === 4 * MB, String(st.bytes));
  check("under budget: hiWater == live", st.hiWaterBytes === 4 * MB);
  check("under budget: installs counted", st.installs === 4, String(st.installs));
  check("under budget: nothing disposed", e.every((x) => x.mat.disposed === 0 && x.tex.disposed === 0));

  // Over budget — one 1 MiB install evicts exactly one 1 MiB signature.
  for (let i = 4; i < 10; i += 1) e.push(installSig(mc, i, 1 * MB));
  st = mc.palettedCacheStats();
  check("over budget: live bytes pinned at the budget", st.bytes === 4 * MB, String(st.bytes));
  check("over budget: signature count follows the BYTES", st.signatures === 4, String(st.signatures));
  check("over budget: texture map tracks the material map",
    mc.palettedTextures.size === 4 && mc._palKeyBytes.size === 4);
  check("over budget: one eviction per excess signature", st.evictions === 6, String(st.evictions));
  check("over budget: evictedBytes accumulates", st.evictedBytes === 6 * MB, String(st.evictedBytes));
  // The charge lands BEFORE the eviction loop (same order as installPaletted),
  // so the high-water legitimately records the one-entry transient overshoot.
  check("over budget: hiWater records the one-entry install overshoot",
    st.hiWaterBytes === 5 * MB, String(st.hiWaterBytes));
  check("over budget: hiWaterSignatures records the transient overshoot",
    st.hiWaterSignatures === 5, String(st.hiWaterSignatures));
  check("eviction is oldest-by-insertion (sig 0 first, sig 9 survives)",
    e[0].mat.disposed === 1 && e[9].mat.disposed === 0 &&
    mc.getCachedPaletted(9, 0x0400_0009, null) === e[9].mat);
  check("each evicted material's PAIRED texture was disposed with it",
    e.slice(0, 6).every((x) => x.mat.disposed === 1 && x.tex.disposed === 1));
  check("no resource disposed more than once",
    e.every((x) => x.mat.disposed <= 1 && x.tex.disposed <= 1));
}

{
  // THE property a count cap structurally cannot express: one big install
  // evicts as many small entries as it takes to get back under budget.
  const mc = new MaterialCache({ palBudgetBytes: 4 * MB });
  const small = [];
  for (let i = 0; i < 3; i += 1) small.push(installSig(mc, i, 1 * MB));
  const big = installSig(mc, 100, 3 * MB); // 3 + 3 = 6 MiB > 4 → evict twice
  const st = mc.palettedCacheStats();
  check("variable evictions per install: 2 smalls fell for 1 big",
    st.evictions === 2, String(st.evictions));
  check("variable evictions: back under budget", st.bytes === 4 * MB, String(st.bytes));
  check("variable evictions: the two OLDEST smalls went",
    small[0].mat.disposed === 1 && small[1].mat.disposed === 1 && small[2].mat.disposed === 0);
  check("variable evictions: the big entry survives (never self-evicted)",
    big.mat.disposed === 0 && mc.getCachedPaletted(100, 0x0400_0064, null) === big.mat);
}

{
  // Protect-the-just-installed: a budget smaller than ONE entry drains the
  // cache down to the entry installed this call, then stops (the
  // `oldestKey === key` guard) — it must NOT spin or empty itself.
  const mc = new MaterialCache({ palBudgetBytes: 1024 }); // 1 KiB
  const a = installSig(mc, 1, 1 * MB);
  const st1 = mc.palettedCacheStats();
  check("tiny budget: the sole entry is kept, not evicted to empty",
    st1.signatures === 1 && st1.evictions === 0 && a.mat.disposed === 0,
    `${st1.signatures}/${st1.evictions}`);
  const b = installSig(mc, 2, 1 * MB);
  const st2 = mc.palettedCacheStats();
  check("tiny budget: the just-installed entry survives, the older one goes",
    st2.signatures === 1 && a.mat.disposed === 1 && b.mat.disposed === 0,
    String(st2.signatures));
  check("tiny budget: still over budget but stable (advisory, like matBudgetMB)",
    st2.bytes === 1 * MB && st2.evictions === 1, `${st2.bytes}/${st2.evictions}`);
}

{
  // Re-installing an existing key REPLACES its charge (no double-count) and
  // never self-evicts, even though a re-set keeps its original Map position
  // (i.e. it can be BOTH the oldest key and the key installed this call).
  const mc = new MaterialCache({ palBudgetBytes: 4 * MB });
  for (let i = 0; i < 3; i += 1) installSig(mc, i, 1 * MB);
  const reMat = fakeMat();
  mc.installPaletted(0, 0x0400_0000, null, reMat, fakeTex(1 * MB));
  const st = mc.palettedCacheStats();
  check("re-install: no double-charge", st.bytes === 3 * MB, String(st.bytes));
  check("re-install: signature count unchanged", st.signatures === 3, String(st.signatures));
  check("re-install: the re-set (and oldest) key is not self-evicted",
    mc.getCachedPaletted(0, 0x0400_0000, null) === reMat && reMat.disposed === 0);
  check("re-install: zero evictions", st.evictions === 0, String(st.evictions));
}

// ===========================================================================
// 3. LEGACY MODE (`?palBudgetMB=off`) — the count cap, bit-for-bit
// ===========================================================================
console.log("\n[legacy count mode (?palBudgetMB=off)]");
{
  const mc = new MaterialCache({ palBudgetBytes: 0 });
  check("not armed in byte mode", mc.palBudgetArmed() === false);
  const e = [];
  const OVER = 44;
  for (let i = 0; i < LEGACY_COUNT_CAP + OVER; i += 1) e.push(installSig(mc, i, 1 * MB));
  const st = mc.palettedCacheStats();
  check("legacy: pinned at 256 SIGNATURES regardless of bytes",
    st.signatures === LEGACY_COUNT_CAP, String(st.signatures));
  check("legacy: bytes are NOT the bound (256 MiB resident, unbudgeted)",
    st.bytes === LEGACY_COUNT_CAP * MB, String(st.bytes));
  check("legacy: one eviction per excess signature", st.evictions === OVER, String(st.evictions));
  check("legacy: eviction is still oldest-by-insertion",
    e[0].mat.disposed === 1 && e[OVER - 1].mat.disposed === 1 && e[OVER].mat.disposed === 0);
  check("legacy: paired textures disposed with their materials",
    e.slice(0, OVER).every((x) => x.tex.disposed === 1));
  check("legacy: stats report the COUNT cap and label the mode",
    st.budgetMode === "count" && st.cap === LEGACY_COUNT_CAP &&
    st.legacyCountCap === LEGACY_COUNT_CAP && st.capMB === null,
    JSON.stringify({ m: st.budgetMode, cap: st.cap, legacy: st.legacyCountCap }));
}

// ===========================================================================
// 4. UNCHARGED-SIGNATURE VALVE — a texture-less install charges 0 bytes
//    forever, so a pure byte budget could never evict it.
// ===========================================================================
console.log("\n[uncharged-signature valve]");
{
  const mc = new MaterialCache({ palBudgetBytes: 64 * MB });
  const e = [];
  for (let i = 0; i < LEGACY_COUNT_CAP + 3; i += 1) e.push(installSig(mc, i, null));
  const st = mc.palettedCacheStats();
  check("texture-less installs stay bounded by the count valve",
    st.signatures === LEGACY_COUNT_CAP, String(st.signatures));
  check("texture-less installs charge zero bytes", st.bytes === 0, String(st.bytes));
  check("texture-less installs are not counted as installs (no texture stored)",
    st.installs === 0, String(st.installs));
  check("texture-less eviction disposes the material, cleanly, oldest-first",
    e[0].mat.disposed === 1 && e[2].mat.disposed === 1 && e[3].mat.disposed === 0);
  // ...and a fully-charged cache is never touched by the valve: every
  // signature is in `_palKeyBytes`, so the uncharged population is 0.
  const mc2 = new MaterialCache({ palBudgetBytes: 1024 * MB });
  for (let i = 0; i < LEGACY_COUNT_CAP + 20; i += 1) installSig(mc2, i, 1024);
  const st2 = mc2.palettedCacheStats();
  check("the valve never evicts CHARGED entries early (276 > 256 survives)",
    st2.signatures === LEGACY_COUNT_CAP + 20 && st2.evictions === 0,
    `${st2.signatures}/${st2.evictions}`);
}

// ===========================================================================
// 4b. REMINT COUNTER — `palRemint`, the churn COST (2026-07-26 museum arm)
// ===========================================================================
// `evictions` counts churn; a signature evicted and never wanted again costs
// nothing. `remints` counts the evictions that were RE-NEEDED — each one is a
// wearer that paid a full decode round-trip (and rendered unrecolored across
// it) for something the cache used to hold. It is the headless proxy for the
// "visual fallback flash" the palBudget decision rule turns on.
console.log("\n[remint counter]");
{
  const mc = new MaterialCache({ palBudgetBytes: 4 * MB });
  for (let i = 0; i < 6; i += 1) installSig(mc, i, 1 * MB);
  const st0 = mc.palettedCacheStats();
  check("evictions happened but nothing was re-needed yet ⇒ remints 0",
    st0.evictions === 2 && st0.remints === 0,
    `${st0.evictions}/${st0.remints}`);
  // Signature 0 was evicted first; asking for it again is the thrash event.
  installSig(mc, 0, 1 * MB);
  const st1 = mc.palettedCacheStats();
  check("re-installing an EVICTED signature counts one remint",
    st1.remints === 1, String(st1.remints));
  // A live key re-installed (the R-8 poisoned-decode replace path) is NOT a
  // remint — nothing was lost, nothing re-decoded from a cache miss.
  const liveKey = mc.palettedMaterials.keys().next().value;
  const liveIdx = Number(String(liveKey).split("|")[0]);
  installSig(mc, liveIdx, 1 * MB);
  check("re-installing a still-LIVE signature is not a remint",
    mc.palettedCacheStats().remints === 1,
    String(mc.palettedCacheStats().remints));
  // Evict→remint→evict→remint counts twice for the same key.
  for (let i = 10; i < 16; i += 1) installSig(mc, i, 1 * MB);
  installSig(mc, 0, 1 * MB);
  check("a second evict→remint cycle for the same key counts again",
    mc.palettedCacheStats().remints === 2,
    String(mc.palettedCacheStats().remints));
  check("the evicted-key ring stays bounded and is reported",
    typeof mc.palettedCacheStats().evictedKeysTracked === "number" &&
    mc.palettedCacheStats().evictedKeysTracked <= 8192,
    String(mc.palettedCacheStats().evictedKeysTracked));
}
{
  // A budget that fits the working set: evictions may still fire, remints must
  // not — this is the shape a correctly-sized default produces.
  const mc = new MaterialCache({ palBudgetBytes: 64 * MB });
  for (let i = 0; i < 40; i += 1) installSig(mc, i, 1 * MB);
  for (let i = 0; i < 40; i += 1) installSig(mc, i, 1 * MB); // second pass: all hits-worth
  const st = mc.palettedCacheStats();
  check("a budget above the working set ⇒ zero remints",
    st.remints === 0 && st.evictions === 0, `${st.remints}/${st.evictions}`);
}

// ===========================================================================
// 5. DIAG SURFACE — `__diag.palettedCache()` and the relay columns
// ===========================================================================
console.log("\n[diag fields]");
{
  const mc = new MaterialCache({ palBudgetBytes: 8 * MB });
  for (let i = 0; i < 12; i += 1) installSig(mc, i, 1 * MB);
  const st = mc.palettedCacheStats();
  // Every field tonight's merge shipped must still be present and typed.
  const required = [
    "signatures", "textures", "cap", "atCap", "bytes", "bytesMB",
    "hiWaterBytes", "hiWaterMB", "hiWaterSignatures", "evictions",
    "evictedBytes", "evictedMB", "installs", "remints", "evictedKeysTracked",
  ];
  check("palettedCacheStats keeps the whole pre-change contract",
    required.every((k) => k in st), JSON.stringify(Object.keys(st)));
  check("new fields present: budgetMode / capMB / legacyCountCap",
    st.budgetMode === "bytes" && "capMB" in st && "legacyCountCap" in st,
    JSON.stringify({ m: st.budgetMode, capMB: st.capMB, l: st.legacyCountCap }));
  check("cap reports the BYTE budget when armed", st.cap === 8 * MB, String(st.cap));
  check("capMB is the same number in MiB", st.capMB === 8, String(st.capMB));
  check("legacyCountCap is null when the byte budget is armed",
    st.legacyCountCap === null, String(st.legacyCountCap));
  check("atCap reads on BYTES when armed", st.atCap === true, String(st.atCap));
  // The relay columns (palMB / palHiMB / palEvict / palSigs) read these four.
  check("relay inputs intact: bytes / hiWaterBytes / evictions / signatures",
    typeof st.bytes === "number" && typeof st.hiWaterBytes === "number" &&
    typeof st.evictions === "number" && typeof st.signatures === "number");
  check("relay palMB arithmetic still lands (8 MiB budget ⇒ 8)",
    Math.round(st.bytes / 1048576) === 8, String(st.bytes));
  check("derived MB fields agree with their byte fields",
    st.bytesMB === +(st.bytes / 1048576).toFixed(2) &&
    st.hiWaterMB === +(st.hiWaterBytes / 1048576).toFixed(2) &&
    st.evictedMB === +(st.evictedBytes / 1048576).toFixed(2));
}

// ===========================================================================
// 6. SOURCE PINS — the invariants that live in code shape, not in behaviour.
// ===========================================================================
console.log("\n[source pins]");
{
  const materialsSrc = readFileSync(resolvePath(__dirname, "scene3d/materials.js"), "utf8");
  const flagsDoc = readFileSync(resolvePath(__dirname, "docs/url-flags.md"), "utf8");
  check("installPaletted's loop condition routes through _palOverBudget()",
    /while \(this\._palOverBudget\(\)\) \{/.test(materialsSrc));
  check("the count cap survives ONLY inside the legacy branch of _palOverBudget",
    /_palOverBudget\(\) \{\s*if \(this\._palBudgetBytes <= 0\) \{\s*return this\.palettedMaterials\.size > PALETTED_CACHE_CAP;/
      .test(materialsSrc));
  check("the byte branch compares _palBytes against the budget",
    /if \(this\._palBytes > this\._palBudgetBytes\) return true;/.test(materialsSrc));
  check("the protect-the-just-installed guard is untouched",
    /if \(oldestKey === undefined \|\| oldestKey === key\) break;/.test(materialsSrc));
  check("the tallies are untouched",
    /this\._palEvictions \+= 1/.test(materialsSrc) &&
    /this\._palEvictedBytes \+= evictedBytes/.test(materialsSrc) &&
    /this\._palHiWaterBytes = this\._palBytes/.test(materialsSrc));
  check("url-flags.md documents `palBudgetMB`", /^\| `palBudgetMB` \|/m.test(flagsDoc));
  {
    const row = flagsDoc.split("\n").find((l) => l.startsWith("| `palBudgetMB` |")) ?? "";
    check("url-flags.md states the 64 MiB default", /\*\*unset = 64 \(MiB\)\*\*/.test(row));
    check("url-flags.md states `off` = the legacy count cap", /`off` = legacy 256-COUNT cap/.test(row));
    check("url-flags.md flags the default as provisional pending the Swank palHiMB rerun",
      /PROVISIONAL/.test(row) && /palHiMB/.test(row));
    check("url-flags.md names the reader chain",
      /parsePalBudgetMB/.test(row) && /_palOverBudget/.test(row));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
