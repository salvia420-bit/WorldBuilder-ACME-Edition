// scene3d/terrain_obsidian.js — OBSIDIAN GLASS terrain VFX (2026-10-23).
//
// THE SPLIT. The owner, on the 1070 (2026-10-23): "we have obsidian plains and
// dark isles texture mixed up with lava, should make new effect for obsidian".
// Terrain code 6 (`ObsidianPlain`, RenderSurface texture 0x06006D56: dark
// purple mottled volcanic glass, NO lava; 2430 landblocks — the Obsidian
// Plains, the Dark Isles and the 0xC8ED "volcano" spot, which is 100 % code 6)
// used to be a member of FAM_VOLCANO and so drew the lava crack glow, ember
// vents and the heat-shimmer disc. It is now its own family, FAM_OBSIDIAN
// (`terrain_families.js`), with its own effect and its own master flag.
//
// THE LOOK: volcanic glass. Sparse, sharp SUN GLINTS off conchoidal facets and
// a dark PURPLE SHEEN at grazing angles. NO glow, NO embers, NO shimmer.
//
// WHERE THE WORK IS. Both terms are ONE fragment block in the terrain shader
// (`terrain.js`, search `OBSIDIAN GLASS`), gated on FAM_OBSIDIAN read from
// `uVertexTypes` (plan trap T3), weighted by the bilinear `obsidianW`, sited
// after the cast shadows resolve (the glints are sunlight; the sheen is sky
// light) and bypassed on any water-touching cell. This module owns the code
// set, the flag surface, the live-tuning knobs and their per-frame push.
//
// WHY THE v1 OBSIDIAN TERM NEVER READ. Wave 2B gave code 6 a 220-exponent
// Blinn lobe on the 24 m MACRO normal plus a near-mirror env term scaled by the
// diurnal ambient (`uEnvIntensity`, ~0.1). Under the default chase camera at
// noon the half vector sits 20-45 degrees off a flat ground normal, so the lobe
// never lit; and the env term was a tenth of a whisper. The owner's noon stills
// of 0xC8ED show plain purple ground. The rework reaches the half vector with
// FACETS (hashed normals tilted up to ~55 degrees — the snow sparkle's lesson)
// and puts the sky reflection on a real glass Fresnel curve.
//
// INVARIANTS (plan §5). A HOST module, THREE-free and window-tolerant, so
// `test_terrain_obsidian.mjs` is pure node. It adds no light (§5.2 — every term
// is additive in the fragment), varies no program cache key (§5.4 — the block is
// part of the one terrain program, gated by a uniform), uses no `Math.random`
// (§5.5 — the facets are a hash of the world cell) and allocates nothing per
// frame (the override push walks preallocated arrays).
//
// FLAGS: `?terrainObsidian` — STRICT `=== "on"` opt-in, ships OFF (preset key
// `terrainObsidian` = `terrainMaster("obsidian", tier)`, ladder high/ultra,
// `TERRAIN_VFX_PROMOTED.obsidian = false` until the owner's live vistest).
// `?terrainVfx=off`, `?visual=off` and `?wireframe=1` kill it like every family.
// Live knobs: `window.__terrainObsidian.tune({...})` (see OBSIDIAN_KNOBS).

import { FAM_OBSIDIAN, TERRAIN_CODE_COUNT, familyForCode } from "./terrain_families.js";
import { registerTerrainVfx, unregisterTerrainVfx } from "./terrain_vfx.js";
import { terrainObsidianEnabled } from "./vfx_flags.js";

/** Provider id — also the `VFX_EFFECT_FLAGS` router row. */
export const OBSIDIAN_PROVIDER_ID = "terrain.obsidian";

/** `LandDefs::TerrainType::ObsidianPlain` — the retail enum value. Diagnostic
 *  and test anchor only; membership is the family LUT (`obsidianTerrainCodes`). */
export const TERRAIN_CODE_OBSIDIAN_PLAIN = 6;

