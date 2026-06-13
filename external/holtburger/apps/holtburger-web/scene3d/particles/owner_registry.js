// A11-S2 (unification survey 2026-06-11) — emitter lifecycle OWNER facade.
//
// Retail owns particle emitters strictly per-CPhysicsObj: each object has
// its OWN lazily-created `ParticleManager` with an OBJECT-SCOPED emitter-id
// table (`LongNIHash<ParticleEmitter> particle_table`, acclient.h:31040-31045;
// created on first `CPhysicsObj::create_particle_emitter`,
// acclient.c:316330-316353; destroyed with the object,
// acclient.c:318082-318095 / :320959-320966). Ours kept TWO global
// `ParticleManager`s (world + statics) with a SHARED emitter-id namespace
// plus THREE independent teardown registries layered on top (survey A11 §3
// row 3, SPLIT-BRAIN):
//   1. `entities.js` `_particleEmittersForGuid` (Map<guid, ids[]>),
//   2. `statics.js` `disposeStaticParticles` (whole-table nuke, no per-anchor
//      scoping),
//   3. `play_effect_vfx.js` `_playEffectEmitterGroups` (FIFO cap registry +
//      one-shot reaper + per-guid map cross-writes).
// Symptoms: script-authored explicit emitter handles from two objects can
// collide in the one global table (a Destroy(14) on object A can kill
// object B's emitter), and three divergent disposal paths drift (the exact
// "fix lands in one copy" failure mode the survey targets).
//
// This module is the ONE owner-keyed lifecycle facade (`?particleOwner=on`,
// default OFF — every legacy registry above is the unchanged off-path):
//   - owner keys: `entityGuid` (number) | `"static:<n>"` | the PlayEffect
//     one-shot path registers under the TARGET entity's guid (retail-true:
//     a PlayEffect script runs on the target object's own managers;
//     `playEffectGroup` survives only as eviction POLICY metadata in
//     play_effect_vfx.js, not as a parallel id registry).
//   - object-scoped emitter-id maps: a script-authored explicit handle
//     (`CreateParticleHook.emitter_id`) maps (ownerKey, handle) → a facade-
//     allocated UNIQUE underlying-manager id, so cross-owner handle collisions
//     in the shared global table are impossible by construction. Replace /
//     blocking semantics (acclient.c:329383-329393 / :329528-329565) are
//     evaluated PER OWNER, like retail's per-object table.
//   - single teardown API: `destroyAllForOwner(ownerKey)` (retail
//     `destroy_particle_manager` analog), plus `destroySome` for the
//     PlayEffect FIFO-evict/reaper owner-policy partial teardown.
//
// The facade does NOT replace the `ParticleManager` runtime — it wraps
// `addEmitter`/`destroyParticleEmitter`/`stopParticleEmitter` on whichever
// manager instance the owner's walker already uses (world or statics), so
// per-particle math, RP6 culling, and disposal stay in one place.
//
// Determinism: no clocks, no RNG, no THREE — plain Maps. Headless tests
// drive it with a fake manager (`test_particle_owner.mjs` leak assertion:
// table size returns to baseline after spawn/despawn churn).

/** Cached `?particleOwner=on` parse. `_resetParticleOwnerFlagForTests()`
 *  clears the cache so headless tests can flip `globalThis.location`. */
let _flagCache = null;

export function particleOwnerOn() {
  if (_flagCache !== null) return _flagCache;
  let on = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      on =
        new URLSearchParams(globalThis.location.search)
          .get("particleOwner")?.toLowerCase() === "on";
    }
  } catch (_) {
    on = false;
  }
  _flagCache = on;
  return on;
}

export function _resetParticleOwnerFlagForTests() {
  _flagCache = null;
}

/**
 * @typedef {Object} OwnerRec
 * @property {Map<number, object>} ids  underlying emitter id → owning manager.
 * @property {Map<number, number|{pending:true, superseded:boolean}>} scoped
 *   script-authored explicit handle → underlying id (or an in-flight token).
 */

export class ParticleOwnerRegistry {
  constructor() {
    /** @type {Map<number|string, OwnerRec>} */
    this._owners = new Map();
    // Owner epochs — bumped by destroyAllForOwner even when no record
    // exists yet, so an addEmitter still awaiting its manager build when
    // the owner despawns destroys its late-resolving emitter instead of
    // orphaning it (the race play_effect_vfx.js:1430-1433 handled ad hoc,
    // now centralized). Entries are one small number per ever-touched
    // owner key — bounded by session entity churn.
    /** @type {Map<number|string, number>} */
    this._epochs = new Map();
    // Diagnostics for leak assertions / __diag readers.
    this.addCount = 0;
    this.destroyCount = 0;
  }

