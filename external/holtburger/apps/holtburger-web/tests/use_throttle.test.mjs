// tests/use_throttle.test.mjs — B2-use-items use-4 (2026-10-08 round 2).
//
// Retail ItemHolder::UseObject (acclient.c:433389-433391) opens with
//   if (Timer::cur_time >= ItemHolder::m_timeLastUsed + 0.2) {
//     ItemHolder::m_timeLastUsed = Timer::cur_time; ...
// — ONE static shared by every caller (3D double-click :275702, toolbar Use
// :241619, keyboard use-selected :399822, the inventory), checked before the
// use is classified, so pickups and refusals spend it too and a throttled call
// is dropped silently. Holtburger throttled only the inventory
// (plugins/inventory.js activateItem, module-local); a habitual double-click on
// the toolbar Use button sent two Use events, and ACE restarts its MoveTo
// chain on each (Player_Use.cs StopExistingMoveToChains).
//
// Pins scene3d/target_cycle.js consumeUseThrottle / consumeWorldUseThrottle
// (and `?retailUseThrottle=off`), plus by source that every caller spends it
// exactly once, at the leaf.
//
// Run: node tests/use_throttle.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  consumeUseThrottle, consumeWorldUseThrottle, _resetUseThrottleForTests, RETAIL_USE_THROTTLE_MS,
} from "../scene3d/target_cycle.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("0.2 s window: cur_time >= last + 0.2 passes and records", () => {
  _resetUseThrottleForTests();
  assert.equal(RETAIL_USE_THROTTLE_MS, 200);
  assert.equal(consumeUseThrottle(0), true);
  assert.equal(consumeUseThrottle(150), false, "inside the window → dropped");
  assert.equal(consumeUseThrottle(200), true, "exactly 0.2 s later → allowed");
  assert.equal(consumeUseThrottle(399), false, "a dropped call does not re-arm the window");
  assert.equal(consumeUseThrottle(400), true);
});

test("one static: the inventory and the world paths share it", () => {
  _resetUseThrottleForTests();
  assert.equal(consumeUseThrottle(1000), true, "inventory activateItem");
  assert.equal(consumeWorldUseThrottle(1100), false, "a toolbar Use 100 ms later is dropped");
  assert.equal(consumeWorldUseThrottle(1200), true);
  assert.equal(consumeUseThrottle(1300), false, "and the world Use spent it for the inventory too");
});

test("?retailUseThrottle=off (0/false): the world paths go unthrottled, the inventory keeps it", () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const prev = globalThis.location;
  try {
    for (const v of ["off", "0", "false", "OFF"]) {
      globalThis.location = { search: `?retailUseThrottle=${v}` };
      _resetUseThrottleForTests();
      assert.equal(consumeWorldUseThrottle(0), true);
      assert.equal(consumeWorldUseThrottle(10), true, `${v}: world unthrottled`);
      assert.equal(consumeUseThrottle(20), true);
      assert.equal(consumeUseThrottle(30), false, `${v}: inventory still throttled`);
    }
    globalThis.location = { search: "?retailUseThrottle=on" };
    _resetUseThrottleForTests();
    assert.equal(consumeWorldUseThrottle(0), true);
    assert.equal(consumeWorldUseThrottle(10), false, "any other value = default ON");
  } finally {
    if (had) globalThis.location = prev; else delete globalThis.location;
    _resetUseThrottleForTests();
  }
});

test("every caller spends it once, at the leaf", () => {
  const inv = src("plugins/inventory.js");
  const act = inv.slice(inv.indexOf("function activateItem("));
  assert.match(inv, /import \{ consumeUseThrottle \} from "\.\.\/scene3d\/target_cycle\.js";/);
  assert.ok(act.indexOf("if (!row) return false;") < act.indexOf("if (!consumeUseThrottle(now)) return true;"),
    "only an OWNED item spends it in activateItem (a world guid is the caller's)");
  assert.doesNotMatch(inv, /lastActivateAt/, "no module-local copy left");

  const p = src("scene3d/picking.js");
  assert.match(p, /if \(doubleClickGate\(guid, ev\) && worldUseThrottleOk\(\)\) \{\s*cancelClientMove\(\);\s*sessionHandle\.useObject/,
    "corpse open");
  assert.match(p, /if \(me !== 0 && worldUseThrottleOk\(\)\) \{/, "ground pickup");
  assert.match(p, /if \(!worldUseThrottleOk\(\)\) return;\s*const refusal = worldUseRefusal\(guid\);/, "world Use");
  assert.match(p, /return consumeWorldUseThrottle\(t\);/);

  // target-bar: inside the activateOrUse `use:` leaf only — never before
  // activateOrUse, or activateItem would see its own call throttled.
  const tb = src("plugins/target-bar.js");
  const onUse = tb.slice(tb.indexOf("function onUseClick()"), tb.indexOf("function examineSelected()"));
  const route = onUse.indexOf("route = activateOrUse(guid, {");
  const spend = onUse.indexOf("throttleOk: () => consumeWorldUseThrottle(performance.now()),");
  assert.ok(route >= 0 && spend > route, "spent inside the use leaf");
  assert.equal(onUse.split("consumeWorldUseThrottle").length - 1, 1, "exactly one spend site");

  const rm = src("plugins/radial-menu.js");
  assert.match(rm, /import \{ consumeWorldUseThrottle \} from "\.\.\/scene3d\/target_cycle\.js";/);
  assert.match(rm, /throttleOk: \(\) => consumeWorldUseThrottle\(performance\.now\(\)\),/);
});
