// scene3d/drone/tether.js — range sphere, ceiling, battery and return path of the Drone Deploy
// craft (scene3d/drone/SPEC.md §3.4).
//
// WHY: the drone may only fly where the client already has the world. The 3×3
// terrain ring around the player's landblock always reaches ≥ 192 m in every
// direction and ACE sends objects for about that neighbourhood, so the range
// is a 3-D sphere around the drop spot capped at 180 m (DV-20): the drone
// never sees unloaded ground or objects the server did not send. The signal
// fades over the last 50 m of the range (the OSD static rises), a ceiling
// keeps the craft within 120 m above the ground, and a battery drains with
// throttle: a warning at 20 %, ONE automatic return-to-home at 10 %, a forced
// landing at 0. `planReturn` builds the climb → cruise → descend polyline
// that scene3d/drone/manual_flight.js flies home.
//
// Drone Deploy is DEFAULT ON since 2026-10-25 (`?drone=off`, exact match, disables it). Pure module: no DOM,
// three, wasm, clocks or Math.random, and no imports. The per-frame members
// (`clamp`, `drain`) allocate nothing: each returns its own reused object
// (callers copy what they keep); `planReturn` is a plan and returns fresh
// arrays. Same inputs → same outputs.

/**
 * Tether defaults (SPEC §3.4): range sphere radius `rangeM` (m, 3-D distance
 * from the drop spot) and its cap `hardCapM`; the signal fades to 0 over the
 * last `signalFadeM` of the range; `ceilingAglM` above the ground; battery
 * life `batterySec` at hover, warning at `warnAt`, automatic return-to-home at
 * `rthAt`; drain rate per second = (`drainIdle` + `drainPerThrottle` ·
 * throttle) / `batterySec` (hover, throttle 1, empties in exactly
 * `batterySec`).
 * @type {Readonly<{rangeM:number, hardCapM:number, signalFadeM:number, ceilingAglM:number,
 *   batterySec:number, warnAt:number, rthAt:number, drainIdle:number, drainPerThrottle:number}>}
 */
export const TETHER_DEFAULTS = Object.freeze({ rangeM: 150, hardCapM: 180, signalFadeM: 50, ceilingAglM: 120,
  batterySec: 600, warnAt: 0.2, rthAt: 0.1, drainIdle: 0.6, drainPerThrottle: 0.4 });

/** Smallest range sphere (m); `rangeM` is clamped to [RANGE_MIN_M, TETHER_DEFAULTS.hardCapM]. */
const RANGE_MIN_M = 20;
/** Throttle (thrust / weight) is clamped to [0, THROTTLE_MAX] for the drain (the craft's 2.5 g limit). */
const THROTTLE_MAX = 2.5;
/** Return paths whose horizontal leg is shorter than this (m) go straight over home (SPEC §3.4). */
const SHORT_RETURN_M = 3;
/** Default cruise height above the ground of a return path (m). */
const CRUISE_AGL_M = 15;
/** Consecutive return-path points closer than this (m) are duplicates. */
const DUPLICATE_M = 1e-9;
/** A battery below this fraction reads as empty (absorbs float drift of Σ dt). */
const BATTERY_EPS = 1e-9;

/** True for an array-like with three finite components. */
function isVec3(a) {
  return a != null && typeof a === "object" &&
    Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}

/** `rangeM` clamped to [RANGE_MIN_M, hardCapM]; non-finite → `fallback`. */
function rangeOf(v, fallback) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(TETHER_DEFAULTS.hardCapM, Math.max(RANGE_MIN_M, v));
}

