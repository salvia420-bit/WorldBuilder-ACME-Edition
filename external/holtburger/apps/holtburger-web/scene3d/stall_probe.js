// ===========================================================================
// STALL PROBE — attributing the p99, not the p50
// (2026-08-06, sibling instrument to `frame_split.js`)
//
// THE NUMBER THIS EXISTS FOR. One arm on the 1070, settled Nanto,
// `?quality=ultra&clouds=on&wxMap=nasa`, Remacri textures live:
//
//     PARKED   p50 30.5 ms   mean 35.4   p95 64.8     552 draws  381 ktris
//     MOVING   p50 47.5 ms   mean 84.0   p95 78.0     847 draws  677 ktris
//                                        p99 1630 ms
//
// mean is 1.8x p50 because a handful of frames are multi-second freezes. The
// same client at `mid` parked runs 20.2 ms with p95 26.5, so this is NOT
// steady-state frame cost — it is a hitch, motion-gated and preset-gated.
//
// WHY EVERY EXISTING INSTRUMENT MISSES IT. `frame_split.js` splits the AVERAGE
// render call fourteen timestamps deep; a hitch that fires once in several
// hundred frames is a rounding error in its p50 and is not even in its p95.
// `__linkProbe.summary()` gives session TOTALS with a `worstMs` but no notion
// of which frame paid them. `__atlasStats()`, `__landblockLru.getStats()`,
// `__xu7Stats()` are all monotonic session counters. Every one of them holds a
// piece of the answer and none of them can say "these 1,630 ms, right here,
// were spent on THAT".
//
// ---------------------------------------------------------------------------
// THE METHOD: DIFFERENCE ALREADY-CUMULATIVE COUNTERS ACROSS ONE FRAME EDGE
// ---------------------------------------------------------------------------
// This probe does not time subsystems. Timing subsystems means wrapping them,
// and the work that is suspected here does not live in one place: the XUBC7
// transcode runs in a detached `.then()` continuation, the statics bake runs
// behind `setTimeout(0)` yields, the shader link runs inside three's
// `setProgram` five call frames below anything we own. Wrapping all of that is
// a week of risk for a question that can be answered by subtraction.
//
// Instead: sample a fixed vector of counters ONCE per `renderer.render` call,
// at the same point every frame, and when the interval between two samples
// exceeds a threshold, push the DELTA into a ring buffer. The ring survives the
// stall; the counters were going to be incremented anyway.
//
// This works because four of the buckets are already denominated in
// MILLISECONDS, not counts — which is the whole point, given how many times
// this investigation has been burned pricing a count:
//
//   bucket        source                              what it costs
//   ------------  ----------------------------------  ---------------------
//   linkStatusMs  __linkProbe.stats.linkStatus.ms     synchronous driver link
//   xu7DecodeMs   __xu7Stats().decodeMs               XUBC7 -> BC7 transcode
//   texAlloc/     this file's own GL wrap              texStorage/texImage +
//     texUpload/                                      texSubImage + bufferData
//     bufUpload
//   syncMs        this file's own GL wrap              readPixels/finish
//
// So a long frame does not come back as "7 decodes and 2 grows happened" — it
// comes back as "1,412 ms of LINK_STATUS, 187 ms of xu7 decode, 22 ms of
// texture upload, 9 ms unexplained". The residual is reported, always, because
// a probe that cannot be wrong is not measuring anything.
//
// ---------------------------------------------------------------------------
// THE ONE SPLIT THAT DISCRIMINATES BEFORE ANY COUNTER IS READ
// ---------------------------------------------------------------------------
// `renderer.render` is wrapped (own instance property, the `frame_split.js`
// idiom), which yields two timestamps per frame and therefore three numbers:
//
//   intervalMs  = t0(n) - t0(n-1)      the frame period
//   renderMs    = t1(n-1) - t0(n-1)    time INSIDE renderer.render
//   outsideMs   = intervalMs - renderMs
//
// That split alone separates the top two suspects without reading a single
// counter. A synchronous shader link happens inside `setProgram` inside
// `renderBufferDirect` inside `renderer.render` -> it lands in `renderMs`.
// An XUBC7 transcode happens in a promise continuation between frames, and a
// landblock bake behind `setTimeout(0)` likewise -> both land in `outsideMs`.
// `tickEviction` is called from the rAF tick AFTER `tickPerFrame` returns and
// is therefore also `outsideMs`. If a 1,630 ms frame is 1,600 ms of
// `outsideMs`, the render loop is innocent and the whole shader story is dead
// on arrival — and that is a conclusion the probe can deliver in one run.
//
// ---------------------------------------------------------------------------
// WHAT IT COSTS, PRICED RATHER THAN ASSUMED
// ---------------------------------------------------------------------------
// Per render call: 2 `performance.now()` + one `_sample()`. `_sample()` is
// ~40 property reads plus three aggregate calls (`__atlasStats()` walks ~29
// buckets, `__landblockLru.getStats()` builds one object, `__xu7Stats()`
// spreads one). Arm time measures both the `now()` unit cost and the sampler's
// own cost, and `__stallReport().probe` carries them, so the reader prices the
// instrument instead of trusting it. Measured shape to expect: sampler p50 in
// the tens of microseconds against a 30-47 ms frame, i.e. ~0.1%.
//
// The GL wrap adds 2 `now()` to each texture/buffer upload and each sync point.
// Those are tens of calls per frame, not thousands (three uploads a texture
// once, then leaves it alone) — but the call COUNTS are reported so the reader
// can price the wrap at `calls * 2 * nowCostNs` rather than take a promise.
// `?statBatchMemo` era lesson: never quote a bucket without its population.
//
// ---------------------------------------------------------------------------
// NO URL FLAG
// ---------------------------------------------------------------------------
// Same contract as `frame_split.js` and `__statMergeProjection`: the module
// costs one parse and zero frame time until something arms it, so it carries no
// flag and needs no docs row. Invoke from the console:
//
//     window.__stallArm()                 // defaults: threshold 100 ms, ring 64
//     ... move for 60 s ...
//     window.__stallReport()              // ranked attribution
//     JSON.stringify(window.__stallSamples())   // the raw long frames
//
// LIMITS, stated so nobody quotes past them:
//   * Attribution is by SUBTRACTION over a window, not by a call stack. If two
//     subsystems overlap in one interval the probe reports both totals and
//     cannot say which one blocked first.
//   * `renderMs` brackets the render CALL, which returns before the GPU is
//     done. A driver stall that shows up as backpressure in the NEXT
//     `render`/`swap` is charged to the next frame. That is the same limit
//     every CPU-side WebGL timer has.
//   * wasm linear-memory growth is NOT sampled — `__hbWasmNs` is module-scoped
//     inside index.html and never published on `window`. A `memory.grow` copies
//     the whole linear memory and would land in `outsideMs` unattributed, i.e.
//     inside `residualMs`. If the residual is large and nothing else moves,
//     that is the next thing to expose.
//   * `performance.memory` is Chrome-only and non-standard. A DROP in
//     `jsHeapMB` across a long frame is GC evidence, not GC proof.
// ===========================================================================

