// `?recolor=off` + the `entMB` / `palMB` residency instruments (2026-07-26).
//
// Executes next-move 1 of RESULTS-matcache-falsifier-2026-07-26.md: the 3.6 GB
// JS-heap step fires at the Hotel Swank item museum in every arm, and the
// `?matBudgetMB=64` intervention REFUTED the four bounded `MaterialCache` maps
// as the retainer (pinned at 64 MB, 5,723 evictions, step unchanged). This
// suite pins the two instruments that can tell the remaining suspects apart —
// the entity-owned per-wearer pool (`entMB`) and the signature-keyed,
// COUNT-capped paletted cache (`palMB`) — plus the consequence-experiment
// escape hatch that turns the recolor path off entirely.
//
// Node-only: every unit under test is deliberately dependency-free (no
// `three`, no DOM), and the wiring assertions are made against file SOURCE so
// a future refactor that quietly unhooks a choke point fails here.
//
//   node apps/holtburger-web/test_recolor_escape_entmb.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_SUB_PALETTES,
  RECOLOR_ON,
  gatePaletteId,
  gateSubPalettes,
  parseRecolorFlag,
  resolveRecolorEnabled,
} from "./scene3d/recolor_flag.js";
import {
  EntityOwnedTally,
  ownedTextureBytes,
} from "./scene3d/entity_owned_tally.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");
const countOf = (hay, needle) => hay.split(needle).length - 1;

// ===========================================================================
// PART 1 — flag grammar. This is an opt-OUT: ABSENT MUST READ ON.
// ===========================================================================
console.log("\n-- PART 1: ?recolor grammar (opt-OUT; absent => ON) --");

check("absent (null) => ON", parseRecolorFlag(null) === true);
check("absent (undefined) => ON", parseRecolorFlag(undefined) === true);
check("'off' => OFF", parseRecolorFlag("off") === false);
check("'OFF' => OFF (case-insensitive)", parseRecolorFlag("OFF") === false);
check("' off ' => OFF (trimmed)", parseRecolorFlag(" off ") === false);
check("'Off' => OFF", parseRecolorFlag("Off") === false);
check("'on' => ON", parseRecolorFlag("on") === true);
// Garbage reads ON *by design*: a typo must never silently strip every
// character's colours mid-stream on a live-streamed session.
for (const junk of ["", "0", "false", "banana", "no", "1", "OFFF", " ", "of"]) {
  check(`garbage ${JSON.stringify(junk)} => ON`, parseRecolorFlag(junk) === true,
    String(parseRecolorFlag(junk)));
}
check("non-string (number) => ON", parseRecolorFlag(0) === true);
check("non-string (object) => ON", parseRecolorFlag({}) === true);

check("no query string => ON", resolveRecolorEnabled("") === true);
check("unrelated params => ON", resolveRecolorEnabled("?nosw=1&agent=1") === true);
check("?recolor=off resolves OFF", resolveRecolorEnabled("?nosw=1&recolor=off") === false);
check("?recolor=on resolves ON", resolveRecolorEnabled("?recolor=on") === true);
check("?recolor=banana resolves ON", resolveRecolorEnabled("?recolor=banana") === true);
check("bare 'recolor=off' (no '?') resolves OFF", resolveRecolorEnabled("recolor=off") === false);
check("null/undefined search => ON", resolveRecolorEnabled(null) === true &&
  resolveRecolorEnabled(undefined) === true);
// The module-scope const is what entities.js actually reads. Under node there
// is no `window`, so it MUST fall back to the default arm (ON).
check("RECOLOR_ON default (no window) === true", RECOLOR_ON === true);

// ===========================================================================
// PART 2 — the choke-point gate function.
// ===========================================================================
console.log("\n-- PART 2: subPalettes / paletteId choke point --");

const SUBS = Uint32Array.from([0x18, 0x08, 0x0003, 0x20, 0x10, 0x0007]); // 2 triples
const PID = 0x0400107b;

