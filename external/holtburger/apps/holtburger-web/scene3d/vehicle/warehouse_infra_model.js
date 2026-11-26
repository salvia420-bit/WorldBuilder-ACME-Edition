// scene3d/vehicle/warehouse_infra_model.js — Concrete Apron & Lane Markings,
// P&D Transfer Stands, Floor-to-AMR Scissor Lift Tables, and Charging Docks.
//
// Strict GPU budgets:
//   - buildConcreteApron: <= 3 draw calls for entire 120 x 90 m yard, z = +0.004 m with polygonOffset
//   - buildTransferStandGroup: <= 2 draw calls for entire yard (1 InstancedMesh + lazy highlight)
//   - buildChargingDockGroup: 2 draw calls (<= 3 combined with TransferStandGroup)
//   - buildScissorLiftTable: <= 4 draw calls unloaded, animated split-rail U-deck (0.000 <-> 0.380 m)
//   - 0 THREE.Light instances across all builders, AGX HDR PBR + 3-cascade CSM shader patching.

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
import {
  NE_FLATLAND_SITE,
  WAREHOUSE_WCID,
  STAND_SPECS,
  LIFT_TABLE_SPECS,
  CHARGER_SPECS,
  buildDefaultHubLayout,
} from "./warehouse_specs.js";

