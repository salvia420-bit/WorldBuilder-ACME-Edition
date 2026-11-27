// scene3d/vehicle/industry_models.js — Extraction, Refining & Power Skids (WCID 4000075..4000087)
// Mounted on ISO 1161 20ft (2.259 x 5.853 m casting centers) and 40ft (2.259 x 11.985 m) steel skids.
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patch, 0 dynamic THREE.Light instances,
// draw calls <= 10, deterministic animations, Set-deduped disposal.

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import { INDUSTRIAL_SKID_WCID } from "./economy_specs.js";
import {
  GeomAcc,
  cShade,
  makeLinearPalette,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
  disposeRootResources,
} from "./deployable_models.js";

function addIsoSkidBase(acc, P, lengthM, widthM = 2.438) {
  const halfW = widthM * 0.5;
  const halfL = lengthM * 0.5;
  const castHalfX = 2.259 * 0.5;
  const castHalfY = (lengthM > 8.0 ? 11.985 : 5.853) * 0.5;
  const beamH = 0.16;

  // Longitudinal I-beams
  acc.box(-halfW + 0.09, 0, beamH * 0.5, 0.08, halfL - 0.10, beamH * 0.5, P.skid);
  acc.box(halfW - 0.09, 0, beamH * 0.5, 0.08, halfL - 0.10, beamH * 0.5, P.skid);
  // End crossbeams
  acc.box(0, -halfL + 0.09, beamH * 0.5, halfW - 0.12, 0.08, beamH * 0.5, P.skid);
  acc.box(0, halfL - 0.09, beamH * 0.5, halfW - 0.12, 0.08, beamH * 0.5, P.skid);
  // Diamond plate skid deck
  acc.box(0, 0, beamH + 0.02, halfW - 0.04, halfL - 0.04, 0.02, P.deck);
  // 8 ISO 1161 corner castings (4 bottom feet + 4 top lifting ears on corner posts if needed)
  for (const sx of [-castHalfX, castHalfX]) {
    for (const sy of [-castHalfY, castHalfY]) {
      acc.box(sx, sy, 0.06, 0.081, 0.089, 0.059, P.casting);
    }
  }
  return beamH + 0.04;
}

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
    skid: 0x262b30,
    deck: 0x3b4248,
    casting: 0x1c2024,
    steel: 0x7e8891,
    stainless: 0xb6c0c8,
    rust: 0x854328,
    yellow: 0xd99b18,
    orange: 0xc95a22,
    blue: 0x25567c,
    green: 0x2b6240,
    red: 0x992b24,
    copper: 0xa66b38,
    dark: 0x1b1e22,
    lampGreen: 0x34e878,
    lampAmber: 0xffb830,
    lampRed: 0xff4632,
    lampEmber: 0xff6a1a,
  });
}

