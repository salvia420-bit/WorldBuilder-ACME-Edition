// ============================================================================
// Retail selection indicator — VividTargetIndicator (2026-08-02)
// ============================================================================
//
// Replaces the vibe-coded flat red torus that used to sit at the selected
// entity's feet (`EntityManager.setSelectedTarget`, the `_selectionRing`
// TorusGeometry). Retail draws NOTHING in the 3D scene: the target indicator
// is a 2D UI overlay that re-projects the target's SELECTION SPHERE every
// frame, which is exactly why the corners "move around depending on where the
// camera is".
//
// ## Retail chain (all line numbers = $DECOMP/acclient.c)
//
//   SmartBox::RenderNormalMode                                    :144866
//     └─ after the world + alpha list are drawn, if a target is set:
//        SmartBox::GetObjectBoundingBox(this, .., iid, &bbox, &heading) :144083
//          ├─ CPhysicsObj::GetSelectionSphere                     :315729
//          │    └─ CPartArray::GetSelectionSphere                 :326293
//          │         = CSetup.selection_sphere, scaled by the part array's
//          │           scale (center *= scale.xyz, radius *= scale.z)
//          ├─ Render::viewconeCheck(&sphere)                      :379711
//          │    0 → not visible at all  (→ status 2, off-screen arrow path)
//          ├─ Render::GetViewerBBox(&sphere, &top_left, &bottom_right) :378949
//          │    top_left     = center − r·Xaxis + r·Zaxis
//          │    bottom_right = center + r·Xaxis − r·Zaxis
//          │    (Xaxis / Zaxis are the CAMERA's right / up axes pushed through
//          │     Render::FrameCurrent — i.e. a camera-facing billboard quad
//          │     around the sphere, which is why the box tracks the camera)
//          └─ xformPointInternal on both corners → a screen-space tagRECT
//        then dispatches to the registered targetting callback:
//          VividTargetIndicator::Draw  :290065 → ::OnDraw  :289744
//
//   Return codes (ObjectSelectStatus): 1 = on-screen rect valid,
//   2 = off-screen (only `heading` valid), 3 = object unknown, 0 = neither.
//
//   VividTargetIndicator::OnDraw  :289744
//     oss == 1 → position the on-screen container and show it. Verbatim:
//        cw, ch  = corner image width/height  (m_rgOnScreenCorners[1])
//        left    = bbox.left  − cw     top    = bbox.top − ch
//        right   = bbox.right          bottom = bbox.bottom
//        if (left > right)  left = right − 1        // degenerate rect
//        if (top  > bottom) top  = bottom − 1
//        clamp left/top    ≥ 8
//        clamp right ≥ cw+8 , bottom ≥ ch+8
//        clamp left  ≤ (vpW − cw − 8) − cw ,  top ≤ (vpH − ch − 8) − ch
//        clamp right ≤ (vpW − cw − 8)      ,  bottom ≤ (vpH − ch − 8)
//        SetPosition(left, top)
//        SetSize(cw + right − left, ch + bottom − top)
//     oss == 2 → hide the corners, show ONE directional arrow on the viewport
//        edge, picked from the heading octant (45° buckets) and placed by
//        tan(heading) against the half-viewport, clamped to an 8 px margin.
//     colour  = gmRadarUI::GetBlipColor(target_iid)  (:289444) — the SAME
//        colour the radar blip uses, so hostiles read red, players blue, etc.
//        `VividTargetIndicator::SetOnScreenColor` :289694 re-tints all four
//        corner images whenever the colour changes.
//
// ## What this module does
//
// Same shape as `hud.js::NameplateLayer`: an absolutely-positioned DOM overlay
// over the canvas, projected once per rAF. Four CSS-triangle corner brackets
// are anchored to the corners of the projected box; a fifth element is the
// off-screen direction arrow. `pointer-events: none` throughout, so picking is
// untouched.
//
// Sphere source: `EntityManager` hands us `{ center: THREE.Vector3 (three
// world space), radius }`. The DAT `CSetup.selection_sphere` is not surfaced
// by the wasm bundle yet (only `fetchSetupPartSortCenters` exists), so the
// caller derives it from the rig's Box3 — see `computeSelectionSphere`. Wiring
// the real field is the follow-up noted in the handoff.
//
// Flag: `?selectionIndicator=` brackets (default) | ring | both | none.
// ============================================================================

