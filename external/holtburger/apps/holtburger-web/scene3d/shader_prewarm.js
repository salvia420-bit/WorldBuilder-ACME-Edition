// shader_prewarm.js (2026-08-01) — aim every shader warm at the COMPOSER's
// program variant, not the canvas one.
//
// three derives two program-cache-key axes from the render target BOUND AT
// COMPILE TIME (WebGLPrograms.getParameters, three r184 :7493/:7548/:7584):
//   null target  → renderer.toneMapping + outputColorSpace (sRGB) baked in
//   any non-null → NoToneMapping + working-color-space output
// The live world renders exclusively through the pmndrs EffectComposer into a
// HalfFloat inputBuffer (atmosphere_pipeline.js) — the NON-NULL variant. But
// every warm site (boot renderer.compile pass 1/2 in index.js, bake_prewarm's
// guardedCompileAsync and everything routed through it: world bakes, envcells,
// per-spawn rig warm, the archetype matrix) compiled with the CANVAS bound,
// warming programs the world passes never use. The 07-16 walk-stall profile
// (/mnt/wbterminal2/tmp/walk-stall-attrib.json, 1070) shows the result: 43
// programs force-linking mid-walk at 172-849 ms each, getProgramParameter =
// 32.9 % of in-stall self-time — the warms had "done" their job on the wrong
// variant. Same mechanism behind the ~22 s cold-load freeze (the 06-27
// finding: boot compile warms sRGB, composer needs the RT variant).
//
// `?shaderPrewarm=on` (exact-match opt-in per the url-flags.md idiom rule;
// default OFF pending the 1070 walk-stall A/B) binds a shared 1×1 HalfFloat
// dummy target around every renderer.compile. A dummy target is exactly
// equivalent for the program key — getParameters inspects only
// null-vs-non-null (and XR), never size/format — and unlike the composer's
// inputBuffer it exists before the atmosphere pipeline does, so no ordering
// or handle-plumbing is needed. Flag OFF = byte-identical legacy behaviour.
//
// NOTE the boot window: until the atmosphere pipeline is constructed the loop
// falls back to direct-to-canvas renderer.render (index.js ~1001), so
// materials drawn in that window still lazy-compile their canvas variant —
// unchanged from today. Once the composer exists, warmed == live.
// `?wireframe=1` never builds a composer (canvas variant IS live there);
// leave shaderPrewarm off in that mode.
//
// `?linkProbe=on` (independent flag — needed in BOTH arms of the A/B) wraps
// gl.linkProgram + gl.getProgramParameter to split three's cheap
// KHR_parallel_shader_compile COMPLETION_STATUS_KHR ready-polls from forced
// LINK_STATUS waits (the synchronous driver-link flush). Score the walk-stall
// re-run on `window.__linkProbe.summary()`. The same probe keeps a program
// create/release LEDGER (`__linkProbe.ledger()`, 2026-10-13) that names every
// key three links a second time — see installLinkProbe.

import * as THREE from "three";

function _optIn(name) {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return new URLSearchParams(globalThis.location.search).get(name) === "on";
    }
  } catch (_) {}
  return false;
}

/** True only for an explicit off-form. A typo keeps the default rather than
 *  silently disabling it — the same rule `?statBatchMemo` adopted, for the same
 *  reason: a mistyped flag must not cost a 2-second stall in silence. */
function _optOut(name) {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return ["off", "0", "false", "no"].includes(
        String(new URLSearchParams(globalThis.location.search).get(name) || "").toLowerCase());
    }
  } catch (_) {}
  return false;
}

/** `?shaderPrewarm=off` escapes; anything else (including absent) is ON.
 *
 * DEFAULT FLIPPED 2026-08-06 — this is the walk-stall A/B the flag row has been
 * waiting on since 08-05, run on the 1070 at `?quality=ultra&clouds=on&wxMap=nasa`
 * while moving, with `scene3d/stall_probe.js` armed:
 *
 *   shaderPrewarm=off   p50 49.4  p95 70.8  p99 97.9   MAX 2131 ms   >250ms 5   >1s 1
 *   shaderPrewarm=ON    p50 48.4  p95 67.9  p99 90.6   MAX  369 ms   >250ms 1   >1s 0
 *
 * Steady state barely moves, which is the point: this was never a throughput
 * problem. The stall probe attributed the worst frame outright —
 * `intervalMs 576.2, renderMs 576.1, outsideMs 0.1, linkPrograms 1` — a single
 * synchronous program link INSIDE `renderer.render`. A transcode or a bake would
 * have landed in `outsideMs`; those exist too but are a ~100 ms class
 * (`xu7DecodeMs 67.8` on a 101 ms frame), not the p99.
 *
 * ⚠ n=1 PER ARM on a rare-event metric. The mechanism is confirmed (the 07-16
 * profile in the header above measured 43 programs linking at 172-849 ms each on
 * this same GPU), but MAX and the >1s count are single observations and stalls
 * are sparse by nature — do not treat 2131 -> 369 as a tight bound.
 *
 * ⚠ COST NOT YET MEASURED: prewarming moves link work to boot. Cold-boot time
 * under this default has not been measured on the 1070. If boot regresses
 * materially, `?shaderPrewarm=off` is the one-flag revert.
 */
