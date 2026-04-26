#!/usr/bin/env python3
import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

EXTRACT_TOWN_WORLD = ROOT / "scripts" / "PopulationPipeline" / "WorldGrammar" / "extract_town_world_data.py"
EXTRACT_COMPONENT = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "extract_component_linked_tensors.py"

DEFAULT_TOWN_RAW = REFERENCE_DIR / "world_grammar_town_surface_raw_world_facts.jsonl"
DEFAULT_TOWN_COMPONENT = REFERENCE_DIR / "world_grammar_town_surface_envcell_components.jsonl"
DEFAULT_TOWN_MANIFEST = REFERENCE_DIR / "world_grammar_town_surface_manifest.json"
DEFAULT_OUT_NPZ = REFERENCE_DIR / "world_grammar_town_component_linked_abstract_ace_tensors.npz"
DEFAULT_OUT_VOCAB = REFERENCE_DIR / "world_grammar_town_component_linked_abstract_ace_vocab.json"


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

    sys.argv = [sys.argv[0], *original_argv]
    world_args = [str(EXTRACT_TOWN_WORLD), *_passthrough_flags("--town-name", "--exclude-town")]
    if _has_flag("--include-interiors"):
        world_args.append("--include-interiors")
    if not _has_flag("--out-raw-jsonl"):
        world_args.extend(["--out-raw-jsonl", str(DEFAULT_TOWN_RAW)])
    if not _has_flag("--out-component-jsonl"):
        world_args.extend(["--out-component-jsonl", str(DEFAULT_TOWN_COMPONENT)])
    if not _has_flag("--out-summary"):
        world_args.extend(["--out-summary", str(DEFAULT_TOWN_MANIFEST)])

    sys.argv = world_args
    runpy.run_path(str(EXTRACT_TOWN_WORLD), run_name="__main__")

    sys.argv = [sys.argv[0], *original_argv]
    tensor_args = [str(EXTRACT_COMPONENT)]
    tensor_args.extend(["--raw-jsonl", str(DEFAULT_TOWN_RAW)])
    tensor_args.extend(["--component-jsonl", str(DEFAULT_TOWN_COMPONENT)])
    if not _has_flag("--target-token-mode"):
        tensor_args.extend(["--target-token-mode", "abstract_ace"])
    if not _has_flag("--out-npz"):
        tensor_args.extend(["--out-npz", str(DEFAULT_OUT_NPZ)])
    if not _has_flag("--out-vocab"):
        tensor_args.extend(["--out-vocab", str(DEFAULT_OUT_VOCAB)])
    tensor_args.extend(_passthrough_flags("--views-per-landblock", "--target-token-mode", "--out-npz", "--out-vocab"))

    sys.argv = tensor_args
    runpy.run_path(str(EXTRACT_COMPONENT), run_name="__main__")


if __name__ == "__main__":
    main()
