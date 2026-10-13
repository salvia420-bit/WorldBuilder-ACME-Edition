// tools/film/audio/features.mjs — frame features for the film-mode song analyser: resampling, log-mel (40),
// chroma-12, MFCC-13, frame RMS and the 0.5 s energy curve.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) needs beats, bars and sections to cut a music video. These are the
// standard MIR front-end features, hand-rolled so the Node tool has no dependencies and is bit-for-bit
// deterministic. Analysis runs at 22050 Hz with a centred STFT (nFft 2048, hop 512, periodic Hann), so feature
// frame t ↔ time t·512/22050 s (≈ 23.2 ms per frame, ≈ 43.07 frames/s).
//
// Choices (documented, all pure):
// - Resampling: Kaiser-windowed sinc (16 zero crossings, β 8.6, cutoff 0.945 × the lower Nyquist), kernel read
//   from a 512×-oversampled table with linear interpolation. Works for any rate pair, including non-integer.
// - Mel: HTK mel scale, 40 unit-peak triangles from 0 Hz to Nyquist on the power spectrum; log-mel in dB with a
//   global top-dB floor (max − 80 dB) so digital silence is flat (no spurious flux).
// - Chroma: magnitude spectrum 100–5000 Hz folded to 12 pitch classes (C=0 … B=11, A4 = 440 Hz) with Gaussian
//   pitch-class spreading (σ ≥ ½ semitone, wider where an FFT bin spans more than a semitone) and a gentle
//   octave weighting centred on A4; each frame L∞-normalised against a silence floor (1e-3 × loudest frame).
// - MFCC: orthonormal DCT-II of the 40 dB log-mel values, 13 coefficients (c0 ≈ loudness).
// - RMS: per centred 2048-sample frame (zeros outside the signal), from a prefix sum of squares.

import { forEachStftFrame, hannWindow, stftFrameCount } from "./fft.mjs";

/** Analysis sample rate (Hz) — the decoder asks ffmpeg for this rate; analyzeSong resamples anything else. */
export const ANALYSIS_SAMPLE_RATE = 22050;
/** STFT size (samples). */
export const N_FFT = 2048;
/** STFT hop (samples). */
export const HOP = 512;
/** Mel bands. */
export const N_MELS = 40;
/** MFCC coefficients (DCT-II of log-mel), including c0. */
export const N_MFCC = 13;
/** Chroma bins (pitch classes, C = 0). */
export const N_CHROMA = 12;
/** Pitch-class names for chroma index 0..11. */
export const PITCH_CLASSES = Object.freeze(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]);

/**
 * Modified Bessel function of the first kind, order 0 (power series; fine for the β ≤ 20 used here).
 * @param {number} x
 * @returns {number}
 */
export function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Band-limited resampling with a Kaiser-windowed sinc kernel. Returns a new Float32Array of
 * round(length · srOut / srIn) samples (a copy when the rates match).
 * @param {ArrayLike<number>} x mono signal
 * @param {number} srIn input rate (Hz, > 0)
 * @param {number} srOut output rate (Hz, > 0)
 * @param {{zeroCrossings?:number, rolloff?:number, kaiserBeta?:number, oversample?:number}} [opts]
 * @returns {Float32Array}
 */
