// =============================================================================
// Contracts panel pure-helper tests — Wave F.5 (2026-05-27), rewritten for
// the HUD overhaul 2026-10-05 retail port of gmContractsUI.
// =============================================================================
//
// Validates `plugins/contracts-panel.js` against retail (acclient.c) + ACE:
//
//   [1] Empty / null snapshot → no rows
//   [2] Single-tracker projection
//   [3] Status text = gmContractsUI::FillProgressString per ContractStage
//       (1 Available / 2 In Progress / 3 Done | Available | "Done (x to
//       Repeat)" / ≥4 description_progress with stage − 4)
//   [4] ClientUISystem::DeltaTimeToString formatting
//   [5] Time fields are SECONDS REMAINING (ACE ContractTracker.cs), counted
//       down from receipt; i64 bit patterns of the wire double decode
//   [6] LandDefs::gid_to_lcoord coordinates + "Indoors"
//   [7] Contact NPC choice + Timed text (gmContractsUI::UpdateButtons)
//   [8] Sort by name / status with reverse (SortContractList)
//   [9] DAT record lookup via window.__hbWasm (and Map-shaped records)
//  [10] Receive-time stamping
//  [11] manifest / view exports
//
// Run from apps/holtburger-web/:
//   node tests/contracts_panel.test.cjs
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

// jsdom-lite stub — just enough that module evaluation (contracts-panel.js
// → social-panel.js → modal-dialog.js / ac_window_position.js / hud_kit.js)
// does not throw. Only pure helpers are exercised.
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
  };
  function makeEl() {
    const el = Object.create(proto);
    el.children = [];
    el.style = {};
    el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
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
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
}

