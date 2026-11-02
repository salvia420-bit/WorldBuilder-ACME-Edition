// scene3d/vehicle/predictor.js — pilot prediction + reconciliation, observer interpolation (vehicles DESIGN §6.2).
//
// Pilot: each local 30 Hz step quantizes the controls into a wire frame (seq = the step index), integrates the
// flight model with EXACTLY that frame (the server integrates the same bytes), and stores (seq, frame, state).
// A VehicleState carrying ackInputSeq = a resets to the server state at a and replays the newer frames; the visible
// jump is folded into an offset that decays over ~150 ms (the camera and the model follow state + offset).
// Observers: VehicleState snapshots are interpolated ~120 ms behind on the server step timeline.
// Pure module: no DOM / three / wasm. The ground function and the clock are injected.

import {
  DT, MODE, cloneState, inputFromFrame, quantizeInput, step, toGlobal, wrapHeading,
} from "./flight_model.js";

export const HISTORY = 256; // 8.5 s of steps
export const SMOOTH_TAU_S = 0.15;
export const SNAP_DISTANCE_M = 25; // beyond this a correction snaps instead of blending
export const OBSERVER_DELAY_S = 0.12;
// The observer playback clock: the offset (local − server seconds) is min-filtered over the samples, and the offset the
// playback uses follows it at a bounded time warp (OBSERVER_CLOCK_WARP: at most 10 % faster / slower than real time).
// Applied at once, a sample drained sooner than the ones before (the frame cadence + network jitter: up to a frame
// period + the jitter) moved the playback time — and the aircraft — forward by that much in ONE frame: a fresh track
// (the bail hand-off, an aircraft coming into view) jumped ~4 m ahead at 111 m/s (273 m/s for one 16.7 ms frame, the
// camera-to-aircraft distance +15 %; vsync-quantized frames + 20 ms arrival jitter). Beyond OBSERVER_CLOCK_SNAP_S
// (a stall, a re-sync) it snaps.
export const OBSERVER_CLOCK_WARP = 0.1;
export const OBSERVER_CLOCK_SNAP_S = 0.5;

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** A VehicleState message (inbox JSON) → a global-coordinate flight state. */
export function stateFromMsg(m) {
  const [x, y, z] = toGlobal(m.cell, m.x, m.y, m.z);
  return { x, y, z, heading: m.heading, pitch: m.pitch, bank: m.bank, speed: m.speed, mode: m.mode };
}

/**
 * @param {{params: object, ground: (x:number,y:number)=>number, initial: object, vCap?: number, startSeq?: number}} o
 */