import { installLinkProbe } from "./shader_prewarm.js";

const _now =
  typeof globalThis !== "undefined" && globalThis.performance && typeof globalThis.performance.now === "function"
    ? () => globalThis.performance.now()
    : () => Date.now();

// Ring cap default. 64 long frames is far more than any single walk produces
// and small enough that the probe can never be the memory story.
const _RING_DEFAULT = 64;
// Default long-frame threshold. p95 MOVING at ultra is 78 ms, so 100 ms is
// above the honest steady-state ceiling and well below the 1,630 ms target —
// it catches the hitch class without drowning the ring in ordinary frames.
const _THRESHOLD_DEFAULT_MS = 100;
// PerformanceObserver longtask entries are kept only long enough to be matched
// against a long frame; anything older than the ring's oldest window is dead.
const _LONGTASK_CAP = 256;

const S = {
  armed: false,
  renderer: null,
  gl: null,
  origRender: null,
  hadOwnRender: false,
  thresholdMs: _THRESHOLD_DEFAULT_MS,
  ringCap: _RING_DEFAULT,
  ring: [],
  ringSeq: 0,
  frames: 0,
  // Every interval, so the report can quote p50/p95/p99 from the SAME clock
  // that produced the ring rather than asking the reader to cross-reference
  // a different harness's percentiles.
  intervals: [],
  intervalsCap: 20000,
  prev: null,
  // Self-cost bookkeeping.
  nowCostNs: 0,
  sampleCostMs: [],
  // GL wrap.
  glOrig: null,
  glCounters: null,
  // longtask observer
  ltObserver: null,
  longTasks: [],
};

