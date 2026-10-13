// tools/film/audio/structure.mjs — song sections (boundaries, repeat labels, roles) for the film-mode analyser.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) plans a music video section by section: the director wants "the
// chorus comes back here, louder" and "this bridge is the only quiet part in the second half". Pipeline (pure,
// deterministic, bar-synchronous):
//   1. Bar features: mean chroma (12) per bar; timbre = mean MFCC c1..c12 + bar loudness (dB) per bar.
//   2. Two cosine self-similarity matrices — chroma (mean-centred) and timbre (z-scored, tiny-variance dims damped)
//      — each mapped to (1 + cos)/2 and averaged.
//   3. Foote checkerboard novelty with a Gaussian-tapered kernel (half-width 4 bars, σ = 2 bars, main diagonal
//      excluded): novelty(i) = weighted mean same-side similarity − weighted mean cross similarity at the bar line
//      between bars i−1 and i.
//   4. Adaptive peak picking: a local maximum within ±2 bars that exceeds (mean novelty within ±8 bars + 0.25 × the
//      global std) and 0.02, accepted greedily by height with a 4-bar minimum section (also from both ends).
//      Boundaries are bar indices, i.e. snapped to downbeats by construction.
//   5. Segment similarity = best mean similarity along a diagonal stripe of the two segments' block (bar k of one
//      against bar k + s of the other, small alignment slack, ≥ half overlap) on a path-enhanced SSM (3-bar diagonal
//      smoothing) — equal-length repeats compare bar by bar. Average-linkage agglomerative clustering merges while
//      similarity ≥ 0.75; labels A, B, C… in order of first appearance; repeatOf = index of the first section with
//      the same label (null for a first occurrence).
//   6. Roles (SECTION_ROLES) — see assignRoles.

/** Role vocabulary written into SongAnalysis.sections[].role. */
export const SECTION_ROLES = Object.freeze(["intro", "verse", "prechorus", "chorus", "bridge", "instrumental", "outro", "unknown"]);

/** Tunables for analyzeStructure (bars unless noted). */
export const STRUCTURE_DEFAULTS = Object.freeze({
  noveltyHalfWidth: 4,
  noveltySigma: 2,
  minSectionBars: 4,
  peakWindow: 2,
  thresholdWindow: 8,
  thresholdK: 0.25,
  minNovelty: 0.02,
  pathHalfLen: 1,
  stripeSlack: 1,
  clusterThreshold: 0.75,
  lowEnergyRatio: 0.7,
});

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @typedef {object} BarFeatures
 * @property {Float64Array[]} chroma per bar, 12 values (mean of the frame-normalised chroma)
 * @property {Float64Array[]} timbre per bar, MFCC c1..c(n−1) means + loudness dB
 * @property {Float64Array} loudnessDb per bar, 10·log10(mean square)
 */

/**
 * Bar-synchronous feature means over the feature frames whose centre lies in [bar.start, bar.end).
 * @param {import("./features.mjs").FeatureSet} features
 * @param {{start:number, end:number}[]} bars
 * @returns {BarFeatures}
 */
export function barSyncFeatures(features, bars) {
  const { frameRate, nFrames, chroma, mfcc, nMfcc, rms } = features;
  const chromaB = [];
  const timbreB = [];
  const loud = new Float64Array(bars.length);
  bars.forEach((bar, i) => {
    const a = clampInt(Math.ceil(bar.start * frameRate), 0, Math.max(0, nFrames - 1));
    const b = clampInt(Math.ceil(bar.end * frameRate), a + 1, nFrames);
    const c = new Float64Array(12);
    const m = new Float64Array(nMfcc);
    let ms = 0;
    for (let t = a; t < b; t++) {
      for (let k = 0; k < 12; k++) c[k] += chroma[t * 12 + k];
      for (let k = 0; k < nMfcc; k++) m[k] += mfcc[t * nMfcc + k];
      ms += rms[t] * rms[t];
    }
    const cnt = Math.max(1, b - a);
    for (let k = 0; k < 12; k++) c[k] /= cnt;
    const tv = new Float64Array(nMfcc);
    for (let k = 1; k < nMfcc; k++) tv[k - 1] = m[k] / cnt;
    loud[i] = 10 * Math.log10(ms / cnt + 1e-12);
    tv[nMfcc - 1] = loud[i];
    chromaB.push(c);
    timbreB.push(tv);
  });
  return { chroma: chromaB, timbre: timbreB, loudnessDb: loud };
}

