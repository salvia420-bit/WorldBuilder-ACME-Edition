#!/usr/bin/env node
// scripts/gen-spell-cast-sequence.cjs
//
// Generates `data/spell-cast-sequence.json` — a SpellId → { school, shape,
// level, fastCast, windupGestures[], castGesture, totalDurationS } lookup
// the cast-pose runtime consumes to drive the local-player magic-cast
// animation. Wave 14 / Phase 44 (foundation work for the cast-pose code
// at Phase 45).
//
// ## Cast-sequence algorithm
//
// Per ACE.Server `SpellFormula.cs:245-287` + `Player_Magic.cs:605-689`:
//
//   for each scarab in spell.formula:
//     play scarab.gesture (Magic stance)             # windup
//   play talisman.gesture (Magic stance)             # cast
//
// Two short-circuit cases:
//
//   1. `SpellFlags.FastCast` (0x4000) set → skip windup entirely; only
//      the cast gesture plays. Player_Magic.cs:607-608.
//   2. `HasWindupGestures => Scarabs.Any(i => i != Lead)` —
//      SpellFormula.cs:265. If the ONLY scarab in the formula is Lead
//      (id=1), there's no windup. Retail encodes this by giving Lead
//      Scarab a `MotionCommand.Invalid` (0x80000000) Gesture in the
//      SpellComponentsTable — the cast pipeline silently skips Invalid
//      motions. (Lead is the only such scarab; Iron..Mana all carry a
//      MagicPowerUp0N gesture.)
//
// ## Sources joined
//
//   * `data/spells-catalog.json` — per-spell `name`, `school`, `level`,
//     `components: ["Comp_N", ...]` (formula component IDs, zero-stripped).
//     Built by `scripts/build_spells_catalog.py` from LSD.
//   * `data/spell-components.json` — per-component-id `gesture` + `type`
//     + `gestureName` + `time`. Built by
//     `cargo run -p holtburger-dat --example dump_spell_components` from
//     the retail `client_portal.dat` SpellComponentsTable (DID 0x0E00000F).
//   * `data/spell-shapes.json` — per-spell `shape` (Bolt/Arc/Streak/...).
//     Built by `gen-spell-shapes.cjs`. Joined here for downstream
//     convenience (the cast-pose runtime + shape-preview overlay both
//     consume both joins; emitting once saves a fetch).
//   * `data/spell-table-attrs.json` — per-spell DECRYPTED `formula`,
//     `bitfield` (= SpellFlags), `casterEffect`/`targetEffect`
//     (PlayScript ints), `formulaVersion`. Built by
//     `scripts/build-spell-table-attrs.cjs` straight from the retail
//     `client_portal.dat` SpellTable (DID 0x0E00000E) — the SAME record
//     the client loads. This is the source of truth for gesture-identity
//     data (WS13). It REPLACES the old LSD `spells.json` source, which
//     was 6,264/6,266 correct but silently corrupt on a few rows
//     (high-word/formula_version leak on 4024, mis-decoded comps on
//     4904, stale targetEffect on 5174). The catalog's `components`
//     field is no longer used for the formula.
//
// ## Output schema
//
// ```json
// {
//   "_comment": "...",
//   "_source_files": ["..."],
//   "_spell_count": 6266,
//   "_fast_cast_count": <N>,
//   "_lead_only_count": <N>,
//   "sequences": {
//     "75": {
//       "school": 1, "shape": "Bolt", "level": 1,
//       "fastCast": false, "leadOnly": true,
//       "windupGestures": [],
//       "castGesture": { "motion": "0x40000031", "name": "MagicHeal", "durationS": 0.0 },
//       "totalDurationS": 0.0,
//       "casterEffect": 0,
//       "targetEffect": 31,
//       "formulaScale": 0.05
//     }
//   }
// }
// ```
//
// `windupGestures` is empty for FastCast spells OR for Lead-only spells.
// `castGesture` is null only when the spell's last component isn't in
// the spell-components table (which shouldn't happen for retail data
// but we guard for it).
//
// ## Wave 18 / Phase 52 fields
//
// - `casterEffect` (u32, default 0) — `SpellBase.CasterEffect` from
//   `ACE.DatLoader/Entity/SpellBase.cs:36`. PlayScript enum value
//   (NOT a 0x33xxxxxx PhysicsScript DID) that the cast pipeline
//   resolves to a real script via the CASTER entity's
//   PhysicsScriptTable lookup (Wave 17 path).
// - `targetEffect` (u32, default 0) — `SpellBase.TargetEffect`
//   (`SpellBase.cs:37`). Plays on the TARGET on hit (out-of-scope
//   wiring for Wave 18 — needs damageDealt→spellId attribution).
// - `formulaScale` (f32, 0.05..=1.0) — `Spell.Formula.Scale` from
//   `ACE.Server/Entity/SpellFormula.cs:313` — derived from the FIRST
//   scarab in the formula via the `ScarabScale` map at
//   `SpellFormula.cs:293-305`: Lead=0.05, Iron=0.2, Copper=0.4,
//   Silver=0.5, Gold=0.6, Pyreal/Diamond/Platinum/Dark/Mana=1.0.
//   Used as the `mod` value when picking from a PhysicsScriptTable
//   (`acclient.c:336552 PhysicsScriptTableData::GetScript`).
//   Defaults to 1.0 if the formula has no scarab (shouldn't happen
//   on retail data; defensive guard).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_PATH = path.join(ROOT, "data", "spells-catalog.json");
const COMPONENTS_PATH = path.join(ROOT, "data", "spell-components.json");
const SHAPES_PATH = path.join(ROOT, "data", "spell-shapes.json");
const DAT_ATTRS_PATH = path.join(ROOT, "data", "spell-table-attrs.json");
const OUT_PATH = path.join(ROOT, "data", "spell-cast-sequence.json");

