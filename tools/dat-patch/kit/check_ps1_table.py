#!/usr/bin/env python3
"""check_ps1_table.py — gate the kit patchers' embedded byte tables.

The kit ships acme-patch-client.ps1 (Windows) and acme-patch-client.py
(Linux/macOS/wine); players patch their OWN retail exe, the kit redistributes no
client bytes.  Both carry a hand-copied table of the lane registry, so they need
a machine gate, not an eyeball:

  1. table parity  — every enabled patch in patch_client.py appears in BOTH
     shipped patchers with identical sig / needle_at / needle / replace, and
     they carry nothing extra (a stray candidate would ship an ungated byte
     change), and the two tables agree with each other.
  2. artifact parity — applying the shipped table to the pristine retail exe
     reproduces the SHIPPING exe byte-for-byte (PE checksum included).

Usage: check_ps1_table.py [--ps1 …] [--registry …] [--orig …] [--shipped …]
Exit 0 = both gates green.
"""
import argparse, hashlib, importlib.util, re, struct, sys

DEF_PS1 = "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch/kit/acme-patch-client.ps1"
DEF_PY = "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch/kit/acme-patch-client.py"
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


def parse_py(path):
    """Pull the (key, title, sig, needle_at, needle, replace) tuples."""
    import ast
    tree = ast.parse(open(path, encoding="utf-8").read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "PATCHES":
            out = []
            for elt in node.value.elts:
                key, _title, sig, at, needle, replace = [ast.literal_eval(v) for v in elt.elts]
                out.append(dict(key=key, sig=sig, at=at, needle=needle, replace=replace))
            return out
    raise SystemExit(f"no PATCHES list found in {path}")


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
    ap.add_argument("--py", default=DEF_PY)
    ap.add_argument("--registry", default=DEF_REG)
    ap.add_argument("--orig", default=DEF_ORIG)
    ap.add_argument("--shipped", default=DEF_SHIP)
    a = ap.parse_args()

    ps1 = parse_ps1(a.ps1)
    py = parse_py(a.py)
    pc = load_registry(a.registry)
    # Two shapes in the registry: unique-signature Patch entries (mirrored as
    # table rows in both kit patchers) and AlignIdiomPatch (the many-site
    # dat-align-lfa scan, mirrored as CODE in both kit patchers).
    reg = {p.key: p for p in pc.PATCHES if p.enabled and isinstance(p, pc.Patch)}
    reg_align = [p for p in pc.PATCHES if p.enabled and not isinstance(p, pc.Patch)]
    print(f"ps1 table   : {len(ps1)} patches")
    print(f"py table    : {len(py)} patches")
    print(f"registry    : {len(reg)} enabled table patches + {len(reg_align)} align patches")

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

    # the two shipped patchers must also agree with each other, entry for entry
    if [(e["key"], e["sig"], e["at"], e["needle"], e["replace"]) for e in ps1] != \
       [(e["key"], e["sig"], e["at"], e["needle"], e["replace"]) for e in py]:
        keys_ps1 = {e["key"] for e in ps1}
        keys_py = {e["key"] for e in py}
        for k in sorted(keys_ps1 ^ keys_py):
            print(f"  MISMATCH {k}: present in only one of the two patchers")
        for a_, b_ in zip(ps1, py):
            if a_ != b_:
                print(f"  MISMATCH {a_['key']}: ps1 and py tables differ")
        bad += 1
    # align-patch parity: both kit patchers must carry the scan CODE with the
    # registry's key and site count (the byte truth is gate 2's job).
    kit_spec = importlib.util.spec_from_file_location("kitpy", a.py)
    kitpy = importlib.util.module_from_spec(kit_spec)
    kit_spec.loader.exec_module(kitpy)
    ps1_txt = open(a.ps1, encoding="utf-8").read()
    for p in reg_align:
        if getattr(kitpy, "ALIGN_KEY", None) != p.key or \
           getattr(kitpy, "ALIGN_SITES", None) != p.expect_sites:
            print(f"  MISMATCH {p.key}: kit py ALIGN_KEY/ALIGN_SITES != registry "
                  f"({getattr(kitpy, 'ALIGN_KEY', None)}/{getattr(kitpy, 'ALIGN_SITES', None)} "
                  f"vs {p.key}/{p.expect_sites})")
            bad += 1
        if not re.search(r"\$ALIGN_KEY\s*=\s*'" + re.escape(p.key) + "'", ps1_txt) or \
           not re.search(r"\$ALIGN_SITES\s*=\s*" + str(p.expect_sites) + r"\b", ps1_txt):
            print(f"  MISMATCH {p.key}: ps1 $ALIGN_KEY/$ALIGN_SITES don't match the registry")
            bad += 1
    print("GATE 1 table parity : " + ("PASS" if bad == 0 else f"FAIL ({bad})"))

    pristine = open(a.orig, "rb").read()
    ship = open(a.shipped, "rb").read()
    want = hashlib.sha256(ship).hexdigest()
    print(f"orig        : {len(pristine):,} bytes  sha256 {hashlib.sha256(pristine).hexdigest()[:8]}…")

    # GATE 2 runs for EACH shipped patcher's own table — a table that parses but
    # doesn't rebuild the gated exe must not reach players.
    for label, table in (("ps1", ps1), ("py", py)):
        orig = bytearray(pristine)
        for e in table:
            hits = locate(orig, e)
            if len(hits) != 1:
                print(f"  [{label}] {e['key']}: {len(hits)} matches — REFUSE")
                bad += 1
                continue
            off = hits[0]
            cur = bytes(orig[off:off + len(e["needle"]) // 2])
            state = "orig" if cur == bytes.fromhex(e["needle"]) else "patched"
            if label == "ps1":
                print(f"  [{e['key']:<22}] 0x{off:06X} {state}")
            orig[off:off + len(cur)] = bytes.fromhex(e["replace"])
        # align patches: py arm uses the SHIPPED kit code's own scan; ps1 arm
        # uses the registry implementation (the ps1 port is code, exercised by
        # the on-box Windows run — see the kit gate notes).
        for p in reg_align:
            if label == "py":
                st, sites_ = kitpy.align_state(orig)
                if st != "orig":
                    print(f"  [{label}] {p.key}: unexpected state {st} on pristine — REFUSE")
                    bad += 1
                    continue
                for j in sites_:
                    orig[j + 3] = 0x00
                n = len(sites_)
            else:
                n = p.apply(orig)
            if n != p.expect_sites:
                print(f"  [{label}] {p.key}: applied {n} sites, expected {p.expect_sites} — REFUSE")
                bad += 1
            if label == "ps1":
                print(f"  [{p.key:<22}] {n} idiom sites")
        off = pe_csum_off(orig)
        struct.pack_into("<I", orig, off, 0)
        struct.pack_into("<I", orig, off, pe_checksum(orig, off))
        got = hashlib.sha256(orig).hexdigest()
        same = got == want
        print(f"rebuilt via {label:<3}: sha256 {got}  {'==' if same else '!='} shipping exe")
        if not same:
            diffs = [i for i in range(min(len(orig), len(ship))) if orig[i] != ship[i]]
            print(f"  {len(diffs)} differing bytes, first at 0x{diffs[0]:X}" if diffs else "  length differs")
            bad += 1
    print(f"shipping exe: sha256 {want}")
    print("GATE 2 artifact parity : " + ("PASS (both patchers rebuild the gated exe byte-for-byte)" if bad == 0 else "FAIL"))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
