// scene3d/texture_worker.js — ST4 (`?texWorkers`) dedicated texture worker.
//
// WHAT THIS IS (SPEC §1.3 / pass-05 D-05.4 + S3; task T14). One Web Worker,
// count 1, WASM-FREE BY DESIGN (pass-05: deliberately topology-neutral — it
// must never couple texture throughput to bake jobs or to the wasm-instance
// census), owning three CPU-side jobs:
//
//   kind:"xu7"              XUBC7 (basisu KTX2) → BC7 transcode, on this
//                           worker's OWN transcoder instance (1.04 MB wasm per
//                           JS context — the known per-context trap,
//                           xu7_textures.js header). With `want.nra` set it
//                           also transcodes one mip level to RGBA32 and
//                           derives an RGBA8 NRA plane (below).
//   kind:"terrain-assemble" the level-major 33-layer array concatenation
//                           `buildTerrainBc7Array` does synchronously today
//                           (terrain_bc7.js:444-502 — 88 MiB alloc+memcpy at
//                           t1024). Payloads in, ONE concatenated buffer out.
//   kind:"nra-derive"       standalone NRA derivation from an RGBA8 plane
//                           (the ST5 consumer's seam; no transcoder needed).
//
// RESULTS-ENQUEUE-ONLY (pass-08 D-08.4/D-08.5): this worker produces CPU-side
// transferable results ONLY. It never creates GPU objects, never touches
// three.js, and NEVER FETCHES — bytes are handed in by the main thread (the
// fetch authority, pass-03 D-03.3). The main thread reconstructs `parseHbc7`-
// shaped subarray views over the returned buffer and uploads on its existing
// schedule.
//
// SELF-CONTAINED ON PURPOSE: module workers do not inherit the page's import
// map, so this file cannot import scene3d/bc7_textures.js (which imports the
// bare specifier "three"). The small HBC7/BC7 helpers are therefore duplicated
// here; `harness/test_texture_worker.mjs` pins them byte-identical against the
// bc7_textures.js exports so they cannot drift silently.
//
// NRA DERIVATION PROVENANCE: a JS port of the runtime derivation the RGBA8
// path uses today — crates/holtburger-dat/src/normal_gen.rs
// (`normal_from_luminance` Sobel-from-Rec.601-luminance with the ≤64px 3x3
// Gaussian pre-blur and the unit-length clamp; `roughness_from_luminance`
// local-σ; `ao_from_luminance` below-local-mean), packed into ONE RGBA8 plane
// with the terrain-nra channel convention (terrain_bc7.js header): R/G =
// tangent-space normal XY, B = roughness, A = AO. Both runtime call sites use
// strength 1.0 (src/lib.rs — the fused-signature note); that is the default
// here. `harness/test_nra_derive.mjs` pins the port against normal_gen.rs's
// own golden bytes (golden_8x8_checkerboard).
//
// PROTOCOL (pass-05 S3, normative; pass-08 S3 additions):
//   main → worker:
//     {type:"init", transcoderBaseUrl}            → {type:"ready"}
//     {type:"job", seq, kind:"xu7", bytes:ArrayBuffer, want:{nra}}
//     {type:"job", seq, kind:"terrain-assemble", tileSize, levels, depth,
//        layerRs:[depth], payloads:[{rs, bytes:ArrayBuffer}…]}
//     {type:"job", seq, kind:"nra-derive", width, height, rgba:ArrayBuffer,
//        strength?}
//     {type:"cancel", seq}
//   worker → main:
//     {type:"result", seq, ok:true, kind:"xu7", width, height,
//        levelBytes:[u32…], bc7:ArrayBuffer, transcodeMs, nra?:{width,height,
//        plane:ArrayBuffer}}                       // transfer bc7 (+ plane)
//     {type:"result", seq, ok:true, kind:"terrain-assemble", tileSize, levels,
//        depth, levelBytes:[u32…], bc7:ArrayBuffer, assembleMs}
//     {type:"result", seq, ok:true, kind:"nra-derive", width, height,
//        plane:ArrayBuffer}
//     {type:"result", seq, ok:false, err}          // caller falls back
//
// FIFO, one job at a time (the worker event loop provides that by
// construction). The transcoder loads LAZILY on the first xu7 job — a
// terrain-assemble-only session never pays the 1.04 MB, and `ready` never
// waits on it. A `cancel` for a seq not yet processed makes that job answer
// `{ok:false, err:"cancelled"}`.
//
// The `?xu7Budget` main-thread FIFO in xu7_textures.js is retained VERBATIM as
// the fallback arm (`?texWorkers` absent/off, worker construction failure, or
// worker death) — that is T14's kill path.

