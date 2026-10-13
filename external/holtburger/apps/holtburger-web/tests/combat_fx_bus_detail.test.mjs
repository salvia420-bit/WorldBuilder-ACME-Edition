// combat_fx_bus_detail.test.mjs — `?combatFxBus=on`: the carnage and blood
// bus handlers read the payload off `CustomEvent.detail`, behind a strict
// opt-in, with the default arm left exactly as shipped.
//
// NEW 2026-10-13. The plugin bus delivers `new CustomEvent(name, { detail:
// payload })` (plugins/api.js events.emit), but scene3d/carnage.js and
// scene3d/blood_decals.js subscribe `playEffect` with `({ targetGuid,
// scriptId }) => …` and `damageDealt` with `(d) => d.criticalHit …` — fields
// read straight off the Event, so on real traffic they are always `undefined`:
// no splatter decal, no limb/finisher automation, and neither crit latch ever
// sets (scripts/lint-event-consumers.mjs DETAIL_KNOWN_BUGS). The older suites
// never saw it because their fake bus calls `fn(payload)` directly
// (tests/carnage_hit_guard.test.mjs).
//
// Both modules are documented default-ON but have never actually fired in
// real play, so making them fire is a large visual change the owner has not
// eye-tested. The fix therefore ships behind `?combatFxBus=on` (exact), read
// once at install time; this suite pins both arms against a REAL EventTarget
// bus built the way plugins/api.js builds it:
//   §1 the flag is a strict opt-in in both modules
//   §2 carnage, default arm — a real CustomEvent still reaches nothing, the
//      raw-payload call the fake buses make still lands (unchanged)
//   §3 carnage, `?combatFxBus=on` — a real CustomEvent lands a hit, the crit
//      latch sets from a real `damageDealt` and is consumed, raw payloads and
//      malformed events are still survived
//   §4 blood, default arm — unchanged, as §2
//   §5 blood, `?combatFxBus=on` — a real splatter reaches `_splatterFromHit`
//      (3-ray fan) and a real crit widens it to the 6-ray crit fan
//
// `three` resolves to the shared `_three_stub.mjs` plus the few members the
// blood ray path touches (Raycaster/Sphere/Vector3 transforms); the stub
// Raycaster counts `set()` calls, i.e. the rays `_splatterFromHit` casts,
// which is how §4/§5 see the 3-vs-6 fan without a renderer. No geometry is
// hit and the terrain oracle answers null, so nothing is ever stamped.
//
// Run: node tests/combat_fx_bus_detail.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_STUB = pathToFileURL(resolvePath(__dirname, "../_three_stub.mjs")).href;
const STUB_SRC = `
import { Vector3 as BaseVector3 } from ${JSON.stringify(BASE_STUB)};
export * from ${JSON.stringify(BASE_STUB)};
export class Vector3 extends BaseVector3 {
  applyMatrix4() { return this; }
  applyMatrix3() { return this; }
  transformDirection() { return this; }
  normalize() { return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}
export class Sphere {
  constructor() { this.center = new Vector3(); this.radius = 0; }
  copy(s) { this.center.copy(s.center); this.radius = s.radius; return this; }
  applyMatrix4() { return this; }
}
export class Raycaster {
  constructor() { this.layers = { enable() {} }; this.far = Infinity; }
  set() { globalThis.__combatFxRaySets = (globalThis.__combatFxRaySets || 0) + 1; return this; }
  intersectObjects() { return []; }
}
`;
const STUB_URL = "data:text/javascript," + encodeURIComponent(STUB_SRC);
const LOADER_SRC = `export async function resolve(s, c, next) {
  if (s === "three") return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true, format: "module" };
  return next(s, c);
}`;
register("data:text/javascript," + encodeURIComponent(LOADER_SRC));

/* ── the browser surface both modules read ────────────────────────────── */

/** entityMap that records every guid it is asked for. */
class SpyMap extends Map {
  constructor() {
    super();
    this.gets = [];
  }
  get(k) {
    this.gets.push(k);
    return super.get(k);
  }
}
const entityMap = new SpyMap();

// 8 Setup slots: 0 = root, {1,2} leg leaves via hips {6,7}, {3,4} high chains
// (the carnage_hit_guard / limbs fixture — classifies as a 2-legged rig).
const PARENT_ROOT = 0xffffffff;
const PARENT_INDEX = new Uint32Array([PARENT_ROOT, 6, 7, 0, 0, PARENT_ROOT, 0, 0]);

