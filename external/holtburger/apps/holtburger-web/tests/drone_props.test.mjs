// tests/drone_props.test.mjs
//
// WHY: the Drone Deploy props (the brass quad, the tablet, the FPV goggles) are
// drawn by the live renderer, so their cost and correctness rules are binding
// (SPEC §3.2): a Light object relinks every lit program (a multi-second freeze), a
// custom shader / onBeforeCompile / a map added later is a new program key at
// runtime, `__disposable` would let the rig's dispose free our resources, a prop
// on layer 0 is overpainted by the indoor depth split, an untagged scene child is
// erased by the doorway punch, a raycastable prop steals clicks from picking.js,
// a stale matrixWorld (skipHiddenMatrix) misplaces the drone on the ground, and a
// leaked geometry / material / texture per deploy grows the GPU forever. This
// suite EXECUTES the real scene3d/drone/props.js against real three r184 (no DOM):
//   P1 droneGroup + build rules (layers, shadows, raycast, lights, stock
//      materials with their final maps, no program-key overrides, no ownership
//      tags), all three props hidden at 'none';
//   P2 mesh and triangle budgets and the model conventions (feet at −0.06, span,
//      collision radius, camera end +y, tablet dims + screen on +z, goggle lenses
//      facing −y); the goggles' lens panels are dark tinted glass on the lit metal
//      and the REC pip is their only glow (1070 V3: no "lit eyes");
//   P3 attach (the `__attachedChildOf` brand, anchors, the drone's 1/rootScale
//      counter-scale, refusals, idempotence), setRig re-parenting, setAnchors;
//   P4 toWorld under a worldRoot-like rig (AC x/y kept to 1e-6, z snapped to
//      groundZ + 0.06, level yaw, scale 1), place / remove / where / worldPos /
//      setDronePose; the drone-in-hand anchor lands the place release with no
//      orientation snap (R4-03: the real fixture frames + the real clip order);
//   P5 setRotor (blades ↔ blur discs at spin 0.3, 1 Hz rear LED), the blur discs'
//      translucent neutral-grey smoke (1070 V2), the blob shadow, setVisible,
//      setScreen (false without a canvas; draws on a fake canvas; its texts
//      rebuilt only when the shown value changes — SPEC §5's 4 Hz rule);
//   P6 fadeOut (removed after delay + duration of setRotor time, no material swap
//      or program-relevant change), no material version / map / program-field
//      change across the whole runtime surface, dispose (exactly what was
//      created, once; idempotent);
//   P7 prewarm against a fake renderer (HalfFloat target bound around compile and
//      restored; then the film lens-overlay twin compiled with the null target
//      from an empty Scene — R2-2; every program of a material ready-polled;
//      memoised per renderer, proxies kept alive, never rejects), the prewarm
//      material set == the live material set, the twin's program fields == every
//      real film overlay material's, and on three r184's REAL WebGLRenderer
//      (tests/helpers/fake_webgl2.mjs) the overlay's first FPV draw links no
//      program after the prewarm (2 without it).
//
// Flag: ?drone (DEFAULT ON since 2026-10-25, ?drone=off disables it) — the module only loads through the drone HUD.
// Run from apps/holtburger-web/: node tests/drone_props.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  PROP_NAMES, DRONE_BODY, DEFAULT_ANCHORS, ANCHOR_OF, ANCHOR_KEY,
  prewarm, createProps, _resetPrewarmForTest,
} from "../scene3d/drone/props.js";
import { GESTURE_CLIPS, buildClip } from "../scene3d/drone/gestures.js";
import { createLensOverlay, LENS_OVERLAY_STYLES } from "../scene3d/film/runtime/lens_overlay.js";
import { createFakeWebGL2, fakeCanvas as fakeGlCanvas } from "./helpers/fake_webgl2.mjs";

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GUID = 0x50000001;
const HUMANOID = Object.freeze({ kind: "humanoid", rightHand: 15, leftHand: 12, head: 16, rightGrip: { partId: 15 }, leftGrip: { partId: 12 } });
const NO_HANDS = Object.freeze({ kind: "no-hands", rightHand: -1, leftHand: -1, head: -1, rightGrip: null, leftGrip: null });

/** A scene with a worldRoot-like rig: worldRoot (rotation.x −π/2) → entities → rig root → 34 part groups. */
function rigScene({ pos = [100.5, 200.25, 12], yaw = 0.7, scale = 1.3, parts = 34 } = {}) {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const entities = new THREE.Group();
  worldRoot.add(entities);
  const root = new THREE.Group();
  root.position.set(pos[0], pos[1], pos[2]);
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
  root.scale.setScalar(scale);
  entities.add(root);
  const partGroups = [];
  for (let i = 0; i < parts; i += 1) {
    const g = new THREE.Group();
    g.name = `part_${i}`;
    g.position.set(0.01 * i, 0.02 * i - 0.3, 0.05 * i);
    g.quaternion.setFromEuler(new THREE.Euler(0.1 * i, -0.05 * i, 0.2));
    root.add(g);
    partGroups.push(g);
  }
  return { scene, worldRoot, root, parts: partGroups, rig: { guid: GUID, parts: partGroups, rootScale: scale, profile: HUMANOID } };
}

/** AC world position of part-local point `p` on `part` (independent of props.js). */
function acOfPartPoint(worldRoot, part, p) {
  worldRoot.parent.updateMatrixWorld(true);
  const v = new THREE.Vector3(p[0], p[1], p[2]);
  part.localToWorld(v);
  worldRoot.worldToLocal(v);
  return [v.x, v.y, v.z];
}

function nodes(root) {
  const out = [];
  root.traverse((o) => out.push(o));
  return out;
}
function allNodes(props) {
  const set = new Set([...nodes(props.group), ...nodes(props.drone), ...nodes(props.tablet), ...nodes(props.goggles)]);
  return [...set];
}
const meshesOf = (root) => nodes(root).filter((o) => o.isMesh);
const tris = (m) => (m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3);
const blobOf = (props) => props.group.getObjectByName("drone-blob");

/** The palette texel `[r, g, b]` (sRGB bytes) a vertex's u coordinate points at. */
function paletteRgb(material, u) {
  const img = material.map.image;
  const i = Math.min(img.width - 1, Math.floor(u * img.width)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Goggles-body vertex indices of the lens panels: the most forward −y-facing surface. */
function lensVertices(props) {
  const g = props.goggles.getObjectByName("goggles-body").geometry;
  const p = g.attributes.position;
  const nr = g.attributes.normal;
  const front = [];
  for (let i = 0; i < p.count; i += 1) if (Math.abs(nr.getY(i) + 1) < 1e-6) front.push(i);
  const minY = Math.min(...front.map((i) => p.getY(i)));
  return front.filter((i) => Math.abs(p.getY(i) - minY) < 1e-6);
}

/** The real drone animation frames (fixtures/drone/anims.json, keyed "0x03000247"). */
const ANIMS = JSON.parse(readFileSync(new URL("../fixtures/drone/anims.json", import.meta.url), "utf8")).anims;
const animKey = (did) => "0x" + did.toString(16).toUpperCase().padStart(8, "0");

/** A live-scene stand-in: lights and fog (both folded into every program key in r184). */
function litFoggedScene() {
  const s = new THREE.Scene();
  s.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.AmbientLight(0xffffff, 0.3), new THREE.HemisphereLight());
  s.fog = new THREE.Fog(0x888888, 10, 500);
  return s;
}

/** Every field three folds into a program cache key that a material can carry. */
function programFields(m) {
  return JSON.stringify({
    type: m.type, map: !!m.map, mapChannel: m.map ? m.map.channel : null, video: !!m.map?.isVideoTexture,
    transparent: m.transparent, blending: m.blending, alphaToCoverage: !!m.alphaToCoverage,
    alphaTest: m.alphaTest > 0, alphaHash: !!m.alphaHash, side: m.side, vertexColors: !!m.vertexColors,
    fog: m.fog, flatShading: !!m.flatShading, toneMapped: m.toneMapped, dithering: !!m.dithering,
    premultipliedAlpha: !!m.premultipliedAlpha, wireframe: !!m.wireframe, envMap: !!m.envMap,
    emissiveMap: !!m.emissiveMap, alphaMap: !!m.alphaMap, normalMap: !!m.normalMap, aoMap: !!m.aoMap,
    lightMap: !!m.lightMap, bumpMap: !!m.bumpMap, displacementMap: !!m.displacementMap,
    metalnessMap: !!m.metalnessMap, roughnessMap: !!m.roughnessMap, specularMap: !!m.specularMap,
    gradientMap: !!m.gradientMap, defines: m.defines ?? null, precision: m.precision ?? null,
    clipping: m.clippingPlanes ? m.clippingPlanes.length : 0, depthPacking: m.depthPacking ?? null,
    combine: m.combine ?? null, key: m.customProgramCacheKey(),
  });
}

/**
 * A WebGLRenderer stand-in for prewarm: records targets around compile(); programs ready on demand.
 * `throwAt` throws from the n-th compile (0 = the prop set, 1 = the overlay twin); `twoPass` gives every
 * material three's `programs` map with a BackSide program (`backReady`) beside the current FrontSide one.
 */
function fakeRenderer({ throwCompile = false, throwAt = -1, vanish = false, twoPass = false } = {}) {
  const prev = { name: "composer-target" };
  const r = {
    prev, _target: prev, events: [], compiles: [], ready: true, backReady: true, isReadyCalls: 0,
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this.events.push(["setRenderTarget", t]); this._target = t; },
    compile(root, camera, scene) {
      this.events.push(["compile", this._target]);
      if (throwCompile || this.compiles.length === throwAt) throw new Error("context lost");
      const set = new Set();
      root.traverse((o) => { if (o.isMesh) set.add(o.material); });
      this.compiles.push({ root, camera, scene, target: this._target, materials: [...set] });
      return set;
    },
    properties: {
      get: () => {
        if (vanish) return {};
        const front = { isReady: () => { r.isReadyCalls += 1; return r.ready; } };
        if (!twoPass) return { currentProgram: front };
        return { programs: new Map([["back", { isReady: () => r.backReady }], ["front", front]]), currentProgram: front };
      },
    },
  };
  return r;
}

