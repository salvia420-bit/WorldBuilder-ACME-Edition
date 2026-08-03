// carnage_hit_guard.test.mjs — the post-await identity guard on the splatter
// path, driven end-to-end through the REAL wiring.
//
// NEW 2026-08-03. `_onSplatterHit` awaits `ensureLimbRegistry` and then mutates
// the captured instance — `_carnageState(inst)`, `st.totalHits++`,
// `setLimbDamage`, `_severLeg` — with no check that `inst` is still the live
// rig for its guid. That await is NOT a rare path: the registry is cold for the
// FIRST entity of every Setup, so the very first splatter on any new creature
// species takes it. If ACE re-issued the same guid for a fresh rig meanwhile
// (LOD respawn / re-stream), every hit landed on the detached instance: the new
// rig never limps or severs, and dismember's own `inst._disposed` guard eats
// the slice silently.
//
// The established shape is identity, never `entityMap.has(guid)` — a same-guid
// respawn passes `.has()`. That is exactly what §2 asserts by respawning INSIDE
// the await window, which is the only place the two forms differ.
//
// This suite drives the shipped path, not a hand-built one: it installs the
// real bus listener via `installCarnage()`, emits a real `playEffect` payload
// in the shape `index.html:8872` emits, and lets the module resolve the limb
// registry through the real `liveScene3d.entityManager.wasmExports` seam — with
// the wasm promise held open so the respawn can land mid-flight.
//
// Run: node tests/carnage_hit_guard.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

/* ── the browser surface carnage.js reads ─────────────────────────────── */

const handlers = new Map();
const entityMap = new Map();
let parentIndexGate = Promise.resolve();

// 8 Setup slots: 0 = root, {1,2} leg leaves via hips {6,7}, {3,4} high chains.
// The same fixture the limbs suite uses, and it classifies as a 2-legged rig.
const PARENT_ROOT = 0xffffffff;
const PARENT_INDEX = new Uint32Array([PARENT_ROOT, 6, 7, 0, 0, PARENT_ROOT, 0, 0]);

globalThis.window = {
  location: { search: "" }, // ?carnage absent ⇒ DEFAULT ON
  getLocalPlayerGuid: () => 0xdeadbeef,
  __pluginClient: {
    events: {
      on(name, fn) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
      },
      emit(name, payload) {
        for (const fn of handlers.get(name) ?? []) fn(payload);
      },
    },
  },
  liveScene3d: {
    entityManager: {
      entityMap,
      wasmExports: {
        async fetchSetupParentIndex() {
          await parentIndexGate;
          return PARENT_INDEX;
        },
      },
    },
  },
};

const { installCarnage } = await import("../scene3d/carnage.js");
const { clearLimbRegistryCache, getLimbRegistry } = await import("../scene3d/limbs.js");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/* A rig with enough decoded parts + rest arrays for the registry to classify. */
let nextSetup = 0x9000;
function makeInst(guid, setupId) {
  const parts = [];
  for (let p = 0; p < 5; p++) {
    parts.push({
      position: { x: 0, y: 0, z: 0, set() {} },
      quaternion: { x: 0, y: 0, z: 0, w: 1, set() {} },
      children: [{
        geometry: { boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } },
        userData: { partIndex: p },
      }],
      visible: true,
    });
  }
  const origins = new Float32Array(15);
  const orients = new Float32Array(20);
  // Two low chains (the legs) and two high ones, so the leg split has a gap.
  const zs = [1.0, 0.0, 0.05, 1.2, 1.3];
  for (let p = 0; p < 5; p++) {
    origins[p * 3 + 2] = zs[p];
    orients[p * 4] = 1;
  }
  return {
    guid,
    _setupId: setupId,
    parts,
    _restOrigins: origins,
    _restOrientations: orients,
    root: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, parent: {} },
    meta: { name: "Drudge Slave" },
  };
}

/** One broadcast splatter, in the payload shape index.html:8872 emits. */
function splatter(guid) {
  window.__pluginClient.events.emit("playEffect", { targetGuid: guid, scriptId: 0x5c, speed: 1 });
}

/* ── 1. arming ────────────────────────────────────────────────────────── */
section("arming");
{
  const realLog = console.info;
  console.info = () => {};
  installCarnage();
  console.info = realLog;
  ok((handlers.get("playEffect") ?? []).length === 1, "installCarnage subscribed the splatter listener");
  ok((handlers.get("damageDealt") ?? []).length === 1, "…and the crit latch");
  ok(typeof window.__carnageOnDeath === "function", "…and published the death hook entities.js calls");
}

