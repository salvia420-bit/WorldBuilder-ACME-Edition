/**
 * Mini 3D viewport for dye-preview tooltips.
 *
 * Wave 7.9.A — adds a tiny THREE.js scene to the dye-preview tooltip
 * so the player sees the rotating armor mesh with the chosen dye
 * applied, on a pedestal. Borrows the existing animationCache for
 * rig parts + composes materials via fetchEntitySurfacesPixels —
 * byte-parity with the spawn-time render path.
 *
 * Each viewport owns its own WebGLRenderer + Scene + Camera +
 * rAF loop. WebGL contexts are bounded (Chrome caps ~16); the
 * plugin disposes the viewport when the tooltip hides so contexts
 * don't accumulate.
 *
 * Player mesh next-to-armor is deferred to D.3 — pedestal-only for
 * the MVS.
 */

import * as THREE from "three";
import { surfacePixelsToTexture } from "../scene3d/adapter.js";

const DEFAULT_SIZE = 280;
// Wave 7.9.B — D.3 callers pass 360×280 (square 280 would crop the
// player rig at half-scale beside the pedestal).
const ROTATION_SPEED = 0.008; // radians/frame at 60fps → ~30s/revolution

export class DyeViewport {
  /**
   * @param {HTMLElement} container — parent element to mount the canvas in
   * @param {number} [size=280] — square size in CSS pixels
   */
  constructor(container, sizeOrWidth = DEFAULT_SIZE, height = null) {
    // Wave 7.9.B — accept rectangular sizing for the D.3 player-mesh
    // path. Default stays square 280×280 for callers that don't pass
    // explicit dims.
    const w = sizeOrWidth;
    const h = height ?? sizeOrWidth;
    this.size = { w, h };
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x1c160e, 0.0); // transparent — let tooltip bg show
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;

    this.scene = new THREE.Scene();
    // Camera angled to show the armor 3/4 from slightly above. The
    // rig auto-fits via _frameRig once loaded.
    this.camera = new THREE.PerspectiveCamera(35, w / h, 0.05, 50);
    this.camera.position.set(0, 1.4, 2.6);
    this.camera.lookAt(0, 0.85, 0);

    // Lights: ambient + key directional, warm-tinted to feel AC-ish.
    this.scene.add(new THREE.AmbientLight(0xfff0d0, 0.55));
    const key = new THREE.DirectionalLight(0xfff0c8, 0.95);
    key.position.set(2.5, 4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8090a0, 0.35);
    fill.position.set(-2, 1, -2);
    this.scene.add(fill);

    this.pedestal = this._buildPedestal();
    this.scene.add(this.pedestal);

    this.rigRoot = new THREE.Group();
    this.scene.add(this.rigRoot);

    // Wave 7.9.B — D.3: secondary rig for the local player at half-
    // scale next to the pedestal. Loaded lazily via loadPlayerMesh;
    // stays empty when no local player is known.
    this.playerRigRoot = new THREE.Group();
    this.playerRigRoot.scale.setScalar(0.5);
    this.scene.add(this.playerRigRoot);

