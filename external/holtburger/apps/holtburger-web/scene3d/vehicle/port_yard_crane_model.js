// scene3d/vehicle/port_yard_crane_model.js — Rail-Mounted Gantry (RMG) & Rubber-Tyred Gantry (RTG)
// Yard Cranes (30 m span, 14.5 m lift, 8 steered RTG tires, telescoping 20ft/40ft spreader)
// PLUS High-Efficiency Instanced Container Stack Pool (200+ ISO 20ft/40ft/40HC boxes in <= 6 DC)
// PLUS shared 1-DC compact ISO container builder for hoisted/carried cargo.
//
// Strict GPU budgets:
//   - buildYardCrane (RMG / RTG): <= 12 draw calls (11 DC unloaded, 12 DC loaded)
//   - createContainerStackPool: <= 6 draw calls for 200..500+ ISO containers across all 6 liveries
//   - 0 dynamic THREE.Light instances (lightCountDelta === 0), AGX HDR PBR + 3-cascade CSM patching.

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
} from "./deployable_models.js";
import {
  PORT_WCID,
  PORT_CONTAINER_WCID,
  ISO_CONTAINERS,
  PORT_CONTAINER_LIVERIES,
  PORT_LIVERY_KEYS,
  STS_CRANE_SPECS,
  YARD_CRANE_SPECS,
  resolvePortContainerSpec,
} from "./port_specs.js";

