#!/usr/bin/env python3
"""
analyze_retail_housing.py - Retail housing coverage and density diagnostics
===========================================================================

Reads the retail ACE world SQL dump directly and summarizes how housing shows
up in outdoor landblocks:
  - unique landblocks containing slumlords
  - cottage / villa / mansion landblock counts
  - link-child coverage for slumlords
  - object density in housing vs non-housing landblocks

This is intended as a fast decision-support tool for OutdoorML training-data
work, not a full ETL pipeline.
"""

from __future__ import annotations

import argparse
import os
import re
from collections import Counter, defaultdict

from housing_linker import classify_slumlord_house_type


BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_SQL = os.path.join(BASE_DIR, "ace_world_release", "ACE-World-Database-v0.9.292.sql")

WT_SLUMLORD = 55


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze retail housing coverage from SQL")
    parser.add_argument("--sql", default=DEFAULT_SQL, help="Path to retail ACE world SQL dump")
    return parser.parse_args()


def load_wcid_types_from_sql(sql_path: str) -> dict[int, int]:
    """Parse the weenie table from the SQL dump to build wcid -> weenie type."""
    wcid_types: dict[int, int] = {}
    row_re = re.compile(r"\((\d+),'[^']*',(\d+),'[^']*'\)")

    with open(sql_path, "r", encoding="utf-8") as f:
        for line in f:
            if "INSERT INTO `weenie`" not in line:
                continue
            for match in row_re.finditer(line):
                wcid_types[int(match.group(1))] = int(match.group(2))

    return wcid_types


def analyze_sql(sql_path: str) -> dict:
    value_re = re.compile(
        r"\((\d+),(\d+),(\d+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"'([^']*)',"
        r"'([^']*)'\)"
    )
    link_re = re.compile(r"\((\d+),(\d+),(\d+),'([^']*)'\)")

    print(f"Loading weenie types from {os.path.basename(sql_path)}...")
    wcid_types = load_wcid_types_from_sql(sql_path)
    print(f"  Loaded {len(wcid_types):,} wcid->type rows")

    all_outdoor_counts: dict[tuple[int, int], int] = defaultdict(int)
    slumlord_by_guid: dict[int, dict] = {}
    slumlord_landblocks: dict[tuple[int, int], list[dict]] = defaultdict(list)
    parent_to_children: dict[int, set[int]] = defaultdict(set)

    print(f"Scanning instances and links from {os.path.basename(sql_path)}...")
    with open(sql_path, "r", encoding="utf-8") as f:
        for line in f:
            if "INSERT INTO `landblock_instance_link`" in line:
                for match in link_re.finditer(line):
                    parent_guid = int(match.group(2))
                    child_guid = int(match.group(3))
                    parent_to_children[parent_guid].add(child_guid)
                continue

            if "INSERT INTO `landblock_instance`" not in line:
                continue

            for match in value_re.finditer(line):
                guid = int(match.group(1))
                wcid = int(match.group(2))
                cell_id = int(match.group(3))

                lb_x = (cell_id >> 24) & 0xFF
                lb_y = (cell_id >> 16) & 0xFF
                cell_idx = cell_id & 0xFFFF
                is_indoor = cell_idx >= 0x100

                if lb_x < 1 or lb_y < 1 or is_indoor:
                    continue

                lb_key = (lb_x, lb_y)
                all_outdoor_counts[lb_key] += 1

                if wcid_types.get(wcid) != WT_SLUMLORD:
                    continue

                house_type = classify_slumlord_house_type(wcid) or "Unknown"
                row = {
                    "guid": guid,
                    "wcid": wcid,
                    "house_type": house_type,
                    "lb_key": lb_key,
                }
                slumlord_by_guid[guid] = row
                slumlord_landblocks[lb_key].append(row)

    housing_lb_counts = {lb: all_outdoor_counts[lb] for lb in slumlord_landblocks}
    non_housing_lb_counts = {
        lb: count for lb, count in all_outdoor_counts.items() if lb not in slumlord_landblocks
    }

    house_type_token_counts = Counter(row["house_type"] for row in slumlord_by_guid.values())
    house_type_lb_counts = Counter()
    for rows in slumlord_landblocks.values():
        for house_type in {row["house_type"] for row in rows}:
            house_type_lb_counts[house_type] += 1

    linked_slumlords = sum(1 for guid in slumlord_by_guid if guid in parent_to_children)
    total_slumlords = len(slumlord_by_guid)
    total_link_children = sum(len(children) for guid, children in parent_to_children.items() if guid in slumlord_by_guid)

    def avg(values: dict[tuple[int, int], int]) -> float:
        if not values:
            return 0.0
        return sum(values.values()) / len(values)

    return {
        "sql_path": sql_path,
        "total_outdoor_landblocks": len(all_outdoor_counts),
        "housing_landblocks": len(slumlord_landblocks),
        "non_housing_landblocks": len(non_housing_lb_counts),
        "total_slumlords": total_slumlords,
        "slumlords_with_links": linked_slumlords,
        "slumlord_link_coverage": (linked_slumlords / total_slumlords) if total_slumlords else 0.0,
        "total_link_children": total_link_children,
        "avg_objects_housing_lb": avg(housing_lb_counts),
        "avg_objects_non_housing_lb": avg(non_housing_lb_counts),
        "max_objects_housing_lb": max(housing_lb_counts.values()) if housing_lb_counts else 0,
        "max_objects_non_housing_lb": max(non_housing_lb_counts.values()) if non_housing_lb_counts else 0,
        "house_type_token_counts": house_type_token_counts,
        "house_type_landblock_counts": house_type_lb_counts,
        "top_housing_landblocks": sorted(
            ((lb, count, len(slumlord_landblocks[lb])) for lb, count in housing_lb_counts.items()),
            key=lambda item: item[1],
            reverse=True,
        )[:15],
    }


