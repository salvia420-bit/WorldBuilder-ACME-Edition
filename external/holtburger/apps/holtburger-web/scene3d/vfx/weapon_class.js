// scene3d/vfx/weapon_class.js — the pure decisions behind the per-weapon
// effects (2026-10-10): which item glows in which colour, which weapons are
// flexible poles, the shaft frame, the spring that bends them, and a seeded
// RNG for the shine timing. No THREE, no DOM, no wasm — node-testable.
//
// Inputs are all static or client-derived: the item's UiEffects bitmask
// (PropertyInt 18, already on the wire in the ObjectCreate weenie header), its
// name, its mesh bounds, and its world pose each frame. Outputs are uniform
// values. Nothing here touches the wire, physics or a replicated field.

import { WFX_KIND } from "./weapon_fx_glsl.js";

// ---------------------------------------------------------------------------
// Glow (aura) by UiEffects bit
// ---------------------------------------------------------------------------

// Priority order: an item carrying an element shows the element even if it
// also carries the generic Magical bit. The physical damage types (Bludgeon
// 0x200, Slash 0x400, Pierce 0x800) get NO glow: in retail they only recolour
// the inventory icon's outline, and a white-ish glow on them is exactly the
// "every weapon looks white" complaint. Colours are linear RGB.
export const AURA_BY_BIT = Object.freeze([
  Object.freeze({ bit: 0x0020, element: "fire",      kind: WFX_KIND.fire,      color: [1.00, 0.45, 0.10] }),
  Object.freeze({ bit: 0x0040, element: "lightning", kind: WFX_KIND.lightning, color: [0.55, 0.72, 1.00] }),
  Object.freeze({ bit: 0x0080, element: "frost",     kind: WFX_KIND.frost,     color: [0.50, 0.82, 1.00] }),
  Object.freeze({ bit: 0x0100, element: "acid",      kind: WFX_KIND.acid,      color: [0.45, 1.00, 0.18] }),
  Object.freeze({ bit: 0x1000, element: "nether",    kind: WFX_KIND.nether,    color: [0.62, 0.18, 0.95] }),
  Object.freeze({ bit: 0x0001, element: "magic",     kind: WFX_KIND.magic,     color: [0.62, 0.46, 1.00] }),
  Object.freeze({ bit: 0x0002, element: "poison",    kind: WFX_KIND.magic,     color: [0.45, 0.95, 0.25] }),
  Object.freeze({ bit: 0x0004, element: "health",    kind: WFX_KIND.magic,     color: [1.00, 0.25, 0.22] }),
  Object.freeze({ bit: 0x0008, element: "mana",      kind: WFX_KIND.magic,     color: [0.30, 0.45, 1.00] }),
  Object.freeze({ bit: 0x0010, element: "stamina",   kind: WFX_KIND.magic,     color: [1.00, 0.82, 0.25] }),
]);

const AURA_BY_ELEMENT = Object.freeze(
  Object.fromEntries(AURA_BY_BIT.map((r) => [r.element, r])),
);

/** The glow row for an element name ("fire", "magic", ...) or null. */
export function auraForElement(element) {
  return (element && AURA_BY_ELEMENT[element]) || null;
}

/** The glow row for a UiEffects mask, or null (no bit / physical types only). */
export function auraForUiEffects(mask) {
  const m = mask >>> 0;
  if (!m) return null;
  for (const r of AURA_BY_BIT) if ((m & r.bit) !== 0) return r;
  return null;
}

// Weapon names that carry their element ("Flaming Spada", "Frost Pike").
// Order matters only between elements; weapons rarely carry two words.
const NAME_ELEMENT_RULES = [
  ["lightning", /lightning|electric|\bshock|thunder|\bstorm|voltaic/i],
  ["fire", /\bfire|flam(e|ing)|blaz|\bburn|inferno|magma|\blava|\bember|scorch|searing|smolder/i],
  ["frost", /frost|\bice\b|\bicy|\bcold\b|freez|glacial|\bchill/i],
  ["acid", /\bacid|corros|caustic|venom/i],
  ["nether", /nether|\bvoid\b/i],
];

/** Element word in a weapon name, or null. */
export function elementFromWeaponName(name) {
  if (typeof name !== "string" || !name) return null;
  for (const [el, rx] of NAME_ELEMENT_RULES) if (rx.test(name)) return el;
  return null;
}

/**
 * The element of a held/dropped item: UiEffects first (authoritative), then
 * the name. Returns the element string or null.
 */
export function weaponElement(uiEffects, name) {
  const row = auraForUiEffects(uiEffects);
  if (row) return row.element;
  return elementFromWeaponName(name);
}

// ---------------------------------------------------------------------------
// What is a weapon, what is a flexible pole
// ---------------------------------------------------------------------------

