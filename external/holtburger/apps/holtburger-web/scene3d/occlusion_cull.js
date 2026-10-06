// scene3d/occlusion_cull.js — GPU occlusion queries for outdoor-visible
// building interiors and entity rigs (`?occlusionCull`, DEFAULT ON, `=off`
// escape). Perf 2026-10-06.
//
// WHY. The frame on the 1070 is main-thread bound by draw submission (~10 µs
// per three.js draw, ~2,000 draws at Holtburg mid). From an outdoor camera the
// render set admits every frustum-visible SeenOutside interior cell (?stablist,
// retail CLandBlock::grab_visible_cells) UNCLIPPED, and every frustum-visible
// NPC rig (~40 part-surface draws per humanoid) — including the shopkeepers
// standing inside those interiors. Nearly all of it sits behind building walls.
// Measured upper bound (1070, Holtburg orbit, mid): interiors cut to doorway
// cells + indoor NPCs hidden = 1,973 -> 1,188 draws, 24.5 -> 30.5 fps.
//
// WHAT. Each candidate (an interior cell container, an entity rig) gets a proxy
// box drawn AFTER every opaque draw of the main world pass — colour and depth
// writes off, depth test on — wrapped in an ANY_SAMPLES_PASSED_CONSERVATIVE
// query. A proxy whose box put no sample on screen is occluded. This keeps
// retail's outcome (an interior shows through its doorway/window apertures and
// over open courtyard walls, retail's portal-clipped stablist) without the
// clip machinery: the depth buffer is the clip.
//
//   - Cell boxes are SHRUNK by CELL_SHRINK_M so a visible cell's own (double-
//     sided) walls can never occlude its own proxy; through an aperture the
//     inner box face still sits in front of the room's far wall.
//   - Entity boxes are PADDED (ENTITY_PAD_M) around the rig's bounds so the
//     rig never occludes its own proxy, and an attack swing stays inside.
//   - Query results land 1-2 frames late (WebGL never resolves a query inside
//     the frame that issued it). hidden -> visible flips on the FIRST visible
//     result; visible -> hidden needs HIDE_AFTER consecutive occluded results,
//     so a proxy grazing an edge cannot flicker.
//   - A camera inside (or within NEAR_GUARD_M of) a proxy box always counts as
//     visible — its faces would be near-clipped and read as occluded.
//   - Indoors (the portal walk is already tight, and ?indoorDepthSplit wipes
//     depth mid-frame) the culler is disarmed: every proxy reads visible.
//
// The proxies are ordinary three.js meshes in the main scene's TRANSPARENT list
// (after every opaque, whatever the opaque sort), on layer 0, never shadow
// casters, never raycast targets. One shared geometry, one shared material ⇒
// one program, no material switches between them.

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("occlusionCull") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function occlusionCullEnabled() {
  return FLAG;
}

export const CELL_SHRINK_M = 0.3;
export const ENTITY_PAD_M = 0.6;
export const NEAR_GUARD_M = 1.0;
export const HIDE_AFTER = 3;
// Flip damping (eye-test 2026-10-06, 1070 street sweeps): a proxy grazing an
// edge while the camera moves re-revealed every few frames (one Holtburg
// cell 8+ times in one sweep), and each reveal lands 1-2 frames late — a
// blink. A proxy revealed again within FLIP_WINDOW_FRAMES of its last reveal
// doubles its hide delay (up to HIDE_AFTER_MAX); a quiet proxy starts over at
// HIDE_AFTER. A still camera never flips, so steady culling is unchanged.
export const HIDE_AFTER_MAX = 24;
export const FLIP_WINDOW_FRAMES = 90;
// A proxy not re-requested for this many frames is retired (box hidden, query
// freed) — the cell left the render set / the entity left the frustum.
const RETIRE_FRAMES = 30;

/**
 * Pure state machine for one proxy (exported for the node test).
 * `result` true = samples passed (visible), false = occluded.
 */
