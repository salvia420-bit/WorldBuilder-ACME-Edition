// tests/drone_audio.test.mjs
//
// WHY (2026-10-24). Drone Deploy (scene3d/drone/SPEC.md, `?drone=on`, DEFAULT
// OFF; `?droneAudio=off` opts the hum out) synthesises a motor hum on the
// client's effect bus. Two pieces must hold:
//   S  the additive audio_manager.js seam `getEffectBus()` (SPEC §6.2): null
//      until the AudioContext exists (it never creates one), then
//      `{ctx: _ctx, node: _effectMaster, sliderGain}` — the HRTF mix carries
//      the effect slider on the bus (`sliderGain() === 1`), the retail mix
//      (`?audioRetailPan=on`) keeps the bus at unity and reports the slider
//      for the caller to multiply in;
//   A  scene3d/drone/audio.js (SPEC §3.7): no bus → silent no-ops; the graph
//      (two detuned saws → low-pass, band-passed looping noise → input → ear /
//      HRTF panner → bus.node) is built at output gain 0, follows throttle,
//      speed and the arm level, crossfades in-ear ↔ panner, writes the panner
//      in three world (x, z, −y), goes quiet after stop(), takes no voice-pool
//      slot, builds identical noise every time, and disconnects everything on
//      dispose.
// This suite EXECUTES the real AudioManager and the real drone audio module on
// the shared tests/helpers/fake_audio_context.mjs fake, extended here with the
// node kinds the hum needs (oscillator, biquad, buffer) and recording params.
//
// Run from apps/holtburger-web/: node tests/drone_audio.test.mjs

import assert from "node:assert/strict";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

const fake = installFakeAudio();
const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
const A = await import("../scene3d/drone/audio.js");
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
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);

// ---------------------------------------------------------------------------
// The hum's extra node kinds on top of the shared fake (recording params).
// ---------------------------------------------------------------------------

const BaseCtx = globalThis.window.AudioContext;
const rparam = (v = 0) => ({
  value: v,
  calls: [],
  setTargetAtTime(target, t, tau) { this.calls.push(["target", target, t, tau]); this.value = target; },
  setValueAtTime(val, t) { this.calls.push(["set", val, t]); this.value = val; },
  cancelScheduledValues(t) { this.calls.push(["cancel", t]); },
});
class DroneFakeCtx extends BaseCtx {
  constructor() {
    super();
    this.sampleRate = 8000;
    this.made = [];
    this.resumes = 0;
  }
  _n(kind, extra) {
    const n = {
      kind,
      connections: [],
      connect(to) { this.connections.push(to); return to; },
      disconnect() { this.connections = []; },
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
      start(t = 0) { this.started = t; },
      stop(t) { this.stopped = true; this.stopAt = t === undefined ? "now" : t; },
      ...extra,
    });
  }
  createOscillator() { return this._src("osc", { type: "sine", frequency: rparam(440), detune: rparam(0) }); }
  createBiquadFilter() { return this._n("biquad", { type: "lowpass", frequency: rparam(350), Q: rparam(1), gain: rparam(0) }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createBufferSource() { return this._src("bufsrc", { buffer: null, loop: false }); }
  createGain() { return this._n("gain", { gain: rparam(1) }); }
  createPanner() {
    return this._n("panner", {
      panningModel: "equalpower", distanceModel: "inverse", refDistance: 1, rolloffFactor: 1, maxDistance: 10000,
      positionX: rparam(0), positionY: rparam(0), positionZ: rparam(0),
    });
  }
  async resume() { this.resumes += 1; this.state = "running"; }
}

function makeBus({ slider = 1, state = "running" } = {}) {
  const ctx = new DroneFakeCtx();
  ctx.state = state;
  const node = ctx._n("bus", { gain: rparam(1) });
  ctx.made.length = 0; // count only the hum's nodes
  let s = slider;
  return { ctx, node, sliderGain: () => s, setSlider(v) { s = v; } };
}

/** The hum graph's named nodes, found by wiring (no reliance on internals). */
function graphOf(ctx, busNode) {
  const made = ctx.made;
  const oscs = made.filter((n) => n.kind === "osc");
  const noise = made.find((n) => n.kind === "bufsrc");
  const panner = made.find((n) => n.kind === "panner");
  const toBus = made.filter((n) => n.connections.includes(busNode));
  const ear = toBus.find((n) => n.kind === "gain");
  const pan = made.find((n) => n.kind === "gain" && n.connections.includes(panner));
  const input = made.find((n) => n.kind === "gain" && n.connections.includes(ear) && n.connections.includes(pan));
  const lowpass = made.find((n) => n.kind === "biquad" && n.type === "lowpass");
  const bandpass = made.find((n) => n.kind === "biquad" && n.type === "bandpass");
  const noiseGain = made.find((n) => n.kind === "gain" && n.connections.includes(input) && n !== lowpass);
  return { made, oscs, noise, panner, toBus, ear, pan, input, lowpass, bandpass, noiseGain };
}

function reaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.connections.some((n) => reaches(n, target, seen));
}

