#!/usr/bin/env python3
"""leak_scan.py - shared secret/internal-path gate for everything we ship.

The r10 archive shipped a credential leak that the old gate could not see: the
text gate was an ASCII `grep`, and a .NET assembly stores its string literals as
UTF-16LE. `AcmeInject.dll` carried a dev-box client path and a live server
address + test account, and grep walked straight past them.

So this scanner searches EVERY pattern in BOTH encodings (ASCII/UTF-8 and
UTF-16LE, the .NET/Windows-wide literal encoding) over the RAW BYTES of a file -
the equivalent of `strings -a -e s` + `strings -a -e l` piped through one pattern
list. Files are mmap'd, so a multi-GB dat costs no RAM.

  leak_scan.py <path>...              # walk paths, scan by class (see below)
  leak_scan.py --all-files <path>...  # also scan dats/archives/media
  leak_scan.py --label "zzpatcher pre-bundle inputs" <dir>

File classes (default, without --all-files):
  * BINARY  (.dll .exe .so .dylib .node .bin .pdb)   -> scanned, both encodings
  * SKIPPED (.dat .tgz .tar .gz .zip .png .jpg .ttf) -> compressed/opaque payload
  * TEXT    (everything else)                        -> scanned, both encodings
`--all-files` promotes SKIPPED to scanned. Note the deliberate blind spot this
leaves and why the callers close it: a self-contained single-file publish
(zzpatcher.exe) stores its embedded assemblies COMPRESSED, so string-scanning
the bundle proves nothing. The plugin-pack assembler therefore scans the
PRE-BUNDLE publish input directory (the loose managed DLLs the bundler eats)
in addition to the shipped bundle.

Exit 0 = clean, 1 = at least one hit (callers must treat that as fatal), 2 = usage.
"""
import argparse
import mmap
import os
import re
import sys

# ---- the pattern list -------------------------------------------------------
# Every entry is a LITERAL (no regex): a literal search is exact in both
# encodings and needs no fragile "widen this regex" step. The tailscale CGNAT
# range 100.64.0.0/10 is therefore expanded to its 64 literal /16 prefixes,
# which is precisely the set of second octets the range covers.
LITERALS = [
    # credentials / test accounts that must never ship
    "tailnet1",
    "phase4demo",
    # the dev server (also covered by the CGNAT sweep below; listed for the record)
    "100.116.47.66",
    # dev-box hostnames, users and paths
    "wbterminal",
    "buildbox",
    "ac-dat-test",
    # the original ASCII text-gate patterns
    "/mnt/",
    "/home/",
]

# The tailscale CGNAT range 100.64.0.0/10 gets its own anchored scan rather than
# 64 more alternatives: `mm.find` on the 4-byte anchor "100." runs at memchr
# speed, and the second octet is then checked numerically. Folding the whole /10
# into the alternation above made the scan ~9x slower for no extra coverage.
TAILSCALE_LO, TAILSCALE_HI = 64, 127
_TS_ANCHOR = {False: b"100.", True: "100.".encode("utf-16-le")}

# ---- allowlist --------------------------------------------------------------
# A hit is suppressed ONLY when it falls inside one of these exact strings. Every
# entry needs a reason, and "it is noisy" is not one. Keep this list tiny.
ALLOWLIST = [
    # Upstream NuGet assemblies (Chorizite.ACProtocol, Chorizite.Common,
    # DatReaderWriter) carry a GitHub-Actions hosted-runner build path in their
    # RSDS debug directory. That is *their* CI's path, not this machine's, we
    # cannot rebuild them, and it discloses nothing about us. Our OWN assemblies
    # must not rely on this: the assemblers build them with -p:PathMap so they
    # embed /_/ instead of a real path.
    "/home/runner/work/",
]

BINARY_EXT = {".dll", ".exe", ".so", ".dylib", ".node", ".bin"}
# .pdb is deliberately in the skip set. A portable PDB carries a SourceLink
# document map keyed by the ORIGINAL absolute source paths, which -p:PathMap does
# not rewrite — so a pdb always "leaks" and would make the gate cry wolf forever.
# It is safe to skip because a pdb is never shipped: the plugin-pack assembler
# excludes *.pdb from the pack AND fails its verify pass if one appears, the kit
# has none, and zzpatcher's single-file bundle uses the default portable
# DebugType (separate .pdb, not embedded — verified: the .dll carries no
# SourceLink map). Pass --all-files to scan them anyway.
OPAQUE_EXT = {".pdb",
              ".dat", ".tgz", ".tar", ".gz", ".bz2", ".xz", ".zip", ".7z",
              ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".ttf", ".otf",
              ".woff", ".woff2", ".wasm", ".mp3", ".wav", ".ogg"}

