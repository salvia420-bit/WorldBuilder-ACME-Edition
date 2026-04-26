#!/usr/bin/env python3
import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, Optional


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RAW_JSONL = ROOT / "pipeline_data" / "reference" / "raw_world_facts_full_with_components_v2.jsonl"
DEFAULT_ACE_ENUM = ROOT.parent / "ACE" / "Source" / "ACE.Entity" / "Enum" / "WeenieClassName.cs"
DEFAULT_LSD_WEENIES = ROOT / "external" / "LSD-Partial-2025-02-23_16-15" / "weenies"
DEFAULT_OUT_JSONL = ROOT / "pipeline_data" / "reference" / "world_grammar_grounding_table.jsonl"
DEFAULT_OUT_CSV = ROOT / "pipeline_data" / "reference" / "world_grammar_grounding_table.csv"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a deterministic grounding table for observed world identities.")
    parser.add_argument("--raw-jsonl", type=Path, default=DEFAULT_RAW_JSONL)
    parser.add_argument("--ace-enum", type=Path, default=DEFAULT_ACE_ENUM)
    parser.add_argument("--lsd-weenies", type=Path, default=DEFAULT_LSD_WEENIES)
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT_JSONL)
    parser.add_argument("--out-csv", type=Path, default=DEFAULT_OUT_CSV)
    return parser.parse_args()


def normalize_ace_name(symbol: str) -> str:
    base = symbol.removeprefix("W_").removesuffix("_CLASS")
    parts = [p for p in base.split("_") if p]
    return " ".join(part.title() for part in parts)


def parse_ace_enum(path: Path) -> Dict[int, str]:
    if not path.exists():
        return {}
    text = path.read_text(errors="ignore")
    mapping: Dict[int, str] = {}
    pattern = re.compile(r"\b(W_[A-Za-z0-9_]+)_CLASS\s*=\s*(\d+)\b")
    for symbol, raw_id in pattern.findall(text):
        mapping[int(raw_id)] = symbol
    return mapping


def extract_lsd_name(data: dict, fallback_stem: str) -> Optional[str]:
    value = data.get("name") or data.get("Name")
    if isinstance(value, str) and value.strip():
        return value.strip()
    for stat in data.get("stringStats", []):
        if stat.get("key") == 1 and isinstance(stat.get("value"), str) and stat["value"].strip():
            return stat["value"].strip()
    if " - " in fallback_stem:
        return fallback_stem.split(" - ", 1)[1].strip()
    return None


def parse_lsd_weenies(path: Path) -> Dict[int, dict]:
    if not path.exists():
        return {}
    mapping: Dict[int, dict] = {}
    for file_path in path.glob("*.json"):
        match = re.match(r"(\d+)\s+-\s+(.+)\.json$", file_path.name)
        if not match:
            continue
        try:
            data = json.loads(file_path.read_text())
        except json.JSONDecodeError:
            continue
        wcid = int(match.group(1))
        mapping[wcid] = {
            "lsd_file": file_path.name,
            "lsd_name": extract_lsd_name(data, file_path.stem),
            "lsd_weenie_type": data.get("weenieType"),
        }
    return mapping


def parse_cell_context(cell_id_value) -> str:
    if isinstance(cell_id_value, str) and cell_id_value.startswith("0x"):
        try:
            return "interior" if int(cell_id_value, 16) >= 0x0100 else "surface"
        except ValueError:
            return "unknown"
    if isinstance(cell_id_value, int):
        return "interior" if cell_id_value >= 0x0100 else "surface"
    return "unknown"


def compact_counter(counter: Counter, limit: int = 5) -> list[dict]:
    return [{"value": key, "count": count} for key, count in counter.most_common(limit)]


def infer_confidence(class_space: str, ace_name: Optional[str], lsd_name: Optional[str]) -> str:
    if class_space == "model_id":
        return "structural_only"
    if lsd_name and ace_name:
        return "high"
    if ace_name or lsd_name:
        return "medium"
    return "low"


