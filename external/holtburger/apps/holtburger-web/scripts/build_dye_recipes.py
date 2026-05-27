#!/usr/bin/env python3
"""Extract real dye-pot recipes from the ACE world database SQL dump.

Replaces the W7.9 hardcoded DYEPOT_OUTCOMES table in
`plugins/dye-preview.js` (which used placeholder paletteTemplate=87 +
arbitrary shade values for all 9 entries) with the actual values
each dye-pot weenie carries.

Model
-----
ACE recipes 3844 (base dye) and 9068 (rare eternal dye) are
"copy palette from source to target on success" recipes — see
`ace-server/Source/ACE.Server/Managers/RecipeManager.cs:1272-1327`
where `ModifyInt` handles `ModificationOperation.CopyFromSourceToTarget`
on `PropertyInt.PaletteTemplate` (stat=3). The actual
(paletteTemplate, shade) for each dye outcome lives on the DYE POT
WEENIE'S OWN PROPERTIES:

  weenie_properties_int   type=3  (PropertyInt.PaletteTemplate)
  weenie_properties_float type=12 (PropertyFloat.Shade)

The success branch's only int mod row is
`(index=1, stat=3, value=0, enum=3 CopyFromSourceToTarget, source=1 Source)`
which literally does `target.PaletteTemplate = source.PaletteTemplate`
at execution time. So every dye-pot wcid -> (palette, shade) mapping
is just the dye-pot weenie's own (PaletteTemplate, Shade) properties.

The fail branch sets PaletteTemplate=87 (PaletteTemplate.DyeBotched
per `ACE.Entity/Enum/PaletteTemplate.cs:93`) and decreases ArmorLevel.

ACE source cross-refs
---------------------
  RecipeManager_New.cs:42-77  — switch on source.WeenieClassId routes
    the 9 base-game W_POTDYE*_CLASS wcids to recipe 3844 and the 10
    W_DYERAREETERNALFOOLPROOF*_CLASS wcids to recipe 9068.
  RecipeManager.cs:1272-1327  — ModifyInt with op=CopyFromSourceToTarget
    on stat=PaletteTemplate (3) copies the source dye-pot's palette
    to the target armor.
  PropertyInt.cs:16           — PaletteTemplate = 3
  PropertyFloat.cs:24         — Shade = 12
  PropertyString.cs:?         — Name = 1
  PaletteTemplate.cs:84-99    — DyeDarkGreen..DyeSpringBlack at indices
                                84-93 (Undef=0 origin)
  WeenieClassName.cs:8019-11453 — base dye-pot wcids 8043..11477
  WeenieClassName.cs:30057-30066 — rare eternal wcids 30082..30091

SQL schemas (see lines 35, 1103, 1711, 1606, 1904 of the dump)
--------------------------------------------------------------
  weenie                    (class_Id, class_Name, type, last_Modified)
  weenie_properties_int     (id, object_Id, type, value)
  weenie_properties_float   (id, object_Id, type, value)
  weenie_properties_string  (id, object_Id, type, value)

To regenerate:
  python3 external/holtburger/apps/holtburger-web/scripts/build_dye_recipes.py

Optional override of input path:
  ACE_WORLD_SQL=/path/to/ACE-World-Database-vX.Y.Z.sql python3 ...
"""

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # apps/holtburger-web
OUT = ROOT / "data" / "dye-recipes.json"
DEFAULT_SQL = (
    Path.home() / "WorldBuilder-ACME-Edition" / "ace_world_release"
    / "ACE-World-Database-v0.9.292.sql"
)
SQL_PATH = Path(os.environ.get("ACE_WORLD_SQL", str(DEFAULT_SQL)))

# Per RecipeManager_New.cs:58 + :76. Tracked for the _recipeIds field of
# the output document so consumers can cite them.
BASE_DYE_RECIPE_ID = 3844
RARE_ETERNAL_RECIPE_ID = 9068

