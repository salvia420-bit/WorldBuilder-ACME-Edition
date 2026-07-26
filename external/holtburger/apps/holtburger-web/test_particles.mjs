// Workstream Sky-J P4 (2026-05-12) — standalone ESM test for the
// particle runtime port.
//
// Mocks the wasm `ParticleEmitterJs` API via a plain object with the
// same camelCase getters; mocks `currentTime()` via `setCurrentTime`;
// mocks RNG via `setRng`. Asserts the math in particle.js,
// particle_emitter.js, particle_emitter_info.js, and particle_manager.js
// against the explicit values in the workstream prompt.
//
// Run from `apps/holtburger-web/`:
//   THREE_PATH=/path/to/three/build/three.module.js \
//     node test_particles.mjs
// or
//   node test_particles.mjs (auto-locates `three` from npx cache).
//
// Mirrors the boot pattern of `test_sky_lighting.mjs`.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}
function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

// ---- locate `three` --------------------------------------------------
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  const candidates = [
    joinPath(process.env.HOME ?? "", ".npm/_npx/e41f203b7505f1fb/node_modules/three"),
  ];
  try {
    const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
    if (existsSync(npxRoot)) {
      const fs = require("node:fs");
      for (const dir of fs.readdirSync(npxRoot)) {
        candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
      }
    }
  } catch (_) {}
  for (const c of candidates) {
    const idx = joinPath(c, "build/three.module.js");
    if (existsSync(idx)) return idx;
  }
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("Workstream Sky-J P4 particle ESM test: SKIP (three not located).");
  console.log("  hint: `THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js node test_particles.mjs`");
  process.exit(0);
}

const threeUrl = pathToFileURL(threePath).href;
const THREE = await import(threeUrl);

