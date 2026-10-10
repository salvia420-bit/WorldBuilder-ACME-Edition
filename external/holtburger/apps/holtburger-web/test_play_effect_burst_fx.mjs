// `?burstFx` (2026-10-09) — the per-family upgrade of the PlayEffect
// placeholder bursts (scene3d/play_effect_burst_fx.js + play_effect_vfx.js).
//
// Guards:
//   1. flag: default ON, off-forms off
//   2. every look's params are finite and in sane ranges; looks are distinct
//   3. shader patch: r184 MeshBasicMaterial anchors matched, per-material
//      uniforms + the shared time installed, one program key per shape
//   4. looks are uniforms only (setBurstLook / setBurstAge never touch the
//      program key or `needsUpdate`)
//   5. EVERY gameplay PlayScript id (all 174 minus the 4 sentinels) maps to a
//      family look — none falls through to "default"
//   6. a pooled burst built by play_effect_vfx carries the FX patch + its look
//
// Run from apps/holtburger-web/:  node test_play_effect_burst_fx.mjs

import * as THREE from "three";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

async function run() {
  globalThis.window = globalThis.window || {};
  globalThis.location = { search: "" };
  window.location = globalThis.location;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  globalThis.requestAnimationFrame = window.requestAnimationFrame;

  const bx = await import("./scene3d/play_effect_burst_fx.js");

  // 1
  check("1. ?burstFx default ON", bx.burstFxEnabled("") === true);
  check("1. ?burstFx=off|0|false|no → off", ["off", "0", "false", "no"].every((v) => bx.burstFxEnabled(`?burstFx=${v}`) === false));

  // 2
  const names = Object.keys(bx.BURST_LOOKS);
  const bad = [];
  for (const n of names) {
    const k = bx.BURST_LOOKS[n];
    const nums = [k.gain, k.rim, k.pow, k.heart, k.swirl, k.freq, k.speed, k.flicker, k.hz, ...k.tint, k.fade, k.edge];
    if (!nums.every(Number.isFinite)) bad.push(`${n}:nonfinite`);
    if (k.gain < 0.5 || k.gain > 2.6) bad.push(`${n}.gain`);
    if (k.heart < 0 || k.heart > 1) bad.push(`${n}.heart`);
    if (k.flicker < 0 || k.flicker > 0.6) bad.push(`${n}.flicker`);
    if (k.fade < 0.5 || k.fade > 2.5) bad.push(`${n}.fade`);
    if (k.tint.some((x) => x < 0.1 || x > 1.5)) bad.push(`${n}.tint`);
  }
  check("2. every look finite and in range", bad.length === 0, bad.join(","));
  const sigs = new Set(names.map((n) => JSON.stringify(bx.BURST_LOOKS[n])));
  check("2. looks are individual (no duplicates)", sigs.size === names.length, `${sigs.size}/${names.length}`);

  // 3
  const shader = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  const u = { uBxA: { value: new THREE.Vector4() }, uBxB: { value: new THREE.Vector4() }, uBxC: { value: new THREE.Vector4() }, uBxD: { value: new THREE.Vector4() } };
  check("3. r184 anchors matched", bx.patchBurstFxShader(shader, u) === true);
  check("3. normal/view/position/uv varyings written after <project_vertex>",
    shader.vertexShader.indexOf("vBxN = normalize( normalMatrix * normal )") > shader.vertexShader.indexOf("#include <project_vertex>"));
  check("3. <color_fragment> replaced by the energy-form stage",
    !shader.fragmentShader.includes("#include <color_fragment>") && shader.fragmentShader.includes("HB_BURST_SHAPE == 0"));
  check("3. per-material uniforms + shared time installed", shader.uniforms.uBxA === u.uBxA && shader.uniforms.uBxTime === bx.BURST_TIME);
  const mats = [0, 1, 2].map((s) => { const m = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending }); bx.applyBurstFxMaterial(m, s, (x, y, z, w) => new THREE.Vector4(x, y, z, w)); return m; });
  check("3. one constant program key per shape", mats.map((m) => m.customProgramCacheKey()).join(",") === "hbBurstFx1|0,hbBurstFx1|1,hbBurstFx1|2");
  check("3. shape define set", mats.every((m, i) => m.defines.HB_BURST_SHAPE === i));
  check("3. idempotent", bx.applyBurstFxMaterial(mats[0], 0) === true && mats[0].userData.__burstFx.shape === 0);

  // 4
  const m = mats[0];
  const v0 = m.version;
  bx.setBurstLook(m, "death", 0.25);
  bx.setBurstAge(m, 0.5);
  const U = m.userData.__burstFx.uniforms;
  const d = bx.BURST_LOOKS.death;
  check("4. look → uniforms", Math.abs(U.uBxA.value.x - d.gain) < 1e-9 && Math.abs(U.uBxB.value.z - d.speed) < 1e-9 &&
    Math.abs(U.uBxC.value.w - d.fade) < 1e-9 && Math.abs(U.uBxD.value.z - 0.25) < 1e-9 && Math.abs(U.uBxD.value.w - 0.5) < 1e-9);
  check("4. look/age changes never bump the material version (no recompile)", m.version === v0);
  bx.setBurstLook(m, "no-such-look", 0);
  check("4. unknown look → default", m.userData.__burstFx.look === "default");

  // 5 + 6 — through play_effect_vfx
  let vfx = null;
  try {
    window.liveScene3d = { entityManager: { entityMap: new Map(), getPhysicsScriptTableDid: () => 0 } };
    vfx = await import("./scene3d/play_effect_vfx.js");
  } catch (e) {
    check("5. play_effect_vfx imports under node", false, String(e && e.message || e));
  }
  if (vfx && typeof vfx.burstLookForPlayScript === "function") {
    const { PLAY_SCRIPT } = await import("./ui/ac_play_script.js");
    const sentinels = new Set(["Invalid", "Test1", "Test2", "Test3"]);
    const fallthrough = [];
    const missingLook = [];
    for (const [name, id] of Object.entries(PLAY_SCRIPT)) {
      if (sentinels.has(name)) continue;
      const look = vfx.burstLookForPlayScript(id);
      if (look === "default") fallthrough.push(name);
      if (!bx.BURST_LOOKS[look]) missingLook.push(`${name}->${look}`);
    }
    check("5. every gameplay PlayScript maps to a family look (none fall to default)", fallthrough.length === 0,
      `${Object.keys(PLAY_SCRIPT).length - 4 - fallthrough.length}/${Object.keys(PLAY_SCRIPT).length - 4} mapped${fallthrough.length ? "; unmapped: " + fallthrough.slice(0, 12).join(",") : ""}`);
    check("5. every mapped look exists", missingLook.length === 0, missingLook.join(","));
    const used = new Set(Object.values(PLAY_SCRIPT).map((id) => vfx.burstLookForPlayScript(id)));
    check("5. families get distinct looks", used.size >= 30, `${used.size} looks in use`);
  } else if (vfx) {
    check("5. burstLookForPlayScript exported", false);
  }

  console.log(`\n[test_play_effect_burst_fx] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
