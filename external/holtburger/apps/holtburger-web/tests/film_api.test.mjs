// tests/film_api.test.mjs
//
// WHY: `window.__film` is the ONLY surface the film director (a Claude Code
// session driving the off-screen Chrome over CDP through tools/film/film.mjs)
// talks to. Every call crosses `page.evaluate`, so a method that throws, hangs
// on bad input, returns a non-JSON value (Infinity, a typed array, a cycle) or
// silently renames a SPEC §3 method breaks the whole shoot on the 1070 —
// usually hours into a run. This suite EXECUTES the real
// `installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports})` against a
// fake liveScene3d (a real three r184 PerspectiveCamera inside a CameraSwitcher
// stand-in), a fake window (`__renderOnce` drives the REAL film hooks and film
// clock), a fake session handle and fake WebCodecs, and checks:
//   A1 every SPEC §3 method exists (dotted paths), version 'film-1', idempotent
//      install, window.__film published, dispose + reinstall;
//   A2 no method ever throws: each is called with bad input and answers
//      `{ok:false, error:{code, message}}`; status() is JSON round-trip exact;
//   A3 own / clean / pose / world.teleport / query.* on the fake scene;
//   A4 the CLI flow: prepare(compiled Take) → rehearse({fps}) → shoot({…}) while
//      recorder.drain() runs concurrently (starting → chunks → done), FILM_BUSY
//      for a concurrent prepare, frames = takeFrames, locked replay of the
//      rehearsal reproduces its checksum, real time sources installed and
//      restored by the film clock (dynamic imports);
//   A5 scout(take, {count, stills, width}) → ranked candidates with words,
//      metrics and JPEG stills captured in postRender, camera handed back;
//   A6 depth of field through the API: classic.rack-focus drives a fake
//      window.__dof every frame and restores it (owner decision 2026-10-13);
//   A9 indoor scout measures candidates through the render set's EnvCell walls
//      (measureCandidate → real sensors default cellIds; review contracts-1);
//   A10 deps.particleCull (review seams-9): rehearse / shoot / scout stills run the
//      RP6 cull at recheckInterval 1 and restore it, the particle query enumerates
//      allParticleManagers(); world.teleport parks the film viewer cell (review
//      seams-11), the next write re-seeds it; a teleport during a take is refused;
//   A11 static catalogs wiring (round 2): the world query reads the client's VFX
//      catalog (same vfx_catalog.js instance) + wasm selection spheres, so a
//      scenery oak is a tree (a label: never a fade key, r4) and a barrel a fadeable prop; modules.vfxCatalog
//      overrides; without a loaded catalog the oak stays 'rock' (never loaded by film).
//   A12 world.teleport / world.command refuse FILM_BUSY while a prepare, shoot, rehearse
//      or scout runs (review tooling-2 defence in depth; same guard as pose / release;
//      prepare since round 3: it awaits while it reads the subject, sun and route);
//   A13 a too-fast drone take through the API: prepare's 'overspeed' issue (with a
//      minDurationSec verified by dry-flying the rebuilt shot, round 3) and flight check
//      (+ dryFlight) reach the rehearse and shoot reports (review math-2: the CLI can
//      surface them), with the craft's tracking gap.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — film/index.js loads only under it.
// Run from apps/holtburger-web/: node tests/film_api.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const API = await import("../scene3d/film/index.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const DRAIN = await import("../tools/film/lib/drain.mjs");

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
const tick = () => new Promise((r) => setImmediate(r));

/** The SPEC §3 table, verbatim (a rename here must fail the gate). */
const SPEC_METHODS = [
  "status", "clean", "own", "release", "pose",
  "world.teleport", "world.ready", "world.prewarm", "world.avatar", "world.look", "world.restoreLook", "world.actor",
  "query.subject", "query.near", "query.groundZ",
  "techniques", "scout", "prepare", "rehearse", "shoot", "recorder.drain",
];

const resolve = (api, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), api);

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const LB = 0xa9b40000;
const LBX = 0xa9 * 192;
const LBY = 0xb4 * 192;

class FakeSwitcher {
  constructor() {
    this.persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    this.mode = "follow";
    this.activeCamera = this.persp;
    this.followYaw = 0.5;
    this.followPitch = 0.2;
    this.keys = { w: false };
    this.positions = 0;
  }
  positionCamera() {
    this.positions += 1;
    this.persp.position.set(1, 2, 3);
  }
  switchMode(m) {
    this.mode = m;
  }
  _applyCameraPlayerFade(o) {
    this._camFadeLastOpacity = o;
  }
}

function fakeCanvas(w = 640, h = 360) {
  const c = { width: w, height: h, jpegs: 0 };
  c.toDataURL = (type) => {
    c.jpegs += 1;
    return `data:${type};base64,${Buffer.from([0xff, 0xd8, 0xff, c.jpegs & 0xff, 0xff, 0xd9]).toString("base64")}`;
  };
  return c;
}

function fakeDocument() {
  const made = [];
  return {
    made,
    getElementById: () => null,
    createElement(tag) {
      const c = fakeCanvas(1, 1);
      c.tag = tag;
      c.draws = [];
      c.getContext = () => ({ drawImage: (src, x, y, w, h) => c.draws.push({ src, w, h }) });
      made.push(c);
      return c;
    },
    head: { appendChild() {} },
    documentElement: { classList: { add() {}, remove() {}, contains: () => false } },
  };
}

/** WebCodecs fakes that emit an Annex-B chunk per frame. */
function makeEncoder() {
  const instances = [];
  class E {
    static async isConfigSupported(cfg) {
      return { supported: cfg.codec === "avc1.640033", config: cfg };
    }
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.encodeQueueSize = 0;
      this.frames = [];
      this.seq = 0;
      instances.push(this);
    }
    configure(cfg) {
      this.config = cfg;
    }
    encode(frame, opts) {
      this.frames.push({ ts: frame.timestamp, key: !!(opts && opts.keyFrame) });
      const bytes = new Uint8Array([0, 0, 0, 1, opts && opts.keyFrame ? 0x65 : 0x41, this.seq++ & 0xff, 7, 7]);
      this.output({ type: opts && opts.keyFrame ? "key" : "delta", timestamp: frame.timestamp, duration: frame.duration, byteLength: bytes.length, copyTo: (d) => d.set(bytes) });
    }
    async flush() {}
    close() {
      this.state = "closed";
    }
  }
  E.instances = instances;
  return E;
}
class FakeFrame {
  constructor(src, init) {
    this.src = src;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.closed = false;
    FakeFrame.all.push(this);
  }
  close() {
    this.closed = true;
  }
}
FakeFrame.all = [];

