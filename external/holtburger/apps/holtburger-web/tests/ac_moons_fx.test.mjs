// tests/ac_moons_fx.test.mjs — ?moonFx (2026-10-11, DEFAULT ON).
//
// Owner, 1070: "for the moon we have clouds and green lights on one of them
// but the clouds are getting throttled a little too hard so the inside is
// missing ... a little more paintbrushy, like a satellite image of clouds on
// jupiter ... anything you can do to make the moons look more 3d".
// scene3d/ac_moons.js now ships MOON_FX_FRAG (the FX path) next to the
// untouched MOON_FRAG (the `?moonFx=off` path). The shader itself compiles
// and draws in test_moon_fx_gpu.cjs (headless SwiftShader); this file pins
// the pure JS around it and the contract between the two.
//
//   F1  flag readers: moonFx default ON (off/0/false/no escape), moonPhase.
//   F2  `=off` IS the pre-FX moon: MOON_FRAG / MOON_VERT pinned by sha256 to
//       HEAD 8f65edbc, legacy quad size, legacy uniform set, tick() writes
//       nothing FX.
//   F3  the throttle: a mirror of the legacy opacity proves the fold-back
//       hollows every dense cloud at the shipped uCloudIntensity 5; the FX
//       shader has one monotone threshold and none of the three culprits.
//   F4  FX material contract: every uniform the FX GLSL declares is bound,
//       quad 1.3x, ASCII-only, no names three's shader prefix already owns.
//   F5  sun -> billboard frame on the REAL lookAt placement: opposite sun =
//       full, sun at the moon = new, sun east of a north moon = lit right.
//   F6  cloud flow clock: complementary weights, resets only at zero weight,
//       bounded values after 100+ days, seamless rotation wrap.
//   F7  libration: orthonormal, identity at 0, the shader's v * M inverse.
//   F8  airmass mirror: 1 at the zenith, monotone, finite at -1 deg; the
//       shader carries the same constants.
//   F9  tick() end to end on a fake liveScene3d: uSunLocal / uNight /
//       uMoonAlt / uLib / uCloudFlow; no sky state = full phase; the cloud
//       speed knob integrates.
//   F10 window.__setMoon* knobs + window.__moonFxState().
//
// Fails on the pre-change code: none of the FX exports exist.
//
// Run: node tests/ac_moons_fx.test.mjs

import { createHash } from "node:crypto";

// A browser-ish global BEFORE the import, so the module installs its
// window.__setMoon* knobs and the flag readers see an empty query.
globalThis.window = globalThis;
globalThis.window.location = { search: "" };

const THREE = await import("three");
const M = await import("../scene3d/ac_moons.js");
const { sunDirFromHeadingPitch } = await import("../scene3d/sun_direction.js");
const { artSunPitchDeg, nightFactorFromArtPitch } = await import("../scene3d/night_ramp.js");
const { ACMoons } = M;

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const v3s = (v) => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Pre-FX shader sources (HEAD 8f65edbc, scene3d/ac_moons.js MOON_FRAG /
// MOON_VERT template literals, hashed as JS strings).
const LEGACY_FRAG_SHA = "fed2f580cdf6f00cd35f9b53bb5c4708f506239116a9a0be88375a9aec872a50";
const LEGACY_VERT_SHA = "5fdd63981a0d427e4f2bdb960330ecea338ac8564e9eeead49226de9d82ed37d";
const LEGACY_UNIFORMS = [
  "map", "uBrightness", "uTime", "uHasClouds", "uCloudIntensity", "uCloudSpeed",
  "uCityIntensity", "uCityPos", "uMicroLights", "uScintEnabled", "uScintIntensity",
].sort();
const ALB_R = 0.115;
const REZ_R = 0.0736;

/** Build both meshes without textures (no GL needed to construct). */
function buildMoons(opts) {
  const m = new ACMoons(opts);
  const tex = new THREE.Texture();
  m.albMesh = m._buildMoonMesh(tex, ALB_R, true);
  m.rezMesh = m._buildMoonMesh(tex, REZ_R, false);
  return m;
}
/** Uniform names a GLSL source declares. */
function declaredUniforms(src) {
  const out = new Set();
  for (const mm of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)) out.add(mm[1]);
  return out;
}
/** A fake liveScene3d (camera + SkyState) for tick(). */
function stage(moons, skyState, camPos = [120, 40, -35]) {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  cam.position.set(camPos[0], camPos[1], camPos[2]);
  globalThis.window.liveScene3d = {
    cameraSwitcher: { activeCamera: cam },
    skyLightingController: { _lastState: skyState },
    acMoons: moons,
  };
  return cam;
}

