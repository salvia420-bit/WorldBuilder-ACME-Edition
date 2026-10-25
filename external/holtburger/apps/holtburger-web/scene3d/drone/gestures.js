// scene3d/drone/gestures.js — Drone Deploy (2026-10-24; DEFAULT ON since 2026-10-25, `?drone=off` disables it).
//
// The pilot's gestures: the three retail-frame JS clips (reach into the pack,
// kneel and place, goggles on), the held ReadState tablet pose, the held-motion
// watchdog and the local wielded-item hide. Contract: scene3d/drone/SPEC.md
// §3.1 (exports, ClipDescriptor, RigProfile, GesturePoll), §6.10 (the wielded
// hider, verbatim), §6.12 (rebind), DV-12 (motions at speed 1), DV-13 (no Ready
// on a death-held rig).
//
// Two halves, both self-contained (this file imports nothing; every live object
// is injected):
//   * pure — `clipFrameCount`, `buildClip`, `rigProfile`, `GESTURE_CLIPS` and the
//     constants. No window / document / three / wasm / clocks / Math.random: the
//     same inputs give deep-equal outputs, and they run in plain node.
//   * page — `loadAnim` (wasm `fetchAnimation`), `readHoldingLocations` (the
//     EntityManager's cached holding table), `createWieldedHider` and
//     `createGestureDriver`, which plays the clips through the entities.js seam
//     `playLocalClip` / `stopLocalClip` (SPEC §6.1) and reports each clip's event
//     frame and end to the frame driver once per frame through `poll(dt)`.
//
// Why clips: on the local rig `setMotion(Pickup)` / `setMotion(StoreInBackpack)`
// play only the Ready→cmd link and snap back upright in one frame (PLAN §13,
// SPEC A1). A clip built from the retail frames plays down and back up smoothly
// (the 1070 probe matched retail Cry frame 17 with zero position error). The
// tablet pose is the retail ReadState held emote state, which `setMotion`
// enters, holds and leaves smoothly. Nothing here sends anything to the server.

// ---------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------

/** Floats per (frame, part) record: `[x, y, z, qw, qx, qy, qz]`, w-first (SPEC §2.1). */
export const FLOATS_PER_PART = 7;

/**
 * The 34-part humanoid rig every humanoid heritage shares (recon/rig-table.json):
 * RightHand holding location on part 15, LeftHand on part 12, the head is part 16
 * (a humanoid constant: no holding entry exists for it). `minParts` is the
 * smallest part count that can carry those indices.
 */
export const HUMANOID_RIG = Object.freeze({ rightHand: 15, leftHand: 12, head: 16, minParts: 17 });

/** ACE ParentLocation key of the client's holding table: RightHand. */
export const LOC_RIGHT_HAND = 1;

/** ACE ParentLocation key of the client's holding table: LeftHand. */
export const LOC_LEFT_HAND = 2;

/**
 * Motion commands (full 32-bit) and the stance the gestures run in: Ready,
 * the ReadState held emote state (the tablet pose) and NonCombat.
 */
export const MOTION = Object.freeze({ READY: 0x41000003, READ_STATE: 0x43000146, NONCOMBAT: 0x8000003d });

/**
 * The three gesture clips. `anim` = the retail Animation DID, `plan` = source
 * frame ranges (`{from, to}` inclusive, `to < from` plays reversed) and holds
 * (`{hold, frames}` repeats source frame `hold` `frames` times), `eventAtFrame`
 * = the CLIP frame of the prop event (drone appears / is released / goggles on),
 * `frames` = the clip length (`clipFrameCount(plan)`). Every level is frozen.
 * - pack: StoreInBackpack 0x030003B7 (reach over the shoulder and back down).
 * - place: Pickup 0x03000247 (kneel, set the drone down, stand).
 * - goggles: Cry 0x030004F8 frames 0..20 (both hands to the eyes and back).
 */
