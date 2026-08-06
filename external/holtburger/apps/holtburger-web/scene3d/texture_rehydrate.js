// scene3d/texture_rehydrate.js — the re-upload source for textures whose
// CPU-side pixel copy has been released.
//
// WHY THIS EXISTS
// The texture census (§9 of docs/2026-08-05-1070-black-flicker-and-renderer-
// oom-handoff.md) measured 1,332 MB of the JS heap held as CPU-side copies of
// pixels that are ALREADY on the GPU: three keeps `image.data` (and
// `mipmaps[].data`) alive for the life of every texture and nothing ever drops
// it. On a page that OOM-crashes at ~2,800 MB of a 4,192 MB cap that is the
// single biggest lever there is.
//
// §10 withdrew "release the CPU copy after upload" on three grounds, and the
// one that ends the discussion is CONTEXT LOSS. `webgl_context_recovery.js`
// calls `e.preventDefault()` on `webglcontextlost` — *"the defining call: tell
// the browser we want a restore. Without preventDefault the context is
// unrecoverable"* (webgl_context_recovery.js:95-97) — and three's own restore
// path clears `WebGLProperties` (three.module.js:16382 via :17055), so on the
// next render EVERY tracked texture re-uploads from `image.data`. Context loss
// is not hypothetical here: the recovery module's header records it *"observed
// 7× on 1070"* under exactly the VRAM pressure this work is about. Release the
// CPU copy with no replacement and a currently-RECOVERED event becomes a
// permanently black world.
//
// This module is that replacement. It is the registry a releasing module calls
// to say *"I dropped this texture's pixels; here is how to get them back"*, and
// the pass that `webgl_context_recovery.js` runs on `webglcontextrestored`
// BEFORE the frame pump is allowed to resume.
//
// WHAT IT IS NOT
// It does not release anything and it does not know how to decode anything.
// Every re-supply source is owned by the module that released the copy:
//   * surface pixels  — the wasm decode path (`fetch_surfaces_pixels` /
//     `fetch_surface_pixels`), the same call `adapter.js` used to build the
//     texture in the first place (adapter.js:1122 albedo, :1180 normal,
//     :1238 height, :1290 roughness, :1325 AO);
//   * BC7 payloads    — `Bc7RecordSource.getAsync()` (bc7_textures.js:614),
//     which re-fetches through its normal `_begin` path on a miss. Note the
//     record cache now has a byte budget (`?bc7RecordsMB`, armed at 256 MB),
//     so a record may legitimately have been evicted and need a real refetch;
//   * atlas layers    — re-packed from the two above.
// All of them are ASYNC, and a restore therefore stalls for a beat. That is
// accepted and expected: a stalled restore is a rendered world, a fast restore
// with no pixels is a black one. What is NOT acceptable is stalling FOREVER,
// so the pass carries a hard deadline (see `DEFAULT_TIMEOUT_MS`) and resumes
// the pump — loudly — rather than deadlocking it.
//
// TODAY THIS IS A NO-OP. Nothing releases a CPU copy yet (that caller is a
// separate work item). With an empty registry `rehydrateReleasedTextures` is
// never even called — `webgl_context_recovery.js` checks
// `releasedTextureCount() === 0` and keeps the old fully-synchronous restore
// path. The registry only ever walks textures EXPLICITLY registered as
// "released, re-hydrate me"; it never sweeps the scene graph.
//
// FAILING LOUD IS THE POINT. A texture that comes back from a restore with no
// pixels renders black — or, worse, routes its node to unbatched `passthrough`
// (statics.js:2379 / static_atlas.js:1121 both gate on `img.data` existing), a
// frame-rate regression no blackness eye-test would catch. So a miss is a
// `console.error` plus a `failed` counter on `textureRehydrateStats()`, never a
// silent skip.

