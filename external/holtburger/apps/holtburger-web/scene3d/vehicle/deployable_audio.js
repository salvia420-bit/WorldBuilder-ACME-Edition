// scene3d/vehicle/deployable_audio.js — Procedural WebAudio & HRTF for Deployables (M3)
// Features mechanical generator hum/chug loop, pneumatic rise hiss, SAM launch roar,
// mortar ballistics/bounces/explosion, and heavy laser hitscan discharge.
// Conforms to deterministic synthesis, HRTF spatialization, and headless safe fallback.

import { hashString, mulberry32 } from "../film/core/rng.js";

const NOISE_SEED = "deployable-audio-seed";

export const DEPLOYABLE_AUDIO_TUNING = Object.freeze({
  speedOfSound: 343,
  generatorBaseHz: 55,
  generatorLfoHz: 3.0,
  generatorLfoDepthHz: 4.0,
  generatorCutoffHz: 320,
  generatorRefDist: 8,
  generatorMaxDist: 150,
  pneumaticDurationSec: 0.35,
  pneumaticCenterHz: 2200,
  pneumaticQ: 2.5,
  samDurationSec: 1.2,
  samCutoffHz: 300,
  mortarLaunchDurationSec: 0.12,
  mortarBounce1DurationSec: 0.08,
  mortarBounce2DurationSec: 0.05,
  mortarExplosionMaxRangeM: 2500,
  laserSnapDurationSec: 0.22,
  laserSnapHz: 1500,
  laserSnapQ: 10,
});

function setParam(param, val, time) {
  if (!param) return;
  try {
    if (time !== undefined && typeof param.setValueAtTime === "function") {
      param.setValueAtTime(val, time);
    } else {
      param.value = val;
    }
  } catch (_) {}
}

function writePannerPosition(panner, x, y, z) {
  if (!panner) return;
  if (panner.positionX && typeof panner.positionX === "object") {
    setParam(panner.positionX, x);
    setParam(panner.positionY, y);
    setParam(panner.positionZ, z);
  } else if (typeof panner["setPosition"] === "function") {
    try { panner["setPosition"](x, y, z); } catch (_) {}
  }
}

function configureHrtfPanner(panner, refDist, maxDist, pos) {
  if (!panner) return;
  try {
    panner.panningModel = "HRTF";
    panner.distanceModel = "exponential";
    panner.refDistance = refDist;
    panner.maxDistance = maxDist;
    panner.rolloffFactor = 1.25;
    if (pos && pos.length >= 3) {
      writePannerPosition(panner, pos[0], pos[1], pos[2]);
    }
  } catch (_) {}
}

export class DeployableAudioManager {
  constructor(audioBus = null, options = {}) {
    this.bus = audioBus;
    this.generators = new Map(); // guid -> generator sound node record
    this.rng = mulberry32(hashString(NOISE_SEED));
    this.enabled = options.enabled !== false;
  }

  getAudioContext() {
    if (this.bus && this.bus.ctx) return this.bus.ctx;
    if (this.bus && this.bus.context) return this.bus.context;
    return null;
  }

  getDestinationNode() {
    if (this.bus && this.bus.node) return this.bus.node;
    if (this.bus && this.bus.destination) return this.bus.destination;
    const ctx = this.getAudioContext();
    return ctx ? ctx.destination : null;
  }

  /**
   * Continuous mechanical generator hum/chug loop.
   */
  createGeneratorHum(guid, pos = [0, 0, 0]) {
    if (!this.enabled) return null;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createGain !== "function" || typeof ctx.createOscillator !== "function") {
      return null;
    }

    if (this.generators.has(guid)) {
      this.stopGeneratorHum(guid);
    }

    try {
      const now = ctx.currentTime || 0;
      const masterGain = ctx.createGain();
      setParam(masterGain.gain, 0.0, now);

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        configureHrtfPanner(
          panner,
          DEPLOYABLE_AUDIO_TUNING.generatorRefDist,
          DEPLOYABLE_AUDIO_TUNING.generatorMaxDist,
          pos
        );
        masterGain.connect(panner);
        const dest = this.getDestinationNode();
        if (dest && typeof panner.connect === "function") panner.connect(dest);
      } else {
        const dest = this.getDestinationNode();
        if (dest && typeof masterGain.connect === "function") masterGain.connect(dest);
      }

      // Filter
      let filter = null;
      if (typeof ctx.createBiquadFilter === "function") {
        filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        setParam(filter.frequency, DEPLOYABLE_AUDIO_TUNING.generatorCutoffHz, now);
        setParam(filter.Q, 1.2, now);
        filter.connect(masterGain);
      }

