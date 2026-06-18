#!/usr/bin/env python3
"""serve.py — the one committed entrypoint for the Holtburger dev web server.

WHY THIS EXISTS
---------------
The 3D renderer's baked data (manifest/shards + per-landblock scenery/spawns/
events) used to be bound into the web-served tree by a fan-out of FOUR gitignored,
machine-local, cross-drive symlinks. They were absent on every fresh checkout, on
every git worktree, on a new host, or whenever someone forgot to hand-run
`setup-dist-symlinks.sh` — and because the wasm client treats a per-landblock 404
as "0 placements here" (correct for an empty LB), a whole unbound layer rendered
an emptier world with ZERO error signal. Outdoor scenery vanished this way
repeatedly. The dev server itself had the same disease: it was an uncommitted
`/tmp/nocache-server.py` that got wiped on reboot.

This script ends both failure modes:

  * The baked layers are now consolidated as REAL dirs under ONE canonical root
    (`$HOLTBURGER_DIST`), so only a single `external/holtburger/dist` symlink is
    needed — and this script (re)creates it automatically, so a fresh tree or
    worktree just works.
  * It VALIDATES every required layer is present + non-empty before serving and
    refuses to start (loud, exit 1) if one is missing — no more silent serving of
    a scenery-less world.
  * It writes `dist/_health.json` (per-layer file counts) that the page reads at
    boot to show a visible banner if a layer ever goes missing despite all this.

It is a committed `ThreadingHTTPServer` (the single-threaded `http.server` wedges
when a client pulls the 3.6 MB wasm over the reverse tunnel) that serves the
`external/holtburger/` tree from any cwd.

USAGE
  scripts/serve.py                 # validate, write _health.json, serve on :8765
  scripts/serve.py --check         # validate + write _health.json, then exit (CI/preflight)
  scripts/serve.py --allow-missing # serve even if a baked layer is absent (UI-only / worktree dev)
  scripts/serve.py --port 9000     # override port (default 8765, env PORT)

ENV
  HOLTBURGER_DIST   canonical baked-data root. Default /mnt/wbterminal2/holtburger-dist.
                    (Honours the legacy HOLTBURGER_DIST_V2 as a fallback alias.)
  PORT              listen port (default 8765 — the proxy.cjs / perf-worker contract).
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# external/holtburger/ — the web root the page fetches `../../dist` + `../../dats`
# against. Derived from this file's location so the server is cwd-independent
# (no more "you must launch from external/holtburger" footgun).
HOLT_ROOT = Path(__file__).resolve().parent.parent
DIST_LINK = HOLT_ROOT / "dist"

DEFAULT_ROOT = "/mnt/wbterminal2/holtburger-dist"

# Layers the RENDERER needs — a missing/empty one is a hard failure (fail-loud).
# `events` is consumed only by offline Node validators, never by the renderer, so
# it is checked but downgraded to a warning.
REQUIRED_FILE = ["manifest.json"]
REQUIRED_DIRS = ["shards", "scenery", "spawns"]
RECOMMENDED_DIRS = ["events"]

# Counting 885k tiny shard files on every launch is wasteful; for big/opaque
# layers we only need "is it non-empty". For the small per-LB layers the page's
# health banner wants the real count.
COUNTED_DIRS = {"scenery", "spawns", "events"}


def canonical_root() -> Path:
    """Resolve the single canonical baked-data root."""
    root = os.environ.get("HOLTBURGER_DIST") or os.environ.get("HOLTBURGER_DIST_V2") or DEFAULT_ROOT
    return Path(root)


def count_files(d: Path) -> int:
    """Cheap non-recursive file count (layers are flat: one file per LB)."""
    try:
        return sum(1 for e in os.scandir(d) if e.is_file())
    except OSError:
        return 0


def dir_nonempty(d: Path) -> bool:
    try:
        return any(os.scandir(d))
    except OSError:
        return False


def count_suffix(d: Path, suffix: str) -> int:
    """Count files ending in `suffix` (e.g. only `.spawns.jsonl`, ignoring
    README.md / wcid_to_setup.json / source.sha256 / per-LB .sha256 sidecars)."""
    try:
        return sum(1 for e in os.scandir(d) if e.is_file() and e.name.endswith(suffix))
    except OSError:
        return 0


def parse_sha256_meta(path: Path) -> dict:
    """Parse a TSV `key\\tvalue` provenance sidecar (source.sha256)."""
    meta: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            if "\t" in line:
                k, v = line.split("\t", 1)
                meta[k] = v
    except OSError:
        pass
    return meta


def ensure_dist_symlink(root: Path, allow_missing: bool) -> None:
    """Make `external/holtburger/dist` point at `root`, creating/repairing as
    needed. The whole point: a fresh checkout/worktree gets the binding for free.
    Never clobbers a real directory someone may have baked directly into dist/."""
    if not root.exists():
        msg = f"baked-data root not found: {root}"
        if allow_missing:
            print(f"WARN: {msg} — serving without baked data (--allow-missing).", file=sys.stderr)
            return
        die_loud([f"root '{root}' does not exist (is the /mnt drive mounted? has the bake run?)"], root)

    if DIST_LINK.is_symlink():
        if Path(os.readlink(DIST_LINK)) == root:
            return
        os.remove(DIST_LINK)  # removes the link only, not its target
        os.symlink(root, DIST_LINK)
        print(f"repaired dist symlink -> {root}", file=sys.stderr)
        return

    if DIST_LINK.exists():
        # A real path is in the way — respect it (could be a direct bake), serve it.
        print(f"NOTE: {DIST_LINK} is a real path, not a symlink — leaving it as-is.", file=sys.stderr)
        return

    os.symlink(root, DIST_LINK)
    print(f"created dist symlink -> {root}", file=sys.stderr)


def build_health():
    """Inspect every layer through the dist link; return (health_dict, failures)."""
    layers: dict[str, dict] = {}
    failures: list[str] = []

    f = DIST_LINK / "manifest.json"
    present = f.is_file()
    layers["manifest.json"] = {"present": present, "files": 1 if present else 0}
    if not present:
        failures.append("manifest.json missing — run the dat-shard bake")

    for name in REQUIRED_DIRS + RECOMMENDED_DIRS:
        d = DIST_LINK / name
        if name == "spawns":
            # DIST-1: content-aware — a spawns/ dir holding only README.md +
            # wcid_to_setup.json (the old `{}` stub failure mode) must NOT read
            # present. Require real per-LB JSONL + the provenance sidecar, and
            # surface scope / populated-lbs so a content-blind dir can't go green.
            jsonl = count_suffix(d, ".spawns.jsonl") if d.is_dir() else 0
            sha = d / "source.sha256"
            present = jsonl > 0 and sha.is_file()
            layer = {"present": present, "files": jsonl}
            if sha.is_file():
                meta = parse_sha256_meta(sha)
                if "scope" in meta:
                    layer["scope"] = meta["scope"]
                if "populated-lbs" in meta:
                    try:
                        layer["populated_lbs"] = int(meta["populated-lbs"])
                    except ValueError:
                        pass
                if "wcid-to-setup-scope" in meta:
                    layer["wcid_to_setup_scope"] = meta["wcid-to-setup-scope"]
            layers[name] = layer
            if not present:
                failures.append(
                    f"layer 'spawns/' has no .spawns.jsonl + source.sha256 at {d} "
                    "(README/wcid_to_setup alone is not a staged world)")
            continue
        present = d.is_dir() and dir_nonempty(d)
        files = count_files(d) if (name in COUNTED_DIRS and d.is_dir()) else (1 if present else 0)
        layers[name] = {"present": present, "files": files}
        if not present and name in REQUIRED_DIRS:
            failures.append(f"layer '{name}/' missing or empty at {d}")

    health = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "root": str(canonical_root()),
        "layers": layers,
    }
    # `failures` is always the raw truth; --allow-missing is applied by the caller
    # so the one-line summary + _health.json never lie about what's actually there.
    return health, failures


def write_health(health: dict) -> None:
    out = DIST_LINK / "_health.json"
    try:
        out.write_text(json.dumps(health, indent=2) + "\n")
    except OSError as e:
        print(f"WARN: could not write {out}: {e}", file=sys.stderr)


def die_loud(failures: list[str], root: Path) -> None:
    bar = "!" * 72
    lines = [
        "",
        bar,
        "!!  HOLTBURGER DEV SERVER — REFUSING TO START: baked data is unbound",
        bar,
        f"!!  canonical root: {root}",
        "!!  the following required layer(s) are missing or empty:",
    ]
    for fail in failures:
        lines.append(f"!!      - {fail}")
    lines += [
        "!!",
        "!!  This is the bug that silently emptied the world. Fix it, don't ignore it:",
        "!!    * make sure /mnt/wbterminal2 (and /mnt/wbterminal1) are mounted",
        "!!    * (re)run the bake — see external/holtburger/docs/emit-dynamic-site.md",
        "!!    * point HOLTBURGER_DIST at the root if the bake lives elsewhere",
        "!!    * for UI-only / worktree work with no baked data, pass --allow-missing",
        bar,
        "",
    ]
    print("\n".join(lines), file=sys.stderr)
    sys.exit(1)


class Handler(SimpleHTTPRequestHandler):
    """Serve the external/holtburger/ tree with dev no-cache headers (the reason
    the old /tmp/nocache-server.py existed — Firefox/Chrome ES-module + wasm
    caching makes inner-loop iteration confusing). Caching for production-shaped
    runs is applied by proxy.cjs in front, not here."""

    # Login-boot diagnosis 2026-06-11: SimpleHTTPRequestHandler defaults to
    # HTTP/1.0 — one TCP connection per request, no keep-alive. A cold boot is
    # ~1,700 requests (144 modules + shards) and the connect storm overflowed
    # the accept queue (kernel ListenOverflows climbing during boots, 1.02s
    # retransmit tails measured). HTTP/1.1 keep-alive is safe here:
    # SimpleHTTPRequestHandler always sends Content-Length.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HOLT_ROOT), **kwargs)

    def send_response_only(self, code, message=None):
        # Stash the status so end_headers() can gate immutable caching on a 2xx
        # (a 304/404 for a convention-URL shard miss must NOT be cached forever).
        self._hb_status = int(code)
        super().send_response_only(code, message)

    def end_headers(self):
        # F5 (2026-06-01): content-addressed shards (/dist/shards/XX/<hash>.bin)
        # are immutable by construction — serve them cache-forever so reloads /
        # new sessions don't re-stream them (severe over a real network). Gated
        # on a 2xx so 404 convention-URL misses + 304s stay uncached. Everything
        # else (app JS, index.html, manifest.json, boot.hba, scenery + manifest
        # catalogs — all STABLE filenames that re-point per bake) keeps the dev
        # no-cache so hot-reload + bake freshness are preserved. Mirrors the
        # production proxy.cjs precedent (shards-only, 200-gated, same header).
        path = self.path.split("?", 1)[0]
        status = getattr(self, "_hb_status", 0)
        if path.startswith("/dist/shards/") and 200 <= status < 300:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif path.endswith((".js", ".mjs", ".wasm", ".bin", ".hba")) and not path.endswith("manifest.json"):
            # Login-boot diagnosis 2026-06-11: no-store forced a full ~23MB /
            # 150-request re-download on EVERY reload and retry cycle.
            # `no-cache` (without no-store) still revalidates every request —
            # hot-reload freshness is preserved — but unchanged bodies
            # collapse to 304s via SimpleHTTPRequestHandler's built-in
            # If-Modified-Since handling.
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console quiet for routine 200s; surface 404/5xx only.
        try:
            status = int(args[1])
        except (IndexError, ValueError):
            status = 0
        if status >= 400:
            super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser(description="Holtburger dev web server (single-root, validated).")
    ap.add_argument("--check", action="store_true", help="validate + write _health.json, then exit (no server)")
    ap.add_argument("--allow-missing", action="store_true", help="serve even if a baked layer is absent")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    root = canonical_root()
    ensure_dist_symlink(root, args.allow_missing)

    health, failures = build_health()
    write_health(health)

    # One-line per-layer summary, always.
    summary = "  ".join(
        f"{name}={info['files'] if info['present'] else 'MISSING'}"
        for name, info in health["layers"].items()
    )
    print(f"[serve] root={root}\n[serve] layers: {summary}", file=sys.stderr)

    if failures and not args.allow_missing:
        die_loud(failures, root)
    if failures:  # --allow-missing: serve anyway, but never claim it's fine
        print(f"[serve] --allow-missing: {len(failures)} required layer(s) absent, ignored:", file=sys.stderr)
        for fail in failures:
            print(f"[serve]   - {fail}", file=sys.stderr)

    if args.check:
        print("[serve] --check OK" + (" (with --allow-missing)" if failures else ": all required layers present."), file=sys.stderr)
        return

    # Login-boot diagnosis 2026-06-11: the default request_queue_size of 5
    # dropped handshakes under the boot fan-out (proxy.cjs opens unbounded
    # parallel upstream sockets). 1024 absorbs any realistic burst.
    class Srv(ThreadingHTTPServer):
        request_queue_size = 1024

    httpd = Srv((args.bind, args.port), Handler)
    url = f"http://{args.bind}:{args.port}/apps/holtburger-web/index.html"
    print(f"[serve] serving {HOLT_ROOT} (threaded, no-cache)\n[serve] open {url}", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] shutting down.", file=sys.stderr)
        httpd.shutdown()


if __name__ == "__main__":
    main()