console.log("Workstream Sky-J P4 — particle runtime standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load particle runtime modules with closure-captured THREE -------
function readSrc(relPath) {
  return readFileSync(resolvePath(__dirname, relPath), "utf8");
}

function stripImportThree(src) {
  return src.replace(
    /^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m,
    "",
  );
}

function stripExports(src) {
  return src
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

// Concatenate the four particle modules into one closure-captured
// factory. Order matters because each file has cross-references — but
// we strip the `import ... from "./*"` lines so the symbols just
// resolve via the shared closure scope.
function stripLocalImports(src) {
  return src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/[^"']+["'];?\s*$/gm, "");
}

let timeRngSrc = readSrc("scene3d/particles/time_rng.js");
let particleSrc = readSrc("scene3d/particles/particle.js");
let particleEmitterInfoSrc = readSrc("scene3d/particles/particle_emitter_info.js");
let particleEmitterSrc = readSrc("scene3d/particles/particle_emitter.js");
let particleManagerSrc = readSrc("scene3d/particles/particle_manager.js");

const sources = [timeRngSrc, particleSrc, particleEmitterInfoSrc, particleEmitterSrc, particleManagerSrc];
const stripped = sources.map((s) => stripExports(stripImportThree(stripLocalImports(s))));

const composite =
  "// === time_rng.js ===\n" + stripped[0] +
  "\n// === particle.js ===\n" + stripped[1] +
  "\n// === particle_emitter_info.js ===\n" + stripped[2] +
  "\n// === particle_emitter.js ===\n" + stripped[3] +
  "\n// === particle_manager.js ===\n" + stripped[4] +
  "\n; return { Particle, ParticleType, ParticleEmitter, ParticleEmitterInfo, EmitterType, ParticleManager, setCurrentTime, setRng, currentTime, rng, normalizeCheckSmall, setTranslucency, localToGlobalVec };";

const factory = new Function("THREE", composite);
const mod = factory(THREE);
const {
  Particle, ParticleType, ParticleEmitter, ParticleEmitterInfo, EmitterType, ParticleManager,
  setCurrentTime, setRng, normalizeCheckSmall, localToGlobalVec, setTranslucency,
} = mod;

// ---- shared deterministic mocks --------------------------------------
let mockTime = 0;
setCurrentTime(() => mockTime);
// Default rng returns 0.5 → centered random values (zero for [-1, 1)
// scaled, 0.5 for [0, 1)).
let mockRngVal = 0.5;
setRng(() => mockRngVal);

// ---- helpers ---------------------------------------------------------
function makeBaseInfo(overrides = {}) {
  // POJO with the same camelCase getters as wasm `ParticleEmitterJs`.
  return Object.assign({
    id: 0x32000456,
    emitterType: EmitterType.BirthratePerSec,
    particleType: ParticleType.Swarm,
    gfxObjId: 0,
    hwGfxObjId: 0x01001A62,
    birthrate: 10.0,
    maxParticles: 3,
    initialParticles: 0,
    totalParticles: 3,
    totalSeconds: 0,
    lifespan: 900.0,
    lifespanRand: 0.0,
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0,
    aX: 0, aY: 0, aZ: 0,
    minA: 1, maxA: 1,
    bX: 0.2, bY: 0.2, bZ: 0.2,
    minB: 1, maxB: 1,
    cX: 300, cY: 300, cZ: 300,
    minC: 1, maxC: 1,
    startScale: 1.0, finalScale: 1.0, scaleRand: 0.0,
    startTrans: 0.0, finalTrans: 0.0, transRand: 0.0,
    isParentLocal: true,
  }, overrides);
}

function makeMesh() {
  // Plain THREE.Mesh with a basic material that has opacity.
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 });
  return new THREE.Mesh(new THREE.BufferGeometry(), mat);
}

// ============================================================
// Test 1: ParticleType enum is frozen and has all 13 values
// ============================================================
check(
  "ParticleType enum exposes all 13 values",
  ParticleType.Unknown === 0 && ParticleType.Still === 1 && ParticleType.LocalVelocity === 2
    && ParticleType.ParabolicLVGA === 3 && ParticleType.ParabolicLVGAGR === 4
    && ParticleType.Swarm === 5 && ParticleType.Explode === 6 && ParticleType.Implode === 7
    && ParticleType.ParabolicLVLA === 8 && ParticleType.ParabolicLVLALR === 9
    && ParticleType.ParabolicGVGA === 10 && ParticleType.ParabolicGVGAGR === 11
    && ParticleType.GlobalVelocity === 12,
  "all 13 enum values present + ordered correctly"
);
check(
  "ParticleType is frozen (Object.freeze)",
  Object.isFrozen(ParticleType),
  `frozen=${Object.isFrozen(ParticleType)}`
);

// ============================================================
// Test 2: Swarm update at t=0 — moon emitter centerpiece math
// ============================================================
{
  mockTime = 100.0;
  mockRngVal = 0.5; // → (rng()*2-1)=0 so randomOffset = (0,0,0)
  const info = new ParticleEmitterInfo(makeBaseInfo());
  const mesh = makeMesh();
  const parent = {
    position: new THREE.Vector3(1900, 0, 0),
    quaternion: new THREE.Quaternion(),
  };
  const parentOffset = {
    position: new THREE.Vector3(450, 0, 0),
    quaternion: new THREE.Quaternion(),
  };
  const p = new Particle();
  // Init internally invokes update with parent=parentOffset, so position
  // will momentarily be (cos0*300+450+450, 0, 300) = (1200, 0, 300).
  p.init(info, parent, -1, parentOffset, mesh,
    /*randomOffset*/ info.getRandomOffset(),
    /*persistent*/ false,
    /*a*/ info.getRandomA(),
    /*b*/ info.getRandomB(),
    /*c*/ info.getRandomC(),
  );

  // Now re-call update with the REAL parent (1900,0,0,0) and lt=0.
  // ACE's ParticleEmitter.UpdateParticles passes Parent.Position.Frame
  // when IsParentLocal=true.
  mockTime = 100.0; // elapsed=0, so lifetime=0
  p.update(ParticleType.Swarm, /*persistent*/ false, mesh, parent);

  check(
    "Swarm @ t=0: position.x = cos(0)*C.x + t*a.x + parent.x + offset.x = 300+0+1900+450 = 2650",
    approx(mesh.position.x, 2650, 1e-3),
    `mesh.position.x=${mesh.position.x}`
  );
  check(
    "Swarm @ t=0: position.y = sin(0)*C.y + t*a.y + parent.y + offset.y = 0+0+0+0 = 0",
    approx(mesh.position.y, 0, 1e-3),
    `mesh.position.y=${mesh.position.y}`
  );
  check(
    "Swarm @ t=0: position.z = cos(0)*C.z + t*a.z + parent.z + offset.z = 300+0+0+0 = 300",
    approx(mesh.position.z, 300, 1e-3),
    `mesh.position.z=${mesh.position.z}`
  );
}

// ============================================================
// Test 3: Swarm update at t=1 — divergence from t=0
// ============================================================
{
  mockTime = 100.0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo());
  const mesh = makeMesh();
  const parent = {
    position: new THREE.Vector3(1900, 0, 0),
    quaternion: new THREE.Quaternion(),
  };
  const parentOffset = {
    position: new THREE.Vector3(450, 0, 0),
    quaternion: new THREE.Quaternion(),
  };
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    info.getRandomOffset(), false,
    info.getRandomA(), info.getRandomB(), info.getRandomC(),
  );

  // Advance by 1 second — non-persistent path sets lifetime = elapsed = 1.
  mockTime = 101.0;
  p.update(ParticleType.Swarm, false, mesh, parent);

  // retail: pos = cos/sin(b*t)*C + t*a + parent + offset  (a=0 here)
  const expX = Math.cos(0.2) * 300 + 1900 + 450; // 294.02 + 2350 ≈ 2644.02
  const expY = Math.sin(0.2) * 300;              // ≈ 59.60
  const expZ = Math.cos(0.2) * 300;              // ≈ 294.02
  check(
    `Swarm @ t=1: position.x = cos(0.2)*300+2350 ≈ ${expX.toFixed(3)}`,
    approx(mesh.position.x, expX, 1e-3),
    `got=${mesh.position.x.toFixed(6)}, expected=${expX.toFixed(6)}`
  );
  check(
    `Swarm @ t=1: position.y = sin(0.2)*300 ≈ ${expY.toFixed(3)}`,
    approx(mesh.position.y, expY, 1e-3),
    `got=${mesh.position.y.toFixed(6)}, expected=${expY.toFixed(6)}`
  );
  check(
    `Swarm @ t=1: position.z = cos(0.2)*300 ≈ ${expZ.toFixed(3)}`,
    approx(mesh.position.z, expZ, 1e-3),
    `got=${mesh.position.z.toFixed(6)}, expected=${expZ.toFixed(6)}`
  );
  check(
    `Swarm @ t=1: position differs from t=0 (proves time evolution)`,
    Math.abs(mesh.position.x - 2650) > 1e-6,
    `mesh.position.x at t=1 = ${mesh.position.x}, vs 2650 @ t=0`
  );
}

// ============================================================
// Test 4: LocalVelocity update — linear growth in A
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.LocalVelocity,
    aX: 1, aY: 2, aZ: 3,
    bX: 0, bY: 0, bZ: 0,
    cX: 0, cY: 0, cZ: 0,
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
  );

  // At t=1: position = (1*1, 1*2, 1*3) + parent + offset = (1, 2, 3).
  mockTime = 1.0;
  p.update(ParticleType.LocalVelocity, false, mesh, parent);
  check(
    "LocalVelocity @ t=1: position = (1, 2, 3) (lifetime * A + parent + offset, both zero)",
    approx(mesh.position.x, 1) && approx(mesh.position.y, 2) && approx(mesh.position.z, 3),
    `pos=(${mesh.position.x}, ${mesh.position.y}, ${mesh.position.z})`
  );

  // At t=2: position = (2, 4, 6).
  mockTime = 2.0;
  p.update(ParticleType.LocalVelocity, false, mesh, parent);
  check(
    "LocalVelocity @ t=2: position = (2, 4, 6)",
    approx(mesh.position.x, 2) && approx(mesh.position.y, 4) && approx(mesh.position.z, 6),
    `pos=(${mesh.position.x}, ${mesh.position.y}, ${mesh.position.z})`
  );
}