// ---------------------------------------------------------------------------
console.log("F1 — flag readers");
check("moonFx: absent / on / junk => ON", () => {
  for (const s of ["", "?x=1", "?moonFx", "?moonFx=on", "?moonFx=1", "?moonFx=yes", "?moonFx=banana"]) {
    assert(M.moonFxEnabled(s) === true, `${s} should be ON`);
  }
});
check("moonFx: off / 0 / false / no (any case) => OFF", () => {
  for (const s of ["?moonFx=off", "?moonFx=0", "?moonFx=false", "?moonFx=no", "?moonFx=OFF", "?a=1&moonFx=Off"]) {
    assert(M.moonFxEnabled(s) === false, `${s} should be OFF`);
  }
});
check("moonFx with no window.location (node default) => ON", () => {
  const saved = globalThis.window.location;
  globalThis.window.location = undefined;
  try {
    assert(M.moonFxEnabled() === true, "default");
  } finally {
    globalThis.window.location = saved;
  }
});
check("moonPhase: default 1, clamps to [0, 1], junk => default", () => {
  assert(M.moonPhaseFlag("") === 1, "absent");
  assert(M.moonPhaseFlag("?moonPhase=0.25") === 0.25, "0.25");
  assert(M.moonPhaseFlag("?moonPhase=0") === 0, "0");
  assert(M.moonPhaseFlag("?moonPhase=7") === 1, "clamp hi");
  assert(M.moonPhaseFlag("?moonPhase=-2") === 0, "clamp lo");
  assert(M.moonPhaseFlag("?moonPhase=abc") === 1, "junk");
  assert(M.moonPhaseFlag("?moonPhase=") === 1, "empty");
});
check("the constructor captures the flags (opts override the URL)", () => {
  assert(new ACMoons()._fx === true, "default ON");
  assert(new ACMoons({ fx: false })._fx === false, "opts.fx");
  assert(new ACMoons({ phase: 0.3 })._fxPhase === 0.3, "opts.phase");
  globalThis.window.location = { search: "?moonFx=off&moonPhase=0.5" };
  try {
    const m = new ACMoons();
    assert(m._fx === false && m._fxPhase === 0.5, `url: fx=${m._fx} phase=${m._fxPhase}`);
  } finally {
    globalThis.window.location = { search: "" };
  }
});

