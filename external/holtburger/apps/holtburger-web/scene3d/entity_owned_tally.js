// Entity-owned texture/material accounting — the `entMB` instrument
// (2026-07-26, RESULTS-matcache-falsifier-2026-07-26.md next-move 1).
//
// WHY THIS EXISTS
// ---------------
// The 3.6 GB JS-heap step fires at the same route position (the Hotel Swank
// item museum) in every arm, and the `?matBudgetMB` falsifier REFUTED the
// `MaterialCache` maps as the retainer by intervention: pinned at 64 MB with
// 5,723 evictions, the heap still stepped to 3,586 MB. The remaining
// route-cumulative suspect is the ENTITY-OWNED recolored-texture pool:
//
//   materials.js `_buildEntityOwnedFromPixels`  (the F.41 batch leg)
//   entities.js  `registerOwnedTexture` / `registerOwnedMaterial`
//   entities.js  `_applyAppearanceHotSwap`'s `_pendingOwnedTextures` commit
//
// Those textures are per-WEARER (not per-DID — a popular recolored surface is
// duplicated once per entity that wears it), live OUTSIDE all four bounded
// `MaterialCache` maps, and were completely uncounted: `matMB` cannot see
// them. This module is the counter.
//
// DESIGN CONSTRAINTS
// ------------------
//  * O(1) per registration. The byte-sum is charged AT REGISTER TIME from
//    `image.data.byteLength`; a poll NEVER walks the entity map. (A
//    per-poll walk over thousands of live rigs is exactly the kind of
//    instrument that changes what it measures.)
//  * Same honest measure as materials.js `estimateTextureBytes` — the JS
//    bytes a `DataTexture` pins through `image.data`, AFTER `?textureDownscale`
//    decimation, EXCLUDING the GPU-side mip chain the JS heap does not hold.
//    Deliberately re-implemented here (3 lines) rather than imported, so this
//    module stays dependency-free and node-testable without `three`.
//  * Idempotent in both directions. `Texture.dispose()` is idempotent in
//    three.js and our teardown paths deliberately double-dispose as a safety
//    net (entities.js:2916 `_disposeMeshChildren` then the `ownedTextures`
//    loop). A WeakMap of charged bytes makes a second dispose — and a second
//    register of the same object — a no-op, so the tally can never drift
//    negative or double-count.
//  * Never throws. Every entry point is wrapped; a diagnostic that can abort
//    a spawn is worse than no diagnostic.
//
// WHAT THE NUMBERS MEAN (read this before drawing a conclusion)
// -------------------------------------------------------------
// `liveBytes` counts textures that have been REGISTERED and not yet
// DISPOSED. `Texture.dispose()` frees the GPU handle only — the JS bytes
// free on UNREACHABILITY. So:
//
//   liveBytes stepping at Swank        ⇒ the pool really does burst there.
//   liveBytes flat while the heap steps ⇒ the bytes are retained AFTER
//                                        dispose, i.e. some holder keeps the
//                                        dead texture (or its owning entity)
//                                        reachable. That is the harder bug and
//                                        this instrument distinguishes it.
//
// `hiWaterBytes` is the max `liveBytes` ever observed, so a burst that has
// since been disposed is still visible after the fact — the relay samples
// once per stop and would otherwise miss a transient.

/**
 * JS-heap bytes a `THREE.DataTexture` pins through `image.data`.
 * Mirrors materials.js `estimateTextureBytes` exactly. Non-DataTexture,
 * absent image, or a throwing getter ⇒ 0.
 */
export function ownedTextureBytes(tex) {
  try {
    const d = tex && tex.image ? tex.image.data : null;
    return d && typeof d.byteLength === "number" ? d.byteLength : 0;
  } catch (_) {
    return 0;
  }
}

export class EntityOwnedTally {
  constructor() {
    // Cumulative (never decrease) — route-progress counters.
    this.registeredTotal = 0;
    this.disposedTotal = 0;
    this.registeredMaterialsTotal = 0;
    this.disposedMaterialsTotal = 0;
    this.registeredBytesTotal = 0;
    // Live (register − dispose).
    this.liveTextures = 0;
    this.liveMaterials = 0;
    this.liveBytes = 0;
    this.liveEntities = 0;
    // High-water mark of `liveBytes` / `liveTextures`.
    this.hiWaterBytes = 0;
    this.hiWaterTextures = 0;
    // Identity ledgers. WeakMap/WeakSet so the tally itself can never be the
    // retainer it is hunting for — holding a strong ref to every owned
    // texture would fabricate the very leak we are measuring.
    /** @type {WeakMap<object, number>} charged bytes per live texture */
    this._texBytes = new WeakMap();
    /** @type {WeakSet<object>} live materials */
    this._mats = new WeakSet();
    /** @type {WeakSet<object>} entity instances currently holding owned assets */
    this._owners = new WeakSet();
  }

