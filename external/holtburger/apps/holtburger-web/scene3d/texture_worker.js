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
      nra = {
        width: nw,
        height: nh,
        plane,
        hasRelief: plane.hasRelief !== false,
        normalRgba: plane.normalRgba || null,
        heightR8: plane.heightR8 || null,
      };
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

/** Separable wrap-around box blur of radius `r` (`(2r+1)x(2r+1)`). */
function _boxBlurWrap(src, w, h, radius) {
  const n = w * h;
  const r = Math.max(0, radius | 0);
  if (r === 0 || n <= 1) return new Float32Array(src);
  const inv = F(1.0 / (2 * r + 1));
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let acc = 0.0;
      for (let dx = -r; dx <= r; dx += 1) {
        const sx = ((x + dx) % w + w) % w;
        acc += src[row + sx];
      }
      tmp[row + x] = F(acc * inv);
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0.0;
      for (let dy = -r; dy <= r; dy += 1) {
        const sy = ((y + dy) % h + h) % h;
        acc += tmp[sy * w + x];
      }
      out[y * w + x] = F(acc * inv);
    }
  }
  return out;
}

/**
 * Multi-scale polarity-safe 8-bit height synthesis from RGBA albedo (`0..255`,
 * `255` = proud outer surface / neutral flat, `0` = recessed joint/crevice).
 *
 * Combines:
 *  - macro & mid wrap-around box blurs (`9x9` / `5x5`) for stone/brick pillows,
 *  - dark mortar/crevice joint recessing `max(0, L_macro - L)`,
 *  - gradient-gated narrow bright-grout recessing so dark stone blocks with
 *    pale lime mortar recess the narrow grout lines instead of inverting them,
 *  - fine grain `L - L_fine` on block faces,
 *  - flatness & alpha-cutout (`alpha < 200`) rejection (`hasRelief: false`,
 *    neutral flat `255`) so uniform trim, banners, foliage cards, wildflowers,
 *    and fences never receive POM distortion.
 */
