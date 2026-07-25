// scene3d/bake_worker_client.js
//
// M2 (worker-based asset bake) — main-thread client for `bake_worker.js`.
// Exposes a Promise API mirroring the heavy WASM decoders, with a
// TRANSPARENT main-thread fallback: when the worker is disabled,
// unsupported, or not yet ready, calls route straight to `wasmExports` so
// behaviour is byte-identical to the pre-M2 path.
//
// In particular `modelMeshFetcher(wasmExports)` returns the EXACT
// `wasmExports.fetch_model_meshes` *reference* when the worker is inactive,
// so a call site that swaps in the fetcher has zero behavioural change
// while the flag is off.
//
// Default-ON since 2026-07-01; opt out with `?bakeWorker=0` (also
// off/false) or `configureBakeWorker({ enabled: false })` during boot.
//
// R-1 (2026-07-09): tex-swap alias DIDs (0x08F00000+n) only resolve in the
// main thread's wasm instance, so worker-routed requests are SPLIT — alias
// DIDs decode on the main-thread wasm, real DIDs in the worker — and the
// results stitched back in input order (`?aliasSplit=0` reverts).

import {
  applySurfaceAudit,
  extractSurfaceAudit,
  reconstructModelMeshes,
  reconstructSurfacePixelsBatch,
  reconstructEntitySurfacesBatch,
} from "./bake_transfer.js";

function urlFlagEnabled() {
  try {
    // Default-ON (2026-07-01): offloads model-mesh + surface-pixel decode to the worker.
    // A/B (laptop/SwiftShader, Holtburg settle + 15 westward @teleloc hops) measured
    // −24% main-thread longtasks total and −34..−37% on the 100–500ms per-LB bake stalls,
    // with 0 console/page errors and 0 main-thread fallbacks (worker fully engaged). The
    // decode is byte-identical to the main-thread path — this only moves WHERE it runs — and
    // failure transparently falls back to the main thread, so default-on is fail-safe.
    // Opt out with ?bakeWorker=0 (also off/false). Does NOT offload the terrain-atlas build.
    const v = new URLSearchParams(globalThis.location?.search || "").get("bakeWorker");
    return v !== "0" && v !== "off" && v !== "false";
  } catch (_) {
    return true;
  }
}

// F1 fetch-concurrency split (defect 3, 2026-07-24).
//
// `concurrency.rs` documents ONE `Semaphore(32)` "per page", but the page runs
// two wasm instances — this thread and the bake worker — and BOTH call
// `init_resource_source`, so both mint a semaphore and the real page-wide fetch
// ceiling was 64: half the F1 stutter fix, silently.
//
// Fix without shared memory: divide the budget before either instance connects.
// The authored knob `globalThis.__hbFetchConcurrency` (or the Rust default 32)
// is the PAGE total; this leaves the main share in `__hbFetchConcurrency` (which
// is what `configured_fetch_concurrency()` reads on this thread) and publishes
// the worker's share for the `init` message. `__hbFetchConcurrencyTotal` keeps
// the authored value so A/B tooling can still see what was asked for.
//
// Share: a quarter to the worker (8 of 32). The worker only fetches shards it
// needs for model/surface decode and dedups against nothing on this side, while
// the main thread carries terrain/statics/scenery/buildings prefetch fan-out —
// so the asymmetry matches the traffic. When the worker is disabled
// (`?bakeWorker=0`) or unavailable, the main thread keeps the whole budget.
//
// MUST be called before `init_resource_source` on the main thread; after that
// the main semaphore is already sized.
const DEFAULT_FETCH_CONCURRENCY = 32; // mirrors concurrency.rs DEFAULT_FETCH_CONCURRENCY
const WORKER_FETCH_SHARE_FRACTION = 0.25;

// A15 §1 shard-cache budget (2026-07-25).
//
// `V2Source::shards` — the resource source's DAT-record cache — never evicted:
// S1/S2 measured it ratcheting to ~58 MB (main) + ~21 MB (worker) over four town
// hops and never falling, the dominant tracked RSS ratchet. Rust now backs it
// with a byte-budgeted LRU whose DEFAULT budget is unbounded, so nothing changes
// until a host sets `globalThis.__hbShardBudgetBytes` (read by
// `configured_shard_budget_bytes()` in `manifest_source.rs`, exactly like
// `__hbFetchConcurrency`).
//
// The knob is authored as `?shardBudgetMB=N` and is PER wasm INSTANCE (each of
// the two instances owns a separate cache), so the page total is at most 2N.
// Deliberately NOT split like the fetch cap: that budget is a page-wide browser
// resource, this one is per-instance working set and halving it would starve
// both caches. Absent / 0 / non-numeric → unbounded (pre-A15 behaviour).
//
// MUST be called before `init_resource_source` on the main thread; that call
// sizes this instance's cache.
export function applyShardBudget(g = globalThis) {
  let mb = 0;
  try {
    const raw = new URLSearchParams(g.location?.search || "").get("shardBudgetMB");
    const n = Number(raw);
    if (raw !== null && Number.isFinite(n) && n > 0) mb = n;
  } catch (_) {
    /* unbounded */
  }
  if (mb > 0) {
    g.__hbShardBudgetBytes = Math.floor(mb * 1024 * 1024);
  } else {
    // Leave the global unset so Rust takes the unbounded default.
    delete g.__hbShardBudgetBytes;
  }
  return { mb, bytes: g.__hbShardBudgetBytes ?? 0 };
}

// Surface-cache budget — S2 host plumbing (DESIGN-surface-budget-2026-07-25).
//
// `SURFACE_PIXEL_CACHE` (apps/holtburger-web/src/lib.rs) is a byte-budget LRU
// sized from the COMPILE-TIME `SURFACE_CACHE_BUDGET_BYTES` = 96 MiB. The page
// runs two wasm instances (main + bake worker), each with its own linear memory
// and therefore its OWN store, so the page holds 2 × 96 MiB ≈ 192 MiB of
// decoded pixels from hop 1 — both stores saturate and evict every session, so
// the constant is a BUDGET, not an observation of demand (design §1). This
// knob turns that constant into the DEFAULT of a host-supplied budget read at
// the store's `LazyLock` init (`configured_surface_budget_bytes()`), so an
// unauthored page is bit-for-bit unchanged.
//
// Grammar:  ?surfaceBudgetMB=N     both instances get N MB
//           ?surfaceBudgetMB=N:M   main gets N MB, the bake worker gets M MB
// The split is design §2 option (B): the roles are asymmetric. The worker
// carries the bulk statics/scenery/entity decode plus the composed (dyed)
// class, while the main thread's cross-call hits are largely suppressed by the
// never-evicted JS `MaterialCache` in front of it — so main plausibly needs
// only the intra-call walk window (`SURFACE_BATCH_SPLIT_CHUNK` = 16 DIDs).
// `:` survives `URLSearchParams` untouched, so this token has none of
// `?decodeAdmission`'s `+`→space footgun; a space is accepted anyway.
//
// Absent / garbage / <= 0 → both globals are DELETED and Rust keeps 96 MiB.
//
// MUST be called before `init_resource_source` on the main thread — really
// before the first surface decode, which that ordering guarantees. FOOTGUN:
// the budget is fixed at the `LazyLock` init and `surface_pixel_cache_clear_all()`
// clears entries WITHOUT resizing, so setting the global after boot is a
// silent no-op (same as `__hbShardBudgetBytes`).
const SURFACE_BUDGET_RE = /^(\d+(?:\.\d+)?)(?:[: ](\d+(?:\.\d+)?))?$/;

