"""walk_check.py — client-compatible dat integrity tripwire (TASKLIST 2026-08-17 B2).

Validates what the RETAIL CLIENT's reader actually depends on (BTree::Search
uses branch[0]!=0 as the leaf test; DRW's tolerant reader does not and will
happily walk a file the client crashes on — the take-3 trip left exactly such
a file):
  - header FileSize == actual file size; freehead/freetail/btree in bounds
  - full b-tree walk with branch[0] leaf semantics; every branch and chain
    pointer in bounds and block-aligned
  - free chain walk: length == FreeBlockCount, every block in bounds/aligned
  - entry count (== --expect if given)

usage: python3 walk_check.py <dat> [--expect N]     exits nonzero on violation
"""
import os
import struct
import sys


def main():
    path = sys.argv[1]
    expect = None
    if "--expect" in sys.argv:
        expect = int(sys.argv[sys.argv.index("--expect") + 1])

    f = open(path, "rb")
    actual = os.fstat(f.fileno()).st_size
    f.seek(0x140)
    h = struct.unpack("<13I", f.read(52))
    _ftype, bs, fsize, _ds, _ss, freehead, freetail, freecount, btree = h[:9]
    errs = []
    if fsize != actual:
        errs.append(f"header FileSize {fsize} != actual {actual}")

    def aligned_in_bounds(off, what):
        if off % bs != 0:
            errs.append(f"{what} 0x{off:X} not {bs}-aligned")
            return False
        if off + bs > actual:
            errs.append(f"{what} 0x{off:X} beyond EOF {actual}")
            return False
        return True

    def read_raw(off, size, what):
        buf = bytearray()
        if not aligned_in_bounds(off, what + " head"):
            return None
        f.seek(off)
        nxt = struct.unpack("<I", f.read(4))[0]
        remaining = size
        while remaining > 0:
            if (nxt & 0x7FFFFFFF) == 0 or remaining <= bs - 4:
                buf += f.read(remaining)
                remaining = 0
            else:
                buf += f.read(bs - 4)
                nn = nxt & 0x7FFFFFFF
                if not aligned_in_bounds(nn, what + " chain"):
                    return None
                f.seek(nn)
                nxt = struct.unpack("<I", f.read(4))[0]
                remaining -= (bs - 4)
        return bytes(buf[:size])

    objsize = 4 * 0x3E + 4 + 24 * 0x3D
    count = [0]

    def walk(off, depth=0):
        if errs and len(errs) > 20:
            return
        if depth > 12:
            errs.append(f"btree depth >12 at 0x{off:X} (cycle?)")
            return
        b = read_raw(off, objsize, "dir-node")
        if b is None:
            return
        branches = struct.unpack_from("<62I", b, 0)
        cnt = struct.unpack_from("<I", b, 62 * 4)[0]
        if cnt > 61:
            errs.append(f"dir node 0x{off:X} cnt={cnt} > 61")
            return
        base = 62 * 4 + 4
        for i in range(cnt):
            _bf, oid, foff, fs, _date, _itr = struct.unpack_from("<6I", b, base + i * 24)
            count[0] += 1
            if foff % bs != 0 or foff + bs > actual:
                errs.append(f"entry 0x{oid:08X} offset 0x{foff:X} bad")
        if branches[0] != 0:                      # retail leaf test: branch[0]
            for i in range(cnt + 1):
                walk(branches[i], depth + 1)

    walk(btree)

    # free chain
    seen = set()
    cur = freehead
    n = 0
    while freecount and cur and (cur & 0x7FFFFFFF) and n <= freecount + 5:
        cur &= 0x7FFFFFFF
        if cur in seen:
            errs.append(f"free chain CYCLE at 0x{cur:X} after {n}")
            break
        seen.add(cur)
        if not aligned_in_bounds(cur, "free block"):
            break
        f.seek(cur)
        cur = struct.unpack("<I", f.read(4))[0]
        n += 1
    if freecount and n != freecount:
        errs.append(f"free chain length {n} != header FreeBlockCount {freecount}")

    if expect is not None and count[0] != expect:
        errs.append(f"entry count {count[0]} != expected {expect}")

    print(f"{os.path.basename(path)}: entries={count[0]} free={freecount} "
          f"size={actual:,} -> {'FAIL' if errs else 'OK'}")
    for e in errs[:20]:
        print("  " + e)
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