export function heightFromLuminance(rgba, w, h, strength = 1.0) {
  const width = w | 0;
  const height = h | 0;
  const pixelCount = width * height;
  if (pixelCount <= 0 || !rgba || rgba.length < pixelCount * 4) {
    return { height: new Uint8Array(0), hasRelief: false };
  }
  const lum = new Float32Array(pixelCount);
  let sumL = 0.0;
  let minL = 1.0;
  let maxL = 0.0;
  let cutoutCount = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const o = i * 4;
    const l = F(
      (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) * (1.0 / 255.0)
    );
    lum[i] = l;
    sumL += l;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
    if (rgba[o + 3] < 200) cutoutCount += 1;
  }

  // Pre-filter <=64px tiles with 3x3 Gaussian (matching normal_gen.rs) so 1px
  // paletted Bayer dithering is rejected instead of turning into POM spikes.
  const baseLum =
    width <= LOW_RES_THRESHOLD || height <= LOW_RES_THRESHOLD
      ? _gaussianBlur3x3(lum, width, height)
      : lum;

  // Measure variance/range excluding the 1px clamped border when dims >= 4 so
  // _gaussianBlur3x3 border clamping on 1px Nyquist dithers cannot masquerade
  // as real surface relief.
  const x0 = width >= 4 ? 1 : 0;
  const x1 = width >= 4 ? width - 1 : width;
  const y0 = height >= 4 ? 1 : 0;
  const y1 = height >= 4 ? height - 1 : height;
  const sampleCount = Math.max(1, (x1 - x0) * (y1 - y0));
  let sumB = 0.0;
  let minB = 1.0;
  let maxB = 0.0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const b = baseLum[row + x];
      sumB += b;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
  }
  const meanL = sumB / sampleCount;
  let varAcc = 0.0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const d = baseLum[row + x] - meanL;
      varAcc += d * d;
    }
  }
  const varL = varAcc / sampleCount;
  const rangeL = maxB - minB;
  const cutoutFrac = cutoutCount / pixelCount;

  // Reject heavily alpha-cutout surfaces (foliage, wildflowers, grates, fences):
  // emit neutral flat 255 height and mark hasRelief: false.
  if (cutoutFrac > 0.05) {
    const flat = new Uint8Array(pixelCount);
    flat.fill(255);
    return { height: flat, hasRelief: false };
  }

  // Reject near-uniform/flat or pure-1px-dither tiles (plaster, solid trim,
  // banners, Nyquist checkerboards): mark hasRelief: false and emit neutral
  // micro-AO (~255 on uniform tiles) so POM stays off.
  if (varL < 0.0006 || rangeL < 0.055) {
    return { height: aoFromLuminance(rgba, width, height, strength), hasRelief: false };
  }

  const lumFine = _boxBlurWrap(baseLum, width, height, 1);   // 3x3 fine grain ref
  const lumMacroRaw = _boxBlurWrap(lum, width, height, 4);   // 9x9 raw macro baseline

  // Separable 9x9 wrap-around min/max matching `lumMacroRaw` (radius = 4) so
  // `brightExcursion` and `darkExcursion` are measured over the exact same
  // 9x9 window (preventing stone block centers 4px from a dark mortar line from
  // missing the dark trench).
  const minH = new Float32Array(pixelCount);
  const maxH = new Float32Array(pixelCount);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let lo = 1.0;
      let hi = 0.0;
      for (let dx = -4; dx <= 4; dx += 1) {
        const v = lum[row + (((x + dx) % width + width) % width)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      minH[row + x] = lo;
      maxH[row + x] = hi;
    }
  }
  const paleSeam = new Float32Array(pixelCount);
  const clampedLum = new Float32Array(pixelCount);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      let lo = 1.0;
      let hi = 0.0;
      for (let dy = -4; dy <= 4; dy += 1) {
        const idx = (((y + dy) % height + height) % height) * width + x;
        if (minH[idx] < lo) lo = minH[idx];
        if (maxH[idx] > hi) hi = maxH[idx];
      }
      const lMr = lumMacroRaw[i];
      const brightExcursion = Math.max(0.0, hi - lMr);
      const darkExcursion = Math.max(0.0, lMr - lo);
      if (brightExcursion > darkExcursion * 1.15 + 0.03) {
        const ridge = Math.max(0.0, Math.max(lum[i], baseLum[i]) - lMr - 0.015);
        paleSeam[i] = ridge * 1.45;
        clampedLum[i] = Math.min(baseLum[i], lMr);
      } else {
        paleSeam[i] = 0.0;
        clampedLum[i] = baseLum[i];
      }
    }
  }

  const paleShoulder = _boxBlurWrap(paleSeam, width, height, 1);
  const lumMid = _boxBlurWrap(clampedLum, width, height, 2);   // 5x5 shoulder ref
  const lumMacro = _boxBlurWrap(clampedLum, width, height, 4); // 9x9 block pillow ref

  const rawH = new Float32Array(pixelCount);
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (let i = 0; i < pixelCount; i += 1) {
    const lc = clampedLum[i];
    const lf = lumFine[i];
    const lm = lumMid[i];
    const lM = lumMacro[i];

    const darkSeam = Math.max(0.0, lM - lc) + 0.55 * Math.max(0.0, lm - lc);
    const lightSeam = Math.max(paleSeam[i], paleShoulder[i] * 0.65);
    const seam = darkSeam + lightSeam;
    const jointMask = Math.max(0.0, 1.0 - seam * 3.0);
    const grain = (lum[i] - lf) * 0.25 * jointMask;
    const hVal = 1.0 - seam * 1.25 + grain;
    rawH[i] = hVal;
    if (hVal < rawMin) rawMin = hVal;
    if (hVal > rawMax) rawMax = hVal;
  }

  const rawRange = rawMax - rawMin;
  if (!(rawRange > 1e-5)) {
    const flat = new Uint8Array(pixelCount);
    flat.fill(255);
    return { height: flat, hasRelief: false };
  }

  // O(N) 256-bin percentile calibration: p96 -> 255 (proud block face),
  // p03 -> deepest joint floor, scaled by relief contrast + strength.
  const hist = new Uint32Array(256);
  const invRange = 255.0 / rawRange;
  for (let i = 0; i < pixelCount; i += 1) {
    const b = Math.min(255, Math.max(0, ((rawH[i] - rawMin) * invRange) | 0));
    hist[b] += 1;
  }
  const loTarget = Math.max(1, Math.floor(pixelCount * 0.03));
  const hiTarget = Math.max(loTarget, Math.ceil(pixelCount * 0.96));
  let acc = 0;
  let loBin = 0;
  let hiBin = 255;
  let foundLo = false;
  for (let b = 0; b < 256; b += 1) {
    acc += hist[b];
    if (!foundLo && acc >= loTarget) {
      loBin = b;
      foundLo = true;
    }
    if (acc >= hiTarget) {
      hiBin = b;
      break;
    }
  }
  const p03 = rawMin + (loBin / 255.0) * rawRange;
  const p96 = rawMin + (Math.min(255, hiBin + 1) / 255.0) * rawRange;
  const span = Math.max(1e-5, hiBin > loBin ? p96 - p03 : rawRange);
  const baseLo = hiBin > loBin ? p03 : rawMin;
  const fs = Math.max(0.25, Number.isFinite(strength) ? strength : 1.0);
  const depthGain = Math.min(1.0, Math.max(0.35, span * 3.2 * fs));

  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const t = Math.min(1.0, Math.max(0.0, (rawH[i] - baseLo) / span));
    const hNorm = 1.0 - (1.0 - t) * depthGain;
    out[i] = Math.min(255, Math.max(0, Math.round(hNorm * 255.0)));
  }
  return { height: out, hasRelief: true };
}