# Per PropertyInt.cs:16 and PropertyFloat.cs:24.
PROPERTY_INT_PALETTE_TEMPLATE = 3
PROPERTY_FLOAT_SHADE = 12
PROPERTY_STRING_NAME = 1

# Per WeenieClassName.cs — the canonical dye-pot wcid ranges.
BASE_DYE_POT_WCIDS = {8043, 8044, 8045, 8650, 8651, 8652, 11475, 11476, 11477}
RARE_ETERNAL_WCIDS = {30082, 30083, 30084, 30085, 30086, 30087, 30088, 30089, 30090, 30091}
KNOWN_DYE_POT_WCIDS = BASE_DYE_POT_WCIDS | RARE_ETERNAL_WCIDS


# ---------------------------------------------------------------------
# SQL row-tuple parser
# ---------------------------------------------------------------------

# `INSERT INTO `<table>` VALUES (...),(...),...;` is one line in the
# dump. We split the rowset into individual `(...)` tuples with a
# regex that respects single-quoted strings (which may contain commas,
# the bit-string magic bytes `\x01` and `\\0`, and escaped quotes).
INSERT_RE = re.compile(r"^INSERT INTO `(\w+)` VALUES (.+);\s*$")

TUPLE_RE = re.compile(
    r"""
    \(                          # opening paren
    (?P<body>
      (?:
        '(?:\\.|[^'\\])*'       # single-quoted string with escapes
        | [^()'\\]               # any non-special, non-paren char
        | \\.                    # escaped char outside a string
      )*
    )
    \)                          # closing paren
    """,
    re.VERBOSE,
)

# Field splitter inside a row — same string-awareness as above.
FIELD_RE = re.compile(
    r"""
    \s*
    (
      '(?:\\.|[^'\\])*'         # quoted string
      | NULL
      | -?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?  # number
    )
    \s*
    (?:,|$)
    """,
    re.VERBOSE,
)


def parse_field(raw: str):
    """Convert a captured SQL literal into a Python value."""
    raw = raw.strip()
    if raw == "NULL":
        return None
    if raw.startswith("'") and raw.endswith("'"):
        inner = raw[1:-1]
        # bit(1) values: '\0' is the literal bytes (backslash + '0')
        # representing b'0' (FALSE); '\x01' (a single 0x01 byte
        # between quotes) is b'1' (TRUE).
        if inner == "\\0":
            return False
        if inner == "\x01":
            return True
        # Generic string — unescape standard MySQL escapes.
        return (
            inner.replace("\\'", "'")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
        )
    # Numeric.
    try:
        if "." in raw or "e" in raw or "E" in raw:
            return float(raw)
        return int(raw)
    except ValueError:
        return raw


def iter_rows(sql_path: Path, target_tables: set):
    """Yield (table, [fields]) for every INSERT row whose table is in
    `target_tables`. The dump has one INSERT per line, so we stream
    line-by-line without loading the 150+ MB file into memory.
    """
    with sql_path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = INSERT_RE.match(line)
            if not m:
                continue
            table, rowset = m.group(1), m.group(2)
            if table not in target_tables:
                continue
            for tup in TUPLE_RE.finditer(rowset):
                body = tup.group("body")
                fields = [parse_field(f) for f in FIELD_RE.findall(body)]
                yield table, fields


# ---------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------

