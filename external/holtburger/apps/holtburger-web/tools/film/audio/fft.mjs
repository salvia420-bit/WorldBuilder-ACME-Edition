// tools/film/audio/fft.mjs — radix-2 FFT, Hann window and STFT framing for the film-mode song analyser.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) cuts music videos to a song's beats and sections. The Node-side
// analyser (`film.mjs song analyze`) needs a deterministic, dependency-free spectral front end: no npm packages,
// no native addons, identical output on every machine. Everything here is a pure function over typed arrays.
//
// Conventions: the forward transform uses W = e^(−2πi·k/n) (no scaling); STFT frames are CENTRED — frame t covers
// samples [t·hop − nFft/2, t·hop + nFft/2) with zeros outside the signal, so frame t ↔ time t·hop/sampleRate.

/**
 * True when `n` is a positive integer power of two.
 * @param {number} n
 * @returns {boolean}
 */
export function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * Smallest power of two ≥ n (n ≥ 1).
 * @param {number} n
 * @returns {number}
 */
export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * In-place iterative radix-2 complex FFT of a fixed size.
 * @param {number} n power of two ≥ 1
 * @returns {{n:number, forward:(re:Float64Array, im:Float64Array) => void}}
 */
export function createFFT(n) {
  if (!isPowerOfTwo(n)) throw new RangeError(`createFFT: size must be a power of two, got ${n}`);
  let bits = 0;
  while ((1 << bits) < n) bits++;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  const half = n >> 1;
  const cosT = new Float64Array(Math.max(1, half));
  const sinT = new Float64Array(Math.max(1, half));
  for (let k = 0; k < half; k++) {
    const a = (2 * Math.PI * k) / n;
    cosT[k] = Math.cos(a);
    sinT[k] = Math.sin(a);
  }
  /** @param {Float64Array} re @param {Float64Array} im */
  function forward(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const h = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < h; j++, k += step) {
          const a = start + j;
          const b = a + h;
          const c = cosT[k];
          const s = sinT[k];
          const tr = re[b] * c + im[b] * s;
          const ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
  return { n, forward };
}

/**
 * Real-input FFT of size n (power of two ≥ 4) via one complex FFT of size n/2 plus the split post-pass.
 * `forward(x, re, im)` writes bins 0..n/2 (n/2+1 values); `power(x, out)` writes |X[k]|².
 * Not re-entrant (owns scratch buffers) — create one per concurrent user.
 * @param {number} n
 * @returns {{n:number, bins:number, forward:(x:ArrayLike<number>, outRe:Float64Array, outIm:Float64Array) => void,
 *   power:(x:ArrayLike<number>, out:Float64Array|Float32Array) => void}}
 */
export function createRealFFT(n) {
  if (!isPowerOfTwo(n) || n < 4) throw new RangeError(`createRealFFT: size must be a power of two ≥ 4, got ${n}`);
  const m = n >> 1;
  const cfft = createFFT(m);
  const zr = new Float64Array(m);
  const zi = new Float64Array(m);
  const wc = new Float64Array(m + 1);
  const ws = new Float64Array(m + 1);
  for (let k = 0; k <= m; k++) {
    const a = (2 * Math.PI * k) / n;
    wc[k] = Math.cos(a);
    ws[k] = Math.sin(a);
  }
  function transform(x) {
    for (let i = 0; i < m; i++) {
      zr[i] = x[2 * i];
      zi[i] = x[2 * i + 1];
    }
    cfft.forward(zr, zi);
  }
  /** X[k] = E[k] + W^k·O[k], E/O = spectra of the even/odd samples recovered from Z = FFT(x_even + i·x_odd). */
  function forward(x, outRe, outIm) {
    transform(x);
    for (let k = 0; k <= m; k++) {
      const k1 = k % m;
      const k2 = (m - k) % m;
      const ar = zr[k1], ai = zi[k1], br = zr[k2], bi = zi[k2];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai - bi);
      const or = 0.5 * (ai + bi), oi = -0.5 * (ar - br);
      const c = wc[k], s = ws[k];
      outRe[k] = er + or * c + oi * s;
      outIm[k] = ei + oi * c - or * s;
    }
  }
  function power(x, out) {
    transform(x);
    for (let k = 0; k <= m; k++) {
      const k1 = k % m;
      const k2 = (m - k) % m;
      const ar = zr[k1], ai = zi[k1], br = zr[k2], bi = zi[k2];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai - bi);
      const or = 0.5 * (ai + bi), oi = -0.5 * (ar - br);
      const c = wc[k], s = ws[k];
      const re = er + or * c + oi * s;
      const im = ei + oi * c - or * s;
      out[k] = re * re + im * im;
    }
  }
  return { n, bins: m + 1, forward, power };
}

