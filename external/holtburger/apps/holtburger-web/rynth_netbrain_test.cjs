#!/usr/bin/env node
// rynth_netbrain_test.cjs — loader + shadow-harness tests for rynth/netbrain.js
// (the D1 path-A′ .NET-wasm brain). No infra needed. If the gitignored
// netbrain/AppBundle is absent (fresh clone), the bundle-dependent half SKIPs
// cleanly — build it with netbrain/build.sh to run the full set.
//
// Run: node rynth_netbrain_test.cjs   (exits 1 on any FAIL)

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const nb = await import(pathToFileURL(path.join(__dirname, "rynth", "netbrain.js")).href);

  // Flag parsing — only the exact strings opt in (flag-default footgun).
  check("mode shadow", nb.netBrainModeFromUrl("?netBrain=shadow") === "shadow");
  check("mode on", nb.netBrainModeFromUrl("?netBrain=on") === "on");
  check("mode 1 is off", nb.netBrainModeFromUrl("?netBrain=1") === "off");
  check("mode absent is off", nb.netBrainModeFromUrl("") === "off");

  // Diag surface shape.
  const d = nb.diag();
  check("diag counters", d.calls.combat === 0 && d.diverges.buff === 0);
  check("diag summary", typeof d.summary() === "string" && d.summary().includes("netbrain mode=off"));

  // shadowTick never throws to the caller.
  check("shadowTick null brain", nb.shadowTick(null, "combat", () => ({}), () => ({ agree: true })) === null);
  check("shadowTick buildInput throw swallowed",
    nb.shadowTick({ scoreTargets: () => ({}) }, "combat", () => { throw new Error("x"); }, () => ({ agree: true })) === null
      && d.errors.combat === 1);

  const bundle = path.join(__dirname, "netbrain", "AppBundle");
  if (!fs.existsSync(path.join(bundle, "_framework", "dotnet.js"))) {
    console.log("SKIP bundle tests (netbrain/AppBundle not built — run netbrain/build.sh)");
  } else {
    const brain = await nb.loadNetBrain({ bundleUrl: pathToFileURL(bundle + "/").href });
    check("bundle loads", !!brain, nb.diag().loadError || "");
    if (brain) {
      check("version", /^rynth-netbrain-/.test(brain.version), brain.version);

      // One committed fixture through each boundary — spot parity (the full
      // corpus gate is netbrain/replay_fixtures.mjs).
      const spike = path.join(__dirname, "../../docs/rynth-integration/netwasm-spike");
      const cfx = JSON.parse(fs.readFileSync(path.join(spike, "CombatScoring/fixtures.json"), "utf8"));
      const c0 = cfx.scenarios[0];
      const cOut = brain.scoreTargets(c0.input);
      check("scoreTargets fixture[0]", cOut.SelectedTargetId === c0.expected.SelectedTargetId,
        `${c0.name}: got ${cOut.SelectedTargetId} want ${c0.expected.SelectedTargetId}`);

      const bfx = JSON.parse(fs.readFileSync(path.join(spike, "BuffScoring/fixtures.json"), "utf8"));
      const call0 = bfx.scenarios[0].calls[0];
      const bOut = brain.scheduleBuffs(call0.input);
      check("scheduleBuffs call[0]", bOut.Action === call0.output.Action,
        `got ${bOut.Action} want ${call0.output.Action}`);

      // Buff shadow end-to-end: a REAL RynthBuffLoop with a mock host, the
      // real bundle attached — proves the live-built BuffInput deserializes
      // in C# (a DTO shape mismatch throws in STJ and lands in errors.buff).
      {
        const bl = await import(pathToFileURL(path.join(__dirname, "rynth", "buff_loop.js")).href);
        const casts = [];
        const host = {
          IsPlayerReady: () => true,
          GetCurrentCombatMode: () => 8,
          GetCastBusyState: () => 0,
          GetBusyState: () => 0,
          CastSpell: (_t, id) => casts.push(id),
          s: {
            playerEnchantments: () => [
              { spellId: 2, spellCategory: 1, startTime: 100, duration: 1800 },
            ],
            playerKnownSpells: () => [2, 6],
          },
        };
        const loop = new bl.RynthBuffLoop(host, [2], { log: () => {}, tierLadders: false });
        loop.attachNetBrain(brain, "shadow", nb, { minIntervalMs: 0 });
        loop.registryReady = true;
        loop.startedAt = Date.now() - 30_000;
        const e0 = d.errors.buff, c0 = d.calls.buff;
        loop.tick();
        loop.lastCastAt = 0; // release B14 pacing for a second shadowed tick
        loop.pending = null;
        loop.tick();
        check("buff shadow calls", d.calls.buff >= c0 + 2, `calls=${d.calls.buff - c0}`);
        check("buff shadow no DTO errors", d.errors.buff === e0, `errors=${d.errors.buff - e0}`);
      }

      // Loot shadow end-to-end: real RynthLootLoop in the LOOT state, real
      // bundle — pickup-plane agreement on the shared value-floor domain.
      {
        const ll = await import(pathToFileURL(path.join(__dirname, "rynth", "loot_loop.js")).href);
        const values = { 0x70001111: 500, 0x70002222: 50000 };
        const host = {
          IsPlayerReady: () => true,
          GetBusyState: () => 0,
          GetPlayerId: () => 0x50000001,
          TryGetObjectIntProperty: (g, k) => (k === 19 ? values[g] : undefined),
          TryGetObjectName: (g) => `item-${g.toString(16)}`,
          s: { moveItem: () => {} },
        };
        const loop = new ll.RynthLootLoop(host, { minValue: 1000, log: () => {} });
        loop.attachNetBrain(brain, "shadow", nb);
        loop.corpse = 0x70000001;
        loop.items = [0x70001111, 0x70002222];
        loop.state = "LOOT";
        loop.stateSince = Date.now();
        const a0 = d.agrees.loot, e0 = d.errors.loot;
        loop.tick(); // 500 < 1000: skip (shadowed), then 50000: pickup (shadowed)
        check("loot shadow calls agree", d.agrees.loot === a0 + 2,
          `agrees=${d.agrees.loot - a0} diverges=${d.diverges.loot} errors=${d.errors.loot - e0}`);
        check("loot shadow no DTO errors", d.errors.loot === e0, `errors=${d.errors.loot - e0}`);
      }

      // Shadow accounting: one agree, one diverge, sample recorded.
      const before = { a: d.agrees.combat, v: d.diverges.combat };
      nb.shadowTick(brain, "combat", () => c0.input,
        (out) => ({ agree: out.SelectedTargetId === c0.expected.SelectedTargetId, jsVal: 1, csVal: 1 }));
      nb.shadowTick(brain, "combat", () => c0.input,
        (out) => ({ agree: false, jsVal: "js", csVal: out.SelectedTargetId }));
      check("shadow agree counted", d.agrees.combat === before.a + 1);
      check("shadow diverge counted", d.diverges.combat === before.v + 1 && d.samples.length > 0);
    }
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