function makeSkidController(root, wcid, lampMat, animFn) {
  let stowed = false;
  return {
    root,
    wcid,
    palletSize: "skid",
    get stowed() { return stowed; },
    setStowed(v) { stowed = Boolean(v); },
    setDeployed(v) { stowed = !Boolean(v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      const tSec = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      const online = s.online !== undefined ? Boolean(s.online) : Boolean((s.onlineFlags ?? 1) & 1);
      if (animFn) animFn(s, tSec, online);
      if (lampMat) {
        lampMat.emissiveIntensity = online ? 0.85 + 0.20 * Math.sin(tSec * 3.0) : 0.25;
      }
    },
    dispose() {
      disposeRootResources(root);
    },
  };
}

// 4000075 — BoreholeMiner (Kind 43)
function buildBoreholeMiner(t, csmState) {
  const root = new t.Group();
  root.name = "industry-borehole-miner-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  acc.box(0, -1.6, z0 + 0.65, 0.95, 1.15, 0.65, P.yellow);
  acc.cylinder(0, 0.2, z0 + 0.65, 0.45, 1.25, 14, P.steel, "y");
  acc.box(-0.75, 1.6, z0 + 1.25, 0.14, 0.14, 1.25, P.skid);
  acc.box(0.75, 1.6, z0 + 1.25, 0.14, 0.14, 1.25, P.skid);
  acc.box(0, 1.6, z0 + 2.45, 0.88, 0.22, 0.14, P.orange);
  root.add(makeBodyMesh(t, acc, { roughness: 0.50, metalness: 0.45, csmState }, "borehole-miner-body").mesh);

  const augerPivot = new t.Group();
  augerPivot.position.set(0, 1.6, z0 + 1.35);
  const augAcc = new GeomAcc();
  augAcc.cylinder(0, 0, 0, 0.22, 2.10, 12, P.stainless, "z");
  augAcc.cone(0, 0, -1.15, 0.04, 0.26, 0.35, 12, P.orange, "z");
  augerPivot.add(makeBodyMesh(t, augAcc, { roughness: 0.35, metalness: 0.68, csmState }, "borehole-miner-auger").mesh);
  root.add(augerPivot);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -2.76, z0 + 1.10, 0.18, 0.02, 0.06, P.lampAmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "borehole-miner-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.BoreholeMiner, lampMat, (_s, tSec, online) => {
    if (online) augerPivot.rotation.z = tSec * 4.5;
  });
}

// 4000076 — JawCrusher (Kind 44)
function buildJawCrusher(t, csmState) {
  const root = new t.Group();
  root.name = "industry-jaw-crusher-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // Feed hopper
  acc.cone(0, -1.35, z0 + 1.85, 0.55, 1.05, 1.10, 4, P.yellow, "z");
  // Crusher jaw housing
  acc.box(0, -0.35, z0 + 0.75, 0.85, 0.90, 0.75, P.dark);
  // Discharge conveyor boom
  acc.box(0, 1.45, z0 + 0.85, 0.48, 1.40, 0.14, P.steel);
  root.add(makeBodyMesh(t, acc, { roughness: 0.52, metalness: 0.48, csmState }, "jaw-crusher-body").mesh);

  const flywheel = new t.Group();
  flywheel.position.set(0.95, -0.35, z0 + 0.85);
  const fwAcc = new GeomAcc();
  fwAcc.cylinder(0, 0, 0, 0.62, 0.16, 16, P.orange, "x");
  flywheel.add(makeBodyMesh(t, fwAcc, { roughness: 0.40, metalness: 0.60, csmState }, "jaw-crusher-flywheel").mesh);
  root.add(flywheel);

  const lampAcc = new GeomAcc();
  lampAcc.cylinder(-0.85, -2.5, z0 + 1.45, 0.07, 0.12, 10, P.lampAmber, "z");
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "jaw-crusher-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.JawCrusher, lampMat, (_s, tSec, online) => {
    if (online) flywheel.rotation.x = tSec * 7.5;
  });
}

// 4000077 — Concentrator (Kind 45)
function buildConcentrator(t, csmState) {
  const root = new t.Group();
  root.name = "industry-concentrator-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  for (const cy of [-1.6, 0.0, 1.6]) {
    acc.cylinder(0, cy, z0 + 0.72, 0.78, 1.44, 16, P.blue, "z");
    acc.box(0, cy, z0 + 1.52, 0.90, 0.22, 0.08, P.steel);
    acc.cylinder(0, cy, z0 + 1.72, 0.20, 0.36, 10, P.yellow, "z");
  }
  acc.box(0.88, 0, z0 + 1.15, 0.16, 2.40, 0.14, P.stainless);
  root.add(makeBodyMesh(t, acc, { roughness: 0.44, metalness: 0.52, csmState }, "concentrator-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -2.75, z0 + 1.25, 0.24, 0.02, 0.06, P.lampGreen);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "concentrator-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.Concentrator, lampMat, null);
}

