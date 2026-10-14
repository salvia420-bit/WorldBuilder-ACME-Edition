// scene3d/film/scene/world_query.js — live scene facts for AC Film Mode perception and planning
// (SPEC §1.1 page adapters, §3 `query.subject/near/groundZ`; recon_physobj.md §1–2, recon_terrain.md Q1).
//
// WHY: the film runtime keeps asking the live client small factual questions —
// where is "Pathwarden Adara" right now and how tall is she, which way is she
// facing and how fast is she walking; what is within 3 m of this sweep hit (a
// tree? a rock? a creature?); how high is the ground under the drone; which
// cell is this dungeon point in. The answers live in five different places
// with five different frames and lifetimes:
//   * rigs: `liveScene3d.entityManager.entityMap` (Map guid → EntityInstance);
//     `inst.root.position` is AC world metres; kind from `inst.meta.itemType` /
//     `objDescFlags` bits (target_cycle.js / nameplate_sprite.js constants,
//     copied here — this module never imports entities.js); body radius/height
//     from `sessionHandle.objectPartDims(guid)` (CPartArray radius/height × scale;
//     empty until the Setup is resident → per-kind defaults × objScale);
//     heading = −yaw (EntityManager.getHeading is CCW; compass is −yaw);
//     velocity from the position history this module keeps per queried guid;
//   * statics/scenery: no retained JS placement index exists (building/static
//     atlases flatten identity), so `staticsNear` reads the wasm placement
//     tables per landblock — `fetch_landblock_objects_soa(Uint32Array.of(lbKey|0xFFFE))`
//     (LandBlockInfo stabs + buildings, `isBuilding`) and
//     `fetch_landblock_scenery_soa(…)` (procedural trees/bushes/rocks) — copies
//     the typed arrays, FREES the SoA boxes, and caches per landblock. Kind:
//     building (isBuilding), tree (VFX archetype trunk-canopy / foliage-pollen,
//     or tip-flex scenery — a label only), rock (other procedural scenery —
//     trees and bushes carry wind/pollen VFX, rocks do not), prop (other
//     placements). The archetype and the body size come from injected `catalogs`
//     (`createStaticCatalogs`: the client's VFX descriptor catalog — archetype +
//     the classifier's DAT bounds — then the wasm Setup selection sphere, else
//     per-kind defaults, `dimsSource`); film/index.js wires the real ones.
//     A statics / building hit (render bounds) names the placement whose axis is
//     nearest relative to its radius (`staticHitScore`); it gets a fade key
//     (`placement:<lb>:object:<row>`) only when that is unambiguous (no other
//     candidate nearly as central) and it is a placed tree or a small prop, both
//     of KNOWN size (STATIC_HIT_RULES). A SCENERY hit (los stops on the physics
//     collider: a trunk cylsphere or boulder sphere, far thinner than a canopy) is
//     only LABELLED (kind + did of the nearest placement axis that could own it,
//     SCENERY_HIT_RULES) and NEVER gets a fade key: the wasm CollisionHit carries
//     no placement identity, and on real data geometry alone keyed the wrong
//     placement (a boulder hit gave the tree behind it — fading that tree read as
//     a clear view while the rock still blocked). Exact scenery fades need a
//     placement index on CollisionHit from the wasm scenery sweep (v2, SPEC §3.1);
//     until then the pilot's fade falls back to a reroute. `staticFadeTargets`
//     resolves an object key to its live staticsGroup draws (a per-placement node,
//     one InstancedMesh instance, or a BatchedMesh instance) for the pilot's
//     occluder fade — the take player hides and restores them; a scenery key
//     resolves to nothing (FADEABLE_STATIC_SOURCES);
//   * particles: delegated to particles_query.js;
//   * ground: `sessionHandle.terrainHeightAt` (resident rings only), then the
//     residency-independent terrain corridor (terrain_corridor.js), whose missing
//     landblocks are fetched in the background on a miss;
//   * cells: outdoor cells from xy; indoor cells by walking
//     `sessionHandle.resolveViewerCell` from a known point of the hint cell;
//     the EnvCell list indoor sweeps use is `renderSetCells(sh)` (shared with
//     runtime/safety.js).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page adapter: every dependency is
// injected ({liveScene3d, sessionHandle, wasmExports, THREE, catalogs, now});
// every wasm export is typeof-guarded and every wasm box freed. Deterministic:
// time comes only from the injected `now()` (default liveScene3d.frameTime.tsMs).

import { kindForLayer, normalizeLayerName } from "./los.js";
import { createParticlesQuery } from "./particles_query.js";
import { createTerrainCorridor } from "./terrain_corridor.js";
import { LB_SIZE, localFromWorld } from "../core/units.js";

// ---------------------------------------------------------------------------
// constants (verbatim from target_cycle.js / nameplate_sprite.js — ACE enums)
// ---------------------------------------------------------------------------

/** ItemType / ObjectDescriptionFlag bits used for kind classification. */
export const ENTITY_FLAGS = Object.freeze({
  ITEM_TYPE_CREATURE: 0x00000010,
  ITEM_TYPE_CONTAINER: 0x00000200,
  ITEM_TYPE_PORTAL: 0x00010000,
  ITEM_TYPE_LIFE_STONE: 0x10000000,
  ODF_PLAYER: 0x00000008,
  ODF_ATTACKABLE: 0x00000010,
  ODF_VENDOR: 0x00000200,
  ODF_DOOR: 0x00001000,
  ODF_CORPSE: 0x00002000,
  ODF_LIFESTONE: 0x00004000,
  ODF_PORTAL: 0x00040000,
  ODF_BINDSTONE: 0x08000000,
});

/** Entity kinds `subject()` / `entitiesNear()` report. */
export const ENTITY_KINDS = Object.freeze(["player", "creature", "npc", "door", "portal", "lifestone", "corpse", "container", "item"]);

/** Static placement kinds `staticsNear()` reports. */
export const STATIC_KINDS = Object.freeze(["building", "tree", "rock", "prop"]);

/** Default body `[radius, height]` (m, before objScale) per entity kind when objectPartDims is empty. */
export const ENTITY_DEFAULT_DIMS = Object.freeze({
  player: [0.48, 1.8],
  creature: [0.6, 1.8],
  npc: [0.48, 1.8],
  door: [1.0, 2.6],
  portal: [1.5, 3.5],
  lifestone: [1.0, 2.5],
  corpse: [0.8, 0.6],
  container: [0.6, 1.0],
  item: [0.3, 0.5],
});

/** Default `[radius, height]` (m, before placement scale) per static kind (the SoA tables carry no bounds). */
export const STATIC_DEFAULT_DIMS = Object.freeze({
  tree: [2.5, 8],
  rock: [1.5, 1.5],
  prop: [1.0, 2.0],
  building: [8, 8],
});

/** VFX archetypes (vfx_catalog.js) that mark a Setup as a tree / foliage. */
export const TREE_ARCHETYPES = Object.freeze(["trunk-canopy", "foliage-pollen"]);

/** Most landblocks one statics query touches (5×5). */
export const STATICS_MAX_LANDBLOCKS = 25;

/** Landblocks kept in the statics cache (FIFO eviction). */
export const STATICS_CACHE_LANDBLOCKS = 64;

/** Entities whose position history is kept for velocity. */
export const HISTORY_MAX = 256;

/**
 * Static placement kinds a film fade may hide (`describeHit` gives them a
 * `fadeKey`): placed trees and small props (of known size, STATIC_HIT_RULES).
 * Rocks and buildings are structure — the pilot reroutes around those
 * (sense_words OCCLUDER_CLASSES.solid).
 */
export const FADEABLE_STATIC_KINDS = Object.freeze(["tree", "prop"]);

/**
 * Placement tables whose rows may carry a fade key (`describeHit`) and resolve to
 * live draws (`staticFadeTargets`): the LandBlockInfo statics ('object') only.
 * v1: procedural SCENERY ('scenery') never fades — a collider hit cannot be tied
 * to one placement without a placement index on the wasm CollisionHit
 * (SCENERY_HIT_RULES); with no key the pilot's fade becomes a reroute.
 */
export const FADEABLE_STATIC_SOURCES = Object.freeze(["object"]);

/** Prefix of a static placement's fade key (`placement:<lbKey hex8>:<source>:<row>`). */
export const STATIC_FADE_PREFIX = "placement:";

/** Fade keys remembered by `describeHit` for `staticFadeTargets` (FIFO). */
export const STATIC_FADE_KEYS_MAX = 256;

/**
 * Which placement a STATICS / BUILDING hit names, and when it may be faded
 * (`describeHit`). Those layers stop rays on the placement's render-mesh bounds
 * (stab AABBs, building physics), i.e. at about its size radius, so:
 * - candidates are ranked by `staticHitScore` (distance from the hit to the
 *   placement's vertical axis ÷ its radius; lower = closer to its middle);
 * - `maxScore`: a fade key needs the hit INSIDE the winner's radius (score ≤ 1);
 * - `ambiguity`: no fade key when the runner-up scores within this of the winner
 *   (overlapping bodies — fading one would not clear the ray; the pilot
 *   reroutes instead);
 * - a fade key needs a KNOWN size (catalog or selection sphere, never the
 *   defaults): the score is only as good as the radius it divides by. A placed
 *   tree of known size fades; a prop also needs max(radius, height / 2) ≤
 *   `propMaxSize` (m) — barrels and crates, never fountains, statues or bridges.
 * Scenery hits are labelled by SCENERY_HIT_RULES instead and never get a key.
 */
export const STATIC_HIT_RULES = Object.freeze({ maxScore: 1, ambiguity: 0.25, propMaxSize: 2 });

