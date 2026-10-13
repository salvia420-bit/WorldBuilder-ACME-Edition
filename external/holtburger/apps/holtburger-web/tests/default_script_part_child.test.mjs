// tests/default_script_part_child.test.mjs — particles-scripts-2 (2026-10-13,
// `?defaultScriptPartChild=on` opt-in, default OFF = the W4.7 owner arm).
//
// Retail DefaultScriptPartHook::Execute → CPhysicsObj::play_default_script(
// object, _part_index) (acclient.c:342324-342327). That overload
// (:320378-320412) walks the object's CHILDLIST: the FIRST entry whose
// part_number == part_index (a wielded weapon / shield / orb; part_number is
// its holding location's part, CPhysicsObj::add_child :316729-316760) plays
// the CHILD's default_script through the CHILD's PhysicsScriptTable +
// intensity, on the child. Nothing held there → nothing plays (returns 0).
// holtburger's hook 18 arm played the WIELDER's own default anchored at the
// part instead.
//
//   1. the genuine DEFAULT_SCRIPT_PART_CHILD_ON reader (exact `on` opt-in)
//   2. source pins: the opt-in is the FIRST branch of the hook 18 arm and
//      gates nothing else; the legacy owner arm text is intact
//   3. opt-in: a child mounted on parts[3] by the genuine attachChildToParent
//      → hook 18 @3 plays (C, C.root) — the wielder's own never
//   4. opt-in: hook 18 on an empty part → nothing (owner raw 0x33 ignored)
//   5. opt-in: a raw 0x33 child default attaches on the child
//   6. opt-in: root sentinel matches only a root-mounted child
//   7. opt-in: first match wins; detached / left-world children play nothing
//   8. opt-in, end to end: the CHILD's own table + intensity resolve the did
//   9. opt-in + `?defaultScriptSpawn=off`: PScriptType child silent, raw 0x33
//      child still plays
//  10. default and `=off`: the legacy owner-anchored call, byte-identical
//
// `window.location` is stubbed BEFORE entities.js loads; each flag state
// loads its own module instance (tests/default_script_no_spawn_play precedent).
//
// Run: node tests/default_script_part_child.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entitiesSrc = readFileSync(join(__dirname, "..", "scene3d", "entities.js"), "utf8");

const W_GUID = 0x50000001; // the wielder (given a default script too — it must never play)
const C_GUID = 0x80006001; // the held weapon
const C2_GUID = 0x80006002;
const BREATHE_LIGHTNING = 0x57; // PlayScript.BreatheLightning — LSD: 47 melee / 14 bows / 2 orbs
const CHILD_TABLE = 0x34000c01;
const WIELDER_TABLE = 0x34000c02;
const CHILD_SCRIPT = 0x33000c0a; // GetScript(0x57, 0.5) through the CHILD's table
const WIELDER_SCRIPT = 0x33000c0b; // what the wielder's table would give
const RAW_CHILD_PES = 0x33000c0c;
const RAW_WIELDER_PES = 0x33000c0d;

// Session-handle getters, keyed per guid (wasm-side in the browser), + the
// PhysicsScriptTable export the ui/ac_physics_script_table.js facade reads.
const defaultScriptByGuid = new Map([[C_GUID, BREATHE_LIGHTNING], [W_GUID, BREATHE_LIGHTNING]]);
const intensityByGuid = new Map([[C_GUID, 0.5], [W_GUID, 0]]);
const tableByGuid = new Map([[C_GUID, CHILD_TABLE], [W_GUID, WIELDER_TABLE]]);
globalThis.window = {
  location: { search: "" },
  // The resolver's lazy play_effect_vfx.js import self-binds to the plugin
  // bus on load; marking it bound skips its 30 s poll for __pluginClient.
  __playEffectVfxBound: true,
  __sessionHandle: {
    entityIsProjectile: () => false,
    entityDefaultScript: (g) => defaultScriptByGuid.get(g >>> 0) ?? 0,
    entityDefaultScriptIntensity: (g) => intensityByGuid.get(g >>> 0) ?? 0,
    entityPhysicsScriptTableDid: (g) => tableByGuid.get(g >>> 0) ?? 0,
  },
  __hbWasm: {
    async fetchPhysicsScriptTable(did) {
      const rows = (did >>> 0) === CHILD_TABLE
        // Two bands: intensity 0.5 must pick the second (first mod ≥ intensity).
        ? [{ mod: 0.25, scriptDid: 0x33000c09 }, { mod: 1.0, scriptDid: CHILD_SCRIPT }]
        : [{ mod: 1.0, scriptDid: WIELDER_SCRIPT }];
      return JSON.stringify({ id: did >>> 0, scripts: { [String(BREATHE_LIGHTNING)]: rows } });
    },
  },
};
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
window.location.search = "?defaultScriptPartChild=on";
const { EntityManager: OnEM } = await import("../scene3d/entities.js?defaultScriptPartChild=on");
window.location.search = "?defaultScriptPartChild=off";
const { EntityManager: OffEM } = await import("../scene3d/entities.js?defaultScriptPartChild=off");
window.location.search = "?defaultScriptPartChild=on&defaultScriptSpawn=off";
const { EntityManager: OnNoSpawnEM } = await import(
  "../scene3d/entities.js?defaultScriptPartChild=on&defaultScriptSpawn=off"
);
window.location.search = "";

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
};

