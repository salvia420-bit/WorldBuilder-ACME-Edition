// Retail terrain-ambient sound model — pure logic (no Web Audio, no DOM).
//
// Ported from OpenAC (MIT, Copyright (c) 2026 Erik Nihlén and OpenAC
// contributors): src/AcDream.Core/Audio/AmbientSoundModel.cs,
// AmbientSoundScheduler.cs and AmbientSoundGatherer.cs, checked against
// the retail decomp (acclient.c, read 2026-10-05):
//
//   gather   CLandBlock::add_ambient_sounds ~352444-352509: every one of a
//            landblock's 8x8 cells contributes its vertex's STB
//            (terrain word (w>>2)&0x1F, scene (w>>11)) via Ambient::AddSound
//            384362-384400: offset = vertex - player; beyond 120 m (14400)
//            skipped; weight = CalcWeight; total += weight ONCE per cell;
//            every ambient row of the STB gets AddTo(weight, offset, dir).
//   weight   Ambient::CalcWeight 383857-383877: 1 inside 20 m, 400/d^2 to
//            120 m, else 0 (constants 45647-45651).
//   dir      Ambient::CalcDir 383880-383925: inside sqrt(200) m = "in viewer
//            block"; else N/S unless |x| >= 0.0002 and |y|/|x| <= 2, E/W
//            unless |y| >= 0.0002 and |x|/|y| <= 2, else a diagonal.
//   share    IntermitSound::UpdateSound 384200-384208: play_chance =
//            base_chance / total * count; ConstantSound::UpdateSound
//            384295-384308: current_volume = volume / total * count.
//   hear     IntermitSound::CanHear play_chance > 0 (383932);
//            ConstantSound::CanHear current_volume >= 0.03 (383947, 45650).
//   fire     Ambient::Play 384452-384500: CanHear -> PlayNow (RollDice <=
//            play_chance; constant always) -> GetSoundPos (intermittent:
//            positional around the viewer; constant: from the centre) ->
//            re-queue at now + GetPlayInterval (intermittent RollDice(min,
//            max) 384004; constant min_rate 384013). A continuous ambient
//            is therefore RE-TRIGGERED as a one-shot every min_rate — it is
//            not a held loop.
//   pos      IntermitSound::GetSoundPos 384212-384257 + AddTo 384260-384292:
//            pick a direction shell uniformly, heading +- 0.3927/2 jitter,
//            distance min + (max-min)*t^2, listener Z kept.
//   queue    Ambient::UseTime 384507-384531 pops every deadline < now;
//            Ambient::UpdatePlayQueue 384630-384652 updates shares and plays
//            any audible sound not already queued (no initial delay).

export const MIN_DISTANCE = 20.0;
export const MIN_DISTANCE_SQ = 400.0;
export const MAX_DISTANCE_SQ = 14400.0;
export const MIN_VOLUME = 0.03;
export const HEADING_SPREAD = 0.39269909;
export const IN_VIEWER_BLOCK_DISTANCE_SQ = MIN_DISTANCE_SQ * 0.5;
export const SHELL_HALF_THICKNESS = MIN_DISTANCE * 0.5;
export const IN_BLOCK_NEAR_DISTANCE = 5.0 - 1.0;
export const LAND_CELL_LENGTH = 24.0;
export const CELLS_PER_SIDE = 8;
export const VERTICES_PER_SIDE = 9;
export const LANDBLOCK_LENGTH = CELLS_PER_SIDE * LAND_CELL_LENGTH;

export const Dir = Object.freeze({
  IN_VIEWER_BLOCK: 0, NORTH: 1, SOUTH: 2, EAST: 3, WEST: 4,
  NORTHWEST: 5, SOUTHWEST: 6, NORTHEAST: 7, SOUTHEAST: 8,
});

/** LandDefs::heading — radians, 0 = north, clockwise. */
export function dirHeading(d) {
  switch (d) {
    case Dir.NORTH: return 0.0;
    case Dir.SOUTH: return 3.14159274;
    case Dir.EAST: return 1.57079637;
    case Dir.WEST: return 4.71238899;
    case Dir.NORTHWEST: return 5.497787;
    case Dir.SOUTHWEST: return 3.92699075;
    case Dir.NORTHEAST: return 0.78539819;
    case Dir.SOUTHEAST: return 2.3561945;
    default: return 0.0;
  }
}