export const GESTURE_CLIPS = Object.freeze({
  pack: Object.freeze({
    anim: 0x030003b7,
    plan: Object.freeze([Object.freeze({ from: 0, to: 19 }), Object.freeze({ hold: 19, frames: 3 }), Object.freeze({ from: 19, to: 0 })]),
    eventAtFrame: 18,
    frames: 43,
  }),
  place: Object.freeze({
    anim: 0x03000247,
    plan: Object.freeze([Object.freeze({ from: 0, to: 21 }), Object.freeze({ hold: 21, frames: 6 }), Object.freeze({ from: 21, to: 0 })]),
    eventAtFrame: 18,
    frames: 50,
  }),
  goggles: Object.freeze({
    anim: 0x030004f8,
    plan: Object.freeze([Object.freeze({ from: 0, to: 20 }), Object.freeze({ from: 20, to: 0 })]),
    eventAtFrame: 14,
    frames: 42,
  }),
});

const CLIP_NAMES = Object.freeze(["pack", "place", "goggles"]);
// The clips are authored at the retail 30 fps; timer jobs and event times use it.
const GESTURE_FPS = 30;
// A plan longer than this (two minutes at 30 fps) is treated as bad: it would only
// come from a typo, and the clip buffer is frames · parts · 7 floats.
const MAX_CLIP_FRAMES = 3600;
// Timer comparisons tolerate the float residue of a Σdt clock.
const TIME_EPS = 1e-9;
// Held-motion watchdog: at most one re-issue per second.
const WATCH_INTERVAL_SEC = 1.0;

function planEntryKind(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  if ("hold" in e) {
    return Number.isInteger(e.hold) && e.hold >= 0 && Number.isInteger(e.frames) && e.frames >= 1 ? "hold" : null;
  }
  if ("from" in e && "to" in e) {
    return Number.isInteger(e.from) && e.from >= 0 && Number.isInteger(e.to) && e.to >= 0 ? "range" : null;
  }
  return null;
}

/**
 * The number of clip frames a plan produces: Σ (|to − from| + 1) over the ranges
 * plus Σ frames over the holds.
 * @param {Array<{from: number, to: number}|{hold: number, frames: number}>} plan
 * @returns {number} 0 for a bad plan (not an array, empty, a non-object entry, an
 *   entry that is neither a range nor a hold, non-integer / negative indices, a
 *   hold of fewer than one frame, or more than 3600 frames in all)
 */
export function clipFrameCount(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const e = plan[i];
    const kind = planEntryKind(e);
    if (kind === "hold") n += e.frames;
    else if (kind === "range") n += Math.abs(e.to - e.from) + 1;
    else return 0;
    if (n > MAX_CLIP_FRAMES) return 0;
  }
  return n;
}

/**
 * Build a one-shot clip descriptor (the shape entities.js `poseRigAt` and the
 * Rust `MotionSequence.fromDescriptor` read) from retail Animation frames.
 * Clip frame k copies source frame `sourceFrames[k]` (all `numParts · 7` floats)
 * unchanged; root motion (Animation POS_FRAMES, `flags & 1`) is never carried.
 *
 * @param {{numFrames: number, numParts: number, frames: Float32Array|number[],
 *   did?: number, flags?: number}} anim AnimationJs shape (`frames` of length
 *   numFrames · numParts · 7; a plain number array is accepted for fixtures)
 * @param {Array<{from: number, to: number}|{hold: number, frames: number}>} plan
 * @param {{fps?: number}} [opts] `{fps = 30}` — the clip framerate
 * @returns {{partCount: number, numFrames: number, framerate: number,
 *   partFrames: Float32Array, frameTimes: Float32Array, duration: number,
 *   posFrames: null, segmentStarts: Uint32Array, segmentCounts: Uint32Array,
 *   segmentFramerates: Float32Array, segmentAnimIds: Uint32Array,
 *   rootFrames: null, sourceFrames: Uint16Array}|null} null (never a throw) for
 *   a missing / non-positive numParts or numFrames, a frames length mismatch, a
 *   bad plan, any source frame outside [0, numFrames), or fps <= 0. `posFrames`
 *   is null, never an empty array: `poseRigAt` tests its truthiness and an empty
 *   array poses NaN.
 */
