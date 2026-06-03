// Phase 7.4a — RAW keyframe → THREE.AnimationClip adapter.
//
// Sister to scene3d/adapter.js — converts wasm
// `EntityAnimationData.partFrames` (a flat Float32Array laid out as
// `[(x, y, z, qw, qx, qy, qz) per part] per frame`) into a
// `THREE.AnimationClip` with two `KeyframeTrack`s per part
// (`.position` + `.quaternion`). The clip is consumed by a
// `THREE.AnimationMixer` bound to the per-entity `Object3D` rig that
// Phase 7.4b builds — each part of the rig is a named child whose
// `.position` / `.quaternion` channels match the track names emitted
// here.
//
// Quaternion order: AC stores `(qw, qx, qy, qz)` — three.js wants
// `(x, y, z, w)`. The reorder happens during the per-track copy
// (vs. via `acQuatToThree` which constructs full Quaternion objects;
// here we just stuff numbers into a `Float32Array` for
// `QuaternionKeyframeTrack`).
//
// This module imports `three` as a bare specifier — works in the
// browser via index.html's importmap and in Node ≥ 22 via a future
// experimental loader. Smoke validation is regex-based; the
// functional ESM test lives in
// `apps/holtburger-web/test_phase7_4a_animation_clip.mjs`.

import * as THREE from "three";
// 2026-05-16 fix for the "second spawn of same setup_id renders no body"
// race. We convert the wasm-side `partMeshes` to three.js BufferGeometry
// + surfaceDid arrays INSIDE this cache so the conversion + wasm-side
// `.free()` happens exactly once per (setupId, mtable, cmd, stance).
// Prior behaviour: every consuming `_spawnImpl` converted then freed,
// but the cache stored a SHARED `partMeshes` array — second consumer's
// converter got null-ptr wrappers and silently returned empty groups,
// so all-but-one NPCs of a shared setup spawned bodyless.
import { meshToGeometryGroups } from "./adapter.js";

// Per-part keyframe stride in `partFrames`: 3 (position) + 4
// (quaternion) = 7 floats.
const FLOATS_PER_PART_PER_FRAME = 7;

/**
 * Build a `THREE.AnimationClip` from raw wasm keyframe data.
 *
 * @param {object} animData - shape:
 *   `{ partCount: number, numFrames: number, framerate: number,
 *      partFrames: Float32Array | number[] }`. Typically the
 *   wasm-bindgen `EntityAnimationData` object whose `partFrames`
 *   getter clones the flat keyframe buffer, OR a plain JS object
 *   with the same fields (used by the smoke test for
 *   round-trip validation).
 * @param {string[]} partNames - names of the per-part `Object3D`
 *   children in the entity rig. Convention: `"part_0"`, `"part_1"`,
 *   ... — matches `EntityManager` (Phase 7.4b) builds. Length must
 *   equal `animData.partCount`.
 * @returns {THREE.AnimationClip|null} - `null` when `numFrames === 0`
 *   (no animation; renderer keeps rest pose). Otherwise a clip with
 *   `2 * partCount` tracks (position + quaternion per part) and
 *   `duration = numFrames / framerate`.
 *
 * The clip's `name` is left as the empty string — callers can stamp
 * it later (the `AnimationCache.get` path stamps `${setupId}:${...}`
 * for debugger ergonomics).
 */
