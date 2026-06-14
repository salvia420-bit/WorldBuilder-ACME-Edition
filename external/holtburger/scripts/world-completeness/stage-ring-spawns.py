#!/usr/bin/env python3
"""
Phase D.1.a — stage the 13x13 ring's ACE landblock_instance spawn records.

Mirrors the Phase C.1 scenery-bake staging pattern (one JSONL per LB,
hex-named, plus a bake-source sha256 sidecar). Output layout:

  /mnt/wbterminal1/holtburger-dist-v2/spawns/
    source.sha256                    # sha256 of input JSONL
    0xA9B4.spawns.jsonl              # 106 records for Holtburg
    0xA9B0.spawns.jsonl              # 13 records for South Outpost
    ...                              # one per LB in the 13x13 ring
    README.md                        # schema notes

Empty JSONL files are emitted for LBs with zero ring matches — this
gives the runtime an unambiguous "this LB has been queried, zero
spawns" signal (vs 404 "this LB hasn't been baked yet").

Filter range (matches the Phase C ring driver):
  landblockId in {(x<<8)|y for x in 163..=175, y in 174..=186}

Run:
  python3 stage-ring-spawns.py
  python3 stage-ring-spawns.py --source /path/to/ace_spawn_records.jsonl
  python3 stage-ring-spawns.py --out /path/to/spawns

Determinism contract: byte-identical output across runs given the same
input. We sort records within each LB by (cell, x, y, z, wcid) so the
JSONL output doesn't drift on the JSONL line order in the source file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


# 13x13 ring centred on Holtburg (LB 0xA9B4 = cell_x 0xA9 = 169,
# cell_y 0xB4 = 180). 169 LBs total, matches the Phase C.1 scenery
# bake's ring.
RING_X_RANGE = range(163, 176)   # inclusive 163..=175
RING_Y_RANGE = range(174, 187)   # inclusive 174..=186

DEFAULT_SOURCE = "/home/wbterminal/projects/RetailSmoke/ace_spawn_records.jsonl"

# Single canonical baked-data root (see scripts/serve.py). All layers stage as
# real subdirs of it; the legacy HOLTBURGER_DIST_V2 is honoured as a fallback.
HOLTBURGER_DIST = (
    os.environ.get("HOLTBURGER_DIST")
    or os.environ.get("HOLTBURGER_DIST_V2")
    or "/mnt/wbterminal2/holtburger-dist"
)
DEFAULT_OUT = os.path.join(HOLTBURGER_DIST, "spawns")
DEFAULT_WEENIE_INDEX = "/home/wbterminal/projects/RetailSmoke/weenie_index.jsonl"


def lb_hex(landblock_id: int) -> str:
    """Render `landblockId` (e.g. 43444 = 0xA9B4) as 0xXXXX."""
    return f"0x{landblock_id:04X}"


def ring_lb_set() -> set[int]:
    """Build the 169-element ring set."""
    out: set[int] = set()
    for x in RING_X_RANGE:
        for y in RING_Y_RANGE:
            out.add((x << 8) | y)
    return out


def sha256_file(path: Path) -> str:
    """SHA-256 of a file's bytes (used for source.sha256 sidecar)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalise_record(rec: dict) -> dict:
    """Project a source JSONL record to the wire-shape we stage.

    Pulls only fields the renderer's synthetic-spawn injector reads.
    Coordinates are LB-local metres (same convention as
    LandblockInfo.objects + scenery bake).

    Orientation: when the source carries explicit per-axis quaternion
    components (`qw/qx/qy/qz` — added by the angle-merge from ACE
    `landblock_instance.angles_*`), we emit them so the wasm
    `EntitySpawnJsonRaw` parser (optional qw/qx/qy/qz, `#[serde(default)]`)
    and `scene3d/spawns.js::buildUpd` render the REAL rotation. Identity
    placements (and pre-merge sources that only ship `{isIdentity}`) omit
    the quat — the parser defaults to qw=1 — keeping files lean and
    backward-compatible.
    """
    out = {
        "wcid": rec["wcid"],
        "name": rec.get("name", ""),
        "category": rec.get("category", ""),
        "weenieType": rec.get("weenieType", 0),
        "landblockId": rec["landblockId"],
        "cell": rec.get("cell", 0),
        "x": rec["x"],
        "y": rec["y"],
        "z": rec["z"],
        "isServerManaged": bool(rec.get("isServerManaged", True)),
        "orientationIsIdentity": bool(rec.get("orientation", {}).get("isIdentity", False)),
    }
    qw = rec.get("qw")
    if qw is not None:
        qx = rec.get("qx", 0.0)
        qy = rec.get("qy", 0.0)
        qz = rec.get("qz", 0.0)
        # Skip identity (qw=1, rest 0) — the parser defaults to it; omit
        # to keep the staged JSONL lean.
        if not (abs(qw - 1.0) < 1e-6 and abs(qx) < 1e-6
                and abs(qy) < 1e-6 and abs(qz) < 1e-6):
            out["qw"] = qw
            out["qx"] = qx
            out["qy"] = qy
            out["qz"] = qz
    return out