export function resample(x, srIn, srOut, { zeroCrossings = 16, rolloff = 0.945, kaiserBeta = 8.6, oversample = 512 } = {}) {
  if (!(srIn > 0) || !(srOut > 0) || !Number.isFinite(srIn) || !Number.isFinite(srOut)) {
    throw new RangeError(`resample: sample rates must be positive finite numbers (got ${srIn} → ${srOut})`);
  }
  if (srIn === srOut) return Float32Array.from(x);
  const ratio = srOut / srIn;
  const fc = rolloff * Math.min(1, ratio); // cutoff relative to the input Nyquist
  const halfWidth = zeroCrossings / fc; // kernel half-width in input samples
  const tlen = zeroCrossings * oversample + 2;
  const table = new Float64Array(tlen);
  const i0b = besselI0(kaiserBeta);
  for (let i = 0; i < tlen; i++) {
    const u = i / oversample; // in sinc zero-crossing units
    const r = u / zeroCrossings;
    if (r >= 1) continue;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    table[i] = (sinc * besselI0(kaiserBeta * Math.sqrt(1 - r * r))) / i0b;
  }
  const n = x.length;
  const nOut = Math.max(0, Math.round(n * ratio));
  const out = new Float32Array(nOut);
  const scale = fc * oversample;
  const last = tlen - 1;
  for (let j = 0; j < nOut; j++) {
    const center = (j * srIn) / srOut;
    let k0 = Math.ceil(center - halfWidth);
    let k1 = Math.floor(center + halfWidth);
    if (k0 < 0) k0 = 0;
    if (k1 > n - 1) k1 = n - 1;
    let acc = 0;
    for (let k = k0; k <= k1; k++) {
      let d = center - k;
      if (d < 0) d = -d;
      const u = d * scale;
      const i = u | 0;
      if (i >= last) continue;
      const t0 = table[i];
      acc += x[k] * (t0 + (u - i) * (table[i + 1] - t0));
    }
    out[j] = acc * fc;
  }
  return out;
}

/** HTK mel scale. @param {number} hz @returns {number} */
export function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

/** Inverse HTK mel scale. @param {number} mel @returns {number} */
export function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Triangular mel filterbank over power-spectrum bins (HTK scale, unit-peak triangles).
 * @param {{sampleRate:number, nFft:number, nMels?:number, fmin?:number, fmax?:number}} opts
 * @returns {{nMels:number, nBins:number, centers:Float64Array, bands:{start:number, weights:Float64Array}[]}}
 */
export function melFilterbank({ sampleRate, nFft, nMels = N_MELS, fmin = 0, fmax = sampleRate / 2 }) {
  const nBins = nFft / 2 + 1;
  const binHz = sampleRate / nFft;
  const mMin = hzToMel(fmin);
  const mMax = hzToMel(fmax);
  const edges = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) edges[i] = melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1));
  const bands = [];
  for (let b = 0; b < nMels; b++) {
    const lo = edges[b];
    const c = edges[b + 1];
    const hi = edges[b + 2];
    const k0 = Math.max(0, Math.ceil(lo / binHz));
    const k1 = Math.min(nBins - 1, Math.floor(hi / binHz));
    const w = [];
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const f = k * binHz;
      const v = f <= c ? (f - lo) / Math.max(1e-12, c - lo) : (hi - f) / Math.max(1e-12, hi - c);
      const vv = Math.max(0, Math.min(1, v));
      w.push(vv);
      sum += vv;
    }
    if (sum <= 0) {
      // A band narrower than one bin: give it the nearest bin so it never reads silence by construction.
      const k = Math.min(nBins - 1, Math.max(0, Math.round(c / binHz)));
      bands.push({ start: k, weights: Float64Array.of(1) });
    } else {
      bands.push({ start: k0, weights: Float64Array.from(w) });
    }
  }
  return { nMels, nBins, centers: edges.slice(1, nMels + 1), bands };
}

/**
 * Chroma filterbank: a dense (bins × 12) weight table for magnitude bins in [fmin, fmax].
 * @param {{sampleRate:number, nFft:number, fmin?:number, fmax?:number, tuningA4?:number, octaveCenterHz?:number,
 *   octaveWidth?:number}} opts
 * @returns {{k0:number, k1:number, weights:Float32Array}} weights[(k − k0)·12 + pc]
 */
export function chromaFilterbank({ sampleRate, nFft, fmin = 100, fmax = 5000, tuningA4 = 440, octaveCenterHz = 440, octaveWidth = 2 }) {
  const binHz = sampleRate / nFft;
  const k0 = Math.max(1, Math.ceil(fmin / binHz));
  const k1 = Math.min(nFft / 2, Math.floor(Math.min(fmax, sampleRate / 2) / binHz));
  const nb = Math.max(0, k1 - k0 + 1);
  const weights = new Float32Array(nb * N_CHROMA);
  for (let k = k0; k <= k1; k++) {
    const f = k * binHz;
    const midi = 69 + 12 * Math.log2(f / tuningA4);
    const pc = ((midi % 12) + 12) % 12;
    const widthSemis = 12 * Math.log2((f + binHz / 2) / Math.max(1e-9, f - binHz / 2));
    const sigma = Math.max(0.5, 0.5 * widthSemis);
    const oct = Math.log2(f / octaveCenterHz) / octaveWidth;
    const octW = Math.exp(-0.5 * oct * oct);
    let sum = 0;
    const row = (k - k0) * N_CHROMA;
    for (let c = 0; c < N_CHROMA; c++) {
      let d = Math.abs(pc - c);
      if (d > 6) d = 12 - d;
      const w = Math.exp(-0.5 * (d / sigma) * (d / sigma));
      weights[row + c] = w;
      sum += w;
    }
    for (let c = 0; c < N_CHROMA; c++) weights[row + c] = (weights[row + c] / sum) * octW;
  }
  return { k0, k1, weights };
}

