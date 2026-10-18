// tests/film_review_film1_5.test.mjs
//
// WHY: the 2026-10-18 systematic review (docs/2026-10-18-systematic-code-review.md)
// confirmed five film-mode bugs. Each one ruins footage or leaves the 1070's
// browser in a film state, and none had a test that could fail for it. This
// suite EXECUTES the real modules (camera_owner, take_player + the REAL film
// clock, recorder, film/index.js installFilmMode + look, clean_frame + the REAL
// nameplate_sprite LOD) against fakes, and every check fails on the code
// before its fix:
//   FILM-1 camera_owner: in a DUNGEON (no building around it, cells not
//          SeenOutside) an eye outside the carried cell's box never escapes to
//          the outdoor landcell (cells.js would drop the whole dungeon): a cut
//          to the site's room with the camera two rooms away, an eye in the rock
//          between rooms, a player-head seed line through a wall (review extra);
//          a building room (SeenOutside) still escapes to the landscape;
//   FILM-2 take_player: a stepped take below the clock's 10 fps floor steps the
//          REAL film clock ⌈10/fps⌉ times per film frame, so the world clock,
//          the FX time and the time-lapse move 1/fps per grabbed frame;
//   FILM-3 recorder: abort() after a grab failure closes the configured encoder
//          (directly, and through a failing stepped shoot);
//   FILM-4 film/index.js: release() (the CLI's `status --release`) and
//          dispose() undo the take's look (sky pin, fog override, exposure);
//          dispose() also drops the film avatar hide;
//   FILM-5 clean_frame: a nameplate the REAL nameplate_sprite LOD re-shows
//          stays off every camera layer while the frame is clean.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these modules load only under it.
// Run from apps/holtburger-web/: node tests/film_review_film1_5.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const CO = await import("../scene3d/film/runtime/camera_owner.js");
const CK = await import("../scene3d/film/runtime/film_clock.js");
const TP = await import("../scene3d/film/runtime/take_player.js");
const REC = await import("../scene3d/film/runtime/recorder.js");
const CF = await import("../scene3d/film/runtime/clean_frame.js");
const API = await import("../scene3d/film/index.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const UNITS = await import("../scene3d/film/core/units.js");
const NP = await import("../scene3d/nameplate_sprite.js");

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
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const hex = (c) => `0x${(c >>> 0).toString(16)}`;

// ---------------------------------------------------------------------------
// FILM-1 the film viewer cell in a dungeon
// ---------------------------------------------------------------------------

const DLB = 0x01d90000;
const DX = 0x01 * 192;
const DY = 0xd9 * 192;
const A = (DLB | 0x101) >>> 0;
const B = (DLB | 0x102) >>> 0;
const C = (DLB | 0x103) >>> 0;
const D = (DLB | 0x104) >>> 0;
/** Rooms [cell, x0, x1, y0, y1] (landblock-local m), all z −50..−40: A–B–C in a row, D north of C. */
const ROOMS = [[A, 10, 20, 10, 20], [B, 20, 40, 10, 20], [C, 40, 60, 10, 20], [D, 40, 60, 20, 40]];
const PORTALS = new Map([[A, [B]], [B, [A, C]], [C, [B, D]], [D, [C]]]);

/** The room containing the AC world point, else 0. */
function roomAt(x, y, z) {
  for (const [cell, x0, x1, y0, y1] of ROOMS) {
    if (x >= DX + x0 && x < DX + x1 && y >= DY + y0 && y < DY + y1 && z >= -50 && z <= -40) return cell;
  }
  return 0;
}

/**
 * A sealed dungeon with the wasm walk's rules (scene.rs resolve_viewer_cell):
 * seeded in an EnvCell, the start must be in the seed or a portal neighbour
 * (else the seed comes back unchanged), the 0.25 m walk follows portals and a
 * wall exit keeps the last cell (no portal leads outdoors); seeded outdoors,
 * viewer_cell_outdoors finds no building transit cells and answers the outdoor
 * landcell under the point. `seenOutside` is the cells' SeenOutside bit.
 */
function makeDungeon({ seenOutside = false } = {}) {
  const res = (carried, x, y, z) => {
    const c = roomAt(x, y, z);
    if (c !== 0 && c === carried) return carried;
    return c !== 0 && (PORTALS.get(carried) || []).includes(c) ? c : null;
  };
  const sh = {
    resolveCalls: 0,
    resolveViewerCell(fx, fy, fz, tx, ty, tz, _r, seed) {
      this.resolveCalls += 1;
      if ((seed & 0xffff) < 0x100) return UNITS.localFromWorld(tx, ty, tz).cellId >>> 0;
      if (res(seed, fx, fy, fz) === null) return seed >>> 0;
      let carried = seed >>> 0;
      const n = Math.max(1, Math.ceil(Math.hypot(tx - fx, ty - fy, tz - fz) / 0.25));
      for (let i = 1; i <= n; i += 1) {
        const t = i / n;
        const r = res(carried, fx + (tx - fx) * t, fy + (ty - fy) * t, fz + (tz - fz) * t);
        if (r === null) return carried;
        carried = r;
      }
      return carried;
    },
    isCellSeenOutside: () => seenOutside,
    getLocalPlayerPose() {
      return { landblockId: A, x: 15, y: 15, z: -50, heading: 0, free() {} };
    },
  };
  // cells.js shape: identity container → "mesh-<cell>" group at the cell origin → surface meshes.
  const cellContainers3d = new Map();
  for (const [cell, x0, x1, y0, y1] of ROOMS) {
    const c = new THREE.Group();
    const g = new THREE.Group();
    g.name = `mesh-${cell.toString(16)}`;
    g.position.set(DX + x0, DY + y0, -50);
    const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, 10);
    geo.translate((x1 - x0) / 2, (y1 - y0) / 2, 5);
    g.add(new THREE.Mesh(geo));
    c.add(g);
    cellContainers3d.set(cell, c);
  }
  const persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const cs = { persp, activeCamera: persp, mode: "follow", followYaw: 0, followPitch: 0, positionCamera() {}, switchMode(m) { this.mode = m; } };
  const live = { cameraSwitcher: cs, sessionHandle: sh, camera: persp, cellContainers3d };
  const owner = CO.createCameraOwner({ liveScene3d: live, THREE, sessionHandle: sh, window: {} });
  const at = (x, y, z = -45) => ({ pos: [DX + x, DY + y, z], h: 0, p: 0, fov: 60 });
  return { sh, live, owner, at };
}

