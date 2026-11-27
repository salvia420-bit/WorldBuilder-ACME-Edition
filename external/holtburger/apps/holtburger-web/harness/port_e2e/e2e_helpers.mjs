// harness/port_e2e/e2e_helpers.mjs
// Shared opaque-box E2E infrastructure for the Marine Container Terminal & Container Ship.
// Zero Math.random() / Date.now(); deterministic clocks and fixed-step simulation drivers.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requireThree } from "../lib/locate_three.mjs";
import { createFakeWebGL2, fakeCanvas } from "../../tests/helpers/fake_webgl2.mjs";
import { installFakeAudio } from "../../tests/helpers/fake_audio_context.mjs";
import { lintManifest, lintSource } from "../../scene3d/vfx/lint_caps.js";

export { assert, createFakeWebGL2, fakeCanvas, installFakeAudio, lintManifest, lintSource };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = path.resolve(HERE, "..");
export const APP_ROOT = path.resolve(HARNESS_ROOT, "..");
export const VEHICLE_DIR = path.join(APP_ROOT, "scene3d", "vehicle");

export const ALL_DEPLOYABLE_WCIDS = Object.freeze([
  4000002, // RadarStation
  4000010, // FluxPod
  4000011, // SolarPanels
  4000012, // PowerGenerator
  4000013, // BatteryUnit
  4000014, // MissileTurret
  4000015, // GroundRadar
  4000016, // MortarTurret
  4000017, // HeavyLaserTurret
]);

export const PORT_MODULE_FILES = Object.freeze([
  { key: "portSpecs", builder: "B1", rel: "scene3d/vehicle/port_specs.js" },
  { key: "portKinematics", builder: "B1", rel: "scene3d/vehicle/port_kinematics.js" },
  { key: "shipKinematics", builder: "B1", rel: "scene3d/vehicle/ship_kinematics.js" },
  { key: "portQuayModel", builder: "B2", rel: "scene3d/vehicle/port_quay_model.js" },
  { key: "portStsCraneModel", builder: "B2", rel: "scene3d/vehicle/port_sts_crane_model.js" },
  { key: "portYardCraneModel", builder: "B2", rel: "scene3d/vehicle/port_yard_crane_model.js" },
  { key: "portShuttleModel", builder: "B2", rel: "scene3d/vehicle/port_shuttle_model.js" },
  { key: "shipModel", builder: "B3", rel: "scene3d/vehicle/ship_model.js" },
  { key: "shipFx", builder: "B3", rel: "scene3d/vehicle/ship_fx.js" },
  { key: "shipControls", builder: "B3", rel: "scene3d/vehicle/ship_controls.js" },
  { key: "shipOsd", builder: "B3", rel: "scene3d/vehicle/ship_osd.js" },
  { key: "portAudio", builder: "B3", rel: "scene3d/vehicle/port_audio.js" },
  { key: "portTerminalManager", builder: "B4", rel: "scene3d/vehicle/port_terminal_manager.js" },
  { key: "shipManager", builder: "B4", rel: "scene3d/vehicle/ship_manager.js" },
]);

export const SHIPPED_MODULE_FILES = Object.freeze([
  { key: "index", rel: "scene3d/vehicle/index.js" },
  { key: "warehouseSpecs", rel: "scene3d/vehicle/warehouse_specs.js" },
  { key: "warehouseManager", rel: "scene3d/vehicle/warehouse_manager.js" },
  { key: "containerLogistics", rel: "scene3d/vehicle/container_logistics.js" },
  { key: "containerModels", rel: "scene3d/vehicle/container_models.js" },
  { key: "deployableModels", rel: "scene3d/vehicle/deployable_models.js" },
  { key: "trailerModels", rel: "scene3d/vehicle/trailer_models.js" },
  { key: "palletJackModel", rel: "scene3d/vehicle/pallet_jack_model.js" },
]);

let cachedThree = null;
export async function getThree() {
  if (!cachedThree) {
    cachedThree = await requireThree("port-e2e");
  }
  return cachedThree;
}

