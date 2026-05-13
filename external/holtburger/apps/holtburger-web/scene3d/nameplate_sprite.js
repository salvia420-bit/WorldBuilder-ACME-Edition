// scene3d/nameplate_sprite.js — Task #13: 3D nameplate via THREE.Sprite.
//
// Pairs with the existing DOM overlay (`hud.js`). Both paths can coexist
// without conflict — the DOM overlay walks a separate `nameplateLayer.nodes`
// map and writes its own `<div>` tree; the sprite path lives entirely
// inside the entity's three.js Object3D tree and is parented to
// `EntityInstance.root` so it auto-follows the rig with no per-frame
// projection.
//
// Why a sprite parented to the entity root:
//   1. No per-frame DOM thrash. Sprite world position is updated for free
//      by three.js's matrixWorld walk; the camera projection happens once
//      per draw call inside the GPU sprite shader.
//   2. Depth-tests against world geometry by default — sprites occluded
//      by a wall stay invisible without our help, matching player
//      expectations. (DOM nameplates always punch through, which can
//      look uncanny indoors.)
//   3. Works the same regardless of which camera the cameraSwitcher
//      activates (follow / orbit / top-down). The sprite always faces
//      the active camera because that's what `THREE.Sprite` does.
//
// Coordinate notes:
//   - `worldRoot.rotation.x = -π/2` rotates AC (Z-up) into three.js (Y-up).
//   - `EntityInstance.root` is a child of `worldRoot.entitiesGroup`, with
//     position set via `setPose(x,y,z,…)` in AC coordinates AND a
//     quaternion that rotates the rig around the AC z-axis. Because the
//     rig only yaws (no roll/pitch in AC's wire format), the entity-LOCAL
//     +Z direction is still the world-up direction in three.js after the
//     worldRoot rotation. Setting `sprite.position.z = HEAD_HEIGHT_AC`
//     in entity-local frame therefore lifts the nameplate vertically in
//     three.js world.
//   - Sprites are scale-by-distance by default in three.js
//     (they're 2D quads in NDC after projection). We use a world-space
//     scale so the nameplate's apparent size matches a fixed real-world
//     metre-height when viewed from the typical camera distance. With
//     `sprite.scale.set(2.0, 0.5, 1)` and a 256x64 canvas texture at a
//     ~5m camera distance, text reads ~24px on a 1280px-wide viewport.
//
// Memory:
//   - One CanvasTexture per unique name. We cache by name so 10 Sparring
//     Golems all share one texture.
//   - One SpriteMaterial per texture (shared the same way — the texture
//     itself is the load-bearing GPU resource).
//   - One Sprite per entity (cheap; just a transform + a Plane geometry
//     under the hood).
//
// Lifecycle:
//   - `ensureNameplateForEntity(inst, scene3d)` is called from
//     EntityManager._spawnImpl right before `entitiesGroup.add(root)`.
//     Idempotent — re-call on the same entity replaces the sprite if
//     the name changed.
//   - `inst.dispose()` removes the entity root from `entitiesGroup`,
//     which removes the sprite alongside it. Per-entity sprite materials
//     and textures live in shared caches (don't dispose on entity
//     teardown — they're reused).

import * as THREE from "three";

// AC's character rig is ~1.8 m crown-to-feet (rough average). Lift to
// ~2.2 m so the nameplate sits well above the head with a small air
// gap. We measure in AC coordinates (Z-up); +Z in entity-local maps
// to +Y in three-world after the worldRoot rotation.
const NAMEPLATE_AC_Z_OFFSET = 2.2;

// Sprite scale in world units. Combined with a 256x64 canvas texture,
// this gives a 2 m × 0.5 m on-screen rectangle in the world — at a
// typical 5 m third-person camera distance, the text reads roughly
// 24 px tall on a 1280 px viewport. The aspect ratio 4:1 must match
// the canvas aspect or text will stretch.
const NAMEPLATE_WORLD_WIDTH = 2.0;
const NAMEPLATE_WORLD_HEIGHT = 0.5;

// Canvas dimensions for the baked text. Power-of-two on width keeps
// WebGL filtering happy. 256x64 is the smallest size that renders
// 32 px bold text without subpixel aliasing — measured against the
// 2D PIXI path's 13 px monospace.
const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 64;