// ---------------------------------------------------------------------------
// BC7 arithmetic + HBC7 parse (duplicated from bc7_textures.js — see header)
// ---------------------------------------------------------------------------

export const HBC7_MAGIC = 0x37434248; // "HBC7" read as LE u32
export const HBC7_HEADER_BYTES = 20;
export const BC7_BLOCK_BYTES = 16;

export function bc7BlocksFor(n) {
  return Math.ceil(Math.max(0, n | 0) / 4);
}

export function bc7LevelBytes(w, h) {
  return bc7BlocksFor(w) * bc7BlocksFor(h) * BC7_BLOCK_BYTES;
}

/** Same walk as bc7_textures.js `parseHbc7` (throwing, subarray views). */
export function parseHbc7Worker(input) {
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
    throw new Error(`HBC7 bad magic 0x${dv.getUint32(0, true).toString(16)} (expected "HBC7")`);
  }
  const width = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const blocksX = dv.getUint32(12, true);
  const blocksY = dv.getUint32(16, true);
  if (width === 0 || height === 0) throw new Error(`HBC7 zero dimension ${width}x${height}`);
  const ebx = bc7BlocksFor(width);
  const eby = bc7BlocksFor(height);
  if (blocksX !== ebx || blocksY !== eby) {
    throw new Error(`HBC7 block dims ${blocksX}x${blocksY} != expected ${ebx}x${eby}`);
  }
  const level0 = blocksX * blocksY * BC7_BLOCK_BYTES;
  const payload = u8.byteLength - HBC7_HEADER_BYTES;
  if (payload < level0) {
    throw new Error(`HBC7 truncated: ${payload} payload bytes < level-0 ${level0}`);
  }
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
    throw new Error(`HBC7 trailing garbage: ${remaining} bytes left after ${levels.length} level(s)`);
  }
  return { width, height, blocksX, blocksY, levels };
}

// ---------------------------------------------------------------------------
// transcoder (this context's OWN instance; lazy — see header)
// ---------------------------------------------------------------------------

const _now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

let _module = null;
let _modulePromise = null;
let _transcoderBase = null;

function _loadTranscoder() {
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    try {
      const base = _transcoderBase || new URL("./transcoder/", import.meta.url);
      const jsUrl = new URL("basis_transcoder.js", base);
      const resp = await fetch(jsUrl);
      if (!resp.ok) throw new Error(`transcoder js fetch ${resp.status}`);
      const src = await resp.text();
      // Same UMD-glue technique as xu7_textures.js: the emscripten script is
      // not an ES module; evaluating it defines `BASIS` in scope. Works in
      // worker scope (the glue's own header says so).
      // eslint-disable-next-line no-new-func
      const factory = new Function(`${src}\nreturn BASIS;`)();
      const module = await factory({ locateFile: (f) => new URL(f, base).href });
      module.initializeBasis();
      _module = module;
      return module;
    } catch (e) {
      // Remembered failure: the worker answers ok:false per job; the client
      // falls back per its matrix rather than re-downloading 1 MB per record.
      _module = null;
      throw e;
    }
  })();
  return _modulePromise;
}

/** Test hook: preset the transcoder module (node cannot run the UMD loader). */
export function _setWorkerTranscoderForTest(module) {
  _module = module ?? null;
  _modulePromise = module ? Promise.resolve(module) : null;
}

