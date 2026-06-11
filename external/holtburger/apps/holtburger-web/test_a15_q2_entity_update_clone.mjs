// A15-Q2 (2026-06-11 unification survey, Stage Q2) — single EntityUpdate
// clone/field schema. The wasm `EntityUpdate` field schema was hand-copied
// ~5× across the two renderer paths (toMeta, __scene3dCloneEntityUpdate,
// cloneEntitySpawn, metaFromSpawn). This test asserts the extracted
// `cloneEntityUpdate` (scene3d/entity_update_clone.js):
//
//   PART 1 — field-parity: over a synthetic EntityUpdate with EVERY field
//            set, the unified clone reproduces every key each legacy clone
//            produced, with the same value (the legacy shapes are
//            replicated inline below from the shipped source).
//   PART 2 — the previously-MISSING fields are now present + correct:
//            `isAutonomous` (read at loop.js dispatchOne KIND_MOTION ~:2098),
//            `physicsTranslucency` (read at toMeta / entities.js spawn ~:1642),
//            and `motionSpeed` (read at KIND_MOTION / KIND_MOTION_ACTION).
//   PART 3 — self-containment: array fields are COPIES (mutating the source
//            does not bleed into the clone), and survive a simulated
//            wasm-bindgen `.free()`.
//   PART 4 — static: both renderer paths actually consume the module behind
//            the `?unifiedClone=on` flag in the shipped source.
//
// Run:
//   cd apps/holtburger-web/
//   node test_a15_q2_entity_update_clone.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import { cloneEntityUpdate, EMPTY_U32 } from "./scene3d/entity_update_clone.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// ---------------------------------------------------------------------
// A synthetic EntityUpdate with EVERY getter set to a distinct non-default
// value (mirrors the wasm-bindgen getter surface; the real handle exposes
// the same property names). Arrays are non-empty so we exercise the copy
// path, not the shared-empty sentinel.
// ---------------------------------------------------------------------
function makeUpd() {
  return {
    kind: 5,
    guid: 0x12345678,
    modelId: 0x02000111,
    landblockId: 0x8602_0000 >>> 0,
    x: 12.5, y: -3.25, z: 7.0,
    qw: 0.5, qx: 0.1, qy: 0.2, qz: 0.3,
    wcid: 31069,
    itemType: 0x10, // CREATURE
    name: "Drudge Skulker",
    objScale: 1.4,
    iconId: 0x06001234,
    paletteId: 0x04000abc,
    mtableId: 0x09000def,
    portalDestination: "Holtburg (87, -3, 0)",
    physicsTranslucency: 0.4,
    objDescFlags: 0x0001,
    weenieFlags: 0x0002,
    modelChanges: Uint32Array.from([1, 0x02000222]),
    textureChanges: Uint32Array.from([0, 0x05000001, 0x05000002]),
    subPalettes: Uint32Array.from([0x04000abc, 0, 256]),
    physicsScriptDid: 0x33000077,
    soundTableDid: 0x20000001,
    motionCommand: 0x00000007, // RUN_FORWARD
    motionStance: 0x0000003d,  // NonCombat
    motionSpeed: 1.75,
    isAutonomous: true,
    vx: 4.0, vy: -1.0, vz: 0.25,
    omegaZ: 0.9,
  };
}

// ---------------------------------------------------------------------
// Legacy clone shapes — replicated VERBATIM from the shipped source, so
// the parity diff catches any drift. These are the per-site copies the
// unified clone replaces.
// ---------------------------------------------------------------------

// scene3d/loop.js#toMeta (3D spawn snapshot). NOTE: uses plain copies here
// instead of _sliceFromScratch; both yield a fresh right-sized Uint32Array.
function legacyToMeta(upd) {
  const sliceLike = (src) =>
    src && src.length > 0 ? Uint32Array.from(src) : EMPTY_U32;
  return {
    guid: (upd.guid >>> 0),
    modelId: (upd.modelId >>> 0),
    setupId: (upd.modelId >>> 0),
    landblockId: (upd.landblockId >>> 0),
    x: upd.x ?? 0, y: upd.y ?? 0, z: upd.z ?? 0,
    qw: upd.qw ?? 1, qx: upd.qx ?? 0, qy: upd.qy ?? 0, qz: upd.qz ?? 0,
    wcid: (upd.wcid >>> 0),
    itemType: (upd.itemType >>> 0),
    name: upd.name || "",
    iconId: (upd.iconId >>> 0),
    objScale: upd.objScale > 0 ? upd.objScale : 1.0,
    physicsTranslucency: +(upd.physicsTranslucency ?? 0),
    paletteId: (upd.paletteId >>> 0),
    mtableId: (upd.mtableId >>> 0),
    motionCommand: (upd.motionCommand ?? 0) >>> 0,
    motionStance: (upd.motionStance ?? 0) >>> 0,
    vx: +(upd.vx ?? 0), vy: +(upd.vy ?? 0), vz: +(upd.vz ?? 0),
    modelChanges: sliceLike(upd.modelChanges),
    textureChanges: sliceLike(upd.textureChanges),
    subPalettes: sliceLike(upd.subPalettes),
    physicsScriptDid: (upd.physicsScriptDid ?? 0) >>> 0,
    soundTableDid: (upd.soundTableDid ?? 0) >>> 0,
  };
}