/** Parse one `surfaceBudgetMB` token. Returns null for absent/garbage (⇒ default). */
export function parseSurfaceBudgetSpec(raw) {
  if (raw === null || raw === undefined) return null;
  const m = SURFACE_BUDGET_RE.exec(String(raw).trim());
  if (!m) return null;
  const mainMB = Number(m[1]);
  if (!Number.isFinite(mainMB) || mainMB <= 0) return null;
  const wRaw = m[2] === undefined ? 0 : Number(m[2]);
  // A lone `N` means BOTH instances get N — unlike `?decodeAdmission`, whose
  // shorthand halves the main share. Here the asymmetry must be authored
  // explicitly: a silent halving would make `=48` mean 48+24, which reads as
  // a page total of 96 and is exactly the confusion this flag exists to end.
  const workerMB = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : mainMB;
  return { mainMB, workerMB };
}

/** Resolve `?surfaceBudgetMB=` into a spec or null. Pure; touches no globals. */
export function resolveSurfaceBudget(search = "") {
  try {
    return parseSurfaceBudgetSpec(new URLSearchParams(search || "").get("surfaceBudgetMB"));
  } catch (_) {
    return null; /* default */
  }
}

/**
 * Apply the resolved budget: `__hbSurfaceBudgetBytes` for THIS instance,
 * `__hbSurfaceBudgetBytesWorker` stashed for the worker's `init` message
 * (defect-4 pattern — `js_sys::global()` in a worker is the WORKER's global,
 * which the page never touched). Returns null when unauthored.
 */
export function applySurfaceBudget(g = globalThis) {
  let spec = null;
  try {
    spec = resolveSurfaceBudget(g.location?.search || "");
  } catch (_) {
    /* default */
  }
  if (!spec) {
    // Leave both globals unset so Rust takes SURFACE_CACHE_BUDGET_BYTES.
    delete g.__hbSurfaceBudgetBytes;
    delete g.__hbSurfaceBudgetBytesWorker;
    return null;
  }
  const toBytes = (mb) => Math.max(1, Math.floor(mb * 1024 * 1024));
  g.__hbSurfaceBudgetBytes = toBytes(spec.mainMB);
  g.__hbSurfaceBudgetBytesWorker = toBytes(spec.workerMB);
  return {
    mainMB: spec.mainMB,
    workerMB: spec.workerMB,
    mainBytes: g.__hbSurfaceBudgetBytes,
    workerBytes: g.__hbSurfaceBudgetBytesWorker,
  };
}

// A15 §2 (a) decode admission — S4 host-supplied bound (2026-07-25).
//
// The Rust decode gate (`apps/holtburger-web/src/decode_admission.rs`) ships
// UNBOUNDED; a host arms it per wasm INSTANCE through three globals read at the
// gate's `LazyLock` init (`configured_decode_admission()`):
//   __hbDecodeMaxJobs / __hbDecodeMaxBytes / __hbDecodeUrgentReserve
// `__hbDecodeMaxJobs` is the arming switch — absent ⇒ pre-S4 behaviour exactly.
//
// Spec grammar (one token):  <jobs>[x<MB>][+<urgentReserve>]     e.g. 4x192+2
//   jobs   concurrent decode leases (the hard guard)
//   MB     estimated live decode bytes (the shaping guard; omitted ⇒ count-only)
//   +res   slots reserved for the urgent lane, which the normal lane can never
//          consume (§2.3 — a single-lane gate re-creates the FIFO starvation
//          `prefetch_urgent` exists to fix). Clamped Rust-side to jobs-1.
//
// URL params, most specific wins:
//   ?decodeAdmissionMain=<spec>    this page's wasm instance
//   ?decodeAdmissionWorker=<spec>  the bake worker's instance
//   ?decodeAdmission=<spec>        shorthand: WORKER takes the spec verbatim,
//                                  MAIN takes half of each field (min 1 where
//                                  the field was non-zero).
// The asymmetry is §2.5: post-R-1 aliasSplit the worker carries the bulk
// mesh/surface load and the main thread the alias residue, so a 50/50 split
// starves the worker. `?decodeAdmission=4x192+2` therefore means worker 4x192+2,
// main 2x96+1 — the design's recommended arm, in one token.
//
// FOOTGUN, handled here: `URLSearchParams` decodes a literal `+` in a query
// string as a SPACE, so a hand-typed `?decodeAdmission=4x192+2` arrives as
// "4x192 2" and would silently lose the urgent reserve. The grammar therefore
// accepts either separator; `%2B` also works but nobody types that.
const DECODE_SPEC_RE = /^(\d+)(?:[xX](\d+(?:\.\d+)?))?(?:[+ ](\d+))?$/;

/** Parse one spec token. Returns null for absent/garbage (⇒ unbounded). */
export function parseDecodeAdmissionSpec(raw) {
  if (raw === null || raw === undefined) return null;
  const m = DECODE_SPEC_RE.exec(String(raw).trim());
  if (!m) return null;
  const jobs = Number(m[1]);
  if (!Number.isFinite(jobs) || jobs < 1) return null;
  const mb = m[2] === undefined ? 0 : Number(m[2]);
  const reserve = m[3] === undefined ? 0 : Number(m[3]);
  return {
    jobs: Math.floor(jobs),
    // 0 ⇒ leave __hbDecodeMaxBytes unset ⇒ Rust's usize::MAX (count-only bound).
    bytes: Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 0,
    reserve: Number.isFinite(reserve) && reserve > 0 ? Math.floor(reserve) : 0,
  };
}

/** Halve a spec for the main thread (shorthand form). */
function halveDecodeSpec(s) {
  if (!s) return null;
  const half = (v) => (v > 0 ? Math.max(1, Math.floor(v / 2)) : 0);
  return { jobs: Math.max(1, Math.floor(s.jobs / 2)), bytes: half(s.bytes), reserve: half(s.reserve) };
}

/**
 * Resolve the three params into `{main, worker}` specs (either may be null =
 * unbounded). Pure — takes the query string, touches no globals.
 */
export function resolveDecodeAdmission(search = "") {
  let both = null, main = null, worker = null;
  try {
    const p = new URLSearchParams(search || "");
    both = parseDecodeAdmissionSpec(p.get("decodeAdmission"));
    main = parseDecodeAdmissionSpec(p.get("decodeAdmissionMain"));
    worker = parseDecodeAdmissionSpec(p.get("decodeAdmissionWorker"));
  } catch (_) {
    /* unbounded */
  }
  return {
    main: main ?? halveDecodeSpec(both),
    worker: worker ?? both,
  };
}

