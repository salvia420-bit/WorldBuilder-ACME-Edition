// scene3d/vehicle/civic_models.js — Town Control & Civic Structures (WCID 4000090..4000095)
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patch, 0 dynamic THREE.Light instances,
// draw calls <= 10, deterministic animations, Set-deduped disposal.

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import { CIVIC_WCID } from "./economy_specs.js";
import {
  GeomAcc,
  makeLinearPalette,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
  disposeRootResources,
} from "./deployable_models.js";

function makeBodyMesh(t, acc, opts, name) {
  const mat = makeDeployablePbrMaterial(t, opts);
  const mesh = new t.Mesh(acc.toBufferGeometry(t), mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, mat };
}

function makeLampMesh(t, acc, emissiveIntensity, csmState, name) {
  const mat = makeLampsMaterial(t, { emissiveIntensity, roughness: 0.25 });
  mat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(mat, csmState);
  const mesh = new t.Mesh(acc.toBufferGeometry(t), mat);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, mat };
}

function makePalette(t) {
  return makeLinearPalette(t, {
    stone: 0x6f7378,
    darkStone: 0x45494e,
    concrete: 0x83888d,
    steel: 0x353c44,
    iron: 0x22262a,
    brass: 0xc2993c,
    gold: 0xdcb53a,
    yellow: 0xe6aa18,
    crimson: 0xa62c28,
    teal: 0x28768c,
    wood: 0x6b4c30,
    lampCyan: 0x4ae8ff,
    lampAmber: 0xffb830,
    lampCrimson: 0xff3b2f,
    lampEmber: 0xff6218,
    lampGreen: 0x35e878,
  });
}

function makeCivicController(root, wcid, lampMat, animFn) {
  let stowed = false;
  return {
    root,
    wcid,
    palletSize: "civic",
    get stowed() { return stowed; },
    setStowed(v) { stowed = Boolean(v); },
    setDeployed(v) { stowed = !Boolean(v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      const tSec = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      if (animFn) animFn(s, tSec);
      if (lampMat) {
        lampMat.emissiveIntensity = 0.85 + 0.20 * Math.sin(tSec * 2.5);
      }
    },
    dispose() {
      disposeRootResources(root);
    },
  };
}

// 4000090 — TownControlNode (Kind 56): Sovereign Obelisk Pylon & Rotating Ring
function buildTownControlNode(t, csmState) {
  const root = new t.Group();
  root.name = "civic-town-control-node-root";
  const P = makePalette(t);

  const bodyAcc = new GeomAcc();
  // Stepped octagonal stone/steel plinth
  bodyAcc.cylinder(0, 0, 0.20, 2.20, 0.40, 8, P.darkStone, "z");
  bodyAcc.cylinder(0, 0, 0.58, 1.55, 0.36, 8, P.stone, "z");
  // Central obelisk shaft & brass trim collar
  bodyAcc.cone(0, 0, 2.25, 0.68, 0.28, 3.00, 8, P.steel, "z");
  bodyAcc.cylinder(0, 0, 0.90, 0.78, 0.16, 8, P.brass, "z");
  // 4 perimeter security bollards
  for (const [bx, by] of [[-1.75, -1.75], [1.75, -1.75], [-1.75, 1.75], [1.75, 1.75]]) {
    bodyAcc.cylinder(bx, by, 0.45, 0.11, 0.90, 8, P.yellow, "z");
  }
  root.add(makeBodyMesh(t, bodyAcc, { roughness: 0.48, metalness: 0.48, csmState }, "tcn-obelisk-body").mesh);

  // Rotating guild transponder ring
  const ringPivot = new t.Group();
  ringPivot.position.set(0, 0, 2.95);
  const ringAcc = new GeomAcc();
  ringAcc.box(0, 0.88, 0, 0.45, 0.08, 0.12, P.brass);
  ringAcc.box(0, -0.88, 0, 0.45, 0.08, 0.12, P.brass);
  ringAcc.box(0.88, 0, 0, 0.08, 0.45, 0.12, P.brass);
  ringAcc.box(-0.88, 0, 0, 0.08, 0.45, 0.12, P.brass);
  ringPivot.add(makeBodyMesh(t, ringAcc, { roughness: 0.34, metalness: 0.70, csmState }, "tcn-transponder-ring").mesh);
  root.add(ringPivot);

  // Emissive sovereign crystal apex & ring indicators (0 lights)
  const lampAcc = new GeomAcc();
  lampAcc.cone(0, 0, 4.15, 0.28, 0.02, 0.85, 8, P.lampCyan, "z");
  for (const [bx, by] of [[-1.75, -1.75], [1.75, -1.75], [-1.75, 1.75], [1.75, 1.75]]) {
    lampAcc.cylinder(bx, by, 0.93, 0.09, 0.06, 8, P.lampCyan, "z");
  }
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.95, csmState, "tcn-sovereign-lamps");
  root.add(lampMesh);

  return makeCivicController(root, CIVIC_WCID.TownControlNode, lampMat, (_s, tSec) => {
    ringPivot.rotation.z = tSec * 0.9;
  });
}

