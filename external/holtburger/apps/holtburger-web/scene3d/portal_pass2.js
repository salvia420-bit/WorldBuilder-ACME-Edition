// scene3d/portal_pass2.js — retail PORTAL ARCHITECTURE, second pass (`?portalPass2`).
//
// DEFAULT OFF. Nothing in this module runs, allocates, or is even referenced
// unless `?portalPass2=on` (strict; see `readPortalPass2Flag`). It adds NO
// render pass, NO framebuffer attachment and NO material — it is a pure
// transform from the wasm aperture stream to a SUBSET of that same stream, so
// the default path's allocation cost is exactly the module's parse cost at
// import time and nothing else. That property is deliberate: the 2026-08-13
// regression was a correctly default-OFF flag whose mere PRESENCE made the
// composer allocate a stencil and flip the shared depth texture to packed
// depth-stencil. A gate that can only ever remove members from a list cannot
// have that failure mode.
//
// ---------------------------------------------------------------------------
// WHAT RETAIL ACTUALLY DOES (read from $DECOMP/acclient.c, not from our JS)
// ---------------------------------------------------------------------------
// The outdoor path — camera outside, looking at a building — is NOT the
// one-big-pass shape we ported. It is, per PORTAL POLYGON:
//
//   BSPNODE::build_draw_portals_only / BSPPORTAL::portal_draw_portals_only
//   (acclient.c:364428-364520) walk the BUILDING'S OWN BSP tree, taking the
//   sidedness of the camera against each splitting plane and recursing
//   far-subtree → own portals → near-subtree. That is a per-building
//   back-to-front portal order, and it calls, per portal poly:
//
//   PView::DrawPortal (acclient.c:462565) →
//     PView::ConstructView(CBldPortal*, CPolygon*, check, mode)
//     (acclient.c:462507-462562), which
//       (a) rejects on SIDEDNESS: signed distance of the camera to the portal
//           plane vs `outside_portal->portal_side` (:462513-462543) — an exact
//           test, and the one our v3 aperture export already carries;
//       (b) runs `PView::GetClip` against the CURRENT accumulated portal view
//           volume and returns 0 when the clipped polygon is empty (:462545);
//       (c) `CEnvCell::GetVisible(other_cell_id)` + `Render::copy_view` — the
//           destination cell must exist and the view must survive intersection
//           with the cell's own portal view (:462551-462558), else return 0;
//       (d) only then stamps the portal poly
//           (`D3DPolyRender::DrawPortalPolyInternal`, :462560) and recurses
//           inward via `ConstructView(cell, other_portal_id)`;
//     and, back in DrawPortal, only when ALL of that returned 1 does it call
//     `PView::DrawCells(this, /*from_outside=*/1)` (:462588) — i.e. THAT
//     portal's interior is drawn immediately, nested inside that building's
//     walk, before the next portal is considered.
//
//   PView::ConstructView(CEnvCell*, portal_in) (acclient.c:462423-462462) is
//   the flood: it seeds `cell_todo_list` from ONE cell and grows it only
//   through `PView::ClipPortals`, so a cell is reached solely by a chain of
//   non-empty clipped apertures. That is the reachability we do not have.
//
// THE Z-WIPE IS NOT PART OF THE OUTDOOR PATH. `PView::DrawCells`
// (acclient.c:461450) puts `LScape::draw` + `FlushAlphaList` + the
// `Clear(4, …, 1.0)` Z-wipe (:461483-461487) INSIDE `if
// (this->outside_view.view_count)`. `outside_view` is populated by the
// INDOOR-looking-out case (`PView::DrawInside`, :462590 → `DrawCells(this, 0)`)
// — the landscape is drawn through the doorways, then Z is wiped, then the
// exterior portal planes are re-stamped, then the cells are drawn. On the
// outdoor entry (`DrawPortal` → `DrawCells(this, 1)`) there is no landscape
// draw and no wipe: the outdoor punch earns DEPTHTEST_ALWAYS from (a)+(b)+(c)
// and from the per-building nesting, NOT from a wipe. So this module
// implements NO Z-wipe; ours already lives, correctly, on the indoor split
// (`?indoorDepthSplit`, scene3d/cells.js `tickPortalSeal`).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE REPRODUCES, AND WHAT IT CANNOT
// ---------------------------------------------------------------------------
// Reproduced:
//   1. the sidedness seed (a) as the FIRST gate, before grouping, so ordering
//      and occlusion only ever see apertures a viewer could face;
//   2. PER-BUILDING GROUPING — retail's unit of work is one building's BSP
//      walk; ours was one flat list across every loaded landblock. Grouping is
//      by proximity of the owning cell's AABB centre (union-find,
//      `BUILDING_GROUP_RADIUS_M`), which is a proxy: the wire format carries
//      no building id, and adding one is `src/lib.rs`, owned by another lane
//      this session;
//   3. BACK-TO-FRONT GROUP ORDER — the BSP walk's observable output, here as a
//      sort on camera→group-centroid distance, descending;
//   4. a BUILDING OCCLUDER (the missing (b)/(c) in screen space): an aperture
//      of a FARTHER group is dropped when its screen rect is fully contained
//      in the screen span of a NEARER group. Retail's occluder is that nearer
//      building's own opaque BSP geometry, drawn in the same walk; we have
//      only the nearer building's apertures, so this is strictly weaker and
//      strictly conservative — it can only drop, never add.
//
// NOT reproduced (and why):
//   · `GetClip` against the accumulated portal view volume — that needs a real
//     `PView` port with per-cell `portal_view` stacks;
//   · the inward flood (`ConstructView(cell, portal_in)`, nested rooms) — the
//     wasm export is depth-1 by construction (`_max_depth` is unused there);
//   · `CEnvCell::GetVisible` + `copy_view` view intersection;
//   · the interleaving of punch and interior draw per portal — we still run
//     ONE punch pass then ONE cells pass; grouping here changes WHICH
//     apertures survive, not how many passes there are;
//   · the Z-wipe — deliberately, see above.
//
// Wire shape in and out is IDENTICAL (the v1/v2/v3 aperture stream that
// `clipAperturesForPunch` already parses), so this slots in front of the
// existing clip with no change to any consumer.