# One alternation per encoding, built once. IGNORECASE is safe for the wide
# form too: casefolding is per-byte and never touches the interleaved NULs.
_ASCII_RX = re.compile(
    b"(?:" + b"|".join(re.escape(s.encode("ascii")) for s in LITERALS) + b")",
    re.IGNORECASE)
_WIDE_RX = re.compile(
    b"(?:" + b"|".join(re.escape(s.encode("utf-16-le")) for s in LITERALS) + b")",
    re.IGNORECASE)


def _ts_hits(mm, wide):
    """Anchored sweep for an address in 100.64.0.0/10. Yields (start, end)."""
    anchor = _TS_ANCHOR[wide]
    step = 2 if wide else 1
    n = len(mm)
    pos = mm.find(anchor, 0)
    while pos != -1:
        # read up to 3 decimal chars after "100." then require a '.'
        digits = ""
        i = pos + len(anchor)
        while len(digits) < 3 and i + step <= n:
            ch = mm[i:i + 1]
            if wide and mm[i + 1:i + 2] != b"\x00":
                break
            if not ch.isdigit():
                break
            digits += ch.decode()
            i += step
        if digits and mm[i:i + step] == (b".\x00" if wide else b"."):
            if TAILSCALE_LO <= int(digits) <= TAILSCALE_HI:
                yield pos, i + step
        pos = mm.find(anchor, pos + step)


_ALLOW_ENC = [(s.encode("ascii"), s.encode("utf-16-le")) for s in ALLOWLIST]


def _allowed(buf, start, end, wide):
    """True when the hit lies inside an allowlisted string at this very offset."""
    for asc, wid in _ALLOW_ENC:
        a = wid if wide else asc
        lo = max(0, start - len(a))
        window = bytes(buf[lo:end + len(a)])
        for pos in range(0, len(window) - len(a) + 1):
            if window[pos:pos + len(a)].lower() != a.lower():
                continue
            abs_lo = lo + pos
            if abs_lo <= start and abs_lo + len(a) >= end:
                return True
    return False


def _context(buf, start, end, wide):
    """Readable neighbourhood of a hit, decoded in the encoding it was found in."""
    if wide:
        lo = max(0, start - 80) & ~1
        raw = bytes(buf[lo:min(len(buf), end + 80)])
        txt = raw.decode("utf-16-le", "replace")
    else:
        lo = max(0, start - 40)
        txt = bytes(buf[lo:min(len(buf), end + 40)]).decode("latin-1", "replace")
    return "".join(c if 32 <= ord(c) < 127 else "." for c in txt)


def scan_file(path, all_files=False):
    """-> list of (encoding, offset, context). Empty list = clean."""
    ext = os.path.splitext(path)[1].lower()
    if ext in OPAQUE_EXT and not all_files:
        return []
    hits = []
    try:
        size = os.path.getsize(path)
    except OSError as e:
        print(f"leak-scan: cannot stat {path}: {e}", file=sys.stderr)
        return []
    if size == 0:
        return []
    with open(path, "rb") as fh:
        with mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            for rx, wide in ((_ASCII_RX, False), (_WIDE_RX, True)):
                spans = [(m.start(), m.end()) for m in rx.finditer(mm)]
                spans += list(_ts_hits(mm, wide))
                for s, e in sorted(spans):
                    if _allowed(mm, s, e, wide):
                        continue
                    hits.append(("utf-16le" if wide else "ascii",
                                 s, _context(mm, s, e, wide)))
    return hits


def walk(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
        else:
            for root, dirs, files in os.walk(p):
                dirs.sort()
                for f in sorted(files):
                    yield os.path.join(root, f)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--all-files", action="store_true",
                    help="also scan dats/archives/media (slow; use for the final sweep)")
    ap.add_argument("--label", default="",
                    help="what is being scanned, for the log line")
    ap.add_argument("--quiet", action="store_true",
                    help="print only on failure")
    args = ap.parse_args()

    for p in args.paths:
        if not os.path.exists(p):
            print(f"leak-scan: no such path: {p}", file=sys.stderr)
            return 2

    nfiles = 0
    bad = 0
    for f in walk(args.paths):
        nfiles += 1
        for enc, off, ctx in scan_file(f, args.all_files):
            bad += 1
            print(f"   LEAK  {f}  [{enc} @ 0x{off:x}]  ...{ctx}...")
    what = args.label or ", ".join(args.paths)
    if bad:
        print(f"   LEAK GATE FAILED: {bad} hit(s) in {what} "
              f"({nfiles} files, ASCII + UTF-16LE)", file=sys.stderr)
        return 1
    if not args.quiet:
        print(f"   leak gate clean: {nfiles} files scanned in {what} "
              f"(ASCII + UTF-16LE, {len(LITERALS)} literals + the "
              f"100.{TAILSCALE_LO}.0.0/10 sweep)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