/** Test hook: reset worker-global state between suites. */
export function _resetTextureWorkerForTest() {
  _module = null;
  _modulePromise = null;
  _transcoderBase = null;
  _cancelled.clear();
}

// ---------------------------------------------------------------------------
// job bodies (pure; exported for the node protocol tests)
// ---------------------------------------------------------------------------

/**
 * XUBC7 → BC7, all levels into ONE freshly allocated buffer (the single
 * transferable of the result). Level layout is the halving chain, level-major
 * — exactly the sizes `bc7LevelBytes` predicts, so the main thread's
 * `parseHbc7`-shaped view reconstruction needs only `levelBytes`.
 *
 * Throws on any failure (the message loop maps that to `{ok:false, err}`).
 * Mirrors xu7_textures.js `_transcodeNow`'s per-level checks so the two paths
 * cannot diverge on what a malformed container is.
 */
export function transcodeXu7Payload(module, bytes, want) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!module) throw new Error("no transcoder");
  if (!u8 || u8.length === 0) throw new Error("empty payload");
  let file = null;
  try {
    file = new module.KTX2File(u8);
    if (!file.isValid()) throw new Error("KTX2 invalid");
    const width = file.getWidth();
    const height = file.getHeight();
    const levelCount = file.getLevels();
    if (!width || !height || !levelCount) throw new Error(`bad dims/levels ${width}x${height}/${levelCount}`);
    if (!file.startTranscoding()) throw new Error("startTranscoding failed");
    const fmt = module.transcoder_texture_format.cTFBC7_RGBA.value;

    // Pass 1: sizes, so the output is ONE allocation.
    const levelDims = [];
    const levelBytes = [];
    let total = 0;
    let lw = width;
    let lh = height;
    for (let i = 0; i < levelCount; i++) {
      const need = bc7LevelBytes(lw, lh);
      const size = file.getImageTranscodedSizeInBytes(i, 0, 0, fmt);
      if (size !== need) throw new Error(`level ${i} size ${size} != expected ${need}`);
      levelDims.push([lw, lh]);
      levelBytes.push(need);
      total += need;
      if (lw === 1 && lh === 1) break;
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }

    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < levelBytes.length; i++) {
      const dst = out.subarray(off, off + levelBytes[i]);
      if (!file.transcodeImage(dst, i, 0, 0, fmt, 0, -1, -1)) {
        throw new Error(`transcodeImage failed at level ${i}`);
      }
      off += levelBytes[i];
    }

    // Optional NRA derive from the transcoded albedo (pass-05 D-05.5):
    // "half" (the default tier) reads level 1 when it exists — normals at half
    // the albedo res, a quarter of the plane bytes; "full" reads level 0.
    let nra = null;
    const wantNra = want && want.nra ? String(want.nra) : null;
    if (wantNra) {
      const li = wantNra === "full" ? 0 : Math.min(1, levelBytes.length - 1);
      const [nw, nh] = levelDims[li];
      const rgbaFmt = module.transcoder_texture_format.cTFRGBA32.value;
      const rgbaSize = file.getImageTranscodedSizeInBytes(li, 0, 0, rgbaFmt);
      const rgba = new Uint8Array(rgbaSize);
      if (!file.transcodeImage(rgba, li, 0, 0, rgbaFmt, 0, -1, -1)) {
        throw new Error(`transcodeImage(RGBA32) failed at level ${li}`);
      }
      const plane = deriveNraPlane(rgba, nw, nh);
      nra = { width: nw, height: nh, plane };
    }

    return { width, height, levelBytes, bc7: out, nra };
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

