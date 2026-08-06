// scene3d/texture_census.js
//
// 2026-08-05 — WeakRef census over three.js TEXTURES, the instrument the
// renderer-OOM investigation is stuck without.
//
// WHY THIS EXISTS. On the 1070, after a six-town route, the tab sits at
// 2,508 MB of a 4,192 MB renderer cap (it crashes near 2,800). The wasm side
// is fully attributed and is not the crash (`__diag.wasmMem`: 630 MB, of which
// the unbounded shard cache is 307 MB). The JS heap is. `renderer.info` says
// 4,146 GL textures against 1,504 the scene can still reach.
//
// THAT COUNT DOES NOT MEAN WHAT IT LOOKS LIKE. In three r184
// `info.memory.textures` is decremented ONLY by `deleteTexture`
// (three.module.js:11397, plus render-target teardown at :11470), which runs
// only from an explicit `dispose()`. And three holds textures WEAKLY —
// `WebGLProperties` is `new WeakMap()` (:8054), as are `_sources` (:11009) and
// `_videoTextures` (:11005). So a texture that is never disposed but also never
// referenced again is collected by the GC completely normally, and the counter
// simply stays high forever. `gl − reachable` therefore proves "never
// disposed"; it says NOTHING about "still in the heap".
//
// This is not a hypothetical distinction. The same reasoning error on the
// GEOMETRY side produced "702 MB of leaked geometry", which a WeakRef census
// corrected to 28 MB orphaned-and-alive out of 71,318 traced — see §5 of
// `docs/2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md`.
//
// SO: trace every texture, hold it only WEAKLY, force a GC, and count what
// survived. A texture that is alive but unreachable from the scene graph is
// retained by something — a cache, a closure, a stale material — and its
// `image.data` bytes are sitting in the heap. That number, not the GL count,
// is the leak.
//
// DEFAULT OFF (`?texCensus=on`, strict exact-match opt-in): it holds one small
// record per texture for the life of the page, which is exactly the kind of
// retention this file exists to measure. Never enable it in a measurement of
// something else.

/** Strict `=on` opt-in — a diagnostic that itself retains must not read ON by accident. */
export function texCensusEnabled(search = (typeof location !== "undefined" ? location.search : "")) {
  try {
    return new URLSearchParams(search || "").get("texCensus") === "on";
  } catch (_) {
    return false;
  }
}

let installed = false;

/** Per-texture record. Holds the texture ONLY through a WeakRef — the whole
 *  point is that tracing must not keep anything alive. */
const entries = [];
const stats = {
  traced: 0,
  disposeCalls: 0,
  collected: 0,
  collectedBytesAtTrace: 0,
};

/** Owner probes: `name -> (texture) => boolean`. Registered by whoever owns a
 *  cache, so the census can say WHICH retainer is holding an orphan rather than
 *  only that one is. A texture matching no probe is reported as `unknown`,
 *  which is itself a finding. */
const ownerProbes = new Map();

export function registerTextureOwnerProbe(name, probe) {
  if (typeof probe === "function") ownerProbes.set(name, probe);
}

const finreg =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((meta) => {
        stats.collected += 1;
        stats.collectedBytesAtTrace += meta.bytes || 0;
      })
    : null;

/** Bytes a texture holds CPU-side, deduped by underlying ArrayBuffer.
 *
 *  Dedupe is load-bearing: several typed-array views can share one buffer
 *  (wasm-bindgen hands out `Uint8Array`/`Uint32Array`/`DataView` over the same
 *  memory), and counting each view separately is how the earlier
 *  "textures are ~1.2 GB CPU-side" figure went wrong. `seen` is supplied by the
 *  caller when summing ACROSS textures so a shared buffer is charged once to
 *  the whole census, not once per texture. */
export function textureCpuBytes(tex, seen) {
  let n = 0;
  // A LOCAL dedupe set is always used, even when the caller supplies none.
  // Verified against real three r184: `texture.image` and `texture.source.data`
  // are the SAME object, so walking both without dedupe double-charges every
  // DataTexture on the page. (Caught by the real-three smoke; the stub-based
  // unit test could not see it.)
  const marks = seen || new Set();
  const add = (arr) => {
    if (!arr || !arr.byteLength) return;
    // Charge the whole underlying ArrayBuffer, once. That is what retention
    // actually costs: while ANY view survives, the entire buffer is held. It
    // also collapses BC7 mip levels, which `parseHbc7` hands out as disjoint
    // `subarray` views over one payload — charging view lengths would report
    // less than the buffer that is actually pinned.
    const buf = arr.buffer;
    const key = buf || arr;
    if (marks.has(key)) return;
    marks.add(key);
    n += buf ? buf.byteLength : arr.byteLength;
  };
  try {
    const img = tex.image;
    if (img) {
      if (img.data) add(img.data);
      if (Array.isArray(img)) for (const f of img) if (f && f.data) add(f.data);
      // CompressedArrayTexture: image.depth layers, data per mip level.
      if (Array.isArray(img.mipmaps)) for (const m of img.mipmaps) if (m && m.data) add(m.data);
    }
    if (Array.isArray(tex.mipmaps)) for (const m of tex.mipmaps) if (m && m.data) add(m.data);
    if (Array.isArray(tex.source?.data)) {
      for (const f of tex.source.data) if (f && f.data) add(f.data);
    } else if (tex.source?.data?.data) {
      add(tex.source.data.data);
    }
  } catch (_) {
    /* a diagnostic must never throw into the render path */
  }
  return n;
}

