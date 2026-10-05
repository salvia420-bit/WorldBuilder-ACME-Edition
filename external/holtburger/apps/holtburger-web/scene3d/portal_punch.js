// scene3d/portal_punch.js — retail-faithful per-aperture DEPTH PUNCH.
//
// The minimal WebGL realization of retail acclient's
// `D3DPolyRender::DrawPortalPolyInternal` (verified in the decomp): draw each
// visible door/window portal polygon with DEPTHTEST_ALWAYS and write
// gl_FragDepth = 0.99999899 (≈ far plane) into every aperture pixel, so the
// building interior — drawn AFTER, in the cells pass — wins the depth test
// inside the doorway and terrain/facade can no longer occlude it there.
//
// This is the "bounded punch, no stencil" approach (chosen 2026-07-05 over the
// stencil scaffold in portal_stencil.js): retail itself uses a screen-space
// polygon clip, NOT hardware stencil, and the building FACADE's own depth
// naturally masks the interior OUTSIDE the aperture (facade is in front from an
// outdoor camera → interior loses there → hidden), so we don't need an explicit
// clip for a first pass. The one accepted tradeoff vs. a true clip: interior
// geometry that projects BEYOND the facade silhouette (over open terrain / sky)
// can "see-through". That is the follow-up (add a clip) IF it's visibly a
// problem — judged on the real GPU, since SwiftShader can't render this.
//
// Pipeline role (atmosphere_pipeline.js, only when ?portalPunch=on AND outdoor
// AND there are visible apertures):
//   1. world pass  → WORLD_ONLY  (terrain + facade + outdoor statics)
//   2. THIS pass   → punch depth to FAR inside each visible aperture
//   3. cells pass  → INDOOR_ONLY (interior cells + entities), depth unchanged,
//                    so they win in the punched apertures, lose behind facade.
// Interior cells stay on RENDER_LAYER_INDOOR (layer 1) the whole time — unlike
// the stencil scaffold, this pass does NOT re-layer them.
//
// 2026-08-13 — that "one accepted tradeoff" turned out to have a second, worse
// face: not just interior geometry overhanging the facade silhouette, but whole
// doorways on the FAR side of an intervening wall being punched and drawn
// through it. See the OCCLUSION GATE block below for the fix and its decomp
// justification; the gate is armed by atmosphere_pipeline.js whenever the
// composer really carries a stencil attachment.
//
// Gated by `?portalPunch` (DEFAULT-ON since 2026-08-04).

import * as THREE from "three";
import { Pass } from "postprocessing";
import { withLogDepthVertex, withLogDepthFragment } from "./shader_logdepth.js";

// `?sealLogDepth` (DEFAULT ON since 2026-10-05 round 2; `?sealLogDepth=off`
// escape) — log-depth encoding for the SEAL material (see makeSealMaterial),
// three r184's logdepthbuf chunks via shader_logdepth.js. A CORRECT seal makes
// the doorway depth wall live for the first time, so it ships together with
// the two retail-order fixes it depends on:
//   1. OUTDOOR REMAINDER BEFORE THE WIPE. Retail PView::DrawCells
//      (acclient.c:461450-461560) draws ALL outdoor content (LScape::draw),
//      depth-tested together, BEFORE Clear(4) and the stamp. cells.js relayers
//      the player landblock's buildings + statics onto layer 1 so terrain
//      cannot occlude the room after the wipe; that content, plus outdoor
//      entities, is drawn by SealRemainderPass right after the world pass and
//      BEFORE the wipe (round 3: round 2 drew it after the wipe, against no
//      depth), narrowed to the doorway rect, so a tree or a neighbour house
//      seen out of the doorway keeps its colour and its terrain occlusion.
//   2. REACHED CELLS ONLY. cells.js feeds the seal from the PView walk's
//      outside view (wasm getPViewOutsidePortals), not from every
//      frustum-visible EnvCell.
//   3. DEPTH RESTORE. SealDepthSavePass / SealDepthRestorePass put the
//      pre-wipe depth back under the sealed pixels after the cells pass, so the
//      depth-reading post effects see the terrain's real distance through a
//      doorway instead of the wall.
// `=off` restores the old perspective seal and skips all three, i.e. the
// pre-2026-10-05 indoor frame exactly.
export function sealLogDepthEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search || "").get("sealLogDepth") !== "off";
  } catch (_) {
    return true;
  }
}

// Layer bits, mirrored from index.js (RENDER_LAYER_WORLD = 0, _INDOOR = 1).
const LAYER_INDOOR_BIT = 1 << 1;

/**
 * Which children to HIDE so that one render with the camera on the INDOOR layer
 * draws exactly the "outdoor remainder" — the outdoor content that the armed
 * indoor split moved past the depth wipe:
 *   - buildingsGroup / staticsGroup children cells.js relayered
 *     (`userData.__splitLayer === 1`: the player landblock's building shells
 *     and outdoor statics). Their OTHER layer-1 children are interior-anchored
 *     particles (statics.js stamps them at emission) and are hidden.
 *   - entitiesGroup children flagged `userData.__splitOutdoor === true` by
 *     cells.js (entities standing in an outdoor landcell). Everything else in
 *     entitiesGroup is hidden.
 *   - every other worldRoot child (cellsGroup = the EnvCells, decoration
 *     groups) is hidden.
 * Only currently-visible nodes are returned, so restoring them is exact.
 * Pure (no GL) — the node test drives it directly.
 *
 * @param {{worldRoot, buildingsGroup, staticsGroup, entitiesGroup}} rem
 * @param {object[]} [out] reused scratch array
 * @returns {object[]}
 */
