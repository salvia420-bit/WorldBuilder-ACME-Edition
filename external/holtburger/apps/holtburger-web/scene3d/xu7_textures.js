// scene3d/xu7_textures.js — P2: XUBC7 (supercompressed BC7) payload decode.
//
// Wire tier: `holtburger/tex-xu7` ships basisu KTX2 containers (unregistered
// scheme-6 supercompression — opaque to everything but the transcoder wasm).
// Measured on our art: lossless 59% of raw BC7+mips (vs zstd's 75%), q75 38%,
// rdo-1.5bpp 22.5%. On-GPU bytes are IDENTICAL to the hbc7 path — the
// transcoder emits the same BC7 blocks, which flow through the same
// makeBc7Texture / atlas upload paths.
//
// FLAG: DEFAULT-ON since 2026-08-05 (owner redmi eye-pass on the 1070
// hi-res capture set); `?texXu7=off` is the EXACT-MATCH escape. The encode
// is ±0.9 dB vs bc7enc_rdo, so this was an eye call, not a correctness
// call. When on, the record source tries the xu7 namespace FIRST and falls
// back to `tex-bc7` on any miss/failure, so a dist without xu7 records
// behaves exactly as before.
//
// TRANSCODER: scene3d/transcoder/basis_transcoder.{js,wasm} (1.04 MB wasm,
// vendored from binomialLLC/basis_universal 9bebe167 / v2.50.0). The glue is
// an emscripten UMD script, not an ES module, so it is fetched and evaluated
// via `new Function` — works in both window and worker scopes (each context
// instantiates its OWN copy; remember the bake-worker-owns-its-wasm trap).
// Loaded LAZILY on the first xu7 decode, so flag-off boots pay zero bytes.
//
// Decode cost: ~32 ms per 1024² single-threaded. Payloads are encoded with
// stripes=8; per-record decode runs on the calling thread.
//
// TOMBSTONE (2026-08-06, p99-stall investigation). This paragraph used to end
// "— the bake worker absorbs atlas feeds, singletons hitch at most once per
// surface." That was WRONG on both halves and it was load-bearing wrong,
// because it read as "the main thread does not pay for this".
//
//   * The bake worker absorbs NOTHING of this. `scene3d/bake_worker.js`'s
//     complete import graph is pkg/holtburger_web.js, tex_overrides.js,
//     gfx_relief.js -> quality.js, and bake_transfer.js. There is no bc7/xu7
//     symbol anywhere in it; it produces RGBA8 SurfacePixels and stops.
//     `transcodeXu7` has exactly ONE caller in the tree — `Bc7RecordSource._begin`
//     in bc7_textures.js — and that source is constructed once, on the main
//     thread, from index.html's boot arm, against the MAIN-thread wasm
//     namespace. Every XUBC7 transcode this client has ever run was on the
//     window thread.
//   * "hitch at most once per surface" is true per surface and irrelevant per
//     FRAME. The wasm `xu7_blocks` is an `async fn`, but after its `prefetch`
//     the bytes come from the in-memory source, so N sibling `getAsync` calls
//     from one landblock's material set settle in the SAME microtask drain and
//     their N transcodes run back-to-back in ONE task, with no yield and no
//     budget between them. The per-surface cost is bounded; the per-task cost
//     is bounded only by how many surfaces a landblock crossing asks for at once.
//
// The transcode is therefore unbudgeted main-thread work that lands between
// render calls. `_stats.decodeMs` below is the honest total; `scene3d/stall_probe.js`
// differences it across a frame edge to say how much of it landed in one hitch.
// If this ever needs fixing, the two candidate shapes are (a) move the decode
// into the bake worker for real, or (b) budget it — a small FIFO drained under
// a per-frame ms cap, the shape `statics.js STATICS_BUILD_BUDGET_MS` already uses.
//
// FIX, 2026-08-08 — shape (b) is implemented below (`?xu7Budget`, DEFAULT ON,
// `=off` restores the straight-through call). See the note on `_drain` for why
// (b) is the one that addresses the hitch.
//
// ST4, 2026-08-08 (SPEC §3 T14) — shape (a) NOW EXISTS as the DEDICATED
// texture worker (`?texWorkers`, DEFAULT OFF while DEV; scene3d/
// texture_worker.js + the client at the bottom of this file), built on top of
// (b) exactly as the prerequisite note below requires: when the flag is ON and
// the worker is up, transcodes run in the worker on its own transcoder
// instance and this file's budgeted FIFO is the RETAINED-VERBATIM fallback arm
// (worker off/loading/crashed — every fallback engagement is counted on
// `__texWorkerStats`, never silent). Flag OFF = every line of the (b) path,
// byte-identical.
//
// WHAT (b) DOES AND DOES NOT CLAIM. It does not make a transcode cheaper: one
// 1024² is still ~32 ms of main-thread work and one record still cannot be
// split. What it removes is the PILE-UP — the N-surfaces-in-one-task shape the
// tombstone identifies as the actual hitch — by draining the FIFO under a
// per-frame ms cap, so N records cost N short tasks across N frames instead of
// one 32N ms task. That is a p99/task-length change, and the honest instrument
// for it is `__xu7Stats().maxBatch` / `maxDrainMs` (task-length shape), NOT
// `decodeMs` (unchanged by construction — it is the same total work).

import { bc7BlocksFor, bc7LevelBytes, flagIsOff } from "./bc7_textures.js";
// ST8 stage A (?frameWork, SPEC §3 T21) — W6 sync-drain adapter for the
// budgeted FIFO below. Returns false when the flag is OFF (this file keeps
// its rAF + hidden-tab-guard scheduling, byte-identical).
import { frameWorkW6Run } from "./frame_work.js";

