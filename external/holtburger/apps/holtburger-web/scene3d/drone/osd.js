// scene3d/drone/osd.js — Drone Deploy FPV on-screen display (scene3d/drone/SPEC.md §3.6).
//
// WHY: in the goggles the player needs the craft's numbers (mode, battery, flight
// time, signal, distance home, altitude, speed, heading, home bearing), the
// warnings (range limit, low battery, returning, crash) and the goggle feel (a boot
// wipe at the cut, edge vignette, static that rises as the signal fades). It is
// DOM, not canvas: one direct <body> child `#hb-drone-osd`, pointer-events none on
// every node, sized in HUD space (`var(--hb-hud-vw)` / `--hb-hud-vh`: the HUD zoom
// does not divide vw / vh — ui/hud_scale.js trap 2). Text changes at 10 Hz
// (`update`, only changed textContent is written); the heading tape and the
// horizon move every frame by CSS transform from cached strings (`frame`, no
// allocation once the strings are cached); the static is a deterministic SVG
// feTurbulence data URI (no RNG). H ("hide HUD") reuses film's clean-frame CSS
// (never `createCleanFrame`, which would lock every input) plus one keep rule
// for the OSD.
//
// Drone Deploy is DEFAULT ON since 2026-10-25 (`?drone=off`, exact match, disables it). The formatters are
// pure (no DOM, clocks or RNG); `createOsd` is a page factory with its document
// injected (none → every method is a no-op returning false). No timers.

import { FILM_CLEAN_CSS, FILM_CLEAN_CLASS, FILM_CLEAN_STYLE_ID } from "../film/runtime/clean_frame.js";

/** id of the OSD root (a direct <body> child). */
export const OSD_ID = "hb-drone-osd";
/** id of the OSD stylesheet. */
export const OSD_STYLE_ID = "hb-drone-osd-style";
/** id of the stylesheet `clean(true)` adds (film clean CSS + the OSD keep rule). */
export const DRONE_CLEAN_STYLE_ID = "hb-drone-clean-css";
/** Keeps the OSD visible under film's `body > [id^="hb-"]` hide. */
export const DRONE_CLEAN_KEEP_CSS = "html.film-clean #hb-drone-osd { display: block !important; }";
/** Modes `show` accepts. @type {ReadonlyArray<string>} */
export const OSD_MODES = Object.freeze(["off", "boot", "fpv", "pilot", "crash"]);

