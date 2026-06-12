// A14-I2 (2026-06-12, W3+ S10) — wasm pursuit / turn-to intents:
// headless test for the pure monitor state machine
// (scene3d/pursuit_monitor.js) + static F6-6 / stomp-fix invariants on
// the picking.js consumer.
//
//   PART 1 — status decode + flag reader.
//   PART 2 — charge monitor semantics: arrived → exactly one "arrive";
//            timeout / failed / stance-abort → exactly one "cancel"
//            with no fire; idle = pending (continue); terminal latch.
//   PART 3 — turn monitor semantics: 2/3 → act (no cancel); timeout →
//            act WITH cancel; terminal latch.
//   PART 4 — static picking.js invariants: the flag-on pursuit path
//            contains ZERO setMovementInput calls; arrival invokes the
//            SAME charge.fireAttack closure with the windup release
//            FIRST (F6-6 preserved verbatim); the legacy chargeTick /
//            turn loop are untouched (flag-off byte path).
//
// Run:
//   cd apps/holtburger-web/
//   node test_a14_i2_pursuit_monitor.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import {
  PURSUIT_ACTIVE,
  PURSUIT_ARRIVED,
  PURSUIT_FAILED,
  PURSUIT_IDLE,
  createPursuitMonitor,
  createTurnMonitor,
  decodePursuitStatus,
  readWasmPursuitFlag,
} from "./scene3d/pursuit_monitor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("PART 1 — status decode + flag reader");
{
  check("idle decodes", decodePursuitStatus(0).state === PURSUIT_IDLE);
  check("active decodes", decodePursuitStatus(1).state === PURSUIT_ACTIVE);
  check("arrived decodes", decodePursuitStatus(2).state === PURSUIT_ARRIVED);
  const fail36 = decodePursuitStatus(3 | (0x36 << 16));
  check("failed state decodes", fail36.state === PURSUIT_FAILED);
  check("failed werror decodes", fail36.werror === 0x36, `0x${fail36.werror.toString(16)}`);
  const fail3d = decodePursuitStatus((3 | (0x3d << 16)) >>> 0);
  check("fail-distance werror decodes", fail3d.werror === 0x3d);
  check("flag on", readWasmPursuitFlag("?wasmPursuit=on") === true);
  check("flag on (compound)", readWasmPursuitFlag("?nullRender=1&wasmPursuit=on&x=1") === true);
  check("flag off (absent)", readWasmPursuitFlag("?melee3dRange=on") === false);
  check("flag off (wrong value)", readWasmPursuitFlag("?wasmPursuit=off") === false);
  check("flag off (empty/undefined)", readWasmPursuitFlag(undefined) === false);
}

console.log("PART 2 — charge monitor semantics");
{
  // Arrived → exactly one "arrive"; fire EXACTLY once per charge.
  const monitor = createPursuitMonitor({ maxDurationMs: 10_000 });
  let r = monitor({ statusRaw: PURSUIT_IDLE, elapsedMs: 16, inCombatStance: true });
  check("idle = pending (continue)", r.action === "continue");
  r = monitor({ statusRaw: PURSUIT_ACTIVE, elapsedMs: 500, inCombatStance: true });
  check("active continues", r.action === "continue");
  r = monitor({ statusRaw: PURSUIT_ARRIVED, elapsedMs: 900, inCombatStance: true });
  check("arrived → arrive", r.action === "arrive");
  r = monitor({ statusRaw: PURSUIT_ARRIVED, elapsedMs: 916, inCombatStance: true });
  check("arrive fires AT MOST once (terminal latch)", r.action === "done");
  r = monitor({ statusRaw: 3 | (0x36 << 16), elapsedMs: 932, inCombatStance: true });
  check("no late cancel after arrive", r.action === "done");

  // Timeout → cancel, no fire — even if status would read arrived.
  const timeoutMonitor = createPursuitMonitor({ maxDurationMs: 10_000 });
  r = timeoutMonitor({ statusRaw: PURSUIT_ARRIVED, elapsedMs: 10_001, inCombatStance: true });
  check("timeout → cancel (no fire)", r.action === "cancel" && r.reason === "timeout");
  r = timeoutMonitor({ statusRaw: PURSUIT_ARRIVED, elapsedMs: 10_017, inCombatStance: true });
  check("cancel terminal latch", r.action === "done");

  // Failed → cancel with the WEENIE code, no fire.
  const failMonitor = createPursuitMonitor({ maxDurationMs: 10_000 });
  r = failMonitor({ statusRaw: (3 | (0x37 << 16)) >>> 0, elapsedMs: 100, inCombatStance: true });
  check("failed → cancel (no fire)", r.action === "cancel" && r.reason === "failed");
  check("failed carries werror", r.werror === 0x37);

  // Stance abort → cancel, no fire.
  const stanceMonitor = createPursuitMonitor({ maxDurationMs: 10_000 });
  r = stanceMonitor({ statusRaw: PURSUIT_ACTIVE, elapsedMs: 100, inCombatStance: false });
  check("stance abort → cancel", r.action === "cancel" && r.reason === "stance");

  // Consumer-shaped fire-once assertion: drive a fake rAF loop the way
  // pursuitMonitorTick does and count fires across spurious extra steps.
  const onceMonitor = createPursuitMonitor({ maxDurationMs: 10_000 });
  let fires = 0;
  let releases = 0;
  const order = [];
  for (const statusRaw of [PURSUIT_ACTIVE, PURSUIT_ARRIVED, PURSUIT_ARRIVED, PURSUIT_ARRIVED]) {
    const step = onceMonitor({ statusRaw, elapsedMs: 16, inCombatStance: true });
    if (step.action === "arrive") {
      order.push("release");
      releases += 1;
      order.push("fire");
      fires += 1;
    }
  }
  check("fire called EXACTLY once per charge", fires === 1, `fires=${fires}`);
  check("windup release precedes fire", order.join(",") === "release,fire");
  check("release also exactly once", releases === 1);
}

