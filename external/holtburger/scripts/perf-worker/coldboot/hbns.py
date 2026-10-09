# hbns.py <shards.json> <fromMs> [toMs] — decode the dist HBNS namespace catalogs (hash16 -> ns, DAT id, size) and break a
# page shard list ([url, startMs, endMs, bytes] rows from resource timing) down by namespace + DAT type.
import json, sys, struct, os, collections
D = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/dist/manifest"
def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i
def load(path, ns, out):
    b = open(path, "rb").read(); assert b[:4] == b"HBNS", path
    full = b[5] & 1; n = struct.unpack_from("<I", b, 8)[0]; i = 16; fid = 0; hl = 32 if full else 16
    for _ in range(n):
        d, i = uleb(b, i); fid += d; h = b[i:i+hl].hex()[:32]; i += hl; sz, i = uleb(b, i); out[h] = (ns, fid, sz)
idx = {}
for f, ns in [("eor-portal.bin", "eor/portal"), ("eor-local.bin", "eor/local"), ("holtburger-core.bin", "holtburger/core"), ("holtburger-tex-bc7.bin", "tex-bc7"), ("holtburger-tex-bc7-pre.bin", "tex-bc7-pre"), ("holtburger-tex-xu7.bin", "tex-xu7")]:
    load(os.path.join(D, f), ns, idx)
for f in os.listdir(os.path.join(D, "regions", "eor-cell")):
    load(os.path.join(D, "regions", "eor-cell", f), "eor/cell", idx)
rows = json.load(open(sys.argv[1])); t0 = float(sys.argv[2]); t1 = float(sys.argv[3]) if len(sys.argv) > 3 else 1e12
TYPES = {0x01: "GfxObj", 0x02: "Setup", 0x03: "Animation", 0x04: "Palette", 0x05: "SurfaceTexture", 0x06: "RenderSurface", 0x08: "Surface", 0x09: "MotionTable", 0x0D: "Environment", 0x0F: "PaletteSet", 0x10: "ClothingTable", 0x11: "DegradeInfo", 0x12: "Scene", 0x20: "SoundTable", 0x32: "ParticleEmitter", 0x33: "PhysicsScript", 0x34: "PhysicsScriptTable"}
g = collections.defaultdict(lambda: [0, 0]); big = []; miss = 0
for name, s, e, sz in rows:
    if s < t0 or s > t1: continue
    if "/shards/" not in name: continue
    h = name.rsplit("/", 1)[1].split(".")[0][:32]
    v = idx.get(h)
    if not v: miss += 1; k = ("?", "?")
    else:
        ns, fid, _ = v; ty = TYPES.get(fid >> 24, hex(fid >> 24)) if ns in ("eor/portal",) else ("cell" if ns == "eor/cell" else hex(fid >> 24)); k = (ns, ty)
        big.append((sz, ns, hex(fid)))
    g[k][0] += 1; g[k][1] += sz
for k, (n, b) in sorted(g.items(), key=lambda x: -x[1][1]): print(f"{b/1e6:8.1f} MB {n:6d}  {k[0]:14s} {k[1]}")
print("unmapped", miss)
big.sort(reverse=True); print("largest:", [(round(s/1e6, 2), ns, f) for s, ns, f in big[:12]])