export const SHADER_PREWARM_ON = !_optOut("shaderPrewarm");
export const LINK_PROBE_ON = _optIn("linkProbe");

let _warmTarget = null;
function _getWarmTarget() {
  if (!_warmTarget) {
    _warmTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    _warmTarget.texture.name = "shader-prewarm-warm-target";
  }
  return _warmTarget;
}

/**
 * Run `fn` (a renderer.compile call) with the warm target bound so the
 * compiled programs carry the composer-path variant key. Restores the
 * previously bound target on every path. Flag OFF (or an unusable renderer)
 * → plain `fn()`, zero behaviour change.
 *
 * @template T
 * @param {any} renderer THREE.WebGLRenderer (or a mock in tests)
 * @param {() => T} fn
 * @returns {T}
 */
export function withWarmTarget(renderer, fn) {
  if (
    !SHADER_PREWARM_ON ||
    !renderer ||
    typeof renderer.setRenderTarget !== "function" ||
    typeof renderer.getRenderTarget !== "function"
  ) {
    return fn();
  }
  const prev = renderer.getRenderTarget();
  let bound = false;
  try {
    renderer.setRenderTarget(_getWarmTarget());
    bound = true;
  } catch (_) {
    /* fail-soft: warm proceeds on the canvas variant (legacy) */
  }
  try {
    return fn();
  } finally {
    if (bound) {
      try {
        renderer.setRenderTarget(prev);
      } catch (_) {}
    }
  }
}

// GL enum values, used only as fallbacks when the context/extension objects
// don't expose them (mocks): LINK_STATUS 0x8B82, COMPLETION_STATUS_KHR 0x91B1.
const _LINK_STATUS_FALLBACK = 0x8b82;
const _COMPLETION_STATUS_KHR = 0x91b1;

/** Program-ledger ring size (entries); the oldest entry drops past it. */
export const LINK_LEDGER_CAP = 2000;
/** Program-ledger diff cadence (ms). `installLinkProbe(r, {ledgerMs: 0})`
 *  turns the timer off — ticks then run only on read or via ledgerTick(). */
export const LINK_LEDGER_MS = 50;
/** cacheKey chars kept per ledger entry (a built-in key lists every program
 *  parameter, plus defines and customProgramCacheKey — it runs long). */
const _LEDGER_KEY_CHARS = 400;

/** 64-bit string hash (cyrb53 mixing, public domain) — relink identity is the
 *  FULL cacheKey (or, for a stage-keyed program, its GLSL; see
 *  _stageHeadEnd), but the ledger must not retain every released key's text
 *  to know it saw it once. */
