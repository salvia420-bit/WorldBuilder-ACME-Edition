// scene3d/film/core/units.js — AC world units, cell ids, map coords and admin teleports (SPEC §1, §2.8).
//
// WHY: the director plans in map coordinates ("42.1N 33.6E"), the gazetteer
// stores cell ids + landblock-local metres, the camera flies in AC global
// metres, and the streaming dolly moves by ACE admin chat commands. One exact,
// tested conversion table keeps those frames from drifting apart (the classic
// bugs: signed landblock keys for x ≥ 0x80, a 0.45° map-origin error, the
// wrong quaternion sign for @teleloc headings, outdoor cell index 0).
//
//   world  x = lbX·192 + localX (east), y = lbY·192 + localY (north), z absolute
//   id     0xXXYYcccc, lbKey = (id & 0xFFFF0000) >>> 0 (ALWAYS unsigned)
//   cell   outdoor 1 + floor(lx/24)·8 + floor(ly/24); EnvCell 0x0100..0xFFFD
//   map    ew = wx/240 − 101.95, ns = wy/240 − 101.95 (E/N positive)
//   quat   @teleloc heading: qw = cos(θ/2), qz = −sin(θ/2), θ compass (CW from north)
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks.

import { FilmError, FILM_ERROR_CODES } from "./errors.js";

/** Landblock edge length in metres. */
export const LB_SIZE = 192;
/** Outdoor land-cell edge length in metres (8×8 cells per landblock). */
export const CELL_SIZE = 24;
/** Metres per map-coordinate degree (ACE Position.cs). */
export const METRES_PER_MAP_UNIT = 240;
/** Map-coordinate offset: map = world/240 − 101.95. */
export const MAP_ORIGIN = 101.95;
/** Decimals used by telelocCmd for x y z (centimetre precision). */
export const TELELOC_POS_DECIMALS = 2;
/** Decimals used by telelocCmd for qw qx qy qz. */
export const TELELOC_QUAT_DECIMALS = 4;
/** Decimals used by teleMapCmd for the ns/ew values. */
export const TELE_MAP_DECIMALS = 2;

const TWO32 = 4294967296;

/**
 * Parse a landblock / cell id: a uint32 number (negative int32 values are
 * reinterpreted unsigned, e.g. `0xA9B4001C | 0`), or a hex string with or
 * without `0x` ("0xA9B4001C", "a9b4001c"). Throws FilmError BAD_CELL_ID on
 * anything else.
 * @param {number|string} id
 * @returns {number} uint32
 */
export function parseCellId(id) {
  if (typeof id === "number") {
    if (Number.isInteger(id) && id >= -2147483648 && id < TWO32) return id >>> 0;
  } else if (typeof id === "string") {
    const m = /^\s*(?:0x)?([0-9a-fA-F]{1,8})\s*$/.exec(id);
    if (m) return parseInt(m[1], 16) >>> 0;
  }
  throw new FilmError(`not a landblock/cell id: ${JSON.stringify(id)} (expected a uint32 or a hex string like "0xA9B4001C")`,
    FILM_ERROR_CODES.BAD_CELL_ID);
}

/**
 * Landblock key of a cell id: `(id & 0xFFFF0000) >>> 0` — ALWAYS unsigned
 * (0xA9B4001C → 0xA9B40000 = 2847145984, never negative).
 * @param {number|string} id
 * @returns {number} uint32
 */
export function lbKeyOf(id) {
  return (parseCellId(id) & 0xffff0000) >>> 0;
}

/**
 * Landblock key from the 16-bit landblock word used by spawn rows and
 * `@teledungeon` (0xA9B4 → 0xA9B40000).
 * @param {number|string} word 0..0xFFFF (hex string allowed)
 * @returns {number} uint32
 */
export function lbKeyFromWord(word) {
  const w = parseCellId(word);
  if (w > 0xffff) {
    throw new FilmError(`landblock word out of range: ${hex32(w)} (expected 0x0000..0xFFFF)`, FILM_ERROR_CODES.BAD_CELL_ID);
  }
  return (w << 16) >>> 0;
}

/**
 * Landblock grid coordinates of an id: `[lbX, lbY]` (each 0..255). The array
 * also carries `.x` / `.y` properties, so both `const [x, y] = lbXY(id)` and
 * `const {x, y} = lbXY(id)` work.
 * @param {number|string} id
 * @returns {number[] & {x:number, y:number}}
 */
export function lbXY(id) {
  const u = parseCellId(id);
  const x = (u >>> 24) & 0xff;
  const y = (u >>> 16) & 0xff;
  const out = /** @type {number[] & {x:number, y:number}} */ ([x, y]);
  out.x = x;
  out.y = y;
  return out;
}

/**
 * True for an indoor EnvCell id (low word 0x0100..0xFFFD). Outdoor land cells
 * are 0x0001..0x0040; 0xFFFE / 0xFFFF are the landblock-info / landblock
 * sentinels (e.g. "portal leads outdoors" = lb|0xFFFF), not cells.
 * @param {number|string} id
 * @returns {boolean}
 */