/** Hard ceiling on one restore pass. Past this we resume the pump anyway and
 *  scream — a stalled decode must not deadlock the frame loop, and a black
 *  frame the user can act on beats a frozen tab they cannot. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** Parallel re-hydrations in flight. The re-supply paths are wasm decodes and
 *  network record fetches; unbounded fan-out would spike wasm linear memory —
 *  the very budget §8's census was built to watch — at the exact moment the
 *  GPU has just been re-created. Four keeps the pipe full without a herd. */
export const DEFAULT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** @type {Map<number, Object>} id → entry. Entries hold the texture ONLY
 *  through a WeakRef: a registry that pinned textures would itself be the leak
 *  this whole workstream is trying to remove (same rule as the census —
 *  texture_census.js:49-51). */
let _entries = new Map();
/** @type {WeakMap<Object, number>} texture → id, so re-registering the same
 *  texture replaces its rehydrator instead of queueing a second one. */
let _ids = new WeakMap();
let _nextId = 1;

const _stats = {
  registered: 0,     // entries currently live in the map
  everRegistered: 0, // cumulative registrations
  passes: 0,
  rehydrated: 0,
  skipped: 0,        // still had pixels — nothing to do
  failed: 0,         // THE counter that must stay 0 in a healthy page
  gcd: 0,            // texture was collected before we got to it
  timedOut: 0,
  aborted: 0,        // a second context loss superseded the pass
  lastError: null,
  lastPass: null,
};

// Drop entries whose texture has been collected. Without this the map grows
// for the life of the page across LB churn — small per entry, but this module
// exists to stop unbounded retention, not to add a new one.
const _finalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((id) => {
      if (_entries.delete(id)) {
        _stats.registered = _entries.size;
        _stats.gcd += 1;
      }
    })
  : null;

/**
 * Register a texture whose CPU-side pixel copy has just been released.
 *
 * THE CONTRACT (this is the signature the releasing module codes against):
 *
 * @param {Object} texture — the three.js Texture whose `image.data` /
 *   `mipmaps[].data` you just dropped. Held via WeakRef; registering does not
 *   keep it alive.
 * @param {(texture: Object, ctx: {reason: string, attempt: number}) => (void|boolean|Promise<void|boolean>)} rehydrate
 *   Re-supply the pixels. Called with the SAME texture object (never a clone —
 *   see below). It must, by the time its promise settles:
 *     1. put pixel bytes back where three reads them — `texture.image.data`
 *        for a DataTexture, `texture.mipmaps[i].data` for a compressed one;
 *     2. leave the dimensions/format it found (this is a re-supply, not a
 *        re-spec — three's restore re-uploads with the descriptor it already
 *        has).
 *   `texture.needsUpdate = true` is set for you on success. Return `false`, or
 *   throw, or reject, to declare a MISS — all three are reported identically
 *   and loudly. Returning `undefined`/`true` means success, and success is then
 *   VERIFIED against `textureHasPixels`; a rehydrator that claims success and
 *   supplies nothing is counted as a miss anyway.
 * @param {{label?: string, owner?: string, bytes?: number}} [meta] — diagnostic
 *   only. `label` names the texture in the error line (a DID/rsId hex is ideal:
 *   a black surface with no name is unactionable), `owner` names the releasing
 *   module, `bytes` records what the release bought.
 * @returns {number} the entry id, for `unregisterReleasedTexture`.
 *
 * CLONES. three's `.clone()` shares `source` (entities.js:12750/12771/16579),
 * so `image.data` is shared too: release/register the SOURCE-owning texture
 * once, not every clone. Registering two clones of one source is not an error —
 * the second simply finds pixels present and is skipped — but the release that
 * preceded it was already global.
 *
 * IDEMPOTENT. Re-registering the same texture replaces the rehydrator and keeps
 * one entry. Registration PERSISTS across restores by design: the pass skips
 * entries that currently have pixels, so a texture that is released → restored
 * → released again needs no re-registration to stay covered (though calling
 * again on each release is free and is the clearer discipline).
 */
