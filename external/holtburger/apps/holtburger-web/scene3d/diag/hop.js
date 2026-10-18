// scene3d/diag/hop.js — TERRAIN-HOP (2026-10-18) devtools surface for the
// wasm hop detector (`holtburger_core::hop_diag`).
//
// Owner report: "there is still a bug in holtburger web where we will be
// running along, usually down a little hill or something, and we do a little
// jump."
//
// The JS rig plays the Falling take-off link on every local leave-ground edge
// and the landing link on touchdown (entities.js `setAirborne`), so one
// airborne slice of a runner reads as a little jump; a body lifted onto
// something reads as one without any airborne slice. The detector lives in
// Rust on the local manual-drive slice. It records every grounded slice that
// ended airborne (liftOff; bounceLiftOff for the landing bounce's own hop) and
// every grounded slice whose feet rose more than 5 cm against the drawn
// terrain (pop), with a cause, the transition outcome, the contact planes, the
// terrain normal and wading depth at both ends, the static objects on both
// landcells and how far the post-transition scenery/entity clamps moved the
// body. It prints a rate-limited `[hop] …` console line for lift-offs and
// unexplained pops (wading steps, step-ups onto objects and the landing
// bounce stay in the ring only). This module only reads that ring, on demand,
// through the `window.__hbWasm.hopDiag*` riders (index.html). It does no
// per-frame work.
//
// Devtools:
//   __diag.hop.summary()   — { count, kept, byKind, byCause, last }
//   __diag.hop.tail(n=5)   — the last n incidents (full records)
//   __diag.hop.explain()   — what the last incident means
//   __diag.hop.clear()     — forget the ring

/** What each kind means and where to look next. */
export const HOP_KINDS = Object.freeze({
  liftOff:
    "A grounded slice ended airborne (begin_fall) — the Falling take-off link " +
    "plays on this edge. transitionOk=true and moved=true with no contact plane " +
    "(contactNz null) or a too-steep one (contactNz < 0.664) is the driver " +
    "losing the ground: compare entryNz (the plane it entered on), " +
    "terrainNzBegin/End, depthBegin/End (shoreline wading) and staticsBegin/End " +
    "(buildings and props on the landcells).",
  bounceLiftOff:
    "The landing bounce's lift-off quantum (?landingBounce): the tail of an " +
    "earlier jump or fall, not a fresh ground loss. Look at the incident before it.",
  pop:
    "The feet rose more than 5 cm against the drawn terrain in one grounded slice " +
    "(rise, metres; excessBegin/End are the feet above the terrain, about -depth " +
    "when wading): a step-up onto an object, a shallower wading depth, or the body " +
    "lifted back out of the ground. The cause says which.",
});

/** What each cause means (the Rust `HopCause`). */
export const HOP_CAUSES = Object.freeze({
  noTerrain:
    "No terrain under the end pose: the landblock it ran onto is not streamed in " +
    "(the 3x3 terrain prefetch around the player normally prevents this).",
  leftGround:
    "Streamed terrain under it, but the transition ended without a contact plane " +
    "(or with one too steep to stand on): the driver lost the ground. Chase this.",
  bounce: "The landing bounce; see the incident before it.",
  wade:
    "The wading depth shrank by the rise: a shoreline cell's wet quadrant to its dry " +
    "one, or water to land. Retail does the same (calc_water_depth steps 0.9/0.45/0.1/0).",
  resurface:
    "The slice began with the feet under the ground and the transition lifted them " +
    "out: an earlier correction (clampM > 0 on the slice before: scenery or entity " +
    "clamp) left the body in the ground. Chase the slice before it.",
  object:
    "A building or prop is registered on the landcell: a step-up onto it (retail " +
    "climbs up to 1.5 x step_up_height = 0.9 m in one slice).",
  unexplained:
    "A rise on bare terrain with no wading change and no object: the one to chase. " +
    "Send __diag.hop.tail() with the position.",
  unknown: "Not classified.",
});

function _hb() {
  const w = (typeof window !== "undefined") ? window : null;
  return (w && w.__hbWasm) ? w.__hbWasm : null;
}

/** Parse the wasm JSON; `null` on a missing export or bad payload. */
export function readHopRing(hb = _hb()) {
  if (!hb || typeof hb.hopDiag !== "function") return null;
  try {
    const parsed = JSON.parse(hb.hopDiag());
    if (!parsed || !Array.isArray(parsed.incidents)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function hex(cell) {
  return typeof cell === "number" ? `0x${(cell >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : null;
}

/** Compact one incident for summaries (the full record stays in tail()). */
export function compactHop(i) {
  if (!i) return null;
  return {
    seq: i.seq,
    kind: i.kind,
    cause: i.cause,
    rise: i.rise,
    dtMs: i.dtMs,
    cells: [hex(i.beginCell), hex(i.endCell)],
    transitionOk: i.transitionOk,
    moved: i.moved,
    grounded: i.grounded,
    contactNz: i.contactNz,
    entryNz: i.entryNz,
    terrainNz: [i.terrainNzBegin, i.terrainNzEnd],
    depth: [i.depthBegin, i.depthEnd],
    statics: [i.staticsBegin, i.staticsEnd],
    clampM: i.clampM,
  };
}

export function attachHop(diag) {
  diag.hop = {
    /** The wasm exports are present (a stale pkg/ has none). */
    available() {
      const hb = _hb();
      return !!(hb && typeof hb.hopDiag === "function");
    },

    /** Incidents recorded since load (or the last clear); null if absent. */
    count() {
      const hb = _hb();
      if (!hb || typeof hb.hopDiagCount !== "function") return null;
      try {
        return hb.hopDiagCount() >>> 0;
      } catch (_) {
        return null;
      }
    },

    /** The last n incidents, oldest first (full records). */
    tail(n = 5) {
      const ring = readHopRing();
      if (!ring) return [];
      const k = Math.max(0, n | 0);
      return k === 0 ? [] : ring.incidents.slice(-k);
    },

    /** The most recent incident, or null. */
    last() {
      const ring = readHopRing();
      if (!ring || ring.incidents.length === 0) return null;
      return ring.incidents[ring.incidents.length - 1];
    },

    summary() {
      const ring = readHopRing();
      if (!ring) {
        return {
          available: false,
          error: "hopDiag export missing (stale pkg/ or pre-boot)",
        };
      }
      const byKind = {};
      const byCause = {};
      for (const i of ring.incidents) {
        byKind[i.kind] = (byKind[i.kind] || 0) + 1;
        const c = i.cause ?? "unknown";
        byCause[c] = (byCause[c] || 0) + 1;
      }
      const last = ring.incidents[ring.incidents.length - 1] ?? null;
      return {
        available: true,
        count: ring.count,
        kept: ring.incidents.length,
        byKind,
        byCause,
        last: compactHop(last),
      };
    },

    /** What an incident means (default: the most recent). */
    explain(incident) {
      const i = incident ?? this.last();
      if (!i) return "no hop recorded";
      const cause = i.cause ?? "unknown";
      return `#${i.seq} ${i.kind} (${cause}): ${HOP_KINDS[i.kind] ?? "unknown kind"} ` +
        `${HOP_CAUSES[cause] ?? "unknown cause"}`;
    },

    clear() {
      const hb = _hb();
      if (!hb || typeof hb.hopDiagClear !== "function") return false;
      try {
        hb.hopDiagClear();
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}
