// AmbientRuntime — adapter between the live scene and the retail terrain
// ambient model (scene3d/audio/ambient_model.js; OpenAC port, MIT).
//
// 2026-10-05 retail rewrite. The previous runtime read ONE nearest vertex,
// held continuous ambients as `loop: true` sources forever (each one
// occupying a retail voice slot), played intermittents at the listener and
// rolled the raw base_chance. Retail instead (acclient.c, read 2026-10-05;
// full citations in ambient_model.js):
//   - gathers EVERY cell within 120 m of the 3x3 landblocks around the
//     player, weighting each 1 inside 20 m, else 400/d^2 (Ambient::AddSound
//     384362, CalcWeight 383857), with 8 direction shells (CalcDir 383880);
//   - continuous ambients get volume = volume * share and are re-triggered
//     as ONE-SHOTS every min_rate from the centre (ConstantSound
//     384295/384013, Ambient::Play 384452), dropped below 0.03 (383947);
//   - intermittents fire with play_chance = base_chance * share every
//     RollDice(min_rate, max_rate) (384200/384004), POSITIONED on a
//     direction shell around the viewer (GetSoundPos 384212, AddTo 384260);
//   - PlayAmbientSound(FromCenter) (383518-383566) rolls the SoundTable
//     row's probability, plays the AMBIENT descriptor's volume (not the
//     row's) and applies the ambient slider twice.
// The regather happens when the player's cell changes (retail
// CellManager -> Ambient::InitSounds / LScape::add_ambient_sounds /
// UpdatePlayQueue, acclient.c:146744-146748), and while landblocks are
// still loading. Indoors (not seen_outside) nothing is added and the
// queue is dropped.
//
// Data sources (unchanged): the pre-baked per-vertex STB feed
// (`getBakedAmbientTriggers`, baked_ambient_source.js) or the live wasm
// Region chain over each landblock's `userData.terrainCodes` (scenePick 0).
//
// Heights (2026-10-05 round 3): offsets are 3D like retail's
// Position::get_offset — vertex Z from the terrain mesh's
// `userData.heights` (81 control-grid Z, column-major, terrain.js) against
// the player's Z. A landblock without a loaded mesh falls back to z = 0.
//
// Inactive app: retail keeps running Ambient::UseTime while the sound
// manager refuses plays, so cadences carry on; here the scheduler is
// fast-forwarded (no plays) while the AudioManager reports inactive, and on
// the first tick after any focus change (a hidden tab stops
// requestAnimationFrame, so that tick is the first one back), so returning
// to the tab does not fire every overdue ambient at once. A plain frame
// hitch (no focus change) is NOT fast-forwarded: retail would play the
// overdue sound late, once.
//
// Indoors: retail's InitSounds resets the counts and adds nothing, so
// instances stop being audible and drop off the queue at their own
// deadlines (384452) — the queue is not cleared at once.

import { acToThree } from "../adapter.js";
import {
  AmbientSoundScheduler,
  gatherAmbient,
  LAND_CELL_LENGTH,
  VERTICES_PER_SIDE,
} from "./ambient_model.js";

const REGATHER_WHILE_LOADING_S = 1.0;

