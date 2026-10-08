// tests/portal_busy.test.mjs — streaming-teleport-5 (2026-10-08 round 3).
//
// Retail CPlayerSystem::SetTeleportInProgress (acclient.c:395704) raises the
// UI busy count for the whole portal sequence (set on TAS_TUNNEL :262424,
// cleared after the world fade-in :262571), and
// ClientCombatSystem::SetCombatMode (:408787) refuses a player-requested
// stance change while teleportInProgress with
// "You can't enter combat mode while in portal space" (text type 0x1A,
// :408840-408845).
//
// Pins ui/portal_busy.js, the use-throttle drop (scene3d/target_cycle.js) and
// by source every gate site.
//
// Run: node tests/portal_busy.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PORTAL_COMBAT_REFUSAL, portalBusyEnabled, portalSpaceActive, portalSpaceBusy,
  refuseCombatModeInPortalSpace,
} from "../ui/portal_busy.js";
import { consumeUseThrottle, _resetUseThrottleForTests } from "../scene3d/target_cycle.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

function inPortalSpace(on, fn) {
  const saved = globalThis.__isPortalSpaceActive;
  globalThis.__isPortalSpaceActive = () => on;
  try { return fn(); } finally { globalThis.__isPortalSpaceActive = saved; }
}

test("?portalBusy: default on; off / 0 / false disable", () => {
  assert.equal(portalBusyEnabled(""), true);
  for (const v of ["off", "0", "false"]) assert.equal(portalBusyEnabled(`?portalBusy=${v}`), false, v);
});

test("busy only while portal space runs", () => {
  assert.equal(portalSpaceActive(), false, "no portal module → not active");
  inPortalSpace(true, () => assert.equal(portalSpaceBusy(), true));
  inPortalSpace(false, () => assert.equal(portalSpaceBusy(), false));
});

test("stance change refused in portal space with retail's line on the transient channel", () => {
  const lines = [];
  const saved = globalThis.__appendChatLine;
  globalThis.__appendChatLine = (t, c) => lines.push([t, c]);
  try {
    assert.equal(refuseCombatModeInPortalSpace(), false, "outside portal space: go ahead");
    inPortalSpace(true, () => assert.equal(refuseCombatModeInPortalSpace(), true));
    assert.deepEqual(lines, [[PORTAL_COMBAT_REFUSAL, 9]]);
    assert.equal(PORTAL_COMBAT_REFUSAL, "You can't enter combat mode while in portal space");
  } finally {
    globalThis.__appendChatLine = saved;
  }
});

test("a use in portal space is dropped like a throttled one (and does not spend the window)", () => {
  _resetUseThrottleForTests();
  inPortalSpace(true, () => assert.equal(consumeUseThrottle(1000), false));
  assert.equal(consumeUseThrottle(1000), true, "after the tunnel the use goes through at once");
});

test("every gate site is wired", () => {
  assert.match(src("scene3d/portal_space.js"), /globalThis\.__isPortalSpaceActive = isPortalSpaceActive/);
  assert.match(src("index.html"), /window\.__refuseCombatModeInPortalSpace\(\)/);
  assert.match(src("plugins/api.js"), /if \(refuseCombatModeInPortalSpace\(\)\) return;/);
  assert.match(src("plugins/combat-bar.js"), /if \(refuseCombatModeInPortalSpace\(\)\) return;/);
  assert.match(src("plugins/target-bar.js"), /if \(refuseCombatModeInPortalSpace\(\)\) return;/);
  assert.match(src("ui/ac_cast_spell.js"), /if \(portalSpaceBusy\(\)\) return "refused";/);
  assert.match(src("plugins/rejection_feedback.js"), /if \(portalSpaceBusy\(\)\) return true;/);
  assert.match(src("scene3d/target_cycle.js"), /if \(portalSpaceBusy\(\)\) return false;/);
});