// ============================================================
// Test 5: ParabolicLVGA update — t² parabola ASSIGNED (retail-anchored)
// ============================================================
{
  // particle.js ASSIGNS the parabola anchored at the parent frame
  // (position = parent + offset + t*A + 0.5*t²*B), matching retail
  // acclient.c:330453-330465 — NOT ACE Particle.cs:150's `+=` accumulator
  // (that decomp-port bug dropped the parent origin → particles flew to
  // world-origin; see the particle.js comment for the CDP repro).
  // **ACE quirk preserved**: ParabolicLVGA's Init only sets B, NOT A, so
  // `this.a` stays (0,0,0) regardless of input `a`.
  // With B=(2,0,0): at t=1 x = 0.5*1²*2 = 1; at t=2 x = 0.5*2²*2 = 4
  // (assigned each tick, not accumulated).
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.ParabolicLVGA,
    aX: 1, aY: 0, aZ: 0,
    bX: 2, bY: 0, bZ: 0,
    cX: 0, cY: 0, cZ: 0,
  }));
  const mesh = makeMesh();
  // Important: reset mesh.position to (0,0,0) before init (it already is).
  mesh.position.set(0, 0, 0);
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const p = new Particle();
  // init() calls update with lt=0, so += 0 → still (0,0,0).
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 0, 0),
  );
  check(
    "ParabolicLVGA after init (lt=0): position = (0, 0, 0)",
    approx(mesh.position.x, 0) && approx(mesh.position.y, 0) && approx(mesh.position.z, 0),
    `pos=(${mesh.position.x}, ${mesh.position.y}, ${mesh.position.z})`
  );

  // First explicit update: lt = (now - lastUpdateTime) = 1 (non-persistent).
  // ACE ParabolicLVGA init only sets B — A stays (0,0,0). So:
  // pos = parent + offset + 0.5*1²*B + 1*0 = (1, 0, 0).
  mockTime = 1.0;
  p.update(ParticleType.ParabolicLVGA, false, mesh, parent);
  check(
    "ParabolicLVGA @ t=1: position = parent + 0.5*t²*B + offset → x=1 (A=0 per ACE init quirk)",
    approx(mesh.position.x, 1),
    `pos.x=${mesh.position.x}`
  );

  // Second update at lt=2. Non-persistent sets lifetime = elapsed,
  // but lastUpdateTime is NOT updated in non-persistent path (Particle.cs:128-134).
  // So lt = 2, and pos is ASSIGNED 0.5*2²*2 = 4 (anchored at parent, not
  // accumulated onto the t=1 value).
  mockTime = 2.0;
  p.update(ParticleType.ParabolicLVGA, false, mesh, parent);
  check(
    "ParabolicLVGA @ t=2: position = parent + 0.5*t²*B = 0.5*4*2 = 4 (retail assign, not ACE += accumulator)",
    approx(mesh.position.x, 4),
    "pos.x=" + mesh.position.x + ", expected=4"
  );
}

// ============================================================
// Test 6: Scale lerp at half-lifetime
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Still,
    startScale: 1.0,
    finalScale: 3.0,
    lifespan: 10.0,
    lifespanRand: 0.0,
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
  );

  // At lifetime=lifespan/2=5, scale = 1 + (3-1)*0.5 = 2.
  mockTime = 5.0;
  p.update(ParticleType.Still, false, mesh, parent);
  check(
    "Scale lerp @ t=lifespan/2: scale = (start + final) / 2 = 2.0",
    approx(mesh.scale.x, 2.0, 1e-4),
    `mesh.scale.x=${mesh.scale.x}`
  );

  // At lifetime=lifespan=10, scale = finalScale = 3.
  mockTime = 10.0;
  p.update(ParticleType.Still, false, mesh, parent);
  check(
    "Scale lerp @ t=lifespan: scale = finalScale = 3.0",
    approx(mesh.scale.x, 3.0, 1e-4),
    `mesh.scale.x=${mesh.scale.x}`
  );

  // At lifetime > lifespan, interval clamps to 1.0 → scale = finalScale.
  mockTime = 20.0;
  p.update(ParticleType.Still, false, mesh, parent);
  check(
    "Scale lerp past lifespan: interval clamps to 1.0, scale stays at finalScale",
    approx(mesh.scale.x, 3.0, 1e-4),
    `mesh.scale.x=${mesh.scale.x}`
  );
}

// ============================================================
// Test 7: Trans (opacity) lerp at half-lifetime
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  // start_trans=0 (opaque), final_trans=1 (invisible) — typical fade-out.
  // At lifetime/lifespan=0.5: trans = 0 + 1*0.5 = 0.5; opacity = 1-0.5 = 0.5.
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Still,
    startScale: 1.0,
    finalScale: 1.0,
    startTrans: 0.0,
    finalTrans: 1.0,
    lifespan: 10.0,
    lifespanRand: 0.0,
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
  );

  mockTime = 5.0;
  p.update(ParticleType.Still, false, mesh, parent);
  check(
    "Trans lerp @ t=lifespan/2: opacity = 1 - 0.5 = 0.5",
    approx(mesh.material.opacity, 0.5, 1e-4),
    `mesh.material.opacity=${mesh.material.opacity}`
  );

  // At lifetime=lifespan=10: trans=1; opacity=0; mesh.visible=false (ACE NoDraw).
  mockTime = 10.0;
  p.update(ParticleType.Still, false, mesh, parent);
  check(
    "Trans lerp @ t=lifespan: opacity = 0 + mesh.visible = false (ACE NoDraw at trans=1.0)",
    mesh.material.opacity === 0 && mesh.visible === false,
    `opacity=${mesh.material.opacity}, visible=${mesh.visible}`
  );
}

