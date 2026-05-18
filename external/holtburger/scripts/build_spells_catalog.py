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
  duration    — 0; LSD doesn't expose a top-level duration field
                (it's inside meta_spell). Leave 0; the plugin gates
                the chip on > 0 so this is harmless.
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
            "duration": 0,
            "components": formula_to_components(v.get("formula")),
        }

    out_doc = {
        "_comment": (
            "Generated from external/LSD-Partial-2025-02-23_16-15/spells.json "
            "by scripts/build_spells_catalog.py. School: 1=War 2=Life 3=Item "
            "4=Creature 5=Void. level is the spell tier (1-8 = I-VIII) parsed "
            "from the trailing roman numeral. untargeted is derived from "
            "SpellFlags.SelfTargeted (0x8). To regenerate, run "
            "`python3 scripts/build_spells_catalog.py`."
        ),
        "spells": spells,
    }
    OUT.write_text(json.dumps(out_doc, separators=(",", ":")))
    print(f"wrote {len(spells)} spells → {OUT} ({OUT.stat().st_size / 1024 / 1024:.2f} MB)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
