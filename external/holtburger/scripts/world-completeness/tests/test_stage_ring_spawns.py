"""
Determinism + filtering tests for `stage-ring-spawns.py`.

The script's docstring promises:
  "byte-identical output across runs given the same input. We sort records
   within each LB by (cell, x, y, z, wcid)..."

These tests prove that contract.

Environment
-----------
Written for Python's stdlib `unittest` (pytest is not installed in this
repo's Python env; no pip available). `pytest` will still collect+run
`unittest.TestCase` classes natively if it ever lands. Run with either:

    python3 -m unittest scripts/world-completeness/tests/test_stage_ring_spawns.py -v
    pytest    scripts/world-completeness/tests/test_stage_ring_spawns.py -v

Scratch
-------
Per memory `feedback_use_external_drives_for_scratch`, when
`/mnt/wbterminal1/tmp/claude-scratch/` exists we drop test work there;
otherwise we fall back to `tempfile.TemporaryDirectory()`.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "world-completeness" / "stage-ring-spawns.py"

EXTERNAL_SCRATCH = Path("/mnt/wbterminal1/tmp/claude-scratch")


def _make_record(wcid: int, landblock_id: int, cell: int,
                 x: float, y: float, z: float,
                 name: str = "") -> dict:
    return {
        "wcid": wcid,
        "name": name,
        "category": "Creature",
        "weenieType": 10,
        "landblockId": landblock_id,
        "cell": cell,
        "x": x,
        "y": y,
        "z": z,
        "isServerManaged": True,
        "orientation": {"isIdentity": True},
    }


def _build_fixture_records() -> list[dict]:
    """30 records spanning 5 in-ring LBs + 4 out-of-ring LBs.

    Each in-ring LB has multiple spawns so sort order is meaningful.
    Includes (cell, x, y, z, wcid) collisions where only the trailing
    key disambiguates -- exercises every level of the sort tuple.
    """
    recs: list[dict] = []

    LB_HOLTBURG = (0xA9 << 8) | 0xB4
    LB_SW_CORNER = (0xA3 << 8) | 0xAE
    LB_NE_CORNER = (0xAF << 8) | 0xBA
    LB_MID = (0xAC << 8) | 0xB7
    LB_ADJ = (0xA9 << 8) | 0xB3

    recs += [
        _make_record(7978, LB_HOLTBURG, 0, 130.239, 104.9, 46.005, "Scrawed Grievver"),
        _make_record(31, LB_HOLTBURG, 0, 80.0, 80.0, 50.0, "Trader"),
        _make_record(31, LB_HOLTBURG, 0, 80.0, 80.0, 50.0, "Trader (dup pos, lower wcid)"),
        _make_record(32, LB_HOLTBURG, 0, 80.0, 80.0, 50.0, "Trader (dup pos, higher wcid)"),
        _make_record(7978, LB_HOLTBURG, 0, 130.239, 104.9, 47.005, "Higher z"),
        _make_record(99, LB_HOLTBURG, 256, 10.0, 20.0, 30.0, "Indoor cell 0x100"),
        _make_record(99, LB_HOLTBURG, 257, 10.0, 20.0, 30.0, "Indoor cell 0x101"),
        _make_record(50, LB_HOLTBURG, 0, 50.0, 60.0, 70.0, "Outdoor mid"),
    ]

    recs += [
        _make_record(100, LB_SW_CORNER, 0, 10.0, 10.0, 10.0, "SW corner A"),
        _make_record(101, LB_SW_CORNER, 0, 10.0, 10.0, 10.0, "SW corner B same pos"),
        _make_record(102, LB_SW_CORNER, 0, 20.0, 10.0, 10.0, "SW corner higher x"),
        _make_record(103, LB_SW_CORNER, 1, 5.0, 5.0, 5.0, "SW corner cell 1"),
    ]

    recs += [
        _make_record(200, LB_NE_CORNER, 0, 50.0, 60.0, 70.0, "NE corner A"),
        _make_record(201, LB_NE_CORNER, 0, 50.0, 61.0, 70.0, "NE corner higher y"),
        _make_record(202, LB_NE_CORNER, 0, 50.0, 60.0, 80.0, "NE corner higher z"),
    ]

    recs += [
        _make_record(300, LB_MID, 0, 100.0, 100.0, 100.0, "Mid A"),
        _make_record(301, LB_MID, 0, 100.0, 100.0, 101.0, "Mid B"),
        _make_record(302, LB_MID, 5, 0.0, 0.0, 0.0, "Mid cell 5"),
        _make_record(303, LB_MID, 2, 0.0, 0.0, 0.0, "Mid cell 2"),
    ]

    recs += [
        _make_record(400, LB_ADJ, 0, 1.0, 2.0, 3.0, "Adj A"),
        _make_record(401, LB_ADJ, 0, 1.0, 2.0, 3.0, "Adj B same pos"),
        _make_record(402, LB_ADJ, 0, 2.0, 2.0, 3.0, "Adj higher x"),
        _make_record(403, LB_ADJ, 0, 1.0, 3.0, 3.0, "Adj higher y"),
    ]

    return recs


def _build_out_of_ring_records() -> list[dict]:
    """Records the filter MUST drop -- one per boundary direction."""
    LB_X_BELOW = (0xA2 << 8) | 0xB4
    LB_X_ABOVE = (0xB0 << 8) | 0xB4
    LB_Y_BELOW = (0xA9 << 8) | 0xAD
    LB_Y_ABOVE = (0xA9 << 8) | 0xBB
    return [
        _make_record(9001, LB_X_BELOW, 0, 1.0, 1.0, 1.0, "x=162 below range"),
        _make_record(9002, LB_X_ABOVE, 0, 1.0, 1.0, 1.0, "x=176 above range"),
        _make_record(9003, LB_Y_BELOW, 0, 1.0, 1.0, 1.0, "y=173 below range"),
        _make_record(9004, LB_Y_ABOVE, 0, 1.0, 1.0, 1.0, "y=187 above range"),
    ]


def _write_jsonl(path: Path, recs: list[dict]) -> None:
    with path.open("w") as f:
        for r in recs:
            f.write(json.dumps(r))
            f.write("\n")


def _run_script(source: Path, out_dir: Path) -> subprocess.CompletedProcess:
    weenie_index = source.parent / "weenie_index_missing.jsonl"
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--source", str(source),
            "--out", str(out_dir),
            "--weenie-index", str(weenie_index),
        ],
        capture_output=True,
        text=True,
        check=True,
    )


def _scratch_root() -> Path:
    if EXTERNAL_SCRATCH.is_dir():
        root = EXTERNAL_SCRATCH / "test_stage_ring_spawns"
        root.mkdir(parents=True, exist_ok=True)
        return root
    return Path(tempfile.gettempdir())


class StageRingSpawnsTests(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="srs-", dir=_scratch_root())
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.tmp_path = Path(self.tmp)

    def _read_all_lb_outputs(self, out_dir: Path) -> dict[str, bytes]:
        return {
            p.name: p.read_bytes()
            for p in sorted(out_dir.glob("*.spawns.jsonl"))
        }

    def test_determinism_under_shuffle(self) -> None:
        """Shuffling input line order MUST yield byte-identical output."""
        recs = _build_fixture_records() + _build_out_of_ring_records()

        src_a = self.tmp_path / "src_a.jsonl"
        src_b = self.tmp_path / "src_b.jsonl"
        _write_jsonl(src_a, recs)

        rng = random.Random(20260519)
        shuffled = list(recs)
        rng.shuffle(shuffled)
        self.assertNotEqual(
            [r["wcid"] for r in recs],
            [r["wcid"] for r in shuffled],
            "shuffle produced identical order; pick a different seed",
        )
        _write_jsonl(src_b, shuffled)

        out_a = self.tmp_path / "out_a"
        out_b = self.tmp_path / "out_b"
        _run_script(src_a, out_a)
        _run_script(src_b, out_b)

        lb_outputs_a = self._read_all_lb_outputs(out_a)
        lb_outputs_b = self._read_all_lb_outputs(out_b)

        self.assertEqual(
            sorted(lb_outputs_a.keys()),
            sorted(lb_outputs_b.keys()),
            "the set of per-LB output filenames differs between runs",
        )

        for name in lb_outputs_a:
            self.assertEqual(
                lb_outputs_a[name],
                lb_outputs_b[name],
                f"per-LB output {name} differs byte-for-byte after shuffle",
            )

        sha_a = (out_a / "source.sha256").read_bytes()
        sha_b = (out_b / "source.sha256").read_bytes()
        self.assertNotEqual(
            sha_a, sha_b,
            "source.sha256 should differ -- it covers input file bytes, which "
            "include line order. Per-LB outputs are what need to match.",
        )

        populated_a = [n for n, b in lb_outputs_a.items() if b]
        self.assertGreaterEqual(
            len(populated_a), 5,
            "fixture should populate 5 in-ring LBs",
        )

    def test_filtering_outside_ring(self) -> None:
        """Records outside x in 163..=175 OR y in 174..=186 MUST be dropped."""
        in_ring = _build_fixture_records()
        out_ring = _build_out_of_ring_records()
        src = self.tmp_path / "src.jsonl"
        _write_jsonl(src, in_ring + out_ring)

        out_dir = self.tmp_path / "out"
        _run_script(src, out_dir)

        out_of_ring_wcids = {r["wcid"] for r in out_ring}
        out_of_ring_lbs = {r["landblockId"] for r in out_ring}

        ring_x = set(range(163, 176))
        ring_y = set(range(174, 187))
        for lb in out_of_ring_lbs:
            cx, cy = (lb >> 8) & 0xFF, lb & 0xFF
            self.assertFalse(
                cx in ring_x and cy in ring_y,
                f"fixture bug: out-of-ring LB 0x{lb:04X} is actually in the ring",
            )

        kept_wcids: set[int] = set()
        all_files = sorted(out_dir.glob("*.spawns.jsonl"))
        self.assertEqual(
            len(all_files), 169,
            "ring is 13x13 = 169 LBs -- every LB gets a (possibly empty) file",
        )
        for f in all_files:
            for line in f.read_text().splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                kept_wcids.add(rec["wcid"])

        for w in out_of_ring_wcids:
            self.assertNotIn(
                w, kept_wcids,
                f"wcid {w} from out-of-ring LB leaked into a staged file",
            )

        in_ring_wcids = {r["wcid"] for r in in_ring}
        for w in in_ring_wcids:
            self.assertIn(
                w, kept_wcids,
                f"wcid {w} from in-ring LB is missing from output",
            )

    def test_empty_input(self) -> None:
        """Empty JSONL -> 169 empty per-LB files (the script's contract)."""
        src = self.tmp_path / "empty.jsonl"
        src.write_text("")

        out_dir = self.tmp_path / "out_empty"
        _run_script(src, out_dir)

        all_files = sorted(out_dir.glob("*.spawns.jsonl"))
        self.assertEqual(
            len(all_files), 169,
            "empty input still yields one file per ring LB",
        )
        for f in all_files:
            self.assertEqual(
                f.read_bytes(), b"",
                f"empty input must produce empty file, got data in {f.name}",
            )

        self.assertTrue((out_dir / "source.sha256").exists())
        self.assertTrue((out_dir / "README.md").exists())

    def test_within_lb_sort_order(self) -> None:
        """Verify the documented sort key (cell, x, y, z, wcid) is applied.

        Reads back one LB's records and asserts they are non-decreasing on
        the documented tuple key.
        """
        recs = _build_fixture_records()
        src = self.tmp_path / "src.jsonl"
        _write_jsonl(src, recs)

        out_dir = self.tmp_path / "out"
        _run_script(src, out_dir)

        LB_HOLTBURG = (0xA9 << 8) | 0xB4
        f = out_dir / f"0x{LB_HOLTBURG:04X}.spawns.jsonl"
        self.assertTrue(f.exists())

        lines = [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
        self.assertGreaterEqual(len(lines), 5)

        keys = [(r["cell"], r["x"], r["y"], r["z"], r["wcid"]) for r in lines]
        self.assertEqual(
            keys, sorted(keys),
            "Holtburg LB output is not sorted by (cell, x, y, z, wcid)",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
