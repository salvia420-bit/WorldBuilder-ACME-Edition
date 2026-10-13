// tests/environ_override.test.mjs
//
// sky-fog-time-2 — AdminEnvirons (0xEA60) fog + ambient override.
// Retail CPlayerSystem::Handle_Admin__Environs (acclient.c:396298) sets, per
// option 1-6, a fog colour, fog min 0, fog max, ambient colour and ambient
// level; LScape::UseTime (acclient.c:307222) blends the day fog / ambient
// toward them by m_override_transition (+0.039999999 per fog tick of 0.8 s and
// per light tick), per byte with truncation; GameSky::Draw (:308494) fogs the
// sky pass while the override is on. holtburger had BlackFog grey (0x969696 is
// the AMBIENT), near = 0.1 x far, an instant snap, no ambient, no sky.
//
//   E1  the table equals the decomp's decoded ARGB / float literals.
//   E2  the transition: 25 steps reach 1, 24 do not; blendByte truncates.
//   E3  the override state machine (sync identity, fog tick cadence, light
//       tick latch, Clear).
//   E4  loop.js tickTerrainSunDir: the terrain ambient blends to the override
//       on the light tick and back after a Clear.
//   E5  loop.js tickDistanceFogColor: the fog rolls in over ~20 s (created
//       fog and region fog), the sky veil follows, Clear restores; and
//       ?environRetail=off keeps the old snap.
//   E6  the sky veil helper.
//   E7  wiring (source scans).
//
// Run: node tests/environ_override.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");

// Import loop.js BEFORE installing the window stub (module-scope flag reads
// take their node fail-soft branches), as tests/retail_light_tick.test.mjs does.
const loop = await import("../scene3d/loop.js");
const { tickTerrainSunDir, tickDistanceFogColor } = loop;
const THREE = await import("three");
const {
  ENVIRON_FOG,
  environFogFor,
  environRetailEnabled,
  ENVIRON_TRANSITION_STEP,
  RETAIL_FOG_TICK_SEC,
  stepTransition,
  blendByte,
  blendArgb,
  blendValue,
  blendFogToward,
  authoredWorldFog,
  createEnvironOverride,
  updateEnvironSkyVeil,
  hideEnvironSkyVeil,
  ENVIRON_SKY_VEIL_RENDER_ORDER,
} = await import("../scene3d/environ_override.js");
const { createRetailLightTick } = await import("../scene3d/retail_light_tick.js");

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const f32 = (bits) => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits >>> 0, true);
  return dv.getFloat32(0, true);
};