export function buildClip(anim, plan, opts = undefined) {
  // `{fps = 30} = {}`, spelled out so a `null` options argument cannot throw.
  const fps = opts && typeof opts === "object" && opts.fps !== undefined ? opts.fps : GESTURE_FPS;
  if (!anim || typeof anim !== "object") return null;
  const nf = anim.numFrames;
  const np = anim.numParts;
  if (!Number.isInteger(nf) || nf <= 0 || !Number.isInteger(np) || np <= 0) return null;
  const frames = anim.frames;
  if (!frames || typeof frames.length !== "number" || frames.length !== nf * np * FLOATS_PER_PART) return null;
  const rate = +fps;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const n = clipFrameCount(plan);
  if (n === 0) return null;
  const order = new Uint16Array(n);
  let k = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const e = plan[i];
    if ("hold" in e) {
      if (e.hold >= nf) return null;
      for (let j = 0; j < e.frames; j += 1) order[k++] = e.hold;
    } else {
      if (e.from >= nf || e.to >= nf) return null;
      const dir = e.to >= e.from ? 1 : -1;
      for (let f = e.from; dir > 0 ? f <= e.to : f >= e.to; f += dir) order[k++] = f;
    }
  }
  const stride = np * FLOATS_PER_PART;
  const partFrames = new Float32Array(n * stride);
  const typed = ArrayBuffer.isView(frames) && typeof frames.subarray === "function";
  for (let c = 0; c < n; c += 1) {
    const src = order[c] * stride;
    const dst = c * stride;
    if (typed) {
      partFrames.set(frames.subarray(src, src + stride), dst);
    } else {
      for (let i = 0; i < stride; i += 1) partFrames[dst + i] = frames[src + i];
    }
  }
  const frameTimes = new Float32Array(n);
  for (let c = 0; c < n; c += 1) frameTimes[c] = c / rate;
  return {
    partCount: np,
    numFrames: n,
    framerate: rate,
    partFrames,
    frameTimes,
    duration: n / rate,
    posFrames: null,
    segmentStarts: new Uint32Array([0]),
    segmentCounts: new Uint32Array([n]),
    segmentFramerates: new Float32Array([rate]),
    segmentAnimIds: new Uint32Array([anim.did >>> 0 || 0]),
    rootFrames: null,
    sourceFrames: order,
  };
}

function holdingEntry(table, key, name) {
  if (!table || typeof table !== "object") return null;
  let e = null;
  if (typeof table.get === "function") {
    e = table.get(key) ?? table.get(String(key)) ?? table.get(name) ?? null;
  } else {
    e = table[key] ?? table[name] ?? null;
  }
  return e && typeof e === "object" ? e : null;
}

const GRIP_FIELDS = Object.freeze(["ox", "oy", "oz", "qw", "qx", "qy", "qz"]);

// A plain copy of a holding entry: `{partId, ox, oy, oz, qw, qx, qy, qz}` (the
// fields present and finite). Also reads the recon `{partId, frame: {origin,
// orientation}}` shape, so the rig table's human Setup works as input.
function gripCopy(e) {
  const out = { partId: e.partId };
  for (const f of GRIP_FIELDS) if (Number.isFinite(e[f])) out[f] = e[f];
  const fr = e.frame;
  if (fr && typeof fr === "object") {
    const o = fr.origin;
    const q = fr.orientation;
    if (Array.isArray(o) && o.length === 3 && o.every(Number.isFinite) && !("ox" in out)) {
      out.ox = o[0]; out.oy = o[1]; out.oz = o[2];
    }
    if (Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && !("qw" in out)) {
      out.qw = q[0]; out.qx = q[1]; out.qy = q[2]; out.qz = q[3];
    }
  }
  return out;
}

/**
 * Classify a rig. Humanoid iff `partCount >= 17` and the holding table puts
 * RightHand (ParentLocation 1) on part 15 and LeftHand (2) on part 12; then
 * parts 15 / 12 / 16 and copies of the two grip entries. Anything else —
 * unknown, partial or malformed input included — is `no-hands` (Olthoi rigs
 * have no hand holding locations; an unknown setup is treated the same).
 *
 * @param {{partCount?: number, holdingLocations?: Map<number|string, {partId: number}>
 *   |Object<string, {partId: number}>}} [input] `holdingLocations` keyed by
 *   ParentLocation number (1, 2) or name ("RightHand", "LeftHand"); entries need
 *   only `partId`
 * @returns {{kind: 'humanoid'|'no-hands', rightHand: number, leftHand: number,
 *   head: number, rightGrip: object|null, leftGrip: object|null}} a fresh object
 */