export const manifest = Object.freeze({
  id: "vfx-port-yard-crane-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

const HALF_PI = Math.PI * 0.5;
const HC_SCALE_Z = ISO_CONTAINERS[4000022].extH / ISO_CONTAINERS[4000021].extH; // 2.896 / 2.591

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function resolvePortLiveryHex(liveryIdOrKey) {
  if (typeof liveryIdOrKey === "string") {
    const trimmed = liveryIdOrKey.trim();
    if (PORT_CONTAINER_LIVERIES[trimmed]) return PORT_CONTAINER_LIVERIES[trimmed].hex;
    const asNum = Number(trimmed);
    if (trimmed !== "" && Number.isInteger(asNum)) {
      const key = PORT_LIVERY_KEYS[((asNum % PORT_LIVERY_KEYS.length) + PORT_LIVERY_KEYS.length) % PORT_LIVERY_KEYS.length];
      return PORT_CONTAINER_LIVERIES[key].hex;
    }
  }
  if (typeof liveryIdOrKey === "number" && Number.isFinite(liveryIdOrKey)) {
    const idx = ((Math.trunc(liveryIdOrKey) % PORT_LIVERY_KEYS.length) + PORT_LIVERY_KEYS.length) % PORT_LIVERY_KEYS.length;
    return PORT_CONTAINER_LIVERIES[PORT_LIVERY_KEYS[idx]].hex;
  }
  return PORT_CONTAINER_LIVERIES.maritimeBlue.hex;
}

function disposeObjectTree(root, extras = []) {
  const disposedG = new Set();
  const disposedM = new Set();
  const visit = (o) => {
    if (!o) return;
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
  };
  if (root) root.traverse(visit);
  for (const ex of extras) visit(ex);
}

// ===========================================================================
// Shared Compact 1-Draw-Call ISO Container Visual (for STS / Yard Cranes / Shuttles)
// Local frame: X in [-W/2, +W/2], Y in [-L/2, +L/2] (+Y front / reefer, -Y doors), Z in [0, H]
// ===========================================================================
export function buildCompactIsoContainer(three, containerMeta = {}, options = {}) {
  const t = three || THREE_DEFAULT;
  const meta = containerMeta && typeof containerMeta === "object" ? containerMeta : { kind: containerMeta };
  const spec = resolvePortContainerSpec(meta.wcid ?? meta.kind ?? meta.containerKind ?? meta.sizeFt ?? "40ft");
  const liveryHex = resolvePortLiveryHex(meta.livery ?? meta.liveryId ?? meta.liveryKey ?? 0);
  const isReefer = Boolean(meta.reefer);

  const pal = makeLinearPalette(t, {
    body: liveryHex,
    casting: 0x2a2f35,
    aperture: 0x111316,
    lockBar: 0xa2a9b0,
    gasket: 0x1a1c1f,
    decalWhite: 0xe8ecf0,
    chevronYellow: 0xf2b00c,
    chevronBlack: 0x17191c,
    reeferWhite: 0xe5eaef,
    reeferGrille: 0x2c343d,
    reeferBlue: 0x1b6ca8,
  });

  const W = spec.extW;
  const L = spec.extL;
  const H = spec.extH;
  const hw = W * 0.5;
  const hl = L * 0.5;
  const acc = new GeomAcc(3);

  // Core corrugated box shell (inset slightly so ribs & castings read cleanly)
  const ribCol = cShade(pal.body, 0.88);
  const railCol = cShade(pal.body, 0.78);
  acc.box(0, 0, H * 0.5, hw - 0.025, hl - 0.025, H * 0.5 - 0.015, pal.body, cShade(pal.body, 0.84));

  // Side vertical corrugation ribs (authentic shipping container texture under sun/CSM)
  const ribCount = spec.sizeFt === 20 ? 12 : 24;
  const ribSpanY = L - 0.52;
  for (let i = 0; i < ribCount; i++) {
    const ry = -ribSpanY * 0.5 + ((i + 0.5) / ribCount) * ribSpanY;
    acc.box(-hw + 0.012, ry, H * 0.5, 0.012, 0.065, H * 0.5 - 0.16, ribCol, cShade(ribCol, 0.84));
    acc.box(+hw - 0.012, ry, H * 0.5, 0.012, 0.065, H * 0.5 - 0.16, ribCol, cShade(ribCol, 0.84));
  }
  // Roof transverse corrugation ribs
  const roofRibs = spec.sizeFt === 20 ? 8 : 16;
  for (let i = 0; i < roofRibs; i++) {
    const ry = -ribSpanY * 0.5 + ((i + 0.5) / roofRibs) * ribSpanY;
    acc.box(0, ry, H - 0.008, hw - 0.12, 0.06, 0.008, ribCol, ribCol);
  }
  // Top & bottom side rails + 4 corner posts
  for (const sx of [-1, 1]) {
    acc.box(sx * (hw - 0.05), 0, 0.075, 0.05, hl - 0.14, 0.075, railCol, cShade(railCol, 0.8));
    acc.box(sx * (hw - 0.045), 0, H - 0.045, 0.045, hl - 0.14, 0.045, railCol, cShade(railCol, 0.85));
    for (const sy of [-1, 1]) {
      acc.box(sx * (hw - 0.075), sy * (hl - 0.075), H * 0.5, 0.075, 0.075, H * 0.5 - 0.118, railCol, cShade(railCol, 0.82));
    }
  }

  // 8x ISO 1161 Cast-Steel Corner Castings (exact corner casting centers)
  const ccX = spec.twistlockHalfX;
  const ccY = spec.twistlockHalfY;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const cz of [0.059, H - 0.059]) {
        acc.box(sx * ccX, sy * ccY, cz, 0.081, 0.089, 0.059, pal.casting, cShade(pal.casting, 0.82));
      }
    }
  }

  // Rear twin doors (-Y): gasket, 4 galvanized locking bars, white BIC plate
  acc.box(0, -hl + 0.012, H * 0.5, 0.025, 0.012, H * 0.44, pal.gasket, pal.gasket);
  for (const bx of [-0.82, -0.34, +0.34, +0.82]) {
    acc.box(bx, -hl + 0.008, H * 0.5, 0.018, 0.018, H * 0.45, pal.lockBar, cShade(pal.lockBar, 0.84));
  }
  acc.box(+0.56, -hl + 0.015, H * 0.82, 0.34, 0.006, 0.08, pal.decalWhite, pal.decalWhite);
  // Exterior side white BIC stencil markings
  for (const sx of [-1, 1]) {
    acc.box(sx * (hw - 0.004), hl - 1.15, H - 0.38, 0.004, 0.65, 0.09, pal.decalWhite, pal.decalWhite);
  }

  // 20ft forklift pockets
  if (spec.sizeFt === 20) {
    for (const py of [-1.025, +1.025]) {
      acc.box(0, py, 0.075, hw - 0.01, 0.18, 0.06, pal.aperture, pal.aperture);
    }
  }

  // 40HC yellow/black corner hazard chevrons
  if (spec.wcid === PORT_CONTAINER_WCID.IsoContainer40HC) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        acc.box(sx * (hw - 0.045), sy * (hl - 0.08), H - 0.16, 0.045, 0.08, 0.07, pal.chevronYellow, pal.chevronYellow);
        acc.box(sx * (hw - 0.045), sy * (hl - 0.08), H - 0.30, 0.045, 0.08, 0.07, pal.chevronBlack, pal.chevronBlack);
      }
    }
  }

  // Optional Reefer Refrigeration Unit bulkhead at +Y front wall
  if (isReefer) {
    acc.box(0, hl - 0.06, H * 0.5, hw - 0.16, 0.06, H * 0.43, pal.reeferWhite, cShade(pal.reeferWhite, 0.88));
    acc.box(0, hl - 0.01, H * 0.68, 0.78, 0.03, 0.34, pal.reeferGrille, pal.reeferGrille);
    acc.box(0, hl - 0.01, H * 0.28, 0.62, 0.03, 0.24, pal.reeferBlue, cShade(pal.reeferBlue, 0.8));
  }

  const geom = acc.toBufferGeometry(t);
  const mat = makeDeployablePbrMaterial(t, { roughness: 0.72, metalness: 0.28, csmState: options.csmState });
  const mesh = new t.Mesh(geom, mat);
  mesh.name = `compact-iso-container-${spec.key}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return {
    mesh,
    spec,
    wcid: spec.wcid,
    liveryHex,
    isReefer,
    dispose() {
      geom.dispose();
      mat.dispose();
    },
  };
}

// ===========================================================================
// 1. High-Efficiency Instanced Container Stack Pool (<= 6 DC for 200+ Boxes)
//    - DC 1: pool-body-20ft      (tinted via setColorAt in all 6 liveries)
//    - DC 2: pool-body-40ft      (tinted via setColorAt; scaled Z for 40HC)
//    - DC 3: pool-hardware-20ft  (unpainted corner castings, door bars, BIC, pockets)
//    - DC 4: pool-hardware-40ft  (unpainted corner castings, door bars, BIC; scaled Z for 40HC)
//    - DC 5: pool-chevrons-40hc  (ISO 6346 yellow/black 40HC top corner chevrons)
//    - DC 6: pool-reefer-units   (front-wall white marine refrigeration bulkheads)
// ===========================================================================

function buildInstancedBodyGeom(t, sizeFt) {
  const spec = sizeFt === 20 ? ISO_CONTAINERS[4000020] : ISO_CONTAINERS[4000021];
  const W = spec.extW;
  const L = spec.extL;
  const H = spec.extH;
  const hw = W * 0.5;
  const hl = L * 0.5;
  const acc = new GeomAcc(3);

  // Neutral white-to-gray AO shading so InstancedMesh.setColorAt tints cleanly to exact livery color!
  const panelTop = [1.0, 1.0, 1.0];
  const panelBot = [0.82, 0.82, 0.82];
  const ribTop = [0.88, 0.88, 0.88];
  const ribBot = [0.74, 0.74, 0.74];
  const railTop = [0.80, 0.80, 0.80];
  const railBot = [0.66, 0.66, 0.66];

  acc.box(0, 0, H * 0.5, hw - 0.025, hl - 0.025, H * 0.5 - 0.015, panelTop, panelBot);

  const ribCount = sizeFt === 20 ? 12 : 24;
  const ribSpanY = L - 0.52;
  for (let i = 0; i < ribCount; i++) {
    const ry = -ribSpanY * 0.5 + ((i + 0.5) / ribCount) * ribSpanY;
    acc.box(-hw + 0.012, ry, H * 0.5, 0.012, 0.068, H * 0.5 - 0.16, ribTop, ribBot);
    acc.box(+hw - 0.012, ry, H * 0.5, 0.012, 0.068, H * 0.5 - 0.16, ribTop, ribBot);
  }
  const roofRibs = sizeFt === 20 ? 8 : 14;
  for (let i = 0; i < roofRibs; i++) {
    const ry = -ribSpanY * 0.5 + ((i + 0.5) / roofRibs) * ribSpanY;
    acc.box(0, ry, H - 0.008, hw - 0.12, 0.06, 0.008, ribTop, ribTop);
  }
  for (const sx of [-1, 1]) {
    acc.box(sx * (hw - 0.05), 0, 0.075, 0.05, hl - 0.14, 0.075, railTop, railBot);
    acc.box(sx * (hw - 0.045), 0, H - 0.045, 0.045, hl - 0.14, 0.045, railTop, railBot);
    for (const sy of [-1, 1]) {
      acc.box(sx * (hw - 0.075), sy * (hl - 0.075), H * 0.5, 0.075, 0.075, H * 0.5 - 0.118, railTop, railBot);
    }
  }
  return acc.toBufferGeometry(t);
}

function buildInstancedHardwareGeom(t, sizeFt) {
  const spec = sizeFt === 20 ? ISO_CONTAINERS[4000020] : ISO_CONTAINERS[4000021];
  const W = spec.extW;
  const L = spec.extL;
  const H = spec.extH;
  const hw = W * 0.5;
  const hl = L * 0.5;
  const pal = makeLinearPalette(t, {
    casting: 0x2b3036,
    aperture: 0x111316,
    lockBar: 0xa6adb4,
    gasket: 0x1b1d20,
    decalWhite: 0xeaeef2,
  });
  const acc = new GeomAcc(3);

  // 8x ISO 1161 Cast-Steel Corner Castings
  const ccX = spec.twistlockHalfX;
  const ccY = spec.twistlockHalfY;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const cz of [0.059, H - 0.059]) {
        acc.box(sx * ccX, sy * ccY, cz, 0.081, 0.089, 0.059, pal.casting, cShade(pal.casting, 0.80));
      }
    }
  }
  // Rear doors (-Y): gasket seam, 4 galvanized locking bars, white BIC plate
  acc.box(0, -hl + 0.012, H * 0.5, 0.024, 0.012, H * 0.44, pal.gasket, pal.gasket);
  for (const bx of [-0.82, -0.34, +0.34, +0.82]) {
    acc.box(bx, -hl + 0.008, H * 0.5, 0.018, 0.018, H * 0.45, pal.lockBar, cShade(pal.lockBar, 0.84));
  }
  acc.box(+0.56, -hl + 0.012, H * 0.82, 0.34, 0.006, 0.08, pal.decalWhite, pal.decalWhite);
  // Exterior side white BIC stencil markings
  for (const sx of [-1, 1]) {
    acc.box(sx * (hw - 0.003), hl - 1.15, H - 0.38, 0.004, 0.65, 0.09, pal.decalWhite, pal.decalWhite);
  }
  // 20ft forklift pockets
  if (sizeFt === 20) {
    for (const py of [-1.025, +1.025]) {
      acc.box(0, py, 0.075, hw - 0.008, 0.18, 0.06, pal.aperture, pal.aperture);
    }
  }
  return acc.toBufferGeometry(t);
}

function build40HcChevronGeom(t) {
  const spec = ISO_CONTAINERS[4000022];
  const hw = spec.extW * 0.5;
  const hl = spec.extL * 0.5;
  const H = spec.extH;
  const pal = makeLinearPalette(t, { yellow: 0xf4b20c, black: 0x16181b });
  const acc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      acc.box(sx * (hw - 0.042), sy * (hl - 0.08), H - 0.16, 0.046, 0.084, 0.072, pal.yellow, pal.yellow);
      acc.box(sx * (hw - 0.042), sy * (hl - 0.08), H - 0.30, 0.046, 0.084, 0.072, pal.black, pal.black);
    }
  }
  return acc.toBufferGeometry(t);
}

function buildReeferUnitGeom(t) {
  // Mounted at container +Y front end; centered at (0, 0, 0) in reefer-unit local space
  const pal = makeLinearPalette(t, {
    white: 0xe6ebf0,
    silver: 0xb6bfc8,
    grille: 0x262d36,
    blue: 0x1a68a6,
    green: 0x28c85a,
  });
  const acc = new GeomAcc(3);
  // White insulated refrigeration bulkhead frame (2.06 m wide x 0.16 m deep x 2.15 m tall)
  acc.box(0, 0.0, 1.28, 1.03, 0.08, 1.06, pal.white, cShade(pal.white, 0.88));
  // Upper evaporator/condenser dark louver grille + dual circular fan housings
  acc.box(0, 0.065, 1.78, 0.82, 0.03, 0.36, pal.grille, pal.grille);
  acc.cylinder(-0.38, 0.075, 1.78, 0.24, 0.04, 12, pal.silver, "y");
  acc.cylinder(+0.38, 0.075, 1.78, 0.24, 0.04, 12, pal.silver, "y");
  // Lower compressor access door + blue Thermo-control badge + status indicator bar
  acc.box(0, 0.065, 0.72, 0.74, 0.03, 0.34, pal.blue, cShade(pal.blue, 0.80));
  acc.box(+0.58, 0.085, 1.18, 0.18, 0.02, 0.08, pal.green, pal.green);
  return acc.toBufferGeometry(t);
}

export function createContainerStackPool(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const maxInstances = Math.max(1, Math.trunc(Number.isFinite(opts.maxInstances) ? opts.maxInstances : 320));
  const originArr = Array.isArray(opts.origin) ? opts.origin : [0, 0, 0];
  const ox = Number.isFinite(originArr[0]) ? originArr[0] : 0;
  const oy = Number.isFinite(originArr[1]) ? originArr[1] : 0;
  const oz = Number.isFinite(originArr[2]) ? originArr[2] : 0;

  const root = new t.Group();
  root.name = "port-container-stack-pool";
  root.position.set(ox, oy, oz);
  root.userData = { containerStackPool: true, maxInstances, maxDrawCalls: YARD_CRANE_SPECS.stackPoolMaxDrawCalls };

  const makeInst = (name, geom, mat, withInstanceColor = false) => {
    const mesh = new t.InstancedMesh(geom, mat, maxInstances);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    if (withInstanceColor) {
      mesh.setColorAt(0, new t.Color(0xffffff));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  };

  // Materials (all CSM-patched PBR, 0 dynamic lights)
  const bodyMat = makeDeployablePbrMaterial(t, { roughness: 0.74, metalness: 0.24, csmState });
  bodyMat.userData.__vfxSetKey = "port-inst-container-body";
  const hwMat = makeDeployablePbrMaterial(t, { roughness: 0.56, metalness: 0.58, csmState });
  const chevMat = makeDeployablePbrMaterial(t, { roughness: 0.65, metalness: 0.18, csmState });
  const reeferMat = makeDeployablePbrMaterial(t, { roughness: 0.45, metalness: 0.35, csmState });

  // 6 InstancedMeshes = <= 6 draw calls for 200..500+ containers!
  const body20Mesh = makeInst("pool-body-20ft", buildInstancedBodyGeom(t, 20), bodyMat, true);
  const body40Mesh = makeInst("pool-body-40ft", buildInstancedBodyGeom(t, 40), bodyMat, true);
  const hw20Mesh = makeInst("pool-hardware-20ft", buildInstancedHardwareGeom(t, 20), hwMat, false);
  const hw40Mesh = makeInst("pool-hardware-40ft", buildInstancedHardwareGeom(t, 40), hwMat, false);
  const chev40HcMesh = makeInst("pool-chevrons-40hc", build40HcChevronGeom(t), chevMat, false);
  const reeferMesh = makeInst("pool-reefer-units", buildReeferUnitGeom(t), reeferMat, false);

  const items = new Map(); // id -> normalized record

  // Reusable zero-alloc scratch objects
  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler(0, 0, 0, "ZYX");
  const _c = new t.Color();

  function normalizeEntry(id, entry) {
    const e = entry && typeof entry === "object" ? entry : {};
    const spec = resolvePortContainerSpec(e.wcid ?? e.kind ?? e.containerKind ?? e.sizeFt ?? "40ft");
    const useLocal = Boolean(opts.useLocalPos);
    const rx = Number.isFinite(e.x) ? e.x : (Array.isArray(e.pos) ? e.pos[0] : 0);
    const ry = Number.isFinite(e.y) ? e.y : (Array.isArray(e.pos) ? e.pos[1] : 0);
    const rz = Number.isFinite(e.z) ? e.z : (Array.isArray(e.pos) ? (e.pos[2] ?? 0) : 0);
    const lx = useLocal ? rx : rx - ox;
    const ly = useLocal ? ry : ry - oy;
    const lz = useLocal ? rz : rz - oz;
    const heading = Number.isFinite(e.heading) ? e.heading : 0.0;
    const liveryHex = resolvePortLiveryHex(e.livery ?? e.liveryId ?? e.liveryKey ?? 0);
    return {
      id: String(id),
      wcid: spec.wcid,
      kind: spec.kind,
      sizeFt: spec.sizeFt,
      is40Hc: spec.wcid === PORT_CONTAINER_WCID.IsoContainer40HC,
      extL: spec.extL,
      extH: spec.extH,
      x: rx,
      y: ry,
      z: rz,
      lx,
      ly,
      lz,
      heading,
      liveryHex,
      reefer: Boolean(e.reefer),
    };
  }

  function commit() {
    let i20 = 0;
    let i40 = 0;
    let iHc = 0;
    let iRf = 0;

    for (const rec of items.values()) {
      _e.set(0, 0, -rec.heading);
      _q.setFromEuler(_e);
      _p.set(rec.lx, rec.ly, rec.lz);

      if (rec.sizeFt === 20) {
        if (i20 < maxInstances) {
          _s.set(1, 1, 1);
          _m.compose(_p, _q, _s);
          body20Mesh.setMatrixAt(i20, _m);
          hw20Mesh.setMatrixAt(i20, _m);
          _c.setHex(rec.liveryHex);
          body20Mesh.setColorAt(i20, _c);
          i20++;
        }
      } else {
        if (i40 < maxInstances) {
          const sz = rec.is40Hc ? HC_SCALE_Z : 1.0;
          _s.set(1, 1, sz);
          _m.compose(_p, _q, _s);
          body40Mesh.setMatrixAt(i40, _m);
          hw40Mesh.setMatrixAt(i40, _m);
          _c.setHex(rec.liveryHex);
          body40Mesh.setColorAt(i40, _c);
          i40++;
        }
        if (rec.is40Hc && iHc < maxInstances) {
          _s.set(1, 1, 1);
          _m.compose(_p, _q, _s);
          chev40HcMesh.setMatrixAt(iHc, _m);
          iHc++;
        }
      }

      if (rec.reefer && iRf < maxInstances) {
        // Place white reefer refrigeration unit flush at container's +Y front bulkhead in rotated frame
        const sinH = Math.sin(rec.heading);
        const cosH = Math.cos(rec.heading);
        const frontOff = rec.extL * 0.5 - 0.04;
        _p.set(rec.lx + sinH * frontOff, rec.ly + cosH * frontOff, rec.lz);
        _s.set(1, 1, rec.is40Hc ? HC_SCALE_Z : 1.0);
        _m.compose(_p, _q, _s);
        reeferMesh.setMatrixAt(iRf, _m);
        iRf++;
      }
    }

    body20Mesh.count = i20;
    hw20Mesh.count = i20;
    body40Mesh.count = i40;
    hw40Mesh.count = i40;
    chev40HcMesh.count = iHc;
    reeferMesh.count = iRf;

    for (const m of [body20Mesh, hw20Mesh, body40Mesh, hw40Mesh, chev40HcMesh, reeferMesh]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    return { total: items.size, count20: i20, count40: i40, count40Hc: iHc, countReefer: iRf };
  }

  function add(id, entry, addOpts = null) {
    if (id === undefined || id === null) return false;
    const key = String(id);
    if (!items.has(key) && items.size >= maxInstances) {
      return false;
    }
    items.set(key, normalizeEntry(key, entry));
    if (!addOpts?.deferCommit) commit();
    return true;
  }

  function update(id, patch, updOpts = null) {
    if (id === undefined || id === null) return false;
    const key = String(id);
    const prev = items.get(key);
    if (!prev) return false;
    const merged = {
      x: patch?.x ?? prev.x,
      y: patch?.y ?? prev.y,
      z: patch?.z ?? prev.z,
      heading: patch?.heading ?? prev.heading,
      wcid: patch?.wcid ?? patch?.kind ?? patch?.containerKind ?? prev.wcid,
      livery: patch?.livery ?? patch?.liveryId ?? patch?.liveryKey ?? prev.liveryHex,
      reefer: patch?.reefer ?? prev.reefer,
    };
    if (typeof merged.livery === "number" && merged.livery > 10) {
      // Preserve hex directly if no livery change was supplied
      const nextRec = normalizeEntry(key, { ...merged, livery: 0 });
      nextRec.liveryHex = prev.liveryHex;
      items.set(key, nextRec);
    } else {
      items.set(key, normalizeEntry(key, merged));
    }
    if (!updOpts?.deferCommit) commit();
    return true;
  }

  function remove(id, remOpts = null) {
    if (id === undefined || id === null) return false;
    const deleted = items.delete(String(id));
    if (deleted && !remOpts?.deferCommit) commit();
    return deleted;
  }

  function clear() {
    items.clear();
    commit();
  }

  function syncFromEntries(entries) {
    items.clear();
    if (entries) {
      const iterable = typeof entries.values === "function" ? entries.values() : entries;
      let idx = 0;
      for (const e of iterable) {
        if (!e || items.size >= maxInstances) break;
        const key = e.key ?? e.id ?? `C_${idx++}`;
        items.set(String(key), normalizeEntry(key, e));
      }
    }
    return commit();
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    items.clear();
    disposeObjectTree(root);
  }

  return {
    root,
    meshes: { body20Mesh, body40Mesh, hw20Mesh, hw40Mesh, chev40HcMesh, reeferMesh },
    maxInstances,
    maxDrawCalls: YARD_CRANE_SPECS.stackPoolMaxDrawCalls,
    get count() {
      return items.size;
    },
    add,
    set: add,
    update,
    remove,
    has(id) {
      return items.has(String(id));
    },
    get(id) {
      return items.get(String(id)) ?? null;
    },
    list() {
      return Array.from(items.values());
    },
    clear,
    commit,
    syncFromEntries,
    dispose,
  };
}

// ===========================================================================
// 2. Rail-Mounted Gantry (RMG) & Rubber-Tyred Gantry (RTG) Yard Cranes
//    Span: 30.0 m (y = +-15.0 m), Lift: 14.5 m, Telescoping 20/40ft Spreader,
//    RTG features 8 large rubber tires in 4 steered 0 <-> 90 deg bogie yokes!
//    Budget: <= 12 draw calls (11 DC unloaded, 12 DC loaded), 0 dynamic lights.
// ===========================================================================

function buildRtgWheelGeom(t, pal) {
  // Large heavy off-road port RTG tire (radius 0.85 m, width 0.44 m), axle along Y (rolls along X when steer=0)
  const acc = new GeomAcc(3);
  acc.cylinder(0, 0, 0, 0.85, 0.44, 18, pal.rubber, "y", true, true, cShade(pal.rubber, 0.82));
  acc.cylinder(0, 0, 0, 0.48, 0.46, 14, pal.rimYellow, "y", true, true, cShade(pal.rimYellow, 0.85));
  acc.cylinder(0, 0, 0, 0.18, 0.50, 10, pal.steelDark, "y");
  // Subtle tread shoulder blocks around circumference for crisp visual spin feedback
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const cx = Math.cos(a) * 0.83;
    const cz = Math.sin(a) * 0.83;
    acc.box(cx, 0, cz, 0.045, 0.23, 0.045, pal.rubberTread, pal.rubber);
  }
  return acc.toBufferGeometry(t);
}

function buildRtgYokeGeom(t, pal) {
  // Articulated 90 deg steering bogie yoke housing holding a dual tire pair along Y
  const acc = new GeomAcc(3);
  acc.bevelBox(0, 0, 0.92, 0.92, 0.82, 0.20, 0.12, pal.steelDark, cShade(pal.steelDark, 0.8));
  acc.cylinder(0, 0, 1.24, 0.26, 0.46, 10, pal.accent, "z");
  acc.box(0, 0, 0.0, 0.18, 0.85, 0.18, pal.steelMid, pal.steelDark);
  // Mudguard / hazard bumper ends along +/-X
  for (const sx of [-0.95, +0.95]) {
    acc.box(sx, 0, 0.55, 0.08, 0.78, 0.45, pal.yellow, pal.steelDark);
  }
  return acc.toBufferGeometry(t);
}

function buildRmgWheelGeom(t, pal) {
  // Flanged steel rail wheel (radius 0.42 m), axle along Y (rolls along X on RMG rails)
  const acc = new GeomAcc(3);
  acc.cylinder(0, 0, 0, 0.42, 0.22, 16, pal.steelBright, "y");
  acc.cylinder(0, +0.10, 0, 0.47, 0.04, 16, pal.steelMid, "y");
  acc.cylinder(0, -0.10, 0, 0.47, 0.04, 16, pal.steelMid, "y");
  acc.cylinder(0, 0, 0, 0.16, 0.28, 10, pal.steelDark, "y");
  return acc.toBufferGeometry(t);
}

function buildRmgBogieGeom(t, pal) {
  const acc = new GeomAcc(3);
  acc.bevelBox(0, 0, 0.56, 1.35, 0.46, 0.34, 0.10, pal.steelDark, cShade(pal.steelDark, 0.8));
  acc.box(0, 0, 0.98, 1.10, 0.42, 0.14, pal.accent, cShade(pal.accent, 0.82));
  for (const sx of [-1.42, +1.42]) {
    acc.box(sx, 0, 0.38, 0.10, 0.36, 0.24, pal.yellow, pal.steelDark);
  }
  return acc.toBufferGeometry(t);
}

function buildTwistlockPinGeom(t, pal) {
  const acc = new GeomAcc(3);
  acc.cylinder(0, 0, 0.04, 0.048, 0.08, 8, pal.steelMid, "z");
  acc.box(0, 0, -0.055, 0.095, 0.052, 0.045, pal.yellow, cShade(pal.yellow, 0.82));
  return acc.toBufferGeometry(t);
}

export function buildYardCrane(three, typeOrOpts = "RMG", options = {}) {
  const t = three || THREE_DEFAULT;
  let typeStr = "RMG";
  let opts = options && typeof options === "object" ? options : {};
  if (typeof typeOrOpts === "string") {
    typeStr = typeOrOpts.toUpperCase() === "RTG" ? "RTG" : "RMG";
  } else if (typeOrOpts && typeof typeOrOpts === "object") {
    opts = typeOrOpts;
    typeStr = String(opts.type || "RMG").toUpperCase() === "RTG" ? "RTG" : "RMG";
  }
  const isRtg = typeStr === "RTG";
  const csmState = opts.csmState;
  const S = YARD_CRANE_SPECS;
  const halfSpan = S.spanM * 0.5; // 15.0 m
  const bridgeBotZ = 15.30;
  const bridgeTopZ = 16.90;
  const trolleyRailZ = 15.10;
  const hoistTopZ = 14.70;
  const legSpreadX = 4.20; // +/-4.2 m leg base along X

  const pal = makeLinearPalette(t, {
    primary: opts.bodyHex ?? (isRtg ? 0xe05e12 : 0x1a5490),
    primaryDark: isRtg ? 0xab4208 : 0x103966,
    accent: isRtg ? 0xf2b20c : 0xe4e8ee,
    yellow: 0xf2b20c,
    rimYellow: 0xe6a814,
    steelDark: 0x252a30,
    steelMid: 0x525a64,
    steelBright: 0x9aa4ae,
    galv: 0x949ea8,
    rubber: 0x181a1e,
    rubberTread: 0x121417,
    white: 0xf0f4f8,
    red: 0xd92620,
    lampAmber: 0xffa818,
    lampRed: 0xff2820,
    lampGreen: 0x22ee66,
  });

  const root = new t.Group();
  root.name = `port-yard-crane-${typeStr.toLowerCase()}-root`;
  root.userData = {
    wcid: isRtg ? S.rtgWcid : S.rmgWcid,
    kind: isRtg ? S.rtgKind : S.rmgKind,
    craneType: typeStr,
    maxDrawCalls: S.maxDrawCalls,
  };

  // =========================================================================
  // DC 1: Main Gantry Portal Frame, Sill Beams, Twin Bridge Box Girders, Walkways & Powerpack
  // =========================================================================
  const stAcc = new GeomAcc(3);
  const sillZ = isRtg ? 1.85 : 1.35;

  for (const sy of [-1, 1]) {
    const legY = sy * halfSpan;
    // Longitudinal sill beam connecting front & rear bogies (x in [-5.6, +5.6])
    stAcc.bevelBox(0, legY, sillZ, 5.60, 0.58, 0.42, 0.08, pal.primary, pal.primaryDark);
    // Hazard yellow/black end aprons on sill beams
    for (const sx of [-5.62, +5.62]) {
      stAcc.box(sx, legY, sillZ, 0.06, 0.54, 0.36, pal.yellow, pal.steelDark);
    }
    // A-frame twin sloped portal legs converging from (x = +-4.2, z = sillZ+0.3) to (x = +-1.55, z = bridgeBotZ)
    for (const sx of [-1, 1]) {
      const pBot = [sx * legSpreadX, legY, sillZ + 0.30];
      const pTop = [sx * 1.55, legY, bridgeBotZ + 0.45];
      stAcc.tube(pBot, pTop, 0.42, 0.34, 8, pal.primary, pal.primaryDark, true, true);
      // Lower diagonal knee gusset
      stAcc.tube([sx * 2.2, legY, sillZ + 0.30], [sx * 3.1, legY, sillZ + 3.2], 0.14, 0.12, 6, pal.primaryDark, pal.primaryDark);
    }
    // Mid-height & upper horizontal portal bracing tie-beams between A-frame legs
    stAcc.box(0, legY, 7.2, 3.05, 0.24, 0.26, pal.primaryDark, pal.primaryDark);
    stAcc.box(0, legY, 13.8, 1.90, 0.30, 0.30, pal.accent, cShade(pal.accent, 0.82));
  }

  // Twin parallel box-section overhead bridge girders spanning Y in [-15.8, +15.8] at x = +-1.55 m
  for (const sx of [-1.55, +1.55]) {
    stAcc.bevelBox(sx, 0, 0.5 * (bridgeBotZ + bridgeTopZ), 0.46, halfSpan + 0.80, 0.80, 0.08, pal.primary, pal.primaryDark);
    // Trolley running rail along inner lower flange
    stAcc.box(sx - Math.sign(sx) * 0.44, 0, trolleyRailZ, 0.08, halfSpan - 0.6, 0.08, pal.steelBright, pal.steelDark);
  }
  // End bridge cross-ties & upper maintenance catwalk + yellow safety handrails
  for (const ey of [-halfSpan, +halfSpan]) {
    stAcc.box(0, ey, bridgeTopZ - 0.25, 1.90, 0.62, 0.45, pal.primaryDark, pal.primaryDark);
  }
  stAcc.box(+2.28, 0, bridgeTopZ + 0.06, 0.36, halfSpan + 0.4, 0.04, pal.galv, pal.steelMid);
  stAcc.box(+2.62, 0, bridgeTopZ + 1.05, 0.03, halfSpan + 0.4, 0.03, pal.yellow, pal.yellow);
  for (let py = -halfSpan; py <= halfSpan; py += 3.0) {
    stAcc.box(+2.62, py, bridgeTopZ + 0.55, 0.03, 0.03, 0.50, pal.yellow, pal.yellow);
  }

  // RTG Diesel-Electric Genset Enclosure vs RMG Electric Cable-Reel House on south sill
  if (isRtg) {
    stAcc.bevelBox(0, -halfSpan, sillZ + 1.35, 2.55, 0.92, 0.92, 0.10, pal.accent, cShade(pal.accent, 0.82));
    stAcc.box(0, -halfSpan - 0.94, sillZ + 1.45, 1.60, 0.04, 0.48, pal.steelDark, pal.steelDark); // radiator louver
    stAcc.cylinder(+2.10, -halfSpan, sillZ + 2.65, 0.10, 0.90, 8, pal.steelMid, "z"); // exhaust stack
  } else {
    // RMG motorized high-voltage cable reel drum & electrical E-house cabinet
    stAcc.cylinder(-2.8, -halfSpan - 0.72, sillZ + 0.85, 0.95, 0.45, 14, pal.steelDark, "y");
    stAcc.cylinder(-2.8, -halfSpan - 0.72, sillZ + 0.85, 0.65, 0.50, 12, pal.yellow, "y");
    stAcc.bevelBox(+1.2, -halfSpan, sillZ + 1.25, 1.80, 0.80, 0.85, 0.08, pal.accent, cShade(pal.accent, 0.84));
  }

  const structMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.44, csmState });
  const structMesh = new t.Mesh(stAcc.toBufferGeometry(t), structMat);
  structMesh.name = "yard-crane-gantry-mesh";
  structMesh.castShadow = true;
  structMesh.receiveShadow = true;
  root.add(structMesh);

  // =========================================================================
  // DC 2 & DC 3: Articulated Bogies + 8 Wheels (RTG: 8 large steered rubber tires; RMG: 8 rail wheels)
  // =========================================================================
  const bogiePositions = [
    [-legSpreadX, -halfSpan],
    [+legSpreadX, -halfSpan],
    [-legSpreadX, +halfSpan],
    [+legSpreadX, +halfSpan],
  ];

  const bogieGeom = isRtg ? buildRtgYokeGeom(t, pal) : buildRmgBogieGeom(t, pal);
  const bogieMat = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.55, csmState });
  const bogiesInst = new t.InstancedMesh(bogieGeom, bogieMat, 4);
  bogiesInst.name = isRtg ? "yard-crane-rtg-bogies-instanced" : "yard-crane-rmg-bogies-instanced";
  bogiesInst.castShadow = true;
  bogiesInst.receiveShadow = true;
  bogiesInst.frustumCulled = false;
  root.add(bogiesInst);

  const wheelGeom = isRtg ? buildRtgWheelGeom(t, pal) : buildRmgWheelGeom(t, pal);
  const wheelMat = makeDeployablePbrMaterial(t, { roughness: isRtg ? 0.78 : 0.36, metalness: isRtg ? 0.14 : 0.78, csmState });
  const wheelsInst = new t.InstancedMesh(wheelGeom, wheelMat, 8);
  wheelsInst.name = isRtg ? "yard-crane-rtg-wheels-instanced" : "yard-crane-rmg-wheels-instanced";
  wheelsInst.castShadow = true;
  wheelsInst.receiveShadow = true;
  wheelsInst.frustumCulled = false;
  root.add(wheelsInst);

  // =========================================================================
  // DC 4 & DC 5: Travelling Trolley Carriage + Glazed Operator Cab
  // =========================================================================
  const trolleyGroup = new t.Group();
  trolleyGroup.name = "yard-crane-trolley-group";
  trolleyGroup.position.set(0, 0, trolleyRailZ);
  root.add(trolleyGroup);

  const trAcc = new GeomAcc(3);
  // Trolley frame spanning across both bridge rails (x in [-1.5, +1.5], y in [-1.5, +1.5])
  trAcc.bevelBox(0, 0, 0.32, 1.48, 1.50, 0.24, 0.08, pal.steelDark, cShade(pal.steelDark, 0.8));
  // Hoist winch drum & motor on trolley deck
  trAcc.cylinder(0, 0, 0.82, 0.44, 1.80, 12, pal.yellow, "x");
  // Under-slung operator / optical sensor cab at x = +1.75
  trAcc.bevelBox(+1.75, 0, -1.10, 0.72, 1.15, 0.92, 0.08, pal.white, pal.galv);
  trAcc.box(+1.75, 0, -0.15, 0.76, 1.18, 0.10, pal.primary, pal.primaryDark);

  const trolleyMat = makeDeployablePbrMaterial(t, { roughness: 0.45, metalness: 0.52, csmState });
  const trolleyMesh = new t.Mesh(trAcc.toBufferGeometry(t), trolleyMat);
  trolleyMesh.name = "yard-crane-trolley-mesh";
  trolleyMesh.castShadow = true;
  trolleyMesh.receiveShadow = true;
  trolleyGroup.add(trolleyMesh);

  const cabGlassAcc = new GeomAcc(3);
  const glassCol = [0.64, 0.84, 0.95];
  cabGlassAcc.box(+1.75, 0, -1.32, 0.75, 1.05, 0.56, glassCol, glassCol);
  const cabGlassMat = new t.MeshStandardMaterial({
    color: 0xaad8f0,
    vertexColors: true,
    roughness: 0.14,
    metalness: 0.68,
    transparent: true,
    opacity: 0.52,
  });
  cabGlassMat.userData.__vfxSetKey = "port-glass";
  if (csmState) installCsmShaderPatch(cabGlassMat, csmState);
  const cabGlassMesh = new t.Mesh(cabGlassAcc.toBufferGeometry(t), cabGlassMat);
  cabGlassMesh.name = "yard-crane-cab-glass-mesh";
  trolleyGroup.add(cabGlassMesh);

  // =========================================================================
  // DC 6: 4-Wire Hoist Reeving (unit height 1.0 m hanging from z = 0 to z = -1.0, scaled dynamically)
  // =========================================================================
  const wireAcc = new GeomAcc(3);
  for (const wx of [-1.05, +1.05]) {
    for (const wy of [-0.95, +0.95]) {
      wireAcc.cylinder(wx, wy, -0.50, 0.024, 1.0, 6, pal.steelBright, "z", false, false);
    }
  }
  const wireMat = makeDeployablePbrMaterial(t, { roughness: 0.36, metalness: 0.80, csmState });
  const hoistWiresMesh = new t.Mesh(wireAcc.toBufferGeometry(t), wireMat);
  hoistWiresMesh.name = "yard-crane-hoist-wires-mesh";
  hoistWiresMesh.position.set(0, 0, hoistTopZ - trolleyRailZ);
  hoistWiresMesh.castShadow = true;
  trolleyGroup.add(hoistWiresMesh);

  // =========================================================================
  // DC 7..10: Telescoping 20ft/40ft ISO Spreader (Main + Left/Right Arms + 4 Twistlocks)
  //           Underside twistlock latch plane strictly at spreaderGroup local z = 0.0!
  //           Oriented East-West (telescoping along crane X, width 2.438 m along crane Y)
  // =========================================================================
  const spreaderGroup = new t.Group();
  spreaderGroup.name = "yard-crane-spreader-group";
  spreaderGroup.position.set(0, 0, S.spreaderSafeZ);
  root.add(spreaderGroup);

  const spMainAcc = new GeomAcc(3);
  // Central telescoping box housing (x in [-2.6, +2.6], y in [-1.15, +1.15], z in [0.05, 0.65])
  spMainAcc.bevelBox(0, 0, 0.36, 2.55, 0.56, 0.28, 0.06, pal.yellow, cShade(pal.yellow, 0.84));
  // Headblock sheave housing atop center frame (z in [0.64, 1.05])
  spMainAcc.bevelBox(0, 0, 0.84, 1.25, 1.08, 0.20, 0.06, pal.steelDark, cShade(pal.steelDark, 0.8));
  for (const sx of [-1.05, +1.05]) {
    for (const sy of [-0.95, +0.95]) {
      spMainAcc.cylinder(sx, sy, 0.92, 0.16, 0.10, 10, pal.steelBright, "x");
    }
  }
  const spMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.48, csmState });
  const spreaderMainMesh = new t.Mesh(spMainAcc.toBufferGeometry(t), spMat);
  spreaderMainMesh.name = "yard-crane-spreader-main-mesh";
  spreaderMainMesh.castShadow = true;
  spreaderMainMesh.receiveShadow = true;
  spreaderGroup.add(spreaderMainMesh);

  // Telescoping Left (-X) and Right (+X) end-beams + corner guide flippers
  const buildArmMesh = (signX) => {
    const aAcc = new GeomAcc(3);
    // Inner telescopic box-beam sliding inside central frame
    aAcc.box(-signX * 1.60, 0, 0.36, 1.55, 0.38, 0.21, pal.steelDark, cShade(pal.steelDark, 0.8));
    // End cross-beam spanning full container width (y in [-1.26, +1.26]) centered at x_local = 0
    aAcc.bevelBox(0, 0, 0.30, 0.24, 1.26, 0.28, 0.05, pal.yellow, cShade(pal.yellow, 0.84));
    // Corner alignment guide flippers at y = +-1.28 m
    for (const sy of [-1, 1]) {
      aAcc.box(signX * 0.10, sy * 1.28, 0.02, 0.14, 0.04, 0.24, pal.primary, pal.primaryDark);
    }
    const m = new t.Mesh(aAcc.toBufferGeometry(t), spMat);
    m.name = signX < 0 ? "yard-crane-spreader-arm-left" : "yard-crane-spreader-arm-right";
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const leftArmMesh = buildArmMesh(-1);
  const rightArmMesh = buildArmMesh(+1);
  spreaderGroup.add(leftArmMesh, rightArmMesh);

  // 4 rotating ISO 1161 twistlock heads (InstancedMesh, count = 4)
  const tlMat = makeDeployablePbrMaterial(t, { roughness: 0.38, metalness: 0.72, csmState });
  const twistlocksInst = new t.InstancedMesh(buildTwistlockPinGeom(t, pal), tlMat, 4);
  twistlocksInst.name = "yard-crane-twistlocks-instanced";
  twistlocksInst.castShadow = true;
  twistlocksInst.frustumCulled = false;
  spreaderGroup.add(twistlocksInst);

  // Cargo mount under spreader (bottom of container sits at -spec.extH so top castings sit flush at z = 0.0!)
  const cargoMount = new t.Group();
  cargoMount.name = "yard-crane-cargo-mount";
  spreaderGroup.add(cargoMount);

  // =========================================================================
  // DC 11: Emissive Warning Beacons & Obstruction Lights (0 dynamic lights!)
  // =========================================================================
  const lampAcc = new GeomAcc(3);
  for (const sy of [-1, 1]) {
    for (const sx of [-4.8, +4.8]) {
      lampAcc.cylinder(sx, sy * halfSpan, sillZ + 0.55, 0.12, 0.22, 8, pal.lampAmber, "z");
    }
    lampAcc.cylinder(0, sy * (halfSpan + 0.35), bridgeTopZ + 0.45, 0.14, 0.26, 8, pal.lampRed, "z");
  }
  const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 1.05, roughness: 0.25 });
  lampsMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(lampsMat, csmState);
  const beaconsMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
  beaconsMesh.name = "yard-crane-beacons-mesh";
  root.add(beaconsMesh);

  // =========================================================================
  // Dynamic State & Zero-Alloc Articulation Update
  // =========================================================================
  const _m = new t.Matrix4();
  const _mSpin = new t.Matrix4();
  const _mSteer = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler(0, 0, 0, "ZYX");

  let curTrolleyY = 0.0;
  let curSpreaderZ = S.spreaderSafeZ;
  let curSpreaderLen = STS_CRANE_SPECS.spreaderLen40M;
  let curTwistlockAngle = 0.0;
  let curWheelSteerRad = 0.0;
  let curWheelSpinRad = 0.0;
  let mountedCargoKey = null;
  let mountedCargo = null;

  function syncBogiesAndWheels() {
    const steer = isRtg ? clamp(curWheelSteerRad, -HALF_PI, HALF_PI) : 0.0;
    const wheelZ = isRtg ? 0.85 : 0.42;
    const bogieZ = isRtg ? 0.85 : 0.42;
    const dualOffsets = isRtg ? [-0.52, +0.52] : [-0.72, +0.72]; // RTG: side-by-side along Y; RMG: tandem along X

    _mSteer.makeRotationZ(-steer);
    _mSpin.makeRotationY(curWheelSpinRad); // axle along Y -> rolls along +X when steer=0

    let wIdx = 0;
    for (let b = 0; b < 4; b++) {
      const [bx, by] = bogiePositions[b];
      _e.set(0, 0, -steer);
      _q.setFromEuler(_e);
      _p.set(bx, by, bogieZ);
      _m.compose(_p, _q, _s);
      bogiesInst.setMatrixAt(b, _m);

      for (let d = 0; d < 2; d++) {
        const off = dualOffsets[d];
        let wx = bx;
        let wy = by;
        if (isRtg) {
          // Local offset (0, off, 0) rotated by -steer around Z
          wx = bx + Math.sin(steer) * off;
          wy = by + Math.cos(steer) * off;
        } else {
          wx = bx + off;
        }
        _m.makeTranslation(wx, wy, wheelZ);
        _m.multiply(_mSteer);
        _m.multiply(_mSpin);
        wheelsInst.setMatrixAt(wIdx++, _m);
      }
    }
    bogiesInst.instanceMatrix.needsUpdate = true;
    wheelsInst.instanceMatrix.needsUpdate = true;
  }

  function syncSpreaderAndWires() {
    const localSpreaderZ = clamp(curSpreaderZ - root.position.z, 0.4, hoistTopZ - 1.10);
    trolleyGroup.position.set(0, curTrolleyY, trolleyRailZ);
    spreaderGroup.position.set(0, curTrolleyY, localSpreaderZ);

    const wireLen = Math.max(0.20, hoistTopZ - (localSpreaderZ + 0.92));
    hoistWiresMesh.scale.set(1, 1, wireLen);

    const halfLen = clamp(curSpreaderLen, STS_CRANE_SPECS.spreaderLen20M, STS_CRANE_SPECS.spreaderLen40M) * 0.5;
    const armX = halfLen - 0.105; // places twistlock pins at exact ISO 1161 casting centers (+-2.9265 / +-5.9925)
    leftArmMesh.position.set(-armX, 0, 0);
    rightArmMesh.position.set(+armX, 0, 0);

    const tlX = halfLen - 0.1035;
    const tlY = 1.1295;
    _e.set(0, 0, curTwistlockAngle);
    _q.setFromEuler(_e);
    let idx = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        _p.set(sx * tlX, sy * tlY, 0.0);
        _m.compose(_p, _q, _s);
        twistlocksInst.setMatrixAt(idx++, _m);
      }
    }
    twistlocksInst.instanceMatrix.needsUpdate = true;
  }

  function syncCarriedContainer(carried) {
    if (!carried) {
      if (mountedCargo) {
        if (mountedCargo.mesh.parent === cargoMount) cargoMount.remove(mountedCargo.mesh);
        mountedCargo.dispose();
        mountedCargo = null;
        mountedCargoKey = null;
      }
      return;
    }
    const spec = resolvePortContainerSpec(carried.wcid ?? carried.kind ?? carried.containerKind ?? carried.sizeFt ?? "40ft");
    const livHex = resolvePortLiveryHex(carried.livery ?? carried.liveryId ?? carried.liveryKey ?? 0);
    const key = `${spec.wcid}:${livHex}:${carried.reefer ? 1 : 0}`;
    if (mountedCargoKey === key && mountedCargo) return;

    if (mountedCargo) {
      if (mountedCargo.mesh.parent === cargoMount) cargoMount.remove(mountedCargo.mesh);
      mountedCargo.dispose();
      mountedCargo = null;
    }
    mountedCargo = buildCompactIsoContainer(t, { wcid: spec.wcid, livery: carried.livery ?? carried.liveryId ?? 0, reefer: carried.reefer }, { csmState });
    // Orient container East-West (heading = PI/2 -> rotation.z = -PI/2) flush beneath spreader underside (z = 0)
    mountedCargo.mesh.rotation.set(0, 0, -HALF_PI);
    mountedCargo.mesh.position.set(0, 0, -spec.extH);
    cargoMount.add(mountedCargo.mesh);
    mountedCargoKey = key;
  }

  function update(state = null) {
    if (state && typeof state === "object") {
      if (Number.isFinite(state.x)) root.position.x = state.x;
      if (Number.isFinite(state.y)) root.position.y = state.y;
      if (Number.isFinite(state.z)) root.position.z = state.z;
      if (Number.isFinite(state.trolleyY)) curTrolleyY = clamp(state.trolleyY, -13.0, +13.0);
      if (Number.isFinite(state.spreaderZ)) curSpreaderZ = clamp(state.spreaderZ, S.spreaderMinZ, S.spreaderMaxZ);
      if (Number.isFinite(state.spreaderLen)) curSpreaderLen = clamp(state.spreaderLen, STS_CRANE_SPECS.spreaderLen20M, STS_CRANE_SPECS.spreaderLen40M);
      if (Number.isFinite(state.twistlockAngle)) curTwistlockAngle = clamp(state.twistlockAngle, 0.0, HALF_PI);
      if (Number.isFinite(state.wheelSteerRad)) curWheelSteerRad = clamp(state.wheelSteerRad, -HALF_PI, HALF_PI);
      if (Number.isFinite(state.wheelSpinRad)) curWheelSpinRad = state.wheelSpinRad;
      if (state.carriedContainer !== undefined) syncCarriedContainer(state.carriedContainer);
      if (Number.isFinite(state.timeSec) || state.active !== undefined) {
        const tSec = Number.isFinite(state.timeSec) ? state.timeSec : 0;
        lampsMat.emissiveIntensity = state.active ? (1.25 + 0.45 * Math.sin(tSec * 6.0)) : 0.85;
      }
    }
    syncBogiesAndWheels();
    syncSpreaderAndWires();
  }

  update(opts.initialState || {});

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    syncCarriedContainer(null);
    disposeObjectTree(root);
  }

  return {
    root,
    type: typeStr,
    isRtg,
    wcid: isRtg ? S.rtgWcid : S.rmgWcid,
    maxDrawCalls: S.maxDrawCalls,
    structMesh,
    bogiesInst,
    wheelsInst,
    trolleyGroup,
    spreaderGroup,
    leftArmMesh,
    rightArmMesh,
    twistlocksInst,
    hoistWiresMesh,
    cargoMount,
    beaconsMesh,
    lampsMat,
    get wheelSteerRad() { return curWheelSteerRad; },
    get trolleyY() { return curTrolleyY; },
    get spreaderZ() { return curSpreaderZ; },
    get spreaderLen() { return curSpreaderLen; },
    get twistlockAngle() { return curTwistlockAngle; },
    get mountedCargo() { return mountedCargo; },
    update,
    dispose,
  };
}

export function buildRmgCrane(three, options = {}) {
  return buildYardCrane(three, "RMG", options);
}

export function buildRtgCrane(three, options = {}) {
  return buildYardCrane(three, "RTG", options);
}