export function readVehicleSource(filename) {
  const fullPath = path.join(VEHICLE_DIR, filename);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing source file for lint inspection: ${fullPath}`);
  }
  return readFileSync(fullPath, "utf8");
}

export async function probePortModules() {
  const results = [];
  for (const mod of PORT_MODULE_FILES) {
    const abs = path.join(APP_ROOT, mod.rel);
    if (!existsSync(abs)) {
      results.push({ ...mod, abs, status: "PENDING_IMPLEMENTATION", error: null });
      continue;
    }
    try {
      const loaded = await import(pathToFileURL(abs).href);
      results.push({ ...mod, abs, status: "AVAILABLE", exports: Object.keys(loaded), error: null });
    } catch (err) {
      results.push({
        ...mod,
        abs,
        status: "LOAD_ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

let cachedMods = null;
export async function loadPortModules() {
  if (cachedMods) return cachedMods;
  const loaded = {};
  const missingRel = {};
  for (const mod of PORT_MODULE_FILES) {
    const abs = path.join(APP_ROOT, mod.rel);
    if (!existsSync(abs)) {
      missingRel[mod.key] = mod.rel;
      continue;
    }
    loaded[mod.key] = await import(pathToFileURL(abs).href);
  }
  for (const mod of SHIPPED_MODULE_FILES) {
    const abs = path.join(APP_ROOT, mod.rel);
    if (!existsSync(abs)) {
      missingRel[mod.key] = mod.rel;
      continue;
    }
    loaded[mod.key] = await import(pathToFileURL(abs).href);
  }
  cachedMods = new Proxy(loaded, {
    get(target, prop) {
      if (typeof prop === "string" && prop in missingRel) {
        throw new Error(`Required port module not found: ${missingRel[prop]}`);
      }
      return target[prop];
    },
  });
  return cachedMods;
}

// =============================================================================
// Audio Mock Contexts
// =============================================================================

function rparam(init = 0) {
  return {
    value: init,
    setValueAtTime(v) { this.value = v; },
    setTargetAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
  };
}

export class FullMockCtx {
  constructor() {
    this.sampleRate = 8000;
    this.currentTime = 0;
    this.state = "running";
    this.made = [];
  }
  _n(kind, extra) {
    const n = {
      kind,
      connections: [],
      connect(to) { this.connections.push(to); return to; },
      disconnect() { this.connections = []; },
      ...extra,
    };
    this.made.push(n);
    return n;
  }
  _src(kind, extra) {
    return this._n(kind, {
      stopped: false,
      onended: null,
      start() {},
      stop() { this.stopped = true; },
      ...extra,
    });
  }
  createOscillator() { return this._src("osc", { type: "sine", frequency: rparam(440) }); }
  createBiquadFilter() { return this._n("biquad", { type: "lowpass", frequency: rparam(350), Q: rparam(1), gain: rparam(0) }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createBufferSource() { return this._src("bufsrc", { buffer: null, loop: false }); }
  createGain() { return this._n("gain", { gain: rparam(1) }); }
  createPanner() {
    return this._n("panner", {
      panningModel: "equalpower",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 10000,
      positionX: rparam(0),
      positionY: rparam(0),
      positionZ: rparam(0),
    });
  }
  async resume() { this.state = "running"; }
}

export class BareMockCtx extends FullMockCtx {
  constructor() {
    super();
    this.createBiquadFilter = undefined;
    this.createPanner = undefined;
  }
  createOscillator() {
    const f = { value: 440, setTargetAtTime(v) { this.value = v; } };
    return this._src("osc", { type: "sine", frequency: f });
  }
}

export function makeAudioBus(Ctx = FullMockCtx) {
  const ctx = new Ctx();
  const node = ctx._n("bus", { gain: rparam(1) });
  ctx.made.length = 0;
  return { ctx, node, sliderGain: () => 1, isActive: () => true };
}

// =============================================================================
// Fake DOM / Window / LiveScene3D / Water Oracle Rig
// =============================================================================

export function makeSiteAWaterOracle(quayY = 47880.0, xMin = 44780.0, xMax = 45180.0) {
  const shorelineY = quayY - 48.0;
  return {
    heightAt() { return 0.0; },
    sample(wx, wy, out) {
      const inQuayBox = wx >= xMin && wx <= xMax && wy <= quayY;
      const onDryLand = wy <= shorelineY || inQuayBox;
      const code = onDryLand ? 10 : 20;
      const res = out || {};
      res.cornerCodes = [code, code, code, code];
      res.hasHeight = true;
      res.height = 0.0;
      return res;
    },
  };
}

export function makeFakeWindowDocCanvas(search = "?vehicles=on&vehicleAudio=on") {
  const winListeners = new Map();
  const docListeners = new Map();
  const canvasListeners = new Map();
  const byId = new Map();

  const makeEl = (tag = "div") => {
    const cls = new Set();
    let clsRaw = "";
    const elListeners = new Map();
    let idVal = "";
    const el = {
      tagName: tag.toUpperCase(),
      get id() { return idVal; },
      set id(v) {
        if (idVal && byId.get(idVal) === el) byId.delete(idVal);
        idVal = String(v || "");
        if (idVal) byId.set(idVal, el);
      },
      get className() { return clsRaw; },
      set className(v) {
        clsRaw = String(v || "");
        cls.clear();
        for (const part of clsRaw.split(/\s+/)) {
          if (part) cls.add(part);
        }
      },
      style: {},
      textContent: "",
      innerHTML: "",
      children: [],
      parentNode: null,
      dataset: {},
      isConnected: true,
      isContentEditable: false,
      contentEditable: "false",
      _modal: false,
      classList: {
        add(...xs) { xs.forEach((x) => cls.add(x)); },
        remove(...xs) { xs.forEach((x) => cls.delete(x)); },
        toggle(x, f) {
          if (f === undefined) { if (cls.has(x)) cls.delete(x); else cls.add(x); }
          else if (f) cls.add(x); else cls.delete(x);
        },
        contains(x) { return cls.has(x); },
      },
      appendChild(c) {
        c.parentNode = el;
        this.children.push(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      remove() {
        if (this.parentNode && Array.isArray(this.parentNode.children)) {
          const i = this.parentNode.children.indexOf(this);
          if (i >= 0) this.parentNode.children.splice(i, 1);
        }
        if (this.id && byId.get(this.id) === this) byId.delete(this.id);
      },
      closest(sel) {
        if (sel === '[aria-modal="true"]' && this._modal) return this;
        return this.parentNode?.closest?.(sel) ?? null;
      },
      querySelector(sel) {
        if (typeof sel === "string" && sel.startsWith("#")) return byId.get(sel.slice(1)) ?? null;
        return null;
      },
      _attrs: Object.create(null),
      setAttribute(k, v) {
        this._attrs[k] = String(v);
        if (k === "aria-modal") this._modal = v === "true";
      },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : (this[k] ?? null); },
      addEventListener(type, fn) {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = elListeners.get(type);
        if (!arr) return;
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      dispatch(type, ev = {}) {
        const arr = [...(elListeners.get(type) || [])];
        for (const fn of arr) fn(ev);
      },
    };
    return el;
  };

  const canvas = {
    clientWidth: 1920,
    clientHeight: 1080,
    style: {},
    requestPointerLock() {},
    addEventListener(type, fn) {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      canvasListeners.get(type)?.delete(fn);
    },
  };

  function dispatchTo(map, type, ev = {}) {
    const arr = [...(map.get(type) || [])];
    const caps = arr.filter((x) => x.capture);
    const bubs = arr.filter((x) => !x.capture);
    let defaultPrevented = false;
    let immediateStopped = false;
    let propagationStopped = false;
    const e = {
      type,
      target: null,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      ...ev,
      get defaultPrevented() { return defaultPrevented; },
      preventDefault() { defaultPrevented = true; },
      stopImmediatePropagation() { immediateStopped = true; propagationStopped = true; },
      stopPropagation() { propagationStopped = true; },
    };
    for (const h of caps) {
      if (immediateStopped) break;
      h.fn(e);
    }
    if (!propagationStopped) {
      for (const h of bubs) {
        if (immediateStopped) break;
        h.fn(e);
      }
    }
    return { event: e, defaultPrevented, immediateStopped, propagationStopped };
  }

  const doc = {
    body: makeEl("body"),
    head: makeEl("head"),
    activeElement: null,
    pointerLockElement: null,
    visibilityState: "visible",
    createElement(tag) { return makeEl(tag); },
    getElementById(id) { return byId.get(id) ?? null; },
    querySelectorAll(sel) {
      if (sel !== '[aria-modal="true"]') return [];
      const out = [];
      const walk = (node) => {
        if (!node || !Array.isArray(node.children)) return;
        for (const c of node.children) {
          if (c._modal) out.push(c);
          walk(c);
        }
      };
      walk(doc.body);
      return out;
    },
    querySelector(sel) {
      if (typeof sel === "string" && sel.startsWith("#")) return byId.get(sel.slice(1)) ?? null;
      return doc.querySelectorAll(sel)[0] ?? null;
    },
    exitPointerLock() { doc.pointerLockElement = null; },
    addEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, capture: cap });
    },
    removeEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.findIndex((x) => x.fn === fn && x.capture === cap);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatch(type, ev = {}) {
      return dispatchTo(docListeners, type, ev);
    },
    listenerCount(type) {
      return (docListeners.get(type) || []).length;
    },
  };

  const funnelLog = [];
  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    location: { search },
    document: doc,
    getLocalPlayerGuid: () => 0,
    __jumpChargeActive: false,
    cancelJumpChargeCalls: 0,
    cancelJumpCharge() { win.cancelJumpChargeCalls++; win.__jumpChargeActive = false; },
    __inputFunnel: {
      installed: true,
      _fault: null,
      poison(v) { this._fault = v; funnelLog.push({ op: "poison", v }); },
      unpoison() { this._fault = null; funnelLog.push({ op: "unpoison" }); },
      releaseHeld(r) { funnelLog.push({ op: "releaseHeld", r }); },
      snapshot() { return { fault: this._fault }; },
    },
    addEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, capture: cap });
    },
    removeEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const arr = winListeners.get(type);
      if (!arr) return;
      const idx = arr.findIndex((x) => x.fn === fn && x.capture === cap);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatch(type, ev = {}) {
      return dispatchTo(winListeners, type, ev);
    },
    listenerCount(type) {
      return (winListeners.get(type) || []).length;
    },
  };

  return { win, doc, canvas, makeEl, byId, funnelLog };
}

function makeHumanoidEntity(THREE, setupId = 0x02000001) {
  const mkPart = (z = 0) => ({
    position: new THREE.Vector3(0, 0, z),
    quaternion: new THREE.Quaternion(),
    rotation: new THREE.Euler(),
  });
  const parts = Array.from({ length: 34 }, (_, i) => mkPart(i === 10 || i === 13 ? 1.38 : 0.9));
  return {
    root: new THREE.Group(),
    setupId,
    parts,
    _filmHidden: false,
    _wireCellId: 0,
    _wireCellIdx: 0,
  };
}

export function makeCsmState() {
  return { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
}

export function makePortTestRig(THREE, initVehicles, opts = {}) {
  const search = opts.search ?? "?vehicles=on&vehicleAudio=on";
  const { win, doc, canvas, makeEl, byId, funnelLog } = makeFakeWindowDocCanvas(search);
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  scene.add(worldRoot);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 4000);
  const entityMap = new Map();
  const standInHiddenCalls = [];

  const localPlayerGuid = opts.localPlayerGuid ?? 0x50000001;
  win.getLocalPlayerGuid = () => localPlayerGuid;
  const localEntity = makeHumanoidEntity(THREE, opts.setupId ?? 0x02000001);
  if (Array.isArray(opts.playerPos)) {
    localEntity.root.position.set(opts.playerPos[0], opts.playerPos[1], opts.playerPos[2] ?? 0);
  }
  entityMap.set(localPlayerGuid, localEntity);

  const inbox = [];
  const calls = {
    containerActions: [],
    upserts: [],
    removals: [],
    chats: [],
  };

  let terrainHeightFn = opts.terrainHeightAt ?? (() => 0.0);
  const terrainOracle = opts.terrainOracle ?? makeSiteAWaterOracle();
  const frameTime = { tsSec: 0.0, tsMs: 0.0 };

  const sessionHandle = opts.sessionHandle === null ? null : {
    vehicleCapabilities() {},
    drainVehicleMessages() {
      const out = JSON.stringify(inbox);
      inbox.length = 0;
      return out;
    },
    terrainHeightAt(x, y) { return terrainHeightFn(x, y); },
    probeContainerSurface() { return null; },
    resolveContainerPushout() { return null; },
    setVehicleSeat() { return true; },
    clearVehicleSeat() {},
    vehicleBoard() {},
    vehicleExit() {},
    vehicleInput() {},
    vehicleTrailerAction() {},
    vehicleContainerAction(containerGuid, action, slotIndex, subSlot, cargoWcid) {
      calls.containerActions.push({ containerGuid, action, slotIndex, subSlot, cargoWcid });
      return true;
    },
    vehiclePalletJackAction() {},
    upsertContainerCollider(guid, cell, x, y, z, heading, kind, doorOpen) {
      calls.upserts.push({ guid, cell, x, y, z, heading, kind, doorOpen });
    },
    removeContainerCollider(guid) {
      calls.removals.push(guid);
      return true;
    },
    sendChat(msg) { calls.chats.push(msg); },
    jumpChargeAbort() { win.__jumpChargeActive = false; },
  };

  const csmState = makeCsmState();
  const cameraSwitcher = {
    persp: camera,
    mode: "follow",
    followYaw: 0,
    followPitch: 0,
    positionCamera() {},
    getPlayerWorldPosition(out) {
      const v = out || new THREE.Vector3();
      return v.copy(localEntity.root.position);
    },
  };

  const live = {
    sessionHandle,
    renderer: { domElement: canvas },
    scene,
    worldRoot,
    camera,
    cameraSwitcher,
    localPlayerGuid,
    csmState,
    frameTime,
    _terrainOracle: terrainOracle,
    nullRender: Boolean(opts.nullRender),
    ...(opts.audioManager ? { audioManager: opts.audioManager } : {}),
    entityManager: {
      entityMap,
      localPlayerGuid,
      isDeathHeld() { return false; },
      setMotion() {},
      setFilmHidden(guid, hidden) {
        standInHiddenCalls.push({ guid: guid >>> 0, hidden: !!hidden });
        const ent = entityMap.get(guid >>> 0);
        if (!ent) return false;
        ent._filmHidden = !!hidden;
        return true;
      },
    },
  };

  const api = initVehicles ? initVehicles(live, { window: win, document: doc, canvas, THREE }) : null;
  let simMs = 0;
  const tick = (dtMs = 16.667) => {
    simMs += dtMs;
    frameTime.tsMs = simMs;
    frameTime.tsSec = simMs / 1000;
    live.vehicles?.afterTick?.(simMs, dtMs);
  };

  return {
    win, doc, canvas, makeEl, byId, funnelLog, scene, worldRoot, camera, cameraSwitcher,
    entityMap, localEntity, standInHiddenCalls, localPlayerGuid, calls, live, api, csmState,
    sessionHandle, frameTime, terrainOracle, tick,
    setTerrainHeightFn(fn) { terrainHeightFn = fn; },
    cleanup() {
      try { api?.dispose?.(); } catch (_) {}
    },
  };
}

// =============================================================================
// Scene Graph, GPU Budget, Bounds, Disposal Spy & WebGL2 Helpers
// =============================================================================

export function countDrawCalls(root, { visibleOnly = false } = {}) {
  let calls = 0;
  if (!root) return 0;
  const countNode = (o) => {
    if (visibleOnly && !o.visible) return;
    if (o.isMesh || o.isLine || o.isSprite || o.isPoints) calls++;
  };
  if (visibleOnly) {
    if (typeof root.traverseVisible === "function") {
      root.traverseVisible(countNode);
    } else {
      const walk = (node) => {
        if (!node || !node.visible) return;
        countNode(node);
        if (Array.isArray(node.children)) {
          for (const child of node.children) walk(child);
        }
      };
      walk(root);
    }
  } else {
    root.traverse(countNode);
  }
  return calls;
}

export function countLights(root) {
  let lights = 0;
  if (!root) return 0;
  root.traverse((o) => {
    if (o.isLight) lights++;
  });
  return lights;
}

export function collectResources(root) {
  const geometries = new Set();
  const materials = new Set();
  if (!root) return { geometries, materials };
  root.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m) materials.add(m);
    }
  });
  return { geometries, materials };
}

export function spyDisposal(root) {
  const { geometries, materials } = collectResources(root);
  const geomCounts = new Map();
  const matCounts = new Map();

  for (const g of geometries) {
    geomCounts.set(g, 0);
    if (typeof g.dispose === "function") {
      if (!g.__portSpyListeners) {
        g.__portSpyListeners = new Set();
        const orig = g.dispose.bind(g);
        g.dispose = () => {
          for (const cb of g.__portSpyListeners) cb();
          return orig();
        };
      }
      g.__portSpyListeners.add(() => {
        geomCounts.set(g, (geomCounts.get(g) || 0) + 1);
      });
    }
  }

  for (const m of materials) {
    matCounts.set(m, 0);
    if (typeof m.dispose === "function") {
      if (!m.__portSpyListeners) {
        m.__portSpyListeners = new Set();
        const orig = m.dispose.bind(m);
        m.dispose = () => {
          for (const cb of m.__portSpyListeners) cb();
          return orig();
        };
      }
      m.__portSpyListeners.add(() => {
        matCounts.set(m, (matCounts.get(m) || 0) + 1);
      });
    }
  }

  return {
    geometries,
    materials,
    geomCounts,
    matCounts,
    assertAllDisposed(label = "resource") {
      const leakedGeom = [];
      for (const [g, count] of geomCounts.entries()) {
        if (count < 1) leakedGeom.push(g.type || g.uuid || "geometry");
      }
      const leakedMat = [];
      for (const [m, count] of matCounts.entries()) {
        if (count < 1) leakedMat.push(m.name || m.type || m.uuid || "material");
      }
      assert.equal(leakedGeom.length, 0, `${label}: leaked ${leakedGeom.length} geometry(ies): ${leakedGeom.slice(0, 5).join(", ")}`);
      assert.equal(leakedMat.length, 0, `${label}: leaked ${leakedMat.length} material(s): ${leakedMat.slice(0, 5).join(", ")}`);
    },
  };
}

export function computeBox3(THREE, obj) {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

export function assertFinitePose(pose, label = "pose") {
  assert.ok(pose && typeof pose === "object", `${label} must be an object`);
  if (Array.isArray(pose)) {
    assert.ok(pose.length >= 3, `${label} array must have >= 3 elements`);
    for (let i = 0; i < 3; i++) {
      assert.ok(Number.isFinite(pose[i]), `${label}[${i}] is not finite: ${pose[i]}`);
    }
    return;
  }
  for (const k of ["x", "y", "z", "heading", "pitch", "roll"]) {
    if (k in pose) assert.ok(Number.isFinite(pose[k]), `${label}.${k} not finite: ${pose[k]}`);
  }
}

export function assertNoNaNDeep(val, label = "value", seen = new Set()) {
  if (typeof val === "number") {
    assert.ok(Number.isFinite(val), `${label} is non-finite: ${val}`);
    return;
  }
  if (!val || typeof val !== "object") return;
  if (seen.has(val)) return;
  seen.add(val);
  if (ArrayBuffer.isView(val)) {
    for (let i = 0; i < val.length; i++) {
      assert.ok(Number.isFinite(val[i]), `${label}[${i}] is non-finite: ${val[i]}`);
    }
    return;
  }
  if (val instanceof Map) {
    for (const [k, v] of val.entries()) assertNoNaNDeep(v, `${label}.get(${String(k)})`, seen);
    return;
  }
  if (val instanceof Set) {
    let idx = 0;
    for (const v of val.values()) assertNoNaNDeep(v, `${label}[set:${idx++}]`, seen);
    return;
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) assertNoNaNDeep(val[i], `${label}[${i}]`, seen);
    return;
  }
  for (const [k, v] of Object.entries(val)) {
    if (typeof v === "function") continue;
    assertNoNaNDeep(v, `${label}.${k}`, seen);
  }
}

export function renderWithFakeWebGL2(THREE, rootOrScene, opts = {}) {
  const originalError = console.error;
  const capturedErrors = [];
  console.error = (...args) => {
    capturedErrors.push(args.join(" "));
    originalError(...args);
  };

  let renderer = null;
  let tempScene = null;
  let attachedToTemp = false;
  try {
    const gl = createFakeWebGL2({ maxTextures: 16 });
    renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    let scene = rootOrScene;
    if (!rootOrScene.isScene) {
      tempScene = new THREE.Scene();
      tempScene.add(rootOrScene);
      scene = tempScene;
      attachedToTemp = true;
    }
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 4000);
    const camPos = opts.cameraPos ?? [44960, 47960, 45];
    const lookAt = opts.lookAt ?? [44960, 47860, 2];
    camera.position.set(camPos[0], camPos[1], camPos[2]);
    camera.up.set(0, 0, 1);
    camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);

    gl.__fake.reset();
    renderer.render(scene, camera);

    const c = gl.__fake.counts;
    const emittedDraws =
      (c.drawArrays || 0) +
      (c.drawElements || 0) +
      (c.drawArraysInstanced || 0) +
      (c.drawElementsInstanced || 0);

    return {
      emittedDraws,
      counts: { ...c },
      capturedErrors: [...capturedErrors],
      dispose() {
        if (attachedToTemp && tempScene && rootOrScene.parent === tempScene) {
          tempScene.remove(rootOrScene);
        }
        renderer?.dispose?.();
      },
    };
  } finally {
    console.error = originalError;
    if (attachedToTemp && tempScene && rootOrScene.parent === tempScene) {
      tempScene.remove(rootOrScene);
    }
  }
}

// =============================================================================
// Deterministic Simulation Drivers
// =============================================================================

export function stepUntil(stepFn, predFn, maxSteps = 2400, dt = 1 / 30) {
  for (let i = 0; i < maxSteps; i++) {
    stepFn(i, dt, i * dt);
    if (predFn(i, (i + 1) * dt)) {
      return { done: true, steps: i + 1, elapsed: (i + 1) * dt };
    }
  }
  return { done: false, steps: maxSteps, elapsed: maxSteps * dt };
}

export async function drivePortPromise(tickFn, taskPromise, opts = {}) {
  const maxSteps = opts.maxSteps ?? 4800;
  const dt = opts.dt ?? 1 / 30;
  const onStep = opts.onStep ?? null;
  let settled = false;
  let rejected = null;
  let value = undefined;
  Promise.resolve(taskPromise).then(
    (v) => { settled = true; value = v; },
    (err) => { settled = true; rejected = err instanceof Error ? err : new Error(String(err)); }
  );
  for (let i = 0; i < maxSteps; i++) {
    tickFn(dt, i);
    if (onStep) onStep(i, (i + 1) * dt);
    await Promise.resolve();
    if (settled) {
      if (rejected) throw rejected;
      return { steps: i + 1, elapsed: (i + 1) * dt, value };
    }
  }
  await Promise.resolve();
  if (settled) {
    if (rejected) throw rejected;
    return { steps: maxSteps, elapsed: maxSteps * dt, value };
  }
  throw new Error(`Port task did not settle within ${maxSteps} steps (${(maxSteps * dt).toFixed(2)}s)`);
}

export async function driveVehiclesPromise(rig, taskPromise, opts = {}) {
  const maxSteps = opts.maxSteps ?? 4800;
  const dtMs = opts.dtMs ?? 33.333;
  const onStep = opts.onStep ?? null;
  let settled = false;
  let rejected = null;
  let value = undefined;
  Promise.resolve(taskPromise).then(
    (v) => { settled = true; value = v; },
    (err) => { settled = true; rejected = err instanceof Error ? err : new Error(String(err)); }
  );
  for (let i = 0; i < maxSteps; i++) {
    rig.tick(dtMs);
    if (onStep) onStep(i, (i + 1) * dtMs);
    await Promise.resolve();
    if (settled) {
      if (rejected) throw rejected;
      return { steps: i + 1, value };
    }
  }
  await Promise.resolve();
  if (settled) {
    if (rejected) throw rejected;
    return { steps: maxSteps, value };
  }
  throw new Error(`afterTick port task did not settle within ${maxSteps} steps`);
}

export function wrapAngle(rad) {
  let a = rad % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