// ---------------------------------------------------------------------------
// GL wrap — the only bucket this file MEASURES rather than reads
// ---------------------------------------------------------------------------
// Split four ways because the four have different fixes. `texAlloc` is
// storage (re)allocation, which is what an atlas grow does and what a context
// restore does en masse. `texUpload` is sub-image traffic. `bufUpload` is
// geometry, which is what a cold landblock re-bake does. `sync` is the
// pipeline-flushing family, which is invisible in every other instrument and
// is the classic hidden multi-hundred-ms stall.
const _GL_GROUPS = {
  texAlloc: ["texImage2D", "texImage3D", "texStorage2D", "texStorage3D", "compressedTexImage2D", "compressedTexImage3D", "renderbufferStorage", "renderbufferStorageMultisample"],
  texUpload: ["texSubImage2D", "texSubImage3D", "compressedTexSubImage2D", "compressedTexSubImage3D"],
  bufUpload: ["bufferData", "bufferSubData"],
  sync: ["readPixels", "finish", "getBufferSubData", "clientWaitSync"],
};

/** Sum the byteLength of any ArrayBufferView / ArrayBuffer in the argument
 *  list. `texImage2D(…, null)` and the HTMLImageElement overloads simply
 *  contribute 0 — an undercount we would rather have than a guess. */
function _argBytes(args) {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && typeof a === "object" && typeof a.byteLength === "number") n += a.byteLength;
  }
  return n;
}

function _wrapGl(gl) {
  const counters = {};
  const orig = [];
  for (const group of Object.keys(_GL_GROUPS)) {
    counters[group] = { calls: 0, ms: 0, bytes: 0 };
    for (const name of _GL_GROUPS[group]) {
      const fn = gl[name];
      if (typeof fn !== "function") continue; // WebGL1 context, or a mock
      const c = counters[group];
      const wrapper = function (...args) {
        const a = _now();
        try {
          return fn.apply(this, args);
        } finally {
          c.ms += _now() - a;
          c.calls += 1;
          c.bytes += _argBytes(args);
        }
      };
      wrapper.__stallProbeWrapped = true;
      orig.push([name, fn, Object.prototype.hasOwnProperty.call(gl, name)]);
      gl[name] = wrapper;
    }
  }
  return { counters, orig };
}

function _unwrapGl(gl, saved) {
  if (!gl || !saved) return;
  for (const [name, fn, wasOwn] of saved.orig) {
    // Only restore what is still OURS. If the app re-assigned the slot after
    // we wrapped it, clobbering that with the pre-arm function would be a
    // real behaviour change shipped by a diagnostic.
    if (gl[name] && gl[name].__stallProbeWrapped !== true) continue;
    if (wasOwn) gl[name] = fn;
    else delete gl[name];
  }
}

// ---------------------------------------------------------------------------
// The counter vector
// ---------------------------------------------------------------------------

function _num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Read every cumulative counter this probe knows about. EVERY read is
 * individually guarded: a diag surface that is not installed yet (the LRU is
 * published ~35 s after in-world; `__linkProbe` only exists once armed) must
 * degrade to a zero, never to a throw inside `renderer.render`.
 */
