// scene3d/vehicle/port_audio.js — Procedural Spatial WebAudio Maritime Soundscape
//
// Zero-asset deterministic synthesis for Marine Container Terminal & Container Ship:
//   - Low-speed marine diesel engine thrum (pitch, harmonics & filter cutoff track EOT -3..+3)
//   - Bow & stern tunnel thruster cavitation hiss (bandpass-filtered noise scaled by thrust)
//   - Deep dual-tone vessel Tyfon foghorn (H key & berth arrival/departure blasts)
//   - STS / RMG / RTG crane electric trolley/hoist hum & pneumatic twistlock clunk
//   - Harbor quay water lap ambient bed
//
// Strictly guarded for headless / missing-AudioContext environments (never throws).
// Deterministic noise via mulberry32(hashString(...)) — zero Math.random().
// Clean stop() and idempotent dispose().

import { hashString, mulberry32 } from "../film/core/rng.js";

const NOISE_SEED = "port-maritime-audio-v1";

export const PORT_AUDIO_TUNING = Object.freeze({
  // Low-speed 2-stroke / medium-speed marine diesel (M/V Dereth Feeder)
  dieselIdleHz: 24.0,
  dieselMaxHz: 62.0,
  dieselFilterMinHz: 110.0,
  dieselFilterMaxHz: 420.0,
  dieselIdleGain: 0.09,
  dieselMaxGain: 0.28,
  dieselRefDist: 32.0,
  dieselMaxDist: 650.0,

  // Bow & stern tunnel thruster cavitation
  thrusterFilterMinHz: 420.0,
  thrusterFilterMaxHz: 1450.0,
  thrusterFilterQ: 1.4,
  thrusterMaxGain: 0.22,
  thrusterRefDist: 24.0,
  thrusterMaxDist: 420.0,

  // Deep dual-tone ship Tyfon foghorn (classic minor/major maritime interval)
  foghornFreqAHz: 110.0, // A2
  foghornFreqBHz: 138.6, // C#3 (rich marine air-diaphragm chord)
  foghornDurationSec: 2.1,
  foghornShortDurationSec: 0.75,
  foghornGain: 0.34,
  foghornRefDist: 60.0,
  foghornMaxDist: 1600.0,

  // STS / RMG / RTG crane electric drive hum & hoist whine
  craneBaseHz: 118.0,
  craneSpanHz: 195.0,
  craneMaxGain: 0.14,
  craneRefDist: 18.0,
  craneMaxDist: 280.0,

  // Pneumatic twistlock clunk & mooring winch
  twistlockDurationSec: 0.24,
  twistlockGain: 0.28,
  winchDurationSec: 0.55,
  winchGain: 0.16,

  // Quay harbor water lap ambient
  ambientFilterHz: 260.0,
  ambientLfoHz: 0.22,
  ambientMaxGain: 0.085,
  ambientMaxDist: 320.0,

  // Concurrency & buffer caps
  maxOneShots: 12,
  noiseSec: 2.5,
  paramTau: 0.06,
});

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const finOr = (v, d) => (fin(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** `?vehicleAudio=off` or `?portAudio=off` disables maritime synthesis. */
export function portAudioEnabled(search) {
  try {
    const sp = new URLSearchParams(search || "");
    if (sp.get("vehicleAudio") === "off") return false;
    if (sp.get("portAudio") === "off") return false;
    return true;
  } catch (_) {
    return true;
  }
}

/** Read [x, y, z] or {x, y, z} into [x, y, z] or null. */
function readVec3(p) {
  if (!p || typeof p !== "object") return null;
  if (fin(p[0]) && fin(p[1]) && fin(p[2])) return [p[0] + 0, p[1] + 0, p[2] + 0];
  if (fin(p.x) && fin(p.y) && fin(p.z)) return [p.x + 0, p.y + 0, p.z + 0];
  return null;
}

/** Convert AC world (x east, y north, z up) to WebAudio Three.js coords [x, z, -y]. */
export function acToAudioPos(pos) {
  const v = readVec3(pos);
  if (!v) return null;
  return [v[0] + 0, v[2] + 0, -v[1] + 0];
}

function setParam(param, val) {
  if (!param) return;
  try { param.value = val; } catch (_) {}
}

function setParamAt(param, val, t) {
  if (!param) return;
  try {
    if (typeof param.setValueAtTime === "function") param.setValueAtTime(val, t);
    else param.value = val;
  } catch (_) {
    setParam(param, val);
  }
}

function targetParam(param, val, t, tau) {
  if (!param) return;
  try {
    if (typeof param.setTargetAtTime === "function") param.setTargetAtTime(val, t, tau);
    else param.value = val;
  } catch (_) {
    setParam(param, val);
  }
}

function rampLin(param, val, tEnd, tStart) {
  if (!param) return;
  try {
    if (typeof param.linearRampToValueAtTime === "function") {
      param.linearRampToValueAtTime(val, tEnd);
      return;
    }
  } catch (_) {}
  targetParam(param, val, tStart, Math.max(0.005, (tEnd - tStart) * 0.35));
}

function rampExp(param, val, tEnd, tStart) {
  if (!param) return;
  const safe = Math.max(1e-4, val);
  try {
    if (typeof param.exponentialRampToValueAtTime === "function") {
      param.exponentialRampToValueAtTime(safe, tEnd);
      return;
    }
  } catch (_) {}
  targetParam(param, val, tStart, Math.max(0.005, (tEnd - tStart) * 0.3));
}

function writePannerAc(panner, pos) {
  if (!panner) return;
  const p = acToAudioPos(pos);
  if (!p) return;
  if (panner.positionX && typeof panner.positionX === "object") {
    setParam(panner.positionX, p[0]);
    setParam(panner.positionY, p[1]);
    setParam(panner.positionZ, p[2]);
  } else if (typeof panner["setPosition"] === "function") {
    try { panner["setPosition"](p[0], p[1], p[2]); } catch (_) {}
  }
}

function configurePanner(panner, refDist, maxDist, pos) {
  if (!panner) return;
  try {
    panner.panningModel = "HRTF";
    panner.distanceModel = "exponential";
    panner.refDistance = refDist;
    panner.rolloffFactor = 1.15;
    panner.maxDistance = maxDist;
    if (pos) writePannerAc(panner, pos);
  } catch (_) {}
}

function connectSafe(from, to) {
  if (!from || !to || typeof from.connect !== "function") return false;
  try {
    from.connect(to);
    return true;
  } catch (_) {
    return false;
  }
}

function stopAndDisconnect(nodes) {
  if (!Array.isArray(nodes)) return;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    try { if (typeof n.stop === "function") n.stop(); } catch (_) {}
    try { if (typeof n.disconnect === "function") n.disconnect(); } catch (_) {}
  }
}

/**
 * Compute pure acoustic targets for a container ship's marine diesel & lateral thrusters.
 * Pure, deterministic, never throws.
 */
export function computeShipAudioParams(state = {}) {
  const T = PORT_AUDIO_TUNING;
  const s = state && typeof state === "object" ? state : {};
  const rawEot = fin(s.eotNotch) ? s.eotNotch : (fin(s.eot) ? s.eot : (fin(s.throttle) ? s.throttle * 3.0 : 0));
  const eot = clamp(rawEot, -3, 3);
  const eotNorm = Math.abs(eot) / 3.0;
  const speed = Math.abs(finOr(s.surgeU, finOr(s.surgeSpeed, finOr(s.speed, 0))));
  const speedNorm = clamp(speed / 6.5, 0, 1);
  const load = clamp(Math.max(eotNorm, speedNorm * 0.85), 0, 1);
  const bowThr = clamp(Math.abs(finOr(s.bowThruster, 0)), 0, 1);
  const sternThr = clamp(Math.abs(finOr(s.sternThruster, 0)), 0, 1);
  const thrusterMag = clamp(Math.max(bowThr, sternThr) * 0.75 + (bowThr + sternThr) * 0.25, 0, 1);
  const moored = Boolean(s.moored);

  const dieselHz = T.dieselIdleHz + (T.dieselMaxHz - T.dieselIdleHz) * Math.pow(load, 0.85);
  const dieselFilterHz = T.dieselFilterMinHz + (T.dieselFilterMaxHz - T.dieselFilterMinHz) * load;
  const idleFloor = moored ? T.dieselIdleGain * 0.65 : T.dieselIdleGain;
  const dieselGain = idleFloor + (T.dieselMaxGain - T.dieselIdleGain) * load;

  const thrusterFilterHz = T.thrusterFilterMinHz + (T.thrusterFilterMaxHz - T.thrusterFilterMinHz) * thrusterMag;
  const thrusterGain = thrusterMag > 0.02 ? T.thrusterMaxGain * Math.pow(thrusterMag, 0.8) : 0;

  return {
    eotNorm,
    load,
    dieselHz,
    dieselFilterHz,
    dieselGain,
    thrusterMag,
    thrusterFilterHz,
    thrusterGain,
  };
}

/**
 * Create the procedural spatial WebAudio maritime soundscape manager.
 *
 * @param {{
 *   bus?: object | (() => object|null) | null,
 *   audioManager?: object | null,
 *   liveScene3d?: object | null,
 *   enabled?: boolean,
 *   volume?: () => number,
 *   isActive?: () => boolean,
 *   rng?: () => number,
 *   clock?: () => number,
 * }} [opts]
 */
export function createPortAudio(opts = {}) {
  const d = opts && typeof opts === "object" ? opts : {};
  const T = PORT_AUDIO_TUNING;
  const enabled = d.enabled !== false;
  const rng = typeof d.rng === "function" ? d.rng : mulberry32(hashString(NOISE_SEED));
  const clock = typeof d.clock === "function"
    ? d.clock
    : () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() / 1000 : 0);

  let disposed = false;
  let lastNullBusAt = -Infinity;

  /** @type {WeakMap<object, object>} ctx -> noise AudioBuffer */
  const ctxNoiseBuffers = new WeakMap();
  /** @type {Map<string, object>} shipId -> continuous diesel + thruster voice */
  const shipVoices = new Map();
  /** @type {Map<string, object>} craneId -> continuous crane electric hum voice */
  const craneVoices = new Map();
  /** @type {object|null} */
  let ambientVoice = null;
  /** @type {Set<object>} */
  const activeOneShots = new Set();

  const stats = {
    foghorns: 0,
    twistlocks: 0,
    winches: 0,
    shipUpdates: 0,
    craneUpdates: 0,
    ambientUpdates: 0,
  };

  function rawResolveBus() {
    let b = null;
    if (typeof d.bus === "function") {
      try { b = d.bus(); } catch (_) { b = null; }
    } else if (d.bus && typeof d.bus === "object") {
      b = d.bus;
    } else {
      const am = d.audioManager ?? d.liveScene3d?.audioManager ?? null;
      if (am && typeof am.getEffectBus === "function") {
        try { b = am.getEffectBus(); } catch (_) { b = null; }
      }
    }
    if (!b || typeof b !== "object") return null;
    const ctx = b.ctx || b.context || null;
    const node = b.node || b.destination || (ctx ? ctx.destination : null);
    if (!ctx || typeof ctx !== "object" || !node) return null;
    return { ctx, node, raw: b };
  }

  function resolveBus(force = false) {
    if (disposed || !enabled) return null;
    if (!force && lastNullBusAt > -Infinity) {
      if (clock() - lastNullBusAt < 1.0) return null;
    }
    const b = rawResolveBus();
    if (!b) {
      lastNullBusAt = clock();
      return null;
    }
    lastNullBusAt = -Infinity;
    return b;
  }

  function masterScale(bus) {
    if (!bus) return 0;
    if (typeof d.isActive === "function") {
      try { if (!d.isActive()) return 0; } catch (_) {}
    }
    const am = d.audioManager ?? d.liveScene3d?.audioManager ?? null;
    if (am && typeof am.isActive === "function") {
      try { if (!am.isActive()) return 0; } catch (_) {}
    }
    if (bus.raw && typeof bus.raw.isActive === "function") {
      try { if (!bus.raw.isActive()) return 0; } catch (_) {}
    }
    let vol = 1;
    if (typeof d.volume === "function") {
      try { vol = clamp(finOr(Number(d.volume()), 1), 0, 1); } catch (_) { vol = 1; }
    }
    let slider = 1;
    if (bus.raw && typeof bus.raw.sliderGain === "function") {
      try { slider = clamp(finOr(Number(bus.raw.sliderGain()), 1), 0, 1); } catch (_) { slider = 1; }
    }
    return vol * slider;
  }

  function getNoiseBuffer(ctx) {
    if (!ctx || typeof ctx.createBuffer !== "function") return null;
    const cached = ctxNoiseBuffers.get(ctx);
    if (cached) return cached;
    const sr = fin(ctx.sampleRate) && ctx.sampleRate > 0 ? Math.round(ctx.sampleRate) : 48000;
    const len = Math.max(256, Math.round(sr * T.noiseSec));
    const buf = ctx.createBuffer(1, len, sr);
    try {
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        ch[i] = rng() * 2 - 1;
      }
    } catch (_) {}
    ctxNoiseBuffers.set(ctx, buf);
    return buf;
  }

  function trackOneShot(nodes, endTime, ctx) {
    const rec = { nodes, endTime, ctx };
    if (activeOneShots.size >= T.maxOneShots) {
      const oldest = activeOneShots.values().next().value;
      if (oldest) {
        stopAndDisconnect(oldest.nodes);
        activeOneShots.delete(oldest);
      }
    }
    activeOneShots.add(rec);
    // Prune already-finished records lazily
    const now = fin(ctx?.currentTime) ? ctx.currentTime : 0;
    for (const item of activeOneShots) {
      if (item !== rec && item.ctx === ctx && now > item.endTime + 0.1) {
        stopAndDisconnect(item.nodes);
        activeOneShots.delete(item);
      }
    }
    return rec;
  }

  function ensureShipVoice(shipId, bus, pos) {
    const key = String(shipId ?? "ship-0");
    const existing = shipVoices.get(key);
    if (existing && existing.ctx === bus.ctx) return existing;
    if (existing) removeShip(key);

    const ctx = bus.ctx;
    if (typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return null;
    const nodes = [];
    const now = finOr(ctx.currentTime, 0);

    try {
      const outGain = ctx.createGain();
      nodes.push(outGain);
      setParamAt(outGain.gain, 0, now);

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        nodes.push(panner);
        configurePanner(panner, T.dieselRefDist, T.dieselMaxDist, pos);
        connectSafe(outGain, panner);
        connectSafe(panner, bus.node);
      } else {
        connectSafe(outGain, bus.node);
      }

      // Low-speed diesel: sawtooth fundamental + sub-harmonic sine + dynamic lowpass
      const dieselGain = ctx.createGain();
      nodes.push(dieselGain);
      setParamAt(dieselGain.gain, 0, now);

      let dieselFilter = null;
      if (typeof ctx.createBiquadFilter === "function") {
        dieselFilter = ctx.createBiquadFilter();
        nodes.push(dieselFilter);
        try { dieselFilter.type = "lowpass"; } catch (_) {}
        setParamAt(dieselFilter.frequency, T.dieselFilterMinHz, now);
        setParamAt(dieselFilter.Q, 1.4, now);
        connectSafe(dieselFilter, dieselGain);
      }
      connectSafe(dieselGain, outGain);

      const oscMain = ctx.createOscillator();
      nodes.push(oscMain);
      try { oscMain.type = "sawtooth"; } catch (_) {}
      setParamAt(oscMain.frequency, T.dieselIdleHz, now);
      connectSafe(oscMain, dieselFilter || dieselGain);

      const oscSub = ctx.createOscillator();
      nodes.push(oscSub);
      try { oscSub.type = "sine"; } catch (_) {}
      setParamAt(oscSub.frequency, T.dieselIdleHz * 0.5, now);
      const subGain = ctx.createGain();
      nodes.push(subGain);
      setParamAt(subGain.gain, 0.55, now);
      connectSafe(oscSub, subGain);
      connectSafe(subGain, dieselFilter || dieselGain);

      // Thruster cavitation hiss (looped deterministic white noise -> bandpass)
      let thrSrc = null;
      let thrFilter = null;
      let thrGain = null;
      const noiseBuf = getNoiseBuffer(ctx);
      if (noiseBuf && typeof ctx.createBufferSource === "function") {
        thrSrc = ctx.createBufferSource();
        nodes.push(thrSrc);
        thrSrc.buffer = noiseBuf;
        thrSrc.loop = true;

        if (typeof ctx.createBiquadFilter === "function") {
          thrFilter = ctx.createBiquadFilter();
          nodes.push(thrFilter);
          try { thrFilter.type = "bandpass"; } catch (_) {}
          setParamAt(thrFilter.frequency, T.thrusterFilterMinHz, now);
          setParamAt(thrFilter.Q, T.thrusterFilterQ, now);
        }
        thrGain = ctx.createGain();
        nodes.push(thrGain);
        setParamAt(thrGain.gain, 0, now);

        if (thrFilter) {
          connectSafe(thrSrc, thrFilter);
          connectSafe(thrFilter, thrGain);
        } else {
          connectSafe(thrSrc, thrGain);
        }
        connectSafe(thrGain, outGain);
        thrSrc.start(now);
      }

      oscMain.start(now);
      oscSub.start(now);

      const rec = {
        ctx,
        nodes,
        outGain,
        panner,
        dieselGain,
        dieselFilter,
        oscMain,
        oscSub,
        thrFilter,
        thrGain,
      };
      shipVoices.set(key, rec);
      return rec;
    } catch (_) {
      stopAndDisconnect(nodes);
      return null;
    }
  }

  function updateShip(shipId, state = {}, listenerPos = null) {
    if (disposed || !enabled) return false;
    stats.shipUpdates++;
    const bus = resolveBus(false);
    if (!bus) return false;

    const s = state && typeof state === "object" ? state : {};
    const pos = readVec3(s.pos) || (fin(s.x) && fin(s.y) ? [s.x, s.y, finOr(s.z, 0)] : [0, 0, 0]);
    const voice = ensureShipVoice(shipId, bus, pos);
    if (!voice) return false;

    const now = finOr(bus.ctx.currentTime, 0);
    const scale = masterScale(bus);
    const p = computeShipAudioParams(s);

    // Optional distance attenuation guard if no panner
    let distScale = 1.0;
    const lis = readVec3(listenerPos);
    if (lis) {
      const dist = Math.hypot(pos[0] - lis[0], pos[1] - lis[1], pos[2] - lis[2]);
      if (dist > T.dieselMaxDist) distScale = 0;
      else if (!voice.panner) distScale = 1 / (1 + dist / T.dieselRefDist);
    }

    writePannerAc(voice.panner, pos);
    targetParam(voice.outGain.gain, scale * distScale, now, T.paramTau);
    targetParam(voice.oscMain.frequency, p.dieselHz, now, T.paramTau);
    targetParam(voice.oscSub.frequency, p.dieselHz * 0.5, now, T.paramTau);
    if (voice.dieselFilter) targetParam(voice.dieselFilter.frequency, p.dieselFilterHz, now, T.paramTau);
    targetParam(voice.dieselGain.gain, p.dieselGain, now, T.paramTau);

    if (voice.thrGain) {
      targetParam(voice.thrGain.gain, p.thrusterGain, now, T.paramTau);
    }
    if (voice.thrFilter) {
      targetParam(voice.thrFilter.frequency, p.thrusterFilterHz, now, T.paramTau);
    }
    return true;
  }

  function removeShip(shipId) {
    const key = String(shipId ?? "ship-0");
    const rec = shipVoices.get(key);
    if (!rec) return false;
    stopAndDisconnect(rec.nodes);
    shipVoices.delete(key);
    return true;
  }

  /**
   * Deep dual-tone vessel Tyfon foghorn (H key & berth arrival/departure).
   */
  function playFoghorn(pos = [0, 0, 0], hornOpts = {}) {
    if (disposed || !enabled) return false;
    stats.foghorns++;
    const bus = resolveBus(true);
    if (!bus) return false;

    const ctx = bus.ctx;
    if (typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return false;
    const scale = masterScale(bus);
    if (scale <= 1e-4) return false;

    const o = hornOpts && typeof hornOpts === "object" ? hornOpts : {};
    const dur = clamp(
      finOr(o.durationSec, o.short ? T.foghornShortDurationSec : T.foghornDurationSec),
      0.25,
      4.5
    );
    const fA = clamp(finOr(o.freqAHz, T.foghornFreqAHz), 60, 260);
    const fB = clamp(finOr(o.freqBHz, T.foghornFreqBHz), 75, 340);
    const now = finOr(ctx.currentTime, 0);
    const nodes = [];

    try {
      const master = ctx.createGain();
      nodes.push(master);
      const peak = T.foghornGain * scale;
      setParamAt(master.gain, 0.0001, now);
      rampLin(master.gain, peak, now + 0.14, now);
      setParamAt(master.gain, peak * 0.92, now + Math.max(0.18, dur - 0.38));
      rampExp(master.gain, 0.0005, now + dur, now + Math.max(0.18, dur - 0.38));

      let filter = null;
      if (typeof ctx.createBiquadFilter === "function") {
        filter = ctx.createBiquadFilter();
        nodes.push(filter);
        try { filter.type = "lowpass"; } catch (_) {}
        setParamAt(filter.frequency, 520, now);
        setParamAt(filter.Q, 1.8, now);
        connectSafe(filter, master);
      }

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        nodes.push(panner);
        configurePanner(panner, T.foghornRefDist, T.foghornMaxDist, pos);
        connectSafe(master, panner);
        connectSafe(panner, bus.node);
      } else {
        connectSafe(master, bus.node);
      }

      const target = filter || master;

      const oscA = ctx.createOscillator();
      nodes.push(oscA);
      try { oscA.type = "sawtooth"; } catch (_) {}
      setParamAt(oscA.frequency, fA, now);
      connectSafe(oscA, target);

      const oscB = ctx.createOscillator();
      nodes.push(oscB);
      try { oscB.type = "sawtooth"; } catch (_) {}
      setParamAt(oscB.frequency, fB, now);
      const gainB = ctx.createGain();
      nodes.push(gainB);
      setParamAt(gainB.gain, 0.72, now);
      connectSafe(oscB, gainB);
      connectSafe(gainB, target);

      // Sub warmth layer
      const oscSub = ctx.createOscillator();
      nodes.push(oscSub);
      try { oscSub.type = "triangle"; } catch (_) {}
      setParamAt(oscSub.frequency, fA * 0.5, now);
      const gainSub = ctx.createGain();
      nodes.push(gainSub);
      setParamAt(gainSub.gain, 0.45, now);
      connectSafe(oscSub, gainSub);
      connectSafe(gainSub, target);

      oscA.start(now);
      oscB.start(now);
      oscSub.start(now);
      oscA.stop(now + dur + 0.04);
      oscB.stop(now + dur + 0.04);
      oscSub.stop(now + dur + 0.04);

      trackOneShot(nodes, now + dur + 0.05, ctx);
      return true;
    } catch (_) {
      stopAndDisconnect(nodes);
      return false;
    }
  }

  function ensureCraneVoice(craneId, bus, pos) {
    const key = String(craneId ?? "crane-0");
    const existing = craneVoices.get(key);
    if (existing && existing.ctx === bus.ctx) return existing;
    if (existing) removeCrane(key);

    const ctx = bus.ctx;
    if (typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return null;
    const nodes = [];
    const now = finOr(ctx.currentTime, 0);

    try {
      const gain = ctx.createGain();
      nodes.push(gain);
      setParamAt(gain.gain, 0, now);

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        nodes.push(panner);
        configurePanner(panner, T.craneRefDist, T.craneMaxDist, pos);
        connectSafe(gain, panner);
        connectSafe(panner, bus.node);
      } else {
        connectSafe(gain, bus.node);
      }

      let filter = null;
      if (typeof ctx.createBiquadFilter === "function") {
        filter = ctx.createBiquadFilter();
        nodes.push(filter);
        try { filter.type = "bandpass"; } catch (_) {}
        setParamAt(filter.frequency, 280, now);
        setParamAt(filter.Q, 1.5, now);
        connectSafe(filter, gain);
      }

      const osc = ctx.createOscillator();
      nodes.push(osc);
      try { osc.type = "triangle"; } catch (_) {}
      setParamAt(osc.frequency, T.craneBaseHz, now);
      connectSafe(osc, filter || gain);
      osc.start(now);

      const rec = { ctx, nodes, gain, panner, filter, osc };
      craneVoices.set(key, rec);
      return rec;
    } catch (_) {
      stopAndDisconnect(nodes);
      return null;
    }
  }

  /**
   * Update STS / RMG / RTG electric trolley & hoist drive hum.
   */
  function updateCrane(craneId, state = {}, listenerPos = null) {
    if (disposed || !enabled) return false;
    stats.craneUpdates++;
    const bus = resolveBus(false);
    if (!bus) return false;

    const s = state && typeof state === "object" ? state : {};
    const pos = readVec3(s.pos) || [0, 0, 0];
    const motion = clamp(
      Math.max(
        Math.abs(finOr(s.trolleySpeed, 0)) / 3.0,
        Math.abs(finOr(s.hoistSpeed, 0)) / 2.0,
        Math.abs(finOr(s.gantrySpeed, 0)) / 2.0,
        finOr(s.activity, 0)
      ),
      0,
      1
    );
    const active = s.active !== false && motion > 0.02;
    const key = String(craneId ?? "crane-0");
    if (!active && !craneVoices.has(key)) return true;

    const voice = ensureCraneVoice(key, bus, pos);
    if (!voice) return false;

    const now = finOr(bus.ctx.currentTime, 0);
    const scale = masterScale(bus);
    let distScale = 1.0;
    const lis = readVec3(listenerPos);
    if (lis) {
      const dist = Math.hypot(pos[0] - lis[0], pos[1] - lis[1], pos[2] - lis[2]);
      if (dist > T.craneMaxDist) distScale = 0;
      else if (!voice.panner) distScale = 1 / (1 + dist / T.craneRefDist);
    }

    writePannerAc(voice.panner, pos);
    const hz = T.craneBaseHz + T.craneSpanHz * motion;
    targetParam(voice.osc.frequency, hz, now, T.paramTau);
    if (voice.filter) targetParam(voice.filter.frequency, 240 + 480 * motion, now, T.paramTau);
    targetParam(voice.gain.gain, active ? T.craneMaxGain * motion * scale * distScale : 0, now, T.paramTau);
    return true;
  }

  function removeCrane(craneId) {
    const key = String(craneId ?? "crane-0");
    const rec = craneVoices.get(key);
    if (!rec) return false;
    stopAndDisconnect(rec.nodes);
    craneVoices.delete(key);
    return true;
  }

  /**
   * ISO spreader twistlock metallic engagement clunk + brief pneumatic air vent.
   */
  function playTwistlockClunk(pos = [0, 0, 0], locked = true) {
    if (disposed || !enabled) return false;
    stats.twistlocks++;
    const bus = resolveBus(true);
    if (!bus) return false;

    const ctx = bus.ctx;
    if (typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return false;
    const scale = masterScale(bus);
    if (scale <= 1e-4) return false;

    const now = finOr(ctx.currentTime, 0);
    const dur = T.twistlockDurationSec;
    const nodes = [];

    try {
      const master = ctx.createGain();
      nodes.push(master);
      setParamAt(master.gain, T.twistlockGain * scale, now);

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        nodes.push(panner);
        configurePanner(panner, 12, 180, pos);
        connectSafe(master, panner);
        connectSafe(panner, bus.node);
      } else {
        connectSafe(master, bus.node);
      }

      // Metallic steel clunk impact
      const osc = ctx.createOscillator();
      nodes.push(osc);
      try { osc.type = "triangle"; } catch (_) {}
      const startHz = locked ? 210 : 165;
      const endHz = locked ? 68 : 54;
      setParamAt(osc.frequency, startHz, now);
      rampExp(osc.frequency, endHz, now + 0.09, now);

      const impGain = ctx.createGain();
      nodes.push(impGain);
      setParamAt(impGain.gain, 0.9, now);
      rampExp(impGain.gain, 0.001, now + 0.11, now);
      connectSafe(osc, impGain);
      connectSafe(impGain, master);
      osc.start(now);
      osc.stop(now + 0.12);

      // Pneumatic air release hiss
      const noiseBuf = getNoiseBuffer(ctx);
      if (noiseBuf && typeof ctx.createBufferSource === "function") {
        const ns = ctx.createBufferSource();
        nodes.push(ns);
        ns.buffer = noiseBuf;
        const bp = typeof ctx.createBiquadFilter === "function" ? ctx.createBiquadFilter() : null;
        if (bp) {
          nodes.push(bp);
          try { bp.type = "bandpass"; } catch (_) {}
          setParamAt(bp.frequency, locked ? 2400 : 1850, now);
          setParamAt(bp.Q, 2.2, now);
        }
        const nGain = ctx.createGain();
        nodes.push(nGain);
        setParamAt(nGain.gain, 0.001, now);
        rampLin(nGain.gain, 0.35, now + 0.02, now);
        rampExp(nGain.gain, 0.001, now + dur, now + 0.02);
        if (bp) {
          connectSafe(ns, bp);
          connectSafe(bp, nGain);
        } else {
          connectSafe(ns, nGain);
        }
        connectSafe(nGain, master);
        ns.start(now);
        ns.stop(now + dur + 0.02);
      }

      trackOneShot(nodes, now + dur + 0.04, ctx);
      return true;
    } catch (_) {
      stopAndDisconnect(nodes);
      return false;
    }
  }

  /**
   * Mooring winch tensioning groan / hawser cleat cue.
   */
  function playMooringWinch(pos = [0, 0, 0]) {
    if (disposed || !enabled) return false;
    stats.winches++;
    const bus = resolveBus(true);
    if (!bus) return false;

    const ctx = bus.ctx;
    if (typeof ctx.createOscillator !== "function" || typeof ctx.createGain !== "function") return false;
    const scale = masterScale(bus);
    if (scale <= 1e-4) return false;

    const now = finOr(ctx.currentTime, 0);
    const dur = T.winchDurationSec;
    const nodes = [];

    try {
      const osc = ctx.createOscillator();
      nodes.push(osc);
      try { osc.type = "sawtooth"; } catch (_) {}
      setParamAt(osc.frequency, 92, now);
      rampLin(osc.frequency, 128, now + dur * 0.7, now);
      rampLin(osc.frequency, 80, now + dur, now + dur * 0.7);

      const gain = ctx.createGain();
      nodes.push(gain);
      setParamAt(gain.gain, 0.001, now);
      rampLin(gain.gain, T.winchGain * scale, now + 0.08, now);
      rampExp(gain.gain, 0.001, now + dur, now + 0.08);

      let panner = null;
      if (typeof ctx.createPanner === "function") {
        panner = ctx.createPanner();
        nodes.push(panner);
        configurePanner(panner, 14, 180, pos);
        connectSafe(osc, gain);
        connectSafe(gain, panner);
        connectSafe(panner, bus.node);
      } else {
        connectSafe(osc, gain);
        connectSafe(gain, bus.node);
      }

      osc.start(now);
      osc.stop(now + dur + 0.03);
      trackOneShot(nodes, now + dur + 0.05, ctx);
      return true;
    } catch (_) {
      stopAndDisconnect(nodes);
      return false;
    }
  }

  function ensureAmbientVoice(bus) {
    if (ambientVoice && ambientVoice.ctx === bus.ctx) return ambientVoice;
    if (ambientVoice) {
      stopAndDisconnect(ambientVoice.nodes);
      ambientVoice = null;
    }
    const ctx = bus.ctx;
    const noiseBuf = getNoiseBuffer(ctx);
    if (!noiseBuf || typeof ctx.createBufferSource !== "function" || typeof ctx.createGain !== "function") {
      return null;
    }
    const nodes = [];
    const now = finOr(ctx.currentTime, 0);

    try {
      const src = ctx.createBufferSource();
      nodes.push(src);
      src.buffer = noiseBuf;
      src.loop = true;

      let filter = null;
      if (typeof ctx.createBiquadFilter === "function") {
        filter = ctx.createBiquadFilter();
        nodes.push(filter);
        try { filter.type = "lowpass"; } catch (_) {}
        setParamAt(filter.frequency, T.ambientFilterHz, now);
        setParamAt(filter.Q, 0.8, now);
      }

      const gain = ctx.createGain();
      nodes.push(gain);
      setParamAt(gain.gain, 0, now);

      // Slow wave-lap LFO modulating filter cutoff
      if (filter && typeof ctx.createOscillator === "function") {
        const lfo = ctx.createOscillator();
        nodes.push(lfo);
        setParamAt(lfo.frequency, T.ambientLfoHz, now);
        const lfoGain = ctx.createGain();
        nodes.push(lfoGain);
        setParamAt(lfoGain.gain, 85, now);
        connectSafe(lfo, lfoGain);
        connectSafe(lfoGain, filter.frequency);
        lfo.start(now);
      }

      if (filter) {
        connectSafe(src, filter);
        connectSafe(filter, gain);
      } else {
        connectSafe(src, gain);
      }
      connectSafe(gain, bus.node);
      src.start(now);

      ambientVoice = { ctx, nodes, gain, filter };
      return ambientVoice;
    } catch (_) {
      stopAndDisconnect(nodes);
      return null;
    }
  }

  /**
   * Gentle harbor quay ambient water lap, attenuated by distance from waterfront.
   */
  function updateAmbient(listenerPos = null, quayPos = null, active = true) {
    if (disposed || !enabled) return false;
    stats.ambientUpdates++;
    const bus = resolveBus(false);
    if (!bus) return false;
    if (!active && !ambientVoice) return true;

    const voice = ensureAmbientVoice(bus);
    if (!voice) return false;

    const now = finOr(bus.ctx.currentTime, 0);
    const scale = masterScale(bus);
    let prox = 1.0;
    const lis = readVec3(listenerPos);
    const qp = readVec3(quayPos);
    if (lis && qp) {
      const dist = Math.hypot(lis[0] - qp[0], lis[1] - qp[1]);
      prox = clamp(1 - dist / T.ambientMaxDist, 0, 1);
    }
    targetParam(voice.gain.gain, active ? T.ambientMaxGain * prox * scale : 0, now, 0.18);
    return true;
  }

  function stop() {
    for (const rec of shipVoices.values()) stopAndDisconnect(rec.nodes);
    shipVoices.clear();
    for (const rec of craneVoices.values()) stopAndDisconnect(rec.nodes);
    craneVoices.clear();
    if (ambientVoice) {
      stopAndDisconnect(ambientVoice.nodes);
      ambientVoice = null;
    }
    for (const rec of activeOneShots) stopAndDisconnect(rec.nodes);
    activeOneShots.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
  }

  return {
    updateShip,
    removeShip,
    playFoghorn,
    playShipHorn: playFoghorn,
    playHorn: playFoghorn,
    updateCrane,
    removeCrane,
    playTwistlockClunk,
    playMooringWinch,
    updateAmbient,
    stop,
    dispose,
    get disposed() { return disposed; },
    get enabled() { return enabled; },
    stats: () => ({
      ...stats,
      activeShips: shipVoices.size,
      activeCranes: craneVoices.size,
      activeOneShots: activeOneShots.size,
      ambientActive: ambientVoice !== null,
      disposed,
    }),
  };
}
