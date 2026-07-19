// Nav-stack sim test: node-only fake-host tests for the report-09 nav stack
// (rynth/router.js + global_router.js + bot.js + control_channel.js) — no
// browser, no wasm, no sidecar. Three tiers:
//   R* — RynthRouter unit tests on a stubbed clock (Date.now overridden), so
//        portal settles / leg timeouts are instant and deterministic.
//   G* — GlobalRouter.goto() against a fake fetch sidecar + a tiny ticking
//        world sim (real timers, ms-scale intervals).
//   B*/C* — full createGrindBot() integration: fake SessionHandle + a Worker
//        polyfill drive the real RynthWebHost heartbeat; control-channel
//        tells go through host._dispatchEvent.
// Regression coverage for the two batch-1 confirmed bugs:
//   bug 1 — goto() read the pose before the host's first tick ("no player
//           pose"); now waits up to poseTimeoutMs (G1/G2, B1).
//   bug 2 — the goto busy latch leaked on failure paths ("goto already
//           active" forever); now try/finally-cleared, busy is a clean
//           reply (G3/G4, B5, C2).
//
// The rynth modules are ESM and this repo has no package.json, so they are
// copied to a tmpdir with a {"type":"module"} package.json (bot.js resolves
// its siblings via import.meta.url, so the copy is self-contained).
//
// Exits 1 on ANY failure (batch-1's runner exited 0 on failure — never again).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ── harness ────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const rows = [];
async function t(id, name, fn) {
  try {
    await fn();
    pass++;
    rows.push([id, name, "PASS"]);
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    fail++;
    rows.push([id, name, "FAIL"]);
    console.log(`FAIL ${id} ${name}: ${e.message}`);
  }
}
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000, step = 5) {
  const t0 = realNow();
  while (!cond()) {
    if (realNow() - t0 > ms) throw new Error("until() timeout");
    await sleep(step);
  }
}

// ── stubbed clock (R* tests only; null = real time) ────────────────────────
const realNow = Date.now.bind(Date);
let simT = null;
Date.now = () => simT ?? realNow();

// ── coordinate helpers (worldXY mirror of router.js) ───────────────────────
const wxy = (objCellId, x, y) => [((objCellId >>> 24) & 0xff) * 192 + x, ((objCellId >>> 16) & 0xff) * 192 + y];
const P = (lbWord, x, y, z = 0) => ({ objCellId: ((lbWord << 16) | 1) >>> 0, x, y, z });
const L = (lbWord, x, y, extra = {}) => ({ lb: ((lbWord << 16) | 1) >>> 0, x, y, z: 0, ...extra });
function legAtWorld(twx, twy) {
  const lbX = Math.floor(twx / 192) & 0xff;
  const lbY = Math.floor(twy / 192) & 0xff;
  return {
    lb: (((lbX << 24) | (lbY << 16)) | 1) >>> 0,
    x: twx - Math.floor(twx / 192) * 192,
    y: twy - Math.floor(twy / 192) * 192,
    z: 0,
    portal: false,
    label: "sim",
  };
}

// ── unit fake host (R* tests: tick() driven by hand) ───────────────────────
function unitHost() {
  return {
    pose: null,
    moves: [],
    stops: 0,
    onMove: null,
    TryGetPlayerPose() {
      return this.pose;
    },
    MoveToPosition(lb, x, y, z) {
      this.moves.push([lb >>> 0, x, y, z]);
      if (this.onMove) this.onMove();
    },
    StopCompletely() {
      this.stops++;
    },
    GetPursuitStatus() {
      return { now: 0, last: 0 };
    },
  };
}

