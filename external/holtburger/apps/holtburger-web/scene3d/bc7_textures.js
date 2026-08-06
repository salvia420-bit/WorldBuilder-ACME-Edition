// scene3d/bc7_textures.js — BC7 (BPTC) direct-to-GPU texture path.
//
// WHAT THIS IS
// The client half of the BC7 texture track: instead of decoding a
// RenderSurface to RGBA8 on the CPU and uploading 32 bpp, fetch a
// pre-encoded BC7 block payload and hand the blocks to the GPU verbatim
// (`compressedTexImage2D` / `compressedTexImage3D` under the hood, via
// three.js `CompressedTexture` / `CompressedArrayTexture`). 8 bpp on the
// GPU instead of 32, and zero CPU decode.
//
// TRANSPORT CONTRACT (fixed by the lead; the bake/delivery half is a
// separate work item — this module only consumes it):
//   namespace  `holtburger/tex-bc7`
//   record key RenderSurface id as u32 (e.g. 0x06003789)
//   payload    "HBC7" container, little-endian:
//                magic "HBC7" (4 B) | u32 width | u32 height
//                | u32 blocksX | u32 blocksY | BC7 blocks (16 B / 4x4 px)
//              `width`/`height` are TRUE pixel dims and MAY be
//              non-multiples of 4; the blocks cover the padded area.
//              Blocks are COMPRESSED_RGBA_BPTC_UNORM_EXT (opaque
//              surfaces still encode alpha = 255).
//
// MIP LEVELS
// v1 of the container carries level 0 ONLY, and the per-statics `tex-bc7`
// records are still v1. WebGL cannot generate mipmaps
// for a compressed texture (`generateMipmaps` is forced false by three), so
// a level-0-only BC7 texture MUST sample with `minFilter = LinearFilter`.
// That is a real regression versus the RGBA8 path, which runs
// `LinearMipmapLinearFilter` + full anisotropy: expect shimmer/moire on
// tiling surfaces at distance. It is ALSO a hard correctness rule, not a
// taste call — `texStorage3D(levels = 1)` plus a mipmapped minFilter is an
// incomplete texture and samples BLACK.
// `parseHbc7` therefore accepts an OPTIONAL trailing mip chain (each
// successive level halving, min 1x1) and only enables mipmapped filtering
// when the payload actually carries one. 2026-08-05: that branch is NO LONGER
// theoretical — the terrain arm ships HBC7 v2 with a full chain (10 levels at
// t512, 11 at t1024) and needed no client change, exactly as designed. The
// statics records are the ones still waiting on a v2 bake.
//
// FEATURE DETECTION IS MANDATORY, NOT OPTIONAL
// `EXT_texture_compression_bptc` is absent on plenty of real devices. (It is
// NOT absent on this laptop's SwiftShader, contrary to what this header and
// the url-flags row both claimed until 2026-08-05 — the probe reports it
// present and the whole path renders locally.) Without the extension three's `convert()`
// returns a null gl format and warns "Attempt to load unsupported
// compressed texture format" once per texture — i.e. flag-ON on an
// unsupported GPU would be a console-noise + all-white-texture bug. So:
//   - `bc7Enabled()` was an EXACT-MATCH opt-in until 2026-07-30, when it was
//     flipped DEFAULT-ON after the 1070 frame-time A/B (see the reader). This
//     header said "EXACT-MATCH opt-in ... DEFAULT OFF" for three days after
//     that flip; corrected 2026-08-02. `?texBc7=off` is the escape.
//   - `bc7Available()` additionally requires `initBc7(renderer)` to have
//     observed the extension. Every consumer calls `bc7Available()`, so an
//     unsupported GPU behaves EXACTLY like flag-off: the existing
//     decode-to-RGBA8 path, no fetches, no textures, no warnings.
//
// DEFAULT ON since 2026-07-30 (`?texBc7=off` escapes), still hard-gated on the
// extension: nothing here allocates or fetches until `bc7Available()` is true.
// (This trailer said "DEFAULT OFF ... until ?texBc7=on" for six days after the
// flip, contradicting the reader eighteen lines above it.)

import * as THREE from "three";
// P2 — call-time-only cycle with xu7_textures.js (it imports bc7BlocksFor/
// bc7LevelBytes back from here); both sides bind functions, never eval-time
// values, so the cycle is safe.
import { texXu7Enabled, transcodeXu7, xu7Stats, ensureXu7Transcoder } from "./xu7_textures.js";

// --------------------------------------------------------------------------
// flag + capability
// --------------------------------------------------------------------------