export function isIndoorCell(id) {
  const lo = parseCellId(id) & 0xffff;
  return lo >= 0x0100 && lo <= 0xfffd;
}

/** Throw unless every value is a finite number. */
function finiteArgs(fn, names, values) {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new FilmError(`${fn}: ${names[i]} must be a finite number (got ${values[i]})`, FILM_ERROR_CODES.BAD_ARGUMENT);
    }
  }
}

/**
 * Landblock-local metres → AC global metres. The landblock comes from the id
 * (never from xy: dungeon cells may sit far outside their landblock square).
 * `lz` is absolute height and passes through (missing → 0).
 * @param {number|string} cellOrLbId full cell id or lbKey (0xXXYYcccc)
 * @param {number} lx @param {number} ly @param {number} [lz=0]
 * @returns {number[]} `[wx, wy, z]`
 */
export function worldFromLocal(cellOrLbId, lx, ly, lz = 0) {
  const [x, y] = lbXY(cellOrLbId);
  const z = lz === undefined || lz === null ? 0 : lz;
  finiteArgs("worldFromLocal", ["lx", "ly", "lz"], [lx, ly, z]);
  return [x * LB_SIZE + lx, y * LB_SIZE + ly, z];
}

/**
 * Outdoor cell index (1..64) for landblock-local metres, clamped to the 8×8 grid.
 * @param {number} lx @param {number} ly
 * @returns {number}
 */
export function outdoorCellIndex(lx, ly) {
  const cx = Math.min(7, Math.max(0, Math.floor(lx / CELL_SIZE)));
  const cy = Math.min(7, Math.max(0, Math.floor(ly / CELL_SIZE)));
  return 1 + cx * 8 + cy;
}

/**
 * AC global metres → the OUTDOOR cell containing (wx, wy). The landblock is
 * clamped to the 256×256 grid (so lx/ly fall outside [0, 192) only off-map).
 * @param {number} wx @param {number} wy @param {number} [z=0]
 * @returns {{cellId:number, lbKey:number, lx:number, ly:number, z:number}}
 */
export function localFromWorld(wx, wy, z = 0) {
  const zz = z === undefined || z === null ? 0 : z;
  finiteArgs("localFromWorld", ["wx", "wy", "z"], [wx, wy, zz]);
  const lbX = Math.max(0, Math.min(255, Math.floor(wx / LB_SIZE)));
  const lbY = Math.max(0, Math.min(255, Math.floor(wy / LB_SIZE)));
  const lx = wx - lbX * LB_SIZE;
  const ly = wy - lbY * LB_SIZE;
  const lbKey = ((lbX << 24) | (lbY << 16)) >>> 0;
  const cellId = (lbKey | outdoorCellIndex(lx, ly)) >>> 0;
  return { cellId, lbKey, lx, ly, z: zz };
}

/**
 * Landblock key containing world point (wx, wy) (grid-clamped).
 * @param {number} wx @param {number} wy
 * @returns {number} uint32
 */
export function landblockOfWorld(wx, wy) {
  return localFromWorld(wx, wy, 0).lbKey;
}

/**
 * AC global metres → map coordinates (E/N positive). Same as ACE @loc / the map panel.
 * @param {number} wx @param {number} wy
 * @returns {{ns:number, ew:number}}
 */
export function worldToMap(wx, wy) {
  finiteArgs("worldToMap", ["wx", "wy"], [wx, wy]);
  return { ns: wy / METRES_PER_MAP_UNIT - MAP_ORIGIN, ew: wx / METRES_PER_MAP_UNIT - MAP_ORIGIN };
}

/**
 * Map coordinates → AC global metres. NOTE the argument order is NS first
 * (like `@tele 42.1N 33.6E`) but the result is `[wx, wy]` (x first).
 * @param {number} ns north positive @param {number} ew east positive
 * @returns {number[]} `[wx, wy]`
 */
export function mapToWorld(ns, ew) {
  finiteArgs("mapToWorld", ["ns", "ew"], [ns, ew]);
  return [(ew + MAP_ORIGIN) * METRES_PER_MAP_UNIT, (ns + MAP_ORIGIN) * METRES_PER_MAP_UNIT];
}

/**
 * Fixed-decimal string without "-0.00" artefacts (values that round to zero print unsigned).
 * @param {number} v @param {number} d
 * @returns {string}
 */
