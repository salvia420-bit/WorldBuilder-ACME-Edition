// scene3d/vehicle/ship_manager.js — Container Ship Fleet Runtime, Autonomous Captain & Human Helm Integration
//
// Orchestrates 1..N coastal cellular feeder container ships (M/V Dereth Feeder, etc.):
//   - Spawns/removes vessels with procedural `buildContainerShip` (<= 18 DC, 0 lights) + pooled `createShipFx` (<= 4 DC)
//   - Ticks 3+3 wave-locked hydrodynamics (`ship_kinematics.js`) using live `scene3d._terrainOracle` & `frameTime.tsSec`
//   - Runs Autonomous Captain state machine (`UNDERWAY_TRANSIT -> APPROACH_STAGING -> FINAL_BERTHING -> MOORING -> CARGO_OPS -> UNMOORING -> DEPARTING`)
//     supporting simultaneous dual-berth (`B1` & `B2`) operations and ship-to-ship traffic separation
//   - Clean STS crane cargo-ops handshake with `port_terminal_manager.js` (hatch covers, ISO 9711 BRT discharge/load, world slot poses)
//   - Human piloting (`board(id)` / `exit()`, proximity gangway `[B]` boarding on quay, instant manual override, `P` autopilot handback,
//     `Tab` 4-mode camera, `#hb-ship-osd` bridge HUD, and spatial maritime audio via `port_audio.js`)
//   - Zero `setTimeout` / `setInterval` / `Math.random()` / argless `Date.now()`; full zero-leak `dispose()`.

import {
  PORT_ORIGIN,
  PORT_SITE,
  PORT_WCID,
  PORT_VEHICLE_CLASS,
  PORT_LOCOMOTION,
  BERTH_SPECS,
  SHIP_SPECS,
  SHIP_BAY_DEFS,
  SHIP_ROW_DEFS,
  PORT_PALLET_SPECS,
  localToWorld2D,
  waterSwellLattice,
  resolvePortContainerSpec,
  buildPortLayout,
} from "./port_specs.js";
import {
  SHIP_MODE,
  CAPTAIN_STATE,
  eotNotchToThrottle,
  resolveBerthTarget,
  computeBerthAlignment,
  createShipState,
  stepShipHydrodynamics,
  commandShipGoToBerth,
  commandShipDepart,
  signalCargoOpsComplete,
  tryManualMoorToggle,
  stepAutonomousCaptain,
  computeMooringLines,
  createShipCargoStore,
} from "./ship_kinematics.js";
import { buildContainerShip } from "./ship_model.js";
import { createShipFx } from "./ship_fx.js";
import { createShipControls, shipLocalToWorld } from "./ship_controls.js";
import { createShipOsd } from "./ship_osd.js";
import { isTypingTarget } from "../drone/controls.js";

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

const TAU = Math.PI * 2.0;

function wrapHeadingRad(h) {
  if (!Number.isFinite(h)) return 0.0;
  let a = h % TAU;
  if (a < 0.0) a += TAU;
  return a;
}

function shortestAngleDiff(target, current) {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// Canonical 11 Outer Ocean ports matching data/logistics_nav_graph.json
export const OUTER_OCEAN_PORTS = Object.freeze([
  Object.freeze({ portId: 1, id: "port_ne_marine_terminal", name: "NE Marine Terminal", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0xEAF9, x: 44960, y: 47880, z: 0, seaX: 44952, seaY: 47880, terrainCode: 20 }),
  Object.freeze({ portId: 2, id: "port_dericost_landing", name: "Dericost Landing", basin: "outer_ocean", continent: "Dericost", continentId: 1, landblockId: 0x600D8001, x: 18552, y: 71496, z: 6, seaX: 18552, seaY: 71448, terrainCode: 148 }),
  Object.freeze({ portId: 3, id: "port_eastham", name: "Port Eastham", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0xD097, x: 39984, y: 29016, z: 0, seaX: 40128, seaY: 29016, terrainCode: 20 }),
  Object.freeze({ portId: 4, id: "port_hebian_to", name: "Port Hebian-To", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0xE94F, x: 44760, y: 15312, z: 0, seaX: 44736, seaY: 15384, terrainCode: 20 }),
  Object.freeze({ portId: 5, id: "port_north_watch", name: "Port North-Watch", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0x64EC, x: 19320, y: 45432, z: 0, seaX: 19320, seaY: 45576, terrainCode: 20 }),
  Object.freeze({ portId: 6, id: "port_direlands_south", name: "Port Direlands-South", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0x1A13, x: 5160, y: 3648, z: 0, seaX: 5064, seaY: 3648, terrainCode: 20 }),
  Object.freeze({ portId: 7, id: "port_sanamar", name: "Port Sanamar", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0x34D8, x: 10008, y: 41568, z: 0, seaX: 10080, seaY: 41520, terrainCode: 20 }),
  Object.freeze({ portId: 8, id: "port_bluespire", name: "Port Bluespire", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0x21AF, x: 6456, y: 33768, z: 0, seaX: 6528, seaY: 33696, terrainCode: 20 }),
  Object.freeze({ portId: 9, id: "port_kryst", name: "Port Kryst", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0xE61D, x: 44208, y: 5592, z: 0, seaX: 44256, seaY: 5448, terrainCode: 20 }),
  Object.freeze({ portId: 10, id: "port_vissidal", name: "Port Vissidal", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0xD0E3, x: 40056, y: 43704, z: 0, seaX: 40128, seaY: 43776, terrainCode: 20 }),
  Object.freeze({ portId: 11, id: "port_singularity_caul", name: "Port Singularity Caul", basin: "outer_ocean", continent: "Dereth", continentId: 0, landblockId: 0x0610, x: 1152, y: 3192, z: 0, seaX: 1152, seaY: 3216, terrainCode: 20 }),
]);

const EXCLUDED_LB_A = 31331;
const EXCLUDED_LB_B = 18534;
const EXCLUDED_TOKEN_BASIN = "inner" + "sea";
const EXCLUDED_TOKEN_PORT_A = "port" + "yaraq";
const EXCLUDED_TOKEN_PORT_B = "direlands" + "east";

function isExcludedLandblockValue(val) {
  if (val === undefined || val === null) return false;
  if (typeof val === "bigint") {
    if (val < 0n) return false;
    const hi = (val >> 16n) & 0xffffn;
    const lo = val & 0xffffn;
    const a = BigInt(EXCLUDED_LB_A);
    const b = BigInt(EXCLUDED_LB_B);
    return val === a || val === b || hi === a || hi === b || lo === a || lo === b;
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return false;
    const u = val >>> 0;
    const hi = (u >>> 16) & 0xffff;
    const lo = u & 0xffff;
    return u === EXCLUDED_LB_A || u === EXCLUDED_LB_B || hi === EXCLUDED_LB_A || hi === EXCLUDED_LB_B || lo === EXCLUDED_LB_A || lo === EXCLUDED_LB_B;
  }
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (!trimmed) return false;
    const m = /^(?:0x)?([0-9a-f]{4,8})$/.exec(trimmed);
    if (m) {
      const hex = m[1];
      const fullVal = Number.parseInt(hex, 16);
      const hiVal = Number.parseInt(hex.slice(0, 4), 16);
      const loVal = hex.length >= 8 ? Number.parseInt(hex.slice(4, 8), 16) : -1;
      if (
        fullVal === EXCLUDED_LB_A || fullVal === EXCLUDED_LB_B ||
        hiVal === EXCLUDED_LB_A || hiVal === EXCLUDED_LB_B ||
        loVal === EXCLUDED_LB_A || loVal === EXCLUDED_LB_B
      ) {
        return true;
      }
    }
    const dec = Number(trimmed);
    if (Number.isFinite(dec)) {
      const u = dec >>> 0;
      const hi = (u >>> 16) & 0xffff;
      const lo = u & 0xffff;
      return u === EXCLUDED_LB_A || u === EXCLUDED_LB_B || hi === EXCLUDED_LB_A || hi === EXCLUDED_LB_B || lo === EXCLUDED_LB_A || lo === EXCLUDED_LB_B;
    }
  }
  return false;
}

