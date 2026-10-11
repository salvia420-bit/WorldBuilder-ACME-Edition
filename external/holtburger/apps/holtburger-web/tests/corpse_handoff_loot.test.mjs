// tests/corpse_handoff_loot.test.mjs — the corpse is lootable from the moment
// it exists (2026-10-11, `?handoffLoot`).
//
// Owner report: "when a creature is killed sometimes the ragdoll takes too
// long to complete its animation as the user is waiting to loot the corpse".
// When the corpse's CreateObject lands, entities.js `_tryCorpseDeathHandoff`
// claims the dying rig and HIDES the corpse until the ragdoll rests (so its
// final pose can land on the corpse). Hidden roots are unpickable and skipped
// by the cycles, so the lootable object was unreachable for seconds, and a
// click on the body on screen selected the creature the server had deleted.
//   handoff-1  a pick on the claimed rig reports the CORPSE (real picking.js +
//              a real three Raycaster): click-select, the hover pick and the
//              double-click Use; the sphere fallback reads the drawn rig's
//              parts; a deleted, unclaimed rig is not pickable.
//   handoff-2  Closest / Next Unopened Corpse find the hidden corpse; the
//              monster cycle still skips both bodies.
//   handoff-3  the reveal follows the ragdoll's rest within one 100 ms poll
//              (bounded), waits for a ragdoll still arming, and a selection
//              made through the stand-in survives it.
// `?handoffLoot=off` (EntityManager `_handoffLootOn = false`) restores the
// pre-2026-10-11 picking and cycling.
//
// Run from apps/holtburger-web/:  node tests/corpse_handoff_loot.test.mjs

import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;
globalThis.document ??= { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { setupClickPicking } = await import("../scene3d/picking.js");
const { _resetUseThrottleForTests } = await import("../scene3d/target_cycle.js");
const {
  handoffPickGuid,
  handoffDrawnViaProxy,
  revealVerdict,
  DEATH_REVEAL_POLL_MS,
  DEATH_REVEAL_MAX_WAIT_MS,
} = await import("../scene3d/death_hold.js");

const ME = 0x50000001;
const DYING = 0x80000d01; // the creature, ragdolling at the origin
const CORPSE = 0x80002d01; // its corpse
const MOB = 0x80000a01; // a live mob 3 m behind it
const MOB_META = { itemType: 0x10, objDescFlags: 0x14 };
const CORPSE_META = { itemType: 0x200, objDescFlags: 0x2001 };

function makeSession() {
  return {
    mode: 1, // peace
    uses: [],
    getLocalPlayerPose() { return { x: 0, y: -6, z: 0, heading: 0, landblockId: 0x00000019 }; },
    getCurrentCellId() { return 0x00000019; }, // outdoor → 75 m radar
    combatMode() { return this.mode; },
    isCharacterOptionEnabled(o) { return o === 0x0d; },
    objectInstanceIdProperty() { return undefined; },
    objectIntProperty(g, s) { return s === 133 ? 2 : undefined; },
    objectDescFlags() { return 0x18; },
    useObject(g) { this.uses.push(g >>> 0); },
    setMovementInput() {},
    stopStick() {},
    cancelPursuit() {},
  };
}

/** A rig: root at `at`, one part Group holding a 1 m box at `partAt` (root-local). */
function addRig(em, guid, meta, at, partAt, extra = {}) {
  const root = new THREE.Group();
  root.position.set(...at);
  const part = new THREE.Group();
  part.position.set(...partAt);
  part.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  root.add(part);
  root.updateMatrixWorld(true);
  const inst = {
    guid, root, parts: [part], meta: { guid, ...meta },
    _stateVisible: true, _attachedParentGuid: null, _attachedChildren: null,
    dispose() {},
    ...extra,
  };
  em.entityMap.set(guid, inst);
  return inst;
}

/**
 * The death scene: camera 6 m south of the origin looking north at the dying
 * creature's box (z 1); a live mob 3 m behind it; the corpse arrives with its
 * authored "prone" part 3 m to the side (so a test can tell whose parts were
 * read). `claim` runs the real `_tryCorpseDeathHandoff`.
 */
function world({ ragdoll = null, arming = false, claim = true } = {}) {
  const sh = makeSession();
  globalThis.window.__sessionHandle = sh;
  globalThis.window.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  em._autoTargetOn = false;
  em._selectionRangeExitOn = false;
  addRig(em, ME, { itemType: 0x10, objDescFlags: 0x18 }, [0, -6, 0], [0, 0, 1], { parts: [] });
  addRig(em, MOB, MOB_META, [0, 3, 0], [0, 0, 1]);
  const now = performance.now();
  const dying = addRig(em, DYING, MOB_META, [0, 0, 0], [0, 0, 1], {
    _deathAt: now, _deathEndAt: now, _deadFrozen: true,
    _ragdoll: ragdoll, _ragdollArming: arming,
  });
  let corpse = null;
  if (claim) {
    corpse = addRig(em, CORPSE, CORPSE_META, [0.2, 0, 0], [3, 0, 0.2]);
    em._tryCorpseDeathHandoff(corpse);
    for (const i of em.entityMap.values()) i.root.updateMatrixWorld(true);
  }
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 100);
  camera.position.set(0, -6, 1);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);
  const listeners = {};
  const canvas = {
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    classList: { contains: () => false, remove() {}, toggle() {} },
  };
  const picking = setupClickPicking({
    canvas,
    liveScene3d: { camera, cameraSwitcher: null, entityManager: em },
    sessionHandle: sh,
    isInMeleeStance: () => false,
    isInRangedStance: () => false,
    isInMagicStance: () => false,
    getLocalPlayerGuid: () => ME,
  });
  _resetUseThrottleForTests();
  /** client x/y of a world point */
  const screen = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [(v.x + 1) * 400, (1 - v.y) * 300];
  };
  const pick = (x = 400, y = 300) => window.__pickEntityAt(x, y);
  let ts = 1000;
  const click = (x = 400, y = 300) => {
    ts += 120;
    listeners.pointerdown?.({
      button: 0, clientX: x, clientY: y, timeStamp: ts,
      stopPropagation() {}, preventDefault() {},
    });
  };
  return { em, sh, dying, corpse, pick, click, screen, picking };
}

