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

// Sprite world-space height. The canvas-pixel width is now computed
// per-name via `ctx.measureText` (Follow-on Task 33 — Bug A fix), and
// the world-space width derives from that measurement so the sprite's
// aspect ratio always matches the canvas's. Constant height preserves
// the familiar "label band sits this far above the head" tuning.
//
// History: this used to be `NAMEPLATE_WORLD_WIDTH = 2.0` paired with a
// fixed `CANVAS_WIDTH = 256`. Long names like "Hudriffa the Shopkeeper"
// (≈ 25 chars × 18px ≈ 450 px at 32 px bold monospace) overflowed the
// 256-px canvas. centre-aligned text drew at canvas-x = 128, so both
// ends clipped (visible in `docs/world-completeness-demo-2026-05-14/
// 01-hudriffa-shopkeeper.png` as "ffa the Shopk").
const NAMEPLATE_WORLD_HEIGHT = 0.5;

// Pixels-per-world-metre conversion at the bake font size. With a 32 px
// bold monospace cap-height and `NAMEPLATE_WORLD_HEIGHT = 0.5 m`, the
// world-to-canvas scale is 128 px/m on the height axis. Apply the same
// ratio horizontally so the text reads at the same density along both
// axes (no horizontal stretch / squish).
const NAMEPLATE_PX_PER_METRE = 128;

// Canvas height stays fixed — the font baseline is centred at canvas
// midline and the cap-height + 4 px outline + 4 px padding tuck into
// 64 px cleanly. Width is computed per-name.
const CANVAS_HEIGHT = 64;

// Minimum canvas width so single-character names (rare; default-name
// fallbacks like "?") still get a readable rounded-rect background.
// 64 px = ≈ 0.5 m of world width at the 128 px/m scale.
const CANVAS_WIDTH_MIN = 64;

// Maximum canvas width — caps the GPU resource size for pathological
// names. 1024 px = ≈ 8 m world-space. The 2D PIXI path's max viewport
// is ≈ 1280 px wide; a label wider than 8 m would dominate the screen
// regardless of camera distance. Names exceeding this cap shrink the
// font to fit (with the post-shrink width pinned at the cap).
const CANVAS_WIDTH_MAX = 1024;

// Horizontal padding either side of the measured text. 16 px keeps the
// rounded-rect background visually balanced and gives the stroke
// outline a few pixels of breathing room before the texture edge.
const CANVAS_PADDING_X = 16;

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

