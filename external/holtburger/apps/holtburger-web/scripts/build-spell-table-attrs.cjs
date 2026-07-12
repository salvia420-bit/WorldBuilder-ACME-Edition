#!/usr/bin/env node
// scripts/build-spell-table-attrs.cjs
//
// Builds `data/spell-table-attrs.json` — the DAT-AUTHORITATIVE per-spell
// attribute table that `gen-spell-cast-sequence.cjs` consumes for
// gesture-identity data (formula, bitfield, caster/target effects).
//
// ## Why this exists (WS13 — data correctness)
//
// The cast-sequence generator historically sourced the spell FORMULA,
// SpellFlags bitfield, and caster/target effects from the LSD dump
// (`LSD-Partial-2025-02-23_16-15/spells.json`). LSD is 6,264/6,266
// correct, but silently corrupt on a handful of rows (a high-word/
// formula_version leak on spell 4024, mis-decoded components on 4904,
// a stale targetEffect on 5174). The retail client itself loads the
// SpellTable (DID 0x0E00000E) straight from `client_portal.dat`, with
// the formula DECRYPTED per-spell (name+desc-keyed, NOT account-keyed —
// see `acclient.c:CSpellBase::InqSpellFormula`). So the DAT is the
// single source of truth. This script mirrors how `spell-components.json`
// is built from the DAT — it shells the WorldBuilder.Terminal chorizite
// oracle for record 0x0E00000E and emits the decrypted attributes.
//
// ## Output schema
//
// ```json
// {
//   "_comment": "...",
//   "_source": "client_portal.dat 0x0E00000E (SpellTable, decrypted)",
//   "_spell_count": 6266,
//   "_fast_cast_count": <N>,
//   "attrs": {
//     "75": {
//       "formula": [1, 15, 34, 40, 55],   // DECRYPTED components, in order
//       "bitfield": 3,                     // SpellFlags as a raw int
//       "casterEffect": 0,                 // PlayScript int (0 = Invalid)
//       "targetEffect": 0,                 // PlayScript int
//       "formulaVersion": 1,
//       "school": "WarMagic"
//     }
//   }
// }
// ```
//
// ## bitfield forms (WS13-verify mustFix #1)
//
// The oracle renders `bitfield` two ways: a comma-separated FLAG-NAME
// STRING for the 6,255 spells whose bits are all named (e.g.
// "Resistable, PKSensitive"), and a raw INT for the 11 spells that carry
// an unnamed high bit (the .NET [Flags] ToString falls back to the
// decimal value). A spell whose bitfield is exactly 0 renders as the
// zero-value member name "Undef". This script MUST handle all three
// forms and always emit the raw integer — a string-only parser breaks on
// the 11 int-form spells. (None of the 11, and none of the "Undef"
// spells, carry the 0x4000 FastCast bit, so fastCast is unaffected —
// but we reconstruct the exact int regardless.)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "spell-table-attrs.json");

// external/ACE enum sources (name -> int). Kept in-repo alongside the
// generator; parsed at build time so we track the enums the rest of the
// pipeline cites rather than hardcoding a stale copy.
const ACE_ENUM_DIR = path.join(
  ROOT, "..", "..", "..", "ACE", "Source", "ACE.Entity", "Enum",
);
const PLAYSCRIPT_ENUM = path.join(ACE_ENUM_DIR, "PlayScript.cs");
const SPELLFLAGS_ENUM = path.join(ACE_ENUM_DIR, "SpellFlags.cs");

// WB.Terminal oracle + DAT (override via env for a non-default box).
const WBT_DLL =
  process.env.WBT_DLL ||
  path.resolve(
    ROOT, "..", "..", "..", "..",
    "WorldBuilder.Terminal", "bin", "Release", "net8.0",
    "WorldBuilder.Terminal.dll",
  );
const DAT_PATH =
  process.env.CLIENT_PORTAL_DAT ||
  "/home/wbterminal/ac_base_dats/client_portal.dat";
const SPELL_TABLE_ID = "0x0E00000E";

function parseCsEnum(file) {
  // Extract `Name = <int-or-hex>` pairs from a C# enum body.
  const txt = fs.readFileSync(file, "utf8");
  const map = new Map();
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|\d+)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    map.set(m[1], parseInt(m[2], m[2].startsWith("0x") ? 16 : 10));
  }
  return map;
}

