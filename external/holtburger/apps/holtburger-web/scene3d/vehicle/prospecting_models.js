// scene3d/vehicle/prospecting_models.js — 4-Stage Prospecting Pallet Deployables (WCID 4000070..4000074)
// Built on Unified ISO 6780 1.100 x 1.100 x 0.145 m 4-way pallet (`buildPallet`),
// AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patch, 0 dynamic THREE.Light instances,
// draw calls <= 10, strict stowed Box3 envelope (|x|,|y| <= 0.550 m, 0 <= z <= 2.05 m).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import { PROSPECTING_WCID } from "./economy_specs.js";
import {
  GeomAcc,
  cShade,
  makeLinearPalette,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
  buildPallet,
  disposeRootResources,
} from "./deployable_models.js";

const DECK_Z = 0.145;

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

function makeBodyMesh(t, acc, opts, name) {
  const mat = makeDeployablePbrMaterial(t, opts);
  const mesh = new t.Mesh(acc.toBufferGeometry(t), mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, mat };
}

// ---------------------------------------------------------------------------
// 4000070 — GprScanner (Kind 38): Ground-Penetrating Radar Sled & Console
// ---------------------------------------------------------------------------
export function buildGprScanner(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  let isStowed = options.stowed !== undefined ? Boolean(options.stowed) : true;

  const root = new t.Group();
  root.name = "deployable-gpr-scanner-root";

  const pallet = buildPallet(t, "standard", { stowed: isStowed, csmState });
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    frame: 0x2c333b,
    housing: 0xd98a1c,
    antenna: 0x1e2329,
    radome: 0xc9d2da,
    cable: 0x15181c,
    steel: 0x8d97a1,
    lampGreen: 0x35e87a,
    lampAmber: 0xf5b82e,
  });

  // Base console & battery pack (stowed strictly inside +-0.48m, z <= 1.15m)
  const baseAcc = new GeomAcc();
  baseAcc.box(0, -0.22, DECK_Z + 0.18, 0.36, 0.22, 0.18, P.housing);
  baseAcc.box(0, -0.22, DECK_Z + 0.38, 0.32, 0.16, 0.04, P.frame);
  baseAcc.box(-0.34, -0.22, DECK_Z + 0.12, 0.08, 0.20, 0.12, P.frame);
  baseAcc.box(0.34, -0.22, DECK_Z + 0.12, 0.08, 0.20, 0.12, P.frame);
  // Telescoping mast stub
  baseAcc.cylinder(0, -0.28, DECK_Z + 0.56, 0.032, 0.42, 10, P.steel, "z");
  const { mesh: baseMesh } = makeBodyMesh(t, baseAcc, { roughness: 0.48, metalness: 0.42, csmState }, "gpr-console-base");
  root.add(baseMesh);

  // Articulated GPR Twin-Antenna Sled Pivot
  const sledPivot = new t.Group();
  sledPivot.name = "gpr-sled-pivot";
  sledPivot.position.set(0, 0.16, DECK_Z + 0.06);
  const sledAcc = new GeomAcc();
  // Bi-static 200/400 MHz bowtie shield box
  sledAcc.box(0, 0, 0.09, 0.42, 0.28, 0.08, P.antenna);
  sledAcc.box(0, 0, 0.03, 0.40, 0.26, 0.02, P.radome);
  sledAcc.box(-0.36, 0, 0.15, 0.04, 0.24, 0.03, P.steel);
  sledAcc.box(0.36, 0, 0.15, 0.04, 0.24, 0.03, P.steel);
  const { mesh: sledMesh } = makeBodyMesh(t, sledAcc, { roughness: 0.58, metalness: 0.25, csmState }, "gpr-antenna-sled");
  sledPivot.add(sledMesh);
  root.add(sledPivot);

  // Mast head transponder
  const mastPivot = new t.Group();
  mastPivot.name = "gpr-mast-pivot";
  mastPivot.position.set(0, -0.28, DECK_Z + 0.72);
  const mastAcc = new GeomAcc();
  mastAcc.cylinder(0, 0, 0.25, 0.024, 0.50, 10, P.steel, "z");
  mastAcc.box(0, 0, 0.52, 0.14, 0.14, 0.04, P.housing);
  const { mesh: mastMesh } = makeBodyMesh(t, mastAcc, { roughness: 0.40, metalness: 0.55, csmState }, "gpr-mast");
  mastPivot.add(mastMesh);
  root.add(mastPivot);

  // Status Lamps (0 dynamic lights)
  const lampAcc = new GeomAcc();
  lampAcc.box(0, -0.445, DECK_Z + 0.28, 0.10, 0.012, 0.03, P.lampGreen);
  lampAcc.box(0, -0.28, DECK_Z + 0.76, 0.04, 0.04, 0.03, P.lampAmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.75, csmState, "gpr-lamps");
  root.add(lampMesh);

  function applyStow() {
    if (isStowed) {
      sledPivot.position.set(0, 0.16, DECK_Z + 0.04);
      sledPivot.rotation.set(0, 0, 0);
      mastPivot.position.set(0, -0.28, DECK_Z + 0.40);
      mastPivot.rotation.set(0, 0, 0);
    } else {
      sledPivot.position.set(0, 0.78, 0.02);
      sledPivot.rotation.set(0, 0, 0);
      mastPivot.position.set(0, -0.28, DECK_Z + 0.74);
      mastPivot.rotation.set(0, 0, 0);
    }
  }
  applyStow();

  return {
    root,
    pallet,
    wcid: PROSPECTING_WCID.GprScanner,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed(v) {
      isStowed = Boolean(v);
      pallet.setStowed(isStowed);
      applyStow();
    },
    setDeployed(v) { this.setStowed(!v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) this.setStowed(s.stowed);
      const tSec = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      const active = !isStowed && (s.online !== false);
      lampMat.emissiveIntensity = active ? 0.85 + 0.25 * Math.sin(tSec * 4.0) : 0.25;
      if (active && Number.isFinite(s.progressPct)) {
        sledPivot.position.y = 0.78 + 0.12 * Math.sin(tSec * 2.5);
      }
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 4000071 — VibroseisSeismic (Kind 39): Seismic Mass Shaker & Geophone Reel
// ---------------------------------------------------------------------------
export function buildVibroseisSeismic(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  let isStowed = options.stowed !== undefined ? Boolean(options.stowed) : true;

  const root = new t.Group();
  root.name = "deployable-vibroseis-seismic-root";

  const pallet = buildPallet(t, "standard", { stowed: isStowed, csmState });
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    frame: 0x30363d,
    yellow: 0xe2a418,
    hydraulics: 0x9aa4ae,
    baseplate: 0x22262a,
    reel: 0x3b6c8c,
    lampAmber: 0xffb32c,
  });

  // Hydraulic frame + reaction mass cage + geophone cable reel
  const frameAcc = new GeomAcc();
  frameAcc.box(-0.36, 0, DECK_Z + 0.45, 0.08, 0.42, 0.45, P.yellow);
  frameAcc.box(0.36, 0, DECK_Z + 0.45, 0.08, 0.42, 0.45, P.yellow);
  frameAcc.box(0, 0, DECK_Z + 0.92, 0.44, 0.42, 0.06, P.frame);
  // Hydraulic power unit box at rear
  frameAcc.box(0, -0.34, DECK_Z + 0.22, 0.34, 0.14, 0.22, P.frame);
  // Geophone cable reel at front
  frameAcc.cylinder(0, 0.34, DECK_Z + 0.20, 0.16, 0.28, 14, P.reel, "x");
  const { mesh: frameMesh } = makeBodyMesh(t, frameAcc, { roughness: 0.45, metalness: 0.48, csmState }, "vibroseis-frame");
  root.add(frameMesh);

  // Articulated Seismic Shaker Actuator & Ground Baseplate
  const shakerPivot = new t.Group();
  shakerPivot.name = "vibroseis-shaker-pivot";
  const shakerAcc = new GeomAcc();
  shakerAcc.box(0, 0, 0.04, 0.26, 0.26, 0.04, P.baseplate);
  shakerAcc.cylinder(0, 0, 0.34, 0.15, 0.52, 14, P.yellow, "z");
  shakerAcc.cylinder(0, 0, 0.66, 0.07, 0.24, 12, P.hydraulics, "z");
  const { mesh: shakerMesh } = makeBodyMesh(t, shakerAcc, { roughness: 0.38, metalness: 0.60, csmState }, "vibroseis-shaker");
  shakerPivot.add(shakerMesh);
  root.add(shakerPivot);

  const lampAcc = new GeomAcc();
  lampAcc.cylinder(0, 0, DECK_Z + 1.00, 0.045, 0.06, 10, P.lampAmber, "z");
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.70, csmState, "vibroseis-beacon");
  root.add(lampMesh);

  function applyStow() {
    shakerPivot.position.set(0, 0, isStowed ? DECK_Z + 0.05 : 0.01);
  }
  applyStow();

  return {
    root,
    pallet,
    wcid: PROSPECTING_WCID.VibroseisSeismic,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed(v) {
      isStowed = Boolean(v);
      pallet.setStowed(isStowed);
      applyStow();
    },
    setDeployed(v) { this.setStowed(!v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) this.setStowed(s.stowed);
      const tSec = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      const active = !isStowed && (s.online !== false);
      shakerPivot.position.z = isStowed ? DECK_Z + 0.05 : (active ? 0.01 + 0.015 * Math.abs(Math.sin(tSec * 28.0)) : 0.01);
      lampMat.emissiveIntensity = active ? 0.90 + 0.30 * Math.sin(tSec * 6.0) : 0.25;
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 4000072 — DiamondCoreDrill (Kind 40): Core Drill Power Pack & Folding Mast
// ---------------------------------------------------------------------------
export function buildDiamondCoreDrill(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  let isStowed = options.stowed !== undefined ? Boolean(options.stowed) : true;

  const root = new t.Group();
  root.name = "deployable-diamond-core-drill-root";

  const pallet = buildPallet(t, "standard", { stowed: isStowed, csmState });
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    frame: 0x2c3238,
    orange: 0xd15b24,
    steel: 0x9aa2ab,
    chrome: 0xcbd2d8,
    hose: 0x1b1e22,
    lampAmber: 0xffb32c,
  });

  // Hydraulic power pack & drill rod rack
  const baseAcc = new GeomAcc();
  baseAcc.box(0, -0.22, DECK_Z + 0.24, 0.42, 0.22, 0.24, P.orange);
  baseAcc.box(0, 0.28, DECK_Z + 0.10, 0.40, 0.18, 0.10, P.frame);
  // NQ/HQ spare core barrel tubes on rack (along X, centered at x=0 -> |x| <= 0.425 m)
  for (const sy of [0.16, 0.28, 0.40]) {
    baseAcc.cylinder(0, sy, DECK_Z + 0.24, 0.042, 0.85, 10, P.steel, "x");
  }
  const { mesh: baseMesh } = makeBodyMesh(t, baseAcc, { roughness: 0.46, metalness: 0.46, csmState }, "core-drill-pack");
  root.add(baseMesh);

  // Telescoping Lattice Mast Pivot (strictly inside +-0.55m, z <= 1.85m stowed; rises to z=2.35m deployed)
  const mastPivot = new t.Group();
  mastPivot.name = "core-drill-mast-pivot";
  mastPivot.position.set(0, 0.0, DECK_Z + 0.56);

  const mastAcc = new GeomAcc();
  // Mast side rails (length 1.08m total: z_local in [-0.38, +0.70])
  mastAcc.box(-0.14, 0, 0.16, 0.03, 0.04, 0.54, P.steel);
  mastAcc.box(0.14, 0, 0.16, 0.03, 0.04, 0.54, P.steel);
  mastAcc.box(0, 0, 0.72, 0.17, 0.06, 0.03, P.orange);
  mastAcc.box(0, 0, -0.36, 0.17, 0.06, 0.03, P.frame);
  const { mesh: mastMesh } = makeBodyMesh(t, mastAcc, { roughness: 0.42, metalness: 0.58, csmState }, "core-drill-mast");
  mastPivot.add(mastMesh);

  // Rotary chuck + drill string rod
  const chuckGroup = new t.Group();
  chuckGroup.name = "core-drill-chuck";
  chuckGroup.position.set(0, 0.08, 0.14);
  const chuckAcc = new GeomAcc();
  chuckAcc.cylinder(0, 0, 0, 0.09, 0.22, 12, P.orange, "z");
  chuckAcc.cylinder(0, 0, -0.18, 0.035, 0.54, 10, P.chrome, "z");
  const { mesh: chuckMesh } = makeBodyMesh(t, chuckAcc, { roughness: 0.28, metalness: 0.78, csmState }, "core-drill-string");
  chuckGroup.add(chuckMesh);
  mastPivot.add(chuckGroup);

  root.add(mastPivot);

  const lampAcc = new GeomAcc();
  lampAcc.box(0, -0.45, DECK_Z + 0.46, 0.12, 0.015, 0.03, P.lampAmber);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.70, csmState, "core-drill-lamp");
  root.add(lampMesh);

  function applyStow() {
    if (isStowed) {
      mastPivot.position.set(0, -0.02, DECK_Z + 0.72);
      mastPivot.rotation.set(0.20, 0, 0);
      chuckGroup.position.set(0, 0.08, 0.14);
    } else {
      mastPivot.position.set(0, 0.16, DECK_Z + 1.28);
      mastPivot.rotation.set(0, 0, 0);
      chuckGroup.position.set(0, 0.08, 0.22);
    }
  }
  applyStow();

  return {
    root,
    pallet,
    wcid: PROSPECTING_WCID.DiamondCoreDrill,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed(v) {
      isStowed = Boolean(v);
      pallet.setStowed(isStowed);
      applyStow();
    },
    setDeployed(v) { this.setStowed(!v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) this.setStowed(s.stowed);
      const tSec = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      const active = !isStowed && (s.online !== false);
      if (active) {
        chuckGroup.rotation.z = tSec * 10.0;
        chuckGroup.position.z = 0.22 - 0.18 * (0.5 + 0.5 * Math.sin(tSec * 1.2));
      } else {
        chuckGroup.rotation.z = 0;
      }
      lampMat.emissiveIntensity = active ? 0.90 : 0.20;
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 4000073 — MobileAssayLab (Kind 41): Geochemical Spectrometer & Hood Lab
// ---------------------------------------------------------------------------
export function buildMobileAssayLab(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  let isStowed = options.stowed !== undefined ? Boolean(options.stowed) : true;

  const root = new t.Group();
  root.name = "deployable-mobile-assay-lab-root";

  const pallet = buildPallet(t, "standard", { stowed: isStowed, csmState });
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    cabinet: 0xd6dde4,
    trim: 0x2c4b66,
    bench: 0x32383e,
    brass: 0xc29c48,
    glass: 0x6ba6c4,
    lampCyan: 0x45e8ff,
  });

  const labAcc = new GeomAcc();
  // Anodized lab cabinet enclosure (0.92 x 0.92 x 0.95 m -> well inside +-0.55m, z <= 1.25m)
  labAcc.box(0, 0, DECK_Z + 0.42, 0.46, 0.46, 0.42, P.cabinet);
  labAcc.box(0, 0, DECK_Z + 0.85, 0.47, 0.47, 0.03, P.trim);
  labAcc.box(0, -0.465, DECK_Z + 0.56, 0.34, 0.015, 0.20, P.glass);
  labAcc.box(0, -0.465, DECK_Z + 0.22, 0.36, 0.02, 0.12, P.bench);
  // XRF / ICP spectrometer turret housing on top deck
  labAcc.cylinder(0.18, 0.12, DECK_Z + 0.96, 0.14, 0.18, 14, P.brass, "z");
  const { mesh: labMesh } = makeBodyMesh(t, labAcc, { roughness: 0.36, metalness: 0.48, csmState }, "assay-lab-cabinet");
  root.add(labMesh);

  // Deployable fume hood snorkel & sample tray
  const hoodPivot = new t.Group();
  hoodPivot.name = "assay-lab-hood-pivot";
  const hoodAcc = new GeomAcc();
  hoodAcc.cylinder(0, 0, 0.14, 0.08, 0.28, 12, P.trim, "z");
  hoodAcc.box(0, 0, 0.30, 0.16, 0.16, 0.04, P.bench);
  const { mesh: hoodMesh } = makeBodyMesh(t, hoodAcc, { roughness: 0.42, metalness: 0.52, csmState }, "assay-lab-hood");
  hoodPivot.add(hoodMesh);
  root.add(hoodPivot);

  const lampAcc = new GeomAcc();
  lampAcc.box(-0.34, -0.468, DECK_Z + 0.72, 0.08, 0.012, 0.03, P.lampCyan);
  lampAcc.box(0.18, 0.12, DECK_Z + 1.07, 0.06, 0.06, 0.02, P.lampCyan);
  const { mesh: lampMesh, mat: lampMat } = makeLampMesh(t, lampAcc, 0.80, csmState, "assay-lab-lamps");
  root.add(lampMesh);

  function applyStow() {
    if (isStowed) {
      hoodPivot.position.set(-0.18, 0.12, DECK_Z + 0.88);
      hoodPivot.rotation.set(0, 0, 0);
    } else {
      hoodPivot.position.set(-0.18, 0.12, DECK_Z + 1.24);
      hoodPivot.rotation.set(0, 0, 0);
    }
  }
  applyStow();

  return {
    root,
    pallet,
    wcid: PROSPECTING_WCID.MobileAssayLab,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed(v) {
      isStowed = Boolean(v);
      pallet.setStowed(isStowed);
      applyStow();
    },
    setDeployed(v) { this.setStowed(!v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) this.setStowed(s.stowed);
      const tSec = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      const active = !isStowed && (s.online !== false);
      lampMat.emissiveIntensity = active ? 0.90 + 0.25 * Math.sin(tSec * 3.0) : 0.25;
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 4000074 — CoreSampleCrate (Kind 42): Sealed Rock Core Transport Crate
// ---------------------------------------------------------------------------
export function buildCoreSampleCrate(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const csmState = options.csmState ?? null;
  let isStowed = options.stowed !== undefined ? Boolean(options.stowed) : true;

  const root = new t.Group();
  root.name = "deployable-core-sample-crate-root";

  const pallet = buildPallet(t, "standard", { stowed: isStowed, csmState });
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    crate: 0x5c6852,
    strap: 0x262a2e,
    coreRock: 0x7a6b5d,
    coreOre: 0xa68942,
    latch: 0xadb5bd,
  });

  // Reinforced steel-banded core crate body + visible rock core cylinders inside
  const crateAcc = new GeomAcc();
  crateAcc.box(0, 0, DECK_Z + 0.04, 0.47, 0.47, 0.04, P.crate);
  crateAcc.box(-0.44, 0, DECK_Z + 0.28, 0.03, 0.47, 0.24, P.crate);
  crateAcc.box(0.44, 0, DECK_Z + 0.28, 0.03, 0.47, 0.24, P.crate);
  crateAcc.box(0, -0.44, DECK_Z + 0.28, 0.41, 0.03, 0.24, P.crate);
  crateAcc.box(0, 0.44, DECK_Z + 0.28, 0.41, 0.03, 0.24, P.crate);
  // Corner strapping + latches
  crateAcc.box(-0.46, 0, DECK_Z + 0.28, 0.015, 0.48, 0.03, P.strap);
  crateAcc.box(0.46, 0, DECK_Z + 0.28, 0.015, 0.48, 0.03, P.strap);
  // Sealed rock core cylinders in 4 rows
  for (let i = -1.5; i <= 1.5; i += 1.0) {
    const col = i === 0.5 ? P.coreOre : P.coreRock;
    crateAcc.cylinder(0, i * 0.20, DECK_Z + 0.18, 0.055, 0.76, 10, col, "x");
  }
  const { mesh: crateMesh } = makeBodyMesh(t, crateAcc, { roughness: 0.68, metalness: 0.30, csmState }, "core-crate-body");
  root.add(crateMesh);

  // Hinged lid
  const lidPivot = new t.Group();
  lidPivot.name = "core-crate-lid-pivot";
  lidPivot.position.set(0, 0.46, DECK_Z + 0.52);
  const lidAcc = new GeomAcc();
  lidAcc.box(0, -0.46, 0.03, 0.48, 0.48, 0.03, P.crate);
  lidAcc.box(0, -0.92, -0.02, 0.14, 0.02, 0.04, P.latch);
  const { mesh: lidMesh } = makeBodyMesh(t, lidAcc, { roughness: 0.55, metalness: 0.38, csmState }, "core-crate-lid");
  lidPivot.add(lidMesh);
  root.add(lidPivot);

  function applyStow() {
    lidPivot.rotation.x = isStowed ? 0.0 : -1.15;
  }
  applyStow();

  return {
    root,
    pallet,
    wcid: PROSPECTING_WCID.CoreSampleCrate,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed(v) {
      isStowed = Boolean(v);
      pallet.setStowed(isStowed);
      applyStow();
    },
    setDeployed(v) { this.setStowed(!v); },
    update(state = null) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) this.setStowed(s.stowed);
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

export function buildProspectingDeployable(three, wcid, options = {}) {
  switch (wcid) {
    case PROSPECTING_WCID.GprScanner:
      return buildGprScanner(three, options);
    case PROSPECTING_WCID.VibroseisSeismic:
      return buildVibroseisSeismic(three, options);
    case PROSPECTING_WCID.DiamondCoreDrill:
      return buildDiamondCoreDrill(three, options);
    case PROSPECTING_WCID.MobileAssayLab:
      return buildMobileAssayLab(three, options);
    case PROSPECTING_WCID.CoreSampleCrate:
      return buildCoreSampleCrate(three, options);
    default:
      return null;
  }
}

export const manifest = Object.freeze({
  id: "vfx-prospecting-models",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});
