#!/usr/bin/env python3
import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
OUTDOORML_EXTRACT = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "extract_component_linked_tensors.py"
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

DEFAULT_OUT_NPZ = REFERENCE_DIR / "world_grammar_component_linked_abstract_ace_tensors.npz"
DEFAULT_OUT_VOCAB = REFERENCE_DIR / "world_grammar_component_linked_abstract_ace_vocab.json"


def _has_flag(flag: str) -> bool:
    return any(arg == flag or arg.startswith(flag + "=") for arg in sys.argv[1:])


def main() -> None:
    argv = [str(OUTDOORML_EXTRACT), *sys.argv[1:]]

    if not _has_flag("--target-token-mode"):
        argv.extend(["--target-token-mode", "abstract_ace"])
    if not _has_flag("--out-npz"):
        argv.extend(["--out-npz", str(DEFAULT_OUT_NPZ)])
    if not _has_flag("--out-vocab"):
        argv.extend(["--out-vocab", str(DEFAULT_OUT_VOCAB)])

    sys.argv = argv
    runpy.run_path(str(OUTDOORML_EXTRACT), run_name="__main__")


if __name__ == "__main__":
    main()