function kindOf(tex) {
  if (tex.isCompressedArrayTexture) return "CompressedArrayTexture";
  if (tex.isCompressedTexture) return "CompressedTexture";
  if (tex.isDataArrayTexture) return "DataArrayTexture";
  if (tex.isData3DTexture) return "Data3DTexture";
  if (tex.isDataTexture) return "DataTexture";
  if (tex.isCanvasTexture) return "CanvasTexture";
  if (tex.isVideoTexture) return "VideoTexture";
  return tex.constructor?.name || "Texture";
}

/** First app frame in the stack — the call site that created this texture.
 *
 *  Lifted from the geometry WeakRef census that produced the corrected 28 MB
 *  figure: filter three/driver frames, then take the first app frame that is
 *  not the shared constructor helper, because `adapter.js` builds textures on
 *  behalf of half the renderer and naming it tells you nothing.
 *
 *  This is the attribution that actually points at a fix. Knowing WHO retains
 *  an orphan needs a heap snapshot; knowing who CREATED it is one stack scrape,
 *  and for a leak that repeats per landblock the two answers usually coincide. */
function originOf() {
  try {
    const lines = (new Error().stack || "").split("\n").slice(2, 20);
    const app = [];
    for (const l of lines) {
      // Drop the frames that are never the answer: three itself, the
      // automation driver, and this file. Matched on three's actual bundle
      // names and on `node_modules`, NOT on a bare `three.` — that also ate any
      // app file whose name merely contains "three." (caught by the real-three
      // suite, whose own filename does).
      if (/three\.module\.|three\.core\.|node_modules|playwright|UtilityScript|texture_census\.js/.test(l)) continue;
      const m = l.match(/([\w.-]+\.m?js)[^\s)]*:(\d+):\d+/);
      if (m) app.push(m[1] + ":" + m[2]);
    }
    return app.find((f) => !f.startsWith("adapter.js")) || app[0] || "(unknown)";
  } catch (_) {
    return "(unknown)";
  }
}

function trace(tex, originOverride) {
  if (tex.__texCensusTraced) return;
  tex.__texCensusTraced = true;
  const bytes = textureCpuBytes(tex, null);
  const rec = {
    ref: new WeakRef(tex),
    id: tex.id,
    kind: kindOf(tex),
    origin: originOverride || originOf(),
    w: tex.image?.width ?? 0,
    h: tex.image?.height ?? 0,
    bytesAtTrace: bytes,
    disposed: false,
  };
  entries.push(rec);
  stats.traced += 1;
  if (finreg) finreg.register(tex, { bytes }, tex);
}

/**
 * Install the hooks. Idempotent.
 *
 * Hooked on `Texture.prototype`, NOT on `EventDispatcher.prototype`: the
 * override then shadows the inherited method for textures only, and materials /
 * geometries / everything else keep the untouched implementation.
 *
 * The trace point is three's own `addEventListener('dispose', …)`, which
 * `WebGLTextures` calls once per texture at FIRST UPLOAD (three.module.js:11711)
 * — every texture that reaches the GPU passes through it, including ones this
 * app never constructs (addons, loaders, render targets). The alternative,
 * wrapping our own factories, would silently miss exactly those.
 *
 * CAVEAT, and it is why this installs at module-import time rather than from
 * `init3D`: a texture uploaded BEFORE the hook lands never calls
 * `addEventListener` again, so it is invisible to the census forever. Install
 * early; treat `traced` as a floor, not a total.
 */
