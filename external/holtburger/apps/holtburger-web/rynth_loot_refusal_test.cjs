#!/usr/bin/env node
// rynth_loot_refusal_test.cjs — the 2026-10-12 loot_loop.js update (client
// drift since 2026-07-24), driven through a fake host that records every
// action and lets the test push ClientEvents the way RynthWebHost does:
//
//   R1-R4  pickup refusals off the push plane: kind=48 InventoryActionFailed
//          (+ a YoureTooBusy kind=13 just before it = retry after a pause, as
//          the client's own Loot All does; anything else = skip at once — no
//          more waiting out the 6 s timeout); retries capped; a 48 for another
//          guid is ignored.
//   O1-O3  OPEN gives up (parks the corpse) instead of re-Using forever, and a
//          "too busy" refusal is retried without spending an attempt.
//   P1     a tick gap (combat held the kernel) re-arms APPROACH instead of
//          timing out on the stale clock.
//   F1-F2  a full pack pauses looting.
//   S1-S3  world-frame corpse distance across an outdoor landblock seam.
//   C1     a finished corpse is closed (NoLongerViewingContents).
//   G1     portal space holds the whole tick.
//
// Run: node rynth_loot_refusal_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const ME = 0x50000001;
const CORPSE = 0xc0ffee;

function makeHost(over = {}) {
  const calls = [];
  const handlers = [];
  const inventory = new Set();
  const h = {
    calls, inventory,
    ground: 0,
    contents: [],
    freeSlots: 50,
    pose: { objCellId: 0xa9b40021, x: 50, y: 50, z: 0 },
    corpsePos: { objCellId: 0xa9b40021, x: 52, y: 50, z: 0 },
    onEvent: (fn) => handlers.push(fn),
    emit: (e) => handlers.forEach((fn) => fn(e)),
    IsPlayerReady: () => true,
    GetBusyState: () => 0,
    GetPlayerId: () => ME,
    TryGetPlayerPose: () => h.pose,
    NearbyGuids: () => [CORPSE],
    TryGetObjectWcid: (g) => (g === CORPSE ? 21 : 0),
    TryGetObjectPosition: (g) => (g === CORPSE ? h.corpsePos : null),
    TryGetObjectIntProperty: () => 100, // every item has Value 100
    HasAppraisalData: () => true,
    MoveToPosition: (...a) => { calls.push(["move", ...a]); return true; },
    StopCompletely: () => { calls.push(["stop"]); return true; },
    UseObject: (g) => { calls.push(["use", g]); return true; },
    GetGroundContainerId: () => h.ground,
    GetContainerContents: () => [...h.contents],
    MoveItemToContainer: (item, to, slot) => { calls.push(["pickup", item, to, slot]); return true; },
    TryGetPlayerInventory: () => [...inventory].map((guid) => ({ guid })),
    TryGetFreeSlots: () => h.freeSlots,
    CloseContainer: (g) => { calls.push(["close", g]); return true; },
    ...over,
  };
  return h;
}

const count = (h, kind, arg) => h.calls.filter((c) => c[0] === kind && (arg === undefined || c[1] === arg)).length;

