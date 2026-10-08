// scene3d/canopy_soften.js — `?canopySoften` (2026-10-07, DEFAULT ON; `=off`
// escape, `=<0..1>` sets the strength).
//
// AC's broadleaf trees are a handful of big flat-faced polygons wrapped around
// a crown. Lit with their own face normals every face takes one flat value, so
// under real sun + shadows + AO (the 2026-10-07 look pass) a crown read as a
// faceted green rock — owner on the 1070: "soften canopies". The standard
// foliage remedy: bend the normals toward rays from the crown's centre, so the
// crown shades like the soft volume it stands for (lit cap, shaded underside,
// a gradual terminator) while each face keeps a share of its own normal (the
// leaf texture's breakup survives).
//
// Applied ONCE per surface group of a wind-responsive model (the same
// windResponds() set the GPU sway uses — trees and foliage), at the statics
// seam where the model's surface groups are built, in model space (AC Z-up),
// and per part for the keyframe-animated scenery (animated_scenery.js —
// swaying foliage and props; its flying ambients, e.g. the butterflies
// 0x02000493 / 0x02000494, are flat wing quads the flat-panel guard skips).
// Trunk-like groups (tall and
// thin), flat panels (flags, banners, blades, cards) and tiny groups are left
// alone. Only the
// `normal` attribute changes: no draw, program or material is added.

/** Default blend toward the crown-radial normal. */
export const CANOPY_SOFTEN_DEFAULT = 0.65;

/** The blend in [0, 1]; 0 = off. `?canopySoften=off` / a number. */
export function canopySoftenStrength(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("canopySoften");
    if (v == null || v === "") return CANOPY_SOFTEN_DEFAULT;
    const lv = String(v).toLowerCase();
    if (lv === "off" || lv === "false" || lv === "no") return 0;
    if (lv === "on" || lv === "true" || lv === "yes") return CANOPY_SOFTEN_DEFAULT;
    const n = Number(lv);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : CANOPY_SOFTEN_DEFAULT;
  } catch (_) {
    return CANOPY_SOFTEN_DEFAULT;
  }
}

const stats = { groups: 0, skippedTrunk: 0, skippedSmall: 0, skippedFlat: 0, vertices: 0 };

/**
 * Soften one surface group's normals toward its crown centre, in place.
 * Positions/normals are flat xyz Float32Arrays in model space, AC Z-up.
 * @returns {boolean} true when the normals were changed
 */
export function softenCanopyNormals(positions, normals, k) {
  if (!(k > 0) || !positions || !normals || positions.length !== normals.length) return false;
  const nv = positions.length / 3;
  if (nv < 12) { stats.skippedSmall += 1; return false; }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const wide = Math.max(dx, dy);
  // A trunk / branch / pole: much taller than wide. Leave its normals alone.
  if (dz > 1.0 && wide < 0.35 * dz) { stats.skippedTrunk += 1; return false; }
  if (wide < 0.15 && dz < 0.15) { stats.skippedSmall += 1; return false; }
  // A flat panel — a flag, a banner, a windmill blade, a single foliage card:
  // crown-radial normals would round it off. Crowns are roughly isotropic.
  if (Math.min(dx, dy, dz) < 0.15 * Math.max(dx, dy, dz)) { stats.skippedFlat += 1; return false; }
  // Crown centre, lowered a little so the cap faces the sky and the underside
  // faces the ground (a crown is lit from above, not from its own middle).
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = z0 + 0.42 * dz;
  for (let i = 0; i < positions.length; i += 3) {
    let rx = positions[i] - cx, ry = positions[i + 1] - cy, rz = positions[i + 2] - cz;
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-5) continue;
    rx /= rl; ry /= rl; rz /= rl;
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    let mx = nx + (rx - nx) * k, my = ny + (ry - ny) * k, mz = nz + (rz - nz) * k;
    let ml = Math.hypot(mx, my, mz);
    // Face normal and radial nearly opposite (an inward-wound face): take the
    // radial — the crown's outward direction is what lighting needs.
    if (ml < 0.2) { mx = rx; my = ry; mz = rz; ml = 1; }
    normals[i] = mx / ml; normals[i + 1] = my / ml; normals[i + 2] = mz / ml;
  }
  stats.groups += 1;
  stats.vertices += nv;
  return true;
}

/**
 * Soften every eligible group of one model (`groups` from
 * meshToGeometryGroups). Idempotent per geometry (userData guard), so a group
 * re-fed or shared across landblocks is never bent twice.
 */
export function softenCanopyGroups(groups, k = canopySoftenStrength()) {
  if (!(k > 0) || !Array.isArray(groups)) return 0;
  let n = 0;
  for (const g of groups) {
    const geom = g && g.geometry;
    if (!geom || !geom.attributes || geom.userData?.hbCanopySoft) continue;
    const pos = geom.attributes.position, nrm = geom.attributes.normal;
    if (!pos || !nrm || pos.itemSize !== 3 || nrm.itemSize !== 3) continue;
    geom.userData = geom.userData || {};
    geom.userData.hbCanopySoft = true;
    if (softenCanopyNormals(pos.array, nrm.array, k)) {
      nrm.needsUpdate = true;
      n += 1;
    }
  }
  return n;
}

export function canopySoftenStats() {
  return { ...stats, strength: canopySoftenStrength() };
}

if (typeof window !== "undefined") {
  window.__canopySoften = { stats: canopySoftenStats };
}
