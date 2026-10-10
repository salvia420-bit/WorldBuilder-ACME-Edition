// Tier-1 particle upgrade (2026-10-10) — effects light the world, glow, GPU
// children, distortion, smoke shading. scene3d/vfx/fx_tier1.js, fx_lights.js,
// fx_distort.js, fx_cues.js, fx_glow_effect.js, fx_distort_effect.js,
// scene3d/particles/particle_fx.js (tier-1 rows + smoke / glow variants),
// particle_fx_kids.js, particle_manager.js wiring, terrain.js light loop.
//
// Guards:
//   1. switches: six preset booleans (low none / mid all but glow / high+ultra
//      all), in quality.js PRESETS + BOOL_FLAGS, URL and force seams
//   2. data: tier-1 terms in the generated rows for the right emitters (portal
//      swirl, flaming weapon, brazier smoke, buff orbs), ranges, sky stays zero
//   3. FX lights: flash envelope + activeLights sync + priority; emitter lights
//      register, dedupe against setup lights and each other, honour the 48 m
//      radius, scope out of sealed dungeons when outdoor, release cleanly; the
//      pool accepts the carrier (writePoolSlot)
//   4. terrain lights: nearest lit pool slots into the shared uniforms, viewer
//      light skipped, day / night gain; the loop is in the assembled terrain GLSL
//   5. distortion: sources project, rings expire, strongest first, 16 max, flag off
//   6. cues: every placeholder look but the matter ones lights; impacts shock
//   7. children: the manager builds one instanced kids draw, 8 instances per
//      parent record, velocity from the slot history; `?fxKids=off` builds none
//   8. emitter light / distortion binding + release through ParticleManager
//   9. glow: provider registered, collects additive FX buckets, constant glow
//      program; the glow + distortion effects construct and update
//  10. smoke variant: HB_FX_SMOKE / HB_FX_CSM defines + keys, CSM uniforms by
//      identity, deterministic tileable noise; calibration on every path
//
// Run from apps/holtburger-web/:  node test_particle_fx_tier1.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

function emitterPojo(over = {}) {
  return {
    id: 0, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0x010010F9,
    birthrate: 0.1, maxParticles: 3, initialParticles: 3, totalParticles: 0, totalSeconds: 0,
    lifespan: 2, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 0.45, finalScale: 0.45, transRand: 0,
    startTrans: 0, finalTrans: 0.5, isParentLocal: false, billboard: false, ...over,
  };
}
function makeQuad(half = 0.147) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -half, 0, -half, half, 0, -half, half, 0, half, -half, 0, -half, half, 0, half, -half, 0, half]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
  return g;
}
function baseMaterial(additive) {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const m = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, map: tex });
  if (additive) m.blending = THREE.AdditiveBlending;
  return m;
}