export const manifest = Object.freeze({
  id: "vfx-warehouse-infra-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

const HIGHLIGHT_STATES = Object.freeze({
  reachable: Object.freeze({ hex: 0x22dd66, intensity: 1.4, opacity: 0.78 }),
  blocked: Object.freeze({ hex: 0xff4422, intensity: 1.5, opacity: 0.82 }),
  target: Object.freeze({ hex: 0x55ffbb, intensity: 2.6, opacity: 0.94 }),
});

const LIFT_STATUS_COLORS = Object.freeze({
  idle: 0x44aa77,
  transit: 0x22ee66,
  lifting: 0xffa818,
  blocked: 0xff2820,
  ready: 0x22ee66,
});

const CHARGER_STATUS_COLORS = Object.freeze({
  ready: 0x22ee66,
  idle: 0x22ee66,
  standby: 0x4488cc,
  charging: 0x18d8ff,
  fault: 0xff2820,
  blocked: 0xff2820,
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeHighlightBorderGeom(t, w = 1.100, d = 1.100) {
  const acc = new GeomAcc(3);
  const bw = 0.035;
  const bh = 0.008;
  const hw = w * 0.5;
  const hd = d * 0.5;
  const col = [1, 1, 1];
  acc.box(0, +hd - bw * 0.5, 0, hw, bw * 0.5, bh * 0.5, col, col);
  acc.box(0, -hd + bw * 0.5, 0, hw, bw * 0.5, bh * 0.5, col, col);
  acc.box(-hw + bw * 0.5, 0, 0, bw * 0.5, Math.max(0.025, hd - bw), bh * 0.5, col, col);
  acc.box(+hw - bw * 0.5, 0, 0, bw * 0.5, Math.max(0.025, hd - bw), bh * 0.5, col, col);
  return acc.toBufferGeometry(t);
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

function addOutlineBox(acc, cx, cy, zBot, zTop, w, d, lineW, col) {
  const cz = 0.5 * (zBot + zTop);
  const hz = 0.5 * (zTop - zBot);
  const hw = w * 0.5;
  const hd = d * 0.5;
  const lw = lineW * 0.5;
  acc.box(cx, cy + hd - lw, cz, hw, lw, hz, col, col);
  acc.box(cx, cy - hd + lw, cz, hw, lw, hz, col, col);
  acc.box(cx - hw + lw, cy, cz, lw, Math.max(0.02, hd - lineW), hz, col, col);
  acc.box(cx + hw - lw, cy, cz, lw, Math.max(0.02, hd - lineW), hz, col, col);
}

function disposeObjectTree(root, extras = []) {
  const disposedG = new Set();
  const disposedM = new Set();
  const disposeOne = (o) => {
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
  if (root) root.traverse(disposeOne);
  for (const ex of extras) disposeOne(ex);
}

// ===========================================================================
// 1. Concrete Apron & Lane Markings (<= 3 draw calls, z = +0.004 m)
// ===========================================================================
export function buildConcreteApron(three, layout = null, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const hub = layout && typeof layout === "object" ? layout : buildDefaultHubLayout();
  const originArr = opts.origin || hub.origin || NE_FLATLAND_SITE.origin;
  const ox = Number.isFinite(originArr[0]) ? originArr[0] : NE_FLATLAND_SITE.origin[0];
  const oy = Number.isFinite(originArr[1]) ? originArr[1] : NE_FLATLAND_SITE.origin[1];
  const oz = Number.isFinite(originArr[2]) ? originArr[2] : NE_FLATLAND_SITE.origin[2];

  const slabW = hub.slabBounds?.width ?? 120.0;
  const slabD = hub.slabBounds?.depth ?? 90.0;
  const apronZ = NE_FLATLAND_SITE.apronVisualZ; // +0.004

  const pal = makeLinearPalette(t, {
    concrete: 0x7b8086,
    concreteJoint: 0x61666c,
    concreteBorder: 0x565b61,
    yellow: 0xe6aa18,
    white: 0xdbe0e5,
    qrDark: 0x1e2228,
    amber: 0xd97d14,
  });

  const root = new t.Group();
  root.name = "warehouse-concrete-apron-root";
  root.position.set(ox, oy, oz);
  root.userData = { warehouseApron: true, apronVisualZ: apronZ };

  // ---- DC 1: Concrete Slab & Expansion Joint Grid ----
  const slabAcc = new GeomAcc(3);
  const tileW = 15.0;
  const tileD = 15.0;
  const nx = Math.max(1, Math.round(slabW / tileW));
  const ny = Math.max(1, Math.round(slabD / tileD));
  const stepX = slabW / nx;
  const stepY = slabD / ny;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const cx = -slabW * 0.5 + (ix + 0.5) * stepX;
      const cy = -slabD * 0.5 + (iy + 0.5) * stepY;
      const shadeFactor = ((ix + iy) % 2 === 0) ? 1.0 : 0.96;
      slabAcc.box(
        cx,
        cy,
        apronZ * 0.5,
        stepX * 0.5 - 0.015,
        stepY * 0.5 - 0.015,
        apronZ * 0.5,
        cShade(pal.concrete, shadeFactor),
        cShade(pal.concreteJoint, shadeFactor)
      );
    }
  }
  // Slab perimeter apron curb band (flush top at apronZ)
  addOutlineBox(slabAcc, 0, 0, 0.0, apronZ, slabW, slabD, 0.35, pal.concreteBorder);

  const slabMat = makeDeployablePbrMaterial(t, { roughness: 0.88, metalness: 0.04, csmState });
  slabMat.polygonOffset = true;
  slabMat.polygonOffsetFactor = -1;
  slabMat.polygonOffsetUnits = -1;
  const slabMesh = new t.Mesh(slabAcc.toBufferGeometry(t), slabMat);
  slabMesh.name = "apron-concrete-mesh";
  slabMesh.castShadow = false;
  slabMesh.receiveShadow = true;
  root.add(slabMesh);

  // ---- DC 2: Safety-Yellow Zone Markings, Drop Pads, Staging Bays & AGF Centerlines ----
  const markAcc = new GeomAcc(3);
  const zMarkBot = apronZ;
  const zMarkTop = apronZ + 0.002;
  const zMarkMid = 0.5 * (zMarkBot + zMarkTop);
  const zMarkHz = 0.5 * (zMarkTop - zMarkBot);

  // Zone A ISO Container Drop Pad outlines & hatch bars
  const pads = Array.isArray(hub.dropPads) ? hub.dropPads : [];
  for (const pad of pads) {
    const lx = pad.localPos ? pad.localPos[0] : (pad.pos[0] - ox);
    const ly = pad.localPos ? pad.localPos[1] : (pad.pos[1] - oy);
    const len = pad.containerKind === "20ft" ? 6.06 : 12.20;
    addOutlineBox(markAcc, lx, ly, zMarkBot, zMarkTop, 2.75, len + 0.30, 0.14, pal.yellow);
    markAcc.box(lx, ly - len * 0.5 - 0.60, zMarkMid, 1.30, 0.45, zMarkHz, pal.amber, pal.amber);
  }

  // Zone B 12 Floor Staging Bay outlines (1.10 x 1.10 m)
  const staging = Array.isArray(hub.stagingBays) ? hub.stagingBays : [];
  for (const sb of staging) {
    const lx = sb.localPos ? sb.localPos[0] : (sb.pos[0] - ox);
    const ly = sb.localPos ? sb.localPos[1] : (sb.pos[1] - oy);
    addOutlineBox(markAcc, lx, ly, zMarkBot, zMarkTop, 1.24, 1.24, 0.07, pal.yellow);
  }

  // Zone C AGF Aisle centerlines & Cross-Aisle Highway borders
  const aisles = Array.isArray(hub.aisles) ? hub.aisles : [];
  for (const ai of aisles) {
    const ly = Number.isFinite(ai.localY) ? ai.localY : (ai.y - oy);
    for (let dx = -16.0; dx <= +7.0; dx += 2.2) {
      markAcc.box(dx, ly, zMarkMid, 0.65, 0.06, zMarkHz, pal.yellow, pal.yellow);
    }
  }
  // Main cross-aisle highway (y = +16..+24) & Zone D lane borders (y = -22, -32)
  markAcc.box(0, +16.0, zMarkMid, 52.0, 0.08, zMarkHz, pal.yellow, pal.yellow);
  markAcc.box(0, +24.0, zMarkMid, 52.0, 0.08, zMarkHz, pal.yellow, pal.yellow);
  markAcc.box(0, -22.0, zMarkMid, 52.0, 0.08, zMarkHz, pal.yellow, pal.yellow);
  markAcc.box(-28.0, -3.0, zMarkMid, 0.08, 19.0, zMarkHz, pal.yellow, pal.yellow);

  const markMat = makeDeployablePbrMaterial(t, { roughness: 0.70, metalness: 0.08, csmState });
  markMat.polygonOffset = true;
  markMat.polygonOffsetFactor = -2;
  markMat.polygonOffsetUnits = -2;
  const markMesh = new t.Mesh(markAcc.toBufferGeometry(t), markMat);
  markMesh.name = "apron-markings-mesh";
  markMesh.castShadow = false;
  markMesh.receiveShadow = true;
  root.add(markMesh);

  // ---- DC 3: AMR QR/Fiducial Floor Markers & White Highway Center Stripes ----
  const fidAcc = new GeomAcc(3);
  const zFidBot = apronZ + 0.0005;
  const zFidTop = apronZ + 0.0025;
  const zFidMid = 0.5 * (zFidBot + zFidTop);
  const zFidHz = 0.5 * (zFidTop - zFidBot);

  // Dashed white Zone D AMR highway centerline at y = -29.0
  for (let lx = -48.0; lx <= +32.0; lx += 3.0) {
    fidAcc.box(lx, -29.0, zFidMid, 0.70, 0.05, zFidHz, pal.white, pal.white);
  }
  // AMR QR/fiducial squares at graph nodes in Zone C/D
  const nodes = Array.isArray(hub.graph?.nodes) ? hub.graph.nodes : [];
  for (const n of nodes) {
    if (!n.allowedModes || !n.allowedModes.includes("amr")) continue;
    const lx = n.localPos ? n.localPos[0] : (n.x - ox);
    const ly = n.localPos ? n.localPos[1] : (n.y - oy);
    fidAcc.box(lx, ly, zFidMid, 0.14, 0.14, zFidHz, pal.white, pal.white);
    fidAcc.box(lx, ly, zFidMid + 0.0003, 0.09, 0.09, zFidHz, pal.qrDark, pal.qrDark);
  }

  const fidMat = makeDeployablePbrMaterial(t, { roughness: 0.68, metalness: 0.10, csmState });
  fidMat.polygonOffset = true;
  fidMat.polygonOffsetFactor = -2;
  fidMat.polygonOffsetUnits = -2;
  const fidMesh = new t.Mesh(fidAcc.toBufferGeometry(t), fidMat);
  fidMesh.name = "apron-fiducials-mesh";
  fidMesh.castShadow = false;
  fidMesh.receiveShadow = true;
  root.add(fidMesh);

  return {
    root,
    slabMesh,
    markMesh,
    fidMesh,
    bounds: hub.slabBounds,
    dispose() {
      disposeObjectTree(root);
    },
  };
}

// ===========================================================================
// 2. P&D Transfer Stands (Single + Batched Group <= 2 DC)
// ===========================================================================
function buildTransferStandGeom(t) {
  const S = STAND_SPECS;
  const pal = makeLinearPalette(t, {
    steel: 0x383e46,
    steelDark: 0x22262c,
    yellow: 0xf0b20c,
    orange: 0xe85a10,
  });
  const acc = new GeomAcc(3);

  // Side leg frames & floor anchor baseplates keeping x in [-0.430, +0.430], z in [0, 0.360] 100% clear
  const legInnerX = S.railInnerX; // 0.430
  const legOuterX = S.outerWidthM * 0.5; // 0.640
  const legMidX = 0.5 * (legInnerX + legOuterX); // 0.535
  const legHalfW = 0.5 * (legOuterX - legInnerX); // 0.105
  const halfD = S.outerDepthM * 0.5; // 0.570
  const railMidX = 0.5 * (S.railInnerX + S.railOuterX); // 0.495
  const railHalfW = S.railWidthM * 0.5; // 0.065
  const railTopZ = S.railHeightM; // 0.380
  const railBotZ = S.railHeightM - S.railThicknessM; // 0.360

  for (const sx of [-1, 1]) {
    // 2 vertical corner leg posts per side (at y = ±0.450, strictly outside [-0.430, +0.430])
    for (const sy of [-1, 1]) {
      const ly = sy * (halfD - 0.08);
      acc.box(sx * legMidX, ly, 0.008, legHalfW, 0.08, 0.008, pal.steelDark, cShade(pal.steelDark, 0.8));
      acc.box(sx * (S.railInnerX + 0.055), ly, railBotZ * 0.5, 0.055, 0.055, railBotZ * 0.5, pal.steel, pal.steelDark);
    }
    // Lower longitudinal tie bar on outer side
    acc.box(sx * (S.railInnerX + 0.055), 0, 0.08, 0.032, halfD - 0.10, 0.032, pal.steel, pal.steelDark);
    // Top pallet support rail (z in [0.360, 0.380], x in ±[0.430, 0.560])
    acc.box(
      sx * railMidX,
      0,
      0.5 * (railBotZ + railTopZ),
      railHalfW,
      halfD,
      S.railThicknessM * 0.5,
      pal.steel,
      pal.steelDark
    );
    // Flared safety-yellow pallet centering ears at corners (x in ±[0.560, 0.640], z in [0.360, 0.425])
    for (const sy of [-1, 1]) {
      acc.box(sx * 0.600, sy * (halfD - 0.10), 0.3925, 0.040, 0.095, 0.0325, pal.yellow, cShade(pal.yellow, 0.85));
    }
    // Front/back yellow safety corner bumpers on legs
    acc.box(sx * 0.545, +halfD - 0.025, 0.20, 0.055, 0.015, 0.16, pal.yellow, cShade(pal.yellow, 0.85));
    acc.box(sx * 0.545, -halfD + 0.025, 0.20, 0.055, 0.015, 0.16, pal.yellow, cShade(pal.yellow, 0.85));
  }

  return acc.toBufferGeometry(t);
}

export function buildTransferStandGroup(three, standDefs = [], options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const defs = Array.isArray(standDefs) && standDefs.length > 0
    ? standDefs
    : [{ id: "S1", localPos: [0, 0, 0], pos: [0, 0, 0], heading: 0 }];

  const originArr = opts.origin || [0, 0, 0];
  const ox = Number.isFinite(originArr[0]) ? originArr[0] : 0;
  const oy = Number.isFinite(originArr[1]) ? originArr[1] : 0;
  const oz = Number.isFinite(originArr[2]) ? originArr[2] : 0;

  const root = new t.Group();
  root.name = "warehouse-transfer-stand-group";
  root.position.set(ox, oy, oz);
  root.userData = { wcid: WAREHOUSE_WCID.TransferStand, kind: STAND_SPECS.kind };

  // ---- DC 1: Instanced Transfer Stands ----
  const standGeom = buildTransferStandGeom(t);
  const standMat = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.55, csmState });
  const instMesh = new t.InstancedMesh(standGeom, standMat, defs.length);
  instMesh.name = "transfer-stands-instanced";
  instMesh.castShadow = true;
  instMesh.receiveShadow = true;
  instMesh.frustumCulled = false;

  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler();

  const standRecords = [];
  const idToIndex = new Map();

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i] || {};
    const lx = Array.isArray(d.pos) && !opts.useLocalPos
      ? d.pos[0] - ox
      : Array.isArray(d.localPos)
        ? d.localPos[0]
        : 0;
    const ly = Array.isArray(d.pos) && !opts.useLocalPos
      ? d.pos[1] - oy
      : Array.isArray(d.localPos)
        ? d.localPos[1]
        : 0;
    const lz = Array.isArray(d.pos) && !opts.useLocalPos
      ? (d.pos[2] ?? oz) - oz
      : Array.isArray(d.localPos)
        ? (d.localPos[2] ?? 0)
        : 0;
    const heading = Number.isFinite(d.heading) ? d.heading : 0;

    _p.set(lx, ly, lz);
    _e.set(0, 0, -heading);
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);
    instMesh.setMatrixAt(i, _m);

    const id = typeof d.id === "string" ? d.id : `S${i + 1}`;
    standRecords.push({ index: i, id, lx, ly, lz, heading });
    idToIndex.set(id, i);
  }
  instMesh.instanceMatrix.needsUpdate = true;
  instMesh.computeBoundingBox();
  instMesh.computeBoundingSphere();
  root.add(instMesh);

  // ---- Dynamic Cargo Group ----
  const cargoGroup = new t.Group();
  cargoGroup.name = "transfer-stands-cargo";
  root.add(cargoGroup);

  const mounted = new Map(); // index -> { wcid, slotGroup, model }

  function resolveIndex(idxOrId) {
    if (typeof idxOrId === "number" && Number.isInteger(idxOrId)) {
      return idxOrId >= 0 && idxOrId < standRecords.length ? idxOrId : -1;
    }
    if (typeof idxOrId === "string" && idToIndex.has(idxOrId)) {
      return idToIndex.get(idxOrId);
    }
    return -1;
  }

  function setSlotCargo(idxOrId, wcid = 0) {
    const idx = resolveIndex(idxOrId);
    if (idx < 0) return null;
    const rec = standRecords[idx];
    const nextWcid = Number.isFinite(wcid) ? (wcid >>> 0) : 0;
    const existing = mounted.get(idx);
    if (existing && existing.wcid === nextWcid) return existing;

    if (existing) {
      if (existing.slotGroup.parent) existing.slotGroup.parent.remove(existing.slotGroup);
      if (typeof existing.model?.dispose === "function") existing.model.dispose();
      disposeObjectTree(existing.slotGroup);
      mounted.delete(idx);
    }
    if (nextWcid === 0) return null;

    const slotGroup = new t.Group();
    slotGroup.name = `transfer-stand-cargo-${rec.id}`;
    slotGroup.position.set(rec.lx, rec.ly, rec.lz + STAND_SPECS.railHeightM);
    slotGroup.rotation.z = -rec.heading;

    const model = mountStowedCargo(t, nextWcid, csmState);
    if (model?.root) {
      model.root.position.set(0, 0, 0);
      model.root.rotation.set(0, 0, 0);
      slotGroup.add(model.root);
    }
    cargoGroup.add(slotGroup);
    const entry = { index: idx, id: rec.id, wcid: nextWcid, slotGroup, model };
    mounted.set(idx, entry);
    return entry;
  }

  // ---- Lazy Slot Highlight (detached when inactive, max +1 DC) ----
  const highlightGeom = makeHighlightBorderGeom(t, 1.100, 1.100);
  const highlightMat = new t.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x22dd66,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.1,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    side: t.DoubleSide,
  });
  if (csmState) installCsmShaderPatch(highlightMat, csmState);

  const highlightMesh = new t.Mesh(highlightGeom, highlightMat);
  highlightMesh.name = "transfer-stand-highlight";
  highlightMesh.castShadow = false;
  highlightMesh.receiveShadow = false;
  highlightMesh.visible = false; // vfx-lint-allow: transfer stand highlight visibility

  function setHighlighted(idxOrId, state = null) {
    const idx = resolveIndex(idxOrId);
    const style = state ? HIGHLIGHT_STATES[state] : null;
    if (idx < 0 || !style) {
      highlightMesh.visible = false; // vfx-lint-allow: transfer stand highlight visibility
      if (highlightMesh.parent) highlightMesh.parent.remove(highlightMesh);
      return false;
    }
    const rec = standRecords[idx];
    highlightMat.emissive.setHex(style.hex);
    highlightMat.emissiveIntensity = style.intensity;
    highlightMat.opacity = style.opacity;
    highlightMesh.position.set(rec.lx, rec.ly, rec.lz + STAND_SPECS.railHeightM + 0.004);
    highlightMesh.rotation.z = -rec.heading;
    highlightMesh.visible = true; // vfx-lint-allow: transfer stand highlight visibility
    if (highlightMesh.parent !== root) root.add(highlightMesh);
    return true;
  }

  function dispose() {
    setHighlighted(null, null);
    for (const idx of Array.from(mounted.keys())) {
      setSlotCargo(idx, 0);
    }
    if (highlightMesh.parent) highlightMesh.parent.remove(highlightMesh);
    disposeObjectTree(root, [highlightMesh]);
  }

  return {
    root,
    instMesh,
    cargoGroup,
    standRecords,
    spec: STAND_SPECS,
    wcid: WAREHOUSE_WCID.TransferStand,
    setSlotCargo,
    setHighlighted,
    dispose,
  };
}

