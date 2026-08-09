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
import email.utils
import hashlib
import json
import os
import stat as stat_mod
import subprocess
import sys
import threading
import zlib
from collections import OrderedDict
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# external/holtburger/ — the web root the page fetches `../../dist` + `../../dats`
# against. Derived from this file's location so the server is cwd-independent
# (no more "you must launch from external/holtburger" footgun).
HOLT_ROOT = Path(__file__).resolve().parent.parent
DIST_LINK = HOLT_ROOT / "dist"

# 2026-08-02 — REPOINTED to the current bake. The previous default
# (/mnt/wbterminal2/holtburger-dist, generated 2026-05-24) does NOT contain the
# `holtburger/tex-bc7` namespace, while `?texBc7` has been DEFAULT-ON since
# 2026-07-30 — so every bare `serve.py` produced the boot warning
#   [bc7] namespace `holtburger/tex-bc7` is not in the loaded manifest
# and silently ran the whole client on the RGBA8 texture path. Worse,
# `ensure_dist_symlink` below actively RE-POINTS external/holtburger/dist at
# this constant on every start, so hand-fixing the symlink was always reverted.
# The two bakes carry identical world data (scenery 195,076 / spawns 38,153 /
# events 80,397 files in both `_health.json`); the newer one just adds the BC7
# texture namespace. `HOLTBURGER_DIST=<path>` still overrides.
#
# 2026-08-05 — REPOINTED again to the P1/P2 bake: same world data + tex-bc7,
# plus `holtburger/tex-bc7-pre` (2,893 quarter-res preview records, ?texPre
# default-ON) and `holtburger/tex-xu7` (3,985 XUBC7 payloads — the Remacri
# statics corpus + tranche-1 entities, ?texXu7=on opt-in). Provenance:
# bake-source.sha256 in the dist root.
# 2026-08-05 (2): -xu7t2 adds tranche 2 — 1,138 paletted RenderSurfaces
# re-emitted at up to 4x/512-cap INDEX16 in eor/portal (t2quant constrained
# re-quantization; injected portal provenance in bake-source.sha256).
DEFAULT_ROOT = "/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2"

# Layers the RENDERER needs — a missing/empty one is a hard failure (fail-loud).
# `events` is consumed only by offline Node validators, never by the renderer, so
# it is checked but downgraded to a warning.
REQUIRED_FILE = ["manifest.json"]
REQUIRED_DIRS = ["shards", "scenery", "spawns"]
RECOMMENDED_DIRS = ["events"]

# pkg/ is gitignored (wasm-pack self-ignore) so every checkout serves a wasm of
# unknown profile and age; an accidental --dev build (~17-19MB vs ~4.2-4.7MB
# release) already cost days once (2026-07-01 incident). Warn, never refuse —
# serving a dev build deliberately is legitimate.
WASM_PKG = HOLT_ROOT / "apps/holtburger-web/pkg/holtburger_web_bg.wasm"
DEV_WASM_BYTES = 8 * 1024 * 1024

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