export function rigProfile(input = {}) {
  const o = input && typeof input === "object" ? input : {};
  const partCount = o.partCount;
  const rh = holdingEntry(o.holdingLocations, LOC_RIGHT_HAND, "RightHand");
  const lh = holdingEntry(o.holdingLocations, LOC_LEFT_HAND, "LeftHand");
  if (
    typeof partCount === "number" && Number.isFinite(partCount) && partCount >= HUMANOID_RIG.minParts &&
    rh && rh.partId === HUMANOID_RIG.rightHand && lh && lh.partId === HUMANOID_RIG.leftHand
  ) {
    return {
      kind: "humanoid",
      rightHand: HUMANOID_RIG.rightHand,
      leftHand: HUMANOID_RIG.leftHand,
      head: HUMANOID_RIG.head,
      rightGrip: gripCopy(rh),
      leftGrip: gripCopy(lh),
    };
  }
  return { kind: "no-hands", rightHand: -1, leftHand: -1, head: -1, rightGrip: null, leftGrip: null };
}

// ---------------------------------------------------------------------------
// Page half
// ---------------------------------------------------------------------------

// Default log: §2.8's shape; warn once per distinct message, never console.error.
const _warned = new Set();
function defaultLog(entry) {
  if (!entry || entry.level !== "warn") return;
  const m = String(entry.message ?? "");
  if (_warned.has(m)) return;
  _warned.add(m);
  try {
    // eslint-disable-next-line no-console
    console.warn("[drone] " + m);
  } catch (_) { /* no console */ }
}

const hex8 = (n) => "0x" + ((n >>> 0).toString(16).toUpperCase().padStart(8, "0"));

// did → Promise<AnimLite|null>. Animations are DAT constants, so a loaded clip is
// kept for the page; a miss (rejection, missing export) is dropped so a later
// call can retry.
const _anims = new Map();

/**
 * Fetch a retail Animation through the wasm (`liveScene3d.wasmExports` —
 * `window.__hbWasm` has no `fetchAnimation`). Reads the `frames` getter ONCE (each
 * access copies the whole clip), `free()`s the AnimationJs in `finally`, and caches
 * the result per DID in a module-level Map (concurrent callers share one fetch).
 *
 * @param {{fetchAnimation?: (did: number) => Promise<object>}|null} wasm
 * @param {number} did Animation DID (0x03xxxxxx)
 * @returns {Promise<{did: number, numFrames: number, numParts: number, flags: number,
 *   frames: Float32Array}|null>} null on a rejection (a DAT miss), a missing export or
 *   a malformed result; never rejects
 */
export async function loadAnim(wasm, did) {
  const key = did >>> 0;
  const hit = _anims.get(key);
  if (hit) return hit;
  if (!wasm || typeof wasm.fetchAnimation !== "function") return null;
  const p = (async () => {
    let a = null;
    try {
      a = await wasm.fetchAnimation(key);
      if (!a || typeof a !== "object") return null;
      const frames = a.frames; // ONE read: the getter copies on every access
      if (!frames || typeof frames.length !== "number") return null;
      return {
        did: key,
        numFrames: a.numFrames >>> 0,
        numParts: a.numParts >>> 0,
        flags: (a.flags >>> 0) || 0,
        frames,
      };
    } catch (_) {
      return null;
    } finally {
      if (a && typeof a.free === "function") {
        try { a.free(); } catch (_) { /* already freed */ }
      }
    }
  })();
  _anims.set(key, p);
  const r = await p;
  if (!r && _anims.get(key) === p) _anims.delete(key);
  return r;
}