// ---------------------------------------------------------------------------
console.log("F2 — `?moonFx=off` is the pre-FX moon, byte for byte");
check("MOON_FRAG and MOON_VERT are the HEAD sources (sha256)", () => {
  assert(sha(M.MOON_FRAG) === LEGACY_FRAG_SHA, `MOON_FRAG changed: ${sha(M.MOON_FRAG)}`);
  const vert = buildMoons({ fx: false }).albMesh.material.vertexShader;
  assert(sha(vert) === LEGACY_VERT_SHA, `MOON_VERT changed: ${sha(vert)}`);
});
const off = buildMoons({ fx: false });
check("flag-off materials use MOON_FRAG and the legacy uniform set only", () => {
  for (const mesh of [off.albMesh, off.rezMesh]) {
    assert(mesh.material.fragmentShader === M.MOON_FRAG, "fragment shader");
    const keys = Object.keys(mesh.material.uniforms).sort();
    assert(JSON.stringify(keys) === JSON.stringify(LEGACY_UNIFORMS), `uniforms: ${keys.join(",")}`);
  }
});
// Canonical snapshot of both built meshes: geometry (parameters, vertices,
// uvs, index), every material field that reaches the GPU, all uniform values,
// renderOrder, frustumCulled. The hash below was taken from HEAD 8f65edbc's
// module; `=off` must reproduce it exactly (geometry included, not just the
// shader strings).
const LEGACY_MESH_SNAPSHOT_SHA = "a381f0428ab507de57841f278a534f6c6f1bd47616eab096658949263f49efcb";
function snapValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (v.isTexture) return "texture";
  if (v.isVector2 || v.isVector3 || v.isVector4) return v.toArray();
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, snapValue);
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, snapValue(v[k])]));
}
function meshSnapshot(mesh) {
  const m = mesh.material;
  return snapValue({
    geometry: mesh.geometry.parameters,
    position: mesh.geometry.attributes.position.array,
    uv: mesh.geometry.attributes.uv.array,
    index: mesh.geometry.index.array,
    material: {
      vertexShader: m.vertexShader, fragmentShader: m.fragmentShader, transparent: m.transparent,
      depthTest: m.depthTest, depthWrite: m.depthWrite, side: m.side, blending: m.blending,
      premultipliedAlpha: m.premultipliedAlpha, toneMapped: m.toneMapped, defines: m.defines ?? {},
      uniforms: Object.fromEntries(Object.entries(m.uniforms).map(([k, u]) => [k, u.value])),
    },
    renderOrder: mesh.renderOrder, frustumCulled: mesh.frustumCulled,
  });
}
check("flag-off meshes == HEAD's, geometry + material + uniforms (snapshot sha256)", () => {
  const fresh = new ACMoons({ fx: false });
  const tex = new THREE.Texture();
  const a = fresh._buildMoonMesh(tex, ALB_R, true);
  const r = fresh._buildMoonMesh(tex, REZ_R, false);
  const h = sha(JSON.stringify([meshSnapshot(a), meshSnapshot(r)]));
  assert(h === LEGACY_MESH_SNAPSHOT_SHA, `=off drifted from HEAD: ${h}`);
  const f = new ACMoons({ fx: true });
  const hf = sha(JSON.stringify([meshSnapshot(f._buildMoonMesh(tex, ALB_R, true)), meshSnapshot(f._buildMoonMesh(tex, REZ_R, false))]));
  assert(hf !== LEGACY_MESH_SNAPSHOT_SHA, "the snapshot must tell FX from legacy");
});
check("flag-off quads keep the legacy size (2 * 2000 * angular radius)", () => {
  const w = (mesh) => mesh.geometry.parameters.width;
  assert(w(off.albMesh) === 2 * 2000 * ALB_R && w(off.rezMesh) === 2 * 2000 * REZ_R,
    `${w(off.albMesh)} / ${w(off.rezMesh)}`);
});
check("flag-off tick() places the moons and touches no FX state", () => {
  stage(off, { dirHeading: 90, dirPitch: 45 });
  off.tick(1000);
  off.tick(1500);
  assert(off._cloudClock === 0 && off._fxLastMs === null, "FX clock untouched");
  assert(!("uSunLocal" in off.albMesh.material.uniforms), "no FX uniforms appeared");
  const d = off.albMesh.position.clone().sub(globalThis.window.liveScene3d.cameraSwitcher.activeCamera.position);
  assert(near(d.length(), 2000, 1e-6), `on the sky shell: ${d.length()}`);
});

// ---------------------------------------------------------------------------
console.log("F3 — the throttle (\"the inside is missing\")");
// Mirror of MOON_FRAG's cloud opacity: cloudAmt = clamp(cloud*mask*2.4 + 0.05),
// t = cloudAmt * uCloudIntensity, opacity = t<1 ? t : 1-(t-1)*0.4, clamp 0..0.92.
const legacyOpacity = (cloudTimesMask, intensity = 5) => {
  const amt = Math.min(1, Math.max(0, cloudTimesMask * 2.4 + 0.05));
  const t = amt * intensity;
  const o = t < 1 ? t : 1 - (t - 1) * 0.4;
  return Math.min(0.92, Math.max(0, o));
};
check("legacy: at the shipped intensity 5 every dense cloud draws NOTHING", () => {
  // The 5-octave fbm averages ~0.48; anything above (0.7 - 0.05) / 2.4 = 0.2708
  // inside the mask has t >= 3.5, where the fold-back reaches exactly 0.
  for (const c of [0.2709, 0.35, 0.48, 0.6, 0.8]) {
    assert(legacyOpacity(c) === 0, `cloud*mask=${c} -> ${legacyOpacity(c)}`);
  }
  // ...while the fringe of the mask (cloud*mask ~0.06) is the most opaque.
  assert(legacyOpacity(0.0625) > 0.99 * 0.92, `fringe ${legacyOpacity(0.0625)}`);
  // and outside every mask the +0.05 bias washes the whole disc at 25%.
  assert(near(legacyOpacity(0), 0.25, 1e-9), `wash ${legacyOpacity(0)}`);
});
check("legacy source still carries the three culprits (documents what =off restores)", () => {
  assert(/\(1\.0 - \(t - 1\.0\) \* 0\.4\)/.test(M.MOON_FRAG), "fold-back taper");
  assert(/quadMask/.test(M.MOON_FRAG) && /discMask/.test(M.MOON_FRAG), "quadrant + radial masks");
  assert(/cloudAmt \* 2\.4 \+ 0\.05/.test(M.MOON_FRAG), "+0.05 bias");
});
// Mirror of MOON_FX_FRAG's coverage: smoothstep(0.35, 0.61, dens) * I * 0.2.
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fxCoverage = (dens, intensity = 5) => Math.min(1, Math.max(0, smooth(0.35, 0.61, dens) * intensity * 0.2));
check("FX: coverage never decreases with density, dense clouds are opaque", () => {
  let prev = -1;
  for (let d = 0; d <= 1.0001; d += 0.01) {
    const c = fxCoverage(d);
    assert(c >= prev - 1e-12, `fold-back at dens=${d.toFixed(2)}`);
    prev = c;
  }
  assert(fxCoverage(0.75) === 1 && fxCoverage(0.2) === 0, "full / clear ends");
  assert(fxCoverage(0.75, 0) === 0, "uCloudIntensity 0 = no clouds");
});
check("FX shader: the single threshold, and none of the culprits", () => {
  const s = M.MOON_FX_FRAG;
  assert(s.includes("smoothstep(0.35, 0.61, dens) * uCloudIntensity * 0.2"), "the mirrored coverage expression");
  assert(!/\(t - 1\.0\) \* 0\.4/.test(s), "no fold-back");
  assert(!/quadMask|tlMask|trBleed|discMask/.test(s), "no quadrant / radial masks");
  assert(!/\+ 0\.05, 0\.0, 1\.0\)/.test(s), "no wash bias");
  // The only limb change is the slant path (thicker toward the limb).
  assert(s.includes("cov = 1.0 - pow(1.0 - cov, 1.0 / max(mu, 0.25));"), "slant-path thickening");
});