def wasm_health() -> dict:
    """Provenance for the served wasm: size (dev-profile tell) + staleness vs
    the last Rust-touching commit. Log-only — see WASM_PKG comment."""
    try:
        st = WASM_PKG.stat()
    except OSError:
        return {"present": False}
    info = {
        "present": True,
        "bytes": st.st_size,
        "mtime": datetime.datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds"),
        "profile_guess": "DEV-SUSPECT" if st.st_size > DEV_WASM_BYTES else "release-shaped",
    }
    try:
        out = subprocess.run(
            ["git", "-C", str(HOLT_ROOT), "log", "-1", "--format=%ct",
             "--", "apps/holtburger-web/src", "crates", ":(exclude)crates/*/examples/*"],
            capture_output=True, text=True, timeout=10)
        last_rust = int(out.stdout.strip() or 0)
        if last_rust:
            info["stale_vs_rust_commit"] = st.st_mtime < last_rust
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return info


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
        if name == "scenery":
            # 2026-08-03: content-aware, same rationale as the spawns arm above
            # — `dir_nonempty` is true for a directory holding only README.md,
            # so a scenery/ that lost its payload passed --check, wrote
            # "present": true into _health.json, printed a clean boot banner,
            # and left the wasm client reading every per-LB 404 as
            # "0 placements". That disappearance is the incident this module's
            # docstring opens with; the hardening was never extended here.
            jsonl = count_suffix(d, ".scenery.jsonl") if d.is_dir() else 0
            present = jsonl > 0
            layers[name] = {"present": present, "files": jsonl}
            if not present:
                failures.append(
                    f"layer 'scenery/' has no .scenery.jsonl at {d} "
                    "(a README-only directory is not a staged world)")
            continue
        if name == "shards":
            # Shards are hex-prefix BUCKET DIRS of .bin records, not flat files,
            # so `count_files` (non-recursive, files only) reads 0 and the old
            # `files = 1 if present` fallback made the summary print
            # "shards=1" unconditionally. Count populated buckets instead.
            buckets = 0
            if d.is_dir():
                try:
                    for e in os.scandir(d):
                        if e.is_dir() and dir_nonempty(Path(e.path)):
                            buckets += 1
                except OSError:
                    buckets = 0
            present = buckets > 0
            layers[name] = {"present": present, "files": buckets, "unit": "buckets"}
            if not present:
                failures.append(
                    f"layer 'shards/' has no populated bucket directories at {d}")
            continue
        present = d.is_dir() and dir_nonempty(d)
        files = count_files(d) if (name in COUNTED_DIRS and d.is_dir()) else (1 if present else 0)
        layers[name] = {"present": present, "files": files}
        if not present and name in REQUIRED_DIRS:
            failures.append(f"layer '{name}/' missing or empty at {d}")

    # T10 pack tree (reengineering ST1). Presence-routed exactly like the
    # client: a manifest WITHOUT `world_index` is a legacy dist and the
    # pack layers are simply not listed (legacy dists keep passing --check
    # unchanged). A manifest that DECLARES `world_index` promises the pack
    # tree — a missing/short/hash-mismatched index or an empty packs/ is
    # then the same class of silent-empty-world bug this validator exists
    # for, and fails loud.
    world_index = None
    try:
        with open(DIST_LINK / "manifest.json") as f:
            world_index = json.load(f).get("world_index")
    except (OSError, ValueError):
        pass
    if world_index is not None:
        idx_rel = world_index.get("url", "")
        idx_path = DIST_LINK / idx_rel
        idx_ok = idx_path.is_file()
        idx_reason = None
        if not idx_ok:
            idx_reason = f"declared index {idx_rel!r} missing"
        else:
            try:
                idx_bytes = idx_path.read_bytes()
                if len(idx_bytes) != int(world_index.get("size", -1)):
                    idx_ok, idx_reason = False, (
                        f"index size {len(idx_bytes)} != declared {world_index.get('size')}")
                else:
                    digest16 = hashlib.sha256(idx_bytes).hexdigest()[:32]
                    if digest16 != world_index.get("sha256_16"):
                        idx_ok, idx_reason = False, (
                            f"index sha256_16 {digest16} != declared "
                            f"{world_index.get('sha256_16')}")
            except OSError as e:
                idx_ok, idx_reason = False, f"index unreadable: {e}"
        layers["index"] = {"present": idx_ok, "files": 1 if idx_ok else 0}
        if not idx_ok:
            failures.append(f"pack layer 'index': {idx_reason}")

        packs_dir = DIST_LINK / "packs"
        buckets = 0
        if packs_dir.is_dir():
            try:
                for e in os.scandir(packs_dir):
                    if e.is_dir() and dir_nonempty(Path(e.path)):
                        buckets += 1
            except OSError:
                buckets = 0
        layers["packs"] = {"present": buckets > 0, "files": buckets, "unit": "buckets"}
        if buckets == 0:
            failures.append(
                f"pack layer 'packs/' has no populated bucket directories at {packs_dir} "
                "(manifest.json declares world_index — this dist promises packs)")

    health = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "root": str(canonical_root()),
        "layers": layers,
        "wasm": wasm_health(),
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


# Cross-origin isolation (--coi). SharedArrayBuffer — and therefore the
# wasm-threads (SAB) work, HANDOFF-wasm-threads-SAB-2026-07-20 §2.4 — requires
# the document be cross-origin isolated. Off by default: `require-corp` changes
# how EVERY cross-origin subresource loads, so the daily loop keeps today's
# behaviour until the threaded build actually needs it.
COI = False


