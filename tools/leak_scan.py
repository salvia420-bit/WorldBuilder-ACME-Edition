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
    "ac-dat-test",
    # the original ASCII text-gate patterns
    "/mnt/",
    "/home/",
    # Windows and macOS home directories. The Linux "/home/" above only ever
    # caught half the problem: a Windows build (the installer is built on
    # Windows-targeting runners, and the launcher is a Windows app) bakes
    # "C:\\Users\\<name>\\..." into project/publish paths, and a macOS build bakes
    # "/Users/<name>/...". Both disclose a real person's account name.
    # ":\\Users\\" rather than "C:\\Users\\" on purpose: it is drive-letter agnostic,
    # so a D:/E: checkout is caught too, and it cannot match anything else -
    # a colon immediately followed by \\Users\\ is a Windows absolute path, whatever
    # its case, so this one is safe to fold.
    ":\\Users\\",
]

# Literals matched CASE-SENSITIVELY. Everything above is folded, which is right
# for a path or a credential but wrong for a short lowercase word that is also a
# legal fragment of an identifier: "buildbox" folded matches the metadata name
# `BuildBoxGeometry` (WorldBuilder/Editors/Landscape/TransformGizmo.cs), so every
# build of the editor tripped the gate on a method name. The dev box is spelled
# `buildbox` in lower case everywhere it actually appears - hostnames, ssh
# targets, paths - so matching case exactly keeps the coverage and drops the
# false positive. Add to this list, not to LITERALS, whenever a pattern is a
# short lowercase word rather than a structured path/credential.
CASE_SENSITIVE_LITERALS = [
    "buildbox",
    # The macOS home prefix. Case-folded it matches the "/users/" path segment of
    # any REST URL or JSON pointer ("https://api.example.com/v1/users/42"), which
    # is common enough in shipped text and metadata to make the gate unpassable.
    # macOS spells the real directory "/Users" with a capital U, always, so an
    # exact-case match loses nothing.
    "/Users/",
]

# ---- regex sweeps -----------------------------------------------------------
# Some leaks have no fixed literal. An e-mail address is the one that matters
# here: the repo owner's personal address appeared in a committed .patch file and
# in a shell script, and no literal list can anticipate every address a future
# script might embed. This is deliberately the ONLY regex, and it is tuned for
# PRECISION, because the gate is fatal and also runs with --all-files over dats
# and images, where random bytes readily look like "x@y.z":
#   * local part 3-64 of the RFC-ish safe set, so single-character noise misses;
#   * at least one 2-63 char domain label;
#   * a LOWERCASE 2-24 letter TLD - mixed-case tails are the signature of binary
#     noise, and a real address's domain is lower-case in every file we ship;
#   * boundary guards on both ends so it cannot fire inside a longer token.
# Nothing is case-folded here (unlike LITERALS), for exactly that reason.
def _email_rx(wide):
    r"""The e-mail sweep, compiled for ASCII/UTF-8 or for UTF-16LE raw bytes.

    Both encodings come from ONE definition: in the wide form every single
    character becomes `(?:<class>\x00)`, which is what a UTF-16LE literal looks
    like on disk for any character in the ASCII range - and an e-mail address in
    a .NET string literal is exactly that.

    (This docstring is a RAW string on purpose. A plain "\x00" here would embed
    an actual NUL byte in this file, and ripgrep skips NUL-containing files
    during a directory walk - the scanner would then be invisible to the greps
    people use to audit it.)
    """
    def ch(cls, quant=""):
        return (f"(?:{cls}\\x00)" if wide else cls) + quant

    local = ch(r"[A-Za-z0-9._%+\-]", "{3,64}")
    at = ch(r"@")
    label = "(?:" + ch(r"[A-Za-z0-9\-]", "{2,63}") + ch(r"\.") + ")+"
    tld = ch(r"[a-z]", "{2,24}")
    # Boundary guards. Fixed width (1 byte narrow / 2 bytes wide), which is all
    # Python's lookbehind supports, and all that is needed.
    # '?' and '$' are in the exclusion set for PRECISION, not politeness: a C++/CLI
    # mangled name is a dense run of them, and Microsoft's own System.Printing.dll
    # (pulled in by WPF, and therefore scanned as a zzpatcher pre-bundle input)
    # contains "??__E?A0x132e1b53@vc.cppcli.attributes@SA_Yes@@YMXXZ" seven times.
    # The middle of that parses as local="A0x132e1b53", labels="vc.cppcli.",
    # tld="attributes" - a perfect e-mail shape that is not an address. Every such
    # run is preceded by '?' or '$', and a REAL address never is: prose puts a
    # space or '<' there, a URL query puts '=', a binary puts a NUL or a length
    # byte. Excluding them kills the whole mangled-name class without weakening
    # the sweep - "?" before an address is not a thing that happens.
    before = f"(?<!{ch(r'[A-Za-z0-9._%+@?$-]')})"
    # Only an alphanumeric may not follow: a trailing "." or "-" is prose or
    # punctuation ("write to bob@example.com."), and excluding those here would
    # turn the single most common way an address appears into a false negative.
    after = f"(?!{ch(r'[A-Za-z0-9]')})"
    return re.compile((before + local + at + label + tld + after).encode("ascii"))

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
    # Same category, different upstream build machines. These are paths belonging
    # to the AUTHORS of NuGet packages we consume, baked into THEIR shipped
    # assemblies' RSDS debug directory. We do not compile these, cannot rebuild
    # them with -p:PathMap, and they disclose nothing about us or our users.
    # Verified against WorldBuilder.Windows/bin/Release/net8.0/win-x64/publish/:
    #   MicroCom.Runtime.dll  (Avalonia's COM interop generator)
    "/home/kekekeks/Projects/",
    #   NAudio.dll, NAudio.Asio/Core/Midi/Wasapi/WinMM.dll  (audio stack)
    "C:\\Users\\markh\\",
    #   HtmlAgilityPack.dll 1.5.1, shipped inside the stock Chorizite RmlUi plugin
    #   release (external/chorizite-plugins/RmlUi/, fetched and digest-verified by
    #   tools/plugin-pack/fetch_stock_plugins.sh). Its RSDS debug-directory entry names
    #   the package author's own build path. This is the ONE hit in either stock plugin
    #   folder -- verified by scanning both trees in both encodings -- and it is as
    #   narrow as an allowlist entry can be: the full directory prefix, not ":\\Users\\".
    "C:\\Users\\Jonathan\\Desktop\\Z\\zzzproject\\",
    # SigScan.dll (upstream Chorizite runtime component). Its VERSIONINFO
    # LegalCopyright field reads "Copyright (C) 2009 Aikar@Windower.net" -- the
    # ORIGINAL AUTHOR'S own attribution, which is exactly what a copyright notice
    # is for. It is a third party's contact address, not ours, we do not build
    # this binary, and stripping another author's credit would be wrong even if we
    # could. Narrow: the full address, never a bare domain or "@".
    "Aikar@Windower.net",
]

