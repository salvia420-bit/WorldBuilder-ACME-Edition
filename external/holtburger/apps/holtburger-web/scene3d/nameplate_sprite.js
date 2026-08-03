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
import { getAcFont, renderAcText, whenPrimaryFontsReady } from "../ui/ac_font.js";

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

// F14-6 — nameplate wall-occlusion. depthTest on the sprite materials is
// normally OFF (Task 33: names render on-top, matching the 2D PIXI path),
// which X-rays monster / NPC / player names (and chat bubbles) through
// dungeon walls and floors — an immersion break and a situational-awareness
// leak vs retail. Behind `?nameplateOcclusion=on` we flip depthTest ON while
// the local player is INDOOR: the atmosphere pipeline already depth-clears
// between the terrain pass and the EnvCell+entity pass (see cells.js
// tickCellVisibility3D), so EnvCell wall geometry is in the depth buffer
// when the layer-1 nameplates render, and a wall between the camera and an
// entity in another cell now occludes its name. Outdoors we keep depthTest
// OFF — no regression, the 2D path stays matched, and the wide-name
// "missing middle" self-occlusion Task 33 fixed doesn't return in the open.
// The fuller per-entity PVS-membership cull (hide the name when its OWNING
// cell is outside the render set) is the better fix but needs the per-entity
// objcell_id surfaced from wasm position updates; deferred (wasm rebuild).
// INTEGRATED always-on — 1070 eye-test PASSED 2026-06-10 (indoor walls occlude
// other-room nameplates; no X-ray). JS, live on reload. Was the default-OFF
// `?nameplateOcclusion=on` gate.
const _NAMEPLATE_OCCLUSION_FLAG = true;
// Effective depthTest currently applied to all baked + cached nameplate
// materials. New bakes read this; setNameplateDepthTest flips it on the
// already-cached materials in place (depthTest is read live by the renderer
// each frame, so no needsUpdate / recompile is required).
let _nameplateDepthTest = false;
function setNameplateDepthTest(enabled) {
  const want = !!enabled;
  if (want === _nameplateDepthTest) return;
  _nameplateDepthTest = want;
  // Flip both the name sprites and the sibling buff-badge ("+N") chips so
  // overhead UI occludes consistently — a badge punching through a wall
  // next to an occluded name would read worse than neither.
  for (const entry of _nameplateCache.values()) {
    if (entry?.material) entry.material.depthTest = want;
  }
  for (const entry of _buffBadgeCache.values()) {
    if (entry?.material) entry.material.depthTest = want;
  }
}

// Wave 1 / A1+A2 fix (2026-05-28) — FIFO caps so neither cache grows
// unboundedly through long sessions with many unique names / enchant-
// state tuples.
//
// 2026-08-03 review F6: eviction used to drop the entry and rely on "GC
// reclaims the GPU resources naturally". It does not. three.js frees a
// WebGLTexture only from the texture's own `dispose` event — `WebGLProperties`
// holds it in a WeakMap, so a garbage-collected CanvasTexture leaks its GL
// handle for the life of the context. Past the cap, every new unique name was
// leaking up to 1024×64 RGBA (256 KB) of VRAM with no way to reclaim it.
//
// We cannot dispose at eviction time either: live sprites may still be drawing
// with that material. So evicted entries move to `_pendingDispose` and are
// freed by a low-frequency mark-and-sweep against the live entity map (the
// same map the LOD tick already walks every frame) — an entry whose material
// no live sprite references is provably safe to free.
const NAMEPLATE_CACHE_CAP = 512;
const BUFF_BADGE_CACHE_CAP = 128;
/** Entries evicted from a cache but possibly still in use by a live sprite. */
const _pendingDispose = [];
/** Sweep cadence in LOD ticks (~10 s at 60 fps). Eviction is rare; the sweep
 *  only needs to be eventual, and it walks the whole entity map. */
const PENDING_DISPOSE_SWEEP_TICKS = 600;
let _pendingSweepTick = 0;
let _pendingDisposed = 0;

function _capCacheFifo(cache, max) {
  while (cache.size > max) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    const evicted = cache.get(firstKey);
    cache.delete(firstKey);
    if (evicted) _pendingDispose.push(evicted);
  }
}

