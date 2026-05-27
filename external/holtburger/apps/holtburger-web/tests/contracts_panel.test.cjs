// =============================================================================
// Wave F.5 (2026-05-27) — contracts panel pure-helpers tests
// =============================================================================
//
// Validates `plugins/contracts-panel.js::buildContractsViewModel` and
// the related stage/countdown logic against the Wave F.5 spec:
//
//   [1] Empty snapshot (null + 0-entry) → 0 rows, "0 / 7" header
//   [2] Single-tracker projection (id, stageLabel, cooldown)
//   [3] Multi-tracker sort preservation (wasm sorts; panel preserves)
//   [4] ContractStage label mapping (1/2/3 → New/Active/Done)
//   [5] Cooldown countdown formatting (HH:MM:SS / "ready" / "—")
//   [6] Display-cap is 7 (retail panel header convention)
//   [7] displayContractId pass-through from snapshot
//
// Run from apps/holtburger-web/:
//   node tests/contracts_panel.test.cjs
//
// The plugin file imports from `../ui/ac_font.js` and `../ui/ac_layout.js`
// (CSS-touching DOM utilities). The test only exercises the pure helper
// `buildContractsViewModel` via dynamic import after the jsdom-lite shim
// keeps top-level `document` / `window` accesses from crashing the
// module evaluation.
// =============================================================================

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const PANEL_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'contracts-panel.js')
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

// jsdom-lite stub — contracts-panel.js touches `document`, `window`,
// and `setAcText` (which reads from ac_font.js → document operations).
// Just enough to keep top-level module evaluation from throwing.
function installDomShim() {
  if (typeof globalThis.document !== 'undefined') return;
  const proto = {
    appendChild(c) { (this.children ||= []).push(c); return c; },
    setAttribute(k, v) { (this.attrs ||= {})[k] = v; },
    getAttribute(k) { return (this.attrs || {})[k]; },
    removeAttribute(k) { delete (this.attrs || {})[k]; },
    addEventListener() {},
    removeEventListener() {},
    insertBefore(c) { (this.children ||= []).push(c); return c; },
    removeChild() {},
    remove() {},
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    cloneNode() { return makeEl(); },
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    dataset: {},
  };
  function makeEl() {
    const el = Object.create(proto);
    el.children = [];
    el.style = {};
    el.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    };
    el.dataset = {};
    el.attrs = {};
    return el;
  }
  globalThis.document = {
    createElement: () => makeEl(),
    createTextNode: () => makeEl(),
    getElementById: () => null,
    head: makeEl(),
    body: makeEl(),
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    __sessionHandle: null,
    __pluginClient: null,
  };
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = (fn) => { try { fn(); } catch (_) {} return 0; };
  globalThis.clearTimeout = () => {};
}

async function loadPanel() {
  installDomShim();
  const mod = await import(PANEL_URL);
  return mod;
}

