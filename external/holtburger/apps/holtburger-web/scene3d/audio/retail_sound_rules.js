// Retail sound-dispatch rules — pure helpers (no Web Audio, no DOM).
//
// Every rule cites the acclient.c lines it was read from (2026-10-05).

/** Retail SoundManager::PlayProbability: rand()*(1/32767) < p (acclient.c:383121-383124). */
export function rollProbability(probability, rng = Math.random) {
  const p = Number.isFinite(probability) ? probability : 1.0;
  return rng() < p;
}

/**
 * Per-sound volume as retail passes it to GetAttenuation. A missing field
 * means "no volume authored" (1.0); an authored 0 is SILENT — GetAttenuation
 * drops anything not > 0 (acclient.c:383096-383115). The old
 * `v > 0 ? v : 1.0` turned silent rows into full-volume ones.
 */
export function retailVolume(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : 1.0;
}

/**
 * Server Sound 0xF750 (GameMessageSound guid, sound, volume):
 *   SmartBox::HandleSoundEvent (acclient.c:143333) -> CPhysicsObj::play_sound
 *   (316424, needs a sound table) -> SoundManager::PlaySoundA(stype, obj,
 *   volume) (383655-383678): GetSound picks the row, PlayProbability rolls the
 *   ROW's probability, and PlaySoundInternal gets the WIRE volume — the row's
 *   volume is not used. GetAttenuation then silences volume <= 0.
 *
 * @param {{probability:number}|null} entry resolved SoundTable row
 * @param {number} wireVolume f32 from the message (ACE default 1.0)
 * @returns {{play:boolean, gain:number, reason:string}}
 */
export function serverSoundPlan(entry, wireVolume, rng = Math.random) {
  if (!entry) return { play: false, gain: 0, reason: "no_entry" };
  const gain = (typeof wireVolume === "number") ? wireVolume : 1.0;
  if (!rollProbability(entry.probability, rng)) return { play: false, gain, reason: "probability" };
  if (!(gain > 0)) return { play: false, gain, reason: "wire_volume_silent" };
  return { play: true, gain, reason: "ok" };
}

/**
 * AdminEnvirons sound options -> UI SoundType, per
 * CPlayerSystem::Handle_Admin__Environs (acclient.c:396430-396545):
 * 101..114 -> Sound_UI_Roar(0x76)..Sound_UI_LostSouls(0x83);
 * 115, 116 -> nothing (no case; default returns);
 * 117 -> Sound_UI_Squeal(0x84); 118..123 -> Sound_UI_Thunder1..6 (0x85..0x8A).
 * Anything else -> 0 (no sound).
 */
export function environSoundType(option) {
  const o = option >>> 0;
  if (o >= 101 && o <= 114) return (o + 0x11) >>> 0;
  if (o >= 117 && o <= 123) return (o + 0x0f) >>> 0;
  return 0;
}

// ClientUISystem::GetUISoundTable (acclient.c:401286-401293):
// DBObj::GetByEnum(0x10000003, 7, 0x22) — the UI SoundTable through the
// EnumIDMap (OpenAC UiSoundTableResolver: master map slot 7, key 0x10000003).
export const UI_SOUND_TABLE_ENUM = 0x10000003;
export const UI_SOUND_TABLE_CATEGORY = 7;
// DAT-verified value the enum resolves to on the retail portal.dat (the
// unique 0x20 table carrying every UI_* slot incl. the 21 environ sounds);
// used when the wasm export is missing or the walk returns 0.
export const UI_SOUND_TABLE_FALLBACK = 0x2000004b;

let _uiStbPromise = null;
/** Resolve (once) the UI SoundTable DID via wasm resolveClientEnumDid. */
export function resolveUiSoundTableDid(wasm) {
  if (_uiStbPromise) return _uiStbPromise;
  _uiStbPromise = (async () => {
    try {
      if (typeof wasm?.resolveClientEnumDid === "function") {
        const d = (await wasm.resolveClientEnumDid(UI_SOUND_TABLE_ENUM, UI_SOUND_TABLE_CATEGORY)) >>> 0;
        if (d) return d;
      }
    } catch (_) { /* fall back */ }
    return UI_SOUND_TABLE_FALLBACK;
  })();
  // Don't pin a fallback forever if wasm was simply not ready yet.
  _uiStbPromise.then((d) => {
    if (d === UI_SOUND_TABLE_FALLBACK && typeof wasm?.resolveClientEnumDid !== "function") _uiStbPromise = null;
  });
  return _uiStbPromise;
}
export function _resetUiSoundTableForTest() { _uiStbPromise = null; }