// 4000091 — TownDepotApron (Kind 57): Logistics Marshalling Apron & Tally Kiosk
function buildTownDepotApron(t, csmState) {
  const root = new t.Group();
  root.name = "civic-town-depot-apron-root";
  const P = makePalette(t);

  const acc = new GeomAcc();
  // Concrete marshalling apron slab (z >= 0)
  acc.box(0, 0, 0.06, 2.20, 3.60, 0.06, P.concrete);
  // Corner container bay brackets (matching 20ft container footprint)
  for (const sx of [-1.22, 1.22]) {
    for (const sy of [-3.03, 3.03]) {
      acc.box(sx, sy, 0.14, 0.16, 0.16, 0.02, P.yellow);
    }
  }
  // Safety wheel stops at +Y edge
  acc.box(-0.75, 3.30, 0.18, 0.45, 0.10, 0.08, P.yellow);
  acc.box(0.75, 3.30, 0.18, 0.45, 0.10, 0.08, P.yellow);
  // Logistics tally kiosk at side (-1.75, -2.2)
  acc.box(-1.75, -2.2, 1.05, 0.36, 0.55, 0.95, P.steel);
  acc.box(-1.75, -2.2, 2.08, 0.46, 0.68, 0.08, P.teal);
  root.add(makeBodyMesh(t, acc, { roughness: 0.72, metalness: 0.25, csmState }, "town-depot-apron-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(-1.75, -2.2, 2.22, 0.12, 0.12, 0.10, P.lampAmber);
  lampAcc.box(-1.38, -2.2, 1.25, 0.02, 0.34, 0.22, P.lampCyan);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.85, csmState, "town-depot-lamps");
  root.add(lampMesh);

  return makeCivicController(root, CIVIC_WCID.TownDepotApron, lampMat, null);
}

// 4000092 — ForwardSiegeBeacon (Kind 58): Tactical Field Siege Transponder
function buildForwardSiegeBeacon(t, csmState) {
  const root = new t.Group();
  root.name = "civic-forward-siege-beacon-root";
  const P = makePalette(t);

  const acc = new GeomAcc();
  // Tripod armored base & ground anchor spikes
  acc.cylinder(0, 0, 0.12, 0.75, 0.24, 6, P.steel, "z");
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    const lx = Math.cos(a) * 0.95;
    const ly = Math.sin(a) * 0.95;
    acc.box(lx * 0.6, ly * 0.6, 0.28, 0.18, 0.18, 0.14, P.iron);
    acc.cone(lx, ly, 0.20, 0.04, 0.10, 0.40, 8, P.crimson, "z");
  }
  // Telescoping armored mast
  acc.cylinder(0, 0, 1.35, 0.16, 2.20, 10, P.steel, "z");
  acc.box(0, 0, 0.85, 0.36, 0.36, 0.32, P.crimson);
  root.add(makeBodyMesh(t, acc, { roughness: 0.44, metalness: 0.58, csmState }, "siege-beacon-mast").mesh);

  // Rotating directional transponder dish
  const dishPivot = new t.Group();
  dishPivot.position.set(0, 0, 2.55);
  const dishAcc = new GeomAcc();
  dishAcc.cone(0, 0.18, 0, 0.45, 0.14, 0.22, 14, P.brass, "y");
  dishAcc.cylinder(0, 0.40, 0, 0.05, 0.25, 8, P.iron, "y");
  dishPivot.add(makeBodyMesh(t, dishAcc, { roughness: 0.38, metalness: 0.65, csmState }, "siege-beacon-dish").mesh);
  root.add(dishPivot);

  const lampAcc = new GeomAcc();
  lampAcc.cylinder(0, 0, 2.90, 0.10, 0.18, 10, P.lampCrimson, "z");
  lampAcc.box(0, -0.37, 0.85, 0.22, 0.02, 0.08, P.lampAmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 1.05, csmState, "siege-beacon-lamps");
  root.add(lampMesh);

  return makeCivicController(root, CIVIC_WCID.ForwardSiegeBeacon, lampMat, (_s, tSec) => {
    dishPivot.rotation.z = tSec * 1.4;
  });
}

