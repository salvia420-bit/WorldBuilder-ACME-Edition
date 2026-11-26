// scene3d/vehicle/amr_underride_model.js — Underride Autonomous Mobile Robot (`WCID 4000042`).
//
// Millimeter-locked to AMR_SPECS & stepAmrKinematics():
//   - Low-profile chamfered titanium-slate & safety-amber hull: 0.780 m W x 1.040 m L
//     (fits cleanly inside 0.860 x 0.360 m P&D Stand and raised Scissor Lift Table tunnels)
//   - Lowered platen z = 0.260 m, raised platen z = 0.450 m (+70 mm lift over 0.380 m rails)
//   - Articulated X-scissor lift arms (InstancedMesh), differential drive wheels (InstancedMesh),
//     diagonal 270-deg LiDAR pods, brass charging contacts, E-stops, perimeter status lightbar,
//     and 0.720 m circular rotating turntable (`turntableGroup.rotation.z = -turntableYawRad`)
//
// Strict GPU budget: 5 draw calls unloaded (<= 6), 0 THREE.Light instances,
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching, Z-up AC coordinates (+Y forward, +X right).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
  buildDeployable,
  buildPallet,
} from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";
import { AMR_SPECS } from "./warehouse_specs.js";

export const manifest = Object.freeze({
  id: "vfx-amr-underride-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

const STATUS_COLORS = Object.freeze({
  idle: 0x44aa77,
  transit: 0x22ee66,
  lifting: 0xffa818,
  charging: 0x18d8ff,
  yield: 0xff2820,
  blocked: 0xff2820,
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function mountStowedCargo(t, wcid, csmState) {
  if (wcid === 4000002) {
    return buildDeployedRadar(t, { stowed: true, csmState });
  }
  if (wcid >= 4000010 && wcid <= 4000017) {
    return buildDeployable(t, wcid, { stowed: true, csmState });
  }
  return buildPallet(t, "standard", { stowed: true, csmState });
}

export function buildAmrUnderride(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const S = AMR_SPECS;

  const pal = makeLinearPalette(t, {
    slate: opts.hullHex ?? 0x3e454e,
    slateDark: 0x24292f,
    amber: 0xe89c14,
    steel: 0x626b76,
    chrome: 0xcfd6de,
    rubber: 0x1a1c20,
    hub: 0x58606a,
    visor: 0x0a111a,
    brass: 0xd4a438,
    red: 0xd62828,
    yellow: 0xf0b20c,
    white: 0xffffff,
  });

  const root = new t.Group();
  root.name = "amr-underride-root";
  root.userData = { wcid: S.wcid, kind: S.kind, amrUnderride: true };

  // ---- 1. Low-Profile Chamfered Hull, Caster Rollers, LiDAR Pods, Contacts & E-Stops (DC 1) ----
  const hullAcc = new GeomAcc(3);
  const hw = S.widthM * 0.5; // 0.390
  const hl = S.lengthM * 0.5; // 0.520

  // Lower chassis belly & bumper skirts (z in [0.025, 0.145])
  hullAcc.bevelBox(0, 0, 0.085, hw - 0.008, hl - 0.008, 0.060, 0.08, pal.slateDark, cShade(pal.slateDark, 0.8));
  // Upper sculpted titanium-slate deck shell (z in [0.145, 0.245])
  hullAcc.bevelBox(0, 0, 0.195, hw, hl, 0.050, 0.09, pal.slate, pal.slateDark);
  // Safety-amber front & rear corner accents
  hullAcc.bevelBox(0, +hl - 0.055, 0.195, hw - 0.04, 0.045, 0.042, 0.04, pal.amber, cShade(pal.amber, 0.82));
  hullAcc.bevelBox(0, -hl + 0.055, 0.195, hw - 0.04, 0.045, 0.042, 0.04, pal.amber, cShade(pal.amber, 0.82));
  // Recessed central scissor well
  hullAcc.box(0, 0, 0.148, 0.27, 0.36, 0.014, pal.slateDark, cShade(pal.slateDark, 0.78));

  // 4 corner caster rollers (radius 0.030 m -> bottom at z = 0.000)
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      hullAcc.cylinder(sx * 0.28, sy * 0.39, 0.030, 0.030, 0.034, 12, pal.rubber, "x");
      hullAcc.box(sx * 0.28, sy * 0.39, 0.052, 0.024, 0.028, 0.016, pal.steel, pal.slateDark);
    }
  }

  // Dual diagonal-corner 270-deg LiDAR safety scanner pods
  for (const [lx, ly] of [[-0.335, +0.465], [+0.335, -0.465]]) {
    hullAcc.cylinder(lx, ly, 0.140, 0.050, 0.068, 14, pal.visor, "z");
    hullAcc.cylinder(lx, ly, 0.180, 0.052, 0.014, 14, pal.slateDark, "z");
  }

  // Rear brass inductive/brush charging contacts (recessed within -0.520 m)
  for (const cx of [-0.09, +0.09]) {
    hullAcc.box(cx, -hl + 0.008, 0.115, 0.036, 0.006, 0.022, pal.brass, cShade(pal.brass, 0.8));
  }

  // Flush side E-stop mushroom buttons (kept strictly inside ±0.390 m width)
  for (const sx of [-1, 1]) {
    hullAcc.box(sx * (hw - 0.012), 0.18, 0.190, 0.008, 0.032, 0.032, pal.yellow, pal.yellow);
    hullAcc.cylinder(sx * (hw - 0.006), 0.18, 0.190, 0.014, 0.010, 10, pal.red, "x");
  }

  const hullMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.48, csmState });
  const hullMesh = new t.Mesh(hullAcc.toBufferGeometry(t), hullMat);
  hullMesh.name = "amr-hull-mesh";
  hullMesh.castShadow = true;
  hullMesh.receiveShadow = true;
  root.add(hullMesh);

  // ---- 2. Differential Drive Wheels (InstancedMesh, DC 2) ----
  const wheelAcc = new GeomAcc(3);
  wheelAcc.cylinder(0, 0, 0, S.wheelRadiusM, 0.055, 18, pal.rubber, "x");
  wheelAcc.cylinder(0, 0, 0, S.wheelRadiusM * 0.58, 0.060, 14, pal.hub, "x");
  const wheelMat = makeDeployablePbrMaterial(t, { roughness: 0.72, metalness: 0.18, csmState });
  const wheelsMesh = new t.InstancedMesh(wheelAcc.toBufferGeometry(t), wheelMat, 2);
  wheelsMesh.name = "amr-wheels-instanced";
  wheelsMesh.castShadow = true;
  wheelsMesh.receiveShadow = true;
  wheelsMesh.frustumCulled = false;
  root.add(wheelsMesh);

  // ---- 3. Articulated X-Scissor Lift Arms (InstancedMesh, DC 3) ----
  const armLen = 0.560;
  const scissorAcc = new GeomAcc(3);
  scissorAcc.box(0, 0, 0, 0.012, armLen * 0.5, 0.011, pal.steel, pal.slateDark);
  scissorAcc.cylinder(0, 0, 0, 0.014, 0.028, 8, pal.chrome, "x");
  const scissorMat = makeDeployablePbrMaterial(t, { roughness: 0.38, metalness: 0.70, csmState });
  const scissorsMesh = new t.InstancedMesh(scissorAcc.toBufferGeometry(t), scissorMat, 4);
  scissorsMesh.name = "amr-scissors-instanced";
  scissorsMesh.castShadow = true;
  scissorsMesh.receiveShadow = true;
  scissorsMesh.frustumCulled = false;
  root.add(scissorsMesh);

  // ---- 4. Circular 0.720 m Rotating Turntable Platen + cargoMount (DC 4) ----
  const turntableGroup = new t.Group();
  turntableGroup.name = "amr-turntable-group";
  turntableGroup.position.set(0, 0, S.loweredHeightM);
  root.add(turntableGroup);

  const ttAcc = new GeomAcc(3);
  const ttR = S.turntableRadiusM; // 0.360
  // Platen disk (z_local in [-0.016, -0.002] so top pads sit at z_local = 0.000)
  ttAcc.cylinder(0, 0, -0.009, ttR, 0.014, 28, pal.slateDark, "z");
  ttAcc.cylinder(0, 0, -0.004, ttR - 0.018, 0.006, 28, pal.slate, "z");
  // 4 rubber pallet-centering corner pads flush at z_local = 0.000
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ttAcc.box(sx * 0.21, sy * 0.21, -0.002, 0.048, 0.048, 0.002, pal.rubber, pal.rubber);
    }
  }
  // Ribbed anti-slip ring & central upward-facing QR/fiducial camera lens
  ttAcc.cylinder(0, 0, -0.001, 0.042, 0.002, 14, pal.steel, "z");
  ttAcc.cylinder(0, 0, 0.000, 0.024, 0.001, 14, pal.visor, "z");

  const ttMat = makeDeployablePbrMaterial(t, { roughness: 0.52, metalness: 0.45, csmState });
  const ttMesh = new t.Mesh(ttAcc.toBufferGeometry(t), ttMat);
  ttMesh.name = "amr-turntable-mesh";
  ttMesh.castShadow = true;
  ttMesh.receiveShadow = true;
  turntableGroup.add(ttMesh);

  const cargoMount = new t.Group();
  cargoMount.name = "amr-cargo-mount";
  cargoMount.position.set(0, 0, 0);
  turntableGroup.add(cargoMount);

  // ---- 5. Perimeter Emissive Status Lightbar (DC 5) ----
  const barAcc = new GeomAcc(3);
  const barZ = 0.215;
  // Front, rear, left & right perimeter lightbar strips
  barAcc.box(0, +hl - 0.006, barZ, hw - 0.11, 0.004, 0.010, pal.white, pal.white);
  barAcc.box(0, -hl + 0.006, barZ, hw - 0.11, 0.004, 0.010, pal.white, pal.white);
  barAcc.box(-hw + 0.006, 0, barZ, 0.004, hl - 0.11, 0.010, pal.white, pal.white);
  barAcc.box(+hw - 0.006, 0, barZ, 0.004, hl - 0.11, 0.010, pal.white, pal.white);

  const statusMat = makeLampsMaterial(t, { emissiveIntensity: 0.90, roughness: 0.25 });
  statusMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(statusMat, csmState);
  statusMat.castShadow = true;
  statusMat.receiveShadow = true;
  const statusMesh = new t.Mesh(barAcc.toBufferGeometry(t), statusMat);
  statusMesh.name = "amr-status-bar-mesh";
  statusMesh.castShadow = true;
  statusMesh.receiveShadow = true;
  root.add(statusMesh);

  // ---- Dynamic State & Scissor/Wheel Updates ----
  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler();

  let liftHeightM = S.loweredHeightM;
  let turntableYawRad = 0.0;
  let wheelSpinL = 0.0;
  let wheelSpinR = 0.0;
  let statusMode = "idle";
  let carriedWcid = 0;
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

    const model = mountStowedCargo(t, nextWcid, csmState);
    if (model?.root) {
      model.root.position.set(0, 0, 0);
      model.root.rotation.set(0, 0, 0);
      cargoMount.add(model.root);
    }
    mountedCargo = { wcid: nextWcid, model };
  }

  function syncInstances() {
    const halfTrack = S.wheelTrackM * 0.5; // 0.300
    // Left wheel (idx 0) & Right wheel (idx 1)
    _p.set(-halfTrack, 0, S.wheelRadiusM);
    _e.set(-wheelSpinL, 0, 0);
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);
    wheelsMesh.setMatrixAt(0, _m);

    _p.set(+halfTrack, 0, S.wheelRadiusM);
    _e.set(-wheelSpinR, 0, 0);
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);
    wheelsMesh.setMatrixAt(1, _m);

    wheelsMesh.instanceMatrix.needsUpdate = true;
    wheelsMesh.computeBoundingBox();
    wheelsMesh.computeBoundingSphere();

    // 4 X-scissor arms in two pairs at x = ±0.200
    const zBot = 0.160;
    const zTop = liftHeightM - 0.015;
    const zMid = 0.5 * (zBot + zTop);
    const dz = Math.max(0.04, zTop - zBot);
    const pitch = Math.asin(clamp(dz / armLen, 0.08, 0.96));

    const armDefs = [
      [-0.200, +pitch],
      [-0.214, -pitch],
      [+0.200, +pitch],
      [+0.214, -pitch],
    ];
    for (let i = 0; i < armDefs.length; i++) {
      _p.set(armDefs[i][0], 0, zMid);
      _e.set(armDefs[i][1], 0, 0);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      scissorsMesh.setMatrixAt(i, _m);
    }
    scissorsMesh.instanceMatrix.needsUpdate = true;
    scissorsMesh.computeBoundingBox();
    scissorsMesh.computeBoundingSphere();
  }

  function update(state = {}) {
    const s = state && typeof state === "object" ? state : {};

    if (Number.isFinite(s.liftHeightM)) {
      liftHeightM = clamp(s.liftHeightM, S.loweredHeightM, S.raisedHeightM);
    }
    if (Number.isFinite(s.turntableYawRad)) {
      turntableYawRad = s.turntableYawRad;
    }
    if (Number.isFinite(s.wheelSpinL)) {
      wheelSpinL = s.wheelSpinL;
    }
    if (Number.isFinite(s.wheelSpinR)) {
      wheelSpinR = s.wheelSpinR;
    }
    if (typeof s.statusMode === "string" && STATUS_COLORS[s.statusMode] !== undefined) {
      statusMode = s.statusMode;
    }

    turntableGroup.position.set(0, 0, liftHeightM);
    // Matches stepAmrKinematics: heldCargoHeading = heading + turntableYawRad
    // and root.rotation.z = -heading -> worldRotZ = -(heading + turntableYawRad)
    turntableGroup.rotation.z = -turntableYawRad;

    statusMat.emissive.setHex(STATUS_COLORS[statusMode] ?? STATUS_COLORS.idle);
    syncInstances();

    if (s.carriedWcid !== undefined) {
      setCarriedWcid(s.carriedWcid);
    }
  }

  update({
    liftHeightM: opts.liftHeightM ?? S.loweredHeightM,
    turntableYawRad: opts.turntableYawRad ?? 0,
    wheelSpinL: opts.wheelSpinL ?? 0,
    wheelSpinR: opts.wheelSpinR ?? 0,
    statusMode: opts.statusMode ?? "idle",
    carriedWcid: opts.carriedWcid ?? 0,
  });

  function dispose() {
    setCarriedWcid(0);
    const disposedG = new Set();
    const disposedM = new Set();
    root.traverse((o) => {
      if (o.geometry && !disposedG.has(o.geometry)) {
        disposedG.add(o.geometry);
        o.geometry.dispose();
      }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && !disposedM.has(m)) {
            disposedM.add(m);
            m.dispose();
          }
        }
      }
      if (o.isInstancedMesh && typeof o.dispose === "function") {
        o.dispose();
      }
    });
  }

  return {
    root,
    turntableGroup,
    cargoMount,
    wheelsMesh,
    scissorsMesh,
    statusMat,
    spec: S,
    wcid: S.wcid,
    maxDrawCalls: S.maxDrawCalls,
    get liftHeightM() { return liftHeightM; },
    get turntableYawRad() { return turntableYawRad; },
    get wheelSpinL() { return wheelSpinL; },
    get wheelSpinR() { return wheelSpinR; },
    get statusMode() { return statusMode; },
    get carriedWcid() { return carriedWcid; },
    get mountedCargo() { return mountedCargo; },
    update,
    dispose,
  };
}