// ---------------------------------------------------------------------------
// P1 build
// ---------------------------------------------------------------------------

check("P1 exported constants (exact, frozen)", () => {
  assert.deepEqual([...PROP_NAMES], ["drone", "tablet", "goggles"]);
  assert.deepEqual({ ...DRONE_BODY }, { spanM: 0.32, restHeightM: 0.06, radiusM: 0.18 });
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_ANCHORS)), {
    droneInHand: { pos: [0.025, 0, -0.076], quat: [0.932351, 0.304211, 0.142447, -0.13374] }, // R4-03 (P4 pins why)
    tablet: { pos: [-0.105, -0.035, -0.143], quat: [-0.509, 0.062, -0.685, 0.518] },
    goggles: { pos: [0, -0.10, 0.085], quat: [1, 0, 0, 0], scale: 1 },
  });
  assert.deepEqual({ ...ANCHOR_OF }, { drone: "rightHand", tablet: "leftHand", goggles: "head" });
  assert.deepEqual({ ...ANCHOR_KEY }, { drone: "droneInHand", tablet: "tablet", goggles: "goggles" });
  for (const o of [PROP_NAMES, DRONE_BODY, DEFAULT_ANCHORS, ANCHOR_OF, ANCHOR_KEY, DEFAULT_ANCHORS.tablet, DEFAULT_ANCHORS.tablet.pos, DEFAULT_ANCHORS.goggles.quat]) {
    assert.ok(Object.isFrozen(o));
  }
});

check("P1 createProps: REQUIRED THREE and scene", () => {
  assert.throws(() => createProps({ scene: new THREE.Scene() }), TypeError);
  assert.throws(() => createProps({ THREE }), TypeError);
  assert.throws(() => createProps(), TypeError);
});

check("P1 droneGroup: scene child, rotation.x −π/2, __punchPhase 2, name drone-world; props hidden at 'none'", () => {
  const scene = new THREE.Scene();
  const props = createProps({ THREE, scene });
  assert.equal(props.group.parent, scene);
  assert.equal(props.group.name, "drone-world");
  near(props.group.rotation.x, -Math.PI / 2, 1e-12);
  assert.equal(props.group.rotation.y, 0);
  assert.equal(props.group.rotation.z, 0);
  assert.equal(props.group.userData.__punchPhase, 2);
  for (const n of PROP_NAMES) {
    assert.equal(props.where(n), "none");
    assert.equal(props[n].parent, null, `${n} unparented`);
    assert.equal(props[n].visible, false, `${n} hidden`);
  }
  assert.equal(blobOf(props).visible, false);
  assert.deepEqual(props.stats(), { meshes: 8, geometries: 8, materials: 5, textures: 4, built: true });
  props.dispose();
});

check("P1 every node: layer 1 only, no shadows; meshes: no-op raycast, default culling; no lights", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  const all = allNodes(props);
  assert.ok(all.length >= 12);
  const rc = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
  for (const o of all) {
    assert.equal(o.layers.mask, 2, `${o.name} layer mask`);
    assert.equal(o.castShadow, false, `${o.name} castShadow`);
    assert.equal(o.receiveShadow, false, `${o.name} receiveShadow`);
    assert.notEqual(o.isLight, true, `${o.name} is a light`);
    if (o.isMesh) {
      assert.notEqual(o.raycast, THREE.Mesh.prototype.raycast, `${o.name} raycast replaced`);
      const hits = [];
      o.raycast(rc, hits);
      assert.equal(hits.length, 0, `${o.name} raycast is a no-op`);
      assert.equal(o.frustumCulled, true, `${o.name} frustumCulled default`);
    }
  }
  props.dispose();
});

check("P1 materials: stock MeshStandard / MeshBasic with their final map; no onBeforeCompile / program-key override / ownership tags", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  const mats = new Set();
  const geoms = new Set();
  for (const o of allNodes(props)) {
    assert.equal(o.userData.__disposable, undefined, `${o.name} node __disposable`);
    assert.equal(o.userData.__cacheOwned, undefined, `${o.name} node __cacheOwned`);
    if (o.isMesh) { mats.add(o.material); geoms.add(o.geometry); }
  }
  assert.equal(mats.size, 5);
  for (const m of mats) {
    assert.ok(m.isMeshStandardMaterial === true || m.isMeshBasicMaterial === true, `${m.name}: ${m.type}`);
    assert.ok(m.type === "MeshStandardMaterial" || m.type === "MeshBasicMaterial");
    assert.notEqual(m.isShaderMaterial, true);
    assert.equal(m.onBeforeCompile, THREE.Material.prototype.onBeforeCompile, `${m.name} onBeforeCompile`);
    assert.equal(m.customProgramCacheKey, THREE.Material.prototype.customProgramCacheKey, `${m.name} customProgramCacheKey`);
    assert.ok(m.map && m.map.isTexture, `${m.name} has its final map`);
    assert.equal(m.vertexColors, false);
    assert.equal(m.userData.__disposable, undefined);
    assert.equal(m.userData.__cacheOwned, undefined);
    assert.equal(m.map.userData.__disposable, undefined);
    if (m.isMeshBasicMaterial) {
      assert.equal(m.transparent, true, `${m.name}: the {map, transparent, depthWrite:false} archetype twin`);
      assert.equal(m.depthWrite, false);
      assert.equal(m.side, THREE.FrontSide);
      assert.equal(m.blending, THREE.NormalBlending);
    } else {
      assert.equal(m.side, THREE.DoubleSide, "metal: the {map, DoubleSide} MeshStandard archetype twin");
      assert.equal(m.transparent, false);
      assert.equal(m.alphaTest, 0);
    }
  }
  for (const g of geoms) {
    assert.equal(g.userData.__disposable, undefined);
    assert.ok(g.attributes.position && g.attributes.normal && g.attributes.uv, "position + normal + uv on every geometry");
    assert.equal(g.attributes.color, undefined);
    assert.equal(g.attributes.tangent, undefined);
  }
  props.dispose();
});

// ---------------------------------------------------------------------------
// P2 budgets + model conventions
// ---------------------------------------------------------------------------

check("P2 budgets: drone ≤ 6 meshes (incl. blob + blur), tablet ≤ 2, goggles ≤ 2; drone ≤ 700 tris, tablet + goggles ≤ 600", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  const droneMeshes = [...meshesOf(props.drone), blobOf(props)];
  assert.ok(droneMeshes.length <= 6, `drone meshes ${droneMeshes.length}`);
  assert.ok(meshesOf(props.drone).some((m) => m.name === "drone-blur"), "blur discs are a drone mesh");
  assert.ok(meshesOf(props.tablet).length <= 2);
  assert.ok(meshesOf(props.goggles).length <= 2);
  const droneTris = droneMeshes.reduce((s, m) => s + tris(m), 0);
  const tgTris = [...meshesOf(props.tablet), ...meshesOf(props.goggles)].reduce((s, m) => s + tris(m), 0);
  assert.ok(droneTris <= 700, `drone tris ${droneTris}`);
  assert.ok(tgTris <= 600, `tablet + goggles tris ${tgTris}`);
  assert.ok(droneTris >= 200, `a real model, not a placeholder (${droneTris})`);
  props.dispose();
});

