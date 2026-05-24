// Phase 7.x — DOM-projected nameplate overlay for the 3D path.
//
// Sister to the 2D PIXI path's `nameplateContainer` + `ensureNameplate` +
// `updateNameplatePositions` (`index.html:2388, 3462, 3506`). The 2D
// path uses a sibling PIXI.Container (NOT scaled by the camera) and
// projects entity world coords through the camera+world transforms to
// canvas pixels. The 3D path can't reuse PIXI for projection because
// the world is rendered by three.js with a perspective camera and a
// `worldRoot.rotation.x = -π/2` rotation — every entity rig's pose is
// in three.js world coords already, but the 2D screen mapping requires
// a per-frame NDC projection.
//
// `THREE.Vector3.project(camera)` is the three.js helper for NDC
// projection. It applies camera.matrixWorldInverse + camera.projection-
// Matrix to the input vector in place and returns NDC `(x, y, z)`
// where `(x, y) ∈ [-1, 1]` is on-screen and `z > 1` is behind the
// camera. We map NDC → pixel coords via the canvas's clientWidth /
// clientHeight (NOT the GL backbuffer pixel size, which is HiDPI-scaled).
//
// Why DOM instead of canvas-overlay 2D? Three reasons:
//
//   1. DOM <div>s get real OS font rendering — the page's `font-smoothing`
//      + system stack carries through. Text crispness matches the 2D
//      path's PIXI.Text style at zero extra cost.
//   2. DOM elements are pointer-events-discardable via CSS, so clicks
//      pass through to the canvas without any per-element hit testing.
//   3. The DOM tree's lifetime survives a renderer hot-swap; if we ever
//      switch 3D→2D mid-session, the nameplates can re-attach to PIXI
//      with the same `setNameplate(guid, name, follow)` calls.
//
// Hide rules:
//
//   - Behind camera: `ndc.z > 1.0` after `Vector3.project(camera)`. We
//     also hard-clip on |ndc.x| > 1.1 or |ndc.y| > 1.1 to avoid
//     hammering layout with off-screen nameplates.
//   - Behind/inside other geometry: NOT implemented yet (would require
//     a Raycaster from camera→entity hit-test per frame). The 2D path
//     also doesn't depth-test nameplates against geometry; it always
//     draws them on top. Same semantics here.
//
// Memory: one `<div>` per tracked GUID. `setNameplate` is idempotent
// (re-call with the same GUID replaces the previous node). Disposal
// is via `removeNameplate(guid)` or `dispose()`.

import * as THREE from "three";

// Metres above the entity's three.js world position to anchor the
// nameplate. AC's character rig height is roughly 1.8 m crown-to-feet;
// 1.9 m hovers just above the head. The 2D path lifts 14px above the
// sprite centre (`index.html:3521`), a different convention since the
// sprite is camera-relative; the 3D path picks a metre offset so the
// nameplate stays the same world-space height regardless of camera
// zoom.
const NAMEPLATE_OFFSET_Y_THREE = 1.9;

// NDC z > 1 means the projected point is BEHIND the camera (past the
// far clip plane after the perspective divide). three.js returns
// `(x, y, z) ∈ [-1, 1]^3` for points inside the frustum and pushes z
// past 1 when the point is past the near or far plane in the wrong
// direction. The behind-camera case is the load-bearing one — we
// must hide nameplates that have walked off the back of the camera or
// the text would smear across the screen as the projection inverts.
const NAMEPLATE_HIDE_BEHIND_THRESHOLD = 1.0;

// Hard-clip nameplates outside the |1.1| NDC box so we don't pay
// layout cost on text that's >10% off-screen. The 10% slack avoids
// nameplate "snap to invisible" right at the edge of the viewport.
const NAMEPLATE_NDC_OFFSCREEN_MARGIN = 1.1;

/**
 * NameplateLayer: per-rAF DOM projection of entity nameplates.
 *
 * Usage from init3D:
 *
 *   const layer = new NameplateLayer(domRoot, sceneCanvas);
 *   liveScene3d.nameplateLayer = layer;
 *
 * From EntityManager.spawn:
 *
 *   scene3d.nameplateLayer?.setNameplate(guid, meta.name, root);
 *
 * From EntityManager.remove:
 *
 *   scene3d.nameplateLayer?.removeNameplate(guid);
 *
 * From scene3d/loop.js#tickPerFrame (after cameraSwitcher.tick):
 *
 *   scene3d.nameplateLayer?.tick(activeCamera);
 *
 * The layer expects `domRoot` to already be CSS-positioned absolutely
 * over the canvas (init3D builds + attaches the div before constructing
 * the layer). The canvas reference is needed so per-frame projection
 * reads clientWidth / clientHeight live (so window-resize works
 * without re-construction).
 */