def write_lb_jsonl(out_dir: Path, lb: int, records: list[dict]) -> None:
    """Write one LB's JSONL, sorted deterministically.

    Sort key: (cell, x, y, z, wcid). Stable across re-runs given the
    same source JSONL. The empty-file invariant: every LB in the ring
    gets a file, even when records is [].
    """
    records.sort(key=lambda r: (r["cell"], r["x"], r["y"], r["z"], r["wcid"]))
    path = out_dir / f"{lb_hex(lb)}.spawns.jsonl"
    # Strict JSON serialisation — sort_keys for byte-identical output
    # across Python releases that may shuffle dict insertion order.
    with path.open("w") as f:
        for r in records:
            f.write(json.dumps(r, sort_keys=True))
            f.write("\n")

    # Wave-4.B (2026-05-23) — per-LB sha256 sidecar. Consumed by the
    # holtburger-web `__diag.integrity.verifyManifests({landblocks:[...]})`
    # surface: client fetches the JSONL + sidecar, hashes the bytes, and
    # asserts the digest matches. Catches network corruption, modder
    # tampering downstream of the bake, and stale CDN caches.
    sha = sha256_file(path)
    (path.parent / f"{path.name}.sha256").write_text(sha + "\n")


def write_readme(out_dir: Path) -> None:
    """Schema doc — explains what the JSONL means and how to consume it."""
    content = """# Phase D.1 — staged ACE spawn records for the 13x13 Holtburg ring

Each `0xXXXX.spawns.jsonl` file contains the ACE `landblock_instance`
spawn records for one landblock, filtered from the world-wide dump at
`/home/wbterminal/projects/RetailSmoke/ace_spawn_records.jsonl`.

## Ring

13 x 13 landblocks centred on Holtburg (LB 0xA9B4 = cell_x 0xA9,
cell_y 0xB4). Mirrors the Phase C.1 scenery bake's ring.

## Schema (per JSONL line)

```jsonc
{
  "wcid":          7978,              // ACE weenie classification ID
  "name":          "Scrawed Grievver",
  "category":      "Creature",         // Creature, Object, NPC, ...
  "weenieType":    10,                // ACE WeenieType enum
  "landblockId":   43444,             // (cell_x << 8) | cell_y
  "cell":          0,                 // intra-LB cell index (0 = outdoor)
  "x":             130.239,           // LB-local metres
  "y":             104.9,
  "z":             46.005,
  "isServerManaged": true,            // ACE manages lifecycle (vs DAT static)
  "orientationIsIdentity": false      // true => use identity quat
}
```

## Notes

- **Orientation is dropped.** The source JSONL has only
  `orientation: {isIdentity: bool}` — no per-axis quaternion
  components. The injector emits identity quat (qw=1). A future
  re-run of the dumper can include full quaternion fields without
  schema breakage.
- **Empty files are intentional.** 125 of 169 LBs in the ring have
  zero spawns. The runtime treats "empty body" as
  "queried, zero spawns" (not 404 "not yet baked").
- **wcid alone doesn't render an entity.** The renderer needs a
  `setupDid` (`csetup_id`) — we resolve it via the weenie_index at
  injection time, not in this stage.
- **The wire-position injector mirrors handleEntitySpawn(upd).** See
  `scene3d/spawns.js::ensureSpawnsForLandblock`.

## Reproducibility

```sh
python3 stage-ring-spawns.py
```

Deterministic given the same input JSONL (records sorted by
`(cell, x, y, z, wcid)` within each LB). The output `source.sha256`
covers the input JSONL so a manifest consumer can verify it has the
same spawn snapshot.
"""
    (out_dir / "README.md").write_text(content)