// ---------------------------------------------------------------------------
// S — the audio_manager.js seam
// ---------------------------------------------------------------------------

check("S1 getEffectBus(): null before notifyUserGesture() — and calling it creates no context", () => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true });
  assert.equal(am.getEffectBus(), null);
  assert.equal(am.getEffectBus(), null);
  assert.equal(am._ctx, null, "the seam never creates the AudioContext");
});

check("S2 after the gesture: {ctx === am._ctx, node === am._effectMaster}; the node feeds _master", () => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true });
  am.notifyUserGesture();
  const bus = am.getEffectBus();
  assert.ok(bus);
  assert.deepEqual(Object.keys(bus).sort(), ["ctx", "node", "sliderGain"]);
  assert.equal(bus.ctx, am._ctx);
  assert.equal(bus.node, am._effectMaster);
  assert.ok(am._effectMaster.connections.includes(am._master), "effect bus → master (master slider + focus mute)");
  assert.equal(typeof bus.sliderGain, "function");
  const again = am.getEffectBus();
  assert.equal(again.ctx, bus.ctx);
  assert.equal(again.node, bus.node);
});

check("S3 HRTF mix (default): the slider rides the bus, sliderGain() === 1", () => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true });
  am.notifyUserGesture();
  const bus = am.getEffectBus();
  assert.equal(bus.sliderGain(), 1);
  am.setEffectGain(0.4);
  assert.equal(bus.node.gain.value, 0.4, "the bus carries the effect slider");
  assert.equal(bus.sliderGain(), 1, "nothing for the caller to multiply in");
});

check("S4 retail mix (hrtf:false = ?audioRetailPan=on): the bus stays at 1 and sliderGain() follows the slider (0.4)", () => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false });
  am.notifyUserGesture();
  const bus = am.getEffectBus();
  assert.equal(bus.sliderGain(), 1);
  am.setEffectGain(0.4);
  assert.equal(bus.node.gain.value, 1, "unity bus in the retail mix");
  assert.equal(bus.sliderGain(), 0.4, "read live: the caller multiplies it in");
  am.setEffectGain(0.9);
  assert.equal(bus.sliderGain(), 0.9);
});

check("S5 resume() from a gesture creates the context, then the bus exists (the deploy-click fallback, §6.2)", async () => {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: true });
  assert.equal(am.getEffectBus(), null);
  const p = am.resume();
  assert.ok(am.getEffectBus(), "its synchronous prefix _initContext() made the context");
  await p;
  am.dispose();
  assert.equal(am.getEffectBus(), null, "a disposed manager has no bus");
});

// ---------------------------------------------------------------------------
// A — scene3d/drone/audio.js
// ---------------------------------------------------------------------------

