// tests/film_audio_tempo.test.mjs — film mode song analyser: DSP front end, tempo, beats, downbeats, bars.
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) cuts music videos on the beat and changes shots on bar
// lines, so `film.mjs song analyze` must report the right BPM, beat times and downbeat phase. These suites build
// deterministic synthetic audio (seeded noise, accented click tracks, a kick/snare/hat loop) and run the REAL
// analyser modules under tools/film/audio/ — no ffmpeg, no real songs, no network.
//
// Run from apps/holtburger-web/: node tests/film_audio_tempo.test.mjs

import assert from "node:assert/strict";
import { createRealFFT, hannWindow, stftFrameCount } from "../tools/film/audio/fft.mjs";
import { ANALYSIS_SAMPLE_RATE, computeFeatures, energyCurve, melFilterbank, resample } from "../tools/film/audio/features.mjs";
import { onsetEnvelope, ONSET_FRAME_SHIFT } from "../tools/film/audio/onset.mjs";
import {
  analyzeRhythm,
  autocorrelation,
  buildBars,
  estimateTempo,
  parabolicOffset,
  TEMPO_DEFAULTS,
  tempoPrior,
} from "../tools/film/audio/tempo.mjs";
import { analyzeSong, SONG_ANALYSIS_VERSION } from "../tools/film/audio/analyze.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message : e}`);
  }
}

const SR = 22050;

/** mulberry32 — deterministic uniform [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Click track: short decaying sine+noise clicks, downbeats louder and lower. Beat k is a downbeat when
 * (k − firstDownIdx) % 4 == 0, so firstDownIdx = 1 starts the track on a pickup beat.
 */
function clickTrack(bpm, { dur = 60, offset = 0.3, firstDownIdx = 1, noise = 0, seed = 1, sr = SR } = {}) {
  const n = Math.round(dur * sr);
  const x = new Float32Array(n);
  const r = rng(seed);
  const ibi = 60 / bpm;
  const beats = [];
  const downs = [];
  for (let k = 0; ; k++) {
    const t = offset + k * ibi;
    if (t > dur - 0.2) break;
    beats.push(t);
    const down = (((k - firstDownIdx) % 4) + 4) % 4 === 0;
    if (down) downs.push(t);
    const s0 = Math.round(t * sr);
    const amp = down ? 0.9 : 0.45;
    const f = down ? 1000 : 1600;
    const len = Math.round(0.06 * sr);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const env = Math.exp(-i / (0.012 * sr));
      x[s0 + i] += amp * env * (0.6 * Math.sin((2 * Math.PI * f * i) / sr) + 0.4 * (r() * 2 - 1));
    }
  }
  if (noise > 0) for (let i = 0; i < n; i++) x[i] += noise * (r() * 2 - 1);
  return { x, beats, downs };
}

/** Rock loop: kick on 1, 3, 3-and; snare on 2 and 4; hats on eighths; a bass root that changes every bar. */
function drumLoop(bpm, { dur = 60, offset = 0.5, noise = 0.05, seed = 7 } = {}) {
  const n = Math.round(dur * SR);
  const x = new Float32Array(n);
  const r = rng(seed);
  const ibi = 60 / bpm;
  const beats = [];
  const downs = [];
  const add = (t, fn, len) => {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < len && s0 + i < n; i++) if (s0 + i >= 0) x[s0 + i] += fn(i);
  };
  const kick = (t) => {
    let ph = 0;
    add(t, (i) => {
      const tt = i / SR;
      ph += (2 * Math.PI * (50 + 100 * Math.exp(-tt / 0.03))) / SR;
      return 0.8 * Math.exp(-tt / 0.12) * Math.sin(ph);
    }, Math.round(0.35 * SR));
  };
  const snare = (t) =>
    add(t, (i) => {
      const tt = i / SR;
      return 0.5 * (Math.exp(-tt / 0.06) * (r() * 2 - 1) * 0.7 + Math.exp(-tt / 0.04) * 0.3 * Math.sin(2 * Math.PI * 190 * tt));
    }, Math.round(0.25 * SR));
  let hp = 0;
  const hat = (t, a) =>
    add(t, (i) => {
      const w = r() * 2 - 1;
      const v = w - hp;
      hp = w;
      return a * Math.exp(-i / SR / 0.015) * v;
    }, Math.round(0.06 * SR));
  const roots = [55, 43.65, 49, 41.2];
  for (let bar = 0; ; bar++) {
    const t0 = offset + bar * 4 * ibi;
    if (t0 > dur - 4 * ibi) break;
    for (let b = 0; b < 4; b++) beats.push(t0 + b * ibi);
    downs.push(t0);
    kick(t0);
    kick(t0 + 2 * ibi);
    kick(t0 + 2.5 * ibi);
    snare(t0 + ibi);
    snare(t0 + 3 * ibi);
    for (let e = 0; e < 8; e++) hat(t0 + (e * ibi) / 2, e % 2 ? 0.12 : 0.2);
    const f = roots[bar % 4];
    add(t0, (i) => {
      const tt = i / SR;
      return 0.25 * Math.min(1, tt / 0.01) * Math.exp(-tt / 1.5) * (Math.sin(2 * Math.PI * f * tt) + 0.5 * Math.sin(4 * Math.PI * f * tt));
    }, Math.round(4 * ibi * SR));
  }
  for (let i = 0; i < n; i++) x[i] += noise * (r() * 2 - 1);
  return { x, beats, downs };
}