// A15 §2.2 item 3 / S5 (2026-07-25) — wasm-memory PRESSURE hysteresis.
//
// Two more globals, read at the same `LazyLock` init, in MEGABYTES:
//   __hbDecodePressureT1MB / __hbDecodePressureT2MB
// Above T1 the instance's effective decode caps halve; above T2 they quarter
// (min 1). Absent ⇒ INERT — the Rust default is `u64::MAX` on both and the
// comparison is strictly `>`, so an unauthored page is bit-for-bit S4.
//
// The sampled signal is `WebAssembly.Memory.buffer.byteLength`, which only ever
// GROWS. It is therefore a high-water mark, NOT live occupancy, and the level
// only ever rises: once tripped the shrink is permanent. That is intended and
// honest for a monotone signal — what would be wrong is treating the sample as
// current usage, which would ratchet the gate shut on memory that has since
// been freed.
//
// Spec grammar (one token):  <t1MB>[:<t2MB>]     e.g. 1024:1536
// A lone `<t1MB>` arms only the halving step. The thresholds are PER INSTANCE
// but the same pair is given to both, because each wasm instance samples its
// OWN linear memory — one number means the same thing on either side of the
// worker boundary (unlike `?decodeAdmission`, whose caps are asymmetric).
//
// Separator note: `:` survives `URLSearchParams` untouched, so this token has
// none of `?decodeAdmission`'s `+`→space footgun; a space is accepted anyway
// for the same-shaped mistake.
const DECODE_PRESSURE_RE = /^(\d+(?:\.\d+)?)(?:[: ](\d+(?:\.\d+)?))?$/;

/** Parse one pressure token. Returns null for absent/garbage (⇒ inert). */
export function parseDecodePressureSpec(raw) {
  if (raw === null || raw === undefined) return null;
  const m = DECODE_PRESSURE_RE.exec(String(raw).trim());
  if (!m) return null;
  const t1MB = Number(m[1]);
  if (!Number.isFinite(t1MB) || t1MB <= 0) return null;
  const t2raw = m[2] === undefined ? 0 : Number(m[2]);
  // A lone T1 (or a T2 below T1) leaves the quarter step unarmed; Rust clamps
  // `t2 = max(t1, t2)` too, so a swapped pair degrades to one step either way.
  const t2MB = Number.isFinite(t2raw) && t2raw > t1MB ? t2raw : 0;
  return { t1MB, t2MB };
}

/** Resolve `?decodePressure=` into a spec or null. Pure; touches no globals. */
export function resolveDecodePressure(search = "") {
  try {
    return parseDecodePressureSpec(new URLSearchParams(search || "").get("decodePressure"));
  } catch (_) {
    return null; /* inert */
  }
}

/**
 * Apply the MAIN thread's spec to `g` and return both halves; the worker's is
 * forwarded in the `init` message (its `globalThis` is not the page's).
 * MUST run before `init_resource_source` — see the ordering note in lib.rs.
 *
 * S5: also applies `?decodePressure` (same pair to both instances) and stashes
 * it for the worker's `init`, so the single pre-init call site covers both.
 */
export function applyDecodeAdmission(g = globalThis) {
  const cfg = resolveDecodeAdmission(g.location?.search || "");
  const pressure = resolveDecodePressure(g.location?.search || "");
  if (pressure) {
    g.__hbDecodePressureT1MB = pressure.t1MB;
    if (pressure.t2MB > 0) g.__hbDecodePressureT2MB = pressure.t2MB;
    else delete g.__hbDecodePressureT2MB;
  } else {
    // Leave both unset so Rust keeps u64::MAX on each ⇒ inert.
    delete g.__hbDecodePressureT1MB;
    delete g.__hbDecodePressureT2MB;
  }
  g.__hbDecodePressureWorker = pressure || undefined;
  cfg.pressure = pressure;
  const s = cfg.main;
  if (s) {
    g.__hbDecodeMaxJobs = s.jobs;
    if (s.bytes > 0) g.__hbDecodeMaxBytes = s.bytes;
    else delete g.__hbDecodeMaxBytes;
    if (s.reserve > 0) g.__hbDecodeUrgentReserve = s.reserve;
    else delete g.__hbDecodeUrgentReserve;
  } else {
    // Leave every global unset so Rust takes the unbounded S1 default.
    delete g.__hbDecodeMaxJobs;
    delete g.__hbDecodeMaxBytes;
    delete g.__hbDecodeUrgentReserve;
  }
  g.__hbDecodeAdmissionWorker = cfg.worker || undefined;
  return cfg;
}

export function applyFetchConcurrencySplit(g = globalThis) {
  let total = DEFAULT_FETCH_CONCURRENCY;
  try {
    const authored = Number(g.__hbFetchConcurrencyTotal ?? g.__hbFetchConcurrency);
    if (Number.isFinite(authored) && authored >= 1) total = Math.floor(authored);
  } catch (_) {
    /* keep the default */
  }
  let workerActive = false;
  try {
    workerActive = urlFlagEnabled() && typeof Worker !== "undefined";
  } catch (_) {
    workerActive = false;
  }
  // At least 1 for the worker when active, and never starve the main thread.
  const worker = workerActive
    ? Math.min(Math.max(1, Math.round(total * WORKER_FETCH_SHARE_FRACTION)), total - 1)
    : 0;
  const main = total - worker;
  g.__hbFetchConcurrencyTotal = total;
  g.__hbFetchConcurrencyWorker = worker;
  g.__hbFetchConcurrency = main;
  return { total, main, worker };
}

// R-1 alias split (2026-07-09). `walk_setup_parts` (src/lib.rs) publishes
// texture-swapped surfaces under synthetic alias DIDs in a reserved slice of
// the 0x08 space (`TEX_SWAP_ALIAS_BASE + n`) — but the registry that resolves
// an alias back to (base Surface, override SurfaceTexture) is per-wasm-
// INSTANCE, and only the main thread's instance mints (the rig bake never
// runs in the worker). The worker's instance treats an alias as a real
// Surface DID, decodes empty, and negative-caches it → texture-swap armor /
// body retargets render the grey fallback (`?bakeWorker=0` was correct).
// Until the alias table is exported to the worker, alias DIDs are decoded on
// the MAIN-thread wasm and real DIDs keep the worker offload; results are
// stitched back in the caller's index order. Opt out with ?aliasSplit=0
// (also off/false) — that restores the pre-split routing (the bug arm, for
// A/B only). Mask/base mirror lib.rs `resolve_tex_swap_alias`.
const TEX_SWAP_ALIAS_BASE = 0x08f00000;
const TEX_SWAP_ALIAS_MASK = 0xfff00000;

function aliasSplitFlagEnabled() {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get("aliasSplit");
    return v !== "0" && v !== "off" && v !== "false";
  } catch (_) {
    return true;
  }
}

// Session 9 (1116 §4) — urgent-first dispatch queue. Pre-queue, every
// message posted to the worker immediately and the worker runs its async
// `onmessage` handlers CONCURRENTLY (nothing on either side queues), so
// under rapid teleports the current LB's surface decodes queued behind
// dozens of stale-town requests (s9 TN-cluster baseline: maxPending 123,
// fetchSurfacesPixels avgDepth 43.4 / avgMs 6.7s). The queue dispatches
// through three lanes with an in-flight cap:
//   lane 0 — `init` + urgent (`isNearPlayerLb`-tagged surface/mesh fetches;
//            the same signal that rides `msg.urgent` to the worker's wasm
//            fetch-semaphore bypass),
//   lane 1 — normal surface/mesh,
//   lane 2 — non-urgent entity-surface types + diagnostics.
// Session 10 (1117 §4): the entity-surface ABI gained a trailing urgent
// arg (wasm + worker + here), so a current-LB entity fetch tagged by the
// same `isNearPlayerLb` signal now promotes to lane 0 like surface/mesh.
// `?bakeQueue=off` (also 0/false) restores post-immediately; `?bakeQueueCap=N`
// tunes the cap. Observe via `__diag.bakeWorkerStats().queue`.
const DEFAULT_BAKE_QUEUE_CAP = 4;