// Per-name texture cache. Two NPCs with the same display name share one
// CanvasTexture / SpriteMaterial — saves an allocation per entity in
// areas with grouped enemies (Sparring Golems, Drudges, etc.). Cleared
// on `disposeNameplateCache` (capture-script support) but otherwise
// retained for the session.
//
// Key shape: `${name}|${colorHex}` — same name in two categories needs
// two textures because the text fill colour differs.
/** @type {Map<string, { texture: THREE.CanvasTexture, material: THREE.SpriteMaterial }>} */
const _nameplateCache = new Map();

// ITEM_TYPE bit constants mirrored from `index.html:2771` (the 2D PIXI
// path). We only need the bits the nameplate-colour switch reads.
const ITEM_TYPE_CREATURE = 0x00000010;
const ITEM_TYPE_PORTAL = 0x00010000;
const ITEM_TYPE_LIFE_STONE = 0x04000000;
const ITEM_TYPE_CONTAINER = 0x00000200;
const ITEM_TYPE_WRITABLE = 0x00100000;
const ITEM_TYPE_MELEE_WEAPON = 0x00000001;
const ITEM_TYPE_MISSILE_WEAPON = 0x00000100;
const ITEM_TYPE_CASTER = 0x00200000;
const ITEM_TYPE_ARMOR = 0x00000002;
const ITEM_TYPE_CLOTHING = 0x00000004;

/**
 * Map an itemType bitmask to a coarse visual category. Mirrors
 * `categoryForItemType` (`index.html:2799`). Used by
 * `nameplateColorForCategory` to pick text fill.
 */
export function categoryForItemType(itemType) {
  const t = (itemType >>> 0);
  if (!t) return "unknown";
  if (t & ITEM_TYPE_PORTAL) return "portal";
  if (t & ITEM_TYPE_LIFE_STONE) return "lifestone";
  if (t & ITEM_TYPE_CREATURE) return "creature";
  if (t & ITEM_TYPE_CONTAINER) return "container";
  if (t & (ITEM_TYPE_MELEE_WEAPON | ITEM_TYPE_MISSILE_WEAPON | ITEM_TYPE_CASTER)) return "weapon";
  if (t & (ITEM_TYPE_ARMOR | ITEM_TYPE_CLOTHING)) return "armor";
  if (t & ITEM_TYPE_WRITABLE) return "writable";
  return "misc";
}

/**
 * Map a category string to a CSS-style colour for the nameplate's text
 * fill. Mirrors `nameplateColorForCategory` (`index.html:3558`) but
 * returns a `#rrggbb` string instead of a u24 — Canvas 2D API wants
 * CSS strings.
 */
export function nameplateColorForCategory(category) {
  switch (category) {
    case "creature":  return "#e07070";
    case "portal":    return "#6ec8e0";
    case "lifestone": return "#4da0e8";
    case "container": return "#cda060";
    case "writable":  return "#e09a3f";
    case "weapon":
    case "armor":     return "#c8c8b0";
    default:          return "#ffffff";
  }
}

/**
 * Bake a name string + colour into a CanvasTexture + SpriteMaterial.
 * Cached by (name, colour) tuple so repeat names reuse one GPU resource.
 *
 * Layout: black 50%-alpha rounded rectangle background filling the
 * canvas, white-or-coloured text centred. 32 px bold monospace + 4 px
 * black outline (the 2D path uses a 3 px stroke at 13 px font — the
 * sprite's larger canvas means we scale the stroke proportionally so
 * the rendered text matches readability when downscaled).
 */
