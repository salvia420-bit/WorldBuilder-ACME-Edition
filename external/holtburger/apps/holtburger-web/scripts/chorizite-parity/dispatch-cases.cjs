#!/usr/bin/env node
// TASK 2B — GetObjectClass dispatch parity (synthetic, branch-labelled)
//
// 20+ synthetic test tuples (loaded from sibling dispatch-cases.json),
// each pinned to one named algorithmic branch in
// `external/chorizite/ACPlugin/API/WorldObject.cs:344-411`.
//
// Pipes every tuple through BOTH classifier ports:
//   - C#: WorldBuilder.Terminal `chorizite-classify` command
//   - JS: plugins/world-objects/canonical_classify.js
//
// Asserts:
//   1. C# output === expected
//   2. JS output === expected
//   3. C# output === JS output  (byte-equal port parity)
//
// Exit 0 only when ALL three assertions hold for every case.
// Exit 1 with a verbatim diff if ANY case mismatches.
//
// This is a CI-gate companion to scripts/cross_port_parity.cjs (which uses
// the same 48-case set as validate_entity_classification.cjs). Lower
// overhead — 25 cases, each carrying an explicit `branch` label citing
// the C# line — designed to fail loud and fast if the dispatch table
// shape drifts.
//
// Run:  node scripts/chorizite-parity/dispatch-cases.cjs
// Exit: 0 on full parity; 1 on any divergence; 2 on harness error.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