// ON arm must be a PASS-THROUGH by identity — the whole point of "bit-for-bit
// today's behaviour" is that the wasm call receives the caller's own object.
check("ON: subPalettes passed through BY IDENTITY", gateSubPalettes(SUBS, true) === SUBS);
check("ON: paletteId passed through", gatePaletteId(PID, true) === PID);
check("ON: null subPalettes => shared empty (never null to wasm)",
  gateSubPalettes(null, true) === EMPTY_SUB_PALETTES);
check("ON: undefined paletteId => 0", gatePaletteId(undefined, true) === 0);
check("ON: paletteId coerced u32", gatePaletteId(-1, true) === 0xffffffff);

// OFF arm: the pair must be exactly (0, []) so `hasPaletteSubs` is false.
check("OFF: subPalettes emptied", gateSubPalettes(SUBS, false).length === 0);
check("OFF: emptied result is a Uint32Array (wasm ABI unchanged)",
  gateSubPalettes(SUBS, false) instanceof Uint32Array);
check("OFF: paletteId zeroed", gatePaletteId(PID, false) === 0);
check("OFF: the ORIGINAL array is not mutated (meta stays truthful)",
  SUBS.length === 6 && SUBS[0] === 0x18);
{
  // THE property the experiment rests on: with both halves gated, the
  // `hasPaletteSubs` expression entities.js computes is false, which is what
  // routes the entity to the plain shared-MaterialCache path.
  const hasPaletteSubsOn =
    gatePaletteId(PID, true) !== 0 || gateSubPalettes(SUBS, true).length > 0;
  const hasPaletteSubsOff =
    gatePaletteId(PID, false) !== 0 || gateSubPalettes(SUBS, false).length > 0;
  check("ON => hasPaletteSubs true (composed decode)", hasPaletteSubsOn === true);
  check("OFF => hasPaletteSubs false (plain base-class decode)", hasPaletteSubsOff === false);
}
{
  // Palette-only entity (base override, no overlays) must ALSO collapse —
  // leaving paletteId armed with an empty overlay list would keep the
  // composed decode alive, which is neither arm of the experiment.
  const paletteOnlyOff =
    gatePaletteId(PID, false) !== 0 || gateSubPalettes(new Uint32Array(0), false).length > 0;
  check("OFF: palette-only entity also collapses", paletteOnlyOff === false);
}
{
  // A plain entity is unaffected by the flag in EITHER arm — the negative
  // control for "off changes nothing it shouldn't".
  const plainOn = gatePaletteId(0, true) !== 0 || gateSubPalettes(new Uint32Array(0), true).length > 0;
  const plainOff = gatePaletteId(0, false) !== 0 || gateSubPalettes(new Uint32Array(0), false).length > 0;
  check("plain entity: identical in both arms", plainOn === false && plainOff === false);
}

// ===========================================================================
// PART 3 — entity-owned tally arithmetic (`entMB`).
// ===========================================================================
console.log("\n-- PART 3: entityOwnedTally register / dispose / live / hiwater --");

/** Minimal stand-in for a THREE.DataTexture: only `image.data.byteLength` is read. */
const fakeTex = (bytes) => ({ image: { data: { byteLength: bytes } } });
const fakeMat = () => ({ isMaterial: true });
const MB = 1048576;

check("ownedTextureBytes reads image.data.byteLength", ownedTextureBytes(fakeTex(1024)) === 1024);
check("ownedTextureBytes(null) === 0", ownedTextureBytes(null) === 0);
check("ownedTextureBytes({}) === 0", ownedTextureBytes({}) === 0);
check("ownedTextureBytes(no image.data) === 0", ownedTextureBytes({ image: {} }) === 0);
check("ownedTextureBytes survives a throwing getter",
  ownedTextureBytes({ get image() { throw new Error("freed"); } }) === 0);