/**
 * Free evicted texture/material pairs that no live sprite references any more.
 * `entityMap` is the authority on what is on screen: a nameplate/badge sprite
 * only ever lives in `inst._nameplateSprite` / `inst._buffBadgeSprite`, so the
 * union of those materials is the complete in-use set. Anything else in
 * `_pendingDispose` is unreachable and its GPU resources can go.
 */
function _sweepPendingDispose(entityMap) {
  if (_pendingDispose.length === 0) return 0;
  const inUse = new Set();
  for (const inst of entityMap.values()) {
    const np = inst && inst._nameplateSprite;
    if (np?.material) inUse.add(np.material);
    const bb = inst && inst._buffBadgeSprite;
    if (bb?.material) inUse.add(bb.material);
  }
  let freed = 0;
  let keep = 0;
  for (let i = 0; i < _pendingDispose.length; i++) {
    const entry = _pendingDispose[i];
    if (entry?.material && inUse.has(entry.material)) {
      // Still on screen — hold it for the next sweep.
      _pendingDispose[keep++] = entry;
      continue;
    }
    try { entry?.texture?.dispose(); } catch (_) {}
    try { entry?.material?.dispose(); } catch (_) {}
    freed++;
  }
  _pendingDispose.length = keep;
  _pendingDisposed += freed;
  return freed;
}

// #27 (Option A) — system-font bake gate. To avoid the use-after-dispose
// + never-upgraded-early-nameplate race, we do NOT bake a system-font
// fallback nameplate during the boot window while the AC bitmap font is
// still loading. Instead, baking is gated: it proceeds once EITHER the AC
// font has resolved (the desired path — bakes go straight to the retail
// font, no system-font entry is ever created) OR a timeout elapses (the
// fallback path — if the AC font never loads, nameplates still appear in
// the system font rather than never appearing at all).
//
// Because the AC font is ready before the first system-font bake can fire
// in the common case, the old "bake in sys, then disposeNameplateCache()
// on font load" dance — which disposed CanvasTextures still held by live
// sprites and never re-baked early nameplates — is removed entirely.
//
// `_systemFontBakeAllowed` starts false (defer system-font bakes) and is
// flipped true when the timeout fires. AC-font bakes are never gated by
// this flag (they read `getAcFont()` directly).
const SYSTEM_FONT_BAKE_TIMEOUT_MS = 5000;
let _systemFontBakeAllowed = false;
let _fontReadyWatchStarted = false;

/**
 * Walk the live entity map and (re-)attempt a nameplate bake for every
 * entity that doesn't yet carry one. Called once the AC font resolves OR
 * the timeout fallback opens the gate, so entities whose bake was deferred
 * during the boot race finally get their nameplate (in the retail font on
 * the happy path; in the system font on the timeout path). Browser-only;
 * fail-soft.
 */
