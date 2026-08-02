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

/**
 * FU-2 (2026-08-02): `?bracketBlipColor=off` pins the brackets to
 * `DEFAULT_COLOR` (the pre-2026-08-02 hostile red) instead of running
 * `blipColorForEntity`. DEFAULT-ON (`!== "off"`) — the mapping is a direct
 * port of `gmRadarUI::GetBlipColor` and only ever changes the tint, but it IS
 * a visible change to a default-ON system, so the escape stays.
 */
export const BRACKET_BLIP_COLOR_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search)
      .get("bracketBlipColor")?.toLowerCase() !== "off";
  } catch (_) { return true; }
})();

/** Reused zero vector for the "no offset captured" path. */
const _ZERO = new THREE.Vector3(0, 0, 0);

// ============================================================================
// FU-2 (2026-08-02) — retail blip colours for the four corners
// ============================================================================
//
// `VividTargetIndicator::SetSelected` (acclient.c:289396) tints the indicator
// with `gmRadarUI::GetBlipColor(&clr, obj)` — the call is at :289443, the
// store into `m_clrSelectedObjectColor` at :289444-:289449, and
// `SetOnScreenColor` (:289694) re-tints corner images 1..4 through
// `CopyImage` (:289470), which multiplies the grayscale corner art by the
// colour. So the corners read exactly like the radar blip.
//
// ## GetBlipColor — acclient.c:262708 (RVA 0x004D76F0)
//
// Reads `PublicWeenieDesc::_bitfield` (acclient.h:6431-6463 = ACE's
// `ObjectDescriptionFlag`) and `PublicWeenieDesc::_blipColor`
// (acclient.h:37191, wire flag `PWD_Packed_BlipColor` 0x100000):
//
//   null obj                 -> RadarDefault                       :262719
//   BF_UI_HIDDEN  (0x80)     -> RadarDefault                       :262721
//   _blipColor != 0          -> switch, SHORT-CIRCUITS everything  :262726-262773
//   BF_PORTAL     (0x40000)  -> RadarPortal   (purple)             :262776
//   BF_VENDOR     (0x200)    -> RadarVendor   (yellow)             :262782
//   BF_ATTACKABLE (0x10) && IsCreature() && !IsPlayer()
//                            -> RadarCreature (gold)               :262788
//   !IsPlayer()              -> RadarDefault  (white)              :262796
//   -- players only from here, base = RadarDefault --              :262804
//   BF_ADMIN(0x100000) && !BF_HIDDEN_ADMIN(0x40)
//                            -> RadarAdmin    (cyan)               :262833
//   else IsPK()     (0x20)   -> RadarPlayerKiller (red)            :262811
//   else IsPKLite() (0x2000000) -> RadarPKLite (pink)              :262818
//   else BF_FREE_PKSTATUS (0x200000) -> RadarCreature (gold)       :262825
//   fellowship leader/fellow -> RadarFellowship* (bright green), LAST,
//                               overrides everything above         :262842-:262856
//
// Predicate helpers: IsCreature acclient.c:436879 (= bitfield 0x10),
// IsPlayer :437199 (0x8), IsPK :437213 (0x20), IsPKLite :437205 (0x2000000).
//
// ## The palette — acclient.c:45107-45116 (base) / :777674-:777758 (semantic)
//
// The semantic globals are assigned from the base literals by CRT static
// initialisers and are never rewritten at runtime.
const BLIP_BASE = Object.freeze({
  Blue:        "#40a8ff", // 0.25, 0.66, 1.0
  Gold:        "#ffab00", // 1.0,  0.67, 0.0
  White:       "#ffffff",
  Purple:      "#bf63ff", // 0.75, 0.39, 1.0
  Red:         "#ff4063", // 1.0,  0.25, 0.39
  Pink:        "#ffa8bf", // 1.0,  0.66, 0.75
  Green:       "#008040", // 0.0,  0.5,  0.25
  Yellow:      "#ffff80", // 1.0,  1.0,  0.5
  Cyan:        "#00ffff",
  BrightGreen: "#00ff00",
});