check("A1 HUM_TUNING frozen; humParams pure, finite for any input, gain 0 at level ≤ 0, freqA / cutoffHz non-decreasing in throttle", () => {
  assert.ok(Object.isFrozen(A.HUM_TUNING));
  for (const k of ["baseHz", "throttleHz", "detuneRatio", "cutoffBaseHz", "noiseBandHz", "gainMax"]) assert.equal(typeof A.HUM_TUNING[k], "number", k);
  const keys = ["cutoffHz", "freqA", "freqB", "gain", "noiseGain"];
  const bad = [NaN, Infinity, -Infinity, undefined, null, -5, 1e9, "x"];
  for (const t of bad) for (const s of bad) for (const l of [...bad, 0.5, 1]) {
    const p = A.humParams({ throttle: t, speed: s, level: l });
    assert.deepEqual(Object.keys(p).sort(), keys);
    for (const k of keys) assert.ok(Number.isFinite(p[k]), `${k} finite for ${t}/${s}/${l}`);
  }
  assert.ok(Number.isFinite(A.humParams().freqA), "no argument");
  for (const odd of [null, 5, "x", true]) {
    const p = A.humParams(odd);
    for (const k of keys) assert.ok(Number.isFinite(p[k]), `${k} finite for humParams(${String(odd)})`);
    assert.equal(p.gain, 0, `humParams(${String(odd)}): no level → silent`);
  }
  for (const l of [0, -1, NaN]) assert.equal(A.humParams({ throttle: 1, speed: 5, level: l }).gain, 0, `level ${l} → gain 0`);
  assert.ok(A.humParams({ throttle: 1, speed: 0, level: 1 }).gain > 0);
  for (const speed of [0, 6, 25]) for (const level of [0, 0.3, 1]) {
    let pf = -Infinity;
    let pc = -Infinity;
    for (let th = -0.5; th <= 3; th += 0.05) {
      const p = A.humParams({ throttle: th, speed, level });
      assert.ok(p.freqA >= pf - 1e-9, `freqA monotonic at th ${th}, speed ${speed}, level ${level}`);
      assert.ok(p.cutoffHz >= pc - 1e-9, `cutoff monotonic at th ${th}`);
      assert.ok(p.freqB > p.freqA, "B detuned above A");
      pf = p.freqA;
      pc = p.cutoffHz;
    }
  }
  assert.ok(A.humParams({ throttle: 1, speed: 0, level: 1 }).freqA > A.humParams({ throttle: 1, speed: 0, level: 0.2 }).freqA, "the spin-up raises the pitch");
  assert.deepEqual(A.humParams({ throttle: 0.7, speed: 3, level: 0.6 }), A.humParams({ throttle: 0.7, speed: 3, level: 0.6 }), "deterministic");
});

check("A2 no bus: start() false; update / stop / dispose silent no-ops; stats empty", () => {
  for (const deps of [undefined, {}, { bus: null }, { bus: {} }, { bus: { ctx: null, node: {} } }, { bus: () => null }, { bus: () => { throw new Error("boom"); } }]) {
    const au = A.createDroneAudio(deps);
    assert.equal(au.start(), false, JSON.stringify(deps ?? null));
    assert.doesNotThrow(() => au.update({ throttle: 1, speed: 3, level: 1, fpv: false, pos: [1, 2, 3] }));
    assert.doesNotThrow(() => au.update(null));
    assert.doesNotThrow(() => au.stop());
    assert.doesNotThrow(() => au.stop({ fadeSec: 0 }));
    assert.deepEqual(au.stats().built, false);
    assert.equal(au.stats().nodes, 0);
    assert.doesNotThrow(() => au.dispose());
    assert.doesNotThrow(() => au.dispose());
    assert.equal(au.active, false);
  }
});

check("A3 enabled:false (?droneAudio=off): start() false and no WebAudio node is built", () => {
  const bus = makeBus();
  const au = A.createDroneAudio({ bus, enabled: false });
  assert.equal(au.start(), false);
  au.update({ throttle: 1, speed: 1, level: 1, fpv: true, pos: [0, 0, 0] });
  assert.equal(bus.ctx.made.length, 0);
  assert.equal(au.active, false);
});

