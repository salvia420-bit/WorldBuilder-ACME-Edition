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
    // Promise-per-key for `getByKeyAsync` (2026-08-12). Separate from
    // `_inflight` (a bare Set used by the sync arm for "already kicked?")
    // because the async arm needs the PROMISE, so concurrent askers for the
    // same stem await one fetch instead of racing several.
    this._inflightByKey = new Map();
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

  /**
   * Sync accessor for a STRING-keyed artifact (Phase-5 texchan, keyed by
   * surface content-hash stem, not DID). Mirrors {@link get} but routes
   * through the wasm `fetch_suite_artifact_by_key`. Returns the decoded
   * artifact or null while loading/absent; kicks the async fetch on the
   * first ask. The consumer (materials.js) retries next time it builds.
   */
  getByKey(key, type) {
    const k = `${type}:${key}`;
    if (this._cache.has(k)) return this._cache.get(k);
    if (!this._inflight.has(k)) this._beginFetchByKey(key, type, k);
    return null;
  }

  /**
   * ASYNC twin of {@link getByKey} — resolves to the decoded artifact (or
   * `null` when absent/failed) once the fetch lands, instead of returning
   * `null` immediately.
   *
   * ⚠ 2026-08-12: `materials.js:_resolveRough` has called this since
   * `54d00236` and **it did not exist**, so the cold arm threw
   * `TypeError: …getByKeyAsync is not a function` on the FIRST ask for every
   * texchan stem — i.e. always, since `getByKey` returns null and kicks the
   * fetch on first ask by design. That throw unwound out of an unguarded
   * `_attachRoughnessMap` call and aborted `_installFromPixels` before
   * `_installCacheEntry` / `_reseatVariantsForDid` / `return mat`, so the
   * caller got the grey `fallbackMaterial` and the clone was never re-seated
   * — permanently untextured geometry (the "white trees"). Measured live on
   * the 1070: ~774 aborted installs, one per texchan stem.
   *
   * Shares the `_inflight` set and `_cache` with the sync path, so a stem
   * already kicked by `getByKey` is NOT re-fetched — concurrent askers await
   * the same promise. Never rejects: a failed fetch resolves `null`, matching
   * `getByKey`'s "never re-hammer a broken endpoint" contract.
   */
  getByKeyAsync(key, type) {
    const k = `${type}:${key}`;
    if (this._cache.has(k)) return Promise.resolve(this._cache.get(k));
    let p = this._inflightByKey.get(k);
    if (!p) {
      p = this._beginFetchByKey(key, type, k);
      this._inflightByKey.set(k, p);
    }
    return p;
  }

  _beginFetchByKey(key, type, k) {
    this._inflight.add(k); this.fetchCount += 1;
    const bytesP = this._fetchImpl
      ? Promise.resolve(this._fetchImpl(key, type))
      : (this._wasm && typeof this._wasm.fetch_suite_artifact_by_key === "function"
          ? (ensureSuiteInit(this._wasm), Promise.resolve(this._wasm.fetch_suite_artifact_by_key(key, type)))
          : Promise.resolve(null));
    bytesP.then((bytes) => {
      if (!bytes || bytes.length === 0) { this._cache.set(k, null); this.absent += 1; return; }
      const dec = _decoders.get(type);
      this._cache.set(k, dec ? dec(bytes, key) : bytes); this.hits += 1;
    }).catch((e) => {
      this.lastError = String(e && e.message ? e.message : e); this.errors += 1;
      this._cache.set(k, null);
      // eslint-disable-next-line no-console
      console.warn(`[suite] fetch failed ${k}:`, e);
    }).finally(() => { this._inflight.delete(k); });
    // Return the settled-to-value promise so `getByKeyAsync` can await it.
    // `.then/.catch` above already normalised every outcome into `_cache`, so
    // reading the cache here yields the same value the sync path would give,
    // and this chain never rejects.
    return bytesP
      .then(() => (this._cache.has(k) ? this._cache.get(k) : null))
      .catch(() => null)
      .finally(() => { this._inflightByKey.delete(k); });
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

// ── P4.3 windclip decoder ───────────────────────────────────────────────────
// Parses a `windclip` artifact — the RAW WindClip::encode_payload() bytes, NOT a
// SuiteBlob "HSB1" container. fetch_suite_artifact returns the on-disk file verbatim
// and strips NOTHING, so the producer MUST write encode_payload() (num_parts at
// offset 0); writing encode() instead makes this decoder read 'HSB1' as num_parts ->
// overflow -> null -> silent frozen fallback. (The SuiteBlob container path is inert/
// reserved for a future wasm-side strip.) Decodes into the object getOrCreateWindGroup
// consumes. Layout (all little-endian) is buildTreeWindClip's output verbatim, so
// the decode is a pure read — NO re-pack, NO endianness dance (both wasm/JS are LE):
//
//   off 0   u32  num_parts
//   off 4   u32  num_frames
//   off 8   u32  k            (phase-bucket count; live K = 4)
//   off 12  f32  fps
//   off 16  k bucket-major blocks, each num_frames*num_parts*7 f32, FRAME-MAJOR:
//             frames[(f*num_parts + p)*7 + 0..6] = [ox,oy,oz, qw,qx,qy,qz]  (AC wxyz)
//   off 16+k*BS  num_parts rig records, 11 f32 each:
//             pivot.x,y,z, weight, rest_o.x,y,z, rest_q.w,x,y,z   (BS = num_frames*num_parts*7*4)
//
// FAIL-SOFT: any malformed input (short/long buffer, k==0, overflow, bad header)
// returns null so the caller fail-soft-degrades to frozen statics (A12 R1). Never
// throws. The returned `frames` (bucket 0) is the zero-transform Float32Array
// buildSceneryAnimationClip already expects; `buckets[b]` carries each phase bucket
// and `rig` lets the consumer re-synthesize per-bucket phase from live wind.
const _WINDCLIP_FLOATS_PER_PART_PER_FRAME = 7;
const _WINDCLIP_RIG_FLOATS_PER_PART = 11;
registerSuiteDecoder("windclip", (bytes, _did) => {
  try {
    if (!bytes || bytes.byteLength < 16) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numParts = dv.getUint32(0, true);
    const numFrames = dv.getUint32(4, true);
    const k = dv.getUint32(8, true);
    const fps = dv.getFloat32(12, true);
    if (k === 0 || numParts === 0 || numFrames === 0) return null;
    // Overflow-guarded float counts (mirror the rust codec's checked_mul).
    const ff = numFrames * numParts * _WINDCLIP_FLOATS_PER_PART_PER_FRAME; // floats / bucket
    if (!Number.isSafeInteger(ff)) return null;
    const bs = ff * 4;                                                     // bytes / bucket
    const rigBytes = numParts * _WINDCLIP_RIG_FLOATS_PER_PART * 4;
    const expected = 16 + k * bs + rigBytes;
    if (!Number.isSafeInteger(expected) || bytes.byteLength !== expected) return null;
    // K phase-bucket clips, each copied into its own Float32Array (alignment-safe:
    // the source byteOffset need not be 4-aligned, so we read scalar-by-scalar).
    const buckets = new Array(k);
    for (let b = 0; b < k; b++) {
      const fa = new Float32Array(ff);
      let o = 16 + b * bs;
      for (let i = 0; i < ff; i++, o += 4) fa[i] = dv.getFloat32(o, true);
      buckets[b] = fa;
    }
    // Per-part rig (pivot, weight, rest.o, rest.q wxyz) — geometry-derived; lets the
    // consumer re-synthesize each bucket's phaseOffset from rig + live wind.
    const rig = new Array(numParts);
    let ro = 16 + k * bs;
    for (let p = 0; p < numParts; p++) {
      rig[p] = {
        pivot: { x: dv.getFloat32(ro, true), y: dv.getFloat32(ro + 4, true), z: dv.getFloat32(ro + 8, true) },
        weight: dv.getFloat32(ro + 12, true),
        rest: {
          o: { x: dv.getFloat32(ro + 16, true), y: dv.getFloat32(ro + 20, true), z: dv.getFloat32(ro + 24, true) },
          q: [dv.getFloat32(ro + 28, true), dv.getFloat32(ro + 32, true), dv.getFloat32(ro + 36, true), dv.getFloat32(ro + 40, true)],
        },
      };
      ro += _WINDCLIP_RIG_FLOATS_PER_PART * 4;
    }
    return {
      numParts, numFrames, fps, numBuckets: k,
      frames: buckets[0],                 // REQUIRED zero-transform clip (bucket 0, phaseOffset 0)
      buckets,                            // all K phase buckets
      rig,                                // per-bucket re-synthesis source
      bucketFrames(b) { return buckets[((b % k) + k) % k]; },
    };
  } catch (_) {
    return null;                          // fail-soft ⇒ caller keeps frozen statics
  }
});

// ── Phase-5 texchan decoder ─────────────────────────────────────────────────
// texchan rides in a SuiteBlob "HSB1" CONTAINER (unlike windclip's raw payload —
// the producer writes TexChan::encode(), so the bytes are integrity-framed and the
// decoder validates magic/version/tag before reading the payload).
//
//   Container (LE): magic[4]="HSB1" | ver:u16 | tagLen:u8 | tag[tagLen] |
//                   payloadLen:u32 | payload | contentHash:u64
//   Payload   (LE): width:u32 | height:u32 | channelMask:u32 | encoding:u32 |
//                   <channels, ascending bit order, present iff mask bit set>
//                     normal   : w*h*3 (RGB8 tangent-space)   bit0
//                     roughness: w*h   (R8)                    bit1
//                     ao       : w*h   (R8, 255=unoccluded)    bit2
//
// FAIL-SOFT: any malformation (bad magic/version/tag, unknown encoding, short/long
// buffer) returns null → the consumer keeps the current (runtime-generated) look.
// Channels are zero-copy Uint8Array VIEWS over the fetched buffer (the fetched array
// is cached + stable). Returns { width, height, normal|null, roughness|null, ao|null }.
const _TEXCHAN_CH_NORMAL = 1;
const _TEXCHAN_CH_ROUGH = 2;
const _TEXCHAN_CH_AO = 4;
const _TEXCHAN_HEADER = 16; // payload header bytes (4 x u32)

export function decodeTexchanBytes(bytes) {
  try {
    // 4 magic + 2 ver + 1 tagLen + (>=1 tag) + 4 payloadLen + 16 payload-hdr + 8 hash
    if (!bytes || bytes.byteLength < 4 + 2 + 1 + 4 + _TEXCHAN_HEADER + 8) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // magic "HSB1"
    if (dv.getUint8(0) !== 0x48 || dv.getUint8(1) !== 0x53 || dv.getUint8(2) !== 0x42 || dv.getUint8(3) !== 0x31) {
      return null;
    }
    let o = 4;
    const ver = dv.getUint16(o, true); o += 2;
    if (ver !== 1) return null;
    const tagLen = dv.getUint8(o); o += 1;
    let tag = "";
    for (let i = 0; i < tagLen; i++) tag += String.fromCharCode(dv.getUint8(o + i));
    o += tagLen;
    if (tag !== "texchan") return null;
    const payloadLen = dv.getUint32(o, true); o += 4;
    const payloadStart = o;
    if (payloadStart + payloadLen + 8 > bytes.byteLength) return null; // +8 trailing hash

    let p = payloadStart;
    const width = dv.getUint32(p, true); p += 4;
    const height = dv.getUint32(p, true); p += 4;
    const mask = dv.getUint32(p, true); p += 4;
    const encoding = dv.getUint32(p, true); p += 4;
    if (encoding !== 0) return null; // raw RGBA8/R8 only (BC reserved)
    const px = width * height;
    if (!Number.isSafeInteger(px)) return null;

    const base = bytes.byteOffset;
    let normal = null, roughness = null, ao = null;
    if (mask & _TEXCHAN_CH_NORMAL) { normal = new Uint8Array(bytes.buffer, base + p, px * 3); p += px * 3; }
    if (mask & _TEXCHAN_CH_ROUGH) { roughness = new Uint8Array(bytes.buffer, base + p, px); p += px; }
    if (mask & _TEXCHAN_CH_AO) { ao = new Uint8Array(bytes.buffer, base + p, px); p += px; }
    if (p - payloadStart !== payloadLen) return null; // short/long payload
    return { width, height, normal, roughness, ao };
  } catch (_) {
    return null;
  }
}
registerSuiteDecoder("texchan", (bytes, _key) => decodeTexchanBytes(bytes));

/**
 * Load the Phase-5 `texchan-manifest.json` (surfaceDid → content-hash stem) once.
 * Maps each "0x%08X" key to a numeric DID. Returns an empty Map on any failure
 * (fail-soft: the consumer then never finds a stem and keeps the runtime look).
 * @param {string} [baseUrl]
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Map<number,string>>}
 */
export async function loadTexchanManifest(baseUrl = SUITE_BASE_URL, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${baseUrl}texchan-manifest.json`);
    if (!res || !res.ok) return new Map();
    const obj = await res.json();
    const m = new Map();
    for (const [didStr, stem] of Object.entries(obj)) {
      const did = parseInt(String(didStr).replace(/^0x/i, ""), 16) >>> 0;
      if (Number.isFinite(did)) m.set(did, stem);
    }
    return m;
  } catch (_) {
    return new Map();
  }
}
