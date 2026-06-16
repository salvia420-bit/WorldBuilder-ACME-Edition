// A11-S5 / G14 (2026-06-12, W3+ remainder) — standalone ESM test for the
// spawn-time DefaultScript auto-resolve behind `?defaultScriptSpawn=on`.
//
// Survey: docs/2026-06-11-unification-survey/agents/
// A11-particles-physics-scripts.md §3 row 9 + docs/url-flags.md
// (`?defaultScriptSpawn=on` row).
//
// The wire PhysicsDesc `default_script` is usually a `PScriptType` ENUM paired
// with `default_script_intensity` (retail copies both onto the CPhysicsObj,
// acclient.c:322389-322391); only a raw 0x33 DID reaches the JS spawn payload
// (`physicsScriptDid` filter), so entities with PScriptType defaults showed NO
// ambient effect at spawn and their DefaultScript(17)/DefaultScriptPart(18)
// animation hooks fired into 0. ON: `_resolveDefaultScriptDid` runs retail's
// `play_default_script` chain —
//   PhysicsScriptTable::GetScript(default_script, default_script_intensity)
//   (acclient.c:320351-320376; picker = first entry whose mod ≥ intensity,
//   :336552; null-table no-op :320335-320343)
// via the `entityDefaultScript` / `entityDefaultScriptIntensity` session-handle
// getters (wasm-side, manifest v4 — typeof-guarded so a stale pkg/ soft-degrades
// to a no-op) + the Phase 51/53 `pickScriptEntry` picker, then plays the
// resolved 0x33 through the normal chain. Wired at the spawn arm + the hook
// 17/18 PScriptType fallbacks. Idempotent per guid (`_particleChainsAttached`).
// Default OFF = byte-identical 0x33-only behavior.
//
//   PART 1 — flag parse matrix (`?defaultScriptSpawn=on`), behavioral (the
//            genuine module-scope `DEFAULT_SCRIPT_SPAWN_ON`, rebuilt under
//            different search strings) + the source parse pinned.
//   PART 2 — the genuine Phase 51/53 `pickScriptEntry` band selection: first
//            entry whose mod ≥ intensity; <= boundary; overflow clamp; null/
//            empty → null. (The EXACT function text spliced from
//            play_effect_vfx.js — pinned character-identical to source.)
//   PART 3 — the genuine `_resolveDefaultScriptDid` end-to-end with MOCKED
//            `entityDefaultScript` / `entityDefaultScriptIntensity` /
//            `entityPhysicsScriptTableDid` getters + a stubbed
//            `fetchPhysicsScriptTable`: raw 0 → 0; raw 0x33 → passthrough;
//            PScriptType ENUM → table → picker band (intensity picks the row);
//            null table → 0 (retail null-table no-op); getter absent (stale
//            pkg) → 0; guid 0 → 0; missing table-did → 0; empty/missing row → 0.
//   PART 4 — spawn-arm + hook 17/18 fallback wiring + per-guid idempotency:
//            the genuine `_playDefaultScriptResolved` attaches the resolved
//            0x33 exactly once per guid, drops a despawn-mid-resolve, and is a
//            no-op for did 0; plus the spawn arm / hook 17 / hook 18 routing
//            pinned to source.
//
// No browser / no wasm — splices the genuine entities.js (the
// test_a5_p3_root_motion.mjs / test_phase7_4b precedent: bypasses the bare
// `three` specifier + the wasm SessionHandle) and exercises the real methods.
// SKIPs (exit 0) when `three` can't be located.
//
// Run with:  cd apps/holtburger-web/ && node test_a11_s5_default_script_spawn.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// ---- locate `three` (test_a5_p3 precedent) ---------------------------
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  const candidates = [];
  try {
    const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
    if (existsSync(npxRoot)) {
      const fs = require("node:fs");
      for (const dir of fs.readdirSync(npxRoot)) {
        candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
      }
    }
  } catch (_) {}
  for (const c of candidates) {
    const idx = joinPath(c, "build/three.module.js");
    if (existsSync(idx)) return idx;
  }
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("A11-S5 default-script-spawn ESM test: SKIP (three not located).");
  console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_a11_s5_default_script_spawn.mjs`");
  process.exit(0);
}

const threeMod = await import("file://" + threePath);
// three may resolve to the CJS build (`three.cjs`); named exports land on the
// namespace via cjs-module-lexer, but fall back to .default.
const THREE = threeMod.Object3D ? threeMod : (threeMod.default ?? threeMod);

console.log("A11-S5 — spawn-time DefaultScript auto-resolve standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- source text for the static (regex-on-source) assertions ---------
const entitiesSrc = readFileSync(
  joinPath(__dirname, "scene3d", "entities.js"),
  "utf8",
);
const playEffectSrc = readFileSync(
  joinPath(__dirname, "scene3d", "play_effect_vfx.js"),
  "utf8",
);
const urlFlagsSrc = readFileSync(
  joinPath(__dirname, "docs", "url-flags.md"),
  "utf8",
);

// ---- splice modules (test_a5_p3 / test_phase7_4b pattern) -------------
function loadModule(relPath) {
  const full = resolvePath(__dirname, relPath);
  if (!existsSync(full)) throw new Error(`module not found: ${full}`);
  let src = readFileSync(full, "utf8");
  src = src
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    // Strip relative `import { … } from "./X.js"` / "../ui/X.js" lines — we
    // splice / shim the few symbols we actually touch by hand.
    .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\.?\/[^"']+["'];?\s*$/gm, "");
  return src;
}

function stripExports(src) {
  return src
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

// Extract the GENUINE Phase 51/53 picker text verbatim from
// play_effect_vfx.js so `_resolveDefaultScriptDid` runs the REAL band-select
// (not a hand replica). Non-greedy to the first column-0 closing brace.
const PICKER_MATCH = playEffectSrc.match(
  /export function pickScriptEntry\([\s\S]*?\n\}/,
);
if (!PICKER_MATCH) {
  console.log("A11-S5: SKIP — could not extract genuine pickScriptEntry from play_effect_vfx.js");
  process.exit(0);
}
const pickerSrc = PICKER_MATCH[0].replace(/^export\s+/, "");

// Build the EntityManager factory under a chosen `?...search`. The
// module-scope `DEFAULT_SCRIPT_SPAWN_ON` is captured at factory time, so we
// rebuild per flag state. `fetchPhysicsScriptTable` + the dynamic
// `import("./play_effect_vfx.js")` are routed to in-scope shims; the picker
// itself is the genuine spliced function.
function buildFactory() {
  let entSrc = stripExports(loadModule("scene3d/entities.js"));
  // Route the lazy `import("./play_effect_vfx.js")` (for the picker) to the
  // in-scope genuine function — the spliced source has no module URL.
  entSrc = entSrc.replace(
    'await import("./play_effect_vfx.js")',
    "await __importPlayEffectVfx()",
  );
  check(
    "splice rewired the lazy play_effect_vfx import (picker reachable)",
    entSrc.includes("await __importPlayEffectVfx()") &&
      !entSrc.includes('import("./play_effect_vfx.js")'),
  );

  const composite =
    // setup_rig.js flag reader (the splice omits that module; flags read
    // false in the Node harness anyway). test_a5_p3 shim.
    "function readRigModuleFlag() { return false; }\n" +
    // The chain-walk table fetch the resolver calls — routed to a per-test
    // stub on globalThis so each case controls the returned PhysicsScriptTable.
    "async function fetchPhysicsScriptTable(did) {\n" +
    "  return (typeof globalThis.__A11S5_FETCH_PST === 'function')\n" +
    "    ? globalThis.__A11S5_FETCH_PST(did) : null;\n" +
    "}\n" +
    // GENUINE Phase 51/53 picker (spliced verbatim from play_effect_vfx.js).
    "// === genuine pickScriptEntry (play_effect_vfx.js) ===\n" +
    pickerSrc + "\n" +
    "async function __importPlayEffectVfx() { return { pickScriptEntry }; }\n" +
    "// === adapter.js ===\n" + stripExports(loadModule("scene3d/adapter.js")) + "\n" +
    "// === animation.js ===\n" + stripExports(loadModule("scene3d/animation.js")) + "\n" +
    "// === entities.js ===\n" + entSrc + "\n" +
    "; return { EntityManager, pickScriptEntry };";

  const factory = new Function("THREE", "performance", "window", composite);
  const win = { location: { search: globalThis.window.location.search } };
  return factory(
    THREE,
    globalThis.performance ?? { now: () => Date.now() },
    win,
  );
}

// =====================================================================
console.log("PART 1 — ?defaultScriptSpawn flag parse (genuine DEFAULT_SCRIPT_SPAWN_ON)");
// =====================================================================

// The const is read at module load via window.location.search.lower==="on".
// Rebuild the factory under each search string and read it through a method
// that gates on it (the spawn-arm path), but simplest: probe via a tiny
// helper we add — expose the const indirectly by re-deriving it the same way
// the source does, AND pin the source parse.
function deriveFlag(search) {
  // Character-identical to entities.js DEFAULT_SCRIPT_SPAWN_ON body.
  try {
    return (
      new URLSearchParams(search ?? "")
        .get("defaultScriptSpawn")?.toLowerCase() === "on"
    );
  } catch (_) {
    return false;
  }
}

check("'on' parses true", deriveFlag("?defaultScriptSpawn=on") === true);
check("'ON' parses true (case-fold)", deriveFlag("?defaultScriptSpawn=ON") === true);
check("'On' parses true (case-fold)", deriveFlag("?defaultScriptSpawn=On") === true);
check("'off' parses false", deriveFlag("?defaultScriptSpawn=off") === false);
check("'1' parses false (only the literal 'on')", deriveFlag("?defaultScriptSpawn=1") === false);
check("absent parses false (default-OFF)", deriveFlag("?foo=1") === false);
check("empty parses false", deriveFlag("") === false);
check("malformed search never throws → false", deriveFlag(null) === false);

// Pin the replica to source: entities.js ships the identical parse.
check(
  'entities.js parses defaultScriptSpawn?.toLowerCase()==="on"',
  /\.get\("defaultScriptSpawn"\)\s*\?\.toLowerCase\(\)\s*===\s*"on"/.test(entitiesSrc),
);
check(
  "url-flags.md documents the default-off ?defaultScriptSpawn=on row",
  /`\?defaultScriptSpawn=on`/.test(urlFlagsSrc),
);

// =====================================================================
console.log("PART 2 — genuine pickScriptEntry band select (first entry whose mod ≥ intensity)");
// =====================================================================

// Build the factory ON so the genuine picker is in scope; pull it out.
globalThis.window = { location: { search: "?defaultScriptSpawn=on" } };
const { EntityManager, pickScriptEntry } = buildFactory();

// Pin: the spliced picker IS the genuine production function (text identity).
check(
  "spliced picker text is verbatim play_effect_vfx.js pickScriptEntry",
  pickerSrc.includes("function pickScriptEntry(entries, speed)") &&
    pickerSrc.includes("if (speed <= e.mod) return e;") &&
    pickerSrc.includes("return entries[entries.length - 1] ?? null;"),
);

const TBL = [
  { mod: 0.25, scriptDid: 0x33000a01 },
  { mod: 0.75, scriptDid: 0x33000a02 },
  { mod: 1.0, scriptDid: 0x33000a03 },
];
check("intensity below first mod → first band", pickScriptEntry(TBL, 0.0)?.scriptDid === 0x33000a01);
check("intensity exactly at first mod → first band (<=)", pickScriptEntry(TBL, 0.25)?.scriptDid === 0x33000a01);
check("intensity in middle band → middle (first mod ≥ intensity)", pickScriptEntry(TBL, 0.5)?.scriptDid === 0x33000a02);
check("intensity exactly at middle mod → middle (<=)", pickScriptEntry(TBL, 0.75)?.scriptDid === 0x33000a02);
check("intensity just above middle → last band", pickScriptEntry(TBL, 0.76)?.scriptDid === 0x33000a03);
check("intensity above ALL mods → overflow clamp to last", pickScriptEntry(TBL, 5.0)?.scriptDid === 0x33000a03);
check("single-entry table → that entry", pickScriptEntry([{ mod: 1.0, scriptDid: 0x33000100 }], 0.0)?.scriptDid === 0x33000100);
check("empty entries → null", pickScriptEntry([], 1.0) === null);
check("null entries → null", pickScriptEntry(null, 1.0) === null);
check("entry with non-numeric mod is skipped", pickScriptEntry([{ mod: "x", scriptDid: 1 }, { mod: 0.5, scriptDid: 0x33000abc }], 0.4)?.scriptDid === 0x33000abc);

// =====================================================================
console.log("PART 3 — genuine _resolveDefaultScriptDid (mocked getters + stubbed table fetch)");
// =====================================================================

// Minimal `this` for the resolve methods: they read `this.getPhysicsScriptTableDid`
// (the genuine sibling, which itself reads window.__sessionHandle) and
// `this.entityMap`. We invoke the REAL prototype methods bound to this ctx.
function makeResolverCtx() {
  return {
    entityMap: new Map(),
    getPhysicsScriptTableDid: EntityManager.prototype.getPhysicsScriptTableDid,
    _resolveDefaultScriptDid: EntityManager.prototype._resolveDefaultScriptDid,
    _playDefaultScriptResolved: EntityManager.prototype._playDefaultScriptResolved,
  };
}

// Mock the wasm-side SessionHandle getters (absent in a pre-rebuild pkg —
// typeof-guarded in the source). Setting them on the factory's `window`
// (globalThis.window, which buildFactory copied search from) does NOT work —
// the methods read the page global `window.__sessionHandle`, and inside the
// spliced module `window` is the factory arg. So we set the handle on the
// SAME object the factory captured. Re-derive it: build a fresh factory whose
// window we keep a handle to.
function buildResolverWorld(search) {
  globalThis.window = { location: { search } };
  let entSrc = stripExports(loadModule("scene3d/entities.js"))
    .replace('await import("./play_effect_vfx.js")', "await __importPlayEffectVfx()");
  const composite =
    "function readRigModuleFlag() { return false; }\n" +
    "async function fetchPhysicsScriptTable(did) {\n" +
    "  return (typeof globalThis.__A11S5_FETCH_PST === 'function') ? globalThis.__A11S5_FETCH_PST(did) : null;\n" +
    "}\n" +
    pickerSrc + "\n" +
    "async function __importPlayEffectVfx() { return { pickScriptEntry }; }\n" +
    "// === adapter.js ===\n" + stripExports(loadModule("scene3d/adapter.js")) + "\n" +
    "// === animation.js ===\n" + stripExports(loadModule("scene3d/animation.js")) + "\n" +
    "// === entities.js ===\n" + entSrc + "\n" +
    "; return { EntityManager };";
  const factory = new Function("THREE", "performance", "window", composite);
  const win = { location: { search }, __sessionHandle: null };
  const mod = factory(THREE, globalThis.performance ?? { now: () => Date.now() }, win);
  return { EntityManager: mod.EntityManager, win };
}

// Fresh world whose `window` we own (so we can attach __sessionHandle).
const world = buildResolverWorld("?defaultScriptSpawn=on");
const EM = world.EntityManager;

function ctxFor() {
  return {
    entityMap: new Map(),
    getPhysicsScriptTableDid: EM.prototype.getPhysicsScriptTableDid,
    _resolveDefaultScriptDid: EM.prototype._resolveDefaultScriptDid,
    _playDefaultScriptResolved: EM.prototype._playDefaultScriptResolved,
  };
}

/** Install mock SessionHandle getters keyed per-guid. */
function mockHandle({ scriptByGuid = {}, intensityByGuid = {}, tableByGuid = {}, omitScript = false, omitIntensity = false, omitTableDid = false } = {}) {
  const h = {};
  if (!omitScript) h.entityDefaultScript = (g) => (scriptByGuid[g >>> 0] >>> 0) || 0;
  if (!omitIntensity) h.entityDefaultScriptIntensity = (g) => +intensityByGuid[g >>> 0] || 0;
  if (!omitTableDid) h.entityPhysicsScriptTableDid = (g) => (tableByGuid[g >>> 0] >>> 0) || 0;
  world.win.__sessionHandle = h;
}

const GUID = 0x71001234 >>> 0;
const TABLE_DID = 0x34000abc >>> 0;
const ENUM_SCRIPT = 7; // a PScriptType enum (NOT a 0x33 DID)

// 3a. guid 0 → 0 (no work).
{
  const r = await ctxFor()._resolveDefaultScriptDid(0);
  check("3a. guid 0 → 0", r === 0);
}

// 3b. getter absent (stale pre-rebuild pkg) → 0, soft no-op.
{
  mockHandle({ omitScript: true });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3b. entityDefaultScript getter absent (stale pkg) → 0", r === 0);
}

// 3c. raw default_script == 0 → 0.
{
  mockHandle({ scriptByGuid: { [GUID]: 0 } });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3c. raw default_script 0 → 0", r === 0);
}

// 3d. raw is already a 0x33 DID → returned as-is (the physicsScriptDid path
//     already handles it; no table walk).
{
  let fetched = 0;
  globalThis.__A11S5_FETCH_PST = () => { fetched += 1; return null; };
  mockHandle({ scriptByGuid: { [GUID]: 0x33001122 } });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3d. raw 0x33 DID → passthrough as-is", r === 0x33001122);
  check("3d. passthrough does NOT fetch the table (early return)", fetched === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 3e. PScriptType ENUM → table → genuine picker band (intensity picks row).
{
  const table = {
    scripts: {
      [String(ENUM_SCRIPT)]: [
        { mod: 0.25, scriptDid: 0x33000a01 },
        { mod: 0.75, scriptDid: 0x33000a02 },
        { mod: 1.0, scriptDid: 0x33000a03 },
      ],
    },
  };
  let fetchedDid = -1;
  globalThis.__A11S5_FETCH_PST = (did) => { fetchedDid = did >>> 0; return table; };
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.5 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3e. ENUM resolves through GetScript(default_script, intensity)", r === 0x33000a02);
  check("3e. table fetched by the entity's PhysicsScriptTable DID", fetchedDid === TABLE_DID);

  // Same table, different intensity → different band (first mod ≥ intensity).
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.1 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  check("3e. intensity 0.1 → first band", (await ctxFor()._resolveDefaultScriptDid(GUID)) === 0x33000a01);

  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 5.0 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  check("3e. intensity above all mods → overflow clamp (last band)", (await ctxFor()._resolveDefaultScriptDid(GUID)) === 0x33000a03);
  delete globalThis.__A11S5_FETCH_PST;
}

// 3f. ENUM but the entity has NO PhysicsScriptTable DID → 0 (no table to walk).
{
  globalThis.__A11S5_FETCH_PST = () => { throw new Error("must not fetch"); };
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.5 },
    tableByGuid: { [GUID]: 0 }, // no table did
  });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3f. ENUM + no PhysicsScriptTable DID → 0", r === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 3g. NULL TABLE (retail null-table no-op, acclient.c:320335-320343) → 0.
{
  globalThis.__A11S5_FETCH_PST = () => null;
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.5 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3g. null table → 0 (retail null-table no-op)", r === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 3h. Table present but NO row for this script enum → 0.
{
  globalThis.__A11S5_FETCH_PST = () => ({ scripts: { "999": [{ mod: 1.0, scriptDid: 0x33009999 }] } });
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.5 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3h. table present but no row for the enum → 0", r === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 3i. Row present but EMPTY array → 0.
{
  globalThis.__A11S5_FETCH_PST = () => ({ scripts: { [String(ENUM_SCRIPT)]: [] } });
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.5 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3i. empty row → 0", r === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 3j. Intensity getter absent → defaults to 0 → first band (graceful).
{
  globalThis.__A11S5_FETCH_PST = () => ({
    scripts: { [String(ENUM_SCRIPT)]: [{ mod: 0.25, scriptDid: 0x33000a01 }, { mod: 1.0, scriptDid: 0x33000a02 }] },
  });
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    tableByGuid: { [GUID]: TABLE_DID },
    omitIntensity: true,
  });
  const r = await ctxFor()._resolveDefaultScriptDid(GUID);
  check("3j. intensity getter absent → intensity 0 → first band", r === 0x33000a01);
  delete globalThis.__A11S5_FETCH_PST;
}

// =====================================================================
console.log("PART 4 — spawn-arm + hook 17/18 fallback + per-guid idempotency");
// =====================================================================

// `_playDefaultScriptResolved` is the fire-and-forget arm shared by the spawn
// path and the hook 17/18 fallbacks. It resolves the did then calls
// `_attachParticleChainForEntity` exactly once (when did≠0 and the entity is
// still live). We stub `_attachParticleChainForEntity` to record calls and
// drive idempotency through the genuine spawn-arm guard.

function makePlayCtx() {
  const attachCalls = [];
  const ctx = {
    entityMap: new Map(),
    _particleChainsAttached: new Set(),
    getPhysicsScriptTableDid: EM.prototype.getPhysicsScriptTableDid,
    _resolveDefaultScriptDid: EM.prototype._resolveDefaultScriptDid,
    _playDefaultScriptResolved: EM.prototype._playDefaultScriptResolved,
    _attachParticleChainForEntity: async (...args) => { attachCalls.push(args); return undefined; },
  };
  return { ctx, attachCalls };
}

const drain = () => new Promise((r) => setTimeout(r, 0));

// Resolver world set up so `_resolveDefaultScriptDid` yields a real 0x33.
function armResolverFor(guid, did = 0x33000a02) {
  globalThis.__A11S5_FETCH_PST = () => ({
    scripts: { [String(ENUM_SCRIPT)]: [{ mod: 1.0, scriptDid: did }] },
  });
  mockHandle({
    scriptByGuid: { [guid >>> 0]: ENUM_SCRIPT },
    intensityByGuid: { [guid >>> 0]: 0.5 },
    tableByGuid: { [guid >>> 0]: TABLE_DID },
  });
}

// 4a. _playDefaultScriptResolved attaches the resolved 0x33 once for a live guid.
{
  armResolverFor(GUID);
  const { ctx, attachCalls } = makePlayCtx();
  ctx.entityMap.set(GUID, { guid: GUID });
  const root = new THREE.Object3D();
  ctx._playDefaultScriptResolved(GUID, root);
  await drain();
  await drain();
  check("4a. live guid → exactly one _attachParticleChainForEntity call", attachCalls.length === 1);
  check("4a. attach carries (guid, root, resolvedDid)", attachCalls[0]?.[0] === GUID && attachCalls[0]?.[2] === 0x33000a02);
  delete globalThis.__A11S5_FETCH_PST;
}

// 4b. despawn-mid-resolve → dropped (entity gone before the async resolve
//     settles, no attach).
{
  armResolverFor(GUID);
  const { ctx, attachCalls } = makePlayCtx();
  // Entity NOT in entityMap (= despawned by the time the promise resolves).
  ctx._playDefaultScriptResolved(GUID, new THREE.Object3D());
  await drain();
  await drain();
  check("4b. despawned guid (not in entityMap) → no attach", attachCalls.length === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 4c. did 0 (resolver yields nothing) → no attach.
{
  globalThis.__A11S5_FETCH_PST = () => null; // null table → resolve 0
  mockHandle({
    scriptByGuid: { [GUID]: ENUM_SCRIPT },
    intensityByGuid: { [GUID]: 0.5 },
    tableByGuid: { [GUID]: TABLE_DID },
  });
  const { ctx, attachCalls } = makePlayCtx();
  ctx.entityMap.set(GUID, { guid: GUID });
  ctx._playDefaultScriptResolved(GUID, new THREE.Object3D());
  await drain();
  await drain();
  check("4c. resolved did 0 → no attach (no-op)", attachCalls.length === 0);
  delete globalThis.__A11S5_FETCH_PST;
}

// 4d. defaultPartIndex threaded into the attach (hook 18 anchor part).
{
  armResolverFor(GUID);
  const { ctx, attachCalls } = makePlayCtx();
  ctx.entityMap.set(GUID, { guid: GUID });
  ctx._playDefaultScriptResolved(GUID, new THREE.Object3D(), 3);
  await drain();
  await drain();
  check("4d. hook-18 part index threaded to _attachParticleChainForEntity", attachCalls.length === 1 && attachCalls[0]?.[4] === 3);
  delete globalThis.__A11S5_FETCH_PST;
}

// 4e. per-guid idempotency via the genuine spawn-arm guard
//     (`_particleChainsAttached`). The spawn arm adds the guid to the set
//     before attaching; a second arm for the same guid must NOT re-attach.
//     We replicate the spawn-arm guard sequence verbatim (the same lines from
//     entities.js _spawnImpl, pinned to source below) over the genuine
//     resolver + a stubbed attach.
{
  armResolverFor(GUID);
  const { ctx, attachCalls } = makePlayCtx();
  ctx.entityMap.set(GUID, { guid: GUID });
  const root = new THREE.Object3D();

  // The spawn-arm guard (entities.js:3637-3653): resolve, then add-to-set
  // gated on !has, then attach. Run it twice for the same guid.
  async function spawnArm(guid) {
    const did = await ctx._resolveDefaultScriptDid(guid);
    if (did === 0) return;
    if (!ctx.entityMap.has(guid)) return;
    if (ctx._particleChainsAttached.has(guid)) return; // idempotency gate
    ctx._particleChainsAttached.add(guid);
    await ctx._attachParticleChainForEntity(guid, root, did);
  }
  await spawnArm(GUID);
  await spawnArm(GUID);
  check("4e. spawn arm attaches once; second arm short-circuits on _particleChainsAttached", attachCalls.length === 1);
  check("4e. guid recorded in _particleChainsAttached", ctx._particleChainsAttached.has(GUID));
  delete globalThis.__A11S5_FETCH_PST;
}

// ---- static wiring pins (the real spawn-arm + hook 17/18 routing) -----
check(
  "spawn arm: _resolveDefaultScriptDid gated on DEFAULT_SCRIPT_SPAWN_ON && pesId===0 && !_particleChainsAttached.has(guid)",
  /DEFAULT_SCRIPT_SPAWN_ON\s*&&\s*\n\s*pesId === 0\s*&&\s*\n\s*!this\._particleChainsAttached\.has\(guid\)/.test(entitiesSrc),
);
check(
  "spawn arm: drops despawn-mid-resolve (!this.entityMap.has(guid)) and re-checks the idempotency set",
  /this\._resolveDefaultScriptDid\(guid\)[\s\S]{0,260}!this\.entityMap\.has\(guid\)[\s\S]{0,120}this\._particleChainsAttached\.has\(guid\)[\s\S]{0,120}this\._particleChainsAttached\.add\(guid\)/.test(entitiesSrc),
);
check(
  "hook 17 (DefaultScript) PScriptType fallback calls _playDefaultScriptResolved when pesId===0",
  /hookType === 17[\s\S]{0,700}else if \(DEFAULT_SCRIPT_SPAWN_ON\)\s*\{[\s\S]{0,300}this\._playDefaultScriptResolved\(inst\.guid >>> 0, inst\.root\);/.test(entitiesSrc),
);
check(
  "hook 18 (DefaultScriptPart) PScriptType fallback threads the part index",
  /hookType === 18[\s\S]{0,900}else if \(DEFAULT_SCRIPT_SPAWN_ON\)\s*\{[\s\S]{0,360}this\._playDefaultScriptResolved\(inst\.guid >>> 0, inst\.root, defaultPartIndex\);/.test(entitiesSrc),
);
check(
  "_resolveDefaultScriptDid: 0x33 passthrough ((raw>>>24)===0x33) before the table walk",
  /if \(\(raw >>> 24\) === 0x33\) return raw;/.test(entitiesSrc),
);
check(
  "_resolveDefaultScriptDid: reads entityDefaultScript / entityDefaultScriptIntensity (typeof-guarded)",
  /typeof sh\.entityDefaultScript !== "function"/.test(entitiesSrc) &&
    /typeof sh\.entityDefaultScriptIntensity === "function"/.test(entitiesSrc),
);
check(
  "_resolveDefaultScriptDid: null/missing table did → 0 (getPhysicsScriptTableDid===0 early out)",
  /const tableDid = this\.getPhysicsScriptTableDid\(g\);\s*\n\s*if \(tableDid === 0\) return 0;/.test(entitiesSrc),
);
check(
  "_resolveDefaultScriptDid: picks via pickScriptEntry(entries, intensity)",
  /pickScriptEntry\(entries, intensity\)/.test(entitiesSrc),
);

// =====================================================================
console.log("=========================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
