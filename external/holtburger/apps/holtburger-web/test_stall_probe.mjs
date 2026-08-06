// 2026-08-06 — `scene3d/stall_probe.js`, the instrument that attributes the
// p99 1630 ms hitch (as opposed to `frame_split.js`, which splits the mean).
//
// WHY THIS FILE EXISTS. This probe's output is going to be quoted straight into
// "the stall is X" — and this workload has already produced SIX 2x+
// overestimates from instruments that looked right. So every property the
// attribution rests on is asserted against a fake renderer + fake diag surfaces
// that reproduce the real shapes.
//
//   PART 1 — THE FRAME EDGE IS THE WINDOW. `intervalMs` is measured between two
//            `render` entries, and `renderMs` is the time inside the call. The
//            derived `outsideMs` is the number that decides the whole
//            investigation (in-render shader link vs between-render transcode),
//            so `renderMs + outsideMs === intervalMs` must hold exactly.
//   PART 2 — THE THRESHOLD IS A FILTER, NOT A SAMPLER. Short frames must never
//            reach the ring, and every frame must reach the interval
//            percentiles — an instrument that only counts what it rings would
//            report a p50 of 1600 ms.
//   PART 3 — COUNTERS ARE DIFFERENCED, LEVELS ARE NOT. `renderer.info.render.calls`
//            is per-frame (autoReset defaults TRUE) and differencing it is
//            meaningless; `resident` is a level. Both must land in `at`, never
//            in `d`. This is the exact class of error that priced residency as
//            if it were drawn.
//   PART 4 — ONLY MS BUCKETS ARE PRICED. `explainedMs` must be built from the
//            ms-denominated buckets alone. A count that wanders into the
//            millisecond sum is how "847 draws" becomes "847 ms".
//   PART 5 — THE RESIDUAL IS REPORTED. `residualMs` = interval − explained, and
//            it must be honest even when it is most of the frame. A probe that
//            cannot be wrong is not measuring anything.
//   PART 6 — THE RING IS A RING. Overflow drops the OLDEST and reports
//            `dropped`, so a long walk cannot silently lose the worst frame's
//            neighbours without saying so.
//   PART 7 — MISSING DIAG SURFACES DEGRADE TO ZERO, NEVER THROW. `__linkProbe`
//            does not exist until armed; `__landblockLru` lands ~35 s after
//            in-world. A throw inside the `renderer.render` wrapper would take
//            the client down, from a diagnostic.
//   PART 8 — DISARM RESTORES EVERY SLOT. `renderer.render` and every wrapped GL
//            entry point go back exactly as found — including the case where
//            there was no own property to restore. And the ring SURVIVES
//            disarm: stopping the overhead must not discard the evidence.
//   PART 9 — THE GL WRAP COUNTS AND BILLS. Upload calls land in the right
//            group with their byte counts, and `glWrapOverheadMs` prices the
//            instrument from the measured `now()` cost.

import assert from "node:assert/strict";

