#!/usr/bin/env python3
import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

EXTRACT_TOWN_WORLD = ROOT / "scripts" / "PopulationPipeline" / "WorldGrammar" / "extract_town_world_data.py"
EXTRACT_INTERIOR_SUPPORT = ROOT / "scripts" / "PopulationPipeline" / "Interiors" / "extract_support_aware_interior_dataset.py"

DEFAULT_TOWN_RAW = REFERENCE_DIR / "world_grammar_town_with_interiors_raw_world_facts.jsonl"
DEFAULT_TOWN_COMPONENT = REFERENCE_DIR / "world_grammar_town_with_interiors_envcell_components.jsonl"
DEFAULT_TOWN_MANIFEST = REFERENCE_DIR / "world_grammar_town_with_interiors_manifest.json"

DEFAULT_OUT_SUPPORT_JSONL = REFERENCE_DIR / "town_interior_support_objects_highconf.jsonl"
DEFAULT_OUT_PROP_JSONL = REFERENCE_DIR / "town_interior_supported_props_highconf.jsonl"
DEFAULT_OUT_SILVER_JSONL = REFERENCE_DIR / "town_interior_supported_props_silver.jsonl"
DEFAULT_OUT_REVIEW_JSONL = REFERENCE_DIR / "town_interior_supported_prop_candidates_review.jsonl"
DEFAULT_OUT_CANDIDATES_JSONL = REFERENCE_DIR / "town_interior_supported_prop_candidates_ranked.jsonl"
DEFAULT_OUT_MOTIFS_JSONL = REFERENCE_DIR / "town_interior_supported_prop_motifs.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "town_interior_support_dataset_highconf_summary.json"


def _has_flag(flag: str) -> bool:
    return any(arg == flag or arg.startswith(flag + "=") for arg in sys.argv[1:])


def _passthrough_flags(*names: str) -> list[str]:
    out: list[str] = []
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        arg = argv[i]
        matched = next((name for name in names if arg == name or arg.startswith(name + "=")), None)
        if matched is None:
            i += 1
            continue
        out.append(arg)
        if arg == matched and i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            out.append(argv[i + 1])
            i += 2
        else:
            i += 1
    return out


def main() -> None:
    original_argv = sys.argv[1:]

    world_args = [
        str(EXTRACT_TOWN_WORLD),
        "--include-interiors",
        *_passthrough_flags("--town-name", "--exclude-town", "--fringe-radius"),
    ]
    if not _has_flag("--out-raw-jsonl"):
        world_args.extend(["--out-raw-jsonl", str(DEFAULT_TOWN_RAW)])
    if not _has_flag("--out-component-jsonl"):
        world_args.extend(["--out-component-jsonl", str(DEFAULT_TOWN_COMPONENT)])
    if not _has_flag("--out-summary"):
        world_args.extend(["--out-summary", str(DEFAULT_TOWN_MANIFEST)])

    sys.argv = world_args
    runpy.run_path(str(EXTRACT_TOWN_WORLD), run_name="__main__")

    interior_args = [str(EXTRACT_INTERIOR_SUPPORT)]
    interior_args.extend(["--raw-jsonl", str(DEFAULT_TOWN_RAW)])
    interior_args.extend(["--component-jsonl", str(DEFAULT_TOWN_COMPONENT)])
    if not _has_flag("--out-support-jsonl"):
        interior_args.extend(["--out-support-jsonl", str(DEFAULT_OUT_SUPPORT_JSONL)])
    if not _has_flag("--out-prop-jsonl"):
        interior_args.extend(["--out-prop-jsonl", str(DEFAULT_OUT_PROP_JSONL)])
    if not _has_flag("--out-silver-jsonl"):
        interior_args.extend(["--out-silver-jsonl", str(DEFAULT_OUT_SILVER_JSONL)])
    if not _has_flag("--out-review-jsonl"):
        interior_args.extend(["--out-review-jsonl", str(DEFAULT_OUT_REVIEW_JSONL)])
    if not _has_flag("--out-candidates-jsonl"):
        interior_args.extend(["--out-candidates-jsonl", str(DEFAULT_OUT_CANDIDATES_JSONL)])
    if not _has_flag("--out-motifs-jsonl"):
        interior_args.extend(["--out-motifs-jsonl", str(DEFAULT_OUT_MOTIFS_JSONL)])
    if not _has_flag("--out-summary-json"):
        interior_args.extend(["--out-summary-json", str(DEFAULT_OUT_SUMMARY_JSON)])

    interior_args.extend(
        _passthrough_flags(
            "--grounding-jsonl",
            "--wcid-types-json",
            "--canonical-enrichment-json",
            "--out-support-jsonl",
            "--out-prop-jsonl",
            "--out-silver-jsonl",
            "--out-review-jsonl",
            "--out-candidates-jsonl",
            "--out-motifs-jsonl",
            "--out-summary-json",
        )
    )

    sys.argv = interior_args
    runpy.run_path(str(EXTRACT_INTERIOR_SUPPORT), run_name="__main__")

    sys.argv = [sys.argv[0], *original_argv]


if __name__ == "__main__":
    main()