/**
 * Cosine self-similarity of row vectors mapped to [0, 1] via (1 + cos)/2. `center` subtracts the mean row;
 * `standardize` divides each dimension by max(its std, 1 % of the largest dimension std).
 * @param {ArrayLike<number>[]} vectors
 * @param {{center?:boolean, standardize?:boolean}} [opts]
 * @returns {Float64Array} n × n row-major
 */
export function cosineSsm(vectors, { center = true, standardize = false } = {}) {
  const n = vectors.length;
  const S = new Float64Array(n * n);
  if (n === 0) return S;
  const d = vectors[0].length;
  const X = vectors.map((v) => Float64Array.from(v));
  if (center || standardize) {
    const mean = new Float64Array(d);
    for (const v of X) for (let k = 0; k < d; k++) mean[k] += v[k] / n;
    if (center) for (const v of X) for (let k = 0; k < d; k++) v[k] -= mean[k];
    if (standardize) {
      const sd = new Float64Array(d);
      for (const v of X) for (let k = 0; k < d; k++) sd[k] += ((v[k] - (center ? 0 : mean[k])) ** 2) / n;
      let maxSd = 0;
      for (let k = 0; k < d; k++) {
        sd[k] = Math.sqrt(sd[k]);
        if (sd[k] > maxSd) maxSd = sd[k];
      }
      const floor = Math.max(1e-9, 0.01 * maxSd);
      for (const v of X) for (let k = 0; k < d; k++) v[k] /= Math.max(sd[k], floor);
    }
  }
  const norms = X.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let k = 0; k < d; k++) dot += X[i][k] * X[j][k];
      const den = norms[i] * norms[j];
      const cos = den > 1e-12 ? dot / den : i === j ? 1 : 0;
      const v = 0.5 * (1 + Math.max(-1, Math.min(1, cos)));
      S[i * n + j] = v;
      S[j * n + i] = v;
    }
  }
  return S;
}

/**
 * Diagonal (path) enhancement: mean over the in-range entries of a centred diagonal segment of ±halfLen.
 * @param {Float64Array} S n × n
 * @param {number} n
 * @param {number} halfLen
 * @returns {Float64Array}
 */
export function enhancePaths(S, n, halfLen) {
  if (halfLen <= 0) return Float64Array.from(S);
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      let c = 0;
      for (let k = -halfLen; k <= halfLen; k++) {
        const a = i + k;
        const b = j + k;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        s += S[a * n + b];
        c++;
      }
      out[i * n + j] = s / c;
    }
  }
  return out;
}

/**
 * Foote checkerboard novelty at every bar line (index i = boundary before bar i; 0 and n stay 0).
 * @param {Float64Array} S n × n similarity
 * @param {number} n
 * @param {{halfWidth?:number, sigma?:number}} [opts]
 * @returns {Float64Array} length n + 1
 */
export function footeNovelty(S, n, { halfWidth = STRUCTURE_DEFAULTS.noveltyHalfWidth, sigma = STRUCTURE_DEFAULTS.noveltySigma } = {}) {
  const N = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) {
    let sameW = 0;
    let sameS = 0;
    let crossW = 0;
    let crossS = 0;
    for (let a = -halfWidth; a < halfWidth; a++) {
      const r = i + a;
      if (r < 0 || r >= n) continue;
      for (let b = -halfWidth; b < halfWidth; b++) {
        const c = i + b;
        if (c < 0 || c >= n || r === c) continue;
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
        if (a < 0 === b < 0) {
          sameW += g;
          sameS += g * S[r * n + c];
        } else {
          crossW += g;
          crossS += g * S[r * n + c];
        }
      }
    }
    N[i] = sameW > 0 && crossW > 0 ? sameS / sameW - crossS / crossW : 0;
  }
  return N;
}

