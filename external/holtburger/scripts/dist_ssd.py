#!/usr/bin/env python3
"""dist_ssd.py — the SERVED copy of a baked dist lives on the internal SSD.

WHY
---
Bakes are written to the USB archive drives (/mnt/wbterminal1, /mnt/wbterminal2:
WD 8 TB spinners). Serving straight from them made every cold load seek: a first
visit to the Training Academy reads ~3,000 small shard files, and on this 8 GB
laptop the page cache had already dropped half of them ten minutes after the
previous load (2026-10-09 evening, run f6s: 1,449 of 2,989 uncached, the drive
~86% busy through the interior fetch). Players on the public front hit the same
disk. So the archive drives keep the bakes, and the tree `serve.py` serves is a
copy on the SSD, outside the repo:

    $HB_SERVE_ROOT  (default ~/hb-serve/dist)
      <name>/            one staged bake — real dirs (layer symlinks dereferenced),
                         files unchanged since the previously active bake are
                         HARDLINKS to it, so a re-bake costs only what changed
      <name>/.dist-ssd.json   provenance: source root, fingerprint, counts
      current -> <name>  what serve.py serves (its default root)

`serve.py` warns at every start when `current` is older than its source (a bake
or stager wrote to the archive since) or when it is serving a rotational disk.

FLOW AFTER ANY BAKE / STAGER RUN
    scripts/dist_ssd.py stage --activate          # re-stage the active bake's source
    scripts/dist_ssd.py stage /mnt/.../new-bake --name new-bake --activate [--bulk]
    scripts/dist_ssd.py prune --keep 1            # drop inactive copies (never `current`)
    scripts/dist_ssd.py status                    # copies, sizes, free space, staleness
    scripts/dist_ssd.py check                     # exit 1 if `current` is stale (CI / serve.py)
Restart serve.py after `activate` only if you want the new _health.json at once;
it serves through the `dist` -> `current` links, so new requests already see it.

The fingerprint is cheap on purpose (seconds on a cold spinner): every top-level
entry, every file of manifest/ and index/, the mtime of every layer dir and of its
bucket subdirs, and the top-level sidecars of each layer (every file not named
`0x…` — README, source.sha256, texchan-manifest.json, …). Adding, removing or renaming a file changes its directory's mtime; a tool
that rewrites an existing per-landblock file IN PLACE without touching a sidecar
is not seen — run `stage` after such a tool (rsync then copies just that file).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

SERVE_ROOT = Path(os.environ.get("HB_SERVE_ROOT") or (Path.home() / "hb-serve" / "dist"))
CURRENT = SERVE_ROOT / "current"
META = ".dist-ssd.json"
# Never copied or fingerprinted: serve.py rewrites _health.json at every start.
SKIP_TOP = {"_health.json", META}
FULL_LAYERS = {"manifest", "index"}  # small: every file counts
DEFAULT_MIN_FREE_GB = 6.0
BULK_THREADS = 4


def _stat_rec(h, rel: str, st: os.stat_result) -> None:
    h.update(f"{rel}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())


def fingerprint(src: Path) -> dict:
    """Cheap change detector for a bake root (see the module doc)."""
    h = hashlib.sha256()
    n = 0
    for top in sorted(os.scandir(src), key=lambda e: e.name):
        if top.name in SKIP_TOP:
            continue
        try:
            st = os.stat(top.path)  # follows the layer symlinks
        except OSError:
            continue
        _stat_rec(h, top.name, st)
        n += 1
        if not os.path.isdir(top.path):
            continue
        real = os.path.realpath(top.path)
        h.update(f"->{real}\n".encode())
        if top.name in FULL_LAYERS:
            for dp, dns, fns in os.walk(real):
                dns.sort()
                for fn in sorted(fns):
                    p = os.path.join(dp, fn)
                    _stat_rec(h, os.path.relpath(p, src), os.stat(p))
                    n += 1
            continue
        for e in sorted(os.scandir(real), key=lambda e: e.name):
            # Per-landblock / per-record files are named `0x…`; everything else at a
            # layer's top (README, source.sha256, *-manifest.json, …) is a sidecar.
            if e.is_dir(follow_symlinks=False) or not e.name.startswith("0x"):
                _stat_rec(h, f"{top.name}/{e.name}", e.stat())
                n += 1
    return {"sha256": h.hexdigest(), "entries": n}


def read_meta(d: Path) -> dict | None:
    try:
        return json.loads((d / META).read_text())
    except (OSError, ValueError):
        return None


def current_name() -> str | None:
    try:
        return os.readlink(CURRENT) if CURRENT.is_symlink() else None
    except OSError:
        return None


def free_bytes(p: Path) -> int:
    s = os.statvfs(p)
    return s.f_bavail * s.f_frsize


def staleness() -> tuple[str, str]:
    """('ok'|'stale'|'no-source'|'none', message) for `current`."""
    name = current_name()
    if not name:
        return "none", f"no staged copy ({CURRENT} missing)"
    meta = read_meta(SERVE_ROOT / name)
    if not meta:
        return "none", f"{SERVE_ROOT / name} has no {META} (not staged by this tool)"
    src = Path(meta["source"])
    if not src.exists():
        return "no-source", f"source {src} not reachable (archive drive unmounted?) — serving the staged copy as-is"
    fp = fingerprint(src)
    if fp["sha256"] != meta["fingerprint"]["sha256"]:
        return "stale", (f"the SSD copy '{name}' is OLDER than its source {src} (staged {meta['staged_at']}): "
                         f"run  scripts/dist_ssd.py stage --activate")
    return "ok", f"'{name}' matches its source {src} (staged {meta['staged_at']})"


def _uleb(b: bytes, i: int) -> tuple[int, int]:
    r = sh = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << sh
        sh += 7
        if x < 0x80:
            return r, i


def referenced_shards(src: Path) -> list[str] | None:
    """`shards/<h[:2]>/<h>.bin` for every record the bake's HBNS catalogs
    (manifest/**) name, or None when it has none (then the whole shards dir is
    staged). Beside the 0.89 M hash-named records the archive's shards dir holds
    0.89 M convention-URL aliases (`shards/<namespace>/0x<id>.bin`, symlinks to
    the same records), which the client asks for only when a namespace has no
    catalog — none of the 3,250–3,500 shard requests of three 2026-10-09 academy
    loads did. serve.py reads any miss through to the archive, so staging only
    the named records is safe and halves the copy (22 GB → ~14 GB on disk)."""
    rels: set[str] = set()
    man = src / "manifest"
    if not man.is_dir():
        return None
    for dp, _dns, fns in os.walk(man):
        for fn in fns:
            with open(os.path.join(dp, fn), "rb") as f:
                b = f.read()
            if b[:4] != b"HBNS":
                continue
            hl = 32 if b[5] & 1 else 16
            n = struct.unpack_from("<I", b, 8)[0]
            i = 16
            for _ in range(n):
                _, i = _uleb(b, i)  # file-id delta
                h = b[i:i + 16].hex()
                i += hl
                _, i = _uleb(b, i)  # size
                rels.add(f"shards/{h[:2]}/{h}.bin")
    return sorted(rels) if rels else None


def drop_unreferenced_shards(dest: Path, shard_rels: list[str]) -> int:
    """Remove shard files of the copy that no catalog names (e.g. a copy staged
    before the referenced-only rule, or records a re-bake dropped)."""
    keep = set(shard_rels)
    n = 0
    root = dest / "shards"
    if not root.is_dir():
        return 0
    for b in os.scandir(root):
        if not b.is_dir(follow_symlinks=False):
            continue
        for f in os.scandir(b.path):
            if f"shards/{b.name}/{f.name}" not in keep:
                os.unlink(f.path)
                n += 1
    return n


def _same(st: os.stat_result, p: str) -> bool:
    try:
        d = os.stat(p)
    except OSError:
        return False
    return d.st_size == st.st_size and d.st_mtime_ns == st.st_mtime_ns


def bulk_prefill(src: Path, partial: Path, link_dest: Path | None, shard_rels: list[str] | None) -> int:
    """Copy, in INODE order, every file rsync would have to copy (absent from
    `partial` and not hardlinkable from `link_dest`), keeping size, mtime and mode
    so rsync's quick check then skips it. On an ext4 spinner inode order is
    close to on-disk order: rsync's name order seeks per small file (~250
    files/s for the first 14 GB bake, 2026-10-09). Returns files copied."""
    todo = []

    def want(sp: str, rel: str) -> None:
        try:
            st = os.stat(sp)
        except OSError:
            return
        if _same(st, os.path.join(partial, rel)):
            return
        if link_dest and _same(st, os.path.join(link_dest, rel)):
            return
        # Plain ints + one str per file (a stat_result and two paths each held
        # 2 GB for the first 1.9 M-file bake); `src/rel` opens the same file
        # through the layer symlinks.
        todo.append((st.st_ino, rel, st.st_mode & 0o7777, st.st_atime_ns, st.st_mtime_ns))

    if shard_rels is not None:
        for rel in shard_rels:
            want(os.path.join(src, rel), rel)
    for top in sorted(os.scandir(src), key=lambda e: e.name):
        if top.name in SKIP_TOP or (shard_rels is not None and top.name == "shards"):
            continue
        real = os.path.realpath(top.path)
        if os.path.isfile(real):
            walk = [(os.path.dirname(real), [], [os.path.basename(real)])]
            base = os.path.dirname(real)
            prefix = ""
        else:
            walk = os.walk(real, followlinks=True)
            base = real
            prefix = top.name
        for dp, _dns, fns in walk:
            for fn in fns:
                sp = os.path.join(dp, fn)
                want(sp, os.path.join(prefix, os.path.relpath(sp, base)) if prefix else top.name)
    todo.sort(key=lambda t: t[0])
    print(f"bulk: {len(todo)} files to pre-copy in inode order ({BULK_THREADS} threads)", file=sys.stderr)
    t0 = time.time()
    made = set()
    nxt = [0]
    lock = threading.Lock()
    errors = []

    # A few threads take the next file in inode order, so the reads stay close
    # to disk order while one thread's seek overlaps the others' writes (one
    # thread left the USB spinner ~48% busy at ~600 files/s, 2026-10-09).
    def work() -> None:
        while True:
            with lock:
                i = nxt[0]
                if i >= len(todo) or errors:
                    return
                nxt[0] = i + 1
            _ino, rel, mode, atime_ns, mtime_ns = todo[i]
            sp = os.path.join(src, rel)
            try:
                dst = os.path.join(partial, rel)
                dd = os.path.dirname(dst)
                if dd not in made:
                    os.makedirs(dd, exist_ok=True)
                    made.add(dd)
                tmp = f"{dst}.bulk-tmp{threading.get_ident()}"
                shutil.copyfile(sp, tmp)
                os.chmod(tmp, mode)
                os.utime(tmp, ns=(atime_ns, mtime_ns))
                os.replace(tmp, dst)
            except OSError as e:
                errors.append(f"{sp}: {e}")
                return
            if (i + 1) % 20000 == 0:
                el = time.time() - t0
                print(f"bulk: {i + 1}/{len(todo)} files, {(i + 1) / el:.0f} files/s", file=sys.stderr)

    threads = [threading.Thread(target=work) for _ in range(BULK_THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if errors:
        raise OSError(f"bulk copy failed: {errors[0]}")
    return len(todo)


def _rsync_cmd(src: Path, dest: Path, link_dest: Path | None, dry: bool,
               files_from: Path | None = None, skip_shards: bool = False) -> list[str]:
    """`files_from`: copy just those paths (the referenced shards); otherwise the
    whole tree, minus /shards/ when `skip_shards` (rsync leaves an excluded dir
    on the receiver alone under --delete)."""
    if files_from:
        cmd = ["rsync", "-aL", f"--files-from={files_from}"]
    else:
        cmd = ["rsync", "-aL", "--delete", "--exclude", "/_health.json", "--exclude", f"/{META}"]
        if skip_shards:
            cmd += ["--exclude", "/shards/"]
    if link_dest:
        cmd += [f"--link-dest={link_dest}"]
    if dry:
        cmd += ["--dry-run", "--stats"]
    else:
        cmd += ["--info=progress2,stats1"]
    return ["ionice", "-c2", "-n7", "nice", "-n", "10", *cmd, f"{src}/", f"{dest}/"]


def cmd_stage(args) -> int:
    SERVE_ROOT.mkdir(parents=True, exist_ok=True)
    cur = current_name()
    if args.src:
        src = Path(args.src).resolve()
    else:
        meta = read_meta(SERVE_ROOT / cur) if cur else None
        if not meta:
            print("stage: no SRC given and no active staged copy to take the source from", file=sys.stderr)
            return 2
        src = Path(meta["source"])
    if not (src / "manifest.json").exists():
        print(f"stage: {src} is not a bake root (no manifest.json)", file=sys.stderr)
        return 2
    if src.resolve().is_relative_to(SERVE_ROOT.resolve()):
        print("stage: the source is inside the serving root", file=sys.stderr)
        return 2
    name = args.name or src.name
    if name == "current" or "/" in name:
        print(f"stage: bad name {name!r}", file=sys.stderr)
        return 2
    final = SERVE_ROOT / name
    partial = SERVE_ROOT / f".staging-{name}"
    # Hardlink against the active copy (unless we are re-staging into it, then
    # rsync updates it in place through the partial dir below).
    link_dest = (SERVE_ROOT / cur).resolve() if cur and cur != name else None
    if final.exists() and not partial.exists():
        # Re-stage of an existing copy: work on a hardlinked clone so `current`
        # keeps serving a complete tree until the swap.
        print(f"stage: cloning {final} as hardlinks for the update…", file=sys.stderr)
        subprocess.run(["cp", "-al", str(final), str(partial)], check=True)
    partial.mkdir(exist_ok=True)
    fp_before = fingerprint(src)
    shard_rels = None if args.all_shards else referenced_shards(src)
    files_from = None
    if shard_rels is not None:
        files_from = SERVE_ROOT / f".shards-{name}.list"
        files_from.write_text("\n".join(shard_rels) + "\n")
        print(f"stage: {len(shard_rels)} shards named by the catalogs (unreferenced ones are not staged)", file=sys.stderr)
    passes = [dict(skip_shards=shard_rels is not None)]
    if files_from:
        passes.append(dict(files_from=files_from))
    # Space guard: what rsync would copy (not hardlink) must leave the floor free.
    need = nfiles = 0
    for kw in passes:
        dry = subprocess.run(_rsync_cmd(src, partial, link_dest, True, **kw), capture_output=True, text=True)
        if dry.returncode != 0:
            print(dry.stderr, file=sys.stderr)
            return dry.returncode
        m = re.search(r"Total transferred file size: ([\d,]+)", dry.stdout)
        need += int(m.group(1).replace(",", "")) if m else 0
        mf = re.search(r"Number of regular files transferred: ([\d,]+)", dry.stdout)
        nfiles += int(mf.group(1).replace(",", "")) if mf else 0
    # Small files round up to whole blocks: allow one 4 KiB block per new file
    # (the first full bake took 22 GB on disk for 15.5 GB of files).
    need += nfiles * 4096
    free = free_bytes(SERVE_ROOT)
    floor = int(args.min_free_gb * 1e9)
    print(f"stage: {src} -> {final}  (copies {nfiles} files, ≤ {need / 1e9:.2f} GB on disk, free {free / 1e9:.1f} GB, floor {args.min_free_gb} GB"
          f"{', hardlinks against ' + str(link_dest) if link_dest else ''})", file=sys.stderr)
    if free - need < floor:
        print(f"stage: REFUSED — would leave {(free - need) / 1e9:.1f} GB free on {SERVE_ROOT} "
              f"(floor {args.min_free_gb} GB). `prune` inactive copies or lower --min-free-gb.", file=sys.stderr)
        return 3
    t0 = time.time()
    if args.bulk:
        bulk_prefill(src, partial, link_dest, shard_rels)
    for kw in passes:
        r = subprocess.run(_rsync_cmd(src, partial, link_dest, False, **kw))
        if r.returncode != 0:
            print(f"stage: rsync failed ({r.returncode}); the partial copy stays at {partial} and the next stage resumes it",
                  file=sys.stderr)
            return r.returncode
    if shard_rels is not None:
        dropped = drop_unreferenced_shards(partial, shard_rels)
        if dropped:
            print(f"stage: removed {dropped} unreferenced shard files from the copy", file=sys.stderr)
        files_from.unlink()
    fp_after = fingerprint(src)
    if fp_after["sha256"] != fp_before["sha256"]:
        print("stage: the source changed WHILE copying — run stage again (the partial copy is kept)", file=sys.stderr)
        return 4
    meta = {
        "source": str(src),
        "staged_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "copy_seconds": round(time.time() - t0, 1),
        "copied_bytes": need,
        "fingerprint": fp_after,
        "link_dest": str(link_dest) if link_dest else None,
    }
    (partial / META).write_text(json.dumps(meta, indent=2) + "\n")
    if final.exists():
        old = SERVE_ROOT / f".old-{name}-{int(time.time())}"
        os.rename(final, old)
        os.rename(partial, final)
        shutil.rmtree(old)
    else:
        os.rename(partial, final)
    print(f"stage: staged '{name}' in {meta['copy_seconds']} s", file=sys.stderr)
    if args.activate:
        return activate(name)
    return 0


def activate(name: str) -> int:
    d = SERVE_ROOT / name
    if not read_meta(d):
        print(f"activate: {d} is not a staged copy", file=sys.stderr)
        return 2
    tmp = SERVE_ROOT / ".current.tmp"
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(name, tmp)
    os.replace(tmp, CURRENT)  # atomic swap
    print(f"activate: current -> {name}", file=sys.stderr)
    return 0


def cmd_activate(args) -> int:
    return activate(args.name)


def copies() -> list[str]:
    if not SERVE_ROOT.exists():
        return []
    return sorted(e.name for e in os.scandir(SERVE_ROOT) if e.is_dir(follow_symlinks=False) and not e.name.startswith("."))


def cmd_prune(args) -> int:
    cur = current_name()
    inactive = [c for c in copies() if c != cur]
    inactive.sort(key=lambda c: (read_meta(SERVE_ROOT / c) or {}).get("staged_at", ""), reverse=True)
    for c in inactive[max(0, args.keep - 1):]:
        print(f"prune: removing {SERVE_ROOT / c}", file=sys.stderr)
        if not args.dry_run:
            shutil.rmtree(SERVE_ROOT / c)
    for e in os.scandir(SERVE_ROOT) if SERVE_ROOT.exists() else []:
        if e.name.startswith(".old-"):
            print(f"prune: removing leftover {e.path}", file=sys.stderr)
            if not args.dry_run:
                shutil.rmtree(e.path)
    return 0


def cmd_status(args) -> int:
    cur = current_name()
    probe = SERVE_ROOT
    while not probe.exists():
        probe = probe.parent
    print(f"serving root: {SERVE_ROOT}   free {free_bytes(probe) / 1e9:.1f} GB")
    for c in copies():
        meta = read_meta(SERVE_ROOT / c) or {}
        print(f"  {'*' if c == cur else ' '} {c}  staged {meta.get('staged_at', '?')}  from {meta.get('source', '?')}")
    for e in (os.scandir(SERVE_ROOT) if SERVE_ROOT.exists() else []):
        if e.name.startswith(".staging-"):
            print(f"    (partial: {e.name} — `stage` resumes it)")
    state, msg = staleness()
    print(f"current: {state} — {msg}")
    return 0


def cmd_check(args) -> int:
    state, msg = staleness()
    print(f"{state}: {msg}", file=sys.stderr)
    return 1 if state in ("stale", "none") else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage baked dist trees onto the SSD serving root.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stage", help="copy a bake root onto the SSD (hardlinking unchanged files)")
    s.add_argument("src", nargs="?", help="bake root (default: the active copy's source)")
    s.add_argument("--name", help="copy name (default: the source dir's name)")
    s.add_argument("--activate", action="store_true", help="point `current` at it when done")
    s.add_argument("--min-free-gb", type=float, default=DEFAULT_MIN_FREE_GB)
    s.add_argument("--all-shards", action="store_true",
                   help="stage every file of shards/, not only the ones the catalogs name")
    s.add_argument("--bulk", action="store_true",
                   help="pre-copy missing files in inode order first (a brand-new bake off a spinner)")
    s.set_defaults(fn=cmd_stage)
    a = sub.add_parser("activate", help="point `current` at a staged copy")
    a.add_argument("name")
    a.set_defaults(fn=cmd_activate)
    p = sub.add_parser("prune", help="remove inactive copies (never `current`)")
    p.add_argument("--keep", type=int, default=1, help="copies to keep INCLUDING current (default 1)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_prune)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("check", help="exit 1 if `current` is missing or older than its source").set_defaults(fn=cmd_check)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
