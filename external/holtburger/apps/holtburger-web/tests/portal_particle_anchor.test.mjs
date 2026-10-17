// Portal "pop-up" root causes on the particle side (2026-10-16):
//
//   ?staticPartAnchor (statics.js) — a static's default script anchors its
//     CreateParticle hooks to PARTS (retail ParticleEmitter::SetParenting), but
//     the static script anchor had no `partFrames`, so every part-anchored hook
//     fell back to the placement origin: a static portal's swirl sat on the
//     ground instead of 1.4 m up, a destroyed portal's sputters up to 3 m low.
//   ?rp6TrueSphere (particle_manager.js) — the emitter cull sphere sat on the
//     rig ORIGIN with only the travel radius + hook offset, so a part-anchored
//     swirl drawn 1.5 m up in 5x-scaled layers was culled whenever the portal's
//     foot left the frame and popped back when it returned.
//
//   A  attachStaticPartFrames builds one node per part in the wasm pose; the
//      emitter runtime then anchors a part hook ON the part (world → scene-local)
//   B  stale pkg / non-Setup / `=off` / a failed fetch → bare anchor, as before
//   C  rp6CullSphere: centre = the part frame, radius adds the sprite reach
//   D  the case that popped: root out of the frustum, the swirl in it
//   E  `?rp6TrueSphere=off` reproduces the old origin sphere
//   F  the flag parsers
import * as THREE from "three";
import {
  attachStaticPartFrames,
  staticPartAnchorEnabled,
  staticPartAnchorStats,
  __setStaticPartAnchorForTest,
} from "../scene3d/statics.js";
import {
  rp6CullSphere,
  rp6SpriteReach,
  rp6TrueSphereEnabled,
  setRp6TrueSphereFlag,
} from "../scene3d/particles/particle_manager.js";
import { ParticleEmitter } from "../scene3d/particles/particle_emitter.js";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