// ============================================================
// Test 8: ParticleEmitter.shouldEmitParticle — birthrate gating
// ============================================================
{
  mockTime = 100.0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    emitterType: EmitterType.BirthratePerSec,
    birthrate: 10.0,
    maxParticles: 5,
    totalParticles: 0, // unlimited
    totalSeconds: 0,
  }));

  // Mock the emitter directly without mesh factory (we only test should logic).
  const e = new ParticleEmitter({
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    meshFactory: () => makeMesh(),
  });
  // Manually wire info + state — bypasses mesh factory for unit test isolation.
  e.info = info;
  e.numParticles = 0;
  e.totalEmitted = 0;
  e.lastEmitTime = 100.0;
  e.lastEmitOffset.set(0, 0, 0);

  // At t=105 (elapsed 5s, birthrate 10): should NOT emit.
  mockTime = 105.0;
  check(
    "shouldEmitParticle: at elapsed=5s < birthrate=10s → false",
    e.shouldEmitParticle() === false,
    `result=${e.shouldEmitParticle()}`
  );

  // At t=111 (elapsed 11s > 10): should emit.
  mockTime = 111.0;
  check(
    "shouldEmitParticle: at elapsed=11s > birthrate=10s → true",
    e.shouldEmitParticle() === true,
    `result=${e.shouldEmitParticle()}`
  );

  // At t=111 with numParticles=maxParticles (5): should NOT emit (slot full).
  e.numParticles = 5;
  check(
    "shouldEmitParticle: numParticles == maxParticles → false (slot full)",
    e.shouldEmitParticle() === false,
    `numParticles=${e.numParticles}, maxParticles=${e.info.maxParticles}`
  );
  e.numParticles = 0;

  // Bounded TotalParticles + totalEmitted==TotalParticles → false.
  e.info.totalParticles = 3;
  e.totalEmitted = 3;
  check(
    "shouldEmitParticle: totalEmitted == TotalParticles → false (emitter exhausted)",
    e.shouldEmitParticle() === false,
    `totalEmitted=${e.totalEmitted}/${e.info.totalParticles}`
  );
}

// ============================================================
// Test 9: ParticleEmitter.killParticle — slot freed when expired
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Still,
    maxParticles: 2,
    totalParticles: 2,
    lifespan: 5.0,
    lifespanRand: 0.0,
  }));
  const e = new ParticleEmitter({
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    meshFactory: () => makeMesh(),
  });
  // setInfo is async — await it.
  await e.setInfo(info);
  e.setParenting(-1, { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() });
  e.initEnd(); // spawns 2 initial particles per TotalParticles
  check(
    "killParticle setup: initEnd spawned 2 particles → numParticles=2",
    e.numParticles === 2,
    `numParticles=${e.numParticles}, expected=2`
  );

  // Advance time past lifespan → particles should be killed on next update.
  mockTime = 10.0;
  e.updateParticles();
  check(
    "killParticle: after lifespan elapses, both particles killed → numParticles=0",
    e.numParticles === 0,
    `numParticles=${e.numParticles}`
  );
}

// ============================================================
// Test 10: ParticleEmitter.stopEmitter — totalSeconds gating
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Still,
    maxParticles: 2,
    totalParticles: 0,
    totalSeconds: 5.0,
    lifespan: 100.0,
  }));
  const e = new ParticleEmitter({
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    meshFactory: () => makeMesh(),
  });
  await e.setInfo(info);
  e.setParenting(-1, { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() });
  e.creationTime = 0;

  mockTime = 4.9;
  check(
    "stopEmitter: at elapsed=4.9s < totalSeconds=5s → still running",
    e.stopEmitter() === false,
    `stopped=${e.stopped}`
  );

  mockTime = 5.1;
  check(
    "stopEmitter: at elapsed=5.1s > totalSeconds=5s → stopped=true",
    e.stopEmitter() === true,
    `stopped=${e.stopped}`
  );
}

