// scene3d/gpu_batch/array_pages.js — R3-3 K1: the GL half of the texture-array
// pages (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 1; the bookkeeping
// half is page_allocator.js).
//
// THE MIPS ARE THE DRIVER'S. Surface textures today are RGBA8 DataTextures
// that three uploads with texStorage2D(full chain) + texSubImage2D(level 0) +
// gl.generateMipmap (adapter.js surfacePixelsToTexture: generateMipmaps =
// true). An array layer must hold those exact bytes at every level, so an
// RGBA8 layer is admitted like this:
//   1. the source 2D texture is uploaded by THREE ITSELF (`renderer.initTexture`
//      — the very texStorage2D / texSubImage2D / generateMipmap sequence the
//      legacy draw would have issued; a texture already resident is not
//      touched). For pixels that never had a texture (`admitPixels`), a
//      scratch DataTexture configured exactly like surfacePixelsToTexture is
//      uploaded the same way and disposed after the copy;
//   2. each level is copied GPU-side into (layer, level):
//      framebufferTexture2D(READ_FRAMEBUFFER, level) + copyTexSubImage3D.
// Never r184's `layerUpdates` + generateMipmap (that re-mips EVERY layer of
// the array on each admit), and never Rust-built mips (not the driver's).
// `admitAs(tex, key)` (R3-4 real boot, 2026-10-31) is admit() under a
// caller-chosen content key: the copy source is `tex`'s own resident levels
// (no scratch upload); `isResident(tex)` says whether three already holds it
// on the live generation. A layer's bytes are booked against the frame's
// budget only once the allocator granted it (a cap refusal books nothing).
// BC7 layers copy their baked levels with compressedTexSubImage3D (a
// compressed format cannot be a framebuffer attachment).
// WHY AN ADMIT WAS REFUSED (R3-5 real boot, 2026-10-31). admit() / admitAs()
// / admitPixels() return null for three different reasons, and a consumer
// must not treat them alike: `lastRefusal` says which one the last null was —
// "unsupported" (the kit can never hold this texture: describeTexture or the
// context's internal format), "cap" (the allocator refused a page: the byte
// cap, after its reclaim / fit; room can appear later), "failed" (the GL copy
// or upload failed; the layer was abandoned). It is null after any other
// result. `wouldAdmit(tex, opts)` answers "would the admit get a layer now"
// with no side effect (no budget, no counter); `neverFits(tex, opts)` is true
// when no amount of freed room could hold it (unsupported, or one layer is
// larger than the whole cap). interior_batch.js waits on "cap" instead of
// re-planning (its header "PAGE-FULL WAITS").
//
// R8 layers (2026-10-31: the POM seam-height planes, adapter.js
// surfacePixelsToHeightTexture: RedFormat / UnsignedByteType / NoColorSpace,
// generateMipmaps) take the RGBA8 path: three uploads the 2D R8 texture
// itself (texStorage2D(R8) + texSubImage2D + generateMipmap), and each level
// is copied into an R8 page (R8 is colour-renderable in WebGL2, and
// copyTexSubImage3D from an R8 read buffer into R8 storage is a legal,
// component-preserving copy). R8 is OPT-IN (`describeTexture(tex, R8_PLANES)`,
// `admit(tex, budget, R8_PLANES)`): without it an R8 texture is refused
// exactly as before (an R8 MAP stays "map-format" for every consumer), so
// every admit that existed keeps its descriptor (and page key).
//
// SAME SAMPLER STATE. The page's GL texture carries the source's wrap S/T,
// min/mag filter and (effective) anisotropy, set with the same rules as
// three's setTextureParameters; the page key (page_allocator.pageKeyOf)
// guarantees every layer of a page wants the same state.
//
// BINDING. Each page's GL texture is wrapped in a three `ExternalTexture`
// (r184: setTexture2DArray binds `sourceTexture` directly, no upload, no
// parameter writes), so a class material just puts it in a sampler2DArray
// uniform.
//
// GL STATE HYGIENE. three caches its bindings (WebGLState). Every raw call
// here saves the GL binding it changes with getParameter (client-side state
// in Chrome, no GPU round trip) and restores it, so three's cache stays true.
//
// CONTEXT LOSS AND RESTORE destroy the pages. A restore keeps the renderer
// object: three's onContextRestore builds a NEW WebGLProperties (and program
// cache, buffers, textures) and assigns it to `renderer.properties`, so every
// GL object made before it is dead on the restored context even though
// `gl.isContextLost()` is false again. The pages therefore remember the
// GL-context GENERATION they were made on (`glContextGeneration`: the
// renderer's properties object) and `contextLost()` is true after a loss AND
// after a restore, whichever a consumer sees first (a loss and a restore can
// both land between two of its ticks). `reset()` drops every page and starts
// a new `generation`; a consumer keys what it built by that number and
// rebuilds from the sources (the next admit uploads again).
//
// NO GL DELETES ON A DEAD GENERATION (K3, 2026-10-30). A page made on a lost
// context is dropped without deleteTexture / deleteFramebuffer, whoever
// drops it (`reset`, `dispose`, the allocator's `trim`) and whether or not
// anyone called `contextLost()` first: each of them re-checks the
// generation (`_destroyPageGl` per page; reset / dispose for the copy
// framebuffer, which outlives a trim that emptied the pages). The same
// rule for the kit's THREE resources (a consumer's merged geometry, the
// state-row texture) is `trackContextGenerations` + `disposeOnLiveContext`
// below. Admits are timed (`budget.addMs("layer", ...)`, S1).