/**
 * The shared "this flag is switched off" predicate for the texture family.
 *
 * `texBc7`, `texPre` and `terrainBc7` each inlined `off|0|false|no`, and
 * `texXu7` shipped `!== "off"` — so `?texXu7=0`, `=false` and `=no` all read ON
 * while the identical spelling disabled its three siblings. The flag audit
 * passed the whole time, because the docs faithfully recorded the divergence.
 * One predicate, imported by all four, is what actually removes the class.
 *
 * @param {string|null} v raw query value (null/undefined ⇒ not off)
 */
export function flagIsOff(v) {
  if (v == null) return false;
  const t = String(v).toLowerCase();
  return t === "off" || t === "0" || t === "false" || t === "no";
}

let _flag;
/** `?texBc7=on` — EXACT-MATCH opt-in (`on`/`1`/`true`/`yes`). Absent, empty,
 *  or any other value reads OFF. Pass `search` explicitly in worker context;
 *  defaults to the page's own query string. */
export function bc7Enabled(search) {
  if (_flag !== undefined && search === undefined) return _flag;
  // DEFAULT-ON since 2026-07-30 (1070, Dryreach, quality=mid, 400 frames/arm:
  // everything-on measured 35.2 ms median / 28.4 fps vs 36.7 / 27.2 for the bare
  // default — compressed textures cut enough bandwidth to more than pay for the
  // normal-map fragment work). Still hard-gated on EXT_texture_compression_bptc
  // below, so a GPU without BPTC falls back to the RGBA8 path regardless.
  let on = true;
  try {
    const s =
      search !== undefined
        ? search
        : typeof window !== "undefined" && window.location
          ? window.location.search
          : "";
    on = !flagIsOff(new URLSearchParams(s).get("texBc7"));
  } catch (_) {
    on = true;
  }
  if (search === undefined) _flag = on;
  return on;
}

let _supported = null; // null = not probed yet, true/false = probed
let _detectNote = "not probed";

/**
 * Probe `EXT_texture_compression_bptc` on the app's real WebGL context.
 * Called once from scene3d/index.js right after the renderer is built.
 * Safe to call with a null/absent renderer (records "no renderer").
 * @returns {boolean} whether the direct-BC7 path is usable on this GPU.
 */
export function initBc7(renderer) {
  if (!bc7Enabled()) {
    _supported = false;
    _detectNote = "flag off";
    return false;
  }
  try {
    // three's WebGLExtensions.has() caches the getExtension() result and is
    // what `convert()` itself consults, so this probes exactly the object
    // the upload path will use.
    if (renderer && renderer.extensions && typeof renderer.extensions.has === "function") {
      _supported = !!renderer.extensions.has("EXT_texture_compression_bptc");
      _detectNote = _supported ? "EXT_texture_compression_bptc present" : "EXT_texture_compression_bptc ABSENT";
    } else if (renderer && typeof renderer.getContext === "function") {
      const gl = renderer.getContext();
      _supported = !!(gl && gl.getExtension("EXT_texture_compression_bptc"));
      _detectNote = _supported ? "bptc via raw getExtension" : "bptc ABSENT (raw getExtension)";
    } else {
      _supported = false;
      _detectNote = "no renderer";
    }
  } catch (e) {
    _supported = false;
    _detectNote = `probe threw: ${String(e && e.message ? e.message : e)}`;
  }
  // Loud once, on purpose: a flag-ON boot must say which arm it took.
  // eslint-disable-next-line no-console
  console.log(`[bc7] flag=on support=${_supported} (${_detectNote})`);
  return _supported;
}

/** True only when the flag is on AND the GPU has BPTC. Every consumer gates
 *  on this; false ⇒ the legacy decode→RGBA8 path, byte-identical. */
export function bc7Available() {
  return bc7Enabled() && _supported === true;
}

/** Test/diag hook: force the capability verdict without a renderer. */
export function _setBc7SupportForTest(v, note = "forced (test)") {
  _supported = v === null ? null : !!v;
  _detectNote = note;
}

export function bc7SupportNote() {
  return _detectNote;
}

// --------------------------------------------------------------------------
// HBC7 container parse
// --------------------------------------------------------------------------

export const HBC7_MAGIC = 0x37434248; // "HBC7" read as LE u32
export const HBC7_HEADER_BYTES = 20;
export const BC7_BLOCK_BYTES = 16;

/** Blocks needed to cover `n` pixels along one axis (4x4 BC7 blocks). */
export function bc7BlocksFor(n) {
  return Math.ceil(Math.max(0, n | 0) / 4);
}

/** Byte length of one BC7 mip level at these TRUE pixel dims. Identical to
 *  three's own `getByteLength(w, h, RGBA_BPTC_Format, …)`
 *  (`ceil(w/4) * ceil(h/4) * 16`), which is what the array-layer subarray
 *  math in WebGLTextures uses — they MUST agree or per-layer uploads slice
 *  the wrong bytes. */
