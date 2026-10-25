// tests/drone_api.test.mjs
//
// WHY: scene3d/drone/index.js installs `window.__drone` and runs the whole Drone Deploy
// cycle: it builds the cycle from injected factories, executes the sequence's actions,
// drives the per-frame pipeline inside `liveScene3d.film.preFrame` and must hand back
// EVERYTHING at idle — the camera (no positionCamera wrap, no filmViewer, no
// liveScene3d.film), the input funnel gate, every window / document / canvas listener,
// every hook listener — on the normal path and on every abort. A leak here is a dead
// keyboard, a camera stuck in the goggles or a console full of errors on the next take.
// This suite EXECUTES the real index.js with `deps.modules` FAKES for every other-lane
// factory (gestures, props, manual_flight, tether, controls, osd, audio — minimal objects
// implementing exactly the SPEC §3 shapes and recording calls; no L1/L2/L3 file is
// imported) and the REAL sequence + REAL world link (film camera owner, safety, world,
// world query, lens overlay) over a fake liveScene3d: a FakeSwitcher with a real
// THREE.PerspectiveCamera as `persp` (tests/film_runtime_camera.test.mjs pattern), a fake
// renderer, a fake entityManager with the pilot instance, a fake session handle. Frames
// are driven through `liveScene3d.film.preFrame(ts, dt)` / `postRender()`:
//   P1  the pure exports: readDroneFlags exact matching, validateSettingsPatch, mergeAnchors
//       order, jsonSafe, sessionKey / sessionMark / sessionChanged (Proxy-wrapped handle
//       stable, a new raw handle changed), filmBusy, readPilot, watchContextLoss;
//   P2  installDrone: idempotent (concurrent and later calls), window.__drone, no scene needed;
//   P3  the full cycle deploy → beats → flying → 120 flying frames → recall → landing → stow →
//       idle: ready() resolving frames after profile() (no clip before it, setRig gets the
//       profile on the first frame it is known, attach never refused), the tether clamp
//       gets home.pos (an array), the camera owned / written while flying, one
//       hb-drone-state event on document per transition (none on window, none at teardown),
//       a message:'state' entry per transition in debug.events(); afterwards the camera
//       released, liveScene3d.film deleted, the funnel gate reopened, listener counts at
//       baseline, the follow camera restored;
//   P4  wheel zoom keeps settings.fovDeg in [60, 110] and persists at most once per second;
//   P5  aborts through the real wiring: soft (damage via the deps.onSignal bus), hard (debug
//       trigger session), WebGL context loss, pagehide, film busy, rig lost / rebuilt; a
//       dispose() from inside an hb-drone-state listener (no later action runs on the cycle),
//       a deploy() from inside the 'idle' event (busy until the teardown ran);
//   P6  refusals (deps.refusal codes with the exact reasons, own not-in-world / busy checks),
//       settings validation + persistence, tune merge order, the cheat sheet once, the
//       broadcastPose setting, the funnel forwarding, pilot view framing;
//   P7  every method (bad arguments, after dispose) never throws and returns JSON-safe data;
//       a throwing sequence tears down through the emergency path (Ready for a held ReadState);
//   P8  the world link (real film runtime pieces): the §6.3 recipe, the §6.5 camera helpers
//       (the orbit restore sets camera.js's `_orbitRigStopped` latch), prewarm, lens, particles;
//   P9  the phase-3 fixes: a crash / forced landing near the ground rests on the BODY floor while
//       the camera keeps the eye floor; an FPV return (rth) clamps the craft with the body reflex
//       and the camera with a second eye clamp; the timer-place drop rule; the tablet arrow at
//       home; R / Tab / recall / pilotView in the cut window; the orphan film gate; film's shared
//       hooks survive a cycle; no Ready from the orbit restore after a death; H ends with the
//       input hand-back; no ReadState on a rebuilt rig after an abort; no deploy on a lost context;
//   P10 the phase-4 (1070) fixes: F1 the open-sky `covered` refusal over the real world link and a
//       fake handle of roof slabs (refused before T1 with nothing built past the link and nothing
//       left; the four columns' geometry; clutter, overhangs, bodies and doors never refuse; a pilot
//       on a platform; a throwing check fails open; the sweeps use the link's session-handle chain
//       and no handle reads as open sky) and F2 the slope drop (terrain + rest height for a pilot
//       on the terrain — the feet within 0.25 m of it —, foot level on a platform).
// The fake craft models manual_flight's floor-contact rest / landing (L1), so a craft clamped by
// the wrong reflex rests where that reflex holds it.
//
// Flag: `?drone`, DEFAULT ON since 2026-10-25 (`=off` disables it); `?droneDebug=on` adds `__drone.debug`.
// Run from apps/holtburger-web/: node tests/drone_api.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const IDX = await import("../scene3d/drone/index.js");
const GB = await import("../scene3d/film/core/gimbal.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      const msg = e && e.message ? String(e.message).split("\n")[0] : String(e);
      const at = e && e.stack ? (e.stack.split("\n").find((l) => l.includes("drone_api.test")) || "").trim() : "";
      console.log(`  [FAIL] ${name} — ${msg}${at ? ` (${at})` : ""}`);
    } finally {
      IDX._resetDroneForTest();
    }
  });
}