function _sample(renderer) {
  const s = {
    // --- renderer.info: levels and cumulative draw counts -------------------
    programs: 0, geometries: 0, textures: 0, calls: 0, triangles: 0,
    // --- XUBC7 transcode: MS, on the main thread (see xu7_textures.js) -----
    // `xu7Drains`/`xu7Deferrals` (2026-08-08) are COUNTS and stay out of
    // `_MS_KEYS`: they say how the transcode ms was SHAPED across this window,
    // not how much of it there was. A long frame carrying 187 ms of
    // `xu7DecodeMs` with `xu7Drains: 1` is the pre-fix pile-up; the same ms
    // spread over one drain per frame is the budgeted path working. A nonzero
    // `xu7Deferrals` means the cap actually bit in this window.
    xu7Decodes: 0, xu7DecodeMs: 0, xu7Skips: 0, xu7Errors: 0,
    // `xu7Runs` is the one that reads on BOTH arms: a long frame carrying
    // `xu7Decodes: 12, xu7Runs: 1` is twelve decodes with no yield between
    // them. `__xu7Stats().maxRun` is its session-wide high-water mark.
    xu7Drains: 0, xu7Deferrals: 0, xu7Runs: 0,
    // --- BC7 record source: counts only ------------------------------------
    bc7Fetches: 0, bc7Hits: 0, bc7PreFetches: 0, bc7Absent: 0, bc7Bytes: 0,
    // --- shader link: MS (requires the link probe, which arm() installs) ----
    linkPrograms: 0, linkStatusCalls: 0, linkStatusMs: 0, linkStalls: 0,
    linkWorstMs: 0, completionCalls: 0, completionMs: 0,
    // --- GL traffic: MS + bytes, measured here ------------------------------
    texAllocCalls: 0, texAllocMs: 0, texAllocBytes: 0,
    texUploadCalls: 0, texUploadMs: 0, texUploadBytes: 0,
    bufUploadCalls: 0, bufUploadMs: 0, bufUploadBytes: 0,
    syncCalls: 0, syncMs: 0,
    // --- statics atlas ------------------------------------------------------
    atlasGrows: 0, atlasGrowUploads: 0, atlasGrowFails: 0,
    atlasLiveLayers: 0, atlasAllocLayers: 0,
    // --- landblock residency ------------------------------------------------
    lruResident: 0, lruEvicted: 0, lruParked: 0, lruParkedTotal: 0,
    lruUnparked: 0, lruLiveGeom: 0, lruGeomPressureEngagements: 0,
    lruGeomPressureActive: 0, lruCenterJumps: 0,
    // --- context loss (a 16-entry ring; we only need its length) ------------
    ctxEvents: 0,
    // --- memory (Chrome-only, non-standard) ---------------------------------
    jsHeapMB: 0,
  };
  try {
    const info = renderer && renderer.info;
    if (info) {
      s.programs = _num(info.programs && info.programs.length);
      s.geometries = _num(info.memory && info.memory.geometries);
      s.textures = _num(info.memory && info.memory.textures);
      // NOTE renderer.info.autoReset defaults TRUE, so render.calls/triangles
      // are PER-FRAME here unless something turned it off. They are carried as
      // absolute levels (`at`), never differenced — a delta of a per-frame
      // counter is meaningless and this investigation has already paid for
      // that mistake once.
      s.calls = _num(info.render && info.render.calls);
      s.triangles = _num(info.render && info.render.triangles);
    }
  } catch (_) {}
  try {
    const x = typeof window !== "undefined" && typeof window.__xu7Stats === "function" ? window.__xu7Stats() : null;
    if (x) {
      s.xu7Decodes = _num(x.decodes);
      s.xu7DecodeMs = _num(x.decodeMs);
      s.xu7Skips = _num(x.notReadySkips);
      s.xu7Errors = _num(x.decodeErrors);
      s.xu7Drains = _num(x.drains);
      s.xu7Deferrals = _num(x.deferrals);
      s.xu7Runs = _num(x.runs);
    }
  } catch (_) {}
  try {
    const b = typeof window !== "undefined" && typeof window.__bc7Stats === "function" ? window.__bc7Stats() : null;
    if (b) {
      s.bc7Fetches = _num(b.fetches);
      s.bc7Hits = _num(b.hits);
      s.bc7PreFetches = _num(b.preFetches);
      s.bc7Absent = _num(b.absent);
      s.bc7Bytes = _num(b.bytesFetched);
    }
  } catch (_) {}
  try {
    const lp = typeof window !== "undefined" && window.__linkProbe ? window.__linkProbe.stats : null;
    if (lp) {
      s.linkPrograms = _num(lp.linkProgramCalls);
      s.linkStatusCalls = _num(lp.linkStatus && lp.linkStatus.calls);
      s.linkStatusMs = _num(lp.linkStatus && lp.linkStatus.ms);
      s.linkStalls = _num(lp.linkStatus && lp.linkStatus.stallCalls);
      s.linkWorstMs = _num(lp.linkStatus && lp.linkStatus.worstMs);
      s.completionCalls = _num(lp.completion && lp.completion.calls);
      s.completionMs = _num(lp.completion && lp.completion.ms);
    }
  } catch (_) {}
  try {
    const g = S.glCounters;
    if (g) {
      s.texAllocCalls = g.texAlloc.calls; s.texAllocMs = g.texAlloc.ms; s.texAllocBytes = g.texAlloc.bytes;
      s.texUploadCalls = g.texUpload.calls; s.texUploadMs = g.texUpload.ms; s.texUploadBytes = g.texUpload.bytes;
      s.bufUploadCalls = g.bufUpload.calls; s.bufUploadMs = g.bufUpload.ms; s.bufUploadBytes = g.bufUpload.bytes;
      s.syncCalls = g.sync.calls; s.syncMs = g.sync.ms;
    }
  } catch (_) {}
  try {
    const a = typeof window !== "undefined" && typeof window.__atlasStats === "function" ? window.__atlasStats() : null;
    if (a) {
      s.atlasGrows = _num(a.layerGrows);
      s.atlasGrowUploads = _num(a.layerGrowUploads);
      s.atlasGrowFails = _num(a.layerGrowFails);
      s.atlasLiveLayers = _num(a.liveLayers);
      s.atlasAllocLayers = _num(a.allocLayers);
    }
  } catch (_) {}
  try {
    const lru = typeof window !== "undefined" ? window.__landblockLru : null;
    const st = lru && typeof lru.getStats === "function" ? lru.getStats() : null;
    if (st) {
      s.lruResident = _num(st.resident);
      s.lruEvicted = _num(st.evicted);
      s.lruParked = _num(st.parked);
      s.lruParkedTotal = _num(st.parkedTotal);
      s.lruUnparked = _num(st.unparkedTotal);
      s.lruLiveGeom = _num(st.liveGeom);
      s.lruGeomPressureEngagements = _num(st.geomPressureEngagements);
      s.lruGeomPressureActive = st.geomPressureActive ? 1 : 0;
      s.lruCenterJumps = _num(st.centerJumps);
    }
  } catch (_) {}
  try {
    const h =
      typeof window !== "undefined" && typeof window.__webglContextRecoveryHistory === "function"
        ? window.__webglContextRecoveryHistory()
        : null;
    if (h && typeof h.length === "number") s.ctxEvents = h.length;
  } catch (_) {}
  try {
    const m = typeof performance !== "undefined" ? performance.memory : null;
    if (m && typeof m.usedJSHeapSize === "number") s.jsHeapMB = m.usedJSHeapSize / 1048576;
  } catch (_) {}
  return s;
}