export function bc7LevelBytes(w, h) {
  return bc7BlocksFor(w) * bc7BlocksFor(h) * BC7_BLOCK_BYTES;
}

/**
 * Parse an HBC7 payload.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{width:number, height:number, blocksX:number, blocksY:number,
 *            levels:Array<{data:Uint8Array,width:number,height:number}>}}
 * @throws {Error} with a precise reason on any malformed field. Callers are
 *   expected to catch and fall back to the RGBA8 path — a bad payload must
 *   never take the renderer down.
 */
export function parseHbc7(input) {
  const u8 =
    input instanceof Uint8Array
      ? input
      : input && input.buffer instanceof ArrayBuffer && typeof input.byteOffset === "number"
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
  if (u8.byteLength < HBC7_HEADER_BYTES) {
    throw new Error(`HBC7 too short (${u8.byteLength} < ${HBC7_HEADER_BYTES})`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== HBC7_MAGIC) {
    throw new Error(
      `HBC7 bad magic 0x${dv.getUint32(0, true).toString(16)} (expected "HBC7")`,
    );
  }
  const width = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const blocksX = dv.getUint32(12, true);
  const blocksY = dv.getUint32(16, true);
  if (width === 0 || height === 0) throw new Error(`HBC7 zero dimension ${width}x${height}`);
  const ebx = bc7BlocksFor(width);
  const eby = bc7BlocksFor(height);
  if (blocksX !== ebx || blocksY !== eby) {
    throw new Error(
      `HBC7 block dims ${blocksX}x${blocksY} != ceil(${width}/4)x ceil(${height}/4) = ${ebx}x${eby}`,
    );
  }
  const level0 = blocksX * blocksY * BC7_BLOCK_BYTES;
  const payload = u8.byteLength - HBC7_HEADER_BYTES;
  if (payload < level0) {
    throw new Error(
      `HBC7 truncated: ${payload} payload bytes < level-0 ${level0} (${blocksX}x${blocksY} blocks)`,
    );
  }
  // v1: exactly one level. FORWARD COMPAT (see the header note): trailing
  // bytes are read as a halving mip chain so a v2 container that appends
  // levels needs no client change.
  const levels = [];
  let off = HBC7_HEADER_BYTES;
  let lw = width;
  let lh = height;
  let remaining = payload;
  for (;;) {
    const need = bc7LevelBytes(lw, lh);
    if (remaining < need) break;
    levels.push({ data: u8.subarray(off, off + need), width: lw, height: lh });
    off += need;
    remaining -= need;
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
    if (remaining === 0) break;
  }
  if (levels.length === 0) throw new Error("HBC7 produced no mip levels");
  if (remaining !== 0) {
    throw new Error(
      `HBC7 trailing garbage: ${remaining} bytes left after ${levels.length} level(s) ` +
        `(v1 expects byteLength == ${HBC7_HEADER_BYTES} + ${blocksX}*${blocksY}*${BC7_BLOCK_BYTES} = ${HBC7_HEADER_BYTES + level0})`,
    );
  }
  return { width, height, blocksX, blocksY, levels };
}

// --------------------------------------------------------------------------
// three.js texture construction
// --------------------------------------------------------------------------

/**
 * Wrap a parsed HBC7 as a `THREE.CompressedTexture` — the per-surface
 * (singleton material) upload.
 *
 * Flags chosen to match `adapter.js surfacePixelsToTexture` wherever a
 * compressed texture can:
 *   colorSpace SRGBColorSpace → three's `convert()` picks
 *     COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT, i.e. the SAME hardware sRGB
 *     decode the RGBA8 path gets from SRGB8_ALPHA8. No shader-side EOTF
 *     anywhere, so the statics-atlas fragment injection is untouched.
 *   flipY — forced false by CompressedTexture, and the RGBA8 path also uses
 *     false (wasm pixels are top-down, as are PNG rows). Consistent.
 *   minFilter — LinearFilter when the payload is level-0-only (MANDATORY,
 *     see the header), LinearMipmapLinearFilter when it carries a chain.
 *   wrapS/wrapT — caller's choice; defaults to Repeat like the RGBA8 twin.
 */
export function makeBc7Texture(parsed, opts = {}) {
  const tex = new THREE.CompressedTexture(
    parsed.levels,
    parsed.width,
    parsed.height,
    THREE.RGBA_BPTC_Format,
    THREE.UnsignedByteType,
  );
  tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = parsed.levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = false; // impossible for compressed; three forces this anyway
  tex.wrapS = opts.wrapS ?? THREE.RepeatWrapping;
  tex.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
  // Anisotropy is legal on a compressed texture, but it only does anything
  // with a mip chain — leave it at the caller's value (0/1 for level-0-only).
  if (typeof opts.anisotropy === "number" && parsed.levels.length > 1) {
    tex.anisotropy = opts.anisotropy;
  }
  tex.needsUpdate = true;
  return tex;
}

/**
 * Allocate an EMPTY `THREE.CompressedArrayTexture` of `depth` BC7 layers at
 * fixed `w`x`h` — the statics-atlas bucket array.
 *
 * WHY THIS SHAPE IS FORCED (and why the atlas already fits it):
 * a compressed array cannot be resized, and every layer must share format
 * AND dimensions. `compressedTexImage3D` wants the whole array's bytes;
 * per-layer writes must go through `compressedTexSubImage3D` at
 * block-aligned offsets. three.js exposes exactly that as
 * `CompressedArrayTexture.addLayerUpdate(i)` — with `layerUpdates` non-empty
 * it emits one `compressedTexSubImage3D` per marked layer instead of
 * re-uploading the array (three r184 WebGLTextures, `isCompressedArrayTexture`
 * branch). The statics atlas already allocates each bucket at a FIXED (w, h)
 * with a FIXED layer capacity and writes layers on demand, so it maps onto
 * this 1:1 — and per-layer subimage is strictly CHEAPER than the RGBA8
 * path's full `needsUpdate` re-upload of the whole array.
 */
export function makeBc7ArrayTexture(w, h, depth, opts = {}) {
  const layerBytes = bc7LevelBytes(w, h);
  const data = new Uint8Array(layerBytes * Math.max(1, depth | 0));
  const arr = new THREE.CompressedArrayTexture(
    [{ data, width: w, height: h }],
    w,
    h,
    Math.max(1, depth | 0),
    THREE.RGBA_BPTC_Format,
    THREE.UnsignedByteType,
  );
  arr.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  arr.magFilter = THREE.LinearFilter;
  arr.minFilter = THREE.LinearFilter; // level-0 only ⇒ mipmapped filter = black
  arr.generateMipmaps = false;
  // Same addressing contract as the RGBA8 DataArrayTexture the atlas uses:
  // ClampToEdge per layer, with the wrap-bucket shader's fract() supplying
  // the tiling (static_atlas.js `makeArrayMaterial`).
  arr.wrapS = THREE.ClampToEdgeWrapping;
  arr.wrapT = THREE.ClampToEdgeWrapping;
  arr.needsUpdate = true;
  return arr;
}

/**
 * Write one layer of a BC7 array from a parsed HBC7 whose dims MUST equal
 * the array's. Marks only that layer dirty (`addLayerUpdate`) so three emits
 * a single `compressedTexSubImage3D` rather than re-uploading the array.
 * @returns {boolean} true when written.
 */
export function writeBc7ArrayLayer(arr, layer, parsed) {
  try {
    const img = arr && arr.image;
    const mip = arr && arr.mipmaps && arr.mipmaps[0];
    if (!img || !mip || !mip.data) return false;
    if (parsed.width !== img.width || parsed.height !== img.height) return false;
    const layerBytes = bc7LevelBytes(img.width, img.height);
    const src = parsed.levels[0].data;
    if (src.length !== layerBytes) return false;
    const off = layer * layerBytes;
    if (off + layerBytes > mip.data.length) return false;
    mip.data.set(src, off);
    if (typeof arr.addLayerUpdate === "function") arr.addLayerUpdate(layer);
    return true;
  } catch (_) {
    return false;
  }
}

/** GPU bytes a BC7 texture/array occupies — for the `?matBudgetMB` /
 *  atlas accounting, which reads `image.data` and so sees 0 for compressed. */
export function bc7TextureBytes(tex) {
  if (!tex || !tex.isCompressedTexture || !Array.isArray(tex.mipmaps)) return 0;
  let n = 0;
  for (const m of tex.mipmaps) if (m && m.data) n += m.data.byteLength;
  return n;
}

// --------------------------------------------------------------------------
// record source (namespace `holtburger/tex-bc7`, key = RenderSurface id)
// --------------------------------------------------------------------------

const _stats = {
  fetches: 0,
  hits: 0,
  absent: 0,
  errors: 0,
  parseErrors: 0,
  lastError: null,
  bytesFetched: 0,
  texturesBuilt: 0,
  atlasLayers: 0,
  atlasBuckets: 0,
  singletonUpgrades: 0,
  deferredNodes: 0,
  preFetches: 0,
  preHits: 0,
  preSwaps: 0,
};

// P1 preview-first (?texPre; DEFAULT ON, =off/0/false/no escape). Fetches the
// quarter-res `holtburger/tex-bc7-pre` record ahead of the full one and swaps
// twice. Pure acceleration: identical final pixels, and an archive without the
// pre namespace behaves exactly as before (empty fetch → negative cache).
let _preFlag;
export function texPreEnabled(search) {
  if (search === undefined && _preFlag !== undefined) return _preFlag;
  let on = true;
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" ? window.location.search : "";
    on = !flagIsOff(new URLSearchParams(s).get("texPre"));
  } catch (_) {
    /* malformed location: stay ON (the path is fail-soft end to end) */
  }
  if (search === undefined) _preFlag = on;
  return on;
}

