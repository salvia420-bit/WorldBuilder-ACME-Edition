// scene3d/shard_fetch_client.js — Workstream B (`?shardFetchWorker`, default ON,
// 2026-10-09): the page half of the shard-fetch worker.
//
// The main wasm instance fetched every DAT shard with `fetch()` + `arrayBuffer()`
// on the main thread — two main-thread turns per record, each waiting behind a
// 90-97 % busy main thread during a cold load (1070 academy, final build: the
// network took p50 0.19-0.24 s, delivery to wasm AFTER the network finished took
// p50 0.09-0.32 s / p90 0.35-0.56 s). index.html registers `fetchShard` below as
// the wasm instance's shard fetcher (`register_shard_fetcher`, MAIN instance
// only, right after `init_resource_source`); the Rust side (Step D of
// `ManifestResourceSource::prefetch_impl`) then calls
//     fetchShard(url, "low" | "auto", expectedShaHex | null)
// inside its unchanged dedup / permit / priority / tolerant-round machinery.
//
// Here: every call made in one turn is coalesced (one microtask) into ONE
// {type:'batch'} message to scene3d/shard_fetch_worker.js, which fetches,
// reads and verifies off the main thread and answers in batches of transferred
// ArrayBuffers (64 entries / 4 MB / 8 ms). Each id resolves to
//   - `{ verified: true, bytes }` when the worker hashed the body and it matches
//     the catalog hash (the wasm Step E then skips its main-thread re-hash), or
//   - a plain `Uint8Array` (no hash asked, or a MISMATCH — the wasm Step E
//     re-hashes and fails that key exactly as before),
// and rejects with `{ status, statusText }` for an HTTP error (so the wasm
// side's 404 tolerance still sees the status) or an `Error` for a network /
// body failure (→ `HttpError::Network`).
//
// FAILURE = DIRECT FETCH: a worker `error` / `messageerror`, a failed post, or a
// silent worker (no message for 15 s before its first, 30 s after, while
// requests are pending) rejects every pending request, terminates the worker
// and calls `register_shard_fetcher(null)`; the wasm walk's retries (3 tries per
// round) then fetch directly for the rest of the session.
//
// PRIORITY (`?shardFetchHigh`, default ON, 2026-10-09 follow-up): the wasm's
// urgent lane calls with "auto" (= no `priority` member: a document's fetch()
// gets High by default in Chrome). Chrome's default for a fetch from a
// DEDICATED WORKER is not guaranteed to be that High, so the client forwards the
// urgent lane as "high" and the worker sends `{priority:"high"}`; "low" stays
// `{priority:"low"}`. `shardFetchHigh=off|0|false|no` forwards "auto" (the worker
// sends no init: the pre-follow-up request, byte for byte).
//
// HASH SLICING (`?shardHashSlice`, default ON, 2026-10-09 follow-up): read here
// once (installShardFetchWorker) and forwarded as `hashSlice` on every batch
// message; the worker's pure-JS sha256 then hashes bodies over 64 KB one 64 KB
// slice per event-loop turn (see shard_fetch_worker.js). `off|0|false|no` =
// the worker's one-shot hash. The worker's slice stats arrive as `hash` on each
// results message -> `__diag.shardFetch().workerHash`.
//
// Diag: `window.__diag.shardFetch()` / `window.__shardFetchStats()` (both arms).
// `academy.mjs --fetchmap`: when `globalThis.__fetchMap` exists, every shard
// request gets a page-clock row {c: call, r: worker headers-in-hand, h: worker
// netEnd (both worker clock mapped through the two timeOrigins), b: body handed
// to wasm}, keyed like the page
// patch (`url.slice(url.indexOf("/shards/"))`). The worker's own resource
// timing (academy.mjs `net.workers`) carries the network side.

export const SHARD_FETCH_STALL_MS = 30000;
export const SHARD_FETCH_BOOT_STALL_MS = 15000;
export const SHARD_FETCH_WATCHDOG_MS = 5000;
const DELIVER_RING = 4096;

/**
 * `?shardFetchWorker` — default ON; `off` / `0` / `false` / `no` disable it.
 * Not memoised.
 */
export function shardFetchWorkerEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location && globalThis.location.search) || "";
    const v = new URLSearchParams(s).get("shardFetchWorker");
    if (v == null) return true;
    const t = String(v).trim().toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

