#!/usr/bin/env python3
"""
Remap outdoor ACE instances (NPCs, portals, chests, etc.) using lb_remap.json.

Updates landblock_instance.obj_Cell_Id for outdoor cells (0x0001..0x0040),
shifting only the landblock high bytes while preserving the low cell index.
"""

import argparse
import json
import subprocess
from pathlib import Path


DEFAULT_MYSQL = Path(r"C:\Program Files\MariaDB 12.2\bin\mysql.exe")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Remap outdoor landblock_instance rows using lb_remap.json"
    )
    parser.add_argument(
        "--lb-remap",
        default="pipeline_data/population_output/lb_remap.json",
        help="Path to lb_remap.json",
    )
    parser.add_argument(
        "--output",
        default="pipeline_data/population_output/outdoor_instance_remap.sql",
        help="Output SQL path",
    )
    parser.add_argument(
        "--mysql",
        default=str(DEFAULT_MYSQL),
        help="Path to mysql.exe",
    )
    parser.add_argument("--user", default="root", help="MySQL user")
    parser.add_argument("--password", default="baltic", help="MySQL password")
    parser.add_argument("--database", default="ace_world", help="MySQL database")
    parser.add_argument("--apply", action="store_true", help="Apply SQL after generation")
    return parser.parse_args()


def parse_lb_key(key):
    x, y = key.split(",")
    return int(x), int(y)


def parse_lb_val(val):
    x, y = val.split(",")
    return int(x), int(y)


def to_prefix(lb_x, lb_y):
    return (lb_x << 24) | (lb_y << 16)


def build_sql(remap_items):
    when_lines = []
    where_ranges = []

    for (old_x, old_y), (new_x, new_y) in remap_items:
        old_prefix = to_prefix(old_x, old_y)
        new_prefix = to_prefix(new_x, new_y)
        old_min = old_prefix | 0x0001
        old_max = old_prefix | 0x0040

        when_lines.append(
            f"    WHEN obj_Cell_Id BETWEEN {old_min} AND {old_max} "
            f"THEN ({new_prefix} | (obj_Cell_Id & 65535))"
        )
        where_ranges.append(f"(obj_Cell_Id BETWEEN {old_min} AND {old_max})")

    where_clause = " OR\n        ".join(where_ranges)
    when_clause = "\n".join(when_lines)

    return f"""-- Outdoor instance remap generated from lb_remap.json
START TRANSACTION;

UPDATE `landblock_instance`
SET `obj_Cell_Id` = CASE
{when_clause}
    ELSE `obj_Cell_Id`
END
WHERE (`obj_Cell_Id` & 65535) BETWEEN 1 AND 64
  AND (
        {where_clause}
      );

COMMIT;
"""


def apply_sql(mysql_path, user, password, database, sql_path):
    with open(sql_path, "r", encoding="utf-8") as f:
        result = subprocess.run(
            [str(mysql_path), "--skip-ssl", "-u", user, f"-p{password}", database],
            stdin=f,
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "mysql apply failed")


def main():
    args = parse_args()

    with open(args.lb_remap, "r", encoding="utf-8") as f:
        raw = json.load(f)

    remap_items = []
    for old_key, new_val in raw.items():
        remap_items.append((parse_lb_key(old_key), parse_lb_val(new_val)))

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sql_text = build_sql(remap_items)
    output_path.write_text(sql_text, encoding="utf-8")

    print(f"LB remap entries: {len(remap_items)}")
    print(f"SQL written: {output_path}")

    if args.apply:
        apply_sql(
            mysql_path=Path(args.mysql),
            user=args.user,
            password=args.password,
            database=args.database,
            sql_path=output_path,
        )
        print("SQL applied to database.")


if __name__ == "__main__":
    main()
