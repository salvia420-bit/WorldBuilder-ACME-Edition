// tests/ground_container_gate.test.mjs — OpenAC comparison round 5
// (2026-10-08), the external-container window.
//
//   extcontainer-1  retail ClientUISystem::OnViewContents (acclient.c:402688)
//                   opens the window only for the requested ground object: a
//                   world object nothing contains or wields. Sub-packs of an
//                   opened chest and the player's own packs never take it; a
//                   new ground object replaces the old one and the server
//                   hears about the old one (SetGroundObject :401660-401666).
//   extcontainer-2  gmExternalContainerUI's 1 s range handler (:253157,
//                   ObjectsInRange :436730): out of the container's
//                   UseRadius (cylinder distance), or the object gone, closes.
//   extcontainer-4  "The %s is locked" after using a container it cannot open
//                   (AttemptSetGroundObject :432280); BF_OPENABLE follows a
//                   live Locked update (OnStatUpdated :437080-437084).
//
// Pure rules from plugins/ground_container_rules.js, plus container-panel's
// onContainerOpened spliced from source with stubs.
//
// Run: node tests/ground_container_gate.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as R from "../plugins/ground_container_rules.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const ME = 0x50000001;
const CHEST = 0x7a9b4031;
const SUBPACK = 0x80000011;
const CHEST_LB = 0xa9b40031;

test("isLandscapeGroundObject: only an uncontained, unwielded world object", () => {
  assert.equal(R.isLandscapeGroundObject({ landblock: CHEST_LB }), true, "a chest on the ground");
  assert.equal(R.isLandscapeGroundObject({ landblock: 0, containerId: ME }), false, "my own pack");
  assert.equal(R.isLandscapeGroundObject({ landblock: 0, containerId: CHEST }), false, "a pack inside the chest");
  assert.equal(R.isLandscapeGroundObject({ landblock: CHEST_LB, containerId: ME }), false,
    "a picked-up pack that still carries its old landblock");
  assert.equal(R.isLandscapeGroundObject({ landblock: CHEST_LB, wielderId: ME }), false, "wielded");
  assert.equal(R.isLandscapeGroundObject({}), false, "unknown guid");
});

test("replacedGroundObject: the previous ground object, if any other", () => {
  assert.equal(R.replacedGroundObject(0, CHEST), 0);
  assert.equal(R.replacedGroundObject(CHEST, CHEST), 0);
  assert.equal(R.replacedGroundObject(CHEST, 0x7a9b4032), CHEST);
});

test("groundObjectFacts: reads the handle; null without the getters (stale pkg)", () => {
  const h = {
    objectPosition: (g) => (g === CHEST ? [CHEST_LB, 10, 20, 5] : g === SUBPACK ? [0, 0, 0, 0] : []),
    objectInstanceIdProperty: (g, stype) => (g === SUBPACK && stype === 2 ? CHEST : undefined),
  };
  assert.deepEqual(R.groundObjectFacts(h, CHEST), { landblock: CHEST_LB, containerId: 0, wielderId: 0 });
  assert.deepEqual(R.groundObjectFacts(h, SUBPACK), { landblock: 0, containerId: CHEST, wielderId: 0 });
  assert.deepEqual(R.groundObjectFacts(h, 0x1234), { landblock: 0, containerId: 0, wielderId: 0 });
  assert.equal(R.groundObjectFacts({}, CHEST), null);
  assert.equal(R.groundObjectFacts(null, CHEST), null);
});

test("flags: default on; off / 0 / false (any case) disable each", () => {
  for (const [name, fn] of [
    ["groundObjectGate", R.groundObjectGateEnabled],
    ["groundContainerRange", R.groundContainerRangeEnabled],
    ["containerDropRule", R.containerDropRuleEnabled],
    ["lockedContainerNotice", R.lockedContainerNoticeEnabled],
  ]) {
    assert.equal(fn(""), true, name);
    assert.equal(fn(`?${name}=on`), true, name);
    for (const v of ["off", "0", "false", "OFF"]) assert.equal(fn(`?nosw=1&${name}=${v}`), false, `${name}=${v}`);
  }
});

test("range verdict: the corpse numbers (UseRadius 2.0, cylinder distance)", () => {
  const player = { x: 0, y: 0, z: 0 };
  const playerDims = [0.68, 1.8];
  const containerDims = [0.6, 1.2];
  const at = (x) => R.groundContainerRangeVerdict({
    useRadius: 2.0, containerPos: { x, y: 0, z: 0 }, playerPos: player, containerDims, playerDims, seen: true,
  });
  assert.equal(at(3.0), "ok", "3.0 m apart = 1.72 m between the cylinders");
  assert.equal(at(3.28), "ok", "exactly on the use radius");
  assert.equal(at(3.5), "ok", "inside the 0.25 m slack");
  assert.equal(at(3.6), "close", "2.32 m between the cylinders");
});