export function createPilotPredictor(o) {
  const params = o.params;
  const ground = o.ground;
  let vCap = Number.isFinite(o.vCap) ? o.vCap : params.vMax;
  let state = cloneState(o.initial);
  let prev = cloneState(state); // state before the latest step (render interpolation)
  let seq = (o.startSeq >>> 0) || 1;
  const hist = new Array(HISTORY); // ring: {seq, frame, state}
  let histCount = 0;
  // visual error offset (decays)
  const off = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0 };
  const stats = {
    steps: 0, acks: 0, corrections: 0, snaps: 0, maxCorrectionM: 0, lastCorrectionM: 0, sumCorrectionM: 0,
    missingAck: 0, substitutedAcks: 0, lastAck: 0, lastAckLagSteps: 0, replayed: 0,
  };
  const corrHist = []; // recent correction magnitudes (bench)

  function entryFor(s) {
    const e = hist[s % HISTORY];
    return e && e.seq === s ? e : null;
  }

  /** One local step with the raw (analog) controls. Returns the quantized frame to send. */
  function stepLocal(rawInput) {
    const frame = { seq, ...quantizeInput(rawInput) };
    prev = cloneState(state);
    step(state, inputFromFrame(frame), params, vCap, ground, DT);
    hist[seq % HISTORY] = { seq, frame, state: cloneState(state) };
    histCount++;
    seq = (seq + 1) >>> 0;
    stats.steps++;
    return frame;
  }

  /** The newest frames, newest first (for redundant sends). */
  function recentFrames(n = 3) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const e = entryFor((seq - i) >>> 0);
      if (!e) break;
      out.push(e.frame);
    }
    return out;
  }

  /** Server state for the pilot (ack = the last input the server consumed). */
  function reconcile(msg) {
    if (Number.isFinite(msg.vCap) && msg.vCap > 0) vCap = msg.vCap;
    const server = stateFromMsg(msg);
    const ack = msg.ack >>> 0;
    stats.acks++;
    stats.lastAck = ack;
    stats.lastAckLagSteps = ((seq - 1) - ack) | 0;
    if (msg.flags & 0x02) stats.substitutedAcks++;
    // ack 0 = the server has not consumed our first input yet: its state is the one we started from
    if (ack === 0 && histCount > 0) return { corrected: false, error: NaN };
    const e = entryFor(ack);
    if (!e) {
      // nothing to compare (before our first input, or a server re-anchor far back): adopt and drop history
      stats.missingAck++;
      if (ack === 0 || stats.lastAckLagSteps < 0 || stats.lastAckLagSteps >= HISTORY) {
        const before = renderPoseRaw(1);
        state = server;
        prev = cloneState(server);
        foldOffset(before, renderPoseRaw(1));
      }
      return { corrected: false, error: NaN };
    }
    const p = e.state;
    const dx = server.x - p.x, dy = server.y - p.y, dz = server.z - p.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const angErr = Math.abs(angleDiff(server.heading, p.heading)) + Math.abs(server.pitch - p.pitch) + Math.abs(server.bank - p.bank);
    const speedErr = Math.abs(server.speed - p.speed);
    if (err < 0.002 && angErr < 1e-4 && speedErr < 1e-3 && server.mode === p.mode) {
      return { corrected: false, error: err };
    }
    // reset to the server at `ack` and replay the newer frames
    const before = renderPoseRaw(1);
    const s = cloneState(server);
    let last = ack;
    for (let k = (ack + 1) >>> 0; k !== seq; k = (k + 1) >>> 0) {
      const he = entryFor(k);
      if (!he) break;
      step(s, inputFromFrame(he.frame), params, vCap, ground, DT);
      he.state = cloneState(s);
      last = k;
      stats.replayed++;
    }
    const lastE = entryFor(((seq - 1) >>> 0));
    // prev = state one step before the newest, for render interpolation
    const pe = entryFor(((seq - 2) >>> 0));
    state = s;
    prev = pe ? cloneState(pe.state) : cloneState(s);
    void last; void lastE;
    stats.corrections++;
    stats.lastCorrectionM = err;
    stats.sumCorrectionM += err;
    if (err > stats.maxCorrectionM) stats.maxCorrectionM = err;
    corrHist.push(err);
    if (corrHist.length > 4096) corrHist.shift();
    if (err > SNAP_DISTANCE_M) {
      stats.snaps++;
      zeroOffset();
    } else {
      foldOffset(before, renderPoseRaw(1));
    }
    return { corrected: true, error: err };
  }

  function zeroOffset() {
    off.x = off.y = off.z = off.heading = off.pitch = off.bank = 0;
  }

  function foldOffset(before, after) {
    off.x += before.x - after.x;
    off.y += before.y - after.y;
    off.z += before.z - after.z;
    off.heading += angleDiff(before.heading, after.heading);
    off.pitch += before.pitch - after.pitch;
    off.bank += before.bank - after.bank;
  }

  /** Decay the visual offset (call once per rendered frame). */
  function decay(dtSec) {
    const k = Math.exp(-Math.max(0, dtSec) / SMOOTH_TAU_S);
    off.x *= k; off.y *= k; off.z *= k; off.heading *= k; off.pitch *= k; off.bank *= k;
  }

  /** prev→state interpolation at alpha ∈ [0,1], WITHOUT the visual offset. */
  function renderPoseRaw(alpha) {
    const a = Math.max(0, Math.min(1, alpha));
    return {
      x: prev.x + (state.x - prev.x) * a,
      y: prev.y + (state.y - prev.y) * a,
      z: prev.z + (state.z - prev.z) * a,
      heading: wrapHeading(prev.heading + angleDiff(state.heading, prev.heading) * a),
      pitch: prev.pitch + (state.pitch - prev.pitch) * a,
      bank: prev.bank + (state.bank - prev.bank) * a,
      speed: prev.speed + (state.speed - prev.speed) * a,
      mode: state.mode,
    };
  }

  /** The pose to draw this frame. */
  function renderPose(alpha) {
    const r = renderPoseRaw(alpha);
    r.x += off.x; r.y += off.y; r.z += off.z;
    r.heading = wrapHeading(r.heading + off.heading);
    r.pitch += off.pitch; r.bank += off.bank;
    return r;
  }

  return {
    stepLocal,
    recentFrames,
    reconcile,
    decay,
    renderPose,
    get state() { return state; },
    get seq() { return seq; },
    get vCap() { return vCap; },
    set vCap(v) { if (Number.isFinite(v) && v > 0) vCap = v; },
    get offset() { return { ...off }; },
    stats: () => ({ ...stats, meanCorrectionM: stats.corrections ? stats.sumCorrectionM / stats.corrections : 0 }),
    corrections: () => corrHist.slice(),
    adopt(msg) {
      state = stateFromMsg(msg);
      prev = cloneState(state);
      if (Number.isFinite(msg.vCap) && msg.vCap > 0) vCap = msg.vCap;
      zeroOffset();
    },
    histCount: () => histCount,
  };
}

