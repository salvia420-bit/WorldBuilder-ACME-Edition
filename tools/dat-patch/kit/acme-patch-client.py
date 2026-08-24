#!/usr/bin/env python3
"""acme-patch-client.py - ACME r8 kit client patcher (Linux / macOS / wine players).

The Windows path is patch-my-client.bat -> acme-patch-client.ps1; this is the
same 8 byte-deltas for people who run Asheron's Call under wine, where no
PowerShell exists. It patches YOUR OWN retail End-of-Retail acclient.exe
(2015-06-12 build 6096) - the ACME kit ships no client executable.

Doctrine (mirrors the lane's patch_client.py):
  * every site is located by a UNIQUE byte SIGNATURE, never a quoted address;
  * a signature that is missing, or found more than once, REFUSES;
  * idempotent - a site already carrying the replacement is a no-op;
  * fail-loud - nothing is written unless every patch resolves;
  * the PE checksum is recomputed.

usage:
  python3 acme-patch-client.py                 patch ./acclient.exe (backup first)
  python3 acme-patch-client.py --verify        report patch state, write nothing
  python3 acme-patch-client.py --check-kit     the play.bat check, for wine players:
                                               every dat at its manifest size AND a
                                               patched client, before you launch
  options: --exe PATH  --out PATH  --no-backup  --quiet
exit: 0 ok / already patched | 1 refused (nothing written) | 2 usage
"""
import argparse
import hashlib
import os
import re
import shutil
import struct
import sys

EXPECTED_SIZE = 4841472

# (key, title, sig, needle_at, needle, replace) - identical to the .ps1 table;
# tools/dat-patch/kit/check_ps1_table.py gates both against the lane registry.
PATCHES = [
    ("palette-leak", "notan's EOR palette-leak fix (site 1 of 3)",
     "66feffff85c07403ff4024c3", 8, "ff4024", "909090"),
    ("palette-leak-2", "notan's EOR palette-leak fix (site 2 of 3)",
     "85f6743cff46248b06538bce", 4, "ff4624", "909090"),
    ("palette-double-free", "releasePalette double-free fix (site 3 of 3 - MANDATORY companion)",
     "066a018bceff50188b166a018bceff52185ec38b068bce5eff", 8,
     "8b166a018bceff5218", "909090909090909090"),
    ("dat-version-preserve", "preserve BTEntry version through DiskController::Decompress",
     "e81853d9ff8d4c2424e80f53d9ff5f5e5d", 5,
     "8d4c2424e80f53d9ff", "0fb745028946049090"),
    ("highres-force-mount", "CLCache::OnServerInterrogation - mount client_highres.dat",
     "89bef402000089bef8020000f64510047405e840feffff8b45088b16", 16, "7405", "9090"),
    ("highres-advertise-cap", "CLCache::OnServerInterrogation - advertise only dats 0-2",
     "84c0750232db8b86e8010000473bf872b5", 6, "8b86e8010000", "b80300000090"),
    ("res-4k-unlock", "4K-res unlock 1/2: UIElement::MouseResizeElement clamps",
     "8bcb8944241c03f7e8a3f8ffff8d54242c526a3d8bcb88442440e891f8ffff884424118d442420506a3e8bcbe87ff8ffff8d4c2424516a3c8bcb8844243ce86df8ffff8b8b800400004983f9078ad0885424120f87b3020000",
     13,
     "8d54242c526a3d8bcb88442440e891f8ffff884424118d442420506a3e8bcbe87ff8ffff8d4c2424516a3c8bcb8844243ce86df8ffff8b8b800400004983f9078ad088542412",
     "c744242c000f00009088442438c644241100909090908d442420506a3e8bcbe87ff8ffffc7442424700800009088442434c6442412008b8b800400004933c033d283f9079090"),
    ("res-4k-unlock-2", "4K-res unlock 2/2: UIElement::ResizeTo clamps",
     "8bcee89ecdffff84c0740a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0740a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0740c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0740a8b4424183bd87d028bd8",
     9,
     "740a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0740a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0740c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c074",
     "eb0a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0eb0a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0eb0c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0eb"),
]


def die(msg):
    print("\nREFUSED: " + msg, file=sys.stderr)
    sys.exit(1)


