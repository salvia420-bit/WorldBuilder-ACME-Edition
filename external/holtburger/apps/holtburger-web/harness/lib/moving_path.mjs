// harness/lib/moving_path.mjs — the DETERMINISTIC camera path for the moving
// benchmark. Pure functions: no clock, no `Math.random`, no live player pose,
// no DOM. Given a spec it returns the identical pose table every time, in this
// process or any other.
//
// WHY THIS FILE EXISTS (2026-08-06)
// --------------------------------
// Every moving measurement of the 2026-08-06 frame-cost investigation was
// thrown away, and it cost two conclusions. The rig spun the camera with
//
//     window.__cam.player(dist, az, el, dz)      // once per frame
//
// which is a *live* call: `player()` reads `__cam.world()`, i.e. the CURRENT
// local-player pose (camera.js :1248-1251), and the az it was handed advanced
// with WALL CLOCK. So the pose the camera reached on frame k depended on
//   (a) where the player had drifted to — server corrections, physics settle,
//       a spawn still being reconciled — and
//   (b) how many frames had elapsed in that many milliseconds, which is the
//       very quantity being measured.
// A slower arm therefore swept a SHORTER arc, streamed a different landblock
// set and frustum-culled a different population. The condition generated its
// own variance: `?statBatchMemo=slack` moving read
//     off [28.5, 33.6, 27.0]   slack [29.6, 19.0, 22.4]
//     delta 6.10 ms | control spread 6.60 ms  -> NOT USABLE
// The control was noisier than the effect. Parked runs on the same rig held
// 0.7-2.3 ms, so the fault was entirely in how motion was produced.
//
// THE THREE RULES THIS MODULE ENCODES
// -----------------------------------
// 1. POSE IS A FUNCTION OF FRAME INDEX, NEVER OF TIME. `poseTable(spec)[k]` is
//    frame k's pose. A frame that took 40 ms and one that took 12 ms get the
//    SAME pose, so two arms traverse the same geometry whatever their fps.
// 2. THE TABLE IS BUILT IN NODE AND SHIPPED TO THE PAGE. The in-page rig does
//    no arithmetic at all — it indexes a row. There is nothing left in the
//    browser that could drift between arms.
// 3. THE ANCHOR IS PINNED, NOT READ. The camera orbits/dollies a WORLD point
//    supplied on the command line (or derived from a landblock cell id), never
//    the live player. Print it once, pass it to every later run.
//
// The path is CLOSED (frame `frames` returns to frame 0's pose) so the warm-up
// pass and the measurement pass cover the identical set of poses — the warm
// pass streams and compiles, the measure pass re-walks the same ground.
//
// Frames are the fixed axis and MILLISECONDS ARE THE MEASUREMENT. Never make a
// run a fixed number of seconds: that reintroduces rule 1's bug one level up.

/** AC world metres per landblock edge. */
export const LB_METRES = 192;

/**
 * Landblock cell id (0xXXYYnnnn, as `@teleloc` and `pose.landblockId` speak it)
 * plus landblock-local x/y/z -> AC world metres (x east, y north, z up). Same
 * fold `camera.js`'s `__cam.world()` does; kept here so `hop` mode can derive
 * its anchor from the cell id alone and never touch a live pose.
 */
export function cellToWorld(cell, lx, ly, lz) {
  const c = cell >>> 0;
  return { x: ((c >>> 24) & 0xff) * LB_METRES + lx, y: ((c >>> 16) & 0xff) * LB_METRES + ly, z: lz };
}

const DEFAULTS = {
  mode: "orbit",      // orbit | dolly | hop
  frames: 600,        // ONE lap. warm and measure each run this many frames.
  anchor: null,       // {x,y,z} AC world metres — REQUIRED (pin it explicitly)
  dist: 26,           // orbit radius / dolly loop half-width, metres
  el: 18,             // elevation degrees above the anchor
  elAmp: 0,           // elevation oscillation amplitude, degrees (0 = flat lap)
  elPeriod: 0,        // frames per elevation cycle (0 => frames/2)
  az0: 0,             // starting azimuth, degrees CW from north
  laps: 1,            // revolutions per `frames` — raises angular rate
  dz: 1.2,            // look-at height above the anchor, metres
  hops: null,         // hop mode: [{ cell, x, y, z }, ...]
  dwell: 120,         // hop mode: frames spent at each stop
};

/**
 * Normalise + validate a spec. Throws rather than silently substituting: a
 * benchmark that quietly ran a different path than the one you asked for is the
 * failure this whole file exists to prevent.
 */
export function normalizeSpec(input) {
  const s = { ...DEFAULTS, ...(input || {}) };
  s.mode = String(s.mode);
  if (!["orbit", "dolly", "hop"].includes(s.mode)) throw new Error(`moving_path: unknown mode ${s.mode}`);
  s.frames = Math.max(2, Math.round(Number(s.frames)));
  if (!Number.isFinite(s.frames)) throw new Error("moving_path: frames must be finite");
  if (s.mode === "hop") {
    if (!Array.isArray(s.hops) || s.hops.length < 2) throw new Error("moving_path: hop mode needs >= 2 stops");
    s.dwell = Math.max(1, Math.round(Number(s.dwell)));
    // Frames are DERIVED in hop mode — a partial dwell at the end would make
    // the last stop's sample shorter than the others.
    s.frames = s.hops.length * s.dwell;
  } else {
    if (!s.anchor || !Number.isFinite(s.anchor.x) || !Number.isFinite(s.anchor.y) || !Number.isFinite(s.anchor.z)) {
      throw new Error("moving_path: orbit/dolly need an explicit --anchor=x,y,z (AC world metres). "
        + "Read one with __cam.world() / @loc, then PIN it — reading it live is the bug this replaces.");
    }
  }
  for (const k of ["dist", "el", "elAmp", "az0", "laps", "dz"]) {
    s[k] = Number(s[k]);
    if (!Number.isFinite(s[k])) throw new Error(`moving_path: ${k} must be finite`);
  }
  s.elPeriod = Math.round(Number(s.elPeriod)) || Math.max(2, s.frames >> 1);
  return s;
}