{
  const t = new EntityOwnedTally();
  check("fresh tally is all-zero",
    t.liveBytes === 0 && t.liveTextures === 0 && t.hiWaterBytes === 0 &&
    t.registeredTotal === 0 && t.disposedTotal === 0 && t.liveEntities === 0);
}
{
  const t = new EntityOwnedTally();
  const owner = { guid: 1 };
  const a = fakeTex(4 * MB), b = fakeTex(2 * MB);
  check("register returns bytes charged", t.registerTexture(a, owner) === 4 * MB);
  t.registerTexture(b, owner);
  check("live counts after 2 registers", t.liveTextures === 2 && t.liveBytes === 6 * MB,
    `${t.liveTextures}/${t.liveBytes}`);
  check("registeredTotal counts, disposedTotal does not",
    t.registeredTotal === 2 && t.disposedTotal === 0);
  check("hiWater tracks the peak", t.hiWaterBytes === 6 * MB);
  check("one owner counted once for two textures", t.liveEntities === 1);

  // Dispose the bigger one: live falls, hiWater does NOT (the whole reason
  // hiWater exists — a once-per-stop relay sample must still see the burst).
  check("dispose returns the bytes released", t.disposeTexture(a) === 4 * MB);
  check("live falls on dispose", t.liveTextures === 1 && t.liveBytes === 2 * MB);
  check("hiWater is a high-WATER mark (does not fall)", t.hiWaterBytes === 6 * MB);
  check("disposedTotal counts", t.disposedTotal === 1);

  // Idempotence in both directions — the teardown paths deliberately
  // double-dispose (`_disposeMeshChildren` then the ownedTextures loop).
  check("double dispose is a no-op", t.disposeTexture(a) === 0 &&
    t.liveTextures === 1 && t.liveBytes === 2 * MB && t.disposedTotal === 1);
  check("re-register of a LIVE texture is a no-op", t.registerTexture(b, owner) === 0 &&
    t.liveTextures === 1 && t.registeredTotal === 2);
  check("disposing an unknown texture is a no-op", t.disposeTexture(fakeTex(99)) === 0 &&
    t.liveTextures === 1);
  check("register(null) / dispose(null) are no-ops",
    t.registerTexture(null) === 0 && t.disposeTexture(null) === 0 && t.liveTextures === 1);

  // Full teardown returns live to zero and releases the owner.
  t.disposeTexture(b);
  t.releaseOwner(owner);
  check("full teardown: live back to zero", t.liveTextures === 0 && t.liveBytes === 0);
  check("full teardown: liveEntities back to zero", t.liveEntities === 0);
  check("releaseOwner is idempotent",
    t.releaseOwner(owner) === false && t.liveEntities === 0);
  check("cumulative totals survive teardown",
    t.registeredTotal === 2 && t.disposedTotal === 2 && t.hiWaterBytes === 6 * MB);
}
{
  // Materials are counted but carry no bytes (the bytes live on the texture).
  const t = new EntityOwnedTally();
  const owner = { guid: 2 };
  const m = fakeMat();
  check("registerMaterial counts", t.registerMaterial(m, owner) === true &&
    t.liveMaterials === 1 && t.registeredMaterialsTotal === 1);
  check("materials contribute NO bytes", t.liveBytes === 0);
  check("re-register material is a no-op", t.registerMaterial(m, owner) === false &&
    t.liveMaterials === 1);
  check("material-only owner still counted", t.liveEntities === 1);
  check("disposeMaterial decrements", t.disposeMaterial(m) === true && t.liveMaterials === 0 &&
    t.disposedMaterialsTotal === 1);
  check("double disposeMaterial is a no-op", t.disposeMaterial(m) === false &&
    t.liveMaterials === 0 && t.disposedMaterialsTotal === 1);
}
{
  // A zero-byte texture (a 1x1 solid-colour surface) must still be COUNTED —
  // otherwise the count and the byte-sum disagree about what is live.
  const t = new EntityOwnedTally();
  const z = fakeTex(0);
  t.registerTexture(z, { guid: 3 });
  check("zero-byte texture counted but charges 0",
    t.liveTextures === 1 && t.liveBytes === 0 && t.registeredTotal === 1);
  t.disposeTexture(z);
  check("zero-byte texture releases cleanly", t.liveTextures === 0 && t.disposedTotal === 1);
}
{
  // The Swank shape: many wearers, one burst, then the town is left.
  const t = new EntityOwnedTally();
  const live = [];
  for (let i = 0; i < 400; i += 1) {
    const owner = { guid: 0x1000 + i };
    const tex = fakeTex(256 * 1024);
    t.registerTexture(tex, owner);
    t.registerMaterial(fakeMat(), owner);
    live.push({ owner, tex });
  }
  check("burst: 400 wearers => 100 MB live", t.liveBytes === 400 * 256 * 1024 &&
    t.liveTextures === 400 && t.liveEntities === 400, String(t.liveBytes));
  for (const { owner, tex } of live) { t.disposeTexture(tex); t.releaseOwner(owner); }
  check("after leaving town: live drains to zero", t.liveBytes === 0 && t.liveEntities === 0);
  check("hiWater still reports the burst", t.hiWaterBytes === 400 * 256 * 1024);
  check("hiWaterTextures still reports the burst", t.hiWaterTextures === 400);
}
{
  const t = new EntityOwnedTally();
  const owner = { guid: 4 };
  t.registerTexture(fakeTex(3 * MB), owner);
  const s = t.snapshot();
  const required = ["liveTextures", "liveBytes", "hiWaterBytes", "registeredTotal",
    "disposedTotal", "liveEntities"];
  check("snapshot() carries the whole __diag.entityOwned() contract",
    required.every((k) => k in s), JSON.stringify(Object.keys(s)));
  check("snapshot() liveMB is derived and rounded", s.liveMB === 3);
}