/**
 * The terrain array assembly `buildTerrainBc7Array` runs synchronously today
 * (terrain_bc7.js:444-502): parse every distinct payload, validate the hard
 * uniformity contract, then concatenate level-major (level li holds every
 * layer's level li in layer order — three's CompressedArrayTexture layout
 * contract). Output is ONE buffer; `levelBytes[li]` = per-layer level bytes ×
 * depth, so offsets are derivable exactly like the mipmaps[] the main thread
 * rebuilds.
 *
 * Throws on any malformed/missing/off-dimension layer — same all-or-nothing
 * rule as the loader (a partially-populated compressed array is worse than the
 * RGBA8 fallback).
 */
export function assembleTerrainChannel({ tileSize, levels, depth, layerRs, payloads }) {
  if (!Number.isInteger(tileSize) || tileSize <= 0) throw new Error(`bad tileSize ${tileSize}`);
  if (!Number.isInteger(levels) || levels < 2) throw new Error(`bad levels ${levels}`);
  if (!Number.isInteger(depth) || depth <= 0) throw new Error(`bad depth ${depth}`);
  if (!Array.isArray(layerRs) || layerRs.length !== depth) {
    throw new Error(`layerRs must have ${depth} entries`);
  }
  const parsedByRs = new Map();
  for (const p of payloads || []) {
    if (!p || !p.rs) throw new Error("payload without rs");
    parsedByRs.set(String(p.rs), parseHbc7Worker(new Uint8Array(p.bytes)));
  }
  const byLayer = new Array(depth).fill(null);
  for (let i = 0; i < depth; i += 1) {
    const rs = layerRs[i] ? String(layerRs[i]) : "";
    const p = rs ? parsedByRs.get(rs) : null;
    if (!p) throw new Error(`layer ${i} has no payload (rsId ${rs})`);
    if (p.width !== tileSize || p.height !== tileSize) {
      throw new Error(`layer ${i} (${rs}) is ${p.width}x${p.height}, array is ${tileSize}x${tileSize}`);
    }
    if (p.levels.length !== levels) {
      throw new Error(`layer ${i} (${rs}) has ${p.levels.length} levels, expected ${levels}`);
    }
    byLayer[i] = p;
  }

  const levelBytes = [];
  let total = 0;
  let w = tileSize;
  let h = tileSize;
  for (let li = 0; li < levels; li += 1) {
    const n = bc7LevelBytes(w, h) * depth;
    levelBytes.push(n);
    total += n;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  const out = new Uint8Array(total);
  let off = 0;
  w = tileSize;
  h = tileSize;
  for (let li = 0; li < levels; li += 1) {
    const layerBytes = bc7LevelBytes(w, h);
    for (let i = 0; i < depth; i += 1) {
      const src = byLayer[i].levels[li].data;
      if (src.byteLength !== layerBytes) {
        throw new Error(`L${li} layer ${i} is ${src.byteLength} B, expected ${layerBytes}`);
      }
      out.set(src, off + i * layerBytes);
    }
    off += layerBytes * depth;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return { tileSize, levels, depth, levelBytes, bc7: out };
}

// ---------------------------------------------------------------------------
// NRA derivation — JS port of crates/holtburger-dat/src/normal_gen.rs
// ---------------------------------------------------------------------------
// Byte-parity with the Rust originals is the contract (the golden test pins
// it); every constant and clamp below mirrors normal_gen.rs by line.

const LOW_RES_THRESHOLD = 64; // normal_gen.rs:24
const ROUGHNESS_CONTRAST_GAIN = 2.0; // normal_gen.rs:30 (exact in f32)

// STRICT f32 EMULATION. The Rust originals compute in f32 with rounding at
// EVERY operation; byte-parity therefore needs `Math.fround` after every
// binary op here. Double rounding f64→f32 is exact for +,-,*,/ and sqrt of
// f32 operands (f64 carries > 2×24+2 bits), so `F(a op b)` IS the f32 op.
const F = Math.fround;
const C_R = F(0.299);
const C_G = F(0.587);
const C_B = F(0.114);

function _sampleClamped(buf, x, y, w, h) {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
  return buf[cy * w + cx];
}

function _luminance(rgba, pixelCount) {
  const lum = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const r = F(rgba[i * 4] / 255.0);
    const g = F(rgba[i * 4 + 1] / 255.0);
    const b = F(rgba[i * 4 + 2] / 255.0);
    // Rust: 0.299*r + 0.587*g + 0.114*b, left-assoc, f32 at each step.
    lum[i] = F(F(F(C_R * r) + F(C_G * g)) + F(C_B * b));
  }
  return lum;
}

function _gaussianBlur3x3(buf, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const l00 = _sampleClamped(buf, x - 1, y - 1, w, h);
      const l10 = _sampleClamped(buf, x, y - 1, w, h);
      const l20 = _sampleClamped(buf, x + 1, y - 1, w, h);
      const l01 = _sampleClamped(buf, x - 1, y, w, h);
      const l11 = _sampleClamped(buf, x, y, w, h);
      const l21 = _sampleClamped(buf, x + 1, y, w, h);
      const l02 = _sampleClamped(buf, x - 1, y + 1, w, h);
      const l12 = _sampleClamped(buf, x, y + 1, w, h);
      const l22 = _sampleClamped(buf, x + 1, y + 1, w, h);
      // Rust left-assoc chain; ×2/×4 are exact in f32, each + rounds.
      let sum = F(l00 + F(2.0 * l10));
      sum = F(sum + l20);
      sum = F(sum + F(2.0 * l01));
      sum = F(sum + F(4.0 * l11));
      sum = F(sum + F(2.0 * l21));
      sum = F(sum + l02);
      sum = F(sum + F(2.0 * l12));
      sum = F(sum + l22);
      out[y * w + x] = F(sum / 16.0);
    }
  }
  return out;
}