function queueFlagEnabled() {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get("bakeQueue");
    return v !== "0" && v !== "off" && v !== "false";
  } catch (_) {
    return true;
  }
}

function queueCapFlag() {
  try {
    const v = parseInt(
      new URLSearchParams(globalThis.location?.search || "").get("bakeQueueCap") || "",
      10,
    );
    return Number.isFinite(v) && v >= 1 ? v : DEFAULT_BAKE_QUEUE_CAP;
  } catch (_) {
    return DEFAULT_BAKE_QUEUE_CAP;
  }
}

// A16 (2026-07-25) — per-SUBMISSION batch cap: `?bakeBatchMax=N`.
//
// WHY A SIZE CAP AND NOT ANOTHER CONCURRENCY CAP. Every stage of the decode
// pipeline already bounds how many things run AT ONCE — the wasm fetch
// semaphore (`concurrency.rs`), the S4 decode gate (`decode_admission.rs`),
// this file's `_queueCap`, and cells.js's `?pvsStreamQueue` in-flight target.
// Nothing bounds how BIG one submission is, and the batched wasm exports
// materialise their ENTIRE decoded output before returning:
//   - `fetch_surfaces_pixels` (src/lib.rs) fills `results: Vec<Option<
//     SurfacePixels>>` sized to the input. `SURFACE_BATCH_SPLIT_CHUNK = 16`
//     chunks only the walk + the decode lease (dropped per chunk) — `results`
//     keeps growing across chunks, so the decoded peak is invisible to the gate.
//   - `fetch_model_meshes` (src/lib.rs) takes ONE lease for the whole call,
//     sized by `estimate_record_bytes` (WIRE bytes, never `revise`d), and its
//     `out: Vec<ModelMesh>` holds every packed mesh — the in-code comment says
//     so: "the peak this bounds is the whole `out` vector".
// A concurrency gate therefore cannot shrink a single submission: one call is
// one lease no matter how tight the cap. That is the mechanical reason S4's
// battery found the tightest arm matching unbounded
// (`RESULTS-s4-battery-2026-07-25.md` finding 3) — and why the remaining lever
// is the batch SIZE, which only the submitter can change.
//
// Behaviour: with `?bakeBatchMax=N` a worker-routed surface / model-mesh
// request longer than N is split into ceil(len/N) SEQUENTIAL waves (await
// between them — concurrent waves would rebuild the very peak we are cutting),
// and the per-wave results are concatenated in input order. Absent / `off` /
// `0` / garbage ⇒ 0 ⇒ every request takes the pre-A16 single-call path with the
// caller's ORIGINAL argument object, i.e. bit-for-bit today's behaviour.
//
// Scope: the two worker-routed funnels every landblock bake goes through
// (`fetchSurfacesPixels`, `fetchModelMeshes`). It is INERT under
// `?bakeWorker=0` — that branch must keep returning the exact wasm export
// reference (see `modelMeshFetcher`'s contract). Entity-surface paths are
// per-entity/per-LB shaped and are deliberately left alone.
//
// The cap binds only at COLD BOOT in practice: a steady-state per-LB bake
// submits far fewer DIDs than any useful N, so the waves collapse to one call
// and the flag costs nothing once the world is warm.
const DEFAULT_BAKE_BATCH_MAX = 0; // 0 = uncapped (pre-A16)

/** Parse one `?bakeBatchMax=` token. Returns 0 for absent/off/garbage. */
export function parseBakeBatchMax(raw) {
  if (raw === null || raw === undefined) return DEFAULT_BAKE_BATCH_MAX;
  const s = String(raw).trim();
  if (s === "" || s === "off" || s === "false") return DEFAULT_BAKE_BATCH_MAX;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BAKE_BATCH_MAX;
  return Math.floor(n);
}

/** Resolve `?bakeBatchMax=` from a query string. Pure; touches no globals. */
export function resolveBakeBatchMax(search = "") {
  try {
    return parseBakeBatchMax(new URLSearchParams(search || "").get("bakeBatchMax"));
  } catch (_) {
    return DEFAULT_BAKE_BATCH_MAX;
  }
}

/**
 * Split `len` items into contiguous `[lo, hi)` wave ranges of at most `cap`.
 * `cap <= 0` (or `len <= cap`) degrades to ONE whole-batch range, which is what
 * keeps the unauthored page on the original single-call path. Mirrors the Rust
 * `batch_split_ranges` (src/lib.rs) shape so the two split notions read alike.
 * Exported for the unit suite.
 */
export function splitBatchWaves(len, cap) {
  if (len <= 0) return [];
  if (!Number.isFinite(cap) || cap <= 0 || len <= cap) return [[0, len]];
  const out = [];
  for (let start = 0; start < len; start += cap) {
    out.push([start, Math.min(start + cap, len)]);
  }
  return out;
}

/** Dispatch lane for a worker message. Exported for the unit suite. */
export function laneForBakeMessage(type, body) {
  if (type === "init") return 0;
  if (body && body.urgent === true) return 0;
  if (type === "fetchModelMeshes" || type === "fetchSurfacesPixels") return 1;
  return 2;
}

function isTexSwapAlias(did) {
  return ((did & TEX_SWAP_ALIAS_MASK) >>> 0) === TEX_SWAP_ALIAS_BASE;
}

function countTexSwapAliases(dids) {
  let n = 0;
  for (const d of dids || []) if (isTexSwapAlias(d >>> 0)) n += 1;
  return n;
}

/**
 * Partition a DID list into worker-decodable (real) and main-thread-only
 * (tex-swap alias) index sets. Order-preserving: `arr[realIdx[k]]` /
 * `arr[aliasIdx[k]]` map leg-result slot `k` back to its input position
 * for the stitch. Exported for the harness gate (test_p1_alias_split.mjs).
 */
export function partitionTexSwapAliasDids(dids) {
  const arr = Array.from(dids, (d) => d >>> 0);
  const aliasIdx = [];
  const realIdx = [];
  for (let i = 0; i < arr.length; i += 1) {
    (isTexSwapAlias(arr[i]) ? aliasIdx : realIdx).push(i);
  }
  return { arr, aliasIdx, realIdx };
}

export class BakeWorkerClient {
  constructor() {
    this.enabled = false;
    this.aliasSplit = true;
    this.manifestUrl = null;
    this.sceneryBaseUrl = null;
    this._worker = null;
    this._readyPromise = null;
    this._seq = 1;
    this._pending = new Map();
    // Session 9 (1116 §4) — urgent-first dispatch queue (see laneForBakeMessage).
    this._queueEnabled = queueFlagEnabled();
    this._queueCap = queueCapFlag();
    this._lanes = [[], [], []];
    this._inFlightPosted = 0;
    // A16 (2026-07-25) — `?bakeBatchMax=N`; 0 = uncapped (pre-A16 behaviour).
    this.batchMax = DEFAULT_BAKE_BATCH_MAX;
  }