async function run() {
  globalThis.window = globalThis.window || {};
  globalThis.location = { search: "" };
  window.location = globalThis.location;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const t1f = await import("./scene3d/vfx/fx_tier1.js");
  const quality = await import("./scene3d/quality.js");
  const fx = await import("./scene3d/particles/particle_fx.js");
  // Tier 1 is checked on its own: the tier-2 variant (test_particle_fx_tier2.mjs)
  // adds m / a / p to every program key, so latch it OFF here.
  fx._setParticleFxTier2VariantForTest({ motion: false, shapes: false, clamp: false });
  const prof = await import("./scene3d/particles/particle_fx_profiles.js");
  const lights = await import("./scene3d/vfx/fx_lights.js");
  const lighting = await import("./scene3d/lighting.js");
  const distort = await import("./scene3d/vfx/fx_distort.js");
  const cues = await import("./scene3d/vfx/fx_cues.js");
  const burst = await import("./scene3d/play_effect_burst_fx.js");
  const poc = await import("./scene3d/particles_over_clouds.js");
  const tier1 = JSON.parse(readFileSync(new URL("./data/particle-fx-tier1.json", import.meta.url), "utf8"));
  const catalog = JSON.parse(readFileSync(new URL("./data/particle-fx-catalog.json", import.meta.url), "utf8"));

  // ---- 1. switches -------------------------------------------------------------------
  const P = t1f.FX_TIER1_PRESETS;
  check("1. low = none; mid = all but the glow; high / ultra = all six",
    t1f.FX_TIER1_FLAGS.every((n) => P.low[n] === false) &&
    t1f.FX_TIER1_FLAGS.every((n) => P.mid[n] === (n !== "fxGlow")) &&
    t1f.FX_TIER1_FLAGS.every((n) => P.high[n] === true && P.ultra[n] === true));
  check("1. quality.js presets carry the six switches",
    ["low", "mid", "high", "ultra"].every((t) => t1f.FX_TIER1_FLAGS.every((n) => quality.PRESETS[t][n] === P[t][n])));
  const q = quality.getQuality("http://x/?quality=mid&fxGlow=on&fxKids=off", "");
  check("1. URL overrides parse through quality BOOL_FLAGS", q.flags.fxGlow === true && q.flags.fxKids === false && q.flags.fxLights === true);
  check("1. URL reading: on/off forms, garbage ignored",
    t1f.fxTier1UrlValue("fxGlow", "?fxGlow=off") === false && t1f.fxTier1UrlValue("fxGlow", "?fxGlow=1") === true &&
    t1f.fxTier1UrlValue("fxGlow", "?fxGlow=zz") === null && t1f.fxTier1UrlValue("fxGlow", "") === null);
  check("1. default (no quality object, no URL) = the mid preset",
    t1f.fxTier1Enabled("fxLights", "") === true && t1f.fxTier1Enabled("fxGlow", "") === false);
  window.__quality = { flags: { fxGlow: true } };
  check("1. the resolved quality flags win over the default", t1f.fxTier1Enabled("fxGlow") === true);
  delete window.__quality;
  t1f.setFxTier1Flag("fxLights", false);
  check("1. force seam", t1f.fxTier1Enabled("fxLights") === false);
  t1f.setFxTier1Flag("fxLights", null);

  // ---- 2. data ----------------------------------------------------------------------------
  const row = (did) => prof.FX_DID_ROWS.get(did >>> 0);
  const T = (did) => fx.particleFxTier1(row(did));
  const portal = T(0x320002CD), flame = T(0x3200026E), smoke = T(0x320001B0), orbs = T(0x3200003C);
  check("2. portal swirl: light + swirl distortion + inflow motes",
    portal.light > 0 && portal.lightRange > 0 && portal.distortKind === fx.FX_DISTORT_KIND.swirl &&
    portal.kids > 0 && portal.kidKind === fx.FX_KID_KIND.inflow, JSON.stringify(portal).slice(0, 160));
  check("2. flaming weapon: embers + heat + warm light (red > blue)",
    flame.kidKind === fx.FX_KID_KIND.ember && flame.distortKind === fx.FX_DISTORT_KIND.heat &&
    flame.light > 0 && flame.lightColor[0] > flame.lightColor[2]);
  check("2. brazier smoke: sun-lit, noise-eroded, shadow-receiving, no light / glow",
    smoke.sunLit > 0 && smoke.noise > 0 && smoke.shadow > 0 && smoke.light === 0 && smoke.glow === 0);
  check("2. buff orbs: glow + glitter", orbs.glow > 0 && orbs.kidKind === fx.FX_KID_KIND.glitter);
  check("2. row 0 has no tier-1 terms", Object.entries(fx.particleFxTier1(0)).every(([k, v]) =>
    Array.isArray(v) ? true : (k === "lightColor" || k === "tint0" || k === "tint1" ? true : (k === "flickerHz" || k === "pulseHz" || k === "gain" ? true : v === 0))));
  const skyDids = Object.entries(catalog.emitters).filter(([, e]) => e.family === "sky").map(([d]) => d);
  check("2. sky-chain emitters carry no tier-1 terms", skyDids.every((d) => !tier1.emitters[d]), `${skyDids.length} sky rows`);
  const R = tier1.ranges;
  const bad = [];
  for (const [did, p] of Object.entries(tier1.emitters)) {
    for (const [k, v] of Object.entries(p)) {
      if (k === "lightColor") { if (!(v.length === 3 && v.every((x) => x >= 0 && x <= 1) && Math.max(...v) > 0.99)) bad.push(`${did} ${k}`); continue; }
      const r = R[k];
      if (r && !(v >= r[0] && v <= r[1])) bad.push(`${did} ${k}=${v}`);
    }
  }
  check("2. every tier-1 value inside its range; light colours normalised", bad.length === 0, bad.slice(0, 5).join(" "));
  check("2. FX_ROW_EXTRA is row-aligned", prof.FX_ROW_EXTRA.length === prof.FX_PROFILE_ROWS.length && prof.FX_ROW_EXTRA.every((x) => x.length === 4));
  const counts = { light: 0, glow: 0, kids: 0, distort: 0, sunLit: 0 };
  for (const p of Object.values(tier1.emitters)) for (const k of Object.keys(counts)) if (p[k]) counts[k]++;
  check("2. broad coverage (hundreds lit / glowing / with children; smoke shaded; tens distorting)",
    counts.light > 800 && counts.glow > 1000 && counts.kids > 800 && counts.distort > 100 && counts.sunLit > 200, JSON.stringify(counts));

  // ---- 3. FX lights ----------------------------------------------------------------------
  lights._resetFxLightsForTest();
  check("3. flash envelope: ramp, hold, quadratic decay, off",
    lights.fxFlashEnvelope(20, 40, 60, 400) === 0.5 && lights.fxFlashEnvelope(80, 40, 60, 400) === 1 &&
    Math.abs(lights.fxFlashEnvelope(300, 40, 60, 400) - 0.25) < 1e-9 && lights.fxFlashEnvelope(600, 40, 60, 400) === 0);
  const scene3d = { activeLights: [], _lightRefPos: new THREE.Vector3(0, 0, 0) };
  const f = lights.spawnFxFlash({ position: { x: 1, y: 1, z: 1 }, color: [1, 0.5, 0.2], intensity: 40, range: 7, attackMs: 0, holdMs: 100, decayMs: 200 });
  lights.tickFxLights(scene3d, f._t0 + 50);
  check("3. a flash joins activeLights at full intensity, with projectile-class priority",
    scene3d.activeLights.includes(f) && f.intensity === 40 && f.userData.__dynamicPriority === true &&
    lighting.lightSelectionSortKey(4, f.userData) < 0);
  lights.tickFxLights(scene3d, f._t0 + 500);
  check("3. …and leaves once its decay is over", !scene3d.activeLights.includes(f) && lights.fxLightsStats().flashesNow === 0);
  const pl = new THREE.PointLight(0xffffff, 0, 0, 2);
  const tmp = new THREE.Vector3();
  const g2 = lights.spawnFxFlash({ position: { x: 2, y: 3, z: 4 }, color: 0xff8800, intensity: 30, range: 6 });
  lights.tickFxLights(scene3d, g2._t0 + 45);
  check("3. the light pool accepts the carrier (writePoolSlot ok, position/colour copied)",
    lighting.writePoolSlot(pl, g2, tmp, null) === "ok" && pl.position.x === 2 && pl.position.z === 4 && pl.intensity > 0 && pl.distance === 6);
  lights._resetFxLightsForTest();
  scene3d.activeLights.length = 0;

  const mkEm = (n = 3) => ({ numParticles: n });
  const at = (x, y, z) => (out) => { out.set(x, y, z); return true; };
  const eA = mkEm(), eB = mkEm(), eC = mkEm(), eD = mkEm();
  const lA = lights.bindEmitterFxLight({ emitter: eA, resolvePosition: at(5, 0, 0), intensity: 30, range: 6, color: [1, 0.4, 0.1], outdoor: true });
  const lB = lights.bindEmitterFxLight({ emitter: eB, resolvePosition: at(5.5, 0, 0), intensity: 10, range: 4, color: [1, 1, 1] }); // within 1.2 m of A
  const lC = lights.bindEmitterFxLight({ emitter: eC, resolvePosition: at(80, 0, 0), intensity: 30, range: 6, color: [1, 1, 1] }); // beyond 48 m
  const setupLamp = new THREE.PointLight(0xffffff, 1, 5, 2);
  setupLamp.position.set(-10, 0, 0); setupLamp.updateMatrixWorld(true);
  const lD = lights.bindEmitterFxLight({ emitter: eD, resolvePosition: at(-10.5, 0, 0), intensity: 20, range: 5, color: [1, 1, 1] }); // beside a setup lamp
  scene3d.activeLights.push(setupLamp);
  for (let i = 0; i < 30; i++) lights.tickFxLights(scene3d, 1000 + i * 16);
  check("3. an emitter light registers and ramps up", scene3d.activeLights.includes(lA) && lA.intensity > 25, `I=${lA.intensity.toFixed(2)}`);
  check("3. a weaker FX light within 1.2 m of a stronger one is suppressed (one portal, one light)", lB.suppressed && !scene3d.activeLights.includes(lB));
  check("3. a light beyond the 48 m registration radius stays out", !lC.registered && !scene3d.activeLights.includes(lC));
  check("3. a light beside a setup LightInfo lamp is suppressed (no double light)", lD.suppressed && !scene3d.activeLights.includes(lD));
  check("3. an outdoor static-chain light carries __lbKey (sealed dungeons drop it)", lA.userData.__lbKey === 0 && lB.userData.__lbKey === undefined);
  eA.numParticles = 0;
  for (let i = 0; i < 60; i++) lights.tickFxLights(scene3d, 2000 + i * 16);
  check("3. an emitter that ran dry fades its light out", !scene3d.activeLights.includes(lA) || lA.intensity < 0.5, `I=${lA.intensity}`);
  lights.releaseFxLight(lA);
  lights.tickFxLights(scene3d, 4000);
  check("3. a released light leaves activeLights", !scene3d.activeLights.includes(lA) && lA.released);
  t1f.setFxTier1Flag("fxLights", false);
  check("3. ?fxLights=off: no flash, no emitter light",
    lights.spawnFxFlash({ position: { x: 0, y: 0, z: 0 } }) === null &&
    lights.bindEmitterFxLight({ emitter: mkEm(), resolvePosition: at(0, 0, 0), intensity: 1, range: 1 }) === null);
  t1f.setFxTier1Flag("fxLights", null);
  lights._resetFxLightsForTest();

  // ---- 4. terrain lights ---------------------------------------------------------------
  const mkPl = (x, I, d, c = 0xffaa66) => { const l = new THREE.PointLight(c, I, d, 2); l.position.set(x, 1, 0); return l; };
  const viewer = { isViewerLightSource: true };
  const pool = { enabled: true, point: [mkPl(0, 30, 8), mkPl(3, 20, 6), mkPl(100, 30, 8), mkPl(1, 2.25, 13), mkPl(5, 0, 5)], selPoint: [{}, {}, {}, viewer, {}] };
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  cam.position.set(0, 2, 5);
  const s3 = { lighting: { lightPool: pool }, camera: cam };
  const lit = lights.feedTerrainFxLights(s3, 1, false);
  const U = lights.TERRAIN_FX_LIGHT_UNIFORMS;
  check("4. lit pool slots feed the terrain, nearest first; the viewer lantern and dark slots stay out",
    lit === 3 && U.uFxLightPos.value[0] === 0 && U.uFxLightPos.value[3] === 8 && U.uFxLightPos.value[8] === 100 &&
    U.uFxLightPos.value[15] === 0, `lit ${lit}`);
  check("4. colour carries the intensity", Math.abs(U.uFxLightCol.value[0] - 30) < 1e-5 && U.uFxLightCol.value[2] < U.uFxLightCol.value[0]);
  check("4. night gain > day gain; indoors = night",
    lights.terrainFxLightGainFor(1, false) === lights.TERRAIN_FX_LIGHT_NIGHT_GAIN &&
    lights.terrainFxLightGainFor(0, false) === lights.TERRAIN_FX_LIGHT_DAY_GAIN &&
    lights.terrainFxLightGainFor(0, true) === lights.TERRAIN_FX_LIGHT_NIGHT_GAIN &&
    Math.abs(U.uFxLightGain.value[0] - lights.TERRAIN_FX_LIGHT_NIGHT_GAIN) < 1e-6);
  t1f.setFxTier1Flag("terrainLights", false);
  lights.feedTerrainFxLights(s3, 1, false);
  check("4. ?terrainLights=off: gain 0 and every slot parked",
    U.uFxLightGain.value[0] === 0 && [0, 1, 2, 3, 4, 5, 6, 7].every((i) => U.uFxLightPos.value[i * 4 + 3] === 0));
  t1f.setFxTier1Flag("terrainLights", null);
  const terrain = await import("./scene3d/terrain.js");
  const tg = terrain._terrainGlslForTest();
  check("4. the assembled terrain fragment declares + calls the light loop on the unlit albedo, before the fog",
    tg.fragment.includes("uniform vec4 uFxLightPos[HB_FX_LIGHTS]") && tg.fragment.includes("vec3 hbFxAlbedo = modulated;") &&
    tg.fragment.indexOf("vec3 hbFxAlbedo = modulated;") < tg.fragment.indexOf("modulated = terrainAcGouraud(") &&
    tg.fragment.indexOf("terrainLit += hbTerrainFxLights(") < tg.fragment.indexOf("fragColor = vec4(terrainApplyFog(terrainLit"));
  const tsrc = readFileSync(new URL("./scene3d/terrain.js", import.meta.url), "utf8");
  check("4. terrain materials bind the SHARED uniform objects", tsrc.includes("uFxLightPos: TERRAIN_FX_LIGHT_UNIFORMS.uFxLightPos"));

  // ---- 5. distortion ----------------------------------------------------------------------
  distort._resetFxDistortForTest();
  const dcam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  dcam.position.set(0, 1.5, 10); dcam.lookAt(0, 1, 0); dcam.updateMatrixWorld(true); dcam.updateProjectionMatrix();
  const emD = { numParticles: 4 };
  const h = distort.addFxDistortSource({ emitter: emD, resolvePosition: at(0, 1, 0), kind: 1, strength: 0.8, radius: 1.5 });
  const sw = distort.spawnFxShockwave({ position: { x: 1, y: 1, z: 0 }, radius: 3, strength: 0.7, durationMs: 400 });
  const out = [];
  distort.collectFxDistortSources(dcam, out, sw.t0 + 100);
  const heat = out.find((s) => s.kind === 1), ring = out.find((s) => s.kind === 3);
  check("5. sources project on screen (centre ~ middle, heat shifted up, depth ~10 m)",
    !!heat && Math.abs(heat.x - 0.5) < 0.05 && heat.y > 0.5 && Math.abs(heat.depth - 10) < 0.5 && heat.radiusM === 1.5);
  check("5. a shockwave carries its 0..1 progress", !!ring && Math.abs(ring.phase - 0.25) < 0.05);
  distort.collectFxDistortSources(dcam, out, sw.t0 + 500);
  check("5. a finished shockwave is pruned", !out.some((s) => s.kind === 3));
  emD.numParticles = 0;
  distort.collectFxDistortSources(dcam, out, sw.t0 + 600);
  check("5. a persistent source goes quiet while its emitter is empty", out.length === 0);
  emD.numParticles = 4;
  for (let i = 0; i < 30; i++) distort.addFxDistortSource({ resolvePosition: at(i * 0.2 - 3, 1, 0), kind: 2, strength: 0.1 + i * 0.01, radius: 1 });
  distort.collectFxDistortSources(dcam, out, sw.t0 + 700);
  check("5. at most 16 sources, strongest first", out.length === distort.FX_DISTORT_MAX && out[0].score >= out[out.length - 1].score);
  distort.releaseFxDistortSource(h);
  t1f.setFxTier1Flag("fxDistort", false);
  distort.collectFxDistortSources(dcam, out, sw.t0 + 700);
  check("5. ?fxDistort=off: nothing collected, no new sources", out.length === 0 &&
    distort.addFxDistortSource({ resolvePosition: at(0, 0, 0), kind: 1, strength: 1, radius: 1 }) === null);
  t1f.setFxTier1Flag("fxDistort", null);
  distort._resetFxDistortForTest();

  // ---- 6. cues -----------------------------------------------------------------------------
  const looks = Object.keys(burst.BURST_LOOKS);
  const unlit = looks.filter((k) => !cues.FX_CUES[k]);
  check("6. every placeholder look lights the world except matter / darkness ones",
    unlit.every((k) => ["default", "splatter", "splatterCrit", "dirtyFighting", "specialStateBlack"].includes(k)), unlit.join(","));
  lights._resetFxLightsForTest();
  const fired = cues.fireFxCue("explode", { x: 0, y: 0, z: 0 });
  check("6. an impact cue fires a flash at chest height and a shockwave",
    !!fired.light && Math.abs(fired.light.position.y - 1) < 1e-9 && !!fired.shock);
  check("6. a matter cue draws no light", cues.fireFxCue("splatter", { x: 0, y: 0, z: 0 }).light === null);
  lights._resetFxLightsForTest();
  distort._resetFxDistortForTest();

  // ---- 7 + 8. manager integration (children, lights, distortion) --------------------------
  const { setCurrentTime } = await import("./scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const { ParticleManager } = await import("./scene3d/particles/particle_manager.js");
  const mcam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  mcam.position.set(0, -5, 1); mcam.lookAt(0, 0, 0); mcam.updateMatrixWorld(true);
  window.liveScene3d = { cameraSwitcher: { activeCamera: mcam }, camera: mcam };
  const geom = makeQuad();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const flameDid = 0x3200026E;
  const scene = new THREE.Group();
  const mgr = new ParticleManager({ scene, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  const id = await mgr.addEmitter({ emitterInfo: emitterPojo({ id: flameDid, aZ: 1, minA: 1, maxA: 1, particleType: 2 }), parent });
  t += 0.25; mgr.tick();
  t += 0.25; mgr.tick();
  const kids = [];
  scene.traverse((o) => { if (o.userData?.isParticleFxKids) kids.push(o); });
  const k0 = kids[0];
  const em = mgr.particleTable.get(id);
  check("7. one instanced children draw under the manager's scene", kids.length === 1 && k0.visible === true);
  if (k0) {
    const g = k0.geometry;
    const recs = mgr._kids.records;
    check("7. 8 instances per parent record (meshPerAttribute 8)",
      recs === em.numParticles && g.instanceCount === recs * 8 && g.attributes.aKidPos.meshPerAttribute === 8, `records ${recs}, count ${g.instanceCount}`);
    const r = g.attributes.aKidRow.array;
    check("7. records carry the emitter's row + the particle seed", Math.round(r[0]) === row(flameDid) && r[1] >= 0 && r[1] < 1);
    const v = g.attributes.aKidVel.array;
    check("7. parent velocity from the slot history (rising particle ⇒ +z)", v[2] > 0.1 && v[3] > 0, `v=(${v[0].toFixed(2)},${v[1].toFixed(2)},${v[2].toFixed(2)}) op ${v[3]}`);
    const late = [];
    mgr._collectParticlesOverClouds(late);
    check("7. the children draw in the late particle pass with their parents", late.includes(k0));
  }
  const kidsSrc = (await import("./scene3d/particles/particle_fx_kids.js")).PARTICLE_FX_KIDS_GLSL;
  check("7. kids shader: child index from gl_InstanceID, log depth, six kinds",
    kidsSrc.vertex.includes("gl_InstanceID") && kidsSrc.vertex.includes("#include <logdepthbuf_vertex>") &&
    kidsSrc.fragment.includes("#include <logdepthbuf_fragment>") && (kidsSrc.vertex.match(/kind < \d\.5/g) || []).length >= 5);
  check("8. the flame emitter carries its own light and heat source", !!em._fxLight && em._fxLight.isFxLightSource && !!em._fxDistort);
  const fxLight = em._fxLight;
  mgr.destroyParticleEmitter(id);
  check("8. destroying the emitter releases both", fxLight.released === true && !em._fxLight && !em._fxDistort);
  t1f.setFxTier1Flag("fxKids", false);
  const scene2 = new THREE.Group();
  const mgr2 = new ParticleManager({ scene: scene2, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  await mgr2.addEmitter({ emitterInfo: emitterPojo({ id: flameDid }), parent });
  t += 0.25; mgr2.tick();
  let any = false; scene2.traverse((o) => { if (o.userData?.isParticleFxKids) any = true; });
  check("7. ?fxKids=off: no children mesh", !any && mgr2._kids === null);
  t1f.setFxTier1Flag("fxKids", null);
  const sceneSky = new THREE.Group();
  const mgrSky = new ParticleManager({ scene: sceneSky, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  const sid = await mgrSky.addEmitter({ emitterInfo: emitterPojo({ id: flameDid }), parent, skyGlow: true });
  check("8. the sky chain gets no light / distortion", !mgrSky.particleTable.get(sid)._fxLight && !mgrSky.particleTable.get(sid)._fxDistort);

  // ---- 9. glow ---------------------------------------------------------------------------------
  const prov = poc.fxGlowProvider();
  check("9. the particle chunk registered the glow provider", !!prov && typeof prov.collect === "function");
  const scene3 = new THREE.Group();
  const mgr3 = new ParticleManager({ scene: scene3, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  const mgr4 = new ParticleManager({ scene: scene3, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(false) });
  await mgr3.addEmitter({ emitterInfo: emitterPojo({ id: flameDid }), parent });
  await mgr4.addEmitter({ emitterInfo: emitterPojo({ id: 0x320001B0, hwGfxObjId: 0x01000FBF }), parent });
  t += 0.25; mgr3.tick(); mgr4.tick();
  const gl = [];
  prov.collect(gl);
  check("9. collect = additive FX buckets only (smoke's alpha bucket is matter)",
    gl.length >= 1 && gl.every((b) => b.userData.particleFx === true && b.userData.alpha === false));
  const gm = prov.materialFor(gl[0]);
  check("9. glow material: HB_FX_GLOW + additive, constant key, cached on the bucket",
    !!gm && "HB_FX_GLOW" in gm.defines && "HB_FX_ADDITIVE" in gm.defines && gm.customProgramCacheKey() === fx.FX_KEY_GLOW &&
    prov.materialFor(gl[0]) === gm && gm.depthTest === false && gm.blending === THREE.AdditiveBlending);
  const sh = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms) };
  fx.patchParticleFxShader(sh);
  check("9. glow variant: drops glow-less rows in the vertex stage, occludes against the scene depth",
    sh.vertexShader.includes("if ( vFxGlow <= 0.0 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );") &&
    sh.fragmentShader.includes("texture2D( uFxGlowDepth, gl_FragCoord.xy / uFxGlowRes )") &&
    sh.fragmentShader.includes("#ifndef HB_FX_GLOW") && sh.uniforms.uFxGlowDepth === fx.FX_UNIFORMS.uFxGlowDepth);
  const { FxGlowEffect, createFxGlowEffect } = await import("./scene3d/vfx/fx_glow_effect.js");
  const { FxDistortEffect, createFxDistortEffect } = await import("./scene3d/vfx/fx_distort_effect.js");
  t1f.setFxTier1Flag("fxGlow", false);
  check("9. effects are null when their switch is off (pipeline drops the slot)",
    createFxGlowEffect() === null && createFxDistortEffect({ enabled: false }) === null);
  t1f.setFxTier1Flag("fxGlow", null);
  const ge = new FxGlowEffect({ camera: mcam });
  check("9. glow effect: SRC blend, additive composite, blurred texture bound",
    ge.fragmentShader.includes("outputColor = vec4(inputColor.rgb + g, inputColor.a);") && ge.uniforms.get("tFxGlow").value === ge.blurPass.texture);
  const de = new FxDistortEffect({ camera: dcam, cameraFar: 5000 });
  distort.spawnFxShockwave({ position: { x: 0, y: 1, z: 0 }, radius: 3 });
  de.update(null, null, 0.016);
  check("9. distortion effect: mainUv only, DEPTH, fills its source arrays",
    de.fragmentShader.includes("void mainUv(inout vec2 uv)") && !de.fragmentShader.includes("mainImage") &&
    de.uniforms.get("uFxDistN").value >= 1 &&
    de.uniforms.get("uFxDistB").value.slice(0, de.uniforms.get("uFxDistN").value).some((v) => v.x === 3),
    `N ${de.uniforms.get("uFxDistN").value} B0 ${de.uniforms.get("uFxDistB").value[0].toArray().join(",")} stats ${JSON.stringify(distort.fxDistortStats())}`);
  distort._resetFxDistortForTest();

  // ---- 10. smoke variant + calibration -----------------------------------------------------------
  const fakeCsm = {
    uCsmShadowMap0: { value: null }, uCsmShadowMap1: { value: null }, uCsmShadowMap2: { value: null },
    uCsmMatrix0: { value: new THREE.Matrix4() }, uCsmMatrix1: { value: new THREE.Matrix4() }, uCsmMatrix2: { value: new THREE.Matrix4() },
    uCsmSplits: { value: new THREE.Vector2(30, 100) }, uCsmFar: { value: 300 }, uCsmBlend: { value: 0.1 },
  };
  fx._setParticleFxVariantForTest(true, fakeCsm);
  const mS = baseMaterial(false);
  fx.applyParticleFxMaterial(mS, { additive: false });
  const shS = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms) };
  mS.onBeforeCompile(shS);
  check("10. smoke + CSM variant: defines and a constant 'sc' key",
    "HB_FX_SMOKE" in mS.defines && "HB_FX_CSM" in mS.defines && mS.customProgramCacheKey() === `${fx.FX_KEY_ALPHA}sc`);
  check("10. the CSM's shared uniforms are bound BY IDENTITY", shS.uniforms.uFxCsm0 === fakeCsm.uCsmShadowMap0 && shS.uniforms.uFxCsmM2 === fakeCsm.uCsmMatrix2 && shS.uniforms.uFxCsmFar === fakeCsm.uCsmFar);
  check("10. smoke stage: pseudo-normal from the alpha's screen gradient, noise erosion, curl flow, rim",
    shS.fragmentShader.includes("vec2( dFdx( fxAl ), dFdy( fxAl ) )") && shS.fragmentShader.includes("texture2D( uFxNoise, fxNuv )") &&
    shS.fragmentShader.includes("fxUv += fxFl * vFxF.z;") && shS.fragmentShader.includes("pow( clamp( -fxSunV.z, 0.0, 1.0 ), 4.0 )") &&
    shS.vertexShader.includes("fxVis = hbFxCsm( fxCw.xyz, -fxCv.z );"));
  fx._setParticleFxVariantForTest(false, null);
  const mN = baseMaterial(true);
  fx.applyParticleFxMaterial(mN, { additive: true });
  check("10. ?fxSmoke=off keeps the 2026-10-09 program key exactly", mN.customProgramCacheKey() === fx.FX_KEY_ADDITIVE && !("HB_FX_SMOKE" in mN.defines));
  fx._setParticleFxVariantForTest(null, null);
  const nd = fx.buildParticleFxNoiseData(64);
  const nd2 = fx.buildParticleFxNoiseData(64);
  let edge = 0;
  for (let j = 0; j < 64; j++) edge = Math.max(edge, Math.abs(nd[(j * 64 + 63) * 4] - nd[(j * 64) * 4]));
  check("10. noise: deterministic, RGBA, wraps (tileable), uses its range",
    nd.length === 64 * 64 * 4 && nd.every((v, i) => v === nd2[i]) && edge < 40 && Math.max(...nd.filter((_, i) => i % 4 === 0)) > 200, `edge step ${edge}`);
  window.liveScene3d = { renderer: { toneMappingExposure: 5 } };
  fx.setParticleFxLive(true);
  fx.FX_UNIFORMS.uFxAlphaCal.value = 1;
  for (let i = 0; i < 40; i++) fx.particleFxFrame(10000 + i);
  check("10. display calibration follows the renderer exposure without the late pass (single-chain boot)",
    Math.abs(fx.FX_UNIFORMS.uFxAlphaCal.value - 0.2) < 1e-9 && fx.FX_UNIFORMS.uFxAddCal.value < 1, `alpha ${fx.FX_UNIFORMS.uFxAlphaCal.value}, add ${fx.FX_UNIFORMS.uFxAddCal.value}`);

  console.log(`\n[test_particle_fx_tier1] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