  /** Count an entity instance as an owner the first time it registers anything. */
  _noteOwner(owner) {
    if (!owner || typeof owner !== "object") return;
    if (this._owners.has(owner)) return;
    this._owners.add(owner);
    this.liveEntities += 1;
  }

  /**
   * Charge `tex` to the live pool. Returns the bytes charged (0 when the
   * texture was already charged, absent, or carries no `image.data`).
   */
  registerTexture(tex, owner = null) {
    try {
      if (!tex || typeof tex !== "object") return 0;
      if (this._texBytes.has(tex)) return 0; // already charged — idempotent
      const bytes = ownedTextureBytes(tex);
      this._texBytes.set(tex, bytes);
      this.registeredTotal += 1;
      this.registeredBytesTotal += bytes;
      this.liveTextures += 1;
      this.liveBytes += bytes;
      if (this.liveBytes > this.hiWaterBytes) this.hiWaterBytes = this.liveBytes;
      if (this.liveTextures > this.hiWaterTextures) {
        this.hiWaterTextures = this.liveTextures;
      }
      this._noteOwner(owner);
      return bytes;
    } catch (_) {
      return 0;
    }
  }

  /** Count an entity-owned material. Bytes live on its texture, not here. */
  registerMaterial(mat, owner = null) {
    try {
      if (!mat || typeof mat !== "object") return false;
      if (this._mats.has(mat)) return false;
      this._mats.add(mat);
      this.registeredMaterialsTotal += 1;
      this.liveMaterials += 1;
      this._noteOwner(owner);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Release `tex` from the live pool. Safe to call on an unknown or
   * already-released texture (returns 0) — the teardown paths deliberately
   * double-dispose.
   */
  disposeTexture(tex) {
    try {
      if (!tex || typeof tex !== "object") return 0;
      if (!this._texBytes.has(tex)) return 0;
      const bytes = this._texBytes.get(tex) || 0;
      this._texBytes.delete(tex);
      this.disposedTotal += 1;
      this.liveTextures -= 1;
      this.liveBytes -= bytes;
      return bytes;
    } catch (_) {
      return 0;
    }
  }

  /** Release an entity-owned material. Idempotent. */
  disposeMaterial(mat) {
    try {
      if (!mat || typeof mat !== "object") return false;
      if (!this._mats.has(mat)) return false;
      this._mats.delete(mat);
      this.disposedMaterialsTotal += 1;
      this.liveMaterials -= 1;
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Entity teardown: stop counting this instance as a live owner. */
  releaseOwner(owner) {
    try {
      if (!owner || typeof owner !== "object") return false;
      if (!this._owners.has(owner)) return false;
      this._owners.delete(owner);
      this.liveEntities -= 1;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Allocation-light read-only snapshot. Shape is the `__diag.entityOwned()`
   * contract; the battery relay reads `liveBytes` / `hiWaterBytes` as
   * `entMB` / `entHi`.
   */
  snapshot() {
    return {
      liveTextures: this.liveTextures,
      liveBytes: this.liveBytes,
      liveMB: +(this.liveBytes / 1048576).toFixed(2),
      hiWaterBytes: this.hiWaterBytes,
      hiWaterMB: +(this.hiWaterBytes / 1048576).toFixed(2),
      hiWaterTextures: this.hiWaterTextures,
      registeredTotal: this.registeredTotal,
      disposedTotal: this.disposedTotal,
      registeredBytesTotal: this.registeredBytesTotal,
      liveEntities: this.liveEntities,
      liveMaterials: this.liveMaterials,
      registeredMaterialsTotal: this.registeredMaterialsTotal,
      disposedMaterialsTotal: this.disposedMaterialsTotal,
    };
  }
}

/** Process-wide tally — one pool across ALL entity instances. */
export const entityOwnedTally = new EntityOwnedTally();
