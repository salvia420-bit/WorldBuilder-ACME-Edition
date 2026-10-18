// tests/retail_unstick.test.mjs — melee lane (2026-10-18), `?retailUnstick`.
//
// Owner: "when attacking monsters with a melee weapon, sometimes it will
// attack them when they are too far away to attack."
//
// ACE swings at once when the attacker is within 4 m (cylinder) of the target
// and glues him to it for the swing (StickToObject on the swing motion,
// Player_Melee.cs:174 / :420); the hit lands with no further range check.
// Retail's StickyManager pulls the attacker in at max_speed x 5 for up to 1 s
// (acclient.c:388519-388690) and only three things end it early: the swing's
// action completing (CMotionInterp::MotionDone :343659), the next motion the
// client actually unpacks (the unpack preamble :339519), and exit-world /
// teleport. No input path unsticks (MoveToManager::CancelMoveTo :345297,
// CleanUp :345143, CPhysicsObj::StopCompletely, TakeControlFromServer
// :716934), and CPhysics::SetObjectMovement (:311149) never unpacks the
// player's own autonomous echo.
//
// The client released the glue early in two places, so the swing often
// landed from where the player stood:
//   - picking.js cancelClientMove() called stopStick() on every canvas
//     left-click and movement key (this file's [1]-[3]);
//   - the wasm UpdateMotion arm unstuck on ACE's autonomous echo of our own
//     MoveToState — the stop pulse sent when the pre-swing server TurnTo ends
//     comes back right after the swing ([4], Rust tests carry the logic).
//
//   [1] RETAIL_UNSTICK reader: default ON; off / 0 / false (any case) disable.
//   [2] cancelClientMove(): no stopStick under the flag, cancelPursuit always;
//       `=off` and an explicit `true` (teardown) still release.
//   [3] wiring: only destroy() forces the release; the click, the movement
//       key, the deselect and the world-use paths keep the bare call.
//   [4] the wasm half reads the same flag tokens and gates the local sticky
//       install on the autonomous bit and the stamp gates.
//
// Run from apps/holtburger-web/:  node tests/retail_unstick.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PICK = readFileSync(resolvePath(APP, "scene3d/picking.js"), "utf8");
const LIB_RS = readFileSync(resolvePath(APP, "src/lib.rs"), "utf8");
const POSITION_RS = readFileSync(resolvePath(APP, "src/session/messages/position.rs"), "utf8");

// The `const NAME = (() => { ... })();` initializer expression.
function iifeExpr(src, name) {
  const head = `const ${name} = (() => {`;
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${name} present`);
  const end = src.indexOf("\n})();", at);
  assert.ok(end > at, `${name} closes`);
  return src.slice(at + `const ${name} = `.length, end + "\n})()".length);
}

// The text of a closure-scoped `function name(...) { ... }` (two-space indent).
function fnSource(src, name) {
  const at = src.indexOf(`  function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  const end = src.indexOf("\n  }\n", at);
  assert.ok(end > at, `${name} closes`);
  return src.slice(at, end + "\n  }".length);
}

function readFlag(search) {
  const expr = iifeExpr(PICK, "RETAIL_UNSTICK");
  const window = { location: { search } };
  return new Function("window", `return ${expr};`)(window);
}

function cancelClientMoveWith(retailUnstick) {
  const calls = [];
  const sessionHandle = {
    stopStick: () => calls.push("stopStick"),
    cancelPursuit: () => calls.push("cancelPursuit"),
  };
  const fn = new Function(
    "sessionHandle",
    "RETAIL_UNSTICK",
    `${fnSource(PICK, "cancelClientMove")}\nreturn cancelClientMove;`,
  )(sessionHandle, retailUnstick);
  return { fn, calls };
}

test("[1] RETAIL_UNSTICK is default-on and off / 0 / false disable it", () => {
  assert.equal(readFlag(""), true, "absent");
  assert.equal(readFlag("?nosw=1"), true, "other flags only");
  assert.equal(readFlag("?retailUnstick=on"), true);
  assert.equal(readFlag("?retailUnstick=off"), false);
  assert.equal(readFlag("?retailUnstick=OFF"), false, "case-insensitive");
  assert.equal(readFlag("?nosw=1&retailUnstick=0"), false);
  assert.equal(readFlag("?retailUnstick=false"), false);
  assert.equal(new Function(`return ${iifeExpr(PICK, "RETAIL_UNSTICK")};`)(), true, "no window (node harness)");
});

