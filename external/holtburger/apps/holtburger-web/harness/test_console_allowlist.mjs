// harness/test_console_allowlist.mjs — Tier-1 lint + behavior test for the
// console-error allowlist (harness/lib/console_allowlist.mjs; pass-10 D-10.7;
// T01 deliverable).
//
// Pure Node. Run: node harness/test_console_allowlist.mjs — exit 0/1.

import {
  ALLOWLIST, isAllowed, filterErrors, validateAllowlist, compile,
} from "./lib/console_allowlist.mjs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};

// ── the shipped allowlist lints green ──────────────────────────────────────
{
  const { ok: clean, errors } = validateAllowlist();
  for (const e of errors) console.error(`  allowlist error: ${e}`);
  ok(clean, `shipped allowlist validates (${errors.length} errors)`);
  ok(ALLOWLIST.length >= 1, "seed entry present");
  ok(ALLOWLIST.some((e) => e.id === "quickemote-no-motiontable-link"), "QuickEmote seed entry present");
  for (const e of ALLOWLIST) ok(compile(e) instanceof RegExp, `${e.id}: pattern compiles`);
}

// ── the QuickEmote class matches; near-misses do NOT ───────────────────────
{
  // Real message shape (scene3d/entities.js:12221-12227).
  const quickEmote =
    "[motion-link] no MotionTable link for attack 0x13000042 (from 0x44000007, "
    + "stance 0x3d, mtable 0x0900019b) on entity 0x50001234 — swing/cast/eat will not play";
  ok(isAllowed(quickEmote)?.id === "quickemote-no-motiontable-link", "QuickEmote 0x13xxxxxx message is allowlisted");

  // A non-QuickEmote attack with a genuinely missing link must still gate.
  const realMiss = quickEmote.replace("0x13000042", "0x01000012");
  ok(isAllowed(realMiss) === null, "non-0x13 missing-link message still fails (a REAL missing link)");
  // A cast miss is not the QuickEmote class either.
  const castMiss = quickEmote.replace("attack 0x13000042", "cast 0x13000042");
  ok(isAllowed(castMiss) === null, "cast-class message is not laundered by the attack entry");
  // Arbitrary errors are never allowlisted.
  ok(isAllowed("TypeError: Cannot read properties of undefined (reading 'foo')") === null, "unlisted error is not allowed");
  ok(isAllowed("") === null && isAllowed(null) === null, "empty/null messages are not allowed");
}

// ── filterErrors: PASS iff zero after subtraction; unlisted errors fail ────
{
  const messages = [
    "[motion-link] no MotionTable link for attack 0x13ab00ff (from 0x0, stance 0x3d, mtable 0x09000001) on entity 0x1 — swing/cast/eat will not play",
    "TypeError: x is not a function",
    "[motion-link] no MotionTable link for attack 0x05000001 (from 0x0, stance 0x3d, mtable 0x09000001) on entity 0x2 — swing/cast/eat will not play",
  ];
  const { failing, allowed } = filterErrors(messages);
  ok(allowed.length === 1 && allowed[0].id === "quickemote-no-motiontable-link", "one allowlisted hit recorded with its entry id");
  ok(failing.length === 2, `unlisted errors gate (${failing.length}/2 failing)`);
  ok(filterErrors([]).failing.length === 0, "empty collection passes the gate");
}

// ── the evidence rule can say NO ───────────────────────────────────────────
{
  const good = {
    id: "x", pattern: "boom", evidence: "scene3d/foo.js:12 proves it", added: "2026-08-08",
  };
  ok(validateAllowlist([good]).ok, "well-formed entry validates");
  ok(!validateAllowlist([{ ...good, evidence: "it looks harmless" }]).ok, "prose-only evidence fails the lint");
  ok(!validateAllowlist([{ ...good, evidence: undefined }]).ok, "missing evidence fails the lint");
  ok(!validateAllowlist([{ ...good, added: "yesterday" }]).ok, "non-ISO added date fails");
  ok(!validateAllowlist([{ ...good, pattern: "(" }]).ok, "non-compiling pattern fails");
  ok(!validateAllowlist([{ ...good, id: "" }]).ok, "missing id fails");
  ok(!validateAllowlist([good, { ...good }]).ok, "duplicate id fails");
  ok(validateAllowlist([{ ...good, evidence: "docs/2026-08-06-p99-stall-attribution.md — triaged benign" }]).ok,
    "docs/ citation satisfies the evidence rule");
}

console.log(`console-allowlist: ${passed} passed, ${failed} failed (${ALLOWLIST.length} entries)`);
if (failed === 0) {
  console.log("CONSOLE-ALLOWLIST ✅");
  process.exit(0);
} else {
  console.error("CONSOLE-ALLOWLIST ❌");
  process.exit(1);
}