globalThis.window = {
  location: { search: "" },
  getLocalPlayerGuid: () => 0xdeadbeef,
  __pluginClient: null,
  liveScene3d: {
    // blood: `_splatterFromHit` needs a group to get past its first guard.
    entitiesGroup: { updateWorldMatrix() {}, matrixWorld: {} },
    // blood: the analytic terrain oracle — null ⇒ outdoor via the spawn stamp,
    // and the down-rays never stamp (no decal pool is ever built).
    sessionHandle: { terrainHeightAt: () => null },
    entityManager: {
      entityMap,
      wasmExports: {
        async fetchSetupParentIndex() {
          return PARENT_INDEX;
        },
      },
    },
  },
};

/**
 * The plugin bus exactly as plugins/api.js builds it — `events.on` is
 * `addEventListener`, `events.emit` dispatches `new CustomEvent(name,
 * { detail: payload })` — plus a record of each listener so a section can
 * also call it the way the older fake buses do (`fn(payload)`).
 */
function makePluginClient() {
  const bus = new EventTarget();
  const listeners = new Map();
  return {
    listeners,
    events: {
      on(name, handler) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(handler);
        bus.addEventListener(name, handler);
      },
      off(name, handler) {
        bus.removeEventListener(name, handler);
      },
      once(name, handler) {
        bus.addEventListener(name, handler, { once: true });
      },
      emit(name, payload) {
        bus.dispatchEvent(new CustomEvent(name, { detail: payload }));
      },
    },
  };
}

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
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const quiet = async (fn) => {
  const realInfo = console.info;
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.info = realInfo;
  }
};
const raySets = () => globalThis.__combatFxRaySets || 0;

