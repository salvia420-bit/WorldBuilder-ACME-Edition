// scene3d/vehicle/trailer_models.js — Articulated fifth-wheel semi-trailer (skeletal container chassis) 3D models.
//
// Client model only (2026-11-17). There is no server object yet: an ACE patch must add the chassis as a
// deployable with its own WCID (TRAILER_WCID below — NOT 4000020/21/22, which are the ISO containers) and a
// wire kind before it can be spawned in-game. Until then harness/trailer-shots-stage.js attaches it under
// server-spawned containers for screenshots. Procedural, Z-up, local origin at the ground under the chassis centre, +Y = front
// (kingpin end), -Y = rear (bogie / ICC bumper) — the same frame as container_models.js, so an ISO
// container built by buildIsoContainer() parented to `containerMount` sits with its doors at the rear.
//
// GPU budget: 6 merged vertex-coloured meshes (frame, landing gear, 2 wheel axle groups, marker lamps,
// brake lamps) + twistlock heads and 0 THREE.Light instances. Twistlock heads are separate pivots so
// TwistlockState can turn them (0 = unlocked / heads fore-aft, 1 = locked / heads rotated 90°).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";

export const TRAILER_KIND = Object.freeze({ Chassis20ft: "20ft", Chassis40ft: "40ft" });

// Reserved WCIDs (distinct from CONTAINER_WCID 4000020..4000022 and the deployables 4000002/4000010..17).
export const TRAILER_WCID = Object.freeze({ Chassis20ft: 4000030, Chassis40ft: 4000031 });

export const TWISTLOCK_STATE = Object.freeze({ Unlocked: 0, Locked: 1 });

// Deck (top of the bolsters) height: where a container's bottom corner castings rest.
export const CHASSIS_DECK_Z = 1.32;

// Kingpin upper-coupler plate underside height: matches tractor fifth-wheel skid plate.
export const CHASSIS_KINGPIN_Z = 0.96;

export const TRAILER_SPECS = Object.freeze({
  "20ft": Object.freeze({
    name: "20-ft Skeletal Container Chassis",
    containerLength: 6.058,
    length: 7.40,
    castingSpan: Object.freeze({ width: 2.259, length: 5.853 }),
    axles: 2,
    landingGearY: 1.55,
    kingpinY: 2.80,
    bogieY: -1.895,
    effectiveWheelbase: 4.695,
    wheelRadius: 0.505,
  }),
  "40ft": Object.freeze({
    name: "40-ft Gooseneck Container Chassis",
    containerLength: 12.192,
    length: 12.50,
    castingSpan: Object.freeze({ width: 2.259, length: 11.985 }),
    axles: 2,
    landingGearY: 3.90,
    kingpinY: 5.35,
    bogieY: -4.445,
    effectiveWheelbase: 9.795,
    wheelRadius: 0.505,
  }),
});