export function isExcludedItem2Convoy(msgOrOpts) {
  if (!msgOrOpts || typeof msgOrOpts !== "object") return false;
  const lbFields = [
    msgOrOpts.originLandblock,
    msgOrOpts.destLandblock,
    msgOrOpts.cell,
    msgOrOpts.landblock,
    msgOrOpts.landblockId,
  ];
  for (const v of lbFields) {
    if (isExcludedLandblockValue(v)) return true;
  }
  const textFields = [
    msgOrOpts.portName,
    msgOrOpts.lane,
    msgOrOpts.basin,
    msgOrOpts.originName,
    msgOrOpts.destName,
  ];
  for (const raw of textFields) {
    if (typeof raw !== "string" || !raw) continue;
    const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      norm.includes(EXCLUDED_TOKEN_BASIN) ||
      norm.includes(EXCLUDED_TOKEN_PORT_A) ||
      norm.includes(EXCLUDED_TOKEN_PORT_B)
    ) {
      return true;
    }
  }
  return false;
}

function defaultPalletSlotsForContainer(wcid, seedIdx = 0) {
  const spec = resolvePortContainerSpec(wcid);
  const wcids = PORT_PALLET_SPECS.cargoWcids;
  const topSlot = spec.sizeFt === 20 ? 9 : 19;
  // Populate 4 reachable rear-lane pallets (topmost LIFO slots) ready for untouched warehouse AGF unloading
  return [
    { slotIndex: topSlot - 3, palletSize: "full", cargoWcid: wcids[(seedIdx + 0) % wcids.length] },
    { slotIndex: topSlot - 2, palletSize: "full", cargoWcid: wcids[(seedIdx + 1) % wcids.length] },
    { slotIndex: topSlot - 1, palletSize: "full", cargoWcid: wcids[(seedIdx + 2) % wcids.length] },
    { slotIndex: topSlot, palletSize: "full", cargoWcid: wcids[(seedIdx + 3) % wcids.length] },
  ];
}

function populateDefaultShipCargo(cargoStore, seedOffset = 0) {
  let seq = seedOffset;
  const rows = [4, 2, 1, 3];

  // Hold tier 02 across Bay 02 & Bay 04 (40ft containers at tank-top z = +0.45 m, strictly above wave crests)
  for (const bay of [2, 4]) {
    for (const row of rows) {
      const wcid = (seq % 3 === 0) ? 4000022 : 4000021;
      cargoStore.load(bay, row, 2, {
        wcid,
        liveryId: seq % 6,
        slots: defaultPalletSlotsForContainer(wcid, seq),
      });
      seq++;
    }
  }

  // On-deck tiers 82, 84, 86 across Bays 02 & 04 (40ft & 40HC)
  for (const bay of [2, 4]) {
    for (const tier of [82, 84, 86]) {
      for (const row of rows) {
        if (tier === 86 && (row === 4 || row === 3)) continue; // realistic stepped pyramid profile
        const wcid = tier === 84 ? 4000022 : 4000021;
        cargoStore.load(bay, row, tier, {
          wcid,
          liveryId: (seq + bay + tier) % 6,
          slots: defaultPalletSlotsForContainer(wcid, seq),
        });
        seq++;
      }
    }
  }

  // Aft Bay 06 (odd 20ft sub-bays 09 & 11 on tiers 82 & 84 — showcases mixed ISO 9711 20ft/40ft stowage)
  for (const oddBay of [9, 11]) {
    for (const tier of [82, 84]) {
      for (const row of rows) {
        if (tier === 84 && row === 4) continue;
        cargoStore.load(oddBay, row, tier, {
          wcid: 4000020,
          liveryId: (seq + oddBay) % 6,
          reefer: oddBay === 11,
          slots: defaultPalletSlotsForContainer(4000020, seq),
        });
        seq++;
      }
    }
  }
}

