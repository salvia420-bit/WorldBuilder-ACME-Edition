// tests/world_use_result.test.mjs — B2-use-items use-1 / use-2 (2026-10-08 round 2).
//
// Retail ItemHolder::UseObject (acclient.c:433354) is the one entry point for
// the 3D double-click (:275702), the toolbar Use (:241619) and the keyboard
// use-selected, and classifies CLIENT-side before it sends anything:
//   use-1  ItemHolder::DetermineUseResult (acclient.c:433086) category 2 —
//          a LOOSE object (no container and not BF_STUCK, or inside the open
//          ground container), not wielded by someone else, not a pack-slot
//          item or container — is PlaceInBackpack (a pickup), never a Use.
//          Our P15 classifier ignored Stuck, so double-clicking a lever (Misc
//          + Stuck, LSD wcid 49591) sent PutItemInContainer; ACE refused it
//          (WeenieError.Stuck) and the lever never pulled. The toolbar /
//          radial Use sent a bare Use for a loose item (ACE: walk over, no
//          pickup).
//   use-2  an object that fails ItemUses::IsUseable sends NOTHING and prints
//          one line (:433528-433563); ACE walks the player to whatever it is
//          sent a Use for, so a peace-mode double-click on a monster ran the
//          player up to it.
// Pins the pure rules (scene3d/target_cycle.js worldUseIsPickup /
// worldUseRejection, plugins/inventory_helpers.js worldUseLeaf) and, by
// source, the wiring in picking.js / target-bar.js / radial-menu.js (DOM +
// three.js, same style as tests/attackable_target.test.mjs).
//
// Run: node tests/world_use_result.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  worldUseIsPickup, isGroundItemType, worldUseRejection, objectIsAttackable,
} from "../scene3d/target_cycle.js";
import { worldUseLeaf } from "../plugins/inventory_helpers.js";

// ACE ItemType / ObjectDescriptionFlag bits.
const IT_MELEE = 0x1, IT_CREATURE = 0x10, IT_MONEY = 0x40, IT_MISC = 0x80, IT_CONTAINER = 0x200;
const ODF_INSCRIBABLE = 0x2, ODF_STUCK = 0x4, ODF_PLAYER = 0x8, ODF_ATTACKABLE = 0x10;
const ODF_DOOR = 0x1000, ODF_REQUIRES_PACKSLOT = 0x800000;
const ME = 0x50000001, OTHER = 0x50000002, CHEST = 0x7A000001;

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("use-1: Stuck fixtures are Used, not picked up (lever, button, Mosswart-style Misc)", () => {
  assert.equal(worldUseIsPickup({ itemType: IT_MISC, objDescFlags: ODF_STUCK }), false, "lever (LSD 49591)");
  assert.equal(worldUseIsPickup({ itemType: IT_MISC, objDescFlags: ODF_STUCK | ODF_ATTACKABLE }), false);
  assert.equal(worldUseIsPickup({ itemType: IT_MISC, objDescFlags: ODF_STUCK | ODF_DOOR }), false, "door");
  // The old P15 type belt alone (`?retailUseResult=off`) took the lever.
  assert.equal(isGroundItemType({ itemType: IT_MISC, objDescFlags: ODF_STUCK }), true);
});

test("use-1: loose items are still picked up (the live dagger ODF 0x12, pyreals)", () => {
  assert.equal(worldUseIsPickup({ itemType: IT_MELEE, objDescFlags: ODF_INSCRIBABLE | ODF_ATTACKABLE }), true,
    "Attackable on an item never blocked a pickup (s7 leg-2, 2026-07-04)");
  assert.equal(worldUseIsPickup({ itemType: IT_MONEY, objDescFlags: 0 }), true);
});