function _keyHash(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Index just past the two WebGLShaderStage ids that head a STAGE-KEYED
 * cacheKey, or -1 for a built-in key ("physical,…", "depth,…").
 *
 * three r184 getProgramCacheKey pushes a built-in material's shaderID first,
 * but for a material with none (ShaderMaterial, RawShaderMaterial, a custom-
 * type subclass) it pushes customVertexShaderID + customFragmentShaderID
 * (three.module.js:7772-7779). Those are WebGLShaderStage ids (`_id ++`,
 * :7376), and WebGLShaderCache.remove deletes a stage once its last material
 * is disposed (:7301-7313; releaseMaterialProgramReferences calls it for every
 * ShaderMaterial, :17104-17106). The next material with the same source gets a
 * NEW id, so a real relink of such a program arrives under a NEW key. Same
 * test as program_retention.js stagePairOf (both leading fields all digits).
 */
function _stageHeadEnd(key) {
  const a = key.indexOf(",");
  if (a <= 0) return -1;
  let b = key.indexOf(",", a + 1);
  if (b < 0) b = key.length;
  if (b === a + 1) return -1;
  for (let i = 0; i < b; i++) {
    if (i === a) continue;
    const c = key.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
  }
  return b;
}

/**
 * Install the link-cost probe on the renderer's GL context (`?linkProbe=on`).
 * Idempotent per context. Returns the probe state ({stats, reset, summary})
 * or null when the flag is off / the context is unusable. Also published as
 * `window.__linkProbe`.
 *
 * `{ force: true }` (2026-08-06) bypasses the URL-flag gate for a caller that
 * has already decided it wants the probe. `stall_probe.js` uses it: the whole
 * point of arming that instrument is to price the LINK_STATUS bucket in ms, and
 * requiring the operator to also remember `&linkProbe=on` on a 1070 session
 * they only get to run once is a footgun, not a safety rail. Everything else
 * about the probe is unchanged — same wrap, same counters, same idempotence.
 *
 * PROGRAM LEDGER (2026-10-13). The counters above say how many links happened,
 * never WHICH key, and every other program count in the client
 * (`?renderDiag`, stall_probe, landblock_lru's eviction snapshot) is
 * `renderer.info.programs.length`. three destroys a WebGLProgram when the
 * last material holding its cache key is released (WebGLPrograms
 * releaseProgram, r184: `--usedTimes === 0` → swap-remove + destroy), and the
 * next material with that key links it AGAIN at first draw — a length can't
 * see that: a release and a create in one tick leave it unchanged. So the
 * probe also diffs `renderer.info.programs` BY `id` (three's programIdCount —
 * never reused) every LINK_LEDGER_MS and on every ledger read, logging
 * `{t, op:'+'|'-', id, name, type, key}` (key = first 400 chars of cacheKey)
 * into a LINK_LEDGER_CAP ring. A '+' whose full cacheKey was resident before
 * is a RELINK (`relink: true`, counted per key). Programs already resident at
 * install are the baseline: remembered, not logged.
 *
 * STAGE-KEYED programs (ShaderMaterial / RawShaderMaterial / custom-type
 * subclasses — a key headed by two WebGLShaderStage ids, see _stageHeadEnd)
 * would never match that way: three mints new stage ids once the last
 * material with that source is disposed, so the relink arrives under a new
 * key. Those are the only programs ProgramRetention (program_retention.js,
 * default ON) still lets relink, so keying them by id would read ~0 relinks
 * by construction. Their identity is the linked GLSL instead: the program's
 * attached shaders' source (gl.getShaderSource on the program's
 * vertexShader / fragmentShader — a client-side string, no GPU round trip;
 * three deletes the shaders after first use but never detaches them, so they
 * stay queryable while the program is resident) + the key minus its two ids.
 * That read runs only for a stage-keyed create (or install seed), never per
 * frame. When the source can't be read (mock, lost context) the full key is
 * used and `stats.ledger.stageKeyedNoSource` counts it: such a relink can
 * only be UNDER-counted. `stats.ledger.stageKeyed` counts stage-keyed creates.
 * Otherwise only renderer.info is read; nothing drawn differently.
 * After WebAC tools/hitch-probe.ts (program-churn scan), AGPL-3.0.
 *
 *   __linkProbe.ledger()        chronological copy of the ring
 *   __linkProbe.ledgerStats()   {available, created, released, relinks,
 *                                distinctKeys, resident, seeded, dropped,
 *                                stageKeyed, stageKeyedNoSource, ...}
 *   __linkProbe.relinkedKeys()  [{name, type, key, relinks, stage}] worst first
 *   __linkProbe.ledgerTick()    diff once now (tests; the timer does this)
 *   __linkProbe.stopLedger()    clear the timer (ledger reads still diff)
 *
 * `reset()` clears the ring and the window counters (`stats.ledger`) but keeps
 * the session's key memory, so a relink after a reset is still a relink.
 *
 * @param {any} renderer
 * @param {{force?: boolean, ledgerMs?: number}} [opts]
 */
export function installLinkProbe(renderer, opts = {}) {
  if ((!LINK_PROBE_ON && opts.force !== true) || !renderer || typeof renderer.getContext !== "function") return null;
  let gl;
  try {
    gl = renderer.getContext();
  } catch (_) {
    return null;
  }
  if (!gl || typeof gl.getProgramParameter !== "function") return null;
  if (gl.__linkProbeState) return gl.__linkProbeState;

  let completionPname = _COMPLETION_STATUS_KHR;
  try {
    const ext = typeof gl.getExtension === "function" ? gl.getExtension("KHR_parallel_shader_compile") : null;
    if (ext && typeof ext.COMPLETION_STATUS_KHR === "number") completionPname = ext.COMPLETION_STATUS_KHR;
  } catch (_) {}
  const linkPname = typeof gl.LINK_STATUS === "number" ? gl.LINK_STATUS : _LINK_STATUS_FALLBACK;

  const _now =
    typeof globalThis !== "undefined" && globalThis.performance && typeof globalThis.performance.now === "function"
      ? () => globalThis.performance.now()
      : () => Date.now();

  const _zero = () => ({
    linkProgramCalls: 0,
    // LINK_STATUS reads: the forced-wait bucket. A read on a still-linking
    // program blocks on the driver link; `stallCalls` counts reads >5 ms.
    linkStatus: { calls: 0, ms: 0, worstMs: 0, stallCalls: 0 },
    // COMPLETION_STATUS_KHR reads: three's cheap async ready-poll.
    completion: { calls: 0, ms: 0 },
    other: { calls: 0, ms: 0 },
    // Program ledger window counters (see the PROGRAM LEDGER note above).
    // `dropped` = entries the ring overwrote. `stageKeyed` = creates of a
    // stage-keyed program (identity = its GLSL); `stageKeyedNoSource` = those
    // whose source was unreadable (identity fell back to the re-mintable key).
    ledger: { created: 0, released: 0, relinks: 0, dropped: 0, stageKeyed: 0, stageKeyedNoSource: 0 },
  });
  let stats = _zero();

  const origLink = gl.linkProgram;
  gl.linkProgram = function (program) {
    stats.linkProgramCalls += 1;
    return origLink.call(this, program);
  };
  const origGet = gl.getProgramParameter;
  gl.getProgramParameter = function (program, pname) {
    const t0 = _now();
    const r = origGet.call(this, program, pname);
    const dt = _now() - t0;
    if (pname === linkPname) {
      stats.linkStatus.calls += 1;
      stats.linkStatus.ms += dt;
      if (dt > stats.linkStatus.worstMs) stats.linkStatus.worstMs = dt;
      if (dt > 5) stats.linkStatus.stallCalls += 1;
    } else if (pname === completionPname) {
      stats.completion.calls += 1;
      stats.completion.ms += dt;
    } else {
      stats.other.calls += 1;
      stats.other.ms += dt;
    }
    return r;
  };

  // ── program ledger ──────────────────────────────────────────────────────
  let ring = [];
  let ringHead = 0; // index of the oldest entry once the ring is full
  let relinked = new Map(); // key hash -> { name, type, key, relinks } (window)
  const keysSeen = new Set(); // key hash of every key ever resident (session)
  let known = new Map(); // id -> { name, type, key, hash } resident last tick
  let ledgerAvailable = false;
  let ledgerTicks = 0;
  let ledgerSeeded = 0;
  let ledgerTimer = null;

  // Relink identity of one newly seen program (see STAGE-KEYED above):
  // {hash, stage, bySource}. Built-in key → hash of the full key.
  const _getShaderSource = typeof gl.getShaderSource === "function" ? gl.getShaderSource : null;
  const _identity = (p, full) => {
    const end = _stageHeadEnd(full);
    if (end < 0) return { hash: _keyHash(full), stage: false, bySource: false };
    let vsSrc = null;
    let fsSrc = null;
    if (_getShaderSource && p.vertexShader && p.fragmentShader) {
      try {
        vsSrc = _getShaderSource.call(gl, p.vertexShader);
        fsSrc = _getShaderSource.call(gl, p.fragmentShader);
      } catch (_) {
        vsSrc = fsSrc = null;
      }
    }
    if (typeof vsSrc !== "string" || typeof fsSrc !== "string" || vsSrc.length === 0 || fsSrc.length === 0) {
      return { hash: _keyHash(full), stage: true, bySource: false };
    }
    return { hash: _keyHash(`glsl\0${vsSrc}\0${fsSrc}\0${full.slice(end)}`), stage: true, bySource: true };
  };

  const _ledgerPush = (e) => {
    if (ring.length < LINK_LEDGER_CAP) {
      ring.push(e);
    } else {
      ring[ringHead] = e;
      ringHead = (ringHead + 1) % LINK_LEDGER_CAP;
      stats.ledger.dropped += 1;
    }
  };

  // One diff of renderer.info.programs against the previous tick. Read fresh
  // every time: three swaps in a new array on context restore. Releases are
  // logged before creates (three releases on dispose and relinks at the next
  // draw); creates in id order, which is creation order. `seed` = the install
  // baseline. Returns the number of entries logged.
  const ledgerTick = (seed = false) => {
    let progs = null;
    try {
      progs = renderer.info && renderer.info.programs;
    } catch (_) {
      progs = null;
    }
    if (!Array.isArray(progs)) return 0; // mock / no info: fail-soft
    ledgerAvailable = true;
    ledgerTicks += 1;
    const t = _now();
    const now = new Map();
    for (const p of progs) if (p && p.id != null) now.set(p.id, p);
    let logged = 0;
    for (const [id, rec] of known) {
      if (now.has(id)) continue;
      stats.ledger.released += 1;
      _ledgerPush({ t, op: "-", id, name: rec.name, type: rec.type, key: rec.key });
      logged += 1;
    }
    const added = [];
    const next = new Map();
    for (const [id, p] of now) {
      const rec = known.get(id);
      if (rec) next.set(id, rec);
      else added.push(p);
    }
    added.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const p of added) {
      const full = typeof p.cacheKey === "string" ? p.cacheKey : String(p.cacheKey ?? "");
      const ident = _identity(p, full);
      const rec = {
        name: typeof p.name === "string" ? p.name : "",
        type: typeof p.type === "string" ? p.type : "",
        key: full.length > _LEDGER_KEY_CHARS ? full.slice(0, _LEDGER_KEY_CHARS) + "…" : full,
        hash: ident.hash,
      };
      next.set(p.id, rec);
      if (seed) {
        keysSeen.add(rec.hash);
        ledgerSeeded += 1;
        continue;
      }
      const relink = keysSeen.has(rec.hash);
      keysSeen.add(rec.hash);
      stats.ledger.created += 1;
      if (ident.stage) {
        stats.ledger.stageKeyed += 1;
        if (!ident.bySource) stats.ledger.stageKeyedNoSource += 1;
      }
      if (relink) {
        stats.ledger.relinks += 1;
        const r = relinked.get(rec.hash);
        if (r) r.relinks += 1;
        else relinked.set(rec.hash, { name: rec.name, type: rec.type, key: rec.key, relinks: 1, stage: ident.stage });
      }
      _ledgerPush({ t, op: "+", id: p.id, name: rec.name, type: rec.type, key: rec.key, relink });
      logged += 1;
    }
    known = next;
    return logged;
  };
  const _ledgerTickSafe = () => {
    try {
      return ledgerTick();
    } catch (_) {
      return 0;
    }
  };

  try {
    ledgerTick(true);
  } catch (_) {}
  const ledgerMs = opts.ledgerMs === undefined ? LINK_LEDGER_MS : Number(opts.ledgerMs);
  if (Number.isFinite(ledgerMs) && ledgerMs > 0 && typeof setInterval === "function") {
    try {
      ledgerTimer = setInterval(_ledgerTickSafe, ledgerMs);
      // node (tests): a diagnostic timer must never hold the process open.
      if (ledgerTimer && typeof ledgerTimer.unref === "function") ledgerTimer.unref();
    } catch (_) {
      ledgerTimer = null;
    }
  }

  const state = {
    get stats() {
      return stats;
    },
    reset() {
      stats = _zero();
      ring = [];
      ringHead = 0;
      relinked = new Map();
    },
    summary() {
      _ledgerTickSafe();
      const ls = stats.linkStatus;
      const lg = stats.ledger;
      return (
        `linkProgram=${stats.linkProgramCalls} | ` +
        `LINK_STATUS ${ls.calls} reads ${ls.ms.toFixed(1)}ms ` +
        `(worst ${ls.worstMs.toFixed(1)}ms, >5ms×${ls.stallCalls}) | ` +
        `COMPLETION_STATUS_KHR ${stats.completion.calls} reads ${stats.completion.ms.toFixed(1)}ms | ` +
        `other ${stats.other.calls} reads ${stats.other.ms.toFixed(1)}ms | ` +
        (ledgerAvailable
          ? `programs relinks=${lg.relinks} distinctKeys=${keysSeen.size} released=${lg.released} ` +
            `created=${lg.created} resident=${known.size} stageKeyed=${lg.stageKeyed} noSource=${lg.stageKeyedNoSource}`
          : `programs ledger n/a (no renderer.info.programs)`)
      );
    },
    /** Chronological copy of the ledger ring (diffs once first). */
    ledger() {
      _ledgerTickSafe();
      return ring.length < LINK_LEDGER_CAP ? ring.slice() : ring.slice(ringHead).concat(ring.slice(0, ringHead));
    },
    /** Diff renderer.info.programs once now; returns entries logged. */
    ledgerTick() {
      return _ledgerTickSafe();
    },
    /** Ledger counters (diffs once first). `distinctKeys`/`resident`/`seeded`
     *  are session-wide; the rest are the `stats.ledger` window. */
    ledgerStats() {
      _ledgerTickSafe();
      const lg = stats.ledger;
      return {
        available: ledgerAvailable,
        created: lg.created,
        released: lg.released,
        relinks: lg.relinks,
        relinkedKeys: relinked.size,
        distinctKeys: keysSeen.size,
        resident: known.size,
        seeded: ledgerSeeded,
        dropped: lg.dropped,
        stageKeyed: lg.stageKeyed,
        stageKeyedNoSource: lg.stageKeyedNoSource,
        entries: ring.length,
        ticks: ledgerTicks,
        timerMs: ledgerTimer ? ledgerMs : 0,
      };
    },
    /** Keys linked more than once, worst first (diffs once first). */
    relinkedKeys() {
      _ledgerTickSafe();
      return [...relinked.values()].map((r) => ({ ...r })).sort((a, b) => b.relinks - a.relinks);
    },
    /** Stop the ledger timer. Reads still diff; nothing else changes. */
    stopLedger() {
      if (ledgerTimer) {
        try {
          clearInterval(ledgerTimer);
        } catch (_) {}
        ledgerTimer = null;
      }
    },
  };
  gl.__linkProbeState = state;
  try {
    if (typeof window !== "undefined") window.__linkProbe = state;
  } catch (_) {}
  // eslint-disable-next-line no-console
  console.info(
    `[shader_prewarm] link probe installed (${opts.force === true ? "forced by caller" : "?linkProbe=on"}) — window.__linkProbe.summary(), .ledger(), .relinkedKeys()`,
  );
  return state;
}

