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
 * WebGL contexts are bounded (Chrome caps ~16); inventory mount/unmount
 * lifecycle disposes the viewport on view swap so contexts don't leak.
 */

import * as THREE from "three";
import { surfacePixelsToTexture } from "../scene3d/adapter.js";

const DEFAULT_W = 224;
const DEFAULT_H = 214;

export class PaperdollViewport {
  /**
   * @param {{width?: number, height?: number}} [opts]
   */
  constructor({ width = DEFAULT_W, height = DEFAULT_H } = {}) {
    this.size = { w: width, h: height };
    this.renderer = new THREE.WebGLRenderer({
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
    this.camera = new THREE.PerspectiveCamera(28, width / height, 0.05, 50);
    this.camera.position.set(0, 1.05, 2.4);
    this.camera.lookAt(0, 0.95, 0);

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

    this.rigRoot = new THREE.Group();
    // AC body-local space is Z-up (X east, Y north, Z up). Three.js is
    // Y-up. The world entity rig handles this via its outer
    // `acQuatToThree` root rotation (entities.js:1131); here we apply the
    // equivalent fixed rotation on rigRoot so the partGroup positions
    // (raw AC `restOrigins`) render upright instead of lying on their
    // back. Rotating −π/2 around X maps AC.z → Three.y (up).
    this.rigRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.rigRoot);

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
  }

  /** Returns the canvas element — caller appends to its container. */
  get dom() { return this.canvas; }

  /**
   * Build a stable key for the (setupId, mtableId, paletteId, subPalettes)
   * tuple so callers can debounce no-op reloads.
   */
  _loadKey(setupId, mtableId, paletteId, subPalettes, wieldedItems, stanceLow) {
    const sp = subPalettes
      ? Array.from(subPalettes).join(",")
      : "";
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
    return `${setupId >>> 0}:${mtableId >>> 0}:${paletteId >>> 0}:${sp}|w=${wt}|s=${(stanceLow >>> 0)}`;
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
  async loadPlayer(setupId, mtableId, paletteId, subPalettes, wieldedItems, stanceLow) {
    if (this._disposed) return false;
    if (!setupId) return false;
    const key = this._loadKey(setupId, mtableId, paletteId, subPalettes, wieldedItems, stanceLow);
    if (key === this._lastLoadKey) return true;
    // Wave C / PR8 — race-cancel token captured at entry.
    const token = ++this._inflightLoadToken;

    const em = window.liveScene3d?.entityManager;
    if (!em?.animationCache?.get) return false;
    const fetchKeyframes = em.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return false;

    let animEntry;
    try {
      animEntry = await em.animationCache.get(
        setupId >>> 0, mtableId >>> 0, 0, 0, fetchKeyframes,
        {
          modelChanges: new Uint32Array(0),
          textureChanges: new Uint32Array(0),
          paletteId: paletteId >>> 0,
          paletteSubsFlat: subPalettes ?? new Uint32Array(0),
        },
      );
    } catch (_) { return false; }
    if (!animEntry || !Array.isArray(animEntry.partGroups)) return false;

    // Tear down prior rig + owned materials/textures before rebuild.
    // Geometries are AnimationCache-shared — do NOT dispose those.
    this._clearRig();

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
    if (hasSubs && typeof em.wasmExports?.fetchEntitySurfacesPixels === "function") {
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          const results = await em.wasmExports.fetchEntitySurfacesPixels(
            dids, paletteId >>> 0, subPalettes ?? new Uint32Array(0),
          );
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
      } catch (_) { /* fall through to cache fallback */ }
    }

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
    // ~1m and would shrink the doll's apparent size; retail's
    // gmPaperDollUI frames on the body and lets the weapon overflow.
    this.rigRoot.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.rigRoot);

    this._frameRig(bounds);

    // Wave C / PR8 (2026-06-06): wielded-children pass. For each wielded
    // item, build a child rig from its meta and parent it under the
    // wielder part identified by the SetupModel's holding-location
    // table at the ParentLocation enum value. Race-cancel on token
    // mismatch so a late await can't land into a newer reload.
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
      } catch (_) { /* fall through */ }
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
      } catch (_) { continue; }
      if (token !== this._inflightLoadToken) return;
      if (!childEntry || !Array.isArray(childEntry.partGroups)) continue;
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

  /**
   * Auto-fit camera + center rig. Translates the rig so its xz-center
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
   * Optional rAF loop. Off by default — the paperdoll is static. Callers
   * that want a constantly-re-rendered viewport (e.g. for an animated
   * doll later) can call start() / stop(). Idempotent.
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

  /** Dispose renderer + force WebGL context loss. Idempotent. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._clearRig();
    try { this.renderer.dispose(); } catch (_) {}
    try { this.renderer.forceContextLoss(); } catch (_) {}
    const el = this.renderer.domElement;
    if (el?.parentNode) el.parentNode.removeChild(el);
  }
}