import {
  polygonPlane,
  apertureFacesAwayWithSide,
  apertureFacesAway,
  projectScreenRect,
} from "./portal_clip.js";

/**
 * Union-find radius for "these two cells belong to the same building", in
 * metres, applied to the owning cell's AABB centre. AC dungeons/buildings put
 * adjacent room cells within a few metres of each other; separate buildings in
 * a town are typically tens of metres apart. Transitive, so a long building
 * still forms one group.
 */
export const BUILDING_GROUP_RADIUS_M = 24;

/**
 * A nearer group must be at least this much closer (metres) before it is
 * allowed to occlude a farther group's aperture. Stops two interleaved
 * buildings at nearly equal range from cancelling each other's doorways.
 */
export const OCCLUDER_MIN_SEPARATION_M = 8;

/**
 * Strict flag reader. `?portalPass2=on` / `=1` arm it; ANYTHING else — absent,
 * empty, `=off`, `=true`, garbage — is OFF.
 *
 * Written as `=== "on" || === "1"` rather than `!== "off"` on purpose: the
 * `!== "off"` idiom is the documented flag-default footgun (a flag commented
 * "default OFF" that reads ON whenever the param is absent), and six cast
 * flags in this app are silently live because of it.
 */
export function readPortalPass2Flag(search) {
  let s = search;
  if (s == null) {
    try {
      s = typeof window !== "undefined" ? window.location?.search : "";
    } catch (_) {
      s = "";
    }
  }
  if (typeof s !== "string" || s.length === 0) return false;
  let v = null;
  try {
    v = new URLSearchParams(s).get("portalPass2");
  } catch (_) {
    return false;
  }
  if (v == null) return false;
  const t = String(v).toLowerCase();
  return t === "on" || t === "1";
}

/**
 * Parse the aperture stream into records that remember their RAW slice, so
 * `encodeApertures` can re-emit survivors byte-for-byte in whatever wire
 * version came in (v1 / v2 / v3).
 *
 * Returns `[]` for a malformed or empty stream — never throws.
 */