console.log("E1 — the Handle_Admin__Environs table");
// The literals as the decomp writes them (acclient.c:396344-396416). Byte
// assembly for the composed ones: opt 1 fog BYTE3=100 BYTE2=0x96 LOWORD=0;
// opt 3 LOBYTE=100, WORD@1=25700 (0x6464), BYTE3=100; opt 4 fog LOBYTE=0,
// WORD@1=7780 (0x1E64), BYTE3=100; opt 5/6 ambient LOBYTE=0x96,
// WORD@1=-26986 (0x9696), BYTE3=100.
const DECOMP = {
  1: { fog: 0x64960000, amb: 1687552000, maxBits: 1112014848, levelBits: 1053609165 },
  2: { fog: 1680998550, amb: 1680998550, maxBits: 1112014848, levelBits: 1050253722 },
  3: { fog: 0x64646464, amb: 0x64646464, maxBits: 1106247680, levelBits: 1053609165 },
  4: { fog: 0x641e6400, amb: 1679713280, maxBits: 1112014848, levelBits: 1050253722 },
  5: { fog: 1677721600, amb: 0x64969696, maxBits: 1109393408, levelBits: 1061997773 },
  6: { fog: 1677721600, amb: 0x64969696, maxBits: 1109393408, levelBits: 1061997773 },
};
await check("options 1-6 equal the decoded decomp ARGB / floats", () => {
  for (const [opt, d] of Object.entries(DECOMP)) {
    const row = ENVIRON_FOG[+opt];
    assert(row, `row ${opt}`);
    assert(row.fogRgb === (d.fog & 0xffffff), `opt ${opt} fog 0x${row.fogRgb.toString(16)} vs 0x${(d.fog >>> 0).toString(16)}`);
    assert(row.ambRgb === (d.amb & 0xffffff), `opt ${opt} amb 0x${row.ambRgb.toString(16)} vs 0x${(d.amb >>> 0).toString(16)}`);
    assert(row.fogMax === f32(d.maxBits), `opt ${opt} fogMax ${row.fogMax} vs ${f32(d.maxBits)}`);
    assert(row.ambLevel === f32(d.levelBits), `opt ${opt} ambLevel ${row.ambLevel} vs ${f32(d.levelBits)}`);
    assert(row.fogMin === 0, `opt ${opt} fogMin ${row.fogMin} (LABEL_46 zeroes it)`);
    assert(((d.fog >>> 24) & 0xff) === 0x64 && ((d.amb >>> 24) & 0xff) === 0x64, `opt ${opt} alpha 0x64`);
  }
  assert(Object.keys(ENVIRON_FOG).length === 6, "only options 1-6 have rows");
});
await check("BlackFog / BlackFog2 fog BLACK under the 0x969696 ambient at 0.8", () => {
  for (const o of [5, 6]) {
    assert(ENVIRON_FOG[o].fogRgb === 0, `opt ${o} fog 0x${ENVIRON_FOG[o].fogRgb.toString(16)}`);
    assert(ENVIRON_FOG[o].ambRgb === 0x969696, `opt ${o} ambient`);
    assert(ENVIRON_FOG[o].ambLevel === Math.fround(0.8), `opt ${o} level`);
    assert(ENVIRON_FOG[o].fogMax === 40, `opt ${o} max`);
  }
  assert(ENVIRON_FOG[3].fogMax === 30 && ENVIRON_FOG[1].fogMax === 50, "White 30, Red 50");
});
await check("environFogFor: a fresh object per message; none for Clear / sounds / others", () => {
  const a = environFogFor(5);
  const b = environFogFor(5);
  assert(a && b && a !== b, "fresh identity");
  assert(a.option === 5 && a.fogRgb === 0 && a.name === "BlackFog", JSON.stringify(a));
  a.fogRgb = 123;
  assert(ENVIRON_FOG[5].fogRgb === 0, "the table row is not shared");
  for (const o of [0, 7, 0x65, 117, 9999, -1]) assert(environFogFor(o) === null, `option ${o}`);
});
await check("?environRetail: on by default; off / 0 / false disable it", () => {
  assert(environRetailEnabled("") === true, "default");
  assert(environRetailEnabled("?environRetail=on") === true, "on");
  for (const v of ["off", "0", "false"]) assert(environRetailEnabled(`?environRetail=${v}`) === false, v);
});

