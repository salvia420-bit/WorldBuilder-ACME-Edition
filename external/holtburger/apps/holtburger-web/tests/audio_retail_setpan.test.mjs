// audio_retail_setpan.test.mjs — audio-3: the `?audioRetailPan=on` mix plays
// retail's DirectSound SetPan channel levels.
//
// Retail SoundBuf::Play (acclient.c:386102) clamps the integer pan to +-15,
// skips SetPan when pan == 0 (`if (!pan) goto LABEL_9`: both channels at full
// level) and otherwise calls IDirectSoundBuffer::SetPan(100 * pan), which
// turns ONLY the far channel down by |pan| dB. PlaySoundInternal(Position)
// (383152-383180) gives pan 0 under 5 m and straight ahead / behind.
//
// Fails on the old code: retailPanGains did not exist; every retail
// positional voice went through an equal-power StereoPannerNode
// (stereoPositionFromPan matched the L/R ratio only), so pan 0 evaluated to
// 0.707 per channel (-3 dB under playFromCenter) and pan 15 to 0.175 / 0.985
// instead of 0.178 / 1.0.
//
// The fake AudioContext below records every node and connection (with
// output/input indices) and evaluates the graph for a constant-level
// buffer, following the Web Audio channel up-/down-mix rules the graph
// depends on (speakers mono<->stereo, discrete splitter input, mono merger
// inputs, equal-power StereoPanner on a mono input).
//
// Run: node tests/audio_retail_setpan.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { retailPanGains, linearGain, PAN_MAX } from "../scene3d/audio/retail_mixer.js";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
};
const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

// ── fake Web Audio with a tiny signal evaluator ────────────────────────────
const STEREO_LEVELS = [0.8, 0.6]; // distinct per channel to catch a swap

