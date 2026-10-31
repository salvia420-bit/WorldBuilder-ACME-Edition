// scene3d/gpu_batch/page_allocator.js — R3-3 K1: the bookkeeping half of the
// texture-array pages (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 1).
//
// WHAT A PAGE IS. One native-size `sampler2DArray` per (width, height, format,
// mip count, colour space, sampler state). Every layer of a page has exactly
// the dimensions of the texture it replaces (no atlas packing, no rescale), so
// a layer sampled with the page's sampler reads the very texels the 2D
// texture held. The sampler state is part of the key because WebGL2 keeps it
// on the texture object: two textures that differ only in wrap mode cannot
// share a page without changing what is sampled.
//
// THIS FILE is pure (no GL, no three): which page and layer a piece of
// content lives in, the per-layer refcounts, the free lists and eviction.
// `array_pages.js` owns the GL objects and the uploads and plugs in through
// `onPageCreate` / `onPageDestroy`.
//
// LAYER LIFECYCLE. A layer is in exactly one of three states:
//   free  — no content (on its page's free list);
//   live  — content resident, refcount > 0;
//   idle  — content resident, refcount 0, kept so a re-acquire of the same
//           content costs no upload (LRU over all pages, oldest first).
// `acquire` takes, in order: the content's own layer (live or idle), a free
// layer of a page with the same key, the oldest idle layer of a page with the
// same key (evicted: its content is dropped), and only then a new page.
//
// PAGE SIZE. A key's first page holds floor(pageBytes / layerBytes) layers,
// clamped to [minLayers, maxLayers] (OpenAC's composite arrays: about 4 MiB
// and at most 64 layers, CompositeTextureArrayCache.cs:236-240). Each further
// page of the same key is x1.5 the previous one (`PAGE_GROWTH`), up to
// maxLayers. Pages are never resized: growing an immutable (texStorage3D)
// array means a GPU copy of every resident layer, so the next page is a new
// array instead (one more draw for the consumer, no copy, no hitch).
// `maxBytes` caps the whole allocator; past it `acquire` returns null and the
// consumer keeps its legacy path for that content.
//
// AT THE CAP (opt-in, R3-4 real boot 2026-10-31; both default OFF, so an
// allocator built without them behaves exactly as above). The cap counts
// RESERVED bytes (whole pages), and a key's next page is x1.5 its last, so a
// big-texture key (512x512: 1.4 MB a layer) can be refused a 29 MB growth
// page while the cap still has room for several of its layers, and idle
// layers of OTHER keys (departed content nobody re-acquired) pin whole pages
// for good (nothing trims during a session):
//   - `reclaimIdle`: before refusing a new page, destroy pages that hold no
//     LIVE layer (their idle content is evicted, oldest idle first) until the
//     page fits (`stats.reclaimedPages` / `reclaimedBytes`);
//   - `fitToCap`: if it still does not fit, the new page shrinks to at most
//     `minLayers` and at most half the layers the cap has left (at least
//     `fitMinLayers`, default 1; `stats.fitted`): near the cap pages are
//     sized for near-term demand and one key never takes the remainder.
// Only past both is the acquire refused. `wouldAcquire(desc, key)` answers
// the same question with no side effect; `reclaim(bytes)` frees idle-only
// pages on demand (a consumer's idle-footprint trim).

export const PAGE_BYTES_DEFAULT = 4 * 1024 * 1024;
export const PAGE_LAYERS_MIN = 4;
export const PAGE_LAYERS_MAX_DEFAULT = 64;
export const PAGE_GROWTH = 1.5;
export const ALLOCATOR_BYTES_MAX_DEFAULT = 128 * 1024 * 1024;

/**
 * Mip levels three r184 allocates for a mipmapped texture: `getMipLevels`
 * returns `Math.log2(Math.max(w, h)) + 1` and `texStorage2D` truncates the
 * GLsizei, i.e. the full halving chain down to 1x1.
 */
export function fullMipLevels(width, height) {
  const m = Math.max(width | 0, height | 0, 1);
  return Math.floor(Math.log2(m)) + 1;
}

/** Dimensions of mip `level` (GL rule: each axis halves, floored, min 1). */
export function levelSize(width, height, level) {
  return [Math.max(1, (width | 0) >> level), Math.max(1, (height | 0) >> level)];
}