console.log("E2 — the transition and the byte blend");
await check("the step is the decomp's 0.039999999 stored to a float", () => {
  assert(ENVIRON_TRANSITION_STEP === 0.039999999, String(ENVIRON_TRANSITION_STEP));
  assert(stepTransition(0) === Math.fround(0.039999999), String(stepTransition(0)));
  assert(RETAIL_FOG_TICK_SEC === Math.fround(0.8) && approx(RETAIL_FOG_TICK_SEC, 0.800000011920929, 1e-15),
    `Dereth tickSize ${RETAIL_FOG_TICK_SEC}`);
});
await check("twenty-five steps take the transition to >= 1; twenty-four do not", () => {
  let t = 0;
  for (let i = 0; i < 24; i += 1) t = stepTransition(t);
  assert(t < 1, `24 steps: ${t}`);
  t = stepTransition(t);
  assert(t >= 1, `25 steps: ${t}`);
});
await check("blendByte = trunc(day - (day - ovr) * t), the decomp formula", () => {
  // Truncation, not rounding: 127.5 -> 127 both ways.
  assert(blendByte(255, 0, 0.5) === 127, String(blendByte(255, 0, 0.5)));
  assert(blendByte(0, 255, 0.5) === 127, String(blendByte(0, 255, 0.5)));
  assert(blendByte(150, 0, stepTransition(0)) === 144, String(blendByte(150, 0, stepTransition(0))));
  assert(blendByte(0xc3, 0x00, 0) === 0xc3, "t = 0 is the day byte");
  // Against an independent transcription over the real transition sequence.
  const ref = (d, o, t) => Number(BigInt.asUintN(64, BigInt(Math.trunc(d - (d - o) * t)))) & 0xff;
  let t = 0;
  let mismatches = 0;
  for (let i = 0; i < 25; i += 1) {
    for (const d of [0, 1, 37, 100, 150, 195, 200, 254, 255]) {
      for (const o of [0, 0x1e, 0x32, 0x64, 0x96, 0xff]) {
        if (blendByte(d, o, t) !== ref(d, o, t)) mismatches += 1;
      }
    }
    t = stepTransition(t);
  }
  assert(mismatches === 0, `mismatches ${mismatches}`);
});
await check("blendArgb blends each byte; blendValue is day - (day - ovr) * t", () => {
  const t = 0.5;
  const out = blendArgb(0xffc3c8dc, 0x64000000, t);
  const want = ((blendByte(0xff, 0x64, t) << 24) | (blendByte(0xc3, 0, t) << 16)
    | (blendByte(0xc8, 0, t) << 8) | blendByte(0xdc, 0, t)) >>> 0;
  assert(out === want, `0x${out.toString(16)} vs 0x${want.toString(16)}`);
  assert(blendValue(2400, 40, 0.25) === 2400 - (2400 - 40) * 0.25, "max");
  assert(blendValue(150, 0, 0.25) === 150 - 150 * 0.25, "min");
});
await check("at t >= 1 (or with no day fog) the override verbatim", () => {
  const ov = environFogFor(1);
  const day = { rgb: 0xc3c8dc, min: 150, max: 2400 };
  let t = 0;
  for (let i = 0; i < 25; i += 1) t = stepTransition(t);
  for (const b of [blendFogToward(day, ov, t), blendFogToward(null, ov, 0)]) {
    assert(b.rgb === 0x960000 && b.min === 0 && b.max === 50, JSON.stringify(b));
  }
  const half = blendFogToward(day, ov, 0.5);
  assert(half.rgb === ((blendByte(0xc3, 0x96, 0.5) << 16) | (blendByte(0xc8, 0, 0.5) << 8) | blendByte(0xdc, 0, 0.5)),
    `0x${half.rgb.toString(16)}`);
  assert(half.min === 75 && half.max === 1225, JSON.stringify(half));
  assert(blendFogToward(day, null, 0.5) === day, "no override: the day fog");
});
await check("authoredWorldFog: GetWorldFog's band, none when world_fog is 0", () => {
  const s = { worldFog: 1, fogMin: 150, fogMax: 2400, fogColorArgb: 0xffc3c8dc };
  const f = authoredWorldFog(s);
  assert(f && f.rgb === 0xc3c8dc && f.min === 150 && f.max === 2400, JSON.stringify(f));
  assert(authoredWorldFog({ ...s, worldFog: 0 }) === null, "world_fog 0");
  assert(authoredWorldFog({ ...s, fogMax: 100, fogMin: 200 }) === null, "inverted band");
  assert(authoredWorldFog(null) === null, "no snapshot");
});

