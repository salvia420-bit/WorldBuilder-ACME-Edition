// tests/default_script_no_spawn_play.test.mjs — particles-scripts-1 (2026-10-13,
// `?defaultScriptAtSpawn=on` opt-in, default OFF = retail).
//
// Retail `CPhysicsObj::set_description` only STORES the wire PhysicsDesc
// default_script + intensity (acclient.c:322389-322391). `play_default_script`
// has three callers — DefaultScriptPartHook::Execute (:342326),
// DefaultScriptHook::Execute (:342332), ACCWeenieObject::DoCollision (:436867)
// — and creation plays only the Setup's default_script_id
// (CPhysicsObj::InitDefaults :320867-320868). The A11-S5 spawn arm played the
// PScriptType default at spawn (breath creatures puffed as they streamed in)
// and raced the Setup arm for the single `_particleChainsAttached` slot.
//
//   1. the genuine DEFAULT_SCRIPT_PLAY_AT_SPAWN_ON reader (exact `on` opt-in)
//   2. source pins: the opt-in is the FIRST operand of the PScriptType spawn
//      arm and gates nothing else (not the Setup arm, the raw-0x33 arm or the
//      hook 17/18 fallbacks)
//   3. real EntityManager, default: an entity with default_script 0x56
//      (BreatheLightning) whose table maps 86 → 0x33000AAA and whose Setup
//      default_script is 0x33000BBB attaches only 0x33000BBB at spawn;
//      DefaultScript(17) / DefaultScriptPart(18) then play 0x33000AAA
//   4. no Setup script: nothing plays at spawn, the slot stays free
//   5. the raw-0x33 wire arm is untouched
//   6. `?defaultScriptAtSpawn=on` restores the spawn play
//   7. `?defaultScriptSpawn=off` still silences the hook fallbacks
//
// `window.location` is stubbed BEFORE entities.js loads; the opt-in and the
// escape load their own module instances (tests/anim_hook_callpes precedent).
//
// Run: node tests/default_script_no_spawn_play.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entitiesSrc = readFileSync(join(__dirname, "..", "scene3d", "entities.js"), "utf8");

const BREATHE_LIGHTNING = 0x56; // PScriptType 86 — ACE PropertyDataId.PhysicsScript on 164+ creatures
const TABLE_DID = 0x34000abc;
const WIRE_SCRIPT = 0x33000aaa; // GetScript(86, 0) through the table
const SETUP_SCRIPT = 0x33000bbb; // Setup.default_script_id
const RAW_PES = 0x33000ccc; // a raw 0x33 wire default_script (physicsScriptDid)

// Session-handle getters (wasm-side in the browser) + the PhysicsScriptTable
// wasm export the ui/ac_physics_script_table.js facade reads.
let defaultScriptReads = 0;
globalThis.window = {
  location: { search: "" },
  // The resolver's lazy play_effect_vfx.js import self-binds to the plugin
  // bus on load; marking it bound skips its 30 s poll for __pluginClient.
  __playEffectVfxBound: true,
  __sessionHandle: {
    entityIsProjectile: () => false,
    entityDefaultScript: () => { defaultScriptReads += 1; return BREATHE_LIGHTNING; },
    entityDefaultScriptIntensity: () => 0,
    entityPhysicsScriptTableDid: () => TABLE_DID,
  },
  __hbWasm: {
    async fetchPhysicsScriptTable(did) {
      return JSON.stringify({
        id: did >>> 0,
        scripts: { [String(BREATHE_LIGHTNING)]: [{ mod: 1.0, scriptDid: WIRE_SCRIPT }] },
      });
    },
  },
};
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
window.location.search = "?defaultScriptAtSpawn=on";
const { EntityManager: OptInEntityManager } = await import("../scene3d/entities.js?defaultScriptAtSpawn=on");
window.location.search = "?defaultScriptSpawn=off";
const { EntityManager: EscapeEntityManager } = await import("../scene3d/entities.js?defaultScriptSpawn=off");
window.location.search = "";