check("P2 model conventions: drone feet at −0.06, ≈0.32 m span inside radiusM, camera at +y; tablet 0.24×0.16×0.012 screen +z; goggle lenses −y", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  const box = (mesh) => { mesh.geometry.computeBoundingBox(); return mesh.geometry.boundingBox; };
  const body = props.drone.getObjectByName("drone-body");
  const glow = props.drone.getObjectByName("drone-glow");
  const blur = props.drone.getObjectByName("drone-blur");
  near(box(body).min.z, -DRONE_BODY.restHeightM, 1e-6, "feet at z = −restHeightM");
  // span = prop tip to prop tip across the diagonal (the body mesh carries the blades)
  const bp = body.geometry.attributes.position;
  let tip = 0;
  for (let i = 0; i < bp.count; i += 1) tip = Math.max(tip, Math.hypot(bp.getX(i), bp.getY(i)));
  assert.ok(2 * tip > 0.30 && 2 * tip < 0.34, `span ${2 * tip}`);
  const b = box(blur);
  assert.ok(b.max.x - b.min.x < 0.3 && b.max.y - b.min.y < 0.3, "blur discs inside the frame footprint");
  let rmax = 0;
  for (const m of meshesOf(props.drone)) {
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 1) rmax = Math.max(rmax, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
  }
  assert.ok(rmax <= DRONE_BODY.radiusM, `every vertex inside the collision radius (${rmax})`);
  // the mana-crystal camera is the +y end: the most forward point on the centreline
  let best = { y: -Infinity, mesh: null };
  for (const m of meshesOf(props.drone)) {
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 1) if (Math.abs(p.getX(i)) < 0.02 && p.getY(i) > best.y) best = { y: p.getY(i), mesh: m.name };
  }
  assert.equal(best.mesh, "drone-glow", "the crystal tip leads on the centreline");
  assert.ok(best.y > 0.08, `camera at +y (${best.y})`);
  // tablet
  const frame = props.tablet.getObjectByName("tablet-frame");
  const screen = props.tablet.getObjectByName("tablet-screen");
  const fb = box(frame);
  near(fb.max.x - fb.min.x, 0.24, 1e-6);
  near(fb.max.y - fb.min.y, 0.16, 1e-6);
  near(fb.max.z - fb.min.z, 0.012, 1e-6);
  const sn = screen.geometry.attributes.normal;
  for (let i = 0; i < sn.count; i += 1) assert.deepEqual([sn.getX(i), sn.getY(i), sn.getZ(i)], [0, 0, 1], "screen faces +z");
  assert.ok(box(screen).min.z > fb.min.z + 0.008 - 1e-9, "the screen sits on the +z face");
  // goggles
  const gb = new THREE.Box3();
  for (const m of meshesOf(props.goggles)) gb.union(box(m));
  assert.ok(gb.max.x - gb.min.x <= 0.18 + 1e-6 && gb.max.y - gb.min.y <= 0.07 + 1e-6 && gb.max.z - gb.min.z <= 0.08 + 1e-6, "0.18 × 0.07 × 0.08");
  const lens = lensVertices(props);
  const lp = props.goggles.getObjectByName("goggles-body").geometry.attributes.position;
  assert.ok(lens.length >= 24, `the lens discs face local −y (head-local forward): ${lens.length} vertices`);
  assert.ok(lens.some((i) => lp.getX(i) < -0.02) && lens.some((i) => lp.getX(i) > 0.02), "two lens panels, left and right");
  props.dispose();
});

check("P2 goggles look (1070 V3): the two lens panels are dark tinted glass on the LIT metal material; the red REC pip is the goggles' only glow", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  const body = props.goggles.getObjectByName("goggles-body");
  const glow = props.goggles.getObjectByName("goggles-glow");
  assert.equal(body.material.isMeshStandardMaterial, true, "the lenses take the scene light (a faint sheen), never self-lit");
  assert.equal(glow.material.isMeshBasicMaterial, true);
  const uv = body.geometry.attributes.uv;
  const lens = lensVertices(props);
  assert.ok(lens.length >= 24);
  for (const i of lens) {
    const [r, g, b] = paletteRgb(body.material, uv.getX(i));
    assert.ok(Math.max(r, g, b) <= 48, `near-black glass, got rgb ${r},${g},${b}`);
    assert.ok(b >= r && g >= r, `a blue-green tint, got rgb ${r},${g},${b}`);
  }
  const gu = glow.geometry.attributes.uv;
  assert.ok(gu.count > 0 && gu.count <= 24, `the glow mesh is the REC pip box only (${gu.count} vertices)`);
  for (let i = 0; i < gu.count; i += 1) {
    const [r, g, b] = paletteRgb(glow.material, gu.getX(i));
    assert.ok(r >= 200 && g <= 60 && b <= 60, `the glow is the red REC pip, got rgb ${r},${g},${b}`);
  }
  props.dispose();
});

// ---------------------------------------------------------------------------
// P3 attach / setRig / setAnchors
// ---------------------------------------------------------------------------

check("P3 attach: parts 15 / 12 / 16 at the anchors, __attachedChildOf = guid (never __disposable), drone counter-scaled 1/rootScale", () => {
  const R = rigScene({ scale: 1.3 });
  const props = createProps({ THREE, scene: R.scene });
  assert.equal(props.attach("drone", "rightHand"), false, "no rig yet");
  props.setRig(R.rig);
  for (const [name, anchor, part] of [["drone", "rightHand", 15], ["tablet", "leftHand", 12], ["goggles", "head", 16]]) {
    assert.equal(props.attach(name, anchor), true, name);
    const root = props[name];
    assert.equal(root.parent, R.parts[part], `${name} on part ${part}`);
    assert.equal(root.userData.__attachedChildOf, GUID);
    assert.equal(root.userData.__disposable, undefined);
    assert.equal(props.where(name), "rig");
    assert.equal(root.visible, true);
    const a = DEFAULT_ANCHORS[ANCHOR_KEY[name]];
    assert.deepEqual(root.position.toArray(), a.pos);
    const n = Math.hypot(...a.quat);
    near(root.quaternion.w, a.quat[0] / n);
    near(root.quaternion.x, a.quat[1] / n);
    near(root.quaternion.y, a.quat[2] / n);
    near(root.quaternion.z, a.quat[3] / n);
    for (const o of nodes(root)) assert.equal(o.layers.mask, 2);
  }
  near(props.drone.scale.x, 1 / 1.3, 1e-12, "drone world size stays 1:1");
  assert.equal(props.drone.scale.y, props.drone.scale.x);
  assert.equal(props.tablet.scale.x, 1, "the tablet inherits the rig scale");
  assert.equal(props.goggles.scale.x, 1, "goggles anchor scale 1");
  // idempotent
  assert.equal(props.attach("drone", "rightHand"), true);
  assert.equal(R.parts[15].children.filter((c) => c === props.drone).length, 1);
  // default anchor
  props.remove("tablet");
  assert.equal(props.attach("tablet"), true);
  assert.equal(props.tablet.parent, R.parts[12]);
  props.dispose();
});

check("P3 attach refusals: no-hands profile, null profile, missing part, unknown name / anchor", () => {
  const R = rigScene();
  const props = createProps({ THREE, scene: R.scene });
  props.setRig({ ...R.rig, profile: NO_HANDS });
  assert.equal(props.attach("drone", "rightHand"), false);
  props.setRig({ ...R.rig, profile: null });
  assert.equal(props.attach("drone", "rightHand"), false);
  props.setRig({ ...R.rig, parts: R.parts.slice(0, 10) });
  assert.equal(props.attach("drone", "rightHand"), false, "part 15 missing");
  props.setRig(R.rig);
  assert.equal(props.attach("drone", "leftFoot"), false);
  assert.equal(props.attach("cape", "head"), false);
  assert.equal(props.where("drone"), "none");
  props.dispose();
});

check("P3 setRig: a rebuilt rig re-parents every rig prop to the same anchor part; no-hands / null removes", () => {
  const A = rigScene();
  const props = createProps({ THREE, scene: A.scene });
  props.setRig(A.rig);
  props.attach("drone", "rightHand");
  props.attach("goggles", "head");
  const B = rigScene({ scale: 2 });
  A.worldRoot.children[0].add(B.root); // the rebuilt rig joins the same scene
  props.setRig({ ...B.rig, rootScale: 2 });
  assert.equal(props.drone.parent, B.parts[15]);
  assert.equal(props.goggles.parent, B.parts[16]);
  near(props.drone.scale.x, 0.5, 1e-12, "counter-scale follows the new rig");
  assert.equal(props.where("drone"), "rig");
  props.setRig({ ...B.rig, profile: NO_HANDS });
  assert.equal(props.where("drone"), "none");
  assert.equal(props.drone.parent, null);
  props.setRig(B.rig);
  props.attach("tablet", "leftHand");
  props.setRig(null);
  assert.equal(props.where("tablet"), "none");
  assert.equal(props.tablet.userData.__attachedChildOf, undefined);
  props.dispose();
});