async function main() {
  console.log('Wave F.5 — Contracts panel pure-helpers tests');
  console.log('═══════════════════════════════════════════════════════════════');

  const panel = await loadPanel();
  const { buildContractsViewModel } = panel;
  assert.ok(typeof buildContractsViewModel === 'function',
    'buildContractsViewModel exported');

  // [1] Empty snapshot — null
  check('null snapshot → 0 rows, 0/7 header', () => {
    const vm = buildContractsViewModel(null, 1_712_000_000);
    assert.equal(vm.count, 0);
    assert.equal(vm.displayCap, 7);
    assert.deepEqual(vm.rows, []);
    assert.equal(vm.displayContractId, 0);
  });

  // [1b] Empty snapshot — present but empty trackers
  check('empty trackers → 0 rows', () => {
    const snap = { trackers: [], displayContractId: 0 };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.count, 0);
    assert.deepEqual(vm.rows, []);
  });

  // [2] Single-tracker projection
  check('single tracker → 1 row, fields populated', () => {
    const snap = {
      trackers: [
        { contractId: 0x0014, stage: 2, version: 1, timeWhenDone: 0, timeWhenRepeats: 0 },
      ],
      displayContractId: 0,
    };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.rows.length, 1);
    const r = vm.rows[0];
    assert.equal(r.id, 0x0014);
    assert.equal(r.stage, 2);
    assert.equal(r.stageLabel, 'Active');
    assert.equal(r.progress, 'Active');
    assert.equal(r.complete, false);
    assert.equal(r.cooldown, '—'); // InProgress = no cooldown column
    assert.ok(r.name.includes(String(0x0014)));
  });

  // [3] Multi-tracker sort preservation (wasm pre-sorted ascending)
  check('multi tracker → preserves wasm sort', () => {
    const snap = {
      trackers: [
        { contractId: 0x0001, stage: 1, version: 1, timeWhenDone: 0, timeWhenRepeats: 0 },
        { contractId: 0x0014, stage: 2, version: 1, timeWhenDone: 0, timeWhenRepeats: 0 },
        { contractId: 0x0042, stage: 3, version: 1, timeWhenDone: 1_712_086_400, timeWhenRepeats: 1_712_172_800 },
      ],
      displayContractId: 0,
    };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.rows.length, 3);
    assert.equal(vm.rows[0].id, 0x0001);
    assert.equal(vm.rows[1].id, 0x0014);
    assert.equal(vm.rows[2].id, 0x0042);
  });

  // [4] Stage label mapping
  check('stage 1 → "New"', () => {
    const snap = { trackers: [{ contractId: 1, stage: 1 }], displayContractId: 0 };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.rows[0].stageLabel, 'New');
    assert.equal(vm.rows[0].progress, 'New');
    assert.equal(vm.rows[0].complete, false);
  });
  check('stage 2 → "Active"', () => {
    const snap = { trackers: [{ contractId: 1, stage: 2 }], displayContractId: 0 };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.rows[0].stageLabel, 'Active');
    assert.equal(vm.rows[0].complete, false);
  });
  check('stage 3 → "Done" + complete=true', () => {
    const snap = { trackers: [{ contractId: 1, stage: 3 }], displayContractId: 0 };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.rows[0].stageLabel, 'Done');
    assert.equal(vm.rows[0].complete, true);
  });
  check('stage 5 (contract-specific) → "Stage 5"', () => {
    const snap = { trackers: [{ contractId: 1, stage: 5 }], displayContractId: 0 };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.rows[0].stageLabel, 'Stage 5');
  });

  // [5] Cooldown formatting (DoneOrPendingRepeat with future repeat)
  check('countdown 1h30m45s', () => {
    const now = 1_712_000_000;
    const repeats = now + 3600 + 30 * 60 + 45; // 01:30:45
    const snap = {
      trackers: [{ contractId: 1, stage: 3, timeWhenDone: now - 100, timeWhenRepeats: repeats }],
      displayContractId: 0,
    };
    const vm = buildContractsViewModel(snap, now);
    assert.equal(vm.rows[0].cooldown, '01:30:45');
  });
  check('countdown 0 padding HH:MM:SS', () => {
    const now = 1_712_000_000;
    const repeats = now + 65; // 00:01:05
    const snap = {
      trackers: [{ contractId: 1, stage: 3, timeWhenDone: now - 100, timeWhenRepeats: repeats }],
      displayContractId: 0,
    };
    const vm = buildContractsViewModel(snap, now);
    assert.equal(vm.rows[0].cooldown, '00:01:05');
  });
  check('countdown past → "ready"', () => {
    const now = 1_712_000_000;
    const repeats = now - 100; // past
    const snap = {
      trackers: [{ contractId: 1, stage: 3, timeWhenDone: now - 200, timeWhenRepeats: repeats }],
      displayContractId: 0,
    };
    const vm = buildContractsViewModel(snap, now);
    assert.equal(vm.rows[0].cooldown, 'ready');
  });
  check('cooldown column empty on non-Done stage', () => {
    const now = 1_712_000_000;
    const snap = {
      trackers: [{ contractId: 1, stage: 2, timeWhenDone: 0, timeWhenRepeats: now + 100 }],
      displayContractId: 0,
    };
    const vm = buildContractsViewModel(snap, now);
    assert.equal(vm.rows[0].cooldown, '—');
  });

  // [6] Display cap is 7
  check('displayCap is 7', () => {
    const vm = buildContractsViewModel(null, 0);
    assert.equal(vm.displayCap, 7);
  });

  // [7] displayContractId pass-through
  check('displayContractId pass-through', () => {
    const snap = {
      trackers: [{ contractId: 0x0008, stage: 2 }],
      displayContractId: 0x0008,
    };
    const vm = buildContractsViewModel(snap, 1_712_000_000);
    assert.equal(vm.displayContractId, 0x0008);
  });

  // [8] Manifest version bump
  check('manifest version is 0.3.0', () => {
    assert.equal(panel.manifest.version, '0.3.0',
      'Wave F.5 bumps from 0.2.0 to 0.3.0');
    assert.equal(panel.manifest.id, 'contracts-panel');
  });

  // [9] view.name + view.nameFor
  check('view exports name + nameFor', () => {
    assert.equal(panel.view.name, 'Contracts');
    assert.equal(typeof panel.view.nameFor, 'function');
    assert.equal(panel.view.nameFor(), 'Contracts');
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Passed: ${passed}    Failed: ${failed}`);
  if (failed > 0) {
    for (const { name, err } of failures) {
      console.log(`  [FAIL] ${name}`);
      console.log(`         ${err.stack || err.message}`);
    }
    process.exit(1);
  }
  console.log('All contracts-panel tests passed.');
}

main().catch((err) => {
  console.log('Test driver failed:', err);
  process.exit(2);
});