/** Independent F-measure (greedy one-to-one matching within ±tol s). */
function fMeasure(est, ref, tol = 0.07) {
  const used = new Uint8Array(ref.length);
  let hit = 0;
  for (const e of est) {
    let bj = -1;
    let bd = Infinity;
    for (let j = 0; j < ref.length; j++) {
      const d = Math.abs(e - ref[j]);
      if (!used[j] && d <= tol && d < bd) {
        bd = d;
        bj = j;
      }
    }
    if (bj >= 0) {
      used[bj] = 1;
      hit++;
    }
  }
  const p = est.length ? hit / est.length : 0;
  const r = ref.length ? hit / ref.length : 0;
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

/** Asserts tempo, beat F and downbeat F of a SongAnalysis against ground truth. */
function assertRhythm(a, bpm, beats, downs, label) {
  assert.ok(Math.abs(a.tempo.bpm - bpm) <= 1.5, `${label}: bpm ${a.tempo.bpm} vs ${bpm}`);
  const fb = fMeasure(a.beats, beats);
  assert.ok(fb >= 0.9, `${label}: beat F ${fb.toFixed(3)} < 0.9`);
  const fd = fMeasure(a.downbeats, downs);
  assert.ok(fd >= 0.9, `${label}: downbeat F ${fd.toFixed(3)} < 0.9 (wrong bar phase?)`);
  // every reported downbeat must sit on a true downbeat (phase, not just count)
  const off = a.downbeats.filter((d) => !downs.some((t) => Math.abs(t - d) <= 0.07)).length;
  assert.ok(off <= 1, `${label}: ${off} downbeats off the true bar grid`);
}

console.log("film_audio_tempo: FFT / features");

check("real FFT matches a naive DFT (n = 64)", () => {
  const n = 64;
  const r = rng(3);
  const x = Float64Array.from({ length: n }, () => r() * 2 - 1);
  const fft = createRealFFT(n);
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  fft.forward(x, re, im);
  for (let k = 0; k <= n / 2; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      sr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      si -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    assert.ok(Math.abs(re[k] - sr) < 1e-9 && Math.abs(im[k] - si) < 1e-9, `bin ${k}`);
  }
  const pw = new Float64Array(n / 2 + 1);
  fft.power(x, pw);
  assert.ok(Math.abs(pw[5] - (re[5] ** 2 + im[5] ** 2)) < 1e-9);
});

check("Hann window and centred STFT frame count", () => {
  const w = hannWindow(8);
  assert.equal(w[0], 0);
  assert.ok(Math.abs(w[4] - 1) < 1e-12);
  assert.equal(stftFrameCount(22050, 512), 1 + Math.floor(22050 / 512));
});

check("resample 44100 → 22050 keeps a 1 kHz sine (frequency, level) and removes a 15 kHz tone", () => {
  const n = 44100;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100) + 0.3 * Math.sin((2 * Math.PI * 15000 * i) / 44100);
  const y = resample(x, 44100, 22050);
  assert.equal(y.length, 22050);
  let c = 0;
  let s = 0;
  let pow = 0;
  for (let i = 2000; i < 20000; i++) {
    c += y[i] * Math.cos((2 * Math.PI * 1000 * i) / 22050);
    s += y[i] * Math.sin((2 * Math.PI * 1000 * i) / 22050);
    pow += y[i] * y[i];
  }
  const amp = (2 * Math.hypot(c, s)) / 18000;
  assert.ok(Math.abs(amp - 0.5) < 0.01, `1 kHz amplitude ${amp}`);
  const rms = Math.sqrt(pow / 18000);
  assert.ok(Math.abs(rms - 0.5 / Math.SQRT2) < 0.01, `alias leaked: rms ${rms}`);
});