let _flag;
/**
 * DEFAULT-ON (2026-08-05 1070 sign-off). Escape: `off`/`0`/`false`/`no`.
 *
 * This read `!== "off"` until 2026-08-05, which meant `?texXu7=0`, `=false` and
 * `=no` all silently read ON while the identical spelling disabled texBc7,
 * texPre and terrainBc7. Now on the shared `flagIsOff` predicate with its three
 * siblings.
 */
export function texXu7Enabled(search) {
  if (search === undefined && _flag !== undefined) return _flag;
  let on = true;
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" ? window.location.search : "";
    on = !flagIsOff(new URLSearchParams(s).get("texXu7"));
  } catch (_) {
    on = true;
  }
  if (search === undefined) _flag = on;
  return on;
}

/**
 * `?xu7Budget` — DEFAULT ON (2026-08-08). `=off`/`0`/`false`/`no` restores the
 * pre-fix straight-through call, where every queued transcode ran back-to-back
 * in whichever task the record fetches happened to settle in.
 *
 * On the shared `flagIsOff` predicate from the first line, because the polarity
 * divergence this family already paid for once (`texXu7` read `!== "off"` for a
 * day) is exactly the bug a hand-rolled reader reintroduces.
 *
 * Not memoized: the ESM suites re-stub `globalThis.window` per case, and a
 * memo would latch the first case's answer for the whole file.
 */
export function xu7BudgetEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    return !flagIsOff(new URLSearchParams(s).get("xu7Budget"));
  } catch (_) {
    return true;
  }
}

// Per-frame cap, in ms. 6 is the house figure (`statics.js
// STATICS_BUILD_BUDGET_MS`, `cells.js ENVCELL_BUILD_BUDGET_MS`,
// `landblock_lru.js SEALED_STEADY_BUDGET_MS` are all 6).
//
// A single 1024² decode is ~32 ms, i.e. 5x this cap, so for the big records the
// cap does NOT subdivide anything — the drain runs one and stops, which is the
// point: the cap is what bounds the BATCH, not the item. Small records (the
// long tail: 128²/64² surfaces at well under a millisecond) do pack several to
// a drain, which is why a fixed items-per-frame limit would have been the wrong
// instrument.
const XU7_BUDGET_MS_DEFAULT = 6;
// `?xu7BudgetMs=N` overrides it. Clamped to [0.5, 1000]: 0 would mean "one item
// per frame forever" by way of the always-run-one rule below, which is a
// legitimate arm but should be spelled `=0.5`, not fall out of a typo.
function _budgetMs(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const raw = new URLSearchParams(s).get("xu7BudgetMs");
    if (raw === null) return XU7_BUDGET_MS_DEFAULT;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return XU7_BUDGET_MS_DEFAULT;
    return Math.min(1000, Math.max(0.5, n));
  } catch (_) {
    return XU7_BUDGET_MS_DEFAULT;
  }
}

const _stats = {
  transcoderLoads: 0,
  transcoderFailed: null,
  decodes: 0,
  decodeErrors: 0,
  decodeMs: 0,
  lastError: null,
  // Records that took the hbc7 route because the transcoder was not up yet.
  // Expected to be non-zero on every cold boot and to stop climbing once the
  // module lands; a count that keeps rising means the load never finished.
  notReadySkips: 0,

  // --- budgeted-FIFO shape (2026-08-08) ------------------------------------
  // These are the fields that can say whether the pile-up is gone, and they are
  // deliberately about TASK LENGTH rather than total ms: `decodeMs` is the same
  // work either way, and quoting it as a win would be the exact mistake this
  // file's tombstone was written about.
  //
  //   queued        jobs that entered the FIFO (== decodes, budget on)
  //   drains        drain passes that ran at least one job
  //   maxBatch      most jobs run in ONE drain — the pile-up metric. Off-budget
  //                 this is unmeasured (no drains); on-budget a landblock
  //                 crossing that used to be one N-job task shows as maxBatch
  //                 small and `drains` ~= `queued`.
  //   maxDrainMs    longest single drain pass, i.e. the longest task this
  //                 module contributes. Floored by ONE decode by construction.
  //   deferrals     times a drain hit the cap with work still queued (each one
  //                 is a burst that used to run inside the same task)
  //   maxQueueDepth high-water FIFO depth — how big the burst actually was
  //   queueWaitMs   total time jobs spent waiting. THE COST SIDE of this fix:
  //                 records upgrade later. Report it next to any win.
  //   maxQueueWaitMs the worst single wait.
  //
  //   maxRun        THE ONE METRIC THAT EXISTS ON BOTH ARMS, and therefore the
  //                 only before/after this change can be quoted from. `drains`
  //                 and `maxBatch` are structurally zero with `?xu7Budget=off`,
  //                 so they cannot compare anything. A "run" is a maximal chain
  //                 of decodes with no yield between them — the pile-up itself.
  //                 HEURISTIC, stated plainly: a run is broken when the gap
  //                 between one decode ENDING and the next STARTING exceeds
  //                 `XU7_RUN_GAP_MS`. JS gives no honest "are we still in the
  //                 same task" predicate from inside a promise continuation
  //                 (`queueMicrotask` ordering depends on when each sibling was
  //                 queued), and a sub-millisecond gap between two ~32 ms
  //                 decodes means nothing yielded in between. Budgeted, it
  //                 should track `maxBatch`; unbudgeted, it is the burst size.
  //   runs          how many such chains there were.
  maxRun: 0,
  runs: 0,
  queued: 0,
  drains: 0,
  maxBatch: 0,
  maxDrainMs: 0,
  deferrals: 0,
  maxQueueDepth: 0,
  queueWaitMs: 0,
  maxQueueWaitMs: 0,
};

