// test_cloud_overlay_dispose.mjs — gate for #28 (single-owner cloud dispose).
//
// CloudOverlay.dispose() and CloudVolume.dispose() previously could
// double-dispose the takram CloudsEffect: EffectComposer.dispose() disposes
// all its passes (including the EffectPass that wraps the CloudsEffect),
// AND CloudVolume.dispose() also calls effect.dispose(). The fix (Option A):
//   - CloudOverlay detaches the EffectPass (composer.removePass) BEFORE
//     composer.dispose() so the composer never disposes the cloud effect.
//   - CloudVolume becomes the SOLE owner that disposes the effect, and nulls
//     `this.effect` FIRST so a re-entrant dispose() is a no-op.
//
// The real CloudOverlay/CloudVolume can't be imported here (they pull in
// @takram/three-clouds, not vendored for node). This test models the exact
// dispose contract with mocks that mirror the real dispose() bodies + a
// counting effect + an order-recording composer.
//
// Run from apps/holtburger-web:
//   node test_cloud_overlay_dispose.mjs

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("== #28 single-owner cloud dispose ==");

// --- Test doubles ----------------------------------------------------

// Counting effect: how many times dispose() was called.
function makeCountingEffect() {
  return {
    disposed: 0,
    dispose() { this.disposed += 1; },
  };
}

// Order-recording composer. dispose() disposes each remaining pass (mirrors
// pmndrs EffectComposer.dispose disposing its passes); removePass detaches a
// pass so a subsequent dispose() will NOT dispose it.
function makeComposer(events) {
  return {
    passes: [],
    addPass(p) { this.passes.push(p); },
    removePass(p) {
      events.push("removePass");
      const i = this.passes.indexOf(p);
      if (i >= 0) this.passes.splice(i, 1);
    },
    dispose() {
      events.push("composer.dispose");
      // EffectComposer.dispose disposes every still-attached pass, which
      // (for an EffectPass) disposes the wrapped effect.
      for (const p of this.passes) p.dispose?.();
    },
  };
}

// EffectPass wrapping the cloud effect — its dispose() disposes the effect
// (this is the double-dispose hazard the fix avoids).
function makeEffectPass(effect) {
  return { dispose() { effect.dispose(); } };
}

// Mock CloudVolume.dispose() — copy of scene3d/cloud_volume.js dispose():
// null this.effect FIRST (re-entry safety), then dispose the captured ref.
function makeVolume(effect) {
  return {
    effect,
    material: {},
    _lastState: {},
    dispose() {
      const e = this.effect;
      this.effect = null;
      this.material = null;
      this._lastState = null;
      if (e && typeof e.dispose === "function") e.dispose();
    },
  };
}

// Mock CloudOverlay.dispose() — copy of scene3d/cloud_overlay.js dispose():
// detach the cloud EffectPass from the composer BEFORE composer.dispose(),
// then dispose the volume (sole owner of the effect).
function makeOverlay(volume, composer, cloudEffectPass) {
  return {
    overlayMesh: { geometry: { dispose() {} } },
    overlayMaterial: { dispose() {} },
    _stbnTex: { dispose() {} },
    volume,
    composer,
    _cloudEffectPass: cloudEffectPass,
    dispose() {
      try {
        this.overlayMesh.geometry.dispose();
        this.overlayMaterial.dispose();
        this._stbnTex?.dispose?.();
        if (this.composer && this._cloudEffectPass) {
          this.composer.removePass(this._cloudEffectPass);
        }
        this.composer?.dispose?.();
        this.volume.dispose();
      } catch (err) {
        this.lastError = String(err);
      }
    },
  };
}

// --- 1. Normal CloudOverlay-style dispose → effect disposed EXACTLY once.
{
  const events = [];
  const effect = makeCountingEffect();
  const composer = makeComposer(events);
  const renderPass = { dispose() {} };
  const cloudEffectPass = makeEffectPass(effect);
  composer.addPass(renderPass);
  composer.addPass(cloudEffectPass);

  const volume = makeVolume(effect);
  const overlay = makeOverlay(volume, composer, cloudEffectPass);
  overlay.dispose();

  check(
    "effect disposed exactly once after overlay.dispose()",
    effect.disposed === 1,
    `effect.disposed=${effect.disposed}`
  );
  // Option A: removePass must precede composer.dispose() so the composer
  // never disposes the cloud effect.
  const iRemove = events.indexOf("removePass");
  const iDispose = events.indexOf("composer.dispose");
  check(
    "removePass called BEFORE composer.dispose() (Option A ordering)",
    iRemove >= 0 && iDispose >= 0 && iRemove < iDispose,
    `events=[${events.join(", ")}]`
  );
  check(
    "volume.effect nulled after dispose (single-owner teardown)",
    volume.effect === null,
    `volume.effect=${volume.effect}`
  );

  // --- 2. A second volume.dispose() must NOT re-dispose the effect.
  volume.dispose();
  check(
    "re-entrant volume.dispose() keeps effect.disposed at 1",
    effect.disposed === 1,
    `effect.disposed=${effect.disposed}`
  );
}

// --- 3. Sanity: WITHOUT the removePass detach (old behavior), the composer
//        would dispose the effect AND the volume would too → 2 (proves the
//        fix is load-bearing).
{
  const events = [];
  const effect = makeCountingEffect();
  const composer = makeComposer(events);
  const cloudEffectPass = makeEffectPass(effect);
  composer.addPass(cloudEffectPass);
  const volume = makeVolume(effect);
  // Old-style dispose: composer.dispose() THEN volume.dispose(), no detach.
  composer.dispose();
  volume.dispose();
  check(
    "control: without detach, effect is double-disposed (2) — confirms hazard",
    effect.disposed === 2,
    `effect.disposed=${effect.disposed}`
  );
}

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log(`PASS: ${passed}/${passed} cloud-dispose ownership checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