// ACE SpellFlags (`ACE.Entity/Enum/SpellFlags.cs`).
const SPELL_FLAGS_FAST_CAST = 0x4000;

// WS13 Patch B (OPTIONAL, default OFF) — emit MotionCommand.Ready
// (0x40000003) as the cast gesture for the 10 no-talisman AoE spells
// (Exploding/Ring/Acid series), matching ACE Player_Magic.DoCastGesture
// Invalid→Ready (Player_Magic.cs:678-679). Kept OFF (regenerate off by
// default) until the batched 1070 eye-test confirms 0x40000003 renders
// in the overlay classifier rather than being a no-op (see
// docs/url-flags.md `castReadyFallback` / packet §2.4/§5). Set the
// GEN_CAST_READY_FALLBACK=1 env var to regenerate with it ON.
const EMIT_READY_FALLBACK = process.env.GEN_CAST_READY_FALLBACK === "1";

// MotionCommand.Invalid — the canonical no-op encoded into Lead Scarab's
// Gesture field in the retail SpellComponentsTable. Cast-pipeline must
// skip windups whose gesture equals this.
const MOTION_INVALID = "0x80000000";

// Scarab component ID (ACE `SpellFormula.cs:15-27 Scarab enum`):
//   Lead=1, Iron=2, Copper=3, Silver=4, Gold=5, Pyreal=6,
//   Diamond=110, Platinum=112, Dark=192, Mana=193.
// We don't hardcode the set — we detect scarab-ness via the
// spell-components table's Type field (Scarab=1).
const TYPE_SCARAB = 1;
const TYPE_TALISMAN = 5;

// ACE `SpellFormula.cs:293-305 ScarabScale` — scarab component ID to
// the f32 "scale" used as the picker `mod` weight when resolving a
// CasterEffect / TargetEffect through a PhysicsScriptTable.
//
// Keys are SpellComponentsTable IDs (== `Scarab` enum value), values
// are the f32 scale from the ACE table verbatim. Lead = 0.05 (lowest
// power, finest visual); Pyreal+ = 1.0 (full scale).
const SCARAB_SCALE = {
  1: 0.05,   // Lead
  2: 0.2,    // Iron
  3: 0.4,    // Copper
  4: 0.5,    // Silver
  5: 0.6,    // Gold
  6: 1.0,    // Pyreal
  110: 1.0,  // Diamond
  112: 1.0,  // Platinum
  192: 1.0,  // Dark
  193: 1.0,  // Mana
};
// Default scale when the formula has no scarab in our table — 1.0
// matches the GameMessageScript constructor default at
// `ACE.Server/Network/GameMessages/Messages/GameMessageScript.cs:8`.
const DEFAULT_FORMULA_SCALE = 1.0;