/** Rust f32 Sobel weighted sum `(a + 2b + c)` left-assoc. */
function _sobelTriple(a, b, c) {
  return F(F(a + F(2.0 * b)) + c);
}

/**
 * Port of `normal_from_luminance` (normal_gen.rs:45-117). Returns a
 * `Uint8Array(w*h*3)` in the same `[(nx+1)/2, (ny+1)/2, nz]*255` packing, or
 * an empty array on malformed input — the Rust contract.
 */
export function normalFromLuminance(rgba, w, h, strength = 1.0) {
  const pixelCount = (w | 0) * (h | 0);
  if (pixelCount <= 0 || !rgba || rgba.length < pixelCount * 4) return new Uint8Array(0);
  const fs = F(strength);
  const C_999 = F(0.999);
  let lum = _luminance(rgba, pixelCount);
  if (w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD) lum = _gaussianBlur3x3(lum, w, h);
  const out = new Uint8Array(pixelCount * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const l00 = _sampleClamped(lum, x - 1, y - 1, w, h);
      const l10 = _sampleClamped(lum, x, y - 1, w, h);
      const l20 = _sampleClamped(lum, x + 1, y - 1, w, h);
      const l01 = _sampleClamped(lum, x - 1, y, w, h);
      const l21 = _sampleClamped(lum, x + 1, y, w, h);
      const l02 = _sampleClamped(lum, x - 1, y + 1, w, h);
      const l12 = _sampleClamped(lum, x, y + 1, w, h);
      const l22 = _sampleClamped(lum, x + 1, y + 1, w, h);
      const gx = F(_sobelTriple(l20, l21, l22) - _sobelTriple(l00, l01, l02));
      const gy = F(_sobelTriple(l02, l12, l22) - _sobelTriple(l00, l10, l20));
      let nx = F(-gx * fs);
      let ny = F(-gy * fs);
      const magSq = F(F(nx * nx) + F(ny * ny));
      if (magSq > 1.0) {
        const scale = F(1.0 / F(Math.sqrt(magSq)));
        nx = F(F(nx * scale) * C_999);
        ny = F(F(ny * scale) * C_999);
      }
      let nzArg = F(1.0 - F(nx * nx));
      nzArg = F(nzArg - F(ny * ny));
      const nz = F(Math.sqrt(Math.max(0.0, nzArg)));
      const idx = (y * w + x) * 3;
      // Rust f32::round = half away from zero; all packed values are >= 0,
      // where Math.round (half toward +inf) agrees.
      out[idx] = Math.min(255, Math.max(0, Math.round(F(F(F(nx + 1.0) * 0.5) * 255.0))));
      out[idx + 1] = Math.min(255, Math.max(0, Math.round(F(F(F(ny + 1.0) * 0.5) * 255.0))));
      out[idx + 2] = Math.min(255, Math.max(0, Math.round(F(nz * 255.0))));
    }
  }
  return out;
}