export function installTextureCensus(THREE) {
  if (installed || !THREE?.Texture?.prototype) return installed;
  installed = true;

  const proto = THREE.Texture.prototype;

  // PRIMARY trace point: the `needsUpdate` SETTER (an accessor on
  // Texture.prototype in r184 — three.core.js:7963). Every texture the app
  // builds sets it immediately after construction, so this fires with the
  // CREATING call site on the stack. That matters: the upload hook below fires
  // from inside `renderer.render`, where the stack is the render loop and
  // `origin` would name `loop.js` for every texture on the page.
  const desc = Object.getOwnPropertyDescriptor(proto, "needsUpdate");
  if (desc && typeof desc.set === "function") {
    Object.defineProperty(proto, "needsUpdate", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        if (value === true && !this.__texCensusTraced) {
          try { trace(this); } catch (_) { /* never break a texture write */ }
        }
        return desc.set.call(this, value);
      },
    });
  }

  // BACKSTOP trace point: three's own `addEventListener('dispose', …)`, called
  // once per texture at first upload (three.module.js:11711). This is what
  // catches textures the app never touches — render targets, shadow maps,
  // BatchedMesh internals, addon-built textures — so the population can be
  // reconciled against `renderer.info.memory.textures` instead of leaving a
  // residual nobody can explain. Their `origin` is the render stack, and is
  // reported as such rather than pretending to name a creator.
  const inheritedAdd = proto.addEventListener;
  proto.addEventListener = function (type, listener) {
    if (type === "dispose" && this.isTexture) {
      try { trace(this, "(traced-at-upload)"); } catch (_) { /* never break an upload */ }
    }
    return inheritedAdd.call(this, type, listener);
  };

  const origDispose = proto.dispose;
  proto.dispose = function () {
    stats.disposeCalls += 1;
    if (this.__texCensusTraced) {
      // Mark rather than drop: a DISPOSED texture that is still ALIVE is its own
      // finding (the GPU side was released, the CPU bytes were not).
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].id === this.id) { entries[i].disposed = true; break; }
      }
    }
    return origDispose.call(this);
  };

  return installed;
}

/**
 * Take a census.
 *
 * CALL A GC FIRST or every dead texture reads as alive — from the driver:
 * `cdp.send('HeapProfiler.collectGarbage')`. There is no in-page way to force
 * one (`?texCensus=on` deliberately does not depend on `--expose-gc`).
 *
 * `scene` is optional; when supplied, every texture reachable from it is
 * excluded from the ORPHAN population, which is the number the fix hinges on:
 * bytes held by textures nothing in the scene points at any more.
 */
