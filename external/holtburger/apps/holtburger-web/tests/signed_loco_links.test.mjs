// tests/signed_loco_links.test.mjs — ?signedLinks (2026-10-24, ANIM-4): the
// retail link plan for a locomotion change involving a NEGATIVE speed, driven
// through the real EntityManager.prototype._fetchSignedLocoLinks against a
// stub link table with retail get_link's signed lookup (acclient.c:337585:
// a negative speed takes the reversed pair links[to][from]) and
// GetObjectSequence's substate branch (:337779-337810).
//
// Run from apps/holtburger-web/:  node tests/signed_loco_links.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;
const { EntityManager } = await import("../scene3d/entities.js");
const plan = EntityManager.prototype._fetchSignedLocoLinks;

const READY = 0x41000003, WALK = 0x45000005, RUN = 0x44000007;
const NAME = { [READY]: "Ready", [WALK]: "Walk", [RUN]: "Run" };
// The human NonCombat links (0x03000005..0x0300000A): every pair but
// Ready→Ready / Walk→Walk exists.
const LINKS = new Set(["Ready>Walk", "Walk>Ready", "Ready>Run", "Run>Ready", "Walk>Run", "Run>Walk"]);

function stub() {
  const calls = [];
  return {
    calls,
    async _fetchLinkEntry(inst, setupId, mtableId, a, b, stance, signed) {
      const sa = signed?.fromSpeed ?? 1, sb = signed?.toSpeed ?? 1;
      // retail get_link: either speed negative → the reversed pair.
      const key = sa < 0 || sb < 0 ? `${NAME[b]}>${NAME[a]}` : `${NAME[a]}>${NAME[b]}`;
      calls.push({ key, reverse: !!signed?.reverse });
      return LINKS.has(key) ? { key, reverse: !!signed?.reverse } : null;
    },
  };
}
const run = (self, from, fs, to, ts) => plan.call(self, {}, 0x02000001, 0x09000001, from, fs, to, ts, 0x8000003d);
const view = (hops) => hops.map((h) => ({ link: h.entry.key, reversed: h.entry.reverse, speed: +h.speed.toFixed(3), cont: h.continuation }));

test("backpedal start (Ready +1 → Walk -2.925): Walk→Ready played backwards at 2.925", async () => {
  const hops = await run(stub(), READY, 1.0, WALK, -2.925);
  assert.deepEqual(view(hops), [{ link: "Walk>Ready", reversed: true, speed: 2.925, cont: false }]);
});

test("backpedal stop (Walk -2.925 → Ready +1): Ready→Walk played backwards at 1.0", async () => {
  const hops = await run(stub(), WALK, -2.925, READY, 1.0);
  assert.deepEqual(view(hops), [{ link: "Ready>Walk", reversed: true, speed: 1, cont: false }]);
});

test("run → backpedal two-hops through Ready: Run→Ready at 4.5, then Walk→Ready backwards at 2.925", async () => {
  const hops = await run(stub(), RUN, 4.5, WALK, -2.925);
  assert.deepEqual(view(hops), [
    { link: "Run>Ready", reversed: false, speed: 4.5, cont: false },
    { link: "Walk>Ready", reversed: true, speed: 2.925, cont: true },
  ]);
});

test("same-sign changes keep the direct forward link", async () => {
  const hops = await run(stub(), READY, 1.0, RUN, 4.5);
  assert.deepEqual(view(hops), [{ link: "Ready>Run", reversed: false, speed: 4.5, cont: false }]);
});

test("a table with no link yields no hops", async () => {
  const empty = { async _fetchLinkEntry() { return null; } };
  assert.deepEqual(await run(empty, READY, 1.0, WALK, -0.65), []);
});