const lenSq = (o) => o.x * o.x + o.y * o.y + (o.z || 0) * (o.z || 0);

export function calcWeight(offset) {
  const d2 = lenSq(offset);
  if (d2 > MAX_DISTANCE_SQ) return 0;
  if (d2 < MIN_DISTANCE_SQ) return 1;
  return MIN_DISTANCE_SQ / d2;
}

export function calcDirection(offset) {
  const x = offset.x;
  const y = offset.y;
  if (x * x + y * y < IN_VIEWER_BLOCK_DISTANCE_SQ) return Dir.IN_VIEWER_BLOCK;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax < 0.00019999999 || ay / ax > 2.0) return y < 0 ? Dir.SOUTH : Dir.NORTH;
  if (ay < 0.00019999999 || ax / ay > 2.0) return x < 0 ? Dir.WEST : Dir.EAST;
  if (x < 0) return y < 0 ? Dir.SOUTHWEST : Dir.NORTHWEST;
  return y < 0 ? Dir.SOUTHEAST : Dir.NORTHEAST;
}

/** Random::RollDice(min, max) with an inverted range swapped. */
export function rollDice(min, max, rng) {
  if (min === max) return min;
  let lo = min, hi = max;
  if (max < min) { lo = max; hi = min; }
  return lo + (hi - lo) * rng();
}

/**
 * @typedef {{sType:number, volume:number, baseChance:number, minRate:number,
 *            maxRate:number, isContinuous?:boolean}} AmbientDesc
 */
export class AmbientSoundInstance {
  /** @param {AmbientDesc} desc @param {number} stbId @param {string} key */
  constructor(desc, stbId, key) {
    this.desc = {
      sType: desc.sType >>> 0,
      volume: +desc.volume,
      baseChance: +desc.baseChance,
      minRate: +desc.minRate,
      maxRate: +desc.maxRate,
    };
    this.isContinuous = typeof desc.isContinuous === "boolean"
      ? desc.isContinuous : this.desc.baseChance === 0;
    this.stbId = stbId >>> 0;
    this.key = key;
    this.soundCount = 0;
    this.currentVolume = 0;
    this.playChance = 0;
    this.onQueue = false;
    /** @type {Array<{dir:number, min:number, max:number}>} */
    this.directions = [];
  }

  resetCount() {
    this.soundCount = 0;
    this.directions.length = 0;
    if (!this.isContinuous) this.playChance = 0;
  }

  addTo(weight, offset, dir) {
    this.soundCount += weight;
    if (this.isContinuous) return;
    const distance = Math.sqrt(lenSq(offset));
    const half = SHELL_HALF_THICKNESS;
    if (dir !== Dir.IN_VIEWER_BLOCK) {
      this._addDir(dir, distance - half, distance + half);
      return;
    }
    for (const d of [Dir.NORTH, Dir.SOUTH, Dir.EAST, Dir.WEST,
      Dir.NORTHWEST, Dir.NORTHEAST, Dir.SOUTHWEST, Dir.SOUTHEAST]) {
      this._addDir(d, IN_BLOCK_NEAR_DISTANCE, half);
    }
  }

  _addDir(dir, min, max) {
    for (const s of this.directions) {
      if (s.dir !== dir) continue;
      if (min < s.min) s.min = min;
      if (max > s.max) s.max = max;
      return;
    }
    if (this.directions.length >= 8) return;
    this.directions.push({ dir, min, max });
  }

  updateSound(total) {
    if (this.isContinuous) {
      this.currentVolume = this.soundCount === 0 ? 0 : (this.desc.volume / total) * this.soundCount;
      return;
    }
    if (this.soundCount > 0) this.playChance = (this.desc.baseChance / total) * this.soundCount;
  }

  canHear() {
    return this.isContinuous ? this.currentVolume >= MIN_VOLUME : this.playChance > 0;
  }