// ── pure rules ──────────────────────────────────────────────────────────────
test("handoff-1 rule: claimed rig → its corpse; deleted unclaimed rig → 0; anything else → itself", () => {
  const s = { guid: DYING, claimGuid: 0, claimMapped: false, removePending: false };
  assert.equal(handoffPickGuid(s), DYING, "a dying rig the server still has");
  assert.equal(handoffPickGuid({ ...s, claimGuid: CORPSE, claimMapped: true }), CORPSE);
  assert.equal(handoffPickGuid({ ...s, claimGuid: CORPSE, claimMapped: true, removePending: true }), CORPSE);
  assert.equal(handoffPickGuid({ ...s, claimGuid: CORPSE, claimMapped: false }), 0, "its corpse already went");
  assert.equal(handoffPickGuid({ ...s, removePending: true }), 0, "deleted, nothing claimed it yet");
});

test("handoff-2 rule: a hidden corpse is drawn only through the rig that still claims it", () => {
  const s = { guid: CORPSE, hiddenForHandoff: true, proxyClaimGuid: CORPSE, proxyVisible: true };
  assert.equal(handoffDrawnViaProxy(s), true);
  assert.equal(handoffDrawnViaProxy({ ...s, proxyVisible: false }), false, "the stand-in itself is hidden");
  assert.equal(handoffDrawnViaProxy({ ...s, proxyClaimGuid: 0x80002d02 }), false, "claim moved on");
  assert.equal(handoffDrawnViaProxy({ ...s, hiddenForHandoff: false }), false, "not hidden: its own state decides");
});

