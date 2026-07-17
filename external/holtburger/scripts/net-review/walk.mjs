// walk.mjs — the movement analogue of settle.mjs. READ THIS HEADER.
//
// WHY THIS EXISTS
// Every probe in this directory calls settleAt() and never presses a key, so the
// whole four-session perf chain has measured ONE pose: the player standing still.
// Three 1070 runs (2026-07-15), stand phase at the walk's END position:
//
//   run  WALK median   walk p99   walk worst   longTasks (walk)      STAND
//   1    40.3 fps      58.3 ms    1433 ms      —                     59.9 fps, worst 33 ms
//   2    59.5 fps      66.6 ms    1383 ms      10 = 3437 ms tot      59.9 fps, 0 long tasks
//   3    59.9 fps     166.7 ms    1150 ms      16 = 6320 ms tot      59.9 fps, 0 long tasks
//
// ⚠ THE MEDIAN IS NOT THE STORY, AND RUN 1 MISLED ME. Walking usually holds the
// 60 fps vsync cap just like standing; run 1's 40 fps median was route/density
// dependent and did NOT reproduce. THE REPRODUCIBLE SIGNAL IS THE HITCHES:
// 10-16 long tasks per 30 s walk, 3.4-6.3 s of frozen main thread (11-21% of the
// walk), worst single task 1.1-1.4 s — against EXACTLY ZERO standing. Score this
// phase on longTasks/p99/worst, never on median fps.
//
// The same runs priced the GL uploads: texSubImage3D = 190 calls / 196.5 MB while
// walking, 0 calls / 0 MB standing (static_atlas.js takes three's whole-array
// branch — it never calls addLayerUpdate; terrain_batch.js:286 does). So
// "streaming work" is not a theory; it is the only phase where most of it exists.
//
// FOUR TRAPS THIS MODULE EXISTS TO STOP YOU REPEATING
//
// 1. ABORT IF YOU DIDN'T ACTUALLY WALK. This is the movement analogue of
//    settle.mjs's abort-if-not-settled. A walk that never moved (login artifact,
//    collision, input not focused) returns beautiful frame stats for a STANDING
//    pose and reads as "walking is cheap". walkFor() throws unless it cleared
//    minDistYds. NEVER score a run that didn't move.
//
// 2. THE ONLY FAIR CONTROL IS STAND-AFTER-WALK, SAME PAGE LOAD. Comparing a walk
//    against a stand somewhere else is a VIEW confound, not a walk cost. First
//    attempt at this measured stand=24 fps vs walk=40 fps and read exactly
//    backwards — because the stand held the dense town centre and the walk left
//    it. Run phase('walk') THEN phase('stand'): the stand lands at the walk's end
//    position, same content, same session, no login gap.
//
// 3. FPS CANNOT SCORE A STEADY-FRAME WIN — STANDING IS VSYNC-CAPPED AT 60.
//    Use renderCPU. And renderCPU means ms-per-FRAME, not ms-per-render()-call:
//    renderer.render() is called ~19x per frame here (sky_dome, portal_punch,
//    portal_stencil x3, main). Averaging per call divides a real win by ~19 and
//    buries it in noise — that mistake made a freeze A/B read 1.37 vs 1.37.
//    Sum the ms across all render() calls and divide by rAF frames. Correctly
//    metered, the same scene reads ~19.5 ms/frame at 36.5 fps.
//
// 4. THE SINGLE-LOGIN SLOT. A run that reaches the world holds `tailnet1` for
//    ~90 s; the next login inside that window silently gets an EMPTY WORLD
//    (pose stays null, nothing streams) and burns the full timeout. Leave >=150 s
//    between page loads, or do all arms in ONE load (preferred — that is what
//    phase() is for). See the handoff's §8.
//
// WHAT IS AND IS NOT KNOWN (do not skip; this chain's failure mode is narrating a
// cause from a mechanism that reads well)
//   MEASURED REAL: the walk hitches (above). Zero standing, every run.
//   MEASURED DEAD — six leads, all of which read beautifully in source first:
//     - CSM shadow raster: renderer.shadowMap.enabled === false, so all 19
//       calls/frame early-return. 0.02 ms/frame, identical walk vs stand. The
//       3-cascade / 1 cm-refit-epsilon mechanism is real and costs NOTHING.
//     - Freeze staticsGroup's matrix walk (the handoff's §4f lead #1): 19.21 ms
//       vs a 19.12-19.53 baseline spread = NO WIN. updateMatrixWorld's 10.6% is
//       not the statics subtree (5,574 nodes frozen live, nothing moved).
//       NB §4f claims `rg matrixWorldAutoUpdate scene3d/` finds nothing — false:
//       cells.js:185 FREEZE_STATIC_MATRIX is default-ON and already does this.
//     - renderer.sortObjects=false: 20.42 ms = LOSES ~0.9 ms. (But note the
//       handoff's "already false in our code" is a misread of BatchedMesh's
//       per-instance flag; renderer.sortObjects is TRUE and untouched, and
//       ?particleSortObjects=off sets scene.sortObjects, which three NEVER reads
//       — a dead flag.)
//     - static-atlas full-array re-upload: 196 MB/walk is REAL but costs 128 ms
//       CPU per 25 s = 0.12 ms/frame. The driver copies and returns. Fix the
//       missing addLayerUpdate on principle; do not expect fps from it.
//     - the bake geometry path: meshToGeometryGroups 2,214 calls = 53 ms total
//       (0.04 ms/frame); _addGeometryGrow 439 calls = 4.8 ms, 0 reallocs.
//     - renderer.compile(): 259 calls / 201 ms walking vs 1 call / 0 ms standing
//       — walk-only and real, but 0.7 ms/frame, worst single call 25 ms.
//   ⭐ STILL UNEXPLAINED — THE ACTUAL OPEN QUESTION: the counters above account
//     for ~390 ms of the walk's 6,320 ms of long tasks. ~94% OF THE STALL TIME IS
//     UNATTRIBUTED, including single 1.1-1.4 s tasks. Do not guess. The next move
//     is ATTRIBUTION, not another candidate: run the CDP Profiler across the walk
//     and window it to a longtask's [startTime, +duration] to see what the stall
//     actually is. Suspects with no evidence yet: GC (the native/gc bucket goes
//     14.7% -> 18.0% when you press W), a synchronous wasm call, terrain bake.
//   CAVEAT: walk-bake-probe's lbBake counter reads 0 — bakeStaticsForLandblock is
//     referenced only in comments, so the live streaming entry is some other
//     function. Find it before trusting any per-LB envelope number.

