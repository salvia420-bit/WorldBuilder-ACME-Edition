// tests/attackable_target.test.mjs — owner report 2026-10-05: "doors are fine,
// I can attack them though, view OpenAC to see their behavior".
//
// Retail gates every attack on ClientCombatSystem::ObjectIsAttackable
// (acclient.c:407410; ExecuteAttack drops a failing target at :408640), and
// OpenAC ports it as SelectedObjectHealthPolicy.ObjectIsAttackable. The first
// test is ItemType.Creature, so a door (ItemType Misc, ODF Door, sometimes
// Attackable too) is never a combat target. A combat-stance click on it takes
// the use path instead (ItemHolder::UseObject, acclient.c:433545).
//
// Pins the pure policy (scene3d/target_cycle.js objectIsAttackable) on
// ACE-shaped metas, plus the picking.js wiring (DOM + three.js, so source
// assertions in the same style as tests/target_cycle.test.cjs).
//
// Run: node tests/attackable_target.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { objectIsAttackable } from "../scene3d/target_cycle.js";

// ACE ItemType / ObjectDescriptionFlag bits.
const IT_CREATURE = 0x10, IT_MISC = 0x80, IT_CONTAINER = 0x200;
const IT_MELEE = 0x1;
const ODF_STUCK = 0x4, ODF_PLAYER = 0x8, ODF_ATTACKABLE = 0x10, ODF_PK = 0x20;
const ODF_DOOR = 0x1000, ODF_FREE_PK = 0x200000, ODF_PKLITE = 0x2000000;

const me = { itemType: IT_CREATURE, objDescFlags: ODF_PLAYER | ODF_ATTACKABLE };

test("doors are never attackable, with or without ACE's Attackable bit", () => {
  assert.equal(objectIsAttackable({ itemType: IT_MISC, objDescFlags: ODF_STUCK | ODF_DOOR }, me), false);
  assert.equal(
    objectIsAttackable({ itemType: IT_MISC, objDescFlags: ODF_STUCK | ODF_DOOR | ODF_ATTACKABLE }, me),
    false, "Attackable alone is not enough: retail checks ItemType.Creature first");
});

test("other non-creatures are not attackable (chests, loose items)", () => {
  assert.equal(objectIsAttackable({ itemType: IT_CONTAINER, objDescFlags: ODF_STUCK | ODF_ATTACKABLE }, me), false);
  assert.equal(objectIsAttackable({ itemType: IT_MELEE, objDescFlags: 0x12 }, me), false, "live dagger ODF 0x12");
});

test("monsters are attackable; non-attackable NPCs are not", () => {
  assert.equal(objectIsAttackable({ itemType: IT_CREATURE, objDescFlags: ODF_STUCK | ODF_ATTACKABLE }, me), true);
  assert.equal(objectIsAttackable({ itemType: IT_CREATURE, objDescFlags: ODF_STUCK }, me), false, "town NPC");
  assert.equal(
    objectIsAttackable({ itemType: IT_CREATURE, objDescFlags: ODF_ATTACKABLE, petOwner: 0x50000001 }, me),
    false, "owned pet");
});

test("players: PK vs PK and PK-lite vs PK-lite only, free-PK always", () => {
  const npk = { itemType: IT_CREATURE, objDescFlags: ODF_PLAYER | ODF_ATTACKABLE };
  const pk = { itemType: IT_CREATURE, objDescFlags: ODF_PLAYER | ODF_PK };
  const pkl = { itemType: IT_CREATURE, objDescFlags: ODF_PLAYER | ODF_PKLITE };
  assert.equal(objectIsAttackable(npk, me), false, "non-PK player");
  assert.equal(objectIsAttackable(pk, me), false, "PK target, non-PK me");
  assert.equal(objectIsAttackable(pk, pk), true);
  assert.equal(objectIsAttackable(pkl, pkl), true);
  assert.equal(objectIsAttackable(pkl, pk), false);
  assert.equal(objectIsAttackable({ ...npk, objDescFlags: ODF_PLAYER | ODF_FREE_PK }, me), true);
  assert.equal(objectIsAttackable(npk, { objDescFlags: ODF_PLAYER | ODF_FREE_PK }), true);
});

test("unknown target is not attackable", () => {
  assert.equal(objectIsAttackable(null, me), false);
  assert.equal(objectIsAttackable({}, me), false);
});

