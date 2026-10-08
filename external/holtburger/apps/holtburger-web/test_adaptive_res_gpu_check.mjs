// adaptiveResGpuCheck (2026-10-07). The GPU fence gate for the adaptive
// render-scale controller. Live on the owner's 1070 (quality=ultra), the
// controller cut the scale 1 → 0.4 while frame time was the SAME at 0.47, 0.88
// and 2.0: the frames were main-thread bound. Asserts:
//   1. CPU-bound (slow frames at EVERY scale, GPU keeps up): never lowers from
//      1, and logs one "holding" line per run.
//   2. CPU-bound after a drop (start at 0.47): raises back to full resolution
//      even though frames stay over the band.
//   3. GPU-bound (GPU behind, frames slow above a threshold scale): still
//      lowers, to the sustainable side. The gate must not break the R9 290 case.
//   4. No probe / unknown verdicts: the old rAF-only behaviour (lowers).
//   5. Fast path: two catastrophic frames with the GPU keeping up do not lower;
//      with the GPU behind they do.
//   6. createFenceGpuProbe on a fake GL: verdict per frame, one-shot sample(),
//      null without fence support or on a lost context.
import {
  AdaptiveRenderScaleController,
  createFenceGpuProbe,
} from "./scene3d/adaptive_render_scale.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// `frameMs(scale)` = frame time at a scale; `behind(scale)` = probe verdict
// (true/false/null) for each frame at that scale.
function runSim({ startScale = 1, seconds = 120, frameMs, behind, probe = true }) {
  let clock = 0;
  let scale = startScale;
  let verdict = null;
  const logs = [];
  const gpuProbe = probe ? { sample: () => verdict } : null;
  const c = new AdaptiveRenderScaleController({
    getScale: () => scale,
    applyScale: (s) => { scale = s; },
    minScale: 0.35,
    maxScale: 1,
    gpuProbe,
    now: () => clock,
    log: (m) => logs.push(m),
  });
  let minSeen = scale;
  while (clock < seconds * 1000) {
    clock += frameMs(scale);
    verdict = behind(scale);
    c.recordFrame();
    minSeen = Math.min(minSeen, scale);
  }
  return { c, scale, minSeen, logs };
}

// 1. CPU-bound at full resolution: 70 ms frames at every scale, GPU idle.
{
  const { c, minSeen, logs } = runSim({ frameMs: () => 70, behind: () => false });
  check("CPU-bound: never lowers from 1", minSeen === 1, `minSeen=${minSeen}`);
  check("CPU-bound: counts holds", c.cpuBoundHolds > 10, `holds=${c.cpuBoundHolds}`);
  const holdLogs = logs.filter((m) => m.includes("holding"));
  check("CPU-bound: one 'holding' log per run, not one per window", holdLogs.length === 1,
    `holdLogs=${holdLogs.length}`);
  check("CPU-bound: no scale changes at all", c.changes === 0, `changes=${c.changes}`);
}

// 2. CPU-bound after an earlier drop: 45 ms frames (inside the band, the
//    case the old controller never recovered from) and GPU idle → back to 1.
{
  const { scale, logs } = runSim({ startScale: 0.47, frameMs: () => 45, behind: () => false });
  check("CPU-bound from 0.47: recovers to full resolution", scale === 1, `scale=${scale}`);
  check("CPU-bound recovery says why", logs.some((m) => m.includes("GPU kept up on 100% of frames")),
    JSON.stringify(logs.slice(0, 3)));
}

// 3. GPU-bound: above 0.6 the GPU is behind and frames take 80 ms; at/below
//    it the GPU keeps up at 17 ms. Must still lower, and settle at <= 0.6.
{
  const { scale, minSeen } = runSim({
    seconds: 600,
    frameMs: (s) => (s <= 0.6 + 1e-9 ? 17 : 80),
    behind: (s) => s > 0.6 + 1e-9,
  });
  check("GPU-bound: lowers below the threshold scale", minSeen <= 0.6 + 1e-9, `minSeen=${minSeen}`);
  check("GPU-bound: ends on the sustainable side", scale <= 0.6 + 1e-9, `scale=${scale}`);
}