def write_wcid_to_setup(out_dir: Path, ring_wcids: set[int],
                         weenie_index_path: Path) -> dict:
    """Stage a `wcid_to_setup.json` mapping for the ring's wcids.

    The renderer's synthetic injector reads this to resolve a SetupModel
    DID (0x02xxxxxx) for each spawn record — the JSONL itself doesn't
    carry the setup_id. Filtered to ring wcids only so the file stays
    tiny (~4 KB for the 13x13 ring vs ~1 MB for all 43k weenies).

    Returns a stats dict (entry counts, miss list).
    """
    if not weenie_index_path.exists():
        return {"missing_input": True, "entries": 0, "missing_wcids": list(ring_wcids)}

    wcid_to_setup: dict[int, int] = {}
    with weenie_index_path.open() as f:
        for line in f:
            line = line.strip().lstrip("﻿")
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            setup = rec.get("setupDid")
            if setup:
                wcid_to_setup[rec["wcid"]] = setup

    out_map: dict[str, int] = {}
    missing: list[int] = []
    for w in sorted(ring_wcids):
        setup = wcid_to_setup.get(w)
        if setup:
            out_map[str(w)] = setup
        else:
            missing.append(w)

    (out_dir / "wcid_to_setup.json").write_text(
        json.dumps(out_map, sort_keys=True, indent=2)
    )

    return {
        "entries": len(out_map),
        "missing_wcids": missing,
        "missing_input": False,
    }


