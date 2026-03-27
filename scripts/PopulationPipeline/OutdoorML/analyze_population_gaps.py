#!/usr/bin/env python3
"""
analyze_population_gaps.py - Retail vs generated OutdoorML gap analysis
========================================================================

This script compares the current generated OutdoorML SQL output against retail
ACE world SQL and highlights the highest-leverage supervision gaps for the next
bounded training cycle.

Focus areas:
  - dense town service semantics
  - slumlord / housing-link coverage
  - coarse structure-family diversity and co-occurrence
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter, defaultdict
from itertools import combinations
from typing import Any

from housing_linker import classify_slumlord_house_type


BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_RETAIL_SQL = os.path.join(BASE_DIR, "ace_world_release", "ACE-World-Database-v0.9.292.sql")
DEFAULT_OUTPUT_DIR = os.path.join(BASE_DIR, "pipeline_data", "population_output")
DEFAULT_JSON_OUT = os.path.join(DEFAULT_OUTPUT_DIR, "population_gap_report.json")

WT_VENDOR = 12
WT_PORTAL = 7
WT_LIFESTONE = 25
WT_SLUMLORD = 55
WT_DOOR = 19
WT_CREATURE = 10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare generated OutdoorML SQL against retail patterns")
    parser.add_argument(
        "--generated-sql",
        default=find_latest_fullworld_sql(),
        help="Path to generated OutdoorML SQL (defaults to latest fullworld output)",
    )
    parser.add_argument(
        "--retail-sql",
        default=DEFAULT_RETAIL_SQL,
        help="Path to retail ACE world SQL dump",
    )
    parser.add_argument(
        "--json-out",
        default=DEFAULT_JSON_OUT,
        help="Optional JSON output path for machine-readable diagnostics",
    )
    parser.add_argument(
        "--town-threshold",
        type=int,
        default=15,
        help="Minimum objects in a landblock before it is considered town-like",
    )
    parser.add_argument(
        "--dense-threshold",
        type=int,
        default=20,
        help="Minimum objects in a landblock before it is considered dense-town-like",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=12,
        help="How many top landblocks / signatures to print per diagnostic section",
    )
    return parser.parse_args()


def find_latest_fullworld_sql() -> str:
    if not os.path.isdir(DEFAULT_OUTPUT_DIR):
        return os.path.join(DEFAULT_OUTPUT_DIR, "fullworld_scene_placer_resume_ema_latest.sql")

    candidates = [
        os.path.join(DEFAULT_OUTPUT_DIR, name)
        for name in os.listdir(DEFAULT_OUTPUT_DIR)
        if name.startswith("fullworld_") and name.endswith(".sql")
    ]
    if not candidates:
        return os.path.join(DEFAULT_OUTPUT_DIR, "fullworld_scene_placer_resume_ema_latest.sql")
    return max(candidates, key=os.path.getmtime)


def load_wcid_types_from_sql(sql_path: str) -> dict[int, int]:
    wcid_types: dict[int, int] = {}
    row_re = re.compile(r"\((\d+),'[^']*',(\d+),'[^']*'\)")

    with open(sql_path, "r", encoding="utf-8") as handle:
        for line in handle:
            if "INSERT INTO `weenie`" not in line:
                continue
            for match in row_re.finditer(line):
                wcid_types[int(match.group(1))] = int(match.group(2))

    return wcid_types


def parse_instances_and_links(sql_path: str) -> tuple[dict[tuple[int, int], list[dict[str, Any]]], list[dict[str, int]]]:
    instances_by_lb: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    links: list[dict[str, int]] = []

    instance_re = re.compile(
        r"\((\d+),(\d+),(\d+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"([^,]+),"
        r"'([^']*)'\)"
    )
    link_re = re.compile(r"\((\d+),(\d+),(\d+),'([^']*)'\)")

    collecting_instances = False
    collecting_links = False
    statement_lines: list[str] = []

    def flush_instances() -> None:
        statement = "".join(statement_lines)
        for match in instance_re.finditer(statement):
            guid = int(match.group(1))
            wcid = int(match.group(2))
            cell_id = int(match.group(3))
            lb_x = (cell_id >> 24) & 0xFF
            lb_y = (cell_id >> 16) & 0xFF
            cell_idx = cell_id & 0xFFFF
            if lb_x < 1 or lb_y < 1 or cell_idx >= 0x100:
                continue

            instances_by_lb[(lb_x, lb_y)].append(
                {
                    "guid": guid,
                    "wcid": wcid,
                    "x": float(match.group(4)),
                    "y": float(match.group(5)),
                    "z": float(match.group(6)),
                    "is_link_child": "1" in match.group(11),
                }
            )

    def flush_links() -> None:
        statement = "".join(statement_lines)
        for match in link_re.finditer(statement):
            links.append(
                {
                    "parent_guid": int(match.group(2)),
                    "child_guid": int(match.group(3)),
                }
            )

    with open(sql_path, "r", encoding="utf-8") as handle:
        for line in handle:
            if "INSERT INTO `landblock_instance`" in line:
                collecting_instances = True
                collecting_links = False
                statement_lines = [line]
                if ";" in line:
                    flush_instances()
                    collecting_instances = False
                    statement_lines = []
                continue

            if "INSERT INTO `landblock_instance_link`" in line:
                collecting_links = True
                collecting_instances = False
                statement_lines = [line]
                if ";" in line:
                    flush_links()
                    collecting_links = False
                    statement_lines = []
                continue

            if collecting_instances or collecting_links:
                statement_lines.append(line)
                if ";" in line:
                    if collecting_instances:
                        flush_instances()
                    elif collecting_links:
                        flush_links()
                    collecting_instances = False
                    collecting_links = False
                    statement_lines = []

    return instances_by_lb, links


def family_labels_for_landblock(insts: list[dict[str, Any]], wcid_types: dict[int, int]) -> list[str]:
    labels: set[str] = set()

    for inst in insts:
        wcid = inst["wcid"]
        wtype = wcid_types.get(wcid, 0)

        if wtype == WT_VENDOR:
            labels.add("vendor")
        elif wtype == WT_PORTAL:
            labels.add("portal")
        elif wtype == WT_LIFESTONE:
            labels.add("lifestone")
        elif wtype == WT_DOOR:
            labels.add("door")
        elif wtype == WT_CREATURE:
            labels.add("creature")
        elif wtype == WT_SLUMLORD:
            house_type = classify_slumlord_house_type(wcid)
            if house_type:
                labels.add(f"housing_{house_type.lower()}")
            else:
                labels.add("housing_unknown")
        else:
            labels.add(f"wt_{wtype}")

    return sorted(labels)


def summarize_dataset(
    name: str,
    instances_by_lb: dict[tuple[int, int], list[dict[str, Any]]],
    links: list[dict[str, int]],
    wcid_types: dict[int, int],
    town_threshold: int,
    dense_threshold: int,
    top_k: int,
) -> dict[str, Any]:
    parent_set = {row["parent_guid"] for row in links}
    town_entries = []
    dense_entries = []
    family_signature_counter: Counter[tuple[str, ...]] = Counter()
    family_presence_counter: Counter[str] = Counter()
    pair_counter: Counter[tuple[str, str]] = Counter()
    dense_unique_wcids: list[int] = []

    house_type_total = Counter()
    house_type_linked = Counter()

    for lb_key, insts in instances_by_lb.items():
        wcid_counter = Counter(inst["wcid"] for inst in insts)
        types = {wcid_types.get(inst["wcid"], 0) for inst in insts}
        family_labels = family_labels_for_landblock(insts, wcid_types)
        signature = tuple(label for label in family_labels if not label.startswith("wt_"))
        if signature:
            family_signature_counter[signature] += 1
            for label in signature:
                family_presence_counter[label] += 1
            for pair in combinations(signature, 2):
                pair_counter[pair] += 1

        slumlords = []
        for inst in insts:
            house_type = classify_slumlord_house_type(inst["wcid"])
            if house_type is None:
                continue
            slumlords.append((inst["guid"], house_type))
            house_type_total[house_type] += 1
            if inst["guid"] in parent_set:
                house_type_linked[house_type] += 1

        entry = {
            "lb_x": lb_key[0],
            "lb_y": lb_key[1],
            "count": len(insts),
            "unique_wcids": len(wcid_counter),
            "has_vendor": WT_VENDOR in types,
            "has_portal": WT_PORTAL in types,
            "has_lifestone": WT_LIFESTONE in types,
            "slumlord_count": len(slumlords),
            "linked_slumlords": sum(1 for guid, _house_type in slumlords if guid in parent_set),
            "family_signature": list(signature),
        }

        if len(insts) >= town_threshold:
            town_entries.append(entry)
        if len(insts) >= dense_threshold:
            dense_entries.append(entry)
            dense_unique_wcids.append(entry["unique_wcids"])

    dense_without_vendor = sorted(
        [entry for entry in dense_entries if not entry["has_vendor"]],
        key=lambda entry: entry["count"],
        reverse=True,
    )[:top_k]
    dense_without_essentials = sorted(
        [entry for entry in town_entries if not entry["has_portal"] and not entry["has_lifestone"]],
        key=lambda entry: entry["count"],
        reverse=True,
    )[:top_k]
    partial_slumlord_links = sorted(
        [
            entry
            for entry in town_entries
            if entry["slumlord_count"] and entry["linked_slumlords"] < entry["slumlord_count"]
        ],
        key=lambda entry: (entry["slumlord_count"] - entry["linked_slumlords"], entry["count"]),
        reverse=True,
    )[:top_k]

    total_slumlords = sum(entry["slumlord_count"] for entry in town_entries)
    linked_slumlords = sum(entry["linked_slumlords"] for entry in town_entries)

    return {
        "name": name,
        "total_landblocks": len(instances_by_lb),
        "town_landblocks": len(town_entries),
        "dense_landblocks": len(dense_entries),
        "vendor_landblocks_ge_dense": sum(1 for entry in dense_entries if entry["has_vendor"]),
        "portal_landblocks_ge_town": sum(1 for entry in town_entries if entry["has_portal"]),
        "lifestone_landblocks_ge_town": sum(1 for entry in town_entries if entry["has_lifestone"]),
        "total_slumlords_ge_town": total_slumlords,
        "linked_slumlords_ge_town": linked_slumlords,
        "slumlord_link_rate_ge_town": (linked_slumlords / total_slumlords) if total_slumlords else 1.0,
        "avg_objects_per_town_lb": (
            sum(entry["count"] for entry in town_entries) / len(town_entries) if town_entries else 0.0
        ),
        "avg_unique_wcids_per_dense_lb": (
            sum(dense_unique_wcids) / len(dense_unique_wcids) if dense_unique_wcids else 0.0
        ),
        "house_type_total": dict(house_type_total),
        "house_type_linked": dict(house_type_linked),
        "family_presence_top": family_presence_counter.most_common(top_k),
        "family_signature_top": [
            {"signature": list(signature), "count": count}
            for signature, count in family_signature_counter.most_common(top_k)
        ],
        "family_pair_top": [
            {"pair": list(pair), "count": count}
            for pair, count in pair_counter.most_common(top_k)
        ],
        "top_dense_without_vendor": dense_without_vendor,
        "top_dense_without_essentials": dense_without_essentials,
        "top_partial_slumlord_links": partial_slumlord_links,
    }


def compare_datasets(retail: dict[str, Any], generated: dict[str, Any]) -> dict[str, Any]:
    def rate(numerator: int, denominator: int) -> float:
        return numerator / denominator if denominator else 0.0

    retail_vendor_rate = rate(retail["vendor_landblocks_ge_dense"], retail["dense_landblocks"])
    generated_vendor_rate = rate(generated["vendor_landblocks_ge_dense"], generated["dense_landblocks"])
    retail_portal_rate = rate(retail["portal_landblocks_ge_town"], retail["town_landblocks"])
    generated_portal_rate = rate(generated["portal_landblocks_ge_town"], generated["town_landblocks"])
    retail_lifestone_rate = rate(retail["lifestone_landblocks_ge_town"], retail["town_landblocks"])
    generated_lifestone_rate = rate(generated["lifestone_landblocks_ge_town"], generated["town_landblocks"])

    house_type_gaps = []
    house_types = sorted(set(retail["house_type_total"]) | set(generated["house_type_total"]))
    for house_type in house_types:
        retail_total = int(retail["house_type_total"].get(house_type, 0))
        generated_total = int(generated["house_type_total"].get(house_type, 0))
        retail_linked = int(retail["house_type_linked"].get(house_type, 0))
        generated_linked = int(generated["house_type_linked"].get(house_type, 0))
        retail_rate_by_type = retail_linked / retail_total if retail_total else 0.0
        generated_rate_by_type = generated_linked / generated_total if generated_total else 0.0
        house_type_gaps.append(
            {
                "house_type": house_type,
                "retail_total": retail_total,
                "generated_total": generated_total,
                "retail_link_rate": retail_rate_by_type,
                "generated_link_rate": generated_rate_by_type,
                "gap": generated_rate_by_type - retail_rate_by_type,
            }
        )

    return {
        "service_rates": {
            "vendor_dense": {"retail": retail_vendor_rate, "generated": generated_vendor_rate},
            "portal_town": {"retail": retail_portal_rate, "generated": generated_portal_rate},
            "lifestone_town": {"retail": retail_lifestone_rate, "generated": generated_lifestone_rate},
        },
        "slumlord_link_rate_ge_town": {
            "retail": retail["slumlord_link_rate_ge_town"],
            "generated": generated["slumlord_link_rate_ge_town"],
        },
        "avg_unique_wcids_per_dense_lb": {
            "retail": retail["avg_unique_wcids_per_dense_lb"],
            "generated": generated["avg_unique_wcids_per_dense_lb"],
        },
        "house_type_gaps": house_type_gaps,
    }


def print_dataset_summary(summary: dict[str, Any], top_k: int) -> None:
    print(f"  Dataset: {summary['name']}")
    print(f"    Landblocks:                  {summary['total_landblocks']:,}")
    print(f"    Town-like LBs >= threshold:  {summary['town_landblocks']:,}")
    print(f"    Dense LBs >= threshold:      {summary['dense_landblocks']:,}")
    print(f"    Vendor coverage (dense):     {summary['vendor_landblocks_ge_dense']}/{summary['dense_landblocks']}")
    print(f"    Portal coverage (town):      {summary['portal_landblocks_ge_town']}/{summary['town_landblocks']}")
    print(f"    Lifestone coverage (town):   {summary['lifestone_landblocks_ge_town']}/{summary['town_landblocks']}")
    print(
        "    Slumlord link coverage:     "
        f" {summary['linked_slumlords_ge_town']}/{summary['total_slumlords_ge_town']}"
        f" ({summary['slumlord_link_rate_ge_town'] * 100:.1f}%)"
    )
    print(f"    Avg objects / town LB:       {summary['avg_objects_per_town_lb']:.1f}")
    print(f"    Avg unique WCIDs / dense LB: {summary['avg_unique_wcids_per_dense_lb']:.1f}")
    print(f"    Top family signatures:")
    for row in summary["family_signature_top"][:top_k]:
        label = ", ".join(row["signature"]) if row["signature"] else "(none)"
        print(f"      {row['count']:5d}  {label}")
    print(f"    Top family co-occurrence pairs:")
    for row in summary["family_pair_top"][:top_k]:
        print(f"      {row['count']:5d}  {' + '.join(row['pair'])}")


def print_comparison(comparison: dict[str, Any], generated: dict[str, Any], top_k: int) -> None:
    print("=" * 72)
    print("  Retail vs Generated Gap Summary")
    print("=" * 72)
    service = comparison["service_rates"]
    print(
        "  Dense vendor coverage:   "
        f"retail={service['vendor_dense']['retail'] * 100:.1f}%  "
        f"generated={service['vendor_dense']['generated'] * 100:.1f}%"
    )
    print(
        "  Town portal coverage:    "
        f"retail={service['portal_town']['retail'] * 100:.1f}%  "
        f"generated={service['portal_town']['generated'] * 100:.1f}%"
    )
    print(
        "  Town lifestone coverage: "
        f"retail={service['lifestone_town']['retail'] * 100:.1f}%  "
        f"generated={service['lifestone_town']['generated'] * 100:.1f}%"
    )
    print(
        "  Slumlord link coverage:  "
        f"retail={comparison['slumlord_link_rate_ge_town']['retail'] * 100:.1f}%  "
        f"generated={comparison['slumlord_link_rate_ge_town']['generated'] * 100:.1f}%"
    )
    print(
        "  Dense unique WCIDs/LB:   "
        f"retail={comparison['avg_unique_wcids_per_dense_lb']['retail']:.1f}  "
        f"generated={comparison['avg_unique_wcids_per_dense_lb']['generated']:.1f}"
    )
    print()
    print("  Highest-leverage generated service gaps:")
    for row in generated["top_dense_without_vendor"][:top_k]:
        print(
            f"    ({row['lb_x']:3d},{row['lb_y']:3d}) count={row['count']:3d} "
            f"vendor={row['has_vendor']} portal={row['has_portal']} "
            f"lifestone={row['has_lifestone']} slumlords={row['slumlord_count']}"
        )
    print()
    print("  Highest-leverage generated slumlord-link gaps:")
    for row in generated["top_partial_slumlord_links"][:top_k]:
        print(
            f"    ({row['lb_x']:3d},{row['lb_y']:3d}) count={row['count']:3d} "
            f"slumlords={row['slumlord_count']} linked={row['linked_slumlords']}"
        )
    print()
    print("  House-type link-rate comparison:")
    for row in comparison["house_type_gaps"]:
        print(
            f"    {row['house_type']:<8} retail={row['retail_link_rate'] * 100:5.1f}% "
            f"generated={row['generated_link_rate'] * 100:5.1f}% "
            f"totals={row['generated_total']:4d}"
        )
    if comparison["slumlord_link_rate_ge_town"]["retail"] == 0.0:
        print()
        print("  Note:")
        print("    Retail SQL does not appear to expose slumlord parent links in a directly")
        print("    comparable way here. Treat generated slumlord-link gaps as within-run")
        print("    diagnostics first, not as a literal retail coverage delta.")
    print("=" * 72)


def main() -> None:
    args = parse_args()

    if not os.path.exists(args.retail_sql):
        raise SystemExit(f"Retail SQL file not found: {args.retail_sql}")
    if not os.path.exists(args.generated_sql):
        raise SystemExit(f"Generated SQL file not found: {args.generated_sql}")

    print(f"Loading retail WCID types from {os.path.basename(args.retail_sql)}...")
    wcid_types = load_wcid_types_from_sql(args.retail_sql)
    print(f"  Loaded {len(wcid_types):,} wcid->type rows")

    print(f"Parsing retail instances and links from {os.path.basename(args.retail_sql)}...")
    retail_instances, retail_links = parse_instances_and_links(args.retail_sql)
    print(f"  Parsed {sum(len(v) for v in retail_instances.values()):,} instances across {len(retail_instances):,} LBs")
    print(f"  Parsed {len(retail_links):,} links")

    print(f"Parsing generated instances and links from {os.path.basename(args.generated_sql)}...")
    generated_instances, generated_links = parse_instances_and_links(args.generated_sql)
    print(
        f"  Parsed {sum(len(v) for v in generated_instances.values()):,} instances across "
        f"{len(generated_instances):,} LBs"
    )
    print(f"  Parsed {len(generated_links):,} links")

    retail_summary = summarize_dataset(
        "retail",
        retail_instances,
        retail_links,
        wcid_types,
        args.town_threshold,
        args.dense_threshold,
        args.top_k,
    )
    generated_summary = summarize_dataset(
        "generated",
        generated_instances,
        generated_links,
        wcid_types,
        args.town_threshold,
        args.dense_threshold,
        args.top_k,
    )
    comparison = compare_datasets(retail_summary, generated_summary)

    print("=" * 72)
    print("  Dataset Summaries")
    print("=" * 72)
    print_dataset_summary(retail_summary, args.top_k)
    print()
    print_dataset_summary(generated_summary, args.top_k)
    print()
    print_comparison(comparison, generated_summary, args.top_k)

    report = {
        "retail_sql": args.retail_sql,
        "generated_sql": args.generated_sql,
        "town_threshold": args.town_threshold,
        "dense_threshold": args.dense_threshold,
        "retail": retail_summary,
        "generated": generated_summary,
        "comparison": comparison,
    }

    if args.json_out:
        os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(f"JSON report written to {args.json_out}")


if __name__ == "__main__":
    main()
