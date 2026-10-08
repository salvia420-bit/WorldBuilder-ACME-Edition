// blip_color.test.mjs — the selection bracket must be tinted by the RADAR
// BLIP colour, and the server's `_blipColor` byte must beat everything else.
//
// 2026-08-02. `blipColorForEntity` transcribed retail's `gmRadarUI::GetBlipColor`
// (acclient.c:262708) correctly, but two of its inputs were never wired, so two
// whole branches were dead:
//
//   1. `_blipColor` (`PublicWeenieDesc::_blipColor`, PropertyInt::RadarBlipColor
//      95). The protocol crate parsed it (description.rs:455) and
//      holtburger-world hydrated it (hydration.rs:143), but nothing surfaced it
//      to JS — so `meta.radarBlipColor` was always undefined and the `idx !== 0`
//      short-circuit at :262726 could never fire. Every lifestone and every NPC
//      fell through to the type ladder and got the default/gold instead of the
//      BLUE and YELLOW retail shows. Now fed by `SessionHandle::entityRadarBlipColor`.
//
//   2. the fellowship leader/fellow override (:262841-262853), which retail
//      applies LAST — after Portal/Vendor/Creature/PK/Admin all resolve — so a
//      fellow who is also a PK still blips fellowship green.
//
// 2026-10-08 round 2:
//   radar-2 — GetBlipColor's Creature arm is `BF_ATTACKABLE && IsCreature()
//      && !IsPlayer()` (:262788) where IsCreature = vfptr[11] =
//      ACCWeenieObject::IsCreature (:436879) = InqType() & TYPE_CREATURE, the
//      ITEM TYPE. Old code read it as the 0x10 ODF bit, so every attackable
//      ACE item (weapons, chests, doors) wore gold brackets instead of white.
//   radar-3 — `resolveRadarLook` reads the LIVE wasm flags and int 95
//      (ACCWeenieObject::OnStatUpdated :438779 / :438785) instead of the spawn
//      meta, which kept another player's PK colour from spawn time forever.
//
// Run: node tests/blip_color.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { blipColorForEntity, BLIP_COLOR, resolveRadarLook } from "../scene3d/selection_brackets.js";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
};

// ObjectDescriptionFlag bits, mirrored from the module under test.
const BF_PLAYER = 0x00000008;
const BF_ATTACKABLE = 0x00000010;
const BF_PLAYER_KILLER = 0x00000020;
const BF_UI_HIDDEN = 0x00000080;
const BF_VENDOR = 0x00000200;
const BF_PORTAL = 0x00040000;

// ItemType bits (ACE ItemType.cs): TYPE_CREATURE, and an ACE melee weapon.
const TYPE_CREATURE = 0x10;
const TYPE_MELEE_WEAPON = 0x1;

const ent = (meta) => ({ meta });

// ── 1. the server-sent `_blipColor` short-circuit (:262726) ────────────────

test("blipColor 1 (LifeStone) paints BLUE even with no flags at all", () => {
  assert.equal(blipColorForEntity(ent({ radarBlipColor: 1 })), "#40a8ff");
});

test("blipColor 8 (NPC) paints YELLOW", () => {
  assert.equal(blipColorForEntity(ent({ radarBlipColor: 8 })), "#ffff80");
});

test("blipColor BEATS the attackable-creature branch", () => {
  // Without the byte this entity is a Creature (gold). With it, blue wins.
  const flags = BF_ATTACKABLE;
  assert.equal(blipColorForEntity(ent({ objDescFlags: flags, itemType: TYPE_CREATURE })), BLIP_COLOR.Creature);
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: flags, itemType: TYPE_CREATURE, radarBlipColor: 1 })),
    "#40a8ff",
  );
});

test("blipColor BEATS the portal and vendor branches", () => {
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_PORTAL, radarBlipColor: 5 })),
    "#ff4063", // Red
  );
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_VENDOR, radarBlipColor: 9 })),
    "#00ffff", // Cyan
  );
});

test("blipColor 0 is the sentinel — falls through to the type ladder", () => {
  // This is what an absent/unknown guid reads as from the wasm accessor, and
  // it MUST be indistinguishable from never having been wired.
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_PORTAL, radarBlipColor: 0 })),
    BLIP_COLOR.Portal,
  );
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_PORTAL })),
    BLIP_COLOR.Portal,
  );
});

test("ACE's RadarColor.BrightGreen (0x10) maps like retail's case 10", () => {
  assert.equal(blipColorForEntity(ent({ radarBlipColor: 16 })), "#00ff00");
  assert.equal(blipColorForEntity(ent({ radarBlipColor: 10 })), "#00ff00");
});

test("an out-of-range blipColor falls to Default, not to the type ladder", () => {
  // Retail's switch has a `default:` arm that yields the default colour; it
  // does NOT resume the ladder below.
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_PORTAL, radarBlipColor: 99 })),
    BLIP_COLOR.Default,
  );
});

test("UI-hidden still wins over blipColor (:262721 precedes :262726)", () => {
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_UI_HIDDEN, radarBlipColor: 1 })),
    BLIP_COLOR.Default,
  );
});

// ── 2. the fellowship override (:262841-262853) ────────────────────────────

const roster = { leaderGuid: 0x500a, members: new Set([0x500a, 0x500b]) };

test("fellowship leader paints FellowshipLeader green", () => {
  assert.equal(
    blipColorForEntity(ent({ guid: 0x500a, objDescFlags: BF_PLAYER }), roster),
    BLIP_COLOR.FellowshipLeader,
  );
});

test("plain fellow paints Fellowship green", () => {
  assert.equal(
    blipColorForEntity(ent({ guid: 0x500b, objDescFlags: BF_PLAYER }), roster),
    BLIP_COLOR.Fellowship,
  );
});