/**
 * `?shardFetchHigh` — default ON (the urgent lane is fetched with an explicit
 * `priority:"high"` in the worker); `off` / `0` / `false` / `no` forward "auto"
 * (no priority member, the pre-2026-10-09-follow-up worker request). Not memoised.
 */
export function shardFetchHighEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location && globalThis.location.search) || "";
    const v = new URLSearchParams(s).get("shardFetchHigh");
    if (v == null) return true;
    const t = String(v).trim().toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

/**
 * `?shardHashSlice` — default ON (the worker hashes bodies over 64 KB in 64 KB
 * slices, one event-loop turn apart); `off` / `0` / `false` / `no` = the
 * worker's one-shot hash. Forwarded as `hashSlice` on every batch message (the
 * worker has no page query of its own). Not memoised.
 */
export function shardHashSliceEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location && globalThis.location.search) || "";
    const v = new URLSearchParams(s).get("shardHashSlice");
    if (v == null) return true;
    const t = String(v).trim().toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

// The worker URL is resolved against THIS module (unbundled: scene3d/; bundled
// shell: shell/, where scripts/build-shell.mjs substitutes the hashed worker
// name). Keep the line below in its EXACT literal form (module worker, string
// specifier, import.meta.url base): build-shell's WORKER_ENTRIES coverage scan
// and its placeholder rewrite both match that shape, and a comment quoting it
// would count as a second site.
function defaultCreateWorker() {
  return new Worker(new URL("./shard_fetch_worker.js", import.meta.url), { type: "module" });
}

function defaultBaseHref() {
  try {
    const d = globalThis.document;
    if (d && typeof d.baseURI === "string" && d.baseURI) return d.baseURI;
  } catch (_) {
    /* fall through */
  }
  try {
    return (globalThis.location && globalThis.location.href) || undefined;
  } catch (_) {
    return undefined;
  }
}

/** Absolutise against the PAGE: a worker resolves a relative URL against its
 *  own script location (scene3d/ or shell/), not index.html, so the wasm's
 *  "../../dist/shards/…" would fetch the wrong path inside the worker. */
function absolutize(url, base) {
  try {
    return base ? new URL(url, base).href : new URL(url).href;
  } catch (_) {
    return String(url);
  }
}

function quantiles(ring, n) {
  const k = Math.min(n, ring.length);
  if (k === 0) return { n: 0, p50: null, p90: null, max: null };
  const a = Array.from(ring.subarray(0, k)).sort((x, y) => x - y);
  const r = (v) => Math.round(v * 10) / 10;
  return { n, p50: r(a[Math.floor(k * 0.5)]), p90: r(a[Math.min(k - 1, Math.floor(k * 0.9))]), max: r(a[k - 1]) };
}

