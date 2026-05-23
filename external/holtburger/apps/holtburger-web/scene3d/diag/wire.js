// scene3d/diag/wire.js — wire-packet observability diagnostic slice
//
// Wave-2 client-side counter for every ClientEvent (poll_events, kinds 0–21)
// and EntityUpdate (pollEntityUpdates, kinds 0–5) that the runtime actually
// DISPATCHES. The hooks fire inside the drain loops AFTER the kind is read,
// so we observe processed packets — not what was queued at the wasm boundary.
// (No cheating: we never peek at the wasm queue pre-drain.)
//
// Disambiguation between the two channels matters: ClientEvent kind=1 means
// PlayerSpawned, while EntityUpdate kind=1 means KIND_SPAWN. Records are
// tagged with a domain key `d ∈ {"event","entity"}` so byKind() / summary()
// can group cleanly across both streams.
//
// Cost per packet is O(1): one counter increment, one ring-buffer push, and
// occasionally one shift() when length exceeds maxTail (200). The Holtburg
// burst peaks at ~500 packets/sec — well within budget. Records are kept
// small (~150 bytes each → 30 KB max heap).
//
// The hook sites in index.html / loop.js wrap the calls in try/catch and use
// optional-chaining (`window.__diag?.wire?.onEvent?.(evt)`) so the diag
// surface is fail-soft during the boot window where the drain may run
// before diag finishes installing.
//
// Devtools entry points exposed on `__diag.wire`:
//   counters    — { "event:<kind>": N, "entity:<kind>": N, ... }
//   tail        — last 200 records mixed chronologically
//   byKind(k)   — filter tail by numeric kind (matches both domains)
//   summary()   — total + byKind + byCategory + windowMs
//   reset()     — zero counters + clear tail

const MAX_TAIL_DEFAULT = 200;
const SNIPPET_LIMIT = 60;

// Category map: domain:kind → category name. summary().byCategory sums every
// recorded (domain, kind) into the named bucket. Categories are loose — they
// match how an operator thinks about the packet stream (chat / combat /
// sound / position / motion / spawn / despawn / etc.), not 1:1 with kinds.
const CATEGORY_MAP = Object.freeze({
  "event:1":  "spawn",      // PlayerSpawned
  "event:2":  "chat",       // ChatReceived
  "event:11": "container",  // InventoryUpdated
  "event:12": "vendor",     // VendorOpened
  "event:15": "door",       // DoorStateChanged
  "event:16": "sound",      // SoundTriggered
  "event:19": "combat",     // CombatEvent
  "event:21": "container",  // ContainerOpened
  "entity:0": "position",   // KIND_POSITION
  "entity:1": "spawn",      // KIND_SPAWN
  "entity:2": "despawn",    // KIND_REMOVE
  "entity:5": "motion",     // KIND_MOTION
});

/** Truncate a string for the tail snippet column. */
function snippet(s) {
  if (typeof s !== "string" || s.length === 0) return undefined;
  return s.length > SNIPPET_LIMIT ? s.slice(0, SNIPPET_LIMIT) : s;
}

/** Coerce any nullable u32-shaped field to undefined when absent. */
function u32OrUndef(n) {
  if (n === null || n === undefined) return undefined;
  // Numeric-coerce so wasm-bindgen Number values land as plain u32.
  return (n >>> 0);
}

/** Build a small record from a ClientEvent. Fields per the kind table. */
function recordFromEvent(evt) {
  const k = (evt.kind | 0);
  const r = { t: performance.now(), k, d: "event" };
  // Primary guid lives in u32Payload for the vast majority of kinds
  // (PlayerSpawned, doors, vendor, container, sound, visibility, airborne,
  // combat). Chat / disconnected / errors have no guid — leave undefined.
  const g = u32OrUndef(evt.u32Payload);
  if (g !== undefined && g !== 0) r.g = g;
  // Snippet from stringPayload for chat / errors / vendor names / etc.
  const s = snippet(evt.stringPayload);
  if (s !== undefined) r.s = s;
  return r;
}

/** Build a small record from an EntityUpdate. guid is on `upd.guid`. */
function recordFromEntity(upd) {
  const k = (upd.kind | 0);
  const r = { t: performance.now(), k, d: "entity" };
  const g = u32OrUndef(upd.guid);
  if (g !== undefined) r.g = g;
  return r;
}

/** Add a record to the ring buffer, shifting once when over capacity. */
function pushTail(wire, rec) {
  const tail = wire.tail;
  tail.push(rec);
  // shift() once is amortized O(1) for our cap (200) — over 100x cheaper
  // than rebuilding the array. Don't loop: cap is only exceeded by one
  // per call, so a single shift restores the invariant.
  if (tail.length > wire.maxTail) tail.shift();
}

export function attachWire(diag) {
  const counters = Object.create(null);   // null-proto: cleaner devtools display

  const wire = {
    counters,
    tail: [],
    maxTail: MAX_TAIL_DEFAULT,

    onEvent(evt) {
      if (!evt || typeof evt.kind !== "number") return;
      const rec = recordFromEvent(evt);
      const key = "event:" + rec.k;
      counters[key] = (counters[key] ?? 0) + 1;
      pushTail(wire, rec);
    },

    onEntityUpdate(upd) {
      if (!upd || typeof upd.kind !== "number") return;
      const rec = recordFromEntity(upd);
      const key = "entity:" + rec.k;
      counters[key] = (counters[key] ?? 0) + 1;
      pushTail(wire, rec);
    },

    /**
     * Filter the tail ring buffer to records with the given numeric kind.
     * Matches across BOTH domains (event:k and entity:k). Use the `d`
     * field on the returned records to disambiguate.
     */
    byKind(kind) {
      const k = (kind | 0);
      return wire.tail.filter((r) => r.k === k);
    },

    summary() {
      // byKind copy: drop the null-proto so consumers can JSON.stringify.
      const byKind = {};
      for (const key in counters) byKind[key] = counters[key];

      const byCategory = {
        spawn: 0, chat: 0, combat: 0, sound: 0, door: 0,
        container: 0, vendor: 0, position: 0, motion: 0, despawn: 0,
      };
      let total = 0;
      for (const key in counters) {
        const n = counters[key];
        total += n;
        const cat = CATEGORY_MAP[key];
        if (cat !== undefined) byCategory[cat] += n;
      }

      const first = wire.tail[0];
      const windowMs = first ? (performance.now() - first.t) : 0;

      return { total, byKind, byCategory, windowMs };
    },

    reset() {
      for (const key in counters) delete counters[key];
      wire.tail.length = 0;
    },
  };

  diag.wire = wire;
}
