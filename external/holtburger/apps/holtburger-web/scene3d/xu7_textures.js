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
// `=off` restores the straight-through call). Shape (a) was NOT attempted; see
// the note on `_drain` for why (b) is the one that addresses the hitch and what
// (a) would still be worth.
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
 * WHY NOT THE BAKE WORKER (shape (a)). Still the better end state and still not
 * done: the worker would need its own 1.04 MB transcoder instance (each context
 * instantiates its own — the tombstone's trap), a new `bake_worker.js` message
 * kind with a `{type:'result', kind:...}` reply, the mip levels moved back as
 * zero-copy transferables through `bake_transfer.js`, and a main-thread
 * fallback in `bake_worker_client.js` for both inactive-worker and worker-error
 * — and that fallback is, by construction, exactly this budgeted path. So (b)
 * is a prerequisite for (a) being safe, not an alternative to it.
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
 */
export async function transcodeXu7(bytes, baseUrl) {
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