function _flushDeferredNameplates() {
  try {
    if (typeof window === "undefined") return;
    const live = window.liveScene3d;
    const entityMap = live && live.entityManager && live.entityManager.entityMap;
    if (!entityMap || typeof entityMap.values !== "function") return;
    for (const inst of entityMap.values()) {
      // Only entities still missing a nameplate sprite need a retry; ones
      // that already have one are left untouched (no churn / no dispose).
      if (inst && !inst._nameplateSprite) {
        try { ensureNameplateForEntity(inst, live); } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * Arm the one-time AC-font readiness watch + timeout fallback that
 * controls `_systemFontBakeAllowed`. Idempotent. On either signal (AC
 * font ready OR timeout) it flushes any nameplate bakes deferred during
 * the boot race. Returns nothing; the gate is read by
 * getOrBakeNameplateMaterial.
 */
function _ensureFontReadyWatch() {
  if (_fontReadyWatchStarted) return;
  _fontReadyWatchStarted = true;
  // Kick off the primary-font load so getAcFont() resolves ASAP. Once it
  // settles, AC-font bakes take over naturally; no cache flush needed
  // (we never baked a system-font entry while the font was loading). Then
  // re-attempt any nameplate bakes that were deferred during the boot race.
  try {
    whenPrimaryFontsReady()
      .catch(() => {})
      .then(() => { _flushDeferredNameplates(); });
  } catch (_) {}
  // Timeout fallback: if the AC font never loads, open the gate so
  // nameplates still bake (in the system font) rather than never appearing,
  // then flush the deferred bakes through the now-open gate.
  try {
    if (typeof setTimeout === "function") {
      setTimeout(() => {
        _systemFontBakeAllowed = true;
        _flushDeferredNameplates();
      }, SYSTEM_FONT_BAKE_TIMEOUT_MS);
    }
  } catch (_) {}
}

// 2026-05-23 — ?hud=none gate. Sprite-baked nameplates are GPU-scene
// objects, not DOM, so the no-hud CSS can't hide them. Read the URL
// flag once at module load; ensureNameplateForEntity short-circuits
// when set, avoiding the CanvasTexture bake + Sprite allocation on
// every entity spawn for the agent fleet's lifetime.
const _NAMEPLATE_DISABLED = (() => {
  try {
    if (typeof window === "undefined") return false; // headless tests exercise the bake paths
    const q = new URLSearchParams(window.location.search);
    if (q.get("hud") === "none") return true;
    // 2026-07-03 user directive: nameplates DEFAULT-OFF; `?nameplates=on` enables.
    const v = (q.get("nameplates") || "").toLowerCase();
    return !(v === "on" || v === "1" || v === "true" || v === "yes");
  } catch (_) { return true; }
})();

// Distance LOD (DEFICIENCY-REPORT #16). Beyond NAMEPLATE_VISIBLE_RANGE_M
// the sprite gets `.visible = false` (no canvas redraw / no draw call).
// MAX_VISIBLE_NAMEPLATES caps how many of the in-range nameplates may
// be visible at once — beyond that, the farther ones are hidden too,
// guarding against the retail "crowd of nameplates" perf cliff.
// Per-frame cost: O(N log N) partial sort across attached sprites (cheap
// for N ≤ 200 — under 0.05 ms on a 2GHz core).
const NAMEPLATE_VISIBLE_RANGE_M = (() => {
  try {
    if (typeof window === "undefined") return 40;
    const raw = new URLSearchParams(window.location.search).get("nameplateRange");
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 40;
  } catch (_) { return 40; }
})();
const MAX_VISIBLE_NAMEPLATES = (() => {
  try {
    if (typeof window === "undefined") return 30;
    const raw = new URLSearchParams(window.location.search).get("nameplateMax");
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
  } catch (_) { return 30; }
})();
// Cached scratch arrays to avoid allocations in the hot per-frame loop.
// `_lodScratch` is rebuilt each tick but only ever holds objects drawn from
// `_lodPool`, which grows to the session's high-water entity count and is then
// reused forever — the old `push({ sprite, d2 })` minted one object per
// in-range entity per frame (2026-08-03 review F5).
const _lodScratch = [];
const _lodPool = [];
function _lodEntry(n) {
  let e = _lodPool[n];
  if (!e) {
    e = { sprite: null, badge: null, d2: 0 };
    _lodPool[n] = e;
  }
  return e;
}
const _lodCamWorld = { x: 0, y: 0, z: 0 };
let _lodRafId = 0;
let _lodDisposed = false;

// ITEM_TYPE bit constants mirrored from the authoritative wire ItemType
// enum (`index.html:4525` — the frozen `ITEM_TYPE` object the 2D PIXI
// path's `categoryForItemType` reads). We only need the bits the
// nameplate-colour switch reads. Earlier this file carried three wrong
// values (WRITABLE 0x00100000, LIFE_STONE 0x04000000, CASTER 0x00200000)
// that did not exist in the wire enum, so Books, Lifestones, and Wands
// fell through to the neutral-white "misc" branch.
const ITEM_TYPE_CREATURE = 0x00000010;
const ITEM_TYPE_PORTAL = 0x00010000;
const ITEM_TYPE_LIFE_STONE = 0x10000000;
const ITEM_TYPE_CONTAINER = 0x00000200;
const ITEM_TYPE_WRITABLE = 0x00002000;
const ITEM_TYPE_MELEE_WEAPON = 0x00000001;
const ITEM_TYPE_MISSILE_WEAPON = 0x00000100;
const ITEM_TYPE_CASTER = 0x00008000;
const ITEM_TYPE_ARMOR = 0x00000002;
const ITEM_TYPE_CLOTHING = 0x00000004;

/**
 * Map an itemType bitmask to a coarse visual category. Mirrors
 * `categoryForItemType` (`index.html:4553`). Used by
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
/**
 * Bake variant that composites a pre-rendered text canvas (the output
 * of `renderAcText`) onto the standard rounded-rect background. Used
 * by the AC-font path; the system-font path keeps its self-contained
 * Canvas2D draw to preserve the legacy stroke-outline look while the
 * AC font is loading.
 */
function _bakeWithCanvasText(cacheKey, textCanvas) {
  const padding = 4;
  const canvasWidth = Math.ceil(
    Math.max(
      CANVAS_WIDTH_MIN,
      Math.min(CANVAS_WIDTH_MAX, textCanvas.width + CANVAS_PADDING_X * 2),
    ),
  );

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(padding, padding, canvasWidth - padding * 2, CANVAS_HEIGHT - padding * 2, 8);
    ctx.fill();
  } else {
    ctx.fillRect(padding, padding, canvasWidth - padding * 2, CANVAS_HEIGHT - padding * 2);
  }

  // Centre the rendered text canvas inside the rounded rect. If the
  // glyphs are taller than the background, clip rather than upscale.
  const dx = Math.floor((canvasWidth - textCanvas.width) / 2);
  const dy = Math.floor((CANVAS_HEIGHT - textCanvas.height) / 2);
  ctx.drawImage(textCanvas, dx, dy);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  // Bitmap fonts deserve nearest-neighbour magnification so the
  // pixel-perfect glyph shapes don't blur when the camera zooms in.
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: _nameplateDepthTest, // F14-6 — always-on gate: true indoors, false outdoors
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
  });
  material.name = `nameplate-${cacheKey}`;

  const entry = { texture, material, canvasWidth };
  _nameplateCache.set(cacheKey, entry);
  _capCacheFifo(_nameplateCache, NAMEPLATE_CACHE_CAP);
  return entry;
}

function getOrBakeNameplateMaterial(name, colorHex) {
  // Cache key includes the font generation (`ac` vs `sys`) so an AC-font
  // bake and a (timeout-fallback) system-font bake of the same name never
  // collide. With #27 (Option A) a system-font entry is only ever created
  // after the timeout fallback opens the gate, so in the common path every
  // entry is keyed `…|ac`.
  const acFontReady = !!getAcFont();
  const cacheKey = `${name}|${colorHex}|${acFontReady ? "ac" : "sys"}`;
  const hit = _nameplateCache.get(cacheKey);
  if (hit) return hit;

  // Capture-script standalone path: `document` may be undefined in pure
  // Node test harnesses. Return null so the spawn path skips creation.
  // The real browser path always has document.
  if (typeof document === "undefined") return null;

  // #27 (Option A) — arm the AC-font readiness watch + timeout fallback
  // on first bake attempt. This kicks the primary-font load and arms the
  // system-font-bake timeout gate. Idempotent.
  _ensureFontReadyWatch();

  // AC-font path — produce the text canvas from the retail bitmap font.
  // The renderAcText() call returns null if the font isn't loaded yet,
  // which falls through to the (possibly gated) system-font path below.
  if (acFontReady) {
    // scale=2 gets us roughly 32px-tall AC glyphs (max_char_height=16).
    const textCanvas = renderAcText(name, { color: colorHex, scale: 2, shadow: false });
    if (textCanvas && textCanvas.width > 0 && textCanvas.height > 0) {
      return _bakeWithCanvasText(cacheKey, textCanvas);
    }
  }

  // #27 (Option A) — DEFER the system-font bake during the boot race.
  // While the AC font is still loading and the timeout fallback hasn't
  // fired, return null so NO `…|sys` nameplate is created. The caller
  // (ensureNameplateForEntity) leaves `inst._nameplateSprite` unset, so
  // the next spawn/refresh/MetaRefresh re-attempts the bake — and by then
  // the AC font is almost always ready, so the nameplate bakes straight
  // into the retail font with no use-after-dispose or font-upgrade dance.
  // Once the timeout fallback opens the gate (AC font never loaded), we
  // fall through and bake in the system font so nameplates still appear.
  if (!_systemFontBakeAllowed) return null;

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
    depthTest: _nameplateDepthTest, // F14-6 — always-on gate: true indoors, false outdoors
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
  _capCacheFifo(_nameplateCache, NAMEPLATE_CACHE_CAP);
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
export function ensureNameplateForEntity(inst, _scene3d) {
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
  // === Wave 4.B — buff-badge cache cleanup (2026-05-28) ===
  for (const entry of _buffBadgeCache.values()) {
    try { entry.texture.dispose(); } catch (_) {}
    try { entry.material.dispose(); } catch (_) {}
  }
  _buffBadgeCache.clear();
  // F6 — drain anything the cap evicted but the sweep hadn't reached yet.
  for (const entry of _pendingDispose) {
    try { entry?.texture?.dispose(); } catch (_) {}
    try { entry?.material?.dispose(); } catch (_) {}
  }
  _pendingDispose.length = 0;
}

/** Pending-dispose telemetry (tests / diagnostic scripts). */
export function getNameplateDisposeStats() {
  return { pending: _pendingDispose.length, disposed: _pendingDisposed };
}

// =========================================================================
// === Wave 4.B — per-nameplate buff/debuff badge (2026-05-28) =============
// =========================================================================
//
// Renders a small chip ABOVE the nameplate showing the target's active
// buff / debuff counts: green "+2" / red "-1" pill. Drives off the
// per-entity enchantment index Wave 4.B added to wasm via
// `handle.entityEnchantments(guid)` — surfaced as
// `window.__buffsHudGetEntitySummary(guid)` by `plugins/buffs-hud.js`.
//
// Why a separate sprite (not merged into the nameplate texture):
//   1. Counts change at MUCH higher frequency than names — a buff
//      arriving / fading shouldn't re-bake the underlying name texture.
//   2. Per-name nameplate texture is shared across all entities with
//      the same name (e.g. 10 Sparring Golems), so per-target counts
//      would invalidate the cache.
//   3. Color-coded chip is far easier to read at a glance than a count
//      glued onto the name.
//
// Lifecycle:
//   - Created lazily on the first non-zero summary fetched for an
//     entity (so most NPCs without enchantments pay zero memory cost).
//   - Updated by `_refreshBuffBadgeFor(inst)` — called from the LOD
//     tick for in-range nameplates, and synchronously from the
//     entity-change listener for the affected GUID.
//   - Disposed alongside the entity (the parent root is removed and
//     this sprite goes with it).
//
// Cache key: `${buffs}|${debuffs}|${cooldowns}` so identical chip
// states reuse the GPU resource.
// =========================================================================

const _buffBadgeCache = new Map();
const BUFF_BADGE_CANVAS_HEIGHT = 28;
const BUFF_BADGE_CANVAS_PAD_X = 8;
const BUFF_BADGE_AC_Z_OFFSET = 2.7;  // Above the nameplate (which sits at 2.2 m).
const BUFF_BADGE_WORLD_HEIGHT = 0.35;
const BUFF_BADGE_PX_PER_METRE = 80;

function _bakeBuffBadge(buffs, debuffs, cooldowns) {
  if (typeof document === "undefined") return null;
  const cacheKey = `${buffs}|${debuffs}|${cooldowns}`;
  const hit = _buffBadgeCache.get(cacheKey);
  if (hit) return hit;

  // Pre-measure: compose a text string from non-zero parts.
  // Buffs render green "+N", debuffs red "-N", cooldowns gray "*N".
  const parts = [];
  if (buffs > 0) parts.push({ text: `+${buffs}`, color: "#5cd66c" });
  if (debuffs > 0) parts.push({ text: `-${debuffs}`, color: "#e07060" });
  if (cooldowns > 0) parts.push({ text: `*${cooldowns}`, color: "#a0a0c8" });
  if (parts.length === 0) return null;

  const canvas = document.createElement("canvas");
  // Estimate width: ~14 px per char + 6 px separator between parts.
  // Recompute after first measure if too small.
  let canvasWidth = BUFF_BADGE_CANVAS_PAD_X * 2;
  for (const p of parts) canvasWidth += p.text.length * 14 + 6;
  canvas.width = Math.max(48, canvasWidth);
  canvas.height = BUFF_BADGE_CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  // Background pill: black 70% alpha with 1 px brass border.
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 6);
    ctx.fill();
  } else {
    ctx.fillRect(1, 1, canvas.width - 2, canvas.height - 2);
  }

  // Text with per-segment colors.
  ctx.font = "bold 18px monospace";
  ctx.textBaseline = "middle";
  let x = BUFF_BADGE_CANVAS_PAD_X;
  for (const p of parts) {
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, x, canvas.height / 2);
    x += ctx.measureText(p.text).width + 6;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: _nameplateDepthTest, // F14-6 — always-on gate: true indoors, false outdoors
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
  });
  material.name = `buff-badge-${cacheKey}`;

  const entry = { texture, material, canvasWidth: canvas.width };
  _buffBadgeCache.set(cacheKey, entry);
  _capCacheFifo(_buffBadgeCache, BUFF_BADGE_CACHE_CAP);
  return entry;
}