function loadJson(p) {
  if (!fs.existsSync(p)) {
    console.error(`missing source: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  const catalog = loadJson(CATALOG_PATH);
  const comps = loadJson(COMPONENTS_PATH);
  const shapes = loadJson(SHAPES_PATH);
  // DAT-authoritative attrs (formula/bitfield/effects), keyed by spell id
  // string. This is `client_portal.dat` 0x0E00000E, decrypted — the
  // source of truth (WS13). See build-spell-table-attrs.cjs.
  const datAttrs = loadJson(DAT_ATTRS_PATH).attrs;
  if (!datAttrs || typeof datAttrs !== "object") {
    console.error("spell-table-attrs has no attrs map");
    process.exit(1);
  }
  // WS13 §A3 — surface any spell whose formula can't be fully resolved
  // (would have caught the corrupt LSD rows 4024/4904 at generation
  // time) or whose formula legitimately has no talisman terminal (the
  // ACE Invalid→Ready cast-gesture gap, §2.4). Emitted as _data_warnings.
  const dataWarnings = [];

  if (!catalog.spells || typeof catalog.spells !== "object") {
    console.error("catalog has no spells map");
    process.exit(1);
  }
  if (!comps.components || typeof comps.components !== "object") {
    console.error("spell-components has no components map");
    process.exit(1);
  }

  // Build a lookup of componentId → component info.
  const compById = {};
  for (const idStr of Object.keys(comps.components)) {
    compById[idStr | 0] = comps.components[idStr];
  }

  const out = {};
  let fastCastCount = 0;
  let leadOnlyCount = 0;
  let missingCompCount = 0;
  let missingShapeCount = 0;

  const spellIds = Object.keys(catalog.spells).sort((a, b) => (a | 0) - (b | 0));
  for (const sidStr of spellIds) {
    const sid = sidStr | 0;
    const sp = catalog.spells[sidStr];
    if (!sp || typeof sp !== "object") continue;

    const attrs = datAttrs[sidStr] || null;
    if (!attrs) {
      dataWarnings.push({ spell: sid, reason: "no-dat-attrs" });
    }
    // DAT decrypted formula is the source of truth (WS13). Mask to
    // low-16 defensively (belt-and-suspenders against any high-word /
    // formula_version leak like the old LSD spell 4024); drop any zero
    // slot. The DAT source is already clean, so the mask is a no-op on
    // real data.
    const componentIds = attrs
      ? attrs.formula.map((n) => n & 0xffff).filter((n) => n > 0)
      : [];
    const bitfield = attrs ? (attrs.bitfield | 0) : 0;
    const fastCast = (bitfield & SPELL_FLAGS_FAST_CAST) !== 0;
    // Wave 18 — caster/target effect (PlayScript enum values). 0 = no
    // effect, do not fire the resolver chain on the caster/target.
    const casterEffect = attrs ? (attrs.casterEffect >>> 0) : 0;
    const targetEffect = attrs ? (attrs.targetEffect >>> 0) : 0;
    // formulaScale — derived from the FIRST scarab in the spell's
    // formula via ACE's ScarabScale map (`SpellFormula.cs:293-313`). We
    // walk the DECODED DAT formula (componentIds, in order) looking for
    // the first SpellComponentsTable entry whose Type == Scarab (1) and
    // grab the matching ScarabScale value.
    let formulaScale = DEFAULT_FORMULA_SCALE;
    for (const compId of componentIds) {
      if ((compId | 0) === 0) continue;
      const c = compById[compId | 0];
      if (c && c.type === TYPE_SCARAB) {
        const scale = SCARAB_SCALE[compId | 0];
        if (typeof scale === "number") {
          formulaScale = scale;
        }
        // First scarab wins per ACE `FirstScarab => Scarabs.First()`.
        break;
      }
    }

    // Find scarabs + talisman in formula order.
    const scarabs = [];
    let talisman = null;
    const unresolvedIds = [];
    for (const cid of componentIds) {
      const c = compById[cid];
      if (!c) {
        // Component not in our table. With the DAT-authoritative source
        // this should never happen for retail data — surface it loudly
        // (WS13 §A3: this check would have caught the corrupt LSD rows
        // 4024/4904 that leaked bogus component ids).
        missingCompCount += 1;
        unresolvedIds.push(cid);
        continue;
      }
      if (c.type === TYPE_SCARAB) {
        scarabs.push({ id: cid, comp: c });
      } else if (c.type === TYPE_TALISMAN) {
        // Last talisman wins (ACE: "assumed to be the last spell component").
        talisman = { id: cid, comp: c };
      }
    }
    if (unresolvedIds.length > 0) {
      dataWarnings.push({
        spell: sid,
        reason: "unresolved-components",
        ids: unresolvedIds,
      });
    }

    // leadOnly: only-scarab in formula is Lead (id=1).
    const leadOnly =
      scarabs.length > 0 && scarabs.every((s) => s.id === 1);
    if (leadOnly) leadOnlyCount += 1;
    if (fastCast) fastCastCount += 1;

    // Compose windupGestures. Skip Lead's Invalid gesture + skip
    // entirely if FastCast or leadOnly. We emit empty array, not null,
    // so consumers can `for ... of` without a guard.
    let windupGestures = [];
    if (!fastCast && !leadOnly) {
      for (const s of scarabs) {
        if (s.comp.gesture === MOTION_INVALID) continue;
        windupGestures.push({
          motion: s.comp.gesture,
          name: s.comp.gestureName || null,
          durationS: s.comp.time || 0,
        });
      }
    }

    // castGesture — ACE `CastGesture => PlayerFormula.Last()` is a
    // talisman only when the formula's LAST component is a talisman
    // (SpellFormula.cs:271-287). Our detection keeps the last talisman
    // seen; guard that it's actually the terminal component so we match
    // ACE's `.Last()` exactly.
    const lastCompId = componentIds.length
      ? componentIds[componentIds.length - 1]
      : 0;
    const lastComp = compById[lastCompId];
    const lastIsTalisman = !!(lastComp && lastComp.type === TYPE_TALISMAN);
    let castGesture = null;
    if (talisman && lastIsTalisman) {
      castGesture = {
        motion: talisman.comp.gesture,
        name: talisman.comp.gestureName || null,
        durationS: talisman.comp.time || 0,
      };
    } else if (EMIT_READY_FALLBACK && componentIds.length && !fastCast) {
      // WS13 §2.4 / Patch B — ACE Player_Magic.DoCastGesture: when
      // CastGesture resolves to Invalid (no talisman terminal), ACE
      // substitutes MotionCommand.Ready (0x40000003) as the cast beat
      // (Player_Magic.cs:678-679). Gated OFF by default (see the
      // EMIT_READY_FALLBACK constant / castReadyFallback flag) until an
      // eye-test confirms 0x40000003 actually renders in the overlay
      // model. durationS is left 0 → WS11 sources the real Ready anim
      // length from the Magic-stance MotionTable.
      castGesture = { motion: "0x40000003", name: "Ready", durationS: 0 };
    }
    // §2.4 fidelity note — non-fast formula that ends in a non-talisman
    // (Potion/Taper) → ACE substitutes Ready as the cast beat (Patch B).
    // Surfaced for coordination; not a corruption. leadOnly is NOT
    // excluded: it only suppresses the WINDUP, so a lead-only no-talisman
    // spell (e.g. 1781/2976) still hits the ACE Invalid→Ready cast path.
    if (!lastIsTalisman && !fastCast && componentIds.length) {
      dataWarnings.push({
        spell: sid,
        reason: "no-talisman-terminal",
        lastComponent: lastCompId,
      });
    }

    const totalDurationS =
      windupGestures.reduce((sum, g) => sum + (g.durationS || 0), 0) +
      (castGesture ? (castGesture.durationS || 0) : 0);

    const shapeEntry = shapes[sidStr];
    if (!shapeEntry) missingShapeCount += 1;

    out[sidStr] = {
      school: sp.school | 0,
      shape: shapeEntry ? shapeEntry.shape : "Self",
      level: (shapeEntry ? shapeEntry.level : sp.level) | 0,
      fastCast,
      leadOnly,
      windupGestures,
      castGesture,
      totalDurationS: Number(totalDurationS.toFixed(4)),
      // Wave 18 / Phase 52 — caster/target effect + formula scale.
      casterEffect,
      targetEffect,
      formulaScale: Number(formulaScale.toFixed(4)),
    };
  }

  // Wave 18 stats — non-zero caster/target effect counts for diag.
  let casterEffectCount = 0;
  let targetEffectCount = 0;
  for (const sidStr of Object.keys(out)) {
    const e = out[sidStr];
    if ((e.casterEffect | 0) !== 0) casterEffectCount += 1;
    if ((e.targetEffect | 0) !== 0) targetEffectCount += 1;
  }

  const doc = {
    _comment:
      "Generated by `node apps/holtburger-web/scripts/gen-spell-cast-sequence.cjs`. " +
      "Sources: spells-catalog.json (school/level/shape) + spell-components.json + " +
      "spell-shapes.json + spell-table-attrs.json (DAT-AUTHORITATIVE formula / SpellFlags " +
      "bitfield / caster+target effects, decrypted from client_portal.dat 0x0E00000E — WS13). " +
      "Algorithm per ACE.Server SpellFormula.cs:245-287 + Player_Magic.cs:605-689: " +
      "for each scarab in formula, play scarab.gesture (Magic stance); then play " +
      "talisman.gesture (Magic stance). Edge cases: " +
      "(a) SpellFlags.FastCast (0x4000) → empty windupGestures; " +
      "(b) Lead-only scarab formulas (HasWindupGestures Lead exemption) → empty windupGestures. " +
      "Both encoded by the retail DAT giving Lead Scarab MotionCommand.Invalid (0x80000000); " +
      "we additionally short-circuit on leadOnly so the consumer can branch on fastCast vs leadOnly. " +
      "Wave 18 fields: casterEffect/targetEffect (PlayScript enum from ACE.DatLoader/Entity/SpellBase.cs:36-37), " +
      "formulaScale (Spell.Formula.Scale from ACE.Server/Entity/SpellFormula.cs:313 — first scarab's " +
      "ScarabScale value, used as picker mod for the PhysicsScriptTable lookup).",
    _source_files: [
      "data/spells-catalog.json",
      "data/spell-components.json",
      "data/spell-shapes.json",
      "data/spell-table-attrs.json",
    ],
    _spell_count: spellIds.length,
    _fast_cast_count: fastCastCount,
    _lead_only_count: leadOnlyCount,
    _missing_component_lookups: missingCompCount,
    _missing_shape_lookups: missingShapeCount,
    _data_warnings: dataWarnings,
    _caster_effect_count: casterEffectCount,
    _target_effect_count: targetEffectCount,
    sequences: out,
  };

  // Compact JSON (consumer reads with JSON.parse, no need for pretty).
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(doc) + "\n");

  const stat = fs.statSync(OUT_PATH);
  console.log(
    `[gen-spell-cast-sequence] wrote ${spellIds.length} sequences (${(stat.size / 1024).toFixed(1)} KB) → ${OUT_PATH}`,
  );
  console.log(`  fastCast spells: ${fastCastCount}`);
  console.log(`  leadOnly spells: ${leadOnlyCount}`);
  console.log(`  missing-component lookups: ${missingCompCount}`);
  console.log(`  missing-shape lookups: ${missingShapeCount}`);
  console.log(`  spells with non-zero casterEffect: ${casterEffectCount}`);
  console.log(`  spells with non-zero targetEffect: ${targetEffectCount}`);

  // Spot-check the audit-doc edge cases.
  const samples = [
    ["75", "Lightning Bolt I"],
    ["5345", "Nether Streak V"],
    ["1", "Strength Other I"],
    ["6", "Heal Self I"],
  ];
  console.log("\n  Spot-checks:");
  for (const [sid, label] of samples) {
    const e = out[sid];
    if (!e) {
      console.log(`    ${sid} (${label}): MISSING`);
      continue;
    }
    const wu = e.windupGestures.map((g) => g.name).join(",") || "(none)";
    const cg = e.castGesture ? e.castGesture.name : "(none)";
    console.log(
      `    ${sid} (${label}): fastCast=${e.fastCast} leadOnly=${e.leadOnly} windup=[${wu}] cast=${cg} ` +
      `casterEffect=0x${e.casterEffect.toString(16)} targetEffect=0x${e.targetEffect.toString(16)} ` +
      `formulaScale=${e.formulaScale}`,
    );
  }
}

main();