  /**
   * @param {{enabled?:boolean, manifestUrl?:string, sceneryBaseUrl?:string, aliasSplit?:boolean, batchMax?:number}} [opts]
   */
  configure(opts = {}) {
    this.enabled = typeof opts.enabled === "boolean" ? opts.enabled : urlFlagEnabled();
    this.aliasSplit =
      typeof opts.aliasSplit === "boolean" ? opts.aliasSplit : aliasSplitFlagEnabled();
    this.batchMax =
      typeof opts.batchMax === "number"
        ? parseBakeBatchMax(opts.batchMax)
        : resolveBakeBatchMax(globalThis.location?.search || "");
    if (opts.manifestUrl != null) this.manifestUrl = opts.manifestUrl;
    if (opts.sceneryBaseUrl != null) this.sceneryBaseUrl = opts.sceneryBaseUrl;
    return this;
  }

  /** Active = caller opted in AND Web Workers exist in this environment. */
  get active() {
    return this.enabled && typeof Worker !== "undefined";
  }

  _ensureWorker() {
    if (this._readyPromise) return this._readyPromise;
    this._worker = new Worker(new URL("./bake_worker.js", import.meta.url), {
      type: "module",
    });
    this._worker.onmessage = (ev) => this._onMessage(ev.data);
    this._worker.onerror = (e) =>
      this._failAll(new Error("bake worker crashed: " + ((e && e.message) || e)));
    // Absolutize URLs against the PAGE: the worker resolves relative URLs
    // against its own script location (scene3d/), not index.html, so a raw
    // "../../dist/manifest.json" would fetch the wrong path inside the worker.
    const abs = (u) => {
      try {
        return u ? new URL(u, globalThis.location?.href).href : u;
      } catch (_) {
        return u;
      }
    };
    // EXPERIMENT (threads-lite, 2026-07-24): hand the worker THIS instance's
    // compiled module + shared memory so it initialises into the same linear
    // memory instead of minting a second one. Set by index.html only under
    // `?sharedWasm=on`; absent -> unchanged two-instance path.
    const shared = globalThis.__hbSharedWasm || null;
    // Host-flag plumbing (defects 1/3/4, 2026-07-24). A worker has no `window`
    // and its `globalThis` is NOT the page's, so three things the page controls
    // never reached the worker's wasm: the URL query string (Rust
    // `js_location_search()` returned ""), `__hbVerifyShards` and
    // `__hbFetchConcurrency` (both read via `js_sys::global()`). All three ride
    // the init message and are applied in `handleInit` BEFORE any flag-gated
    // work. BEHAVIOUR CHANGE: the worker now honours Rust-side URL flags
    // (e.g. `?surfaceCache=off`) that it silently ignored before.
    const locationSearch = (() => {
      try {
        return globalThis.location?.search || "";
      } catch (_) {
        return "";
      }
    })();
    this._readyPromise = this._request("init", {
      manifestUrl: abs(this.manifestUrl),
      sceneryBaseUrl: abs(this.sceneryBaseUrl),
      sharedModule: shared?.module ?? null,
      sharedMemory: shared?.memory ?? null,
      locationSearch,
      // `undefined` → leave the worker global unset → Rust default (verify ON).
      verifyShards: globalThis.__hbVerifyShards,
      fetchConcurrency: globalThis.__hbFetchConcurrencyWorker,
      // A15 §1: the worker's own `globalThis` is not the page's, so its shard
      // cache would stay unbounded while the main thread's was capped. Same
      // per-instance value (see applyShardBudget); `undefined` → unbounded.
      shardBudgetBytes: globalThis.__hbShardBudgetBytes,
      // Surface-budget S2: the WORKER's half of `?surfaceBudgetMB=N:M` (a lone
      // `N` gives both instances N). Same defect-4 reason as the shard budget —
      // the worker's `globalThis` is not the page's, so its surface store would
      // keep the 96 MiB default while the main thread's was capped.
      // `undefined` → the worker leaves its global unset → Rust's 96 MiB.
      surfaceBudgetBytes: globalThis.__hbSurfaceBudgetBytesWorker,
      // A15 §2.5 (S4): the WORKER's own decode-admission spec — deliberately
      // the larger half (it carries the bulk mesh/surface load). `undefined`
      // → the worker leaves its globals unset → Rust's unbounded default.
      decodeAdmission: globalThis.__hbDecodeAdmissionWorker,
      // A15 §2.2 item 3 (S5): the same pressure thresholds — each instance
      // samples its OWN linear memory, so one pair means the same thing on
      // both sides. `undefined` → the worker leaves its globals unset → inert.
      decodePressure: globalThis.__hbDecodePressureWorker,
    });
    return this._readyPromise;
  }

