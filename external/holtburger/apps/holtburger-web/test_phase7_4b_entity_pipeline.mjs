// Phase 7.4b — synthetic end-to-end test for the EntityManager
// pipeline, using mocked wasm exports so the JS-side rig builder +
// the motion-playhead flow can be exercised without a live ACE session.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_phase7_4b_entity_pipeline.mjs
//
// Same THREE-resolution dance as test_phase7_4a_animation_clip.mjs:
//   - THREE_PATH env var to point at three.module.js
//   - Walk Playwright's npx cache for `three` if env var unset
//   - SKIP gracefully if three can't be found (smoke check is the
//     mandatory floor; this test is the functional half)
//
// What this exercises:
//   1. Create EntityManager with a mocked wasmExports object that
//      stubs `fetchEntityAnimationKeyframes` (returns synthetic
//      4-part 8-frame walk + 8-frame run keyframes), `fetch_surfaces_pixels`
//      (returns tiny RGBA8), and `fetchEntitySurfacesPixels` (same
//      RGBA8 shape with palette overlay).
//   2. Drive the pipeline through a wire-shape sequence:
//      - kind=1 SPAWN (motion=0 idle) → assert rig built (root +
//        N parts), no action playing yet.
//      - kind=4 VELOCITY → assert no error, vel stashed.
//      - kind=5 MOTION (cmd=WALK_FORWARD) → assert walkAction is
//        playing after the cache fetch resolves.
//      - kind=5 MOTION (cmd=RUN_FORWARD) → assert crossFade lands;
//        currentAction switches to runAction.
//      - kind=5 MOTION (cmd=STOP) → assert currentAction goes null.
//      - kind=2 REMOVE → assert entityMap.size === 0.
//   3. Tick the manager between each step and assert mixer.time
//      advances when an action is playing.
//
// The drainEntityEvents3D path is exercised separately (smoke check
// asserts the regex; live capture closes the loop on real wire data).

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stripStaticImports } from "./harness/lib/splice_module.mjs";
import { entitiesToplevelPrelude } from "./harness/lib/scene3d_stubs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
    else passed += 1;
}