  /** Number of owners currently holding live emitters. */
  get ownerCount() {
    return this._owners.size;
  }

  /** Live emitter count for one owner (0 for unknown owners). */
  emitterCountForOwner(ownerKey) {
    return this._owners.get(ownerKey)?.ids.size ?? 0;
  }

  /** Iterate live owner keys (used by statics whole-dispose). */
  ownerKeys() {
    return this._owners.keys();
  }

  _epoch(ownerKey) {
    return this._epochs.get(ownerKey) ?? 0;
  }

  _ownerRec(ownerKey) {
    let rec = this._owners.get(ownerKey);
    if (!rec) {
      rec = { ids: new Map(), scoped: new Map() };
      this._owners.set(ownerKey, rec);
    }
    return rec;
  }

  /**
   * Owner-scoped `CreateParticleEmitter` / `CreateBlockingParticleEmitter`.
   *
   * `req` is the same request shape `ParticleManager.addEmitter` takes;
   * `req.emitterId` is interpreted as the OBJECT-SCOPED script handle
   * (0 = anonymous/auto). The facade ALWAYS passes `emitterId: 0` to the
   * underlying manager (global ids are facade-allocated via the manager's
   * `nextEmitterId`), so the shared global table can never collide across
   * owners; replace/blocking semantics run here, per owner, exactly like
   * retail's per-object table (acclient.c:329383-329393 replace-destructs
   * the old emitter; :329528-329565 blocking returns 0 and leaves it).
   *
   * @param {number|string} ownerKey
   * @param {object} manager  the walker's ParticleManager (world or statics).
   * @param {object} req      addEmitter request (emitterId = scoped handle).
   * @returns {Promise<number>} underlying emitter id, or 0 on failure /
   *   blocking-refused / owner-despawned-during-await.
   */
  async addEmitter(ownerKey, manager, req) {
    if (!manager || typeof manager.addEmitter !== "function") return 0;
    const handle = (req?.emitterId ?? 0) >>> 0;
    const blocking = req?.blocking === true;
    const rec = this._ownerRec(ownerKey);

    if (handle !== 0) {
      const existing = rec.scoped.get(handle);
      if (existing !== undefined) {
        if (blocking) {
          // Retail CreateBlockingParticleEmitter: id live in THIS object's
          // table → return 0, never replace (acclient.c:329528-329565).
          return 0;
        }
        // Retail CreateParticleEmitter replace: destroy the old emitter
        // (parts + materials freed via destroyParticleEmitter) before the
        // new one is built (acclient.c:329383-329393).
        if (typeof existing === "number") {
          this._destroyUnderlying(rec, existing);
        } else {
          // Still in flight — mark superseded; its resolve self-destroys.
          existing.superseded = true;
        }
      }
      // In-flight token so a concurrent blocking create on the same handle
      // refuses, and a concurrent replace supersedes correctly.
      var token = { pending: true, superseded: false };
      rec.scoped.set(handle, token);
    }

    const epochAtCall = this._epoch(ownerKey);
    let id = 0;
    try {
      // Underlying create is ALWAYS auto-id + non-blocking: scoping and
      // blocking were resolved above at owner level.
      id = await manager.addEmitter({ ...req, emitterId: 0, blocking: false });
    } catch (err) {
      id = 0;
      // Mirror the walkers' fail-soft contract — never throw past here.
      // eslint-disable-next-line no-console
      console.warn("[particle-owner] addEmitter failed:", err);
    }

    const liveRec = this._owners.get(ownerKey);
    const ownerGone = liveRec !== rec || this._epoch(ownerKey) !== epochAtCall;
    const superseded = handle !== 0 && token.superseded === true;

    if ((id >>> 0) === 0) {
      // Creation failed — clear our pending token (unless replaced since)
      // and prune an owner record this failed create may have created.
      if (handle !== 0 && !ownerGone && rec.scoped.get(handle) === token) {
        rec.scoped.delete(handle);
      }
      if (!ownerGone) this._pruneOwner(ownerKey, rec);
      return 0;
    }
    if (ownerGone || superseded) {
      // Owner despawned (destroyAllForOwner ran mid-await) or an explicit-id
      // replace superseded this create: the late emitter must not leak.
      try { manager.destroyParticleEmitter(id); } catch (_) {}
      return 0;
    }

    rec.ids.set(id, manager);
    if (handle !== 0 && rec.scoped.get(handle) === token) {
      rec.scoped.set(handle, id);
    }
    this.addCount += 1;
    return id;
  }