  _request(type, body) {
    const id = this._seq++;
    // Session 7 (1114 §3) — per-request latency + backlog depth, aggregated
    // by message type. `_pending` holds queued AND posted requests, so the
    // depth at enqueue time IS the JS-visible backlog the teleport
    // investigation needs to see (dispatch-queue wait + in-worker decode).
    // O(1) per request; read via window.__diag.bakeWorkerStats().
    const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
    const depth = this._pending.size;
    const done = (ok) => {
      try {
        const s = this._stats || (this._stats = { byType: {}, maxPending: 0 });
        const b = s.byType[type] || (s.byType[type] = {
          count: 0, failed: 0, totalMs: 0, maxMs: 0, totalDepth: 0, maxDepth: 0,
        });
        const dt = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0;
        b.count += 1;
        if (!ok) b.failed += 1;
        b.totalMs += dt;
        if (dt > b.maxMs) b.maxMs = dt;
        b.totalDepth += depth;
        if (depth > b.maxDepth) b.maxDepth = depth;
        if (depth > s.maxPending) s.maxPending = depth;
      } catch (_) { /* stats must never affect the request */ }
    };
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve: (v) => { done(true); resolve(v); },
        reject: (e) => { done(false); reject(e); },
      });
      // Session 9 (1116 §4) — urgent-first dispatch. `?bakeQueue=off`
      // restores the pre-queue post-immediately behavior (the s8 arm).
      if (!this._queueEnabled) {
        this._worker.postMessage({ type, id, ...body });
        return;
      }
      const lane = laneForBakeMessage(type, body);
      this._lanes[lane].push({ type, id, body, lane, tq: t0 });
      this._noteQueueLen();
      this._pump();
    });
  }

  /** Post queued messages urgent-lane-first while under the in-flight cap. */
  _pump() {
    while (this._worker && this._inFlightPosted < this._queueCap) {
      const entry =
        this._lanes[0].shift() ?? this._lanes[1].shift() ?? this._lanes[2].shift();
      if (!entry) return;
      this._inFlightPosted += 1;
      try {
        const q = this._stats?.queue;
        if (q) {
          const nowMs =
            (typeof performance !== "undefined") ? performance.now() : Date.now();
          const qMs = nowMs - entry.tq;
          const b = q.byLane[entry.lane];
          q.posted += 1;
          b.count += 1;
          b.totalQueueMs += qMs;
          if (qMs > b.maxQueueMs) b.maxQueueMs = qMs;
        }
      } catch (_) { /* stats must never affect dispatch */ }
      this._worker.postMessage({ type: entry.type, id: entry.id, ...entry.body });
    }
  }

  _noteQueueLen() {
    try {
      const s = this._stats || (this._stats = { byType: {}, maxPending: 0 });
      const q = s.queue || (s.queue = {
        posted: 0,
        maxQueuedLen: 0,
        byLane: [0, 1, 2].map(() => ({ count: 0, totalQueueMs: 0, maxQueueMs: 0 })),
      });
      const len = this._lanes[0].length + this._lanes[1].length + this._lanes[2].length;
      if (len > q.maxQueuedLen) q.maxQueuedLen = len;
    } catch (_) { /* stats must never affect dispatch */ }
  }

  _onMessage(msg) {
    const entry = this._pending.get(msg && msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    if (this._queueEnabled) {
      this._inFlightPosted = Math.max(0, this._inFlightPosted - 1);
      this._pump();
    }
    if (msg.type === "ready") return entry.resolve(true);
    if (msg.type === "error") return entry.reject(new Error(msg.message));
    if (msg.type === "result") return entry.resolve(msg);
    entry.reject(new Error("bake worker: unknown reply " + msg.type));
  }

  _failAll(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
    // Queued-but-unposted entries were rejected via `_pending` above; drop
    // their lane records and the posted counter so a respawn starts clean.
    this._lanes = [[], [], []];
    this._inFlightPosted = 0;
    // Drop the dead worker so a later call can respawn.
    this._worker = null;
    this._readyPromise = null;
  }

  /**
   * Join the two legs of an alias-split request back into the caller's
   * index order. The result is a MIXED array — plain reconstructed objects
   * (worker leg) and wasm-bindgen `SurfacePixels` handles (main leg). That
   * is contract-safe: every consumer reads the fields as properties and
   * guards `.free()` per element (`typeof sp.free === "function"`). If
   * either leg fails, frees whatever main-leg handles did land and
   * rethrows so the caller's existing catch runs the whole-request
   * main-thread fallback (unchanged pre-split semantics).
   */
  async _stitchSplit(split, workerPromise, mainPromise) {
    const [workerRes, mainRes] = await Promise.allSettled([workerPromise, mainPromise]);
    if (workerRes.status === "rejected" || mainRes.status === "rejected") {
      if (mainRes.status === "fulfilled") {
        for (const sp of mainRes.value || []) {
          try {
            if (sp && typeof sp.free === "function") sp.free();
          } catch (_) {}
        }
      }
      throw workerRes.status === "rejected" ? workerRes.reason : mainRes.reason;
    }
    const out = new Array(split.arr.length).fill(null);
    for (let k = 0; k < split.realIdx.length; k += 1) {
      out[split.realIdx[k]] = workerRes.value[k] ?? null;
    }
    for (let k = 0; k < split.aliasIdx.length; k += 1) {
      out[split.aliasIdx[k]] = mainRes.value[k] ?? null;
    }
    // P2↔P3 ABI: merge the call-level decode audits from the two legs onto
    // the stitched result. A leg without the fields (legacy wasm)
    // contributes nothing; when BOTH legs lack them the stitched result
    // stays legacy-shaped and the materials.js readers never poison.
    const wAudit = extractSurfaceAudit(workerRes.value);
    const mAudit = extractSurfaceAudit(mainRes.value);
    if (wAudit || mAudit) {
      const audit = {};
      if (
        typeof wAudit?.decodeMisses === "number" ||
        typeof mAudit?.decodeMisses === "number"
      ) {
        audit.decodeMisses = (wAudit?.decodeMisses ?? 0) + (mAudit?.decodeMisses ?? 0);
      }
      if (Array.isArray(wAudit?.provenAbsent) || Array.isArray(mAudit?.provenAbsent)) {
        audit.provenAbsent = [
          ...new Set([...(wAudit?.provenAbsent ?? []), ...(mAudit?.provenAbsent ?? [])]),
        ];
      }
      applySurfaceAudit(out, audit);
    }
    return out;
  }

  /**
   * Model meshes off-thread. Returns objects with the SAME field surface a
   * wasm `ModelMesh` exposes (drop-in for `meshToGeometryGroups`). Falls
   * back to the direct main-thread wasm call on inactive / error.
   *
   * streamFix urgent lane (2026-07-02): optional `urgent` rides through to
   * the worker's wasm `fetch_model_meshes(ids, urgent)` (and the main-thread
   * fallback) so a current-LB bake bypasses the fetch semaphore in WHICHEVER
   * wasm instance does the decode. `undefined` = pre-fix normal lane.
   */
  async fetchModelMeshes(wasmExports, ids, urgent) {
    if (!this.active) return wasmExports.fetch_model_meshes(ids, urgent);
    // A16: split an oversized submission into sequential waves. `splitBatchWaves`
    // returns a single whole-batch range whenever the cap is unset or unreached,
    // and that range takes the `ids` object through UNTOUCHED.
    const arr = this.batchMax > 0 ? Array.from(ids, (v) => v >>> 0) : null;
    const waves = arr ? splitBatchWaves(arr.length, this.batchMax) : null;
    if (waves && waves.length > 1) {
      const out = [];
      for (const [lo, hi] of waves) {
        const part = await this._fetchModelMeshesOnce(
          wasmExports,
          Uint32Array.from(arr.slice(lo, hi)),
          urgent,
        );
        for (const m of part) out.push(m);
      }
      return out;
    }
    return this._fetchModelMeshesOnce(wasmExports, ids, urgent);
  }

  /** One worker round-trip for model meshes (the pre-A16 body). */
  async _fetchModelMeshesOnce(wasmExports, ids, urgent) {
    try {
      await this._ensureWorker();
      const res = await this._request("fetchModelMeshes", {
        ids: Array.from(ids),
        urgent: urgent === true,
      });
      return reconstructModelMeshes(res.payload);
    } catch (e) {
      console.warn("[bake_worker_client] model-mesh worker failed; main-thread fallback:", e);
      return wasmExports.fetch_model_meshes(ids, urgent);
    }
  }

  /** Surface pixels off-thread. Drop-in for the surface consumers. */
  async fetchSurfacesPixels(wasmExports, dids, urgent) {
    if (!this.active) return wasmExports.fetch_surfaces_pixels(dids, urgent);
    // A16: sequential waves when `?bakeBatchMax=N` is armed and exceeded. The
    // per-wave results concatenate in input order (every consumer binds by
    // index into the DID list it passed), and the CALL-LEVEL decode audit is
    // merged the same way `_stitchSplit` merges the two alias legs: misses sum,
    // provenAbsent unions. A single wave (the unarmed case) passes `dids`
    // through untouched.
    const arr = this.batchMax > 0 ? Array.from(dids, (d) => d >>> 0) : null;
    const waves = arr ? splitBatchWaves(arr.length, this.batchMax) : null;
    if (waves && waves.length > 1) {
      const out = [];
      let misses;
      let absent = null;
      for (const [lo, hi] of waves) {
        const part = await this._fetchSurfacesPixelsOnce(
          wasmExports,
          Uint32Array.from(arr.slice(lo, hi)),
          urgent,
        );
        const a = extractSurfaceAudit(part);
        if (a) {
          if (typeof a.decodeMisses === "number") misses = (misses ?? 0) + a.decodeMisses;
          if (Array.isArray(a.provenAbsent)) {
            absent = absent ? [...absent, ...a.provenAbsent] : [...a.provenAbsent];
          }
        }
        for (const sp of part) out.push(sp);
      }
      if (misses !== undefined || absent) {
        applySurfaceAudit(out, {
          ...(misses !== undefined ? { decodeMisses: misses } : {}),
          ...(absent ? { provenAbsent: [...new Set(absent)] } : {}),
        });
      }
      return out;
    }
    return this._fetchSurfacesPixelsOnce(wasmExports, dids, urgent);
  }

  /** One worker round-trip for surface pixels (the pre-A16 body). */
  async _fetchSurfacesPixelsOnce(wasmExports, dids, urgent) {
    try {
      await this._ensureWorker();
      // R-1 alias split: statics/cells/buildings never carry aliases (no
      // wire texture changes), so this only fires on the non-dyed ENTITY
      // preload path (entities.js → materialCache.preload).
      const split = this.aliasSplit ? partitionTexSwapAliasDids(dids) : null;
      if (split && split.aliasIdx.length > 0) {
        console.info(
          `[bake_worker_client] alias split (surfaces): ${split.aliasIdx.length} alias DID(s) → main wasm, ${split.realIdx.length} real → worker`,
        );
        const workerPromise = split.realIdx.length
          ? this._request("fetchSurfacesPixels", {
              dids: split.realIdx.map((i) => split.arr[i]),
              urgent: urgent === true,
            }).then((res) =>
              applySurfaceAudit(reconstructSurfacePixelsBatch(res.payload), res.audit),
            )
          : Promise.resolve([]);
        // Main-thread wasm owns the alias registry — identical decode to
        // the known-correct ?bakeWorker=0 arm for exactly these DIDs.
        const mainPromise = wasmExports.fetch_surfaces_pixels(
          Uint32Array.from(split.aliasIdx, (i) => split.arr[i]),
          urgent,
        );
        return await this._stitchSplit(split, workerPromise, mainPromise);
      }
      const res = await this._request("fetchSurfacesPixels", {
        dids: Array.from(dids),
        urgent: urgent === true,
      });
      return applySurfaceAudit(reconstructSurfacePixelsBatch(res.payload), res.audit);
    } catch (e) {
      console.warn("[bake_worker_client] surface worker failed; main-thread fallback:", e);
      return wasmExports.fetch_surfaces_pixels(dids, urgent);
    }
  }

  /**
   * Entity (dyed/paletted) surface pixels off-thread. Returns a plain
   * `Array<SurfacePixels-like>` — drop-in for the `fetchEntitySurfacesPixels`
   * consumers in `entities.js` (they read `.width/.pixels/.translucency/…`
   * and guard `.free()`). Falls back to the direct main-thread wasm call.
   *
   * decode-priority (2026-07-10): optional `urgent` rides through to the
   * worker's wasm (and both fallbacks) exactly like fetchSurfacesPixels —
   * lane-0 dispatch here, fetch-semaphore bypass in whichever wasm decodes.
   */
  async fetchEntitySurfacesPixels(wasmExports, dids, paletteId, subPalettes, urgent) {
    if (!this.active) {
      return wasmExports.fetchEntitySurfacesPixels(dids, paletteId, subPalettes, urgent);
    }
    try {
      await this._ensureWorker();
      // R-1 alias split. Both legs carry the SAME (paletteId, subPalettes):
      // the wasm decodes per-DID with the entity's palette state applied
      // uniformly (`fetch_entity_surfaces_pixels` doc), so a split call is
      // result-identical to the single call, per DID.
      const split = this.aliasSplit ? partitionTexSwapAliasDids(dids) : null;
      if (split && split.aliasIdx.length > 0) {
        console.info(
          `[bake_worker_client] alias split (entity-surfaces): ${split.aliasIdx.length} alias DID(s) → main wasm, ${split.realIdx.length} real → worker`,
        );
        const workerPromise = split.realIdx.length
          ? this._request("fetchEntitySurfacesPixels", {
              dids: split.realIdx.map((i) => split.arr[i]),
              paletteId: paletteId >>> 0,
              subPalettes: Array.from(subPalettes || []),
              urgent: urgent === true,
            }).then((res) =>
              applySurfaceAudit(reconstructSurfacePixelsBatch(res.payload), res.audit),
            )
          : Promise.resolve([]);
        const mainPromise = wasmExports.fetchEntitySurfacesPixels(
          Uint32Array.from(split.aliasIdx, (i) => split.arr[i]),
          paletteId,
          subPalettes,
          urgent,
        );
        return await this._stitchSplit(split, workerPromise, mainPromise);
      }
      const res = await this._request("fetchEntitySurfacesPixels", {
        dids: Array.from(dids),
        paletteId: paletteId >>> 0,
        subPalettes: Array.from(subPalettes || []),
        urgent: urgent === true,
      });
      return applySurfaceAudit(reconstructSurfacePixelsBatch(res.payload), res.audit);
    } catch (e) {
      console.warn(
        "[bake_worker_client] entity-surface worker failed; main-thread fallback:",
        e,
      );
      return wasmExports.fetchEntitySurfacesPixels(dids, paletteId, subPalettes, urgent);
    }
  }

  /**
   * F.41 batched entity surfaces off-thread. Returns a drop-in for the wasm
   * `EntitySurfacesPixelsBatch` handle (`len` / `payloadAt(i)` single-shot /
   * `wasDrained(i)` / `free()`) so `materials.js::preloadBatch` is unchanged.
   * Falls back to the direct main-thread wasm call.
   */
  async fetchEntitySurfacesPixelsBatch(
    wasmExports,
    flatDids,
    lens,
    basePals,
    flatSubs,
    tripleCounts,
    urgent,
  ) {
    if (!this.active) {
      return wasmExports.fetchEntitySurfacesPixelsBatch(
        flatDids,
        lens,
        basePals,
        flatSubs,
        tripleCounts,
        urgent,
      );
    }
    try {
      await this._ensureWorker();
      // R-1 alias split. The flat/lens group encoding makes a per-DID
      // stitch disproportionate here, and today's only batch caller (the
      // F.41 spawn pre-warm, spawns.js) derives its DIDs from setups with
      // no wire texture changes — aliases are unexpected. If one does
      // appear, route the WHOLE batch to the main-thread wasm (the only
      // instance that can resolve it); correctness over offload.
      const nAlias = this.aliasSplit ? countTexSwapAliases(flatDids) : 0;
      if (nAlias > 0) {
        console.info(
          `[bake_worker_client] alias split (entity-surface-batch): ${nAlias} alias DID(s) in batch → whole batch on main wasm`,
        );
        return wasmExports.fetchEntitySurfacesPixelsBatch(
          flatDids,
          lens,
          basePals,
          flatSubs,
          tripleCounts,
          urgent,
        );
      }
      const res = await this._request("fetchEntitySurfacesPixelsBatch", {
        flatDids: Array.from(flatDids),
        lens: Array.from(lens),
        basePals: Array.from(basePals),
        flatSubs: Array.from(flatSubs || []),
        tripleCounts: Array.from(tripleCounts || []),
        urgent: urgent === true,
      });
      return applySurfaceAudit(reconstructEntitySurfacesBatch(res.payload), res.audit);
    } catch (e) {
      console.warn(
        "[bake_worker_client] entity-surface-batch worker failed; main-thread fallback:",
        e,
      );
      return wasmExports.fetchEntitySurfacesPixelsBatch(
        flatDids,
        lens,
        basePals,
        flatSubs,
        tripleCounts,
        urgent,
      );
    }
  }

  /**
   * A07 §3.6 — fetch the WORKER wasm instance's `dat_decode_diag()` JSON
   * (decode-failure counters + negative-cache contents; otherwise invisible
   * from the main thread). Returns the raw JSON string, or null when the
   * worker is inactive / not yet ready / stale-pkg (never throws — this is
   * a diagnostic, not a dependency).
   */
  async datDecodeDiag() {
    if (!this.active || !this._worker) return null;
    try {
      await this._ensureWorker();
      const res = await this._request("datDecodeDiag", {});
      return res.payload ?? null;
    } catch (_) {
      return null;
    }
  }

  terminate() {
    if (this._worker) this._worker.terminate();
    this._failAll(new Error("bake worker terminated"));
  }
}