(async () => {
  const { RynthLootLoop, horizontalDistance } = await import(pathToFileURL(path.join(__dirname, "rynth/loot_loop.js")).href);
  const quiet = () => {};

  // Put the loop mid-corpse in LOOT with a work list.
  function inLoot(h, loop, items) {
    loop.corpse = CORPSE;
    h.ground = CORPSE;
    loop.items = [...items];
    loop._setState("LOOT");
  }

  // ── R1 busy refusal -> retry the SAME item after a pause ──────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    inLoot(h, loop, [0xa1, 0xa2]);
    loop.tick(); // pickup a1 -> CONFIRM
    h.emit({ kind: 13, u32: 0x1d }); // "You're too busy" ...
    h.emit({ kind: 48, u32: 0xa1, u32b: 0x1d }); // ... then the failed move
    loop.tick(); // CONFIRM sees the refusal at once
    check("R1 busy refusal ends CONFIRM immediately and requeues the item", loop.state === "LOOT" && loop.items[0] === 0xa1 && loop.items.length === 2,
      `state=${loop.state} items=${loop.items}`);
    loop.tick();
    check("R1 the retry waits out the pause", count(h, "pickup", 0xa1) === 1);
    loop._nextPickupAt = 0;
    loop.tick();
    check("R1 the same item is picked up again", count(h, "pickup", 0xa1) === 2 && loop.pendingItem === 0xa1);
  }

  // ── R2 a non-busy refusal skips at once ───────────────────────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    inLoot(h, loop, [0xb1, 0xb2]);
    loop.tick(); // pickup b1
    h.emit({ kind: 48, u32: 0xb1, u32b: 0x2a }); // e.g. pack full / someone else took it
    loop.tick(); // refusal -> skip
    loop._nextPickupAt = 0;
    loop.tick(); // next item
    check("R2 a non-busy refusal skips without the 6 s wait", count(h, "pickup", 0xb1) === 1 && count(h, "pickup", 0xb2) === 1 && loop.refusedPickups === 1,
      JSON.stringify(h.calls));
  }

  // ── R3 busy retries are capped ────────────────────────────────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    inLoot(h, loop, [0xc1]);
    for (let i = 0; i < 6; i++) {
      loop._nextPickupAt = 0;
      loop.tick(); // pickup (or finish)
      if (loop.state !== "CONFIRM") break;
      h.emit({ kind: 13, u32: 0x1d });
      h.emit({ kind: 48, u32: 0xc1, u32b: 0x1d });
      loop.tick();
    }
    check("R3 an item refused as busy is tried at most 3 times", count(h, "pickup", 0xc1) === 3 && loop.state === "SCAN", `pickups=${count(h, "pickup", 0xc1)} state=${loop.state}`);
  }

  // ── R4 a refusal for another guid is ignored ──────────────────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    inLoot(h, loop, [0xd1]);
    loop.tick();
    h.emit({ kind: 48, u32: 0xdead, u32b: 0x2a });
    loop.tick();
    check("R4 a 48 for a different item leaves CONFIRM alone", loop.state === "CONFIRM" && loop.pendingItem === 0xd1);
    h.inventory.add(0xd1);
    loop.tick();
    check("R4 the real pickup still confirms", loop.lootedCount === 1 && loop.state === "LOOT");
  }

  // ── O1 OPEN gives up after MAX_OPEN_TRIES refusals ────────────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    loop.tick(); // SCAN: corpse 2 m away -> Use (try 1) -> OPEN
    check("O1 in reach: opened with Use", loop.state === "OPEN" && count(h, "use", CORPSE) === 1);
    for (let i = 0; i < 10 && loop.state === "OPEN"; i++) {
      h.emit({ kind: 13, u32: 0x0436 }); // a non-busy UseFailed (e.g. no loot permission)
      loop.tick(); // refusal -> retry scheduled
      loop._openRetryAt = loop._openRetryAt ? 1 : 0; // retry delay elapsed
      loop.tick(); // re-Use (or park)
    }
    check("O1 a corpse ACE keeps refusing is parked after 3 Uses", loop.state === "SCAN" && count(h, "use", CORPSE) === 3 && loop.looted.has(CORPSE),
      `state=${loop.state} uses=${count(h, "use", CORPSE)}`);
    check("O1 the kernel pin is released (state SCAN)", loop.state === "SCAN");
  }

  // ── O2 a "too busy" open refusal does not spend an attempt ────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    loop.tick(); // Use #1
    h.emit({ kind: 13, u32: 0x1d });
    loop.tick(); // busy -> retry scheduled, uncounted
    loop._openRetryAt = 1;
    loop.tick(); // Use #2
    check("O2 busy open retried without counting", count(h, "use", CORPSE) === 2 && loop._openTries === 1, `uses=${count(h, "use", CORPSE)} tries=${loop._openTries}`);
  }

  // ── O3 open timeout still retries (old behaviour), then parks ─────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    loop.tick(); // Use #1
    for (let i = 0; i < 5 && loop.state === "OPEN"; i++) {
      loop.stateSince = Date.now() - 7000; // OPEN_TIMEOUT_MS passed
      loop.tick();
    }
    check("O3 open timeouts park after 3 Uses", loop.state === "SCAN" && count(h, "use", CORPSE) === 3);
  }

  // ── P1 preemption re-arms APPROACH ────────────────────────────────────
  {
    const h = makeHost();
    h.corpsePos = { objCellId: 0xa9b40021, x: 70, y: 50, z: 0 }; // 20 m: approach
    const loop = new RynthLootLoop(h, { log: quiet });
    loop.tick(); // SCAN -> MoveTo -> APPROACH
    check("P1 approach issued", loop.state === "APPROACH" && count(h, "move") === 1);
    // Combat held the kernel for 25 s: the old clock would say "approach timeout".
    loop.stateSince = Date.now() - 25_000;
    loop._lastTickAt = Date.now() - 25_000;
    loop.tick();
    check("P1 resumed instead of timing out (approach re-issued)", loop.state === "APPROACH" && count(h, "move") === 2 && !loop.looted.has(CORPSE),
      `state=${loop.state} moves=${count(h, "move")}`);
  }

  // ── F1/F2 full pack ───────────────────────────────────────────────────
  {
    const h = makeHost();
    h.freeSlots = 0;
    const loop = new RynthLootLoop(h, { log: quiet });
    check("F1 a full pack hides corpses from the kernel", loop._findCorpse() === null);
    const h2 = makeHost();
    const loop2 = new RynthLootLoop(h2, { log: quiet });
    inLoot(h2, loop2, [0xe1]);
    h2.freeSlots = 0;
    loop2._pack.at = -Infinity; // fresh verdict
    loop2.tick();
    check("F2 a pack that fills mid-corpse leaves the corpse (no doomed pickups)", loop2.state === "SCAN" && count(h2, "pickup") === 0 && count(h2, "close", CORPSE) === 1);
  }

  // ── S1-S3 world-frame distance ────────────────────────────────────────
  {
    // me near the east edge of LB A9B4, corpse just across the seam in AAB4.
    const me = { objCellId: 0xa9b40039, x: 190, y: 100 };
    const across = { objCellId: 0xaab40001, x: 2, y: 100 };
    check("S1 seam distance is 4 m in the world frame", Math.abs(horizontalDistance(me, across) - 4) < 1e-9, String(horizontalDistance(me, across)));
    const h = makeHost();
    h.pose = { ...me, z: 0 };
    h.corpsePos = { ...across, z: 0 };
    const loop = new RynthLootLoop(h, { log: quiet });
    check("S2 a corpse across an outdoor seam is found", loop._findCorpse()?.guid === CORPSE);
    check("S3 indoor cells of different landblocks are not compared",
      horizontalDistance({ objCellId: 0x01d90105, x: 1, y: 1 }, { objCellId: 0x01da0105, x: 1, y: 1 }) === null);
  }

  // ── C1 a finished corpse is closed ────────────────────────────────────
  {
    const h = makeHost();
    const loop = new RynthLootLoop(h, { log: quiet });
    inLoot(h, loop, []);
    loop.tick(); // nothing left -> finish
    check("C1 NoLongerViewingContents on finish", count(h, "close", CORPSE) === 1 && loop.state === "SCAN" && loop.looted.has(CORPSE));
  }

  // ── G1 portal space holds the tick ────────────────────────────────────
  {
    const h = makeHost({ IsPortalSpaceActive: () => true });
    h.corpsePos = { objCellId: 0xa9b40021, x: 70, y: 50, z: 0 };
    const loop = new RynthLootLoop(h, { log: quiet });
    loop.tick();
    check("G1 no MoveTo/Use while in portal space", h.calls.length === 0 && loop.state === "SCAN");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