  _destroyUnderlying(rec, id) {
    const manager = rec.ids.get(id);
    if (manager) {
      try { manager.destroyParticleEmitter(id); } catch (_) {}
      rec.ids.delete(id);
      this.destroyCount += 1;
    }
    // Drop any scoped alias pointing at this id.
    for (const [h, v] of rec.scoped) {
      if (v === id) rec.scoped.delete(h);
    }
  }

  /**
   * `DestroyParticleHook` (14) teardown by OBJECT-SCOPED handle (retail
   * `destroy_particle_emitter`, acclient.c:316382-316393). Also accepts a
   * raw underlying id (PlayEffect reaper path). Unknown handles no-op,
   * matching retail's per-object table miss.
   * @returns {boolean} true when an emitter was destroyed.
   */
  destroyEmitter(ownerKey, handle) {
    const rec = this._owners.get(ownerKey);
    if (!rec) return false;
    const h = handle >>> 0;
    const mapped = rec.scoped.get(h);
    if (typeof mapped === "number") {
      this._destroyUnderlying(rec, mapped);
      this._pruneOwner(ownerKey, rec);
      return true;
    }
    if (mapped !== undefined) {
      // In-flight create destroyed before it resolved — supersede it.
      mapped.superseded = true;
      rec.scoped.delete(h);
      return true;
    }
    if (rec.ids.has(h)) {
      this._destroyUnderlying(rec, h);
      this._pruneOwner(ownerKey, rec);
      return true;
    }
    return false;
  }

  /**
   * `StopParticleHook` (15) — stop emission by scoped handle, NO teardown
   * (retail stop = flag-only, acclient.c:329442-329480; the manager reaps
   * the drained emitter from its table on its own).
   */
  stopEmitter(ownerKey, handle) {
    const rec = this._owners.get(ownerKey);
    if (!rec) return false;
    const h = handle >>> 0;
    const mapped = rec.scoped.get(h);
    const id = typeof mapped === "number" ? mapped : (rec.ids.has(h) ? h : 0);
    if (id === 0) return false;
    const manager = rec.ids.get(id);
    if (!manager) return false;
    try { return manager.stopParticleEmitter(id) === true; } catch (_) { return false; }
  }

  /**
   * Partial teardown — destroy a specific id list under one owner. This is
   * the PlayEffect FIFO-evict / one-shot-reaper OWNER-POLICY hook: the
   * group keeps only {ownerKey, ids[]} policy metadata and routes the
   * actual teardown here, instead of maintaining a parallel registry.
   * Ids already reaped/destroyed no-op (idempotent).
   */
  destroySome(ownerKey, ids) {
    const rec = this._owners.get(ownerKey);
    if (!rec || !Array.isArray(ids)) return 0;
    let n = 0;
    for (const id of ids) {
      if (rec.ids.has(id >>> 0)) {
        this._destroyUnderlying(rec, id >>> 0);
        n += 1;
      }
    }
    this._pruneOwner(ownerKey, rec);
    return n;
  }

  /**
   * THE single teardown API (survey A11 §4 Stage S2): destroy every
   * emitter this owner holds and tombstone in-flight creates (epoch bump),
   * mirroring retail's `destroy_particle_manager` on the CPhysicsObj
   * destructor path (acclient.c:318082-318095, :320959-320966).
   * @returns {number} emitters destroyed synchronously.
   */
  destroyAllForOwner(ownerKey) {
    // Epoch bump FIRST so in-flight addEmitter resolves self-destroy even
    // when no record exists yet (despawn racing the first create).
    this._epochs.set(ownerKey, this._epoch(ownerKey) + 1);
    const rec = this._owners.get(ownerKey);
    if (!rec) return 0;
    let n = 0;
    for (const [id, manager] of rec.ids) {
      try { manager.destroyParticleEmitter(id); } catch (_) {}
      this.destroyCount += 1;
      n += 1;
    }
    // Supersede any still-pending scoped creates.
    for (const v of rec.scoped.values()) {
      if (v && typeof v === "object") v.superseded = true;
    }
    this._owners.delete(ownerKey);
    return n;
  }

  /** Drop empty owner records so churn doesn't accumulate dead owners. */
  _pruneOwner(ownerKey, rec) {
    if (rec.ids.size === 0 && rec.scoped.size === 0) {
      this._owners.delete(ownerKey);
    }
  }

  /** Test-only: full reset. */
  _resetForTests() {
    this._owners.clear();
    this._epochs.clear();
    this.addCount = 0;
    this.destroyCount = 0;
  }
}

/** The shared singleton every walker routes through when the flag is on. */
export const ownerRegistry = new ParticleOwnerRegistry();

export default ParticleOwnerRegistry;
