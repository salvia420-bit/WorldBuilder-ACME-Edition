// A5-P2 (unification survey 2026-06-11) — `?tweenClock=dt` headless test.
//
// One clock domain for the four hook-side-effect tweens (`_tickSwingTween` /
// `_tickJumpPoseTween` / `_tickCastTween` / `_tickScaleHookTween`). Retail
// clocks every animation side effect off the single physics quantum in ONE
// update pass (CSequence::update_internal, acclient.c:340659-340780, on the
// `Timer::cur_time` static, acclient.c:46992); ours mixed clamped-dt mixers
// with `performance.now()` wall-clock tweens (A5 divergence #8).
//
// This is the ROADMAP-required "2s-gap phase test": simulate a tab-throttle —
// wall clock jumps 2000ms while the loop delivers only small clamped dts —
// and assert tween phase equals MIXER phase (advanced by accumulated dt),
// not wall phase, when the flag is on; and that the legacy wall behavior is
// byte-preserved when off.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_a5_p2_tween_clock.mjs
//
// Same THREE-resolution + module-splice dance as
// test_phase7_4b_entity_pipeline.mjs (the factory's `performance` and
// `window` params let us inject a controllable wall clock + URL flag).

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stripStaticImports } from "./harness/lib/splice_module.mjs";
import { entitiesToplevelPrelude, entitiesCtorPrelude } from "./harness/lib/scene3d_stubs.mjs";

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
    const candidates = [];
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
    console.log("A5-P2 tween-clock test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_a5_p2_tween_clock.mjs`");
    process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("A5-P2 — ?tweenClock=dt one-clock-domain test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- splice harness (phase7_4b precedent) ----------------------------
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    if (!existsSync(full)) throw new Error(`module not found: ${full}`);
    let src = readFileSync(full, "utf8");
    // Shared tolerant stripper (2026-10-05): the hand-rolled regexes missed
    // `import {...} from "..."; // trailing comment` lines in entities.js.
    return stripStaticImports(src).replace(/import\.meta\.url/g, '"file:///__spliced__"');
}
function stripExports(src) {
    return src
        .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const RIG_STUBS =
    "const readRigModuleFlag = () => false;\n" +
    "const applyRestPoseFrame = () => { throw new Error('rigModule stubbed'); };\n" +
    "const buildPartSurfaceMeshes = () => { throw new Error('rigModule stubbed'); };\n" +
    "const createPartFramesProxy = () => { throw new Error('rigModule stubbed'); };\n";
const UI_STUBS =
    "const drainPendingPlayEffects = () => {};\n" +
    "const showSpeechBubbleOnEntity = () => {};\n" +
    "const removeSpeechBubbleFromEntity = () => {};\n" +
    "const ensureNameplateForEntity = () => {};\n";
const PARTICLE_CLOCK_STUB = "const particleClockMode = () => \"off\";\n";
// A11-S2: entities.js imports the ?particleOwner facade (stripped import
// from ./particles/owner_registry.js); flag-off = legacy per-guid map path
// (the facade itself is covered by test_particle_owner.mjs).
const PARTICLE_OWNER_STUB =
    "const particleOwnerOn = () => false;\n" +
    "const ownerRegistry = { addEmitter: async () => 0, destroyEmitter: () => false, " +
    "stopEmitter: () => false, destroySome: () => 0, destroyAllForOwner: () => 0, " +
    "ownerKeys: () => [][Symbol.iterator]() };\n";

const entitiesRaw = readFileSync(resolvePath(__dirname, "scene3d/entities.js"), "utf8");
const composite = PARTICLE_CLOCK_STUB + PARTICLE_OWNER_STUB + RIG_STUBS + UI_STUBS +
    // module-top-level reader calls other than readRigModuleFlag (stubbed above)
    entitiesToplevelPrelude(["readRigModuleFlag"]) + entitiesCtorPrelude() +
    "// === adapter.js ===\n" + stripExports(loadModule("scene3d/adapter.js")) + "\n" +
    "// === animation.js ===\n" + stripExports(loadModule("scene3d/animation.js")) + "\n" +
    "// === entities.js ===\n" + stripExports(loadModule("scene3d/entities.js")) + "\n" +
    "; return { EntityManager };";
const factory = new Function("THREE", "performance", "window", composite);

// Controllable wall clock shared by every manager in this test.
let wallMs = 100000;
const fakePerf = { now: () => wallMs };

function makeManager(search) {
    const win = search === undefined
        ? undefined
        : { location: { search } };
    const { EntityManager } = factory(THREE, fakePerf, win);
    const entitiesGroup = new THREE.Group();
    return new EntityManager({ entitiesGroup, materialCache: null }, {});
}

// Fabricate a 16-part humanoid rig shape (indices 10/13 upper arms,
// 1/5 upper legs are the ones the jump/swing/cast tweens touch).
function makeHumanInst(guid) {
    const root = new THREE.Object3D();
    const parts = [];
    for (let i = 0; i < 16; i += 1) {
        const p = new THREE.Object3D();
        parts.push(p);
        root.add(p);
    }
    return { guid: guid >>> 0, root, parts, _baseScale: 1.0 };
}

const EPS = 1e-9;

// =====================================================================
console.log("[1] source wiring asserts");
{
    const tickerWall = (entitiesRaw.match(/Tween\(inst, performance\.now\(\)\)/g) || []).length;
    check("no ticker call site reads performance.now()", tickerWall === 0, `found ${tickerWall}`);
    const tickerDt = (entitiesRaw.match(/Tween\(inst, this\._tweenNowMs\(\)\)/g) || []).length;
    // WS-B teardown (2026-06-18): the swing + cast vibe-pose tweens
    // (setSwingPose / setCastPose + their tickers) were RETIRED in favour of
    // the Rust motion authority — 2 tickers (jump + scale) remain.
    check("both remaining ticker call sites (jump + scale) read _tweenNowMs()", tickerDt === 2, `found ${tickerDt}`);
    const stampWall = (entitiesRaw.match(/startMs: performance\.now\(\)/g) || []).length;
    check("no tween startMs stamps performance.now()", stampWall === 0, `found ${stampWall}`);
    const stampDt = (entitiesRaw.match(/startMs: this\._tweenNowMs\(\)/g) || []).length;
    check("all 5 stamp sites use _tweenNowMs() (4 jump + scale; swing/cast retired)",
        stampDt === 5, `found ${stampDt}`);
    check("tick(dt) advances the accumulated clock by dt*1000",
        /this\._tweenClockMs \+= dt \* 1000;/.test(entitiesRaw));
}

// =====================================================================
console.log("[2] gate parse matrix (factory window injection)");
{
    wallMs = 100000;
    const off = makeManager(undefined);          // no window at all
    const offJunk = makeManager("?tweenClock=on"); // wrong value — only "dt" arms
    const on = makeManager("?tweenClock=dt");
    const onCase = makeManager("?tweenClock=DT");  // case-insensitive parse
    // Advance dt clocks 80ms, then jump the wall 2000ms: a dt-clocked
    // manager reads seed+80, a wall-clocked manager reads the new wall.
    for (const m of [off, offJunk, on, onCase]) {
        for (let i = 0; i < 5; i += 1) m.tick(0.016);
    }
    wallMs += 2000;
    check("default (no window) → wall clock", Math.abs(off._tweenNowMs() - wallMs) < EPS,
        `${off._tweenNowMs()} vs wall ${wallMs}`);
    check("?tweenClock=on (junk value) → wall clock",
        Math.abs(offJunk._tweenNowMs() - wallMs) < EPS);
    check("?tweenClock=dt → accumulated-dt clock", Math.abs(on._tweenNowMs() - 100080) < 1e-6,
        `${on._tweenNowMs()} vs 100080`);
    check("?tweenClock=DT (case-insensitive) → dt clock",
        Math.abs(onCase._tweenNowMs() - 100080) < 1e-6);
}

// =====================================================================
console.log("[3] dt-clock advance law");
{
    wallMs = 100000;
    const em = makeManager("?tweenClock=dt");
    const t0 = em._tweenNowMs();
    for (let i = 0; i < 5; i += 1) em.tick(0.016);
    check("5 × tick(0.016) advances exactly 80ms", Math.abs(em._tweenNowMs() - t0 - 80) < 1e-6,
        `${em._tweenNowMs() - t0}`);
    const t1 = em._tweenNowMs();
    wallMs += 2000;
    check("2s wall jump does NOT move the dt clock", Math.abs(em._tweenNowMs() - t1) < EPS);
    em.tick(0); em.tick(-1); em.tick(NaN);
    check("tick(0)/tick(-1)/tick(NaN) do not advance", Math.abs(em._tweenNowMs() - t1) < EPS);
    check("dt clock is seeded from wall at construction", Math.abs(t0 - 100000) < EPS,
        `${t0}`);
}

// =====================================================================
console.log("[4] tween phase == mixer phase (the unification contract)");
{
    wallMs = 100000;
    const em = makeManager("?tweenClock=dt");
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const t0 = em._tweenNowMs();
    const dts = [0.016, 0.033, 0.1, 0.007, 0.05]; // irregular clamped frames
    for (const dt of dts) {
        em.tick(dt);
        mixer.update(dt);
        wallMs += 500; // wall races ahead every frame (throttled tab)
    }
    const tweenElapsedS = (em._tweenNowMs() - t0) / 1000;
    check("accumulated tween clock equals mixer.time after irregular dts",
        Math.abs(tweenElapsedS - mixer.time) < 1e-9,
        `tween ${tweenElapsedS}s vs mixer ${mixer.time}s (wall raced ${dts.length * 500}ms)`);
}

// =====================================================================
console.log("[5] 2s-gap phase test — jump pose (human)");
{
    wallMs = 100000;
    const em = makeManager("?tweenClock=dt");
    const inst = makeHumanInst(0x100);
    em._applyHumanJumpPose(inst); // 200ms tween
    check("startMs stamped from the dt clock (not the wall)",
        Math.abs(inst._jumpPoseTween.startMs - em._tweenNowMs()) < EPS);
    wallMs += 2000; // tab throttle: wall jumps 2s...
    em.tick(0.1);   // ...but the loop only delivers 100ms of clamped dt
    em._tickJumpPoseTween(inst, em._tweenNowMs());
    check("after 2s wall gap + 100ms dt, tween still ACTIVE at t=0.5",
        inst._jumpPoseTween !== null);
    // eased(0.5) = 1 - 0.5^3 = 0.875 → arm strictly between start and target.
    const arm = inst.parts[13];
    const target = inst._jumpPoseTween.to.get(13);
    const from = inst._jumpPoseTween.from.get(13);
    check("arm quaternion is mid-slerp (≠ start, ≠ target)",
        !arm.quaternion.equals(target) && !arm.quaternion.equals(from),
        `angleTo(target)=${arm.quaternion.angleTo(target).toFixed(4)}`);
    em.tick(0.15); // accumulate past 200ms total
    em._tickJumpPoseTween(inst, em._tweenNowMs());
    check("tween completes once ACCUMULATED dt crosses 200ms",
        inst._jumpPoseTween === null && arm.quaternion.equals(target));
    check("takeoff completion stamps _airborneStablishedMs from the dt clock",
        Math.abs(inst._airborneStablishedMs - em._tweenNowMs()) < EPS);
}

// =====================================================================
console.log("[6] 2s-gap phase test — jump pose (generic)");
{
    wallMs = 100000;
    const em = makeManager("?tweenClock=dt");
    const inst = makeHumanInst(0x101);
    em._applyGenericJumpPose(inst); // 200ms, scale 1.0 → 1.08
    wallMs += 2000;
    em.tick(0.1);
    em._tickJumpPoseTween(inst, em._tweenNowMs());
    // eased(0.5)=0.875 → scaleZ = 1 + 0.08*0.875 = 1.07
    check("generic tween mid-phase at t=0.5 (scale.z ≈ 1.07)",
        inst._jumpPoseTween !== null && Math.abs(inst.root.scale.z - 1.07) < 1e-9,
        `scale.z=${inst.root.scale.z}`);
    em.tick(0.15);
    em._tickJumpPoseTween(inst, em._tweenNowMs());
    check("generic tween completes on accumulated dt",
        inst._jumpPoseTween === null);
    check("airborne tilt locked at tween-in completion", inst.airborneTilt !== null);
}

// =====================================================================
console.log("[7] swing/cast vibe-pose tweens stay retired (WS-B 2026-06-18)");
{
    const em = makeManager("?tweenClock=dt");
    check("setSwingPose retired (Rust motion authority owns swings)", typeof em.setSwingPose !== "function");
    check("setCastPose retired (Rust motion authority owns casts)", typeof em.setCastPose !== "function");
}

// =====================================================================
console.log("[9] 2s-gap phase test — scale hook (hookType 12)");
{
    wallMs = 100000;
    const em = makeManager("?tweenClock=dt");
    const inst = makeHumanInst(0x104);
    em._fireHook(inst, { hookType: 12, rampEnd: 2.0, rampTime: 0.4, direction: 0 }, null, null);
    const tw = inst._scaleHookTween;
    check("scale-hook startMs stamped from the dt clock",
        tw && Math.abs(tw.startMs - em._tweenNowMs()) < EPS,
        tw ? `startMs=${tw.startMs}` : "no tween");
    wallMs += 2000;
    em.tick(0.2); // half of 400ms → linear t=0.5 → scale 1.5
    em._tickScaleHookTween(inst, em._tweenNowMs());
    check("scale mid-phase 1.5 after 200ms accumulated dt",
        inst._scaleHookTween !== null && Math.abs(inst.root.scale.x - 1.5) < 1e-9,
        `scale.x=${inst.root.scale.x}`);
    em.tick(0.25);
    em._tickScaleHookTween(inst, em._tweenNowMs());
    check("scale snaps to 2.0 + clears on accumulated dt",
        inst._scaleHookTween === null && Math.abs(inst.root.scale.x - 2.0) < 1e-9);
}

// =====================================================================
console.log("[10] flag OFF — legacy wall-clock behavior byte-preserved");
{
    wallMs = 100000;
    const em = makeManager(undefined);
    const instJ = makeHumanInst(0x200);
    em._applyHumanJumpPose(instJ);
    check("OFF: startMs is the wall clock", Math.abs(instJ._jumpPoseTween.startMs - wallMs) < EPS);
    const instK = makeHumanInst(0x203);
    em._fireHook(instK, { hookType: 12, rampEnd: 2.0, rampTime: 0.4, direction: 0 }, null, null);
    // 2s wall gap with only 1ms of loop dt: wall-clocked tweens all complete
    // immediately (the legacy desync this flag exists to fix).
    wallMs += 2000;
    em.tick(0.001);
    em._tickJumpPoseTween(instJ, em._tweenNowMs());
    em._tickScaleHookTween(instK, em._tweenNowMs());
    check("OFF: jump tween completed on the wall gap", instJ._jumpPoseTween === null);
    check("OFF: scale tween snapped to end on the wall gap",
        instK._scaleHookTween === null && Math.abs(instK.root.scale.x - 2.0) < 1e-9);
}

// =====================================================================
console.log("=========================");
console.log(`A5-P2 tween-clock test: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