// Fields that are LEVELS, not accumulators. Differencing them is either
// meaningless (per-frame draw counts, whose autoReset zeroes them) or
// misleading (resident count). They are reported as absolutes under `at`.
const _LEVEL_KEYS = new Set([
  "programs", "geometries", "textures", "calls", "triangles",
  "atlasLiveLayers", "atlasAllocLayers",
  "lruResident", "lruParked", "lruLiveGeom", "lruGeomPressureActive",
  "linkWorstMs", "jsHeapMB", "ctxEvents",
]);

// The ms-denominated buckets, in the order the report ranks them. These are the
// only fields allowed into `explainedMs` — everything else is a count and this
// investigation has already produced six 2x+ overestimates by pricing counts.
const _MS_KEYS = ["linkStatusMs", "xu7DecodeMs", "texAllocMs", "texUploadMs", "bufUploadMs", "syncMs", "completionMs"];

function _delta(cur, prev) {
  const d = {};
  for (const k of Object.keys(cur)) {
    if (_LEVEL_KEYS.has(k)) continue;
    const v = cur[k] - prev[k];
    if (v !== 0) d[k] = v;
  }
  return d;
}

function _levels(cur, prev) {
  const at = {};
  for (const k of _LEVEL_KEYS) {
    at[k] = cur[k];
    // programs/geometries/textures/jsHeap are worth their trend too: a heap
    // DROP across a long frame is the only GC evidence available to us.
    if (k === "programs" || k === "geometries" || k === "textures" || k === "jsHeapMB" || k === "ctxEvents") {
      const dv = cur[k] - prev[k];
      if (dv !== 0) at[`${k}Δ`] = k === "jsHeapMB" ? Number(dv.toFixed(2)) : dv;
    }
  }
  return at;
}

// ---------------------------------------------------------------------------
// arm / disarm
// ---------------------------------------------------------------------------

