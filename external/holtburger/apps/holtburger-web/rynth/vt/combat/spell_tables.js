// rynth/vt/combat/spell_tables.js — VTank combat spell families (PLAN W1-7
// CMB, §3.9, Appendix C). Data: rynth/vt/data/combat_spells.json, generated
// and verified by rynth_vt_spell_tables_test.cjs (ids from the verified seed
// lists; levels from the DAT scarab formula; power = the LSD spell power, the
// difficulty VTank's SpellDiffExcessThreshold compares; never resolved by
// name — the C# name→id map is last-wins over duplicate names, U6 §2.5).
//
// Families: imperil fester yield broadside gravity wc fc dc cp cs vuln:<el>
// bolt:<el> streak:<el> arc:<el> ring:<el> (lowercase element; Nether shapes
// are the Void spells) + the D38 item enchantments impen and bane:<el>
// (Item school 3, cast TARGETED at an item).
//
// Loaded lazily (C11, the buff_loop.js loader pattern): node reads the file:
// URL with node:fs/promises, the browser fetches it. Until loadCombatSpells()
// resolves, isLoaded() is false and every lookup answers "nothing known" —
// consumers treat that as "feature not ready" (no cast).

/** @typedef {"Slash"|"Pierce"|"Bludgeon"|"Fire"|"Cold"|"Lightning"|"Acid"|"Nether"} Element */

export const ELEMENTS = Object.freeze(["Slash", "Pierce", "Bludgeon", "Fire", "Cold", "Lightning", "Acid", "Nether"]);

// Element aliases (U6 §2.6: C# GetWeakest returns "electric"; RynthAi uses
// Blade/Bludgeoning in spell names). Keys lowercase.
const ELEMENT_ALIASES = new Map([
  ["slash", "Slash"], ["slashing", "Slash"], ["blade", "Slash"],
  ["pierce", "Pierce"], ["piercing", "Pierce"],
  ["bludgeon", "Bludgeon"], ["bludgeoning", "Bludgeon"], ["blunt", "Bludgeon"],
  ["fire", "Fire"], ["flame", "Fire"],
  ["cold", "Cold"], ["frost", "Cold"],
  ["lightning", "Lightning"], ["electric", "Lightning"], ["electrical", "Lightning"],
  ["acid", "Acid"],
  ["nether", "Nether"], ["void", "Nether"],
]);

/** "electric" → "Lightning", "Blade" → "Slash"; null for anything else (incl. "Auto"/"None"). */
export function normalizeElement(s) {
  if (s == null) return null;
  return ELEMENT_ALIASES.get(String(s).trim().toLowerCase()) ?? null;
}

let TABLE = null; // { families: { fam: Rung[] } }
let BY_ID = null; // Map<id, { rung, family }>
let LOAD_PROMISE = null;

function index(table) {
  const families = {};
  const byId = new Map();
  const src = table && typeof table === "object" && table.families && typeof table.families === "object" ? table.families : {};
  for (const [fam, rows] of Object.entries(src)) {
    if (!Array.isArray(rows)) continue;
    const rungs = [];
    for (const r of rows) {
      if (!r || !Number.isInteger(r.id)) continue;
      const rung = Object.freeze({
        id: r.id,
        name: String(r.name ?? ""),
        level: Number(r.level) || 0,
        school: Number(r.school) || 0,
        duration: Number(r.duration) || 0,
        untargeted: r.untargeted === true,
        metaSpellType: Number(r.metaSpellType) || 0,
        power: Number(r.power) || 0, // 0 = not in the table (bestCastable's powerOf fallback)
      });
      rungs.push(rung);
      if (!byId.has(rung.id)) byId.set(rung.id, { rung, family: fam });
    }
    rungs.sort((a, b) => a.level - b.level || a.id - b.id);
    families[fam] = Object.freeze(rungs);
  }
  TABLE = { families };
  BY_ID = byId;
}

