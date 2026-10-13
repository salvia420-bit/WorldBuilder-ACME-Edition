// scene3d/program_retention.js — keep every linked WebGLProgram for the session
// (render-perf-1, 2026-10-13). Default ON; `?programRetain=off` restores three's
// stock refcount lifetime.
//
// WHY. three r184 refcounts a WebGLProgram by the materials using it
// (WebGLPrograms acquireProgram / releaseProgram, three.module.js:7988-8025)
// and destroys it when the last one is disposed (`--usedTimes === 0` →
// swap-remove + gl.deleteProgram). The next material with the same cache key
// links it from scratch. This client disposes materials on steady-play paths:
// entity despawn (entities.js `_disposeMaterialIfOwned`), the paletted and VFX
// variant LRUs (materials.js), far-terrain patches and per-landblock terrain
// ShaderMaterials on evict, and every shadow-depth clone three mints for a
// disposed source material (WebGLShadowMap onMaterialDispose). Only the parked
// warm populations (bake_prewarm.js archetype warm, pool_prewarm.js) were kept
// alive, by never-disposed proxies. async_link_guard.js's `readySigs` shortcut
// ("a fingerprint seen linked is a program-cache hit", d===3 → draw at once)
// is only TRUE while that program survives; shadow-depth materials and
// unguarded ShaderMaterials always link synchronously on their first draw.
//
// WHAT. Once per rendered frame (index.js recordRenderDiag, the render tail all
// three paths share), give each program that appeared since the last call one
// extra reference (`usedTimes++`) and remember it in a WeakSet. usedTimes then
// never returns to 0, releaseProgram never destroys it, and acquireProgram
// finds it again by key. Nothing drawn changes: the program for a key is the
// one three would have linked for it anyway. Materials, textures and
// geometries are still freed by their owners; a WebGLProgram holds no
// material reference. After WebAC packages/renderer/src/scene/
// ProgramRetention.ts, AGPL-3.0.
//
// TWO HOLES THE WEBAC VERSION HAS, CLOSED HERE.
//   1. Context restore. three builds a NEW WebGLPrograms on restore and points
//      `info.programs` at its (new) array (three.module.js:16402). A
//      length-only change check can then skip new programs whose count happens
//      to equal the old one. We track the array OBJECT; a new array resets the
//      per-context state (the old programs are gone with the old context).
//   2. Stage-keyed programs. For a material with no built-in shaderID
//      (ShaderMaterial, RawShaderMaterial, any subclass with its own `type`),
//      getProgramCacheKey's first two fields are WebGLShaderStage ids
//      (three.module.js:7770-7779), and WebGLShaderCache.remove deletes a stage
//      when its last material is disposed (:7300-7312) — the next material
//      with the same source gets a NEW stage id (`this.id = _id ++`, :7375),
//      hence a new key. A retained program of a freed stage is never found
//      again: retaining it is a pure GPU leak. Those programs are left to
//      three's refcount unless their stage pair is PINNED (pinStagePair /
//      pinMaterialStages) by a caller that keeps one material with that exact
//      vertexShader + fragmentShader alive for the session (the parked-proxy
//      idiom), which keeps the stage ids — and so the keys — stable.
//
// BOUNDS. The distinct-key set is small by design (materials.js
// `_patchSetCacheKey` encodes patch SETS, never per-instance config), so the
// program count plateaus at the session's distinct keys. A soft cap
// (PROGRAM_RETAIN_CAP) stops retaining past that many programs: three exposes
// no public releaseProgram, so a retained program cannot be un-retained back
// into destruction — the cap is a "stop adding", not an LRU.
//
// COST. The per-frame call compares the array object, its length and its last
// element (three pushes new programs at the end) and returns. A full scan runs
// when that signature moves, and every PROGRAM_RETAIN_SWEEP_EVERY calls as a
// safety net: a program created and then swapped out of the tail by a release
// in the same window leaves the signature unchanged.
//
// DIAG. `window.__diag.programs` (live object, updated in place on each scan):
//   enabled, cap, retained, skippedShader, overCap, pinnedFamilies,
//   keysSeen, relinks, relinkedKeys, relinkedBy {name|type: n}, released,
//   scans, contextResets.
// `relinks` counts a newly appearing program whose cacheKey was already seen
// in this context — the number to drive to 0. It is measured with retention
// OFF too, so `?programRetain=off` is the A/B baseline. The precise per-key
// ledger is `?linkProbe=on` (shader_prewarm.js installLinkProbe).

/** Stop retaining past this many programs (soft cap; see BOUNDS above). */
export const PROGRAM_RETAIN_CAP = 1024;
/** Full rescan cadence in calls (~4 s at 60 fps) — the same-window safety net. */
export const PROGRAM_RETAIN_SWEEP_EVERY = 240;
/** Distinct `relinkedBy` labels kept before the rest fold into "(other)". */
const RELINKED_BY_LABELS = 64;

