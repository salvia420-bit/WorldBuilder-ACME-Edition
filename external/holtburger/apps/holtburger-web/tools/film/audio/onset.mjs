// tools/film/audio/onset.mjs — onset-strength envelope for the film-mode song analyser.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) cuts on beats; beats come from an onset-strength envelope.
// Envelope = log-mel spectral flux: per band the frame-to-frame increase in dB (half-wave rectified), averaged over
// the 40 bands, minus a ±0.5 s local mean (rectified again, which removes the busy-mix noise floor), then divided
// by its standard deviation so the beat tracker's tightness (100) has its usual meaning.
//
// Timing: with centred 2048-sample windows a sharp onset at τ first shows up in the frame whose window's leading edge
// has just passed τ (the dB jump from silence happens on the window taper), i.e. 1–2 frames BEFORE τ; with a noise
// floor under the onset the jump lands about one frame later. Measured on synthetic clicks and drum loops the raw
// envelope peak sits 1.1–1.6 frames early on clean material and 0.3–0.5 frames early under noise, so envelope
// index e maps to time (e + ONSET_FRAME_SHIFT) / frameRate with ONSET_FRAME_SHIFT = 1.0 frame (≈ 23 ms), which
// keeps beat times within about −5..+15 ms of the true onsets in both regimes (librosa pads 2 frames for the same
// effect).

/** Envelope frame offset (frames) that maps envelope index → onset time; see the header. */
export const ONSET_FRAME_SHIFT = 1.0;

/**
 * Mean half-wave-rectified first difference of a frame-major dB matrix (lag 1); flux[0] = 0.
 * @param {Float32Array|Float64Array} melDb nFrames × nMels
 * @param {number} nFrames
 * @param {number} nMels
 * @returns {Float64Array}
 */
export function spectralFlux(melDb, nFrames, nMels) {
  const flux = new Float64Array(nFrames);
  for (let t = 1; t < nFrames; t++) {
    const a = t * nMels;
    const b = a - nMels;
    let s = 0;
    for (let k = 0; k < nMels; k++) {
      const d = melDb[a + k] - melDb[b + k];
      if (d > 0) s += d;
    }
    flux[t] = s / nMels;
  }
  return flux;
}

/**
 * Centred moving average over [i − h, i + h] (clipped at the ends, divided by the in-range count).
 * @param {ArrayLike<number>} x
 * @param {number} halfWidth
 * @returns {Float64Array}
 */
export function movingAverage(x, halfWidth) {
  const n = x.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const out = new Float64Array(n);
  const h = Math.max(0, Math.floor(halfWidth));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(n, i + h + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

/**
 * Sample standard deviation (n − 1), 0 for fewer than two values.
 * @param {ArrayLike<number>} x
 * @returns {number}
 */
export function stdDev(x) {
  const n = x.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - m) * (x[i] - m);
  return Math.sqrt(s / (n - 1));
}

/**
 * @typedef {object} OnsetEnvelope
 * @property {Float64Array} env local-mean-subtracted, rectified, std-normalised onset strength (≥ 0)
 * @property {Float64Array} flux raw log-mel flux (dB per band), before local-mean subtraction
 * @property {number} frameRate envelope frames per second
 * @property {number} shift ONSET_FRAME_SHIFT (envelope index e ↔ time (e + shift) / frameRate)
 */

/**
 * Onset-strength envelope from a FeatureSet (features.mjs computeFeatures).
 * @param {{melDb:Float32Array, nFrames:number, nMels:number, frameRate:number}} features
 * @param {{localMeanSec?:number}} [opts] half-width of the subtracted local mean (default 0.5 s)
 * @returns {OnsetEnvelope}
 */
export function onsetEnvelope(features, { localMeanSec = 0.5 } = {}) {
  const { melDb, nFrames, nMels, frameRate } = features;
  const flux = spectralFlux(melDb, nFrames, nMels);
  const lm = movingAverage(flux, Math.max(1, Math.round(localMeanSec * frameRate)));
  const env = new Float64Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    const v = flux[t] - lm[t];
    env[t] = v > 0 ? v : 0;
  }
  const sd = stdDev(env);
  if (sd > 0) for (let t = 0; t < nFrames; t++) env[t] /= sd;
  return { env, flux, frameRate, shift: ONSET_FRAME_SHIFT };
}

/**
 * Envelope frame index (may be fractional) → seconds.
 * @param {number} frame
 * @param {number} frameRate
 * @returns {number}
 */
export function envFrameToSec(frame, frameRate) {
  return (frame + ONSET_FRAME_SHIFT) / frameRate;
}

/**
 * Seconds → envelope frame index (fractional).
 * @param {number} sec
 * @param {number} frameRate
 * @returns {number}
 */
export function secToEnvFrame(sec, frameRate) {
  return sec * frameRate - ONSET_FRAME_SHIFT;
}