/**
 * Hann window. `periodic` (default, the STFT convention) uses denominator n; symmetric uses n−1.
 * @param {number} n
 * @param {{periodic?:boolean}} [opts]
 * @returns {Float64Array}
 */
export function hannWindow(n, { periodic = true } = {}) {
  const w = new Float64Array(n);
  const d = periodic ? n : Math.max(1, n - 1);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

/**
 * Number of centred STFT frames for a signal: 1 + floor(length / hop).
 * @param {number} length
 * @param {number} hop
 * @returns {number}
 */
export function stftFrameCount(length, hop) {
  return 1 + Math.floor(length / hop);
}

/**
 * Streams centred, Hann-windowed STFT power frames to a callback without storing the spectrogram.
 * `onFrame(t, power)` receives a reused Float64Array of nFft/2+1 power bins — copy what you keep.
 * @param {ArrayLike<number>} x mono signal
 * @param {{nFft?:number, hop?:number, window?:Float64Array}} opts
 * @param {(t:number, power:Float64Array) => void} onFrame
 * @returns {number} frame count
 */
export function forEachStftFrame(x, { nFft = 2048, hop = 512, window } = {}, onFrame) {
  if (!isPowerOfTwo(nFft) || nFft < 4) throw new RangeError(`STFT size must be a power of two ≥ 4, got ${nFft}`);
  if (!Number.isInteger(hop) || hop < 1) throw new RangeError(`STFT hop must be a positive integer, got ${hop}`);
  const win = window ?? hannWindow(nFft);
  if (win.length !== nFft) throw new RangeError(`STFT window length ${win.length} ≠ nFft ${nFft}`);
  const rfft = createRealFFT(nFft);
  const len = x.length;
  const nFrames = stftFrameCount(len, hop);
  const buf = new Float64Array(nFft);
  const pow = new Float64Array(nFft / 2 + 1);
  const half = nFft >> 1;
  for (let t = 0; t < nFrames; t++) {
    const start = t * hop - half;
    if (start >= 0 && start + nFft <= len) {
      for (let i = 0; i < nFft; i++) buf[i] = x[start + i] * win[i];
    } else {
      for (let i = 0; i < nFft; i++) {
        const j = start + i;
        buf[i] = j >= 0 && j < len ? x[j] * win[i] : 0;
      }
    }
    rfft.power(buf, pow);
    onFrame(t, pow);
  }
  return nFrames;
}

/**
 * Full power spectrogram (frame-major Float32Array, nFrames × nBins). Meant for short signals and tests;
 * the analyser itself streams with forEachStftFrame.
 * @param {ArrayLike<number>} x
 * @param {{nFft?:number, hop?:number}} [opts]
 * @returns {{nFrames:number, nBins:number, power:Float32Array}}
 */
export function stftPower(x, { nFft = 2048, hop = 512 } = {}) {
  const nBins = nFft / 2 + 1;
  const nFrames = stftFrameCount(x.length, hop);
  const power = new Float32Array(nFrames * nBins);
  forEachStftFrame(x, { nFft, hop }, (t, p) => {
    power.set(p, t * nBins);
  });
  return { nFrames, nBins, power };
}
