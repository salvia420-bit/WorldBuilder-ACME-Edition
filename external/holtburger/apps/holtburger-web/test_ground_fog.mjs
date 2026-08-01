// test_ground_fog.mjs — the SHARED camera-centred ground-fog ring
// (`scene3d/ground_fog.js`, Wave 3A; plan §3.5 item 3 "Tests": billboards face
// the camera, never write depth, decode log depth, sample NEAREST, count
// matches tier).
//
// Locks:
//   L1  BILLBOARDS FACE THE CAMERA. The vertex shader builds its card basis in
//       VIEW space from the world-up axis and the eye direction — a cylindrical
//       billboard — so the card spins to the eye about world up and never
//       shears. Asserted structurally on the GLSL (there is no GPU here) plus a
//       CPU re-implementation of the basis on three sample view matrices.
//   L2  NEVER WRITES DEPTH. `depthWrite === false` on the material (plan §3.5:
//       "depth-write off"), and the mesh never casts a shadow (§5.7).
//   L3  DECODES LOG DEPTH (plan trap T4). The fragment shader contains the
//       `exp2(2.0 * d / FC) - 1.0` inverse and NOT a linear read, and the JS
//       twin round-trips against the forward transform three actually writes.
//   L4  SAMPLES NEAREST + SENTINEL-AWARE (OPTICAL_EFFECTS_HANDOFF.md, the
//       R9 290 HalfFloat/LINEAR regression). `setSceneDepthTexture` forces
//       NEAREST on both filters and only then raises the threshold off its 0
//       sentinel; with no texture the shader can never sample.
//   L5  COUNT MATCHES TIER, with the scatter pool's documented round-up to a
//       perfect square, and `count` is authoritative over the request.
//   L6  EFFECT-AGNOSTIC. No swamp anywhere in the module: the palette, the card
//       size, the family gate and the radius are all in-parameters, and
//       `setPalette` re-tints a live ring (the seam snow/volcano reuse).
//   L7  ADDS NO LIGHT and no per-instance program cache key (§5.2 / §5.4): the
//       ring builds exactly one material and no light of any kind.
//   L8  HEADLESS. With no THREE the ring still runs its full CPU bookkeeping
//       and builds no GPU object (the `?nullRender=1` path).
//   L9  FAMILY GATE. A card over a non-listed family (including FAM_WATER —
//       plan §3.8.1) is written degenerate by the pool.
//
// Run from apps/holtburger-web/:  node test_ground_fog.mjs
// (`three` resolves as a bare import via node_modules — the plan §6 tier for
// anything touching InstancedMesh.)

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FAM_SWAMP, FAM_WATER, FAM_GRASS } from "./scene3d/terrain_families.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const fogMod = await import("./scene3d/ground_fog.js");
const {
  createGroundFog, GROUND_FOG_DEFAULTS, GROUND_FOG_SCHEMA,
  GROUND_FOG_VERTEX_GLSL, GROUND_FOG_FRAGMENT_GLSL, GROUND_FOG_DEPTH_SENTINEL,
  groundFogLogDepthFC, decodeLogDepthToMetres, softParticleFade,
} = fogMod;

const SRC = readFileSync(new URL("./scene3d/ground_fog.js", import.meta.url), "utf8");
// Comment-stripped source. `lint_caps.js` layer B does exactly this before its
// denylist sweep, and for the same reason: the module header DISCUSSES
// `Math.random` and names swamp as the fog's first caller, and neither of those
// is a code fact. Only executable text may be asserted on.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
  .replace(/\/\/.*$/gm, "");

// A fake oracle: flat ground at z = 4, everything FAM_SWAMP unless the caller
// says otherwise. Same shape `test_terrain_scatter.mjs` uses.
function makeOracle(familyAt) {
  return {
    sample(x, y, out) {
      const o = out || {};
      o.height = 4;
      o.hasHeight = true;      // the pool refuses to guess a height without it
      o.code = 4;
      o.family = familyAt ? familyAt(x, y) : FAM_SWAMP;
      o.normal = { x: 0, y: 0, z: 1 };
      o.cornerCodes = null;
      return o;
    },
    heightAt() { return 4; },
  };
}