function fakeScene(o = {}) {
  const cs = o.noCamera ? null : new FakeSwitcher();
  const canvas = fakeCanvas();
  const hidden = [];
  const live = {
    frameTime: { tsMs: 1000 },
    renderer: { domElement: canvas, toneMappingExposure: 1 },
    entityManager: {
      entityMap: new Map(),
      _filmHiddenGuids: new Set(),
      setFilmHidden(g, on) {
        hidden.push([g, on]);
        if (on) this._filmHiddenGuids.add(g);
        else this._filmHiddenGuids.delete(g);
        return true;
      },
      setSelectedTarget() {},
      getSelectedTarget: () => 0,
    },
    terrainBakedLbs: new Set([LB]),
    staticsGroup: { children: [] },
    cellContainers3d: new Map(),
    _pvsSweepIncomplete: false,
  };
  if (cs) {
    live.cameraSwitcher = cs;
    live.camera = cs.persp;
  }
  const renders = { count: 0, bare: 0 };
  const win = {
    liveScene3d: live,
    performance: { now: () => 1e12 },
    __renderOnce(ts) {
      const prev = live.frameTime.tsMs;
      const t = Number.isFinite(ts) ? ts : prev + 16;
      if (!Number.isFinite(ts)) renders.bare += 1;
      renders.count += 1;
      live.frameTime = { tsMs: t };
      if (live.film && typeof live.film.preFrame === "function") live.film.preFrame(t, (t - prev) / 1000);
      if (cs) cs.positionCamera();
      if (live.film && typeof live.film.postRender === "function") live.film.postRender();
      return true;
    },
    addEventListener() {},
    removeEventListener() {},
    __isPortalSpaceActive: () => false,
    getLocalPlayerGuid: () => 0x50000001,
  };
  const sent = [];
  const sh = {
    terrainHeightAt: () => 0,
    getLocalPlayerPose: () => ({ landblockId: 0xa9b4001c, x: 50, y: 50, z: 0, heading: 0, isOnGround: true, free() {} }),
    playerGuid: () => 0x50000001,
    sendChat: (c) => sent.push(c),
    isPlayerReady: () => true,
  };
  return { live, win, sh, sent, canvas, renders, hidden, cs };
}

function install(S, extra = {}) {
  return API.installFilmMode({
    liveScene3d: S.live,
    THREE,
    sessionHandle: S.sh,
    wasmExports: {},
    window: S.win,
    document: fakeDocument(),
    VideoEncoder: makeEncoder(),
    VideoFrame: FakeFrame,
    log: () => {},
    ...extra,
  });
}

/** A compiled Take (tools/film/plan/compile.mjs item.take shape). */
function dollyTake(fps = 10, extra = {}) {
  return {
    shotId: "dolly",
    siteId: "yard",
    technique: "classic.dolly-in",
    family: "classic",
    spec: { technique: "classic.dolly-in", duration: 1.5, params: {}, seed: 7, subject: { kind: "point", pos: [LBX + 60, LBY + 60, 0] } },
    subject: { kind: "point", pos: [LBX + 60, LBY + 60, 0] },
    path: null,
    route: null,
    standingOrder: "Keep at least 2 m from anything solid.",
    goal: "a slow push onto the statue",
    pilot: { mode: "code" },
    capture: { mode: "stepped", fps, width: 640, height: 360 },
    look: {},
    actor: null,
    cell: null,
    indoor: false,
    anchor: [LBX + 60, LBY + 60, 0],
    editOffsetSec: 0,
    preRollSec: 0.25,
    showAvatar: false,
    ...extra,
  };
}

async function waitRuntime(api) {
  await api.__runtime.ready();
  for (let i = 0; i < 50 && !api.status().runtimeReady; i += 1) await tick();
}

// ---------------------------------------------------------------------------
// A1 surface
// ---------------------------------------------------------------------------

check("A1 every SPEC §3 method exists; version film-1; window.__film; FILM_API_METHODS covers the SPEC", () => {
  const S = fakeScene();
  const api = install(S);
  assert.equal(S.win.__film, api);
  assert.equal(api.version, "film-1");
  assert.equal(API.FILM_API_VERSION, "film-1");
  for (const m of SPEC_METHODS) {
    assert.equal(typeof resolve(api, m), "function", `window.__film.${m}`);
    assert.ok(API.FILM_API_METHODS.includes(m), `FILM_API_METHODS lists ${m}`);
  }
  for (const m of API.FILM_API_METHODS) assert.equal(typeof resolve(api, m), "function", `extra ${m}`);
  api.dispose();
});

check("A1 idempotent install; dispose removes window.__film; reinstall gives a fresh api", () => {
  const S = fakeScene();
  const a = install(S);
  const b = install(S);
  assert.equal(a, b, "same liveScene3d → same api");
  S.win.__film = undefined;
  assert.equal(install(S), a, "re-published");
  assert.equal(S.win.__film, a);
  assert.deepEqual(a.dispose(), { ok: true, disposed: true });
  assert.equal(S.win.__film, undefined);
  const c = install(S);
  assert.notEqual(c, a);
  assert.equal(S.win.__film, c);
  c.dispose();
  assert.throws(() => API.installFilmMode({ window: {} }), (e) => e.code === "BAD_ARGUMENT");
});

// ---------------------------------------------------------------------------
// A2 never throws
// ---------------------------------------------------------------------------

check("A2 every method answers {ok:false, error} for bad input — never throws, never hangs", async () => {
  const S = fakeScene();
  const api = install(S);
  await waitRuntime(api);
  const bad = [
    ["pose", ["garbage"]],
    ["pose", [{ pos: [NaN, 0, 0], h: 0, p: 0 }]],
    ["world.teleport", [42]],
    ["world.teleport", ["/hello everyone"]],
    ["world.teleport", ["@shutdown"]],
    ["world.command", [{}]],
    ["world.ready", ["soon"]],
    ["world.prewarm", [5]],
    ["world.look", ["moody"]],
    ["world.actor", [7]],
    ["query.subject", [null]],
    ["query.subject", [0x7fffffff]],
    ["query.near", [{ center: "here" }]],
    ["query.near", [{ center: [0, 0, 0], radius: -1 }]],
    ["query.groundZ", ["a", "b"]],
    ["techniques", [{ family: "steadicam" }]],
    ["scout", [null]],
    ["scout", [{ technique: "classic.nope", duration: 2 }]],
    ["prepare", [42]],
    ["prepare", [{}]],
    ["prepare", [{ technique: "classic.nope", duration: 2 }]],
    ["prepare", [{ spec: { technique: "classic.dolly-in", duration: 2 } }]], // needs a subject
    ["rehearse", [{ fps: 10 }]], // nothing prepared yet
    ["shoot", [{ fps: 10 }]],
  ];
  for (const [m, args] of bad) {
    let r;
    try {
      r = await Promise.race([resolve(api, m)(...args), new Promise((res) => setTimeout(() => res("HUNG"), 3000))]);
    } catch (e) {
      assert.fail(`${m} threw: ${e && e.message}`);
    }
    assert.notEqual(r, "HUNG", `${m} hung`);
    assert.equal(typeof r, "object", `${m} returns an object`);
    assert.equal(r.ok, false, `${m}(${JSON.stringify(args).slice(0, 60)}) → ok:false (got ${JSON.stringify(r).slice(0, 120)})`);
    assert.ok(r.error && typeof r.error === "object" && typeof r.error.message === "string", `${m} has error.message`);
    assert.equal(typeof r.code === "string" || typeof r.error.code === "string", true);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r, `${m} result is JSON-exact`);
  }
  // bad input that is tolerated still answers an object
  const d = api.recorder.drain("not an object");
  assert.equal(d.ok, true);
  assert.equal(d.done, true);
  assert.deepEqual(d.chunks, []);
  assert.equal(api.release().ok, true);
  assert.equal(api.abort().ok, true);
  assert.equal(api.clean(false).ok, true);
  const unk = await api.prepare({ technique: "classic.nope", duration: 2 });
  assert.equal(unk.code, "UNKNOWN_TECHNIQUE");
  const np = await api.rehearse({});
  assert.equal(np.code, "FILM_NOT_PREPARED");
  api.dispose();
});

