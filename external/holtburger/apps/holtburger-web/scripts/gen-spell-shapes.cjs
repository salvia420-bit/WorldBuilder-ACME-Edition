#!/usr/bin/env node
// scripts/gen-spell-shapes.cjs
//
// Generates `data/spell-shapes.json` — a SpellId → { school, shape, level }
// lookup the renderer's spell-picker / projectile-spawner consumes to pick
// projectile-spawn patterns by spell shape (Bolt / Arc / Streak / Volley /
// Wall / Ring / Blast / Self). The cast wind-up motion is uniform per
// retail; only the projectile pattern differs by shape.
//
// Wave 5 / Phase 12 of the CMT fixes plan
// (`external/holtburger/docs/cmt-fixes-plan-2026-05-26.md`).
//
// ## Source data
//
// Joins the EXISTING committed catalog
// `apps/holtburger-web/data/spells-catalog.json` (6,266 spells with
// school+level+name+desc, built from LSD-Partial by
// `scripts/build_spells_catalog.py`) with a name + description pattern
// matcher to derive `shape`. We deliberately do NOT re-walk LSD here —
// the catalog already has the school + level fields ACE-correctly
// (school enum matches `ACE.Entity/Enum/MagicSchool.cs`: 1=War, 2=Life,
// 3=Item, 4=Creature, 5=Void) and re-deriving would duplicate work.
//
// ## Shape vocabulary (canonical)
//
// Per the acpedia wiki + Phase 12 brief (cross-ref:
// `docs/acpedia-combat-research-2026-05-26.md` §War Magic + §Void Magic):
//
//   War Magic shapes (6): Arc, Ring, Wall, Bolt, Volley, Blast
//   Void Magic shapes (5): Arc, Ring, Bolt, Streak, Blast
//     (no Wall, no Volley; adds DoT + debuff variants)
//   Streaks are rapid-fire same-projectile per the Slumbering Giant
//   patch — War got streaks too (Acid Streak, Flame Streak, etc.).
//
// The renderer-side superset is 7 projectile shapes:
//   Bolt, Arc, Streak, Volley, Wall, Ring, Blast
// Plus a `Self` bucket for non-projectile spells (buffs / debuffs / DoT /
// heal — these don't spawn a visible projectile pattern; the renderer
// shows the cast wind-up + a target-side effect instead).
//
// ## Classification rules
//
// 1. **Shape from name word** — case-sensitive whole-word match on the
//    spell's `name` field. The word list maps 1:1 to the shape enum.
//    "Bolt" → Bolt, "Arc" → Arc, "Streak" → Streak, "Volley" → Volley,
//    "Wall" → Wall, "Ring" → Ring, "Blast" → Blast.
//
// 2. **Shape from description fallback** — if the name has no shape
//    word, parse the description text for the canonical phrasings the
//    LSD spell-bases use:
//      "Sends a bolt of X streaking towards the target" → Bolt
//      "Shoots a [stream|shock wave|bolt] [at|toward] the target" → Bolt
//      "Shoots [N] [waves|bolts|blades|...] outward from the caster"
//        → Ring (caster-centered AoE; the wiki specifies "8 waves
//        outward" is the ring shape)
//      "Shoots [N] [bolts|...] toward the target" → Volley (multi-
//        projectile fan converging on target)
//      "Rains [N] [bolts|...] down at the area around the target"
//        → Volley (sky-rain volley)
//      "Sends a wall of [N] [balls|blades|...]" → Wall
//    Patterns are case-insensitive; the regex set below is the
//    canonical list from a 691-spell War + 76-spell Void survey of the
//    catalog descriptions (see Phase 12 investigation).
//
// 3. **Self / Buff / Debuff / DoT bucket** — for School 2 (Life), 3
//    (Item), 4 (Creature) spells (which are buffs / debuffs / heals)
//    AND for War / Void spells whose name and desc match none of the
//    shape patterns (typically Void DoTs like Corruption, Corrosion,
//    Festering Curse, Weakening Curse), the shape is `Self` — meaning
//    "no projectile pattern, render the target-effect overlay only".
//    The `untargeted` field on the catalog (derived from
//    `SpellFlags.SelfTargeted = 0x8`) is preserved by leaving the
//    school+level alone; the shape just says "no projectile".
//
// 4. **School from catalog** — `MagicSchool.None=0` entries from LSD
//    are emitted with school=0 and shape=null (the classifier returns
//    null for these; they're typically internal / unfinished spell
//    entries).
//
// ## Output
//
// `data/spell-shapes.json` keyed by SpellId u32 string:
//   { "75": { "school": 1, "shape": "Bolt", "level": 1 }, ... }
// Sorted by numeric SpellId for diff stability. Compact (no whitespace)
// to keep the file small (~150 KB expected for 6,266 entries).
//
// ## Re-run
//
// One-shot. Re-run if the spells catalog regenerates from LSD:
//   node external/holtburger/apps/holtburger-web/scripts/gen-spell-shapes.cjs
//
// Authored 2026-05-26 for CMT fixes Wave 5 Phase 12 (Agent K).

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_PATH = path.resolve(
  __dirname, "..", "data", "spells-catalog.json",
);
const OUT_PATH = path.resolve(
  __dirname, "..", "data", "spell-shapes.json",
);