import * as THREE from "three";
import { PageAllocator, fullMipLevels, levelSize, layerBytesOf } from "./page_allocator.js";
import { UPLOAD_KIND, uploadNowMs } from "./upload_budget.js";

// GL enums are read off the context (as three's WebGLUtils does), with the
// WebGL2 values as the fallback.
function _wrapToGl(gl, w) {
  if (w === THREE.RepeatWrapping) return gl.REPEAT ?? 0x2901;
  if (w === THREE.MirroredRepeatWrapping) return gl.MIRRORED_REPEAT ?? 0x8370;
  return gl.CLAMP_TO_EDGE ?? 0x812f;
}
function _filterToGl(gl, f) {
  switch (f) {
    case THREE.NearestFilter: return gl.NEAREST ?? 0x2600;
    case THREE.NearestMipmapNearestFilter: return gl.NEAREST_MIPMAP_NEAREST ?? 0x2700;
    case THREE.NearestMipmapLinearFilter: return gl.NEAREST_MIPMAP_LINEAR ?? 0x2702;
    case THREE.LinearMipmapNearestFilter: return gl.LINEAR_MIPMAP_NEAREST ?? 0x2701;
    case THREE.LinearMipmapLinearFilter: return gl.LINEAR_MIPMAP_LINEAR ?? 0x2703;
    default: return gl.LINEAR ?? 0x2601;
  }
}

/** describeTexture / admit option: also accept plain linear R8 planes (the POM height maps). */
export const R8_PLANES = Object.freeze({ r8: true });

/**
 * The page descriptor for a texture, or null when the kit cannot hold it
 * byte-exactly (anything but a plain RGBA8 DataTexture, a single BC7
 * CompressedTexture with every level's blocks still in memory or, with
 * `opts.r8`, a plain linear R8 DataTexture; any unpack flag or uv transform
 * that would change what is sampled).
 */