/** Port of `roughness_from_luminance` (normal_gen.rs:405-441): per-texel 3x3
 *  luminance σ × gain, clamped. Empty on malformed input. */
export function roughnessFromLuminance(rgba, w, h, strength = 1.0) {
  const pixelCount = (w | 0) * (h | 0);
  if (pixelCount <= 0 || !rgba || rgba.length < pixelCount * 4) return new Uint8Array(0);
  const fs = F(strength);
  let lum = _luminance(rgba, pixelCount);
  if (w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD) lum = _gaussianBlur3x3(lum, w, h);
  const out = new Uint8Array(pixelCount);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0.0;
      let sumSq = 0.0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const s = _sampleClamped(lum, x + dx, y + dy, w, h);
          sum = F(sum + s);
          sumSq = F(sumSq + F(s * s));
        }
      }
      const mean = F(sum / 9.0);
      const variance = Math.max(0.0, F(F(sumSq / 9.0) - F(mean * mean)));
      const sigma = F(Math.sqrt(variance));
      const r = Math.min(1.0, Math.max(0.0, F(F(sigma * ROUGHNESS_CONTRAST_GAIN) * fs)));
      out[y * w + x] = Math.min(255, Math.max(0, Math.round(F(r * 255.0))));
    }
  }
  return out;
}

/** Port of `ao_from_luminance` (normal_gen.rs:457-479): occlusion where a
 *  texel sits below its 3x3-Gaussian local mean. 255 = unoccluded. */
export function aoFromLuminance(rgba, w, h, strength = 1.0) {
  const pixelCount = (w | 0) * (h | 0);
  if (pixelCount <= 0 || !rgba || rgba.length < pixelCount * 4) return new Uint8Array(0);
  const fs = F(strength);
  let lum = _luminance(rgba, pixelCount);
  if (w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD) lum = _gaussianBlur3x3(lum, w, h);
  const localMean = _gaussianBlur3x3(lum, w, h);
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const d = Math.max(0.0, F(localMean[i] - lum[i]));
    const occ = Math.min(1.0, Math.max(0.0, F(fs * d)));
    out[i] = Math.min(255, Math.max(0, Math.round(F(F(1.0 - occ) * 255.0))));
  }
  return out;
}

/**
 * The packed NRA plane (pass-05 S3 result shape): RGBA8, R/G = tangent normal
 * XY, B = roughness, A = AO — the terrain-nra channel convention. `Uint8Array
 * (w*h*4)`; a malformed input yields flat/neutral texels only if partial
 * derivations fail (empty normal ⇒ flat (128,128); empty roughness ⇒ 0; empty
 * AO ⇒ 255), and an empty plane when dims are bad.
 */