check("A2 own() without a camera → ok:false FILM_CAMERA_UNAVAILABLE; status() is JSON round-trip exact", async () => {
  const S = fakeScene({ noCamera: true });
  const api = install(S);
  const r = api.own();
  assert.equal(r.ok, false);
  assert.equal(r.code, "FILM_CAMERA_UNAVAILABLE");
  await waitRuntime(api);
  const s = api.status();
  assert.equal(s.ok, true);
  assert.equal(s.version, "film-1");
  assert.equal(s.cameraOwned, false);
  for (const k of ["ok", "version", "active", "cameraOwned", "clean", "take", "recorder", "pilot", "clock", "flags"]) assert.ok(k in s, `status.${k}`);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.flags.jevBridge, false);
  assert.equal(s.flags.dof, false);
  api.dispose();
});

check("A2 jsonSafe: non-finite → null, typed arrays → arrays, cycles → null, round trip exact", () => {
  const cyc = { a: 1 };
  cyc.self = cyc;
  const v = API.jsonSafe({ inf: Infinity, nan: NaN, f: () => 1, u: undefined, ta: new Float64Array([1, Infinity]), set: new Set([1]), map: new Map([["k", 2]]), cyc, err: new Error("x"), arr: [undefined, () => 0, 3] });
  assert.equal(v.inf, null);
  assert.equal(v.nan, null);
  assert.ok(!("f" in v) && !("u" in v));
  assert.deepEqual(v.ta, [1, null]);
  assert.deepEqual(v.set, [1]);
  assert.deepEqual(v.map, [["k", 2]]);
  assert.equal(v.cyc.self, null);
  assert.equal(v.err.code, "INTERNAL_ERROR");
  assert.deepEqual(v.arr, [null, null, 3]);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

// ---------------------------------------------------------------------------
// A3 camera / clean / world / query
// ---------------------------------------------------------------------------

check("A3 own → pose (straight down, no lookAt) → release; clean on/off; teleport; query.*", async () => {
  const S = fakeScene();
  const api = install(S);
  const o = api.own();
  assert.equal(o.ok, true);
  assert.equal(o.owned, true);
  const h = 0.8;
  const p = api.pose({ pos: [LBX + 10, LBY + 20, 40], h, p: -Math.PI / 2, r: 0, fov: 50 });
  assert.equal(p.ok, true);
  const cam = S.cs.persp;
  near(cam.fov, 50, 1e-9);
  // three: AC (x, y, z) → (x, z, −y)
  near(cam.position.x, LBX + 10, 1e-9);
  near(cam.position.y, 40, 1e-9);
  near(cam.position.z, -(LBY + 20), 1e-9);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  near(fwd.y, -1, 1e-9, "looks straight down");
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  // AC up at the nadir = (sin h·…) → three: the image top points along heading h
  near(up.x, Math.sin(h), 1e-9, "heading kept at the nadir (no north snap)");
  near(up.z, -Math.cos(h), 1e-9);
  S.win.__renderOnce(2000);
  near(cam.position.y, 40, 1e-9, "the follow derivation is skipped while owned");
  assert.equal(api.clean(true).ok, true);
  assert.equal(api.status().clean, true);
  assert.equal(api.clean(false).ok, true);
  assert.equal(api.status().clean, false);
  const t = api.world.teleport("@telepoi Holtburg");
  assert.equal(t.ok, true);
  assert.deepEqual(S.sent, ["@telepoi Holtburg"]);
  const g = api.query.groundZ(LBX + 5, LBY + 5);
  assert.deepEqual(g, { ok: true, x: LBX + 5, y: LBY + 5, z: 0 });
  assert.equal(api.query.groundZ([LBX + 5, LBY + 5]).z, 0);
  const n = api.query.near({ center: [LBX + 5, LBY + 5, 0], radius: 20 });
  assert.equal(n.ok, true);
  assert.ok(Array.isArray(n.entities) && Array.isArray(n.statics) && Array.isArray(n.particles));
  const tech = api.techniques();
  assert.equal(tech.ok, true);
  assert.ok(tech.count >= 60);
  assert.ok(tech.techniques.some((x) => x.id === "classic.rack-focus"));
  assert.equal(api.techniques({ family: "fpv" }).techniques.every((x) => x.family === "fpv"), true);
  const rel = api.release();
  assert.equal(rel.ok, true);
  assert.equal(rel.owned, false);
  S.win.__renderOnce(2100);
  assert.equal(cam.position.y, 2, "follow mode back after release");
  api.dispose();
});

// ---------------------------------------------------------------------------
// A4 the CLI flow
// ---------------------------------------------------------------------------

check("A4 prepare → rehearse → shoot while draining (starting → chunks → done); FILM_BUSY; locked replay", async () => {
  const S = fakeScene();
  const api = install(S);
  await waitRuntime(api);
  const st0 = api.status();
  assert.deepEqual(st0.timeSources, { timeRng: true, fxTime: true, sceneryTime: true }, "real time-source modules loaded by dynamic import");
  assert.equal(api.own().ok, true);
  const prep = await api.prepare(dollyTake(10));
  assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
  assert.equal(prep.technique, "classic.dolly-in");
  assert.equal(prep.plannedFrames, 15);
  assert.equal(prep.hasSubject, true);
  assert.deepEqual(prep.subject.kind, "point");
  const reh = await api.rehearse({ fps: 10 });
  assert.equal(reh.ok, true, JSON.stringify(reh).slice(0, 300));
  assert.equal(reh.frames, 15);
  assert.equal(reh.realisedTable.frames, 15);
  assert.equal(reh.checksum, TR.tableChecksum(reh.realisedTable.rows));
  // shoot + concurrent drain (the CLI's drainTake loop)
  const renders0 = S.renders.count;
  const shootP = api.shoot({ fps: 10, width: 640, height: 360, codec: "avc", bitrate: 20e6, mode: "stepped", locked: false });
  const busy = await api.prepare(dollyTake(10));
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "FILM_BUSY");
  const first = api.recorder.drain({ maxBytes: 8 << 20 });
  assert.equal(first.done, false, "a drain racing the shoot start never reports the previous take done");
  const chunks = [];
  let done = false;
  let polls = 0;
  let codec = null;
  while (!done && polls < 2000) {
    const r = api.recorder.drain({ maxBytes: 8 << 20 });
    polls += 1;
    chunks.push(...r.chunks);
    if (r.stats && r.stats.codec) codec = r.stats.codec;
    done = r.done;
    if (!done) await tick();
  }
  const rep = await shootP;
  assert.equal(rep.ok, true, JSON.stringify(rep).slice(0, 400));
  assert.equal(done, true);
  assert.equal(rep.frames, 15);
  assert.equal(chunks.length, 15, "every recorded frame drained exactly once");
  assert.deepEqual(chunks.map((c) => c.seq), [...Array(15).keys()]);
  assert.equal(chunks[0].key, true);
  chunks.forEach((c, k) => assert.equal(c.timestampUs, Math.round((k / 10) * 1e6)));
  assert.equal(DRAIN.kindOfCodec(codec), "avc");
  assert.ok(chunks.every((c) => DRAIN.sniffChunkKind(DRAIN.chunkBytes(c)) === "avc"));
  assert.equal(rep.cleanApplied, true, "shoot strips the HUD when the CLI forgot");
  assert.ok(S.renders.count - renders0 >= 15 + 6, "pre-roll + take frames rendered");
  assert.equal(rep.realisedChecksum, reh.checksum, "a stepped shoot reproduces its rehearsal");
  assert.equal(rep.pilot.mode, "code");
  assert.ok(FakeFrame.all.every((f) => f.closed));
  const st = api.status();
  assert.equal(st.lastTake.frames, 15);
  assert.equal(st.active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
  assert.equal(S.live.film.holdLoop, false, "the realtime loop is handed back");
  assert.ok(S.renders.bare >= 1, "re-armed with a bare __renderOnce()");
  // locked: the CLI re-prepares with {…take, table: rehearsal.realisedTable}
  const prep2 = await api.prepare({ ...dollyTake(10), table: reh.realisedTable });
  assert.equal(prep2.ok, true);
  assert.equal(prep2.fromTable, true);
  const rep2P = api.shoot({ fps: 10, codec: "avc", mode: "stepped", locked: true });
  let n2 = 0;
  for (let i = 0; i < 2000; i += 1) {
    const r = api.recorder.drain({});
    n2 += r.chunks.length;
    if (r.done) break;
    await tick();
  }
  const rep2 = await rep2P;
  assert.equal(rep2.ok, true);
  assert.equal(rep2.locked, true);
  assert.equal(rep2.realisedChecksum, reh.checksum);
  assert.equal(n2, 15);
  api.dispose();
});

check("A4 injected time-source modules are installed for the take and restored after", async () => {
  const S = fakeScene();
  const calls = [];
  const timeRng = { setCurrentTime: (fn) => calls.push(["time", typeof fn]), setRng: (fn) => calls.push(["rng", typeof fn]), particleClockMode: () => "off" };
  const fxTime = { setFxTimeSource: (fn) => calls.push(["fx", typeof fn]) };
  const api = install(S, { modules: { timeRng, fxTime, sceneryTime: null } });
  await waitRuntime(api);
  assert.deepEqual(api.status().timeSources, { timeRng: true, fxTime: true, sceneryTime: false });
  api.own();
  assert.equal((await api.prepare(dollyTake(10))).ok, true);
  assert.equal((await api.rehearse({ fps: 10 })).ok, true);
  assert.deepEqual(calls, [["time", "function"], ["rng", "function"], ["fx", "function"], ["time", "object"], ["rng", "object"], ["fx", "object"]]);
  api.dispose();
});

// ---------------------------------------------------------------------------
// A5 scout
// ---------------------------------------------------------------------------

check("A5 scout: ranked candidates with words + metrics + JPEG stills (postRender), camera handed back", async () => {
  const S = fakeScene();
  const doc = fakeDocument();
  const api = install(S, { document: doc });
  await waitRuntime(api);
  const r = await api.scout(dollyTake(10), { count: 3, stills: true, width: 64 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.candidates.length, 3);
  assert.equal(r.intent.framing, "MS");
  assert.equal(r.intent.angle, "eye");
  assert.deepEqual(r.stills, { captured: 3, failed: 0 });
  r.candidates.forEach((c, i) => {
    assert.equal(c.rank, i);
    assert.equal(typeof c.words, "string");
    assert.ok(c.words.length > 0);
    assert.ok(c.pose.pos.every(Number.isFinite));
    assert.ok(/^data:image\/jpeg;base64,/.test(c.still), "a JPEG data URL the CLI can save");
    assert.equal(typeof c.metrics.distance, "number");
  });
  assert.ok(r.candidates[0].cost <= r.candidates[2].cost || r.candidates[0].ok !== r.candidates[2].ok);
  assert.equal(doc.made.length, 3, "each still downscaled to the requested width");
  assert.equal(doc.made[0].width, 64);
  assert.equal(doc.made[0].height, 36);
  assert.equal(doc.made[0].draws[0].src, S.canvas, "drawn from the WebGL canvas inside postRender");
  assert.equal(api.status().cameraOwned, false, "not owned before → released after");
  assert.equal(S.live.film.holdLoop, false);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, "JSON-exact (no -0, NaN, Infinity)");
  // with the camera owned, the previous pose comes back
  api.own();
  api.pose({ pos: [LBX + 1, LBY + 1, 30], h: 0, p: 0, r: 0, fov: 60 });
  await api.scout(dollyTake(10), { count: 2, stills: true });
  near(S.cs.persp.position.y, 30, 1e-9, "pose restored after scouting");
  assert.equal(api.status().cameraOwned, true);
  api.dispose();
});

// ---------------------------------------------------------------------------
// A6 depth of field
// ---------------------------------------------------------------------------

check("A6 classic.rack-focus through the API drives window.__dof every frame and restores it", async () => {
  const S = fakeScene();
  const writes = [];
  let enabled = false;
  let fd = 12;
  let flips = 0;
  S.win.__dof = {
    get enabled() {
      return enabled;
    },
    set enabled(v) {
      if (!!v !== enabled) flips += 1;
      enabled = !!v;
    },
    get focusDistance() {
      return fd;
    },
    set focusDistance(v) {
      if (!(Number.isFinite(v) && v >= 0)) throw new RangeError("focusDistance");
      fd = v;
      writes.push({ v, enabled });
    },
  };
  const api = install(S);
  await waitRuntime(api);
  api.own();
  const take = dollyTake(10, { technique: "classic.rack-focus", spec: { technique: "classic.rack-focus", duration: 2, params: {}, seed: 3 } });
  const prep = await api.prepare(take);
  assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
  assert.equal(prep.hasFocus, true);
  assert.equal(api.status().flags.dof, true);
  const shootP = api.shoot({ fps: 10, codec: "avc" });
  for (let i = 0; i < 2000; i += 1) {
    const r = api.recorder.drain({});
    if (r.done) break;
    await tick();
  }
  const rep = await shootP;
  assert.equal(rep.ok, true, JSON.stringify(rep).slice(0, 300));
  assert.equal(rep.dof.used, true);
  const during = writes.filter((w) => w.enabled).map((w) => w.v);
  assert.ok(during.length >= 20, `written every frame (${during.length})`);
  assert.ok(Math.max(...during) - Math.min(...during) > 0.3, "focus pulls");
  assert.equal(enabled, false, "restored");
  assert.equal(fd, 12, "focusDistance restored");
  assert.equal(flips, 2);
  api.dispose();
});

// ---------------------------------------------------------------------------
// A7 live subjects through the API (review contracts-7 + math-0 / contracts-0)
// ---------------------------------------------------------------------------

/** The fake scene plus a local player the wasm reports at a mutable spot; it walks north 0.3 m per render when `walking`. */
function walkingPlayerScene() {
  const S = fakeScene();
  const P = { x: 60, y: 60, z: 0, walking: false, renders: [] };
  S.sh.objectPosition = (g) => ((g >>> 0) === 0x50000001 ? [LB, P.x, P.y, P.z] : null);
  const render = S.win.__renderOnce;
  S.win.__renderOnce = (ts) => {
    if (P.walking) P.y += 0.3;
    P.renders.push(P.y);
    return render(ts);
  };
  return { S, P };
}

/** A compiled Take whose subject is the player (tools/film/plan/compile.mjs shape). */
function playerTake(extra = {}) {
  return {
    shotId: "walk",
    technique: "classic.tracking-follow",
    family: "classic",
    spec: { technique: "classic.tracking-follow", duration: 2, params: {}, seed: 11 },
    subject: "player",
    pilot: { mode: "code" },
    capture: { mode: "stepped", fps: 10, width: 640, height: 360 },
    look: {},
    actor: null,
    cell: null,
    indoor: false,
    preRollSec: 0,
    ...extra,
  };
}

check("A7 a player subject goes live when its actor walks or the take is realtime; explicit moving:false / a still stepped take stay static", async () => {
  const { S } = walkingPlayerScene();
  const api = install(S);
  await waitRuntime(api);
  api.own();
  const cases = [
    [{ actor: { moveTo: [LBX + 80, LBY + 60, 0] } }, true],
    [{ actor: [{ at: 0, emote: "Wave" }, { at: 0.5, moves: true }] }, true],
    [{ capture: { mode: "realtime", fps: 10 } }, true],
    [{ subject: { kind: "player", moving: true } }, true],
    [{ subject: { kind: "player", moving: false }, actor: { moveTo: [LBX + 80, LBY + 60, 0] } }, false],
    [{}, false],
    [{ actor: { emote: "Wave" } }, false],
  ];
  for (const [extra, live] of cases) {
    const prep = await api.prepare(playerTake(extra));
    assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
    assert.equal(prep.subject.kind, "player");
    assert.equal(prep.subject.moving, live, `${JSON.stringify(extra)} → live ${live}`);
    if (live) assert.deepEqual({ mode: prep.liveSubject.mode, rotate: prep.liveSubject.rotate }, { mode: "carry", rotate: true });
    else assert.equal(prep.liveSubject, null);
  }
  api.dispose();
});

check("A7 the take follows the walking player: the realised camera travels with the avatar (frozen without the live subject)", async () => {
  const run = async (extra) => {
    const { S, P } = walkingPlayerScene();
    const api = install(S);
    await waitRuntime(api);
    api.own();
    const prep = await api.prepare(playerTake(extra));
    assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
    P.walking = true;
    const reh = await api.rehearse({ fps: 10 });
    assert.equal(reh.ok, true, JSON.stringify(reh).slice(0, 300));
    api.dispose();
    const rows = reh.realisedTable.rows;
    const n = reh.frames;
    return { reh, n, camDy: rows[(n - 1) * TR.TABLE_STRIDE + 2] - rows[2], playerDy: 0.3 * (n - 1) };
  };
  const live = await run({ actor: { moveTo: [LBX + 60, LBY + 90, 0] } });
  assert.equal(live.n, 20);
  assert.equal(live.reh.liveSubject.mode, "carry");
  assert.equal(live.reh.liveSubject.missingFrames, 0);
  assert.ok(Math.abs(live.camDy - live.playerDy) <= 0.15 * live.playerDy, `camera moved ${live.camDy.toFixed(2)} m with the player's ${live.playerDy.toFixed(2)} m`);
  const frozen = await run({ subject: { kind: "player", moving: false }, actor: { moveTo: [LBX + 60, LBY + 90, 0] } });
  assert.equal(frozen.reh.liveSubject, null);
  assert.ok(Math.abs(frozen.camDy) < 0.5, `a static subject's rig stays put (${frozen.camDy.toFixed(2)} m)`);
});

// ---------------------------------------------------------------------------
// A8 the live sun (review math-3 / contracts-9)
// ---------------------------------------------------------------------------

check("A8 ShotContext.sun from the sky snapshot (degrees → radians, toward the sun): scout honours intent.light; builders place the camera sun-side", async () => {
  const S = fakeScene();
  S.live.skyLightingController = { _lastState: { dirHeading: 90, dirPitch: 35, dirBright: 1 } };
  const api = install(S);
  await waitRuntime(api);
  const back = await api.scout(dollyTake(10), { count: 12, intent: { light: "back" } });
  assert.equal(back.ok, true, JSON.stringify(back).slice(0, 300));
  assert.deepEqual(back.sun, { available: true, reason: null, headingDeg: 90, pitchDeg: 35 });
  assert.deepEqual(back.warnings, []);
  assert.ok(back.candidates.every((c) => Number.isFinite(c.metrics.lightAngleDeg)), "every candidate has a light angle");
  const best = back.candidates.find((c) => c.ok) || back.candidates[0];
  assert.ok(best.metrics.lightAngleDeg >= 150, `the best 'back' candidate is backlit (${best.metrics.lightAngleDeg}°)`);
  const front = await api.scout(dollyTake(10), { count: 12, intent: { light: "front" } });
  const bestF = front.candidates.find((c) => c.ok) || front.candidates[0];
  assert.ok(bestF.metrics.lightAngleDeg <= 30, `the best 'front' candidate is front-lit (${bestF.metrics.lightAngleDeg}°)`);
  // the shot builders get the sun: an unheaded point subject's 'front' is the sun side (east)
  api.own();
  const take = dollyTake(10, { technique: "classic.static", spec: { technique: "classic.static", duration: 1, params: {}, seed: 2, subject: { kind: "point", pos: [LBX + 60, LBY + 60, 0] } } });
  const prep = await api.prepare(take);
  assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
  assert.equal(prep.sun.available, true);
  const reh = await api.rehearse({ fps: 10 });
  const r = reh.realisedTable.rows;
  const bearing = Math.atan2(r[1] - (LBX + 60), r[2] - (LBY + 60)) * (180 / Math.PI);
  near(bearing, 90, 1, "camera stands on the sun side (front-lit)");
  api.dispose();
});

check("A8 no usable sun (night, indoors, no sky state) → no ctx.sun and scout says intent.light was ignored; getSkyState() boxes are freed", async () => {
  const S = fakeScene();
  S.live.skyLightingController = { _lastState: { dirHeading: 90, dirPitch: 0.9 } }; // Dereth's night floor
  const api = install(S);
  await waitRuntime(api);
  const night = await api.scout(dollyTake(10), { count: 4, intent: { light: "back" } });
  assert.equal(night.ok, true);
  assert.equal(night.sun.available, false);
  assert.match(night.sun.reason, /night/);
  assert.equal(night.warnings.length, 1);
  assert.match(night.warnings[0], /intent\.light "back" was ignored: no usable sun \(it is night/);
  assert.ok(night.candidates.every((c) => c.metrics.lightAngleDeg === null));
  const indoor = await api.scout(dollyTake(10, { indoor: true }), { count: 4, intent: { light: "rim" } });
  assert.equal(indoor.sun.reason, "indoors");
  assert.match(indoor.warnings[0], /indoors/);
  const noLight = await api.scout(dollyTake(10), { count: 4 });
  assert.deepEqual(noLight.warnings, [], "no light asked → nothing to warn about");
  api.dispose();
  // no snapshot: one getSkyState() read, copied, then freed
  const S2 = fakeScene();
  let freed = 0;
  S2.sh.getSkyState = () => ({ dirHeading: 270, dirPitch: 40, free() {
    freed += 1;
  } });
  const api2 = install(S2);
  await waitRuntime(api2);
  const day = await api2.scout(dollyTake(10), { count: 4, intent: { light: "back" } });
  assert.equal(day.sun.available, true);
  assert.equal(day.sun.headingDeg, 270);
  assert.equal(freed, 1, "the wasm SkyState box was freed");
  const S3 = fakeScene();
  const api3 = install(S3);
  await waitRuntime(api3);
  const none = await api3.scout(dollyTake(10), { count: 4, intent: { light: "back" } });
  assert.equal(none.sun.available, false);
  assert.match(none.warnings[0], /sky state is not available/);
  api2.dispose();
  api3.dispose();
});

// ---------------------------------------------------------------------------
// A9 indoor scout sweeps the EnvCell walls (review contracts-1)
// ---------------------------------------------------------------------------

check("A9 indoor scout: candidates are measured through the render set's EnvCell walls (a walled-in subject is not 'fully visible')", async () => {
  const cell = (LB | 0x0105) >>> 0;
  /** The review's probe: every cell-layer sweep stops a tenth of the way along (a wall right in front of the lens). */
  const cellHit = (fx, fy, fz, tx, ty, tz) => {
    const d = [tx - fx, ty - fy, tz - fz];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    const t = 0.1;
    return { t, x: fx + d[0] * t, y: fy + d[1] * t, z: fz + d[2] * t, normalX: -d[0] / L, normalY: -d[1] / L, normalZ: -d[2] / L, free() {} };
  };
  const run = async (indoor) => {
    const S = fakeScene();
    const calls = [];
    S.sh.getRenderSet = () => [cell];
    S.sh.sweepSphereAgainstCellMesh = (fx, fy, fz, tx, ty, tz, r, cells) => {
      calls.push(Array.from(cells));
      return cellHit(fx, fy, fz, tx, ty, tz, r);
    };
    const api = install(S);
    await waitRuntime(api);
    const r = await api.scout(dollyTake(10, { indoor }), { count: 3 });
    api.dispose();
    return { r, calls };
  };
  const inside = await run(true);
  assert.equal(inside.r.ok, true, JSON.stringify(inside.r).slice(0, 300));
  assert.ok(inside.calls.length > 0, "measureCandidate's sensors swept the cell layer");
  assert.ok(inside.calls.every((c) => c.length === 1 && c[0] === cell), "with the render set");
  for (const c of inside.r.candidates) {
    assert.equal(c.metrics.visibleFrac, 0, `candidate ${c.id}: the wall hides the subject`);
    assert.equal(c.metrics.occluderKind, "wall");
    assert.ok(Number.isFinite(c.metrics.clearance), "the wall is the nearest obstacle");
  }
  // Outdoors the cell layer is never swept: the same scene reads clear.
  const outside = await run(false);
  assert.equal(outside.calls.length, 0);
  assert.ok(outside.r.candidates.every((c) => c.metrics.visibleFrac === 1));
});

// ---------------------------------------------------------------------------
// A10 the particle_manager.js seams through the install (review seams-9) and the
// viewer cell parked by world.teleport (review seams-11)
// ---------------------------------------------------------------------------

/** A particle_manager.js stand-in with the real contract (returns the previous config; null/undefined keep). */
function fakeParticleCull(managers = []) {
  const log = [];
  const cur = { maxDistance: 220, recheckInterval: 6 };
  return {
    log,
    cur,
    seam: {
      setParticleCullConfig(o = {}) {
        log.push({ ...o });
        const prev = { ...cur };
        if (o.recheckInterval !== undefined && o.recheckInterval !== null) cur.recheckInterval = o.recheckInterval;
        if (o.maxDistance !== undefined && o.maxDistance !== null) cur.maxDistance = o.maxDistance;
        return prev;
      },
      allParticleManagers: () => managers.slice(),
    },
  };
}

check("A10 particleCull: takes and scout stills run recheckInterval 1 (restored after); the particle query sees every registered manager", async () => {
  // A manager only allParticleManagers() knows about (not on the entity / static facade, no owner registry entry).
  const emitter = { numParticles: 4, info: { maxParticles: 8 }, parent: { position: { x: LBX + 7, y: LBY + 5, z: 1 } }, parts: [] };
  const mgr = { particleTable: new Map([[5, emitter]]), _scene: null };
  const P = fakeParticleCull([mgr]);
  const S = fakeScene();
  const api = install(S, { particleCull: P.seam });
  await waitRuntime(api);
  const near1 = api.query.near({ center: [LBX + 5, LBY + 5, 0], radius: 20 });
  assert.equal(near1.ok, true);
  assert.equal(near1.particles.length, 1, JSON.stringify(near1.particles));
  assert.match(near1.particles[0].key, /#5$/);
  const bare = install(fakeScene());
  await waitRuntime(bare);
  assert.equal(bare.query.near({ center: [LBX + 5, LBY + 5, 0], radius: 20 }).particles.length, 0, "without the seam that manager is invisible");
  bare.dispose();
  // a rendered rehearsal
  const seen = new Set();
  S.live.film.addPostRender(() => seen.add(P.cur.recheckInterval));
  assert.equal(api.own().ok, true);
  assert.equal((await api.prepare(dollyTake(10))).ok, true);
  const reh = await api.rehearse({ fps: 10 });
  assert.equal(reh.ok, true, JSON.stringify(reh).slice(0, 300));
  assert.deepEqual([...seen], [1], "every rendered frame ran the cull every tick");
  assert.deepEqual(reh.particleCull, { recheckInterval: 1, previous: 6, restored: true });
  assert.deepEqual(P.log, [{ recheckInterval: 1 }, { recheckInterval: 6 }]);
  assert.deepEqual(P.cur, { maxDistance: 220, recheckInterval: 6 });
  // a shoot
  seen.clear();
  const shootP = api.shoot({ fps: 10, codec: "avc", mode: "stepped" });
  for (let i = 0; i < 2000; i += 1) {
    const r = api.recorder.drain({});
    if (r.done) break;
    await tick();
  }
  const rep = await shootP;
  assert.equal(rep.ok, true, JSON.stringify(rep).slice(0, 300));
  assert.deepEqual([...seen], [1]);
  assert.equal(P.cur.recheckInterval, 6);
  // scout stills: each still is a cut to a new candidate
  seen.clear();
  const sc = await api.scout(dollyTake(10), { count: 2, stills: true, width: 64 });
  assert.equal(sc.ok, true);
  assert.deepEqual(sc.stills, { captured: 2, failed: 0 });
  assert.deepEqual([...seen], [1]);
  assert.deepEqual(P.log.slice(-2), [{ recheckInterval: 1 }, { recheckInterval: 6 }]);
  assert.equal(P.cur.recheckInterval, 6);
  api.dispose();
});

check("A10 world.teleport parks the film viewer cell (cells.js follows the player while the next site loads); the next write re-seeds; never during a take", async () => {
  const S = fakeScene();
  const api = install(S);
  await waitRuntime(api);
  assert.equal(api.own().ok, true);
  assert.equal(api.pose({ pos: [LBX + 10, LBY + 20, 40], h: 0, p: 0, r: 0, fov: 60 }).ok, true);
  const cell = S.live.filmViewer && S.live.filmViewer.cell;
  assert.ok(cell > 0, "the owned camera publishes its cell");
  const t = api.world.teleport("@telepoi Holtburg");
  assert.equal(t.ok, true);
  assert.equal(t.viewerParked, true);
  assert.equal("filmViewer" in S.live, false, "the previous site's cell no longer drives cells.js");
  assert.equal(api.status().viewerCell, "0x00000000");
  assert.equal(api.status().cameraOwned, true, "the camera stays owned between shots");
  S.win.__renderOnce(5000);
  assert.equal("filmViewer" in S.live, false, "a rendered frame without a write publishes nothing");
  assert.equal(api.pose({ pos: [LBX + 12, LBY + 20, 40], h: 0, p: 0, r: 0, fov: 60 }).ok, true);
  assert.ok(S.live.filmViewer && S.live.filmViewer.cell > 0, "re-seeded on the next write");
  // a teleport sent while a take runs is refused (FILM_BUSY, review tooling-2): nothing is sent and
  // the take's cell carry is left alone
  assert.equal((await api.prepare(dollyTake(10))).ok, true);
  const shootP = api.shoot({ fps: 10, codec: "avc", mode: "stepped" });
  const during = api.world.teleport("@telepoi Arwic");
  assert.equal(during.ok, false);
  assert.equal(during.code, "FILM_BUSY");
  for (let i = 0; i < 2000; i += 1) {
    if (api.recorder.drain({}).done) break;
    await tick();
  }
  assert.equal((await shootP).ok, true);
  assert.ok(S.live.filmViewer && S.live.filmViewer.cell > 0);
  assert.deepEqual(S.sent, ["@telepoi Holtburg"]);
  api.dispose();
});

check("A12 world.teleport / world.command answer FILM_BUSY while a prepare, shoot, rehearse or scout runs (nothing sent); both work again after (review tooling-2; prepare: round 3)", async () => {
  const S = fakeScene();
  const api = install(S);
  await waitRuntime(api);
  assert.equal(api.own().ok, true);
  const refused = (label) => {
    for (const [name, cmd] of [["teleport", "@telepoi Arwic"], ["command", "@cloak on"]]) {
      const r = api.world[name](cmd);
      assert.equal(r.ok, false, `${label}: world.${name} must refuse`);
      assert.equal(r.code, "FILM_BUSY", `${label}: world.${name} code`);
      assert.equal(r.error.code, "FILM_BUSY");
      assert.match(r.error.message, new RegExp(`world\\.${name}: .* is running`));
      assert.deepEqual(JSON.parse(JSON.stringify(r)), r, "JSON-safe");
    }
    assert.equal(api.pose({ pos: [LBX + 10, LBY + 20, 40], h: 0, p: 0, r: 0, fov: 60 }).code, "FILM_BUSY", `${label}: pose (same guard)`);
    assert.equal(api.release().code, "FILM_BUSY", `${label}: release (same guard)`);
  };
  // idle: both go through
  assert.equal(api.world.command("@cloak on").ok, true);
  // a prepare, busy through its own awaits (the runtime, the subject / sun / route it resolves):
  // a teleport there would move the world under what it reads (round 3: cameraBusy covers 'prepare')
  const prepP = api.prepare(dollyTake(10));
  assert.equal(api.status().busy, "prepare");
  refused("prepare");
  assert.equal((await prepP).ok, true);
  assert.equal(api.status().busy, null);
  // a rehearse (busy from the call on, before its take starts)
  const rehP = api.rehearse({ fps: 10 });
  refused("rehearse");
  assert.equal((await rehP).ok, true);
  // a shoot while it records
  const shootP = api.shoot({ fps: 10, codec: "avc", mode: "stepped" });
  refused("shoot");
  let mid = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (api.status().take.running && mid === 0) {
      refused("shoot, take running");
      mid += 1;
    }
    if (api.recorder.drain({}).done) break;
    await tick();
  }
  assert.equal((await shootP).ok, true);
  assert.equal(mid, 1, "probed while the take player was running");
  // a scout
  const scP = api.scout(dollyTake(10), { count: 2, stills: true, width: 64 });
  refused("scout");
  assert.equal((await scP).ok, true);
  // idle again: both go through, and only the idle calls were ever sent
  assert.equal(api.status().active, false);
  const t = api.world.teleport("@telepoi Arwic");
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(api.world.command("@cloak off").ok, true);
  assert.deepEqual(S.sent, ["@cloak on", "@telepoi Arwic", "@cloak off"]);
  api.dispose();
});

check("A13 a drone take that outruns its preset: prepare's 'overspeed' issue + flight check travel in the rehearse and shoot reports (JSON-safe)", async () => {
  const S = fakeScene();
  const api = install(S);
  await waitRuntime(api);
  assert.equal(api.own().ok, true);
  // 150 m of valley in 6 s: ~25 m/s for the 12 m/s cinema craft
  const path = [[LBX + 20, LBY + 40, 5], [LBX + 95, LBY + 45, 5], [LBX + 170, LBY + 40, 5]];
  const take = dollyTake(10, {
    shotId: "canyon", technique: "drone.canyon-run", family: "drone",
    spec: { technique: "drone.canyon-run", duration: 6, params: {}, seed: 3 }, subject: null, path,
  });
  const prep = await api.prepare(take);
  assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
  assert.equal(prep.flight.overspeed, true);
  assert.equal(prep.validation.ok, false);
  const iss = prep.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(iss && iss.minDurationSec > 6 && prep.flight.minDurationVerified === true, JSON.stringify(prep.flight));
  // round 3: verified by DRY-FLYING the rebuilt shot (not by its speed alone); the dry flight at 6 s travels too
  assert.equal(prep.flight.minDurationCheck, "verified");
  assert.equal(prep.flight.limitedBy, "speed");
  assert.ok(prep.flight.dryFlight && prep.flight.dryFlight.maxGapM > 10 && iss.maxGapM === prep.flight.dryFlight.maxGapM, JSON.stringify(prep.flight.dryFlight));
  assert.match(iss.message, /dry-flown within 1 m there/);
  const reh = await api.rehearse({ fps: 10 });
  assert.equal(reh.ok, true, JSON.stringify(reh).slice(0, 300));
  assert.deepEqual(reh.validation, prep.validation);
  assert.equal(reh.flight.overspeed, true);
  assert.equal(reh.flight.minDurationSec, iss.minDurationSec);
  assert.ok(reh.flight.tracking.maxGapM > 10, JSON.stringify(reh.flight.tracking));
  assert.deepEqual(reh.flight.dryFlight, prep.flight.dryFlight, "prepare's dry flight beside the run's tracking");
  const shootP = api.shoot({ fps: 10, codec: "avc", mode: "stepped" });
  for (let i = 0; i < 4000; i += 1) {
    if (api.recorder.drain({}).done) break;
    await tick();
  }
  const rep = await shootP;
  assert.equal(rep.ok, true, JSON.stringify(rep).slice(0, 300));
  assert.ok(rep.validation.issues.some((i) => i.code === "overspeed" && i.minDurationSec === iss.minDurationSec));
  assert.equal(rep.flight.overspeed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(rep)), rep, "the shoot report is JSON round-trip exact");
  // a classic take has no flight block, and its validation passes
  assert.equal((await api.prepare(dollyTake(10))).ok, true);
  const cls = await api.rehearse({ fps: 10 });
  assert.equal(cls.flight, null);
  assert.equal(cls.validation.ok, true);
  api.dispose();
});

// ---------------------------------------------------------------------------
// A11 static catalogs wiring (review round 2, r2-perception)
// ---------------------------------------------------------------------------

const VC = await import("../scene3d/vfx_catalog.js");
const OAK_DID = 0x02000246;
const BARREL_DID = 0x020001aa;
/** One visual_descriptors.jsonl line (the C# classifier's shape): a trunk-canopy oak 9 m tall, 6 m wide. */
const OAK_JSONL = JSON.stringify({
  did: "0x02000246", archetype: "trunk-canopy", components: [{ name: "deformation.windSwayGpu" }],
  signals: [{ name: "maxDimension", value: "9.00" }, { name: "aspectRatio", value: "1.50" }, { name: "partCount", value: "3" }],
});

/** wasm placement tables for LB 0xA9B4: an oak (scenery row 0) at local (60, 70), a barrel (object row 0) at (80, 70); selection spheres. */
function placementWasm() {
  const k = LB;
  const soa = (o) => ({ ...o, free() { this.freed = (this.freed ?? 0) + 1; } });
  const sphereCalls = [];
  return {
    sphereCalls,
    async fetch_landblock_objects_soa(ids) {
      return (ids[0] & 0xffff0000) >>> 0 === k
        ? soa({ len: 1, modelIds: Uint32Array.of(BARREL_DID), positions: Float32Array.of(80, 70, 0), scales: Float32Array.of(1), isBuilding: Uint8Array.of(0), landblockIds: Uint32Array.of(k) })
        : soa({ len: 0 });
    },
    async fetch_landblock_scenery_soa(ids) {
      return (ids[0] & 0xffff0000) >>> 0 === k
        ? soa({ len: 1, objIds: Uint32Array.of(OAK_DID), positions: Float32Array.of(60, 70, 0), scales: Float32Array.of(1), landblockIds: Uint32Array.of(k) })
        : soa({ len: 0 });
    },
    async fetchSetupSelectionSphere(id) {
      sphereCalls.push(id);
      return { setupId: id, cx: 0, cy: 0, cz: 0.5, radius: id === BARREL_DID ? 0.6 : 0.1, valid: id === BARREL_DID, free() {} };
    },
  };
}
// The oak's would-be key: v1 never gives procedural scenery a fade key (world_query FADEABLE_STATIC_SOURCES, r4).
const OAK_KEY = `placement:${LB.toString(16).padStart(8, "0")}:scenery:0`;
const BARREL_KEY = `placement:${LB.toString(16).padStart(8, "0")}:object:0`;
const oakHit = { layer: "scenery", point: [LBX + 60, LBY + 69.6, 1], normal: [0, -1, 0] };
const barrelHit = { layer: "statics", point: [LBX + 80, LBY + 69.5, 0.5], normal: [0, -1, 0] };

check("A11 the world query gets the client's VFX catalog (the SAME vfx_catalog.js instance, dynamic import) and the wasm selection spheres: a scenery oak is a tree (round 1: every oak was 'rock') — labelled only, never keyed (r4: procedural scenery never fades) — and a barrel a fadeable prop", async () => {
  VC.setVfxCatalog(VC.parseDescriptorsJsonl(`${OAK_JSONL}\n`)); // what the client's statics bake loads
  try {
    const S = fakeScene();
    const wasm = placementWasm();
    const api = install(S, { wasmExports: wasm });
    const wq = api.__runtime.worldQuery;
    await wq.staticsNear([LBX + 60, LBY + 60, 0], 30);
    const oak = wq.describeHit(oakHit);
    assert.deepEqual([oak.kind, oak.did, oak.fadeKey], ["tree", OAK_DID, null], "a tree label, no key (r4)");
    assert.equal(wq.staticFadeTargets(OAK_KEY), null, "a hand-made scenery key resolves to nothing");
    const barrel = wq.describeHit(barrelHit);
    assert.deepEqual([barrel.kind, barrel.fadeKey], ["prop", BARREL_KEY]);
    assert.deepEqual(wasm.sphereCalls, [BARREL_DID], "the oak's size comes from the catalog; only the barrel's sphere is fetched");
    const near = api.query.near({ center: [LBX + 70, LBY + 70, 0], radius: 15 });
    assert.equal(near.ok, true);
    const byDid = new Map(near.statics.map((s) => [s.did, s]));
    assert.deepEqual([byDid.get(OAK_DID).kind, byDid.get(OAK_DID).dimsSource, byDid.get(OAK_DID).radius, byDid.get(OAK_DID).height], ["tree", "catalog", 3, 9]);
    assert.deepEqual([byDid.get(BARREL_DID).kind, byDid.get(BARREL_DID).dimsSource], ["prop", "selectionSphere"]);
    api.dispose();
  } finally {
    VC._resetVfxCatalog();
  }
});

check("A11 deps.modules.vfxCatalog replaces the import (a fake catalog makes the oak a tree, still with no fade key: r4); null, or a catalog the client never loaded, leaves it 'rock' with no fade key", async () => {
  const S = fakeScene();
  const api = install(S, { wasmExports: placementWasm(), modules: { vfxCatalog: { vfxDescriptorFor: (did) => (did === OAK_DID ? { archetype: "trunk-canopy" } : null) } } });
  await api.__runtime.worldQuery.staticsNear([LBX + 60, LBY + 60, 0], 30);
  const oak = api.__runtime.worldQuery.describeHit(oakHit);
  assert.deepEqual([oak.kind, oak.fadeKey], ["tree", null], "a tree label (default size: no DAT bounds in this fake), never a key (r4)");
  api.dispose();
  const S2 = fakeScene();
  const api2 = install(S2, { wasmExports: placementWasm(), modules: { vfxCatalog: null } });
  await api2.__runtime.worldQuery.staticsNear([LBX + 60, LBY + 60, 0], 30);
  assert.deepEqual(api2.__runtime.worldQuery.describeHit(oakHit).kind, "rock");
  api2.dispose();
  const S3 = fakeScene(); // the real module, empty (?visual=off: the client never loaded it)
  const api3 = install(S3, { wasmExports: placementWasm() });
  await api3.__runtime.worldQuery.staticsNear([LBX + 60, LBY + 60, 0], 30);
  const o3 = api3.__runtime.worldQuery.describeHit(oakHit);
  assert.deepEqual([o3.kind, o3.fadeKey], ["rock", null], "never loads the catalog itself");
  api3.dispose();
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`film_api: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