export class ShardFetchClient {
  /**
   * @param {object} [opts]
   * @param {() => Worker} [opts.createWorker]   default: the module worker next to this file
   * @param {(reason: string) => void} [opts.onDisable]  called once when the client fails
   * @param {() => number} [opts.now]            page clock (performance.now)
   * @param {number} [opts.pageOrigin]           performance.timeOrigin of the page
   * @param {string} [opts.baseHref]             base for relative URLs (document.baseURI)
   * @param {Map} [opts.fetchMap]                default: globalThis.__fetchMap when it is a Map
   * @param {Function} [opts.setTimer] / [opts.clearTimer] / [opts.queueMicrotask]
   * @param {number} [opts.stallMs] / [opts.bootStallMs] / [opts.watchdogMs]
   * @param {"high"|"auto"} [opts.urgentPriority]  what the wasm's urgent lane ("auto")
   *        is forwarded as (default "high"; installShardFetchWorker passes "auto" under
   *        `?shardFetchHigh=off`). The normal lane ("low") is always "low".
   * @param {boolean} [opts.hashSlice]  `?shardHashSlice` forwarded on every batch
   *        (default true; installShardFetchWorker passes false under `=off`)
   * @param {Console} [opts.log]
   */
  constructor(opts = {}) {
    this._urgentPrio = opts.urgentPriority === "auto" ? "auto" : "high";
    this._hashSlice = opts.hashSlice !== false;
    this._createWorker = opts.createWorker || defaultCreateWorker;
    this._onDisable = typeof opts.onDisable === "function" ? opts.onDisable : null;
    this._now = opts.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this._pageOrigin =
      opts.pageOrigin != null ? opts.pageOrigin : (typeof performance !== "undefined" && performance.timeOrigin) || 0;
    this._baseHref = opts.baseHref !== undefined ? opts.baseHref : defaultBaseHref();
    this._fetchMapOpt = opts.fetchMap;
    this._setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
    this._queueMicrotask = opts.queueMicrotask || ((fn) => queueMicrotask(fn));
    this._stallMs = opts.stallMs != null ? opts.stallMs : SHARD_FETCH_STALL_MS;
    this._bootStallMs = opts.bootStallMs != null ? opts.bootStallMs : SHARD_FETCH_BOOT_STALL_MS;
    this._watchdogMs = opts.watchdogMs != null ? opts.watchdogMs : SHARD_FETCH_WATCHDOG_MS;
    this._log = opts.log || console;

    this._seq = 0;
    this._pending = new Map(); // id -> { resolve, reject, rec, c }
    this._queue = [];
    this._flushQueued = false;
    this._worker = null;
    this._workerOrigin = null;
    this._heardFrom = false; // any message from the worker yet
    this._lastHeardAt = this._now();
    this._watchdog = null;
    this._disabled = false;
    this._deliver = new Float64Array(DELIVER_RING);
    this._deliverN = 0;
    this._total = new Float64Array(DELIVER_RING);
    this._totalN = 0;
    this.stats = {
      enabled: true,
      workerReady: false,
      engine: null,
      secure: null,
      urgentPriority: this._urgentPrio,
      hashSlice: this._hashSlice,
      batches: 0,
      reqs: 0,
      maxBatch: 0,
      resultMsgs: 0,
      maxResultBatch: 0,
      results: 0,
      bytes: 0,
      verified: 0,
      unverified: 0,
      shaMismatch: 0,
      errors: { http: 0, network: 0, failedPending: 0 },
      disabledReason: null,
      // The worker's event-loop lag probe, as of its latest results message
      // ({probes, max, over16, over50, over100} ms; null until one arrives).
      workerLag: null,
      // The worker's `?shardHashSlice` stats, as of its latest results message
      // ({slice, yield, slicedBodies, slices, maxSliceMs}; null until one arrives).
      workerHash: null,
    };

    try {
      this._worker = this._createWorker();
    } catch (e) {
      this._fail(`worker construction failed: ${String((e && e.message) || e)}`);
      return;
    }
    if (!this._worker) {
      this._fail("worker construction returned nothing");
      return;
    }
    this._worker.onmessage = (ev) => this._onMessage(ev ? ev.data : null);
    this._worker.onerror = (e) =>
      this._fail(`worker error: ${String((e && (e.message || e.type)) || e)}`);
    this._worker.onmessageerror = () => this._fail("worker messageerror");
  }

  get disabled() {
    return this._disabled;
  }

  /** The registered wasm fetcher. Never throws; returns a Promise. */
  fetchShard(url, prio, sha) {
    if (this._disabled) {
      return Promise.reject(new Error(`shard fetch worker disabled: ${this.stats.disabledReason}`));
    }
    const id = ++this._seq;
    const abs = absolutize(url, this._baseHref);
    const c = this._now();
    let rec = null;
    const fm = this._fetchMap();
    if (fm) {
      const i = abs.indexOf("/shards/");
      if (i >= 0) {
        rec = { c };
        try {
          fm.set(abs.slice(i), rec);
        } catch (_) {
          rec = null;
        }
      }
    }
    return new Promise((resolve, reject) => {
      if (this._pending.size === 0 && this._queue.length === 0) this._lastHeardAt = c;
      this._pending.set(id, { resolve, reject, rec, c });
      this._queue.push({
        id,
        url: abs,
        // normal lane stays "low"; the urgent lane ("auto" from wasm) goes out
        // as "high" (default) or "auto" under `?shardFetchHigh=off`.
        prio: prio === "low" ? "low" : this._urgentPrio,
        sha: typeof sha === "string" && sha ? sha : null,
      });
      if (!this._flushQueued) {
        this._flushQueued = true;
        this._queueMicrotask(() => this._flush());
      }
      this._armWatchdog();
    });
  }

  _fetchMap() {
    const fm = this._fetchMapOpt !== undefined ? this._fetchMapOpt : globalThis.__fetchMap;
    return fm && typeof fm.set === "function" ? fm : null;
  }