function getOrBakeNameplateMaterial(name, colorHex) {
  const cacheKey = `${name}|${colorHex}`;
  const hit = _nameplateCache.get(cacheKey);
  if (hit) return hit;

  // Capture-script standalone path: `document` may be undefined in pure
  // Node test harnesses. Return null so the spawn path skips creation.
  // The real browser path always has document.
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Background. Rounded rectangle filling the canvas with 8 px corner
  // radius and a thin 1px stroke for definition. Drawn first so text
  // composites on top.
  const padding = 4;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  // roundRect is r166+ on canvas2d; three.js 0.184 implies a modern
  // browser, but feature-detect anyway in case of an unusual host.
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(padding, padding, CANVAS_WIDTH - padding * 2, CANVAS_HEIGHT - padding * 2, 8);
    ctx.fill();
  } else {
    ctx.fillRect(padding, padding, CANVAS_WIDTH - padding * 2, CANVAS_HEIGHT - padding * 2);
  }

  // Text. Bold 32 px monospace per task brief, centre-aligned with a
  // black outline so it stays legible on bright backgrounds (sky,
  // snow, lit interiors). Text fill colour comes from caller (category-
  // coded).
  ctx.font = "bold 32px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#000000";
  ctx.lineJoin = "round";
  // Outline first, fill second — that's the standard "knockout"
  // pattern that gets you a clean stroke without the half-pixel
  // antialiasing of a fill-then-stroke order.
  ctx.strokeText(name, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
  ctx.fillStyle = colorHex;
  ctx.fillText(name, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  // Sprites are GUI-ish; nearest-neighbour magnification would look
  // pixelated when the camera dollies in. Linear filtering keeps the
  // bake crisp at any zoom.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // Prevent the texture from interfering with the scene's renderer
  // colorSpace expectations. Sprites composite over the scene; SRGB
  // is the right choice for direct-color output.
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    // depthTest=true makes the sprite hide behind world geometry that's
    // in front of it (a wall, a building corner). depthWrite=false so
    // overlapping nameplates don't z-fight each other. This is the
    // standard "labels on a 3D scene" recipe.
    depthTest: true,
    depthWrite: false,
    // sizeAttenuation=true (default) — sprite gets smaller in the
    // distance, like a real billboard. Keeps the nameplate's apparent
    // size proportional to the rig as the player moves away.
    sizeAttenuation: true,
    // Render after opaque geometry so depth-test against opaque is
    // still correct (depth buffer already filled).
    toneMapped: false,
  });
  material.name = `nameplate-${cacheKey}`;

  const entry = { texture, material };
  _nameplateCache.set(cacheKey, entry);
  return entry;
}

/**
 * Build a THREE.Sprite carrying the rendered nameplate. Public so
 * tests and capture scripts can construct one in isolation.
 *
 * Returns null when `document` is unavailable (no-DOM harness) or the
 * name string is empty — both are signals to skip nameplate creation.
 *
 * @param {string} name — the display string. Empty → null returned.
 * @param {object} options
 * @param {number} [options.itemType] — wire ItemType bitmask. Used to
 *   pick the text colour; 0 ⇒ neutral white.
 * @param {string} [options.color] — explicit colour override. Wins over
 *   itemType when set.
 * @returns {THREE.Sprite | null}
 */
export function createNameplateSprite(name, options = {}) {
  if (!name || typeof name !== "string" || name.length === 0) return null;
  const category = options.color
    ? null
    : categoryForItemType((options.itemType >>> 0) | 0);
  const colorHex = options.color || nameplateColorForCategory(category);
  const baked = getOrBakeNameplateMaterial(name, colorHex);
  if (!baked) return null;
  const sprite = new THREE.Sprite(baked.material);
  sprite.name = `nameplate_${name}`;
  // World-space size. The same Sprite reused across the scene will
  // render at this metre-size at every camera distance (modulo
  // perspective shrink with `sizeAttenuation: true`).
  sprite.scale.set(NAMEPLATE_WORLD_WIDTH, NAMEPLATE_WORLD_HEIGHT, 1);
  // Render order: high enough to win against the world-geometry pass
  // when depthTest is true and the geometry passes. Doesn't matter for
  // depthTest=true rendering against opaque, but is the right knob to
  // turn if we ever flip to depthTest=false for "X-ray" nameplates.
  sprite.renderOrder = 10;
  // Stash the source name on userData so capture scripts can read it
  // back without parsing canvas pixels. The capture asserts
  // `sprite.userData.nameplateText === entity.meta.name`.
  sprite.userData = { nameplateText: name, color: colorHex };
  return sprite;
}