/** Semantic radar colours, acclient.c:777674-:777758. */
export const BLIP_COLOR = Object.freeze({
  Default:          BLIP_BASE.White,       // :777674
  Admin:            BLIP_BASE.Cyan,        // :777681
  Advocate:         BLIP_BASE.Pink,        // :777688
  Creature:         BLIP_BASE.Gold,        // :777695
  LifeStone:        BLIP_BASE.Blue,        // :777702
  NPC:              BLIP_BASE.Yellow,      // :777709
  PlayerKiller:     BLIP_BASE.Red,         // :777716
  Portal:           BLIP_BASE.Purple,      // :777723
  Sentinel:         BLIP_BASE.Cyan,        // :777730
  Vendor:           BLIP_BASE.Yellow,      // :777737
  Fellowship:       BLIP_BASE.BrightGreen, // :777744
  FellowshipLeader: BLIP_BASE.BrightGreen, // :777751
  PKLite:           BLIP_BASE.Pink,        // :777758
});

// `_blipColor` switch, acclient.c:262726-262773. Index = the server-sent
// PropertyInt::RadarBlipColor. ACE's RadarColor enum (ACE.Entity/Enum/
// RadarColor.cs:3-27) matches 0..9 exactly; ACE declares BrightGreen = 0x10
// where retail's tenth case is 10, so accept BOTH (retail would render an ACE
// BrightGreen as the `default:` white).
const BLIP_COLOR_BY_INDEX = Object.freeze({
  1: BLIP_BASE.Blue,
  2: BLIP_BASE.Gold,
  3: BLIP_BASE.White,
  4: BLIP_BASE.Purple,
  5: BLIP_BASE.Red,
  6: BLIP_BASE.Pink,
  7: BLIP_BASE.Green,
  8: BLIP_BASE.Yellow,
  9: BLIP_BASE.Cyan,
  10: BLIP_BASE.BrightGreen,
  16: BLIP_BASE.BrightGreen, // ACE's RadarColor.BrightGreen
});

// ObjectDescriptionFlag bits (acclient.h:6431-6463 / ACE ObjectDescriptionFlag.cs).
const BF_PLAYER = 0x00000008;
const BF_ATTACKABLE = 0x00000010;
const BF_PLAYER_KILLER = 0x00000020;
const BF_HIDDEN_ADMIN = 0x00000040;
const BF_UI_HIDDEN = 0x00000080;
const BF_VENDOR = 0x00000200;
const BF_PORTAL = 0x00040000;
const BF_ADMIN = 0x00100000;
const BF_FREE_PKSTATUS = 0x00200000;
const BF_PKLITE_PKSTATUS = 0x02000000;

/**
 * Port of `gmRadarUI::GetBlipColor` (acclient.c:262708) over the data an
 * entity instance already carries. `meta.objDescFlags` is the wire
 * `PublicWeenieDescription.obj_desc_flags` (loop.js toMeta :2408 /
 * entity_update_clone.js:114).
 *
 * Two faithful gaps, both benign (they fall through to the flag branch, which
 * is exactly what retail does when `_blipColor == 0`):
 *  - `_blipColor` — parsed by the protocol crate as
 *    `PublicWeenieDescription.radar_blip_color` and hydrated to
 *    `PropertyInt::RadarBlipColor` (holtburger-world/src/hydration.rs:143),
 *    but not surfaced on the entity meta by the wasm bundle. Honoured here
 *    when a caller can supply it (`meta.radarBlipColor`), so wiring it later
 *    is a one-field change. Without it, lifestones/NPCs read Default white.
 *  - fellowship — the leader/fellow override (:262842) needs the fellowship
 *    roster; skipped.
 *
 * @param {{meta?: object}|null} inst — an EntityManager entity record.
 * @returns {string} a CSS colour; `BLIP_COLOR.Default` when unclassifiable.
 */