/** Mutable module tally — read via `window.__bc7Stats()`. */
export function bc7Stats() {
  return {
    ..._stats,
    enabled: bc7Enabled(),
    supported: _supported,
    support: _detectNote,
    cached: _source ? _source.cacheSize : 0,
    inflight: _source ? _source.inflightSize : 0,
  };
}

export function _bumpBc7Stat(name, by = 1) {
  if (name in _stats) _stats[name] += by;
}

/**
 * Per-RenderSurface BC7 record source. Mirrors `suite_assets.js`
 * `SuiteAssetSource`: a SYNC accessor that returns the parsed payload or
 * null-while-loading and kicks the async fetch on the first ask, so callers
 * on a synchronous build path (the statics atlas feed) need no await.
 *
 * `fetchImpl(rsId) -> Promise<Uint8Array|null>` is injectable, which is what
 * makes this testable with no wasm and no GPU (and lets the delivery half
 * swap in a plain-HTTP route if it prefers one to the HBA namespace).
 */
export class Bc7RecordSource {
  constructor(opts = {}) {
    this._wasm = opts.wasmExports || null;
    this._fetchImpl = opts.fetchImpl || null;
    this._preFetchImpl = opts.preFetchImpl || null;
    this._cache = new Map(); // rsId -> parsed | null (null = absent/failed)
    this._inflight = new Set();
    this._preCache = new Map(); // rsId -> parsed | null (pre-record twin)
    this._preInflight = new Set();
    // 2026-08-05 — rsId -> the in-flight promise, so a second ask for a record
    // already being fetched JOINS it instead of starting a rival fetch. Retail
    // shares RenderSurfaces across Surfaces (three of the 33 terrain layers
    // alone, and far more among statics) while `MaterialCache._bc7Asked`
    // dedupes by surface DID, so concurrent asks for one rsId are routine.
    // `get()` was already guarded by `_inflight`; `getAsync()` was not, and
    // under P2 each duplicate cost a full xu7 payload fetch AND a ~32 ms/1024²
    // main-thread transcode on top of the wasted bytes.
    this._inflightP = new Map();
    this._preInflightP = new Map();
  }