// ---------------------------------------------------------------------------
console.log("F4 — FX material contract");
const fx = buildMoons({ fx: true });
check("FX materials use MOON_FX_FRAG + the unchanged vertex shader", () => {
  for (const mesh of [fx.albMesh, fx.rezMesh]) {
    assert(mesh.material.fragmentShader === M.MOON_FX_FRAG, "fragment");
    assert(sha(mesh.material.vertexShader) === LEGACY_VERT_SHA, "vertex");
    assert(mesh.material.transparent === true && mesh.material.depthTest === false && mesh.material.depthWrite === false,
      "composites exactly like before (transparent, no depth)");
    assert(mesh.renderOrder === 800, `renderOrder ${mesh.renderOrder}`);
  }
});
check("every uniform the FX GLSL declares is bound on both moons", () => {
  const decl = declaredUniforms(M.MOON_FX_FRAG);
  assert(decl.size >= 30, `parsed ${decl.size} uniforms`);
  for (const mesh of [fx.albMesh, fx.rezMesh]) {
    for (const name of decl) assert(name in mesh.material.uniforms, `${name} unbound`);
  }
});
check("every legacy knob uniform is still on the FX material", () => {
  for (const name of LEGACY_UNIFORMS) assert(name in fx.albMesh.material.uniforms, name);
});
check("FX quads are 1.3x (the shader scales its UVs back by uQuadScale)", () => {
  assert(M.MOON_FX_QUAD_SCALE === 1.3, "constant");
  const w = fx.albMesh.geometry.parameters.width;
  assert(near(w, 2 * 2000 * ALB_R * 1.3, 1e-9), `width ${w}`);
  assert(fx.albMesh.material.uniforms.uQuadScale.value === 1.3, "uniform");
  assert(M.MOON_FX_FRAG.includes("vec2 uv = 0.5 + (vUv - 0.5) * uQuadScale;"), "UV undo");
});
check("FX GLSL is ASCII and has no backtick (it lives in a JS template literal)", () => {
  assert(!/[^\x00-\x7F]/.test(M.MOON_FX_FRAG), "non-ASCII character");
  assert(!M.MOON_FX_FRAG.includes(String.fromCharCode(96)), "backtick");
});
check("FX GLSL declares nothing three's ShaderMaterial prefix already defines", () => {
  // WebGLProgram (r184) prepends viewMatrix / cameraPosition / isOrthographic,
  // luminance() and the colour-space + tone-mapping helpers.
  for (const name of ["viewMatrix", "cameraPosition", "isOrthographic", "luminance", "saturate",
    "toneMappingExposure", "linearToOutputTexel", "LinearTransferOETF", "sRGBTransferOETF"]) {
    const re = new RegExp(`\\b(float|vec[234]|mat[34]|void|bool)\\s+${name}\\b`);
    assert(!re.test(M.MOON_FX_FRAG), `${name} redeclared`);
  }
});
check("Rez'arel stays cloudless; Alb'arel alone has clouds, lights and a rim", () => {
  const a = fx.albMesh.material.uniforms;
  const r = fx.rezMesh.material.uniforms;
  assert(a.uHasClouds.value === 1 && r.uHasClouds.value === 0, "uHasClouds");
  assert(r.uMicroLights.value.every((v) => v.z === 0), "Rez'arel lights zeroed");
  assert(a.uRim.value > 0 && r.uRim.value === 0, "rim");
  assert(r.uScintEnabled.value === 1 && a.uScintEnabled.value === 0, "scintillation stays Rez'arel's");
});

