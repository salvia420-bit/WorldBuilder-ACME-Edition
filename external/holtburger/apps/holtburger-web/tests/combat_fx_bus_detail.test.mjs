// combat_fx_bus_detail.test.mjs — `?combatFxBus` (DEFAULT ON since
// 2026-10-19): the carnage and blood bus handlers read the payload off
// `CustomEvent.detail`; `?combatFxBus=off` (also 0/false/no) restores the
// legacy non-firing arm.
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
// Both modules are documented default-ON but had never actually fired in
// real play, so making them fire is a large visual change. The fix shipped
// 2026-10-13 behind an exact `?combatFxBus=on` and went DEFAULT ON
// 2026-10-19, ahead of its 1070 eye test (still owed). The flag is read once
// at install time; this suite pins both arms against a REAL EventTarget bus
// built the way plugins/api.js builds it:
//   §1 the flag is DEFAULT ON with an off/0/false/no escape in both modules
//   §2 carnage, `=off` escape arm — a real CustomEvent reaches nothing, the
//      raw-payload call the fake buses make still lands (the legacy arm)
//   §3 carnage, bare default (and an explicit `=on`) — a real CustomEvent
//      lands a hit, the crit latch sets from a real `damageDealt` and is
//      consumed, raw payloads and malformed events are still survived
//   §4 blood, `=off` escape arm — as §2
//   §5 blood, bare default (and an explicit `=on`) — a real splatter reaches
//      `_splatterFromHit` (3-ray fan) and a real crit widens it to the 6-ray
//      crit fan
//   §2-§5 also pin the console tell: it fires only on the `=off` escape
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
/** Runs `fn` with console.info captured; returns the `combatFxBus` tell lines. */
const busTells = async (fn) => {
  const realInfo = console.info;
  const lines = [];
  console.info = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.info = realInfo;
  }
  return lines.filter((l) => l.includes("combatFxBus"));
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
section("?combatFxBus is DEFAULT ON (2026-10-19) with an off|0|false|no escape in both modules");
{
  const carnage = await import("../scene3d/carnage.js?arm=polarity");
  const blood = await import("../scene3d/blood_decals.js?arm=polarity");
  for (const [label, fn] of [["carnage", carnage.combatFxBusEnabled], ["blood", blood.combatFxBusEnabled]]) {
    window.location.search = "";
    ok(fn() === true, `${label}: an ABSENT ?combatFxBus reads ON (the bare default fires)`);
    window.location.search = "?other=1";
    ok(fn() === true, `${label}: a query without ?combatFxBus reads ON`);
    for (const v of ["on", "ON", "1", "true", "yes", "", "garbage"]) {
      window.location.search = `?combatFxBus=${v}`;
      ok(fn() === true, `${label}: ?combatFxBus=${v} reads ON (only the off forms escape)`);
    }
    for (const v of ["off", "0", "false", "no", "OFF", "No", "FALSE", "%20off%20"]) {
      window.location.search = `?combatFxBus=${v}`;
      ok(fn() === false, `${label}: ?combatFxBus=${v} is the escape (trimmed, case-insensitive)`);
    }
    // No `window` at all (a worker, a test without the shim): the catch arm
    // must return the default, i.e. ON.
    const realWindow = globalThis.window;
    globalThis.window = undefined;
    try {
      ok(fn() === true, `${label}: a missing window falls back to the default (ON)`);
    } finally {
      globalThis.window = realWindow;
    }
  }
  window.location.search = "";
}

/* ── 2. carnage, ?combatFxBus=off escape ──────────────────────────────── */
section("carnage — ?combatFxBus=off escape: real bus traffic reaches nothing (the legacy arm)");
{
  window.location.search = "?combatFxBus=off";
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const { installCarnage } = await import("../scene3d/carnage.js?arm=off");
  const tells = await busTells(() => installCarnage());
  ok(tells.length === 1 && tells[0].startsWith("[carnage] ?combatFxBus=off"),
    `the escape logs its one console tell (got ${JSON.stringify(tells)})`);
  ok((pc.listeners.get("playEffect") ?? []).length === 1, "the splatter listener is subscribed");
  ok((pc.listeners.get("damageDealt") ?? []).length === 1, "…and the crit latch");

  const GUID = 0x2001;
  const inst = makeInst(GUID, "Drudge Escaped");
  entityMap.gets.length = 0;
  pc.events.emit("damageDealt", dealt("Drudge Escaped", true));
  pc.events.emit("playEffect", splatter(GUID));
  await tick();
  ok(!entityMap.gets.includes(GUID), "a real CustomEvent never gets as far as the entity lookup");
  ok(inst._carnage === undefined, "…so no hit lands (the legacy non-firing escape arm)");

  // The fake-bus shape (fn(payload)) the older suites use still lands — the
  // escape subscribes the very same handler the pre-flip default did.
  pc.listeners.get("playEffect")[0](splatter(GUID));
  await tick();
  ok(inst._carnage?.totalHits === 1, `a raw-payload call still lands one hit (got ${inst._carnage?.totalHits})`);
  ok(inst._carnage?.lastCritAt === 0,
    "…and it is NOT a crit: the real damageDealt above never latched on the =off arm");
  ok(legHits(inst).join() === "1", `…so the leg took a single hit (got [${legHits(inst)}])`);
}