  get cacheSize() {
    return this._cache.size;
  }

  get inflightSize() {
    return this._inflight.size;
  }

  /** Whether a fetch for this id is still outstanding (the atlas defers
   *  nodes in this state rather than committing them to an RGBA8 bucket). */
  pending(rsId) {
    return this._inflight.has(rsId >>> 0);
  }

  /** True once we have a verdict (payload or proven-absent) for this id. */
  known(rsId) {
    return this._cache.has(rsId >>> 0);
  }

  /** Sync accessor: parsed payload, or null while loading / absent. */
  get(rsId) {
    const id = rsId >>> 0;
    if (this._cache.has(id)) return this._cache.get(id);
    if (!this._inflight.has(id)) this._begin(id);
    return null;
  }

  /** Async accessor: resolves to the parsed payload or null. */
  getAsync(rsId) {
    const id = rsId >>> 0;
    if (this._cache.has(id)) return Promise.resolve(this._cache.get(id));
    return this._begin(id);
  }

  /**
   * P1 — async accessor for the PRE record (quarter-res twin). Resolves to
   * the parsed payload or null (absent / namespace not shipped / flag off /
   * wasm without the export). Never throws; never warns on absence — the pre
   * layer is optional by contract.
   */
  getPreAsync(rsId) {
    const id = rsId >>> 0;
    if (this._preCache.has(id)) return Promise.resolve(this._preCache.get(id));
    const impl = this._preFetchImpl
      ? this._preFetchImpl
      : this._wasm && typeof this._wasm.bc7_pre_blocks === "function"
        ? (i) => this._wasm.bc7_pre_blocks(i)
        : null;
    if (!impl) {
      this._preCache.set(id, null);
      return Promise.resolve(null);
    }
    // 2026-08-05 — this used to be an empty `if (this._preInflight.has(id)) {}`
    // whose comment said "just re-fetch; the store layer dedupes the network
    // hop". The store dedupes the HOP, not the parse or the caller's work, and
    // the block did nothing either way. Join the in-flight promise instead.
    const joined = this._preInflightP.get(id);
    if (joined) return joined;
    this._preInflight.add(id);
    _stats.preFetches += 1;
    const pre = Promise.resolve(impl(id))
      .then((bytes) => {
        if (!bytes || bytes.length === 0) {
          this._preCache.set(id, null);
          return null;
        }
        let parsed;
        try {
          parsed = parseHbc7(bytes);
        } catch (e) {
          // A malformed PRE payload is a bake bug like any other — loud.
          _stats.parseErrors += 1;
          _stats.lastError = String(e && e.message ? e.message : e);
          // eslint-disable-next-line no-console
          console.error(`[bc7] 0x${id.toString(16).toUpperCase()} malformed PRE payload:`, e);
          this._preCache.set(id, null);
          return null;
        }
        _stats.bytesFetched += bytes.length;
        _stats.preHits += 1;
        this._preCache.set(id, parsed);
        return parsed;
      })
      .catch(() => {
        this._preCache.set(id, null);
        return null;
      })
      .finally(() => {
        this._preInflight.delete(id);
        this._preInflightP.delete(id);
      });
    this._preInflightP.set(id, pre);
    return pre;
  }