export function collectOutdoorRemainderHidden(rem, out = []) {
  out.length = 0;
  if (!rem || !rem.worldRoot) return out;
  const { worldRoot, buildingsGroup, staticsGroup, entitiesGroup } = rem;
  for (const c of worldRoot.children) {
    if (!c.visible) continue;
    if (c === buildingsGroup || c === staticsGroup || c === entitiesGroup) continue;
    out.push(c);
  }
  for (const g of [buildingsGroup, staticsGroup]) {
    if (!g || !Array.isArray(g.children)) continue;
    for (const c of g.children) {
      if (!c.visible) continue;
      if (c.userData && c.userData.__splitLayer === 1) continue;
      // Only layer-1 nodes could draw under the INDOOR mask; leave the rest.
      if ((c.layers.mask & LAYER_INDOOR_BIT) === 0) continue;
      out.push(c);
    }
  }
  if (entitiesGroup && Array.isArray(entitiesGroup.children)) {
    for (const c of entitiesGroup.children) {
      if (!c.visible) continue;
      if (c.userData && c.userData.__splitOutdoor === true) continue;
      out.push(c);
    }
  }
  return out;
}

// Retail's DrawPortalPolyInternal writes 0.99999899 (just shy of the far plane).
// Under logarithmicDepthBuffer the encoding is log2(1 + w) / log2(1 + far), so
// far maps to exactly 1 and the near plane maps to log2(1 + near) / log2(1 +
// far) — about 0.011 for this renderer (near 0.1, far 5000), not 0. The literal
// is therefore still a valid "far" written straight to gl_FragDepth: any real
// geometry has a smaller gl_FragDepth and wins.

const FAR_DEPTH = 0.99999899;

// Single stencil ref for the occlusion gate (same value portal_stencil.js used).
const STENCIL_REF = 1;

// OCCLUSION GATE (2026-08-13) — the missing half of the punch.
//
// Retail never punches an unreachable portal. `PView::ConstructView`
// (acclient.c:462423-462462) seeds `cell_todo_list` from the cell the camera
// is IN and only ever grows it through `PView::ClipPortals` (:462461), so a
// portal is reached solely by a chain of NON-EMPTY clipped apertures from the
// viewpoint; and each building's punch + interior are drawn inside that
// building's own back-to-front `InsCellTodoList`/`DrawCells` pass
// (:461917-461925, :461567), so a nearer wall drawn afterwards overwrites any
// leak.
//
// We have neither property: `visible_portal_apertures_flat`
// (src/lib.rs) takes EVERY outdoor-facing portal of EVERY frustum-visible
// EnvCell across ALL loaded landblocks — no reachability, and no occluder
// beyond a terrain-heightfield LOS march that by construction ignores
// buildings — and we run ONE punch pass for all of them AFTER the whole world
// pass. With `depthFunc = Always` that punch writes far-Z into apertures that
// are demonstrably behind a wall, and the cells pass then fills them: portals
// visible THROUGH walls.
//
// The screen-space equivalent of retail's reachability, given that the world
// pass has already laid down every opaque outdoor occluder's depth, is: punch
// only where the aperture polygon itself passes the depth test. That is a
// per-pixel test, so it cannot be expressed by the punch material alone — the
// punch WRITES gl_FragDepth, and a written gl_FragDepth is also the value the
// depth test compares, so flipping `depthFunc` to LessEqual would compare FAR
// against the buffer and reject everywhere.
//
// So it is two draws of the same mesh, the technique proven in the retired
// portal_stencil.js (whose MARK/RESET pair was always correct; what retired it
// was its cell RE-LAYERING half, which this pass does not do):
//
//   (a) MARK  — depth-TESTED, depth-write OFF, colour OFF; stencil REPLACE on
//               Z-PASS only. Marks exactly the aperture pixels that are not
//               occluded by world-pass geometry. An aperture behind a wall
//               fails the depth test → stencilZFail → KEEP → never marked.
//   (b) PUNCH — the existing DEPTHTEST_ALWAYS far-Z stamp, now confined by
//               stencil EQUAL REF (test only, writeMask 0).
//
// Net effect: identical to today inside genuinely visible doorways (the mark
// passes, the punch runs unchanged), and a no-op for doorways a wall covers.
// It can only ever punch a SUBSET of what it punches today, so it cannot make
// a visible interior disappear — only an occluded one, which is the bug.
//
// WHY THIS DOES NOT CONTRADICT `DEPTHTEST_ALWAYS`. docs/url-flags.md's
// `portalPunch` row states the punch is "deliberately NOT depth-tested against
// the world pass … testing the aperture against that same buffer would reject
// exactly the apertures that need punching", the case being a SUNKEN interior
// that terrain wrongly wins depth over. That objection is about TERRAIN, and it
// does not reach this gate, for two independent reasons:
//
//   * Terrain-occluded apertures never get here. `clipAperturesForPunch`
//     (portal_clip.js) already runs a camera→aperture terrain line-of-sight
//     cull and drops them upstream — that is the `dropped.terrain` counter on
//     `_portalPunchDiag`. So the only occluders this depth test can NEWLY
//     reject are the ones that are not terrain: walls, facades and statics —
//     precisely the occluder class our aperture selection has never had, and
//     precisely the class producing the reported artifact.
//   * The gate tests the APERTURE POLYGON, which lies in the facade at the
//     doorway, not the interior geometry behind it. Terrain winning depth over
//     a sunken ROOM does not imply it wins over the DOORWAY, and where it does
//     the doorway is genuinely not visible.
//
// Retail can skip the test only because it has the stronger property instead:
// `PView::DrawCells` wipes Z outright (`Clear(4, …, 1.0)`, acclient.c:461484)
// before stamping the portal planes, so at stamp time there is no terrain depth
// left to lose to — and it can afford that wipe because reachability has
// already guaranteed the portal is visible. We have the wipe's opposite (one
// shared depth buffer, whole world already in it) and none of the
// reachability, so the buffer is the only occlusion evidence available to us.
// EYE-TEST OBLIGATION: a sunken/half-buried interior must still render. That is
// the failure mode this gate would announce, and it is a positive item on the
// 1070 shot list, not an assumption.
//
// Requires a stencil attachment on the composer's ping-pong buffers
// (atmosphere_pipeline.js allocates one when `portalPunch` is on). If it is
// absent the gate is DISABLED and the pass falls back to the legacy
// unconditional punch — never to "mark nothing, punch nothing", which would
// present as the 2026-08-12 "interiors vanish" regression.
function makeMarkMaterial() {
  // MeshBasicMaterial (not a bespoke ShaderMaterial) so three injects its
  // logdepthbuf chunk when the renderer runs logarithmicDepthBuffer — the
  // mark's gl_FragDepth must be encoded the same way terrain's is or the
  // comparison is meaningless.
  const m = new THREE.MeshBasicMaterial();
  m.name = "portal-punch-mark";
  m.colorWrite = false;
  m.depthWrite = false; // never perturb depth; this draw only marks stencil
  m.depthTest = true;
  m.depthFunc = THREE.LessEqualDepth; // occluded doorway → Z-fail → no mark
  m.side = THREE.DoubleSide;
  m.stencilWrite = true;
  m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilRef = STENCIL_REF;
  m.stencilFuncMask = 0xff;
  m.stencilWriteMask = 0xff;
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp; // DEPTH fail (occluded) → do NOT mark
  m.stencilZPass = THREE.ReplaceStencilOp; // visible → mark
  return m;
}