function _resolveRenderer(explicit) {
  if (explicit) return explicit;
  try {
    // `window.liveScene3d` is a one-time init3D SNAPSHOT, not a live facade
    // ref — but `renderer` is stamped into it at construction, so this
    // particular read is safe. Anything stamped LATE would read null forever.
    return (typeof window !== "undefined" && window.liveScene3d && window.liveScene3d.renderer) || null;
  } catch (_) {
    return null;
  }
}

function _measureNowCostNs() {
  const N = 20000;
  for (let i = 0; i < 2000; i++) _now();
  const a = _now();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += _now();
  const b = _now();
  return sink === Infinity ? 0 : ((b - a) * 1e6) / N;
}

/**
 * Arm the probe.
 *
 * @param {object} [opts]
 * @param {any}    [opts.renderer]     THREE.WebGLRenderer; defaults to
 *                                     `window.liveScene3d.renderer`.
 * @param {number} [opts.thresholdMs]  ring an interval at or above this (100).
 * @param {number} [opts.ring]         ring capacity in long frames (64).
 * @param {boolean}[opts.gl]           wrap the GL upload/sync family (true).
 * @param {boolean}[opts.link]         force-install the link probe (true).
 *                                     `?linkProbe=on` is NOT required — this
 *                                     passes `{force:true}` — but the LINK_STATUS
 *                                     bucket is empty without it, and that is
 *                                     the bucket the 07-16 walk-stall profile
 *                                     says carries the stall.
 * @param {boolean}[opts.longtask]     observe PerformanceObserver longtasks (true).
 */
export function armStallProbe(opts = {}) {
  if (S.armed) return { error: "already armed — __stallDisarm() first" };
  const renderer = _resolveRenderer(opts.renderer);
  if (!renderer || typeof renderer.render !== "function") {
    return { error: "no renderer (window.liveScene3d.renderer is null — is the scene up?)" };
  }
  S.renderer = renderer;
  S.thresholdMs = typeof opts.thresholdMs === "number" ? opts.thresholdMs : _THRESHOLD_DEFAULT_MS;
  S.ringCap = typeof opts.ring === "number" ? Math.max(1, opts.ring | 0) : _RING_DEFAULT;
  S.ring = [];
  S.ringSeq = 0;
  S.frames = 0;
  S.intervals = [];
  S.prev = null;
  S.sampleCostMs = [];
  S.longTasks = [];
  S.nowCostNs = _measureNowCostNs();

  // Link probe. Independent module, independent flag — but the whole reason to
  // arm THIS probe is to price the link bucket in ms, so force it on unless
  // the caller says otherwise.
  if (opts.link !== false) {
    try {
      installLinkProbe(renderer, { force: true });
    } catch (_) {}
  }

  // GL wrap.
  if (opts.gl !== false) {
    try {
      const gl = typeof renderer.getContext === "function" ? renderer.getContext() : null;
      if (gl) {
        S.gl = gl;
        S.glOrig = _wrapGl(gl);
        S.glCounters = S.glOrig.counters;
      }
    } catch (_) {
      S.gl = null;
      S.glOrig = null;
      S.glCounters = null;
    }
  }

  // Longtask observer. Catches a stall that happens entirely BETWEEN render
  // calls — which is exactly the shape an XUBC7 transcode burst or a bake
  // continuation has. `attribution` is usually empty in Chrome for same-origin
  // script, so the value here is the {startTime, duration} pair, not the name.
  if (opts.longtask !== false && typeof PerformanceObserver === "function") {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          S.longTasks.push({ startTime: e.startTime, duration: e.duration, name: e.name });
        }
        if (S.longTasks.length > _LONGTASK_CAP) S.longTasks.splice(0, S.longTasks.length - _LONGTASK_CAP);
      });
      obs.observe({ type: "longtask", buffered: false });
      S.ltObserver = obs;
    } catch (_) {
      S.ltObserver = null;
    }
  }

  // Wrap `renderer.render` as an OWN instance property over whatever the slot
  // resolves to today (prototype method, or another probe's wrapper — nesting
  // is fine, `frame_split.js` may be armed at the same time; disarm in reverse
  // arm order).
  S.hadOwnRender = Object.prototype.hasOwnProperty.call(renderer, "render");
  S.origRender = renderer.render;
  const orig = S.origRender;
  const wrapper = function (...args) {
    const t0 = _now();
    // Sample BEFORE the render so the window [prev.t0, t0] is closed by
    // counters read at the same phase every frame.
    const sc0 = _now();
    const cur = _sample(this);
    const sampleMs = _now() - sc0;
    const prev = S.prev;
    if (prev) {
      _closeFrame(prev, t0, cur);
      if (S.sampleCostMs.length < 20000) S.sampleCostMs.push(sampleMs);
    }
    S.prev = { t0, t1: t0, sample: cur };
    try {
      return orig.apply(this, args);
    } finally {
      S.prev.t1 = _now();
    }
  };
  wrapper.__stallProbeWrapped = true;
  renderer.render = wrapper;
  S.armed = true;
  return {
    armed: true,
    thresholdMs: S.thresholdMs,
    ring: S.ringCap,
    glWrapped: !!S.glCounters,
    linkWrapped: typeof window !== "undefined" && !!window.__linkProbe,
    longtaskObserver: !!S.ltObserver,
    nowCostNs: Number(S.nowCostNs.toFixed(1)),
    note: "move for >=60 s, then __stallReport()",
  };
}

