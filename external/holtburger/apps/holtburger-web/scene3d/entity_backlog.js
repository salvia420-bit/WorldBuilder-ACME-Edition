// scene3d/entity_backlog.js — compaction of the pre-3D entity-update backlog (2026-10-06).
//
// index.html buffers every EntityUpdate (plain clones) in `window.__scene3dEntityBacklog` until
// init3D installs the 3D drain hook; loop.js `installSharedDrainHook` then replays the buffer in
// arrival order. When a slow init3D let the buffer pass 512 events, the old A15-Q1 policy kept
// every SPAWN and the NEWEST other events and dropped the oldest — treating REMOVE, APPEARANCE and
// ATTACH like position filler. After the replay that meant objects that had left the world came
// back as ghosts, clothing/palette changes were lost, and wielded items were never put in hand.
// Seen on a slow remote boot (2026-10-06 console: "[A15-Q1] __scene3dEntityBacklog exceeded 512").
//
// Compaction now drops only updates that a NEWER update of the same kind for the same guid
// supersedes — POSITION, VELOCITY, MOTION, MOTION_ACTION and TURN each carry that object's whole
// current state of that kind (a stale one-shot action is history by replay time) — and keeps every
// SPAWN, REMOVE, META_REFRESH, APPEARANCE and ATTACH. Kept events stay in arrival order in the SAME
// array (the replay `splice(0)`s it). Only when the survivors still exceed `hardCap` — a session
// whose 3D hook never installs (2D mode) — are the oldest kept events dropped, spawns last.
//
// Pure: no window, no DOM, no wasm; node-tested (test_entity_backlog.mjs).

import { KIND } from "./entity_dispatch.js";

/** Kinds where only the newest update per guid matters. */
export const COALESCE_KINDS = new Set([KIND.POSITION, KIND.VELOCITY, KIND.MOTION, KIND.MOTION_ACTION, KIND.TURN]);

/** Default bound on what survives a compaction (memory guard for a never-drained backlog). */
export const BACKLOG_HARD_CAP = 8192;

/**
 * Compact the backlog in place.
 * @param {Array<{kind:number, guid:number}>} b the backlog, oldest first; mutated in place
 * @param {{ hardCap?: number }} [o]
 * @returns {{ before:number, after:number, coalesced:number, hardDropped:number, spawnsDropped:number }}
 */
export function compactEntityBacklog(b, { hardCap = BACKLOG_HARD_CAP } = {}) {
  const before = b.length;
  const keep = new Uint8Array(before);
  // newest first: the first (newest) coalescible update per (guid, kind) wins
  const seen = new Set();
  let coalesced = 0;
  for (let i = before - 1; i >= 0; i--) {
    const e = b[i];
    if (!e) continue;
    const kind = e.kind | 0;
    if (COALESCE_KINDS.has(kind)) {
      const key = (e.guid >>> 0) * 16 + kind; // kind < 16; exact in a double (2^36)
      if (seen.has(key)) { coalesced++; continue; }
      seen.add(key);
    }
    keep[i] = 1;
  }
  let kept = 0;
  for (let i = 0; i < before; i++) kept += keep[i];
  // hard cap: oldest non-spawns first, then oldest spawns
  let hardDropped = 0, spawnsDropped = 0;
  for (let pass = 0; pass < 2 && kept > hardCap; pass++) {
    for (let i = 0; i < before && kept > hardCap; i++) {
      if (!keep[i]) continue;
      const isSpawn = (b[i].kind | 0) === KIND.SPAWN;
      if (pass === 0 && isSpawn) continue;
      keep[i] = 0;
      kept--;
      hardDropped++;
      if (isSpawn) spawnsDropped++;
    }
  }
  let w = 0;
  for (let i = 0; i < before; i++) if (keep[i]) b[w++] = b[i];
  b.length = w;
  return { before, after: w, coalesced, hardDropped, spawnsDropped };
}
