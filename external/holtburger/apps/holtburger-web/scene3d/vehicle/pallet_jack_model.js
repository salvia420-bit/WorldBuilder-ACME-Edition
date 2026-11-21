// scene3d/vehicle/pallet_jack_model.js — ISO 3691-5 Walk-Behind Pedestrian Low-Lift Pallet Jack (`WCID 4000035`).
// Dimensions conform to ISO 3691-5 & North American GMA 4-way pallet stringer geometry:
//   - Twin beveled forks: 1.150 m length (45"), 0.160 m width, 0.685 m outer spread (27", +-0.2625 m centerlines)
//   - Lift stroke: 0.085 m lowered -> 0.200 m raised (<= 300 mm low-lift ceiling)
//   - Wheelbase: 1.18 m (steer pivot y = -0.52 m, tandem load wheels y = +0.66 m)
//   - Articulated 3-position steel tiller handle: 1.22 m height, +-95 deg (1.65 rad) steer arc
//
// Strict GPU budget: 5 draw calls unloaded (<= 6), 0 THREE.Light instances,
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching, Z-up AC coordinates (+Y forward, +X right).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import { buildDeployable, buildPallet } from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";

export const PALLET_JACK_WCID = 4000035;

export const PALLET_JACK_SPECS = Object.freeze({
  wcid: PALLET_JACK_WCID,
  kind: 16,
  maxDrawCalls: 6,
  forkLength: 1.150,
  forkWidth: 0.160,
  forkSpread: 0.685,
  forkCenterX: 0.2625,
  forkThickness: 0.052,
  forkLoweredZ: 0.085,
  forkRaisedZ: 0.200,
  tillerHeight: 1.22,
  wheelbase: 1.18,
  maxTillerRad: 1.65,
  forkHeelY: -0.35,
  forkTipY: 0.80,
  loadAxleY: 0.66,
  steerPivotY: -0.52,
  cargoCenterY: 0.250,
});

export const manifest = Object.freeze({
  id: "vfx-pallet-jack-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform"]),
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function shade(t, raw, hex, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0 } = {}) {
  const g = raw.index ? raw.toNonIndexed() : raw.clone();
  raw.dispose();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  for (const n of Object.keys(g.attributes)) {
    if (n !== "position" && n !== "normal") g.deleteAttribute(n);
  }
  g.computeVertexNormals();
  const n = g.getAttribute("position").count;
  const c = new Float32Array(n * 3);
  const col = new t.Color(hex);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new t.BufferAttribute(c, 3));
  return g;
}

function merge(t, parts) {
  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;
  const P = new Float32Array(total * 3);
  const N = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    const pa = p.getAttribute("position").array;
    P.set(pa, o);
    N.set(p.getAttribute("normal").array, o);
    C.set(p.getAttribute("color").array, o);
    o += pa.length;
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

const box = (t, dx, dy, dz, hex, x, y, z, rot) =>
  shade(t, new t.BoxGeometry(dx, dy, dz), hex, { x, y, z, ...(rot || {}) });

const cylX = (t, r, len, hex, x, y, z, seg = 16) =>
  shade(t, new t.CylinderGeometry(r, r, len, seg), hex, { rz: Math.PI / 2, x, y, z });

const cylZ = (t, r, len, hex, x, y, z, seg = 12) =>
  shade(t, new t.CylinderGeometry(r, r, len, seg), hex, { rx: Math.PI / 2, x, y, z });

function mat(t, opts, csmState) {
  const m = new t.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, ...opts });
  if (csmState) installCsmShaderPatch(m, csmState);
  return m;
}