check("P3 setAnchors: replaces the offsets (validated, quats normalised) and re-applies them to rig props", () => {
  const R = rigScene();
  const props = createProps({ THREE, scene: R.scene });
  props.setRig(R.rig);
  props.attach("goggles", "head");
  props.attach("tablet", "leftHand");
  props.setAnchors({
    goggles: { pos: [0.01, -0.12, 0.09], quat: [2, 0, 0, 0], scale: 1.25 },
    tablet: { pos: [NaN, 0, 0], quat: [0, 0, 0, 0] }, // invalid → defaults
    clipMode: "timer",
  });
  assert.deepEqual(props.goggles.position.toArray(), [0.01, -0.12, 0.09]);
  assert.deepEqual(props.goggles.quaternion.toArray(), [0, 0, 0, 1], "normalised");
  assert.equal(props.goggles.scale.x, 1.25);
  assert.deepEqual(props.tablet.position.toArray(), DEFAULT_ANCHORS.tablet.pos);
  props.dispose();
});

// ---------------------------------------------------------------------------
// P4 toWorld / place / remove / where / worldPos / setDronePose
// ---------------------------------------------------------------------------

check("P4 toWorld under a worldRoot-like rig: AC x/y kept (1e-6), z = groundZ + 0.06, level yaw, scale 1, off the rig", () => {
  const R = rigScene({ pos: [12345.25, 23456.5, 37.2], yaw: 2.1, scale: 1.4 });
  const props = createProps({ THREE, scene: R.scene });
  props.setRig(R.rig);
  props.attach("drone", "rightHand");
  const want = acOfPartPoint(R.worldRoot, R.parts[15], DEFAULT_ANCHORS.droneInHand.pos);
  const inHand = props.worldPos("drone");
  for (let i = 0; i < 3; i += 1) near(inHand[i], want[i], 1e-6, `worldPos on the rig [${i}]`);
  const yaw = 1.2;
  const r = props.toWorld("drone", 36.5, yaw);
  assert.equal(r.ok, true);
  near(r.pos[0], want[0], 1e-6, "AC x kept");
  near(r.pos[1], want[1], 1e-6, "AC y kept");
  assert.equal(r.pos[2], 36.5 + DRONE_BODY.restHeightM);
  assert.equal(props.drone.parent, props.group);
  assert.equal(props.drone.userData.__attachedChildOf, undefined);
  assert.deepEqual(props.drone.scale.toArray(), [1, 1, 1]);
  near(props.drone.quaternion.w, Math.cos(-yaw / 2), 1e-12);
  near(props.drone.quaternion.z, Math.sin(-yaw / 2), 1e-12);
  assert.equal(props.drone.quaternion.x, 0);
  assert.equal(props.drone.quaternion.y, 0);
  assert.equal(props.where("drone"), "world");
  const back = props.worldPos("drone", [0, 0, 0]);
  for (let i = 0; i < 3; i += 1) near(back[i], r.pos[i], 1e-6, "worldPos == the snapped position");
  // the snapped forward axis is the compass heading: forward(h) = (sin h, cos h)
  const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(props.drone.quaternion);
  near(fwd.x, Math.sin(yaw), 1e-9);
  near(fwd.y, Math.cos(yaw), 1e-9);
  const r2 = props.toWorld("drone", 36.5, yaw);
  assert.notEqual(r2.pos, r.pos, "a fresh array");
  // the tablet snaps to groundZ itself
  props.attach("tablet", "leftHand");
  assert.equal(props.toWorld("tablet", 36.5, 0).pos[2], 36.5);
  props.dispose();
});

check("P4 droneInHand anchor (R4-03): at the place release (real fixture, real clip order: Pickup source frame 18) the drone is level in the hand and toWorld's level pilot-facing snap turns it < 0.1° at any heading / rig scale (the old 90°-about-x grip turned it 58°)", () => {
  const spec = GESTURE_CLIPS.place;
  const anim = ANIMS[animKey(spec.anim)];
  const clip = buildClip({ numFrames: anim.numFrames, numParts: anim.numParts, frames: anim.frames }, spec.plan);
  const src = clip.sourceFrames[spec.eventAtFrame];
  assert.equal(src, 18, "the release is Pickup source frame 18");
  const dropAt = (compass, scale, anchors) => {
    const R = rigScene({ pos: [100, 200, 10], yaw: -compass, scale }); // AC quat of compass h = Rz(−h)
    const f = anim.frames;
    for (let i = 0; i < R.parts.length; i += 1) {
      const b = (src * anim.numParts + i) * 7; // [x, y, z, qw, qx, qy, qz]
      R.parts[i].position.set(f[b], f[b + 1], f[b + 2]);
      R.parts[i].quaternion.set(f[b + 4], f[b + 5], f[b + 6], f[b + 3]).normalize();
    }
    const props = createProps({ THREE, scene: R.scene, anchors });
    props.setRig(R.rig);
    assert.equal(props.attach("drone", "rightHand"), true);
    const qw = new THREE.Quaternion();
    props.drone.getWorldQuaternion(qw);
    const qr = new THREE.Quaternion();
    R.worldRoot.getWorldQuaternion(qr);
    const inHand = qr.invert().multiply(qw); // AC world = droneGroup's frame
    const up = new THREE.Vector3(0, 0, 1).applyQuaternion(inHand);
    assert.equal(props.toWorld("drone", 9.5, compass + Math.PI).ok, true); // index.js dropYaw, launchFacing 'pilot'
    const snapDeg = (inHand.angleTo(props.drone.quaternion) * 180) / Math.PI;
    props.dispose();
    return { snapDeg, tiltDeg: (Math.acos(Math.min(1, up.z)) * 180) / Math.PI };
  };
  for (const compass of [0, 0.9, -2.4]) {
    for (const scale of [1, 1.3]) {
      const d = dropAt(compass, scale, undefined);
      assert.ok(d.tiltDeg < 0.1, `compass ${compass} scale ${scale}: level in the hand (${d.tiltDeg.toFixed(3)}°)`);
      assert.ok(d.snapDeg < 0.1, `compass ${compass} scale ${scale}: no snap at the drop (${d.snapDeg.toFixed(3)}°)`);
    }
  }
  const old = dropAt(0.9, 1, { droneInHand: { quat: [0.707107, 0.707107, 0, 0] } });
  assert.ok(old.snapDeg > 50, `negative control: the old anchor snapped ${old.snapDeg.toFixed(1)}°`);
});

check("P4 toWorld refusals: not placed, non-finite groundZ / yaw, unknown name → {ok:false, pos:null}", () => {
  const R = rigScene();
  const props = createProps({ THREE, scene: R.scene });
  assert.deepEqual(props.toWorld("drone", 0, 0), { ok: false, pos: null });
  props.setRig(R.rig);
  props.attach("drone", "rightHand");
  assert.deepEqual(props.toWorld("drone", NaN, 0), { ok: false, pos: null });
  assert.deepEqual(props.toWorld("drone", null, 0), { ok: false, pos: null });
  assert.deepEqual(props.toWorld("drone", 1, undefined), { ok: false, pos: null });
  assert.deepEqual(props.toWorld("cape", 1, 0), { ok: false, pos: null });
  assert.equal(props.where("drone"), "rig", "a refused toWorld changes nothing");
  props.dispose();
});