def main() -> None:
    args = parse_args()
    if not os.path.exists(args.sql):
        raise SystemExit(f"SQL file not found: {args.sql}")

    summary = analyze_sql(args.sql)

    print("=" * 72)
    print("  Retail Housing Coverage Summary")
    print("=" * 72)
    print(f"  SQL:                      {summary['sql_path']}")
    print(f"  Outdoor landblocks:       {summary['total_outdoor_landblocks']:,}")
    print(f"  Housing landblocks:       {summary['housing_landblocks']:,}")
    print(f"  Non-housing landblocks:   {summary['non_housing_landblocks']:,}")
    print(f"  Total slumlords:          {summary['total_slumlords']:,}")
    print(f"  Slumlords with links:     {summary['slumlords_with_links']:,}")
    print(f"  Slumlord link coverage:   {summary['slumlord_link_coverage'] * 100:.1f}%")
    print(f"  Linked housing children:  {summary['total_link_children']:,}")
    print()
    print("  House-type counts by slumlord token:")
    for house_type, count in summary["house_type_token_counts"].most_common():
        print(f"    {house_type:<8} {count:,}")
    print()
    print("  House-type counts by unique landblock:")
    for house_type, count in summary["house_type_landblock_counts"].most_common():
        print(f"    {house_type:<8} {count:,}")
    print()
    print(f"  Avg objects / housing LB:     {summary['avg_objects_housing_lb']:.1f}")
    print(f"  Avg objects / non-housing LB: {summary['avg_objects_non_housing_lb']:.1f}")
    print(f"  Max objects / housing LB:     {summary['max_objects_housing_lb']:,}")
    print(f"  Max objects / non-housing LB: {summary['max_objects_non_housing_lb']:,}")
    print()
    print("  Top housing landblocks by outdoor instance count:")
    for lb, count, slumlords in summary["top_housing_landblocks"]:
        print(f"    ({lb[0]:3d},{lb[1]:3d})  objects={count:4d}  slumlords={slumlords}")
    print("=" * 72)


if __name__ == "__main__":
    main()
