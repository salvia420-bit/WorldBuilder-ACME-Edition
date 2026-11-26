// scene3d/vehicle/warehouse_rack_model.js — 4-Tier Selective Steel Pallet Racking (`WCID 4000040`).
//
// Merged multi-bay single or double-sided industrial selective steel racking:
//   - Cobalt-blue teardrop slotted uprights, horizontal & diagonal Z-bracing, bolted baseplates,
//     and back-to-back flue row spacers
//   - Safety-orange box-section load beams with end-plate connectors & locking clips at z = 2.35, 4.70, 7.05 m
//   - Galvanized steel wire-mesh deck panels & front-to-back pallet support bars
//   - Safety-yellow column protectors & end-of-aisle capacity placards
//
// Strict GPU budget: <= 4 structural draw calls per entire N-bay row, 0 THREE.Light instances,
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching, Z-up AC coordinates (+Y forward, +X right).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
  buildDeployable,
  buildPallet,
} from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";
import {
  RACK_SPECS,
  WAREHOUSE_WCID,
  computeRackSlotLocalPose,
  computeRackRowBounds,
} from "./warehouse_specs.js";

export const manifest = Object.freeze({
  id: "vfx-warehouse-rack-model",
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

function makeProxyPalletGeom(t) {
  const acc = new GeomAcc(3);
  const pal = makeLinearPalette(t, {
    oak: 0x8e6b47,
    steel: 0x4b535d,
    crate: 0x3b4d5e,
    trim: 0xd89014,
  });
  // Standard 1.100 x 1.100 x 0.145 m pallet base
  acc.box(0, 0, 0.0725, 0.550, 0.550, 0.0725, pal.oak, cShade(pal.oak, 0.78));
  // Stowed cargo silhouette on top (<= 1.25 m total height, within ±0.52 m)
  acc.box(0, 0, 0.645, 0.480, 0.480, 0.500, pal.crate, cShade(pal.crate, 0.80));
  acc.box(0, 0, 1.160, 0.495, 0.495, 0.020, pal.trim, pal.steel);
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

export function buildRackRow(three, config = {}, options = {}) {
  const t = three || THREE_DEFAULT;
  const cfg = config && typeof config === "object" ? config : {};
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState ?? cfg.csmState;
  const spec = cfg.spec || opts.spec || RACK_SPECS;

  const bayCount = Math.max(1, Math.trunc(Number.isFinite(cfg.bayCount) ? cfg.bayCount : 8));
  const doubleSided = Boolean(cfg.doubleSided);
  const rowId = typeof cfg.id === "string" ? cfg.id : "rack-row";
  const sideCount = doubleSided ? 2 : 1;
  const bounds = computeRackRowBounds(bayCount, doubleSided, spec);
  const maxSlots = bayCount * spec.tierCount * spec.slotsPerBay * sideCount;

  const pal = makeLinearPalette(t, {
    blue: 0x164a8a,
    blueDark: 0x0f3564,
    orange: 0xe85a10,
    orangeDark: 0xb84308,
    galv: 0x8c959e,
    galvDark: 0x677078,
    yellow: 0xf0b20c,
    steel: 0x2a2f36,
    placard: 0xeaecef,
    placardBorder: 0x1e242c,
  });

  const root = new t.Group();
  root.name = `warehouse-rack-row-${rowId}`;
  root.userData = {
    wcid: WAREHOUSE_WCID.SteelRackBay,
    kind: spec.kind,
    rowId,
    bayCount,
    doubleSided,
    bounds,
  };

  const frameCentersY = doubleSided
    ? [-spec.sideCenterOffsetY, +spec.sideCenterOffsetY]
    : [0.0];
  const halfFrameD = spec.frameDepthM * 0.5;
  const postHalfX = spec.uprightWidthM * 0.5; // 0.050
  const postHalfY = spec.uprightDepthM * 0.5; // 0.040
  const postOffsetY = halfFrameD - postHalfY; // 0.510 -> outer edge at ±0.550

  // ---- 1. Cobalt-Blue Uprights, Bracing & Flue Row Spacers (Draw Call 1) ----
  const upAcc = new GeomAcc(3);
  const braceZLevels = [0.35, 1.35, 2.35, 3.50, 4.70, 5.85, 7.05, 7.45];

  for (let b = 0; b <= bayCount; b++) {
    const ux = postHalfX + b * spec.bayPitchM;
    for (const fy of frameCentersY) {
      const yF = fy - postOffsetY;
      const yB = fy + postOffsetY;
      // Front & rear slotted teardrop C-posts (z in [0.012, 7.600])
      upAcc.box(ux, yF, 3.806, postHalfX, postHalfY, 3.794, pal.blue, pal.blueDark);
      upAcc.box(ux, yB, 3.806, postHalfX, postHalfY, 3.794, pal.blue, pal.blueDark);

      // Horizontal frame struts
      for (const bz of braceZLevels) {
        upAcc.box(ux, fy, bz, 0.022, postOffsetY - postHalfY + 0.01, 0.020, pal.blue, pal.blueDark);
      }
      // Diagonal Z-bracing between front & back posts
      for (let i = 0; i < braceZLevels.length - 1; i++) {
        const z0 = braceZLevels[i];
        const z1 = braceZLevels[i + 1];
        const y0 = i % 2 === 0 ? yF : yB;
        const y1 = i % 2 === 0 ? yB : yF;
        upAcc.tube([ux, y0, z0], [ux, y1, z1], 0.016, 0.016, 6, pal.blue, pal.blueDark, false, false);
      }
    }
    // Back-to-back row spacers across the 0.200 m flue gap
    if (doubleSided) {
      for (const sz of [1.15, 3.50, 5.85]) {
        upAcc.box(ux, 0.0, sz, 0.030, spec.rowSpacerM * 0.5 + 0.02, 0.028, pal.blueDark, cShade(pal.blueDark, 0.8));
      }
    }
  }

  const upMat = makeDeployablePbrMaterial(t, { roughness: 0.45, metalness: 0.55, csmState });
  const upMesh = new t.Mesh(upAcc.toBufferGeometry(t), upMat);
  upMesh.name = "rack-uprights-mesh";
  upMesh.castShadow = true;
  upMesh.receiveShadow = true;
  root.add(upMesh);

  // ---- 2. Safety-Orange Box Beams & End-Plate Connectors (Draw Call 2) ----
  const beamAcc = new GeomAcc(3);
  const beamHalfX = spec.baySpanM * 0.5; // 1.350
  const beamHalfZ = spec.beamHeightM * 0.5; // 0.060

  for (let b = 0; b < bayCount; b++) {
    const bxStart = spec.uprightWidthM + b * spec.bayPitchM;
    const bxCenter = bxStart + beamHalfX;
    for (const fy of frameCentersY) {
      const yF = fy - postOffsetY;
      const yB = fy + postOffsetY;
      for (let tier = 1; tier < spec.tierCount; tier++) {
        const topZ = spec.tierZ[tier];
        const cz = topZ - beamHalfZ;
        // Front & back load box beams (top strictly at tierZ[tier])
        beamAcc.box(bxCenter, yF, cz, beamHalfX, 0.028, beamHalfZ, pal.orange, pal.orangeDark);
        beamAcc.box(bxCenter, yB, cz, beamHalfX, 0.028, beamHalfZ, pal.orange, pal.orangeDark);
        // End-plate connectors & safety clips
        for (const endX of [bxStart + 0.010, bxStart + spec.baySpanM - 0.010]) {
          beamAcc.box(endX, yF, cz, 0.010, 0.036, beamHalfZ + 0.016, pal.orangeDark, cShade(pal.orangeDark, 0.82));
          beamAcc.box(endX, yB, cz, 0.010, 0.036, beamHalfZ + 0.016, pal.orangeDark, cShade(pal.orangeDark, 0.82));
        }
      }
    }
  }

  const beamMat = makeDeployablePbrMaterial(t, { roughness: 0.42, metalness: 0.35, csmState });
  const beamMesh = new t.Mesh(beamAcc.toBufferGeometry(t), beamMat);
  beamMesh.name = "rack-beams-mesh";
  beamMesh.castShadow = true;
  beamMesh.receiveShadow = true;
  root.add(beamMesh);

  // ---- 3. Galvanized Wire-Mesh Decks & Pallet Support Bars (Draw Call 3) ----
  const deckAcc = new GeomAcc(3);
  const deckSpanY = postOffsetY - 0.020; // 0.490
  for (let b = 0; b < bayCount; b++) {
    const bxStart = spec.uprightWidthM + b * spec.bayPitchM;
    const bxCenter = bxStart + beamHalfX;
    for (const fy of frameCentersY) {
      for (let tier = 1; tier < spec.tierCount; tier++) {
        const topZ = spec.tierZ[tier];
        // Front-to-back pallet support bars (3 per slot = 6 per bay)
        for (const slot of [0, 1]) {
          const sx = bxCenter + (slot === 0 ? -spec.slotOffsetX : +spec.slotOffsetX);
          for (const dx of [-0.40, 0.0, +0.40]) {
            deckAcc.box(sx + dx, fy, topZ - 0.011, 0.024, deckSpanY, 0.010, pal.galvDark, cShade(pal.galvDark, 0.82));
          }
          // Wire-mesh deck panel perimeter & cross-grid bars (strictly below topZ)
          deckAcc.box(sx, fy - deckSpanY + 0.020, topZ - 0.005, 0.56, 0.014, 0.004, pal.galv, pal.galvDark);
          deckAcc.box(sx, fy + deckSpanY - 0.020, topZ - 0.005, 0.56, 0.014, 0.004, pal.galv, pal.galvDark);
          for (let wx = -0.48; wx <= 0.481; wx += 0.24) {
            deckAcc.box(sx + wx, fy, topZ - 0.004, 0.006, deckSpanY - 0.02, 0.003, pal.galv, pal.galvDark);
          }
          for (let wy = -0.36; wy <= 0.361; wy += 0.24) {
            deckAcc.box(sx, fy + wy, topZ - 0.003, 0.55, 0.005, 0.002, pal.galv, pal.galvDark);
          }
        }
      }
    }
  }

  const deckMat = makeDeployablePbrMaterial(t, { roughness: 0.50, metalness: 0.65, csmState });
  const deckMesh = new t.Mesh(deckAcc.toBufferGeometry(t), deckMat);
  deckMesh.name = "rack-decks-mesh";
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  root.add(deckMesh);

  // ---- 4. Safety-Yellow Column Protectors, Baseplates & Aisle Placards (Draw Call 4) ----
  const safetyAcc = new GeomAcc(3);
  for (let b = 0; b <= bayCount; b++) {
    const ux = postHalfX + b * spec.bayPitchM;
    for (let fIdx = 0; fIdx < frameCentersY.length; fIdx++) {
      const fy = frameCentersY[fIdx];
      const yF = fy - postOffsetY;
      const yB = fy + postOffsetY;
      // Bolted baseplates (z in [0, 0.012], strictly inside upright [0, width] and ±depth/2)
      safetyAcc.box(ux, yF, 0.006, postHalfX, postHalfY, 0.006, pal.steel, cShade(pal.steel, 0.8));
      safetyAcc.box(ux, yB, 0.006, postHalfX, postHalfY, 0.006, pal.steel, cShade(pal.steel, 0.8));

      // Aisle-facing safety-yellow column protectors (z in [0.012, 0.400], flush inside bounds)
      if (!doubleSided || fIdx === 0) {
        safetyAcc.box(ux, yF, 0.206, postHalfX, postHalfY, 0.194, pal.yellow, cShade(pal.yellow, 0.85));
      }
      if (!doubleSided || fIdx === 1) {
        safetyAcc.box(ux, yB, 0.206, postHalfX, postHalfY, 0.194, pal.yellow, cShade(pal.yellow, 0.85));
      }
    }
  }
  // End-of-aisle capacity & row placards (kept inside [0, bounds.maxX] x [-depth/2, +depth/2])
  const placardXLeft = 0.004;
  const placardXRight = bounds.maxX - 0.004;
  for (const fy of frameCentersY) {
    safetyAcc.box(placardXLeft, fy, 2.15, 0.004, 0.22, 0.28, pal.placardBorder, pal.steel);
    safetyAcc.box(placardXLeft + 0.002, fy, 2.15, 0.002, 0.19, 0.25, pal.placard, pal.placard);
    safetyAcc.box(placardXLeft + 0.002, fy, 2.34, 0.002, 0.19, 0.04, pal.yellow, pal.yellow);

    safetyAcc.box(placardXRight, fy, 2.15, 0.004, 0.22, 0.28, pal.placardBorder, pal.steel);
    safetyAcc.box(placardXRight - 0.002, fy, 2.15, 0.002, 0.19, 0.25, pal.placard, pal.placard);
    safetyAcc.box(placardXRight - 0.002, fy, 2.34, 0.002, 0.19, 0.04, pal.yellow, pal.yellow);
  }

  const safetyMat = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.30, csmState });
  const safetyMesh = new t.Mesh(safetyAcc.toBufferGeometry(t), safetyMat);
  safetyMesh.name = "rack-safety-mesh";
  safetyMesh.castShadow = true;
  safetyMesh.receiveShadow = true;
  root.add(safetyMesh);

  // ---- Dynamic Slot Cargo Group & Lazy Highlight ----
  const cargoGroup = new t.Group();
  cargoGroup.name = "rack-cargo-group";
  root.add(cargoGroup);

  const loadedSlots = new Map();

  function makeSlotKey(bay, tier, side, slotInBay) {
    const sSide = doubleSided && side === 1 ? 1 : 0;
    return `${sSide}:${bay}:${tier}:${slotInBay}`;
  }

  function resolvePose(bay, tier, side, slotInBay) {
    if (!Number.isInteger(bay) || bay < 0 || bay >= bayCount) {
      throw new RangeError(`warehouse_rack_model: invalid bay ${bay} (bayCount=${bayCount})`);
    }
    const sSide = doubleSided && side === 1 ? 1 : 0;
    return {
      side: sSide,
      lp: computeRackSlotLocalPose(bay, tier, slotInBay, spec, {
        doubleSided,
        side: sSide,
      }),
    };
  }

  // ---- >120 m Instanced LOD Proxy (detached until active) ----
  const proxyGeom = makeProxyPalletGeom(t);
  const proxyMat = makeDeployablePbrMaterial(t, { roughness: 0.58, metalness: 0.25, csmState });
  const proxyMesh = new t.InstancedMesh(proxyGeom, proxyMat, Math.max(1, maxSlots));
  proxyMesh.name = "rack-cargo-lod-proxy";
  proxyMesh.castShadow = true;
  proxyMesh.receiveShadow = true;
  proxyMesh.frustumCulled = false;
  proxyMesh.count = 0;
  proxyMesh.visible = false; // vfx-lint-allow: LOD proxy hidden until distance > 120m

  const _mProxy = new t.Matrix4();
  const _qProxy = new t.Quaternion();
  const _qHalfTurn = new t.Quaternion().setFromAxisAngle(new t.Vector3(0, 0, 1), Math.PI);
  const _qIdent = new t.Quaternion();
  const _pProxy = new t.Vector3();
  const _sProxy = new t.Vector3(1, 1, 1);
  const _rowCenter = new t.Vector3();
  const _camVec = new t.Vector3();
  let lodActive = false;

  function syncLodProxyMatrices() {
    let idx = 0;
    for (const entry of loadedSlots.values()) {
      if (idx >= maxSlots) break;
      _pProxy.set(entry.lp.x, entry.lp.y, entry.lp.z);
      _qProxy.copy(entry.side === 1 ? _qHalfTurn : _qIdent);
      _mProxy.compose(_pProxy, _qProxy, _sProxy);
      proxyMesh.setMatrixAt(idx, _mProxy);
      idx++;
    }
    proxyMesh.count = idx;
    proxyMesh.instanceMatrix.needsUpdate = true;
    proxyMesh.computeBoundingBox();
    proxyMesh.computeBoundingSphere();
  }

  function setCargoLodDistance(camPosOrDist) {
    let dist = Infinity;
    if (typeof camPosOrDist === "number") {
      dist = camPosOrDist;
    } else if (camPosOrDist && typeof camPosOrDist === "object") {
      const cx = Array.isArray(camPosOrDist) ? camPosOrDist[0] : camPosOrDist.x;
      const cy = Array.isArray(camPosOrDist) ? camPosOrDist[1] : camPosOrDist.y;
      const cz = Array.isArray(camPosOrDist) ? camPosOrDist[2] : (camPosOrDist.z ?? 0);
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        let acFrameRoot = null;
        for (let cur = root.parent; cur; cur = cur.parent) {
          if (cur.isScene) break;
          if (
            cur.name === "worldRoot" ||
            Math.abs(cur.rotation?.x || 0) > 1e-4 ||
            Math.abs(cur.rotation?.y || 0) > 1e-4
          ) {
            acFrameRoot = cur;
            break;
          }
        }
        if (typeof root.updateWorldMatrix === "function") {
          root.updateWorldMatrix(true, false);
        } else {
          root.updateMatrixWorld(true);
        }
        _rowCenter.set(bounds.width * 0.5, 0, bounds.height * 0.5).applyMatrix4(root.matrixWorld);
        _camVec.set(cx, cy, Number.isFinite(cz) ? cz : 0);
        if (acFrameRoot) {
          _camVec.applyMatrix4(acFrameRoot.matrixWorld);
        }
        dist = _rowCenter.distanceTo(_camVec);
      }
    }

    const nextLod = Number.isFinite(dist) && dist > 120.0 && loadedSlots.size > 0;
    lodActive = nextLod;
    if (nextLod) {
      syncLodProxyMatrices();
      cargoGroup.visible = false; // vfx-lint-allow: LOD hides detailed rack cargo beyond 120m
      proxyMesh.visible = true; // vfx-lint-allow: LOD proxy visible beyond 120m
      if (proxyMesh.parent !== root) {
        root.add(proxyMesh);
      }
    } else {
      cargoGroup.visible = true; // vfx-lint-allow: detailed rack cargo visible within 120m
      proxyMesh.visible = false; // vfx-lint-allow: LOD proxy hidden within 120m
      if (proxyMesh.parent === root) {
        root.remove(proxyMesh);
      }
    }
    return nextLod;
  }

  // ---- Lazy Diegetic Slot Highlight (detached when null) ----
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
  highlightMesh.name = "rack-slot-highlight";
  highlightMesh.castShadow = false;
  highlightMesh.receiveShadow = false;
  highlightMesh.visible = false; // vfx-lint-allow: rack slot highlight visibility

  function setHighlightedSlot(bay, tier, side = 0, slotInBay = 0, state = null) {
    const style = state ? HIGHLIGHT_STATES[state] : null;
    if (bay === null || bay === undefined || !style) {
      highlightMesh.visible = false; // vfx-lint-allow: rack slot highlight visibility
      if (highlightMesh.parent) {
        highlightMesh.parent.remove(highlightMesh);
      }
      return false;
    }
    const { lp } = resolvePose(bay, tier, side, slotInBay);
    highlightMat.emissive.setHex(style.hex);
    highlightMat.emissiveIntensity = style.intensity;
    highlightMat.opacity = style.opacity;
    highlightMesh.position.set(lp.x, lp.y, lp.z + 0.008);
    highlightMesh.visible = true; // vfx-lint-allow: rack slot highlight visibility
    if (highlightMesh.parent !== root) {
      root.add(highlightMesh);
    }
    return true;
  }

  function _unloadSlot(bay, tier, side = 0, slotInBay = 0, keepLod = false) {
    const sSide = doubleSided && side === 1 ? 1 : 0;
    const key = makeSlotKey(bay, tier, sSide, slotInBay);
    const entry = loadedSlots.get(key);
    if (!entry) return false;
    if (entry.slotGroup && entry.slotGroup.parent) {
      entry.slotGroup.parent.remove(entry.slotGroup);
    }
    try {
      if (typeof entry.model?.dispose === "function") {
        entry.model.dispose();
      }
      const seenG = new Set();
      const seenM = new Set();
      entry.slotGroup.traverse((o) => {
        if (o.geometry && !seenG.has(o.geometry)) {
          seenG.add(o.geometry);
          o.geometry.dispose();
        }
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && !seenM.has(m)) {
              seenM.add(m);
              m.dispose();
            }
          }
        }
      });
    } catch (_) {}
    loadedSlots.delete(key);
    if (lodActive && !keepLod) {
      if (loadedSlots.size === 0) {
        setCargoLodDistance(0);
      } else {
        syncLodProxyMatrices();
      }
    }
    return true;
  }

  function unloadSlot(bay, tier, side = 0, slotInBay = 0) {
    return _unloadSlot(bay, tier, side, slotInBay, false);
  }

  function loadSlot(bay, tier, side = 0, slotInBay = 0, wcid = 0) {
    const { side: sSide, lp } = resolvePose(bay, tier, side, slotInBay);
    if (wcid === null || wcid === undefined || wcid === 0) {
      unloadSlot(bay, tier, sSide, slotInBay);
      return null;
    }
    const nextWcid = Number.isFinite(wcid) ? (wcid >>> 0) : 0;
    if (nextWcid === 0) {
      unloadSlot(bay, tier, sSide, slotInBay);
      return null;
    }

    const key = makeSlotKey(bay, tier, sSide, slotInBay);
    _unloadSlot(bay, tier, sSide, slotInBay, true);

    const slotGroup = new t.Group();
    slotGroup.name = `rack-slot-${key}`;
    slotGroup.position.set(lp.x, lp.y, lp.z);
    slotGroup.rotation.z = sSide === 1 ? Math.PI : 0.0;

    const model = mountStowedCargo(t, nextWcid, csmState);
    if (model?.root) {
      model.root.position.set(0, 0, 0);
      model.root.rotation.set(0, 0, 0);
      slotGroup.add(model.root);
    }

    cargoGroup.add(slotGroup);
    const entry = {
      key,
      bay,
      tier,
      side: sSide,
      slotInBay,
      wcid: nextWcid,
      lp,
      slotGroup,
      model,
    };
    loadedSlots.set(key, entry);
    if (lodActive) {
      syncLodProxyMatrices();
    }
    return entry;
  }

  function getSlotWorldPos(bay, tier, side = 0, slotInBay = 0, outVec = null) {
    const { lp } = resolvePose(bay, tier, side, slotInBay);
    root.updateMatrixWorld(true);
    const target = outVec && typeof outVec.set === "function" ? outVec : new t.Vector3();
    target.set(lp.x, lp.y, lp.z).applyMatrix4(root.matrixWorld);
    return target;
  }

  function dispose() {
    setHighlightedSlot(null, null, null, null, null);
    setCargoLodDistance(0);
    for (const key of Array.from(loadedSlots.keys())) {
      const entry = loadedSlots.get(key);
      if (entry) {
        unloadSlot(entry.bay, entry.tier, entry.side, entry.slotInBay);
      }
    }
    if (proxyMesh.parent) proxyMesh.parent.remove(proxyMesh);
    if (highlightMesh.parent) highlightMesh.parent.remove(highlightMesh);

    const disposedG = new Set();
    const disposedM = new Set();
    const disposeObj = (o) => {
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

    root.traverse(disposeObj);
    disposeObj(proxyMesh);
    disposeObj(highlightMesh);
  }

  return {
    root,
    cargoGroup,
    proxyMesh,
    spec,
    wcid: WAREHOUSE_WCID.SteelRackBay,
    rowId,
    bayCount,
    doubleSided,
    bounds,
    loadedSlots,
    get isLodActive() { return lodActive; },
    loadSlot,
    unloadSlot,
    setHighlightedSlot,
    setCargoLodDistance,
    getSlotWorldPos,
    dispose,
  };
}

export function buildRackBay(three, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  return buildRackRow(three, { ...opts, bayCount: 1 }, opts);
}