/**
 * Adaptive novelty peak picking with a minimum section length (see header step 4).
 * @param {Float64Array} N novelty, length n + 1
 * @param {number} n bar count
 * @param {Partial<typeof STRUCTURE_DEFAULTS>} [opts]
 * @returns {number[]} ascending boundary bar indices (each in [minSectionBars, n − minSectionBars])
 */
export function pickBoundaries(N, n, opts = {}) {
  const o = { ...STRUCTURE_DEFAULTS, ...opts };
  const L = Math.max(1, o.minSectionBars);
  if (n < 2 * L) return [];
  let mean = 0;
  let cnt = 0;
  for (let i = 1; i < n; i++) {
    mean += N[i];
    cnt++;
  }
  mean /= Math.max(1, cnt);
  let sd = 0;
  for (let i = 1; i < n; i++) sd += (N[i] - mean) ** 2;
  sd = Math.sqrt(sd / Math.max(1, cnt));
  const cands = [];
  for (let i = L; i <= n - L; i++) {
    let isMax = true;
    for (let j = i - o.peakWindow; j <= i + o.peakWindow; j++) {
      if (j === i || j < 1 || j > n - 1) continue;
      if (N[j] > N[i] || (N[j] === N[i] && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let s = 0;
    let c = 0;
    for (let j = Math.max(1, i - o.thresholdWindow); j <= Math.min(n - 1, i + o.thresholdWindow); j++) {
      s += N[j];
      c++;
    }
    const thr = s / c + o.thresholdK * sd;
    if (N[i] > thr && N[i] > o.minNovelty) cands.push(i);
  }
  cands.sort((a, b) => N[b] - N[a] || a - b);
  const acc = [];
  for (const i of cands) if (acc.every((j) => Math.abs(i - j) >= L)) acc.push(i);
  return acc.sort((a, b) => a - b);
}

/**
 * Diagonal-stripe similarity between two bar segments [x0, x1) and [y0, y1) of an n × n SSM.
 * @param {Float64Array} S
 * @param {number} n
 * @param {[number, number]} x
 * @param {[number, number]} y
 * @param {{slack?:number}} [opts]
 * @returns {number}
 */
export function segmentSimilarity(S, n, [x0, x1], [y0, y1], { slack = STRUCTURE_DEFAULTS.stripeSlack } = {}) {
  const lx = x1 - x0;
  const ly = y1 - y0;
  if (lx <= 0 || ly <= 0) return 0;
  const sMin = Math.min(0, lx - ly) - slack;
  const sMax = Math.max(0, lx - ly) + slack;
  const minOverlap = Math.max(1, Math.ceil(0.5 * Math.min(lx, ly)));
  let best = -Infinity;
  for (let s = sMin; s <= sMax; s++) {
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < ly; k++) {
      const xi = x0 + k + s;
      if (xi < x0 || xi >= x1) continue;
      sum += S[xi * n + (y0 + k)];
      cnt++;
    }
    if (cnt >= minOverlap && sum / cnt > best) best = sum / cnt;
  }
  return best === -Infinity ? 0 : best;
}

/**
 * Average-linkage agglomerative clustering; returns cluster ids renumbered by first appearance.
 * @param {number[][]} sim m × m similarity
 * @param {number} threshold merge while the best average similarity ≥ threshold
 * @returns {number[]}
 */
export function clusterSegments(sim, threshold) {
  const m = sim.length;
  let clusters = Array.from({ length: m }, (_, i) => [i]);
  while (clusters.length > 1) {
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let s = 0;
        for (const p of clusters[i]) for (const q of clusters[j]) s += sim[p][q];
        const v = s / (clusters[i].length * clusters[j].length);
        if (v > best + 1e-12) {
          best = v;
          bi = i;
          bj = j;
        }
      }
    }
    if (!(best >= threshold)) break;
    clusters[bi] = clusters[bi].concat(clusters[bj]).sort((a, b) => a - b);
    clusters = clusters.filter((_, k) => k !== bj);
  }
  const raw = new Array(m);
  clusters.forEach((c, k) => c.forEach((i) => (raw[i] = k)));
  const map = new Map();
  return raw.map((c) => {
    if (!map.has(c)) map.set(c, map.size);
    return map.get(c);
  });
}