    this._ownedMaterials = [];
    this._ownedTextures = [];
    this._rafId = null;
    this._rotation = 0;
    this._disposed = false;
    // R9 (2026-08-03) — race-cancel token, the same device the sibling
    // ac_paperdoll_viewport.js got in Wave C / PR8 (2026-06-06) and this
    // viewport never did. `loadDyedItem` / `loadPlayerMesh` each await twice
    // (animationCache.get, then fetchEntitySurfacesPixels) before mutating
    // rigRoot / playerRigRoot / _ownedMaterials / _ownedTextures, and the
    // dye picker calls them once per swatch click. Two overlapping calls can
    // resolve OUT OF ORDER (a cache-hit second click beats a cache-miss first
    // one), leaving the preview showing the older dye — and every stale
    // resumption still allocates GPU textures nobody frees. Bumped on entry,
    // re-checked after every await; a superseded (or post-dispose) load bails.
    //
    // Per-RIG counters, not one shared counter: loadDyedItem owns rigRoot and
    // loadPlayerMesh owns playerRigRoot, and plugins/dye-preview.js runs them
    // back to back. A single counter would make the player load cancel the
    // armor load (or vice versa) the moment either grew a second await.
    this._loadTokens = { dyed: 0, player: 0 };
  }

  /** True when `token` is still the newest load of `kind` and we're alive. */
  _loadStillCurrent(kind, token) {
    return !this._disposed && token === this._loadTokens[kind];
  }

  _buildPedestal() {
    // Two-tone stone pedestal: base + cap. Simple geometric shapes
    // (no DAT lookup — wide-Holtburg surveys turned up no
    // canonical "display pedestal" wcid + this avoids another
    // wire dependency). Looks reasonable as a tooltip prop.
    const group = new THREE.Group();
    const baseGeom = new THREE.CylinderGeometry(0.42, 0.5, 0.18, 24);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x4a3d28, roughness: 0.92, metalness: 0.05,
    });
    const base = new THREE.Mesh(baseGeom, baseMat);
    base.position.y = 0.09;
    group.add(base);
    const capGeom = new THREE.CylinderGeometry(0.36, 0.4, 0.06, 24);
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x6b5a3e, roughness: 0.78, metalness: 0.1,
    });
    const cap = new THREE.Mesh(capGeom, capMat);
    cap.position.y = 0.21;
    group.add(cap);
    return group;
  }

  /**
   * Load the dyed armor rig into the viewport. Replaces any existing
   * rig in place. Returns true on success.
   *
   * @param {number} setupId      — SetupModel DataID (0x02xxxxxx)
   * @param {number} mtableId     — MotionTable (0 ok for static items)
   * @param {number} paletteId    — base palette (0 = texture intrinsic)
   * @param {Uint32Array} subPalettes — flat [palette_did, offset, length, ...]
   *                                    triples — already resolved via
   *                                    pickPaletteForShade JS-side
   * @returns {Promise<boolean>}
   */
  async loadDyedItem(setupId, mtableId, paletteId, subPalettes) {
    if (this._disposed) return false;
    const kind = "dyed";
    const token = ++this._loadTokens.dyed; // R9 — race-cancel, see ctor
    const em = window.liveScene3d?.entityManager;
    if (!em?.animationCache?.get) return false;
    const fetchKeyframes = em.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return false;

    let animEntry;
    try {
      animEntry = await em.animationCache.get(
        setupId >>> 0,
        mtableId >>> 0,
        0,
        0,
        fetchKeyframes,
        {
          modelChanges: new Uint32Array(0),
          textureChanges: new Uint32Array(0),
          paletteId: paletteId >>> 0,
          paletteSubsFlat: subPalettes ?? new Uint32Array(0),
        },
      );
    } catch (_) {
      return false;
    }
    // R9 — a newer load (or dispose()) landed while we were awaiting; drop
    // this result rather than clobbering the rig with a stale dye.
    if (!this._loadStillCurrent(kind, token)) return false;
    if (!animEntry || !Array.isArray(animEntry.partGroups)) return false;

    // Tear down prior rig contents (geometry refs are cache-shared —
    // do NOT dispose; materials/textures owned by us → dispose).
    this._clearRig();

    // Build entity-owned materials via wasm compositor (mirrors
    // entities.js:1033 path so we get the right dyed pixels). When
    // paletteId == 0 && subPalettes empty, fall through to the
    // shared MaterialCache so we don't pay for fresh decode every
    // preview.
    const hasDye = (paletteId >>> 0) !== 0 || (subPalettes && subPalettes.length > 0);
    const allSurfaceDids = new Set();
    for (const pg of animEntry.partGroups) {
      if (!pg) continue;
      for (const did of pg.surfaceDids) allSurfaceDids.add(did >>> 0);
    }

    const matByDid = new Map();
    if (hasDye && typeof em.wasmExports?.fetchEntitySurfacesPixels === "function") {
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          const results = await em.wasmExports.fetchEntitySurfacesPixels(
            dids, paletteId >>> 0, subPalettes ?? new Uint32Array(0),
          );
          // R9 — superseded/disposed while decoding: free the wasm-owned
          // SurfacePixels boxes and build nothing. Without this the stale
          // load allocated THREE textures + materials into _ownedTextures /
          // _ownedMaterials that dispose() had already drained, so nothing
          // would ever free them.
          if (!this._loadStillCurrent(kind, token)) {
            for (const sp of results) { if (sp?.free) try { sp.free(); } catch (_) {} }
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
      } catch (_) { /* fall through to cache fallback */ }
    }

    // Build per-part Group + child meshes. Mirrors entities.js:1144
    // rig-build loop but without restPose, mixer, scene parenting,
    // shadows — preview-grade simplification.
    let bounds = new THREE.Box3();
    for (let p = 0; p < animEntry.partGroups.length; p += 1) {
      const partGroup = new THREE.Group();
      partGroup.name = `dye-preview-part-${p}`;
      if (Array.isArray(animEntry.restOrigins) || ArrayBuffer.isView(animEntry.restOrigins)) {
        const ro = animEntry.restOrigins;
        if (ro.length >= (p + 1) * 3) {
          partGroup.position.set(ro[p*3+0], ro[p*3+1], ro[p*3+2]);
        }
      }
      if (Array.isArray(animEntry.restOrientations) || ArrayBuffer.isView(animEntry.restOrientations)) {
        const rq = animEntry.restOrientations;
        if (rq.length >= (p + 1) * 4) {
          // AC wire order (qw, qx, qy, qz) → three.js (qx, qy, qz, qw)
          partGroup.quaternion.set(rq[p*4+1], rq[p*4+2], rq[p*4+3], rq[p*4+0]);
        }
      }
      const conv = animEntry.partGroups[p];
      if (conv) {
        for (const grp of (conv.groups ?? [])) {
          const did = (grp.surfaceDid >>> 0);
          let mat = matByDid.get(did);
          if (!mat) {
            mat = em.materialCache?.getCached?.(did) ?? this._fallbackMaterial();
          }
          const mesh = new THREE.Mesh(grp.geometry, mat);
          partGroup.add(mesh);
          mesh.updateMatrixWorld();
          const meshBox = new THREE.Box3().setFromObject(mesh);
          bounds = bounds.isEmpty() ? meshBox : bounds.union(meshBox);
        }
      }
      this.rigRoot.add(partGroup);
    }

    this._frameRig(bounds);
    return true;
  }

  /**
   * Wave 7.9.B — D.3 player-mesh-next-to-pedestal. Build a half-scale
   * rig representing the local player + their current equipment.
   * Mirrors loadDyedItem's part-assembly loop but places parts
   * under playerRigRoot at +x offset (next to the pedestal). The
   * player rig uses the player's CURRENT substitutions (no dye
   * overlay applied) so the viewer can compare "what I look like
   * now" vs "what this armor would look like dyed".
   *
   * Returns true on success. False when (a) no local player guid,
   * (b) no entity instance for the player, (c) animationCache fails.
   * Per the dispose-friendliness contract, calling this twice tears
   * down the prior playerRigRoot contents.
   *
   * @param {number} setupId
   * @param {number} mtableId
   * @param {number} paletteId
   * @param {Uint32Array} subPalettes — flat triple buffer (player's CURRENT)
   * @returns {Promise<boolean>}
   */
  async loadPlayerMesh(setupId, mtableId, paletteId, subPalettes) {
    if (this._disposed) return false;
    if (!setupId) return false;
    const kind = "player";
    const token = ++this._loadTokens.player; // R9 — race-cancel, see ctor
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
    // R9 — superseded or disposed while awaiting: don't touch playerRigRoot.
    if (!this._loadStillCurrent(kind, token)) return false;
    if (!animEntry || !Array.isArray(animEntry.partGroups)) return false;

    // Tear down prior player rig contents.
    while (this.playerRigRoot.children.length > 0) {
      this.playerRigRoot.remove(this.playerRigRoot.children[0]);
    }

    const hasDye = (paletteId >>> 0) !== 0 || (subPalettes && subPalettes.length > 0);
    const allSurfaceDids = new Set();
    for (const pg of animEntry.partGroups) {
      if (!pg) continue;
      for (const did of pg.surfaceDids) allSurfaceDids.add(did >>> 0);
    }
    const matByDid = new Map();
    if (hasDye && typeof em.wasmExports?.fetchEntitySurfacesPixels === "function") {
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          const results = await em.wasmExports.fetchEntitySurfacesPixels(
            dids, paletteId >>> 0, subPalettes ?? new Uint32Array(0),
          );
          // R9 — superseded/disposed while decoding: free the wasm-owned
          // SurfacePixels boxes and build nothing. Without this the stale
          // load allocated THREE textures + materials into _ownedTextures /
          // _ownedMaterials that dispose() had already drained, so nothing
          // would ever free them.
          if (!this._loadStillCurrent(kind, token)) {
            for (const sp of results) { if (sp?.free) try { sp.free(); } catch (_) {} }
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
              map: tex, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
            });
            this._ownedMaterials.push(mat);
            this._ownedTextures.push(tex);
            matByDid.set(did, mat);
          }
        }
      } catch (_) {}
    }

    for (let p = 0; p < animEntry.partGroups.length; p += 1) {
      const partGroup = new THREE.Group();
      partGroup.name = `dye-preview-player-part-${p}`;
      if (animEntry.restOrigins && animEntry.restOrigins.length >= (p + 1) * 3) {
        partGroup.position.set(
          animEntry.restOrigins[p*3+0],
          animEntry.restOrigins[p*3+1],
          animEntry.restOrigins[p*3+2],
        );
      }
      if (animEntry.restOrientations && animEntry.restOrientations.length >= (p + 1) * 4) {
        const rq = animEntry.restOrientations;
        partGroup.quaternion.set(rq[p*4+1], rq[p*4+2], rq[p*4+3], rq[p*4+0]);
      }
      const conv = animEntry.partGroups[p];
      if (conv) {
        for (const grp of (conv.groups ?? [])) {
          const did = grp.surfaceDid >>> 0;
          let mat = matByDid.get(did)
            ?? em.materialCache?.getCached?.(did)
            ?? this._fallbackMaterial();
          partGroup.add(new THREE.Mesh(grp.geometry, mat));
        }
      }
      this.playerRigRoot.add(partGroup);
    }

    // Position the half-scale player rig off to the side of the
    // pedestal. The .scale.setScalar(0.5) from the constructor
    // pre-applies the half-scale; here we just translate.
    this.playerRigRoot.position.set(1.0, 0.0, 0.0);
    return true;
  }

  /**
   * Auto-fit camera + position rig above pedestal. The pedestal cap
   * sits at y≈0.24; we lift the rig so its lowest bounds touch
   * y=0.24 and re-target the camera + adjust distance to fill the
   * frame. Falls through to defaults if bounds are empty.
   */
  _frameRig(bounds) {
    if (!bounds || bounds.isEmpty()) {
      this.rigRoot.position.set(0, 0.3, 0);
      this.camera.position.set(0, 1.4, 2.6);
      this.camera.lookAt(0, 0.85, 0);
      return;
    }
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    // Translate rig so its base is on the pedestal cap (y=0.24) and
    // its xz-center is at origin.
    this.rigRoot.position.set(-center.x, 0.24 - bounds.min.y, -center.z);
    // Frame the camera: distance = max half-size / tan(fov/2) * a
    // little slack. fov is in degrees.
    const fov = (this.camera.fov * Math.PI) / 180;
    const halfMax = Math.max(size.x, size.y, size.z) * 0.5;
    const distance = (halfMax / Math.tan(fov * 0.5)) * 1.9 + 0.4;
    const targetY = 0.24 + size.y * 0.5;
    this.camera.position.set(
      distance * Math.sin(Math.PI / 5),
      targetY + halfMax * 0.6,
      distance * Math.cos(Math.PI / 5),
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
      // child meshes own geometries that are AnimationCache-shared
      // (don't dispose); materials owned by us (disposed in dispose()).
      child.traverse((node) => {
        if (node.isMesh && node.geometry?.userData?.__disposable === true) {
          try { node.geometry.dispose(); } catch (_) {}
        }
      });
    }
  }

  /**
   * Wave 7.9.B — D.3 introspection helper for the diag harness.
   * Returns counts of part-Groups currently mounted on each rig.
   */
  getRigStats() {
    return {
      dyedRigPartCount: this.rigRoot?.children?.length ?? 0,
      playerRigPartCount: this.playerRigRoot?.children?.length ?? 0,
      size: { ...this.size },
    };
  }

  /** Begin rAF render loop. Idempotent. */
  start() {
    if (this._rafId !== null || this._disposed) return;
    const tick = () => {
      if (this._disposed) return;
      this._rafId = requestAnimationFrame(tick);
      this._rotation += ROTATION_SPEED;
      this.rigRoot.rotation.y = this._rotation;
      // Pedestal + player rig stay still — only the dyed item spins.
      // Player mesh as a static reference frame is more useful than
      // a counter-rotating one (the player would just look like they
      // were also dye-previewing themselves).
      try { this.renderer.render(this.scene, this.camera); } catch (_) {}
    };
    tick();
  }

  /** Stop rAF + tear down WebGL context. Idempotent. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._clearRig();
    while (this.playerRigRoot.children.length > 0) {
      const child = this.playerRigRoot.children[0];
      this.playerRigRoot.remove(child);
    }
    for (const t of this._ownedTextures) {
      try { t.dispose(); } catch (_) {}
    }
    for (const m of this._ownedMaterials) {
      try { m.dispose(); } catch (_) {}
    }
    this._ownedTextures.length = 0;
    this._ownedMaterials.length = 0;
    try { this.renderer.dispose(); } catch (_) {}
    try { this.renderer.forceContextLoss(); } catch (_) {}
    const el = this.renderer.domElement;
    if (el?.parentNode) el.parentNode.removeChild(el);
  }
}
