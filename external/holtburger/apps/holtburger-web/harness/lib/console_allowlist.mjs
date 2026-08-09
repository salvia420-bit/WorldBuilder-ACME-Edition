// harness/lib/console_allowlist.mjs — the console-error allowlist behind the
// promotion bar's "0 console errors" (SPEC §1.7 / pass-10 D-10.7; T01
// deliverable).
//
// MECHANICAL FORM of the gate: a bench collects `page.on("pageerror")` plus
// console messages of type `error` (moving-bench already does both,
// moving-bench.mjs:192-193) from navigation start to scenario end; the run
// PASSES the console gate iff ZERO messages remain after subtracting this
// allowlist. Unlisted errors FAIL — the allowlist is the only escape, and it
// is deliberately hard to grow:
//
//   EVIDENCE RULE (pass-10 D-10.7): every entry carries an evidence citation
//   (file:line of the emitting code, or the doc that proves benignity) and an
//   `added` date. An entry without evidence fails the Tier-1 lint
//   (harness/test_console_allowlist.mjs). "It looks harmless" is not
//   evidence.
//
// Warnings are recorded in the RESULTS file and triaged, never gating —
// EXCEPT that an allowlisted pattern may match whichever channel its evidence
// says the message rides (the QuickEmote line is emitted via console.warn;
// some drivers fold warn+error together, so the entry documents its channel).
//
// Scope note: matching is on the MESSAGE TEXT the page produced. Keep
// patterns tight — an allowlist entry that matches broadly launders real
// defects (that is why patterns pin the 0x13 prefix below rather than any
// missing link).

export const ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "quickemote-no-motiontable-link",
    // "[motion-link] no MotionTable link for attack 0x13xxxxxx (from 0x…, …)"
    pattern: "\\[motion-link\\] no MotionTable link for attack 0x13[0-9a-f]{6}\\b",
    flags: "i",
    channel: "warn",
    evidence:
      "scene3d/entities.js:12221-12227 emits the line when an Action-class "
      + "one-shot has no MotionTable link clip; 0x13xxxxxx commands are the "
      + "QuickEmote class, which legitimately carries no link — benign by "
      + "design (MEMORY.md §2, pass-10 D-10.7 seed entry). Non-0x13 attack/"
      + "cast hits of the same line are REAL missing links and stay failing.",
    added: "2026-08-08",
  }),
]);

/** Compile an entry's pattern (entries store source+flags so the list is
 *  plain JSON-serializable data). */
export function compile(entry) {
  return new RegExp(entry.pattern, entry.flags || "");
}

/**
 * Return the matching allowlist entry for a console/page-error message, or
 * null when the message is NOT allowlisted (i.e. it gates).
 * @param {string} message
 */
export function isAllowed(message) {
  const text = String(message ?? "");
  for (const entry of ALLOWLIST) {
    if (compile(entry).test(text)) return entry;
  }
  return null;
}

/**
 * Partition collected error messages into gating failures and allowlisted
 * hits. PASS of the console gate === `failing.length === 0`.
 * @param {string[]} messages
 * @returns {{ failing: string[], allowed: {message: string, id: string}[] }}
 */
export function filterErrors(messages) {
  const failing = [];
  const allowed = [];
  for (const m of messages ?? []) {
    const hit = isAllowed(m);
    if (hit) allowed.push({ message: String(m), id: hit.id });
    else failing.push(String(m));
  }
  return { failing, allowed };
}

// Evidence must name WHERE the benign behavior lives: a file:line span or a
// doc path. Prose alone ("seems fine") does not satisfy the rule.
const EVIDENCE_RE = /\S+\.(?:js|mjs|cjs|rs|html|md):\d+|docs\//;

/**
 * Validate an allowlist (defaults to THE allowlist). Returns
 * { ok, errors: string[] }. Enforced per entry: id, compilable pattern,
 * evidence with a file:line/doc citation, ISO `added` date.
 */
export function validateAllowlist(list = ALLOWLIST) {
  const errors = [];
  const seen = new Set();
  for (const e of list) {
    const at = e && e.id ? e.id : "<missing id>";
    if (!e || typeof e.id !== "string" || e.id.length === 0) errors.push(`${at}: id is required`);
    else if (seen.has(e.id)) errors.push(`${at}: duplicate id`);
    else seen.add(e.id);
    if (typeof e.pattern !== "string" || e.pattern.length === 0) {
      errors.push(`${at}: pattern (regex source string) is required`);
    } else {
      try { new RegExp(e.pattern, e.flags || ""); }
      catch (err) { errors.push(`${at}: pattern does not compile: ${err.message}`); }
    }
    if (typeof e.evidence !== "string" || !EVIDENCE_RE.test(e.evidence)) {
      errors.push(`${at}: evidence citation required (file:line or docs/ path) — an allowlist entry without evidence fails the Tier-1 lint (pass-10 D-10.7)`);
    }
    if (typeof e.added !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.added)) {
      errors.push(`${at}: added must be a YYYY-MM-DD date`);
    }
  }
  return { ok: errors.length === 0, errors };
}
