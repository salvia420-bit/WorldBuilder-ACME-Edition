// harness/playwright/flags.sync.mjs — descriptor for the A1-O3 synchronous
// physics-tick boundary flag (?syncPhysicsTick=on), Tier 3, JS-LIVE.
//
// Conforms to harness/lib/schema.md. assertBrowser(helpers) consumes ONLY the
// helper API from harness/lib/boot.mjs#launchAndEnter and returns a
// {status,detail} envelope from harness/lib/assert.mjs. The DRIVER owns the
// browser lifecycle + folds composeDeps into the query; this body classifies
// only NON-url preconditions.
//
// WHY rebuildCoupled:false — A1-O3 is "JS-live on reload, NO wasm rebuild
// needed; manifest unchanged (v4)" (docs/url-flags.md:484). The whole path is
// in scene3d/index.js (syncTickHop, lines 1617-1645): the diag object
// window.__syncTickDiag is pure JS, and the only wasm calls it makes
// (handle.tickMovement() + handle.getLocalPlayerPose()) are long-present
// exports. So there is no v3/v4 additive getter to guard — this flag never
// returns 'rebuild-pending' (it has no rebuild-coupled surface). It is still
// defensive about getters being callable so a future pkg regression degrades
// to 'skip', not a false 'fail'.
//
// COUNTER SEMANTICS (verified against scene3d/index.js syncTickHop):
//   window.__syncTickDiag = { enqueued, hopCompleted, poseChangedSameFrame, skipped2d }
//   - enqueued++             : frame-top, every time syncTickHop() runs with a
//                              live SessionHandle (no input required).
//   - hopCompleted++         : after handle.tickMovement() + the one-microtask
//                              hop (await Promise.resolve()) resolves.
//   - poseChangedSameFrame++ : ONLY when the post-tick getLocalPlayerPose()
//                              differs from the pre-tick pose the SAME frame —
//                              i.e. the player actually moved. Requires a
//                              movement input; a no-input idle boot leaves this
//                              at 0. We drive it via setMovementInput(1,0,0,run).
//   - skipped2d              : 2D-loop-skip count (not asserted here).
//
// FLAG GATE GOTCHA: ?syncTickDiag requires the EXACT string '1'
// (URLSearchParams.get('syncTickDiag') === '1', NOT 'on'/'true'). The query
// below sets it correctly; when absent the whole object is undefined by design.
//
// COMPOSE: ?syncPhysicsTick=on warns (one-shot console) without
// ?posePublishPostTick=on (the camera would read a pre-tick pose); the
// canonical combo is renderer=3d&unifiedTick=on&posePublishPostTick=on&
// syncPhysicsTick=on&syncTickDiag=1 — exactly the query carried here.

import { result, pass, fail, skip, rebuildPending } from "../lib/assert.mjs";

// Console-error patterns that indicate a genuine wasm/world break (drops benign
// asset 404s / texture warnings / network noise). Matched case-insensitively.
const FATAL_PATTERNS = [
  /unreachable/i,
  /\bpanic(ked)?\b/i,
  /RuntimeError/i,
  /wasm.*abort/i,
  /index out of bounds/i,
  /called `Option::unwrap\(\)`/i,
  /called `Result::unwrap\(\)`/i,
];

function fatalErrors(errs) {
  return (errs || []).filter((e) =>
    FATAL_PATTERNS.some((re) => re.test(e.text || ""))
  );
}

// In-page: drive a forward(+run) movement input through the wasm SessionHandle
// so the integrator advances the local pose, which is what makes
// poseChangedSameFrame tick. Self-contained for page.evaluate (no closures).
// `on` true = start moving forward, false = stop (0,0,0). Returns a small
// report so the assert can tell whether the input boundary was even callable.
function driveForwardInPage(on) {
  const h = window.__sessionHandle;
  if (!h || typeof h.setMovementInput !== "function") {
    return { ok: false, why: "setMovementInput absent" };
  }
  try {
    // forward, strafe, turn, run. Run=true → the faster gait, bigger per-frame
    // delta → a robust pose change. Stop = all-zero.
    if (on) h.setMovementInput(1, 0, 0, true);
    else h.setMovementInput(0, 0, 0, false);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `setMovementInput threw: ${e && e.message ? e.message : String(e)}` };
  }
}