export class NameplateLayer {
  /**
   * @param {HTMLElement} domRoot — an absolute-positioned <div> overlaid
   *   on the canvas. The layer appends one `<div>` per tracked GUID
   *   under this root.
   * @param {HTMLCanvasElement} sceneCanvas — the three.js renderer's
   *   canvas. Used per-frame for clientWidth / clientHeight (the CSS
   *   layout size, NOT the GL backbuffer pixel size which carries the
   *   devicePixelRatio multiplier).
   */
  constructor(domRoot, sceneCanvas) {
    this.domRoot = domRoot;
    this.canvas = sceneCanvas;
    /** @type {Map<number, { el: HTMLDivElement, follow: any, name: string }>} */
    this.nodes = new Map();
    // Scratch Vector3 reused across every tick projection — avoids
    // per-frame GC churn. `tick(camera)` is hot (called every rAF).
    this._tmpVec = new THREE.Vector3();
    // Diagnostics — capture scripts read these to verify the layer is
    // actually doing work.
    this.lastTickProjectedCount = 0;
    this.lastTickVisibleCount = 0;
    this.lastTickHiddenBehindCount = 0;
  }

  /**
   * Add or replace a nameplate for `guid`. If the guid already has a
   * node, the existing element is reused (in-place text update) so a
   * name-only refresh (kind=3 MetaRefresh) doesn't churn layout.
   *
   * `followObj3d` is the THREE.Object3D whose world position the
   * nameplate tracks per frame. Typically `EntityInstance.root` (a
   * THREE.Group at the entity's world transform); could also be a
   * per-part anchor for boss nameplates that hover above a specific
   * limb. Whatever object is passed, its `matrixWorld` is what gets
   * projected each tick (via `getWorldPosition`).
   *
   * Empty / null `name` removes the nameplate (mirrors 2D's
   * `ensureNameplate` skip on missing meta.name at `index.html:3466`).
   *
   * Follow-on Task 34 (Bug B fix) — dedupe-by-guid: `this.nodes` is
   * keyed on the u32-coerced GUID. A second `setNameplate` call for
   * the same GUID is a no-op when the name + follow match; it updates
   * text in place when the name changes; it relabels the follow object
   * when the entity rig is rebuilt (re-spawn). At most ONE DOM
   * `<div>` exists per GUID at any time.
   */
  setNameplate(guid, name, followObj3d) {
    const key = (guid >>> 0);
    // Empty name → remove.
    if (!name || typeof name !== "string" || name.length === 0) {
      this.removeNameplate(key);
      return;
    }
    if (!followObj3d) return;
    // Dedupe-by-guid: if a node already exists for this key, reuse it.
    // This is the cross-call idempotency the smoke check relies on —
    // two calls in a row with the same (guid, name) result in one DOM
    // `<div>`, not two.
    const existing = this.nodes.get(key);
    if (existing) {
      if (existing.name !== name) {
        // The inner `<ac-text>` element holds the text — update it
        // there so the custom element re-renders. Fallback to direct
        // textContent if the inner element was never created (older
        // dev tooling, capture-script harness, etc.).
        if (existing.textEl) {
          existing.textEl.textContent = name;
        } else {
          existing.el.textContent = name;
        }
        existing.name = name;
      }
      existing.follow = followObj3d;
      return;
    }
    // First-time create. Minimal style — matches the 2D PIXI.Text
    // "readable on anything" intent: 11px sans-serif, white-on-black,
    // small padding, rounded corners. Anchored bottom-centre via
    // `transform: translate(-50%, -100%)` so `style.left`/`top` set the
    // bottom-centre pixel and the text grows up and outward.
    //
    // Inner `<ac-text>` swaps to the retail bitmap font once the font
    // runtime loads; until then, system-font textContent shows.
    const el = this.domRoot.ownerDocument.createElement("div");
    el.className = "nameplate-3d";
    const textEl = this.domRoot.ownerDocument.createElement("ac-text");
    textEl.textContent = name;
    el.appendChild(textEl);
    el.style.position = "absolute";
    // Perf B6 — position via `translate3d` (composited, layout-free)
    // instead of `style.left`/`top` (forces style recalc + layout). The
    // anchor offset (`translate(-50%, -100%)` for bottom-centre anchor)
    // is folded into the same `transform` string. The per-frame writer
    // in `tick()` overwrites this once we've projected to pixel coords;
    // setting it here just primes a sane starting transform.
    el.style.transform = "translate3d(0px, 0px, 0) translate(-50%, -100%)";
    el.style.padding = "2px 6px";
    el.style.background = "rgba(0, 0, 0, 0.6)";
    el.style.color = "#ffffff";
    el.style.font = "11px sans-serif";
    el.style.borderRadius = "4px";
    el.style.pointerEvents = "none";
    el.style.whiteSpace = "nowrap";
    el.style.userSelect = "none";
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.display = "none"; // start hidden until first tick projects it
    this.domRoot.appendChild(el);
    // Perf B6 — stash last-written {left, top} on the record so the
    // per-frame writer in `tick()` can skip identical transform writes.
    // NaN seeds force a first-frame write regardless of projected coords.
    this.nodes.set(key, { el, textEl, follow: followObj3d, name, _lastLeft: NaN, _lastTop: NaN });
  }