  _begin(id) {
    // Join an ask already in flight (see `_inflightP` in the ctor).
    const joined = this._inflightP.get(id);
    if (joined) return joined;
    this._inflight.add(id);
    _stats.fetches += 1;
    // P2 (2026-08-04): with `?texXu7=on`, try the XUBC7 namespace FIRST —
    // transcoded output is shape-identical to parseHbc7's, so the rest of
    // this chain and every consumer is codec-blind. Any miss/failure falls
    // through to the hbc7 fetch below, which is only kicked on that path
    // (no double bandwidth).
    const tryXu7 = () => {
      if (!texXu7Enabled() || this._fetchImpl || !this._wasm || typeof this._wasm.xu7_blocks !== "function") {
        return Promise.resolve(null);
      }
      // 2026-08-05 — ASK whether the transcoder is up; never AWAIT it. The
      // module is 1.04 MB of lazily-loaded wasm, and awaiting it here put every
      // full-record fetch behind that load: measured ~15 s on localhost with
      // zero surfaces upgrading and every material stuck `__bc7Pending` (so the
      // atlas deferred them too), and a load that never settled would have been
      // permanent AND silent — the catch below only sees a REJECTION, not a
      // pending promise. See `ensureXu7Transcoder`. Until it lands, records take
      // the hbc7 route: the same bytes the tier-off boot would have spent, and
      // no xu7 payload fetched only to be dropped into a stalled await.
      if (!ensureXu7Transcoder()) return Promise.resolve(null);
      return Promise.resolve(this._wasm.xu7_blocks(id))
        .then((b) => {
          if (!b || b.length === 0) return null;
          _stats.bytesFetched += b.length;
          return transcodeXu7(b);
        })
        .catch(() => null);
    };
    const bytesP = () =>
      this._fetchImpl
        ? Promise.resolve(this._fetchImpl(id))
        : this._wasm && typeof this._wasm.bc7_blocks === "function"
          ? Promise.resolve(this._wasm.bc7_blocks(id))
          : Promise.resolve(null);
    const p = tryXu7()
      .then((xu7Parsed) => {
        if (xu7Parsed) {
          this._cache.set(id, xu7Parsed);
          _stats.hits += 1;
          return { __shortCircuit: xu7Parsed };
        }
        return bytesP();
      })
      .then((bytesOrDone) => {
        if (bytesOrDone && bytesOrDone.__shortCircuit) return bytesOrDone.__shortCircuit;
        const bytes = bytesOrDone;
        if (!bytes || bytes.length === 0) {
          this._cache.set(id, null); // proven-absent OR namespace not shipped
          _stats.absent += 1;
          return null;
        }
        _stats.bytesFetched += bytes.length;
        let parsed;
        try {
          parsed = parseHbc7(bytes);
        } catch (e) {
          _stats.parseErrors += 1;
          _stats.lastError = String(e && e.message ? e.message : e);
          // Loud: a malformed payload is a BAKE bug, not an environment
          // quirk, and silently rendering the retail texture would hide it.
          // eslint-disable-next-line no-console
          console.error(`[bc7] 0x${id.toString(16).toUpperCase()} malformed payload:`, e);
          this._cache.set(id, null);
          return null;
        }
        this._cache.set(id, parsed);
        _stats.hits += 1;
        return parsed;
      })
      .catch((e) => {
        _stats.errors += 1;
        _stats.lastError = String(e && e.message ? e.message : e);
        this._cache.set(id, null); // never re-hammer a broken endpoint
        // eslint-disable-next-line no-console
        console.warn(`[bc7] fetch failed 0x${id.toString(16).toUpperCase()}:`, e);
        return null;
      })
      .finally(() => {
        this._inflight.delete(id);
        this._inflightP.delete(id);
      });
    // Set BEFORE anyone can await: `p` cannot have settled yet (promise
    // callbacks are microtasks), so the `.finally` above never races this.
    this._inflightP.set(id, p);
    return p;
  }
}

