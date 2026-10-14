// tools/film/audio/tempo.mjs — tempo, beats, downbeats and bars for the film-mode song analyser.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) cuts a music video on the beat and changes shots on bar lines.
// Pipeline (pure, deterministic):
//   1. Tempo — autocorrelation of the onset envelope over lags for 50–220 BPM, weighted by a log-normal prior
//      (centre 120 BPM, σ 0.9 octave); parabolic peak refinement, then a harmonic refinement that re-measures the
//      period from the peaks at 2..8 × the lag (precision ~0.1 frame); then the double/half check below.
//   2. Octave (double/half) check by harmonic support: put a pulse comb at the slower grid, best phase, and take
//      off/on = mean onset strength at the grid's midpoints ÷ at its pulses, scaled by prior(fast)/prior(slow). If
//      that is ≥ 0.55 the true beat is twice as fast (a 140 BPM kick/snare loop whose ac/prior favoured 70: the
//      backbeat snares carry ~0.6 of the kicks); if, checking the half tempo, it is < 0.3 the beat is half as fast.
//      Both candidates must stay inside [minBpm, maxBpm]. Measured on synthetic loops, eighth-note hats at a slow
//      tempo score ≤ 0.52 (70 BPM) and backbeats at the doubled tempo ≥ 0.6 up to ~170 BPM; fast drum loops with a
//      weak backbeat (≥ ~170 BPM) can still read at half tempo, the usual metrical-level ambiguity.
//   3. Beats — Ellis (2007) dynamic programming, librosa-style (Gaussian local score σ = period/32, transition
//      window [−2P, −P/2], cost −tightness·log²(Δ/P), tightness 100, weak-edge trim), then each beat is moved to the
//      onset peak within ±0.1 period (parabolic sub-frame), then the grid is regularised (beats closer than 0.6 IBI
//      dropped, gaps of ≈k IBIs filled) so bar counting stays in phase.
//   4. Downbeats (4/4) — z-scored beat-synchronous accents (raw onset flux at the beat + low-band (< 180 Hz) energy
//      just after it + chroma change across it, 2-beat windows); the phase 0..3 with the highest mean accent wins.
//   5. Bars — consecutive downbeats; gaps ≥ 1.5 bars are filled on the bar grid; extrapolated BEFORE the first
//      downbeat (whole bars that start ≥ 0, a start within 5 % of a bar before 0 clamps to 0) and AFTER the last
//      (while at least half a bar of audio remains), so bars cover the song for section snapping.
// BPM reported = 60 / mean of the inlier inter-beat intervals (within ±15 % of the median), falling back to the
// autocorrelation period when fewer than 4 beats exist.

import { ONSET_FRAME_SHIFT } from "./onset.mjs";

/** Defaults for tempo/beat/downbeat estimation. */
export const TEMPO_DEFAULTS = Object.freeze({
  minBpm: 50,
  maxBpm: 220,
  priorBpm: 120,
  priorSigmaOct: 0.9,
  octaveUpRatio: 0.55,
  octaveDownRatio: 0.3,
  tightness: 100,
  beatsPerBar: 4,
});

/**
 * Log-normal tempo prior: exp(−½·(log2(bpm/priorBpm)/σ)²).
 * @param {number} bpm
 * @param {{priorBpm?:number, priorSigmaOct?:number}} [opts]
 * @returns {number}
 */
export function tempoPrior(bpm, { priorBpm = TEMPO_DEFAULTS.priorBpm, priorSigmaOct = TEMPO_DEFAULTS.priorSigmaOct } = {}) {
  if (!(bpm > 0)) return 0;
  const z = Math.log2(bpm / priorBpm) / priorSigmaOct;
  return Math.exp(-0.5 * z * z);
}

/**
 * Mean-removed, unbiased autocorrelation r[lag] = Σ e[i]e[i+lag] / (n − lag) for lag 0..maxLag.
 * @param {ArrayLike<number>} x
 * @param {number} maxLag
 * @returns {Float64Array}
 */
