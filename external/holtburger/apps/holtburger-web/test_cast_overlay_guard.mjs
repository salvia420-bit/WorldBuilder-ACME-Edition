// `?castOverlayGuard` (WS03) — local cast persistence across movement.
//
// Owner report 2026-08-01: "The animation doesn't continue when side-strafing
// etc — kind of breaks the animation client side, on our own side. The sort of
// animation breaking that is desirable is on how others perceive us — not
// breaking our own animation."
//
// ## The break (all in OUR client, nothing to do with the wire)
//
// The local cast gesture is installed by `setSwingMotion`, which stamps it as
// `inst.currentAction` (entities.js ~8489) and ramps the base locomotion cycle
// to weight 0 via `_suppressBaseCycleForOverlay`.
//
// Any drive change then re-issues a locomotion command through `setMotion` —
// including a PURE STRAFE, because the forward axis stays 0 and the kind-61
// `DriveApplied` consumer (index.html, default-ON `?cmdInterp`) maps forward==0
// to Ready 0x41000003. `setMotion`'s tail is `inst.crossFadeTo(action, key, 0)`,
// whose hard-cut branch (`CROSSFADE_S === 0`) runs `this.currentAction.stop()`
// — i.e. it stops the cast gesture.
//
// ## Retail does not do this
//
//   * `CMotionTable::GetObjectSequence` MOVEMENT branch: `clear_physics` +
//     `remove_cyclic_anims` (acclient.c:337795-337796), never `clear_animations`.
//   * `CSequence::remove_cyclic_anims` (acclient.c:340154) starts at
//     `first_cyclic`, so one-shot link anims queued BEFORE it survive.
//   * `remove_redundant_links` (acclient.c:330079) aborts its backward
//     truncation scan on any queued action with anims.
//   * Sidestep reaches that same movement branch via
//     `CMotionInterp::apply_interpreted_movement` (acclient.c:344178).
//
// So a strafe can never cancel an in-flight gesture in retail. (Forward is a
// different story only because a cast gesture is a SubState-class command that
// owns the single forward slot — `InterpretedMotionState::ApplyMotion`
// acclient.c:332759/:332890 — which is the deliberate `?castMove` anim-break we
// keep, and which observers never see because it is client-side.)
//
// ## What is asserted here
//
//   PART 1 — DEFAULT (flag absent): a locomotion base swap under an ACTIVE cast
//            overlay does NOT stop the overlay; the new base is installed
//            underneath it at weight 0 and `_locoCycleKey` is repointed.
//   PART 2 — `?castOverlayGuard=off`: the pre-flip behaviour is preserved
//            byte-for-byte (the overlay IS stopped) — the rollback escape works.
//   PART 3 — a same-cycle re-issue (the `use_time` pump reclaim between windups)
//            is a clean no-op that leaves the overlay running.
//   PART 4 — swap-safe restore: after a mid-cast base swap, completing the
//            overlay restores the CURRENT `_locoCycleKey`, not the originally
//            captured base action.
//   PART 5 — the forward-edge anim-break (`cancelCastSequence`) still HARD-CUTS
//            the overlay — retail fastcast is intentionally kept.
//
// Splice harness: same pattern as test_a5_p3_root_motion.mjs (locate `three`,
// strip the relative imports, eval the module bodies together). SKIPs (exit 0)
// when `three` can't be located.
//
// Run:  cd apps/holtburger-web/ && node test_cast_overlay_guard.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

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
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) {}
  return null;
}
const threePath = locateThree();
if (!threePath) {
  console.log("castOverlayGuard test: SKIP (three not located).");
  process.exit(0);
}
const threeMod = await import("file://" + threePath);
const THREE = threeMod.Object3D ? threeMod : (threeMod.default ?? threeMod);