/**
 * Orthonormal DCT-II matrix (nOut × nIn, row-major): c_k = s_k Σ_n x_n cos(πk(2n+1)/(2·nIn)).
 * @param {number} nIn
 * @param {number} nOut
 * @returns {Float64Array}
 */
export function dctMatrix(nIn, nOut) {
  const m = new Float64Array(nOut * nIn);
  for (let k = 0; k < nOut; k++) {
    const s = k === 0 ? Math.sqrt(1 / nIn) : Math.sqrt(2 / nIn);
    for (let n = 0; n < nIn; n++) m[k * nIn + n] = s * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * nIn));
  }
  return m;
}

/**
 * Per-frame RMS over centred nFft windows (zeros outside the signal, divided by the full window length).
 * @param {ArrayLike<number>} x
 * @param {{nFft?:number, hop?:number}} [opts]
 * @returns {Float32Array}
 */
export function frameRms(x, { nFft = N_FFT, hop = HOP } = {}) {
  const n = x.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i] * x[i];
  const nFrames = stftFrameCount(n, hop);
  const out = new Float32Array(nFrames);
  const half = nFft >> 1;
  for (let t = 0; t < nFrames; t++) {
    const a = Math.max(0, t * hop - half);
    const b = Math.min(n, t * hop + half);
    out[t] = b > a ? Math.sqrt(Math.max(0, pre[b] - pre[a]) / nFft) : 0;
  }
  return out;
}

/**
 * Loudness curve: RMS over consecutive windows of `hopSec`, normalised so the loudest window is 1
 * (all zeros for silence). values.length = ceil(duration / hopSec).
 * @param {ArrayLike<number>} x
 * @param {number} sampleRate
 * @param {{hopSec?:number}} [opts]
 * @returns {{hopSec:number, values:Float64Array}}
 */
export function energyCurve(x, sampleRate, { hopSec = 0.5 } = {}) {
  const n = x.length;
  const win = Math.max(1, Math.round(hopSec * sampleRate));
  const count = Math.max(1, Math.ceil(n / win));
  const values = new Float64Array(count);
  let max = 0;
  for (let i = 0; i < count; i++) {
    const a = i * win;
    const b = Math.min(n, a + win);
    let s = 0;
    for (let j = a; j < b; j++) s += x[j] * x[j];
    const r = b > a ? Math.sqrt(s / (b - a)) : 0;
    values[i] = r;
    if (r > max) max = r;
  }
  if (max > 0) for (let i = 0; i < count; i++) values[i] /= max;
  return { hopSec, values };
}

/**
 * Converts power values to dB in place with a global floor: 10·log10(max(p, amin)), then clamped to (max − topDb).
 * @param {Float32Array|Float64Array} p
 * @param {{amin?:number, topDb?:number}} [opts]
 * @returns {{maxDb:number, floorDb:number}}
 */
export function powerToDbInPlace(p, { amin = 1e-10, topDb = 80 } = {}) {
  let maxDb = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const v = 10 * Math.log10(Math.max(amin, p[i]));
    p[i] = v;
    if (v > maxDb) maxDb = v;
  }
  if (!Number.isFinite(maxDb)) maxDb = 10 * Math.log10(amin);
  const floorDb = maxDb - topDb;
  for (let i = 0; i < p.length; i++) if (p[i] < floorDb) p[i] = floorDb;
  return { maxDb, floorDb };
}