/**
 * How a SCENERY hit (los.js scenery layer) is LABELLED by `describeHit` — kind and
 * did only: v1 NEVER gives a scenery hit a fade key (FADEABLE_STATIC_SOURCES).
 * Those rays stop on the PHYSICS colliders — trunk cylspheres and boulder spheres
 * (DAT `CSetup` cylspheres / spheres × the placement scale) — and the wasm
 * CollisionHit carries only t / x / y / z / normal, no placement. On real data the
 * geometry cannot pick the owner reliably: the main scenery boulder 0x02001065
 * (87 % of the collidable scenery rocks) has two r 2.3 m spheres up to 1 m off its
 * axis, so a tree standing behind it fits a hit on its face better than the boulder
 * does, and multi-trunk trees (0x0200035F, 0x02000251, 0x020002DC) lose their
 * off-axis hits to a neighbour. A key would then fade the wrong placement and the
 * sensors would report a clear view through the rock. Exact scenery fades need a
 * placement index on CollisionHit from the wasm scenery sweep (v2, SPEC §3.1).
 * The label names the placement whose axis is ABSOLUTELY nearest
 * (`staticAxisDistance`) among the placements that could own the hit:
 * - reach: that distance is at most the placement's plausible collider reach
 *   (`sceneryColliderReach`) + `slackM` (the los point is the swept sphere's
 *   centre, off the surface by the probe radius);
 * - side: with a usable hit normal (horizontal part ≥ `minNormalXY`) the axis lies
 *   BEHIND the hit, within `lateralM` × max(1, scale) of the inward normal line
 *   (`colliderSideFit`; the wasm wall / sphere normal is radial from the
 *   collider's axis / centre, which sits on the placement axis or a little off it).
 * When none could own it the absolute-nearest axis gives the label. A wrong label
 * is harmless: a 'tree' answer (fade) with no key reroutes exactly like a 'rock'.
 * Plausible collider reach (m, model space, × scale): the catalog's when it
 * carries one (`catalogs.staticColliderOf`), else min(`reachCap[kind]`,
 * max(`reachGrowth` × r, r + `reachPadM`)) of the placement's size radius r
 * (catalog / selection sphere / defaults). Grounded in the 2026-07-27 scenery
 * collider census (176 scenery DIDs, DAT cylspheres / spheres): trunk colliders
 * reach 0.07–0.4 × a trunk-canopy tree's catalog radius, bush colliders up to
 * ~1.3 × theirs (one 0.55 m beyond), at most 5.16 m for a tree and 1.53 m for an
 * uncatalogued rock (the catalogued boulder 0x02001065 reaches 3.29 m × scale).
 */
export const SCENERY_HIT_RULES = Object.freeze({
  reachCap: Object.freeze({ tree: 5.2, rock: 2.1 }),
  reachGrowth: 1.35,
  reachPadM: 0.6,
  slackM: 0.3,
  minNormalXY: 0.3,
  lateralM: 0.7,
});

/** Static size sources (`StaticFacts.dimsSource`), best first. */
export const STATIC_DIMS_SOURCES = Object.freeze(["catalog", "selectionSphere", "default"]);

/** Selection spheres at or below this radius (m) are retail's degenerate placeholder (0.1), not a size. */
const MIN_SELECTION_RADIUS = 0.15;

/**
 * Match tolerances (m) between a placement origin and a scene node / instance
 * translation in staticsGroup space (= AC world metres; instance matrices are
 * float32, ≈ 4 mm at 49 km).
 */
export const STATIC_MATCH_TOL = Object.freeze({ xy: 0.1, z: 0.5 });

/** Velocity smoothing time constant (s). */
const VELOCITY_TAU_S = 0.15;
/** A history gap longer than this (s) or a jump farther than this (m) resets the velocity. */
const HISTORY_GAP_S = 2;
const HISTORY_JUMP_M = 50;

// ---------------------------------------------------------------------------
// pure helpers (exported for tests and other adapters)
// ---------------------------------------------------------------------------

/**
 * Entity kind from spawn meta (`itemType`, `objDescFlags`) and guid:
 * corpse → player (PLAYER flag or guid tier 0x5) → door → portal → lifestone
 * (lifestone/bindstone) → creature (attackable creature) / npc (non-attackable
 * creature: vendors, town folk) → container → item.
 * @param {{itemType?:number, objDescFlags?:number}|null} meta
 * @param {number} [guid]
 * @returns {string} one of ENTITY_KINDS
 */
export function entityKindOf(meta, guid = 0) {
  const F = ENTITY_FLAGS;
  const it = meta && Number.isFinite(meta.itemType) ? meta.itemType >>> 0 : 0;
  const odf = meta && Number.isFinite(meta.objDescFlags) ? meta.objDescFlags >>> 0 : 0;
  const g = Number.isFinite(guid) ? guid >>> 0 : 0;
  if (odf & F.ODF_CORPSE) return "corpse";
  if (odf & F.ODF_PLAYER || g >>> 28 === 0x5) return "player";
  if (odf & F.ODF_DOOR) return "door";
  if (it & F.ITEM_TYPE_PORTAL || odf & F.ODF_PORTAL) return "portal";
  if (it & F.ITEM_TYPE_LIFE_STONE || odf & (F.ODF_LIFESTONE | F.ODF_BINDSTONE)) return "lifestone";
  if (it & F.ITEM_TYPE_CREATURE) return odf & F.ODF_ATTACKABLE ? "creature" : "npc";
  if (it & F.ITEM_TYPE_CONTAINER) return "container";
  return "item";
}

/**
 * Obstacle word (pilot/sense_words OBSTACLE_KINDS) for an entity kind:
 * player → player, creature/npc → creature, door → door, anything else → prop.
 * @param {string} kind
 * @returns {string}
 */
export function obstacleKindForEntity(kind) {
  if (kind === "player") return "player";
  if (kind === "creature" || kind === "npc") return "creature";
  if (kind === "door") return "door";
  return "prop";
}

/**
 * Static placement kind: building when `isBuilding`; tree for the TREE_ARCHETYPES;
 * procedural scenery → tree for `tip-flex`, else rock; any other placement → prop.
 * `tip-flex` is the VFX classifier's thin flexing-tip archetype (weapon-like poles
 * and spikes with aspect > 3, vfx/weapon_fx.js), not bushes or grass: no scenery
 * DID of the 2026-07-27 collider census carries it, and a scenery kind is only a
 * label (scenery never gets a fade key).
 * @param {{isBuilding?:boolean, source?:'object'|'scenery', archetype?:string|null}} p
 * @returns {string} one of STATIC_KINDS
 */
export function staticKindOf(p) {
  const o = p && typeof p === "object" ? p : {};
  if (o.isBuilding === true) return "building";
  const a = typeof o.archetype === "string" ? o.archetype : null;
  if (a && TREE_ARCHETYPES.includes(a)) return "tree";
  if (o.source === "scenery") return a === "tip-flex" ? "tree" : "rock";
  return "prop";
}

/**
 * Compass heading (radians, clockwise from north, wrapped to (−π, π]) of an
 * AC quaternion stored the three.js way on a rig root (`{x,y,z,w}` = AC
 * x,y,z,w): −yaw with yaw = atan2(2(wz + xy), 1 − 2(y² + z²)). Null when not finite.
 * @param {{x:number,y:number,z:number,w:number}|null} q
 * @returns {number|null}
 */
export function compassFromRootQuat(q) {
  if (!q || typeof q !== "object") return null;
  const { x, y, z, w } = q;
  if (![x, y, z, w].every(Number.isFinite)) return null;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return wrapPi(-yaw);
}

/**
 * The EnvCell list the indoor collision layers sweep (los.js `cellIds`): a
 * Uint32Array COPY of the walk root's depth-1 render set — the film viewer
 * cell's (`getViewerRenderSet`, rooted where camera_owner carries the camera)
 * when the handle has it, else the player's `getRenderSet(1)`. Null when there
 * is no handle, the export is missing, it throws, or the set is empty. Shared
 * by the safety reflex and the sensors (scout, pre-roll and take), so the
 * reflex and perception always sweep the same walls.
 * @param {object|null} sh wasm SessionHandle (or a fake)
 * @returns {Uint32Array|null}
 */
export function renderSetCells(sh) {
  if (!sh || (typeof sh !== "object" && typeof sh !== "function")) return null;
  const tries = [];
  if (typeof sh.getViewerRenderSet === "function") tries.push(() => sh.getViewerRenderSet());
  if (typeof sh.getRenderSet === "function") tries.push(() => sh.getRenderSet(1));
  for (const f of tries) {
    try {
      const rs = f();
      if (rs && typeof rs.length === "number" && rs.length > 0) return Uint32Array.from(rs);
    } catch {
      /* stale pkg / borrow conflict → next source */
    }
  }
  return null;
}

/**
 * Fade key of a static placement row (`{lbKey, source, index}` from staticsNear).
 * @param {{lbKey:number, source:string, index:number}} p
 * @returns {string|null}
 */
export function staticFadeKey(p) {
  if (!p || typeof p !== "object" || !Number.isFinite(p.lbKey) || !Number.isInteger(p.index) || p.index < 0) return null;
  const src = p.source === "scenery" ? "scenery" : "object";
  return `${STATIC_FADE_PREFIX}${(p.lbKey >>> 0).toString(16).padStart(8, "0")}:${src}:${p.index}`;
}

/**
 * Parse a static fade key; null when `id` is not one. Particle keys
 * (`<ownerKey>#<emitterId>`, owner keys like `static:<lb>`) never parse.
 * @param {*} id
 * @returns {{lbKey:number, source:'object'|'scenery', index:number}|null}
 */
export function parseStaticFadeKey(id) {
  if (typeof id !== "string" || !id.startsWith(STATIC_FADE_PREFIX) || id.includes("#")) return null;
  const m = /^placement:([0-9a-f]{8}):(object|scenery):(\d+)$/.exec(id);
  if (!m) return null;
  return { lbKey: parseInt(m[1], 16) >>> 0, source: /** @type {'object'|'scenery'} */ (m[2]), index: Number(m[3]) };
}

