// scene3d/diag/physics.js — local-player predicted-vs-server drift diagnostic
//
// Wave-3 surface. Captures one sample per applied integrator frame from the
// LOCAL PLAYER's three pose sources, all of which the runtime is already
// computing for normal rendering — we never trigger a re-integration just to
// diagnose. The three sources, per the Wave 3.F shadow + reconcile model:
//
//   PREDICTED — `sessionHandle.getLastClientPrediction()` (wasm-bindgen
//       export added 2026-05-19 explicitly for diagnostics; carries the
//       integrator's PURE prediction before server reconciliation clobbers
//       it). Returns `{position_x, position_y, position_z, ...}` in
//       WORLD space (the JS rAF setter pushes `sprite.x/sprite.y`, which
//       are world-coordinate values per index.html:5332-5333). Fallback:
//       `scene3d.cameraSwitcher.predictedPlayerPos` for the eventuality
//       that the wasm getter isn't compiled into this build.
//
//   SERVER — `window.__lastEntityWorldPos.get(localGuid)` slot
//       `{x, y, z, ts}` populated by drainEntityEvents3D's KIND_POSITION
//       branch (loop.js:806-815). `ts` is `performance.now()` at receive
//       time, so `now - rec.ts` is a meaningful staleness signal.
//
//   APPLIED — `liveScene3d.entityManager.entityMap.get(localGuid).root
//       .position` (a Three.Vector3) — what the per-frame setPose actually
//       wrote to the scene-graph rig. Sourced from the integrator's
//       reconciled pose blended with the camera-side prediction lerp, so
//       a fork between predicted and applied means the lerp is doing real
//       work (typical) and a fork between server and applied means the
//       reconcile pulled the rig away from the pure-prediction shadow.
//
// Drift definition: `distance(predicted, server)` — meters. This is the
// "rubberband magnitude": how far the client's PURE prediction is from
// the server's authoritative pose. The 5.0 m threshold matches the
// Workstream B reconcile-vs-snap cutoff in camera.js:852 — anything
// above that flips from lerp to snap, which is the visible rubberband
// event we want to count.
//
// Cost: ~2 Map lookups + 1 sqrt + 1 push + occasional shift, per applied
// frame. At 60 Hz this is microseconds. Ring buffer caps at 600 samples
// (~10 s of history) — single-shift on overflow is amortized O(1).
//
// Devtools entry points exposed on `__diag.physics`:
//   samples        — raw ring buffer (read-only access from devtools)
//   onFrame()      — host hook; called from loop.js per applied frame
//   summary()      — { total, windowMs, drift{max,avg,p99}, hitchCount,
//                      lastSampleAgeMs }
//   tail(n=20)     — last n samples in chronological order
//   reset()        — clear the buffer

const MAX_SAMPLES_DEFAULT = 600;
const HITCH_THRESHOLD_M = 5.0;

/** Pull the local player's guid through the runtime accessor. */
function readLocalGuid() {
  if (typeof window === "undefined") return null;
  const fn = window.getLocalPlayerGuid;
  if (typeof fn !== "function") return null;
  try {
    const g = fn();
    if (g === null || g === undefined) return null;
    return g >>> 0;
  } catch (_) {
    return null;
  }
}

/** Predicted pose in world space. Returns [x,y,z] or null. */
function readPredicted(ls, sessionHandle) {
  if (sessionHandle && typeof sessionHandle.getLastClientPrediction === "function") {
    try {
      const p = sessionHandle.getLastClientPrediction();
      if (p) return [p.position_x, p.position_y, p.position_z];
    } catch (_) {}
  }
  const fallback = ls?.cameraSwitcher?.predictedPlayerPos;
  if (fallback && Number.isFinite(fallback.x)) {
    return [fallback.x, fallback.y, fallback.z];
  }
  return null;
}

/** Scene-graph applied pose. Returns [x,y,z] or null. */
function readApplied(ls, guid) {
  const inst = ls?.entityManager?.entityMap?.get(guid);
  if (!inst || !inst.root) return null;
  const p = inst.root.position;
  if (!p) return null;
  return [p.x, p.y, p.z];
}