/* ── 3. carnage, bare default (and an explicit =on) ───────────────────── */
// Two passes over fresh module instances: the BARE URL pins the new default,
// `?combatFxBus=on` keeps the 2026-10-13 spelling working.
for (const [k, search, armLabel] of [[0, "", "bare default"], [1, "?combatFxBus=on", "?combatFxBus=on"]]) {
  section(`carnage — ${armLabel} (combatFxBus DEFAULT ON): a real CustomEvent reaches the splatter and crit logic`);
  window.location.search = search;
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const { installCarnage } = await import(`../scene3d/carnage.js?arm=on${k}`);
  const tells = await busTells(() => installCarnage());
  ok(tells.length === 0, `${armLabel}: no combatFxBus console tell on the default arm (got ${JSON.stringify(tells)})`);
  ok((pc.listeners.get("playEffect") ?? []).length === 1, `${armLabel}: the splatter listener is subscribed`);
  ok((pc.listeners.get("damageDealt") ?? []).length === 1, `${armLabel}: …and the crit latch`);

  // A crit rolls for a dislocation (dismember, not under test here) — pin the
  // roll high so the escalation draw is always "nothing".
  const realRandom = Math.random;
  Math.random = () => 0.999;
  try {
    const base = 0x3000 + k * 0x100;
    const GUID = base + 1;
    const critName = `Drudge Crit ${k}`;
    const inst = makeInst(GUID, critName);
    pc.events.emit("damageDealt", dealt(critName, true));
    pc.events.emit("playEffect", splatter(GUID));
    await tick();
    ok(inst._carnage?.totalHits === 1,
      `${armLabel}: a real splatter CustomEvent lands a hit (got ${inst._carnage?.totalHits})`);
    ok(inst._carnage?.lastCritAt > 0,
      `${armLabel}: …flagged CRITICAL by a real damageDealt CustomEvent (the latch set)`);
    ok(legHits(inst).join() === "2", `${armLabel}: …so the leg took the crit's double hit (got [${legHits(inst)}])`);
    ok(inst._limbDamage instanceof Map && inst._limbDamage.size === 1,
      `${armLabel}: …which is already a limp (2 leg hits) — the visible effect the =off arm never reaches`);

    pc.events.emit("playEffect", splatter(GUID));
    await tick();
    ok(inst._carnage?.totalHits === 2, `${armLabel}: a second real splatter lands too`);
    ok(legHits(inst).join() === "3",
      `${armLabel}: …as a plain hit: the latch was consumed by the first (got [${legHits(inst)}])`);

    const CALM = base + 2;
    const calmName = `Drudge Calm ${k}`;
    const calm = makeInst(CALM, calmName);
    pc.events.emit("damageDealt", dealt(calmName, false));
    pc.events.emit("playEffect", splatter(CALM));
    await tick();
    ok(calm._carnage?.totalHits === 1 && calm._carnage.lastCritAt === 0,
      `${armLabel}: a non-critical damageDealt does not latch`);

    // kill_impulse.js's `d?.detail ?? d`: a fake bus passing the raw payload
    // still works on the default arm (carnage_hit_guard's shape).
    const RAW = base + 3;
    const raw = makeInst(RAW, `Drudge Raw ${k}`);
    pc.listeners.get("playEffect")[0](splatter(RAW));
    await tick();
    ok(raw._carnage?.totalHits === 1, `${armLabel}: a raw-payload call still lands`);

    const SELF = 0xdeadbeef;
    const self = makeInst(SELF, "Me");
    pc.events.emit("playEffect", splatter(SELF));
    await tick();
    ok(self._carnage === undefined, `${armLabel}: the local player stays exempt`);

    pc.events.emit("playEffect", undefined);
    pc.events.emit("playEffect", {});
    pc.events.emit("damageDealt", null);
    pc.listeners.get("playEffect")[0](undefined);
    pc.listeners.get("damageDealt")[0](undefined);
    await tick();
    ok(true, `${armLabel}: empty / malformed events are swallowed, never thrown into the bus`);
  } finally {
    Math.random = realRandom;
  }
}