function resolveEffect(v, playScript, ctx) {
  // The oracle emits caster/target effect as a PlayScript enum NAME
  // string ("Invalid", "HealthUpRed", ...). Be defensive: accept a raw
  // number too (in case a future oracle emits the int for an unnamed
  // value).
  if (typeof v === "number") return v >>> 0;
  if (typeof v !== "string") return 0;
  const s = v.trim();
  if (s === "" || s === "Invalid") return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10) >>> 0;
  const val = playScript.get(s);
  if (val === undefined) {
    throw new Error(
      `unresolved PlayScript effect name "${s}" (spell ${ctx}) — ` +
      `add it to PlayScript.cs or teach the build step`,
    );
  }
  return val >>> 0;
}

function resolveBitfield(bf, spellFlags, ctx) {
  // Three oracle forms (see header): raw int, comma-separated flag names,
  // or the zero-value name "Undef".
  if (typeof bf === "number") return bf | 0;
  if (typeof bf !== "string") return 0;
  const s = bf.trim();
  if (s === "" || s === "Undef") return 0;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10) | 0;
  let acc = 0;
  for (const tok of s.split(",")) {
    const name = tok.trim();
    if (name === "" || name === "Undef") continue;
    const val = spellFlags.get(name);
    if (val === undefined) {
      throw new Error(
        `unresolved SpellFlags name "${name}" (spell ${ctx})`,
      );
    }
    acc |= val;
  }
  return acc | 0;
}

function main() {
  for (const p of [PLAYSCRIPT_ENUM, SPELLFLAGS_ENUM, WBT_DLL]) {
    if (!fs.existsSync(p)) {
      console.error(`missing dependency: ${p}`);
      process.exit(1);
    }
  }
  const playScript = parseCsEnum(PLAYSCRIPT_ENUM);
  const spellFlags = parseCsEnum(SPELLFLAGS_ENUM);

  const req = JSON.stringify({
    command: "chorizite-parse-dat-record",
    datPath: DAT_PATH,
    idHex: SPELL_TABLE_ID,
    typeName: "SpellTable",
  });
  console.log(`[build-spell-table-attrs] dumping ${SPELL_TABLE_ID} from ${DAT_PATH} ...`);
  const raw = execSync(
    `DOTNET_ROLL_FORWARD=LatestMajor dotnet ${JSON.stringify(WBT_DLL)} --stdin`,
    { input: req + "\n", maxBuffer: 1 << 30 },
  ).toString("utf8");
  // The oracle can print banner lines; the JSON object is the last line.
  const line = raw.trimEnd().split("\n").pop();
  const doc = JSON.parse(line);
  if (!doc.success || !doc.fields || !doc.fields.spells) {
    console.error("oracle returned no spells");
    console.error(raw.slice(0, 400));
    process.exit(1);
  }

  const spells = doc.fields.spells;
  const attrs = {};
  let fastCastCount = 0;
  const SPELL_FLAGS_FAST_CAST = spellFlags.get("FastCast") || 0x4000;

  const ids = Object.keys(spells).sort((a, b) => (a | 0) - (b | 0));
  for (const sidStr of ids) {
    const s = spells[sidStr];
    if (!s || typeof s !== "object") continue;
    const formula = Array.isArray(s.components)
      ? s.components.map((n) => n | 0).filter((n) => n > 0)
      : [];
    const bitfield = resolveBitfield(s.bitfield, spellFlags, sidStr);
    if ((bitfield & SPELL_FLAGS_FAST_CAST) !== 0) fastCastCount += 1;
    attrs[sidStr] = {
      formula,
      bitfield,
      casterEffect: resolveEffect(s.casterEffect, playScript, sidStr),
      targetEffect: resolveEffect(s.targetEffect, playScript, sidStr),
      formulaVersion: s.formulaVersion | 0,
      school: typeof s.school === "string" ? s.school : null,
    };
  }

  const outDoc = {
    _comment:
      "Generated by `node apps/holtburger-web/scripts/build-spell-table-attrs.cjs`. " +
      "DAT-authoritative per-spell attributes from client_portal.dat SpellTable " +
      "(DID 0x0E00000E), formula DECRYPTED. Source of truth for the cast-sequence " +
      "generator's formula/bitfield/caster+target effects (WS13). bitfield is a raw " +
      "SpellFlags int; caster/target effect are PlayScript ints (0 = Invalid).",
    _source: "client_portal.dat 0x0E00000E (SpellTable, decrypted)",
    _spell_count: ids.length,
    _fast_cast_count: fastCastCount,
    attrs,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(outDoc) + "\n");
  const stat = fs.statSync(OUT_PATH);
  console.log(
    `[build-spell-table-attrs] wrote ${ids.length} spell attrs (${(stat.size / 1024).toFixed(1)} KB) → ${OUT_PATH}`,
  );
  console.log(`  fastCast (0x4000) spells: ${fastCastCount}`);
}

main();