/**
 * The RightHand (1) and LeftHand (2) holding entries of a Setup, through the
 * client's cached table (`entityManager._resolveHoldingLocation`). Never calls wasm
 * `fetchSetupHoldingLocations` directly: its `takeLocations()` is a one-shot drain
 * whose entries must be freed, and the EntityManager already owns that.
 *
 * @param {{_resolveHoldingLocation?: (setupId: number, key: number) => Promise<object|null>}} entityManager
 * @param {number} setupId
 * @returns {Promise<Map<1|2, {partId: number, ox?: number, oy?: number, oz?: number,
 *   qw?: number, qx?: number, qy?: number, qz?: number}>>} a key whose lookup throws
 *   or resolves null is missing; never rejects
 */
export async function readHoldingLocations(entityManager, setupId) {
  const out = new Map();
  if (!entityManager || typeof entityManager._resolveHoldingLocation !== "function") return out;
  for (const key of [LOC_RIGHT_HAND, LOC_LEFT_HAND]) {
    try {
      const e = await entityManager._resolveHoldingLocation(setupId >>> 0, key);
      if (e && typeof e === "object") out.set(key, e);
    } catch (_) { /* that key is missing */ }
  }
  return out;
}

/**
 * Hide the pilot's wielded items locally for the whole cycle (a sword or shield
 * would cut through the drone and the tablet), through the film seam
 * `entityManager.setFilmHidden`. Exact code of SPEC §6.10. Never
 * `clearAllFilmHidden()` (film's own hides). Hidden items' pool lights and
 * particles keep drawing.
 *
 * @param {object} entityManager EntityManager (`entityMap`, `setFilmHidden`, `_filmHiddenGuids`)
 * @param {number} guid the pilot
 * @returns {{apply: () => number, restore: () => number, hidden: () => number[]}}
 *   `apply()` hides every attached child not yet hidden by us or by film and
 *   returns how many we hide; `restore()` un-hides exactly ours and returns the
 *   count; `hidden()` lists ours
 */
export function createWieldedHider(entityManager, guid) {
  const mine = new Set();
  return {
    apply() {                                   // deploy start, then 4 Hz (a newly wielded guid gets hidden too)
      const kids = entityManager?.entityMap?.get(guid >>> 0)?._attachedChildren;   // null until the first attach
      if (!kids || kids.size === 0) return mine.size;
      for (const c of kids) {
        const g = c >>> 0;
        if (mine.has(g)) continue;
        if (entityManager._filmHiddenGuids?.has(g)) continue;   // someone else's (film's) hide: not ours to restore
        entityManager.setFilmHidden(g, true);
        mine.add(g);
      }
      return mine.size;
    },
    restore() {                                 // EVERY exit path: stow end, abort, session change, dispose
      let n = 0;
      for (const g of mine) { try { entityManager.setFilmHidden(g, false); n += 1; } catch (_) {} }
      mine.clear();                             // setFilmHidden remembers absent guids; un-hiding them forgets them
      return n;
    },
    hidden() { return [...mine]; },
  };
}

/**
 * @typedef {object} GesturePoll
 * @property {boolean} active a job is running after this poll
 * @property {string|null} name the current job's clip name (also on its done poll)
 * @property {boolean} event true on exactly one poll per job
 * @property {boolean} done true on exactly one poll per job
 * @property {boolean} rigChanged the job ended because the rig instance changed
 */

/**
 * @typedef {object} GestureDriver
 * @property {() => Promise<{ok: boolean, profile: object|null, clips: {pack: boolean,
 *   place: boolean, goggles: boolean}}>} ready resolve the rig (memoised until rebind)
 * @property {() => object|null} profile the RigProfile once known (sync)
 * @property {(name: string, speed?: number) => {ok: boolean, mode: 'clip'|'timer'|null,
 *   name: string}} clip start a job, replacing any current one
 * @property {(dt: number) => GesturePoll} poll once per frame; reused object
 * @property {() => boolean} stop end the current job silently
 * @property {(cmd?: number, speed?: number) => Promise<void>} hold setMotion a held state
 * @property {() => Promise<void>} release back to Ready (not on a death-held rig)
 * @property {(nowSec: number) => boolean} watch held-motion watchdog
 * @property {(on: boolean) => number} hideWielded hide / restore the wielded items
 * @property {() => number} applyWielded re-apply the hide while hidden
 * @property {(inst?: object) => void} rebind the rig was rebuilt
 * @property {() => Promise<object>} clipParity debug frame check
 * @property {() => void} dispose
 */