// PUNCH material — reset depth to FAR inside the aperture. depthFunc=Always so it
// writes unconditionally (retail DEPTHTEST_ALWAYS); depthTest stays ENABLED
// because WebGL does not write depth when the test is disabled. colorWrite off
// (never touch the world pass's colour — the cells pass fills the doorway).
// DoubleSide: the doorway is viewed from either face. No stencil.
// SEAL material (2026-08-04 round 6) — retail `DrawPortalPolyInternal(p,
// zClear=FALSE)`, acclient.c:461536 as called from the INDOOR `PView::DrawCells`
// loop. Writes the polygon's TRUE interpolated depth rather than far Z: it is a
// depth WALL at the doorway plane, not a hole.
//
// Why the indoor split needs it. `PView::DrawCells` wipes Z (:461484) and then
// re-stamps every outdoor-facing portal plane at true depth BEFORE drawing the
// cells (:461536). Without that re-stamp, the wipe leaves the world pass's
// colour — terrain AND the outdoor particles drawn with it — protected by no
// depth at all, so ANY interior geometry drawn afterwards overpaints it even
// when it is genuinely FARTHER away than what is visible through the doorway.
// That is the reported "doorway filled with outdoor fountain blobs / interior
// particles gone" ordering: both are layer-0 world-pass content whose depth the
// wipe destroyed. The seal restores exactly the depth retail restores.
//
// LOG-DEPTH (2026-10-05, `?sealLogDepth`, DEFAULT ON since round 2, `=off` escape): the
// renderer runs `logarithmicDepthBuffer`, so every built-in material writes a
// LOG gl_FragDepth, while a seal without the chunk writes PERSPECTIVE
// gl_FragCoord.z — a different encoding, so the "true depth" wall it stamps is
// at the wrong depth for everything that later tests against it (interior
// cells, interior particles). Armed, the seal writes the same log encoding via
// shader_logdepth.js: vFragDepth = 1 + clip.w in the vertex stage and
// gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5 in the fragment stage,
// guarded on USE_LOGARITHMIC_DEPTH_BUFFER (three defines it for every non-raw
// ShaderMaterial and uploads logDepthBufFC for every program). Still a depth
// WALL at the doorway's true depth — just in the buffer's own encoding.
function makeSealMaterial(logDepth = sealLogDepthEnabled()) {
  const vertexShader = /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`;
  // Flag OFF (escape): NO gl_FragDepth write — the rasterizer's interpolated
  // PERSPECTIVE depth, i.e. the pre-2026-10-05 seal (wrong space vs the log
  // buffer). Armed: the helper prepends the log gl_FragDepth write.
  const fragmentShader = /* glsl */ `
      precision highp float;
      out vec4 _c;
      void main() {
        _c = vec4(0.0);
      }`;
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: logDepth ? withLogDepthVertex(vertexShader) : vertexShader,
    fragmentShader: logDepth ? withLogDepthFragment(fragmentShader) : fragmentShader,
  });
  m.name = "portal-seal";
  m.colorWrite = false;
  m.depthTest = true;
  m.depthFunc = THREE.AlwaysDepth; // retail DEPTHTEST_ALWAYS
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  return m;
}

function makePunchMaterial(stencilGate = false) {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      out vec4 _c;
      void main() {
        gl_FragDepth = ${FAR_DEPTH.toFixed(8)};
        _c = vec4(0.0);
      }`,
  });
  m.name = "portal-punch";
  m.colorWrite = false;
  m.depthTest = true;
  m.depthFunc = THREE.AlwaysDepth; // write regardless of what's already there
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  if (stencilGate) {
    // Confine the far-Z stamp to the pixels the MARK draw proved visible.
    // Test only — writeMask 0 so the punch never edits the mark it reads.
    m.stencilWrite = true;
    m.stencilFunc = THREE.EqualStencilFunc;
    m.stencilRef = STENCIL_REF;
    m.stencilFuncMask = 0xff;
    m.stencilWriteMask = 0x00;
    m.stencilFail = THREE.KeepStencilOp;
    m.stencilZFail = THREE.KeepStencilOp;
    m.stencilZPass = THREE.KeepStencilOp;
  }
  return m;
}

