// C2 (2026-07-12) — retail target-cycling ordering + cycle logic.
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

  // Emulate EntityManager.cycleTarget's retail wrap dispatch over the pure
  // primitive, so the sequence tests exercise the same next→wrap logic.
  const selectNext = (cur, closer, extreme) =>
    computeSelectNext(WORLD, cur, SELF, closer, extreme);
  const cycle = (mode, cur) => {
    if (mode === 'closest') return selectNext(cur, true, true) || cur;
    if (mode === 'previous') {
      let g = selectNext(cur, false, false);
      if (!g) g = selectNext(cur, true, true);
      return g || cur;
    }
    let g = selectNext(cur, true, false);
    if (!g) g = selectNext(cur, false, true);
    return g || cur;
  };

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
  check('closer step from mid selection → immediately closer', () => {
    assert.equal(selectNext(0xB, true, false), 0xA); // closer than B(5) = A(1)
    assert.equal(selectNext(0xC, true, false), 0xB); // closer than C(10) = B(5)
  });
  check('closer step from nearest → 0 (nothing closer → caller wraps)', () => {
    assert.equal(selectNext(0xA, true, false), 0);
  });
  check('farther step from mid selection → immediately farther', () => {
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
    assert.equal(computeSelectNext(tied, 0xC, SELF, true, false), 0xD);
    // nearest overall is still A(1); the 5m tie doesn't affect it.
    assert.equal(computeSelectNext(tied, 0, SELF, true, false), 0xA);
  });

  // ── (4b) round-4c far-stray regression (the selectNext bug) ─────────────
  // Real r4c world (journal wf_68abc3df-e11): a freshly @create'd Pyreal
  // Target Drudge at ~5yd next to two far strays the cycle kept locking —
  // "The Chicken" 0x8000967b @~100yd (HIGHEST guid) and "Drudge Slinker"
  // 0x8000920d @~121yd (FARTHEST). centerSetup called __selectNextTarget
  // ("monster") = NextMonster, which wrapped to the far stray instead of the
  // near drudge. These pin WHY, and that ClosestMonster is the fix.
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
  const r4cSel = (cur, closer, extreme) =>
    computeSelectNext(R4C_WORLD, cur, R4C.self, closer, extreme);
  const r4cCycle = (mode, cur) => {
    if (mode === 'closest') return r4cSel(cur, true, true) || cur;
    let g = r4cSel(cur, true, false);
    if (!g) g = r4cSel(cur, false, true);
    return g || cur;
  };
  check('r4c: NextMonster from the near drudge WRAPS to the farthest stray (the bug)', () => {
    // Drudge already selected (the nearest) → "next" finds nothing closer →
    // wraps to farthest = Drudge Slinker @121yd. This is the observed defect:
    // a cycle re-issued after the near drudge is held jumps to a far mob.
    assert.equal(r4cCycle('next', R4C.drudge), R4C.slinker);
  });
  check('r4c: NextMonster with NO selection does pick the near drudge (clean-slate step)', () => {
    // From an empty selection the first "next" IS the nearest; the failure only
    // bites once a stale selection exists OR the drudge is not yet a candidate.
    assert.equal(r4cCycle('next', 0), R4C.drudge);
  });
  check('r4c: ClosestMonster locks the near drudge from ANY prior selection (the fix)', () => {
    assert.equal(r4cCycle('closest', 0), R4C.drudge);
    assert.equal(r4cCycle('closest', R4C.drudge), R4C.drudge); // holds; never wraps
    assert.equal(r4cCycle('closest', R4C.chicken), R4C.drudge);
    assert.equal(r4cCycle('closest', R4C.slinker), R4C.drudge);
  });
  check('r4c: while the drudge is mid-bake (absent), closest reaches only the nearer stray', () => {
    // The async-spawn race: spawn() commits to entityMap only after the mesh
    // bakes, so a just-@create'd drudge is briefly NOT a candidate. closest
    // then reaches the nearer stray (chicken@100 < slinker@121) — which is why
    // the harness must POLL closest until the near drudge goes live.
    const noDrudge = R4C_WORLD.filter((c) => c.guid !== R4C.drudge);
    assert.equal(computeSelectNext(noDrudge, 0, R4C.self, true, true), R4C.chicken);
  });

  // ── (5) cycleTarget wrap sequences (acclient.c:399692-399746) ───────────
  check('NextMonster sequence: nearest, then farthest, descending, wrap', () => {
    // A(nearest) → C(wrap to farthest) → B → A → C … (the retail quirk).
    let g = 0;
    const seq = [];
    for (let i = 0; i < 6; i++) { g = cycle('next', g); seq.push(g); }
    assert.deepEqual(seq, [0xA, 0xC, 0xB, 0xA, 0xC, 0xB]);
  });
  check('PreviousMonster sequence: farthest, then nearest, ascending, wrap', () => {
    let g = 0;
    const seq = [];
    for (let i = 0; i < 6; i++) { g = cycle('previous', g); seq.push(g); }
    assert.deepEqual(seq, [0xC, 0xA, 0xB, 0xC, 0xA, 0xB]);
  });
  check('ClosestMonster always selects the nearest', () => {
    assert.equal(cycle('closest', 0), 0xA);
    assert.equal(cycle('closest', 0xC), 0xA);
    assert.equal(cycle('closest', 0xB), 0xA);
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

  // ── (8) index.html dispatch + harness hooks ─────────────────────────────
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