// ---------------------------------------------------------------------------
console.log("F5 — sun -> billboard frame (real lookAt placement)");
{
  const m = buildMoons({ fx: true });
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  cam.position.set(310, 22, -870);
  const out = new THREE.Vector3();
  const dirOf = (mesh) => mesh.position.clone().sub(cam.position).normalize();
  check("sun opposite the moon = full phase, sunLocal (0,0,1)", () => {
    m._setMoonOnSphere(m.albMesh, 0.7, 0.4, cam);
    M.moonSunLocal(dirOf(m.albMesh).negate(), m.albMesh.quaternion, out);
    assert(near(out.z, 1, 1e-6), v3s(out));
    const p = M.moonPhaseInfo(out);
    assert(near(p.phaseAngleDeg, 0, 0.05) && near(p.illuminatedFraction, 1, 1e-6), JSON.stringify(p));
  });
  check("sun behind the moon = new moon, sunLocal (0,0,-1)", () => {
    M.moonSunLocal(dirOf(m.albMesh), m.albMesh.quaternion, out);
    assert(near(out.z, -1, 1e-6), v3s(out));
    assert(near(M.moonPhaseInfo(out).illuminatedFraction, 0, 1e-6), "dark");
  });
  check("moon due north on the horizon, sun due east: lit on the screen RIGHT (+x)", () => {
    m._setMoonOnSphere(m.rezMesh, 0, 0, cam); // az 0 = -Z = north
    const east = sunDirFromHeadingPitch(90, 0, new THREE.Vector3()); // AC heading 90 = east
    M.moonSunLocal(east, m.rezMesh.quaternion, out);
    assert(near(out.x, 1, 1e-6), v3s(out));
    assert(near(M.moonPhaseInfo(out).phaseAngleDeg, 90, 0.05), "quarter");
  });
  check("same moon, sun at the zenith: lit from the TOP (+y)", () => {
    M.moonSunLocal(new THREE.Vector3(0, 1, 0), m.rezMesh.quaternion, out);
    assert(near(out.y, 1, 1e-6), v3s(out));
  });
  check("the billboard frame is right-handed with +z toward the viewer (what the shader assumes)", () => {
    const q = m.albMesh.quaternion;
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    assert(near(z.dot(dirOf(m.albMesh)), -1, 1e-9), "+z faces the camera");
    assert(near(x.clone().cross(y).dot(z), 1, 1e-9), "right-handed");
    assert(y.y > 0, "+y is up the sky");
  });
}

// ---------------------------------------------------------------------------
console.log("F6 — cloud flow clock");
const P = M.MOON_CLOUD_FLOW_PERIOD_S;
check("weights are complementary triangles in [0,1]; local times bounded", () => {
  for (let t = 0; t < 3 * P; t += 0.37) {
    const f = M.moonCloudFlow(t);
    assert(f.wA >= 0 && f.wA <= 1, `wA ${f.wA}`);
    assert(f.tA >= -P / 2 && f.tA < P / 2 && f.tB >= -P / 2 && f.tB < P / 2, `t ${f.tA} ${f.tB}`);
    assert(f.seedA >= 0 && f.seedA < 64 && f.seedB >= 0 && f.seedB < 64, "seeds");
    assert(Number.isInteger(f.seedA) && Number.isInteger(f.seedB), "integer seeds");
  }
});
check("each phase resets (new seed, time jumps) only while its weight is 0", () => {
  for (const k of [1, 2, 7]) {
    const a = M.moonCloudFlow(k * P - 1e-6);
    const b = M.moonCloudFlow(k * P + 1e-6);
    assert(a.wA < 1e-6 && b.wA < 1e-6, `A weight at reset ${a.wA} ${b.wA}`);
    assert(a.seedA !== b.seedA, "A seed advances");
    const c = M.moonCloudFlow((k + 0.5) * P - 1e-6);
    const d = M.moonCloudFlow((k + 0.5) * P + 1e-6);
    assert(1 - c.wA < 1e-6 && 1 - d.wA < 1e-6, `B weight at reset ${1 - c.wA}`);
    assert(c.seedB !== d.seedB, "B seed advances");
  }
});
check("the visible state is continuous (weighted shear changes < 0.1 s per 0.05 s step)", () => {
  let prev = M.moonCloudFlow(0);
  let worst = 0;
  for (let t = 0.05; t < 2.5 * P; t += 0.05) {
    const f = M.moonCloudFlow(t);
    worst = Math.max(worst, Math.abs(f.wA * f.tA - prev.wA * prev.tA), Math.abs((1 - f.wA) * f.tB - (1 - prev.wA) * prev.tB));
    prev = f;
  }
  assert(worst < 0.1, `worst step ${worst}`);
});
check("rigid rotation wraps to [0, 2pi) seamlessly; 100+ days stay bounded", () => {
  let prev = M.moonCloudFlow(0).rot;
  for (let t = 1; t < 9000; t += 1) {
    const r = M.moonCloudFlow(t).rot;
    let d = r - prev;
    if (d < -Math.PI) d += 2 * Math.PI;
    assert(d > 0 && d < 0.01, `rotation step ${d} at ${t}`);
    prev = r;
  }
  const late = M.moonCloudFlow(1e7);
  assert(late.rot >= 0 && late.rot < 2 * Math.PI && Math.abs(late.tA) <= P / 2 && late.seedA < 64, JSON.stringify(late));
});

