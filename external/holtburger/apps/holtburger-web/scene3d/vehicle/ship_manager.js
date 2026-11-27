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
  BERTH_SPECS,
  SHIP_SPECS,
  SHIP_BAY_DEFS,
  SHIP_ROW_DEFS,
  PORT_PALLET_SPECS,
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

      if (st.mode === SHIP_MODE.MANUAL) {
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
      boardedShipId,
      viewMode: shipControls.getViewMode(),
      ships: out,
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
    linkTerminalManager(tm) { terminalManager = tm; },
    getRoot: () => shipsRoot,
    getControls: () => shipControls,
    getOsd: () => shipOsd,
    getState,
    get stats() {
      let totalContainers = 0;
      let mooredCount = 0;
      for (const entry of ships.values()) {
        totalContainers += entry.cargo.count();
        if (entry.state.moored) mooredCount++;
      }
      return {
        disposed,
        simTimeSec,
        tickCount,
        shipCount: ships.size,
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