let failures = 0;
function check(cond, label) {
  if (cond) return;
  failures += 1;
  // eslint-disable-next-line no-console
  console.error(`FAIL: ${label}`);
}
function eq(a, b, label) {
  try {
    assert.deepEqual(a, b);
  } catch (_) {
    failures += 1;
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${label}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`);
  }
}

// --- fake window BEFORE importing the module (it installs on window at load) --
const win = {};
globalThis.window = win;

const { armStallProbe, disarmStallProbe, resetStallProbe, stallReport, stallSamples } = await import(
  "./scene3d/stall_probe.js"
);

check(typeof win.__stallArm === "function", "install: window.__stallArm published");
check(typeof win.__stallReport === "function", "install: window.__stallReport published");

// ---------------------------------------------------------------------------
// Fixture: a renderer whose `render` burns a controllable number of ms, and
// diag surfaces whose counters we drive by hand.
// ---------------------------------------------------------------------------
function burn(ms) {
  const t = performance.now();
  // Busy-wait: `render` is synchronous in three, and the probe's whole premise
  // is that it brackets synchronous time. A setTimeout would test nothing.
  while (performance.now() - t < ms) {
    /* spin */
  }
}

const glCalls = [];
function makeGl() {
  const gl = {
    LINK_STATUS: 0x8b82,
    getExtension: () => null,
    getProgramParameter: () => true,
    linkProgram: () => {},
    texStorage3D(...a) {
      glCalls.push(["texStorage3D", a.length]);
      burn(1);
    },
    texSubImage3D() {
      glCalls.push(["texSubImage3D"]);
    },
    bufferData() {
      glCalls.push(["bufferData"]);
    },
    readPixels() {
      glCalls.push(["readPixels"]);
    },
  };
  return gl;
}

const state = {
  xu7: { decodes: 0, decodeMs: 0, notReadySkips: 0, decodeErrors: 0 },
  atlas: { layerGrows: 0, layerGrowUploads: 0, layerGrowFails: 0, liveLayers: 12, allocLayers: 16 },
  lru: { resident: 25, evicted: 0, parked: 3, parkedTotal: 0, unparkedTotal: 0, liveGeom: 7100, geomPressureEngagements: 0, geomPressureActive: false, centerJumps: 0 },
  infoCalls: 552,
};
win.__xu7Stats = () => ({ ...state.xu7 });
win.__atlasStats = () => ({ ...state.atlas });
win.__landblockLru = { getStats: () => ({ ...state.lru }) };
win.__bc7Stats = () => ({ fetches: 202, hits: 183, preFetches: 0, absent: 0, bytesFetched: 0 });

function makeRenderer(gl) {
  return {
    info: {
      programs: { length: 300 },
      memory: { geometries: 5000, textures: 900 },
      render: { calls: state.infoCalls, triangles: 381000 },
    },
    getContext: () => gl,
    render(_scene, _cam) {
      burn(this.__burnMs || 0);
    },
  };
}

const gl = makeGl();
const renderer = makeRenderer(gl);
const hadOwnRenderBefore = Object.prototype.hasOwnProperty.call(renderer, "render");
check(hadOwnRenderBefore === true, "fixture: render is an own property before arming");

const armed = armStallProbe({ renderer, thresholdMs: 40, ring: 3, longtask: false });
check(armed.armed === true, `arm: succeeded (${JSON.stringify(armed)})`);
check(armed.glWrapped === true, "arm: GL wrap installed");
check(armed.linkWrapped === true, "arm: link probe force-installed without ?linkProbe=on");
check(armed.nowCostNs > 0, "arm: measured a non-zero performance.now() unit cost");

// Arming twice must refuse rather than double-wrap (a double wrap would charge
// every bucket twice and look like a 2x regression).
const twice = armStallProbe({ renderer });
check(typeof twice.error === "string", "arm: refuses a second arm");

// ---------------------------------------------------------------------------
// PART 1/2/3/4/5 — drive frames.
// ---------------------------------------------------------------------------
// Frame A: short. Must NOT ring.
renderer.__burnMs = 2;
renderer.render();
burn(5);

// Frame B: opens the window that will be long. During it we simulate 120 ms of
// xu7 decode landing OUTSIDE the render call (the transcode shape) and one
// atlas grow, plus a real GL alloc inside.
renderer.__burnMs = 3;
renderer.render();
state.xu7.decodes += 4;
state.xu7.decodeMs += 120;
state.atlas.layerGrows += 1;
state.atlas.layerGrowUploads += 4;
state.lru.evicted += 2;
state.lru.unparkedTotal += 5;
renderer.info.render.calls = 847; // per-frame level changed — must land in `at`, not `d`
gl.texStorage3D(1, 2, 3, 4, 5, 6); // 1 ms, into texAlloc
gl.texSubImage3D();
gl.bufferData();
burn(60); // the gap; total interval will be ~64 ms > 40 ms threshold

// Frame C: closes B's window.
renderer.__burnMs = 1;
renderer.render();

let rep = stallReport();
check(rep.frames === 2, `part2: every closed frame counted (frames=${rep.frames})`);
check(rep.long.count === 1, `part2: exactly one frame rang (count=${rep.long.count})`);
const recB = rep.ring[0];
check(recB.intervalMs >= 60, `part1: interval captured the whole window (${recB.intervalMs} ms)`);
check(recB.renderMs >= 2.5 && recB.renderMs < 20, `part1: renderMs brackets the call only (${recB.renderMs} ms)`);
check(
  Math.abs(recB.renderMs + recB.outsideMs - recB.intervalMs) < 0.15,
  `part1: renderMs + outsideMs === intervalMs (${recB.renderMs} + ${recB.outsideMs} vs ${recB.intervalMs})`,
);
check(recB.outsideMs > recB.renderMs * 5, "part1: a between-frame stall is charged to outsideMs, not the render call");

// PART 3 — levels vs accumulators.
check(recB.d.xu7DecodeMs === 120, `part3: xu7DecodeMs differenced (${recB.d.xu7DecodeMs})`);
check(recB.d.xu7Decodes === 4, "part3: xu7 decode COUNT differenced");
check(recB.d.atlasGrows === 1, "part3: atlas grows differenced");
check(recB.d.lruEvicted === 2 && recB.d.lruUnparked === 5, "part3: LRU accumulators differenced");
check(!("calls" in recB.d), "part3: renderer.info.render.calls is a LEVEL — never differenced");
check(!("lruResident" in recB.d), "part3: LRU resident is a LEVEL — never differenced");
check(recB.at.calls === 847, `part3: the per-frame draw level is reported absolutely (${recB.at.calls})`);
check(recB.at.lruResident === 25, "part3: resident reported absolutely");
check(recB.at.atlasLiveLayers === 12, "part3: live layers reported absolutely");

// PART 4 — only ms buckets are priced.
const byKeys = recB.by.map((r) => r[0]);
check(byKeys.includes("xu7DecodeMs"), "part4: xu7DecodeMs is priced");
check(byKeys.includes("texAllocMs"), `part4: the measured GL alloc is priced (by=${JSON.stringify(recB.by)})`);
check(!byKeys.includes("xu7Decodes"), "part4: a COUNT never enters the ms ranking");
check(!byKeys.includes("atlasGrows"), "part4: atlas grow COUNT never enters the ms ranking");
check(recB.by[0][0] === "xu7DecodeMs", `part4: buckets ranked by ms desc (top=${recB.by[0][0]})`);

// PART 5 — the residual is reported and honest.
check(recB.explainedMs >= 120 && recB.explainedMs < 140, `part5: explainedMs ~= 121 (${recB.explainedMs})`);
check(
  Math.abs(recB.residualMs - (recB.intervalMs - recB.explainedMs)) < 0.05,
  "part5: residualMs = interval − explained",
);
check(rep.residualMs === Number((rep.long.totalMs - rep.explainedMs).toFixed(1)), "part5: report-level residual closes");
check(
  Math.abs(rep.long.insideRenderMs + rep.long.outsideRenderMs - rep.long.totalMs) < 0.2,
  "part5: the report's inside/outside split re-adds to the long-frame total",
);
check(rep.probe.sampleMs.p50 >= 0, "part5: the probe prices its own sampler");
check(rep.probe.glWrapOverheadMs >= 0, "part5: the probe prices its own GL wrap");

// PART 9 — the GL wrap counted and grouped.
check(rep.probe.glCalls.texAlloc === 1, `part9: texStorage3D landed in texAlloc (${rep.probe.glCalls.texAlloc})`);
check(rep.probe.glCalls.texUpload === 1, "part9: texSubImage3D landed in texUpload");
check(rep.probe.glCalls.bufUpload === 1, "part9: bufferData landed in bufUpload");
check(rep.probe.glCalls.sync === 0, "part9: nothing miscounted into the sync group");
check(recB.d.texAllocMs >= 0.8, `part9: the 1 ms alloc was timed (${recB.d.texAllocMs} ms)`);
check(glCalls.length === 3, "part9: the wrap FORWARDS — the real GL functions still ran");

// ---------------------------------------------------------------------------
// PART 6 — the ring is a ring.
// ---------------------------------------------------------------------------
for (let i = 0; i < 4; i++) {
  renderer.__burnMs = 1;
  renderer.render();
  burn(50);
}
renderer.render();
rep = stallReport();
check(rep.long.count === 3, `part6: ring capped at 3 (${rep.long.count})`);
check(rep.long.dropped >= 2, `part6: drops are reported, not hidden (${rep.long.dropped})`);
check(rep.ring[0].seq > 0, "part6: the OLDEST entry was dropped (seq of head advanced)");
const seqs = rep.ring.map((r) => r.seq);
eq(seqs, [...seqs].sort((a, b) => a - b), "part6: ring stays in chronological order");

// ---------------------------------------------------------------------------
// PART 7 — missing diag surfaces degrade to zero, never throw.
// ---------------------------------------------------------------------------
resetStallProbe();
const savedXu7 = win.__xu7Stats;
const savedLru = win.__landblockLru;
const savedAtlas = win.__atlasStats;
delete win.__xu7Stats;
delete win.__landblockLru;
win.__atlasStats = () => {
  throw new Error("atlas diag exploded");
};
let threw = null;
try {
  renderer.__burnMs = 1;
  renderer.render();
  burn(50);
  renderer.render();
} catch (e) {
  threw = e;
}
check(threw === null, `part7: a broken diag surface never throws through renderer.render (${threw && threw.message})`);
rep = stallReport();
check(rep.long.count === 1, "part7: the frame still rang with the diag surfaces gone");
check(rep.ring[0].at.atlasLiveLayers === 0, "part7: a throwing surface degrades to zero");
win.__xu7Stats = savedXu7;
win.__landblockLru = savedLru;
win.__atlasStats = savedAtlas;

// ---------------------------------------------------------------------------
// PART 8 — disarm restores everything; the ring survives.
// ---------------------------------------------------------------------------
const ringBefore = stallSamples().length;
const off = disarmStallProbe();
check(off.armed === false, "part8: disarm reports disarmed");
check(off.ringHeld === ringBefore, `part8: the ring SURVIVES disarm (${off.ringHeld} vs ${ringBefore})`);
check(renderer.render.__stallProbeWrapped !== true, "part8: renderer.render unwrapped");
check(Object.prototype.hasOwnProperty.call(renderer, "render"), "part8: render restored as an own property");
check(gl.texStorage3D.__stallProbeWrapped !== true, "part8: texStorage3D unwrapped");
check(gl.readPixels.__stallProbeWrapped !== true, "part8: readPixels unwrapped");
const before = glCalls.length;
gl.texStorage3D(1);
gl.readPixels();
check(glCalls.length === before + 2, "part8: the restored GL functions are the originals and still work");

// A disarmed probe must be inert: driving `render` adds no frames.
const framesAtDisarm = stallReport().frames;
renderer.render();
burn(50);
renderer.render();
check(stallReport().frames === framesAtDisarm, "part8: a disarmed probe records nothing");

// And it can be re-armed cleanly (a stuck `armed` flag would make the second
// 1070 session of the day useless).
const rearm = armStallProbe({ renderer, thresholdMs: 40, ring: 2, longtask: false });
check(rearm.armed === true, `part8: re-arms after disarm (${JSON.stringify(rearm)})`);
check(stallReport().long.count === 0, "part8: re-arm clears the ring");
disarmStallProbe();

// ---------------------------------------------------------------------------
// Non-own-property restore: three's `render` is a PROTOTYPE method on the real
// renderer, so the probe must DELETE its own property rather than pin the
// prototype method as an own one — the frame_split PART 9 lesson.
// ---------------------------------------------------------------------------
class FakeRenderer {
  constructor(g) {
    this.info = { programs: { length: 1 }, memory: { geometries: 0, textures: 0 }, render: { calls: 0, triangles: 0 } };
    this._gl = g;
  }
  getContext() {
    return this._gl;
  }
  render() {}
}
const protoR = new FakeRenderer(makeGl());
check(!Object.prototype.hasOwnProperty.call(protoR, "render"), "proto: render starts inherited");
armStallProbe({ renderer: protoR, thresholdMs: 40, longtask: false });
check(Object.prototype.hasOwnProperty.call(protoR, "render"), "proto: armed adds an own property");
disarmStallProbe();
check(
  !Object.prototype.hasOwnProperty.call(protoR, "render"),
  "proto: disarm DELETES the own property, leaving the prototype method exposed",
);

if (failures) {
  // eslint-disable-next-line no-console
  console.error(`\ntest_stall_probe: ${failures} FAILURE(S)`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log("test_stall_probe: OK");