function installEvalAudio({ splitterMerger = true } = {}) {
  const nodes = [];
  const param = (v) => ({ value: v, setTargetAtTime(t) { this.value = t; }, cancelScheduledValues() {} });
  const node = (kind, extra = {}) => {
    const n = {
      kind,
      conns: [],
      channelCount: 2,
      channelCountMode: "max",
      channelInterpretation: "speakers",
      connect(to, output = 0, input = 0) { this.conns.push({ to, output, input }); return to; },
      disconnect() { this.conns = []; },
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  class EvalAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = node("destination", { channelCountMode: "explicit" });
      this.listener = {
        positionX: param(0), positionY: param(0), positionZ: param(0),
        forwardX: param(0), forwardY: param(0), forwardZ: param(-1),
        upX: param(0), upY: param(1), upZ: param(0),
      };
    }
    createGain() { return node("gain", { gain: param(1) }); }
    createStereoPanner() { return node("stereo", { pan: param(0), channelCountMode: "clamped-max" }); }
    createPanner() {
      return node("panner", { positionX: param(0), positionY: param(0), positionZ: param(0) });
    }
    createBufferSource() {
      return node("source", {
        buffer: null, loop: false, started: false, stopped: false, onended: null,
        start() { this.started = true; },
        stop() { this.stopped = true; },
      });
    }
    async decodeAudioData(ab) {
      const ch = new Uint8Array(ab)[0] === 2 ? 2 : 1;
      return { duration: 1, length: 22050, numberOfChannels: ch, levels: ch === 2 ? STEREO_LEVELS : [1] };
    }
    async resume() { this.state = "running"; }
    suspend() { this.state = "suspended"; }
  }
  if (splitterMerger) {
    EvalAudioContext.prototype.createChannelSplitter = function (n = 6) {
      return node("splitter", {
        numberOfOutputs: n, channelCount: n, channelCountMode: "explicit", channelInterpretation: "discrete",
      });
    };
    EvalAudioContext.prototype.createChannelMerger = function (n = 6) {
      return node("merger", { numberOfInputs: n, channelCount: 1, channelCountMode: "explicit" });
    };
  }

  // Web Audio channel mixing (only the cases this graph uses).
  const remix = (sig, n, interp) => {
    if (sig.length === n) return sig.slice();
    if (interp === "discrete") {
      const out = new Array(n).fill(0);
      for (let i = 0; i < Math.min(n, sig.length); i++) out[i] = sig[i];
      return out;
    }
    if (sig.length === 1 && n === 2) return [sig[0], sig[0]];
    if (sig.length === 2 && n === 1) return [0.5 * (sig[0] + sig[1])];
    throw new Error(`unmodelled mix ${sig.length} -> ${n}`);
  };
  const computed = (n, inCount) => {
    if (n.channelCountMode === "explicit") return n.channelCount;
    if (n.channelCountMode === "clamped-max") return Math.min(inCount, n.channelCount);
    return inCount;
  };
  const inputSignal = (n, inputIndex) => {
    const parts = [];
    for (const src of nodes) {
      for (const c of src.conns) {
        if (c.to === n && c.input === inputIndex) parts.push(outputsOf(src)[c.output]);
      }
    }
    if (!parts.length) return null;
    const count = Math.max(...parts.map((p) => p.length));
    const sum = new Array(count).fill(0);
    for (const p of parts) remix(p, count, "speakers").forEach((v, i) => { sum[i] += v; });
    return remix(sum, computed(n, count), n.channelInterpretation);
  };
  const outputsOf = (n) => {
    switch (n.kind) {
      case "source": {
        const lv = n.buffer?.levels ?? [1];
        return [n.started && !n.stopped ? lv.slice() : lv.map(() => 0)];
      }
      case "gain": {
        const s = inputSignal(n, 0);
        return [s ? s.map((v) => v * n.gain.value) : [0]];
      }
      case "stereo": {
        // Spec equal-power law for a mono input.
        const s = inputSignal(n, 0);
        if (!s) return [[0, 0]];
        if (s.length !== 1) throw new Error("stereo-input StereoPanner not modelled");
        const x = (Math.max(-1, Math.min(1, n.pan.value)) + 1) / 2;
        return [[s[0] * Math.cos(x * Math.PI / 2), s[0] * Math.sin(x * Math.PI / 2)]];
      }
      case "splitter": {
        const s = inputSignal(n, 0) ?? new Array(n.numberOfOutputs).fill(0);
        return s.map((v) => [v]);
      }
      case "merger": {
        const out = [];
        for (let i = 0; i < n.numberOfInputs; i++) out.push(inputSignal(n, i)?.[0] ?? 0);
        return [out];
      }
      default:
        throw new Error(`unmodelled node ${n.kind}`);
    }
  };

  const hadWindow = globalThis.window != null;
  const prevWindow = globalThis.window;
  globalThis.window = { AudioContext: EvalAudioContext };
  return {
    nodes,
    // [L, R] reaching the speakers.
    levelsAt: (ctx) => inputSignal(ctx.destination, 0) ?? [0, 0],
    kinds: () => nodes.map((n) => n.kind),
    fetchWave: async (did) => ({
      id: did, sampleRate: 22050, numChannels: 1, bitsPerSample: 16,
      // First byte = channel count for the fake decoder (0x...F2 = stereo).
      takeRiffBytes: () => new Uint8Array([((did & 0xff) === 0xf2) ? 2 : 1, 0, 0, 0]),
    }),
    uninstall() {
      if (hadWindow) globalThis.window = prevWindow;
      else delete globalThis.window;
    },
  };
}

const fake0 = installEvalAudio();
const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
fake0.uninstall();

// Listener at the origin facing AC north (identity camera quaternion).
async function voice(fake, threePos, { did = 0x0a000001, hrtf = false, center = false } = {}) {
  const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf, savedGains: false });
  am._loudLines = 1e6; // quiet the [audio-loud] diagnostic in test output
  am.notifyUserGesture();
  am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
  const h = center
    ? await am.playFromCenter(did, 1.0)
    : await am.play(did, threePos, { gain: 1.0 });
  return { am, h, lr: () => fake.levelsAt(am._ctx) };
}

// ── pure SetPan gains ──────────────────────────────────────────────────────
await test("retailPanGains: pan 0 leaves both channels at full level", () => {
  assert.deepEqual(retailPanGains(0), { left: 1, right: 1 });
});
await test("retailPanGains: pan 15 turns the LEFT channel down 15 dB, right stays 1", () => {
  const g = retailPanGains(15);
  near(g.left, 0.1778, 1e-3, "left");
  near(g.left, Math.pow(10, -0.75), 1e-12, "left exact");
  assert.equal(g.right, 1);
});
await test("retailPanGains: pan -15 mirrors", () => {
  const g = retailPanGains(-15);
  assert.equal(g.left, 1);
  near(g.right, 0.1778, 1e-3, "right");
});
await test("retailPanGains: clamps at +-15 (SoundBuf::Play)", () => {
  assert.equal(PAN_MAX, 15);
  assert.deepEqual(retailPanGains(20), retailPanGains(15));
  assert.deepEqual(retailPanGains(-20), retailPanGains(-15));
});
await test("retailPanGains: near side always 1, channel difference = |pan| dB", () => {
  for (let pan = -15; pan <= 15; pan++) {
    const { left, right } = retailPanGains(pan);
    assert.equal(Math.max(left, right), 1, `pan ${pan}`);
    near(20 * Math.log10(right / left), pan, 1e-9, `pan ${pan}`);
  }
});

