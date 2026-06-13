// A8-M4 (2026-06-11 unification survey) — generic PRE-CREATE event buffer,
// the retail "null object" analog (`?preCreateBuffer=on`, default OFF).
//
// Retail: a wire message addressed to a guid with no created CPhysicsObj is
// NOT dropped — `CObjectMaint::QueueBlobForObject` (acclient.c:310848-310860)
// files the netblob on a placeholder made by `GetNullObject(id, create=1)`
// (acclient.c:310675-310716) via `CPhysicsObj::queue_netblob` (FIFO; replayed
// in arrival order when the real object is created), and EVERY new queued
// blob re-stamps the placeholder's destruction timer to `cur_time + 25.0`
// via `AddObjectToBeDestroyed` (remove + re-add, acclient.c:310651-310672,
// the 25.0 at :310666). UseTime additionally nags the server with
// `SendForceObjdesc` for placeholders older than 20 s
// (acclient.c:310302-310308) — that re-request hook is NOT implemented here
// (ROADMAP ruling: ACE support UNRESOLVED, bucket D; the buffer + expiry
// half is self-contained and useful without the nag).
//
// Ours: scene3d had two bespoke per-kind analogs in entities.js —
// `_pendingAttach` (wielded-item ParentEvent before either rig exists) and
// `_pendingVisibility` (F16-5 spawn-time kind=17 draw gate before the rig
// exists) — and silently dropped every OTHER pre-create event. This module
// is the generic replacement mechanism (A8 report §4 Stage M4 "generalizes
// the F16-5 pattern"): one guid-keyed FIFO of tagged events, drained on
// spawn-commit, whole bucket expired 25 s after its LAST enqueue.
//
// Pure + dependency-free BY CONSTRUCTION (no THREE, no window, no module
// side effects) so node tests can exercise it directly — same shape as
// scene3d/client_event_dispatch.js (A8-M3) and scene3d/hook_windows.js.
// The wiring (which kinds route here, what "drain" applies) lives with the
// flag gate in scene3d/entities.js.

// Retail expiry: 25.0 s, acclient.c:310666. Milliseconds here (callers feed
// Date.now()/performance.now()-domain stamps via the injected clock).
export const PRE_CREATE_EXPIRY_MS = 25000;

/**
 * @param {{ now?: () => number, expiryMs?: number }} [opts] — injectable
 *   clock for tests; expiry override for tests only (production callers
 *   keep the retail 25 s).
 */
export function createPreCreateBuffer({ now = () => Date.now(), expiryMs = PRE_CREATE_EXPIRY_MS } = {}) {
  /**
   * guid → { lastQueuedAt: number, events: Array<{kind: string, data: object}> }
   * `events` is FIFO (retail queue_netblob replay order); `lastQueuedAt`
   * mirrors retail's refresh-on-every-blob destruction stamp.
   * @type {Map<number, {lastQueuedAt: number, events: Array<{kind: string, data: object}>}>}
   */
  const buckets = new Map();
  let eventCount = 0;

  return {
    /** Park an event for a not-yet-created guid. `dedupeKind: true` drops
     *  any earlier event of the same kind for this guid first (used for
     *  attach, preserving the legacy `_pendingAttach` Map last-write-wins
     *  semantics — two parked attaches would race their async holding-
     *  location resolves on drain, so only the latest is kept; the fresh
     *  event still appends at the TAIL so cross-kind arrival order holds). */
    enqueue(guid, kind, data, { dedupeKind = false } = {}) {
      const g = guid >>> 0;
      let bucket = buckets.get(g);
      if (!bucket) {
        bucket = { lastQueuedAt: 0, events: [] };
        buckets.set(g, bucket);
      }
      if (dedupeKind) {
        const before = bucket.events.length;
        bucket.events = bucket.events.filter((e) => e.kind !== kind);
        eventCount -= before - bucket.events.length;
      }
      bucket.events.push({ kind, data });
      eventCount += 1;
      // Retail refresh: every queued blob re-stamps cur_time + 25
      // (acclient.c:310848-310860 → AddObjectToBeDestroyed re-add).
      bucket.lastQueuedAt = now();
    },

    /** Any parked event for guid (optionally of one kind)? Non-consuming. */
    hasFor(guid, kind = null) {
      const bucket = buckets.get(guid >>> 0);
      if (!bucket) return false;
      if (kind === null) return bucket.events.length > 0;
      return bucket.events.some((e) => e.kind === kind);
    },

    /** Remove + return all events parked under guid, FIFO (retail replay
     *  order). Empty array when none. */
    takeFor(guid) {
      const g = guid >>> 0;
      const bucket = buckets.get(g);
      if (!bucket) return [];
      buckets.delete(g);
      eventCount -= bucket.events.length;
      return bucket.events;
    },

    /** Remove + return events matching `pred(guid, event)` across ALL
     *  buckets, bucket order then FIFO within a bucket; each returned
     *  record carries its owning guid. Used for the legacy
     *  `_flushPendingAttach` wielder-side scan (a parked attach is keyed
     *  by CHILD guid but may be unblocked by its PARENT's spawn). */
    takeMatching(pred) {
      const out = [];
      for (const [g, bucket] of buckets) {
        const keep = [];
        for (const ev of bucket.events) {
          if (pred(g, ev)) out.push({ guid: g, kind: ev.kind, data: ev.data });
          else keep.push(ev);
        }
        if (keep.length !== bucket.events.length) {
          eventCount -= bucket.events.length - keep.length;
          if (keep.length === 0) buckets.delete(g);
          else bucket.events = keep;
        }
      }
      return out;
    },

    /** Drop events matching `pred(guid, event)` (no return). Used by
     *  `_detachChild` to cancel a parked attach (legacy
     *  `_pendingAttach.delete`). */
    removeMatching(pred) {
      this.takeMatching(pred);
    },

    /** Drop everything parked under guid (despawn purge; the legacy
     *  remove() `_pendingAttach.delete + _pendingVisibility.delete`). */
    purgeGuid(guid) {
      const g = guid >>> 0;
      const bucket = buckets.get(g);
      if (!bucket) return;
      eventCount -= bucket.events.length;
      buckets.delete(g);
    },

    /** Expire whole buckets whose LAST enqueue is older than the 25 s
     *  window (retail destroys the placeholder + its queued blobs
     *  together when the destruction timer fires, acclient.c:310246-310278).
     *  Returns the number of guids expired. */
    expire(atMs = now()) {
      let expired = 0;
      for (const [g, bucket] of buckets) {
        if (atMs - bucket.lastQueuedAt > expiryMs) {
          eventCount -= bucket.events.length;
          buckets.delete(g);
          expired += 1;
        }
      }
      return expired;
    },

    /** Total parked event count (cheap gate for the per-second sweep). */
    size() {
      return eventCount;
    },

    /** Number of guids with parked events (diagnostics). */
    guidCount() {
      return buckets.size;
    },
  };
}