/** True when `id` is a static placement fade key (see staticFadeKey). */
export function isStaticFadeKey(id) {
  return parseStaticFadeKey(id) !== null;
}

/**
 * How central a hit point is on a static placement: the distance from the point
 * to the placement's vertical axis segment (origin → origin + height) divided by
 * its radius. 0 = on the axis, 1 = on the body's surface, > 1 = outside it.
 * Infinity for an unusable row or point. Unlike the surface distance (0 for EVERY
 * body containing the point), it tells overlapping placements apart.
 * @param {number[]} point AC world metres
 * @param {{pos:number[], radius:number, height:number}} it a StaticFacts row
 * @returns {number}
 */
export function staticHitScore(point, it) {
  if (!it || typeof it !== "object" || !(it.radius > 0)) return Infinity;
  return staticAxisDistance(point, it) / it.radius;
}

/**
 * Distance (m) from a hit point to a static placement's vertical axis segment
 * (origin → origin + height): the horizontal distance to the axis while the point
 * is within the placement's height, else the distance to the nearer segment end.
 * Infinity for an unusable row or point.
 * @param {number[]} point AC world metres
 * @param {{pos:number[], height?:number}} it a StaticFacts row
 * @returns {number}
 */
export function staticAxisDistance(point, it) {
  const p = vec(point);
  const b = it && typeof it === "object" ? vec(it.pos) : null;
  if (!p || !b) return Infinity;
  const h = Number.isFinite(it.height) ? Math.max(0, it.height) : 0;
  const z = Math.min(Math.max(p[2], b[2]), b[2] + h);
  return Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - z);
}

/**
 * Plausible physics-collider reach (m, world) of a scenery placement: how far from
 * its vertical axis a ray stopped by its trunk cylsphere / boulder sphere can be
 * (SCENERY_HIT_RULES). `colliderModel` (m, model space) is the catalog's collider
 * reach when it carries one; otherwise the bound comes from the row's size radius
 * (already × scale) and kind. 0 for an unusable row.
 * @param {{kind?:string, radius?:number, scale?:number}} it a StaticFacts row
 * @param {number|null} [colliderModel]
 * @returns {number}
 */
export function sceneryColliderReach(it, colliderModel = null) {
  if (!it || typeof it !== "object") return 0;
  const S = SCENERY_HIT_RULES;
  const s = Number.isFinite(it.scale) && it.scale > 0 ? it.scale : 1;
  if (Number.isFinite(colliderModel) && colliderModel > 0) return colliderModel * s;
  const r = Number.isFinite(it.radius) && it.radius > 0 ? it.radius : 0;
  if (r === 0) return 0;
  const cap = Object.prototype.hasOwnProperty.call(S.reachCap, it.kind) ? S.reachCap[it.kind] * s : Infinity;
  return Math.min(cap, Math.max(S.reachGrowth * r, r + S.reachPadM * s));
}

/**
 * Could a scenery placement's collider own a hit with this normal? The wasm
 * scenery normal is radial from the collider's axis (cylinder wall) or centre
 * (sphere), so the owner's axis lies BEHIND the hit along −normal, within
 * `SCENERY_HIT_RULES.lateralM` × max(1, scale) of that line (collider axes sit a
 * little off the placement axis for a few DIDs). Null when the normal carries no
 * side information (missing, or nearly vertical: a cap or a boulder's top).
 * @param {number[]} point AC world metres
 * @param {number[]|null} normal the hit normal (toward the ray's start)
 * @param {{pos:number[], scale?:number}} it a StaticFacts row
 * @returns {boolean|null}
 */
export function colliderSideFit(point, normal, it) {
  const S = SCENERY_HIT_RULES;
  const p = vec(point);
  const n = vec(normal);
  const b = it && typeof it === "object" ? vec(it.pos) : null;
  if (!p || !n || !b) return null;
  const nxy = Math.hypot(n[0], n[1]);
  if (!(nxy >= S.minNormalXY)) return null;
  const ux = -n[0] / nxy, uy = -n[1] / nxy; // inward: toward the owner's axis
  const vx = b[0] - p[0], vy = b[1] - p[1];
  const depth = vx * ux + vy * uy;
  const lateral = Math.abs(vx * uy - vy * ux);
  const s = Number.isFinite(it.scale) && it.scale > 0 ? it.scale : 1;
  return depth >= 0 && lateral <= S.lateralM * Math.max(1, s);
}

/**
 * `{radius, height}` (m, model space) of a VFX descriptor from the classifier's
 * DAT-bounds signals (WorldBuilder OntologyService: `maxDimension` = the largest
 * box extent, `aspectRatio` = height ÷ max(width, depth)): radius = half the
 * footprint, height = the box height. Null when the signals are missing or bad.
 * @param {{raw?:{signals?:{name:string, value:*}[]}}|null} desc vfxDescriptorFor(did)
 * @returns {{radius:number, height:number}|null}
 */