// index.html#__scene3dCloneEntityUpdate (3D pre-init backlog clone). This is
// the one that MISSED isAutonomous / physicsTranslucency / motionSpeed.
function legacyBacklogClone(upd) {
  return {
    kind: upd.kind,
    guid: upd.guid,
    modelId: upd.modelId ?? 0,
    landblockId: upd.landblockId ?? 0,
    x: upd.x ?? 0, y: upd.y ?? 0, z: upd.z ?? 0,
    qw: upd.qw ?? 1, qx: upd.qx ?? 0, qy: upd.qy ?? 0, qz: upd.qz ?? 0,
    vx: upd.vx ?? 0, vy: upd.vy ?? 0, vz: upd.vz ?? 0,
    omegaZ: upd.omegaZ ?? 0,
    motionCommand: (upd.motionCommand ?? 0) >>> 0,
    motionStance: (upd.motionStance ?? 0) >>> 0,
    wcid: (upd.wcid ?? 0) >>> 0,
    itemType: (upd.itemType ?? 0) >>> 0,
    name: upd.name ?? "",
    iconId: (upd.iconId ?? 0) >>> 0,
    objScale: upd.objScale && upd.objScale > 0 ? upd.objScale : 1,
    paletteId: (upd.paletteId ?? 0) >>> 0,
    mtableId: (upd.mtableId ?? 0) >>> 0,
    modelChanges: upd.modelChanges && upd.modelChanges.length > 0
      ? Uint32Array.from(upd.modelChanges) : new Uint32Array(0),
    textureChanges: upd.textureChanges && upd.textureChanges.length > 0
      ? Uint32Array.from(upd.textureChanges) : new Uint32Array(0),
    subPalettes: upd.subPalettes && upd.subPalettes.length > 0
      ? Uint32Array.from(upd.subPalettes) : new Uint32Array(0),
    physicsScriptDid: (upd.physicsScriptDid ?? 0) >>> 0,
    soundTableDid: (upd.soundTableDid ?? 0) >>> 0,
  };
}

// index.html#cloneEntitySpawn (2D pre-liveScene deferred spawn; raw copy).
function legacyCloneEntitySpawn(upd) {
  return {
    kind: upd.kind, guid: upd.guid, modelId: upd.modelId,
    landblockId: upd.landblockId,
    x: upd.x, y: upd.y, z: upd.z,
    qw: upd.qw, qx: upd.qx, qy: upd.qy, qz: upd.qz,
    wcid: upd.wcid, itemType: upd.itemType, name: upd.name,
    objScale: upd.objScale, iconId: upd.iconId, paletteId: upd.paletteId,
    mtableId: upd.mtableId,
    modelChanges: upd.modelChanges, textureChanges: upd.textureChanges,
    subPalettes: upd.subPalettes,
    physicsScriptDid: upd.physicsScriptDid, soundTableDid: upd.soundTableDid,
  };
}

function eqVal(a, b) {
  const isArrA = a instanceof Uint32Array || Array.isArray(a);
  const isArrB = b instanceof Uint32Array || Array.isArray(b);
  if (isArrA || isArrB) {
    if (!isArrA || !isArrB) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if ((a[i] >>> 0) !== (b[i] >>> 0)) return false;
    return true;
  }
  if (typeof a === "number" && typeof b === "number") {
    // tolerate u32-normalization of negative landblock ids etc.
    return a === b || (a >>> 0) === (b >>> 0) || Math.abs(a - b) < 1e-6;
  }
  return a === b;
}

// Superset assertion: every key in `legacy` exists in `unified` with an
// equal value. `unified` may carry MORE keys (it's the superset).
function assertSuperset(label, legacy, unified) {
  let allOk = true;
  const misses = [];
  for (const k of Object.keys(legacy)) {
    if (!(k in unified)) { allOk = false; misses.push(`${k}:absent`); continue; }
    if (!eqVal(legacy[k], unified[k])) {
      allOk = false;
      misses.push(`${k}:${JSON.stringify(legacy[k])}!=${JSON.stringify(unified[k])}`);
    }
  }
  check(`${label}: unified is a superset (every legacy key present + equal)`,
    allOk, misses.length ? misses.join(", ") : undefined);
}

// =====================================================================
console.log("PART 1 — field-parity vs every legacy clone shape");
const upd = makeUpd();
const uni = cloneEntityUpdate(upd);

assertSuperset("toMeta", legacyToMeta(upd), uni);
assertSuperset("__scene3dCloneEntityUpdate", legacyBacklogClone(upd), uni);
assertSuperset("cloneEntitySpawn", legacyCloneEntitySpawn(upd), uni);

// =====================================================================
console.log("PART 2 — previously-MISSING fields now carried");
check("isAutonomous present + correct (loop.js dispatchOne ~:2098)",
  uni.isAutonomous === true, `got ${uni.isAutonomous}`);