def build_rows(raw_jsonl: Path, ace_names: Dict[int, str], lsd_weenies: Dict[int, dict]) -> Iterable[dict]:
    stats: dict[tuple[str, int], dict] = {}

    with raw_jsonl.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            row = json.loads(line)
            class_space = row.get("classIdSpace")
            class_id = row.get("classId")
            if class_space is None or class_id is None:
                continue

            key = (str(class_space), int(class_id))
            bucket = stats.get(key)
            if bucket is None:
                bucket = {
                    "class_space": str(class_space),
                    "class_id": int(class_id),
                    "observed_count": 0,
                    "source_db_counts": Counter(),
                    "source_table_counts": Counter(),
                    "component_kind_counts": Counter(),
                    "interior_context_counts": Counter(),
                    "weenie_type_counts": Counter(),
                    "landblock_counts": Counter(),
                }
                stats[key] = bucket

            bucket["observed_count"] += 1
            bucket["source_db_counts"][row.get("sourceDb") or "unknown"] += 1
            bucket["source_table_counts"][row.get("sourceTable") or "unknown"] += 1
            bucket["component_kind_counts"][row.get("envCellComponentKind") or "none"] += 1
            bucket["interior_context_counts"][parse_cell_context(row.get("cellId"))] += 1
            bucket["landblock_counts"][f"{row.get('landblockX')},{row.get('landblockY')}"] += 1

            weenie_type = row.get("typeId") or row.get("weenieType")
            if weenie_type is not None:
                bucket["weenie_type_counts"][int(weenie_type)] += 1

    for (class_space, class_id), bucket in sorted(stats.items(), key=lambda item: (-item[1]["observed_count"], item[0][0], item[0][1])):
        ace_name = ace_names.get(class_id) if class_space == "wcid" else None
        lsd_meta = lsd_weenies.get(class_id) if class_space == "wcid" else None
        lsd_name = lsd_meta.get("lsd_name") if lsd_meta else None
        normalized_ace_name = normalize_ace_name(ace_name) if ace_name else None
        preferred_name = lsd_name or normalized_ace_name

        yield {
            "class_space": class_space,
            "class_id": class_id,
            "observed_count": bucket["observed_count"],
            "preferred_name": preferred_name,
            "ace_class_name": ace_name,
            "ace_friendly_name": normalized_ace_name,
            "lsd_name": lsd_name,
            "lsd_file": lsd_meta.get("lsd_file") if lsd_meta else None,
            "observed_weenie_type": bucket["weenie_type_counts"].most_common(1)[0][0] if bucket["weenie_type_counts"] else None,
            "observed_weenie_type_counts": compact_counter(bucket["weenie_type_counts"]),
            "source_db_counts": compact_counter(bucket["source_db_counts"]),
            "source_table_counts": compact_counter(bucket["source_table_counts"]),
            "component_kind_counts": compact_counter(bucket["component_kind_counts"]),
            "interior_context_counts": compact_counter(bucket["interior_context_counts"]),
            "top_landblocks": compact_counter(bucket["landblock_counts"]),
            "source_of_name": "lsd" if lsd_name else ("ace_enum" if ace_name else None),
            "source_of_type": "world_facts" if bucket["weenie_type_counts"] else (("lsd" if lsd_meta and lsd_meta.get("lsd_weenie_type") is not None else None)),
            "grounding_confidence": infer_confidence(class_space, ace_name, lsd_name),
        }


def write_outputs(rows: list[dict], out_jsonl: Path, out_csv: Path) -> None:
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)
    out_csv.parent.mkdir(parents=True, exist_ok=True)

    with out_jsonl.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")

    csv_fields = [
        "class_space",
        "class_id",
        "observed_count",
        "preferred_name",
        "ace_class_name",
        "ace_friendly_name",
        "lsd_name",
        "lsd_file",
        "observed_weenie_type",
        "source_of_name",
        "source_of_type",
        "grounding_confidence",
    ]
    with out_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=csv_fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in csv_fields})


def main() -> None:
    args = parse_args()
    ace_names = parse_ace_enum(args.ace_enum)
    lsd_weenies = parse_lsd_weenies(args.lsd_weenies)
    rows = list(build_rows(args.raw_jsonl, ace_names, lsd_weenies))
    write_outputs(rows, args.out_jsonl, args.out_csv)
    print(f"Wrote {len(rows)} grounding rows")
    print(f"  JSONL: {args.out_jsonl}")
    print(f"  CSV:   {args.out_csv}")


if __name__ == "__main__":
    main()
