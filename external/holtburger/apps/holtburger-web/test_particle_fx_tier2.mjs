// Tier-2 particle upgrade (2026-10-10) — motion (velocity stretch, ribbon
// trails, elemental swing trails), analytic sprites, ground marks, ambient GPU
// fields, the sub-pixel clamp and the showcase set pieces.
// scene3d/vfx/fx_tier2.js, fx_ribbons.js, fx_decals.js, fx_decal_effect.js,
// fx_fields.js, fx_showcase.js, scene3d/particles/particle_fx.js (tier-2 rows +
// HB_FX_MOTION / HB_FX_SHAPES / HB_FX_CLAMP), particle_fx_kids.js (bounce +
// clamp), particle_manager.js (velocity in the instance matrix), fx_cues.js
// (marks), the pipeline / loop / index / entities wiring.
//
// Guards:
//   1. switches: six preset booleans (low none / mid five / high+ultra all six,
//      the fields through the terrain-VFX ladder), BOOL_FLAGS, URL + force seams
//   2. data: tier-2 terms in the generated rows (stretch on sparks / blood /
//      debris / spray, star / orb / ring shapes with energy-matched colours,
//      spark bounce), ranges, the analytic constants agree with the shader
//   3. shader: the motion prologue strips the velocity row before any chunk,
//      the depth stage stretches + clamps, the analytic sprite replaces the
//      texture fetch, program keys gain m / a / p, the glow twin carries them
//   4. manager: a stretch row's velocity rides the instance matrix's bottom
//      row; other rows keep it zero; the motion variant off writes nothing
//   5. velocity: smoothing, same-tick reuse, respawn reset, teleport cutoff
//   6. children: HB_FX_BOUNCE / HB_FX_CLAMP from the variant, the soft-depth
//      uniforms bound by identity, the bisection in the source
//   7. ribbons: element from names / light colours, a flying bolt grows a
//      ribbon, the impact fades it out, a swinging elemental weapon trails, a
//      plain one does not, `?fxMotion=off` draws nothing
//   8. marks: spawn / fade / cap / persistent rings, the effect (DEPTH, SRC,
//      composite), cues leave the right mark, `?fxDecals=off` spawns none
//   9. fields: densities per environment, coverage from codes, the provider
//      builds seven fields under worldRoot, late-pass + glow-extra sources
//  10. showcase: a portal gets a disc + ring, a lifestone a shaft + ring, the
//      level-up a column + flare (to the glow buffer when `?fxGlow`)
//  11. wiring: pipeline lists, loop ticks, index init, entities swing note
//
// Run from apps/holtburger-web/:  node test_particle_fx_tier2.mjs

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
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

