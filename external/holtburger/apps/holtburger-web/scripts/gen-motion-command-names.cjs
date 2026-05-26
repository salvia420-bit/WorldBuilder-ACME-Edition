#!/usr/bin/env node
// scripts/gen-motion-command-names.cjs
//
// Parses ACE's MotionCommand enum and emits a JSON lookup table keyed by
// hex u32 string → enum name. Used by `scene3d/diag/combat.js` so the
// motion-u32 histogram renders human-readable names ("SlashMed") instead
// of raw `0x10000068`.
//
// Source: /home/wbterminal/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs
// Output: data/motion-command-names.json
//
// One-shot — re-run if ACE updates the enum:
//   node apps/holtburger-web/scripts/gen-motion-command-names.cjs
//
// Authored 2026-05-26 for CMT fixes Wave 1 Phase 1.

const fs = require("node:fs");
const path = require("node:path");

const ACE_SRC = "/home/wbterminal/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs";
const OUT_PATH = path.resolve(__dirname, "..", "data", "motion-command-names.json");

function main() {
  const text = fs.readFileSync(ACE_SRC, "utf8");

  // Slice to just the `public enum MotionCommand` body — there's a
  // helper class with case-statements after it that we must NOT match.
  const enumStart = text.indexOf("public enum MotionCommand");
  if (enumStart < 0) {
    console.error("MotionCommand enum not found in", ACE_SRC);
    process.exit(1);
  }
  // Find the opening brace and walk to the matching close.
  const openIdx = text.indexOf("{", enumStart);
  if (openIdx < 0) { console.error("opening brace not found"); process.exit(1); }
  let depth = 1;
  let cursor = openIdx + 1;
  while (cursor < text.length && depth > 0) {
    const ch = text[cursor];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    cursor += 1;
  }
  const body = text.slice(openIdx + 1, cursor - 1);

  // Match `Name = 0xHEX,` lines. Allow trailing `// comment`.
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*0x([0-9a-fA-F]+)\s*,/gm;
  const out = {};
  const dupes = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    const hex = m[2].toLowerCase().padStart(8, "0");
    const key = "0x" + hex;
    if (key in out) {
      dupes.push({ key, kept: out[key], dropped: name });
      continue; // First definition wins (canonical).
    }
    out[key] = name;
  }

  const count = Object.keys(out).length;
  if (count < 100) {
    console.error(`Suspiciously few entries (${count}); aborting.`);
    process.exit(1);
  }

  // Sort by numeric u32 for diff stability.
  const sorted = {};
  for (const k of Object.keys(out).sort((a, b) => parseInt(a, 16) - parseInt(b, 16))) {
    sorted[k] = out[k];
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`[gen-motion-command-names] wrote ${count} entries → ${OUT_PATH}`);
  if (dupes.length) {
    console.warn(`[gen-motion-command-names] ${dupes.length} duplicate hex values (first def kept):`);
    for (const d of dupes) console.warn(`  ${d.key}: kept=${d.kept} dropped=${d.dropped}`);
  }
}

main();