export function registerReleasedTexture(texture, rehydrate, meta = {}) {
  if (!texture || typeof texture !== "object") {
    throw new Error("registerReleasedTexture: a texture object is required");
  }
  if (typeof rehydrate !== "function") {
    // A registration with no way back is worse than no registration: it looks
    // covered and is not. Refuse it at the door.
    throw new Error(
      `registerReleasedTexture: rehydrate callback is required (label=${meta?.label ?? "?"})`
    );
  }
  const existing = _ids.get(texture);
  const id = existing !== undefined ? existing : _nextId++;
  const prev = _entries.get(id);
  _entries.set(id, {
    id,
    ref: new WeakRef(texture),
    rehydrate,
    label: meta.label != null ? String(meta.label) : `tex#${id}`,
    owner: meta.owner != null ? String(meta.owner) : "unknown",
    bytes: Number.isFinite(meta.bytes) ? meta.bytes : 0,
    attempts: prev ? prev.attempts : 0,
    lastError: prev ? prev.lastError : null,
  });
  if (existing === undefined) {
    _ids.set(texture, id);
    _stats.everRegistered += 1;
    if (_finalizer) {
      try { _finalizer.register(texture, id, texture); } catch (_) { /* best-effort */ }
    }
  }
  _stats.registered = _entries.size;
  return id;
}

/**
 * Drop a registration — call this if the texture is disposed, or if its CPU
 * copy is back for good and will not be released again.
 * @param {Object|number} textureOrId
 * @returns {boolean} whether an entry was removed.
 */
export function unregisterReleasedTexture(textureOrId) {
  let id = textureOrId;
  if (typeof textureOrId === "object" && textureOrId !== null) {
    id = _ids.get(textureOrId);
    if (id === undefined) return false;
    _ids.delete(textureOrId);
    if (_finalizer) {
      try { _finalizer.unregister(textureOrId); } catch (_) { /* best-effort */ }
    }
  }
  const entry = _entries.get(id);
  if (entry && typeof textureOrId === "number") {
    // Unregistering by id: clear the texture→id side map too, or a later
    // re-registration of the same texture would silently reuse a slot this
    // caller believed it had given up.
    const tex = entry.ref.deref();
    if (tex) {
      _ids.delete(tex);
      if (_finalizer) {
        try { _finalizer.unregister(tex); } catch (_) { /* best-effort */ }
      }
    }
  }
  const had = _entries.delete(id);
  _stats.registered = _entries.size;
  return had;
}

/** How many textures are currently registered as released. ZERO on a page
 *  where nothing has released anything — which is what keeps the restore path
 *  a strict no-op today (webgl_context_recovery.js reads this before deciding
 *  whether to go async at all). */
export function releasedTextureCount() {
  return _entries.size;
}

/** Diagnostic snapshot. `failed` is the number that matters: any non-zero
 *  value means a texture came back from a restore with no pixels. */
export function textureRehydrateStats() {
  const byOwner = {};
  for (const e of _entries.values()) {
    byOwner[e.owner] = (byOwner[e.owner] || 0) + 1;
  }
  return { ..._stats, registered: _entries.size, byOwner };
}

// ---------------------------------------------------------------------------
// pixel presence
// ---------------------------------------------------------------------------

/**
 * Does this texture still carry CPU-side pixels three could re-upload from?
 *
 * This is the predicate the pass uses BOTH to skip work and to verify a
 * rehydrator's claim, so it deliberately mirrors what three's `uploadTexture`
 * actually reads: `texture.image` (a DataTexture's `{data,width,height}`, or a
 * canvas/ImageBitmap/video element, which carry their own pixels and are never
 * released by us) and `texture.mipmaps[]` for the compressed path.
 * `texture.source.data` is the same object as `texture.image` in r184 — the
 * census double-charged bytes for exactly that reason (test_texture_census.mjs
 * header) — so it is checked only as a fallback, never as a second source.
 *
 * A render-target texture (`isRenderTargetTexture`) legitimately has no CPU
 * pixels ever; treat it as "has pixels" so nobody registers one by mistake and
 * then gets a permanent miss.
 */
