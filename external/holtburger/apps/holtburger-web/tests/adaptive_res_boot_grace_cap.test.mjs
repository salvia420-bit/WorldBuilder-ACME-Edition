// tests/adaptive_res_boot_grace_cap.test.mjs — ?adaptiveResBootGrace when the
// scene never reports `ready` (review 2026-10-18, RENDER-6).
//
// The grace held every lower until 30 s after the first `ready` in
// window.__bootStateHistory. index.js emits `ready` only after the atmosphere
// pipeline is built (or skipped by the wire agent / wireframe); a failed
// atmosphere / SkyDome init emits nothing, and the grace then never ended: a
// GPU-bound player stayed at full render scale for the session (bootHolds
// climbing). Now, with no `ready`, the grace ends BOOT_READY_WAIT_MS after the
// first `in-world`. Runs the real bootGraceActive and controller.
//
// Run:  cd apps/holtburger-web && node tests/adaptive_res_boot_grace_cap.test.mjs

import {
  bootGraceActive,
  BOOT_GRACE_MS,
  BOOT_READY_WAIT_MS,
  AdaptiveRenderScaleController,
} from "../scene3d/adaptive_render_scale.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

console.log("PART 1 — bootGraceActive");
{
  const t0 = 5_000_000;
  const login = [{ state: "init", ts: t0 - 600_000 }, { state: "form-shown", ts: t0 - 600_000 }];
  check("at the login form (no in-world, no ready) ⇒ booting", bootGraceActive(login, t0) === true);
  const inWorld = [...login, { state: "in-world", ts: t0 }];
  check("in-world, ready still pending ⇒ booting", bootGraceActive(inWorld, t0 + 60_000) === true);
  check(`no ready ${BOOT_READY_WAIT_MS / 1000} s after in-world ⇒ the grace ends`,
    bootGraceActive(inWorld, t0 + BOOT_READY_WAIT_MS) === false);
  check("the wait is measured from the FIRST in-world (a re-entry does not restart it)",
    bootGraceActive([...inWorld, { state: "in-world", ts: t0 + 100_000 }], t0 + BOOT_READY_WAIT_MS) === false);
  check("the wait outlasts the 90 s autoLogin ready watchdog", BOOT_READY_WAIT_MS > 90_000);
  const ready = [...inWorld, { state: "ready", ts: t0 + 20_000 }];
  check("a ready that arrives still rules: booting until BOOT_GRACE_MS after it",
    bootGraceActive(ready, t0 + 20_000 + BOOT_GRACE_MS - 1) === true && bootGraceActive(ready, t0 + 20_000 + BOOT_GRACE_MS) === false);
  check("ready before in-world (nullRender order) keeps its 30 s grace",
    bootGraceActive([{ state: "ready", ts: t0 }, { state: "in-world", ts: t0 + 1 }], t0 + 10_000) === true);
}

console.log("PART 2 — the controller lowers once the capped grace has ended");
{
  // index.js wiring: isBooting reads the live history through bootGraceActive.
  const history = [{ state: "in-world", ts: 0 }];
  let wall = 0, scale = 1, t = 0;
  const c = new AdaptiveRenderScaleController({
    getScale: () => scale, applyScale: (s) => { scale = s; },
    now: () => t, isBooting: () => bootGraceActive(history, wall), settle: true,
  });
  // GPU-bound: back-to-back catastrophic frames (4x the band).
  const run = (n) => { for (let i = 0; i < n; i++) { t += 240; wall += 240; c.recordFrame(); } };
  run(40);
  check("within the wait: lowers held", scale === 1 && c.bootHolds > 0, JSON.stringify({ scale, holds: c.bootHolds }));
  wall = BOOT_READY_WAIT_MS; // no ready ever arrived
  run(40);
  check("past it with still no ready: the scale comes down", scale < 1, JSON.stringify({ scale, holds: c.bootHolds }));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
