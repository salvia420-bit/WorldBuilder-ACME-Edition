// Rec #65 — unit tests for the StateDesc.pass_to_children cascade.
//
// The DAT crate (file_type/state_desc.rs) carries a `pass_to_children`
// bool that, when set, propagates the StateDesc's overrides (sprite /
// color / position-delta / extent) down the LayoutDesc element tree to
// every descendant of the element holding the override. The wasm-side
// fetch_layout serializer emits this flag verbatim (src/lib.rs:7794).
//
// `collectCascadedStates` in ui/ac_layout.js is the test-friendly
// projection of that cascade — given a root ElementDesc, it returns
// per-element {own, inherited} StateDesc arrays so a renderer can
// later pick the right precedence (own wins; inherited fills in
// unset fields). This file exercises the helper against synthetic
// fixtures so the cascade behaviour is locked in regardless of
// future wasm-side schema tweaks.
//
// Run from apps/holtburger-web/:
//   node tests/layout_state_inheritance.test.cjs

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const LAYOUT_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'ac_layout.js')
).href;

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

(async () => {
  const { collectCascadedStates } = await import(LAYOUT_URL);

  // Fixture builder — element with an optional state_desc + states map
  // + children. Mirrors the wasm v3 serializer's per-element shape.
  function elem(key, opts = {}) {
    const e = { key };
    if (opts.state_desc) e.state_desc = opts.state_desc;
    if (opts.states) e.states = opts.states;
    if (opts.children) e.children = opts.children;
    return e;
  }
  function stateDesc(stateId, pass) {
    return {
      state_id: stateId,
      pass_to_children: !!pass,
      properties: {},
      media: [],
    };
  }

  // ── Test 1 — single ancestor pass_to_children=true ────────────
  check('cascade: pass_to_children=true reaches a direct child', () => {
    const parentState = stateDesc(0, true);
    const root = elem(1, {
      state_desc: parentState,
      children: [elem(2)],
    });
    const map = collectCascadedStates(root);
    const child = map.get(2);
    assert.ok(child, 'child entry missing');
    assert.strictEqual(child.inherited.length, 1);
    assert.strictEqual(child.inherited[0], parentState);
    assert.strictEqual(child.own.length, 0);
  });

  // ── Test 2 — pass_to_children=false does NOT propagate ───────
  check('cascade: pass_to_children=false stays on the parent', () => {
    const parentState = stateDesc(0, false);
    const root = elem(1, {
      state_desc: parentState,
      children: [elem(2)],
    });
    const map = collectCascadedStates(root);
    const child = map.get(2);
    assert.ok(child);
    assert.strictEqual(child.inherited.length, 0);
  });

  // ── Test 3 — multi-level cascade composes ─────────────────────
  check('cascade composes across multiple levels of pass_to_children', () => {
    const gp = stateDesc(0, true);
    const mid = stateDesc(0, true);
    const root = elem(1, {
      state_desc: gp,
      children: [
        elem(2, {
          state_desc: mid,
          children: [elem(3)],
        }),
      ],
    });
    const map = collectCascadedStates(root);
    const leaf = map.get(3);
    assert.ok(leaf);
    // Most-recent ancestor first per the helper contract.
    assert.strictEqual(leaf.inherited.length, 2);
    assert.strictEqual(leaf.inherited[0], mid);
    assert.strictEqual(leaf.inherited[1], gp);
  });

  // ── Test 4 — sibling isolation (cascade is per-subtree) ───────
  check('cascade does not bleed across sibling subtrees', () => {
    const passing = stateDesc(0, true);
    const root = elem(1, {
      children: [
        elem(2, { state_desc: passing, children: [elem(3)] }),
        elem(4, { children: [elem(5)] }),
      ],
    });
    const map = collectCascadedStates(root);
    assert.strictEqual(map.get(3).inherited.length, 1);
    assert.strictEqual(map.get(5).inherited.length, 0);
  });

  // ── Test 5 — element with own override + inherited cascade ───
  check('own states are kept separate from inherited cascade', () => {
    const ancestorPass = stateDesc(0, true);
    const childOwn = stateDesc(1, false);
    const root = elem(1, {
      state_desc: ancestorPass,
      children: [
        elem(2, {
          state_desc: childOwn,
          states: { '1': childOwn },
        }),
      ],
    });
    const map = collectCascadedStates(root);
    const child = map.get(2);
    assert.ok(child);
    assert.strictEqual(child.own.length, 1);
    assert.strictEqual(child.own[0], childOwn);
    assert.strictEqual(child.inherited.length, 1);
    assert.strictEqual(child.inherited[0], ancestorPass);
  });

  // ── Test 6 — empty children array doesn't break the walk ──────
  check('empty / missing children arrays are safe', () => {
    const root = elem(1, { state_desc: stateDesc(0, true) });
    const map = collectCascadedStates(root);
    assert.strictEqual(map.size, 1);
    assert.strictEqual(map.get(1).inherited.length, 0);
  });

  // ── Test 7 — multiple pass_through states on same element ────
  check('multiple pass_to_children states on one element all cascade', () => {
    const passA = stateDesc(0, true);
    const passB = stateDesc(1, true);
    const root = elem(1, {
      states: { '0': passA, '1': passB },
      children: [elem(2)],
    });
    const map = collectCascadedStates(root);
    const child = map.get(2);
    assert.ok(child);
    // Order within a single element's states is implementation-defined
    // (Object.values), but both should be present.
    assert.strictEqual(child.inherited.length, 2);
    assert.ok(child.inherited.includes(passA));
    assert.ok(child.inherited.includes(passB));
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const { name, err } of failures) {
      console.log(`  - ${name}: ${err.message}`);
    }
    process.exit(1);
  }
})().catch((e) => {
  console.error('Test harness error:', e);
  process.exit(1);
});