/**
 * The packed NRA plane: RGBA8, R/G = tangent normal XY, B = roughness,
 * A = calibrated 8-bit POM height (`255` = proud/flat, `0` = deep joint).
 * `Uint8Array(w*h*4)` with `.hasRelief` boolean attached for worker/main-thread
 * POM gating; an empty plane is returned when dims are malformed.
 */
export function deriveNraPlane(rgba, w, h, { strength = 1.0 } = {}) {
  const pixelCount = (w | 0) * (h | 0);
  if (pixelCount <= 0 || !rgba || rgba.length < pixelCount * 4) return new Uint8Array(0);
  const normal = normalFromLuminance(rgba, w, h, strength);
  const rough = roughnessFromLuminance(rgba, w, h, strength);
  const { height: hgt, hasRelief } = heightFromLuminance(rgba, w, h, strength);
  const out = new Uint8Array(pixelCount * 4);
  const normalRgba = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const p4 = i * 4;
    const p3 = i * 3;
    const nx = normal.length ? normal[p3] : 128;
    const ny = normal.length ? normal[p3 + 1] : 128;
    const nz = normal.length ? normal[p3 + 2] : 255;
    out[p4] = nx;
    out[p4 + 1] = ny;
    out[p4 + 2] = rough.length ? rough[i] : 0;
    out[p4 + 3] = hgt.length ? hgt[i] : 255;
    normalRgba[p4] = nx;
    normalRgba[p4 + 1] = ny;
    normalRgba[p4 + 2] = nz;
    normalRgba[p4 + 3] = 255;
  }
  out.hasRelief = hasRelief;
  Object.defineProperty(out, "normalRgba", { value: normalRgba, enumerable: false });
  Object.defineProperty(out, "heightR8", { value: hgt.length ? hgt : null, enumerable: false });
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
        reply.nra = {
          width: r.nra.width,
          height: r.nra.height,
          plane: r.nra.plane.buffer,
          hasRelief: r.nra.hasRelief !== false,
        };
        transfers.push(r.nra.plane.buffer);
        if (r.nra.normalRgba && r.nra.normalRgba.buffer) {
          reply.nra.normalRgba = r.nra.normalRgba.buffer;
          transfers.push(r.nra.normalRgba.buffer);
        }
        if (r.nra.heightR8 && r.nra.heightR8.buffer) {
          reply.nra.heightR8 = r.nra.heightR8.buffer;
          transfers.push(r.nra.heightR8.buffer);
        }
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
        {
          type: "result",
          seq,
          ok: true,
          kind,
          width: data.width,
          height: data.height,
          plane: plane.buffer,
          hasRelief: plane.hasRelief !== false,
        },
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
  self.onerror = (e) => {
    try {
      self.postMessage({
        type: "error",
        err: "texture_worker uncaught error: " + ((e && e.message) || e),
      });
    } catch (_) {}
  };
  self.onunhandledrejection = (ev) => {
    const reason = ev && ev.reason;
    try {
      self.postMessage({
        type: "error",
        err: "texture_worker unhandled rejection: " + ((reason && reason.message) || reason),
      });
    } catch (_) {}
  };
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