/** Last server-reported pose + age in ms. Returns {pos, ageMs} or {pos:null, ageMs:null}. */
function readServer(guid, now) {
  // Per the loop.js drain branch, the canonical home is `window.__lastEntityWorldPos`.
  // Grounding mentioned `scene3d.__lastEntityWorldPos`; the actual map lives on window.
  const map = (typeof window !== "undefined") ? window.__lastEntityWorldPos : null;
  if (!(map instanceof Map)) return { pos: null, ageMs: null };
  const rec = map.get(guid);
  if (!rec) return { pos: null, ageMs: null };
  const ageMs = (typeof rec.ts === "number") ? (now - rec.ts) : null;
  return { pos: [rec.x, rec.y, rec.z], ageMs };
}

/** Euclidean distance between two [x,y,z] tuples. Returns -1 if either is null. */
function dist3(a, b) {
  if (!a || !b) return -1;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function attachPhysics(diag) {
  const physics = {
    samples: [],
    maxSamples: MAX_SAMPLES_DEFAULT,

    /**
     * Per-frame host hook. Reads predicted/applied/server from runtime
     * state and pushes one sample. No-op when liveScene3d isn't wired up
     * yet (boot window) or when there's no local player guid (pre-spawn).
     */
    onFrame() {
      if (typeof window === "undefined") return;
      const ls = window.liveScene3d;
      if (!ls) return;
      const sessionHandle = ls.sessionHandle ?? window.__sessionHandle ?? null;
      const guid = readLocalGuid();
      if (!guid) return;

      const t = performance.now();
      const predicted = readPredicted(ls, sessionHandle);
      const applied = readApplied(ls, guid);
      const { pos: server, ageMs: serverAge } = readServer(guid, t);
      const drift = dist3(predicted, server);
      const hitch = (drift >= 0) && (drift > HITCH_THRESHOLD_M);

      const sample = { t, predicted, applied, server, serverAge, drift, hitch };
      this.samples.push(sample);
      if (this.samples.length > this.maxSamples) this.samples.shift();
    },

    /**
     * Aggregate over the current ring buffer. drift.max/avg/p99 are
     * computed over samples with valid drift (>= 0); samples with null
     * predicted or null server are excluded from the drift stats but
     * still counted in `total`.
     */
    summary() {
      const samples = this.samples;
      const total = samples.length;
      if (total === 0) {
        return {
          total: 0,
          windowMs: 0,
          drift: { max: 0, avg: 0, p99: 0 },
          hitchCount: 0,
          lastSampleAgeMs: 0,
        };
      }
      const first = samples[0];
      const last = samples[total - 1];
      const windowMs = last.t - first.t;

      const drifts = [];
      let hitchCount = 0;
      for (const s of samples) {
        if (s.drift >= 0) drifts.push(s.drift);
        if (s.hitch) hitchCount += 1;
      }
      let max = 0, avg = 0, p99 = 0;
      if (drifts.length > 0) {
        let sum = 0;
        for (const d of drifts) {
          if (d > max) max = d;
          sum += d;
        }
        avg = sum / drifts.length;
        // p99: sort ascending, index = ceil(0.99 * n) - 1, clamped.
        const sorted = drifts.slice().sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.99 * sorted.length) - 1));
        p99 = sorted[idx];
      }

      const lastSampleAgeMs = performance.now() - last.t;

      return {
        total,
        windowMs,
        drift: { max, avg, p99 },
        hitchCount,
        lastSampleAgeMs,
      };
    },

    /** Last n samples in chronological order (oldest → newest). */
    tail(n = 20) {
      const samples = this.samples;
      const k = Math.max(0, Math.min(n | 0, samples.length));
      return samples.slice(samples.length - k);
    },

    /** Clear the ring buffer. Counters in summary() reset implicitly. */
    reset() {
      this.samples.length = 0;
    },
  };

  diag.physics = physics;
}