// ============================================================================
// Targeted warm helpers (2026-10-09, D2: `?tunnelWorldWarm` in portal_space.js,
// `?pmremPrecompile` in ibl_environment.js). Used only by those two flags.
// ============================================================================
// three r184 keys a program on the target bound at compile time by null vs
// non-null only (getParameters: outputColorSpace + toneMapping; no size/type),
// so a warm binds the right CLASS of target per draw: null for a pass that
// draws to the canvas, the shared 1×1 HalfFloat warm target for anything drawn
// offscreen (composer buffers, PMREM cubeUV / ping-pong, the IBL cube RT).
// A warm only STARTS the link (KHR_parallel_shader_compile links in the GPU
// process); callers poll `programPending` — never getUniforms/LINK_STATUS —
// so nothing here can block the main thread on a link.

/** The shared non-null warm target (1×1 HalfFloat, never drawn into). */
export function getWarmTarget() {
  return _getWarmTarget();
}

/**
 * renderer.compile(root, camera, targetScene) with `target` bound (null = the
 * canvas), restoring the previous target / cube face / mip level on every
 * path. Must run outside renderer.render() (compile resets three's render
 * state). Returns the compiled material Set, or null (no usable renderer, or
 * compile threw — the materials then link at first draw, as before).
 */
export function compileWithTarget(renderer, root, camera, targetScene, target) {
  if (
    !renderer || !root || !camera ||
    typeof renderer.compile !== "function" ||
    typeof renderer.setRenderTarget !== "function" ||
    typeof renderer.getRenderTarget !== "function"
  ) return null;
  const prev = renderer.getRenderTarget();
  let face = 0, mip = 0;
  try {
    face = typeof renderer.getActiveCubeFace === "function" ? renderer.getActiveCubeFace() : 0;
    mip = typeof renderer.getActiveMipmapLevel === "function" ? renderer.getActiveMipmapLevel() : 0;
  } catch (_) { /* defaults */ }
  try {
    renderer.setRenderTarget(target ?? null);
    const set = renderer.compile(root, camera, targetScene ?? null);
    return set && typeof set.forEach === "function" ? set : null;
  } catch (_) {
    return null;
  } finally {
    try { renderer.setRenderTarget(prev, face, mip); } catch (_) { /* best effort */ }
  }
}