// ---------------------------------------------------------------------------
console.log("\n== L1  billboards face the camera (cylindrical, world-up pinned)");
// ---------------------------------------------------------------------------
check("vertex shader derives the up axis from OBJECT +Z through modelViewMatrix",
  /modelViewMatrix\s*\*\s*vec4\(0\.0,\s*0\.0,\s*1\.0,\s*0\.0\)/.test(GROUND_FOG_VERTEX_GLSL));
check("vertex shader builds right = cross(up, toEye) in VIEW space",
  /cross\(upView,\s*toEye\)/.test(GROUND_FOG_VERTEX_GLSL));
check("toEye is view-space +Z (three cameras look down -Z)",
  /vec3 toEye = vec3\(0\.0, 0\.0, 1\.0\)/.test(GROUND_FOG_VERTEX_GLSL));
check("the card is displaced along BOTH basis vectors (it is a quad, not a line)",
  /rightView \* \(position\.x \* aScale\.x\)/.test(GROUND_FOG_VERTEX_GLSL)
  && /upView \* \(position\.y \* aScale\.y\)/.test(GROUND_FOG_VERTEX_GLSL));
check("the degenerate look-straight-down case has a fallback basis",
  /rl > 1e-4/.test(GROUND_FOG_VERTEX_GLSL));
check("the card origin is its BOTTOM edge (uv.y 0..1 lifts, so the anchor is the foot)",
  /-0\.5, 0\.0, 0,[\s\S]{0,80}0\.5, 1\.0, 0/.test(SRC));

// CPU re-implementation of the shader's basis, checked on three camera poses.
// The card normal must always point at the eye when projected onto the ground
// plane, and the card up must always be world up.
function basisFor(matrixWorldInverse) {
  const e = matrixWorldInverse.elements;
  // object space == AC space (worldRoot carries the -PI/2 flip), so object +Z
  // is world up; transform it as a DIRECTION.
  const up = new THREE.Vector3(e[8], e[9], e[10]).normalize(); // column 2 of the 3x3
  const toEye = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(up, toEye);
  return { up, right, degenerate: right.length() <= 1e-4 };
}
{
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 8000);
  const worldRoot = new THREE.Object3D();
  worldRoot.rotation.x = -Math.PI / 2;
  worldRoot.updateMatrixWorld(true);
  let allUnit = true, allPerp = true, anyDegenerate = false;
  // Ordinary third-person poses. A camera directly overhead looking straight
  // DOWN is the one genuinely degenerate case (world up becomes the view
  // forward axis) and the shader's `rl > 1e-4` fallback owns it — see below.
  for (const pose of [[0, 6, 40], [120, 8, -60], [-40, 30, 90]]) {
    cam.position.set(pose[0], pose[1], pose[2]);
    cam.lookAt(0, 3, 0);
    cam.updateMatrixWorld(true);
    const mv = new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, worldRoot.matrixWorld);
    const b = basisFor({ elements: mv.elements });
    if (!near(b.up.length(), 1, 1e-5)) allUnit = false;
    if (Math.abs(b.up.dot(b.right)) > 1e-5) allPerp = false;
    if (b.degenerate) anyDegenerate = true;
  }
  check("card up stays unit-length across camera poses", allUnit);
  check("card right is perpendicular to card up (a well-formed billboard basis)", allPerp);
  check("no degenerate basis for ordinary player-height poses", !anyDegenerate);
  // The one pose that DOES degenerate — straight down — must be the pose the
  // shader's fallback branch exists for, or that branch is dead code.
  cam.position.set(0, 40, 0);
  cam.lookAt(0, 3, 0);
  cam.updateMatrixWorld(true);
  const mvDown = new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, worldRoot.matrixWorld);
  check("straight-down IS the degenerate pose the fallback branch covers",
    basisFor({ elements: mvDown.elements }).degenerate === true);
}

// ---------------------------------------------------------------------------
console.log("\n== L2  never writes depth");
// ---------------------------------------------------------------------------
const oracle = makeOracle();
const fog = createGroundFog({
  THREE,
  name: "test-fog",
  oracle,
  families: [FAM_SWAMP],
  count: 24,
  radiusM: 56,
  seed: 0x1234,
});
check("material.depthWrite === false", fog.material.depthWrite === false);
check("material.depthTest === true (fog is still occluded by the world)", fog.material.depthTest === true);
check("material.transparent === true", fog.material.transparent === true);
check("mesh.castShadow === false (§5.7 — added geometry is paid twice)", fog.mesh.castShadow === false);
check("mesh.receiveShadow === false", fog.mesh.receiveShadow === false);
check("source never sets depthWrite true", !/depthWrite:\s*true/.test(CODE));