export function parseApertures(flat, opts = {}) {
  const out = [];
  if (!flat || flat.length < 1) return out;
  const withCellCenter = !!opts.withCellCenter;
  const withPortalSide = !!opts.withPortalSide;
  const count = flat[0] | 0;
  if (count <= 0) return out;
  let k = 1;
  for (let a = 0; a < count; a++) {
    const recStart = k;
    if (k >= flat.length) break;
    const nv = flat[k++] | 0;
    let center = null;
    if (withCellCenter) {
      center = { x: flat[k], y: flat[k + 1], z: flat[k + 2] };
      k += 3;
    }
    let portalSide = null;
    if (withPortalSide) {
      portalSide = flat[k] === 1;
      k += 1;
    }
    const vStart = k;
    k += nv * 3;
    if (nv < 3 || k > flat.length) break;
    const pts = new Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) pts[i] = flat[vStart + i];
    out.push({
      index: a,
      nverts: nv,
      center,
      portalSide,
      pts,
      recStart,
      recEnd: k,
    });
  }
  return out;
}

/** Re-emit a subset of parsed apertures in the SAME wire shape they arrived in. */
export function encodeApertures(flat, apertures) {
  const out = [apertures.length];
  for (const ap of apertures) {
    for (let i = ap.recStart; i < ap.recEnd; i++) out.push(flat[i]);
  }
  out[0] = apertures.length;
  return out;
}

function apertureAnchor(ap) {
  if (ap.center && Number.isFinite(ap.center.x)) return ap.center;
  let x = 0;
  let y = 0;
  let z = 0;
  const n = ap.nverts;
  for (let i = 0; i < n; i++) {
    x += ap.pts[i * 3];
    y += ap.pts[i * 3 + 1];
    z += ap.pts[i * 3 + 2];
  }
  return { x: x / n, y: y / n, z: z / n };
}

/**
 * Retail's unit of work: ONE BUILDING (`BSPNODE::build_draw_portals_only`
 * walks a single building's tree). Union-find over anchor proximity; O(n²) in
 * the aperture count, which in a town is tens, not thousands, and only when
 * the flag is on.
 */
export function groupAperturesByBuilding(apertures, opts = {}) {
  const r = Number.isFinite(opts.radiusM) ? opts.radiusM : BUILDING_GROUP_RADIUS_M;
  const r2 = r * r;
  const n = apertures.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const anchors = apertures.map(apertureAnchor);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = anchors[i].x - anchors[j].x;
      const dy = anchors[i].y - anchors[j].y;
      const dz = anchors[i].z - anchors[j].z;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let g = byRoot.get(root);
    if (!g) {
      g = { id: byRoot.size, apertures: [], anchors: [] };
      byRoot.set(root, g);
    }
    g.apertures.push(apertures[i]);
    g.anchors.push(anchors[i]);
  }
  const groups = [...byRoot.values()];
  for (const g of groups) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const a of g.anchors) {
      x += a.x;
      y += a.y;
      z += a.z;
    }
    g.centroid = { x: x / g.anchors.length, y: y / g.anchors.length, z: z / g.anchors.length };
    delete g.anchors;
  }
  return groups;
}

/**
 * Back-to-front, the observable output of retail's BSP portal walk
 * (acclient.c:364428-364520 recurses far side → own portals → near side).
 * Farthest group first; ids are re-stamped so the diag reads in draw order.
 */
export function orderGroupsBackToFront(groups, camAc) {
  const cam = camAc ?? { x: 0, y: 0, z: 0 };
  const withDist = groups.map((g) => {
    const dx = g.centroid.x - cam.x;
    const dy = g.centroid.y - cam.y;
    const dz = g.centroid.z - cam.z;
    return { g, d: Math.sqrt(dx * dx + dy * dy + dz * dz) };
  });
  withDist.sort((a, b) => b.d - a.d);
  return withDist.map((e, i) => {
    e.g.dist = e.d;
    e.g.order = i;
    return e.g;
  });
}

function rectUnion(rects) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    if (r.x0 < x0) x0 = r.x0;
    if (r.y0 < y0) y0 = r.y0;
    if (r.x1 > x1) x1 = r.x1;
    if (r.y1 > y1) y1 = r.y1;
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x0, y0, x1, y1 };
}

function contains(outer, inner) {
  return (
    inner.x0 >= outer.x0 &&
    inner.x1 <= outer.x1 &&
    inner.y0 >= outer.y0 &&
    inner.y1 <= outer.y1
  );
}