export function textureCensus(scene, renderer) {
  const reachable = new Set();
  if (scene) {
    const note = (t) => { if (t && t.isTexture) reachable.add(t.id); };
    const noteUniforms = (u) => {
      if (!u) return;
      for (const k of Object.keys(u)) {
        const v = u[k]?.value;
        if (v && v.isTexture) note(v);
        else if (Array.isArray(v)) for (const e of v) if (e && e.isTexture) note(e);
      }
    };
    try {
      scene.traverse((o) => {
        // BatchedMesh keeps its per-instance matrix / indirect / colour
        // DataTextures as OWN PROPERTIES, not on any material. Four subsystems
        // here render through BatchedMesh, so missing these would report every
        // one of them as an orphan.
        if (o.isBatchedMesh) {
          note(o._matricesTexture); note(o._indirectTexture); note(o._colorsTexture);
        }
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (!m) continue;
          for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) note(v); }
          noteUniforms(m.uniforms);
          // `onBeforeCompile` injects uniforms into a shader object the material
          // never stores — the statics atlas hands its 32 MB `DataArrayTexture`s
          // over that way (static_atlas.js:473-475), reachable ONLY through the
          // closure. three keeps the resolved bag at
          // `renderer.properties.get(material).uniforms` (three.module.js:18153),
          // which is the one public-ish route to it.
          //
          // This is not a detail. Without it the first live run of this census
          // reported 451 MB of live atlas as "orphaned and alive" — the exact
          // over-count class this file exists to prevent.
          if (renderer?.properties?.get) {
            try { noteUniforms(renderer.properties.get(m)?.uniforms); } catch (_) { /* not compiled yet */ }
          }
          // Anything a material stashed in userData (`_statPomUniforms` is the
          // whole shader.uniforms bag), one level of nesting deep.
          const ud = m.userData;
          if (ud && typeof ud === "object") {
            for (const k of Object.keys(ud)) {
              const v = ud[k];
              if (v && v.isTexture) note(v);
              else if (v && typeof v === "object") noteUniforms(v);
            }
          }
        }
      });
      note(scene.background);
      note(scene.environment);
    } catch (_) { /* partial reachability is still better than none */ }
  }

  // One shared `seen` across the whole walk: a buffer shared by two textures is
  // charged to the census once. Alive textures are measured LIVE (their image
  // data can be replaced after tracing), never from the trace-time snapshot.
  const seen = new Set();
  const out = {
    traced: stats.traced,
    disposeCalls: stats.disposeCalls,
    collected: stats.collected,
    alive: 0,
    aliveBytes: 0,
    orphanedAlive: 0,
    orphanedAliveBytes: 0,
    disposedButAlive: 0,
    disposedButAliveBytes: 0,
    canvasBackedOrEmpty: 0,
    pooled: 0,
    pooledBytes: 0,
    reachable: reachable.size,
    byKind: {},
    byOwner: {},
    byOrigin: {},
    aliveByOrigin: {},
    sceneSupplied: !!scene,
  };

  const kept = [];
  for (const rec of entries) {
    const tex = rec.ref.deref();
    if (!tex) continue; // collected — the healthy outcome
    kept.push(rec);
    const bytes = textureCpuBytes(tex, seen);
    // Canvas-backed textures (nameplates, speech bubbles, sky, blood decals)
    // have no typed array at all, so they contribute 0 to every byte total.
    // Counted separately rather than silently: they are real GPU objects and a
    // real part of the `renderer.info` count, just not part of the heap answer.
    if (bytes === 0 && !tex.isCompressedTexture) out.canvasBackedOrEmpty += 1;
    // Pooled per-LB planes (`terrain.js` `_installPoolDispose` overwrites
    // `dispose` as an OWN property and recycles instead of freeing). They live
    // for the page by design, so they would otherwise read as a permanent and
    // growing orphan population. Small — 324 B / 1536 B each.
    if (tex.userData?.__rp4Pooled) {
      out.pooled += 1;
      out.pooledBytes += bytes;
    }
    // Gate on "a scene was supplied", NOT on "the scene reached something".
    // A scene that legitimately reaches zero textures means every alive texture
    // IS an orphan; keying off `reachable.size > 0` would silently report that
    // worst case as a clean bill of health.
    const isOrphan = !!scene && !reachable.has(tex.id);
    out.alive += 1;
    out.aliveBytes += bytes;
    const k = (out.byKind[rec.kind] ??= { alive: 0, bytes: 0, orphanBytes: 0 });
    k.alive += 1;
    k.bytes += bytes;
    // Creation site for EVERY alive texture, not just the orphans. `byOrigin`
    // answers "who leaked it"; this answers "who is holding the resident
    // working set", which is the bigger number by 8× and the one that decides
    // where residency work goes (2026-08-05 §10: the 644 MB of
    // `DataArrayTexture` splits between over-allocated statics-atlas buckets
    // and terrain one-shot arrays, and nobody knew the ratio).
    const ao = (out.aliveByOrigin[rec.origin] ??= { count: 0, bytes: 0, kind: rec.kind });
    ao.count += 1;
    ao.bytes += bytes;
    if (isOrphan) {
      out.orphanedAlive += 1;
      out.orphanedAliveBytes += bytes;
      k.orphanBytes += bytes;
      let named = false;
      for (const [name, probe] of ownerProbes) {
        let hit = false;
        try { hit = !!probe(tex); } catch (_) { hit = false; }
        if (hit) {
          const o = (out.byOwner[name] ??= { count: 0, bytes: 0 });
          o.count += 1;
          o.bytes += bytes;
          named = true;
        }
      }
      if (!named) {
        const o = (out.byOwner.unknown ??= { count: 0, bytes: 0 });
        o.count += 1;
        o.bytes += bytes;
      }
      // Creation site, always — for an orphan no probe claims, this is the
      // only thing in the report that points anywhere.
      const org = (out.byOrigin[rec.origin] ??= { count: 0, bytes: 0 });
      org.count += 1;
      org.bytes += bytes;
    }
    if (rec.disposed) {
      out.disposedButAlive += 1;
      out.disposedButAliveBytes += bytes;
    }
  }
  // Compact: collected entries never need visiting again.
  entries.length = 0;
  entries.push(...kept);

  // Handed back so a caller can charge OTHER holders against the same dedupe
  // set and report only what they hold independently of these textures.
  out.__seenBuffers = seen;
  const mb = (n) => (n / 1048576).toFixed(1) + "MB";
  out.topOwners = Object.entries(out.byOwner)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([n, v]) => `${n} ${mb(v.bytes)} (${v.count})`);
  out.topOrigins = Object.entries(out.byOrigin)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 8)
    .map(([n, v]) => `${n} ${mb(v.bytes)} (${v.count})`);
  out.topAliveOrigins = Object.entries(out.aliveByOrigin)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([n, v]) => `${n} ${mb(v.bytes)} (${v.count} ${v.kind})`);
  out.topKinds = Object.entries(out.byKind)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([n, v]) => `${n} ${mb(v.bytes)} alive=${v.alive} orphan=${mb(v.orphanBytes)}`);
  return out;
}

/** Reset the traced population. Test hook; not used by the page. */
export function __resetTextureCensusForTests() {
  entries.length = 0;
  stats.traced = 0;
  stats.disposeCalls = 0;
  stats.collected = 0;
  stats.collectedBytesAtTrace = 0;
  ownerProbes.clear();
  installed = false;
}