// ---- splice ----------------------------------------------------------
function loadModule(relPath) {
  const full = resolvePath(__dirname, relPath);
  let src = readFileSync(full, "utf8");
  // Strip EVERY static import (single- and multi-line, trailing comments and
  // all) — the spliced modules are concatenated by hand instead. Dynamic
  // `await import(...)` is untouched: it never starts a line with `import` +
  // whitespace.
  return src
    .replace(/^[ \t]*import\s[\s\S]*?from\s+["'][^"']+["'];.*$/gm, "")
    .replace(/^[ \t]*import\s+["'][^"']+["'];.*$/gm, "")
    // `import.meta.url` is a module-only form; the only use is inside
    // `_prewarmCanonicalCastScripts`, which this test never calls.
    .replace(/import\.meta\.url/g, '"file:///__spliced__"');
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
/** Every static-import name a spliced module referenced. */
function importedNames(relPath) {
  const src = readFileSync(resolvePath(__dirname, relPath), "utf8");
  const out = new Set();
  const re = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1].trim();
    const braces = /\{([\s\S]*?)\}/.exec(spec);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const id = part.trim().split(/\s+/).pop();
        if (/^[A-Za-z_$][\w$]*$/.test(id ?? "")) out.add(id);
      }
    }
    const lead = spec.split("{")[0].replace(/\*\s+as\s+/, "").replace(/,$/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(lead)) out.add(lead);
  }
  return out;
}

const spliced =
  "// === adapter.js ===\n" + stripExports(loadModule("scene3d/adapter.js")) + "\n" +
  "// === animation.js ===\n" + stripExports(loadModule("scene3d/animation.js")) + "\n" +
  "// === entities.js ===\n" + stripExports(loadModule("scene3d/entities.js")) + "\n";