export function resolveTrailerKind(k) {
  if (
    k === "40ft" ||
    k === 40 ||
    k === "Chassis40ft" ||
    k === "TrailerChassis40" ||
    k === TRAILER_WCID.Chassis40ft ||
    k === 14
  ) {
    return "40ft";
  }
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
  const railX = 0.50, railH = 0.28, railTopZ = deckZ - 0.05, railZ = railTopZ - railH / 2;
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
  // kingpin upper-coupler plate + 2" kingpin (SAE J700), standardized underside at CHASSIS_KINGPIN_Z (0.96 m)
  const kpY = spec.kingpinY;
  F.push(box(t, 1.30, 1.60, 0.03, steelHex, 0, kpY, CHASSIS_KINGPIN_Z + 0.015));
  F.push(cylZ(t, 0.0254, 0.085, steelHex, 0, kpY, CHASSIS_KINGPIN_Z - 0.04));
  // nose bumper
  F.push(box(t, 2.30, 0.10, 0.18, frameHex, 0, halfL - 0.05, deckZ - 0.09 + (gooseL ? 0.12 : 0)));
  // landing gear fixed upper housings, diagonal braces, cross brace, crank
  const lgY = spec.landingGearY;
  for (const sx of [-1, 1]) {
    F.push(box(t, 0.13, 0.13, railZ - 0.50, frameHex, sx * 0.62, lgY, (railZ + 0.50) / 2));
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

  const frameMat = mat(t, { roughness: 0.55, metalness: 0.45 }, options.csmState);
  const frameMesh = new t.Mesh(merge(t, F), frameMat);
  frameMesh.name = "trailer-frame";

  // Telescoping lower landing gear legs + sand shoes (retracted +0.45 m when coupled)
  const LG = [];
  for (const sx of [-1, 1]) {
    LG.push(box(t, 0.10, 0.10, 0.50, steelHex, sx * 0.62, lgY, 0.30));
    LG.push(box(t, 0.30, 0.36, 0.05, steelHex, sx * 0.62, lgY, 0.025));
  }
  const landingGearGroup = new t.Group();
  landingGearGroup.name = "trailer-landing-gear";
  const landingGearMesh = new t.Mesh(merge(t, LG), frameMat);
  landingGearMesh.name = "trailer-landing-gear-mesh";
  landingGearMesh.castShadow = true;
  landingGearMesh.receiveShadow = true;
  landingGearGroup.add(landingGearMesh);
  root.add(landingGearGroup);

  // ---- 2. Running gear: 2 axle-centered wheel groups for rolling rotation ----
  const tireR = spec.wheelRadius ?? 0.505, tireW = 0.28;
  const gearMat = mat(t, { roughness: 0.8, metalness: 0.15 }, options.csmState);
  const wheelGroups = [];
  for (let i = 0; i < axleYs.length; i++) {
    const ay = axleYs[i];
    const wg = new t.Group();
    wg.name = `trailer-wheel-group-${i}`;
    wg.position.set(0, ay, tireR);
    const A = [];
    A.push(cylX(t, 0.07, 2.30, steelHex, 0, 0, 0, 12));
    for (const sx of [-1, 1]) {
      for (const dual of [0.80, 1.11]) {
        A.push(cylX(t, tireR, tireW, rubberHex, sx * dual, 0, 0, 28));
        A.push(cylX(t, 0.29, tireW + 0.01, rimHex, sx * dual, 0, 0, 20));
      }
      A.push(cylX(t, 0.12, 0.08, steelHex, sx * 1.27, 0, 0, 12)); // hub cap
    }
    const axleMesh = new t.Mesh(merge(t, A), gearMat);
    axleMesh.name = `trailer-axle-${i}`;
    axleMesh.castShadow = true;
    axleMesh.receiveShadow = true;
    wg.add(axleMesh);
    root.add(wg);
    wheelGroups.push(wg);
  }

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

  // ---- 4. Lamps (emissive, no lights): split rear brake lamps from amber side markers ----
  function makeLampMat(emissiveIntensity = 0.6) {
    const m = new t.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      emissive: 0xffffff,
      emissiveIntensity,
      roughness: 0.3,
    });
    m.onBeforeCompile = (s) => {
      // emissive follows the vertex colour (red / amber) rather than white
      s.fragmentShader = s.fragmentShader.replace(
        "vec3 totalEmissiveRadiance = emissive;",
        "vec3 totalEmissiveRadiance = emissive * vColor.rgb;",
      );
    };
    return m;
  }

  const brakeParts = [];
  const markerParts = [];
  for (const sx of [-1, 1]) {
    brakeParts.push(box(t, 0.18, 0.03, 0.08, 0xff2a1a, sx * 0.95, -halfL - 0.025, deckZ - 0.20));
    for (const y of [halfL - 0.3, 0, -halfL + 0.4]) {
      markerParts.push(box(t, 0.02, 0.07, 0.04, 0xffa000, sx * 1.155, y, deckZ - 0.12));
    }
  }
  const brakeLampMat = makeLampMat(0.6);
  const markerLampMat = makeLampMat(0.6);
  const brakeLampMesh = new t.Mesh(merge(t, brakeParts), brakeLampMat);
  brakeLampMesh.name = "trailer-brake-lamps";
  const markerLampMesh = new t.Mesh(merge(t, markerParts), markerLampMat);
  markerLampMesh.name = "trailer-marker-lamps";

  for (const m of [frameMesh, brakeLampMesh, markerLampMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
  }

  // Mount point: a container parented here rests on the twistlocks (front-aligned to the front castings).
  const containerMount = new t.Group();
  containerMount.name = "trailer-container-mount";
  containerMount.position.set(0, 0, deckZ);
  root.add(containerMount);

  let twistlockState = TWISTLOCK_STATE.Unlocked;
  function setTwistlockState(s) {
    twistlockState = s ? TWISTLOCK_STATE.Locked : TWISTLOCK_STATE.Unlocked;
    for (const p of twistlockPivots) p.rotation.z = twistlockState ? Math.PI / 2 : 0;
  }
  setTwistlockState(options.twistlockState ?? 0);

  let landingGearRetracted = false;
  function setLandingGearRetracted(retracted) {
    landingGearRetracted = Boolean(retracted);
    landingGearGroup.position.z = landingGearRetracted ? 0.45 : 0.0;
  }
  setLandingGearRetracted(options.landingGearRetracted ?? false);

  let brakeLights = false;
  function setBrakeLights(on) {
    brakeLights = Boolean(on);
    brakeLampMat.emissiveIntensity = brakeLights ? 2.4 : 0.6;
  }
  setBrakeLights(options.brakeLights ?? false);

  let wheelRollAngle = 0;
  function setWheelRollAngle(angle) {
    if (!Number.isFinite(angle)) return;
    wheelRollAngle = angle;
    for (const wg of wheelGroups) wg.rotation.x = wheelRollAngle;
  }

  let mounted = null;
  function detachContainer() {
    const prev = mounted;
    if (mounted?.root && mounted.root.parent === containerMount) {
      containerMount.remove(mounted.root);
    }
    mounted = null;
    return prev;
  }

  return {
    root,
    spec,
    kind,
    kingpinY: kpY,
    kingpinZ: CHASSIS_KINGPIN_Z,
    containerMount,
    landingGearGroup,
    wheelGroups,
    twistlockPivots,
    materials: {
      frameMat,
      gearMat,
      lockMat,
      brakeLampMat,
      markerLampMat,
    },
    get twistlockState() { return twistlockState; },
    setTwistlockState,
    get landingGearRetracted() { return landingGearRetracted; },
    setLandingGearRetracted,
    get brakeLights() { return brakeLights; },
    setBrakeLights,
    get wheelRollAngle() { return wheelRollAngle; },
    get mountedContainer() { return mounted; },
    /** Seat a container model (from buildIsoContainer) on the chassis. 20ft on a 40ft chassis rides at the rear. */
    attachContainer(model, opts) {
      const position = opts?.position ?? "auto";
      if (mounted) detachContainer();
      if (!model) return null;
      mounted = model;
      const cl = model?.spec?.external?.length ?? spec.containerLength;
      let y = 0;
      if (kind === "40ft" && cl < 7 && position !== "center") {
        y = (position === "front" || position === 1) ? 2.9295 : -2.9295;
      }
      model.root.position.set(0, y, 0);
      model.root.rotation.set(0, 0, 0);
      containerMount.add(model.root);
      return model;
    },
    detachContainer,
    update(dtOrState = 0.033, stateOrDt = {}) {
      let dt;
      let state;
      if (dtOrState !== null && typeof dtOrState === "object") {
        state = dtOrState;
        dt = Number.isFinite(state.dt) ? state.dt : (Number.isFinite(stateOrDt) ? stateOrDt : 0.033);
      } else {
        dt = Number.isFinite(dtOrState) ? dtOrState : 0.033;
        state = (stateOrDt && typeof stateOrDt === "object") ? stateOrDt : {};
      }
      if (state.twistlockState !== undefined) setTwistlockState(state.twistlockState);
      if (state.landingGearRetracted !== undefined) setLandingGearRetracted(state.landingGearRetracted);
      const brakeInput = state.brakeLights !== undefined ? state.brakeLights : state.braking;
      if (brakeInput !== undefined) setBrakeLights(brakeInput);
      if (Number.isFinite(state.wheelRollAngle)) {
        setWheelRollAngle(state.wheelRollAngle);
      } else if (dt > 0 && Number.isFinite(state.speed) && Math.abs(state.speed) > 1e-6) {
        let next = (wheelRollAngle + (state.speed * dt) / tireR) % (2 * Math.PI);
        if (next < 0) next += 2 * Math.PI;
        setWheelRollAngle(next);
      }
    },
    dispose() {
      detachContainer();
      const disposedGeoms = new Set();
      const disposedMats = new Set();
      root.traverse((o) => {
        if (o.geometry && !disposedGeoms.has(o.geometry)) {
          o.geometry.dispose();
          disposedGeoms.add(o.geometry);
        }
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && !disposedMats.has(m)) {
              m.dispose();
              disposedMats.add(m);
            }
          }
        }
      });
    },
  };
}

export const buildTrailer = buildSemiTrailer;