test("range verdict: unknowns, a missing object, no radius, no sizes", () => {
  const p = { x: 0, y: 0, z: 0 };
  assert.equal(R.groundContainerRangeVerdict({ useRadius: 1, containerPos: p, playerPos: null }), "unknown");
  assert.equal(R.groundContainerRangeVerdict({ useRadius: 1, containerPos: null, playerPos: p, seen: false }), "unknown",
    "not seen yet: its position may still be on the way");
  assert.equal(R.groundContainerRangeVerdict({ useRadius: 1, containerPos: null, playerPos: p, seen: true }), "close",
    "gone (ObjectsInRange fails on a missing object)");
  // No UseRadius: ACE's 0.6 m default; no sizes: centre distance with slack.
  const noDims = (x, useRadius) => R.groundContainerRangeVerdict({
    useRadius, containerPos: { x, y: 0, z: 0 }, playerPos: p, containerDims: [], playerDims: [0, 0], seen: true,
  });
  assert.equal(noDims(2.0, undefined), "ok", "0.6 + 1.5 slack");
  assert.equal(noDims(2.2, undefined), "close");
  assert.equal(noDims(3.0, 2.0), "ok");
  assert.equal(noDims(3.6, 2.0), "close");
});

test("landblockToWorld: landblock-local Z-up to world; null when unplaced", () => {
  assert.deepEqual(R.landblockToWorld([0xa9b40031, 10, 20, 5]), { x: 0xa9 * 192 + 10, y: 0xb4 * 192 + 20, z: 5 });
  assert.equal(R.landblockToWorld([0, 1, 2, 3]), null);
  assert.equal(R.landblockToWorld([]), null);
  assert.equal(R.landblockToWorld(null), null);
});

test("containerOpenable / isContainerObject: the live Locked update wins", () => {
  assert.equal(R.containerOpenable(1, undefined), true);
  assert.equal(R.containerOpenable(0, undefined), false);
  assert.equal(R.containerOpenable(0, false), true, "unlocked after creation");
  assert.equal(R.containerOpenable(1, true), false, "locked after creation");
  assert.equal(R.isContainerObject({ itemsCapacity: 120 }), true);
  assert.equal(R.isContainerObject({ containersCapacity: 1 }), true);
  assert.equal(R.isContainerObject({ odf: 0x00800000 }), true, "BF_REQUIRES_PACKSLOT");
  assert.equal(R.isContainerObject({ odf: 0x10 }), false);
});

test("groundContainerUseNotice: only for a locked, unowned, useable container", () => {
  const chest = { isContainer: true, owned: false, useable: 32, openable: false, isCreature: false, name: "Chest" };
  assert.equal(R.groundContainerUseNotice(chest), "The Chest is locked");
  assert.equal(R.groundContainerUseNotice({ ...chest, useable: undefined }), "The Chest is locked",
    "no ItemUseable is usable (ItemUses::IsUseable)");
  assert.equal(R.groundContainerUseNotice({ ...chest, openable: true }), null);
  assert.equal(R.groundContainerUseNotice({ ...chest, owned: true }), null);
  assert.equal(R.groundContainerUseNotice({ ...chest, isCreature: true }), null);
  assert.equal(R.groundContainerUseNotice({ ...chest, useable: 0x00100008 }), null, "a targeted use");
  assert.equal(R.groundContainerUseNotice({ ...chest, useable: 1 }), null, "USEABLE_NO");
  assert.equal(R.groundContainerUseNotice({ ...chest, isContainer: false }), null);
  assert.equal(R.groundContainerUseNotice({ ...chest, name: "" }), "The container is locked");
});

/** Extract `function name(...) { ... }` from `text` by brace matching. */
function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`${name}: unbalanced braces`);
}

/** container-panel's onContainerOpened with a stub window / handle. */
function loadOnContainerOpened({ handle, lootBar = null, gate = true }) {
  const body = extractFunction(src("plugins/container-panel.js"), "onContainerOpened");
  const log = { opened: [], noLonger: [], emitted: [] };
  const win = {
    __sessionHandle: handle && {
      ...handle,
      noLongerViewingContents: (g) => log.noLonger.push(g >>> 0),
    },
    __corpseLootBar: lootBar,
    __pluginClient: { events: { emit: (name, p) => log.emitted.push([name, p]) } },
  };
  const factory = new Function(
    "window", "groundObjectGateEnabled", "groundObjectFacts", "isLandscapeGroundObject",
    "replacedGroundObject", "openGround", "console",
    `${body}\nreturn onContainerOpened;`,
  );
  const fn = factory(
    win, () => gate, R.groundObjectFacts, R.isLandscapeGroundObject, R.replacedGroundObject,
    (g, name) => log.opened.push([g >>> 0, name]), { info() {} },
  );
  return { fn, log };
}

const worldHandle = {
  objectPosition: (g) => ({ [CHEST]: [CHEST_LB, 1, 1, 0], 0x7a9b4032: [CHEST_LB, 5, 5, 0] }[g] ?? [0, 0, 0, 0]),
  objectInstanceIdProperty: (g, stype) => (stype === 2 ? ({ [SUBPACK]: CHEST, 0x80000022: ME }[g]) : undefined),
};
const ev = (guid, name = "Chest") => ({ detail: { u32Payload: guid, stringPayload: name } });

