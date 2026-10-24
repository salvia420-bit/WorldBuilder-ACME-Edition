// tests/loco_prewarm.test.mjs — ?locoPrewarm (2026-10-24, default ON): the
// local rig's locomotion cycles and start/stop/gait links (signed backpedal
// pair included) are baked when the rig commits and on every stance change,
// so the first W after login does not stand in the idle pose while the run
// cycle bakes (~35 frames at 18 m/s, live on the 1070). Drives the real
// EntityManager.prototype._prewarmLocalLocomotion against a recording stub.
//
// Run from apps/holtburger-web/:  node tests/loco_prewarm.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;
const { EntityManager } = await import("../scene3d/entities.js");
const prewarm = EntityManager.prototype._prewarmLocalLocomotion;

const hex = (n) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
function stub() {
  const cycles = [], links = [];
  return {
    cycles, links,
    wasmExports: { fetchEntityAnimationKeyframes() {} },
    animationCache: {
      get(setupId, mtableId, cmd, stance) { cycles.push(`${hex(cmd)}@${hex(stance)}`); return Promise.resolve(null); },
    },
    _fetchLinkEntry(inst, setupId, mtableId, a, b, stance, signed) {
      links.push(`${hex(a)}>${hex(b)}@${hex(stance)}${signed ? (signed.toSpeed < 0 || signed.fromSpeed < 0 ? " signed-reversed" : " signed") : ""}`);
      return Promise.resolve(null);
    },
  };
}
const human = () => ({ meta: { modelId: 0x02000001, mtableId: 0x09000001 } });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("bakes the run/walk/strafe/turn/fall cycles and the gait links for the stance", async () => {
  const self = stub();
  prewarm.call(self, human(), 0x8000003d);
  await settle();
  assert.deepEqual(self.cycles.sort(), [
    "0x40000015@0x8000003d", "0x44000007@0x8000003d", "0x45000005@0x8000003d",
    "0x6500000d@0x8000003d", "0x6500000f@0x8000003d",
  ]);
  assert.deepEqual(self.links, [
    "0x41000003>0x44000007@0x8000003d", "0x44000007>0x41000003@0x8000003d",
    "0x41000003>0x45000005@0x8000003d", "0x45000005>0x41000003@0x8000003d",
    "0x45000005>0x44000007@0x8000003d", "0x44000007>0x45000005@0x8000003d",
    // The backpedal start / stop pair, as _fetchSignedLocoLinks asks for it.
    "0x41000003>0x45000005@0x8000003d signed-reversed",
    "0x45000005>0x41000003@0x8000003d signed-reversed",
  ]);
});

test("once per setup:table:stance; a stance change bakes the new stance", async () => {
  const self = stub();
  const inst = human();
  prewarm.call(self, inst, 0x8000003d);
  prewarm.call(self, inst, 0x8000003d);
  await settle();
  assert.equal(self.cycles.length, 5, "the second call is a no-op");
  prewarm.call(self, inst, 0x8000003c); // UA combat
  await settle();
  assert.equal(self.cycles.length, 10);
  assert.ok(self.cycles.slice(5).every((c) => c.endsWith("@0x8000003c")));
});

test("a bare low-16 stance is widened to the full stance id", async () => {
  const self = stub();
  prewarm.call(self, human(), 0x3e);
  await settle();
  assert.ok(self.cycles.every((c) => c.endsWith("@0x8000003e")), self.cycles.join());
});

test("no setup, no meta or no wasm bake export: nothing is fetched", async () => {
  for (const [self, inst] of [
    [stub(), { meta: { modelId: 0, mtableId: 0x09000001 } }],
    [stub(), {}],
    [Object.assign(stub(), { wasmExports: {} }), human()],
  ]) {
    prewarm.call(self, inst, 0x8000003d);
    await settle();
    assert.equal(self.cycles.length + self.links.length, 0);
  }
});