check("P4 place / remove / where / worldPos / setDronePose", () => {
  const R = rigScene();
  const props = createProps({ THREE, scene: R.scene });
  assert.equal(props.setDronePose([1, 2, 3], [1, 0, 0, 0]), false, "not in the world");
  assert.equal(props.worldPos("drone"), null);
  assert.equal(props.place("drone", [500, 600, 70.06], 0.5), true);
  assert.equal(props.where("drone"), "world");
  assert.equal(props.drone.parent, props.group);
  assert.equal(props.drone.visible, true);
  assert.deepEqual(props.worldPos("drone").map((v) => +v.toFixed(9)), [500, 600, 70.06]);
  assert.equal(props.place("drone", [NaN, 0, 0], 0), false);
  assert.equal(props.place("drone", [1, 2, 3], NaN), false);
  assert.equal(props.setDronePose([510, 605, 75], [Math.cos(0.2), 0.1, 0, Math.sin(0.2)]), true);
  const q = [Math.cos(0.2), 0.1, 0, Math.sin(0.2)];
  const n = Math.hypot(...q);
  near(props.drone.quaternion.w, q[0] / n);
  near(props.drone.quaternion.x, q[1] / n, 1e-9, "three field order (x, y, z, w) from [w, x, y, z]");
  near(props.drone.quaternion.z, q[3] / n);
  const out = [9, 9, 9];
  assert.equal(props.worldPos("drone", out), out, "writes into the caller's array");
  assert.deepEqual(out.map((v) => +v.toFixed(9)), [510, 605, 75]);
  assert.equal(props.setDronePose([1, 2, Infinity], q), false);
  assert.equal(props.setDronePose([1, 2, 3], [NaN, 0, 0, 0]), false);
  assert.equal(props.setDronePose([1, 2, 3], [0, 0, 0, 0]), false);
  assert.equal(props.remove("drone"), true);
  assert.equal(props.where("drone"), "none");
  assert.equal(props.drone.parent, null);
  assert.equal(props.drone.visible, false);
  assert.equal(props.worldPos("drone"), null);
  assert.equal(props.remove("cape"), false);
  assert.equal(props.where("cape"), "none");
  // place takes a prop off the rig too
  props.setRig(R.rig);
  props.attach("goggles", "head");
  assert.equal(props.place("goggles", [1, 2, 3], 0), true);
  assert.equal(props.goggles.parent, props.group);
  assert.equal(props.goggles.userData.__attachedChildOf, undefined);
  props.dispose();
});

// ---------------------------------------------------------------------------
// P5 setRotor / blob / setVisible / setScreen
// ---------------------------------------------------------------------------

check("P5 setRotor: two-blade rotors at or below spin 0.3, translucent blur discs above; blades spin up on the CPU", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  props.place("drone", [0, 0, 0.06], 0);
  const blur = props.drone.getObjectByName("drone-blur");
  const body = props.drone.getObjectByName("drone-body");
  const pos = body.geometry.attributes.position;
  props.setRotor(0, 0);
  assert.equal(blur.visible, false);
  const v0 = pos.version;
  props.setRotor(0, 0.016);
  assert.equal(pos.version, v0, "stopped rotors write nothing");
  props.setRotor(0.2, 0.032);
  assert.ok(pos.version > v0, "slow rotors turn (blade vertices rewritten)");
  assert.equal(pos.updateRanges.length, 0, "no addUpdateRange (it allocates an object per call)");
  props.setRotor(0.3, 0.048);
  assert.equal(blur.visible, false, "exactly 0.3: still blades");
  props.setRotor(0.31, 0.064);
  assert.equal(blur.visible, true, "above 0.3: blur discs");
  const map = blur.material.map;
  const r0 = map.rotation;
  props.setRotor(1.2, 0.08);
  assert.notEqual(map.rotation, r0, "the blur shimmer is a uv rotation (a uniform), not a new map");
  props.setRotor(0.25, 0.096);
  assert.equal(blur.visible, false, "back to blades");
  props.setRotor(NaN, NaN);
  assert.equal(blur.visible, false, "non-finite spin = 0");
  props.dispose();
});

check("P5 blur discs (1070 V2): a translucent neutral-grey smoke — grey texels; alpha × opacity peaks at 0.2–0.35 in the outer band at every blur spin, about half that toward an empty hub, faded out by the octagon's edge midpoints", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  props.place("drone", [0, 0, 0.06], 0);
  const blur = props.drone.getObjectByName("drone-blur");
  const m = blur.material;
  assert.equal(m.transparent, true);
  assert.equal(m.depthWrite, false);
  const img = m.map.image;
  const n = img.width;
  const px = img.data;
  for (let i = 0; i < n * n; i += 1) {
    const o = i * 4;
    assert.ok(px[o] === px[o + 1] && px[o + 1] === px[o + 2], `neutral grey texels (r = g = b), got ${px[o]},${px[o + 1]},${px[o + 2]}`);
    assert.ok(px[o] <= 0x80, `a mid grey, never cream / white (${px[o]})`);
  }
  // texture alpha over a band of disc radii (uv centre 0.5, rim at radius 1)
  const band = (r0, r1) => {
    let sum = 0;
    let k = 0;
    let peak = 0;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const r = Math.hypot(((x + 0.5) / n) * 2 - 1, ((y + 0.5) / n) * 2 - 1);
        if (r < r0 || r >= r1) continue;
        const a = px[(y * n + x) * 4 + 3] / 255;
        sum += a;
        k += 1;
        peak = Math.max(peak, a);
      }
    }
    return { mean: sum / k, peak };
  };
  const outer = band(0.6, 0.8);
  const inner = band(0.25, 0.4);
  const peakA = band(0, 2).peak;
  assert.equal(band(0, 0.1).peak, 0, "an empty hub");
  assert.ok(inner.mean < 0.6 * outer.mean, `fainter toward the hub (${inner.mean.toFixed(3)} vs ${outer.mean.toFixed(3)})`);
  // the disc is an octagon: its edge midpoints sit at r = cos 22.5°, and the smoke must be gone there (it reads round)
  const rMid = Math.cos(Math.PI / 8);
  for (let k = 0; k < 64; k += 1) {
    const th = (k / 64) * 2 * Math.PI;
    const x = Math.min(n - 1, Math.floor((0.5 + 0.5 * rMid * Math.cos(th)) * n));
    const y = Math.min(n - 1, Math.floor((0.5 + 0.5 * rMid * Math.sin(th)) * n));
    assert.ok(px[(y * n + x) * 4 + 3] / 255 <= 0.05, `no octagon edge at ${th.toFixed(2)} rad`);
  }
  let t = 0;
  for (const spin of [0.31, 0.5, 1, 1.5, 2.5]) {
    props.setRotor(spin, (t += 0.02));
    assert.equal(blur.visible, true);
    assert.ok(peakA * m.opacity <= 0.35 + 1e-9, `spin ${spin}: peak alpha ${(peakA * m.opacity).toFixed(3)} ≤ 0.35`);
    assert.ok(outer.peak * m.opacity >= 0.2, `spin ${spin}: the outer band still reads (${(outer.peak * m.opacity).toFixed(3)})`);
  }
  props.dispose();
});

check("P5 setRotor: the rear red LED blinks at 1 Hz (only its uvs change), steady otherwise", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  props.place("drone", [0, 0, 0.06], 0);
  const uv = props.drone.getObjectByName("drone-glow").geometry.attributes.uv;
  const snap = () => Array.from(uv.array);
  props.setRotor(0.35, 10.25);
  const on = snap();
  props.setRotor(0.35, 10.4);
  assert.deepEqual(snap(), on, "still on");
  props.setRotor(0.35, 10.75);
  const off = snap();
  assert.notDeepEqual(off, on, "off in the second half-second");
  const changed = on.filter((v, i) => v !== off[i]).length;
  assert.ok(changed > 0 && changed <= 48, `only the rear LED vertices change (${changed} uv values)`);
  props.setRotor(0.35, 11.2);
  assert.deepEqual(snap(), on, "on again a second later");
  props.dispose();
});

check("P5 blob shadow: on the ground at groundZ + 0.03, opacity ∝ max(0, 1 − AGL/3), hidden in the hand / hidden drone / high up", () => {
  const R = rigScene();
  const props = createProps({ THREE, scene: R.scene });
  const blob = blobOf(props);
  props.setRig(R.rig);
  props.attach("drone", "rightHand");
  props.setRotor(0, 0);
  assert.equal(blob.visible, false, "no blob in the hand");
  props.toWorld("drone", 20, 0);
  props.setRotor(0.35, 0.1);
  assert.equal(blob.visible, true);
  near(blob.position.z, 20 + 0.03, 1e-9, "lifted 0.03 m (no polygonOffset)");
  near(blob.position.x, props.drone.position.x, 1e-9);
  near(blob.material.opacity, 0.55 * (1 - 0.06 / 3), 1e-9, "almost full at rest (AGL = z − groundZ = 0.06)");
  props.setDronePose([props.drone.position.x, props.drone.position.y, 20 + 1.5], [1, 0, 0, 0]);
  props.setGround(20);
  props.setRotor(1, 0.2);
  near(blob.material.opacity, 0.55 * 0.5, 1e-9, "half at 1.5 m AGL");
  props.setGround(null); // keeps the last
  props.setRotor(1, 0.3);
  near(blob.material.opacity, 0.55 * 0.5, 1e-9);
  props.setGround(19);
  props.setRotor(1, 0.35);
  near(blob.material.opacity, 0.55 * (1 - 2.5 / 3), 1e-9, "a lower ground → more AGL");
  props.setDronePose([0, 0, 19 + 3.2], [1, 0, 0, 0]);
  props.setRotor(1, 0.4);
  assert.equal(blob.visible, false, "above 3 m AGL");
  props.setDronePose([0, 0, 19.5], [1, 0, 0, 0]);
  props.setRotor(1, 0.5);
  assert.equal(blob.visible, true);
  props.setVisible("drone", false);
  assert.equal(props.drone.visible, false);
  assert.equal(blob.visible, false, "the driver hides the drone (and its blob) while the camera is owned");
  assert.equal(props.where("drone"), "world", "render visibility only");
  props.setVisible("drone", true);
  assert.equal(props.drone.visible, true);
  props.remove("drone");
  assert.equal(blob.visible, false);
  props.dispose();
});