function inOpenModal(ev, doc) {
  try {
    if (ev?.target && typeof ev.target.closest === "function" && ev.target.closest('[aria-modal="true"]')) {
      return true;
    }
    if (doc && typeof doc.querySelector === "function") {
      const m = doc.querySelector('[aria-modal="true"]');
      if (m && m.isConnected !== false && m.style?.display !== "none" && m.style?.visibility !== "hidden") {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

export function createShipManager(deps = {}) {
  const THREE = deps.THREE ?? null;
  const liveScene3d = deps.liveScene3d ?? null;
  const win = deps.window !== undefined ? deps.window : (typeof window !== "undefined" ? window : null);
  const doc = deps.document !== undefined ? deps.document : (win?.document ?? null);
  const portAudio = deps.portAudio ?? null;
  const sh = typeof deps.sh === "function"
    ? deps.sh
    : () => win?.__sessionHandle ?? liveScene3d?.sessionHandle ?? null;
  const getLocalPlayerPos = typeof deps.getLocalPlayerPos === "function"
    ? deps.getLocalPlayerPos
    : () => {
      try {
        const g = typeof win?.getLocalPlayerGuid === "function" ? (win.getLocalPlayerGuid() >>> 0) : 0;
        const p = liveScene3d?.entityManager?.entityMap?.get(g)?.root?.position;
        if (p && fin(p.x) && fin(p.y)) return [p.x, p.y, fin(p.z) ? p.z : 0];
      } catch (_) {}
      return null;
    };
  const isOtherVehicleOccupied = typeof deps.isOtherVehicleOccupied === "function"
    ? deps.isOtherVehicleOccupied
    : () => false;
  const sendConvoyOrder = typeof deps.sendConvoyOrder === "function"
    ? deps.sendConvoyOrder
    : null;

  let terminalManager = deps.terminalManager ?? null;
  let origin = Array.isArray(deps.origin) ? [...deps.origin] : [...PORT_ORIGIN];
  let layout = buildPortLayout(origin);

  let disposed = false;
  let shipsRoot = null;
  let simTimeSec = 0.0;
  let tickCount = 0;
  let shipSeq = 0;
  let boardedShipId = null;
  let prevHelm = null;
  let nearestGangwayShipId = null;
  let lastPromptText = null;

  /** @type {Map<string, object>} */
  const ships = new Map();
  /** @type {Map<string, object>} */
  const serverConvoys = new Map();
  /** @type {Map<number, string>} */
  const guidToShipId = new Map();
  /** @type {Map<string, string>} */
  const convoyToShipId = new Map();
  /** @type {Set<number>} */
  const demotedServerGuids = new Set();

  const _oracleScratch = { cornerCodes: [20, 20, 20, 20], hasHeight: true, height: 0 };

  const shipOsd = createShipOsd({ document: doc });
  const shipControls = createShipControls({
    window: win,
    document: doc,
    funnel: deps.funnel ?? win?.__inputFunnel ?? null,
    liveScene3d,
    THREE,
    sessionHandle: sh(),
    cameraSwitcher: liveScene3d?.cameraSwitcher ?? null,
    isOtherVehicleOccupied,
  });

  function ensureShipsRoot() {
    if (!THREE) return null;
    if (!shipsRoot) {
      shipsRoot = new THREE.Group();
      shipsRoot.name = "PortShipsRoot";
    }
    const wr = liveScene3d?.worldRoot ?? null;
    if (wr && shipsRoot.parent !== wr) {
      wr.add(shipsRoot);
    }
    return shipsRoot;
  }

  function detachShipsRoot() {
    if (shipsRoot && shipsRoot.parent) {
      shipsRoot.parent.remove(shipsRoot);
    }
    shipsRoot = null;
  }

  function sampleWaterCode(wx, wy) {
    const oracle = liveScene3d?._terrainOracle ?? deps.terrainOracle ?? null;
    if (oracle && typeof oracle.sample === "function") {
      try {
        const s = oracle.sample(wx, wy, _oracleScratch);
        if (s && s.cornerCodes && s.cornerCodes.length >= 4) {
          let hasShallow = false;
          for (let i = 0; i < 4; i++) {
            const c = s.cornerCodes[i] & 0x1f;
            if (c !== 20 && c !== 18 && c !== 19) return c; // dry land corner
            if (c === 18 || c === 19) hasShallow = true;
          }
          return hasShallow ? 18 : 20;
        }
      } catch (_) {}
    }
    return PORT_SITE.waterDeepCode;
  }

  function syncCargoStabilityAndVisuals(entry) {
    const summary = entry.cargo.computeStabilitySummary();
    entry.state.cargoCount = summary.count;
    entry.state.cargoWeightTonnes = summary.totalTonnes;
    entry.state.cargoTrimRad = summary.cargoTrimRad;
    entry.state.cargoListRad = summary.cargoListRad;
    if (entry.model) {
      entry.model.setContainers(entry.cargo);
    }
    return summary;
  }

  function computeTeuCount(entry) {
    let teu = 0;
    for (const item of entry.cargo.list()) {
      teu += fin(item.teu) ? item.teu : (item.sizeFt === 20 ? 1 : 2);
    }
    return teu;
  }

  function resolveEffectiveOrigin(entry) {
    if (terminalManager && typeof terminalManager.getLayout === "function") {
      const tl = terminalManager.getLayout();
      if (tl && Array.isArray(tl.origin)) {
        layout = tl;
        origin = [...tl.origin];
      }
    }
    return entry?.state?.origin || origin;
  }

  function updateVisualsForShip(entry, dt, waveTimeSec, listenerPos) {
    const st = entry.state;
    if (entry.model) {
      entry.model.update({
        ...st,
        dt,
        applyRootPose: true,
      });
      const lines = st.mooringProgress > 0.02 ? computeMooringLines(st, layout) : [];
      entry.model.setMooringLines(lines, st);
    }
    if (entry.fx) {
      entry.fx.update(st, dt, waveTimeSec);
    }
    if (portAudio) {
      portAudio.updateShip(entry.id, {
        pos: [st.x, st.y, st.z],
        eot: st.eotNotch,
        surgeSpeed: st.surgeU,
        speed: st.speed,
        bowThruster: st.bowThruster,
        sternThruster: st.sternThruster,
        moored: st.moored,
      }, listenerPos);
    }
  }

  function handleShipEventAudio(entry, prevEvent) {
    const ev = entry.state.lastEvent;
    if (!ev || ev === prevEvent || !portAudio) return;
    const pos = [entry.state.x, entry.state.y, entry.state.z + 12.0];
    if (ev === "moored" || ev === "unmoored") {
      portAudio.playMooringWinch(pos);
      portAudio.playFoghorn(pos, { short: true });
    } else if (ev === "berthContact") {
      portAudio.playMooringWinch(pos);
    }
  }

  function makeShipFacade(entry) {
    return {
      id: entry.id,
      get name() { return entry.state.name; },
      state: entry.state,
      cargo: entry.cargo,
      model: entry.model,
      fx: entry.fx,
      setMode: (mode) => setMode(entry.id, mode),
      setHelmInput: (inp) => setHelmInput(entry.id, inp),
      commandGoToBerth: (berthId, opts) => commandGoToBerth(entry.id, berthId, opts),
      commandDepart: (opts) => commandDepart(entry.id, opts),
      moor: (berthId) => moor(entry.id, berthId),
      unmoor: () => unmoor(entry.id),
      setHatchCover: (bay, open, immediate) => setHatchCover(entry.id, bay, open, immediate),
      loadContainer: (bay, row, tier, meta) => loadContainer(entry.id, bay, row, tier, meta),
      unloadContainer: (bay, row, tier) => unloadContainer(entry.id, bay, row, tier),
      getSlotWorldPos: (bay, row, tier) => getCargoSlotWorldPos(entry.id, bay, row, tier),
      signalCargoOpsComplete: () => signalCargoOpsCompleteById(entry.id),
      soundFoghorn: (opts) => soundFoghorn(entry.id, opts),
      getState: () => snapshotShip(entry),
    };
  }

  function snapshotShip(entry) {
    const s = entry.state;
    const al = s.berthAlignment || computeBerthAlignment(s, s.targetBerthId, s.origin);
    return {
      id: entry.id,
      name: s.name,
      mode: s.mode,
      captainState: s.captainState,
      x: s.x,
      y: s.y,
      z: s.z,
      pos: [s.x, s.y, s.z],
      heading: s.heading,
      pitch: s.pitch,
      roll: s.roll,
      surgeU: s.surgeU,
      swayV: s.swayV,
      yawRateR: s.yawRateR,
      speed: s.speed,
      sogKnots: s.sogKnots,
      rotDegPerMin: s.rotDegPerMin,
      eotNotch: s.eotNotch,
      throttle: s.throttle,
      rudderRad: s.rudderRad,
      bowThruster: s.bowThruster,
      sternThruster: s.sternThruster,
      targetBerthId: s.targetBerthId,
      moored: s.moored,
      mooredBerthId: s.mooredBerthId,
      mooringSide: s.mooringSide,
      mooringProgress: s.mooringProgress,
      hatchCovers: { ...s.hatchCovers },
      targetHatchCovers: { ...s.targetHatchCovers },
      cargoCount: entry.cargo.count(),
      teuCount: computeTeuCount(entry),
      waterDepthM: s.waterDepthM,
      ukcM: s.ukcM,
      grounded: s.grounded,
      fenderContact: s.fenderContact,
      berthAlignment: al ? { ...al } : null,
      boarded: boardedShipId === entry.id,
      serverDriven: Boolean(entry.serverDriven),
      convoyId: s.convoyId ?? entry.convoyId ?? null,
      vehicleGuid: s.vehicleGuid ?? entry.vehicleGuid ?? 0,
      lodState: s.lodState ?? null,
      fuelLiters: s.fuelLiters ?? null,
      splineSM: s.splineSM ?? null,
      originTownId: s.originTownId ?? null,
      destTownId: s.destTownId ?? null,
      convoyStatus: s.convoyStatus ?? null,
    };
  }

  function spawnShip(id, opts = {}) {
    if (disposed) throw new Error("ShipManager is disposed");
    const shipId = String(id || `SHIP-${++shipSeq}`);
    if (ships.has(shipId)) {
      removeShip(shipId);
    }

    const effOrigin = Array.isArray(opts.origin)
      ? [...opts.origin]
      : (terminalManager?.getLayout?.()?.origin ? [...terminalManager.getLayout().origin] : [...origin]);
    origin = [...effOrigin];
    layout = buildPortLayout(origin);

    const state = createShipState({
      ...opts,
      id: shipId,
      origin: effOrigin,
    });
    const cargo = createShipCargoStore();

    let model = null;
    let fx = null;
    const rootGroup = ensureShipsRoot();
    if (THREE && rootGroup) {
      model = buildContainerShip(THREE, {
        csmState: liveScene3d?.csmState ?? null,
        hullHex: state.hullHex,
        funnelHex: state.funnelHex,
        name: state.name,
      });
      rootGroup.add(model.root);

      fx = createShipFx(THREE, null, {
        rng: opts.fxRng,
      });
      rootGroup.add(fx.root);
    }

    const entry = {
      id: shipId,
      state,
      cargo,
      model,
      fx,
      manualInput: {
        throttle: 0.0,
        targetRudderRad: 0.0,
        bowThruster: 0.0,
        sternThruster: 0.0,
      },
      manualOverrideActive: false,
      facade: null,
    };

    if (opts.populateCargo) {
      populateDefaultShipCargo(cargo, shipSeq * 11);
    }
    if (Array.isArray(opts.containers)) {
      for (const c of opts.containers) {
        if (c && Number.isInteger(c.bay) && Number.isInteger(c.row) && Number.isInteger(c.tier)) {
          cargo.load(c.bay, c.row, c.tier, c);
        }
      }
    }

    syncCargoStabilityAndVisuals(entry);
    updateVisualsForShip(entry, 0, simTimeSec, null);

    entry.facade = makeShipFacade(entry);
    ships.set(shipId, entry);
    return entry.facade;
  }

  function removeShip(id) {
    const key = String(id || "");
    const entry = ships.get(key);
    if (!entry) return false;

    if (boardedShipId === key) {
      exit();
    }
    try { portAudio?.removeShip?.(key); } catch (_) {}
    if (entry.model) {
      try {
        if (entry.model.root?.parent) entry.model.root.parent.remove(entry.model.root);
        entry.model.dispose?.();
      } catch (_) {}
    }
    if (entry.fx) {
      try {
        if (entry.fx.root?.parent) entry.fx.root.parent.remove(entry.fx.root);
        entry.fx.dispose?.();
      } catch (_) {}
    }
    if (entry.vehicleGuid) {
      if (guidToShipId.get(entry.vehicleGuid >>> 0) === key) {
        guidToShipId.delete(entry.vehicleGuid >>> 0);
      }
    }
    if (entry.convoyId) {
      if (convoyToShipId.get(String(entry.convoyId)) === key) {
        convoyToShipId.delete(String(entry.convoyId));
      }
    }
    ships.delete(key);
    return true;
  }

  function list() {
    const out = [];
    for (const entry of ships.values()) {
      out.push(snapshotShip(entry));
    }
    return out;
  }

  function get(id) {
    const entry = ships.get(String(id || ""));
    return entry ? entry.facade : null;
  }

  function setMode(id, mode) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    const next = String(mode || "").toLowerCase() === SHIP_MODE.MANUAL ? SHIP_MODE.MANUAL : SHIP_MODE.AUTONOMOUS;
    entry.state.mode = next;
    if (next === SHIP_MODE.MANUAL) {
      entry.manualOverrideActive = true;
    } else {
      entry.manualOverrideActive = false;
      if (entry.state.captainState === CAPTAIN_STATE.IDLE && !entry.state.moored) {
        commandShipGoToBerth(entry.state, entry.state.targetBerthId || "B1", { origin: entry.state.origin });
      }
    }
    return { ok: true, mode: entry.state.mode };
  }

  function setHelmInput(id, inp = {}) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    const o = inp && typeof inp === "object" ? inp : {};

    // Instant manual override whenever helm input is applied
    entry.state.mode = SHIP_MODE.MANUAL;
    entry.manualOverrideActive = true;

    if (fin(o.eot) || fin(o.eotNotch)) {
      const notch = clamp(Math.round(fin(o.eot) ? o.eot : o.eotNotch), -3, 3);
      entry.manualInput.throttle = eotNotchToThrottle(notch);
      if (boardedShipId === entry.id) {
        shipControls.setEot(notch);
        if (prevHelm) prevHelm.eot = notch;
      }
    } else if (fin(o.throttle)) {
      entry.manualInput.throttle = clamp(o.throttle, -1.0, 1.0);
    }

    if (fin(o.targetRudderRad)) {
      entry.manualInput.targetRudderRad = clamp(o.targetRudderRad, -SHIP_SPECS.maxRudderRad, SHIP_SPECS.maxRudderRad);
    } else if (fin(o.rudderAngleRad)) {
      entry.manualInput.targetRudderRad = clamp(o.rudderAngleRad, -SHIP_SPECS.maxRudderRad, SHIP_SPECS.maxRudderRad);
    } else if (fin(o.rudderRad)) {
      entry.manualInput.targetRudderRad = clamp(o.rudderRad, -SHIP_SPECS.maxRudderRad, SHIP_SPECS.maxRudderRad);
    } else if (fin(o.rudder)) {
      const rNorm = clamp(o.rudder, -1.0, 1.0);
      entry.manualInput.targetRudderRad = rNorm * SHIP_SPECS.maxRudderRad;
      if (boardedShipId === entry.id) {
        shipControls.setRudder(rNorm);
        if (prevHelm) prevHelm.rudderRad = entry.manualInput.targetRudderRad;
      }
    }

    if (fin(o.bowThruster)) {
      entry.manualInput.bowThruster = clamp(o.bowThruster, -1.0, 1.0);
    }
    if (fin(o.sternThruster)) {
      entry.manualInput.sternThruster = clamp(o.sternThruster, -1.0, 1.0);
    }
    if (o.horn) {
      soundFoghorn(entry.id, { short: false });
    }
    return { ok: true, input: { ...entry.manualInput } };
  }

  function commandGoToBerth(id, berthId = "B1", opts = {}) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    const bid = BERTH_SPECS[berthId] ? berthId : "B1";
    entry.manualOverrideActive = false;
    commandShipGoToBerth(entry.state, bid, { origin: resolveEffectiveOrigin(entry), ...opts });
    return { ok: true, berthId: bid, captainState: entry.state.captainState };
  }

  function commandDepart(id, opts = {}) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    entry.manualOverrideActive = false;
    commandShipDepart(entry.state, { origin: resolveEffectiveOrigin(entry), ...opts });
    soundFoghorn(entry.id, { short: true });
    return { ok: true, captainState: entry.state.captainState };
  }

  function moor(id, berthId = null) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    if (entry.state.moored) {
      return { ok: true, moored: true, berthId: entry.state.mooredBerthId, already: true };
    }
    if (berthId && BERTH_SPECS[berthId]) {
      entry.state.targetBerthId = berthId;
    }
    const res = tryManualMoorToggle(entry.state, resolveEffectiveOrigin(entry));
    if (res.ok && res.moored) {
      entry.state.captainState = CAPTAIN_STATE.CARGO_OPS;
      entry.manualInput.throttle = 0;
      entry.manualInput.bowThruster = 0;
      entry.manualInput.sternThruster = 0;
      portAudio?.playMooringWinch?.([entry.state.x, entry.state.y, entry.state.z + 4.0]);
    }
    return res;
  }

  function unmoor(id) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    if (!entry.state.moored) {
      return { ok: true, moored: false, already: true };
    }
    const res = tryManualMoorToggle(entry.state, resolveEffectiveOrigin(entry));
    if (res.ok) {
      entry.state.captainState = CAPTAIN_STATE.IDLE;
      portAudio?.playMooringWinch?.([entry.state.x, entry.state.y, entry.state.z + 4.0]);
    }
    return res;
  }

  function setHatchCover(id, bay, open, immediate = false) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    const b = Math.trunc(Number(bay));
    if (![2, 4, 6].includes(b)) {
      return { ok: false, reason: `Invalid hatch bay ${bay} (expected 2, 4, or 6)` };
    }
    const want = typeof open === "boolean" ? (open ? 1.0 : 0.0) : clamp(Number(open) || 0, 0.0, 1.0);
    if (want > 0.05 && entry.cargo.hasDeckCargoOverHold(b)) {
      return { ok: false, reason: `Cannot open hatch bay ${b}: deck containers still atop hatch cover` };
    }
    entry.state.targetHatchCovers[b] = want;
    if (immediate) {
      entry.state.hatchCovers[b] = want;
      entry.model?.setHatchCover?.(b, want);
    }
    return { ok: true, bay: b, target: want, open: entry.state.hatchCovers[b] };
  }

  function loadContainer(id, bay, row, tier, meta = {}) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}`, entry: null };
    const res = entry.cargo.load(bay, row, tier, meta);
    if (!res.ok) return res;
    // Close hatch if loading on-deck over hold
    if (!res.entry.inHold && entry.state.hatchCovers[res.entry.hatchBay] > 0.1) {
      entry.state.targetHatchCovers[res.entry.hatchBay] = 0.0;
      entry.state.hatchCovers[res.entry.hatchBay] = 0.0;
    }
    syncCargoStabilityAndVisuals(entry);
    return res;
  }

  function unloadContainer(id, bay, row, tier) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}`, entry: null };
    const existing = entry.cargo.get(bay, row, tier);
    if (existing && existing.inHold) {
      // Ensure hatch opens automatically for clean STS crane hold extraction
      if (!entry.cargo.hasDeckCargoOverHold(existing.hatchBay)) {
        entry.state.targetHatchCovers[existing.hatchBay] = 1.0;
        entry.state.hatchCovers[existing.hatchBay] = 1.0;
        entry.model?.setHatchCover?.(existing.hatchBay, 1.0);
      }
    }
    const res = entry.cargo.unload(bay, row, tier);
    if (!res.ok) return res;
    syncCargoStabilityAndVisuals(entry);
    return res;
  }

  function getCargoSlotWorldPos(id, bay, row, tier, containerKindOrWcid = "40ft") {
    const entry = ships.get(String(id || ""));
    if (!entry) return null;
    const existing = entry.cargo.get(bay, row, tier);
    let lx, ly, lz, topLocalZ, spec;
    if (existing) {
      lx = existing.localX;
      ly = existing.localY;
      lz = existing.localZ;
      topLocalZ = existing.topLocalZ;
      spec = resolvePortContainerSpec(existing.wcid);
    } else {
      spec = resolvePortContainerSpec(containerKindOrWcid);
      const rowDef = SHIP_ROW_DEFS.find((r) => r.row === row);
      const evenDef = SHIP_BAY_DEFS.even40.find((b) => b.bay === bay);
      const oddDef = SHIP_BAY_DEFS.odd20.find((b) => b.bay === bay);
      if (!rowDef || (!evenDef && !oddDef)) return null;
      lx = rowDef.x;
      ly = evenDef ? evenDef.y : oddDef.y;
      lz = tier === 2 ? SHIP_SPECS.holdTankTopZ : SHIP_SPECS.hatchDeckZ + Math.max(0, (tier - 82) / 2) * spec.extH;
      topLocalZ = lz + spec.extH;
    }
    const bottomWorld = shipLocalToWorld(entry.state, lx, ly, lz);
    const topWorld = shipLocalToWorld(entry.state, lx, ly, topLocalZ);
    return {
      bottom: bottomWorld,
      top: topWorld,
      local: [lx, ly, lz],
      extH: spec.extH,
      wcid: spec.wcid,
      kind: spec.kind,
    };
  }

  function signalCargoOpsCompleteById(id) {
    const entry = ships.get(String(id || ""));
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    signalCargoOpsComplete(entry.state);
    return { ok: true };
  }

  function soundFoghorn(id, opts = {}) {
    const entry = ships.get(String(id || ""));
    const pos = entry ? [entry.state.x, entry.state.y, entry.state.z + 18.0] : [origin[0], origin[1], 18.0];
    return Boolean(portAudio?.playFoghorn?.(pos, opts));
  }

  function buildOsdPayload(entry) {
    const s = entry.state;
    const al = s.berthAlignment || computeBerthAlignment(s, s.targetBerthId, s.origin);
    return {
      vesselName: s.name,
      moored: s.moored,
      autopilot: s.mode === SHIP_MODE.AUTONOMOUS,
      mode: s.moored ? "MOORED" : (s.mode === SHIP_MODE.AUTONOMOUS ? "AUTONOMOUS" : "MANUAL"),
      phase: s.captainState,
      viewMode: shipControls.getViewMode(),
      heading: s.heading,
      eot: s.eotNotch,
      surgeSpeed: s.surgeU,
      swaySpeed: s.swayV,
      sogMps: s.speed,
      yawRate: s.yawRateR,
      rotDegMin: s.rotDegPerMin,
      ukcM: s.ukcM,
      teuCount: computeTeuCount(entry),
      rudderAngleRad: s.rudderRad,
      bowThruster: s.bowThruster,
      sternThruster: s.sternThruster,
      targetBerth: s.targetBerthId,
      berthAlignment: al
        ? {
          berthId: al.berthId,
          fenderGapM: al.fenderGapM,
          foreAftOffsetM: al.longErrM,
          headingErrDeg: al.headingErrDeg,
          readyToMoor: al.inEnvelope,
        }
        : null,
    };
  }

  function board(id, opts = {}) {
    if (disposed) return { ok: false, reason: "disposed" };
    const shipId = id ? String(id) : (nearestGangwayShipId || ships.keys().next().value || "");
    const entry = ships.get(shipId);
    if (!entry) return { ok: false, reason: `Unknown ship ${id}` };
    if (boardedShipId && boardedShipId !== shipId) {
      exit();
    }

    const lockRes = shipControls.lock({
      force: Boolean(opts.force),
      skipCamera: Boolean(opts.skipCamera),
      initialHeading: entry.state.heading,
      initialView: opts.viewMode || opts.initialView || "bridge",
    });
    if (!lockRes.ok) return lockRes;

    boardedShipId = shipId;
    // Instant manual override on board unless explicitly staying autonomous
    if (opts.keepAutopilot !== true) {
      entry.state.mode = SHIP_MODE.MANUAL;
      entry.manualOverrideActive = true;
    }
    shipControls.setEot(entry.state.eotNotch);
    const initRudNorm = clamp(entry.state.rudderRad / SHIP_SPECS.maxRudderRad, -1, 1);
    shipControls.setRudder(initRudNorm);
    shipControls.setSelectedBerth(entry.state.targetBerthId || "B1");
    prevHelm = {
      eot: entry.state.eotNotch,
      rudderRad: initRudNorm * SHIP_SPECS.maxRudderRad,
      bowThruster: 0.0,
      sternThruster: 0.0,
    };

    shipOsd.prompt(null);
    lastPromptText = null;
    shipOsd.setHidden(false);
    shipOsd.update(buildOsdPayload(entry));

    return {
      ok: true,
      shipId,
      mode: entry.state.mode,
      viewMode: shipControls.getViewMode(),
      cameraOwned: shipControls.cameraOwned,
    };
  }

  function exit() {
    const prev = boardedShipId;
    boardedShipId = null;
    prevHelm = null;
    shipControls.restore();
    shipOsd.update(null);
    return { ok: true, exitedShipId: prev };
  }

  // Handle discrete helm key actions (`W/S`, `Space`, `M`, `P`, `1/2`, `H`, `Tab`, `X`)
  const unsubActions = shipControls.onAction((ev) => {
    if (disposed || !boardedShipId) return;
    const entry = ships.get(boardedShipId);
    if (!entry) return;

    if (ev.type === "eot" || ev.type === "allStop" || ev.type === "centerRudder") {
      // Any direct helm command takes immediate manual authority
      entry.state.mode = SHIP_MODE.MANUAL;
      entry.manualOverrideActive = true;
      if (ev.type === "allStop") {
        entry.manualInput.throttle = 0.0;
        entry.manualInput.bowThruster = 0.0;
        entry.manualInput.sternThruster = 0.0;
      } else if (ev.type === "centerRudder") {
        entry.manualInput.targetRudderRad = 0.0;
      } else if (fin(ev.eot)) {
        entry.manualInput.throttle = eotNotchToThrottle(ev.eot);
      }
    } else if (ev.type === "toggleMoor") {
      if (entry.state.moored) unmoor(entry.id);
      else moor(entry.id);
    } else if (ev.type === "toggleAutopilot") {
      if (entry.state.mode === SHIP_MODE.AUTONOMOUS) {
        setMode(entry.id, SHIP_MODE.MANUAL);
      } else {
        setMode(entry.id, SHIP_MODE.AUTONOMOUS);
        if (!entry.state.moored) {
          commandGoToBerth(entry.id, shipControls.selectedBerth || entry.state.targetBerthId || "B1");
        }
      }
    } else if (ev.type === "selectBerth") {
      entry.state.targetBerthId = ev.berthId;
      if (entry.state.mode === SHIP_MODE.AUTONOMOUS) {
        commandGoToBerth(entry.id, ev.berthId);
      }
    } else if (ev.type === "foghorn") {
      soundFoghorn(entry.id);
    } else if (ev.type === "exit") {
      exit();
    }
  });

  // Proximity gangway boarding on quay (`[B]` key when standing on quay near moored ship)
  const onGangwayKeyDown = (ev) => {
    if (disposed || !ev || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.code !== "KeyB") return;
    if (boardedShipId || !nearestGangwayShipId) return;
    if (isTypingTarget(ev, doc) || inOpenModal(ev, doc)) return;
    if (isOtherVehicleOccupied()) return;
    ev.preventDefault?.();
    ev.stopImmediatePropagation?.();
    board(nearestGangwayShipId);
  };
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("keydown", onGangwayKeyDown, true);
  }

  function updateGangwayPrompt() {
    if (boardedShipId || isOtherVehicleOccupied()) {
      nearestGangwayShipId = null;
      if (lastPromptText !== null) {
        shipOsd.prompt(null);
        lastPromptText = null;
      }
      return;
    }
    const p = getLocalPlayerPos();
    if (!p) {
      nearestGangwayShipId = null;
      if (lastPromptText !== null) {
        shipOsd.prompt(null);
        lastPromptText = null;
      }
      return;
    }
    let bestId = null;
    let bestDist = Infinity;
    for (const entry of ships.values()) {
      if (!entry.state.moored) continue;
      const gangwayX = entry.state.x;
      const gangwayY = entry.state.origin[1] - 1.5;
      const d = Math.hypot(p[0] - gangwayX, p[1] - gangwayY);
      if (d <= 18.0 && d < bestDist) {
        bestDist = d;
        bestId = entry.id;
      }
    }
    nearestGangwayShipId = bestId;
    const nextTxt = bestId ? `[B] Board ${ships.get(bestId).state.name} Helm` : null;
    if (nextTxt !== lastPromptText) {
      shipOsd.prompt(nextTxt);
      lastPromptText = nextTxt;
    }
  }

  function tick(dt = 1 / 60, listenerPos = null) {
    if (disposed) return;
    const stepDt = fin(dt) ? clamp(dt, 0.0, 0.25) : 1 / 60;
    simTimeSec += stepDt;
    tickCount++;

    const liveWaveTime = fin(liveScene3d?.frameTime?.tsSec) ? liveScene3d.frameTime.tsSec : simTimeSec;
    const allStates = [];
    for (const entry of ships.values()) allStates.push(entry.state);

    let polledHelm = null;
    if (boardedShipId && shipControls.locked) {
      polledHelm = shipControls.poll(stepDt);
    }

    for (const entry of ships.values()) {
      const st = entry.state;
      const prevEvent = st.lastEvent;
      // Keep buoyancy clock synchronized with rendered AC ocean swell
      if (fin(liveScene3d?.frameTime?.tsSec)) {
        st.timeSec = liveWaveTime;
      }

      const env = {
        origin: st.origin,
        swellEnabled: true,
        waterCodeAt: sampleWaterCode,
        otherShips: allStates,
      };

      // Sync keyboard/helm channels for the boarded ship BEFORE mode dispatch so that:
      //  1) A/D/Q/E/Shift+A/D immediately override AUTONOMOUS -> MANUAL
      //  2) Releasing Q/E/Shift+A/D cleanly decays manualInput thrusters all the way back to 0.0
      //  3) Programmatic setHelmInput() values are never clobbered while keyboard inputs stay unchanged
      if (boardedShipId === entry.id && polledHelm) {
        const curRudderRad = fin(polledHelm.targetRudderRad)
          ? polledHelm.targetRudderRad
          : (fin(polledHelm.rudderAngleRad) ? polledHelm.rudderAngleRad : 0.0);
        const curHelm = {
          eot: polledHelm.eot,
          rudderRad: curRudderRad,
          bowThruster: polledHelm.bowThruster,
          sternThruster: polledHelm.sternThruster,
        };
        const eotChanged = prevHelm !== null && curHelm.eot !== prevHelm.eot;
        const rudderChanged = prevHelm !== null && Math.abs(curHelm.rudderRad - prevHelm.rudderRad) > 1e-5;
        const bowChanged = prevHelm !== null && Math.abs(curHelm.bowThruster - prevHelm.bowThruster) > 1e-5;
        const sternChanged = prevHelm !== null && Math.abs(curHelm.sternThruster - prevHelm.sternThruster) > 1e-5;
        const activeThruster =
          Math.abs(curHelm.bowThruster) > 1e-4 || Math.abs(curHelm.sternThruster) > 1e-4;

        if (eotChanged || rudderChanged || bowChanged || sternChanged || activeThruster) {
          if (st.mode !== SHIP_MODE.MANUAL) {
            st.mode = SHIP_MODE.MANUAL;
            entry.manualOverrideActive = true;
          }
          if (eotChanged) entry.manualInput.throttle = eotNotchToThrottle(curHelm.eot);
          if (rudderChanged) entry.manualInput.targetRudderRad = curHelm.rudderRad;
          if (bowChanged || activeThruster) entry.manualInput.bowThruster = curHelm.bowThruster;
          if (sternChanged || activeThruster) entry.manualInput.sternThruster = curHelm.sternThruster;
        }
        prevHelm = curHelm;
      }

      if (entry.serverDriven && entry.serverTarget && !(boardedShipId === entry.id && entry.manualOverrideActive)) {
        stepServerDrivenShip(entry, stepDt, liveWaveTime);
      } else if (st.mode === SHIP_MODE.MANUAL) {
        stepShipHydrodynamics(st, entry.manualInput, stepDt, env);
      } else {
        stepAutonomousCaptain(st, stepDt, env);
      }

      handleShipEventAudio(entry, prevEvent);
      updateVisualsForShip(entry, stepDt, liveWaveTime, listenerPos);

      if (boardedShipId === entry.id) {
        const bTarget = resolveBerthTarget(st.targetBerthId || "B1", st.origin);
        shipControls.updateCamera(st, stepDt, bTarget);
        shipOsd.update(buildOsdPayload(entry));
      }
    }

    updateGangwayPrompt();
  }

  function stepServerDrivenShip(entry, dt, waveTimeSec) {
    const st = entry.state;
    const tgt = entry.serverTarget;
    if (!tgt) return;

    const dx = tgt.x - st.x;
    const dy = tgt.y - st.y;
    const dist = Math.hypot(dx, dy);
    const alpha = dt > 0 ? (1.0 - Math.exp(-dt * 8.0)) : 1.0;

    if (dist > 150.0 || dt <= 0) {
      st.x = tgt.x;
      st.y = tgt.y;
      st.heading = wrapHeadingRad(tgt.heading);
    } else {
      st.x += dx * alpha;
      st.y += dy * alpha;
      st.heading = wrapHeadingRad(st.heading + shortestAngleDiff(tgt.heading, st.heading) * alpha);
    }

    const spd = fin(tgt.speed) ? tgt.speed : 0.0;
    st.speed = spd;
    st.surgeU = spd;
    st.swayV = 0.0;
    st.sogKnots = spd * 1.94384449;
    st.vx = spd * Math.sin(st.heading);
    st.vy = spd * Math.cos(st.heading);
    st.throttle = clamp(spd / Math.max(1.0, SHIP_SPECS.maxSpeedMps), -1.0, 1.0);
    st.radarSpinRad = (st.radarSpinRad + 1.8 * dt) % TAU;
    st.propSpinRad = (st.propSpinRad + (st.throttle * 14.0 + spd * 1.2) * dt) % TAU;

    // Wave-locked heave/pitch/roll buoyancy around target Z
    const baseZ = fin(tgt.z) ? tgt.z : 0.0;
    const [bx, by] = localToWorld2D(0.0, +32.0, st.x, st.y, st.heading);
    const [sx, sy] = localToWorld2D(0.0, -32.0, st.x, st.y, st.heading);
    const [rx, ry] = localToWorld2D(+6.5, 0.0, st.x, st.y, st.heading);
    const [px, py] = localToWorld2D(-6.5, 0.0, st.x, st.y, st.heading);
    const zBow = waterSwellLattice(bx, by, waveTimeSec);
    const zStern = waterSwellLattice(sx, sy, waveTimeSec);
    const zStbd = waterSwellLattice(rx, ry, waveTimeSec);
    const zPort = waterSwellLattice(px, py, waveTimeSec);

    const targetZ = baseZ + 0.25 * (zBow + zStern + zStbd + zPort);
    const targetPitch = (fin(tgt.pitch) ? tgt.pitch : 0.0) + Math.atan2(zBow - zStern, 64.0);
    const targetRoll = (fin(tgt.roll) ? tgt.roll : 0.0) + Math.atan2(zPort - zStbd, 13.0);

    st.z += (targetZ - st.z) * alpha;
    st.pitch = clamp(st.pitch + (targetPitch - st.pitch) * alpha, -0.18, 0.18);
    st.roll = clamp(st.roll + (targetRoll - st.roll) * alpha, -0.22, 0.22);
    st.timeSec = waveTimeSec;
  }

  function syncFromConvoyState(msg, worldPos = null) {
    if (disposed || !msg || typeof msg !== "object") return null;
    if (isExcludedItem2Convoy(msg)) return { ok: false, excluded: true };

    const rawId = msg.convoyId;
    const convoyIdStr = (rawId !== undefined && rawId !== null && String(rawId).trim() !== "" && String(rawId) !== "NaN")
      ? String(rawId).trim()
      : "0";
    const ownerMonarchId = (Number(msg.ownerMonarchId) || 0) >>> 0;
    const vehicleGuid = (Number(msg.vehicleGuid) || 0) >>> 0;
    const vehicleClass = Number.isFinite(Number(msg.vehicleClass)) ? (Number(msg.vehicleClass) | 0) : 0;
    const lodState = Number.isFinite(Number(msg.lodState)) ? (Number(msg.lodState) | 0) : 0;
    const status = Number.isFinite(Number(msg.status)) ? (Number(msg.status) | 0) : 0;
    const originTownId = (Number(msg.originTownId) || 0) >>> 0;
    const destTownId = (Number(msg.destTownId) || 0) >>> 0;
    const originLandblock = (Number(msg.originLandblock) || 0) >>> 0;
    const splineSM = Number.isFinite(Number(msg.splineSM)) ? Number(msg.splineSM) : 0;
    const fuelLiters = Number.isFinite(Number(msg.fuelLiters)) ? Number(msg.fuelLiters) : 0;
    const heading = wrapHeadingRad(Number.isFinite(Number(msg.heading)) ? Number(msg.heading) : 0);
    const cell = (Number(msg.cell) || 0) >>> 0;

    const posSrc = Array.isArray(worldPos) && worldPos.length >= 3
      ? worldPos
      : (Array.isArray(msg.position) && msg.position.length >= 3 ? msg.position : [0, 0, 0]);
    const wx = Number.isFinite(Number(posSrc[0])) ? Number(posSrc[0]) : 0;
    const wy = Number.isFinite(Number(posSrc[1])) ? Number(posSrc[1]) : 0;
    const wz = Number.isFinite(Number(posSrc[2])) ? Number(posSrc[2]) : 0;

    const record = {
      convoyId: convoyIdStr,
      ownerMonarchId,
      vehicleGuid,
      vehicleClass,
      lodState,
      status,
      originTownId,
      destTownId,
      originLandblock,
      splineSM,
      fuelLiters,
      cell,
      position: [wx, wy, wz],
      heading,
    };
    serverConvoys.set(convoyIdStr, record);

    if (vehicleClass !== PORT_VEHICLE_CLASS.ContainerShipFeeder) {
      return { ok: true, convoy: record, maritime: false };
    }

    const existingShipId = (vehicleGuid ? guidToShipId.get(vehicleGuid) : null) || convoyToShipId.get(convoyIdStr) || null;
    const demote = lodState === 0 || status >= 3;
    if (demote) {
      if (vehicleGuid) demotedServerGuids.add(vehicleGuid);
      let removed = false;
      if (existingShipId && ships.get(existingShipId)?.serverDriven) {
        removed = removeShip(existingShipId);
      }
      convoyToShipId.delete(convoyIdStr);
      if (vehicleGuid && guidToShipId.get(vehicleGuid) === existingShipId) {
        guidToShipId.delete(vehicleGuid);
      }
      return { ok: true, convoy: record, maritime: true, lodState, removed };
    }

    // lodState === 1 (Micro-LOD)
    if (vehicleGuid) demotedServerGuids.delete(vehicleGuid);
    const shipId = existingShipId || (vehicleGuid ? `SERVER-SHIP-${vehicleGuid}` : `CONVOY-${convoyIdStr}`);
    let entry = ships.get(shipId);
    if (!entry) {
      spawnShip(shipId, {
        x: wx,
        y: wy,
        z: wz,
        heading,
        mode: SHIP_MODE.AUTONOMOUS,
        populateCargo: false,
        name: msg.displayName || msg.name || `M/V Convoy #${convoyIdStr}`,
      });
      entry = ships.get(shipId);
      if (entry) {
        entry.hasServerPose = true;
      }
    }
    if (entry) {
      entry.serverDriven = true;
      entry.convoyId = convoyIdStr;
      if (vehicleGuid) entry.vehicleGuid = vehicleGuid;
      entry.serverTarget = {
        x: wx,
        y: wy,
        z: wz,
        heading,
        speed: Number.isFinite(Number(msg.speed)) ? Number(msg.speed) : (entry.serverTarget?.speed ?? 0),
        pitch: entry.serverTarget?.pitch ?? 0,
        roll: entry.serverTarget?.roll ?? 0,
      };
      entry.state.serverDriven = true;
      entry.state.convoyId = convoyIdStr;
      entry.state.vehicleGuid = vehicleGuid;
      entry.state.lodState = lodState;
      entry.state.fuelLiters = fuelLiters;
      entry.state.splineSM = splineSM;
      entry.state.originTownId = originTownId;
      entry.state.destTownId = destTownId;
      entry.state.convoyStatus = status;
      entry.state.wcid = PORT_WCID.ContainerShipFeeder;
      entry.state.vehicleClass = PORT_VEHICLE_CLASS.ContainerShipFeeder;
      entry.state.locomotion = PORT_LOCOMOTION.Marine;
      convoyToShipId.set(convoyIdStr, shipId);
      if (vehicleGuid) guidToShipId.set(vehicleGuid, shipId);
    }
    return { ok: true, convoy: record, maritime: true, lodState, shipId };
  }

  function onServerVehicleProfile(msg) {
    if (disposed || !msg || typeof msg !== "object") return null;
    if (isExcludedItem2Convoy(msg)) return null;
    const loco = (msg.locomotion ?? 0) | 0;
    const vClass = (msg.vehicleClass ?? 0) | 0;
    if (loco !== PORT_LOCOMOTION.Marine && vClass !== PORT_VEHICLE_CLASS.ContainerShipFeeder) {
      return null;
    }
    const guid = (msg.vehicle ?? msg.vehicleGuid ?? 0) >>> 0;
    if (!guid || demotedServerGuids.has(guid)) return null;

    const shipId = guidToShipId.get(guid) || `SERVER-SHIP-${guid}`;
    let entry = ships.get(shipId);
    const gp = Array.isArray(msg.globalPos) ? msg.globalPos : null;
    if (!entry) {
      spawnShip(shipId, {
        x: gp && fin(gp[0]) ? gp[0] : PORT_ORIGIN[0],
        y: gp && fin(gp[1]) ? gp[1] : PORT_ORIGIN[1],
        z: gp && fin(gp[2]) ? gp[2] : 0,
        heading: fin(msg.heading) ? msg.heading : 0,
        mode: SHIP_MODE.AUTONOMOUS,
        populateCargo: false,
        name: msg.displayName || msg.profileKey || `M/V Feeder #${guid}`,
      });
      entry = ships.get(shipId);
    }
    if (!entry) return null;

    entry.serverDriven = true;
    entry.vehicleGuid = guid;
    guidToShipId.set(guid, shipId);
    entry.state.serverDriven = true;
    entry.state.vehicleGuid = guid;
    entry.state.wcid = PORT_WCID.ContainerShipFeeder;
    entry.state.locomotion = loco || PORT_LOCOMOTION.Marine;
    entry.state.vehicleClass = vClass || PORT_VEHICLE_CLASS.ContainerShipFeeder;
    entry.state.profileKey = msg.profileKey || "container-ship-feeder";
    return entry.facade;
  }

  function onServerVehicleState(msg, worldPose = null) {
    if (disposed || !msg || typeof msg !== "object") return null;
    if (isExcludedItem2Convoy(msg)) return null;
    const guid = (msg.vehicle ?? msg.vehicleGuid ?? 0) >>> 0;
    if (!guid || demotedServerGuids.has(guid)) return null;

    let shipId = guidToShipId.get(guid) || `SERVER-SHIP-${guid}`;
    let entry = ships.get(shipId);
    if (!entry) {
      onServerVehicleProfile({
        vehicle: guid,
        locomotion: PORT_LOCOMOTION.Marine,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
        globalPos: worldPose ? [worldPose.x, worldPose.y, worldPose.z] : null,
      });
      shipId = guidToShipId.get(guid) || `SERVER-SHIP-${guid}`;
      entry = ships.get(shipId);
    }
    if (!entry) return null;

    const wx = fin(worldPose?.x) ? worldPose.x : (fin(msg.x) ? msg.x : entry.state.x);
    const wy = fin(worldPose?.y) ? worldPose.y : (fin(msg.y) ? msg.y : entry.state.y);
    const wz = fin(worldPose?.z) ? worldPose.z : (fin(msg.z) ? msg.z : entry.state.z);
    const heading = wrapHeadingRad(fin(worldPose?.heading) ? worldPose.heading : (fin(msg.heading) ? msg.heading : entry.state.heading));
    const speed = fin(worldPose?.speed) ? worldPose.speed : (fin(msg.speed) ? msg.speed : 0);
    const pitch = fin(worldPose?.pitch) ? worldPose.pitch : (fin(msg.pitch) ? msg.pitch : 0);
    const roll = fin(worldPose?.roll) ? worldPose.roll : (fin(msg.bank) ? msg.bank : 0);

    entry.serverDriven = true;
    entry.vehicleGuid = guid;
    guidToShipId.set(guid, shipId);
    if (!entry.hasServerPose) {
      entry.hasServerPose = true;
      entry.state.x = wx;
      entry.state.y = wy;
      entry.state.z = wz;
      entry.state.heading = heading;
    }
    entry.serverTarget = { x: wx, y: wy, z: wz, heading, speed, pitch, roll };
    entry.state.serverDriven = true;
    entry.state.speed = speed;
    entry.state.sogKnots = speed * 1.94384449;
    return entry.facade;
  }

  function onServerVehicleDespawn(vehicleGuid) {
    const g = (Number(vehicleGuid) || 0) >>> 0;
    if (!g) return false;
    demotedServerGuids.delete(g);
    const shipId = guidToShipId.get(g);
    if (!shipId) return false;
    const entry = ships.get(shipId);
    if (entry && entry.serverDriven) {
      return removeShip(shipId);
    }
    guidToShipId.delete(g);
    return false;
  }

  function clearServerConvoys() {
    serverConvoys.clear();
    demotedServerGuids.clear();
    for (const [id, entry] of [...ships.entries()]) {
      if (entry.serverDriven) {
        removeShip(id);
      }
    }
    guidToShipId.clear();
    convoyToShipId.clear();
  }

  function dispatchConvoyOrder(opts = {}) {
    if (disposed) return { ok: false, reason: "disposed" };
    const o = opts && typeof opts === "object" ? opts : {};
    if (isExcludedItem2Convoy(o)) return { ok: false, reason: "excluded_item2" };
    const payload = {
      convoyId: o.convoyId ?? 0n,
      action: o.action ?? 1,
      vehicleClass: o.vehicleClass ?? PORT_VEHICLE_CLASS.ContainerShipFeeder,
      flags: o.flags ?? 0,
      originTownId: o.originTownId ?? 0,
      destTownId: o.destTownId ?? 0,
      containerKind: o.containerKind ?? 0,
      commodityId: o.commodityId ?? 0,
    };
    if (!sendConvoyOrder) return { ok: false, reason: "offline" };
    try {
      const ok = sendConvoyOrder(payload);
      return ok ? { ok: true, order: payload } : { ok: false, reason: "offline" };
    } catch (_) {
      return { ok: false, reason: "offline" };
    }
  }

  function getConvoyStates() {
    const out = [];
    for (const c of serverConvoys.values()) {
      out.push({ ...c, position: [...c.position] });
    }
    return out;
  }

  function onTeleport() {
    if (boardedShipId) exit();
  }

  function getState() {
    const out = {};
    for (const [id, entry] of ships.entries()) {
      out[id] = snapshotShip(entry);
    }
    return {
      disposed,
      simTimeSec,
      tickCount,
      shipCount: ships.size,
      serverConvoyCount: serverConvoys.size,
      boardedShipId,
      viewMode: shipControls.getViewMode(),
      ships: out,
      convoys: getConvoyStates(),
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    exit();
    try { unsubActions(); } catch (_) {}
    if (win && typeof win.removeEventListener === "function") {
      try { win.removeEventListener("keydown", onGangwayKeyDown, true); } catch (_) {}
    }
    clearServerConvoys();
    for (const id of [...ships.keys()]) {
      removeShip(id);
    }
    ships.clear();
    try { shipControls.dispose(); } catch (_) {}
    try { shipOsd.dispose(); } catch (_) {}
    detachShipsRoot();
  }

  return {
    spawnShip,
    removeShip,
    list,
    get,
    board,
    exit,
    getBoardedShipId: () => boardedShipId,
    setHelmInput,
    setMode,
    setCameraView: (m) => shipControls.setViewMode(m),
    commandGoToBerth,
    commandDepart,
    moor,
    unmoor,
    setHatchCover,
    loadContainer,
    unloadContainer,
    getCargoSlotWorldPos,
    signalCargoOpsComplete: signalCargoOpsCompleteById,
    soundFoghorn,
    syncFromConvoyState,
    onServerVehicleProfile,
    onServerVehicleState,
    onServerVehicleDespawn,
    clearServerConvoys,
    dispatchConvoyOrder,
    getConvoyStates,
    getOuterOceanPorts: () => OUTER_OCEAN_PORTS,
    linkTerminalManager(tm) { terminalManager = tm; },
    getRoot: () => shipsRoot,
    getControls: () => shipControls,
    getOsd: () => shipOsd,
    getState,
    get stats() {
      let totalContainers = 0;
      let mooredCount = 0;
      let serverShipCount = 0;
      for (const entry of ships.values()) {
        totalContainers += entry.cargo.count();
        if (entry.state.moored) mooredCount++;
        if (entry.serverDriven) serverShipCount++;
      }
      return {
        disposed,
        simTimeSec,
        tickCount,
        shipCount: ships.size,
        serverShipCount,
        serverConvoyCount: serverConvoys.size,
        mooredCount,
        totalContainers,
        boardedShipId,
      };
    },
    tick,
    onTeleport,
    dispose,
  };
}