/**
 * Refresh (or create / remove) the buff badge sprite on an entity.
 * Pulls fresh counts from `window.__buffsHudGetEntitySummary(guid)`
 * (set by `plugins/buffs-hud.js`). Idempotent — same counts → no work.
 *
 * Returns the attached sprite, or null if the entity has no
 * enchantments (in which case any existing badge is removed).
 *
 * @param {object} inst EntityInstance from EntityManager.
 * @returns {THREE.Sprite | null}
 */
export function refreshBuffBadgeForEntity(inst) {
  if (_NAMEPLATE_DISABLED) return null;
  if (!inst || !inst.root) return null;
  // Skip local player — buff state is shown in the main HUD's buffs
  // strip, not above the player's own head.
  try {
    if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
      const lpg = window.getLocalPlayerGuid();
      if (lpg !== null && lpg !== undefined && (lpg >>> 0) === (inst.guid >>> 0)) {
        return null;
      }
    }
  } catch (_) {}

  const summaryFn = (typeof window !== "undefined")
    ? window.__buffsHudGetEntitySummary
    : null;
  // Plugin not mounted yet — skip silently. The buffs-hud plugin sets
  // up this global in its module-load init, but during the entity
  // spawn burst at login the plugin may not have run yet.
  if (typeof summaryFn !== "function") return inst._buffBadgeSprite || null;

  const summary = summaryFn(inst.guid >>> 0) || { buffs: 0, debuffs: 0, cooldowns: 0 };
  const { buffs = 0, debuffs = 0, cooldowns = 0 } = summary;
  const newKey = `${buffs}|${debuffs}|${cooldowns}`;
  const existing = inst._buffBadgeSprite || null;
  const prevKey = existing?.userData?.badgeKey ?? null;

  if (newKey === prevKey) return existing;  // No change.

  // Remove any existing badge so we can re-attach with the new texture.
  if (existing) {
    try { existing.parent && existing.parent.remove(existing); } catch (_) {}
    inst._buffBadgeSprite = null;
  }

  if (buffs === 0 && debuffs === 0 && cooldowns === 0) return null;

  const baked = _bakeBuffBadge(buffs, debuffs, cooldowns);
  if (!baked) return null;
  const sprite = new THREE.Sprite(baked.material);
  sprite.name = `buff_badge_${inst.guid >>> 0}`;
  const worldWidth = baked.canvasWidth / BUFF_BADGE_PX_PER_METRE;
  sprite.scale.set(worldWidth, BUFF_BADGE_WORLD_HEIGHT, 1);
  sprite.renderOrder = 11;  // Above the nameplate (which is 10).
  sprite.position.set(0, 0, BUFF_BADGE_AC_Z_OFFSET);
  sprite.userData = { badgeKey: newKey, buffs, debuffs, cooldowns };

  inst.root.add(sprite);
  inst._buffBadgeSprite = sprite;
  return sprite;
}

