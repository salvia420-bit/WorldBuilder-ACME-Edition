// tests/use_target_self_pick.test.mjs — usetarget-3 (2026-10-18).
//
// Owner: "healing kits told me to select something but when i pressed them on
// my character, it didn't heal me." scene3d/picking.js pickEntityAt left the
// local player out of the pick map ("so you can't pick yourself", #18), so a
// click on your own body with a kit armed found nothing or what stood behind.
//
// Retail's render pick tests every drawn part with an object id — the
// player's too (CPhysicsPart::Draw sets check_curr_object, acclient.c:314614;
// Render::GetMouseSelectionObjectID :380089) — and a target-mode click hands
// the find to ItemHolder::TargetAcquired (:433578), which accepts the player
// for a kit (ItemUseable 0x220008: target REMOTE|SELF; TargetType Creature).
// Here the self pick is taken ONLY while a use-on-target waits and only when
// Rust canUseWith says the item may be used on you: a normal click still steps
// past your own back (the follow camera puts it under the screen centre).
//
// CONTRACT (the REAL picking.js spliced with explicit stubs, real three.js
// math with a stubbed Raycaster hit list, as test_picking_resolve.mjs):
//   [1] no target mode: the local rig is stepped past (#18 unchanged);
//   [2] a kit awaiting its target: the nearest hit wins, yourself included;
//       a click on yourself resolves the target on the player; the hover
//       reticule turns green over you;
//   [3] an item that cannot target you (a lockpick): still stepped past;
//   [4] a hidden local rig (first person) stays unpickable;
//   [5] `?useTargetSelfPick=off` restores the old pick.
//
// Run from apps/holtburger-web/:  node tests/use_target_self_pick.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const require = createRequire(import.meta.url);
let threePath = null;
try { threePath = require.resolve("three"); } catch (_) { threePath = null; }
if (!threePath) {
  console.log("use_target_self_pick: SKIP (three not located)");
  process.exit(0);
}
const THREE = await import(pathToFileURL(threePath).href);
const pickMath = await import(pathToFileURL(path.join(APP, "scene3d", "pick_math.js")).href);
globalThis.__PM = pickMath;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

// ── picking.js, spliced (every import explicit; none of these run on the
//    pick / target-click paths under test) ─────────────────────────────────
const STUBS = {
  getCombatManeuver: "() => 0",
  loadCombatManeuverTable: "() => {}",
  ATTACK_TYPE: "({ Undef: 0, Punch: 0x01, Slash: 0x04, Kick: 0x08 })",
  inferAttackTypeForWeapon: "() => 0",
  resolveAttackTypeForStance: "() => 0",
  isThrustSlashAttackType: "() => false",
  getAimLevelForVelocity: "() => 0",
  getAimLevelForBallisticArc: "() => 0",
  isAttackerBehindDefender: "() => false",
  classifySpell: "() => null",
  readBusyCount: "() => 0",
  getInputFunnel: "() => { throw new Error('funnel not used'); }",
  inputFunnelV2On: "() => false",
  movementKeyOf: "() => ''",
  pickSkillLevel: "() => 0",
  determineSpellRange: "() => 0",
  decideRangeWarn: "() => null",
  faceDeadzoneRad: "() => 0.05",
  faceTurnStep: "() => 0",
  serverTurnOwnsFacing: "() => false",
  objectIsAttackable: "() => false",
  itemIsUseable: "() => false",
  isGroundItemType: "() => false",
  worldUseIsPickup: "() => false",
  worldUseRejection: "() => null",
  consumeWorldUseThrottle: "() => true",
  ODF_PLAYER: "0x8",
  ODF_CORPSE: "0x2000",
  readAttackMeta: "() => null",
  altarConfirmText: "() => null",
  containerOpenable: "() => true",
  groundContainerUseNotice: "() => null",
  isContainerObject: "() => false",
  lockedContainerNoticeEnabled: "() => false",
  pickNearestSphereHit: "globalThis.__PM.pickNearestSphereHit",
  SEARCH_REASON: "({ MouseOver: 1, Select: 2, TargetedUse: 7 })",
  selectionFlashEnabled: "() => false",
  getAttackCharge: "() => 0",
  createAttackRepeatState: "() => null",
  attackRepeatStateEnabled: "() => false",
  escapeActionEnabled: "() => false",
  installEscapeAction: "() => null",
};
const pickingBody = spliceModule(readFileSync(path.join(APP, "scene3d", "picking.js"), "utf8"), {
  label: "scene3d/picking.js", stubs: STUBS, provided: ["THREE"],
});
const pickingFactory = new Function("THREE", "window", "document", pickingBody + "\n; return { setupClickPicking };");

