// WS16 — scene3d/diag/cast.js unit tests (headless, no browser).
//
// Run with:
//   cd apps/holtburger-web/
//   node tests/test_cast_diag.mjs
//
// Drives the __diag.cast surface hooks with synthetic cast data and asserts
// the chain state, per-cast timeline, link-resolution counters, echo-dedup
// counters, and the assertLastCast probe helper. Exits non-zero on failure.
// Mirrors test_ac_spell_cast_sequence.mjs's plain-node check() harness.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = "file://" + resolvePath(__dirname, "..", "scene3d/diag/cast.js");
const { attachCast } = await import(modUrl);

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

console.log("===========================================================");
console.log("WS16 — __diag.cast surface unit tests");
console.log("===========================================================");

const diag = {};
attachCast(diag);
const cast = diag.cast;

check("attachCast installs diag.cast", cast && typeof cast === "object");
check("hooks are callable", typeof cast.onCastRequested === "function" && typeof cast.onGesture === "function");

const G = 0x50000123;   // synthetic local player guid

// ── Scenario 1: a 1-windup void cast (spell 2331, colored powerup) that
//    resolves its links and completes normally. ──
cast.onCastRequested({ guid: G, spellId: 2331, school: 2, shape: "Self", level: 7, fastCast: false });
check("requested opens a live chain", cast.state(G)?.phase === "requested");
cast.onChainStart({ guid: G, spellId: 2331, token: 5, busyUntilMs: 1000, windupCount: 1, hasCast: true, fastCast: false });
check("chainStart records token", cast.state(G)?.token === 5);
check("chainStart computes gestureCount=2", cast.state(G)?.gestureCount === 2);
// windup gesture 0x10000132 (MagicPowerUp08Purple) resolves (hit)
cast.onLinkResolve({ guid: G, cmd: 0x10000132, stance: 0x8000_0049, mtableId: 0x09000001, outcome: "hit" });
cast.onGesture({ guid: G, index: 0, motion: 0x10000132, name: "MagicPowerUp08Purple", isCast: false });
check("gesture advances index", cast.state(G)?.gestureIndex === 0);
// cast gesture 0x40000035 (MagicTransfer) resolves (hit)
cast.onLinkResolve({ guid: G, cmd: 0x40000035, stance: 0x8000_0049, mtableId: 0x09000001, outcome: "hit" });
cast.onGesture({ guid: G, index: 1, motion: 0x40000035, name: "MagicTransfer", isCast: true });
check("cast phase set", cast.state(G)?.phase === "cast");
cast.onCasterEffect({ guid: G, scriptId: 74, scale: 1.0 });
cast.onChainComplete({ guid: G });
check("complete clears live chain", cast.state(G) === null);

{
  const tl = cast.lastTimeline(G);
  check("timeline: outcome complete", tl?.outcome === "complete", tl?.outcome);
  check("timeline: 1 windup stamp", tl?.deltasMs?.windups?.length === 1, `${tl?.deltasMs?.windups?.length}`);
  check("timeline: cast delta present", tl?.deltasMs?.cast != null);
  check("timeline: casterEffect delta present", tl?.deltasMs?.casterEffect != null);
  check("timeline: windup cmd humanized to hex", tl?.deltasMs?.windups?.[0]?.cmd === "0x10000132");
}

// ── Scenario 2: link MISS on the colored windup (the S1(a) void repro). ──
const G2 = 0x50000222;
cast.onCastRequested({ guid: G2, spellId: 2331, school: 2, shape: "Self", level: 7 });
cast.onChainStart({ guid: G2, spellId: 2331, token: 1, busyUntilMs: 1000, windupCount: 1, hasCast: true });
cast.onLinkResolve({ guid: G2, cmd: 0x10000132, stance: 0, mtableId: 0x09000001, outcome: "miss", reason: "stance-falsy" });
cast.onGesture({ guid: G2, index: 0, motion: 0x10000132, name: "MagicPowerUp08Purple", isCast: false });
cast.onLinkResolve({ guid: G2, cmd: 0x40000035, stance: 0, mtableId: 0x09000001, outcome: "miss", reason: "stance-falsy" });
cast.onGesture({ guid: G2, index: 1, motion: 0x40000035, name: "MagicTransfer", isCast: true });
cast.onChainComplete({ guid: G2 });
{
  const ls = cast.linkStats({ castOnly: true });
  const cell = ls["0x00000000"]?.["0x10000132"];
  check("linkStats records the miss under stance 0", cell?.miss === 1, JSON.stringify(cell));
  check("linkStats captures miss reason", cell?.reasons?.["stance-falsy"] === 1);
  const s = cast.summary();
  check("summary rolls up cast link miss", s.castLink.miss === 2 && s.castLink.hit === 2, JSON.stringify(s.castLink));
}

// ── Scenario 3: busy-window suppression (S1(e)). ──
const G3 = 0x50000333;
cast.onCastRequested({ guid: G3, spellId: 7 });
cast.onCastSuppressed({ guid: G3, spellId: 7, reason: "busyWindow" });
check("suppression counted", cast.summary().suppress.busyWindow === 1);
check("suppressed cast committed to timeline", cast.lastTimeline(G3)?.outcome === "suppressed");
check("suppressed chain cleared", cast.state(G3) === null);

// ── Scenario 4: fizzle mid-cast cancels the chain (S2(b)). ──
const G4 = 0x50000444;
cast.onCastRequested({ guid: G4, spellId: 9 });
cast.onChainStart({ guid: G4, spellId: 9, token: 2, windupCount: 0, hasCast: true });
cast.onFizzle({ guid: G4 });
cast.onChainCancel({ guid: G4, cause: "fizzle" });
{
  const tl = cast.lastTimeline(G4);
  check("fizzle recorded on timeline", tl?.deltasMs?.fizzle != null);
  check("cancel cause captured", tl?.cancelCause === "fizzle", tl?.cancelCause);
  check("fizzle + cancel counters", cast.summary().fizzles === 1 && cast.summary().chainsCancelled === 1);
}

// ── Scenario 5: echo-dedup counters. ──
cast.onEchoNote(0x10000132);
cast.onEchoConsume({ cmd: 0x10000132, hit: true });
cast.onEchoConsume({ cmd: 0x40000035, hit: false });
{
  const e = cast.echoStats();
  check("echo noted/consumed counters", e.noted === 1 && e.consumedHit === 1 && e.consumedMiss === 1, JSON.stringify(e));
}

// ── Scenario 6: assertLastCast probe helper (PASS + DRIFT). ──
{
  const good = cast.assertLastCast(G, { forbidSuppressed: true, minWindups: 1, expectCast: true, expectCasterEffect: true, expectOutcome: "complete" });
  check("assertLastCast PASS on the good complete cast", good.pass === true, JSON.stringify(good.checks.filter((c) => !c.pass)));
  const bad = cast.assertLastCast(G3, { forbidSuppressed: true, expectCast: true });
  check("assertLastCast DRIFT on the suppressed cast", bad.pass === false);
}

// ── Scenario 7: movementSnapshot degrades gracefully with no wasm. ──
{
  const snap = cast.movementSnapshot();
  check("movementSnapshot returns an object with null wasm", snap && snap.latchAutonomous === null && snap.pendingMotions === null);
}

// ── Scenario 8: reset() zeroes counters, keeps the surface. ──
cast.reset();
{
  const s = cast.summary();
  check("reset zeroes counters", s.requested === 0 && s.chainsCompleted === 0 && s.castLink.miss === 0);
  check("reset clears timeline", cast.timelineTail(10).length === 0);
}

// ── Summary ──
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("All WS16 __diag.cast tests PASS.");