export class PortalPunchPass extends Pass {
  /**
   * @param {THREE.Scene} _scene  unused (interiors are drawn by the cells pass)
   * @param {THREE.Camera} camera the main render camera
   */
  constructor(_scene, camera, mode = "punch", opts = {}) {
    super(mode === "seal" ? "PortalSealPass" : "PortalPunchPass");
    this.mode = mode;
    // Occlusion gate (see makeMarkMaterial). PUNCH mode only: the SEAL pass
    // runs inside `PView::DrawCells`' own indoor sequence (acclient.c:461536)
    // where the Z-wipe has just destroyed the depth it would test against, so
    // gating it would be both meaningless and wrong.
    // Caller must pass `stencil: true` ONLY when the composer really allocated
    // a stencil attachment — with the gate armed against a missing buffer the
    // MARK draw writes nowhere, the punch's EQUAL test fails everywhere, and
    // every interior disappears. Default false = legacy unconditional punch.
    this._stencilGate = mode !== "seal" && opts.stencil === true;
    // We render the aperture mesh into the composer's input buffer ourselves and
    // do not consume/produce a full-screen quad → keep buffers across the pass.
    this.needsSwap = false;
    // Store on `this.camera` (the real pmndrs Pass field), NOT `this.mainCamera`
    // — the base Pass in this postprocessing version exposes `set mainCamera`
    // as an EMPTY no-op with no getter, so assigning `this.mainCamera` silently
    // drops the camera and `render()` would read `undefined` and bail forever
    // (the reason this punch never executed / shipped UNVALIDATED).
    this.camera = camera;

    // Aperture geometry lives in its own tiny scene, rotated to match worldRoot
    // (AC Z-up → three Y-up is the -pi/2 X rotation applied in index.js).
    this.apertureScene = new THREE.Scene();
    this.apertureGroup = new THREE.Group();
    this.apertureGroup.rotation.x = -Math.PI / 2;
    this.apertureScene.add(this.apertureGroup);

    // SEAL only: whether the stamp is a live (log-depth) wall, and the
    // outdoor-remainder pre-draw that must precede it (see render()). Both are
    // decided once at construction from `?sealLogDepth`.
    this._sealLogDepth = mode === "seal" && (opts.logDepth ?? sealLogDepthEnabled());
    this._punchMat =
      mode === "seal" ? makeSealMaterial(this._sealLogDepth) : makePunchMaterial(this._stencilGate);
    // `{ scene, worldRoot, buildingsGroup, staticsGroup, entitiesGroup }`, set
    // per tick by cells.js `tickPortalSeal`. null = no pre-draw.
    this.outdoorRemainder = null;
    // Union screen rect of the sealed doorways ([0,1], y up) — the pre-draw's
    // PortalList clip. null = full frame.
    this.remainderRect = null;
    this._remainderHidden = [];
    this.remainderDraws = 0; // diag: frames the pre-draw ran
    this.remainderNarrowed = 0; // diag: …of which narrowed to the doorway rect
    this.depthRestores = 0; // diag: frames the depth restore ran
    this._depthSaved = false;
    this._savedDepthRT = null;
    this._curDepthRT = null;
    this._restoreMat = null;
    this._markMat = this._stencilGate ? makeMarkMaterial() : null;
    // PERSISTENT aperture mesh (2026-08-04 perf). `setApertures` runs EVERY
    // frame the punch is armed; the original implementation disposed the
    // BufferGeometry and built a fresh one + a fresh THREE.Mesh each call,
    // which on a real driver is a VBO delete + VBO create + full upload per
    // frame (SwiftShader hides this — it has no driver allocator to thrash).
    // Now the geometry, its Float32Array and the Mesh are allocated ONCE and
    // grown by doubling; a frame update is a memcpy into the existing array,
    // one `needsUpdate` (bufferSubData) and a `setDrawRange`.
    this._apertureMesh = null;   // created lazily by _ensureApertureBuffer
    this._posAttr = null;        // its position BufferAttribute
    this._positions = null;      // the attribute's backing Float32Array
    this._posCapacity = 0;       // capacity in VERTICES (not floats)
    this._apertureCount = 0;
    // 2026-08-04 over-punch containment: the union screen rect of the
    // apertures that survived scene3d/portal_clip.js `clipAperturesForPunch`,
    // in the GL convention ([0,1], y up). `null` = no bound (legacy call
    // shape; the punch then covers the whole target as it always did).
    // Applied as a RENDER-TARGET scissor in `render()`, so even a polygon
    // that somehow rasterizes wrong is physically incapable of writing depth
    // outside the doorway rects — the structural fix for the 2026-07-06
    // whole-world blackout.
    this._scissorRect = null;
    // Permanent no-op after any render throw (driver-specific GL failure) so a
    // bug here can never freeze the frame — interiors just fall back to the
    // default (occluded) world-pass draw, and preFrameSkySync stops splitting.
    this._errored = false;
  }

  /** True when the retail-reachability occlusion gate is armed (diag). */
  get occlusionGated() {
    return this._stencilGate === true;
  }

  get hasApertures() {
    return !this._errored && this._apertureCount > 0 && this._apertureMesh != null;
  }