export function buildAnimationClip(animData, partNames) {
    const {
        partCount,
        numFrames,
        framerate,
        partFrames,
        frameTimes,
        duration,
        posFrames,
    } = animData;

    if (
        typeof partCount !== "number" ||
        typeof numFrames !== "number" ||
        typeof framerate !== "number"
    ) {
        throw new TypeError(
            `buildAnimationClip: animData must carry numeric partCount/numFrames/framerate; got ${typeof partCount}/${typeof numFrames}/${typeof framerate}`
        );
    }
    if (numFrames === 0) {
        // No cycle resolved — caller renders rest pose only.
        return null;
    }
    if (!Array.isArray(partNames) || partNames.length !== partCount) {
        throw new TypeError(
            `buildAnimationClip: partNames length ${partNames?.length ?? "n/a"} does not match partCount ${partCount}`
        );
    }
    const expectedSize = numFrames * partCount * FLOATS_PER_PART_PER_FRAME;
    const flat = partFrames;
    if (!flat || flat.length !== expectedSize) {
        throw new TypeError(
            `buildAnimationClip: partFrames length ${flat?.length ?? "n/a"} != numFrames*partCount*7 (${expectedSize})`
        );
    }

    // Times array — same for every track. T4 (2026-05-28): prefer the
    // per-frame `frameTimes` from wasm. A single `AnimData` carries one
    // framerate, but a MotionData chains MULTIPLE AnimData (≈23% of retail) —
    // e.g. a swing's windup→strike→recover→settle — each with its own rate
    // AND sign (≈22% are negative = reverse playback). The wasm side now
    // concatenates all segments (ACE Sequence/AnimSequenceNode chaining) and
    // emits the cumulative per-frame time, so a single uniform `i / framerate`
    // can no longer represent the clip. We fall back to uniform timing only
    // for legacy/plain animData with no frameTimes (the smoke test, or a
    // single-AnimData cycle where the two are identical anyway).
    //
    // Frames themselves are still authored keys snapped via InterpolateDiscrete
    // (PhatSDK `(long)floor(frame_number)`); only the per-frame *time stamps*
    // become non-uniform across segments.
    let times;
    const hasFrameTimes =
        frameTimes &&
        typeof frameTimes.length === "number" &&
        frameTimes.length === numFrames;
    if (hasFrameTimes) {
        times =
            frameTimes instanceof Float32Array
                ? frameTimes
                : Float32Array.from(frameTimes);
    } else {
        if (framerate <= 0) {
            // No usable timing source — caller renders rest pose only.
            return null;
        }
        times = new Float32Array(numFrames);
        const dt = 1.0 / framerate;
        for (let f = 0; f < numFrames; f += 1) {
            times[f] = f * dt;
        }
    }

    // Render-completeness audit (2026-05-29) — root motion. `posFrames` (if
    // present) carries a per-frame whole-object translation (x,y,z per frame,
    // length numFrames*3) from the Animation's pos_frames. We add it to EVERY
    // part's position keyframe so the whole rig translates together (a lunge
    // steps forward, a door swings open). All-zero / absent for idle + walk/run
    // cycles (verified pos_frames_len==0 on the human idle), so this is a no-op
    // for the common case. Fail-soft: wrong length → no offset.
    const hasPos =
        posFrames &&
        typeof posFrames.length === "number" &&
        posFrames.length === numFrames * 3;

    const tracks = [];
    for (let p = 0; p < partCount; p += 1) {
        const posValues = new Float32Array(numFrames * 3);
        const quatValues = new Float32Array(numFrames * 4);
        for (let f = 0; f < numFrames; f += 1) {
            const base =
                (f * partCount + p) * FLOATS_PER_PART_PER_FRAME;
            // (x, y, z) — part-local origin + (optional) whole-object root motion.
            const rx = hasPos ? posFrames[f * 3 + 0] : 0;
            const ry = hasPos ? posFrames[f * 3 + 1] : 0;
            const rz = hasPos ? posFrames[f * 3 + 2] : 0;
            posValues[f * 3 + 0] = flat[base + 0] + rx;
            posValues[f * 3 + 1] = flat[base + 1] + ry;
            posValues[f * 3 + 2] = flat[base + 2] + rz;
            // (qw, qx, qy, qz) → (qx, qy, qz, qw) for three.js's
            // QuaternionKeyframeTrack value layout.
            const qw = flat[base + 3];
            const qx = flat[base + 4];
            const qy = flat[base + 5];
            const qz = flat[base + 6];
            quatValues[f * 4 + 0] = qx;
            quatValues[f * 4 + 1] = qy;
            quatValues[f * 4 + 2] = qz;
            quatValues[f * 4 + 3] = qw;
        }
        const partName = partNames[p];
        // Cohere-B (2026-05-12): `InterpolateDiscrete` makes the mixer
        // snap to the latest authored frame rather than LERP/SLERP
        // between consecutive keys. AC animations are baked at the
        // canonical 30 Hz with every frame as an explicit key (Joe
        // Angell's AllKeyer workflow); retail snapped at runtime and
        // never interpolated. Without this flag, three.js's default
        // linear/SLERP fills intermediate poses the animators never
        // authored — visible as rig decoherence in motion. See
        // PhatSDK PartArray.cpp:56-59 (`(long)floor(frame_number)`)
        // for the retail snap path.
        //
        // T3 GUARD (2026-06-02): this discrete flag is now LOAD-BEARING for
        // the non-uniform `times` array. When `frameTimes` is supplied, the
        // per-segment gaps between keys are uneven (each AnimData segment has
        // its own framerate + sign). InterpolateDiscrete still snaps to the
        // last-passed key regardless of spacing, which is exactly retail's
        // `floor(frame_number)` behavior. DO NOT switch either track to
        // Interpolate{Linear,Smooth}: with non-uniform times that would
        // SLERP/LERP across segment boundaries (windup→strike) at a
        // mismatched rate, re-introducing the very decoherence this fix
        // removes. Both tracks below MUST stay InterpolateDiscrete.
        tracks.push(
            new THREE.VectorKeyframeTrack(
                `${partName}.position`,
                times,
                posValues,
                THREE.InterpolateDiscrete
            )
        );
        tracks.push(
            new THREE.QuaternionKeyframeTrack(
                `${partName}.quaternion`,
                times,
                quatValues,
                THREE.InterpolateDiscrete
            )
        );
    }

    // Prefer the wasm-provided total duration (T4 — last frame time + its
    // segment dt). Fall back to the legacy numFrames/framerate, then to the
    // last frame time.
    let clipDuration;
    if (typeof duration === "number" && duration > 0) {
        clipDuration = duration;
    } else if (framerate > 0) {
        clipDuration = numFrames / framerate;
    } else {
        clipDuration = times.length ? times[times.length - 1] : 0;
    }
    return new THREE.AnimationClip("", clipDuration, tracks);
}

