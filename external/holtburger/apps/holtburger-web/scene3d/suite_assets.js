// scene3d/suite_assets.js
// Phase-4 bake-migration — the ONE per-DID binary-sidecar transport (A07 / SL-24).
//
// Greenfield + INERT-WHEN-UNREFERENCED: nothing calls SuiteAssetSource.get() unless a
// consumer (P4.3 wind `?treeWind`, Phase-5 `?tex…`) resolves a unified descriptor that
// carries a `sidecars` ref. So with the suite/effect flag off the descriptor router
// never asks for a sidecar ⇒ zero fetch, zero cache mutation ⇒ render byte-identical to
// pre-Phase-4 (off-trace L-OFF: stats().fetchCount === 0, cacheSize === 0).
//
// Mirrors scene3d/audio/baked_ambient_source.js, re-keyed (did,type). The fetch engine is
// the wasm `mod suite_fetch` (init_suite_base_url + fetch_suite_artifact(did,type) →
// Uint8Array); the per-type DECODE lives in JS via a registry, so Phase-5 texture channels
// add a decoder, not a fetch path. Tests inject `fetchImpl` instead of the wasm.

export const SUITE_BASE_URL = "../../dist/suite/";

// Per-type decoders. P4.3 registers "windclip"; Phase-5 registers "texchan".
// decode(bytes:Uint8Array, did:number) -> decoded artifact (codec-specific). Absent
// decoder ⇒ the raw Uint8Array is cached (a consumer may decode itself).
const _decoders = new Map();
export function registerSuiteDecoder(type, decode) { _decoders.set(type, decode); }
export function _hasSuiteDecoder(type) { return _decoders.has(type); } // test hook

let _baseUrlInitialized = false;
/** Init the wasm fetch base URL once (mirror ensureSceneryInit, statics.js:359). Soft no-op without wasm. */
export function ensureSuiteInit(wasmExports) {
  if (_baseUrlInitialized) return;
  _baseUrlInitialized = true;
  if (!wasmExports || typeof wasmExports.init_suite_base_url !== "function") return;
  try { wasmExports.init_suite_base_url(SUITE_BASE_URL); } catch (_) { /* soft */ }
}
export function _resetSuiteInit() { _baseUrlInitialized = false; } // test hook

export class SuiteAssetSource {
  /**
   * @param {object} [opts]
   * @param {object} [opts.wasmExports]  the wasm module (uses fetch_suite_artifact).
   * @param {(did:number,type:string)=>Promise<Uint8Array|null>} [opts.fetchImpl]  test stub.
   */
  constructor(opts = {}) {
    this._wasm = opts.wasmExports || null;
    this._fetchImpl = opts.fetchImpl || null;
    this._cache = new Map();   // "type:0xDID" -> decoded | null(absent)
    this._inflight = new Set();
    this.fetchCount = 0; this.hits = 0; this.absent = 0; this.errors = 0; this.lastError = null;
  }
  _key(did, type) { return `${type}:0x${(did >>> 0).toString(16).toUpperCase().padStart(8, "0")}`; }

  /**
   * Sync accessor — the decoded artifact, or null while loading/absent; kicks the async
   * fetch on the first ask (mirror getTriggersForLb). The consumer retries next frame.
   */
  get(did, type) {
    const k = this._key(did, type);
    if (this._cache.has(k)) return this._cache.get(k);
    if (!this._inflight.has(k)) this._beginFetch(did, type, k);
    return null;
  }

  _beginFetch(did, type, k) {
    this._inflight.add(k); this.fetchCount += 1;
    const bytesP = this._fetchImpl
      ? Promise.resolve(this._fetchImpl(did, type))
      : (this._wasm && typeof this._wasm.fetch_suite_artifact === "function"
          ? (ensureSuiteInit(this._wasm), Promise.resolve(this._wasm.fetch_suite_artifact(did, type)))
          : Promise.resolve(null));
    bytesP.then((bytes) => {
      if (!bytes || bytes.length === 0) { this._cache.set(k, null); this.absent += 1; return; } // absent == off/default
      const dec = _decoders.get(type);
      this._cache.set(k, dec ? dec(bytes, did) : bytes); this.hits += 1;
    }).catch((e) => {
      this.lastError = String(e && e.message ? e.message : e); this.errors += 1;
      this._cache.set(k, null); // never re-hammer a broken endpoint
      // eslint-disable-next-line no-console
      console.warn(`[suite] fetch failed ${k}:`, e);
    }).finally(() => { this._inflight.delete(k); });
  }

  get cacheSize() { return this._cache.size; }

  /** Plain-scalar snapshot for the off-trace harness / capture scripts. */
  stats() {
    return {
      baseUrl: SUITE_BASE_URL, cached: this._cache.size, inflight: this._inflight.size,
      fetchCount: this.fetchCount, hits: this.hits, absent: this.absent,
      errors: this.errors, lastError: this.lastError,
    };
  }
}
