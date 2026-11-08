// tests/stance_routing_and_loco_transitions.test.mjs
// Milestone 3 Stance Routing & Locomotion State Transitions Unit Tests
// Features 30, 31, 32, 37

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const { EntityManager, isLocomotionLink, canonicalCycleBaseSpeed } = await import("../scene3d/entities.js");
const { FADE_LOCOMOTION_MS, FADE_STANCE_SWAP_MS, FADE_TAKEOFF_MS, FADE_LANDING_MS } = await import("../scene3d/animation.js");

const READY = 0x41000003, WALK = 0x45000005, RUN = 0x44000007, CROUCH = 0x41000012;
const NON_COMBAT = 0x8000003D, SWORD = 0x8000003E, BOW = 0x8000003F, MAGIC = 0x80000049;

test("Feature 37: Crossfade constants are exported and match spec", () => {
  assert.equal(FADE_LOCOMOTION_MS, 120);
  assert.equal(FADE_STANCE_SWAP_MS, 150);
  assert.equal(FADE_TAKEOFF_MS, 80);
  assert.equal(FADE_LANDING_MS, 60);
});

test("Feature 31: isLocomotionLink includes Crouch 0x41000012", () => {
  assert.equal(isLocomotionLink(READY, CROUCH), true);
  assert.equal(isLocomotionLink(CROUCH, READY), true);
  assert.equal(isLocomotionLink(RUN, CROUCH), true);
  assert.equal(isLocomotionLink(CROUCH, RUN), true);
  assert.equal(isLocomotionLink(WALK, CROUCH), true);
  assert.equal(isLocomotionLink(CROUCH, WALK), true);
});

test("Feature 32: _resolveStyleLinks executes 2-hop routing via NonCombat 0x8000003D", async () => {
  const recorded = [];
  const fakeEntityMgr = {
    _styleChainRetailOn: true,
    async _fetchLinkEntry(inst, setupId, mtableId, fromCmd, toCmd, stance) {
      recorded.push({ fromCmd, toCmd, stance });
      // Direct between two combat stances is absent in MT 0x09000001
      if (stance === SWORD && toCmd === BOW) return null;
      // Sheathe sword into NonCombat
      if (stance === SWORD && toCmd === NON_COMBAT) return { clip: "sheathe_sword" };
      // Draw bow from NonCombat
      if (stance === NON_COMBAT && toCmd === BOW) return { clip: "draw_bow" };
      return null;
    }
  };

  const hops = await EntityManager.prototype._resolveStyleLinks.call(fakeEntityMgr, {}, 1, 1, SWORD, BOW);
  assert.equal(hops.length, 2);
  assert.equal(hops[0].toCmd, NON_COMBAT);
  assert.equal(hops[0].stance, SWORD);
  assert.equal(hops[1].toCmd, BOW);
  assert.equal(hops[1].stance, NON_COMBAT);
});

test("Feature 31: _fetchSubstateLinks routes Run -> Crouch via 2-hop through Ready", async () => {
  const fakeEntityMgr = {
    async _fetchLinkEntry(inst, setupId, mtableId, from, to, stance) {
      if (from === RUN && to === CROUCH) return null; // No direct link
      if (from === RUN && to === READY) return { clip: "run_to_ready" };
      if (from === READY && to === CROUCH) return { clip: "ready_to_crouch" };
      return null;
    }
  };

  const hops = await EntityManager.prototype._fetchSubstateLinks.call(fakeEntityMgr, {}, 1, 1, RUN, CROUCH, NON_COMBAT, 1.0);
  assert.equal(hops.length, 2);
  assert.equal(hops[0].fromCmd, RUN);
  assert.equal(hops[0].entry.clip, "run_to_ready");
  assert.equal(hops[1].fromCmd, READY);
  assert.equal(hops[1].entry.clip, "ready_to_crouch");
});

test("Feature 31: _fetchSubstateLinks routes Crouch -> Run via 2-hop through Ready", async () => {
  const fakeEntityMgr = {
    async _fetchLinkEntry(inst, setupId, mtableId, from, to, stance) {
      if (from === CROUCH && to === RUN) return null; // No direct link
      if (from === CROUCH && to === READY) return { clip: "crouch_to_ready" };
      if (from === READY && to === RUN) return { clip: "ready_to_run" };
      return null;
    }
  };

  const hops = await EntityManager.prototype._fetchSubstateLinks.call(fakeEntityMgr, {}, 1, 1, CROUCH, RUN, NON_COMBAT, 1.0);
  assert.equal(hops.length, 2);
  assert.equal(hops[0].fromCmd, CROUCH);
  assert.equal(hops[0].entry.clip, "crouch_to_ready");
  assert.equal(hops[1].fromCmd, READY);
  assert.equal(hops[1].entry.clip, "ready_to_run");
});

test("Feature 28: canonicalCycleBaseSpeed provides correct speeds", () => {
  assert.equal(canonicalCycleBaseSpeed(0x44000007), 4.0000);
  assert.equal(canonicalCycleBaseSpeed(0x45000005), 2.6017);
  assert.equal(canonicalCycleBaseSpeed(0x6500000F), 1.2500);
  assert.equal(canonicalCycleBaseSpeed(0x65000010), 1.2500);
  assert.equal(canonicalCycleBaseSpeed(0x41000003), 0.0);
});
