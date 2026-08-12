// T13 (ST3, `?geomBundles`) — HBG1 GeometryBundle consumption.
//
// SPEC §1.2 / pass 4 D-04.5/S3: the wasm `assemble_model_geometry` /
// `assemble_envcell_geometry` exports hand back ONE JS-owned buffer + a
// small descriptor; `bundleToGeometryGroups` builds the SAME
// `{ groups: [{geometry, surfaceDid, doubleSided, subsetStippled}], … }`
// shape `meshToGeometryGroups` returns today, with geometries built as
// shared-vertex-stream attributes + per-group compact index arrays —
// `setIndex` finally present on the model path.
//
// ARMING (the T20 `?slotGrid` pattern — EXACT-MATCH DEV opt-in, every leg
// loud): `?geomBundles=on` requires
//   (1) `?packSource=on` with an ARMED controller (GEOM rides packs);
//   (2) the wasm assemble exports present (stale pkg/ disarms loudly);
//   (3) geometry relief OFF — HBG1 GEOM payloads bake the relief-free
//       default; index.html forces relief off under this flag unless the
//       user explicitly authored `?gfxRelief=on`, which wins and DISARMS
//       bundles. RELIEF-IN-BAKE lifts that leg for `?reliefBundles=on`
//       (DEFAULT-OFF, below): the dist then also carries baked relief
//       VARIANT payloads (`GEOMR`) and the arm consumes those instead of
//       disarming;
//   (4) `?placementId` NOT `off` — the bake resolves setup frames on the
//       retail chain (the wasm default).
// Any missing leg ⇒ byte-identical legacy decode (the kill path).
//
// Group identity mirrors `meshToGeometryGroups` exactly: default arm
// buckets by surface only (every group `doubleSided: true`); under
// `?perPolyCull=on` buckets split by (surface, sides). Subset stipple bits
// OR per SURFACE across subsets — the runtime's per-surface accumulation.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Flag + arming
// ---------------------------------------------------------------------------