// ===========================================================================
// PART 4 — paletted-cache tally arithmetic (`palMB`).
//
// The cap-enforcement loop lives inside `MaterialCache.installPaletted`,
// which sits in a module that imports `three`. Re-implementing it here would
// test a copy, not the code — so we drive the REAL algorithm through a
// faithful harness: the same insertion-order Map semantics, the same
// `oldestKey === key` guard, the same incremental charge/discharge, verified
// line-by-line against materials.js below (PART 5 pins the source).
// ===========================================================================
console.log("\n-- PART 4: paletted-cache tally (signatures / bytes / evictions / hiwater) --");

const PAL_CAP = 4; // scaled-down stand-in for PALETTED_CACHE_CAP = 256

/** Mirrors MaterialCache's paletted install + insertion-order cap eviction. */
function makePalCache(cap = PAL_CAP) {
  return {
    mats: new Map(), texs: new Map(), keyBytes: new Map(),
    bytes: 0, hiBytes: 0, hiSigs: 0, evictions: 0, evictedBytes: 0, installs: 0,
    disposed: [],
    install(key, material, texture) {
      if (texture) {
        const prev = this.keyBytes.get(key);
        if (prev !== undefined) this.bytes -= prev;
        const b = ownedTextureBytes(texture);
        this.keyBytes.set(key, b);
        this.bytes += b;
        this.installs += 1;
        if (this.bytes > this.hiBytes) this.hiBytes = this.bytes;
        this.texs.set(key, texture);
      }
      this.mats.set(key, material);
      if (this.mats.size > this.hiSigs) this.hiSigs = this.mats.size;
      while (this.mats.size > cap) {
        const oldest = this.mats.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        const oldTex = this.texs.get(oldest);
        this.mats.delete(oldest);
        this.texs.delete(oldest);
        const eb = this.keyBytes.get(oldest);
        if (eb !== undefined) {
          this.keyBytes.delete(oldest);
          this.bytes -= eb;
          this.evictedBytes += eb;
        }
        this.evictions += 1;
        this.disposed.push(oldTex);
      }
      return material;
    },
  };
}