/** A rig shaped like an EntityInstance: root + per-part Groups under it. */
function rig(guid, nParts, meta = {}) {
  const root = new THREE.Group();
  const parts = [];
  for (let i = 0; i < nParts; i += 1) {
    const g = new THREE.Group();
    root.add(g);
    parts.push(g);
  }
  return { guid, root, parts, meta, _attachedParentGuid: null, _attachedChildren: null };
}

/**
 * Manager + wielder W (6 parts) + child C, with spies on the two play sinks.
 * `realResolve` keeps the genuine `_playDefaultScriptResolved` (end to end).
 */
function world(Manager, { childMeta = {}, wielderMeta = {}, realResolve = false } = {}) {
  const wasmExports = {
    async fetchPhysicsScript() { return null; },
    async fetchParticleEmitter() { return null; },
    async fetchBuildingPlacement() { return { partCount: 0, free() {} }; },
  };
  const em = new Manager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  const attached = [];
  const resolved = [];
  em._attachParticleChainForEntity = (...a) => { attached.push(a); return Promise.resolve(); };
  if (!realResolve) em._playDefaultScriptResolved = (...a) => { resolved.push(a); };
  // Holding locations: key 1 (RightHand) → part 3, key 2 → part 3 too (two
  // items on one part), key 9 → the root (part -1).
  em._resolveHoldingLocation = async (_setup, key) => {
    const partId = key === 9 ? -1 : 3;
    return { partId, ox: 0, oy: 0, oz: 0, qw: 1, qx: 0, qy: 0, qz: 0 };
  };
  const W = rig(W_GUID, 6, wielderMeta);
  const C = rig(C_GUID, 1, childMeta);
  const C2 = rig(C2_GUID, 1, {});
  em.entityMap.set(W_GUID, W);
  em.entityMap.set(C_GUID, C);
  em.entityMap.set(C2_GUID, C2);
  return { em, W, C, C2, attached, resolved };
}
const hook18 = (em, W, partIndex) => em._fireHook(W, { hookType: 18, partIndex }, null, null);

// ---------------------------------------------------------------------------
test("1. genuine DEFAULT_SCRIPT_PART_CHILD_ON reader: exact `on` opt-in", () => {
  const m = entitiesSrc.match(/const DEFAULT_SCRIPT_PART_CHILD_ON = (\(\(\) => \{[\s\S]*?\n\}\)\(\));/);
  assert.ok(m, "reader found in entities.js");
  const read = (win) => new Function("window", `return ${m[1]};`)(win);
  const W = (search) => ({ location: { search } });
  assert.equal(read(W("")), false, "absent → off (default path unchanged)");
  assert.equal(read(W("?foo=1")), false, "other params → off");
  assert.equal(read(W("?defaultScriptPartChild=on")), true, "=on → on");
  assert.equal(read(W("?defaultScriptPartChild=ON")), true, "=ON → on (case-fold)");
  assert.equal(read(W("?defaultScriptPartChild=off")), false, "=off → off");
  assert.equal(read(W("?defaultScriptPartChild=1")), false, "=1 is not the opt-in value");
  assert.equal(read(undefined), false, "no window → off");
  assert.equal(read({}), false, "window without location → off");
});

