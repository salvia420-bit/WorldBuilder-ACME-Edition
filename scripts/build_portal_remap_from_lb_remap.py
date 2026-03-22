#!/usr/bin/env python3
"""
Generate/apply portal destination remap SQL from population_output/lb_remap.json.

This updates outdoor portal destination obj_Cell_Id values so portal destinations
track moved towns/landblocks after town placement remap.
"""

import argparse
import json
import subprocess
from pathlib import Path


DEFAULT_MYSQL = Path(r"C:\Program Files\MariaDB 12.2\bin\mysql.exe")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build portal remap SQL from lb_remap.json and optionally apply it."
    )
    parser.add_argument(
        "--lb-remap",
        default="population_output/lb_remap.json",
        help="Path to lb_remap.json",
    )
    parser.add_argument(
        "--output",
        default="population_output/portal_remap_from_lb_remap.sql",
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
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply generated SQL to the database",
    )
    return parser.parse_args()


def to_lb_tuple(s):
    x_str, y_str = s.split(",")
    return int(x_str), int(y_str)


def load_lb_remap(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    remap = {}
    for old_key, new_val in raw.items():
        remap[to_lb_tuple(old_key)] = to_lb_tuple(new_val)
    return remap


def query_portal_rows(mysql_path, user, password, database):
    query = (
        "SELECT wpp.object_Id, wpp.position_Type, wpp.obj_Cell_Id "
        "FROM weenie_properties_position wpp "
        "JOIN weenie w ON wpp.object_Id = w.class_Id "
        "WHERE w.`type` = 7;"
    )
    result = subprocess.run(
        [
            str(mysql_path),
            "-u",
            user,
            f"-p{password}",
            database,
            "--batch",
            "--raw",
            "-e",
            query,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "mysql query failed")
    return result.stdout


def build_updates(table_text, lb_remap):
    lines = [ln for ln in table_text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return [], 0, 0, 0

    headers = lines[0].split("\t")
    idx = {name: i for i, name in enumerate(headers)}

    updates = []
    skipped_interior = 0
    skipped_no_remap = 0

    for line in lines[1:]:
        cols = line.split("\t")
        try:
            object_id = int(cols[idx["object_Id"]])
            position_type = int(cols[idx["position_Type"]])
            old_cell = int(cols[idx["obj_Cell_Id"]])
        except Exception:
            continue

        cell = old_cell & 0xFFFF
        if cell >= 0x0100:
            skipped_interior += 1
            continue

        lbx = (old_cell >> 24) & 0xFF
        lby = (old_cell >> 16) & 0xFF
        old_lb = (lbx, lby)
        if old_lb not in lb_remap:
            skipped_no_remap += 1
            continue

        new_lbx, new_lby = lb_remap[old_lb]
        new_cell = (new_lbx << 24) | (new_lby << 16) | cell
        if new_cell == old_cell:
            continue

        updates.append((object_id, position_type, old_cell, new_cell))

    total_rows = len(lines) - 1
    return updates, total_rows, skipped_interior, skipped_no_remap


def write_sql(path, updates):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"-- Portal destination remap from lb_remap.json ({len(updates)} updates)\n")
        for object_id, position_type, old_cell, new_cell in updates:
            f.write(
                "UPDATE `weenie_properties_position` "
                f"SET `obj_Cell_Id` = {new_cell} "
                f"WHERE `object_Id` = {object_id} "
                f"AND `position_Type` = {position_type} "
                f"AND `obj_Cell_Id` = {old_cell};\n"
            )


def apply_sql(mysql_path, user, password, database, sql_path):
    with open(sql_path, "r", encoding="utf-8") as f:
        result = subprocess.run(
            [str(mysql_path), "-u", user, f"-p{password}", database],
            stdin=f,
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "mysql apply failed")


def main():
    args = parse_args()
    lb_remap_path = Path(args.lb_remap)
    output_path = Path(args.output)
    mysql_path = Path(args.mysql)

    lb_remap = load_lb_remap(lb_remap_path)
    table_text = query_portal_rows(
        mysql_path=mysql_path,
        user=args.user,
        password=args.password,
        database=args.database,
    )
    updates, total_rows, skipped_interior, skipped_no_remap = build_updates(
        table_text, lb_remap
    )
    write_sql(output_path, updates)

    print(f"Loaded LB remaps: {len(lb_remap)}")
    print(f"Portal rows scanned: {total_rows}")
    print(f"Interior rows skipped: {skipped_interior}")
    print(f"No-remap rows skipped: {skipped_no_remap}")
    print(f"Portal destination updates: {len(updates)}")
    print(f"SQL written: {output_path}")

    if args.apply:
        apply_sql(
            mysql_path=mysql_path,
            user=args.user,
            password=args.password,
            database=args.database,
            sql_path=output_path,
        )
        print("SQL applied to database.")


if __name__ == "__main__":
    main()