check("FILM-1 a cut to the site's room with the camera two rooms away lands in the eye's room, never outdoors", () => {
  const { live, owner, at } = makeDungeon();
  owner.own();
  owner.setCutCell(A); // the indoor site's anchor cell; the dolly starts in C
  owner.write(at(55, 15));
  assert.equal(hex(owner.viewerCell()), hex(C), "the cut cell is corrected to the room the eye is in");
  for (let k = 1; k <= 3; k += 1) {
    owner.write(at(55 - k * 0.5, 15));
    assert.equal(hex(owner.viewerCell()), hex(C), `frame ${k}: still in C (old code: the outdoor landcell)`);
    assert.equal(owner.viewerIndoor(), true);
    assert.deepEqual(live.filmViewer, { cell: C });
  }
  // The dolly carries on through the portal into B.
  owner.write(at(35, 15));
  assert.equal(hex(owner.viewerCell()), hex(B));
});

check("FILM-1 an eye in the rock between rooms keeps the dungeon cell; back in the room it is that room again", () => {
  const { owner, at } = makeDungeon();
  owner.own();
  owner.setCutCell(B);
  owner.write(at(30, 15));
  assert.equal(hex(owner.viewerCell()), hex(B));
  const escapes = owner.stats().cellEscapes;
  owner.write(at(30, 25)); // 5 m north of B's wall, in no room
  assert.equal(hex(owner.viewerCell()), hex(B), "the walk's dungeon cell stands (old code: the outdoor landcell)");
  assert.equal(owner.viewerIndoor(), true);
  assert.equal(owner.stats().cellEscapes, escapes, "nothing better was found");
  owner.write(at(30, 15));
  assert.equal(hex(owner.viewerCell()), hex(B));
});

