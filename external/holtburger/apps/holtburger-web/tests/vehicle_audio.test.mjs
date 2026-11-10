// tests/vehicle_audio.test.mjs — Unit & integration suite for the F6F Hellcat WebAudio soundscape.
//
// Run from apps/holtburger-web/: node tests/vehicle_audio.test.mjs

import assert from "node:assert/strict";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

const tSuiteStart = performance.now();
const fake = installFakeAudio();
const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
const V = await import("../scene3d/vehicle/audio.js");
const { MODE } = await import("../scene3d/vehicle/flight_model.js");
const { mulberry32, hashString } = await import("../scene3d/film/core/rng.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}
const near = (a, b, eps = 1e-6, msg = "") =>
  assert.ok(Math.abs(a - b) <= eps, `${msg ? `${msg}: ` : ""}expected ${b} ± ${eps}, got ${a}`);

// ---------------------------------------------------------------------------
// Fast 8 kHz recording subclass of FakeAudioContext (full + minimal variants)
// ---------------------------------------------------------------------------

const BaseCtx = globalThis.window.AudioContext;

function rparam(v = 0) {
  return {
    value: v,
    calls: [],
    setTargetAtTime(target, t, tau) {
      this.calls.push(["target", target, t, tau]);
      this.value = target;
    },
    setValueAtTime(val, t) {
      this.calls.push(["set", val, t]);
      this.value = val;
    },
    linearRampToValueAtTime(val, t) {
      this.calls.push(["lin", val, t]);
      this.value = val;
    },
    exponentialRampToValueAtTime(val, t) {
      this.calls.push(["exp", val, t]);
      this.value = val;
    },
    cancelScheduledValues(t) {
      this.calls.push(["cancel", t]);
    },
  };
}

class VehicleFakeCtx extends BaseCtx {
  constructor() {
    super();
    this.sampleRate = 8000;
    this.made = [];
    this.resumes = 0;
    this.periodicWaves = 0;
  }
  _n(kind, extra) {
    const n = {
      kind,
      connections: [],
      connect(to) {
        this.connections.push(to);
        return to;
      },
      disconnect() {
        this.connections = [];
      },
      ...extra,
    };
    this.made.push(n);
    return n;
  }
  _src(kind, extra) {
    return this._n(kind, {
      started: null,
      stopAt: null,
      stopped: false,
      onended: null,
      start(t = 0) {
        this.started = t;
      },
      stop(t) {
        this.stopped = true;
        this.stopAt = t === undefined ? "now" : t;
      },
      ...extra,
    });
  }
  createOscillator() {
    return this._src("osc", {
      type: "sine",
      periodicWave: null,
      frequency: rparam(440),
      detune: rparam(0),
      setPeriodicWave(w) {
        this.periodicWave = w;
        this.type = "custom";
      },
    });
  }
  createPeriodicWave(real, imag) {
    this.periodicWaves += 1;
    return { real: Float32Array.from(real), imag: Float32Array.from(imag) };
  }
  createWaveShaper() {
    return this._n("shaper", { curve: null, oversample: "none" });
  }
  createBiquadFilter() {
    return this._n("biquad", { type: "lowpass", frequency: rparam(350), Q: rparam(1), gain: rparam(0) });
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createBufferSource() {
    return this._src("bufsrc", { buffer: null, loop: false });
  }
  createGain() {
    return this._n("gain", { gain: rparam(1) });
  }
  createPanner() {
    return this._n("panner", {
      panningModel: "equalpower",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 10000,
      positionX: rparam(0),
      positionY: rparam(0),
      positionZ: rparam(0),
    });
  }
  async resume() {
    this.resumes += 1;
    this.state = "running";
  }
}

/** Minimal context lacking createPeriodicWave, createWaveShaper, and ramp methods. */
class MinimalFakeCtx extends VehicleFakeCtx {
  constructor() {
    super();
    this.createPeriodicWave = undefined;
    this.createWaveShaper = undefined;
  }
  createOscillator() {
    const f = { value: 440, setTargetAtTime(v) { this.value = v; } };
    return this._src("osc", { type: "sine", frequency: f });
  }
}

function makeBus({ slider = 1, state = "running", Ctx = VehicleFakeCtx } = {}) {
  const ctx = new Ctx();
  ctx.state = state;
  const node = ctx._n("bus", { gain: rparam(1) });
  ctx.made.length = 0; // record only vehicle nodes
  let s = slider;
  return {
    ctx,
    node,
    sliderGain: () => s,
    setSlider(v) {
      s = v;
    },
  };
}

function flushEnded(ctx) {
  for (const n of [...ctx.made]) {
    if (typeof n.onended === "function" && n.stopped) {
      const fn = n.onended;
      fn();
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Pure Acoustic Model: hellcatEngineParams & HELLCAT_AUDIO_TUNING
// ---------------------------------------------------------------------------

check("1.1 HELLCAT_AUDIO_TUNING is frozen; hellcatEngineParams is pure, deterministic, and finite on hostile inputs", () => {
  assert.ok(Object.isFrozen(V.HELLCAT_AUDIO_TUNING));
  const expectedKeys = [
    "blowerGain", "blowerHz", "buffetGain", "crankHz", "diveHowlGain", "diveHowlHz",
    "drive", "fireHz", "propBpfHz", "radialCutoffHz", "radialGain", "rpm",
    "rpmNorm", "stallHornGain", "tipBuzzGain", "windCutoffHz", "windGain",
  ];
  const p0 = V.hellcatEngineParams();
  assert.deepEqual(Object.keys(p0).sort(), expectedKeys);

  const hostile = [undefined, null, NaN, Infinity, -Infinity, -999, 1e9, "bad", {}, true];
  for (const x of hostile) {
    const direct = V.hellcatEngineParams(x);
    const fields = V.hellcatEngineParams({
      throttle: x, speed: x, mode: x, boost: x, pitch: x, bank: x,
      gLoad: x, vMin: x, backPressure: x, level: x,
    });
    for (const k of expectedKeys) {
      assert.ok(Number.isFinite(direct[k]), `direct ${k} finite for ${String(x)}`);
      assert.ok(Number.isFinite(fields[k]), `fields ${k} finite for ${String(x)}`);
      assert.ok(!Object.is(direct[k], -0), `no -0 on ${k}`);
    }
  }
  assert.deepEqual(
    V.hellcatEngineParams({ throttle: 0.72, speed: 83, mode: MODE.FLIGHT }),
    V.hellcatEngineParams({ throttle: 0.72, speed: 83, mode: MODE.FLIGHT }),
  );
});

check("1.2 R-2800-10W operating points & monotonicity: parked idle (660 RPM) → cruise (83 m/s) → military → WEP (111 m/s) & NO 40 m/s clamp", () => {
  const idle = V.hellcatEngineParams({ throttle: 0, speed: 0, mode: MODE.PARKED, boost: false });
  near(idle.rpm, 660, 1e-6, "parked idle RPM");
  near(idle.crankHz, 11, 1e-6, "idle crankHz");
  near(idle.fireHz, 99, 1e-6, "idle 9-per-rev fireHz");
  near(idle.propBpfHz, 16.5, 1e-6, "idle 3-blade 2:1 propBpfHz");
  near(idle.rpmNorm, 0, 1e-6);
  near(idle.blowerHz, 1150, 1e-6);
  assert.equal(idle.tipBuzzGain, 0);
  assert.equal(idle.windGain, 0);
  assert.equal(idle.diveHowlGain, 0);
  assert.equal(idle.buffetGain, 0);
  assert.equal(idle.stallHornGain, 0);

  const cruise = V.hellcatEngineParams({ throttle: 0.67, speed: 83, mode: MODE.FLIGHT, boost: false });
  assert.ok(cruise.rpm > 2050 && cruise.rpm < 2250, `cruise ~2150 RPM, got ${cruise.rpm}`);
  near(cruise.crankHz, cruise.rpm / 60, 1e-6);
  near(cruise.propBpfHz, 1.5 * cruise.crankHz, 1e-6);
  assert.ok(cruise.rpmNorm < 0.76, "cruise sits below transonic tip-buzz onset");
  assert.equal(cruise.tipBuzzGain, 0, "clean cruise chop without tip rasp");

  const mil = V.hellcatEngineParams({ throttle: 1.0, speed: 83, mode: MODE.FLIGHT, boost: false });
  near(mil.rpm, 2700, 1e-6, "military 2700 RPM");
  near(mil.crankHz, 45, 1e-6, "military 45 Hz");
  near(mil.propBpfHz, 67.5, 1e-6, "military 67.5 Hz prop chop");
  assert.ok(mil.rpmNorm > 0.76);
  assert.ok(mil.tipBuzzGain > 0, "military power triggers prop-tip rasp");

  const wep = V.hellcatEngineParams({ throttle: 1.0, speed: 111, mode: MODE.FLIGHT, boost: true });
  near(wep.rpm, 2820, 1e-6, "WEP 2820 RPM");
  near(wep.crankHz, 47, 1e-6, "WEP 47 Hz");
  near(wep.propBpfHz, 70.5, 1e-6, "WEP 70.5 Hz");
  near(wep.blowerHz, 4450, 1e-6, "WEP two-stage blower whine 4450 Hz");
  assert.ok(wep.tipBuzzGain > mil.tipBuzzGain, "WEP rasp > military rasp");
  assert.ok(wep.blowerHz > mil.blowerHz && wep.blowerGain > mil.blowerGain, "supercharger steps up in boost");
  assert.ok(wep.drive > mil.drive && mil.drive > cruise.drive && cruise.drive > idle.drive);

  // Airborne windmilling RPM floor at throttled-back glide
  const glide = V.hellcatEngineParams({ throttle: 0, speed: 80, mode: MODE.FLIGHT });
  assert.ok(glide.rpm > idle.rpm + 400, `airborne windmilling RPM (${glide.rpm}) > parked idle (${idle.rpm})`);

  // Monotonicity across throttle [0..1]
  let prevRpm = -Infinity;
  let prevCut = -Infinity;
  let prevBlower = -Infinity;
  for (let th = 0; th <= 1.0001; th += 0.05) {
    const p = V.hellcatEngineParams({ throttle: th, speed: 83, mode: MODE.FLIGHT });
    assert.ok(p.rpm >= prevRpm - 1e-9, `RPM monotonic at throttle ${th}`);
    assert.ok(p.radialCutoffHz >= prevCut - 1e-9, `radialCutoffHz monotonic at throttle ${th}`);
    assert.ok(p.blowerHz >= prevBlower - 1e-9, `blowerHz monotonic at throttle ${th}`);
    prevRpm = p.rpm;
    prevCut = p.radialCutoffHz;
    prevBlower = p.blowerHz;
  }

  // Full 0..115 m/s slipstream — proving NO 40 m/s clamp!
  const w0 = V.hellcatEngineParams({ throttle: 0.5, speed: 0, mode: MODE.FLIGHT });
  const w40 = V.hellcatEngineParams({ throttle: 0.5, speed: 40, mode: MODE.FLIGHT });
  const w83 = V.hellcatEngineParams({ throttle: 0.5, speed: 83, mode: MODE.FLIGHT });
  const w111 = V.hellcatEngineParams({ throttle: 0.5, speed: 111, mode: MODE.FLIGHT });
  const w115 = V.hellcatEngineParams({ throttle: 0.5, speed: 115, mode: MODE.FLIGHT });
  assert.ok(w0.windGain < w40.windGain && w40.windGain < w83.windGain && w83.windGain < w111.windGain && w111.windGain < w115.windGain,
    "windGain scales strictly across 0 → 40 → 83 → 111 → 115 m/s");
  assert.ok(w0.windCutoffHz < w40.windCutoffHz && w40.windCutoffHz < w83.windCutoffHz && w83.windCutoffHz < w111.windCutoffHz && w111.windCutoffHz < w115.windCutoffHz,
    "windCutoffHz scales strictly across 0 → 40 → 83 → 111 → 115 m/s");
});

check("1.3 Steep-dive howl, high-G / pre-stall airframe buffet, and stall / backPressure warning horn", () => {
  // Dive howl requires BOTH pitch < -0.18 AND speed > 58
  assert.equal(V.hellcatEngineParams({ pitch: -0.10, speed: 95, mode: MODE.FLIGHT }).diveHowlGain, 0, "shallow dive silent");
  assert.equal(V.hellcatEngineParams({ pitch: -0.45, speed: 50, mode: MODE.FLIGHT }).diveHowlGain, 0, "slow dive silent");
  const dive1 = V.hellcatEngineParams({ pitch: -0.30, speed: 75, mode: MODE.FLIGHT });
  const dive2 = V.hellcatEngineParams({ pitch: -0.55, speed: 108, mode: MODE.FLIGHT });
  assert.ok(dive1.diveHowlGain > 0 && dive2.diveHowlGain > dive1.diveHowlGain);
  assert.ok(dive1.diveHowlHz >= 320 && dive2.diveHowlHz <= 680 && dive2.diveHowlHz > dive1.diveHowlHz);
  assert.ok(dive2.tipBuzzGain > 0, "fast steep dive also excites prop-tip buzz");

  // High-G buffet (gLoad > 1.85)
  assert.equal(V.hellcatEngineParams({ speed: 83, gLoad: 1.5, mode: MODE.FLIGHT }).buffetGain, 0);
  const hiG = V.hellcatEngineParams({ speed: 83, gLoad: 3.2, mode: MODE.FLIGHT });
  assert.ok(hiG.buffetGain > 0 && hiG.stallHornGain === 0);

  // Pre-stall buffet (speed < vMin * 1.18 = 35.4) before stall horn (speed < vMin * 1.12 = 33.6)
  const nibble = V.hellcatEngineParams({ speed: 34.5, vMin: 30, mode: MODE.FLIGHT });
  assert.ok(nibble.buffetGain > 0, "airframe shudders at 1.15 * vMin");
  assert.equal(nibble.stallHornGain, 0, "horn not yet active above 1.12 * vMin");

  const stall = V.hellcatEngineParams({ speed: 31.5, vMin: 30, mode: MODE.FLIGHT });
  assert.ok(stall.buffetGain > nibble.buffetGain);
  assert.ok(stall.stallHornGain > 0, "stall horn active below 1.12 * vMin");

  // Envelope backPressure triggers horn even at cruise speed
  const envWarn = V.hellcatEngineParams({ speed: 83, vMin: 30, mode: MODE.FLIGHT, backPressure: true });
  assert.ok(envWarn.stallHornGain > 0, "backPressure activates cockpit reed");

  // level: 0 silences all gains
  const muted = V.hellcatEngineParams({ throttle: 1, speed: 110, boost: true, pitch: -0.5, gLoad: 4, backPressure: true, level: 0 });
  for (const k of ["radialGain", "tipBuzzGain", "blowerGain", "windGain", "diveHowlGain", "buffetGain", "stallHornGain"]) {
    assert.equal(muted[k], 0, `${k} is 0 at level 0`);
  }
});

// ---------------------------------------------------------------------------
// 2. Coordinate Frame & 3D Doppler Helpers
// ---------------------------------------------------------------------------

check("2.1 acToThreePos, threeToAcPos, and computeDoppler: approach > 1.35, broadside === 1, receding < 0.80, no -0", () => {
  assert.deepEqual(V.acToThreePos([10, 20, 3]), [10, 3, -20]);
  assert.deepEqual(V.acToThreePos({ x: -4, y: 7.5, z: 12 }), [-4, 12, -7.5]);
  assert.deepEqual(V.threeToAcPos([10, 3, -20]), [10, 20, 3]);
  assert.deepEqual(V.threeToAcPos(V.acToThreePos([123.5, -456.25, 88])), [123.5, -456.25, 88]);
  assert.equal(V.acToThreePos(null), null);
  assert.equal(V.acToThreePos([NaN, 1, 2]), null);
  assert.equal(V.threeToAcPos(undefined), null);

  for (const zeroVec of [[0, 0, 0], [-0, 0, -0], [0, -0, 0], { x: -0, y: 0, z: -0 }]) {
    const t = V.acToThreePos(zeroVec);
    const a = V.threeToAcPos(zeroVec);
    for (const c of [...t, ...a]) assert.ok(!Object.is(c, -0), "strictly +0, never -0");
  }

  // Head-on approach: aircraft at y=300 flying south (-105 m/s) toward listener at origin
  const dApproach = V.computeDoppler([0, 300, 50], [0, -105, 0], [0, 0, 50], [0, 0, 0]);
  assert.ok(dApproach > 1.35, `head-on approach D (${dApproach}) > 1.35`);
  near(dApproach, 343 / (343 - 105), 1e-9);

  // Two Hellcats closing head-on at 111 m/s each → vRel clamped to +150 → D clamped to 1.75
  const dClampHi = V.computeDoppler([0, 300, 50], [0, -111, 0], [0, 0, 50], [0, 111, 0]);
  near(dClampHi, 1.75, 1e-9, "clamped at 1.75");

  // Broadside (abeam): source east of listener flying north → radial closing speed 0 → D === 1
  const dBroadside = V.computeDoppler([200, 0, 50], [0, 95, 0], [0, 0, 50], [0, 0, 0]);
  assert.equal(dBroadside, 1);

  // Receding: source south of listener flying further south (-105 m/s)
  const dRecede = V.computeDoppler([0, -300, 50], [0, -105, 0], [0, 0, 50], [0, 0, 0]);
  assert.ok(dRecede < 0.80, `receding D (${dRecede}) < 0.80`);
  near(dRecede, 343 / (343 + 105), 1e-9);

  // Extreme recession clamp (vRel clamped to -150 → 343 / (343 + 150) ≈ 0.6957 >= 0.55)
  const dClampLo = V.computeDoppler([0, -300, 50], [0, -300, 0], [0, 0, 50], [0, 300, 0]);
  near(dClampLo, 343 / (343 + 150), 1e-9, "vRel clamped at -150");
  assert.ok(dClampLo >= 0.55 && dClampLo < 0.80);
  assert.equal(V.computeDoppler([10, 10, 10], [50, 0, 0], [10, 10, 10], [0, 0, 0]), 1, "coincident safe");
});

// ---------------------------------------------------------------------------
// 3. Pilot Synth Lifecycle, Spool Lag, Perspective Routing & Mocks
// ---------------------------------------------------------------------------

check("3.1 Pilot start/update/stop lifecycle, deterministic RNG noise, PeriodicWave + WaveShaper, and minimal mock fallback", () => {
  const bus = makeBus({ state: "suspended" });
  const au = V.createVehicleAudio({ bus });
  assert.equal(au.isStarted(), false);
  assert.equal(au.isLive(), false);
  assert.equal(au.start(), true);
  assert.equal(bus.ctx.resumes, 1, "resumes suspended context");
  assert.equal(au.isStarted(), true);
  assert.equal(au.isLive(), true);
  assert.ok(bus.ctx.periodicWaves >= 1, "uses PeriodicWave when supported");
  assert.ok(bus.ctx.made.some((n) => n.kind === "shaper" && n.curve instanceof Float32Array), "uses soft-tanh WaveShaper");

  // Deterministic noise buffer matches mulberry32(hashString("vehicle-hellcat-audio"))
  const bufSrc = bus.ctx.made.find((n) => n.kind === "bufsrc");
  assert.ok(bufSrc && bufSrc.buffer);
  const actualNoise = bufSrc.buffer.getChannelData(0);
  const rng = mulberry32(hashString("vehicle-hellcat-audio"));
  const expectedNoise = new Float32Array(actualNoise.length);
  for (let i = 0; i < expectedNoise.length; i++) expectedNoise[i] = rng() * 2 - 1;
  assert.deepEqual(actualNoise, expectedNoise, "exact deterministic PRNG buffer");

  // Terminal connections into bus.node: earOut (gain) + HRTF panner
  const terminals = bus.ctx.made.filter((n) => n.connections.includes(bus.node));
  assert.deepEqual(terminals.map((n) => n.kind).sort(), ["gain", "panner"]);

  // Minimal mock without createPeriodicWave / createWaveShaper never throws
  const minBus = makeBus({ Ctx: MinimalFakeCtx });
  const auMin = V.createVehicleAudio({ bus: minBus });
  assert.equal(auMin.start(), true);
  assert.doesNotThrow(() => auMin.update({ throttle: 0.8, speed: 85, mode: MODE.FLIGHT, fpv: false, pos: [10, 20, 30] }));
  assert.doesNotThrow(() => auMin.fireGun({ pos: [10, 20, 30], mine: true }));
  auMin.dispose();
  assert.ok(minBus.ctx.made.every((n) => n.connections.length === 0));
  au.dispose();
});

check("3.2 Lazy <= 1 Hz bus retry before user gesture, chase vs cockpit routing, param deduping, spool lag, and rapid stop→start", () => {
  const bus = makeBus();
  let ready = false;
  let calls = 0;
  let now = 5;
  const au = V.createVehicleAudio({
    bus: () => {
      calls += 1;
      return ready ? bus : null;
    },
    clock: () => now,
  });

  assert.equal(au.start(), false, "bus null before user gesture");
  assert.equal(au.isStarted(), true, "marked started awaiting gesture");
  assert.equal(au.isLive(), false, "not yet built");
  assert.equal(calls, 1);

  for (const t of [5.2, 5.5, 5.95]) {
    now = t;
    au.update({ throttle: 0.5, speed: 60, mode: MODE.FLIGHT, pos: [1, 2, 3] });
  }
  assert.equal(calls, 1, "throttled to <= 1 Hz while null");

  ready = true;
  now = 6.05;
  au.update({ throttle: 0, speed: 0, mode: MODE.PARKED, fpv: false, pos: [15, 25, 5] });
  assert.equal(calls, 2);
  assert.equal(au.isLive(), true, "built automatically on 1 Hz retry");

  const panner = bus.ctx.made.find((n) => n.kind === "panner");
  assert.deepEqual([panner.positionX.value, panner.positionY.value, panner.positionZ.value], [15, 5, -25]);

  // Cockpit (~3.0 kHz canopy rolloff + earGain=1) vs Chase (~7.8 kHz open-air + panGain=1)
  const earOut = bus.ctx.made.find((n) => n.kind === "gain" && n.connections.includes(bus.node));
  const earGain = bus.ctx.made.find((n) => n.kind === "gain" && n.connections.includes(earOut) && n.gain.value === 0);
  const panGain = bus.ctx.made.find((n) => n.kind === "gain" && n.connections.includes(panner));
  const lps = bus.ctx.made.filter((n) => n.kind === "biquad" && n.type === "lowpass");
  assert.ok(lps.some((f) => f.frequency.value === 3000), "cockpit 3.0 kHz lowpass present");
  assert.ok(lps.some((f) => f.frequency.value === 7800), "external 7.8 kHz lowpass present");
  assert.equal(panGain.gain.value, 1);
  assert.equal(earGain.gain.value, 0);

  // Switch to cockpit with stall warning active -> earGain=1, panGain=0, stall reed active on earOut
  const stallState = { throttle: 0, speed: 28, vMin: 30, mode: MODE.FLIGHT, fpv: true, pos: [15, 25, 5], dt: 0 };
  au.update(stallState);
  assert.equal(earGain.gain.value, 1);
  assert.equal(panGain.gain.value, 0);
  const stallGainNode = bus.ctx.made.find((n) => n.kind === "gain" && n !== earGain && n.connections.includes(earOut));
  assert.ok(stallGainNode && stallGainNode.gain.value > 0, "8 Hz cockpit stall reed audible on ear");

  // Deduplication: identical update writes zero new automation calls
  const callCountBefore = bus.ctx.made.reduce((acc, n) => acc + (n.gain?.calls?.length ?? 0) + (n.frequency?.calls?.length ?? 0), 0);
  au.update(stallState);
  au.update(stallState);
  const callCountAfter = bus.ctx.made.reduce((acc, n) => acc + (n.gain?.calls?.length ?? 0) + (n.frequency?.calls?.length ?? 0), 0);
  assert.equal(callCountAfter, callCountBefore, "epsilon check deduplicates unchanged params");

  // Spool lag asymmetry: tauUp (0.26s) spools faster than tauDown (0.44s)
  const busSpool = makeBus();
  const auSpool = V.createVehicleAudio({ bus: busSpool });
  auSpool.start();
  auSpool.update({ throttle: 0, speed: 0, mode: MODE.PARKED }); // 660 RPM
  const radialOsc = busSpool.ctx.made.find((n) => n.kind === "osc" && n.periodicWave !== null);
  near(radialOsc.frequency.value, 11, 1e-5);
  auSpool.update({ throttle: 1, speed: 0, mode: MODE.PARKED, dt: 0.26 }); // 1 tauUp -> ~63.2% toward 2700 RPM (45 Hz)
  const fracUp = (radialOsc.frequency.value - 11) / (45 - 11);
  near(fracUp, 1 - Math.exp(-1), 0.01, "tauUp = 0.26s");
  // Settle at 45 Hz then chop throttle for 0.26s -> tauDown = 0.44s drops by < 63.2%
  auSpool.update({ throttle: 1, speed: 0, mode: MODE.PARKED, dt: 10 });
  near(radialOsc.frequency.value, 45, 0.05);
  auSpool.update({ throttle: 0, speed: 0, mode: MODE.PARKED, dt: 0.26 });
  const fracDown = (45 - radialOsc.frequency.value) / (45 - 11);
  near(fracDown, 1 - Math.exp(-0.26 / 0.44), 0.01, "tauDown = 0.44s slower than tauUp");
  auSpool.dispose();

  // stop({ fadeSec }) schedules stop on audio clock, blocks update(), and cleans up on onended
  bus.ctx.currentTime = 4.0;
  const firstGraphNodes = [...bus.ctx.made];
  au.stop({ fadeSec: 0.5 });
  assert.equal(au.isStarted(), false);
  assert.equal(au.isLive(), false);
  assert.equal(au.stats().built, true, "fading until onended");
  assert.ok(firstGraphNodes.filter((n) => n.kind === "osc" || n.kind === "bufsrc").every((s) => s.stopAt === 4.5));

  // Rapid stop -> start before onended cuts fading graph cleanly and builds fresh graph at gain 0
  bus.ctx.made.length = 0;
  assert.equal(au.start(), true);
  assert.equal(au.isLive(), true);
  assert.ok(firstGraphNodes.every((n) => n.connections.length === 0), "interrupted fade graph disconnected");

  // Full fade -> onended teardown
  const secondGraphNodes = [...bus.ctx.made];
  au.stop({ fadeSec: 0.5 });
  flushEnded(bus.ctx);
  assert.equal(au.stats().built, false);
  assert.ok(secondGraphNodes.every((n) => n.connections.length === 0), "all nodes disconnected on onended");
  au.dispose();
});

// ---------------------------------------------------------------------------
// 4. Observer 3D Flyby Pool (Allocation Cap, Parked/Range Filter, Doppler & Whoosh)
// ---------------------------------------------------------------------------

check("4.1 Observer pool caps at maxObserverVoices, ignores silent parked/out-of-range aircraft, shifts Doppler & < 65 m whoosh, and releases cleanly", () => {
  const bus = makeBus();
  const au = V.createVehicleAudio({ bus, maxObserverVoices: 4 });
  const listenerPos = [0, 0, 50];
  const listenerVel = [0, 0, 0];

  const fleet = [
    { id: "parked-silent", pos: [20, 0, 50], mode: MODE.PARKED, throttle: 0, speed: 0 },
    { id: "crashed", pos: [30, 0, 50], mode: MODE.CRASHED, throttle: 1, speed: 0 },
    { id: "out-of-range", pos: [0, 1950, 50], mode: MODE.FLIGHT, throttle: 1, speed: 90, vel: [0, -90, 0] },
    { id: "approaching-close", pos: [0, 40, 50], mode: MODE.FLIGHT, throttle: 0.85, speed: 95, vel: [0, -95, 0] },
    { id: "receding-mid", pos: [0, -200, 50], mode: MODE.FLIGHT, throttle: 0.85, speed: 95, vel: [0, -95, 0] },
    { id: "derelict", pos: [120, 100, 80], mode: MODE.DERELICT, throttle: 0, speed: 78, vel: [0, -78, -8] },
    { id: "runup-parked", pos: [-90, 50, 50], mode: MODE.PARKED, throttle: 0.4, speed: 0, vel: [0, 0, 0] },
    { id: "fifth-farther", pos: [400, 400, 120], mode: MODE.FLIGHT, throttle: 0.8, speed: 83, vel: [0, 83, 0] },
    { id: "sixth-farther", pos: [600, 600, 120], mode: MODE.FLIGHT, throttle: 0.8, speed: 83, vel: [0, 83, 0] },
  ];

  au.updateObservers(fleet, listenerPos, listenerVel, 1 / 60);
  assert.equal(au.stats().observerVoices, 4, "capped at maxObserverVoices = 4 nearest audible");

  // Compare pure approach vs pure recession at identical distance & power
  bus.ctx.made.length = 0;
  au.updateObservers([], listenerPos, listenerVel, 1 / 60);
  assert.equal(au.stats().observerVoices, 0, "empty fleet releases all voices");

  au.updateObservers(
    [{ id: "flyby", pos: [0, 45, 50], mode: MODE.FLIGHT, throttle: 0.8, speed: 100, vel: [0, -100, 0] }],
    listenerPos,
    listenerVel,
    1 / 60,
  );
  const voiceNodes = [...bus.ctx.made];
  const radialOsc = voiceNodes.find((n) => n.kind === "osc" && n.periodicWave !== null);
  const blowerOsc = voiceNodes.find((n) => n.kind === "osc" && n.type === "sine");
  const atmoLp = voiceNodes.find((n) => n.kind === "biquad" && n.type === "lowpass");
  const whooshBp = voiceNodes.find((n) => n.kind === "biquad" && n.type === "bandpass");
  const whooshGain = voiceNodes.find((n) => n.kind === "gain" && whooshBp.connections.includes(n));

  const baseParams = V.hellcatEngineParams({ throttle: 0.8, speed: 100, mode: MODE.FLIGHT, boost: true });
  const approachHz = radialOsc.frequency.value;
  const approachBlowerHz = blowerOsc.frequency.value;
  const approachCutoff = atmoLp.frequency.value;
  assert.ok(approachHz > baseParams.crankHz * 1.3, "approaching radial pitch shifted up");
  assert.ok(approachBlowerHz > baseParams.blowerHz * 1.3, "approaching supercharger pitch shifted up");
  assert.ok(whooshGain.gain.value > 0, "closest-approach (< 65 m) propwash whoosh active at 45 m");

  // Now aircraft has passed overhead and is receding at 200 m (outside 65 m whoosh zone)
  for (let i = 0; i < 12; i++) {
    au.updateObservers(
      [{ id: "flyby", pos: [0, -200, 50], mode: MODE.FLIGHT, throttle: 0.8, speed: 100, vel: [0, -100, 0] }],
      listenerPos,
      listenerVel,
      0.05,
    );
  }
  assert.ok(radialOsc.frequency.value < baseParams.crankHz * 0.82, "receding radial pitch shifted down");
  assert.ok(blowerOsc.frequency.value < baseParams.blowerHz * 0.82, "receding supercharger pitch shifted down");
  assert.ok(atmoLp.frequency.value < approachCutoff, "receding atmospheric filter darker than approach");
  assert.equal(whooshGain.gain.value, 0, "propwash whoosh silent outside 65 m");

  // Move out of 1800 m range -> voice released and all nodes disconnected
  au.updateObservers(
    [{ id: "flyby", pos: [0, -1900, 50], mode: MODE.FLIGHT, throttle: 0.8, speed: 100, vel: [0, -100, 0] }],
    listenerPos,
    listenerVel,
    0.05,
  );
  assert.equal(au.stats().observerVoices, 0);
  assert.ok(voiceNodes.every((n) => n.connections.length === 0), "out-of-range observer voice leaves zero connections");
  au.dispose();
});

// ---------------------------------------------------------------------------
// 5. All 10 One-Shot FX, Bailout/Freefall, Concurrency Cap & Zero Leaks
// ---------------------------------------------------------------------------

check("5.1 explosionDelayAndGain & explosion(): speed-of-sound delay, 58→20 Hz sub shockwave, 2000 lb > 1000 lb, 2500 m range", () => {
  const e1000 = V.explosionDelayAndGain([343, 0, 0], 1000, [0, 0, 0]);
  const e2000 = V.explosionDelayAndGain([343, 0, 0], 2000, [0, 0, 0]);
  near(e1000.delaySec, 1.0, 1e-6, "343 m → 1.0 s delay");
  assert.ok(e1000.audible && e2000.audible);
  assert.ok(e2000.shockGain > e1000.shockGain && e2000.rumbleGain > e1000.rumbleGain && e2000.durationSec > e1000.durationSec,
    "2000 lb ordnance carries higher shockwave/rumble energy & duration than 1000 lb");

  const eFar = V.explosionDelayAndGain([1200, 0, 0], 2000, [0, 0, 0]);
  near(eFar.delaySec, 2.2, 1e-6, "delay capped at 2.2 s");
  assert.ok(eFar.audible);

  const eTooFar = V.explosionDelayAndGain([2600, 0, 0], 2000, [0, 0, 0]);
  assert.equal(eTooFar.audible, false);
  assert.equal(eTooFar.gain, 0);

  const bus = makeBus();
  bus.ctx.currentTime = 10.0;
  const au = V.createVehicleAudio({ bus });
  assert.equal(au.explosion({ pos: [2600, 0, 0], lb: 2000, listenerPos: [0, 0, 0] }), false, "beyond 2500 m culled");
  assert.equal(bus.ctx.made.length, 0);

  assert.equal(au.explosion({ pos: [686, 0, 0], lb: 2000, listenerPos: [0, 0, 0] }), true);
  const subOsc = bus.ctx.made.find((n) => n.kind === "osc" && n.type === "sine");
  assert.ok(subOsc, "sub-bass shockwave oscillator built");
  near(subOsc.started, 12.0, 1e-6, "scheduled at t0 + 686/343 = +2.0 s on ctx.currentTime");
  assert.ok(subOsc.frequency.calls.some((c) => c[1] === 58) && subOsc.frequency.calls.some((c) => c[1] === 20),
    "58 → 20 Hz sub-bass shockwave sweep");

  flushEnded(bus.ctx);
  assert.equal(au.stats().activeOneShots, 0);
  assert.ok(bus.ctx.made.every((n) => n.connections.length === 0));
  au.dispose();
});

check("5.2 Every one-shot (fireGun 3-burst stagger, fireRocket, bombRelease, hit rate-limit, gear, touchdown, canopy, rearm, bailout/fall/chuteOpen)", () => {
  const bus = makeBus();
  let now = 20.0;
  bus.ctx.currentTime = 2.0;
  const au = V.createVehicleAudio({ bus, clock: () => now });

  // fireGun: 3 micro-staggered bursts at +0, +28ms, +62ms + cockpit clatter
  assert.equal(au.fireGun({ pos: [10, 30, 5], mine: true, fpv: true }), true);
  const gunStarts = bus.ctx.made.filter((n) => n.started !== null).map((n) => +(n.started - 2.0).toFixed(3));
  for (const dt of [0, 0.028, 0.062]) {
    assert.ok(gunStarts.includes(dt), `fireGun includes staggered burst at +${dt}s`);
  }
  flushEnded(bus.ctx);
  assert.ok(bus.ctx.made.every((n) => n.connections.length === 0));

  // fireRocket: igniter snap + 0.55 s motor whoosh
  bus.ctx.made.length = 0;
  assert.equal(au.fireRocket({ pos: [10, 30, 5], mine: false }), true);
  assert.ok(bus.ctx.made.some((n) => n.kind === "bufsrc" && Math.abs(n.stopAt - 2.55) < 1e-6), "0.55 s HVAR motor whoosh");
  flushEnded(bus.ctx);
  assert.ok(bus.ctx.made.every((n) => n.connections.length === 0));

  // bombRelease, gear (deploy & retract), touchdown (aircraft & chute), canopy (open & close), rearm
  for (const invoke of [
    () => au.bombRelease({ pos: [0, 10, 50], mine: true }),
    () => au.gear({ deploying: true, pos: [0, 10, 5], mine: true }),
    () => au.gear({ deploying: false, pos: [0, 10, 5], mine: true }),
    () => au.touchdown({ pos: [0, 10, 0], speed: 6, chute: false, mine: true }),
    () => au.touchdown({ pos: [0, 10, 0], speed: 5, chute: true, mine: true }),
    () => au.canopy({ open: true, mine: true }),
    () => au.canopy({ open: false, mine: true }),
    () => au.rearm({ mine: true }),
  ]) {
    bus.ctx.made.length = 0;
    assert.equal(invoke(), true);
    assert.ok(au.stats().activeOneShots === 1);
    flushEnded(bus.ctx);
    assert.equal(au.stats().activeOneShots, 0);
    assert.ok(bus.ctx.made.every((n) => n.connections.length === 0));
  }

  // hit() rate-limit (>= 0.055 s on ctx.currentTime OR wall clock)
  assert.equal(au.hit({ damage: 15 }), true, "first hit plays");
  assert.equal(au.hit({ damage: 15 }), false, "immediate duplicate blocked (< 55 ms)");
  bus.ctx.currentTime += 0.030;
  now += 0.030;
  assert.equal(au.hit({ damage: 15 }), false, "still < 55 ms");
  bus.ctx.currentTime += 0.030; // +0.060 s total on audio clock
  assert.equal(au.hit({ damage: 25 }), true, "allowed after >= 55 ms on ctx.currentTime");
  assert.equal(au.hit({ damage: 25 }), false, "rate-limited again");
  now += 0.060; // advance wall clock only
  assert.equal(au.hit({ damage: 25 }), true, "allowed after >= 55 ms on wall clock");
  flushEnded(bus.ctx);

  // Bailout canopy bang + freefall wind (50 m/s terminal roar → 6 m/s parachute breeze) + chuteOpen + stopFall
  bus.ctx.made.length = 0;
  assert.equal(au.bailout({ pos: [0, 0, 500] }), true);
  assert.equal(au.stats().fallBuilt, true);
  assert.equal(au.stats().activeOneShots, 1, "canopy jettison bang fired");
  flushEnded(bus.ctx); // finish jettison bang while fall loop continues
  assert.equal(au.stats().fallBuilt, true);

  const fallGainNode = bus.ctx.made.find((n) => n.kind === "gain" && n.connections.includes(bus.node) && n.gain.value === 0);
  const fallBp = bus.ctx.made.find((n) => n.kind === "biquad" && n.connections.includes(fallGainNode));
  au.updateFall({ speed: 50, chute: false, pos: [0, 0, 400] });
  const terminalGain = fallGainNode.gain.value;
  const terminalCut = fallBp.frequency.value;
  assert.ok(terminalGain > 0.18 && terminalCut > 2000, "50 m/s terminal freefall roar");

  assert.equal(au.chuteOpen({ pos: [0, 0, 250], mine: true }), true);
  flushEnded(bus.ctx);
  au.updateFall({ speed: 6, chute: true, pos: [0, 0, 240] });
  assert.ok(fallGainNode.gain.value < terminalGain * 0.25, "gentle 6 m/s breeze under open canopy");
  assert.ok(fallBp.frequency.value < terminalCut * 0.3, "darker wind under canopy");

  au.stopFall({ fadeSec: 0.3 });
  flushEnded(bus.ctx);
  assert.equal(au.stats().fallBuilt, false);
  assert.ok(bus.ctx.made.every((n) => n.connections.length === 0), "zero leaked connections after fall teardown");
  au.dispose();
});

check("5.3 One-shot concurrency cap (14) under rapid fire and 100% leak-free synchronous dispose()", () => {
  const bus = makeBus();
  const au = V.createVehicleAudio({ bus });

  for (let i = 0; i < 30; i++) {
    assert.equal(au.fireGun({ pos: [i, 10, 5], mine: false }), true);
    assert.ok(au.stats().activeOneShots <= 14, `capped at 14 at shot ${i}`);
  }
  assert.equal(au.stats().activeOneShots, 14);
  // High-priority explosion steals cleanly when at cap
  assert.equal(au.explosion({ pos: [100, 0, 0], lb: 2000, listenerPos: [0, 0, 0] }), true);
  assert.equal(au.stats().activeOneShots, 14);

  // Start pilot + observers + fall concurrently, then dispose() synchronously
  au.start();
  au.update({ throttle: 0.9, speed: 95, mode: MODE.FLIGHT, pos: [0, 0, 100] });
  au.updateObservers([{ id: 1, pos: [50, 50, 100], speed: 83, mode: MODE.FLIGHT, vel: [0, 83, 0] }], [0, 0, 100], [0, 0, 0], 1 / 60);
  au.bailout({ pos: [0, 0, 100] });
  assert.ok(au.stats().totalNodes > 40);

  const allMade = [...bus.ctx.made];
  au.dispose();
  assert.equal(au.stats().totalNodes, 0);
  assert.equal(au.stats().activeOneShots, 0);
  assert.equal(au.stats().observerVoices, 0);
  assert.equal(au.isStarted(), false);
  assert.equal(au.isLive(), false);
  assert.ok(allMade.every((n) => n.connections.length === 0), "every single node disconnected on dispose()");
  assert.ok(
    allMade.filter((n) => n.kind === "osc" || n.kind === "bufsrc").every((s) => s.stopped),
    "every single oscillator and buffer source stopped on dispose()",
  );
});

// ---------------------------------------------------------------------------
// 6. Real AudioManager Integration (HRTF vs ?audioRetailPan=on, voicePool, focus mute)
// ---------------------------------------------------------------------------

check("6.1 Real AudioManager integration: voicePool.activeCount() === 0, sliderGain() in HRTF & retail pan, setActive(false) mute, clean dispose()", () => {
  const prevCtx = globalThis.window.AudioContext;
  globalThis.window.AudioContext = VehicleFakeCtx;
  try {
    // A. HRTF mode (default): bus carries effect slider, sliderGain() === 1
    const amHrtf = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true, savedGains: false });
    amHrtf.notifyUserGesture();
    amHrtf.setEffectGain(0.4);
    const auHrtf = V.createVehicleAudio({
      bus: () => amHrtf.getEffectBus?.() ?? null,
      audioManager: amHrtf,
      volume: () => 0.5,
    });
    assert.equal(auHrtf.start(), true);
    auHrtf.update({ throttle: 0.8, speed: 83, mode: MODE.FLIGHT, fpv: true, pos: [0, 0, 50] });
    auHrtf.updateObservers([{ id: 7, pos: [60, 0, 50], speed: 83, mode: MODE.FLIGHT, vel: [0, 83, 0] }], [0, 0, 50], [0, 0, 0], 1 / 60);
    auHrtf.fireGun({ pos: [0, 0, 50], mine: true, fpv: true });
    assert.equal(amHrtf.voicePool.activeCount(), 0, "takes 0 slots in the 16-voice retail voicePool");
    assert.equal(amHrtf._effectMaster.gain.value, 0.4, "HRTF bus carries effect slider");

    // Focus mute via setActive(false)
    amHrtf.setActive(false);
    assert.equal(amHrtf._master.gain.value, 0, "AudioManager mutes master bus on blur");
    assert.equal(auHrtf.fireRocket({ pos: [0, 0, 50], mine: true }), false, "refuses new one-shots while inactive");
    auHrtf.update({ throttle: 0.8, speed: 83, mode: MODE.FLIGHT, fpv: true, pos: [0, 0, 50] });
    amHrtf.setActive(true);
    assert.equal(amHrtf._master.gain.value, 1, "master restored on focus");
    assert.equal(auHrtf.fireRocket({ pos: [0, 0, 50], mine: true }), true, "one-shots resume on focus");

    const hrtfVehicleNodes = amHrtf._ctx.made.filter(
      (n) => n !== amHrtf._master && n !== amHrtf._effectMaster && n !== amHrtf._ambientMaster,
    );
    auHrtf.dispose();
    assert.ok(hrtfVehicleNodes.every((n) => n.connections.length === 0), "clean vehicle teardown on HRTF bus");
    assert.ok(amHrtf._effectMaster.connections.includes(amHrtf._master), "AudioManager bus intact");
    amHrtf.dispose();

    // B. Retail pan mode (?audioRetailPan=on / hrtf: false): bus stays unity, sliderGain() scales vehicle mix
    const amRetail = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false, savedGains: false });
    amRetail.notifyUserGesture();
    amRetail.setEffectGain(0.35);
    const auRetail = V.createVehicleAudio({
      bus: () => amRetail.getEffectBus?.() ?? null,
      audioManager: amRetail,
      volume: () => 0.8,
    });
    assert.equal(auRetail.start(), true);
    auRetail.update({ throttle: 0.75, speed: 83, mode: MODE.FLIGHT, fpv: true, pos: [0, 0, 50] });
    assert.equal(amRetail._effectMaster.gain.value, 1, "retail mode keeps _effectMaster at unity");
    // Find aircraftMix GainNode (feeds earShelf and panLowpass -> 2 connections)
    const retailNodes = amRetail._ctx.made.filter(
      (n) => n !== amRetail._master && n !== amRetail._effectMaster && n !== amRetail._ambientMaster,
    );
    const aircraftMix = retailNodes.find((n) => n.kind === "gain" && n.connections.length === 2 && Math.abs(n.gain.value - 0.8 * 0.35) < 1e-9);
    assert.ok(aircraftMix, "aircraftMix scales by volume() * bus.sliderGain() (0.8 * 0.35)");
    assert.equal(amRetail.voicePool.activeCount(), 0);

    auRetail.dispose();
    assert.ok(retailNodes.every((n) => n.connections.length === 0));
    amRetail.dispose();
  } finally {
    globalThis.window.AudioContext = prevCtx;
  }
});

check("6.2 Disabled / null-bus silent zero-node no-ops and deterministic source hygiene (zero Math.random / setTimeout)", async () => {
  assert.equal(V.vehicleAudioEnabled(""), true);
  assert.equal(V.vehicleAudioEnabled("?vehicleAudio=on"), true);
  assert.equal(V.vehicleAudioEnabled("?vehicleAudio=off"), false);

  const bus = makeBus();
  for (const au of [V.createVehicleAudio({ bus, enabled: false }), V.createVehicleAudio({ bus: null })]) {
    assert.equal(au.start(), false);
    assert.equal(au.isStarted(), false);
    assert.equal(au.isLive(), false);
    au.update({ throttle: 1, speed: 95, mode: MODE.FLIGHT, pos: [0, 0, 50] });
    au.updateObservers([{ id: 1, pos: [20, 0, 50], speed: 83, mode: MODE.FLIGHT }], [0, 0, 50], [0, 0, 0], 1 / 60);
    assert.equal(au.bailout({ pos: [0, 0, 50] }), false);
    au.updateFall({ speed: 40, chute: false, pos: [0, 0, 40] });
    au.stopFall();
    assert.equal(au.fireGun({ pos: [0, 0, 50] }), false);
    assert.equal(au.fireRocket({ pos: [0, 0, 50] }), false);
    assert.equal(au.bombRelease({ pos: [0, 0, 50] }), false);
    assert.equal(au.explosion({ pos: [0, 0, 50], lb: 1000 }), false);
    assert.equal(au.hit({ damage: 10 }), false);
    assert.equal(au.gear({ deploying: true }), false);
    assert.equal(au.touchdown({ speed: 4 }), false);
    assert.equal(au.canopy({ open: true }), false);
    assert.equal(au.rearm(), false);
    assert.equal(au.chuteOpen(), false);
    au.stop();
    au.dispose();
  }
  assert.equal(bus.ctx.made.length, 0, "zero WebAudio nodes constructed when disabled or bus null");

  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scene3d/vehicle/audio.js", import.meta.url), "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/\bMath\.random\s*\(/.test(codeOnly), "zero Math.random() calls in scene3d/vehicle/audio.js");
  assert.ok(!/\bsetTimeout\s*\(/.test(codeOnly), "zero setTimeout() calls in scene3d/vehicle/audio.js");
});

// ---------------------------------------------------------------------------

for (const p of pending) await p();
fake.uninstall();
const elapsedMs = performance.now() - tSuiteStart;
console.log(`\nvehicle_audio: ${passed} passed, ${failed} failed (${elapsedMs.toFixed(1)} ms)`);
if (failed > 0) process.exit(1);
process.exit(0);
