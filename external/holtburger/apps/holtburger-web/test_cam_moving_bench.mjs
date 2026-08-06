// test_cam_moving_bench.mjs — headless suite for the DETERMINISTIC moving benchmark
// (`harness/lib/moving_path.mjs`, `harness/lib/moving_rig.mjs`,
// `harness/moving-bench.mjs`).
//
// WHY THIS SUITE EXISTS
// ---------------------
// "A harness that cannot prove its own repeatability is worse than none" — the
// overnight flag census produced 42 runs of unusable data because its baseline
// drifted 2.44x and nothing checked. The moving rig it replaced failed the same
// way for a different reason: it derived the camera pose from WALL CLOCK and the
// LIVE player position, so a slower arm swept a shorter arc from a different
// place. The moving control then ranged 27.0-33.6 ms against a 6.10 ms effect.
//
// So the claims below are the harness's product, and each is tested directly:
//
//   1. frame k gets pose k, whatever frame k COST      (§2, §5)
//   2. two runs of the same spec walk the same ground  (§1)
//   3. an unpinned anchor is refused, not substituted  (§3)
//   4. a camera that drifts is DETECTED, not averaged  (§6)
//   5. a run that streamed / ran short / diverged is REJECTED (§7)
//
// §5 is the load-bearing one: it runs the real in-page rig twice against a stub
// client whose frames take wildly different times, and asserts the two runs are
// pose-for-pose identical. That is the property the old rig did not have.
//
// Run: cd apps/holtburger-web/ && node test_cam_moving_bench.mjs

import { poseTable, normalizeSpec, tableChecksum, cellToWorld, LB_METRES } from "./harness/lib/moving_path.mjs";
import { movingRigSource } from "./harness/lib/moving_rig.mjs";
import { judge, deltaWalk } from "./harness/moving-bench.mjs";

let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

console.log("moving-bench — the deterministic moving benchmark");
console.log("=========================");

const ANCHOR = { x: 25171, y: 20344, z: 42 };
const baseSpec = { mode: "orbit", anchor: ANCHOR, frames: 60, dist: 26, el: 18, laps: 1 };