check("features: A4 sine → chroma peak at A, 40 mel bands, 13 MFCC, RMS ≈ amp/√2", () => {
  const n = SR * 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const f = computeFeatures(x, SR);
  assert.equal(f.nMels, 40);
  assert.equal(f.nMfcc, 13);
  assert.equal(f.melDb.length, f.nFrames * 40);
  const t = Math.floor(f.nFrames / 2);
  let best = 0;
  for (let c = 1; c < 12; c++) if (f.chroma[t * 12 + c] > f.chroma[t * 12 + best]) best = c;
  assert.equal(best, 9, "chroma argmax should be A (9)");
  assert.ok(Math.abs(f.chroma[t * 12 + 9] - 1) < 1e-6, "chroma is L∞-normalised");
  assert.ok(Math.abs(f.rms[t] - 0.4 / Math.SQRT2) < 0.005, `rms ${f.rms[t]}`);
  const fb = melFilterbank({ sampleRate: SR, nFft: 2048 });
  assert.equal(fb.bands.length, 40);
  assert.ok(fb.centers[39] < SR / 2 && fb.centers[0] > 0);
});

check("energy curve: 0.5 s windows normalised to a max of 1", () => {
  const x = new Float32Array(SR * 3);
  for (let i = SR; i < 2 * SR; i++) x[i] = 0.5;
  for (let i = 2 * SR; i < 3 * SR; i++) x[i] = 0.25;
  const e = energyCurve(x, SR);
  assert.equal(e.hopSec, 0.5);
  assert.equal(e.values.length, 6);
  assert.deepEqual(Array.from(e.values), [0, 0, 1, 1, 0.5, 0.5]);
});

console.log("film_audio_tempo: tempo helpers");

check("log-normal tempo prior peaks at 120 BPM and is symmetric in octaves", () => {
  assert.equal(tempoPrior(120), 1);
  assert.ok(Math.abs(tempoPrior(60) - tempoPrior(240)) < 1e-12);
  assert.ok(tempoPrior(100) > tempoPrior(70));
  assert.equal(TEMPO_DEFAULTS.tightness, 100);
});

check("parabolic peak refinement and autocorrelation of a pulse train", () => {
  assert.ok(Math.abs(parabolicOffset(1, 2, 1)) < 1e-12);
  assert.ok(parabolicOffset(1, 2, 1.5) > 0 && parabolicOffset(1.5, 2, 1) < 0);
  const x = new Float64Array(400);
  for (let i = 0; i < 400; i += 20) x[i] = 1;
  const ac = autocorrelation(x, 60);
  let best = 10;
  for (let l = 10; l <= 60; l++) if (ac[l] > ac[best]) best = l;
  assert.equal(best, 20);
});

check("estimateTempo on an impulse envelope at 43.07 frames/s", () => {
  const fr = SR / 512;
  const env = new Float64Array(2600);
  const period = (60 * fr) / 128;
  for (let k = 0; ; k++) {
    const p = Math.round(5 + k * period);
    if (p >= env.length) break;
    env[p] = 1;
  }
  const est = estimateTempo(env, fr);
  assert.ok(Math.abs(est.bpm - 128) < 1.5, `bpm ${est.bpm}`);
  assert.ok(est.clarity > 0.3);
});

check("buildBars extrapolates whole bars before the first downbeat and covers the song", () => {
  const bars = buildBars([2.5, 4.5, 6.5, 8.5], 2, 11);
  assert.deepEqual(
    bars.map((b) => b.start),
    [0.5, 2.5, 4.5, 6.5, 8.5],
  );
  assert.equal(bars[bars.length - 1].end, 10.5);
  bars.forEach((b, i) => assert.equal(b.i, i));
});

console.log("film_audio_tempo: click tracks (60 s, accented downbeats, pickup beat first)");

for (const bpm of [90, 120, 128, 150, 174]) {
  check(`click track ${bpm} BPM: bpm ±1.5, beat F ≥ 0.9, downbeat phase correct`, () => {
    const { x, beats, downs } = clickTrack(bpm, { seed: bpm });
    const a = analyzeSong(x, SR);
    assertRhythm(a, bpm, beats, downs, `${bpm} BPM`);
  });
}

console.log("film_audio_tempo: robustness");

for (const bpm of [120, 174]) {
  check(`click track ${bpm} BPM under white noise (−26 dBFS): still correct`, () => {
    const { x, beats, downs } = clickTrack(bpm, { noise: 0.05, seed: 1000 + bpm });
    const a = analyzeSong(x, SR);
    assertRhythm(a, bpm, beats, downs, `${bpm} BPM + noise`);
  });
}