export function blipColorForEntity(inst) {
  const meta = inst?.meta;
  if (!meta) return BLIP_COLOR.Default;
  const bits = (meta.objDescFlags ?? 0) >>> 0;
  // :262721 — UI-hidden objects get the default colour (retail suppresses the
  // blip via GetBlipShape returning 0, not via the colour).
  if (bits & BF_UI_HIDDEN) return BLIP_COLOR.Default;
  // :262726 — the server-sent blip colour short-circuits EVERYTHING.
  const idx = (meta.radarBlipColor ?? 0) >>> 0;
  if (idx !== 0) return BLIP_COLOR_BY_INDEX[idx] || BLIP_COLOR.Default;
  if (bits & BF_PORTAL) return BLIP_COLOR.Portal;                  // :262776
  if (bits & BF_VENDOR) return BLIP_COLOR.Vendor;                  // :262782
  const isPlayer = (bits & BF_PLAYER) !== 0;                       // IsPlayer :437199
  // :262788 — IsCreature() is itself `bitfield & 0x10` (:436879), so the
  // retail predicate `BF_ATTACKABLE && IsCreature() && !IsPlayer()` collapses
  // to "attackable and not a player".
  if ((bits & BF_ATTACKABLE) && !isPlayer) return BLIP_COLOR.Creature;
  if (!isPlayer) return BLIP_COLOR.Default;                        // :262796
  // --- players only, base = Default (:262804) ---
  if ((bits & BF_ADMIN) && !(bits & BF_HIDDEN_ADMIN)) return BLIP_COLOR.Admin; // :262833
  if (bits & BF_PLAYER_KILLER) return BLIP_COLOR.PlayerKiller;     // IsPK :262811
  if (bits & BF_PKLITE_PKSTATUS) return BLIP_COLOR.PKLite;         // IsPKLite :262818
  if (bits & BF_FREE_PKSTATUS) return BLIP_COLOR.Creature;         // :262825
  return BLIP_COLOR.Default;
}

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

// ============================================================================
// FU-2 (2026-08-02) — the REAL selection sphere, from the DAT
// ============================================================================
//
// Retail's bracket bounds are `CSetup.selection_sphere`, scaled by the part
// array's scale (`CPartArray::GetSelectionSphere`, acclient.c:326293):
//
//     center.{x,y,z} = scale.{x,y,z} * setup.selection_sphere.center.{x,y,z}
//     radius         = scale.z       * setup.selection_sphere.radius
//
// (the radius really does scale by z alone — retail's own asymmetry). The
// sphere lives in OBJECT space and is pushed to world by
// `Render::positionPush(3, &obj->m_position)` at :144120, so in three terms it
// is a rig-LOCAL offset resolved through `root.localToWorld` — and because
// `worldRoot.rotation.x = -PI/2` (scene3d/index.js:1324) carries the whole
// AC→three axis change, everything under an entity rig is already AC-native.
// The DAT center therefore needs no swizzle, and `localToWorld` applies both
// the rig heading and `root.scale` (the wire `obj_scale`) for free.
//
// `fetchSetupSelectionSphere(setupId)` (src/lib.rs) is async, so selection
// takes the heuristic immediately and upgrades in place when the DAT lands.
// The cache is keyed by setup id — the field is static per setup, exactly as
// retail's `CSetup::selection_sphere` is.
//
// Retail's own fallback when `GetSelectionSphere` returns 0 is a hardcoded
// tiny sphere, center (0, 0, 0.1) radius 0.1 (acclient.c:144129-144132, the
// four `0x3DCCCCCD` = 0.1f stores). That is a degenerate placeholder, not a
// usable bound, so we keep the Box3 heuristic for that case instead.

/** @type {Map<number, {cx:number,cy:number,cz:number,radius:number}|null>} */
const _datSphereCache = new Map();
/** @type {Map<number, Promise<any>>} */
const _datSphereInflight = new Map();

/**
 * Which path fed the currently-drawn brackets. Read by headless probes as
 * `window.__diag.selectionSphere` (installed by the layer constructor).
 */
export const selectionSphereStats = {
  dat: 0,        // selections bracketed by the DAT sphere
  heuristic: 0,  // selections bracketed by the Box3 fallback
  upgrades: 0,   // heuristic → DAT swaps that landed after the async fetch
  fetches: 0,    // wasm calls issued
  noSphere: 0,   // setups whose DAT sphere was absent/degenerate
  lastPath: "",  // "dat" | "heuristic"
};

/** The RAW cached DAT sphere for a setup, or null/undefined if unknown. */
export function peekDatSelectionSphere(setupId) {
  return _datSphereCache.get(setupId >>> 0);
}

/**
 * Kick (or join) the async DAT fetch for one setup id. Resolves to the cached
 * record (possibly `null` when the setup has no usable sphere).
 * @param {Function} fetchFn — `wasmExports.fetchSetupSelectionSphere`
 * @param {number} setupId
 */