/** The terrain codes that are FAM_OBSIDIAN, DERIVED from the family LUT. */
export function obsidianTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_OBSIDIAN) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function obsidianCodeBitmask() {
  let mask = 0;
  for (const c of obsidianTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

// ---------------------------------------------------------------------------
// Live uniform overrides — shared with `terrain_volcano.js` (crack glow knobs).
//
// WHY A PUSH. `terrain_batch.js` builds the batched terrain material by CLONING
// every uniform value into a fresh `{value}` object, and every landblock bake
// makes a new material from `terrain.js`'s DEFAULT_* constants. So a knob that
// wrote the uniforms once would miss both the batched path's future rebuilds
// and every landblock that streams in later. Instead the override is recorded
// and re-written onto `scene3d.terrainMaterials` (which carries the batched
// material too) once per frame — and ONLY while an override exists, so the
// default session pays one length test per frame.
//
// RESTORE (2026-10-24 verify pass). `set(null)` must put the look BACK, not
// just stop pushing: the vistest checklist resets with `tune(null)`, and the
// resident landblock materials plus the long-lived batched material would
// otherwise keep the last override (e.g. `day: 1`) for the rest of the
// session. So the material's own value of each uniform is captured off the
// first material that binds it, BEFORE the first override write (the
// `terrain_dirt.js` print-seed idiom), and `set(null)` queues those defaults
// for one write-back on the next push. `reset()` drops everything with no
// write-back (test seams only).
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, {uniform:string, size:1|2|3, min:number, max:number}>} knobs
 *   knob name → the terrain uniform it drives, its component count, and the
 *   clamp applied to every component.
 */
export function createUniformOverrides(knobs) {
  const names = [];      // uniform names with a live override
  const sizes = [];      // component count per entry
  const values = [];     // flat: 3 slots per entry (unused slots 0)
  const base = [];       // flat: the material's own (default) value per entry
  const baseHave = [];   // per entry: `base` captured yet?
  // A pending write-back of the defaults (queued by set(null)).
  const restoreNames = [];
  const restoreSizes = [];
  const restoreVals = [];  // flat: 3 slots per entry
  const state = { version: 0, pushes: 0, restores: 0 };

  function _clamp(k, v) {
    const spec = knobs[k];
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(spec.max, Math.max(spec.min, n));
  }

  // Copy a uniform slot's value into `arr` at `b` (3 slots). False when the
  // slot holds nothing usable (it is then not a baseline).
  function _read(slot, size, arr, b) {
    if (size === 1) {
      const n = Number(slot.value);
      if (!Number.isFinite(n)) return false;
      arr[b] = n; arr[b + 1] = 0; arr[b + 2] = 0;
      return true;
    }
    const v = slot.value;
    if (!v || typeof v !== "object" || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return false;
    arr[b] = v.x; arr[b + 1] = v.y; arr[b + 2] = size === 3 && Number.isFinite(v.z) ? v.z : 0;
    return true;
  }

  // Write `arr[b..]` into a uniform slot. Zero-alloc.
  function _write(slot, size, arr, b) {
    if (size === 1) {
      slot.value = arr[b];
    } else if (slot.value && typeof slot.value === "object") {
      slot.value.x = arr[b];
      slot.value.y = arr[b + 1];
      if (size === 3) slot.value.z = arr[b + 2];
    }
  }

  function set(patch) {
    if (patch === null) {
      // Queue the captured defaults for one write-back. An entry whose
      // baseline was never captured never reached a material: nothing to undo.
      for (let e = 0; e < names.length; e += 1) {
        if (!baseHave[e] || restoreNames.indexOf(names[e]) >= 0) continue;
        restoreNames.push(names[e]);
        restoreSizes.push(sizes[e]);
        restoreVals.push(base[e * 3], base[e * 3 + 1], base[e * 3 + 2]);
      }
      names.length = 0; sizes.length = 0; values.length = 0;
      base.length = 0; baseHave.length = 0;
      state.version += 1;
      return current();
    }
    if (!patch || typeof patch !== "object") return current();
    for (const k of Object.keys(knobs)) {
      if (!(k in patch)) continue;
      const spec = knobs[k];
      const raw = patch[k];
      const comps = spec.size === 1 ? [raw] : (Array.isArray(raw) ? raw : null);
      if (!comps || comps.length < spec.size) continue;
      const vals = [];
      let ok = true;
      for (let i = 0; i < spec.size; i += 1) {
        const c = _clamp(k, comps[i]);
        if (c === null) { ok = false; break; }
        vals.push(c);
      }
      if (!ok) continue;
      let at = names.indexOf(spec.uniform);
      if (at < 0) {
        at = names.length;
        names.push(spec.uniform);
        sizes.push(spec.size);
        values.push(0, 0, 0);
        base.push(0, 0, 0);
        baseHave.push(false);
        // Re-overridden before a queued write-back ran: the materials still
        // hold the OLD override, so take the queued default as the baseline.
        const r = restoreNames.indexOf(spec.uniform);
        if (r >= 0) {
          for (let i = 0; i < 3; i += 1) base[at * 3 + i] = restoreVals[r * 3 + i];
          baseHave[at] = true;
          restoreNames.splice(r, 1);
          restoreSizes.splice(r, 1);
          restoreVals.splice(r * 3, 3);
        }
      }
      for (let i = 0; i < 3; i += 1) values[at * 3 + i] = i < vals.length ? vals[i] : 0;
    }
    state.version += 1;
    return current();
  }

  /** Write every override onto every material that has the uniform (after
   *  capturing any default not yet seen, and running a queued write-back).
   *  Zero-alloc. */
  function push(materials) {
    if ((names.length === 0 && restoreNames.length === 0) || !materials) return 0;
    let writes = 0;
    // 1. Capture each new entry's default BEFORE anything overwrites it.
    for (let e = 0; e < names.length; e += 1) {
      if (baseHave[e]) continue;
      for (let m = 0; m < materials.length; m += 1) {
        const u = materials[m] && materials[m].uniforms;
        const slot = u && u[names[e]];
        if (slot && _read(slot, sizes[e], base, e * 3)) { baseHave[e] = true; break; }
      }
    }
    // 2. A queued write-back of the defaults (set(null)), exactly once.
    if (restoreNames.length > 0) {
      for (let m = 0; m < materials.length; m += 1) {
        const u = materials[m] && materials[m].uniforms;
        if (!u) continue;
        for (let r = 0; r < restoreNames.length; r += 1) {
          const slot = u[restoreNames[r]];
          if (!slot) continue;
          _write(slot, restoreSizes[r], restoreVals, r * 3);
          writes += 1;
        }
      }
      restoreNames.length = 0; restoreSizes.length = 0; restoreVals.length = 0;
      state.restores += 1;
    }
    // 3. The live overrides.
    for (let m = 0; m < materials.length; m += 1) {
      const u = materials[m] && materials[m].uniforms;
      if (!u) continue;
      for (let e = 0; e < names.length; e += 1) {
        const slot = u[names[e]];
        if (!slot) continue;
        _write(slot, sizes[e], values, e * 3);
        writes += 1;
      }
    }
    state.pushes += 1;
    return writes;
  }

  /** Drop every override AND any queued write-back (test seams only). */
  function reset() {
    names.length = 0; sizes.length = 0; values.length = 0;
    base.length = 0; baseHave.length = 0;
    restoreNames.length = 0; restoreSizes.length = 0; restoreVals.length = 0;
    state.version += 1;
  }

  /** The live overrides, keyed by KNOB name (allocates — diagnostics only). */
  function current() {
    const out = {};
    for (const k of Object.keys(knobs)) {
      const at = names.indexOf(knobs[k].uniform);
      if (at < 0) continue;
      out[k] = knobs[k].size === 1
        ? values[at * 3]
        : values.slice(at * 3, at * 3 + knobs[k].size);
    }
    return out;
  }

  return {
    set,
    push,
    current,
    reset,
    get size() { return names.length; },
    /** Anything to push this frame: a live override or a queued write-back. */
    get active() { return names.length > 0 || restoreNames.length > 0; },
    get version() { return state.version; },
    get pushes() { return state.pushes; },
    get restores() { return state.restores; },
  };
}

/** `window.__terrainObsidian.tune({...})` knobs → the terrain.js uniforms. The
 *  defaults live in terrain.js (`DEFAULT_OBSIDIAN_*`); these are the clamps. */
export const OBSIDIAN_KNOBS = Object.freeze({
  enabled: Object.freeze({ uniform: "uObsidianEnabled", size: 1, min: 0, max: 1 }),
  glint: Object.freeze({ uniform: "uObsidianGlint", size: 1, min: 0, max: 64 }),
  glintDensity: Object.freeze({ uniform: "uObsidianGlintDensity", size: 1, min: 0.1, max: 12 }),
  glintFrac: Object.freeze({ uniform: "uObsidianGlintFrac", size: 1, min: 0, max: 1 }),
  glintSharpness: Object.freeze({ uniform: "uObsidianGlintSharpness", size: 1, min: 4, max: 4000 }),
  glintCorePx: Object.freeze({ uniform: "uObsidianGlintCorePx", size: 1, min: 0.25, max: 8 }),
  glintFade: Object.freeze({ uniform: "uObsidianGlintFade", size: 2, min: 0, max: 4000 }),
  sheen: Object.freeze({ uniform: "uObsidianSheen", size: 1, min: 0, max: 4 }),
  sheenColor: Object.freeze({ uniform: "uObsidianSheenColor", size: 3, min: 0, max: 4 }),
  sheenFade: Object.freeze({ uniform: "uObsidianSheenFade", size: 2, min: 0, max: 8000 }),
});

// ---------------------------------------------------------------------------
// Module state + the provider.
// ---------------------------------------------------------------------------

let _obs = null;

const _stats = {
  inits: 0,
  frames: 0,
  overridePushes: 0,
  overrideWrites: 0,
};

const _overrides = createUniformOverrides(OBSIDIAN_KNOBS);

function _terrainMaterials(frameCtx) {
  try {
    const s = (frameCtx && frameCtx.scene3d) || (_obs && _obs.scene3d);
    if (s && Array.isArray(s.terrainMaterials)) return s.terrainMaterials;
    if (typeof window !== "undefined" && Array.isArray(window.liveScene3d?.terrainMaterials)) {
      return window.liveScene3d.terrainMaterials;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

function _pushOverrides(frameCtx) {
  if (!_overrides.active) return;
  const mats = _terrainMaterials(frameCtx);
  if (!mats) return;
  _stats.overrideWrites += _overrides.push(mats);
  _stats.overridePushes += 1;
}

function _provider() {
  return {
    id: OBSIDIAN_PROVIDER_ID,
    // Camera scope: the effect is a shader term with no per-landblock state, so
    // the provider needs no landblock callbacks — it only re-asserts the live
    // knob overrides each frame (a no-op with none set).
    scope: "camera",
    families: [FAM_OBSIDIAN],
    enabled() { return terrainObsidianEnabled(); },
    update(dt, frameCtx) {
      _stats.frames += 1;
      _pushOverrides(frameCtx);
    },
    dispose() {},
  };
}

/**
 * Construct + register the OBSIDIAN family. Called once from `scene3d/index.js`
 * next to `initTerrainVolcano`. Returns `null` — registering nothing,
 * allocating nothing — unless `?terrainObsidian=on` (or the promoted tier), so
 * a bare-default boot is byte-identical. The shader block itself is gated by
 * `uObsidianEnabled`, composed in `terrain.js::resolveTerrainRingOpts` from the
 * same reader, so it does not depend on this registration.
 *
 * @param {{scene3d?:object}} [opts]
 */
export function initTerrainObsidian(opts = {}) {
  if (!terrainObsidianEnabled()) return null;
  if (_obs) return terrainObsidianSurface();
  _obs = { scene3d: opts.scene3d || null, registered: null };
  _stats.inits += 1;
  _obs.registered = registerTerrainVfx(_provider());
  return terrainObsidianSurface();
}

/** Diagnostics — mirrored onto `window.__terrainObsidian` by `scene3d/index.js`. */
export function terrainObsidianStats() {
  return {
    enabled: terrainObsidianEnabled(),
    inited: !!_obs,
    obsidianCodes: obsidianTerrainCodes(),
    obsidianCodeMask: obsidianCodeBitmask(),
    overrides: _overrides.current(),
    counters: { ..._stats },
  };
}

/**
 * Live tuning for the 1070 vistest: `tune({glint: 9, sheen: 0.5})` records the
 * override, writes it onto every live terrain material now, and the provider
 * re-asserts it on every frame (so new landblocks and the batched material get
 * it too). `tune(null)` drops every override and writes the captured
 * defaults back onto every terrain material (a real reset, the batched
 * material included). Returns the live override set.
 */
export function tuneTerrainObsidian(patch) {
  const out = _overrides.set(patch);
  _pushOverrides(null);
  return out;
}

function terrainObsidianSurface() {
  return {
    stats: terrainObsidianStats,
    tune: tuneTerrainObsidian,
    knobs: Object.keys(OBSIDIAN_KNOBS),
  };
}

/** Test seam — unregister the provider and drop all state. */
export function _resetTerrainObsidian() {
  if (_obs && _obs.registered) {
    try { unregisterTerrainVfx(_obs.registered.id); } catch (_) {}
  }
  _obs = null;
  _overrides.reset();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