test("use-1: pack-slot items and containers are not category 2", () => {
  assert.equal(worldUseIsPickup({ itemType: IT_MISC, objDescFlags: ODF_REQUIRES_PACKSLOT }), false, "RequiresPackSlot");
  assert.equal(worldUseIsPickup({ itemType: IT_MISC }, { itemsCapacity: 24 }), false, "ItemsCapacity");
  assert.equal(worldUseIsPickup({ itemType: IT_MISC }, { containersCapacity: 7 }), false, "ContainersCapacity");
  assert.equal(worldUseIsPickup({ itemType: IT_CONTAINER }), false, "Container type (component packs: residual gap)");
  assert.equal(worldUseIsPickup({ itemType: IT_CREATURE, objDescFlags: 0 }), false, "creature belt");
});

test("use-1: wielder and container rules", () => {
  const dagger = { itemType: IT_MELEE, objDescFlags: 0x12 };
  assert.equal(worldUseIsPickup(dagger, { wielder: OTHER, me: ME }), false, "someone else's weapon");
  assert.equal(worldUseIsPickup(dagger, { wielder: ME, me: ME }), true, "mine → PlaceInBackpack (unwield)");
  assert.equal(worldUseIsPickup(dagger, { containerId: CHEST, groundObject: CHEST }), true, "in the open chest");
  assert.equal(worldUseIsPickup(dagger, { containerId: CHEST, groundObject: 0 }), false, "in a closed container");
  assert.equal(worldUseIsPickup({ itemType: IT_MELEE, objDescFlags: ODF_STUCK }, { containerId: CHEST, groundObject: CHEST }),
    true, "the open ground container's contents ignore Stuck, as retail");
});

test("use-2: retail ItemHolder::UseObject refusal lines", () => {
  const r = (o) => worldUseRejection({ name: "Thing", ...o });
  // A peace-mode monster (LSD Drudge Skulker 19257: ItemUseable 1, Stuck|Attackable).
  assert.equal(r({ useable: 1, odf: 0x14, attackable: true, inPeace: true, name: "Drudge Skulker" }),
    "To attack Drudge Skulker, click on the dove icon first");
  assert.equal(r({ useable: 1, odf: ODF_STUCK | ODF_DOOR, name: "Door" }), "You can't open or close this Door that way");
  assert.equal(r({ useable: 1, odf: ODF_STUCK, attackable: false, inPeace: false, name: "Statue" }), "The Statue cannot be used");
  assert.equal(r({ useable: 1, odf: ODF_STUCK, attackable: false, inPeace: true, name: "Statue" }), "The Statue cannot be used");
  assert.equal(r({ useable: 1, odf: 0x14, attackable: true, inPeace: false }), "", "melee + attack target → silent, no send");
  assert.equal(r({ useable: 0x20 }), null, "NPC (Remote) → send");
  assert.equal(r({ useable: undefined }), null, "no ItemUseable → retail default 0 → send");
  assert.equal(r({ useable: 0 }), null);
});

test("use-2: the dove line follows retail ObjectIsAttackable, not the raw Attackable bit", () => {
  const me = { itemType: IT_CREATURE, objDescFlags: ODF_PLAYER | ODF_ATTACKABLE };
  // An attackable-flagged lever is Misc: ObjectIsAttackable says no → "cannot be used".
  const lever = { itemType: IT_MISC, objDescFlags: ODF_STUCK | ODF_ATTACKABLE };
  assert.equal(worldUseRejection({ useable: 1, odf: lever.objDescFlags, attackable: objectIsAttackable(lever, me),
    inPeace: true, name: "Lever" }), "The Lever cannot be used");
});