test("2. source: the opt-in is the first hook-18 branch and gates nothing else", () => {
  assert.match(
    entitiesSrc,
    /if \(hookType === 18\) \{[\s\S]{0,500}?if \(DEFAULT_SCRIPT_PART_CHILD_ON\) \{\s*\n\s*this\._playHeldChildDefaultScript\(inst, partHint\);\s*\n\s*\} else if \(pesId !== 0\) \{\s*\n\s*this\._attachParticleChainForEntity\(inst\.guid >>> 0, inst\.root, pesId, 0, defaultPartIndex\)/,
  );
  // Legacy owner arm (test_a11_s5 / default_script_no_spawn_play pins) intact.
  assert.match(
    entitiesSrc,
    /hookType === 18[\s\S]{0,900}else if \(DEFAULT_SCRIPT_SPAWN_ON\)\s*\{[\s\S]{0,360}this\._playDefaultScriptResolved\(inst\.guid >>> 0, inst\.root, defaultPartIndex\);/,
  );
  const codeUses = entitiesSrc
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\bDEFAULT_SCRIPT_PART_CHILD_ON\b/.test(l));
  assert.equal(codeUses.length, 2, "declared once, read once (the hook 18 arm)");
});

test("3. opt-in: hook 18 on the held part plays the CHILD's default on the child", async () => {
  const { em, W, C, attached, resolved } = world(OnEM);
  await em.attachChildToParent(C_GUID, W_GUID, 1, 0);
  assert.equal(C.root.parent, W.parts[3], "genuine attach mounted the child on parts[3]");
  assert.ok(W._attachedChildren?.has(C_GUID));
  hook18(em, W, 3);
  assert.equal(resolved.length, 1, "one play");
  assert.equal(resolved[0][0], C_GUID, "owned by the child guid");
  assert.equal(resolved[0][1], C.root, "anchored on the child rig");
  assert.equal(resolved[0][2], undefined, "child's own anchors (no wielder part threaded)");
  assert.equal(attached.length, 0, "no raw 0x33 path");
  assert.equal(em._defaultScriptPartChildHits, 1);
  assert.equal(em._defaultScriptPartHookFires, 1, "hook counter still ticks");
  em.dispose();
});

test("4. opt-in: nothing held on the hook's part → nothing plays (owner ignored)", async () => {
  const { em, W, attached, resolved } = world(OnEM, { wielderMeta: { physicsScriptDid: RAW_WIELDER_PES } });
  await em.attachChildToParent(C_GUID, W_GUID, 1, 0); // on part 3
  hook18(em, W, 5);
  hook18(em, W, 0);
  // A wielder holding nothing at all.
  const { em: em2, W: W2, attached: a2, resolved: r2 } = world(OnEM, { wielderMeta: { physicsScriptDid: RAW_WIELDER_PES } });
  hook18(em2, W2, 3);
  await settle();
  assert.equal(resolved.length + attached.length, 0, "empty part → retail returns 0");
  assert.equal(r2.length + a2.length, 0, "the wielder's own raw 0x33 never plays from hook 18");
  assert.equal(em._defaultScriptPartChildHits | 0, 0);
  em.dispose();
  em2.dispose();
});

test("5. opt-in: a raw 0x33 child default attaches on the child", async () => {
  const { em, W, C, attached, resolved } = world(OnEM, { childMeta: { physicsScriptDid: RAW_CHILD_PES } });
  await em.attachChildToParent(C_GUID, W_GUID, 1, 0);
  hook18(em, W, 3);
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0], [C_GUID, C.root, RAW_CHILD_PES]);
  assert.equal(resolved.length, 0, "no PScriptType resolve for a raw DID");
  em.dispose();
});

test("6. opt-in: the root sentinel matches only a root-mounted child", async () => {
  const { em, W, C, C2, resolved } = world(OnEM);
  await em.attachChildToParent(C_GUID, W_GUID, 1, 0); // part 3
  hook18(em, W, 0xffffffff);
  assert.equal(resolved.length, 0, "a part-3 child is not at part_number 0xFFFFFFFF");
  await em.attachChildToParent(C2_GUID, W_GUID, 9, 0); // root
  assert.equal(C2.root.parent, W.root);
  hook18(em, W, 0xffffffff);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0][0], C2_GUID);
  assert.equal(resolved[0][1], C2.root);
  assert.notEqual(resolved[0][1], C.root);
  em.dispose();
});