export function autocorrelation(x, maxLag) {
  const n = x.length;
  if (n === 0) return new Float64Array(0);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) e[i] = x[i] - mean;
  const L = Math.max(0, Math.min(Math.floor(maxLag), n - 1));
  const ac = new Float64Array(L + 1);
  for (let lag = 0; lag <= L; lag++) {
    let s = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) s += e[i] * e[i + lag];
    ac[lag] = s / m;
  }
  return ac;
}

/**
 * Vertex offset of the parabola through (−1, a), (0, b), (1, c), clamped to [−0.5, 0.5]; 0 when b is not a
 * strict local maximum shape.
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
export function parabolicOffset(a, b, c) {
  const den = a - 2 * b + c;
  if (!(den < 0)) return 0;
  const d = (0.5 * (a - c)) / den;
  return Math.max(-0.5, Math.min(0.5, d));
}

function median(arr) {
  if (arr.length === 0) return NaN;
  const s = Array.from(arr).sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function maxAround(x, i, r) {
  let best = 0;
  const a = Math.max(0, i - r);
  const b = Math.min(x.length - 1, i + r);
  for (let j = a; j <= b; j++) if (x[j] > best) best = x[j];
  return best;
}

/**
 * Pulse-comb support at period T (frames): the best-phase mean onset strength on the grid, the mean strength at the
 * grid's midpoints (off-beats), and their ratio.
 * @param {ArrayLike<number>} env
 * @param {number} period
 * @returns {{on:number, off:number, ratio:number, phase:number}}
 */
export function combSupport(env, period) {
  const n = env.length;
  if (!(period >= 1) || n < 2) return { on: 0, off: 0, ratio: 0, phase: 0 };
  const nPh = Math.max(1, Math.round(period));
  let best = -1;
  let bestPhase = 0;
  for (let ph = 0; ph < nPh; ph++) {
    let s = 0;
    let c = 0;
    for (let k = 0; ; k++) {
      const pos = Math.round(ph + k * period);
      if (pos >= n) break;
      s += maxAround(env, pos, 1);
      c++;
    }
    const v = c ? s / c : 0;
    if (v > best) {
      best = v;
      bestPhase = ph;
    }
  }
  let s2 = 0;
  let c2 = 0;
  for (let k = 0; ; k++) {
    const pos = Math.round(bestPhase + (k + 0.5) * period);
    if (pos >= n) break;
    s2 += maxAround(env, pos, 1);
    c2++;
  }
  const off = c2 ? s2 / c2 : 0;
  return { on: Math.max(0, best), off, ratio: best > 0 ? off / best : 0, phase: bestPhase };
}

/**
 * Harmonic refinement: re-measure the period from autocorrelation peaks near k·P (k = 2..maxK), each with
 * parabolic interpolation, combined as a running weighted mean (weight k·peak height).
 * @param {Float64Array} acn normalised autocorrelation
 * @param {number} p0 initial period (frames)
 * @param {number} [maxK]
 * @returns {number}
 */
export function refinePeriodHarmonics(acn, p0, maxK = 8) {
  let p = p0;
  const h0 = Math.max(1e-6, interpLinear(acn, p0));
  let num = p0 * h0;
  let den = h0;
  for (let k = 2; k <= maxK; k++) {
    const target = k * p;
    const r = Math.max(1, Math.round(0.5 + 0.2 * k));
    const c = Math.round(target);
    if (c + r + 1 >= acn.length) break;
    let jBest = -1;
    let vBest = -Infinity;
    for (let j = c - r; j <= c + r; j++) {
      if (j < 1) continue;
      if (acn[j] > vBest) {
        vBest = acn[j];
        jBest = j;
      }
    }
    if (jBest < 1 || !(vBest > 0)) continue;
    if (acn[jBest] < acn[jBest - 1] || acn[jBest] < acn[jBest + 1]) continue; // peak lies outside the window
    const lam = jBest + parabolicOffset(acn[jBest - 1], acn[jBest], acn[jBest + 1]);
    const w = k * vBest;
    num += (lam / k) * w;
    den += w;
    p = num / den;
  }
  return p;
}