test("worldUseLeaf: throttle first, then pickup, then refusal, then Use", () => {
  const log = [];
  const deps = (o = {}) => ({
    throttleOk: () => true,
    isPickup: () => false,
    pickUp: (g) => log.push(["pickUp", g]),
    refusal: () => null,
    reject: (m) => log.push(["reject", m]),
    use: (g) => log.push(["use", g]),
    ...o,
  });
  assert.equal(worldUseLeaf(7, deps()), "used");
  assert.deepEqual(log.splice(0), [["use", 7]]);
  assert.equal(worldUseLeaf(7, deps({ throttleOk: () => false, isPickup: () => true })), "throttled");
  assert.deepEqual(log.splice(0), [], "a throttled call is dropped silently");
  assert.equal(worldUseLeaf(7, deps({ isPickup: () => true, refusal: () => "nope" })), "pickup");
  assert.deepEqual(log.splice(0), [["pickUp", 7]], "category 2 is decided before IsUseable");
  assert.equal(worldUseLeaf(7, deps({ refusal: () => "The Statue cannot be used" })), "refused");
  assert.deepEqual(log.splice(0), [["reject", "The Statue cannot be used"]]);
  assert.equal(worldUseLeaf(7, deps({ refusal: () => "" })), "refused");
  assert.deepEqual(log.splice(0), [], "silent refusal");
  assert.equal(worldUseLeaf(7, { use: (g) => log.push(["use", g]) }), "used", "no picking.js → plain Use");
  assert.deepEqual(log.splice(0), [["use", 7]]);
  assert.equal(worldUseLeaf(0, deps()), "none");
});

test("picking.js: Stuck is excluded now, and the use branch refuses before it sends", () => {
  const p = src("scene3d/picking.js");
  assert.doesNotMatch(p, /Deliberately NOT\s+(?:\/\/\s*)?Stuck/, "the P15 'Deliberately NOT Stuck' rule is gone");
  assert.match(p, /return worldUseIsPickup\(meta, \{/);
  assert.match(p, /if \(!RETAIL_USE_RESULT\) return isGroundItemType\(meta\);/);
  // The refusal runs on the COMPLETING click only (a single click selects),
  // after the throttle and before the Use send.
  const branch = p.slice(p.indexOf("// use-2 (2026-10-08 round 2): on the completing click"));
  const gate = branch.indexOf("if (doubleClickGate(guid, ev)) {");
  const throttle = branch.indexOf("if (!worldUseThrottleOk()) return;");
  const refuse = branch.indexOf("const refusal = worldUseRefusal(guid);");
  const send = branch.indexOf("sessionHandle.useObject(guid >>> 0);");
  assert.ok(gate >= 0 && gate < throttle && throttle < refuse && refuse < send,
    `order gate < throttle < refusal < send: ${[gate, throttle, refuse, send]}`);
  assert.match(p, /return worldUseRejection\(\{/);
  // Players keep the send (retail result 5 = secure trade), corpses their open.
  assert.match(p, /if \(\(odf & \(ODF_PLAYER \| ODF_CORPSE\)\) !== 0\) return null;/);
  assert.match(p, /window\.__worldUseIsPickup = \(guid\) => RETAIL_USE_RESULT && entityIsGroundItem\(guid\);/);
  assert.match(p, /window\.__worldUseRefusal = worldUseRefusal;/);
});

test("target-bar.js / radial-menu.js: the world Use goes through worldUseLeaf", () => {
  const tb = src("plugins/target-bar.js");
  const onUse = tb.slice(tb.indexOf("function onUseClick()"), tb.indexOf("function examineSelected()"));
  assert.match(onUse, /leaf = worldUseLeaf\(g, \{/);
  assert.match(onUse, /isPickup: window\.__worldUseIsPickup,/);
  assert.match(onUse, /pickUp: window\.__itemDrag\?\.placeInBackpack,/);
  assert.match(onUse, /refusal: window\.__worldUseRefusal,/);
  assert.match(onUse, /if \(route !== "used" \|\| leaf !== "used"\) return;/, "a pickup never opens a book");
  const rm = src("plugins/radial-menu.js");
  assert.match(rm, /label: pickup \? "Pick Up" : isCreature\(ent\) \? "Talk" : "Use",/);
  assert.match(rm, /worldUseLeaf\(guid, \{/);
});