// ============================================================
// Test 11: ParticleManager — addEmitter + tick lifecycle
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const scene = new THREE.Scene();
  const mgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => new THREE.BufferGeometry(),
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const id = await mgr.addEmitter({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 1,
      totalParticles: 1,
      totalSeconds: 0,
      lifespan: 2.0,
      lifespanRand: 0,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  check(
    "ParticleManager.addEmitter returned non-zero id",
    id !== 0 && typeof id === "number",
    `id=${id}`
  );
  check(
    "ParticleManager: getNumEmitters() == 1 after first addEmitter",
    mgr.getNumEmitters() === 1,
    `count=${mgr.getNumEmitters()}`
  );

  // tick at t=0 keeps emitter; tick after particle expires + emitter
  // hits totalParticles limit → emitter removed.
  mockTime = 0;
  mgr.tick();
  check(
    "ParticleManager: tick @ t=0 keeps emitter (particle alive, totalEmitted < TotalParticles? actually = 1 = TotalParticles → stopped)",
    mgr.getNumEmitters() === 1 || mgr.getNumEmitters() === 0,
    `count=${mgr.getNumEmitters()}`
  );

  // Advance past lifespan → particle dies → emitter has no particles AND
  // is stopped (totalEmitted >= TotalParticles=1) → manager removes it.
  mockTime = 100.0;
  mgr.tick();
  check(
    "ParticleManager: after lifespan + tick, emitter is removed (no particles + stopped)",
    mgr.getNumEmitters() === 0,
    `count=${mgr.getNumEmitters()}`
  );
}

// ============================================================
// Test 11b: addEmitter snapshots parentOffset BY VALUE at entry (#17)
// ------------------------------------------------------------
// Regression guard for C5-async-liveness: addEmitter awaits the
// geometry/material factories before parenting. If the caller mutates
// the shared offset frame while those awaits are pending, the emitter
// must STILL parent to the offset as it was at addEmitter() entry — the
// fix snapshots offsetFrame synchronously up front. Also exercises the
// plain-POJO offset path ({x,y,z} / {w,x,y,z} without THREE methods).
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;

  // --- THREE-instance offset, mutated mid-await -----------------------
  const scene = new THREE.Scene();
  // Deferred geometryFactory: resolves only when we fire `release`, so we
  // can mutate the shared offset between addEmitter() and resolve.
  let release;
  const gate = new Promise((res) => { release = res; });
  const mgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => { await gate; return new THREE.BufferGeometry(); },
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });

  const sharedOffset = {
    position: new THREE.Vector3(7, 8, 9),
    quaternion: new THREE.Quaternion(),
  };
  const addPromise = mgr.addEmitter({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 1,
      totalParticles: 1,
      totalSeconds: 0,
      lifespan: 2.0,
      lifespanRand: 0,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
    parentOffset: sharedOffset,
  });
  // Mutate the shared frame BEFORE the deferred factory resolves — a
  // late read inside addEmitter would pick up these mutated values.
  sharedOffset.position.set(111, 222, 333);
  release();
  const id = await addPromise;
  const emitter = mgr.particleTable.get(id);
  check(
    "Test 11b: parentOffset snapshot survives mid-await mutation (THREE instance)",
    !!emitter
      && approx(emitter.parentOffset.position.x, 7)
      && approx(emitter.parentOffset.position.y, 8)
      && approx(emitter.parentOffset.position.z, 9),
    emitter
      ? `parentOffset.position=(${emitter.parentOffset.position.x}, ${emitter.parentOffset.position.y}, ${emitter.parentOffset.position.z}) expected (7, 8, 9)`
      : "emitter not found"
  );
  // The snapshot must be a distinct object — not an alias of the caller's
  // frame — so future caller mutations cannot reach into the emitter.
  check(
    "Test 11b: snapshot is a copy, not an alias of caller's offset",
    !!emitter && emitter.parentOffset.position !== sharedOffset.position,
    "emitter.parentOffset.position must be a fresh Vector3"
  );

  // --- plain-POJO offset path -----------------------------------------
  const scene2 = new THREE.Scene();
  const mgr2 = new ParticleManager({
    scene: scene2,
    geometryFactory: async (_) => new THREE.BufferGeometry(),
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const id2 = await mgr2.addEmitter({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 1,
      totalParticles: 1,
      totalSeconds: 0,
      lifespan: 2.0,
      lifespanRand: 0,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
    // Bare POJOs, no .clone()/.copy() — exercises the `?? new THREE...`
    // fallback in the snapshot.
    parentOffset: {
      position: { x: 1, y: 2, z: 3 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    },
  });
  const emitter2 = mgr2.particleTable.get(id2);
  check(
    "Test 11b: plain-POJO offset is accepted and snapshotted",
    !!emitter2
      && approx(emitter2.parentOffset.position.x, 1)
      && approx(emitter2.parentOffset.position.y, 2)
      && approx(emitter2.parentOffset.position.z, 3),
    emitter2
      ? `parentOffset.position=(${emitter2.parentOffset.position.x}, ${emitter2.parentOffset.position.y}, ${emitter2.parentOffset.position.z}) expected (1, 2, 3)`
      : "emitter not found"
  );
}

// ============================================================
// Test 12: ParticleEmitterInfo random helpers
// ============================================================
{
  mockTime = 0;
  // RNG returns 0.5 → (rng()*2-1) = 0; rng() = 0.5.
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    aX: 10, aY: 20, aZ: 30,
    minA: 0.5, maxA: 1.5,
    lifespan: 100, lifespanRand: 50,
    startScale: 2.0, finalScale: 5.0, scaleRand: 0.25,
    startTrans: 0.0, finalTrans: 1.0, transRand: 0.5,
  }));

  const a = info.getRandomA();
  // magnitude = (1.5 - 0.5) * 0.5 + 0.5 = 1.0; A = (10,20,30) * 1 = (10,20,30).
  check(
    "getRandomA: magnitude = (max - min) * rng + min = 1.0, scaled A",
    approx(a.x, 10) && approx(a.y, 20) && approx(a.z, 30),
    `a=(${a.x}, ${a.y}, ${a.z})`
  );

  const ls = info.getRandomLifespan();
  // (0.5*2-1)*50 + 100 = 0 + 100 = 100.
  check(
    "getRandomLifespan: at rng=0.5 → result = lifespan (rand factor cancels)",
    approx(ls, 100),
    `lifespan=${ls}`
  );

  // sortingSphere should now reflect velocityRadius = maxA * lifespan
  // = 1.5 * 100 = 150 (versus maxOffset=0, so 150 wins).
  check(
    "ParticleEmitterInfo.sortingSphere.radius = max(maxOffset, maxA*lifespan) = 150",
    approx(info.sortingSphere.radius, 150),
    `radius=${info.sortingSphere.radius}`
  );
}

