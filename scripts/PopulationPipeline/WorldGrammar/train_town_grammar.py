#!/usr/bin/env python3
import runpy
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
TRAIN_WORLD = ROOT / "scripts" / "PopulationPipeline" / "WorldGrammar" / "train_world_grammar.py"
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

TOWN_TENSOR = REFERENCE_DIR / "world_grammar_town_component_linked_abstract_ace_tensors.npz"
TOWN_VOCAB = REFERENCE_DIR / "world_grammar_town_component_linked_abstract_ace_vocab.json"


def _has_flag(flag: str) -> bool:
    return any(arg == flag or arg.startswith(flag + "=") for arg in sys.argv[1:])


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def main() -> None:
    argv = [str(TRAIN_WORLD), *sys.argv[1:]]
    if not _has_flag("--tensor-path"):
        argv.extend(["--tensor-path", str(TOWN_TENSOR)])
    if not _has_flag("--vocab-path"):
        argv.extend(["--vocab-path", str(TOWN_VOCAB)])
    if not _has_flag("--run-name"):
        argv.extend(["--run-name", f"world_grammar_town_component_linked_abstract_ace_{_timestamp()}"])
    sys.argv = argv
    runpy.run_path(str(TRAIN_WORLD), run_name="__main__")


if __name__ == "__main__":
    main()