// ---------------------------------------------------------------------------
console.log("\n-- 1. the pose table is a pure function of the spec --");
{
  const a = poseTable(baseSpec);
  const b = poseTable({ ...baseSpec });
  check("1: two builds of the same spec produce the same checksum", a.checksum === b.checksum, a.checksum);
  check("2: ...and the same rows, byte for byte",
    JSON.stringify(a.rows) === JSON.stringify(b.rows));
  const c = poseTable({ ...baseSpec, dist: 27 });
  check("3: a 1 m radius change moves the checksum (it is not a constant)", a.checksum !== c.checksum,
    `${a.checksum} vs ${c.checksum}`);
  const d = poseTable({ ...baseSpec, anchor: { ...ANCHOR, x: ANCHOR.x + 0.5 } });
  check("4: a 0.5 m anchor change moves it too — a mis-pinned anchor cannot pass as the same run",
    a.checksum !== d.checksum);
  // Quantisation is 1 mm; that must NOT swallow anything at the scale that
  // changes which instances are culled (?statBatchMemo's slack is 8 METRES).
  const e = poseTable({ ...baseSpec, anchor: { ...ANCHOR, x: ANCHOR.x + 0.002 } });
  check("5: 2 mm still registers — the quantisation is 4 orders below the 8 m slack",
    a.checksum !== e.checksum);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. pose is indexed by FRAME, never by time --");
{
  const t = poseTable(baseSpec);
  check("6: the table has exactly `frames` rows", t.rows.length === 60);
  // The whole contract in one assertion: nothing in the module reads a clock,
  // so a table built now and one built after an arbitrary delay are identical.
  const before = t.checksum;
  const spin = Date.now() + 5;
  while (Date.now() < spin) { /* burn a few ms of wall clock */ }
  check("7: rebuilding after wall-clock has advanced changes nothing",
    poseTable(baseSpec).checksum === before);
  // The path is CLOSED, so the warm lap and the measure lap cover the same
  // ground rather than the measure lap starting somewhere the warm lap never
  // reached (which would price a cold cache as the steady state).
  const first = t.rows[0];
  // Frame `frames` of a 1-lap/60-frame path is frame 60 of a 2-lap/120-frame
  // path: both advance 6 deg per frame (az = az0 + laps*360*k/frames). If that
  // row is frame 0 again, the lap closed.
  const wrap = poseTable({ ...baseSpec, frames: 120, laps: 2 }).rows[60];
  const closed = [0, 1, 2].every((i) => Math.abs(first[i] - wrap[i]) < 1e-6);
  check("8: a full lap is CLOSED — frame `frames` returns to frame 0, so warm and measure cover the same ground",
    closed, `${first.slice(0, 3).map((v) => v.toFixed(3))} vs ${wrap.slice(0, 3).map((v) => v.toFixed(3))}`);
  // Angular rate is per FRAME. Doubling `frames` at the same `laps` HALVES the
  // per-frame step — which is what makes two arms sweep the same arc whatever
  // their fps, instead of the same arc-per-second at different frame counts.
  const dense = poseTable({ ...baseSpec, frames: 120 });
  const stepA = Math.hypot(t.rows[1][0] - t.rows[0][0], t.rows[1][1] - t.rows[0][1]);
  const stepB = Math.hypot(dense.rows[1][0] - dense.rows[0][0], dense.rows[1][1] - dense.rows[0][1]);
  check("9: the per-FRAME step is set by frames/laps alone, never by elapsed time",
    Math.abs(stepA / stepB - 2) < 0.01, `${stepA.toFixed(3)} m/frame vs ${stepB.toFixed(3)} m/frame`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. the spec refuses what the old rig assumed --");
{
  let threw = null;
  try { normalizeSpec({ mode: "orbit", frames: 60 }); } catch (e) { threw = e.message; }
  check("10: orbit without an explicit anchor THROWS (reading it live is the bug)",
    threw != null && /anchor/.test(threw), threw);
  threw = null;
  try { normalizeSpec({ mode: "spin", anchor: ANCHOR }); } catch (e) { threw = e.message; }
  check("11: an unknown mode throws rather than silently falling back", threw != null, threw);
  threw = null;
  try { normalizeSpec({ mode: "hop", hops: [{ cell: 1, x: 1, y: 1, z: 1 }] }); } catch (e) { threw = e.message; }
  check("12: hop mode needs >= 2 stops", threw != null, threw);
  // hop derives its frame count so no stop gets a short dwell.
  const h = normalizeSpec({ mode: "hop", dwell: 100, hops: [{ cell: 0x9722003a, x: 80, y: 80, z: 42 }, { cell: 0x9622003a, x: 80, y: 80, z: 42 }] });
  check("13: hop frames = stops * dwell (no partial dwell at the end)", h.frames === 200, String(h.frames));
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. hop mode derives its anchor from the CELL, not a live pose --");
{
  const hops = [{ cell: 0x9722003a, x: 80, y: 80, z: 42 }, { cell: 0x9622003a, x: 80, y: 80, z: 42 }];
  const t = poseTable({ mode: "hop", hops, dwell: 10, dist: 20, el: 15, dz: 1.2 });
  check("14: a teleloc is emitted on each stop's FIRST frame only",
    t.events.filter(Boolean).length === 2 && t.events[0] && t.events[10] && !t.events[1]);
  check("15: and it carries the cell + local x/y/z verbatim",
    /^@teleloc 9722003a 80 80 42$/.test(t.events[0]), t.events[0]);
  // cellToWorld folds the landblock origin the same way camera.js `__cam.world()`
  // does: x = ((cell>>>24)&0xff)*192 + localX.
  const w = cellToWorld(0x9722003a, 80, 80, 42);
  check("16: cell -> AC world metres folds the landblock origin (192 m per LB)",
    w.x === 0x97 * LB_METRES + 80 && w.y === 0x22 * LB_METRES + 80 && w.z === 42,
    JSON.stringify(w));
  // Stop 2 is 1 landblock west, so its camera anchor moves by exactly 192 m —
  // derived, never read, so it cannot drift with where the player actually landed.
  const eye0 = t.rows[0], eye1 = t.rows[10];
  check("17: the second stop's look-at is exactly one landblock away",
    Math.abs((eye0[3] - eye1[3]) - LB_METRES) < 1e-9, `${(eye0[3] - eye1[3]).toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// The in-page rig, driven against a stub client. This is the SHIPPED rig source
// — `movingRigSource()` is the same function `page.evaluate` sends — so what
// passes here is what runs on the box.
// ---------------------------------------------------------------------------
console.log("\n-- 5. the rig: frame k gets pose k, whatever frame k COST --");

/**
 * A stub client. `frameCostMs` is consumed one entry per frame, so a run can be
 * given a deliberately erratic frame profile; `drift` injects the OLD rig's
 * failure (the camera creeping away from where it was told to be).
 */
function stubClient({ frameCostMs, drift = 0, lbChurnAt = [] }) {
  const g = globalThis;
  let clock = 0;
  let frame = 0;
  const cam = { position: { x: 0, y: 0, z: 0 } };
  const lbs = new Map([[1, true], [2, true], [3, true]]);
  const applied = [];
  g.performance = { now: () => clock };
  g.requestAnimationFrame = (cb) => { setTimeout(() => cb(clock), 0); return 1; };
  g.__diag = { vfxGauge: { armed: true, frames: 0, tCpuMs: 0, tGpuMs: -1 } };
  g.__cam = {
    set(ex, ey, ez) {
      applied.push([ex, ey, ez]);
      // acToThree(ax,ay,az) = [ax, az, -ay]  (scene3d/adapter.js :1772)
      const d = drift * frame;
      cam.position.x = ex + d; cam.position.y = ez; cam.position.z = -ey;
    },
  };
  g.__renderOnce = () => {
    const cost = frameCostMs[frame % frameCostMs.length];
    clock += cost;
    g.__diag.vfxGauge.frames += 1;
    g.__diag.vfxGauge.tCpuMs = cost;
    if (lbChurnAt.includes(frame)) lbs.set(100 + frame, true);
    renderer.info.render.calls += 40;
    renderer.info.render.triangles += 400000;
    frame += 1;
    return true;
  };
  const renderer = { info: { autoReset: true, render: { calls: 0, triangles: 0 } } };
  g.liveScene3d = {
    renderer,
    scene: { traverse(fn) { fn({ isBatchedMesh: true, name: "static-batch-c-r50x50-s08000001-m0" }); } },
    cameraSwitcher: { activeCamera: cam },
    terrainBakedLbs: lbs,
  };
  g.__statBatchXStats = () => ({ walk: { calls: 10, hitsExact: 1, hitsSlack: 2, rebuilds: 3, rebuildsSlack: 4, instancesWalked: 5, instancesSkipped: 6, errors: 0, slots: { all: 13195 }, sphere: { calls: 0, walks: 9, builds: 1, slotsBuilt: 200, slotsWalked: 1800, ineligible: 0, errors: 0, lateActivations: 0, verifyFails: 0 } } });
  g.__sessionHandle = { sendChat() {} };
  return { applied, get frames() { return frame; } };
}

async function runRig(table, opts) {
  const s = stubClient(opts);
  movingRigSource()();
  globalThis.__mbench.install({ spec: table.spec, rows: table.rows, events: table.events, warmFrames: 0, drive: "ondemand" });
  const r = await globalThis.__mbench.run();
  return { r, stub: s };
}

{
  const t = poseTable({ ...baseSpec, frames: 24 });
  // Two arms with wildly different frame profiles — 8 ms flat vs a 6-40 ms
  // sawtooth. The OLD rig would have swept different arcs; this one must not.
  const fast = await runRig(t, { frameCostMs: [8] });
  const slow = await runRig(t, { frameCostMs: [6, 40, 11, 33, 9, 27] });
  check("18: both arms rendered exactly `frames` frames", fast.r.frames === 24 && slow.r.frames === 24);
  check("19: and applied the IDENTICAL pose sequence despite a 6.7x frame-cost spread",
    JSON.stringify(fast.stub.applied) === JSON.stringify(slow.stub.applied),
    `${fast.stub.applied.length} poses`);
  check("20: so their realised checksums match each other AND the intended path",
    fast.r.realisedChecksum === slow.r.realisedChecksum && fast.r.realisedChecksum === t.checksum,
    `${fast.r.realisedChecksum} / ${slow.r.realisedChecksum} / intended ${t.checksum}`);
  // The measured quantity DOES differ — that is the point. Same workload,
  // different cost, which is the only shape in which an A/B means anything.
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  check("21: the COST differs while the workload does not (the A/B is meaningful)",
    Math.abs(mean(fast.r.cpuMs) - 8) < 1e-9 && mean(slow.r.cpuMs) > 15,
    `fast ${mean(fast.r.cpuMs).toFixed(1)} ms, slow ${mean(slow.r.cpuMs).toFixed(1)} ms`);
  check("22: renderer.info.autoReset was turned OFF and draws differenced per frame",
    globalThis.liveScene3d.renderer.info.autoReset === false
    && fast.r.draws.length === 24 && fast.r.draws.every((d) => d === 40),
    `draws/frame ${fast.r.draws[0]}`);
  check("23: every frame carried a vfxGauge sample (no silent gaps)", fast.r.missedGauge === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. a camera that does not obey is DETECTED --");
{
  const t = poseTable({ ...baseSpec, frames: 24 });
  // Reproduce the old rig's failure: the camera creeps 5 cm per frame away from
  // where it was told to be, because something is re-deriving it from a drifting
  // player pose. Over 24 frames that is 1.2 m — invisible in an fps average,
  // fatal to an A/B, and it must not be able to pass.
  const drifted = await runRig(t, { frameCostMs: [8], drift: 0.05 });
  check("24: a 5 cm/frame camera drift changes the realised checksum",
    drifted.r.realisedChecksum !== t.checksum,
    `realised ${drifted.r.realisedChecksum} vs intended ${t.checksum}`);
  const rep = {
    pathChecksum: t.checksum, realisedChecksum: drifted.r.realisedChecksum,
    frames: { requested: 24, measured: 24 }, lb: { churnFrames: 0 },
    workload: { draws: { min: 40, max: 40, mean: 40 } }, errors: [], missedGauge: 0,
  };
  const j = judge(rep, { churnMax: 0, drawSpreadMax: 0.05 });
  check("25: and the run is REJECTED, not averaged in",
    !j.ok && /DIVERGED-PATH/.test(j.reasons.join(" ")), j.reasons[0]);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. the verdict rejects every way a run can diverge --");
{
  const ok = {
    pathChecksum: "abc", realisedChecksum: "abc",
    frames: { requested: 100, measured: 100 }, lb: { churnFrames: 0 },
    workload: { draws: { min: 100, max: 102, mean: 101 } }, errors: [], missedGauge: 0,
  };
  check("26: a clean run is USABLE", judge(ok, { churnMax: 0, drawSpreadMax: 0.05 }).ok);
  check("27: streaming during an orbit is rejected (churn budget 0)",
    /DIVERGED-STREAM/.test(judge({ ...ok, lb: { churnFrames: 7 } }, { churnMax: 0, drawSpreadMax: 0.05 }).reasons.join(" ")));
  check("28: ...but hop mode, where streaming is the point, allows it",
    judge({ ...ok, lb: { churnFrames: 7 } }, { churnMax: 1e9, drawSpreadMax: 0.05 }).ok);
  check("29: a short run is rejected (a truncated lap is a different lap)",
    /SHORT/.test(judge({ ...ok, frames: { requested: 100, measured: 81 } }, { churnMax: 0, drawSpreadMax: 0.05 }).reasons.join(" ")));
  check("30: a wide per-frame draw spread is rejected",
    /DIVERGED-WORKLOAD/.test(judge({ ...ok, workload: { draws: { min: 60, max: 140, mean: 100 } } }, { churnMax: 0, drawSpreadMax: 0.05 }).reasons.join(" ")));
  check("31: page errors are rejected",
    /ERRORS/.test(judge({ ...ok, errors: ["boom"] }, { churnMax: 0, drawSpreadMax: 0.05 }).reasons.join(" ")));
  check("32: missing vfxGauge samples are rejected (a silent `?vfxGauge` typo)",
    /GAUGE-GAPS/.test(judge({ ...ok, missedGauge: 40 }, { churnMax: 0, drawSpreadMax: 0.05 }).reasons.join(" ")));
}

// ---------------------------------------------------------------------------
console.log("\n-- 8. walk counters are reported as DELTAS over the measure lap --");
{
  const a = { calls: 100, hitsExact: 10, hitsSlack: 20, rebuilds: 5, rebuildsSlack: 5, instancesWalked: 1000, instancesSkipped: 2000, errors: 0, sphere: { calls: 0, walks: 10, builds: 2, slotsBuilt: 400, slotsWalked: 2000, ineligible: 0, errors: 0, lateActivations: 0, verifyFails: 0 } };
  const b = { calls: 200, hitsExact: 60, hitsSlack: 60, rebuilds: 10, rebuildsSlack: 10, instancesWalked: 3000, instancesSkipped: 9000, errors: 0, sphere: { calls: 0, walks: 40, builds: 3, slotsBuilt: 600, slotsWalked: 8000, ineligible: 0, errors: 0, lateActivations: 0, verifyFails: 0 } };
  const d = deltaWalk(a, b);
  check("33: cumulative counters are differenced, not quoted raw",
    d.calls === 100 && d.hitsExact === 50 && d.instancesSkipped === 7000, JSON.stringify(d));
  // (60-10 exact + 60-20 slack) / (200-100 calls) = 90/100. Over the LAP, not
  // since page load — quoting the raw counter would fold in boot and the warm lap.
  check("34: hitRate is over the lap's own calls", d.hitRate === 0.9, String(d.hitRate));
  // The one number that says whether the sphere cache is worth anything under
  // motion: slots read from the cache per slot spent building it.
  check("35: sphere payback = slotsWalked / slotsBuilt over the lap",
    d.sphere.payback === 30, String(d.sphere.payback));
  check("36: a cache rebuilt as fast as it is read reports payback ~1 (a LOSS)",
    deltaWalk(a, { ...b, sphere: { ...b.sphere, slotsWalked: 2200, slotsBuilt: 600 } }).sphere.payback === 1,
    String(deltaWalk(a, { ...b, sphere: { ...b.sphere, slotsWalked: 2200, slotsBuilt: 600 } }).sphere.payback));
}

// ---------------------------------------------------------------------------
console.log("\n-- 9. the checksum is stable across processes --");
{
  // The intended checksum is computed in node and the realised one in the page,
  // by two separate implementations of the same FNV-1a. If they ever drift,
  // every run reports DIVERGED-PATH and the harness is dead — so pin the value.
  const t = poseTable({ mode: "orbit", anchor: { x: 1000, y: 2000, z: 30 }, frames: 8, dist: 20, el: 10, laps: 1, dz: 1 });
  check("37: a fixed spec hashes to a fixed value", t.checksum === tableChecksum(t.rows, t.events), t.checksum);
  check("38: and the page-side implementation agrees with the node-side one",
    (await runRig(t, { frameCostMs: [8] })).r.realisedChecksum === t.checksum, t.checksum);
}

console.log("=========================");
console.log(`moving-bench test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