(async () => {
  const scriptDir = __dirname;
  const webRoot = path.resolve(scriptDir, "..", "..");
  const fixturePath = path.join(scriptDir, "dispatch-cases.json");
  const classifierUrl = url.pathToFileURL(path.join(
    webRoot, "plugins", "world-objects", "canonical_classify.js"
  )).href;

  if (!fs.existsSync(fixturePath)) {
    console.error(`[dispatch-cases] fixture not found: ${fixturePath}`);
    process.exit(2);
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const cases = fixture.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error(`[dispatch-cases] fixture .cases must be a non-empty array`);
    process.exit(2);
  }

  const { canonicalClassify } = await import(classifierUrl);

  const dotnetRoot = process.env.DOTNET_ROOT || "/home/wbterminal/.dotnet";
  const wbDll = path.resolve(webRoot,
    "..", "..", "..", "..", "WorldBuilder.Terminal", "bin", "Release", "net8.0",
    "WorldBuilder.Terminal.dll");
  if (!fs.existsSync(wbDll)) {
    console.error(`[dispatch-cases] WB.Terminal dll not found: ${wbDll}`);
    console.error(`  Build it first: dotnet build -c Release WorldBuilder.Terminal`);
    process.exit(2);
  }

  const lines = [];
  for (const c of cases) {
    lines.push(JSON.stringify({
      command: "chorizite-classify",
      itemType:     c.itemType,
      objDescFlags: c.objDescFlags,
      weenieFlags:  c.weenieFlags,
    }));
  }
  lines.push(JSON.stringify({ command: "quit" }));

  process.stderr.write(
    `[dispatch-cases] piping ${cases.length} cases through WB.Terminal...\n`
  );
  const wb = spawnSync(`${dotnetRoot}/dotnet`, [wbDll, "--stdin"], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    timeout: 60_000,
  });
  if (wb.status !== 0) {
    console.error(`[dispatch-cases] WB.Terminal exited ${wb.status}`);
    console.error(`  stderr: ${wb.stderr}`);
    process.exit(2);
  }

  const wbResponses = wb.stdout
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    })
    .filter(r => r && r.command === "chorizite-classify");

  if (wbResponses.length !== cases.length) {
    console.error(
      `[dispatch-cases] expected ${cases.length} WB.Terminal responses, ` +
      `got ${wbResponses.length}`
    );
    console.error(`  raw stdout: ${wb.stdout}`);
    process.exit(2);
  }

  const rows = [];
  const mismatches = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const itU32  = Number.parseInt(c.itemType,     16) >>> 0;
    const odfU32 = Number.parseInt(c.objDescFlags, 16) >>> 0;
    const whfU32 = Number.parseInt(c.weenieFlags,  16) >>> 0;
    const jsOut = canonicalClassify(itU32, odfU32, whfU32);
    const csOut = wbResponses[i].objectClass;

    const csMatchesExpected = csOut === c.expected;
    const jsMatchesExpected = jsOut === c.expected;
    const csEqJs            = csOut === jsOut;
    const ok = csMatchesExpected && jsMatchesExpected && csEqJs;

    rows.push({
      idx: i + 1,
      name: c.name,
      branch: c.branch,
      csLine: c.csLine,
      itemType: c.itemType,
      objDescFlags: c.objDescFlags,
      weenieFlags: c.weenieFlags,
      expected: c.expected,
      csOut,
      jsOut,
      ok,
    });

    if (!ok) {
      mismatches.push({
        idx: i + 1,
        name: c.name,
        branch: c.branch,
        csLine: c.csLine,
        inputs: {
          itemType: c.itemType,
          objDescFlags: c.objDescFlags,
          weenieFlags: c.weenieFlags,
        },
        expected: c.expected,
        csOut,
        jsOut,
        csMatchesExpected,
        jsMatchesExpected,
        csEqJs,
      });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log("");
  console.log("dispatch-cases — TASK 2B GetObjectClass parity");
  console.log("==============================================");
  console.log(`Source:   external/chorizite/ACPlugin/API/WorldObject.cs:344-411`);
  console.log(`JS port:  plugins/world-objects/canonical_classify.js`);
  console.log(`C# port:  WorldBuilder.Terminal::ChoriziteClassify`);
  console.log(`Fixture:  scripts/chorizite-parity/dispatch-cases.json`);
  console.log(`Cases:    ${cases.length}`);
  console.log("");
  console.log("Per-branch coverage table:");
  console.log("");
  console.log(
    pad("#",  3) + " " +
    pad("name",                       30) + " " +
    pad("cs:line",                     8) + " " +
    pad("itemType",                   11) + " " +
    pad("objDescFlags",               13) + " " +
    pad("weenieFlags",                12) + " " +
    pad("expected",                   18) + " " +
    pad("cs-out",                     18) + " " +
    pad("js-out",                     18) + " " +
    "match"
  );
  console.log("-".repeat(139));
  for (const r of rows) {
    console.log(
      pad(r.idx, 3) + " " +
      pad(r.name,         30) + " " +
      pad(`:${r.csLine}`,  8) + " " +
      pad(r.itemType,     11) + " " +
      pad(r.objDescFlags, 13) + " " +
      pad(r.weenieFlags,  12) + " " +
      pad(r.expected,     18) + " " +
      pad(r.csOut,        18) + " " +
      pad(r.jsOut,        18) + " " +
      (r.ok ? "PASS" : "FAIL")
    );
  }
  console.log("");

  const pass = rows.length - mismatches.length;
  const fail = mismatches.length;
  console.log(`Pass: ${pass} / ${cases.length}`);
  console.log(`Fail: ${fail} / ${cases.length}`);
  console.log("");

  console.log("Branches exercised (deduped by branch label):");
  const branchesByLabel = new Map();
  for (const r of rows) {
    if (!branchesByLabel.has(r.branch)) {
      branchesByLabel.set(r.branch, { ok: true, csLine: r.csLine });
    }
    if (!r.ok) branchesByLabel.get(r.branch).ok = false;
  }
  for (const [label, info] of branchesByLabel) {
    console.log(`  ${info.ok ? "[ok]" : "[!!]"} cs:${info.csLine}  ${label}`);
  }
  console.log(`Distinct branches hit: ${branchesByLabel.size}`);
  console.log("");

  if (fail > 0) {
    console.log("DIVERGENCES — DO NOT silently fix; this is a real finding.");
    console.log("Re-read ACPlugin/API/WorldObject.cs:344-411. Whichever port");
    console.log("differs from that source is the bug.");
    console.log("");
    for (const m of mismatches) {
      console.log(`  ✗ case #${m.idx} ${m.name}`);
      console.log(`      branch:   ${m.branch}  (cs:${m.csLine})`);
      console.log(`      inputs:   itemType=${m.inputs.itemType} ` +
                  `objDescFlags=${m.inputs.objDescFlags} ` +
                  `weenieFlags=${m.inputs.weenieFlags}`);
      console.log(`      expected: ${m.expected}`);
      console.log(`      c# port:  ${m.csOut}    ${m.csMatchesExpected ? "(matches expected)" : "(diverged)"}`);
      console.log(`      js port:  ${m.jsOut}    ${m.jsMatchesExpected ? "(matches expected)" : "(diverged)"}`);
      console.log(`      c# == js: ${m.csEqJs}`);
      console.log("");
    }
    process.exit(1);
  }

  console.log(
    `PASS — all ${pass} cases agree: C# port ≡ JS port ≡ expected. ` +
    `${branchesByLabel.size} distinct branches exercised.`
  );
  process.exit(0);
})().catch(e => {
  console.error("[dispatch-cases] harness crashed:", e);
  process.exit(2);
});