// ── ticking world sim (G*/B*/C* tests: real timers) ────────────────────────
function world({ wx = 400, wy = 400, z = 0, speed = 6 } = {}) {
  const st = { wx, wy, z, speed, target: null, hidden: false, blocked: false, chats: [], timer: null };
  st.step = () => {
    if (st.blocked || !st.target) return;
    const dx = st.target.twx - st.wx;
    const dy = st.target.twy - st.wy;
    const d = Math.hypot(dx, dy);
    if (d <= st.speed) {
      st.wx = st.target.twx;
      st.wy = st.target.twy;
    } else {
      st.wx += (dx / d) * st.speed;
      st.wy += (dy / d) * st.speed;
    }
  };
  st.cell = () => {
    const bx = Math.floor(st.wx / 192);
    const by = Math.floor(st.wy / 192);
    return { objCellId: ((((bx & 0xff) << 24) | ((by & 0xff) << 16)) | 1) >>> 0, x: st.wx - bx * 192, y: st.wy - by * 192, z: st.z };
  };
  st.host = {
    TryGetPlayerPose: () => (st.hidden ? null : st.cell()),
    MoveToPosition: (lb, x, y) => {
      const [twx, twy] = wxy(lb >>> 0, x, y);
      st.target = { twx, twy };
    },
    StopCompletely: () => {
      st.target = null;
    },
    GetPursuitStatus: () => ({ now: 0, last: 0 }),
  };
  st.drive = (router, ms = 4) => {
    st.timer = setInterval(() => {
      st.step();
      router.tick();
    }, ms);
  };
  st.stopDrive = () => clearInterval(st.timer);
  return st;
}

// fake SessionHandle over a world sim (B*/C* tests, real RynthWebHost on top)
function session(st) {
  return {
    isPlayerReady: () => true,
    getLocalPlayerPose: () => {
      st.step(); // world advances once per webhost tick
      if (st.hidden) return null;
      const c = st.cell();
      return { landblockId: c.objCellId, x: c.x, y: c.y, z: c.z, heading: 0 };
    },
    moveToPosition: (lb, x, y, z) => st.host.MoveToPosition(lb, x, y, z),
    cancelPursuit: () => st.host.StopCompletely(),
    pursuitStatus: () => 0,
    sendChat: (txt) => st.chats.push(txt),
    nearbyEntityGuids: () => [],
  };
}

// ── fake sidecar over global fetch ─────────────────────────────────────────
let sidecar = null; // async (body) => payload
let routeCalls = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/route")) {
    routeCalls++;
    const payload = await sidecar(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => payload };
  }
  if (u.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ ok: true, tiles: 1, portals: 1 }) };
  throw new Error(`unexpected fetch ${u}`);
};
const legsPayload = (legs) => ({ ok: true, legs, estUnits: 100, portalsUsed: 0, coverage: "detour" });

// ── Worker polyfill (webhost heartbeat rides this under node) ──────────────
class FakeWorker {
  constructor() {
    this._t = null;
    this.onmessage = null;
  }
  postMessage(m) {
    clearInterval(this._t);
    if (m && m.cmd === "start") this._t = setInterval(() => this.onmessage && this.onmessage({ data: 1 }), m.ms);
  }
  terminate() {
    clearInterval(this._t);
  }
}
globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:navsim";

