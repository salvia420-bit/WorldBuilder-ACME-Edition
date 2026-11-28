// scene3d/vehicle/port_terminal_manager.js — Marine Container Terminal Runtime Orchestrator
//
// Coordinates the complete Site A Marine Container Terminal (`PORT_ORIGIN = [44960, 47880, 0]`):
//   - Engineered Quay, Caisson Seawall, Ramp, Fenders, Bollards, Reefer Racks, Gatehouse (`buildPortQuay`)
//   - ISO 9711 Container Yard (`A1/A2/B1/B2/REEFER`, odd=20ft / even=40ft, structural support validation)
//     backed by a single instanced rendering pool (`createContainerStackPool`, <= 6 DC for 200+ boxes)
//   - Ship-to-Shore Gantry Cranes `STS-1` & `STS-2` (shared-rail anti-collision >= 26 m, deterministic FIFO queues)
//   - Yard Gantry Cranes `RMG-1`, `RMG-2`, `RTG-1` (separation >= 22 m, 90 deg RTG steering bogies, FIFO queues)
//   - Autonomous Terminal Tractor Shuttles `TT-1..TT-3` (A* road routing, smooth ramp Z/pitch over Y in [47810, 47834],
//     `PortReservationGrid` traffic control)
//   - ZERO-EDIT WAREHOUSE BRIDGE: delivers containers onto untouched Automated Warehouse Zone A Drop Pads
//     `C1`/`C2`/`C3` (`[44920,47657.5,0]`, `[44936,47657.5,0]`, `[44952,47654.43,0]`, `heading=0`) by promoting
//     ONLY those active pad containers into `window.__vehicles.containers` (and demoting via `removeLocal` on
//     outbound pickup) so untouched `warehouseManager` AGFs run `pickFromContainer`/`loadIntoContainer` cleanly
//     with ZERO yard-stack pollution of `window.__vehicles.containers`.
//
// Zero `setTimeout` / `setInterval` / `Math.random()` / argless `Date.now()`; full zero-leak `dispose()`.

import {
  PORT_ORIGIN,
  PORT_SITE,
  PORT_WCID,
  PORT_DEPLOYABLE_KIND,
  PORT_GUID_BASE,
  QUAY_SPECS,
  STS_CRANE_SPECS,
  YARD_CRANE_SPECS,
  YARD_BLOCK_SPECS,
  SHUTTLE_SPECS,
  PORT_PALLET_SPECS,
  resolvePortContainerSpec,
  formatIso6346Bic,
  quayRampZ,
  quayRampPitch,
  computeYardSlotWorldPose,
  buildPortLayout,
} from "./port_specs.js";
import {
  STS_PHASE,
  YARD_CRANE_PHASE,
  createStsCraneState,
  enforceStsRailAntiCollision,
  stepStsCrane,
  stepStsTransferCycle,
  createYardCraneState,
  enforceYardCraneSeparation,
  stepYardCrane,
  stepYardTransferCycle,
  findRoadPath,
  PortReservationGrid,
  createShuttleState,
  stepShuttle,
  createYardStackStore,
} from "./port_kinematics.js";
import { buildPortQuay } from "./port_quay_model.js";
import { buildStsCrane } from "./port_sts_crane_model.js";
import { buildYardCrane, createContainerStackPool } from "./port_yard_crane_model.js";
import { buildPortShuttle } from "./port_shuttle_model.js";
import { buildIsoContainer, ISO_CONTAINER_SPECS } from "./container_models.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
} from "./deployable_models.js";

const KIND_TO_PORT_WCID = Object.freeze({
  [PORT_DEPLOYABLE_KIND.StsGantryCrane]: PORT_WCID.StsGantryCrane,
  [PORT_DEPLOYABLE_KIND.RmgYardCrane]: PORT_WCID.RmgYardCrane,
  [PORT_DEPLOYABLE_KIND.RtgYardCrane]: PORT_WCID.RtgYardCrane,
  [PORT_DEPLOYABLE_KIND.TerminalTractorShuttle]: PORT_WCID.TerminalTractorShuttle,
  [PORT_DEPLOYABLE_KIND.ReeferRackBay]: PORT_WCID.ReeferRackBay,
  [PORT_DEPLOYABLE_KIND.QuayBollard]: PORT_WCID.QuayBollard,
  [PORT_DEPLOYABLE_KIND.MarineFender]: PORT_WCID.MarineFender,
});

function disposeObjectTreeLocal(root) {
  if (!root) return;
  const disposedG = new Set();
  const disposedM = new Set();
  root.traverse((o) => {
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
  });
}