export function loadDatSelectionSphere(fetchFn, setupId) {
  const id = setupId >>> 0;
  if (_datSphereCache.has(id)) return Promise.resolve(_datSphereCache.get(id));
  if (_datSphereInflight.has(id)) return _datSphereInflight.get(id);
  if (typeof fetchFn !== "function" || (id >>> 24) !== 0x02) {
    _datSphereCache.set(id, null);
    return Promise.resolve(null);
  }
  selectionSphereStats.fetches++;
  const p = Promise.resolve()
    .then(() => fetchFn(id))
    .then((res) => {
      let rec = null;
      try {
        if (res && res.valid && Number.isFinite(res.radius) && res.radius > 0) {
          rec = { cx: res.cx, cy: res.cy, cz: res.cz, radius: res.radius };
        }
      } catch (_) { rec = null; }
      if (rec === null) selectionSphereStats.noSphere++;
      _datSphereCache.set(id, rec);
      _datSphereInflight.delete(id);
      return rec;
    })
    .catch(() => {
      _datSphereCache.set(id, null);
      _datSphereInflight.delete(id);
      selectionSphereStats.noSphere++;
      return null;
    });
  _datSphereInflight.set(id, p);
  return p;
}

/**
 * Turn a cached DAT record into the layer's sphere shape. `local: true` tells
 * `tick` to resolve the offset through `root.localToWorld` (which applies the
 * rig heading + `root.scale`), and the radius is scaled by `root.scale.z` to
 * match `CPartArray::GetSelectionSphere` exactly.
 * @param {{cx:number,cy:number,cz:number,radius:number}|null} rec
 * @param {THREE.Object3D} root
 * @returns {{offset: THREE.Vector3, radius: number, local: boolean}|null}
 */
export function datSelectionSphereFor(rec, root) {
  if (!rec || !root) return null;
  const sz = Math.abs(root.scale?.z ?? 1) || 1;
  const r = rec.radius * sz;
  if (!Number.isFinite(r) || r <= 0) return null;
  return {
    offset: new THREE.Vector3(rec.cx, rec.cy, rec.cz),
    radius: r,
    local: true,
  };
}

/**
 * Box3-over-rig FALLBACK for setups with no usable `CSetup.selection_sphere`
 * (raw `0x01` GfxObj ids, parse failures, degenerate radii). Retail's own
 * fallback is a 0.1-radius placeholder, which brackets nothing useful.
 *
 * Returned as a WORLD-space OFFSET from the rig root's world position (plus a
 * radius) so `tick` can re-anchor it to the rig's live world position every
 * frame without recomputing the box.
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
    // FU-2: `?bracketBlipColor=off` freezes the legacy hostile red.
    if (!BRACKET_BLIP_COLOR_ON) return;
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
    // FU-2 (2026-08-02): a DAT sphere (`local: true`) is an OBJECT-space
    // centre — push it through the rig's world matrix so the heading and
    // `root.scale` apply, matching retail's `Render::positionPush(3,
    // &obj->m_position)` at :144120 over the already-scaled
    // `CPartArray::GetSelectionSphere` centre. The Box3 heuristic's offset is
    // world-space and just rides the root position.
    if (this._sphere.local) {
      this._vC.copy(this._sphere.offset || _ZERO);
      this._follow.updateWorldMatrix(true, false);
      this._vC.applyMatrix4(this._follow.matrixWorld);
    } else {
      this._follow.getWorldPosition(this._vC);
      this._vC.add(this._sphere.offset || _ZERO);
    }

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
  // FU-2 (2026-08-02): headless probe surface — which bounds path fired and
  // what colour the corners are wearing.
  try {
    window.__diag = window.__diag || {};
    window.__diag.selectionSphere = selectionSphereStats;
    window.__diag.selectionBrackets = {
      stats: selectionSphereStats,
      blipColorOn: BRACKET_BLIP_COLOR_ON,
      color: () => layer.color,
      rect: () => layer.lastRect,
      status: () => layer.lastStatus,
      radius: () => layer._sphere?.radius ?? null,
      fromDat: () => !!layer._sphere?.local,
    };
  } catch (_) {}
  return { layer, domRoot: div };
}