/**
 * T11 (2026-05-28) — locomotion cycle playback-rate factor (anti-ice-skating).
 *
 * Retail scales a movement cycle's framerate by the ratio of the entity's
 * ACTUAL ground speed to the speed the cycle was AUTHORED to move at
 * (`MotionData.velocity` magnitude) — ACE `AnimData.Framerate = base * speed`,
 * `MotionInterp.apply_run_to_command`. Holtburger currently plays walk/run
 * cycles at a fixed `setEffectiveTimeScale(1.0)` (entities.js), so foot-speed
 * desyncs from ground travel ("ice-skating") whenever actual ≠ authored speed
 * (encumbrance, run-skill, backpedal).
 *
 * This is the pure factor. `baseSpeed <= 0` (or non-finite inputs) → 1.0
 * (no-op), and the result is clamped to [0.25, 4.0] so a bad/zero authored
 * velocity can't freeze or hyper-spin the rig.
 *
 * T1 (2026-06-02): now WIRED. The two inputs come from the motion-state
 * model rather than the old XZ-position-delta heuristic:
 *   - `actualSpeed` ← the new synchronous wasm getter `stateGroundSpeed`
 *     (rust `state_ground_speed`), the FINAL ground anim-speed in m/s with
 *     `run_rate` already applied internally (clamp `run_rate*4.0`). JS must
 *     NOT re-scale it by run_rate — it is the retail `get_state_velocity`
 *     magnitude. entities.js feeds it as this arg at entities.js:6841,
 *     replacing the EMA-on-XZ-position-delta reading (which read garbage
 *     during server-pose snaps / teleports / rubber-banding).
 *   - `baseSpeed` ← the existing async wasm getter `cycleBaseSpeed`, now a
 *     robust authored-speed resolver (|MotionData.velocity| →
 *     MotionKinematics.cycle_kinematics → GetAnimDist → 0.0). A returned
 *     `0.0` ("no scaling") lands in the `baseSpeed <= 1e-4` no-op below.
 *
 * This function is PURE and UNCHANGED — it consumes whatever scalars it is
 * handed, so the robust base + state-velocity actual flow straight through.
 * The clamp [0.25, 4.0] and the `base <= 1e-4 -> 1.0` no-op are load-bearing
 * (a bad/empty authored velocity can't freeze or hyper-spin the rig). Do NOT
 * touch the discrete-interpolation behavior in buildAnimationClip — this is
 * a playback-RATE factor (setEffectiveTimeScale), orthogonal to per-key snap.
 *
 * @param {number} actualSpeed - entity ground speed (m/s, final, run_rate
 *   already applied by `stateGroundSpeed`); sign ignored.
 * @param {number} baseSpeed   - authored cycle speed from `cycleBaseSpeed`
 *   (|MotionData.velocity| or its GetAnimDist/MotionKinematics fallback).
 * @returns {number} timeScale to pass to `action.setEffectiveTimeScale`.
 */
export function cycleTimeScale(actualSpeed, baseSpeed) {
    // T1: base<=1e-4 (including the cycleBaseSpeed "0.0 = no scaling"
    // sentinel) and any non-finite input → 1.0 no-op. Clamp stays [0.25, 4.0].
    if (
        !Number.isFinite(actualSpeed) ||
        !Number.isFinite(baseSpeed) ||
        baseSpeed <= 1e-4
    ) {
        return 1.0;
    }
    const f = Math.abs(actualSpeed) / baseSpeed;
    return Math.min(4.0, Math.max(0.25, f));
}

/**
 * Cache of built `THREE.AnimationClip`s keyed by
 * `${setupId}:${mtableId}:${motionCommand}:${stance}`. Memoizes the
 * wasm round-trip + the JS-side clip build so a second call for the
 * same key returns the same Promise.
 *
 * Phase 7.4b's `EntityManager` will instantiate one cache per
 * scene + share it across every entity. Two NPCs with the same
 * setup + clothing template hit the same cache entry and share the
 * underlying `AnimationClip` (mixer-bound bindings live per-entity,
 * so this is safe).
 */
export class AnimationCache {
    constructor() {
        // key → Promise<{ clip, partMeshes, partCount, framerate, resolvedStance }>
        //
        // Wave 7.6 (2026-05-24) — LRU eviction. Pre-W7.5 the cache key
        // was setup/mt/motion/stance and 169-LB Holtburg fit
        // comfortably under a few hundred entries. W7.5's substitution-
        // aware suffix multiplies entries by num_unique_equip_variants
        // per (setup, mt, motion, stance) tuple, which is bounded in
        // starter zones but can grow large in dense vendor towns or
        // long-running sessions. JS `Map` preserves insertion order;
        // `get(key)` on a hit deletes+re-inserts to move-to-tail
        // (strict LRU). When `entries.size > maxEntries` after a
        // miss-then-fetch, we evict from the head — skipping any key
        // that's still in `pendingStartTimes` (an in-flight Promise
        // shared by concurrent callers — evicting it would cause
        // duplicate fetches but never corruption).
        //
        // Geometries held by cached entries are also referenced by
        // every live entity's Mesh tree (entity registers them at
        // spawn time via `inst.registerGeometry`). Eviction just
        // drops the cache entry — live entities continue rendering;
        // dispose happens via normal GC when the last entity using
        // a geometry despawns. Cache geometries don't carry the
        // `__disposable` userData tag, so `EntityInstance.dispose`'s
        // skip-cache-geometries guard (FU3) already protects against
        // disposing them prematurely. Mixer + AnimationAction objects
        // pinned by live entities also keep `entry.clip` alive
        // independently of the cache.
        this.entries = new Map();
        // Wave 7.6 — cap + eviction stats. URL flag `?animCacheMax=N`
        // overrides the default for stress testing or memory tuning.
        this.maxEntries = 256;
        try {
            if (typeof window !== "undefined" && window.location) {
                const v = new URLSearchParams(window.location.search).get("animCacheMax");
                if (v) {
                    const n = parseInt(v, 10);
                    if (Number.isFinite(n) && n >= 1) this.maxEntries = n;
                }
            }
        } catch (_) {}
        // Cumulative eviction counter + high-watermark of entries.size.
        this.evictionCount = 0;
        this.sizeWatermark = 0;
        // Sidecar to `entries` keyed by the same cache-key — records
        // wall-clock at promise-creation time so `__diag.assets.stuck
        // (thresholdMs)` can flag long-pending fetches. Cleared in
        // `.then` / `.catch` continuations attached at .set() time so
        // entries.size keeps growing (cache pattern) but pendingStart
        // Times only retains in-flight requests. Observation only —
        // never read from cache logic.
        /** @type {Map<string, number>} */
        this.pendingStartTimes = new Map();
        // setupId → string[] (computed on first bake; reused for every
        // future stance/command on the same setup).
        this.partNames = new Map();
        // F.40 (2026-05-14) — set of setupIds whose wasm-side `shards`
        // cache has been pre-warmed via `getBatch`. The batched
        // wasm call walks Setup → MotionTable → default Animations
        // for each setupId in ONE prefetch loop; subsequent
        // single-call `fetchEntityAnimationKeyframes` invocations hit
        // the warm cache and complete sync-fast. The JS-side cache
        // entries fill in lazily via the normal `get(...)` path on
        // first spawn — `getBatch` does NOT populate per-cache-key
        // entries because the batch's mt=0/motion=0/stance=0
        // semantics don't carry walk/run clip data (the wasm side
        // returns rest-pose-only payloads); only specific
        // `(setupId, mt, motion, stance)` tuples have those, and
        // those land via `get(...)` after motion arrives on the wire.
        this.prewarmedSetupIds = new Set();
        // In-flight batch promise dedup. Concurrent `getBatch` calls
        // for overlapping setup sets share a single
        // `fetchEntityAnimationKeyframesBatch` round-trip via a small
        // request-coalescing window keyed on the sorted union of
        // requested setupIds.
        this._batchInFlight = new Map();
    }