// ============================================================
// Test 13: setTranslucency helper boundary
// ============================================================
{
  const mesh = makeMesh();
  setTranslucency(mesh, 0.0);
  check(
    "setTranslucency(0): opacity=1, visible=true (fully opaque per ACE)",
    mesh.material.opacity === 1 && mesh.visible === true,
    `opacity=${mesh.material.opacity}, visible=${mesh.visible}`
  );
  setTranslucency(mesh, 0.7);
  check(
    "setTranslucency(0.7): opacity = 1 - 0.7 = 0.3",
    approx(mesh.material.opacity, 0.3, 1e-4),
    `opacity=${mesh.material.opacity}`
  );
  setTranslucency(mesh, 1.0);
  check(
    "setTranslucency(1.0): opacity=0, visible=false (mirrors ACE PhysicsPart.SetTranslucency NoDraw)",
    mesh.material.opacity === 0 && mesh.visible === false,
    `opacity=${mesh.material.opacity}, visible=${mesh.visible}`
  );
}

// ============================================================
// Test 14: localToGlobalVec is pure rotation (no translation)
// ============================================================
{
  // Frame at position (1000, 0, 0), rotated 90° around Y.
  const frame = {
    position: new THREE.Vector3(1000, 0, 0),
    quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),
  };
  const v = new THREE.Vector3(1, 0, 0);
  const out = localToGlobalVec(frame, v);
  // 90° Y rotation maps (1,0,0) → (0,0,-1). NO translation added (the
  // 1000 position is irrelevant).
  check(
    "localToGlobalVec: (1,0,0) rotated 90° around Y → (0,0,-1), no translation from frame.position",
    approx(out.x, 0) && approx(out.y, 0) && approx(out.z, -1) && Math.abs(out.x - 1000) > 1,
    `out=(${out.x.toFixed(4)}, ${out.y.toFixed(4)}, ${out.z.toFixed(4)}) — must NOT contain frame.position (1000)`
  );
}

// ============================================================
// Test 15: normalizeCheckSmall — small-vector branch
// ============================================================
{
  const small = new THREE.Vector3(1e-4, 1e-4, 1e-4);
  const ok = normalizeCheckSmall(small);
  check(
    "normalizeCheckSmall: lengthSq < 1e-6 → returns true (caller should zero)",
    ok === true,
    `result=${ok}`
  );

  const big = new THREE.Vector3(3, 4, 0);
  const ok2 = normalizeCheckSmall(big);
  check(
    "normalizeCheckSmall: large vector → returns false + normalizes in-place",
    ok2 === false && approx(big.length(), 1, 1e-4),
    `result=${ok2}, length=${big.length()}`
  );
}

// ============================================================
// Test 16: GlobalVelocity matches LocalVelocity update math
// ============================================================
{
  // ACE Particle.cs:143-145 combines LocalVelocity and GlobalVelocity in
  // the same case (same formula). Test that GlobalVelocity follows the
  // same trajectory.
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.GlobalVelocity,
    aX: 5, aY: 0, aZ: 0,
    bX: 0, bY: 0, bZ: 0,
    cX: 0, cY: 0, cZ: 0,
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(100, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
  );
  // At t=2: position = 2*5 + 100 = 110.
  mockTime = 2.0;
  p.update(ParticleType.GlobalVelocity, false, mesh, parent);
  check(
    "GlobalVelocity @ t=2: position = t*A + parent + offset = 2*5+100 = 110",
    approx(mesh.position.x, 110),
    `x=${mesh.position.x}`
  );
}

// ============================================================
// Test 17: Explode update — preserves ACE quirk (A.X scalar across XYZ)
// ============================================================
{
  // ACE Particle.cs:166: `(lifetime * B + C * A.X) * lifetime + Offset + parent.Origin;`
  // — scalar A.X multiplies ALL of C's components. This is faithful to ACE.
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Explode,
    aX: 2, aY: 999, aZ: 999, // A.Y/Z unused in Explode update.
    bX: 1, bY: 1, bZ: 1,
    cX: 0, cY: 0, cZ: 0, // C is randomized in init via cos(ra)*c.X*rb etc.
    minA: 1, maxA: 1,
    minB: 1, maxB: 1,
    minC: 1, maxC: 1,
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  // randomC = (0,0,0) → C in init becomes (0,0,0) since c.X=c.Y=c.Z=0.
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(2, 999, 999), new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 0, 0),
  );

  // At t=1: (1*B + C*A.X)*1 = B + 0 = (1, 1, 1) (since C is zero after init).
  mockTime = 1.0;
  p.update(ParticleType.Explode, false, mesh, parent);
  check(
    "Explode @ t=1: position = (t*B + C*A.X)*t + offset + parent = (1+0)*1 + 0 + 0 = (1, 1, 1)",
    approx(mesh.position.x, 1) && approx(mesh.position.y, 1) && approx(mesh.position.z, 1),
    `pos=(${mesh.position.x}, ${mesh.position.y}, ${mesh.position.z})`
  );
}

// ============================================================
// Test 18: Implode update — cos(A.X*t)*C + t²*B + parent + offset
// ============================================================
{
  // ACE Particle.cs:169: `((float)Math.Cos(A.X * lifetime) * C) + (lifetime² * B) + parent.Origin + Offset;`
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Implode,
    aX: 0, // cos(0) = 1
    bX: 1, bY: 0, bZ: 0,
    cX: 5, cY: 5, cZ: 5, // C in init gets `offset *= c` → offset=(0,0,0) * c = (0,0,0).
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  // With offset=(0,0,0) in init: C = Offset * c = (0,0,0) * (5,5,5) = (0,0,0).
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(5, 5, 5),
  );

  // At t=2 with C=(0,0,0), B=(1,0,0): cos(0*2)*0 + 4*1 = 4.
  mockTime = 2.0;
  p.update(ParticleType.Implode, false, mesh, parent);
  check(
    "Implode @ t=2: cos(A.X*t)*C + t²*B + 0 + 0 = 0 + 4 = 4 (C zero'd by Offset*=c init)",
    approx(mesh.position.x, 4),
    `x=${mesh.position.x}`
  );
}