async function main() {
  console.log('Contracts panel pure-helpers tests (gmContractsUI retail port)');
  console.log('═══════════════════════════════════════════════════════════════');
  installDomShim();
  const panel = await import(PANEL_URL);
  const {
    buildContractsViewModel, contractStatusText, deltaTimeToString, decodeWireSeconds,
    cellToMapCoords, worldToMapCoords, formatMapCoords, contractContact, contractTimedText,
    sortContractRows, formatProgressTemplate, normalizeContractRecord, lookupContractRecord,
    noteContractTrackers, CONTRACT_STAGE,
  } = panel;
  const NOW = 1_712_000_000;
  const noRec = () => null;

  // [1]
  check('null snapshot → no rows', () => {
    const vm = buildContractsViewModel(null, NOW, { lookup: noRec });
    assert.equal(vm.count, 0);
    assert.deepEqual(vm.rows, []);
    assert.equal(vm.displayContractId, 0);
  });
  check('empty trackers → no rows', () => {
    const vm = buildContractsViewModel({ trackers: [], displayContractId: 0 }, NOW, { lookup: noRec });
    assert.equal(vm.count, 0);
  });

  // [2]
  check('single tracker → one row with retail fields', () => {
    const snap = { trackers: [{ contractId: 0x14, stage: 2, timeWhenDone: 0, timeWhenRepeats: 0 }] };
    const vm = buildContractsViewModel(snap, NOW, { lookup: noRec });
    assert.equal(vm.rows.length, 1);
    const r = vm.rows[0];
    assert.equal(r.id, 0x14);
    assert.equal(r.name, 'Contract 20');
    assert.equal(r.status, 'In Progress');
    assert.equal(r.timed, 'None');
    assert.equal(r.contact, 'None');
    assert.equal(r.complete, false);
  });
  check('displayContractId passes through', () => {
    const vm = buildContractsViewModel({ trackers: [], displayContractId: 8 }, NOW, { lookup: noRec });
    assert.equal(vm.displayContractId, 8);
  });

  // [3]
  check('stage 1 → "Available", stage 2 → "In Progress"', () => {
    assert.equal(contractStatusText(CONTRACT_STAGE.Available, null, 0), 'Available');
    assert.equal(contractStatusText(CONTRACT_STAGE.InProgress, null, 0), 'In Progress');
  });
  check('stage 3 with no repeat flag → "Done"; with a repeat flag and no wait → "Available"', () => {
    assert.equal(contractStatusText(3, null, 0), 'Done');
    assert.equal(contractStatusText(3, { questflagRepeatTime: 'q_repeat' }, 0), 'Available');
  });
  check('stage 3 waiting to repeat → "Done (<delta> to Repeat)"', () => {
    assert.equal(contractStatusText(3, { questflagRepeatTime: 'q' }, 3725), 'Done (1h 2m 5s to Repeat)');
  });
  check('stage ≥4 fills description_progress with stage − 4', () => {
    assert.equal(contractStatusText(7, { descriptionProgress: '%d/5 Drudges Slain' }, 0), '3/5 Drudges Slain');
    assert.equal(contractStatusText(4, { descriptionProgress: '' }, 0), 'In Progress');
  });
  check('formatProgressTemplate handles %% and only the first conversion', () => {
    assert.equal(formatProgressTemplate('%d%% done, %d left', 40), '40% done, %d left');
    assert.equal(formatProgressTemplate('%i of 9', 2), '2 of 9');
  });

  // [4]
  check('deltaTimeToString matches ClientUISystem::DeltaTimeToString', () => {
    assert.equal(deltaTimeToString(0), '0s');
    assert.equal(deltaTimeToString(45), '45s');
    assert.equal(deltaTimeToString(3600), '1h 0s');
    assert.equal(deltaTimeToString(3725), '1h 2m 5s');
    assert.equal(deltaTimeToString(90061), '1d 1h 1m 1s');
    assert.equal(deltaTimeToString(2592000 + 5), '1mo 5s');
    assert.equal(deltaTimeToString(-10), '0s');
  });

  // [5]
  check('decodeWireSeconds: plain seconds pass through, junk → 0', () => {
    assert.equal(decodeWireSeconds(3600), 3600);
    assert.equal(decodeWireSeconds(0), 0);
    assert.equal(decodeWireSeconds(-5), 0);
    assert.equal(decodeWireSeconds(NaN), 0);
    assert.equal(decodeWireSeconds(undefined), 0);
  });
  check('decodeWireSeconds: i64 bit pattern of a double decodes (protocol reads f64 as i64)', () => {
    const bits = (d) => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, d, true);
      return Number(dv.getBigInt64(0, true));
    };
    assert.equal(decodeWireSeconds(bits(3600)), 3600);
    assert.ok(Math.abs(decodeWireSeconds(bits(86399.873)) - 86399.873) < 1e-6);
    assert.equal(decodeWireSeconds(bits(-1)), 0, 'negative double (unlimited/expired) → 0');
  });
  check('repeat countdown subtracts time since receipt', () => {
    const snap = { trackers: [{ contractId: 1, stage: 3, timeWhenRepeats: 3600 }] };
    const vm = buildContractsViewModel(snap, NOW, { lookup: noRec, receivedAtSec: () => NOW - 100 });
    assert.equal(vm.rows[0].repeatRemaining, 3500);
    assert.equal(vm.rows[0].status, 'Done (58m 20s to Repeat)');
    assert.equal(vm.rows[0].ticking, true);
  });
  check('repeat elapsed since receipt → not ticking, status no longer counts down', () => {
    const snap = { trackers: [{ contractId: 1, stage: 3, timeWhenRepeats: 60 }] };
    const vm = buildContractsViewModel(snap, NOW, { lookup: () => ({ questflagRepeatTime: 'q' }), receivedAtSec: () => NOW - 120 });
    assert.equal(vm.rows[0].repeatRemaining, 0);
    assert.equal(vm.rows[0].status, 'Available');
    assert.equal(vm.rows[0].ticking, false);
  });

  // [6]
  check('cellToMapCoords: outdoor cell → retail lcoord coordinates', () => {
    const c = cellToMapCoords(0xA9B4001F);
    assert.ok(c);
    assert.equal(formatMapCoords(c), '42.7N, 33.6E');
  });
  check('cellToMapCoords: dungeon cell / 0 → null → "Indoors"', () => {
    assert.equal(cellToMapCoords(0x01D90108), null);
    assert.equal(cellToMapCoords(0), null);
    assert.equal(formatMapCoords(null), 'Indoors');
  });
  check('worldToMapCoords: global/240 − 102 (ACE GetMapCoords), indoors → null', () => {
    assert.equal(formatMapCoords(worldToMapCoords(0xA9B4001F, 96, 96)), '42.4N, 33.6E');
    assert.equal(worldToMapCoords(0x01D90108, 10, 10), null);
    assert.equal(formatMapCoords({ ns: -12.25, ew: -0.04 }), '12.3S, 0.0W');
  });

  // [7]
  check('contractContact: start NPC unless in progress with an end NPC', () => {
    const rec = {
      nameNpcStart: 'Avarin', nameNpcEnd: 'Turnin', locationNpcStart: { cellId: 1 }, locationNpcEnd: { cellId: 2 },
    };
    assert.deepEqual(contractContact(1, rec), { name: 'Avarin', cellId: 1 });
    assert.deepEqual(contractContact(2, rec), { name: 'Turnin', cellId: 2 });
    assert.deepEqual(contractContact(5, rec), { name: 'Turnin', cellId: 2 });
    assert.deepEqual(contractContact(3, rec), { name: 'Avarin', cellId: 1 });
    assert.deepEqual(contractContact(2, { nameNpcStart: 'Solo', locationNpcStart: { cellId: 9 } }), { name: 'Solo', cellId: 9 });
  });
  check('contractTimedText: None / remaining / Finished', () => {
    assert.equal(contractTimedText({}, 100), 'None');
    assert.equal(contractTimedText({ questflagTimer: 't' }, 65), '1m 5s');
    assert.equal(contractTimedText({ questflagTimer: 't' }, 0), 'Finished');
  });

  // [8]
  check('sortContractRows: name asc, reverse, status', () => {
    const rows = [
      { id: 1, name: 'Bravo', status: 'In Progress' },
      { id: 2, name: 'alpha', status: 'Available' },
      { id: 3, name: 'Charlie', status: 'Available' },
    ];
    assert.deepEqual(sortContractRows(rows, 'name').map((r) => r.id), [2, 1, 3]);
    assert.deepEqual(sortContractRows(rows, 'name', true).map((r) => r.id), [3, 1, 2]);
    assert.deepEqual(sortContractRows(rows, 'status').map((r) => r.id), [2, 3, 1]);
  });

  // [9]
  check('no wasm table → "Contract N" placeholder', () => {
    assert.equal(lookupContractRecord(200), null);
    const vm = buildContractsViewModel({ trackers: [{ contractId: 200, stage: 2 }] }, NOW);
    assert.equal(vm.rows[0].name, 'Contract 200');
  });
  check('window.__hbWasm.getContractRecord supplies name / NPC / locations', () => {
    globalThis.window.__hbWasm = {
      getContractRecord: (id) => (id === 0xC8 ? {
        id: 0xC8,
        name: 'Jailbreak: Ardent Leader',
        nameNpcStart: 'Avarin',
        nameNpcEnd: '',
        description: 'Defeat the Large Ardent Moarsman in the Freebooter Prison.',
        descriptionProgress: '%d/1 Large Ardent Moarsman',
        questflagTimer: '',
        locationNpcStart: { cellId: 0xA9B4001F },
        locationQuestArea: { cellId: 0x69010100 },
      } : null),
    };
    const vm = buildContractsViewModel({ trackers: [{ contractId: 0xC8, stage: 4 }] }, NOW);
    const r = vm.rows[0];
    assert.equal(r.name, 'Jailbreak: Ardent Leader');
    assert.equal(r.status, '0/1 Large Ardent Moarsman');
    assert.equal(r.contact, 'Avarin');
    assert.equal(r.contactLoc, '42.7N, 33.6E');
    assert.equal(r.questLoc, 'Indoors');
    assert.equal(r.timed, 'None');
    assert.ok(r.notes.startsWith('Defeat the Large'));
    delete globalThis.window.__hbWasm;
  });
  check('legacy window.getContractRecord + Map-shaped record (serde_wasm_bindgen)', () => {
    globalThis.window.getContractRecord = () => new Map([
      ['name', 'Map Contract'],
      ['nameNpcStart', 'Mapper'],
      ['locationNpcStart', new Map([['cellId', 0xA9B4001F]])],
    ]);
    const rec = lookupContractRecord(5);
    assert.equal(rec.name, 'Map Contract');
    assert.equal(rec.locationNpcStart.cellId, 0xA9B4001F);
    const vm = buildContractsViewModel({ trackers: [{ contractId: 5, stage: 1 }] }, NOW);
    assert.equal(vm.rows[0].contact, 'Mapper');
    delete globalThis.window.getContractRecord;
  });
  check('normalizeContractRecord leaves plain objects alone', () => {
    const o = { name: 'x' };
    assert.equal(normalizeContractRecord(o), o);
    assert.equal(normalizeContractRecord(null), null);
  });

  // [10]
  check('noteContractTrackers stamps new / changed trackers only', () => {
    const m = new Map();
    noteContractTrackers([{ contractId: 1, stage: 3, timeWhenDone: 0, timeWhenRepeats: 100 }], 10, m);
    noteContractTrackers([{ contractId: 1, stage: 3, timeWhenDone: 0, timeWhenRepeats: 100 }], 20, m);
    assert.equal(m.get(1).atSec, 10, 'unchanged tracker keeps its stamp');
    noteContractTrackers([{ contractId: 1, stage: 3, timeWhenDone: 0, timeWhenRepeats: 90 }], 30, m);
    assert.equal(m.get(1).atSec, 30, 'changed tracker re-stamped');
  });

  // [11]
  check('manifest + view exports', () => {
    assert.equal(panel.manifest.id, 'contracts-panel');
    assert.equal(panel.manifest.version, '0.4.0');
    assert.equal(panel.view.name, 'Contracts');
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