async function readTable(url) {
  // Node (tests, harness tools) has no fetch for file: URLs.
  if (url.startsWith("file:") && typeof window === "undefined") {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(new URL(url), "utf8"));
  }
  const r = await fetch(url);
  return r.ok ? r.json() : null;
}

/** C11 loader; idempotent. Never rejects — a failed read leaves the table empty (isLoaded() stays false). */
export function loadCombatSpells() {
  if (TABLE) return Promise.resolve();
  if (!LOAD_PROMISE) {
    const url = new URL("../data/combat_spells.json", import.meta.url).href;
    LOAD_PROMISE = readTable(url)
      .then((t) => {
        if (t && typeof t === "object" && t.families) index(t);
        else LOAD_PROMISE = null; // allow a later retry
      })
      .catch(() => {
        LOAD_PROMISE = null;
      });
  }
  return LOAD_PROMISE.then(() => undefined);
}

export function isLoaded() {
  return TABLE !== null;
}

/** Every family name in the table ([] until loaded). */
export function familyNames() {
  return TABLE ? Object.keys(TABLE.families) : [];
}

/** Rungs of a family sorted by level ([] for an unknown family or before load). */
export function familyLadder(family) {
  if (!TABLE) return [];
  return TABLE.families[String(family)] ?? [];
}

/**
 * Highest-level rung of `family` that is in `known`, not in `exclude`, and at
 * or below `maxLevelBySchool(rung.school)` (gate by the spell's OWN school —
 * U6 §2.1: Imperil/Vulns are Life, curses are Void). null when none.
 *
 * `maxPowerBySchool(school)` gates by difficulty instead (VTank's
 * SpellDiffExcessThreshold: the rung's power at or below it; -Infinity =
 * nothing in that school, e.g. untrained). A rung the table has no power for
 * asks `powerOf(id)` (the live spell record); still unknown = not gated.
 */
export function bestCastable(family, { known, maxLevelBySchool, maxPowerBySchool, powerOf, exclude } = {}) {
  const ladder = familyLadder(family);
  if (!ladder.length) return null;
  const has = (id) => (known && typeof known.has === "function" ? known.has(id) : false);
  for (let i = ladder.length - 1; i >= 0; i--) {
    const r = ladder[i];
    if (!has(r.id)) continue;
    if (exclude && typeof exclude.has === "function" && exclude.has(r.id)) continue;
    if (typeof maxLevelBySchool === "function") {
      let cap;
      try {
        cap = maxLevelBySchool(r.school);
      } catch (_) {
        cap = Infinity;
      }
      if (typeof cap === "number" && r.level > cap) continue;
    }
    if (typeof maxPowerBySchool === "function") {
      let cap;
      try {
        cap = maxPowerBySchool(r.school);
      } catch (_) {
        cap = Infinity;
      }
      if (typeof cap === "number" && cap < Infinity) {
        let power = r.power;
        if (!(power > 0) && typeof powerOf === "function") {
          try {
            power = Number(powerOf(r.id)) || 0;
          } catch (_) {
            power = 0;
          }
        }
        if (cap === -Infinity || (power > 0 && power > cap)) continue;
      }
    }
    return { id: r.id, level: r.level, school: r.school, duration: r.duration, untargeted: r.untargeted };
  }
  return null;
}

/** Family of a spell id (first family listing it), or null. */
export function familyOf(id) {
  const e = BY_ID && BY_ID.get(Number(id));
  return e ? e.family : null;
}

/** Enchantment / DoT window in seconds (0 = none or unknown). */
export function durationOf(id) {
  const e = BY_ID && BY_ID.get(Number(id));
  return e ? e.rung.duration : 0;
}

/** Spell name as the server prints it ("" when unknown). */
export function nameOf(id) {
  const e = BY_ID && BY_ID.get(Number(id));
  return e ? e.rung.name : "";
}

/** The full rung record of an id, or null. */
export function rungOf(id) {
  const e = BY_ID && BY_ID.get(Number(id));
  return e ? e.rung : null;
}