export class AmbientRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.soundTableCache
   * @param {object} opts.audioManager  play() / playFromCenter()
   * @param {() => ({x:number,y:number,z:number}|null)} opts.getPlayerPos  AC world metres
   * @param {() => any} opts.getRegion  RegionJs or Promise (live chain)
   * @param {(lbX:number, lbY:number) => (Array|null)} [opts.getBakedAmbientTriggers]
   * @param {() => boolean} [opts.isCurrentCellIndoor]
   * @param {() => boolean} [opts.isCurrentCellSeenOutside]
   * @param {() => Array} [opts.getTerrainMeshes]
   * @param {() => number} [opts.rng]
   * @param {number} [opts.scenePick=0]
   * @param {(record: object) => void} [opts.pushEventRecord]
   * @param {() => number} [opts.clock]  wall-clock ms (default performance.now)
   */
  constructor(opts) {
    if (!opts || !opts.soundTableCache || !opts.audioManager) {
      throw new Error("AmbientRuntime: opts.soundTableCache + opts.audioManager required");
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
    this._getBakedAmbientTriggers =
      typeof opts.getBakedAmbientTriggers === "function" ? opts.getBakedAmbientTriggers : null;
    this._isCurrentCellIndoor =
      typeof opts.isCurrentCellIndoor === "function" ? opts.isCurrentCellIndoor : () => false;
    this._isCurrentCellSeenOutside =
      typeof opts.isCurrentCellSeenOutside === "function" ? opts.isCurrentCellSeenOutside : () => false;
    this._getTerrainMeshes =
      typeof opts.getTerrainMeshes === "function" ? opts.getTerrainMeshes : null;
    this._rng = typeof opts.rng === "function" ? opts.rng : Math.random;
    this._scenePick = Number.isFinite(opts.scenePick) ? opts.scenePick | 0 : 0;
    this._pushEventRecord =
      typeof opts.pushEventRecord === "function" ? opts.pushEventRecord : () => {};
    this._clock = typeof opts.clock === "function"
      ? opts.clock
      : (typeof performance !== "undefined" ? () => performance.now() : () => Date.now());

    this._scheduler = new AmbientSoundScheduler(this._rng);
    this._firings = [];
    this._region = null;
    this._regionRequested = false;
    this._gatherKey = null;
    this._lastGatherS = -Infinity;
    this._lastMissing = 0;
    this._lastIndoor = false;
    this._lastEpoch = null;

    // Diagnostics.
    this.tickCount = 0;
    this.gatherCount = 0;
    this.continuousFireCount = 0;
    this.probabilisticFireCount = 0;
    this.skippedNoRegion = 0;
    this.skippedNoPlayer = 0;
    this.skippedIndoor = 0;
    this.terrainSampleMisses = 0;
    this.lastError = null;
  }

  /** Seconds on the runtime clock. */
  _nowS() {
    return (+this._clock()) / 1000;
  }

  /** Called once per frame; `_dt` is advisory (the wall clock drives the queue). */
  tick(_dt) {
    this.tickCount += 1;
    const now = this._nowS();
    const epoch = this._audioManager.activityEpoch | 0;
    const focusChanged = this._lastEpoch !== null && epoch !== this._lastEpoch;
    this._lastEpoch = epoch;
    const inactive = this._audioManager.isActive?.() === false;
    if (inactive || focusChanged) {
      this._scheduler.fastForward(now);
      this.fastForwardCount = (this.fastForwardCount | 0) + 1;
      if (inactive) return;
    }

    if (!this._getBakedAmbientTriggers && !this._region) {
      this._tryResolveRegion();
      if (!this._region) {
        this.skippedNoRegion += 1;
        return;
      }
    }

    const player = this._getPlayerPos();
    if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) {
      this.skippedNoPlayer += 1;
      return;
    }
    const listener = { x: +player.x, y: +player.y, z: Number.isFinite(player.z) ? +player.z : 0 };

    const indoor = !!this._isCurrentCellIndoor() && !this._isCurrentCellSeenOutside?.();
    if (indoor) {
      // Outdoor cells only contribute when outdoors or seen_outside
      // (acclient.c:146721/146746). Retail InitSounds + UpdatePlayQueue with
      // nothing added: counts reset, nothing is audible, and each queued
      // instance drops off at its own deadline (Ambient::Play CanHear,
      // 384452-384500) — keep ticking the queue rather than clearing it.
      if (!this._lastIndoor) {
        this._scheduler.beginRebuild();
        this._scheduler.endRebuild(now);
      }
      this._lastIndoor = true;
      this._gatherKey = null;
      this.skippedIndoor += 1;
      this._firings.length = 0;
      this._scheduler.tick(now, this._firings, this._soundBase(listener));
      this._emit(listener);
      return;
    }
    this._lastIndoor = false;

    const key = `${Math.floor(listener.x / LAND_CELL_LENGTH)}:${Math.floor(listener.y / LAND_CELL_LENGTH)}`;
    const loading = this._lastMissing > 0 && now - this._lastGatherS >= REGATHER_WHILE_LOADING_S;
    if (key !== this._gatherKey || loading) {
      this._gatherKey = key;
      this._gather(listener, now);
    }

    this._firings.length = 0;
    this._scheduler.tick(now, this._firings, this._soundBase(listener));
    this._emit(listener);
  }

  /** Drop every instance and deadline (renderer switch / world teardown). */
  reset() {
    this._scheduler.clear();
    this._gatherKey = null;
    this._lastIndoor = false;
    this._lastMissing = 0;
  }

  setClockForTest(clockFn) {
    if (typeof clockFn !== "function") throw new Error("setClockForTest: clockFn must be a function");
    const prior = this._clock;
    this._clock = clockFn;
    return prior;
  }

  stats() {
    const insts = this._scheduler.instances;
    let dominant = null;
    for (const i of insts) if (i.soundCount > 0 && (!dominant || i.soundCount > dominant.soundCount)) dominant = i;
    return {
      tickCount: this.tickCount,
      gatherCount: this.gatherCount,
      activeStbId: dominant ? dominant.stbId : null,
      totalSoundCount: this._scheduler.totalSoundCount,
      queued: this._scheduler.queuedCount,
      instances: insts.map((i) => ({
        stbId: i.stbId,
        sType: i.desc.sType,
        continuous: i.isContinuous,
        soundCount: +i.soundCount.toFixed(4),
        volume: +i.currentVolume.toFixed(4),
        playChance: +i.playChance.toFixed(4),
        directions: i.directions.length,
        onQueue: i.onQueue,
      })),
      continuousFireCount: this.continuousFireCount,
      probabilisticFireCount: this.probabilisticFireCount,
      skippedNoRegion: this.skippedNoRegion,
      skippedNoPlayer: this.skippedNoPlayer,
      skippedIndoor: this.skippedIndoor,
      terrainSampleMisses: this.terrainSampleMisses,
      lastError: this.lastError,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────

  _gather(listener, now) {
    this.gatherCount += 1;
    this._lastGatherS = now;
    this._firings.length = 0;
    const liveCache = new Map();
    const { missing } = gatherAmbient(
      this._scheduler,
      listener,
      (lbX, lbY) => this._cellSource(lbX, lbY, liveCache),
      now,
      this._firings,
    );
    this._lastMissing = missing;
    if (missing) this.terrainSampleMisses += missing;
    // UpdatePlayQueue plays any newly audible sound at once (384630-384652).
    this._emit(listener);
  }

  /** Per-landblock {stbAt, heightAt} lookup, or null while missing. */
  _cellSource(lbX, lbY, liveCache) {
    const mesh = this._findMesh(lbX, lbY);
    const heights = mesh?.userData?.heights;
    const heightAt = heights && heights.length >= VERTICES_PER_SIDE * VERTICES_PER_SIDE
      ? (vi) => heights[vi]
      : null;
    const stbAt = this._stbSource(lbX, lbY, mesh, liveCache);
    return stbAt ? { stbAt, heightAt } : null;
  }

  _stbSource(lbX, lbY, mesh, liveCache) {
    if (this._getBakedAmbientTriggers) {
      let triggers;
      try { triggers = this._getBakedAmbientTriggers(lbX, lbY); } catch (_) { triggers = null; }
      if (triggers == null) return null;
      const byVertex = new Map();
      for (const t of triggers) {
        if (!t || !Array.isArray(t.vertexIndices)) continue;
        const entry = { stbId: t.stbId >>> 0, sounds: t.ambientSounds || [] };
        for (const vi of t.vertexIndices) if (!byVertex.has(vi | 0)) byVertex.set(vi | 0, entry);
      }
      return (vi) => byVertex.get(vi) ?? null;
    }
    const codes = mesh?.userData?.terrainCodes;
    if (!codes || codes.length < VERTICES_PER_SIDE * VERTICES_PER_SIDE) return null;
    return (vi) => this._liveStbForCode(codes[vi] | 0, liveCache);
  }

  _liveStbForCode(code, cache) {
    if (cache.has(code)) return cache.get(code);
    let out = null;
    try {
      const stb = this._region.ambientStbForTerrainCode(code, this._scenePick);
      if (stb) {
        const raw = stb.ambientSounds?.() ?? [];
        out = {
          stbId: stb.stbId >>> 0,
          sounds: raw.map((s) => ({
            sType: s.sType >>> 0, volume: +s.volume, baseChance: +s.baseChance,
            minRate: +s.minRate, maxRate: +s.maxRate, isContinuous: !!s.isContinuous,
          })),
        };
        try { stb.free?.(); } catch (_) {}
      }
    } catch (e) {
      this.lastError = String(e?.message ?? e);
    }
    cache.set(code, out);
    return out;
  }

  _findMesh(lbX, lbY) {
    const meshes = this._listTerrainMeshes();
    if (!meshes) return null;
    for (const m of meshes) {
      if (m?.userData && m.userData.lbX === lbX && m.userData.lbY === lbY) return m;
    }
    return null;
  }

  _listTerrainMeshes() {
    if (this._getTerrainMeshes) {
      try { return this._getTerrainMeshes(); } catch (_) { return null; }
    }
    const ls = typeof window !== "undefined" ? window.liveScene3d : null;
    return ls?.terrainGroup?.children ?? null;
  }

  /** Base of GetSoundPos: the listener (retail player_position_ = viewer). */
  _soundBase(player) {
    const l = this._audioManager.getListenerAc?.();
    return l ? { x: l.x, y: l.y, z: l.z } : player;
  }

  _emit(player) {
    if (!this._firings.length) return;
    const firings = this._firings.splice(0);
    for (const f of firings) this._play(f, player);
  }

  _play(firing, player) {
    const inst = firing.instance;
    if (inst.isContinuous) this.continuousFireCount += 1;
    else this.probabilisticFireCount += 1;
    const run = async () => {
      const row = await this._soundTableCache.resolveSound(inst.stbId, inst.desc.sType);
      if (!row) return;
      // PlayAmbientSound(FromCenter) roll the row's probability
      // (acclient.c:383533/383557) and play the AMBIENT volume.
      if (!(this._rng() < (Number.isFinite(row.probability) ? row.probability : 1.0))) return;
      const at = firing.position ?? player;
      this._pushEventRecord({
        type: "sound",
        wave_did: row.waveDid >>> 0,
        parent_entity_guid: null,
        world_pos: [+at.x, +at.y, +at.z],
        t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
        source: "AmbientRuntime",
        source_meta: {
          stb_id: inst.stbId >>> 0,
          s_type: inst.desc.sType >>> 0,
          continuous: inst.isContinuous,
          positional: !!firing.position,
          gain: firing.volume,
        },
      });
      const opts = { category: "ambient", sliderTwice: true };
      if (firing.position) {
        const [x, y, z] = acToThree(firing.position.x, firing.position.y, firing.position.z);
        await this._audioManager.play(row.waveDid >>> 0, { x, y, z }, { ...opts, gain: firing.volume });
      } else if (typeof this._audioManager.playFromCenter === "function") {
        await this._audioManager.playFromCenter(row.waveDid >>> 0, firing.volume, opts);
      }
    };
    run().catch((e) => {
      this.lastError = String(e?.message ?? e);
    });
  }

  _tryResolveRegion() {
    if (this._regionRequested) return;
    let r;
    try { r = this._getRegion(); } catch (e) { this.lastError = String(e?.message ?? e); return; }
    if (!r) return;
    if (typeof r.then === "function") {
      this._regionRequested = true;
      r.then((v) => { if (v) this._region = v; })
        .catch((e) => { this.lastError = String(e?.message ?? e); })
        .finally(() => { this._regionRequested = false; });
    } else {
      this._region = r;
    }
  }
}