# --- response compression (2026-08-04) --------------------------------------
# Players first-load over ~666 kbps links; the cold path is ~5.4 MB wasm +
# several MB of unminified ES-module JS + JSON + shard payloads, and nothing
# was served with Content-Encoding. Negotiated per-request via Accept-Encoding:
#   * text assets  -> gzip (stdlib zlib, level 6)
#   * binary assets (wasm / shard .bin / .hba / .hbc7) -> zstd when a zstd
#     codec is importable AND the client accepts it; else gzip (still ~15-20%
#     on BC7 blobs); else identity.
# Never compresses a request that carries a Range header (byte offsets), never
# compresses when the client didn't ask, always sends Vary: Accept-Encoding on
# compressible extensions. Fail-loud posture: if no zstd codec exists we say so
# ONCE at startup instead of silently downgrading forever.
try:
    import zstandard as _zstd_pkg  # pip package (not installed everywhere)

    def _zstd_compress(data: bytes) -> bytes:
        return _zstd_pkg.ZstdCompressor(level=10).compress(data)

    ZSTD_IMPL: str | None = f"zstandard {_zstd_pkg.__version__}"
except ImportError:
    try:
        from compression import zstd as _zstd_std  # stdlib, Python >= 3.14

        def _zstd_compress(data: bytes) -> bytes:
            return _zstd_std.compress(data, level=10)

        ZSTD_IMPL = "stdlib compression.zstd"
    except ImportError:
        def _zstd_compress(data: bytes) -> bytes:  # never negotiated when None
            raise RuntimeError("no zstd codec available")

        ZSTD_IMPL = None

# Text-shaped assets: gzip only (universally accepted, great ratio on source).
# .jsonl is the per-LB scenery/spawns layer — fetched constantly at boot.
TEXT_COMPRESS_EXTS = {".js", ".mjs", ".html", ".css", ".json", ".jsonl", ".md", ".map"}
# Binary payloads: zstd preferred (faster + better on already-packed data),
# gzip fallback. .bin = content-addressed dist shards (incl. tex-bc7 blobs).
#
# 2026-08-05 — this block used to end "NEVER add XUBC7 payloads
# (.ktx2/.basis/tex-xu7) here ... extensions absent from both allowlists are
# served identity by omission, which is the mechanism". That mechanism does not
# exist: `dat-shard` writes EVERY record, tex-xu7 included, to
# `shards/<xx>/<sha>.bin`, and `.bin` is right there in the set. The extension
# an XUBC7 payload had at bake time never reaches the wire. Payloads escaped
# only because they are incompressible and the negative cache below caught them
# after paying for the attempt.
#
# So the guard is CONTENT-based now (`_is_identity_only`), which is the only
# thing a content-addressed store can key on. See its docstring.
BIN_COMPRESS_EXTS = {".wasm", ".bin", ".hba", ".hbc7"}

# KTX2 file identifier (12 bytes, Khronos spec) — the same check
# `dat_shard.rs` validates XUBC7 ingest with, and `src/lib.rs xu7_blocks`
# re-checks on read.
KTX2_MAGIC = bytes([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A])


def _is_identity_only(raw: bytes) -> bool:
    """Payloads that must ship identity no matter what extension they arrived
    under. XUBC7 (basisu KTX2, unregistered scheme-6 supercompression) is
    already Zstd-compressed inside: re-compressing it burns CPU and cache for a
    body that cannot shrink. Checked on the file's own bytes because the dist is
    content-addressed — every namespace lands as `<sha>.bin`, so there is no
    extension left to gate on."""
    return raw[:12] == KTX2_MAGIC
GZIP_LEVEL = 6
MIN_COMPRESS_BYTES = 256               # header overhead isn't worth it below this
MAX_COMPRESS_BYTES = 64 * 1024 * 1024  # sanity cap: don't buffer huge files


def _gzip_compress(data: bytes) -> bytes:
    # wbits=31 -> gzip container (RFC 1952), what Content-Encoding: gzip means.
    co = zlib.compressobj(GZIP_LEVEL, zlib.DEFLATED, 31)
    return co.compress(data) + co.flush()


class _CompressCache:
    """Byte-bounded LRU of compressed bodies keyed by (path, mtime_ns, size,
    encoding) so repeated fetches (reload loops, multi-agent boots) don't
    re-compress. A value of None is a negative entry: 'compression did not
    shrink this file — serve identity' (stops re-compressing incompressible
    data on every hit). Thread-safe: the server is a ThreadingHTTPServer."""

    def __init__(self, max_bytes: int = 96 * 1024 * 1024):
        self._lock = threading.Lock()
        self._map: OrderedDict[tuple, bytes | None] = OrderedDict()
        self._bytes = 0
        self._max_bytes = max_bytes

    def get(self, key: tuple):
        with self._lock:
            if key not in self._map:
                return False, None  # (hit?, value)
            self._map.move_to_end(key)
            return True, self._map[key]

    def put(self, key: tuple, body: bytes | None) -> None:
        size = len(body) if body is not None else 0
        if size > self._max_bytes:
            return
        with self._lock:
            old = self._map.pop(key, None)
            if old is not None:
                self._bytes -= len(old)
            self._map[key] = body
            self._bytes += size
            while self._bytes > self._max_bytes and self._map:
                _, evicted = self._map.popitem(last=False)
                if evicted is not None:
                    self._bytes -= len(evicted)