function interpLinear(x, pos) {
  if (pos <= 0) return x[0] ?? 0;
  const i = Math.floor(pos);
  if (i >= x.length - 1) return x[x.length - 1] ?? 0;
  const f = pos - i;
  return x[i] + f * (x[i + 1] - x[i]);
}

/**
 * @typedef {object} TempoEstimate
 * @property {number} bpm
 * @property {number} period beat period in envelope frames (fractional)
 * @property {number} clarity normalised autocorrelation at the period (0..1)
 * @property {'kept'|'doubled'|'halved'|'fallback'} octave what the double/half check did
 * @property {{bpm:number, ac:number, score:number}[]} candidates top autocorrelation peaks (prior-weighted)
 */

/**
 * Global tempo from an onset envelope.
 * @param {ArrayLike<number>} env onset envelope (≥ 0)
 * @param {number} frameRate envelope frames per second
 * @param {Partial<typeof TEMPO_DEFAULTS>} [opts]
 * @returns {TempoEstimate}
 */
export function estimateTempo(env, frameRate, opts = {}) {
  const o = { ...TEMPO_DEFAULTS, ...opts };
  const n = env.length;
  const fallback = {
    bpm: o.priorBpm,
    period: (60 * frameRate) / o.priorBpm,
    clarity: 0,
    octave: /** @type {'fallback'} */ ("fallback"),
    candidates: [],
  };
  const minLag = Math.max(2, Math.floor((60 * frameRate) / o.maxBpm));
  const maxLag = Math.ceil((60 * frameRate) / o.minBpm);
  if (n < minLag * 4 + 4) return fallback;
  const acMax = Math.min(n - 2, maxLag * 8 + 8);
  const ac = autocorrelation(env, acMax);
  if (!(ac[0] > 0)) return fallback;
  const acn = new Float64Array(ac.length);
  for (let i = 0; i < ac.length; i++) acn[i] = ac[i] / ac[0];
  const cands = [];
  for (let L = minLag; L <= maxLag && L + 1 < acn.length; L++) {
    if (!(acn[L] > 0)) continue;
    if (acn[L] < acn[L - 1] || acn[L] < acn[L + 1]) continue;
    const bpm = (60 * frameRate) / L;
    cands.push({ lag: L, bpm, ac: acn[L], score: acn[L] * tempoPrior(bpm, o) });
  }
  if (cands.length === 0) return fallback;
  let best = cands[0];
  for (const c of cands) if (c.score > best.score) best = c;
  const L = best.lag;
  let period = L + parabolicOffset(acn[L - 1], acn[L], acn[L + 1]);
  period = refinePeriodHarmonics(acn, period);
  let octave = /** @type {'kept'|'doubled'|'halved'} */ ("kept");
  const bpmOf = (p) => (60 * frameRate) / p;
  // Effective off/on ratio of the slower grid, scaled by how much the prior prefers the faster tempo.
  const priorFavour = (pSlow) => tempoPrior(bpmOf(pSlow / 2), o) / Math.max(1e-9, tempoPrior(bpmOf(pSlow), o));
  if (bpmOf(period / 2) <= o.maxBpm * 1.02 && period / 2 >= 2) {
    const up = combSupport(env, period);
    if (up.ratio * priorFavour(period) >= o.octaveUpRatio) {
      period /= 2;
      octave = "doubled";
    }
  }
  if (octave === "kept" && bpmOf(period * 2) >= o.minBpm * 0.98 && period * 2 < n / 4) {
    const down = combSupport(env, period * 2);
    if (down.on > 0 && down.ratio * priorFavour(period * 2) < o.octaveDownRatio) {
      period *= 2;
      octave = "halved";
    }
  }
  const clarity = Math.max(0, Math.min(1, interpLinear(acn, period)));
  const top = cands
    .slice()
    .sort((a, b) => b.score - a.score || a.lag - b.lag)
    .slice(0, 5)
    .map((c) => ({ bpm: c.bpm, ac: c.ac, score: c.score }));
  return { bpm: bpmOf(period), period, clarity, octave, candidates: top };
}