  /**
   * Remove a nameplate by GUID. Idempotent (silent no-op for unknown
   * GUIDs). Detaches the `<div>` from the DOM and drops the entry from
   * the internal map.
   */
  removeNameplate(guid) {
    const key = (guid >>> 0);
    const entry = this.nodes.get(key);
    if (!entry) return;
    try {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    } catch (_) {}
    this.nodes.delete(key);
  }

  /**
   * Per-rAF projection pass. Walks every tracked node, reads the
   * follow object's three.js world position (matrixWorld-aware via
   * `getWorldPosition`), adds the +Y nameplate offset in world space,
   * runs `Vector3.project(camera)` for the NDC mapping, and writes the
   * resulting pixel coords + visibility back onto `el.style`.
   *
   * `camera` is the active camera (the cameraSwitcher's
   * `activeCamera` — perspective or orthographic). Both project the
   * same way; `OrthographicCamera.project` returns NDC z ∈ [-1, 1]
   * when in frustum, and `> 1` when past the far plane.
   *
   * Cheap O(N) where N = tracked entity count. With ~hundreds of
   * entities the per-frame cost is dominated by getWorldPosition's
   * 4×4 matrix walk (one per entry) and the projection matmul (one
   * per entry). DOM writes only happen when style values change —
   * setting `el.style.left = "123px"` to the SAME pixel string is
   * idempotent in modern engines (no layout invalidation), so unless
   * the camera/entity moves, the per-frame cost is effectively the
   * matrix math alone.
   */
  tick(camera) {
    if (!camera) return;
    // canvas.clientWidth/clientHeight are the CSS layout size (in CSS
    // pixels). The GL backbuffer is sized by devicePixelRatio in
    // setSize(w, h, false), so pixel coordinates for the OVERLAY DIV
    // (which lives in CSS pixel space) must come from clientWidth /
    // clientHeight, NOT from `canvas.width / canvas.height`.
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    const halfW = w / 2;
    const halfH = h / 2;
    let projected = 0;
    let visible = 0;
    let hiddenBehind = 0;
    for (const entry of this.nodes.values()) {
      const follow = entry.follow;
      if (!follow) {
        entry.el.style.display = "none";
        continue;
      }
      // Read the follow object's world position into our scratch
      // Vector3. getWorldPosition walks the parent chain and applies
      // every matrix, so `worldRoot.rotation.x = -π/2` is included
      // automatically — we don't have to re-apply the AC→three.js
      // rotation here.
      try {
        follow.getWorldPosition(this._tmpVec);
      } catch (_) {
        entry.el.style.display = "none";
        continue;
      }
      // Lift the projection point above the entity's origin in three.js
      // world space. +Y is up in three world coords (worldRoot rotation
      // already converted AC Z-up to three Y-up for the position).
      this._tmpVec.y += NAMEPLATE_OFFSET_Y_THREE;
      // `Vector3.project(camera)` mutates the vector in place into NDC
      // coords. Behind-camera points come back with `z > 1`; on-screen
      // points have `(x, y, z) ∈ [-1, 1]^3` (modulo the near/far
      // clipping which lifts z past 1 in either direction outside the
      // frustum).
      this._tmpVec.project(camera);
      projected += 1;
      if (this._tmpVec.z > NAMEPLATE_HIDE_BEHIND_THRESHOLD) {
        entry.el.style.display = "none";
        hiddenBehind += 1;
        continue;
      }
      // Hard-clip off-screen NDC. The 0.1 NDC slack keeps the nameplate
      // visible right at the screen edge so it doesn't snap-to-hide
      // when the camera grazes the entity.
      if (
        this._tmpVec.x < -NAMEPLATE_NDC_OFFSCREEN_MARGIN ||
        this._tmpVec.x > NAMEPLATE_NDC_OFFSCREEN_MARGIN ||
        this._tmpVec.y < -NAMEPLATE_NDC_OFFSCREEN_MARGIN ||
        this._tmpVec.y > NAMEPLATE_NDC_OFFSCREEN_MARGIN
      ) {
        entry.el.style.display = "none";
        continue;
      }
      // NDC → pixel coords. NDC x ∈ [-1, 1] maps to pixel x ∈ [0, w]:
      //   px = (ndc.x + 1) * w/2 = ndc.x * halfW + halfW
      // NDC y ∈ [-1, 1] maps to pixel y ∈ [0, h] with the Y-flip
      // (NDC +y is screen up; CSS +y is screen down):
      //   py = (-ndc.y + 1) * h/2 = -ndc.y * halfH + halfH
      const px = this._tmpVec.x * halfW + halfW;
      const py = -this._tmpVec.y * halfH + halfH;
      // Round to integer pixels so the nameplate doesn't blur via
      // subpixel positioning. Performance-neutral; visual win is real.
      const pxInt = px | 0;
      const pyInt = py | 0;
      // Perf B6 — skip the transform write when the projected pixel
      // hasn't moved more than 0.5 px since the last frame. With 100+
      // visible nameplates this collapses ~100 style mutations / frame
      // into the handful that actually moved. We also switched from
      // `style.left`/`top` (forces style + layout recalc) to
      // `style.transform = translate3d(...)` (composited; no layout).
      // The bottom-centre anchor (`translate(-50%, -100%)`) is folded
      // into the same transform string.
      if (
        Math.abs(pxInt - entry._lastLeft) >= 0.5 ||
        Math.abs(pyInt - entry._lastTop) >= 0.5 ||
        entry._lastLeft !== entry._lastLeft || // NaN seed → first write
        entry._lastTop !== entry._lastTop
      ) {
        entry.el.style.transform = `translate3d(${pxInt}px, ${pyInt}px, 0) translate(-50%, -100%)`;
        entry._lastLeft = pxInt;
        entry._lastTop = pyInt;
      }
      entry.el.style.display = "block";
      visible += 1;
    }
    this.lastTickProjectedCount = projected;
    this.lastTickVisibleCount = visible;
    this.lastTickHiddenBehindCount = hiddenBehind;
  }