export function textureHasPixels(tex) {
  if (!tex || typeof tex !== "object") return false;
  if (tex.isRenderTargetTexture) return true;
  const img = tex.image !== undefined ? tex.image : tex.source?.data;
  if (img) {
    // DataTexture / CompressedTexture level 0.
    if (img.data && img.data.byteLength > 0) return true;
    // canvas / ImageBitmap / <img> / <video>: pixels live in the element, not
    // in a typed array we could ever have released.
    if (!("data" in img) && (img.width > 0 || img.videoWidth > 0)) return true;
    if (Array.isArray(img)) {
      // Cube textures: every face must be present.
      return img.length > 0 && img.every((f) => f && f.data && f.data.byteLength > 0);
    }
  }
  const mips = tex.mipmaps;
  if (Array.isArray(mips) && mips.length > 0) {
    return !!(mips[0] && mips[0].data && mips[0].data.byteLength > 0);
  }
  return false;
}

// ---------------------------------------------------------------------------
// the restore pass
// ---------------------------------------------------------------------------

function _now() {
  return (typeof performance !== "undefined" && performance.now)
    ? performance.now()
    : Date.now();
}

/** Race a rehydrator against the pass deadline. A rehydrator that never
 *  settles (a wasm decode behind a module that never loads — the exact shape of
 *  the xu7 stall in bc7_textures.js:685-695) must not pin the frame pump. */
function _withDeadline(promise, msLeft, label) {
  if (!(msLeft > 0)) {
    // Already past the deadline — do not await, but DO adopt the promise so a
    // late rejection is not an unhandled one.
    Promise.resolve(promise).catch(() => {});
    return Promise.resolve({ timedOut: true, label });
  }
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ timedOut: true, label });
    }, msLeft);
    // `unref` so a node test process is never held open by a pending deadline.
    if (t && typeof t.unref === "function") t.unref();
    Promise.resolve(promise).then(
      (value) => { if (!done) { done = true; clearTimeout(t); resolve({ value }); } },
      (error) => { if (!done) { done = true; clearTimeout(t); resolve({ error }); } },
    );
  });
}

/** Passes SERIALIZE — they never overlap, and they never merge.
 *
 *  Merging was the first shape of this and it was wrong. A second context loss
 *  abandons the pass in flight (`isStale`); if the restore that follows that
 *  loss then JOINED the abandoned pass instead of running its own, it would
 *  resume the frame pump on a pass that deliberately did no work — a black
 *  world produced by the very guard meant to prevent one. Chaining gives every
 *  caller a pass that ran strictly AFTER its own call, while still keeping two
 *  decodes of the same surface from running concurrently. */
let _chain = Promise.resolve();

/**
 * Walk every registered released texture and put its pixels back. Never throws;
 * every failure mode is reported in the returned summary and on the console.
 *
 * @param {Object} [opts]
 * @param {string} [opts.reason] — what triggered the pass (goes in the log line).
 * @param {number} [opts.timeoutMs] — hard deadline for the WHOLE pass.
 * @param {number} [opts.concurrency]
 * @param {() => boolean} [opts.isStale] — checked between entries; return true
 *   to abandon the pass (the caller uses it to bail when a SECOND context loss
 *   has already superseded this restore — finishing would be wasted decode and
 *   would resume a pump that must stay parked).
 * @returns {Promise<{attempted:number, rehydrated:number, skipped:number, failed:number, gcd:number, timedOut:number, aborted:boolean, ms:number}>}
 */
export function rehydrateReleasedTextures(opts = {}) {
  const run = () => _runPass(opts);
  const result = _chain.then(run, run);
  // The chain tail must never reject, or every later pass inherits it.
  _chain = result.then(() => {}, () => {});
  return result;
}

