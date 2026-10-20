/**
 * Wave 14 — small THREE.js viewport that renders the local player's
 * full character rig inside the inventory panel's paperdoll area.
 * Mirrors retail `gmPaperDollUI::RedressCreature` (acclient.c:4146):
 * a static, centered 3D doll seen from the front-3/4 so equipped
 * armor + body palette show through the slot frames overlaid on top.
 *
 * Slimmed-down sibling of `ui/ac_dye_viewport.js` (W7.9.A/B):
 *   - No pedestal — just the rig at full scale.
 *   - No rotation — paperdoll is static (retail behaviour).
 *   - Transparent clear so the inventory panel's dark gradient + slot
 *     squares composite cleanly on top.
 *   - Single front-3/4 camera framed against the rig's bounding box,
 *     leaving ~10% padding top + bottom so head + feet are visible.
 *
 * Hot-swap path: callers should re-invoke `loadPlayer(...)` whenever
 * the local player's substitution set changes (mid-game equip / dye /
 * applyAppearance). The viewport tears down the previous rig contents
 * before rebuilding so subPalette deltas land instantly.
 *
 * WebGL contexts are bounded (Chrome caps ~16). 2026-10-20 (improvement hunt
 * hud-audio-2): consumers no longer build + destroy a context per mount —
 * `PaperdollViewport.acquire(consumer, size)` / `vp.release()` keep ONE
 * long-lived viewport per consumer (inventory, examine), re-parented on each
 * mount and destroyed only on pagehide, its own context loss or past a
 * parked-texture budget. See the pool block below.
 */

import * as THREE from "three";
import { surfacePixelsToTexture } from "../scene3d/adapter.js";

const DEFAULT_W = 224;
const DEFAULT_H = 214;

// Bug 13 (2026-10-07) — retail paperdoll framing. `gmPaperDollUI` turns the
// doll to a fixed heading (`CPhysicsObj::set_heading(doll, 191.3679)`,
// acclient.c:220051 — facing the viewer, turned 11.37°), and the viewport
// camera is fixed, not fitted: `UIElement_Viewport::SetCamera` with eye
// (0.12, -2.4, 0.88) looking straight along +Y (acclient.c:221604-221611) at
// `CreatureMode::m_fFOVRadians` = 0.785398 (45°, :145328). Heritages with a
// bigger body pull the eye back (`gmPaperDollUI::UpdateForRace`,
// acclient.c:220179). OpenAC: DollEntityBuilder / DollCamera /
// PaperdollHeritagePresentation (same values).
export const PAPERDOLL_HEADING_DEG = 191.3679;
export const PAPERDOLL_FOV_DEG = 45;
/** Retail eye (AC frame, Z up) for a HeritageGroup (PropertyInt 188). */
export function paperdollEyeForHeritage(heritage) {
  switch (heritage >>> 0) {
    case 6: case 7: return [0.12, -3.0, 0.88];
    case 8: return [0.12, -3.4, 1.0];
    case 9: case 12: case 13: return [0.12, -3.4, 0.88];
    default: return [0.12, -2.4, 0.88];
  }
}

// `?paperdollHeld=off|0|false` — retail parity: no held items on the doll.
// Retail's doll is a fresh object: `gmPaperDollUI::RedressCreature`
// (acclient.c:220031) → `CPhysicsObj::makeObject(player)` = makeObject(setup)
// + `MorphToExistingObject` (:316880 — copies the part array + translucency,
// never the CHILDLIST), then `DoObjDescChangesFromDefault`. A wielded weapon,
// shield or torch therefore never shows on it (the examine 3D view, :226945,
// is built the same way). DEFAULT ON keeps holtburger's Wave C / PR8
// wielded-children pass; flipping the default is an owner call.
export function paperdollHeldEnabled(search) {
  let v = null;
  try { v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("paperdollHeld"); }
  catch (_) { v = null; }
  return !(v === "off" || v === "0" || v === "false");
}