console.log("E3 — the override state machine");
function envAt() {
  const c = { t: 0 };
  c.env = createEnvironOverride({ now: () => c.t });
  return c;
}
await check("fog ticks every 0.8 s; the 26th tick (20 s after the first) shows the override", () => {
  const c = envAt();
  c.env.sync(environFogFor(1));
  const shown = [];
  for (let i = 0; i < 40 * 60; i += 1) { // 40 s of 60 Hz frames
    c.t = i / 60;
    shown.push(c.env.fogTick());
  }
  const st = c.env.stats();
  // Like retail's next_tick, the 0.8 s deadline re-arms from the frame that
  // fired, so each interval rounds up to a frame: 49 frames = 0.8167 s.
  assert(st.fogTicks >= 48 && st.fogTicks <= 51, `~one tick per 0.8 s: ${st.fogTicks}`);
  assert(shown[0] === 0, "the first tick shows the day fog");
  const sec = shown.findIndex((t) => t >= 1) / 60;
  assert(sec >= 20 && sec <= 20.5, `full at ${sec} s`);
  assert(c.env.transition >= 1 && c.env.transition < 1.01, `stops stepping at 1: ${c.env.transition}`);
});
await check("sync: the same message keeps the transition, a new one restarts it", () => {
  const c = envAt();
  const a = environFogFor(2);
  c.env.sync(a);
  for (let i = 0; i < 5; i += 1) { c.env.fogTick(); c.t += 1; }
  const t5 = c.env.transition;
  assert(t5 > 0.19 && t5 < 0.21, `5 ticks: ${t5}`);
  c.env.sync(a);
  assert(c.env.transition === t5, "same identity: no reset");
  c.env.sync(environFogFor(2));
  assert(c.env.transition === 0 && c.env.fogT === 0, "a re-sent option restarts from 0, as retail");
});
await check("a light tick also steps the transition, after blending with it", () => {
  const c = envAt();
  c.env.sync(environFogFor(5));
  const day = 0xffffffff;
  const out0 = c.env.lightTick(day, 0.4);
  assert(out0.argb === day && out0.level === 0.4, `t=0 is the day ambient: ${JSON.stringify(out0)}`);
  assert(c.env.transition === stepTransition(0), "stepped");
  for (let i = 0; i < 9; i += 1) { c.env.fogTick(); c.t += 1; }
  const t = c.env.transition;
  const out = c.env.lightTick(day, 0.4);
  assert(out.argb === blendArgb(day, 0x64969696, t), `0x${out.argb.toString(16)}`);
  assert(out.level === 0.4 - (0.4 - Math.fround(0.8)) * t, String(out.level));
  assert(c.env.transition === stepTransition(t), "the light tick stepped it");
  const amb = c.env.ambient(day, 0.4);
  assert(amb && amb.argb === out.argb && amb.level === out.level, "per-frame consumers see the latch");
});
await check("Clear: transition 0, fog min/max 0; the ambient waits for the next light tick", () => {
  const c = envAt();
  c.env.sync(environFogFor(5));
  for (let i = 0; i < 30; i += 1) { c.env.fogTick(); c.t += 1; }
  c.env.lightTick(0xffffffff, 0.4);
  assert(c.env.ambient(0xffffffff, 0.4).level === Math.fround(0.8), "full override latched");
  c.env.clear();
  const st = c.env.stats();
  assert(!st.active && st.transition === 0 && st.fogMin === 0 && st.fogMax === 0 && st.fogT === 0, JSON.stringify(st));
  assert(c.env.fogTick() === 0, "no fog override");
  assert(c.env.ambient(0xffffffff, 0.4).level === Math.fround(0.8), "retail re-lights only on a light tick");
  assert(c.env.lightTick(0xffffffff, 0.4) === null, "the light tick drops it");
  assert(c.env.ambient(0xffffffff, 0.4) === null, "day ambient");
});

console.log("E4 — loop.js tickTerrainSunDir, the terrain ambient");
globalThis.window = { __environFogOverride: null };
function vec3() {
  return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
}
function color() {
  return { r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } };
}
function terrainMaterial() {
  return {
    userData: {},
    uniforms: {
      uSunDir: { value: vec3() },
      uAcSunVec: { value: vec3() },
      uAcSunColor: { value: color() },
      uAcAmbColor: { value: color() },
      uAcAmbLevel: { value: 0 },
    },
  };
}
function sky() {
  return {
    dirHeading: 90, dirPitch: 45, dirBright: 0.5,
    dirColorArgb: 0xffffffff, ambColorArgb: 0xffffffff, ambBright: 0.4,
    worldFog: 1, fogMin: 150, fogMax: 2400, fogColorArgb: 0xffc3c8dc,
  };
}
await check("BlackFog: day ambient, then a blend, then 0x969696 @ 0.8; Clear restores on the next tick", () => {
  const c = { t: 0 };
  const lt = createRetailLightTick({ now: () => c.t });
  const env = createEnvironOverride({ now: () => c.t });
  const mat = terrainMaterial();
  const scene3d = { terrainMaterials: [mat], skyLightingController: { _lastState: sky(), _tickCount: 1 } };
  const amb = () => mat.uniforms.uAcAmbColor.value;
  const lvl = () => mat.uniforms.uAcAmbLevel.value;
  const nextLight = () => { c.t += 15.01; tickTerrainSunDir(scene3d, lt, env); };

  tickTerrainSunDir(scene3d, lt, env); // no override: the day light
  const dayR = amb().r;
  assert(dayR > 0 && lvl() === 0.4, `day ${dayR} @ ${lvl()}`);

  window.__environFogOverride = environFogFor(5);
  nextLight(); // the set lands; this tick blends at t = 0
  assert(approx(amb().r, dayR) && lvl() === 0.4, `t=0: ${amb().r} @ ${lvl()}`);
  for (let i = 0; i < 10; i += 1) { c.t += 1; env.fogTick(); }
  const t = env.transition;
  nextLight();
  const byte = Math.trunc(255 - (255 - 0x96) * t);
  assert(approx(amb().r / dayR, byte / 255, 1e-9), `blend r ${amb().r / dayR} vs ${byte / 255}`);
  assert(approx(amb().g, amb().r) && approx(amb().b, amb().r), "grey");
  assert(lvl() === 0.4 - (0.4 - Math.fround(0.8)) * t, `level ${lvl()}`);

  for (let i = 0; i < 30; i += 1) { c.t += 1; env.fogTick(); }
  nextLight();
  assert(approx(amb().r / dayR, 0x96 / 255, 1e-9), `full r ${amb().r / dayR}`);
  assert(lvl() === Math.fround(0.8), `full level ${lvl()}`);

  window.__environFogOverride = null;
  tickTerrainSunDir(scene3d, lt, env); // between ticks: still lit by the override
  assert(lvl() === Math.fround(0.8), "held until the light tick");
  nextLight();
  assert(approx(amb().r, dayR) && lvl() === 0.4, `restored ${amb().r} @ ${lvl()}`);
});