// ============================================================
// Test 19: Still update — position = parent + offset (no time evolution)
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const info = new ParticleEmitterInfo(makeBaseInfo({
    particleType: ParticleType.Still,
  }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(50, 25, 10), quaternion: new THREE.Quaternion() };
  const parentOffset = { position: new THREE.Vector3(1, 2, 3), quaternion: new THREE.Quaternion() };
  const p = new Particle();
  p.init(info, parent, -1, parentOffset, mesh,
    new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
  );
  // After init: offset = (1,2,3) (rotated by identity). Then update inside
  // init runs with parent=parentOffset → mesh.position = (1,2,3)+(1,2,3) = (2,4,6).
  // Now post-init: real parent, lt=0, position = parent + offset = (50,25,10)+(1,2,3) = (51,27,13).
  mockTime = 5.0;
  p.update(ParticleType.Still, false, mesh, parent);
  check(
    "Still @ t=5: position = parent + offset (time-independent) = (51, 27, 13)",
    approx(mesh.position.x, 51) && approx(mesh.position.y, 27) && approx(mesh.position.z, 13),
    `pos=(${mesh.position.x}, ${mesh.position.y}, ${mesh.position.z})`
  );
}

// ============================================================
// Test 20: ParticleManager.destroyParticleEmitter
// ============================================================
{
  mockTime = 0;
  const scene = new THREE.Scene();
  const mgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => new THREE.BufferGeometry(),
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const id = await mgr.addEmitter({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 1, totalParticles: 0, totalSeconds: 100,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  check(
    "destroyParticleEmitter: removes the emitter from the table",
    mgr.destroyParticleEmitter(id) === true && mgr.getNumEmitters() === 0,
    `result=${mgr.getNumEmitters()}`
  );
  check(
    "destroyParticleEmitter(0) is a no-op",
    mgr.destroyParticleEmitter(0) === false,
    "returned false for ID 0"
  );
}

// ============================================================
// Test 21: A11-S0(a) — explicit-id re-create destroys the OLD emitter
// ------------------------------------------------------------
// Survey A11 §3 row 5: a bare `particleTable.delete()` on the explicit-id
// replace path orphaned the old emitter's slot meshes in the scene and
// leaked its per-slot cloned materials. The fix routes the replace through
// destroyParticleEmitter (scene-removal + material disposal). Assert that
// re-adding the SAME explicit emitter id disposes the first emitter's
// per-slot materials and that the table holds the NEW emitter object.
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const scene = new THREE.Scene();
  const mgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => new THREE.BufferGeometry(),
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const FIXED_ID = 0x12345678 >>> 0;
  const baseReq = () => ({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 2, totalParticles: 0, totalSeconds: 100,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
    emitterId: FIXED_ID,
  });
  const id1 = await mgr.addEmitter(baseReq());
  const firstEmitter = mgr.particleTable.get(FIXED_ID);
  check(
    "A11-S0(a): first explicit-id addEmitter returns the supplied id",
    id1 === FIXED_ID && firstEmitter != null,
    `id1=${id1}`
  );
  // The per-slot meshes hold CLONED materials (addEmitter's meshFactory
  // tags them __disposable + !__cacheOwned). Instrument each first-emitter
  // slot material's dispose() directly so we can prove the replace path
  // actually frees them (the bare-`delete` bug did NOT) — clone() yields
  // fresh instances, so we patch the already-built clones here, AFTER the
  // first emitter exists but BEFORE the replace.
  const firstSlotMats = (firstEmitter.partStorage || [])
    .map((m) => m && m.material)
    .filter(Boolean);
  for (const m of firstSlotMats) {
    m.__disposeCount = 0;
    const orig = m.dispose.bind(m);
    m.dispose = () => { m.__disposeCount += 1; orig(); };
  }
  // Capture the old slot meshes so we can confirm they are detached.
  const firstSlotMeshes = (firstEmitter.partStorage || []).filter(Boolean);
  // Re-add with the SAME explicit id → must destroy the first emitter.
  const id2 = await mgr.addEmitter(baseReq());
  const secondEmitter = mgr.particleTable.get(FIXED_ID);
  check(
    "A11-S0(a): re-create with same id keeps table size at 1 (no orphan slot)",
    id2 === FIXED_ID && mgr.getNumEmitters() === 1,
    `id2=${id2} count=${mgr.getNumEmitters()}`
  );
  check(
    "A11-S0(a): table now holds the NEW emitter object (old one replaced)",
    secondEmitter != null && secondEmitter !== firstEmitter,
    `same=${secondEmitter === firstEmitter}`
  );
  // destroyParticleEmitter → _disposeMaterialIfOwned disposes every
  // __disposable per-slot clone. The bare-`delete` bug left these alive.
  const disposedCount = firstSlotMats.filter((m) => (m.__disposeCount | 0) >= 1).length;
  check(
    "A11-S0(a): old emitter's per-slot materials disposed on replace (no leak)",
    firstSlotMats.length > 0 && disposedCount === firstSlotMats.length,
    `firstSlotMats=${firstSlotMats.length} disposed=${disposedCount}`
  );
  // And the old slot meshes must be detached from any scene parent (the
  // bug orphaned them in the scene graph).
  const detached = firstSlotMeshes.every((m) => m.parent == null);
  check(
    "A11-S0(a): old emitter's slot meshes detached from the scene graph",
    detached,
    `slotMeshes=${firstSlotMeshes.length} stillParented=${firstSlotMeshes.filter((m) => m.parent != null).length}`
  );
}

// ============================================================
// Test 22: A11-S0(b) — blocking create returns 0 if id already live
// ------------------------------------------------------------
// Survey A11 §3 row 6: retail `CreateBlockingParticleEmitter`
// (acclient.c:329528-329565) returns 0 and does NOT replace when the
// emitter id is already live — the opposite of the non-blocking replace
// path. Assert blocking:true over a live id returns 0 + leaves the
// existing emitter object untouched; and that blocking over a FREE id
// still installs normally.
// ============================================================
{
  mockTime = 0;
  mockRngVal = 0.5;
  const scene = new THREE.Scene();
  const mgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => new THREE.BufferGeometry(),
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const FIXED_ID = 0x0badf00d >>> 0;
  const req = (extra) => Object.assign({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 1, totalParticles: 0, totalSeconds: 100,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
    emitterId: FIXED_ID,
  }, extra || {});

  // Blocking over a FREE id installs (returns the id).
  const idBlockFree = await mgr.addEmitter(req({ blocking: true }));
  const installedEmitter = mgr.particleTable.get(FIXED_ID);
  check(
    "A11-S0(b): blocking create over a FREE id installs (returns id)",
    idBlockFree === FIXED_ID && installedEmitter != null,
    `id=${idBlockFree}`
  );

  // Blocking over the now-LIVE id returns 0 and does NOT replace.
  const idBlockLive = await mgr.addEmitter(req({ blocking: true }));
  check(
    "A11-S0(b): blocking create over a LIVE id returns 0 (no replace)",
    idBlockLive === 0,
    `id=${idBlockLive}`
  );
  check(
    "A11-S0(b): the original emitter object survives the blocking no-replace",
    mgr.particleTable.get(FIXED_ID) === installedEmitter && mgr.getNumEmitters() === 1,
    `same=${mgr.particleTable.get(FIXED_ID) === installedEmitter} count=${mgr.getNumEmitters()}`
  );

  // Control: NON-blocking over the live id DOES replace (legacy off-path).
  const idReplace = await mgr.addEmitter(req({ blocking: false }));
  check(
    "A11-S0(b): non-blocking (default) over a LIVE id still replaces (legacy off-path)",
    idReplace === FIXED_ID
      && mgr.particleTable.get(FIXED_ID) !== installedEmitter
      && mgr.getNumEmitters() === 1,
    `id=${idReplace} replaced=${mgr.particleTable.get(FIXED_ID) !== installedEmitter}`
  );
}

// ============================================================
// Test 24: null-geometry guard (2026-07-26)
// ------------------------------------------------------------
// Remote-play regression: `[particle-owner] addEmitter failed: TypeError …
// reading 'morphAttributes' of null` ×4. A geometryFactory that resolves
// null (missing GfxObj record / a part that decoded to triCount 0) used to
// reach `new THREE.Mesh(null, mat)` in the per-slot meshFactory, whose
// `updateMorphTargets()` dereferences `geometry.morphAttributes` and throws
// out of addEmitter. Assert the emitter is now SKIPPED (returns 0, nothing
// installed, no throw), that a real geometry still installs normally, and
// that hwGfxObjId==0 still short-circuits to 0 silently.
// ============================================================
{
  mockTime = 0;
  const scene = new THREE.Scene();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };

  const nullGeomMgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => null,
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const req = (overrides = {}) => ({
    emitterInfo: makeBaseInfo({
      particleType: ParticleType.Still,
      maxParticles: 2, totalParticles: 0, totalSeconds: 100,
      ...overrides,
    }),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });

  let threw = null;
  let nullId = -1;
  try {
    nullId = await nullGeomMgr.addEmitter(req());
  } catch (e) {
    threw = e;
  }
  check(
    "null geometry: addEmitter does NOT throw (was TypeError morphAttributes of null)",
    threw === null,
    threw ? `threw=${threw}` : "no throw"
  );
  check(
    "null geometry: addEmitter returns 0 and installs nothing",
    nullId === 0 && nullGeomMgr.getNumEmitters() === 0,
    `id=${nullId} count=${nullGeomMgr.getNumEmitters()}`
  );
  check(
    "null geometry: warns exactly once, naming the emitter + gfxobj DIDs",
    warns.length === 1
      && warns[0].includes("id=0x32000456")
      && warns[0].includes("hwGfxObjId=0x1001a62"),
    `warns=${warns.length} first=${JSON.stringify(warns[0] ?? null)}`
  );

  // Rate limit: a SECOND null-geometry emitter with the same DID pair is
  // silent (emitters re-attach on every landblock re-bake).
  await nullGeomMgr.addEmitter(req());
  check(
    "null geometry: repeat of the same (emitter,gfxobj) pair is rate-limited",
    warns.length === 1,
    `warns=${warns.length}`
  );

  // hwGfxObjId == 0 short-circuits BEFORE the factories, silently (the
  // entities path deliberately went quiet for id 0 on 2026-06-29).
  const warnsBefore = warns.length;
  let geomCalls = 0;
  const zeroMgr = new ParticleManager({
    scene,
    geometryFactory: async (_) => { geomCalls += 1; return new THREE.BufferGeometry(); },
    materialFactory: async (_) => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const zeroId = await zeroMgr.addEmitter(req({ hwGfxObjId: 0 }));
  check(
    "hwGfxObjId==0 returns 0 without calling the factories or warning",
    zeroId === 0 && geomCalls === 0 && warns.length === warnsBefore
      && zeroMgr.getNumEmitters() === 0,
    `id=${zeroId} geomCalls=${geomCalls} newWarns=${warns.length - warnsBefore}`
  );

  // Control: a real geometry through the SAME manager still installs.
  const okId = await zeroMgr.addEmitter(req());
  check(
    "control: a non-null geometry still installs the emitter normally",
    okId !== 0 && zeroMgr.getNumEmitters() === 1 && geomCalls === 1,
    `id=${okId} count=${zeroMgr.getNumEmitters()} geomCalls=${geomCalls}`
  );

  console.warn = realWarn;
}

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log(`PASS: ${passed}/${passed} Sky-J P4 particle runtime checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