export const WALK_DEFAULTS = {
  walkMs: 30000,
  sampleMs: 1000,
  minDistYds: 20,        // abort below this — you did not walk
  stallSegYds: 1.0,      // per-sample distance under this == stalled
  stallSamples: 3,       // consecutive stalled samples before an unstick pulse
  unstickPulseMs: 700,   // turn-right pulse to slip past geometry
  maxSegYds: 60,         // ignore landblock-rollover coordinate jumps in distance
};

/** Assert the box is the real GPU. Every probe here refuses to publish otherwise. */
export async function assertRealGpu(page) {
  const r = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return null;
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (!r || !/GTX 1070/i.test(r) || /SwiftShader|Software|llvmpipe/i.test(r)) {
    throw new Error(`REAL-GPU ASSERT FAILED — renderer=${r}. Refusing to publish.`);
  }
  return r;
}

/** Wrap renderer.render() so renderCPU is summed per FRAME (see trap 3). Idempotent. */
export async function installRenderCpuMeter(page) {
  return page.evaluate(() => {
    const s3 = window.liveScene3d;
    const r = s3?.renderer;
    if (!r) return { ok: false, reason: "no renderer on liveScene3d" };
    if (!r.__rcMeter) {
      window.__rc = { ms: 0, calls: 0, raf: 0, compileMs: 0, compileN: 0, compileMax: 0 };
      const orig = r.render.bind(r);
      r.render = function (...a) {
        const t = performance.now();
        const out = orig(...a);
        window.__rc.ms += performance.now() - t;
        window.__rc.calls++;
        return out;
      };
      // renderer.compile() traverses the WHOLE live scene synchronously and links
      // programs (three.module.js: traverseVisible + setupLights). bake_prewarm.js
      // calls it per LB bake / per entity spawn, so it is a WALK-ONLY cost that no
      // settled probe can trigger. Wrapped at runtime — it is a renderer method,
      // so this needs no source patch.
      const oc = r.compile.bind(r);
      r.compile = function (...a) {
        const t = performance.now();
        const out = oc(...a);
        const d = performance.now() - t;
        window.__rc.compileMs += d; window.__rc.compileN++;
        if (d > window.__rc.compileMax) window.__rc.compileMax = d;
        return out;
      };
      const tick = () => { window.__rc.raf++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      r.__rcMeter = true;
    }
    return { ok: true, sortObjects: r.sortObjects, shadowEnabled: r.shadowMap?.enabled };
  });
}

/**
 * Run ONE phase and return its frame stats.
 * mode: "walk" | "stand". Run walk FIRST, then stand (trap 2).
 * Throws on a walk that did not move (trap 1).
 */
export async function phase(page, mode, opts = {}) {
  const log = opts.log || (() => {});
  // NOTE: strip `log` (and anything else non-serializable) — page.evaluate args
  // must be JSON-serializable, and spreading opts straight through drags the
  // caller's log function across the boundary and throws.
  const { log: _drop, ...rest } = opts;
  const o = { ...WALK_DEFAULTS, ...rest };
  const out = await page.evaluate(async ({ mode, o }) => {
    const h = window.__sessionHandle;
    const snap = () => {
      const p = h?.getLocalPlayerPose?.();
      return p ? { lb: (p.landblockId >>> 0).toString(16), x: p.x, y: p.y, z: p.z } : null;
    };
    const key = (k, down) => document.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", {
      key: k, code: "Key" + k.toUpperCase(), bubbles: true,
    }));

    const longTasks = [];
    let po = null;
    try {
      po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)); });
      po.observe({ entryTypes: ["longtask"] });
    } catch (_) {}

    const frames = [];
    let last = performance.now(), running = true;
    const tick = (t) => { if (!running) return; frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    if (window.__rc) {
      window.__rc.ms = 0; window.__rc.calls = 0; window.__rc.raf = 0;
      window.__rc.compileMs = 0; window.__rc.compileN = 0; window.__rc.compileMax = 0;
    }

    const start = snap();
    const lbs = new Set(start ? [start.lb] : []);
    let prev = start, dist = 0, stalled = 0, unstickPulses = 0;

    if (mode === "walk") key("w", true);
    const t0 = performance.now();
    while (performance.now() - t0 < o.walkMs) {
      await new Promise((r) => setTimeout(r, o.sampleMs));
      const cur = snap();
      if (!cur || !prev) continue;
      lbs.add(cur.lb);
      const seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (seg < o.maxSegYds) dist += seg;      // skip LB-rollover coordinate jumps
      if (mode === "walk") {
        stalled = seg < o.stallSegYds ? stalled + 1 : 0;
        if (stalled >= o.stallSamples) {       // slip past geometry, keep streaming
          key("e", true);
          await new Promise((r) => setTimeout(r, o.unstickPulseMs));
          key("e", false);
          unstickPulses++; stalled = 0;
        }
      }
      prev = cur;
    }
    if (mode === "walk") key("w", false);
    running = false;
    try { po?.disconnect(); } catch (_) {}

    const secs = (performance.now() - t0) / 1000;
    const f = frames.slice(2).filter((d) => d > 0 && d < 5000).sort((a, b) => a - b);
    const q = (p) => (f.length ? f[Math.min(f.length - 1, Math.floor(f.length * p))] : 0);
    const rc = window.__rc;
    return {
      mode,
      secs: +secs.toFixed(1),
      distYds: +dist.toFixed(1),
      lbsVisited: lbs.size,
      unstickPulses,
      start, end: snap(),
      frames: f.length,
      fps_median: +(1000 / (q(0.5) || 1)).toFixed(1),
      frameMs_median: +q(0.5).toFixed(1),
      frameMs_p95: +q(0.95).toFixed(1),
      frameMs_p99: +q(0.99).toFixed(1),
      frameMs_max: +(f[f.length - 1] ?? 0).toFixed(1),
      longTasks: longTasks.length,
      longTaskMsTotal: longTasks.reduce((a, b) => a + b, 0),
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
      // renderCPU summed per FRAME, not per render() call (trap 3)
      renderCPU_ms_per_frame: rc && rc.raf ? +(rc.ms / rc.raf).toFixed(2) : null,
      renderCalls_per_frame: rc && rc.raf ? +(rc.calls / rc.raf).toFixed(1) : null,
      // renderer.compile(): whole-scene traverse + program link, per LB bake (walk-only)
      compile_calls: rc ? rc.compileN : null,
      compile_ms_total: rc ? +rc.compileMs.toFixed(0) : null,
      compile_ms_worst: rc ? +rc.compileMax.toFixed(0) : null,
      terrainBakedLbs: window.liveScene3d?.terrainBakedLbs?.size ?? null,
    };
  }, { mode, o });

  if (mode === "walk" && out.distYds < o.minDistYds) {
    throw new Error(
      `WALK ABORTED — moved only ${out.distYds} yds (< ${o.minDistYds}). ` +
      `Do NOT score this run: a walk that did not move reports a STANDING pose. ` +
      `Check the login slot (>=150 s between page loads), collision, and that the world streamed ` +
      `(terrainBakedLbs=${out.terrainBakedLbs}).`,
    );
  }
  log(`${mode.toUpperCase()}: ${out.distYds} yds across ${out.lbsVisited} LBs | ` +
      `${out.fps_median} fps median | p99 ${out.frameMs_p99} ms | worst ${out.frameMs_max} ms | ` +
      `longTasks ${out.longTasks} (${out.longTaskMsTotal} ms, max ${out.longTaskMax})` +
      (out.renderCPU_ms_per_frame != null ? ` | renderCPU ${out.renderCPU_ms_per_frame} ms/frame over ${out.renderCalls_per_frame} calls` : "") +
      (out.compile_calls ? ` | renderer.compile ${out.compile_calls}x = ${out.compile_ms_total} ms (worst ${out.compile_ms_worst} ms)` : " | renderer.compile 0x"));
  return out;
}

/** walk then stand, same page load, same area — the only fair pair (trap 2). */
export async function walkThenStand(page, opts = {}) {
  const walk = await phase(page, "walk", opts);
  const stand = await phase(page, "stand", opts);
  return { walk, stand, deltaMsPerFrame: +(walk.frameMs_median - stand.frameMs_median).toFixed(2) };
}