// 4000078 — RotaryOilRig (Kind 46, 40ft 42P1 footprint)
function buildRotaryOilRig(t, csmState) {
  const root = new t.Group();
  root.name = "industry-rotary-oil-rig-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 12.192);
  // Mud tanks & pipe rack at -Y
  acc.box(0, -3.6, z0 + 0.75, 0.95, 1.85, 0.75, P.blue);
  acc.box(0, -0.9, z0 + 0.35, 0.90, 0.75, 0.35, P.steel);
  // API 16A BOP stack & rotary table under mast at +Y
  acc.cylinder(0, 2.6, z0 + 0.55, 0.42, 1.10, 12, P.red, "z");
  // 4-leg derrick mast
  for (const sx of [-0.72, 0.72]) {
    for (const sy of [1.88, 3.32]) {
      acc.box(sx, sy, z0 + 3.6, 0.09, 0.09, 3.55, P.yellow);
    }
  }
  acc.box(0, 2.6, z0 + 7.2, 0.85, 0.85, 0.20, P.orange);
  // Drawworks winch house
  acc.box(0, 4.7, z0 + 0.80, 0.95, 0.90, 0.80, P.skid);
  root.add(makeBodyMesh(t, acc, { roughness: 0.48, metalness: 0.52, csmState }, "rotary-oil-rig-body").mesh);

  const kelly = new t.Group();
  kelly.position.set(0, 2.6, z0 + 3.6);
  const kelAcc = new GeomAcc();
  kelAcc.cylinder(0, 0, 0, 0.08, 4.8, 10, P.stainless, "z");
  kelAcc.box(0, 0, 1.2, 0.26, 0.26, 0.35, P.orange);
  kelly.add(makeBodyMesh(t, kelAcc, { roughness: 0.30, metalness: 0.75, csmState }, "rotary-oil-rig-kelly").mesh);
  root.add(kelly);

  const lampAcc = new GeomAcc();
  lampAcc.cylinder(0, 2.6, z0 + 7.55, 0.09, 0.16, 10, P.lampRed, "z");
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.95, csmState, "rotary-oil-rig-beacon");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.RotaryOilRig, lampMat, (_s, tSec, online) => {
    if (online) kelly.rotation.z = tSec * 5.0;
  });
}

// 4000079 — PumpjackTree (Kind 47)
function buildPumpjackTree(t, csmState) {
  const root = new t.Group();
  root.name = "industry-pumpjack-tree-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // Christmas tree wellhead valves at +1.85m
  acc.cylinder(0, 1.85, z0 + 0.55, 0.22, 1.10, 12, P.red, "z");
  acc.box(0, 1.85, z0 + 0.85, 0.55, 0.14, 0.14, P.red);
  // Samson post A-frame
  acc.box(-0.48, -0.20, z0 + 1.10, 0.10, 0.35, 1.10, P.blue);
  acc.box(0.48, -0.20, z0 + 1.10, 0.10, 0.35, 1.10, P.blue);
  // Gear reducer & prime mover at -1.8m
  acc.box(0, -1.85, z0 + 0.55, 0.65, 0.65, 0.55, P.dark);
  root.add(makeBodyMesh(t, acc, { roughness: 0.46, metalness: 0.50, csmState }, "pumpjack-base").mesh);

  const beamPivot = new t.Group();
  beamPivot.position.set(0, -0.20, z0 + 2.25);
  const beamAcc = new GeomAcc();
  beamAcc.box(0, 0, 0, 0.18, 2.20, 0.22, P.yellow);
  beamAcc.box(0, 2.15, -0.20, 0.22, 0.26, 0.48, P.orange);
  beamAcc.box(0, -1.95, -0.10, 0.42, 0.25, 0.30, P.skid);
  beamPivot.add(makeBodyMesh(t, beamAcc, { roughness: 0.42, metalness: 0.55, csmState }, "pumpjack-walking-beam").mesh);
  root.add(beamPivot);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -2.52, z0 + 1.12, 0.16, 0.02, 0.06, P.lampGreen);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "pumpjack-lamp");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.PumpjackTree, lampMat, (_s, tSec, online) => {
    beamPivot.rotation.x = online ? 0.22 * Math.sin(tSec * 1.6) : 0;
  });
}