let _source = null;

/**
 * Install the process-wide record source. Called once from index.html right
 * after `init_resource_source` (the wasm `bc7_blocks` export reads through the
 * same manifest source every other record goes through).
 *
 * ORDERING NOTE — deliberately NOT gated on `bc7Available()`: the renderer (and
 * therefore the BPTC probe in `initBc7`) is built inside the POST-CONNECT
 * `init3D` arm, which runs LATER than `init_resource_source`. Gating here would
 * make the install a guaranteed no-op. Construction is a bare object + two empty
 * Maps; the capability gate lives in `bc7Source()`, which every consumer calls,
 * so nothing fetches until both the flag and the probe agree.
 */
export function initBc7Source(opts = {}) {
  if (_source) return _source;
  _source = new Bc7RecordSource(opts);
  if (typeof window !== "undefined") {
    window.__bc7Stats = () => bc7Stats();
    window.__xu7Stats = () => xu7Stats();
  }
  return _source;
}

/** The installed source, or null when the path is off/unsupported. */
export function bc7Source() {
  return bc7Available() ? _source : null;
}

/**
 * Resident bytes held by the record source's parsed-payload caches — the
 * `bc7Records` row of `__diag.textures()` (2026-08-05).
 *
 * These are `_cache` / `_preCache`, both UNBOUNDED, keyed by RenderSurface id.
 * They matter to the OOM investigation for a reason that is easy to miss: they
 * hold the parsed payload INDEPENDENTLY of any texture built from it, so a
 * census that watches textures die will report those bytes as freed while this
 * map is still holding every one of them. Route-length retention, one layer
 * below the textures.
 *
 * Deduped by underlying `ArrayBuffer`: `parseHbc7` hands out `subarray` views
 * over ONE `Uint8Array` per record, so summing `levels[].data.byteLength` naively
 * counts the same payload once per mip level.
 *
 * Returns `{ records, preRecords, bytes, absent }`; `absent` counts negative
 * entries (a `null` value = "no such record"), which cost a map slot and no bytes.
 */
export function bc7RecordCacheBytes(sharedSeen) {
  const out = { records: 0, preRecords: 0, bytes: 0, absent: 0, shared: !!sharedSeen };
  // When the caller passes the texture census's dedupe set, every buffer a LIVE
  // texture already charged is skipped, so `bytes` becomes the cache's
  // INDEPENDENT retention: payload nothing else is holding. That is the number
  // that matters — `makeBc7Texture` passes `parsed.levels` through with no copy,
  // so a texture and its record share one buffer and naively summing both
  // double-counts the same megabytes.
  const seen = sharedSeen || new Set();
  const sum = (map, key) => {
    if (!map) return;
    for (const parsed of map.values()) {
      if (!parsed) { out.absent += 1; continue; }
      out[key] += 1;
      const levels = parsed.levels || [];
      for (const l of levels) {
        const buf = l?.data?.buffer;
        if (!buf || seen.has(buf)) continue;
        seen.add(buf);
        out.bytes += buf.byteLength;
      }
    }
  };
  try {
    sum(_source?._cache, "records");
    sum(_source?._preCache, "preRecords");
  } catch (_) { /* diagnostic only */ }
  return out;
}

/** Test hook: drop the installed source + stats. */
export function _resetBc7ForTest() {
  _source = null;
  for (const k of Object.keys(_stats)) {
    if (typeof _stats[k] === "number") _stats[k] = 0;
  }
  _stats.lastError = null;
  _flag = undefined;
  // 2026-08-05 — `_preFlag` was missing here, so a no-arg `texPreEnabled()`
  // memoised once and then silently decided every later case in the same
  // process regardless of what the test set up.
  _preFlag = undefined;
  _supported = null;
  _detectNote = "not probed";
}

// --------------------------------------------------------------------------
// consumer helper — swap a live material's albedo to BC7
// --------------------------------------------------------------------------

