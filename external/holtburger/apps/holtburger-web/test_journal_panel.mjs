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

const {
  projectContractsToJournalEntries, timerDurationMs, journalTimerText,
  normalizeJournalPages, isBlankJournalPage,
} = await import("./plugins/journal-panel.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(cond, label) { if (!cond) throw new Error(label); }
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

// HUD overhaul 2026-10-05 — ACE's TimeWhenRepeats is SECONDS REMAINING at
// send time (ContractTracker.cs: GetNextSolveTime().TotalSeconds), not an
// epoch; retail subtracts the time since `_time_of_server_update`
// (gmContractsUI::FillProgressString).
check("stage 3 with repeat time remaining → cooldown", () => {
  const snap = { trackers: [{ contractId: 4, stage: 3, timeWhenRepeats: 3600 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out[0].status, "cooldown", "cooldown");
  assertEq(out[0].statusText, "Done (1h 0s to Repeat)", "retail status text (DeltaTimeToString drops zero units)");
});

check("stage 3 whose repeat time elapsed since receipt → complete (ready again)", () => {
  const snap = { trackers: [{ contractId: 5, stage: 3, timeWhenRepeats: 3600 }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW, { receivedAtSec: () => NOW - 7200 });
  assertEq(out[0].status, "complete", "past-repeat");
});

check("repeat time arriving as an i64 bit pattern of a double still decodes", () => {
  // protocol crate reads ACE's double as i64: 3600.0 → 0x40AC200000000000.
  const bits = Number(BigInt.asIntN(64, 0x40AC200000000000n));
  const snap = { trackers: [{ contractId: 6, stage: 3, timeWhenRepeats: bits }] };
  const out = projectContractsToJournalEntries(snap, () => null, NOW);
  assertEq(out[0].status, "cooldown", "decoded cooldown");
  assertEq(out[0].statusText, "Done (1h 0s to Repeat)", "decoded text");
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

check("stage 2 shows retail 'In Progress' (no %d template filled)", () => {
  const snap = { trackers: [{ contractId: 8, stage: 2 }] };
  const lookup = () => ({ name: "Kill Quest", description: "Slay the drudges.", descriptionProgress: "%d/5 drudges" });
  const out = projectContractsToJournalEntries(snap, lookup, NOW);
  assertEq(out[0].progressText, "", "no progress at stage 2");
  assertEq(out[0].statusText, "In Progress", "status");
  assertEq(out[0].body, "Slay the drudges.", "body");
});

check("progress-counter stage fills %d with stage − 4 and folds into body", () => {
  const snap = { trackers: [{ contractId: 8, stage: 7 }] };
  const lookup = () => ({ name: "Kill Quest", description: "Slay the drudges.", descriptionProgress: "%d/5 drudges" });
  const out = projectContractsToJournalEntries(snap, lookup, NOW);
  assertEq(out[0].progressText, "3/5 drudges", "progress");
  assertEq(out[0].statusText, "3/5 drudges", "status");
  assertEq(out[0].status, "active", "still active");
  assertEq(out[0].body, "Slay the drudges.  •  3/5 drudges", "body-with-progress");
});

check("progress not duplicated when already in description", () => {
  const snap = { trackers: [{ contractId: 9, stage: 4 }] };
  const lookup = () => ({ name: "Q", description: "Found 0 gems", descriptionProgress: "Found %d gems" });
  const out = projectContractsToJournalEntries(snap, lookup, NOW);
  assertEq(out[0].body, "Found 0 gems", "no-dupe");
});

// ── retail gmJournalUI notebook helpers ──────────────────────────────────

check("timerDurationMs = (d·24 + h)·60 + m minutes", () => {
  assertEq(timerDurationMs(1, 2, 3), ((24 + 2) * 60 + 3) * 60000, "1d2h3m");
  assertEq(timerDurationMs("", "", ""), 0, "blank");
  assertEq(timerDurationMs("-4", "x", "5"), 5 * 60000, "garbage clamps");
});

check("journalTimerText: None / Ready / DeltaTimeToString", () => {
  assertEq(journalTimerText(0, 1000), "None", "not running");
  assertEq(journalTimerText(5000, 6000), "Ready", "elapsed");
  assertEq(journalTimerText(1000 + 3725 * 1000, 1000), "1h 2m 5s", "running");
});

check("normalizeJournalPages always yields ≥1 well-formed page", () => {
  const empty = normalizeJournalPages(null);
  assertEq(empty.length, 1, "one page");
  assert(isBlankJournalPage(empty[0]), "blank page");
  const pages = normalizeJournalPages([
    { label: "Aerbax", title: "Keys", notes: "Get 3 keys", loc: { ns: 42.1, ew: 33.6 }, timer: { d: "0", h: "20", m: "0", endsAt: 99 } },
    { bogus: true },
    7,
  ]);
  assertEq(pages.length, 2, "two pages (bogus object kept as blank, number dropped)");
  assertEq(pages[0].loc, { ns: 42.1, ew: 33.6 }, "location kept");
  assertEq(pages[0].timer.endsAt, 99, "timer kept");
  assert(!isBlankJournalPage(pages[0]), "content page not blank");
  assert(isBlankJournalPage(pages[1]), "bogus page blank");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