// 4000080 — ThreePhaseSeparator (Kind 48)
function buildThreePhaseSeparator(t, csmState) {
  const root = new t.Group();
  root.name = "industry-three-phase-separator-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  acc.box(0, -1.5, z0 + 0.35, 0.75, 0.18, 0.35, P.skid);
  acc.box(0, 1.5, z0 + 0.35, 0.75, 0.18, 0.35, P.skid);
  acc.cylinder(0, 0, z0 + 1.25, 0.72, 4.20, 18, P.stainless, "y");
  acc.cone(0, 2.25, z0 + 1.25, 0.72, 0.18, 0.35, 18, P.stainless, "y");
  acc.cone(0, -2.25, z0 + 1.25, 0.18, 0.72, 0.35, 18, P.stainless, "y");
  acc.cylinder(0, 1.2, z0 + 2.20, 0.14, 0.55, 10, P.yellow, "z");
  acc.cylinder(0.85, -1.4, z0 + 0.85, 0.12, 0.75, 10, P.blue, "z");
  root.add(makeBodyMesh(t, acc, { roughness: 0.36, metalness: 0.65, csmState }, "separator-vessel").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(-0.85, -2.2, z0 + 1.15, 0.04, 0.18, 0.06, P.lampGreen);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "separator-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.ThreePhaseSeparator, lampMat, null);
}

// 4000081 — AduRefinery (Kind 49)
function buildAduRefinery(t, csmState) {
  const root = new t.Group();
  root.name = "industry-adu-refinery-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // Fired furnace box
  acc.box(0, -1.65, z0 + 0.85, 0.88, 0.95, 0.85, P.rust);
  // Tall atmospheric fractionation column
  acc.cylinder(0, 0.85, z0 + 2.45, 0.65, 4.90, 18, P.stainless, "z");
  for (const pz of [1.2, 2.2, 3.2, 4.2]) {
    acc.cylinder(0, 0.85, z0 + pz, 0.76, 0.06, 18, P.steel, "z");
  }
  // Overhead condenser drum
  acc.cylinder(0, 2.25, z0 + 1.05, 0.36, 1.15, 12, P.blue, "x");
  root.add(makeBodyMesh(t, acc, { roughness: 0.38, metalness: 0.62, csmState }, "adu-refinery-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.cylinder(0, 0.85, z0 + 4.98, 0.08, 0.14, 10, P.lampAmber, "z");
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.85, csmState, "adu-refinery-beacon");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.AduRefinery, lampMat, null);
}

// 4000082 — HdtVduDewaxer (Kind 50)
function buildHdtVduDewaxer(t, csmState) {
  const root = new t.Group();
  root.name = "industry-hdt-vdu-dewaxer-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // Twin hydrotreater + vacuum distillation towers
  acc.cylinder(-0.55, -0.85, z0 + 1.85, 0.45, 3.70, 16, P.stainless, "z");
  acc.cylinder(0.55, -0.85, z0 + 1.55, 0.42, 3.10, 16, P.steel, "z");
  // Heat exchanger bundle & wax knockout drum
  acc.cylinder(0, 1.45, z0 + 0.90, 0.44, 2.20, 14, P.copper, "y");
  acc.box(0, 1.45, z0 + 1.65, 0.80, 0.75, 0.25, P.blue);
  root.add(makeBodyMesh(t, acc, { roughness: 0.36, metalness: 0.65, csmState }, "hdt-vdu-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -2.70, z0 + 1.15, 0.24, 0.02, 0.06, P.lampGreen);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.80, csmState, "hdt-vdu-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.HdtVduDewaxer, lampMat, null);
}

// 4000083 — PyroSmelter (Kind 51)
function buildPyroSmelter(t, csmState) {
  const root = new t.Group();
  root.name = "industry-pyro-smelter-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // Refractory furnace body
  acc.box(0, -0.45, z0 + 1.15, 0.96, 1.45, 1.15, P.rust);
  // Exhaust flue stack
  acc.cylinder(0, -1.35, z0 + 3.05, 0.32, 1.90, 14, P.dark, "z");
  // Tap spout & ingot casting bed
  acc.box(0, 1.75, z0 + 0.42, 0.72, 0.95, 0.42, P.skid);
  root.add(makeBodyMesh(t, acc, { roughness: 0.62, metalness: 0.42, csmState }, "pyro-smelter-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, 1.02, z0 + 0.75, 0.38, 0.04, 0.22, P.lampEmber);
  lampAcc.box(0, 1.75, z0 + 0.86, 0.35, 0.55, 0.02, P.lampEmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 1.10, csmState, "pyro-smelter-embers");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.PyroSmelter, lampMat, null);
}

// 4000084 — ContactAcidWorks (Kind 52)
function buildContactAcidWorks(t, csmState) {
  const root = new t.Group();
  root.name = "industry-contact-acid-works-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  acc.cylinder(0, -1.75, z0 + 0.85, 0.56, 1.60, 14, P.yellow, "x");
  acc.cylinder(-0.45, 0.20, z0 + 1.65, 0.48, 3.30, 16, P.stainless, "z");
  acc.cylinder(0.55, 1.65, z0 + 1.45, 0.44, 2.90, 16, P.green, "z");
  root.add(makeBodyMesh(t, acc, { roughness: 0.40, metalness: 0.58, csmState }, "acid-works-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -2.75, z0 + 1.10, 0.22, 0.02, 0.06, P.lampAmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "acid-works-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.ContactAcidWorks, lampMat, null);
}

// 4000085 — BioProcessorTannery (Kind 53)
function buildBioProcessorTannery(t, csmState) {
  const root = new t.Group();
  root.name = "industry-bio-processor-tannery-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  acc.cylinder(0, -1.30, z0 + 0.85, 0.85, 1.70, 16, P.stainless, "z");
  acc.cylinder(0, 0.85, z0 + 0.85, 0.85, 1.70, 16, P.stainless, "z");
  acc.box(0, 2.25, z0 + 0.75, 0.88, 0.48, 0.75, P.green);
  root.add(makeBodyMesh(t, acc, { roughness: 0.36, metalness: 0.58, csmState }, "bio-processor-body").mesh);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, 2.75, z0 + 1.25, 0.22, 0.02, 0.06, P.lampGreen);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "bio-processor-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.BioProcessorTannery, lampMat, null);
}

// 4000086 — IndustrialGenset150kW (Kind 54)
function buildIndustrialGenset150kW(t, csmState) {
  const root = new t.Group();
  root.name = "industry-genset-150kw-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // 20ft acoustic container enclosure
  acc.box(0, 0, z0 + 1.05, 1.05, 2.75, 1.05, P.yellow);
  acc.box(0, 0, z0 + 2.12, 1.08, 2.78, 0.06, P.skid);
  // Roof exhaust muffler & stack
  acc.cylinder(-0.35, -1.2, z0 + 2.38, 0.22, 1.40, 12, P.steel, "y");
  acc.cylinder(-0.35, -1.9, z0 + 2.70, 0.11, 0.65, 10, P.dark, "z");
  // Radiator grille housing at +Y
  acc.box(0, 2.78, z0 + 1.05, 0.85, 0.06, 0.85, P.dark);
  root.add(makeBodyMesh(t, acc, { roughness: 0.45, metalness: 0.48, csmState }, "genset-150kw-housing").mesh);

  const fanGroup = new t.Group();
  fanGroup.position.set(0, 2.84, z0 + 1.05);
  const fanAcc = new GeomAcc();
  fanAcc.box(0, 0, 0, 0.68, 0.03, 0.08, P.steel);
  fanAcc.box(0, 0, 0, 0.08, 0.03, 0.68, P.steel);
  fanGroup.add(makeBodyMesh(t, fanAcc, { roughness: 0.38, metalness: 0.65, csmState }, "genset-150kw-fan").mesh);
  root.add(fanGroup);

  const lampAcc = new GeomAcc();
  lampAcc.box(1.07, -1.8, z0 + 1.45, 0.02, 0.20, 0.08, P.lampGreen);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.90, csmState, "genset-150kw-lamps");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.IndustrialGenset150kW, lampMat, (_s, tSec, online) => {
    if (online) fanGroup.rotation.y = tSec * 14.0;
  });
}

// 4000087 — IndustrialBess18MJ (Kind 55)
function buildIndustrialBess18MJ(t, csmState) {
  const root = new t.Group();
  root.name = "industry-bess-18mj-root";
  const P = makePalette(t);
  const acc = new GeomAcc();
  const z0 = addIsoSkidBase(acc, P, 6.058);
  // 20ft containerized battery enclosure
  acc.box(0, 0, z0 + 1.05, 1.05, 2.75, 1.05, P.blue);
  // 4 side cabinet doors
  for (const dy of [-1.8, -0.6, 0.6, 1.8]) {
    acc.box(-1.07, dy, z0 + 1.05, 0.03, 0.48, 0.88, P.steel);
    acc.box(1.07, dy, z0 + 1.05, 0.03, 0.48, 0.88, P.steel);
  }
  // Dual roof HVAC chillers & HV busbar conduit
  acc.box(0, -1.35, z0 + 2.28, 0.72, 0.55, 0.20, P.stainless);
  acc.box(0, 1.35, z0 + 2.28, 0.72, 0.55, 0.20, P.stainless);
  root.add(makeBodyMesh(t, acc, { roughness: 0.42, metalness: 0.52, csmState }, "bess-18mj-enclosure").mesh);

  // 5-bar SoC LED meter
  const lampAcc = new GeomAcc();
  for (let i = 0; i < 5; i++) {
    lampAcc.box(0, -2.77, z0 + 0.65 + i * 0.22, 0.28, 0.02, 0.06, P.lampGreen);
  }
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.85, csmState, "bess-18mj-soc");
  root.add(lampMesh);

  return makeSkidController(root, INDUSTRIAL_SKID_WCID.IndustrialBess18MJ, lampMat, null);
}