// Anything entities.js/animation.js imported that the splice does NOT itself
// define gets a permissive recursive stub. None of them are on any code path
// this test drives (setMotion's pre-seeded-action route, the overlay guard, and
// cancelCastSequence); they exist only so the module body evaluates.
const wanted = new Set([
  ...importedNames("scene3d/entities.js"),
  ...importedNames("scene3d/animation.js"),
  ...importedNames("scene3d/adapter.js"),
]);
wanted.delete("THREE");
const missing = [...wanted].filter(
  (n) => !new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?(?:function|class|const|let|var)\\s+${n}\\b`).test(spliced),
);
const stubPrelude =
  "const __mkStub = () => new Proxy(function () {}, {\n" +
  "  get: (t, k) => (k === Symbol.toPrimitive || k === 'then' ? undefined : __mkStub()),\n" +
  "  apply: () => __mkStub(),\n" +
  "});\n" +
  missing.map((n) => `const ${n} = __mkStub();`).join("\n") + "\n";

const composite =
  stubPrelude + spliced +
  "; return { EntityManager, EntityInstance, AnimationCache, CAST_OVERLAY_GUARD };";
const factory = new Function("THREE", "performance", "window", composite);

const GUID = 0x71001234 >>> 0;
const SETUP_ID = 0x02000001 >>> 0;
const MTABLE_ID = 0x09000001 >>> 0;
const MAGIC_STANCE = 0x80000049 >>> 0;
const CMD_READY = 0x41000003 >>> 0;
const CMD_WALK_FORWARD = 0x45000005 >>> 0;

/** Build a fresh spliced world with a given `?search`. */
function makeWorld(search) {
  const fakeWindow = {
    location: { search },
    __lastEntityWorldPos: new Map(),
    getLocalPlayerGuid: () => GUID,
    __diag: {},
  };
  const mod = factory(THREE, globalThis.performance ?? { now: () => Date.now() }, fakeWindow);
  return { mod, fakeWindow };
}

/** A trivial 1-track clip so THREE.AnimationAction has something real to run. */
function makeClip(name, dur) {
  const track = new THREE.VectorKeyframeTrack(
    ".position", [0, dur], [0, 0, 0, 0, 1, 0],
  );
  return new THREE.AnimationClip(name, dur, [track]);
}

/**
 * Hand-build the EntityInstance + EntityManager state that a live local cast
 * reaches: an active cast overlay as `currentAction`, suppressing a base
 * locomotion cycle whose key is `_locoCycleKey`.
 *
 * Every locomotion action `setMotion` might resolve is PRE-SEEDED into
 * `inst.actions` under the real `AnimationCache.makeKey`, so setMotion never
 * touches the wasm keyframe fetch.
 */
function makeCastingRig(mod) {
  const { EntityManager, EntityInstance, AnimationCache } = mod;
  const root = new THREE.Object3D();
  const mixer = new THREE.AnimationMixer(root);
  const meta = {
    modelId: SETUP_ID, setupId: SETUP_ID, mtableId: MTABLE_ID,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    paletteId: 0, subPalettes: new Uint32Array(0),
  };
  const inst = new EntityInstance(GUID, root, [], mixer, meta);
  inst.currentStance = MAGIC_STANCE;
  inst.lastStance = MAGIC_STANCE;
  // 0 => setMotion skips the from-motion link probe (which would need wasm).
  inst.lastMotionCommand = 0;

  const em = new EntityManager({ scene: new THREE.Scene() }, {});
  em.entityMap.set(GUID, inst);

  const keyFor = (cmd) => AnimationCache.makeKey(SETUP_ID, MTABLE_ID, cmd >>> 0, MAGIC_STANCE);
  const readyKey = keyFor(CMD_READY);
  const walkKey = keyFor(CMD_WALK_FORWARD);

  // Pre-seed both locomotion cycles so the cache-miss branch never runs.
  const readyAction = mixer.clipAction(makeClip("ready", 1.0));
  readyAction.setLoop(THREE.LoopRepeat, Infinity);
  readyAction.setEffectiveWeight(1.0);
  readyAction.play();
  inst.actions.set(readyKey, readyAction);

  const walkAction = mixer.clipAction(makeClip("walk", 1.0));
  walkAction.setLoop(THREE.LoopRepeat, Infinity);
  inst.actions.set(walkKey, walkAction);

  // The cast overlay: LoopOnce, currentAction, suppressing the Ready base.
  const overlayKey = "swing:10000132:49"; // MagicPowerUp08Purple in Magic stance
  const overlay = mixer.clipAction(makeClip("MagicPowerUp08Purple", 3.676));
  overlay.setLoop(THREE.LoopOnce, 1);
  overlay.clampWhenFinished = true;
  overlay.setEffectiveWeight(1.0);
  overlay.enabled = true;
  overlay.play();
  inst.actions.set(overlayKey, overlay);
  inst.currentAction = overlay;
  inst.currentActionKey = overlayKey;
  inst._locoCycleKey = readyKey;
  em._suppressBaseCycleForOverlay(inst, overlay);

  return { em, inst, overlay, overlayKey, readyKey, walkKey, readyAction, walkAction, mixer };
}

console.log("===========================================================");
console.log("?castOverlayGuard — local cast persistence across movement");
console.log("===========================================================");

// ---------------------------------------------------------------------
// PART 0 — the flag default itself.
// ---------------------------------------------------------------------
console.log("\nPART 0 — flag default");
{
  check("absent param => DEFAULT-ON", makeWorld("").mod.CAST_OVERLAY_GUARD === true);
  check("?castOverlayGuard=off => OFF", makeWorld("?castOverlayGuard=off").mod.CAST_OVERLAY_GUARD === false);
  check("?castOverlayGuard=on => ON", makeWorld("?castOverlayGuard=on").mod.CAST_OVERLAY_GUARD === true);
  check(
    "an unrelated flag does not turn it off",
    makeWorld("?wireframe=1").mod.CAST_OVERLAY_GUARD === true,
  );
}

// ---------------------------------------------------------------------
// PART 1 — DEFAULT: a strafe-driven base swap must NOT stop the cast.
// ---------------------------------------------------------------------
console.log("\nPART 1 — default: base swap under an active cast overlay");
{
  const { mod } = makeWorld("");
  const rig = makeCastingRig(mod);
  check("precondition: overlay running + suppressing the base", rig.overlay.isRunning() && rig.inst._baseSuppressAction === rig.overlay);
  check("precondition: base cycle ramped to weight 0", rig.readyAction.getEffectiveWeight() === 0);

  // A strafe edge: forward axis is 0, so the kind-61 DriveApplied consumer
  // re-issues Ready. This is the exact call index.html makes.
  await rig.em.setMotion(GUID, CMD_READY, MAGIC_STANCE);
  check("cast overlay SURVIVES the strafe-driven base re-issue", rig.overlay.isRunning());
  check("overlay is still currentAction", rig.inst.currentAction === rig.overlay);

  // A walk edge under the same cast (base cycle genuinely CHANGES).
  await rig.em.setMotion(GUID, CMD_WALK_FORWARD, MAGIC_STANCE);
  check("cast overlay SURVIVES a walk base swap too", rig.overlay.isRunning());
  check(
    "the new base is installed UNDER the overlay at weight 0",
    rig.walkAction.isRunning() && rig.walkAction.getEffectiveWeight() === 0,
    `running=${rig.walkAction.isRunning()} w=${rig.walkAction.getEffectiveWeight()}`,
  );
  check("_locoCycleKey repointed to the new base", rig.inst._locoCycleKey === rig.walkKey);
  check("the superseded base cycle was stopped", !rig.readyAction.isRunning());
}

// ---------------------------------------------------------------------
// PART 2 — the =off rollback escape reproduces the reported break.
// ---------------------------------------------------------------------
console.log("\nPART 2 — ?castOverlayGuard=off preserves the pre-flip behaviour");
{
  const { mod } = makeWorld("?castOverlayGuard=off");
  const rig = makeCastingRig(mod);
  check("precondition: overlay running", rig.overlay.isRunning());
  await rig.em.setMotion(GUID, CMD_WALK_FORWARD, MAGIC_STANCE);
  check(
    "flag OFF: the base swap STOPS the cast overlay (the reported bug)",
    !rig.overlay.isRunning(),
    "if this passes, =off is a true byte-identical rollback",
  );
}

// ---------------------------------------------------------------------
// PART 3 — same-cycle re-issue (use_time pump reclaim between windups).
// ---------------------------------------------------------------------
console.log("\nPART 3 — same-cycle re-issue is a clean no-op");
{
  const { mod } = makeWorld("");
  const rig = makeCastingRig(mod);
  const before = rig.readyAction.getEffectiveWeight();
  await rig.em.setMotion(GUID, CMD_READY, MAGIC_STANCE);
  await rig.em.setMotion(GUID, CMD_READY, MAGIC_STANCE);
  check("overlay still running after repeated same-cycle re-issues", rig.overlay.isRunning());
  check("_locoCycleKey unchanged", rig.inst._locoCycleKey === rig.readyKey);
  check("base stays suppressed (weight unchanged)", rig.readyAction.getEffectiveWeight() === before);
}

// ---------------------------------------------------------------------
// PART 4 — swap-safe restore on overlay completion.
// ---------------------------------------------------------------------
console.log("\nPART 4 — swap-safe base-weight restore");
{
  const { mod } = makeWorld("");
  const rig = makeCastingRig(mod);
  await rig.em.setMotion(GUID, CMD_WALK_FORWARD, MAGIC_STANCE);
  // Overlay completes naturally. `_completeOverlay` is the ?hookDrain owner of
  // overlay-end work; it must restore whatever `_locoCycleKey` points at NOW
  // (the walk cycle installed mid-cast), not the Ready action captured at
  // suppression time.
  rig.em._completeOverlay(rig.inst, rig.overlayKey, rig.overlay, true);
  check(
    "the CURRENT base cycle got its weight back",
    rig.walkAction.getEffectiveWeight() === 1.0,
    `walk w=${rig.walkAction.getEffectiveWeight()}`,
  );
  check("suppression bookkeeping cleared", rig.inst._baseSuppressAction === null);
  check("the stale captured base was NOT revived", !rig.readyAction.isRunning());
}

// ---------------------------------------------------------------------
// PART 5 — the forward-edge anim-break is intentionally KEPT.
// ---------------------------------------------------------------------
console.log("\nPART 5 — forward-edge anim-break still cuts (retail fastcast)");
{
  const { mod } = makeWorld("");
  const rig = makeCastingRig(mod);
  check("precondition: overlay running", rig.overlay.isRunning());
  // index.html fires this on a forward-axis PRESS edge inside the cast-busy
  // window (the classic invisible animation break — local-only; observers keep
  // watching the full cast because the server only rate-checks).
  rig.em.cancelCastSequence(GUID, "anim-break");
  check(
    "cancelCastSequence HARD-CUTS the overlay",
    !rig.overlay.isRunning(),
    "a forward tap must still break our own gesture — that is retail fastcast",
  );
  check("suppression bookkeeping cleared on cancel", rig.inst._baseSuppressAction === null);
}

console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("castOverlayGuard tests FAILED.");
  process.exit(1);
}
console.log("All castOverlayGuard tests PASS.");