export function buildTransferStand(three, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const grp = buildTransferStandGroup(three, [{ id: "S0", localPos: [0, 0, 0], pos: [0, 0, 0], heading: 0 }], {
    ...opts,
    origin: [0, 0, 0],
    useLocalPos: true,
  });
  return {
    ...grp,
    setCargoWcid(wcid) {
      return grp.setSlotCargo(0, wcid);
    },
  };
}

// ===========================================================================
// 3. Floor-to-AMR Hydraulic Scissor Lift Table (<= 4 DC unloaded)
// ===========================================================================
export function buildScissorLiftTable(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const S = LIFT_TABLE_SPECS;

  const pal = makeLinearPalette(t, {
    steel: 0x353b44,
    steelDark: 0x20242a,
    yellow: 0xf0b20c,
    orange: 0xe85a10,
    chrome: 0xd4dae0,
    white: 0xffffff,
  });

  const root = new t.Group();
  root.name = "scissor-lift-table-root";
  root.userData = { wcid: S.wcid, kind: S.kind, scissorLiftTable: true };

  const halfW = S.outerWidthM * 0.5; // 0.670
  const halfD = S.outerDepthM * 0.5; // 0.650
  const railMidX = 0.5 * (S.railInnerX + S.railOuterX); // 0.495
  const railHalfW = S.railWidthM * 0.5; // 0.065

  // ---- DC 1: Base Frame, Floor Entry Bevel Ramps & Outer Power Pack ----
  const baseAcc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    // Side base runners (x in ±[0.430, 0.670], z in [0.000, 0.015])
    baseAcc.box(sx * 0.550, 0, 0.0075, 0.120, halfD, 0.0075, pal.steelDark, cShade(pal.steelDark, 0.8));
    // Outer hydraulic power pack / scissor channel guard (x in ±[0.575, 0.670], z in [0.015, 0.085])
    baseAcc.box(sx * 0.6225, 0, 0.050, 0.0475, halfD - 0.08, 0.035, pal.yellow, cShade(pal.yellow, 0.85));
  }
  // Flush 0.015 m beveled floor entry lead-in strips at ±Y (keeps central x in [-0.430, +0.430] low at floor)
  for (const sy of [-1, 1]) {
    baseAcc.box(0, sy * (halfD - 0.04), 0.006, S.railInnerX, 0.04, 0.006, pal.yellow, pal.steelDark);
  }
  // Hydraulic power unit box at (+0.62, -0.52)
  baseAcc.box(0.62, -0.50, 0.12, 0.05, 0.12, 0.07, pal.orange, cShade(pal.orange, 0.82));

  const baseMat = makeDeployablePbrMaterial(t, { roughness: 0.52, metalness: 0.50, csmState });
  const baseMesh = new t.Mesh(baseAcc.toBufferGeometry(t), baseMat);
  baseMesh.name = "lift-base-mesh";
  baseMesh.castShadow = true;
  baseMesh.receiveShadow = true;
  root.add(baseMesh);

  // ---- DC 2: Outer-Channel X-Scissor Arms (InstancedMesh, keeps central tunnel open!) ----
  const armLen = 0.860;
  const scissorAcc = new GeomAcc(3);
  scissorAcc.box(0, 0, 0, 0.012, armLen * 0.5, 0.012, pal.steel, pal.steelDark);
  scissorAcc.cylinder(0, 0, 0, 0.014, 0.030, 8, pal.chrome, "x");

  const scissorMat = makeDeployablePbrMaterial(t, { roughness: 0.40, metalness: 0.68, csmState });
  const scissorsMesh = new t.InstancedMesh(scissorAcc.toBufferGeometry(t), scissorMat, 4);
  scissorsMesh.name = "lift-scissors-instanced";
  scissorsMesh.castShadow = true;
  scissorsMesh.receiveShadow = true;
  scissorsMesh.frustumCulled = false;
  root.add(scissorsMesh);

  // ---- DC 3: Split Side-Rail U-Deck + cargoMount ----
  const liftDeckGroup = new t.Group();
  liftDeckGroup.name = "lift-deck-group";
  liftDeckGroup.position.set(0, 0, 0.020);
  root.add(liftDeckGroup);

  const deckAcc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    // Split pallet support rails (x in ±[0.430, 0.560], z_local in [-0.020, 0.000])
    // Top is strictly z_local = 0.000; underside is z_local = -0.020 (at 0.380 m raised -> 0.360 m clear tunnel)
    deckAcc.box(sx * railMidX, 0, -0.010, railHalfW, halfD - 0.04, 0.010, pal.steel, pal.steelDark);
    // Outer yellow guide rails (top kept at z_local = 0.000 so raised Box3.max.z === 0.380)
    deckAcc.box(sx * 0.600, 0, -0.010, 0.040, halfD - 0.06, 0.010, pal.yellow, cShade(pal.yellow, 0.85));
  }

  const deckMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.56, csmState });
  const deckMesh = new t.Mesh(deckAcc.toBufferGeometry(t), deckMat);
  deckMesh.name = "lift-deck-mesh";
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  liftDeckGroup.add(deckMesh);

  const cargoMount = new t.Group();
  cargoMount.name = "lift-cargo-mount";
  cargoMount.position.set(0, 0, -0.020);
  liftDeckGroup.add(cargoMount);

  // ---- DC 4: Side Safety Status Beacon (makeLampsMaterial + CSM) ----
  const beaconAcc = new GeomAcc(3);
  for (const sx of [-1, 1]) {
    beaconAcc.box(sx * (halfW - 0.010), +halfD - 0.10, 0.095, 0.008, 0.06, 0.016, pal.white, pal.white);
  }
  const beaconMat = makeLampsMaterial(t, { emissiveIntensity: 0.85, roughness: 0.25 });
  beaconMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(beaconMat, csmState);
  beaconMat.castShadow = true;
  beaconMat.receiveShadow = true;
  const beaconMesh = new t.Mesh(beaconAcc.toBufferGeometry(t), beaconMat);
  beaconMesh.name = "lift-beacon-mesh";
  beaconMesh.castShadow = true;
  beaconMesh.receiveShadow = true;
  root.add(beaconMesh);

  // ---- Lazy Highlight Border (detached when null) ----
  const highlightGeom = makeHighlightBorderGeom(t, 1.100, 1.100);
  const highlightMat = new t.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x22dd66,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.1,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    side: t.DoubleSide,
  });
  if (csmState) installCsmShaderPatch(highlightMat, csmState);

  const highlightMesh = new t.Mesh(highlightGeom, highlightMat);
  highlightMesh.name = "lift-table-highlight";
  highlightMesh.castShadow = false;
  highlightMesh.receiveShadow = false;
  highlightMesh.visible = false; // vfx-lint-allow: lift table highlight visibility

  // ---- Dynamic State ----
  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler();

  let heightM = S.loweredZ;
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

  function setHighlighted(state = null) {
    const style = state ? HIGHLIGHT_STATES[state] : null;
    if (!style) {
      highlightMesh.visible = false; // vfx-lint-allow: lift table highlight visibility
      if (highlightMesh.parent) highlightMesh.parent.remove(highlightMesh);
      return false;
    }
    highlightMat.emissive.setHex(style.hex);
    highlightMat.emissiveIntensity = style.intensity;
    highlightMat.opacity = style.opacity;
    highlightMesh.position.set(0, 0, Math.max(0.008, heightM + 0.004));
    highlightMesh.visible = true; // vfx-lint-allow: lift table highlight visibility
    if (highlightMesh.parent !== root) root.add(highlightMesh);
    return true;
  }

  function syncScissors(deckZ) {
    const zBot = 0.015;
    const zTop = Math.max(0.035, deckZ - 0.020);
    const zMid = 0.5 * (zBot + zTop);
    const dz = Math.max(0.020, zTop - zBot);
    const pitch = Math.asin(clamp(dz / armLen, 0.025, 0.92));
    const defs = [
      [-0.595, +pitch],
      [-0.610, -pitch],
      [+0.595, +pitch],
      [+0.610, -pitch],
    ];
    for (let i = 0; i < defs.length; i++) {
      _p.set(defs[i][0], 0, zMid);
      _e.set(defs[i][1], 0, 0);
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
    if (Number.isFinite(s.heightM)) {
      heightM = clamp(s.heightM, S.loweredZ, S.raisedZ);
    }
    if (typeof s.statusMode === "string" && LIFT_STATUS_COLORS[s.statusMode] !== undefined) {
      statusMode = s.statusMode;
    }

    const frac = heightM / S.raisedZ;
    const deckZ = S.railThicknessM + frac * (S.raisedZ - S.railThicknessM); // [0.020 .. 0.380]
    liftDeckGroup.position.set(0, 0, deckZ);
    cargoMount.position.set(0, 0, heightM - deckZ);

    syncScissors(deckZ);
    beaconMat.emissive.setHex(LIFT_STATUS_COLORS[statusMode] ?? LIFT_STATUS_COLORS.idle);

    if (highlightMesh.parent === root) {
      highlightMesh.position.z = Math.max(0.008, heightM + 0.004);
    }
    if (s.highlightState !== undefined) {
      setHighlighted(s.highlightState);
    }
    if (s.carriedWcid !== undefined) {
      setCarriedWcid(s.carriedWcid);
    }
  }

  update({
    heightM: opts.heightM ?? S.loweredZ,
    carriedWcid: opts.carriedWcid ?? 0,
    statusMode: opts.statusMode ?? "idle",
  });

  function dispose() {
    setHighlighted(null);
    setCarriedWcid(0);
    if (highlightMesh.parent) highlightMesh.parent.remove(highlightMesh);
    disposeObjectTree(root, [highlightMesh]);
  }

  return {
    root,
    liftDeckGroup,
    cargoMount,
    scissorsMesh,
    beaconMat,
    spec: S,
    wcid: S.wcid,
    maxDrawCalls: S.maxDrawCalls,
    get heightM() { return heightM; },
    get statusMode() { return statusMode; },
    get carriedWcid() { return carriedWcid; },
    get mountedCargo() { return mountedCargo; },
    setCargoWcid: setCarriedWcid,
    setHighlighted,
    update,
    dispose,
  };
}