  _flush() {
    this._flushQueued = false;
    if (this._disabled || this._queue.length === 0) return;
    const reqs = this._queue;
    this._queue = [];
    try {
      this._worker.postMessage({ type: "batch", reqs, hashSlice: this._hashSlice });
    } catch (e) {
      this._fail(`batch post failed: ${String((e && e.message) || e)}`);
      return;
    }
    this.stats.batches += 1;
    this.stats.reqs += reqs.length;
    if (reqs.length > this.stats.maxBatch) this.stats.maxBatch = reqs.length;
  }

  _armWatchdog() {
    if (this._watchdog !== null || this._disabled || !(this._watchdogMs > 0)) return;
    this._watchdog = this._setTimer(() => {
      this._watchdog = null;
      this._checkStall();
    }, this._watchdogMs);
  }

  _checkStall() {
    if (this._disabled || this._pending.size === 0) return;
    const limit = this._heardFrom ? this._stallMs : this._bootStallMs;
    const silent = this._now() - this._lastHeardAt;
    if (silent > limit) {
      this._fail(
        `worker silent for ${Math.round(silent)} ms with ${this._pending.size} request(s) pending` +
          (this._heardFrom ? "" : " (never reported ready)"),
      );
      return;
    }
    this._armWatchdog();
  }

  _noteSample(ring, which, v) {
    const n = which === "deliver" ? this._deliverN++ : this._totalN++;
    ring[n % ring.length] = v;
  }

  _onMessage(data) {
    if (this._disabled) return;
    this._heardFrom = true;
    this._lastHeardAt = this._now();
    if (!data || typeof data !== "object") return;
    if (data.type === "ready") {
      if (typeof data.to === "number") this._workerOrigin = data.to;
      this.stats.workerReady = true;
      this.stats.engine = data.engine || null;
      this.stats.secure = data.secure == null ? null : !!data.secure;
      return;
    }
    if (data.type !== "results" || !Array.isArray(data.res)) return;
    const to = typeof data.to === "number" && data.to > 0 ? data.to : this._workerOrigin;
    const off = typeof to === "number" && to > 0 && this._pageOrigin > 0 ? to - this._pageOrigin : null;
    const b = this._now();
    this.stats.resultMsgs += 1;
    if (data.res.length > this.stats.maxResultBatch) this.stats.maxResultBatch = data.res.length;
    if (data.lag && typeof data.lag === "object") this.stats.workerLag = data.lag;
    if (data.hash && typeof data.hash === "object") this.stats.workerHash = data.hash;
    for (const r of data.res) {
      if (!r) continue;
      const p = this._pending.get(r.id);
      if (!p) continue;
      this._pending.delete(r.id);
      const h = off != null && typeof r.tNetEnd === "number" ? r.tNetEnd + off : null;
      if (p.rec) {
        p.rec.h = h;
        // headers in hand in the worker (page clock): with the worker's
        // resource timing it splits the network-end → `h` gap (diag).
        if (off != null && typeof r.tResp === "number") p.rec.r = r.tResp + off;
      }
      if (r.ok && r.buf) {
        const bytes = new Uint8Array(r.buf);
        if (p.rec) p.rec.b = b;
        this.stats.results += 1;
        this.stats.bytes += bytes.byteLength;
        if (r.verified) this.stats.verified += 1;
        else this.stats.unverified += 1;
        if (r.mismatch) this.stats.shaMismatch += 1;
        if (h != null) this._noteSample(this._deliver, "deliver", b - h);
        this._noteSample(this._total, "total", b - p.c);
        p.resolve(r.verified ? { verified: true, bytes } : bytes);
      } else if (!r.ok && (r.status | 0) > 0) {
        this.stats.errors.http += 1;
        p.reject({ status: r.status | 0, statusText: String(r.statusText || ""), message: r.msg || `HTTP ${r.status}` });
      } else {
        this.stats.errors.network += 1;
        p.reject(new Error(r.msg || "shard fetch failed in the worker"));
      }
    }
  }