console.log("E5 — loop.js tickDistanceFogColor, the fog roll-in and the sky veil");
function fogWorld({ regionFog = false, withState = true } = {}) {
  const c = { t: 0 };
  const env = createEnvironOverride({ now: () => c.t });
  const skyScene = new THREE.Scene();
  const scene = new THREE.Scene();
  if (regionFog) scene.fog = new THREE.Fog(0x808080, 300, 1500);
  const scene3d = {
    scene,
    skyDome: { skyScene },
    skyLightingController: withState ? { _lastState: sky(), _tickCount: 1 } : null,
  };
  const veil = () => skyScene.userData.environSkyVeil || null;
  return { c, env, scene, scene3d, skyScene, veil };
}
await check("no fog path: the authored band rolls toward BlackFog over 26 fog ticks; Clear removes it", () => {
  const w = fogWorld();
  window.__environFogOverride = environFogFor(5);
  tickDistanceFogColor(w.scene3d, w.env);
  const fog = w.scene.fog;
  assert(fog && fog.isFog && fog.__environCreated, "created");
  assert(fog.color.getHex() === 0xc3c8dc && fog.near === 150 && fog.far === 2400,
    `t=0 is the day fog: 0x${fog.color.getHex().toString(16)} ${fog.near}-${fog.far}`);
  assert(!w.veil() || !w.veil().visible, "no veil at t = 0");
  let ticks = 1;
  while (w.env.fogT < 1 && ticks < 60) {
    w.c.t += 1;
    tickDistanceFogColor(w.scene3d, w.env);
    ticks += 1;
    const t = w.env.fogT;
    if (t < 1) {
      assert(w.scene.fog === fog, "the same fog");
      assert(fog.far === 2400 - (2400 - 40) * t && fog.near === 150 - 150 * t, `tick ${ticks}: ${fog.near}-${fog.far}`);
      assert(w.veil().visible && w.veil().material.opacity === t, `veil alpha ${w.veil().material.opacity} vs ${t}`);
    }
  }
  assert(ticks === 26, `full on the 26th tick: ${ticks}`);
  assert(fog.color.getHex() === 0 && fog.near === 0 && fog.far === 40, `full: 0x${fog.color.getHex().toString(16)} ${fog.near}-${fog.far}`);
  const v = w.veil();
  assert(v.visible && v.material.opacity === 1 && v.material.color.getHex() === 0, "black sky");
  assert(v.renderOrder === ENVIRON_SKY_VEIL_RENDER_ORDER && v.material.depthTest === false, "last in the sky pass");
  window.__environFogOverride = null;
  tickDistanceFogColor(w.scene3d, w.env);
  assert(w.scene.fog === null, "Clear tears the created fog down");
  assert(!v.visible, "veil hidden");
  assert(!w.env.active, "Clear reached the override state");
});
await check("region fog: blends from its own band, then Clear hands the band back", () => {
  const w = fogWorld({ regionFog: true, withState: false });
  const fog = w.scene.fog;
  window.__environFogOverride = environFogFor(1);
  for (let i = 0; i < 13; i += 1) {
    tickDistanceFogColor(w.scene3d, w.env);
    w.c.t += 1;
  }
  const t = w.env.fogT;
  assert(t > 0.4 && t < 0.5, `13 ticks: ${t}`);
  // The stash keeps the day band: 13 blends did not compound.
  assert(fog.far === 1500 - (1500 - 50) * t && fog.near === 300 - 300 * t, `${fog.near}-${fog.far}`);
  // A region fog's colour is a working-space radiance: it blends there.
  const want = new THREE.Color(0x808080).lerp(new THREE.Color(0x960000), t);
  assert(fog.color.equals(want), `${fog.color.toArray()} vs ${want.toArray()}`);
  for (let i = 0; i < 20; i += 1) {
    tickDistanceFogColor(w.scene3d, w.env);
    w.c.t += 1;
  }
  assert(fog.color.getHex() === 0x960000 && fog.near === 0 && fog.far === 50, "RedFog verbatim");
  window.__environFogOverride = null;
  tickDistanceFogColor(w.scene3d, w.env);
  assert(w.scene.fog === fog, "a region fog is never torn down");
  assert(fog.color.getHex() === 0x808080 && fog.near === 300 && fog.far === 1500,
    `day band back: 0x${fog.color.getHex().toString(16)} ${fog.near}-${fog.far}`);
  assert(!w.veil().visible, "veil hidden");
});
await check("region fog + a live sky: blends from what the day half writes each frame", () => {
  // The day half's own output on an identical world, no override.
  const d = fogWorld({ regionFog: true });
  window.__environFogOverride = null;
  tickDistanceFogColor(d.scene3d, d.env);
  const day = { color: d.scene.fog.color.clone(), near: d.scene.fog.near, far: d.scene.fog.far };
  assert(day.color.getHex() === 0xc3c8dc, `the day half wrote the snapshot colour: 0x${day.color.getHex().toString(16)}`);
  const w = fogWorld({ regionFog: true });
  const fog = w.scene.fog;
  window.__environFogOverride = environFogFor(3);
  for (let i = 0; i < 10; i += 1) {
    tickDistanceFogColor(w.scene3d, w.env);
    w.c.t += 1;
    const t = w.env.fogT;
    const want = day.color.clone().lerp(new THREE.Color(0x646464), t);
    assert(fog.color.equals(want) && fog.near === blendValue(day.near, 0, t) && fog.far === blendValue(day.far, 30, t),
      `tick ${i + 1} t=${t}: ${fog.color.toArray()} ${fog.near}-${fog.far}`);
  }
  window.__environFogOverride = null;
  tickDistanceFogColor(w.scene3d, w.env);
  assert(fog.color.equals(day.color) && fog.near === day.near && fog.far === day.far, "the day fog again");
});
await check("?environRetail=off keeps the old instant snap (near = 0.1 x far), no veil", async () => {
  globalThis.location = { search: "?environRetail=off" };
  try {
    const off = await import("../scene3d/loop.js?environRetailOff");
    const w = fogWorld();
    window.__environFogOverride = environFogFor(5);
    off.tickDistanceFogColor(w.scene3d, w.env);
    const fog = w.scene.fog;
    assert(fog && fog.color.getHex() === 0 && fog.far === 40 && fog.near === 4, `snap: ${fog?.near}-${fog?.far}`);
    assert(!w.veil(), "no veil");
    assert(!w.env.active, "the retail state machine never ran");
    window.__environFogOverride = null;
    off.tickDistanceFogColor(w.scene3d, w.env);
    assert(w.scene.fog === null, "Clear");
  } finally {
    delete globalThis.location;
  }
});
await check("no override: the day path leaves the fog and the sky scene alone", () => {
  const w = fogWorld({ regionFog: true, withState: false });
  window.__environFogOverride = null;
  tickDistanceFogColor(w.scene3d, w.env);
  assert(w.scene.fog.color.getHex() === 0x808080 && w.scene.fog.near === 300 && w.scene.fog.far === 1500, "untouched");
  assert(w.skyScene.children.length === 0 && !w.veil(), "no veil made");
  assert(w.scene.fog.__environDay === undefined, "no stash");
});