COMPRESS_CACHE = _CompressCache()


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

    # --- compression -------------------------------------------------------

    def _accepted_encodings(self) -> set[str]:
        """Parse Accept-Encoding into the set of codings with q > 0."""
        hdr = self.headers.get("Accept-Encoding", "")
        accepted: set[str] = set()
        for part in hdr.split(","):
            part = part.strip()
            if not part:
                continue
            token, _, params = part.partition(";")
            token = token.strip().lower()
            q = 1.0
            params = params.strip().lower()
            if params.startswith("q="):
                try:
                    q = float(params[2:])
                except ValueError:
                    q = 0.0
            if q > 0:
                accepted.add("gzip" if token == "x-gzip" else token)
        return accepted

    def _negotiate_encoding(self, ext: str) -> str | None:
        accepted = self._accepted_encodings()
        if ext in TEXT_COMPRESS_EXTS:
            return "gzip" if "gzip" in accepted else None
        if ext in BIN_COMPRESS_EXTS:
            if ZSTD_IMPL is not None and "zstd" in accepted:
                return "zstd"
            if "gzip" in accepted:
                return "gzip"
        return None

    def _maybe_send_compressed(self) -> bool:
        """Serve a compressed body when negotiable. Returns True when the
        request was fully handled; False falls through to the stdlib path
        (which also covers 404s, directories, redirects, and Range requests
        — a Range response must NEVER be compressed, byte offsets break)."""
        if self.headers.get("Range") is not None:
            return False
        clean = self.path.split("?", 1)[0].split("#", 1)[0]
        # T10 pack tree: HBP1 packs are per-section zstd inside and the
        # HBSI1 index is hash-dominated (≈incompressible); the wire
        # contract for the CAS tier is IDENTITY encoding (hash = bytes —
        # reengineering pass 3 S6.1). `.bin` is in BIN_COMPRESS_EXTS for
        # the legacy shard store, so gate by path, not extension.
        if clean.startswith("/dist/packs/") or clean.startswith("/dist/index/"):
            return False
        ext = os.path.splitext(clean)[1].lower()
        if ext not in TEXT_COMPRESS_EXTS and ext not in BIN_COMPRESS_EXTS:
            return False
        enc = self._negotiate_encoding(ext)
        if enc is None:
            return False
        fspath = self.translate_path(self.path)
        try:
            fs = os.stat(fspath)
        except OSError:
            return False  # stdlib path produces the 404
        if not stat_mod.S_ISREG(fs.st_mode):
            return False
        if not (MIN_COMPRESS_BYTES <= fs.st_size <= MAX_COMPRESS_BYTES):
            return False

        # Preserve SimpleHTTPRequestHandler's If-Modified-Since -> 304 contract
        # (the no-cache tiers below rely on revalidation collapsing to 304s).
        ims_hdr = self.headers.get("If-Modified-Since")
        if ims_hdr is not None and "If-None-Match" not in self.headers:
            try:
                ims = email.utils.parsedate_to_datetime(ims_hdr)
            except (TypeError, IndexError, OverflowError, ValueError):
                ims = None
            if ims is not None:
                if ims.tzinfo is None:
                    ims = ims.replace(tzinfo=datetime.timezone.utc)
                if ims.tzinfo is datetime.timezone.utc:
                    last_modif = datetime.datetime.fromtimestamp(
                        fs.st_mtime, datetime.timezone.utc).replace(microsecond=0)
                    if last_modif <= ims:
                        self.send_response(HTTPStatus.NOT_MODIFIED)
                        self.end_headers()
                        return True

        key = (fspath, fs.st_mtime_ns, fs.st_size, enc)
        hit, body = COMPRESS_CACHE.get(key)
        if not hit:
            try:
                with open(fspath, "rb") as f:
                    raw = f.read()
            except OSError:
                return False
            if _is_identity_only(raw):
                # Cached as a negative entry, so the sniff costs one read per
                # (path, mtime, size, enc) rather than one per request.
                body = None
            else:
                body = _zstd_compress(raw) if enc == "zstd" else _gzip_compress(raw)
                if len(body) >= len(raw):
                    body = None  # negative entry: incompressible, serve identity
            COMPRESS_CACHE.put(key, body)
        if body is None:
            return False

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(fspath))
        self.send_header("Content-Encoding", enc)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return True

    def do_GET(self):
        if self._maybe_send_compressed():
            return
        super().do_GET()

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
        # Any extension that CAN be served compressed varies by Accept-Encoding,
        # whether or not this particular response was compressed (keeps every
        # cache in front — SW, proxy.cjs, browser — from mixing encodings).
        if os.path.splitext(path)[1].lower() in TEXT_COMPRESS_EXTS | BIN_COMPRESS_EXTS:
            self.send_header("Vary", "Accept-Encoding")
        if COI:
            # Both headers are required — COOP alone does not isolate. Same-origin
            # workers (bake_worker, net worker) inherit isolation; the wsbridge
            # WebSocket is COEP-exempt. Cross-origin subresources must then supply
            # CORP or pass a CORS check (jsdelivr importmap / Servers.xml).
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        if (
            path.startswith(("/dist/shards/", "/dist/packs/", "/dist/index/"))
            and 200 <= status < 300
        ):
            # Content-addressed tiers: legacy shards + (T10) HBP1 packs and
            # the HBSI1 index — immutable by name, 200-gated, no-transform
            # (pass 3 S6.1/S6.3: hash = bytes; CDN must not re-encode).
            self.send_header(
                "Cache-Control", "public, max-age=31536000, immutable, no-transform")
        elif path.endswith(
            (".js", ".mjs", ".wasm", ".bin", ".hba",
             # Load-regression fix 2026-08-03: static imagery was falling to
             # the no-store branch below, so the 9 MB terrain_macro PNG set
             # (default-ON, and until today on the blocking boot path)
             # re-downloaded in full on EVERY page load — brutal over a
             # tunnel. Same revalidating contract as JS: 304 when unchanged.
             ".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".exr")
        ) and not path.endswith("manifest.json"):
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
    ap.add_argument("--coi", action="store_true",
                    help="send COOP/COEP cross-origin-isolation headers (required for "
                         "SharedArrayBuffer / wasm threads; changes cross-origin loads)")
    args = ap.parse_args()

    global COI
    COI = args.coi

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

    w = health["wasm"]
    if w.get("present"):
        print(f"[serve] wasm: {w['bytes'] / 1e6:.1f} MB ({w['profile_guess']}, mtime {w['mtime']})",
              file=sys.stderr)
        if w["profile_guess"] == "DEV-SUSPECT":
            print("[serve] WARNING: pkg wasm is DEV-sized (~4x slower runtime). If unintended:\n"
                  "[serve]   wasm-pack build --target web --out-dir pkg --release", file=sys.stderr)
        if w.get("stale_vs_rust_commit"):
            print("[serve] WARNING: pkg wasm predates the last Rust-touching commit — REBUILD before\n"
                  "[serve]   trusting any measurement (pkg/ is gitignored; stale = silent boot fail).",
                  file=sys.stderr)
    else:
        print("[serve] WARNING: no pkg wasm found — the app cannot boot until wasm-pack builds pkg/.",
              file=sys.stderr)

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
    if ZSTD_IMPL is not None:
        print(f"[serve] compression: text=gzip-{GZIP_LEVEL}, binary=zstd ({ZSTD_IMPL}) with gzip fallback.",
              file=sys.stderr)
    else:
        print(f"[serve] WARNING: no zstd codec (no `zstandard` package; stdlib compression.zstd needs "
              f"Python>=3.14, this is {sys.version.split()[0]}) — binary payloads (wasm/shards) fall back "
              "to gzip. `pip install --user zstandard` to enable.", file=sys.stderr)
    if COI:
        print("[serve] --coi: COOP=same-origin COEP=require-corp (crossOriginIsolated).\n"
              "[serve]   Use ?nosw=1 — SW-cached responses predate these headers and silently\n"
              "[serve]   un-isolate the document (service-worker.js CONTENT_CACHE needs a bump).",
              file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] shutting down.", file=sys.stderr)
        httpd.shutdown()


if __name__ == "__main__":
    main()