/**
 * The gesture driver for one pilot (one per deploy cycle). Plays the three clips
 * through `entityManager.playLocalClip` and reports their events and ends through
 * `poll(dt)` (exactly once each per job; a job replaced by `clip()` or ended by
 * `stop()` never reports again); holds / releases ReadState with `setMotion` at
 * speed 1 (DV-12); watches the held motion; hides the wielded items. A clip that
 * cannot play (not built — part-count mismatch, DAT miss —, `clipMode() ===
 * 'timer'`, or the seam refused) runs as a TIMER job: no rig motion, the event
 * at `eventAtFrame/30/speed` s and the end at `frames/30/speed` s of polled dt.
 *
 * @param {{entityManager: object, guid: number, wasm?: object|null,
 *   clipMode?: () => 'clip'|'timer', log?: (entry: object) => void}} deps
 *   `entityManager` and `guid` (non-zero u32) are REQUIRED
 * @returns {GestureDriver}
 * @throws {TypeError} without `entityManager` or `guid`
 */
export function createGestureDriver(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const em = d.entityManager;
  if (!em || typeof em !== "object") throw new TypeError("[drone] createGestureDriver: deps.entityManager is required");
  if (typeof d.guid !== "number" || !Number.isFinite(d.guid) || (d.guid >>> 0) === 0) {
    throw new TypeError("[drone] createGestureDriver: deps.guid (non-zero u32) is required");
  }
  const guid = d.guid >>> 0;
  const wasm = d.wasm ?? null;
  const clipModeOf = typeof d.clipMode === "function" ? d.clipMode : null;
  const log = typeof d.log === "function" ? d.log : defaultLog;
  const hider = createWieldedHider(em, guid);

  let disposed = false;
  let readyP = null;
  let gen = 0;
  let profileVal = null;
  const built = { pack: null, place: null, goggles: null };
  let job = null;
  const out = { active: false, name: null, event: false, done: false, rigChanged: false };
  let heldCmd = null;
  let lastIssueSec = null; // watchdog clock: null = stamp on the next watch() (a hold just went out)
  let wieldedOn = false;

  const say = (level, message, extra) => {
    try { log({ event: "drone", level, message, ...(extra || {}) }); } catch (_) { /* a throwing log never breaks us */ }
  };
  const instNow = () => {
    try { return em.entityMap?.get?.(guid) ?? null; } catch (_) { return null; }
  };
  const modeNow = () => {
    let m = "clip";
    if (clipModeOf) { try { m = clipModeOf(); } catch (_) { m = "clip"; } }
    return m === "timer" ? "timer" : "clip";
  };
  const setupOf = (inst) => ((inst?.meta?.modelId ?? inst?.meta?.setupId ?? 0) >>> 0);
  const deathHeld = () => {
    try { return typeof em.isDeathHeld === "function" && em.isDeathHeld(guid) === true; } catch (_) { return false; }
  };
  const issue = async (cmd, speed) => {
    try { await em.setMotion(guid, cmd >>> 0, MOTION.NONCOMBAT, speed); } catch (_) { /* never rejects */ }
  };

  // Our clip off the playhead — only while OUR record still is the playhead
  // (never `rec.seq`: a freed wasm record throws on its getters).
  function stopOurClip() {
    const j = job;
    if (!j || j.mode !== "clip") return false;
    const inst = instNow();
    if (!inst || inst !== j.inst || inst._unifiedSeq !== j.rec) return false;
    try { return em.stopLocalClip(guid) === true; } catch (_) { return false; }
  }

  function ready() {
    if (readyP) return readyP;
    const myGen = gen;
    readyP = (async () => {
      const res = { ok: false, profile: null, clips: { pack: false, place: false, goggles: false } };
      try {
        const inst = instNow();
        if (!inst || disposed) return res;
        const sid = setupOf(inst);
        const holding = await readHoldingLocations(em, sid);
        // Rebound meanwhile (the rig was rebuilt): hand over to the re-resolution,
        // so whoever holds this promise (index.js latches `rig` from it) gets the
        // new rig's answer rather than a stale "no profile" (→ no-hands).
        if (disposed) return res;
        if (myGen !== gen) return ready();
        const parts = inst.parts?.length ?? 0;
        const prof = rigProfile({ partCount: parts, holdingLocations: holding });
        profileVal = prof;
        res.profile = prof;
        if (prof.kind === "humanoid") {
          const anims = await Promise.all(CLIP_NAMES.map((n) => loadAnim(wasm, GESTURE_CLIPS[n].anim)));
          if (disposed) return res;
          if (myGen !== gen) return ready();
          const rootMotion = [];
          for (let i = 0; i < CLIP_NAMES.length; i += 1) {
            const name = CLIP_NAMES[i];
            const a = anims[i];
            let desc = null;
            if (a && a.numParts === parts) {
              if ((a.flags & 1) !== 0) rootMotion.push(hex8(a.did));
              desc = buildClip(a, GESTURE_CLIPS[name].plan);
            }
            built[name] = desc;
            res.clips[name] = desc !== null;
          }
          if (rootMotion.length > 0) {
            say("warn", "gesture animation carries root motion (POS_FRAMES); the clip drops it", { anims: rootMotion });
          }
        }
        res.ok = true;
      } catch (e) {
        say("warn", "gestures.ready failed", { error: String(e?.message ?? e) });
      }
      return res;
    })();
    return readyP;
  }

  function clip(name, speed = 1) {
    const spec = typeof name === "string" && Object.prototype.hasOwnProperty.call(GESTURE_CLIPS, name)
      ? GESTURE_CLIPS[name] : null;
    if (!spec || disposed) return { ok: false, mode: null, name };
    stopOurClip(); // the current job is replaced: our clip leaves the playhead first
    job = null;
    const sp = +speed;
    const s = Number.isFinite(sp) && sp > 0 ? sp : 1;
    const inst = instNow();
    const desc = built[name];
    let rec = null;
    if (desc && inst && modeNow() !== "timer") {
      let ok = false;
      try { ok = em.playLocalClip(guid, desc, { speed: s }) === true; } catch (_) { ok = false; }
      if (ok) rec = inst._unifiedSeq ?? null;
    }
    job = {
      name,
      mode: rec ? "clip" : "timer",
      rec,
      inst,
      eventFrame: spec.eventAtFrame,
      eventSec: spec.eventAtFrame / GESTURE_FPS / s,
      endSec: spec.frames / GESTURE_FPS / s,
      elapsed: 0,
      eventFired: false,
      rigEnded: false,
    };
    return { ok: true, mode: job.mode, name };
  }

  function poll(dt) {
    const o = out;
    o.event = false;
    o.done = false;
    o.rigChanged = false;
    const j = job;
    if (!j || disposed) {
      o.active = false;
      o.name = null;
      return o;
    }
    o.active = true;
    o.name = j.name;
    j.elapsed += Number.isFinite(dt) && dt > 0 ? dt : 0;
    let ended = false;
    if (j.rigEnded) {
      ended = true;
      o.rigChanged = true;
    } else if (j.mode === "clip") {
      const inst = instNow();
      if (inst !== j.inst) {
        ended = true; // the rig was rebuilt or despawned under the clip
        o.rigChanged = true;
      } else if (inst._unifiedSeq !== j.rec) {
        ended = true; // finished (clearOnDone handed back) or cut (fizzle, death, ...)
      } else {
        let f = -1;
        try { f = j.rec.seq.globalFrameIndex; } catch (_) { f = -1; }
        if (!j.eventFired && f >= j.eventFrame) {
          j.eventFired = true;
          o.event = true;
        }
      }
    } else {
      if (!j.eventFired && j.elapsed + TIME_EPS >= j.eventSec) {
        j.eventFired = true;
        o.event = true;
      }
      if (j.elapsed + TIME_EPS >= j.endSec) ended = true;
    }
    if (ended) {
      if (!j.eventFired) { // a job that ends before its event fires it on its done poll
        j.eventFired = true;
        o.event = true;
      }
      o.done = true;
      o.active = false;
      job = null;
    }
    return o;
  }

  function stop() {
    const freed = stopOurClip();
    job = null; // discarded silently: no event / done afterwards
    return freed;
  }

  function hold(cmd = MOTION.READ_STATE, speed = 1) {
    if (disposed) return Promise.resolve();
    heldCmd = cmd >>> 0;
    lastIssueSec = null;
    const sp = +speed;
    return issue(heldCmd, Number.isFinite(sp) && sp > 0 ? sp : 1);
  }

  function release() {
    heldCmd = null;
    lastIssueSec = null;
    if (disposed) return Promise.resolve();
    // Ready passes CQ-06 and would free a death hold: the local corpse would stand up.
    if (deathHeld()) return Promise.resolve();
    return issue(MOTION.READY, 1.0);
  }

  function watch(nowSec) {
    if (disposed || heldCmd === null) return false;
    const now = +nowSec;
    if (!Number.isFinite(now)) return false;
    if (lastIssueSec === null) { // first watch after a hold(): start the 1 s clock
      lastIssueSec = now;
      return false;
    }
    if (now - lastIssueSec < WATCH_INTERVAL_SEC) return false;
    const inst = instNow();
    if (!inst) return false;
    if (((inst.lastMotionCommand ?? 0) >>> 0) === heldCmd) return false;
    if (deathHeld()) return false;
    lastIssueSec = now;
    void issue(heldCmd, 1);
    return true;
  }

  function hideWielded(on) {
    if (on) {
      if (disposed) return 0;
      wieldedOn = true;
      try { return hider.apply(); } catch (_) { return hider.hidden().length; }
    }
    wieldedOn = false;
    try { return hider.restore(); } catch (_) { return 0; }
  }

  function applyWielded() {
    if (!wieldedOn || disposed) return 0;
    try { return hider.apply(); } catch (_) { return 0; }
  }

  function rebind(_inst) {
    if (job) {
      stopOurClip(); // only acts if our record is somehow still the live playhead
      job.rigEnded = true; // reported as done + rigChanged on the next poll
    }
    readyP = null;
    gen += 1;
  }

  async function clipParity() {
    const res = { ok: false, setupId: hex8(0), clips: {} };
    try {
      const inst = instNow();
      res.setupId = hex8(setupOf(inst));
      const parts = inst?.parts?.length ?? null;
      for (const name of CLIP_NAMES) {
        const spec = GESTURE_CLIPS[name];
        const a = await loadAnim(wasm, spec.anim);
        const row = { built: false, flags: a ? a.flags : null, maxPosErr: null, maxQuatErr: null };
        const desc = a ? buildClip(a, spec.plan) : null;
        if (desc) {
          const stride = desc.partCount * FLOATS_PER_PART;
          let pe = 0;
          let qe = 0;
          for (let k = 0; k < desc.numFrames; k += 1) {
            const sb = desc.sourceFrames[k] * stride;
            const cb = k * stride;
            for (let i = 0; i < stride; i += 1) {
              const err = Math.abs(desc.partFrames[cb + i] - Math.fround(+a.frames[sb + i]));
              if (i % FLOATS_PER_PART < 3) pe = Math.max(pe, err);
              else qe = Math.max(qe, err);
            }
          }
          row.built = parts === null || a.numParts === parts;
          row.maxPosErr = Number.isFinite(pe) ? +pe.toFixed(6) : null;
          row.maxQuatErr = Number.isFinite(qe) ? +qe.toFixed(6) : null;
        }
        res.clips[name] = row;
      }
      res.ok = true;
    } catch (e) {
      say("warn", "gestures.clipParity failed", { error: String(e?.message ?? e) });
    }
    return res;
  }

  function dispose() {
    if (disposed) return;
    stop();
    // A local clip still on the pilot's playhead can only be ours (only drone
    // code plays local clips; one driver per pilot).
    const inst = instNow();
    if (inst?._unifiedSeq?.localClip === true) {
      try { em.stopLocalClip(guid); } catch (_) { /* gone */ }
    }
    hideWielded(false);
    heldCmd = null;
    lastIssueSec = null;
    disposed = true;
    readyP = null;
    job = null;
  }

  return {
    ready,
    profile: () => profileVal,
    clip,
    poll,
    stop,
    hold,
    release,
    watch,
    hideWielded,
    applyWielded,
    rebind,
    clipParity,
    dispose,
  };
}