check("P5 setScreen: false without a canvas (node: 1×1 DataTexture); draws on an injected canvas and flags the upload", () => {
  const plain = createProps({ THREE, scene: new THREE.Scene() });
  const sm = plain.tablet.getObjectByName("tablet-screen").material;
  assert.ok(sm.map.isDataTexture, "the node screen is a 1×1 DataTexture");
  assert.equal(sm.map.image.width, 1);
  assert.equal(plain.setScreen({ signal: 1, battery: 0.5, homeBearingRad: 0, distM: 10, live: true }), false);
  plain.dispose();
  assert.equal(createProps({ THREE, scene: new THREE.Scene(), createCanvas: () => null }).setScreen({}), false);
  const ops = [];
  const state = {};
  const ctx = new Proxy(state, {
    get(t, k) { return k in t ? t[k] : (...a) => { ops.push([k, ...a]); }; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = { width: 300, height: 150, getContext: (kind) => (kind === "2d" ? ctx : null) };
  const props = createProps({ THREE, scene: new THREE.Scene(), createCanvas: (w, h) => { assert.deepEqual([w, h], [256, 160]); return canvas; } });
  assert.deepEqual([canvas.width, canvas.height], [256, 160]);
  const map = props.tablet.getObjectByName("tablet-screen").material.map;
  assert.ok(map.isCanvasTexture);
  assert.equal(map.image, canvas);
  assert.equal(map.generateMipmaps, false, "no mipmap rebuild on every 4 Hz redraw");
  assert.ok(ops.some((o) => o[0] === "fillText" && o[1] === "NO LINK"), "a first frame is drawn at build");
  const v0 = map.version;
  ops.length = 0;
  assert.equal(props.setScreen({ signal: 0.8, battery: 0.87, homeBearingRad: 1.2, distM: 1234, live: true }), true);
  assert.ok(map.version > v0, "needsUpdate");
  const texts = ops.filter((o) => o[0] === "fillText").map((o) => o[1]);
  assert.ok(texts.includes("LIVE") && texts.includes("87%") && texts.includes("1.23 km") && texts.includes("HOME"), texts.join("|"));
  assert.ok(ops.some((o) => o[0] === "rotate" && o[1] === 1.2), "home arrow at the compass bearing");
  ops.length = 0;
  assert.equal(props.setScreen({ signal: null, battery: null, homeBearingRad: NaN, distM: undefined, live: false }), true);
  const texts2 = ops.filter((o) => o[0] === "fillText").map((o) => o[1]);
  assert.ok(texts2.includes("NO LINK") && texts2.includes("--%") && texts2.includes("--"), texts2.join("|"));
  assert.ok(!ops.some((o) => o[0] === "rotate"), "no arrow without a bearing");
  props.dispose();
  assert.equal(props.setScreen({}), false, "after dispose");
});

/** A recording 2D context (fillText strings) on a fake 256×160 canvas. */
function fakeCanvas() {
  const ops = [];
  const state = {};
  const ctx = new Proxy(state, {
    get(t, k) { return k in t ? t[k] : (...a) => { ops.push([k, ...a]); }; },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ops, canvas: { width: 256, height: 160, getContext: (kind) => (kind === "2d" ? ctx : null) } };
}

check("P5 setScreen: the numeric texts are rebuilt only when the shown value changes (SPEC §5, 4 Hz); every call still redraws", () => {
  const { ops, canvas } = fakeCanvas();
  const props = createProps({ THREE, scene: new THREE.Scene(), createCanvas: () => canvas });
  const map = props.tablet.getObjectByName("tablet-screen").material.map;
  const texts = () => ops.filter((o) => o[0] === "fillText").map((o) => o[1]);
  const st = { signal: 0.8, battery: 0.874, homeBearingRad: 0.3, distM: 1234, live: true };
  ops.length = 0;
  props.setScreen(st);
  assert.ok(texts().includes("87%") && texts().includes("1.23 km"), texts().join("|"));
  // hovering: the same shown values → no number formatting at all
  const toFixed = Number.prototype.toFixed;
  let formats = 0;
  Number.prototype.toFixed = function (...a) { formats += 1; return toFixed.apply(this, a); };
  try {
    for (let i = 0; i < 20; i += 1) {
      const v0 = map.version;
      st.distM = 1231 + (i % 3); // 1231..1233 m: still "1.23 km"
      st.battery = 0.872 + (i % 2) * 0.001; // 87.2 / 87.3: still "87%"
      ops.length = 0;
      assert.equal(props.setScreen(st), true);
      assert.ok(map.version > v0, "every call redraws and flags the upload");
      assert.ok(texts().includes("87%") && texts().includes("1.23 km"));
    }
  } finally {
    Number.prototype.toFixed = toFixed;
  }
  assert.equal(formats, 0, "no km text rebuilt while the shown value is unchanged");
  // the texts follow every shown change
  for (const [patch, want] of [
    [{ distM: 1244.9 }, "1.24 km"], [{ battery: 0.876 }, "88%"], [{ distM: 999.4 }, "999 m"], [{ distM: 999.6 }, "1000 m"],
    [{ distM: 12.4 }, "12 m"], [{ distM: 12.6 }, "13 m"], [{ distM: 0 }, "0 m"], [{ battery: 0 }, "0%"],
    [{ distM: null }, "--"], [{ battery: null }, "--%"], [{ distM: 150 }, "150 m"], [{ battery: 1 }, "100%"],
  ]) {
    Object.assign(st, patch);
    ops.length = 0;
    props.setScreen(st);
    assert.ok(texts().includes(want), `${JSON.stringify(patch)} → ${want} (${texts().join("|")})`);
  }
  props.dispose();
});

// ---------------------------------------------------------------------------
// P6 fadeOut / dispose
// ---------------------------------------------------------------------------

check("P6 fadeOut: removed after delay + duration of setRotor time; a scale-out with no material swap or program change", () => {
  const props = createProps({ THREE, scene: new THREE.Scene() });
  assert.equal(props.fadeOut("drone", { delaySec: 5, durationSec: 1, now: 0 }), false, "nothing to fade at 'none'");
  props.place("drone", [10, 20, 30.06], 0);
  const meshes = [...meshesOf(props.drone), blobOf(props)];
  const before = meshes.map((m) => [m.material, programFields(m.material)]);
  const blob = blobOf(props);
  props.setRotor(0, 100);
  assert.equal(props.fadeOut("drone", { delaySec: 5, durationSec: 1, now: 100 }), true);
  assert.equal(props.fading("drone"), true);
  props.setRotor(0, 104.9);
  assert.equal(props.drone.scale.x, 1, "still waiting out the delay");
  props.setRotor(0, 105.5);
  assert.equal(props.where("drone"), "world");
  assert.ok(props.drone.scale.x < 1 && props.drone.scale.x > 0, `shrinking (${props.drone.scale.x})`);
  near(props.drone.position.z, 30.06 - 0.06 * (1 - props.drone.scale.x), 1e-9, "toward the feet");
  assert.ok(blob.material.opacity < 0.55, "the blob fades with it");
  meshes.forEach((m, i) => {
    assert.equal(m.material, before[i][0], `${m.name}: no material swap`);
    assert.equal(programFields(m.material), before[i][1], `${m.name}: no program-relevant change`);
  });
  props.setRotor(0, 106.0);
  assert.equal(props.where("drone"), "none", "removed at delay + duration");
  assert.equal(props.fading("drone"), false);
  assert.equal(props.drone.visible, false);
  meshes.forEach((m, i) => assert.equal(programFields(m.material), before[i][1]));
  // re-placing restores the full size; remove() cancels a pending fade
  props.place("drone", [0, 0, 0.06], 0);
  assert.equal(props.drone.scale.x, 1);
  props.fadeOut("drone", { now: 200 });
  assert.equal(props.fading("drone"), true);
  props.remove("drone");
  assert.equal(props.fading("drone"), false);
  props.place("drone", [0, 0, 0.06], 0);
  props.setRotor(0, 300);
  assert.equal(props.where("drone"), "world", "the cancelled fade never fires");
  // defaults: delay 0, duration 1
  props.fadeOut("drone", { now: 300 });
  props.setRotor(0, 300.999);
  assert.equal(props.where("drone"), "world");
  props.setRotor(0, 301);
  assert.equal(props.where("drone"), "none");
  props.dispose();
});

check("P6 no program-key change at runtime: across every member each mesh keeps its material, and each material its version, map and program fields", () => {
  const R = rigScene();
  const { canvas } = fakeCanvas();
  const props = createProps({ THREE, scene: R.scene, createCanvas: () => canvas });
  const meshes = allNodes(props).filter((o) => o.isMesh);
  const snap = () => meshes.map((m) => [m, m.material, m.material.version, m.material.map, programFields(m.material)]);
  const before = snap();
  // compared after EVERY step: a field flipped and flipped back still counts
  const same = (step) => {
    const now = snap();
    before.forEach((b, i) => {
      const a = now[i];
      assert.equal(a[1], b[1], `${step}: ${b[0].name} keeps its material object`);
      assert.equal(a[2], b[2], `${step}: ${b[0].name} material.version unchanged (no needsUpdate → no program re-check)`);
      assert.equal(a[3], b[3], `${step}: ${b[0].name} keeps its map`);
      assert.equal(a[4], b[4], `${step}: ${b[0].name} program-relevant fields unchanged`);
    });
  };
  // the whole runtime surface, in deploy → fly → stow order
  props.setRig(R.rig);
  same("setRig");
  for (const n of PROP_NAMES) { props.attach(n, ANCHOR_OF[n]); same(`attach ${n}`); }
  props.setAnchors({ goggles: { pos: [0, -0.11, 0.09], quat: [1, 0, 0, 0], scale: 1.2 } });
  same("setAnchors");
  for (let i = 0; i < 4; i += 1) {
    props.setScreen({ signal: 1 - i / 4, battery: 0.5, homeBearingRad: i, distM: 10 * i, live: i > 1 });
    same("setScreen");
  }
  props.toWorld("drone", 20, 0.4);
  same("toWorld");
  let t = 50;
  for (const spin of [0, 0.1, 0.2, 0.3, 0.31, 0.8, 1.6, 2.5, 3, 0.25, 0]) {
    for (let k = 0; k < 40; k += 1) { // 40 × 1/30 s: crosses the 1 Hz LED edges
      t += 1 / 30;
      props.setDronePose([props.drone.position.x, props.drone.position.y, 20.06 + spin], [Math.cos(t), 0, 0, Math.sin(t)]);
      props.setGround(k % 7 === 0 ? null : 20);
      props.setRotor(spin, t);
      if (k % 10 === 0) same(`setRotor ${spin}`);
    }
  }
  props.setVisible("drone", false);
  same("setVisible off");
  props.setRotor(1, (t += 0.1));
  props.setVisible("drone", true);
  same("setVisible on");
  props.remove("tablet");
  props.place("tablet", [1, 2, 3], 0);
  same("remove / place");
  props.fadeOut("drone", { delaySec: 0.5, durationSec: 1, now: t });
  for (let k = 0; k < 60; k += 1) {
    props.setRotor(0.35, (t += 1 / 30));
    if (k % 5 === 0) same("fade");
  }
  assert.equal(props.where("drone"), "none", "the fade ran to completion");
  props.place("drone", [5, 6, 7.06], 1);
  props.setRotor(0.5, (t += 0.5));
  same("place again");
  props.dispose();
});

check("P6 dispose: disposes exactly the created geometries / materials / textures once, removes droneGroup and the rig props; idempotent", () => {
  const R = rigScene();
  const props = createProps({ THREE, scene: R.scene });
  props.setRig(R.rig);
  props.attach("tablet", "leftHand");
  props.attach("goggles", "head");
  props.place("drone", [0, 0, 0.06], 0);
  const found = { geometries: new Set(), materials: new Set(), textures: new Set() };
  for (const o of allNodes(props)) {
    if (!o.isMesh) continue;
    found.geometries.add(o.geometry);
    found.materials.add(o.material);
    if (o.material.map) found.textures.add(o.material.map);
  }
  const counts = new Map();
  for (const set of Object.values(found)) {
    for (const r of set) { counts.set(r, 0); r.addEventListener("dispose", () => counts.set(r, counts.get(r) + 1)); }
  }
  const r = props.dispose();
  assert.equal(r.ok, true);
  assert.deepEqual(r.disposed, { geometries: found.geometries.size, materials: found.materials.size, textures: found.textures.size });
  assert.deepEqual(r.disposed, { geometries: 8, materials: 5, textures: 4 });
  for (const [res, n] of counts) assert.equal(n, 1, `${res.name || res.type} disposed exactly once`);
  assert.equal(props.group.parent, null, "droneGroup left the scene");
  assert.ok(!R.parts[12].children.includes(props.tablet) && !R.parts[16].children.includes(props.goggles), "detached from the rig");
  assert.equal(props.stats().built, false);
  const r2 = props.dispose();
  assert.deepEqual(r2, { ok: true, disposed: { geometries: 0, materials: 0, textures: 0 } });
  for (const [, n] of counts) assert.equal(n, 1, "the second dispose disposes nothing");
  // inert afterwards, never throws
  assert.equal(props.attach("drone", "rightHand"), false);
  assert.equal(props.place("drone", [0, 0, 0], 0), false);
  assert.equal(props.where("drone"), "none");
  assert.doesNotThrow(() => { props.setRotor(1, 1); props.setGround(1); props.setVisible("drone", true); props.setRig(R.rig); props.setAnchors({}); });
  assert.deepEqual(JSON.parse(JSON.stringify(props.stats())), props.stats());
});

// ---------------------------------------------------------------------------
// P7 prewarm
// ---------------------------------------------------------------------------

check("P7 prewarm: HalfFloat 1×1 target bound around compile, previous target restored, target disposed; {ok, compiled > 0}", async () => {
  _resetPrewarmForTest();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const r = fakeRenderer();
  const res = await prewarm({ THREE, renderer: r, scene, camera });
  assert.equal(res.ok, true);
  assert.equal(res.compiled, 6, "the five prop materials and the lens-overlay twin");
  assert.ok(Number.isFinite(res.ms) && res.ms >= 0);
  assert.equal(r.compiles.length, 2, "the prop set, then the overlay twin");
  const c = r.compiles[0];
  assert.equal(c.camera, camera);
  assert.equal(c.scene, scene, "compiled against the live scene (its lights and fog)");
  assert.ok(c.target && c.target.isWebGLRenderTarget, "a render target is bound during compile");
  assert.equal(c.target.texture.type, THREE.HalfFloatType);
  assert.deepEqual([c.target.width, c.target.height], [1, 1]);
  assert.equal(c.target.depthBuffer, false);
  assert.equal(c.target.stencilBuffer, false);
  assert.equal(r._target, r.prev, "the previous target is restored");
  assert.deepEqual(r.events.map((e) => e[0]), ["setRenderTarget", "compile", "setRenderTarget", "setRenderTarget", "compile", "setRenderTarget"]);
  assert.equal(r.events[2][1], r.prev, "restored right after the prop compile");
  assert.equal(r.events[3][1], null, "the twin binds the canvas target only after the HalfFloat compile is over");
  assert.equal(r.events[5][1], r.prev, "and the previous target is restored again");
  let targetDisposed = false;
  // the target was disposed right after compile: a second dispose event would be a no-op, so check via a fresh listener-free probe
  c.target.addEventListener("dispose", () => { targetDisposed = true; });
  c.target.dispose();
  assert.equal(targetDisposed, true);
  assert.equal(c.root.parent, null, "the proxies never join a scene");
});

check("P7 prewarm: memoised per renderer, proxies kept alive (never disposed), ready-poll waits, a vanished program counts as done", async () => {
  _resetPrewarmForTest();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const r = fakeRenderer();
  r.ready = false;
  const p1 = prewarm({ THREE, renderer: r, scene, camera });
  const p2 = prewarm({ THREE, renderer: r, scene, camera });
  assert.equal(p2, p1, "a second call returns the first promise");
  let settled = false;
  p1.then(() => { settled = true; });
  await sleep(35);
  assert.equal(settled, false, "waits for isReady()");
  assert.ok(r.isReadyCalls >= 10, "polls every 10 ms");
  const disposedMats = [];
  for (const c of r.compiles) for (const m of c.materials) m.addEventListener("dispose", () => disposedMats.push(m));
  r.ready = true;
  const res = await p1;
  assert.equal(res.ok, true);
  assert.equal(r.compiles.length, 2, "compiled once (the prop set + the overlay twin)");
  await sleep(20);
  assert.equal(disposedMats.length, 0, "the proxy materials stay alive (their programs stay referenced)");
  const other = fakeRenderer({ vanish: true });
  const p3 = prewarm({ THREE, renderer: other, scene, camera });
  assert.notEqual(p3, p1, "per renderer");
  assert.equal((await p3).ok, true, "a vanished program counts as done");
  _resetPrewarmForTest();
  assert.notEqual(prewarm({ THREE, renderer: r, scene, camera }), p1, "the test reset forgets the memo");
});

check("P7 prewarm never rejects: no renderer / compile / THREE / camera / scene, a throwing prop or twin compile; offscreen:false binds no HalfFloat target", async () => {
  _resetPrewarmForTest();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  for (const deps of [undefined, null, {}, { THREE, scene, camera }, { THREE, renderer: {}, scene, camera }]) {
    const r = await prewarm(deps);
    assert.deepEqual({ ok: r.ok, compiled: r.compiled, ms: r.ms }, { ok: false, compiled: 0, ms: 0 });
    assert.equal(typeof r.reason, "string");
  }
  assert.equal((await prewarm({ renderer: fakeRenderer(), scene, camera })).ok, false, "no THREE");
  assert.equal((await prewarm({ THREE, renderer: fakeRenderer(), scene })).ok, false, "no camera");
  assert.equal((await prewarm({ THREE, renderer: fakeRenderer(), camera })).ok, false, "no scene");
  const bad = fakeRenderer({ throwCompile: true });
  const rb = await prewarm({ THREE, renderer: bad, scene, camera });
  assert.equal(rb.ok, false);
  assert.match(rb.reason, /context lost/);
  assert.equal(bad._target, bad.prev, "the previous target is restored even when compile throws");
  const badTwin = fakeRenderer({ throwAt: 1 });
  const rt = await prewarm({ THREE, renderer: badTwin, scene, camera });
  assert.equal(rt.ok, false);
  assert.match(rt.reason, /context lost/);
  assert.equal(badTwin._target, badTwin.prev, "a throwing overlay-twin compile still restores the previous target");
  const canvasOnly = fakeRenderer();
  const rc = await prewarm({ THREE, renderer: canvasOnly, scene, camera, offscreen: false });
  assert.equal(rc.ok, true);
  assert.deepEqual(canvasOnly.events.map((e) => e[0]), ["compile", "setRenderTarget", "compile", "setRenderTarget"],
    "the wireframe (no composer) path compiles the prop set for the current target, then the twin for the canvas");
  assert.equal(canvasOnly.compiles[0].target, canvasOnly.prev);
  assert.equal(canvasOnly.compiles[1].target, null);
  assert.equal(canvasOnly._target, canvasOnly.prev);
});

check("P7 the prewarm material set has the same program-relevant fields as the createProps materials", async () => {
  _resetPrewarmForTest();
  const scene = new THREE.Scene();
  const r = fakeRenderer();
  await prewarm({ THREE, renderer: r, scene, camera: new THREE.PerspectiveCamera() });
  const warm = r.compiles[0].materials.map(programFields).sort();
  const props = createProps({ THREE, scene });
  const live = new Set();
  for (const o of allNodes(props)) if (o.isMesh) live.add(o.material);
  const liveFields = [...live].map(programFields).sort();
  assert.deepEqual(warm, liveFields);
  // and the proxy geometry carries the same attribute set (vertexNormals / uv are program bits in r184)
  const proxyGeom = r.compiles[0].root.children[0].geometry;
  assert.deepEqual(Object.keys(proxyGeom.attributes).sort(), ["normal", "position", "uv"]);
  props.dispose();
  _resetPrewarmForTest();
});

check("P7 prewarm R2-2: the lens-overlay twin — one MeshBasic {map, transparent, DoubleSide two-pass, depthTest / depthWrite / fog / toneMapped off} plane, compiled with the null target against its own EMPTY Scene (never the lit, fogged live scene)", async () => {
  _resetPrewarmForTest();
  const scene = litFoggedScene();
  const camera = new THREE.PerspectiveCamera();
  const r = fakeRenderer();
  assert.equal((await prewarm({ THREE, renderer: r, scene, camera })).ok, true);
  const tw = r.compiles[1];
  assert.equal(tw.target, null, "the canvas variant: the overlay draws with setRenderTarget(null)");
  assert.equal(tw.camera, camera);
  assert.notEqual(tw.scene, scene, "never the live scene: its light counts and fog are in every program key");
  assert.equal(tw.scene.isScene, true, "a Scene as the target scene");
  assert.equal(tw.scene.children.length, 0, "no lights");
  assert.equal(tw.scene.fog, null, "no fog");
  assert.equal(tw.scene.environment, null);
  assert.equal(tw.root.parent, null, "the twin never joins a scene");
  const meshes = [];
  tw.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].geometry.type, "PlaneGeometry");
  assert.deepEqual(tw.materials, [meshes[0].material]);
  const m = meshes[0].material;
  assert.equal(m.type, "MeshBasicMaterial");
  assert.ok(m.map && m.map.isTexture && m.map.isVideoTexture !== true, "a non-video map");
  assert.deepEqual(
    { transparent: m.transparent, depthTest: m.depthTest, depthWrite: m.depthWrite, fog: m.fog, toneMapped: m.toneMapped, side: m.side, forceSinglePass: m.forceSinglePass },
    { transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide, forceSinglePass: false },
    "three compiles it as a BackSide and a FrontSide pass, like the overlay",
  );
  assert.ok(!r.compiles[0].materials.includes(m), "not part of the HalfFloat (composer) compile");
  _resetPrewarmForTest();
});

check("P7 prewarm R2-2: the twin's program-relevant fields (+ forceSinglePass, + the geometry's attributes) equal every material of the REAL film lens overlay, in each style", async () => {
  _resetPrewarmForTest();
  const r = fakeRenderer();
  await prewarm({ THREE, renderer: r, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
  const twinMesh = r.compiles[1].root.children[0];
  const fields = (mat) => programFields(mat) + "|forceSinglePass=" + mat.forceSinglePass;
  const attrs = (g) => Object.keys(g.attributes).sort().join(",");
  const ov = createLensOverlay({ THREE, renderer: { render() {} } });
  for (const style of LENS_OVERLAY_STYLES) {
    assert.equal(ov.configure({ props: { style } }, { uptiltDeg: 20 }).ok, true, style);
    let n = 0;
    ov.scene().traverse((o) => {
      if (!o.isMesh) return;
      n += 1;
      assert.equal(fields(o.material), fields(twinMesh.material), `${style}: an overlay material drifted from the twin`);
      assert.equal(attrs(o.geometry), attrs(twinMesh.geometry), `${style}: overlay geometry attributes`);
    });
    assert.ok(n >= 10, `${style}: ${n} overlay meshes compared`);
  }
  ov.dispose();
  _resetPrewarmForTest();
});

check("P7 prewarm: the ready-poll waits for EVERY program of a material (a two-pass material's BackSide program too, not only currentProgram)", async () => {
  _resetPrewarmForTest();
  const r = fakeRenderer({ twoPass: true });
  r.backReady = false;
  let settled = false;
  const p = prewarm({ THREE, renderer: r, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
  p.then(() => { settled = true; });
  await sleep(35);
  assert.equal(settled, false, "currentProgram is ready but the BackSide program is still linking");
  r.backReady = true;
  const res = await p;
  assert.deepEqual([res.ok, res.compiled], [true, 6]);
  _resetPrewarmForTest();
});

check("P7 prewarm R2-2 on three r184's REAL WebGLRenderer (fake WebGL2): the film lens overlay's first FPV draw links NO program after the prewarm (both offscreen modes, each style); without the prewarm it links 2", async () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  for (const warm of [null, true, false]) {
    for (const style of LENS_OVERLAY_STYLES) {
      _resetPrewarmForTest();
      const gl = createFakeWebGL2();
      const renderer = new THREE.WebGLRenderer({ canvas: fakeGlCanvas(gl), context: gl });
      if (warm !== null) {
        const res = await prewarm({ THREE, renderer, scene: litFoggedScene(), camera, offscreen: warm });
        assert.deepEqual([res.ok, res.compiled], [true, 6], `prewarm offscreen:${warm}`);
      }
      const ov = createLensOverlay({ THREE, renderer });
      assert.equal(ov.configure({ props: { style } }, { uptiltDeg: 20 }).ok, true);
      const before = gl.__fake.counts.createProgram ?? 0;
      assert.equal(ov.draw({ t: 0, throttle: 1, fov: 90 }).drawn, true);
      const linked = (gl.__fake.counts.createProgram ?? 0) - before;
      assert.equal(linked, warm === null ? 2 : 0, `prewarm ${warm === null ? "none" : "offscreen:" + warm}, ${style}: programs linked inside the first overlay draw`);
      ov.dispose();
      renderer.dispose();
    }
  }
  _resetPrewarmForTest();
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`drone_props: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
