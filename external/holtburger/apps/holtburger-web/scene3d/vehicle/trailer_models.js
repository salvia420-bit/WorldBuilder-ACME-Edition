// scene3d/vehicle/trailer_models.js — Articulated fifth-wheel semi-trailer (skeletal container chassis) 3D models.
//
// Client model only (2026-11-17). There is no server object yet: an ACE patch must add the chassis as a
// deployable with its own WCID (TRAILER_WCID below — NOT 4000020/21/22, which are the ISO containers) and a
// wire kind before it can be spawned in-game. Until then harness/trailer-shots-stage.js attaches it under
// server-spawned containers for screenshots. Procedural, Z-up, local origin at the ground under the chassis centre, +Y = front
// (kingpin end), -Y = rear (bogie / ICC bumper) — the same frame as container_models.js, so an ISO
// container built by buildIsoContainer() parented to `containerMount` sits with its doors at the rear.
//
// GPU budget mirrors the container: 4 merged vertex-coloured meshes (frame, running gear, twistlock heads,
// lamps) and 0 THREE.Light instances. Twistlock heads are a separate mesh group so TwistlockState can turn
// them (0 = unlocked / heads fore-aft, 1 = locked / heads rotated 90°).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";

export const TRAILER_KIND = Object.freeze({ Chassis20ft: "20ft", Chassis40ft: "40ft" });

// Reserved WCIDs (distinct from CONTAINER_WCID 4000020..4000022 and the deployables 4000002/4000010..17).
export const TRAILER_WCID = Object.freeze({ Chassis20ft: 4000030, Chassis40ft: 4000031 });

export const TWISTLOCK_STATE = Object.freeze({ Unlocked: 0, Locked: 1 });

// Deck (top of the bolsters) height: where a container's bottom corner castings rest.
export const CHASSIS_DECK_Z = 1.32;

export const TRAILER_SPECS = Object.freeze({
  "20ft": Object.freeze({
    name: "20-ft Skeletal Container Chassis",
    containerLength: 6.058,
    length: 7.40,
    castingSpan: Object.freeze({ width: 2.259, length: 5.853 }),
    axles: 2,
    landingGearY: 1.55,
  }),
  "40ft": Object.freeze({
    name: "40-ft Gooseneck Container Chassis",
    containerLength: 12.192,
    length: 12.50,
    castingSpan: Object.freeze({ width: 2.259, length: 11.985 }),
    axles: 2,
    landingGearY: 3.90,
  }),
});

export function resolveTrailerKind(k) {
  if (k === "40ft" || k === 40 || k === "Chassis40ft" || k === TRAILER_WCID.Chassis40ft) return "40ft";
  return "20ft";
}

// --- geometry helpers (same scheme as container_models.js: non-indexed, vertex colour, merged) -------------

function shade(t, raw, hex, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0 } = {}) {
  const g = raw.index ? raw.toNonIndexed() : raw.clone();
  raw.dispose();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  for (const n of Object.keys(g.attributes)) if (n !== "position" && n !== "normal") g.deleteAttribute(n);
  g.computeVertexNormals();
  const n = g.getAttribute("position").count;
  const c = new Float32Array(n * 3);
  const col = new t.Color(hex);
  for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  g.setAttribute("color", new t.BufferAttribute(c, 3));
  return g;
}

function merge(t, parts) {
  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), C = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    P.set(p.getAttribute("position").array, o);
    N.set(p.getAttribute("normal").array, o);
    C.set(p.getAttribute("color").array, o);
    o += p.getAttribute("position").array.length;
    p.dispose();
  }
  const g = new t.BufferGeometry();
  g.setAttribute("position", new t.BufferAttribute(P, 3));
  g.setAttribute("normal", new t.BufferAttribute(N, 3));
  g.setAttribute("color", new t.BufferAttribute(C, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const box = (t, dx, dy, dz, hex, x, y, z, rot) => shade(t, new t.BoxGeometry(dx, dy, dz), hex, { x, y, z, ...(rot || {}) });
// Cylinder whose axis runs along X (wheels, axles).
const cylX = (t, r, len, hex, x, y, z, seg = 20) =>
  shade(t, new t.CylinderGeometry(r, r, len, seg), hex, { rz: Math.PI / 2, x, y, z });
// Cylinder whose axis runs along Z (legs, kingpin).
const cylZ = (t, r, len, hex, x, y, z, seg = 12) =>
  shade(t, new t.CylinderGeometry(r, r, len, seg), hex, { rx: Math.PI / 2, x, y, z });

function mat(t, opts, csmState) {
  const m = new t.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, ...opts });
  if (csmState) installCsmShaderPatch(m, csmState);
  return m;
}