/**
 * Label for a cluster index: 0 → "A" … 25 → "Z", 26 → "A2", 27 → "B2", …
 * @param {number} k
 * @returns {string}
 */
export function labelName(k) {
  const letter = String.fromCharCode(65 + (k % 26));
  const round = Math.floor(k / 26);
  return round === 0 ? letter : `${letter}${round + 1}`;
}

/**
 * Mean of an energy curve over [t0, t1) weighted by window overlap.
 * @param {{hopSec:number, values:ArrayLike<number>}} curve
 * @param {number} t0
 * @param {number} t1
 * @returns {number}
 */
export function meanEnergy(curve, t0, t1) {
  const { hopSec, values } = curve;
  if (!(t1 > t0) || values.length === 0) return 0;
  const a = Math.max(0, Math.floor(t0 / hopSec));
  const b = Math.min(values.length - 1, Math.floor((t1 - 1e-9) / hopSec));
  let s = 0;
  let w = 0;
  for (let i = a; i <= b; i++) {
    const lo = Math.max(t0, i * hopSec);
    const hi = Math.min(t1, (i + 1) * hopSec);
    if (hi <= lo) continue;
    s += values[i] * (hi - lo);
    w += hi - lo;
  }
  return w > 0 ? s / w : 0;
}

/**
 * @typedef {object} Section
 * @property {number} i
 * @property {number} start seconds (first section starts at 0)
 * @property {number} end seconds (last section ends at durationSec)
 * @property {number} startBar first bar index
 * @property {number} endBar EXCLUSIVE bar index (the section spans bars startBar..endBar−1)
 * @property {string} label A, B, C… by first appearance
 * @property {string} role one of SECTION_ROLES
 * @property {number} energy mean of the 0..1 energy curve over the section
 * @property {number|null} repeatOf index of the first section with the same label, null for a first occurrence
 */

/**
 * Role assignment over labelled sections (mutates nothing; returns roles by section index).
 *  - chorus: among labels repeated ≥ 2 (and, when timed lyrics exist, sung at least once) the highest
 *    count × energy-rank (rank 1 = quietest repeated label); ties → louder, then earlier.
 *  - prechorus: another repeated label, mean length ≤ 8 bars and ≤ its feeder's, ≥ 2/3 of its occurrences directly
 *    before a chorus AND ≥ 2/3 directly after one same other repeated label (the verse that feeds it).
 *  - verse: the remaining repeated label that most often precedes a chorus (directly or through a prechorus);
 *    ties → more occurrences, quieter, earlier. Other repeated labels that precede a chorus also read verse.
 *  - instrumental: with timed lyrics, any section of a repeated label that has no lyric line inside it.
 *  - bridge: a non-repeated section, not first or last, whose midpoint lies in the second half of the song.
 *  - intro: the first section when it is not repeated or is low energy (< lowEnergyRatio × the length-weighted
 *    median section energy); outro: the last section when not repeated, low energy, or fading (last third
 *    < 0.6 × first third of its energy). Everything else: unknown. A single-section song is unknown.
 * @param {{start:number, end:number, startBar:number, endBar:number, label:string, energy:number}[]} sections
 * @param {{durationSec:number, energy?:{hopSec:number, values:ArrayLike<number>}, timedLyrics?:{t:number}[]|null,
 *   lowEnergyRatio?:number}} ctx
 * @returns {string[]}
 */