// ===========================================================================
// 4. Inductive / Brush Charging Docks (Single + Batched Group <= 2 DC)
// ===========================================================================
function buildChargerBodyGeom(t) {
  const S = CHARGER_SPECS;
  const pal = makeLinearPalette(t, {
    slate: 0x353c45,
    slateDark: 0x1f242b,
    yellow: 0xf0b20c,
    pad: 0x2a2f36,
    brass: 0xd4a438,
    steel: 0x5c6470,
  });
  const acc = new GeomAcc(3);

  // Main power cabinet at -Y (y in [-0.45, -0.05], height 0.65 m)
  acc.bevelBox(0, -0.25, S.heightM * 0.5, S.widthM * 0.44, 0.18, S.heightM * 0.5, 0.05, pal.slate, pal.slateDark);
  // Top warning visor cap
  acc.box(0, -0.25, S.heightM - 0.025, S.widthM * 0.45, 0.19, 0.025, pal.yellow, cShade(pal.yellow, 0.85));
  // High-voltage diamond plate stencil on cabinet front (+Y face)
  acc.box(0, -0.068, 0.40, 0.09, 0.008, 0.09, pal.yellow, pal.yellow);

  // Inductive charging floor pad (0.90 x 0.70 m at y = +0.10, z in [0, 0.012])
  acc.box(0, +0.10, 0.006, S.padWidthM * 0.5, S.padLengthM * 0.5, 0.006, pal.pad, pal.slateDark);
  // Brass spring brush contacts on cabinet front
  for (const cx of [-0.09, +0.09]) {
    acc.box(cx, -0.03, 0.115, 0.032, 0.04, 0.020, pal.brass, cShade(pal.brass, 0.8));
  }
  // Angled AMR wheel guide rails extending +Y
  for (const sx of [-1, 1]) {
    acc.box(sx * (S.widthM * 0.5 - 0.04), +0.15, 0.045, 0.035, 0.30, 0.045, pal.yellow, cShade(pal.yellow, 0.85));
    acc.box(sx * (S.widthM * 0.5 - 0.04), +0.15, 0.008, 0.050, 0.32, 0.008, pal.steel, pal.slateDark);
  }

  return acc.toBufferGeometry(t);
}