/**
 * @typedef {object} FeatureSet
 * @property {number} sampleRate analysis rate (Hz)
 * @property {number} hop
 * @property {number} nFft
 * @property {number} nFrames
 * @property {number} frameRate frames per second (sampleRate / hop)
 * @property {number} durationSec
 * @property {number} nMels
 * @property {Float32Array} melDb frame-major nFrames × nMels log-mel (dB, floored at max − 80)
 * @property {Float64Array} melCenters band centre frequencies (Hz)
 * @property {Float32Array} chroma frame-major nFrames × 12 (C = 0), L∞-normalised per frame
 * @property {number} nMfcc
 * @property {Float32Array} mfcc frame-major nFrames × nMfcc
 * @property {Float32Array} rms per-frame RMS (linear)
 */

/**
 * One streaming STFT pass → log-mel, chroma, MFCC and RMS for every frame.
 * @param {ArrayLike<number>} pcm mono samples (any rate; the analyser passes 22050 Hz)
 * @param {number} sampleRate
 * @param {{nFft?:number, hop?:number, nMels?:number, nMfcc?:number, topDb?:number}} [opts]
 * @returns {FeatureSet}
 */
export function computeFeatures(pcm, sampleRate, { nFft = N_FFT, hop = HOP, nMels = N_MELS, nMfcc = N_MFCC, topDb = 80 } = {}) {
  const melFb = melFilterbank({ sampleRate, nFft, nMels });
  const chFb = chromaFilterbank({ sampleRate, nFft });
  const nFrames = stftFrameCount(pcm.length, hop);
  const melDb = new Float32Array(nFrames * nMels);
  const chroma = new Float32Array(nFrames * N_CHROMA);
  const chromaMax = new Float32Array(nFrames);
  const nCh = chFb.k1 - chFb.k0 + 1;
  const acc = new Float64Array(N_CHROMA);
  forEachStftFrame(pcm, { nFft, hop, window: hannWindow(nFft) }, (t, pow) => {
    const mo = t * nMels;
    for (let b = 0; b < nMels; b++) {
      const { start, weights } = melFb.bands[b];
      let s = 0;
      for (let i = 0; i < weights.length; i++) s += weights[i] * pow[start + i];
      melDb[mo + b] = s;
    }
    acc.fill(0);
    for (let i = 0; i < nCh; i++) {
      const mag = Math.sqrt(pow[chFb.k0 + i]);
      if (mag === 0) continue;
      const row = i * N_CHROMA;
      for (let c = 0; c < N_CHROMA; c++) acc[c] += mag * chFb.weights[row + c];
    }
    let mx = 0;
    const co = t * N_CHROMA;
    for (let c = 0; c < N_CHROMA; c++) {
      chroma[co + c] = acc[c];
      if (acc[c] > mx) mx = acc[c];
    }
    chromaMax[t] = mx;
  });
  powerToDbInPlace(melDb, { topDb });
  let globalMax = 0;
  for (let t = 0; t < nFrames; t++) if (chromaMax[t] > globalMax) globalMax = chromaMax[t];
  const floor = Math.max(1e-12, globalMax * 1e-3);
  for (let t = 0; t < nFrames; t++) {
    const d = Math.max(chromaMax[t], floor);
    const co = t * N_CHROMA;
    for (let c = 0; c < N_CHROMA; c++) chroma[co + c] /= d;
  }
  const dct = dctMatrix(nMels, nMfcc);
  const mfcc = new Float32Array(nFrames * nMfcc);
  for (let t = 0; t < nFrames; t++) {
    const mo = t * nMels;
    const oo = t * nMfcc;
    for (let k = 0; k < nMfcc; k++) {
      let s = 0;
      const row = k * nMels;
      for (let b = 0; b < nMels; b++) s += dct[row + b] * melDb[mo + b];
      mfcc[oo + k] = s;
    }
  }
  const rms = frameRms(pcm, { nFft, hop });
  return {
    sampleRate,
    hop,
    nFft,
    nFrames,
    frameRate: sampleRate / hop,
    durationSec: pcm.length / sampleRate,
    nMels,
    melDb,
    melCenters: melFb.centers,
    chroma,
    nMfcc,
    mfcc,
    rms,
  };
}
