#!/usr/bin/env python3
"""test_dist_ssd.py — scripts/dist_ssd.py on throwaway trees (no real bake, no SSD).

    python3 scripts/test_dist_ssd.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TOOL = Path(__file__).resolve().parent / "dist_ssd.py"
failures = 0


def run(serve_root: Path, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, HB_SERVE_ROOT=str(serve_root))
    return subprocess.run([sys.executable, str(TOOL), *args], env=env, capture_output=True, text=True)


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"  {'ok ' if ok else 'FAIL'} {name}{'' if ok else '  ' + detail}")
    if not ok:
        failures += 1


def make_bake(root: Path, shared_layer: Path) -> None:
    (root / "shards" / "ab").mkdir(parents=True)
    (root / "shards" / "ab" / "ab01.bin").write_bytes(b"record-1")
    (root / "shards" / "cd").mkdir()
    (root / "shards" / "cd" / "cd02.bin").write_bytes(b"record-2")
    (root / "manifest").mkdir()
    (root / "manifest" / "eor-portal.bin").write_bytes(b"catalog")
    (root / "manifest.json").write_text('{"v":2}')
    (root / "_health.json").write_text("{}")  # serve.py's: never copied
    # A layer shared with the base bake through a symlink, as on the archive drive.
    shared_layer.mkdir(parents=True)
    (shared_layer / "0x0001.scenery.jsonl").write_text("{}\n")
    (shared_layer / "source.sha256").write_text("src\tabc\n")
    os.symlink(shared_layer, root / "scenery")


with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    bake = td / "archive" / "bake-a"
    make_bake(bake, td / "archive" / "base" / "scenery")
    serve = td / "ssd" / "dist"

    r = run(serve, "stage", str(bake), "--activate", "--min-free-gb", "0")
    check("stage + activate exits 0", r.returncode == 0, r.stderr)
    cur = serve / "current"
    check("current -> bake-a", cur.is_symlink() and os.readlink(cur) == "bake-a")
    check("records copied", (cur / "shards" / "ab" / "ab01.bin").read_bytes() == b"record-1")
    check("symlinked layer staged as a REAL dir", (serve / "bake-a" / "scenery").is_dir()
          and not (serve / "bake-a" / "scenery").is_symlink()
          and (serve / "bake-a" / "scenery" / "0x0001.scenery.jsonl").exists())
    check("_health.json not copied", not (serve / "bake-a" / "_health.json").exists())
    meta = json.loads((serve / "bake-a" / ".dist-ssd.json").read_text())
    check("provenance names the source", meta["source"] == str(bake.resolve()))

    r = run(serve, "check")
    check("check: fresh copy is ok (exit 0)", r.returncode == 0 and r.stderr.startswith("ok"), r.stderr)

    # A writer adds a record to the archive → stale.
    time.sleep(0.02)
    (bake / "shards" / "ab" / "ab03.bin").write_bytes(b"record-3")
    r = run(serve, "check")
    check("check: a new record in the archive → stale (exit 1)", r.returncode == 1 and r.stderr.startswith("stale"), r.stderr)
    # A layer sidecar rewritten in place → stale too.
    r = run(serve, "stage", "--activate", "--min-free-gb", "0")
    check("re-stage of the active copy (no SRC) exits 0", r.returncode == 0, r.stderr)
    check("re-stage picked up the new record", (cur / "shards" / "ab" / "ab03.bin").exists())
    check("check after re-stage is ok", run(serve, "check").returncode == 0)
    time.sleep(0.02)
    (td / "archive" / "base" / "scenery" / "source.sha256").write_text("src\tdef\n")
    check("check: a layer sidecar rewritten → stale", run(serve, "check").returncode == 1)

    # A second bake hardlinks every file it shares with the active copy.
    bake_b = td / "archive" / "bake-b"
    make_bake(bake_b, td / "archive" / "base-b" / "scenery")
    # Same bytes and mtime as the staged copy's (rsync's quick check) → hardlinked.
    m = os.stat(serve / "bake-a" / "shards" / "ab" / "ab01.bin").st_mtime_ns
    os.utime(bake_b / "shards" / "ab" / "ab01.bin", ns=(m, m))
    (bake_b / "shards" / "cd" / "cd02.bin").write_bytes(b"record-2-changed")
    r = run(serve, "stage", str(bake_b), "--min-free-gb", "0")
    check("stage bake-b exits 0 (not activated)", r.returncode == 0 and os.readlink(cur) == "bake-a", r.stderr)
    a1 = os.stat(serve / "bake-a" / "shards" / "ab" / "ab01.bin")
    b1 = os.stat(serve / "bake-b" / "shards" / "ab" / "ab01.bin")
    check("unchanged record is a HARDLINK to the active copy", a1.st_ino == b1.st_ino)
    check("changed record is its own file", (serve / "bake-b" / "shards" / "cd" / "cd02.bin").read_bytes() == b"record-2-changed"
          and (serve / "bake-a" / "shards" / "cd" / "cd02.bin").read_bytes() == b"record-2")

    r = run(serve, "activate", "bake-b")
    check("activate bake-b", r.returncode == 0 and os.readlink(cur) == "bake-b", r.stderr)
    r = run(serve, "prune", "--keep", "1")
    check("prune --keep 1 removes the inactive copy only", r.returncode == 0 and not (serve / "bake-a").exists()
          and (serve / "bake-b").exists(), r.stderr)
    check("hardlinked record survives the prune", (serve / "bake-b" / "shards" / "ab" / "ab01.bin").read_bytes() == b"record-1")

    # --bulk: a third bake pre-copied in inode order; unchanged files still hardlink.
    bake_c = td / "archive" / "bake-c"
    make_bake(bake_c, td / "archive" / "base-c" / "scenery")
    for rel in ("shards/ab/ab01.bin", "shards/cd/cd02.bin"):
        st = os.stat(serve / "bake-b" / rel)
        (bake_c / rel).write_bytes((serve / "bake-b" / rel).read_bytes())
        os.utime(bake_c / rel, ns=(st.st_mtime_ns, st.st_mtime_ns))
    (bake_c / "shards" / "ef").mkdir()
    (bake_c / "shards" / "ef" / "ef09.bin").write_bytes(b"record-9")
    r = run(serve, "stage", str(bake_c), "--bulk", "--min-free-gb", "0")
    check("stage --bulk exits 0", r.returncode == 0 and "bulk:" in r.stderr, r.stderr)
    check("--bulk copied the new record", (serve / "bake-c" / "shards" / "ef" / "ef09.bin").read_bytes() == b"record-9")
    check("--bulk left unchanged records as hardlinks",
          os.stat(serve / "bake-c" / "shards" / "cd" / "cd02.bin").st_ino == os.stat(serve / "bake-b" / "shards" / "cd" / "cd02.bin").st_ino)
    check("--bulk staged the symlinked layer", (serve / "bake-c" / "scenery" / "0x0001.scenery.jsonl").exists()
          and not (serve / "bake-c" / "scenery").is_symlink())
    check("--bulk leaves no temp files", not list((serve / "bake-c").rglob("*.bulk-tmp*")))

    # HBNS catalogs name the records: only those shards are staged.
    import struct
    bake_d = td / "archive" / "bake-d"
    make_bake(bake_d, td / "archive" / "base-d" / "scenery")
    h_ref = bytes(range(16)).hex()          # 000102…0f
    h_old = bytes(range(16, 32)).hex()      # 101112…1f
    for h in (h_ref, h_old):
        (bake_d / "shards" / h[:2]).mkdir(exist_ok=True)
        (bake_d / "shards" / h[:2] / f"{h}.bin").write_bytes(h.encode())
    def uleb(v):
        out = bytearray()
        while True:
            x = v & 0x7F
            v >>= 7
            out.append(x | (0x80 if v else 0))
            if not v:
                return bytes(out)
    cat = b"HBNS" + bytes([1, 0, 0, 0]) + struct.pack("<I", 1) + b"\0" * 4 + uleb(0x0E000001) + bytes.fromhex(h_ref) + uleb(32)
    (bake_d / "manifest" / "eor-portal.bin").write_bytes(cat)
    r = run(serve, "stage", str(bake_d), "--min-free-gb", "0")
    d = serve / "bake-d"
    check("catalog-referenced shard staged", r.returncode == 0 and (d / "shards" / h_ref[:2] / f"{h_ref}.bin").exists(), r.stderr)
    check("unreferenced shard NOT staged", not (d / "shards" / h_old[:2] / f"{h_old}.bin").exists())
    check("shards the catalog does not name (ab01) are not staged either", not (d / "shards" / "ab" / "ab01.bin").exists())
    check("the rest of the tree still staged", (d / "scenery" / "0x0001.scenery.jsonl").exists() and (d / "manifest.json").exists())
    # A copy holding an unreferenced shard (staged before the rule) loses it on re-stage.
    (d / "shards" / h_old[:2]).mkdir(exist_ok=True)
    (d / "shards" / h_old[:2] / f"{h_old}.bin").write_bytes(b"stale")
    r = run(serve, "stage", str(bake_d), "--min-free-gb", "0")
    check("re-stage removes an unreferenced shard from the copy", r.returncode == 0
          and not (d / "shards" / h_old[:2] / f"{h_old}.bin").exists() and "unreferenced" in r.stderr, r.stderr)
    r = run(serve, "stage", str(bake_d), "--name", "bake-d-all", "--all-shards", "--min-free-gb", "0")
    check("--all-shards stages every shard", r.returncode == 0 and (serve / "bake-d-all" / "shards" / h_old[:2] / f"{h_old}.bin").exists(), r.stderr)

    r = run(serve, "stage", str(bake), "--min-free-gb", "1000000")
    check("space guard refuses (exit 3) and leaves current alone", r.returncode == 3 and os.readlink(cur) == "bake-b", r.stderr)

    r = run(serve, "stage", str(td / "archive"), "--min-free-gb", "0")
    check("a dir without manifest.json is refused", r.returncode == 2)

    r = run(serve, "status")
    check("status lists the active copy", r.returncode == 0 and "* bake-b" in r.stdout, r.stdout)

print(f"\n{'FAILED' if failures else 'all passed'} ({failures} failure(s))")
sys.exit(1 if failures else 0)