  playNow(rng) {
    return this.isContinuous || rng() <= this.playChance;
  }

  getVolume() {
    return this.isContinuous ? this.currentVolume : this.desc.volume;
  }

  getPlayInterval(rng) {
    return this.isContinuous ? this.desc.minRate : rollDice(this.desc.minRate, this.desc.maxRate, rng);
  }

  /** Positional intermittent location (AC frame), or null = from centre. */
  getSoundPosition(listener, rng) {
    if (this.isContinuous || this.directions.length === 0) return null;
    let idx = Math.floor(rng() * this.directions.length);
    if (idx >= this.directions.length) idx = this.directions.length - 1;
    const shell = this.directions[idx];
    const angle = dirHeading(shell.dir) + rng() * HEADING_SPREAD - HEADING_SPREAD * 0.5;
    const t = rng();
    const distance = shell.min + (shell.max - shell.min) * t * t;
    return {
      x: listener.x + Math.sin(angle) * distance,
      y: listener.y + Math.cos(angle) * distance,
      z: listener.z,
    };
  }
}

/** Minimal binary min-heap keyed by deadline. */
class DeadlineQueue {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, key) {
    const a = this.a;
    a.push({ item, key });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key <= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  peekKey() { return this.a.length ? this.a[0].key : Infinity; }
  pop() { return this.popEntry().item; }
  popEntry() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].key < a[m].key) m = l;
        if (r < a.length && a[r].key < a[m].key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  clear() { this.a.length = 0; }
}

/**
 * @typedef {{instance: AmbientSoundInstance, volume: number,
 *            position: {x:number,y:number,z:number}|null}} AmbientFiring
 */
export class AmbientSoundScheduler {
  constructor(rng = Math.random) {
    this.rng = rng;
    /** @type {AmbientSoundInstance[]} */
    this.instances = [];
    this._byKey = new Map();
    this._queue = new DeadlineQueue();
    this.totalSoundCount = 0;
  }

  get queuedCount() { return this._queue.size; }

  beginRebuild() {
    for (const i of this.instances) i.resetCount();
    this.totalSoundCount = 0;
  }

  track(desc, stbId, index = 0) {
    const key = `${stbId >>> 0}:${index}:${desc.sType >>> 0}:${desc.volume}:${desc.baseChance}:${desc.minRate}:${desc.maxRate}`;
    let inst = this._byKey.get(key);
    if (!inst) {
      inst = new AmbientSoundInstance(desc, stbId, key);
      this._byKey.set(key, inst);
      this.instances.push(inst);
    }
    return inst;
  }

  /** One cell's STB: weight counted ONCE, every row gets AddTo. */
  contributeCell(offset, stbId, sounds) {
    const w = calcWeight(offset);
    if (!(w > 0)) return;
    const dir = calcDirection(offset);
    this.totalSoundCount += w;
    for (let i = 0; i < sounds.length; i++) this.track(sounds[i], stbId, i).addTo(w, offset, dir);
  }

  /** Single-instance contribution (tests / OpenAC parity). */
  contribute(instance, offset) {
    const w = calcWeight(offset);
    if (!(w > 0)) return;
    instance.addTo(w, offset, calcDirection(offset));
    this.totalSoundCount += w;
  }

  endRebuild(now, firings = null, listener = { x: 0, y: 0, z: 0 }) {
    for (const i of this.instances) i.updateSound(this.totalSoundCount);
    for (const i of this.instances) {
      if (i.onQueue || !i.canHear()) continue;
      this._fire(i, now, firings, listener);
    }
  }

  tick(now, firings, listener) {
    while (this._queue.size && this._queue.peekKey() < now) {
      const i = this._queue.pop();
      i.onQueue = false;
      if (!i.canHear()) continue;
      this._fire(i, now, firings, listener);
    }
  }

