#!/usr/bin/env node
// rynth_confirmreflex_test.cjs — unit tests for rynth/ai/confirm_reflex.js
// (WP-14 A1-4): the dark, flag-off server-confirmation reflex. No infra,
// mocked host.
//
// Covers the WP acceptance shape: an allow-listed dialog is ANSWERED (accept);
// an unknown/non-allow-listed dialog is DECLINED (never blindly accepted); and
// the survival invariants (flag-off no-op that never polls, empty allow-list =
// decline-everything, declineUnknown=false leaves unknowns, never-throws).

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Mock host with a settable pending-confirmation queue.
function makeHost(pending) {
  const calls = [];
  return {
    calls,
    TryGetPendingConfirmations: () => (pending || []),
    SendConfirmationResponse: (t, c, accepted) => { calls.push({ t: t | 0, c: c | 0, accepted: !!accepted }); return true; },
  };
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "confirm_reflex.js")).href);
  const { ConfirmReflex, ConfirmationType, DEFAULT_AUTO_YES } = mod;

  check("enum: CraftInteraction=5, SwearAllegiance=1", ConfirmationType.CraftInteraction === 5 && ConfirmationType.SwearAllegiance === 1);
  check("default allow-list is exactly [CraftInteraction]", DEFAULT_AUTO_YES.length === 1 && DEFAULT_AUTO_YES[0] === ConfirmationType.CraftInteraction);

  // (a) allow-listed dialog (CraftInteraction) with defaults -> ACCEPT.
  {
    const host = makeHost([{ confirmType: ConfirmationType.CraftInteraction, context: 42, text: "Chance of success 80%. Proceed?" }]);
    const r = new ConfirmReflex(host, { enabled: true }).step();
    check("allow-listed craft: acted", r.acted === true, JSON.stringify(r));
    check("allow-listed craft: SendConfirmationResponse ACCEPT with verbatim type/context",
      host.calls.length === 1 && host.calls[0].t === 5 && host.calls[0].c === 42 && host.calls[0].accepted === true,
      JSON.stringify(host.calls));
  }

  // (b) unknown / non-allow-listed dialogs -> DECLINE (never accepted).
  for (const ct of [ConfirmationType.SwearAllegiance, ConfirmationType.AlterAttribute, ConfirmationType.Augmentation, ConfirmationType.Fellowship, ConfirmationType.YesNo]) {
    const host = makeHost([{ confirmType: ct, context: 7, text: "something" }]);
    const r = new ConfirmReflex(host, { enabled: true }).step();
    check(`type ${ct}: DECLINED (not accepted)`, r.acted === true && host.calls.length === 1 && host.calls[0].t === ct && host.calls[0].accepted === false, JSON.stringify(host.calls));
  }

  // (c) mixed queue: allow-listed accepted, others declined, all answered.
  {
    const host = makeHost([
      { confirmType: ConfirmationType.SwearAllegiance, context: 1, text: "Swear allegiance to Aria?" },
      { confirmType: ConfirmationType.CraftInteraction, context: 2, text: "Proceed craft?" },
    ]);
    const r = new ConfirmReflex(host, { enabled: true }).step();
    check("mixed: both dialogs answered", r.acted === true && host.calls.length === 2, JSON.stringify(host.calls));
    const allegiance = host.calls.find((c) => c.t === ConfirmationType.SwearAllegiance);
    const craft = host.calls.find((c) => c.t === ConfirmationType.CraftInteraction);
    check("mixed: allegiance DECLINED", allegiance && allegiance.accepted === false);
    check("mixed: craft ACCEPTED", craft && craft.accepted === true);
  }

  // (d) flag-off -> no-op AND never polls the host.
  {
    let touched = false;
    const throwingHost = new Proxy({}, { get() { touched = true; throw new Error("touched"); } });
    const r = new ConfirmReflex(throwingHost, { enabled: false }).step();
    check("flag-off: no-op (disabled)", r.acted === false && r.reason === "disabled", JSON.stringify(r));
    check("flag-off: host never polled", touched === false);
  }

  // (e) no pending -> no-op.
  {
    const host = makeHost([]);
    const r = new ConfirmReflex(host, { enabled: true }).step();
    check("empty queue: no-op (none-pending)", r.acted === false && r.reason === "none-pending", JSON.stringify(r));
  }

  // (f) empty allow-list -> decline EVERYTHING (max caution), including craft.
  {
    const host = makeHost([{ confirmType: ConfirmationType.CraftInteraction, context: 9, text: "craft?" }]);
    const r = new ConfirmReflex(host, { enabled: true, autoYes: [] }).step();
    check("empty allow-list: craft is DECLINED", r.acted === true && host.calls[0].accepted === false, JSON.stringify(host.calls));
  }

  // (g) declineUnknown=false -> leave non-allow-listed dialogs untouched.
  {
    const host = makeHost([{ confirmType: ConfirmationType.SwearAllegiance, context: 3, text: "oath?" }]);
    const r = new ConfirmReflex(host, { enabled: true, declineUnknown: false }).step();
    check("declineUnknown=false: unknown left for server auto-timeout", r.acted === false && r.reason === "no-actionable" && host.calls.length === 0, JSON.stringify(r));
  }

  // (h) custom allow-list is honored.
  {
    const host = makeHost([{ confirmType: ConfirmationType.Fellowship, context: 4, text: "join?" }]);
    const r = new ConfirmReflex(host, { enabled: true, autoYes: [ConfirmationType.Fellowship] }).step();
    check("custom allow-list: fellowship ACCEPTED when opted in", r.acted === true && host.calls[0].accepted === true, JSON.stringify(host.calls));
  }

  // (i) never throws: a host that throws while polling degrades safely.
  {
    let threw = false;
    try {
      const host = { TryGetPendingConfirmations: () => { throw new Error("boom"); }, SendConfirmationResponse: () => true };
      const r = new ConfirmReflex(host, { enabled: true }).step();
      check("throwing host: degrades to no-op, no throw", r.acted === false, JSON.stringify(r));
    } catch { threw = true; }
    check("throwing host: step() never throws", threw === false);
  }

  // (j) unavailable host surface -> no-op (unavailable).
  {
    const r = new ConfirmReflex({}, { enabled: true }).step();
    check("missing host methods: no-op (unavailable)", r.acted === false && r.reason === "unavailable", JSON.stringify(r));
  }

  // (k) send failure leaves the dialog pending, no throw.
  {
    const host = { TryGetPendingConfirmations: () => [{ confirmType: ConfirmationType.CraftInteraction, context: 1 }], SendConfirmationResponse: () => false };
    const r = new ConfirmReflex(host, { enabled: true }).step();
    check("send fails: reported as no-actionable, no throw", r.acted === false && r.reason === "no-actionable", JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