// 2026-05-23 — ?hud=none gate. Sprite-baked nameplates are GPU-scene
// objects, not DOM, so the no-hud CSS can't hide them. Read the URL
// flag once at module load; ensureNameplateForEntity short-circuits
// when set, avoiding the CanvasTexture bake + Sprite allocation on
// every entity spawn for the agent fleet's lifetime.
const _NAMEPLATE_DISABLED = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("hud") === "none";
  } catch (_) { return false; }
})();

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
 * Layout: black 55%-alpha rounded rectangle background filling the
 * canvas, white-or-coloured text centred. 32 px bold monospace + 4 px
 * black outline (the 2D path uses a 3 px stroke at 13 px font — the
 * sprite's larger canvas means we scale the stroke proportionally so
 * the rendered text matches readability when downscaled).
 *
 * Follow-on Task 33 (Bug A fix): canvas width is computed per-name via
 * `ctx.measureText(name).width + 2 × CANVAS_PADDING_X`. Previously a
 * fixed 256 px width truncated long names ("Hudriffa the Shopkeeper"
 * rendered as "ffa the Shopk" in the world-completeness demo). The
 * returned entry now carries `canvasWidth` so callers can scale the
 * sprite proportionally and keep the on-screen pixel density consistent
 * across all names (no horizontal stretch).
 *
 * The returned `{ texture, material, canvasWidth }` is cached on first
 * bake; repeated calls for the same `(name, colour)` reuse the entry
 * verbatim so we don't reallocate the GPU resource on every spawn.
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
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Bug A — Follow-on Task 33 — measure the name's pixel width at the
  // bake font BEFORE sizing the canvas so long names ("Hudriffa the
  // Shopkeeper", "Scrawed Grievver") don't clip at the centre-aligned
  // draw call. The measurement reads the same font we draw with, so
  // there's no "measure-then-draw mismatch" risk.
  //
  // measureText is a one-call canvas2d API present on every browser
  // that supports `getContext("2d")` — three.js 0.184 implies modern
  // browsers, so we don't feature-detect. If the host lacks measureText
  // entirely, the `.width` read below would throw and the whole bake
  // path would surface the failure as a console warning via the caller.
  ctx.font = "bold 32px monospace";
  const measured = ctx.measureText(name).width;
  // Clamp width to [MIN, MAX] and round up to even pixels so the
  // power-of-two-ish CanvasTexture upload aligns cleanly. The MAX cap
  // protects GPU memory for pathological long names; if a name's
  // measured width exceeds the cap, we shrink the font to fit (so the
  // sprite stays at the cap width without stretching). Shrinking the
  // font is the lesser-evil compared to clipping or stretching — names
  // remain readable, just smaller, and the on-screen footprint stays
  // bounded.
  let canvasWidth =
    Math.ceil(Math.max(CANVAS_WIDTH_MIN, measured + CANVAS_PADDING_X * 2));
  let fontPx = 32;
  if (canvasWidth > CANVAS_WIDTH_MAX) {
    // Reduce the font size proportionally so the text fits inside the
    // capped width. Re-measure after the resize to get the exact
    // post-shrink width.
    const shrinkRatio = (CANVAS_WIDTH_MAX - CANVAS_PADDING_X * 2) / measured;
    fontPx = Math.max(12, Math.floor(32 * shrinkRatio));
    canvasWidth = CANVAS_WIDTH_MAX;
    ctx.font = `bold ${fontPx}px monospace`;
  }
  canvas.width = canvasWidth;
  canvas.height = CANVAS_HEIGHT;

  // Background. Rounded rectangle filling the canvas with 8 px corner
  // radius. Drawn first so text composites on top.
  const padding = 4;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  // roundRect is r166+ on canvas2d; three.js 0.184 implies a modern
  // browser, but feature-detect anyway in case of an unusual host.
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(padding, padding, canvasWidth - padding * 2, CANVAS_HEIGHT - padding * 2, 8);
    ctx.fill();
  } else {
    ctx.fillRect(padding, padding, canvasWidth - padding * 2, CANVAS_HEIGHT - padding * 2);
  }

  // Text. Bold N px monospace (N = 32 by default; smaller when the
  // shrink-to-fit branch fired), centre-aligned with a black outline so
  // it stays legible on bright backgrounds (sky, snow, lit interiors).
  // Re-set the font AFTER canvas.width is assigned — Chrome resets
  // canvas2d state on width-change so the earlier `ctx.font = ...` is
  // wiped. The pre-resize measureText call still gives valid metrics
  // because the font was set at that time.
  ctx.font = `bold ${fontPx}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, Math.round(fontPx / 8));
  ctx.strokeStyle = "#000000";
  ctx.lineJoin = "round";
  // Outline first, fill second — that's the standard "knockout"
  // pattern that gets you a clean stroke without the half-pixel
  // antialiasing of a fill-then-stroke order.
  ctx.strokeText(name, canvasWidth / 2, CANVAS_HEIGHT / 2);
  ctx.fillStyle = colorHex;
  ctx.fillText(name, canvasWidth / 2, CANVAS_HEIGHT / 2);

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
    // Follow-on Task 33 (2026-05-14) — depthTest flipped from true →
    // false. With the per-name dynamic canvas width (Bug A fix), wide
    // labels for long names like "Novedion the Gem Seller" span across
    // the NPC's own body geometry. depthTest=true was rejecting the
    // sprite pixels behind the NPC torso, producing a visible "missing
    // middle" effect (verified in capture-run-1 vs the original 256-px
    // truncated build — see `/mnt/wbterminal1/tmp/claude-scratch/
    // scenery-bake/f33-34/`). depthTest=false matches the 2D PIXI
    // nameplate path (`index.html:3624 ensureNameplate` draws to a
    // sibling PIXI.Container that's NOT depth-sorted against world
    // geometry).
    //
    // depthWrite stays false so overlapping nameplates don't z-fight.
    // The cost is that nameplates now punch through walls (the camera
    // sees a nameplate for an entity around the corner). That matches
    // the 2D path's behavior exactly — players who depended on the 2D
    // experience already see this; the 3D path's old "depth-cull
    // through walls" was inconsistent with the 2D and arguably worse
    // for player situational awareness (you couldn't see the name of a
    // vendor through a wall before walking in).
    depthTest: false,
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

  const entry = { texture, material, canvasWidth };
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
  // World-space size. Width is derived from the baked canvas width so
  // long names stay readable at the same px/m density as short names
  // (Follow-on Task 33 — Bug A fix). The same Sprite reused across the
  // scene will render at this metre-size at every camera distance
  // (modulo perspective shrink with `sizeAttenuation: true`).
  //
  // canvasWidth = measured-text + padding (from getOrBakeNameplateMaterial);
  // dividing by NAMEPLATE_PX_PER_METRE = 128 px/m gives the world
  // width. Height stays at 0.5 m so the on-screen "label band" height
  // is consistent across the scene — only width grows with name length.
  const canvasWidth = baked.canvasWidth || CANVAS_WIDTH_MIN;
  const worldWidth = canvasWidth / NAMEPLATE_PX_PER_METRE;
  sprite.scale.set(worldWidth, NAMEPLATE_WORLD_HEIGHT, 1);
  // Render order: high enough to win against the world-geometry pass
  // when depthTest is true and the geometry passes. Doesn't matter for
  // depthTest=true rendering against opaque, but is the right knob to
  // turn if we ever flip to depthTest=false for "X-ray" nameplates.
  sprite.renderOrder = 10;
  // Stash the source name on userData so capture scripts can read it
  // back without parsing canvas pixels. The capture asserts
  // `sprite.userData.nameplateText === entity.meta.name`.
  sprite.userData = { nameplateText: name, color: colorHex, canvasWidth };
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
  if (_NAMEPLATE_DISABLED) return null;
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

  // Re-bake check (dedupe-by-guid via the EntityInstance.root tree):
  // was a sprite already attached?
  //
  // Follow-on Task 34 (Bug B fix) — there are two ways a duplicate
  // could land:
  //   1. `_spawnImpl` re-entry for the same guid (already guarded by
  //      `EntityManager.spawnInFlight` + `remove(guid)` at entities.js:
  //      438-445; verified idempotent).
  //   2. An unrelated code path attaching another Sprite to inst.root
  //      whose name matches "nameplate_<X>". We defensively scan
  //      inst.root.children for any pre-existing nameplate sprite (not
  //      just the cached `_nameplateSprite` pointer) so a stale
  //      attachment from a previous code path / hot-reload gets cleaned
  //      up here too. This is "dedupe-at-registration-time" keyed on
  //      the inst.guid: there is at most ONE nameplate sprite per
  //      EntityInstance after this function returns.
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
  // Perf task B5 (2026-05-18) — orphan scan replaced with a dev-mode
  // assertion. The slot `inst._nameplateSprite` (set/cleared above and
  // at attach below) is the single source of truth for the attached
  // sprite; at spawn-burst the previous O(children) walk multiplied
  // across every entity. The scan only ever caught a hot-reload
  // edge case (re-running `_spawnImpl` before the previous tear-down
  // ran left a ghost nameplate parented to the same root — see commit
  // ad26b39 "Bug B"). That's a dev-only scenario; production spawn
  // ordering is guarded by `EntityManager.spawnInFlight` +
  // `remove(guid)` (entities.js:438-445).
  //
  // Trade: skip the scan in production; in dev mode (opt-in via
  // `window.__debugNameplates`) walk the children once to detect
  // orphans and warn loudly so hot-reload regressions still surface.
  if (typeof window !== "undefined" && window.__debugNameplates) {
    if (inst.root && Array.isArray(inst.root.children)) {
      for (const child of inst.root.children) {
        if (
          child &&
          child !== inst._nameplateSprite &&
          child.userData &&
          typeof child.userData.nameplateText === "string"
        ) {
          console.warn(
            "[nameplate_sprite] orphan nameplate sprite detected on entity",
            inst.guid,
            "— this is the hot-reload race from commit ad26b39. " +
              "Slot `inst._nameplateSprite` did not match `inst.root.children`.",
            { orphan: child, expected: inst._nameplateSprite }
          );
          try { inst.root.remove(child); } catch (_) {}
        }
      }
    }
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
