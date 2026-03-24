#!/usr/bin/env python3
"""Compatibility wrapper for the staged Population Pipeline script."""

from pathlib import Path
import runpy


TARGET = Path(__file__).resolve().parent / "OutdoorML" / "housing_linker.py"

if __name__ == "__main__":
    runpy.run_path(str(TARGET), run_name="__main__")
else:
    globals().update(runpy.run_path(str(TARGET)))