check("FILM-1 (review extra) a player-head seed line through a wall still reaches the eye's dungeon room", () => {
  const { owner, at } = makeDungeon();
  owner.own();
  // No cut: the head (room A) → eye (room D) line leaves B through its north wall.
  owner.write(at(50, 35));
  assert.equal(hex(owner.viewerCell()), hex(D), "re-resolved by the room box that holds the eye");
  assert.ok(owner.stats().cellEscapes >= 1);
});

check("FILM-1 a SeenOutside (building) room left through a wall still escapes to the landscape (Bandit Castle)", () => {
  const { owner, at } = makeDungeon({ seenOutside: true });
  owner.own();
  owner.setCutCell(B);
  owner.write(at(30, 15));
  const eye = at(30, 25);
  owner.write(eye);
  const outdoor = UNITS.localFromWorld(eye.pos[0], eye.pos[1], eye.pos[2]).cellId >>> 0;
  assert.equal(hex(owner.viewerCell()), hex(outdoor));
  assert.equal(owner.viewerIndoor(), false);
});

// ---------------------------------------------------------------------------
// FILM-2 / FILM-3 stepped takes on the REAL film clock
// ---------------------------------------------------------------------------

/** A minimal WebCodecs encoder: one Annex-B chunk per frame. */
function encoderClass() {
  const instances = [];
  class E {
    static async isConfigSupported(cfg) {
      return { supported: true, config: cfg };
    }
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = "unconfigured";
      this.encodeQueueSize = 0;
      this.closes = 0;
      this.seq = 0;
      instances.push(this);
    }
    configure(cfg) {
      this.config = cfg;
      this.state = "configured";
    }
    encode(frame, opts) {
      if (this.state !== "configured") throw new Error(`encode in state ${this.state}`);
      const key = !!(opts && opts.keyFrame);
      const bytes = new Uint8Array([0, 0, 0, 1, key ? 0x65 : 0x41, this.seq++ & 0xff, 7, 7]);
      this.output({ type: key ? "key" : "delta", timestamp: frame.timestamp, duration: frame.duration, byteLength: bytes.length, copyTo: (dst) => dst.set(bytes) });
    }
    async flush() {}
    close() {
      this.closes += 1;
      this.state = "closed";
    }
  }
  E.instances = instances;
  return E;
}

/**
 * The take player on the REAL film clock and recorder. `__renderOnce(ts)` stamps
 * frameTime, runs preFrame and postRender a microtask later (index.js tick()); each
 * VideoFrame remembers the world state of the frame it wraps.
 */
function steppedRig({ failGrabAt = null } = {}) {
  let wall = 1000;
  const live = { frameTime: { tsMs: 1000 } };
  const hooks = CO.ensureFilmHooks(live);
  const sky = [];
  const sh = {
    setSkyTimeOverride(t) {
      sky.push(t);
      return true;
    },
    getSkyState: () => ({ timeOfDayNormalized: 0.25, free() {} }),
  };
  const fxTime = { fn: null, setFxTimeSource(fn) { this.fn = fn; } };
  const win = { performance: { now: () => wall } };
  win.__renderOnce = (ts) => {
    Promise.resolve().then(() => {
      const prev = live.frameTime.tsMs;
      const t = Number.isFinite(ts) ? ts : wall; // the hand-back re-arm renders bare
      live.frameTime = { tsMs: t };
      live.film?.preFrame?.(t, (t - prev) / 1000);
      live.film?.postRender?.();
    });
    return true;
  };
  const clock = CK.createFilmClock({ liveScene3d: live, window: win, fxTime, sessionHandle: sh, now: () => wall, sleep: async (ms) => { wall += ms; } });
  const begins = [];
  const clockSpy = {
    begin(b) {
      begins.push({ ...b });
      return clock.begin(b);
    },
    step: () => clock.step(),
    end: (o) => clock.end(o),
    get active() {
      return clock.active;
    },
    stats: () => clock.stats(),
  };
  const grabs = [];
  class F {
    constructor(src, init) {
      if (failGrabAt !== null && grabs.length === failGrabAt) throw new Error("VideoFrame: the canvas shrank below the visible rect");
      this.timestamp = init.timestamp;
      this.duration = init.duration;
      grabs.push({ us: init.timestamp, worldMs: live.frameTime.tsMs, fxMs: fxTime.fn ? fxTime.fn() : null, sky: sky.length ? sky[sky.length - 1] : null });
    }
    close() {}
  }
  const E = encoderClass();
  const canvas = { width: 640, height: 360 };
  const writes = [];
  const cam = {
    owned: true,
    write(p) {
      writes.push({ t: p.t, pos: p.pos.slice(), q: p.q.slice(), fov: p.fov });
      return true;
    },
    currentPose: () => (writes.length ? { ...writes[writes.length - 1] } : null),
    setCutCell: (c) => c,
    viewerCell: () => 0,
    onPostRender: (fn) => hooks.addPostRender(fn),
  };
  // The reflex never moves this open-air dolly.
  const safety = { clamp: (prev, desired) => ({ pose: desired, adjusted: false, hits: [] }), reset() {}, release: () => 0 };
  const player = TP.createTakePlayer({
    cameraOwner: cam,
    clock: clockSpy,
    safety,
    recorder: (ro) => REC.createRecorder({ canvas, ...ro, VideoEncoder: E, VideoFrame: F }),
    worldQuery: { groundZ: () => 0 },
    liveScene3d: live,
    window: win,
  });
  return { live, clock, begins, grabs, E, player };
}