  /**
   * Detach every nameplate `<div>` from the DOM + clear the map.
   * Called on scene teardown / renderer hot-swap. The domRoot itself
   * is owned by init3D and is NOT removed here (it can be reused if
   * the layer is recreated against a fresh canvas).
   */
  dispose() {
    for (const entry of this.nodes.values()) {
      try {
        if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
      } catch (_) {}
    }
    this.nodes.clear();
    this.lastTickProjectedCount = 0;
    this.lastTickVisibleCount = 0;
    this.lastTickHiddenBehindCount = 0;
  }
}

/**
 * Convenience constructor: build the overlay `<div>` + the
 * NameplateLayer in one call. Returns `{ layer, domRoot }` so init3D
 * can both keep the layer reference and (later) tear down the DOM
 * element on dispose.
 *
 * The overlay `<div>` is appended to `canvas.parentElement` so it
 * tracks the canvas's CSS layout exactly. The CSS keeps it
 * `pointer-events: none` so clicks pass through to the canvas.
 */
export function createNameplateOverlay(canvas) {
  if (!canvas || !canvas.parentElement) return null;
  const doc = canvas.ownerDocument;
  const div = doc.createElement("div");
  div.id = "nameplate-layer-3d";
  div.style.position = "absolute";
  div.style.pointerEvents = "none";
  div.style.left = "0";
  div.style.top = "0";
  div.style.width = "100%";
  div.style.height = "100%";
  div.style.zIndex = "10";
  div.style.overflow = "hidden";
  // The parent needs `position: relative` (or absolute / fixed) for
  // the overlay's left/top/width/height percentages to anchor against
  // the canvas region. The canvas-column div is `display: flex; flex-
  // direction: column` (`index.html:26`); since flex parents are
  // statically positioned by default, set the canvas's parent to
  // relative so the overlay layers ON TOP of just the canvas, not the
  // whole page. Idempotent — re-running init3D doesn't accumulate
  // position styles.
  const parent = canvas.parentElement;
  if (getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }
  parent.appendChild(div);
  const layer = new NameplateLayer(div, canvas);
  return { layer, domRoot: div };
}