let _singleton = null;
/** Lazily-created process singleton (default disabled until configured). */
export function getBakeWorkerClient() {
  if (!_singleton) {
    _singleton = new BakeWorkerClient().configure({});
    // Diag global: monotone request counter (battery "streamed-work"
    // column — settle-stability alone can't tell a settled page from a
    // streaming-starved one; see battery-findings-2026-07-10.md §5).
    try {
      if (typeof window !== "undefined") {
        window.__bakeWorkerSeq = () => (_singleton ? _singleton._seq : 0);
        // Session 7 (1114 §3) — request latency/queue-depth aggregates
        // (avgMs/avgDepth derived at read time). Pairs with
        // __diag.bakeWait(): guard-level pre-admission waits there,
        // worker-FIFO + decode time here.
        if (!window.__diag) window.__diag = {};
        window.__diag.bakeWorkerStats = () => {
          const s = _singleton?._stats;
          const lanes = _singleton?._lanes || [[], [], []];
          const queue = {
            enabled: _singleton?._queueEnabled === true,
            cap: _singleton?._queueCap ?? null,
            queuedNow: lanes[0].length + lanes[1].length + lanes[2].length,
            inFlightPosted: _singleton?._inFlightPosted ?? 0,
            posted: s?.queue?.posted ?? 0,
            maxQueuedLen: s?.queue?.maxQueuedLen ?? 0,
            byLane: (s?.queue?.byLane ?? []).map((b) => ({
              count: b.count,
              avgQueueMs: b.count ? Math.round(b.totalQueueMs / b.count) : 0,
              maxQueueMs: Math.round(b.maxQueueMs),
            })),
          };
          const batchMax = _singleton?.batchMax ?? 0;
          if (!s) return { active: !!_singleton?.active, batchMax, byType: {}, maxPending: 0, queue };
          const byType = {};
          for (const [type, b] of Object.entries(s.byType)) {
            byType[type] = {
              count: b.count,
              failed: b.failed,
              avgMs: b.count ? Math.round(b.totalMs / b.count) : 0,
              maxMs: Math.round(b.maxMs),
              avgDepth: b.count ? Math.round((b.totalDepth / b.count) * 10) / 10 : 0,
              maxDepth: b.maxDepth,
              // Session 9 (1116 §4) — raw accumulators so a capture can diff
              // two snapshots into a per-window mean (avgMs/avgDepth alone
              // can't be windowed; count-deltas + total-deltas can).
              totalMs: Math.round(b.totalMs),
              totalDepth: b.totalDepth,
            };
          }
          return { active: !!_singleton?.active, batchMax, pendingNow: _singleton?._pending?.size ?? 0, maxPending: s.maxPending, byType, queue };
        };
      }
    } catch (_) {}
  }
  return _singleton;
}
/** Configure (and enable) the singleton — call once during boot. */
export function configureBakeWorker(opts) {
  return getBakeWorkerClient().configure(opts);
}