// MagicSchool enum (ACE) — kept inline so this script has no JS-import
// dependency on the helper. The helper's `SPELL_SCHOOL` export is the
// authoritative copy for runtime consumers.
const SCHOOL = Object.freeze({
  None: 0, War: 1, Life: 2, Item: 3, Creature: 4, Void: 5,
});

// Shape enum (superset) — same caveat: kept inline; the helper's
// `SPELL_SHAPE` export is authoritative.
const SHAPE = Object.freeze({
  Bolt: "Bolt", Arc: "Arc", Streak: "Streak", Volley: "Volley",
  Wall: "Wall", Ring: "Ring", Blast: "Blast", Self: "Self",
});

// Whole-word shape regex — captures the shape names as standalone
// tokens so e.g. "Strangeling" doesn't match Streak's "Streak" via
// substring. `\b` works on ASCII names (all retail spell names are
// ASCII per a catalog grep).
const NAME_SHAPE_WORDS = [
  // Order: more-specific first so e.g. "Streak" doesn't lose to
  // "Strea" anything. All are mutually exclusive whole-word matches so
  // order is incidental, but kept deterministic.
  { re: /\bBolt\b/i,   shape: SHAPE.Bolt },
  { re: /\bArc\b/i,    shape: SHAPE.Arc },
  { re: /\bStreak\b/i, shape: SHAPE.Streak },
  { re: /\bVolley\b/i, shape: SHAPE.Volley },
  { re: /\bWall\b/i,   shape: SHAPE.Wall },
  { re: /\bRing\b/i,   shape: SHAPE.Ring },
  { re: /\bBlast\b/i,  shape: SHAPE.Blast },
];

// Description-pattern fallbacks. The LSD spell descriptions use a
// remarkably stable phrasing across the 691 War + 76 Void spells:
//
//   - "Sends a bolt of X streaking towards the target" → single
//     projectile → Bolt
//   - "Shoots a stream/shock wave of X at the target" → single → Bolt
//   - "Shoots N waves outward from the caster" → caster-centered ring
//     of projectiles → Ring (wiki's "ring" shape is described as
//     "shoots 8 waves outward")
//   - "Shoots a ring of X" → Ring (explicit naming)
//   - "Shoots N waves around the caster" → Ring (variant phrasing)
//   - "Shoots N waves forward from the caster" → directional wave-cone
//     → Wall (closest wiki shape; "wall" is described as "5 balls,
//     2 high, slowly towards the target" in the canonical Wall spells,
//     and "forward wave" is the same gameplay shape)
//   - "Shoots N bolts toward the target" → multi-projectile fan
//     converging on target → Volley
//   - "Rains N bolts down at the area around the target" → sky-rain
//     volley → Volley
//   - "Rains LOTS of …" / "Rains up to N …" → Volley (lazy LSD
//     phrasing variants)
//   - "Sends a wall of N projectiles" → Wall (canonical 5-ball, 2-high
//     advancing wall)
//   - "Sends a line of N projectiles towards the target" → Wall
//     (variant phrasing; same gameplay shape)
//
// Fireworks ("Shoots out a Black Firework", "Shoots a Black Firework
// straight up") deliberately do NOT match — they're emote spells with
// no projectile-vs-target shape; the renderer can treat them as Self
// and play the firework VFX directly.
//
// Patterns are anchored to canonical openers because the LSD desc is
// machine-generated from spell parameters and almost never deviates.
const DESC_PATTERNS = [
  // Wall — must come before Bolt-like patterns; "Sends a wall of …"
  // and "Sends a line of …" both produce the same gameplay shape.
  { re: /^sends a wall of/i,                                 shape: SHAPE.Wall },
  { re: /^sends a line of/i,                                 shape: SHAPE.Wall },
  // Wall (forward wave-cone) — "shoots N waves forward from the caster"
  // / "shoots eight slashing waves forward from the caster". Must come
  // BEFORE the generic "outward from the caster" Ring pattern because
  // "forward" is a more specific match.
  { re: /^shoots (\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)[^.]*forward from the caster/i,
    shape: SHAPE.Wall },
  // Volley sky-rain — "Rains 9 bolts down" / "Rains up to 12 balls" /
  // "Rains LOTS of boulders"
  { re: /^rains (up to |lots? of |\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)/i,
    shape: SHAPE.Volley },
  // Ring (explicit) — "Shoots a ring of X out from the caster"
  { re: /^shoots a ring of/i,                                shape: SHAPE.Ring },
  // Ring caster-centered AoE — "shoots N waves outward from the caster"
  // / "shoots N waves around the caster"
  { re: /^shoots (\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)[^.]*(outward|around) (from )?the caster/i,
    shape: SHAPE.Ring },
  // Volley target-direction multi — REQUIRES a numeric count word
  // (≥2) because "shoots a bolt at the target" is a single-projectile
  // Bolt, not a Volley. Count words: "\d+" (digit, treated as ≥2
  // safely; the LSD data uses 3/4/5/6/8/9/12), "two".."twelve",
  // "fifteen", "twenty".
  { re: /^shoots (\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)[^.]*(toward|at) (the )?target/i,
    shape: SHAPE.Volley },
  // Bolt single-projectile — "Sends a bolt of …" / "Sends a … streaking
  // towards the target" / "Shoots a [stream|shock wave|bolt|magical
  // blade|cloud|cow|table|present] at the target". `Shoots a/an X at
  // target` is unambiguously single-projectile because Volley above
  // requires a count word ≥ 2.
  { re: /^sends a [^.]*streaking towards/i,                  shape: SHAPE.Bolt },
  { re: /^shoots an? [^.]*(at|toward) (your |the )?target/i, shape: SHAPE.Bolt },
];

