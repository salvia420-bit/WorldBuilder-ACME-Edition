// Level-8 cast gesture chain — "it should raise its arms twice" (2026-08-01).
//
// Owner report: "In mage combat, when casting a level 8 spell, it should raise
// its arms twice."
//
// ## Ground truth for what "twice" means
//
// A player cast is TWO gesture layers, and only the first is level-dependent:
//
//   1. WINDUP gestures — one per SCARAB component of the spell's formula.
//      ACE `SpellFormula.WindupGestures` (Entity/SpellFormula.cs:245-263) maps
//      each scarab through the portal.dat SpellComponentTable (0x0E00000F)
//      `SpellComponentBase.Gesture` field. Lead Scarab's gesture is
//      `0x80000000` (Invalid), and `HasWindupGestures => Scarabs.Any(i =>
//      i != Scarab.Lead)` (:265), so a level-1 Lead spell has NO windup.
//      The COUNT is `count(scarabs)`, never the level; the LEVEL picks WHICH
//      MagicPowerUp anim (ScarabLevel table, SpellFormula.cs:40-52).
//   2. The CAST gesture — the talisman's gesture (`CastGesture =>
//      PlayerFormula.Last()`), played once.
//
// So a level-8 (Mana / Dark / Platinum scarab) spell = 1 windup
// (MagicPowerUp08Purple 0x10000132) + 1 cast gesture = TWO arm-raise gestures,
// whereas a level-1 Lead spell = 0 windups + 1 cast gesture = ONE. That is
// exactly the level dependence the owner describes.
//
// Cross-checked against the REAL retail DAT (WorldBuilder.Terminal
// `chorizite-parse-dat-record` on ~/ac_base_dats/client_portal.dat, player
// MotionTable 0x09000001): `links[(Magic 0x49, Ready 0x0003)][0x10000132]`
// carries TWO AnimData — anim 0x3000848 frames 0..60 at +24 fps, then the SAME
// anim at -51 fps (negative framerate = reverse playback). 60/24 + 60/51 =
// 3.676 s, matching the Platinum/Mana component `_time` below. So the windup
// itself is raise-then-lower, and the cast gesture is the second raise.
//
// ## What this test pins (all node-provable, no browser)
//
//   PART 1 — the generated chain data (`data/spell-cast-sequence.json`) still
//            produces 2 gestures for level-8 war Incantations and 1 for
//            level-1 Lead spells.
//   PART 2 — windup count == scarab count, and each windup's motion id is
//            EXACTLY the scarab's DAT `Gesture` (the ACE rule), for every
//            non-FastCast non-Lead-only spell.
//   PART 3 — the scarab-level -> MagicPowerUp mapping is intact, including the
//            level-8 Purple variant and its 3.676 s authored length.
//   PART 4 — ROUTING: the level-8 windup command survives the renderer's
//            classifier. `MotionItem` truncates commands to the low 16 bits on
//            the wire (ACE MotionItem.cs:16-19), so 0x10000132 arrives as
//            0x0132; `classifyMotionCommand` must bucket it "cast" and
//            `expandActionCommandLow16` must re-prefix it to 0x10000132 or the
//            MotionTable link lookup misses and the arms never rise.
//
// Run:  cd apps/holtburger-web/ && node test_cast_level8_windup.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const readJson = (p) => JSON.parse(readFileSync(joinPath(__dirname, p), "utf8"));
const sequences = readJson("data/spell-cast-sequence.json").sequences;
const components = readJson("data/spell-components.json").components;
const catalog = readJson("data/spells-catalog.json").spells;

const TYPE_SCARAB = 1;
const MOTION_INVALID = "0x80000000";
// ACE SpellFormula.cs:40-52 ScarabLevel (component id -> spell level).
const SCARAB_LEVEL = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 110: 7, 112: 7, 192: 8, 193: 8,
};

const catalogEntries = Array.isArray(catalog)
  ? catalog.map((s) => [String(s.id), s])
  : Object.entries(catalog);

const componentIdsOf = (s) =>
  (s.components ?? []).map((c) => Number(String(c).split("_")[1])).filter(Number.isFinite);