// ---------------------------------------------------------------------------
console.log("F7 — libration");
check("identity at zero; orthonormal with det +1 elsewhere", () => {
  const m3 = new THREE.Matrix3();
  M.moonLibrationMatrix(0, 0, m3);
  assert(m3.equals(new THREE.Matrix3()), "identity");
  for (const [yaw, pitch] of [[0.1, -0.05], [-0.2, 0.08], [0.6, 0.3]]) {
    M.moonLibrationMatrix(yaw, pitch, m3);
    const mt = m3.clone().transpose();
    const p = m3.clone().multiply(mt);
    assert(p.elements.every((e, i) => near(e, [1, 0, 0, 0, 1, 0, 0, 0, 1][i], 1e-12)), "M Mt = I");
    assert(near(m3.determinant(), 1, 1e-12), "det");
  }
});
check("yaw turns the view centre toward body +x (body = Rx(pitch) Ry(yaw) view)", () => {
  const m3 = M.moonLibrationMatrix(0.2, 0, new THREE.Matrix3());
  const b = new THREE.Vector3(0, 0, 1).applyMatrix3(m3);
  assert(near(b.x, Math.sin(0.2), 1e-12) && near(b.z, Math.cos(0.2), 1e-12), v3s(b));
});
check("the shader's light projection (v * uLib) inverts uLib: a light round-trips", () => {
  const m3 = M.moonLibrationMatrix(0.12, -0.04, new THREE.Matrix3());
  const mt = m3.clone().transpose();
  const luv = [0.13, 0.49]; // the city
  const cb = [(luv[0] - 0.5) / 0.46, (luv[1] - 0.5) / 0.46];
  const body = new THREE.Vector3(cb[0], cb[1], Math.sqrt(1 - cb[0] * cb[0] - cb[1] * cb[1]));
  const view = body.clone().applyMatrix3(mt); // GLSL nb * uLib
  const back = view.clone().applyMatrix3(m3); // GLSL uLib * nV
  assert(back.distanceTo(body) < 1e-12, "round trip");
  // and with no libration the light sits exactly where the legacy shader drew it
  const id = M.moonLibrationMatrix(0, 0, new THREE.Matrix3());
  const v0 = body.clone().applyMatrix3(id);
  assert(near(0.5 + v0.x * 0.46, luv[0], 1e-12) && near(0.5 + v0.y * 0.46, luv[1], 1e-12), "identity at rest");
});
check("libration angles: bounded by the amplitude (yaw) and half of it (pitch); 0 deg = still", () => {
  let maxYaw = 0;
  let maxPitch = 0;
  for (let ms = 0; ms < 3.6e6; ms += 3000) {
    const l = M.moonLibration(ms, 6, [7.3 * 60e3, 11.9 * 60e3], [0, 1.3]);
    maxYaw = Math.max(maxYaw, Math.abs(l.yaw));
    maxPitch = Math.max(maxPitch, Math.abs(l.pitch));
  }
  const a = (6 * Math.PI) / 180;
  assert(maxYaw <= a + 1e-12 && maxYaw > 0.95 * a, `yaw ${maxYaw}`);
  assert(maxPitch <= a / 2 + 1e-12 && maxPitch > 0.45 * a, `pitch ${maxPitch}`);
  const z = M.moonLibration(123456, 0, [1, 1], [0, 0]);
  assert(z.yaw === 0 && z.pitch === 0, "still");
});