check("A4 start(): the graph ends on bus.node (ear gain + HRTF panner), built at output gain 0, oscillators running", () => {
  const bus = makeBus();
  const au = A.createDroneAudio({ bus, volume: () => 0.6 });
  assert.equal(au.start(), true);
  assert.equal(au.active, true);
  const st = au.stats();
  assert.equal(st.built, true);
  assert.equal(st.started, true);
  assert.equal(st.nodes, 10);
  const g = graphOf(bus.ctx, bus.node);
  assert.equal(g.made.length, 10, "10 nodes: 2 osc, lowpass, noise, bandpass, noise gain, input, ear, pan, panner");
  assert.equal(g.oscs.length, 2);
  assert.ok(g.oscs.every((o) => o.type === "sawtooth"), "sawtooth");
  assert.ok(g.oscs[1].frequency.value > g.oscs[0].frequency.value, "detuned pair");
  assert.deepEqual(g.toBus.map((n) => n.kind).sort(), ["gain", "panner"], "ear → bus and panner → bus");
  assert.equal(g.panner.panningModel, "HRTF");
  assert.equal(g.panner.distanceModel, "exponential");
  assert.equal(g.panner.refDistance, 5);
  assert.equal(g.panner.rolloffFactor, 2);
  assert.equal(g.panner.maxDistance, 200);
  assert.equal(g.lowpass.type, "lowpass");
  assert.equal(g.bandpass.type, "bandpass");
  assert.ok(g.noise.loop, "looping noise");
  assert.ok(g.noise.buffer && g.noise.buffer.length === 8000 * A.HUM_TUNING.noiseSec);
  for (const n of g.made) assert.ok(reaches(n, bus.node), `${n.kind} reaches the bus`);
  assert.ok(g.oscs.every((o) => reaches(o, g.lowpass)), "saws → low-pass");
  assert.ok(reaches(g.noise, g.bandpass) && reaches(g.bandpass, g.input));
  assert.equal(g.input.gain.value, 0, "silent until an update with level > 0");
  assert.ok([...g.oscs, g.noise].every((s) => s.started !== null && !s.stopped), "sources started");
  assert.equal(g.ear.gain.value, 0, "third person at build (the deploy click)");
  assert.equal(g.pan.gain.value, 1);
  // a second start() while running keeps the graph
  assert.equal(au.start(), true);
  assert.equal(bus.ctx.made.length, 10, "no rebuild while running");
  au.dispose();
});

check("A5 update(): output gain = humParams.gain · volume() · bus.sliderGain() (τ 0.05); level 0 → gain 0; pitch / filter / noise follow", () => {
  const bus = makeBus({ slider: 0.4 });
  let vol = 0.5;
  const au = A.createDroneAudio({ bus, volume: () => vol });
  au.start();
  const g = graphOf(bus.ctx, bus.node);
  const u = { throttle: 1.2, speed: 8, level: 1, fpv: true, pos: [0, 0, 0] };
  au.update(u);
  const p = A.humParams(u);
  near(g.input.gain.value, p.gain * 0.5 * 0.4, 1e-12, "level");
  const last = g.input.gain.calls.at(-1);
  assert.equal(last[0], "target");
  assert.equal(last[3], A.HUM_TUNING.levelTau);
  near(g.oscs[0].frequency.value, p.freqA, 1e-9);
  near(g.oscs[1].frequency.value, p.freqB, 1e-9);
  near(g.lowpass.frequency.value, p.cutoffHz, 1e-9);
  near(g.noiseGain.gain.value, p.noiseGain, 1e-12);
  // an unchanged state writes nothing new
  const n0 = g.input.gain.calls.length + g.oscs[0].frequency.calls.length + g.lowpass.frequency.calls.length;
  au.update(u);
  au.update(u);
  assert.equal(g.input.gain.calls.length + g.oscs[0].frequency.calls.length + g.lowpass.frequency.calls.length, n0, "no redundant automation");
  // the slider and the volume are read live
  bus.setSlider(1);
  vol = 1;
  au.update(u);
  near(g.input.gain.value, p.gain, 1e-12);
  // level 0 → silent
  au.update({ ...u, level: 0 });
  assert.equal(g.input.gain.value, 0);
  // more throttle → higher pitch and brighter
  const f1 = g.oscs[0].frequency.value;
  au.update({ ...u, throttle: 2.4 });
  assert.ok(g.oscs[0].frequency.value > f1);
  au.dispose();
});