// --- builder ---------------------------------------------------------------------------------------------------

export function buildSemiTrailer(three, kindIn = "40ft", options = {}) {
  const t = three || THREE_DEFAULT;
  const kind = resolveTrailerKind(kindIn);
  const spec = TRAILER_SPECS[kind];
  const L = spec.length, halfL = L / 2;
  const deckZ = CHASSIS_DECK_Z;
  const frameHex = options.frameHex ?? 0x23262a; // black-painted steel
  const steelHex = 0x6d7176, rubberHex = 0x141414, rimHex = 0xa7abb0;

  const root = new t.Group();
  root.name = `semi-trailer-${kind}-root`;
  root.userData = { kind, spec, trailer: true };

  // ---- 1. Frame: twin I-beam main rails, cross-members, bolsters, kingpin plate, landing gear, ICC bumper ----
  const F = [];
  const railX = 0.50, railH = 0.34, railTopZ = deckZ - 0.05, railZ = railTopZ - railH / 2;
  const gooseL = kind === "40ft" ? 3.15 : 0; // 40HC gooseneck tunnel length
  for (const sx of [-1, 1]) {
    // web + top/bottom flanges
    F.push(box(t, 0.012, L - 0.3, railH, frameHex, sx * railX, -0.15, railZ));
    F.push(box(t, 0.14, L - 0.3, 0.018, frameHex, sx * railX, -0.15, railTopZ - 0.009));
    F.push(box(t, 0.14, L - 0.3, 0.018, frameHex, sx * railX, -0.15, railTopZ - railH + 0.009));
    if (gooseL) {
      // raised gooseneck rail section (fits the 40HC tunnel)
      F.push(box(t, 0.14, gooseL, 0.12, frameHex, sx * railX, halfL - gooseL / 2, deckZ + 0.06));
    }
  }
  // cross-members
  const xmStep = 1.1;
  for (let y = -halfL + 0.9; y < halfL - 0.6; y += xmStep) F.push(box(t, 2 * railX + 0.14, 0.08, 0.16, frameHex, 0, y, railZ + 0.04));
  // outrigger side rails (light) give the skeletal-chassis silhouette
  for (const sx of [-1, 1]) F.push(box(t, 0.06, L - 1.0, 0.10, frameHex, sx * 1.12, -0.2, deckZ - 0.12));
  // bolsters at each twistlock pair (front, rear, plus 20ft mid-positions on the 40ft)
  const castY = spec.castingSpan.length / 2, castX = spec.castingSpan.width / 2;
  const bolsterYs = [castY, -castY];
  if (kind === "40ft") bolsterYs.push(2.9295, -2.9295); // 20ft container corner positions on a 40ft chassis
  for (const by of bolsterYs) F.push(box(t, 2.44, 0.22, 0.20, frameHex, 0, by, deckZ - 0.10 + (kind === "40ft" && by === castY ? 0.12 : 0)));
  // twistlock housings (bases) at every bolster end
  const lockPoints = [];
  for (const by of bolsterYs) for (const sx of [-1, 1]) {
    const lz = deckZ + (kind === "40ft" && by === castY ? 0.12 : 0);
    F.push(box(t, 0.16, 0.16, 0.06, steelHex, sx * castX, by, lz - 0.03));
    lockPoints.push({ x: sx * castX, y: by, z: lz });
  }
  // kingpin upper-coupler plate + 2" kingpin (SAE J700), 0.9 m behind the nose
  const kpY = halfL - 0.9;
  F.push(box(t, 1.30, 1.60, 0.03, steelHex, 0, kpY, railTopZ - railH - 0.015 + (gooseL ? 0.12 : 0)));
  F.push(cylZ(t, 0.0254, 0.085, steelHex, 0, kpY, railTopZ - railH - 0.07 + (gooseL ? 0.12 : 0)));
  // nose bumper
  F.push(box(t, 2.30, 0.10, 0.18, frameHex, 0, halfL - 0.05, deckZ - 0.09 + (gooseL ? 0.12 : 0)));
  // landing gear: two legs, cross brace, sand shoes, crank handle
  const lgY = spec.landingGearY;
  for (const sx of [-1, 1]) {
    F.push(box(t, 0.13, 0.13, railZ - 0.12, frameHex, sx * 0.62, lgY, (railZ - 0.12) / 2 + 0.12));
    F.push(box(t, 0.10, 0.10, 0.30, steelHex, sx * 0.62, lgY, 0.20));
    F.push(box(t, 0.30, 0.36, 0.05, steelHex, sx * 0.62, lgY, 0.025));
    F.push(box(t, 0.08, 0.6, 0.06, frameHex, sx * 0.58, lgY + 0.3, railZ - 0.2, { rx: 0.7 })); // diagonal brace
  }
  F.push(box(t, 1.24, 0.06, 0.06, frameHex, 0, lgY, 0.65));
  F.push(cylX(t, 0.02, 0.40, steelHex, 0.86, lgY, 0.78, 8)); // crank shaft
  F.push(box(t, 0.03, 0.03, 0.22, steelHex, 1.06, lgY, 0.70)); // crank handle
  // suspension hangers + equaliser over the tandem
  const axleYs = [];
  for (let i = 0; i < spec.axles; i++) axleYs.push(-halfL + 1.15 + i * 1.31);
  for (const sx of [-1, 1]) {
    for (const ay of axleYs) {
      F.push(box(t, 0.08, 0.14, railZ - railH / 2 - 0.55, frameHex, sx * railX, ay + 0.55, (railZ - railH / 2 + 0.55) / 2));
      F.push(box(t, 0.08, 1.10, 0.06, steelHex, sx * railX, ay, 0.60)); // leaf/air-ride arm
    }
    F.push(box(t, 0.10, 0.10, railZ - railH / 2 - 0.55, frameHex, sx * railX, axleYs[0] - 0.55, (railZ - railH / 2 + 0.55) / 2));
  }
  // ICC rear under-ride bumper
  F.push(box(t, 2.36, 0.10, 0.10, frameHex, 0, -halfL + 0.05, 0.55));
  for (const sx of [-1, 1]) F.push(box(t, 0.08, 0.08, railZ - railH / 2 - 0.55, frameHex, sx * 0.85, -halfL + 0.05, (railZ - railH / 2 + 0.55) / 2));
  // tail-light bar + mud-flap hangers
  F.push(box(t, 2.40, 0.08, 0.14, frameHex, 0, -halfL + 0.02, deckZ - 0.20));
  for (const sx of [-1, 1]) F.push(box(t, 0.55, 0.012, 0.55, rubberHex, sx * 0.93, axleYs[0] - 0.62, 0.38));

  const frameMesh = new t.Mesh(merge(t, F), mat(t, { roughness: 0.55, metalness: 0.45 }, options.csmState));
  frameMesh.name = "trailer-frame";

  // ---- 2. Running gear: axles, hubs, dual wheels ----
  const R = [];
  const tireR = 0.505, tireW = 0.28;
  for (const ay of axleYs) {
    R.push(cylX(t, 0.07, 2.30, steelHex, 0, ay, tireR, 12));
    for (const sx of [-1, 1]) {
      for (const dual of [0.80, 1.11]) {
        R.push(cylX(t, tireR, tireW, rubberHex, sx * dual, ay, tireR, 28));
        R.push(cylX(t, 0.29, tireW + 0.01, rimHex, sx * dual, ay, tireR, 20));
      }
      R.push(cylX(t, 0.12, 0.08, steelHex, sx * 1.27, ay, tireR, 12)); // hub cap
    }
  }
  const gearMesh = new t.Mesh(merge(t, R), mat(t, { roughness: 0.8, metalness: 0.15 }, options.csmState));
  gearMesh.name = "trailer-running-gear";

  // ---- 3. Twistlock heads (ISO 1161 cone, turned by TwistlockState) ----
  const twistlockPivots = [];
  const lockMat = mat(t, { roughness: 0.4, metalness: 0.7 }, options.csmState);
  const lockGeom = merge(t, [
    box(t, 0.06, 0.11, 0.035, 0xd8b028, 0, 0, 0.0175), // head (yellow-zinc)
    shade(t, new t.CylinderGeometry(0.02, 0.035, 0.05, 8), 0xd8b028, { rx: Math.PI / 2, z: 0.055 }),
  ]);
  for (const p of lockPoints) {
    const piv = new t.Group();
    piv.position.set(p.x, p.y, p.z);
    const m = new t.Mesh(lockGeom, lockMat);
    m.castShadow = true;
    piv.add(m);
    root.add(piv);
    twistlockPivots.push(piv);
  }

  // ---- 4. Lamps (emissive, no lights): red tails, amber side markers ----
  const Lm = [];
  for (const sx of [-1, 1]) {
    Lm.push(box(t, 0.18, 0.03, 0.08, 0xff2a1a, sx * 0.95, -halfL - 0.025, deckZ - 0.20));
    for (const y of [halfL - 0.3, 0, -halfL + 0.4]) Lm.push(box(t, 0.02, 0.07, 0.04, 0xffa000, sx * 1.155, y, deckZ - 0.12));
  }
  const lampMat = new t.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.3 });
  lampMat.onBeforeCompile = (s) => {
    // emissive follows the vertex colour (red / amber) rather than white
    s.fragmentShader = s.fragmentShader.replace("vec3 totalEmissiveRadiance = emissive;", "vec3 totalEmissiveRadiance = emissive * vColor.rgb;");
  };
  const lampMesh = new t.Mesh(merge(t, Lm), lampMat);
  lampMesh.name = "trailer-lamps";

  for (const m of [frameMesh, gearMesh, lampMesh]) { m.castShadow = true; m.receiveShadow = true; root.add(m); }

  // Mount point: a container parented here rests on the twistlocks (front-aligned to the front castings).
  const containerMount = new t.Group();
  containerMount.name = "trailer-container-mount";
  containerMount.position.set(0, 0, deckZ + (kind === "40ft" ? 0.0 : 0));
  root.add(containerMount);

  let twistlockState = TWISTLOCK_STATE.Unlocked;
  function setTwistlockState(s) {
    twistlockState = s ? TWISTLOCK_STATE.Locked : TWISTLOCK_STATE.Unlocked;
    for (const p of twistlockPivots) p.rotation.z = twistlockState ? Math.PI / 2 : 0;
  }
  setTwistlockState(options.twistlockState ?? 0);

  let mounted = null;
  return {
    root,
    spec,
    kind,
    containerMount,
    twistlockPivots,
    get twistlockState() { return twistlockState; },
    setTwistlockState,
    /** Seat a container model (from buildIsoContainer) on the chassis. 20ft on a 40ft chassis rides at the rear. */
    attachContainer(model, { position = "auto" } = {}) {
      if (mounted) containerMount.remove(mounted.root);
      mounted = model;
      const cl = model?.spec?.external?.length ?? spec.containerLength;
      let y = 0;
      if (kind === "40ft" && cl < 7 && position !== "center") y = position === "front" ? 2.9295 : -2.9295;
      model.root.position.set(0, y, 0);
      model.root.rotation.set(0, 0, 0);
      containerMount.add(model.root);
      return model;
    },
    update(dt = 0.033, state = {}) {
      if (state.twistlockState !== undefined) setTwistlockState(state.twistlockState);
    },
    dispose() {
      root.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
    },
  };
}

export const buildTrailer = buildSemiTrailer;
