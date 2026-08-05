// scene3d/xu7_textures.js — P2: XUBC7 (supercompressed BC7) payload decode.
//
// Wire tier: `holtburger/tex-xu7` ships basisu KTX2 containers (unregistered
// scheme-6 supercompression — opaque to everything but the transcoder wasm).
// Measured on our art: lossless 59% of raw BC7+mips (vs zstd's 75%), q75 38%,
// rdo-1.5bpp 22.5%. On-GPU bytes are IDENTICAL to the hbc7 path — the
// transcoder emits the same BC7 blocks, which flow through the same
// makeBc7Texture / atlas upload paths.
//
// FLAG: `?texXu7=on` — EXACT-MATCH opt-in until the 1070 confirms the new
// base blocks (house rules; the encode is ±0.9 dB vs bc7enc_rdo, so this is
// an eye call, not a correctness call). When on, the record source tries the
// xu7 namespace FIRST and falls back to `tex-bc7` on any miss/failure, so a
// dist without xu7 records behaves exactly as before.
//
// TRANSCODER: scene3d/transcoder/basis_transcoder.{js,wasm} (1.04 MB wasm,
// vendored from binomialLLC/basis_universal 9bebe167 / v2.50.0). The glue is
// an emscripten UMD script, not an ES module, so it is fetched and evaluated
// via `new Function` — works in both window and worker scopes (each context
// instantiates its OWN copy; remember the bake-worker-owns-its-wasm trap).
// Loaded LAZILY on the first xu7 decode, so flag-off boots pay zero bytes.
//
// Decode cost: ~32 ms per 1024² single-threaded. Payloads are encoded with
// stripes=8; per-record decode currently runs on the calling thread — the
// bake worker absorbs atlas feeds, singletons hitch at most once per surface.

import { bc7BlocksFor, bc7LevelBytes } from "./bc7_textures.js";

let _flag;
/** `?texXu7=on` exact-match opt-in (default OFF until 1070-confirmed). */
export function texXu7Enabled(search) {
  if (search === undefined && _flag !== undefined) return _flag;
  let on = false;
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" ? window.location.search : "";
    on = new URLSearchParams(s).get("texXu7") === "on";
  } catch (_) {
    on = false;
  }
  if (search === undefined) _flag = on;
  return on;
}

const _stats = {
  transcoderLoads: 0,
  transcoderFailed: null,
  decodes: 0,
  decodeErrors: 0,
  decodeMs: 0,
  lastError: null,
};

export function xu7Stats() {
  return { ..._stats, enabled: texXu7Enabled() };
}

let _modulePromise = null;

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
  _modulePromise = modulePromise;
}

/** Test hook: reset flag + transcoder memo + stats. */
export function _resetXu7ForTest() {
  _flag = undefined;
  _modulePromise = null;
  for (const k of Object.keys(_stats)) {
    if (typeof _stats[k] === "number") _stats[k] = 0;
    else _stats[k] = null;
  }
}

/**
 * Transcode an XUBC7 KTX2 payload to the EXACT shape `parseHbc7` returns —
 * `{width, height, blocksX, blocksY, levels:[{data,width,height}]}` — so
 * every downstream consumer (makeBc7Texture, the statics atlas) is unaware
 * which wire codec delivered the blocks.
 *
 * Returns null on ANY failure; the caller falls back to the hbc7 path.
 */
export async function transcodeXu7(bytes, baseUrl) {
  const module = await xu7Transcoder(baseUrl);
  if (!module || !bytes || bytes.length === 0) return null;
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
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