console.log("E6 — the sky veil");
await check("created on first use, follows the camera, hides at alpha 0", () => {
  const skyScene = new THREE.Scene();
  assert(updateEnvironSkyVeil(THREE, skyScene, new THREE.Color(0x960000), 0) === null, "alpha 0 makes nothing");
  assert(skyScene.children.length === 0, "nothing added");
  const c = new THREE.Color(0x960000);
  const v = updateEnvironSkyVeil(THREE, skyScene, c, 0.48);
  assert(v && v.parent === skyScene && v.visible, "added");
  assert(v.material.opacity === 0.48 && v.material.color.equals(c), "alpha + colour");
  assert(v.material.side === THREE.BackSide && v.material.depthWrite === false && v.material.fog === false, "sky shell");
  assert(v.frustumCulled === false && v.renderOrder === 1000, "drawn last");
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(10, 20, 30);
  cam.updateMatrixWorld(true);
  v.onBeforeRender(null, skyScene, cam);
  assert(v.position.x === 10 && v.position.y === 20 && v.position.z === 30, "centred on the camera");
  assert(updateEnvironSkyVeil(THREE, skyScene, c, 1.04).material.opacity === 1, "alpha clamps at 1");
  assert(updateEnvironSkyVeil(THREE, skyScene, c, 0) === v && !v.visible, "kept, hidden");
  updateEnvironSkyVeil(THREE, skyScene, c, 0.2);
  hideEnvironSkyVeil(skyScene);
  assert(!v.visible && skyScene.children.length === 1, "hide keeps the one mesh");
  hideEnvironSkyVeil(null);
});