  /**
   * Advance the queue to `now` WITHOUT playing anything — what retail's
   * Ambient::UseTime does while the sound manager refuses plays (inactive
   * app, s_bPlaySoundOnlyWhenActive 45633): each due instance is popped at
   * its deadline, its play is refused, and Ambient::Play re-queues it at
   * that time + its interval (384452-384500); an instance that can no
   * longer be heard drops off. So when sound resumes the bed carries on at
   * its cadence instead of every overdue instance firing at once.
   */
  fastForward(now) {
    while (this._queue.size && this._queue.peekKey() < now) {
      const { item: inst, key } = this._queue.popEntry();
      inst.onQueue = false;
      if (!inst.canHear()) continue;
      const interval = inst.getPlayInterval(this.rng);
      this._queue.push(inst, interval > 0 ? key + interval : now);
      inst.onQueue = true;
    }
  }

  clear() {
    for (const i of this.instances) i.onQueue = false;
    this.instances.length = 0;
    this._byKey.clear();
    this._queue.clear();
    this.totalSoundCount = 0;
  }

  _fire(inst, now, firings, listener) {
    if (firings && inst.playNow(this.rng)) {
      firings.push({
        instance: inst,
        volume: inst.getVolume(),
        position: inst.getSoundPosition(listener, this.rng),
      });
    }
    this._queue.push(inst, now + inst.getPlayInterval(this.rng));
    inst.onQueue = true;
  }
}

/**
 * Rebuild the scheduler from the 3x3 landblocks around the listener.
 *
 * Offsets are 3D when the source supplies vertex heights: retail
 * Position::get_offset is a full 3D difference, CalcWeight (383863) and the
 * 120 m cull (384375) use its 3D length and IntermitSound::AddTo sizes the
 * shells from it (384270); CalcDir uses x/y only (383880).
 *
 * A cell whose STB exists but lists no ambient rows still adds its weight to
 * the shared total (Ambient::AddSound adds `total += weight` before walking
 * the rows, 384382) — it dilutes the neighbours' shares.
 *
 * @param {AmbientSoundScheduler} scheduler
 * @param {{x:number, y:number, z?:number}} listener  AC world metres (lbX = floor(x/192))
 * @param {(lbX:number, lbY:number) => (((vertexIndex:number) =>
 *          ({stbId:number, sounds:AmbientDesc[]}|null))
 *          | {stbAt:(vi:number) => ({stbId:number, sounds:AmbientDesc[]}|null),
 *             heightAt?:(vi:number) => (number|null)}
 *          | null)} cellSource
 *        Per-vertex STB (and optional height) lookup for a loaded
 *        landblock, or null when the landblock is missing.
 * @returns {{missing:number}} landblocks that returned null
 */
export function gatherAmbient(scheduler, listener, cellSource, now, firings = null) {
  scheduler.beginRebuild();
  const vx = Math.floor(listener.x / LANDBLOCK_LENGTH);
  const vy = Math.floor(listener.y / LANDBLOCK_LENGTH);
  let missing = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bx = vx + dx, by = vy + dy;
      if (bx < 0 || bx > 0xff || by < 0 || by > 0xff) continue;
      const src = cellSource(bx, by);
      if (!src) { missing += 1; continue; }
      const stbAt = typeof src === "function" ? src : src.stbAt;
      const heightAt = typeof src === "function" ? null : src.heightAt;
      const lz = Number.isFinite(listener.z) ? listener.z : 0;
      for (let x = 0; x < CELLS_PER_SIDE; x++) {
        for (let y = 0; y < CELLS_PER_SIDE; y++) {
          const vi = x * VERTICES_PER_SIDE + y;
          const h = heightAt ? heightAt(vi) : null;
          const offset = {
            x: bx * LANDBLOCK_LENGTH + x * LAND_CELL_LENGTH - listener.x,
            y: by * LANDBLOCK_LENGTH + y * LAND_CELL_LENGTH - listener.y,
            z: Number.isFinite(h) ? h - lz : 0,
          };
          if (lenSq(offset) > MAX_DISTANCE_SQ) continue;
          const stb = stbAt(vi);
          if (!stb) continue;
          scheduler.contributeCell(offset, stb.stbId >>> 0, stb.sounds || []);
        }
      }
    }
  }
  scheduler.endRebuild(now, firings, { x: listener.x, y: listener.y, z: listener.z ?? 0 });
  return { missing };
}