async function run() {
  globalThis.window = globalThis.window || {};
  globalThis.location = { search: "" };
  window.location = globalThis.location;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const t2f = await import("./scene3d/vfx/fx_tier2.js");
  const t1f = await import("./scene3d/vfx/fx_tier1.js");
  const quality = await import("./scene3d/quality.js");
  const fx = await import("./scene3d/particles/particle_fx.js");
  const prof = await import("./scene3d/particles/particle_fx_profiles.js");
  const tier2 = JSON.parse(src("./data/particle-fx-tier2.json"));
  const catalog = JSON.parse(src("./data/particle-fx-catalog.json"));

  // ---- 1. switches -------------------------------------------------------------------
  const P = t2f.FX_TIER2_PRESETS;
  const five = ["fxMotion", "fxShapes", "fxDecals", "fxClamp", "fxShowcase"];
  check("1. low = none; mid / high / ultra = the five plain switches",
    five.every((n) => P.low[n] === false && P.mid[n] === true && P.high[n] === true && P.ultra[n] === true));
  check("1. quality.js presets carry the five switches + fxFields on the terrain ladder (high / ultra)",
    ["low", "mid", "high", "ultra"].every((t) => five.every((n) => quality.PRESETS[t][n] === P[t][n])) &&
    quality.PRESETS.low.fxFields === false && quality.PRESETS.mid.fxFields === false &&
    quality.PRESETS.high.fxFields === true && quality.PRESETS.ultra.fxFields === true &&
    quality.TERRAIN_VFX_PROMOTED.fields === true &&
    ["low", "mid", "high", "ultra"].every((t) => quality.PRESETS[t].fxFields === quality.terrainMaster("fields", t)));
  const q = quality.getQuality("http://x/?quality=mid&fxShapes=off&fxFields=on", "");
  check("1. URL overrides parse through quality BOOL_FLAGS (fxFields too)",
    q.flags.fxShapes === false && q.flags.fxFields === true && q.flags.fxMotion === true);
  check("1. URL reading: on/off forms, garbage ignored",
    t2f.fxTier2UrlValue("fxDecals", "?fxDecals=off") === false && t2f.fxTier2UrlValue("fxDecals", "?fxDecals=yes") === true &&
    t2f.fxTier2UrlValue("fxDecals", "?fxDecals=maybe") === null);
  check("1. default (no quality object, no URL) = the mid preset (fields off)",
    t2f.fxTier2Enabled("fxMotion", "") === true && t2f.fxTier2Enabled("fxFields", "") === false);
  window.__quality = { flags: { fxFields: true, fxMotion: false } };
  check("1. the resolved quality flags win over the default", t2f.fxTier2Enabled("fxFields") === true && t2f.fxTier2Enabled("fxMotion") === false);
  delete window.__quality;
  t2f.setFxTier2Flag("fxShapes", false);
  check("1. force seam", t2f.fxTier2Enabled("fxShapes") === false);
  t2f.setFxTier2Flag("fxShapes", null);

  // ---- 2. data ----------------------------------------------------------------------------
  const row = (did) => prof.FX_DID_ROWS.get(did >>> 0);
  const T2 = (did) => fx.particleFxTier2(row(did));
  const buffOrbs = T2(0x3200003C), rim = T2(0x320002D6), star4 = T2(0x3200005D), star6 = T2(0x32000056);
  const blood = T2(0x32000237), debris = T2(0x3200024B), specks = T2(0x3200000B), spray = T2(0x3200000C);
  const sparkStar = T2(0x32000093), bouncer = T2(0x32000174);
  check("2. buff orbs: analytic orb with an energy-matched (green) sprite colour",
    buffOrbs.shape === fx.FX_SHAPE.orb && buffOrbs.sprite[1] > buffOrbs.sprite[0] && buffOrbs.sprite[1] > buffOrbs.sprite[2] && buffOrbs.halo > 0,
    JSON.stringify(buffOrbs));
  check("2. the portal rim layer is an analytic ring (purple)", rim.shape === fx.FX_SHAPE.ring && rim.sprite[2] > rim.sprite[1]);
  check("2. stars: analytic stars with 4 (warm) or 6 (cool) spikes",
    star4.shape === fx.FX_SHAPE.star && star4.spikes === 4 && star6.shape === fx.FX_SHAPE.star && star6.spikes === 6 &&
    star6.sprite[2] > star6.sprite[0]);
  check("2. stretch on blood droplets, debris, specks, water spray; a thrown star is an orb streak",
    blood.stretch > 0 && debris.stretch > 0 && specks.stretch > 0 && spray.stretch > 0 &&
    sparkStar.stretch > 0 && sparkStar.shape === fx.FX_SHAPE.orb);
  check("2. spark-children rows carry a bounce", bouncer.bounce > 0 && fx.particleFxTier1(row(0x32000174)).kidKind === fx.FX_KID_KIND.spark);
  const fam = (did) => catalog.emitters[did]?.family;
  const swarmStar = Object.entries(tier2.emitters).find(([d]) => fam(d) === "star" && catalog.emitters[d].behavior === "swarm");
  check("2. a buff-swirl star (swarm) keeps round: no stretch", !!swarmStar && !(swarmStar[1].stretch > 0));
  check("2. row 0 has no tier-2 terms", Object.values(fx.particleFxTier2(0)).every((v) => (Array.isArray(v) ? v.every((x) => x === 0) : v === 0)));
  const R = tier2.ranges;
  const bad = [];
  for (const [did, p] of Object.entries(tier2.emitters)) {
    for (const [k, v] of Object.entries(p)) {
      if (k === "sprite") { if (!(v.length === 3 && v.every((x) => x >= R.sprite[0] && x <= R.sprite[1]) && Math.max(...v) > 0)) bad.push(`${did} sprite`); continue; }
      const r = R[k];
      if (r && !(v >= r[0] && v <= r[1])) bad.push(`${did} ${k}=${v}`);
    }
    if (p.shape && !(p.sprite && p.halo > 0)) bad.push(`${did} shape without sprite/halo`);
  }
  check("2. every tier-2 value inside its range; every shape has its sprite colour + halo", bad.length === 0, bad.slice(0, 5).join(" "));
  const counts = { stretch: 0, shape: 0, bounce: 0 };
  for (const p of Object.values(tier2.emitters)) for (const k of Object.keys(counts)) if (p[k]) counts[k]++;
  check("2. broad coverage (hundreds stretched / shaped, tens bouncing)",
    counts.stretch > 200 && counts.shape > 600 && counts.bounce > 40, JSON.stringify(counts));
  const skyDids = Object.entries(catalog.emitters).filter(([, e]) => e.family === "sky").map(([d]) => d);
  check("2. sky-chain emitters carry no tier-2 terms", skyDids.every((d) => !tier2.emitters[d]));
  check("2. rows: 12 texels, the tier-2 names at 40..47",
    prof.FX_TEXELS_PER_ROW === 12 && fx.FX_PARAM_LAYOUT.length === 48 &&
    fx.FX_PARAM_LAYOUT.slice(40).join(",") === "stretch,shape,spikes,bounce,spriteR,spriteG,spriteB,halo");
  const A = tier2.analytic;
  const glslSrc = src("./scene3d/particles/particle_fx.js");
  check("2. the analytic constants of tier2.py's energy match are the shader's",
    glslSrc.includes(`smoothstep( ${A.starCoreR} - fw, ${A.starCoreR} + fw, r )`) &&
    glslSrc.includes(`smoothstep( ${A.orbCoreR} - fw, ${A.orbCoreR} + fw, r )`) &&
    glslSrc.includes(`abs( r - ${A.ringR0} )`) && glslSrc.includes(`smoothstep( ${A.ringW} - fw, ${A.ringW} + fw, d )`) &&
    glslSrc.includes(`1.0 - smoothstep( ${A.edge0.toFixed(2)}, 1.0, r )`));

  // ---- 3. shader + keys ------------------------------------------------------------------------
  fx._setParticleFxVariantForTest(false, null);
  fx._setParticleFxTier2VariantForTest({ motion: true, shapes: true, clamp: true });
  const sh = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms) };
  check("3. every anchor still matches", fx.patchParticleFxShader(sh) === true);
  const v = sh.vertexShader, f = sh.fragmentShader;
  const iPro = v.indexOf("#define instanceMatrix hbFxIm");
  check("3. the motion prologue reads + strips the velocity row, then aliases instanceMatrix, BEFORE <project_vertex>",
    iPro > 0 && v.includes("vec3 hbFxVel = vec3( hbFxIm[ 0 ][ 3 ], hbFxIm[ 1 ][ 3 ], hbFxIm[ 2 ][ 3 ] );") &&
    v.includes("hbFxIm[ 2 ][ 3 ] = 0.0;") && iPro < v.indexOf("#include <project_vertex>") &&
    v.indexOf("#include <color_vertex>") < iPro);
  const iDepth = v.indexOf("vFxD.w = gl_Position.w;");
  check("3. the depth stage clamps then stretches, before the view depth is taken",
    v.indexOf("hbPx < uFxMinPx") > v.indexOf("#include <project_vertex>") &&
    v.indexOf("hbPx < uFxMinPx") < v.indexOf("hbFxStretchK > 0.0 && hbR > 1e-5") &&
    v.indexOf("hbFxStretchK > 0.0 && hbR > 1e-5") < iDepth &&
    v.includes("hbOff += hbDir * ( dot( hbOff, hbDir ) * ( hbS - 1.0 ) - 0.5 * hbL );") && v.includes("vFxA.a *= hbE;"));
  check("3. the stretch reads texel 10 and the sprite texel 11 (tier-2 fetches)",
    v.includes("texelFetch( uFxTable, ivec2( 10, fxRow ), 0 )") && v.includes("texelFetch( uFxTable, ivec2( 11, fxRow ), 0 )"));
  check("3. the fragment computes the analytic sprite instead of the texture for shaped rows",
    f.includes("vec4 hbFxAnalytic( vec2 uv )") && f.includes("if ( vFxSh.x > 0.5 ) sampledDiffuseColor = hbFxAnalytic( fxUv );") &&
    f.includes("else sampledDiffuseColor = texture2D( map, fxUv );"));
  check("3. the tier-2 uniforms are bound by identity", sh.uniforms.uFxStretchT === fx.FX_UNIFORMS.uFxStretchT &&
    sh.uniforms.uFxViewH === fx.FX_UNIFORMS.uFxViewH && sh.uniforms.uFxMinPx === fx.FX_UNIFORMS.uFxMinPx);
  const mA = baseMaterial(true);
  fx.applyParticleFxMaterial(mA, { additive: true });
  check("3. program keys gain m / a / p; defines set", mA.customProgramCacheKey() === `${fx.FX_KEY_ADDITIVE}map` &&
    "HB_FX_MOTION" in mA.defines && "HB_FX_SHAPES" in mA.defines && "HB_FX_CLAMP" in mA.defines);
  const gm = fx.makeParticleFxGlowMaterial(mA);
  check("3. the glow twin carries the variant (it shares the velocity-carrying matrices)",
    "HB_FX_MOTION" in gm.defines && "HB_FX_GLOW" in gm.defines && gm.customProgramCacheKey() === `${fx.FX_KEY_GLOW}map`);
  fx._setParticleFxTier2VariantForTest({ motion: false, shapes: false, clamp: false });
  const mOff = baseMaterial(true);
  fx.applyParticleFxMaterial(mOff, { additive: true });
  check("3. tier 2 off keeps the tier-1 key and no tier-2 define", mOff.customProgramCacheKey() === fx.FX_KEY_ADDITIVE &&
    !("HB_FX_MOTION" in mOff.defines) && !("HB_FX_SHAPES" in mOff.defines) && !("HB_FX_CLAMP" in mOff.defines) &&
    fx.particleFxMotionOn() === false);

  // ---- 4. manager: velocity in the instance matrix ---------------------------------------------
  fx._setParticleFxTier2VariantForTest({ motion: true, shapes: true, clamp: true });
  const { setCurrentTime } = await import("./scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const { ParticleManager } = await import("./scene3d/particles/particle_manager.js");
  const mcam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  mcam.position.set(0, -5, 1); mcam.lookAt(0, 0, 0); mcam.updateMatrixWorld(true);
  window.liveScene3d = { cameraSwitcher: { activeCamera: mcam }, camera: mcam };
  const geom = makeQuad();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const scene = new THREE.Group();
  const mgr = new ParticleManager({ scene, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  const bloodDid = 0x32000237, flameDid = 0x3200026E;
  await mgr.addEmitter({ emitterInfo: emitterPojo({ id: bloodDid, aZ: 1, minA: 1, maxA: 1, particleType: 2 }), parent });
  t += 0.1; mgr.tick();
  t += 0.1; mgr.tick();
  t += 0.1; mgr.tick();
  let bucket = null;
  scene.traverse((o) => { if (o.isInstancedMesh && o.userData?.particleFx) bucket = o; });
  const mm = bucket ? bucket.instanceMatrix.array : null;
  check("4. a stretch row's velocity rides the bottom row of its instance matrix (rising ⇒ +z)",
    !!mm && bucket.count > 0 && mm[11] > 0.1 && Math.abs(mm[3]) < 1e-3 && mm[15] === 1,
    mm ? `row (${mm[3].toFixed(3)}, ${mm[7].toFixed(3)}, ${mm[11].toFixed(3)}, ${mm[15]})` : "no bucket");
  const scene2 = new THREE.Group();
  const mgr2 = new ParticleManager({ scene: scene2, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  await mgr2.addEmitter({ emitterInfo: emitterPojo({ id: flameDid, aZ: 1, minA: 1, maxA: 1, particleType: 2 }), parent });
  t += 0.1; mgr2.tick();
  t += 0.1; mgr2.tick();
  let b2 = null;
  scene2.traverse((o) => { if (o.isInstancedMesh && o.userData?.particleFx) b2 = o; });
  check("4. a row without stretch keeps the row zero (an affine matrix)",
    !!b2 && b2.count > 0 && b2.instanceMatrix.array[3] === 0 && b2.instanceMatrix.array[7] === 0 && b2.instanceMatrix.array[11] === 0);
  fx._setParticleFxTier2VariantForTest({ motion: false, shapes: false, clamp: false });
  const scene3 = new THREE.Group();
  const mgr3 = new ParticleManager({ scene: scene3, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  await mgr3.addEmitter({ emitterInfo: emitterPojo({ id: bloodDid, aZ: 1, minA: 1, maxA: 1, particleType: 2 }), parent });
  t += 0.1; mgr3.tick();
  t += 0.1; mgr3.tick();
  let b3 = null;
  scene3.traverse((o) => { if (o.isInstancedMesh && o.userData?.particleFx) b3 = o; });
  check("4. the motion variant off writes no velocity (programs without it would read w)",
    !!b3 && b3.count > 0 && b3.instanceMatrix.array[11] === 0);
  fx._setParticleFxTier2VariantForTest({ motion: true, shapes: true, clamp: true });

  // ---- 5. velocity helper -------------------------------------------------------------------------
  const em = { parts: [1, 1] };
  const e = new Float32Array(16);
  const out = [0, 0, 0];
  e[12] = 0; e[13] = 0; e[14] = 0;
  fx.particleFxSlotVelocity(em, 0, e, 0.5, 10, out);
  e[14] = 0.2;
  fx.particleFxSlotVelocity(em, 0, e, 0.5, 10.1, out);
  const v1 = out[2];
  e[14] = 0.4;
  fx.particleFxSlotVelocity(em, 0, e, 0.5, 10.2, out);
  check("5. finite difference, then lightly smoothed", Math.abs(v1 - 2) < 1e-3 && Math.abs(out[2] - 2) < 1e-3, `v1 ${v1}, v2 ${out[2]}`);
  e[14] = 9;
  fx.particleFxSlotVelocity(em, 0, e, 0.5, 10.2, out);
  check("5. a second call in the same tick returns the last velocity", Math.abs(out[2] - 2) < 1e-3);
  fx.particleFxSlotVelocity(em, 0, e, 0.7, 10.3, out);
  check("5. a respawn (new seed) restarts at rest", out[0] === 0 && out[1] === 0 && out[2] === 0);
  e[12] = 50;
  fx.particleFxSlotVelocity(em, 0, e, 0.7, 10.4, out);
  check("5. a jump over 60 m/s is a teleport, not a velocity", out[0] === 0 && out[2] === 0);

  // ---- 6. children ---------------------------------------------------------------------------------
  const kidsMod = await import("./scene3d/particles/particle_fx_kids.js");
  const km = kidsMod.particleFxKidsMaterial();
  check("6. children compile with the variant: HB_FX_BOUNCE (motion) + HB_FX_CLAMP",
    "HB_FX_BOUNCE" in km.defines && "HB_FX_CLAMP" in km.defines && km.uniforms.uFxSceneW === fx.FX_UNIFORMS.uFxSceneW &&
    km.uniforms.uFxSoftOn === fx.FX_UNIFORMS.uFxSoftOn && km.uniforms.uFxMinPx === fx.FX_UNIFORMS.uFxMinPx);
  const kv = kidsMod.PARTICLE_FX_KIDS_GLSL.vertex;
  check("6. the spark marches + bisects its crossing of the scene depth, bounces only on contact, off a level floor",
    kv.includes("bool hbKidBehind( vec3 c, out float gap )") && kv.includes("for ( int s = 1; s <= 4; s++ )") &&
    kv.includes("for ( int s = 0; s < 5; s++ )") && kv.includes("if ( gap < 0.6 ) {") &&
    kv.includes("vec3 vr = ( vh - 2.0 * dot( vh, up ) * up ) * bounce;"));

  // ---- 7. ribbons -----------------------------------------------------------------------------------
  const rib = await import("./scene3d/vfx/fx_ribbons.js");
  const E = rib.fxElementFromName;
  check("7. element from the projectile's name",
    E("Flame Bolt") === "fire" && E("Frost Bolt") === "frost" && E("Acid Stream") === "acid" && E("Lightning Bolt") === "lightning" &&
    E("Nether Bolt") === "nether" && E("Force Bolt") === "force" && E("Whirling Blade") === "blade" && E("Arrow") === "missile" &&
    E("Fire Arrow") === "fire" && E("Shock Wave") === "lightning" && E("Quarrel") === "missile" && E("Something") === null);
  check("7. element from a light colour when the name says nothing",
    rib.fxElementFromColor(1, 0.5, 0.1) === "fire" && rib.fxElementFromColor(0.4, 0.8, 1) === "frost" &&
    rib.fxElementFromColor(0.4, 1, 0.2) === "acid" && rib.fxElementFromColor(0.7, 0.2, 1) === "nether" &&
    rib.fxElementFromColor(1, 1, 1) === null);
  rib._resetFxRibbonsForTest();
  const names = new Map();
  window.__sessionHandle = { objectName: (g) => names.get(g) };
  const world = new THREE.Scene();
  const bolt = { guid: 0x80000001, _isProjectile: true, _ballistic: true, root: new THREE.Group() };
  world.add(bolt.root);
  names.set(bolt.guid, "Flame Bolt");
  const entityMap = new Map([[bolt.guid, bolt]]);
  const s3d = { entityManager: { entityMap }, scene: world, renderer: { toneMappingExposure: 5 } };
  for (let i = 0; i < 8; i++) {
    bolt.root.position.set(i * 0.6, 1.5, 0);
    rib.tickFxRibbons(s3d, 5000 + i * 20);
  }
  const ribMesh = rib.fxRibbonMesh();
  const ri = ribMesh.geometry.attributes.aCol.array;
  check("7. a flying bolt grows a ribbon in ONE shared draw, coloured by its element",
    ribMesh.visible === true && ribMesh.parent === world && ribMesh.geometry.drawRange.count > 0 &&
    Math.abs(ri[0] - rib.FX_ELEMENTS.fire.color[0]) < 1e-6 && rib.fxRibbonStats().drawn === 1 && ribMesh.layers.mask === 2,
    JSON.stringify(rib.fxRibbonStats()));
  check("7. the ribbon's u runs head (0) → tail, alpha falls to it",
    ribMesh.geometry.attributes.aInfo.array[0] === 0 && ribMesh.geometry.attributes.aInfo.array[4 * 2 * 3] > 0);
  bolt._ballistic = false; bolt._projectileImpacted = true;
  rib.tickFxRibbons(s3d, 5200);
  const alive = rib.fxRibbonStats().live;
  rib.tickFxRibbons(s3d, 5600);
  check("7. the impact stops it growing; it fades and retires", alive === 1 && rib.fxRibbonStats().live === 0 && ribMesh.visible === false);
  check("7. fxProjectileElement reads a live projectile's element (for its impact mark)",
    (() => { window.liveScene3d = { entityManager: { entityMap } }; const el = rib.fxProjectileElement(bolt.guid); return el && el.decal === "scorch"; })());
  // swing trails
  rib._resetFxRibbonsForTest();
  const wielder = { guid: 0x50000001, root: new THREE.Group() };
  const sword = { guid: 0x80000010, root: new THREE.Group(), _attachedParentGuid: wielder.guid };
  const plain = { guid: 0x80000011, root: new THREE.Group(), _attachedParentGuid: wielder.guid };
  for (const w of [sword, plain]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.02), new THREE.MeshBasicMaterial());
    blade.position.set(0, 0.55, 0);
    w.root.add(blade);
    wielder.root.add(w.root);
  }
  world.add(wielder.root);
  names.set(sword.guid, "Flaming Long Sword");
  names.set(plain.guid, "Long Sword");
  const swingMap = new Map([[wielder.guid, wielder], [sword.guid, sword], [plain.guid, plain]]);
  const s3dSwing = { entityManager: { entityMap: swingMap }, scene: world };
  rib.fxNoteSwing(wielder, 9000);
  for (let i = 0; i < 6; i++) {
    wielder.root.rotation.z = i * 0.35;   // the blade (local +y) sweeps round the wielder's z
    wielder.root.updateMatrixWorld(true);
    rib.tickFxRibbons(s3dSwing, 9000 + i * 16);
  }
  const bl = rib.fxBladeLocal(sword);
  check("7. the blade: its long axis, the tip at the far end from the grip",
    !!bl && Math.abs(bl.tip.y - 1.05) < 1e-3 && Math.abs(bl.mid.y - 1.05 * 0.35) < 1e-3, bl ? `tip ${bl.tip.toArray()}` : "none");
  check("7. a swinging ELEMENTAL weapon trails (one swept ribbon); a plain one does not",
    rib.fxRibbonStats().live === 1 && rib.fxRibbonStats().drawn === 1 && ribMesh.geometry.attributes.aCol.array[3] === 1);
  rib.tickFxRibbons(s3dSwing, 9000 + rib.FX_SWING_WINDOW_MS + 600);
  check("7. the window closes: the trail fades out", rib.fxRibbonStats().live === 0);
  t2f.setFxTier2Flag("fxMotion", false);
  bolt._ballistic = true; bolt._projectileImpacted = false;
  rib.tickFxRibbons(s3d, 12000);
  check("7. ?fxMotion=off: no ribbon", rib.fxRibbonStats().live === 0 && ribMesh.visible === false);
  t2f.setFxTier2Flag("fxMotion", null);
  const rv = rib.FX_RIBBON_GLSL.vertex;
  check("7. ribbon shader: camera-facing strip, lightning jag re-randomised every ~50 ms, log depth",
    rv.includes("cross( normalize( T ), toCam )") && rv.includes("floor( uRibTime * 20.0 )") && rv.includes("#include <logdepthbuf_vertex>"));
  rib._resetFxRibbonsForTest();

  // ---- 8. marks -------------------------------------------------------------------------------------
  const dec = await import("./scene3d/vfx/fx_decals.js");
  dec._resetFxDecalsForTest();
  const d0 = dec.spawnFxDecal({ position: { x: 1, y: 0, z: 2 }, kind: "scorch", nowMs: 1000 });
  check("8. a scorch spawns with its defaults", !!d0 && d0.kind === dec.FX_DECAL_KIND.scorch && d0.radius === dec.FX_DECAL_DEFAULTS.scorch.radius);
  check("8. fade: in over 120 ms, full to 60 % of life, out to 0",
    dec.fxDecalFade(60, 1000) === 0.5 && dec.fxDecalFade(500, 1000) === 1 && Math.abs(dec.fxDecalFade(800, 1000) - 0.5) < 1e-9 &&
    dec.fxDecalFade(1000, 1000) === 0);
  for (let i = 0; i < 40; i++) dec.spawnFxDecal({ position: { x: i, y: 0, z: 0 }, kind: "frost", nowMs: 2000 + i });
  const ring = dec.addFxDecal({ position: { x: 0, y: 0, z: 0 }, kind: "ring", radius: 2, color: [1, 0, 1] });
  const live = dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 2100);
  check("8. at most 32 drawn (oldest transient evicted), the persistent ring always kept, nearest first",
    live.length === dec.FX_DECAL_MAX && live.includes(ring) && dec.fxDecalStats().transient === dec.FX_DECAL_MAX &&
    live[0].dist2 <= live[live.length - 1].dist2);
  check("8. a ring is persistent-only (spawnFxDecal refuses it)", dec.spawnFxDecal({ position: { x: 0, y: 0, z: 0 }, kind: "ring" }) === null);
  dec.releaseFxDecal(ring);
  check("8. expired marks are pruned", dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 2000 + 15000 + 100).length === 0);
  t2f.setFxTier2Flag("fxDecals", false);
  check("8. ?fxDecals=off: nothing spawns", dec.spawnFxDecal({ position: { x: 0, y: 0, z: 0 }, kind: "acid" }) === null);
  t2f.setFxTier2Flag("fxDecals", null);
  dec._resetFxDecalsForTest();
  const { FxDecalEffect, createFxDecalEffect, FX_DECAL_GLSL } = await import("./scene3d/vfx/fx_decal_effect.js");
  const PP = await import("postprocessing");
  const de = new FxDecalEffect({ camera: mcam });
  check("8. the effect: SRC blend, DEPTH attribute (keeps its slot before the aerial), scene*MUL + ADD",
    (de.getAttributes() & PP.EffectAttribute.DEPTH) !== 0 && de.blendMode.blendFunction === PP.BlendFunction.SRC &&
    FX_DECAL_GLSL.composite.includes("outputColor = vec4(inputColor.rgb * m + a, inputColor.a);") &&
    de.mulMaterial.blendSrc === THREE.DstColorFactor && de.mulMaterial.blendDst === THREE.ZeroFactor &&
    de.mulMaterial.side === THREE.BackSide && de.addMaterial.blendDst === THREE.OneFactor);
  check("8. box fragment: depth → world position, up-facing only, inside the box, fogged",
    FX_DECAL_GLSL.fragment.includes("vec3 wp = ( uDecalCamWorld * vec4( vp, 1.0 ) ).xyz;") &&
    FX_DECAL_GLSL.fragment.includes("smoothstep( 0.45, 0.8, abs( n.y ) / nl )") &&
    FX_DECAL_GLSL.fragment.includes("if ( abs( ly ) > 1.0 || dot( q, q ) > 1.0 ) discard;") && FX_DECAL_GLSL.fragment.includes("fogF"));
  t2f.setFxTier2Flag("fxDecals", false);
  check("8. createFxDecalEffect is null when off (the pipeline drops the slot)", createFxDecalEffect() === null);
  t2f.setFxTier2Flag("fxDecals", null);
  const cues = await import("./scene3d/vfx/fx_cues.js");
  const lights = await import("./scene3d/vfx/fx_lights.js");
  const distort = await import("./scene3d/vfx/fx_distort.js");
  lights._resetFxLightsForTest();
  const fired = cues.fireFxCue("explode", { x: 0, y: 0, z: 0 }, { decalWorld: { x: 0, y: -0.1, z: 0 } });
  check("8. an explosion leaves a scorch with its own hot rim colour", !!fired.decal && fired.decal.kindName === "scorch" &&
    fired.decal.color[0] === cues.FX_CUES.explode.color[0]);
  const frostHit = cues.fireFxCue("projectileCollision", { x: 0, y: 0, z: 0 },
    { decalWorld: { x: 1, y: 0, z: 0 }, element: rib.FX_ELEMENTS.frost });
  const forceHit = cues.fireFxCue("projectileCollision", { x: 0, y: 0, z: 0 },
    { decalWorld: { x: 1, y: 0, z: 0 }, element: rib.FX_ELEMENTS.force });
  check("8. an impact takes its projectile's element: frost rimes, force leaves nothing",
    frostHit.decal?.kindName === "frost" && forceHit.decal === null);
  check("8. the breaths mark ahead of the breather", cues.fxCueDecalAhead("breatheAcid") > 0 && cues.fxCueDecalAhead("explode") === 0 &&
    cues.fireFxCue("breatheAcid", { x: 0, y: 0, z: 0 }, { decalWorld: { x: 3, y: 0, z: 0 } }).decal?.kindName === "acid");
  check("8. a cue without a mark position leaves none (tier-1 call shape)", cues.fireFxCue("explode", { x: 0, y: 0, z: 0 }).decal === null);
  lights._resetFxLightsForTest();
  distort._resetFxDistortForTest();
  dec._resetFxDecalsForTest();

  // ---- 9. fields ------------------------------------------------------------------------------------
  const fields = await import("./scene3d/vfx/fx_fields.js");
  const fam9 = await import("./scene3d/terrain_families.js");
  const D = fields.fxFieldDensities;
  const grassy = { grass: 0.8 };
  check("9. fireflies at night over grass, not by day; pollen by day",
    D(grassy, 1, false).fireflies > 0.9 && D(grassy, 0, false).fireflies === 0 && D(grassy, 0, false).pollen > 0.5 && D(grassy, 1, false).pollen === 0);
  check("9. indoors: only the dust", (() => { const d = D(grassy, 1, true); return d.dust === 1 && d.fireflies === 0 && d.leaves === 0; })());
  check("9. snow over snow, ash + embers over volcanic ground, leaves over forest floor",
    D({ snow: 1 }, 0, false).snow === 1 && D({ volcano: 1 }, 0, false).ash === 1 && D({ volcano: 1 }, 0, false).embers === 1 &&
    D({ forest: 1 }, 0, false).leaves === 1 && D({}, 0, false).snow === 0);
  const cov = fields.fxFieldCoverage([1, 1, 21, 15, 6, -1]);
  check("9. coverage from terrain codes (forest codes counted as both grass and forest; unknown skipped)",
    Math.abs(cov.grass - 0.6) < 1e-9 && Math.abs(cov.forest - 0.2) < 1e-9 && Math.abs(cov.snow - 0.2) < 1e-9 &&
    Math.abs(cov.volcano - 0.2) < 1e-9 && fam9.TERRAIN_CODE_TO_FAMILY[21] === fam9.FAM_GRASS);
  fields._resetFxFieldsForTest();
  const prov = fields.createFxFieldsProvider();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  const sceneF = new THREE.Scene();
  sceneF.add(worldRoot);
  const terrainGroup = new THREE.Group();
  worldRoot.add(terrainGroup);
  sceneF.updateMatrixWorld(true);
  const fcam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  fcam.position.set(10, 3, -20);
  fcam.updateMatrixWorld(true);
  const oracle = { sample: (_x, _y, o) => { o.code = 1; o.hasHeight = true; o.height = 1.25; return o; } };
  const s3dF = { terrainGroup, renderer: { toneMappingExposure: 5 }, skyLightingController: { _lastState: { dirPitch: 0.9 } } };
  prov.update(0.5, { camera: fcam, scene3d: s3dF, oracle, tSec: 100 });
  for (let i = 0; i < 30; i++) prov.update(0.5, { camera: fcam, scene3d: s3dF, oracle, tSec: 100 + i * 0.5 });
  const st = fields.fxFieldsStats();
  let fieldMeshes = [];
  worldRoot.traverse((o) => { if (o.userData?.isFxField) fieldMeshes.push(o); });
  check("9. the provider builds the seven fields under worldRoot (AC frame), ONE program",
    st.built === true && fieldMeshes.length === 7 && new Set(fieldMeshes.map((m) => m.material.vertexShader)).size === 1);
  const ff = fieldMeshes.find((m) => m.userData.field === "fireflies");
  check("9. at night over grass the fireflies fade in; the ground grid follows the oracle",
    st.night > 0.9 && ff.visible === true && ff.material.uniforms.uDensity.value > 0.5 &&
    ff.material.uniforms.uHgt.value.every((h) => h === 1.25), JSON.stringify(st.densities));
  const lateOut = [];
  const poc = await import("./scene3d/particles_over_clouds.js");
  poc.collectLateFx(lateOut, sceneF, 0xffffffff);
  check("9. additive fields draw in the late particle pass", lateOut.includes(ff));
  const gx = [];
  for (const s of poc.fxGlowExtraSources()) s.collect(gx);
  check("9. fireflies send light to the glow buffer (a glow extra with its own depth-occluded variant)",
    gx.some((e) => e.object === ff && "HB_FIELD_GLOW" in e.material.defines));
  t2f.setFxTier2Flag("fxFields", false);
  check("9. ?fxFields=off: initFxFields registers nothing", fields.initFxFields() === null);
  t2f.setFxTier2Flag("fxFields", null);
  prov.dispose();
  fields._resetFxFieldsForTest();

  // ---- 10. showcase ---------------------------------------------------------------------------------
  const show = await import("./scene3d/vfx/fx_showcase.js");
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();
  const sScene = new THREE.Scene();
  const portal = { guid: 0x70000001, root: new THREE.Group(), meta: { objDescFlags: show.ODF_PORTAL } };
  const stone = { guid: 0x70000002, root: new THREE.Group(), meta: { objDescFlags: show.ODF_LIFESTONE } };
  portal.root.position.set(5, 0, 0);
  stone.root.position.set(-5, 0, 0);
  sScene.add(portal.root, stone.root);
  sScene.updateMatrixWorld(true);
  const scam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  scam.position.set(0, 2, 10);
  scam.updateMatrixWorld(true);
  const s3dS = { entityManager: { entityMap: new Map([[portal.guid, portal], [stone.guid, stone]]) }, scene: sScene, camera: scam,
    renderer: { toneMappingExposure: 5 } };
  t1f.setFxTier1Flag("fxGlow", true);
  const nS = show.tickFxShowcase(s3dS, 20000);
  const ss = show.fxShowcaseStats();
  const sMesh = sScene.children.find((o) => o.userData?.isFxShowcase);
  const SA0 = sMesh?.geometry.attributes.aS0.array;
  check("10. a portal gets its portal-space disc, a lifestone its shaft — one instanced draw",
    nS === 2 && ss.portals === 1 && ss.lifestones === 1 && !!sMesh && SA0[3] === show.FX_SHOWCASE_KIND.disc &&
    SA0[7] === show.FX_SHOWCASE_KIND.shaft && Math.abs(SA0[1] - 1.6) < 1e-6);
  const rings = dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 20000);
  check("10. both stand in a persistent light ring on the ground", rings.length === 2 && rings.every((d) => d.persistent && d.kindName === "ring"));
  check("10. the level-up raises a column and flares", show.fireFxShowcaseCue("levelUp", { x: 0, y: 0, z: 0 }, 21000) === true &&
    show.fireFxShowcaseCue("explode", { x: 0, y: 0, z: 0 }, 21000) === false);
  show.tickFxShowcase(s3dS, 21150);
  check("10. ?fxGlow on but no glow pass running: the flare stays in the scene", sMesh.material.uniforms.uShowFlareInScene.value === 1);
  window.__fxGlow = { effect: {} };   // the composer built the glow effect
  show.tickFxShowcase(s3dS, 21200);
  const gxs = [];
  for (const s of poc.fxGlowExtraSources()) s.collect(gxs);
  check("10. with ?fxGlow the flare goes to the glow buffer (and not into the scene)",
    show.fxShowcaseStats().flares === 1 && sMesh.material.uniforms.uShowFlareInScene.value === 0 &&
    gxs.some((e) => e.object === sMesh && "HB_SHOWCASE_GLOW" in e.material.defines));
  t1f.setFxTier1Flag("fxGlow", false);
  delete window.__fxGlow;
  show.tickFxShowcase(s3dS, 21300);
  check("10. without the glow buffer the flare draws in the scene", sMesh.material.uniforms.uShowFlareInScene.value === 1);
  t1f.setFxTier1Flag("fxGlow", null);
  const env0 = show.fxColumnEnvelope(0.1), env1 = show.fxColumnEnvelope(1.0), env2 = show.fxColumnEnvelope(3.1);
  check("10. the column ramps in, holds, fades; it grows to full height", env0[0] > 0 && env0[0] < 1 && env1[0] === 1 && env1[1] === 1 && env2[0] === 0);
  s3dS.entityManager.entityMap.delete(portal.guid);
  show.tickFxShowcase(s3dS, 22000);
  check("10. a portal out of the scan releases its ring", dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 22000).filter((d) => d.persistent).length === 1);
  t2f.setFxTier2Flag("fxShowcase", false);
  show.tickFxShowcase(s3dS, 23000);
  check("10. ?fxShowcase=off: nothing drawn, rings released",
    sMesh.visible === false && dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 23000).length === 0);
  t2f.setFxTier2Flag("fxShowcase", null);
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();

  // ---- 11. wiring -----------------------------------------------------------------------------------
  const pipe = src("./scene3d/atmosphere_pipeline.js");
  check("11. the pipeline puts fxDecals after the AO composite and before the clouds / aerial on BOTH chains",
    pipe.includes("[heatHaze, fxDistort, ssaoComposite, fxDecals, cloudsMain, aerialPerspective, horizonDissolve].filter(Boolean)") &&
    pipe.includes("...[heatHaze, fxDistort, ssaoComposite, fxDecals, cloudsMain, aerialPerspective, horizonDissolve, fxGlow,") &&
    pipe.includes("fxDecals?.dispose?.();"));
  const loopSrc = src("./scene3d/loop.js");
  check("11. the loop ticks the ribbons and the showcase after the particle phase",
    loopSrc.indexOf("tickFxRibbons(scene3d);") > loopSrc.indexOf("tickStaticParticles(scene3d); } catch (_) {}") &&
    loopSrc.indexOf("tickFxShowcase(scene3d);") > loopSrc.indexOf("tickFxRibbons(scene3d);"));
  check("11. index.js registers the fields beside the grass", src("./scene3d/index.js").includes("initFxFields();"));
  const ent = src("./scene3d/entities.js");
  check("11. entities.js notes a melee swing (not a missile shot) for the swing trails",
    ent.includes("if (cls === \"attack\" && _fxIsMeleeSwing(cmd)) fxNoteSwing(inst);") && ent.includes("const _FX_SWING_NOT = new Set([0x0061,"));
  const pev = src("./scene3d/play_effect_vfx.js");
  check("11. the PlayEffect cue places its mark (ground / ahead) and fires the showcase cue",
    pev.includes("fireFxCue(look, _cueWorld, opts);") && pev.includes("fireFxShowcaseCue(look, _cueWorld);") &&
    pev.includes("element: projectile ? fxProjectileElement(targetGuid) : null"));

  console.log(`\n[test_particle_fx_tier2] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
