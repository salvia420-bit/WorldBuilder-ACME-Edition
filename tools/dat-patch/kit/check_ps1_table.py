#!/usr/bin/env python3
"""check_ps1_table.py — gate the kit patcher's embedded byte table.

The kit ships acme-patch-client.ps1 (players patch their OWN retail exe; the
kit redistributes no client bytes).  Its patch table is a hand-carried copy of
the lane registry, so it needs a machine gate, not an eyeball:

  1. table parity  — every enabled patch in patch_client.py appears in the ps1
     with identical sig / needle_at / needle / replace, and the ps1 carries
     nothing extra (a stray candidate would ship an ungated byte change).
  2. artifact parity — applying the ps1's OWN table to the pristine retail exe
     reproduces the SHIPPING exe byte-for-byte (PE checksum included).

Usage: check_ps1_table.py [--ps1 …] [--registry …] [--orig …] [--shipped …]
Exit 0 = both gates green.
"""
import argparse, hashlib, importlib.util, re, struct, sys

DEF_PS1 = "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch/kit/acme-patch-client.ps1"
DEF_REG = "/mnt/wbterminal2/ac-eor-patch/patch_client.py"
DEF_ORIG = "/mnt/wbterminal2/ac-eor-patch/acclient.eor.orig.exe"
DEF_SHIP = "/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.exe"


def parse_ps1(path):
    """Pull the @{ key=…; sig=…; at=…; needle=…; replace=… } entries."""
    txt = open(path, encoding="utf-8").read()
    body = txt.split("$PATCHES = @(", 1)[1]
    out = []
    for m in re.finditer(
            r"@\{\s*key='([^']+)';.*?sig='([0-9a-f]+)';\s*at=(\d+);\s*"
            r"needle='([0-9a-f]+)';\s*replace='([0-9a-f]+)'\s*\}", body, re.S):
        key, sig, at, needle, replace = m.groups()
        out.append(dict(key=key, sig=sig, at=int(at), needle=needle, replace=replace))
    return out


def load_registry(path):
    spec = importlib.util.spec_from_file_location("pc", path)
    pc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pc)
    return pc


def pe_csum_off(buf):
    lfanew = struct.unpack_from("<I", buf, 0x3C)[0]
    assert buf[lfanew:lfanew + 4] == b"PE\0\0", "not a PE file"
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


def locate(buf, ent):
    """The ps1's own locate rule: unique prefix+mid∈{needle,replace}+suffix."""
    sig, at = bytes.fromhex(ent["sig"]), ent["at"]
    needle, replace = bytes.fromhex(ent["needle"]), bytes.fromhex(ent["replace"])
    assert sig[at:at + len(needle)] == needle, f"{ent['key']}: needle not at `at` inside sig"
    assert len(needle) == len(replace), f"{ent['key']}: length change not allowed"
    prefix, suffix = sig[:at], sig[at + len(needle):]
    hits, i = [], -1
    while True:
        i = buf.find(prefix, i + 1) if prefix else buf.find(needle, i + 1)
        if i < 0:
            break
        mid = i + len(prefix) if prefix else i
        if buf[mid:mid + len(needle)] not in (needle, replace):
            continue
        if suffix and buf[mid + len(needle):mid + len(needle) + len(suffix)] != suffix:
            continue
        hits.append(mid)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ps1", default=DEF_PS1)
    ap.add_argument("--registry", default=DEF_REG)
    ap.add_argument("--orig", default=DEF_ORIG)
    ap.add_argument("--shipped", default=DEF_SHIP)
    a = ap.parse_args()

    ps1 = parse_ps1(a.ps1)
    pc = load_registry(a.registry)
    reg = {p.key: p for p in pc.PATCHES if p.enabled}
    print(f"ps1 table   : {len(ps1)} patches")
    print(f"registry    : {len(reg)} enabled patches")

    bad = 0
    seen = set()
    for e in ps1:
        seen.add(e["key"])
        p = reg.get(e["key"])
        if p is None:
            print(f"  MISMATCH {e['key']}: not enabled in the registry (would ship an ungated change)")
            bad += 1
            continue
        for field, mine, theirs in (("sig", e["sig"], p.sig.hex()),
                                    ("needle_at", e["at"], p.needle_at),
                                    ("needle", e["needle"], p.needle.hex()),
                                    ("replace", e["replace"], p.replace.hex())):
            if mine != theirs:
                print(f"  MISMATCH {e['key']}.{field}: ps1={mine} registry={theirs}")
                bad += 1
    for k in reg:
        if k not in seen:
            print(f"  MISSING  {k}: enabled in the registry, absent from the ps1")
            bad += 1
    print("GATE 1 table parity : " + ("PASS" if bad == 0 else f"FAIL ({bad})"))

    orig = bytearray(open(a.orig, "rb").read())
    ship = open(a.shipped, "rb").read()
    print(f"orig        : {len(orig):,} bytes  sha256 {hashlib.sha256(orig).hexdigest()[:8]}…")
    for e in ps1:
        hits = locate(orig, e)
        if len(hits) != 1:
            print(f"  {e['key']}: {len(hits)} matches — REFUSE")
            bad += 1
            continue
        off = hits[0]
        cur = bytes(orig[off:off + len(e["needle"]) // 2])
        state = "orig" if cur == bytes.fromhex(e["needle"]) else "patched"
        print(f"  [{e['key']:<22}] 0x{off:06X} {state}")
        orig[off:off + len(cur)] = bytes.fromhex(e["replace"])
    off = pe_csum_off(orig)
    struct.pack_into("<I", orig, off, 0)
    struct.pack_into("<I", orig, off, pe_checksum(orig, off))

    got, want = hashlib.sha256(orig).hexdigest(), hashlib.sha256(ship).hexdigest()
    same = got == want
    print(f"rebuilt     : sha256 {got}")
    print(f"shipping exe: sha256 {want}")
    print("GATE 2 artifact parity : " + ("PASS (byte-identical to the gated exe)" if same else "FAIL"))
    if not same:
        diffs = [i for i in range(min(len(orig), len(ship))) if orig[i] != ship[i]]
        print(f"  {len(diffs)} differing bytes, first at 0x{diffs[0]:X}" if diffs else "  length differs")
        bad += 1
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