check("A6 fpv crossfades ear / panner (τ 0.08); the panner sits at AC (x, y, z) → three (x, z, −y)", () => {
  const bus = makeBus();
  const au = A.createDroneAudio({ bus });
  au.start();
  const g = graphOf(bus.ctx, bus.node);
  au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [10, 20, 3] });
  assert.equal(g.ear.gain.value, 1, "in-ear in the goggles");
  assert.equal(g.pan.gain.value, 0);
  assert.equal(g.ear.gain.calls.at(-1)[3], A.HUM_TUNING.earTau);
  assert.equal(g.pan.gain.calls.at(-1)[3], 0.08);
  assert.equal(g.panner.positionX.value, 10);
  assert.equal(g.panner.positionY.value, 3);
  assert.equal(g.panner.positionZ.value, -20);
  au.update({ throttle: 1, speed: 0, level: 1, fpv: false, pos: [-4, 7.5, 12] });
  assert.equal(g.ear.gain.value, 0, "third person: the panner at the drone");
  assert.equal(g.pan.gain.value, 1);
  assert.deepEqual([g.panner.positionX.value, g.panner.positionY.value, g.panner.positionZ.value], [-4, 12, -7.5]);
  // a non-finite position keeps the last one
  au.update({ throttle: 1, speed: 0, level: 1, fpv: false, pos: [NaN, 0, 0] });
  au.update({ throttle: 1, speed: 0, level: 1, fpv: false, pos: null });
  assert.deepEqual([g.panner.positionX.value, g.panner.positionY.value, g.panner.positionZ.value], [-4, 12, -7.5]);
  au.dispose();
});

check("A7 stop({fadeSec}): ramps to 0, schedules the sources' end, disconnects on onended; update after stop() writes nothing", () => {
  const bus = makeBus();
  const au = A.createDroneAudio({ bus });
  au.start();
  bus.ctx.currentTime = 3;
  const g = graphOf(bus.ctx, bus.node);
  au.update({ throttle: 1, speed: 2, level: 1, fpv: false, pos: [1, 1, 1] });
  assert.ok(g.input.gain.value > 0);
  au.stop({ fadeSec: 0.6 });
  assert.equal(au.active, false);
  const ramp = g.input.gain.calls.at(-1);
  assert.deepEqual(ramp.slice(0, 3), ["target", 0, 3]);
  near(ramp[3], 0.6 / 5, 1e-12, "τ = fade / 5");
  assert.ok([...g.oscs, g.noise].every((s) => s.stopAt === 3 + 0.6), "sources end on the audio clock (no JS timer)");
  // update is a no-op from the stop() call on (the per-frame level never fights the fade)
  const snapshot = g.made.map((n) => JSON.stringify([n.gain?.calls?.length, n.frequency?.calls?.length, n.positionX?.value]));
  au.update({ throttle: 2, speed: 9, level: 1, fpv: true, pos: [9, 9, 9] });
  assert.deepEqual(g.made.map((n) => JSON.stringify([n.gain?.calls?.length, n.frequency?.calls?.length, n.positionX?.value])), snapshot);
  assert.equal(au.stats().built, true, "still fading");
  g.oscs[0].onended();
  assert.equal(au.stats().built, false);
  assert.ok(g.made.every((n) => n.connections.length === 0), "everything disconnected at the end of the fade");
  // stop() with the default fade and with 0
  const bus2 = makeBus();
  const au2 = A.createDroneAudio({ bus: bus2 });
  au2.start();
  const g2 = graphOf(bus2.ctx, bus2.node);
  au2.stop();
  near(g2.input.gain.calls.at(-1)[3], 0.4 / 5, 1e-12, "default fade 0.4 s");
  au2.dispose();
  const bus3 = makeBus();
  const au3 = A.createDroneAudio({ bus: bus3 });
  au3.start();
  const g3 = graphOf(bus3.ctx, bus3.node);
  au3.stop({ fadeSec: 0 });
  assert.equal(au3.stats().built, false, "fade 0: immediate");
  assert.ok(g3.made.every((n) => n.connections.length === 0));
  assert.ok([...g3.oscs, g3.noise].every((s) => s.stopped && s.stopAt === "now"));
});