check("physicsTranslucency present + correct (toMeta / entities.js ~:1642)",
  uni.physicsTranslucency === 0.4, `got ${uni.physicsTranslucency}`);
check("motionSpeed present + correct (KIND_MOTION/_ACTION)",
  uni.motionSpeed === 1.75, `got ${uni.motionSpeed}`);
// The legacy backlog clone LACKED these — prove the gap they close.
const lbc = legacyBacklogClone(upd);
check("legacy backlog clone confirms the gap (no isAutonomous key)",
  !("isAutonomous" in lbc));
check("legacy backlog clone confirms the gap (no physicsTranslucency key)",
  !("physicsTranslucency" in lbc));
check("legacy backlog clone confirms the gap (no motionSpeed key)",
  !("motionSpeed" in lbc));
// dispatchOne reads `!!upd.isAutonomous`: a missing key (legacy) === false,
// which MISCLASSIFIES the client-predicted echo as server-FORCED.
check("missing isAutonomous would misclassify (=== false on legacy clone)",
  (!!lbc.isAutonomous) === false && (!!uni.isAutonomous) === true);

// motionSpeed default for a non-motion update is the 1.0 identity.
const spawnUpd = { ...makeUpd(), kind: 1 };
delete spawnUpd.motionSpeed;
const uniSpawn = cloneEntityUpdate(spawnUpd);
check("motionSpeed defaults to 1.0 identity when absent",
  uniSpawn.motionSpeed === 1.0, `got ${uniSpawn.motionSpeed}`);

// =====================================================================
console.log("PART 3 — self-containment (copies + free-safe)");
{
  const src = makeUpd();
  const c = cloneEntityUpdate(src);
  // Mutate the source arrays + scalars AFTER cloning.
  src.modelChanges[0] = 0xdeadbeef;
  src.x = 999;
  src.name = "MUTATED";
  check("modelChanges is a copy (source mutation does not bleed)",
    c.modelChanges[0] === 1, `got ${c.modelChanges[0]}`);
  check("scalar fields captured by value (source mutation does not bleed)",
    c.x === 12.5 && c.name === "Drudge Skulker");
}
{
  // Simulate wasm-bindgen .free(): a getter access throws after free.
  const freed = makeUpd();
  const c = cloneEntityUpdate(freed); // clone BEFORE free
  for (const k of Object.keys(freed)) {
    Object.defineProperty(freed, k, {
      get() { throw new Error("use after free"); },
    });
  }
  check("clone survives a post-clone source free (no shared refs)",
    c.guid === (0x12345678 >>> 0) && c.physicsTranslucency === 0.4);
}
{
  // Empty arrays → shared empty sentinel (matches toMeta's _emptyU32 alloc).
  const empty = { ...makeUpd(), modelChanges: new Uint32Array(0),
    textureChanges: null, subPalettes: undefined };
  const c = cloneEntityUpdate(empty);
  check("empty/null/undefined arrays → shared empty sentinel",
    c.modelChanges === EMPTY_U32 && c.textureChanges === EMPTY_U32 &&
    c.subPalettes === EMPTY_U32);
}
{
  // The opts.sliceU32 hook (loop.js passes _sliceFromScratch) is honored.
  const tag = Uint32Array.from([42]);
  const c = cloneEntityUpdate(makeUpd(), { sliceU32: () => tag });
  check("opts.sliceU32 copier is honored (loop.js scratch path)",
    c.modelChanges === tag && c.subPalettes === tag);
}

// =====================================================================
console.log("PART 4 — static: both paths consume the module behind ?unifiedClone");
const idx = readFileSync(joinPath(__dirname, "index.html"), "utf8");
const loop = readFileSync(joinPath(__dirname, "scene3d", "loop.js"), "utf8");

check("index.html imports cloneEntityUpdate from the shared module",
  /import\s*\{\s*cloneEntityUpdate\s+as\s+__unifiedCloneEntityUpdate\s*\}\s*from\s*["']\.\/scene3d\/entity_update_clone\.js["']/.test(idx));
check("index.html parses the ?unifiedClone flag",
  idx.includes('get("unifiedClone")'));
check("index.html backlog clone defers to __unifiedCloneEntityUpdate under flag",
  /if\s*\(\s*__UNIFIED_CLONE\s*\)\s*\{\s*return\s+__unifiedCloneEntityUpdate\(upd\)/.test(idx));
check("loop.js imports cloneEntityUpdate from the shared module",
  /import\s*\{\s*cloneEntityUpdate\s*\}\s*from\s*["']\.\/entity_update_clone\.js["']/.test(loop));
check("loop.js#toMeta defers to cloneEntityUpdate under ?unifiedClone",
  /UNIFIED_CLONE_ON/.test(loop) &&
  /return\s+cloneEntityUpdate\(upd,\s*\{\s*sliceU32:\s*_sliceFromScratch\s*\}\)/.test(loop));

// =====================================================================
console.log(`\nA15-Q2 entity-update-clone: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