function fixed(v, d) {
  const s = v.toFixed(d);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

/**
 * One map axis "42.1N": magnitude with `decimals`, suffix from the sign of the
 * ROUNDED value (a value that rounds to zero gets the positive suffix).
 */
function axis(v, decimals, pos, neg) {
  const mag = fixed(Math.abs(v), decimals);
  const rounded = Number(fixed(v, decimals));
  return `${mag}${rounded < 0 ? neg : pos}`;
}

/**
 * Human map string, NS first, retail style: `formatMap(42.1, 33.6)` →
 * "42.1N, 33.6E" (1 decimal by default, S/W for negatives).
 * @param {number} ns @param {number} ew @param {number} [decimals=1] 0..6
 * @returns {string}
 */
export function formatMap(ns, ew, decimals = 1) {
  finiteArgs("formatMap", ["ns", "ew"], [ns, ew]);
  const d = Math.max(0, Math.min(6, Math.round(Number.isFinite(decimals) ? decimals : 1)));
  return `${axis(ns, d, "N", "S")}, ${axis(ew, d, "E", "W")}`;
}

/**
 * `0x` + 8 upper-case hex digits of the unsigned 32-bit value (0xA9B4001C).
 * @param {number} n integer (negative int32 values are reinterpreted unsigned)
 * @returns {string}
 */
export function hex32(n) {
  const u = parseCellId(n);
  return `0x${u.toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * @teleloc / ACE heading quaternion for a compass heading θ (radians, clockwise
 * from north): rotation about +z by −θ, i.e. `qw = cos(θ/2), qx = qy = 0,
 * qz = −sin(θ/2)`. θ is wrapped into (−π, π] first so qw ≥ 0; non-finite → identity.
 * @param {number} compassRad
 * @returns {{qw:number, qx:number, qy:number, qz:number}}
 */
export function headingQuat(compassRad) {
  if (!Number.isFinite(compassRad)) return { qw: 1, qx: 0, qy: 0, qz: 0 };
  let a = compassRad % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  else if (a > Math.PI) a -= 2 * Math.PI;
  return { qw: Math.cos(a / 2), qx: 0, qy: 0, qz: 0 - Math.sin(a / 2) }; // 0 − x: no −0 for θ = 0
}

/**
 * ACE admin exact teleport (Developer):
 * `@teleloc 0xA9B4001D 84.00 112.00 66.00 1.0000 0.0000 0.0000 0.0000`.
 * Format: cell as hex32; x y z with TELELOC_POS_DECIMALS (2) decimals; the
 * heading quaternion qw qx qy qz with TELELOC_QUAT_DECIMALS (4) decimals,
 * always emitted (identity = facing north when compassRad is omitted).
 *
 * OUTDOOR ids are canonicalised: the cell index is recomputed from (lx, ly)
 * (fixing spawn-row "cell 0" ids) and a point outside the landblock square is
 * re-homed to the landblock that contains it — ACE does no such correction and
 * a mismatched outdoor cell lands the character in the wrong place. INDOOR
 * (EnvCell) ids and their local coordinates are passed through unchanged.
 * @param {number|string} cellId
 * @param {number} lx landblock-local metres @param {number} ly @param {number} lz absolute height
 * @param {number} [compassRad] facing, radians clockwise from north
 * @returns {string}
 */
export function telelocCmd(cellId, lx, ly, lz, compassRad) {
  let id = parseCellId(cellId);
  finiteArgs("telelocCmd", ["lx", "ly", "lz"], [lx, ly, lz]);
  let x = lx, y = ly;
  const lo = id & 0xffff;
  if (!(lo >= 0x0100 && lo <= 0xfffd)) {
    const w = worldFromLocal(id, lx, ly, lz);
    const loc = localFromWorld(w[0], w[1], lz);
    id = loc.cellId;
    x = loc.lx;
    y = loc.ly;
  }
  const q = headingQuat(compassRad);
  const P = TELELOC_POS_DECIMALS, Q = TELELOC_QUAT_DECIMALS;
  return `@teleloc ${hex32(id)} ${fixed(x, P)} ${fixed(y, P)} ${fixed(lz, P)} ` +
    `${fixed(q.qw, Q)} ${fixed(q.qx, Q)} ${fixed(q.qy, Q)} ${fixed(q.qz, Q)}`;
}

/**
 * ACE map teleport (Advocate ≥ 5; the server snaps z to terrain/buildings):
 * `teleMapCmd(42.1, 33.6)` → "@tele 42.10N 33.60E" (NS first, TELE_MAP_DECIMALS decimals).
 * @param {number} ns @param {number} ew
 * @returns {string}
 */
export function teleMapCmd(ns, ew) {
  finiteArgs("teleMapCmd", ["ns", "ew"], [ns, ew]);
  return `@tele ${axis(ns, TELE_MAP_DECIMALS, "N", "S")} ${axis(ew, TELE_MAP_DECIMALS, "E", "W")}`;
}

/**
 * ACE named point-of-interest teleport: `telepoiCmd("Holtburg")` → "@telepoi Holtburg".
 * Whitespace is collapsed; empty names and control characters (which could
 * smuggle a second chat line) throw FilmError BAD_COMMAND.
 * @param {string} name
 * @returns {string}
 */
export function telepoiCmd(name) {
  if (typeof name !== "string") {
    throw new FilmError(`telepoiCmd: name must be a string (got ${typeof name})`, FILM_ERROR_CODES.BAD_COMMAND);
  }
  // Tabs are tolerated (collapsed below); every other control character is refused.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(name)) {
    throw new FilmError(`telepoiCmd: name contains control characters: ${JSON.stringify(name)}`, FILM_ERROR_CODES.BAD_COMMAND);
  }
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) throw new FilmError("telepoiCmd: empty point-of-interest name", FILM_ERROR_CODES.BAD_COMMAND);
  return `@telepoi ${clean}`;
}
