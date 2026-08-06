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
};

export function xu7Stats() {
  return { ..._stats, enabled: texXu7Enabled() };
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

/** Test hook: reset flag + transcoder memo + stats. */
export function _resetXu7ForTest() {
  _flag = undefined;
  _modulePromise = null;
  _module = null;
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