  /**
   * Rebuild the aperture geometry from the flat float array wasm
   * `getVisiblePortalApertures` returns:
   *   [ count, (nverts, x0,y0,z0, …) × count ]   (AC world coords, Z-up)
   * Convex polygons are fan-triangulated into one merged BufferGeometry.
   *
   * @param {ArrayLike<number>|null} flat
   * @param {{x0:number,y0:number,x1:number,y1:number}|null} [rect]
   *        Union screen-space bound of these apertures (GL convention: [0,1],
   *        y up), from `clipAperturesForPunch`. Omitted/null → unbounded.
   */
  setApertures(flat, rect = null) {
    this._apertureCount = 0;
    if (this._apertureMesh) this._apertureMesh.visible = false;
    this._scissorRect =
      rect &&
      Number.isFinite(rect.x0) && Number.isFinite(rect.y0) &&
      Number.isFinite(rect.x1) && Number.isFinite(rect.y1) &&
      rect.x1 > rect.x0 && rect.y1 > rect.y0
        ? rect
        : null;
    if (!flat || flat.length < 1) return;

    let k = 0;
    const count = flat[k++] | 0;
    if (count <= 0) return;

    // PASS 1 — vertex budget. Fan triangulation of an nv-gon emits (nv-2)*3
    // vertices. `flat` is a few hundred floats, so the extra walk is free
    // next to the allocation it removes.
    let need = 0;
    let scan = k;
    for (let a = 0; a < count && scan < flat.length; a++) {
      const nv = flat[scan++] | 0;
      if (nv >= 3) need += (nv - 2) * 3;
      scan += nv * 3;
    }
    if (need <= 0) return;
    this._ensureApertureBuffer(need);
    const pos = this._positions;
    if (!pos) return;

    // PASS 2 — write straight into the persistent buffer.
    let w = 0;
    for (let a = 0; a < count; a++) {
      const nv = flat[k++] | 0;
      if (nv < 3) {
        k += nv * 3;
        continue;
      }
      const base = k;
      for (let t = 1; t < nv - 1; t++) {
        const i0 = base;
        const i1 = base + t * 3;
        const i2 = base + (t + 1) * 3;
        pos[w++] = flat[i0]; pos[w++] = flat[i0 + 1]; pos[w++] = flat[i0 + 2];
        pos[w++] = flat[i1]; pos[w++] = flat[i1 + 1]; pos[w++] = flat[i1 + 2];
        pos[w++] = flat[i2]; pos[w++] = flat[i2 + 1]; pos[w++] = flat[i2 + 2];
      }
      k += nv * 3;
      this._apertureCount++;
    }

    if (w === 0) {
      this._apertureCount = 0;
      return;
    }
    const attr = this._posAttr;
    // Sub-upload only the bytes actually written (mirrors portal_stencil.js).
    if (attr.addUpdateRange) attr.addUpdateRange(0, w);
    else attr.updateRange = { offset: 0, count: w };
    attr.needsUpdate = true;
    this._apertureMesh.geometry.setDrawRange(0, (w / 3) | 0);
    this._apertureMesh.visible = true;
  }