/**
 * Attach a nameplate sprite to an entity's root Group. Idempotent on
 * re-call: replaces the existing sprite if the name changed; no-ops if
 * the name + colour are unchanged.
 *
 * Skip conditions:
 *   - No `meta.name` (unnamed item — typical for some loot drops).
 *   - Entity is the local player (their head is the camera anchor; the
 *     2D path's `ensureNameplate` skips localPlayer for the same reason
 *     at `index.html:3596`).
 *   - Entity is an inventory item (cellId low 16 == 0, no LB anchor).
 *     The 2D path doesn't filter this directly because inventory items
 *     never get sprites either; we mirror the check explicitly to be
 *     safe.
 *
 * @param {object} inst — `EntityInstance` from EntityManager. Must
 *   carry `.root` (THREE.Group) and `.meta`.
 * @param {object} scene3d — the scene3d handle; reserved for future
 *   per-scene customisation (e.g. a renderer-level "hide all
 *   nameplates" toggle). Currently unused.
 * @returns {THREE.Sprite | null} the attached sprite (or null on skip).
 */
export function ensureNameplateForEntity(inst, scene3d) {
  if (!inst || !inst.root || !inst.meta) return null;
  const meta = inst.meta;
  const name = (meta && typeof meta.name === "string") ? meta.name : "";
  if (!name) return null;

  // Local-player skip. The 2D path looks at `localPlayerGuid` for
  // the same check; on the 3D path the equivalent is exposed via
  // `window.getLocalPlayerGuid()` (set by the 2D bootstrap). Wrapped
  // in try/catch because the function may not exist in some standalone
  // capture paths.
  try {
    if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
      const lpg = window.getLocalPlayerGuid();
      if (lpg !== null && lpg !== undefined && (lpg >>> 0) === (inst.guid >>> 0)) {
        return null;
      }
    }
  } catch (_) {}

  // Inventory-item skip. Inventory entities have a landblockId of 0
  // (or 0x00000000_xxxx_xxxx with the LB high bytes empty). The wire's
  // `landblockId` is the cell-id form: high 16 bits is the LB key.
  // landblockId === 0 ⇒ no anchor in the world ⇒ not visible anyway.
  const lbHigh = ((meta.landblockId >>> 0) & 0xffff0000) >>> 0;
  if (lbHigh === 0) return null;

  // Re-bake check: was a sprite already attached?
  const existing = inst._nameplateSprite || null;
  if (existing) {
    const prevText = existing.userData && existing.userData.nameplateText;
    if (prevText === name) {
      // Same name as before — keep the existing sprite, no work.
      return existing;
    }
    // Name changed (kind=3 MetaRefresh path). Remove the old sprite
    // before attaching a fresh one — the material is shared via the
    // per-name cache so we don't dispose it; just detach.
    try {
      existing.parent && existing.parent.remove(existing);
    } catch (_) {}
    inst._nameplateSprite = null;
  }

  const sprite = createNameplateSprite(name, { itemType: meta.itemType >>> 0 });
  if (!sprite) return null;
  // Position is in the entity's LOCAL frame. The entity root carries a
  // yaw quaternion (rotation about AC +Z), but +Z in entity-local is
  // still +Z in world (yaw doesn't tilt the Z axis), so a Z offset
  // here ends up vertically above the rig in three-world after the
  // worldRoot.rotation.x = -π/2 conversion. Y in entity-local sits in
  // the AC horizontal plane and is rotated by the entity's yaw — we
  // leave Y at 0 so the sprite is centred over the rig regardless of
  // facing.
  sprite.position.set(0, 0, NAMEPLATE_AC_Z_OFFSET);

  inst.root.add(sprite);
  inst._nameplateSprite = sprite;
  return sprite;
}

/**
 * Test / capture helper — clear the per-name texture+material cache.
 * Called from capture scripts that want to verify per-name allocation
 * behaviour without process-restart. Disposes the GPU resources too.
 */
export function disposeNameplateCache() {
  for (const entry of _nameplateCache.values()) {
    try { entry.texture.dispose(); } catch (_) {}
    try { entry.material.dispose(); } catch (_) {}
  }
  _nameplateCache.clear();
}

/** Read-only access to the cache for diagnostic scripts. */
export function getNameplateCacheSize() {
  return _nameplateCache.size;
}