// 2026-10-20 (improvement hunt hud-audio-2) — one long-lived viewport per
// consumer instead of a WebGL2 context per mount. Before: every inventory
// open built `new THREE.WebGLRenderer` (a fresh context + a fresh three
// program cache, so the doll's MeshStandardMaterial programs re-linked),
// re-ran the wasm palette composite + one texture upload per doll surface,
// and every close ran `renderer.dispose()` + `forceContextLoss()`
// (main-panel hide/closeView → inventory cleanup). Every creature / player
// examine did the same, and examine's onAppearanceRefresh did it again on
// ANY entity's appearance change. Now `PaperdollViewport.acquire(consumer,
// {width, height})` hands back that consumer's parked viewport, the caller
// re-parents `vp.dom` into its host, and `vp.release()` detaches the canvas
// instead of destroying the context; the `_lastLoadKey` debounce then makes
// an unchanged doll a no-op. One viewport PER CONSUMER ("inventory",
// "examine"), not one shared canvas: the examine floaty and the inventory
// panel are on screen together. A second acquire of a consumer that is still
// held (a main-panel examine + the floaty) gets a transient viewport —
// today's per-mount behaviour, disposed on release. The context is destroyed
// only on `pagehide`, a `webglcontextlost` on its own canvas, or a release
// past the parked-texture budget (PAPERDOLL_PARK_MAX_TEXTURES below).
//
// Pixel-identical by construction: a re-acquired viewport hides its parked
// rig until the consumer's first loadPlayer says whether it is still current
// (same key → shown at once; new key → blank until the new rig lands, exactly
// what a fresh instance shows), and a build that fell back to a placeholder
// material (surface not decoded yet, composite failed, held item not fetched)
// re-loads on the next acquire, as a fresh instance would have.
//
// `?paperdollPersist=off|0|false` restores per-mount construction + dispose.
export function paperdollPersistEnabled(search) {
  let v = null;
  try { v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("paperdollPersist"); }
  catch (_) { v = null; }
  return !(v === "off" || v === "0" || v === "false");
}
let _persistMemo = null; // read once per page (acquire runs per mount, not per frame)
function paperdollPersistOn() {
  if (_persistMemo === null) _persistMemo = paperdollPersistEnabled();
  return _persistMemo;
}

/** consumer key → its long-lived PaperdollViewport (held or parked). */
const _pool = new Map();
/** Console / test live-check: how many WebGL contexts the doll has cost. */
export const paperdollPoolStats = { constructed: 0, reused: 0, transient: 0, recycled: 0, disposed: 0 };
// Parking keeps every GPU copy the context has made. The doll's own
// composited textures are freed on each rebuild, but the shared MaterialCache
// textures a non-paletted creature (or a held item) draws with are never
// disposed while the cache holds them (unbounded unless `?matBudgetMB`), so a
// parked examine context would keep a second GPU copy of every such creature
// ever examined. Past this many live textures (`renderer.info.memory`, read
// live) a release destroys the context instead and the next acquire builds a
// fresh one — today's cost, once per many examines. The inventory doll (one
// player, ~10-30 surfaces) stays well under it.
export const PAPERDOLL_PARK_MAX_TEXTURES = 64;
// Seam for node tests (no WebGL there); production always builds the real one.
let _createRenderer = (opts) => new THREE.WebGLRenderer(opts);
let _pagehideInstalled = false;
function installPagehide() {
  if (_pagehideInstalled) return;
  _pagehideInstalled = true;
  try { globalThis.addEventListener?.("pagehide", disposePaperdollPool); } catch (_) {}
}

/**
 * pagehide: destroy every parked viewport's context now. A held one leaves
 * the pool and is destroyed when its consumer releases it.
 */
export function disposePaperdollPool() {
  for (const [key, vp] of [..._pool]) {
    _pool.delete(key);
    if (!vp._held) vp.dispose();
  }
}

/** Test seam: swap the renderer factory / pin the flag; empties the pool. */
export function _configurePaperdollPoolForTests({ createRenderer, persist } = {}) {
  for (const vp of [..._pool.values()]) { vp._held = false; vp.dispose(); }
  _pool.clear();
  if (typeof createRenderer === "function") _createRenderer = createRenderer;
  _persistMemo = persist === undefined ? null : !!persist;
  for (const k of Object.keys(paperdollPoolStats)) paperdollPoolStats[k] = 0;
}

export class PaperdollViewport {
  /**
   * hud-audio-2 (2026-10-20): the consumer's long-lived viewport (see the
   * pool block above). The caller appends `vp.dom` to its host, calls
   * `loadPlayer`, and calls `vp.release()` on unmount — never `dispose()`.
   * @param {string} consumer — pool key ("inventory" | "examine")
   * @param {{width?: number, height?: number}} [size]
   * @returns {PaperdollViewport}
   */
  static acquire(consumer, { width = DEFAULT_W, height = DEFAULT_H } = {}) {
    const key = consumer ? String(consumer) : "";
    if (key && paperdollPersistOn()) {
      let vp = _pool.get(key);
      if (vp && (vp._disposed || vp._contextLost)) { _pool.delete(key); vp = null; }
      if (vp && !vp._held) {
        vp._held = true;
        vp._unpark(width, height);
        paperdollPoolStats.reused += 1;
        return vp;
      }
      if (!vp) {
        vp = new PaperdollViewport({ width, height });
        vp._poolKey = key;
        vp._held = true;
        _pool.set(key, vp);
        installPagehide();
        return vp;
      }
      // Held by another live mount → a transient viewport, below.
    }
    const t = new PaperdollViewport({ width, height });
    t._held = true;
    paperdollPoolStats.transient += 1;
    return t;
  }

