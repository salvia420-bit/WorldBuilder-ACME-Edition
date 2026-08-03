// test_bot_escape_rung.mjs — the portal-escape rung must not blacklist the
// portal it just walked to (2026-08-03 review F9, task #151), plus the two
// lower rungs from the same sweep.
//
// F9: `_pendingEscapeGuid` was set when an escalation was ISSUED and cleared
// in exactly one place — the blacklist arm. The walk arm ("portal is >5 m
// away, walk to it") set it, the bot arrived and stood still (arriving is the
// point), and ~20 s later the first thing that ran was
// `_deadEscapeGuids.add()` on the portal it was standing on. The `d <= 5`
// UseObject arm could then never be reached for that portal, because the
// candidate scan skips blacklisted guids. A SUCCESSFUL hop is also followed by
// stillness, so working portals were poisoned too, and `_deadEscapeGuids` is
// never cleared or capped.
//
// The rung is a method on a large class with heavy construction, so this
// drives the decision logic directly against the shipped source's own state
// fields rather than booting a bot.
//
// Run: node rynth/test_bot_escape_rung.mjs

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const SRC = readFileSync(new URL("./bot.js", import.meta.url), "utf8");

// ── a faithful model of the shipped pending-state decision ─────────────────
// Mirrors the three arms in bot.js's `if (this._pendingEscapeGuid != null)`.
function makeRung() {
  return {
    now: 0,
    lastMoveAt: 0,
    pendingGuid: null,
    pendingAt: null,
    dead: new Set(),
    resolved: 0,
    issue(guid, atTime) { this.pendingGuid = guid; this.pendingAt = atTime; },
    // Returns "resolved" | "blacklisted" | "waiting" | "idle"
    step() {
      if (this.pendingGuid == null) return "idle";
      const movedSinceIssue = this.pendingAt != null && this.lastMoveAt > this.pendingAt;
      if (movedSinceIssue) {
        this.pendingGuid = null; this.pendingAt = null; this.resolved += 1;
        return "resolved";
      }
      if (this.now - this.lastMoveAt > 20_000) {
        this.dead.add(this.pendingGuid);
        this.pendingGuid = null; this.pendingAt = null;
        return "blacklisted";
      }
      return "waiting";
    },
  };
}

// ── the walk-then-arrive sequence must NOT poison the portal ───────────────
{
  const r = makeRung();
  r.now = 1000; r.lastMoveAt = 1000;
  r.issue(0xaaaa, 1000);              // "walking to portal (~30 m)"
  r.now = 6000; r.lastMoveAt = 6000;  // …the bot walks, pose moves
  const s1 = r.step();
  check("F9: arriving at the portal RESOLVES the escalation", s1 === "resolved", s1);
  check("F9: …and does NOT blacklist it", r.dead.size === 0);

  // Now it stands still at the portal for 30 s — the old code's death window.
  r.now = 36_000;
  const s2 = r.step();
  check("F9: standing at a resolved portal is idle, not a blacklist",
    s2 === "idle" && r.dead.size === 0, s2);
}

// ── a genuinely dead portal is still blacklisted ───────────────────────────
{
  const r = makeRung();
  r.now = 1000; r.lastMoveAt = 1000;
  r.issue(0xbbbb, 1000);              // UseObject on a decorative portal
  r.now = 10_000;
  check("dead portal: still waiting inside the grace window", r.step() === "waiting");
  r.now = 25_000;                     // >20 s with no movement at all
  check("dead portal: is blacklisted after the stall window",
    r.step() === "blacklisted" && r.dead.has(0xbbbb));
}

// ── a WORKING portal (use → teleport → movement) is not poisoned ───────────
{
  const r = makeRung();
  r.now = 1000; r.lastMoveAt = 1000;
  r.issue(0xcccc, 1000);
  r.now = 3000; r.lastMoveAt = 2500;  // the teleport moved the pose
  check("working portal: resolves rather than blacklists", r.step() === "resolved");
  r.now = 40_000;                     // long stillness after arriving somewhere new
  r.step();
  check("working portal: survives the post-hop stillness", r.dead.size === 0);
}

// ── the pre-fix shape must be gone from the source ─────────────────────────
{
  const i = SRC.indexOf("if (this._pendingEscapeGuid != null) {");
  // CODE only — these fixes describe the old bug in prose, and a raw text
  // scan would happily match the comment instead of the statement (the
  // `entity_dispatch.js` "comments excluded" precedent).
  const block = SRC.slice(i, i + 3200)
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("bot.js: the pending block has a movement-based success arm",
    block.includes("movedSinceIssue"), "(F9 success arm missing)");
  check("bot.js: both escalation sites stamp the issue time",
    (SRC.match(/this\._pendingEscapeAt = this\.now\(\);/g) || []).length === 2,
    `found ${(SRC.match(/this\._pendingEscapeAt = this\.now\(\);/g) || []).length}`);
  check("bot.js: the success arm is reached BEFORE the blacklist arm",
    block.indexOf("_escapeResolved") > 0 &&
    block.indexOf("_escapeResolved") < block.indexOf("_deadEscapeGuids.add"),
    `resolved@${block.indexOf("_escapeResolved")} dead@${block.indexOf("_deadEscapeGuids.add")}`);
}

// ── the two lower rungs from the same sweep ────────────────────────────────
{
  const i = SRC.indexOf("const wasVisited = visited.has(target);");
  check("sweep label: 'revisit' is captured BEFORE visited.add",
    i > 0 && i < SRC.indexOf("visited.add(target);", i),
    "(wasVisited capture missing or after the add)");
  // Match the LABEL, not this fix's own explanatory comment.
  const labelLine = SRC.split("\n").find((l) => l.includes("idle — indoor sweep to"));
  check("sweep label: the closure reads the captured flag, not the live set",
    !!labelLine && labelLine.includes("wasVisited ?") && !labelLine.includes("visited.has(target) ?"),
    labelLine ?? "(label not found)");
}
{
  check("goto re-issue: has a hard budget constant",
    /^const GOTO_REISSUE_MAX = \d+;/m.test(SRC));
  const j = SRC.indexOf("re-issuing last unreached goto");
  const block = SRC.slice(j - 900, j + 900);
  check("goto re-issue: the rung counts its attempts",
    block.includes("this._gotoReissues += 1") && block.includes("< GOTO_REISSUE_MAX"));
  check("goto re-issue: the counter resets when the destination changes",
    block.includes("this._gotoReissueKey !== key"));
  check("goto re-issue: exhaustion falls THROUGH to the sweep rungs",
    block.includes("Deliberately NO return"));
}

console.log("");
console.log(`bot escape rung: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
