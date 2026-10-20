#!/usr/bin/env python3
"""test_serve_cache_headers.py — serve.py's Cache-Control tiers, end to end, no socket.

2026-10-20 (improvement hunt boot-cache-1): the terrain BC7 tiers (.hbc7) fell
to the `no-cache, no-store, must-revalidate` branch of `Handler.end_headers`,
so every warm boot, every SW background refresh and the first context-loss
restore re-downloaded them in full (~78 MB at t1024). This drives the REAL
`Handler` (imported from serve.py; requests read from / responses written to
in-memory streams, so no port is bound and the running server is untouched)
over a throwaway tree and pins:

  H1  .hbc7 identity 200: `Cache-Control: no-cache` (no no-store / Pragma /
      Expires), Last-Modified sent, bytes intact
  H2  .hbc7 identity + If-Modified-Since: 304 with `no-cache` (the stdlib path)
  H3  .hbc7 gzip 200: Content-Encoding gzip, `no-cache`, Vary, Last-Modified
  H4  .hbc7 gzip + If-Modified-Since: 304 (the compressed path's own IMS check)
  H5  .hbc7 + an OLDER If-Modified-Since: a full 200 (freshness kept)
  H6  controls: the tier manifest.json and an unknown extension stay no-store;
      .png stays no-cache (the 2026-08-03 tier)

    python3 scripts/test_serve_cache_headers.py
"""

from __future__ import annotations

import gzip
import io
import os
import sys
import tempfile
from email.utils import formatdate
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import serve  # noqa: E402  (import-safe: main() is behind __name__ guard)

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"  {'ok ' if ok else 'FAIL'} {name}{'' if ok else '  ' + detail}")
    if not ok:
        failures += 1


def request(root: Path, path: str, headers: dict[str, str] | None = None):
    """One GET through serve.Handler. Returns (status, {header: value}, body)."""
    raw = f"GET {path} HTTP/1.1\r\nHost: test\r\n"
    for k, v in (headers or {}).items():
        raw += f"{k}: {v}\r\n"
    raw += "\r\n"
    h = serve.Handler.__new__(serve.Handler)  # skip socket setup
    h.directory = str(root)
    h.rfile = io.BytesIO(raw.encode("latin-1"))
    h.wfile = io.BytesIO()
    h.client_address = ("127.0.0.1", 0)
    h.handle_one_request()
    head, _, body = h.wfile.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    hdrs: dict[str, str] = {}
    for line in lines[1:]:
        k, _, v = line.partition(":")
        key = k.strip().lower()
        hdrs[key] = f"{hdrs[key]}, {v.strip()}" if key in hdrs else v.strip()
    return status, hdrs, body


with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    tier = root / "apps" / "holtburger-web" / "scene3d" / "assets" / "terrain_bc7" / "t1024"
    tier.mkdir(parents=True)
    payload = b"HBC7" + bytes(range(256)) * 32  # > MIN_COMPRESS_BYTES, compressible
    hbc7 = tier / "0x06006D06_color.hbc7"
    hbc7.write_bytes(payload)
    (tier / "manifest.json").write_text('{"tier":"t1024"}' + " " * 400)
    macro = root / "apps" / "holtburger-web" / "scene3d" / "assets" / "terrain_macro"
    macro.mkdir(parents=True)
    (macro / "m.png").write_bytes(b"\x89PNG" + bytes(600))
    (tier / "notes.xyz").write_bytes(b"x" * 600)
    mtime = 1_790_000_000  # fixed, so Last-Modified is deterministic
    for p in (hbc7, tier / "manifest.json", macro / "m.png", tier / "notes.xyz"):
        os.utime(p, (mtime, mtime))
    lm = formatdate(mtime, usegmt=True)
    older = formatdate(mtime - 86400, usegmt=True)
    url = "/apps/holtburger-web/scene3d/assets/terrain_bc7/t1024/0x06006D06_color.hbc7"

    def no_store(h: dict[str, str]) -> bool:
        return "no-store" in h.get("cache-control", "") or "pragma" in h or "expires" in h

    s, h, b = request(root, url)
    check("H1 .hbc7 identity: 200", s == 200, str(s))
    check("H1 Cache-Control: no-cache (revalidating)", h.get("cache-control") == "no-cache", str(h))
    check("H1 no no-store / Pragma / Expires", not no_store(h), str(h))
    check("H1 Last-Modified sent", h.get("last-modified") == lm, str(h.get("last-modified")))
    check("H1 identity bytes intact", b == payload and "content-encoding" not in h)
    check("H1 Vary: Accept-Encoding (compressible extension)", h.get("vary") == "Accept-Encoding", str(h))

    s, h, b = request(root, url, {"If-Modified-Since": lm})
    check("H2 .hbc7 identity + IMS: 304 (stdlib path)", s == 304, str(s))
    check("H2 304 keeps no-cache, no no-store", h.get("cache-control") == "no-cache" and not no_store(h), str(h))
    check("H2 304 has no body", b == b"")

    s, h, b = request(root, url, {"Accept-Encoding": "gzip"})
    check("H3 .hbc7 gzip: 200", s == 200, str(s))
    check("H3 Content-Encoding gzip", h.get("content-encoding") == "gzip", str(h))
    check("H3 Cache-Control: no-cache", h.get("cache-control") == "no-cache" and not no_store(h), str(h))
    check("H3 Last-Modified sent", h.get("last-modified") == lm, str(h.get("last-modified")))
    check("H3 gunzipped bytes intact", gzip.decompress(b) == payload)

    s, h, b = request(root, url, {"Accept-Encoding": "gzip", "If-Modified-Since": lm})
    check("H4 .hbc7 gzip + IMS: 304 (compressed path)", s == 304, str(s))
    check("H4 304 keeps no-cache", h.get("cache-control") == "no-cache" and not no_store(h), str(h))
    check("H4 304 has no body", b == b"")

    s, h, b = request(root, url, {"If-Modified-Since": older})
    check("H5 older IMS: full 200 (freshness kept)", s == 200 and b == payload, str(s))

    s, h, _ = request(root, "/apps/holtburger-web/scene3d/assets/terrain_bc7/t1024/manifest.json")
    check("H6 tier manifest.json stays no-store", s == 200 and no_store(h), str(h))
    s, h, _ = request(root, "/apps/holtburger-web/scene3d/assets/terrain_bc7/t1024/notes.xyz")
    check("H6 unknown extension stays no-store", s == 200 and no_store(h), str(h))
    s, h, _ = request(root, "/apps/holtburger-web/scene3d/assets/terrain_macro/m.png")
    check("H6 .png stays no-cache", s == 200 and h.get("cache-control") == "no-cache", str(h))

print(f"\n{'OK' if failures == 0 else f'{failures} FAILURE(S)'}")
sys.exit(1 if failures else 0)