# --- dat-align-lfa: the many-site DAT-parser alignment patch ----------------
# Retail's archive/cache 4-byte alignment idiom computes `(signed int)ptr % 4`
# (`and r32, 0x80000003` + sign fixup).  acclient is large-address-aware, so
# above 2 GB buffer pointers are negative as signed ints, the modulo returns
# the wrong pad, the read cursor desyncs, and the DAT parsers AV.  The fix
# clears the sign bit of the immediate at EVERY idiom site (signed %4 ->
# unsigned &3) — byte-identical behavior for all sub-2GB pointers.  Ported
# from the lane registry's AlignIdiomPatch (patch_client.py); the site filter
# (AND opcode before the imm + mov r32,4 + or r32,-4 within 28 bytes) is what
# skips the file's non-idiom uses of the constant.  Fail-loud: exactly
# ALIGN_SITES sites of exactly one form, or nothing is written.
ALIGN_KEY = "dat-align-lfa"
ALIGN_SITES = 189
_ALIGN_IMM_ORIG = b"\x03\x00\x00\x80"
_ALIGN_IMM_LFA = b"\x03\x00\x00\x00"
_ALIGN_OR_MINUS4 = re.compile(rb"\x83[\xc8-\xcf]\xfc")
_ALIGN_WINDOW = 28


def align_scan(buf, imm):
    hits, j = [], -1
    while True:
        j = buf.find(imm, j + 1)
        if j < 0:
            break
        if j < 2:
            continue
        if not (buf[j - 1] == 0x25 or
                (buf[j - 2] == 0x81 and 0xE0 <= buf[j - 1] <= 0xE7)):
            continue
        w = bytes(buf[j + 4:j + 4 + _ALIGN_WINDOW])
        if b"\x04\x00\x00\x00" not in w:
            continue
        if not _ALIGN_OR_MINUS4.search(w):
            continue
        hits.append(j)
    return hits


def align_state(buf):
    """('orig'|'patched', sites) or die — any other census means wrong build."""
    o = align_scan(buf, _ALIGN_IMM_ORIG)
    p = align_scan(buf, _ALIGN_IMM_LFA)
    if len(o) == ALIGN_SITES and not p:
        return "orig", o
    if len(p) == ALIGN_SITES and not o:
        return "patched", p
    die(f"[{ALIGN_KEY}] found {len(o)} original + {len(p)} patched alignment-idiom "
        f"sites, expected exactly {ALIGN_SITES} of one form. This is not the retail "
        "End-of-Retail acclient.exe (or another tool partially changed it). "
        "Nothing was written.")


def locate(buf, sig_hex, at, needle_hex, replace_hex, key):
    sig = bytes.fromhex(sig_hex)
    needle, replace = bytes.fromhex(needle_hex), bytes.fromhex(replace_hex)
    if sig[at:at + len(needle)] != needle or len(needle) != len(replace):
        die(f"[{key}] malformed patch table entry")
    prefix, suffix = sig[:at], sig[at + len(needle):]
    hits, i = [], -1
    while True:
        i = buf.find(prefix, i + 1) if prefix else buf.find(needle, i + 1)
        if i < 0:
            break
        mid = i + len(prefix) if prefix else i
        if bytes(buf[mid:mid + len(needle)]) not in (needle, replace):
            continue
        if suffix and bytes(buf[mid + len(needle):mid + len(needle) + len(suffix)]) != suffix:
            continue
        hits.append(mid)
    if not hits:
        die(f"[{key}] signature not found. This is not the retail End-of-Retail "
            "acclient.exe (or another tool already changed this site). Nothing was written.")
    if len(hits) > 1:
        die(f"[{key}] signature is NOT unique ({len(hits)} matches) - refusing. Nothing was written.")
    return hits[0]


def csum_off(buf):
    lfanew = struct.unpack_from("<I", buf, 0x3C)[0]
    if bytes(buf[lfanew:lfanew + 4]) != b"PE\0\0":
        die("not a PE file")
    return lfanew + 4 + 20 + 64


def pe_checksum(buf, off):
    total, i, limit = 0, 0, len(buf)
    while i + 1 < limit:
        if i == off:
            i += 4
            continue
        total += buf[i] | (buf[i + 1] << 8)
        total = (total & 0xFFFF) + (total >> 16)
        i += 2
    if i < limit:
        total += buf[i]
        total = (total & 0xFFFF) + (total >> 16)
    total = (total & 0xFFFF) + (total >> 16)
    return (total + limit) & 0xFFFFFFFF