export function assignRoles(sections, { durationSec, energy = null, timedLyrics = null, lowEnergyRatio = STRUCTURE_DEFAULTS.lowEnergyRatio }) {
  const m = sections.length;
  const roles = new Array(m).fill("unknown");
  if (m <= 1) return roles;
  const hasTimed = Array.isArray(timedLyrics) && timedLyrics.length > 0;
  const vocal = sections.map((s, k) =>
    hasTimed ? timedLyrics.some((l) => l.t >= s.start && (l.t < s.end || (k === m - 1 && l.t <= s.end))) : true,
  );
  const stats = new Map();
  sections.forEach((s, k) => {
    if (!stats.has(s.label)) stats.set(s.label, { label: s.label, idx: [], energy: 0, bars: 0, first: k, sung: false });
    const st = stats.get(s.label);
    st.idx.push(k);
    st.energy += s.energy;
    st.bars += s.endBar - s.startBar;
    if (vocal[k]) st.sung = true;
  });
  for (const st of stats.values()) {
    st.count = st.idx.length;
    st.energy /= st.count;
    st.bars /= st.count;
  }
  const repeated = [...stats.values()].filter((st) => st.count >= 2);
  const byEnergy = repeated.slice().sort((a, b) => a.energy - b.energy || a.first - b.first);
  byEnergy.forEach((st, r) => (st.rank = r + 1));
  const chorusPool = hasTimed ? repeated.filter((st) => st.sung) : repeated;
  let chorus = null;
  for (const st of chorusPool) {
    const score = st.count * st.rank;
    if (
      !chorus ||
      score > chorus.count * chorus.rank ||
      (score === chorus.count * chorus.rank && (st.energy > chorus.energy || (st.energy === chorus.energy && st.first < chorus.first)))
    ) {
      chorus = st;
    }
  }
  const isChorus = (k) => chorus !== null && k >= 0 && k < m && sections[k].label === chorus.label;
  const labelRole = new Map();
  if (chorus) labelRole.set(chorus.label, "chorus");
  // A prechorus sits BETWEEN a verse-like repeated label and the chorus; a label that merely precedes the chorus
  // (no other repeated section in front of it) is the verse itself.
  for (const st of repeated) {
    if (labelRole.has(st.label)) continue;
    const before = st.idx.filter((k) => isChorus(k + 1)).length;
    const fedBy = new Map();
    for (const k of st.idx) {
      const p = k > 0 ? stats.get(sections[k - 1].label) : null;
      if (p && p !== st && p !== chorus && p.count >= 2) fedBy.set(p.label, (fedBy.get(p.label) ?? 0) + 1);
    }
    let feeder = null;
    for (const [label, c] of fedBy) if (!feeder || c > feeder.c) feeder = { label, c };
    const feederSt = feeder ? stats.get(feeder.label) : null;
    if (st.bars <= 8 && before / st.count >= 2 / 3 && feeder && feeder.c / st.count >= 2 / 3 && st.bars <= feederSt.bars) {
      labelRole.set(st.label, "prechorus");
    }
  }
  const precedesChorus = (k) => isChorus(k + 1) || (labelRole.get(sections[k + 1]?.label) === "prechorus" && isChorus(k + 2));
  let verse = null;
  for (const st of repeated) {
    if (labelRole.has(st.label)) continue;
    st.pre = st.idx.filter((k) => precedesChorus(k)).length;
    if (
      !verse ||
      st.pre > verse.pre ||
      (st.pre === verse.pre &&
        (st.count > verse.count || (st.count === verse.count && (st.energy < verse.energy || (st.energy === verse.energy && st.first < verse.first)))))
    ) {
      verse = st;
    }
  }
  if (verse && (verse.pre > 0 || chorus)) labelRole.set(verse.label, "verse");
  for (const st of repeated) {
    if (labelRole.has(st.label)) continue;
    if (hasTimed && !st.sung) labelRole.set(st.label, "instrumental");
    else if (st.idx.some((k) => precedesChorus(k))) labelRole.set(st.label, "verse");
  }
  sections.forEach((s, k) => {
    const role = labelRole.get(s.label);
    if (role) roles[k] = role;
    if (hasTimed && stats.get(s.label).count >= 2 && !vocal[k]) roles[k] = "instrumental";
  });
  const half = durationSec / 2;
  sections.forEach((s, k) => {
    if (stats.get(s.label).count === 1 && k > 0 && k < m - 1 && (s.start + s.end) / 2 >= half) roles[k] = "bridge";
  });
  const weighted = sections
    .map((s) => ({ e: s.energy, w: Math.max(1e-9, s.end - s.start) }))
    .sort((a, b) => a.e - b.e);
  const totalW = weighted.reduce((acc, v) => acc + v.w, 0);
  let cum = 0;
  let medianE = weighted[weighted.length - 1].e;
  for (const v of weighted) {
    cum += v.w;
    if (cum >= totalW / 2) {
      medianE = v.e;
      break;
    }
  }
  const low = (s) => s.energy < lowEnergyRatio * medianE;
  const first = sections[0];
  if (stats.get(first.label).count === 1 || low(first)) roles[0] = "intro";
  const last = sections[m - 1];
  let fading = false;
  if (energy) {
    const third = (last.end - last.start) / 3;
    const e0 = meanEnergy(energy, last.start, last.start + third);
    const e2 = meanEnergy(energy, last.end - third, last.end);
    fading = e0 > 0 && e2 < 0.6 * e0;
  }
  if (stats.get(last.label).count === 1 || low(last) || fading) roles[m - 1] = "outro";
  return roles;
}

