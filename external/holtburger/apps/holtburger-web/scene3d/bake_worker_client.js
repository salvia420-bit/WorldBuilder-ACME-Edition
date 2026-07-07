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
// Enable per-session with `?bakeWorker=1` in the page URL, or
// `configureBakeWorker({ enabled: true, manifestUrl, sceneryBaseUrl })`
// during boot. Default: DISABLED.

import {
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

class BakeWorkerClient {
  constructor() {
    this.enabled = false;
    this.manifestUrl = null;
    this.sceneryBaseUrl = null;
    this._worker = null;
    this._readyPromise = null;
    this._seq = 1;
    this._pending = new Map();
  }

  /**
   * @param {{enabled?:boolean, manifestUrl?:string, sceneryBaseUrl?:string}} [opts]
   */
  configure(opts = {}) {
    this.enabled = typeof opts.enabled === "boolean" ? opts.enabled : urlFlagEnabled();
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
    this._readyPromise = this._request("init", {
      manifestUrl: abs(this.manifestUrl),
      sceneryBaseUrl: abs(this.sceneryBaseUrl),
    });
    return this._readyPromise;
  }

  _request(type, body) {
    const id = this._seq++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ type, id, ...body });
    });
  }

  _onMessage(msg) {
    const entry = this._pending.get(msg && msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    if (msg.type === "ready") return entry.resolve(true);
    if (msg.type === "error") return entry.reject(new Error(msg.message));
    if (msg.type === "result") return entry.resolve(msg);
    entry.reject(new Error("bake worker: unknown reply " + msg.type));
  }

  _failAll(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
    // Drop the dead worker so a later call can respawn.
    this._worker = null;
    this._readyPromise = null;
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
      const res = await this._request("fetchSurfacesPixels", {
        dids: Array.from(dids),
        urgent: urgent === true,
      });
      return reconstructSurfacePixelsBatch(res.payload);
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
   */
  async fetchEntitySurfacesPixels(wasmExports, dids, paletteId, subPalettes) {
    if (!this.active) {
      return wasmExports.fetchEntitySurfacesPixels(dids, paletteId, subPalettes);
    }
    try {
      await this._ensureWorker();
      const res = await this._request("fetchEntitySurfacesPixels", {
        dids: Array.from(dids),
        paletteId: paletteId >>> 0,
        subPalettes: Array.from(subPalettes || []),
      });
      return reconstructSurfacePixelsBatch(res.payload);
    } catch (e) {
      console.warn(
        "[bake_worker_client] entity-surface worker failed; main-thread fallback:",
        e,
      );
      return wasmExports.fetchEntitySurfacesPixels(dids, paletteId, subPalettes);
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
  ) {
    if (!this.active) {
      return wasmExports.fetchEntitySurfacesPixelsBatch(
        flatDids,
        lens,
        basePals,
        flatSubs,
        tripleCounts,
      );
    }
    try {
      await this._ensureWorker();
      const res = await this._request("fetchEntitySurfacesPixelsBatch", {
        flatDids: Array.from(flatDids),
        lens: Array.from(lens),
        basePals: Array.from(basePals),
        flatSubs: Array.from(flatSubs || []),
        tripleCounts: Array.from(tripleCounts || []),
      });
      return reconstructEntitySurfacesBatch(res.payload);
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
      );
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
  if (!_singleton) _singleton = new BakeWorkerClient().configure({});
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
  if (!client.active) return wasmExports.fetchEntitySurfacesPixels;
  return (dids, paletteId, subPalettes) =>
    client.fetchEntitySurfacesPixels(wasmExports, dids, paletteId, subPalettes);
}

/** Same contract for the F.41 batched entity-surface decoder. */
export function entitySurfacesBatchFetcher(wasmExports) {
  if (typeof wasmExports.fetchEntitySurfacesPixelsBatch !== "function") {
    return wasmExports.fetchEntitySurfacesPixelsBatch;
  }
  const client = getBakeWorkerClient();
  if (!client.active) return wasmExports.fetchEntitySurfacesPixelsBatch;
  return (flatDids, lens, basePals, flatSubs, tripleCounts) =>
    client.fetchEntitySurfacesPixelsBatch(
      wasmExports,
      flatDids,
      lens,
      basePals,
      flatSubs,
      tripleCounts,
    );
}