export function stepProxyState(st, result, frame = 0) {
  if (result) {
    if (!st.visible) {
      st.hideAfter = frame - st.lastReveal <= FLIP_WINDOW_FRAMES
        ? Math.min((st.hideAfter || HIDE_AFTER) * 2, HIDE_AFTER_MAX)
        : HIDE_AFTER;
      st.lastReveal = frame;
    }
    st.occludedRun = 0;
    st.visible = true;
  } else {
    st.occludedRun += 1;
    if (st.occludedRun >= (st.hideAfter || HIDE_AFTER)) st.visible = false;
  }
  return st.visible;
}

export class OcclusionCuller {
  /**
   * @param {object} THREE three namespace
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene  the MAIN scene (the world RenderPass's scene)
   */
  constructor(THREE, renderer, scene) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.scene = scene;
    this.gl = renderer.getContext();
    this.armed = false;
    this.forceOff = false; // live A/B seam: window.__occlusionCull.off = true
    this._armEpoch = 0;
    this.frame = 0;
    this.camera = null;
    this._camPos = new THREE.Vector3();
    this.proxies = new Map(); // key -> proxy
    this.group = new THREE.Group();
    this.group.name = "occlusion-proxies";
    this.group.matrixAutoUpdate = false;
    this.group.layers.set(0);
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      side: THREE.DoubleSide,
      // three draws a double-sided TRANSPARENT material twice (back, then
      // front) unless forced single-pass — one draw per query is enough.
      forceSinglePass: true,
      fog: false,
      toneMapped: false,
    });
    this.material.name = "occlusion-proxy";
    // The query must bracket a REAL draw: never let ?asyncLink skip it.
    this.material.userData.__noAsyncLink = true;
    this.stats = { proxies: 0, issued: 0, resolved: 0, hidden: 0, pendingMax: 0, guarded: 0 };
    scene.add(this.group);
  }

  /** Once per frame, before any isVisible() read. Resolves finished queries. */
  beginFrame(camera, armed) {
    this.frame += 1;
    this.camera = camera || null;
    const wasArmed = this.armed;
    this.armed = !!armed && !!camera && !this.forceOff;
    if (camera) camera.getWorldPosition(this._camPos);
    const gl = this.gl;
    let hidden = 0, pending = 0, resolved = 0;
    for (const [key, p] of this.proxies) {
      if (p.query && p.queryPending) {
        let avail = false;
        try { avail = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE); } catch (_) { avail = true; }
        if (avail) {
          let passed = true;
          try { passed = gl.getQueryParameter(p.query, gl.QUERY_RESULT) !== 0; } catch (_) { passed = true; }
          p.queryPending = false;
          resolved += 1;
          // A result issued while disarmed (or before a re-arm) is stale.
          if (p.issuedArmedEpoch === this._armEpoch) stepProxyState(p, passed, this.frame);
        } else {
          pending += 1;
        }
      }
      if (this.frame - p.lastWanted > RETIRE_FRAMES) {
        this._retire(key, p);
        continue;
      }
      if (!p.visible) hidden += 1;
    }
    if (this.armed !== wasArmed) {
      // (Re)arming or disarming invalidates every verdict: start over visible.
      this._armEpoch += 1;
      for (const p of this.proxies.values()) { p.visible = true; p.occludedRun = 0; }
    }
    // Default every box to not-drawn; want*() re-enables the ones in use.
    for (const p of this.proxies.values()) p.mesh.visible = false;
    this.group.visible = this.armed;
    this.stats.proxies = this.proxies.size;
    this.stats.hidden = hidden;
    this.stats.resolved += resolved;
    if (pending > this.stats.pendingMax) this.stats.pendingMax = pending;
  }

  _retire(key, p) {
    try { if (p.query) this.gl.deleteQuery(p.query); } catch (_) {}
    this.group.remove(p.mesh);
    this.proxies.delete(key);
  }

  _proxy(key) {
    let p = this.proxies.get(key);
    if (!p) {
      const mesh = new this.THREE.Mesh(this.geometry, this.material);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 2147483000; // last within the transparent list
      mesh.raycast = () => {};
      mesh.visible = false;
      p = {
        key, mesh, query: null, queryPending: false, issuedFrame: -1, issuedArmedEpoch: -1,
        visible: true, occludedRun: 0, lastWanted: this.frame, hideAfter: HIDE_AFTER, lastReveal: -Infinity,
      };
      const self = this;
      mesh.onBeforeRender = function (renderer, scene, camera) {
        if (scene !== self.scene || camera !== self.camera || p.issuedFrame === self.frame || p.queryPending) return;
        const gl = self.gl;
        if (!p.query) { try { p.query = gl.createQuery(); } catch (_) { return; } }
        try {
          gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, p.query);
          p._open = true;
        } catch (_) { p._open = false; }
      };
      mesh.onAfterRender = function () {
        if (!p._open) return;
        p._open = false;
        try { self.gl.endQuery(self.gl.ANY_SAMPLES_PASSED_CONSERVATIVE); } catch (_) { return; }
        p.queryPending = true;
        p.issuedFrame = self.frame;
        p.issuedArmedEpoch = self._armEpoch;
        self.stats.issued += 1;
      };
      this.group.add(mesh);
      this.proxies.set(key, p);
    }
    return p;
  }

  /**
   * Declare `key` a candidate this frame with an AC-or-three world AABB given as
   * (minX,minY,minZ,maxX,maxY,maxZ) in the MAIN SCENE's frame. Returns whether
   * the candidate should draw this frame.
   */
  want(key, minX, minY, minZ, maxX, maxY, maxZ) {
    if (!this.armed) return true;
    const p = this._proxy(key);
    p.lastWanted = this.frame;
    const c = this._camPos;
    if (c.x > minX - NEAR_GUARD_M && c.x < maxX + NEAR_GUARD_M &&
        c.y > minY - NEAR_GUARD_M && c.y < maxY + NEAR_GUARD_M &&
        c.z > minZ - NEAR_GUARD_M && c.z < maxZ + NEAR_GUARD_M) {
      // Camera at/inside the box: never trust (or issue) a query.
      p.visible = true;
      p.occludedRun = 0;
      this.stats.guarded += 1;
      return true;
    }
    const m = p.mesh;
    const sx = Math.max(maxX - minX, 0.05), sy = Math.max(maxY - minY, 0.05), sz = Math.max(maxZ - minZ, 0.05);
    const e = m.matrix.elements;
    e[0] = sx; e[1] = 0; e[2] = 0; e[3] = 0;
    e[4] = 0; e[5] = sy; e[6] = 0; e[7] = 0;
    e[8] = 0; e[9] = 0; e[10] = sz; e[11] = 0;
    e[12] = (minX + maxX) * 0.5; e[13] = (minY + maxY) * 0.5; e[14] = (minZ + maxZ) * 0.5; e[15] = 1;
    m.matrixWorld.copy(m.matrix); // group sits at the scene root, identity
    m.matrixWorldNeedsUpdate = false;
    // Draw (= re-query) only when no result is still in flight.
    m.visible = !p.queryPending;
    return p.visible;
  }

  dispose() {
    for (const [key, p] of this.proxies) this._retire(key, p);
    this.scene.remove(this.group);
    this.geometry.dispose();
    this.material.dispose();
  }
}