const scarabsOf = (s) =>
  componentIdsOf(s).filter((id) => components[String(id)]?.type === TYPE_SCARAB);

console.log("===========================================================");
console.log("Level-8 cast gesture chain — windup + cast = two arm raises");
console.log("===========================================================");

// ---------------------------------------------------------------------
// PART 1 — the shipped chain data.
// ---------------------------------------------------------------------
console.log("\nPART 1 — gesture count by scarab level");
{
  const gestureCount = (seq) =>
    (seq.windupGestures?.length ?? 0) + (seq.castGesture ? 1 : 0);

  // A representative level-8 War Incantation the owner would cast in mage
  // combat. 4439 = "Incantation of Flame Bolt" (Mana scarab).
  const L8 = sequences["4439"];
  check("level-8 war Incantation (4439) is present in the chain data", !!L8);
  check(
    "level-8 spell plays TWO gestures (1 windup + 1 cast)",
    gestureCount(L8) === 2,
    `windups=${L8?.windupGestures?.length} cast=${!!L8?.castGesture}`,
  );
  check(
    "its windup is MagicPowerUp08Purple (0x10000132)",
    (L8?.windupGestures?.[0]?.motion ?? "").toLowerCase() === "0x10000132",
    String(L8?.windupGestures?.[0]?.motion),
  );
  check(
    "its cast gesture is a DIFFERENT command from the windup",
    (L8?.castGesture?.motion ?? "").toLowerCase() !==
      (L8?.windupGestures?.[0]?.motion ?? "").toLowerCase(),
    `${L8?.windupGestures?.[0]?.name} vs ${L8?.castGesture?.name}`,
  );
  check(
    "not FastCast / not Lead-only (both would erase the windup)",
    L8?.fastCast === false && L8?.leadOnly === false,
  );

  // 75 = "Lightning Bolt I" (Lead scarab) — the level-1 contrast case.
  const L1 = sequences["75"];
  check(
    "level-1 Lead spell (75) plays ONE gesture (Lead's gesture is Invalid)",
    gestureCount(L1) === 1 && (L1?.windupGestures?.length ?? 0) === 0,
    `windups=${L1?.windupGestures?.length}`,
  );

  // Population check across every level-8 War Incantation.
  let l8Total = 0;
  let l8TwoGestures = 0;
  const l8Outliers = [];
  for (const [sid, s] of catalogEntries) {
    if (!/^Incantation of /.test(String(s.name ?? ""))) continue;
    const scar = scarabsOf(s);
    if (scar.length !== 1 || SCARAB_LEVEL[scar[0]] !== 8) continue;
    const seq = sequences[sid];
    if (!seq || seq.fastCast) continue; // FastCast (Streak) spells skip windup by design
    l8Total += 1;
    if (gestureCount(seq) === 2) l8TwoGestures += 1;
    else if (l8Outliers.length < 5) l8Outliers.push(`${sid} ${s.name} n=${gestureCount(seq)}`);
  }
  check(
    "EVERY non-FastCast single-scarab level-8 Incantation plays exactly 2 gestures",
    l8Total > 0 && l8TwoGestures === l8Total,
    `${l8TwoGestures}/${l8Total}${l8Outliers.length ? " outliers: " + l8Outliers.join("; ") : ""}`,
  );
}

// ---------------------------------------------------------------------
// PART 2 — windup list == scarab list (the ACE rule), across all spells.
// ---------------------------------------------------------------------
console.log("\nPART 2 — windup list mirrors SpellFormula.WindupGestures");
{
  let checked = 0;
  const countMismatch = [];
  const gestureMismatch = [];
  for (const [sid, s] of catalogEntries) {
    const seq = sequences[sid];
    if (!seq) continue;
    const scar = scarabsOf(s);
    if (scar.length === 0) continue;
    if (seq.fastCast || seq.leadOnly) continue; // both legitimately erase the list
    // ACE skips Lead's Invalid gesture; the generator mirrors that.
    const expected = scar
      .map((id) => components[String(id)]?.gesture)
      .filter((g) => g && g !== MOTION_INVALID);
    const actual = (seq.windupGestures ?? []).map((g) => String(g.motion));
    checked += 1;
    if (actual.length !== expected.length) {
      if (countMismatch.length < 5) countMismatch.push(`${sid} ${s.name}: ${actual.length} vs ${expected.length}`);
      continue;
    }
    for (let i = 0; i < expected.length; i++) {
      if (String(actual[i]).toLowerCase() !== String(expected[i]).toLowerCase()) {
        if (gestureMismatch.length < 5) gestureMismatch.push(`${sid} ${s.name}[${i}]: ${actual[i]} vs ${expected[i]}`);
        break;
      }
    }
  }
  check("spells cross-checked", checked > 1000, `checked=${checked}`);
  check(
    "windup COUNT == scarab count for every checked spell",
    countMismatch.length === 0,
    countMismatch.join(" | "),
  );
  check(
    "each windup motion == that scarab's DAT Gesture",
    gestureMismatch.length === 0,
    gestureMismatch.join(" | "),
  );
}