test("7. opt-in: first match wins; detached and left-world children play nothing", async () => {
  const { em, W, C, C2, resolved } = world(OnEM);
  await em.attachChildToParent(C_GUID, W_GUID, 1, 0); // part 3
  await em.attachChildToParent(C2_GUID, W_GUID, 2, 0); // part 3 too
  hook18(em, W, 3);
  assert.equal(resolved.length, 1, "retail returns from inside the CHILDLIST loop");
  assert.equal(resolved[0][0], C_GUID, "the first child in attach order");

  // An out-of-world child still parented (retail `if (v5->cell)` fails): the
  // first match ends the walk without a play.
  C._leftWorld = true;
  hook18(em, W, 3);
  assert.equal(resolved.length, 1, "left-world child plays nothing");
  C._leftWorld = false;

  // Explicit detach (genuine _detachChild) takes C off the CHILDLIST.
  em._detachChild(C_GUID);
  assert.notEqual(C.root.parent, W.parts[3]);
  hook18(em, W, 3);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[1][0], C2_GUID, "C2 is now the child on part 3");
  em._detachChild(C2_GUID);
  hook18(em, W, 3);
  assert.equal(resolved.length, 2, "nothing held → nothing");
  em.dispose();
});

test("8. opt-in, end to end: the CHILD's own table + intensity pick the script", async () => {
  const { em, W, C, attached } = world(OnEM, { realResolve: true });
  await em.attachChildToParent(C_GUID, W_GUID, 1, 0);
  hook18(em, W, 3);
  assert.ok(await waitFor(() => attached.length > 0), "resolved and attached");
  await settle();
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].slice(0, 3), [C_GUID, C.root, CHILD_SCRIPT],
    "GetScript(child default 0x57, child intensity 0.5) through the child's table");
  assert.equal(attached[0][4], -1, "anchored on the child root, not the wielder part");
  assert.ok(!attached.some((a) => (a[2] >>> 0) === WIELDER_SCRIPT), "wielder table never used");
  em.dispose();
});

test("9. opt-in + `?defaultScriptSpawn=off`: PScriptType child silent, raw 0x33 child plays", async () => {
  const a = world(OnNoSpawnEM);
  await a.em.attachChildToParent(C_GUID, W_GUID, 1, 0);
  hook18(a.em, a.W, 3);
  assert.equal(a.resolved.length + a.attached.length, 0, "master switch off = 0x33-only");
  a.em.dispose();

  const b = world(OnNoSpawnEM, { childMeta: { physicsScriptDid: RAW_CHILD_PES } });
  await b.em.attachChildToParent(C_GUID, W_GUID, 1, 0);
  hook18(b.em, b.W, 3);
  assert.deepEqual(b.attached, [[C_GUID, b.C.root, RAW_CHILD_PES]]);
  b.em.dispose();
});

test("10. default and `=off`: the legacy owner-anchored hook 18 call", async () => {
  for (const Manager of [EntityManager, OffEM]) {
    const { em, W, C, attached, resolved } = world(Manager);
    let helperCalls = 0;
    em._playHeldChildDefaultScript = () => { helperCalls += 1; return 0; };
    await em.attachChildToParent(C_GUID, W_GUID, 1, 0);
    assert.equal(C.root.parent, W.parts[3]);
    hook18(em, W, 3);
    assert.equal(helperCalls, 0, "child walk never consulted");
    assert.deepEqual(resolved, [[W_GUID, W.root, 3]], "wielder's own default at part 3");
    assert.equal(attached.length, 0);
    em.dispose();

    const raw = world(Manager, { wielderMeta: { physicsScriptDid: RAW_WIELDER_PES } });
    hook18(raw.em, raw.W, 2);
    assert.deepEqual(raw.attached, [[W_GUID, raw.W.root, RAW_WIELDER_PES, 0, 2]]);
    assert.equal(raw.resolved.length, 0);
    raw.em.dispose();
  }
});