// ---- locate `three` --------------------------------------------------
function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        return process.env.THREE_PATH;
    }
    try {
        return require.resolve("three");
    } catch (_) {}
    const candidates = [
        joinPath(process.env.HOME ?? "", ".npm/_npx/e41f203b7505f1fb/node_modules/three"),
    ];
    try {
        const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
        if (existsSync(npxRoot)) {
            const fs = require("node:fs");
            for (const dir of fs.readdirSync(npxRoot)) {
                candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
            }
        }
    } catch (_) {}
    for (const c of candidates) {
        const idx = joinPath(c, "build/three.module.js");
        if (existsSync(idx)) return idx;
    }
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("Phase 7.4b entity-pipeline ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_phase7_4b_entity_pipeline.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import("three"); // same instance entities.js imports

console.log("Phase 7.4b — entity-pipeline standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// 2026-10-05 — entities.js / animation.js / adapter.js are IMPORTED as real ES
// modules instead of text-spliced into new Function(). The splice rotted on
// every new import (module-top-level reader calls, then spawn-path helpers
// such as recolor_flag.js gatePaletteId), and a growing hand-stub list made
// the spawn path partly fake. Verified 2026-10-05: the whole entities.js
// module graph imports headless in Node, so the GENUINE code runs. `three`
// is imported by the same bare specifier the app uses, so THREE below is the
// SAME instance entities.js builds with (instanceof checks hold).
const __entMod = await import("./scene3d/entities.js");
const __animMod = await import("./scene3d/animation.js");
const __adapterMod = await import("./scene3d/adapter.js");
const factoryEnv = { ...__adapterMod, ...__animMod, ...__entMod };
const { EntityManager, AnimationCache, buildAnimationClip } = factoryEnv;
// The Rust MotionSequence playhead is the ONLY animation driver (the three.js
// AnimationMixer was retired 2026-10-05); a pure-JS stand-in for the wasm class
// lets the genuine spawn/setMotion/tick plumbing run headless.
import { installFakeMotionSequence } from "./harness/lib/fake_motion_sequence.mjs";
installFakeMotionSequence();

// ---- Mock wasm exports ----------------------------------------------
//
// fetchEntityAnimationKeyframes returns 4-part 8-frame keyframes; the
// frame layout is `[(x,y,z, qw,qx,qy,qz) per part] per frame`.
// Different motion commands produce different keyframe Y values so we
// can spot-check that the right clip is playing later.
const PART_COUNT = 4;
const NUM_FRAMES = 8;
const FRAMERATE = 30.0;

function buildSyntheticKeyframes(yOffset) {
    const flat = new Float32Array(NUM_FRAMES * PART_COUNT * 7);
    for (let f = 0; f < NUM_FRAMES; f += 1) {
        for (let p = 0; p < PART_COUNT; p += 1) {
            const base = (f * PART_COUNT + p) * 7;
            // x, y, z — y carries the yOffset so we can tell walk vs run apart
            flat[base + 0] = p * 0.1;
            flat[base + 1] = yOffset + f * 0.05;
            flat[base + 2] = p * 0.05;
            // qw, qx, qy, qz — identity (no rotation animation in this fixture)
            flat[base + 3] = 1; // qw
            flat[base + 4] = 0; // qx
            flat[base + 5] = 0; // qy
            flat[base + 6] = 0; // qz
        }
    }
    return flat;
}

function makePartMesh(partIdx) {
    // ModelMesh-shaped object the meshToGeometryGroups adapter consumes.
    // 1 triangle per part; surfaceIndex 0 → surfaceDid 0x08001234.
    return {
        triCount: 1,
        positions: new Float32Array([
            partIdx * 1.0, 0.0, 0.0,
            partIdx * 1.0 + 0.5, 0.0, 0.0,
            partIdx * 1.0 + 0.25, 0.5, 0.0,
        ]),
        uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
        // T6 (2026-05-28): per-vertex normals — 9 floats/tri (3 distinct
        // normals), no longer a single broadcast face normal (was [0,0,1]).
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        surfaceIndices: new Uint8Array([0]),
        surfaces: new Uint32Array([0x08001234]),
    };
}

let keyframeFetchCount = 0;
let surfacePixelsFetchCount = 0;
let entitySurfacePixelsFetchCount = 0;

const mockWasmExports = {
    async fetchEntityAnimationKeyframes(
        setupId,
        modelChanges,
        textureChanges,
        paletteId,
        paletteSubsFlat,
        mtableId,
        motionCommand,
        stance
    ) {
        keyframeFetchCount += 1;
        const cmdLow = motionCommand & 0xffff;
        // Idle (cmd=0 or stop=0x0004): no animation. Returns
        // partMeshes for rest pose + numFrames=0 so the cache skips
        // clip build.
        const isIdle = motionCommand === 0 || cmdLow === 0x0004;
        const isWalk = cmdLow === 0x0005 || cmdLow === 0x0006;
        const isRun = cmdLow === 0x0007;
        const yOffset = isRun ? 100 : isWalk ? 50 : 0;
        const numFrames = isIdle ? 0 : NUM_FRAMES;
        const flat = isIdle ? new Float32Array(0) : buildSyntheticKeyframes(yOffset);

        const partMeshes = [];
        for (let p = 0; p < PART_COUNT; p += 1) {
            partMeshes.push(makePartMesh(p));
        }
        return {
            partCount: PART_COUNT,
            numFrames,
            framerate: isIdle ? 0.0 : FRAMERATE,
            resolvedStance: stance || 0x0000003d, // NonCombat default
            partFrames: flat,
            takePartMeshes() {
                // One-shot drain. Subsequent calls return [].
                const out = partMeshes.splice(0);
                return out;
            },
        };
    },
    async fetch_surfaces_pixels(surfaceDids) {
        surfacePixelsFetchCount += 1;
        const out = [];
        for (let i = 0; i < surfaceDids.length; i += 1) {
            // Tiny 2x2 RGBA8 (red square) — enough to build a DataTexture.
            const px = new Uint8Array([
                255, 0, 0, 255,
                255, 0, 0, 255,
                255, 0, 0, 255,
                255, 0, 0, 255,
            ]);
            out.push({ pixels: px, width: 2, height: 2 });
        }
        return out;
    },
    async fetchEntitySurfacesPixels(surfaceDids, basePaletteId, subPalettes) {
        entitySurfacePixelsFetchCount += 1;
        const out = [];
        for (let i = 0; i < surfaceDids.length; i += 1) {
            // Slight tint variation so the entity-owned texture is
            // distinguishable from the cache-shared one.
            const px = new Uint8Array([
                0, 255, 0, 255,
                0, 255, 0, 255,
                0, 255, 0, 255,
                0, 255, 0, 255,
            ]);
            out.push({ pixels: px, width: 2, height: 2 });
        }
        return out;
    },
};

// ---- Mock scene3d shape ----------------------------------------------
const entitiesGroup = new THREE.Group();
entitiesGroup.name = "entities";
const mockScene3d = {
    entitiesGroup,
    materialCache: null, // EntityManager handles the no-cache fallback
};

const em = new EntityManager(mockScene3d, mockWasmExports);
check("EntityManager constructed", !!em, `entityMap.size=${em.entityMap.size}`);

// ---- Test 1: SPAWN (motion=0 idle) ----------------------------------
const TEST_GUID = 0x12345678;
const TEST_SETUP = 0x02000099;
const TEST_MTABLE = 0x09000001;

const meta = {
    guid: TEST_GUID,
    modelId: TEST_SETUP,
    landblockId: 0xa9b40001 >>> 0,
    x: 50, y: 60, z: 70,
    qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0,
    mtableId: TEST_MTABLE,
    motionCommand: 0,
    motionStance: 0,
    objScale: 1.0,
    name: "TestGolem",
    wcid: 12698,
    itemType: 0x10, // Creature
    iconId: 0,
    modelChanges: new Uint32Array(0),
    textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
};

const inst = await em.spawn(meta);
check(
    "spawn() returned EntityInstance",
    !!inst,
    `inst=${!!inst}, entityMap.size=${em.entityMap.size}`
);
check(
    "entityMap holds entity by GUID",
    em.entityMap.has(TEST_GUID),
    `has=${em.entityMap.has(TEST_GUID)}`
);
check(
    "entity root parented under entitiesGroup",
    inst?.root?.parent === entitiesGroup,
    `parent=${inst?.root?.parent?.name}`
);
check(
    "entity root has expected name",
    inst?.root?.name === `entity_${TEST_GUID.toString(16).padStart(8, "0")}`,
    `name=${inst?.root?.name}`
);
check(
    "entity rig has PART_COUNT part children",
    inst?.parts?.length === PART_COUNT,
    `parts=${inst?.parts?.length}, expected=${PART_COUNT}`
);
check(
    "each part group is named part_${i}",
    inst?.parts?.every((p, i) => p.name === `part_${i}`),
    `names=${inst?.parts?.map((p) => p.name).join(",")}`
);

// World coords: lbX=0xa9, lbY=0xb4 → wx = 0xa9 * 192 + 50 = 32498,
// wy = 0xb4 * 192 + 60 = 34620, wz = 70.
const expectedWx = 0xa9 * 192 + 50;
const expectedWy = 0xb4 * 192 + 60;
check(
    "entity root.position has world coords (LB-converted)",
    Math.abs(inst.root.position.x - expectedWx) < 1e-3 &&
        Math.abs(inst.root.position.y - expectedWy) < 1e-3 &&
        Math.abs(inst.root.position.z - 70) < 1e-3,
    `pos=(${inst.root.position.x}, ${inst.root.position.y}, ${inst.root.position.z}), ` +
        `expected=(${expectedWx}, ${expectedWy}, 70)`
);

check(
    "no AnimationMixer on the rig (retired — the Rust playhead drives it)",
    inst.mixer === undefined,
    `mixer=${inst.mixer}`
);
check(
    "no playhead cycle after idle spawn (motion=0 → no clip → rest pose)",
    inst._unifiedLoco == null && inst.currentActionKey === null,
    `loco=${!!inst._unifiedLoco}, key=${inst.currentActionKey}`
);

// ---- Test 2: kind=4 VELOCITY ----------------------------------------
em.setVelocity({
    guid: TEST_GUID,
    vx: 1.0, vy: 0.5, vz: 0, omegaZ: 0.1,
});
check(
    "setVelocity stamps lastVel without throwing",
    inst.lastVel?.vx === 1.0 && inst.lastVel?.vy === 0.5,
    `lastVel=${JSON.stringify(inst.lastVel)}`
);

// ---- Test 3: kind=5 MOTION = WALK_FORWARD ----------------------------
const WALK_CMD = 0x4500_0005;
const RUN_CMD = 0x4400_0007;
const STOP_CMD = 0x4500_0004;

await em.setMotion(TEST_GUID, WALK_CMD, 0x003d); // NonCombat
check(
    "setMotion(WALK_FORWARD) installed the walk cycle on the playhead",
    !!inst._unifiedLoco,
    `loco=${!!inst._unifiedLoco}`
);

const walkActionKey = inst.currentActionKey;
const walkLoco = inst._unifiedLoco;
check(
    "walk currentActionKey carries WALK_CMD encoding",
    typeof walkActionKey === "string" && walkActionKey === `33554585:150994945:${WALK_CMD >>> 0}:61`,
    `walkActionKey=${walkActionKey}`
);

// Tick; the playhead should advance and pose the rig from the walk clip.
em.tick(0.05);
em.tick(0.05);
em.tick(0.05);
check(
    "walk playhead advances after tick(dt) calls",
    walkLoco.seq.phase > 0,
    `phase=${walkLoco.seq.phase}`
);
check(
    "rig posed from the walk keyframes (part y in the walk band)",
    inst.parts[0].position.y >= 50 && inst.parts[0].position.y < 51,
    `y=${inst.parts[0].position.y}`
);

// ---- Test 4: kind=5 MOTION = RUN_FORWARD (cycle swap) ----------------
await em.setMotion(TEST_GUID, RUN_CMD, 0x003d);
check(
    "setMotion(RUN_FORWARD) swapped the playhead cycle",
    inst._unifiedLoco && inst._unifiedLoco !== walkLoco,
    `same=${inst._unifiedLoco === walkLoco}`
);
check("previous cycle's sequence freed", walkLoco.seq.__wbg_ptr === 0);
const runActionKey = inst.currentActionKey;
check(
    "run currentActionKey != walk currentActionKey",
    runActionKey !== walkActionKey,
    `runKey=${runActionKey}, walkKey=${walkActionKey}`
);
em.tick(0.1);
check(
    "rig posed from the run keyframes",
    inst.parts[0].position.y >= 100,
    `y=${inst.parts[0].position.y}`
);

// ---- Test 5: idempotent setMotion (same cmd) ------------------------
const beforeSwitchCount = em.motionSwitchCount;
await em.setMotion(TEST_GUID, RUN_CMD, 0x003d);
check(
    "setMotion(same RUN cmd) is a no-op (no extra switch)",
    em.motionSwitchCount === beforeSwitchCount,
    `before=${beforeSwitchCount}, after=${em.motionSwitchCount}`
);

// ---- Test 6: kind=5 MOTION = STOP ------------------------------------
// STOP (cmdLow 0x0004) / Invalid (0x0000) is SUBSTITUTED to Ready (0x0003) so
// the stance-aware idle cycle plays (combat pose survives releasing W) instead
// of a bare rest pose.
await em.setMotion(TEST_GUID, STOP_CMD, 0x003d);
const READY_CMD = (STOP_CMD & 0xFFFF0000) | 0x0003;
check(
    "setMotion(STOP) substitutes the stance Ready idle cycle",
    inst.currentActionKey === `33554585:150994945:${READY_CMD >>> 0}:61`,
    `key=${inst.currentActionKey}`
);

// ---- Test 7: re-entering WALK lands on the walk cycle again ---------
await em.setMotion(TEST_GUID, WALK_CMD, 0x003d);
const walkKey = `33554585:150994945:${WALK_CMD >>> 0}:61`;
check(
    "re-entering WALK plays the walk cycle again",
    inst.currentActionKey === walkKey,
    `currentActionKey=${inst.currentActionKey}`
);

// ---- Test 8: kind=2 REMOVE -------------------------------------------
em.remove(TEST_GUID);
check(
    "remove() drops from entityMap",
    em.entityMap.size === 0,
    `entityMap.size=${em.entityMap.size}`
);
check(
    "remove() detaches root from entitiesGroup",
    !inst.root.parent || inst.root.parent !== entitiesGroup,
    `parent=${inst.root.parent?.name}`
);

// ---- Test 9: respawn after remove ------------------------------------
const inst2 = await em.spawn({ ...meta, motionCommand: WALK_CMD });
check(
    "respawn after remove builds a fresh rig",
    !!inst2 && inst2 !== inst,
    `inst2=${!!inst2}, sameAsOld=${inst2 === inst}`
);
check(
    "respawn puts the WALK spawn motion straight onto the playhead",
    !!inst2._unifiedLoco && inst2.currentActionKey === `33554585:150994945:${WALK_CMD >>> 0}:61`,
    `loco=${!!inst2._unifiedLoco}, key=${inst2.currentActionKey}`
);
em.remove(TEST_GUID);

// ---- Test 10: dispose() -----------------------------------------------
const inst3 = await em.spawn(meta);
em.dispose();
check(
    "dispose() empties entityMap",
    em.entityMap.size === 0,
    `entityMap.size=${em.entityMap.size}`
);

// ---- Summary ----------------------------------------------------------
console.log("=========================");
console.log(
    `keyframe fetches: ${keyframeFetchCount}, ` +
    `surface fetches: ${surfacePixelsFetchCount}, ` +
    `entity-surface fetches: ${entitySurfacePixelsFetchCount}`
);
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Phase 7.4b synthetic checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