/** A rig the limb registry classifies, with a root blood can place a wound on. */
let nextSetup = 0xa000;
function makeInst(guid, name) {
  const parts = [];
  const zs = [1.0, 0.0, 0.05, 1.2, 1.3];
  for (let p = 0; p < 5; p++) {
    parts.push({
      position: { x: 0, y: 0, z: zs[p], set() {} },
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
  for (let p = 0; p < 5; p++) {
    origins[p * 3 + 2] = zs[p];
    orients[p * 4] = 1;
  }
  const inst = {
    guid,
    _setupId: nextSetup++,
    parts,
    _restOrigins: origins,
    _restOrientations: orients,
    root: { position: { x: 10, y: 20, z: 30 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, parent: {} },
    meta: { name },
  };
  entityMap.set(guid, inst);
  return inst;
}

// Payload shapes as shipped: app/client_events.js kind=PlayEffect emits
// {targetGuid, scriptId, speed}; the kind=19 combat family emits the parsed
// JSON (src/session/messages/game_event.rs: defenderName, criticalHit, …).
const SPLATTER_LOW_LEFT_FRONT = 0x5c; // Low band ⇒ always a leg (no coin flip)
const splatter = (guid) => ({ targetGuid: guid, scriptId: SPLATTER_LOW_LEFT_FRONT, speed: 1 });
const dealt = (defenderName, criticalHit) => ({
  type: "damageDealt", defenderName, damage: 7, damageType: 1, healthPercent: 0.8, criticalHit,
});
const legHits = (inst) => [...(inst._carnage?.hits?.values() ?? [])];

/* ── 1. flag polarity ─────────────────────────────────────────────────── */
section("?combatFxBus is a STRICT opt-in (`=== \"on\"`) in both modules");
{
  const carnage = await import("../scene3d/carnage.js?arm=polarity");
  const blood = await import("../scene3d/blood_decals.js?arm=polarity");
  for (const [label, fn] of [["carnage", carnage.combatFxBusEnabled], ["blood", blood.combatFxBusEnabled]]) {
    window.location.search = "";
    ok(fn() === false, `${label}: an ABSENT ?combatFxBus reads OFF (default arm unchanged)`);
    window.location.search = "?combatFxBus=on";
    ok(fn() === true, `${label}: ?combatFxBus=on opts in`);
    for (const v of ["1", "true", "ON", "off", ""]) {
      window.location.search = `?combatFxBus=${v}`;
      ok(fn() === false, `${label}: ?combatFxBus=${v} is NOT the opt-in`);
    }
  }
  window.location.search = "";
}

/* ── 2. carnage, default arm ──────────────────────────────────────────── */
section("carnage — default arm: real bus traffic still reaches nothing (unchanged)");
{
  window.location.search = "";
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const { installCarnage } = await import("../scene3d/carnage.js?arm=off");
  await quiet(() => installCarnage());
  ok((pc.listeners.get("playEffect") ?? []).length === 1, "the splatter listener is subscribed");
  ok((pc.listeners.get("damageDealt") ?? []).length === 1, "…and the crit latch");

  const GUID = 0x2001;
  const inst = makeInst(GUID, "Drudge Default");
  entityMap.gets.length = 0;
  pc.events.emit("damageDealt", dealt("Drudge Default", true));
  pc.events.emit("playEffect", splatter(GUID));
  await tick();
  ok(!entityMap.gets.includes(GUID), "a real CustomEvent never gets as far as the entity lookup");
  ok(inst._carnage === undefined, "…so no hit lands (the shipped, non-firing default)");

  // The fake-bus shape (fn(payload)) the older suites use still lands — the
  // default arm subscribes the very same handler it always did.
  pc.listeners.get("playEffect")[0](splatter(GUID));
  await tick();
  ok(inst._carnage?.totalHits === 1, `a raw-payload call still lands one hit (got ${inst._carnage?.totalHits})`);
  ok(inst._carnage?.lastCritAt === 0,
    "…and it is NOT a crit: the real damageDealt above never latched on the default arm");
  ok(legHits(inst).join() === "1", `…so the leg took a single hit (got [${legHits(inst)}])`);
}

/* ── 3. carnage, ?combatFxBus=on ──────────────────────────────────────── */
section("carnage — ?combatFxBus=on: a real CustomEvent reaches the splatter and crit logic");
{
  window.location.search = "?combatFxBus=on";
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const { installCarnage } = await import("../scene3d/carnage.js?arm=on");
  await quiet(() => installCarnage());
  ok((pc.listeners.get("playEffect") ?? []).length === 1, "the splatter listener is subscribed");
  ok((pc.listeners.get("damageDealt") ?? []).length === 1, "…and the crit latch");

  // A crit rolls for a dislocation (dismember, not under test here) — pin the
  // roll high so the escalation draw is always "nothing".
  const realRandom = Math.random;
  Math.random = () => 0.999;
  try {
    const GUID = 0x3001;
    const inst = makeInst(GUID, "Drudge Crit");
    pc.events.emit("damageDealt", dealt("Drudge Crit", true));
    pc.events.emit("playEffect", splatter(GUID));
    await tick();
    ok(inst._carnage?.totalHits === 1, `a real splatter CustomEvent lands a hit (got ${inst._carnage?.totalHits})`);
    ok(inst._carnage?.lastCritAt > 0, "…flagged CRITICAL by a real damageDealt CustomEvent (the latch set)");
    ok(legHits(inst).join() === "2", `…so the leg took the crit's double hit (got [${legHits(inst)}])`);
    ok(inst._limbDamage instanceof Map && inst._limbDamage.size === 1,
      "…which is already a limp (2 leg hits) — the visible effect the default arm never reaches");

    pc.events.emit("playEffect", splatter(GUID));
    await tick();
    ok(inst._carnage?.totalHits === 2, "a second real splatter lands too");
    ok(legHits(inst).join() === "3", `…as a plain hit: the latch was consumed by the first (got [${legHits(inst)}])`);

    const CALM = 0x3002;
    const calm = makeInst(CALM, "Drudge Calm");
    pc.events.emit("damageDealt", dealt("Drudge Calm", false));
    pc.events.emit("playEffect", splatter(CALM));
    await tick();
    ok(calm._carnage?.totalHits === 1 && calm._carnage.lastCritAt === 0,
      "a non-critical damageDealt does not latch");

    // kill_impulse.js's `d?.detail ?? d`: a fake bus passing the raw payload
    // still works under the flag (carnage_hit_guard's shape).
    const RAW = 0x3003;
    const raw = makeInst(RAW, "Drudge Raw");
    pc.listeners.get("playEffect")[0](splatter(RAW));
    await tick();
    ok(raw._carnage?.totalHits === 1, "a raw-payload call still lands under the flag");

    const SELF = 0xdeadbeef;
    const self = makeInst(SELF, "Me");
    pc.events.emit("playEffect", splatter(SELF));
    await tick();
    ok(self._carnage === undefined, "the local player stays exempt");

    pc.events.emit("playEffect", undefined);
    pc.events.emit("playEffect", {});
    pc.events.emit("damageDealt", null);
    pc.listeners.get("playEffect")[0](undefined);
    pc.listeners.get("damageDealt")[0](undefined);
    await tick();
    ok(true, "empty / malformed events are swallowed, never thrown into the bus");
  } finally {
    Math.random = realRandom;
  }
}

/* ── 4. blood, default arm ────────────────────────────────────────────── */
section("blood — default arm: real bus traffic still stamps nothing (unchanged)");
{
  window.location.search = "";
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const blood = await import("../scene3d/blood_decals.js?arm=off");
  await quiet(() => blood.installBloodDecals());
  ok((pc.listeners.get("playEffect") ?? []).length === 1, "the splatter listener is subscribed");
  ok((pc.listeners.get("damageDealt") ?? []).length === 1, "…and the crit latch");
  ok(window.__diag?.blood?.stats().bound === true, "__diag.blood.stats().bound reports the subscription");

  const GUID = 0x4001;
  makeInst(GUID, "Bleeder Default");
  const before = raySets();
  entityMap.gets.length = 0;
  pc.events.emit("damageDealt", dealt("Bleeder Default", true));
  pc.events.emit("playEffect", splatter(GUID));
  ok(!entityMap.gets.includes(GUID), "a real CustomEvent never gets as far as the entity lookup");
  ok(raySets() === before, "…so no ray is cast (the shipped, non-firing default)");

  pc.listeners.get("playEffect")[0](splatter(GUID));
  ok(raySets() - before === blood.BLOOD_RAYS_HIT,
    `a raw-payload call still splatters — the NORMAL ${blood.BLOOD_RAYS_HIT}-ray fan, since the real ` +
    `damageDealt never latched (got ${raySets() - before})`);
}

/* ── 5. blood, ?combatFxBus=on ────────────────────────────────────────── */
section("blood — ?combatFxBus=on: a real CustomEvent reaches the splatter and crit logic");
{
  window.location.search = "?combatFxBus=on";
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const blood = await import("../scene3d/blood_decals.js?arm=on");
  await quiet(() => blood.installBloodDecals());
  ok((pc.listeners.get("playEffect") ?? []).length === 1, "the splatter listener is subscribed");

  const GUID = 0x5001;
  makeInst(GUID, "Bleeder On");
  let before = raySets();
  entityMap.gets.length = 0;
  pc.events.emit("playEffect", splatter(GUID));
  ok(entityMap.gets.includes(GUID), "a real splatter CustomEvent reaches the entity lookup");
  ok(raySets() - before === blood.BLOOD_RAYS_HIT,
    `…and _splatterFromHit casts the normal ${blood.BLOOD_RAYS_HIT}-ray fan (got ${raySets() - before})`);

  before = raySets();
  pc.events.emit("damageDealt", dealt("Bleeder On", true));
  pc.events.emit("playEffect", splatter(GUID));
  ok(raySets() - before === blood.BLOOD_RAYS_CRIT,
    `a real crit damageDealt widens the next splatter to the ${blood.BLOOD_RAYS_CRIT}-ray crit fan ` +
    `(got ${raySets() - before})`);

  const RAW = 0x5002;
  makeInst(RAW, "Bleeder Raw");
  before = raySets();
  pc.listeners.get("playEffect")[0](splatter(RAW));
  ok(raySets() - before === blood.BLOOD_RAYS_HIT, "a raw-payload call still splatters under the flag");

  before = raySets();
  pc.events.emit("playEffect", undefined);
  pc.events.emit("playEffect", { targetGuid: GUID, scriptId: 0x01, speed: 1 });
  pc.events.emit("damageDealt", null);
  pc.listeners.get("playEffect")[0](undefined);
  pc.listeners.get("damageDealt")[0](undefined);
  ok(raySets() === before, "empty, malformed and non-Splatter events cast nothing and never throw");
}

console.log(`\ncombat_fx_bus_detail: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