/* ── 2. REGRESSION: a same-guid respawn inside the await ──────────────── */
section("same-guid respawn during the registry fetch (2026-08-03 lock)");
{
  clearLimbRegistryCache();
  const GUID = 0x1001;
  const SETUP = nextSetup++;
  const oldInst = makeInst(GUID, SETUP);
  entityMap.set(GUID, oldInst);

  // Hold the wasm fetch open so the respawn lands mid-await, exactly as a
  // re-stream does while the first entity of a Setup is classifying.
  let release;
  parentIndexGate = new Promise((r) => { release = r; });

  splatter(GUID);
  await tick(2);
  ok(getLimbRegistry(SETUP) === null, "the registry really is still in flight (the await is live)");

  // ACE re-issues the SAME guid for a FRESH rig. `entityMap.has(GUID)` is still
  // true — which is why `.has()` is the wrong guard.
  const newInst = makeInst(GUID, SETUP);
  entityMap.set(GUID, newInst);
  oldInst.root.parent = null; // dispose() detaches the root
  ok(entityMap.has(GUID), "…and a `.has(guid)` check would still pass (the trap)");

  release();
  await tick(20);

  ok(getLimbRegistry(SETUP) !== null, "the registry finished building (the fetch was not wasted)");
  ok(oldInst._carnage === undefined,
    "the DETACHED instance accumulated no carnage state (pre-fix: totalHits 1 on a dead rig)");
  ok(oldInst._limbDamage === undefined, "…and no limb damage was written to it");
  ok(newInst._carnage === undefined, "…and the hit is dropped, not silently re-attributed to the new rig");
  parentIndexGate = Promise.resolve();
}

/* ── 3. POSITIVE CONTROL: the same flow with no respawn must still land ── */
section("positive control");
{
  clearLimbRegistryCache();
  const GUID = 0x1002;
  const SETUP = nextSetup++;
  const inst = makeInst(GUID, SETUP);
  entityMap.set(GUID, inst);

  let release;
  parentIndexGate = new Promise((r) => { release = r; });
  splatter(GUID);
  await tick(2);
  release();
  await tick(20);

  ok(inst._carnage !== undefined, "an entity that is still live DOES accumulate carnage state");
  ok(inst._carnage.totalHits === 1, `…exactly one hit (got ${inst._carnage?.totalHits})`);
  ok(inst._carnage.severed.size === 0, "…and a single Low-band hit severs nothing");

  // The registry is now warm, so the second hit takes the SYNCHRONOUS path —
  // the branch the guard must not disturb.
  splatter(GUID);
  await tick(20);
  ok(inst._carnage.totalHits === 2, "a second hit on a warm registry still lands (sync path unguarded)");
  parentIndexGate = Promise.resolve();
}

/* ── 4. the other rejections on that path ─────────────────────────────── */
section("bus hygiene");
{
  clearLimbRegistryCache();
  // The local player is exempt — it is the camera rig.
  const SELF = 0xdeadbeef;
  const self = makeInst(SELF, nextSetup++);
  entityMap.set(SELF, self);
  splatter(SELF);
  await tick(20);
  ok(self._carnage === undefined, "the local player is exempt from carnage");

  // A non-splatter PlayScript decodes to null and must be ignored.
  const GUID = 0x1003;
  const inst = makeInst(GUID, nextSetup++);
  entityMap.set(GUID, inst);
  window.__pluginClient.events.emit("playEffect", { targetGuid: GUID, scriptId: 0x01, speed: 1 });
  await tick(20);
  ok(inst._carnage === undefined, "a non-Splatter script is not a hit");

  // An unknown guid, and a rig with no parts, must not throw on the shared bus.
  splatter(0xabcdef01);
  entityMap.set(0x1004, { guid: 0x1004, parts: [], _setupId: 1 });
  splatter(0x1004);
  await tick(20);
  ok(true, "an unmapped guid and a part-less rig are both survived without throwing");

  // A malformed payload must not break the bus for the listeners behind us.
  window.__pluginClient.events.emit("playEffect", {});
  window.__pluginClient.events.emit("playEffect", { targetGuid: null, scriptId: null });
  ok(true, "a malformed playEffect payload is swallowed, not rethrown into the bus");
}

console.log(`\ncarnage_hit_guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
