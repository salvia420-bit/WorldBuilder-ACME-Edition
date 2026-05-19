#!/usr/bin/env node
// Phase E.E — Cross-port parity for entity classification
//
// Drives the same payload set through BOTH classifier ports:
//   - JS:  plugins/world-objects/canonical_classify.js
//   - C#:  WorldBuilder.Terminal `chorizite-classify` command
//
// Both are 1:1 ports of ACPlugin/API/WorldObject.cs:344-411. If they
// ever disagree on the same input, ONE has drifted from the C# source.
// Re-read WorldObject.cs to determine which is wrong; fix the port,
// don't change this test.
//
// **Run:**  node scripts/cross_port_parity.cjs
// **Exit:** 0 if every payload classifies identically; nonzero on any
//           divergence.
//
// **What this protects against:**
//   - Future edits to canonical_classify.js drifting from the algorithm
//   - Future edits to CommandEngine.Chorizite.cs::ChoriziteClassify
//     drifting from the algorithm
//   - Upstream changes to ACPlugin's GetObjectClass that we'd want to
//     mirror (manual cross-read + port-both)
//
// **What it does NOT protect against:**
//   - BOTH ports drifting in the same direction from upstream ACPlugin
//     (would need a third reference; currently the C# source IS the
//     reference, and re-reading it during periodic audits is the only
//     defense)

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const url = require("node:url");