// ---------------------------------------------------------------------
// PART 3 — the scarab-level -> MagicPowerUp mapping.
// ---------------------------------------------------------------------
console.log("\nPART 3 — scarab level picks WHICH MagicPowerUp anim");
{
  const expectations = [
    [1, "Lead Scarab", "0x80000000", "Invalid"],
    [2, "Iron Scarab", "0x10000070", "MagicPowerUp02"],
    [6, "Pyreal Scarab", "0x10000078", "MagicPowerUp10"],
    [112, "Platinum Scarab", "0x10000132", "MagicPowerUp08Purple"],
    [193, "Mana Scarab", "0x10000132", "MagicPowerUp08Purple"],
  ];
  for (const [id, name, gesture, gestureName] of expectations) {
    const c = components[String(id)];
    check(
      `scarab ${id} (${name}) -> ${gestureName}`,
      c && c.name === name && String(c.gesture).toLowerCase() === gesture &&
        c.gestureName === gestureName,
      c ? `${c.name} ${c.gesture} ${c.gestureName}` : "missing",
    );
  }
  // The DAT link for 0x10000132 is anim 0x3000848 frames 0..60 @ +24 fps then
  // the same anim @ -51 fps (reverse): 60/24 + 60/51 = 3.676 s. The component
  // `_time` must match, or the chain's per-gesture sleep desyncs from the clip.
  const mana = components["193"];
  check(
    "level-8 windup authored length ~= 3.676 s (matches the DAT link's two segments)",
    Math.abs((mana?.time ?? 0) - 3.6764705) < 1e-4,
    String(mana?.time),
  );
  check(
    "level-8 windup durationS in the chain data matches the component time",
    Math.abs((sequences["4439"]?.windupGestures?.[0]?.durationS ?? 0) - (mana?.time ?? -1)) < 1e-4,
    String(sequences["4439"]?.windupGestures?.[0]?.durationS),
  );
}

