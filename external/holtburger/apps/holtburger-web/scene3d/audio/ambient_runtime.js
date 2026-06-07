// Task D (ambient-sounds-chain, 2026-05-12) — AmbientRuntime.
//
// Per-rAF roller that walks the PhatSDK
// `Region → terrain_info → SceneType → SoundDesc → SoundTable → Wave`
// chain at the player's current position and emits per-tick ambient
// audio plays via `AudioManager.play(waveDid, listenerPos, opts)`.
//
// The chain (see `docs/ambient-sounds-chain-2026-05-12.md` for the
// concrete byte-level reference):
//
//   1. Sample the local player's `(landblockId, lbLocalX, lbLocalY)`.
//   2. Read the per-LB `terrainCodes` Uint8Array (column-major, 81
//      entries) stashed on `lbMesh.userData` by `terrain.js`.
//   3. Index into the closest 24m vertex to get a `code` (0..31).
//   4. Walk `region.ambientStbForTerrainCode(code, 0)` (Rust-side
//      chain — `terrain_types[code].scene_types[0]` →
//      `scene_info.scene_types[scene_idx].stb_index` →
//      `sound_info.stb_descs[stb_index]`). Returns an `AmbientStbJs`
//      with `stbId` + `ambientSounds()`.
//   5. For each `AmbientSoundDesc`:
//      - `isContinuous` (`baseChance == 0.0`) → start once on STB
//        activation; loop until the active STB changes.
//      - Else → maintain a per-entry timer in `[minRate, maxRate]`
//        seconds. On expire, roll `rng() < baseChance` and on success
//        play one-shot, then reset the timer.
//   6. To resolve a play, call
//      `soundTableCache.resolveSound(stb.stbId, sound.sType)` → get
//      `{waveDid, volume, ...}`, then `audioManager.play(waveDid, pos,
//      { gain: sound.volume * resolved.volume, loop: isContinuous })`.
//
// Indoor behaviour: when `isCurrentCellIndoor()` returns true, we
// **stop all continuous loops** and **freeze probabilistic timers**
// (decrement skipped per tick). When we transition back outside, the
// next tick resumes timers and re-starts the continuous loops on the
// active STB. Rationale: AC's indoor EnvCells have their own ambient
// path (not yet wired); bleeding the Region's outdoor wind/forest
// into a dungeon would be wrong and immersion-breaking.
//
// STB-change behaviour: when the player walks across a terrain
// boundary (Grassland → LushGrass), the active STB id may change.
// We track `_activeStbId`; on change we stop the current continuous
// loops, clear timers, and re-prime against the new STB. New
// continuous loops start on the next tick.
//
// **Style models read**: `audio_manager.js` (H3-D constructor + opts
// validation), `sound_table_cache.js` (Task C — same directory,
// concurrency model + `stats()` shape), `sky_dome.js` (Sky-J P5 —
// per-tick chain walker that resolves DAT-driven data through
// fetchX → addEmitter).

import { acToThree } from "../adapter.js";

// ----- Constants ---------------------------------------------------

// Per-LB mesh layout (mirrors `terrain.js`).
const VERTEX_GRID = 9;           // 9×9 vertices per landblock
const VERTEX_SPACING_M = 24.0;   // 192 m / 8 cells = 24 m per vertex spacing
const METERS_PER_LANDBLOCK = 192.0;

// PannerNode tuning for non-positional ambient. Per the chain doc:
// "non-positional sounds (town-wide hum), playback is at the
// listener position (no PannerNode attenuation)". We achieve this by
// playing AT the listener position with a large refDistance so the
// attenuation curve stays at unity gain. AudioManager handles HRTF
// panning; co-locating with the listener means the sound is heard
// "around" them, not from a single direction.
const AMBIENT_REF_DISTANCE = 200.0;   // far enough that 0 m → 1.0 gain
const AMBIENT_ROLLOFF_FACTOR = 0.0;   // no falloff for the ambient layer
const AMBIENT_MAX_DISTANCE = 500.0;

/**
 * @typedef {object} PlayerPos
 * @property {number} x          AC world X (metres).
 * @property {number} y          AC world Y (metres).
 * @property {number} z          AC world Z (metres).
 * @property {number} [landblockId]  Optional explicit LB id (XXYYFFFF).
 *                              When omitted, derived from x/y.
 */