const LAPSE = 0.01; // game days per film second
function dolly(D = 2) {
  return TR.makeTrajectory({ id: "north", technique: "classic.dolly-in", family: "classic", duration: D, positionAt: (t) => [100, 100 + 5 * t, 10], orientAt: { h: 0, p: 0, r: 0 }, meta: { timeLapse: { rate: LAPSE } } });
}

check("FILM-2 a 5 fps stepped shoot: the world, FX time and time-lapse advance 1/5 s per grabbed frame", async () => {
  const R = steppedRig();
  R.player.prepare({ trajectory: dolly(2), capture: { fps: 5, width: 640, height: 360 } });
  const rep = await R.player.shoot({ fps: 5 });
  assert.equal(rep.frames, 10);
  assert.equal(R.begins[0].fps, 10, "two clock frames per film frame (the clock's floor is 10 fps)");
  assert.equal(R.grabs.length, 10, "only the last clock frame of each film frame is grabbed");
  for (let k = 1; k < R.grabs.length; k += 1) {
    const a = R.grabs[k - 1];
    const b = R.grabs[k];
    near(b.us - a.us, 200000, 1, `frame ${k}: film time`);
    near(b.worldMs - a.worldMs, 200, 1e-6, `frame ${k}: world clock (old code: 100 ms, half-speed world)`);
    near(b.fxMs - a.fxMs, 200, 1e-6, `frame ${k}: FX / scenery time`);
    near(b.sky - a.sky, LAPSE * 0.2, 1e-9, `frame ${k}: time-lapse`);
  }
  assert.equal(R.E.instances[0].state, "closed");
});

check("FILM-2 an 8 fps stepped rehearsal (the CLI default) runs a 16 fps clock: 2 clock frames per film frame", async () => {
  const R = steppedRig();
  R.player.prepare({ trajectory: dolly(2), capture: { fps: 30 } });
  const t0 = R.live.frameTime.tsMs;
  const reh = await R.player.rehearse({ fps: 8 });
  assert.equal(reh.frames, 16);
  assert.equal(R.begins[0].fps, 16);
  const st = R.clock.stats();
  assert.equal(st.steps % 2, 0, "whole film frames");
  assert.ok(st.steps >= 2 * reh.frames, "pre-roll + take frames, two clock frames each");
  near(st.lastTsMs - t0, (st.steps / 2) * 125, 1e-6, "the world clock moved 1/8 s per film frame");
  // At or above the floor nothing changes: one clock frame per film frame.
  const R2 = steppedRig();
  R2.player.prepare({ trajectory: dolly(2), capture: { fps: 12 } });
  await R2.player.rehearse({ fps: 12 });
  assert.equal(R2.begins[0].fps, 12);
});