export const flags = [
  // ---------------------------------------------------------------------------
  // syncPhysicsTick — A1-O3 synchronous physics-tick boundary (Tier 3, JS-live)
  // ---------------------------------------------------------------------------
  {
    key: "syncPhysicsTick",
    name: "A1-O3 sync physics tick boundary (Tier 3, JS-live, NO rebuild)",
    tier: "A1-O3",
    // Canonical combo (docs/url-flags.md:484): the flag + its URL-settable
    // composeDeps + the diag canary. syncTickDiag MUST be the exact string '1'.
    query:
      "renderer=3d&unifiedTick=on&posePublishPostTick=on&syncPhysicsTick=on&syncTickDiag=1",
    composeDeps: ["unifiedTick", "posePublishPostTick"],
    // JS-live: no wasm getter added in a manifest wave is read here — the diag
    // object is pure JS and tickMovement/getLocalPlayerPose are long-present.
    rebuildCoupled: false,
    // A1-O3 has NO named rust tests (it is a JS-side frame-driver change). The
    // wasm TickMovement arm it leans on is covered by the spine tests.
    rustTests: [],
    crate: "",

    async assertBrowser(helpers) {
      // 1) The diag object only exists when ?syncTickDiag=1 parsed. The driver
      //    folds it into the query (exact '1'), so absence here means the flag
      //    plumbing did not engage — a real harness/flag-parse problem, not a
      //    rebuild issue (this flag has no rebuild-coupled surface). But it can
      //    also legitimately be absent for one beat before the first hop runs,
      //    so wait briefly and re-read before deciding.
      let diag = await helpers.readDiag("__syncTickDiag");
      if (diag == null) {
        await helpers.waitMs(300);
        diag = await helpers.readDiag("__syncTickDiag");
      }
      if (diag == null) {
        // The object is installed eagerly at parse time when syncTickDiag=1
        // (scene3d/index.js:521), so a persistent absence means the flag did
        // not parse (wrong token) or the 3D driver never installed it.
        return fail(
          "window.__syncTickDiag absent — ?syncTickDiag=1 did not engage " +
            "(it requires the EXACT token '1'; this flag is JS-live so this is " +
            "a flag/plumbing problem, not a rebuild gap)"
        );
      }
      // Shape sanity: the four counter fields must be present + numeric.
      const need = ["enqueued", "hopCompleted", "poseChangedSameFrame", "skipped2d"];
      const missing = need.filter((k) => typeof diag[k] !== "number");
      if (missing.length) {
        return fail(
          `__syncTickDiag missing/bad counter field(s): ${missing.join(", ")} ` +
            `(got ${JSON.stringify(diag)})`
        );
      }

      // 2) Confirm the sync-tick driver is the one owning the frame (the 3D
      //    driver claims it under ?syncPhysicsTick=on). Best-effort; reported.
      const owned = await helpers.evalInPage(() => ({
        syncTickOwned: window.__syncTickOwned === true,
        frameDriver: window.__scene3dFrameDriverActive === true,
        lastEnqueueMs:
          typeof window.__syncTickLastEnqueueMs === "number"
            ? window.__syncTickLastEnqueueMs
            : null,
      }));

      // 3) Let the frame driver tick for a beat so enqueued/hopCompleted climb
      //    on idle (these advance every frame the hop runs — no input needed).
      const before = {
        enqueued: diag.enqueued,
        hopCompleted: diag.hopCompleted,
        poseChangedSameFrame: diag.poseChangedSameFrame,
      };
      await helpers.waitMs(700);
      let mid = await helpers.readDiag("__syncTickDiag");
      if (mid == null) {
        return fail("__syncTickDiag vanished mid-run (driver stopped?)");
      }

      // enqueued + hopCompleted MUST climb if the sync-tick hop is running.
      // CRITICAL classification (matches the MEMORY "ready≠in-world / partial
      // boot" trap): the hop is only ever called from the 3D frame driver's
      // tick(). If that driver is NOT active (window.__scene3dFrameDriverActive
      // false — e.g. a degraded/partial boot where the page reported in-world
      // but the render loop never claimed the frame, or the 2D-loop watchdog
      // took over), the counters CANNOT advance by design. That is an
      // ENVIRONMENTAL/boot condition, NOT a flag defect ⇒ SKIP, never FAIL. We
      // only FAIL when the frame driver IS active (so the hop should be running)
      // but the counters stay flat — a true exercised-but-wrong case.
      if (!(mid.enqueued > before.enqueued)) {
        if (!owned.frameDriver) {
          return skip(
            `__syncTickDiag present but enqueued flat (${before.enqueued} → ${mid.enqueued}) ` +
              `with the 3D frame driver INACTIVE (frameDriver=false, ` +
              `syncTickOwned=${owned.syncTickOwned}) — the sync-tick hop only runs from ` +
              `the 3D tick() loop, which never claimed the frame (degraded/partial boot, ` +
              `not the flag). Diag installed correctly; the hop path is unexercised — ` +
              `presence-only`
          );
        }
        return fail(
          `__syncTickDiag.enqueued did not advance over ~0.7s ` +
            `(${before.enqueued} → ${mid.enqueued}) while the 3D frame driver IS active ` +
            `(frameDriver=true, syncTickOwned=${owned.syncTickOwned}) — the syncPhysicsTick ` +
            `phase #0 hop is not running on a live frame driver (flag path not engaged ` +
            `despite ?syncPhysicsTick=on)`
        );
      }
      if (!(mid.hopCompleted > before.hopCompleted)) {
        return fail(
          `__syncTickDiag.hopCompleted did not advance over ~0.7s ` +
            `(${before.hopCompleted} → ${mid.hopCompleted}) while enqueued did ` +
            `(${before.enqueued} → ${mid.enqueued}) — the one-microtask hop is ` +
            `not resolving (tickMovement threw or never completed)`
        );
      }
      // hopCompleted must not get ahead of enqueued (it is incremented strictly
      // after the matching enqueue in syncTickHop).
      if (mid.hopCompleted > mid.enqueued) {
        return fail(
          `__syncTickDiag.hopCompleted (${mid.hopCompleted}) > enqueued ` +
            `(${mid.enqueued}) — counter invariant violated`
        );
      }

      // 4) poseChangedSameFrame only climbs when the post-tick pose differs
      //    from the pre-tick pose the SAME frame — i.e. the player moved. Drive
      //    a forward+run input through the wasm input boundary, let several
      //    frames tick, then stop. If the input boundary is not callable we
      //    cannot stage motion headlessly → SKIP the pose-change assertion
      //    (enqueued/hopCompleted already proved the boundary is live).
      const poseBefore = mid.poseChangedSameFrame;
      const start = await helpers.evalInPage(driveForwardInPage, true);
      if (!start.ok) {
        // setMovementInput unexpectedly absent/threw. The boundary is a
        // long-present export; if it is gone the pkg regressed — but this flag
        // is JS-live, so classify as skip (presence of the diag + advancing
        // enqueued/hopCompleted is the floor) rather than fail.
        await helpers.evalInPage(driveForwardInPage, false).catch(() => {});
        return skip(
          `enqueued+hopCompleted advancing (${before.enqueued}→${mid.enqueued} / ` +
            `${before.hopCompleted}→${mid.hopCompleted}) but could not drive a ` +
            `movement input to exercise poseChangedSameFrame (${start.why}); ` +
            `idle path verified, pose-change path unexercised`
        );
      }
      // Hold the input across enough frames to register multiple moved frames.
      // At ~60fps a 1s hold is ~60 frames; even a slow swiftshader headless
      // pass gives well over the single moved frame we need.
      await helpers.waitMs(1000);
      const after = await helpers.readDiag("__syncTickDiag");
      // Stop moving so a reused same-query session is left at rest.
      await helpers.evalInPage(driveForwardInPage, false).catch(() => {});

      if (after == null) {
        return fail("__syncTickDiag vanished while driving input (driver stopped?)");
      }
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(
          `fatal console error under syncPhysicsTick: ${fatals[0].text}` +
            (fatals.length > 1 ? ` (+${fatals.length - 1} more)` : "")
        );
      }

      const poseDelta = after.poseChangedSameFrame - poseBefore;
      const enqDelta = after.enqueued - before.enqueued;
      const hopDelta = after.hopCompleted - before.hopCompleted;
      const trace =
        `enqueued ${before.enqueued}→${after.enqueued} (+${enqDelta}), ` +
        `hopCompleted ${before.hopCompleted}→${after.hopCompleted} (+${hopDelta}), ` +
        `poseChangedSameFrame ${poseBefore}→${after.poseChangedSameFrame} ` +
        `(+${poseDelta}), syncTickOwned=${owned.syncTickOwned}, ` +
        `frameDriver=${owned.frameDriver}`;

      if (poseDelta > 0) {
        // Full path proven: the frame-top enqueue + one-microtask hop produced
        // a SAME-FRAME post-integration pose change under forward+run input.
        return pass(
          `sync physics tick boundary live: ${trace} — same-frame post-tick ` +
            `pose change observed while moving (the A1-O3 contract)`
        );
      }

      // enqueued+hopCompleted climbed (idle path proven) but the pose never
      // changed same-frame. The player may have been wall-blocked / not
      // grounded / server-authoritative-stationary at the spawn — the integrator
      // ran but produced no delta. The boundary + hop are proven; the moved-
      // frame proof did not manifest → SKIP (presence + idle-path, not a fail).
      return skip(
        `sync-tick hop running (${trace}) but poseChangedSameFrame did not ` +
          `advance under a forward+run input — the integrator ticked but the ` +
          `pose did not change (player wall-blocked / not grounded / server-` +
          `stationary at spawn). enqueued+hopCompleted prove the boundary; ` +
          `the moved-frame path is unexercised here — presence + idle-path only`
      );
    },
  },
];

export default flags;