/**
 * librosa-style local score: the envelope smoothed with a Gaussian of σ = period/32 frames.
 * @param {ArrayLike<number>} env
 * @param {number} period
 * @returns {Float64Array}
 */
export function beatLocalScore(env, period) {
  const n = env.length;
  const sigma = Math.max(1e-3, period / 32);
  const r = Math.max(1, Math.ceil(4 * sigma));
  const win = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) win[i + r] = Math.exp(-0.5 * (i / sigma) * (i / sigma));
  const out = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = -r; i <= r; i++) {
      const j = t - i;
      if (j >= 0 && j < n) s += env[j] * win[i + r];
    }
    out[t] = s;
  }
  return out;
}

/**
 * Ellis (2007) dynamic-programming beat tracker on an onset envelope. Returns integer envelope frames.
 * @param {ArrayLike<number>} env onset envelope (std-normalised)
 * @param {number} period beat period in frames
 * @param {{tightness?:number, trim?:boolean}} [opts]
 * @returns {Int32Array}
 */
export function trackBeats(env, period, { tightness = TEMPO_DEFAULTS.tightness, trim = true } = {}) {
  const n = env.length;
  if (n === 0 || !(period > 1)) return new Int32Array(0);
  const ls = beatLocalScore(env, period);
  let lsMax = 0;
  for (let t = 0; t < n; t++) if (ls[t] > lsMax) lsMax = ls[t];
  if (!(lsMax > 0)) return new Int32Array(0);
  const wLo = -Math.round(2 * period);
  const wHi = -Math.max(1, Math.round(period / 2));
  const nW = wHi - wLo + 1;
  const txwt = new Float64Array(nW);
  for (let i = 0; i < nW; i++) {
    const r = Math.log(-(wLo + i) / period);
    txwt[i] = -tightness * r * r;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let first = true;
  for (let t = 0; t < n; t++) {
    let bestV = -Infinity;
    let bestI = 0;
    for (let i = 0; i < nW; i++) {
      const p = t + wLo + i;
      const v = txwt[i] + (p >= 0 ? cum[p] : 0);
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }
    cum[t] = ls[t] + bestV;
    if (first && ls[t] < 0.01 * lsMax) {
      back[t] = -1;
    } else {
      back[t] = t + wLo + bestI;
      first = false;
    }
  }
  const maxima = [];
  for (let t = 0; t < n; t++) {
    const left = t === 0 || cum[t] > cum[t - 1];
    const right = t === n - 1 || cum[t] >= cum[t + 1];
    if (left && right) maxima.push(t);
  }
  let last = -1;
  if (maxima.length) {
    const med = median(maxima.map((t) => cum[t]));
    for (const t of maxima) if (cum[t] > 0.5 * med) last = t;
  }
  if (last < 0) {
    last = 0;
    for (let t = 1; t < n; t++) if (cum[t] > cum[last]) last = t;
  }
  let beats = [last];
  while (back[beats[beats.length - 1]] >= 0) beats.push(back[beats[beats.length - 1]]);
  beats.reverse();
  if (trim && beats.length > 2) {
    const vals = beats.map((b) => ls[b]);
    const sm = vals.map((v, i) => 0.5 * (vals[i - 1] ?? 0) + v + 0.5 * (vals[i + 1] ?? 0));
    let ms = 0;
    for (const v of sm) ms += v * v;
    const thr = 0.5 * Math.sqrt(ms / sm.length);
    let a = sm.findIndex((v) => v > thr);
    let b = sm.length - 1;
    while (b >= 0 && !(sm[b] > thr)) b--;
    if (a < 0) a = 0;
    if (b < a) b = sm.length - 1;
    beats = beats.slice(a, b + 1);
  }
  return Int32Array.from(beats);
}

/**
 * Moves each beat to the strongest envelope frame within ±radiusFrac·period (parabolic sub-frame position).
 * @param {ArrayLike<number>} env
 * @param {ArrayLike<number>} beats envelope frames
 * @param {number} period
 * @param {{radiusFrac?:number}} [opts]
 * @returns {Float64Array} fractional envelope frames
 */
export function refineBeats(env, beats, period, { radiusFrac = 0.1 } = {}) {
  const n = env.length;
  const r = Math.max(1, Math.round(radiusFrac * period));
  const out = new Float64Array(beats.length);
  for (let i = 0; i < beats.length; i++) {
    const b = Math.round(beats[i]);
    let jBest = b;
    let vBest = -Infinity;
    for (let j = Math.max(0, b - r); j <= Math.min(n - 1, b + r); j++) {
      if (env[j] > vBest) {
        vBest = env[j];
        jBest = j;
      }
    }
    if (!(vBest > 0)) {
      out[i] = beats[i];
      continue;
    }
    const off = jBest > 0 && jBest < n - 1 ? parabolicOffset(env[jBest - 1], env[jBest], env[jBest + 1]) : 0;
    out[i] = jBest + off;
  }
  return out;
}

/**
 * Regularises a beat sequence: drops the weaker of two beats closer than 0.6 × the median IBI and fills gaps of
 * ≈k median IBIs (k ≥ 2) with evenly spaced beats.
 * @param {ArrayLike<number>} beats sorted fractional frames
 * @param {ArrayLike<number>} env
 * @returns {Float64Array}
 */
export function regularizeBeats(beats, env) {
  const b = Array.from(beats).sort((p, q) => p - q);
  if (b.length < 3) return Float64Array.from(b);
  const ibis = [];
  for (let i = 1; i < b.length; i++) ibis.push(b[i] - b[i - 1]);
  const med = median(ibis);
  if (!(med > 0)) return Float64Array.from(b);
  const strength = (f) => env[Math.min(env.length - 1, Math.max(0, Math.round(f)))] ?? 0;
  const kept = [b[0]];
  for (let i = 1; i < b.length; i++) {
    const prev = kept[kept.length - 1];
    if (b[i] - prev < 0.6 * med) {
      if (strength(b[i]) > strength(prev)) kept[kept.length - 1] = b[i];
    } else {
      kept.push(b[i]);
    }
  }
  const out = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    const gap = kept[i] - kept[i - 1];
    const k = Math.round(gap / med);
    if (k >= 2 && gap >= 1.5 * med) for (let j = 1; j < k; j++) out.push(kept[i - 1] + (gap * j) / k);
    out.push(kept[i]);
  }
  return Float64Array.from(out);
}

