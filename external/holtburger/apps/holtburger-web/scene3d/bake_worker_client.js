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
  }

  /**
   * @param {{enabled?:boolean, manifestUrl?:string, sceneryBaseUrl?:string, aliasSplit?:boolean}} [opts]
   */
  configure(opts = {}) {
    this.enabled = typeof opts.enabled === "boolean" ? opts.enabled : urlFlagEnabled();
    this.aliasSplit =
      typeof opts.aliasSplit === "boolean" ? opts.aliasSplit : aliasSplitFlagEnabled();
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
          if (!s) return { active: !!_singleton?.active, byType: {}, maxPending: 0, queue };
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
          return { active: !!_singleton?.active, pendingNow: _singleton?._pending?.size ?? 0, maxPending: s.maxPending, byType, queue };
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
