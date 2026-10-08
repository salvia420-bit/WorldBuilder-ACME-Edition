// C2 (2026-07-12) — retail target-cycling ordering + cycle logic.
// A3-selection (2026-10-08): retail Next/Previous order + the off-list /
// previous-selection anchor (selection-1), the radar-range candidate gate
// (selection-3) and the range-exit drop (selection-4).
// A2-death round 2 (2026-10-08): the UNOPENED_CORPSE type (death-5,
// SelectNext case 5) and its four corpse-loot binds.
// A3-radar round 2 (2026-10-08): the shared radar-visibility rule
// (`radarShowableFor`, radar-1) and the BlackFog2 radar blank (radar-4).
//
// Pins the PURE selection math (scene3d/target_cycle.js — import-free, loads
// under plain node) against CPlayerSystem::SelectNext (acclient.c:397944) and
// its keybind wrap dispatch (acclient.c:399692-399746), plus static-source
// assertions for the load-bearing wiring in entities.js / index.html /
// keymap.js (three.js + DOM — same pattern as tests/test_c1_facing_camera.cjs).
//
// Run: node tests/target_cycle.test.cjs   (from apps/holtburger-web/)

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const ENTITIES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'entities.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'index.html'), 'utf8');
const KEYMAP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'keymap.js'), 'utf8');
const FLAGS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'url-flags.md'), 'utf8');
const RADAR_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'plugins', 'radar.js'), 'utf8');

// A small three-mob world used across the ordering tests.
//   self 0x1 @0.5 (excluded)   A 0xA @1   B 0xB @5   C 0xC @10
const SELF = 0x1;
const WORLD = [
  { guid: SELF, dist: 0.5 },
  { guid: 0xA, dist: 1 },
  { guid: 0xB, dist: 5 },
  { guid: 0xC, dist: 10 },
];