const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b} ± ${eps}, got ${a}`);
const roundTrip = (r, msg = "") => assert.deepEqual(JSON.parse(JSON.stringify(r)), r, `JSON-safe ${msg}`);
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// page fakes
// ---------------------------------------------------------------------------

/** An event target that counts listeners by type + capture flag and records dispatches. */
class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.dispatched = [];
  }
  _key(type, opts) {
    const capture = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
    return `${type}|${capture}`;
  }
  addEventListener(type, fn, opts) {
    const k = this._key(type, opts);
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k).add(fn);
  }
  removeEventListener(type, fn, opts) {
    const s = this.listeners.get(this._key(type, opts));
    if (s) s.delete(fn);
  }
  dispatchEvent(ev) {
    this.dispatched.push(ev);
    for (const [k, set] of this.listeners) {
      if (k.split("|")[0] !== ev.type) continue;
      for (const fn of [...set]) fn(ev);
    }
    return true;
  }
  count() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

const LBX = 0xa9 * 192;
const LBY = 0xb4 * 192;
const GROUND = 50;
const GUID = 0x50000001;
const HUMANOID = Object.freeze({ kind: "humanoid", rightHand: 15, leftHand: 12, head: 16, rightGrip: { partId: 15 }, leftGrip: { partId: 12 } });
const NO_HANDS = Object.freeze({ kind: "no-hands", rightHand: -1, leftHand: -1, head: -1, rightGrip: null, leftGrip: null });

/** CameraSwitcher stand-in (film_runtime_camera.test.mjs pattern). */
class FakeSwitcher {
  constructor(canvas) {
    this.persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    this.mode = "orbit";
    this.activeCamera = this.persp;
    this.followYaw = 1.25;
    this.followPitch = 0.3;
    this.followDistance = 6;
    this._prevEyeAc = { x: 1, y: 2, z: 3 };
    this._camFadeLastOpacity = 1;
    this._inHead = false;
    this._orbitRigStopped = false;
    this.readyDispatches = 0;
    this.keys = { w: false, a: false, s: false, d: false };
    this.domElement = canvas;
    this.calls = { position: 0, switchMode: [], fade: [] };
    this.getPlayerHeading = () => 0.4;
  }
  /**
   * camera.js _dispatchMovement's orbit branch, once per frame: orbit suppresses movement and
   * dispatches Ready ONCE on entering it (the `_orbitRigStopped` latch); every other mode
   * re-arms the latch.
   */
  tickMovement() {
    if (this.mode !== "orbit") {
      this._orbitRigStopped = false;
      return;
    }
    if (!this._orbitRigStopped) {
      this._orbitRigStopped = true;
      this.readyDispatches += 1; // setMotion(pilot, 0x41000003 Ready) in camera.js
    }
  }
  positionCamera() {
    this.calls.position += 1;
    this.persp.position.set(999, 999, 999);
  }
  switchMode(next) {
    this.calls.switchMode.push(next);
    this.mode = next;
    this._prevEyeAc = null;
  }
  getPlayerWorldPosition(out) {
    out.set(LBX + 100, GROUND + 1, -(LBY + 100));
    return out;
  }
  _applyCameraPlayerFade(o) {
    this.calls.fade.push(o);
    this._camFadeLastOpacity = o;
  }
  _endFollowDrag() {}
}

function makePilot(guid = GUID, setupId = 0x02000001, parts = 34) {
  return {
    guid,
    root: { position: { x: LBX + 100, y: LBY + 100, z: GROUND }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    parts: Array.from({ length: parts }, (_, i) => ({ name: `part_${i}` })),
    meta: { modelId: setupId },
  };
}

/** A fake input funnel: the one untagged fault slot. */
function makeFunnel() {
  return {
    _fault: null,
    installed: true,
    poisons: [],
    poison(mode = "throw") {
      this.poisons.push(mode);
      this._fault = mode;
    },
    unpoison() {
      this._fault = null;
    },
    releaseHeld() {},
    snapshot() {
      return { fault: this._fault, installed: this.installed };
    },
  };
}

/** Fake localStorage with a write log stamped by the fake clock. */
function makeStorage(clock, seed = {}) {
  const map = new Map(Object.entries(seed));
  const writes = [];
  return {
    map,
    writes,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      writes.push({ k, v, t: clock.t });
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}

/** The whole page: window, document, liveScene3d, session handle, clock, storage. */
function makeEnv(o = {}) {
  const clock = { t: 100 };
  const canvas = new FakeTarget();
  canvas.width = 1920;
  canvas.height = 1080;
  const cs = new FakeSwitcher(canvas);
  const pilot = makePilot(GUID, o.setupId ?? 0x02000001);
  const em = {
    entityMap: new Map([[GUID, pilot]]),
    spawnInFlight: new Map(),
    deathHeld: false,
    isDeathHeld() {
      return this.deathHeld;
    },
  };
  const sh = { terrainHeightAt: () => GROUND, isPlayerReady: () => true };
  const renderer = {
    domElement: canvas,
    renders: 0,
    info: { autoReset: true },
    autoClear: true,
    render() {
      this.renders += 1;
    },
    getRenderTarget() {
      return null;
    },
    setRenderTarget() {},
  };
  const audioManager = {
    resumed: 0,
    getEffectBus: () => null,
    resume() {
      this.resumed += 1;
      return Promise.resolve();
    },
  };
  const live = {
    scene: new THREE.Scene(),
    renderer,
    camera: cs.persp,
    cameraSwitcher: cs,
    entityManager: em,
    sessionHandle: sh,
    wasmExports: {},
    wireframeMode: false,
    audioManager,
    frameTime: { tsMs: 0, tsSec: 0, dt: 0 },
  };
  const win = new FakeTarget();
  Object.assign(win, {
    liveScene3d: live,
    __sessionHandle: sh,
    __bootState: "in-world",
    __inputFunnel: makeFunnel(),
    getLocalPlayerGuid: () => GUID,
    performance: { now: () => clock.t * 1000 },
    CustomEvent,
    location: { search: o.search ?? "?drone=on&droneDebug=on" },
  });
  const doc = new FakeTarget();
  doc.visibilityState = "visible";
  doc.defaultView = win;
  win.document = doc;
  const storage = makeStorage(clock, o.storageSeed);
  return { clock, canvas, cs, pilot, em, sh, renderer, live, win, doc, storage };
}

// ---------------------------------------------------------------------------
// other-lane fakes (SPEC §3 shapes, recording calls)
// ---------------------------------------------------------------------------

const DEFAULT_ANCHORS = Object.freeze({
  droneInHand: Object.freeze({ pos: Object.freeze([0.025, 0, -0.076]), quat: Object.freeze([0.707107, 0.707107, 0, 0]) }),
  tablet: Object.freeze({ pos: Object.freeze([-0.105, -0.035, -0.143]), quat: Object.freeze([-0.509, 0.062, -0.685, 0.518]) }),
  goggles: Object.freeze({ pos: Object.freeze([0, -0.10, 0.085]), quat: Object.freeze([1, 0, 0, 0]), scale: 1 }),
});
const DRONE_BODY = Object.freeze({ spanM: 0.32, restHeightM: 0.06, radiusM: 0.18 });
const CLIP_TIMING = { pack: { frames: 43, ev: 18 }, place: { frames: 50, ev: 18 }, goggles: { frames: 42, ev: 14 } };

/** Build the deps.modules fakes plus their recorder. */
function makeFakes(o = {}) {
  const R = {
    gestures: [], props: [], crafts: [], tethers: [], controls: [], osds: [], audios: [], prewarms: [],
    ctl: { frames: 0, profileFrame: o.profileFrame ?? 3, readyFrame: o.readyFrame ?? 8, profile: o.profile ?? HUMANOID,
      sticks: { throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0 } },
  };
  const modules = {
    DEFAULT_ANCHORS,
    DRONE_BODY,
    prewarmProps(deps) {
      R.prewarms.push(deps);
      return Promise.resolve({ ok: true, compiled: 3, ms: 1 });
    },
    createGestureDriver(deps) {
      const ctl = R.ctl;
      let resolveReady;
      const readyP = new Promise((r) => {
        resolveReady = r;
      });
      const g = {
        deps,
        calls: [],
        job: null,
        held: null,
        firstClipFrame: null,
        readyResolvedFrame: null,
        pollOut: { active: false, name: null, event: false, done: false, rigChanged: false },
        ready() {
          this.calls.push(["ready"]);
          return readyP;
        },
        profile() {
          return ctl.frames >= ctl.profileFrame ? ctl.profile : null;
        },
        clip(name, speed) {
          this.calls.push(["clip", name, speed]);
          if (this.firstClipFrame === null) this.firstClipFrame = ctl.frames;
          const c = CLIP_TIMING[name];
          if (!c) return { ok: false, mode: null, name };
          this.job = { name, t: 0, ev: false, evAt: c.ev / 30 / speed, doneAt: c.frames / 30 / speed };
          return { ok: true, mode: "timer", name };
        },
        poll(dt) {
          ctl.frames += 1;
          if (ctl.frames === ctl.readyFrame) {
            this.readyResolvedFrame = ctl.frames;
            resolveReady({ ok: true, profile: ctl.profile, clips: { pack: false, place: false, goggles: false } });
          }
          const p = this.pollOut;
          p.event = false;
          p.done = false;
          p.rigChanged = false;
          const j = this.job;
          if (j && dt > 0) {
            j.t += dt;
            if (!j.ev && j.t >= j.evAt) {
              j.ev = true;
              p.event = true;
            }
            if (j.t >= j.doneAt) {
              if (!j.ev) p.event = true;
              p.done = true;
              this.job = null;
            }
          }
          p.active = this.job !== null;
          p.name = this.job ? this.job.name : null;
          return p;
        },
        stop() {
          this.calls.push(["stop"]);
          this.job = null;
          return true;
        },
        hold(cmd, speed) {
          this.calls.push(["hold", cmd, speed]);
          this.held = cmd;
          return Promise.resolve();
        },
        release() {
          this.calls.push(["release"]);
          this.held = null;
          return Promise.resolve();
        },
        watches: 0,
        watch() {
          this.watches += 1;
          return false;
        },
        hideWielded(on) {
          this.calls.push(["hideWielded", on]);
          return 0;
        },
        applied: 0,
        applyWielded() {
          this.applied += 1;
          return 0;
        },
        rebind(inst) {
          this.calls.push(["rebind", inst && inst.guid]);
          this.job = null;
        },
        clipParity() {
          return Promise.resolve({ ok: true, setupId: "0x02000001", clips: { pack: { built: false, flags: 0, maxPosErr: 0, maxQuatErr: 0 } } });
        },
        disposed: 0,
        dispose() {
          this.disposed += 1;
          this.job = null;
        },
      };
      R.gestures.push(g);
      return g;
    },
    createProps(deps) {
      assert.ok(deps.THREE && deps.scene, "createProps gets THREE and the scene");
      const p = {
        deps,
        calls: [],
        rig: null,
        at: { drone: "none", tablet: "none", goggles: "none" },
        visible: { drone: true, tablet: true, goggles: true },
        dronePos: [0, 0, 0],
        fade: null,
        poses: 0,
        rotorT: null,
        lastSpin: 0,
        screens: 0,
        disposed: 0,
        rigFrames: [],
        setRig(rig) {
          this.calls.push(["setRig", rig && rig.profile ? rig.profile.kind : null]);
          this.rigFrames.push(R.ctl.frames); // gestures.poll() count when setRig ran
          this.rig = rig;
        },
        setAnchors(a) {
          this.calls.push(["setAnchors", a]);
        },
        attach(name, anchor) {
          if (!this.rig || !this.rig.profile || this.rig.profile.kind !== "humanoid") {
            this.calls.push(["attach-refused", name]);
            return false;
          }
          this.calls.push(["attach", name, anchor]);
          this.at[name] = "rig";
          return true;
        },
        toWorld(name, groundZ, yaw) {
          this.calls.push(["toWorld", name, groundZ, yaw]);
          const hand = [LBX + 100, LBY + 100.72, groundZ];
          this.at[name] = "world";
          this.dronePos = [hand[0], hand[1], groundZ + 0.06];
          return { ok: true, pos: this.dronePos.slice() };
        },
        place(name, pos, yaw) {
          this.calls.push(["place", name, pos.slice(), yaw]);
          this.at[name] = "world";
          this.dronePos = pos.slice();
          return true;
        },
        remove(name) {
          this.calls.push(["remove", name]);
          this.at[name] = "none";
          if (name === "drone") this.fade = null;
          return true;
        },
        where(name) {
          return this.at[name] ?? "none";
        },
        worldPos(name, out) {
          if (this.at[name] === "none") return null;
          out[0] = LBX + 100;
          out[1] = LBY + 100.72;
          out[2] = GROUND + 0.1;
          return out;
        },
        setDronePose(pos) {
          if (this.at.drone !== "world") return false;
          this.dronePos[0] = pos[0];
          this.dronePos[1] = pos[1];
          this.dronePos[2] = pos[2];
          this.poses += 1;
          return true;
        },
        setVisible(name, on) {
          this.calls.push(["setVisible", name, on]);
          this.visible[name] = on;
        },
        setRotor(spin, t) {
          this.lastSpin = spin;
          this.rotorT = t;
          if (this.fade && t >= this.fade.end) {
            this.fade = null;
            this.at.drone = "none";
          }
        },
        setGround() {},
        screenLog: [],
        setScreen(s) {
          this.screens += 1;
          this.screenLog.push({ ...s, frame: R.ctl.frames }); // a copy: NaN survives (no JSON)
          return false;
        },
        fadeOut(name, { delaySec = 0, durationSec = 1, now } = {}) {
          this.calls.push(["fadeOut", name, delaySec, durationSec]);
          this.fade = { end: now + delaySec + durationSec };
          return true;
        },
        fading(name) {
          return name === "drone" && this.fade !== null;
        },
        stats() {
          return { meshes: 0, geometries: 0, materials: 0, textures: 0, built: true };
        },
        dispose() {
          this.disposed += 1;
          return { ok: true, disposed: { geometries: 0, materials: 0, textures: 0 } };
        },
      };
      R.props.push(p);
      return p;
    },
    createManualCraft(deps) {
      const c = new FakeCraft(deps);
      R.crafts.push(c);
      return c;
    },
    createTether(opts) {
      const t = {
        opts,
        homes: [],
        calls: [],
        battery: 1,
        out: { pos: [0, 0, 0], signal: 1, limited: false, kind: null, normal: null, distM: 0 },
        clamp(pos, home, groundZ) {
          if (this.homes.length < 5 || !Array.isArray(home)) this.homes.push({ isArray: Array.isArray(home), home: Array.isArray(home) ? home.slice() : home, groundZ });
          const o2 = this.out;
          o2.pos[0] = pos[0];
          o2.pos[1] = pos[1];
          o2.pos[2] = pos[2];
          o2.distM = Math.hypot(pos[0] - home[0], pos[1] - home[1], pos[2] - home[2]);
          o2.signal = 1;
          return o2;
        },
        drainOut: { battery: 1, warn: false, rth: false, empty: false },
        drain(dt, throttle) {
          const sec = this.opts.batterySec;
          const o2 = this.drainOut;
          if (!(sec > 0)) {
            o2.battery = 1;
            return o2;
          }
          this.battery = Math.max(0, this.battery - (dt / sec) * (0.6 + 0.4 * Math.min(Math.max(throttle, 0), 2.5)));
          o2.battery = this.battery;
          o2.warn = this.battery <= 0.2;
          o2.empty = this.battery <= 0;
          return o2;
        },
        planReturn(from, home, opts2) {
          this.calls.push(["planReturn", from, home, opts2]);
          const cruiseZ = Math.max(from[2], (opts2.groundZFrom ?? home[2]) + opts2.cruiseAglM, (opts2.groundZHome ?? home[2]) + opts2.cruiseAglM);
          const points = [from.slice(), [from[0], from[1], cruiseZ], [home[0], home[1], cruiseZ], home.slice()];
          let L = 0;
          for (let k = 1; k < points.length; k += 1) L += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1], points[k][2] - points[k - 1][2]);
          return { points, lengthM: L, cruiseZ };
        },
        configure(o2) {
          this.calls.push(["configure", o2]);
        },
        reset() {},
        state() {
          return { rangeM: 150, ceilingAglM: 120, batterySec: this.opts.batterySec, battery: this.battery, rthFired: false };
        },
      };
      R.tethers.push(t);
      return t;
    },
    createControls(deps) {
      const c = {
        deps,
        calls: [],
        locked: false,
        pointerLocked: false,
        phase: null,
        listeners: [],
        fns: new Set(),
        funnelRef: null,
        didPoison: false,
        onKey: () => {},
        lock() {
          this.calls.push(["lock"]);
          if (this.locked) return { ok: true, already: true, steps: {} };
          const f = deps.funnel ?? deps.window.__inputFunnel;
          this.funnelRef = f;
          if (f && f._fault === null) {
            f.poison("gate");
            this.didPoison = true;
          }
          for (const t of ["keydown", "keyup"]) deps.window.addEventListener(t, this.onKey, { capture: true });
          this.locked = true;
          return { ok: true, already: false, steps: {} };
        },
        restore() {
          this.calls.push(["restore"]);
          if (!this.locked) return { ok: true, wasLocked: false, steps: {} };
          const f = this.funnelRef;
          // The real controls' funnel step shape: `unpoisoned` = our own gate was released here.
          let funnel = { ok: true, skipped: "no funnel was locked" };
          if (f && !this.didPoison) funnel = { ok: true, unpoisoned: false, prevFault: f._fault };
          else if (f && f._fault === "gate") {
            f.unpoison();
            funnel = { ok: true, unpoisoned: true };
          } else if (f) funnel = { ok: true, unpoisoned: false, changedBy: "someone else" };
          this.didPoison = false;
          for (const t of ["keydown", "keyup"]) deps.window.removeEventListener(t, this.onKey, { capture: true });
          this.locked = false;
          return { ok: true, wasLocked: true, steps: { funnel } };
        },
        setPhase(p) {
          this.calls.push(["setPhase", p]);
          this.phase = p;
          return p;
        },
        sticks: { throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0 },
        polls: 0,
        poll() {
          this.polls += 1;
          Object.assign(this.sticks, R.ctl.sticks);
          return this.sticks;
        },
        onAction(fn) {
          this.fns.add(fn);
          return () => this.fns.delete(fn);
        },
        fire(type) {
          for (const fn of [...this.fns]) fn({ type, source: "keyboard" });
        },
        status() {
          return { locked: this.locked, phase: this.phase, pointerLocked: false, draining: false, source: "keyboard", gamepad: false,
            held: [], blocked: 0, actions: 0, lockRequests: 0, lockErrors: 0, drained: 0, funnelInstalled: true };
        },
        disposed: 0,
        dispose() {
          this.disposed += 1;
          const r = this.restore();
          this.fns.clear();
          return r;
        },
      };
      R.controls.push(c);
      return c;
    },
    createOsd(deps) {
      const o2 = {
        deps,
        shows: [],
        updates: 0,
        frames: 0,
        statics: [],
        cheats: [],
        cleans: [],
        lastView: null,
        disposed: 0,
        show(mode, opts) {
          this.shows.push(opts === undefined ? [mode] : [mode, opts]);
          return true;
        },
        update(v) {
          this.updates += 1;
          this.lastView = JSON.parse(JSON.stringify(v));
        },
        frame() {
          this.frames += 1;
        },
        staticLevel(s) {
          if (this.statics.length < 3) this.statics.push(s);
          return 0;
        },
        cheatSheet(show) {
          this.cheats.push(show);
          return true;
        },
        clean(on) {
          this.cleans.push(on);
          return on;
        },
        dispose() {
          this.disposed += 1;
        },
      };
      R.osds.push(o2);
      return o2;
    },
    createDroneAudio(deps) {
      const a = {
        deps,
        started: 0,
        updates: 0,
        stops: [],
        disposed: 0,
        lastUpdate: null,
        start() {
          this.started += 1;
          if (typeof deps.bus === "function") deps.bus();
          return false;
        },
        update(u) {
          this.updates += 1;
          this.lastUpdate = { ...u, pos: u.pos ? [...u.pos] : null };
        },
        stop(o3) {
          this.stops.push(o3);
        },
        dispose() {
          this.disposed += 1;
        },
        get active() {
          return false;
        },
        stats() {
          return { built: false, started: false, nodes: 0 };
        },
      };
      R.audios.push(a);
      return a;
    },
  };
  return { modules, R };
}

/** A kinematic stand-in for manual_flight's ManualCraft (CraftFrame shape of SPEC §3.3). */
class FakeCraft {
  constructor(deps) {
    this.deps = deps;
    this.mode = deps.mode;
    this.calls = [];
    this.plan = null;
    this.planT = 0;
    this.landed = false;
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.h = 0;
    this.done = false;
    this.distTD = null;
    this.impact = 0;
    this.steps = 0;
    this.lastStep = null;
    this.contacts = []; // {z, plan, floor} of every contact() call
    const q = [1, 0, 0, 0];
    this.f = { t: 0, pos: this.pos, vel: this.vel, speed: 0, body: { h: 0, p: 0, r: 0, q }, cam: { t: 0, pos: this.pos, h: 0, p: 0, r: 0, q, fov: 75 },
      throttle: 0, landed: false, autopilot: null, autopilotDone: false, distTouchdownM: null };
  }
  out() {
    const f = this.f;
    f.speed = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
    f.body.h = this.h;
    f.cam.h = this.h;
    f.body.q[0] = Math.cos(this.h / 2);
    f.body.q[3] = -Math.sin(this.h / 2);
    f.throttle = this.landed ? 0 : 1;
    f.landed = this.landed;
    f.autopilot = this.plan ? this.plan.kind : null;
    f.autopilotDone = this.done;
    f.distTouchdownM = this.distTD;
    return f;
  }
  reset(pose, opts = {}) {
    this.calls.push(["reset", pose.pos.slice(), pose.h, opts.landed === true]);
    for (let k = 0; k < 3; k += 1) this.pos[k] = pose.pos[k];
    this.vel.fill(0);
    this.h = pose.h;
    this.landed = opts.landed === true;
    this.plan = null;
    this.done = false;
    this.distTD = null;
    return this.out();
  }
  step(input) {
    this.steps += 1;
    this.lastStep = { dt: input.dt, groundZ: input.groundZ, fovDeg: input.fovDeg, pitch: input.sticks.pitch };
    const dt = input.dt;
    if (!(dt > 0)) return this.out();
    const P = this.plan;
    const prev = this.pos.slice();
    if (P && P.kind === "liftoff") {
      this.planT += dt;
      const tau = Math.min(this.planT / P.durationSec, 1);
      const s = tau * tau * tau * (10 - 15 * tau + 6 * tau * tau);
      for (let k = 0; k < 3; k += 1) this.pos[k] = P.from[k] + (P.to[k] - P.from[k]) * s;
      this.done = tau >= 1;
      this.landed = false;
      this.h = P.heading;
    } else if (P && (P.kind === "rth" || P.kind === "land") && !this.landed) {
      const pts = P.kind === "rth" ? P.path.points : [this.pos.slice(), P.at];
      if (!this.cursor) this.cursor = { i: 1 };
      let budget = (P.kind === "rth" ? 10 : 2) * dt;
      while (budget > 0 && this.cursor.i < pts.length) {
        const tgt = pts[this.cursor.i];
        const d = Math.hypot(tgt[0] - this.pos[0], tgt[1] - this.pos[1], tgt[2] - this.pos[2]);
        if (d <= budget) {
          for (let k = 0; k < 3; k += 1) this.pos[k] = tgt[k];
          budget -= d;
          this.cursor.i += 1;
        } else {
          for (let k = 0; k < 3; k += 1) this.pos[k] += ((tgt[k] - this.pos[k]) / d) * budget;
          budget = 0;
        }
      }
      let rem = 0;
      let a = this.pos;
      for (let k = this.cursor.i; k < pts.length; k += 1) {
        rem += Math.hypot(pts[k][0] - a[0], pts[k][1] - a[1], pts[k][2] - a[2]);
        a = pts[k];
      }
      this.distTD = rem;
      if (rem < 1e-9) {
        this.landed = true;
        this.done = true;
      }
    } else if (P && P.kind === "crash") {
      if (!this.landed) {
        const floor = (input.groundZ ?? GROUND) + 0.06;
        this.pos[2] = Math.max(floor, this.pos[2] - 5 * dt);
        if (this.pos[2] <= floor) this.landed = true;
      }
    } else if (!P) {
      const s = input.sticks;
      if (!(this.landed && s.throttle <= 0.1)) {
        this.landed = false;
        this.pos[0] += s.roll * 10 * dt;
        this.pos[1] += s.pitch * 10 * dt;
        this.pos[2] += s.throttle * 4 * dt;
      }
    }
    for (let k = 0; k < 3; k += 1) this.vel[k] = (this.pos[k] - prev[k]) / dt;
    return this.out();
  }
  contact(hits, clampedPos) {
    const P = this.plan;
    if (!P || P.kind !== "liftoff") for (let k = 0; k < 3; k += 1) this.pos[k] = clampedPos[k];
    if (this.contacts.length < 4000) this.contacts.push({ z: clampedPos[2], plan: P ? P.kind : null, floor: hits.some((h) => h.layer === "terrain-floor") });
    // manual_flight's floor contact (L1): a floor-like hit at a low speed rests a crash, and lands a
    // rth / land plan on its last finalM + 0.5 m, wherever the clamp holds the craft.
    if (!this.landed && P && P.kind !== "liftoff" && P.kind !== "hold"
      && hits.some((h) => h.layer !== "tether" && h.normal && h.normal[2] >= 0.7)) {
      if (this.vel[2] < 0) this.vel[2] = 0; // the floor takes the into-surface velocity
      const sp = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
      if (sp < 0.3 && (P.kind === "crash" || ((P.kind === "rth" || P.kind === "land") && this.distTD !== null && this.distTD <= 2))) {
        this.landed = true;
        this.done = true;
        this.f.landed = true;
        this.f.autopilotDone = true;
      }
    }
    return { impactSpeed: this.impact };
  }
  setMode(m) {
    this.calls.push(["setMode", m]);
    this.mode = m;
    return m;
  }
  setRates(r) {
    this.calls.push(["setRates", r]);
  }
  autopilot(plan) {
    this.calls.push(["autopilot", plan ? plan.kind : null, plan ? JSON.parse(JSON.stringify(plan)) : null]);
    this.plan = plan;
    this.planT = 0;
    this.cursor = null;
    this.done = false;
    if (!plan) this.distTD = null;
    return { ok: true, kind: plan ? plan.kind : null };
  }
  state() {
    return { mode: this.mode, pos: this.pos.slice(), landed: this.landed };
  }
}

/** Install with the fakes; returns everything. */
async function setup(o = {}) {
  const env = makeEnv(o);
  const { modules, R } = makeFakes(o);
  const logs = [];
  const sinks = new Set();
  const deps = {
    window: env.win,
    document: env.doc,
    THREE,
    clock: () => env.clock.t,
    search: o.search ?? "?drone=on&droneDebug=on",
    storage: env.storage,
    fetchJson: o.fetchJson ?? (async () => ({ version: 1, profiles: {} })),
    log: (e) => logs.push(e),
    modules: { ...modules, ...(o.modules || {}) },
    ...(o.withBus === false ? {} : { onSignal: (fn) => { sinks.add(fn); return () => sinks.delete(fn); } }),
    ...(o.deps || {}),
  };
  const api = await IDX.installDrone(deps);
  return { ...env, R, api, logs, sinks, deps };
}

/** One frame through the film hooks (preFrame then postRender) and camera.js's movement tick, then a microtask flush. */
async function frame(E, dt = 1 / 60) {
  E.clock.t += dt;
  const ts = E.clock.t * 1000;
  E.live.frameTime = { tsMs: ts, tsSec: ts / 1000, dt };
  const hooks = E.live.film;
  if (hooks) {
    hooks.preFrame(ts, dt);
    hooks.postRender();
  }
  E.cs.tickMovement();
  await flush();
}

async function frames(E, n, dt = 1 / 60) {
  for (let k = 0; k < n; k += 1) await frame(E, dt);
}

async function untilState(E, s, maxFrames = 3000, dt = 1 / 60) {
  for (let k = 0; k < maxFrames; k += 1) {
    if (E.api.status().state === s) return k;
    await frame(E, dt);
  }
  throw new Error(`state ${s} not reached (at ${E.api.status().state})`);
}

const stateEvents = (target) => target.dispatched.filter((e) => e.type === "hb-drone-state").map((e) => e.detail);

// ---------------------------------------------------------------------------
// P1 pure exports
// ---------------------------------------------------------------------------

check("P1 readDroneFlags: exact '=== \"on\"' for droneDebug, exact '=== \"off\"' for droneAudio, never throws", () => {
  assert.deepEqual(IDX.readDroneFlags("?droneDebug=on"), { debug: true, audio: true });
  assert.deepEqual(IDX.readDroneFlags("?droneAudio=off"), { debug: false, audio: false });
  assert.deepEqual(IDX.readDroneFlags("?a=1&droneDebug=on&droneAudio=off"), { debug: true, audio: false });
  for (const s of ["", "?droneDebug", "?droneDebug=1", "?droneDebug=true", "?droneDebug=ON", "?droneDebug=off", "?xdroneDebug=on"]) {
    assert.equal(IDX.readDroneFlags(s).debug, false, s);
  }
  for (const s of ["", "?droneAudio", "?droneAudio=0", "?droneAudio=false", "?droneAudio=OFF", "?droneAudio=on"]) {
    assert.equal(IDX.readDroneFlags(s).audio, true, s);
  }
  assert.deepEqual(IDX.readDroneFlags(undefined), { debug: false, audio: true });
  assert.deepEqual(IDX.readDroneFlags(null), { debug: false, audio: true });
  assert.deepEqual(IDX.readDroneFlags(new URLSearchParams("droneDebug=on")), { debug: true, audio: true });
  const bad = { toString() { throw new Error("boom"); } };
  assert.deepEqual(IDX.readDroneFlags(bad), { debug: false, audio: true });
  assert.equal(IDX.DRONE_API_VERSION, "drone-1");
});

check("P1 validateSettingsPatch: every rule type, one bad key refuses the whole patch", () => {
  const D = IDX.DRONE_SETTINGS_DEFAULTS;
  assert.deepEqual(Object.keys(D).sort(), Object.keys(IDX.SETTINGS_RULES).sort());
  assert.ok(Object.isFrozen(D) && Object.isFrozen(IDX.SETTINGS_RULES) && Object.isFrozen(IDX.DRONE_REFUSAL_REASONS));
  assert.deepEqual({ ...D }, { mode: "cine", sensitivity: 1.0, invertY: false, gamepadLayout: "mode2", acroRc: 1.0, acroSuper: 0.7, acroExpo: 0,
    rangeM: 150, ceilingAglM: 120, batteryMin: 10, crash: true, crashMps: 7, quickDeploy: false, launchFacing: "pilot", broadcastPose: false,
    volume: 0.6, fovDeg: 75 });
  for (const [k, v] of Object.entries(D)) assert.equal(IDX.validateSettingsPatch({ [k]: v }).ok, true, `default ${k}`);
  const ok = IDX.validateSettingsPatch({ mode: "acro", sensitivity: 5, rangeM: 20, batteryMin: 0, invertY: true, fovDeg: 110 });
  assert.deepEqual(ok, { ok: true, value: { mode: "acro", sensitivity: 5, rangeM: 20, batteryMin: 0, invertY: true, fovDeg: 110 } });
  const bads = [{ mode: "turbo" }, { sensitivity: 0.05 }, { sensitivity: "1" }, { invertY: 1 }, { gamepadLayout: "mode3" }, { acroSuper: 0.96 },
    { rangeM: 181 }, { ceilingAglM: 9 }, { batteryMin: 61 }, { crashMps: NaN }, { volume: Infinity }, { fovDeg: 59 }, { launchFacing: "up" },
    { nope: 1 }, { mode: "cine", volume: 2 }];
  for (const b of bads) {
    const r = IDX.validateSettingsPatch(b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.equal(r.code, "bad-argument");
    assert.equal(typeof r.reason, "string");
  }
  for (const b of [null, undefined, 5, "x", []]) assert.equal(IDX.validateSettingsPatch(b).ok, false);
  assert.deepEqual(IDX.validateSettingsPatch({}), { ok: true, value: {} });
});

check("P1 mergeAnchors: local > profile > defaults per anchor per field; source = highest layer; quats normalised", () => {
  const def = IDX.mergeAnchors(DEFAULT_ANCHORS, null, undefined);
  assert.equal(def.source, "default");
  assert.equal(def.clipMode, null);
  assert.deepEqual(def.tablet, { pos: [-0.105, -0.035, -0.143], quat: [-0.509, 0.062, -0.685, 0.518] }, "defaults copied as given");
  assert.deepEqual(def.goggles.scale, 1);
  const prof = { tablet: { pos: [1, 2, 3] }, clipMode: "timer" };
  const local = { tablet: { quat: [0, 0, 0, 2] }, goggles: { scale: 1.2, pos: [1, 2] } };
  const m = IDX.mergeAnchors(DEFAULT_ANCHORS, prof, local);
  assert.equal(m.source, "local");
  assert.deepEqual(m.tablet, { pos: [1, 2, 3], quat: [0, 0, 0, 1] });
  assert.deepEqual(m.goggles, { pos: [0, -0.10, 0.085], quat: [1, 0, 0, 0], scale: 1.2 }, "an invalid local pos falls back");
  assert.deepEqual(m.droneInHand, { pos: [0.025, 0, -0.076], quat: [0.707107, 0.707107, 0, 0] });
  assert.equal(m.clipMode, "timer");
  const p = IDX.mergeAnchors(DEFAULT_ANCHORS, prof, {});
  assert.equal(p.source, "profile");
  assert.equal(IDX.mergeAnchors(DEFAULT_ANCHORS, {}, { clipMode: "clip" }).source, "local", "clipMode alone counts");
  assert.equal(IDX.mergeAnchors(DEFAULT_ANCHORS, { tablet: { quat: [0, 0, 0, 0] } }, null).source, "default", "a zero quat is invalid");
  roundTrip(m);
});

check("P1 jsonSafe: NaN/±Infinity → null, −0 → 0, typed arrays, Map/Set, functions / undefined dropped, cycles → null", () => {
  const cyc = { a: 1 };
  cyc.self = cyc;
  const shared = { s: 1 };
  const v = IDX.jsonSafe({ n: NaN, i: -Infinity, z: -0, f: () => 1, u: undefined, t: new Float32Array([1.5, NaN]), m: new Map([["k", 1]]),
    s: new Set([1, 2]), arr: [undefined, () => 0, 3], c: cyc, sh: [shared, shared], b: 10n, d: { toJSON() { return { j: 1 }; } } });
  assert.deepEqual(v, { n: null, i: null, z: 0, t: [1.5, null], m: { k: 1 }, s: [1, 2], arr: [null, null, 3], c: { a: 1, self: null },
    sh: [{ s: 1 }, { s: 1 }], b: 10, d: { j: 1 } });
  assert.ok(Object.is(IDX.jsonSafe(-0), 0));
  roundTrip(v);
  assert.equal(IDX.jsonSafe(undefined), null);
});

check("P1 sessionKey / sessionMark / sessionChanged: a Proxy-wrapped handle is stable, a new raw handle is a change", () => {
  const RAW = Symbol.for("holtburger.rawSessionHandle");
  const raw = { name: "raw" };
  const wrapped = new Proxy(raw, { get(t, k) { return k === RAW ? t : Reflect.get(t, k); } });
  const doubly = new Proxy(wrapped, { get(t, k) { return k === RAW ? t : Reflect.get(t, k); } });
  assert.equal(IDX.sessionKey(wrapped), raw);
  assert.equal(IDX.sessionKey(doubly), raw);
  assert.equal(IDX.sessionKey(raw), raw);
  assert.equal(IDX.sessionKey(null), null);
  const win = { __sessionHandle: raw, getLocalPlayerGuid: () => GUID, __bootState: "in-world" };
  const mark = IDX.sessionMark(win);
  assert.deepEqual(mark, { key: raw, guid: GUID, discTs: 0 });
  win.__sessionHandle = doubly;
  assert.equal(IDX.sessionChanged(win, mark), false, "the rejection_feedback Proxy is the same session");
  win.__bootState = "ready";
  assert.equal(IDX.sessionChanged(win, mark), false, "'ready' and 'in-world' both count");
  win.__sessionHandle = { name: "reconnected" };
  assert.equal(IDX.sessionChanged(win, mark), true, "a new raw handle");
  win.__sessionHandle = null;
  assert.equal(IDX.sessionChanged(win, mark), true, "pagehide nulls it");
  win.__sessionHandle = raw;
  win.getLocalPlayerGuid = () => GUID + 1;
  assert.equal(IDX.sessionChanged(win, mark), true, "another character");
  win.getLocalPlayerGuid = () => GUID;
  win.__hbLoggingOff = true;
  assert.equal(IDX.sessionChanged(win, mark), true, "/logout");
  win.__hbLoggingOff = false;
  win.__lastDisconnect = { ts: 5 };
  assert.equal(IDX.sessionChanged(win, mark), true, "a new disconnect");
  win.__lastDisconnect = undefined;
  win.__bootState = "char-select";
  assert.equal(IDX.sessionChanged(win, mark), true, "left in-world");
});

check("P1 filmBusy, readPilot (compass = −root yaw), watchContextLoss (add / remove, throwing callbacks contained)", () => {
  assert.equal(IDX.filmBusy({}), false);
  assert.equal(IDX.filmBusy({ __film: { status: () => ({ ok: true, active: false, cameraOwned: false, clean: false, take: { running: null } }) } }), false);
  assert.equal(IDX.filmBusy({ __film: { status: () => ({ ok: true, active: false, take: { running: { mode: "realtime" } } }) } }), true);
  assert.equal(IDX.filmBusy({ __film: { status: () => ({ ok: true, cameraOwned: true }) } }), true);
  assert.equal(IDX.filmBusy({ __film: { status: () => ({ ok: false, active: true }) } }), false);
  assert.equal(IDX.filmBusy({ __film: { status: () => { throw new Error("x"); } } }), false);
  assert.equal(IDX.filmBusy(null), false);
  const pilot = makePilot();
  const yaw = 0.5;
  pilot.root.quaternion = { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
  const live = { entityManager: { entityMap: new Map([[GUID, pilot]]) } };
  const out = { x: 0, y: 0, z: 0, compass: 0 };
  assert.equal(IDX.readPilot(live, { getLocalPlayerGuid: () => GUID }, out), pilot);
  near(out.compass, -yaw, 1e-12);
  assert.equal(out.x, LBX + 100);
  assert.equal(IDX.readPilot(live, { getLocalPlayerGuid: () => 7 }, out), null);
  assert.equal(IDX.readPilot(live, {}, out), null);
  const c = new FakeTarget();
  let lost = 0;
  let restored = 0;
  const off = IDX.watchContextLoss(c, () => { lost += 1; throw new Error("contained"); }, () => { restored += 1; });
  assert.equal(c.count(), 2);
  c.dispatchEvent({ type: "webglcontextlost" });
  c.dispatchEvent({ type: "webglcontextrestored" });
  assert.equal(lost, 1);
  assert.equal(restored, 1);
  off();
  assert.equal(c.count(), 0);
  assert.equal(typeof IDX.watchContextLoss(null, () => {}), "function");
});

// ---------------------------------------------------------------------------
// P2 install
// ---------------------------------------------------------------------------

check("P2 installDrone: idempotent (concurrent + later calls), window.__drone, settings work without a scene", async () => {
  const env = makeEnv();
  const { modules } = makeFakes();
  const deps = { window: env.win, document: env.doc, THREE, clock: () => env.clock.t, storage: env.storage, modules, search: "", fetchJson: async () => null };
  const [a, b] = await Promise.all([IDX.installDrone(deps), IDX.installDrone({ ...deps, search: "?droneDebug=on" })]);
  assert.equal(a, b);
  const c = await IDX.installDrone({});
  assert.equal(c, a, "later deps ignored");
  assert.equal(env.win.__drone, a);
  assert.equal(a.version, "drone-1");
  assert.equal(a.debug, undefined, "no ?droneDebug=on → no debug member");
  env.win.liveScene3d = null;
  const s = a.settings();
  assert.equal(s.ok, true);
  assert.deepEqual(s.defaults, { ...IDX.DRONE_SETTINGS_DEFAULTS });
  assert.equal(a.setSettings({ volume: 0.2 }).ok, true);
  assert.equal(a.deploy().code, "not-in-world");
  const st = a.status();
  assert.equal(st.state, "idle");
  assert.equal(st.flags.signals, "levels-only");
  roundTrip(st);
  // A failing default import rejects and clears the memo (the next call retries).
  IDX._resetDroneForTest();
  const broken = { ...modules };
  delete broken.createOsd;
  // ./osd.js is another lane's file: when it is missing (or broken) the import rejects.
  let rejected = false;
  try {
    await IDX.installDrone({ ...deps, modules: { ...broken, createOsd: undefined } });
  } catch (_) {
    rejected = true;
  }
  assert.equal(rejected, true, "a factory that is not a function rejects installDrone");
  const again = await IDX.installDrone(deps);
  assert.equal(typeof again.deploy, "function", "the memo was cleared");
});

// ---------------------------------------------------------------------------
// P3 the full cycle
// ---------------------------------------------------------------------------

check("P3 deploy → beats → flying → 120 flying frames → recall → landing → stow → idle; everything handed back", async () => {
  const E = await setup();
  const { api, live, cs, win, doc, canvas, R } = E;
  const base = { win: win.count(), doc: doc.count(), canvas: canvas.count() };
  assert.equal(live.film, undefined, "no hooks before deploy");
  const r = api.deploy();
  assert.deepEqual(r, { ok: true, state: "deploying", quick: false });
  roundTrip(r);
  assert.ok(live.film && typeof live.film.preFrame === "function", "camera owner installed the film hooks");
  assert.equal(win.__inputFunnel._fault, "gate", "the fake controls poisoned the funnel they resolved");
  assert.equal(cs.mode, "follow", "prepareFollowCamera left orbit");
  assert.equal(R.prewarms.length, 1);
  assert.equal(R.prewarms[0].offscreen, true);
  assert.equal(R.prewarms[0].renderer, live.renderer);
  assert.equal(live.audioManager.resumed, 1, "the resume fallback ran inside the deploy");
  assert.equal(R.audios[0].started, 1);
  const g = R.gestures[0];
  const p = R.props[0];
  assert.deepEqual(p.calls[0], ["setRig", null], "setRig at deploy, profile unknown yet");
  assert.deepEqual(g.calls.find((c) => c[0] === "hideWielded"), ["hideWielded", true]);
  await untilState(E, "flying", 1500);
  // ready() resolved several frames after profile() was known: no clip before it.
  assert.equal(g.readyResolvedFrame, R.ctl.readyFrame);
  assert.ok(g.firstClipFrame > g.readyResolvedFrame, `first clip at frame ${g.firstClipFrame}, ready at ${g.readyResolvedFrame}`);
  const setRigs = p.calls.filter((c) => c[0] === "setRig");
  assert.deepEqual(setRigs, [["setRig", null], ["setRig", "humanoid"]], "setRig with the profile on the first frame it is known");
  assert.deepEqual(p.rigFrames, [0, R.ctl.profileFrame], "at deploy (no frame yet), then on the frame profile() first answers");
  assert.equal(p.calls.some((c) => c[0] === "attach-refused"), false, "no attach before the profile reached props");
  assert.deepEqual(p.calls.filter((c) => c[0] === "attach").map((c) => c[1]), ["drone", "goggles", "tablet"]);
  assert.equal(p.calls.filter((c) => c[0] === "toWorld").length, 1, "the drone left the hand onto the ground");
  assert.deepEqual(g.calls.filter((c) => c[0] === "clip").map((c) => c[1]), ["pack", "place", "goggles"]);
  assert.deepEqual(g.calls.find((c) => c[0] === "hold"), ["hold", 0x43000146, 1]);
  const craft = R.crafts[0];
  const lift = craft.calls.find((c) => c[0] === "autopilot" && c[1] === "liftoff")[2];
  near(lift.durationSec, 2.2, 1e-12);
  near(lift.to[2] - lift.from[2], 1.7, 1e-9, "rise");
  near(Math.hypot(lift.to[0] - lift.from[0], lift.to[1] - lift.from[1]), 3.4, 1e-9, "back off");
  assert.deepEqual(lift.lookAt, [LBX + 100, LBY + 100, GROUND + 1.2], "launchFacing 'pilot' looks at the chest");
  // The tether clamp got home.pos, an array, at the drop spot.
  const t = R.tethers[0];
  assert.ok(t.homes.length > 0 && t.homes.every((h) => h.isArray), "home.pos is an array");
  assert.deepEqual(t.homes[0].home, [LBX + 100, LBY + 100.72, GROUND + 0.06]);
  // Flying: the camera is owned and written from the craft pose.
  let st = api.status();
  assert.equal(st.camera.owned, true);
  assert.ok("filmViewer" in live, "camera_owner publishes the viewer cell while owned");
  assert.equal(Object.prototype.hasOwnProperty.call(cs, "positionCamera"), true);
  assert.equal(R.controls[0].phase, "fly");
  R.ctl.sticks.pitch = 0.5;
  await frames(E, 120);
  R.ctl.sticks.pitch = 0;
  st = api.status();
  assert.equal(st.state, "flying");
  roundTrip(st);
  assert.ok(st.craft && st.craft.pos.length === 3);
  const camAc = GB.threeToAcPos(cs.persp.position);
  near(camAc[0], st.craft.pos[0], 1e-3, "camera x");
  near(camAc[1], st.craft.pos[1], 1e-3, "camera y");
  near(camAc[2], st.craft.pos[2], 1e-3, "camera z");
  assert.ok(st.craft.pos[1] - (LBY + 100) > 5, "the pitch stick moved the craft north");
  assert.equal(p.visible.drone, false, "the drone is hidden while the camera is owned");
  assert.ok(R.osds[0].updates > 5 && R.osds[0].frames > 100);
  assert.equal(R.osds[0].lastView.reticle, "crosshair");
  assert.equal(R.audios[0].lastUpdate.fpv, true);
  // Recall → returning → landing → stowing → idle.
  const rr = api.recall();
  assert.deepEqual(rr, { ok: true, state: "returning" });
  const plan = craft.calls.filter((c) => c[0] === "autopilot" && c[1] === "rth").pop()[2];
  assert.equal(plan.path.points.length, 4);
  assert.deepEqual(plan.path.points[3], [LBX + 100, LBY + 100.72, GROUND + 0.06], "the RTH lands on home");
  const dropYaw = p.calls.find((c) => c[0] === "toWorld")[3];
  assert.equal(plan.yaw, dropYaw, "the rth plan carries the drop yaw (home.yaw): the drone lands facing the way it was set down");
  near(Math.abs(dropYaw), Math.PI, 1e-12, "launchFacing 'pilot' at compass 0: the drop faces south, at the pilot");
  await untilState(E, "idle", 4000);
  // Afterwards: nothing left behind.
  assert.equal(Object.prototype.hasOwnProperty.call(cs, "positionCamera"), false, "positionCamera unwrapped");
  assert.equal(Object.prototype.hasOwnProperty.call(cs, "getPlayerWorldPosition"), false, "light-pool reference restored");
  assert.equal("filmViewer" in live, false);
  assert.equal(live.film, undefined, "liveScene3d.film deleted");
  assert.equal(win.__inputFunnel._fault, null, "the funnel gate reopened");
  assert.deepEqual({ win: win.count(), doc: doc.count(), canvas: canvas.count() }, base, "listener counts back to baseline");
  assert.equal(cs.mode, "orbit", "the follow camera restored to the player's mode");
  assert.equal(cs.followYaw, 1.25);
  assert.equal(api.status().camera.owned, false);
  assert.equal(api.status().craft, null);
  assert.equal(R.controls[0].disposed, 1);
  assert.equal(g.disposed, 1);
  assert.equal(R.osds[0].disposed, 1);
  assert.equal(R.audios[0].disposed, 1);
  assert.equal(p.disposed, 1);
  assert.equal(E.sinks.size, 0, "the bus listener unsubscribed");
  assert.equal(p.where("drone"), "none");
  assert.deepEqual(g.calls.filter((c) => c[0] === "clip").map((c) => c[1]), ["pack", "place", "goggles", "goggles", "place", "pack"]);
  assert.ok(g.calls.some((c) => c[0] === "release"), "Ready at tabletDown");
  assert.deepEqual(g.calls.filter((c) => c[0] === "hideWielded").map((c) => c[1]), [true, false]);
  // One hb-drone-state event on document per transition; none on window; none extra at teardown.
  const seq = ["deploying", "flying", "returning", "landing", "stowing", "idle"];
  const evs = stateEvents(doc);
  assert.deepEqual(evs.map((e) => e.state), seq);
  assert.deepEqual(evs.map((e) => e.prev), ["idle", ...seq.slice(0, -1)]);
  assert.ok(evs.every((e) => typeof e.at === "number"));
  assert.ok(doc.dispatched.filter((e) => e.type === "hb-drone-state").every((e) => e.bubbles === false));
  assert.equal(stateEvents(win).length, 0);
  const log = api.debug.events({ limit: 200 });
  assert.equal(log.ok, true);
  assert.deepEqual(log.events.filter((e) => e.message === "state").map((e) => e.state), seq);
  roundTrip(log);
  // No console noise: every log entry is info or warn, and the warns are only the corridor fetches of the fake pkg.
  assert.ok(E.logs.every((e) => e.level !== "error"));
});

check("P4 wheel zoom keeps settings.fovDeg in [60, 110]; the storage write happens at most once per second", async () => {
  const E = await setup();
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  const w0 = E.storage.writes.length;
  E.R.ctl.sticks.zoom = 1;
  for (let k = 0; k < 90; k += 1) {
    await frame(E);
    const f = E.api.settings().settings.fovDeg;
    assert.ok(f >= 60 && f <= 110, `fov ${f}`);
  }
  assert.equal(E.api.settings().settings.fovDeg, 110);
  assert.equal(E.R.crafts[0].lastStep.fovDeg, 110, "the craft gets the live fov");
  E.R.ctl.sticks.zoom = -1;
  for (let k = 0; k < 90; k += 1) await frame(E);
  assert.equal(E.api.settings().settings.fovDeg, 60);
  E.R.ctl.sticks.zoom = 0;
  await frames(E, 90);
  const writes = E.storage.writes.slice(w0).filter((w) => w.k === "hb.drone.v1");
  assert.ok(writes.length >= 1, "persisted");
  for (let k = 1; k < writes.length; k += 1) assert.ok(writes[k].t - writes[k - 1].t >= 0.999, `writes ${writes[k - 1].t} → ${writes[k].t}`);
  assert.equal(JSON.parse(writes[writes.length - 1].v).fovDeg, 60);
  assert.equal(E.api.status().camera.fovDeg, 60);
});

// ---------------------------------------------------------------------------
// P5 aborts through the real wiring
// ---------------------------------------------------------------------------

/** Deploy (quick) and fly. */
async function flying(o = {}) {
  const E = await setup(o);
  assert.equal(E.api.deploy({ quick: true }).ok, true);
  await untilState(E, "flying", 1500);
  return E;
}

/** After idle: nothing of the cycle is left. */
function assertClean(E, base, msg) {
  assert.equal(E.live.film, undefined, `${msg}: liveScene3d.film`);
  assert.equal(Object.prototype.hasOwnProperty.call(E.cs, "positionCamera"), false, `${msg}: positionCamera`);
  assert.equal("filmViewer" in E.live, false, `${msg}: filmViewer`);
  assert.equal(E.win.__inputFunnel._fault, null, `${msg}: funnel`);
  assert.deepEqual({ win: E.win.count(), doc: E.doc.count(), canvas: E.canvas.count() }, base, `${msg}: listeners`);
  assert.equal(E.api.status().state, "idle");
}

check("P5 soft abort via the deps.onSignal bus (damage): camera + input back at once, drone lands and fades, then idle", async () => {
  const E = await setup();
  const base = { win: E.win.count(), doc: E.doc.count(), canvas: E.canvas.count() };
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  assert.equal(E.sinks.size, 1, "index.js registered one signal listener");
  for (const fn of E.sinks) fn("damage", { current: 10 });
  await frame(E);
  const st = E.api.status();
  assert.equal(st.state, "aborting");
  assert.deepEqual(st.lastAbort.reason, "damage");
  assert.equal(st.camera.owned, false, "camera back within one frame");
  assert.equal(E.win.__inputFunnel._fault, null, "input back within one frame");
  assert.ok(E.R.gestures[0].calls.some((c) => c[0] === "release"), "Ready on damage");
  assert.ok(E.R.props[0].calls.some((c) => c[0] === "fadeOut"));
  await untilState(E, "idle", 1200);
  assertClean(E, base, "soft");
  roundTrip(E.api.status());
});

check("P5 hard aborts: debug.trigger('session'), WebGL context loss, pagehide, film busy — idle at once", async () => {
  for (const how of ["trigger", "contextlost", "pagehide", "film", "death-no-ready"]) {
    const E = await flying();
    const base = { win: 0, doc: 0, canvas: 0 };
    if (how === "trigger") {
      assert.deepEqual(E.api.debug.trigger("session"), { ok: true });
      await frame(E);
    } else if (how === "contextlost") E.canvas.dispatchEvent({ type: "webglcontextlost" });
    else if (how === "pagehide") E.win.dispatchEvent({ type: "pagehide" });
    else if (how === "film") {
      E.win.__film = { status: () => ({ ok: true, active: true }) };
      await frames(E, 20); // ≤ 250 ms (4 Hz poll)
    } else if (how === "death-no-ready") {
      E.em.deathHeld = true;
      await frame(E);
      assert.equal(E.api.status().state, "aborting", "death is soft");
      assert.equal(E.R.gestures[0].calls.some((c) => c[0] === "release"), false, "no Ready on a death");
      await untilState(E, "idle", 1200);
    }
    const st = E.api.status();
    assert.equal(st.state, "idle", how);
    const want = { trigger: "session", contextlost: "contextLost", pagehide: "session", film: "film", "death-no-ready": "death" }[how];
    assert.equal(st.lastAbort.reason, want, how);
    assertClean(E, base, how);
    IDX._resetDroneForTest();
  }
});

check("P5 rig watch: a rebuilt instance is re-bound (setRig, rebind, hold); a missing rig aborts rigLost", async () => {
  const E = await flying();
  const fresh = makePilot();
  E.em.entityMap.set(GUID, fresh);
  await frames(E, 20);
  const p = E.R.props[0];
  const last = p.calls.filter((c) => c[0] === "setRig").pop();
  assert.deepEqual(last, ["setRig", "humanoid"]);
  assert.equal(p.rig.parts, fresh.parts, "props follow the new part groups");
  assert.ok(E.R.gestures[0].calls.some((c) => c[0] === "rebind"));
  assert.equal(E.R.gestures[0].calls.filter((c) => c[0] === "hold").length, 2, "ReadState re-held on the new rig");
  assert.equal(E.api.status().state, "flying");
  // In flight (respawning): wait; missing and not in flight ≥ 1 s → hard abort rigLost.
  E.em.entityMap.delete(GUID);
  E.em.spawnInFlight.set(GUID, Promise.resolve());
  await frames(E, 60);
  assert.equal(E.api.status().state, "flying", "a respawn in flight is waited for");
  E.em.spawnInFlight.delete(GUID);
  await frames(E, 90);
  assert.equal(E.api.status().state, "idle");
  assert.equal(E.api.status().lastAbort.reason, "rigLost");
});

check("P5 dispose mid-flight: hard abort 'dispose', window.__drone removed, later calls → disposed", async () => {
  const E = await flying();
  assert.deepEqual(E.api.dispose(), { ok: true });
  assert.equal(E.win.__drone, undefined);
  assert.equal(E.live.film, undefined);
  assert.equal(E.win.__inputFunnel._fault, null);
  for (const r of [E.api.status(), E.api.deploy(), E.api.dispose(), E.api.settings(), E.api.debug.events()]) {
    assert.equal(r.ok, false);
    assert.equal(r.code, "disposed");
    roundTrip(r);
  }
  assert.equal((await E.api.debug.clipParity()).code, "disposed");
  const again = await IDX.installDrone(E.deps);
  assert.notEqual(again, E.api, "the singleton was cleared");
});

// ---------------------------------------------------------------------------
// P6 refusals, settings, tune, cheat sheet, broadcast, funnel forwarding, pilot view
// ---------------------------------------------------------------------------

check("P6 refusals: deps.refusal codes pass through with the exact reasons; own not-in-world / busy / already", async () => {
  const table = {
    "not-in-world": "Enter the world first",
    portal: "Not while in portal space",
    dead: "Not while dead",
    "film-busy": "A film take owns the camera",
    busy: "The drone is busy",
    targeting: "Finish targeting first", // a pending use-target (R4-10); `busy` = drone state ≠ idle
    indoors: "Outdoors only",
    combat: "Leave combat mode first",
    moving: "Stand still to deploy",
    covered: "Needs open sky above you", // index.js's own open-sky check (phase 4 F1, P10); a deps code passes through too
  };
  assert.deepEqual({ ...IDX.DRONE_REFUSAL_REASONS }, table);
  let code = null;
  const E = await setup({ deps: { refusal: () => code } });
  for (const [c, reason] of Object.entries(table)) {
    code = c;
    assert.deepEqual(E.api.deploy(), { ok: false, code: c, reason }, c);
    assert.deepEqual(E.api.button(), { ok: false, code: c, reason, action: "deploy" });
  }
  code = null;
  // Own checks.
  E.win.getLocalPlayerGuid = () => 0;
  assert.equal(E.api.deploy().code, "not-in-world");
  E.win.getLocalPlayerGuid = () => GUID;
  E.em.entityMap.delete(GUID);
  assert.equal(E.api.deploy().code, "not-in-world");
  E.em.entityMap.set(GUID, E.pilot);
  const cs = E.live.cameraSwitcher;
  E.live.cameraSwitcher = null;
  assert.equal(E.api.deploy().code, "not-in-world");
  E.live.cameraSwitcher = cs;
  assert.equal(E.api.deploy().ok, true);
  assert.deepEqual(E.api.deploy(), { ok: true, already: true, state: "deploying" });
  await untilState(E, "flying", 1500);
  assert.deepEqual(E.api.deploy(), { ok: false, code: "busy", reason: "The drone is busy" });
  assert.equal(E.api.skip().code, "not-flying");
  assert.deepEqual(E.api.button({ shift: true }), { ok: true, state: "returning", action: "recallInstant" });
  assert.equal(E.api.status().camera.owned, false, "Shift: the camera cut back at once");
  assert.deepEqual(E.api.button(), { ok: true, already: true, state: "returning", action: "recallInstant" });
  assert.deepEqual(E.api.recall(), { ok: true, already: true, state: "returning" });
  await untilState(E, "stowing", 3000);
  assert.deepEqual(E.api.button(), { ok: true, action: "ignored", state: "stowing" });
  assert.deepEqual(E.api.recall(), { ok: true, already: true, state: "stowing" });
  await untilState(E, "idle", 3000);
  assert.equal(E.api.recall().code, "not-flying");
  assert.deepEqual(E.api.abort(), { ok: true, state: "idle", already: true });
});

check("P6 settings: stored values validated per key on load, setSettings refuses a whole bad patch, persists hb.drone.v1, applies live", async () => {
  const seed = { "hb.drone.v1": JSON.stringify({ mode: "acro", sensitivity: 99, bogus: 1, fovDeg: 90, invertY: "yes" }) };
  const E = await setup({ storageSeed: seed });
  const s = E.api.settings().settings;
  assert.equal(s.mode, "acro");
  assert.equal(s.sensitivity, 1.0, "an invalid stored value → default");
  assert.equal(s.invertY, false);
  assert.equal(s.fovDeg, 90);
  assert.equal("bogus" in s, false, "unknown keys dropped");
  const bad = E.api.setSettings({ mode: "angle", volume: 7 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad-argument");
  assert.equal(E.api.settings().settings.mode, "acro", "nothing applied");
  const ok = E.api.setSettings({ mode: "cine", rangeM: 90, acroRc: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.rangeM, 90);
  const stored = JSON.parse(E.storage.map.get("hb.drone.v1"));
  assert.deepEqual(stored, ok.settings, "the full settings object written back");
  // Live application during a cycle.
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  E.api.setSettings({ rangeM: 120, ceilingAglM: 50, acroExpo: 0.5 });
  assert.ok(E.R.tethers[0].calls.some((c) => c[0] === "configure" && c[1].rangeM === 120 && c[1].ceilingAglM === 50));
  assert.ok(E.R.crafts[0].calls.some((c) => c[0] === "setRates" && c[1].expo === 0.5 && c[1].rc === 2));
  assert.deepEqual(E.api.setMode("angle"), { ok: true, mode: "angle" });
  assert.ok(E.R.crafts[0].calls.some((c) => c[0] === "setMode" && c[1] === "angle"));
  await frames(E, 8); // the OSD text view is a 10 Hz update
  assert.equal(E.R.osds[0].lastView.reticle, "horizon");
  assert.ok(E.renderer.renders > 0, "the lens overlay draws in angle mode (postRender)");
  E.R.controls[0].fire("mode");
  assert.equal(E.api.settings().settings.mode, "acro", "M cycles the mode");
  assert.equal(E.api.setMode("turbo").code, "bad-argument");
  E.R.controls[0].fire("hideHud");
  assert.deepEqual(E.R.osds[0].cleans, [true]);
  E.R.controls[0].fire("returnHome");
  assert.equal(E.api.status().state, "returning", "R → recall");
});

check("P6 tune: profile (data file) and local (hb.drone.tune.v1) layers merge in order, validated, persisted, applied live", async () => {
  const fetchJson = async (url) => {
    assert.ok(String(url).endsWith("/data/drone-rig-profiles.json"), url);
    return { version: 1, profiles: { "0x02000001": { tablet: { pos: [1, 2, 3] }, clipMode: "timer" }, bad_key: { tablet: {} } } };
  };
  const seed = { "hb.drone.tune.v1": JSON.stringify({ version: 1, profiles: { "0x02000001": { tablet: { quat: [0, 0, 0, 2] } } } }) };
  const E = await setup({ fetchJson, storageSeed: seed });
  let t = E.api.tune();
  assert.equal(t.ok, true);
  assert.equal(t.setupId, "0x02000001");
  assert.equal(t.source, "local");
  assert.equal(t.clipMode, "timer");
  assert.deepEqual(t.anchors.tablet, { pos: [1, 2, 3], quat: [0, 0, 0, 1] });
  assert.deepEqual(t.anchors.goggles, { pos: [0, -0.10, 0.085], quat: [1, 0, 0, 0], scale: 1 });
  t = E.api.tune({ goggles: { scale: 1.2, quat: [0, 0, 0, 3] } });
  assert.equal(t.anchors.goggles.scale, 1.2);
  assert.deepEqual(t.anchors.goggles.quat, [0, 0, 0, 1]);
  const stored = JSON.parse(E.storage.map.get("hb.drone.tune.v1"));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.profiles["0x02000001"].goggles, { scale: 1.2, quat: [0, 0, 0, 1] });
  t = E.api.tune({ reset: true });
  assert.equal(t.source, "profile");
  assert.deepEqual(t.anchors.tablet.quat, [-0.509, 0.062, -0.685, 0.518]);
  assert.equal("0x02000001" in JSON.parse(E.storage.map.get("hb.drone.tune.v1")).profiles, false);
  for (const b of [5, { tablet: { scale: 2 } }, { tablet: { pos: [1, 2] } }, { goggles: { quat: [0, 0, 0, 0] } }, { clipMode: "fast" }, { nope: {} }, { reset: 1 }]) {
    const r = E.api.tune(b);
    assert.equal(r.code, "bad-argument", JSON.stringify(b));
  }
  // Live: a deploy picks the merged anchors, a tune patch reaches props.setAnchors.
  E.api.deploy({ quick: true });
  await frames(E, 2);
  const props = E.R.props[0];
  assert.deepEqual(props.deps.anchors.tablet.pos, [1, 2, 3]);
  assert.equal(E.R.gestures[0].deps.clipMode(), "timer", "clipMode from the profile reaches the gestures");
  E.api.tune({ clipMode: "clip", tablet: { pos: [0, 0, 0] } });
  assert.equal(E.R.gestures[0].deps.clipMode(), "clip");
  const sa = props.calls.filter((c) => c[0] === "setAnchors").pop();
  assert.deepEqual(sa[1].tablet.pos, [0, 0, 0]);
  E.api.abort("dispose");
  // No pilot → not-in-world.
  E.win.getLocalPlayerGuid = () => 0;
  assert.equal(E.api.tune().code, "not-in-world");
});

check("P6 the first-flight cheat sheet once per page load (storage hb.drone.seen.v1); broadcastPose only when the setting is on", async () => {
  const sent = [];
  const E = await setup({ deps: { broadcastPose: () => { sent.push(1); return { ok: true }; } } });
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  assert.deepEqual(E.R.osds[0].cheats, [true]);
  assert.equal(E.storage.map.get("hb.drone.seen.v1"), "1");
  assert.equal(sent.length, 0, "broadcastPose off by default: nothing sent");
  E.api.abort("session");
  E.api.setSettings({ broadcastPose: true });
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  assert.equal(sent.length, 1, "exactly one /read at tablet-up");
  assert.deepEqual(E.R.osds[1].cheats, [], "not again in the same page load");
  assert.deepEqual(E.R.osds[1].shows.map((s) => s[0]), ["boot", "fpv"]);
});

check("P6 deps.funnel is forwarded to the controls (window.__inputFunnel untouched); pilot view frames the pilot from the front", async () => {
  const own = makeFunnel();
  const E = await setup({ deps: { funnel: own } });
  E.api.deploy({ quick: true });
  assert.equal(own._fault, "gate");
  assert.equal(E.win.__inputFunnel._fault, null);
  await untilState(E, "flying", 1500);
  assert.deepEqual(E.api.pilotView(), { ok: true, state: "pilotView" });
  assert.equal(E.api.status().camera.owned, false);
  near(E.cs.followYaw, 0.4 + Math.PI, 1e-12, "framePilotFront: followYaw = heading + π");
  near(E.cs._lastUserYawMs, E.clock.t * 1000, 1e-6, "autofollow grace stamped with performance.now()");
  assert.equal(E.R.controls[0].phase, "pilot");
  assert.deepEqual(E.api.pilotView(true), { ok: true, already: true, state: "pilotView" });
  E.R.controls[0].fire("pilotView");
  assert.equal(E.api.status().state, "flying", "Tab returns to the goggles");
  assert.equal(E.api.status().camera.owned, true);
  assert.deepEqual(E.api.pilotView(false), { ok: true, already: true, state: "flying" });
  E.api.abort();
  await untilState(E, "idle", 1200);
  assert.equal(own._fault, null);
});

check("P6 launchFacing 'away' (yaw = pilot compass, no look-at); a drop at the pilot's feet backs off along the pilot's facing", async () => {
  const E = await setup();
  E.api.setSettings({ launchFacing: "away" });
  // The pilot faces east (compass +π/2 = root yaw −π/2, CCW).
  E.pilot.root.quaternion = { x: 0, y: 0, z: Math.sin(-Math.PI / 4), w: Math.cos(-Math.PI / 4) };
  E.api.deploy({ quick: true });
  const props = E.R.props[0];
  props.toWorld = function toWorld(name, groundZ, yaw) {
    this.calls.push(["toWorld", name, groundZ, yaw]);
    this.at[name] = "world";
    this.dronePos = [LBX + 100.03, LBY + 100, groundZ + 0.06]; // 3 cm from the feet: degenerate
    return { ok: true, pos: this.dronePos.slice() };
  };
  await untilState(E, "flying", 1500);
  const tw = props.calls.find((c) => c[0] === "toWorld");
  near(tw[3], Math.PI / 2, 1e-9, "'away': the drone yaw is the pilot's compass");
  const lift = E.R.crafts[0].calls.find((c) => c[0] === "autopilot" && c[1] === "liftoff")[2];
  assert.equal(lift.lookAt, null, "'away': a level look along the heading");
  near(lift.to[0] - lift.from[0], 3.4, 1e-9, "backs off east, the pilot's facing");
  near(lift.to[1] - lift.from[1], 0, 1e-9);
  near(lift.heading, Math.PI / 2, 1e-9);
});

check("P6 no-hands rig: the drone is placed beside the pilot (1.5 m) and lifts off; status().rig reports the kind", async () => {
  const E = await setup({ profile: NO_HANDS, profileFrame: 1, readyFrame: 2 });
  E.api.deploy();
  await untilState(E, "flying", 1500);
  const pl = E.R.props[0].calls.find((c) => c[0] === "place");
  near(pl[2][1] - (LBY + 100), 1.5, 1e-9, "1.5 m ahead (compass 0 = north)");
  near(pl[2][2], GROUND + 0.06, 1e-9, "rest height on the terrain");
  near(pl[3], Math.PI, 1e-12, "facing the pilot");
  assert.equal(E.R.props[0].calls.some((c) => c[0] === "attach"), false);
  assert.deepEqual(E.api.status().rig, { kind: "no-hands", setupId: "0x02000001", parts: 34 });
});

// ---------------------------------------------------------------------------
// P7 never throws, JSON-safe
// ---------------------------------------------------------------------------

check("P7 every method with bad arguments never throws and is JSON-safe", async () => {
  const E = await setup();
  const a = E.api;
  const calls = [
    () => a.deploy("x"), () => a.deploy({ quick: "y" }), () => a.recall(5), () => a.recall({ instant: "no" }), () => a.skip(1),
    () => a.button(null), () => a.button("x"), () => a.abort(42), () => a.setMode(null), () => a.pilotView("x"), () => a.settings(),
    () => a.setSettings(null), () => a.setSettings({ x: 1 }), () => a.tune(5), () => a.tune({ tablet: { pos: [1] } }),
    () => a.debug.setSticks(null, 1), () => a.debug.setSticks({ pitch: 9 }, -1), () => a.debug.trigger("nope"), () => a.debug.events({ limit: -1 }),
    () => a.debug.events("x"), () => a.status(),
  ];
  for (const f of calls) {
    const r = f();
    assert.equal(typeof r.ok, "boolean");
    roundTrip(r, f.toString());
    if (r.ok === false) assert.equal(typeof r.code, "string");
  }
  assert.equal(a.deploy({ quick: "y" }).code, "bad-argument");
  assert.equal(a.setMode("x").code, "bad-argument");
  const s = a.debug.setSticks({ pitch: 9, boost: true, bogus: 1 }, 500);
  assert.equal(s.ok, true);
  assert.equal(typeof s.untilSec, "number");
  const cp = await a.debug.clipParity();
  assert.equal(cp.ok, true, "clipParity with a transient gestures driver while idle");
  roundTrip(cp);
  // Mid-flight too.
  a.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  for (const f of calls) roundTrip(f());
  const st = a.status();
  assert.deepEqual(Object.keys(st).sort(), ["ok", "version", "state", "beat", "mode", "since", "quick", "rig", "craft", "input", "camera", "flags", "lastAbort"].sort());
  assert.deepEqual(Object.keys(st.craft).sort(), ["pos", "vel", "hprDeg", "aglM", "speed", "distHomeM", "signal", "battery"].sort());
  assert.deepEqual(Object.keys(st.input).sort(), ["source", "pointerLocked", "locked", "gamepad"].sort());
  assert.deepEqual(st.flags, { debug: true, audio: true, signals: "bus" });
  assert.deepEqual(st.rig, { kind: "humanoid", setupId: "0x02000001", parts: 34 });
  // (button() while idle deployed a first cycle above: the current cycle's fakes are the last ones.)
  const ctrl = E.R.controls[E.R.controls.length - 1];
  // debug.setSticks overrides controls.poll for ms of driver time.
  const polls0 = ctrl.polls;
  a.debug.setSticks({ roll: 1 }, 250);
  await frames(E, 10);
  assert.equal(ctrl.polls, polls0, "controls.poll is not called while overridden");
  await frames(E, 10);
  assert.ok(ctrl.polls > polls0, "back to the controls after the override");
  // A throwing factory method in the frame driver → hard abort 'error', one warn, never a throw.
  E.R.crafts[E.R.crafts.length - 1].step = () => { throw new Error("boom"); };
  await frame(E);
  assert.equal(a.status().state, "idle");
  assert.equal(a.status().lastAbort.reason, "error");
  assert.ok(E.logs.some((l) => l.level === "warn" && /boom/.test(l.message)));
  assert.equal(E.live.film, undefined);
});

check("P7 a throwing sequence at deploy → internal, nothing left; a throwing executor → internal; ?droneAudio=off reaches the audio", async () => {
  const E = await setup({ deps: {} });
  E.api.dispose();
  IDX._resetDroneForTest();
  // A sequence whose tick throws: emergency teardown, no state event, the hooks gone.
  const env = makeEnv();
  const { modules, R } = makeFakes();
  const api = await IDX.installDrone({ window: env.win, document: env.doc, THREE, clock: () => env.clock.t, storage: env.storage,
    search: "?droneAudio=off", log: () => {}, fetchJson: async () => null,
    modules: { ...modules, createSequence: () => ({ tick() { throw new Error("seq boom"); }, state() { return { beat: null, quick: false, rig: null, lastAbort: null }; }, reset() {} }) } });
  const r = api.deploy();
  assert.equal(r.ok, false);
  assert.equal(r.code, "internal");
  assert.equal(api.status().state, "idle");
  assert.equal(env.live.film, undefined);
  assert.equal(env.win.__inputFunnel._fault, null);
  assert.equal(R.audios[0].deps.enabled, false, "?droneAudio=off → enabled: false");
  assert.equal(R.props[0].disposed, 1);
  IDX._resetDroneForTest();
  // An executor that throws during the deploy tick (controls.lock): hard abort 'error' → internal, clean.
  const env2 = makeEnv();
  const f2 = makeFakes();
  const orig = f2.modules.createControls;
  f2.modules.createControls = (deps) => {
    const c = orig(deps);
    c.lock = () => { throw new Error("lock boom"); };
    return c;
  };
  const api2 = await IDX.installDrone({ window: env2.win, document: env2.doc, THREE, clock: () => env2.clock.t, storage: env2.storage,
    log: () => {}, fetchJson: async () => null, modules: f2.modules });
  const r2 = api2.deploy();
  assert.equal(r2.code, "internal");
  assert.equal(api2.status().state, "idle");
  assert.equal(api2.status().lastAbort.reason, "error");
  assert.equal(env2.live.film, undefined);
  assert.deepEqual(stateEvents(env2.doc).map((e) => e.state), ["deploying", "idle"]);
});

check("P5 a holtburger:state event re-checks the session synchronously (reconnect → hard abort 'session')", async () => {
  const E = await flying();
  E.win.dispatchEvent({ type: "holtburger:state", detail: { state: "ready" } });
  assert.equal(E.api.status().state, "flying", "same session: nothing");
  E.win.__sessionHandle = { reconnected: true };
  E.win.dispatchEvent({ type: "holtburger:state", detail: { state: "in-world" } });
  assert.equal(E.api.status().state, "idle");
  assert.equal(E.api.status().lastAbort.reason, "session");
});

check("P5 dispose() from an hb-drone-state listener ends the cycle mid-list: no later action runs on it (the camera stays released)", async () => {
  const E = await flying();
  assert.deepEqual(E.api.pilotView(), { ok: true, state: "pilotView" });
  let seen = null;
  let disposedWith = null;
  E.doc.addEventListener("hb-drone-state", (ev) => {
    if (seen !== null || ev.detail.state !== "flying") return;
    seen = ev.detail.prev;
    disposedWith = E.api.dispose(); // (an assert in here would be swallowed by the executor's try/catch)
  });
  // T11 = [state(flying), cameraOwn, controlsPhase(fly), osd(fpv), autopilot(null)]: the dispose runs inside the
  // state executor's event, before cameraOwn.
  E.api.pilotView();
  assert.equal(seen, "pilotView");
  assert.deepEqual(disposedWith, { ok: true });
  assert.equal(Object.prototype.hasOwnProperty.call(E.cs, "positionCamera"), false, "own() never ran on the torn-down link");
  assert.equal("filmViewer" in E.live, false);
  assert.equal(E.live.film, undefined);
  assert.equal(E.win.__inputFunnel._fault, null);
  assert.equal(E.R.controls[0].phase, "pilot", "controlsPhase(fly) never reached the disposed controls");
  assert.deepEqual(E.R.osds[0].shows.slice(-1), [["pilot"]], "osd(fpv) never ran");
  assert.equal(E.win.__drone, undefined);
  assert.equal(E.api.status().code, "disposed");
});

check("P5 a deploy() from inside the 'idle' hb-drone-state event is busy (the last cycle's inputRestore is still pending)", async () => {
  const E = await flying();
  let again = null;
  E.doc.addEventListener("hb-drone-state", (ev) => {
    if (again === null && ev.detail.state === "idle") again = E.api.deploy({ quick: true });
  });
  E.api.recall({ instant: true });
  await untilState(E, "idle", 4000);
  assert.deepEqual(again, { ok: false, code: "busy", reason: "The drone is busy" });
  assert.equal(E.R.controls.length, 1, "no second cycle was built");
  assert.equal(E.win.__inputFunnel._fault, null);
  assert.equal(E.api.deploy({ quick: true }).ok, true, "a deploy after the teardown works");
  assert.equal(E.win.__inputFunnel._fault, "gate", "and holds the gate");
});

check("P7 a sequence that throws mid-flight: the emergency teardown releases the held ReadState (HARD 'error') and hands everything back", async () => {
  const SQ = await import("../scene3d/drone/sequence.js");
  let armed = false;
  const createSequence = (o) => {
    const s = SQ.createSequence(o);
    return { state: s.state, reset: s.reset, tick(i) { if (armed) throw new Error("seq boom"); return s.tick(i); } };
  };
  const E = await setup({ modules: { createSequence } });
  const base = { win: E.win.count(), doc: E.doc.count(), canvas: E.canvas.count() };
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  const g = E.R.gestures[0];
  assert.equal(g.held, 0x43000146, "ReadState held while flying");
  armed = true;
  await frame(E);
  const st = E.api.status();
  assert.equal(st.state, "idle");
  assert.deepEqual({ reason: st.lastAbort.reason, from: st.lastAbort.from }, { reason: "error", from: "flying" });
  assert.equal(g.calls.filter((c) => c[0] === "release").length, 1, "Ready for the held ReadState");
  assert.equal(g.held, null);
  assert.equal(g.disposed, 1);
  assert.ok(E.logs.some((l) => l.level === "warn" && /seq boom/.test(l.message)), "one warn");
  assert.deepEqual(stateEvents(E.doc).map((e) => e.state), ["deploying", "flying", "idle"]);
  assertClean(E, base, "emergency");
});

// ---------------------------------------------------------------------------
// P8 the world link (real film runtime pieces over a fake liveScene3d)
// ---------------------------------------------------------------------------

const WL = await import("../scene3d/drone/world_link.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");

/** A fake scene for the link alone, with loader spies for world.prewarm. */
function linkEnv() {
  const env = makeEnv();
  const fired = [];
  const lbs = { terrain: new Set(), statics: new Set(), buildings: new Set(), env: new Set() };
  Object.assign(env.live, {
    terrainBakedLbs: lbs.terrain,
    staticsBakedLbs: lbs.statics,
    buildingsBakedLbs: lbs.buildings,
    envCellLoadedLbs: lbs.env,
    _runTerrainRingBatch(x, y) {
      fired.push(["terrain", x, y]);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) lbs.terrain.add((((x + dx) << 24) | ((y + dy) << 16)) >>> 0);
    },
    loadStaticsForLandblock(x, y) {
      fired.push(["statics", x, y]);
      lbs.statics.add(((x << 24) | (y << 16)) >>> 0);
    },
    loadBuildingsForLandblock(x, y) {
      fired.push(["buildings", x, y]);
      lbs.buildings.add(((x << 24) | (y << 16)) >>> 0);
    },
    loadEnvCellsForLandblock(lb) {
      fired.push(["envCells", lb]);
    },
  });
  const populate = [];
  env.live.wasmExports = {
    populateBuildingAabbsForLandblock: (lb) => populate.push(lb),
    populateStaticsAabbsForLandblock: (lb) => populate.push(lb),
  };
  return { ...env, fired, populate };
}

check("P8 world link: exports, FilmError DRONE_NO_SCENE, writeAcPose, the §6.5 camera helpers", () => {
  assert.deepEqual({ ...WL.DRONE_PREWARM }, { radius: 96, maxLandblocks: 4, minIntervalMs: 2000, timeoutSec: 8, envCells: false, collision: false, corridor: true });
  assert.ok(Object.isFrozen(WL.DRONE_PREWARM));
  assert.equal(WL.DRONE_LENS_QUERY_MS, 250);
  assert.throws(() => WL.createWorldLink({}), (e) => e instanceof FilmError && e.code === "DRONE_NO_SCENE");
  const o = new THREE.Object3D();
  const q = GB.quatFromHPR(0.7, -0.2, 0.1);
  assert.equal(WL.writeAcPose(o, [1, 2, 3], [q[0] * 2, q[1] * 2, q[2] * 2, q[3] * 2]), true);
  assert.deepEqual([o.position.x, o.position.y, o.position.z], [1, 3, -2]);
  const tq = GB.acQuatToThree(q);
  near(o.quaternion.x, tq[0], 1e-12);
  near(o.quaternion.y, tq[1], 1e-12);
  near(o.quaternion.z, tq[2], 1e-12);
  near(o.quaternion.w, tq[3], 1e-12);
  assert.equal(WL.writeAcPose(o, [NaN, 0, 0], q), false);
  assert.equal(WL.writeAcPose(o, [0, 0, 0], [0, 0, 0, 0]), false);
  assert.equal(WL.writeAcPose(null, [0, 0, 0], q), false);
  // prepareFollowCamera / restoreFollowCamera
  const cs = new FakeSwitcher(new FakeTarget());
  cs._inHead = true;
  const saved = WL.prepareFollowCamera(cs);
  assert.deepEqual(saved, { ok: true, mode: "orbit", followYaw: 1.25, followPitch: 0.3, followDistance: 6, inHead: true });
  assert.equal(cs.mode, "follow");
  assert.equal(cs._inHead, false);
  assert.equal(cs._prevEyeAc, null);
  cs.followYaw = 9;
  cs.followDistance = 2;
  cs.tickMovement(); // a follow tick re-arms camera.js's orbit-entry latch
  assert.equal(cs._orbitRigStopped, false);
  assert.equal(WL.restoreFollowCamera(cs, saved), true);
  assert.equal(cs.mode, "orbit");
  assert.equal(cs._orbitRigStopped, true, "back into orbit with the latch set: camera.js dispatches no Ready");
  cs.tickMovement();
  assert.equal(cs.readyDispatches, 0, "no Ready from the orbit entry");
  assert.equal(cs.followYaw, 1.25);
  assert.equal(cs.followDistance, 6);
  assert.equal(cs._inHead, true);
  // Another saved mode leaves the latch alone (only the orbit entry dispatches).
  const cs2 = new FakeSwitcher(new FakeTarget());
  cs2.mode = "topDown";
  const saved2 = WL.prepareFollowCamera(cs2);
  cs2.tickMovement();
  assert.equal(WL.restoreFollowCamera(cs2, saved2), true);
  assert.equal(cs2.mode, "topDown");
  assert.equal(cs2._orbitRigStopped, false);
  assert.deepEqual(WL.prepareFollowCamera(null), { ok: false, mode: null, followYaw: null, followPitch: null, followDistance: null, inHead: false });
  assert.equal(WL.restoreFollowCamera(cs, { ok: false }), false);
  // framePilotFront / forcePilotOpaque
  assert.equal(WL.framePilotFront(cs, 1234), true);
  near(cs.followYaw, 0.4 + Math.PI, 1e-12);
  assert.equal(cs._lastUserYawMs, 1234);
  cs.getPlayerHeading = () => NaN;
  assert.equal(WL.framePilotFront(cs, 1), false);
  assert.equal(WL.framePilotFront({}, 1), false);
  cs._camFadeLastOpacity = 0.2;
  assert.equal(WL.forcePilotOpaque(cs), true);
  assert.equal(cs.calls.fade.pop(), 1);
  assert.equal(WL.forcePilotOpaque({}), false);
});

check("P8 world link: the §6.3 recipe — hooks, groundZ (terrain only), body vs eye safety, session-handle getters", () => {
  const L = linkEnv();
  let handle = L.sh;
  const link = WL.createWorldLink({ liveScene3d: L.live, THREE, window: L.win, getSessionHandle: () => handle, wasmExports: L.live.wasmExports,
    body: DRONE_BODY, log: () => {} });
  assert.ok(L.live.film && L.live.film === link.hooks, "camera owner installed the shared film hooks");
  assert.equal(link.los.segmentBlocked !== undefined, true);
  assert.equal(link.groundZ(LBX + 10, LBY + 10), GROUND);
  assert.equal(link.groundZ(NaN, 0), null);
  // Body reflex: radius 0.18 at fov 1, clearance = the rest height; the eye: ≥ 0.25 m and the 0.7 m floor.
  near(link.safetyBody.radiusFor(1, 16 / 9), 0.18, 1e-12);
  assert.ok(link.safety.radiusFor(75, 16 / 9) >= 0.25);
  const below = { pos: [LBX + 10, LBY + 10, GROUND - 1], q: [1, 0, 0, 0], fov: 75 };
  near(link.safetyBody.clamp(null, below, { fovDeg: 1, cut: true }).pose.pos[2], GROUND + 0.06, 1e-12, "body floor");
  near(link.safety.clamp(null, below, { fovDeg: 75, cut: true }).pose.pos[2], GROUND + 0.7, 1e-12, "eye floor");
  // The session handle is read lazily: a swapped handle is used by the next sweep (safety) and write (camera owner).
  const calls = [];
  handle = {
    terrainHeightAt: () => GROUND,
    sweepSphereAgainstBuildingMesh(...a) {
      calls.push(a[7]);
      return undefined;
    },
    resolveViewerCell(...a) {
      calls.push("cell");
      return a[7];
    },
  };
  link.safetyBody.clamp({ pos: [LBX + 10, LBY + 10, GROUND + 5] }, { pos: [LBX + 12, LBY + 10, GROUND + 5], q: [1, 0, 0, 0] }, { fovDeg: 1 });
  assert.ok(calls.length >= 1, "safety swept with the new handle");
  link.cameraOwner.own();
  link.cameraOwner.write({ pos: [LBX + 10, LBY + 10, GROUND + 5], q: [1, 0, 0, 0], fov: 75 });
  link.cameraOwner.write({ pos: [LBX + 11, LBY + 10, GROUND + 5], q: [1, 0, 0, 0], fov: 75 });
  assert.ok(calls.includes("cell"), "the camera owner walks the viewer cell with the new handle");
  // Hook listeners added through the link are removed by dispose; the camera is released; liveScene3d.film deleted.
  let pre = 0;
  link.onPreFrame(() => { pre += 1; });
  link.onPostRender(() => {});
  L.live.film.preFrame(0, 0.016);
  assert.equal(pre, 1);
  assert.equal(link.stats().listeners, 2);
  roundTrip(link.stats());
  const d = link.dispose();
  assert.deepEqual(d, { ok: true, already: false, emittersShown: 0 });
  assert.equal(link.cameraOwner.owned, false);
  assert.equal(L.live.film, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(L.cs, "positionCamera"), false);
  assert.deepEqual(link.dispose(), { ok: true, already: true, emittersShown: 0 });
  assert.equal(typeof link.onPreFrame(() => {}), "function");
  assert.equal(L.live.film, undefined, "no hooks re-installed after dispose");
  assert.equal(link.prewarmAround([LBX + 500, LBY, GROUND]), false);
});

check("P8 world link: a film hooks object that existed before the link is shared and never deleted; one the link created is", async () => {
  const { ensureFilmHooks } = await import("../scene3d/film/runtime/camera_owner.js");
  const L = linkEnv();
  const film = ensureFilmHooks(L.live); // film mode's install at init3D
  const link = WL.createWorldLink({ liveScene3d: L.live, THREE, window: L.win, getSessionHandle: () => L.sh, log: () => {} });
  assert.equal(link.hooks, film, "ensureFilmHooks handed the link film's object");
  link.onPreFrame(() => {});
  link.onPostRender(() => {});
  link.cameraOwner.own();
  link.dispose();
  assert.equal(L.live.film, film, "film's object stays installed");
  assert.deepEqual([film.stats().preListeners, film.stats().postListeners], [0, 0], "the link's own listeners are gone");
  assert.equal(link.cameraOwner.owned, false, "the camera is released");
  assert.equal(Object.prototype.hasOwnProperty.call(L.cs, "positionCamera"), false);
  // A non-hooks object there is replaced by ensureFilmHooks: the replacement is the link's own, deleted at dispose.
  const L2 = linkEnv();
  L2.live.film = { foreign: true };
  const l2 = WL.createWorldLink({ liveScene3d: L2.live, THREE, window: L2.win, getSessionHandle: () => L2.sh, log: () => {} });
  assert.equal(L2.live.film, l2.hooks);
  l2.dispose();
  assert.equal(L2.live.film, undefined);
});

check("P8 world link: prewarmAround only on a new landblock, one in flight, ≥ 2 s apart; the six DRONE_PREWARM keys", async () => {
  const L = linkEnv();
  let t = 0;
  const link = WL.createWorldLink({ liveScene3d: L.live, THREE, window: L.win, getSessionHandle: () => L.sh, log: () => {}, now: () => t });
  const p0 = [LBX + 100, LBY + 100, GROUND + 5];
  assert.equal(link.prewarmAround(p0), false, "the first position sets the baseline");
  assert.equal(link.prewarmAround([LBX + 150, LBY + 100, GROUND]), false, "same landblock");
  t = 5000;
  assert.equal(link.prewarmAround([LBX + 200, LBY + 100, GROUND + 5]), true, "entered the landblock to the east");
  assert.equal(link.prewarmAround([LBX + 400, LBY + 100, GROUND + 5]), false, "one in flight");
  await flush();
  await flush();
  const s = link.stats().prewarm;
  assert.equal(s.started, 1);
  assert.equal(s.finished, 1, "resolved once every required kind was baked");
  assert.equal(s.lastLb, "0xAAB40000");
  assert.ok(L.fired.some((f) => f[0] === "terrain"), "terrain ring batch");
  assert.ok(L.fired.some((f) => f[0] === "statics") && L.fired.some((f) => f[0] === "buildings"));
  assert.equal(L.fired.some((f) => f[0] === "envCells"), false, "envCells: false");
  assert.equal(L.populate.length, 0, "collision: false");
  const lbsTouched = new Set(L.fired.filter((f) => f[0] === "statics").map((f) => `${f[1]},${f[2]}`));
  assert.ok(lbsTouched.size <= 4, `maxLandblocks 4 (got ${lbsTouched.size})`);
  t = 5500;
  assert.equal(link.prewarmAround([LBX + 400, LBY + 100, GROUND + 5]), false, "< 2 s since the last one");
  t = 7100;
  assert.equal(link.prewarmAround([LBX + 400, LBY + 100, GROUND + 5]), true, "≥ 2 s later, a new landblock");
  assert.equal(link.prewarmAround([NaN, 0, 0]), false);
  await flush();
  link.dispose();
});

check("P8 world link: lens overlay per mode (cine off, angle / acro freestyle), drawn only while owned; aspect fallbacks", () => {
  const L = linkEnv();
  const link = WL.createWorldLink({ liveScene3d: L.live, THREE, window: L.win, getSessionHandle: () => L.sh, log: () => {} });
  assert.deepEqual(link.configureLens("cine"), { ok: true, on: false });
  assert.equal(link.stats().lens.overlay, null, "cine never builds the overlay");
  assert.deepEqual(link.configureLens("angle"), { ok: true, on: true });
  assert.equal(link.stats().lens.overlay.style, "freestyle");
  assert.equal(link.drawLens({ t: 1, theta: 1, throttle: 1, fov: 75 }), false, "not owned → no draw");
  link.cameraOwner.own();
  const r0 = L.renderer.renders;
  assert.equal(link.drawLens({ t: 1, theta: 1, throttle: 1, fov: 75 }), true);
  assert.equal(L.renderer.renders, r0 + 1, "one extra render");
  assert.equal(L.renderer.autoClear, true, "renderer state restored");
  assert.deepEqual(link.configureLens("acro"), { ok: true, on: true });
  assert.deepEqual(link.configureLens("cine"), { ok: true, on: false });
  assert.equal(link.drawLens({ t: 1, theta: 1, throttle: 1, fov: 75 }), false, "off again");
  assert.deepEqual(link.configureLens("warp"), { ok: false, on: false });
  near(link.aspect(), 1920 / 1080, 1e-12);
  L.canvas.width = 0;
  near(link.aspect(), 16 / 9, 1e-12, "persp.aspect");
  L.cs.persp.aspect = 2;
  assert.equal(link.aspect(), 2);
  L.live.cameraSwitcher = null;
  near(link.aspect(), 16 / 9, 1e-12);
  assert.equal(link.prepareFollowCamera().ok, false, "helpers read cameraSwitcher at call time");
  L.live.cameraSwitcher = L.cs;
  link.dispose();
  // Without THREE the overlay cannot build.
  const L2 = linkEnv();
  const l2 = WL.createWorldLink({ liveScene3d: L2.live, window: L2.win, log: () => {} });
  assert.deepEqual(l2.configureLens("angle"), { ok: false, on: false });
  l2.dispose();
});

check("P8 world link: the near-lens particle hide goes through a ≤ 4 Hz throttle (DRONE_LENS_QUERY_MS)", () => {
  const L = linkEnv();
  let t = 0;
  const link = WL.createWorldLink({ liveScene3d: L.live, THREE, window: L.win, getSessionHandle: () => L.sh, log: () => {}, now: () => t,
    particleManagers: [] });
  assert.ok(link.particles && typeof link.particles.near === "function");
  let queries = 0;
  link.particles.near = () => {
    queries += 1;
    return [];
  };
  const pose = (x) => ({ pos: [LBX + x, LBY + 10, GROUND + 5], q: [1, 0, 0, 0], fov: 75 });
  for (let k = 0; k < 10; k += 1) {
    link.safety.clamp(pose(k), pose(k + 0.1), { fovDeg: 75, cut: true });
    t += 50; // 20 Hz of clamps
  }
  assert.equal(queries, 2, "500 ms of 20 Hz clamps → 2 queries (0 ms, 250 ms)");
  link.safetyBody.clamp(pose(0), pose(1), { fovDeg: 1, cut: true });
  assert.equal(queries, 2, "the body reflex never hides particles");
  link.dispose();
});

// ---------------------------------------------------------------------------
// P9 the phase-3 fixes (2026-10-24)
// ---------------------------------------------------------------------------

/** The camera's AC z (camera_owner.write applies the pose to persp at once). */
const camZ = (E) => GB.threeToAcPos(E.cs.persp.position)[2];

check("P9 an FPV crash near the ground: the body reflex rests the drone at ground + rest height; the camera never goes under the eye floor", async () => {
  const E = await flying();
  const craft = E.R.crafts[0];
  const p = E.R.props[0];
  craft.impact = 20; // > crashMps 7: the next contact crashes
  E.R.ctl.sticks.throttle = -1; // a dive onto the eye's terrain floor
  for (let k = 0; k < 600 && E.api.status().state === "flying"; k += 1) await frame(E);
  craft.impact = 0;
  E.R.ctl.sticks.throttle = 0;
  assert.equal(E.api.status().state, "crashed");
  assert.equal(E.api.status().camera.owned, true, "the 1 s crash static keeps the goggles");
  let camMin = Infinity;
  for (let k = 0; k < 300; k += 1) {
    const st = E.api.status();
    if (st.state !== "crashed") break;
    if (st.camera.owned) camMin = Math.min(camMin, camZ(E));
    await frame(E);
  }
  assert.equal(E.api.status().state, "stowing", "T23 after the static");
  near(p.dronePos[2], GROUND + 0.06, 1e-9, "the drone rests on the ground (rest height), not on the eye's 0.7 m floor");
  assert.equal(craft.landed, true);
  assert.ok(camMin >= GROUND + 0.7 - 1e-9, `the camera kept the eye floor while owned (min ${camMin - GROUND} m AGL)`);
  assert.ok(craft.contacts.filter((c) => c.plan === "crash").every((c) => !c.floor || c.z <= GROUND + 0.06 + 1e-9),
    "no eye-floor hit reached the crashing craft");
  await frames(E, 30);
  near(p.dronePos[2], GROUND + 0.06, 1e-9, "and stays there through the stow");
});

check("P9 a forced landing (empty battery) while skimming the eye floor lands on the ground; the camera never goes under the eye floor", async () => {
  const E = await flying();
  const p = E.R.props[0];
  E.R.ctl.sticks.throttle = -1;
  await frames(E, 60);
  E.R.ctl.sticks.throttle = 0;
  near(E.api.status().craft.aglM, 0.7, 1e-6, "the eye's terrain floor holds the craft while the goggles fly it");
  E.R.tethers[0].battery = 1e-9; // empty on the next drain → T19
  let camMin = Infinity;
  const seen = [];
  for (let k = 0; k < 600; k += 1) {
    const st = E.api.status();
    if (seen[seen.length - 1] !== st.state) seen.push(st.state);
    if (st.state === "stowing") break;
    if (st.camera.owned) camMin = Math.min(camMin, camZ(E));
    await frame(E);
  }
  assert.deepEqual(seen, ["flying", "landing", "stowing"]);
  assert.equal(E.R.crafts[0].landed, true);
  near(p.dronePos[2], GROUND + 0.06, 1e-9, "landed on the ground (rest height), not on the eye floor");
  assert.ok(camMin >= GROUND + 0.7 - 1e-9, `the camera kept the eye floor while owned (min ${camMin - GROUND} m AGL)`);
});

check("P9 an FPV return (rth) is a ground plan: the body reflex clamps the craft, a second eye clamp the camera; a T16 cancel sweeps the eye on from its own last pose", async () => {
  const calls = [];
  /** The real world link, its two safety instances recording every clamp call. */
  const createWorldLink = (d) => {
    const l = WL.createWorldLink(d);
    for (const [name, inst] of [["eye", l.safety], ["body", l.safetyBody]]) {
      const clamp0 = inst.clamp;
      inst.clamp = (prev, want, ctx) => {
        const r = clamp0(prev, want, ctx);
        calls.push({ name, prev, want, pose: r && r.pose ? r.pose : null, cut: !!(ctx && ctx.cut) });
        return r;
      };
    }
    return l;
  };
  const E = await flying({ modules: { createWorldLink } });
  /** One frame; the clamp calls it made. */
  const step = async () => {
    const n = calls.length;
    await frame(E);
    return calls.slice(n);
  };
  let f = await step();
  assert.deepEqual(f.map((x) => x.name), ["eye"], "flying in the goggles: the eye reflex alone");
  let lastEye = f[0].pose;
  assert.deepEqual(E.api.recall(), { ok: true, state: "returning" });
  assert.equal(E.api.status().camera.owned, true, "an FPV return keeps the goggles (cancellable)");
  for (let k = 0; k < 10; k += 1) {
    f = await step();
    assert.deepEqual(f.map((x) => x.name), ["body", "eye"], `rth frame ${k}: the body clamps the craft, then the eye the camera`);
    assert.equal(f[1].want, f[0].pose, "the camera's eye clamp takes the body pose");
    assert.equal(f[1].prev, lastEye, "and sweeps from the last EYE pose");
    near(camZ(E), f[1].pose.pos[2], 1e-9, "the camera is written from the eye pose");
    lastEye = f[1].pose;
  }
  assert.equal(E.api.status().state, "returning");
  E.R.ctl.sticks.pitch = 0.5; // a fresh stick input cancels the armed FPV return (T16)
  f = await step();
  E.R.ctl.sticks.pitch = 0;
  assert.equal(E.api.status().state, "flying");
  assert.deepEqual(f.map((x) => x.name), ["eye"], "manual flight again: the eye reflex alone");
  assert.equal(f[0].prev, lastEye, "the eye sweeps on from its own last pose, not the body's");
  assert.equal(f[0].cut, false);
});

check("P9 a standing hand (timer place) drops on the spot 0.72 m ahead on the pilot compass; a release-frame hand drops at the hand", async () => {
  const compass = -0.9;
  const quat = { x: 0, y: 0, z: Math.sin(-compass / 2), w: Math.cos(-compass / 2) }; // compass = −root yaw
  const X = LBX + 100, Y = LBY + 100;
  const cases = [
    // the Ready pose a timer job leaves: the in-hand drone at the right hip (~0.3 m out, 0.8 m up)
    { name: "standing", hand: [X + 0.245, Y + 0.11, GROUND + 0.796], atHand: false },
    // the place clip's release frame: 0.72 m out on the compass, 0.1 m up
    { name: "release", hand: [X + Math.sin(compass) * 0.72, Y + Math.cos(compass) * 0.72, GROUND + 0.1], atHand: true },
    // low, but at the feet (< 0.4 m out)
    { name: "feet", hand: [X + 0.05, Y + 0.05, GROUND + 0.05], atHand: false },
    // far enough out, but still 0.8 m up (a place clip cut before the hand reached the ground)
    { name: "high", hand: [X + Math.sin(compass) * 0.72, Y + Math.cos(compass) * 0.72, GROUND + 0.8], atHand: false },
  ];
  for (const k of cases) {
    const E = await setup();
    E.pilot.root.quaternion = quat;
    E.api.deploy({ quick: true });
    const props = E.R.props[0];
    props.worldPos = function worldPos(name, out) {
      if (this.at[name] === "none") return null;
      out[0] = k.hand[0];
      out[1] = k.hand[1];
      out[2] = k.hand[2];
      return out;
    };
    await untilState(E, "flying", 1500);
    const tw = props.calls.filter((c) => c[0] === "toWorld");
    const pl = props.calls.filter((c) => c[0] === "place");
    const lift = E.R.crafts[0].calls.find((c) => c[0] === "autopilot" && c[1] === "liftoff")[2];
    if (k.atHand) {
      assert.deepEqual([tw.length, pl.length], [1, 0], `${k.name}: dropped under the hand`);
    } else {
      assert.deepEqual([tw.length, pl.length], [0, 1], `${k.name}: never at the hand`);
      const pos = pl[0][2];
      near(Math.hypot(pos[0] - X, pos[1] - Y), 0.72, 1e-9, `${k.name}: 0.72 m out`);
      near(Math.atan2(pos[0] - X, pos[1] - Y), compass, 1e-9, `${k.name}: on the pilot compass`);
      near(pos[2], GROUND + 0.06, 1e-9, `${k.name}: rest height on the terrain`);
      near(pl[0][3], GB.wrapPi(compass + Math.PI), 1e-12, `${k.name}: facing the pilot`);
      near(Math.atan2(lift.to[0] - lift.from[0], lift.to[1] - lift.from[1]), compass, 1e-9, `${k.name}: the lift-off backs away straight ahead`);
      assert.deepEqual(lift.from, pos, `${k.name}: home is the drop spot`);
    }
    IDX._resetDroneForTest();
  }
});

check("P9 the tablet's home arrow: none at home (< 1 m, the OSD's rule), the bearing to home away from it", async () => {
  const E = await flying(); // quick deploy: tablet up, lift-off; screens only while the camera is not owned
  const p = E.R.props[0];
  const deployScreens = p.screenLog.slice();
  assert.ok(deployScreens.some((s) => s.distM < 1), "a screen with the drone at home (tablet up)");
  for (const s of deployScreens) {
    if (s.distM < 1) assert.ok(Number.isNaN(s.homeBearingRad), `at home (${s.distM} m): no arrow (got ${s.homeBearingRad})`);
    else assert.ok(Number.isFinite(s.homeBearingRad), `${s.distM} m out: an arrow`);
  }
  // Pilot view far from home: the compass bearing from the drone to home.
  E.R.ctl.sticks.pitch = 0.5;
  await frames(E, 60);
  E.R.ctl.sticks.pitch = 0;
  assert.deepEqual(E.api.pilotView(), { ok: true, state: "pilotView" });
  const n0 = p.screenLog.length;
  await frames(E, 90);
  const far = p.screenLog.slice(n0);
  assert.ok(far.length >= 5, `4 Hz screens in pilot view (${far.length} in 1.5 s)`);
  const last = far[far.length - 1];
  const st = E.api.status();
  const home = [LBX + 100, LBY + 100.72];
  assert.ok(last.distM > 5);
  near(GB.wrapPi(last.homeBearingRad - Math.atan2(home[0] - st.craft.pos[0], home[1] - st.craft.pos[1])), 0, 1e-3, "the bearing to home");
  // Without the drone in the world (a stale last distance): no arrow either.
  p.at.drone = "none";
  const n2 = p.screenLog.length;
  await frames(E, 40); // ≥ 2 of the 4 Hz screens whatever their phase (20 frames could hold just one)
  p.at.drone = "world";
  const gone = p.screenLog.slice(n2);
  assert.ok(gone.length >= 2 && gone.every((s) => s.live === false && s.distM > 5 && Number.isNaN(s.homeBearingRad)),
    "no drone in the world: no arrow");
  // A full RTH back onto home: the tablet-down screens show no arrow again.
  const n1 = p.screenLog.length;
  E.api.recall();
  await untilState(E, "stowing", 3000);
  await frames(E, 20);
  const back = p.screenLog.slice(n1);
  assert.ok(back.some((s) => s.distM < 1), "screens with the drone back on home");
  assert.ok(back.filter((s) => s.distM < 1).every((s) => Number.isNaN(s.homeBearingRad)), "no arrow at home after the RTH");
});

/** Deploy (quick) and stop in the cut window: the goggle cut ran (camera owned), T8 not yet. */
async function inCutWindow(o = {}) {
  const E = await setup(o);
  assert.equal(E.api.deploy({ quick: true }).ok, true);
  for (let k = 0; k < 1500; k += 1) {
    const st = E.api.status();
    assert.equal(st.state, "deploying", "deploying until the cut");
    if (st.camera.owned) return E;
    await frame(E);
  }
  throw new Error("the cut window was not reached");
}

check("P9 R / Tab / recall() / pilotView() after the goggle cut but before T8 take control first (the skip = T8), then apply", async () => {
  for (const how of ["key-r", "key-tab", "api-recall", "api-pilotView"]) {
    const E = await inCutWindow();
    const n0 = stateEvents(E.doc).length;
    let r = null;
    if (how === "key-r") E.R.controls[0].fire("returnHome");
    else if (how === "key-tab") E.R.controls[0].fire("pilotView");
    else if (how === "api-recall") r = E.api.recall();
    else r = E.api.pilotView();
    const want = how === "key-r" || how === "api-recall" ? "returning" : "pilotView";
    assert.equal(E.api.status().state, want, how);
    assert.deepEqual(stateEvents(E.doc).slice(n0).map((e) => e.state), ["flying", want], `${how}: T8 first, then the press`);
    if (r) assert.deepEqual(r, { ok: true, state: want }, how);
    const plans = E.R.crafts[0].calls.filter((c) => c[0] === "autopilot").map((c) => c[1]);
    assert.deepEqual(plans.slice(-2), [null, want === "returning" ? "rth" : "hold"], `${how}: T8's autopilot(null), then the press's plan`);
    assert.ok(E.R.osds[0].shows.some((s) => s[0] === "fpv"), `${how}: the pending osd(fpv) came with T8`);
    IDX._resetDroneForTest();
  }
  // Before the cut a press still answers not-flying and skips nothing.
  const E = await setup();
  E.api.deploy({ quick: true });
  await frames(E, 30);
  const before = E.api.status();
  assert.equal(before.camera.owned, false);
  assert.equal(E.api.recall().code, "not-flying");
  assert.equal(E.api.pilotView().code, "not-flying");
  assert.deepEqual([E.api.status().state, E.api.status().beat], ["deploying", before.beat], "the deploy was not skipped");
});

/** film clean_frame.js's funnel step: apply() snapshots the fault and poisons 'gate'; restore() puts the snapshot back blindly. */
function fakeCleanFrame(win) {
  let saved = null;
  return {
    apply() {
      const f = win.__inputFunnel;
      saved = { prevFault: f.snapshot().fault ?? null };
      f.poison("gate");
    },
    restore() {
      const f = win.__inputFunnel;
      if (saved.prevFault === null) f.unpoison();
      else f.poison(saved.prevFault);
      saved = null;
    },
  };
}

check("P9 a film take started mid-cycle: the 'gate' film puts back from its snapshot of our lock is cleared once film is idle (status / deploy)", async () => {
  const E = await flying();
  const f = E.win.__inputFunnel;
  let filmOn = false;
  E.win.__film = { status: () => ({ ok: true, active: filmOn, cameraOwned: false, clean: filmOn, take: { running: filmOn ? { mode: "realtime" } : null } }) };
  /** A take starts mid-cycle (the drone hard-aborts 'film' within 250 ms), then ends. */
  async function takeMidCycle() {
    assert.equal(f._fault, "gate", "the drone's gate");
    const cf = fakeCleanFrame(E.win);
    cf.apply(); // the take snapshots OUR gate
    filmOn = true;
    await frames(E, 20);
    assert.equal(E.api.status().state, "idle");
    assert.equal(E.api.status().lastAbort.reason, "film");
    assert.equal(f._fault, null, "our restore released our gate");
    return () => {
      cf.restore(); // the take ends: film puts back the gate it saw
      filmOn = false;
      assert.equal(f._fault, "gate", "an orphan gate (nobody owns it)");
    };
  }
  let end = await takeMidCycle();
  for (let k = 0; k < 3; k += 1) E.api.status();
  assert.equal(f._fault, null, "nothing settled while film is busy");
  end();
  E.api.status(); // the plugin's 500 ms launcher tick
  assert.equal(f._fault, null, "status() cleared the orphan gate");
  f.poison("gate"); // __diag.input.poison: not ours
  E.api.status();
  assert.equal(f._fault, "gate", "settled once: a later gate set by someone else stays");
  f.unpoison();
  // deploy() settles first, then locks with its own gate.
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  end = await takeMidCycle();
  end();
  assert.equal(E.api.deploy({ quick: true }).ok, true);
  assert.equal(E.R.controls[E.R.controls.length - 1].didPoison, true, "the new cycle found the slot open and holds its own gate");
  E.api.abort("session");
  assert.equal(f._fault, null);
  // A restore with film idle records nothing: a gate someone else sets afterwards stays.
  f.poison("gate"); // __diag.input.poison
  E.api.status();
  assert.equal(f._fault, "gate", "a restore outside a film take leaves nothing to settle");
  f.unpoison();
  // Only a slot that still reads 'gate' is cleared.
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  end = await takeMidCycle();
  end();
  f.poison("throw");
  E.api.status();
  assert.equal(f._fault, "throw", "another fault is never cleared");
  f.unpoison();
  // A gate someone else set before the deploy (never ours): kept, even when a take interleaves.
  f.poison("gate"); // __diag.input.poison
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  assert.equal(E.R.controls[E.R.controls.length - 1].didPoison, false, "the lock found the slot taken");
  const cf2 = fakeCleanFrame(E.win);
  cf2.apply();
  filmOn = true;
  await frames(E, 20);
  assert.equal(E.api.status().lastAbort.reason, "film");
  assert.equal(f._fault, "gate", "our restore leaves a gate that is not ours");
  cf2.restore();
  filmOn = false;
  E.api.status();
  assert.equal(f._fault, "gate", "and nothing settles it later (our restore released no gate)");
  f.unpoison();
  // Film still busy at the next deploy (no deps.refusal): that cycle gates the open slot itself,
  // and nothing is settled while it runs, even once the take ends; the pending settle runs at idle.
  E.api.deploy({ quick: true });
  await untilState(E, "flying", 1500);
  end = await takeMidCycle(); // our gate released inside the take: a settle is pending
  assert.equal(E.api.deploy({ quick: true }).ok, true, "film still busy: the deploy starts (no deps.refusal)");
  assert.equal(E.R.controls[E.R.controls.length - 1].didPoison, true, "the new cycle gates the open slot");
  end(); // the take ends mid-cycle: the slot reads the new cycle's own 'gate'
  E.api.status();
  assert.equal(f._fault, "gate", "a running cycle's own gate is never settled");
  await untilState(E, "flying", 1500);
  E.api.recall({ instant: true });
  await untilState(E, "idle", 4000);
  assert.equal(f._fault, null, "the cycle's own restore reopened the slot");
  E.api.status(); // the pending settle: nothing left to clear
  f.poison("gate"); // __diag.input.poison
  E.api.status();
  assert.equal(f._fault, "gate", "the settle ran once and is gone");
  f.unpoison();
  // A take with no cycle running: film's own gate is never touched.
  const cf = fakeCleanFrame(E.win);
  cf.apply();
  filmOn = true;
  E.api.status();
  assert.equal(f._fault, "gate");
  cf.restore();
  filmOn = false;
  E.api.status();
  assert.equal(f._fault, null);
});

check("P9 a film camera owner created first (film mode) survives a full drone cycle: its liveScene3d.film object and listeners stay", async () => {
  const { createCameraOwner } = await import("../scene3d/film/runtime/camera_owner.js");
  const E = await setup();
  // Film's install at init3D: its hooks object exists, idle (no listener until a take or scout).
  const filmOwner = createCameraOwner({ liveScene3d: E.live, THREE, window: E.win, log: () => {} });
  const filmHooks = E.live.film;
  assert.ok(filmHooks && filmHooks === filmOwner.hooks);
  /** One full drone cycle (quick deploy, FPV, instant recall, stow). */
  async function cycle() {
    E.api.deploy({ quick: true });
    assert.equal(E.live.film, filmHooks, "the drone shares film's hooks object");
    await untilState(E, "flying", 1500);
    assert.equal(E.api.status().camera.owned, true);
    E.api.recall({ instant: true });
    await untilState(E, "idle", 4000);
    assert.equal(E.live.film, filmHooks, "film's hooks object is still installed");
    assert.equal(Object.prototype.hasOwnProperty.call(E.cs, "positionCamera"), false, "the drone released the camera");
  }
  await cycle();
  assert.deepEqual([filmHooks.stats().preListeners, filmHooks.stats().postListeners], [0, 0], "none of the drone's listeners is left");
  // A take starts after the cycle: its frame grab subscribes through film's camera owner (take_player installGrab).
  let grabs = 0;
  const offGrab = filmOwner.onPostRender(() => { grabs += 1; });
  await frames(E, 10);
  assert.equal(grabs, 10, "the take's postRender listener runs every frame (the object the page calls)");
  // A second cycle while film's listener is subscribed: it stays subscribed and running.
  await cycle();
  assert.deepEqual([filmHooks.stats().preListeners, filmHooks.stats().postListeners], [0, 1], "only film's own listener is left");
  const g0 = grabs;
  await frames(E, 10);
  assert.equal(grabs, g0 + 10);
  assert.equal(filmOwner.own().ok, true, "film's camera owner still owns the camera");
  assert.equal(filmOwner.release().wasOwned, true);
  offGrab();
  filmOwner.dispose();
  assert.equal(E.live.film, undefined, "film's own dispose removes it once unshared");
});

check("P9 a death abort for a pilot who deployed from orbit: the orbit restore dispatches no Ready (the corpse stays down); the mode is the player's", async () => {
  const E = await setup();
  assert.equal(E.cs.mode, "orbit");
  E.api.deploy({ quick: true });
  assert.equal(E.cs.mode, "follow", "prepareFollowCamera left orbit");
  await untilState(E, "flying", 1500);
  assert.equal(E.cs._orbitRigStopped, false, "the follow ticks re-armed camera.js's orbit-entry latch");
  E.em.deathHeld = true;
  await frame(E);
  assert.deepEqual([E.api.status().state, E.api.status().lastAbort.reason], ["aborting", "death"]);
  assert.equal(E.cs.mode, "orbit", "the player's camera mode is back");
  await untilState(E, "idle", 1200);
  assert.equal(E.cs.readyDispatches, 0, "camera.js's orbit entry dispatched no Ready");
  assert.equal(E.R.gestures[0].calls.some((c) => c[0] === "release"), false, "and the drone sent none (DV-13)");
  // The fake is camera.js's latch: an orbit entry without it dispatches exactly one Ready.
  E.cs.switchMode("follow");
  E.cs.tickMovement();
  E.cs.switchMode("orbit");
  E.cs.tickMovement();
  E.cs.tickMovement();
  assert.equal(E.cs.readyDispatches, 1);
});

check("P9 H (clean view) ends when control comes back: osd.clean(false) right after controls.restore() (soft abort); nothing when H is off", async () => {
  const E = await flying();
  E.R.controls[0].fire("hideHud");
  const osd = E.R.osds[0];
  assert.deepEqual(osd.cleans, [true]);
  const order = [];
  const ctl = E.R.controls[0];
  const restore0 = ctl.restore.bind(ctl);
  ctl.restore = () => {
    order.push("restore");
    return restore0();
  };
  const clean0 = osd.clean.bind(osd);
  osd.clean = (on) => {
    order.push(`clean(${on})`);
    return clean0(on);
  };
  for (const fn of E.sinks) fn("damage", { current: 10 });
  await frame(E);
  assert.equal(E.api.status().state, "aborting");
  assert.deepEqual(order, ["restore", "clean(false)"], "the HUD and the cursor come back with the input (same executor)");
  await untilState(E, "idle", 1200);
  assert.deepEqual(osd.cleans, [true, false], "once");
  IDX._resetDroneForTest();
  const E2 = await flying();
  for (const fn of E2.sinks) fn("damage", { current: 10 });
  await frame(E2);
  assert.equal(E2.api.status().state, "aborting");
  assert.deepEqual(E2.R.osds[0].cleans, [], "H off: the OSD's clean view is not touched");
});

check("P9 a rig rebuild during the settle after a combat / death soft abort re-asserts no ReadState (DV-13)", async () => {
  for (const reason of ["combat", "death"]) {
    const E = await flying();
    const g = E.R.gestures[0];
    assert.equal(g.calls.filter((c) => c[0] === "hold").length, 1);
    if (reason === "combat") E.win.__getCurrentStanceLow = () => 0x3c;
    else E.em.deathHeld = true;
    await frame(E);
    assert.deepEqual([E.api.status().state, E.api.status().lastAbort.reason], ["aborting", reason]);
    assert.equal(g.calls.some((c) => c[0] === "release"), false, `${reason}: no Ready`);
    E.em.entityMap.set(GUID, makePilot()); // a same-guid rebuild inside the settle
    await frames(E, 20);
    assert.ok(g.calls.some((c) => c[0] === "rebind"), `${reason}: the rebuilt rig was re-bound`);
    assert.equal(g.calls.filter((c) => c[0] === "hold").length, 1, `${reason}: no ReadState on the rebuilt rig`);
    await untilState(E, "idle", 1200);
    IDX._resetDroneForTest();
  }
});

check("P9 deploy() while the WebGL context is lost is refused (not-in-world) and locks nothing", async () => {
  const E = await setup();
  E.live.__webglContextLost = true; // webgl_context_recovery._onLost (the loop is paused)
  assert.deepEqual(E.api.deploy(), { ok: false, code: "not-in-world", reason: "Enter the world first" });
  assert.deepEqual(E.api.button(), { ok: false, code: "not-in-world", reason: "Enter the world first", action: "deploy" });
  assert.equal(E.win.__inputFunnel._fault, null, "the funnel stays open");
  assert.equal(E.R.controls.length, 0, "no cycle was built");
  assert.equal(E.live.film, undefined);
  assert.equal(E.api.status().state, "idle");
  E.live.__webglContextLost = false; // cleared on restore
  assert.equal(E.api.deploy().ok, true);
});

// ---------------------------------------------------------------------------
// P10 the phase-4 fixes (the 1070 eye test, 2026-10-25)
// ---------------------------------------------------------------------------

const PX = LBX + 100;
const PY = LBY + 100; // the pilot's feet (makePilot), on the terrain at GROUND
const LB_KEY = ((0xa9 << 24) | (0xb4 << 16)) >>> 0; // the landblock every column lies in
const COVERED = Object.freeze({ ok: false, code: "covered", reason: "Needs open sky above you" });
/** The open-sky columns, metres ahead of the pilot: the pilot, the humanoid / no-hands drops, the lift-off end. */
const COLUMNS_M = Object.freeze([0, 0.72, 1.5, 0.72 + 3.4]);
/** The pilot's root quaternion for a compass heading (compass = −root yaw, CCW). */
const facing = (compass) => ({ x: 0, y: 0, z: Math.sin(-compass / 2), w: Math.cos(-compass / 2) });
/** A 30° slope through the pilot's feet (GROUND there), falling toward +y (north). */
const SLOPE_30 = Math.tan(Math.PI / 6);
const slopeZ = (x, y) => GROUND - SLOPE_30 * (y - PY);

/**
 * A fake wasm sweep layer of horizontal slabs `{x0, x1, y0, y1, z}` (AC world) — physics.rs
 * `sweep_sphere_against_triangles` for a sphere of radius r along from → to: the earliest contact
 * with a slab plane the sphere reaches (t where its surface touches the plane on the start side;
 * t = 0 when it starts within r of it), the normal toward the start side; nothing for a slab it
 * moves away from, never reaches or passes beside (xy inflated by r). Every call is recorded and
 * every hit box carries free() (los.js frees each one).
 */
function slabLayer(slabs = []) {
  const out = { slabs, calls: [], freed: 0 };
  out.fn = (fx, fy, fz, tx, ty, tz, r, key) => {
    out.calls.push({ from: [fx, fy, fz], to: [tx, ty, tz], r, key });
    let best = null;
    for (const s of slabs) {
      const d0 = fz - s.z;
      const dz = tz - fz;
      let t = 0;
      if (Math.abs(d0) > r) {
        if (Math.abs(dz) < 1e-12) continue;
        t = (Math.sign(d0) * r - d0) / dz;
        if (!(t >= 0 && t <= 1)) continue;
      }
      const cx = fx + (tx - fx) * t;
      const cy = fy + (ty - fy) * t;
      if (cx < s.x0 - r || cx > s.x1 + r || cy < s.y0 - r || cy > s.y1 + r) continue;
      if (best === null || t < best.t) best = { t, x: cx, y: cy, z: s.z, nz: d0 >= 0 ? 1 : -1 };
    }
    if (best === null) return undefined;
    return { t: best.t, x: best.x, y: best.y, z: best.z, normalX: 0, normalY: 0, normalZ: best.nz, free() { out.freed += 1; } };
  };
  return out;
}

/** Every wasm sweep layer on the env's session handle: the building mesh = the slabs; the rest find nothing. */
function roofWorld(E, slabs = []) {
  const roof = slabLayer(slabs);
  const counts = { buildingMesh: 0, statics: 0, scenery: 0, cellMesh: 0, cellStatics: 0, entities: 0, objects: 0 };
  const none = (k) => () => {
    counts[k] += 1;
    return undefined;
  };
  Object.assign(E.sh, {
    sweepSphereAgainstBuildingMesh: (...a) => {
      counts.buildingMesh += 1;
      return roof.fn(...a);
    },
    sweepSphereAgainstStatics: none("statics"),
    sweepSphereAgainstScenery: none("scenery"),
    sweepSphereAgainstCellMesh: none("cellMesh"),
    sweepSphereAgainstCellStatics: none("cellStatics"),
    sweepSphereAgainstEntities: none("entities"),
    sweepSphereAgainstObjects: none("objects"),
  });
  return { roof, counts };
}

const coveredEvents = (E) => E.api.debug.events({ limit: 200 }).events.filter((e) => e.message === "covered");

check("P10 F1 a roof over the pilot (the 1070 archway, 11.9 m up) → covered 'Needs open sky above you': idle, nothing built past the link, nothing left", async () => {
  let link = null;
  const createWorldLink = (d) => (link = WL.createWorldLink(d));
  const E = await setup({ modules: { createWorldLink } });
  // Over the pilot's column only (the drop spots 0.72 m+ ahead are past y1 + the body radius).
  const { roof, counts } = roofWorld(E, [{ x0: PX - 3, x1: PX + 3, y0: PY - 2, y1: PY + 0.3, z: GROUND + 11.9 }]);
  const adds = { win: 0, doc: 0, canvas: 0 };
  for (const [k, t] of [["win", E.win], ["doc", E.doc], ["canvas", E.canvas]]) {
    const add = t.addEventListener.bind(t);
    t.addEventListener = (...a) => {
      adds[k] += 1;
      return add(...a);
    };
  }
  const base = { win: E.win.count(), doc: E.doc.count(), canvas: E.canvas.count() };
  const funnel = E.win.__inputFunnel;
  const r = E.api.deploy();
  assert.deepEqual(r, COVERED);
  roundTrip(r);
  assert.equal(E.api.status().state, "idle", "the state stays idle");
  assert.deepEqual(stateEvents(E.doc), [], "no hb-drone-state event");
  assert.deepEqual(adds, { win: 0, doc: 0, canvas: 0 }, "no window / document / canvas listener was ever added");
  assert.deepEqual({ win: E.win.count(), doc: E.doc.count(), canvas: E.canvas.count() }, base);
  assert.deepEqual([funnel._fault, funnel.poisons.length], [null, 0], "the funnel untouched (refused before T1)");
  assert.equal(E.live.film, undefined, "liveScene3d.film went with the link");
  assert.ok(link, "the world link was built: the check sweeps through it");
  assert.deepEqual([link.stats().disposed, link.stats().listeners], [true, 0], "the link disposed, no hook listener");
  assert.equal(link.cameraOwner.owned, false);
  assert.equal(Object.prototype.hasOwnProperty.call(E.cs, "positionCamera"), false);
  assert.equal(E.cs.mode, "orbit", "the follow camera was never prepared");
  const R = E.R;
  assert.deepEqual([R.props.length, R.gestures.length, R.crafts.length, R.tethers.length, R.controls.length, R.osds.length,
    R.audios.length, R.prewarms.length], [0, 0, 0, 0, 0, 0, 0, 0], "nothing past the link was built");
  assert.equal(E.live.audioManager.resumed, 0, "no AudioContext resume");
  assert.equal(E.sinks.size, 0, "no bus subscription");
  assert.equal(counts.buildingMesh, 1, "the first column (the pilot) refused: no further sweep");
  assert.equal(roof.freed, 1, "the hit box was freed");
  const ev = coveredEvents(E);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].level, ev[0].aheadM, ev[0].layer, ev[0].kind], ["info", 0, "buildingMesh", "building"]);
  near(ev[0].roofM, 11.9, 1e-9, "the roof's height above the drop height");
  assert.deepEqual(E.api.button(), { ...COVERED, action: "deploy" });
  assert.equal(E.api.status().state, "idle");
  // Open sky again: the next deploy starts (the refusal left no cycle behind).
  roof.slabs.length = 0;
  assert.deepEqual(E.api.deploy(), { ok: true, state: "deploying", quick: false });
  assert.equal(funnel._fault, "gate");
  assert.equal(R.controls.length, 1);
});

check("P10 F1 a roof over the lift-off end only (4.12 m ahead on the pilot's compass) refuses too; film's own hooks object stays installed", async () => {
  const { ensureFilmHooks } = await import("../scene3d/film/runtime/camera_owner.js");
  const E = await setup();
  const compass = -0.9;
  E.pilot.root.quaternion = facing(compass);
  const ex = PX + Math.sin(compass) * 4.12;
  const ey = PY + Math.cos(compass) * 4.12;
  const { roof } = roofWorld(E, [{ x0: ex - 0.3, x1: ex + 0.3, y0: ey - 0.3, y1: ey + 0.3, z: GROUND + 9 }]);
  const film = ensureFilmHooks(E.live); // film mode's install at init3D
  assert.deepEqual(E.api.deploy({ quick: true }), COVERED);
  assert.equal(roof.calls.length, 4, "every column swept: the first three are clear");
  const ev = coveredEvents(E);
  near(ev[0].aheadM, 4.12, 1e-12, "the lift-off end");
  near(ev[0].roofM, 9, 1e-9);
  assert.equal(E.live.film, film, "film's hooks object stays");
  assert.deepEqual([film.stats().preListeners, film.stats().postListeners], [0, 0], "none of ours on it");
  assert.equal(E.api.status().state, "idle");
  assert.deepEqual([E.R.controls.length, E.R.props.length], [0, 0]);
  assert.equal(E.win.__inputFunnel._fault, null);
});

check("P10 F1 the columns (the pilot, 0.72 / 1.5 / 4.12 m ahead) run 0.5 → 16.5 m above the terrain there (30° slope), body radius; clutter under 0.5 m, an overhang over 16.5 m, a body or a door never refuse", async () => {
  const E = await setup();
  const compass = 0.6;
  E.pilot.root.quaternion = facing(compass);
  E.sh.terrainHeightAt = (x, y) => slopeZ(x, y); // the pilot stands on it (GROUND at the feet)
  const cols = COLUMNS_M.map((a) => [PX + Math.sin(compass) * a, PY + Math.cos(compass) * a]);
  const slabs = [];
  for (const [x, y] of cols) {
    const g = slopeZ(x, y);
    // ground clutter 0.25 m up and an overhang 17 m up, over this column only
    slabs.push({ x0: x - 0.1, x1: x + 0.1, y0: y - 0.1, y1: y + 0.1, z: g + 0.25 }, { x0: x - 0.1, x1: x + 0.1, y0: y - 0.1, y1: y + 0.1, z: g + 17 });
  }
  const { roof, counts } = roofWorld(E, slabs);
  // A player / NPC body and a door leaf over every column (the objects / entities layers): never a roof.
  const box = () => ({ t: 0.3, x: PX, y: PY, z: GROUND + 2, normalX: 0, normalY: 0, normalZ: -1, free() {} });
  E.sh.sweepSphereAgainstObjects = () => {
    counts.objects += 1;
    return box();
  };
  E.sh.sweepSphereAgainstEntities = () => {
    counts.entities += 1;
    return box();
  };
  const r = E.api.deploy({ quick: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(counts, { buildingMesh: 4, statics: 4, scenery: 4, cellMesh: 0, cellStatics: 0, entities: 0, objects: 0 },
    "one sweep per roof layer and column; no cell ids outdoors; bodies and doors never swept");
  assert.equal(coveredEvents(E).length, 0);
  for (let k = 0; k < COLUMNS_M.length; k += 1) {
    const call = roof.calls[k];
    const [x, y] = cols[k];
    const g = slopeZ(x, y);
    near(call.from[0], x, 1e-9, `column ${COLUMNS_M[k]} x`);
    near(call.from[1], y, 1e-9, `column ${COLUMNS_M[k]} y`);
    near(call.to[0], x, 1e-9);
    near(call.to[1], y, 1e-9);
    near(call.from[2] - g, 0.5, 1e-9, `column ${COLUMNS_M[k]}: from 0.5 m above the terrain there`);
    near(call.to[2] - g, 16.5, 1e-9, `column ${COLUMNS_M[k]}: to OPEN_SKY_M 16.5 m`);
    near(call.r, 0.18, 1e-12, "the drone's body radius");
    assert.equal(call.key, LB_KEY);
  }
  // Clear sky with every layer present but the cell ones, and with none (the existing fake handle): both deploy.
  IDX._resetDroneForTest();
  const E2 = await setup();
  assert.equal(typeof E2.sh.sweepSphereAgainstBuildingMesh, "undefined", "the plain fake handle has no sweep method");
  assert.deepEqual(E2.api.deploy(), { ok: true, state: "deploying", quick: false }, "a missing sweep method reads as open sky");
});

check("P10 F1 a pilot on a 1 m platform: the columns start 0.5 m above the platform (the drop height), so its floor is no roof; a roof over it still refuses", async () => {
  const E = await setup();
  E.pilot.root.position.z = GROUND + 1; // the terrain stays at GROUND (groundZ is terrain-only)
  const floor = { x0: PX - 10, x1: PX + 10, y0: PY - 10, y1: PY + 10, z: GROUND + 1 };
  const { roof } = roofWorld(E, [floor]);
  const r = E.api.deploy({ quick: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(roof.calls.length, 4);
  assert.ok(roof.calls.every((c) => Math.abs(c.from[2] - (GROUND + 1.5)) < 1e-9 && Math.abs(c.to[2] - (GROUND + 17.5)) < 1e-9),
    "every column runs from 0.5 m to 16.5 m above the platform");
  E.api.abort("session");
  assert.equal(E.api.status().state, "idle");
  roof.slabs.push({ ...floor, z: GROUND + 1 + 6 }); // a roof 6 m over the platform
  assert.deepEqual(E.api.deploy({ quick: true }), COVERED);
  near(coveredEvents(E)[0].roofM, 6, 1e-9);
});

check("P10 F1 a throwing open-sky check reads as open sky: the deploy starts, a warn per column, no throw", async () => {
  const createWorldLink = (d) => {
    const l = WL.createWorldLink(d);
    l.los = { segmentBlocked() { throw new Error("los boom"); } };
    return l;
  };
  const E = await setup({ modules: { createWorldLink } });
  const r = E.api.deploy({ quick: true });
  assert.deepEqual(r, { ok: true, state: "deploying", quick: true });
  const warns = E.logs.filter((l) => l.level === "warn" && /open-sky check failed: los boom/.test(l.message));
  assert.equal(warns.length, COLUMNS_M.length, "one warn per column");
  assert.equal(coveredEvents(E).length, 0);
});

check("P10 F1 the open-sky sweeps run on the link's session handle (deps.getSessionHandle, then liveScene3d.sessionHandle, then window.__sessionHandle); no handle at all reads as open sky", async () => {
  /** A handle whose building mesh holds a roof 8 m over the pilot (the env's plain handle has no sweep method). */
  const roofed = () => {
    const roof = slabLayer([{ x0: PX - 3, x1: PX + 3, y0: PY - 3, y1: PY + 3, z: GROUND + 8 }]);
    return { roof, h: { terrainHeightAt: () => GROUND, isPlayerReady: () => true, sweepSphereAgainstBuildingMesh: roof.fn } };
  };
  // The getter's handle wins over liveScene3d's init3D handle and window.__sessionHandle (both the plain one).
  let A = roofed();
  let E = await setup({ deps: { getSessionHandle: () => A.h } });
  assert.deepEqual(E.api.deploy(), COVERED, "deps.getSessionHandle()");
  assert.equal(A.roof.calls.length, 1);
  IDX._resetDroneForTest();
  // No getter answer → liveScene3d.sessionHandle, before window.__sessionHandle.
  A = roofed();
  E = await setup({ deps: { getSessionHandle: () => null } });
  E.live.sessionHandle = A.h;
  assert.deepEqual(E.api.deploy(), COVERED, "liveScene3d.sessionHandle");
  IDX._resetDroneForTest();
  // Then window.__sessionHandle.
  A = roofed();
  E = await setup({ deps: { getSessionHandle: () => null } });
  E.live.sessionHandle = null;
  E.win.__sessionHandle = A.h;
  assert.deepEqual(E.api.deploy(), COVERED, "window.__sessionHandle");
  IDX._resetDroneForTest();
  // No handle anywhere: the roof is there but nothing can sweep it → open sky (no throw, no false refusal).
  A = roofed();
  E = await setup({ deps: { getSessionHandle: () => null } });
  E.live.sessionHandle = null;
  E.win.__sessionHandle = null;
  assert.deepEqual(E.api.deploy({ quick: true }), { ok: true, state: "deploying", quick: true }, "no handle → open sky");
  assert.equal(A.roof.calls.length, 0);
  assert.equal(coveredEvents(E).length, 0);
  assert.deepEqual(E.logs.filter((l) => /open-sky|deploy failed/.test(String(l.message))), []);
});

check("P10 F1 the open-sky check runs last: a page refusal (`moving`) and an own not-in-world check win over a roof, with no world link built and nothing swept", async () => {
  let code = "moving";
  let links = 0;
  const createWorldLink = (d) => {
    links += 1;
    return WL.createWorldLink(d);
  };
  const E = await setup({ deps: { refusal: () => code }, modules: { createWorldLink } });
  const { roof } = roofWorld(E, [{ x0: PX - 3, x1: PX + 3, y0: PY - 3, y1: PY + 3, z: GROUND + 8 }]);
  assert.deepEqual(E.api.deploy(), { ok: false, code: "moving", reason: "Stand still to deploy" });
  code = null;
  const cs = E.live.cameraSwitcher;
  E.live.cameraSwitcher = null;
  assert.equal(E.api.deploy().code, "not-in-world");
  E.live.cameraSwitcher = cs;
  assert.deepEqual([links, roof.calls.length], [0, 0], "no link, no sweep before every other check passed");
  assert.deepEqual(E.api.deploy(), COVERED, "then the roof refuses");
  assert.deepEqual([links, roof.calls.length], [1, 1]);
});

/** The drone's resting point right after the drop: [x, y, z] from the props call, and status().craft.aglM. */
async function dropAndAgl(E) {
  let agl = null;
  for (let f = 0; f < 1500 && agl === null; f += 1) {
    await frame(E);
    const c = E.api.status().craft;
    if (c) agl = c.aglM;
  }
  const props = E.R.props[0];
  const d = props.calls.find((c) => c[0] === "toWorld" || c[0] === "place");
  assert.ok(d, "the drone was dropped");
  const pos = d[0] === "place" ? d[2] : (props.dropPos ?? null); // toWorld: the test's override records it
  return { how: d[0], pos, agl, call: d };
}

check("P10 F2 a pilot on a 30° slope: the drop follows the terrain at the drop spot — humanoid 0.72 m (at the hand downhill, placed uphill) and no-hands 1.5 m both ways, AGL 0.06", async () => {
  const cases = [
    { name: "humanoid downhill", profile: HUMANOID, compass: 0, out: 0.72, how: "toWorld" },
    { name: "humanoid uphill", profile: HUMANOID, compass: Math.PI, out: 0.72, how: "place" }, // the hand > 0.3 m above the feet
    { name: "no-hands downhill", profile: NO_HANDS, compass: 0, out: 1.5, how: "place" },
    { name: "no-hands uphill", profile: NO_HANDS, compass: Math.PI, out: 1.5, how: "place" },
  ];
  for (const k of cases) {
    const E = await setup(k.profile === NO_HANDS ? { profile: NO_HANDS, profileFrame: 1, readyFrame: 2 } : {});
    E.sh.terrainHeightAt = (x, y) => slopeZ(x, y);
    E.pilot.root.quaternion = facing(k.compass);
    assert.equal(E.api.deploy({ quick: true }).ok, true, k.name);
    if (k.profile === HUMANOID) {
      // The place clip's release frame: the hand 0.72 m out on the compass, 0.1 m above the terrain there.
      const hx = PX + Math.sin(k.compass) * 0.72;
      const hy = PY + Math.cos(k.compass) * 0.72;
      const props = E.R.props[0];
      props.worldPos = function worldPos(name, out) {
        if (this.at[name] === "none") return null;
        out[0] = hx;
        out[1] = hy;
        out[2] = slopeZ(hx, hy) + 0.1;
        return out;
      };
      props.toWorld = function toWorld(name, groundZ, yaw) {
        this.calls.push(["toWorld", name, groundZ, yaw]);
        this.at[name] = "world";
        this.dronePos = [hx, hy, groundZ + 0.06];
        this.dropPos = this.dronePos.slice();
        return { ok: true, pos: this.dronePos.slice() };
      };
    }
    const d = await dropAndAgl(E);
    assert.equal(d.how, k.how, `${k.name}: ${k.how}`);
    near(Math.hypot(d.pos[0] - PX, d.pos[1] - PY), k.out, 1e-9, `${k.name}: ${k.out} m out`);
    const ground = slopeZ(d.pos[0], d.pos[1]);
    assert.ok(Math.abs(ground - GROUND) > 0.4, `${k.name}: the drop spot's terrain is off the feet (${ground - GROUND} m)`);
    near(d.pos[2] - ground, 0.06, 0.01, `${k.name}: AGL at the drop`);
    near(d.agl, 0.06, 0.01, `${k.name}: status().craft.aglM`);
    IDX._resetDroneForTest();
  }
});