def check_kit(exe, quiet):
    """play.bat's rule, for players who launch acclient.exe under wine directly."""
    if not os.path.exists("kit-manifest.txt"):
        die("kit-manifest.txt is missing - this install is incomplete. Re-download the kit.")
    bad = []
    with open("kit-manifest.txt", "rb") as fh:
        for raw in fh.read().decode("ascii").splitlines():
            line = raw.strip()
            if not line:
                continue
            name, _, size = line.partition("|")
            if not os.path.exists(name):
                bad.append(f"{name} missing")
            elif os.path.getsize(name) != int(size):
                bad.append(f"{name} wrong size {os.path.getsize(name)} expected {size}")
    if bad:
        die("this install is incomplete - the game will NOT start correctly: "
            + "; ".join(bad) + ". Re-download the kit or restore the named files.")
    if not quiet:
        print("dats: all present at their manifest sizes")
    return exe


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--exe", default="acclient.exe")
    ap.add_argument("--out", default="")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--check-kit", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    def say(m):
        if not a.quiet:
            print(m)

    if a.check_kit:
        check_kit(a.exe, a.quiet)

    if not os.path.exists(a.exe):
        die(f"{a.exe} not found. Run this from your Asheron's Call install folder, "
            "or pass --exe PATH.")
    buf = bytearray(open(a.exe, "rb").read())
    say(f"\nACME client patcher - {os.path.abspath(a.exe)}")
    say(f"  size {len(buf):,} bytes")
    if len(buf) != EXPECTED_SIZE:
        die(f"unexpected size {len(buf):,} (expected {EXPECTED_SIZE:,} for the retail "
            "End-of-Retail acclient.exe). This patcher targets that build only; "
            "nothing was written.")

    sites = []
    for key, _title, sig, at, needle, replace in PATCHES:
        off = locate(buf, sig, at, needle, replace, key)
        cur = bytes(buf[off:off + len(needle) // 2])
        state = "orig" if cur == bytes.fromhex(needle) else "patched"
        sites.append((key, off, state, replace))
        say(f"  [{key:<22}] 0x{off:06X}  {state}")

    a_state, a_sites = align_state(buf)
    sites.append((ALIGN_KEY, a_sites[0], a_state, None))
    say(f"  [{ALIGN_KEY:<22}] 0x{a_sites[0]:06X}  {a_state} ({len(a_sites)} idiom sites)")

    todo = [s for s in sites if s[2] == "orig"]
    n_all = len(sites)
    if a.verify or a.check_kit:
        if todo:
            if a.check_kit:
                die(f"your {a.exe} is not patched for this release - run this script "
                    "without --check-kit first. Without the patch the client never "
                    "loads client_highres.dat and most textures would be missing.")
            say(f"\nVERIFY: {len(todo)} of {len(sites)} sites still original - "
                "run this script without --verify to patch.")
            return 1
        say("\n" + ("KIT-OK" if a.check_kit else f"VERIFY: fully patched ({n_all}/{n_all} patches)."))
        return 0

    if not todo:
        say(f"\nAlready patched ({n_all}/{n_all} patches) - nothing to do.")
        return 0

    target = a.out or a.exe
    if not a.out and not a.no_backup:
        bak = a.exe + ".acme-orig.bak"
        if not os.path.exists(bak):
            shutil.copy2(a.exe, bak)
            say(f"  backup -> {bak}")
        else:
            say(f"  backup already exists -> {bak} (kept)")
    for key, off, state, replace in sites:
        if state == "patched":
            continue
        if key == ALIGN_KEY:
            for j in a_sites:
                buf[j + 3] = 0x00
            say(f"  applied [{key}] at {len(a_sites)} idiom sites (1 byte each)")
            continue
        rep = bytes.fromhex(replace)
        buf[off:off + len(rep)] = rep
        say(f"  applied [{key}] at 0x{off:06X} ({len(rep)} bytes)")
    off = csum_off(buf)
    struct.pack_into("<I", buf, off, 0)
    val = pe_checksum(buf, off)
    struct.pack_into("<I", buf, off, val)
    with open(target, "wb") as fh:
        fh.write(buf)
    say(f"  PE checksum 0x{val:08X}")
    say(f"\nPATCHED: {os.path.abspath(target)}")
    say(f"  sha256 {hashlib.sha256(buf).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