// Long-shafted weapons: the shaft may flex. Checked BEFORE the rigid list so a
// "Swordstaff" is a staff.
const POLE_RX = /spear|staff|stave|\bpike|lance|yari|trident|partizan|partisan|halberd|glaive|naginata|corsesca|budiaq|quarter ?staff|\bjo\b|nabut|bastone|\bbo\b|scythe|voulge|bardiche|ranseur|\bpole\b/i;
// Everything that must stay rigid: blades, heads on short hafts, casters, bows.
// (Ammo — arrows, quarrels, darts — is deliberately absent: a projectile is not
// a weapon-ish item, and entities.js skips projectiles before asking.)
const RIGID_RX = /sword|blade|sabre|sabra|scimitar|tachi|katana|kaskara|spada|rapier|dagger|knife|dirk|stiletto|\baxe|\bono\b|shou-ono|tofun|dolabra|hatchet|mace|hammer|club|morning ?star|cestus|nekode|katar|jitte|tetsubo|kasrullah|yaoji|flail|cleaver|machete|sickle|baton|wand|sceptre|scepter|\borb\b|shield|buckler|\bbow\b|longbow|yumi|crossbow|arbalest|atlatl|sling|claw|\bfist|knuckle/i;

/** Does the NAME read as a weapon (or shield) at all? */
export function nameLooksLikeWeapon(name) {
  return typeof name === "string" && !!name && (POLE_RX.test(name) || RIGID_RX.test(name));
}

/**
 * Flex class from the name and the mesh bounds (metres): "pole" or null.
 *  - a pole word and at least 1 m long ⇒ pole;
 *  - a rigid word ⇒ rigid (swords, maces, axes, daggers, bows, casters);
 *  - an unknown name ⇒ pole only when long AND thin (>= 1.3 m, cross-section
 *    <= 12 % of the length).
 * @param {{name?:string, length:number, width:number}} o
 */
export function flexClassFor({ name, length, width }) {
  if (!(length > 0)) return null;
  const n = typeof name === "string" ? name : "";
  if (n && POLE_RX.test(n)) return length >= 1.0 ? "pole" : null;
  if (n && RIGID_RX.test(n)) return null;
  if (length >= 1.3 && (width / length) <= 0.12) return "pole";
  return null;
}

// ---------------------------------------------------------------------------
// The shaft frame
// ---------------------------------------------------------------------------

/**
 * The long axis of a box: index (0 x, 1 y, 2 z) of the largest extent, its
 * length, and the second-largest extent (the cross-section "width").
 * @param {number[]} min @param {number[]} max
 */
export function longAxisOf(min, max) {
  const e = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let ax = 0;
  if (e[1] > e[ax]) ax = 1;
  if (e[2] > e[ax]) ax = 2;
  const others = [0, 1, 2].filter((i) => i !== ax).map((i) => e[i]);
  return { axis: ax, length: e[ax], width: Math.max(others[0], others[1]) };
}

/**
 * The shaft frame in the part's object space.
 *  grip given (held): origin = the grip projected onto the centre line, the
 *    axis points at the LONGER side, len = [to the + end, to the - end].
 *  grip null (on the ground): origin = the min end, len = [full length, 0].
 * @param {number[]} min @param {number[]} max  object-space bounds
 * @param {number} axis  long-axis index
 * @param {number[]|null} grip  object-space grip point, or null
 * @returns {{origin:number[], dir:number[], lenPos:number, lenNeg:number, held:boolean}}
 */
export function shaftFrame(min, max, axis, grip) {
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const lo = min[axis] - c[axis];
  const hi = max[axis] - c[axis];
  const held = Array.isArray(grip) && grip.every(Number.isFinite);
  let s0 = held ? Math.min(hi, Math.max(lo, grip[axis] - c[axis])) : lo;
  let lenPos = hi - s0;
  let lenNeg = s0 - lo;
  let sign = 1;
  if (held && lenNeg > lenPos) {
    sign = -1;
    const t = lenPos; lenPos = lenNeg; lenNeg = t;
  }
  const origin = c.slice();
  origin[axis] = c[axis] + s0;
  const dir = [0, 0, 0];
  dir[axis] = sign;
  return { origin, dir, lenPos: Math.max(lenPos, 1e-3), lenNeg: Math.max(lenNeg, 1e-3), held };
}

// ---------------------------------------------------------------------------
// The spring
// ---------------------------------------------------------------------------

/**
 * Spring constants for one side of the shaft. Longer sides ring slower; the
 * displayed bend is `compliance` of the virtual tip's lag, saturating softly
 * toward `maxAng` radians (7.4 degrees): a whip of several degrees at the end
 * of a swing, about half a degree of sway at a run, nothing at rest.
 */
export function flexParams(lenSide) {
  const L = Math.max(0.3, +lenSide || 0);
  const f = Math.min(3.2, Math.max(1.6, 2.6 / Math.sqrt(L)));
  return { omega: 2 * Math.PI * f, zeta: 0.16, compliance: 0.22, maxAng: 0.13 };
}

/** A fresh spring (one per shaft end). */
export function makeSpring() {
  return { x: [0, 0, 0], v: [0, 0, 0], prev: [0, 0, 0], init: false };
}