// ── AudioManager retail mix (hrtf: false) ──────────────────────────────────
await test("pan 0 (3 m east, inside the 5 m dead zone): no pan nodes, full level = playFromCenter", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: 3, y: 0, z: 0 });
    assert.ok(v.h, "played");
    assert.equal(v.am.lastMix.pan, 0);
    assert.equal(v.h.panner, null, "no panner");
    assert.equal(v.h.setPan, null, "no SetPan graph");
    for (const k of ["stereo", "splitter", "merger"]) assert.ok(!fake.kinds().includes(k), `no ${k} node`);
    const [l, r] = v.lr();
    near(l, 1, 1e-9, "left full");
    near(r, 1, 1e-9, "right full");
    const c = await voice(fake, null, { did: 0x0a000002, center: true });
    assert.deepEqual(c.lr(), v.lr(), "same level as playFromCenter");
  } finally { fake.uninstall(); }
});
await test("pan 0 straight ahead at 10 m: both channels at the -12 dB voice gain (not 0.707x)", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: 0, y: 0, z: -10 });
    assert.equal(v.am.lastMix.pan, 0);
    const [l, r] = v.lr();
    near(l, linearGain(-12), 1e-9, "left");
    near(r, linearGain(-12), 1e-9, "right");
  } finally { fake.uninstall(); }
});
await test("pan 15 (10 m east): splitter graph, L 0.1778 / R 1.0 times the -12 dB gain", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: 10, y: 0, z: 0 });
    assert.equal(v.am.lastMix.pan, 15);
    assert.equal(v.h.panner, null, "no StereoPannerNode");
    assert.ok(!fake.kinds().includes("stereo"), "no stereo node built");
    const sp = v.h.setPan;
    assert.ok(sp, "SetPan graph");
    near(sp.left.gain.value, 0.1778, 1e-3, "left gain");
    assert.equal(sp.right.gain.value, 1, "right gain");
    // Topology: gain (explicit stereo up-mix) -> splitter -> L/R gains -> merger -> effect bus.
    assert.equal(v.h.gain.channelCount, 2);
    assert.equal(v.h.gain.channelCountMode, "explicit");
    assert.equal(v.h.gain.channelInterpretation, "speakers");
    assert.deepEqual(v.h.gain.conns.map((c) => c.to), [sp.splitter]);
    assert.deepEqual(sp.splitter.conns.map((c) => [c.to, c.output]), [[sp.left, 0], [sp.right, 1]]);
    assert.deepEqual(sp.left.conns.map((c) => [c.to, c.input]), [[sp.merger, 0]]);
    assert.deepEqual(sp.right.conns.map((c) => [c.to, c.input]), [[sp.merger, 1]]);
    assert.deepEqual(sp.merger.conns.map((c) => c.to), [v.am._effectMaster]);
    const g = linearGain(-12);
    const [l, r] = v.lr();
    near(l, g * 0.1778, 1e-3 * g, "left");
    near(r, g * 1.0, 1e-9, "right (near side at full level)");
  } finally { fake.uninstall(); }
});
await test("pan -15 (10 m west) mirrors: right attenuated, left full", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: -10, y: 0, z: 0 });
    assert.equal(v.am.lastMix.pan, -15);
    const g = linearGain(-12);
    const [l, r] = v.lr();
    near(l, g, 1e-9, "left");
    near(r, g * Math.pow(10, -0.75), 1e-9, "right");
  } finally { fake.uninstall(); }
});
await test("a stereo wave keeps its channels; SetPan scales each one", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: 10, y: 0, z: 0 }, { did: 0x0a0000f2 });
    assert.equal(v.am.lastMix.pan, 15);
    const g = linearGain(-12);
    const [l, r] = v.lr();
    near(l, STEREO_LEVELS[0] * g * Math.pow(10, -0.75), 1e-9, "left");
    near(r, STEREO_LEVELS[1] * g, 1e-9, "right");
  } finally { fake.uninstall(); }
});
await test("bearing sweep at 20 m: loud side = the voice gain, difference = |pan| dB", async () => {
  for (let deg = 0; deg < 360; deg += 15) {
    const fake = installEvalAudio();
    try {
      const rad = deg * Math.PI / 180;
      // AC (sin, cos) * 20 -> three (x, z = -y).
      const v = await voice(fake, { x: Math.sin(rad) * 20, y: 0, z: -Math.cos(rad) * 20 });
      const m = v.am.lastMix;
      const g = linearGain(m.decibels);
      const [l, r] = v.lr();
      near(Math.max(l, r), g, 1e-9, `${deg} deg loud side`);
      near(20 * Math.log10(r / l), m.pan, 1e-6, `${deg} deg channel difference`);
      assert.equal(fake.kinds().includes("splitter"), m.pan !== 0, `${deg} deg graph only for a non-zero pan`);
    } finally { fake.uninstall(); }
  }
});
await test("SetPan nodes are disconnected when the voice ends", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: 10, y: 0, z: 0 });
    const sp = v.h.setPan;
    v.h.source.onended();
    for (const k of ["splitter", "left", "right", "merger"]) assert.equal(sp[k].conns.length, 0, `${k} disconnected`);
    assert.equal(v.h.gain.conns.length, 0, "gain disconnected");
  } finally { fake.uninstall(); }
});
await test("a dropped 17th voice disconnects its SetPan nodes", async () => {
  const fake = installEvalAudio();
  try {
    const am = new AudioManager({ fetchWave: fake.fetchWave, hrtf: false, savedGains: false });
    am._loudLines = 1e6;
    am.notifyUserGesture();
    am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
    for (let i = 0; i < 16; i++) assert.ok(await am.playFromCenter(0x0a000100 + i, 1.0));
    assert.equal(await am.play(0x0a000200, { x: 10, y: 0, z: 0 }, { gain: 1.0 }), null, "17th dropped");
    assert.equal(am.voiceDropCount, 1);
    const built = fake.nodes.filter((n) => n.kind === "splitter" || n.kind === "merger");
    assert.equal(built.length, 2, "graph was built before the claim");
    for (const n of built) assert.equal(n.conns.length, 0, `${n.kind} disconnected`);
  } finally { fake.uninstall(); }
});
await test("context without ChannelSplitter/Merger: StereoPanner fallback for pan 15, none for pan 0", async () => {
  const fake = installEvalAudio({ splitterMerger: false });
  try {
    const v = await voice(fake, { x: 10, y: 0, z: 0 });
    assert.equal(v.h.panner?.kind, "stereo");
    assert.equal(v.h.setPan, null);
    const v0 = await voice(fake, { x: 3, y: 0, z: 0 }, { did: 0x0a000003 });
    assert.equal(v0.h.panner, null);
    near(v0.lr()[0], 1, 1e-9, "pan 0 full level");
  } finally { fake.uninstall(); }
});
await test("retail playFromCenter builds no pan nodes", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, null, { center: true });
    assert.equal(v.h.panner, null);
    assert.equal(v.h.setPan, null);
    for (const k of ["stereo", "splitter", "merger"]) assert.ok(!fake.kinds().includes(k), `no ${k} node`);
  } finally { fake.uninstall(); }
});

// ── HRTF default arm unchanged ─────────────────────────────────────────────
await test("HRTF (default) arm: source -> gain -> HRTF PannerNode -> effect bus, no SetPan nodes", async () => {
  const fake = installEvalAudio();
  try {
    const v = await voice(fake, { x: 10, y: 0, z: 0 }, { hrtf: true });
    assert.equal(v.h.panner.kind, "panner");
    assert.equal(v.h.panner.panningModel, "HRTF");
    assert.equal(v.h.setPan, null);
    for (const k of ["stereo", "splitter", "merger"]) assert.ok(!fake.kinds().includes(k), `no ${k} node`);
    assert.deepEqual(v.h.source.conns.map((c) => c.to), [v.h.gain]);
    assert.deepEqual(v.h.gain.conns.map((c) => c.to), [v.h.panner]);
    assert.deepEqual(v.h.panner.conns.map((c) => c.to), [v.am._effectMaster]);
    assert.equal(v.h.gain.channelCountMode, "max", "voice gain channel config untouched");
  } finally { fake.uninstall(); }
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}`);
