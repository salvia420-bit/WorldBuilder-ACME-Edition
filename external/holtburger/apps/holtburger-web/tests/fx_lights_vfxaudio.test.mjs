// tests/fx_lights_vfxaudio.test.mjs — the tier-1 FX light carriers keep
// `scene3d.activeLights` honest (2026-10-18 systematic review, VFXAUDIO-1/2/3).
// scene3d/vfx/fx_lights.js + the binding in scene3d/particles/particle_manager.js.
//
//   VFXAUDIO-1  a flash evicted by the 10-flash cap leaves activeLights. It used
//               to stay there for the session (released, intensity 0, still
//               `__dynamicPriority`, so it out-ranked every static lamp within
//               48 m for a pool slot), one more per eviction.
//   VFXAUDIO-2  the 2 Hz dedupe skips lights past the registration reach: it
//               compared every lit emitter with every kept one (O(E²) per pass)
//               before the radius test. Inside the radius nothing changes.
//   VFXAUDIO-3  an interior static chain's light carries its anchor's EnvCell
//               (`__cellId`), as the prop's own Setup lamps do, so the
//               cell-scoped pool drops it while its room is hidden; an outdoor
//               chain keeps `__lbKey`, an entity emitter stays unstamped.
//
// Run from apps/holtburger-web/: node tests/fx_lights_vfxaudio.test.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};

const { setFxClockSource } = await import("../scene3d/fx_clock.js");
const lights = await import("../scene3d/vfx/fx_lights.js");

// The flash clock (spawn stamps) under the test's control.
let clock = 10000;
setFxClockSource(() => clock);

// ---- VFXAUDIO-1: cap eviction ----------------------------------------------------------
{
  lights._resetFxLightsForTest();
  const scene3d = { activeLights: [], _lightRefPos: new THREE.Vector3(0, 0, 0) };
  const flash = (i) => lights.spawnFxFlash({ position: { x: i, y: 1, z: 0 }, intensity: 30, range: 6, attackMs: 0, holdMs: 400, decayMs: 300 });
  const first = [];
  for (let i = 0; i < 10; i++) {
    first.push(flash(i));
    clock += 5;
    lights.tickFxLights(scene3d, clock);
  }
  check("1. ten live flashes sit in activeLights", scene3d.activeLights.length === 10 && first.every((f) => scene3d.activeLights.includes(f)));
  const eleventh = flash(10);
  clock += 5;
  lights.tickFxLights(scene3d, clock);
  check("1. the 11th evicts the oldest, which leaves activeLights on the next tick",
    first[0].released && !scene3d.activeLights.includes(first[0]) &&
    scene3d.activeLights.includes(eleventh) && scene3d.activeLights.length === 10,
    `activeLights ${scene3d.activeLights.length}, oldest in it: ${scene3d.activeLights.includes(first[0])}`);
  clock += 2000;
  lights.tickFxLights(scene3d, clock);
  check("1. once every envelope is over, activeLights is empty", scene3d.activeLights.length === 0,
    `left: ${JSON.stringify(scene3d.activeLights.map((s) => ({ released: s.released, I: s.intensity })))}`);

  // a burst (a town's buffs between two frames): 40 flashes, few ticks
  for (let i = 0; i < 40; i++) {
    flash(i % 7);
    clock += 1;
    if (i % 8 === 7) lights.tickFxLights(scene3d, clock);
  }
  lights.tickFxLights(scene3d, clock);
  check("1. a burst never holds more than the cap in activeLights", scene3d.activeLights.length <= 10, `${scene3d.activeLights.length}`);
  clock += 2000;
  lights.tickFxLights(scene3d, clock);
  check("1. …and leaks none of the evicted ones", scene3d.activeLights.length === 0 && lights.fxLightsStats().flashesNow === 0,
    `${scene3d.activeLights.length} left`);
  lights._resetFxLightsForTest();
}