/**
 * @typedef {object} ContinuousLoopHandle
 * @property {number} stbId       The STB that started this loop.
 * @property {number} sType       The Sound enum (e.g. 0x46 Ambient1).
 * @property {{source: AudioBufferSourceNode, panner: PannerNode,
 *             gain: GainNode}|null} audioHandle  Returned by
 *                              `audioManager.play` (null if play()
 *                              hadn't started yet — the resolver is
 *                              async).
 */

/**
 * @typedef {object} ProbTimerEntry
 * @property {number} sType       Sound enum.
 * @property {number} volume      Per-row volume multiplier (0..1).
 * @property {number} baseChance  Probability per fire (0..1).
 * @property {number} minRate     Lower bound of timer window (s).
 * @property {number} maxRate     Upper bound of timer window (s).
 * @property {number} remainingS  Seconds remaining until next roll.
 */

export class AmbientRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.soundTableCache     Task C `SoundTableCache`.
   * @param {object} opts.audioManager        H3-D `AudioManager`.
   * @param {() => (PlayerPos|null)} opts.getPlayerPos
   *        Resolver — called per tick. Return `null` when no player
   *        is known yet (pre-spawn). Runtime no-ops until non-null.
   * @param {() => Promise<any|null> | any | null} opts.getRegion
   *        Resolver — called once per tick (cheap; returns `null`
   *        until the Region has fetched). Either a sync getter that
   *        returns the cached `RegionJs` once it's available, or an
   *        async function — the runtime awaits the latter once.
   * @param {() => boolean} [opts.isCurrentCellIndoor]
   *        Indoor predicate. When true, continuous loops are stopped
   *        and probabilistic timers freeze. Defaults to `() => false`
   *        (always outdoor) if unset.
   * @param {() => boolean} [opts.isCurrentCellSeenOutside]
   *        Phase 4 (2026-06-04) — ENVCELL_FLAG_SEEN_OUTSIDE (0x01)
   *        predicate. When true in an indoor cell, the indoor gate is
   *        relaxed so the region's outdoor ambient keeps running
   *        (retail acclient.c:146721/146746). Defaults to `() => false`.
   * @param {() => Array<{userData: {lbX: number, lbY: number,
   *           terrainCodes: Uint8Array}}>|Array} [opts.getTerrainMeshes]
   *        Returns the array of terrain Mesh objects, each whose
   *        `userData.terrainCodes` Uint8Array is the per-vertex
   *        terrain code grid. Defaults to reading
   *        `liveScene3d.terrainGroup.children` if not provided.
   * @param {() => number} [opts.rng]
   *        Random source returning a float in [0, 1). Defaults to
   *        `Math.random`. Tests inject a deterministic stub.
   * @param {number} [opts.scenePick=0]
   *        Index into `terrain_types[code].scene_types` — the doc
   *        plan endorses 0 universally as a Task D simplification
   *        (the PhatSDK `CTerrainDesc::GetScene` position-hash isn't
   *        decompiled).
   * @param {(record: object) => void} [opts.pushEventRecord]
   *        Phase F.C runtime event log probe. Called with one record
   *        per `audioManager.play` fire (continuous + probabilistic).
   *        No-op stub when `?eventLog=on` is absent. Records carry
   *        `{type:"sound", source:"AmbientRuntime", source_meta:
   *        {terrain_code, stb_index, s_type, continuous}, wave_did,
   *        world_pos, t_wall_ms, ...}` — see
   *        `docs/event-completeness-method.md` for the schema.
   * @param {() => number} [opts.clock]
   *        F.D-fu2 (2026-05-20) — wall-clock source returning ms.
   *        Defaults to `performance.now`. Each tick the runtime
   *        derives its OWN dt from the clock delta, ignoring the
   *        `dt` arg passed into `tick(dt)`. Rationale: the rAF
   *        dt-recovery armor in `scene3d/index.js::tick` (clamps dt
   *        to 0 after a >500ms gap to prevent animation snap) was
   *        also zeroing ambient timer decrements under headless
   *        software-GL, where swiftshader's per-frame cost regularly
   *        exceeds the recovery threshold. Ambient sounds are a
   *        wall-clock cadence (per ACE's STB semantics, sound timers
   *        keep ticking even when the renderer is paused), so
   *        decoupling from the renderer's dt is the correct model.
   *        Tests inject a deterministic stub here (advance the clock
   *        between asserts to fire timers on demand).
   */
  constructor(opts) {
    if (!opts || !opts.soundTableCache || !opts.audioManager) {
      throw new Error(
        "AmbientRuntime: opts.soundTableCache + opts.audioManager required"
      );
    }
    if (typeof opts.getPlayerPos !== "function") {
      throw new Error("AmbientRuntime: opts.getPlayerPos function required");
    }
    if (typeof opts.getRegion !== "function") {
      throw new Error("AmbientRuntime: opts.getRegion function required");
    }
    this._soundTableCache = opts.soundTableCache;
    this._audioManager = opts.audioManager;
    this._getPlayerPos = opts.getPlayerPos;
    this._getRegion = opts.getRegion;
    this._isCurrentCellIndoor =
      typeof opts.isCurrentCellIndoor === "function"
        ? opts.isCurrentCellIndoor
        : () => false;
    // Phase 4 (2026-06-04) — ENVCELL_FLAG_SEEN_OUTSIDE (0x01) provider.
    // Retail feeds outdoor ambient into a cell when it is an outdoor
    // cell OR carries the seen_outside flag (acclient.c:146721/146746),
    // so a portal/window cell keeps the region's outdoor ambient alive.
    // Defaults to `() => false` (never seen-outside) if unset.
    this._isCurrentCellSeenOutside =
      typeof opts.isCurrentCellSeenOutside === "function"
        ? opts.isCurrentCellSeenOutside
        : () => false;
    this._getTerrainMeshes =
      typeof opts.getTerrainMeshes === "function"
        ? opts.getTerrainMeshes
        : null;
    this._rng = typeof opts.rng === "function" ? opts.rng : Math.random;
    this._scenePick = Number.isFinite(opts.scenePick) ? opts.scenePick | 0 : 0;
    // Phase F.C — runtime event log probe (no-op when disabled).
    this._pushEventRecord =
      typeof opts.pushEventRecord === "function"
        ? opts.pushEventRecord
        : (_record) => {};
    // F.D-fu2 (2026-05-20) — wall-clock source (ms). Default to
    // performance.now; tests inject a stub that returns a manually-
    // advanced number. See `setClockForTest` for the swap path.
    this._clock =
      typeof opts.clock === "function"
        ? opts.clock
        : (typeof performance !== "undefined"
            ? () => performance.now()
            : () => Date.now());
    // Last clock reading. Lazily initialised on the first tick so
    // the first sample doesn't see a phantom dt from runtime
    // construction → first-tick wall-clock gap (boot path can take
    // 100+ s on swiftshader; we don't want that to count as a single
    // 100-s ambient step on tick #1).
    this._lastClockMs = null;

    // Resolver state.
    this._region = null;
    this._regionPending = null;
    this._regionRequested = false;

    // Active STB state.
    /** @type {number|null} */ this._activeStbId = null;
    /** @type {number} */ this._activeTerrainCode = -1;
    /** @type {number} */ this._activeSceneIndex = -1;

    // Continuous loops keyed by `sType` (one loop per Sound enum per
    // active STB). Resetting clears all entries.
    /** @type {Map<number, ContinuousLoopHandle>} */
    this._continuousLoops = new Map();

    // Probabilistic timers keyed by `sType`.
    /** @type {Map<number, ProbTimerEntry>} */
    this._probTimers = new Map();

    // Diagnostics.
    this.tickCount = 0;
    this.continuousStartCount = 0;
    this.probabilisticFireCount = 0;
    this.skippedNoRegion = 0;
    this.skippedNoPlayer = 0;
    this.skippedIndoor = 0;
    this.terrainSampleMisses = 0;
    this.lastError = null;
    this._lastIndoor = false;
  }

  /**
   * Called once per rAF (or once per any monotonic time step).
   *
   * F.D-fu2 (2026-05-20): the `dt` argument is now ADVISORY ONLY —
   * the runtime computes its own dt from `this._clock()` deltas, so
   * the rAF dt-recovery armor in `scene3d/index.js::tick` (which
   * clamps dt to 0 after long gaps to prevent animation snap) does
   * not zero ambient timer decrements under headless software-GL.
   * Ambient sounds model wall-clock cadence, so they MUST keep
   * decrementing in real-world ms even when the renderer's per-frame
   * dt is artificially clamped. Tests can drive deterministic
   * behaviour by injecting a stub `opts.clock` and calling
   * `tick(0)` between manual clock advances.
   *
   * Idempotent on a zero clock delta (just bumps `tickCount` so
   * capture scripts can verify the runtime is being driven).
   *
   * Bails when:
   * - No region yet → `skippedNoRegion++`.
   * - No player yet → `skippedNoPlayer++`.
   * - `isCurrentCellIndoor() == true` → `skippedIndoor++`, stops
   *   continuous loops + freezes timers.
   *
   * @param {number} _dt  (advisory; ignored — see comment above)
   */
  tick(_dt) {
    this.tickCount += 1;
    // F.D-fu2: derive dt from the clock source so renderer-side
    // dt-recovery doesn't zero ambient progress.
    const nowMs = +this._clock();
    let dt;
    if (this._lastClockMs === null) {
      // First tick — establish the baseline; no progress this tick.
      this._lastClockMs = nowMs;
      dt = 0;
    } else {
      const deltaMs = nowMs - this._lastClockMs;
      this._lastClockMs = nowMs;
      // Cap dt at 1s to avoid a single huge step on first-tick-after-
      // boot from firing every timer simultaneously. ACE's STB sound
      // descriptors' min_rate is typically ~1s, so a 1s cap is the
      // largest single-step advance that won't pop multiple sounds
      // at once from one row.
      dt = Math.max(0, Math.min(deltaMs * 0.001, 1.0));
    }
    if (!Number.isFinite(dt)) dt = 0;
    if (dt < 0) dt = 0;

    // Resolve the Region lazily on first tick (or whenever
    // `_getRegion` finally returns non-null). The lazy fetch is to
    // accommodate the boot path where init3D constructs AmbientRuntime
    // BEFORE `populateSkyDescFromRegion` lands; the user supplies a
    // resolver that returns null until the Region is parsed.
    if (!this._region) {
      this._tryResolveRegion();
      if (!this._region) {
        this.skippedNoRegion += 1;
        return;
      }
    }

    // Indoor short-circuit. We still call `getPlayerPos` so capture
    // scripts can verify the indoor flag fires before the player-pos
    // lookup; tearing down continuous loops + freezing timers happens
    // here too so the user doesn't hear sky-wind through a dungeon
    // wall.
    const indoor = !!this._isCurrentCellIndoor();
    // Phase 4 (2026-06-04) — ENVCELL_FLAG_SEEN_OUTSIDE (0x01) relaxes
    // the indoor gate: retail feeds outdoor ambient into a cell when it
    // is an outdoor cell OR carries seen_outside, so a portal/window
    // cell keeps the region's outdoor ambient alive instead of tearing
    // down its loops (acclient.c:146721/146746). Only treat the cell as
    // "indoor for ambient purposes" when indoor AND NOT seen_outside.
    const seenOutside = !!this._isCurrentCellSeenOutside?.();
    const ambientIndoor = indoor && !seenOutside;
    if (ambientIndoor) {
      if (!this._lastIndoor) {
        // Transition outdoor → indoor: stop continuous loops + clear
        // the active-STB state so the next outdoor tick re-primes.
        this._stopAllContinuousLoops();
        this._activeStbId = null;
        this._activeTerrainCode = -1;
        this._activeSceneIndex = -1;
      }
      this._lastIndoor = true;
      this.skippedIndoor += 1;
      return;
    }
    this._lastIndoor = false;

    const player = this._getPlayerPos();
    if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) {
      this.skippedNoPlayer += 1;
      return;
    }

    // Sample the terrain code at the player's LB-local position.
    const code = this._sampleTerrainCodeAt(player);
    if (code < 0) {
      this.terrainSampleMisses += 1;
      // Don't clear loops on a transient sample miss — the player
      // may just be on the edge of a freshly-loaded LB. The next
      // tick gets another shot.
      return;
    }

    // Walk the chain. Returns AmbientStbJs | null/undefined.
    let stb = null;
    try {
      stb = this._region.ambientStbForTerrainCode(code, this._scenePick);
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn("[task-d/ambient] ambientStbForTerrainCode threw:", e);
      return;
    }

    if (!stb) {
      // No ambient for this terrain (`stb_index == -1` or the chain
      // returned no STB). Stop any active continuous loops and clear
      // the active state; probabilistic timers also drain.
      if (this._activeStbId !== null) {
        this._stopAllContinuousLoops();
        this._activeStbId = null;
        this._activeTerrainCode = code;
        this._activeSceneIndex = -1;
      }
      return;
    }

    const newStbId = stb.stbId >>> 0;
    let stbChanged = false;
    if (this._activeStbId !== newStbId) {
      // STB transition: tear down everything from the previous STB
      // and prime against the new one. Continuous loops are restarted
      // on this same tick below; probabilistic timers re-seed.
      this._stopAllContinuousLoops();
      this._probTimers.clear();
      this._activeStbId = newStbId;
      stbChanged = true;
    }
    this._activeTerrainCode = code;

    // Walk the ambient sounds for the active STB.
    const sounds = stb.ambientSounds();
    for (let i = 0; i < sounds.length; i += 1) {
      const s = sounds[i];
      const sType = s.sType >>> 0;
      const baseChance = +s.baseChance;
      const volume = +s.volume;
      const minRate = +s.minRate;
      const maxRate = +s.maxRate;
      const isContinuous = !!s.isContinuous;

      if (isContinuous) {
        // Start the loop on first activation. The Promise from play()
        // resolves once the source has STARTED — we stash the handle
        // for stop() but don't block.
        if (!this._continuousLoops.has(sType)) {
          this._startContinuousLoop(newStbId, sType, volume, player);
        }
      } else {
        // Seed timer on first sight of this entry under the active
        // STB; tick down on subsequent visits.
        let entry = this._probTimers.get(sType);
        if (!entry || stbChanged) {
          const remainingS = this._sampleRate(minRate, maxRate);
          entry = {
            sType,
            volume,
            baseChance,
            minRate,
            maxRate,
            remainingS,
          };
          this._probTimers.set(sType, entry);
        }
        entry.remainingS -= dt;
        if (entry.remainingS <= 0) {
          // Roll the dice. On success → one-shot play.
          const roll = this._rng();
          if (roll < entry.baseChance) {
            this._fireProbabilistic(newStbId, entry, player);
          }
          entry.remainingS = this._sampleRate(entry.minRate, entry.maxRate);
        }
      }
    }

    // Free wasm-bindgen handle for the AmbientStbJs returned this tick.
    // The AmbientSoundDescJs entries (returned by .ambientSounds())
    // are `Copy` Rust structs — no `.free()` needed.
    if (stb && typeof stb.free === "function") {
      try { stb.free(); } catch (_) {}
    }
  }

  /**
   * Stop all continuous loops + reset all probabilistic timer state.
   * Call on landblock change or explicit cleanup (renderer switch).
   * Diagnostics counters preserved.
   */
  reset() {
    this._stopAllContinuousLoops();
    this._probTimers.clear();
    this._activeStbId = null;
    this._activeTerrainCode = -1;
    this._activeSceneIndex = -1;
    this._lastIndoor = false;
  }

  /**
   * F.D-fu2 (2026-05-20) — test hook. Inject a clock function and
   * reset the baseline so the next `tick()` recomputes from the
   * new source. Useful for unit tests + validator-driven scenarios
   * that need to advance time deterministically. Returns the prior
   * clock for restoration.
   *
   * @param {() => number} clockFn  Returns wall-clock ms.
   * @returns {() => number}        The previous clock function.
   */
  setClockForTest(clockFn) {
    if (typeof clockFn !== "function") {
      throw new Error("setClockForTest: clockFn must be a function");
    }
    const prior = this._clock;
    this._clock = clockFn;
    // Reset the baseline so the first tick under the new clock
    // doesn't see a phantom delta from the prior source.
    this._lastClockMs = null;
    return prior;
  }

  /**
   * Diagnostic snapshot — read by capture scripts to verify state
   * without poking the internal maps. All plain scalars + arrays —
   * safe to JSON.stringify.
   *
   * @returns {{
   *   tickCount: number,
   *   activeStbId: number|null,
   *   terrainCode: number,
   *   sceneIndex: number,
   *   sceneTypeCount: number,
   *   continuousLoops: Array<{sType: number, started: boolean}>,
   *   timers: Array<{sType: number, remainingS: number,
   *                  baseChance: number, minRate: number, maxRate: number}>,
   *   continuousStartCount: number,
   *   probabilisticFireCount: number,
   *   skippedNoRegion: number,
   *   skippedNoPlayer: number,
   *   skippedIndoor: number,
   *   terrainSampleMisses: number,
   *   lastError: string|null,
   * }}
   */
  stats() {
    const continuousLoops = [];
    for (const [sType, h] of this._continuousLoops.entries()) {
      continuousLoops.push({
        sType,
        started: !!h.audioHandle,
      });
    }
    const timers = [];
    for (const [sType, e] of this._probTimers.entries()) {
      timers.push({
        sType,
        remainingS: +e.remainingS.toFixed(3),
        baseChance: e.baseChance,
        minRate: e.minRate,
        maxRate: e.maxRate,
      });
    }
    let sceneTypeCount = 0;
    if (this._region && this._activeTerrainCode >= 0) {
      try {
        sceneTypeCount = this._region.sceneTypeCountForTerrain(
          this._activeTerrainCode
        );
      } catch (_) {
        sceneTypeCount = 0;
      }
    }
    return {
      tickCount: this.tickCount,
      activeStbId: this._activeStbId,
      terrainCode: this._activeTerrainCode,
      sceneIndex: this._activeSceneIndex,
      sceneTypeCount,
      continuousLoops,
      timers,
      continuousStartCount: this.continuousStartCount,
      probabilisticFireCount: this.probabilisticFireCount,
      skippedNoRegion: this.skippedNoRegion,
      skippedNoPlayer: this.skippedNoPlayer,
      skippedIndoor: this.skippedIndoor,
      terrainSampleMisses: this.terrainSampleMisses,
      lastError: this.lastError,
    };
  }

  // ===================================================================
  // Internal helpers
  // ===================================================================

  /**
   * Lazy-resolve the Region. `_getRegion` may return:
   * - a `RegionJs` directly (sync) → install.
   * - a Promise → await once, then install on the next tick.
   * - `null` → keep waiting; next tick re-tries.
   */
  _tryResolveRegion() {
    if (this._regionRequested) {
      // Pending — bail; next tick polls again.
      return;
    }
    let regionOrPromise;
    try {
      regionOrPromise = this._getRegion();
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      return;
    }
    if (!regionOrPromise) return;
    if (typeof regionOrPromise.then === "function") {
      this._regionRequested = true;
      regionOrPromise
        .then((r) => {
          if (r) this._region = r;
        })
        .catch((e) => {
          this.lastError = String(e?.message ?? e);
          // eslint-disable-next-line no-console
          console.warn("[task-d/ambient] getRegion promise rejected:", e);
        })
        .finally(() => {
          this._regionRequested = false;
        });
    } else {
      this._region = regionOrPromise;
    }
  }

  /**
   * Sample the per-vertex terrain code grid at the player's
   * LB-local position. Returns -1 when:
   * - No terrain mesh covers this LB (player walked off the loaded
   *   ring before dynamic LB loading lands for 3D).
   * - The mesh exists but `userData.terrainCodes` is missing (older
   *   build of `terrain.js` predating Task D).
   *
   * Simplification: snaps to the NEAREST 24m vertex (not bilinear
   * interp). Terrain types are 2D footprints — sub-vertex
   * interpolation would mix codes, which doesn't have a meaningful
   * "average" anyway. Documented in the doc plan as the explicit
   * design choice for Task D.
   */
  _sampleTerrainCodeAt(player) {
    const meshes = this._listTerrainMeshes();
    if (!meshes || meshes.length === 0) return -1;

    // Derive the player's LB from world (x, y). Each LB is 192 m;
    // (lbX = floor(x/192), lbY = floor(y/192)). Mirrors the wasm
    // landblock decode: id = (lbX << 24) | (lbY << 16) | 0xFFFF.
    const lbX = Math.floor(player.x / METERS_PER_LANDBLOCK);
    const lbY = Math.floor(player.y / METERS_PER_LANDBLOCK);

    let mesh = null;
    for (let i = 0; i < meshes.length; i += 1) {
      const m = meshes[i];
      if (!m || !m.userData) continue;
      if (m.userData.lbX === lbX && m.userData.lbY === lbY) {
        mesh = m;
        break;
      }
    }
    if (!mesh || !mesh.userData) return -1;
    const codes = mesh.userData.terrainCodes;
    if (!codes || codes.length < VERTEX_GRID * VERTEX_GRID) return -1;

    // LB-local x/y in metres [0, 192). The vertex grid is 9×9; vertex
    // (col, row) sits at world (lbX*192 + col*24, lbY*192 + row*24).
    // Snap to the nearest vertex by rounding (clamp to [0, 8]).
    const localX = player.x - lbX * METERS_PER_LANDBLOCK;
    const localY = player.y - lbY * METERS_PER_LANDBLOCK;
    let col = Math.round(localX / VERTEX_SPACING_M);
    let row = Math.round(localY / VERTEX_SPACING_M);
    if (col < 0) col = 0;
    if (col > VERTEX_GRID - 1) col = VERTEX_GRID - 1;
    if (row < 0) row = 0;
    if (row > VERTEX_GRID - 1) row = VERTEX_GRID - 1;
    // Column-major: `terrainCodes[col * 9 + row]`. Verified vs
    // `adapter.js::buildVertexTypesDataTexture` (line 248-250).
    return codes[col * VERTEX_GRID + row] | 0;
  }

  /**
   * Read the terrain meshes from the configured source. Defaults to
   * `liveScene3d.terrainGroup.children`; tests inject their own list.
   */
  _listTerrainMeshes() {
    if (this._getTerrainMeshes) {
      try {
        return this._getTerrainMeshes();
      } catch (_) {
        return null;
      }
    }
    // Default: walk the global scene3d's terrainGroup.children.
    // eslint-disable-next-line no-undef
    const ls = typeof window !== "undefined" ? window.liveScene3d : null;
    if (ls && ls.terrainGroup && Array.isArray(ls.terrainGroup.children)) {
      return ls.terrainGroup.children;
    }
    return null;
  }

  /**
   * Sample a random rate-window seconds in `[minRate, maxRate]`.
   * Guards against bogus wire data where `min > max` (treat as
   * `max = min`) and `min == max == 0` (degenerate; clamp to 0.1s
   * so we don't spin a 0-second timer that fires every tick).
   */
  _sampleRate(minRate, maxRate) {
    let lo = +minRate;
    let hi = +maxRate;
    if (!Number.isFinite(lo) || lo < 0) lo = 0;
    if (!Number.isFinite(hi) || hi < lo) hi = lo;
    const span = hi - lo;
    let rate = lo + this._rng() * span;
    if (rate < 0.1) rate = 0.1;
    return rate;
  }

  /**
   * Start a continuous loop for `sType` under `stbId`. Async (the
   * SoundTable + Wave fetch are both Promise-based) but
   * fire-and-forget — the runtime returns immediately and the loop
   * lights up once both resolve. If the resolve fails, the loop
   * silently doesn't start; the runtime's `_continuousLoops` entry
   * keeps `audioHandle === null` so a subsequent tick won't retry
   * (matches PhatSDK's `play_count` once-only semantics).
   */
  _startContinuousLoop(stbId, sType, ambientVolume, listenerPos) {
    // Reserve the slot eagerly so a second tick (before the resolve
    // lands) doesn't double-fire.
    const handle = { stbId, sType, audioHandle: null };
    this._continuousLoops.set(sType, handle);
    this.continuousStartCount += 1;

    const resolveAndPlay = async () => {
      const resolved = await this._soundTableCache.resolveSound(stbId, sType);
      if (!resolved) {
        // No mapping — silently leave the slot empty so we don't
        // retry every tick.
        return;
      }
      // #31 (2026-06-07) — the loop may have been stopped (and a NEW
      // loop for the same sType — even under the SAME stbId, e.g. an
      // indoor↔outdoor toggle re-priming the active STB) installed
      // under us while resolving. Guard on the HANDLE IDENTITY, not
      // stbId: only proceed if the map slot still holds OUR handle.
      const stillActive = this._continuousLoops.get(sType);
      if (stillActive !== handle) return;
      // Play at the listener position so HRTF panning lands
      // centred — non-positional "town-wide hum" per the doc plan.
      const gain = clamp01(ambientVolume * resolved.volume);
      // Phase F.C — emit event log record BEFORE play() so the
      // record always lands even if play() rejects. Source-meta
      // carries the terrain code + STB id + Sound enum + continuous
      // flag — enough for F.D's validator to time-correlate
      // against the F.B-baked ambient manifest.
      this._pushEventRecord({
        type: "sound",
        wave_did: resolved.waveDid >>> 0,
        parent_entity_guid: null,
        world_pos: [+listenerPos.x, +listenerPos.y, +listenerPos.z],
        t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
        source: "AmbientRuntime",
        source_meta: {
          terrain_code: this._activeTerrainCode | 0,
          stb_id: stbId >>> 0,
          s_type: sType >>> 0,
          continuous: true,
          gain,
        },
      });
      // #15 (2026-06-07) — the AudioListener is anchored at the active
      // camera in three.js world coords (index.js setListener), so the
      // PannerNode position must be in the SAME frame. listenerPos here
      // is AC (Z-up, +Y north); transform it before play() or HRTF
      // panning + the play()-side distance cull both see a frame
      // mismatch (one-shots silently culled, loops mis-panned). The
      // event-log world_pos above intentionally stays AC-frame.
      const [px, py, pz] = acToThree(
        +listenerPos.x,
        +listenerPos.y,
        +listenerPos.z
      );
      const audio = await this._audioManager.play(
        resolved.waveDid >>> 0,
        { x: px, y: py, z: pz },
        {
          // Phase 3 (2026-06-04) — route through the ambient category
          // bus so the ambient_sound_volume slider premultiplies before
          // the dB curve (retail acclient.c:383092-383095, @45630).
          category: "ambient",
          loop: true,
          gain,
          refDistance: AMBIENT_REF_DISTANCE,
          rolloffFactor: AMBIENT_ROLLOFF_FACTOR,
          maxDistance: AMBIENT_MAX_DISTANCE,
        }
      );
      // Re-check active state after the second await. #31 — guard on
      // handle identity: if the slot no longer holds OUR handle (the
      // loop was stopped + possibly re-started for the same sType/stbId)
      // we lost the race, so stop the source we just started and do NOT
      // write it onto whatever handle now occupies the slot.
      const final = this._continuousLoops.get(sType);
      if (final !== handle) {
        // Lost the race — stop the source we just started.
        this._stopAudioHandle(audio);
        return;
      }
      final.audioHandle = audio;
    };
    resolveAndPlay().catch((e) => {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(
        `[task-d/ambient] continuous loop start failed (stb=0x${stbId.toString(
          16
        )}, sType=0x${sType.toString(16)}):`,
        e
      );
    });
  }

  /**
   * Fire a one-shot probabilistic ambient. Same resolver path as
   * continuous, but `loop: false` and we don't track the handle —
   * AudioManager.play returns a Promise we don't await for ordering.
   */
  _fireProbabilistic(stbId, entry, listenerPos) {
    this.probabilisticFireCount += 1;
    const resolveAndPlay = async () => {
      const resolved = await this._soundTableCache.resolveSound(
        stbId,
        entry.sType
      );
      if (!resolved) return;
      const gain = clamp01(entry.volume * resolved.volume);
      // Phase F.C — emit event log record BEFORE play() so the
      // record always lands even if play() rejects. `continuous:
      // false` distinguishes from the looped-loop path; source_meta
      // mirrors the continuous record's shape so F.D's validator
      // treats both uniformly.
      this._pushEventRecord({
        type: "sound",
        wave_did: resolved.waveDid >>> 0,
        parent_entity_guid: null,
        world_pos: [+listenerPos.x, +listenerPos.y, +listenerPos.z],
        t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
        source: "AmbientRuntime",
        source_meta: {
          terrain_code: this._activeTerrainCode | 0,
          stb_id: stbId >>> 0,
          s_type: entry.sType >>> 0,
          continuous: false,
          base_chance: entry.baseChance,
          gain,
        },
      });
      // #15 (2026-06-07) — transform AC→three before play() so the
      // PannerNode lands in the same frame as the camera-anchored
      // AudioListener (else the one-shot is silently distance-culled).
      // The event-log world_pos above intentionally stays AC-frame.
      const [px, py, pz] = acToThree(
        +listenerPos.x,
        +listenerPos.y,
        +listenerPos.z
      );
      await this._audioManager.play(
        resolved.waveDid >>> 0,
        { x: px, y: py, z: pz },
        {
          // Phase 3 (2026-06-04) — route through the ambient category
          // bus so the ambient_sound_volume slider premultiplies before
          // the dB curve (retail acclient.c:383092-383095, @45630).
          category: "ambient",
          loop: false,
          gain,
          refDistance: AMBIENT_REF_DISTANCE,
          rolloffFactor: AMBIENT_ROLLOFF_FACTOR,
          maxDistance: AMBIENT_MAX_DISTANCE,
        }
      );
    };
    resolveAndPlay().catch((e) => {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(
        `[task-d/ambient] probabilistic fire failed (stb=0x${stbId.toString(
          16
        )}, sType=0x${entry.sType.toString(16)}):`,
        e
      );
    });
  }

  /**
   * Stop all continuous loops + clear the registry. Safe to call
   * even when audio handles are still resolving (the audio_handle
   * == null branch in resolveAndPlay above handles the race).
   */
  _stopAllContinuousLoops() {
    for (const h of this._continuousLoops.values()) {
      this._stopAudioHandle(h.audioHandle);
    }
    this._continuousLoops.clear();
  }

  /**
   * Stop a single audio handle by terminating its source. AudioManager
   * doesn't expose a per-handle `stop()`; we drive `source.stop()`
   * directly. Safe across browser variants — `source.stop(0)` is the
   * cross-browser stop primitive.
   */
  _stopAudioHandle(audioHandle) {
    if (!audioHandle) return;
    if (audioHandle.source && typeof audioHandle.source.stop === "function") {
      try {
        audioHandle.source.stop(0);
      } catch (_) {
        // source.stop() throws if not started yet or already stopped.
      }
    }
  }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