test("fellowship BEATS the PK branch (retail applies it last)", () => {
  const flags = BF_PLAYER | BF_PLAYER_KILLER;
  assert.equal(
    blipColorForEntity(ent({ guid: 0x500b, objDescFlags: flags })),
    BLIP_COLOR.PlayerKiller,
  );
  assert.equal(
    blipColorForEntity(ent({ guid: 0x500b, objDescFlags: flags }), roster),
    BLIP_COLOR.Fellowship,
  );
});

test("a non-fellow is unaffected by the roster", () => {
  assert.equal(
    blipColorForEntity(ent({ guid: 0x5099, objDescFlags: BF_PORTAL }), roster),
    BLIP_COLOR.Portal,
  );
});

test("fellowship does NOT override an explicit _blipColor (switch returns first)", () => {
  assert.equal(
    blipColorForEntity(
      ent({ guid: 0x500a, objDescFlags: BF_PLAYER, radarBlipColor: 1 }),
      roster,
    ),
    "#40a8ff",
  );
});

test("omitting the roster is a no-op (back-compat with the 1-arg call)", () => {
  assert.equal(
    blipColorForEntity(ent({ guid: 0x500a, objDescFlags: BF_PORTAL })),
    BLIP_COLOR.Portal,
  );
});

test("guid 0 never matches a roster entry", () => {
  const zeroRoster = { leaderGuid: 0, members: new Set([0]) };
  assert.equal(
    blipColorForEntity(ent({ guid: 0, objDescFlags: BF_PORTAL }), zeroRoster),
    BLIP_COLOR.Portal,
  );
});

// ── 3. radar-2: IsCreature is the ITEM TYPE (:262788 → :436879) ────────────

test("an attackable ACE item (weapon) is Default white, not Creature gold", () => {
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_ATTACKABLE, itemType: TYPE_MELEE_WEAPON })),
    BLIP_COLOR.Default,
  );
  assert.equal(blipColorForEntity(ent({ objDescFlags: BF_ATTACKABLE })), BLIP_COLOR.Default,
    "no itemType ⇒ not a creature");
});

test("Creature needs attackable AND TYPE_CREATURE AND not a player", () => {
  assert.equal(blipColorForEntity(ent({ objDescFlags: BF_ATTACKABLE, itemType: TYPE_CREATURE })),
    BLIP_COLOR.Creature);
  assert.equal(blipColorForEntity(ent({ objDescFlags: 0, itemType: TYPE_CREATURE })),
    BLIP_COLOR.Default, "a non-attackable NPC");
  assert.equal(
    blipColorForEntity(ent({ objDescFlags: BF_ATTACKABLE | BF_PLAYER, itemType: TYPE_CREATURE })),
    BLIP_COLOR.Default, "a non-PK player");
});

// ── 4. radar-3: resolveRadarLook reads the live wasm state ─────────────────

const ODF_PK_PLAYER = BF_PLAYER | BF_PLAYER_KILLER;

test("live flags beat the stale spawn meta (a PK altar after spawn)", () => {
  const sh = { objectDescFlags: () => ODF_PK_PLAYER, objectIntProperty: () => undefined };
  const look = resolveRadarLook(sh, 5, { objDescFlags: BF_PLAYER });
  assert.equal(look.odf, ODF_PK_PLAYER);
  assert.equal(
    blipColorForEntity({ guid: 5, meta: { objDescFlags: look.odf, radarBlipColor: look.blipColor } }),
    BLIP_COLOR.PlayerKiller,
  );
});

test("unknown wasm guid (flags 0) falls back to the meta", () => {
  const sh = { objectDescFlags: () => 0, objectIntProperty: () => undefined };
  assert.equal(resolveRadarLook(sh, 5, { objDescFlags: BF_PORTAL }).odf, BF_PORTAL);
});

test("live RadarBlipColor (int 95) beats the meta; unset int falls back", () => {
  const sh = {
    objectDescFlags: () => BF_PLAYER,
    objectIntProperty: (g, s) => (s === 95 ? 8 : undefined),
    entityRadarBlipColor: () => 1,
  };
  assert.equal(resolveRadarLook(sh, 5, { radarBlipColor: 0 }).blipColor, 8);
  const unset = { ...sh, objectIntProperty: () => undefined };
  assert.equal(resolveRadarLook(unset, 5, { radarBlipColor: 3 }).blipColor, 3, "meta first");
  assert.equal(resolveRadarLook(unset, 5, {}).blipColor, 1, "then the spawn index");
});

test("stale pkg/ (no exports) passes the meta through; no handle → zeros", () => {
  assert.deepEqual(resolveRadarLook({}, 5, { objDescFlags: 0x10, radarBlipColor: 1 }),
    { odf: 0x10, blipColor: 1 });
  assert.deepEqual(resolveRadarLook(null, 5, null), { odf: 0, blipColor: 0 });
});

test("a throwing export degrades to the meta", () => {
  const sh = { objectDescFlags: () => { throw new Error("freed"); }, objectIntProperty: () => { throw new Error("freed"); } };
  assert.deepEqual(resolveRadarLook(sh, 5, { objDescFlags: 0x8, radarBlipColor: 2 }), { odf: 0x8, blipColor: 2 });
});

test("?radarLiveFlags=off (live=false) restores meta-first reads", () => {
  const sh = { objectDescFlags: () => ODF_PK_PLAYER, objectIntProperty: () => 8, entityRadarBlipColor: () => 4 };
  assert.deepEqual(resolveRadarLook(sh, 5, { objDescFlags: BF_PLAYER }, false), { odf: BF_PLAYER, blipColor: 4 });
});

console.log(`blip_color: ${passed} passed${process.exitCode ? " (with failures)" : ""}`);
