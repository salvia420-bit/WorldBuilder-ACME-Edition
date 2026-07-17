#!/usr/bin/env node
// rynth_loot_gate_test.cjs — unit test for the LOOT-state appraisal gate
// (LootScoring finding #1, fixed 2026-07-17): with minValue > 0, an item
// whose Value(19) hasn't streamed is HELD (one RequestId + a bounded wait),
// not shifted out and skipped forever; on timeout it falls through and is
// judged unappraised. minValue = 0 keeps the no-gate fast path.
//
// Run: node rynth_loot_gate_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Minimal host: only what the LOOT/CONFIRM states touch.
function makeHost() {
  const calls = [];
  const values = new Map(); // guid -> Value(19) or undefined (not streamed)
  const appraised = new Set();
  const inventory = new Set();
  return {
    calls, values, appraised, inventory,
    IsPlayerReady: () => true,
    GetBusyState: () => 0,
    GetPlayerId: () => 0x50000001,
    TryGetObjectIntProperty: (g, p) => (p === 19 ? values.get(g) ?? null : null),
    HasAppraisalData: (g) => appraised.has(g),
    RequestId: (g) => { calls.push(["requestId", g]); return true; },
    s: {
      moveItem: (g, to, slot) => calls.push(["moveItem", g, to, slot]),
      playerInventory: () => [...inventory].map((guid) => ({ guid })),
    },
  };
}

(async () => {
  const { RynthLootLoop } = await import(pathToFileURL(path.join(__dirname, "rynth/loot_loop.js")).href);

  // Drive the loop directly in the LOOT state with a synthetic work list.
  function inLootState(loop, items) {
    loop.corpse = 0xc0ffee;
    loop.items = [...items];
    loop._setState("LOOT");
  }

  // --- held, then appraises in time -> value rule applies ----------------
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { minValue: 100, log: () => {} });
    inLootState(loop, [0xa1, 0xa2]);
    h.values.set(0xa2, 500); // a2 already streamed; a1 not yet
    loop.tick();
    check("unappraised head is held, not shifted", loop.items[0] === 0xa1 && loop.items.length === 2);
    check("one RequestId issued", h.calls.filter((c) => c[0] === "requestId" && c[1] === 0xa1).length === 1);
    loop.tick();
    check("no duplicate RequestId while waiting", h.calls.filter((c) => c[0] === "requestId").length === 1);
    // appraisal lands: value above floor -> picked up
    h.values.set(0xa1, 250);
    h.appraised.add(0xa1);
    loop.tick();
    check("appraised item picked up", h.calls.some((c) => c[0] === "moveItem" && c[1] === 0xa1) && loop.state === "CONFIRM");
    // confirm, then the next item (already appraised) is judged immediately
    h.inventory.add(0xa1);
    loop.tick(); // CONFIRM -> LOOT
    loop.tick(); // LOOT: a2 (500 >= 100) -> pickup
    check("next appraised item flows", h.calls.some((c) => c[0] === "moveItem" && c[1] === 0xa2));
  }

  // --- held, appraisal lands with LOW value -> correctly skipped ----------
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { minValue: 100, log: () => {} });
    inLootState(loop, [0xb1]);
    loop.tick(); // hold + RequestId
    h.values.set(0xb1, 5);
    h.appraised.add(0xb1);
    loop.tick();
    check("low-value item skipped after appraisal", !h.calls.some((c) => c[0] === "moveItem") && loop.state === "SCAN");
  }

  // --- never appraises -> timeout falls through (old behavior) ------------
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { minValue: 100, log: () => {} });
    inLootState(loop, [0xc1]);
    loop.tick(); // hold
    // Simulate the timeout by backdating the hold stamp past the window.
    loop._assessAt.set(0xc1, Date.now() - 10_000);
    loop.tick();
    check("timeout: item judged unappraised and skipped", !h.calls.some((c) => c[0] === "moveItem") && loop.state === "SCAN");
    check("timeout: holds cleared with corpse", loop._assessAt.size === 0);
  }

  // --- minValue=0 fast path: no gate, no RequestId ------------------------
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: () => {} }); // default minValue 0
    inLootState(loop, [0xd1]);
    loop.tick();
    check("minValue=0 loots without appraisal", h.calls.some((c) => c[0] === "moveItem" && c[1] === 0xd1));
    check("minValue=0 issues no RequestId", !h.calls.some((c) => c[0] === "requestId"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
