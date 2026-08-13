#!/usr/bin/env python3
"""Convert LSD-Partial's spells.json into the spellbook plugin's
catalog format.

Input:  ../LSD-Partial-2025-02-23_16-15/spells.json
        (5.2 MB; 6266 entries under table.spellBaseHash)
Output: apps/holtburger-web/data/spells-catalog.json
        (one entry per learnable spell, ~1.3 MB)

Per-spell fields the spellbook plugin reads
(apps/holtburger-web/plugins/spellbook.js):
  name        — display string
  school      — 1=War 2=Life 3=Item 4=Creature 5=Void
  level       — 1-8, parsed from the trailing roman numeral
  untargeted  — bool, derived from SpellFlags.SelfTargeted (0x8)
  mana        — base_mana
  icon        — surface DID (0x06xxxxxx); rendered when DAT-surface
                fetching is wired
  desc        — flavour text
  duration    — enchantment duration in SECONDS, from
                `meta_spell.spell.duration`. Emitted ONLY for the two
                MetaSpellTypes whose DAT record actually carries a
                duration field, mirroring ACE's own SpellBase reader
                (`ACE.DatLoader/Entity/SpellBase.cs:78-84`):
                    case SpellType.Enchantment:        // 1
                    case SpellType.FellowEnchantment:  // 12
                        Duration = reader.ReadDouble();
                Every other MetaSpellType (Projectile, Boost, Dispel,
                Portal*, ...) has no duration in the DAT at all and
                stays 0 — correct, not missing. PortalSummon's
                `PortalLifetime` is a DIFFERENT field and is not a
                spell duration; it is deliberately not folded in here.
                Ledger E10: this used to be hardcoded 0 for ALL 6266
                entries while the DAT carried the real value (spell
                2639 Repulsion = 60 s).
  components  — ["Comp_N", ...] from the spell formula (zero entries
                stripped). Cross-referenced against the component
                name table when rendering.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LSD = ROOT / ".." / "LSD-Partial-2025-02-23_16-15" / "spells.json"
OUT = ROOT / "apps" / "holtburger-web" / "data" / "spells-catalog.json"

ROMAN_TO_LEVEL = {
    "I": 1, "II": 2, "III": 3, "IV": 4,
    "V": 5, "VI": 6, "VII": 7, "VIII": 8,
}
ROMAN_RE = re.compile(r"\s(VIII|VII|VI|IV|V|III|II|I)\s*$")

SELF_TARGETED = 0x8  # ACE SpellFlags

# MetaSpellTypes whose DAT record carries a `Duration` double —
# `ACE.DatLoader/Entity/SpellBase.cs:78-84`. Values are ACE's
# `SpellType` enum ordinals (ACE.Entity/Enum/SpellType.cs).
SPELL_TYPE_ENCHANTMENT = 1
SPELL_TYPE_FELLOW_ENCHANTMENT = 12
DURATION_BEARING_SPELL_TYPES = frozenset(
    (SPELL_TYPE_ENCHANTMENT, SPELL_TYPE_FELLOW_ENCHANTMENT)
)


def duration_from_meta_spell(meta_spell) -> float:
    """Enchantment duration in seconds, or 0.0 when the spell type has none.

    LSD nests it as `meta_spell.spell.duration`. We gate on `sp_type` rather
    than on mere presence: LSD also reports a `duration` on 19 of the 21
    `EnchantmentProjectile` (15) rows, but ACE's DAT reader does NOT read one
    for that type, so trusting presence alone would ship a value the retail
    record does not contain.
    """
    if not isinstance(meta_spell, dict):
        return 0.0
    if meta_spell.get("sp_type") not in DURATION_BEARING_SPELL_TYPES:
        return 0.0
    spell = meta_spell.get("spell")
    if not isinstance(spell, dict):
        return 0.0
    d = spell.get("duration")
    if not isinstance(d, (int, float)) or d <= 0:
        return 0.0
    return float(d)

def level_from_name(name: str) -> int:
    m = ROMAN_RE.search(name)
    if not m:
        return 1
    return ROMAN_TO_LEVEL.get(m.group(1), 1)

def formula_to_components(formula):
    if not isinstance(formula, list):
        return []
    return [f"Comp_{n}" for n in formula if isinstance(n, int) and n > 0]

def main():
    if not LSD.exists():
        print(f"missing LSD source: {LSD}", file=sys.stderr)
        return 1
    src = json.loads(LSD.read_text())
    sbh = src.get("table", {}).get("spellBaseHash", [])
    if not isinstance(sbh, list):
        print("LSD spellBaseHash not a list", file=sys.stderr)
        return 1

    spells = {}
    for ent in sbh:
        sid = ent.get("key")
        v = ent.get("value", {})
        if not isinstance(sid, int) or not isinstance(v, dict):
            continue
        name = v.get("name") or f"Spell #{sid}"
        bitfield = v.get("bitfield") or 0
        spells[str(sid)] = {
            "name": name,
            "school": v.get("school", 0),
            "level": level_from_name(name),
            "untargeted": bool(bitfield & SELF_TARGETED),
            "mana": v.get("base_mana", 0),
            "icon": v.get("iconID", 0),
            "desc": v.get("desc", ""),
            "duration": duration_from_meta_spell(v.get("meta_spell")),
            "components": formula_to_components(v.get("formula")),
        }

    out_doc = {
        "_comment": (
            "Generated from external/LSD-Partial-2025-02-23_16-15/spells.json "
            "by scripts/build_spells_catalog.py. School: 1=War 2=Life 3=Item "
            "4=Creature 5=Void. level is the spell tier (1-8 = I-VIII) parsed "
            "from the trailing roman numeral. untargeted is derived from "
            "SpellFlags.SelfTargeted (0x8). duration is the enchantment "
            "duration in SECONDS from meta_spell.spell.duration, emitted only "
            "for MetaSpellType Enchantment(1) / FellowEnchantment(12) — the "
            "two types whose DAT record carries one (ACE SpellBase.cs:78-84); "
            "every other type has no duration and stays 0. To regenerate, run "
            "`python3 scripts/build_spells_catalog.py`."
        ),
        "spells": spells,
    }
    OUT.write_text(json.dumps(out_doc, separators=(",", ":")))
    print(f"wrote {len(spells)} spells → {OUT} ({OUT.stat().st_size / 1024 / 1024:.2f} MB)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
