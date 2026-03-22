#!/usr/bin/env python3
"""
Reseed town-related instances from retail SQL using lb_remap.json.

Why this exists:
- When the current DB has already been globally remapped/shuffled, town-specific
  remap passes can become no-ops for many GUIDs.
- This script re-imports only retail instances whose source landblocks are in
  lb_remap.json, then remaps outdoor obj_Cell_Id high bytes to the destination
  landblocks from lb_remap.
- Interior instances are imported with their original retail obj_Cell_Id so that
  remap-buildings-sql can resolve them to the newly exported EnvCell IDs.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Set, Tuple


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RETAIL_SQL = Path(r"D:\ACE\world-db\ACE-World-Database-v0.9.292.sql")
DEFAULT_LB_REMAP = ROOT / "pipeline_data" / "population_output" / "lb_remap.json"
DEFAULT_OUTPUT_SQL = ROOT / "pipeline_data" / "population_output" / "town_instance_reseed.sql"
DEFAULT_MYSQL = Path(r"C:\Program Files\MariaDB 12.2\bin\mysql.exe")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Reseed town instances from retail SQL")
    p.add_argument("--lb-remap", default=str(DEFAULT_LB_REMAP), help="Path to lb_remap.json")
    p.add_argument("--retail-sql", default=str(DEFAULT_RETAIL_SQL), help="Path to retail ACE SQL dump")
    p.add_argument("--output", default=str(DEFAULT_OUTPUT_SQL), help="Output SQL file path")
    p.add_argument("--mysql", default=str(DEFAULT_MYSQL), help="Path to mysql.exe")
    p.add_argument("--user", default="root", help="MySQL user")
    p.add_argument("--password", default="baltic", help="MySQL password")
    p.add_argument("--database", default="ace_world", help="Target MySQL database")
    p.add_argument("--apply", action="store_true", help="Apply generated SQL to DB")
    return p.parse_args()


def load_lb_remap(path: Path) -> Dict[Tuple[int, int], Tuple[int, int]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    remap: Dict[Tuple[int, int], Tuple[int, int]] = {}
    for k, v in raw.items():
        ox, oy = (int(x) for x in k.split(","))
        nx, ny = (int(x) for x in v.split(","))
        remap[(ox, oy)] = (nx, ny)
    return remap


def load_retail_instances_and_links(retail_sql_path: Path):
    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import cluster_shuffle_populate as csp

    return csp.parse_retail_sql(str(retail_sql_path))


def remap_outdoor_cell(cell_id: int, target_lb: Tuple[int, int]) -> int:
    cell_idx = cell_id & 0xFFFF
    nx, ny = target_lb
    return (nx << 24) | (ny << 16) | cell_idx


def sql_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


def format_instance_row(inst, cell_id: int) -> str:
    is_link = 1 if inst.is_link_child else 0
    return (
        f"({inst.guid},{inst.wcid},{cell_id},"
        f"{inst.origin_x:.6f},{inst.origin_y:.6f},{inst.origin_z:.6f},"
        f"{inst.angles_w:.6f},{inst.angles_x:.6f},{inst.angles_y:.6f},{inst.angles_z:.6f},"
        f"{is_link},'{sql_escape(inst.last_modified)}')"
    )


def batched(items: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def write_sql(
    out_path: Path,
    remap: Dict[Tuple[int, int], Tuple[int, int]],
    instances_by_lb,
    links,
) -> Tuple[int, int, int, int]:
    interior_instances = instances_by_lb.pop((-1, -1), [])

    source_lbs = set(remap.keys())

    selected_instances = []
    selected_guids: Set[int] = set()

    outdoor_selected = 0
    interior_selected = 0

    for lb, inst_list in instances_by_lb.items():
        if lb not in source_lbs:
            continue
        target_lb = remap[lb]
        for inst in inst_list:
            new_cell = remap_outdoor_cell(inst.obj_cell_id, target_lb)
            selected_instances.append(format_instance_row(inst, new_cell))
            selected_guids.add(inst.guid)
            outdoor_selected += 1

    for inst in interior_instances:
        lb = ((inst.obj_cell_id >> 24) & 0xFF, (inst.obj_cell_id >> 16) & 0xFF)
        if lb not in source_lbs:
            continue
        selected_instances.append(format_instance_row(inst, inst.obj_cell_id))
        selected_guids.add(inst.guid)
        interior_selected += 1

    selected_links = [
        f"({l.link_id},{l.parent_guid},{l.child_guid},'{sql_escape(l.last_modified)}')"
        for l in links
        if l.parent_guid in selected_guids and l.child_guid in selected_guids
    ]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        f.write("-- Town instance reseed generated from retail SQL + lb_remap\n")
        f.write(f"-- Source LBs: {len(source_lbs)}\n")
        f.write(f"-- Outdoor instances: {outdoor_selected}\n")
        f.write(f"-- Interior instances: {interior_selected}\n")
        f.write(f"-- Instance links: {len(selected_links)}\n\n")
        f.write("START TRANSACTION;\n\n")

        if selected_instances:
            for batch in batched(selected_instances, 500):
                f.write(
                    "INSERT INTO `landblock_instance` "
                    "(`guid`,`weenie_Class_Id`,`obj_Cell_Id`,`origin_X`,`origin_Y`,`origin_Z`,"
                    "`angles_W`,`angles_X`,`angles_Y`,`angles_Z`,`is_Link_Child`,`last_Modified`) VALUES\n"
                )
                f.write(",\n".join(batch))
                f.write(
                    "\nON DUPLICATE KEY UPDATE\n"
                    "`weenie_Class_Id`=VALUES(`weenie_Class_Id`),\n"
                    "`obj_Cell_Id`=VALUES(`obj_Cell_Id`),\n"
                    "`origin_X`=VALUES(`origin_X`),\n"
                    "`origin_Y`=VALUES(`origin_Y`),\n"
                    "`origin_Z`=VALUES(`origin_Z`),\n"
                    "`angles_W`=VALUES(`angles_W`),\n"
                    "`angles_X`=VALUES(`angles_X`),\n"
                    "`angles_Y`=VALUES(`angles_Y`),\n"
                    "`angles_Z`=VALUES(`angles_Z`),\n"
                    "`is_Link_Child`=VALUES(`is_Link_Child`),\n"
                    "`last_Modified`=VALUES(`last_Modified`);\n\n"
                )

        if selected_links:
            for batch in batched(selected_links, 500):
                f.write(
                    "INSERT INTO `landblock_instance_link` "
                    "(`id`,`parent_GUID`,`child_GUID`,`last_Modified`) VALUES\n"
                )
                f.write(",\n".join(batch))
                f.write(
                    "\nON DUPLICATE KEY UPDATE\n"
                    "`parent_GUID`=VALUES(`parent_GUID`),\n"
                    "`child_GUID`=VALUES(`child_GUID`),\n"
                    "`last_Modified`=VALUES(`last_Modified`);\n\n"
                )

        f.write("COMMIT;\n")

    return outdoor_selected, interior_selected, len(selected_links), len(source_lbs)


def apply_sql(mysql_path: Path, user: str, password: str, database: str, sql_path: Path) -> None:
    with sql_path.open("r", encoding="utf-8") as f:
        result = subprocess.run(
            [str(mysql_path), "--skip-ssl", "-u", user, f"-p{password}", database],
            stdin=f,
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "mysql apply failed")


def main() -> None:
    args = parse_args()
    lb_remap_path = Path(args.lb_remap)
    retail_sql_path = Path(args.retail_sql)
    output_path = Path(args.output)

    if not lb_remap_path.exists():
        raise FileNotFoundError(f"lb_remap not found: {lb_remap_path}")
    if not retail_sql_path.exists():
        raise FileNotFoundError(f"retail SQL not found: {retail_sql_path}")

    remap = load_lb_remap(lb_remap_path)
    instances_by_lb, links = load_retail_instances_and_links(retail_sql_path)

    outdoor_n, interior_n, links_n, lbs_n = write_sql(output_path, remap, instances_by_lb, links)

    print(f"LB remap entries considered : {lbs_n}")
    print(f"Outdoor instances selected : {outdoor_n}")
    print(f"Interior instances selected: {interior_n}")
    print(f"Links selected             : {links_n}")
    print(f"SQL written                : {output_path}")

    if args.apply:
        apply_sql(Path(args.mysql), args.user, args.password, args.database, output_path)
        print("SQL applied to database.")


if __name__ == "__main__":
    main()