const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

let nextGuid = 0x80005001;
async function setup(Manager = EntityManager, { setupScript = SETUP_SCRIPT, physicsScriptDid = 0 } = {}) {
  const wasmExports = {
    // No animation: only the default-script arms are under test.
    async fetchEntityAnimationKeyframes() {
      return { partCount: 0, numFrames: 0, framerate: 0, resolvedStance: 0x3d, partFrames: new Float32Array(0) };
    },
    // Present so every default-script arm is eligible (the gates are what's tested).
    async fetchPhysicsScript() { return null; },
    async fetchParticleEmitter() { return null; },
    async fetchBuildingPlacement() { return { partCount: 0, free() {} }; },
    async fetchSetupDefaultScript() { return setupScript; },
  };
  const em = new Manager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  const attached = [];
  em._attachParticleChainForEntity = (...args) => { attached.push(args); return Promise.resolve(); };
  // Track B7 table prewarm is unrelated warm-up work.
  em._prewarmPhysicsScriptTable = async () => {};
  const inst = await em.spawn({
    guid: nextGuid, modelId: 0x02000001, mtableId: 0, landblockId: 0xa9b40001,
    x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0, paletteId: 0, motionCommand: 0,
    motionStance: 0, objScale: 1, name: "Olthoi Soldier", wcid: 1, itemType: 0x10, iconId: 0,
    physicsScriptDid,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
  nextGuid += 1;
  const dids = () => attached.map((a) => a[2] >>> 0);
  return { em, inst, attached, dids };
}

// ---------------------------------------------------------------------------
test("1. genuine DEFAULT_SCRIPT_PLAY_AT_SPAWN_ON reader: exact `on` opt-in", () => {
  const m = entitiesSrc.match(/const DEFAULT_SCRIPT_PLAY_AT_SPAWN_ON = (\(\(\) => \{[\s\S]*?\n\}\)\(\));/);
  assert.ok(m, "reader found in entities.js");
  const read = (win) => new Function("window", `return ${m[1]};`)(win);
  const W = (search) => ({ location: { search } });
  assert.equal(read(W("")), false, "absent → off (retail)");
  assert.equal(read(W("?foo=1")), false, "other params → off");
  assert.equal(read(W("?defaultScriptAtSpawn=on")), true, "=on → on");
  assert.equal(read(W("?defaultScriptAtSpawn=ON")), true, "=ON → on (case-fold)");
  assert.equal(read(W("?defaultScriptAtSpawn=off")), false, "=off → off");
  assert.equal(read(W("?defaultScriptAtSpawn=1")), false, "=1 is not the opt-in value");
  assert.equal(read(undefined), false, "no window → off");
  assert.equal(read({}), false, "window without location → off");
});

test("2. source: the opt-in leads the PScriptType spawn arm and gates nothing else", () => {
  assert.match(
    entitiesSrc,
    /if \(\s*\n\s*DEFAULT_SCRIPT_PLAY_AT_SPAWN_ON &&\s*\n\s*DEFAULT_SCRIPT_SPAWN_ON &&\s*\n\s*pesId === 0 &&[\s\S]{0,900}?\)\s*\{\s*\n\s*this\._resolveDefaultScriptDid\(guid\)/,
    "spawn-arm condition starts with DEFAULT_SCRIPT_PLAY_AT_SPAWN_ON &&",
  );
  const codeUses = entitiesSrc
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\bDEFAULT_SCRIPT_PLAY_AT_SPAWN_ON\b/.test(l));
  assert.equal(
    codeUses.length, 2,
    "declared once, read once (the spawn arm) — Setup / raw-0x33 / hook arms ungated",
  );
  // The hook fallbacks keep the master switch only.
  assert.match(entitiesSrc, /hookType === 17[\s\S]{0,700}else if \(DEFAULT_SCRIPT_SPAWN_ON\)\s*\{/);
  assert.match(entitiesSrc, /hookType === 18[\s\S]{0,900}else if \(DEFAULT_SCRIPT_SPAWN_ON\)\s*\{/);
  // The Setup default_script arm is not behind the wire-script flags.
  assert.match(entitiesSrc, /if \(\s*\n\s*SETUP_DEFAULT_SCRIPT_ON &&\s*\n\s*pesId === 0 &&/);
});

test("3. default: only the Setup script plays at spawn; hooks 17/18 play the wire script", async () => {
  const { em, inst, attached, dids } = await setup();
  // Control: the mocks DO resolve the wire script (so its absence below is the gate).
  assert.equal(await em._resolveDefaultScriptDid(inst.guid), WIRE_SCRIPT);
  assert.ok(await waitFor(() => dids().includes(SETUP_SCRIPT)), "Setup default_script attached");
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dids(), [SETUP_SCRIPT], "the PhysicsDesc default_script is NOT played at spawn");
  assert.equal(attached[0][1], inst.root, "Setup script anchored on the rig root");
  assert.ok(em._particleChainsAttached.has(inst.guid >>> 0), "the Setup arm holds the slot");

  // DefaultScriptHook::Execute → play_default_script (acclient.c:342332).
  em._fireHook(inst, { hookType: 17 }, null, null);
  assert.ok(await waitFor(() => dids().includes(WIRE_SCRIPT)), "hook 17 plays GetScript(0x56, 0)");
  assert.deepEqual(attached[1].slice(0, 3), [inst.guid >>> 0, inst.root, WIRE_SCRIPT]);
  assert.equal(attached[1][4], -1, "hook 17 anchors on the root");

  // DefaultScriptPartHook::Execute → play_default_script(object, _part_index) (:342326).
  em._fireHook(inst, { hookType: 18, partIndex: 2 }, null, null);
  assert.ok(await waitFor(() => attached.length === 3), "hook 18 plays it too");
  assert.equal(attached[2][2] >>> 0, WIRE_SCRIPT);
  assert.equal(attached[2][4], 2, "hook 18 threads its part index");
  em.dispose();
});

test("4. default, no Setup script: nothing plays at spawn and the slot stays free", async () => {
  defaultScriptReads = 0;
  const { em, inst, attached } = await setup(EntityManager, { setupScript: 0 });
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(attached.length, 0, "no breath puff as the creature streams in");
  assert.equal(em._particleChainsAttached.has(inst.guid >>> 0), false);
  assert.equal(defaultScriptReads, 0, "the spawn path never consults the wire default_script");
  em.dispose();
});

test("5. the raw-0x33 wire arm is untouched", async () => {
  const { em, dids } = await setup(EntityManager, { physicsScriptDid: RAW_PES });
  assert.ok(await waitFor(() => dids().length > 0));
  await settle();
  assert.deepEqual(dids(), [RAW_PES]);
  em.dispose();
});

test("6. `?defaultScriptAtSpawn=on` restores the spawn play", async () => {
  const { em, inst, dids } = await setup(OptInEntityManager, { setupScript: 0 });
  assert.ok(await waitFor(() => dids().includes(WIRE_SCRIPT)), "wire default_script played at spawn");
  await settle();
  assert.deepEqual(dids(), [WIRE_SCRIPT]);
  assert.ok(em._particleChainsAttached.has(inst.guid >>> 0), "the spawn arm takes the slot (legacy)");
  em.dispose();
});

test("7. `?defaultScriptSpawn=off` silences the hook fallbacks; the Setup script still plays", async () => {
  const { em, inst, attached, dids } = await setup(EscapeEntityManager);
  assert.ok(await waitFor(() => dids().includes(SETUP_SCRIPT)));
  em._fireHook(inst, { hookType: 17 }, null, null);
  em._fireHook(inst, { hookType: 18, partIndex: 1 }, null, null);
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dids(), [SETUP_SCRIPT], "escape = 0x33-only behavior");
  assert.equal(attached.length, 1);
  em.dispose();
});