check("P10 F2 a 40° slope, where the humanoid drop 0.72 m out is 0.6 m off the feet (past DV-22's 0.5 m, unlike 30°): the hand drop downhill (toWorld) and the place uphill both rest on the terrain there", async () => {
  const SLOPE_40 = Math.tan((40 * Math.PI) / 180);
  const slope40 = (x, y) => GROUND - SLOPE_40 * (y - PY);
  for (const k of [{ name: "downhill hand drop", compass: 0, how: "toWorld" }, { name: "uphill place", compass: Math.PI, how: "place" }]) {
    const E = await setup();
    E.sh.terrainHeightAt = (x, y) => slope40(x, y);
    E.pilot.root.quaternion = facing(k.compass);
    assert.equal(E.api.deploy({ quick: true }).ok, true, k.name);
    // The place clip's release frame: the hand 0.72 m out on the compass, 0.1 m above the terrain there.
    const hx = PX + Math.sin(k.compass) * 0.72;
    const hy = PY + Math.cos(k.compass) * 0.72;
    const props = E.R.props[0];
    props.worldPos = function worldPos(name, out) {
      if (this.at[name] === "none") return null;
      out[0] = hx;
      out[1] = hy;
      out[2] = slope40(hx, hy) + 0.1;
      return out;
    };
    props.toWorld = function toWorld(name, groundZ, yaw) {
      this.calls.push(["toWorld", name, groundZ, yaw]);
      this.at[name] = "world";
      this.dronePos = [hx, hy, groundZ + 0.06];
      this.dropPos = this.dronePos.slice();
      return { ok: true, pos: this.dronePos.slice() };
    };
    const d = await dropAndAgl(E);
    assert.equal(d.how, k.how, `${k.name}: ${k.how}`);
    near(Math.hypot(d.pos[0] - PX, d.pos[1] - PY), 0.72, 1e-9, `${k.name}: 0.72 m out`);
    const ground = slope40(d.pos[0], d.pos[1]);
    assert.ok(Math.abs(ground - GROUND) > 0.5, `${k.name}: the drop spot's terrain is past DV-22's 0.5 m (${ground - GROUND} m)`);
    near(d.pos[2] - ground, 0.06, 0.01, `${k.name}: AGL at the drop`);
    near(d.agl, 0.06, 0.01, `${k.name}: status().craft.aglM`);
    IDX._resetDroneForTest();
  }
});