/** Every program `material` owns — three keeps one per cache key in
 *  `properties.programs` (a transparent DoubleSide material compiles a Back and
 *  a Front one), not just `currentProgram`. Appends to `out`. */
export function programsOf(renderer, material, out = []) {
  let mp = null;
  try { mp = renderer?.properties?.get?.(material) ?? null; } catch (_) { mp = null; }
  const progs = mp && mp.programs;
  if (progs && typeof progs.forEach === "function") progs.forEach((p) => { if (p) out.push(p); });
  else if (mp && mp.currentProgram) out.push(mp.currentProgram);
  return out;
}

/** Still linking? Non-blocking: three's isReady() polls COMPLETION_STATUS_KHR
 *  (and is `true` from the start without the extension). A program three has
 *  released (usedTimes 0 — deleted) or whose poll throws / returns null (lost
 *  context) counts as done, so a stale entry can never hold anything. */
export function programPending(p) {
  if (!p || typeof p.isReady !== "function") return false;
  if (typeof p.usedTimes === "number" && p.usedTimes <= 0) return false;
  try { return p.isReady() === false; } catch (_) { return false; }
}

/** Drop every program that is no longer pending from `set` (a Set); returns
 *  how many are still linking. */
export function prunePending(set) {
  if (!set || typeof set.forEach !== "function") return 0;
  for (const p of set) if (!programPending(p)) set.delete(p);
  return set.size;
}