async function _runPass({
  reason = "context-restored",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  isStale = null,
} = {}) {
  const started = _now();
  const deadline = started + timeoutMs;
  const summary = {
    reason,
    attempted: 0,
    rehydrated: 0,
    skipped: 0,
    failed: 0,
    gcd: 0,
    timedOut: 0,
    aborted: false,
    ms: 0,
  };
  _stats.passes += 1;

  const queue = Array.from(_entries.values());
  if (queue.length === 0) {
    summary.ms = _now() - started;
    _stats.lastPass = summary;
    return summary;
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[tex-rehydrate] ${reason}: re-supplying pixels for ${queue.length} released texture(s) — ` +
    `the frame pump stays parked until this settles (async decode; expect a stall)`
  );

  let cursor = 0;
  const runner = async () => {
    for (;;) {
      if (summary.aborted) return;
      if (isStale && isStale()) {
        summary.aborted = true;
        return;
      }
      const i = cursor++;
      if (i >= queue.length) return;
      const entry = queue[i];
      // The entry may have been unregistered while we were awaiting an earlier
      // one (dispose during restore is legal).
      if (!_entries.has(entry.id)) continue;
      const tex = entry.ref.deref();
      if (!tex) {
        summary.gcd += 1;
        _stats.gcd += 1;
        _entries.delete(entry.id);
        continue;
      }
      if (textureHasPixels(tex)) {
        // Its copy is present — either it was never really released, or an
        // earlier pass already put it back. Nothing to do, and nothing wrong.
        summary.skipped += 1;
        _stats.skipped += 1;
        continue;
      }
      summary.attempted += 1;
      entry.attempts += 1;
      const msLeft = deadline - _now();
      let outcome;
      try {
        outcome = await _withDeadline(
          entry.rehydrate(tex, { reason, attempt: entry.attempts }),
          msLeft,
          entry.label,
        );
      } catch (e) {
        // A rehydrator that throws SYNCHRONOUSLY never produced a promise.
        outcome = { error: e };
      }

      if (outcome.timedOut) {
        summary.timedOut += 1;
        summary.failed += 1;
        _stats.timedOut += 1;
        _stats.failed += 1;
        entry.lastError = `timed out after ${timeoutMs}ms`;
        _stats.lastError = `${entry.label}: ${entry.lastError}`;
        // eslint-disable-next-line no-console
        console.error(
          `[tex-rehydrate] MISS (timeout) ${entry.label} owner=${entry.owner} — ` +
          `pass deadline ${timeoutMs}ms hit; this texture will render BLACK ` +
          `(and may de-batch its node — statics.js:2379 gates on img.data)`
        );
        continue;
      }
      if (outcome.error || outcome.value === false) {
        summary.failed += 1;
        _stats.failed += 1;
        entry.lastError = outcome.error
          ? String(outcome.error?.message ?? outcome.error)
          : "rehydrator returned false";
        _stats.lastError = `${entry.label}: ${entry.lastError}`;
        // eslint-disable-next-line no-console
        console.error(
          `[tex-rehydrate] MISS ${entry.label} owner=${entry.owner} — ` +
          `${entry.lastError}; this texture will render BLACK`,
          outcome.error ?? "",
        );
        continue;
      }
      // Trust, then verify. A rehydrator that resolves without actually
      // putting bytes back is the silent-black failure this module exists to
      // prevent, so the claim is checked against the same predicate three's
      // upload will use.
      if (!textureHasPixels(tex)) {
        summary.failed += 1;
        _stats.failed += 1;
        entry.lastError = "rehydrator resolved but supplied no pixels";
        _stats.lastError = `${entry.label}: ${entry.lastError}`;
        // eslint-disable-next-line no-console
        console.error(
          `[tex-rehydrate] MISS ${entry.label} owner=${entry.owner} — ` +
          `${entry.lastError}; this texture will render BLACK`
        );
        continue;
      }
      // three re-uploads from image.data on the next render only if the
      // texture is marked dirty. The restore already cleared WebGLProperties
      // (three.module.js:16382), but the rehydrator may have been called for a
      // reason other than a restore, so mark it here regardless — a redundant
      // needsUpdate costs one upload, a missing one costs a black frame.
      try { tex.needsUpdate = true; } catch (_) { /* frozen stub in tests */ }
      entry.lastError = null;
      summary.rehydrated += 1;
      _stats.rehydrated += 1;
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: lanes }, runner));

  summary.ms = _now() - started;
  _stats.registered = _entries.size;
  if (summary.aborted) {
    _stats.aborted += 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[tex-rehydrate] pass ABANDONED after ${summary.ms.toFixed(0)}ms — ` +
      `superseded (second context loss); the next restore re-runs it`
    );
  } else if (summary.failed > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[tex-rehydrate] pass finished with ${summary.failed} MISS(es) in ` +
      `${summary.ms.toFixed(0)}ms (rehydrated=${summary.rehydrated} ` +
      `skipped=${summary.skipped} gcd=${summary.gcd}) — expect black textures`
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[tex-rehydrate] pass OK in ${summary.ms.toFixed(0)}ms ` +
      `(rehydrated=${summary.rehydrated} skipped=${summary.skipped} gcd=${summary.gcd})`
    );
  }
  _stats.lastPass = summary;
  return summary;
}