function buildStandalonePortFixture(THREE, kind, csmState) {
  const pal = makeLinearPalette(THREE, {
    galv: 0x969fa8,
    galvDark: 0x6d7680,
    steelDark: 0x262b31,
    yellow: 0xe8ad18,
    cabinetBlue: 0x225a8c,
    red: 0xc92c24,
    green: 0x22e868,
    amber: 0xde7a14,
    rubber: 0x1a1d20,
    rubberLight: 0x2a2e33,
  });
  const acc = new GeomAcc(3);
  const root = new THREE.Group();

  if (kind === PORT_DEPLOYABLE_KIND.ReeferRackBay) {
    root.name = "port-server-reefer-rack-bay";
    const gantryH = 8.4;
    for (const sx of [-1.4, 1.4]) {
      for (const sy of [-2.4, 2.4]) {
        acc.box(sx, sy, gantryH * 0.5, 0.08, 0.08, gantryH * 0.5, pal.galv, pal.galvDark);
        acc.box(sx, sy, 0.05, 0.16, 0.16, 0.05, pal.steelDark, pal.steelDark);
      }
    }
    for (const tz of [2.58, 5.18, 7.78]) {
      acc.box(0, 0, tz, 1.45, 2.55, 0.05, pal.galv, pal.galvDark);
      acc.box(-1.42, 0, tz + 0.95, 0.03, 2.55, 0.03, pal.yellow, cShade(pal.yellow, 0.82));
      acc.box(+1.42, 0, tz + 0.95, 0.03, 2.55, 0.03, pal.yellow, cShade(pal.yellow, 0.82));
      acc.box(0, 0, tz + 0.55, 0.22, 0.35, 0.30, pal.cabinetBlue, cShade(pal.cabinetBlue, 0.8));
      acc.box(0, -0.14, tz + 0.45, 0.24, 0.06, 0.06, pal.red, pal.red);
      acc.box(0, +0.14, tz + 0.45, 0.24, 0.06, 0.06, pal.red, pal.red);
    }
  } else if (kind === PORT_DEPLOYABLE_KIND.QuayBollard) {
    root.name = "port-server-quay-bollard";
    acc.bevelBox(0, 0, 0.04, 0.38, 0.34, 0.04, 0.08, pal.steelDark, cShade(pal.steelDark, 0.78));
    acc.cone(0, 0, 0.35, 0.24, 0.19, 0.54, 12, pal.yellow, "z", true, true, cShade(pal.yellow, 0.80));
    acc.bevelBox(0, 0, 0.73, 0.42, 0.24, 0.11, 0.06, pal.yellow, cShade(pal.yellow, 0.84));
  } else {
    root.name = "port-server-marine-fender";
    acc.box(0, 0.04, 0.0, 0.86, 0.04, 0.86, pal.steelDark, cShade(pal.steelDark, 0.78));
    acc.cone(0, 0.50, 0.0, 0.72, 0.44, 0.84, 12, pal.rubber, "y", true, true, cShade(pal.rubber, 0.75));
    acc.bevelBox(0, 1.04, 0.0, 0.95, 0.12, 0.92, 0.08, pal.steelDark, cShade(pal.steelDark, 0.78));
    acc.box(0, 1.175, 0.0, 0.88, 0.025, 0.86, pal.rubberLight, pal.rubber);
    acc.box(0, 1.06, +0.88, 0.92, 0.08, 0.05, pal.yellow, cShade(pal.yellow, 0.84));
  }

  const mat = makeDeployablePbrMaterial(THREE, {
    roughness: kind === PORT_DEPLOYABLE_KIND.MarineFender ? 0.74 : 0.46,
    metalness: kind === PORT_DEPLOYABLE_KIND.MarineFender ? 0.22 : 0.58,
    csmState,
  });
  const mesh = new THREE.Mesh(acc.toBufferGeometry(THREE), mat);
  mesh.name = `${root.name}-mesh`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);

  let disposed = false;
  return {
    root,
    wcid: KIND_TO_PORT_WCID[kind] || PORT_WCID.QuayBollard,
    kind,
    update(st = null) {
      if (disposed || !st) return;
      if (fin(st.x)) root.position.x = st.x;
      if (fin(st.y)) root.position.y = st.y;
      if (fin(st.z)) root.position.z = st.z;
      if (fin(st.heading)) root.rotation.z = -st.heading;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeObjectTreeLocal(root);
    },
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function defaultPalletSlots(wcid, seedIdx = 0) {
  const spec = resolvePortContainerSpec(wcid);
  const wcids = PORT_PALLET_SPECS.cargoWcids;
  const topSlot = spec.sizeFt === 20 ? 9 : 19;
  return [
    { slotIndex: topSlot - 3, palletSize: "full", cargoWcid: wcids[(seedIdx + 0) % wcids.length] },
    { slotIndex: topSlot - 2, palletSize: "full", cargoWcid: wcids[(seedIdx + 1) % wcids.length] },
    { slotIndex: topSlot - 1, palletSize: "full", cargoWcid: wcids[(seedIdx + 2) % wcids.length] },
    { slotIndex: topSlot, palletSize: "full", cargoWcid: wcids[(seedIdx + 3) % wcids.length] },
  ];
}

function rejectPendingQueue(queue, reason) {
  if (!Array.isArray(queue)) return;
  const err = reason instanceof Error ? reason : new Error(String(reason));
  while (queue.length > 0) {
    const item = queue.shift();
    try { item?.reject?.(err); } catch (_) {}
  }
}

function populateDefaultYardStacks(yardStore, density = "standard") {
  let seq = 1;
  const maxTiersDry = density === "dense" ? 4 : 3;

  // Block A1 (North Import Buffer, 40ft & 40HC stacks + 20ft sub-bays on west end)
  for (const evenBay of [2, 4, 6, 8, 10, 12, 14, 16, 18]) {
    for (let row = 1; row <= 5; row++) {
      const tiers = ((evenBay + row) % maxTiersDry) + 1;
      for (let t = 1; t <= tiers; t++) {
        const wcid = t === 2 ? 4000022 : 4000021;
        yardStore.place("A1", evenBay, row, t, {
          wcid,
          liveryId: (seq + evenBay + row) % 6,
          slots: defaultPalletSlots(wcid, seq),
        });
        seq++;
      }
    }
  }
  // 20ft odd sub-bays in A1 east bays (odd bays 37, 39, 41, 43)
  for (const oddBay of [37, 39, 41, 43]) {
    for (let row = 1; row <= 4; row++) {
      const tiers = (row % 2) + 1;
      for (let t = 1; t <= tiers; t++) {
        yardStore.place("A1", oddBay, row, t, {
          wcid: 4000020,
          liveryId: (seq + oddBay) % 6,
          slots: defaultPalletSlots(4000020, seq),
        });
        seq++;
      }
    }
  }

  // Block A2 (North Export Buffer, 40ft & 40HC)
  for (const evenBay of [2, 4, 6, 8, 10, 12, 14]) {
    for (let row = 1; row <= 4; row++) {
      const tiers = ((evenBay / 2 + row) % maxTiersDry) + 1;
      for (let t = 1; t <= tiers; t++) {
        const wcid = (t === 1 && row % 2 === 0) ? 4000021 : 4000022;
        yardStore.place("A2", evenBay, row, t, {
          wcid,
          liveryId: (seq + row * 2) % 6,
          slots: defaultPalletSlots(wcid, seq),
        });
        seq++;
      }
    }
  }

  // Block B1 (South Warehouse-Interchange Staging, served by RTG-1)
  for (const evenBay of [2, 4, 6, 8, 10, 12, 14, 16]) {
    for (let row = 1; row <= 4; row++) {
      const tiers = ((evenBay + row) % 3) + 1;
      for (let t = 1; t <= tiers; t++) {
        const wcid = t === 3 ? 4000022 : 4000021;
        yardStore.place("B1", evenBay, row, t, {
          wcid,
          liveryId: (seq + evenBay) % 6,
          slots: defaultPalletSlots(wcid, seq),
        });
        seq++;
      }
    }
  }

  // Block B2 (South Dry/Empty Staging)
  for (const evenBay of [2, 4, 6, 8]) {
    for (let row = 1; row <= 3; row++) {
      for (let t = 1; t <= 2; t++) {
        yardStore.place("B2", evenBay, row, t, {
          wcid: 4000021,
          liveryId: (seq + t) % 6,
          slots: defaultPalletSlots(4000021, seq),
        });
        seq++;
      }
    }
  }

  // REEFER Block (3-tier shore-powered refrigerated containers in galvanized reefer racks!)
  for (const evenBay of [2, 4, 6, 8]) {
    for (let row = 1; row <= 4; row++) {
      const tiers = row <= 2 ? 3 : 2;
      for (let t = 1; t <= tiers; t++) {
        yardStore.place("REEFER", evenBay, row, t, {
          wcid: 4000022,
          liveryId: 4, // light/white-tan refrigerated livery
          reefer: true,
          slots: defaultPalletSlots(4000022, seq),
        });
        seq++;
      }
    }
  }
}

export function createPortTerminalManager(deps = {}) {
  const THREE = deps.THREE ?? null;
  const liveScene3d = deps.liveScene3d ?? null;
  const containers = deps.containers ?? new Map();
  const portAudio = deps.portAudio ?? null;
  const warehouseManager = deps.warehouseManager ?? null;
  const spawnLocalContainerFn = typeof deps.spawnLocalContainer === "function" ? deps.spawnLocalContainer : null;
  const removeLocalContainerFn = typeof deps.removeLocalContainer === "function" ? deps.removeLocalContainer : null;

  let shipManager = deps.shipManager ?? null;
  let disposed = false;
  let built = false;
  let layout = null;
  let terminalRoot = null;
  let quayModel = null;
  let yardPool = null;
  let yardStore = createYardStackStore(PORT_ORIGIN);
  const reservationGrid = new PortReservationGrid();

  let simTimeSec = 0.0;
  let tickCount = 0;
  let nextHandoffGuid = PORT_GUID_BASE.handoffContainers;
  let nextSerial = 600001;
  let activeScenario = null;

  /** @type {Map<string, object>} */
  const stsEntries = new Map();
  /** @type {Map<string, object>} */
  const stsPublic = new Map();
  /** @type {Map<string, object>} */
  const yardCraneEntries = new Map();
  /** @type {Map<string, object>} */
  const yardCranesPublic = new Map();
  /** @type {Map<string, object>} */
  const shuttleEntries = new Map();
  /** @type {Map<string, object>} */
  const shuttlesPublic = new Map();
  /** @type {Map<string, object>} padId ("C1"|"C2"|"C3") -> promoted container metadata */
  const promotedPadContainers = new Map();
  /** @type {Map<number, object>} guid >>> 0 -> server DeployableKind 23..29 record */
  const serverDeployables = new Map();

  function csmStateOf() {
    return liveScene3d?.csmState ?? null;
  }

  function worldRootOf() {
    return liveScene3d?.worldRoot ?? null;
  }

  function ensureTerminalRoot() {
    if (!THREE) return null;
    if (!terminalRoot) {
      terminalRoot = new THREE.Group();
      terminalRoot.name = "PortTerminalRoot";
    }
    const wr = worldRootOf();
    if (wr && terminalRoot.parent !== wr) {
      wr.add(terminalRoot);
    }
    return terminalRoot;
  }

  function detachTerminalRoot() {
    if (terminalRoot && terminalRoot.parent) {
      terminalRoot.parent.remove(terminalRoot);
    }
    terminalRoot = null;
  }

  function syncYardPool() {
    if (yardPool) {
      yardPool.syncFromEntries(yardStore.entries);
    }
  }

  // Yard facade wrapping `yardStore` so every mutation updates the instanced stack pool automatically
  const yard = {
    place(blockId, bay, row, tier, meta = {}) {
      const res = yardStore.place(blockId, bay, row, tier, meta);
      if (res.ok) syncYardPool();
      return res;
    },
    remove(blockId, bay, row, tier) {
      const res = yardStore.remove(blockId, bay, row, tier);
      if (res.ok) syncYardPool();
      return res;
    },
    get(blockId, bay, row, tier) {
      return yardStore.get(blockId, bay, row, tier);
    },
    hasContainerAbove(blockId, bay, row, tier) {
      return yardStore.hasContainerAbove(blockId, bay, row, tier);
    },
    findFreeSlot(blockId, containerKindOrWcid = "40ft", opts = {}) {
      return yardStore.findFreeSlot(blockId, containerKindOrWcid, opts);
    },
    findTopContainer(blockId = null, filterFn = null) {
      return yardStore.findTopContainer(blockId, filterFn);
    },
    list(blockId = null) {
      return yardStore.list(blockId);
    },
    manifest(blockId = null) {
      return yardStore.list(blockId).map((e) => ({
        key: e.key,
        blockId: e.blockId,
        bay: e.bay,
        row: e.row,
        tier: e.tier,
        brt: e.brt,
        wcid: e.wcid,
        sizeFt: e.sizeFt,
        bic: e.bic,
        liveryId: e.liveryId,
        reefer: e.reefer,
        pos: [e.x, e.y, e.z],
      }));
    },
    clear() {
      yardStore.clear();
      syncYardPool();
    },
    count: () => yardStore.count(),
    syncVisuals: syncYardPool,
    get pool() { return yardPool; },
  };

  // =========================================================================
  // Zero-Edit Warehouse Bridge (Zone A Drop Pads C1 / C2 / C3 ONLY)
  // =========================================================================

  function promoteLocalContainerFallback(guid, kind, pos, heading, state) {
    const g = guid >>> 0;
    const spec = resolvePortContainerSpec(kind);
    let model = null;
    if (THREE && worldRootOf()) {
      const containerOpts = {
        csmState: csmStateOf(),
        serialNumber: state.serialNumber ?? 0,
        doorProgress: state.doorProgress ?? 1.0,
      };
      if (state.livery !== undefined) containerOpts.livery = state.livery;
      else if (state.liveryKey !== undefined) containerOpts.liveryKey = state.liveryKey;
      else if (
        state.liveryId !== undefined &&
        (state.liveryId !== 0 || !ISO_CONTAINER_SPECS[spec.wcid]?.defaultLiveryHex)
      ) {
        containerOpts.liveryId = state.liveryId;
      }
      model = buildIsoContainer(THREE, spec.wcid, containerOpts);
      model.root.position.set(pos[0], pos[1], pos[2]);
      model.root.rotation.z = -heading;
      if (Array.isArray(state.slots) && state.slots.length > 0) {
        try { model.syncSlots?.(state.slots); } catch (_) {}
      }
      worldRootOf().add(model.root);
    }
    const entry = {
      guid: g,
      kind: spec.kind,
      wcid: spec.wcid,
      model,
      rawPos: [pos[0], pos[1], pos[2]],
      heading,
      currentDoorProgress: state.doorProgress ?? 1.0,
      targetDoorProgress: state.doorProgress ?? 1.0,
      localOnly: true,
      liveryId: state.liveryId ?? 0,
      serialNumber: state.serialNumber ?? 0,
      slots: Array.isArray(state.slots) ? state.slots.map((s) => ({ ...s })) : [],
      last: { ...state },
    };
    containers.set(g, entry);
    return entry;
  }

  function demoteLocalContainerFallback(guid) {
    const g = guid >>> 0;
    const entry = containers.get(g);
    if (!entry) return;
    try {
      if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
      entry.model?.dispose?.();
    } catch (_) {}
    containers.delete(g);
  }

  function deliverToWarehousePad(padId, containerMeta = {}) {
    if (!built || !layout) throw new Error("deliverToWarehousePad: terminal not built");
    const pid = String(padId || "C1").toUpperCase();
    const pad = layout.warehouseDropPads[pid];
    if (!pad) throw new RangeError(`Unknown warehouse drop pad: ${padId} (expected C1, C2, or C3)`);

    // Demote any previous promoted container on this pad cleanly
    if (promotedPadContainers.has(pid)) {
      pickupFromWarehousePad(pid);
    }

    const spec = resolvePortContainerSpec(
      containerMeta.wcid ?? containerMeta.kind ?? containerMeta.containerKind ?? pad.wcid
    );
    const guid = (fin(containerMeta.guid) ? containerMeta.guid : nextHandoffGuid++) >>> 0;
    const liveryId = Number.isInteger(containerMeta.liveryId) ? containerMeta.liveryId : 0;
    const serialNumber = Number.isInteger(containerMeta.serialNumber) ? containerMeta.serialNumber : nextSerial++;
    const bic = containerMeta.bic || formatIso6346Bic(serialNumber);
    const doorProgress = fin(containerMeta.doorProgress) ? clamp(containerMeta.doorProgress, 0.0, 1.0) : 1.0;
    const slots = Array.isArray(containerMeta.slots)
      ? containerMeta.slots.map((s) => ({ ...s }))
      : defaultPalletSlots(spec.wcid, serialNumber);

    const pos = [pad.pos[0], pad.pos[1], 0.0]; // strictly z = 0.0 for immutable warehouse_manager.js compatibility!
    const stateObj = {
      doorProgress,
      doorState: doorProgress >= 0.5 ? 2 : 0,
      liveryId,
      serialNumber,
      slots,
    };

    const entry = spawnLocalContainerFn
      ? spawnLocalContainerFn(guid, spec.kind, pos, pad.heading ?? 0.0, stateObj)
      : promoteLocalContainerFallback(guid, spec.kind, pos, pad.heading ?? 0.0, stateObj);

    if (entry && entry.model && typeof entry.model.syncSlots === "function") {
      try { entry.model.syncSlots(entry.slots); } catch (_) {}
    }

    const rec = {
      padId: pid,
      guid,
      wcid: spec.wcid,
      kind: spec.kind,
      sizeFt: spec.sizeFt,
      liveryId,
      serialNumber,
      bic,
      pos,
      heading: pad.heading ?? 0.0,
      entry,
    };
    promotedPadContainers.set(pid, rec);
    return rec;
  }

  function pickupFromWarehousePad(padId) {
    const pid = String(padId || "C1").toUpperCase();
    const rec = promotedPadContainers.get(pid);
    if (!rec) return null;

    const liveEntry = containers.get(rec.guid);
    const latestSlots = Array.isArray(liveEntry?.slots)
      ? liveEntry.slots.map((s) => ({ ...s }))
      : (Array.isArray(rec.entry?.slots) ? rec.entry.slots.map((s) => ({ ...s })) : []);

    if (removeLocalContainerFn) {
      try { removeLocalContainerFn(rec.guid); } catch (_) {}
    } else {
      demoteLocalContainerFallback(rec.guid);
    }
    promotedPadContainers.delete(pid);

    return {
      padId: pid,
      guid: rec.guid,
      wcid: rec.wcid,
      kind: rec.kind,
      sizeFt: rec.sizeFt,
      liveryId: rec.liveryId,
      serialNumber: rec.serialNumber,
      bic: rec.bic,
      slots: latestSlots,
    };
  }

  function clearWarehousePads() {
    for (const pid of [...promotedPadContainers.keys()]) {
      pickupFromWarehousePad(pid);
    }
  }

  const warehouseBridge = {
    deliverToPad: deliverToWarehousePad,
    pickupFromPad: pickupFromWarehousePad,
    getPad: (padId) => promotedPadContainers.get(String(padId || "").toUpperCase()) ?? null,
    listPads: () => [...promotedPadContainers.values()].map((r) => ({
      padId: r.padId,
      guid: r.guid,
      wcid: r.wcid,
      kind: r.kind,
      bic: r.bic,
      pos: [...r.pos],
      slotCount: (containers.get(r.guid)?.slots || []).length,
    })),
    clearPads: clearWarehousePads,
  };

  // =========================================================================
  // Equipment Queue Builders (STS Cranes, Yard Cranes, Shuttles)
  // =========================================================================

  function findNearestRoadNode(x, y) {
    if (!layout?.graph?.nodes?.length) return null;
    let best = layout.graph.nodes[0];
    let bestD = Infinity;
    for (const n of layout.graph.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  function findMooredShipAtBerth(berthId) {
    if (!shipManager || typeof shipManager.list !== "function") return null;
    const all = shipManager.list();
    return all.find((s) => s.moored && s.mooredBerthId === berthId) || all.find((s) => s.moored) || null;
  }

  function makeStsPublicHandle(rec) {
    function enqueue(job) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      return new Promise((resolve, reject) => {
        rec.queue.push({ job, resolve, reject, started: false });
      });
    }

    function transferShipToApron(opts = {}) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      const shipSnap = opts.shipId
        ? shipManager?.get?.(opts.shipId)
        : (() => {
          const found = findMooredShipAtBerth(rec.state.berthId);
          return found ? shipManager?.get?.(found.id) : null;
        })();
      if (!shipSnap) {
        return Promise.reject(new Error(`STS ${rec.id}: no moored ship found for discharge`));
      }

      let bay = opts.bay;
      let row = opts.row;
      let tier = opts.tier;
      let slotEntry = null;
      if (Number.isInteger(bay) && Number.isInteger(row) && Number.isInteger(tier)) {
        slotEntry = shipSnap.cargo.get(bay, row, tier);
      } else {
        slotEntry = shipSnap.cargo.findNextDischargeable(opts.preferredBay ?? null);
        if (slotEntry) {
          bay = slotEntry.bay;
          row = slotEntry.row;
          tier = slotEntry.tier;
        }
      }
      if (!slotEntry) {
        return Promise.reject(new Error(`STS ${rec.id}: no dischargeable container on ship ${shipSnap.id}`));
      }

      const slotWorld = shipManager.getCargoSlotWorldPos(shipSnap.id, bay, row, tier);
      if (!slotWorld) {
        return Promise.reject(new Error(`STS ${rec.id}: unable to resolve world pose for ${bay}/${row}/${tier}`));
      }

      const spec = resolvePortContainerSpec(slotEntry.wcid);
      const shuttle = opts.shuttleId ? shuttleEntries.get(opts.shuttleId) : null;
      const laneLocalY = QUAY_SPECS.portalLaneLocalYs[1]; // -13.0 m (main portal transfer lane)
      const apronY = fin(opts.apronY) ? opts.apronY : (shuttle ? shuttle.state.y : layout.origin[1] + laneLocalY);
      const apronX = fin(opts.apronX) ? opts.apronX : (shuttle ? shuttle.state.x : slotWorld.top[0]);
      const apronZ = layout.bounds.quayDeckZ + (shuttle ? SHUTTLE_SPECS.deckZ : 0.0) + spec.extH;

      const containerMeta = {
        wcid: slotEntry.wcid,
        kind: slotEntry.kind,
        sizeFt: slotEntry.sizeFt,
        liveryId: slotEntry.liveryId,
        bic: slotEntry.bic,
        reefer: slotEntry.reefer,
        slots: Array.isArray(slotEntry.slots) ? slotEntry.slots.map((s) => ({ ...s })) : [],
      };

      return enqueue({
        type: "shipToApron",
        shipId: shipSnap.id,
        bay,
        row,
        tier,
        shuttleId: shuttle ? shuttle.id : null,
        pickPos: slotWorld.top,
        placePos: [apronX, apronY, apronZ],
        container: containerMeta,
        onPicked() {
          shipManager.unloadContainer(shipSnap.id, bay, row, tier);
        },
        onPlaced() {
          if (shuttle) {
            shuttle.state.cargo = { ...containerMeta };
          }
        },
      });
    }

    function transferApronToShip(opts = {}) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      const shipSnap = opts.shipId
        ? shipManager?.get?.(opts.shipId)
        : (() => {
          const found = findMooredShipAtBerth(rec.state.berthId);
          return found ? shipManager?.get?.(found.id) : null;
        })();
      if (!shipSnap) {
        return Promise.reject(new Error(`STS ${rec.id}: no moored ship found for loading`));
      }

      const shuttle = opts.shuttleId ? shuttleEntries.get(opts.shuttleId) : null;
      const containerMeta = opts.container || shuttle?.state?.cargo;
      if (!containerMeta) {
        return Promise.reject(new Error(`STS ${rec.id}: no container supplied for apron-to-ship load`));
      }
      const spec = resolvePortContainerSpec(containerMeta);

      let bay = opts.bay;
      let row = opts.row;
      let tier = opts.tier;
      if (!Number.isInteger(bay) || !Number.isInteger(row) || !Number.isInteger(tier)) {
        const free = shipSnap.cargo.findFreeDeckSlot(spec.wcid, opts.preferredBay ?? null);
        if (!free) return Promise.reject(new Error(`STS ${rec.id}: no free ship deck slot for ${spec.key}`));
        bay = free.bay;
        row = free.row;
        tier = free.tier;
      }

      const slotWorld = shipManager.getCargoSlotWorldPos(shipSnap.id, bay, row, tier, spec.wcid);
      if (!slotWorld) {
        return Promise.reject(new Error(`STS ${rec.id}: unable to resolve ship slot world pose`));
      }

      const laneLocalY = QUAY_SPECS.portalLaneLocalYs[1];
      const pickX = fin(opts.pickX) ? opts.pickX : (shuttle ? shuttle.state.x : slotWorld.top[0]);
      const pickY = fin(opts.pickY) ? opts.pickY : (shuttle ? shuttle.state.y : layout.origin[1] + laneLocalY);
      const pickZ = layout.bounds.quayDeckZ + (shuttle ? SHUTTLE_SPECS.deckZ : 0.0) + spec.extH;

      return enqueue({
        type: "apronToShip",
        shipId: shipSnap.id,
        bay,
        row,
        tier,
        shuttleId: shuttle ? shuttle.id : null,
        pickPos: [pickX, pickY, pickZ],
        placePos: slotWorld.top,
        container: { ...containerMeta, wcid: spec.wcid, kind: spec.kind, sizeFt: spec.sizeFt },
        onPicked() {
          if (shuttle) shuttle.state.cargo = null;
        },
        onPlaced() {
          shipManager.loadContainer(shipSnap.id, bay, row, tier, containerMeta);
        },
      });
    }

    return {
      id: rec.id,
      berthId: rec.state.berthId,
      state: rec.state,
      model: rec.model,
      get queueLength() { return rec.queue.length; },
      enqueue,
      transferShipToApron,
      transferApronToShip,
      setBoomStowed(stowed) {
        rec.state.boomStowed = Boolean(stowed);
        rec.state.targetBoomAngle = rec.state.boomStowed ? STS_CRANE_SPECS.boomStowedAngleRad : 0.0;
      },
      setPoseImmediate(pose = {}) {
        if (fin(pose.x)) { rec.state.x = pose.x; rec.state.targetX = pose.x; }
        if (fin(pose.trolleyY)) { rec.state.trolleyY = pose.trolleyY; rec.state.targetTrolleyY = pose.trolleyY; }
        if (fin(pose.spreaderZ)) { rec.state.spreaderZ = pose.spreaderZ; rec.state.targetSpreaderZ = pose.spreaderZ; }
        if (fin(pose.spreaderLen)) { rec.state.spreaderLen = pose.spreaderLen; rec.state.targetSpreaderLen = pose.spreaderLen; }
        if (fin(pose.boomAngle)) { rec.state.boomAngle = pose.boomAngle; rec.state.targetBoomAngle = pose.boomAngle; }
        if (fin(pose.twistlockAngle)) {
          rec.state.twistlockAngle = pose.twistlockAngle;
          rec.state.targetTwistlockAngle = pose.twistlockAngle;
          rec.state.twistlocksLocked = pose.twistlockAngle >= Math.PI * 0.45;
        }
        if (pose.carriedContainer !== undefined) rec.state.carriedContainer = pose.carriedContainer;
        rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
      },
    };
  }

  function makeYardCranePublicHandle(rec) {
    function enqueue(job) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      return new Promise((resolve, reject) => {
        rec.queue.push({ job, resolve, reject, started: false });
      });
    }

    function transferTtlToYard(opts = {}) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      const blockId = opts.blockId || rec.state.blockIds[0];
      const block = layout.blocks[blockId];
      if (!block) return Promise.reject(new Error(`YardCrane ${rec.id}: unknown block ${blockId}`));
      const shuttle = opts.shuttleId ? shuttleEntries.get(opts.shuttleId) : null;
      const containerMeta = opts.container || shuttle?.state?.cargo;
      if (!containerMeta) return Promise.reject(new Error(`YardCrane ${rec.id}: no container supplied`));
      const spec = resolvePortContainerSpec(containerMeta);

      let bay = opts.bay;
      let row = opts.row;
      let tier = opts.tier;
      let pose;
      if (Number.isInteger(bay) && Number.isInteger(row) && Number.isInteger(tier)) {
        pose = computeYardSlotWorldPose(blockId, bay, row, tier, spec.wcid, (b, r, t) => yardStore.get(blockId, b, r, t), layout.origin);
      } else {
        const free = yardStore.findFreeSlot(blockId, spec.wcid);
        if (!free) return Promise.reject(new Error(`YardCrane ${rec.id}: block ${blockId} is full`));
        bay = free.bay;
        row = free.row;
        tier = free.tier;
        pose = free.pose;
      }

      const pickX = fin(opts.ttlX) ? opts.ttlX : (shuttle ? shuttle.state.x : pose.x);
      const pickY = block.ttlY;
      const pickZ = layout.bounds.yardZ + SHUTTLE_SPECS.deckZ + spec.extH;

      return enqueue({
        type: "ttlToYard",
        blockId,
        bay,
        row,
        tier,
        pickPos: [pickX, pickY, pickZ],
        placePos: [pose.x, pose.y, pose.z + spec.extH],
        container: { ...containerMeta, wcid: spec.wcid, kind: spec.kind, sizeFt: spec.sizeFt },
        onPicked() {
          if (shuttle) shuttle.state.cargo = null;
        },
        onPlaced() {
          yard.place(blockId, bay, row, tier, containerMeta);
        },
      });
    }

    function transferYardToTtl(opts = {}) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      const blockId = opts.blockId || rec.state.blockIds[0];
      const block = layout.blocks[blockId];
      if (!block) return Promise.reject(new Error(`YardCrane ${rec.id}: unknown block ${blockId}`));
      const shuttle = opts.shuttleId ? shuttleEntries.get(opts.shuttleId) : null;

      let entry = null;
      if (Number.isInteger(opts.bay) && Number.isInteger(opts.row) && Number.isInteger(opts.tier)) {
        entry = yardStore.get(blockId, opts.bay, opts.row, opts.tier);
      } else {
        entry = yardStore.findTopContainer(blockId);
      }
      if (!entry) return Promise.reject(new Error(`YardCrane ${rec.id}: no removable container in block ${blockId}`));

      const placeX = fin(opts.ttlX) ? opts.ttlX : (shuttle ? shuttle.state.x : entry.x);
      const placeY = block.ttlY;
      const placeZ = layout.bounds.yardZ + SHUTTLE_SPECS.deckZ + entry.extH;
      const snapshot = {
        wcid: entry.wcid,
        kind: entry.kind,
        sizeFt: entry.sizeFt,
        liveryId: entry.liveryId,
        bic: entry.bic,
        reefer: entry.reefer,
        slots: Array.isArray(entry.slots) ? entry.slots.map((s) => ({ ...s })) : [],
      };

      return enqueue({
        type: "yardToTtl",
        blockId,
        bay: entry.bay,
        row: entry.row,
        tier: entry.tier,
        pickPos: [entry.x, entry.y, entry.topZ],
        placePos: [placeX, placeY, placeZ],
        container: snapshot,
        onPicked() {
          yard.remove(blockId, entry.bay, entry.row, entry.tier);
        },
        onPlaced() {
          if (shuttle) shuttle.state.cargo = { ...snapshot };
        },
      });
    }

    return {
      id: rec.id,
      type: rec.state.type,
      blockIds: [...rec.state.blockIds],
      state: rec.state,
      model: rec.model,
      get queueLength() { return rec.queue.length; },
      enqueue,
      transferTtlToYard,
      transferYardToTtl,
      setPoseImmediate(pose = {}) {
        if (fin(pose.x)) { rec.state.x = pose.x; rec.state.targetX = pose.x; }
        if (fin(pose.y)) { rec.state.y = pose.y; rec.state.targetY = pose.y; }
        if (fin(pose.trolleyY)) { rec.state.trolleyY = pose.trolleyY; rec.state.targetTrolleyY = pose.trolleyY; }
        if (fin(pose.spreaderZ)) { rec.state.spreaderZ = pose.spreaderZ; rec.state.targetSpreaderZ = pose.spreaderZ; }
        if (fin(pose.spreaderLen)) { rec.state.spreaderLen = pose.spreaderLen; rec.state.targetSpreaderLen = pose.spreaderLen; }
        if (fin(pose.twistlockAngle)) {
          rec.state.twistlockAngle = pose.twistlockAngle;
          rec.state.targetTwistlockAngle = pose.twistlockAngle;
          rec.state.twistlocksLocked = pose.twistlockAngle >= Math.PI * 0.45;
        }
        if (fin(pose.wheelSteerRad)) { rec.state.wheelSteerRad = pose.wheelSteerRad; rec.state.targetWheelSteerRad = pose.wheelSteerRad; }
        if (pose.carriedContainer !== undefined) rec.state.carriedContainer = pose.carriedContainer;
        rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
      },
    };
  }

  function makeShuttlePublicHandle(rec) {
    function enqueue(job) {
      if (!built || disposed) return Promise.reject(new Error("Terminal not built or disposed"));
      return new Promise((resolve, reject) => {
        rec.queue.push({ job, resolve, reject, waypointIndex: 0 });
      });
    }

    function driveToNode(goalNodeId, opts = {}) {
      if (!built || !layout) return Promise.reject(new Error("Terminal not built"));
      const startNode = findNearestRoadNode(rec.state.x, rec.state.y);
      if (!startNode) return Promise.reject(new Error("Road graph empty"));
      const path = findRoadPath(layout.graph, startNode.id, goalNodeId);
      if (path.length === 0) return Promise.reject(new Error(`No road path from ${startNode.id} to ${goalNodeId}`));
      return enqueue({
        type: "drive",
        waypoints: path,
        finalHeading: opts.finalHeading,
        goalTolM: opts.goalTolM ?? 0.75,
        onArrive: opts.onArrive || null,
      });
    }

    function drivePath(waypoints, opts = {}) {
      if (!Array.isArray(waypoints) || waypoints.length === 0) {
        return Promise.resolve({ arrived: true });
      }
      const norm = waypoints.map((w) => (Array.isArray(w) ? { x: w[0], y: w[1] } : { x: w.x, y: w.y }));
      return enqueue({
        type: "drive",
        waypoints: norm,
        finalHeading: opts.finalHeading,
        goalTolM: opts.goalTolM ?? 0.75,
        onArrive: opts.onArrive || null,
      });
    }

    return {
      id: rec.id,
      state: rec.state,
      model: rec.model,
      get queueLength() { return rec.queue.length; },
      enqueue,
      driveToNode,
      drivePath,
      setCargo(cargo) {
        rec.state.cargo = cargo ? { ...cargo } : null;
        rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
      },
      setPoseImmediate(pose = {}) {
        if (fin(pose.x)) rec.state.x = pose.x;
        if (fin(pose.y)) rec.state.y = pose.y;
        if (fin(pose.heading)) rec.state.heading = pose.heading;
        rec.state.z = fin(pose.z) ? pose.z : quayRampZ(rec.state.y, layout.origin);
        rec.state.pitch = fin(pose.pitch) ? pose.pitch : quayRampPitch(rec.state.y, rec.state.heading, layout.origin);
        rec.state.speed = fin(pose.speed) ? pose.speed : 0.0;
        if (pose.cargo !== undefined) rec.state.cargo = pose.cargo ? { ...pose.cargo } : null;
        reservationGrid.updateAgent(rec.id, rec.state.x, rec.state.y, rec.state.heading, rec.state.speed);
        rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
      },
    };
  }

  // =========================================================================
  // Terminal Build & Clear Lifecycle
  // =========================================================================

  function buildTerminal(opts = {}) {
    if (disposed) throw new Error("PortTerminalManager is disposed");
    if (built) clearTerminal();

    for (const rec of serverDeployables.values()) {
      disposeServerDeployableModel(rec);
    }

    const origin = Array.isArray(opts.origin) ? [...opts.origin] : [...PORT_ORIGIN];
    layout = buildPortLayout(origin);
    yardStore = createYardStackStore(layout.origin);
    reservationGrid.clear();

    const rootGroup = ensureTerminalRoot();
    if (THREE && rootGroup) {
      quayModel = buildPortQuay(THREE, layout, { csmState: csmStateOf(), origin: layout.origin });
      rootGroup.add(quayModel.root);

      yardPool = createContainerStackPool(THREE, {
        csmState: csmStateOf(),
        origin: layout.origin,
        maxInstances: opts.maxYardContainers ?? 400,
      });
      rootGroup.add(yardPool.root);
    }

    // Spawn STS-1 & STS-2 on shared quay crane rails
    for (const def of layout.stsCranes) {
      const state = createStsCraneState({
        id: def.id,
        berthId: def.berthId,
        origin: layout.origin,
        x: def.x,
        y: def.y,
        z: def.z,
        railMinX: def.railMinX,
        railMaxX: def.railMaxX,
        boomStowed: def.boomStowed,
      });
      let model = null;
      if (THREE && rootGroup) {
        model = buildStsCrane(THREE, { csmState: csmStateOf(), initialState: state });
        rootGroup.add(model.root);
      }
      const rec = { id: def.id, state, model, queue: [] };
      stsEntries.set(def.id, rec);
      stsPublic.set(def.id, makeStsPublicHandle(rec));
    }

    // Spawn RMG-1, RMG-2 & RTG-1 yard gantry cranes
    for (const def of layout.yardCranes) {
      const state = createYardCraneState({
        id: def.id,
        type: def.type,
        blockIds: def.blockIds,
        x: def.x,
        y: def.y,
        z: def.z,
        minX: def.minX,
        maxX: def.maxX,
      });
      let model = null;
      if (THREE && rootGroup) {
        model = buildYardCrane(THREE, def.type, { csmState: csmStateOf(), initialState: state });
        rootGroup.add(model.root);
      }
      const rec = { id: def.id, state, model, queue: [] };
      yardCraneEntries.set(def.id, rec);
      yardCranesPublic.set(def.id, makeYardCranePublicHandle(rec));
    }

    // Spawn TT-1, TT-2, TT-3 autonomous terminal tractor shuttles
    const nodeById = new Map(layout.graph.nodes.map((n) => [n.id, n]));
    for (const def of SHUTTLE_SPECS.defaultShuttles) {
      const startN = nodeById.get(def.startNode) || layout.graph.nodes[0];
      const state = createShuttleState({
        id: def.id,
        origin: layout.origin,
        x: startN.x,
        y: startN.y,
        heading: Math.PI * 0.5,
      });
      let model = null;
      if (THREE && rootGroup) {
        model = buildPortShuttle(THREE, { csmState: csmStateOf(), initialState: state });
        rootGroup.add(model.root);
      }
      reservationGrid.updateAgent(def.id, state.x, state.y, state.heading, 0.0);
      const rec = { id: def.id, state, model, queue: [], yieldSec: 0.0 };
      shuttleEntries.set(def.id, rec);
      shuttlesPublic.set(def.id, makeShuttlePublicHandle(rec));
    }

    if (opts.populateYard !== false) {
      populateDefaultYardStacks(yardStore, opts.yardDensity || "standard");
    }
    syncYardPool();

    built = true;
    for (const rec of [...serverDeployables.values()]) {
      onDeployableState({ ...rec, deployable: rec.guid }, [rec.x, rec.y, rec.z]);
    }
    return layout;
  }

  function stopScenarios() {
    if (!activeScenario) return;
    const sc = activeScenario;
    sc.stopped = true;
    activeScenario = null;
    for (const r of stsEntries.values()) rejectPendingQueue(r.queue, "Scenario stopped");
    for (const r of yardCraneEntries.values()) rejectPendingQueue(r.queue, "Scenario stopped");
    for (const r of shuttleEntries.values()) rejectPendingQueue(r.queue, "Scenario stopped");
    try { sc.resolve?.({ stopped: true, name: sc.name }); } catch (_) {}
  }

  function clearTerminal() {
    stopScenarios();
    clearWarehousePads();
    clearServerDeployables();

    for (const r of stsEntries.values()) {
      rejectPendingQueue(r.queue, "Terminal cleared");
      try { portAudio?.removeCrane?.(r.id); } catch (_) {}
      try {
        if (r.model?.root?.parent) r.model.root.parent.remove(r.model.root);
        r.model?.dispose?.();
      } catch (_) {}
    }
    stsEntries.clear();
    stsPublic.clear();

    for (const r of yardCraneEntries.values()) {
      rejectPendingQueue(r.queue, "Terminal cleared");
      try { portAudio?.removeCrane?.(r.id); } catch (_) {}
      try {
        if (r.model?.root?.parent) r.model.root.parent.remove(r.model.root);
        r.model?.dispose?.();
      } catch (_) {}
    }
    yardCraneEntries.clear();
    yardCranesPublic.clear();

    for (const r of shuttleEntries.values()) {
      rejectPendingQueue(r.queue, "Terminal cleared");
      try {
        if (r.model?.root?.parent) r.model.root.parent.remove(r.model.root);
        r.model?.dispose?.();
      } catch (_) {}
    }
    shuttleEntries.clear();
    shuttlesPublic.clear();

    if (yardPool) {
      try {
        if (yardPool.root?.parent) yardPool.root.parent.remove(yardPool.root);
        yardPool.dispose?.();
      } catch (_) {}
      yardPool = null;
    }
    if (quayModel) {
      try {
        if (quayModel.root?.parent) quayModel.root.parent.remove(quayModel.root);
        quayModel.dispose?.();
      } catch (_) {}
      quayModel = null;
    }

    yardStore.clear();
    reservationGrid.clear();
    detachTerminalRoot();
    layout = null;
    built = false;
  }

  // =========================================================================
  // Deterministic Scenarios (0 setTimeout — driven strictly by tick(dt))
  // =========================================================================

  function runScenario(name = "port-import-to-warehouse", opts = {}) {
    if (!built) buildTerminal({ origin: opts.origin || PORT_ORIGIN });
    stopScenarios();

    let resolveSc, rejectSc;
    const promise = new Promise((res, rej) => { resolveSc = res; rejectSc = rej; });
    const sc = { name: String(name), stopped: false, resolve: resolveSc, reject: rejectSc };
    activeScenario = sc;

    const runAsync = async () => {
      try {
        if (sc.name === "port-import-to-warehouse") {
          const sts1 = stsPublic.get("STS-1");
          const rmg1 = yardCranesPublic.get("RMG-1");
          const tt1 = shuttlesPublic.get("TT-1");
          const tt3 = shuttlesPublic.get("TT-3");
          const padId = opts.padId || "C1";

          // 1. Position TT-1 under STS-1 portal & discharge container from ship at Berth 1
          await tt1.driveToNode("quay_lane_b1", { finalHeading: Math.PI * 0.5 });
          if (sc.stopped) return;
          const discharged = await sts1.transferShipToApron({
            shipId: opts.shipId,
            shuttleId: "TT-1",
            bay: opts.bay,
            row: opts.row,
            tier: opts.tier,
          });
          if (sc.stopped) return;

          // 2. Drive TT-1 down the 4.76 deg quay approach ramp to Block A1 TTL
          await tt1.driveToNode("ttl_A1_mid", { finalHeading: Math.PI * 0.5 });
          if (sc.stopped) return;

          // 3. RMG-1 lifts discharged container off TT-1 into ISO 9711 yard stack A1
          const stacked = await rmg1.transferTtlToYard({ blockId: "A1", shuttleId: "TT-1" });
          if (sc.stopped) return;

          // 4. TT-1 clears Block A1 TTL while TT-3 arrives; RMG-1 removes the exact stacked box
          //    from Block A1 onto TT-3 (conserving BIC — zero duplication in A1!), then TT-3
          //    delivers it onto Warehouse Zone A Drop Pad C1 (promoted to __vehicles.containers!)
          await Promise.all([
            tt1.driveToNode("yard_n_w", { finalHeading: Math.PI * 1.5 }),
            tt3.driveToNode("ttl_A1_mid", { finalHeading: Math.PI * 0.5 }),
          ]);
          if (sc.stopped) return;
          const pickedFromYard = await rmg1.transferYardToTtl({
            blockId: "A1",
            bay: stacked?.bay,
            row: stacked?.row,
            tier: stacked?.tier,
            shuttleId: "TT-3",
          });
          if (sc.stopped) return;

          await tt3.driveToNode(`wh_pad_${padId}`, { finalHeading: 0.0 });
          if (sc.stopped) return;
          const handoffMeta = pickedFromYard?.container || tt3.state.cargo || discharged?.container;
          tt3.setCargo(null);
          const promoted = deliverToWarehousePad(padId, {
            ...handoffMeta,
            doorProgress: 1.0,
          });

          if (activeScenario === sc) activeScenario = null;
          resolveSc({
            ok: true,
            name: sc.name,
            padId,
            promotedGuid: promoted.guid,
            bic: promoted.bic,
            stackedSlot: stacked ? { blockId: stacked.blockId, bay: stacked.bay, row: stacked.row, tier: stacked.tier } : null,
          });
        } else if (sc.name === "port-outbound-to-ship") {
          const padId = opts.padId || "C1";
          const tt1 = shuttlesPublic.get("TT-1");
          const sts1 = stsPublic.get("STS-1");
          const picked = pickupFromWarehousePad(padId);
          if (!picked) throw new Error(`No container on warehouse drop pad ${padId} for outbound pickup`);
          tt1.setCargo(picked);
          await tt1.driveToNode("quay_lane_b1", { finalHeading: Math.PI * 0.5 });
          if (sc.stopped) return;
          await sts1.transferApronToShip({ shipId: opts.shipId, shuttleId: "TT-1", container: picked });
          if (sc.stopped) return;
          if (opts.departShip && opts.shipId) {
            shipManager?.commandDepart?.(opts.shipId);
          }
          if (activeScenario === sc) activeScenario = null;
          resolveSc({ ok: true, name: sc.name, padId, loadedBic: picked.bic });
        } else {
          // "full-port-ops": parallel shuttle loop + yard crane move
          const rmg1 = yardCranesPublic.get("RMG-1");
          const rtg1 = yardCranesPublic.get("RTG-1");
          const tt2 = shuttlesPublic.get("TT-2");
          await Promise.all([
            tt2.driveToNode("ttl_B1_mid", { finalHeading: Math.PI * 0.5 }),
            rmg1.transferYardToTtl({ blockId: "A1" }).catch(() => null),
            rtg1.transferYardToTtl({ blockId: "B1" }).catch(() => null),
          ]);
          if (activeScenario === sc) activeScenario = null;
          resolveSc({ ok: true, name: sc.name });
        }
      } catch (err) {
        if (activeScenario === sc) activeScenario = null;
        if (!sc.stopped) rejectSc(err);
      }
    };
    runAsync();
    return promise;
  }

  function isWithinBuiltFootprint(wx, wy) {
    if (!built || !layout) return false;
    const ox = layout.origin[0];
    const oy = layout.origin[1];
    return (
      wx >= ox + PORT_SITE.localMinX - 25.0 &&
      wx <= ox + PORT_SITE.localMaxX + 25.0 &&
      wy >= oy - 230.0 &&
      wy <= oy + 25.0
    );
  }

  function findNearestAvailableLocalUnit(map, guid, wx, wy, filterFn = null) {
    let best = null;
    let bestD = Infinity;
    for (const rec of map.values()) {
      if (filterFn && !filterFn(rec)) continue;
      const boundGuid = rec.boundServerGuid >>> 0;
      if (boundGuid !== 0 && boundGuid !== guid) continue;
      const d = Math.hypot((rec.state?.x ?? 0) - wx, (rec.state?.y ?? 0) - wy);
      if (d < bestD) {
        bestD = d;
        best = rec;
      }
    }
    return best;
  }

  function releaseBoundUnit(rec) {
    if (!rec || !rec.boundUnitId) return;
    if (rec.boundType === "sts") {
      const u = stsEntries.get(rec.boundUnitId);
      if (u && (u.boundServerGuid >>> 0) === rec.guid) u.boundServerGuid = 0;
    } else if (rec.boundType === "yardCrane") {
      const u = yardCraneEntries.get(rec.boundUnitId);
      if (u && (u.boundServerGuid >>> 0) === rec.guid) u.boundServerGuid = 0;
    } else if (rec.boundType === "shuttle") {
      const u = shuttleEntries.get(rec.boundUnitId);
      if (u && (u.boundServerGuid >>> 0) === rec.guid) u.boundServerGuid = 0;
    }
    rec.boundUnitId = null;
    rec.boundType = null;
  }

  function disposeServerDeployableModel(rec) {
    if (!rec) return;
    releaseBoundUnit(rec);
    if (rec.model) {
      try {
        if (rec.model.root?.parent) rec.model.root.parent.remove(rec.model.root);
        rec.model.dispose?.();
      } catch (_) {}
      rec.model = null;
    }
  }

  function buildStandaloneServerDeployableModel(kind, wx, wy, wz, heading, stowed, active) {
    const rootGroup = ensureTerminalRoot();
    if (!THREE || !rootGroup) return null;
    let model = null;
    if (kind === PORT_DEPLOYABLE_KIND.StsGantryCrane) {
      model = buildStsCrane(THREE, {
        csmState: csmStateOf(),
        initialState: {
          x: wx,
          y: wy,
          z: wz,
          boomAngle: stowed ? STS_CRANE_SPECS.boomStowedAngleRad : 0.0,
          active,
          timeSec: simTimeSec,
        },
      });
    } else if (kind === PORT_DEPLOYABLE_KIND.RmgYardCrane) {
      model = buildYardCrane(THREE, "RMG", {
        csmState: csmStateOf(),
        initialState: { x: wx, y: wy, z: wz, active, timeSec: simTimeSec },
      });
    } else if (kind === PORT_DEPLOYABLE_KIND.RtgYardCrane) {
      model = buildYardCrane(THREE, "RTG", {
        csmState: csmStateOf(),
        initialState: { x: wx, y: wy, z: wz, active, timeSec: simTimeSec },
      });
    } else if (kind === PORT_DEPLOYABLE_KIND.TerminalTractorShuttle) {
      model = buildPortShuttle(THREE, {
        csmState: csmStateOf(),
        initialState: { x: wx, y: wy, z: wz, heading, timeSec: simTimeSec },
      });
    } else {
      model = buildStandalonePortFixture(THREE, kind, csmStateOf());
    }
    if (model && model.root) {
      model.root.position.set(wx, wy, wz);
      model.root.rotation.z = -heading;
      rootGroup.add(model.root);
    }
    return model;
  }

  function onDeployableState(msg, worldPos = null) {
    if (disposed || !msg || typeof msg !== "object") return null;
    const kind = (Number(msg.kind) || 0) | 0;
    const wcid = KIND_TO_PORT_WCID[kind] || 0;
    const guid = (Number(msg.deployable ?? msg.guid) || 0) >>> 0;
    if (!wcid || !guid) return null;

    const onlineFlags = (Number(msg.onlineFlags) || 0) | 0;
    const stowed = Boolean(onlineFlags & 0x10);
    const powered = Boolean(onlineFlags & 0x01) && !stowed;
    const active = Boolean(onlineFlags & 0x04);
    const posSrc = Array.isArray(worldPos) && worldPos.length >= 3
      ? worldPos
      : [msg.x ?? 0, msg.y ?? 0, msg.z ?? 0];
    const wx = fin(Number(posSrc[0])) ? Number(posSrc[0]) : 0;
    const wy = fin(Number(posSrc[1])) ? Number(posSrc[1]) : 0;
    const wz = fin(Number(posSrc[2])) ? Number(posSrc[2]) : 0;
    const heading = fin(Number(msg.heading)) ? Number(msg.heading) : 0;
    const pitch = fin(Number(msg.pitch)) ? Number(msg.pitch) : 0;
    const yaw = fin(Number(msg.yaw)) ? Number(msg.yaw) : 0;
    const roll = fin(Number(msg.roll)) ? Number(msg.roll) : 0;
    const elevation = fin(Number(msg.elevation)) ? Number(msg.elevation) : 0;
    const powerWatts = fin(Number(msg.powerWatts)) ? Number(msg.powerWatts) : 0;
    const energyJoules = fin(Number(msg.energyJoules)) ? Number(msg.energyJoules) : 0;
    const energyCapacity = fin(Number(msg.energyCapacity)) ? Number(msg.energyCapacity) : 0;
    const fuelSec = fin(Number(msg.fuelSec)) ? Number(msg.fuelSec) : 0;

    let rec = serverDeployables.get(guid);
    if (rec && rec.kind !== kind) {
      disposeServerDeployableModel(rec);
      serverDeployables.delete(guid);
      rec = null;
    }
    if (!rec) {
      rec = {
        guid,
        kind,
        wcid,
        x: wx,
        y: wy,
        z: wz,
        heading,
        pitch,
        yaw,
        roll,
        elevation,
        onlineFlags,
        powered,
        stowed,
        active,
        powerWatts,
        energyJoules,
        energyCapacity,
        fuelSec,
        boundUnitId: null,
        boundType: null,
        model: null,
      };
      serverDeployables.set(guid, rec);
    } else {
      rec.x = wx;
      rec.y = wy;
      rec.z = wz;
      rec.heading = heading;
      rec.pitch = pitch;
      rec.yaw = yaw;
      rec.roll = roll;
      rec.elevation = elevation;
      rec.onlineFlags = onlineFlags;
      rec.powered = powered;
      rec.stowed = stowed;
      rec.active = active;
      rec.powerWatts = powerWatts;
      rec.energyJoules = energyJoules;
      rec.energyCapacity = energyCapacity;
      rec.fuelSec = fuelSec;
    }

    const inFootprint = isWithinBuiltFootprint(wx, wy);
    if (inFootprint) {
      if (rec.model) {
        try {
          if (rec.model.root?.parent) rec.model.root.parent.remove(rec.model.root);
          rec.model.dispose?.();
        } catch (_) {}
        rec.model = null;
      }
      if (kind === PORT_DEPLOYABLE_KIND.StsGantryCrane) {
        const unit = rec.boundUnitId ? stsEntries.get(rec.boundUnitId) : findNearestAvailableLocalUnit(stsEntries, guid, wx, wy);
        if (unit) {
          unit.boundServerGuid = guid;
          rec.boundUnitId = unit.id;
          rec.boundType = "sts";
          if (unit.queue.length === 0) {
            unit.state.boomStowed = stowed;
            unit.state.targetBoomAngle = stowed ? STS_CRANE_SPECS.boomStowedAngleRad : 0.0;
            unit.state.targetX = clamp(wx, unit.state.railMinX, unit.state.railMaxX);
          }
          return rec;
        }
      } else if (kind === PORT_DEPLOYABLE_KIND.RmgYardCrane || kind === PORT_DEPLOYABLE_KIND.RtgYardCrane) {
        const wantType = kind === PORT_DEPLOYABLE_KIND.RmgYardCrane ? "RMG" : "RTG";
        const unit = rec.boundUnitId
          ? yardCraneEntries.get(rec.boundUnitId)
          : findNearestAvailableLocalUnit(yardCraneEntries, guid, wx, wy, (u) => u.state?.type === wantType);
        if (unit) {
          unit.boundServerGuid = guid;
          rec.boundUnitId = unit.id;
          rec.boundType = "yardCrane";
          if (unit.queue.length === 0) {
            unit.state.targetX = clamp(wx, unit.state.minX, unit.state.maxX);
          }
          return rec;
        }
      } else if (kind === PORT_DEPLOYABLE_KIND.TerminalTractorShuttle) {
        const unit = rec.boundUnitId ? shuttleEntries.get(rec.boundUnitId) : findNearestAvailableLocalUnit(shuttleEntries, guid, wx, wy);
        if (unit) {
          unit.boundServerGuid = guid;
          rec.boundUnitId = unit.id;
          rec.boundType = "shuttle";
          if (unit.queue.length === 0) {
            unit.state.x = wx;
            unit.state.y = wy;
            unit.state.z = fin(wz) ? wz : quayRampZ(wy, layout.origin);
            unit.state.heading = heading;
            unit.state.pitch = quayRampPitch(wy, heading, layout.origin);
          }
          return rec;
        }
      } else {
        rec.boundUnitId = "QUAY";
        rec.boundType = "quay";
        return rec;
      }
    }

    // Standalone mesh (unbuilt terminal or outside built terminal footprint)
    releaseBoundUnit(rec);
    if (!rec.model) {
      rec.model = buildStandaloneServerDeployableModel(kind, wx, wy, wz, heading, stowed, active);
    }
    if (rec.model) {
      rec.model.root?.position?.set(wx, wy, wz);
      if (rec.model.root?.rotation) rec.model.root.rotation.z = -heading;
      try {
        if (kind === PORT_DEPLOYABLE_KIND.StsGantryCrane) {
          rec.model.update({
            x: wx,
            y: wy,
            z: wz,
            boomAngle: stowed ? STS_CRANE_SPECS.boomStowedAngleRad : 0.0,
            active,
            timeSec: simTimeSec,
          });
        } else if (kind === PORT_DEPLOYABLE_KIND.RmgYardCrane || kind === PORT_DEPLOYABLE_KIND.RtgYardCrane) {
          rec.model.update({ x: wx, y: wy, z: wz, active, timeSec: simTimeSec });
        } else if (kind === PORT_DEPLOYABLE_KIND.TerminalTractorShuttle) {
          rec.model.update({ x: wx, y: wy, z: wz, heading, pitch, timeSec: simTimeSec });
        } else {
          rec.model.update({ x: wx, y: wy, z: wz, heading, powered, stowed, active, timeSec: simTimeSec });
        }
      } catch (_) {}
    }
    return rec;
  }

  function onDeployableDespawn(guid) {
    const g = (Number(guid) || 0) >>> 0;
    if (!g) return false;
    const rec = serverDeployables.get(g);
    if (!rec) return false;
    disposeServerDeployableModel(rec);
    serverDeployables.delete(g);
    return true;
  }

  function clearServerDeployables() {
    for (const rec of serverDeployables.values()) {
      disposeServerDeployableModel(rec);
    }
    serverDeployables.clear();
  }

  function getServerDeployables() {
    const out = [];
    for (const rec of serverDeployables.values()) {
      out.push({
        guid: rec.guid,
        kind: rec.kind,
        wcid: rec.wcid,
        pos: [rec.x, rec.y, rec.z],
        heading: rec.heading,
        onlineFlags: rec.onlineFlags,
        powered: rec.powered,
        stowed: rec.stowed,
        active: rec.active,
        powerWatts: rec.powerWatts,
        energyJoules: rec.energyJoules,
        energyCapacity: rec.energyCapacity,
        fuelSec: rec.fuelSec,
        elevation: rec.elevation,
        boundUnitId: rec.boundUnitId,
        boundType: rec.boundType,
      });
    }
    return out;
  }

  function countPoweredReeferRacks() {
    let n = 0;
    for (const rec of serverDeployables.values()) {
      if (rec.kind === PORT_DEPLOYABLE_KIND.ReeferRackBay && rec.powered) n++;
    }
    return n;
  }

  // =========================================================================
  // Per-Frame Deterministic Tick (zero setTimeout)
  // =========================================================================

  function tick(dt = 1 / 60, listenerPos = null) {
    if (disposed) return;
    const stepDt = fin(dt) ? clamp(dt, 0.0, 0.25) : 1 / 60;
    if (!built) {
      if (serverDeployables.size > 0) {
        simTimeSec += stepDt;
        tickCount++;
        for (const rec of serverDeployables.values()) {
          if (rec.model) {
            try {
              rec.model.update({ timeSec: simTimeSec, active: rec.active, powered: rec.powered, stowed: rec.stowed });
            } catch (_) {}
          }
        }
      }
      return;
    }
    simTimeSec += stepDt;
    tickCount++;

    // 1. Update Quay lighting pulse
    if (quayModel) {
      quayModel.update({ timeSec: simTimeSec });
    }

    // 2. Step STS Cranes + Enforce Shared-Rail Anti-Collision (>= 26 m)
    const stsStateList = [];
    for (const rec of stsEntries.values()) {
      const cur = rec.queue[0];
      if (cur) {
        if (!cur.started) {
          cur.started = true;
          rec.state.phase = STS_PHASE.IDLE;
        }
        const res = stepStsTransferCycle(rec.state, cur.job, stepDt);
        if (res.pickedEvent) {
          try { cur.job.onPicked?.(); } catch (_) {}
          portAudio?.playTwistlockClunk?.(rec.state.spreaderWorldPos, true);
        }
        if (res.placedEvent) {
          try { cur.job.onPlaced?.(); } catch (_) {}
          portAudio?.playTwistlockClunk?.(rec.state.spreaderWorldPos, false);
        }
        if (res.done) {
          rec.state.phase = STS_PHASE.IDLE;
          rec.queue.shift();
          try { cur.resolve({ ok: true, craneId: rec.id, container: cur.job.container }); } catch (_) {}
        }
      } else {
        stepStsCrane(rec.state, null, stepDt);
      }
      stsStateList.push(rec.state);
    }
    enforceStsRailAntiCollision(stsStateList);
    for (const rec of stsEntries.values()) {
      rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
      if (portAudio) {
        portAudio.updateCrane(rec.id, {
          pos: rec.state.spreaderWorldPos,
          gantrySpeed: rec.state.gantryVel,
          trolleySpeed: rec.state.trolleyVel,
          hoistSpeed: rec.state.hoistVel,
          active: rec.state.active,
        }, listenerPos);
      }
    }

    // 3. Step Yard Cranes (RMG-1, RMG-2, RTG-1) + Enforce Separation (>= 22 m)
    const ycStateList = [];
    for (const rec of yardCraneEntries.values()) {
      const cur = rec.queue[0];
      if (cur) {
        if (!cur.started) {
          cur.started = true;
          rec.state.phase = YARD_CRANE_PHASE.IDLE;
        }
        const res = stepYardTransferCycle(rec.state, cur.job, stepDt);
        if (res.pickedEvent) {
          try { cur.job.onPicked?.(); } catch (_) {}
          portAudio?.playTwistlockClunk?.(rec.state.spreaderWorldPos, true);
        }
        if (res.placedEvent) {
          try { cur.job.onPlaced?.(); } catch (_) {}
          portAudio?.playTwistlockClunk?.(rec.state.spreaderWorldPos, false);
        }
        if (res.done) {
          rec.state.phase = YARD_CRANE_PHASE.IDLE;
          rec.queue.shift();
          try {
            cur.resolve({
              ok: true,
              craneId: rec.id,
              blockId: cur.job.blockId,
              bay: cur.job.bay,
              row: cur.job.row,
              tier: cur.job.tier,
              container: cur.job.container,
            });
          } catch (_) {}
        }
      } else {
        stepYardCrane(rec.state, null, stepDt);
      }
      ycStateList.push(rec.state);
    }
    enforceYardCraneSeparation(ycStateList);
    for (const rec of yardCraneEntries.values()) {
      rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
      if (portAudio) {
        portAudio.updateCrane(rec.id, {
          pos: rec.state.spreaderWorldPos,
          gantrySpeed: rec.state.gantryVel,
          active: rec.state.active,
        }, listenerPos);
      }
    }

    // 4. Step Autonomous Terminal Tractor Shuttles (TT-1..TT-3) with Reservation Grid
    for (const rec of shuttleEntries.values()) {
      const cur = rec.queue[0];
      if (cur) {
        const res = stepShuttle(rec.state, cur.job.waypoints, stepDt, {
          origin: layout.origin,
          reservationGrid,
          waypointIndex: cur.waypointIndex,
          finalHeading: cur.job.finalHeading,
          goalTolM: cur.job.goalTolM,
        });
        cur.waypointIndex = res.waypointIndex;
        if (rec.state.status === "YIELDING") {
          rec.yieldSec = (rec.yieldSec || 0) + stepDt;
          // Fleet traffic management: if blocked behind an IDLE parked shuttle for > 0.5s,
          // dispatch the idle shuttle to clear the lane via an adjacent unoccupied road node.
          if (rec.yieldSec >= 0.5) {
            rec.yieldSec = 0;
            const fx = Math.sin(rec.state.heading);
            const fy = Math.cos(rec.state.heading);
            for (const other of shuttleEntries.values()) {
              if (other.id === rec.id || other.queue.length > 0) continue;
              const dx = other.state.x - rec.state.x;
              const dy = other.state.y - rec.state.y;
              const d = Math.hypot(dx, dy);
              if (d > 0.1 && d <= reservationGrid.slowDistM + 2.0 && (dx * fx + dy * fy) / d > 0.35) {
                // Pick a distant unoccupied staging node for the idle shuttle to pull clear
                const stagingCandidates = ["corridor_e", "corridor_w", "yard_mid_e", "yard_mid_w", "quay_e", "quay_w"];
                const goalPt = cur.job.waypoints[cur.job.waypoints.length - 1];
                let bestNodeId = null;
                let bestScore = -Infinity;
                for (const nid of stagingCandidates) {
                  const n = layout.graph.nodes.find((nd) => nd.id === nid);
                  if (!n) continue;
                  const distFromGoal = Math.hypot(n.x - goalPt.x, n.y - goalPt.y);
                  const distFromSelf = Math.hypot(n.x - rec.state.x, n.y - rec.state.y);
                  const occupied = [...shuttleEntries.values()].some((s) => s.id !== other.id && Math.hypot(s.state.x - n.x, s.state.y - n.y) < 30.0);
                  if (occupied) continue;
                  const score = distFromGoal + distFromSelf;
                  if (score > bestScore) { bestScore = score; bestNodeId = nid; }
                }
                if (bestNodeId) {
                  const handle = shuttlesPublic.get(other.id);
                  handle?.driveToNode?.(bestNodeId)?.catch?.(() => {});
                }
              }
            }
          }
        } else {
          rec.yieldSec = 0;
        }
        if (res.arrived) {
          rec.yieldSec = 0;
          rec.queue.shift();
          try { cur.job.onArrive?.(rec.state); } catch (_) {}
          try { cur.resolve({ arrived: true, shuttleId: rec.id, pos: [rec.state.x, rec.state.y, rec.state.z] }); } catch (_) {}
        }
      } else {
        rec.yieldSec = 0;
        stepShuttle(rec.state, [], stepDt, { origin: layout.origin, reservationGrid });
      }
      rec.model?.update?.({ ...rec.state, timeSec: simTimeSec });
    }

    // 5. Harbor quay ambient soundscape
    if (portAudio && layout) {
      portAudio.updateAmbient(listenerPos, layout.origin, true);
    }

    // 6. Standalone server deployables animation pulse (if any)
    for (const rec of serverDeployables.values()) {
      if (rec.model) {
        try {
          rec.model.update({ timeSec: simTimeSec, active: rec.active, powered: rec.powered, stowed: rec.stowed });
        } catch (_) {}
      }
    }
  }

  function getState() {
    const stsState = {};
    for (const [id, rec] of stsEntries.entries()) {
      const s = rec.state;
      stsState[id] = {
        id,
        berthId: s.berthId,
        x: s.x,
        y: s.y,
        z: s.z,
        boomAngle: s.boomAngle,
        trolleyY: s.trolleyY,
        spreaderZ: s.spreaderZ,
        spreaderLen: s.spreaderLen,
        twistlocksLocked: s.twistlocksLocked,
        phase: s.phase,
        carrying: Boolean(s.carriedContainer),
        queueLength: rec.queue.length,
      };
    }
    const ycState = {};
    for (const [id, rec] of yardCraneEntries.entries()) {
      const s = rec.state;
      ycState[id] = {
        id,
        type: s.type,
        blockIds: [...s.blockIds],
        x: s.x,
        y: s.y,
        z: s.z,
        trolleyY: s.trolleyY,
        spreaderZ: s.spreaderZ,
        wheelSteerRad: s.wheelSteerRad,
        phase: s.phase,
        carrying: Boolean(s.carriedContainer),
        queueLength: rec.queue.length,
      };
    }
    const shuttleState = {};
    for (const [id, rec] of shuttleEntries.entries()) {
      const s = rec.state;
      shuttleState[id] = {
        id,
        x: s.x,
        y: s.y,
        z: s.z,
        pos: [s.x, s.y, s.z],
        heading: s.heading,
        pitch: s.pitch,
        speed: s.speed,
        status: s.status,
        carrying: Boolean(s.cargo),
        queueLength: rec.queue.length,
      };
    }

    return {
      built,
      disposed,
      origin: layout ? [...layout.origin] : null,
      simTimeSec,
      tickCount,
      scenario: activeScenario ? activeScenario.name : null,
      yardContainerCount: yardStore.count(),
      promotedPadCount: promotedPadContainers.size,
      promotedPads: warehouseBridge.listPads(),
      serverDeployableCount: serverDeployables.size,
      reeferRacksPowered: countPoweredReeferRacks(),
      serverDeployables: getServerDeployables(),
      sts: stsState,
      yardCranes: ycState,
      shuttles: shuttleState,
    };
  }

  function dispose() {
    if (disposed) return;
    clearTerminal();
    clearServerDeployables();
    disposed = true;
  }

  return {
    buildTerminal,
    clearTerminal,
    yard,
    sts: stsPublic,
    yardCranes: yardCranesPublic,
    shuttles: shuttlesPublic,
    warehouseBridge,
    deliverToWarehousePad,
    pickupFromWarehousePad,
    onDeployableState,
    onDeployableDespawn,
    clearServerDeployables,
    getServerDeployables,
    linkShipManager(sm) { shipManager = sm; },
    getShipManager: () => shipManager,
    getWarehouseManager: () => warehouseManager,
    getRoot: () => terminalRoot,
    getLayout: () => layout,
    getQuayModel: () => quayModel,
    runScenario,
    stopScenarios,
    getState,
    get stats() {
      return {
        built,
        disposed,
        simTimeSec,
        tickCount,
        yardContainerCount: yardStore.count(),
        yardPoolCount: yardPool ? yardPool.count : 0,
        stsCount: stsEntries.size,
        yardCraneCount: yardCraneEntries.size,
        shuttleCount: shuttleEntries.size,
        promotedPadCount: promotedPadContainers.size,
        serverDeployableCount: serverDeployables.size,
        reeferRacksPowered: countPoweredReeferRacks(),
        scenario: activeScenario ? activeScenario.name : null,
      };
    },
    tick,
    dispose,
  };
}