export function buildPalletJack(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const S = PALLET_JACK_SPECS;

  const yellowHex = options.frameHex ?? 0xe5a00d;
  const darkSteelHex = 0x282c32;
  const polyWheelHex = 0xc93a20; // Polyurethane load & steer wheels
  const wheelHubHex = 0x454a52;
  const chromeHex = 0xd4dae0;
  const gripBlackHex = 0x1b1e22;
  const triggerRedHex = 0xd62828;

  const root = new t.Group();
  root.name = "pallet-jack-root";
  root.userData = { wcid: PALLET_JACK_WCID, kind: S.kind, palletJack: true };

  // ---- 1. Lifting Forks + Load Backrest Apron + cargoMount (Draw call 1) ----
  const forksGroup = new t.Group();
  forksGroup.name = "pallet-jack-forks";
  forksGroup.position.set(0, 0, S.forkLoweredZ);
  root.add(forksGroup);

  const forkParts = [];
  const fkThick = S.forkThickness;
  const fkBodyLen = 1.09; // y in [-0.35, +0.74]
  const fkBodyCenterY = S.forkHeelY + fkBodyLen / 2; // +0.195

  for (const sx of [-1, 1]) {
    const cx = sx * S.forkCenterX;
    // Main C-channel fork blade (top surface at z = 0 in forksGroup local space)
    forkParts.push(box(t, S.forkWidth, fkBodyLen, fkThick * 0.65, yellowHex, cx, fkBodyCenterY, -fkThick * 0.325));
    // Lower dark steel channel skirt
    forkParts.push(box(t, S.forkWidth - 0.016, fkBodyLen - 0.04, fkThick * 0.35, darkSteelHex, cx, fkBodyCenterY, -fkThick * 0.825));
    // Beveled pallet-entry wedge tip (y in [+0.74, +0.80]), sloping downward toward +Y so max Z <= 0
    forkParts.push(box(t, S.forkWidth * 0.92, 0.045, fkThick * 0.45, yellowHex, cx, S.forkTipY - 0.037, -fkThick * 0.30, { rx: -0.14 }));
    forkParts.push(box(t, S.forkWidth * 0.78, 0.025, fkThick * 0.24, darkSteelHex, cx, S.forkTipY - 0.013, -fkThick * 0.48, { rx: -0.26 }));
  }
  // Rear cross-bridge & vertical load backrest apron with guard ribs (y in [-0.35, -0.305])
  forkParts.push(box(t, S.forkSpread - 0.02, 0.05, 0.07, yellowHex, 0, S.forkHeelY + 0.025, 0.01));
  forkParts.push(box(t, S.forkSpread - 0.04, 0.04, 0.30, darkSteelHex, 0, S.forkHeelY + 0.02, 0.17));
  forkParts.push(box(t, 0.18, 0.05, 0.24, yellowHex, 0, S.forkHeelY + 0.025, 0.15));
  forkParts.push(box(t, S.forkSpread - 0.04, 0.028, 0.026, yellowHex, 0, S.forkHeelY + 0.02, 0.33));
  for (const sx of [-1, 1]) {
    forkParts.push(box(t, 0.022, 0.028, 0.26, darkSteelHex, sx * 0.21, S.forkHeelY + 0.02, 0.19));
  }

  const forksMat = mat(t, { roughness: 0.45, metalness: 0.50 }, options.csmState);
  const forksMesh = new t.Mesh(merge(t, forkParts), forksMat);
  forksMesh.name = "pallet-jack-forks-mesh";
  forksMesh.castShadow = true;
  forksMesh.receiveShadow = true;
  forksGroup.add(forksMesh);

  const cargoMount = new t.Group();
  cargoMount.name = "pallet-jack-cargo-mount";
  cargoMount.position.set(0, S.cargoCenterY, 0);
  forksGroup.add(cargoMount);

  // ---- 2. Ground Chassis Rollers & Thrust Collar (Draw call 2) ----
  const chassisParts = [];
  for (const sx of [-1, 1]) {
    const cx = sx * S.forkCenterX;
    // Tandem polyurethane load wheels (r = 0.040 m, resting at z = 0.0)
    for (const dy of [-0.055, 0.055]) {
      const wy = S.loadAxleY + dy;
      chassisParts.push(cylX(t, 0.040, 0.075, polyWheelHex, cx, wy, 0.040, 14));
      chassisParts.push(cylX(t, 0.020, 0.082, wheelHubHex, cx, wy, 0.040, 10));
    }
    // Rocker bogie side straps
    chassisParts.push(box(t, 0.11, 0.17, 0.024, darkSteelHex, cx, S.loadAxleY, 0.044));
    // Entry glide roller at fork bevel (r = 0.024 m, bottom at z = 0.0)
    chassisParts.push(cylX(t, 0.024, 0.06, darkSteelHex, cx, S.forkTipY - 0.04, 0.024, 10));
  }
  // Hydraulic thrust yoke collar & push-rod linkage housing
  chassisParts.push(cylZ(t, 0.082, 0.06, darkSteelHex, 0, S.steerPivotY, 0.20, 14));
  chassisParts.push(box(t, 0.16, 0.20, 0.05, darkSteelHex, 0, S.steerPivotY + 0.10, 0.12));

  const chassisMat = mat(t, { roughness: 0.55, metalness: 0.40 }, options.csmState);
  const chassisMesh = new t.Mesh(merge(t, chassisParts), chassisMat);
  chassisMesh.name = "pallet-jack-chassis-rollers";
  chassisMesh.castShadow = true;
  chassisMesh.receiveShadow = true;
  root.add(chassisMesh);

  // ---- 3. Steerable Pump Housing & Dual Steer Wheels (Draw call 3) ----
  const steerPivot = new t.Group();
  steerPivot.name = "pallet-jack-steer-pivot";
  steerPivot.position.set(0, S.steerPivotY, 0);
  root.add(steerPivot);

  const steerYokeParts = [
    // Safety yellow hydraulic pump cylinder housing
    cylZ(t, 0.075, 0.24, yellowHex, 0, 0, 0.32, 16),
    // Hydraulic oil sight-cap & filler collar on pump shoulder
    cylZ(t, 0.020, 0.024, darkSteelHex, 0.045, 0.045, 0.445, 10),
    cylZ(t, 0.014, 0.012, 0xd49420, 0.045, 0.045, 0.458, 10),
    // Dark steel valve manifold block
    box(t, 0.17, 0.16, 0.10, darkSteelHex, 0, 0, 0.22),
    // Foot-release lowering pedal on rear manifold
    box(t, 0.060, 0.060, 0.018, darkSteelHex, -0.055, -0.095, 0.175, { rx: 0.18 }),
    box(t, 0.052, 0.036, 0.016, triggerRedHex, -0.055, -0.118, 0.182, { rx: 0.18 }),
    // Steer axle & fork yoke
    cylX(t, 0.022, 0.20, darkSteelHex, 0, 0, 0.090, 10),
    box(t, 0.10, 0.09, 0.11, darkSteelHex, 0, 0, 0.14),
  ];
  // Dual polyurethane steer wheels (r = 0.090 m, bottom at z = 0.0)
  for (const sx of [-1, 1]) {
    steerYokeParts.push(cylX(t, 0.090, 0.050, polyWheelHex, sx * 0.065, 0, 0.090, 18));
    steerYokeParts.push(cylX(t, 0.048, 0.054, wheelHubHex, sx * 0.065, 0, 0.090, 12));
  }
  const steerYokeMat = mat(t, { roughness: 0.45, metalness: 0.45 }, options.csmState);
  const steerYokeMesh = new t.Mesh(merge(t, steerYokeParts), steerYokeMat);
  steerYokeMesh.name = "pallet-jack-steer-yoke";
  steerYokeMesh.castShadow = true;
  steerYokeMesh.receiveShadow = true;
  steerPivot.add(steerYokeMesh);

  // ---- 4. Hydraulic Lift Ram Piston (Draw call 4) ----
  const pistonParts = [
    cylZ(t, 0.026, 0.24, chromeHex, 0, 0, 0.48, 12),
    cylZ(t, 0.036, 0.03, darkSteelHex, 0, 0, 0.60, 12),
    cylZ(t, 0.016, 0.14, chromeHex, 0, -0.055, 0.36, 10), // Pump plunger
  ];
  const pistonMat = mat(t, { roughness: 0.24, metalness: 0.84 }, options.csmState);
  const pistonMesh = new t.Mesh(merge(t, pistonParts), pistonMat);
  pistonMesh.name = "pallet-jack-pump-piston";
  pistonMesh.castShadow = true;
  pistonMesh.receiveShadow = true;
  steerPivot.add(pistonMesh);

  // ---- 5. Articulated 3-Position Steel Tiller Handle (1.22 m total height, Draw call 5) ----
  const tillerPivot = new t.Group();
  tillerPivot.name = "pallet-jack-tiller-pivot";
  tillerPivot.position.set(0, 0, 0.38); // 0.38 + 0.84 = 1.220 m exact ISO 3691-5 tiller height
  steerPivot.add(tillerPivot);

  const tillerParts = [
    // Twin tubular root yoke
    cylZ(t, 0.018, 0.14, darkSteelHex, -0.045, 0, 0.06, 10),
    cylZ(t, 0.018, 0.14, darkSteelHex, +0.045, 0, 0.06, 10),
    box(t, 0.12, 0.035, 0.04, darkSteelHex, 0, 0, 0.13),
    // Central tubular steel stem
    cylZ(t, 0.020, 0.56, darkSteelHex, 0, 0, 0.41, 12),
    // Ergonomic closed loop handle grip (top at z_local = 0.84 -> 1.22 m)
    box(t, 0.26, 0.04, 0.034, gripBlackHex, 0, 0, 0.823), // Top crossbar (top at 0.840)
    box(t, 0.24, 0.036, 0.03, darkSteelHex, 0, 0, 0.69),  // Lower grip bridge
    box(t, 0.034, 0.04, 0.14, gripBlackHex, -0.115, 0, 0.76), // Left handguard
    box(t, 0.034, 0.04, 0.14, gripBlackHex, +0.115, 0, 0.76), // Right handguard
    // Red 3-position hydraulic release lever
    box(t, 0.14, 0.025, 0.022, triggerRedHex, 0, -0.022, 0.76),
  ];
  const tillerMat = mat(t, { roughness: 0.48, metalness: 0.45 }, options.csmState);
  const tillerMesh = new t.Mesh(merge(t, tillerParts), tillerMat);
  tillerMesh.name = "pallet-jack-tiller";
  tillerMesh.castShadow = true;
  tillerMesh.receiveShadow = true;
  tillerPivot.add(tillerMesh);

  // ---- State & Dynamic Cargo Mounting ----
  let forkHeightM = S.forkLoweredZ;
  let tillerAngle = 0;
  let pumpStroke = 0;
  let carriedWcid = 0;
  let stowed = false;
  let mountedCargo = null;

  function setCarriedWcid(nextRaw) {
    const nextWcid = Number.isFinite(nextRaw) ? (nextRaw >>> 0) : 0;
    if (nextWcid === (mountedCargo?.wcid ?? 0) && nextWcid === carriedWcid) {
      return;
    }
    if (mountedCargo) {
      if (mountedCargo.model?.root && mountedCargo.model.root.parent === cargoMount) {
        cargoMount.remove(mountedCargo.model.root);
      }
      if (typeof mountedCargo.model?.dispose === "function") {
        mountedCargo.model.dispose();
      }
      mountedCargo = null;
    }
    carriedWcid = nextWcid;
    if (nextWcid === 0) return;

    let model;
    if (nextWcid === 4000002) {
      model = buildDeployedRadar(t, { stowed: true, csmState: options.csmState });
    } else if (nextWcid >= 4000010 && nextWcid <= 4000017) {
      model = buildDeployable(t, nextWcid, { stowed: true, csmState: options.csmState });
    } else {
      model = buildPallet(t, "standard", { stowed: true, csmState: options.csmState });
    }
    if (model?.root) {
      model.root.position.set(0, 0, 0);
      model.root.rotation.set(0, 0, 0);
      cargoMount.add(model.root);
    }
    mountedCargo = { wcid: nextWcid, model };
  }

  function update(state = {}) {
    const s = state && typeof state === "object" ? state : {};

    const rawH = s.forkHeightM !== undefined ? s.forkHeightM : s.ForkHeightM;
    if (Number.isFinite(rawH)) {
      forkHeightM = clamp(rawH, S.forkLoweredZ, S.forkRaisedZ);
    }
    forksGroup.position.z = forkHeightM;
    const DECK_UNDERSIDE_Z = 0.123;
    cargoMount.position.set(0, S.cargoCenterY, Math.max(-forkHeightM, -DECK_UNDERSIDE_Z));
    pistonMesh.position.z = (forkHeightM - S.forkLoweredZ) * 0.75;

    if (s.stowed !== undefined) {
      stowed = Boolean(s.stowed);
    }

    const rawTiller = s.tillerAngle !== undefined ? s.tillerAngle : s.TillerAngle;
    if (Number.isFinite(rawTiller)) {
      tillerAngle = clamp(rawTiller, -S.maxTillerRad, S.maxTillerRad);
    }

    const rawPump = s.pumpStroke !== undefined ? s.pumpStroke : s.PumpStroke;
    if (Number.isFinite(rawPump)) {
      pumpStroke = clamp(rawPump, 0, 1);
    }

    if (stowed) {
      steerPivot.rotation.z = 0;
      tillerPivot.rotation.x = 0;
    } else {
      steerPivot.rotation.z = tillerAngle;
      // Right-handed +X rotation tilts +Z tiller stem toward -Y operator
      tillerPivot.rotation.x = pumpStroke * 0.75;
    }

    const rawWcid = s.carriedWcid !== undefined ? s.carriedWcid : s.CarriedWcid;
    if (rawWcid !== undefined) {
      setCarriedWcid(rawWcid);
    }
  }

  update({
    forkHeightM: options.forkHeightM ?? S.forkLoweredZ,
    tillerAngle: options.tillerAngle ?? 0,
    pumpStroke: options.pumpStroke ?? 0,
    carriedWcid: options.carriedWcid ?? 0,
    stowed: options.stowed ?? false,
  });

  return {
    root,
    forksGroup,
    cargoMount,
    steerPivot,
    tillerPivot,
    spec: S,
    wcid: PALLET_JACK_WCID,
    maxDrawCalls: S.maxDrawCalls,
    get forkHeightM() { return forkHeightM; },
    get tillerAngle() { return tillerAngle; },
    get pumpStroke() { return pumpStroke; },
    get carriedWcid() { return carriedWcid; },
    get stowed() { return stowed; },
    get mountedCargo() { return mountedCargo; },
    update,
    dispose() {
      setCarriedWcid(0);
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