// ---------------------------------------------------------------------
// PART 4 — routing: the windup command must reach the link overlay.
// ---------------------------------------------------------------------
console.log("\nPART 4 — renderer routing for the level-8 windup command");
{
  function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
    try { return require.resolve("three"); } catch (_) { return null; }
  }
  const threePath = locateThree();
  if (!threePath) {
    console.log("  [SKIP] classifier routing (three not located)");
  } else {
    const threeMod = await import("file://" + threePath);
    const THREE = threeMod.Object3D ? threeMod : (threeMod.default ?? threeMod);

    function loadModule(relPath) {
      return readFileSync(resolvePath(__dirname, relPath), "utf8")
        .replace(/^[ \t]*import\s[\s\S]*?from\s+["'][^"']+["'];.*$/gm, "")
        .replace(/^[ \t]*import\s+["'][^"']+["'];.*$/gm, "")
        .replace(/import\.meta\.url/g, '"file:///__spliced__"');
    }
    function stripExports(src) {
      return src
        .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
    }
    function importedNames(relPath) {
      const src = readFileSync(resolvePath(__dirname, relPath), "utf8");
      const out = new Set();
      const re = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm;
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1].trim();
        const braces = /\{([\s\S]*?)\}/.exec(spec);
        if (braces) {
          for (const part of braces[1].split(",")) {
            const id = part.trim().split(/\s+/).pop();
            if (/^[A-Za-z_$][\w$]*$/.test(id ?? "")) out.add(id);
          }
        }
        const lead = spec.split("{")[0].replace(/\*\s+as\s+/, "").replace(/,$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(lead)) out.add(lead);
      }
      return out;
    }

    const spliced =
      stripExports(loadModule("scene3d/adapter.js")) + "\n" +
      stripExports(loadModule("scene3d/animation.js")) + "\n" +
      stripExports(loadModule("scene3d/entities.js")) + "\n";
    const wanted = new Set([
      ...importedNames("scene3d/entities.js"),
      ...importedNames("scene3d/animation.js"),
      ...importedNames("scene3d/adapter.js"),
    ]);
    wanted.delete("THREE");
    const missing = [...wanted].filter(
      (n) => !new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?(?:function|class|const|let|var)\\s+${n}\\b`).test(spliced),
    );
    const prelude =
      "const __mkStub = () => new Proxy(function () {}, {\n" +
      "  get: (t, k) => (k === Symbol.toPrimitive || k === 'then' ? undefined : __mkStub()),\n" +
      "  apply: () => __mkStub(),\n" +
      "});\n" +
      missing.map((n) => `const ${n} = __mkStub();`).join("\n") + "\n";
    const factory = new Function(
      "THREE", "performance", "window",
      prelude + spliced +
      "; return { classifyMotionCommand, expandActionCommandLow16, CAST_COMMANDS };",
    );
    const mod = factory(
      THREE,
      globalThis.performance ?? { now: () => Date.now() },
      { location: { search: "" }, __diag: {} },
    );

    const WINDUP_FULL = 0x10000132 >>> 0;   // MagicPowerUp08Purple
    const WINDUP_LOW = 0x0132;              // what MotionItem puts on the wire
    const CAST_BLAST = 0x4000002b >>> 0;    // MagicBlast
    const CAST_RECOIL = 0x40000033 >>> 0;   // MagicRecoilMissile

    check(
      "MagicPowerUp08Purple (0x0132) is in CAST_COMMANDS",
      mod.CAST_COMMANDS.has(WINDUP_LOW),
    );
    check(
      "classifyMotionCommand(0x10000132) === 'cast'",
      mod.classifyMotionCommand(WINDUP_FULL) === "cast",
      String(mod.classifyMotionCommand(WINDUP_FULL)),
    );
    check(
      "classifyMotionCommand(wire low16 0x0132) === 'cast'",
      mod.classifyMotionCommand(WINDUP_LOW) === "cast",
      String(mod.classifyMotionCommand(WINDUP_LOW)),
    );
    check(
      "expandActionCommandLow16(0x0132) re-prefixes to 0x10000132 (link inner key)",
      mod.expandActionCommandLow16(WINDUP_LOW) === WINDUP_FULL,
      "0x" + (mod.expandActionCommandLow16(WINDUP_LOW) >>> 0).toString(16),
    );
    check(
      "expandActionCommandLow16 is lossless for an already-full command",
      mod.expandActionCommandLow16(WINDUP_FULL) === WINDUP_FULL,
    );
    check(
      "both level-8 cast gestures also classify 'cast'",
      mod.classifyMotionCommand(CAST_BLAST) === "cast" &&
        mod.classifyMotionCommand(CAST_RECOIL) === "cast",
    );
    // Every MagicPowerUp variant a scarab can name must route, or some spell
    // level would silently lose its windup.
    const allScarabGestures = [...new Set(
      Object.values(components)
        .filter((c) => c.type === TYPE_SCARAB && c.gesture && c.gesture !== MOTION_INVALID)
        .map((c) => parseInt(c.gesture, 16) >>> 0),
    )];
    const unrouted = allScarabGestures.filter((g) => mod.classifyMotionCommand(g) !== "cast");
    check(
      "EVERY scarab windup gesture in the DAT classifies 'cast'",
      unrouted.length === 0,
      unrouted.map((g) => "0x" + g.toString(16)).join(","),
    );
  }
}

console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Level-8 windup chain tests FAILED.");
  process.exit(1);
}
console.log("All level-8 windup chain tests PASS.");
