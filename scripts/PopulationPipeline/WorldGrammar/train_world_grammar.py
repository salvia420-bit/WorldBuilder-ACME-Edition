#!/usr/bin/env python3
import os
import runpy
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
OUTDOORML_TRAIN = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "train_scene_placer.py"
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

WORLD_TENSOR = REFERENCE_DIR / "world_grammar_component_linked_abstract_ace_tensors.npz"
WORLD_VOCAB = REFERENCE_DIR / "world_grammar_component_linked_abstract_ace_vocab.json"
LEGACY_TENSOR = REFERENCE_DIR / "component_linked_abstract_ace_tensors.npz"
LEGACY_VOCAB = REFERENCE_DIR / "component_linked_abstract_ace_vocab.json"


def _pick_path(primary: Path, fallback: Path) -> str:
    return str(primary if primary.exists() else fallback)


def _has_flag(flag: str) -> bool:
    return any(arg == flag or arg.startswith(flag + "=") for arg in sys.argv[1:])


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def main() -> None:
    argv = [str(OUTDOORML_TRAIN), *sys.argv[1:]]

    if not _has_flag("--tensor-path"):
        argv.extend(["--tensor-path", _pick_path(WORLD_TENSOR, LEGACY_TENSOR)])
    if not _has_flag("--vocab-path"):
        argv.extend(["--vocab-path", _pick_path(WORLD_VOCAB, LEGACY_VOCAB)])
    if not _has_flag("--run-name"):
        argv.extend(["--run-name", f"world_grammar_component_linked_abstract_ace_{_timestamp()}"])

    sys.argv = argv
    runpy.run_path(str(OUTDOORML_TRAIN), run_name="__main__")


if __name__ == "__main__":
    main()

