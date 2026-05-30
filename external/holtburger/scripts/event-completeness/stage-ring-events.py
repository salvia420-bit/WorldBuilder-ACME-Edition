#!/usr/bin/env python3
"""
Phase F.E.stage — stage the F.B per-LB event manifests into the
renderer-accessible v2 dist tree.

Mirrors Phase C.1 / D.1 staging (one JSONL per LB, hex-named, plus a
bake-source sha256 sidecar). Output layout:

  /mnt/wbterminal1/holtburger-dist-v2/events/
    event-bake-source.sha256         # copied verbatim from F.B output
    0xA3AE.events.jsonl              # one per LB in the 13x13 ring
    0xA3AF.events.jsonl
    ...
    0xAFBA.events.jsonl
    README.md                        # schema notes

Input source (frozen, read-only — the F.B bake at commit cc42434):

  /mnt/wbterminal1/tmp/claude-scratch/event-completeness/b/holtburg-ring/

Empty JSONL files are emitted for LBs whose F.B output didn't exist
(no ambient + no entity hooks). Same invariant as Phase D.1's spawn
staging: "every LB queried" is observable from the dist tree.

Run:
  python3 stage-ring-events.py
  python3 stage-ring-events.py --source /path/to/bake/dir
  python3 stage-ring-events.py --out /path/to/events
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
from pathlib import Path


# 13x13 ring centred on Holtburg (LB 0xA9B4 = cell_x 0xA9 = 169,
# cell_y 0xB4 = 180). 169 LBs total, matches Phases C.1 + D.1 staging.
RING_X_RANGE = range(0xA3, 0xB0)   # inclusive 0xA3..=0xAF == 163..=175
RING_Y_RANGE = range(0xAE, 0xBB)   # inclusive 0xAE..=0xBA == 174..=186

DEFAULT_SOURCE = (
    "/mnt/wbterminal1/tmp/claude-scratch/"
    "event-completeness/b/holtburg-ring"
)
# Single canonical baked-data root (see scripts/serve.py). All layers stage as
# real subdirs of it; the legacy HOLTBURGER_DIST_V2 is honoured as a fallback.
HOLTBURGER_DIST = (
    os.environ.get("HOLTBURGER_DIST")
    or os.environ.get("HOLTBURGER_DIST_V2")
    or "/mnt/wbterminal2/holtburger-dist"
)
DEFAULT_OUT = Path(HOLTBURGER_DIST) / "events"


def lb_hex(landblock_id: int) -> str:
    return f"0x{landblock_id:04X}"


def ring_lb_set() -> set[int]:
    out: set[int] = set()
    for x in RING_X_RANGE:
        for y in RING_Y_RANGE:
            out.add((x << 8) | y)
    return out


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def stage_ring(source: Path, out_dir: Path) -> dict:
    """Copy per-LB JSONLs from `source` into `out_dir`. Emit empty
    files for LBs with no F.B output. Copy the bake-source.sha256
    sidecar through verbatim. Return per-LB counts for the report.
    """
    if not source.is_dir():
        raise FileNotFoundError(f"source dir missing: {source}")
    out_dir.mkdir(parents=True, exist_ok=True)

    lbs = sorted(ring_lb_set())
    stats = {
        "ring_size": len(lbs),
        "with_events": 0,
        "empty_emitted": 0,
        "total_events": 0,
        "per_lb": {},
    }

    for lb in lbs:
        name = f"{lb_hex(lb)}.events.jsonl"
        src_path = source / name
        dst_path = out_dir / name
        if src_path.is_file():
            shutil.copyfile(src_path, dst_path)
            # Count newline-terminated event records. (Last line may
            # or may not have a trailing newline — handle both.)
            with src_path.open("rb") as f:
                raw = f.read()
            count = raw.count(b"\n")
            if raw and not raw.endswith(b"\n"):
                count += 1
            stats["with_events"] += 1
            stats["total_events"] += count
            stats["per_lb"][lb_hex(lb)] = count
        else:
            # Emit an explicit empty JSONL so the renderer can
            # distinguish "queried, zero events" from "not baked yet"
            # (404). Mirrors Phase D.1's empty-spawn-file convention.
            dst_path.write_bytes(b"")
            stats["empty_emitted"] += 1
            stats["per_lb"][lb_hex(lb)] = 0

    # Copy the bake-source.sha256 sidecar verbatim — the F.B bake
    # output already enumerates the DAT files + their hashes + the
    # bake-tool version. Renderer consumers can verify the manifest
    # matches their DATs before honouring it.
    src_sha = source / "event-bake-source.sha256"
    dst_sha = out_dir / "event-bake-source.sha256"
    if src_sha.is_file():
        shutil.copyfile(src_sha, dst_sha)
        stats["sha256_copied"] = True
        stats["sha256_size"] = src_sha.stat().st_size
    else:
        stats["sha256_copied"] = False
        stats["sha256_size"] = 0

    return stats


def write_readme(out_dir: Path, stats: dict, source: Path) -> None:
    body = f"""# Phase F.E — staged event manifests for the 13x13 Holtburg ring