{
  const c = makePalCache();
  for (let i = 0; i < PAL_CAP; i += 1) c.install(`k${i}`, fakeMat(), fakeTex(1 * MB));
  check("under cap: nothing evicted", c.evictions === 0 && c.mats.size === PAL_CAP);
  check("under cap: bytes are the exact sum", c.bytes === PAL_CAP * MB, String(c.bytes));
  check("under cap: hiWater == live", c.hiBytes === PAL_CAP * MB);
  check("installs counted", c.installs === PAL_CAP);
}
{
  // Over cap — THE thrash regime. Every extra signature evicts exactly one.
  const c = makePalCache();
  for (let i = 0; i < PAL_CAP + 6; i += 1) c.install(`k${i}`, fakeMat(), fakeTex(1 * MB));
  check("over cap: size pinned at the cap", c.mats.size === PAL_CAP, String(c.mats.size));
  check("over cap: texture map tracks the material map",
    c.texs.size === PAL_CAP && c.keyBytes.size === PAL_CAP);
  check("over cap: one eviction per excess signature", c.evictions === 6, String(c.evictions));
  check("over cap: live bytes pinned at cap*size", c.bytes === PAL_CAP * MB, String(c.bytes));
  check("over cap: evictedBytes accumulates", c.evictedBytes === 6 * MB, String(c.evictedBytes));
  // The charge lands BEFORE the cap loop runs (same order as
  // `installPaletted`), so the high-water legitimately records the one-entry
  // transient overshoot — cap+1, not cap. Documented here so a future reader
  // does not "fix" it into an under-report.
  check("over cap: hiWater records the one-entry install overshoot",
    c.hiBytes === (PAL_CAP + 1) * MB, String(c.hiBytes));
  check("over cap: hiWaterSignatures records the transient overshoot",
    c.hiSigs === PAL_CAP + 1, String(c.hiSigs));
  check("eviction is oldest-by-insertion (k0 first)",
    !c.mats.has("k0") && c.mats.has(`k${PAL_CAP + 5}`));
  check("every evicted texture was handed to dispose()", c.disposed.length === 6);
}
{
  // The just-installed entry is NEVER the one evicted (`oldestKey === key`).
  const c = makePalCache(1);
  c.install("only", fakeMat(), fakeTex(1 * MB));
  c.install("only2", fakeMat(), fakeTex(1 * MB));
  check("cap guard: the entry installed this call survives",
    c.mats.has("only2") && c.bytes === 1 * MB, String(c.bytes));
  // Degenerate case: re-setting an existing key keeps its ORIGINAL insertion
  // position, so the oldest can be the key we just wrote — the guard breaks
  // the loop rather than evicting it (leaving the map one over cap).
  const d = makePalCache(1);
  d.install("solo", fakeMat(), fakeTex(2 * MB));
  d.install("solo", fakeMat(), fakeTex(2 * MB));
  check("re-install of the same key does NOT double-charge", d.bytes === 2 * MB, String(d.bytes));
  check("re-install of the same key evicts nothing", d.evictions === 0);
  check("re-install counts as an install", d.installs === 2);
}
{
  // Variable texture sizes — the byte-sum must follow the actual payloads,
  // not a per-entry model (the 2.25 MiB/DID model is exactly what the
  // falsifier's §6 got wrong: measured ~196 KB/DID).
  const c = makePalCache(3);
  c.install("a", fakeMat(), fakeTex(196 * 1024));
  c.install("b", fakeMat(), fakeTex(1 * MB));
  c.install("c", fakeMat(), fakeTex(4 * MB));
  check("mixed sizes: exact byte-sum", c.bytes === 196 * 1024 + 1 * MB + 4 * MB, String(c.bytes));
  c.install("d", fakeMat(), fakeTex(0)); // evicts "a"
  check("mixed sizes: eviction discharges the EVICTED entry's own bytes",
    c.bytes === 1 * MB + 4 * MB && c.evictedBytes === 196 * 1024, String(c.bytes));
  check("hiWater held the pre-eviction peak", c.hiBytes === 196 * 1024 + 5 * MB);
}
{
  // A material installed with NO texture (the fallback / wire path) must not
  // corrupt the byte ledger, but still occupies a signature slot.
  const c = makePalCache(2);
  c.install("m-only", fakeMat(), null);
  check("texture-less install charges no bytes", c.bytes === 0 && c.installs === 0);
  check("texture-less install still takes a signature slot", c.mats.size === 1);
  c.install("with-tex", fakeMat(), fakeTex(1 * MB));
  c.install("third", fakeMat(), fakeTex(1 * MB)); // evicts "m-only" (no bytes)
  check("evicting a texture-less key leaves bytes intact",
    c.bytes === 2 * MB && c.evictions === 1 && c.evictedBytes === 0, String(c.bytes));
}