(async () => {
  const repoRoot = path.dirname(__filename) + "/..";
  const classifierUrl = url.pathToFileURL(path.join(
    repoRoot, "plugins", "world-objects", "canonical_classify.js"
  )).href;
  const { canonicalClassify, BITFLAGS } = await import(classifierUrl);

  const IT  = BITFLAGS.ItemType;
  const ODF = BITFLAGS.ObjectDescriptionFlag;
  const WHF = BITFLAGS.WeenieHeaderFlag;

  // Reuse the SAME payload set as validate_entity_classification.cjs
  // so coverage is identical. Kept inline (rather than imported) so
  // this script stays a single-file standalone artifact.
  const cases = [
    // PASS 1 ItemType
    { name: "MeleeWeapon", it: IT.MeleeWeapon, odf: 0, whf: 0 },
    { name: "Armor", it: IT.Armor, odf: 0, whf: 0 },
    { name: "Clothing", it: IT.Clothing, odf: 0, whf: 0 },
    { name: "Jewelry", it: IT.Jewelry, odf: 0, whf: 0 },
    { name: "Creature (no obj-desc)", it: IT.Creature, odf: 0, whf: 0 },
    { name: "Creature+Attackable", it: IT.Creature, odf: ODF.Attackable, whf: 0 },
    { name: "Food via ItemType", it: IT.Food, odf: 0, whf: 0 },
    { name: "Money", it: IT.Money, odf: 0, whf: 0 },
    { name: "Misc", it: IT.Misc, odf: 0, whf: 0 },
    { name: "MissileWeapon", it: IT.MissileWeapon, odf: 0, whf: 0 },
    { name: "Container", it: IT.Container, odf: 0, whf: 0 },
    { name: "Useless", it: IT.Useless, odf: 0, whf: 0 },
    { name: "Gem", it: IT.Gem, odf: 0, whf: 0 },
    { name: "SpellComponents", it: IT.SpellComponents, odf: 0, whf: 0 },
    { name: "Key", it: IT.Key, odf: 0, whf: 0 },
    { name: "Caster", it: IT.Caster, odf: 0, whf: 0 },
    { name: "Portal", it: IT.Portal, odf: 0, whf: 0 },
    { name: "PromissoryNote", it: IT.PromissoryNote, odf: 0, whf: 0 },
    { name: "ManaStone", it: IT.ManaStone, odf: 0, whf: 0 },
    { name: "Service", it: IT.Service, odf: 0, whf: 0 },
    { name: "MagicWieldable", it: IT.MagicWieldable, odf: 0, whf: 0 },
    { name: "CraftCookingBase", it: IT.CraftCookingBase, odf: 0, whf: 0 },
    { name: "CraftAlchemyBase", it: IT.CraftAlchemyBase, odf: 0, whf: 0 },
    { name: "CraftFletchingBase", it: IT.CraftFletchingBase, odf: 0, whf: 0 },
    { name: "CraftFletchingIntermediate", it: IT.CraftFletchingIntermediate, odf: 0, whf: 0 },
    { name: "TinkeringTool", it: IT.TinkeringTool, odf: 0, whf: 0 },
    { name: "TinkeringMaterial", it: IT.TinkeringMaterial, odf: 0, whf: 0 },
    // PASS 2 obj-desc overrides
    { name: "Player override", it: IT.Creature, odf: ODF.Player, whf: 0 },
    { name: "Vendor override", it: IT.Creature, odf: ODF.Vendor, whf: 0 },
    { name: "Door", it: 0, odf: ODF.Door, whf: 0 },
    { name: "Corpse", it: 0, odf: ODF.Corpse, whf: 0 },
    { name: "Lifestone", it: 0, odf: ODF.Lifestone, whf: 0 },
    { name: "Food via obj-desc", it: 0, odf: ODF.Food, whf: 0 },
    { name: "Healer", it: IT.Misc, odf: ODF.Healer, whf: 0 },
    { name: "Lockpick", it: IT.Misc, odf: ODF.Lockpick, whf: 0 },
    { name: "Portal via obj-desc", it: 0, odf: ODF.Portal, whf: 0 },
    { name: "Foci", it: 0, odf: ODF.RequiresPackSlot, whf: 0 },
    { name: "Container via Openable", it: 0, odf: ODF.Openable, whf: 0 },
    { name: "Bindstone", it: 0, odf: ODF.BindStone, whf: 0 },
    // PASS 3 refinements
    { name: "Journal", it: IT.Writable, odf: ODF.Book | ODF.Inscribable, whf: 0 },
    { name: "Sign", it: IT.Writable, odf: ODF.Book | ODF.Stuck, whf: 0 },
    { name: "Book plain", it: IT.Writable, odf: ODF.Book, whf: 0 },
    { name: "Scroll", it: IT.Writable, odf: 0, whf: WHF.Spell },
    { name: "Npc via !Attackable", it: IT.Creature, odf: 0, whf: 0 },
    { name: "Npc via IncludesSecondHeader", it: IT.Creature, odf: ODF.Attackable | ODF.IncludesSecondHeader, whf: 0 },
    { name: "Misc+Stuck → Static", it: IT.Misc, odf: ODF.Stuck, whf: 0 },
    { name: "Unknown+Stuck → Static", it: 0, odf: ODF.Stuck, whf: 0 },
    // Unknown sentinel
    { name: "Unknown (no inputs)", it: 0, odf: 0, whf: 0 },
  ];

  // ──────────────────────────────────────────────────────────────
  // Build the stdin payload for WB.Terminal (1 line per case + quit)
  // ──────────────────────────────────────────────────────────────
  const dotnetRoot = process.env.DOTNET_ROOT || "/home/wbterminal/.dotnet";
  const wbDll = path.resolve(repoRoot,
    "../../../../WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll");
  const lines = [];
  for (const c of cases) {
    lines.push(JSON.stringify({
      command: "chorizite-classify",
      itemType: `0x${c.it.toString(16).padStart(8, "0")}`,
      objDescFlags: `0x${c.odf.toString(16).padStart(8, "0")}`,
      weenieFlags: `0x${c.whf.toString(16).padStart(8, "0")}`,
    }));
  }
  lines.push(JSON.stringify({ command: "quit" }));

  process.stderr.write(`[cross-port] piping ${cases.length} cases through WB.Terminal...\n`);
  const wb = spawnSync(`${dotnetRoot}/dotnet`, [wbDll, "--stdin"], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    timeout: 60_000,
  });
  if (wb.status !== 0) {
    console.error("WB.Terminal exited", wb.status);
    console.error("stderr:", wb.stderr);
    process.exit(2);
  }

  // Parse the WB.Terminal responses. One JSON per line, skip the
  // ready + quit envelope responses.
  const wbResponses = wb.stdout
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(r => r.command === "chorizite-classify");

  if (wbResponses.length !== cases.length) {
    console.error(`expected ${cases.length} WB.Terminal responses, got ${wbResponses.length}`);
    process.exit(2);
  }

  // ──────────────────────────────────────────────────────────────
  // Compare JS vs C# port output for every case
  // ──────────────────────────────────────────────────────────────
  let pass = 0, fail = 0;
  const drifts = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const jsOut = canonicalClassify(c.it, c.odf, c.whf);
    const csOut = wbResponses[i].objectClass;
    const ok = jsOut === csOut;
    if (ok) {
      pass++;
    } else {
      fail++;
      drifts.push({ name: c.name, js: jsOut, cs: csOut, inputs: c });
    }
  }

  console.log("");
  console.log("cross_port_parity — Phase E.E");
  console.log("=============================");
  console.log(`JS port:  plugins/world-objects/canonical_classify.js`);
  console.log(`C# port:  WorldBuilder.Terminal::ChoriziteClassify`);
  console.log(`Source:   external/chorizite/ACPlugin/API/WorldObject.cs:344-411`);
  console.log(`Cases:    ${cases.length}`);
  console.log(`Pass:     ${pass}`);
  console.log(`Fail:     ${fail}`);
  console.log("");

  if (fail > 0) {
    console.log("DRIFTS:");
    for (const d of drifts) {
      console.log(`  ✗ ${d.name}`);
      console.log(`      js  → ${d.js}`);
      console.log(`      c#  → ${d.cs}`);
      console.log(`      inputs: itemType=0x${d.inputs.it.toString(16)} ` +
                  `objDescFlags=0x${d.inputs.odf.toString(16)} ` +
                  `weenieFlags=0x${d.inputs.whf.toString(16)}`);
    }
    console.log("");
    console.log("Resolution: re-read ACPlugin/API/WorldObject.cs:344-411.");
    console.log("Whichever port differs from that source is the bug; fix the port,");
    console.log("don't change this test. See docs/entity-completeness-method.md §E.D.");
    process.exit(1);
  }

  console.log(`PASS — JS and C# ports produce byte-identical output for all ${pass} cases.`);
  process.exit(0);
})().catch(e => {
  console.error("cross-port harness crashed:", e);
  process.exit(2);
});