/** Observer interpolation of a vehicle someone else flies. */
export function createObserverTrack() {
  const snaps = []; // {t (server seconds), state}
  let clockOffset = null; // localSec - serverSec (min-filtered)
  let applied = null; // the offset the playback uses: follows clockOffset at OBSERVER_CLOCK_WARP
  let posedAt = null; // localSec of the last pose()
  /** The playback's clock offset at localSec (slewed toward the min-filtered one; see OBSERVER_CLOCK_WARP). */
  function playbackOffset(localSec) {
    const target = clockOffset ?? 0;
    if (applied === null || !(Math.abs(target - applied) <= OBSERVER_CLOCK_SNAP_S)) applied = target;
    else if (posedAt !== null && localSec > posedAt) {
      const m = OBSERVER_CLOCK_WARP * (localSec - posedAt);
      applied += Math.max(-m, Math.min(m, target - applied));
    }
    if (posedAt === null || localSec > posedAt) posedAt = localSec;
    return applied;
  }
  return {
    push(msg, localSec) {
      const t = msg.step * DT;
      const st = stateFromMsg(msg);
      if (snaps.length && t <= snaps[snaps.length - 1].t) return;
      snaps.push({ t, state: st });
      if (snaps.length > 64) snaps.shift();
      const off = localSec - t;
      clockOffset = clockOffset === null ? off : Math.min(clockOffset + 0.001, off);
    },
    pose(localSec) {
      if (!snaps.length) return null;
      const t = localSec - playbackOffset(localSec) - OBSERVER_DELAY_S;
      if (t <= snaps[0].t) return { ...snaps[0].state };
      for (let i = snaps.length - 1; i > 0; i--) {
        const a = snaps[i - 1], b = snaps[i];
        if (t >= a.t && t <= b.t) {
          const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
          return {
            x: a.state.x + (b.state.x - a.state.x) * k,
            y: a.state.y + (b.state.y - a.state.y) * k,
            z: a.state.z + (b.state.z - a.state.z) * k,
            heading: wrapHeading(a.state.heading + angleDiff(b.state.heading, a.state.heading) * k),
            pitch: a.state.pitch + (b.state.pitch - a.state.pitch) * k,
            bank: a.state.bank + (b.state.bank - a.state.bank) * k,
            speed: b.state.speed,
            mode: b.state.mode,
          };
        }
      }
      // past the newest: extrapolate along the heading for at most 0.25 s
      const last = snaps[snaps.length - 1].state;
      const ex = Math.min(0.25, t - snaps[snaps.length - 1].t);
      if (last.mode !== MODE.FLIGHT && last.mode !== MODE.DERELICT) return { ...last };
      const h = last.speed * Math.cos(last.pitch);
      return {
        ...last,
        x: last.x + h * Math.sin(last.heading) * ex,
        y: last.y + h * Math.cos(last.heading) * ex,
        z: last.z + last.speed * Math.sin(last.pitch) * ex,
      };
    },
    get count() { return snaps.length; },
  };
}