    /**
     * Build the cache key. Mirrors the 2D path's cycle bake key shape.
     */
    static makeKey(setupId, mtableId, motionCommand, stance) {
        return `${setupId >>> 0}:${mtableId >>> 0}:${motionCommand >>> 0}:${stance >>> 0}`;
    }

    /**
     * Wave 7.5 (2026-05-24) — substitution-aware cache-key suffix.
     *
     * Pre-W7.5 the cache key was just (setupId, mtableId, motion,
     * stance). modelChanges + textureChanges + paletteId +
     * paletteSubsFlat were passed to fetchKeyframes but NOT folded
     * into the cache key, so two spawns of the same setup with
     * different equips returned the same cached entry — silently
     * stale for any callsite that varied substitutions across calls
     * (W7.3 despawn+respawn applyAppearance, W7.5 hot-swap, and any
     * future plugin that needs to re-render an entity with new
     * substitutions).
     *
     * Suffix is omitted (returns empty string) when every
     * substitution arg is at its default (zero / empty), so the
     * pre-W7.5 cache keys for plain spawns continue to match. The
     * suffix uses a stable FNV-1a-like hash over the input bytes
     * so identical equips across multiple entities share one
     * cache slot.
     */
    static _substitutionSuffix(modelChanges, textureChanges, paletteId, paletteSubsFlat) {
        const mc = modelChanges || new Uint32Array(0);
        const tc = textureChanges || new Uint32Array(0);
        const psf = paletteSubsFlat || new Uint32Array(0);
        const pid = (paletteId ?? 0) >>> 0;
        if (mc.length === 0 && tc.length === 0 && psf.length === 0 && pid === 0) {
            return "";
        }
        // Simple stable mix. Pre-W7.5 stance keys had no suffix.
        let h = 0x811C9DC5 >>> 0;
        const mix = (v) => {
            h = (h ^ ((v >>> 0))) >>> 0;
            // h *= 0x01000193 mod 2^32 — emulate without BigInt.
            h = Math.imul(h, 0x01000193) >>> 0;
        };
        mix(0xA1); for (let i = 0; i < mc.length; i++) mix(mc[i]);
        mix(0xB2); for (let i = 0; i < tc.length; i++) mix(tc[i]);
        mix(0xC3); mix(pid);
        mix(0xD4); for (let i = 0; i < psf.length; i++) mix(psf[i]);
        return `:sub:${h.toString(16)}`;
    }