const D2R = Math.PI / 180;

/** Eye position for an orbit of `anchor` at (dist, azDeg CW from north, elDeg up). */
function orbitEye(a, dist, azDeg, elDeg) {
  const az = azDeg * D2R;
  const el = elDeg * D2R;
  const h = Math.cos(el) * dist;
  return { x: a.x + h * Math.sin(az), y: a.y + h * Math.cos(az), z: a.z + Math.sin(el) * dist };
}

/**
 * The pose table: `frames` rows of `[ex, ey, ez, tx, ty, tz]` in AC world
 * metres, plus a parallel `events` array holding the chat command (if any) that
 * must be issued BEFORE that frame renders.
 *
 * Every row is a function of the integer k and the spec — that is the whole
 * contract. Read `laps`/`frames` as the angular rate: `laps * 360 / frames`
 * degrees per FRAME, so a 600-frame lap turns 0.6 deg/frame. At 40 fps that is
 * 24 deg/s of real motion; at 20 fps it is 12 deg/s — deliberately, because the
 * arms must sweep the same ARC, not the same rate.
 */
export function poseTable(specIn) {
  const s = normalizeSpec(specIn);
  const rows = new Array(s.frames);
  const events = new Array(s.frames).fill(null);

  if (s.mode === "hop") {
    // A fixed teleport sequence: same cells, same order, same dwell IN FRAMES.
    // The camera orbits each stop's own anchor, derived from the cell id, so no
    // step of this depends on where the player actually landed.
    for (let k = 0; k < s.frames; k++) {
      const stopIdx = Math.floor(k / s.dwell);
      const stop = s.hops[stopIdx];
      const a = cellToWorld(stop.cell, stop.x, stop.y, stop.z);
      const t = { x: a.x, y: a.y, z: a.z + s.dz };
      const kIn = k - stopIdx * s.dwell;                 // frame within this stop
      const az = s.az0 + (s.laps * 360 * kIn) / s.dwell;
      const eye = orbitEye(a, s.dist, az, s.el);
      rows[k] = [eye.x, eye.y, eye.z, t.x, t.y, t.z];
      if (kIn === 0) {
        // Issued on the stop's FIRST frame. `@teleloc` takes the same number
        // order as `@loc` (memory: ace-admin-cmds).
        events[k] = `@teleloc ${stop.cell.toString(16)} ${stop.x} ${stop.y} ${stop.z}`;
      }
    }
    return { spec: s, rows, events, checksum: tableChecksum(rows, events) };
  }

  const a = s.anchor;
  const t = [a.x, a.y, a.z + s.dz];
  for (let k = 0; k < s.frames; k++) {
    const az = s.az0 + (s.laps * 360 * k) / s.frames;
    const el = s.elAmp === 0 ? s.el : s.el + s.elAmp * Math.sin((2 * Math.PI * k) / s.elPeriod);
    let eye;
    if (s.mode === "orbit") {
      eye = orbitEye(a, s.dist, az, el);
    } else {
      // dolly — a closed LOOP of pure translation at a fixed per-frame step,
      // with the look-at held on the anchor. This is the arm that stresses the
      // TRANSLATION half of `?statBatchMemo=slack`'s validity region (8 m by
      // default): a lap of circumference 2*pi*dist crosses it 2*pi*dist/8 times
      // per lap regardless of fps, which is exactly the property the old rig
      // could not offer.
      const th = az * D2R;
      eye = {
        x: a.x + s.dist * Math.sin(th),
        y: a.y + s.dist * Math.cos(th),
        z: a.z + s.dz + s.dist * 0.25 * Math.sin(2 * th),
      };
    }
    rows[k] = [eye.x, eye.y, eye.z, t[0], t[1], t[2]];
  }
  return { spec: s, rows, events, checksum: tableChecksum(rows, events) };
}

/**
 * FNV-1a over the pose table, quantised to 1 mm.
 *
 * Quantised on purpose. The checksum's job is NOT to detect a float ulp; it is
 * to detect that two runs walked DIFFERENT GROUND — a different anchor, a
 * different lap count, a truncated run, or the app taking the camera back. All
 * of those move the camera by metres. Millimetres are 4 decimal orders below
 * `?statBatchMemo`'s 8 m translation slack, so quantising here cannot hide a
 * divergence that could change which instances are culled.
 */
export function tableChecksum(rows, events) {
  let h = 0x811c9dc5 >>> 0;
  const mix = (x) => {
    h ^= x & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (x >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (x >>> 16) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (x >>> 24) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let j = 0; j < 6; j++) mix(Math.round(r[j] * 1000) | 0);
    const e = events && events[i];
    if (e) for (let c = 0; c < e.length; c++) mix(e.charCodeAt(c));
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The same checksum over what the camera REALLY was when each frame rendered.
 *
 * This is the load-bearing one. `tableChecksum` proves both arms were ASKED for
 * the same path; only this proves they GOT it. The old rig's failure — the
 * camera following a drifting player — is invisible to the intended checksum
 * and screams in this one. The rig samples `camera.position` + the look-at it
 * applied, converts back to AC metres, and hashes with the identical
 * quantisation so the two are directly comparable.
 */
export const realisedChecksum = tableChecksum;
