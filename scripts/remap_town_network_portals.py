#!/usr/bin/env python3
"""
Remap town-network portal destinations to current town_placements landblocks.

This remaps portal destination obj_Cell_Id high bytes (lbX/lbY) based on portal
class names like "portalarwic", "portalholtburg", etc., preserving the low cell
index so drop placement remains consistent inside the destination landblock.
"""

import argparse
import json
import re
import subprocess
from pathlib import Path


MYSQL_DEFAULT = Path(r"C:\Program Files\MariaDB 12.2\bin\mysql.exe")


def normalize(text):
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def load_town_tokens(path):
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    towns = payload.get("towns", payload)

    token_to_town = {}
    for town_name in towns.keys():
        token = normalize(town_name)
        token_to_town[token] = town_name

    # Sort longest-first so "linvaktukal" wins before "lin".
    ordered_tokens = sorted(token_to_town.keys(), key=len, reverse=True)
    return towns, token_to_town, ordered_tokens


def query_portals(mysql_path, user, password, database):
    query = (
        "SELECT w.class_Id, w.class_Name, wpp.position_Type, wpp.obj_Cell_Id "
        "FROM weenie_properties_position wpp "
        "JOIN weenie w ON wpp.object_Id = w.class_Id "
        "WHERE w.type = 7 AND wpp.position_Type = 2;"
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
            "-N",
            "-e",
            query,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "mysql query failed")
    rows = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        cols = line.split("\t")
        if len(cols) != 4:
            continue
        rows.append(
            {
                "class_id": int(cols[0]),
                "class_name": cols[1],
                "position_type": int(cols[2]),
                "obj_cell_id": int(cols[3]),
            }
        )
    return rows


def find_town_for_portal(class_name, token_to_town, ordered_tokens):
    name_norm = normalize(class_name)
    if not name_norm.startswith("portal"):
        return None
    suffix = name_norm[len("portal") :]
    for token in ordered_tokens:
        if suffix.startswith(token):
            return token_to_town[token]
    return None


def build_updates(rows, towns, token_to_town, ordered_tokens):
    updates = []
    matched = 0
    skipped_interior = 0

    for row in rows:
        old_cell = row["obj_cell_id"]
        cell_idx = old_cell & 0xFFFF
        if cell_idx >= 0x0100:
            skipped_interior += 1
            continue

        town_name = find_town_for_portal(row["class_name"], token_to_town, ordered_tokens)
        if not town_name:
            continue

        matched += 1
        target = towns[town_name]
        new_lbx = int(target["lbX"])
        new_lby = int(target["lbY"])
        new_cell = (new_lbx << 24) | (new_lby << 16) | cell_idx

        if new_cell == old_cell:
            continue

        updates.append(
            {
                "class_id": row["class_id"],
                "class_name": row["class_name"],
                "position_type": row["position_type"],
                "old_cell": old_cell,
                "new_cell": new_cell,
                "town_name": town_name,
            }
        )

    return updates, matched, skipped_interior


def write_sql(path, updates):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"-- Town-network portal destination remap ({len(updates)} updates)\n")
        for u in updates:
            f.write(
                f"-- {u['class_name']} -> {u['town_name']}\n"
                "UPDATE `weenie_properties_position` "
                f"SET `obj_Cell_Id` = {u['new_cell']} "
                f"WHERE `object_Id` = {u['class_id']} "
                f"AND `position_Type` = {u['position_type']} "
                f"AND `obj_Cell_Id` = {u['old_cell']};\n"
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
    parser = argparse.ArgumentParser(description="Remap town-network portal destinations")
    parser.add_argument(
        "--town-placements",
        default="population_output/town_placements.json",
        help="Path to town_placements.json",
    )
    parser.add_argument(
        "--output",
        default="population_output/portal_town_network_remap.sql",
        help="Output SQL path",
    )
    parser.add_argument("--mysql", default=str(MYSQL_DEFAULT), help="Path to mysql.exe")
    parser.add_argument("--user", default="root", help="MySQL user")
    parser.add_argument("--password", default="baltic", help="MySQL password")
    parser.add_argument("--database", default="ace_world", help="MySQL database")
    parser.add_argument("--apply", action="store_true", help="Apply SQL after generation")
    args = parser.parse_args()

    towns, token_to_town, ordered_tokens = load_town_tokens(args.town_placements)
    rows = query_portals(args.mysql, args.user, args.password, args.database)
    updates, matched, skipped_interior = build_updates(rows, towns, token_to_town, ordered_tokens)
    write_sql(Path(args.output), updates)

    print(f"Portal rows scanned: {len(rows)}")
    print(f"Town-token matched portals: {matched}")
    print(f"Interior destinations skipped: {skipped_interior}")
    print(f"Destination updates generated: {len(updates)}")
    print(f"SQL written: {args.output}")

    if args.apply:
        apply_sql(args.mysql, args.user, args.password, args.database, Path(args.output))
        print("SQL applied to database.")


if __name__ == "__main__":
    main()