// ---------------------------------------------------------------------------
console.log("\n== L3  decodes LOG depth (plan trap T4)");
// ---------------------------------------------------------------------------
check("fragment shader carries the exp2 log-depth inverse",
  /exp2\(2\.0 \* d \/ uLogDepthFC\) - 1\.0/.test(GROUND_FOG_FRAGMENT_GLSL));
check("fragment shader does NOT treat the depth texel as a linear distance",
  !/sceneDist\s*=\s*d\s*[;*]/.test(GROUND_FOG_FRAGMENT_GLSL));
check("uLogDepthFC is a declared uniform", /uniform float uLogDepthFC/.test(GROUND_FOG_FRAGMENT_GLSL));
{
  // Round-trip against the FORWARD transform three writes:
  //   gl_FragDepth = log2(1 + viewZ) * logDepthBufFC * 0.5
  const far = 8000;
  const FC = groundFogLogDepthFC(far);
  let worst = 0;
  for (const viewZ of [1, 12.5, 96, 640, 3000, 7999]) {
    const depth = Math.log2(1 + viewZ) * FC * 0.5;
    const back = decodeLogDepthToMetres(depth, FC);
    worst = Math.max(worst, Math.abs(back - viewZ) / viewZ);
  }
  check("decodeLogDepthToMetres inverts three's forward log-depth write", worst < 1e-9, `relErr ${worst}`);
  check("groundFogLogDepthFC matches the atmosphere_pipeline expression",
    near(FC, 2.0 / Math.log2(far + 1.0)));
  check("a LINEAR reading of the same texel would be wildly wrong (the trap is real)",
    Math.abs(Math.log2(1 + 96) * FC * 0.5 - 96) > 90);
  check("fog.setCameraFar updates the uniform", (() => {
    const v = fog.setCameraFar(4321);
    return near(v, groundFogLogDepthFC(4321)) && near(fog.uniforms.uLogDepthFC.value, v);
  })());
}
check("softParticleFade: no occluder ⇒ 1 (fog stays visible — the SAFE failure)",
  softParticleFade(0, 10, 2) === 1 && softParticleFade(-1, 10, 2) === 1);
check("softParticleFade: softness 0 ⇒ term disabled", softParticleFade(50, 10, 0) === 1);
check("softParticleFade: fragment behind the occluder ⇒ 0", softParticleFade(10, 40, 2) === 0);
check("softParticleFade: ramps linearly across the band",
  near(softParticleFade(11, 10, 2), 0.5));

// ---------------------------------------------------------------------------
console.log("\n== L4  NEAREST sampling + a sentinel-aware threshold");
// ---------------------------------------------------------------------------
check("fresh ring: threshold sits at the 0 sentinel (never samples)",
  fog.uniforms.uDepthThreshold.value === 0);
check("fresh ring: no depth texture bound", fog.uniforms.uSceneDepth.value === null);
check("fragment shader gates the whole depth read on the sentinel",
  /if \(uDepthThreshold > 0\.0 && uSoftnessM > 0\.0\)/.test(GROUND_FOG_FRAGMENT_GLSL));
check("fragment shader rejects at/over-threshold texels as sky (no occluder)",
  /if \(d < uDepthThreshold\)/.test(GROUND_FOG_FRAGMENT_GLSL));
{
  // A texture arriving with the R9 290's regressed LINEAR filters must be
  // forced back to NEAREST before it is ever sampled.
  const tex = new THREE.DepthTexture(8, 8);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const wired = fog.setSceneDepthTexture(tex);
  check("setSceneDepthTexture returns true when a texture is wired", wired === true);
  check("minFilter forced to NEAREST", tex.minFilter === THREE.NearestFilter);
  check("magFilter forced to NEAREST", tex.magFilter === THREE.NearestFilter);
  check("threshold raised off the sentinel", fog.uniforms.uDepthThreshold.value === GROUND_FOG_DEPTH_SENTINEL);
  check("sentinel is the cloud_overlay 0.9999 convention", GROUND_FOG_DEPTH_SENTINEL === 0.9999);
  check("stats report the wire + the filter", fog.stats().depthWired === true && fog.stats().depthFilter === "nearest");
  fog.setSceneDepthTexture(null);
  check("unwiring drops back to the sentinel", fog.uniforms.uDepthThreshold.value === 0
    && fog.uniforms.uSceneDepth.value === null && fog.stats().depthWired === false);
}
check("softness ships 0 by default (the depth read is armed only by ?terrainGroundFogSoftness)",
  GROUND_FOG_DEFAULTS.softnessM === 0);