/**
 * Fetcher to hand to `statics.js` helpers in place of
 * `wasmExports.fetch_model_meshes`. When the worker is INACTIVE this is the
 * EXACT same function reference (byte-identical to pre-M2); when active it
 * routes through the worker (with main-thread fallback on error).
 */
export function modelMeshFetcher(wasmExports) {
  const client = getBakeWorkerClient();
  // streamFix (2026-07-02): both branches accept an optional trailing
  // `urgent` — the raw wasm export takes it natively (`Option<bool>`), the
  // worker route forwards it in the message body.
  if (!client.active) return wasmExports.fetch_model_meshes;
  return (ids, urgent) => client.fetchModelMeshes(wasmExports, ids, urgent);
}

/** Same contract for the surface-pixels decoder. */
export function surfacePixelsFetcher(wasmExports) {
  const client = getBakeWorkerClient();
  if (!client.active) return wasmExports.fetch_surfaces_pixels;
  return (dids, urgent) => client.fetchSurfacesPixels(wasmExports, dids, urgent);
}

/**
 * Same contract for the single-call entity (dyed) surface decoder. Returns
 * the EXACT `wasmExports.fetchEntitySurfacesPixels` reference when the
 * worker is inactive (byte-identical to pre-offload), OR when the wasm
 * bundle predates the export (so callers' `typeof … === "function"` guards
 * still gate correctly). When active, routes through the worker.
 */
export function entitySurfacePixelsFetcher(wasmExports) {
  if (typeof wasmExports.fetchEntitySurfacesPixels !== "function") {
    return wasmExports.fetchEntitySurfacesPixels;
  }
  const client = getBakeWorkerClient();
  // decode-priority (2026-07-10): both branches accept an optional trailing
  // `urgent`, same as modelMeshFetcher — the raw wasm export takes it
  // natively (`Option<bool>`), the worker route forwards it in the body.
  if (!client.active) return wasmExports.fetchEntitySurfacesPixels;
  return (dids, paletteId, subPalettes, urgent) =>
    client.fetchEntitySurfacesPixels(wasmExports, dids, paletteId, subPalettes, urgent);
}

/** Same contract for the F.41 batched entity-surface decoder. */
export function entitySurfacesBatchFetcher(wasmExports) {
  if (typeof wasmExports.fetchEntitySurfacesPixelsBatch !== "function") {
    return wasmExports.fetchEntitySurfacesPixelsBatch;
  }
  const client = getBakeWorkerClient();
  if (!client.active) return wasmExports.fetchEntitySurfacesPixelsBatch;
  return (flatDids, lens, basePals, flatSubs, tripleCounts, urgent) =>
    client.fetchEntitySurfacesPixelsBatch(
      wasmExports,
      flatDids,
      lens,
      basePals,
      flatSubs,
      tripleCounts,
      urgent,
    );
}