export function xu7Stats() {
  return {
    ..._stats,
    enabled: texXu7Enabled(),
    // Config + live level, kept OUT of `_stats` so `_resetXu7ForTest`'s
    // zero-every-number sweep cannot silently rewrite the configuration.
    budgetEnabled: xu7BudgetEnabled(),
    budgetMs: _budgetMs(),
    queueDepth: _queue.length,
  };
}

// ---------------------------------------------------------------------------
// THE BUDGETED FIFO
// ---------------------------------------------------------------------------
// Entirely inside this module, on purpose. `transcodeXu7` was already `async`
// and already had exactly one caller (`Bc7RecordSource._begin`), which awaits
// its promise — so deferring the decode to a drain changes WHEN the promise
// settles and nothing else. No caller edit, no new message kind, no wasm
// plumbing, and `bc7_textures.js` is untouched by this change.

const _now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

// Run detection (see `_stats.maxRun`). 0.5 ms: two decodes separated by less
// than this had nothing between them worth calling a yield, and the items being
// chained are milliseconds to tens of milliseconds each, so the threshold is
// two orders of magnitude below the thing it separates.
const XU7_RUN_GAP_MS = 0.5;
let _lastDecodeEndMs = null;
let _runLen = 0;

/** @type {Array<{module:any, bytes:Uint8Array, resolve:(v:any)=>void, tQueued:number}>} */
const _queue = [];
let _drainScheduled = false;
let _rafHandle = null;
let _timerHandle = null;

// rAF is the right clock (this is per-FRAME work competing with rendering) but
// it does not fire in a hidden tab, and it does not exist in node or a worker.
// The guard timer is what stops a backgrounded tab from parking the queue
// forever; in a visible tab the rAF always wins and cancels it.
const _HIDDEN_GUARD_MS = 250;

function _scheduleDrain() {
  if (_drainScheduled) return;
  _drainScheduled = true;
  // ST8 stage A (?frameWork=on): the drain registers as a W6 client — the
  // scheduler calls `_drain` inside the post-render stream slot under the
  // GLOBAL cap (the drain's own ?xu7BudgetMs batch bound and T14's worker
  // routing are untouched; this FIFO is the fallback arm either way).
  // `_drain`'s leading `_clearScheduled()` resets `_drainScheduled` on both
  // paths. Flag OFF: the rAF + hidden-tab guard below, byte-identical.
  if (frameWorkW6Run("xu7Drain", () => _drain())) return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  if (raf) {
    try {
      _rafHandle = raf(() => _drain());
    } catch (_) {
      _rafHandle = null;
    }
  }
  try {
    _timerHandle = setTimeout(() => _drain(), raf ? _HIDDEN_GUARD_MS : 0);
  } catch (_) {
    _timerHandle = null;
  }
}

function _clearScheduled() {
  _drainScheduled = false;
  if (_rafHandle !== null) {
    try {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(_rafHandle);
    } catch (_) {
      /* fail-soft */
    }
    _rafHandle = null;
  }
  if (_timerHandle !== null) {
    try {
      clearTimeout(_timerHandle);
    } catch (_) {
      /* fail-soft */
    }
    _timerHandle = null;
  }
}

/**
 * Run queued transcodes until the per-frame cap is spent, then reschedule.
 *
 * ALWAYS RUNS AT LEAST ONE. The cap is 6 ms and a big record is ~32 ms, so a
 * cap checked BEFORE the first job would drain nothing, forever.
 *
 * THE EXACT BOUND, because a wrong one here is worse than none: a drain never
 * STARTS an item once the cap is spent, so one drain is at most
 * `budget + (one item)` — NOT "at most 6 ms per frame", and not "at most one
 * item per frame" either. Both looser readings have been written down and both
 * are wrong.
 *
 * A COROLLARY THAT MUST TRAVEL WITH IT: where records were ALREADY arriving one
 * per task, the FIFO can COALESCE cheap ones into a batch that did not exist
 * before (bounded, as above, by the cap). That is measured, not theoretical —
 * see the local one-hop numbers in the commit. It is the right trade for a p99
 * fix (the worst case strictly improves, the best case gets slightly lumpier,
 * and 200 tiny mips should not take 200 frames to upgrade), but it does mean
 * `maxRun` can read HIGHER with the budget on in a workload that never had a
 * pile-up. Do not read that as a regression without checking `maxDrainMs`.
 *
 * WHY NOT SPLIT A RECORD ACROSS FRAMES. `transcodeImage` is per-mip and the
 * levels are independent, so level-granularity yielding is possible and would
 * cut the worst single task from ~32 ms to ~24 ms (level 0 is 3/4 of a mip
 * chain's texels). It also means holding an open `KTX2File` across frames, with
 * a close/delete obligation on every abandonment path. Not taken here: the
 * measured hitch is the N-record burst, not one record, and this fix is the one
 * that can be reasoned about without a live GPU.
 *
 * SHAPE (a) SHIPPED AT ST4 (2026-08-08) — as a DEDICATED texture worker, not
 * the bake worker (pass-05 D-05.4 rejected the bake worker as host: it would
 * couple texture throughput to bake jobs and to the wasm topology; the
 * texture worker is deliberately wasm-free). `?texWorkers=on` routes
 * transcodes there (own 1.04 MB transcoder instance — the tombstone's
 * per-context trap, paid once, off the window thread), and THIS budgeted path
 * is its main-thread fallback for worker-off/loading/crashed — "(b) is a
 * prerequisite for (a) being safe" held: (a) was built on top of (b), and (b)
 * is retained verbatim as the kill path.
 */