export function describeTexture(tex, opts = null) {
  if (!tex || !tex.isTexture || tex.isRenderTargetTexture || tex.isExternalTexture) return null;
  if (tex.isDataArrayTexture || tex.isCompressedArrayTexture || tex.isData3DTexture || tex.isCubeTexture) return null;
  if (tex.internalFormat !== null && tex.internalFormat !== undefined) return null;
  if (tex.channel !== 0) return null;
  if (!tex.matrix || !tex.matrix.equals(_IDENTITY3)) return null;
  if (tex.offset.x !== 0 || tex.offset.y !== 0 || tex.repeat.x !== 1 || tex.repeat.y !== 1 || tex.rotation !== 0) return null;
  if (tex.compareFunction) return null;
  const img = tex.image;
  const w = img && img.width | 0;
  const h = img && img.height | 0;
  if (!(w > 0 && h > 0)) return null;
  const base = {
    width: w, height: h, colorSpace: tex.colorSpace,
    wrapS: tex.wrapS, wrapT: tex.wrapT, minFilter: tex.minFilter, magFilter: tex.magFilter,
    anisotropy: tex.anisotropy || 1,
  };
  if (tex.isCompressedTexture) {
    if (tex.format !== THREE.RGBA_BPTC_Format) return null;
    const mips = tex.mipmaps;
    if (!Array.isArray(mips) || mips.length === 0) return null;
    for (let l = 0; l < mips.length; l += 1) {
      const m = mips[l];
      const [lw, lh] = levelSize(w, h, l);
      if (!m || !m.data || m.width !== lw || m.height !== lh) return null;
    }
    return { format: "bc7", levels: mips.length, ...base };
  }
  if (!tex.isDataTexture) return null;
  if (opts && opts.r8 === true && tex.format === THREE.RedFormat && tex.type === THREE.UnsignedByteType) {
    // R8: linear only (three allocates R8 for NoColorSpace / LinearSRGB; an
    // sR8 plane would need an extension three does not use for RedFormat).
    if (tex.colorSpace !== THREE.NoColorSpace && tex.colorSpace !== THREE.LinearSRGBColorSpace) return null;
    const levelsR = tex.generateMipmaps
      ? fullMipLevels(w, h)
      : (Array.isArray(tex.mipmaps) && tex.mipmaps.length > 0 ? tex.mipmaps.length : 1);
    return { format: "r8", levels: levelsR, ...base };
  }
  if (tex.format !== THREE.RGBAFormat || tex.type !== THREE.UnsignedByteType) return null;
  // Unpack flags (flipY, premultiplyAlpha, unpackAlignment) shape the bytes
  // THREE uploads into the 2D texture; the admit copies those GPU bytes, so
  // they need no check here. The colour space decides the internal format
  // (SRGB8_ALPHA8 vs RGBA8) and copyTexSubImage3D needs them to agree.
  if (tex.colorSpace !== THREE.SRGBColorSpace && tex.colorSpace !== THREE.NoColorSpace && tex.colorSpace !== THREE.LinearSRGBColorSpace) return null;
  const levels = tex.generateMipmaps
    ? fullMipLevels(w, h)
    : (Array.isArray(tex.mipmaps) && tex.mipmaps.length > 0 ? tex.mipmaps.length : 1);
  return { format: "rgba8", levels, ...base };
}
const _IDENTITY3 = new THREE.Matrix3();

/** Content key: a texture's bytes change only with a new upload (version). */
export function contentKeyOf(tex) {
  return `${tex.uuid}:${tex.version}`;
}

function _isSrgb(cs) {
  return cs === THREE.SRGBColorSpace;
}

/**
 * The renderer's GL-context generation: the object three swaps on a context
 * restore (`renderer.properties`, a new WebGLProperties from
 * onContextRestore -> initGLContext; async_link_guard.js "CONTEXT RESTORE").
 * Two reads return the same object iff no restore happened in between.
 * shader_prewarm.js keys its batch warm set the same way.
 */
export function glContextGeneration(renderer) {
  return (renderer && renderer.properties) || renderer || null;
}

/** The generation of a context that is lost RIGHT NOW (no GL object is live on it). */
export const LOST_CONTEXT_GENERATION = Object.freeze({ lostContext: true });

/**
 * The generation whose GL objects are live now: `glContextGeneration`, or
 * LOST_CONTEXT_GENERATION while `gl.isContextLost()` (between a loss and its
 * restore nothing is live: three swaps renderer.properties only at the
 * restore).
 */
export function liveContextGeneration(renderer) {
  if (!renderer) return null;
  try {
    const gl = renderer.getContext();
    if (gl && gl.isContextLost() === true) return LOST_CONTEXT_GENERATION;
  } catch (_) { /* no context: the properties object decides */ }
  return glContextGeneration(renderer);
}

// ---------------------------------------------------------------------------
// Kit-owned THREE resources across a context loss / restore.
//
// three's per-context modules (r184 WebGLGeometries + WebGLAttributes +
// WebGLBindingStates, WebGLTextures) add a 'dispose' listener to a geometry or
// texture the first time THEY upload it, and that listener deletes THEIR GL
// objects (deleteBuffer per attribute and index, deleteVertexArray per
// program, deleteTexture). A restore builds new modules but cannot take the
// old listener back off the object, so a later dispose() runs it: it deletes
// ids of the lost context on the restored one (Chrome: "INVALID_OPERATION:
// delete: object does not belong to this context"). And when the object was
// drawn again after the restore, the new generation's listener sits next to
// it and must still run (else the new buffers leak on the live context).
//
// `trackContextGenerations(obj, generationOf)` records, for every 'dispose'
// listener added to `obj`, the generation that was live when it was added
// (three adds it in the call that uploads, so that is the generation the GL
// objects belong to). `disposeOnLiveContext(obj)` takes every listener of
// another generation (all of them while the context is lost) off before
// dispose(): only GL objects of the live context are deleted; the dead ones
// go with their generation. Untracked objects just dispose().
// ---------------------------------------------------------------------------
const _tracked = new WeakMap(); // obj -> { generationOf, gens: Map(listener -> generation) }