// ---------------------------------------------------------------------------
console.log("\n== L5  count matches tier (with the pool's documented round-up)");
// ---------------------------------------------------------------------------
for (const [request, expected] of [[8, 9], [16, 16], [24, 25], [1, 1]]) {
  const f = createGroundFog({ THREE: null, oracle, families: [FAM_SWAMP], count: request, radiusM: 40 });
  check(`tier ${request} ⇒ ${expected} cards (ceil(sqrt)^2), request preserved`,
    f.count === expected && f.requestedCount === request && f.pool.count === expected,
    `${f.count}`);
  f.dispose();
}
check("live ring's stats expose both numbers", (() => {
  const s = fog.stats();
  return s.count === fog.count && s.requestedCount === 24;
})());

// ---------------------------------------------------------------------------
console.log("\n== L6  effect-agnostic (no swamp anywhere in the module)");
// ---------------------------------------------------------------------------
check("module CODE never mentions swamp/marsh (prose may name its first caller)",
  !/swamp|marsh/i.test(CODE));
check("module imports only the scatter pool", (() => {
  const imports = [...SRC.matchAll(/^import .*from "(.*)";$/gm)].map((m) => m[1]);
  return imports.length === 1 && imports[0] === "./terrain_scatter.js";
})());
check("colour / opacity / card size / lift band are all in-parameters", (() => {
  const d = GROUND_FOG_DEFAULTS;
  return Array.isArray(d.colour) && Number.isFinite(d.opacity)
    && Number.isFinite(d.cardWidthM) && Number.isFinite(d.cardHeightM)
    && d.liftMinM === 0.2 && d.liftMaxM === 1.5;   // plan §3.5: height + 0.2..1.5
})());
{
  const before = fog.uniforms.uColour.value.clone();
  fog.setPalette({ colour: [0.1, 0.9, 0.2], opacity: 0.42, softnessM: 3, nearFadeM: 9 });
  check("setPalette re-tints a LIVE ring (the snow/volcano reuse seam)",
    near(fog.uniforms.uColour.value.g, 0.9, 1e-3)
    && fog.uniforms.uOpacity.value === 0.42
    && fog.uniforms.uSoftnessM.value === 3
    && fog.uniforms.uNearFadeM.value === 9
    && !near(before.g, 0.9, 1e-3));
  fog.setPalette({ colour: [before.r, before.g, before.b], opacity: GROUND_FOG_DEFAULTS.opacity, softnessM: 0 });
}
check("the ring never reads a URL flag (gating belongs to the effect, not the machinery)",
  !/URLSearchParams|location\.search/.test(CODE));

// ---------------------------------------------------------------------------
console.log("\n== L7  no light, one material, no per-instance cache key");
// ---------------------------------------------------------------------------
check("no Light of any kind is constructed", !/new THREE\.\w*Light|PointLight|SpotLight|DirectionalLight/.test(CODE));
check("exactly one ShaderMaterial per ring", (CODE.match(/new THREE\.ShaderMaterial/g) || []).length === 1);
check("no customProgramCacheKey (§5.4)", !/customProgramCacheKey/.test(CODE));
check("no Math.random (§5.5)", !/Math\.random/.test(CODE));
check("no argless Date.now", !/Date\.now\(\)/.test(CODE));
check("the one `.visible =` write is a host-module toggle and carries the lint allowance",
  (CODE.match(/\.visible = /g) || []).length === 1 && /vfx-lint-allow/.test(SRC));