function _drain() {
  _clearScheduled();
  if (_queue.length === 0) return;
  // A drain callback IS a fresh task (rAF or the guard timer), so decodes in
  // two different drains are in two different tasks by construction — no
  // heuristic needed. Breaking the run here makes `maxRun` EXACT on the
  // budgeted arm and leaves the timestamp heuristic to do the work only on the
  // unbudgeted one, which is the arm that has nothing better.
  // (`_drainXu7QueueForTest` calls this in-task; that is a test hook, and the
  // suite's tight drain loop is the one place the assumption is synthetic.)
  _lastDecodeEndMs = null;
  _runLen = 0;
  const budget = _budgetMs();
  const t0 = _now();
  let ran = 0;
  if (_queue.length > _stats.maxQueueDepth) _stats.maxQueueDepth = _queue.length;
  while (_queue.length > 0) {
    if (ran > 0 && _now() - t0 >= budget) {
      _stats.deferrals += 1;
      break;
    }
    const job = _queue.shift();
    const wait = _now() - job.tQueued;
    _stats.queueWaitMs += wait;
    if (wait > _stats.maxQueueWaitMs) _stats.maxQueueWaitMs = wait;
    let out = null;
    try {
      out = _transcodeNow(job.module, job.bytes);
    } catch (e) {
      // `_transcodeNow` already catches and returns null; this is belt-and-braces
      // so one bad record can never abandon the rest of the queue.
      _stats.decodeErrors += 1;
      _stats.lastError = String(e && e.message ? e.message : e);
      out = null;
    }
    ran += 1;
    // Resolution is a microtask, so the caller's continuation runs after this
    // drain returns rather than nesting inside it.
    job.resolve(out);
  }
  const drainMs = _now() - t0;
  _stats.drains += 1;
  if (ran > _stats.maxBatch) _stats.maxBatch = ran;
  if (drainMs > _stats.maxDrainMs) _stats.maxDrainMs = drainMs;
  if (_queue.length > 0) _scheduleDrain();
}

let _modulePromise = null;
let _module = null;

/**
 * The transcoder IF it is already up, else null — kicking the load on the way
 * past. This is the gate `Bc7RecordSource` uses, and it is the reason the xu7
 * tier cannot stall the BC7 path.
 *
 * WHY THIS EXISTS. `transcodeXu7` awaits `xu7Transcoder()`, and the fallback
 * contract ("any miss/failure falls back to tex-bc7") covers a REJECTED load,
 * not one that simply never settles. With the record source awaiting it, every
 * full-record fetch queued behind a slow module load: measured on localhost,
 * ~15 s from the first xu7 decode to the module being ready (the 50 KB glue
 * alone took 7.2 s behind the app's 24-way fetch concurrency over HTTP/1.1's
 * 6-connection limit), and on the 666 kbps line this tier targets the 1.04 MB
 * wasm is ~13 s by itself. During that window NO surface upgraded, every
 * material kept `__bc7Pending`, and the atlas deferred all of them. A load that
 * never settled at all would have been permanent and silent — `transcoderFailed`
 * stays null while a promise is merely pending.
 *
 * Asking "is it up?" instead of "wait for it" removes the failure mode
 * structurally rather than papering over it with a timeout: while the module is
 * loading, records take the hbc7 route (correct pixels, the bytes we would have
 * spent with the tier off), and the xu7 saving starts as soon as it lands. It
 * also stops the pre-fix waste of fetching an xu7 payload and then dropping it
 * into a stalled await.
 */
export function ensureXu7Transcoder(baseUrl) {
  if (_module) return _module;
  // Fire-and-forget: something has to start the load, and this is the only
  // caller on the hot path.
  xu7Transcoder(baseUrl);
  _stats.notReadySkips += 1;
  return null;
}

/**
 * Load + initialize the transcoder module ONCE per JS context. Resolves to
 * the initialized emscripten module or null (load failure is remembered —
 * the xu7 path disables itself rather than re-downloading 1 MB per record).
 */
export function xu7Transcoder(baseUrl) {
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    try {
      const base = baseUrl || new URL("./transcoder/", import.meta.url);
      const jsUrl = new URL("basis_transcoder.js", base);
      const resp = await fetch(jsUrl);
      if (!resp.ok) throw new Error(`transcoder js fetch ${resp.status}`);
      const src = await resp.text();
      // UMD glue: evaluating the script text defines `BASIS` in scope.
      // eslint-disable-next-line no-new-func
      const factory = new Function(`${src}\nreturn BASIS;`)();
      const module = await factory({
        locateFile: (f) => new URL(f, base).href,
      });
      module.initializeBasis();
      _module = module;
      _stats.transcoderLoads += 1;
      return module;
    } catch (e) {
      _stats.transcoderFailed = String(e && e.message ? e.message : e);
      // eslint-disable-next-line no-console
      console.warn("[xu7] transcoder load failed (falling back to tex-bc7):", e);
      return null;
    }
  })();
  return _modulePromise;
}

/** Test hook: preset the transcoder module (node tests can't run the
 *  browser-shaped UMD loader — emscripten's node branch requires
 *  `require`, absent in ESM eval). */
export function _setXu7ModuleForTest(modulePromise) {
  // Accepts a module or a promise for one. `await xu7Transcoder()` afterwards
  // to make `ensureXu7Transcoder()` report ready.
  _modulePromise = Promise.resolve(modulePromise).then((m) => {
    _module = m ?? null;
    return m ?? null;
  });
}