// 4000093 — TownMint (Kind 59): Hydraulic Pyreal Coinage Press & Bullion Vault
function buildTownMint(t, csmState) {
  const root = new t.Group();
  root.name = "civic-town-mint-root";
  const P = makePalette(t);

  const acc = new GeomAcc();
  // Heavy 20ft skid base
  acc.box(0, 0, 0.12, 1.219, 3.029, 0.12, P.steel);
  // Twin-column hydraulic coining press frame
  acc.box(-0.72, 0.4, 1.25, 0.20, 0.35, 1.10, P.iron);
  acc.box(0.72, 0.4, 1.25, 0.20, 0.35, 1.10, P.iron);
  acc.box(0, 0.4, 2.38, 0.95, 0.42, 0.22, P.brass);
  // Armored bullion vault cage & ingot hopper at -Y
  acc.box(0, -1.65, 1.05, 0.92, 0.95, 0.85, P.steel);
  acc.box(0, -1.65, 0.65, 0.45, 0.45, 0.25, P.gold);
  // Pyreal blank feed chute at +Y
  acc.box(0, 1.85, 0.72, 0.48, 0.75, 0.50, P.brass);
  root.add(makeBodyMesh(t, acc, { roughness: 0.42, metalness: 0.62, csmState }, "town-mint-body").mesh);

  const flywheel = new t.Group();
  flywheel.position.set(1.05, 0.4, 1.55);
  const fwAcc = new GeomAcc();
  fwAcc.cylinder(0, 0, 0, 0.62, 0.16, 18, P.brass, "x");
  flywheel.add(makeBodyMesh(t, fwAcc, { roughness: 0.32, metalness: 0.75, csmState }, "town-mint-flywheel").mesh);
  root.add(flywheel);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -2.62, 1.55, 0.32, 0.02, 0.08, P.lampAmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.90, csmState, "town-mint-lamps");
  root.add(lampMesh);

  return makeCivicController(root, CIVIC_WCID.TownMint, lampMat, (s, tSec) => {
    const active = s.online !== undefined ? Boolean(s.online) : Boolean((s.onlineFlags ?? 1) & 1);
    if (active) flywheel.rotation.x = tSec * 5.5;
  });
}