/**
 * Tag `obj`'s future 'dispose' listeners with `generationOf()` (call it once,
 * at creation, before three ever sees the object). `onAdd(listener)`, when
 * given, is called on each new 'dispose' listener (three's first touch of
 * the object in a generation; consumers time uploads from it). Returns obj.
 */
export function trackContextGenerations(obj, generationOf, onAdd) {
  if (!obj || typeof obj.addEventListener !== "function" || _tracked.has(obj)) return obj;
  const gens = new Map();
  _tracked.set(obj, { generationOf, gens });
  const add = obj.addEventListener;
  Object.defineProperty(obj, "addEventListener", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function hbTrackedAddEventListener(type, listener) {
      if (type === "dispose" && !gens.has(listener)) {
        let gen;
        try { gen = generationOf(); } catch (_) { gen = null; }
        gens.set(listener, gen);
        if (onAdd) { try { onAdd(listener); } catch (_) { /* diag only */ } }
      }
      return add.call(this, type, listener);
    },
  });
  return obj;
}

/** dispose() `obj`, running only the 'dispose' listeners of the live generation (see above). */
export function disposeOnLiveContext(obj) {
  if (!obj) return;
  const t = _tracked.get(obj);
  if (t) {
    let live;
    try { live = t.generationOf(); } catch (_) { live = null; }
    for (const [listener, gen] of t.gens) {
      if (live === LOST_CONTEXT_GENERATION || gen !== live) obj.removeEventListener("dispose", listener);
    }
    t.gens.clear();
  }
  obj.dispose();
}

