// scene3d/drone/audio.js — Drone Deploy motor hum (scene3d/drone/SPEC.md §3.7).
//
// WHY: a drone that makes no sound feels dead, and the hum is the cheapest cue
// for throttle and distance. It is synthesised, not a DAT Wave: two detuned
// sawtooth oscillators through a low-pass, plus band-passed looping noise for
// prop wash, pitch / brightness / level following throttle, speed and the rotor
// arm level. It goes out through the client's effect bus
// (`audioManager.getEffectBus()`, the §6.2 seam), so the master and effect
// sliders and the focus mute apply exactly as for a `category: "effect"` voice,
// and it takes no slot in the retail voice pool. In the goggles it plays in-ear
// (the listener follows the active camera, which IS the drone eye); in third
// person it crossfades onto an HRTF PannerNode at the drone (audio_manager's
// model: exponential, ref 5 m, rolloff 2, max 200 m).
//
// Graph (single-use nodes, built at gain 0 by start(), rebuilt after a stop):
//   oscA, oscB (sawtooth) → lowpass ─┐
//   noise (loop) → bandpass → noise ─┴→ input ─→ ear ─────────→ bus.node
//                                            └─→ pan → panner ─→ bus.node
// Noise comes from mulberry32(hashString("drone-audio")) — deterministic, and
// identical on every build. No timers: a stop schedules the oscillators' end on
// the audio clock and disconnects on `onended`.
//
// Drone Deploy is DEFAULT ON since 2026-10-25 (`?drone=off`, exact match, disables it); `?droneAudio=off`
// (read by index.js) passes `enabled: false` and no WebAudio node is built.
// Page module: the bus is injected; no bus → every method is a silent no-op.

import { hashString, mulberry32 } from "../film/core/rng.js";

/**
 * Hum synthesis constants (frequencies Hz, gains linear, times seconds).
 * @type {Readonly<Record<string, number>>}
 */
export const HUM_TUNING = Object.freeze({
  baseHz: 72, // oscillator A at throttle 0, fully armed
  throttleHz: 78, // + per unit throttle (thrust / weight; hover = 1 → 150 Hz)
  speedHz: 1.5, // + per m/s of airspeed
  maxHz: 420,
  spinFloor: 0.3, // pitch scale at arm level 0 (the spin-up rises from here)
  detuneRatio: 1.012, // oscillator B = A × ratio (a slow beat)
  cutoffBaseHz: 420,
  cutoffThrottleHz: 700,
  cutoffSpeedHz: 22,
  cutoffMaxHz: 4200,
  filterQ: 0.8,
  noiseBandHz: 1700, // prop-wash band
  noiseQ: 0.7,
  noiseBase: 0.05,
  noiseThrottle: 0.08,
  noiseSpeed: 0.006,
  noiseMax: 0.4,
  gainBase: 0.1,
  gainThrottle: 0.06,
  gainMax: 0.28,
  maxThrottle: 2.5,
  maxSpeed: 40,
  noiseSec: 2, // looping noise buffer length
  earTau: 0.08, // in-ear / panner crossfade time constant
  levelTau: 0.05, // level, pitch, filter and noise time constant
  refDistance: 5,
  rolloffFactor: 2,
  maxDistance: 200,
});

const NOISE_SEED = "drone-audio";
const EPS = 1e-5;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const clampN = (v, lo, hi) => (!fin(v) ? lo : v < lo ? lo : v > hi ? hi : v);

/** humParams body writing into `out` (allocation-free for the per-frame path). */
function humParamsInto(out, throttle, speed, level) {
  const T = HUM_TUNING;
  const t = clampN(throttle, 0, T.maxThrottle);
  const s = clampN(speed, 0, T.maxSpeed);
  const l = clampN(level, 0, 1);
  const spin = T.spinFloor + (1 - T.spinFloor) * l;
  out.freqA = Math.min(T.maxHz, (T.baseHz + T.throttleHz * t) * spin + T.speedHz * s);
  out.freqB = out.freqA * T.detuneRatio;
  out.cutoffHz = Math.min(T.cutoffMaxHz, (T.cutoffBaseHz + T.cutoffThrottleHz * t) * spin + T.cutoffSpeedHz * s);
  out.noiseGain = Math.min(T.noiseMax, T.noiseBase + T.noiseThrottle * t + T.noiseSpeed * s);
  out.gain = l > 0 ? l * Math.min(T.gainMax, T.gainBase + T.gainThrottle * t) : 0;
  return out;
}