// ---------------------------------------------------------------------------
// test double + devtools
// ---------------------------------------------------------------------------

/**
 * THE TEST DOUBLE for the caller that does not exist yet.
 *
 * The releasing module (a separate work item) will do exactly this: drop the
 * pixel arrays after upload, then register a way to get them back. Shipping it
 * here means the registry + restore path are exercised end-to-end today, and
 * gives that work item a reference implementation to match.
 *
 * @param {Object} texture — a texture whose pixels are currently present.
 * @param {() => (Object|Promise<Object>)} refill — returns `{data}` for the
 *   image, or `{data, mipmaps:[{data},…]}`; resolve to null to simulate a miss.
 * @param {{label?: string, owner?: string}} [meta]
 * @returns {number} the registry id.
 */
export function releaseTextureDataForTest(texture, refill, meta = {}) {
  const bytes = texture?.image?.data?.byteLength ?? 0;
  // Release exactly what three would have re-uploaded from.
  if (texture.image && "data" in texture.image) texture.image.data = null;
  if (Array.isArray(texture.mipmaps)) {
    for (const m of texture.mipmaps) { if (m) m.data = null; }
  }
  return registerReleasedTexture(texture, async (tex) => {
    const fresh = await refill();
    if (!fresh) return false;           // a genuine miss — must be reported
    if (tex.image && fresh.data) tex.image.data = fresh.data;
    if (Array.isArray(tex.mipmaps) && Array.isArray(fresh.mipmaps)) {
      for (let i = 0; i < tex.mipmaps.length && i < fresh.mipmaps.length; i++) {
        if (tex.mipmaps[i]) tex.mipmaps[i].data = fresh.mipmaps[i].data;
      }
    }
    return true;
  }, { label: meta.label ?? "test-double", owner: meta.owner ?? "releaseTextureDataForTest", bytes });
}

/** Install `window.__textureRehydrate` — the diag surface. Called from
 *  `installWebglContextRecovery`, alongside `__loseContext`/`__restoreContext`,
 *  so the whole loss→restore→rehydrate cycle is drivable from one console. */
export function installTextureRehydrateDevtools() {
  if (typeof window === "undefined") return;
  window.__textureRehydrate = {
    stats: () => textureRehydrateStats(),
    count: () => releasedTextureCount(),
    /** Force a pass without losing the context — verifies rehydrators without
     *  a real GL event, which is the only way to test them on a machine where
     *  WEBGL_lose_context is unavailable. */
    run: (reason = "manual") => rehydrateReleasedTextures({ reason }),
  };
}

/** Test-only reset. */
export function __resetTextureRehydrateForTests() {
  _entries = new Map();
  _ids = new WeakMap();
  _nextId = 1;
  _chain = Promise.resolve();
  Object.assign(_stats, {
    registered: 0, everRegistered: 0, passes: 0, rehydrated: 0, skipped: 0,
    failed: 0, gcd: 0, timedOut: 0, aborted: 0, lastError: null, lastPass: null,
  });
}