  _fail(reason) {
    if (this._disabled) return;
    this._disabled = true;
    this.stats.enabled = false;
    this.stats.disabledReason = reason;
    if (this._watchdog !== null) {
      try {
        this._clearTimer(this._watchdog);
      } catch (_) {
        /* ignore */
      }
      this._watchdog = null;
    }
    const pending = Array.from(this._pending.values());
    this._pending.clear();
    this._queue = [];
    this.stats.errors.failedPending += pending.length;
    try {
      if (this._worker && typeof this._worker.terminate === "function") this._worker.terminate();
    } catch (_) {
      /* ignore */
    }
    // Unregister FIRST, so the wasm retries these keys trigger go direct.
    try {
      if (this._onDisable) this._onDisable(reason);
    } catch (_) {
      /* ignore */
    }
    const err = new Error(`shard fetch worker failed: ${reason}`);
    for (const p of pending) p.reject(err);
  }

  /** Stop routing through the worker (same path as a failure). */
  dispose(reason = "disposed") {
    this._fail(reason);
  }

  diag() {
    return {
      ...this.stats,
      errors: { ...this.stats.errors },
      workerLag: this.stats.workerLag ? { ...this.stats.workerLag } : null,
      workerHash: this.stats.workerHash ? { ...this.stats.workerHash } : null,
      pending: this._pending.size,
      queued: this._queue.length,
      deliverMs: quantiles(this._deliver, this._deliverN),
      totalMs: quantiles(this._total, this._totalN),
    };
  }
}

// ---------------------------------------------------------------------------
// page install (index.html calls this once, after init_resource_source)
// ---------------------------------------------------------------------------

let _active = null;
let _lastReason = null;

/** Diag snapshot for both arms. */
export function shardFetchDiag() {
  if (_active) return _active.diag();
  return { enabled: false, disabledReason: _lastReason };
}

function installDiag() {
  try {
    const g = globalThis;
    g.__shardFetchStats = shardFetchDiag;
    if (!g.__diag || typeof g.__diag !== "object") g.__diag = {};
    g.__diag.shardFetch = shardFetchDiag;
  } catch (_) {
    /* diag is best effort */
  }
}

/**
 * Arm the shard-fetch worker for the MAIN wasm instance. Returns the client, or
 * null (flag off, no Worker, stale pkg without `register_shard_fetcher`, the
 * worker could not be constructed, or registration refused) — null means the
 * wasm keeps fetching directly. Never throws.
 *
 * @param {object} opts
 * @param {object} opts.wasmNs   the pkg namespace (`__hbWasmNs`)
 * @param {string} [opts.search] query string (default location.search)
 * @param {() => Worker} [opts.createWorker]  test seam (default: the module worker)
 * ...plus every ShardFetchClient option.
 */
export function installShardFetchWorker(opts = {}) {
  installDiag();
  const log = opts.log || console;
  if (!shardFetchWorkerEnabled(opts.search)) {
    _lastReason = "flag off (?shardFetchWorker=off)";
    return null;
  }
  if (typeof opts.createWorker !== "function" && typeof globalThis.Worker !== "function") {
    _lastReason = "no Worker in this context";
    return null;
  }
  const ns = opts.wasmNs;
  const register = ns ? ns.register_shard_fetcher : undefined;
  if (typeof register !== "function") {
    _lastReason = "stale pkg: no register_shard_fetcher export";
    return null;
  }
  if (_active && !_active.disabled) return _active;
  const client = new ShardFetchClient({
    ...opts,
    // `?shardFetchHigh` (default on): the urgent lane's explicit priority.
    urgentPriority: shardFetchHighEnabled(opts.search) ? "high" : "auto",
    // `?shardHashSlice` (default on): forwarded to the worker on every batch.
    hashSlice: shardHashSliceEnabled(opts.search),
    onDisable: (why) => {
      _lastReason = why;
      try {
        register(null);
      } catch (_) {
        /* ignore */
      }
      try {
        log.warn(`[shardFetch] worker disabled — direct fetch from now on: ${why}`);
      } catch (_) {
        /* ignore */
      }
    },
  });
  if (client.disabled) {
    _active = client; // keep its reason + counters visible in the diag
    return null;
  }
  let ok = false;
  try {
    ok = register((url, prio, sha) => client.fetchShard(url, prio, sha)) === true;
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    client.dispose("register_shard_fetcher refused the fetcher");
    _active = client;
    return null;
  }
  _active = client;
  _lastReason = null;
  return client;
}

/** Test seam: forget the installed client (does not unregister). */
export function _resetShardFetchForTests() {
  _active = null;
  _lastReason = null;
}