/** Test hook: reset flag + transcoder memo + stats + the FIFO.
 *
 *  Pending jobs are RESOLVED with null rather than dropped: a dropped job is a
 *  promise that never settles, and the one caller awaits it inside a
 *  `.finally`-guarded chain, so a test that resets mid-flight would hang
 *  `_inflightP` forever instead of failing. null is the value the whole path
 *  already treats as "fall back to hbc7". */
export function _resetXu7ForTest() {
  _flag = undefined;
  _modulePromise = null;
  _module = null;
  _clearScheduled();
  _lastDecodeEndMs = null;
  _runLen = 0;
  while (_queue.length) {
    const job = _queue.shift();
    try {
      job.resolve(null);
    } catch (_) {
      /* fail-soft */
    }
  }
  for (const k of Object.keys(_stats)) {
    if (typeof _stats[k] === "number") _stats[k] = 0;
    else _stats[k] = null;
  }
}

/** Test hook: run one drain pass NOW, ignoring the rAF/timer schedule.
 *  Returns the queue depth left behind. */
export function _drainXu7QueueForTest() {
  _drain();
  return _queue.length;
}

/** Test hook: the live FIFO depth without going through `xu7Stats()`. */
export function _xu7QueueDepthForTest() {
  return _queue.length;
}

/**
 * Transcode an XUBC7 KTX2 payload to the EXACT shape `parseHbc7` returns —
 * `{width, height, blocksX, blocksY, levels:[{data,width,height}]}` — so
 * every downstream consumer (makeBc7Texture, the statics atlas) is unaware
 * which wire codec delivered the blocks.
 *
 * Returns null on ANY failure; the caller falls back to the hbc7 path.
 *
 * 2026-08-08 — the decode itself is `_transcodeNow`; this function's job is now
 * to get the module and then either run it straight through (`?xu7Budget=off`)
 * or hand it to the budgeted FIFO. The RESOLVED VALUE is identical either way,
 * so `Bc7RecordSource._begin` and every downstream consumer are unchanged.
 *
 * ST4 (`?texWorkers=on`, DEFAULT OFF): the transcode routes to the dedicated
 * texture worker FIRST — same transcoder, same output shape, off the window
 * thread. If the worker is not routable (flag off, still loading, crashed,
 * queue over cap) the call falls through to the two lines of legacy behaviour
 * below, and every flag-ON fall-through is counted (`fifoFallbacks` /
 * `fallbackEngagements` on `__texWorkerStats`) so the fallback can never
 * engage silently — SPEC T14's kill criterion.
 */
export async function transcodeXu7(bytes, baseUrl) {
  if (texWorkersEnabled()) {
    const routed = await _workerTranscodeXu7(bytes);
    if (routed !== _TW_UNROUTED) return routed;
    _twStats.fifoFallbacks += 1;
  }
  const module = await xu7Transcoder(baseUrl);
  if (!module || !bytes || bytes.length === 0) return null;
  if (!xu7BudgetEnabled()) return _transcodeNow(module, bytes);
  return new Promise((resolve) => {
    _queue.push({ module, bytes, resolve, tQueued: _now() });
    _stats.queued += 1;
    if (_queue.length > _stats.maxQueueDepth) _stats.maxQueueDepth = _queue.length;
    _scheduleDrain();
  });
}

/** The synchronous decode. Never throws (the caller's fallback contract is
 *  "null means take the hbc7 route"), and owns the KTX2File lifetime. */