  /**
   * Allocate (or grow, by doubling) the persistent aperture buffer so it holds
   * at least `vertCount` vertices. Growth is rare — the aperture count in view
   * is bounded by the loaded portal set and settles after the first few
   * landblocks — so the dispose here is not a per-frame cost.
   *
   * @param {number} vertCount vertices required this frame
   */
  _ensureApertureBuffer(vertCount) {
    if (this._apertureMesh && this._posCapacity >= vertCount) return;
    let cap = this._posCapacity > 0 ? this._posCapacity : 192;
    while (cap < vertCount) cap *= 2;
    this._disposeApertureMesh();
    const positions = new Float32Array(cap * 3);
    const attr = new THREE.BufferAttribute(positions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", attr);
    geom.setDrawRange(0, 0);
    // `frustumCulled = false` (retail punches whatever the walk offers), which
    // also means three never asks for a bounding sphere — so the stale bounds
    // of a partially-filled buffer can never cull the mesh.
    const mesh = new THREE.Mesh(geom, this._punchMat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; // fixed at identity under apertureGroup
    mesh.visible = false;
    // Never a pick/ray target (?punchRetail puts this mesh in the main scene).
    mesh.raycast = () => {};
    this._positions = positions;
    this._posAttr = attr;
    this._posCapacity = cap;
    this._apertureMesh = mesh;
    this.apertureGroup.add(mesh);
  }

  _disposeApertureMesh() {
    if (this._apertureMesh) {
      this.apertureGroup.remove(this._apertureMesh);
      this._apertureMesh.geometry?.dispose();
      this._apertureMesh = null;
    }
    this._posAttr = null;
    this._positions = null;
    this._posCapacity = 0;
  }

  render(renderer, inputBuffer /*, outputBuffer, dt, maskActive */) {
    if (this._errored || !this.hasApertures) return;
    const cam = this.camera;
    if (!cam || !cam.layers) return; // camera not wired yet → skip, never crash

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    // Render-target scissor bound (2026-08-04). three.js reads viewport/scissor
    // OFF THE RENDER TARGET when one is bound (WebGLRenderer.setRenderTarget
    // copies `renderTarget.scissor` / `.scissorTest` into GL state), so the
    // bound must be written on `inputBuffer` — `renderer.setScissor` would be
    // ignored here. Values are RENDER-TARGET pixels (no pixelRatio multiply on
    // the RT path). Saved and restored unconditionally so the composer's next
    // pass sees the buffer exactly as it found it.
    const rect = this._scissorRect;
    const prevScissorTest = inputBuffer ? inputBuffer.scissorTest : false;
    const prevScissorX = inputBuffer ? inputBuffer.scissor.x : 0;
    const prevScissorY = inputBuffer ? inputBuffer.scissor.y : 0;
    const prevScissorZ = inputBuffer ? inputBuffer.scissor.z : 0;
    const prevScissorW = inputBuffer ? inputBuffer.scissor.w : 0;
    try {
      // 2026-10-05 "portal punch = screen-sized black box": NEVER scissor a
      // MULTISAMPLED target. three resolves the MSAA renderbuffer into the
      // texture after every render (blitFramebuffer — which honours the
      // scissor test) and then invalidates the MSAA colour, so only the
      // scissor rect resolved and it came back BLACK (live-confirmed: the
      // box vanished with msaa off). The scissor is a pure optimisation —
      // the GPU clips the punch polygons anyway, and retail has none.
      const multisampled = (inputBuffer?.samples | 0) > 0;
      if (rect && inputBuffer && !multisampled) {
        const bw = inputBuffer.width | 0;
        const bh = inputBuffer.height | 0;
        // Round OUTWARD by a pixel so a doorway edge is never sliced off by
        // rounding — over-including one pixel of the doorway is harmless,
        // under-including leaves a hairline of un-punched terrain.
        const sx = Math.max(0, Math.floor(rect.x0 * bw) - 1);
        const sy = Math.max(0, Math.floor(rect.y0 * bh) - 1);
        const sw = Math.min(bw - sx, Math.ceil((rect.x1 - rect.x0) * bw) + 2);
        const sh = Math.min(bh - sy, Math.ceil((rect.y1 - rect.y0) * bh) + 2);
        if (sw > 0 && sh > 0) {
          inputBuffer.scissor.set(sx, sy, sw, sh);
          inputBuffer.scissorTest = true;
        }
      }
      renderer.autoClear = false;
      renderer.setRenderTarget(inputBuffer);
      if (this._stencilGate && this._markMat) {
        // Stencil is scratch space owned entirely by this pass, but nothing
        // else clears it, so a mark left by the previous frame would let a
        // now-occluded aperture punch. Clear first — the scissor set above is
        // live on the bound target, so this only touches the doorway rects.
        renderer.clearStencil();
        // (a) MARK the pixels where the aperture is genuinely unoccluded.
        this._apertureMesh.material = this._markMat;
        renderer.render(this.apertureScene, cam);
        // (b) PUNCH, confined to those pixels.
        this._apertureMesh.material = this._punchMat;
        renderer.render(this.apertureScene, cam);
      } else {
        // (SEAL: the outdoor remainder is drawn BEFORE the wipe by
        // SealRemainderPass / the direct path, never here — round 3.)
        // Legacy unconditional punch (no stencil attachment available).
        // Draw the aperture polygons: colorWrite off, depthFunc Always, write
        // FAR. Punches the doorway depth to far in the shared buffer the cells
        // pass then draws into. No color/depth/stencil CLEAR.
        renderer.render(this.apertureScene, cam);
      }
    } catch (e) {
      this._errored = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[portal_punch] render error — pass DISABLED (interiors fall back to the world pass). Report:",
        e,
      );
    } finally {
      if (inputBuffer) {
        inputBuffer.scissor.set(prevScissorX, prevScissorY, prevScissorZ, prevScissorW);
        inputBuffer.scissorTest = prevScissorTest;
      }
      renderer.autoClear = prevAutoClear;
      // Re-binding the previous target re-applies GL viewport/scissor state
      // from that target (or the renderer, for the canvas) — so the restore
      // above is what the composer's next pass actually observes.
      renderer.setRenderTarget(prevTarget);
    }
  }

  /** True when this SEAL wants the outdoor-remainder pre-draw this frame. */
  get wantsRemainder() {
    return this.mode === "seal" && this._sealLogDepth === true && !this._errored &&
      this.outdoorRemainder != null && this.hasApertures;
  }

  /** True when this SEAL wants the pre-wipe depth saved and restored. */
  get wantsDepthRestore() {
    return this.mode === "seal" && this._sealLogDepth === true && !this._errored && this.hasApertures;
  }

  /**
   * Draw the outdoor remainder (see collectOutdoorRemainderHidden) into the
   * bound target with the camera on the INDOOR layer. MUST run BEFORE the
   * depth wipe, right after the world pass, so it depth-tests against terrain
   * and the other-landblock buildings exactly as retail LScape::draw tests all
   * outdoor content together (acclient.c:461480, before Clear(4) at :461484).
   *
   * Narrowed to `remainderRect` (the union screen rect of the doorways being
   * sealed, GL convention [0,1] y-up, from cells.js) — retail's PortalList
   * clip: viewport set to the rect and the camera given the matching view
   * offset, so both the cull frustum and the rasterised area are the doorway.
   * Viewport, never scissor: a scissor on a multisampled target also clips the
   * MSAA resolve (the 2026-10-05 black-box bug).
   *
   * Everything it touches — node visibility, camera mask / view / projection,
   * target viewport, scene background, shadow-map auto update — is restored,
   * also on a throw. Shadow maps are not re-rendered (the world pass rendered
   * them). The cells pass redraws these nodes after the wipe: nearer than the
   * wall at identical depth (LessEqual, same colour), beyond it rejected, so
   * this draw's colour stays exactly where the doorway shows outdoors.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} cam
   * @param {THREE.WebGLRenderTarget|null} target  null = the canvas
   */
  drawOutdoorRemainder(renderer, cam, target = null) {
    const rem = this.outdoorRemainder;
    const scene = rem && rem.scene;
    if (!scene || !rem.worldRoot || !cam || !cam.layers) return false;
    const hidden = collectOutdoorRemainderHidden(rem, this._remainderHidden);
    const prevMask = cam.layers.mask;
    const prevBg = scene.background;
    const shadowMap = renderer.shadowMap;
    const prevShadowAuto = shadowMap ? shadowMap.autoUpdate : undefined;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    const narrow = narrowCameraToRect(renderer, cam, target, this.remainderRect);
    let n = 0;
    try {
      for (; n < hidden.length; n++) hidden[n].visible = false;
      cam.layers.mask = LAYER_INDOOR_BIT;
      // three repaints scene.background on every render() — it would wipe the
      // world pass's colour.
      scene.background = null;
      if (shadowMap) shadowMap.autoUpdate = false;
      renderer.autoClear = false;
      if (renderer.setRenderTarget) renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      this.remainderDraws++;
      if (narrow) this.remainderNarrowed++;
      return true;
    } finally {
      for (let i = 0; i < n; i++) hidden[i].visible = true;
      hidden.length = 0;
      if (narrow) narrow.restore();
      cam.layers.mask = prevMask;
      scene.background = prevBg;
      if (shadowMap) shadowMap.autoUpdate = prevShadowAuto;
      renderer.autoClear = prevAutoClear;
      if (renderer.setRenderTarget) renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    this._disposeApertureMesh();
    this._punchMat?.dispose();
    this._markMat?.dispose();
    this._restoreMat?.dispose();
    this._savedDepthRT?.dispose();
    this._curDepthRT?.dispose();
    super.dispose?.();
  }
}

/**
 * Narrow `cam` + the render viewport to `rect` ([0,1] GL convention, y up).
 * Returns `{ restore() }` or null when there is nothing to narrow (no rect, a
 * degenerate rect, a camera without setViewOffset, or a rect covering the
 * whole frame). Expands outward by one pixel so a doorway edge is never cut.
 * Exported for the node test.
 */
export function narrowCameraToRect(renderer, cam, target, rect) {
  if (!rect || !cam || typeof cam.setViewOffset !== "function") return null;
  if (!(Number.isFinite(rect.x0) && Number.isFinite(rect.y0) &&
        Number.isFinite(rect.x1) && Number.isFinite(rect.y1))) return null;
  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return null;
  let W;
  let H;
  if (target) {
    W = target.width | 0;
    H = target.height | 0;
  } else if (renderer && typeof renderer.getSize === "function") {
    const v = renderer.getSize(new THREE.Vector2());
    W = v.x | 0;
    H = v.y | 0;
  }
  if (!(W > 0 && H > 0)) return null;
  const x = Math.max(0, Math.floor(rect.x0 * W) - 1);
  const y = Math.max(0, Math.floor(rect.y0 * H) - 1); // from the bottom
  const x1 = Math.min(W, Math.ceil(rect.x1 * W) + 1);
  const y1 = Math.min(H, Math.ceil(rect.y1 * H) + 1);
  const w = x1 - x;
  const h = y1 - y;
  if (w <= 0 || h <= 0) return null;
  if (x === 0 && y === 0 && w === W && h === H) return null;

  const prevView = cam.view ? { ...cam.view } : null;
  const prevProj = cam.projectionMatrix.clone();
  const prevProjInv = cam.projectionMatrixInverse.clone();
  const prevViewport = target ? target.viewport.clone() : null;
  const prevRendererViewport =
    !target && renderer && typeof renderer.getViewport === "function"
      ? renderer.getViewport(new THREE.Vector4())
      : null;
  // three's view offset counts y from the TOP of the full frame.
  cam.setViewOffset(W, H, x, H - y - h, w, h);
  if (target) {
    target.viewport.set(x, y, w, h);
  } else if (renderer && typeof renderer.setViewport === "function") {
    renderer.setViewport(x, y, w, h);
  }
  return {
    x, y, w, h, W, H,
    restore() {
      cam.view = prevView;
      cam.projectionMatrix.copy(prevProj);
      cam.projectionMatrixInverse.copy(prevProjInv);
      if (target && prevViewport) target.viewport.copy(prevViewport);
      if (prevRendererViewport) renderer.setViewport(prevRendererViewport);
    },
  };
}

/**
 * The per-pixel rule the depth restore implements (the GLSL in
 * makeDepthRestoreMaterial is this function): under a sealed pixel, if the
 * depth left after the cells pass still EQUALS the seal's own depth there,
 * nothing interior drew in front of the wall, so the pixel shows outdoor
 * colour and gets back the pre-wipe (outdoor) depth. Otherwise the interior
 * surface that won keeps its depth.
 */
export const DEPTH_RESTORE_EPS = 1e-5;
export function restoredDepth(cur, sealOwn, saved) {
  return Math.abs(cur - sealOwn) <= DEPTH_RESTORE_EPS ? saved : cur;
}

// Fullscreen copy of a depth texture into a float colour target. texelFetch:
// no filtering on a depth texture (implementation-defined with LINEAR).
let _copyScene = null;
let _copyCam = null;
let _copyMat = null;
function _depthCopyRig() {
  if (_copyScene) return { scene: _copyScene, cam: _copyCam, mat: _copyMat };
  _copyMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tDepth: { value: null } },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform highp sampler2D tDepth;
      out vec4 _c;
      void main() {
        _c = vec4(texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r, 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  _copyMat.name = "portal-seal-depth-copy";
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), _copyMat);
  mesh.frustumCulled = false;
  _copyScene = new THREE.Scene();
  _copyScene.add(mesh);
  _copyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { scene: _copyScene, cam: _copyCam, mat: _copyMat };
}

function _ensureFloatRT(rt, w, h) {
  if (rt && rt.width === w && rt.height === h) return rt;
  rt?.dispose();
  const next = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RedFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  next.texture.name = "portal-seal-depth";
  return next;
}

function _copyDepth(renderer, depthTexture, rt) {
  const rig = _depthCopyRig();
  rig.mat.uniforms.tDepth.value = depthTexture;
  renderer.setRenderTarget(rt);
  renderer.render(rig.scene, rig.cam);
  rig.mat.uniforms.tDepth.value = null;
}

function makeDepthRestoreMaterial() {
  const vertexShader = /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`;
  // Same vertex math + same log-depth statements as the seal, so `own` is the
  // value the seal stamped at this fragment. Then restoredDepth() verbatim.
  const fragmentShader = /* glsl */ `
      precision highp float;
      uniform highp sampler2D tSaved;
      uniform highp sampler2D tCur;
      // Declared here, not by withLogDepthFragment: that helper leaves any
      // source that already mentions vFragDepth untouched, and three only
      // defines USE_LOGARITHMIC_DEPTH_BUFFER — it declares none of these.
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        uniform float logDepthBufFC;
        varying float vFragDepth;
        varying float vIsPerspective;
      #endif
      out vec4 _c;
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
          float own = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
        #else
          float own = gl_FragCoord.z;
        #endif
        float cur = texelFetch(tCur, p, 0).r;
        gl_FragDepth = abs(cur - own) <= 1.0e-5 ? texelFetch(tSaved, p, 0).r : cur;
        _c = vec4(0.0);
      }`;
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tSaved: { value: null }, tCur: { value: null } },
    vertexShader: withLogDepthVertex(vertexShader),
    fragmentShader: withLogDepthFragment(fragmentShader),
  });
  m.name = "portal-seal-depth-restore";
  m.colorWrite = false;
  m.depthTest = true;
  m.depthFunc = THREE.AlwaysDepth;
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * Composer slot right AFTER the world pass and BEFORE the depth wipe: draws
 * the seal's outdoor remainder against the world depth (retail LScape::draw
 * order). Disabled unless the seal wants it this frame.
 */
export class SealRemainderPass extends Pass {
  constructor(seal) {
    super("SealRemainderPass");
    this.seal = seal;
    this.needsSwap = false;
  }

  render(renderer, inputBuffer) {
    const seal = this.seal;
    if (!seal || !seal.wantsRemainder) return;
    try {
      seal.drawOutdoorRemainder(renderer, seal.camera, inputBuffer);
    } catch (e) {
      seal._errored = true;
      // eslint-disable-next-line no-console
      console.warn("[portal_seal] outdoor-remainder pre-draw failed — seal DISABLED:", e);
    }
  }
}

/**
 * Composer slot after the remainder pass and BEFORE the wipe: copy the
 * outdoor depth aside for SealDepthRestorePass.
 */
export class SealDepthSavePass extends Pass {
  constructor(seal) {
    super("SealDepthSavePass");
    this.seal = seal;
    this.needsSwap = false;
  }

  render(renderer, inputBuffer) {
    const seal = this.seal;
    if (!seal) return;
    seal._depthSaved = false;
    const depth = inputBuffer?.depthTexture;
    if (!seal.wantsDepthRestore || !depth) return;
    const prev = renderer.getRenderTarget();
    try {
      seal._savedDepthRT = _ensureFloatRT(seal._savedDepthRT, inputBuffer.width, inputBuffer.height);
      _copyDepth(renderer, depth, seal._savedDepthRT);
      seal._depthSaved = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[portal_seal] depth save failed — restore skipped:", e);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }
}

/**
 * Composer slot right AFTER the cells pass: under the sealed pixels, give
 * back the pre-wipe depth wherever the seal's wall is still the depth (see
 * restoredDepth), so AerialPerspective / heat haze / horizon dissolve / the
 * cloud overlay read the outdoor distance through a doorway instead of the
 * wall. Two draws: a fullscreen depth copy and the aperture mesh.
 */
export class SealDepthRestorePass extends Pass {
  constructor(seal) {
    super("SealDepthRestorePass");
    this.seal = seal;
    this.needsSwap = false;
    // The effects read pmndrs' STABLE depth copy, which the composer blits
    // only after passes that ask for it (EffectComposer.render, 6.39.1
    // build/index.js:1279). The cells RenderPass blitted before this pass ran,
    // so ask for a re-blit or the restore is invisible to every effect.
    this.needsDepthBlit = true;
  }

  render(renderer, inputBuffer) {
    const seal = this.seal;
    if (!seal || !seal._depthSaved) return;
    seal._depthSaved = false;
    const depth = inputBuffer?.depthTexture;
    const cam = seal.camera;
    if (!depth || !cam || !seal.hasApertures || !seal._apertureMesh) return;
    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const mesh = seal._apertureMesh;
    const prevMat = mesh.material;
    // This slot runs right after the cells pass, while the camera is still on
    // the INDOOR-only mask; the aperture mesh lives on layer 0.
    const prevMask = cam.layers.mask;
    try {
      cam.layers.mask = prevMask | 1;
      seal._curDepthRT = _ensureFloatRT(seal._curDepthRT, inputBuffer.width, inputBuffer.height);
      _copyDepth(renderer, depth, seal._curDepthRT);
      if (!seal._restoreMat) seal._restoreMat = makeDepthRestoreMaterial();
      seal._restoreMat.uniforms.tSaved.value = seal._savedDepthRT.texture;
      seal._restoreMat.uniforms.tCur.value = seal._curDepthRT.texture;
      mesh.material = seal._restoreMat;
      renderer.autoClear = false;
      renderer.setRenderTarget(inputBuffer);
      renderer.render(seal.apertureScene, cam);
      seal.depthRestores++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[portal_seal] depth restore failed:", e);
    } finally {
      cam.layers.mask = prevMask;
      mesh.material = prevMat;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prev);
    }
  }
}

/** Test hook: the depth-restore material (tests/portal_shader_decls.test.mjs). */
export const __test_makeDepthRestoreMaterial = () => makeDepthRestoreMaterial();