/**
 * Retail SoundManager::PlaySoundFromCenter(stype, table) (acclient.c:
 * 383569-383589): GetSound -> PlayProbability(row.probability) ->
 * GetAttenuation(0.0, row.volume, effect) -> play with pan 0.
 *
 * @param {{audioManager:any, soundTableCache:any}} live
 * @param {number} soundTableDid
 * @param {number} soundType
 * @returns {Promise<object|null>} the voice handle, or null
 */
export async function playSoundFromCenter(live, soundTableDid, soundType, { rng = Math.random, category } = {}) {
  const audioMgr = live?.audioManager;
  const cache = live?.soundTableCache;
  if (!audioMgr || !cache || !soundTableDid) return null;
  const entry = await cache.resolveSound(soundTableDid >>> 0, soundType >>> 0);
  if (!entry) return null;
  if (!rollProbability(entry.probability, rng)) return null;
  if (typeof audioMgr.playFromCenter !== "function") return null;
  return audioMgr.playFromCenter(entry.waveDid, retailVolume(entry.volume), category ? { category } : {});
}

/** PlaySoundFromCenter against the UI SoundTable (GetUISoundTable). */
export async function playUiSound(live, soundType, opts = {}) {
  const stb = await resolveUiSoundTableDid(live?.wasmExports);
  return playSoundFromCenter(live, stb, soundType, opts);
}

/**
 * Sounds for objects the client does not know yet. Retail
 * SmartBox::HandleSoundEvent (acclient.c:143333-143350) queues the blob on
 * a null object (CObjectMaint::QueueBlobForObject 310848-310861): the FIRST
 * blob for an unknown id creates the null object and schedules its
 * destruction once, at cur_time + 25.0 (AddObjectToBeDestroyed 310666);
 * later blobs for the same id join that object and share its deadline. The
 * blobs are replayed when the real object is created. Here: one deadline
 * per guid from its first queue; `drain(guid)` replays synchronously and is
 * called from the entity-insert hook (entities.js, next to
 * drainPendingPlayEffects).
 */
export const OBJECT_BLOB_TTL_S = 25.0;
export class PendingObjectSounds {
  constructor({ now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) } = {}) {
    this._now = now;
    /** @type {Map<number, {deadline:number, replays:Array<() => void>}>} */
    this.byGuid = new Map();
    this.replayed = 0;
    this.expired = 0;
  }

  get size() {
    let n = 0;
    for (const e of this.byGuid.values()) n += e.replays.length;
    return n;
  }

  add(guid, replay) {
    const now = this._now();
    this.prune(now);
    const g = guid >>> 0;
    let e = this.byGuid.get(g);
    if (!e) {
      e = { deadline: now + OBJECT_BLOB_TTL_S * 1000, replays: [] };
      this.byGuid.set(g, e);
    }
    e.replays.push(replay);
  }

  /** Replay (in arrival order) every sound queued for `guid`. */
  drain(guid) {
    const now = this._now();
    this.prune(now);
    const g = guid >>> 0;
    const e = this.byGuid.get(g);
    if (!e) return 0;
    this.byGuid.delete(g);
    for (const r of e.replays) {
      this.replayed += 1;
      try { r(); } catch (_) {}
    }
    return e.replays.length;
  }

  prune(now = this._now()) {
    for (const [g, e] of this.byGuid) {
      if (now > e.deadline) {
        this.expired += e.replays.length;
        this.byGuid.delete(g);
      }
    }
  }
}

/** The session-wide queue (client_events queues, entities.js drains). */
export const pendingObjectSounds = new PendingObjectSounds();
export function drainPendingObjectSounds(guid) {
  return pendingObjectSounds.drain(guid);
}