import * as THREE from "three";

/** Retail's fixed 8 px viewport margin (OnDraw :289789-:289816). */
const EDGE_MARGIN_PX = 8;

/** Corner bracket leg length in CSS px (retail reads the DAT image size). */
const CORNER_PX = 10;

/** Corner bracket stroke thickness in CSS px. */
const CORNER_THICKNESS_PX = 3;

/**
 * NDC z past this means the point is behind the camera. Same threshold the
 * nameplate layer uses; retail's equivalent is `viewconeCheck` returning 0.
 */
const BEHIND_CAMERA_NDC_Z = 1.0;

/**
 * Default indicator colour. Retail pulls `gmRadarUI::GetBlipColor(iid)`
 * (:289444) so the brackets match the radar blip; until the blip-colour table
 * is ported, red is the right default (it is the hostile/creature blip colour
 * and the colour the user described).
 */
const DEFAULT_COLOR = "#ff2a1a";

/** Reused zero vector for the "no offset captured" path. */
const _ZERO = new THREE.Vector3(0, 0, 0);

/**
 * Read `?selectionIndicator`. Values: "brackets" (default), "ring" (the
 * legacy torus), "both", "none". Unknown values fall back to "brackets".
 * @returns {"brackets"|"ring"|"both"|"none"}
 */
export function readSelectionIndicatorMode() {
  try {
    if (typeof window === "undefined" || !window.location) return "brackets";
    const v = new URLSearchParams(window.location.search)
      .get("selectionIndicator")?.toLowerCase();
    if (v === "ring" || v === "legacy") return "ring";
    if (v === "both") return "both";
    if (v === "none" || v === "off") return "none";
    return "brackets";
  } catch (_) {
    return "brackets";
  }
}

/**
 * Retail `CPartArray::GetSelectionSphere` (:326293) reads
 * `CSetup.selection_sphere` and scales it. That DAT field is not surfaced by
 * the current wasm bundle, so derive an equivalent from the rig's world-space
 * bounding box. Cheap enough at one call per selection change (NOT per frame).
 *
 * Returned as an OFFSET from the rig root's world position (plus a radius) so
 * `tick` can re-anchor it to the rig's live world position every frame without
 * recomputing the box — retail stores the sphere in OBJECT space and pushes it
 * through `Render::positionPush(3, &obj->m_position)` at :144120, which is the
 * same relationship.
 *
 * @param {THREE.Object3D} root — the entity rig root.
 * @returns {{offset: THREE.Vector3, radius: number}|null}
 */