    /**
     * Return a cached clip + rest-pose part meshes for the given
     * `(setupId, mtableId, motionCommand, stance)`. First call kicks
     * `fetchKeyframes(...)` (the wasm export) and builds the clip;
     * subsequent calls with the same key return the same Promise.
     *
     * @param {number} setupId
     * @param {number} mtableId
     * @param {number} motionCommand
     * @param {number} stance
     * @param {Function} fetchKeyframes - the wasm-exported
     *   `fetchEntityAnimationKeyframes` (or a JS shim with the same
     *   shape). Called as
     *   `fetchKeyframes(setupId, modelChanges, textureChanges,
     *    paletteId, paletteSubsFlat, mtableId, motionCommand, stance)`.
     * @param {object} [opts] - optional substitution args, all default
     *   to empty arrays / 0 (`modelChanges`, `textureChanges`,
     *   `paletteId`, `paletteSubsFlat`).
     * @returns {Promise<{ clip: THREE.AnimationClip|null,
     *   partMeshes: any[], partCount: number, framerate: number,
     *   resolvedStance: number, restOrigins: Float32Array,
     *   restOrientations: Float32Array }>}
     *
     * Cohere-B (2026-05-12): `restOrigins` is `partCount * 3` floats
     * (x, y, z per part) and `restOrientations` is `partCount * 4`
     * floats in AC w-first order (qw, qx, qy, qz). The entity-rig
     * builder applies these to each `partGroup` at spawn so static
     * pose matches retail; the AnimationMixer overrides during cycle
     * playback with the model-space keyframe values from `clip`.
     * Part meshes are part-LOCAL (no placement baked in) — see
     * EntityAnimationData's struct doc in lib.rs.
     */
    async get(setupId, mtableId, motionCommand, stance, fetchKeyframes, opts = {}) {
        // 2026-05-18 motion-link experiment: when `opts.fromMotion` is
        // non-zero, fold it into the cache key so link-transition
        // clips and the underlying cycles get separate slots, and
        // pass it through to the wasm fetcher which will try the
        // MotionTable's Links table for the
        // `(stance, fromMotion → motionCommand)` transition before
        // falling back to the cycle lookup.
        const fromMotion = (opts.fromMotion ?? 0) >>> 0;
        const modelChanges = opts.modelChanges ?? new Uint32Array(0);
        const textureChanges = opts.textureChanges ?? new Uint32Array(0);
        const paletteId = (opts.paletteId ?? 0) >>> 0;
        const paletteSubsFlat = opts.paletteSubsFlat ?? new Uint32Array(0);
        // Wave 7.5: include substitutions in the key so different
        // equips on the same setup/motion/stance don't collide.
        const subSuffix = AnimationCache._substitutionSuffix(
            modelChanges, textureChanges, paletteId, paletteSubsFlat);
        const baseKey = AnimationCache.makeKey(setupId, mtableId, motionCommand, stance);
        const key = fromMotion === 0
            ? `${baseKey}${subSuffix}`
            : `${baseKey}:link:${fromMotion.toString(16)}${subSuffix}`;
        const hit = this.entries.get(key);
        if (hit) {
            // Wave 7.6 — move-to-tail on hit (strict LRU). JS Maps
            // preserve insertion order; delete + set re-inserts at
            // tail. O(1), no allocation. Safe even if `hit` is an
            // unresolved Promise — Promise refs are stable.
            this.entries.delete(key);
            this.entries.set(key, hit);
            return hit;
        }
        const promise = (async () => {

            const animData = await fetchKeyframes(
                setupId,
                modelChanges,
                textureChanges,
                paletteId,
                paletteSubsFlat,
                mtableId,
                motionCommand,
                stance,
                fromMotion,
            ).catch((e) => {
                try { window.__diag?.assets?.onAnimationError?.({ setupId, mtableId, motionCmd: motionCommand, stance, error: e, source: "get" }); } catch (_) {}
                throw e;
            });

            const partCount = animData.partCount >>> 0;
            const numFrames = animData.numFrames >>> 0;
            const framerate = +animData.framerate;
            const resolvedStance = animData.resolvedStance >>> 0;

            // First-call-per-setup: stash the partNames so future
            // bakes for other commands/stances reuse the same labels
            // (the rig's child names are determined once at rig-build
            // time in Phase 7.4b).
            let partNames = this.partNames.get(setupId);
            if (!partNames) {
                partNames = Array.from({ length: partCount }, (_, i) => `part_${i}`);
                this.partNames.set(setupId, partNames);
            }

            // Drain the rest-pose meshes here so the wasm-side
            // EntityAnimationData can be GC'd. JS holds the Float32
            // mesh data going forward; the entity rig builder
            // consumes it next.
            const partMeshes =
                typeof animData.takePartMeshes === "function"
                    ? animData.takePartMeshes()
                    : [];

            // 2026-05-16 — convert each wasm `ModelMesh` to three.js
            // `{ groups: [{ geometry, surfaceDid }], surfaceDids: [] }`
            // and free the wasm handle. Doing this ONCE per cache entry
            // (instead of per-spawn in entities.js::_spawnImpl) means:
            //   1. Multiple spawns of the same setupId share the SAME
            //      BufferGeometry objects (THREE.Mesh tolerates shared
            //      geometry — N meshes with the same geometry render
            //      correctly, each with its own transform/material).
            //   2. The race that caused "second spawn = bodyless NPC"
            //      (first spawn `.free()`'d the wasm handles, second
            //      spawn's `meshToGeometryGroups` returned empty)
            //      is gone — the wasm handles never leak past this
            //      cache promise.
            //   3. Per-setup work moves from O(spawnCount) to O(1).
            // Empty / null partMesh slots (raw GfxObjs whose Setup
            // declared a part the GfxObj wasn't actually present in,
            // or wasm bundles without `takePartMeshes`) yield an
            // empty `{ groups: [], surfaceDids: [] }` shim — entities.js
            // already handles that path.
            const partGroups = new Array(partMeshes.length);
            for (let p = 0; p < partMeshes.length; p += 1) {
                const partMesh = partMeshes[p];
                if (!partMesh) {
                    partGroups[p] = { groups: [], surfaceDids: [] };
                    continue;
                }
                try {
                    partGroups[p] = meshToGeometryGroups(partMesh);
                } catch (e) {
                    partGroups[p] = { groups: [], surfaceDids: [] };
                    try { window.__diag?.assets?.onMeshError?.({ partIndex: p, setupId, error: e }); } catch (_) {}
                }
                if (typeof partMesh.free === "function") {
                    try { partMesh.free(); } catch (_) {}
                }
            }

            // Read partFrames once (clones from wasm). After this,
            // animData is dead weight.
            const partFrames =
                typeof animData.partFrames === "object" &&
                animData.partFrames !== null
                    ? animData.partFrames
                    : (animData.partFrames ?? new Float32Array(0));

            // Render-completeness audit (2026-05-29) — root motion offset
            // track (clones from wasm). Empty / all-zero for cycles without
            // pos_frames (idle, walk/run); non-zero for one-shot translating
            // anims. Empty fallback handles older wasm bundles without the
            // `posFrames` getter (buildAnimationClip then applies no offset).
            const posFrames =
                typeof animData.posFrames === "object" &&
                animData.posFrames !== null
                    ? animData.posFrames
                    : new Float32Array(0);

            // Cohere-B (2026-05-12): clone the per-part rest pose
            // alongside partFrames. Cached together because rest pose
            // is a function of (setupId, mtableId, stance) — same
            // lifecycle as the clip. Empty fallback handles old wasm
            // builds without the new getters (callers see
            // length-0 typed arrays and skip the apply step).
            const restOrigins =
                typeof animData.restOrigins === "object" &&
                animData.restOrigins !== null
                    ? animData.restOrigins
                    : new Float32Array(0);
            const restOrientations =
                typeof animData.restOrientations === "object" &&
                animData.restOrientations !== null
                    ? animData.restOrientations
                    : new Float32Array(0);

            // T3 (2026-06-02): forward the wasm-provided per-frame
            // `frameTimes` + total `duration` to the clip builder. Previously
            // this call site DROPPED both, so every clip fell through to the
            // uniform `t = i/framerate` fallback using the AVERAGED framerate
            // (numFrames/duration). Single-segment cycles (idle/walk/run/Ready)
            // are identical either way, but a MotionData that chains multiple
            // AnimData (~23% of retail: swing windup→strike→recover→settle,
            // casts) has per-segment framerates AND signs — the averaged rate
            // plays every segment at the wrong relative speed. The wasm bake
            // (`build_concatenated_motion_frames`) already emits correct
            // cumulative per-frame times + total_duration; buildAnimationClip
            // already consumes them (animation.js:114-134, :204-212) and snaps
            // each non-uniform key via InterpolateDiscrete — we just stop
            // discarding the data. NOTE: non-uniform `frameTimes` REQUIRE the
            // discrete-interpolation path (animation.js:189/197) — a linear/
            // SLERP track over uneven times would interpolate poses across
            // segment boundaries the animators never authored.
            const frameTimes =
                typeof animData.frameTimes === "object" &&
                animData.frameTimes !== null
                    ? animData.frameTimes
                    : (animData.frameTimes ?? undefined);
            const duration = +animData.duration;
            let clip = null;
            if (numFrames > 0 && framerate > 0) {
                clip = buildAnimationClip(
                    {
                        partCount,
                        numFrames,
                        framerate,
                        partFrames,
                        posFrames,
                        // T3: stop dropping these two — the per-segment timing
                        // path keyed on them already exists in the builder.
                        frameTimes,
                        duration: Number.isFinite(duration) ? duration : undefined,
                    },
                    partNames,
                );
                if (clip) {
                    clip.name = key;
                }
            }

            // Task E (2026-05-12) — AnimationHook timeline drain.
            // The wasm `EntityAnimationData.takeHooks()` returns a
            // sorted-by-time list of `AnimationHookJs` entries baked
            // from each `AnimationFrame.hooks` in the resolved cycle.
            // Snapshot to plain JS POJOs IMMEDIATELY so the cache
            // doesn't hold stale wasm-bindgen handles past `.free()`
            // (the same lifetime hazard `EntityUpdate` has — see
            // `__scene3dCloneEntityUpdate` in index.html). Empty
            // fallback handles old wasm bundles without the getter
            // (callers see `hooks.length === 0` and the per-frame
            // executor skips this action's timeline entirely).
            let hooks = [];
            if (typeof animData.takeHooks === "function") {
                const raw = animData.takeHooks();
                hooks = new Array(raw.length);
                for (let i = 0; i < raw.length; i += 1) {
                    const h = raw[i];
                    // Snapshot each field through the wasm getter into
                    // a plain object — the wasm-bindgen handle gets
                    // freed below.
                    hooks[i] = {
                        time: +h.timeInClipS,
                        hookType: h.hookType >>> 0,
                        direction: h.direction | 0,
                        // Sound (1) + SoundTweaked (21) decoded fields.
                        soundWaveId: h.soundWaveId >>> 0,
                        soundEnum: h.soundEnum >>> 0,
                        soundProbability: +h.soundProbability,
                        soundVolume: +h.soundVolume,
                        soundPriority: +h.soundPriority,
                        // Wave 1 — particle hook decoded fields.
                        // CreateParticle (13) / CreateBlockingParticle (26):
                        // emitter info + Frame offset + per-script handle.
                        // DestroyParticle (14) / StopParticle (15): reuse
                        // `particleEmitterId` getter for the handle (it's
                        // hookType-aware on the Rust side).
                        // CallPES (19): pes_did + pes_pause.
                        emitterInfoId: h.emitterInfoId >>> 0,
                        createPartIndex: h.createPartIndex >>> 0,
                        offsetOriginX: +h.offsetOriginX,
                        offsetOriginY: +h.offsetOriginY,
                        offsetOriginZ: +h.offsetOriginZ,
                        offsetOrientationW: +h.offsetOrientationW,
                        offsetOrientationX: +h.offsetOrientationX,
                        offsetOrientationY: +h.offsetOrientationY,
                        offsetOrientationZ: +h.offsetOrientationZ,
                        particleEmitterId: h.particleEmitterId >>> 0,
                        callPesDid: h.callPesDid >>> 0,
                        callPesPause: +h.callPesPause,
                        // Wave 3 — material/transform/visibility hook fields.
                        // rampStart/End/Time cover Transparent (20),
                        // Luminous (8), Diffuse (10), TransparentPart (7),
                        // LuminousPart (9), DiffusePart (11), Scale (12).
                        // Scale has only end+time (rampStart is 0); all
                        // others have all three.
                        rampStart: +h.rampStart,
                        rampEnd: +h.rampEnd,
                        rampTime: +h.rampTime,
                        // Ethereal (6), NoDraw (16) — boolean-ish toggles.
                        etherealValue: h.etherealValue | 0,
                        noDrawValue: h.noDrawValue >>> 0,
                        // SetOmega (22) — angular velocity axis (rad/s).
                        omegaX: +h.omegaX,
                        omegaY: +h.omegaY,
                        omegaZ: +h.omegaZ,
                        // TextureVelocity (23) / TextureVelocityPart (24)
                        // — UV scroll velocity.
                        textureUSpeed: +h.textureUSpeed,
                        textureVSpeed: +h.textureVSpeed,
                        // SetLight (25) — boolean: lights on/off.
                        lightsOn: h.lightsOn | 0,
                        // Wave 4 — per-part variants + ReplaceObject.
                        // partIndex covers hooks 7/9/11/18/24 (sentinel
                        // `0xFFFFFFFF` for non-part-aware hooks).
                        // replacePartIndex + replaceNewGfxObjId cover
                        // ReplaceObject (5).
                        partIndex: h.partIndex >>> 0,
                        replacePartIndex: h.replacePartIndex >>> 0,
                        replaceNewGfxObjId: h.replaceNewGfxObjId >>> 0,
                    };
                    if (typeof h.free === "function") {
                        try { h.free(); } catch (_) {}
                    }
                }
            }

            return {
                clip,
                // Pre-converted three.js groups (one per part). Each
                // entry: `{ groups: [{geometry, surfaceDid}], surfaceDids: [] }`.
                // Shared across all consumers — see comment block above.
                partGroups,
                // Legacy field — present but always empty post-2026-05-16.
                // Kept so older capture scripts that destructure
                // `partMeshes` don't crash; production code uses
                // `partGroups`. The wasm handles are freed in the
                // conversion loop above.
                partMeshes: [],
                partCount,
                framerate,
                resolvedStance,
                restOrigins,
                restOrientations,
                hooks,
            };
        })();
        this.entries.set(key, promise);
        // pendingStartTimes sidecar for __diag.assets.stuck() — cleared
        // on both success and failure via Promise.then(both arms).
        this.pendingStartTimes.set(key, performance.now());
        // Wave 7.6 — clearing + eviction together. After the in-flight
        // Promise resolves we attempt eviction again, which catches
        // the boot-drain case where many fetches start concurrently:
        // at insert time every entry is still pending and the
        // eviction loop skips all of them; after each promise
        // resolves we re-check, and the just-resolved entry becomes
        // a valid eviction candidate.
        const _clearPending = () => {
            this.pendingStartTimes.delete(key);
            if (this.entries.size > this.maxEntries) {
                this._evictLruIfNeeded();
            }
        };
        promise.then(_clearPending, _clearPending);
        // First-pass eviction at insert time. Catches the common case
        // of cap+1 sequential miss-then-resolve in single-stepping
        // scenarios (one motion change, then another, then another).
        if (this.entries.size > this.maxEntries) {
            this._evictLruIfNeeded();
        }
        if (this.entries.size > this.sizeWatermark) {
            this.sizeWatermark = this.entries.size;
        }
        return promise;
    }