def main():
    if not SQL_PATH.exists():
        print(f"missing ACE world SQL dump: {SQL_PATH}", file=sys.stderr)
        return 1

    print(f"reading {SQL_PATH} ({SQL_PATH.stat().st_size / 1024 / 1024:.1f} MB)")

    palette = {}           # wcid -> PaletteTemplate int (84-93)
    shade = {}             # wcid -> Shade float (often 0)
    disp_name = {}         # wcid -> PropertyString.Name (display name)
    class_name = {}        # wcid -> weenie.class_Name (lower-case)

    n_int = n_float = n_string = n_weenie = 0
    target_tables = {
        "weenie",
        "weenie_properties_int",
        "weenie_properties_float",
        "weenie_properties_string",
    }
    for table, fields in iter_rows(SQL_PATH, target_tables):
        if table == "weenie":
            n_weenie += 1
            # (class_Id, class_Name, type, last_Modified)
            if len(fields) >= 2 and isinstance(fields[0], int) and fields[0] in KNOWN_DYE_POT_WCIDS:
                class_name[fields[0]] = fields[1]
        elif table == "weenie_properties_int":
            n_int += 1
            # (id, object_Id, type, value)
            if len(fields) >= 4 and fields[1] in KNOWN_DYE_POT_WCIDS and fields[2] == PROPERTY_INT_PALETTE_TEMPLATE:
                palette[fields[1]] = fields[3]
        elif table == "weenie_properties_float":
            n_float += 1
            if len(fields) >= 4 and fields[1] in KNOWN_DYE_POT_WCIDS and fields[2] == PROPERTY_FLOAT_SHADE:
                shade[fields[1]] = fields[3]
        elif table == "weenie_properties_string":
            n_string += 1
            if len(fields) >= 4 and fields[1] in KNOWN_DYE_POT_WCIDS and fields[2] == PROPERTY_STRING_NAME:
                disp_name[fields[1]] = fields[3]

    print(f"  scanned: weenie={n_weenie}, int_props={n_int}, "
          f"float_props={n_float}, string_props={n_string}")
    print(f"  dye pots discovered: {len(class_name)} "
          f"(of {len(KNOWN_DYE_POT_WCIDS)} expected)")

    # Sanity check.
    missing = sorted(KNOWN_DYE_POT_WCIDS - class_name.keys())
    if missing:
        print(f"  WARN: missing dye-pot wcids from SQL: {missing}",
              file=sys.stderr)

    # Build the output dye-pots table.
    dye_pots = {}
    for wcid in sorted(KNOWN_DYE_POT_WCIDS):
        if wcid not in palette:
            # No palette property on this dye pot — skip it; the
            # preview can't render a meaningful color.
            continue
        recipe_id = BASE_DYE_RECIPE_ID if wcid in BASE_DYE_POT_WCIDS else RARE_ETERNAL_RECIPE_ID
        dye_pots[str(wcid)] = {
            "name": disp_name.get(wcid)
                    or class_name.get(wcid)
                    or f"Dye Pot #{wcid}",
            "paletteTemplate": palette[wcid],
            "shade": float(shade.get(wcid, 0.0)),
            "_recipeId": recipe_id,
        }

    out_doc = {
        "_comment": (
            "Generated from ACE-World-Database-v0.9.292.sql by "
            "scripts/build_dye_recipes.py. Maps dye-pot wcid -> "
            "(paletteTemplate int, shade float) extracted directly "
            "from the dye-pot's own weenie_properties_int "
            "(PropertyInt.PaletteTemplate=3) + weenie_properties_float "
            "(PropertyFloat.Shade=12) — recipes 3844 (base) and 9068 "
            "(rare eternal) just CopyFromSourceToTarget those values "
            "onto the dyed armor at success time (see "
            "ace-server RecipeManager.cs:ModifyInt + "
            "RecipeManager_New.cs:GetNewRecipe). To regenerate: "
            "python3 external/holtburger/apps/holtburger-web/scripts/"
            "build_dye_recipes.py"
        ),
        "_source": SQL_PATH.name,
        "_recipeIds": [BASE_DYE_RECIPE_ID, RARE_ETERNAL_RECIPE_ID],
        "dyePots": dye_pots,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out_doc, indent=2))
    print(f"wrote {len(dye_pots)} dye pots -> {OUT} "
          f"({OUT.stat().st_size} bytes)")

    # Print a per-pot summary so the user can eyeball it.
    print()
    print("=== dye-pot outcomes ===")
    for wcid_s, rec in dye_pots.items():
        print(f"  wcid={wcid_s:>5}  "
              f"palette={rec['paletteTemplate']:>3}  "
              f"shade={rec['shade']:.2f}  "
              f"recipe={rec['_recipeId']:>5}  "
              f"name={rec['name']!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
