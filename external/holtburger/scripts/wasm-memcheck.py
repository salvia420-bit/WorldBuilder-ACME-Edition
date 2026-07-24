import sys
f = open(sys.argv[1], 'rb')
data = f.read(4_000_000)          # sections we need are near the front
assert data[:4] == b'\x00asm', "not a wasm module"
p = 8
def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s
        if not x & 0x80: return r, i
        s += 7
def limits(b, i, label):
    flags, i = uleb(b, i)
    mn, i = uleb(b, i)
    mx = None
    if flags & 0x01:
        mx, i = uleb(b, i)
    shared = bool(flags & 0x02)
    print(f"  {label}: flags=0x{flags:02x} shared={shared} "
          f"min={mn} pages ({mn*64//1024} KiB) max={mx if mx is None else str(mx)+' pages ('+str(mx*64//1024)+' KiB)'}")
    return shared, i
found = False
while p < len(data):
    sid, p = uleb(data, p)
    size, p = uleb(data, p)
    end = p + size
    if sid == 5:  # memory section
        n, q = uleb(data, p)
        print(f"MEMORY section: {n} memory/ies (module-defined)")
        for _ in range(n):
            sh, q = limits(data, q, "memory")
            found = found or sh
    elif sid == 2:  # import section — memory may be imported instead
        n, q = uleb(data, p)
        for _ in range(n):
            ml, q = uleb(data, q); mod = data[q:q+ml].decode('utf8','replace'); q += ml
            nl, q = uleb(data, q); nm = data[q:q+nl].decode('utf8','replace'); q += nl
            kind = data[q]; q += 1
            if kind == 0x02:
                print(f"IMPORTED memory {mod}.{nm}:")
                sh, q = limits(data, q, "memory")
                found = found or sh
            elif kind == 0x00: _, q = uleb(data, q)
            elif kind == 0x01:
                q += 1; _, q = limits(data, q, "table")
            elif kind == 0x03: q += 2
    if sid in (5,) and found: break
    p = end
    if p > 3_000_000: break
print("\nRESULT:", "SHARED MEMORY PRESENT — threads-capable module" if found
      else "NOT shared — plain single-threaded memory")
sys.exit(0 if found else 1)