    /**
     * Wave 7.6 (2026-05-24) — evict LRU entries until size is at or
     * below maxEntries. Walks `entries` in insertion order (which the
     * `get(...)` hit path moves-to-tail on every hit, so head = LRU)
     * and deletes the first key that is NOT in `pendingStartTimes`
     * (an in-flight Promise; evicting would cause duplicate fetches
     * for concurrent callers). Stops when size <= maxEntries OR when
     * a full pass found nothing to evict (all remaining entries are
     * in flight — the cap effectively becomes maxEntries + max-
     * pending-concurrent-fetches, which is still bounded).
     *
     * Cache geometries held in evicted entries are NOT disposed here.
     * Live entities still reference them via `inst.geometries` (cache-
     * shared, no `__disposable` tag). When the last entity using a
     * geometry despawns + GC runs, the geometry is reclaimed. The
     * `EntityInstance.dispose` FU3 guard ensures we never dispose
     * cache geometries prematurely.
     *
     * @private
     */
    _evictLruIfNeeded() {
        // Wave 2 / R3 fix (2026-05-28) — capture peak entry count before
        // eviction trims it back, so `getStats().watermark` actually
        // reflects how high the cache pressed against `maxEntries`.
        if (this.entries.size > this.sizeWatermark) {
            this.sizeWatermark = this.entries.size;
        }
        let evicted = 0;
        for (const key of this.entries.keys()) {
            if (this.entries.size <= this.maxEntries) break;
            if (this.pendingStartTimes.has(key)) continue;
            this.entries.delete(key);
            evicted += 1;
            // Defensive: if the caller has a sidecar map keyed by the
            // same string, future versions might want to clear it
            // here. partNames is keyed by setupId (not by cache key),
            // so we don't touch it — multiple cache entries for the
            // same setup share one partNames entry; eviction of one
            // shouldn't disturb the others.
        }
        this.evictionCount += evicted;
    }

