// Wave C / PR10 (2026-06-06) — optimistic-audio helper.
//
// Fires inventory-action sound cues at click time, BEFORE the wire send,
// so the player hears the wield/unwield/pickup/drop sound immediately
// instead of after the ACE round-trip (typically 100-300ms). The server
// broadcasts a matching GameMessageSound 0xF750 a few hundred ms later;
// the recent-fire ring here lets the server-broadcast consumer in
// index.html suppress the echo to avoid double-playing.
//
// ACE Sound enum values (per ace-server/Source/ACE.Entity/Enum/Sound.cs):
//   WieldObject   = 0x8C
//   UnwieldObject = 0x8D
//   ReceiveItem   = 0x8E
//   PickUpItem    = 0x8F
//   DropItem      = 0x90

export const SOUND = Object.freeze({
  WIELD:   0x8C,
  UNWIELD: 0x8D,
  RECEIVE: 0x8E,
  PICKUP:  0x8F,
  DROP:    0x90,
});

const TTL_MS = 300;
const recentFire = new Map(); // key=`${soundId}:${playerGuid}` -> expiresAtMs

// The key is (soundId, playerGuid) NOT (soundId, itemGuid): ACE's
// GameMessageSound carries the sound-emitting entity GUID, which for
// player-emitted inventory action sounds is the local player. Keying on
// the item GUID would never match the echo and the dedupe would no-op.
function ringKey(soundId, playerGuid) {
  return `${(soundId >>> 0)}:${(playerGuid >>> 0)}`;
}

/**
 * Returns true when the (soundId, playerGuid) pair was fired optimistically
 * within the last TTL_MS. The server-broadcast consumer (kind=16) checks
 * this BEFORE calling audioManager.play() and skips the play on a hit.
 * One-shot: consumes the entry so a second genuine fire still plays.
 *
 * Callers from the server-sound dispatch pass the SoundTriggered entity
 * GUID (=player GUID for player-emitted action sounds) as the second arg.
 */
export function shouldSuppressEcho(soundId, playerGuid) {
  const key = ringKey(soundId, playerGuid);
  const expires = recentFire.get(key);
  if (!expires) return false;
  const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
  if (now > expires) {
    recentFire.delete(key);
    return false;
  }
  recentFire.delete(key);
  return true;
}

/**
 * Fire an inventory-action sound at the local player's position. Resolves
 * the wave through the entity's SoundTable + the shared SoundTableCache,
 * then plays via the global AudioManager. Records the fire in the recent
 * ring so the matching server broadcast can be suppressed.
 */
export async function playOptimistic(soundId, itemGuid) {
  try {
    const live = window.liveScene3d;
    const audioMgr = live?.audioManager;
    const cache = live?.soundTableCache;
    const em = live?.entityManager;
    if (!audioMgr || !cache || !em) return;
    const lpgFn = window.getLocalPlayerGuid;
    const lpg = (typeof lpgFn === "function") ? (lpgFn() >>> 0) : 0;
    if (lpg === 0) return;
    const inst = em.entityMap?.get?.(lpg);
    const stbDid = (inst?.soundTableDid >>> 0) || 0;
    if (stbDid === 0) return;
    // Record BEFORE the await so an echo arriving mid-resolution is
    // suppressed correctly. itemGuid is preserved on the call shape for
    // future debugging/telemetry; the ring key is (soundId, playerGuid)
    // because that's what the server-broadcast echo carries.
    void itemGuid;
    const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
    recentFire.set(ringKey(soundId, lpg), now + TTL_MS);
    const entry = await cache.resolveSound(stbDid, (soundId >>> 0));
    if (!entry) return;
    const pos = inst?.root?.position;
    if (!pos) return;
    const baseVol = (entry.volume > 0) ? entry.volume : 1.0;
    await audioMgr.play(
      entry.waveDid,
      { x: pos.x, y: pos.y, z: pos.z },
      { gain: baseVol * 0.5 },
    );
  } catch (_) { /* best-effort */ }
}

// Expose for the server-broadcast consumer in index.html which lives
// outside ES-module scope (loaded via <script>, not import).
if (typeof window !== "undefined") {
  window.__audioOptimistic = { playOptimistic, shouldSuppressEcho, SOUND };
}