      // Fundamental oscillator (55 Hz sawtooth)
      const osc1 = ctx.createOscillator();
      osc1.type = "sawtooth";
      setParam(osc1.frequency, DEPLOYABLE_AUDIO_TUNING.generatorBaseHz, now);

      // Harmonic oscillator (110 Hz sine)
      const osc2 = ctx.createOscillator();
      osc2.type = "sine";
      setParam(osc2.frequency, DEPLOYABLE_AUDIO_TUNING.generatorBaseHz * 2, now);
      const gain2 = ctx.createGain();
      setParam(gain2.gain, 0.4, now);
      osc2.connect(gain2);

      // LFO modulation (3.0 Hz modulation)
      const lfo = ctx.createOscillator();
      lfo.frequency.value = DEPLOYABLE_AUDIO_TUNING.generatorLfoHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = DEPLOYABLE_AUDIO_TUNING.generatorLfoDepthHz;
      lfo.connect(lfoGain);
      lfoGain.connect(osc1.frequency);

      const target = filter || masterGain;
      osc1.connect(target);
      gain2.connect(target);

      osc1.start(now);
      osc2.start(now);
      lfo.start(now);

      const record = {
        masterGain,
        panner,
        filter,
        osc1,
        osc2,
        lfo,
        active: true,
      };
      this.generators.set(guid, record);
      return record;
    } catch (_) {
      return null;
    }
  }

  updateGeneratorFuel(guid, fuelSecondsRemaining) {
    const rec = this.generators.get(guid);
    if (!rec) return;
    const ctx = this.getAudioContext();
    const now = ctx ? ctx.currentTime || 0 : 0;
    const targetGain = fuelSecondsRemaining > 0 ? 0.35 : 0.0;
    setParam(rec.masterGain.gain, targetGain, now);
  }

  stopGeneratorHum(guid) {
    const rec = this.generators.get(guid);
    if (!rec) return;
    try {
      if (rec.osc1 && typeof rec.osc1.stop === "function") rec.osc1.stop();
      if (rec.osc2 && typeof rec.osc2.stop === "function") rec.osc2.stop();
      if (rec.lfo && typeof rec.lfo.stop === "function") rec.lfo.stop();
    } catch (_) {}
    this.generators.delete(guid);
  }

  /**
   * Pneumatic cylinder rise hiss (0.35s).
   */
  playPneumaticRise(pos = [0, 0, 0]) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createBuffer !== "function" || typeof ctx.createGain !== "function") return;

    try {
      const now = ctx.currentTime || 0;
      const dur = DEPLOYABLE_AUDIO_TUNING.pneumaticDurationSec;
      const sampleRate = ctx.sampleRate || 44100;
      const bufSize = Math.floor(sampleRate * dur);
      const buffer = ctx.createBuffer(1, bufSize, sampleRate);
      const data = buffer.getChannelData(0);

      // Deterministic noise
      for (let i = 0; i < bufSize; i++) {
        data[i] = (this.rng() * 2 - 1) * 0.25;
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = ctx.createBiquadFilter ? ctx.createBiquadFilter() : null;
      if (filter) {
        filter.type = "bandpass";
        setParam(filter.frequency, DEPLOYABLE_AUDIO_TUNING.pneumaticCenterHz, now);
        setParam(filter.Q, DEPLOYABLE_AUDIO_TUNING.pneumaticQ, now);
      }

      const gain = ctx.createGain();
      setParam(gain.gain, 0.0, now);
      if (typeof gain.gain.linearRampToValueAtTime === "function") {
        gain.gain.linearRampToValueAtTime(0.3, now + 0.03);
        gain.gain.setValueAtTime(0.3, now + dur - 0.05);
        gain.gain.linearRampToValueAtTime(0.0, now + dur);
      }

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        configureHrtfPanner(panner, 5, 80, pos);
      }

      const dest = this.getDestinationNode();
      if (filter) {
        noise.connect(filter);
        filter.connect(gain);
      } else {
        noise.connect(gain);
      }

      if (panner) {
        gain.connect(panner);
        if (dest) panner.connect(dest);
      } else if (dest) {
        gain.connect(dest);
      }

      noise.start(now);
      noise.stop(now + dur);
    } catch (_) {}
  }

  /**
   * SAM launch roar (1.2s duration).
   */
  playSamLaunch(pos = [0, 0, 0]) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return;

    try {
      const now = ctx.currentTime || 0;
      const dur = DEPLOYABLE_AUDIO_TUNING.samDurationSec;

      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      setParam(osc.frequency, 120, now);
      if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
        osc.frequency.exponentialRampToValueAtTime(50, now + dur);
      }

      const gain = ctx.createGain();
      setParam(gain.gain, 0.45, now);
      if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      }

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        configureHrtfPanner(panner, 10, 200, pos);
      }

      const dest = this.getDestinationNode();
      osc.connect(gain);
      if (panner) {
        gain.connect(panner);
        if (dest) panner.connect(dest);
      } else if (dest) {
        gain.connect(dest);
      }

      osc.start(now);
      osc.stop(now + dur);
    } catch (_) {}
  }

  /**
   * Mortar compressed-air launch thud (0.12s).
   */
  playMortarLaunch(pos = [0, 0, 0]) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return;

    try {
      const now = ctx.currentTime || 0;
      const dur = DEPLOYABLE_AUDIO_TUNING.mortarLaunchDurationSec;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      setParam(osc.frequency, 180, now);
      if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
        osc.frequency.exponentialRampToValueAtTime(42, now + dur);
      }

      const gain = ctx.createGain();
      setParam(gain.gain, 0.5, now);
      if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      }

      const dest = this.getDestinationNode();
      osc.connect(gain);
      if (dest) gain.connect(dest);

      osc.start(now);
      osc.stop(now + dur);
    } catch (_) {}
  }

  /**
   * Mortar ground bounce impacts.
   */
  playMortarBounce(pos = [0, 0, 0], bounceIndex = 1) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return;

    try {
      const now = ctx.currentTime || 0;
      const isFirst = bounceIndex === 1;
      const startHz = isFirst ? 100 : 130;
      const endHz = isFirst ? 60 : 80;
      const dur = isFirst
        ? DEPLOYABLE_AUDIO_TUNING.mortarBounce1DurationSec
        : DEPLOYABLE_AUDIO_TUNING.mortarBounce2DurationSec;
      const vol = isFirst ? 0.22 : 0.10;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      setParam(osc.frequency, startHz, now);
      if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
        osc.frequency.exponentialRampToValueAtTime(endHz, now + dur);
      }

      const gain = ctx.createGain();
      setParam(gain.gain, vol, now);
      if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      }

      const dest = this.getDestinationNode();
      osc.connect(gain);
      if (dest) gain.connect(dest);

      osc.start(now);
      osc.stop(now + dur);
    } catch (_) {}
  }

  /**
   * Mortar explosion with speed-of-sound arrival delay.
   */
  playMortarExplosion(pos = [0, 0, 0], listenerPos = [0, 0, 0]) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return;

    try {
      const dist = Math.hypot(
        pos[0] - listenerPos[0],
        pos[1] - listenerPos[1],
        (pos[2] || 0) - (listenerPos[2] || 0)
      );
      if (dist > DEPLOYABLE_AUDIO_TUNING.mortarExplosionMaxRangeM) return;

      const delaySec = Math.min(2.2, dist / DEPLOYABLE_AUDIO_TUNING.speedOfSound);
      const now = (ctx.currentTime || 0) + delaySec;
      const dur = 1.8;

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      setParam(osc.frequency, 75, now);
      if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
        osc.frequency.exponentialRampToValueAtTime(25, now + dur);
      }

      const gain = ctx.createGain();
      const distAtten = Math.max(0.05, 1.0 - dist / DEPLOYABLE_AUDIO_TUNING.mortarExplosionMaxRangeM);
      setParam(gain.gain, 0.6 * distAtten, now);
      if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      }

      const dest = this.getDestinationNode();
      osc.connect(gain);
      if (dest) gain.connect(dest);

      osc.start(now);
      osc.stop(now + dur);
    } catch (_) {}
  }

  /**
   * Heavy laser hitscan discharge sound.
   */
  playLaserDischarge(pos = [0, 0, 0]) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return;

    try {
      const now = ctx.currentTime || 0;
      const dur = DEPLOYABLE_AUDIO_TUNING.laserSnapDurationSec;

      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      setParam(osc.frequency, 5200, now);
      if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
        osc.frequency.exponentialRampToValueAtTime(1800, now + 0.02);
      }

      const gain = ctx.createGain();
      setParam(gain.gain, 0.35, now);
      if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      }

      const dest = this.getDestinationNode();
      osc.connect(gain);
      if (dest) gain.connect(dest);

      osc.start(now);
      osc.stop(now + dur);
    } catch (_) {}
  }

  dispose() {
    for (const guid of Array.from(this.generators.keys())) {
      this.stopGeneratorHum(guid);
    }
    this.generators.clear();
  }
}
