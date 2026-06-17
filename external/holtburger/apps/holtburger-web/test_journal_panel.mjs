// HUD rec #147 (2026-06-16) — journal-panel quest-projection test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_journal_panel.mjs
//
// Covers projectContractsToJournalEntries — the pure projection from a
// SessionHandle.playerContracts() snapshot + DAT ContractTable lookup into
// the journal's {id, title, status, body} entry shape. The contract tracker
// IS the retail quest journal (ACE has no QuestUpdate opcode), so this is
// where the journal's live data comes from.
//
// A minimal DOM shim lets us import the real plugin module (its DOM work is
// inside mount(), which we don't drive here) so the function under test is
// the shipping one, not a copy.

globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, addEventListener() {}, append() {}, remove() {}, children: [],
  }),
  getElementById: () => null,
  head: { appendChild() {} },
  body: { appendChild() {} },
};

const { projectContractsToJournalEntries } = await import("./plugins/journal-panel.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

console.log("===========================================================");
console.log("HUD rec #147 — journal-panel contract → quest projection");
console.log("===========================================================\n");

const NOW = 1_000_000;

check("null snapshot → []", () => {
  assertEq(projectContractsToJournalEntries(null, () => null, NOW), [], "null");
});

check("empty trackers → []", () => {
  assertEq(projectContractsToJournalEntries({ trackers: [] }, () => null, NOW), [], "empty");
});

check("stage 1 (New) / stage 2 (InProgress) → active", () => {
  const snap = { trackers: [{ contractId: 1, stage: 1 }, { contractId: 2, stage: 2 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out.map((e) => e.status), ["active", "active"], "stages 1+2");
});

check("stage 3 with no repeat timer → complete", () => {
  const snap = { trackers: [{ contractId: 3, stage: 3, timeWhenRepeats: 0 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out[0].status, "complete", "done");
});

check("stage 3 with future repeat → cooldown", () => {
  const snap = { trackers: [{ contractId: 4, stage: 3, timeWhenRepeats: NOW + 3600 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out[0].status, "cooldown", "cooldown");
});

check("stage 3 with past repeat → complete (ready again)", () => {
  const snap = { trackers: [{ contractId: 5, stage: 3, timeWhenRepeats: NOW - 60 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out[0].status, "complete", "past-repeat");
});

check("title falls back to 'Contract <id>' when no DAT record", () => {
  const snap = { trackers: [{ contractId: 42, stage: 1 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out[0].title, "Contract 42", "fallback-title");
});

check("DAT record supplies name + description", () => {
  const snap = { trackers: [{ contractId: 7, stage: 2 }] };
  const lookup = (id) => id === 7
    ? { name: "Aun Tutelage", description: "Seek the Aun elders.", descriptionProgress: "" }
    : null;
  const out = projectContractsToJournalEntries(snap, lookup, NOW);
  assertEq(out[0].title, "Aun Tutelage", "title");
  assertEq(out[0].body, "Seek the Aun elders.", "body");
});

check("descriptionProgress %d placeholders blanked + folded into body", () => {
  const snap = { trackers: [{ contractId: 8, stage: 2 }] };
  const lookup = () => ({ name: "Kill Quest", description: "Slay the drudges.", descriptionProgress: "%d/5 drudges" });
  const out = projectContractsToJournalEntries(snap, lookup, NOW);
  assertEq(out[0].progressText, "?/5 drudges", "progress");
  assertEq(out[0].body, "Slay the drudges.  •  ?/5 drudges", "body-with-progress");
});

check("progress not duplicated when already in description", () => {
  const snap = { trackers: [{ contractId: 9, stage: 2 }] };
  const lookup = () => ({ name: "Q", description: "Find 3 gems", descriptionProgress: "Find 3 gems" });
  const out = projectContractsToJournalEntries(snap, lookup, NOW);
  assertEq(out[0].body, "Find 3 gems", "no-dupe");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