export function buildIndustryDeployable(three, wcid, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  switch (wcid) {
    case INDUSTRIAL_SKID_WCID.BoreholeMiner:
      return buildBoreholeMiner(t, csmState);
    case INDUSTRIAL_SKID_WCID.JawCrusher:
      return buildJawCrusher(t, csmState);
    case INDUSTRIAL_SKID_WCID.Concentrator:
      return buildConcentrator(t, csmState);
    case INDUSTRIAL_SKID_WCID.RotaryOilRig:
      return buildRotaryOilRig(t, csmState);
    case INDUSTRIAL_SKID_WCID.PumpjackTree:
      return buildPumpjackTree(t, csmState);
    case INDUSTRIAL_SKID_WCID.ThreePhaseSeparator:
      return buildThreePhaseSeparator(t, csmState);
    case INDUSTRIAL_SKID_WCID.AduRefinery:
      return buildAduRefinery(t, csmState);
    case INDUSTRIAL_SKID_WCID.HdtVduDewaxer:
      return buildHdtVduDewaxer(t, csmState);
    case INDUSTRIAL_SKID_WCID.PyroSmelter:
      return buildPyroSmelter(t, csmState);
    case INDUSTRIAL_SKID_WCID.ContactAcidWorks:
      return buildContactAcidWorks(t, csmState);
    case INDUSTRIAL_SKID_WCID.BioProcessorTannery:
      return buildBioProcessorTannery(t, csmState);
    case INDUSTRIAL_SKID_WCID.IndustrialGenset150kW:
      return buildIndustrialGenset150kW(t, csmState);
    case INDUSTRIAL_SKID_WCID.IndustrialBess18MJ:
      return buildIndustrialBess18MJ(t, csmState);
    default:
      return null;
  }
}

export const manifest = Object.freeze({
  id: "vfx-industry-models",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});