check("FILM-3 a stepped shoot whose grab throws fails FILM_RECORDER_FAILED and closes the encoder", async () => {
  const R = steppedRig({ failGrabAt: 3 });
  R.player.prepare({ trajectory: dolly(2), capture: { fps: 10, width: 640, height: 360 } });
  await assert.rejects(R.player.shoot({ fps: 10 }), (e) => e && e.code === "FILM_RECORDER_FAILED");
  const enc = R.E.instances[0];
  assert.equal(enc.state, "closed", "the configured (hardware) encoder is not left open until the next shoot");
  assert.equal(enc.closes, 1);
  assert.equal(R.player.currentRecorder().state, "failed");
});

check("FILM-3 recorder.abort() after a grab failure closes the encoder once; output chunks stay drainable", async () => {
  const E = encoderClass();
  let throwNext = false;
  class F {
    constructor(src, init) {
      if (throwNext) throw new Error("VideoFrame: canvas resized");
      this.timestamp = init.timestamp;
      this.duration = init.duration;
    }
    close() {}
  }
  const r = REC.createRecorder({ canvas: { width: 640, height: 360 }, width: 640, height: 360, fps: 30, VideoEncoder: E, VideoFrame: F });
  await r.start();
  assert.equal(r.grab(0), true);
  throwNext = true;
  assert.equal(r.grab(1 / 30), false);
  assert.equal(r.state, "failed");
  assert.equal(E.instances[0].state, "configured", "fail() alone leaves the encoder open");
  const s = r.abort(new Error("the recorder failed"));
  assert.equal(s.state, "failed");
  assert.equal(E.instances[0].state, "closed");
  r.abort();
  assert.equal(E.instances[0].closes, 1, "idempotent");
  const d = r.drain();
  assert.equal(d.chunks.length, 1);
  assert.equal(d.done, true);
});

// ---------------------------------------------------------------------------
// FILM-4 release / dispose undo the look
// ---------------------------------------------------------------------------

function filmPage() {
  const persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const cs = {
    persp,
    activeCamera: persp,
    mode: "follow",
    followYaw: 0,
    followPitch: 0,
    keys: {},
    positionCamera() {},
    switchMode(m) { this.mode = m; },
    _applyCameraPlayerFade(o) { this._camFadeLastOpacity = o; },
  };
  const hidden = [];
  const live = {
    frameTime: { tsMs: 1000 },
    renderer: { domElement: { width: 640, height: 360 }, toneMappingExposure: 1 },
    cameraSwitcher: cs,
    camera: persp,
    entityManager: {
      entityMap: new Map(),
      setFilmHidden(g, on) {
        hidden.push([g, on]);
        return true;
      },
      setSelectedTarget() {},
      getSelectedTarget: () => 0,
    },
    cellContainers3d: new Map(),
  };
  const fogBefore = { option: 0, name: "boot" };
  const win = {
    liveScene3d: live,
    performance: { now: () => 1e12 },
    __renderOnce: () => true,
    addEventListener() {},
    removeEventListener() {},
    getLocalPlayerGuid: () => 0x50000001,
    __setExposure(v) {
      live.renderer.toneMappingExposure = v;
      return v;
    },
    __environFogOverride: fogBefore,
  };
  const sky = [];
  const sh = {
    setSkyTimeOverride(t) {
      sky.push(t);
      return true;
    },
    getLocalPlayerPose: () => ({ landblockId: 0xa9b4001c, x: 50, y: 50, z: 0, heading: 0, free() {} }),
    playerGuid: () => 0x50000001,
    isPlayerReady: () => true,
    terrainHeightAt: () => 0,
    sendChat() {},
  };
  const api = API.installFilmMode({
    liveScene3d: live, THREE, sessionHandle: sh, wasmExports: {}, window: win, document: null, log: () => {},
    modules: { timeRng: null, fxTime: null, sceneryTime: null, vfxCatalog: null },
  });
  return { api, live, win, sky, hidden, fogBefore };
}