test("[2] cancelClientMove keeps the swing sticky under the flag", () => {
  const on = cancelClientMoveWith(true);
  on.fn();
  assert.deepEqual(on.calls, ["cancelPursuit"], "a click / movement key no longer releases the sticky");
  on.calls.length = 0;
  on.fn(true);
  assert.deepEqual(on.calls, ["stopStick", "cancelPursuit"], "an explicit release (teardown) still releases");

  const off = cancelClientMoveWith(false);
  off.fn();
  assert.deepEqual(off.calls, ["stopStick", "cancelPursuit"], "?retailUnstick=off: the old release");
});

test("[3] only teardown forces the release; input paths keep the bare call", () => {
  const forced = PICK.match(/cancelClientMove\(true\)/g) ?? [];
  assert.equal(forced.length, 1, "exactly one forced release");
  const destroyAt = PICK.indexOf("    destroy() {");
  assert.ok(destroyAt > 0, "destroy() present");
  assert.ok(
    PICK.indexOf("cancelClientMove(true);", destroyAt) > destroyAt
      && PICK.indexOf("cancelClientMove(true);", destroyAt) < PICK.indexOf("canvas.removeEventListener", destroyAt),
    "the forced release is destroy()'s",
  );
  // The pointerdown, movement-key, deselect, corpse / ground-item / world-use
  // paths all call it bare (retail: neither a select nor a key unsticks).
  const bare = PICK.match(/cancelClientMove\(\);/g) ?? [];
  assert.ok(bare.length >= 6, `bare calls kept (${bare.length})`);
  const pointer = PICK.slice(PICK.indexOf("function onPointerDown(ev) {"));
  assert.ok(pointer.indexOf("cancelClientMove();") > 0
    && pointer.indexOf("cancelClientMove();") < pointer.indexOf("const guid = pickEntityAt(ev.clientX, ev.clientY);"),
  "the click path keeps the bare call");
  const key = PICK.slice(PICK.indexOf("function onKeyDownAbortCharge(ev) {"));
  assert.ok(key.indexOf("cancelClientMove();") > 0, "the movement-key path keeps the bare call");
  // The function itself gates stopStick on its argument.
  const body = fnSource(PICK, "cancelClientMove");
  assert.match(body, /function cancelClientMove\(releaseSticky = !RETAIL_UNSTICK\)/);
  assert.match(body, /if \(releaseSticky\) \{\s*try \{ sessionHandle\.stopStick\?\.\(\); \} catch \{\}\s*\}/);
});

test("[4] the wasm half shares the flag and gates the local sticky install", () => {
  // Same reader tokens on both sides of the bridge.
  const parseAt = LIB_RS.indexOf("fn parse_retail_unstick_flag(search: &str) -> bool {");
  assert.ok(parseAt >= 0, "parse_retail_unstick_flag present");
  assert.match(
    LIB_RS.slice(parseAt, parseAt + 400),
    /"retailUnstick=off" \| "retailUnstick=0" \| "retailUnstick=false"/,
  );
  assert.match(LIB_RS, /let retail_unstick_on: bool = parse_retail_unstick_flag\(&flag_search\(\)\);/);
  // position.rs: the install runs through the retail SetObjectMovement gate.
  const arm = POSITION_RS.slice(POSITION_RS.indexOf("GameMessage::UpdateMotion(data) => {"));
  const call = arm.indexOf("match local_motion_sticky_update(");
  assert.ok(call > 0, "the local install calls local_motion_sticky_update");
  const args = arm.slice(call, arm.indexOf(") {", call));
  assert.match(args, /local_sticky_target,\s*data\.is_autonomous,\s*stamps_recorded,\s*retail_unstick_on,/);
  assert.match(arm, /let stamps_recorded = !wire_state_packs_stage1_on\s*\|\| w\.player\.self_update_motion_recorded\(&data\);/);
  assert.match(arm, /LocalStickyUpdate::Untouched => \{\}/, "an unpacked-never message leaves the glue alone");
  // The old unconditional install/unstick is gone.
  assert.doesNotMatch(arm.slice(0, arm.indexOf("// A2-P3 R2 (2026-06-12, W3+ S9 Stage R2;")),
    /if local_sticky_target != 0 \{/);
});
