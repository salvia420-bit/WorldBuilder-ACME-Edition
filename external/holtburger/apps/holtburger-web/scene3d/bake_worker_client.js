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
} from "./bake_transfer.js";

function urlFlagEnabled() {
  try {
    return new URLSearchParams(globalThis.location?.search || "").has("bakeWorker");
  } catch (_) {
    return false;
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
   */
  async fetchModelMeshes(wasmExports, ids) {
    if (!this.active) return wasmExports.fetch_model_meshes(ids);
    try {
      await this._ensureWorker();
      const res = await this._request("fetchModelMeshes", { ids: Array.from(ids) });
      return reconstructModelMeshes(res.payload);
    } catch (e) {
      console.warn("[bake_worker_client] model-mesh worker failed; main-thread fallback:", e);
      return wasmExports.fetch_model_meshes(ids);
    }
  }

  /** Surface pixels off-thread. Drop-in for the surface consumers. */
  async fetchSurfacesPixels(wasmExports, dids) {
    if (!this.active) return wasmExports.fetch_surfaces_pixels(dids);
    try {
      await this._ensureWorker();
      const res = await this._request("fetchSurfacesPixels", { dids: Array.from(dids) });
      return reconstructSurfacePixelsBatch(res.payload);
    } catch (e) {
      console.warn("[bake_worker_client] surface worker failed; main-thread fallback:", e);
      return wasmExports.fetch_surfaces_pixels(dids);
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
  if (!client.active) return wasmExports.fetch_model_meshes;
  return (ids) => client.fetchModelMeshes(wasmExports, ids);
}

/** Same contract for the surface-pixels decoder. */
export function surfacePixelsFetcher(wasmExports) {
  const client = getBakeWorkerClient();
  if (!client.active) return wasmExports.fetch_surfaces_pixels;
  return (dids) => client.fetchSurfacesPixels(wasmExports, dids);
}