/**
 * Remove the buff badge sprite from an entity (and its userData slot).
 * Called by EntityManager cleanup paths or when buffs are fully purged.
 */
export function removeBuffBadgeFromEntity(inst) {
  if (!inst || !inst._buffBadgeSprite) return;
  try {
    inst._buffBadgeSprite.parent &&
      inst._buffBadgeSprite.parent.remove(inst._buffBadgeSprite);
  } catch (_) {}
  inst._buffBadgeSprite = null;
}

/** Read-only buff badge cache size (test helper). */
export function getBuffBadgeCacheSize() {
  return _buffBadgeCache.size;
}

// === Wave 4.B — subscribe to per-entity enchantment changes (2026-05-28) ===
//
// The buffs-hud plugin exposes a subscription helper at
// `window.__buffsHudOnEntityChange(fn)` that fires for every per-target
// enchantment delta. When the plugin is mounted (and the helper is
// installed), wire a callback that refreshes the affected entity's
// badge synchronously — no rAF poll needed.
//
// Browser-only; no-op in Node test harnesses.
let _wavefourBSubscribed = false;
if (typeof window !== "undefined" && !_NAMEPLATE_DISABLED) {
  const trySubscribe = () => {
    if (_wavefourBSubscribed) return true;
    const sub = window.__buffsHudOnEntityChange;
    if (typeof sub !== "function") return false;
    sub((guid) => {
      try {
        const live = window.liveScene3d;
        if (!live) return;
        // guid === 0 is the "clear all" signal from
        // clearEntityEnchantments(); rebuild every nameplate.
        if (guid === 0) {
          const entityMap = live.entityManager?.entityMap;
          if (!entityMap) return;
          for (const inst of entityMap.values()) {
            if (inst._nameplateSprite) refreshBuffBadgeForEntity(inst);
          }
          return;
        }
        const inst = live.entityManager?.entityMap?.get(guid >>> 0);
        if (inst) refreshBuffBadgeForEntity(inst);
      } catch (e) {
        console.warn("[nameplate_sprite] buff-badge refresh failed", e);
      }
    });
    _wavefourBSubscribed = true;
    return true;
  };
  // Try immediately; if the buffs-hud plugin hasn't loaded yet, poll
  // every 500 ms until it does. Stops after one successful subscribe.
  if (!trySubscribe()) {
    const watchId = setInterval(() => {
      if (trySubscribe()) clearInterval(watchId);
    }, 500);
  }
}