function _closeFrame(prev, t0, cur) {
  const intervalMs = t0 - prev.t0;
  S.frames += 1;
  if (S.intervals.length < S.intervalsCap) S.intervals.push(intervalMs);
  if (intervalMs < S.thresholdMs) return;
  const renderMs = prev.t1 - prev.t0;
  const rec = {
    seq: S.ringSeq++,
    tStartMs: Number(prev.t0.toFixed(1)),
    intervalMs: Number(intervalMs.toFixed(1)),
    // THE discriminator: inside renderer.render vs everything else.
    renderMs: Number(renderMs.toFixed(1)),
    outsideMs: Number((intervalMs - renderMs).toFixed(1)),
    d: _delta(cur, prev.sample),
    at: _levels(cur, prev.sample),
    longTasks: S.longTasks
      .filter((e) => e.startTime + e.duration >= prev.t0 && e.startTime <= t0)
      .map((e) => ({ startMs: Number(e.startTime.toFixed(1)), durMs: Number(e.duration.toFixed(1)) })),
  };
  // Rank the ms buckets for this one frame and state the residual, so a single
  // ring entry is readable without running the aggregate report.
  let explained = 0;
  const by = [];
  for (const k of _MS_KEYS) {
    const v = rec.d[k];
    if (typeof v === "number" && v > 0.05) {
      explained += v;
      by.push([k, Number(v.toFixed(1))]);
    }
  }
  by.sort((a, b) => b[1] - a[1]);
  rec.explainedMs = Number(explained.toFixed(1));
  rec.residualMs = Number((intervalMs - explained).toFixed(1));
  rec.by = by;
  S.ring.push(rec);
  if (S.ring.length > S.ringCap) S.ring.shift();
}

/** Restore every slot this probe took. Safe to call unarmed. */
export function disarmStallProbe() {
  if (!S.armed) return { armed: false };
  try {
    const r = S.renderer;
    if (r && r.render && r.render.__stallProbeWrapped === true) {
      if (S.hadOwnRender) r.render = S.origRender;
      else delete r.render;
    }
  } catch (_) {}
  try {
    _unwrapGl(S.gl, S.glOrig);
  } catch (_) {}
  try {
    if (S.ltObserver) S.ltObserver.disconnect();
  } catch (_) {}
  S.ltObserver = null;
  S.glOrig = null;
  S.gl = null;
  S.origRender = null;
  S.renderer = null;
  S.armed = false;
  // The ring is deliberately KEPT: disarming to stop the overhead must not
  // throw away the evidence the run was for. `__stallReset()` clears it.
  return { armed: false, ringHeld: S.ring.length };
}

/** Clear the ring and every accumulator; stay armed if armed. */
export function resetStallProbe() {
  S.ring = [];
  S.ringSeq = 0;
  S.frames = 0;
  S.intervals = [];
  S.sampleCostMs = [];
  S.longTasks = [];
  S.prev = null;
  if (S.glCounters) {
    for (const g of Object.keys(S.glCounters)) {
      S.glCounters[g].calls = 0;
      S.glCounters[g].ms = 0;
      S.glCounters[g].bytes = 0;
    }
  }
  try {
    if (typeof window !== "undefined" && window.__linkProbe && typeof window.__linkProbe.reset === "function") {
      window.__linkProbe.reset();
    }
  } catch (_) {}
  return { reset: true, armed: S.armed };
}