check("click track starting ON the downbeat (phase 0) at 100 BPM", () => {
  const { x, beats, downs } = clickTrack(100, { firstDownIdx: 0, offset: 0.7, seed: 5 });
  const a = analyzeSong(x, SR);
  assertRhythm(a, 100, beats, downs, "100 BPM phase 0");
});

for (const bpm of [100, 140]) {
  check(`kick/snare/hat drum loop ${bpm} BPM with noise: tempo, beats, downbeats`, () => {
    const { x, beats, downs } = drumLoop(bpm, { seed: bpm });
    const a = analyzeSong(x, SR);
    assertRhythm(a, bpm, beats, downs, `drums ${bpm}`);
  });
}

check("44.1 kHz input is resampled and analysed the same (128 BPM)", () => {
  const { x, beats, downs } = clickTrack(128, { sr: 44100, dur: 40, seed: 44 });
  const a = analyzeSong(x, 44100);
  assert.equal(a.sampleRate, ANALYSIS_SAMPLE_RATE);
  assert.equal(a.sourceSampleRate, 44100);
  assert.ok(Math.abs(a.durationSec - 40) < 1e-3, `duration ${a.durationSec}`);
  assertRhythm(a, 128, beats, downs, "44.1k");
});

check("analyzeRhythm reports beat frames consistent with ONSET_FRAME_SHIFT", () => {
  const { x } = clickTrack(120, { dur: 20, seed: 9 });
  const f = computeFeatures(x, SR);
  const o = onsetEnvelope(f);
  const r = analyzeRhythm(f, o);
  assert.equal(r.beats.length, r.beatFrames.length);
  for (let i = 0; i < r.beats.length; i++) assert.ok(Math.abs(r.beats[i] - (r.beatFrames[i] + ONSET_FRAME_SHIFT) / o.frameRate) < 1e-9);
  assert.ok(Math.abs(r.barSec - 2) < 0.01, `barSec ${r.barSec}`);
});

console.log("film_audio_tempo: SongAnalysis shape and determinism");

check("SongAnalysis shape: version, bars cover the song, beats ascending, deterministic JSON", () => {
  const { x } = clickTrack(110, { dur: 30, seed: 11 });
  const a = analyzeSong(x, SR);
  const b = analyzeSong(x, SR);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.version, SONG_ANALYSIS_VERSION);
  assert.equal(a.version, 1);
  for (const k of ["durationSec", "sampleRate", "tempo", "beats", "downbeats", "bars", "sections", "energy"]) assert.ok(k in a, k);
  assert.equal(a.lyrics, undefined);
  for (let i = 1; i < a.beats.length; i++) assert.ok(a.beats[i] > a.beats[i - 1]);
  assert.ok(a.bars[0].start >= 0 && a.bars[0].start < 60 / 110 * 4 + 1e-6);
  assert.ok(a.bars[a.bars.length - 1].end <= a.durationSec + 1e-9);
  for (let i = 1; i < a.bars.length; i++) assert.equal(a.bars[i].start, a.bars[i - 1].end);
  assert.ok(a.tempo.confidence > 0.5 && a.tempo.confidence <= 1, `confidence ${a.tempo.confidence}`);
  assert.equal(a.energy.hopSec, 0.5);
  assert.equal(a.energy.values.length, 60);
  assert.ok(Math.max(...a.energy.values) === 1 && Math.min(...a.energy.values) >= 0);
  assert.equal(a.sections[0].start, 0);
  assert.equal(a.sections[a.sections.length - 1].end, a.durationSec);
});

check("silence and very short input do not throw (fallback tempo, zero confidence)", () => {
  const a = analyzeSong(new Float32Array(SR * 3), SR);
  assert.equal(a.tempo.confidence, 0);
  assert.equal(a.beats.length, 0);
  assert.equal(a.sections.length, 1);
  assert.equal(a.sections[0].role, "unknown");
  const b = analyzeSong(Float32Array.of(0.1, -0.1, 0.2), 8000);
  assert.ok(b.durationSec > 0);
  assert.throws(() => analyzeSong(new Float32Array(0), SR), /empty/);
  assert.throws(() => analyzeSong(new Float32Array(10), 0), /sampleRate/);
});

check("non-finite samples are treated as silence", () => {
  const { x } = clickTrack(120, { dur: 12, seed: 12 });
  x[1000] = NaN;
  x[2000] = Infinity;
  const a = analyzeSong(x, SR);
  assert.ok(Number.isFinite(a.tempo.bpm) && a.energy.values.every(Number.isFinite));
});

console.log(`film_audio_tempo: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