/**
 * THE PASS-2 FILTER. Stream in → same-shape stream out, plus a diag.
 *
 * Stages, in retail's order:
 *   0. sidedness seed  (ConstructView, acclient.c:462513-462543)
 *   1. per-building grouping     (one BSP walk per building)
 *   2. back-to-front group order (the BSP walk's output order)
 *   3. nearer-building occluder  (screen-space stand-in for GetClip/copy_view)
 *
 * Never throws: on any malformed input it returns the input untouched with
 * `reason` naming why, so an armed session degrades to today's behaviour
 * rather than to a black frame.
 */
export function portalPass2Filter(flat, mvp, opts = {}) {
  const diag = {
    armed: true,
    reason: "ok",
    offered: flat && flat.length ? flat[0] | 0 : 0,
    kept: 0,
    dropped: { sidedness: 0, occluded: 0 },
    groups: [],
    gates: {
      sidedness: false,
      grouping: true,
      backToFront: true,
      occluder: opts.occluder !== false,
      zWipe: false, // retail's wipe is the INDOOR path only — see header.
    },
  };
  if (!flat || flat.length < 1 || (flat[0] | 0) <= 0) {
    diag.reason = "no-apertures";
    return { flat, diag };
  }
  const parsed = parseApertures(flat, opts);
  if (parsed.length !== (flat[0] | 0)) {
    // A short/mismatched buffer means we parsed a shape we were not given.
    // Hand the caller its own input back rather than a truncated punch set.
    diag.reason = "parse-shape-mismatch";
    return { flat, diag };
  }

  const camAc = opts.camAc ?? null;

  // 0. sidedness seed.
  let survivors = parsed;
  if (camAc) {
    survivors = [];
    for (const ap of parsed) {
      const plane = polygonPlane(ap.pts);
      let away = false;
      if (ap.portalSide !== null) {
        away = !!apertureFacesAwayWithSide(ap.pts, ap.portalSide, camAc, 0);
      } else if (ap.center) {
        away = !!apertureFacesAway(ap.pts, ap.center, camAc, 0);
      }
      ap.plane = plane;
      if (away) {
        diag.dropped.sidedness++;
        continue;
      }
      survivors.push(ap);
    }
    diag.gates.sidedness = true;
  }

  // 1 + 2. group, then order back-to-front.
  const groups = orderGroupsBackToFront(
    groupAperturesByBuilding(survivors, opts),
    camAc,
  );

  // 3. nearer-building occluder.
  const useOccluder = opts.occluder !== false && mvp && mvp.length === 16;
  const groupRects = new Array(groups.length).fill(null);
  if (useOccluder) {
    for (let i = 0; i < groups.length; i++) {
      groupRects[i] = rectUnion(
        groups[i].apertures.map((ap) => projectScreenRect(ap.pts, mvp)),
      );
    }
  }

  const kept = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let gk = 0;
    let gdrop = 0;
    for (const ap of g.apertures) {
      let occluded = false;
      if (useOccluder) {
        const r = projectScreenRect(ap.pts, mvp);
        if (r) {
          // Groups are ordered far → near, so every LATER group is nearer.
          for (let j = i + 1; j < groups.length; j++) {
            const nearer = groups[j];
            if (g.dist - nearer.dist < OCCLUDER_MIN_SEPARATION_M) continue;
            const nr = groupRects[j];
            if (nr && contains(nr, r)) {
              occluded = true;
              break;
            }
          }
        }
      }
      if (occluded) {
        diag.dropped.occluded++;
        gdrop++;
        continue;
      }
      kept.push(ap);
      gk++;
    }
    diag.groups.push({
      id: g.id,
      order: g.order,
      dist: Math.round(g.dist * 10) / 10,
      offered: g.apertures.length,
      kept: gk,
      droppedOccluded: gdrop,
    });
  }

  // Keep the ORIGINAL stream order for the encoded output: the punch pass draws
  // every aperture with DEPTHTEST_ALWAYS into the same buffer, so their order
  // among themselves is not observable, and preserving it keeps this filter a
  // pure subset — trivially diffable against the unfiltered arm.
  kept.sort((a, b) => a.index - b.index);
  diag.kept = kept.length;
  if (kept.length === 0) diag.reason = "all-apertures-dropped";
  return { flat: encodeApertures(flat, kept), diag };
}

/** The diag shape reported when the flag is OFF — so a paste is never ambiguous. */
export function portalPass2DisarmedDiag() {
  return { armed: false, reason: "flag-off(?portalPass2)", offered: 0, kept: 0, groups: [] };
}