function _transcodeNow(module, bytes) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  // Run bookkeeping — the ONLY before/after metric that exists on both arms.
  // Measured around the whole decode (including the failure path), because a
  // decode that threw still occupied the task.
  if (_lastDecodeEndMs !== null && t0 - _lastDecodeEndMs < XU7_RUN_GAP_MS) {
    _runLen += 1;
  } else {
    _runLen = 1;
    _stats.runs += 1;
  }
  if (_runLen > _stats.maxRun) _stats.maxRun = _runLen;
  let file = null;
  try {
    file = new module.KTX2File(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    if (!file.isValid()) throw new Error("KTX2 invalid");
    const width = file.getWidth();
    const height = file.getHeight();
    const levelCount = file.getLevels();
    if (!width || !height || !levelCount) throw new Error(`bad dims/levels ${width}x${height}/${levelCount}`);
    if (!file.startTranscoding()) throw new Error("startTranscoding failed");
    const fmt = module.transcoder_texture_format.cTFBC7_RGBA.value;
    const levels = [];
    let lw = width;
    let lh = height;
    for (let i = 0; i < levelCount; i++) {
      const need = bc7LevelBytes(lw, lh);
      const size = file.getImageTranscodedSizeInBytes(i, 0, 0, fmt);
      if (size !== need) throw new Error(`level ${i} size ${size} != expected ${need}`);
      const dst = new Uint8Array(size);
      if (!file.transcodeImage(dst, i, 0, 0, fmt, 0, -1, -1)) {
        throw new Error(`transcodeImage failed at level ${i}`);
      }
      levels.push({ data: dst, width: lw, height: lh });
      if (lw === 1 && lh === 1) break;
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }
    _stats.decodes += 1;
    _stats.decodeMs += (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    return {
      width,
      height,
      blocksX: bc7BlocksFor(width),
      blocksY: bc7BlocksFor(height),
      levels,
    };
  } catch (e) {
    _stats.decodeErrors += 1;
    _stats.lastError = String(e && e.message ? e.message : e);
    // eslint-disable-next-line no-console
    console.warn("[xu7] transcode failed (falling back to tex-bc7):", _stats.lastError);
    return null;
  } finally {
    _lastDecodeEndMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (file) {
      try {
        file.close();
        file.delete();
      } catch (_) {
        /* fail-soft */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ?texWorkers — ST4 dedicated-texture-worker CLIENT (SPEC §3 T14; pass-05
// D-05.4 + S3, pass-08 D-08.4)
// ---------------------------------------------------------------------------
// The worker itself is scene3d/texture_worker.js (wasm-free, own transcoder
// instance, self-contained — it cannot import this file). This client owns:
//   * the flag (`texWorkersEnabled` — DEV opt-in, DEFAULT OFF; the default
//     flip is a migration event gated on GATE-TEXWORKER, never done here);
//   * lifecycle: lazy construction, an ASK-DON'T-AWAIT ready gate for the hot
//     xu7 path (the ensureXu7Transcoder lesson: a load that never settles must
//     not stall record upgrades — while the worker loads, records ride the
//     budgeted FIFO and are counted), and a bounded AWAIT for the one-shot
//     terrain assembly (which is exactly the 88 MiB task the worker exists
//     to absorb, so it is worth waiting a few seconds for);
//   * a client-side FIFO, ONE job in flight (pass-08 backpressure), depth-
//     capped — over-cap xu7 asks fall back to the budgeted FIFO, counted;
//   * fallback accounting: EVERY path that routes work back to the main
//     thread while the flag is ON increments a counter on `__texWorkerStats`
//     (fifoFallbacks / fallbackEngagements / pendingNulled / terrainFallbacks)
//     — "fallback failing to engage silently" is T14's kill criterion, so
//     silence is designed out;
//   * RESULTS-ENQUEUE-ONLY (pass-08 D-08.5): the onmessage handler ONLY
//     settles the caller's promise — the continuation is the same microtask
//     the budgeted FIFO's `job.resolve` produces today. No GPU object is
//     created in the worker or in the arrival callback; uploads keep their
//     existing main-thread schedule.
//
// Worker crash mid-job: the transferred payload bytes died with the worker,
// so pending jobs are resolved null — for xu7 that is the existing "null means
// take the hbc7 route" contract (correct pixels, extra bytes), for terrain the
// caller re-fetches from HTTP cache. All counted, warned once, and every
// SUBSEQUENT job routes straight to the main-thread arm.

/**
 * `?texWorkers` — DEV opt-in, **DEFAULT OFF** (flag lifecycle SPEC §0.1; the
 * orchestrator flips it after GATE-TEXWORKER). EXACT-MATCH opt-in like
 * `?texFreeCpu`: only `on`/`1`/`true`/`yes` (or an integer >= 1 — the
 * `?texWorkers=N` measurement escape; v1 always constructs ONE worker and
 * records the request) read ON. Absent, empty, `off`, `0`, garbage ⇒ OFF.
 * Not memoized — same ESM-suite re-stub reason as `xu7BudgetEnabled`.
 */
export function texWorkersEnabled(search) {
  return _texWorkersRequested(search) >= 1;
}

/** The requested worker count (0 = off). v1 constructs at most 1. */
function _texWorkersRequested(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("texWorkers");
    if (v == null) return 0;
    const t = String(v).toLowerCase();
    if (t === "on" || t === "true" || t === "yes") return 1;
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) && n >= 1 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Client FIFO depth cap [A]: an xu7 ask beyond it rides the budgeted FIFO
// instead (counted). Terrain jobs (2/session) are never the ones over cap.
const TEX_WORKER_QUEUE_CAP = 64;
// How long the ONE-SHOT terrain assembly will wait for the worker to come up
// before falling back to the synchronous main-thread build [A]. The worker
// script is same-origin and `ready` does not wait on the transcoder, so this
// is script-fetch + eval time.
const TEX_WORKER_TERRAIN_READY_MS = 10_000;

const _TW_UNROUTED = Symbol("texWorker-unrouted");

let _twWorker = null;
let _twState = "off"; // off | loading | ready | dead
let _twSeq = 0;
let _twReadyPromise = null;
let _twReadyResolve = null;
let _twFactory = null; // test hook
/** @type {Array<{msg:any, transfers:any[], resolve:(v:any)=>void}>} */
const _twQueue = [];
/** @type {Map<number, {msg:any, transfers:any[], resolve:(v:any)=>void}>} */
const _twPending = new Map();

const _twStats = {
  jobs: 0, // worker jobs completed ok (xu7)
  jobErrors: 0, // worker answered ok:false (bad payload class — hbc7 fallback)
  msTranscode: 0, // OFF-THREAD worker transcode ms (reported, never frame-attributed)
  maxQueueDepth: 0,
  fifoFallbacks: 0, // flag ON but an xu7 ask rode the main-thread FIFO (loading/dead/over-cap)
  fallbackEngagements: 0, // worker death transitions (construction failure, crash)
  pendingNulled: 0, // in-flight jobs lost to a crash, resolved null
  cancels: 0,
  terrainAssembles: 0,
  msAssemble: 0, // OFF-THREAD worker assembly ms
  terrainFallbacks: 0, // terrain assembly rode the main thread while flag ON
  nraDerives: 0,
  lastError: null,
};

/** Read via `window.__texWorkerStats()` (installed below at module scope —
 *  this module loads with the scene3d import graph at boot). Folds into
 *  `__texStats().worker` at ST5 (same-name-successor; see the diag registry). */
export function texWorkerStats() {
  return {
    ..._twStats,
    enabled: texWorkersEnabled(),
    requested: _texWorkersRequested(),
    state: _twState,
    queueDepth: _twQueue.length + _twPending.size,
    inflight: _twPending.size,
  };
}
if (typeof window !== "undefined") {
  try {
    window.__texWorkerStats = () => texWorkerStats();
  } catch (_) {
    /* fail-soft */
  }
}

function _twDie(reason) {
  if (_twState === "dead") return;
  _twState = "dead";
  _twStats.fallbackEngagements += 1;
  _twStats.lastError = String(reason);
  // Loud once, on purpose — the kill criterion is a SILENT fallback.
  // eslint-disable-next-line no-console
  console.warn("[texWorkers] texture worker failed — main-thread fallback armed (counted):", reason);
  if (_twReadyResolve) {
    _twReadyResolve(false);
    _twReadyResolve = null;
  }
  const drop = (job) => {
    _twStats.pendingNulled += 1;
    try {
      job.resolve(null);
    } catch (_) {
      /* fail-soft */
    }
  };
  for (const [, job] of _twPending) drop(job);
  _twPending.clear();
  while (_twQueue.length) drop(_twQueue.shift());
  if (_twWorker) {
    try {
      _twWorker.terminate();
    } catch (_) {
      /* fail-soft */
    }
    _twWorker = null;
  }
}

/** Kick construction if needed; true only when the worker is READY NOW.
 *  Never awaits — the xu7 hot path asks, it does not wait. */
function _twEnsure() {
  if (_twState === "ready") return true;
  if (_twState === "dead" || _twState === "loading") return false;
  _twState = "loading";
  _twReadyPromise = new Promise((res) => {
    _twReadyResolve = res;
  });
  try {
    const make =
      _twFactory ||
      (() => new Worker(new URL("./texture_worker.js", import.meta.url), { type: "module" }));
    _twWorker = make();
    _twWorker.onmessage = (ev) => _twOnMessage(ev && ev.data);
    _twWorker.onerror = (ev) =>
      _twDie(`worker error: ${(ev && (ev.message || ev.type)) || "unknown"}`);
    try {
      _twWorker.onmessageerror = () => _twDie("worker messageerror");
    } catch (_) {
      /* optional handler */
    }
    let base = null;
    try {
      base = new URL("./transcoder/", import.meta.url).href;
    } catch (_) {
      base = null;
    }
    _twWorker.postMessage({ type: "init", transcoderBaseUrl: base });
  } catch (e) {
    _twDie(`construct: ${String(e && e.message ? e.message : e)}`);
  }
  return false;
}

/** Await readiness with a bound. `timeoutMs <= 0` = ask-only (no wait). */
async function _twReady(timeoutMs) {
  if (_twState === "ready") return true;
  if (_twState === "dead") return false;
  _twEnsure();
  if (_twState === "ready") return true;
  if (_twState === "dead" || !_twReadyPromise) return false;
  if (!(timeoutMs > 0)) return false;
  let timer = null;
  const winner = await Promise.race([
    _twReadyPromise,
    new Promise((res) => {
      timer = setTimeout(() => res("timeout"), timeoutMs);
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  return winner === true;
}

function _twOnMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ready") {
    if (_twState === "loading") {
      _twState = "ready";
      if (_twReadyResolve) {
        _twReadyResolve(true);
        _twReadyResolve = null;
      }
      _twPump();
    }
    return;
  }
  if (msg.type !== "result") return;
  const job = _twPending.get(msg.seq);
  if (!job) return;
  _twPending.delete(msg.seq);
  // RESULTS-ENQUEUE-ONLY: settling the promise is ALL this callback does —
  // the caller's continuation is a microtask, the exact shape the budgeted
  // FIFO's job.resolve produces. No scene, no GL, no uploads here.
  try {
    job.resolve(msg);
  } catch (_) {
    /* fail-soft */
  }
  _twPump();
}

function _twSubmit(msg, transfers) {
  return new Promise((resolve) => {
    _twQueue.push({ msg, transfers: transfers || [], resolve });
    const depth = _twQueue.length + _twPending.size;
    if (depth > _twStats.maxQueueDepth) _twStats.maxQueueDepth = depth;
    _twPump();
  });
}

/** ONE job in flight (pass-08 backpressure); FIFO within the client queue. */
function _twPump() {
  if (_twState !== "ready" || _twPending.size > 0) return;
  const job = _twQueue.shift();
  if (!job) return;
  _twPending.set(job.msg.seq, job);
  try {
    _twWorker.postMessage(job.msg, job.transfers);
  } catch (e) {
    _twDie(`postMessage: ${String(e && e.message ? e.message : e)}`);
  }
}

/**
 * Cancel a queued/in-flight worker job by seq (pass-05 S3 `cancel`). A job
 * still in the client queue resolves null immediately; one already posted is
 * cancelled worker-side only if the worker has not reached it (its reply then
 * reads `ok:false, err:"cancelled"`). Returns whether the seq was known.
 * No caller evicts pre-run today — this is the ST5 eviction seam.
 */
export function cancelTextureWorkerJob(seq) {
  for (let i = 0; i < _twQueue.length; i += 1) {
    if (_twQueue[i].msg.seq === seq) {
      const [job] = _twQueue.splice(i, 1);
      _twStats.cancels += 1;
      try {
        job.resolve(null);
      } catch (_) {
        /* fail-soft */
      }
      return true;
    }
  }
  if (_twPending.has(seq) && _twWorker) {
    _twStats.cancels += 1;
    try {
      _twWorker.postMessage({ type: "cancel", seq });
    } catch (_) {
      /* fail-soft */
    }
    return true;
  }
  return false;
}

/** Rebuild the exact `parseHbc7`/`_transcodeNow` result shape as zero-copy
 *  subarray views over the ONE transferred buffer (pass-05 S3 contract). */
function _twReconstructParsed(res) {
  const buf = new Uint8Array(res.bc7);
  const levels = [];
  let off = 0;
  let lw = res.width;
  let lh = res.height;
  for (const n of res.levelBytes) {
    levels.push({ data: buf.subarray(off, off + n), width: lw, height: lh });
    off += n;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  return {
    width: res.width,
    height: res.height,
    blocksX: bc7BlocksFor(res.width),
    blocksY: bc7BlocksFor(res.height),
    levels,
  };
}

/**
 * Route one xu7 transcode to the worker. Returns `_TW_UNROUTED` when the
 * worker cannot take it (caller falls through to the legacy arm and counts);
 * otherwise resolves exactly like `_transcodeNow` (parsed shape, or null =
 * "take the hbc7 route").
 */
async function _workerTranscodeXu7(bytes) {
  if (!bytes || bytes.length === 0) return null;
  if (!_twEnsure()) return _TW_UNROUTED;
  if (_twQueue.length + _twPending.size >= TEX_WORKER_QUEUE_CAP) return _TW_UNROUTED;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Transfer, don't copy — but only when the view owns its whole buffer
  // (`xu7_blocks` returns fresh copies out of wasm memory, so it does).
  const owned = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
  const seq = ++_twSeq;
  const res = await _twSubmit(
    { type: "job", seq, kind: "xu7", bytes: owned.buffer, want: { nra: null } },
    [owned.buffer],
  );
  if (!res) return null; // worker died mid-flight (pendingNulled counted) → hbc7 route
  if (!res.ok) {
    _twStats.jobErrors += 1;
    _twStats.lastError = String(res.err ?? "job failed");
    // eslint-disable-next-line no-console
    console.warn("[texWorkers] xu7 job failed (falling back to tex-bc7):", _twStats.lastError);
    return null;
  }
  _twStats.jobs += 1;
  _twStats.msTranscode += res.transcodeMs || 0;
  return _twReconstructParsed(res);
}

/**
 * Terrain BC7 array assembly in the worker (pass-05 D-05.4: the 88 MiB
 * level-major alloc+copy leaves the main thread). Caller: terrain_bc7.js
 * `buildTerrainBc7Atlas`, which gates on `texWorkersEnabled()` and falls back
 * to the synchronous `buildTerrainBc7Array` on ANY throw here (re-fetching
 * its payloads — the transferred buffers died with the job).
 *
 * @param {{tileSize:number, levels:number, depth:number, layerRs:string[],
 *          payloads:Array<{rs:string, bytes:ArrayBuffer}>}} job
 * @returns {Promise<{tileSize:number, levels:number, depth:number,
 *          levelBytes:number[], bc7:ArrayBuffer, assembleMs:number}>}
 */
export async function workerTerrainAssemble(job) {
  const ready = await _twReady(TEX_WORKER_TERRAIN_READY_MS);
  if (!ready) {
    _twStats.terrainFallbacks += 1;
    throw new Error(`texture worker unavailable (state=${_twState})`);
  }
  const seq = ++_twSeq;
  const transfers = job.payloads.map((p) => p.bytes);
  const res = await _twSubmit({ type: "job", seq, kind: "terrain-assemble", ...job }, transfers);
  if (!res || !res.ok) {
    _twStats.terrainFallbacks += 1;
    const err = res && res.err ? String(res.err) : "texture worker died during terrain assembly";
    _twStats.lastError = err;
    throw new Error(err);
  }
  _twStats.terrainAssembles += 1;
  _twStats.msAssemble += res.assembleMs || 0;
  return res;
}

/**
 * Standalone NRA derivation in the worker (pass-05 D-05.5's `nra-derive`
 * kind; RGBA8 plane in the terrain channel convention R/G=normal XY,
 * B=roughness, A=AO). Ask-only readiness — returns null when the worker is
 * not up, and the caller keeps its current source. The ST5 consumer seam;
 * no production caller at ST4.
 */
export async function workerDeriveNra({ width, height, rgba, strength }) {
  const ready = await _twReady(0);
  if (!ready) return null;
  const seq = ++_twSeq;
  const res = await _twSubmit(
    { type: "job", seq, kind: "nra-derive", width, height, rgba, strength },
    [rgba],
  );
  if (!res || !res.ok) return null;
  _twStats.nraDerives += 1;
  return { width: res.width, height: res.height, plane: new Uint8Array(res.plane) };
}

/** Test hook: inject a Worker-shaped factory (node has no Worker). */
export function _setTexWorkerFactoryForTest(factory) {
  _twFactory = factory ?? null;
}

/** Test hook: tear down the client — terminate, null-resolve everything,
 *  zero the stats (same discipline as `_resetXu7ForTest`). */
export function _resetTexWorkerForTest() {
  if (_twWorker) {
    try {
      _twWorker.terminate();
    } catch (_) {
      /* fail-soft */
    }
  }
  _twWorker = null;
  _twState = "off";
  _twSeq = 0;
  _twReadyPromise = null;
  _twReadyResolve = null;
  while (_twQueue.length) {
    const j = _twQueue.shift();
    try {
      j.resolve(null);
    } catch (_) {
      /* fail-soft */
    }
  }
  for (const [, j] of _twPending) {
    try {
      j.resolve(null);
    } catch (_) {
      /* fail-soft */
    }
  }
  _twPending.clear();
  for (const k of Object.keys(_twStats)) {
    _twStats[k] = typeof _twStats[k] === "number" ? 0 : null;
  }
}

/** Test hook: the live client state string. */
export function _texWorkerStateForTest() {
  return _twState;
}