function zscore(arr) {
  const n = arr.length;
  let m = 0;
  for (const v of arr) m += v;
  m /= Math.max(1, n);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  const sd = Math.sqrt(s / Math.max(1, n));
  return arr.map((v) => (sd > 1e-9 ? (v - m) / sd : 0));
}

function meanChroma(chroma, f0, f1, nFrames) {
  const out = new Float64Array(12);
  const a = Math.max(0, Math.round(f0));
  const b = Math.min(nFrames, Math.max(a + 1, Math.round(f1)));
  for (let t = a; t < b; t++) for (let c = 0; c < 12; c++) out[c] += chroma[t * 12 + c];
  return out;
}

function cosine(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

/**
 * @typedef {object} DownbeatEstimate
 * @property {number} phase index (0..beatsPerBar−1) of the first downbeat in the beat list
 * @property {number[]} indices beat indices that are downbeats
 * @property {number[]} phaseScores mean accent per phase
 * @property {number} confidence (best − runner-up) / accent spread, clamped to 0..1
 */

/**
 * Chooses the downbeat phase for a fixed meter by beat-synchronous accent.
 * @param {{beatFrames:ArrayLike<number>, flux:ArrayLike<number>, features:{melDb:Float32Array, nMels:number,
 *   melCenters:Float64Array, chroma:Float32Array, nFrames:number}, period:number, beatsPerBar?:number}} input
 *   beatFrames are ENVELOPE frames (fractional); feature frame = envelope frame + ONSET_FRAME_SHIFT.
 * @returns {DownbeatEstimate}
 */
export function detectDownbeats({ beatFrames, flux, features, period, beatsPerBar = TEMPO_DEFAULTS.beatsPerBar }) {
  const nb = beatFrames.length;
  if (nb === 0) return { phase: 0, indices: [], phaseScores: [], confidence: 0 };
  const { melDb, nMels, melCenters, chroma, nFrames } = features;
  const lowBands = [];
  for (let k = 0; k < nMels; k++) if (melCenters[k] < 180) lowBands.push(k);
  if (lowBands.length === 0) lowBands.push(0);
  const onset = [];
  const low = [];
  const change = [];
  for (let i = 0; i < nb; i++) {
    const e = Math.round(beatFrames[i]);
    onset.push(maxAround(flux, e, 1));
    const m = beatFrames[i] + ONSET_FRAME_SHIFT;
    const a = Math.max(0, Math.round(m));
    const b = Math.min(nFrames, Math.max(a + 1, Math.round(m + 0.3 * period)));
    let s = 0;
    let c = 0;
    for (let t = a; t < b; t++) {
      for (const k of lowBands) s += Math.pow(10, melDb[t * nMels + k] / 10);
      c++;
    }
    low.push(10 * Math.log10(1e-12 + s / Math.max(1, c * lowBands.length)));
    const prevStart = i >= 2 ? beatFrames[i - 2] + ONSET_FRAME_SHIFT : m - 2 * period;
    const nextEnd = i + 2 < nb ? beatFrames[i + 2] + ONSET_FRAME_SHIFT : m + 2 * period;
    const cPrev = meanChroma(chroma, prevStart, m, nFrames);
    const cNext = meanChroma(chroma, m, nextEnd, nFrames);
    change.push(1 - cosine(cPrev, cNext));
  }
  const zo = zscore(onset);
  const zl = zscore(low);
  const zc = zscore(change);
  const accent = zo.map((v, i) => v + zl[i] + zc[i]);
  const phaseScores = [];
  for (let ph = 0; ph < beatsPerBar; ph++) {
    let s = 0;
    let c = 0;
    for (let i = ph; i < nb; i += beatsPerBar) {
      s += accent[i];
      c++;
    }
    phaseScores.push(c ? s / c : -Infinity);
  }
  let phase = 0;
  for (let ph = 1; ph < beatsPerBar; ph++) if (phaseScores[ph] > phaseScores[phase]) phase = ph;
  const sorted = phaseScores.filter(Number.isFinite).sort((p, q) => q - p);
  const spread = Math.sqrt(accent.reduce((s, v) => s + v * v, 0) / Math.max(1, nb));
  const confidence = sorted.length > 1 && spread > 0 ? Math.max(0, Math.min(1, (sorted[0] - sorted[1]) / spread)) : 0;
  const indices = [];
  for (let i = phase; i < nb; i += beatsPerBar) indices.push(i);
  return { phase, indices, phaseScores, confidence };
}

/**
 * Bars from downbeat times; see the header for the gap-fill and extrapolation rules.
 * @param {ArrayLike<number>} downbeats seconds, ascending
 * @param {number} barSec nominal bar length (seconds)
 * @param {number} durationSec
 * @returns {{i:number, start:number, end:number}[]}
 */
export function buildBars(downbeats, barSec, durationSec) {
  const starts = [];
  if (!(barSec > 0) || !(durationSec > 0)) return [];
  if (downbeats.length === 0) {
    for (let s = 0; s < durationSec - 0.5 * barSec || (s === 0 && durationSec > 0); s += barSec) starts.push(s);
  } else {
    const pre = [];
    let s = downbeats[0] - barSec;
    while (s >= -0.05 * barSec) {
      pre.push(Math.max(0, s));
      s -= barSec;
    }
    pre.reverse();
    starts.push(...pre);
    for (let i = 0; i < downbeats.length; i++) {
      if (i > 0) {
        const gap = downbeats[i] - downbeats[i - 1];
        const k = Math.round(gap / barSec);
        if (k >= 2 && gap >= 1.5 * barSec) for (let j = 1; j < k; j++) starts.push(downbeats[i - 1] + (gap * j) / k);
      }
      starts.push(downbeats[i]);
    }
    let e = downbeats[downbeats.length - 1] + barSec;
    while (e < durationSec - 0.5 * barSec) {
      starts.push(e);
      e += barSec;
    }
  }
  const clean = starts.filter((v, i) => v < durationSec && (i === 0 || v > starts[i - 1]));
  return clean.map((start, i) => ({
    i,
    start,
    end: i + 1 < clean.length ? clean[i + 1] : Math.min(durationSec, start + barSec),
  }));
}

/**
 * Beat-tracking F-measure with one-to-one greedy matching inside ±tol seconds (both lists ascending).
 * @param {ArrayLike<number>} estimated
 * @param {ArrayLike<number>} reference
 * @param {number} [tol]
 * @returns {{f:number, precision:number, recall:number, matched:number}}
 */
export function beatFMeasure(estimated, reference, tol = 0.07) {
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < estimated.length && j < reference.length) {
    const d = estimated[i] - reference[j];
    if (Math.abs(d) <= tol) {
      matched++;
      i++;
      j++;
    } else if (d < 0) i++;
    else j++;
  }
  const precision = estimated.length ? matched / estimated.length : 0;
  const recall = reference.length ? matched / reference.length : 0;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { f, precision, recall, matched };
}

