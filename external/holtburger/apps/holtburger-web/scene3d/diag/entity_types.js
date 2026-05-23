// scene3d/diag/entity_types.js — entity-classification diagnostic slice
//
// Wraps `window.__wom` (WorldObjectManager) to expose four read-only
// devtools entry points under `diag.entityTypes`:
//
//   snapshot()              — whole-world classification counts
//   coverageByLb(lbId)      — same shape but filtered to one landblock
//                             (entity guid high-16 == landblock high-16)
//   unknownTuples()         — every entity that fell through canonicalClassify
//                             to the Unknown sentinel; the dump-shape the
//                             build-side classifier extension consumes
//   findByClass(className)  — convenience: live WorldObject instances by
//                             constructor name (delegates to __wom.byClass)
//
// We never re-run canonicalClassify here — that's cross-port testing
// territory (build-side). All this module does is SLICE what __wom has
// already classified into the diagnostic shape the harness expects.
//
// `__wom.snapshot()` already builds total / byClass / byCanonical /
// unknownCount / itemFallbackCount + a per-object array carrying the
// five classification fields. We reuse it for the whole-world call and
// iterate `__wom.objects` directly for the LB-filtered call so we don't
// have to materialize a full-world snapshot just to throw most of it
// away.

const NO_WOM = { error: "wom not loaded" };

/** Format an unsigned integer as a `0x...` hex string, no padding. */
function hex(n) {
  return "0x" + ((n >>> 0).toString(16));
}

/** Format a guid for display, zero-padded to 8 hex digits. */
function hexGuid(n) {
  return "0x" + ((n >>> 0).toString(16).padStart(8, "0"));
}

/** Landblock high-16 from a guid (AC's GUID layout puts the LB in the high word). */
function lbOfGuid(guid) {
  return ((guid & 0xffff0000) >>> 0);
}

/** Coerce a landblock argument (number or "0xLLLL0000" string) to its high-16. */
function normalizeLb(lbId) {
  const raw = typeof lbId === "string" ? parseInt(lbId, 16) : lbId;
  return ((raw & 0xffff0000) >>> 0);
}

/** Tally classificationSource counts over an iterable of objects. */
function sourceCounts(iter) {
  const out = { canonical: 0, "canonical-item-fallback": 0, unknown: 0 };
  for (const wo of iter) {
    const src = wo.classificationSource ?? "unknown";
    out[src] = (out[src] ?? 0) + 1;
  }
  return out;
}

/** Build a `byClass` tally from an iterable of live WorldObject instances. */
function classCounts(iter) {
  const out = {};
  for (const wo of iter) {
    const cls = wo.constructor?.name ?? "WorldObject";
    out[cls] = (out[cls] ?? 0) + 1;
  }
  return out;
}

/** Same but for the pre-fallback canonical class. */
function canonicalCounts(iter) {
  const out = {};
  for (const wo of iter) {
    const c = wo.canonicalObjectClass ?? "(unset)";
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

/** Extract one unknown-tuple record from a WorldObject (display form). */
function toUnknownTuple(wo) {
  return {
    wcid: hex(wo.classId ?? 0),
    itemType: hex(wo.intValues?.get(1) ?? 0),
    objDescFlags: hex(wo.objDescFlags ?? 0),
    weenieFlags: hex(wo.weenieFlags ?? 0),
    name: wo.stringValues?.get(1) ?? "",
    guid: hexGuid(wo.id ?? 0),
  };
}

export function attachEntityTypes(diag) {
  diag.entityTypes = {
    snapshot() {
      const wom = (typeof window !== "undefined") ? window.__wom : null;
      if (!wom) return { ...NO_WOM };
      // __wom.snapshot() already does the whole-world classification
      // bookkeeping; slice it into the diagnostic shape.
      const snap = wom.snapshot();
      const objects = wom.objects?.values?.() ?? [];
      const unknownTuples = [];
      for (const wo of objects) {
        if (wo.classificationSource === "unknown") unknownTuples.push(toUnknownTuple(wo));
      }
      return {
        total: snap.total,
        byClass: snap.byClass,
        bySource: sourceCounts(wom.objects.values()),
        byCanonicalObjectClass: snap.byCanonical,
        unknownTuples,
      };
    },

    coverageByLb(lbId) {
      const wom = (typeof window !== "undefined") ? window.__wom : null;
      if (!wom) return { ...NO_WOM };
      const lb = normalizeLb(lbId);
      const inLb = [];
      for (const wo of wom.objects.values()) {
        if (lbOfGuid(wo.id) === lb) inLb.push(wo);
      }
      const unknownTuples = inLb
        .filter((wo) => wo.classificationSource === "unknown")
        .map(toUnknownTuple);
      return {
        landblockId: "0x" + lb.toString(16).padStart(8, "0"),
        total: inLb.length,
        byClass: classCounts(inLb),
        bySource: sourceCounts(inLb),
        byCanonicalObjectClass: canonicalCounts(inLb),
        unknownTuples,
        ok: unknownTuples.length === 0,
      };
    },

    unknownTuples() {
      const wom = (typeof window !== "undefined") ? window.__wom : null;
      if (!wom) return { ...NO_WOM };
      const out = [];
      for (const wo of wom.objects.values()) {
        if (wo.classificationSource === "unknown") out.push(toUnknownTuple(wo));
      }
      return out;
    },

    findByClass(className) {
      const wom = (typeof window !== "undefined") ? window.__wom : null;
      if (!wom) return { ...NO_WOM };
      // Delegate to __wom.byClass — it already handles taxonomy descendants.
      return wom.byClass(className);
    },
  };
}