/**
 * Hum parameters for a rotor state (pure; every field finite; `gain` is 0 when
 * `level <= 0`; `freqA` and `cutoffHz` are non-decreasing in throttle).
 * @param {{throttle?: number, speed?: number, level?: number}} [state]
 *   throttle = thrust / weight (0..2.5), speed m/s, level = rotor arm level 0..1;
 *   a missing / non-object state reads as all zero (never throws)
 * @returns {{freqA: number, freqB: number, cutoffHz: number, noiseGain: number, gain: number}}
 */
export function humParams(state = {}) {
  const s = state && typeof state === "object" ? state : {};
  return humParamsInto({ freqA: 0, freqB: 0, cutoffHz: 0, noiseGain: 0, gain: 0 }, s.throttle, s.speed, s.level);
}

function setParam(param, v) {
  if (!param) return;
  try { param.value = v; } catch (_) { /* a read-only fake */ }
}

function targetParam(param, v, t, tau) {
  if (!param) return;
  try {
    if (typeof param.setTargetAtTime === "function") param.setTargetAtTime(v, t, tau);
    else param.value = v;
  } catch (_) {
    try { param.value = v; } catch (_e) { /* give up on this param */ }
  }
}

/**
 * Create the drone motor hum (SPEC §3.7).
 *
 * @param {{bus?: ({ctx: object, node: object, sliderGain?: () => number}|(() => object|null)|null),
 *   enabled?: boolean, volume?: () => number, rng?: () => number, clock?: () => number}} [deps]
 *   `bus` — the effect bus, or a getter resolved at `start()` and, while started
 *   but unbuilt, at most once per second in `update()`; `volume` — the drone
 *   volume setting (0..1, default 1); `rng` — fills the noise table once per
 *   instance (default `mulberry32(hashString("drone-audio"))`); `clock` —
 *   seconds for the 1 Hz bus retry (default `performance.now() / 1000`).
 * @returns {{
 *   start: () => boolean,
 *   update: (u: {throttle: number, speed: number, level: number, fpv: boolean, pos: ArrayLike<number>|null}) => void,
 *   stop: (opts?: {fadeSec?: number}) => void,
 *   dispose: () => void,
 *   readonly active: boolean,
 *   stats: () => {built: boolean, started: boolean, nodes: number}}}
 */