/**
 * @typedef {object} RhythmAnalysis
 * @property {number} bpm
 * @property {number} confidence 0..1 (√(pulse clarity × beat regularity))
 * @property {number} beatPeriodSec
 * @property {number[]} beats seconds
 * @property {number[]} downbeats seconds
 * @property {number} downbeatPhase
 * @property {number} downbeatConfidence
 * @property {{i:number, start:number, end:number}[]} bars
 * @property {number} barSec
 * @property {TempoEstimate} tempo raw estimate (before beat-based refinement)
 * @property {Float64Array} beatFrames envelope frames of `beats`
 */

/**
 * Tempo → beats → downbeats → bars from features + onset envelope.
 * @param {import("./features.mjs").FeatureSet} features
 * @param {import("./onset.mjs").OnsetEnvelope} onset
 * @param {Partial<typeof TEMPO_DEFAULTS>} [opts]
 * @returns {RhythmAnalysis}
 */
export function analyzeRhythm(features, onset, opts = {}) {
  const o = { ...TEMPO_DEFAULTS, ...opts };
  const { env, flux, frameRate } = onset;
  const durationSec = features.durationSec;
  const tempo = estimateTempo(env, frameRate, o);
  const raw = trackBeats(env, tempo.period, { tightness: o.tightness });
  const refined = refineBeats(env, raw, tempo.period);
  const beatFrames = regularizeBeats(refined, env);
  const beats = [];
  const frames = [];
  for (const f of beatFrames) {
    const t = (f + ONSET_FRAME_SHIFT) / frameRate;
    if (t >= 0 && t <= durationSec) {
      beats.push(t);
      frames.push(f);
    }
  }
  const ibis = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  let beatPeriodSec = tempo.period / frameRate;
  let regularity = 0;
  if (ibis.length >= 3) {
    const med = median(ibis);
    const inl = ibis.filter((v) => Math.abs(v - med) <= 0.15 * med);
    if (inl.length) beatPeriodSec = inl.reduce((s, v) => s + v, 0) / inl.length;
    regularity = ibis.filter((v) => Math.abs(v - med) <= 0.1 * med).length / ibis.length;
  }
  const bpm = 60 / beatPeriodSec;
  const confidence = Math.sqrt(Math.max(0, tempo.clarity) * regularity);
  const db = detectDownbeats({
    beatFrames: frames,
    flux,
    features,
    period: beatPeriodSec * frameRate,
    beatsPerBar: o.beatsPerBar,
  });
  const downbeats = db.indices.map((i) => beats[i]);
  const barSec = beatPeriodSec * o.beatsPerBar;
  const bars = buildBars(downbeats, barSec, durationSec);
  return {
    bpm,
    confidence,
    beatPeriodSec,
    beats,
    downbeats,
    downbeatPhase: db.phase,
    downbeatConfidence: db.confidence,
    bars,
    barSec,
    tempo,
    beatFrames: Float64Array.from(frames),
  };
}