check("FILM-4 release() hands back the look too: sky pin cleared, fog override and exposure restored", () => {
  const P = filmPage();
  const lk = P.api.world.look({ timeOfDay: "night", fog: "white", exposure: 1.6 });
  assert.equal(lk.ok, true);
  assert.equal(P.sky[P.sky.length - 1], 0, "night pinned");
  assert.notEqual(P.win.__environFogOverride, P.fogBefore, "white fog override");
  assert.equal(P.live.renderer.toneMappingExposure, 1.6);
  assert.equal(P.api.own().ok, true);
  const rel = P.api.release();
  assert.equal(rel.ok, true);
  assert.equal(rel.owned, false);
  assert.ok(Number.isNaN(P.sky[P.sky.length - 1]), "the sky time override is cleared (no boot ?skytime pin)");
  assert.equal(P.win.__environFogOverride, P.fogBefore, "the original fog override object is back");
  assert.equal(P.live.renderer.toneMappingExposure, 1);
  assert.deepEqual([...rel.look.restored].sort(), ["exposure", "fog", "timeOfDay"]);
  assert.equal(P.api.status().look.active, false);
  P.api.dispose();
});

check("FILM-4 dispose() undoes the look and the film avatar hide", () => {
  const P = filmPage();
  P.api.world.avatar(false);
  P.api.world.look({ timeOfDay: "dusk", exposure: 0.8 });
  assert.deepEqual(P.api.dispose(), { ok: true, disposed: true });
  assert.ok(Number.isNaN(P.sky[P.sky.length - 1]), "sky time override cleared");
  assert.equal(P.live.renderer.toneMappingExposure, 1);
  assert.deepEqual(P.hidden[P.hidden.length - 1], [0x50000001, false], "the avatar is shown again");
  assert.equal(P.win.__film, undefined);
});

// ---------------------------------------------------------------------------
// FILM-5 nameplates stay hidden through the nameplate LOD
// ---------------------------------------------------------------------------

check("FILM-5 a clean frame keeps nameplates out of the render although the REAL LOD re-shows them", () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld(true);
  const entity = (guid, z) => {
    const root = new THREE.Group();
    root.position.set(0, 0, z);
    const plate = new THREE.Sprite(new THREE.SpriteMaterial());
    const badge = new THREE.Sprite(new THREE.SpriteMaterial());
    root.add(plate, badge);
    root.updateMatrixWorld(true);
    return { guid, root, _nameplateSprite: plate, _buffBadgeSprite: badge };
  };
  const nearOne = entity(0x80000001, -10);
  const farOne = entity(0x80000002, -100); // beyond the 40 m LOD range
  const em = { entityMap: new Map([[nearOne.guid, nearOne], [farOne.guid, farOne]]), setSelectedTarget() {}, getSelectedTarget: () => 0 };
  const live = { entityManager: em, cameraSwitcher: { activeCamera: camera } };
  const drawn = (s) => s.visible && s.layers.test(camera.layers);
  NP.tickNameplateLod(live);
  assert.equal(drawn(nearOne._nameplateSprite), true);
  assert.equal(nearOne._nameplateSprite.visible && !farOne._nameplateSprite.visible, true, "the LOD hid the far one");
  const cf = CF.createCleanFrame({ document: null, window: null, liveScene3d: live });
  const r = cf.apply();
  assert.equal(r.steps.nameplates.ok, true);
  assert.equal(r.steps.nameplates.hidden, 4, "every nameplate and badge, the LOD-hidden ones too");
  NP.tickNameplateLod(live); // the LOD's next animation frame
  assert.equal(nearOne._nameplateSprite.visible, true, "the LOD owns .visible and re-shows the near plate");
  assert.equal(drawn(nearOne._nameplateSprite), false, "but it is off every camera layer: not in the footage");
  assert.equal(drawn(nearOne._buffBadgeSprite), false);
  // The far entity walks into range mid-take.
  farOne.root.position.set(0, 0, -12);
  farOne.root.updateMatrixWorld(true);
  NP.tickNameplateLod(live);
  assert.equal(farOne._nameplateSprite.visible, true);
  assert.equal(drawn(farOne._nameplateSprite), false, "a plate hidden by the LOD at apply() stays out too");
  cf.restore();
  NP.tickNameplateLod(live);
  for (const s of [nearOne._nameplateSprite, nearOne._buffBadgeSprite, farOne._nameplateSprite, farOne._buffBadgeSprite]) {
    assert.equal(drawn(s), true, "restored: back on its layer, the LOD decides again");
  }
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`film_review_film1_5: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