function buildChargerLedGeom(t) {
  const S = CHARGER_SPECS;
  const acc = new GeomAcc(3);
  const white = [1, 1, 1];
  // Front status LED bar on cabinet upper fascia
  acc.box(0, -0.065, S.heightM - 0.09, 0.36, 0.012, 0.024, white, white);
  return acc.toBufferGeometry(t);
}

export function buildChargingDockGroup(three, dockDefs = [], options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const defs = Array.isArray(dockDefs) && dockDefs.length > 0
    ? dockDefs
    : [{ id: "CH1", localPos: [0, 0, 0], pos: [0, 0, 0], heading: 0 }];

  const originArr = opts.origin || [0, 0, 0];
  const ox = Number.isFinite(originArr[0]) ? originArr[0] : 0;
  const oy = Number.isFinite(originArr[1]) ? originArr[1] : 0;
  const oz = Number.isFinite(originArr[2]) ? originArr[2] : 0;

  const root = new t.Group();
  root.name = "warehouse-charging-dock-group";
  root.position.set(ox, oy, oz);
  root.userData = { wcid: WAREHOUSE_WCID.ChargingDock, kind: CHARGER_SPECS.kind };

  // ---- DC 1: Charger Bodies InstancedMesh ----
  const bodyGeom = buildChargerBodyGeom(t);
  const bodyMat = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.45, csmState });
  const bodyMesh = new t.InstancedMesh(bodyGeom, bodyMat, defs.length);
  bodyMesh.name = "charging-docks-body-instanced";
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = false;

  // ---- DC 2: Charger LED Status Bars InstancedMesh ----
  const ledGeom = buildChargerLedGeom(t);
  const ledMat = makeLampsMaterial(t, { emissiveIntensity: 0.90, roughness: 0.25 });
  ledMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(ledMat, csmState);
  ledMat.castShadow = true;
  ledMat.receiveShadow = true;
  const ledMesh = new t.InstancedMesh(ledGeom, ledMat, defs.length);
  ledMesh.name = "charging-docks-led-instanced";
  ledMesh.castShadow = true;
  ledMesh.receiveShadow = true;
  ledMesh.frustumCulled = false;

  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);
  const _e = new t.Euler();
  const _col = new t.Color();

  const dockRecords = [];
  const idToIndex = new Map();

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i] || {};
    const lx = Array.isArray(d.pos) && !opts.useLocalPos
      ? d.pos[0] - ox
      : Array.isArray(d.localPos)
        ? d.localPos[0]
        : 0;
    const ly = Array.isArray(d.pos) && !opts.useLocalPos
      ? d.pos[1] - oy
      : Array.isArray(d.localPos)
        ? d.localPos[1]
        : 0;
    const lz = Array.isArray(d.pos) && !opts.useLocalPos
      ? (d.pos[2] ?? oz) - oz
      : Array.isArray(d.localPos)
        ? (d.localPos[2] ?? 0)
        : 0;
    const heading = Number.isFinite(d.heading) ? d.heading : 0;

    _p.set(lx, ly, lz);
    _e.set(0, 0, -heading);
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);
    bodyMesh.setMatrixAt(i, _m);
    ledMesh.setMatrixAt(i, _m);

    _col.setHex(CHARGER_STATUS_COLORS.ready);
    ledMesh.setColorAt(i, _col);

    const id = typeof d.id === "string" ? d.id : `CH${i + 1}`;
    dockRecords.push({ index: i, id, lx, ly, lz, heading, mode: "ready" });
    idToIndex.set(id, i);
  }
  bodyMesh.instanceMatrix.needsUpdate = true;
  bodyMesh.computeBoundingBox();
  bodyMesh.computeBoundingSphere();

  ledMesh.instanceMatrix.needsUpdate = true;
  if (ledMesh.instanceColor) ledMesh.instanceColor.needsUpdate = true;
  ledMesh.computeBoundingBox();
  ledMesh.computeBoundingSphere();

  root.add(bodyMesh);
  root.add(ledMesh);

  function resolveIndex(idxOrId) {
    if (typeof idxOrId === "number" && Number.isInteger(idxOrId)) {
      return idxOrId >= 0 && idxOrId < dockRecords.length ? idxOrId : -1;
    }
    if (typeof idxOrId === "string" && idToIndex.has(idxOrId)) {
      return idToIndex.get(idxOrId);
    }
    return -1;
  }

  function setDockState(idxOrId, mode = "ready") {
    const idx = resolveIndex(idxOrId);
    if (idx < 0) return false;
    const hex = CHARGER_STATUS_COLORS[mode] ?? CHARGER_STATUS_COLORS.ready;
    dockRecords[idx].mode = mode;
    _col.setHex(hex);
    ledMesh.setColorAt(idx, _col);
    if (ledMesh.instanceColor) ledMesh.instanceColor.needsUpdate = true;
    return true;
  }

  return {
    root,
    bodyMesh,
    ledMesh,
    dockRecords,
    spec: CHARGER_SPECS,
    wcid: WAREHOUSE_WCID.ChargingDock,
    setDockState,
    dispose() {
      disposeObjectTree(root);
    },
  };
}

export function buildChargingDock(three, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const grp = buildChargingDockGroup(three, [{ id: "CH0", localPos: [0, 0, 0], pos: [0, 0, 0], heading: 0 }], {
    ...opts,
    origin: [0, 0, 0],
    useLocalPos: true,
  });
  return {
    ...grp,
    setState(mode) {
      return grp.setDockState(0, mode);
    },
  };
}