/** A positive finite ceiling (m above the ground); anything else → `fallback`. */
function ceilingOf(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Link quality at a 3-D distance from the drop spot: 1 at ≤ `rangeM − fadeM`,
 * falling linearly to 0 at `rangeM` (and 0 beyond). `fadeM <= 0` is a step at
 * `rangeM`. A non-finite distance reads 0; a non-finite `rangeM` / `fadeM`
 * falls back to TETHER_DEFAULTS. Example (rangeM 150): 100 → 1, 125 → 0.5,
 * 150 → 0.
 * @param {number} distM metres from the drop spot
 * @param {number} rangeM range sphere radius (m)
 * @param {number} [fadeM=50] fade band below `rangeM` (m)
 * @returns {number} signal in [0, 1]
 */
export function signalForDistance(distM, rangeM, fadeM = TETHER_DEFAULTS.signalFadeM) {
  if (typeof distM !== "number" || !Number.isFinite(distM)) return 0;
  const R = typeof rangeM === "number" && Number.isFinite(rangeM) ? rangeM : TETHER_DEFAULTS.rangeM;
  const F = typeof fadeM === "number" && Number.isFinite(fadeM) ? fadeM : TETHER_DEFAULTS.signalFadeM;
  if (!(F > 0)) return distM < R ? 1 : 0;
  const s = (R - distM) / F;
  return s >= 1 ? 1 : s <= 0 ? 0 : s;
}

/**
 * Create the tether of one deploy (SPEC §3.4).
 *
 * - `clamp(pos, home, groundZ)` → reused `{pos, signal, limited, kind, normal, distM}`:
 *   `distM` = 3-D distance of `pos` from `home`; outside `rangeM` the position
 *   is projected onto the sphere (`kind 'range'`, `normal` = unit vector toward
 *   home); above `(groundZ ?? home[2]) + ceilingAglM` z is clamped
 *   (`kind 'ceiling'`, `normal [0, 0, −1]`); both limits are applied when both
 *   are exceeded and range wins the report; `signal` =
 *   `signalForDistance(distM)` before the projection; `kind` / `normal` are
 *   null when not limited. A non-finite `home` means no tether (pos passes,
 *   signal 1); a non-finite `pos` passes through unchanged with signal 0.
 * - `drain(dt, throttle)` → reused `{battery, warn, rth, empty}`:
 *   `battery −= dt / batterySec · (0.6 + 0.4·clamp(throttle, 0, 2.5))`, floored
 *   at 0; `warn = battery ≤ 0.2`; `rth` true on exactly ONE call — the first
 *   with `battery ≤ 0.1` since the last reset (the crossing call); `empty =
 *   battery ≤ 0`. `dt ≤ 0` / non-finite drains nothing; a non-finite throttle
 *   counts as 0. Battery off (`batterySec <= 0`) → `{battery: 1, warn: false,
 *   rth: false, empty: false}`.
 * - `planReturn(from, home, {cruiseAglM = 15, groundZFrom = null, groundZHome =
 *   null})` → fresh `{points, lengthM, cruiseZ}`: `cruiseZ = max(from[2],
 *   (groundZFrom ?? home[2]) + cruiseAglM, (groundZHome ?? home[2]) +
 *   cruiseAglM)`; horizontal distance ≥ 3 m → `[from, [from.x, from.y,
 *   cruiseZ], [home.x, home.y, cruiseZ], home]`, else `[from, [home.x, home.y,
 *   max(from.z, home.z + 1)], home]`; consecutive duplicates removed (the
 *   later point kept, so the last point is `home` exactly); `lengthM` = Σ
 *   segment lengths. Never throws (a non-finite `home` → the path `[from]`
 *   (or `[]`), a non-finite `from` → `[home]`).
 * - `configure({rangeM?, ceilingAglM?})` — live settings change (rangeM clamped
 *   to [20, 180]; invalid values ignored).
 * - `reset({battery = 1})` — battery level (clamped to [0, 1]) and the one-shot
 *   RTH re-armed.
 * - `state()` → fresh `{rangeM, ceilingAglM, batterySec, battery, rthFired}`.
 *
 * @param {{rangeM?:number, ceilingAglM?:number, batterySec?:number}} [opts] rangeM clamped to [20, 180]
 *   (default 150); ceilingAglM (default 120); batterySec (default 600; ≤ 0 = battery off)
 * @returns {{clamp:(pos:number[], home:number[], groundZ:number|null)=>{pos:number[], signal:number,
 *   limited:boolean, kind:('range'|'ceiling'|null), normal:(number[]|null), distM:number},
 *   drain:(dt:number, throttle:number)=>{battery:number, warn:boolean, rth:boolean, empty:boolean},
 *   planReturn:(from:number[], home:number[], opts?:{cruiseAglM?:number, groundZFrom?:number|null,
 *   groundZHome?:number|null})=>{points:number[][], lengthM:number, cruiseZ:number},
 *   configure:(patch:{rangeM?:number, ceilingAglM?:number})=>void, reset:(opts?:{battery?:number})=>void,
 *   state:()=>{rangeM:number, ceilingAglM:number, batterySec:number, battery:number, rthFired:boolean}}}
 */
export function createTether(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  let rangeM = rangeOf(o.rangeM, TETHER_DEFAULTS.rangeM);
  let ceilingAglM = ceilingOf(o.ceilingAglM, TETHER_DEFAULTS.ceilingAglM);
  const batterySec = typeof o.batterySec === "number" && Number.isFinite(o.batterySec) ? o.batterySec : TETHER_DEFAULTS.batterySec;
  const batteryOn = batterySec > 0;
  // The battery level is an object field, not a closure variable: a double in a closure variable
  // is re-boxed into a new heap number on every write (drain runs every frame).
  const bat = { level: 1 };
  let rthFired = false;

  const clampOut = { pos: [0, 0, 0], signal: 1, limited: false, kind: null, normal: null, distM: 0 };
  const rangeNormal = [0, 0, 0];
  const ceilingNormal = [0, 0, -1];
  const drainOut = { battery: 1, warn: false, rth: false, empty: false };

  function clamp(pos, home, groundZ) {
    const out = clampOut;
    const px = pos != null && typeof pos === "object" ? pos[0] : NaN;
    const py = pos != null && typeof pos === "object" ? pos[1] : NaN;
    const pz = pos != null && typeof pos === "object" ? pos[2] : NaN;
    out.pos[0] = px;
    out.pos[1] = py;
    out.pos[2] = pz;
    out.limited = false;
    out.kind = null;
    out.normal = null;
    out.distM = 0;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
      out.signal = 0;
      return out;
    }
    if (!isVec3(home)) {
      out.signal = 1;
      return out;
    }
    const hx = home[0], hy = home[1], hz = home[2];
    const dx = px - hx, dy = py - hy, dz = pz - hz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.distM = d;
    // = signalForDistance(d, rangeM), inline: a call returning a double boxes it each frame unless inlined
    const sg = (rangeM - d) / TETHER_DEFAULTS.signalFadeM;
    out.signal = sg >= 1 ? 1 : sg <= 0 ? 0 : sg;
    let x = px, y = py, z = pz;
    let kind = null;
    if (d > rangeM) {
      const s = rangeM / d;
      x = hx + dx * s;
      y = hy + dy * s;
      z = hz + dz * s;
      rangeNormal[0] = -dx / d;
      rangeNormal[1] = -dy / d;
      rangeNormal[2] = -dz / d;
      kind = "range";
    }
    const gz = typeof groundZ === "number" && Number.isFinite(groundZ) ? groundZ : hz;
    const ceil = gz + ceilingAglM;
    if (z > ceil) {
      z = ceil;
      if (kind === null) kind = "ceiling";
    }
    out.pos[0] = x;
    out.pos[1] = y;
    out.pos[2] = z;
    if (kind !== null) {
      out.limited = true;
      out.kind = kind;
      if (kind === "range") {
        out.normal = rangeNormal;
      } else {
        ceilingNormal[0] = 0;
        ceilingNormal[1] = 0;
        ceilingNormal[2] = -1;
        out.normal = ceilingNormal;
      }
    }
    return out;
  }

  function drain(dt, throttle) {
    const out = drainOut;
    if (!batteryOn) {
      out.battery = 1;
      out.warn = false;
      out.rth = false;
      out.empty = false;
      return out;
    }
    if (typeof dt === "number" && Number.isFinite(dt) && dt > 0) {
      const th = typeof throttle === "number" && Number.isFinite(throttle) ? Math.min(THROTTLE_MAX, Math.max(0, throttle)) : 0;
      bat.level -= (dt / batterySec) * (TETHER_DEFAULTS.drainIdle + TETHER_DEFAULTS.drainPerThrottle * th);
      if (!(bat.level > BATTERY_EPS)) bat.level = 0;
    }
    const level = bat.level;
    out.battery = level;
    out.warn = level <= TETHER_DEFAULTS.warnAt;
    out.empty = level <= 0;
    out.rth = false;
    if (!rthFired && level <= TETHER_DEFAULTS.rthAt) {
      rthFired = true;
      out.rth = true;
    }
    return out;
  }

  function planReturn(from, home, planOpts = {}) {
    const po = planOpts && typeof planOpts === "object" ? planOpts : {};
    const agl = typeof po.cruiseAglM === "number" && Number.isFinite(po.cruiseAglM) ? po.cruiseAglM : CRUISE_AGL_M;
    if (!isVec3(home)) {
      if (!isVec3(from)) return { points: [], lengthM: 0, cruiseZ: 0 };
      return { points: [[from[0], from[1], from[2]]], lengthM: 0, cruiseZ: from[2] };
    }
    const H = [home[0], home[1], home[2]];
    const gF = typeof po.groundZFrom === "number" && Number.isFinite(po.groundZFrom) ? po.groundZFrom : H[2];
    const gH = typeof po.groundZHome === "number" && Number.isFinite(po.groundZHome) ? po.groundZHome : H[2];
    if (!isVec3(from)) return { points: [H], lengthM: 0, cruiseZ: Math.max(gF + agl, gH + agl) };
    const F = [from[0], from[1], from[2]];
    const cruiseZ = Math.max(F[2], gF + agl, gH + agl);
    const horizontal = Math.hypot(F[0] - H[0], F[1] - H[1]);
    const raw = horizontal >= SHORT_RETURN_M
      ? [F, [F[0], F[1], cruiseZ], [H[0], H[1], cruiseZ], H]
      : [F, [H[0], H[1], Math.max(F[2], H[2] + 1)], H];
    // Drop a point that duplicates the NEXT one, so the last point stays `home` exactly.
    const points = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      const n = raw[i + 1];
      if (n && Math.hypot(n[0] - p[0], n[1] - p[1], n[2] - p[2]) <= DUPLICATE_M) continue;
      points.push(p);
    }
    let lengthM = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      lengthM += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    return { points, lengthM, cruiseZ };
  }

  function configure(patch) {
    const p = patch && typeof patch === "object" ? patch : {};
    if (p.rangeM !== undefined) rangeM = rangeOf(p.rangeM, rangeM);
    if (p.ceilingAglM !== undefined) ceilingAglM = ceilingOf(p.ceilingAglM, ceilingAglM);
  }

  function reset(resetOpts = {}) {
    const r = resetOpts && typeof resetOpts === "object" ? resetOpts : {};
    const b = typeof r.battery === "number" && Number.isFinite(r.battery) ? r.battery : 1;
    bat.level = Math.min(1, Math.max(0, b));
    rthFired = false;
  }

  function state() {
    return { rangeM, ceilingAglM, batterySec, battery: batteryOn ? bat.level : 1, rthFired };
  }

  return { clamp, drain, planReturn, configure, reset, state };
}