// ---------------------------------------------------------------------------
console.log("F8 — horizon airmass");
check("1 at the zenith, ~38 on the horizon, monotone, finite down to the clamp", () => {
  assert(near(M.moonAirmass(Math.PI / 2), 1, 2e-3), `zenith ${M.moonAirmass(Math.PI / 2)}`);
  const h = M.moonAirmass(0);
  assert(h > 30 && h < 45, `horizon ${h}`);
  let prev = Infinity;
  for (let deg = -1; deg <= 90; deg += 0.25) {
    const a = M.moonAirmass((deg * Math.PI) / 180);
    assert(Number.isFinite(a) && a < prev, `not decreasing at ${deg}: ${a}`);
    prev = a;
  }
  assert(M.moonAirmass(-0.5) === M.moonAirmass(-0.0175), "clamped below -1 deg");
});
check("the shader computes the same airmass (same constants, same clamp)", () => {
  const s = M.MOON_FX_FRAG;
  assert(s.includes("max(uMoonAlt + c.y * uAngRadius, -0.0175)"), "clamp + per-fragment altitude");
  assert(s.includes("1.0 / (sin(altC) + 0.50572 * pow(max(degrees(altC) + 6.07995, 0.5), -1.6364))"), "Kasten-Young");
});

// ---------------------------------------------------------------------------
console.log("F9 — tick() end to end");
{
  const m = buildMoons({ fx: true });
  const cam = stage(m, { dirHeading: 90, dirPitch: 45 }); // day, above the night-ramp knee
  m.tick(5000);
  const sunW = sunDirFromHeadingPitch(90, artSunPitchDeg(45), new THREE.Vector3());
  check("uSunLocal = the sky sun in each moon's own billboard frame", () => {
    for (const mesh of [m.albMesh, m.rezMesh]) {
      const want = M.moonSunLocal(sunW, mesh.quaternion, new THREE.Vector3());
      const got = mesh.material.uniforms.uSunLocal.value;
      assert(got.distanceTo(want) < 1e-9, `${v3s(got)} vs ${v3s(want)}`);
      const back = got.clone().applyQuaternion(mesh.quaternion);
      assert(back.distanceTo(sunW) < 1e-9, "rotates back to the world sun");
    }
  });
  check("day: uNight 0; uMoonAlt is the placed altitude", () => {
    for (const mesh of [m.albMesh, m.rezMesh]) {
      const u = mesh.material.uniforms;
      assert(u.uNight.value === 0, `night ${u.uNight.value}`);
      const geomAlt = Math.asin((mesh.position.y - cam.position.y) / 2000);
      assert(near(u.uMoonAlt.value, geomAlt, 1e-9), `${u.uMoonAlt.value} vs ${geomAlt}`);
    }
  });
  check("uLib is a rotation (orthonormal) after a tick", () => {
    const l = m.albMesh.material.uniforms.uLib.value;
    assert(near(l.determinant(), 1, 1e-12), "det");
  });
  check("night (authored 0.9 deg -> art -14 deg): uNight 1, the sun is below the horizon", () => {
    globalThis.window.liveScene3d.skyLightingController._lastState = { dirHeading: 270, dirPitch: 0.9 };
    m.tick(5100);
    const u = m.albMesh.material.uniforms;
    assert(near(u.uNight.value, nightFactorFromArtPitch(artSunPitchDeg(0.9)), 1e-12) && u.uNight.value === 1, `night ${u.uNight.value}`);
    const sunWorld = u.uSunLocal.value.clone().applyQuaternion(m.albMesh.quaternion);
    assert(sunWorld.y < -0.2, `sun y ${sunWorld.y}`);
  });
  check("no sky state yet: lit from the viewer (full phase), i.e. the art", () => {
    globalThis.window.liveScene3d.skyLightingController._lastState = null;
    m.tick(5200);
    for (const mesh of [m.albMesh, m.rezMesh]) {
      const s = mesh.material.uniforms.uSunLocal.value;
      assert(s.x === 0 && s.y === 0 && s.z === 1, v3s(s));
    }
    assert(m._fxSunValid === false, "flagged invalid");
  });
  check("cloud clock integrates uCloudSpeed (0.22 = 1x, 0 freezes, 0.44 = 2x, dt clamped)", () => {
    const n = buildMoons({ fx: true });
    stage(n, { dirHeading: 90, dirPitch: 45 });
    n.tick(0);
    for (let i = 1; i <= 60; i += 1) n.tick(i * (1000 / 60)); // 1 s at 60 fps
    assert(near(n._cloudClock, 1, 1e-9), `1x: ${n._cloudClock}`);
    n.albMesh.material.uniforms.uCloudSpeed.value = 0;
    for (let i = 61; i <= 120; i += 1) n.tick(i * (1000 / 60));
    assert(near(n._cloudClock, 1, 1e-9), `frozen: ${n._cloudClock}`);
    n.albMesh.material.uniforms.uCloudSpeed.value = 0.44;
    for (let i = 121; i <= 180; i += 1) n.tick(i * (1000 / 60));
    assert(near(n._cloudClock, 3, 1e-9), `2x: ${n._cloudClock}`);
    n.tick(180 * (1000 / 60) + 60000); // a minute in a background tab
    assert(near(n._cloudClock, 3.5, 1e-9), `dt clamp: ${n._cloudClock}`);
    const f = M.moonCloudFlow(n._cloudClock);
    const u = n.albMesh.material.uniforms;
    assert(near(u.uCloudFlow.value.x, f.tA, 1e-9) && near(u.uCloudFlow.value.z, f.wA, 1e-9)
      && near(u.uCloudFlow.value.w, f.rot, 1e-9) && u.uCloudSeed.value.x === f.seedA, "uniforms = moonCloudFlow");
  });
}