export function dimsFromDescriptor(desc) {
  const sig = desc && desc.raw && Array.isArray(desc.raw.signals) ? desc.raw.signals : null;
  if (!sig) return null;
  const val = (name) => {
    const s = sig.find((x) => x && x.name === name);
    const v = s ? Number.parseFloat(s.value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  const M = val("maxDimension");
  const A = val("aspectRatio");
  if (!Number.isFinite(M) || !Number.isFinite(A)) return null;
  const height = A >= 1 ? M : A * M;
  const footprint = A >= 1 ? M / A : M;
  const radius = Math.max(0.05, footprint / 2);
  return height > 0 ? { radius, height } : null;
}

/**
 * `{radius, height}` (m, model space) of a Setup's DAT selection sphere
 * (`fetchSetupSelectionSphere` → {cx, cy, cz, radius, valid}): radius = the
 * sphere's horizontal reach from the placement axis, height = its top above the
 * origin. Null when invalid, degenerate (retail's 0.1 m placeholder) or below ground.
 * @param {{cx?:number, cy?:number, cz?:number, radius?:number, valid?:boolean}|null} s
 * @returns {{radius:number, height:number}|null}
 */
export function dimsFromSelectionSphere(s) {
  if (!s || typeof s !== "object" || s.valid === false) return null;
  const R = Number(s.radius);
  const cx = Number(s.cx ?? 0), cy = Number(s.cy ?? 0), cz = Number(s.cz ?? 0);
  if (![R, cx, cy, cz].every(Number.isFinite) || R <= MIN_SELECTION_RADIUS) return null;
  const height = cz + R;
  if (!(height > 0)) return null;
  return { radius: R + Math.hypot(cx, cy), height };
}

/**
 * The real static-placement catalogs `createWorldQuery({catalogs})` reads
 * (wired by film/index.js; every source optional):
 * - `vfxArchetypeOf(did)` → the VFX descriptor's archetype (trunk-canopy → tree…) or null;
 * - `staticDimsOf(did, kind)` → `{radius, height, source}` (model space): the
 *   descriptor's DAT bounds (`dimsFromDescriptor`, source 'catalog'), else the
 *   Setup's cached selection sphere ('selectionSphere'), else null (defaults);
 * - `prefetchStaticDims(dids)` → Promise: waits for `ready` (the catalog module),
 *   then fetches the selection sphere of every uncatalogued Setup DID (0x02……, once
 *   per DID, boxes freed); resolves when all settle or after `timeoutMs`. A DID
 *   still unsettled when a wait times out is remembered as STALLED: later prefetches
 *   do not wait for it again (its fetch stays in flight; if it ever settles, its
 *   size applies from then on);
 * - `staticColliderOf(did)` → the physics-collider reach (m, model space) from the
 *   optional `colliderOf(did)` source, else null (SCENERY_HIT_RULES then bounds it
 *   from the size radius); it only sharpens the scenery hit LABEL, never a fade.
 *   The client's VFX descriptors carry no collider data, so film/index.js passes no
 *   source today.
 * Read-only on the client: it never loads the VFX catalog itself (no
 * ensureVfxCatalog — loading it would change the client's VFX under ?visual=off /
 * ?treeWindGpu=off); a catalog the client never loaded leaves archetypes null.
 * @param {{descriptorFor?:(did:number)=>object|null, ready?:Promise<*>,
 *   selectionSphere?:(setupId:number)=>Promise<object>|object, colliderOf?:(did:number)=>number|null,
 *   timeoutMs?:number, setTimeout?:Function, clearTimeout?:Function}} [o]
 * @returns {{vfxArchetypeOf:Function, staticDimsOf:Function, staticColliderOf:Function,
 *   prefetchStaticDims:Function,
 *   stats:()=>{spheres:number, fetches:number, failures:number, timeouts:number, stalled:number}}}
 */
export function createStaticCatalogs(o = {}) {
  const c = o && typeof o === "object" ? o : {};
  const descriptorFor = typeof c.descriptorFor === "function" ? c.descriptorFor : null;
  const fetchSphere = typeof c.selectionSphere === "function" ? c.selectionSphere : null;
  const colliderOf = typeof c.colliderOf === "function" ? c.colliderOf : null;
  const ready = c.ready && typeof c.ready.then === "function" ? c.ready : Promise.resolve(true);
  const timeoutMs = Number.isFinite(c.timeoutMs) && c.timeoutMs >= 0 ? c.timeoutMs : 3000;
  const setT = typeof c.setTimeout === "function" ? c.setTimeout : (typeof setTimeout === "function" ? setTimeout : null);
  const clearT = typeof c.clearTimeout === "function" ? c.clearTimeout : (typeof clearTimeout === "function" ? clearTimeout : null);
  /** @type {Map<number, {radius:number, height:number}|null>} */
  const spheres = new Map();
  /** @type {Map<number, Promise<void>>} */
  const inflight = new Map();
  /** DIDs whose fetch outlived a prefetch's wait: never waited for again (until it settles). */
  const stalled = new Set();
  const counters = { fetches: 0, failures: 0, timeouts: 0 };
  const SPHERES_MAX = 8192;

  const desc = (did) => {
    if (!descriptorFor) return null;
    try {
      const x = descriptorFor(did >>> 0);
      return x && typeof x === "object" ? x : null;
    } catch {
      return null;
    }
  };

  function vfxArchetypeOf(did) {
    const x = desc(did);
    return x && typeof x.archetype === "string" && x.archetype ? x.archetype : null;
  }

  function staticDimsOf(did) {
    const fromCatalog = dimsFromDescriptor(desc(did));
    if (fromCatalog) return { ...fromCatalog, source: "catalog" };
    const s = spheres.get(did >>> 0);
    return s ? { ...s, source: "selectionSphere" } : null;
  }

  function staticColliderOf(did) {
    if (!colliderOf) return null;
    try {
      const v = Number(colliderOf(did >>> 0));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  function loadSphere(id) {
    if (spheres.has(id)) return Promise.resolve();
    const running = inflight.get(id);
    if (running) return running;
    counters.fetches += 1;
    const p = Promise.resolve()
      .then(() => fetchSphere(id))
      .then((box) => {
        let dims = null;
        try {
          if (box && typeof box === "object") {
            dims = dimsFromSelectionSphere({ cx: get(box, "cx"), cy: get(box, "cy"), cz: get(box, "cz"), radius: get(box, "radius"), valid: get(box, "valid") });
          }
        } finally {
          freeBox(box);
        }
        spheres.set(id, dims);
      })
      .catch(() => {
        counters.failures += 1;
        spheres.set(id, null);
      })
      .finally(() => {
        inflight.delete(id);
        stalled.delete(id);
        while (spheres.size > SPHERES_MAX) spheres.delete(spheres.keys().next().value);
      });
    inflight.set(id, p);
    return p;
  }

  async function prefetchStaticDims(dids) {
    try {
      await ready;
    } catch {
      /* no catalog: spheres only */
    }
    if (!fetchSphere || dids == null || typeof dids[Symbol.iterator] !== "function") return;
    const jobs = [];
    const waiting = [];
    for (const raw of dids) {
      const id = Number(raw) >>> 0;
      if (id >>> 24 !== 0x02 || spheres.has(id) || dimsFromDescriptor(desc(id))) continue; // GfxObj DIDs have no Setup sphere
      if (stalled.has(id)) continue; // a hung fetch already cost one wait: never block on it again
      jobs.push(loadSphere(id));
      waiting.push(id);
    }
    if (!jobs.length) return;
    const all = Promise.all(jobs).then(() => undefined);
    if (!setT || timeoutMs === Infinity) return all;
    let timer = null;
    const cap = new Promise((resolve) => {
      timer = setT(() => {
        counters.timeouts += 1;
        for (const id of waiting) if (!spheres.has(id) && inflight.has(id)) stalled.add(id);
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([all, cap]);
    } finally {
      if (timer !== null && clearT) clearT(timer);
    }
  }

  return {
    vfxArchetypeOf,
    staticDimsOf,
    staticColliderOf,
    prefetchStaticDims,
    stats: () => ({ spheres: spheres.size, ...counters, stalled: stalled.size }),
  };
}

/** @param {number} a @returns {number} a wrapped into (−π, π] */
function wrapPi(a) {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x === 0 ? 0 : x;
}

/** `[x,y,z]` from an array-like / `{x,y,z}`; null unless finite. */
function vec(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * Distance from point c to the surface of an upright capsule-ish body (vertical
 * segment base → base+height, radius r); 0 inside.
 */
function bodyDistance(c, base, r, h) {
  const z = Math.min(Math.max(c[2], base[2]), base[2] + Math.max(0, h));
  const d = Math.hypot(c[0] - base[0], c[1] - base[1], c[2] - z);
  return Math.max(0, d - r);
}

/** Read a wasm getter safely. */
function get(obj, k) {
  try {
    return obj[k];
  } catch {
    return undefined;
  }
}

/** free() a wasm box, swallowing double-free errors. */
function freeBox(b) {
  if (b && typeof b === "object" && typeof b.free === "function") {
    try {
      b.free();
    } catch {
      /* already released */
    }
  }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EntityFacts
 * @property {number} guid
 * @property {string|null} name
 * @property {string} kind      one of ENTITY_KINDS
 * @property {string} obstacleKind  obstacleKindForEntity(kind)
 * @property {number[]} pos     body BASE, AC world metres
 * @property {number[]} center  pos + height/2
 * @property {number} radius
 * @property {number} height
 * @property {number|null} heading compass radians
 * @property {number} setupId
 * @property {boolean} isLocal  the local player (the hidden film dolly)
 * @property {number} [distance] surface distance from the query centre (entitiesNear)
 */

/**
 * @typedef {Object} StaticFacts
 * @property {string} kind      one of STATIC_KINDS
 * @property {number} did       Setup / GfxObj DID
 * @property {number[]} pos     AC world metres (placement origin)
 * @property {number} radius
 * @property {number} height
 * @property {number} scale
 * @property {'object'|'scenery'} source
 * @property {boolean} isBuilding
 * @property {number} lbKey
 * @property {number} index     row in that landblock's table
 * @property {string|null} archetype  VFX archetype (catalogs.vfxArchetypeOf), null when uncatalogued
 * @property {'catalog'|'selectionSphere'|'default'} dimsSource  where radius / height come from
 * @property {number} [distance] surface distance from the query centre
 */

/**
 * Create the live world query adapter (SPEC §1.1 / §3).
 *
 * Methods (AC world metres; never throw for bad input):
 * - `entitiesNear(center, radius, {kinds, includeLocal=false, limit})` → EntityFacts[]
 *   within `radius` (surface distance), nearest first; `kinds` filters by entity
 *   kind or obstacle kind ("creature" matches creature and npc);
 * - `subject(ref)` → `{guid, name, kind, pos, radius, height, heading, velocity,
 *   setupId, isLocal}` or null; ref = guid | "0x…" guid | name | 'player' |
 *   {guid} | {name}. Each call records the position for the velocity estimate
 *   (call it every frame for a moving subject);
 * - `localPlayer()` → `{guid, pos, heading, cellId, onGround}` or null (wasm
 *   LocalPlayerPose copied + freed; rig fallback);
 * - `staticsNear(center, radius)` (async) → StaticFacts[] nearest first (per-landblock
 *   cache of the objects + scenery SoA tables); `staticsNearCached(center, radius)`
 *   → the same from cached landblocks only (missing ones are fetched in the background);
 * - `particlesNear(center, radius)` → particles_query `near` rows;
 * - `groundZ(x, y)` → terrainHeightAt, then the terrain corridor; null when unknown
 *   (a corridor miss schedules a background fetch of that landblock);
 * - `cellAt(point, hintCell)` → full cell id (0 when unknown): outdoor cells from xy;
 *   with an indoor hint the cell is walked with resolveViewerCell from the last
 *   point known in that cell (`hintCell` may be `{cell, from:[x,y,z]}`);
 * - `describeHit(hit, {indoor})` → `{kind, guid, did, fadeKey}`: the los.js hit's kind refined by
 *   what sits near the hit point (entity within 1.5 m for the objects/entities
 *   layers; placements within 4 m for the others). STATICS / BUILDINGS (render
 *   bounds): the placement whose axis is nearest relative to its radius
 *   (`staticHitScore`); `fadeKey` only for a placed tree or a prop ≤
 *   STATIC_HIT_RULES.propMaxSize, both of KNOWN size, hit inside its radius, with
 *   no other placement scoring within STATIC_HIT_RULES.ambiguity of it. SCENERY
 *   (collider hits): LABEL only — kind + did of the placement whose axis is
 *   absolutely nearest (`staticAxisDistance`) among those within their plausible
 *   collider reach (`sceneryColliderReach` + slack) and behind the hit along its
 *   normal (`colliderSideFit`), else of the absolute-nearest axis
 *   (SCENERY_HIT_RULES); `fadeKey` is ALWAYS null (FADEABLE_STATIC_SOURCES);
 * - `staticFadeTargets(key)` → `{key, kind, did, pos, targets}` | null: the live
 *   staticsGroup draws of an object fade key's placement (null for a scenery key:
 *   v1 never fades scenery), matched by placement origin
 *   (STATIC_MATCH_TOL) and model DID: `{type:'node', node}` (a per-placement Mesh /
 *   LOD / animated Group, or an InstancedMesh holding only it), `{type:'instance',
 *   mesh, index}` (one instance of a shared InstancedMesh, also every level of an
 *   instanced LOD), `{type:'batch', mesh, instanceId}` (a visible BatchedMesh
 *   instance). Particles, script anchors and the shared rAF-written buckets of
 *   instanced animated scenery are never targets (their per-placement anchor node
 *   is). The caller hides and restores them (take_player fade);
 * - `renderSetCells()` → the module helper `renderSetCells(sessionHandle)`;
 * - `corridor`, `particles` — the terrain corridor and particle query in use.
 *
 * `catalogs` (createStaticCatalogs builds the real static ones): `vfxArchetypeOf(did)`,
 * `staticDimsOf(did, kind)` → `{radius, height, source}` (model space; × placement scale),
 * `staticColliderOf(did)` → physics-collider reach (m, model space) or null (scenery labels),
 * `prefetchStaticDims(dids)` (awaited per landblock before its rows are ready; a
 * query's landblocks load concurrently), `particleFamilyOf`, `particleCatalog`. Rows
 * whose archetype or size was unknown are re-resolved when touched, so a catalog
 * that lands later still applies.
 *
 * @param {{liveScene3d?:object|null, sessionHandle?:object|null, wasmExports?:object|null,
 *   THREE?:object|null, catalogs?:{vfxArchetypeOf?:Function, particleFamilyOf?:Function,
 *   particleCatalog?:object, staticDimsOf?:Function, staticColliderOf?:Function,
 *   prefetchStaticDims?:Function},
 *   terrainCorridor?:object, particles?:object,
 *   ownerRegistry?:object|null, getLocalPlayerGuid?:()=>number, now?:()=>number,
 *   log?:(entry:object)=>void}} [deps]
 * @returns {object} the query API above
 */
export function createWorldQuery(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : null;
  const sh = d.sessionHandle && (typeof d.sessionHandle === "object" || typeof d.sessionHandle === "function") ? d.sessionHandle : null;
  const wasm = d.wasmExports && (typeof d.wasmExports === "object" || typeof d.wasmExports === "function") ? d.wasmExports : null;
  const catalogs = d.catalogs && typeof d.catalogs === "object" ? d.catalogs : {};
  const log = typeof d.log === "function" ? d.log : null;

  const corridor = d.terrainCorridor && typeof d.terrainCorridor === "object"
    ? d.terrainCorridor
    : createTerrainCorridor({ wasmExports: wasm, log: log ?? undefined });
  const particles = d.particles && typeof d.particles === "object"
    ? d.particles
    : createParticlesQuery({
      liveScene3d: live,
      THREE: d.THREE ?? null,
      familyOf: typeof catalogs.particleFamilyOf === "function" ? catalogs.particleFamilyOf : null,
      catalog: catalogs.particleCatalog ?? null,
      ...(d.ownerRegistry !== undefined ? { ownerRegistry: d.ownerRegistry } : {}),
    });

  const emit = (entry) => {
    if (!log) return;
    try {
      log({ event: "film-world-query", ...entry });
    } catch {
      /* never break perception on a logger */
    }
  };

  /** Seconds from the injected clock (default the render frame stamp); NaN when unknown. */
  const now = () => {
    try {
      if (typeof d.now === "function") {
        const t = Number(d.now());
        return Number.isFinite(t) ? t : NaN;
      }
      const ts = live && live.frameTime && typeof live.frameTime === "object" ? live.frameTime.tsMs : undefined;
      return Number.isFinite(ts) ? ts / 1000 : NaN;
    } catch {
      return NaN;
    }
  };

  const em = () => (live && live.entityManager && typeof live.entityManager === "object" ? live.entityManager : null);
  const entityMap = () => {
    const m = em();
    const map = m ? m.entityMap : null;
    return map && typeof map.get === "function" && typeof map.entries === "function" ? map : null;
  };

  /** Local player's guid (0 when unknown). */
  function localGuid() {
    const tries = [
      () => (typeof d.getLocalPlayerGuid === "function" ? d.getLocalPlayerGuid() : undefined),
      () => (sh && typeof sh.playerGuid === "function" ? sh.playerGuid() : undefined),
      () => (typeof globalThis.getLocalPlayerGuid === "function" ? globalThis.getLocalPlayerGuid() : undefined),
    ];
    for (const f of tries) {
      try {
        const g = f();
        if (Number.isFinite(g) && g >>> 0 !== 0) return g >>> 0;
      } catch {
        /* next source */
      }
    }
    return 0;
  }

  /** Body dims [r, h] of a guid from objectPartDims, or null. */
  function partDims(guid) {
    if (!sh || typeof sh.objectPartDims !== "function") return null;
    try {
      const a = sh.objectPartDims(guid);
      if (a && a.length >= 2) {
        const r = Number(a[0]), h = Number(a[1]);
        if (Number.isFinite(r) && Number.isFinite(h) && r > 0 && h > 0) return [r, h];
      }
    } catch {
      /* stale pkg / borrow conflict */
    }
    return null;
  }

  /** Wasm-tracked world position of a guid (objectPosition → [lb, x, y, z] LB-local), or null. */
  function wasmPosition(guid) {
    if (!sh || typeof sh.objectPosition !== "function") return null;
    try {
      const a = sh.objectPosition(guid);
      if (!a || a.length < 4) return null;
      const lb = Number(a[0]) >>> 0;
      const x = Number(a[1]), y = Number(a[2]), z = Number(a[3]);
      if (![x, y, z].every(Number.isFinite)) return null;
      return [((lb >>> 24) & 0xff) * LB_SIZE + x, ((lb >>> 16) & 0xff) * LB_SIZE + y, z];
    } catch {
      return null;
    }
  }

  /** Full facts of one entity instance; null when it has no usable position. */
  function factsOf(guid, inst, lg) {
    const g = guid >>> 0;
    const root = inst && inst.root && typeof inst.root === "object" ? inst.root : null;
    const meta = inst && inst.meta && typeof inst.meta === "object" ? inst.meta : {};
    const pos = (root && vec(root.position)) || wasmPosition(g);
    if (!pos) return null;
    const isLocal = lg !== 0 && g === lg;
    const kind = isLocal ? "player" : entityKindOf(meta, g);
    let dims = partDims(g);
    if (!dims) {
      const def = ENTITY_DEFAULT_DIMS[kind] || ENTITY_DEFAULT_DIMS.item;
      const s = Number.isFinite(meta.objScale) && meta.objScale > 0 ? meta.objScale : 1;
      dims = [def[0] * s, def[1] * s];
    }
    let heading = null;
    const m = em();
    if (m && typeof m.getHeading === "function") {
      try {
        const yaw = m.getHeading(g);
        if (Number.isFinite(yaw)) heading = wrapPi(-yaw);
      } catch {
        heading = null;
      }
    }
    if (heading === null && root) heading = compassFromRootQuat(root.quaternion);
    let name = typeof meta.name === "string" && meta.name ? meta.name : null;
    if (!name && root && root.userData && typeof root.userData.name === "string") name = root.userData.name;
    const setupId = Number.isFinite(meta.setupId) ? meta.setupId >>> 0 : Number.isFinite(meta.modelId) ? meta.modelId >>> 0 : 0;
    return {
      guid: g,
      name,
      kind,
      obstacleKind: obstacleKindForEntity(kind),
      pos,
      center: [pos[0], pos[1], pos[2] + dims[1] / 2],
      radius: dims[0],
      height: dims[1],
      heading,
      setupId,
      isLocal,
    };
  }

  /**
   * Entities near a point (see createWorldQuery).
   * @param {number[]|{x:number,y:number,z:number}} center
   * @param {number} radius
   * @param {{kinds?:string[]|string, includeLocal?:boolean, limit?:number}} [opts]
   * @returns {EntityFacts[]}
   */
  function entitiesNear(center, radius, opts = {}) {
    const c = vec(center);
    const map = entityMap();
    if (!c || !map) return [];
    const o = opts && typeof opts === "object" ? opts : {};
    const R = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    const kinds = o.kinds == null ? null : new Set(Array.isArray(o.kinds) ? o.kinds : [o.kinds]);
    const includeLocal = o.includeLocal === true;
    const limit = Number.isFinite(o.limit) && o.limit >= 0 ? Math.floor(o.limit) : Infinity;
    const lg = localGuid();
    const out = [];
    for (const [guid, inst] of map.entries()) {
      if (!Number.isFinite(guid)) continue;
      if (!includeLocal && lg !== 0 && guid >>> 0 === lg) continue;
      // Cheap reject on the root position before the full facts (dims may cost a wasm call).
      const rp = inst && inst.root ? vec(inst.root.position) : null;
      if (rp && Math.hypot(rp[0] - c[0], rp[1] - c[1]) > R + 12) continue;
      let f = null;
      try {
        f = factsOf(guid, inst, lg);
      } catch {
        f = null;
      }
      if (!f) continue;
      if (kinds && !kinds.has(f.kind) && !kinds.has(f.obstacleKind)) continue;
      const dist = bodyDistance(c, f.pos, f.radius, f.height);
      if (dist <= R) out.push({ ...f, distance: dist });
    }
    out.sort((a, b) => a.distance - b.distance || a.guid - b.guid);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  // --- subject + velocity history -------------------------------------------------

  /** @type {Map<number, {t:number, pos:number[], vel:number[]}>} */
  const history = new Map();

  /** Update and return the smoothed velocity of a guid at `pos`. */
  function trackVelocity(guid, pos) {
    const t = now();
    if (!Number.isFinite(t)) return [0, 0, 0];
    const rec = history.get(guid);
    if (!rec) {
      history.set(guid, { t, pos: pos.slice(), vel: [0, 0, 0] });
      while (history.size > HISTORY_MAX) history.delete(history.keys().next().value);
      return [0, 0, 0];
    }
    const dt = t - rec.t;
    if (!(dt > 1e-3)) return rec.vel.slice();
    const jump = Math.hypot(pos[0] - rec.pos[0], pos[1] - rec.pos[1], pos[2] - rec.pos[2]);
    if (dt > HISTORY_GAP_S || jump > HISTORY_JUMP_M) {
      rec.vel = [0, 0, 0];
    } else {
      const a = Math.min(1, dt / VELOCITY_TAU_S);
      const raw = [(pos[0] - rec.pos[0]) / dt, (pos[1] - rec.pos[1]) / dt, (pos[2] - rec.pos[2]) / dt];
      rec.vel = [rec.vel[0] + (raw[0] - rec.vel[0]) * a, rec.vel[1] + (raw[1] - rec.vel[1]) * a, rec.vel[2] + (raw[2] - rec.vel[2]) * a];
    }
    rec.t = t;
    rec.pos = pos.slice();
    history.delete(guid);
    history.set(guid, rec);
    return rec.vel.slice();
  }

  /** Resolve a subject reference to a guid (0 when not found). */
  function resolveGuid(ref) {
    if (ref == null) return 0;
    if (typeof ref === "number") return Number.isFinite(ref) ? ref >>> 0 : 0;
    if (typeof ref === "object") {
      if (Number.isFinite(ref.guid)) return ref.guid >>> 0;
      if (typeof ref.name === "string") return resolveGuid(ref.name);
      if (ref.kind === "player") return localGuid();
      return 0;
    }
    if (typeof ref !== "string") return 0;
    const s = ref.trim();
    if (!s) return 0;
    const low = s.toLowerCase();
    if (low === "player" || low === "self" || low === "me" || low === "local") return localGuid();
    if (/^0x[0-9a-f]{1,8}$/i.test(s)) return parseInt(s.slice(2), 16) >>> 0;
    const m = em();
    if (m && typeof m.findGuidByName === "function") {
      try {
        const g = m.findGuidByName(s);
        if (Number.isFinite(g) && g >>> 0 !== 0) return g >>> 0;
      } catch {
        /* fall back to a scan */
      }
    }
    const map = entityMap();
    if (!map) return 0;
    let exact = 0;
    let loose = 0;
    for (const [guid, inst] of map.entries()) {
      const n = inst && inst.meta && typeof inst.meta.name === "string" ? inst.meta.name : null;
      if (!n) continue;
      const g = guid >>> 0;
      if (n === s && (exact === 0 || g < exact)) exact = g;
      else if (n.toLowerCase() === low && (loose === 0 || g < loose)) loose = g;
    }
    return exact || loose;
  }

  /**
   * Subject facts for a reference (see createWorldQuery).
   * @param {number|string|{guid?:number, name?:string}} ref
   * @returns {(EntityFacts & {velocity:number[]})|null}
   */
  function subject(ref) {
    const guid = resolveGuid(ref);
    if (guid === 0) return null;
    const map = entityMap();
    const inst = map ? map.get(guid) : undefined;
    let f = null;
    try {
      f = factsOf(guid, inst, localGuid());
    } catch {
      f = null;
    }
    if (!f) return null;
    return { ...f, velocity: trackVelocity(guid, f.pos) };
  }

  /**
   * The local player (the hidden film dolly): `{guid, pos, heading, cellId, onGround}` or null.
   * @returns {{guid:number, pos:number[], heading:number|null, cellId:number, onGround:boolean|null}|null}
   */
  function localPlayer() {
    const guid = localGuid();
    if (sh && typeof sh.getLocalPlayerPose === "function") {
      let pose = null;
      try {
        pose = sh.getLocalPlayerPose();
        if (pose && typeof pose === "object") {
          const lb = Number(get(pose, "landblockId")) >>> 0;
          const x = Number(get(pose, "x")), y = Number(get(pose, "y")), z = Number(get(pose, "z"));
          const yaw = Number(get(pose, "heading"));
          const onGround = get(pose, "isOnGround");
          if ([x, y, z].every(Number.isFinite)) {
            return {
              guid,
              pos: [((lb >>> 24) & 0xff) * LB_SIZE + x, ((lb >>> 16) & 0xff) * LB_SIZE + y, z],
              heading: Number.isFinite(yaw) ? wrapPi(-yaw) : null,
              cellId: lb,
              onGround: typeof onGround === "boolean" ? onGround : null,
            };
          }
        }
      } catch {
        /* fall back to the rig */
      } finally {
        freeBox(pose);
      }
    }
    if (guid === 0) return null;
    const map = entityMap();
    const f = map ? factsOf(guid, map.get(guid), guid) : null;
    if (!f) return null;
    return { guid, pos: f.pos, heading: f.heading, cellId: localFromWorld(f.pos[0], f.pos[1], f.pos[2]).cellId, onGround: null };
  }

  // --- statics ----------------------------------------------------------------

  /** @type {Map<number, {ready:boolean, items:StaticFacts[], promise:Promise<void>|null}>} */
  const staticsCache = new Map();
  const staticsCounters = { fetches: 0, freed: 0, failures: 0 };

  /** Archetype string of a DID from the injected catalog lookup. */
  function archetypeOf(did) {
    if (typeof catalogs.vfxArchetypeOf !== "function") return null;
    try {
      const a = catalogs.vfxArchetypeOf(did);
      if (typeof a === "string" && a) return a;
      if (a && typeof a === "object" && typeof a.archetype === "string") return a.archetype;
    } catch {
      /* unknown */
    }
    return null;
  }

  /** `[radius, height, dimsSource]` of a static placement (catalog size × scale, else the kind's defaults). */
  function staticDims(did, kind, scale) {
    if (typeof catalogs.staticDimsOf === "function") {
      try {
        const r = catalogs.staticDimsOf(did, kind);
        if (r && Number.isFinite(r.radius) && Number.isFinite(r.height) && r.radius > 0 && r.height > 0) {
          const src = STATIC_DIMS_SOURCES.includes(r.source) && r.source !== "default" ? r.source : "catalog";
          return [r.radius * scale, r.height * scale, src];
        }
      } catch {
        /* defaults */
      }
    }
    const def = STATIC_DEFAULT_DIMS[kind] || STATIC_DEFAULT_DIMS.prop;
    return [def[0] * scale, def[1] * scale, "default"];
  }

  /** (Re)derive a cached row's archetype, kind and size from the catalogs (in place). */
  function resolveRow(it) {
    const archetype = archetypeOf(it.did);
    const kind = staticKindOf({ isBuilding: it.isBuilding, source: it.source, archetype });
    const [radius, height, dimsSource] = staticDims(it.did, kind, it.scale);
    it.archetype = archetype;
    it.kind = kind;
    it.radius = radius;
    it.height = height;
    it.dimsSource = dimsSource;
    return it;
  }

  /**
   * A row resolved before the client's VFX catalog held its DID (archetype null)
   * or before its selection sphere landed (default size) is re-resolved when touched.
   */
  function refreshRow(it) {
    if (it.archetype === null && archetypeOf(it.did) !== null) return resolveRow(it);
    if (it.dimsSource === "default" && typeof catalogs.staticDimsOf === "function") {
      const [, , src] = staticDims(it.did, it.kind, it.scale);
      if (src !== "default") return resolveRow(it);
    }
    return it;
  }

  /** Copy one SoA table into StaticFacts rows, freeing it. */
  function adoptSoa(soa, lbKey, source, out) {
    if (!soa || typeof soa !== "object") return;
    try {
      const n = Number(get(soa, "len")) >>> 0;
      if (n === 0) return;
      const ids = get(soa, source === "scenery" ? "objIds" : "modelIds");
      const pos = get(soa, "positions");
      const sc = get(soa, "scales");
      const isB = source === "object" ? get(soa, "isBuilding") : null;
      const lbs = get(soa, "landblockIds");
      if (!ids || !pos || ids.length < n || pos.length < 3 * n) return;
      for (let i = 0; i < n; i++) {
        const lb = lbs && lbs.length > i && Number.isFinite(lbs[i]) && lbs[i] !== 0 ? (lbs[i] & 0xffff0000) >>> 0 : lbKey;
        const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
        if (![x, y, z].every(Number.isFinite)) continue;
        const did = Number(ids[i]) >>> 0;
        const scale = sc && Number.isFinite(sc[i]) && sc[i] > 0 ? sc[i] : 1;
        const isBuilding = isB ? isB[i] !== 0 : false;
        out.push(resolveRow({
          kind: "prop",
          did,
          pos: [((lb >>> 24) & 0xff) * LB_SIZE + x, ((lb >>> 16) & 0xff) * LB_SIZE + y, z],
          radius: 0,
          height: 0,
          scale,
          source,
          isBuilding,
          lbKey: lb,
          index: i,
          archetype: null,
          dimsSource: "default",
        }));
      }
    } finally {
      freeBox(soa);
      staticsCounters.freed += 1;
    }
  }

  /** Fetch one landblock's placement tables into the cache (shared promise). */
  function loadStatics(lbKey) {
    const hit = staticsCache.get(lbKey);
    if (hit) return hit.ready ? Promise.resolve() : hit.promise;
    const rec = { ready: false, items: [], promise: null };
    staticsCache.set(lbKey, rec);
    while (staticsCache.size > STATICS_CACHE_LANDBLOCKS) {
      const oldest = staticsCache.keys().next().value;
      if (oldest === lbKey) break;
      staticsCache.delete(oldest);
    }
    rec.promise = (async () => {
      const ids = Uint32Array.of((lbKey | 0xfffe) >>> 0);
      const items = [];
      const tables = [
        ["object", "fetch_landblock_objects_soa"],
        ["scenery", "fetch_landblock_scenery_soa"],
      ];
      for (const [source, fn] of tables) {
        if (!wasm || typeof wasm[fn] !== "function") continue;
        let soa = null;
        try {
          staticsCounters.fetches += 1;
          soa = await wasm[fn](ids);
        } catch (e) {
          staticsCounters.failures += 1;
          emit({ level: "warn", message: `${fn} failed for 0x${lbKey.toString(16)}`, error: e && e.message ? e.message : String(e) });
          continue;
        }
        adoptSoa(soa, lbKey, source, items);
      }
      // Real sizes (selection spheres) for this landblock's models, then re-resolve the rows.
      if (items.length && typeof catalogs.prefetchStaticDims === "function") {
        try {
          await catalogs.prefetchStaticDims([...new Set(items.map((it) => it.did))]);
        } catch (e) {
          emit({ level: "warn", message: `static size prefetch failed for 0x${lbKey.toString(16)}`, error: e && e.message ? e.message : String(e) });
        }
        for (const it of items) resolveRow(it);
      }
      rec.items = items;
      rec.ready = true;
    })();
    return rec.promise;
  }

  /** Landblock keys a disc touches (capped at STATICS_MAX_LANDBLOCKS, nearest first). */
  function lbKeysAround(c, R) {
    const x0 = Math.max(0, Math.floor((c[0] - R) / LB_SIZE)), x1 = Math.min(255, Math.floor((c[0] + R) / LB_SIZE));
    const y0 = Math.max(0, Math.floor((c[1] - R) / LB_SIZE)), y1 = Math.min(255, Math.floor((c[1] + R) / LB_SIZE));
    const keys = [];
    const cx = Math.floor(c[0] / LB_SIZE), cy = Math.floor(c[1] / LB_SIZE);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push([Math.max(Math.abs(x - cx), Math.abs(y - cy)), ((x << 24) | (y << 16)) >>> 0]);
    keys.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return keys.slice(0, STATICS_MAX_LANDBLOCKS).map((k) => k[1]);
  }

  /** Filter cached items of the given landblocks near c. */
  function collectStatics(keys, c, R) {
    const out = [];
    for (const k of keys) {
      const rec = staticsCache.get(k);
      if (!rec || !rec.ready) continue;
      for (const it of rec.items) {
        const pad = R + Math.max(it.radius, STATIC_DEFAULT_DIMS.building[0]) + 1;
        if (Math.abs(it.pos[0] - c[0]) > pad || Math.abs(it.pos[1] - c[1]) > pad) continue;
        refreshRow(it);
        if (Math.abs(it.pos[0] - c[0]) > R + it.radius + 1 || Math.abs(it.pos[1] - c[1]) > R + it.radius + 1) continue;
        const dist = bodyDistance(c, it.pos, it.radius, it.height);
        if (dist <= R) out.push({ ...it, pos: it.pos.slice(), distance: dist });
      }
    }
    out.sort((a, b) => a.distance - b.distance || a.lbKey - b.lbKey || a.index - b.index || (a.source < b.source ? -1 : 1));
    return out;
  }

  /**
   * Static placements near a point, fetching their landblocks first. The
   * landblocks load CONCURRENTLY: each load ends with a size prefetch bounded by
   * the catalogs' timeout (stalled DIDs are not waited for again), so one query
   * waits about one such bound, not one per landblock (≤ STATICS_MAX_LANDBLOCKS).
   * @param {number[]|{x:number,y:number,z:number}} center
   * @param {number} radius
   * @returns {Promise<StaticFacts[]>}
   */
  async function staticsNear(center, radius) {
    const c = vec(center);
    if (!c) return [];
    const R = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    const keys = lbKeysAround(c, R);
    await Promise.all(keys.map((k) => loadStatics(k).catch(() => {
      /* recorded per table */
    })));
    return collectStatics(keys, c, R);
  }

  /**
   * Static placements near a point from CACHED landblocks only; missing landblocks
   * are fetched in the background for later calls.
   * @param {number[]|{x:number,y:number,z:number}} center
   * @param {number} radius
   * @returns {StaticFacts[]}
   */
  function staticsNearCached(center, radius) {
    const c = vec(center);
    if (!c) return [];
    const R = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    const keys = lbKeysAround(c, R);
    for (const k of keys) {
      if (!staticsCache.has(k)) loadStatics(k).catch(() => {});
    }
    return collectStatics(keys, c, R);
  }

  // --- ground, cells ------------------------------------------------------------

  const pendingGround = new Set();

  /**
   * Ground height at (x, y): terrainHeightAt, then the corridor; null when unknown.
   * @param {number} x @param {number} y
   * @returns {number|null}
   */
  function groundZ(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (sh && typeof sh.terrainHeightAt === "function") {
      try {
        const z = sh.terrainHeightAt(x, y);
        if (typeof z === "number" && Number.isFinite(z)) return z;
      } catch {
        /* fall through to the corridor */
      }
    }
    const z = corridor && typeof corridor.heightAt === "function" ? corridor.heightAt(x, y) : null;
    if (typeof z === "number" && Number.isFinite(z)) return z;
    const lbX = Math.floor(x / LB_SIZE), lbY = Math.floor(y / LB_SIZE);
    if (lbX >= 0 && lbX <= 255 && lbY >= 0 && lbY <= 255 && corridor && typeof corridor.ensure === "function") {
      const k = ((lbX << 24) | (lbY << 16)) >>> 0;
      if (!pendingGround.has(k)) {
        pendingGround.add(k);
        Promise.resolve()
          .then(() => corridor.ensure([k]))
          .catch(() => {})
          .finally(() => pendingGround.delete(k));
      }
    }
    return null;
  }

  /** @type {Map<number, number[]>} indoor cell → last point resolved inside it */
  const cellPoints = new Map();

  /**
   * Cell containing a point (see createWorldQuery).
   * @param {number[]|{x:number,y:number,z:number}} point
   * @param {number|{cell:number, from?:number[]}} [hintCell]
   * @returns {number} full cell id, 0 when unknown
   */
  function cellAt(point, hintCell) {
    const p = vec(point);
    if (!p) return 0;
    let hint = 0;
    let from = null;
    if (typeof hintCell === "number" && Number.isFinite(hintCell)) hint = hintCell >>> 0;
    else if (hintCell && typeof hintCell === "object") {
      if (Number.isFinite(hintCell.cell)) hint = hintCell.cell >>> 0;
      from = vec(hintCell.from);
    }
    const lo = hint & 0xffff;
    const indoor = lo >= 0x0100 && lo <= 0xfffd;
    if (!indoor) return localFromWorld(p[0], p[1], p[2]).cellId;
    const start = from || cellPoints.get(hint) || null;
    if (!start || !sh || typeof sh.resolveViewerCell !== "function") return hint;
    let c = 0;
    try {
      c = Number(sh.resolveViewerCell(start[0], start[1], start[2], p[0], p[1], p[2], 0.3, hint)) >>> 0;
    } catch {
      c = 0;
    }
    if (c === 0) return hint;
    const clo = c & 0xffff;
    if (clo >= 0x0100 && clo <= 0xfffd) {
      cellPoints.set(c, p.slice());
      while (cellPoints.size > 512) cellPoints.delete(cellPoints.keys().next().value);
    }
    return c;
  }

  /**
   * Record a point known to lie in an indoor cell (seeds cellAt walks, e.g. from the plan's cell).
   * @param {number} cell @param {number[]} point
   * @returns {boolean}
   */
  function noteCellPoint(cell, point) {
    const p = vec(point);
    if (!p || !Number.isFinite(cell)) return false;
    cellPoints.set(cell >>> 0, p);
    return true;
  }

  // --- hit refinement -------------------------------------------------------------

  /** @type {Map<string, {key:string, kind:string, did:number, pos:number[], source:string, lbKey:number, index:number}>} */
  const fadeables = new Map();

  /** Remember the placement a fade key names (FIFO, STATIC_FADE_KEYS_MAX). */
  function rememberFadeable(key, it) {
    fadeables.delete(key);
    fadeables.set(key, { key, kind: it.kind, did: it.did >>> 0, pos: it.pos.slice(), source: it.source, lbKey: it.lbKey >>> 0, index: it.index });
    while (fadeables.size > STATIC_FADE_KEYS_MAX) fadeables.delete(fadeables.keys().next().value);
  }

  /**
   * May the placement a statics / building hit names be faded? Only a placed tree
   * or a small prop, both of KNOWN size (never the defaults: the score divides by
   * the radius), hit inside its radius, with no other placement nearly as central
   * (STATIC_HIT_RULES). Anything else → no fade key → the pilot reroutes.
   */
  function fadeableHit(kind, best, runnerScore) {
    const R = STATIC_HIT_RULES;
    const it = best.it;
    if (it.isBuilding || !FADEABLE_STATIC_KINDS.includes(kind) || !FADEABLE_STATIC_SOURCES.includes(it.source)) return false;
    if (it.dimsSource === "default") return false;
    if (!(best.score <= R.maxScore)) return false;
    if (runnerScore - best.score < R.ambiguity) return false;
    if (kind === "prop" && Math.max(it.radius, it.height / 2) > R.propMaxSize) return false;
    return true;
  }

  /** The catalog's physics-collider reach (m, model space) of a DID, or null. */
  function colliderModelOf(did) {
    if (typeof catalogs.staticColliderOf !== "function") return null;
    try {
      const v = catalogs.staticColliderOf(did);
      const r = v && typeof v === "object" ? Number(v.radius) : Number(v);
      return Number.isFinite(r) && r > 0 ? r : null;
    } catch {
      return null;
    }
  }

  /** Stable order of two placement rows (lbKey, index). */
  const rowOrder = (a, b) => a.lbKey - b.lbKey || a.index - b.index;

  /**
   * The scenery placement that LABELS a collider hit (SCENERY_HIT_RULES): the
   * nearest axis among the rows that could own the hit (within their collider
   * reach, on the right side of the normal), else the absolute-nearest axis of
   * all; null when there is no usable row. A label only — never a fade key.
   * @returns {StaticFacts|null}
   */
  function sceneryLabelRow(p, normal, rows) {
    const S = SCENERY_HIT_RULES;
    const better = (a, b) => !b || a.axis < b.axis || (a.axis === b.axis && rowOrder(a.it, b.it) < 0);
    let fit = null;
    let nearest = null;
    for (const it of rows) {
      const axis = staticAxisDistance(p, it);
      if (!Number.isFinite(axis)) continue;
      const row = { it, axis };
      if (better(row, nearest)) nearest = row;
      if (axis > sceneryColliderReach(it, colliderModelOf(it.did)) + S.slackM) continue;
      if (colliderSideFit(p, normal, it) === false) continue;
      if (better(row, fit)) fit = row;
    }
    const pick = fit ?? nearest;
    return pick ? pick.it : null;
  }

  /**
   * Refine a los.js hit's kind from what sits near its point.
   * @param {{layer?:string, point?:number[], normal?:number[], kind?:string}} hit
   * @param {{indoor?:boolean}} [opts]
   * @returns {{kind:string|null, guid:number|null, did:number|null, fadeKey:string|null}}
   */
  function describeHit(hit, opts = {}) {
    const h = hit && typeof hit === "object" ? hit : {};
    const layer = normalizeLayerName(h.layer);
    const indoor = opts && opts.indoor === true;
    if (!layer) return { kind: typeof h.kind === "string" ? h.kind : null, guid: null, did: null, fadeKey: null };
    const p = vec(h.point);
    let refined = null;
    let guid = null;
    let did = null;
    /** Statics / building pick, judged by fadeableHit once the kind is known (the only fade-key source). */
    let boundsPick = null;
    if (p && (layer === "objects" || layer === "entities")) {
      const near = entitiesNear(p, 1.5, { includeLocal: false, limit: 1 });
      if (near.length) {
        refined = near[0].obstacleKind;
        guid = near[0].guid;
      }
    } else if (p && layer === "scenery") {
      // Collider hits (trunk cylspheres / boulder spheres): LABEL only — the
      // absolute-nearest axis that could own the hit. Never a fade key (v1): the
      // CollisionHit names no placement, and a wrong key fades a neighbour while the
      // real collider still blocks (a false clear view). The pilot reroutes instead.
      const row = sceneryLabelRow(p, vec(h.normal), staticsNearCached(p, 4).filter((it) => it.source === "scenery"));
      if (row) {
        refined = row.kind;
        did = row.did;
      }
    } else if (p && (layer === "statics" || layer === "buildingMesh")) {
      const want = layer === "statics" ? (it) => it.source === "object" && !it.isBuilding : (it) => it.isBuilding;
      // Render-bounds hits: the placement whose axis is nearest relative to its radius —
      // NOT the nearest surface (0 for every body containing the point, so overlapping
      // neighbours tied).
      const ranked = staticsNearCached(p, 4)
        .filter(want)
        .map((it) => ({ it, score: staticHitScore(p, it) }))
        .sort((a, b) => a.score - b.score || a.it.distance - b.it.distance || rowOrder(a.it, b.it));
      if (ranked.length) {
        boundsPick = { best: ranked[0], runnerScore: ranked.length > 1 ? ranked[1].score : Infinity };
        refined = ranked[0].it.kind === "building" && indoor ? "wall" : ranked[0].it.kind;
        did = ranked[0].it.did;
      }
    }
    const kind = refined === "player" ? "player" : kindForLayer(layer, { kind: refined ?? undefined, normal: h.normal, indoor });
    /** The placement a fade key names (null = never faded: always for entities and scenery). */
    const keyRow = boundsPick && fadeableHit(kind, boundsPick.best, boundsPick.runnerScore) ? boundsPick.best.it : null;
    let fadeKey = null;
    if (keyRow && FADEABLE_STATIC_KINDS.includes(kind) && FADEABLE_STATIC_SOURCES.includes(keyRow.source)) {
      fadeKey = staticFadeKey(keyRow);
      if (fadeKey) rememberFadeable(fadeKey, keyRow);
    }
    return { kind, guid, did, fadeKey };
  }

  // --- static fade targets ----------------------------------------------------------

  /**
   * The placement a fade key names: remembered by describeHit, else found in the
   * statics cache. Null for a key of a table that never fades (a scenery key —
   * describeHit never issues one; a hand-made one hides nothing).
   */
  function placementOfKey(key) {
    const m = parseStaticFadeKey(key);
    if (!m || !FADEABLE_STATIC_SOURCES.includes(m.source)) return null;
    const known = fadeables.get(key);
    if (known) return known;
    for (const rec of staticsCache.values()) {
      if (!rec || !rec.ready) continue;
      for (const it of rec.items) {
        if (it.index === m.index && it.source === m.source && it.lbKey >>> 0 === m.lbKey) {
          refreshRow(it);
          return { key, kind: it.kind, did: it.did >>> 0, pos: it.pos.slice(), source: it.source, lbKey: it.lbKey >>> 0, index: it.index };
        }
      }
    }
    return null;
  }

  /** Point (x, y, z) through a column-major 4×4 `elements` array (identity when absent). */
  function xform(e, x, y, z) {
    if (!e || typeof e.length !== "number" || e.length < 16) return [x, y, z];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = Number.isFinite(w) && Math.abs(w) > 1e-12 ? 1 / w : 1;
    return [(e[0] * x + e[4] * y + e[8] * z + e[12]) * iw, (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw, (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw];
  }

  /** Local matrix elements of a node (null = identity). */
  function localElements(node) {
    const e = node && node.matrix && node.matrix.elements;
    return e && typeof e.length === "number" && e.length >= 16 ? e : null;
  }

  function atPlacement(q, P) {
    return !!q && Math.abs(q[0] - P.pos[0]) <= STATIC_MATCH_TOL.xy && Math.abs(q[1] - P.pos[1]) <= STATIC_MATCH_TOL.xy &&
      Math.abs(q[2] - P.pos[2]) <= STATIC_MATCH_TOL.z;
  }

  /** Instance indices of an InstancedMesh whose translation sits on the placement. */
  function instancesAt(mesh, P) {
    const arr = mesh && mesh.instanceMatrix && mesh.instanceMatrix.array;
    if (!arr || typeof arr.length !== "number") return [];
    const n = Math.min(Number.isInteger(mesh.count) ? mesh.count : Math.floor(arr.length / 16), Math.floor(arr.length / 16));
    const e = localElements(mesh);
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = 16 * i;
      if (atPlacement(xform(e, arr[o + 12], arr[o + 13], arr[o + 14]), P)) out.push(i);
    }
    return out;
  }

  /** Visible BatchedMesh instance ids whose translation sits on the placement. */
  function batchInstancesAt(bm, P) {
    if (typeof bm.getMatrixAt !== "function" || typeof bm.setVisibleAt !== "function") return [];
    const n = Array.isArray(bm._instanceInfo) ? bm._instanceInfo.length
      : Number.isInteger(bm.maxInstanceCount) ? bm.maxInstanceCount : 0;
    const e = localElements(bm);
    const sink = {
      elements: new Array(16).fill(0),
      fromArray(a, off = 0) {
        for (let k = 0; k < 16; k++) this.elements[k] = a[off + k];
        return this;
      },
    };
    const out = [];
    for (let i = 0; i < n; i++) {
      try {
        bm.getMatrixAt(i, sink);
        if (typeof bm.getVisibleAt === "function" && bm.getVisibleAt(i) === false) continue;
      } catch {
        continue; // deleted / out-of-range id
      }
      const m = sink.elements;
      if (atPlacement(xform(e, m[12], m[13], m[14]), P)) out.push(i);
    }
    return out;
  }

  /**
   * Live draws of the placement a fade key names (see createWorldQuery).
   * @param {string} key
   * @returns {{key:string, kind:string, did:number, pos:number[], targets:object[]}|null}
   */
  function staticFadeTargets(key) {
    const P = placementOfKey(key);
    if (!P) return null;
    const group = live && live.staticsGroup && typeof live.staticsGroup === "object" ? live.staticsGroup : null;
    const kids = group && Array.isArray(group.children) ? group.children : [];
    const targets = [];
    for (const node of kids) {
      if (!node || typeof node !== "object" || node.isLight) continue;
      const ud = node.userData && typeof node.userData === "object" ? node.userData : {};
      if (ud.__particle === true || ud.isParticleInstanced === true || ud.isStaticScriptAnchor === true) continue;
      // The shared buckets of instanced animated scenery are rewritten by its rAF every frame:
      // never a target. Their per-placement ANCHOR (isAnimatedScenery + instanced) is — the
      // animator collapses a hidden anchor's slots (animated_scenery.js _anchorVisible).
      if (ud.isAnimatedSceneryInstanced === true) continue;
      const mid = Number(ud.modelId);
      if (Number.isFinite(mid) && mid !== 0 && P.did !== 0 && mid >>> 0 !== P.did) continue;
      try {
        if (node.isBatchedMesh) {
          for (const id of batchInstancesAt(node, P)) targets.push({ type: "batch", mesh: node, instanceId: id });
        } else if (node.isInstancedMesh) {
          const hits = instancesAt(node, P);
          if (hits.length && node.count === 1) targets.push({ type: "node", node });
          else for (const i of hits) targets.push({ type: "instance", mesh: node, index: i });
        } else if (node.isLOD && ud.isInstancedLod === true) {
          const levels = Array.isArray(node.levels) ? node.levels : [];
          for (const lv of levels) {
            const m = lv && lv.object;
            if (m && m.isInstancedMesh) for (const i of instancesAt(m, P)) targets.push({ type: "instance", mesh: m, index: i });
          }
        } else if (atPlacement(vec(node.position), P)) {
          targets.push({ type: "node", node });
        }
      } catch {
        /* a node mid-dispose: skip it */
      }
    }
    return { key, kind: P.kind, did: P.did, pos: P.pos.slice(), targets };
  }

  return {
    entitiesNear,
    subject,
    localPlayer,
    staticsNear,
    staticsNearCached,
    /**
     * Particle clouds near a point — particles_query `near` rows made JSON-safe
     * (the live `emitter` / `manager` references are dropped; use
     * `particles.near` directly when the runtime needs them, e.g. to hide one).
     * @param {number[]|{x:number,y:number,z:number}} center
     * @param {number} radius
     * @returns {{key:string, family:string|null, behavior:string|null, occludes:boolean, additive:boolean,
     *   center:number[], radius:number, density:number, range:number, did:number, emitterId:number,
     *   ownerKey:number|string|null}[]}
     */
    particlesNear(center, radius) {
      let rows = [];
      try {
        rows = particles.near(center, radius) || [];
      } catch {
        rows = [];
      }
      return rows.map((r) => {
        const { emitter: _e, manager: _m, ...rest } = r;
        return rest;
      });
    },
    groundZ,
    cellAt,
    noteCellPoint,
    describeHit,
    staticFadeTargets,
    /** @returns {Uint32Array|null} renderSetCells(sessionHandle) */
    renderSetCells: () => renderSetCells(sh),
    localGuid,
    corridor,
    particles,
    /** @returns {{statics:{fetches:number, freed:number, failures:number, landblocks:number}, history:number}} */
    stats() {
      return { statics: { ...staticsCounters, landblocks: staticsCache.size }, history: history.size };
    },
    /** Drop every cache (after a teleport). */
    reset() {
      staticsCache.clear();
      history.clear();
      cellPoints.clear();
      fadeables.clear();
    },
  };
}