console.log("E7 — wiring");
await check("client_events.js maps the options through environFogFor, no grey BlackFog", () => {
  const ce = src("app/client_events.js");
  assert(ce.includes('import { environFogFor } from "../scene3d/environ_override.js";'), "import");
  assert(!/0x05:\s*\{\s*rgb:\s*0x969696/.test(ce) && !/rgb:\s*0x969696/.test(ce), "the grey BlackFog row is gone");
  assert(!ce.includes("const ENVIRON_FOG = {"), "no local table");
  const at = ce.indexOf("ClientEventKind.ENVIRON_CHANGE) {");
  const arm = ce.slice(at, at + 2500);
  assert(arm.includes("window.__environFogOverride = ec === 0x00 ? null : environFogFor(ec);"), "the arm");
  assert(arm.indexOf("radarBlankAfterEnviron(") < arm.indexOf("if (ec <= 0x06) {"), "radar-4 order kept");
});
await check("loop.js: retail path gated, old snap kept for =off, ambient on the light tick + probe", () => {
  const l = src("scene3d/loop.js");
  const f = l.slice(l.indexOf("function tickDistanceFogColor("), l.indexOf("function tickEnvironFogRetail("));
  assert(f.indexOf("fogOff) {") < f.indexOf("hideEnvironSkyVeil("), "fog off hides the veil");
  assert(/Number\.isFinite\(environOv\.fogRgb\) && _environRetailOn\(\)\) \{\s*tickEnvironFogRetail\(scene3d, environOv, env\);/.test(f), "gate");
  assert(f.includes("const near = far * 0.1;"), "=off keeps the snap");
  const sun = l.slice(l.indexOf("export function tickTerrainSunDir("), l.indexOf("// === W3 — clouds-independent weather tick"));
  assert(sun.includes("envAmb = env.lightTick(state.ambColorArgb >>> 0, dayAmbLevel);"), "light tick");
  assert(sun.includes("g.ambLevel = envAmb ? envAmb.level : dayAmbLevel;"), "level");
  assert(/const state = _environLitState\(scene3d\.skyLightingController\?\._lastState \?\? null\);\s*const cam = [^\n]+\n\s*scene3d\.atmosphereLights\.tick\(state, cam\?\.position\);/.test(l),
    "atmosphere_lights sees the overridden ambient");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