/**
 * Ask for the BC7 replacement of `rsId` and, when it lands, swap it in as
 * `mat.map`, disposing the RGBA8 texture the material was built with.
 *
 * WHY A SWAP AND NOT A BUILD-TIME CHOICE: materials are built on a
 * synchronous path from an already-decoded `SurfacePixels`; the BC7 record
 * is a separate async fetch. Building RGBA8 first and upgrading keeps the
 * first frame correct (retail texels) and makes the whole path fail-soft.
 * The cost is a visible race with the statics atlas — see
 * `static_atlas.js`'s `__bc7Pending` deferral, which holds a node out of an
 * RGBA8 bucket for one LB stream rather than locking it to 32 bpp.
 *
 * P1 (2026-08-04): when `?texPre` is on (default) and the archive ships the
 * `tex-bc7-pre` namespace, the quarter-res pre-record is fetched CONCURRENTLY
 * and, if it lands while the full record is still in flight, swapped in first
 * — the surface goes textured at ~6% of the bytes, then sharpens in place
 * when the full record arrives. Each swap is reported through `onSwap` so the
 * caller can re-point clone families both times; the returned promise still
 * resolves once, after the FULL verdict, preserving v1 semantics.
 *
 * @param {THREE.Material} mat
 * @param {number} rsId RenderSurface (0x06xxxxxx) id
 * @param {(res:{swapped:true,replaced:THREE.Texture|null})=>void} [onSwap]
 *   invoked after EACH swap (pre and/or full) with the texture it replaced.
 * @returns {Promise<boolean|{swapped:true,replaced:*}>} final-phase result
 */
export function upgradeMaterialToBc7(mat, rsId, onSwap) {
  const src = bc7Source();
  if (!src || !mat || !(rsId >>> 0)) return Promise.resolve(false);
  // Mark BEFORE the await so the atlas can see "verdict pending" on the very
  // first feed and defer instead of baking this surface in at 32 bpp.
  const already = src.known(rsId);
  // 2026-08-03 — mutate userData in place, never `{...spread}`: this runs on a
  // possibly-compiled material, and a spread drops the non-enumerable live
  // handles materials.js `_defineLiveUserData` installs.
  if (!already) {
    mat.userData = mat.userData || {};
    mat.userData.__bc7Pending = true;
  }
  let fullDone = false;
  let preTex = null;
  const buildAndSwap = (parsed, phase) => {
    const old = mat.map;
    const tex = makeBc7Texture(parsed, {
      wrapS: old ? old.wrapS : undefined,
      wrapT: old ? old.wrapT : undefined,
      colorSpace: old && old.colorSpace ? old.colorSpace : undefined,
    });
    mat.map = tex;
    mat.needsUpdate = true;
    _stats.texturesBuilt += 1;
    if (phase === "pre") _stats.preSwaps += 1;
    else _stats.singletonUpgrades += 1;
    return { swapped: true, replaced: old };
  };
  // Pre phase: only worth kicking when the full verdict isn't already cached.
  if (texPreEnabled() && !already) {
    src
      .getPreAsync(rsId)
      .then((parsed) => {
        // Lost the race (or full already landed): the pre texture is never
        // built, so there is nothing to dispose. parsed stays in _preCache
        // for any later asker.
        if (!parsed || fullDone) return;
        if (mat.userData && mat.userData.__bc7) return; // full already swapped
        const res = buildAndSwap(parsed, "pre");
        preTex = mat.map;
        const ud = (mat.userData = mat.userData || {});
        ud.__bc7Pre = true;
        if (onSwap) {
          try {
            onSwap(res);
          } catch (_) {
            /* caller's re-point failed: material itself is still correct */
          }
        }
      })
      .catch(() => {
        /* pre is best-effort by contract */
      });
  }
  return src
    .getAsync(rsId)
    .then((parsed) => {
      fullDone = true;
      const ud = (mat.userData = mat.userData || {});
      delete ud.__bc7Pending;
      if (!parsed) return false;
      const res = buildAndSwap(parsed, "full");
      ud.__bc7 = true;
      delete ud.__bc7Pre;
      ud.__bc7RsId = rsId >>> 0;
      if (onSwap) {
        // The caller's re-point handler owns disposal of `replaced` (RGBA8
        // twin in phase pre, the pre texture here) exactly as in v1.
        try {
          onSwap(res);
        } catch (_) {
          /* caller's re-point failed: material itself is still correct */
        }
      } else if (res.replaced && res.replaced === preTex) {
        // No caller handler: the pre texture was built here and is tracked
        // nowhere else — dispose it or it leaks GPU memory on every upgrade.
        try {
          res.replaced.dispose();
        } catch (_) {
          /* fail-soft */
        }
      }
      return res;
    })
    .catch(() => {
      const ud = (mat.userData = mat.userData || {});
      delete ud.__bc7Pending;
      return false;
    });
}

/** Whether a material is waiting on a BC7 verdict (atlas deferral gate). */
export function bc7PendingOn(mat) {
  return !!(mat && mat.userData && mat.userData.__bc7Pending);
}