function _pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * The report. Percentiles come from the SAME clock that filled the ring, so
 * "p99 1630 ms" and "the ring's worst entry" are the same frame by
 * construction rather than by cross-referencing two harnesses.
 */
export function stallReport() {
  const iv = S.intervals.slice().sort((a, b) => a - b);
  const sc = S.sampleCostMs.slice().sort((a, b) => a - b);
  const long = S.ring;
  // Aggregate the ms buckets across every ringed frame.
  const agg = {};
  let longTotal = 0;
  let longRender = 0;
  let longOutside = 0;
  for (const r of long) {
    longTotal += r.intervalMs;
    longRender += r.renderMs;
    longOutside += r.outsideMs;
    for (const [k, v] of r.by) agg[k] = (agg[k] || 0) + v;
  }
  const ranked = Object.entries(agg)
    .map(([k, v]) => [k, Number(v.toFixed(1)), longTotal > 0 ? Number(((v / longTotal) * 100).toFixed(1)) : 0])
    .sort((a, b) => b[1] - a[1]);
  const explained = ranked.reduce((a, b) => a + b[1], 0);
  const probeMs = sc.reduce((a, b) => a + b, 0);
  return {
    armed: S.armed,
    thresholdMs: S.thresholdMs,
    frames: S.frames,
    intervalMs: {
      p50: Number(_pct(iv, 50).toFixed(2)),
      p95: Number(_pct(iv, 95).toFixed(2)),
      p99: Number(_pct(iv, 99).toFixed(2)),
      max: Number((iv.length ? iv[iv.length - 1] : 0).toFixed(1)),
      mean: Number((iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : 0).toFixed(2)),
    },
    long: {
      count: long.length,
      ringCap: S.ringCap,
      dropped: Math.max(0, S.ringSeq - long.length),
      totalMs: Number(longTotal.toFixed(1)),
      // The split that decides the investigation before any bucket is read.
      insideRenderMs: Number(longRender.toFixed(1)),
      outsideRenderMs: Number(longOutside.toFixed(1)),
      worstMs: long.length ? Math.max(...long.map((r) => r.intervalMs)) : 0,
    },
    // [bucket, ms, % of all long-frame time]. Only ms-denominated buckets are
    // here; counts live in the per-frame `d` and are NOT priced.
    rankedMs: ranked,
    explainedMs: Number(explained.toFixed(1)),
    residualMs: Number((longTotal - explained).toFixed(1)),
    probe: {
      nowCostNs: Number(S.nowCostNs.toFixed(1)),
      sampleMs: { p50: Number(_pct(sc, 50).toFixed(4)), max: Number((sc.length ? sc[sc.length - 1] : 0).toFixed(3)) },
      totalSampleMs: Number(probeMs.toFixed(1)),
      // Price the GL wrap honestly: calls x 2 x now(). If this is a meaningful
      // share of any bucket above, say so out loud rather than quoting the
      // bucket.
      glCalls: S.glCounters
        ? Object.fromEntries(Object.entries(S.glCounters).map(([k, v]) => [k, v.calls]))
        : null,
      glWrapOverheadMs: S.glCounters
        ? Number(
            (
              (Object.values(S.glCounters).reduce((a, v) => a + v.calls, 0) * 2 * S.nowCostNs) /
              1e6
            ).toFixed(2),
          )
        : 0,
      linkProbe: typeof window !== "undefined" && window.__linkProbe ? "installed" : "ABSENT — linkStatusMs will read 0",
      longtaskObserver: !!S.ltObserver,
    },
    ring: long,
  };
}

/** The raw ring, for `JSON.stringify` into a file. */
export function stallSamples() {
  return S.ring.slice();
}

/** Test-only: drive one synthetic frame edge without a renderer. */
export function _stallProbeStateForTest() {
  return S;
}

// ---------------------------------------------------------------------------
// Window surface. No URL flag: zero frame time until armed, the shape
// `frame_split.js` and `window.__statMergeProjection` established.
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  const guard = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  window.__stallArm = guard(armStallProbe);
  window.__stallDisarm = guard(disarmStallProbe);
  window.__stallReset = guard(resetStallProbe);
  window.__stallReport = guard(stallReport);
  window.__stallSamples = guard(stallSamples);
}
