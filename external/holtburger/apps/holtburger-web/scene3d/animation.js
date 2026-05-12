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
    const { partCount, numFrames, framerate, partFrames } = animData;

    if (
        typeof partCount !== "number" ||
        typeof numFrames !== "number" ||
        typeof framerate !== "number"
    ) {
        throw new TypeError(
            `buildAnimationClip: animData must carry numeric partCount/numFrames/framerate; got ${typeof partCount}/${typeof numFrames}/${typeof framerate}`
        );
    }
    if (numFrames === 0 || framerate <= 0) {
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

    // Times array — same for every track. Frame i lands at i / framerate
    // seconds. Uniform timing is the correct AC semantics.
    //
    // F#13 (animation framerate variance) — AUDIT RESULT: close-as-NIL.
    // The AC data model carries framerate per-cycle, not per-frame.
    // Verified against three independent sources on 2026-05-10:
    //   1. crates/holtburger-dat/src/file_type/motion_table.rs:138-154 —
    //      `AnimData { anim_id, low_frame, high_frame, framerate: f32 }`.
    //      One f32 framerate per (stance, command) cycle. No per-frame
    //      timing.
    //   2. crates/holtburger-dat/src/file_type/animation.rs:15-23 +
    //      crates/holtburger-dat/src/file_type/setup_model.rs:129-149 —
    //      `Animation { num_frames, part_frames: Vec<AnimationFrame> }`
    //      and `AnimationFrame { frames: Vec<Frame>, hooks: Vec<...> }`.
    //      `Frame { origin: Vector3, orientation: Quaternion }`. No
    //      time/delta/duration field anywhere in the per-frame record.
    //   3. external/ACE/Source/ACE.Server/Physics/Animation/AnimData.cs
    //      + external/DatReaderWriter/.../AnimationTests.cs — ACE and
    //      DatReaderWriter both model `AnimData` with exactly the same
    //      four fields. No per-frame timing in either ref impl.
    // AC's `AnimationHook` payloads (sounds, particles, attack cones)
    // also carry no time data — hooks are attached to a specific frame
    // index, played as that frame is rendered.
    // Therefore: uniform `times[i] = i / framerate` IS the authoritative
    // AC semantics. There is no judder source from this code — any
    // observed judder would be a different bug (mixer step size,
    // crossFade timing, dt accumulation in the rAF loop).
    const times = new Float32Array(numFrames);
    const dt = 1.0 / framerate;
    for (let f = 0; f < numFrames; f += 1) {
        times[f] = f * dt;
    }

    const tracks = [];
    for (let p = 0; p < partCount; p += 1) {
        const posValues = new Float32Array(numFrames * 3);
        const quatValues = new Float32Array(numFrames * 4);
        for (let f = 0; f < numFrames; f += 1) {
            const base =
                (f * partCount + p) * FLOATS_PER_PART_PER_FRAME;
            // (x, y, z) — copied straight through.
            posValues[f * 3 + 0] = flat[base + 0];
            posValues[f * 3 + 1] = flat[base + 1];
            posValues[f * 3 + 2] = flat[base + 2];
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

    const duration = numFrames / framerate;
    return new THREE.AnimationClip("", duration, tracks);
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
        this.entries = new Map();
        // setupId → string[] (computed on first bake; reused for every
        // future stance/command on the same setup).
        this.partNames = new Map();
    }

    /**
     * Build the cache key. Mirrors the 2D path's cycle bake key shape.
     */
    static makeKey(setupId, mtableId, motionCommand, stance) {
        return `${setupId >>> 0}:${mtableId >>> 0}:${motionCommand >>> 0}:${stance >>> 0}`;
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
        const key = AnimationCache.makeKey(setupId, mtableId, motionCommand, stance);
        const hit = this.entries.get(key);
        if (hit) return hit;
        const promise = (async () => {
            const modelChanges = opts.modelChanges ?? new Uint32Array(0);
            const textureChanges = opts.textureChanges ?? new Uint32Array(0);
            const paletteId = (opts.paletteId ?? 0) >>> 0;
            const paletteSubsFlat = opts.paletteSubsFlat ?? new Uint32Array(0);

            const animData = await fetchKeyframes(
                setupId,
                modelChanges,
                textureChanges,
                paletteId,
                paletteSubsFlat,
                mtableId,
                motionCommand,
                stance,
            );

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

            // Read partFrames once (clones from wasm). After this,
            // animData is dead weight.
            const partFrames =
                typeof animData.partFrames === "object" &&
                animData.partFrames !== null
                    ? animData.partFrames
                    : (animData.partFrames ?? new Float32Array(0));

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

            let clip = null;
            if (numFrames > 0 && framerate > 0) {
                clip = buildAnimationClip(
                    { partCount, numFrames, framerate, partFrames },
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
                    };
                    if (typeof h.free === "function") {
                        try { h.free(); } catch (_) {}
                    }
                }
            }

            return {
                clip,
                partMeshes,
                partCount,
                framerate,
                resolvedStance,
                restOrigins,
                restOrientations,
                hooks,
            };
        })();
        this.entries.set(key, promise);
        return promise;
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
    }
}