export function createDroneAudio(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const enabled = d.enabled !== false;
  const busDep = d.bus;
  const clock = typeof d.clock === "function"
    ? d.clock
    : () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() / 1000 : 0);
  const T = HUM_TUNING;

  let started = false;
  let disposed = false;
  /** @type {null|object} the current graph */
  let graph = null;
  let lastResolveAt = -Infinity;
  /** @type {Float32Array|null} */
  let noiseData = null;
  const P = { freqA: 0, freqB: 0, cutoffHz: 0, noiseGain: 0, gain: 0 };
  const last = { out: NaN, freqA: NaN, freqB: NaN, cutoff: NaN, noise: NaN, fpv: null, x: NaN, y: NaN, z: NaN };
  const resetLast = () => {
    last.out = last.freqA = last.freqB = last.cutoff = last.noise = NaN;
    last.fpv = null;
    last.x = last.y = last.z = NaN;
  };

  function resolveBus() {
    let b = null;
    if (typeof busDep === "function") {
      try { b = busDep(); } catch (_) { b = null; }
    } else if (busDep && typeof busDep === "object") {
      b = busDep;
    }
    if (!b || typeof b !== "object" || !b.ctx || typeof b.ctx !== "object" || !b.node) return null;
    return b;
  }

  function noiseFor(len) {
    if (noiseData && noiseData.length === len) return noiseData;
    const rng = typeof d.rng === "function" ? d.rng : mulberry32(hashString(NOISE_SEED));
    const a = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const r = Number(rng());
      a[i] = Number.isFinite(r) ? r * 2 - 1 : 0;
    }
    noiseData = a;
    return a;
  }

  function teardown(g) {
    if (!g || g.dead) return;
    g.dead = true;
    for (const src of g.sources) {
      try { src.onended = null; } catch (_) {}
      try { src.stop(); } catch (_) { /* already stopped */ }
    }
    for (const n of g.nodes) {
      try { n.disconnect(); } catch (_) {}
    }
    if (graph === g) graph = null;
  }

  function build(bus) {
    const ctx = bus.ctx;
    const nodes = [];
    try {
      const t = fin(ctx.currentTime) ? ctx.currentTime : 0;
      humParamsInto(P, 0, 0, 0);
      const oscA = ctx.createOscillator();
      nodes.push(oscA);
      oscA.type = "sawtooth";
      setParam(oscA.frequency, P.freqA);
      const oscB = ctx.createOscillator();
      nodes.push(oscB);
      oscB.type = "sawtooth";
      setParam(oscB.frequency, P.freqB);
      const lowpass = ctx.createBiquadFilter();
      nodes.push(lowpass);
      lowpass.type = "lowpass";
      setParam(lowpass.frequency, P.cutoffHz);
      setParam(lowpass.Q, T.filterQ);
      const sr = fin(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
      const len = Math.max(1, Math.round(sr * T.noiseSec));
      const buf = ctx.createBuffer(1, len, sr);
      const ch = buf.getChannelData(0);
      ch.set(noiseFor(len));
      const noise = ctx.createBufferSource();
      nodes.push(noise);
      noise.buffer = buf;
      noise.loop = true;
      const bandpass = ctx.createBiquadFilter();
      nodes.push(bandpass);
      bandpass.type = "bandpass";
      setParam(bandpass.frequency, T.noiseBandHz);
      setParam(bandpass.Q, T.noiseQ);
      const noiseGain = ctx.createGain();
      nodes.push(noiseGain);
      setParam(noiseGain.gain, P.noiseGain);
      const input = ctx.createGain();
      nodes.push(input);
      setParam(input.gain, 0); // silent until an update with level > 0
      const ear = ctx.createGain();
      nodes.push(ear);
      setParam(ear.gain, 0);
      const pan = ctx.createGain();
      nodes.push(pan);
      setParam(pan.gain, 1);
      const panner = ctx.createPanner();
      nodes.push(panner);
      panner.panningModel = "HRTF";
      panner.distanceModel = "exponential";
      panner.refDistance = T.refDistance;
      panner.rolloffFactor = T.rolloffFactor;
      panner.maxDistance = T.maxDistance;

      oscA.connect(lowpass);
      oscB.connect(lowpass);
      lowpass.connect(input);
      noise.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(input);
      input.connect(ear);
      ear.connect(bus.node);
      input.connect(pan);
      pan.connect(panner);
      panner.connect(bus.node);

      const g = {
        ctx, bus, oscA, oscB, lowpass, noise, bandpass, noiseGain, input, ear, pan, panner,
        nodes, sources: [oscA, oscB, noise], stopping: false, dead: false,
      };
      oscA.start(t);
      oscB.start(t);
      noise.start(t);
      graph = g;
      resetLast();
      return true;
    } catch (_) {
      teardown({ nodes, sources: nodes.filter((n) => n && typeof n.stop === "function"), dead: false });
      return false;
    }
  }

  function resume(ctx) {
    if (ctx.state !== "suspended" || typeof ctx.resume !== "function") return;
    try {
      const p = ctx.resume();
      if (p && typeof p.then === "function") p.then(undefined, () => {});
    } catch (_) {
      /* resumes on a later gesture */
    }
  }

  function start() {
    if (disposed || !enabled) return false;
    const getter = typeof busDep === "function";
    if (!getter && !(busDep && typeof busDep === "object")) return false;
    if (graph && !graph.stopping) {
      started = true;
      return true; // already running
    }
    if (graph) teardown(graph); // a fading graph from stop(): its nodes are single-use
    lastResolveAt = clock();
    const bus = resolveBus();
    if (!bus) {
      started = getter; // a getter is retried by update() at ≤ 1 Hz
      return false;
    }
    started = true;
    resume(bus.ctx);
    return build(bus);
  }

  function readVolume() {
    if (typeof d.volume !== "function") return 1;
    let v;
    try { v = Number(d.volume()); } catch (_) { return 0; }
    return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
  }

  function readSlider(bus) {
    if (typeof bus.sliderGain !== "function") return 1;
    let v;
    try { v = Number(bus.sliderGain()); } catch (_) { return 1; }
    return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 1;
  }

  function update(u) {
    if (!started || disposed) return;
    let g = graph;
    if (!g) {
      if (typeof busDep !== "function") return;
      const now = clock();
      if (now - lastResolveAt < 1) return;
      lastResolveAt = now;
      const bus = resolveBus();
      if (!bus || !build(bus)) return;
      g = graph;
    }
    if (!g || g.stopping || !u || typeof u !== "object") return;
    humParamsInto(P, u.throttle, u.speed, u.level);
    const out = P.gain * readVolume() * readSlider(g.bus);
    const t = fin(g.ctx.currentTime) ? g.ctx.currentTime : 0;
    if (!(Math.abs(out - last.out) <= EPS)) { last.out = out; targetParam(g.input.gain, out, t, T.levelTau); }
    if (!(Math.abs(P.freqA - last.freqA) <= 0.01)) { last.freqA = P.freqA; targetParam(g.oscA.frequency, P.freqA, t, T.levelTau); }
    if (!(Math.abs(P.freqB - last.freqB) <= 0.01)) { last.freqB = P.freqB; targetParam(g.oscB.frequency, P.freqB, t, T.levelTau); }
    if (!(Math.abs(P.cutoffHz - last.cutoff) <= 0.5)) { last.cutoff = P.cutoffHz; targetParam(g.lowpass.frequency, P.cutoffHz, t, T.levelTau); }
    if (!(Math.abs(P.noiseGain - last.noise) <= EPS)) { last.noise = P.noiseGain; targetParam(g.noiseGain.gain, P.noiseGain, t, T.levelTau); }
    const fpv = u.fpv === true;
    if (fpv !== last.fpv) {
      last.fpv = fpv;
      targetParam(g.ear.gain, fpv ? 1 : 0, t, T.earTau);
      targetParam(g.pan.gain, fpv ? 0 : 1, t, T.earTau);
    }
    const p = u.pos;
    if (p && fin(p[0]) && fin(p[1]) && fin(p[2])) {
      // AC (x east, y north, z up) → three world (x, z, −y).
      const x = p[0];
      const y = p[2];
      const z = -p[1] + 0;
      if (x !== last.x || y !== last.y || z !== last.z) {
        last.x = x;
        last.y = y;
        last.z = z;
        const pn = g.panner;
        if (pn.positionX && typeof pn.positionX === "object") {
          setParam(pn.positionX, x);
          setParam(pn.positionY, y);
          setParam(pn.positionZ, z);
        } else if (typeof pn.setPosition === "function") {
          try { pn.setPosition(x, y, z); } catch (_) {}
        }
      }
    }
  }

  function stop(opts) {
    started = false; // update is a no-op from here until the next start()
    const g = graph;
    if (!g || g.stopping || g.dead) return;
    g.stopping = true;
    const raw = opts && typeof opts === "object" ? opts.fadeSec : undefined;
    const fade = fin(raw) ? Math.min(Math.max(raw, 0), 10) : 0.4;
    if (fade <= 0) {
      teardown(g);
      return;
    }
    const t = fin(g.ctx.currentTime) ? g.ctx.currentTime : 0;
    try { if (typeof g.input.gain.cancelScheduledValues === "function") g.input.gain.cancelScheduledValues(t); } catch (_) {}
    targetParam(g.input.gain, 0, t, fade / 5); // ≈ 99 % down at the end of the fade
    const done = () => teardown(g);
    for (const src of g.sources) {
      try { src.stop(t + fade); } catch (_) {}
    }
    try { g.oscA.onended = done; } catch (_) {}
  }

  function dispose() {
    started = false;
    if (graph) teardown(graph);
    disposed = true;
  }

  return {
    start,
    update,
    stop,
    dispose,
    get active() {
      return started && !disposed;
    },
    stats: () => ({ built: graph !== null, started, nodes: graph ? graph.nodes.length : 0 }),
  };
}