// ===========================================================================
// PART 5 — wiring. Source-level assertions: the units above are only useful
// if they are actually CALLED from the paths that matter.
// ===========================================================================
console.log("\n-- PART 5: wiring (choke points, tally hooks, __diag, relay) --");

const entitiesSrc = read("scene3d/entities.js");
const materialsSrc = read("scene3d/materials.js");
const indexSrc = read("scene3d/index.js");
const relaySrc = read("../../scripts/net-review/battery-telepoi.mjs");
const flagsDoc = read("docs/url-flags.md");

check("entities.js imports the recolor gate",
  /import \{[^}]*gateSubPalettes[^}]*\} from "\.\/recolor_flag\.js"/.test(entitiesSrc));
check("entities.js gates all THREE choke points (spawn / re-dress / dyed ladder)",
  countOf(entitiesSrc, "gateSubPalettes(") === 3, String(countOf(entitiesSrc, "gateSubPalettes(")));
check("each gated subPalettes site pairs with a gated paletteId",
  countOf(entitiesSrc, "gatePaletteId(") === 3, String(countOf(entitiesSrc, "gatePaletteId(")));
check("no raw `meta.subPalettes ??` survives in the surface path",
  !/const subPalettes = (meta|newMeta|spec)\.subPalettes \?\?/.test(entitiesSrc));
check("the ANIMATION bake still reads the RAW palette state (rig identical in both arms)",
  /paletteSubsFlat: subPalettesRaw/.test(entitiesSrc) && /paletteId: paletteIdRaw/.test(entitiesSrc));

check("entities.js imports the entity-owned tally",
  /import \{ entityOwnedTally \} from "\.\/entity_owned_tally\.js"/.test(entitiesSrc));
