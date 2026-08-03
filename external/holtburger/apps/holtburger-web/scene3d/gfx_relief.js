// scene3d/gfx_relief.js — geometry-relief flag resolution + wasm hand-off.
//
// WHAT THIS GATES
// ---------------
// The Rust decode (`crates/holtburger-dat/src/gfx_subdiv.rs`, driven from
// `apps/holtburger-web/src/lib.rs`) subdivides world model meshes and displaces
// the resulting vertices OUTWARD ALONG THEIR NORMALS so Tudor timber protrudes
// and brick coursing juts out. The displacement is BAKED INTO `position` inside
// the decode — deliberately NOT a custom vertex attribute and NOT a material
// patch:
//
//   * `static_atlas.js::normalizeForMerge` (:449-459) DELETES every attribute
//     that is not {position, normal, uv} before a geometry enters a bucket, and
//     `makeArrayMaterial` (:730) REPLACES the node's material outright. That is
//     exactly how POM ended up rendering nothing on atlased statics.
//   * `position` and `normal`, by contrast, are copied verbatim through every
//     consumer (see the audit block at the bottom of this file).
//
// So relief lives in the position buffer, where the atlas cannot lose it.
//
// GEOMETRY IS SHARED PER DISTINCT MODEL (dedupe ~54.9x), so the vertex-count
// cost is paid once per model, not per placement — but it IS paid in full by
// the shadow depth pass, which reads the same buffer (see `?gfxRelief` notes in
// docs/url-flags.md).
//
// READER SEMANTICS — the master flag is a STRICT `=== "on"` opt-in.
// docs/url-flags.md warns (2026-07-23 + 2026-07-27 audit boxes) that the
// `!== "off"` idiom silently reads ON when the param is absent or misspelled.
// 20 flags shipped live that way by accident. `gfxRelief` therefore enables
// ONLY on the exact string "on"; every other value, including "1"/"true"/"yes",
// leaves it at the quality preset's value (true on mid/high/ultra since
// 2026-07-30; false on low).
//
// ONE RESOLUTION, TWO WASM INSTANCES. The bake worker owns its OWN wasm
// instance (`bake_worker.js`), so it must be told the same numbers or the same
// model decodes with relief on one thread and flat on the other depending on
// which instance happened to bake it. We do NOT re-resolve in the worker (its
// `getQuality()` would have no GPU probe and could land on a different tier) —
// index.html stashes the resolved config on `globalThis.__hbGfxRelief` and
// `bake_worker_client.js` rides it through the `init` message, exactly like
// `__hbShardBudgetBytes` / `__hbDecodeAdmissionWorker`.
//
// Node/worker safe: no top-level `window`, `document` or `localStorage` access.

import { getQuality } from "./quality.js";

/** Hard clamps. `subdivLevel` 0 = none, 1 = 4x tris, 2 = 16x tris. */
export const GFX_SUBDIV_MIN = 0;
export // 5 = 32 segments per edge (1,024 tris per source tri). Needed because
// town buildings have a median source edge of 1.16-2.50 m while brick
// coursing is ~10-15 cm — below ~16 segments a mortar line cannot exist
// as geometry at all. The Rust side clamps to the same ceiling.
const GFX_SUBDIV_MAX = 5;
export const GFX_RELIEF_SCALE_MIN = 0;
export const GFX_RELIEF_SCALE_MAX = 2;