(async () => {
  // Stage the ESM modules in a type:module tmpdir (see header).
  const srcDir = path.join(__dirname, "rynth");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-navsim-"));
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(srcDir, f), path.join(tmpDir, f));
  }
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  const mod = (f) => import(pathToFileURL(path.join(tmpDir, f)).href);
  let RT, GR, BOT;
  try {
    [RT, GR, BOT] = await Promise.all([mod("router.js"), mod("global_router.js"), mod("bot.js")]);

    const FAST = { legTimeoutMs: 250, settleMs: 20, reissueMs: 40, log: quiet };

    // ════ R* — RynthRouter unit tests (stubbed clock) ════
    const rtest = async (id, name, fn) =>
      t(id, name, async () => {
        simT = 1_000_000;
        try {
          await fn();
        } finally {
          simT = null;
        }
      });

    await rtest("R1", "walks a 3-leg route to DONE; walked counts arrivals", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 10, 0), L(0x0101, 20, 0), L(0x0101, 30, 0)]);
      for (const x of [9, 19, 29]) {
        h.pose = P(0x0101, x, 0);
        r.tick();
      }
      assert.equal(r.status.state, "DONE");
      assert.deepEqual([r.status.leg, r.status.legs, r.status.walked], [3, 3, 3]);
    });

    await rtest("R2", "empty route is DONE immediately", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      r.follow([]);
      assert.equal(r.status.state, "DONE");
      assert.equal(r.status.walked, 0);
    });

    await rtest("R3", "same-landblock teleport enters PORTAL, resumes, no timeout stall", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 150, 0)]);
      h.pose = P(0x0101, 10, 0);
      r.tick(); // walking
      h.pose = P(0x0101, 60, 0); // +50m jump, lb word UNCHANGED
      r.tick();
      assert.equal(r.status.state, "PORTAL"); // teleport detected without lb change
      assert.equal(h.stops, 1);
      simT += 4001; // past PORTAL_SETTLE_MS
      r.tick(); // resume: unflagged teleport -> nearest remaining = current leg
      assert.equal(r.status.state, "WALK");
      assert.equal(r.status.leg, 0);
      for (const x of [85, 110, 135, 148]) {
        h.pose = P(0x0101, x, 0); // on-foot steps (< seamJumpM per tick)
        r.tick();
      }
      assert.equal(r.status.state, "DONE");
      assert.equal(r.status.walked, 1);
    });

    await rtest("R4", "portal hop skips stale old-lb waypoints, resumes nearest", () => {
      const h = unitHost();
      const arrivals = [];
      const r = new RT.RynthRouter(h, { log: quiet, onArrive: (i) => arrivals.push(i) });
      h.pose = P(0x0101, 40, 0);
      r.follow([L(0x0101, 50, 0, { portal: true }), L(0x0101, 60, 0), L(0x4040, 10, 10)]);
      h.pose = P(0x0101, 44, 0);
      r.tick(); // walking toward the portal
      h.pose = P(0x4040, 8, 8); // portal fired: far side
      r.tick();
      assert.equal(r.status.state, "PORTAL");
      simT += 4001;
      r.tick(); // resume: portal leg consumed, stale old-lb leg skipped
      assert.equal(r.status.state, "WALK");
      assert.equal(r.status.leg, 2);
      assert.equal(r.status.walked, 1); // consumed portal leg counted
      h.pose = P(0x4040, 9.5, 9.5);
      r.tick();
      assert.equal(r.status.state, "DONE");
      assert.equal(r.status.walked, 2); // stale leg 1 never counted
      assert.deepEqual(arrivals, [0, 2], "onArrive fired for consumed portal leg + walked leg, not the stale one");
    });

    await rtest("R5", "rubber-band teleport re-begins current leg with fresh watchdog", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 30, 0), L(0x0101, 60, 0)]);
      h.pose = P(0x0101, 29, 0);
      r.tick(); // leg 0 arrival
      assert.deepEqual([r.status.leg, r.status.walked], [1, 1]);
      h.pose = P(0x0101, 40, 0);
      r.tick(); // walking leg 1
      const movesBefore = h.moves.length;
      h.pose = P(0x0101, 2, 0); // 38m rubber-band BACK, same lb
      r.tick();
      assert.equal(r.status.state, "PORTAL");
      simT += 4001;
      r.tick(); // resume: nearest remaining = leg 1 itself
      assert.deepEqual([r.status.state, r.status.leg, r.status.walked], ["WALK", 1, 1]);
      assert.ok(h.moves.length > movesBefore, "re-begun leg re-issues moveTo");
      for (const x of [25, 45, 58]) {
        h.pose = P(0x0101, x, 0); // on-foot steps (< seamJumpM per tick)
        r.tick();
      }
      assert.equal(r.status.state, "DONE");
      assert.equal(r.status.walked, 2);
    });

    await rtest("R6", "null-pose ticks mid-walk neither advance nor fake a portal", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 50, 0)]);
      h.pose = P(0x0101, 5, 0);
      r.tick();
      h.pose = null;
      r.tick();
      r.tick();
      r.tick();
      assert.equal(r.status.state, "WALK");
      h.pose = P(0x0101, 8, 0); // back, 3m from last known — NOT a portal
      r.tick();
      assert.equal(r.status.state, "WALK");
      assert.equal(h.stops, 0);
      for (const x of [30, 48]) {
        h.pose = P(0x0101, x, 0); // on-foot steps (< seamJumpM per tick)
        r.tick();
      }
      assert.equal(r.status.state, "DONE");
    });

    await rtest("R7", "follow() with null pose: first real pose seeds anchor, no false portal", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = null;
      r.follow([L(0xabcd, 50, 50)]);
      r.tick(); // null pose: nothing
      assert.equal(r.status.state, "WALK");
      h.pose = P(0xabcd, 40, 40); // huge world coords vs a zero anchor
      r.tick();
      assert.equal(r.status.state, "WALK", "seeded, not treated as portal");
      assert.equal(h.stops, 0);
      h.pose = P(0xabcd, 49, 49);
      r.tick();
      assert.equal(r.status.state, "DONE");
    });

    await rtest("R8", "pose null forever -> leg times out FAILED (no eternal stall)", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = null;
      r.follow([L(0x0101, 50, 0)]);
      r.tick();
      assert.equal(r.status.state, "WALK");
      simT += 30_001; // past LEG_TIMEOUT_MS
      r.tick();
      assert.equal(r.status.state, "FAILED");
      assert.equal(h.stops, 1);
    });

    await rtest("R9", "tick() is reentrancy-guarded (no double-advance in one tick)", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 11, 0);
      r.follow([L(0x0101, 10, 0), L(0x0101, 12, 0)]);
      h.onMove = () => r.tick(); // host synchronously re-enters tick
      r.tick(); // arrival at leg 0 -> _beginLeg(leg 1) -> MoveTo -> nested tick
      assert.deepEqual([r.status.state, r.status.leg, r.status.walked], ["WALK", 1, 1], "nested tick was a no-op");
      r.tick(); // next real tick completes leg 1 (pose already within 3m)
      assert.equal(r.status.state, "DONE");
      assert.equal(r.status.walked, 2);
    });

    await rtest("R10", "on-foot seam crossing (lb change, small jump) keeps walking", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 190, 0);
      r.follow([L(0x0201, 20, 0)]);
      h.pose = P(0x0101, 191, 0);
      r.tick();
      h.pose = P(0x0201, 2, 0); // lb changed, world jump 3m = seam
      r.tick();
      assert.equal(r.status.state, "WALK");
      assert.equal(h.stops, 0);
      h.pose = P(0x0201, 19, 0);
      r.tick();
      assert.equal(r.status.state, "DONE");
    });

    await rtest("R11", "cancel() lands in IDLE (goto treats as cancelled, not done/failed)", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 50, 0)]);
      r.tick();
      r.cancel();
      assert.equal(r.status.state, "IDLE");
      assert.equal(r.done, false);
      assert.ok(h.stops >= 1);
    });

    await rtest("R12", "stitch leg fails at the SHORT deadline with stitchBlocked", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 50, 0, { stitch: true })]);
      r.tick();
      simT += 10_001; // past STITCH_TIMEOUT_MS, well under LEG_TIMEOUT_MS
      r.tick();
      assert.equal(r.status.state, "FAILED");
      assert.equal(r.status.stitchBlocked, true);
      assert.equal(h.stops, 1);
    });

    await rtest("R12b", "non-stitch leg is untouched by the short deadline (still 30s)", () => {
      const h = unitHost();
      const r = new RT.RynthRouter(h, { log: quiet });
      h.pose = P(0x0101, 0, 0);
      r.follow([L(0x0101, 50, 0)]);
      r.tick();
      simT += 10_001;
      r.tick();
      assert.equal(r.status.state, "WALK", "10s does not fail a normal leg");
      simT += 20_001; // now past LEG_TIMEOUT_MS
      r.tick();
      assert.equal(r.status.state, "FAILED");
      assert.equal(r.status.stitchBlocked, false);
    });

    // ════ G* — GlobalRouter.goto (fake sidecar, ticking world) ════
    const GOPTS = { retries: 2, pollMs: 5, poseTimeoutMs: 400, stallMs: 600 };

    await t("G1", "bug1: goto waits out a late first pose instead of failing", async () => {
      const st = world();
      st.hidden = true; // host hasn't produced a snapshot yet
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      sidecar = async () => legsPayload([legAtWorld(st.wx + 30, st.wy), legAtWorld(st.wx + 60, st.wy)]);
      st.drive(router);
      setTimeout(() => (st.hidden = false), 30); // first "tick" lands late
      try {
        const r = await gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.state, "DONE");
        assert.equal(r.legsWalked, 2);
      } finally {
        st.stopDrive();
      }
    });

    await t("G2", "goto fails cleanly after pose deadline; sidecar never queried", async () => {
      const st = world();
      st.hidden = true; // never produces a pose
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      sidecar = async () => legsPayload([legAtWorld(st.wx + 30, st.wy)]);
      const r = await gr.goto(router, { ns: 1, ew: 1 }, { ...GOPTS, poseTimeoutMs: 60 });
      assert.equal(r.ok, false);
      assert.equal(r.error, "no player pose");
      assert.equal(routeCalls, 0);
    });

    await t("G3", "bug2: concurrent goto gets clean busy reply; latch clears after", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      sidecar = async () => legsPayload([legAtWorld(st.wx + 150, st.wy)]);
      st.drive(router);
      try {
        const p1 = gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        assert.equal(gr.busy, true);
        const r2 = await gr.goto(router, { ns: 2, ew: 2 }, GOPTS);
        assert.equal(r2.ok, false);
        assert.equal(r2.error, "goto already active");
        assert.equal(gr.busy, true, "first goto unaffected by the rejection");
        const r1 = await p1;
        assert.equal(r1.ok, true, JSON.stringify(r1));
        assert.equal(gr.busy, false, "latch cleared on completion");
        const r3 = await gr.goto(router, { ns: 3, ew: 3 }, GOPTS);
        assert.equal(r3.ok, true, "third goto runs after latch cleared");
      } finally {
        st.stopDrive();
      }
    });

    await t("G4", "bug2: latch clears on route-error AND on exception paths", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      // (a) sidecar route failure
      sidecar = async () => ({ ok: false, error: "no route" });
      const ra = await gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
      assert.equal(ra.ok, false);
      assert.equal(ra.error, "no route");
      assert.equal(gr.busy, false, "latch cleared after route error");
      // (b) host throws mid-goto
      const goodPose = st.host.TryGetPlayerPose;
      st.host.TryGetPlayerPose = () => {
        throw new Error("host exploded");
      };
      await assert.rejects(gr.goto(router, { ns: 1, ew: 1 }, GOPTS), /host exploded/);
      assert.equal(gr.busy, false, "latch cleared after exception");
      // (c) still usable afterwards
      st.host.TryGetPlayerPose = goodPose;
      sidecar = async () => legsPayload([legAtWorld(st.wx + 30, st.wy)]);
      st.drive(router);
      try {
        const rc = await gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        assert.equal(rc.ok, true, JSON.stringify(rc));
      } finally {
        st.stopDrive();
      }
    });

    await t("G5", "poll loop has a stall deadline (host stopped ticking)", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, FAST); // never ticked: no drive()
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      sidecar = async () => legsPayload([legAtWorld(st.wx + 60, st.wy)]);
      const r = await gr.goto(router, { ns: 1, ew: 1 }, { ...GOPTS, pollMs: 10, stallMs: 100 });
      assert.equal(r.ok, false);
      assert.match(r.error, /stalled/);
      assert.equal(router.status.state, "IDLE", "stalled route was cancelled");
      assert.equal(gr.busy, false);
    });

    await t("G6", "replan waits out a mid-teleport null pose", async () => {
      const st = world();
      st.blocked = true; // leg 1 can never progress
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      sidecar = async () => legsPayload([legAtWorld(st.wx + 60, st.wy)]);
      st.drive(router);
      try {
        const p = gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        await until(() => routeCalls === 1);
        st.hidden = true; // pose vanishes (teleport-like)
        await until(() => router.status.state === "FAILED"); // null-pose watchdog fires
        st.blocked = false;
        setTimeout(() => (st.hidden = false), 60); // pose returns mid-replan
        const r = await p;
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.replans, 1);
        assert.equal(routeCalls, 2);
        assert.equal(r.legsWalked, 1);
      } finally {
        st.stopDrive();
      }
    });

    await t("G7", "legsWalked sums completed legs across re-follow", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      sidecar = async () =>
        routeCalls === 1
          ? legsPayload([legAtWorld(st.wx + 30, st.wy), legAtWorld(st.wx + 180, st.wy)])
          : legsPayload([legAtWorld(st.wx + 30, st.wy)]);
      st.drive(router);
      try {
        const p = gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        await until(() => router.status.walked === 1 && routeCalls === 1); // leg A done
        st.blocked = true; // leg B stalls -> leg timeout -> FAILED -> replan
        await until(() => routeCalls === 2);
        st.blocked = false;
        const r = await p;
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.replans, 1);
        assert.equal(r.legsWalked, 2, "1 (before fail) + 1 (replanned) — not leg indices");
      } finally {
        st.stopDrive();
      }
    });

    await t("G8", "external cancel() aborts the goto without replanning", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, FAST);
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      sidecar = async () => legsPayload([legAtWorld(st.wx + 500, st.wy)]);
      st.drive(router);
      try {
        const p = gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        await until(() => routeCalls === 1);
        await sleep(20);
        router.cancel();
        const r = await p;
        assert.equal(r.ok, false);
        assert.equal(r.error, "route cancelled");
        assert.equal(routeCalls, 1, "no replan on a cancelled route");
        assert.equal(gr.busy, false);
      } finally {
        st.stopDrive();
      }
    });

    await t("G9", "blocked stitch: sidecar IGNORES avoid -> fail with avoidTried (v1 guard)", async () => {
      const st = world();
      // Tiny stitch deadline so the blocked stitch leg fails in ms; normal
      // legs keep FAST's 250ms watchdog.
      const router = new RT.RynthRouter(st.host, { ...FAST, stitchTimeoutMs: 60 });
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      st.blocked = true; // world never moves: the stitch leg cannot complete
      // A v1 (or avoid-blind) sidecar: same stitched plan whether or not "avoid" is sent.
      sidecar = async () => ({
        ...legsPayload([{ ...legAtWorld(st.wx + 60, st.wy), stitch: true }]),
        coverage: "mixed",
        stitchedLegs: 1,
        partial: true,
        avoidApplied: 0,
      });
      st.drive(router);
      try {
        const r = await gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        assert.equal(r.ok, false, JSON.stringify(r));
        assert.equal(r.error, "blocked stitch leg");
        assert.equal(r.replans, 0, "avoid-replan is not a normal replan");
        assert.equal(routeCalls, 2, "one avoid-replan attempt, then the identical-plan guard fires");
        assert.ok(r.blockedLeg && Number.isFinite(r.blockedLeg.x), "blockedLeg carried");
        assert.equal(r.avoidTried.length, 1, "the tried avoid circle is carried out");
        assert.ok(Number.isFinite(r.avoidTried[0].x) && r.avoidTried[0].r === 6, "avoid circle at blocked world pos, default r=6");
        assert.equal(r.stitchedLegs, 1);
        assert.equal(r.partial, true);
      } finally {
        st.stopDrive();
      }
    });

    await t("G10", "blocked stitch: sidecar HONORS avoid -> detours around and completes", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, { ...FAST, stitchTimeoutMs: 60 });
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      st.blocked = true; // block the initial stitch leg
      let avoidSeen = null;
      sidecar = async (body) => {
        const hasAvoid = Array.isArray(body.avoid) && body.avoid.length > 0;
        if (!hasAvoid) {
          // initial plan: a single blocked stitch leg
          return {
            ...legsPayload([{ ...legAtWorld(st.wx + 60, st.wy), stitch: true }]),
            coverage: "mixed", stitchedLegs: 1, partial: true, avoidApplied: 0,
          };
        }
        // avoid honored: a DIFFERENT, fully on-mesh plan the world can walk
        avoidSeen = body.avoid;
        return {
          ...legsPayload([legAtWorld(st.wx + 30, st.wy)]),
          coverage: "detour", stitchedLegs: 0, partial: false, avoidApplied: body.avoid.length,
        };
      };
      st.drive(router);
      try {
        const p = gr.goto(router, { ns: 1, ew: 1 }, GOPTS);
        await until(() => routeCalls === 2); // avoid-replan issued
        st.blocked = false; // let the detour plan walk to completion
        const r = await p;
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(routeCalls, 2, "initial + one avoid-replan");
        assert.equal(r.avoidTried.length, 1, "the avoid circle used is carried out");
        assert.ok(avoidSeen && avoidSeen.length === 1 && Number.isFinite(avoidSeen[0].x) && avoidSeen[0].r === 6, "sidecar received the avoid circle");
        assert.equal(r.coverage, "detour", "walked the on-mesh detour, not a stitch");
        assert.ok(r.legsWalked >= 1);
      } finally {
        st.stopDrive();
      }
    });

    await t("G11", "avoidRetries:0 restores the exact fail-fast (no avoid attempt)", async () => {
      const st = world();
      const router = new RT.RynthRouter(st.host, { ...FAST, stitchTimeoutMs: 60 });
      const gr = new GR.GlobalRouter(st.host, { log: quiet });
      routeCalls = 0;
      st.blocked = true;
      let sawAvoid = false;
      sidecar = async (body) => {
        if (Array.isArray(body.avoid) && body.avoid.length) sawAvoid = true;
        return {
          ...legsPayload([{ ...legAtWorld(st.wx + 60, st.wy), stitch: true }]),
          coverage: "mixed", stitchedLegs: 1, partial: true, avoidApplied: 0,
        };
      };
      st.drive(router);
      try {
        const r = await gr.goto(router, { ns: 1, ew: 1 }, { ...GOPTS, avoidRetries: 0 });
        assert.equal(r.ok, false, JSON.stringify(r));
        assert.equal(r.error, "blocked stitch leg");
        assert.equal(r.replans, 0);
        assert.equal(routeCalls, 1, "sidecar consulted exactly once — no avoid replan");
        assert.equal(sawAvoid, false, "no avoid ever sent");
        assert.equal(r.avoidTried.length, 0, "avoidTried empty");
      } finally {
        st.stopDrive();
      }
    });

    // ════ B*/C* — createGrindBot integration (real webhost heartbeat) ════
    const BOTCFG = {
      hz: 60,
      buffs: [],
      loot: false,
      vitals: false,
      control: { prefix: "!bot", log: quiet },
      nav: { endpoint: "http://127.0.0.1:8767" },
      router: { legTimeoutMs: 400, settleMs: 20, reissueMs: 60, log: quiet },
    };
    const BGOPTS = { retries: 2, pollMs: 5, poseTimeoutMs: 800, stallMs: 900 };
    const mkBot = async (st) => BOT.createGrindBot(session(st), BOTCFG);

    await t("B1", "bug1: bot.goto right after createGrindBot (pre-first-tick) works", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        sidecar = async () => legsPayload([legAtWorld(st.wx + 40, st.wy)]);
        // no waiting for the heartbeat: this used to be "no player pose"
        const r = await bot.goto({ ns: 1, ew: 1 }, BGOPTS);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.legsWalked, 1);
      } finally {
        bot.stop();
      }
    });

    await t("B2", "goto restores prior kernel state: running stays running", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        sidecar = async () => legsPayload([legAtWorld(st.wx + 40, st.wy)]);
        assert.equal(bot.kernel._running, true, "kernel runs after boot");
        const r = await bot.goto({ ns: 1, ew: 1 }, BGOPTS);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(bot.kernel._running, true, "restarted after goto");
      } finally {
        bot.stop();
      }
    });

    await t("B3", "goto does NOT restart a kernel that was stopped before goto", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        sidecar = async () => legsPayload([legAtWorld(st.wx + 40, st.wy)]);
        bot.kernel.stop(); // deliberate operator stop
        const r = await bot.goto({ ns: 1, ew: 1 }, BGOPTS);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(bot.kernel._running, false, "prior stopped state restored");
      } finally {
        bot.stop();
      }
    });

    await t("B4", "travel() then goto(): goto cancels the raw travel and wins", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        let lastLeg = null;
        sidecar = async () => {
          lastLeg = legAtWorld(st.wx + 40, st.wy);
          return legsPayload([lastLeg]);
        };
        const tr = bot.travel([legAtWorld(st.wx + 800, st.wy + 800)]);
        assert.equal(tr.ok, true);
        await sleep(30); // travel is walking
        const r = await bot.goto({ ns: 1, ew: 1 }, BGOPTS);
        assert.equal(r.ok, true, JSON.stringify(r));
        const [twx, twy] = wxy(lastLeg.lb, lastLeg.x, lastLeg.y);
        assert.ok(Math.hypot(st.wx - twx, st.wy - twy) < 12, "ended at goto target, not travel's");
      } finally {
        bot.stop();
      }
    });

    await t("B5", "bug2 + interleave: travel refused and 2nd goto busy while goto active; kernel untouched", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        // long enough for a wide busy window, short enough for the leg timeout
        sidecar = async () => legsPayload([legAtWorld(st.wx + 150, st.wy)]);
        assert.equal(bot.kernel._running, true);
        const p1 = bot.goto({ ns: 1, ew: 1 }, BGOPTS);
        assert.equal(bot.globalRouter.busy, true);
        const tr = bot.travel([legAtWorld(st.wx, st.wy + 50)]);
        assert.equal(tr.ok, false, "raw travel refused while goto owns the router");
        const r2 = await bot.goto({ ns: 2, ew: 2 }, BGOPTS);
        assert.equal(r2.ok, false);
        assert.equal(r2.error, "goto already active");
        assert.equal(bot.kernel._running, false, "busy rejection did not restart the kernel mid-goto");
        const r1 = await p1;
        assert.equal(r1.ok, true, JSON.stringify(r1));
        assert.equal(bot.kernel._running, true, "restored when the owning goto finished");
      } finally {
        bot.stop();
      }
    });

    const tell = (bot, sender, body) => bot.host._dispatchEvent({ kind: 2, stringPayload: `${sender} tells you, "${body}"` });

    await t("C1", "bug2 regression: control goto routes and reports arrival", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        sidecar = async () => legsPayload([legAtWorld(st.wx + 40, st.wy)]);
        tell(bot, "Boss", "!bot goto 10.0 20.0");
        await until(() => st.chats.some((c) => /arrived \(1 legs, 0 replans\)/.test(c)), 5000);
        assert.ok(st.chats.some((c) => /— routing/.test(c)), "acked with a routing reply");
      } finally {
        bot.stop();
      }
    });

    await t("C2", "second goto tell while routing: clean busy reply, first still arrives", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        sidecar = async () => legsPayload([legAtWorld(st.wx + 60, st.wy)]);
        tell(bot, "Boss", "!bot goto 10.0 20.0");
        tell(bot, "Boss", "!bot goto -5.0 5.0");
        await until(() => st.chats.some((c) => /route failed: goto already active/.test(c)), 5000);
        await until(() => st.chats.some((c) => /arrived \(1 legs/.test(c)), 5000);
        assert.equal(st.chats.filter((c) => /arrived/.test(c)).length, 1, "exactly one goto ran");
      } finally {
        bot.stop();
      }
    });

    await t("C3", "goto 1e309 -0 and out-of-range args get usage reply, no route", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        sidecar = async () => legsPayload([legAtWorld(st.wx + 40, st.wy)]);
        const callsBefore = routeCalls;
        tell(bot, "Uva", "!bot goto 1e309 -0");
        tell(bot, "Uva", "!bot goto 500 0");
        await until(() => st.chats.filter((c) => /usage: goto/.test(c)).length === 2, 3000);
        assert.equal(routeCalls, callsBefore, "sidecar never queried");
      } finally {
        bot.stop();
      }
    });

    await t("C4", "reply spam is throttled per sender", async () => {
      const st = world({ speed: 8 });
      const bot = await mkBot(st);
      try {
        for (let i = 0; i < 10; i++) tell(bot, "Spammer", "!bot status");
        await sleep(50);
        const replies = st.chats.filter((c) => c.startsWith("/t Spammer,"));
        assert.equal(bot.channel.commands.length, 10, "all commands were parsed");
        assert.equal(replies.length, 5, "replies capped at 5 per 5s window");
      } finally {
        bot.stop();
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n== rynth_navsim results ==");
  console.log("RESULT  ID   NAME");
  for (const [id, name, res] of rows) console.log(`${res.padEnd(7)} ${id.padEnd(4)} ${name}`);
  console.log(`\nnavsim: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