def stage_spawns(source_path: Path, out_dir: Path,
                  weenie_index_path: Path, all_world: bool = False) -> dict:
    """Read source JSONL, partition by LB into per-LB files, write sha256.

    Ring mode (default): keep only the 13x13 Holtburg ring, pre-seeding an
    empty file for every ring LB. World mode (`all_world=True`): keep EVERY
    landblock present in the source, emitting a file only for LBs that have
    spawns (unpopulated LBs 404 -> the loader fail-softs to "no spawns",
    which is correct). Returns a stats dict for logging.
    """
    if not source_path.exists():
        raise SystemExit(f"FAIL: source missing: {source_path}")
    out_dir.mkdir(parents=True, exist_ok=True)

    ring = None if all_world else ring_lb_set()
    # World mode pre-seeds the 13x13 ring as empties so the whole-world bake is
    # a strict SUPERSET of the legacy ring bake (every ring LB keeps a
    # file + sidecar; other populated LBs are added on first record;
    # unpopulated non-ring LBs 404 -> loader fail-softs to "no spawns").
    per_lb: dict[int, list[dict]] = (
        {lb: [] for lb in ring_lb_set()} if all_world else {lb: [] for lb in ring}
    )
    ring_wcids: set[int] = set()
    total_seen = 0
    total_kept = 0

    with source_path.open() as f:
        for line in f:
            line = line.strip().lstrip("﻿")
            if not line:
                continue
            total_seen += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"WARN: bad json on line {total_seen}: {e}", file=sys.stderr)
                continue
            lb = rec.get("landblockId")
            if ring is not None:
                if lb not in ring:
                    continue
            else:
                if not isinstance(lb, int):
                    continue
                per_lb.setdefault(lb, [])
            total_kept += 1
            per_lb[lb].append(normalise_record(rec))
            ring_wcids.add(rec["wcid"])

    # Write per-LB files (empties included)
    populated = 0
    empty = 0
    for lb in sorted(per_lb.keys()):
        recs = per_lb[lb]
        write_lb_jsonl(out_dir, lb, recs)
        if recs:
            populated += 1
        else:
            empty += 1

    # Source sha256 sidecar — auditable provenance for manifest
    # consumers (Phase E will verify against expected hashes).
    src_sha = sha256_file(source_path)

    wcid_stats = write_wcid_to_setup(out_dir, ring_wcids, weenie_index_path)

    scope = "world" if ring is None else "ring"
    lb_count = len(per_lb) if ring is None else len(ring)
    range_lines = (
        ""
        if ring is None
        else (
            f"ring-x-range\t{RING_X_RANGE.start}..={RING_X_RANGE.stop - 1}\n"
            f"ring-y-range\t{RING_Y_RANGE.start}..={RING_Y_RANGE.stop - 1}\n"
        )
    )
    (out_dir / "source.sha256").write_text(
        f"{source_path.name}\t{src_sha}\n"
        f"bake-tool-version\tstage-ring-spawns.py/0.2.0\n"
        f"scope\t{scope}\n"
        + range_lines
        + f"lb-count\t{lb_count}\n"
        f"populated-lbs\t{populated}\n"
        f"empty-lbs\t{empty}\n"
        f"total-records\t{total_kept}\n"
        f"unique-wcids\t{len(ring_wcids)}\n"
        f"wcid-to-setup-entries\t{wcid_stats['entries']}\n"
        f"wcid-to-setup-missing\t{len(wcid_stats['missing_wcids'])}\n"
    )

    write_readme(out_dir)

    return {
        "total_seen": total_seen,
        "total_kept": total_kept,
        "ring_size": lb_count,
        "ring_wcids": len(ring_wcids),
        "populated": populated,
        "empty": empty,
        "source_sha256": src_sha,
        "wcid_to_setup_entries": wcid_stats["entries"],
        "wcid_to_setup_missing": wcid_stats["missing_wcids"],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", default=DEFAULT_SOURCE,
                    help=f"Input JSONL path (default: {DEFAULT_SOURCE})")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help=f"Output dir (default: {DEFAULT_OUT})")
    ap.add_argument("--weenie-index", default=DEFAULT_WEENIE_INDEX,
                    help=f"Weenie index JSONL (default: {DEFAULT_WEENIE_INDEX})")
    ap.add_argument("--all-world", action="store_true",
                    help="Stage EVERY landblock present in the source (whole "
                         "world), not just the 13x13 Holtburg ring. Emits a "
                         "file only for LBs that have spawns.")
    args = ap.parse_args()

    src = Path(args.source)
    out = Path(args.out)
    weenie_index = Path(args.weenie_index)
    stats = stage_spawns(src, out, weenie_index, all_world=args.all_world)

    print(f"Phase D.1.a — staged spawn records")
    print(f"=================================")
    print(f"source            : {src}")
    print(f"out               : {out}")
    print(f"records scanned   : {stats['total_seen']}")
    print(f"records kept      : {stats['total_kept']}  (ring={stats['ring_size']})")
    print(f"  populated LBs   : {stats['populated']}")
    print(f"  empty LBs       : {stats['empty']}")
    print(f"ring unique wcids : {stats['ring_wcids']}")
    print(f"wcid_to_setup ents: {stats['wcid_to_setup_entries']}  "
          f"(missing={len(stats['wcid_to_setup_missing'])})")
    print(f"source.sha256     : {stats['source_sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
