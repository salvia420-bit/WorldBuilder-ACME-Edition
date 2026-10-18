// tests/entity_icon_inventory_free.test.mjs — 2026-10-18 review fix pass
// (PLUGINS-A-4 class: wasm boxes from playerInventory() never freed).
//
// resolveItemIcon falls back to lookupItemIconId, which walked
// `handle.playerInventory()` (one wasm box per row) and left every box to the
// FinalizationRegistry. The hotbar's icon refresh reaches it once per slot
// whose item the entity store cannot describe yet, and that refresh now runs
// on a normal boot (PLUGINS-A-1). Every row box must be freed, on a hit and on
// a miss.
//
// Run: node tests/entity_icon_inventory_free.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window ?? globalThis;
const { resolveItemIcon } = await import("../ui/ac_entity_icon.js");

function boxedInventory(rows) {
  const boxes = [];
  return {
    boxes,
    playerInventory() {
      const out = rows.map((r) => {
        const b = { ...r, freed: false, free() { this.freed = true; } };
        boxes.push(b);
        return b;
      });
      return out;
    },
  };
}

test("every playerInventory() box is freed by the icon lookup (hit and miss)", async () => {
  const handle = boxedInventory([
    { guid: 0x5000_0001, iconId: 0x0600_1111 },
    { guid: 0x5000_0002, iconId: 0x0600_2222 },
    { guid: 0x5000_0003, iconId: 0x0600_3333 },
  ]);
  window.__sessionHandle = handle;
  try {
    await resolveItemIcon(0x5000_0002); // hit: returns early from inside the walk
    await resolveItemIcon(0x5000_0099); // miss: walks every row
    assert.ok(handle.boxes.length >= 6, `the lookup read the inventory twice (${handle.boxes.length} boxes)`);
    const leaked = handle.boxes.filter((b) => !b.freed).length;
    assert.equal(leaked, 0, `${leaked} of ${handle.boxes.length} inventory boxes left unfreed`);
  } finally {
    delete window.__sessionHandle;
  }
});