// Raycaster: the hit list each test sets (the up-walk to a guid is real).
let nextHits = [];
THREE.Raycaster.prototype.setFromCamera = function () {};
THREE.Raycaster.prototype.intersectObjects = function () { return nextHits.map((object) => ({ object, distance: 0 })); };

const ME = 0x50000001;
const OTHER = 0x50000002;
const KIT = 0x7000AA01;
const LOCKPICK = 0x7000AA02;

function build({ search = "" } = {}) {
  const win = { location: { search } };
  const doc = { addEventListener() {}, removeEventListener() {} };
  const local = { root: new THREE.Group() };
  const other = { root: new THREE.Group() };
  const entityMap = new Map([[ME, local], [OTHER, other]]);
  const listeners = new Map();
  const classes = new Set();
  const canvas = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    classList: {
      contains: (c) => classes.has(c),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return !!on; },
    },
  };
  const legal = new Set([`${KIT}:${ME}`]);
  const sessionHandle = {
    canUseWith: (a, b) => legal.has(`${a >>> 0}:${b >>> 0}`),
    stopStick() {},
    cancelPursuit() {},
    setMovementInput() {},
  };
  pickingFactory(THREE, win, doc).setupClickPicking({
    canvas,
    liveScene3d: { camera: {}, cameraSwitcher: null, entityManager: { entityMap } },
    sessionHandle,
    isInMeleeStance: () => false,
    isInRangedStance: () => false,
    isInMagicStance: () => false,
    getLocalPlayerGuid: () => ME,
  });
  const resolved = [];
  const arm = (itemGuid) => {
    win.__useTargeting = itemGuid
      ? { pending: { itemGuid }, resolve(g) { resolved.push(g >>> 0); this.pending = null; return true; }, cancel() { this.pending = null; } }
      : null;
  };
  const pointer = (type) => {
    const ev = { button: 0, clientX: 400, clientY: 300, stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} };
    listeners.get(type)(ev);
    return ev;
  };
  return { win, pick: () => win.__pickEntityAt(400, 300), local, other, arm, resolved, pointer, classes };
}

console.log("\n[1] no target mode — #18 unchanged");
{
  const w = build();
  check("your own back in front of the monster → the monster", () => {
    nextHits = [w.local.root, w.other.root];
    assert.equal(w.pick(), OTHER);
  });
  check("only yourself under the cursor → nothing (can't pick yourself)", () => {
    nextHits = [w.local.root];
    assert.equal(w.pick(), null);
  });
}

console.log("\n[2] a healing kit awaits its target");
{
  const w = build();
  w.arm(KIT);
  check("the nearest hit wins, yourself included", () => {
    nextHits = [w.local.root, w.other.root];
    assert.equal(w.pick(), ME);
    nextHits = [w.local.root];
    assert.equal(w.pick(), ME);
    nextHits = [w.other.root, w.local.root];
    assert.equal(w.pick(), OTHER, "someone in front of you is still them");
  });
  check("the hover reticule turns green over you", () => {
    nextHits = [w.local.root];
    w.pointer("pointermove");
    assert.ok(w.classes.has("use-target-ok"));
  });
  check("a click on yourself → TargetAcquired(player): __useTargeting.resolve(player)", () => {
    nextHits = [w.local.root];
    const ev = w.pointer("pointerdown");
    assert.deepEqual(w.resolved, [ME]);
    assert.equal(ev.stopped, true, "the click was consumed");
  });
  check("once the mode ended you are unpickable again", () => {
    nextHits = [w.local.root, w.other.root];
    assert.equal(w.pick(), OTHER);
  });
}

console.log("\n[3] an item that cannot be used on you");
{
  const w = build();
  w.arm(LOCKPICK);
  check("a lockpick awaiting its target still steps past your own back", () => {
    nextHits = [w.local.root, w.other.root];
    assert.equal(w.pick(), OTHER);
    nextHits = [w.local.root];
    assert.equal(w.pick(), null);
  });
}

console.log("\n[4] first person");
{
  const w = build();
  w.arm(KIT);
  check("a hidden local rig is not drawn, so not pickable", () => {
    w.local.root.visible = false;
    nextHits = [w.local.root, w.other.root];
    assert.equal(w.pick(), OTHER);
  });
}

console.log("\n[5] ?useTargetSelfPick=off");
{
  const w = build({ search: "?useTargetSelfPick=off" });
  w.arm(KIT);
  check("the kit's target pick steps past yourself again", () => {
    nextHits = [w.local.root, w.other.root];
    assert.equal(w.pick(), OTHER);
    nextHits = [w.local.root];
    assert.equal(w.pick(), null);
  });
}

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