const SHADER_TYPES = new Set(["ShaderMaterial", "RawShaderMaterial"]);

/** Default ON; `?programRetain=off` (or 0 / false) keeps three's stock lifetime. */
export function programRetainEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("programRetain");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) {
    return true;
  }
}

function _keyOf(p) {
  const k = p.cacheKey;
  return typeof k === "string" ? k : String(k ?? "");
}

function _isDigits(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** "vs,fs" stage-id pair at the head of a stage-keyed cacheKey, or null for a
 *  built-in (shaderID-keyed: "physical,…", "depth,…") key. */
export function stagePairOf(cacheKey) {
  if (typeof cacheKey !== "string") return null;
  const a = cacheKey.indexOf(",");
  if (a < 0) return null;
  const b = cacheKey.indexOf(",", a + 1);
  const vs = cacheKey.slice(0, a);
  const fs = b < 0 ? cacheKey.slice(a + 1) : cacheKey.slice(a + 1, b);
  return _isDigits(vs) && _isDigits(fs) ? `${vs},${fs}` : null;
}

/** True when the program's key carries WebGLShaderStage ids (no built-in
 *  shaderID): ShaderMaterial / RawShaderMaterial and custom-type subclasses. */
export function isStageKeyed(p) {
  if (!p) return false;
  if (SHADER_TYPES.has(p.type)) return true;
  const key = _keyOf(p);
  const c = key.indexOf(",");
  return _isDigits(c < 0 ? key : key.slice(0, c));
}

/**
 * @param {{enabled?: boolean, cap?: number, sweepEvery?: number}} [opts]
 */
export function createProgramRetention(opts = {}) {
  const enabled = opts.enabled !== false;
  const cap = Number.isFinite(opts.cap) && opts.cap >= 0 ? Math.floor(opts.cap) : PROGRAM_RETAIN_CAP;
  const sweepEvery =
    Number.isFinite(opts.sweepEvery) && opts.sweepEvery >= 1 ? Math.floor(opts.sweepEvery) : PROGRAM_RETAIN_SWEEP_EVERY;

  const stats = {
    enabled,
    cap,
    retained: 0, // programs holding our extra reference (this context)
    skippedShader: 0, // stage-keyed programs left to three's refcount
    overCap: 0, // programs not retained because `cap` was reached
    pinnedFamilies: 0, // pinned "vs,fs" stage pairs (this context)
    keysSeen: 0, // distinct cacheKeys seen (this context)
    relinks: 0, // new programs whose key was seen before (cumulative)
    relinkedKeys: 0, // distinct keys relinked (this context)
    relinkedBy: Object.create(null), // material name || type → relinks (cumulative)
    released: 0, // programs that left info.programs (three destroyed them; cumulative)
    scans: 0,
    contextResets: 0,
  };

  // Per-context state — reset when three swaps in a new programs array.
  let lastArray = null;
  let lastLen = 0;
  let lastTail;
  let sinceSweep = 0;
  let seen = new WeakSet();
  let retained = new WeakSet();
  const keysSeen = new Set();
  const relinkedKeySet = new Set();
  const pins = new Set();
  let pinRescan = false;

  function _resetContext(progs) {
    const restored = lastArray !== null; // null = first adoption, not a restore
    lastArray = progs;
    lastLen = 0;
    lastTail = undefined;
    sinceSweep = 0;
    if (!restored) return;
    stats.contextResets += 1;
    seen = new WeakSet();
    retained = new WeakSet();
    keysSeen.clear();
    relinkedKeySet.clear();
    // Stage ids are reissued by the new context's shader cache: old pins can
    // never match again. The owner of a parked proxy re-pins after it recompiles.
    pins.clear();
    pinRescan = false;
    stats.retained = 0;
    stats.skippedShader = 0;
    stats.overCap = 0;
    stats.pinnedFamilies = 0;
    stats.keysSeen = 0;
    stats.relinkedKeys = 0;
  }

  function _retainable(p) {
    if (!isStageKeyed(p)) return true;
    const pair = stagePairOf(_keyOf(p));
    return pair !== null && pins.has(pair);
  }

  function _publish() {
    try {
      if (typeof window === "undefined") return;
      if (!window.__diag) window.__diag = {};
      if (window.__diag.programs !== stats) window.__diag.programs = stats;
    } catch (_) {
      /* a diagnostic must never break the frame */
    }
  }

  /**
   * Retain every program that appeared since the last call. Call once per
   * rendered frame, after the render. Returns how many were retained now.
   */
  function retainNew(renderer) {
    let progs = null;
    try {
      progs = renderer && renderer.info && renderer.info.programs;
    } catch (_) {
      progs = null;
    }
    if (!Array.isArray(progs)) return 0;
    let force = false;
    if (progs !== lastArray) {
      _resetContext(progs);
      force = true;
    }
    const n = progs.length;
    const tail = n > 0 ? progs[n - 1] : undefined;
    sinceSweep += 1;
    if (!force && !pinRescan && n === lastLen && tail === lastTail && sinceSweep < sweepEvery) return 0;
    sinceSweep = 0;
    stats.scans += 1;
    const rescan = pinRescan;
    pinRescan = false;
    let fresh = 0;
    let added = 0;
    for (let i = 0; i < n; i++) {
      const p = progs[i];
      if (!p || typeof p !== "object") continue;
      const isNew = !seen.has(p);
      if (isNew) {
        seen.add(p);
        fresh += 1;
        const key = _keyOf(p);
        if (keysSeen.has(key)) {
          stats.relinks += 1;
          if (!relinkedKeySet.has(key)) {
            relinkedKeySet.add(key);
            stats.relinkedKeys = relinkedKeySet.size;
          }
          // Material names can be per-instance (`far-terrain-${px}-${py}`,
          // `nameplate-${key}`): past RELINKED_BY_LABELS labels, fold into "(other)".
          let label = (typeof p.name === "string" && p.name) || (typeof p.type === "string" && p.type) || "?";
          const by = stats.relinkedBy;
          if (!(label in by) && Object.keys(by).length >= RELINKED_BY_LABELS) label = "(other)";
          by[label] = (by[label] || 0) + 1;
        } else {
          keysSeen.add(key);
          stats.keysSeen = keysSeen.size;
        }
      } else if (!rescan) {
        continue;
      }
      if (!enabled || retained.has(p)) continue;
      const stageKeyed = isStageKeyed(p);
      if (!_retainable(p)) {
        if (isNew) stats.skippedShader += 1;
        continue;
      }
      if (stats.retained >= cap) {
        if (isNew) stats.overCap += 1;
        continue;
      }
      if (typeof p.usedTimes !== "number" || p.usedTimes <= 0) continue; // already released: never resurrect
      p.usedTimes += 1; // the extra reference: releaseProgram can no longer reach 0
      retained.add(p);
      stats.retained += 1;
      added += 1;
      // A stage-keyed program seen before its pair was pinned was counted as skipped.
      if (!isNew && stageKeyed) stats.skippedShader -= 1;
    }
    // Every program in the array is now seen, so whatever was live last scan
    // plus what is new, minus what is live now, is what three destroyed.
    const gone = lastLen + fresh - n;
    if (gone > 0) stats.released += gone;
    lastLen = n;
    lastTail = tail;
    _publish();
    return added;
  }

  /** Pin a WebGLShaderStage id pair so programs keyed by it are retained. The
   *  caller MUST keep a material with that exact vertexShader+fragmentShader
   *  alive for the session (otherwise the stage ids are reissued and the
   *  retained programs become unreachable). Per context. */
  function pinStagePair(vertexStageId, fragmentStageId) {
    const vs = String(vertexStageId);
    const fs = String(fragmentStageId);
    if (!_isDigits(vs) || !_isDigits(fs)) return false;
    const pair = `${vs},${fs}`;
    if (!pins.has(pair)) {
      pins.add(pair);
      stats.pinnedFamilies = pins.size;
      pinRescan = true;
    }
    return true;
  }

  /** Pin the stage pair of an already-compiled, never-disposed (parked)
   *  material's current program. Returns false when it has no stage-keyed
   *  program yet (not compiled, or a built-in material). */
  function pinMaterialStages(renderer, material) {
    let mp = null;
    try {
      mp = renderer?.properties?.get?.(material) ?? null;
    } catch (_) {
      mp = null;
    }
    const p = mp && mp.currentProgram;
    const pair = p ? stagePairOf(_keyOf(p)) : null;
    if (!pair) return false;
    const c = pair.indexOf(",");
    return pinStagePair(pair.slice(0, c), pair.slice(c + 1));
  }

  return { retainNew, pinStagePair, pinMaterialStages, stats };
}

// ── Session singleton (the index.js render-tail hook) ─────────────────────────
let _session = null;

/** The session's retention controller (created on first use from the URL flag). */
export function getProgramRetention() {
  if (_session === null) _session = createProgramRetention({ enabled: programRetainEnabled() });
  return _session;
}

/** Render-tail hook: retain programs created since the last frame. Never throws. */
export function retainNewPrograms(renderer) {
  try {
    return getProgramRetention().retainNew(renderer);
  } catch (_) {
    return 0;
  }
}
