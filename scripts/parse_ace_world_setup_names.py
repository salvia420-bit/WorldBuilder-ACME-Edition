#!/usr/bin/env python3
"""
parse_ace_world_setup_names.py

Streams the ACE world database SQL dump and extracts a setupDid -> name
mapping that's broader than LSD-Partial, by combining:

  - weenie.class_Name             (always present, enum-style identifier)
  - weenie_properties_string[1]   (PropertyString.Name, human-readable)
  - weenie_properties_d_i_d[1]    (PropertyDataId.Setup -> setupDid)

Output:
  pipeline_data/enrichment/ace_world_setup_names.json
    {
      "by_setup_did": {
        "33554433": {
           "wcids": [4, 12345, ...],
           "names":      ["Player",  ...],   # PropertyString.Name where present
           "class_names":["acePlayer", ...], # weenie.class_Name fallback
           "weenie_types":[1, 7, ...]
        },
        ...
      },
      "stats": {...}
    }
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/salvia420/WorldBuilder-ACME-Edition")
SQL_PATH = REPO / "ace_world_release/ACE-World-Database-v0.9.292.sql"
OUT_PATH = REPO / "pipeline_data/enrichment/ace_world_setup_names.json"

PROP_DID_SETUP = 1   # PropertyDataId.Setup
PROP_STR_NAME = 1    # PropertyString.Name


# ──────────────────────────────────────────────────────────────────────────
# MySQL VALUES tuple parser (handles backslash escapes, single-quoted strs)
# ──────────────────────────────────────────────────────────────────────────

_ESCAPE = {
    "0": "\0", "'": "'", '"': '"', "b": "\b", "n": "\n",
    "r": "\r", "t": "\t", "Z": "\x1a", "\\": "\\", "%": "%", "_": "_",
}


def parse_tuples(blob: str) -> list[list]:
    """Parse `(...),(...),(...)...;` into a list of value lists.

    Handles integers, single-quoted strings with backslash escapes,
    and the bareword NULL.
    """
    out: list[list] = []
    i = 0
    n = len(blob)
    while i < n:
        c = blob[i]
        if c.isspace() or c == ",":
            i += 1
            continue
        if c == ";":
            break
        if c != "(":
            # skip until next ( — covers leading "VALUES " etc.
            i += 1
            continue
        # parse one tuple
        i += 1
        row: list = []
        while i < n:
            c = blob[i]
            if c.isspace() or c == ",":
                i += 1
                continue
            if c == ")":
                i += 1
                out.append(row)
                break
            if c == "'":
                i += 1
                buf = []
                while i < n:
                    c = blob[i]
                    if c == "\\" and i + 1 < n:
                        nxt = blob[i + 1]
                        buf.append(_ESCAPE.get(nxt, nxt))
                        i += 2
                        continue
                    if c == "'":
                        # MySQL also escapes single quotes by doubling
                        if i + 1 < n and blob[i + 1] == "'":
                            buf.append("'")
                            i += 2
                            continue
                        i += 1
                        break
                    buf.append(c)
                    i += 1
                row.append("".join(buf))
                continue
            # NULL or number
            j = i
            while j < n and blob[j] not in ",)":
                j += 1
            tok = blob[i:j].strip()
            if tok.upper() == "NULL":
                row.append(None)
            else:
                try:
                    row.append(int(tok))
                except ValueError:
                    try:
                        row.append(float(tok))
                    except ValueError:
                        row.append(tok)
            i = j
    return out


# ──────────────────────────────────────────────────────────────────────────
# Streamers per table
# ──────────────────────────────────────────────────────────────────────────

INSERT_PREFIXES = {
    "weenie": "INSERT INTO `weenie` VALUES ",
    "weenie_properties_d_i_d": "INSERT INTO `weenie_properties_d_i_d` VALUES ",
    "weenie_properties_string": "INSERT INTO `weenie_properties_string` VALUES ",
}


def stream_inserts(sql_path: Path):
    """Yield (table, values_blob_str) for each relevant INSERT."""
    with sql_path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            for table, prefix in INSERT_PREFIXES.items():
                if line.startswith(prefix):
                    yield table, line[len(prefix):]
                    break


# ──────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    weenie_class_name: dict[int, str] = {}
    weenie_type: dict[int, int] = {}
    wcid_to_setup: dict[int, int] = {}
    wcid_to_name: dict[int, str] = {}

    rows_seen = defaultdict(int)
    print(f"Streaming {SQL_PATH} ...")
    for table, blob in stream_inserts(SQL_PATH):
        tuples = parse_tuples(blob)
        rows_seen[table] += len(tuples)
        if table == "weenie":
            # (class_Id, class_Name, type, last_Modified)
            for t in tuples:
                if len(t) >= 3 and isinstance(t[0], int) and isinstance(t[1], str):
                    weenie_class_name[t[0]] = t[1]
                    if isinstance(t[2], int):
                        weenie_type[t[0]] = t[2]
        elif table == "weenie_properties_d_i_d":
            # (id, object_Id, type, value)
            for t in tuples:
                if len(t) >= 4 and t[2] == PROP_DID_SETUP:
                    wcid = t[1]
                    setup = t[3]
                    if isinstance(wcid, int) and isinstance(setup, int):
                        wcid_to_setup[wcid] = setup
        elif table == "weenie_properties_string":
            # (id, object_Id, type, value)
            for t in tuples:
                if len(t) >= 4 and t[2] == PROP_STR_NAME:
                    wcid = t[1]
                    val = t[3]
                    if isinstance(wcid, int) and isinstance(val, str) and val:
                        wcid_to_name.setdefault(wcid, val)

    print(f"  weenie rows ........................ {rows_seen['weenie']:,}")
    print(f"  weenie_properties_d_i_d rows ....... {rows_seen['weenie_properties_d_i_d']:,}")
    print(f"  weenie_properties_string rows ...... {rows_seen['weenie_properties_string']:,}")
    print(f"  unique wcids (class_Name) .......... {len(weenie_class_name):,}")
    print(f"  wcid -> setupDid mappings .......... {len(wcid_to_setup):,}")
    print(f"  wcid -> human Name mappings ........ {len(wcid_to_name):,}")

    by_setup: dict[int, dict] = {}
    for wcid, setup in wcid_to_setup.items():
        bucket = by_setup.setdefault(
            setup,
            {"wcids": [], "names": [], "class_names": [], "weenie_types": []},
        )
        bucket["wcids"].append(wcid)
        if wcid in wcid_to_name and wcid_to_name[wcid] not in bucket["names"]:
            bucket["names"].append(wcid_to_name[wcid])
        if wcid in weenie_class_name and weenie_class_name[wcid] not in bucket["class_names"]:
            bucket["class_names"].append(weenie_class_name[wcid])
        if wcid in weenie_type:
            t = weenie_type[wcid]
            if t not in bucket["weenie_types"]:
                bucket["weenie_types"].append(t)

    print(f"  unique setupDids covered ........... {len(by_setup):,}")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(
        {
            "source": str(SQL_PATH),
            "stats": {
                "weenie_rows": rows_seen["weenie"],
                "weenie_properties_d_i_d_rows": rows_seen["weenie_properties_d_i_d"],
                "weenie_properties_string_rows": rows_seen["weenie_properties_string"],
                "wcids": len(weenie_class_name),
                "wcid_to_setup_did": len(wcid_to_setup),
                "wcid_to_name": len(wcid_to_name),
                "unique_setup_dids": len(by_setup),
            },
            "by_setup_did": {str(k): v for k, v in sorted(by_setup.items())},
        },
        indent=2,
    ))
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
