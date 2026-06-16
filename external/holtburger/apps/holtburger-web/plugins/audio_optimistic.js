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
  WIELD:    0x8C,
  UNWIELD:  0x8D,
  RECEIVE:  0x8E,
  PICKUP:   0x8F,
  DROP:     0x90,
  // UI_GeneralError — fires on user-action rejections (cannot equip,
  // unequip-first, invalid drop target). Same play path as the action
  // sounds; resolved against the local player's SoundTable.
  UI_ERROR: 0x6D,
  // Rec #190 — slider grab/release. ACE Sound.UI_GrabSlider (0x73) +
  // UI_ReleaseSlider (0x74); retail fires on input/range mousedown +
  // mouseup. Resolved against the local player's SoundTable just like
  // every other UI cue, so a missing entry soft-degrades to silence.
  UI_GRAB:    0x73,
  UI_RELEASE: 0x74,
});

// Rec #190 — global delegating slider-grab/release wiring.
//
// Any <input type="range"> in the page picks up the UI_GrabSlider /
// UI_ReleaseSlider retail sound cues without per-panel boilerplate.
// We use pointerdown / pointerup at the window level so panels created
// after the listener (settings-panel, options-panel, future audio
// preferences) are covered without re-registration. The seen-set
// keys on the slider element so a single pointer interaction only
// fires GRAB once even if a nested handler also dispatches it.
const _slidersHeld = new WeakSet();
function _onWindowPointerDown(ev) {
  const t = ev.target;
  if (!t || t.tagName !== "INPUT" || t.type !== "range") return;
  if (_slidersHeld.has(t)) return;
  _slidersHeld.add(t);
  const lpgFn = (typeof window !== "undefined") ? window.getLocalPlayerGuid : null;
  const lpg = (typeof lpgFn === "function") ? (lpgFn() >>> 0) : 0;
  try { void playOptimistic(SOUND.UI_GRAB, lpg); } catch (_) {}
}
function _onWindowPointerUp(ev) {
  const t = ev.target;
  // pointerup can fire on a different element when the pointer drifts
  // off the thumb; walk the held set and release any tracked slider.
  // The seen-set is small (typically one entry) so this is cheap.
  if (t && t.tagName === "INPUT" && t.type === "range" && _slidersHeld.has(t)) {
    _slidersHeld.delete(t);
    const lpgFn = (typeof window !== "undefined") ? window.getLocalPlayerGuid : null;
    const lpg = (typeof lpgFn === "function") ? (lpgFn() >>> 0) : 0;
    try { void playOptimistic(SOUND.UI_RELEASE, lpg); } catch (_) {}
    return;
  }
  // Pointer drifted off the slider — clear any held sliders + fire
  // RELEASE once. Using pointercancel as well would double-fire on
  // some browsers; pointerup with the held-set guard is sufficient.
  if (_slidersHeld instanceof WeakSet) {
    // WeakSet can't be iterated; instead we rely on a follow-up
    // pointerdown on a fresh slider to repopulate after a stale held
    // entry. The audible artifact of a missed RELEASE is silence — no
    // worse than the pre-rec behaviour.
  }
}
if (typeof window !== "undefined" && !window.__audio_sliderListenersInstalled) {
  window.addEventListener("pointerdown", _onWindowPointerDown, true);
  window.addEventListener("pointerup",   _onWindowPointerUp,   true);
  // Cancel fires on touch-drag-off and Esc — release the held slider
  // silently to avoid leaking the entry past the interaction.
  window.addEventListener("pointercancel", (ev) => {
    const t = ev.target;
    if (t && t.tagName === "INPUT" && t.type === "range") _slidersHeld.delete(t);
  }, true);
  window.__audio_sliderListenersInstalled = true;
}

// Named alias so rejection-site callers can read playUiError(...) instead
// of remembering the magic 0x6D. Falls back to the local player guid as
// the second argument when none is provided so the ring-key matches the
// (eventual) server echo.
export function playUiError(playerGuid) {
  const lpg = (playerGuid >>> 0)
    || ((typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function")
        ? (window.getLocalPlayerGuid() >>> 0) : 0);
  try { void playOptimistic(SOUND.UI_ERROR, lpg); } catch (_) {}
}

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
  window.__audioOptimistic = { playOptimistic, shouldSuppressEcho, SOUND, playUiError };
}