test("handoff-3 rule: wait while the ragdoll may move, bounded; 100 ms polls", () => {
  assert.equal(DEATH_REVEAL_POLL_MS, 100);
  assert.equal(revealVerdict({ ragdollLive: true, waitedMs: 0 }), "wait");
  assert.equal(revealVerdict({ ragdollLive: true, waitedMs: DEATH_REVEAL_MAX_WAIT_MS - 1 }), "wait");
  assert.equal(revealVerdict({ ragdollLive: true, waitedMs: DEATH_REVEAL_MAX_WAIT_MS }), "reveal");
  assert.equal(revealVerdict({ ragdollLive: false, waitedMs: 0 }), "reveal");
});

// ── picking: real picking.js, real Raycaster ────────────────────────────────
test("handoff-1: before the corpse exists, the dying creature picks as itself", () => {
  const { pick, picking } = world({ claim: false });
  assert.equal(pick(), DYING);
  picking.destroy();
});

test("handoff-1: the claimed rig picks as its hidden corpse; double-click loots it", () => {
  const { em, sh, corpse, pick, click, picking } = world({ ragdoll: { sim: { done: false } } });
  assert.equal(corpse._hiddenForHandoff, true, "the corpse is hidden until the ragdoll rests");
  assert.equal(corpse.root.visible, false);
  assert.equal(pick(), CORPSE, "hover / click on the tumbling body → the corpse");
  click();
  assert.equal(em.getSelectedTarget(), CORPSE, "single click selects the corpse");
  assert.deepEqual(sh.uses, [], "a single click does not Use");
  click();
  assert.deepEqual(sh.uses, [CORPSE], "double-click Uses (opens) the corpse — not the deleted creature");
  picking.destroy();
  em.dispose();
});

test("handoff-1: the sphere fallback reads the DRAWN rig's parts, reports the corpse", () => {
  const { em, dying, pick, screen, picking } = world({ ragdoll: { sim: { done: false } } });
  em.entityMap.delete(MOB);
  // The claim snapped the creature root onto the corpse (x 0.2). Aim 0.65 m
  // right of its box centre: outside the box, inside its 0.87 m sphere. The
  // corpse's own (hidden) part sits 3 m away and must not be what is read.
  const cx = dying.root.position.x;
  assert.equal(cx, 0.2, "the rig was snapped onto the corpse's transform");
  const [x, y] = screen(cx + 0.65, 0, 1);
  assert.equal(pick(x, y), CORPSE);
  const [fx, fy] = screen(cx + 1.2, 0, 1); // outside the sphere too
  assert.equal(pick(fx, fy), null, "…and only inside the drawn rig's sphere");
  picking.destroy();
  em.dispose();
});

test("handoff-1: a deleted, unclaimed rig is click-through; ?handoffLoot=off picks it as before", () => {
  const { em, dying, pick, picking } = world({ claim: false });
  dying._removePending = true; // the server delete landed, the corpse not yet
  assert.equal(pick(), MOB, "the click passes through to the mob behind");
  em._handoffLootOn = false;
  assert.equal(pick(), DYING, "escape: the old behaviour");
  picking.destroy();
  em.dispose();
});

test("handoff-1 escape: ?handoffLoot=off — the claimed rig picks as the deleted creature", () => {
  const { em, pick, picking } = world({ ragdoll: { sim: { done: false } } });
  em._handoffLootOn = false;
  assert.equal(pick(), DYING);
  picking.destroy();
  em.dispose();
});

// ── selection cycles ────────────────────────────────────────────────────────
test("handoff-2: Closest Unopened Corpse finds the hidden corpse at once; the monster cycle skips both bodies", () => {
  const { em, sh, picking } = world({ ragdoll: { sim: { done: false } } });
  assert.equal(em.unopenedCorpseAction("closest", sh), CORPSE);
  assert.deepEqual(sh.uses, [CORPSE], "the Use variant opens it");
  em._commitSelection(0);
  assert.equal(em.cycleTarget("closest", "monster"), MOB, "neither the dying rig nor the corpse is a monster target");
  picking.destroy();
  em.dispose();
});