export class ArrayPages {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [opts] PageAllocator options (pageBytes, maxLayers, maxBytes, minLayers)
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this._fbo = null;
    this._lost = false;
    /** The GL-context generation the pages live on (see glContextGeneration). */
    this.ctx = glContextGeneration(renderer);
    /** Bumped by every `reset()`: what a consumer built against an older value is gone. */
    this.generation = 0;
    let maxLayers = opts.maxLayers;
    try {
      const gl = renderer.getContext();
      const cap = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) | 0;
      if (cap > 0) maxLayers = Math.min(maxLayers ?? cap, cap);
    } catch (_) { /* keep opts */ }
    this.alloc = new PageAllocator({
      ...opts,
      maxLayers,
      onPageCreate: (page) => this._createPageGl(page),
      onPageDestroy: (page) => this._destroyPageGl(page),
    });
    this.stats = { admits: 0, admitBytes: 0, copiedLevels: 0, bc7Levels: 0, deferred: 0, unsupported: 0, failed: 0, scratch: 0, capRefused: 0 };
    /** Why the last admit returned null: "unsupported" | "cap" | "failed" (null otherwise). See the header. */
    this.lastRefusal = null;
  }

  /**
   * Would admit(tex, budget, opts) get a layer now (the budget aside)? No
   * side effect: no budget, no allocator counter, no GL. `contentKey` as in
   * admitAs (null = the texture's identity key).
   */
  wouldAdmit(tex, opts = null, contentKey = null) {
    if (this.contextLost()) return false;
    const desc = describeTexture(tex, opts);
    if (!desc || !this.internalFormatOf(desc)) return false;
    const ck = contentKey === null || contentKey === undefined ? contentKeyOf(tex) : contentKey;
    return this.alloc.wouldAcquire(desc, ck);
  }

  /**
   * Can `tex` never get a layer, whatever is released (unsupported here, or
   * one layer larger than the whole cap)?
   */
  neverFits(tex, opts = null) {
    const desc = describeTexture(tex, opts);
    if (!desc || !this.internalFormatOf(desc)) return true;
    return layerBytesOf(desc) > this.alloc.maxBytes;
  }

  get gl() { return this.renderer.getContext(); }

  _bptcExt() {
    try { return this.renderer.extensions.get("EXT_texture_compression_bptc"); } catch (_) { return null; }
  }

  /** The internal format three would allocate the source with (0 = unsupported). */
  internalFormatOf(desc) {
    if (desc.format === "bc7") {
      const ext = this._bptcExt();
      if (!ext) return 0;
      return _isSrgb(desc.colorSpace)
        ? (ext.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT ?? 0x8e8d)
        : (ext.COMPRESSED_RGBA_BPTC_UNORM_EXT ?? 0x8e8c);
    }
    const gl = this.gl;
    if (desc.format === "r8") return gl.R8 ?? 0x8229;
    return _isSrgb(desc.colorSpace) ? (gl.SRGB8_ALPHA8 ?? 0x8c43) : (gl.RGBA8 ?? 0x8058);
  }

  _createPageGl(page) {
    const gl = this.gl;
    const d = page.desc;
    const ifmt = this.internalFormatOf(d);
    if (!ifmt || this._lost) return false;
    const tex = gl.createTexture();
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, d.levels, ifmt, d.width, d.height, page.capacity);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, _wrapToGl(gl, d.wrapS));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, _wrapToGl(gl, d.wrapT));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, _wrapToGl(gl, THREE.ClampToEdgeWrapping));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, _filterToGl(gl, d.magFilter));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, _filterToGl(gl, d.minFilter));
    // Anisotropy: three's setTextureParameters rule, verbatim in effect.
    const ext = (() => { try { return this.renderer.extensions.get("EXT_texture_filter_anisotropic"); } catch (_) { return null; } })();
    if (ext && d.magFilter !== THREE.NearestFilter
      && (d.minFilter === THREE.NearestMipmapLinearFilter || d.minFilter === THREE.LinearMipmapLinearFilter)
      && d.anisotropy > 1) {
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(d.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, prev);
    const ext3 = new THREE.ExternalTexture(tex);
    ext3.name = `gpu-batch-page-${page.id}`;
    page.gl = { tex, texture: ext3, internalFormat: ifmt };
    return true;
  }

  _destroyPageGl(page) {
    if (!page.gl) return;
    // A page of a dead generation is dropped, never deleted on the live one.
    try { if (!this.contextLost()) this.gl.deleteTexture(page.gl.tex); } catch (_) { /* fail-soft */ }
    page.gl = null;
  }

  /**
   * True once the context was lost OR restored since the pages were made
   * (the generation changed): every page is a dead GL object; call `reset()`.
   */
  contextLost() {
    if (this._lost) return true;
    let lost = false;
    try { lost = this.gl.isContextLost() === true; } catch (_) { lost = false; }
    // Lost and restored between two checks: not lost NOW, but every page was
    // made on the context that is gone.
    if (!lost && glContextGeneration(this.renderer) !== this.ctx) lost = true;
    this._lost = lost;
    return lost;
  }

  /**
   * Drop every page (after a context loss / restore, or teardown) and start a
   * new generation on the renderer's current context. Pages of a lost
   * context are dropped without GL calls (their objects are dead).
   */
  reset() {
    // Re-check the generation first: a caller that did not ask contextLost()
    // (a canvas event, another consumer, resetKit) must not delete pages of a
    // lost context on the restored one.
    this.contextLost();
    this.alloc.clear();
    if (this._fbo && !this._lost) { try { this.gl.deleteFramebuffer(this._fbo); } catch (_) { /* fail-soft */ } }
    this._fbo = null;
    this.ctx = glContextGeneration(this.renderer);
    try { this._lost = this.gl.isContextLost() === true; } catch (_) { this._lost = false; }
    this.generation += 1;
  }

  /**
   * Take a reference on `tex`'s layer, uploading it when not resident.
   * Returns `{ page, layer, contentKey }`, `{ deferred: true }` when the
   * frame's upload budget refused the admit (try again next frame), or null
   * when the texture cannot live in a page (the consumer keeps its legacy
   * path for it).
   */
  admit(tex, budget, opts = null) {
    return this.admitAs(tex, null, budget, opts);
  }

  /**
   * The budget gate of a fresh layer (R3-4 real boot, 2026-10-31): a frame
   * without room defers (counted as the budget's refusal, as before); a
   * frame with room books the bytes only once the allocator has granted the
   * layer, so an allocator refusal (the byte cap) books nothing.
   */
  _budgetOpen(budget, bytes) {
    if (!budget || budget.canSpend(bytes, UPLOAD_KIND.LAYER)) return true;
    budget.trySpend(bytes, UPLOAD_KIND.LAYER); // refused: books the refusal, nothing else
    this.stats.deferred += 1;
    return false;
  }

  /**
   * Is `tex` uploaded on the LIVE generation at its current version (three's
   * own 2D texture, from the legacy draw)? A copy from it then needs no
   * upload of its bytes.
   */
  isResident(tex) {
    if (!tex || this.contextLost()) return false;
    let props = null;
    try { props = this.renderer.properties.get(tex); } catch (_) { props = null; }
    return !!(props && props.__webglTexture && props.__version === tex.version);
  }

  /**
   * `admit(tex)` under the caller's content key (`contentKey` null = the
   * texture's identity key): the layer is a GPU copy of `tex`'s OWN levels
   * (three's 2D texture, uploaded by three if it is not resident). R3-4 uses
   * it for a value-keyed composite whose legacy texture is already resident:
   * the very texels the legacy draw samples, no scratch upload. Returns as
   * admit(). `opts`: describeTexture's (R8_PLANES admits an R8 plane).
   */
  admitAs(tex, contentKey, budget, opts = null) {
    this.lastRefusal = null;
    // Lost (or restored onto a new generation): wait, nothing is uploaded
    // into a dead page; the consumer resets and re-plans.
    if (this.contextLost()) return { deferred: true, lost: true };
    const desc = describeTexture(tex, opts);
    if (!desc || !this.internalFormatOf(desc)) { this.stats.unsupported += 1; this.lastRefusal = "unsupported"; return null; }
    const ck = contentKey === null || contentKey === undefined ? contentKeyOf(tex) : contentKey;
    if (!this.alloc.needsUpload(ck)) {
      const e = this.alloc.acquire(desc, ck);
      return { page: e.page, layer: e.layer, contentKey: ck };
    }
    const bytes = layerBytesOf(desc);
    if (!this._budgetOpen(budget, bytes)) return { deferred: true };
    const t0 = uploadNowMs();
    const e = this.alloc.acquire(desc, ck);
    if (!e) { this.stats.capRefused += 1; this.lastRefusal = "cap"; return null; }
    if (budget) budget.trySpend(bytes, UPLOAD_KIND.LAYER); // room checked above, nothing booked since
    const ok = desc.format === "bc7" ? this._uploadBc7(tex, e.page, e.layer) : this._copyRgba8(tex, e.page, e.layer);
    if (!ok) { this.alloc.abandon(ck); this.stats.failed += 1; this.lastRefusal = "failed"; return null; }
    this.stats.admits += 1;
    this.stats.admitBytes += bytes;
    // S1: CPU ms of the admit's GL work (page creation, three's upload of a
    // non-resident source, the per-level copies / compressed uploads).
    if (budget && typeof budget.addMs === "function") budget.addMs(UPLOAD_KIND.LAYER, uploadNowMs() - t0);
    return { page: e.page, layer: e.layer, contentKey: ck };
  }

  /**
   * Admit raw RGBA8 pixels that have no texture yet (R3-4's palette
   * composites): a scratch DataTexture set up EXACTLY like adapter.js
   * surfacePixelsToTexture (sRGB, flipY false, Linear / LinearMipmapLinear,
   * generateMipmaps, `anisotropy`, wrap), uploaded by three, copied level by
   * level, disposed. `contentKey` is the caller's (value-keyed) identity.
   */
  admitPixels(rgba, width, height, opts, contentKey, budget) {
    this.lastRefusal = null;
    if (this.contextLost()) return { deferred: true, lost: true };
    const scratch = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    scratch.colorSpace = opts?.colorSpace ?? THREE.SRGBColorSpace;
    scratch.flipY = false;
    scratch.magFilter = THREE.LinearFilter;
    scratch.minFilter = THREE.LinearMipmapLinearFilter;
    scratch.generateMipmaps = true;
    scratch.anisotropy = opts?.anisotropy ?? 1;
    scratch.wrapS = opts?.wrapS ?? THREE.RepeatWrapping;
    scratch.wrapT = opts?.wrapT ?? THREE.RepeatWrapping;
    scratch.needsUpdate = true;
    const desc = describeTexture(scratch);
    if (!desc) { this.stats.unsupported += 1; this.lastRefusal = "unsupported"; return null; }
    if (!this.alloc.needsUpload(contentKey)) {
      const e = this.alloc.acquire(desc, contentKey);
      return { page: e.page, layer: e.layer, contentKey };
    }
    const bytes = layerBytesOf(desc);
    if (!this._budgetOpen(budget, bytes)) return { deferred: true };
    const t0 = uploadNowMs();
    const e = this.alloc.acquire(desc, contentKey);
    if (!e) { this.stats.capRefused += 1; this.lastRefusal = "cap"; return null; }
    if (budget) budget.trySpend(bytes, UPLOAD_KIND.LAYER); // room checked above, nothing booked since
    const ok = this._copyRgba8(scratch, e.page, e.layer);
    try { scratch.dispose(); } catch (_) { /* fail-soft */ }
    this.stats.scratch += 1;
    if (!ok) { this.alloc.abandon(contentKey); this.stats.failed += 1; this.lastRefusal = "failed"; return null; }
    this.stats.admits += 1;
    this.stats.admitBytes += bytes;
    if (budget && typeof budget.addMs === "function") budget.addMs(UPLOAD_KIND.LAYER, uploadNowMs() - t0);
    return { page: e.page, layer: e.layer, contentKey };
  }

  /** Drop one reference (the layer idles, content kept for a re-acquire). */
  release(contentKey) {
    return this.alloc.release(contentKey);
  }

  _webglTextureOf(tex) {
    const r = this.renderer;
    let props = r.properties.get(tex);
    if (!props.__webglTexture || (tex.version > 0 && props.__version !== tex.version)) {
      r.initTexture(tex); // three's own upload path (generateMipmap included)
      props = r.properties.get(tex);
    }
    return props.__webglTexture || null;
  }

  /** Per-level GPU copy of three's own 2D upload of `tex` into (layer, level): RGBA8 and R8 pages. */
  _copyRgba8(tex, page, layer) {
    const gl = this.gl;
    const src = this._webglTextureOf(tex);
    if (!src || !page.gl) return false;
    const d = page.desc;
    if (!this._fbo) this._fbo = gl.createFramebuffer();
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const prevArr = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fbo);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, page.gl.tex);
    for (let l = 0; l < d.levels; l += 1) {
      const [w, h] = levelSize(d.width, d.height, l);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, l);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, layer, 0, 0, w, h);
      this.stats.copiedLevels += 1;
    }
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, prevArr);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    return true;
  }

  _uploadBc7(tex, page, layer) {
    const gl = this.gl;
    if (!page.gl) return false;
    const d = page.desc;
    const prevArr = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, page.gl.tex);
    for (let l = 0; l < d.levels; l += 1) {
      const m = tex.mipmaps[l];
      gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, layer, m.width, m.height, 1, page.gl.internalFormat, m.data);
      this.stats.bc7Levels += 1;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, prevArr);
    return true;
  }

  /**
   * Read one layer level back (smoke / 1070 probe) as RGBA8 bytes (an R8
   * layer reads back as (r, 0, 0, 255): readPixels RGBA / UNSIGNED_BYTE, the
   * same conversion `readTexture2D` applies to the legacy R8 texture).
   */
  readLayer(page, layer, level = 0) {
    const gl = this.gl;
    const [w, h] = levelSize(page.desc.width, page.desc.height, level);
    const out = new Uint8Array(w * h * 4);
    if (!this._fbo) this._fbo = gl.createFramebuffer();
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fbo);
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, page.gl.tex, level, layer);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    return out;
  }

  /** Read one level of a resident RGBA8 (or R8) 2D texture back (the legacy side of the comparison). */
  readTexture2D(tex, level = 0) {
    const gl = this.gl;
    const src = this._webglTextureOf(tex);
    const [w, h] = levelSize(tex.image.width, tex.image.height, level);
    const out = new Uint8Array(w * h * 4);
    if (!this._fbo) this._fbo = gl.createFramebuffer();
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, level);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    return out;
  }

  summary() {
    return { ...this.alloc.summary(), generation: this.generation, gl: { ...this.stats } };
  }

  dispose() {
    this.contextLost(); // as in reset(): no deletes on a dead generation
    this.alloc.clear();
    if (this._fbo && !this._lost) { try { this.gl.deleteFramebuffer(this._fbo); } catch (_) { /* fail-soft */ } }
    this._fbo = null;
  }
}