const ROMAN_RE = /\s(VIII|VII|VI|IV|V|III|II|I)\s*$/;
const ROMAN_TO_LEVEL = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };

function levelFromName(name) {
  const m = (name || "").match(ROMAN_RE);
  return m ? (ROMAN_TO_LEVEL[m[1]] || 1) : 1;
}

function classifyShape(name, desc, school) {
  // Non-War/Void spells default to Self shape — they're enchantments,
  // heals, debuffs that don't spawn a projectile pattern. The renderer
  // can pick a generic target-overlay VFX for these without consulting
  // the shape (cast wind-up motion is the same regardless).
  if (school !== SCHOOL.War && school !== SCHOOL.Void) {
    return SHAPE.Self;
  }
  // 1) Whole-word name match (Bolt / Arc / Streak / Volley / Wall /
  //    Ring / Blast).
  for (const { re, shape } of NAME_SHAPE_WORDS) {
    if (re.test(name || "")) return shape;
  }
  // 2) Description-pattern fallback for spells with non-shape display
  //    names (Whirling Blade, Acid Stream, Shock Wave, Firestorm,
  //    Cassius' Ring of Fire, etc.).
  const d = (desc || "").trim();
  if (d) {
    for (const { re, shape } of DESC_PATTERNS) {
      if (re.test(d)) return shape;
    }
  }
  // 3) Fall-through for War/Void spells with no shape word and no
  //    matching desc pattern → Self (DoTs, debuffs, "kills the target",
  //    creature-magic-only filler spells, etc.).
  return SHAPE.Self;
}

function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error("missing catalog:", CATALOG_PATH);
    console.error("regenerate with: python3 external/holtburger/scripts/build_spells_catalog.py");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  const spells = doc.spells;
  if (!spells || typeof spells !== "object") {
    console.error("catalog has no spells map");
    process.exit(1);
  }

  const out = {};
  const buckets = new Map(); // (school, shape) → count
  let totalEmitted = 0;

  for (const sid of Object.keys(spells)) {
    const sp = spells[sid];
    if (!sp || typeof sp !== "object") continue;
    const school = (sp.school | 0);
    // Re-derive level from name in case the catalog upstream changed
    // its mapping; cheap and keeps this generator self-contained.
    const level = sp.level || levelFromName(sp.name);
    const shape = classifyShape(sp.name || "", sp.desc || "", school);

    out[sid] = { school, shape, level };
    const bucketKey = `${school}/${shape}`;
    buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);
    totalEmitted += 1;
  }

  // Sort by numeric SpellId for diff stability.
  const sorted = {};
  for (const k of Object.keys(out).sort((a, b) => (a | 0) - (b | 0))) {
    sorted[k] = out[k];
  }

  // Compact JSON keeps the file under 200 KB for 6,266 spells.
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted) + "\n");

  const stat = fs.statSync(OUT_PATH);
  console.log(`[gen-spell-shapes] wrote ${totalEmitted} entries (${(stat.size / 1024).toFixed(1)} KB) → ${OUT_PATH}`);
  console.log("[gen-spell-shapes] per-(school, shape) buckets:");
  const schoolName = ["None", "War", "Life", "Item", "Creature", "Void"];
  const keysSorted = [...buckets.keys()].sort();
  for (const k of keysSorted) {
    const [sId, shape] = k.split("/");
    const sName = schoolName[sId | 0] ?? sId;
    console.log(`  ${sName.padEnd(9)} ${shape.padEnd(8)} ${buckets.get(k)}`);
  }
}

main();