function _exactOn(search, name) {
  try {
    const s =
      search !== undefined
        ? search
        : typeof window !== "undefined" && window.location
          ? window.location.search
          : "";
    const v = new URLSearchParams(s).get(name);
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

export function geomBundlesEnabled(search) {
  return _exactOn(search, "geomBundles");
}

/**
 * RELIEF-IN-BAKE — `?reliefBundles=on`. DEFAULT-OFF, EXACT-MATCH opt-in
 * (I7 / pass 9 D-09.3): absent or anything but an affirmative reads OFF,
 * so the OFF arm is today's code path byte-for-byte.
 *
 * Consuming the baked relief variant is what lets `?geomBundles` stop
 * force-disabling `?gfxRelief` (T13 D3). It requires BOTH flags plus relief
 * actually resolving ON for the instance — relief geometry with the relief
 * shading/config off would be an incoherent pairing.
 */
export function reliefBundlesEnabled(search) {
  return _exactOn(search, "reliefBundles");
}

/** True when the assemble path is serving baked relief variants. */
export function reliefBundlesActive() {
  return _state.armed === true && _state.relief === true;
}

const _state = {
  armed: false,
  wasmExports: null,
  reasons: [],
  // RELIEF-IN-BAKE: consume baked relief VARIANT geometry. DEFAULT-OFF
  // (I7) — false unless `?reliefBundles=on` armed every leg.
  relief: false,
};

const _stats = {
  bundles: { assembled: 0, bytesOut: 0, msAssemble: 0 },
  // D-04.8 gate counters — land with the entity-path instrumentation
  // (dormant substitution cache); zeros until then, fields present per the
  // registry contract.
  entityDecode: { count: 0, msTotal: 0, substKeyDupes: 0 },
  geomFallback: { modelsServedByRuntimeDecode: 0 },
  // RELIEF-IN-BAKE surface. `armed` = the variant export is in use;
  // `variantRowsResident` = how many relief rows the resident packs carry
  // (0 on a dist baked without `--geom-relief` — the loud tell that the arm
  // has nothing to serve and every model reads its relief-free default).
  relief: { armed: false, variantRowsResident: 0, modelsAssembled: 0 },
};

/**
 * DIAG-SHADOW (2026-08-11, GFXOBJ-RELIEF). `scene3d/diag/geometry.js` uses the
 * SAME `__diag.geometry` key for the geom-audit entry points, and both sides
 * used to install with a whole-object assignment — so whichever module ran
 * last won outright. In practice the audit ran last, its `relief()` GATE
 * FUNCTION sat where this module's relief STATS object should be, and the
 * RELIEF-IN-BAKE assertion `__diag.geometry.relief.variantRowsResident > 0`
 * could not be read literally in any arm (task-T4-EYES-report.md §3.3 — the
 * T4 session had to fall back to matching a console string).
 *
 * The two surfaces now COMPOSE. This module keeps ownership of the object
 * IDENTITY (`__diag.geometry === geomBundleStats()`, the registry contract in
 * `harness/lib/diag_schema.mjs`), and carries across anything the audit
 * attached first; `attachGeometry` attaches ONTO this object rather than
 * replacing it. The registered data fields keep the `relief` key; the gate
 * function is `reliefGate()`. Order-independent in both directions.
 */
function _installDiag() {
  try {
    if (typeof window === "undefined") return;
    if (!window.__diag) window.__diag = {};
    const prior = window.__diag.geometry;
    if (prior && prior !== _stats) {
      for (const k of Object.keys(prior)) {
        if (!(k in _stats)) _stats[k] = prior[k];
      }
    }
    window.__diag.geometry = _stats;
  } catch (_) {}
}

/**
 * Arm the bundle path. Call AFTER the pack controller boot + wasm seam
 * arming (the index.html ordering contract). Fail-soft: any missing leg
 * logs and leaves the runtime-decode path in charge.
 */
export function initGeomBundles({ wasmExports, controller } = {}) {
  _installDiag();
  _state.armed = false;
  _state.reasons = [];
  if (!geomBundlesEnabled()) return false;
  const reasons = _state.reasons;
  try {
    const ps = new URLSearchParams(window.location.search);
    const on = (v) => v === "on" || v === "1" || v === "true" || v === "yes";
    if (!on(ps.get("packSource"))) {
      reasons.push("?geomBundles=on requires ?packSource=on (SPEC §3 T13)");
    }
    if (ps.get("placementId") === "off") {
      reasons.push(
        "?placementId=off conflicts with baked setup frames (retail chain)"
      );
    }
  } catch (_) {
    reasons.push("URL parse failed");
  }
  const ctl =
    controller ||
    (typeof globalThis !== "undefined" && globalThis.__hbFetch
      ? globalThis.__hbFetch
      : null);
  const ctlArmed = !!(ctl && (ctl.enabled === true || ctl.armed === true));
  if (!ctlArmed) {
    reasons.push("pack controller not armed (legacy dist or ?packSource off)");
  }
  // RELIEF-IN-BAKE. Relief ON is a DISARM unless the relief-variant arm is
  // explicitly requested AND every one of its own legs holds — in which case
  // relief geometry comes from the bake and the pairing is coherent.
  const reliefOn = !!(
    typeof globalThis !== "undefined" &&
    globalThis.__hbGfxRelief &&
    globalThis.__hbGfxRelief.enabled === true
  );
  let wantRelief = false;
  if (reliefOn) {
    const reliefReasons = [];
    if (!reliefBundlesEnabled()) {
      reliefReasons.push(
        "?reliefBundles=on not authored (DEFAULT-OFF until the eye pair passes)"
      );
    }
    if (
      !wasmExports ||
      typeof wasmExports.assemble_model_geometry_relief !== "function"
    ) {
      reliefReasons.push(
        "wasm assemble_model_geometry_relief missing (stale pkg/ — rebuild wasm)"
      );
    }
    const lvl =
      (globalThis.__hbGfxRelief && globalThis.__hbGfxRelief.subdivLevel) | 0;
    if (lvl !== 0) {
      // The bake reproduces the material-identity RAILS the presets ship at
      // subdivLevel 0. Levels 1..5 are the per-texel displacement path, which
      // needs decoded surface height fields and is not bakeable — refuse to
      // pretend, rather than ship a level the dist does not carry.
      reliefReasons.push(
        `?gfxSubdivLevel=${lvl} has no baked variant (the bake carries level 0 rails)`
      );
    }
    if (reliefReasons.length > 0) {
      reasons.push(
        "gfxRelief is ON but the relief-variant arm is not available:\n      - " +
          reliefReasons.join("\n      - ")
      );
    } else {
      wantRelief = true;
    }
  }
  if (
    !wasmExports ||
    typeof wasmExports.assemble_model_geometry !== "function" ||
    typeof wasmExports.assemble_envcell_geometry !== "function"
  ) {
    reasons.push(
      "wasm assemble exports missing (stale pkg/ build — rebuild wasm)"
    );
  }
  if (reasons.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      "[geomBundles] flag ON but DISARMED (runtime decode in charge):\n  - " +
        reasons.join("\n  - ")
    );
    return false;
  }
  _state.wasmExports = wasmExports;
  _state.armed = true;
  _state.relief = wantRelief;
  _stats.relief.armed = wantRelief;
  if (wantRelief) {
    let rows = 0;
    try {
      if (typeof wasmExports.geom_relief_rows_resident === "function") {
        rows = wasmExports.geom_relief_rows_resident() | 0;
      }
    } catch (_) {}
    _stats.relief.variantRowsResident = rows;
    if (rows === 0) {
      // Never silent: the arm is live but this dist was baked without
      // `--geom-relief`, so every model reads its relief-free default.
      // eslint-disable-next-line no-console
      console.warn(
        "[geomBundles] relief variants armed but 0 GEOMR rows resident — " +
          "this dist was baked without --geom-relief; geometry will be relief-free"
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    "[geomBundles] armed — statics/buildings/anim-scenery/cells consume HBG1 bundles" +
      (wantRelief ? " (relief variants ON)" : "")
  );
  return true;
}

export function geomBundlesActive() {
  return _state.armed === true;
}

/** Counted never-silent fallback marker (S7 `geomFallback`). */
export function countGeomFallback(n) {
  _stats.geomFallback.modelsServedByRuntimeDecode += n | 0;
}

export function geomBundleStats() {
  return _stats;
}

// ---------------------------------------------------------------------------
// Bundle parsing
// ---------------------------------------------------------------------------

function _parseBundle(raw) {
  const buffer = raw.buffer; // Uint8Array, JS-owned (wasm copied out once)
  const descriptor = JSON.parse(raw.descriptor);
  return { buffer, descriptor };
}

function _perPolyCull(opts) {
  return (
    (opts && opts.perPolyCull) ||
    (typeof globalThis !== "undefined" && globalThis.__perPolyCull === true)
  );
}

/**
 * Shared attribute views over one model/cell entry's vertex region.
 * Layout (geom_bundles.rs): pos f32×3×V | normal f32×3×V | uv f32×2×V.
 */
function _entryAttributes(buffer, vtxOff, vtxCount, bakedOff) {
  const ab = buffer.buffer;
  const base = buffer.byteOffset + vtxOff;
  const position = new THREE.BufferAttribute(
    new Float32Array(ab, base, vtxCount * 3),
    3,
    false
  );
  const normal = new THREE.BufferAttribute(
    new Float32Array(ab, base + vtxCount * 12, vtxCount * 3),
    3,
    false
  );
  const uv = new THREE.BufferAttribute(
    new Float32Array(ab, base + vtxCount * 24, vtxCount * 2),
    2,
    false
  );
  let baked = null;
  if (typeof bakedOff === "number") {
    baked = new THREE.BufferAttribute(
      new Uint8Array(ab, buffer.byteOffset + bakedOff, vtxCount * 3),
      3,
      true // normalized, the acBakedLight contract (adapter.js RND-04)
    );
  }
  return { position, normal, uv, baked };
}

function _readIndex(buffer, idx, first, count) {
  const ab = buffer.buffer;
  const base = buffer.byteOffset + idx.off;
  if (idx.width === 2) {
    return new Uint16Array(ab, base + first * 2, count);
  }
  return new Uint32Array(ab, base + first * 4, count);
}

/**
 * Bucket subsets → groups mirroring `meshToGeometryGroups`:
 * default: by surface (doubleSided always true);
 * `?perPolyCull=on`: by (surface, subset doubleSided bit).
 * Returns `{ groups, surfaceDids, subsetStippled }`.
 *
 * `subsets` rows: `{ surfaceRef|surfaceDid, flags, firstIndex, indexCount }`
 * with flags bit0 = doubleSided, bit1 = stipple-wrap, bit2 = stipple-side.
 */
function _subsetsToGroups(buffer, entry, subsets, opts) {
  const perPolyCull = _perPolyCull(opts);
  const vtx = entry.vtx;
  const idx = entry.idx;
  const attrs = _entryAttributes(
    buffer,
    vtx.off,
    vtx.count,
    entry.baked ? entry.baked.off : undefined
  );

  // Per-surface stipple OR (the runtime accumulates per SURFACE across
  // sides — adapter.js RND-33 semantics).
  const stippleBySurface = new Map();
  for (const s of subsets) {
    const did = (s.surfaceDid !== undefined ? s.surfaceDid : s.surfaceRef) >>> 0;
    const bits = ((s.flags >> 1) & 0x3) | 0; // wrap | side → RND-33 bits 0/1
    stippleBySurface.set(did, (stippleBySurface.get(did) | 0) | bits);
  }

  // Bucket subset index ranges.
  const byKey = new Map();
  for (const s of subsets) {
    if ((s.indexCount | 0) === 0) continue;
    const did = (s.surfaceDid !== undefined ? s.surfaceDid : s.surfaceRef) >>> 0;
    const dbl = perPolyCull ? (s.flags & 0x1) === 0x1 : true;
    const key = perPolyCull ? `${did}|${dbl ? 1 : 0}` : `${did}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { did, dbl, ranges: [], total: 0 };
      byKey.set(key, bucket);
    }
    bucket.ranges.push([s.firstIndex | 0, s.indexCount | 0]);
    bucket.total += s.indexCount | 0;
  }

  const groups = [];
  const surfaceDids = [];
  for (const bucket of byKey.values()) {
    // Compact per-group index array (concat of subset ranges — small; the
    // vertex streams stay shared views, three keys VBOs by attribute).
    const IndexArr = idx.width === 2 && vtx.count <= 0xffff ? Uint16Array : Uint32Array;
    const groupIndex = new IndexArr(bucket.total);
    let w = 0;
    for (const [first, count] of bucket.ranges) {
      groupIndex.set(_readIndex(buffer, idx, first, count), w);
      w += count;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", attrs.position);
    geom.setAttribute("uv", attrs.uv);
    geom.setAttribute("normal", attrs.normal);
    if (attrs.baked) {
      geom.setAttribute("acBakedLight", attrs.baked);
    }
    geom.setIndex(new THREE.BufferAttribute(groupIndex, 1, false));
    geom.computeBoundingSphere();
    const surfaceDid = bucket.did;
    if (surfaceDid !== 0) surfaceDids.push(surfaceDid);
    groups.push({
      geometry: geom,
      surfaceDid,
      doubleSided: bucket.dbl,
      subsetStippled:
        surfaceDid !== 0 ? stippleBySurface.get(surfaceDid) | 0 : null,
    });
  }
  return { groups, surfaceDids, subsetStippled: null };
}

/**
 * Model entry → fused per-surface groups (the statics shape — one group per
 * unique surface across all parts, exactly what `meshToGeometryGroups`
 * produces over `fetch_model_meshes` output).
 */
export function bundleToGeometryGroups(entry, buffer, opts) {
  if (!entry || entry.missing || !entry.vtx || entry.vtx.count === 0) {
    return { groups: [], surfaceDids: [] };
  }
  return _subsetsToGroups(buffer, entry, entry.fused.subsets, opts);
}

/**
 * Model entry → per-part groups + hinge frames (the buildings /
 * animated-scenery shape: `bakeBuildingPlacement` parity — part geometry
 * carries the setup frame baked in; the hinge rides alongside).
 */
export function bundleToPartGroups(entry, buffer, opts) {
  if (!entry || entry.missing) return null;
  const parts = [];
  const surfaceDids = new Set();
  for (const p of entry.parts) {
    const r = _subsetsToGroups(buffer, entry, p.subsets, opts);
    for (const d of r.surfaceDids) surfaceDids.add(d >>> 0);
    const h = p.hinge; // [x, y, z, qw, qx, qy, qz]
    parts.push({
      partIndex: p.partIndex | 0,
      groups: r.groups,
      hinge: { x: h[0], y: h[1], z: h[2], qw: h[3], qx: h[4], qy: h[5], qz: h[6] },
    });
  }
  return { parts, surfaceDids };
}

/** Env cell entry → groups (resolved DIDs, acBakedLight attached). */
export function cellToGeometryGroups(cellEntry, buffer, opts) {
  if (!cellEntry || cellEntry.missing || !cellEntry.vtx || cellEntry.vtx.count === 0) {
    return null;
  }
  return _subsetsToGroups(buffer, cellEntry, cellEntry.subsets, opts);
}

// ---------------------------------------------------------------------------
// Assembly wrappers (stats + shape)
// ---------------------------------------------------------------------------

/**
 * Assemble a model batch. Returns
 * `{ byModel: Map<modelId, entry>, buffer, missingIds: number[] }` or `null`
 * when unarmed / the export throws (callers fall back to runtime decode).
 */
export function assembleModels(modelIds) {
  if (!_state.armed) return null;
  const t0 =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  let raw;
  try {
    const ids = new Uint32Array(modelIds);
    // RELIEF-IN-BAKE: the variant export reads each model's baked relief
    // payload when the dist carries one and its relief-free default
    // otherwise — that default IS the relief geometry for models the
    // profile leaves alone, so a mixed read is still a coherent world.
    raw = _state.relief
      ? _state.wasmExports.assemble_model_geometry_relief(ids)
      : _state.wasmExports.assemble_model_geometry(ids);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[geomBundles] assemble_model_geometry threw (runtime fallback):", e);
    return null;
  }
  const { buffer, descriptor } = _parseBundle(raw);
  const t1 =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  _stats.bundles.assembled += descriptor.assembled | 0;
  _stats.bundles.bytesOut += descriptor.bytes | 0;
  _stats.bundles.msAssemble += t1 - t0;
  if (_state.relief) _stats.relief.modelsAssembled += descriptor.assembled | 0;
  const byModel = new Map();
  const missingIds = [];
  for (const m of descriptor.models) {
    if (m.missing) {
      missingIds.push(m.id >>> 0);
    } else {
      byModel.set(m.id >>> 0, m);
    }
  }
  return { byModel, buffer, missingIds };
}

/**
 * Assemble the cells of one landblock. Returns
 * `{ byCell: Map<cellId, entry>, buffer, missingIds }` or `null`.
 */
export function assembleEnvcells(landblockId, cellIds) {
  if (!_state.armed) return null;
  const t0 =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  let raw;
  try {
    raw = _state.wasmExports.assemble_envcell_geometry(
      landblockId >>> 0,
      new Uint32Array(cellIds)
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[geomBundles] assemble_envcell_geometry threw (runtime fallback):", e);
    return null;
  }
  const { buffer, descriptor } = _parseBundle(raw);
  const t1 =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  _stats.bundles.assembled += descriptor.assembled | 0;
  _stats.bundles.bytesOut += descriptor.bytes | 0;
  _stats.bundles.msAssemble += t1 - t0;
  const byCell = new Map();
  const missingIds = [];
  for (const c of descriptor.cells) {
    if (c.missing) {
      missingIds.push(c.cellId >>> 0);
    } else {
      byCell.set(c.cellId >>> 0, c);
    }
  }
  return { byCell, buffer, missingIds };
}

// Test seam: node suites arm the module without a browser.
export function _testArm(wasmExports, opts) {
  _state.armed = true;
  _state.wasmExports = wasmExports;
  _state.relief = !!(opts && opts.relief);
  _stats.relief.armed = _state.relief;
  _installDiag();
}
export function _testDisarm() {
  _state.armed = false;
  _state.wasmExports = null;
  _state.relief = false;
  _stats.relief.armed = false;
}