const DEG = 180 / Math.PI;
const NO_VALUE = "--";
const COMPASS_8 = Object.freeze(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
const MODE_LABELS = Object.freeze({ cine: "CINE", angle: "ANGLE", acro: "ACRO" });

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Compass degrees wrapped to [0, 360). */
const wrap360 = (deg) => {
  const w = deg % 360;
  return w < 0 ? w + 360 : w + 0;
};

// ---- pure formatters ---------------------------------------------------------

/**
 * Fraction → whole percent: `0.874 → "87%"`. Null / non-finite → `"--"`.
 * @param {number|null} frac
 * @returns {string}
 */
export function formatPercent(frac) {
  if (!fin(frac)) return NO_VALUE;
  return `${Math.round(frac * 100) + 0}%`;
}

/**
 * Distance: `12.34 → "12 m"`, `1234 → "1.23 km"` (km from 1000 m after rounding).
 * Null / non-finite → `"--"`.
 * @param {number|null} m metres
 * @returns {string}
 */
export function formatDistance(m) {
  if (!fin(m)) return NO_VALUE;
  const r = Math.round(m) + 0;
  if (Math.abs(r) < 1000) return `${r} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

/**
 * Altitude: one decimal below 100 m (`15.24 → "15.2 m"`), whole metres above
 * (`123.4 → "123 m"`). Null / non-finite → `"--"`.
 * @param {number|null} m metres
 * @returns {string}
 */
export function formatAltitude(m) {
  if (!fin(m)) return NO_VALUE;
  const r1 = Math.round(m * 10) / 10;
  if (Math.abs(r1) < 100) return `${r1.toFixed(1)} m`;
  return `${Math.round(m) + 0} m`;
}

/**
 * Speed: `12.34 → "12.3 m/s"`. Null / non-finite → `"--"`.
 * @param {number|null} mps
 * @returns {string}
 */
export function formatSpeed(mps) {
  if (!fin(mps)) return NO_VALUE;
  return `${(Math.round(mps * 10) / 10).toFixed(1)} m/s`;
}

/**
 * Flight timer: `135 → "02:15"`, `3725 → "1:02:05"` (whole seconds, floored).
 * Null / non-finite / negative → `"--"`.
 * @param {number|null} sec
 * @returns {string}
 */
export function formatTimer(sec) {
  if (!fin(sec) || sec < 0) return NO_VALUE;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The RETURNING banner with the seconds left to cancel a recall, 1–9 s (built once, read at 10 Hz). */
const RETURNING_COUNTDOWN = Object.freeze(Array.from({ length: 10 }, (_, n) => `RETURNING ${n} · FLY TO CANCEL`));

/**
 * The RETURNING banner: with the seconds left to cancel a recall from the goggles (rounded up,
 * at least 1) `2.4 → "RETURNING 3 · FLY TO CANCEL"`; null / non-finite / negative → "RETURNING".
 * @param {number|null} sec
 * @returns {string}
 */
export function formatReturning(sec) {
  if (!fin(sec) || sec < 0) return "RETURNING";
  const n = Math.max(1, Math.ceil(sec - 1e-9));
  return n < RETURNING_COUNTDOWN.length ? RETURNING_COUNTDOWN[n] : `RETURNING ${n} · FLY TO CANCEL`;
}

/**
 * Compass heading, three digits wrapped to [0, 360): `0.785 → "045°"`.
 * Null / non-finite → `"--"`.
 * @param {number|null} rad compass radians (clockwise from north)
 * @returns {string}
 */
export function formatHeading(rad) {
  if (!fin(rad)) return NO_VALUE;
  const d = wrap360(Math.round(rad * DEG));
  return `${String(d).padStart(3, "0")}°`;
}

/**
 * 8-point compass label of a compass heading: "N", "NE", … "NW".
 * Null / non-finite → `"--"`.
 * @param {number|null} rad
 * @returns {string}
 */
export function compassLabel(rad) {
  if (!fin(rad)) return NO_VALUE;
  const i = Math.round(wrap360(rad * DEG) / 45) % 8;
  return COMPASS_8[i];
}

/**
 * Flight-mode label: `"cine" → "CINE"`, `"angle" → "ANGLE"`, `"acro" → "ACRO"`;
 * anything else → `"--"`.
 * @param {string} mode
 * @returns {string}
 */
export function modeLabel(mode) {
  return typeof mode === "string" && Object.prototype.hasOwnProperty.call(MODE_LABELS, mode) ? MODE_LABELS[mode] : NO_VALUE;
}

/**
 * Signal bars 0..5: `signal <= 0 → 0`, else `ceil(signal·5)` (capped at 5).
 * Non-finite → 0.
 * @param {number} signal 0..1
 * @returns {number}
 */
export function signalBars(signal) {
  if (!fin(signal) || signal <= 0) return 0;
  return Math.min(5, Math.ceil(signal * 5));
}

/**
 * Static-noise opacity: `0.85·(1 − clamp01(signal))^1.5` (signal 1 → 0, 0 → 0.85).
 * Non-finite → 0 (no static flash on an unknown signal).
 * @param {number} signal 0..1
 * @returns {number}
 */
export function staticOpacity(signal) {
  if (!fin(signal)) return 0;
  return 0.85 * Math.pow(1 - clamp01(signal), 1.5) + 0;
}

/**
 * Heading-tape offset: `−(wrapped compass degrees)·pxPerDeg`. Non-finite → 0.
 * @param {number} rad compass radians
 * @param {number} [pxPerDeg=4]
 * @returns {number}
 */
export function headingTapeOffsetPx(rad, pxPerDeg = 4) {
  if (!fin(rad)) return 0;
  const k = fin(pxPerDeg) ? pxPerDeg : 4;
  return -wrap360(rad * DEG) * k + 0;
}

/**
 * Relative bearing of home from the current heading, degrees in (−180, 180]
 * (+ = home is to the right). Non-finite input → 0.
 * @param {number} headingRad compass radians
 * @param {number} bearingRad compass radians to home
 * @returns {number}
 */
export function homeArrowDeg(headingRad, bearingRad) {
  if (!fin(headingRad) || !fin(bearingRad)) return 0;
  let r = ((bearingRad - headingRad) * DEG) % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r + 0;
}

// ---- styles -------------------------------------------------------------------

const STATIC_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='192' height='192'>"
  + "<filter id='n' x='0' y='0'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='7' stitchTiles='stitch'/>"
  + "<feColorMatrix type='saturate' values='0'/></filter>"
  + "<rect width='192' height='192' filter='url(#n)'/></svg>";
const STATIC_URI = `url("data:image/svg+xml,${encodeURIComponent(STATIC_SVG)}")`;

const TAPE_PX_PER_DEG = 4;
const TAPE_W = 360; // 90° visible
const TAPE_HALF = TAPE_W / 2;
const TAPE_FROM_DEG = -180; // the strip spans −180°..540°, so any 90° window around [0, 360) is seamless
const TAPE_TO_DEG = 540;
const TAPE_STRIP_W = (TAPE_TO_DEG - TAPE_FROM_DEG) * TAPE_PX_PER_DEG;
const HORIZON_PX_PER_DEG = 4;
const HOME_MAX_PX = TAPE_HALF - 10;
const CHEAT_FADE_SEC = 0.6;

const OSD_CSS = [
  "#hb-drone-osd, #hb-drone-osd * { pointer-events: none !important; box-sizing: border-box; }",
  "#hb-drone-osd { position: fixed; left: 0; top: 0; width: calc(100 * var(--hb-hud-vw, 1vw)); height: calc(100 * var(--hb-hud-vh, 1vh));",
  "  z-index: 30; overflow: hidden; user-select: none; color: #eef6e8;",
  "  font: 600 13px/1.3 ui-monospace, Consolas, Menlo, monospace; letter-spacing: 0.04em;",
  "  text-shadow: 0 0 2px #000, 0 1px 1px #000, 0 0 4px rgba(0, 0, 0, 0.6); }",
  // 'off' must beat DRONE_CLEAN_KEEP_CSS (specificity 1,1,1) while H is on.
  "#hb-drone-osd[data-mode=\"off\"], html.film-clean #hb-drone-osd[data-mode=\"off\"] { display: none !important; }",
  "#hb-drone-osd [hidden] { display: none !important; }",
  // Oversized by one tile and jittered by transform: compositor-only, no full-screen repaint.
  ".dosd-static { position: absolute; left: -192px; top: -192px; right: -192px; bottom: -192px; opacity: 0;",
  `  background-image: ${STATIC_URI}; background-size: 192px 192px; will-change: transform, opacity; }`,
  ".dosd-static[data-on=\"1\"] { animation: dosd-static-jitter 0.32s steps(1, end) infinite; }",
  "@keyframes dosd-static-jitter { 0% { transform: translate(0, 0); } 25% { transform: translate(-67px, 41px); }",
  "  50% { transform: translate(29px, -83px); } 75% { transform: translate(-101px, -17px); } }",
  ".dosd-vignette { position: absolute; left: 0; top: 0; right: 0; bottom: 0;",
  "  background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0) 56%, rgba(0, 0, 0, 0.42) 82%, rgba(0, 0, 0, 0.72) 100%); }",
  // The client HUD stays up in the goggles (vitals top-left — the orb panes end at ≈ 127 HUD px,
  // the classic bars at ≈ 169 —, radar top-right, chat bottom-left, toolbar bottom-centre from
  // ≈ 606, all z ≥ 48 over this z 30 layer). In HUD px (the HUD space is ≈ 1280 × 720 at 16:9)
  // the readouts form an inner instrument row just below the vitals, and the heading tape sits
  // at the bottom under the cheat sheet (PLAN §6.6); with H (clean) the readouts move out to the
  // classic FPV corners and the tape down to the edge. The right block never comes closer than 310 HUD px to
  // the right edge, so an open main panel (right 8, width 300) cannot cover it on narrower (16:10) HUD spaces;
  // at 16:9 the two terms are equal.
  ".dosd-tl { position: absolute; left: calc(50% - 330px); top: 190px; }",
  ".dosd-tr { position: absolute; right: max(calc(50% - 330px), 310px); top: 190px; text-align: right; }",
  "html.film-clean #hb-drone-osd > .dosd-tl { left: 22px; top: 16px; }",
  "html.film-clean #hb-drone-osd > .dosd-tr { right: 22px; top: 16px; }",
  "html.film-clean #hb-drone-osd > .dosd-tape { top: auto; bottom: 18px; }",
  "html.film-clean #hb-drone-osd > .dosd-cheat { bottom: 100px; }",
  ".dosd-row { display: block; white-space: nowrap; margin-top: 2px; }",
  ".dosd-k { opacity: 0.68; font-size: 11px; margin-right: 0.5em; }",
  ".dosd-tr .dosd-k { margin-right: 0; margin-left: 0.5em; }",
  ".dosd-mode { display: inline-block; padding: 1px 7px; margin-bottom: 4px; border: 1px solid rgba(238, 246, 232, 0.75); }",
  ".dosd-batt[data-warn=\"1\"] { color: #ff6a4a; }",
  ".dosd-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 13px; vertical-align: -1px; }",
  ".dosd-bar { display: inline-block; width: 4px; background: rgba(238, 246, 232, 0.22); box-shadow: 0 0 1px #000; }",
  ".dosd-bar[data-on=\"1\"] { background: #eef6e8; }",
  ".dosd-center { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }",
  ".dosd-crosshair { position: absolute; left: -15px; top: -15px; width: 30px; height: 30px; }",
  ".dosd-ch { position: absolute; background: #eef6e8; box-shadow: 0 0 2px #000; }",
  ".dosd-ch-l { left: 0; top: 14px; width: 10px; height: 2px; } .dosd-ch-r { right: 0; top: 14px; width: 10px; height: 2px; }",
  ".dosd-ch-t { left: 14px; top: 0; width: 2px; height: 10px; } .dosd-ch-b { left: 14px; bottom: 0; width: 2px; height: 10px; }",
  ".dosd-horizon { position: absolute; left: -130px; top: 0; width: 260px; height: 0; will-change: transform; }",
  ".dosd-horizon-line { position: absolute; left: 0; top: -1px; width: 260px; height: 2px; will-change: transform;",
  "  background: linear-gradient(90deg, #eef6e8 0 36%, transparent 36% 64%, #eef6e8 64% 100%); box-shadow: 0 0 2px #000; }",
  ".dosd-craft { position: absolute; left: -22px; top: -1px; width: 44px; height: 2px; background: #f3d27a; box-shadow: 0 0 2px #000; }",
  ".dosd-tape { position: absolute; left: 50%; top: auto; bottom: 150px; width: 360px; height: 66px; margin-left: -180px; }",
  ".dosd-tape-win { position: absolute; left: 0; top: 20px; width: 360px; height: 30px; overflow: hidden;",
  "  border-top: 1px solid rgba(238, 246, 232, 0.35);",
  "  -webkit-mask-image: linear-gradient(90deg, transparent, #000 16%, #000 84%, transparent);",
  "  mask-image: linear-gradient(90deg, transparent, #000 16%, #000 84%, transparent); }",
  `.dosd-tape-strip { position: absolute; left: 0; top: 0; width: ${TAPE_STRIP_W}px; height: 30px; will-change: transform; }`,
  ".dosd-tick { position: absolute; top: 0; width: 0; height: 7px; border-left: 1px solid rgba(238, 246, 232, 0.6); }",
  ".dosd-tick[data-major=\"1\"] { height: 11px; border-left-color: #eef6e8; }",
  ".dosd-tick-label { position: absolute; top: 12px; left: -14px; width: 28px; text-align: center; font-size: 11px; }",
  ".dosd-tape-caret { position: absolute; left: 179px; top: 20px; width: 2px; height: 14px; background: #f3d27a; }",
  ".dosd-heading { position: absolute; left: 50%; top: 0; transform: translateX(-50%); padding: 0 6px;",
  "  border: 1px solid rgba(238, 246, 232, 0.6); background: rgba(0, 0, 0, 0.25); }",
  ".dosd-home { position: absolute; left: 180px; top: 51px; width: 0; height: 0; }",
  ".dosd-home-glyph { position: absolute; left: -14px; top: 0; width: 28px; text-align: center; color: #8fe3ff; font-size: 12px; }",
  ".dosd-banner { position: absolute; left: 0; right: 0; top: 30%; text-align: center; }",
  // Pilot view frames the pilot at the centre: its banner goes below the feet, above the toolbar.
  "#hb-drone-osd[data-mode=\"pilot\"] > .dosd-banner { top: auto; bottom: 24%; }",
  ".dosd-b { display: table; margin: 0 auto 6px; padding: 3px 14px; font-size: 15px; letter-spacing: 0.14em;",
  "  border: 1px solid currentColor; background: rgba(0, 0, 0, 0.35); }",
  ".dosd-b[data-banner=\"crash\"] { color: #ff5a3c; font-size: 28px; letter-spacing: 0.3em; }",
  ".dosd-b[data-banner=\"rangeLimit\"], .dosd-b[data-banner=\"lowBattery\"] { color: #ffb347; animation: dosd-blink 1s steps(2, start) infinite; }",
  ".dosd-b[data-banner=\"returning\"] { color: #8fe3ff; }",
  ".dosd-b[data-banner=\"pilot\"] { color: #f3d27a; }",
  ".dosd-b[data-banner=\"acroHint\"] { color: #f3d27a; font-size: 13px; }",
  "@keyframes dosd-blink { 0% { opacity: 1; } 100% { opacity: 0.35; } }",
  ".dosd-cheat { position: absolute; left: 50%; bottom: 240px; transform: translateX(-50%); max-width: 660px;",
  "  padding: 8px 12px; font-size: 12px; line-height: 1.5; background: rgba(8, 10, 14, 0.62);",
  "  border: 1px solid rgba(217, 180, 90, 0.6); opacity: 1; transition: opacity 0.6s linear; }",
  ".dosd-cheat[data-fade=\"1\"] { opacity: 0; }",
  ".dosd-cheat-line { display: block; white-space: nowrap; }",
  ".dosd-fade { position: absolute; left: 0; top: 0; right: 0; bottom: 0; background: #000; opacity: 0; display: none; }",
  // Mode visibility (JS also sets [hidden] on the banners and the reticles).
  "#hb-drone-osd[data-mode=\"pilot\"] > :not(.dosd-banner) { display: none !important; }",
  "#hb-drone-osd[data-mode=\"crash\"] > :not(.dosd-banner):not(.dosd-static):not(.dosd-vignette) { display: none !important; }",
  "#hb-drone-osd:not([data-mode=\"fpv\"]) > .dosd-cheat { display: none !important; }",
  "#hb-drone-osd[data-mode=\"boot\"] > .dosd-static { display: none !important; }",
  // The goggle cut: black in the first half (the driver switches the camera at the midpoint),
  // wiped away top-down in the second while the readouts boot in. Two identical keyframe
  // names alternate (data-boot a / b) so a second boot restarts the animation.
  "#hb-drone-osd[data-mode=\"boot\"] > .dosd-fade { display: block; }",
  "#hb-drone-osd[data-mode=\"boot\"][data-boot=\"a\"] > .dosd-fade { animation: dosd-boot-a var(--dosd-boot, 0.35s) linear both; }",
  "#hb-drone-osd[data-mode=\"boot\"][data-boot=\"b\"] > .dosd-fade { animation: dosd-boot-b var(--dosd-boot, 0.35s) linear both; }",
  "#hb-drone-osd[data-mode=\"boot\"][data-boot=\"a\"] > :not(.dosd-fade) { animation: dosd-in-a var(--dosd-boot, 0.35s) linear both; }",
  "#hb-drone-osd[data-mode=\"boot\"][data-boot=\"b\"] > :not(.dosd-fade) { animation: dosd-in-b var(--dosd-boot, 0.35s) linear both; }",
  "@keyframes dosd-boot-a { 0% { opacity: 0; clip-path: inset(0 0 0 0); } 50% { opacity: 1; clip-path: inset(0 0 0 0); }",
  "  100% { opacity: 1; clip-path: inset(100% 0 0 0); } }",
  "@keyframes dosd-boot-b { 0% { opacity: 0; clip-path: inset(0 0 0 0); } 50% { opacity: 1; clip-path: inset(0 0 0 0); }",
  "  100% { opacity: 1; clip-path: inset(100% 0 0 0); } }",
  "@keyframes dosd-in-a { 0%, 50% { opacity: 0; } 100% { opacity: 1; } }",
  "@keyframes dosd-in-b { 0%, 50% { opacity: 0; } 100% { opacity: 1; } }",
].join("\n");

const BANNERS = Object.freeze([
  ["rangeLimit", "RANGE LIMIT"],
  ["lowBattery", "LOW BATTERY"],
  ["returning", "RETURNING"],
  ["crash", "CRASH"],
  ["pilot", "PILOT VIEW · Tab / View: goggles"],
  ["acroHint", "ACRO: gamepad recommended"],
]);

const CHEAT_LINES = Object.freeze([
  "W / S forward · A / D strafe · Q / E yaw · Space / C up / down",
  "Shift boost · click: mouse look (Esc frees it) · wheel: field of view",
  "M mode · Tab pilot view · H hide HUD · R return home · Shift+F11 recall",
  "Pad: sticks fly · LT / RT gimbal · RB boost · Y mode · View pilot · A home · hold B recall",
]);

// Static opacity in 0.01 steps (staticOpacity ≤ 0.85): cached strings, no per-frame building.
const OPACITY_STR = Object.freeze(Array.from({ length: 101 }, (_, i) => String(i / 100)));

/**
 * Create the OSD (SPEC §3.6). The DOM is built on the first `show` other than
 * `'off'`.
 *
 * @param {{document?: object|null, window?: object|null, clock?: () => number}} [deps]
 *   `document` is required for the DOM (absent → every method is a no-op
 *   returning false); `clock` (seconds; default `performance.now() / 1000`)
 *   times the cheat-sheet fade, which `frame` calls drive.
 * @returns {{
 *   show: (mode: string, opts?: {durationSec?: number}) => boolean,
 *   update: (view: object) => (boolean|void),
 *   frame: (f: {headingRad: number, rollRad: number, pitchRad: number}) => (boolean|void),
 *   staticLevel: (signal: number) => (number|false),
 *   cheatSheet: (show: boolean, opts?: {durationSec?: number}) => boolean,
 *   clean: (on: boolean) => boolean,
 *   dispose: () => void,
 *   readonly mode: string, readonly built: boolean}}
 */
export function createOsd(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const doc = d.document && typeof d.document === "object" ? d.document : null;
  const win = d.window && typeof d.window === "object" ? d.window : null;
  const clock = typeof d.clock === "function"
    ? d.clock
    : () => {
      const p = (win && win.performance) || (typeof performance !== "undefined" ? performance : null);
      return p && typeof p.now === "function" ? p.now() / 1000 : 0;
    };

  let disposed = false;
  let built = false;
  let mode = "off";
  let bootFlip = false;
  let cleanOn = false;
  /** @type {any} */ let root = null;
  /** @type {any} */ let style = null;
  const E = {}; // element refs
  const bannerEls = {};
  const barEls = [];

  // Latest raw view (copied; index.js reuses its object) and what is on screen.
  const cur = {
    mode: null, battery: null, timerSec: null, signal: null, distHomeM: null, aglM: null, speedMps: null,
    headingRad: null, homeBearingRad: null, reticle: null,
    rangeLimit: false, lowBattery: false, returning: false, returningSec: null, crash: false, acroHint: false,
  };
  const shown = { mode: "", batt: "", warn: "", timer: "", bars: -1, dist: "", agl: "", speed: "", heading: "", homeKey: NaN, homeGlyph: "", homeVisible: null, reticle: "", returning: "" };
  let staticSignal = 1;
  let staticKey = -1;
  let tapeKey = NaN;
  let rollKey = NaN;
  let pitchKey = NaN;
  const txCache = new Map();
  const rotCache = new Map();
  const tyCache = new Map();
  const translateX = (px) => {
    let s = txCache.get(px);
    if (s === undefined) { s = `translateX(${px}px)`; txCache.set(px, s); }
    return s;
  };
  const rotate = (halfDeg) => {
    let s = rotCache.get(halfDeg);
    if (s === undefined) { s = `rotate(${halfDeg / 2}deg)`; rotCache.set(halfDeg, s); }
    return s;
  };
  const translateY = (px) => {
    let s = tyCache.get(px);
    if (s === undefined) { s = `translateY(${px}px)`; tyCache.set(px, s); }
    return s;
  };

  let cheatOn = false;
  let cheatFadeAt = 0;
  let cheatHideAt = 0;
  let cheatFading = false;

  function mk(tag, cls, parent, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (e.style) e.style.pointerEvents = "none";
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function row(parent, key, cls, rightAligned) {
    const r = mk("div", "dosd-row", parent);
    if (!rightAligned) mk("span", "dosd-k", r, key);
    const v = mk("span", cls, r, NO_VALUE);
    if (rightAligned) mk("span", "dosd-k", r, key);
    return v;
  }

  function build() {
    if (built || disposed || !doc) return built;
    const head = doc.head || doc.documentElement || doc.body;
    const body = doc.body || doc.documentElement;
    if (!head || !body || typeof doc.createElement !== "function") return false;
    try {
      style = doc.getElementById ? doc.getElementById(OSD_STYLE_ID) : null;
      if (!style) {
        style = doc.createElement("style");
        style.id = OSD_STYLE_ID;
        style.textContent = OSD_CSS;
        head.appendChild(style);
      }
      root = mk("div", null, null);
      root.id = OSD_ID;
      root.setAttribute("data-mode", "off");
      root.setAttribute("aria-hidden", "true");
      const st = root.style;
      st.position = "fixed";
      st.left = "0";
      st.top = "0";
      st.width = "calc(100 * var(--hb-hud-vw, 1vw))";
      st.height = "calc(100 * var(--hb-hud-vh, 1vh))";

      E.static = mk("div", "dosd-static", root);
      E.vignette = mk("div", "dosd-vignette", root);

      E.tl = mk("div", "dosd-tl", root);
      const modeRow = mk("div", "dosd-row", E.tl);
      E.mode = mk("span", "dosd-mode", modeRow, NO_VALUE);
      E.batt = row(E.tl, "BAT", "dosd-batt", false);
      E.timer = row(E.tl, "TIME", "dosd-timer", false);

      E.tr = mk("div", "dosd-tr", root);
      const sigRow = mk("div", "dosd-row", E.tr);
      E.bars = mk("span", "dosd-bars", sigRow);
      for (let i = 0; i < 5; i++) {
        const b = mk("span", "dosd-bar", E.bars);
        b.style.height = `${4 + i * 2}px`;
        b.setAttribute("data-on", "0");
        barEls.push(b);
      }
      mk("span", "dosd-k", sigRow, "SIG");
      E.dist = row(E.tr, "HOME", "dosd-dist", true);
      E.agl = row(E.tr, "AGL", "dosd-agl", true);
      E.speed = row(E.tr, "SPD", "dosd-speed", true);

      E.center = mk("div", "dosd-center", root);
      E.crosshair = mk("div", "dosd-crosshair", E.center);
      E.crosshair.setAttribute("data-reticle", "crosshair");
      for (const c of ["dosd-ch dosd-ch-l", "dosd-ch dosd-ch-r", "dosd-ch dosd-ch-t", "dosd-ch dosd-ch-b"]) mk("span", c, E.crosshair);
      E.horizon = mk("div", "dosd-horizon", E.center);
      E.horizon.setAttribute("data-reticle", "horizon");
      E.horizonLine = mk("div", "dosd-horizon-line", E.horizon);
      mk("div", "dosd-craft", E.horizon);
      E.horizon.hidden = true;

      E.tape = mk("div", "dosd-tape", root);
      E.heading = mk("span", "dosd-heading", E.tape, NO_VALUE);
      E.tapeWin = mk("div", "dosd-tape-win", E.tape);
      E.strip = mk("div", "dosd-tape-strip", E.tapeWin);
      for (let deg = TAPE_FROM_DEG; deg <= TAPE_TO_DEG; deg += 15) {
        const t = mk("span", "dosd-tick", E.strip);
        t.style.left = `${(deg - TAPE_FROM_DEG) * TAPE_PX_PER_DEG}px`;
        if (deg % 45 === 0) {
          t.setAttribute("data-major", "1");
          mk("span", "dosd-tick-label", t, COMPASS_8[(((deg / 45) % 8) + 8) % 8]);
        }
      }
      mk("span", "dosd-tape-caret", E.tape);
      E.home = mk("div", "dosd-home", E.tape);
      E.homeGlyph = mk("span", "dosd-home-glyph", E.home, "H");
      E.home.hidden = true;

      E.banner = mk("div", "dosd-banner", root);
      for (const [key, text] of BANNERS) {
        const b = mk("span", "dosd-b", E.banner, text);
        b.setAttribute("data-banner", key);
        b.hidden = true;
        bannerEls[key] = b;
      }

      E.cheat = mk("div", "dosd-cheat", root);
      for (const line of CHEAT_LINES) mk("span", "dosd-cheat-line", E.cheat, line);
      E.cheat.hidden = true;
      E.cheat.setAttribute("data-fade", "0");

      E.fade = mk("div", "dosd-fade", root);

      body.appendChild(root);
      built = true;
    } catch (_) {
      teardownDom();
      return false;
    }
    staticKey = -1;
    tapeKey = rollKey = pitchKey = NaN;
    applyStatic(staticOpacity(staticSignal));
    render();
    return true;
  }

  function teardownDom() {
    try { if (root && typeof root.remove === "function") root.remove(); else if (root && root.parentNode) root.parentNode.removeChild(root); } catch (_) {}
    try { if (style && typeof style.remove === "function") style.remove(); else if (style && style.parentNode) style.parentNode.removeChild(style); } catch (_) {}
    root = null;
    style = null;
    built = false;
    for (const k of Object.keys(E)) delete E[k];
    for (const k of Object.keys(bannerEls)) delete bannerEls[k];
    barEls.length = 0;
  }

  const setText = (el, key, text) => {
    if (shown[key] === text) return;
    shown[key] = text;
    el.textContent = text;
  };
  const setHidden = (el, h) => {
    if (el && el.hidden !== h) el.hidden = h;
  };

  function applyBanners() {
    if (!built) return;
    const live = mode === "fpv" || mode === "boot";
    setHidden(bannerEls.rangeLimit, !(live && cur.rangeLimit));
    setHidden(bannerEls.lowBattery, !((live || mode === "pilot") && cur.lowBattery));
    setHidden(bannerEls.returning, !(live && cur.returning));
    setHidden(bannerEls.crash, !(mode === "crash" || (live && cur.crash)));
    setHidden(bannerEls.pilot, mode !== "pilot");
    setHidden(bannerEls.acroHint, !(live && cur.acroHint));
  }

  /** Write the 10 Hz readouts from `cur` (only what changed). */
  function render() {
    if (!built) return;
    setText(E.mode, "mode", modeLabel(cur.mode));
    setText(E.batt, "batt", formatPercent(cur.battery));
    const warn = cur.lowBattery ? "1" : "0";
    if (shown.warn !== warn) { shown.warn = warn; E.batt.setAttribute("data-warn", warn); }
    setText(E.timer, "timer", formatTimer(cur.timerSec));
    const bars = signalBars(cur.signal);
    if (shown.bars !== bars) {
      shown.bars = bars;
      for (let i = 0; i < barEls.length; i++) barEls[i].setAttribute("data-on", i < bars ? "1" : "0");
    }
    setText(E.dist, "dist", formatDistance(cur.distHomeM));
    setText(E.agl, "agl", formatAltitude(cur.aglM));
    setText(E.speed, "speed", formatSpeed(cur.speedMps));
    setText(E.heading, "heading", formatHeading(cur.headingRad));
    // Home arrow on the tape (relative bearing, pinned to the tape edges with an arrow).
    const homeOk = fin(cur.headingRad) && fin(cur.homeBearingRad) && !(fin(cur.distHomeM) && cur.distHomeM < 1);
    if (shown.homeVisible !== homeOk) { shown.homeVisible = homeOk; setHidden(E.home, !homeOk); }
    if (homeOk) {
      const rel = homeArrowDeg(cur.headingRad, cur.homeBearingRad);
      let px = Math.round(rel * TAPE_PX_PER_DEG);
      let glyph = "H";
      if (px > HOME_MAX_PX) { px = HOME_MAX_PX; glyph = "H▶"; } else if (px < -HOME_MAX_PX) { px = -HOME_MAX_PX; glyph = "◀H"; }
      if (shown.homeKey !== px) { shown.homeKey = px; E.home.style.transform = translateX(px); }
      setText(E.homeGlyph, "homeGlyph", glyph);
    }
    const ret = cur.reticle === "horizon" || cur.reticle === "crosshair"
      ? cur.reticle
      : (cur.mode === "angle" || cur.mode === "acro" ? "horizon" : "crosshair");
    if (shown.reticle !== ret) {
      shown.reticle = ret;
      setHidden(E.crosshair, ret !== "crosshair");
      setHidden(E.horizon, ret !== "horizon");
    }
    setText(bannerEls.returning, "returning", formatReturning(cur.returningSec));
    applyBanners();
  }

  function applyStatic(op) {
    if (!built) return;
    const key = Math.max(0, Math.min(100, Math.round(op * 100)));
    if (key === staticKey) return;
    const wasOn = staticKey > 0;
    staticKey = key;
    E.static.style.opacity = OPACITY_STR[key];
    if (wasOn !== key > 0) E.static.setAttribute("data-on", key > 0 ? "1" : "0");
  }

  function setRootMode(m) {
    mode = m;
    if (root) root.setAttribute("data-mode", m);
  }

  const durationOf = (opts, dflt, lo, hi) => {
    const v = opts && typeof opts === "object" ? opts.durationSec : undefined;
    return fin(v) && v > 0 ? Math.min(Math.max(v, lo), hi) : dflt;
  };

  // ---- members ---------------------------------------------------------------

  function show(m, opts) {
    if (!doc || disposed) return false;
    if (typeof m !== "string" || !OSD_MODES.includes(m)) return false;
    if (m === "off") {
      setRootMode("off");
      return true;
    }
    if (!build()) return false;
    if (m === "boot") {
      const dur = durationOf(opts, 0.35, 0.02, 5);
      bootFlip = !bootFlip;
      try { root.style.setProperty("--dosd-boot", `${dur}s`); } catch (_) {}
      root.setAttribute("data-boot", bootFlip ? "a" : "b");
    }
    setRootMode(m);
    applyStatic(m === "crash" ? 0.85 : staticOpacity(staticSignal));
    applyBanners();
    return true;
  }

  function update(view) {
    if (!doc || disposed) return false;
    if (!view || typeof view !== "object") return false;
    cur.mode = typeof view.mode === "string" ? view.mode : null;
    cur.battery = fin(view.battery) ? view.battery : null;
    cur.timerSec = fin(view.timerSec) ? view.timerSec : null;
    cur.signal = fin(view.signal) ? view.signal : null;
    cur.distHomeM = fin(view.distHomeM) ? view.distHomeM : null;
    cur.aglM = fin(view.aglM) ? view.aglM : null;
    cur.speedMps = fin(view.speedMps) ? view.speedMps : null;
    cur.headingRad = fin(view.headingRad) ? view.headingRad : null;
    cur.homeBearingRad = fin(view.homeBearingRad) ? view.homeBearingRad : null;
    cur.reticle = typeof view.reticle === "string" ? view.reticle : null;
    const b = view.banners && typeof view.banners === "object" ? view.banners : null;
    cur.rangeLimit = !!(b && b.rangeLimit === true);
    cur.lowBattery = !!(b && b.lowBattery === true);
    cur.returning = !!(b && b.returning === true);
    cur.returningSec = b && fin(b.returningSec) ? b.returningSec : null;
    cur.crash = !!(b && b.crash === true);
    cur.acroHint = !!(b && b.acroHint === true);
    if (!built) return true; // kept for the build
    render();
    return true;
  }

  function frame(f) {
    if (!doc || disposed || !built) return false;
    if (f && typeof f === "object") {
      const tx = Math.round(TAPE_HALF - (0 - TAPE_FROM_DEG) * TAPE_PX_PER_DEG + headingTapeOffsetPx(f.headingRad, TAPE_PX_PER_DEG)) + 0;
      if (tx !== tapeKey) { tapeKey = tx; E.strip.style.transform = translateX(tx); }
      // Bank right (+roll) turns the horizon counter-clockwise; nose down (−pitch) lifts it.
      let rollDeg = fin(f.rollRad) ? (f.rollRad * DEG) % 360 : 0;
      if (rollDeg > 180) rollDeg -= 360; else if (rollDeg <= -180) rollDeg += 360;
      const rk = Math.round(-rollDeg * 2) + 0;
      if (rk !== rollKey) { rollKey = rk; E.horizon.style.transform = rotate(rk); }
      const pDeg = fin(f.pitchRad) ? Math.max(-90, Math.min(90, f.pitchRad * DEG)) : 0;
      const pk = Math.round(pDeg * HORIZON_PX_PER_DEG) + 0;
      if (pk !== pitchKey) { pitchKey = pk; E.horizonLine.style.transform = translateY(pk); }
    }
    if (cheatOn) {
      const t = clock();
      if (!cheatFading && t >= cheatFadeAt) {
        cheatFading = true;
        E.cheat.setAttribute("data-fade", "1");
      }
      if (t >= cheatHideAt) {
        cheatOn = false;
        setHidden(E.cheat, true);
      }
    }
    return true;
  }

  function staticLevel(signal) {
    if (!doc || disposed) return false;
    staticSignal = fin(signal) ? signal : 1;
    const op = mode === "crash" ? 0.85 : staticOpacity(signal);
    applyStatic(op);
    return op;
  }

  function cheatSheet(on, opts) {
    if (!doc || disposed) return false;
    if (on !== true) {
      cheatOn = false;
      if (built) setHidden(E.cheat, true);
      return false;
    }
    if (!build()) return false;
    const dur = durationOf(opts, 5, 0.1, 120);
    const t = clock();
    cheatOn = true;
    cheatFading = false;
    cheatFadeAt = t + dur;
    cheatHideAt = t + dur + CHEAT_FADE_SEC;
    E.cheat.setAttribute("data-fade", "0");
    setHidden(E.cheat, false);
    return true;
  }

  function clean(on) {
    if (!doc || disposed) return false;
    try {
      if (on === true) {
        let st = doc.getElementById ? doc.getElementById(DRONE_CLEAN_STYLE_ID) : null;
        if (!st) {
          st = doc.createElement("style");
          st.id = DRONE_CLEAN_STYLE_ID;
          st.textContent = `${FILM_CLEAN_CSS} ${DRONE_CLEAN_KEEP_CSS}`;
          const parent = doc.head || doc.documentElement || doc.body;
          parent.appendChild(st);
        }
        const cl = doc.documentElement && doc.documentElement.classList;
        if (cl && typeof cl.add === "function") cl.add(FILM_CLEAN_CLASS);
        cleanOn = true;
        return true;
      }
      const st = doc.getElementById ? doc.getElementById(DRONE_CLEAN_STYLE_ID) : null;
      if (st) {
        if (typeof st.remove === "function") st.remove();
        else if (st.parentNode) st.parentNode.removeChild(st);
      }
      // Film's own clean frame keeps the class while its stylesheet is up.
      const filmStyle = doc.getElementById ? doc.getElementById(FILM_CLEAN_STYLE_ID) : null;
      const cl = doc.documentElement && doc.documentElement.classList;
      if (!filmStyle && cl && typeof cl.remove === "function") cl.remove(FILM_CLEAN_CLASS);
    } catch (_) {
      /* a broken document: report off */
    }
    cleanOn = false;
    return false;
  }

  function dispose() {
    if (disposed) return;
    if (doc) {
      let ours = null;
      try { ours = doc.getElementById ? doc.getElementById(DRONE_CLEAN_STYLE_ID) : null; } catch (_) { ours = null; }
      if (cleanOn || ours) clean(false);
    }
    cheatOn = false;
    teardownDom();
    txCache.clear();
    rotCache.clear();
    tyCache.clear();
    disposed = true;
  }

  return {
    show,
    update,
    frame,
    staticLevel,
    cheatSheet,
    clean,
    dispose,
    get mode() {
      return mode;
    },
    get built() {
      return built;
    },
  };
}