check("A8 start() after stop() builds a fresh graph at gain 0 (single-use nodes); the noise buffer is identical across builds and instances", () => {
  const bus = makeBus();
  const au = A.createDroneAudio({ bus });
  au.start();
  const first = graphOf(bus.ctx, bus.node);
  const firstNodes = [...first.made];
  const data1 = Float32Array.from(first.noise.buffer.getChannelData(0));
  au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
  au.stop({ fadeSec: 0.4 });
  bus.ctx.made.length = 0;
  assert.equal(au.start(), true);
  const second = graphOf(bus.ctx, bus.node);
  assert.equal(second.made.length, 10, "rebuilt");
  assert.ok(firstNodes.every((n) => n.connections.length === 0), "the fading graph was cut");
  assert.ok(firstNodes.filter((n) => n.kind === "osc" || n.kind === "bufsrc").every((s) => s.stopped), "its sources stopped");
  assert.equal(second.input.gain.value, 0, "a new build starts silent");
  assert.deepEqual(Float32Array.from(second.noise.buffer.getChannelData(0)), data1, "same noise");
  const bus2 = makeBus();
  const other = A.createDroneAudio({ bus: bus2 });
  other.start();
  assert.deepEqual(Float32Array.from(graphOf(bus2.ctx, bus2.node).noise.buffer.getChannelData(0)), data1, "same noise in another instance");
  const rng = mulberry32(hashString("drone-audio"));
  const expect = new Float32Array(data1.length);
  for (let i = 0; i < expect.length; i++) expect[i] = rng() * 2 - 1;
  assert.deepEqual(data1, expect, "mulberry32(hashString('drone-audio')) white noise");
  assert.ok(data1.some((v) => v > 0.5) && data1.some((v) => v < -0.5), "not silent");
  au.dispose();
  other.dispose();
});

check("A9 dispose() stops every oscillator and the noise, leaves no connection; idempotent; inert afterwards", () => {
  const bus = makeBus();
  const au = A.createDroneAudio({ bus });
  au.start();
  const g = graphOf(bus.ctx, bus.node);
  au.update({ throttle: 1, speed: 1, level: 1, fpv: false, pos: [1, 2, 3] });
  au.dispose();
  assert.ok([...g.oscs, g.noise].every((s) => s.stopped), "sources stopped");
  assert.ok(g.made.every((n) => n.connections.length === 0), "no connection left");
  assert.deepEqual(au.stats(), { built: false, started: false, nodes: 0 });
  assert.doesNotThrow(() => au.dispose());
  assert.equal(au.start(), false, "no rebuild after dispose");
  assert.equal(au.active, false);
  bus.ctx.made.length = 0;
  au.update({ throttle: 1, speed: 1, level: 1, fpv: false, pos: [1, 2, 3] });
  assert.equal(bus.ctx.made.length, 0);
});