/** Bytes one level of one layer occupies. */
export function levelBytes(format, width, height) {
  if (format === "bc7") return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
  return width * height * 4; // rgba8
}

/** Bytes one layer (all its levels) occupies. */
export function layerBytesOf(desc) {
  let n = 0;
  for (let l = 0; l < desc.levels; l += 1) {
    const [w, h] = levelSize(desc.width, desc.height, l);
    n += levelBytes(desc.format, w, h);
  }
  return n;
}

/**
 * The page key: everything that must be equal for two textures to share one
 * GL array object and be sampled identically.
 */
export function pageKeyOf(desc) {
  return `${desc.format}|${desc.width}x${desc.height}|L${desc.levels}|cs:${desc.colorSpace || ""}`
    + `|w${desc.wrapS}.${desc.wrapT}|f${desc.minFilter}.${desc.magFilter}|a${desc.anisotropy || 1}`;
}

let _nextPageId = 1;

export class PageAllocator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.pageBytes]   target bytes of a key's first page
   * @param {number} [opts.minLayers]
   * @param {number} [opts.maxLayers]   per page (GL MAX_ARRAY_TEXTURE_LAYERS >= 256)
   * @param {number} [opts.maxBytes]    whole allocator
   * @param {(page:object)=>boolean|void} [opts.onPageCreate] GL allocation; `false` = refused
   * @param {(page:object)=>void} [opts.onPageDestroy]
   * @param {(contentKey:string, page:object, layer:number)=>void} [opts.onEvict]
   * @param {boolean} [opts.reclaimIdle]  at the cap, destroy idle-only pages first (see AT THE CAP)
   * @param {boolean} [opts.fitToCap]     at the cap, shrink the new page to what is left
   * @param {number} [opts.fitMinLayers]  the smallest page `fitToCap` makes (default 1)
   */
  constructor(opts = {}) {
    this.pageBytes = opts.pageBytes ?? PAGE_BYTES_DEFAULT;
    this.minLayers = Math.max(1, opts.minLayers ?? PAGE_LAYERS_MIN);
    this.maxLayers = Math.max(this.minLayers, opts.maxLayers ?? PAGE_LAYERS_MAX_DEFAULT);
    this.maxBytes = opts.maxBytes ?? ALLOCATOR_BYTES_MAX_DEFAULT;
    this.reclaimIdle = opts.reclaimIdle === true;
    this.fitToCap = opts.fitToCap === true;
    this.fitMinLayers = Math.max(1, opts.fitMinLayers ?? 1);
    this.onPageCreate = typeof opts.onPageCreate === "function" ? opts.onPageCreate : null;
    this.onPageDestroy = typeof opts.onPageDestroy === "function" ? opts.onPageDestroy : null;
    this.onEvict = typeof opts.onEvict === "function" ? opts.onEvict : null;
    /** Every page, creation order. */
    this.pages = [];
    this._byKey = new Map();     // pageKey -> page[]
    this._byContent = new Map(); // contentKey -> { page, layer }
    this._idle = new Map();      // contentKey -> { page, layer }; insertion order = LRU
    this.bytes = 0;
    this.stats = {
      acquires: 0, liveHits: 0, idleHits: 0, fresh: 0, evictions: 0,
      pagesCreated: 0, pagesDestroyed: 0, releases: 0, refused: 0,
    };
    // AT THE CAP counters (only the opt-in paths move them).
    if (this.reclaimIdle || this.fitToCap) Object.assign(this.stats, { reclaimedPages: 0, reclaimedBytes: 0, fitted: 0 });
  }

  /** Live (refcount > 0) layers of `page`. */
  _liveLayers(page) {
    let n = 0;
    for (let l = 0; l < page.capacity; l += 1) if (page.refs[l] > 0) n += 1;
    return n;
  }

  /** Bytes the idle-only pages (no live layer) hold: what `reclaim` could free. */
  reclaimableBytes() {
    let n = 0;
    for (const p of this.pages) if (this._liveLayers(p) === 0) n += p.capacity * p.layerBytes;
    return n;
  }

  /** Destroy one page (bookkeeping + onPageDestroy); its idle content is evicted. */
  _destroyPage(p) {
    for (let l = 0; l < p.capacity; l += 1) {
      const ck = p.content[l];
      if (ck === null) continue;
      this._idle.delete(ck);
      this._byContent.delete(ck);
      p.content[l] = null;
      this.stats.evictions += 1;
      if (this.onEvict) this.onEvict(ck, p, l);
    }
    const i = this.pages.indexOf(p);
    if (i >= 0) this.pages.splice(i, 1);
    const list = this._byKey.get(p.key);
    if (list) {
      const k = list.indexOf(p);
      if (k >= 0) list.splice(k, 1);
      if (list.length === 0) this._byKey.delete(p.key);
    }
    this.bytes -= p.capacity * p.layerBytes;
    if (this.onPageDestroy) this.onPageDestroy(p);
    this.stats.pagesDestroyed += 1;
  }

  /**
   * Free at least `bytes` (Infinity = all) by destroying pages that hold no
   * live layer, oldest idle content first (then never-used empty pages).
   * `keep` (a page) is never destroyed. Returns the bytes freed.
   */
  reclaim(bytes, keep = null) {
    let freed = 0;
    if (!(bytes > 0)) return 0;
    const order = [];
    const seen = new Set();
    for (const ent of this._idle.values()) {
      if (seen.has(ent.page)) continue;
      seen.add(ent.page);
      order.push(ent.page);
    }
    for (const p of this.pages) if (!seen.has(p)) order.push(p);
    for (const p of order) {
      if (freed >= bytes) break;
      if (p === keep || this._liveLayers(p) > 0) continue;
      const b = p.capacity * p.layerBytes;
      this._destroyPage(p);
      freed += b;
      if (this.stats.reclaimedPages !== undefined) { this.stats.reclaimedPages += 1; this.stats.reclaimedBytes += b; }
    }
    return freed;
  }

  /**
   * Would `acquire(desc, contentKey)` succeed now (no side effects)? True for
   * resident content, a free or idle layer of the key, or a new page that
   * fits the cap (after the opt-in reclaim / fit).
   */
  wouldAcquire(desc, contentKey) {
    if (contentKey !== undefined && this._byContent.has(contentKey)) return true;
    const key = pageKeyOf(desc);
    const list = this._byKey.get(key);
    if (list) for (const p of list) if (p.free.length > 0) return true;
    for (const ent of this._idle.values()) if (ent.page.key === key) return true;
    const lb = layerBytesOf(desc);
    const room = this.maxBytes - this.bytes + (this.reclaimIdle ? this.reclaimableBytes() : 0);
    const cap = this.capacityFor(desc, list);
    if (cap * lb <= room) return true;
    return this.fitToCap && Math.floor(room / lb) >= this.fitMinLayers;
  }

  /** Layers of the next page for `key` (see PAGE SIZE in the header). */
  capacityFor(desc, list) {
    const prev = list && list.length ? list[list.length - 1].capacity : 0;
    if (prev > 0) return Math.min(this.maxLayers, Math.ceil(prev * PAGE_GROWTH));
    const lb = layerBytesOf(desc);
    const hint = desc.initialLayers | 0;
    const want = hint > 0 ? hint : Math.floor(this.pageBytes / Math.max(1, lb));
    return Math.min(this.maxLayers, Math.max(this.minLayers, want));
  }

  _newPage(desc, key, list) {
    let capacity = this.capacityFor(desc, list);
    const layerBytes = layerBytesOf(desc);
    // AT THE CAP (opt-in): reclaim idle-only pages, then fit what is left.
    if (this.reclaimIdle && this.bytes + capacity * layerBytes > this.maxBytes) {
      this.reclaim(this.bytes + capacity * layerBytes - this.maxBytes);
    }
    if (this.fitToCap && this.bytes + capacity * layerBytes > this.maxBytes) {
      const fit = Math.floor((this.maxBytes - this.bytes) / layerBytes);
      if (fit >= this.fitMinLayers) {
        // At most half of what is left and at most a minimum page (never
        // below fitMinLayers): near the cap pages are sized for near-term
        // demand, so one key cannot take the remainder from the keys after it.
        capacity = Math.min(capacity, Math.max(this.fitMinLayers, Math.min(this.minLayers, Math.floor(fit / 2))));
        this.stats.fitted += 1;
      }
    }
    if (this.bytes + capacity * layerBytes > this.maxBytes) { this.stats.refused += 1; return null; }
    const page = {
      id: _nextPageId++,
      key,
      desc: { ...desc },
      capacity,
      layerBytes,
      refs: new Int32Array(capacity),
      content: new Array(capacity).fill(null),
      free: [],
      gl: null,
    };
    for (let l = capacity - 1; l >= 0; l -= 1) page.free.push(l); // pop() hands out layer 0 first
    if (this.onPageCreate && this.onPageCreate(page) === false) { this.stats.refused += 1; return null; }
    list.push(page);
    this.pages.push(page);
    this.bytes += capacity * layerBytes;
    this.stats.pagesCreated += 1;
    return page;
  }

  /** `{ page, layer }` of resident content, or null. Does not touch refcounts. */
  lookup(contentKey) {
    return this._byContent.get(contentKey) || null;
  }

  /** Refcount of resident content (0 = idle, -1 = not resident). */
  refCount(contentKey) {
    const e = this._byContent.get(contentKey);
    return e ? e.page.refs[e.layer] : -1;
  }

  /** Would `acquire(desc, contentKey)` need an upload? (No side effects.) */
  needsUpload(contentKey) {
    return !this._byContent.has(contentKey);
  }

  /**
   * Take one reference on `contentKey`'s layer, allocating one when it is not
   * resident. Returns `{ page, layer, fresh }` (`fresh` = the caller must
   * upload the content now), or null when no page can be had (byte cap, or
   * the GL side refused the page).
   */
  acquire(desc, contentKey) {
    this.stats.acquires += 1;
    const have = this._byContent.get(contentKey);
    if (have) {
      const r = have.page.refs[have.layer];
      have.page.refs[have.layer] = r + 1;
      if (r === 0) { this._idle.delete(contentKey); this.stats.idleHits += 1; } else this.stats.liveHits += 1;
      return { page: have.page, layer: have.layer, fresh: false };
    }
    const key = pageKeyOf(desc);
    let list = this._byKey.get(key);
    if (!list) { list = []; this._byKey.set(key, list); }
    let page = null;
    let layer = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].free.length > 0) { page = list[i]; layer = page.free.pop(); break; }
    }
    if (page === null) {
      for (const [ck, ent] of this._idle) {
        if (ent.page.key !== key) continue;
        this._idle.delete(ck);
        this._byContent.delete(ck);
        ent.page.content[ent.layer] = null;
        page = ent.page;
        layer = ent.layer;
        this.stats.evictions += 1;
        if (this.onEvict) this.onEvict(ck, page, layer);
        break;
      }
    }
    if (page === null) {
      page = this._newPage(desc, key, list);
      if (page === null) {
        if (list.length === 0) this._byKey.delete(key);
        return null;
      }
      layer = page.free.pop();
    }
    page.content[layer] = contentKey;
    page.refs[layer] = 1;
    const ent = { page, layer };
    this._byContent.set(contentKey, ent);
    this.stats.fresh += 1;
    return { page, layer, fresh: true };
  }

  /**
   * Drop one reference. At 0 the layer goes idle (content kept, newest end of
   * the LRU). Returns false for unknown content or a refcount already at 0.
   */
  release(contentKey) {
    const ent = this._byContent.get(contentKey);
    if (!ent) return false;
    const p = ent.page;
    if (p.refs[ent.layer] <= 0) return false;
    p.refs[ent.layer] -= 1;
    this.stats.releases += 1;
    if (p.refs[ent.layer] === 0) this._idle.set(contentKey, ent);
    return true;
  }

  /**
   * Forget content whose upload failed after `acquire` returned fresh (the
   * layer holds garbage): the layer goes straight back to the free list.
   * Only legal while the caller holds the only reference.
   */
  abandon(contentKey) {
    const ent = this._byContent.get(contentKey);
    if (!ent || ent.page.refs[ent.layer] !== 1) return false;
    ent.page.refs[ent.layer] = 0;
    ent.page.content[ent.layer] = null;
    ent.page.free.push(ent.layer);
    this._byContent.delete(contentKey);
    return true;
  }

  /**
   * Free every idle layer, then destroy pages left with no resident content.
   * Returns the number of pages destroyed.
   */
  trim() {
    for (const [ck, ent] of this._idle) {
      this._byContent.delete(ck);
      ent.page.content[ent.layer] = null;
      ent.page.free.push(ent.layer);
      if (this.onEvict) this.onEvict(ck, ent.page, ent.layer);
      this.stats.evictions += 1;
    }
    this._idle.clear();
    let n = 0;
    for (let i = this.pages.length - 1; i >= 0; i -= 1) {
      const p = this.pages[i];
      if (p.free.length !== p.capacity) continue;
      this.pages.splice(i, 1);
      const list = this._byKey.get(p.key);
      if (list) {
        const k = list.indexOf(p);
        if (k >= 0) list.splice(k, 1);
        if (list.length === 0) this._byKey.delete(p.key);
      }
      this.bytes -= p.capacity * p.layerBytes;
      if (this.onPageDestroy) this.onPageDestroy(p);
      this.stats.pagesDestroyed += 1;
      n += 1;
    }
    return n;
  }

  /** Destroy everything (consumer teardown). */
  clear() {
    for (const p of this.pages) if (this.onPageDestroy) this.onPageDestroy(p);
    this.stats.pagesDestroyed += this.pages.length;
    this.pages.length = 0;
    this._byKey.clear();
    this._byContent.clear();
    this._idle.clear();
    this.bytes = 0;
  }

  /** Counts for diag. */
  summary() {
    let live = 0, idle = 0, free = 0, layers = 0, liveBytes = 0, idleBytes = 0;
    for (const p of this.pages) {
      layers += p.capacity;
      free += p.free.length;
      for (let l = 0; l < p.capacity; l += 1) {
        if (p.content[l] === null) continue;
        if (p.refs[l] > 0) { live += 1; liveBytes += p.layerBytes; } else { idle += 1; idleBytes += p.layerBytes; }
      }
    }
    // `bytes` = reserved (whole pages, what the cap counts); live / idle =
    // resident content; the rest of `bytes` is free layers.
    return { pages: this.pages.length, layers, live, idle, free, bytes: this.bytes, maxBytes: this.maxBytes, liveBytes, idleBytes, ...this.stats };
  }

  /**
   * Check every invariant; returns a list of violations (empty = consistent).
   * Used by tests/gpu_batch_pages.test.mjs after every operation.
   */
  verify() {
    const bad = [];
    let mapped = 0;
    let idleSeen = 0;
    let bytes = 0;
    for (const p of this.pages) {
      bytes += p.capacity * p.layerBytes;
      const freeSet = new Set();
      for (const l of p.free) {
        if (l < 0 || l >= p.capacity) bad.push(`page ${p.id}: free layer ${l} out of range`);
        if (freeSet.has(l)) bad.push(`page ${p.id}: layer ${l} twice on the free list`);
        freeSet.add(l);
      }
      const list = this._byKey.get(p.key);
      if (!list || !list.includes(p)) bad.push(`page ${p.id}: missing from its key list`);
      for (let l = 0; l < p.capacity; l += 1) {
        const c = p.content[l];
        const r = p.refs[l];
        if (r < 0) bad.push(`page ${p.id} layer ${l}: negative refcount ${r}`);
        if (c === null) {
          if (r !== 0) bad.push(`page ${p.id} layer ${l}: free layer with refcount ${r}`);
          if (!freeSet.has(l)) bad.push(`page ${p.id} layer ${l}: empty but not on the free list`);
          continue;
        }
        mapped += 1;
        if (freeSet.has(l)) bad.push(`page ${p.id} layer ${l}: resident content ${c} on the free list`);
        const ent = this._byContent.get(c);
        if (!ent || ent.page !== p || ent.layer !== l) bad.push(`content ${c}: map does not point at page ${p.id} layer ${l}`);
        const inIdle = this._idle.has(c);
        if (r === 0 && !inIdle) bad.push(`content ${c}: refcount 0 but not idle`);
        if (r > 0 && inIdle) bad.push(`content ${c}: refcount ${r} but on the idle list`);
        if (inIdle) idleSeen += 1;
      }
    }
    if (mapped !== this._byContent.size) bad.push(`content map holds ${this._byContent.size}, pages hold ${mapped}`);
    if (idleSeen !== this._idle.size) bad.push(`idle list holds ${this._idle.size}, pages hold ${idleSeen} idle`);
    if (bytes !== this.bytes) bad.push(`byte count ${this.bytes} != ${bytes}`);
    if (this.bytes > this.maxBytes) bad.push(`over the byte cap: ${this.bytes} > ${this.maxBytes}`);
    for (const [key, list] of this._byKey) {
      for (const p of list) if (p.key !== key || !this.pages.includes(p)) bad.push(`key list ${key}: stray page ${p.id}`);
    }
    return bad;
  }
}