// 4. No probe (WebGL1 / flag off) and an all-null probe: old behaviour.
{
  const a = runSim({ probe: false, frameMs: () => 70, behind: () => false });
  check("no probe: 70 ms frames still lower (old behaviour)", a.minSeen < 1, `minSeen=${a.minSeen}`);
  // 2026-10-07 (later): with a probe installed, lowering needs a GPU-BOUND
  // verdict. Unknown and mixed windows HOLD (live: 29-30% "behind" windows and
  // unknown load-stall frames ratcheted the owner's 1070 to 0.35).
  const b = runSim({ frameMs: () => 70, behind: () => null });
  check("probe with unknown verdicts: 70 ms frames HOLD at 1", b.minSeen === 1, `minSeen=${b.minSeen}`);
  let n = 0;
  const m = runSim({ frameMs: () => 70, behind: () => (n++ % 20) < 7 });
  check("mixed verdicts (35% behind): HOLD at 1", m.minSeen === 1, `minSeen=${m.minSeen}`);
  let k = 0;
  const g = runSim({ frameMs: () => 70, behind: () => (k++ % 20) < 12 });
  check("60% behind (GPU-bound): still lowers", g.minSeen < 1, `minSeen=${g.minSeen}`);
}

// 5. Fast path: alternate normal frames with pairs of 400 ms stalls.
function stallSim(behindDuringStall) {
  let clock = 0, scale = 1, verdict = null, i = 0;
  const c = new AdaptiveRenderScaleController({
    getScale: () => scale,
    applyScale: (s) => { scale = s; },
    gpuProbe: { sample: () => verdict },
    now: () => clock,
  });
  while (clock < 60_000) {
    const stall = (i % 40) >= 38; // two consecutive catastrophic frames every 40
    clock += stall ? 400 : 16;
    verdict = stall ? behindDuringStall : false;
    c.recordFrame();
    i++;
  }
  return { c, scale };
}
{
  const cpu = stallSim(false);
  check("fast path: CPU stalls with the GPU keeping up never lower", cpu.c.changes === 0,
    `changes=${cpu.c.changes} scale=${cpu.scale}`);
  const gpu = stallSim(true);
  check("fast path: the same stalls with the GPU behind do lower", gpu.c.changes > 0,
    `changes=${gpu.c.changes}`);
}

// 6. createFenceGpuProbe against a fake WebGL2 context.
{
  const SIGNALED = 0x9119, UNSIGNALED = 0x9118;
  let signalNext = true, deleted = 0, created = 0, lost = false;
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, SYNC_STATUS: 0x9114, SIGNALED, UNSIGNALED,
    fenceSync() { if (lost) return null; created++; return { id: created }; },
    // Like WebGL: a lost context answers null instead of a status.
    getSyncParameter() { return lost ? null : (signalNext ? SIGNALED : UNSIGNALED); },
    deleteSync() { deleted++; },
  };
  const p = createFenceGpuProbe(gl);
  check("probe: created for a WebGL2-shaped context", !!p);
  p.frameEnd();
  check("probe: first frame has no verdict", p.sample() === null);
  signalNext = false; p.frameEnd();
  check("probe: unsignalled fence a frame later → behind", p.sample() === true);
  check("probe: sample() is one-shot", p.sample() === null);
  signalNext = true; p.frameEnd();
  check("probe: signalled fence → kept up", p.sample() === false);
  check("probe: every read fence is deleted", deleted === 2, `deleted=${deleted} created=${created}`);
  lost = true; p.frameEnd(); p.frameEnd();
  check("probe: lost context → no verdict", p.sample() === null);
  check("probe: null without fenceSync (WebGL1)", createFenceGpuProbe({}) === null);
  check("probe: null without a context", createFenceGpuProbe(null) === null);
}

console.log(`\nadaptiveResGpuCheck: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
