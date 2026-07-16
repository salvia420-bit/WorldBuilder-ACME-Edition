#!/usr/bin/env node
// parity_check.cjs — replay fixtures.json (C# LootScoring expectations)
// against the SHIPPED JS loot brain: apps/holtburger-web/rynth/loot_loop.js.
//
// The JS loop's ENTIRE rule model is one min-value gate
// (loot_loop.js:163-164: `TryGetObjectIntProperty(item, 19) ?? 0 >= minValue`),
// so for each scenario the harness builds a mock RynthWebHost (mirroring
// webhost.js contracts: _live() returns undefined on miss, webhost.js:290-297;
// TryGetObjectIntProperty webhost.js:317-318; host.s = sessionHandle with
// moveItem/playerInventory), instantiates the real RynthLootLoop with the
// scenario's jsMap.minValue, puts it in the LOOT state with the fixture item,
// runs tick() under a frozen Date.now, and observes whether s.moveItem fired
// (pickup) or the item was skipped.
//
// Comparison plane: PICKUP — C# verdict keep/salvage => pickup, no-loot =>
// skip (JS has no salvage plane; a C# "salvage" that JS picks up counts as
// pickup-agreement, the plane gap is reported separately). jsMap.mappable
// marks scenarios whose profile is fully expressible as the JS gate —
// divergence there would be a GENUINE finding; elsewhere divergences are
// expected-by-design and jsMap.gap names the missing predicate plane.
//
// Divergences are FINDINGS, not failures — exit code is 0 unless the harness
// itself breaks. Run:  node parity_check.cjs [path/to/fixtures.json]

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;
const FIXTURES = process.argv[2] || path.join(HERE, "fixtures.json");
const LOOT_LOOP = path.join(HERE, "../../../../apps/holtburger-web/rynth/loot_loop.js");

const PLAYER_ID = 0x50f00001;
const CORPSE_ID = 0x7c0ff001;
const NOW_MS = 1_000_000;

function makeHost(input, calls) {
  const item = input.Item;
  return {
    // snapshot-backed reads the LOOT branch touches (webhost.js:249-266)
    IsPlayerReady: () => true,
    GetBusyState: () => 0, // idle — the gate itself is pacing, not verdict
    GetPlayerId: () => PLAYER_ID,
    // webhost.js:317-318 — _live() misses read as undefined (never null/0).
    TryGetObjectIntProperty: (g, stype) => {
      if (g !== item.Id) return undefined;
      const v = (item.IntValues || {})[String(stype)];
      return v === undefined ? undefined : v;
    },
    // sessionHandle seam (webhost.js:86; loot_loop.js:165 h.s.moveItem)
    s: {
      moveItem: (guid, to, slot) => calls.push({ guid, to, slot }),
      playerInventory: () => [],
    },
    // surface used by OTHER states, present so an unexpected transition
    // fails loud rather than TypeErroring silently:
    TryGetPlayerPose: () => ({ objCellId: 0xa9b40015, x: 96, y: 96, z: 0 }),
    GetGroundContainerId: () => CORPSE_ID,
    GetContainerContents: (g) => (g === CORPSE_ID ? [item.Id] : []),
    NearbyGuids: () => [],
    TryGetObjectWcid: () => 0,
    TryGetObjectPosition: () => null,
    MoveToPosition: () => {},
    UseObject: () => {},
    StopCompletely: () => {},
    onTick: () => {},
  };
}

async function main() {
  // loot_loop.js is ESM (`export class`) but carries a .js extension with no
  // "type":"module" package.json above it — copy to a temp .mjs so Node's
  // loader classifies it correctly. The bytes tested are the repo file's.
  const src = fs.readFileSync(LOOT_LOOP, "utf8");
  const tmp = path.join(os.tmpdir(), `loot_loop_parity_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  let RynthLootLoop;
  try {
    ({ RynthLootLoop } = await import("file://" + tmp));
  } finally {
    fs.unlinkSync(tmp);
  }

  const fx = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  const realNow = Date.now;
  const rows = [];

  for (const sc of fx.scenarios) {
    const input = sc.input;
    const exp = sc.expected;
    const calls = [];
    const host = makeHost(input, calls);

    const loop = new RynthLootLoop(host, {
      minValue: sc.jsMap.minValue,
      log: () => {},
    });
    // Seed the LOOT state directly: corpse already opened + enumerated
    // (loot_loop.js:141-149 stamps items/corpse then _setState("LOOT")).
    loop.corpse = CORPSE_ID;
    loop.items = [input.Item.Id];
    loop.state = "LOOT";
    loop.stateSince = NOW_MS;

    Date.now = () => NOW_MS;
    let jsPickup, jsEndState;
    try {
      loop.tick(); // LOOT branch: loot_loop.js:158-174
      jsPickup = calls.length > 0 && calls[0].guid === input.Item.Id;
      jsEndState = loop.state;
    } finally {
      Date.now = realNow;
    }

    const csPickup = exp.Verdict === "keep" || exp.Verdict === "salvage";
    const isError = exp.Verdict === "error";

    let verdict, cls;
    if (isError) {
      verdict = "C#-ERROR-PATH";
      cls = "error-path";
    } else if (csPickup === jsPickup) {
      verdict = "agree";
      cls = exp.Verdict === "salvage" ? "agree-pickup (salvage plane lost in JS)" : "agree";
    } else {
      verdict = "DIVERGE";
      cls = sc.jsMap.mappable
        ? "GENUINE (profile was JS-mappable)"
        : `expected-by-design (${sc.jsMap.gap || "JS subset"})`;
    }

    rows.push({
      name: sc.name,
      rules: sc.rules.join(","),
      verdict,
      cls,
      cs: isError ? `error:${exp.Error}` : exp.Verdict,
      js: jsPickup ? "pickup" : `skip(${jsEndState})`,
    });
  }

  const W = Math.max(...rows.map((r) => r.name.length)) + 1;
  for (const r of rows)
    console.log(
      `${r.verdict.padEnd(14)} ${r.name.padEnd(W)} cs=${r.cs.padEnd(22)} js=${r.js.padEnd(12)} ${r.cls} [${r.rules}]`
    );

  const agree = rows.filter((r) => r.verdict === "agree").length;
  const div = rows.filter((r) => r.verdict === "DIVERGE").length;
  const err = rows.filter((r) => r.verdict === "C#-ERROR-PATH").length;
  const genuine = rows.filter((r) => r.cls.startsWith("GENUINE")).length;
  console.log(
    `\nTOTAL: ${rows.length} scenarios — agree=${agree} DIVERGE=${div} (genuine=${genuine}, expected-by-design=${div - genuine}) error-path=${err}`
  );

  // Per-gap breakdown of the expected divergences.
  const byGap = new Map();
  for (const r of rows)
    if (r.verdict === "DIVERGE") {
      const k = r.cls;
      byGap.set(k, (byGap.get(k) || 0) + 1);
    }
  for (const [k, n] of [...byGap.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}x ${k}`);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