/* ── 4. blood, ?combatFxBus=off escape ────────────────────────────────── */
section("blood — ?combatFxBus=off escape: real bus traffic stamps nothing (the legacy arm)");
{
  window.location.search = "?combatFxBus=off";
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const blood = await import("../scene3d/blood_decals.js?arm=off");
  const tells = await busTells(() => blood.installBloodDecals());
  ok(tells.length === 1 && tells[0].startsWith("[blood] ?combatFxBus=off"),
    `the escape logs its one console tell (got ${JSON.stringify(tells)})`);
  ok((pc.listeners.get("playEffect") ?? []).length === 1, "the splatter listener is subscribed");
  ok((pc.listeners.get("damageDealt") ?? []).length === 1, "…and the crit latch");
  ok(window.__diag?.blood?.stats().bound === true, "__diag.blood.stats().bound reports the subscription");

  const GUID = 0x4001;
  makeInst(GUID, "Bleeder Escaped");
  const before = raySets();
  entityMap.gets.length = 0;
  pc.events.emit("damageDealt", dealt("Bleeder Escaped", true));
  pc.events.emit("playEffect", splatter(GUID));
  ok(!entityMap.gets.includes(GUID), "a real CustomEvent never gets as far as the entity lookup");
  ok(raySets() === before, "…so no ray is cast (the legacy non-firing escape arm)");

  pc.listeners.get("playEffect")[0](splatter(GUID));
  ok(raySets() - before === blood.BLOOD_RAYS_HIT,
    `a raw-payload call still splatters — the NORMAL ${blood.BLOOD_RAYS_HIT}-ray fan, since the real ` +
    `damageDealt never latched (got ${raySets() - before})`);
}

/* ── 5. blood, bare default (and an explicit =on) ─────────────────────── */
for (const [k, search, armLabel] of [[0, "", "bare default"], [1, "?combatFxBus=on", "?combatFxBus=on"]]) {
  section(`blood — ${armLabel} (combatFxBus DEFAULT ON): a real CustomEvent reaches the splatter and crit logic`);
  window.location.search = search;
  const pc = makePluginClient();
  window.__pluginClient = pc;
  const blood = await import(`../scene3d/blood_decals.js?arm=on${k}`);
  const tells = await busTells(() => blood.installBloodDecals());
  ok(tells.length === 0, `${armLabel}: no combatFxBus console tell on the default arm (got ${JSON.stringify(tells)})`);
  ok((pc.listeners.get("playEffect") ?? []).length === 1, `${armLabel}: the splatter listener is subscribed`);

  const base = 0x5000 + k * 0x100;
  const GUID = base + 1;
  const name = `Bleeder On ${k}`;
  makeInst(GUID, name);
  let before = raySets();
  entityMap.gets.length = 0;
  pc.events.emit("playEffect", splatter(GUID));
  ok(entityMap.gets.includes(GUID), `${armLabel}: a real splatter CustomEvent reaches the entity lookup`);
  ok(raySets() - before === blood.BLOOD_RAYS_HIT,
    `${armLabel}: …and _splatterFromHit casts the normal ${blood.BLOOD_RAYS_HIT}-ray fan (got ${raySets() - before})`);

  before = raySets();
  pc.events.emit("damageDealt", dealt(name, true));
  pc.events.emit("playEffect", splatter(GUID));
  ok(raySets() - before === blood.BLOOD_RAYS_CRIT,
    `${armLabel}: a real crit damageDealt widens the next splatter to the ${blood.BLOOD_RAYS_CRIT}-ray crit fan ` +
    `(got ${raySets() - before})`);

  const RAW = base + 2;
  makeInst(RAW, `Bleeder Raw ${k}`);
  before = raySets();
  pc.listeners.get("playEffect")[0](splatter(RAW));
  ok(raySets() - before === blood.BLOOD_RAYS_HIT, `${armLabel}: a raw-payload call still splatters`);

  before = raySets();
  pc.events.emit("playEffect", undefined);
  pc.events.emit("playEffect", { targetGuid: GUID, scriptId: 0x01, speed: 1 });
  pc.events.emit("damageDealt", null);
  pc.listeners.get("playEffect")[0](undefined);
  pc.listeners.get("damageDealt")[0](undefined);
  ok(raySets() === before, `${armLabel}: empty, malformed and non-Splatter events cast nothing and never throw`);
}

console.log(`\ncombat_fx_bus_detail: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