// ---------------------------------------------------------------------------
console.log("F10 — live knobs + diag");
{
  const m = buildMoons({ fx: true });
  stage(m, { dirHeading: 90, dirPitch: 45 });
  m.tick(1000);
  const a = m.albMesh.material.uniforms;
  const r = m.rezMesh.material.uniforms;
  check("__setMoonPhase / Ambient / Relief / Halo / Horizon set BOTH moons, clamped", () => {
    assert(window.__setMoonPhase(2) === 1 && a.uPhase.value === 1 && r.uPhase.value === 1, "phase clamp");
    assert(window.__setMoonPhase(0.4) === 0.4 && r.uPhase.value === 0.4, "phase");
    assert(window.__setMoonAmbient(0.05) === 0.05 && a.uAmbient.value === 0.05 && r.uAmbient.value === 0.05, "ambient");
    assert(window.__setMoonRelief(9) === 4 && r.uRelief.value === 4, "relief clamp");
    assert(window.__setMoonHalo(-1) === 0 && a.uHalo.value === 0, "halo clamp");
    assert(window.__setMoonHorizon(0.5) === 0.5 && r.uHorizon.value === 0.5, "horizon");
  });
  check("__setMoonRim / __setMoonCloudShadow touch Alb'arel only", () => {
    const rezRim = r.uRim.value;
    assert(window.__setMoonRim(2) === 2 && a.uRim.value === 2 && r.uRim.value === rezRim, "rim");
    assert(window.__setMoonCloudShadow(0.3) === 0.3 && a.uCloudShadow.value === 0.3, "shadow");
  });
  check("__setMoonLibration sets the amplitude (deg), clamped", () => {
    assert(window.__setMoonLibration(10) === 10 && m._libDeg === 10, "10");
    assert(window.__setMoonLibration(99) === 30, "clamp");
  });
  check("the legacy knobs still drive the FX material", () => {
    assert(window.__setMoonCloudIntensity(3) === 3 && a.uCloudIntensity.value === 3, "cloud intensity");
    assert(window.__setMoonCloudSpeed(0.1) === 0.1, "cloud speed");
    assert(JSON.stringify(window.__setMoonCityPos(0.2, 0.4)) === "[0.2,0.4]", "city pos");
    assert(window.__setMoonScintIntensity(0.5) === 0.5, "scint");
  });
  check("__moonFxState reports the phase each moon is drawn with", () => {
    const st = window.__moonFxState();
    assert(st.enabled === true && st.loaded === true && st.sunValid === true, JSON.stringify(st));
    const want = M.moonPhaseInfo(a.uSunLocal.value);
    assert(near(st.alb.illuminatedFraction, want.illuminatedFraction, 1e-3), "alb fraction");
    assert(st.rez && typeof st.rez.phaseAngleDeg === "number", "rez");
  });
  check("FX knobs answer null with ?moonFx=off (no FX uniforms to set)", () => {
    const o = buildMoons({ fx: false });
    stage(o, { dirHeading: 90, dirPitch: 45 });
    assert(window.__setMoonPhase(0.5) === null && window.__setMoonRim(1) === null, "uniform knobs");
    assert(window.__setMoonLibration(3) === null, "libration");
    assert(window.__moonFxState().enabled === false, "state");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