  /**
   * hud-audio-2: unmount. A pooled viewport detaches its canvas and parks
   * (context, programs, textures and rig kept); anything else (transient,
   * `?paperdollPersist=off`, dropped from the pool by pagehide / context
   * loss, or built with `new`) is disposed, and so is a pooled one holding
   * more than PAPERDOLL_PARK_MAX_TEXTURES GPU textures. Idempotent.
   */
  release() {
    if (this._disposed) return;
    const pooled = this._poolKey != null && _pool.get(this._poolKey) === this;
    if (!pooled) { this.dispose(); return; }
    if (!this._held) return;
    let liveTextures = 0;
    try { liveTextures = this.renderer.info?.memory?.textures ?? 0; } catch (_) { liveTextures = 0; }
    if (liveTextures > PAPERDOLL_PARK_MAX_TEXTURES) {
      paperdollPoolStats.recycled += 1;
      this.dispose();
      return;
    }
    this._held = false;
    this.stop();
    const el = this.canvas;
    if (el?.parentNode) el.parentNode.removeChild(el);
  }

  /** hud-audio-2: re-acquire a parked viewport at (width, height). */
  _unpark(width, height) {
    // Same end state as the constructor's setSize → setPixelRatio.
    const dpr = window.devicePixelRatio || 1;
    try {
      if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr);
      if (this.size.w !== width || this.size.h !== height) {
        this.size = { w: width, h: height };
        this.renderer.setSize(width, height);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
      }
    } catch (_) {}
    // A degraded build (placeholder material) re-loads, as a fresh instance would.
    if (this._degraded) this._lastLoadKey = null;
    // A fresh instance shows nothing until its first load lands: hide the
    // parked rig until loadPlayer confirms (or replaces) it, and clear the
    // preserved drawing buffer so the previous doll never flashes.
    this.rigRoot.visible = false;
    this.renderNow();
  }

  /**
   * @param {{width?: number, height?: number}} [opts]
   */
  constructor({ width = DEFAULT_W, height = DEFAULT_H } = {}) {
    this.size = { w: width, h: height };
    paperdollPoolStats.constructed += 1;
    this.renderer = _createRenderer({
      alpha: true,
      antialias: true,
      // 2026-05-29 — preserveDrawingBuffer:true so the single render
      // inside `loadPlayer()` stays composited after the next browser
      // paint cycle. Without it, the back-buffer gets swapped/cleared
      // and the canvas reads as transparent until start() is called.
      // The doll is small (224×214) so the extra memory cost is trivial.
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0.0); // transparent
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const el = this.renderer.domElement;
    el.style.display = "block";
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    // Slot squares overlay this canvas; clicks must pass through to
    // the slots underneath, not get swallowed by the WebGL canvas.
    el.style.pointerEvents = "none";
    this.canvas = el;

    this.scene = new THREE.Scene();
    // Camera angled slightly above the head height (~10°) per retail's
    // front-3/4 paperdoll framing. `_frameRig` retargets after the rig
    // bounds are known; these starting values just keep us from peeking
    // through an empty scene.
    this.camera = new THREE.PerspectiveCamera(PAPERDOLL_FOV_DEG, width / height, 0.05, 50);
    this._placeRetailCamera(0);

    // Lighting: ambient + front-key + cool back fill. Warm tint matches
    // the dye-viewport so the inventory doll reads the same as the
    // dye preview's player mesh.
    this.scene.add(new THREE.AmbientLight(0xfff0d0, 0.7));
    const key = new THREE.DirectionalLight(0xfff0c8, 0.95);
    key.position.set(1.5, 3, 2.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8090a0, 0.35);
    fill.position.set(-1.5, 1, -1.5);
    this.scene.add(fill);

    // AC body-local space is Z-up (X east, Y north, Z up). Three.js is
    // Y-up. The world entity rig handles this via its outer
    // `acQuatToThree` root rotation (entities.js:1131); here `dollRoot`
    // applies the equivalent fixed rotation so the partGroup positions
    // (raw AC `restOrigins`) render upright. Rotating −π/2 around X maps
    // AC.z → Three.y (up) and AC.y → Three −z.
    this.dollRoot = new THREE.Group();
    this.dollRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.dollRoot);
    // `rigRoot` lives in the AC frame and carries the retail doll heading
    // (bug 13): AC heading h (degrees, clockwise from +Y/north) is a
    // rotation of −h about AC +Z. Before this fix there was no heading at
    // all: the model faced AC +Y = three −Z, away from the camera.
    this.rigRoot = new THREE.Group();
    this.rigRoot.rotation.z = -PAPERDOLL_HEADING_DEG * Math.PI / 180;
    this.dollRoot.add(this.rigRoot);

    this._ownedMaterials = [];
    this._ownedTextures = [];
    this._rafId = null;
    this._disposed = false;
    // Stash of last-loaded params so callers can skip redundant reloads
    // when no substitution has actually changed.
    this._lastLoadKey = null;
    // Wave C / PR8 (2026-06-06): race-cancel token for loadPlayer.
    // Each loadPlayer call increments this; awaiting paths bail out
    // when their captured token != current so a late wieldedItems
    // animationCache.get can't clobber a newer reload.
    this._inflightLoadToken = 0;
    // Wave C / PR8 (2026-06-06): wielder-side holding-location cache,
    // keyed by wielder setupId. Mirrors `entities.js::_holdingLocCache`
    // pattern; populated lazily inside loadPlayer's wielded pass.
    this._holdingLocCache = new Map();
    // hud-audio-2 (2026-10-20) pool state — see PaperdollViewport.acquire.
    this._poolKey = null;      // consumer key while this is the pooled viewport
    this._held = false;        // acquired by a mounted consumer (vs parked)
    this._contextLost = false;
    this._degraded = false;    // last build used a placeholder material
    // A lost context is never handed out again: it leaves the pool at once
    // (the next acquire builds a fresh one); a parked one is destroyed now, a
    // held one when its consumer releases it. three's own listener (added
    // first) preventDefault()s, so a restore can still happen — repaint then.
    this._onContextLost = () => {
      if (this._disposed) return;
      this._contextLost = true;
      if (this._poolKey != null && _pool.get(this._poolKey) === this) _pool.delete(this._poolKey);
      if (!this._held) this.dispose();
    };
    this._onContextRestored = () => {
      if (!this._disposed && this._held) this.renderNow();
    };
    try {
      el.addEventListener("webglcontextlost", this._onContextLost);
      el.addEventListener("webglcontextrestored", this._onContextRestored);
    } catch (_) {}
    // 2026-10-07 — re-render when the canvas becomes visible (the panel opens).
    // This covers a load that finished while the panel was display:none. It
    // replaces the 2026-05-29 workaround, where inventory.js called start()
    // after every load: a perpetual rAF loop re-rendering a static doll every
    // frame, panel open or closed (~0.75 ms of main thread per frame, measured
    // on the 1070). IntersectionObserver costs nothing per frame and never
    // forces a layout.
    this._io = null;
    if (typeof IntersectionObserver === "function") {
      this._io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last?.isIntersecting) this.renderNow();
      });
      this._io.observe(el);
    }
  }

  /** One render of the current rig (no-op once disposed). */
  renderNow() {
    if (this._disposed) return;
    try { this.renderer.render(this.scene, this.camera); } catch (_) {}
  }

  /** Returns the canvas element — caller appends to its container. */
  get dom() { return this.canvas; }

  /**
   * Build a stable key for the (setupId, mtableId, paletteId, subPalettes)
   * tuple so callers can debounce no-op reloads.
   */
  _loadKey(setupId, mtableId, paletteId, subPalettes, wieldedItems, stanceLow, appearance) {
    const sp = subPalettes
      ? Array.from(subPalettes).join(",")
      : "";
    // Bug 13: the worn armour / clothing (ObjDesc part + texture swaps) is
    // part of the key, so equipping a piece reloads the doll.
    const mc = appearance?.modelChanges ? Array.from(appearance.modelChanges).join(",") : "";
    const tc = appearance?.textureChanges ? Array.from(appearance.textureChanges).join(",") : "";
    const her = (appearance?.heritage >>> 0) || 0;
    // Wave C / PR8 (2026-06-06): include wielded tuple + stance so equip
    // deltas + combat-mode toggle hot-swap the cached rig instead of
    // no-op'ing on the body-only key.
    let wt = "";
    if (Array.isArray(wieldedItems) && wieldedItems.length > 0) {
      const sorted = wieldedItems
        .slice()
        .sort((a, b) => (a?.itemGuid >>> 0) - (b?.itemGuid >>> 0))
        .map((w) => `${(w?.itemGuid >>> 0)}-${(w?.parentLocation >>> 0)}-${(w?.placement >>> 0)}`);
      wt = sorted.join(";");
    }
    return `${setupId >>> 0}:${mtableId >>> 0}:${paletteId >>> 0}:${sp}|w=${wt}|s=${(stanceLow >>> 0)}|mc=${mc}|tc=${tc}|h=${her}`;
  }

  /**
   * Load (or reload) the player rig. Idempotent — calling twice with
   * the same params is a no-op; calling with different params tears
   * down the prior rig + materials and rebuilds. Returns true on
   * success, false when the rig couldn't be built (no animationCache,
   * no setupId, etc).
   *
   * @param {number} setupId      — SetupModel DataID (0x02xxxxxx)
   * @param {number} mtableId     — MotionTable DID (0 = inert)
   * @param {number} paletteId    — base palette (0 = intrinsic)
   * @param {Uint32Array} subPalettes — flat [palette_did, offset, length, ...]
   *                                    triples (the player's CURRENT
   *                                    substitution set — already resolved
   *                                    by the wire EntityUpdate or
   *                                    applyAppearance code path).
   * @returns {Promise<boolean>}
   */
  /**
   * Wave C / PR8 (2026-06-06): extended signature.
   *
   * @param {Array<{itemGuid:number, parentLocation:number, placement:number,
   *   meta?:{setupId?:number, mtableId?:number, paletteId?:number,
   *   subPalettes?:Uint32Array}}>} [wieldedItems] — items to attach
   *   onto the rig (sword, wand, shield). Armor/ammo (equip_mask &
   *   0x3700000 == 0) is rendered via the body rig's ObjDesc path
   *   and must NOT be passed here.
   * @param {number} [stanceLow] — `window.__getCurrentStanceLow()`
   *   result. Currently informational; future pose-driven rendering
   *   may key off this. Caching uses it so a combat-mode toggle
   *   forces a re-render.
   */
  async loadPlayer(setupId, mtableId, paletteId, subPalettes, wieldedItems, stanceLow, appearance = null) {
    if (this._disposed) return false;
    if (!setupId) return false;
    // `?paperdollHeld=off`: retail's doll has no children (see
    // paperdollHeldEnabled) — the held items leave both the key and the build.
    if (!paperdollHeldEnabled()) wieldedItems = null;
    const key = this._loadKey(setupId, mtableId, paletteId, subPalettes, wieldedItems, stanceLow, appearance);
    if (key === this._lastLoadKey) {
      // hud-audio-2 (2026-10-20): the doll asked for is the one built, so a
      // build still in flight is for a key the consumer has moved off (it
      // would land over this one) — cancel it. And a re-acquired viewport
      // keeps its parked rig hidden until this confirmation (`_unpark`).
      ++this._inflightLoadToken;
      if (!this.rigRoot.visible) { this.rigRoot.visible = true; this.renderNow(); }
      return true;
    }
    // Wave C / PR8 — race-cancel token captured at entry.
    const token = ++this._inflightLoadToken;

    const em = window.liveScene3d?.entityManager;
    if (!em?.animationCache?.get) return false;
    const fetchKeyframes = em.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return false;

    let animEntry;
    try {
      // Bug 13 (2026-10-07): bake WITH the player's ObjDesc part + texture
      // swaps — the worn armour. Retail redresses the doll from the player's
      // visual desc (`gmPaperDollUI::RedressCreature` →
      // `DoObjDescChangesFromDefault(doll, get_player_visualdesc)`,
      // acclient.c:220061); this used to pass empty swaps (a bare body).
      animEntry = await em.animationCache.get(
        setupId >>> 0, mtableId >>> 0, 0, 0, fetchKeyframes,
        {
          modelChanges: appearance?.modelChanges ?? new Uint32Array(0),
          textureChanges: appearance?.textureChanges ?? new Uint32Array(0),
          paletteId: paletteId >>> 0,
          paletteSubsFlat: subPalettes ?? new Uint32Array(0),
        },
      );
    } catch (_) { return false; }
    if (token !== this._inflightLoadToken) return false;
    if (!animEntry || !Array.isArray(animEntry.partGroups)) return false;
    // eslint-disable-next-line no-console
    console.info(
      `[paperdoll] load setup=0x${(setupId >>> 0).toString(16)} heading=${PAPERDOLL_HEADING_DEG} ` +
      `fov=${PAPERDOLL_FOV_DEG} heritage=${(appearance?.heritage >>> 0) || 0} ` +
      `modelChanges=${appearance?.modelChanges?.length ?? 0} textureChanges=${appearance?.textureChanges?.length ?? 0} ` +
      `subPalettes=${subPalettes?.length ?? 0}`,
    );

    // Tear down prior rig + owned materials/textures before rebuild.
    // Geometries are AnimationCache-shared — do NOT dispose those.
    this._clearRig();
    // hud-audio-2: from here the rig is this build — the empty, visible
    // rigRoot a fresh instance starts with. `_degraded` collects placeholder
    // materials so the next acquire re-loads rather than keeping them.
    this.rigRoot.visible = true;
    this._degraded = false;

    // Build entity-owned materials via wasm compositor (mirrors
    // entities.js:1437-1462 spawn path) so substitutions land.
    // When paletteId=0 + no subPalettes, fall through to the shared
    // MaterialCache.getCached to avoid paying for fresh decode.
    const hasSubs = (paletteId >>> 0) !== 0
      || (subPalettes && subPalettes.length > 0);
    const allSurfaceDids = new Set();
    for (const pg of animEntry.partGroups) {
      if (!pg) continue;
      for (const did of pg.surfaceDids) allSurfaceDids.add(did >>> 0);
    }
    const matByDid = new Map();
    let composited = false;
    if (hasSubs && typeof em.wasmExports?.fetchEntitySurfacesPixels === "function") {
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          const results = await em.wasmExports.fetchEntitySurfacesPixels(
            dids, paletteId >>> 0, subPalettes ?? new Uint32Array(0),
          );
          // hud-audio-2: a newer load started during the composite. Without
          // this check both builds added meshes to the one rigRoot (a double
          // doll) — reachable within one inventory mount before, and across
          // examines now that the examine viewport is reused.
          if (token !== this._inflightLoadToken) {
            for (const sp of (results ?? [])) { if (sp?.free) try { sp.free(); } catch (_) {} }
            return false;
          }
          for (let i = 0; i < dids.length; i += 1) {
            const did = dids[i] >>> 0;
            const sp = results[i];
            if (!sp || sp.width === 0 || sp.height === 0) {
              if (sp?.free) try { sp.free(); } catch (_) {}
              matByDid.set(did, this._fallbackMaterial());
              continue;
            }
            const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
            if (sp.free) try { sp.free(); } catch (_) {}
            const mat = new THREE.MeshStandardMaterial({
              map: tex, roughness: 0.85, metalness: 0.0,
              side: THREE.DoubleSide,
            });
            this._ownedMaterials.push(mat);
            this._ownedTextures.push(tex);
            matByDid.set(did, mat);
          }
        }
        composited = true;
      } catch (_) { /* fall through to cache fallback */ }
    }
    // Un-recoloured cache materials stand in for a missing / failed composite.
    if (hasSubs && !composited) this._degraded = true;

    // Build per-part Group + child meshes. Mirrors entities.js's rig-build
    // loop (simplified — no restPose extras, no mixer, no shadows; this
    // is a static UI render, not a live scene entity).
    for (let p = 0; p < animEntry.partGroups.length; p += 1) {
      const partGroup = new THREE.Group();
      partGroup.name = `paperdoll-part-${p}`;
      if (animEntry.restOrigins && animEntry.restOrigins.length >= (p + 1) * 3) {
        partGroup.position.set(
          animEntry.restOrigins[p*3+0],
          animEntry.restOrigins[p*3+1],
          animEntry.restOrigins[p*3+2],
        );
      }
      if (animEntry.restOrientations && animEntry.restOrientations.length >= (p + 1) * 4) {
        const rq = animEntry.restOrientations;
        // AC wire order (qw, qx, qy, qz) → three.js (qx, qy, qz, qw)
        partGroup.quaternion.set(rq[p*4+1], rq[p*4+2], rq[p*4+3], rq[p*4+0]);
      }
      // Add to rigRoot FIRST so subsequent mesh world-matrix computations
      // pick up the rigRoot's AC→Three rotation (rotation.x = -π/2 set in
      // the ctor). Pre-2026-05-30 the order was reversed and bounds were
      // computed in AC body-local space → camera framing was misaligned
      // after the rotation was added.
      this.rigRoot.add(partGroup);
      const conv = animEntry.partGroups[p];
      if (conv) {
        for (const grp of (conv.groups ?? [])) {
          const did = grp.surfaceDid >>> 0;
          let mat = matByDid.get(did)
            ?? em.materialCache?.getCached?.(did)
            ?? this._fallbackMaterial();
          // getCached hands back the cache's shared fallback for a surface
          // not decoded yet (did 0 is the permanent no-surface sentinel).
          if (did !== 0 && mat === em.materialCache?.fallbackMaterial) this._degraded = true;
          const mesh = new THREE.Mesh(grp.geometry, mat);
          partGroup.add(mesh);
        }
      }
    }

    // Compute bounds in post-rotation world space once the whole rig is
    // assembled. setFromObject walks updateMatrixWorld() internally.
    //
    // Wave C / PR8 (2026-06-06): bounds are captured BEFORE attaching
    // wielded children so camera framing stays anchored on the body
    // silhouette. A held two-hander pushes the unbiased bounds out by
    // ~1m and would shrink the doll's apparent size. (Retail's doll never
    // has a held item at all: RedressCreature builds it without children —
    // see paperdollHeldEnabled / `?paperdollHeld=off`.)
    // Bug 13: retail framing is FIXED (no bounds fit) — doll at the origin,
    // feet on the floor, the heritage eye from UpdateForRace.
    this.rigRoot.position.set(0, 0, 0);
    this._placeRetailCamera(appearance?.heritage >>> 0);
    this.dollRoot.updateMatrixWorld(true);

    // Wave C / PR8 (2026-06-06): wielded-children pass. For each wielded
    // item, build a child rig from its meta and parent it under the
    // wielder part identified by the SetupModel's holding-location
    // table at the ParentLocation enum value. Race-cancel on token
    // mismatch so a late await can't land into a newer reload.
    // (`?paperdollHeld=off` nulled wieldedItems above → pass skipped.)
    if (Array.isArray(wieldedItems) && wieldedItems.length > 0) {
      try {
        await this._attachWieldedChildren(
          setupId >>> 0, wieldedItems, token,
        );
      } catch (_) { /* best-effort */ }
      if (token !== this._inflightLoadToken) return false;
    }

    this._lastLoadKey = key;
    // Single render — no rAF loop needed for a static doll. start()
    // remains available for callers that want continuous re-render.
    try { this.renderer.render(this.scene, this.camera); } catch (_) {}
    return true;
  }

  /**
   * Wave C / PR8 (2026-06-06): build a child rig for each wielded item
   * and parent it under the wielder part identified by ParentLocation.
   * Mirrors `scene3d/entities.js::attachChildToParent` but for the
   * paperdoll's static rig (no animation, no _attachedChildren tracking).
   */
  async _attachWieldedChildren(wielderSetupId, wieldedItems, token) {
    const em = window.liveScene3d?.entityManager;
    if (!em?.animationCache?.get) return;
    const fetchKeyframes = em.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return;
    const fetchHL = em.wasmExports?.fetchSetupHoldingLocations;
    let locTable = this._holdingLocCache.get(wielderSetupId);
    if (!locTable && typeof fetchHL === "function") {
      try {
        const bundle = await fetchHL(wielderSetupId);
        if (token !== this._inflightLoadToken) return;
        locTable = new Map();
        const locs = bundle?.takeLocations ? bundle.takeLocations() : [];
        for (const e of (locs ?? [])) {
          locTable.set((e.locationKey >>> 0), {
            partId: e.partId | 0,
            ox: +e.ox, oy: +e.oy, oz: +e.oz,
            qw: +e.qw, qx: +e.qx, qy: +e.qy, qz: +e.qz,
          });
        }
        this._holdingLocCache.set(wielderSetupId, locTable);
      } catch (_) { this._degraded = true; /* fall through; retried on the next acquire */ }
    }
    // Only items with the "Selectable" mask (equipMask & 0x3700000) — held
    // weapons / shields. Armor/clothing/ammo (equipMask without held bits)
    // are rendered via the body rig's ObjDesc path; attaching them here
    // would double-render. The caller already filters this; this is a
    // defense-in-depth guard.
    for (const w of wieldedItems) {
      if (!w || !w.meta) continue;
      const childSetup = (w.meta.setupId ?? w.meta.modelId ?? 0) >>> 0;
      if (childSetup === 0) continue;
      let childEntry = null;
      try {
        childEntry = await em.animationCache.get(
          childSetup, (w.meta.mtableId ?? 0) >>> 0, 0, 0, fetchKeyframes,
          {
            modelChanges: new Uint32Array(0),
            textureChanges: new Uint32Array(0),
            paletteId: (w.meta.paletteId ?? 0) >>> 0,
            paletteSubsFlat: w.meta.subPalettes ?? new Uint32Array(0),
          },
        );
      } catch (_) { this._degraded = true; continue; }
      if (token !== this._inflightLoadToken) return;
      if (!childEntry || !Array.isArray(childEntry.partGroups)) { this._degraded = true; continue; }
      const childRoot = new THREE.Group();
      childRoot.name = `paperdoll-wielded-${(w.itemGuid >>> 0)}`;
      for (let p = 0; p < childEntry.partGroups.length; p += 1) {
        const pg = childEntry.partGroups[p];
        if (!pg) continue;
        const partGroup = new THREE.Group();
        if (childEntry.restOrigins && childEntry.restOrigins.length >= (p + 1) * 3) {
          partGroup.position.set(
            childEntry.restOrigins[p*3+0],
            childEntry.restOrigins[p*3+1],
            childEntry.restOrigins[p*3+2],
          );
        }
        if (childEntry.restOrientations && childEntry.restOrientations.length >= (p + 1) * 4) {
          const rq = childEntry.restOrientations;
          partGroup.quaternion.set(rq[p*4+1], rq[p*4+2], rq[p*4+3], rq[p*4+0]);
        }
        for (const grp of (pg.groups ?? [])) {
          const did = grp.surfaceDid >>> 0;
          const mat = em.materialCache?.getCached?.(did) ?? this._fallbackMaterial();
          if (did !== 0 && mat === em.materialCache?.fallbackMaterial) this._degraded = true;
          partGroup.add(new THREE.Mesh(grp.geometry, mat));
        }
        childRoot.add(partGroup);
      }
      // Mount on wielder part per ParentLocation.
      const loc = locTable?.get((w.parentLocation >>> 0));
      const wielderParts = this.rigRoot.children;
      let mount = this.rigRoot;
      if (loc && loc.partId >= 0 && loc.partId < wielderParts.length) {
        mount = wielderParts[loc.partId];
      }
      if (loc) {
        childRoot.position.set(loc.ox, loc.oy, loc.oz);
        // AC quat order (qw, qx, qy, qz) -> three (qx, qy, qz, qw).
        childRoot.quaternion.set(loc.qx, loc.qy, loc.qz, loc.qw);
      }
      mount.add(childRoot);
    }
    this.rigRoot.updateMatrixWorld(true);
  }

  /** Retail camera: the heritage eye, looking straight along AC +Y. AC
   *  (x, y, z) is three (x, z, −y) here (dollRoot's −π/2 about X). */
  _placeRetailCamera(heritage) {
    const [ex, ey, ez] = paperdollEyeForHeritage(heritage);
    this.camera.fov = PAPERDOLL_FOV_DEG;
    this.camera.position.set(ex, ez, -ey);
    this.camera.lookAt(ex, ez, -ey - 1);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Legacy auto-fit (kept for reference; retail framing is fixed — see
   * `_placeRetailCamera`). Translates the rig so its xz-center
   * is at world origin + its feet sit at y=0, then positions the camera
   * front-3/4 above eye height, framing the full body height with ~10%
   * padding top/bottom.
   */
  _frameRig(bounds) {
    if (!bounds || bounds.isEmpty()) return;
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    // Translate rig: feet on y=0, xz-center at origin.
    this.rigRoot.position.set(-center.x, -bounds.min.y, -center.z);
    // Frame camera. fov in radians; distance derived from desired
    // vertical fill (body height should occupy ~80% of canvas height).
    const fov = (this.camera.fov * Math.PI) / 180;
    const targetFill = 0.82;
    const distance = (size.y * 0.5) / Math.tan(fov * 0.5) / targetFill;
    const targetY = size.y * 0.55; // chest height — eyes naturally settle there
    // Slight downward angle from above the head, swung to the right by
    // ~12° so the rig reads as 3/4 view rather than dead-flat front
    // (matches retail's gmPaperDollUI camera framing).
    const yaw = Math.PI / 15;
    this.camera.position.set(
      distance * Math.sin(yaw),
      targetY + size.y * 0.12,
      distance * Math.cos(yaw),
    );
    this.camera.lookAt(0, targetY, 0);
    this.camera.updateProjectionMatrix();
  }

  _fallbackMaterial() {
    this._degraded = true; // hud-audio-2: a placeholder → re-load on the next acquire
    if (!this._fallback) {
      this._fallback = new THREE.MeshStandardMaterial({
        color: 0x888888, roughness: 0.9, metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this._ownedMaterials.push(this._fallback);
    }
    return this._fallback;
  }

  _clearRig() {
    while (this.rigRoot.children.length > 0) {
      const child = this.rigRoot.children[0];
      this.rigRoot.remove(child);
      // Geometries are AnimationCache-shared — never dispose them here.
      // Owned materials/textures get freed in dispose() en masse.
    }
    // Dispose prior owned materials/textures eagerly so a hot-swap
    // doesn't accumulate them across reloads.
    for (const t of this._ownedTextures) {
      try { t.dispose(); } catch (_) {}
    }
    for (const m of this._ownedMaterials) {
      try { m.dispose(); } catch (_) {}
    }
    this._ownedTextures.length = 0;
    this._ownedMaterials.length = 0;
    this._fallback = null;
  }

  /**
   * Optional rAF loop. Off by default — the paperdoll is static, and the
   * IntersectionObserver in the constructor re-renders it when it is shown.
   * Callers that want a constantly-re-rendered viewport (e.g. for an
   * animated doll later) can call start() / stop(). Idempotent.
   */
  start() {
    if (this._rafId !== null || this._disposed) return;
    const tick = () => {
      if (this._disposed) return;
      this._rafId = requestAnimationFrame(tick);
      try { this.renderer.render(this.scene, this.camera); } catch (_) {}
    };
    tick();
  }

  stop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Dispose renderer + force WebGL context loss. Idempotent. Consumers call
   * `release()` (hud-audio-2); this runs for transient viewports, on
   * pagehide and on context loss.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._held = false;
    if (this._poolKey != null && _pool.get(this._poolKey) === this) _pool.delete(this._poolKey);
    paperdollPoolStats.disposed += 1;
    this.stop();
    try { this._io?.disconnect(); } catch (_) {}
    this._io = null;
    this._clearRig();
    const el = this.renderer.domElement;
    try {
      el?.removeEventListener?.("webglcontextlost", this._onContextLost);
      el?.removeEventListener?.("webglcontextrestored", this._onContextRestored);
    } catch (_) {}
    try { this.renderer.dispose(); } catch (_) {}
    // An already-lost context has nothing left to lose.
    if (!this._contextLost) { try { this.renderer.forceContextLoss(); } catch (_) {} }
    if (el?.parentNode) el.parentNode.removeChild(el);
  }
}