export function computeSelectionSphere(root) {
  if (!root) return null;
  try {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return null;
    // Retail's selection sphere is authored to hug the model; a Box3-derived
    // sphere circumscribes the box and so overshoots by up to √3. Pull it back
    // toward the box's own half-extent so the brackets sit near the silhouette
    // instead of far outside it.
    const size = box.getSize(new THREE.Vector3());
    const halfMax = Math.max(size.x, size.y, size.z) * 0.5;
    const rootWorld = root.getWorldPosition(new THREE.Vector3());
    return {
      offset: sphere.center.clone().sub(rootWorld),
      radius: Math.max(halfMax, sphere.radius * 0.62),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Four corner brackets + an off-screen arrow, projected each frame.
 */
export class SelectionBracketLayer {
  /**
   * @param {HTMLElement} domRoot — absolute-positioned overlay div.
   * @param {HTMLCanvasElement} sceneCanvas — the renderer canvas (read for
   *   `clientWidth`/`clientHeight`, i.e. CSS pixels, NOT the DPR-scaled
   *   backbuffer).
   */
  constructor(domRoot, sceneCanvas) {
    this.domRoot = domRoot;
    this.canvas = sceneCanvas;
    this.color = DEFAULT_COLOR;
    /** @type {{offset: THREE.Vector3, radius: number}|null} */
    this._sphere = null;
    /** @type {THREE.Object3D|null} */
    this._follow = null;
    this._guid = 0;

    this._tl = this._makeCorner("tl");
    this._tr = this._makeCorner("tr");
    this._bl = this._makeCorner("bl");
    this._br = this._makeCorner("br");
    this._arrow = this._makeArrow();

    // Scratch — `tick` is per-rAF; never allocate in it.
    this._vTL = new THREE.Vector3();
    this._vBR = new THREE.Vector3();
    this._vC = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();

    // Diagnostics (capture scripts read these).
    this.lastStatus = 0;       // retail ObjectSelectStatus: 0/1/2/3
    this.lastRect = null;      // {left, top, right, bottom} CSS px
    this.tickCount = 0;
  }

  /**
   * Build one corner bracket: two CSS borders on an empty div, forming an
   * "L". Retail uses four DAT bitmaps (UI element ids 0x10000039-0x1000003C
   * under the on-screen container 0x10000038, `Initialized` :290085-:290098);
   * the L-bracket is the same silhouette without the DAT dependency.
   */
  _makeCorner(which) {
    const el = this.domRoot.ownerDocument.createElement("div");
    el.className = `selection-corner selection-corner-${which}`;
    el.style.position = "absolute";
    el.style.width = `${CORNER_PX}px`;
    el.style.height = `${CORNER_PX}px`;
    el.style.pointerEvents = "none";
    el.style.display = "none";
    el.style.boxSizing = "border-box";
    const t = `${CORNER_THICKNESS_PX}px solid ${this.color}`;
    if (which === "tl") { el.style.borderTop = t; el.style.borderLeft = t; }
    if (which === "tr") { el.style.borderTop = t; el.style.borderRight = t; }
    if (which === "bl") { el.style.borderBottom = t; el.style.borderLeft = t; }
    if (which === "br") { el.style.borderBottom = t; el.style.borderRight = t; }
    this.domRoot.appendChild(el);
    return el;
  }

  /**
   * Off-screen direction arrow (retail `m_pOffScreen`, UI element 0x10000045,
   * one of 8 octant bitmaps chosen at :289826-:289878). A CSS triangle
   * rotated to the heading is the DAT-free equivalent.
   */
  _makeArrow() {
    const el = this.domRoot.ownerDocument.createElement("div");
    el.className = "selection-offscreen-arrow";
    el.style.position = "absolute";
    el.style.width = "0";
    el.style.height = "0";
    el.style.borderLeft = "8px solid transparent";
    el.style.borderRight = "8px solid transparent";
    el.style.borderBottom = `14px solid ${this.color}`;
    el.style.pointerEvents = "none";
    el.style.display = "none";
    this.domRoot.appendChild(el);
    return el;
  }

  /**
   * Retail `VividTargetIndicator::SetOnScreenColor` (:289694) — re-tint every
   * corner when the blip colour changes. No-op when unchanged.
   * @param {string} cssColor
   */
  setColor(cssColor) {
    if (!cssColor || cssColor === this.color) return;
    this.color = cssColor;
    const t = `${CORNER_THICKNESS_PX}px solid ${cssColor}`;
    this._tl.style.borderTop = t; this._tl.style.borderLeft = t;
    this._tr.style.borderTop = t; this._tr.style.borderRight = t;
    this._bl.style.borderBottom = t; this._bl.style.borderLeft = t;
    this._br.style.borderBottom = t; this._br.style.borderRight = t;
    this._arrow.style.borderBottom = `14px solid ${cssColor}`;
  }

  /**
   * Retail `SmartBox::SetTargetObjectID` — set (or clear with guid 0) the
   * tracked target. `follow` is the rig root whose world transform the
   * projection reads each frame; `sphere` is its selection sphere in three
   * world space, recomputed on selection change (retail reads the static DAT
   * field, so it never changes for a given rig either).
   *
   * @param {number} guid
   * @param {THREE.Object3D|null} follow
   * @param {{offset: THREE.Vector3, radius: number}|null} sphere
   */
  setTarget(guid, follow, sphere) {
    this._guid = guid >>> 0;
    this._follow = follow || null;
    this._sphere = sphere || null;
    if (!this._guid || !this._follow || !this._sphere) this._hideAll();
  }

  _hideAll() {
    this._tl.style.display = "none";
    this._tr.style.display = "none";
    this._bl.style.display = "none";
    this._br.style.display = "none";
    this._arrow.style.display = "none";
    this.lastStatus = 0;
    this.lastRect = null;
  }

  /**
   * Per-rAF projection. Mirrors `SmartBox::GetObjectBoundingBox` (:144083)
   * then `VividTargetIndicator::OnDraw` (:289744).
   * @param {THREE.Camera} camera — the active camera.
   */
  tick(camera) {
    this.tickCount += 1;
    if (!camera || !this._guid || !this._follow || !this._sphere) {
      this._hideAll();
      return;
    }
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;

    // The sphere centre rides the rig. `_sphere.center` was captured at
    // selection time in world space; re-anchor it to the rig's CURRENT world
    // position each frame (the offset from the rig origin is the invariant —
    // retail's sphere is stored in OBJECT space and pushed through
    // `Render::positionPush` at :144120).
    this._follow.getWorldPosition(this._vC);
    this._vC.add(this._sphere.offset || _ZERO);

    // Camera basis. Retail multiplies Render::Xaxis / Zaxis through
    // FrameCurrent (:378949) — in three.js the camera's world matrix columns
    // 0 and 1 ARE those axes.
    this._right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this._up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    const r = this._sphere.radius;
    // top_left     = center − r·X + r·Z
    // bottom_right = center + r·X − r·Z          (GetViewerBBox :378949)
    this._vTL.copy(this._vC)
      .addScaledVector(this._right, -r)
      .addScaledVector(this._up, r);
    this._vBR.copy(this._vC)
      .addScaledVector(this._right, r)
      .addScaledVector(this._up, -r);

    // Behind-camera test — retail's `viewconeCheck` (:379711) returning 0.
    this._vC.project(camera);
    if (this._vC.z > BEHIND_CAMERA_NDC_Z) {
      this._showOffScreen(this._vC, w, h);
      return;
    }
    this._vTL.project(camera);
    this._vBR.project(camera);

    const halfW = w / 2;
    const halfH = h / 2;
    let left = this._vTL.x * halfW + halfW;
    let top = -this._vTL.y * halfH + halfH;
    let right = this._vBR.x * halfW + halfW;
    let bottom = -this._vBR.y * halfH + halfH;

    // Fully outside the viewport → retail's status-2 arrow.
    if (right < 0 || left > w || bottom < 0 || top > h) {
      this._showOffScreen(this._vC, w, h);
      return;
    }

    // --- OnDraw :289789-:289816, verbatim ---------------------------------
    const cw = CORNER_PX;
    const ch = CORNER_PX;
    const maxX = w - cw - EDGE_MARGIN_PX;
    const maxY = h - ch - EDGE_MARGIN_PX;
    left -= cw;
    top -= ch;
    if (left > right) left = right - 1;
    if (top > bottom) top = bottom - 1;
    if (left < EDGE_MARGIN_PX) left = EDGE_MARGIN_PX;
    if (top < EDGE_MARGIN_PX) top = EDGE_MARGIN_PX;
    if (right < cw + EDGE_MARGIN_PX) right = cw + EDGE_MARGIN_PX;
    if (bottom < ch + EDGE_MARGIN_PX) bottom = ch + EDGE_MARGIN_PX;
    if (left > maxX - cw) left = maxX - cw;
    if (top > maxY - ch) top = maxY - ch;
    if (right > maxX) right = maxX;
    if (bottom > maxY) bottom = maxY;

    // Retail's container spans (left, top) → (left + cw + right − left,
    // top + ch + bottom − top); the four corner images sit at ITS corners.
    const boxL = left | 0;
    const boxT = top | 0;
    const boxR = (left + cw + right - left) | 0;
    const boxB = (top + ch + bottom - top) | 0;

    this._place(this._tl, boxL, boxT);
    this._place(this._tr, boxR - cw, boxT);
    this._place(this._bl, boxL, boxB - ch);
    this._place(this._br, boxR - cw, boxB - ch);
    this._arrow.style.display = "none";
    this.lastStatus = 1;
    this.lastRect = { left: boxL, top: boxT, right: boxR, bottom: boxB };
  }

  _place(el, x, y) {
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (el.style.display !== "block") el.style.display = "block";
  }

  /**
   * Retail status 2 (`OnDraw` :289826-:289928): the target is off-screen, so
   * show ONE arrow on the viewport edge pointing at it, clamped to the 8 px
   * margin. Retail derives the direction from a world-space heading; we use
   * the projected NDC direction, which is the same information post-projection
   * and is correct for the behind-camera case once mirrored.
   */
  _showOffScreen(ndc, w, h) {
    this._tl.style.display = "none";
    this._tr.style.display = "none";
    this._bl.style.display = "none";
    this._br.style.display = "none";
    let nx = ndc.x;
    let ny = ndc.y;
    // Behind the camera: the perspective divide mirrors the point.
    if (ndc.z > BEHIND_CAMERA_NDC_Z) { nx = -nx; ny = -ny; }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const halfW = w / 2;
    const halfH = h / 2;
    // Scale the unit direction out to the viewport edge, then pull in by the
    // margin (retail clamps with MathLib::Clamp(v, 8, extent − 8 − size)).
    const s = Math.min(
      Math.abs((halfW - EDGE_MARGIN_PX - 16) / (nx || 1e-6)),
      Math.abs((halfH - EDGE_MARGIN_PX - 16) / (ny || 1e-6))
    );
    const px = halfW + nx * s;
    const py = halfH - ny * s;
    // Point the triangle down the screen-space direction (it is authored
    // pointing UP, hence the +180° / atan2 ordering).
    const deg = (Math.atan2(nx, ny) * 180) / Math.PI + 180;
    this._arrow.style.transform =
      `translate3d(${px | 0}px, ${py | 0}px, 0) translate(-50%, -50%) rotate(${deg.toFixed(1)}deg)`;
    if (this._arrow.style.display !== "block") this._arrow.style.display = "block";
    this.lastStatus = 2;
    this.lastRect = null;
  }

  dispose() {
    for (const el of [this._tl, this._tr, this._bl, this._br, this._arrow]) {
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
    }
  }
}

/**
 * Convenience constructor mirroring `hud.js::createNameplateOverlay`.
 * @param {HTMLCanvasElement} canvas
 * @returns {{layer: SelectionBracketLayer, domRoot: HTMLDivElement}|null}
 */
export function createSelectionBracketOverlay(canvas) {
  if (!canvas || !canvas.parentElement) return null;
  const doc = canvas.ownerDocument;
  const div = doc.createElement("div");
  div.id = "selection-brackets-3d";
  div.style.position = "absolute";
  div.style.pointerEvents = "none";
  div.style.left = "0";
  div.style.top = "0";
  div.style.width = "100%";
  div.style.height = "100%";
  // Above the nameplate layer (z-index 10) — retail draws the target
  // indicator last, after the world and the alpha list (RenderNormalMode
  // :144918-:144930).
  div.style.zIndex = "11";
  div.style.overflow = "hidden";
  const parent = canvas.parentElement;
  if (getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }
  parent.appendChild(div);
  const layer = new SelectionBracketLayer(div, canvas);
  return { layer, domRoot: div };
}