// The scene graph the static manager lives in: staticsGroup under a worldRoot
// rotated −π/2 about X (acToThree), exactly like the client.
function makeWorld() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  worldRoot.add(staticsGroup);
  return { scene, worldRoot, staticsGroup };
}
// The purple portal Setup 0x020001B3: one part, Default frame z +1.415.
const PURPLE_POSE = Float32Array.from([0, 0, 1.415, 1, 0, 0, 0]);
// A destroyed-portal-like Setup: a part 2.764 m up, one on the ground.
const BROKEN_POSE = Float32Array.from([0, 0, 2.764, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
const wasmWith = (poses) => ({
  calls: 0,
  async fetchSetupPartPose(sid) { this.calls += 1; return poses.get(sid >>> 0) ?? new Float32Array(0); },
});

// ── A — part frames on the static anchor ──────────────────────────────────
__setStaticPartAnchorForTest(true);
{
  const { scene, staticsGroup } = makeWorld();
  const anchor = new THREE.Group();
  anchor.position.set(1000, 2000, 50);
  anchor.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  staticsGroup.add(anchor);
  const wasm = wasmWith(new Map([[0x020001b3, PURPLE_POSE], [0x020019e4, BROKEN_POSE]]));
  const n = await attachStaticPartFrames(anchor, 0x020001b3, wasm);
  check("A: one part node for the one-part portal", n === 1 && anchor.children.length === 1);
  check("A: the anchor exposes partFrames[0]", !!anchor.partFrames && anchor.partFrames.length === 1);
  scene.updateMatrixWorld(true);
  const wf = anchor.partFrames[0];
  // the part's WORLD position = staticsGroup-local (1000, 2000, 51.415) through worldRoot
  const expectWorld = new THREE.Vector3(1000, 2000, 51.415).applyMatrix4(staticsGroup.matrixWorld);
  check("A: partFrames[0] is the part's WORLD frame (1.415 m above the anchor)", wf.position.distanceTo(expectWorld) < 1e-4,
    `${wf.position.toArray()} vs ${expectWorld.toArray()}`);
  // The emitter runtime turns it back into staticsGroup-local space.
  const em = new ParticleEmitter({ parent: anchor, scene: staticsGroup, meshFactory: async () => null });
  em.partIndex = 0;
  const f = em._resolveAnchorFrame();
  check("A: a part-0 hook anchors ON the part (scene-local z 51.415, not 50)", near(f.position.z, 51.415, 1e-4) &&
    near(f.position.x, 1000, 1e-3) && near(f.position.y, 2000, 1e-3), f.position.toArray().join(","));
  em.partIndex = -1;
  check("A: a root hook still anchors on the anchor", em._resolveAnchorFrame() === anchor);
  // multi-part: each hook rides its own part
  const a2 = new THREE.Group();
  staticsGroup.add(a2);
  check("A: the destroyed-portal pose builds both parts", (await attachStaticPartFrames(a2, 0x020019e4, wasm)) === 2);
  scene.updateMatrixWorld(true);
  const e2 = new ParticleEmitter({ parent: a2, scene: staticsGroup, meshFactory: async () => null });
  e2.partIndex = 0;
  check("A: part 0 rides 2.764 m up", near(e2._resolveAnchorFrame().position.z, 2.764, 1e-4));
  e2.partIndex = 1;
  check("A: part 1 rides the ground", near(e2._resolveAnchorFrame().position.z, 0, 1e-4));
  e2.partIndex = 5;
  check("A: an out-of-range part falls back to the anchor", e2._resolveAnchorFrame() === a2);
  const before = wasm.calls;
  await attachStaticPartFrames(new THREE.Group(), 0x020001b3, wasm);
  check("A: the pose is fetched once per Setup", wasm.calls === before);
  check("A: diag counts anchors and parts", staticPartAnchorStats().anchors >= 3 && staticPartAnchorStats().parts >= 4);
}

// ── B — the bare-anchor cases ─────────────────────────────────────────────
{
  const wasm = wasmWith(new Map());
  const a = new THREE.Group();
  check("B: a raw GfxObj model gets no part frames", (await attachStaticPartFrames(a, 0x0100168b, wasm)) === 0 && !a.partFrames);
  check("B: a stale pkg (no export) gets none", (await attachStaticPartFrames(a, 0x020001b3, {})) === 0 && !a.partFrames);
  check("B: an empty pose (unreadable record) gets none", (await attachStaticPartFrames(a, 0x02000001, wasm)) === 0 && !a.partFrames);
  const throwing = { async fetchSetupPartPose() { throw new Error("transient"); } };
  check("B: a failed fetch gets none", (await attachStaticPartFrames(a, 0x02000002, throwing)) === 0);
  const ok = wasmWith(new Map([[0x02000002, PURPLE_POSE]]));
  check("B: ...and is retried next time (failures are not cached)", (await attachStaticPartFrames(new THREE.Group(), 0x02000002, ok)) === 1);
  __setStaticPartAnchorForTest(false);
  const off = new THREE.Group();
  check("B: ?staticPartAnchor=off leaves the anchor bare", (await attachStaticPartFrames(off, 0x020001b3, wasmWith(new Map([[0x020001b3, PURPLE_POSE]])))) === 0 && !off.partFrames);
  __setStaticPartAnchorForTest(true);
}

// ── C / D / E — the cull sphere ───────────────────────────────────────────
function portalEmitter(world) {
  // An ENTITY-style rig: root at the portal's foot, part 0 posed 1.415 m up.
  const root = new THREE.Group();
  root.position.set(0, 0, 0);
  world.staticsGroup.add(root);
  const part = new THREE.Group();
  part.position.set(0, 0, 1.415);
  root.add(part);
  root.partFrames = {
    length: 1,
    0: (() => {
      const f = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
      return new Proxy(f, { get(t, k) { if (k === "position") { part.updateWorldMatrix(true, false); part.getWorldPosition(t.position); } return t[k]; } });
    })(),
  };
  world.scene.updateMatrixWorld(true);
  return {
    parent: root,
    partIndex: 0,
    parentOffset: { position: new THREE.Vector3(0, 0, 0.15), quaternion: new THREE.Quaternion() },
    // the purple swirl 0x320002CD: travel radius max(0.1, 1.5 × 2) = 3, scale 5 → 0.1
    info: { sortingSphere: { radius: 3 }, startScale: 5, finalScale: 0.1, scaleRand: 0 },
    _gfxRadius: 0.7,
  };
}
{
  const world = makeWorld();
  const em = portalEmitter(world);
  setRp6TrueSphereFlag(true);
  const c = new THREE.Vector3();
  const r = rp6CullSphere(em, c);
  const partWorld = new THREE.Vector3();
  em.parent.children[0].getWorldPosition(partWorld);
  check("C: the centre is the part frame (1.415 m up), not the foot", c.distanceTo(partWorld) < 1e-5, c.toArray().join(","));
  check("C: the radius adds one sprite's reach (0.7 × 5)", near(rp6SpriteReach(em), 3.5) && near(r, 3 + 0.15 + 3.5), `r ${r}`);
  check("C: no gfx radius → no sprite term", rp6SpriteReach({ info: em.info }) === 0);
  check("C: the sprite scale is clamped like retail (≤ 10)", near(rp6SpriteReach({ info: { startScale: 40, finalScale: 1, scaleRand: 0 }, _gfxRadius: 1 }), 10));

  // D — the camera close in front, pitched UP at the swirl: the foot is below
  // the frame, the swirl fills it. (THREE world: the AC z-up is THREE +y.)
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  cam.position.copy(partWorld).add(new THREE.Vector3(0, 0, 6));
  cam.lookAt(partWorld.clone().add(new THREE.Vector3(0, 2.4, 0)));
  cam.updateMatrixWorld(true);
  const fr = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const footWorld = new THREE.Vector3();
  em.parent.getWorldPosition(footWorld);
  check("D: setup — the portal's foot is out of the frame", !fr.containsPoint(footWorld));
  check("D: setup — the swirl centre is in the frame", fr.containsPoint(partWorld));
  check("D: ON — the emitter is kept (the true sphere is in view)", fr.intersectsSphere(new THREE.Sphere(c.clone(), r)));
  setRp6TrueSphereFlag(false);
  const c0 = new THREE.Vector3();
  const r0 = rp6CullSphere(em, c0);
  check("E: =off — the old sphere sits on the foot with travel + offset only", c0.distanceTo(footWorld) < 1e-5 && near(r0, 3.15), `r ${r0}`);
  // the destroyed-portal sputter (0.75 m travel, part 2.764 m up): culled off, kept on
  const sputter = { ...portalEmitter(world), info: { sortingSphere: { radius: 0.75 }, startScale: 5, finalScale: 0.1, scaleRand: 0 } };
  sputter.parent.children[0].position.z = 2.764;
  world.scene.updateMatrixWorld(true);
  const cS = new THREE.Vector3();
  const rS0 = rp6CullSphere(sputter, cS);
  const sw = new THREE.Vector3();
  sputter.parent.children[0].getWorldPosition(sw);
  const cam2 = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  cam2.position.copy(sw).add(new THREE.Vector3(0, 0.5, 5));
  cam2.lookAt(sw.clone().add(new THREE.Vector3(0, 1.5, 0)));
  cam2.updateMatrixWorld(true);
  const fr2 = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam2.projectionMatrix, cam2.matrixWorldInverse));
  check("D: =off — the sputter WAS culled while in view (the pop)", !fr2.intersectsSphere(new THREE.Sphere(cS.clone(), rS0)) && fr2.containsPoint(sw));
  setRp6TrueSphereFlag(true);
  const rS = rp6CullSphere(sputter, cS);
  check("D: ON — the sputter stays live", fr2.intersectsSphere(new THREE.Sphere(cS.clone(), rS)));
  // a root-anchored emitter is unchanged apart from the sprite term
  const rootEm = { ...em, partIndex: -1 };
  const cR = new THREE.Vector3();
  check("E: a root-anchored emitter keeps its origin centre", rp6CullSphere(rootEm, cR) > 0 && cR.distanceTo(footWorld) < 1e-5);
  check("E: no anchor → -1 (bail open)", rp6CullSphere({ parent: null }, cR) === -1);
  check("E: a ballistic projectile is never culled", rp6CullSphere({ parent: { userData: { __ballistic: true } } }, cR) === -1);
}

// ── F — flag parsers ──────────────────────────────────────────────────────
check("F: staticPartAnchor absent → on", staticPartAnchorEnabled("") === true);
for (const v of ["off", "0", "false", "no"]) check(`F: staticPartAnchor=${v} → off`, staticPartAnchorEnabled(`?staticPartAnchor=${v}`) === false);
setRp6TrueSphereFlag(null);
check("F: rp6TrueSphere absent → on (node has no location → default)", rp6TrueSphereEnabled() === true);

__setStaticPartAnchorForTest(undefined);
setRp6TrueSphereFlag(null);
console.log(`portal_particle_anchor: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