Each `0xXXXX.events.jsonl` file contains the per-LB expected event
manifest baked by Phase F.B (commit `cc42434`). Renderer consumers
fetch one file per LB on demand, mirroring `dist/scenery/` and
`dist/spawns/`.

## Ring

13 x 13 landblocks centred on Holtburg (LB 0xA9B4). 169 LBs total —
identical ring to Phases C.1 (scenery) + D.1 (spawns).

## Schema (per JSONL line)

Three event kinds appear:

### Ambient (`source: "ambient"`)

```jsonc
{{
  "source":         "ambient",
  "trigger":        "terrain",
  "terrain_type":   1,
  "scene_type":     0,
  "scene_info_idx": 18,
  "stb_index":      9,
  "stb_id":         "0x2000001B",
  "vertex_indices": [0, 19, 20, ...],  // 81-vertex LB indices
  "ambient_sounds": [
    {{"s_type": 70, "volume": 0.25, "base_chance": 0.0,
      "min_rate": 8.27, "max_rate": 8.27, "continuous": true}},
    ...
  ]
}}
```

- `base_chance == 0 && continuous` → one continuous loop while
  terrain_type is active at the player's vertex.
- `base_chance > 0 && !continuous` → probabilistic roll per
  `[min_rate, max_rate]` interval.

### PhysicsScript particle (`source: "physics_script_particle"`)

```jsonc
{{
  "source":           "physics_script_particle",
  "trigger":          "physics_script_particle",
  "default_script_id":"0x3300067A",
  "start_time_s":     0.0,
  "emitter_id":       "0x320002CD",
  "part_index":       0,
  "blocking":         false,
  "anchor":           "entity_origin"
}}
```

Each row is one CreateParticle hook in a `PhysicsScript` referenced
from a spawned entity's `default_script_id`. The H2 walker in
`scene3d/entities.js` consumes these at spawn time.

### Anim sound (`source: "anim_sound"`) — DEFERRED

Anim-sound rows are NOT in the F.B bake. The F.B docs flag this as
"channel not yet exercised through synthetic spawn data; awaiting
F.B.5 (wcid -> MotionTableDataId staging)". The F.D validator
reports `anim_sound: 0 observed / 0 expected` for the ring.

## Notes

- **Empty files are intentional.** {stats["empty_emitted"]} of
  {stats["ring_size"]} LBs in the ring produced zero events at bake
  time (no ambient + no entity hooks). The runtime treats an empty
  file as "queried, zero events" (not 404 "not yet baked").
- **`event-bake-source.sha256`** carries the input DAT hashes + the
  bake-tool version. F.E consumers verify their DATs match before
  honouring the manifest, same contract as `scenery/bake-source.sha256`.

## Reproducibility

```sh
python3 stage-ring-events.py
```

Deterministic given the same F.B bake input. Source:
`{source}` (frozen at commit cc42434).
"""
    (out_dir / "README.md").write_text(body)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", default=DEFAULT_SOURCE, type=Path)
    p.add_argument("--out", default=DEFAULT_OUT, type=Path)
    args = p.parse_args()

    src = args.source.resolve()
    out = args.out.resolve()
    print(f"[stage-ring-events] source: {src}")
    print(f"[stage-ring-events] out:    {out}")

    stats = stage_ring(src, out)
    write_readme(out, stats, src)

    print(
        f"[stage-ring-events] ring_size={stats['ring_size']} "
        f"with_events={stats['with_events']} "
        f"empty_emitted={stats['empty_emitted']} "
        f"total_events={stats['total_events']} "
        f"sha256_copied={stats['sha256_copied']}"
    )
    print(f"[stage-ring-events] wrote README.md")
    if not stats["sha256_copied"]:
        print(
            "[stage-ring-events] WARNING: source bake missing "
            "event-bake-source.sha256 — consumers can't verify DATs",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