/**
 * @typedef {object} StructureResult
 * @property {Section[]} sections
 * @property {number[]} boundaries bar indices
 * @property {Float64Array} novelty length nBars + 1
 * @property {Float64Array} ssm nBars × nBars (chroma/timbre average)
 * @property {number[][]} segmentSimilarity
 */

/**
 * Sections from features + bars + energy curve.
 * @param {import("./features.mjs").FeatureSet} features
 * @param {{i:number, start:number, end:number}[]} bars
 * @param {{hopSec:number, values:ArrayLike<number>}} energy 0..1 curve (features.mjs energyCurve)
 * @param {Partial<typeof STRUCTURE_DEFAULTS> & {timedLyrics?:{t:number}[]|null}} [opts]
 * @returns {StructureResult}
 */
export function analyzeStructure(features, bars, energy, opts = {}) {
  const o = { ...STRUCTURE_DEFAULTS, ...opts };
  const durationSec = features.durationSec;
  const n = bars.length;
  const single = (label = "A") => {
    const sec = {
      i: 0,
      start: 0,
      end: durationSec,
      startBar: 0,
      endBar: n,
      label,
      role: "unknown",
      energy: meanEnergy(energy, 0, durationSec),
      repeatOf: null,
    };
    return { sections: [sec], boundaries: [], novelty: new Float64Array(n + 1), ssm: new Float64Array(n * n), segmentSimilarity: [[1]] };
  };
  if (n < 2 * o.minSectionBars) return single();
  const bf = barSyncFeatures(features, bars);
  const Sc = cosineSsm(bf.chroma, { center: true });
  const St = cosineSsm(bf.timbre, { center: true, standardize: true });
  const S = new Float64Array(n * n);
  for (let i = 0; i < S.length; i++) S[i] = 0.5 * (Sc[i] + St[i]);
  const novelty = footeNovelty(S, n, { halfWidth: o.noveltyHalfWidth, sigma: o.noveltySigma });
  const boundaries = pickBoundaries(novelty, n, o);
  const edges = [0, ...boundaries, n];
  const segs = [];
  for (let k = 0; k + 1 < edges.length; k++) segs.push([edges[k], edges[k + 1]]);
  const Sp = enhancePaths(S, n, o.pathHalfLen);
  const m = segs.length;
  const sim = Array.from({ length: m }, () => new Array(m).fill(1));
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const v = 0.5 * (segmentSimilarity(Sp, n, segs[a], segs[b], o) + segmentSimilarity(Sp, n, segs[b], segs[a], o));
      sim[a][b] = v;
      sim[b][a] = v;
    }
  }
  const ids = clusterSegments(sim, o.clusterThreshold);
  const firstOf = new Map();
  const sections = segs.map(([b0, b1], k) => {
    const start = k === 0 ? 0 : bars[b0].start;
    const end = k === m - 1 ? durationSec : bars[b1].start;
    const label = labelName(ids[k]);
    if (!firstOf.has(label)) firstOf.set(label, k);
    const rep = firstOf.get(label);
    return {
      i: k,
      start,
      end,
      startBar: b0,
      endBar: b1,
      label,
      role: "unknown",
      energy: meanEnergy(energy, start, end),
      repeatOf: rep === k ? null : rep,
    };
  });
  const roles = assignRoles(sections, { durationSec, energy, timedLyrics: o.timedLyrics ?? null, lowEnergyRatio: o.lowEnergyRatio });
  sections.forEach((s, k) => (s.role = roles[k]));
  return { sections, boundaries, novelty, ssm: S, segmentSimilarity: sim };
}