/** Snap the spring onto the real tip (spawn, teleport, a hitch, a re-wield). */
export function resetSpring(s, tip) {
  s.x[0] = tip[0]; s.x[1] = tip[1]; s.x[2] = tip[2];
  s.prev[0] = tip[0]; s.prev[1] = tip[1]; s.prev[2] = tip[2];
  s.v[0] = 0; s.v[1] = 0; s.v[2] = 0;
  s.init = true;
}

const SUBSTEP_S = 1 / 120;

/**
 * Advance the virtual tip toward the real one. The tip is a point mass on a
 * spring to the shaft's end with damping RELATIVE to the end's own velocity,
 * so steady motion leaves no lag and only acceleration bends the shaft. The
 * target is interpolated across sub-steps (stable at low frame rates).
 * Resets (returns zero lag) on the first call, after a jump of > 1.5 m, or for
 * a frame gap > 0.25 s.
 * @param {{x:number[],v:number[],prev:number[],init:boolean}} s
 * @param {number[]} tip  this frame's real tip (world)
 * @param {number} dt seconds
 * @param {{omega:number, zeta:number}} p
 * @param {number[]} [out]  the lag (virtual - real), world
 * @returns {number[]} out
 */
export function stepSpring(s, tip, dt, p, out = [0, 0, 0]) {
  const jump = s.init
    ? Math.hypot(tip[0] - s.x[0], tip[1] - s.x[1], tip[2] - s.x[2])
    : Infinity;
  if (!s.init || !(dt > 0) || dt > 0.25 || jump > 1.5) {
    resetSpring(s, tip);
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }
  const n = Math.min(30, Math.max(1, Math.ceil(dt / SUBSTEP_S)));
  const h = dt / n;
  const w2 = p.omega * p.omega;
  const c = 2 * p.zeta * p.omega;
  const vt0 = (tip[0] - s.prev[0]) / dt;
  const vt1 = (tip[1] - s.prev[1]) / dt;
  const vt2 = (tip[2] - s.prev[2]) / dt;
  for (let k = 0; k < n; k++) {
    // the target at the START of this sub-step: with the end-of-step target the
    // semi-implicit update settles one sub-step AHEAD of a steadily moving end
    // (a constant 'lag' of vt * h — 3 cm at a 4 m/s run), i.e. a bend at a jog
    const f = k / n;
    const t0 = s.prev[0] + (tip[0] - s.prev[0]) * f;
    const t1 = s.prev[1] + (tip[1] - s.prev[1]) * f;
    const t2 = s.prev[2] + (tip[2] - s.prev[2]) * f;
    s.v[0] += (w2 * (t0 - s.x[0]) + c * (vt0 - s.v[0])) * h;
    s.v[1] += (w2 * (t1 - s.x[1]) + c * (vt1 - s.v[1])) * h;
    s.v[2] += (w2 * (t2 - s.x[2]) + c * (vt2 - s.v[2])) * h;
    s.x[0] += s.v[0] * h;
    s.x[1] += s.v[1] * h;
    s.x[2] += s.v[2] * h;
  }
  s.prev[0] = tip[0]; s.prev[1] = tip[1]; s.prev[2] = tip[2];
  out[0] = s.x[0] - tip[0];
  out[1] = s.x[1] - tip[1];
  out[2] = s.x[2] - tip[2];
  return out;
}

/**
 * The bend for one shaft end as a rotation vector (axis * angle, world): the
 * rotation about the grip that swings the end toward its lagging virtual tip.
 * @param {number[]} lag   virtual - real tip (world)
 * @param {number[]} dir   unit direction grip -> this end (world)
 * @param {number} len     grip -> end distance (m)
 * @param {{compliance:number, maxAng:number}} p
 * @param {number} [gain=1] live tuning multiplier
 * @param {number[]} [out]
 * @returns {number[]} out (zero when there is no perpendicular lag)
 */
export function bendVector(lag, dir, len, p, gain = 1, out = [0, 0, 0]) {
  const d = lag[0] * dir[0] + lag[1] * dir[1] + lag[2] * dir[2];
  const px = lag[0] - d * dir[0];
  const py = lag[1] - d * dir[1];
  const pz = lag[2] - d * dir[2];
  const perp = Math.hypot(px, py, pz);
  if (!(perp > 1e-7) || !(len > 1e-3)) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  // soft saturation: ~linear for small bends, never a flat-topped clamp
  const raw = Math.atan((perp * p.compliance * gain) / len);
  const ang = p.maxAng * Math.tanh(raw / p.maxAng);
  // axis = dir x perp (normalised): rotating dir about it moves the end toward the lag
  let ax = dir[1] * pz - dir[2] * py;
  let ay = dir[2] * px - dir[0] * pz;
  let az = dir[0] * py - dir[1] * px;
  const al = Math.hypot(ax, ay, az);
  if (!(al > 1e-9)) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  ax /= al; ay /= al; az /= al;
  out[0] = ax * ang; out[1] = ay * ang; out[2] = az * ang;
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic randomness (shine timing, per-weapon phase)
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG returning [0, 1). */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable [0,1) phase per object (guid hash). */
export function seed01(guid) {
  let h = (guid >>> 0) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