export function deriveNraPlane(rgba, w, h, { strength = 1.0 } = {}) {
  const pixelCount = (w | 0) * (h | 0);
  if (pixelCount <= 0 || !rgba || rgba.length < pixelCount * 4) return new Uint8Array(0);
  const normal = normalFromLuminance(rgba, w, h, strength);
  const rough = roughnessFromLuminance(rgba, w, h, strength);
  const ao = aoFromLuminance(rgba, w, h, strength);
  const out = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    out[i * 4] = normal.length ? normal[i * 3] : 128;
    out[i * 4 + 1] = normal.length ? normal[i * 3 + 1] : 128;
    out[i * 4 + 2] = rough.length ? rough[i] : 0;
    out[i * 4 + 3] = ao.length ? ao[i] : 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// message loop
// ---------------------------------------------------------------------------

const _cancelled = new Set();

/**
 * Handle one protocol message. `post(msg, transfers)` is the reply channel —
 * injected so the node tests can drive the exact protocol with no Worker.
 * Returns a promise that settles when the reply (if any) has been posted.
 */
export async function handleTextureWorkerMessage(data, post) {
  if (!data || typeof data !== "object") return;
  if (data.type === "init") {
    if (data.transcoderBaseUrl) _transcoderBase = data.transcoderBaseUrl;
    // Ready NEVER waits on the transcoder (lazy — see header): terrain
    // assembly must be available immediately and a slow 1.04 MB load must not
    // stall the ready gate (the ensureXu7Transcoder lesson, ask-don't-await).
    post({ type: "ready" });
    return;
  }
  if (data.type === "cancel") {
    _cancelled.add(data.seq);
    return;
  }
  if (data.type !== "job") return;
  const { seq, kind } = data;
  if (_cancelled.has(seq)) {
    _cancelled.delete(seq);
    post({ type: "result", seq, ok: false, err: "cancelled" });
    return;
  }
  try {
    if (kind === "xu7") {
      let module = _module;
      if (!module) module = await _loadTranscoder();
      const t0 = _now();
      const r = transcodeXu7Payload(module, new Uint8Array(data.bytes), data.want);
      const transcodeMs = _now() - t0;
      const reply = {
        type: "result",
        seq,
        ok: true,
        kind,
        width: r.width,
        height: r.height,
        levelBytes: r.levelBytes,
        bc7: r.bc7.buffer,
        transcodeMs,
      };
      const transfers = [r.bc7.buffer];
      if (r.nra) {
        reply.nra = { width: r.nra.width, height: r.nra.height, plane: r.nra.plane.buffer };
        transfers.push(r.nra.plane.buffer);
      }
      post(reply, transfers);
      return;
    }
    if (kind === "terrain-assemble") {
      const t0 = _now();
      const r = assembleTerrainChannel(data);
      const assembleMs = _now() - t0;
      post(
        {
          type: "result",
          seq,
          ok: true,
          kind,
          tileSize: r.tileSize,
          levels: r.levels,
          depth: r.depth,
          levelBytes: r.levelBytes,
          bc7: r.bc7.buffer,
          assembleMs,
        },
        [r.bc7.buffer],
      );
      return;
    }
    if (kind === "nra-derive") {
      const rgba = new Uint8Array(data.rgba);
      const plane = deriveNraPlane(rgba, data.width, data.height, { strength: data.strength ?? 1.0 });
      if (plane.length === 0) throw new Error(`nra-derive: malformed input ${data.width}x${data.height}`);
      post(
        { type: "result", seq, ok: true, kind, width: data.width, height: data.height, plane: plane.buffer },
        [plane.buffer],
      );
      return;
    }
    throw new Error(`unknown job kind "${kind}"`);
  } catch (e) {
    post({ type: "result", seq, ok: false, err: String(e && e.message ? e.message : e) });
  }
}

// Worker scope only: node imports this module for its pure functions and must
// not see a message loop; the window must never eval this as a script.
const _IS_WORKER_SCOPE =
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof window === "undefined" &&
  typeof self.document === "undefined";

if (_IS_WORKER_SCOPE) {
  self.onmessage = (ev) => {
    handleTextureWorkerMessage(ev.data, (msg, transfers) => {
      try {
        self.postMessage(msg, transfers || []);
      } catch (e) {
        // A failed structured clone/transfer must still answer the seq, or the
        // client's pending map wedges (the never-settling-promise bug class).
        try {
          self.postMessage({
            type: "result",
            seq: msg && msg.seq,
            ok: false,
            err: `postMessage failed: ${String(e && e.message ? e.message : e)}`,
          });
        } catch (_) {
          /* nothing left to do */
        }
      }
    });
  };
}