test("handoff-2 escape: ?handoffLoot=off — the hidden corpse is out of the cycle again", () => {
  const { em, picking } = world({ ragdoll: { sim: { done: false } } });
  em._handoffLootOn = false;
  assert.equal(em.unopenedCorpseAction("closest"), 0);
  picking.destroy();
  em.dispose();
});

test("handoff-2: the stand-in hidden (cloaked / NoDraw) → the corpse is not drawn either", () => {
  const { em, dying, picking } = world({ ragdoll: { sim: { done: false } } });
  dying._stateVisible = false;
  assert.equal(em.unopenedCorpseAction("closest"), 0);
  picking.destroy();
  em.dispose();
});

// ── reveal timing (mocked setTimeout + a fake performance clock) ────────────
/** Run `fn(advance)` with mocked timers; advance(ms) moves both clocks. */
function withClock(fn) {
  const realNow = performance.now.bind(performance);
  let fake = realNow();
  const desc = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", { value: () => fake, configurable: true, writable: true });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    fn((ms) => {
      // step in small slices so each poll sees the clock it fired at
      for (let left = ms; left > 0; left -= Math.min(left, 10)) {
        const d = Math.min(left, 10);
        fake += d;
        mock.timers.tick(d);
      }
    });
  } finally {
    mock.timers.reset();
    if (desc) Object.defineProperty(performance, "now", desc);
    else delete performance.now;
  }
}

test("handoff-3: the reveal lands within one poll of the ragdoll resting; the selection survives it", () => {
  withClock((advance) => {
    const ragdoll = { sim: { done: false } };
    const { em, corpse, click, picking } = world({ ragdoll });
    click();
    assert.equal(em.getSelectedTarget(), CORPSE, "selected through the stand-in");
    advance(1250); // the authored clock ran out at the claim; the sim keeps moving
    assert.equal(corpse._hiddenForHandoff, true, "still hidden while the sim moves");
    assert.ok(em.entityMap.has(DYING));
    ragdoll.sim.done = true; // it comes to rest between two polls
    advance(DEATH_REVEAL_POLL_MS);
    assert.equal(corpse._hiddenForHandoff, false, `revealed within one ${DEATH_REVEAL_POLL_MS} ms poll (was up to 500 ms)`);
    assert.equal(corpse.root.visible, true);
    assert.equal(corpse._handoffFromGuid, 0, "the reverse link is cleared");
    assert.equal(em.entityMap.has(DYING), false, "the creature rig is removed in the same beat");
    assert.equal(em.getSelectedTarget(), CORPSE, "the corpse stays selected across the reveal");
    assert.ok(corpse._ragdollFrozenPose, "the ragdoll's final pose landed on the corpse");
    picking.destroy();
    em.dispose();
  });
});

test("handoff-3: a ragdoll that never rests is revealed at the bound", () => {
  withClock((advance) => {
    const { em, corpse, picking } = world({ ragdoll: { sim: { done: false } } });
    advance(DEATH_REVEAL_MAX_WAIT_MS - 50);
    assert.equal(corpse._hiddenForHandoff, true);
    advance(50 + DEATH_REVEAL_POLL_MS);
    assert.equal(corpse._hiddenForHandoff, false, `revealed ${DEATH_REVEAL_MAX_WAIT_MS} ms past the authored clock`);
    assert.equal(em.entityMap.has(DYING), false);
    picking.destroy();
    em.dispose();
  });
});

test("handoff-3: a ragdoll still ARMING holds the reveal (no authored-pose flash)", () => {
  withClock((advance) => {
    const { em, dying, corpse, picking } = world({ arming: true });
    advance(400);
    assert.equal(corpse._hiddenForHandoff, true, "waits for the arm");
    dying._ragdollArming = false; // the arm failed: no ragdoll after all
    advance(DEATH_REVEAL_POLL_MS);
    assert.equal(corpse._hiddenForHandoff, false);
    assert.equal(em.entityMap.has(DYING), false);
    picking.destroy();
    em.dispose();
  });
});