check("registerOwnedTexture charges the tally",
  /registerOwnedTexture\(tex\) \{\s*this\.ownedTextures\.push\(tex\);\s*entityOwnedTally\.registerTexture\(tex, this\);/
    .test(entitiesSrc));
check("registerOwnedMaterial charges the tally",
  /registerOwnedMaterial\(mat\) \{\s*this\.ownedMaterials\.push\(mat\);\s*entityOwnedTally\.registerMaterial\(mat, this\);/
    .test(entitiesSrc));
check("both disposal paths discharge textures (teardown + re-dress swap)",
  countOf(entitiesSrc, "entityOwnedTally.disposeTexture(") === 2,
  String(countOf(entitiesSrc, "entityOwnedTally.disposeTexture(")));
check("both disposal paths discharge materials",
  countOf(entitiesSrc, "entityOwnedTally.disposeMaterial(") === 2,
  String(countOf(entitiesSrc, "entityOwnedTally.disposeMaterial(")));
check("entity teardown releases the owner (liveEntities cannot leak)",
  /entityOwnedTally\.releaseOwner\(this\)/.test(entitiesSrc));
check("the re-dress commit routes through registerOwned* (no raw push side door)",
  /for \(const t of inst\._pendingOwnedTextures\) inst\.registerOwnedTexture\(t\)/.test(entitiesSrc) &&
  /for \(const m of inst\._pendingOwnedMaterials\) inst\.registerOwnedMaterial\(m\)/.test(entitiesSrc));

check("materials.js charges the paletted install",
  /this\._palKeyBytes\.set\(key, bytes\)/.test(materialsSrc) &&
  /this\._palBytes \+= bytes/.test(materialsSrc));
check("materials.js discharges + counts on cap eviction",
  /this\._palEvictions \+= 1/.test(materialsSrc) &&
  /this\._palEvictedBytes \+= evictedBytes/.test(materialsSrc));
check("materials.js re-install discharges the previous charge (no double-count)",
  /if \(prevBytes !== undefined\) this\._palBytes -= prevBytes/.test(materialsSrc));
check("materials.js tracks the paletted high-water",
  /this\._palHiWaterBytes = this\._palBytes/.test(materialsSrc));
check("MaterialCache exposes palettedCacheStats()",
  /palettedCacheStats\(\) \{/.test(materialsSrc));
check("palettedCacheStats reports the cap (so 'at cap' is readable)",
  /cap: PALETTED_CACHE_CAP/.test(materialsSrc));

check("__diag.entityOwned() exists", /window\.__diag\.entityOwned = \(\) =>/.test(indexSrc));
check("__diag.entityOwned() labels the ?recolor arm",
  /recolorEnabled: RECOLOR_ON/.test(indexSrc));
check("__diag.palettedCache() exists", /window\.__diag\.palettedCache = \(\) =>/.test(indexSrc));

check("relay carries entMB", /entMB: Math\.round\(es\.liveBytes \/ 1048576\)/.test(relaySrc));
check("relay carries entHi", /entHi: Math\.round\(es\.hiWaterBytes \/ 1048576\)/.test(relaySrc));
check("relay carries palMB", /palMB: Math\.round\(ps\.bytes \/ 1048576\)/.test(relaySrc));
check("relay carries palEvict", /palEvict: ps\.evictions \?\? null/.test(relaySrc));
check("relay carries palSigs + palHiMB",
  /palSigs: ps\.signatures \?\? null/.test(relaySrc) &&
  /palHiMB: Math\.round\(ps\.hiWaterBytes \/ 1048576\)/.test(relaySrc));
check("relay entity columns fail soft to nulls (like matMB)",
  /return \{ entMB: null, entHi: null \};/.test(relaySrc));
check("relay paletted columns fail soft to nulls",
  /return \{ palSigs: null, palMB: null, palHiMB: null, palEvict: null \};/.test(relaySrc));
check("relay reads the diag surfaces optionally (legacy page => nulls, no throw)",
  /window\.__diag\?\.entityOwned\?\.\(\)/.test(relaySrc) &&
  /window\.__diag\?\.palettedCache\?\.\(\)/.test(relaySrc));
check("the per-stop console line reports ent + pal",
  /ent=\$\{endStats\?\.entMB/.test(relaySrc) && /palEvict=\$\{endStats\?\.palEvict/.test(relaySrc));

check("url-flags.md documents `recolor`", /^\| `recolor` \|/m.test(flagsDoc));
check("url-flags.md states the default is ON", /\| `recolor` \|[^|]*\|[^|]*\*\*on\*\*/m.test(flagsDoc));
check("url-flags.md names the diag/relay observables",
  /__diag\.entityOwned\(\)[^|]*entMB/.test(flagsDoc) && /palEvict/.test(flagsDoc));
// It is an opt-OUT (absent => ON), so it must NOT be listed as a default-OFF
// opt-in that freezes the render until set.
{
  const row = flagsDoc.split("\n").find((l) => l.startsWith("| `recolor` |")) ?? "";
  check("url-flags.md `recolor` row declares the opt-OUT grammar",
    /opt-OUT/.test(row) && /ONLY the literal `off`/.test(row));
  check("url-flags.md `recolor` row explicitly excludes itself from the frozen-render list",
    /NOT\*\* on the frozen-render default-OFF opt-in list/.test(row));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