test("onContainerOpened: a chest opens the window; its sub-pack and my own pack do not", () => {
  const { fn, log } = loadOnContainerOpened({ handle: worldHandle });
  fn(ev(CHEST));
  fn(ev(SUBPACK, "Pack"));
  fn(ev(0x80000022, "Pack"));
  assert.deepEqual(log.opened, [[CHEST, "Chest"]]);
  assert.deepEqual(log.emitted, [["groundObjectOpened", { guid: CHEST }]], "the vendor window is told");
  assert.deepEqual(log.noLonger, []);
});

test("onContainerOpened: chest B replaces chest A and the server hears about A once", () => {
  const lootBar = { isOpen: () => true, current: () => CHEST };
  const { fn, log } = loadOnContainerOpened({ handle: worldHandle, lootBar });
  fn(ev(0x7a9b4032, "Chest"));
  assert.deepEqual(log.noLonger, [CHEST]);
  fn(ev(CHEST, "Chest")); // the same object again: nothing to release
  assert.deepEqual(log.noLonger, [CHEST]);
});

test("onContainerOpened: fail-open on a stale pkg; ?groundObjectGate=off opens everything", () => {
  const stale = loadOnContainerOpened({ handle: {} });
  stale.fn(ev(SUBPACK, "Pack"));
  assert.deepEqual(stale.log.opened, [[SUBPACK, "Pack"]]);
  const off = loadOnContainerOpened({ handle: worldHandle, gate: false });
  off.fn(ev(SUBPACK, "Pack"));
  assert.deepEqual(off.log.opened, [[SUBPACK, "Pack"]]);
});

test("wiring: the loot window polls the range, and closes on vendor / portal / death", () => {
  const bar = src("plugins/corpse-loot-bar.js");
  assert.match(bar, /groundContainerRangeVerdict\(/);
  assert.match(bar, /client\.events\.on\("vendorOpened", onVendorOpenedCloseGround\)/);
  assert.match(bar, /client\.events\.on\("kind:12", onVendorOpenedCloseGround\)/);
  assert.match(bar, /client\.events\.on\("portalSpaceEntered", onPortalSpaceCloseGround\)/);
  assert.match(bar, /client\.events\.on\("death", onDeathCloseGround\)/);
  assert.match(src("plugins/vendor-ui.js"), /client\.events\.on\("groundObjectOpened", onGroundObjectOpened\)/);
  const picking = src("scene3d/picking.js");
  assert.match(picking, /window\.__worldUseNotice = worldUseNotice/);
  // The notice follows the Use (ACE still plays the lock sound).
  const send = picking.indexOf("sessionHandle.useObject(guid >>> 0);\n            const notice = worldUseNotice(guid);");
  assert.ok(send > 0, "worldUseNotice runs right after the Use is sent");
});

// extcontainer-5 (2026-10-09): retail gmExternalContainerUI's container row.
test("externalContainerView: packs in the container row, the open container's items in the strip", () => {
  const pack = { guid: SUBPACK, itemType: 0x200 };
  const a = { guid: 0x80000021, itemType: 0x8 };
  const b = { guid: 0x80000022, itemType: 0x800 };
  const n1 = { guid: 0x80000031, itemType: 0x8 };
  const rootItems = [pack, a, b];
  const onRoot = R.externalContainerView({ root: CHEST, rootItems });
  assert.deepEqual(onRoot.packs, [pack]);
  assert.deepEqual(onRoot.items, [a, b], "packs are not in the item strip");
  assert.equal(onRoot.open, CHEST);
  const onPack = R.externalContainerView({ root: CHEST, openSub: SUBPACK, rootItems, subItems: [n1] });
  assert.equal(onPack.open, SUBPACK);
  assert.deepEqual(onPack.items, [n1]);
  assert.deepEqual(onPack.packs, [pack], "the row keeps every pack");
  // The open pack left the ground object: retail ItemList_OpenFirstContainer.
  const gone = R.externalContainerView({ root: CHEST, openSub: SUBPACK, rootItems: [a, b], subItems: [n1] });
  assert.equal(gone.open, CHEST);
  assert.deepEqual(gone.items, [a, b]);
  assert.deepEqual(R.externalContainerView({ root: CHEST, openSub: CHEST, rootItems }).open, CHEST);
  assert.deepEqual(R.externalContainerView({ root: CHEST, openSub: SUBPACK, rootItems, subItems: null }).items, [],
    "an open pack whose contents are not cached shows empty, not the chest");
  assert.equal(R.isPackMeta({ itemType: 0x200 }), true);
  assert.equal(R.isPackMeta({ itemType: 0x8 }), false);
  assert.equal(R.isPackMeta(null), false);
});

test("extNestedPacksEnabled: default on, =off / 0 / false escapes", () => {
  assert.equal(R.extNestedPacksEnabled(""), true);
  assert.equal(R.extNestedPacksEnabled("?extNestedPacks=on"), true);
  for (const v of ["off", "0", "false"]) assert.equal(R.extNestedPacksEnabled(`?extNestedPacks=${v}`), false);
});