const _renderable = (o) => !!o && (o.isMesh || o.isPoints || o.isLine || o.isSprite) && !!o.material;
const _kindBits = (o) => (o.isInstancedMesh ? 1 : 0) | (o.isBatchedMesh ? 2 : 0) | (o.isSkinnedMesh ? 4 : 0);
const _standIns = new WeakMap(); // scene -> stand-in target scene

/**
 * Compile the materials of `scene` that are new or changed since this warm
 * last compiled them, with `target` bound (see compileWithTarget), in ONE
 * compile() call. One traversal collects the renderables (visible or not —
 * a hidden patch still draws the moment it is shown) and the lights on the
 * visible path; compile() then runs against a stand-in target scene carrying
 * the real scene's fog / environment / environmentRotation and those lights,
 * so the light-count and fog bits of every key match the real draw without a
 * second walk of the world. `opts.seen` (WeakMap material → Set of keys) makes
 * a re-run cheap: a material is compiled again only when its version, its
 * object kind, the scene's light count, fog or environment class changed.
 * `opts.skip(object)` prunes a subtree; `opts.maxNew` caps the materials
 * compiled per call (the rest wait for the next call: `deferred`).
 *
 * @returns {{materials: Set|null, objects: number, compiled: number, deferred: number}}
 */
export function warmSceneMaterials(renderer, scene, camera, target, opts = {}) {
  const out = { materials: null, objects: 0, compiled: 0, deferred: 0 };
  if (!renderer || !scene || !camera) return out;
  const seen = opts.seen instanceof WeakMap ? opts.seen : null;
  const skip = typeof opts.skip === "function" ? opts.skip : null;
  const maxNew = Number.isFinite(opts.maxNew) && opts.maxNew > 0 ? opts.maxNew : Infinity;
  const lights = [];
  const objs = [];
  const picked = new Map(); // material -> its seen key, this call
  const over = new Set(); // materials left for a later call (maxNew)
  const env = scene.environment;
  const fog = scene.fog;
  // Iterative walk (deep worlds): [object, onVisiblePath].
  const stack = [[scene, scene.visible !== false]];
  const pending = [];
  while (stack.length) {
    const [o, vis] = stack.pop();
    if (!o || (skip && o !== scene && skip(o))) continue;
    out.objects += 1;
    if (o.isLight) { if (vis) lights.push(o); }
    else if (_renderable(o)) pending.push(o);
    const ch = o.children;
    if (ch && ch.length) for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], vis && ch[i] && ch[i].visible !== false]);
  }
  const ctx = `${lights.length}|${env ? 1 : 0}:${env?.image?.height ?? 0}|${fog ? (fog.isFogExp2 ? 2 : 1) : 0}`;
  for (const o of pending) {
    const list = Array.isArray(o.material) ? o.material : [o.material];
    let take = false;
    for (const m of list) {
      if (!m || !m.isMaterial || picked.has(m)) continue;
      const key = `${_kindBits(o)}|${m.version}|${ctx}`;
      const s = seen && seen.get(m);
      if (s && s.has(key)) continue;
      if (picked.size >= maxNew) { over.add(m); continue; }
      picked.set(m, key);
      take = true;
    }
    if (take) objs.push(o);
  }
  out.deferred = over.size;
  if (objs.length === 0) return out;
  let standIn = _standIns.get(scene);
  if (!standIn) {
    standIn = {
      isScene: true,
      __lights: [],
      get fog() { return scene.fog; },
      get environment() { return scene.environment; },
      get environmentRotation() { return scene.environmentRotation; },
      traverseVisible(cb) { for (const l of this.__lights) cb(l); },
      traverse(cb) { for (const l of this.__lights) cb(l); },
    };
    _standIns.set(scene, standIn);
  }
  standIn.__lights = lights;
  const root = {
    traverse(cb) { for (const o of objs) cb(o); },
    traverseVisible(cb) { for (const o of objs) cb(o); },
  };
  const mats = compileWithTarget(renderer, root, camera, standIn, target);
  standIn.__lights = [];
  if (!mats) return out;
  out.materials = mats;
  out.compiled = mats.size;
  if (seen) {
    // Key on the version AFTER compile: three's two-pass prepare of a
    // transparent DoubleSide material bumps it (side Back/Front + needsUpdate).
    for (const [m, key0] of picked) {
      const key = key0.replace(/^(\d+)\|\d+\|/, `$1|${m.version}|`);
      let s = seen.get(m);
      if (!s || s.size >= 8) { s = new Set(); seen.set(m, s); }
      s.add(key);
    }
  }
  return out;
}