check("P10 F2 a pilot standing 1 m above the terrain (a platform) keeps the foot level (DV-22): the no-hands place and the humanoid hand drop", async () => {
  for (const profile of [NO_HANDS, HUMANOID]) {
    const E = await setup(profile === NO_HANDS ? { profile: NO_HANDS, profileFrame: 1, readyFrame: 2 } : {});
    E.pilot.root.position.z = GROUND + 1; // flat terrain at GROUND, 1 m below the feet
    assert.equal(E.api.deploy({ quick: true }).ok, true);
    const props = E.R.props[0];
    if (profile === HUMANOID) {
      props.worldPos = function worldPos(name, out) {
        if (this.at[name] === "none") return null;
        out[0] = PX;
        out[1] = PY + 0.72;
        out[2] = GROUND + 1.1; // the release frame, on the platform
        return out;
      };
    }
    const d = await dropAndAgl(E);
    if (profile === HUMANOID) {
      assert.equal(d.how, "toWorld");
      near(d.call[2], GROUND + 1, 1e-9, "humanoid: dropped onto the feet level");
    } else {
      assert.equal(d.how, "place");
      near(d.pos[2], GROUND + 1 + 0.06, 1e-9, "no-hands: placed at the feet level");
    }
    IDX._resetDroneForTest();
  }
});