check("A10 start() resumes a suspended context (it runs inside the deploy click)", async () => {
  const bus = makeBus({ state: "suspended" });
  const au = A.createDroneAudio({ bus });
  assert.equal(au.start(), true);
  assert.equal(bus.ctx.resumes, 1);
  await Promise.resolve();
  assert.equal(bus.ctx.state, "running");
  au.dispose();
  // a rejecting resume() is swallowed
  const bus2 = makeBus({ state: "suspended" });
  bus2.ctx.resume = () => Promise.reject(new Error("no gesture"));
  const au2 = A.createDroneAudio({ bus: bus2 });
  assert.equal(au2.start(), true);
  await new Promise((r) => setTimeout(r, 2));
  au2.dispose();
});

check("A11 a bus getter is resolved at start() and, while started but unbuilt, at most once per second in update()", () => {
  const bus = makeBus();
  let ready = false;
  let calls = 0;
  let now = 10;
  const au = A.createDroneAudio({ bus: () => { calls += 1; return ready ? bus : null; }, clock: () => now });
  assert.equal(au.start(), false, "no context yet");
  assert.equal(calls, 1);
  assert.equal(au.active, true, "started, unbuilt");
  for (const t of [10.2, 10.5, 10.99]) { now = t; au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] }); }
  assert.equal(calls, 1, "≤ 1 Hz");
  now = 11;
  au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
  assert.equal(calls, 2);
  ready = true;
  now = 11.5;
  au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
  assert.equal(calls, 2);
  assert.equal(au.stats().built, false);
  now = 12.01;
  au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
  assert.equal(calls, 3);
  assert.equal(au.stats().built, true, "built from update()");
  const g = graphOf(bus.ctx, bus.node);
  near(g.input.gain.value, A.humParams({ throttle: 1, speed: 0, level: 1 }).gain, 1e-12, "the same update then sets the level");
  now = 20;
  au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
  assert.equal(calls, 3, "no more resolves once built");
  // stopped while unbuilt: no retry
  const au2 = A.createDroneAudio({ bus: () => { calls += 1; return null; }, clock: () => now });
  au2.start();
  const c0 = calls;
  au2.stop();
  now = 40;
  au2.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
  assert.equal(calls, c0);
  au.dispose();
});

check("A12 on the REAL effect bus: the hum connects to am._effectMaster, takes no voice-pool slot, and leaves nothing on dispose", () => {
  const prev = globalThis.window.AudioContext;
  globalThis.window.AudioContext = DroneFakeCtx;
  try {
    const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false });
    am.notifyUserGesture();
    am.setEffectGain(0.5);
    const au = A.createDroneAudio({ bus: () => am.getEffectBus?.() ?? null, volume: () => 0.6 });
    assert.equal(au.start(), true);
    const ctx = am._ctx;
    const hum = ctx.made.filter((n) => n !== am._master && n !== am._effectMaster && n !== am._ambientMaster);
    const toBus = hum.filter((n) => n.connections.includes(am._effectMaster));
    assert.deepEqual(toBus.map((n) => n.kind).sort(), ["gain", "panner"]);
    assert.equal(am.voicePool.activeCount(), 0, "no retail voice slot");
    au.update({ throttle: 1, speed: 0, level: 1, fpv: true, pos: [0, 0, 0] });
    const input = hum.find((n) => n.kind === "gain" && n.connections.length === 2);
    near(input.gain.value, A.humParams({ throttle: 1, speed: 0, level: 1 }).gain * 0.6 * 0.5, 1e-12, "retail mix: the slider multiplied in");
    assert.equal(am._effectMaster.gain.value, 1, "the bus itself stays at unity");
    au.dispose();
    assert.ok(hum.every((n) => n.connections.length === 0));
    assert.ok(am._effectMaster.connections.includes(am._master), "the client's bus untouched");
  } finally {
    globalThis.window.AudioContext = prev;
  }
});

// ---------------------------------------------------------------------------

for (const p of pending) await p();
fake.uninstall();
console.log(`\ndrone_audio: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