console.log("PART 3 — turn monitor semantics");
{
  const turn = createTurnMonitor({ timeoutMs: 800 });
  let r = turn({ statusRaw: PURSUIT_ACTIVE, elapsedMs: 100 });
  check("turning continues", r.action === "continue");
  r = turn({ statusRaw: PURSUIT_ARRIVED, elapsedMs: 200 });
  check("turn arrived → act, no cancel", r.action === "act" && r.cancel === false);
  r = turn({ statusRaw: PURSUIT_ARRIVED, elapsedMs: 216 });
  check("turn terminal latch", r.action === "done");

  const turnFail = createTurnMonitor({ timeoutMs: 800 });
  r = turnFail({ statusRaw: (3 | (8 << 16)) >>> 0, elapsedMs: 50 });
  check("turn failed → act anyway (legacy fallback parity)", r.action === "act" && r.cancel === false);

  const turnTimeout = createTurnMonitor({ timeoutMs: 800 });
  r = turnTimeout({ statusRaw: PURSUIT_ACTIVE, elapsedMs: 801 });
  check("turn timeout → act WITH cancelPursuit", r.action === "act" && r.cancel === true);
}

console.log("PART 4 — static picking.js invariants");
{
  const source = readFileSync(joinPath(__dirname, "scene3d", "picking.js"), "utf8");

  // Extract a top-level closure function body by brace balancing.
  function extractFn(name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) return null;
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return null;
  }

  const monitorTick = extractFn("pursuitMonitorTick");
  check("pursuitMonitorTick exists", !!monitorTick);
  check(
    "ZERO setMovementInput in the wasm pursuit monitor",
    !!monitorTick && !monitorTick.includes("setMovementInput"),
  );
  check(
    "monitor arrival invokes the SAME charge.fireAttack closure (F6-6)",
    !!monitorTick && monitorTick.includes("charge.fireAttack()"),
  );
  const releaseIdx = monitorTick?.indexOf("_releaseLocalWindupHold()") ?? -1;
  const fireIdx = monitorTick?.indexOf("charge.fireAttack()") ?? -1;
  check(
    "windup release BEFORE fire on arrival (legacy order preserved)",
    releaseIdx >= 0 && fireIdx >= 0 && releaseIdx < fireIdx,
  );

  const startCharge = extractFn("startCharge");
  check("startCharge exists", !!startCharge);
  check(
    "flag-on startCharge hands steering to pursueEntity",
    !!startCharge && startCharge.includes("sessionHandle.pursueEntity("),
  );
  check(
    "startCharge keeps the windup hold (setSwingMotion holdAtPeak) on both paths",
    !!startCharge && startCharge.includes("holdAtPeak: true"),
  );
  check(
    "ZERO setMovementInput in startCharge",
    !!startCharge && !startCharge.includes("setMovementInput"),
  );

  // Legacy paths untouched: chargeTick still steers via
  // setMovementInput(1, 0, turn, true) and stops with (0,0,0,false).
  const chargeTick = extractFn("chargeTick");
  check("legacy chargeTick still present (flag-off path)", !!chargeTick);
  check(
    "legacy chargeTick still steers via setMovementInput",
    !!chargeTick && chargeTick.includes("setMovementInput(1"),
  );
  check(
    "legacy chargeTick fire path intact (F6-6 site)",
    !!chargeTick && chargeTick.includes("charge.fireAttack()"),
  );

  const cancel = extractFn("cancelCharge");
  check(
    "cancelCharge routes wasm pursuits to cancelPursuit (no stomp)",
    !!cancel && cancel.includes("cancelPursuit") &&
      cancel.includes("charge.wasmPursuit"),
  );
  check(
    "cancelCharge legacy branch keeps the (0,0,0) stop",
    !!cancel && cancel.includes("setMovementInput?.(0, 0, 0, false)"),
  );

  const turnFn = extractFn("turnToFaceThenAct");
  check(
    "turnToFaceThenAct wasm branch uses turnToEntity",
    !!turnFn && turnFn.includes("sessionHandle.turnToEntity("),
  );
  check(
    "turn wasm branch is monitor-shaped (createTurnMonitor)",
    !!turnFn && turnFn.includes("createTurnMonitor("),
  );
  check(
    "S15 NO-GO: no 0xF649 / TurnToEvent send appears in picking.js",
    !source.includes("0xF649") && !source.toLowerCase().includes("turntoevent"),
  );
  check(
    "effective-on requires the exports (typeof guards)",
    source.includes('typeof sessionHandle.pursueEntity === "function"') &&
      source.includes('typeof sessionHandle.pursuitStatus === "function"'),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