// ============================================================================
// R3-3 GPU batch kit (2026-10-30): the class-program registry.
// ============================================================================
// scene3d/gpu_batch/class_materials.js builds one MeshStandardMaterial per
// draw CLASS (blend x light x side) with its own program key
// (`|hbBatch1|...`). A class program first seen mid-walk is an FXC compile
// (0.5-1.7 s per pixel shader on the 1070, round-3 plan §6), so every class a
// consumer will draw is REGISTERED here and compiled against the composer
// variant (the warm target) before its first draw:
//   - `registerBatchClassPrewarm(key, makeProxies)`: a consumer, ONLY when
//     its flag is on, registers a factory of one-instance proxies (one per
//     program variant it draws; `classPrewarmProxy`). Nothing registers with
//     every batch flag off, so with the flags off this section is inert: the
//     map stays empty and nothing below runs.
//   - `prewarmBatchClasses(renderer, camera, targetScene, opts)`: compile
//     every registered class not yet warmed on this renderer's CURRENT GL
//     context, in ONE compile() call with the warm target bound, against a
//     stand-in target scene that carries the live scene's lights / fog /
//     environment (so the light-count and fog bits of the key match the real
//     draw). The proxies stay PARKED for the session (three refcounts
//     programs: disposing the proxy would release the program it just linked
//     — bake_prewarm.js rule). Returns the compiled material Set (poll with
//     `programPending`).
//   - "Warmed" is per GL context, not per renderer object: three's
//     onContextRestore assigns a NEW WebGLProperties (and program cache) to
//     `renderer.properties` (async_link_guard.js "CONTEXT RESTORE"), so the
//     warmed set is keyed by that object and a restored context warms every
//     registered class again.
// Wiring: NO index.js call is needed. The consumer (anim_scenery_batch.js)
// calls prewarmBatchClasses itself at its first instance registration — the
// first landblock bake, behind the loading screen — with window.liveScene3d's
// renderer / camera / scene, and again at the first warming check of a class
// not yet warm on the current context (a class minted later, or any class
// after a context restore); it keeps the class's draws hidden until its
// program has linked. An optional index.js call next to the boot compile pass
// would only move the same compile earlier.
const _batchClassPrewarm = new Map(); // key -> () => Object3D[]
const _batchClassWarmed = new WeakMap(); // renderer.properties (GL-context generation) -> Set(key)
const _batchClassParked = []; // proxies kept alive (program refcount)
const _batchStandIns = new WeakMap(); // targetScene -> stand-in