// ---- VFXAUDIO-2: dedupe cost ------------------------------------------------------------
{
  lights._resetFxLightsForTest();
  const scene3d = { activeLights: [], _lightRefPos: new THREE.Vector3(0, 0, 0) };
  const em = () => ({ numParticles: 3 });
  const at = (x, y, z) => (out) => { out.set(x, y, z); return true; };
  const bind = (x, z, intensity) => lights.bindEmitterFxLight({ emitter: em(), resolvePosition: at(x, 0, z), intensity, range: 6, color: [1, 0.5, 0.2] });
  // near: one portal (swirl + weaker rim), and a pair straddling the 56 m edge
  const near = bind(5, 0, 30);
  const rim = bind(5.5, 0, 10);
  const edge = bind(56.8, 0, 30);   // outside 56 m, inside the dedupe reach
  const inside = bind(55.9, 0, 10); // within 1.2 m of `edge`
  // far: a dense town 200-260 m away, 3 m apart (none dedupes another)
  const E = 400;
  const far = [];
  for (let i = 0; i < E; i++) far.push(bind(200 + (i % 20) * 3, Math.floor(i / 20) * 3, 20 + (i % 5)));
  const proto = THREE.Vector3.prototype;
  const orig = proto.distanceToSquared;
  let calls = 0;
  proto.distanceToSquared = function (v) { calls++; return orig.call(this, v); };
  try {
    lights.tickFxLights(scene3d, 20000); // first tick runs the dedupe pass
  } finally {
    proto.distanceToSquared = orig;
  }
  check("2. the dedupe pass is linear in the lights past the radius (no E² compare)", calls < 4 * (E + 4), `${calls} distance tests for ${E + 4} lights`);
  check("2. far lights stay unregistered and out of activeLights", far.every((s) => !s.registered && !scene3d.activeLights.includes(s)));
  check("2. inside the radius the dedupe is unchanged (one portal, one light)",
    near.registered && !near.suppressed && rim.suppressed && !rim.registered && scene3d.activeLights.includes(near) && !scene3d.activeLights.includes(rim));
  check("2. a light just past 56 m still suppresses its weaker twin inside", !edge.registered && inside.suppressed && !inside.registered);
  lights._resetFxLightsForTest();
}

// ---- VFXAUDIO-3: interior lights are cell-scoped ---------------------------------------------
{
  lights._resetFxLightsForTest();
  const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const { ParticleManager } = await import("../scene3d/particles/particle_manager.js");
  const quad = new THREE.BufferGeometry();
  quad.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -0.15, 0, -0.15, 0.15, 0, -0.15, 0.15, 0, 0.15, -0.15, 0, -0.15, 0.15, 0, 0.15, -0.15, 0, 0.15]), 3));
  quad.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
  const material = () => {
    const m = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, map: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1) });
    m.blending = THREE.AdditiveBlending;
    return m;
  };
  // 0x3200026E: the flame emitter (tier-1 light 17.4 / 4.2 m)
  const flame = {
    id: 0x3200026E, emitterType: 1, particleType: 2, gfxObjId: 0, hwGfxObjId: 0x010010F9,
    birthrate: 0.1, maxParticles: 3, initialParticles: 3, totalParticles: 0, totalSeconds: 0,
    lifespan: 2, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 1, minA: 1, maxA: 1,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 0.45, finalScale: 0.45, transRand: 0,
    startTrans: 0, finalTrans: 0.5, isParentLocal: false, billboard: false,
  };
  const mgr = new ParticleManager({ scene: new THREE.Group(), instancing: true, geometryFactory: () => quad, materialFactory: material });
  const anchorOf = (userData) => ({ position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion(), userData });
  const lightOf = async (parent, renderLayer) => {
    const id = await mgr.addEmitter({ emitterInfo: { ...flame }, parent, renderLayer });
    return mgr.particleTable.get(id)?._fxLight ?? null;
  };
  const CELL = 0x01D90105;
  const interior = await lightOf(anchorOf({ isStaticScriptAnchor: true, isCellStaticScriptAnchor: true, cellId: CELL, landblockId: 0x01D90105 }), 1);
  check("3. an interior static chain's light carries its anchor's EnvCell (the room scope of its Setup lamps)",
    !!interior && interior.userData.__cellId === CELL && interior.userData.__lbKey === undefined,
    interior ? JSON.stringify(interior.userData) : "no light");
  const unlayered = await lightOf(anchorOf({ isStaticScriptAnchor: true, isCellStaticScriptAnchor: true, cellId: CELL }), 0);
  check("3. ?indoorParticleLayer=off (interior chain on layer 0): still the room scope, not the outdoor one",
    !!unlayered && unlayered.userData.__cellId === CELL && unlayered.userData.__lbKey === undefined,
    unlayered ? JSON.stringify(unlayered.userData) : "no light");
  const outdoor = await lightOf(anchorOf({ isStaticScriptAnchor: true, landblockId: 0xA9B40001 }), 0);
  check("3. an outdoor static chain's light keeps __lbKey (sealed dungeons drop it), no cell",
    !!outdoor && outdoor.userData.__lbKey === 0 && outdoor.userData.__cellId === undefined);
  const entity = await lightOf(anchorOf({}), 1);
  check("3. an entity emitter's light stays unstamped (always a candidate)",
    !!entity && entity.userData.__lbKey === undefined && entity.userData.__cellId === undefined);
  lights._resetFxLightsForTest();
}

setFxClockSource(null);
console.log(`\n[fx_lights_vfxaudio] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
