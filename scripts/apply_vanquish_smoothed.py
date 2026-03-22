#!/usr/bin/env python3
"""
apply_vanquish_smoothed.py — Apply V3-smoothed heightmaps to projects/vanquishtest via Terminal

Pipes JSON commands through the terminal's --stdin mode to:
  1. Load the projects/vanquishtest project
  2. Apply all heightmaps from vanquish_smoothed.jsonl 
  3. Export to projects/vanquishtest/ DAT files

Usage:
    .venv311\\Scripts\\python.exe scripts\\apply_vanquish_smoothed.py [--skip-export]
"""

import json
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TERMINAL_EXE = PROJECT_ROOT / "WorldBuilder.Terminal" / "bin" / "Release" / "net8.0" / "WorldBuilder.Terminal.exe"
PROJECT_FILE = PROJECT_ROOT / "projects" / "vanquishtest" / "vanquishtest.wbproj"
HEIGHTMAP_FILE = PROJECT_ROOT / "pipeline_data" / "heightmaps" / "vanquish_smoothed.jsonl"
EXPORT_DIR = str(PROJECT_ROOT / "projects" / "vanquishtest")


def send_command(proc, cmd_dict):
    """Send a JSON command and read the JSON response."""
    line = json.dumps(cmd_dict, separators=(',', ':')) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()

    resp_line = proc.stdout.readline().strip()
    if not resp_line:
        return None
    try:
        return json.loads(resp_line)
    except json.JSONDecodeError:
        print(f"  [WARN] Non-JSON response: {resp_line[:200]}")
        return None


def main():
    skip_export = "--skip-export" in sys.argv

    print("=" * 70)
    print("  APPLY VANQUISH V3-SMOOTHED HEIGHTMAPS")
    print("=" * 70)

    if not TERMINAL_EXE.exists():
        print(f"ERROR: Terminal not found at {TERMINAL_EXE}")
        print("  Build with: dotnet build WorldBuilder.Terminal -c Release")
        sys.exit(1)

    if not HEIGHTMAP_FILE.exists():
        print(f"ERROR: Heightmap file not found: {HEIGHTMAP_FILE}")
        sys.exit(1)

    # Count records
    print(f"\n  Counting heightmaps...")
    total = 0
    with open(HEIGHTMAP_FILE, "r", encoding="utf-8") as f:
        for _ in f:
            total += 1
    print(f"  {total} blocks to apply")

    # Start terminal in --stdin mode
    print(f"\n  Starting WorldBuilder.Terminal with project...")
    proc = subprocess.Popen(
        [str(TERMINAL_EXE), "--stdin", "--project", str(PROJECT_FILE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(PROJECT_ROOT),
    )

    # Read the "ready" message
    ready_line = proc.stdout.readline().strip()
    print(f"  Ready response: {ready_line[:200]}")

    try:
        ready = json.loads(ready_line)
        if ready.get("command") == "ready":
            print(f"  Terminal v{ready.get('version', '?')} is ready")
        else:
            print(f"  Unexpected startup message, proceeding anyway")
    except:
        print(f"  Could not parse ready message, proceeding anyway")

    # Verify project is loaded
    resp = send_command(proc, {"command": "info"})
    if resp:
        if resp.get("loaded"):
            print(f"  Project loaded: {resp.get('projectName', '?')}")
        else:
            print(f"  WARNING: Project not loaded. Attempting load...")
            resp = send_command(proc, {"command": "load", "path": str(PROJECT_FILE)})
            if resp and resp.get("success"):
                print(f"  Loaded: {resp.get('projectName', '?')}")
            else:
                print(f"  FATAL: Cannot load project: {resp}")
                proc.kill()
                sys.exit(1)

    # Apply all heightmaps
    print(f"\n  Applying {total} blocks (heightmaps)...")
    t0 = time.time()
    applied = 0
    terrain_applied = 0
    errors = 0
    last_print = time.time()

    with open(HEIGHTMAP_FILE, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            rec = json.loads(line)
            lbX = rec["lbX"]
            lbY = rec["lbY"]
            heights = rec["heightIndices"]

            # Apply heights
            cmd = {
                "command": "set-landblock-heightmap",
                "lbX": lbX,
                "lbY": lbY,
                "heights": heights,
            }

            resp = send_command(proc, cmd)
            if resp and resp.get("success"):
                applied += 1
            else:
                errors += 1
                if errors <= 5:
                    print(f"    ERROR at ({lbX},{lbY}): {resp}")

            # Apply terrain types if present
            if "terrainTypes" in rec:
                cmd_t = {
                    "command": "set-landblock-terrain",
                    "lbX": lbX,
                    "lbY": lbY,
                    "types": rec["terrainTypes"],
                }
                resp_t = send_command(proc, cmd_t)
                if resp_t and resp_t.get("success"):
                    terrain_applied += 1

            # Progress every 10 seconds
            now = time.time()
            if now - last_print > 10:
                elapsed = now - t0
                rate = applied / elapsed if elapsed > 0 else 0
                eta = (total - line_num) / rate if rate > 0 else 0
                print(f"    {line_num}/{total} ({line_num*100/total:.1f}%) "
                      f"| {rate:.0f} blocks/s | ETA {eta:.0f}s | errors={errors}")
                last_print = now

    elapsed = time.time() - t0
    print(f"\n  Heightmaps applied: {applied}/{total} in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"  Terrain types applied: {terrain_applied}")
    print(f"  Errors: {errors}")
    if elapsed > 0:
        print(f"  Rate: {applied/elapsed:.0f} blocks/sec")

    # Export
    if not skip_export:
        print(f"\n  Exporting to {EXPORT_DIR}...")
        t2 = time.time()
        resp = send_command(proc, {"command": "export", "directory": EXPORT_DIR})
        export_elapsed = time.time() - t2
        if resp:
            print(f"    Success: {resp.get('success')}")
            if resp.get('directory'):
                print(f"    Directory: {resp['directory']}")
        print(f"    Export took {export_elapsed:.0f}s")
    else:
        print(f"\n  Skipping export (--skip-export)")

    # Quit
    print(f"\n  Shutting down terminal...")
    try:
        send_command(proc, {"command": "quit"})
        proc.wait(timeout=30)
    except:
        proc.kill()

    total_time = time.time() - t0
    print(f"\n{'='*70}")
    print(f"  VANQUISH SMOOTHED WORLD APPLIED in {total_time:.0f}s ({total_time/60:.1f} min)")
    print(f"  {applied} heightmaps + {terrain_applied} terrain type sets applied")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