// ---------------------------------------------------------------------------
console.log("\n== L8  headless (no THREE)");
// ---------------------------------------------------------------------------
{
  const head = createGroundFog({ THREE: null, oracle, families: [FAM_SWAMP], count: 16, radiusM: 48 });
  check("no THREE ⇒ no mesh, no material, no geometry",
    head.mesh === null && head.material === null && head.geometry === null);
  check("no THREE ⇒ CPU bookkeeping still runs", (() => {
    head.update(0.016, 1.0, 500, 500, 4);
    const s = head.stats();
    // 7 of a 4x4 slot grid fall outside the inscribed disc — a legitimate,
    // STABLE rejection the pool documents; the other 9 are grounded cards.
    return s.built === false && s.frames === 1 && s.count === 16
      && s.pool.live === 9 && s.pool.outOfRange === 7 && s.pool.nullSamples === 0;
  })());
  check("setSceneDepthTexture is a safe no-op-ish without THREE", (() => {
    const ok = head.setSceneDepthTexture({});
    return ok === true && head.uniforms.uDepthThreshold.value === GROUND_FOG_DEPTH_SENTINEL;
  })());
  head.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n== L9  family gate — nothing is placed on water");
// ---------------------------------------------------------------------------
{
  // Half the world is water, half is swamp. Every LIVE card must be on swamp.
  const split = createGroundFog({
    THREE: null,
    oracle: makeOracle((x) => (x < 500 ? FAM_WATER : FAM_SWAMP)),
    families: [FAM_SWAMP],
    count: 64,
    radiusM: 64,
    seed: 0x777,
  });
  split.update(0.016, 0, 500, 500, 4);
  let live = 0, onWater = 0;
  const off = split.pool.arrays.aOffset;
  for (let i = 0; i < split.count; i += 1) {
    if (!split.pool.isLive(i)) continue;
    live += 1;
    if (off[i * 3] < 500) onWater += 1;
  }
  check("some cards are live over the swamp half", live > 0, `live=${live}`);
  check("ZERO live cards over the water half (plan §3.8.1)", onWater === 0, `onWater=${onWater}`);
  const allFam = createGroundFog({
    THREE: null, oracle: makeOracle(() => FAM_GRASS), families: [FAM_SWAMP], count: 25, radiusM: 48,
  });
  allFam.update(0.016, 0, 0, 0, 4);
  let anyLive = false;
  for (let i = 0; i < allFam.count; i += 1) if (allFam.pool.isLive(i)) anyLive = true;
  check("a wholly non-matching family produces ZERO live cards", anyLive === false);
  split.dispose();
  allFam.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n== placement determinism + the lift band");
// ---------------------------------------------------------------------------
{
  const mk = () => createGroundFog({
    THREE: null, oracle, families: [FAM_SWAMP], count: 25, radiusM: 48, seed: 0xBEEF,
  });
  const a = mk(); const b = mk();
  a.update(0.016, 0, 1000, 2000, 4);
  b.update(0.016, 0, 1000, 2000, 4);
  let same = true, minLift = Infinity, maxLift = -Infinity;
  for (let i = 0; i < a.count * 3; i += 1) if (a.pool.arrays.aOffset[i] !== b.pool.arrays.aOffset[i]) same = false;
  for (let i = 0; i < a.count; i += 1) {
    if (!a.pool.isLive(i)) continue;
    const lift = a.pool.arrays.aOffset[i * 3 + 2] - 4;   // ground is flat at z=4
    minLift = Math.min(minLift, lift);
    maxLift = Math.max(maxLift, lift);
  }
  check("two rings with the same seed place identically (hash-stable, §5.5)", same);
  check("every card sits within the plan's 0.2..1.5 m lift band",
    Number.isFinite(minLift) && minLift >= 0.2 - 1e-6 && maxLift <= 1.5 + 1e-6,
    `${minLift}..${maxLift}`);
  // Walk away and come back: the pool is world-anchored, so the field returns.
  const snapshot = Float32Array.from(a.pool.arrays.aOffset);
  a.update(0.016, 0, 9000, 9000, 4);
  a.update(0.016, 0, 1000, 2000, 4);
  let restored = true;
  for (let i = 0; i < snapshot.length; i += 1) {
    if (Math.abs(snapshot[i] - a.pool.arrays.aOffset[i]) > 1e-6) restored = false;
  }
  check("teleport away and back reproduces the ring byte-for-byte", restored);
  a.dispose(); b.dispose();
}
check("the attribute schema is the documented triple",
  GROUND_FOG_SCHEMA.map((s) => `${s.name}:${s.itemSize}`).join(",") === "aOffset:3,aScale:2,aCard:4");

fog.dispose();

console.log(`\n[test_ground_fog] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