/** Read-only access to the cache for diagnostic scripts. */
export function getNameplateCacheSize() {
  return _nameplateCache.size;
}

/**
 * Per-frame distance/count LOD for attached nameplate sprites.
 * - Hides sprites further than `NAMEPLATE_VISIBLE_RANGE_M` from the camera.
 * - Of the in-range sprites, keeps only the N nearest visible (N =
 *   `MAX_VISIBLE_NAMEPLATES`); hides the rest.
 * - Local-player sprite is always visible regardless of distance/cap.
 * Idempotent — safe to call every rAF. Returns visible/considered counts
 * for diagnostic scripts.
 */
export function tickNameplateLod(scene3d) {
  if (_NAMEPLATE_DISABLED) return { visible: 0, considered: 0 };
  if (!scene3d) return { visible: 0, considered: 0 };
  // F14-6 — drive nameplate / buff-badge wall-occlusion off the local
  // player's indoor state (stamped by cells.js tickCellVisibility3D each
  // frame). INTEGRATED always-on (the ?nameplateOcclusion=on gate was retired
  // after the 2026-06-10 1070 eye-test — see _NAMEPLATE_OCCLUSION_FLAG):
  // depthTest is ON indoors, OFF outdoors. setNameplateDepthTest no-ops when
  // the value is unchanged, so this is a cheap per-frame check.
  if (_NAMEPLATE_OCCLUSION_FLAG) {
    setNameplateDepthTest(!!scene3d._currentCellIndoor);
  }
  const entityMap = scene3d.entityManager?.entityMap;
  if (!entityMap || typeof entityMap.values !== "function") {
    return { visible: 0, considered: 0 };
  }
  // F6 — reclaim GPU resources for cache entries evicted past the cap, once
  // no live sprite references them. Cheap: runs once every ~10 s and only when
  // something was actually evicted.
  if (++_pendingSweepTick >= PENDING_DISPOSE_SWEEP_TICKS) {
    _pendingSweepTick = 0;
    _sweepPendingDispose(entityMap);
  }
  const cam = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
  if (!cam) return { visible: 0, considered: 0 };

  // World-space camera position. cam.matrixWorld is current as of the
  // last cameraSwitcher.tick (this LOD runs after render so the next
  // frame sees up-to-date positions).
  const camPos = cam.position;
  _lodCamWorld.x = camPos.x;
  _lodCamWorld.y = camPos.y;
  _lodCamWorld.z = camPos.z;

  let localGuid = null;
  try {
    if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
      const lpg = window.getLocalPlayerGuid();
      if (lpg !== null && lpg !== undefined) localGuid = (lpg >>> 0);
    }
  } catch (_) {}

  _lodScratch.length = 0;
  const rangeSq = NAMEPLATE_VISIBLE_RANGE_M * NAMEPLATE_VISIBLE_RANGE_M;
  for (const inst of entityMap.values()) {
    const sprite = inst && inst._nameplateSprite;
    // F5/F8 — the badge comes from its OWN tracked slot, not a per-frame
    // `root.children.find(...)` scan (one closure + an O(children) walk per
    // entity per frame). The slot is also the only way to reach a badge on an
    // entity that has NO nameplate — deferred font bake, or a name filtered by
    // the local-player / inventory skips. `refreshBuffBadgeForEntity` attaches
    // to those, and the old `if (!sprite) continue` left them stranded visible
    // at any distance, past both the range cull and the count cap.
    const badge = inst && inst._buffBadgeSprite;
    if (!sprite) {
      if (badge) badge.visible = false;
      continue;
    }
    // Local-player sprite: always visible. (Note: ensureNameplateForEntity
    // already skips the local player, but if a future path attaches one
    // anyway — e.g. third-person showing your own name — keep it on.)
    if (localGuid !== null && (inst.guid >>> 0) === localGuid) {
      sprite.visible = true;
      if (badge) badge.visible = true;
      continue;
    }
    // World position of the sprite. Sprite is parented to inst.root,
    // whose matrixWorld already incorporates the worldRoot rotation.
    // sprite.matrixWorld is updated by the standard render walk; here
    // we read the parent root's world position as a stable proxy
    // (avoids an updateWorldMatrix call per-entity per-frame).
    const root = inst.root;
    if (!root) continue;
    const m = root.matrixWorld.elements;
    const dx = m[12] - _lodCamWorld.x;
    const dy = m[13] - _lodCamWorld.y;
    const dz = m[14] - _lodCamWorld.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > rangeSq) {
      sprite.visible = false;
      // Wave 4.B (#19) — hide the sibling buff badge too, or it stays visible
      // after the nameplate LODs out (stranded "+N" chip floating with no
      // name). Mirrors the in-range visibility sync below.
      if (badge) badge.visible = false;
      continue;
    }
    const e = _lodEntry(_lodScratch.length);
    e.sprite = sprite;
    e.badge = badge || null;
    e.d2 = d2;
    _lodScratch.push(e);
  }

  // Count cap: partial-sort by distance² and keep the N nearest. Plain
  // O(n log n) sort is fine here — n typically ≤ 200; the in-range
  // subset is usually << that. The scratch entries themselves are pooled
  // (`_lodEntry`), so the sort shuffles references and allocates nothing.
  _lodScratch.sort((a, b) => a.d2 - b.d2);
  let visible = 0;
  for (let i = 0; i < _lodScratch.length; i++) {
    const e = _lodScratch[i];
    const want = i < MAX_VISIBLE_NAMEPLATES;
    e.sprite.visible = want;
    if (want) visible++;
    // === Wave 4.B — sync buff badge visibility with nameplate (2026-05-28) ===
    // The badge is parented to the same entity root, but the LOD path toggles
    // `.visible` per-sprite, so the badge has to be mirrored explicitly (same
    // range + count cap). Carried on the pooled scratch entry from its tracked
    // slot — no children scan (F5).
    if (e.badge) e.badge.visible = want;
    // Drop the refs so a pooled entry can't pin a despawned sprite alive.
    e.sprite = null;
    e.badge = null;
  }
  const considered = _lodScratch.length;
  _lodScratch.length = 0;
  return { visible, considered };
}

/**
 * Stop the auto-rAF LOD loop. Idempotent. Sprites are left in their
 * current visibility state. For HMR / URL-flag-change paths.
 */
export function disposeNameplateLod() {
  _lodDisposed = true;
  if (_lodRafId && typeof window !== "undefined") {
    try { window.cancelAnimationFrame(_lodRafId); } catch (_) {}
  }
  _lodRafId = 0;
}

// Self-managed rAF: kicks in once `window.liveScene3d` is available
// and ticks every frame thereafter. Browser-only (no-op in tests).
if (typeof window !== "undefined" && !_NAMEPLATE_DISABLED) {
  const _lodLoop = () => {
    if (_lodDisposed) return;
    try {
      const live = window.liveScene3d;
      if (live) tickNameplateLod(live);
    } catch (_) {}
    _lodRafId = window.requestAnimationFrame(_lodLoop);
  };
  _lodRafId = window.requestAnimationFrame(_lodLoop);
}