test("picking.js gates the attack and routes non-attackable clicks to use", () => {
  const src = readFileSync(new URL("../scene3d/picking.js", import.meta.url), "utf8");
  // (2026-10-08 round 2: the import list grew — B2-use-items world Use rules.)
  assert.match(src, /import \{[^}]*\bobjectIsAttackable, itemIsUseable\b[^}]*\} from "\.\/target_cycle\.js";/);
  // fireAttackOnSelectedTarget refuses before any wire send.
  const fire = src.slice(src.indexOf("function fireAttackOnSelectedTarget("));
  const gate = fire.indexOf("if (targetGuid === 0 || !entityIsAttackableTarget(targetGuid))");
  assert.ok(gate > 0, "attack gate present");
  assert.ok(gate < fire.indexOf("missileAttack("), "gate precedes the missile send");
  assert.ok(gate < fire.indexOf("const fireOnce"), "gate precedes the melee/missile senders");
  assert.match(fire, /You must select a valid combat target before attacking/);
  // Combat-stance click: only an attackable target stays on the select-only
  // branch; a door falls through to the double-click useObject branch.
  assert.match(src,
    /\} else if \(\(isInMeleeStance\?\.\(\) \|\| isInRangedStance\?\.\(\)\) && entityIsAttackableTarget\(guid\)\) \{/);
  // Bug 9 (2026-10-07): a usable non-attackable object (the Reformed Bandit)
  // skips the magic branch, so a magic-stance double-click Uses it (retail
  // ItemHolder::UseObject in every stance); and an armed spell only blocks a
  // double-click on an ATTACK target.
  assert.match(src, /const usableNonTarget = !entityIsAttackableTarget\(guid\) && entityIsUsable\(guid\);/);
  assert.match(src, /isInMagicStance\?\.\(\) && typeof sessionHandle\.castTargetedSpell === "function" && !usableNonTarget\)/);
  assert.match(src, /&& !isInMagicStance\?\.\(\) && entityIsAttackableTarget\(guid\)\) \{\s*emitActionRejected\("Enter magic mode to cast that spell\."\);/);
});

test("bug 9/10: retail Use and health-meter policies (target_cycle.js)", async () => {
  const tc = await import("../scene3d/target_cycle.js");
  // ItemUses::IsUseable — bit 0 (USEABLE_NO) clear = usable; absent = usable.
  assert.equal(tc.itemIsUseable(0x20), true);  // Reformed Bandit: Remote
  assert.equal(tc.itemIsUseable(1), false);    // monsters: No
  assert.equal(tc.itemIsUseable(undefined), true);
  // gmToolbarUI::HandleSelectionChanged — players, pets, attackable only.
  const me = { objDescFlags: ODF_PLAYER };
  assert.equal(tc.shouldQueryHealth({ itemType: 0x10, objDescFlags: 0x14 }, me), true);   // drudge / hollow minion
  assert.equal(tc.shouldQueryHealth({ itemType: 0x10, objDescFlags: 0x04 }, me), false);  // Reformed Bandit
  assert.equal(tc.shouldQueryHealth({ itemType: 0x10, objDescFlags: 0x08 }, me), true);   // another player
  assert.equal(tc.shouldQueryHealth({ itemType: 0x10, objDescFlags: 0x04, petOwner: 0x50000002 }, me), true);
  assert.equal(tc.shouldQueryHealth(null, me), false);
});

// selection-6 (2026-10-08) — retail ClientCombatSystem::GetAttackTarget
// (acclient.c:407570-407597): a selected wielded item is attacked through its
// wielder (CPhysicsObj::parent), an item the player owns attacks nobody, and
// ExecuteAttack (:408626-408660) prints one line for no / invalid target.
test("resolveAttackTarget: wielder redirect, owned items, plain targets", async () => {
  const { resolveAttackTarget } = await import("../scene3d/target_cycle.js");
  const ME = 0x50000001, MOB = 0x80000001, SWORD = 0x80000002;
  const r = (o) => resolveAttackTarget({ me: ME, ownerContainer: 0, ownerWielder: 0,
    attachedParentGuid: 0, parentKnown: false, ...o });
  assert.equal(r({ sel: SWORD, attachedParentGuid: MOB, parentKnown: true }), MOB, "monster's weapon → monster");
  assert.equal(r({ sel: SWORD, attachedParentGuid: MOB, parentKnown: false }), 0, "wielder unknown → nobody");
  assert.equal(r({ sel: SWORD, ownerWielder: ME, attachedParentGuid: ME, parentKnown: true }), 0, "my own wielded weapon");
  assert.equal(r({ sel: SWORD, ownerContainer: ME }), 0, "an item in my pack");
  assert.equal(r({ sel: MOB }), MOB, "a plain monster");
  assert.equal(r({ sel: 0 }), 0, "nothing selected");
});

test("picking.js attacks the resolved target and uses retail's single refusal line", () => {
  const src = readFileSync(new URL("../scene3d/picking.js", import.meta.url), "utf8");
  const fire = src.slice(src.indexOf("function fireAttackOnSelectedTarget("));
  const head = fire.slice(0, fire.indexOf("const cb = window.__combatBarState;"));
  assert.doesNotMatch(head, /Select a target first\./);
  const resolve = head.indexOf("em.attackTargetFor(selGuid)");
  const gate = head.indexOf("if (targetGuid === 0 || !entityIsAttackableTarget(targetGuid))");
  assert.ok(resolve > 0 && gate > resolve, "resolve the attack target before the gate");
  const ent = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  assert.match(ent, /^  attackTargetFor\(guid\) \{/m);
  assert.match(ent, /return resolveAttackTarget\(\{/);
});