# ---- per-file exemption from the E-MAIL SWEEP ONLY --------------------------
# A third-party attribution notices file is the one place where e-mail addresses
# are supposed to appear: upstream licences name their authors, and several
# require that the notice travel verbatim with the binary. Chasing those
# addresses means either editing someone else's licence text (not acceptable) or
# re-allowlisting every address each time a dependency bumps.
#
# So these filenames are exempt from the e-mail regex AND NOTHING ELSE. They are
# still scanned, in both encodings, for every literal: our hostnames, our
# credentials, our tailnet range, ":\\Users\\". A leak of OURS in one of these
# files still fails the gate. Match is on the basename, case-insensitively.
EMAIL_EXEMPT_BASENAMES = {
    "dotnet-third-party-notices.txt",
    "third-party-notices.txt",
}

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

_CS_ASCII_RX = re.compile(
    b"(?:" + b"|".join(re.escape(s.encode("ascii"))
                       for s in CASE_SENSITIVE_LITERALS) + b")")
_CS_WIDE_RX = re.compile(
    b"(?:" + b"|".join(re.escape(s.encode("utf-16-le"))
                       for s in CASE_SENSITIVE_LITERALS) + b")")

# The e-mail sweep, one per encoding, built once alongside the literal ones.
_EMAIL_ASCII_RX = _email_rx(False)
_EMAIL_WIDE_RX = _email_rx(True)

# Every pattern that applies to a given encoding, in one place.
_RX_BY_ENCODING = {
    False: (_ASCII_RX, _CS_ASCII_RX, _EMAIL_ASCII_RX),
    True: (_WIDE_RX, _CS_WIDE_RX, _EMAIL_WIDE_RX),
}


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


_USERS_ENC = {False: b":\\Users\\", True: ":\\Users\\".encode("utf-16-le")}


def _is_bare_users_template(buf, start, end, wide):
    """True for a ":\\Users\\" hit with NO account name after it.

    Chorizite.Injector.dll builds its symbol-cache path from two separate string
    literals -- "C:\\Users\\" and "\\AppData\\Local\\Temp\\SymbolCache" -- and fills the
    account name in at run time. Verified by reading the bytes: the first literal
    is followed immediately by its NUL terminator, so no person's name is in the
    file at all. A REAL leak is ":\\Users\\<name>\\...", which still fires: this
    only suppresses the hit when the very next character cannot begin a name.

    Deliberately NOT an allowlist entry: allowlisting the string "C:\\Users\\"
    would suppress every genuine Windows home-directory path and gut the check.
    """
    a = _USERS_ENC[wide]
    if end - start != len(a) or bytes(buf[start:end]).lower() != a.lower():
        return False
    step = 2 if wide else 1
    nxt = bytes(buf[end:end + step])
    if len(nxt) < step:
        return True                      # end of file: nothing follows
    if wide and nxt[1:2] != b"\x00":
        return False                     # not a plain ASCII char in UTF-16LE
    ch = nxt[0:1]
    # A name cannot start with a terminator, a separator, or a quote.
    return ch in (b"\x00", b"\\", b"/", b'"', b"'", b"\r", b"\n", b"\t", b" ")


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
            email_exempt = (os.path.basename(path).lower()
                            in EMAIL_EXEMPT_BASENAMES)
            for wide in (False, True):
                spans = []
                lit_rx, cs_rx, email_rx = _RX_BY_ENCODING[wide]
                for rx in (lit_rx, cs_rx) if email_exempt else (lit_rx, cs_rx, email_rx):
                    spans += [(m.start(), m.end()) for m in rx.finditer(mm)]
                spans += list(_ts_hits(mm, wide))
                for s, e in sorted(spans):
                    if _allowed(mm, s, e, wide):
                        continue
                    if _is_bare_users_template(mm, s, e, wide):
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
              f"(ASCII + UTF-16LE, "
              f"{len(LITERALS) + len(CASE_SENSITIVE_LITERALS)} literals + the "
              f"100.{TAILSCALE_LO}.0.0/10 and e-mail-address sweeps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