check("P10 F2 'on the terrain' = the terrain under the feet within 0.25 m: 0.2 m over (or under) a 30° slope still drops onto the terrain, 0.3 m over it keeps the feet (DV-22)", async () => {
  for (const [liftM, onTerrain] of [[0.2, true], [-0.2, true], [0.3, false]]) {
    const E = await setup({ profile: NO_HANDS, profileFrame: 1, readyFrame: 2 });
    E.sh.terrainHeightAt = (x, y) => slopeZ(x, y);
    E.pilot.root.position.z = GROUND + liftM; // the terrain under the feet stays at GROUND
    E.pilot.root.quaternion = facing(0); // downhill: the terrain 1.5 m ahead is 0.87 m under GROUND
    assert.equal(E.api.deploy({ quick: true }).ok, true, `${liftM} m`);
    const d = await dropAndAgl(E);
    assert.equal(d.how, "place");
    const want = onTerrain ? slopeZ(d.pos[0], d.pos[1]) : GROUND + liftM;
    near(d.pos[2], want + 0.06, 1e-9, `${liftM} m off the terrain: ${onTerrain ? "the terrain at the drop spot" : "the feet"}`);
    IDX._resetDroneForTest();
  }
});

check("P11 the way home (owner 2026-10-25): 3 s in the goggles with a countdown, then the cut and the drone put over home; instant close by comes straight down; pilot view flies a near drone home, puts a far one over home", async () => {
  const home = [LBX + 100, LBY + 100.72, GROUND + 0.06];
  const last = (calls, name) => calls.filter((c) => c[0] === name).pop();
  const flyNorth = async (E, sec) => {
    E.R.ctl.sticks.pitch = 1; // the fake craft: 10 m/s north
    await frames(E, Math.round(sec * 60));
    E.R.ctl.sticks.pitch = 0;
    await frames(E, 2);
  };
  // (a) a recall from the goggles: the return starts as before, the view stays 3 s, then cuts.
  {
    const E = await flying();
    const craft = E.R.crafts[0], tether = E.R.tethers[0];
    const dropYaw = E.R.props[0].calls.find((c) => c[0] === "toWorld")[3];
    await flyNorth(E, 3);
    assert.deepEqual(E.api.recall(), { ok: true, state: "returning" });
    assert.equal(last(craft.calls, "autopilot")[1], "rth", "the return starts the old way");
    assert.equal(last(tether.calls, "planReturn")[3].cruiseAglM, 15);
    await frames(E, 12);
    assert.equal(E.api.status().camera.owned, true, "still in the goggles");
    const sec = E.R.osds[0].lastView.banners.returningSec;
    assert.ok(sec > 2 && sec < 3, `the OSD counts down the grace (${sec})`);
    const nReset = craft.calls.filter((c) => c[0] === "reset").length;
    await frames(E, 180);
    assert.equal(E.api.status().camera.owned, false, "cut to the pilot after the grace");
    assert.equal(E.R.osds[0].lastView.banners.returningSec, null, "no countdown once it cannot be cancelled");
    const resets = craft.calls.filter((c) => c[0] === "reset");
    assert.equal(resets.length, nReset + 1, "put over home once");
    const r = resets[resets.length - 1];
    assert.deepEqual(r[1], [home[0], home[1], home[2] + 5], "5 m over the drop spot");
    assert.equal(r[2], dropYaw, "facing the way it was set down");
    assert.equal(r[3], false, "in the air");
    const pr = last(tether.calls, "planReturn");
    assert.deepEqual(pr[1], [home[0], home[1], home[2] + 5]);
    assert.equal(pr[3].cruiseAglM, 5);
    const ap = last(craft.calls, "autopilot");
    assert.equal(ap[1], "rth");
    assert.equal(ap[2].yaw, dropYaw);
    await untilState(E, "idle", 3000);
    IDX._resetDroneForTest();
  }
  // (b) instant recall right after the lift-off (3.8 m from home): no jump, straight down.
  {
    const E = await flying();
    const craft = E.R.crafts[0], tether = E.R.tethers[0];
    const nReset = craft.calls.filter((c) => c[0] === "reset").length;
    assert.deepEqual(E.api.recall({ instant: true }), { ok: true, state: "returning" });
    assert.equal(E.api.status().camera.owned, false, "the view cuts at once");
    assert.equal(craft.calls.filter((c) => c[0] === "reset").length, nReset, "no jump");
    assert.equal(last(tether.calls, "planReturn")[3].cruiseAglM, 0, "no climb");
    assert.equal(last(craft.calls, "autopilot")[1], "rth");
    await untilState(E, "idle", 3000);
    IDX._resetDroneForTest();
  }
  // (c) pilot view, the drone ~10 m out: it flies home at the approach height (no jump in view).
  {
    const E = await flying();
    const craft = E.R.crafts[0], tether = E.R.tethers[0];
    await flyNorth(E, 1);
    assert.deepEqual(E.api.pilotView(), { ok: true, state: "pilotView" });
    await frames(E, 5);
    const nReset = craft.calls.filter((c) => c[0] === "reset").length;
    E.api.recall();
    assert.equal(craft.calls.filter((c) => c[0] === "reset").length, nReset, "flies home in view");
    assert.equal(last(tether.calls, "planReturn")[3].cruiseAglM, 5);
    await untilState(E, "idle", 3000);
    IDX._resetDroneForTest();
  }
  // (d) pilot view, the drone ~40 m out: too far to see, so it is put over home.
  {
    const E = await flying();
    const craft = E.R.crafts[0];
    await flyNorth(E, 4);
    E.api.pilotView();
    await frames(E, 5);
    const nReset = craft.calls.filter((c) => c[0] === "reset").length;
    E.api.recall();
    const resets = craft.calls.filter((c) => c[0] === "reset");
    assert.equal(resets.length, nReset + 1, "put over home");
    assert.deepEqual(resets[resets.length - 1][1], [home[0], home[1], home[2] + 5]);
    await untilState(E, "idle", 3000);
    IDX._resetDroneForTest();
  }
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`drone_api: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