async function main() {
  const m = await import('../scene3d/target_cycle.js');
  const { farther, weightedDistance, matchesSelectionType, computeSelectNext, SELECTION_TYPE } = m;

  // The anchor EntityManager._cycleAnchor hands computeSelectNext: the
  // selected object + its weighted distance, or null.
  const anchorIn = (world, cur) => {
    const e = world.find((c) => c.guid === cur);
    return e ? { guid: e.guid, dist: e.dist } : null;
  };
  // Emulate EntityManager.cycleTarget's retail dispatch over the pure
  // primitive (CPlayerSystem::OnAction acclient.c:399729-399747):
  //   Closest (1,1); Previous (1,0) else (0,1); Next (0,0) else (1,1).
  const cycleIn = (world, self, mode, cur) => {
    const sel = (closer, extreme) =>
      computeSelectNext(world, anchorIn(world, cur), self, closer, extreme);
    const keep = (g) => (g && g !== cur ? g : 0);
    if (mode === 'closest') return keep(sel(true, true)) || cur;
    const outward = mode !== 'previous';
    let g = keep(sel(!outward, false));
    if (!g) g = keep(sel(outward, true));
    return g || cur;
  };
  const selectNext = (cur, closer, extreme) =>
    computeSelectNext(WORLD, anchorIn(WORLD, cur), SELF, closer, extreme);
  const cycle = (mode, cur) => cycleIn(WORLD, SELF, mode, cur);

  // ── (1) Farther comparator (acclient.c:395865) ──────────────────────────
  check('farther is strict greater-than on distance', () => {
    assert.equal(farther(10, 0xA, 5, 0xB), true);
    assert.equal(farther(5, 0xA, 10, 0xB), false);
  });
  check('farther breaks distance ties by higher id', () => {
    assert.equal(farther(5, 0xD, 5, 0xB), true);   // 0xD > 0xB
    assert.equal(farther(5, 0xB, 5, 0xD), false);
    assert.equal(farther(5, 0xB, 5, 0xB), false);  // equal → not farther
  });

  // ── (2) Weighted distance (Get2DDistance + GetWeightedZDistance) ─────────
  check('weightedDistance = 2D horizontal + |dz| * 1.2', () => {
    const d = weightedDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 10 });
    assert.equal(d, 5 + 10 * 1.2); // 5 horizontal + 12 z-weighted = 17
  });
  check('weightedDistance z penalty is symmetric (|dz|)', () => {
    const up = weightedDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    const down = weightedDistance({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 });
    assert.equal(up, down);
    assert.equal(up, 6); // 0 + 5*1.2
  });

  // ── (3) Selection-type filter (acclient.c:398049-398120) ────────────────
  const CREATURE = 0x10, ODF_PLAYER = 0x08, ODF_ATTACK = 0x10, ODF_CORPSE = 0x2000;
  check('MONSTER = attackable creature, not player', () => {
    assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK }, SELECTION_TYPE.MONSTER), true);
  });
  check('MONSTER excludes players (Player ODF bit)', () => {
    assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK | ODF_PLAYER }, SELECTION_TYPE.MONSTER), false);
  });
  check('MONSTER excludes non-attackable creatures', () => {
    assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: 0 }, SELECTION_TYPE.MONSTER), false);
  });
  check('MONSTER excludes non-creature attackables (loose live dagger)', () => {
    assert.equal(matchesSelectionType({ itemType: 0x1, objDescFlags: ODF_ATTACK }, SELECTION_TYPE.MONSTER), false);
  });
  check('corpses are excluded from every cycle', () => {
    assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK | ODF_CORPSE }, SELECTION_TYPE.MONSTER), false);
    assert.equal(matchesSelectionType({ objDescFlags: ODF_PLAYER | ODF_CORPSE }, SELECTION_TYPE.PLAYER), false);
  });
  check('PLAYER = carries the Player ODF bit', () => {
    assert.equal(matchesSelectionType({ objDescFlags: ODF_PLAYER }, SELECTION_TYPE.PLAYER), true);
    assert.equal(matchesSelectionType({ objDescFlags: ODF_ATTACK }, SELECTION_TYPE.PLAYER), false);
  });
  check('ANY = any attackable non-corpse', () => {
    assert.equal(matchesSelectionType({ objDescFlags: ODF_ATTACK }, SELECTION_TYPE.ANY), true);
  });
  check('missing meta never throws (defaults to 0 flags)', () => {
    assert.equal(matchesSelectionType(undefined, SELECTION_TYPE.MONSTER), false);
    assert.equal(matchesSelectionType(null, SELECTION_TYPE.ANY), false);
  });
  check('UNOPENED_CORPSE (death-5, case 5 :398069-398072) = a corpse not yet opened', () => {
    const U = SELECTION_TYPE.UNOPENED_CORPSE;
    assert.equal(matchesSelectionType({ objDescFlags: ODF_CORPSE }, U), true);
    assert.equal(matchesSelectionType({ objDescFlags: ODF_CORPSE }, U, { corpseOpened: true }), false, 'opened');
    assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK }, U), false, 'a live mob');
    assert.equal(matchesSelectionType(undefined, U), false);
    // every other cycle still rejects a corpse, opened or not
    assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK | ODF_CORPSE }, SELECTION_TYPE.MONSTER, { corpseOpened: false }), false);
  });

  // ── (4) computeSelectNext — the SelectNext primitive ────────────────────
  check('self (playerID) is always skipped', () => {
    // nearest is self @0.5 but self must be excluded → A @1.
    assert.equal(computeSelectNext(WORLD, 0, SELF, true, false), 0xA);
  });
  check('no selection + closer → nearest', () => {
    assert.equal(selectNext(0, true, false), 0xA);
  });
  check('no selection + !closer → farthest', () => {
    assert.equal(selectNext(0, false, false), 0xC);
  });
  check('extreme + closer → nearest (ignores current)', () => {
    assert.equal(selectNext(0xB, true, true), 0xA);
  });
  check('extreme + !closer → farthest (ignores current)', () => {
    assert.equal(selectNext(0xB, false, true), 0xC);
  });
  check('closer (Previous) step from mid selection → immediately closer', () => {
    assert.equal(selectNext(0xB, true, false), 0xA); // closer than B(5) = A(1)
    assert.equal(selectNext(0xC, true, false), 0xB); // closer than C(10) = B(5)
  });
  check('closer step from nearest → 0 (nothing closer → caller wraps)', () => {
    assert.equal(selectNext(0xA, true, false), 0);
  });
  check('farther (Next) step from mid selection → immediately farther', () => {
    assert.equal(selectNext(0xB, false, false), 0xC); // farther than B(5) = C(10)
    assert.equal(selectNext(0xA, false, false), 0xB); // farther than A(1) = B(5)
  });
  check('farther step from farthest → 0 (nothing farther → caller wraps)', () => {
    assert.equal(selectNext(0xC, false, false), 0);
  });
  check('empty candidate list → 0', () => {
    assert.equal(computeSelectNext([], 0, SELF, true, false), 0);
    assert.equal(computeSelectNext([{ guid: SELF, dist: 1 }], 0, SELF, true, false), 0);
  });

  // Distance-tie ordering: two mobs at the same weighted distance sort by id.
  check('distance ties resolve by id (nearest = lower id, step picks higher)', () => {
    const tied = [
      { guid: 0xA, dist: 1 },
      { guid: 0xB, dist: 5 },
      { guid: 0xD, dist: 5 },
      { guid: 0xC, dist: 10 },
    ];
    // closer step from C(10): max (dist,id) that is <= 10 excluding C →
    // among B(5,0xB) and D(5,0xD), the "farther" (higher id) D wins.
    assert.equal(computeSelectNext(tied, { guid: 0xC, dist: 10 }, SELF, true, false), 0xD);
    // nearest overall is still A(1); the 5m tie doesn't affect it.
    assert.equal(computeSelectNext(tied, 0, SELF, true, false), 0xA);
  });

  // ── (4a) the anchor (selection-1, acclient.c:398004-398029) ───────────
  check('an off-list anchor still anchors (NPC at 6 m): Next → C, Previous → B', () => {
    const npc = { guid: 0xE, dist: 6 }; // selected NPC, not a MONSTER candidate
    assert.equal(computeSelectNext(WORLD, npc, SELF, false, false), 0xC); // first > 6
    assert.equal(computeSelectNext(WORLD, npc, SELF, true, false), 0xB);  // largest <= 6
  });
  check('no anchor: Next (0,0) picks the FARTHEST, Previous (1,0) the nearest', () => {
    assert.equal(computeSelectNext(WORLD, null, SELF, false, false), 0xC);
    assert.equal(computeSelectNext(WORLD, null, SELF, true, false), 0xA);
  });
  check('extreme ignores the anchor (and may re-pick it)', () => {
    assert.equal(computeSelectNext(WORLD, { guid: 0xA, dist: 1 }, SELF, true, true), 0xA);
    assert.equal(computeSelectNext(WORLD, { guid: 0xA, dist: 1 }, SELF, false, true), 0xC);
  });
  check('the anchor itself is skipped on a step (retail :398159)', () => {
    // B anchored at its own distance: nothing else at 5, so Previous → A.
    assert.equal(computeSelectNext(WORLD, { guid: 0xB, dist: 5 }, SELF, true, false), 0xA);
  });
  check('a bare guid is the legacy in-list-only anchor (?retailSelectNext=off)', () => {
    assert.equal(computeSelectNext(WORLD, 0xB, SELF, false, false), 0xC);
    assert.equal(computeSelectNext(WORLD, 0xE, SELF, false, false), 0xC); // off-list → no anchor → farthest
    assert.equal(computeSelectNext(WORLD, 0xE, SELF, true, false), 0xA);  // → nearest
  });

  // ── (4b) round-4c harness world ─────────────────────────────────────────
  // Real r4c world (journal wf_68abc3df-e11): a freshly @create'd Pyreal
  // Target Drudge at ~5yd next to two far strays — "The Chicken" 0x8000967b
  // @~100yd (HIGHEST guid) and "Drudge Slinker" 0x8000920d @~121yd
  // (FARTHEST). The harness driver called __selectNextTarget("monster"). The
  // old swapped dispatch wrapped from the drudge to the farthest stray; retail
  // Next steps one mob outward, and the radar range (75 m outdoors) keeps
  // both strays out of the cycle entirely. ClosestMonster stays the lock.
  const R4C = {
    self: 0x50000001,
    drudge: 0x8000941e,   // Pyreal Target Drudge, ~5yd — the wanted target
    chicken: 0x8000967b,  // The Chicken, ~100yd — highest guid
    slinker: 0x8000920d,  // Drudge Slinker, ~121yd — farthest
  };
  const R4C_WORLD = [
    { guid: R4C.self, dist: 0.4 },
    { guid: R4C.drudge, dist: 5 },
    { guid: R4C.chicken, dist: 100 },
    { guid: R4C.slinker, dist: 121 },
  ];
  // What `?cycleRadarFilter` leaves (2D == weighted here: all at eye level).
  const R4C_RADAR = R4C_WORLD.filter((c) => c.dist <= m.RADAR_RANGE_OUTDOOR);
  const r4cCycle = (mode, cur) => cycleIn(R4C_WORLD, R4C.self, mode, cur);
  const r4cRadarCycle = (mode, cur) => cycleIn(R4C_RADAR, R4C.self, mode, cur);
  check('r4c: Next from the drudge steps one mob OUTWARD (no far wrap)', () => {
    assert.equal(r4cCycle('next', R4C.drudge), R4C.chicken);
    assert.equal(r4cCycle('next', R4C.slinker), R4C.drudge); // wraps to the nearest
  });
  check('r4c: with the radar range the strays are out — Next holds the drudge', () => {
    assert.equal(r4cRadarCycle('next', R4C.drudge), R4C.drudge);
    assert.equal(r4cRadarCycle('previous', R4C.drudge), R4C.drudge);
    assert.equal(r4cRadarCycle('next', 0), R4C.drudge);
  });
  check('r4c: ClosestMonster locks the near drudge from ANY prior selection', () => {
    assert.equal(r4cCycle('closest', 0), R4C.drudge);
    assert.equal(r4cCycle('closest', R4C.drudge), R4C.drudge); // holds; never wraps
    assert.equal(r4cCycle('closest', R4C.chicken), R4C.drudge);
    assert.equal(r4cCycle('closest', R4C.slinker), R4C.drudge);
  });
  check('r4c: while the drudge is mid-bake, closest finds nothing in radar range', () => {
    // The async-spawn race: spawn() commits to entityMap only after the mesh
    // bakes, so a just-@create'd drudge is briefly NOT a candidate. Without
    // the range limit closest reached the nearer stray; with it, nothing —
    // so the harness poll simply retries until the drudge goes live.
    const noDrudge = R4C_WORLD.filter((c) => c.guid !== R4C.drudge);
    assert.equal(computeSelectNext(noDrudge, null, R4C.self, true, true), R4C.chicken);
    const noDrudgeRadar = R4C_RADAR.filter((c) => c.guid !== R4C.drudge);
    assert.equal(computeSelectNext(noDrudgeRadar, null, R4C.self, true, true), 0);
  });

  // ── (5) cycleTarget wrap sequences (acclient.c:399692-399746) ───────────
  check('NextMonster sequence: farthest first, then outward from the nearest', () => {
    // Unanchored Next = farthest C; outward from C → wrap to nearest A → B → C …
    let g = 0;
    const seq = [];
    for (let i = 0; i < 6; i++) { g = cycle('next', g); seq.push(g); }
    assert.deepEqual(seq, [0xC, 0xA, 0xB, 0xC, 0xA, 0xB]);
  });
  check('PreviousMonster sequence: nearest first, then inward from the farthest', () => {
    let g = 0;
    const seq = [];
    for (let i = 0; i < 6; i++) { g = cycle('previous', g); seq.push(g); }
    assert.deepEqual(seq, [0xA, 0xC, 0xB, 0xA, 0xC, 0xB]);
  });
  check('ClosestMonster always selects the nearest', () => {
    assert.equal(cycle('closest', 0), 0xA);
    assert.equal(cycle('closest', 0xC), 0xA);
    assert.equal(cycle('closest', 0xB), 0xA);
  });

  // ── (5b) cycleCandidateOk — the radar-range gate (selection-3) ─────────
  const { cycleCandidateOk, radarRangeForCell } = m;
  const OUT = radarRangeForCell(0xa9b40019); // outdoor cell → 75
  const IN = radarRangeForCell(0xa9b40105);  // EnvCell → 25
  const ME = { itemType: CREATURE, objDescFlags: ODF_PLAYER | ODF_ATTACK };
  const MOB = { itemType: CREATURE, objDescFlags: ODF_ATTACK | 0x4 };
  const base = { playerMeta: ME, isFellow: false, showable: true, stateVisible: true, attached: false };
  const ok = (meta, over, type = SELECTION_TYPE.MONSTER) =>
    cycleCandidateOk(meta, { ...base, dist2d: 10, range: OUT, ...over }, type);
  check('radar range: 74 m in / 76 m out outdoors, 24 m in / 26 m out indoors', () => {
    assert.equal(OUT, 75);
    assert.equal(IN, 25);
    assert.equal(ok(MOB, { dist2d: 74 }), true);
    assert.equal(ok(MOB, { dist2d: 76 }), false);
    assert.equal(ok(MOB, { dist2d: 24, range: IN }), true);
    assert.equal(ok(MOB, { dist2d: 26, range: IN }), false);
  });
  check('the range is 2D only: 70 m away and 20 m up is still in', () => {
    const pose = { x: 0, y: 0, z: 0 };
    const t = { x: 70, y: 0, z: 20 };
    assert.ok(weightedDistance(pose, t) > OUT); // ranks at 94 …
    assert.equal(ok(MOB, { dist2d: Math.hypot(t.x - pose.x, t.y - pose.y) }), true); // … but in range
  });
  check('MONSTER excludes vendors, fellows, radar-hidden, UI-hidden, undrawn, mounted', () => {
    assert.equal(ok({ ...MOB, objDescFlags: ODF_ATTACK | 0x200 }), false, 'vendor');
    assert.equal(ok(MOB, { isFellow: true }), false, 'fellow');
    assert.equal(ok(MOB, { showable: false }), false, 'ShowNever / Undef');
    assert.equal(ok({ ...MOB, objDescFlags: ODF_ATTACK | 0x80 }), false, 'UI hidden');
    assert.equal(ok(MOB, { stateVisible: false }), false, 'cloaked / NoDraw');
    assert.equal(ok(MOB, { attached: true }), false, 'wielded child');
    assert.equal(ok({ ...MOB, objDescFlags: ODF_ATTACK | ODF_CORPSE }), false, 'corpse');
  });
  check('MONSTER = ObjectIsAttackable: mutual-PK players in, pets out', () => {
    const pkMe = { itemType: CREATURE, objDescFlags: ODF_PLAYER | 0x20 };
    const pkThem = { itemType: CREATURE, objDescFlags: ODF_PLAYER | 0x20 };
    assert.equal(ok(pkThem, { playerMeta: pkMe }), true, 'PK vs PK');
    assert.equal(ok(pkThem, { playerMeta: ME }), false, 'PK target, non-PK me');
    assert.equal(ok({ ...MOB, petOwner: 0x50000002 }), false, 'pet');
    assert.equal(ok({ itemType: CREATURE, objDescFlags: 0x4 }), false, 'town NPC');
  });
  check('isShowableOnRadar: 2/3/4 only; absent is hidden (retail default 0)', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, undefined].map(m.isShowableOnRadar),
      [false, false, true, true, true, false, false]);
  });
  // radar-1: InqShowableOnRadar (:436764) + AddObject's UI-hidden gate
  // (:264435). Old radar code fell back to the ODF/itemType heuristic when
  // RadarBehavior was ABSENT, blipping creature-typed props retail hides
  // (Exploration Marker, levers, pedestals).
  check('radarShowableFor: absent RadarBehavior hides even a creature-typed object', () => {
    const rb = (v) => ({ objectIntProperty: (g, s) => (s === 133 ? v : undefined) });
    assert.equal(m.radarShowableFor(rb(undefined), 1, 0, CREATURE), false);
    assert.equal(m.radarShowableFor(rb(4), 1, 0, 0), true);
    assert.equal(m.radarShowableFor(rb(2), 1, 0, 0), true);
    assert.equal(m.radarShowableFor(rb(3), 1, 0, 0), true);
    assert.equal(m.radarShowableFor(rb(1), 1, 0, CREATURE), false, 'ShowNever');
    assert.equal(m.radarShowableFor(rb(4), 1, 0x80, 0), false, 'UI-hidden');
    const throws = { objectIntProperty: () => { throw new Error('freed'); } };
    assert.equal(m.radarShowableFor(throws, 1, 0, CREATURE), false);
  });
  check('radarShowableFor: the heuristic only for a bundle with no objectIntProperty', () => {
    assert.equal(m.radarShowableFor({}, 1, 0, CREATURE), true);
    assert.equal(m.radarShowableFor(null, 1, ODF_PLAYER, 0), true);
    assert.equal(m.radarShowableFor(null, 1, 0, 0x1), false);
  });
  // radar-4: CPlayerSystem::Handle_Admin__Environs (:396298) m_bRadarBlank.
  check('radarBlankAfterEnviron: 6 sets; 0-5 and 9999 clear; sounds / others keep', () => {
    assert.equal(m.radarBlankAfterEnviron(false, 6), true);
    for (const o of [0, 1, 2, 3, 4, 5, 9999]) assert.equal(m.radarBlankAfterEnviron(true, o), false, String(o));
    for (const o of [0x65, 7, 117, 124, 200, -1]) assert.equal(m.radarBlankAfterEnviron(true, o), true, String(o));
    assert.equal(m.radarBlankAfterEnviron(false, 0x70), false);
  });
  check('PLAYER needs the Player bit and radar visibility', () => {
    const other = { itemType: CREATURE, objDescFlags: ODF_PLAYER };
    assert.equal(ok(other, {}, SELECTION_TYPE.PLAYER), true);
    assert.equal(ok(other, { showable: false }, SELECTION_TYPE.PLAYER), false);
    assert.equal(ok(MOB, {}, SELECTION_TYPE.PLAYER), false);
  });
  check('COMPASS_COMBAT (auto-target) = attackable, not fellow, not vendor, on radar', () => {
    const C = SELECTION_TYPE.COMPASS_COMBAT;
    assert.equal(ok(MOB, {}, C), true);
    assert.equal(ok(MOB, { showable: false }, C), false);
    assert.equal(ok(MOB, { isFellow: true }, C), false);
    assert.equal(ok({ ...MOB, objDescFlags: ODF_ATTACK | 0x200 }, {}, C), false);
    assert.equal(ok(MOB, { dist2d: 80 }, C), false);
  });
  check('the showable thunk runs only for candidates that pass every cheaper rule', () => {
    let calls = 0;
    const thunk = () => { calls += 1; return true; };
    ok(MOB, { showable: thunk, dist2d: 90 });
    ok({ itemType: CREATURE, objDescFlags: 0x4 }, { showable: thunk });
    assert.equal(calls, 0);
    assert.equal(ok(MOB, { showable: thunk }), true);
    assert.equal(calls, 1);
  });

  check('cycleCandidateOk UNOPENED_CORPSE: an unopened corpse in radar range; no radar-showable test', () => {
    const U = SELECTION_TYPE.UNOPENED_CORPSE;
    const CORPSE = { itemType: 0x200, objDescFlags: ODF_CORPSE | 0x1 };
    let calls = 0;
    assert.equal(ok(CORPSE, { showable: () => { calls += 1; return false; } }, U), true);
    assert.equal(calls, 0, 'retail case 5 never calls InqShowableOnRadar');
    assert.equal(ok(CORPSE, { corpseOpened: true }, U), false, 'already opened');
    assert.equal(ok(CORPSE, { dist2d: 76 }, U), false, 'out of radar range');
    assert.equal(ok(CORPSE, { dist2d: 26, range: IN }, U), false, 'indoor range');
    assert.equal(ok(CORPSE, { stateVisible: false }, U), false, 'hidden (corpse handoff)');
    assert.equal(ok({ ...CORPSE, objDescFlags: ODF_CORPSE | 0x80 }, {}, U), false, 'UI hidden');
    assert.equal(ok(MOB, {}, U), false, 'a live mob');
    assert.equal(ok(CORPSE, {}), false, 'MONSTER still rejects a corpse');
  });

  // ── (5c) selectionRangeExit (selection-4, acclient.c:398710-398737) ─────
  check('range exit: out of range AND off screen drops; on screen / in range / owned keep', () => {
    const { selectionRangeExit } = m;
    assert.equal(selectionRangeExit({ xyDist: 80, range: OUT, inView: false, exempt: false }), true);
    assert.equal(selectionRangeExit({ xyDist: 80, range: OUT, inView: true, exempt: false }), false);
    assert.equal(selectionRangeExit({ xyDist: 74, range: OUT, inView: false, exempt: false }), false);
    assert.equal(selectionRangeExit({ xyDist: 26, range: IN, inView: false, exempt: false }), true);
    assert.equal(selectionRangeExit({ xyDist: 80, range: OUT, inView: false, exempt: true }), false);
  });

  // ── (6) entities.js wiring (three.js — static assertion) ────────────────
  check('entities.js imports the pure target_cycle math', () => {
    assert.match(ENTITIES_SRC, /from "\.\/target_cycle\.js"/);
    assert.match(ENTITIES_SRC, /computeSelectNext/);
    assert.match(ENTITIES_SRC, /matchesSelectionType/);
    assert.match(ENTITIES_SRC, /weightedDistance/);
  });
  check('entities.js exposes selectNext / cycleTarget / selectSelf', () => {
    assert.match(ENTITIES_SRC, /\bselectNext\(closer, extreme, type/);
    assert.match(ENTITIES_SRC, /\bcycleTarget\(mode, type/);
    assert.match(ENTITIES_SRC, /\bselectSelf\(\)/);
    assert.match(ENTITIES_SRC, /\bselectedTargetInfo\(\)/);
  });
  check('cycleTarget reuses selection ring + emits selectionChanged', () => {
    // _commitSelection routes through setSelectedTarget (the ring) and the bus.
    assert.match(ENTITIES_SRC, /_commitSelection/);
    assert.match(ENTITIES_SRC, /setSelectedTarget\(next\)/);
    assert.match(ENTITIES_SRC, /emit\?\.\("selectionChanged"/);
  });
  check('cycle drops dead (_deadFrozen) entities', () => {
    assert.match(ENTITIES_SRC, /_gatherCycleCandidates/);
    assert.match(ENTITIES_SRC, /if \(inst\._deadFrozen\) continue;/);
  });
  check('selectNext honours the ?targetCycle gate', () => {
    assert.match(ENTITIES_SRC, /_targetCycleEnabled/);
    assert.match(ENTITIES_SRC, /get\("targetCycle"\)/);
  });

  check('cycleTarget uses the retail Next/Previous dispatch behind ?retailSelectNext', () => {
    assert.match(ENTITIES_SRC, /get\("retailSelectNext"\)/);
    const ct = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('  cycleTarget(mode, type'));
    assert.match(ct, /const outward = \(mode !== "previous"\) !== \(this\._retailSelectNextOn === false\);/);
    assert.match(ct, /let g = this\.selectNext\(!outward, false, type\);\s*if \(!g\) g = this\.selectNext\(outward, true, type\);/);
    assert.match(ENTITIES_SRC, /const anchor = this\._retailSelectNextOn === false \? cur : this\._cycleAnchor\(pose\);/);
  });
  check('prevSelectedID is kept on a selection change and on despawn of the selection', () => {
    const sst = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('  setSelectedTarget(guid) {'));
    assert.match(sst.slice(0, 1500), /this\._prevSelectedGuid = \(this\._selectedGuid >>> 0\) \|\| 0;/);
    const rm = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('F16-4 — clear the selected target'));
    assert.match(rm.slice(0, 1500), /this\._prevSelectedGuid = g;/);
    assert.match(ENTITIES_SRC, /\(this\._selectedGuid >>> 0\) \|\| \(this\._prevSelectedGuid >>> 0\)/);
  });
  check('the gather applies cycleCandidateOk behind ?cycleRadarFilter', () => {
    assert.match(ENTITIES_SRC, /get\("cycleRadarFilter"\)/);
    const g = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('  _gatherCycleCandidates(type, pose) {'));
    assert.match(g.slice(0, 3000), /if \(this\._cycleRadarFilterOn === false\)/);
    assert.match(g.slice(0, 3000), /cycleCandidateOk\(inst\.meta, \{/);
    assert.match(g.slice(0, 3000), /dist2d: Math\.hypot\(p\.x - pose\.x, p\.y - pose\.y\)/);
  });
  check('tick runs the 1 s range-exit drop through _commitSelection(0)', () => {
    assert.match(ENTITIES_SRC, /get\("selectionRangeExit"\)/);
    assert.match(ENTITIES_SRC, /try \{ this\._tickSelectionRules\(_sepPlayerPose\); \}/);
    const t = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('  _tickSelectionRules(pose) {'));
    const body = t.slice(0, t.indexOf('\n  }\n'));
    assert.match(body, /this\._selRangeNextAt = now \+ 1000;/);
    assert.match(body, /if \(selectionRangeExit\(\{/);
    assert.match(body, /this\._commitSelection\(0\); \/\/ not willingly lost/);
  });
  check('plugins/radar.js re-exports the shared radar helpers from target_cycle.js', () => {
    assert.match(RADAR_SRC, /from "\.\.\/scene3d\/target_cycle\.js";/);
    assert.match(RADAR_SRC, /export \{ RADAR_RANGE_OUTDOOR, RADAR_RANGE_INDOOR, isOutdoorCell, radarRangeForCell, isShowableOnRadar \};/);
    assert.doesNotMatch(RADAR_SRC, /export function radarRangeForCell/);
  });
  check('radar-1: the radar and the cycle share radarShowableFor (the heuristic only behind ?radarRetailShowable=off)', () => {
    const info = RADAR_SRC.slice(RADAR_SRC.indexOf('function radarInfoFor('));
    const body = info.slice(0, info.indexOf('\n}\n'));
    assert.match(body, /if \(RADAR_RETAIL_SHOWABLE_ON\) \{\s*showable = radarShowableFor\(sh, guid, odf, itemType\);/);
    assert.match(body, /const \{ odf, blipColor \} = resolveRadarLook\(sh, guid, meta\);/);
    assert.doesNotMatch(body, /meta\.radarBlipColor = /, 'no one-time stash onto the spawn meta');
    const rs = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('  _radarShowable(sh, guid, meta) {'));
    assert.match(rs.slice(0, 300), /return radarShowableFor\(sh, guid, /);
  });
  check('radar-4: client_events writes __radarBlank before the fog/sound split; radar.js skips only the draws', () => {
    const CE = fs.readFileSync(path.join(__dirname, '..', 'app', 'client_events.js'), 'utf8');
    const at = CE.indexOf('ClientEventKind.ENVIRON_CHANGE) {');
    const arm = CE.slice(at, at + 1500);
    assert.ok(arm.indexOf('window.__radarBlank = radarBlankAfterEnviron(') < arm.indexOf('if (ec <= 0x06) {'));
    assert.match(RADAR_SRC, /const blank = RADAR_BLANK_ON && window\.__radarBlank === true;/);
    assert.match(RADAR_SRC, /if \(!blank\) \{\s*drawPixels\(k, blipPixels\(shape\)/);
    // hover / click still see the blank blips (DrawObjects picks before DrawBlip)
    assert.match(RADAR_SRC, /\}\s*drawn\.push\(\{/);
  });
  check('radar-5: update() no longer builds the debug snapshot each tick', () => {
    assert.doesNotMatch(RADAR_SRC, /_lastSnapshot = \{/);
    assert.match(RADAR_SRC, /snapshot: \(\) => \(_snapFormat && _snapRaw\.valid \? _snapFormat\(\) : null\)/);
  });

  // ── (7) keymap.js binds (Tab / Shift+Tab / T), no collision ─────────────
  check('keymap defines Next/Previous/Closest Monster local actions', () => {
    assert.match(KEYMAP_SRC, /"Next Monster",\s*defaultCode: "Tab"/);
    assert.match(KEYMAP_SRC, /"Previous Monster",\s*defaultCode: \{ code: "Tab", shift: true \}/);
    assert.match(KEYMAP_SRC, /"Closest Monster",\s*defaultCode: "KeyT"/);
    assert.match(KEYMAP_SRC, /NEXT_MONSTER: "0xFF000028"/);
    assert.match(KEYMAP_SRC, /PREV_MONSTER: "0xFF000029"/);
    assert.match(KEYMAP_SRC, /CLOSEST_MONSTER: "0xFF00002A"/);
  });
  check('the three cycle labelHashes are unique in LOCAL_ACTIONS', () => {
    for (const hash of ['0xFF000028', '0xFF000029', '0xFF00002A']) {
      const count = (KEYMAP_SRC.match(new RegExp(`labelHash: "${hash}"`, 'g')) || []).length;
      assert.equal(count, 1, `labelHash ${hash} should appear exactly once`);
    }
  });
  check('KeyT is not otherwise bound (no movement / other LOCAL_ACTION uses it)', () => {
    // Movement is WASDQE; the only "KeyT" default is the Closest Monster bind.
    const keyTDefaults = (KEYMAP_SRC.match(/defaultCode: "KeyT"/g) || []).length;
    assert.equal(keyTDefaults, 1);
    // Tab defaults belong only to the two monster-cycle rows.
    const tabRows = (KEYMAP_SRC.match(/defaultCode: (?:"Tab"|\{ code: "Tab")/g) || []).length;
    assert.equal(tabRows, 2);
  });

  check('death-5: four unbound corpse-loot local actions with unique labelHashes', () => {
    for (const [label, hash, id] of [
      ['Closest Unopened Corpse', '0xFF00002C', 'CLOSEST_UNOPENED_CORPSE'],
      ['Next Unopened Corpse', '0xFF00002D', 'NEXT_UNOPENED_CORPSE'],
      ['Use Closest Unopened Corpse', '0xFF00002E', 'USE_CLOSEST_UNOPENED_CORPSE'],
      ['Use Next Unopened Corpse', '0xFF00002F', 'USE_NEXT_UNOPENED_CORPSE'],
    ]) {
      assert.match(KEYMAP_SRC, new RegExp(`labelHash: "${hash}", label: "${label}", defaultCode: null`));
      assert.match(KEYMAP_SRC, new RegExp(`${id}: "${hash}"`));
      assert.equal((KEYMAP_SRC.match(new RegExp(`labelHash: "${hash}"`, 'g')) || []).length, 1, hash);
    }
  });

  // ── (8) index.html dispatch + harness hooks ─────────────────────────────
  check('death-5: index.html dispatches the corpse-loot binds to unopenedCorpseAction', () => {
    assert.match(INDEX_SRC, /\[__LOCAL_ACTION_IDS\.CLOSEST_UNOPENED_CORPSE, "closest", false\]/);
    assert.match(INDEX_SRC, /\[__LOCAL_ACTION_IDS\.USE_NEXT_UNOPENED_CORPSE, "next", true\]/);
    assert.match(INDEX_SRC, /em\.unopenedCorpseAction\(corpseAct\[1\], corpseAct\[2\] \? handle : null\)/);
    const g = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('  _gatherCycleCandidates(type, pose) {'));
    assert.match(g.slice(0, 3000), /corpseOpened: this\._openedCorpses\.has\(g\),/);
  });
  check('index.html keydown dispatches cycleTarget on the binds', () => {
    assert.match(INDEX_SRC, /NEXT_MONSTER/);
    assert.match(INDEX_SRC, /PREV_MONSTER/);
    assert.match(INDEX_SRC, /CLOSEST_MONSTER/);
    assert.match(INDEX_SRC, /em\.cycleTarget\(cycled, "monster"\)/);
    // Shift+Tab is tested before bare Tab (stricter match first).
    const prevIdx = INDEX_SRC.indexOf('cycled = "previous"');
    const nextIdx = INDEX_SRC.indexOf('cycled = "next"');
    assert.ok(prevIdx > 0 && nextIdx > 0 && prevIdx < nextIdx,
      'previous match must precede next match');
  });
  check('index.html exposes the harness hooks', () => {
    assert.match(INDEX_SRC, /window\.__selectNextTarget = /);
    assert.match(INDEX_SRC, /window\.__getSelectedTarget = /);
    assert.match(INDEX_SRC, /selectedTargetInfo/);
  });
  check('index.html __selectNextTarget forwards a mode + exposes __selectClosestTarget', () => {
    // The harness must be able to reach ClosestMonster (nearest, ignores the
    // current selection) without a keydown — the fix for the far-stray lock.
    assert.match(INDEX_SRC, /window\.__selectNextTarget = \(type, mode\)/);
    assert.match(INDEX_SRC, /em\.cycleTarget\(mode \|\| "next", type \|\| "monster"\)/);
    assert.match(INDEX_SRC, /window\.__selectClosestTarget = /);
    assert.match(INDEX_SRC, /__selectNextTarget\(type, "closest"\)/);
  });
  check('entities.js selectNext reports only the guid it actually committed', () => {
    // A pick that despawned between gather and commit is refused by
    // setSelectedTarget; selectNext must not return it as "selected".
    assert.match(ENTITIES_SRC, /const committed = \(this\._commitSelection\(pick\) >>> 0\) \|\| 0;/);
    assert.match(ENTITIES_SRC, /return committed === \(pick >>> 0\) \? pick : 0;/);
  });

  // ── (9) url-flags row present ───────────────────────────────────────────
  check('docs/url-flags.md documents ?targetCycle (default-on, =off escape)', () => {
    assert.match(FLAGS_SRC, /`targetCycle`/);
    assert.match(FLAGS_SRC, /targetCycle=off/);
  });
  check('docs/url-flags.md documents the A3-radar round 2 flags', () => {
    for (const f of ['radarRetailShowable', 'radarLiveFlags', 'radarBlank', 'attachedSoundPos']) {
      assert.match(FLAGS_SRC, new RegExp('^\\| `' + f + '`=off \\(default \\*\\*ON\\*\\*\\)', 'm'), f);
    }
  });
  check('docs/url-flags.md documents the A3-selection flags', () => {
    for (const f of ['retailSelectNext', 'cycleRadarFilter', 'selectionRangeExit']) {
      assert.match(FLAGS_SRC, new RegExp('^\\| `' + f + '`=off \\(default \\*\\*ON\\*\\*\\)', 'm'), f);
    }
  });

  // ── summary ─────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) {
      console.log(`\nFAIL: ${f.name}\n${f.err.stack || f.err.message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
