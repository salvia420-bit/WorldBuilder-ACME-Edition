// Retail 16-voice sound pool — pure slot-selection logic.
//
// Ported from OpenAC src/AcDream.Core/Audio/RetailVoicePool.cs (MIT,
// Copyright (c) 2026 Erik Nihlén and OpenAC contributors).
//
// Retail SoundManager::PlaySoundInternal(SoundBufRef*, pan, attenuation)
// (acclient.c:383004-383067, read 2026-10-05):
//   - `playing_sounds_` is a fixed array of 16 SoundPlayingData
//     {SoundBuf *buffer; float priority; long double start_time}
//     (acclient.h:46404) scanned as a ring from `curr_playing_buffer_`.
//   - pass 1 (383019-383027): the first slot that is empty, has no
//     DirectSound buffer, or whose buffer is no longer PLAYING
//     (GetStatus & 1 == 0) is reused.
//   - pass 2 (383028-383040): every slot is busy; take the first slot in
//     ring order whose recorded priority is STRICTLY lower than the new
//     sound's (`flt_86F514[4*v4] < current_sound->data_.priority_`) and
//     Stop() it. If none, the new sound is DROPPED (`return`).
//   - the claimed slot records the priority + start time and the cursor
//     advances to claimed+1 mod 16 (383061-383066).
//
// Note on priority: the recorded value is `current_sound->data_.priority_`
// — the SoundBufRef's OWN SoundData, which only SoundData::SoundData
// (acclient.c:384780-384786, priority_ = 0) ever writes; GetSound copies the
// SoundTable row into the caller's local `stdata`, never into the ref
// (383452-383456). So in retail every voice records priority 0, nothing is
// strictly lower than 0, and a 17th concurrent sound is dropped rather than
// cutting a playing one short. VOICE_PRIORITY below is that constant.

export const VOICE_COUNT = 16;
/** Sentinel: no slot available — drop the sound. */
export const NO_SLOT = -1;
/** The priority every retail voice records (SoundData ctor default). */
export const VOICE_PRIORITY = 0;

function ring(cursor, offset, n) {
  const idx = (cursor + offset) % n;
  return idx < 0 ? idx + n : idx;
}

/**
 * Pick the slot a new sound plays in.
 *
 * @param {ReadonlyArray<{occupied:boolean, stillPlaying:boolean, priority:number}>} slots
 * @param {number} cursor   ring start (retail curr_playing_buffer_)
 * @param {number} priority the new sound's priority
 * @returns {number} slot index, or NO_SLOT to drop the sound
 */
export function acquireVoice(slots, cursor, priority) {
  const n = slots ? slots.length : 0;
  if (n === 0) return NO_SLOT;
  for (let i = 0; i < n; i++) {
    const idx = ring(cursor, i, n);
    const s = slots[idx];
    if (!s || !s.occupied || !s.stillPlaying) return idx;
  }
  for (let i = 0; i < n; i++) {
    const idx = ring(cursor, i, n);
    if (slots[idx].priority < priority) return idx;
  }
  return NO_SLOT;
}

/** Cursor after claiming `claimed` (retail `(v4 + 1) % 16`). */
export function advanceCursor(claimed, slotCount) {
  return slotCount <= 0 ? 0 : (claimed + 1) % slotCount;
}

/**
 * Stateful 16-slot pool around acquireVoice. Each slot holds an opaque
 * `voice` handle with a `stop()` the pool calls when it steals the slot.
 * The owner calls `release(token)` when the voice finishes (source
 * `onended`), which marks the slot not-playing so pass 1 reuses it.
 */
export class VoicePool {
  constructor(count = VOICE_COUNT) {
    this.count = count;
    this.cursor = 0;
    /** @type {Array<{occupied:boolean, stillPlaying:boolean, priority:number, voice:any, token:number}>} */
    this.slots = Array.from({ length: count }, () => ({
      occupied: false, stillPlaying: false, priority: 0, voice: null, token: 0,
    }));
    this._nextToken = 1;
    this.dropCount = 0;
    this.stealCount = 0;
  }

  /**
   * Claim a slot for `voice`. Returns a token (>0) to pass to release(),
   * or 0 when the sound must be dropped.
   */
  claim(voice, priority = VOICE_PRIORITY) {
    const idx = acquireVoice(this.slots, this.cursor, priority);
    if (idx === NO_SLOT) {
      this.dropCount += 1;
      return 0;
    }
    const s = this.slots[idx];
    if (s.occupied && s.stillPlaying && s.voice) {
      // Pass-2 steal: retail SoundBuf::Stop (acclient.c:383043).
      this.stealCount += 1;
      const old = s.voice;
      s.voice = null;
      try { old.stop?.(); } catch (_) {}
    }
    const token = this._nextToken++;
    s.occupied = true;
    s.stillPlaying = true;
    s.priority = priority;
    s.voice = voice;
    s.token = token;
    this.cursor = advanceCursor(idx, this.count);
    return token;
  }

  /** Mark the voice holding `token` as finished (no-op if already reused). */
  release(token) {
    if (!token) return;
    for (const s of this.slots) {
      if (s.token === token) {
        s.stillPlaying = false;
        s.voice = null;
        return;
      }
    }
  }

  activeCount() {
    let n = 0;
    for (const s of this.slots) if (s.occupied && s.stillPlaying) n += 1;
    return n;
  }
}