/** Values used when nothing at all resolves (no preset, no URL). */
export const GFX_RELIEF_FALLBACK = Object.freeze({
  gfxRelief: false,
  gfxSubdivLevel: 1,
  gfxReliefScale: 1.0,
});

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function clampFloat(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function searchParamsOf(search) {
  try {
    if (search instanceof URLSearchParams) return search;
    if (typeof search === "string") return new URLSearchParams(search);
    if (typeof globalThis !== "undefined" && globalThis.location) {
      return new URLSearchParams(globalThis.location.search || "");
    }
  } catch (_) {
    /* fall through */
  }
  return new URLSearchParams("");
}

/**
 * Resolve the three relief knobs from (URL > quality preset > fallback).
 *
 * @param {string|URLSearchParams} [search]  query string; defaults to
 *        `globalThis.location.search`. Pass explicitly from a worker.
 * @param {object} [presetFlags]  a `getQuality().flags` bag. Omitted ⇒ this
 *        function calls `getQuality()` itself (which runs the 1x1 throwaway
 *        GPU probe and releases it — see quality.js `detectGpuTier`).
 * @returns {{enabled:boolean, subdivLevel:number, scale:number,
 *            requestedSubdivLevel:number, preset:string|null,
 *            source:{enabled:string, subdivLevel:string, scale:string}}}
 */
export function resolveGfxRelief(search, presetFlags) {
  const params = searchParamsOf(search);

  let preset = null;
  let flags = presetFlags;
  if (!flags) {
    try {
      const q = getQuality(
        typeof globalThis !== "undefined" && globalThis.location
          ? globalThis.location.href
          : null,
      );
      flags = q.flags;
      preset = q.preset;
    } catch (_) {
      flags = null;
    }
  }
  const base = {
    ...GFX_RELIEF_FALLBACK,
    ...(flags && typeof flags === "object" ? flags : {}),
  };

  // --- master flag: STRICT exact-match opt-in (never `!== "off"`). ---
  // (`params` is the URLSearchParams built by `searchParamsOf` above — named
  // here so scripts/lint-url-flags.mjs's ±10-line context sweep sees it.)
  const rawMaster = params.get("gfxRelief");
  let enabled;
  let enabledSource;
  if (rawMaster === "on") {
    enabled = true;
    enabledSource = "url";
  } else if (rawMaster === "off") {
    enabled = false;
    enabledSource = "url";
  } else {
    enabled = base.gfxRelief === true;
    enabledSource = flags ? "preset" : "fallback";
    if (rawMaster !== null) {
      // A value we do not recognise must NOT be read as "on" — say so loudly,
      // because a silent no-op here looks exactly like a broken Rust decode.
      // eslint-disable-next-line no-console
      console.warn(
        `[gfxRelief] ignoring ?gfxRelief=${JSON.stringify(rawMaster)} — the master flag is an EXACT-match opt-in; use ?gfxRelief=on (or =off).`,
      );
    }
  }

  // --- subdivision level: 0 | 1 | 2 --- (URLSearchParams read; see above)
  let subdivLevel = clampInt(
    Number.parseInt(params.get("gfxSubdivLevel") ?? "", 10),
    GFX_SUBDIV_MIN,
    GFX_SUBDIV_MAX,
  );
  let subdivSource = "url";
  if (subdivLevel === null) {
    subdivLevel =
      clampInt(base.gfxSubdivLevel, GFX_SUBDIV_MIN, GFX_SUBDIV_MAX) ??
      GFX_RELIEF_FALLBACK.gfxSubdivLevel;
    subdivSource = flags ? "preset" : "fallback";
  }

  // --- displacement amplitude multiplier, clamped [0, 2] --- (URLSearchParams)
  let scale = clampFloat(
    Number.parseFloat(params.get("gfxReliefScale") ?? ""),
    GFX_RELIEF_SCALE_MIN,
    GFX_RELIEF_SCALE_MAX,
  );
  let scaleSource = "url";
  if (scale === null) {
    scale =
      clampFloat(base.gfxReliefScale, GFX_RELIEF_SCALE_MIN, GFX_RELIEF_SCALE_MAX) ??
      GFX_RELIEF_FALLBACK.gfxReliefScale;
    scaleSource = flags ? "preset" : "fallback";
  }

  // Defence in depth: with the master flag off we hand the wasm a level of 0
  // and an amplitude of 0 as well, so a Rust build that ever forgets to honour
  // `enabled` still cannot subdivide or displace anything.
  return {
    enabled,
    subdivLevel: enabled ? subdivLevel : 0,
    scale: enabled ? scale : 0,
    requestedSubdivLevel: subdivLevel,
    requestedScale: scale,
    preset,
    source: { enabled: enabledSource, subdivLevel: subdivSource, scale: scaleSource },
  };
}

// Module-level memo so the page, the worker hand-off and `window.__diag` all
// report the SAME numbers, and so `getQuality()`'s GPU probe runs once.
let _resolved = null;

/** Resolve once and memoize. `force` re-resolves (tests only). */
export function getGfxRelief(search, presetFlags, force) {
  if (_resolved && !force) return _resolved;
  _resolved = resolveGfxRelief(search, presetFlags);
  return _resolved;
}

/** Test seam — drop the memo. */
export function _resetGfxReliefForTest() {
  _resolved = null;
}

/**
 * Push the resolved config into ONE wasm instance.
 *
 * MUST be called after the module's `init()` and BEFORE `init_resource_source`
 * / any `fetch_model_meshes`: the Rust triangulation memo is decode-once per
 * wasm instance (perf-maintainability, 2026-07-01), so a late flip would leave
 * already-decoded models flat while later ones get relief.
 *
 * Soft-degrades on a stale `pkg/` (the export simply is not there yet) — that
 * is the house `typeof fn === "function"` guard, and it is why `?gfxRelief=on`
 * on an un-rebuilt wasm renders flat with a warn rather than throwing.
 *
 * @param {object} wasmNs   the wasm module namespace (`__hbWasmNs` / the
 *                          worker's `* as __wasmNs`).
 * @param {object} cfg      a `resolveGfxRelief()` result.
 * @param {string} [label]  "main" | "bake-worker" — log prefix only.
 * @returns {boolean} true when the wasm actually took the values.
 */
export function applyGfxReliefToWasm(wasmNs, cfg, label = "main") {
  // A missing config resolves to an explicit, RESOLVED-SHAPE off.
  //
  // NOT `GFX_RELIEF_FALLBACK` (2026-08-03): that constant is the PRESET-FLAGS
  // bag — `{gfxRelief, gfxSubdivLevel, gfxReliefScale}` — while every read
  // below is on the RESOLVER's output shape, `{enabled, subdivLevel, scale}`.
  // Using it as the fallback made all three reads `undefined`, so the wasm got
  // `fn(false, 0, NaN)`; the stale-`pkg/` `console.error` was suppressed
  // (`c.enabled` undefined is falsy); and because the constant is FROZEN, the
  // `applied` stamp — described three lines down as "the only record that a
  // headless assert can distinguish 'flag on, wasm took it' from 'flag on,
  // stale pkg/'" — was skipped entirely. Latent, because both live callers
  // pass a real config and `bake_worker.js:159` hand-spreads exactly the shape
  // built here to dodge the bug; it no longer has to.
  const c = (cfg && typeof cfg === "object")
    ? cfg
    : { ...GFX_RELIEF_FALLBACK, enabled: false, subdivLevel: 0, scale: 0 };
  const fn = wasmNs && wasmNs.set_gfx_relief;
  // Stamp the outcome onto the config object itself — `window.__hbWasmNs` is
  // module-scoped in index.html and never reaches `window`, so the diag reader
  // cannot re-probe the export. This is the only record that a headless
  // assert can distinguish "flag on, wasm took it" from "flag on, stale pkg/".
  // `Object.isFrozen` guard: `GFX_RELIEF_FALLBACK` is frozen and modules run in
  // strict mode, where assigning to a frozen object THROWS.
  if (c && typeof c === "object" && !Object.isFrozen(c)) {
    c.applied = c.applied || {};
    c.applied[label] = { wasmExportPresent: typeof fn === "function", ok: false };
  }
  if (typeof fn !== "function") {
    if (c.enabled) {
      // eslint-disable-next-line no-console
      console.error(
        `[gfxRelief:${label}] ?gfxRelief=on but the wasm export \`set_gfx_relief\` is MISSING — stale pkg/ build. ` +
          "Rebuild (capped-build wasm-pack build --target web --out-dir pkg --release). Rendering FLAT.",
      );
    }
    return false;
  }
  try {
    // NEVER hand the wasm a NaN. `c.subdivLevel >>> 0` already coerces junk to
    // 0, but `Number(undefined)` is NaN — and a NaN amplitude reaches the Rust
    // `f32` as a NaN, which would multiply every displaced vertex position into
    // one. Belt to the braces above: this holds even for a config shaped wrong
    // in a way the fallback cannot detect (e.g. the preset bag passed by hand).
    const scale = Number(c.scale);
    fn(!!c.enabled, c.subdivLevel >>> 0, Number.isFinite(scale) ? scale : 0);
    if (c && c.applied && c.applied[label]) c.applied[label].ok = true;
    // eslint-disable-next-line no-console
    console.log(
      `[gfxRelief:${label}] enabled=${!!c.enabled} subdivLevel=${c.subdivLevel} scale=${c.scale}` +
        (c.preset ? ` (preset=${c.preset})` : "") +
        ` source=${JSON.stringify(c.source ?? {})}`,
    );
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[gfxRelief:${label}] set_gfx_relief threw (non-fatal, rendering FLAT):`, e);
    return false;
  }
}

/**
 * Install `window.__gfxRelief` — the primary readback, available from the
 * moment the wasm initialises (long before `init3D` installs `__diag`).
 *
 * The `__diag.gfxRelief` mirror below only fires if `__diag` already exists;
 * at boot it does not, so treat `__diag.geometry.relief()` as THE diag entry
 * point — it reads `window.__gfxRelief` + the worker ack and is installed by
 * `diag/geometry.js::attachGeometry`. Idempotent.
 */
export function installGfxReliefOnWindow(cfg) {
  if (typeof window === "undefined") return cfg;
  window.__gfxRelief = cfg;
  try {
    if (window.__diag) window.__diag.gfxRelief = cfg;
  } catch (_) {
    /* diagnostics never block boot */
  }
  return cfg;
}

// ===========================================================================
// AUDIT — where displaced `position` values survive (verified in-file
// 2026-07-30). Anything added to this list must copy positions VERBATIM.
//
//   decode → adapter:
//     adapter.js:946-948 meshToGeometryGroups   — per-vertex copy, no re-derive
//     adapter.js:1024    meshToFusedGeometry    — Float32Array.from, verbatim
//     bake_transfer.js:138 serializeModelMeshes — zero-copy transferable
//   singleton statics:
//     statics.js:841/1025 groups → THREE.Mesh, geometry handed through
//   statics atlas (default-ON, `?statAtlas`):
//     static_atlas.js:449 normalizeForMerge — toNonIndexed()+clone, position
//                         and normal KEPT (only NON-{pos,nrm,uv} deleted)
//     static_atlas.js:919/927 addGeometry into the bucket BatchedMesh
//   per-LB static batch (`?staticBatch`):
//     statics.js:1729    bm.addGeometry(m.geometry)
//   buildings:
//     buildings.js:531   new THREE.Mesh(g.geometry, mat)
//   EnvCell / interiors:
//     cells.js:321/907   mergedPos.set(src.attributes.position.array, …)
//
// The ONLY `computeVertexNormals()` in the whole scene3d tree is
// adapter.js:335, inside `landblockMeshToGeometry` — the legacy 9x9 TERRAIN
// heightfield, which never sees a model mesh. Every model/static/building/cell
// path uses the authored `SWVertex.normal` from the DAT verbatim (adapter.js
// :951-953, :1029). There is NO `normalizeNormals`, no re-centering, no
// quantisation and no geometry compression anywhere on these paths. All
// `computeBoundingSphere()` calls are derived-from-position and compute-if-
// absent (adapter.js:986/1038, cells.js:335/916, statics.js:1465/3411/3445/
// 3472) — they read positions, never write them.
// ===========================================================================