let _culler = null;

/** The scene's culler (lazily built), or null when the flag is off / no WebGL2. */
export function getOcclusionCuller(scene3d, THREE) {
  if (!FLAG || !scene3d?.renderer || !scene3d?.scene) return null;
  if (_culler && _culler.scene === scene3d.scene && _culler.renderer === scene3d.renderer) return _culler;
  const gl = scene3d.renderer.getContext?.();
  if (!gl || typeof gl.createQuery !== "function" || gl.ANY_SAMPLES_PASSED_CONSERVATIVE === undefined) return null;
  try {
    _culler = new OcclusionCuller(THREE, scene3d.renderer, scene3d.scene);
  } catch (_) {
    _culler = null;
    return null;
  }
  scene3d._occlusionCuller = _culler;
  if (typeof window !== "undefined") {
    try {
      window.__occlusionCull = {
        get enabled() { return !!_culler; },
        get armed() { return !!_culler?.armed; },
        get off() { return !!_culler?.forceOff; },
        set off(v) { if (_culler) _culler.forceOff = !!v; },
        get stats() { return _culler ? { ..._culler.stats, frame: _culler.frame } : null; },
        hiddenKeys() { return _culler ? [..._culler.proxies.values()].filter((p) => !p.visible).map((p) => p.key) : []; },
      };
    } catch (_) {}
  }
  return _culler;
}