    /**
     * Wave 7.6 — observability snapshot. Used by `scene3d/diag/assets.js`
     * via read-through from `EntityManager.animationCache.getStats()`.
     */
    getStats() {
        return {
            size: this.entries.size,
            max: this.maxEntries,
            pending: this.pendingStartTimes.size,
            evictions: this.evictionCount,
            watermark: this.sizeWatermark,
        };
    }

    /**
     * F.40 (2026-05-14) — batch-prewarm the wasm-side `shards`
     * cache for `setupIds`. ONE
     * `fetchEntityAnimationKeyframesBatch(union_of_unique_setupIds)`
     * call walks each Setup → default MotionTable → default
     * Animations in a single iterative prefetch loop, populating
     * `ManifestResourceSource::shards` for every transitive record.
     * Subsequent single-call `AnimationCache.get(...)` invocations
     * for those setupIds hit a warm cache and complete sync-fast
     * (no further HTTP round-trips).
     *
     * **Use case.** The spawn pipeline (`scene3d/spawns.js`'s
     * `ensureSpawnsForLandblock`) calls `getBatch` BEFORE dispatching
     * the N synthetic-spawn events. Each subsequent
     * `entityManager.spawn(meta)` then hits a warm cache. F.36 measured
     * 25 unique setups × 4-19s per cold walk = 100-475s; F.40's
     * batched walk drops the wall-clock to one prefetch loop's worth
     * of round-trips total.
     *
     * @param {number[]|Uint32Array} setupIds - the union of setupIds
     *   to pre-warm. Duplicates + already-prewarmed IDs are filtered
     *   out internally. Empty input is a no-op.
     * @param {Function} fetchKeyframesBatch - the wasm-exported
     *   `fetchEntityAnimationKeyframesBatch` (or a JS shim with the
     *   same shape). Called as `fetchKeyframesBatch(Uint32Array)`,
     *   resolves to an `EntityAnimationKeyframesBatch` wasm handle.
     * @returns {Promise<{prewarmedCount: number, skippedCount: number}>}
     *   resolves after the batch call completes. `prewarmedCount`
     *   is the number of newly-warmed setupIds; `skippedCount` is
     *   how many requested IDs were already in `prewarmedSetupIds`
     *   (no-op on those — they were warm from a prior batch).
     *
     * **Idempotency.** Re-calling for the same setupIds is cheap —
     * `prewarmedSetupIds` filters them out and the wasm batch sees
     * an empty Uint32Array (early-return on its side too).
     *
     * **Lifetime.** The batch's `EntityAnimationData` payloads are
     * drained and `.free()`'d here — JS doesn't hold wasm handles
     * past this call. The cache entries themselves still get
     * populated lazily via the normal `get(...)` path; the win is
     * that those `get(...)` calls now hit a warm wasm-side cache.
     */
    async getBatch(setupIds, fetchKeyframesBatch) {
        if (typeof fetchKeyframesBatch !== "function") {
            // eslint-disable-next-line no-console
            console.warn(
                "[scene3d.animation] getBatch: fetchEntityAnimationKeyframesBatch missing; falling back to lazy single-call path"
            );
            return { prewarmedCount: 0, skippedCount: 0 };
        }
        // Dedup + filter already-warmed IDs.
        const requested = new Set();
        for (const raw of setupIds || []) {
            const id = (raw >>> 0);
            if (id !== 0) requested.add(id);
        }
        let skippedCount = 0;
        const fresh = [];
        for (const id of requested) {
            if (this.prewarmedSetupIds.has(id)) {
                skippedCount += 1;
            } else {
                fresh.push(id);
            }
        }
        if (fresh.length === 0) {
            return { prewarmedCount: 0, skippedCount };
        }

        // Sorted-union key for in-flight dedup. Two concurrent
        // getBatch calls with the SAME fresh set share one wasm
        // round-trip; with overlapping sets the second call still
        // hits the dedup map if every element is already in flight
        // (else, the partial overlap proceeds with the freshly-not-
        // in-flight slice — the prewarmedSetupIds set ensures we
        // never double-count finished entries).
        fresh.sort((a, b) => a - b);
        const dedupKey = fresh.join(",");
        let inFlight = this._batchInFlight.get(dedupKey);
        if (!inFlight) {
            inFlight = (async () => {
                // Mark BEFORE the await — concurrent getBatch calls
                // for the same setupIds skip rather than re-fire.
                // On the (rare) error path we rollback below.
                for (const id of fresh) {
                    this.prewarmedSetupIds.add(id);
                }
                let batch;
                try {
                    batch = await fetchKeyframesBatch(new Uint32Array(fresh));
                } catch (e) {
                    try { window.__diag?.assets?.onAnimationError?.({ setupIds: fresh, error: e, source: "getBatch" }); } catch (_) {}
                    // Roll back so a retry can re-attempt.
                    for (const id of fresh) {
                        this.prewarmedSetupIds.delete(id);
                    }
                    throw e;
                }
                // Drain + free each payload. The wasm-side `shards`
                // cache is already populated by the batch's
                // prefetch loop; we don't need the EntityAnimationData
                // structs to live past this drain. The actual
                // cache entries land lazily via subsequent get(...)
                // calls on the now-warm shards.
                try {
                    const len = batch.len >>> 0;
                    for (let i = 0; i < len; i += 1) {
                        const payload = batch.payloadAt(i);
                        if (payload && typeof payload.free === "function") {
                            try { payload.free(); } catch (_) {}
                        }
                    }
                } finally {
                    if (typeof batch.free === "function") {
                        try { batch.free(); } catch (_) {}
                    }
                }
                return { prewarmedCount: fresh.length, skippedCount };
            })();
            this._batchInFlight.set(dedupKey, inFlight);
            // Clean up the dedup map after settle (success or fail)
            // so a future getBatch for the same set after a flake
            // can retry. The prewarmedSetupIds set is the
            // authoritative warm-state cache — _batchInFlight is
            // purely the concurrent-call coalescer.
            inFlight.finally(() => {
                if (this._batchInFlight.get(dedupKey) === inFlight) {
                    this._batchInFlight.delete(dedupKey);
                }
            });
        }
        return inFlight;
    }

    /**
     * Drop every cached clip. Call when the renderer tears down the
     * scene (page navigation, ?renderer flip, etc.). The
     * AnimationClips are owned by mixers across multiple entities
     * — disposing those is the mixer-owner's job; this only drops
     * the cache's own references so the GC can reclaim them once
     * the mixers also let go.
     */
    dispose() {
        this.entries.clear();
        this.partNames.clear();
        this.prewarmedSetupIds.clear();
        this._batchInFlight.clear();
    }
}
