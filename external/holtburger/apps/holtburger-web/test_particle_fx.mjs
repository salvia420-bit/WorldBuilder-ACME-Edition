// `?particleFx` (2026-10-09) — the per-emitter particle upgrade.
// scene3d/particles/particle_fx.js + particle_fx_profiles.js (generated from
// data/particle-fx-catalog.json) + the particle_manager bucket wiring.
//
// Guards:
//   1. flag: default ON, off-forms off
//   2. the generated module is in sync with the catalog, and the catalog covers
//      EVERY retail emitter the DAT extraction found (2051) + every synthesized
//      emitter kind; every emitter has a note; row 0 is the neutral identity
//   3. row lookup: fxProfile name > emitter id > neutral
//   4. shader patch: every anchor of three r184's MeshBasicMaterial matched
//      (vertex + fragment), shared uniforms installed, two constant program keys
//   5. instance packing: (op, age, row + seed) and seeds that are stable for a
//      particle's life but change on respawn
//   6. manager integration: an additive and an alpha emitter build FX buckets,
//      write packed instance colours, keep the blend state; sky-chain emitters
//      and `?particleFx=off` keep the stock bucket (op, op, op)
//   7. late-pass hooks: registered; `before` copies and turns the soft term on,
//      restores the render target; `after` turns it off
//   8. light: day / night / indoor targets
//   9. every row inside the safe ranges; spin only on full-UV 4-vertex quads
//
// Run from apps/holtburger-web/:  node test_particle_fx.mjs

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

  const fx = await import("./scene3d/particles/particle_fx.js");
  const prof = await import("./scene3d/particles/particle_fx_profiles.js");
  const poc = await import("./scene3d/particles_over_clouds.js");
  const gen = await import("./scripts/gen-particle-fx-profiles.mjs");
  const catalog = JSON.parse(readFileSync(new URL("./data/particle-fx-catalog.json", import.meta.url), "utf8"));

  // ---- 1. flag ---------------------------------------------------------------
  check("1. ?particleFx default ON", fx.particleFxEnabled("") === true && fx.particleFxEnabled("?x=1") === true);
  check("1. ?particleFx=off|0|false|no → off",
    ["off", "0", "false", "no", "OFF"].every((v) => fx.particleFxEnabled(`?particleFx=${v}`) === false));
  check("1. ?particleFx=on / garbage → on", fx.particleFxEnabled("?particleFx=on") && fx.particleFxEnabled("?particleFx=zz"));

  // ---- 2. catalog + generated module -------------------------------------------
  const expected = gen.renderModule(catalog);
  const actual = readFileSync(new URL("./scene3d/particles/particle_fx_profiles.js", import.meta.url), "utf8");
  check("2. particle_fx_profiles.js is generated from the catalog (not stale)", expected === actual,
    expected === actual ? "" : "run: node scripts/gen-particle-fx-profiles.mjs");
  const dids = Object.keys(catalog.emitters);
  check("2. catalog covers all 2051 retail ParticleEmitters", dids.length === 2051, `${dids.length}`);
  check("2. every DID is a 0x32 ParticleEmitter id", dids.every((d) => (parseInt(d, 16) >>> 24) === 0x32));
  const noNote = dids.filter((d) => !(typeof catalog.emitters[d].note === "string" && catalog.emitters[d].note.length > 12));
  check("2. every retail emitter carries a note on what it is in game", noNote.length === 0, noNote.slice(0, 5).join(","));
  const synthWanted = ["particle.gemSparkle", "particle.brazierEmbers.ember", "particle.brazierEmbers.smoke",
    "terrain.volcanoEmbers.ember", "terrain.volcanoEmbers.smoke", "particle.foliagePollen", "particle.foliageFireflies",
    "particle.foliageLeaves", "particle.breathFog", "terrain.sandDevils", "terrain.swampFireflies", "terrain.swampMidges",
    "terrain.marshGas.bubble", "terrain.marshGas.wisp"];
  const missingSynth = synthWanted.filter((n) => !catalog.synthesized[n] || !Number.isInteger(prof.FX_NAMED_ROWS[n]));
  check("2. every synthesized emitter kind has its own profile", missingSynth.length === 0, missingSynth.join(","));
  check("2. every retail DID resolves in FX_DID_ROWS", dids.every((d) => prof.FX_DID_ROWS.has(parseInt(d, 16) >>> 0)));
  const r0 = prof.FX_PROFILE_ROWS[0];
  check("2. row 0 is the neutral identity",
    JSON.stringify(r0) === JSON.stringify([1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 1, 0]), // [23] edgeSoft 0
    JSON.stringify(r0));
  check("2. every row has 24 finite floats", prof.FX_PROFILE_ROWS.every((r) => r.length === 24 && r.every(Number.isFinite)));
  // individuality: the upgrade is per emitter, not one blanket look
  const upgraded = dids.filter((d) => prof.FX_DID_ROWS.get(parseInt(d, 16) >>> 0) !== 0).length;
  check("2. retail emitters with a non-neutral upgrade (only misc/none/sky stay neutral)",
    upgraded >= 1950, `${upgraded}/2051, ${prof.FX_PROFILE_ROWS.length} distinct rows`);

  // ---- 3. row lookup -------------------------------------------------------------
  const someDid = parseInt(dids.find((d) => prof.FX_DID_ROWS.get(parseInt(d, 16) >>> 0) > 0), 16);
  check("3. retail emitter id → its row", fx.particleFxRowFor({ id: someDid }) === prof.FX_DID_ROWS.get(someDid >>> 0));
  check("3. fxProfile name wins over id",
    fx.particleFxRowFor({ id: someDid, fxProfile: "particle.gemSparkle" }) === prof.FX_NAMED_ROWS["particle.gemSparkle"]);
  check("3. synthesized synth id (pollen 0xF0E00001) → its row",
    fx.particleFxRowFor({ id: 0xF0E00001 }) === prof.FX_NAMED_ROWS["particle.foliagePollen"]);
  check("3. unknown id / no info → neutral row 0", fx.particleFxRowFor({ id: 0x12345678 }) === 0 && fx.particleFxRowFor(null) === 0);

  // ---- 4. shader patch -------------------------------------------------------------
  const shader = {
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
  };
  const ok = fx.patchParticleFxShader(shader);
  check("4. every r184 MeshBasicMaterial anchor matched", ok === true);
  check("4. vertex stage fetches the profile row (texelFetch × 6) after <color_vertex>",
    (shader.vertexShader.match(/texelFetch\( uFxTable/g) || []).length === 6 &&
    shader.vertexShader.indexOf("#include <color_vertex>") < shader.vertexShader.indexOf("texelFetch( uFxTable"));
  check("4. view depth written after <project_vertex>",
    shader.vertexShader.indexOf("vFxD.w = gl_Position.w") > shader.vertexShader.indexOf("#include <project_vertex>"));
  check("4. <map_fragment> and <color_fragment> replaced",
    !shader.fragmentShader.includes("#include <map_fragment>") && !shader.fragmentShader.includes("#include <color_fragment>") &&
    shader.fragmentShader.includes("texture2D( map, fxUv )"));
  check("4. alpha test still follows the FX colour stage",
    shader.fragmentShader.indexOf("diffuseColor = vec4( fxC, fxA )") < shader.fragmentShader.indexOf("#include <alphatest_fragment>"));
  check("4. shared uniforms installed (same objects)",
    shader.uniforms.uFxTable === fx.FX_UNIFORMS.uFxTable && shader.uniforms.uFxSoftOn === fx.FX_UNIFORMS.uFxSoftOn &&
    shader.uniforms.uFxTime === fx.FX_UNIFORMS.uFxTime && shader.uniforms.uFxLight === fx.FX_UNIFORMS.uFxLight);
  const mA = baseMaterial(true), mB = baseMaterial(false);
  fx.applyParticleFxMaterial(mA, { additive: true });
  fx.applyParticleFxMaterial(mB, { additive: false });
  check("4. constant program keys (one additive, one alpha program)",
    mA.customProgramCacheKey() === fx.FX_KEY_ADDITIVE && mB.customProgramCacheKey() === fx.FX_KEY_ALPHA &&
    "HB_FX_ADDITIVE" in mA.defines && !("HB_FX_ADDITIVE" in mB.defines));
  const wire = new THREE.MeshBasicMaterial({ wireframe: true });
  check("4. wireframe / non-basic materials are left alone",
    fx.applyParticleFxMaterial(wire, { additive: true }) === false &&
    fx.applyParticleFxMaterial(new THREE.MeshStandardMaterial(), { additive: true }) === false);
  const table = fx.particleFxTable();
  check("4. profile DataTexture: 6 × rows RGBA float, nearest",
    table.image.width === 6 && table.image.height === prof.FX_PROFILE_ROWS.length && table.type === THREE.FloatType &&
    table.minFilter === THREE.NearestFilter);

  // ---- 5. packing + seeds -------------------------------------------------------------
  const em = { parts: [{}, {}, {}] };
  const s1 = fx.particleFxSeed(em, 1, 0.1);
  const s2 = fx.particleFxSeed(em, 1, 0.5);
  const s3 = fx.particleFxSeed(em, 1, 0.02); // lifetime went down ⇒ respawned
  check("5. seed stable while the particle ages", s1 === s2 && s1 >= 0 && s1 < 1, `${s1} ${s2}`);
  check("5. seed redrawn on respawn (lifetime decreased)", s3 !== s2, `${s2} → ${s3}`);
  const packed = fx.particleFxPacked(42, 0.4567);
  check("5. packed b = row + seed (floor recovers the row)", Math.floor(packed) === 42 && Math.abs(packed - 42.4567) < 1e-6);
  fx.setParticleFxLive(false);
  check("5. live A/B off ⇒ row 0 for every instance", Math.floor(fx.particleFxPacked(42, 0.3)) === 0);
  fx.setParticleFxLive(true);
  check("5. age = lifetime / lifespan, clamped",
    fx.particleFxAge({ lifetime: 1, lifespan: 4 }) === 0.25 && fx.particleFxAge({ lifetime: 9, lifespan: 4 }) === 1 &&
    fx.particleFxAge({ lifetime: 1, lifespan: 0 }) === 0);

  // ---- 6. manager integration -------------------------------------------------------------
  const { setCurrentTime } = await import("./scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const { ParticleManager } = await import("./scene3d/particles/particle_manager.js");
  const scene = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  cam.position.set(0, -5, 1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
  const geom = makeQuad();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const buckets = () => { const out = []; scene.traverse((o) => { if (o.isInstancedMesh && o.userData?.isParticleInstanced) out.push(o); }); return out; };

  const fireDid = parseInt(dids.find((d) => catalog.emitters[d].family === "fire"), 16);
  const smokeDid = parseInt(dids.find((d) => catalog.emitters[d].family === "smoke_dark"), 16);
  const mgrAdd = new ParticleManager({ scene, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  const mgrAlp = new ParticleManager({ scene, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(false) });
  await mgrAdd.addEmitter({ emitterInfo: emitterPojo({ id: fireDid }), parent });
  await mgrAlp.addEmitter({ emitterInfo: emitterPojo({ id: smokeDid, hwGfxObjId: 0x01000FBF }), parent });
  t += 0.5;
  mgrAdd.tick(); mgrAlp.tick();
  const bs = buckets();
  const add = bs.find((b) => !b.userData.alpha), alp = bs.find((b) => b.userData.alpha);
  check("6. precondition: an additive and an alpha bucket were built", !!add && !!alp, `${bs.length} buckets`);
  if (add && alp) {
    check("6. both buckets carry the FX material", add.userData.particleFx === true && alp.userData.particleFx === true &&
      add.material.userData.__particleFx === "add" && alp.material.userData.__particleFx === "alpha");
    check("6. additive bucket keeps additive blend / no depth write",
      add.material.blending === THREE.AdditiveBlending && add.material.depthWrite === false && add.material.transparent === true);
    check("6. alpha bucket keeps normal blend / alphaTest 0.1 / depth write",
      alp.material.blending === THREE.NormalBlending && alp.material.alphaTest === 0.1 && alp.material.depthWrite === true);
    const fireRow = prof.FX_DID_ROWS.get(fireDid >>> 0);
    const c = add.instanceColor.array;
    let goodRows = true, goodAge = true, goodOp = true;
    for (let i = 0; i < add.count; i++) {
      if (Math.floor(c[i * 3 + 2]) !== fireRow) goodRows = false;
      if (!(c[i * 3 + 1] > 0.2 && c[i * 3 + 1] < 0.3)) goodAge = false; // 0.5 s of a 2 s life
      if (!(c[i * 3] > 0 && c[i * 3] <= 1)) goodOp = false;
    }
    check("6. instance b = the emitter's own row (+ seed)", add.count > 0 && goodRows, `row ${fireRow}, count ${add.count}`);
    check("6. instance g = age", goodAge, Array.from(c.slice(0, 9)).map((x) => x.toFixed(3)).join(","));
    check("6. instance r = per-particle opacity", goodOp);
  }
  // sky chain + flag off
  const sceneSky = new THREE.Group();
  const mgrSky = new ParticleManager({ scene: sceneSky, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  await mgrSky.addEmitter({ emitterInfo: emitterPojo({ id: fireDid }), parent, skyGlow: true });
  mgrSky.tick();
  let skyB = null; sceneSky.traverse((o) => { if (o.isInstancedMesh) skyB = o; });
  check("6. sky-chain bucket is NOT upgraded (takram sky stays as authored)", !!skyB && skyB.userData.particleFx === false);
  fx.setParticleFxFlag(false);
  const sceneOff = new THREE.Group();
  const mgrOff = new ParticleManager({ scene: sceneOff, instancing: true, geometryFactory: () => geom, materialFactory: () => baseMaterial(true) });
  await mgrOff.addEmitter({ emitterInfo: emitterPojo({ id: fireDid }), parent });
  mgrOff.tick();
  let offB = null; sceneOff.traverse((o) => { if (o.isInstancedMesh) offB = o; });
  const oc = offB ? offB.instanceColor.array : [];
  check("6. ?particleFx=off: stock bucket, (op, op, op) instance colours",
    !!offB && offB.userData.particleFx === false && offB.material.userData.__particleFx === undefined &&
    oc[0] === oc[1] && oc[1] === oc[2]);
  fx.setParticleFxFlag(null);

  // ---- 7. late hooks -------------------------------------------------------------
  check("7. late-pass hooks registered", poc.lateFxHookCount() >= 1);
  const calls = [];
  const target0 = { name: "T" };
  let cur = target0;
  const fakeRenderer = {
    capabilities: { logarithmicDepthBuffer: true },
    autoClear: true,
    getRenderTarget: () => cur,
    setRenderTarget: (rt) => { calls.push(["set", rt && rt.texture ? rt.texture.name : rt?.name ?? null]); cur = rt; },
    render: () => calls.push(["render"]),
  };
  const depth = new THREE.DepthTexture(640, 360);
  poc.runLateFxBefore(fakeRenderer, depth, cam);
  check("7. before: depth copied into the linear-depth target and soft term ON",
    fx.FX_UNIFORMS.uFxSoftOn.value === 1 && calls.some((c) => c[0] === "render") &&
    calls.some((c) => c[0] === "set" && c[1] === "particle-fx-scene-w") && fx.FX_UNIFORMS.uFxSceneW.value?.name === "particle-fx-scene-w");
  check("7. before: render target and autoClear restored", cur === target0 && fakeRenderer.autoClear === true);
  check("7. before: inverse resolution matches the depth texture",
    Math.abs(fx.FX_UNIFORMS.uFxInvRes.value.x - 1 / 640) < 1e-9 && Math.abs(fx.FX_UNIFORMS.uFxInvRes.value.y - 1 / 360) < 1e-9);
  poc.runLateFxAfter();
  check("7. after: soft term OFF (no soft fade outside the late pass)", fx.FX_UNIFORMS.uFxSoftOn.value === 0);
  poc.runLateFxBefore(fakeRenderer, depth, cam, 1280, 720);
  check("7. before: the late target's size wins over stale depth-texture metadata",
    Math.abs(fx.FX_UNIFORMS.uFxInvRes.value.x - 1 / 1280) < 1e-9 && Math.abs(fx.FX_UNIFORMS.uFxInvRes.value.y - 1 / 720) < 1e-9 &&
    fx.particleFxSoftStats().w === 1280);
  poc.runLateFxAfter();
  poc.runLateFxBefore(fakeRenderer, null, cam);
  check("7. no depth texture ⇒ soft stays off", fx.FX_UNIFORMS.uFxSoftOn.value === 0);

  // ---- 7b. alpha display calibration --------------------------------------------
  check("7b. ?particleAlphaCal default ON, off-forms off",
    fx.particleAlphaCalEnabled("") === true && fx.particleAlphaCalEnabled("?particleAlphaCal=off") === false);
  check("7b. factor = 1 / exposure (5 → 0.2), none at exposure ≤ 1",
    Math.abs(fx.particleAlphaCalFor(5) - 0.2) < 1e-12 && fx.particleAlphaCalFor(1) === 1 && fx.particleAlphaCalFor(undefined) === 1);
  fakeRenderer.toneMappingExposure = 5;
  poc.runLateFxBefore(fakeRenderer, depth, cam, 640, 360); poc.runLateFxAfter();
  check("7b. the late hook follows the live exposure", Math.abs(fx.FX_UNIFORMS.uFxAlphaCal.value - 0.2) < 1e-12);
  fakeRenderer.toneMappingExposure = 2.5;
  poc.runLateFxBefore(fakeRenderer, null, cam); poc.runLateFxAfter();
  check("7b. …even when the soft copy is skipped (no depth)", Math.abs(fx.FX_UNIFORMS.uFxAlphaCal.value - 0.4) < 1e-12);
  fx.setParticleFxLive(false);
  check("7b. live A/B off lifts the calibration (exact stock look)", fx.FX_UNIFORMS.uFxAlphaCal.value === 1);
  poc.runLateFxBefore(fakeRenderer, null, cam); poc.runLateFxAfter();
  check("7b. …and the hook keeps it lifted while the A/B is off", fx.FX_UNIFORMS.uFxAlphaCal.value === 1);
  fx.setParticleFxLive(true);
  const shA = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  fx.patchParticleFxShader(shA);
  check("7b. calibration only in the ALPHA branch of the colour stage",
    /#else\s+fxA \*= vColor\.r;\s+fxC \*= uFxAlphaCal;/.test(shA.fragmentShader) && shA.uniforms.uFxAlphaCal === fx.FX_UNIFORMS.uFxAlphaCal);
  check("7b. additive factor = K / exposure (K 2 → 0.4 at exposure 5), capped at 1, K 0 = none",
    Math.abs(fx.particleAddCalFor(5, 2) - 0.4) < 1e-12 && fx.particleAddCalFor(1, 2) === 1 && fx.particleAddCalFor(5, 0) === 1 &&
    fx.particleAddCalFor(1.5, 2) === 1);
  check("7b. ?particleAddCal parsing: default K, number, off",
    fx.particleAddCalK("") === fx.PARTICLE_ADD_CAL_DEFAULT_K && fx.particleAddCalK("?particleAddCal=3") === 3 &&
    fx.particleAddCalK("?particleAddCal=off") === 0 && fx.particleAddCalK("?particleAddCal=junk") === fx.PARTICLE_ADD_CAL_DEFAULT_K);
  fx.setParticleAddCalK(2);
  fakeRenderer.toneMappingExposure = 5;
  poc.runLateFxBefore(fakeRenderer, null, cam); poc.runLateFxAfter();
  check("7b. the late hook sets the additive calibration", Math.abs(fx.FX_UNIFORMS.uFxAddCal.value - 0.4) < 1e-12);
  fx.setParticleFxLive(false);
  check("7b. live A/B off lifts the additive calibration too", fx.FX_UNIFORMS.uFxAddCal.value === 1);
  fx.setParticleFxLive(true);
  fx.setParticleAddCalK(null);
  check("7b. additive calibration only in the ADDITIVE branch",
    /fxC \*= vColor\.r \* uFxAddCal;/.test(shA.fragmentShader) && shA.uniforms.uFxAddCal === fx.FX_UNIFORMS.uFxAddCal);
  check("7b. erosion + core read PERCEPTUAL brightness for additive sprites",
    shA.fragmentShader.includes("float fxMxP = sqrt( fxMx )") && shA.fragmentShader.includes("float fxEnergy = fxMxP * diffuseColor.a") &&
    shA.fragmentShader.includes("smoothstep( 0.45, 1.0, fxMxP )"));
  check("7b. edgeSoft rides texel 5.w and fades the quad border in the map stage",
    fx.FX_PARAM_LAYOUT[23] === "edgeSoft" && shA.vertexShader.includes("vFxE = p5.w;") &&
    shA.fragmentShader.includes("smoothstep( 0.0, vFxE, min( fxEd.x, fxEd.y ) )"));
  check("7b. erosion window open at birth (threshold 0 ⇒ no early dimming)",
    shA.vertexShader.includes("p3.x > 0.0 ? ( p3.x + fxErW ) * pow( fxAge, 1.5 ) : 0.0") &&
    shA.fragmentShader.includes("smoothstep( vFxB.z - vFxB.w, vFxB.z, fxEnergy )"));
  check("7b. additive K follows scene brightness: day 4, night 2, indoor 2, pinned K wins",
    fx.particleAddCalKFor(0, false, null) === fx.PARTICLE_ADD_CAL_DAY_K && fx.particleAddCalKFor(1, false, null) === fx.PARTICLE_ADD_CAL_DEFAULT_K &&
    fx.particleAddCalKFor(0, true, null) === fx.PARTICLE_ADD_CAL_DEFAULT_K && Math.abs(fx.particleAddCalKFor(0.5, false, null) - 3) < 1e-12 &&
    fx.particleAddCalKFor(0, false, 2.5) === 2.5);
  fx.setParticleFxEnvironment(0, false);
  fakeRenderer.toneMappingExposure = 5;
  poc.runLateFxBefore(fakeRenderer, null, cam); poc.runLateFxAfter();
  const dayCal = fx.FX_UNIFORMS.uFxAddCal.value;
  fx.setParticleFxEnvironment(1, false);
  poc.runLateFxBefore(fakeRenderer, null, cam); poc.runLateFxAfter();
  const nightCal = fx.FX_UNIFORMS.uFxAddCal.value;
  check("7b. the hook applies the day/night K (0.8 by day, 0.4 at night at exposure 5)",
    Math.abs(dayCal - 0.8) < 1e-12 && Math.abs(nightCal - 0.4) < 1e-12, `${dayCal} / ${nightCal}`);
  fx.setParticleFxEnvironment(0, false);
  fx.FX_UNIFORMS.uFxAlphaCal.value = 1;
  fx.FX_UNIFORMS.uFxAddCal.value = 1;

  // ---- 8. light -------------------------------------------------------------
  const day = fx.particleFxLightFor(0, false), night = fx.particleFxLightFor(1, false), ind = fx.particleFxLightFor(0.5, true);
  check("8. day light = white", day.every((x) => x === 1));
  check("8. night light = dim moonlit blue", night[2] > night[0] && night[0] < 0.4);
  check("8. indoor light ignores the sun", ind[0] > 0.5 && ind[0] < 0.7);

  // ---- 9. ranges -------------------------------------------------------------
  const L = fx.FX_PARAM_LAYOUT;
  const lim = { gain: [0.6, 2.4], core: [0, 1.3], sat: [0, 1.4], fadeIn: [0, 0.35], fadeOut: [0, 0.6], erode: [0, 0.6],
    flicker: [0, 0.5], twinkle: [0, 0.45], spin: [0, 1.6], wobble: [0, 0.04], soft: [0, 2.5], nearFade: [0, 3], lit: [0, 1],
    pulse: [0, 0.8], edgeSoft: [0, 0.3] };
  const bad = [];
  prof.FX_PROFILE_ROWS.forEach((r, i) => {
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      const v = r[L.indexOf(k)];
      if (v < lo - 1e-9 || v > hi + 1e-9) bad.push(`row${i}.${k}=${v}`);
    }
  });
  check("9. every row inside the safe ranges", bad.length === 0, bad.slice(0, 6).join(" "));
  const ctxPath = new URL("./data/particle-fx-catalog.json", import.meta.url);
  void ctxPath;
  const spinBad = dids.filter((d) => {
    const e = catalog.emitters[d];
    return (e.params.spin || 0) > 0 && ["flame_tongue", "lightning", "rune", "insect", "beam", "streak", "swirl_tex"].includes(e.family);
  });
  const edgeBad = dids.filter((d) => {
    const e = catalog.emitters[d];
    return (e.params.edgeSoft || 0) > 0 && ["swirl_tex", "water_sheet", "beam", "streak", "lightning", "rune", "ring_line"].includes(e.family);
  });
  check("9. no edge softening on surfaces that fill/tile their quad", edgeBad.length === 0, edgeBad.slice(0, 5).join(","));
  check("9. no spin on directional families (flame tongues, lightning, runes, insects, beams, streaks, swirl stripes)",
    spinBad.length === 0, spinBad.slice(0, 5).join(","));

  console.log(`\n[test_particle_fx] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