/** Register a class's prewarm proxies factory (idempotent per key). */
export function registerBatchClassPrewarm(key, makeProxies) {
  if (typeof key !== "string" || typeof makeProxies !== "function") return false;
  if (_batchClassPrewarm.has(key)) return false;
  _batchClassPrewarm.set(key, makeProxies);
  return true;
}

/** Keys registered so far (diag / tests). */
export function batchClassPrewarmKeys() {
  return [..._batchClassPrewarm.keys()];
}

// The renderer's GL-context generation (see above).
function _batchWarmCtx(renderer) {
  return (renderer && renderer.properties) || renderer;
}

/** Keys already compiled on `renderer`'s current GL context. */
export function batchClassWarmedKeys(renderer) {
  const s = renderer ? _batchClassWarmed.get(_batchWarmCtx(renderer)) : null;
  return s ? [...s] : [];
}

function _batchStandIn(targetScene, lights) {
  let s = _batchStandIns.get(targetScene);
  if (!s) {
    s = {
      isScene: true,
      __lights: [],
      get fog() { return targetScene.fog; },
      get environment() { return targetScene.environment; },
      get environmentRotation() { return targetScene.environmentRotation; },
      traverseVisible(cb) { for (const l of this.__lights) cb(l); },
      traverse(cb) { for (const l of this.__lights) cb(l); },
    };
    _batchStandIns.set(targetScene, s);
  }
  s.__lights = lights;
  return s;
}

/**
 * Compile every registered batch class not yet warmed on `renderer`'s
 * current GL context.
 * `opts.target` (default: the warm target), `opts.lights` (skips the light
 * walk of `targetScene`). Returns `{ keys, compiled, materials }`.
 */
export function prewarmBatchClasses(renderer, camera, targetScene, opts = {}) {
  const out = { keys: [], compiled: 0, materials: null };
  if (!renderer || !camera || _batchClassPrewarm.size === 0) return out;
  const ctx = _batchWarmCtx(renderer);
  let warmed = _batchClassWarmed.get(ctx);
  if (!warmed) { warmed = new Set(); _batchClassWarmed.set(ctx, warmed); }
  const group = new THREE.Group();
  group.name = "gpu-batch-class-prewarm";
  for (const [key, make] of _batchClassPrewarm) {
    if (warmed.has(key)) continue;
    let proxies = null;
    try { proxies = make(); } catch (_) { proxies = null; }
    if (!Array.isArray(proxies) || proxies.length === 0) continue;
    for (const p of proxies) group.add(p);
    out.keys.push(key);
  }
  if (out.keys.length === 0) return out;
  let lights = Array.isArray(opts.lights) ? opts.lights : null;
  if (!lights) {
    lights = [];
    if (targetScene && typeof targetScene.traverseVisible === "function") {
      targetScene.traverseVisible((o) => { if (o.isLight) lights.push(o); });
    }
  }
  const standIn = targetScene ? _batchStandIn(targetScene, lights) : null;
  const target = opts.target !== undefined ? opts.target : _getWarmTarget();
  const mats = compileWithTarget(renderer, group, camera, standIn, target);
  if (standIn) standIn.__lights = [];
  _batchClassParked.push(group);
  if (!mats) return out;
  for (const k of out.keys) warmed.add(k);
  out.materials = mats;
  out.compiled = mats.size;
  return out;
}