// 4000094 — TownWorkshop (Kind 60): Gantry Fabrication Bay & Forge Bench
function buildTownWorkshop(t, csmState) {
  const root = new t.Group();
  root.name = "civic-town-workshop-root";
  const P = makePalette(t);

  const acc = new GeomAcc();
  // 20ft steel workshop floor skid
  acc.box(0, 0, 0.10, 1.219, 3.029, 0.10, P.steel);
  // 4 gantry portal columns & overhead I-beam hoist rail
  for (const sx of [-1.05, 1.05]) {
    for (const sy of [-2.6, 2.6]) {
      acc.box(sx, sy, 1.35, 0.12, 0.12, 1.25, P.iron);
    }
    acc.box(sx, 0, 2.65, 0.12, 2.75, 0.12, P.yellow);
  }
  acc.box(0, 0.4, 2.65, 1.15, 0.14, 0.14, P.yellow);
  // Fabrication bench, lathe & anvil station
  acc.box(-0.55, -1.1, 0.62, 0.45, 1.25, 0.44, P.teal);
  acc.box(0.55, 1.2, 0.58, 0.38, 0.85, 0.40, P.iron);
  acc.box(0.55, -1.5, 0.88, 0.42, 0.55, 0.72, P.darkStone);
  root.add(makeBodyMesh(t, acc, { roughness: 0.50, metalness: 0.48, csmState }, "town-workshop-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, 0.4, 2.48, 0.40, 0.08, 0.04, P.lampCyan);
  lampAcc.box(0.55, -1.5, 1.62, 0.25, 0.25, 0.04, P.lampEmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.90, csmState, "town-workshop-lamps");
  root.add(lampMesh);

  return makeCivicController(root, CIVIC_WCID.TownWorkshop, lampMat, null);
}

// 4000095 — PublicCommonsStarterHearth (Kind 61): Indestructible 0 kW Starter Hearth
function buildPublicCommonsStarterHearth(t, csmState) {
  const root = new t.Group();
  root.name = "civic-starter-hearth-root";
  const P = makePalette(t);

  const acc = new GeomAcc();
  // Stone hearth foundation & stepped apron
  acc.cylinder(0, 0, 0.12, 1.65, 0.24, 8, P.darkStone, "z");
  // Arched stone fireback wall + chimney flue at +Y
  acc.box(0, 0.62, 0.92, 1.05, 0.38, 0.68, P.stone);
  acc.box(-0.88, 0.25, 0.72, 0.22, 0.55, 0.52, P.stone);
  acc.box(0.88, 0.25, 0.72, 0.22, 0.55, 0.52, P.stone);
  acc.cone(0, 0.65, 2.25, 0.58, 0.32, 1.45, 8, P.darkStone, "z");
  // Wrought-iron crucible pot rack & anvil block
  acc.box(0, -0.15, 0.78, 0.55, 0.05, 0.05, P.iron);
  acc.cylinder(0, -0.15, 0.58, 0.24, 0.28, 12, P.iron, "z");
  acc.box(-1.15, -0.75, 0.42, 0.26, 0.38, 0.30, P.iron);
  acc.box(1.15, -0.75, 0.32, 0.28, 0.32, 0.20, P.wood);
  root.add(makeBodyMesh(t, acc, { roughness: 0.80, metalness: 0.18, csmState }, "starter-hearth-masonry").mesh);

  // Glowing coal/ember bed via makeLampsMaterial (ZERO dynamic THREE.Light!)
  const emberAcc = new GeomAcc();
  emberAcc.cylinder(0, 0.05, 0.30, 0.52, 0.12, 10, P.lampEmber, "z");
  emberAcc.cone(0, 0.05, 0.44, 0.30, 0.06, 0.20, 8, P.lampAmber, "z");
  const { mesh: emberMesh, mat: emberMat } = makeLampMesh(t, emberAcc, 1.15, csmState, "starter-hearth-embers");
  root.add(emberMesh);

  return makeCivicController(root, CIVIC_WCID.PublicCommonsStarterHearth, emberMat, (_s, tSec) => {
    emberMat.emissiveIntensity = 1.05 + 0.22 * Math.sin(tSec * 5.2);
  });
}

export function buildCivicDeployable(three, wcid, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  switch (wcid) {
    case CIVIC_WCID.TownControlNode:
      return buildTownControlNode(t, csmState);
    case CIVIC_WCID.TownDepotApron:
      return buildTownDepotApron(t, csmState);
    case CIVIC_WCID.ForwardSiegeBeacon:
      return buildForwardSiegeBeacon(t, csmState);
    case CIVIC_WCID.TownMint:
      return buildTownMint(t, csmState);
    case CIVIC_WCID.TownWorkshop:
      return buildTownWorkshop(t, csmState);
    case CIVIC_WCID.PublicCommonsStarterHearth:
      return buildPublicCommonsStarterHearth(t, csmState);
    default:
      return null;
  }
}

export const manifest = Object.freeze({
  id: "vfx-civic-models",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});
