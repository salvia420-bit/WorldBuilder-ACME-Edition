#!/usr/bin/env python3
"""bake_water_flow.py -- per-vertex terrain-water flow + foam for holtburger-web.

Reads the retail base DATs directly (no WorldBuilder.Terminal, no ACE DB, no
network), routes every terrain-water vertex downstream with a water-preferring
priority flood, and writes:

  data/water_flow.bin         per-landblock 9x9 (flowE, flowN, foam) bytes ("HBWF" v1)
  data/water_flow_sites.json  waterfall / drop sites (lip + foot global metres)

Usage (from anywhere):
  python3 tools/water-flow/bake_water_flow.py                 # bake with ~/ac_base_dats
  python3 tools/water-flow/bake_water_flow.py --check         # verify data/water_flow.bin
  python3 tools/water-flow/bake_water_flow.py --cell X --portal Y --allow-nonbase

Grid convention: global vertex (gx, gy) = (lbX*8 + gridX, lbY*8 + gridY); gx grows
EAST, gy grows NORTH; the vertex sits at global metres (24*gx, 24*gy). The DAT
stores each landblock's 81 vertices as index gridX*9 + gridY. See README.md.

Python 3 + numpy only. Deterministic (same bytes every run on the same DATs).
"""
import argparse, hashlib, heapq, json, mmap, os, struct, sys, time
from array import array

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, "..", ".."))
BASE_DATS = os.path.expanduser("~/ac_base_dats")
DEFAULT_CELL = os.path.join(BASE_DATS, "client_cell_1.dat")
DEFAULT_PORTAL = os.path.join(BASE_DATS, "client_portal.dat")
DEFAULT_OUT = os.path.join(APP, "data", "water_flow.bin")
DEFAULT_SITES = os.path.join(APP, "data", "water_flow_sites.json")

TOOL_VERSION = "bake_water_flow.py 1"
FORMAT_VERSION = 1
FULL_SCALE = 4.0                # speed units represented by byte offset +-127
NLB = 255                       # landblock coords 0x00..0xFE
N = NLB * 8 + 1                 # 2041 vertices per axis
CELL_M = 24.0
REGION_ID = 0x13000000

WATERLIKE = (16, 17, 18, 19, 20, 22)    # retail SurfChar water 16..20 + FauxWaterRunning 22 (fall faces)
SEA = (18, 19, 20)
RUN, FAUX = 16, 22
CLS_LAND, CLS_RIVER, CLS_FALL, CLS_LAKE, CLS_STILL = 0, 1, 2, 3, 4

# DAT static waterfall anchors (LandBlockInfo 0xXXYYFFFE objects with these setups)
ANCHOR_SETUPS = (0x020003E4, 0x0200085A, 0x02000859, 0x020003C5, 0x02000B4D, 0x02000B4E)

# landblock rectangles (lbX0, lbX1, lbY0, lbY1) forced still: the SW map corner (the
# "compass wheel" landmass with a free-standing FauxWaterRunning patch at 0x0D07, and the
# 0x1203 test square: a sea-coded 2-50 m plateau / waterfall-anchor test field) and the
# NW-corner sea-coded shelf (0x03F7..0x06FA). Both lie outside the playable continents.
CORNER_ZONES = ((0x00, 0x14, 0x00, 0x13), (0x00, 0x08, 0xF4, 0xFE))

PENALTY = 1000.0                # land elevation penalty (m) for the water-preferring flood
GAP_R = 6                       # max land gap (vertices) for a "land-cliff gap" fall
GAP_DROP = 10.0                 # min drop (m) for a gap fall
DIRECT_DROP = 4.0               # min drop (m) between adjacent water vertices = steep/fall
RIDGE_TOL = 4.0
FACE_DROP = 6.0                 # foam 255 on faces with >= this drop
RAPIDS_DROP = 2.0               # foam ~80 on running water with drops in [2, 6) m
PLUNGE_R = 3.0                  # plunge radius (vertices)

# names for well-known sites (acpedia), keyed by landblock
KNOWN_NAMES = {
    0xB6A3: "Cragstone Falls",
    0x21E6: "Cataracts of Sabella", 0x21E7: "Cataracts of Sabella", 0x21E8: "Cataracts of Sabella",
    0x22E6: "Cataracts of Sabella", 0x22E7: "Cataracts of Sabella",
    0xE43D: "Blue Ghost Falls (Nanto)",
    0xEA74: "Behind the Waterfall",
    0xF418: "Ithaenc Island falls", 0xF419: "Ithaenc Island falls",
    0xF518: "Ithaenc Island falls", 0xF519: "Ithaenc Island falls",
    0x1CB4: "Marae Lassel river fall", 0x1DB4: "Marae Lassel river fall",
    0x1BBC: "Marae Lassel pool cascade (west)", 0x1CBC: "Marae Lassel pool cascade (west)",
    0x1EBC: "Marae Lassel pool cascade (east)", 0x1FBC: "Marae Lassel pool cascade (east)",
    0x20BC: "Marae Lassel pool cascade (east)",
    0x1FBF: "Marae Lassel pool cascade (north)", 0x20BF: "Marae Lassel source pond",
    0x24BC: "Marae Lassel spring", 0x25BC: "Marae Lassel spring",
}

OFF8 = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))


def _rss_mb():
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmHWM"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return -1


def log(*a):
    if os.environ.get("WATER_FLOW_RSS"):
        a = a + (f"[peak {_rss_mb()} MB]",)
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- DAT reader
class Dat:
    """Minimal read-only AC DAT reader (mmap + B-tree), after tools/particle-fx/datcat.py."""

    def __init__(self, path):
        self.path = path
        self.f = open(path, "rb")
        self.m = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
        h = struct.unpack_from("<11I", self.m, 0x140)
        self.bs = h[1]          # block size
        self.root = h[8]        # B-tree root directory offset

    def close(self):
        self.m.close(); self.f.close()

    def read(self, off, size):
        m, bs = self.m, self.bs
        out = bytearray(); pos = off
        while size > 0:
            nxt = struct.unpack_from("<I", m, pos)[0]
            n = min(size, bs - 4)
            out += m[pos + 4: pos + 4 + n]
            size -= n
            if size > 0:
                if nxt == 0:
                    raise ValueError(f"{self.path}: truncated block chain at {off:#x}")
                pos = nxt
        return bytes(out)

    def _node(self, off):
        d = self.read(off, 62 * 4 + 4 + 61 * 24)
        br = struct.unpack_from("<62I", d, 0)
        cnt = struct.unpack_from("<I", d, 248)[0]
        ents = np.frombuffer(d, dtype="<u4", count=cnt * 6, offset=252).reshape(cnt, 6)
        return br, cnt, ents          # entry = (flags, id, offset, size, date, iteration)

    def walk(self, keep):
        """{id: (offset, size)} for every file id with keep(id)."""
        out = {}
        stack = [self.root]
        while stack:
            br, cnt, ents = self._node(stack.pop())
            for _fl, oid, foff, fsz, _dt, _it in ents.tolist():
                if keep(oid):
                    out[oid] = (foff, fsz)
            if br[0] != 0:
                stack.extend(br[i] for i in range(cnt + 1))
        return out

    def find(self, oid):
        off = self.root
        while True:
            br, cnt, ents = self._node(off)
            ids = ents[:, 1]
            i = int(np.searchsorted(ids, oid))
            if i < cnt and int(ids[i]) == oid:
                return int(ents[i, 2]), int(ents[i, 3])
            if br[0] == 0:
                return None
            off = br[i]


def patch_id(oid):
    """bake-base-dats-only guard: 0x__FFxxxx ids are patch content (0xFF______ is DAT bookkeeping)."""
    return ((oid >> 16) & 0xFF) == 0xFF and (oid >> 24) != 0xFF and (oid & 0xFFFF) not in (0xFFFF, 0xFFFE)


def read_region_height_table(portal):
    """RegionDesc 0x13000000 -> LandDefs.LandHeightTable (256 f32), field order per
    ACE.DatLoader FileTypes/RegionDesc.cs + Entity/LandDefs.cs."""
    loc = portal.find(REGION_ID)
    if loc is None:
        raise SystemExit("Region 0x13000000 not found in portal DAT")
    b = portal.read(*loc)
    p = 0
    rid, region_number, version = struct.unpack_from("<3I", b, p); p += 12
    if rid != REGION_ID:
        raise SystemExit(f"bad Region id {rid:#x}")
    slen = struct.unpack_from("<H", b, p)[0]; p += 2          # PString (u16 length)
    name = b[p:p + slen].decode("latin-1"); p += slen
    p = (p + 3) & ~3                                          # AlignBoundary
    (nbl, nbw, square_len, lblock_len, vpc, max_obj_h, sky_h, road_w) = struct.unpack_from("<iifiifff", b, p)
    p += 32
    lht = np.frombuffer(b, dtype="<f4", count=256, offset=p).astype(np.float64)
    info = dict(name=name, region_number=region_number, version=version, num_block_length=nbl,
                num_block_width=nbw, square_length=square_len, lblock_length=lblock_len, vertex_per_cell=vpc)
    if (nbl, nbw, square_len, lblock_len) != (255, 255, 24.0, 8):
        raise SystemExit(f"unexpected LandDefs {info}")
    return lht, info


def read_world(cell_path, portal_path):
    """-> H (float64 metres), T (uint8 terrain code), anchors [(setup, x_m, y_m, z_m)], region info."""
    t0 = time.time()
    portal = Dat(portal_path)
    lht, rinfo = read_region_height_table(portal)
    portal.close()
    cell = Dat(cell_path)
    files = cell.walk(lambda o: (o & 0xFFFF) in (0xFFFF, 0xFFFE))
    for oid in files:
        if patch_id(oid):
            raise SystemExit(f"cell DAT contains patch-pattern id {oid:#010x} (base DATs only)")
    HI = np.zeros((N, N), np.uint8)
    TW = np.zeros((N, N), np.uint16)
    missing = 0
    for lx in range(NLB):
        for ly in range(NLB):
            oid = (lx << 24) | (ly << 16) | 0xFFFF
            e = files.get(oid)
            if e is None:
                missing += 1
                continue
            b = cell.read(*e)
            # CellLandblock: id u32, hasObjects u32, terrain u16[81], height u8[81] (index gridX*9+gridY)
            if struct.unpack_from("<I", b, 0)[0] != oid:
                raise SystemExit(f"landblock id mismatch at {oid:#010x}")
            TW[lx * 8:lx * 8 + 9, ly * 8:ly * 8 + 9] = np.frombuffer(b, "<u2", 81, 8).reshape(9, 9)
            HI[lx * 8:lx * 8 + 9, ly * 8:ly * 8 + 9] = np.frombuffer(b, "u1", 81, 8 + 162).reshape(9, 9)
    anchors = []
    aset = set(ANCHOR_SETUPS)
    for oid in sorted(k for k in files if (k & 0xFFFF) == 0xFFFE):
        b = cell.read(*files[oid])
        # LandblockInfo: id u32, numCells u32, objects: u32 count + count * (id u32, origin 3f, quat 4f)
        nobj = struct.unpack_from("<I", b, 8)[0]
        lx, ly = oid >> 24, (oid >> 16) & 0xFF
        for k in range(nobj):
            sid, ox, oy, oz = struct.unpack_from("<I3f", b, 12 + 32 * k)
            if sid in aset:
                anchors.append((sid, lx * 192.0 + ox, ly * 192.0 + oy, float(oz)))
    cell.close()
    T = ((TW >> 2) & 0x1F).astype(np.uint8)
    H = lht[HI]
    log(f"[dat] {len(files)} landblock records, {missing} missing; {len(anchors)} waterfall anchors; "
        f"region '{rinfo['name']}'; {time.time() - t0:.1f}s")
    return H, T, anchors, rinfo


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 22)
            if not b:
                break
            h.update(b)
    return dict(file=os.path.basename(path), size=os.path.getsize(path), sha256=h.hexdigest())


# --------------------------------------------------------------------------- grid helpers
def nshift(a, dx, dy, fill):
    """out[x, y] = a[x+dx, y+dy] (fill outside)."""
    out = np.full(a.shape, fill, dtype=a.dtype)
    xs = slice(max(0, -dx), N - max(0, dx)); xd = slice(max(0, dx), N - max(0, -dx))
    ys = slice(max(0, -dy), N - max(0, dy)); yd = slice(max(0, dy), N - max(0, -dy))
    out[xs, ys] = a[xd, yd]
    return out


def min_filter_sq(a, r, fill):
    out = a.copy()
    for d in range(1, r + 1):
        out = np.minimum(out, np.minimum(nshift(a, d, 0, fill), nshift(a, -d, 0, fill)))
    tmp = out
    out = tmp.copy()
    for d in range(1, r + 1):
        out = np.minimum(out, np.minimum(nshift(tmp, 0, d, fill), nshift(tmp, 0, -d, fill)))
    return out


def label(mask, conn8=False):
    """Connected components of a 2-D bool mask (run-length union-find).
    Labels 1..n in row-major first-occurrence order (deterministic)."""
    nx, ny = mask.shape
    pad = np.zeros((nx, 1), np.int8)
    d = np.diff(np.concatenate([pad, mask.astype(np.int8), pad], axis=1), axis=1)
    sx, sy = np.nonzero(d == 1)
    _ex, ey = np.nonzero(d == -1)
    n = len(sx)
    out = np.zeros(mask.shape, np.int32)
    if n == 0:
        return out, 0
    par = list(range(n))

    def find(a):
        r = a
        while par[r] != r:
            r = par[r]
        while par[a] != r:
            par[a], a = r, par[a]
        return r

    rowptr = np.searchsorted(sx, np.arange(nx + 1))
    ext = 1 if conn8 else 0
    for x in range(1, nx):
        a0, a1, b1 = int(rowptr[x - 1]), int(rowptr[x]), int(rowptr[x + 1])
        if a0 == a1 or a1 == b1:
            continue
        ps, pe = sy[a0:a1], ey[a0:a1]
        cs, ce = sy[a1:b1], ey[a1:b1]
        lo = np.searchsorted(pe, cs - ext, side="right")
        hi = np.searchsorted(ps, ce + ext, side="left")
        for j in np.flatnonzero(hi > lo).tolist():
            rb = find(a1 + j)
            for i in range(int(lo[j]), int(hi[j])):
                ra = find(a0 + i)
                if ra != rb:
                    if ra < rb:
                        par[rb] = ra; rb = ra
                    else:
                        par[ra] = rb
    labels = np.empty(n, np.int32)
    seen = {}
    for i in range(n):
        r = find(i)
        if r not in seen:
            seen[r] = len(seen) + 1
        labels[i] = seen[r]
    lengths = ey - sy
    starts = sx * ny + sy
    total = int(lengths.sum())
    offs = np.arange(total) - np.repeat(np.cumsum(lengths) - lengths, lengths)
    out.ravel()[np.repeat(starts, lengths) + offs] = np.repeat(labels, lengths)
    return out, len(seen)


def nearest_within(src, r):
    """For every vertex: squared distance (vertices^2, int32; BIG where none) to the nearest
    True cell of src within radius r, and that cell's (gx, gy) as int16 (-1 where none).
    Deterministic tie order (offsets by (d2, dx, dy)); distances are exact integers."""
    big = np.int32(1 << 30)
    best = np.full((N, N), big, np.int32)
    bx = np.full((N, N), -1, np.int16); by = np.full((N, N), -1, np.int16)
    gx = np.arange(N, dtype=np.int16)[:, None]; gy = np.arange(N, dtype=np.int16)[None, :]
    ri = int(np.floor(r))
    offs = sorted(((dx * dx + dy * dy, dx, dy) for dx in range(-ri, ri + 1) for dy in range(-ri, ri + 1)
                   if dx * dx + dy * dy <= r * r))
    for d2, dx, dy in offs:
        upd = nshift(src, dx, dy, False) & (best == big)
        if upd.any():
            best[upd] = d2
            bx[upd] = np.broadcast_to(gx + dx, (N, N))[upd]
            by[upd] = np.broadcast_to(gy + dy, (N, N))[upd]
    return best, bx, by, big


def cluster_xy(pts, radius):
    """Union points (x, y) closer than radius (metres). -> list of root ids (deterministic)."""
    par = list(range(len(pts)))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]; a = par[a]
        return a
    grid = {}
    for n_, (x, y) in enumerate(pts):
        grid.setdefault((int(x // radius), int(y // radius)), []).append(n_)
    for (cx, cy), lst in sorted(grid.items()):
        for ddx in (-1, 0, 1):
            for ddy in (-1, 0, 1):
                for n2 in grid.get((cx + ddx, cy + ddy), []):
                    for n1 in lst:
                        if (pts[n1][0] - pts[n2][0]) ** 2 + (pts[n1][1] - pts[n2][1]) ** 2 <= radius * radius:
                            a, b = find(n1), find(n2)
                            if a != b:
                                par[max(a, b)] = min(a, b)
    return [find(i) for i in range(len(pts))]


def lb_of(gx, gy):
    lx = min(gx // 8, NLB - 1); ly = min(gy // 8, NLB - 1)
    return lx, ly


def lb_key(gx, gy):
    lx, ly = lb_of(gx, gy)
    return (lx << 8) | ly


def line_pts(x0, y0, x1, y1):
    n = max(abs(x1 - x0), abs(y1 - y0))
    ts = np.linspace(0, 1, n + 1)
    return np.rint(x0 + (x1 - x0) * ts).astype(int), np.rint(y0 + (y1 - y0) * ts).astype(int)


# --------------------------------------------------------------------------- drop pairs
def find_pairs(H, T):
    """(ux, uy, lx, ly, kind): 'direct' = 8-neighbour water->water drop >= DIRECT_DROP;
    'gap' = upper water -> lower water of a DIFFERENT 8-connected water body within GAP_R
    vertices, >= GAP_DROP lower, the straight segment crosses land and never rises above
    the upper level + RIDGE_TOL."""
    wl = np.isin(T, WATERLIKE)
    pairs = []
    for dx, dy in OFF8:
        hn = nshift(H, dx, dy, np.nan); wn = nshift(wl, dx, dy, False)
        m = wl & wn & ((H - np.nan_to_num(hn, nan=1e9)) >= DIRECT_DROP)
        for x, y in zip(*np.nonzero(m)):
            pairs.append((int(x), int(y), int(x + dx), int(y + dy), "direct"))
    # gap falls only join DIFFERENT water bodies (a straight line that merely clips the
    # bank between a lip and its own pool below is not a land-cliff gap)
    wlab, _nw = label(wl, conn8=True)
    lowest = min_filter_sq(np.where(wl, H, np.inf), GAP_R, np.inf)
    cand = wl & (H >= GAP_DROP) & ((H - lowest) >= GAP_DROP)
    for x, y in zip(*np.nonzero(cand)):
        x = int(x); y = int(y); hu = H[x, y]
        x0, x1 = max(0, x - GAP_R), min(N - 1, x + GAP_R); y0, y1 = max(0, y - GAP_R), min(N - 1, y + GAP_R)
        sub = wl[x0:x1 + 1, y0:y1 + 1] & ((hu - H[x0:x1 + 1, y0:y1 + 1]) >= GAP_DROP)
        for lx, ly in zip(*np.nonzero(sub)):
            lx = int(lx) + x0; ly = int(ly) + y0
            if wlab[lx, ly] == wlab[x, y]:
                continue
            px, py = line_pts(x, y, lx, ly)
            ix, iy = px[1:-1], py[1:-1]
            if len(ix) == 0 or wl[ix, iy].all():
                continue
            if (H[ix, iy] > hu + RIDGE_TOL).any():
                continue
            pairs.append((x, y, lx, ly, "gap"))
    pairs.sort()
    return pairs


# --------------------------------------------------------------------------- priority flood
def priority_flood(Z, sink):
    """FIFO priority-flood (Barnes et al. 2014) over the full 8-neighbour grid.
    -> rec (flat receiver gx*N+gy; -1 sink, -2 unreached), D (flow distance to sink, m),
       order (processing order, flat indices)."""
    P = N + 2
    Zp = np.full((P, P), np.inf); Zp[1:-1, 1:-1] = Z
    dom = np.zeros((P, P), bool); dom[1:-1, 1:-1] = True
    snk = np.zeros((P, P), bool); snk[1:-1, 1:-1] = sink
    offs = [(1, 24.0), (-1, 24.0), (P, 24.0), (-P, 24.0),
            (P + 1, 33.941125), (P - 1, 33.941125), (-P + 1, 33.941125), (-P - 1, 33.941125)]
    Zl = array("d", Zp.ravel().tobytes())
    open_ = (dom & ~snk)
    openl = bytearray(open_.ravel().astype(np.uint8).tobytes())
    rec = array("i", np.full(P * P, -2, np.int32).tobytes())
    D = array("d", bytes(8 * P * P))
    nb_open = open_.copy()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx or dy:
                nb_open[max(0, -dx):P - max(0, dx), max(0, -dy):P - max(0, dy)] |= \
                    open_[max(0, dx):P - max(0, -dx), max(0, dy):P - max(0, -dy)]
    heap = []; cnt = 0
    for s in np.flatnonzero((snk & nb_open).ravel()).tolist():
        heap.append((Zl[s], cnt, s)); cnt += 1
    for s in np.flatnonzero(snk.ravel()).tolist():
        rec[s] = -1
    heapq.heapify(heap)
    order = array("i")
    pop, push = heapq.heappop, heapq.heappush
    while heap:
        p, _, i = pop(heap)
        di = D[i]
        for o, L in offs:
            j = i + o
            if not openl[j]:
                continue
            openl[j] = 0
            rec[j] = i
            D[j] = di + L
            zj = Zl[j]
            push(heap, (p if p > zj else zj, cnt, j)); cnt += 1
            order.append(j)
    rec = np.frombuffer(rec, dtype=np.int32).astype(np.int64).reshape(P, P)[1:-1, 1:-1].copy()
    D = np.frombuffer(D, dtype=np.float64).reshape(P, P)[1:-1, 1:-1].copy()
    ok = rec >= 0
    rx, ry = np.divmod(rec[ok], P)
    rec[ok] = (rx - 1) * N + (ry - 1)
    o = np.frombuffer(order, dtype=np.int32).astype(np.int64)
    ox, oy = np.divmod(o, P)
    D[rec == -2] = np.nan
    return rec, D, (ox - 1) * N + (oy - 1)


# --------------------------------------------------------------------------- sparse vector ops
def _nb(xs, ys, dx, dy):
    nx, ny = xs + dx, ys + dy
    inb = (nx >= 0) & (nx < N) & (ny >= 0) & (ny < N)
    return np.clip(nx, 0, N - 1), np.clip(ny, 0, N - 1), inb


def grad_dir(D, act, jump=3.0):
    """Downstream unit vectors = -grad D (least squares over 'act' 8-neighbours,
    skipping |dD| > jump*distance = basin divides). Sparse over np.nonzero(act)."""
    xs, ys = np.nonzero(act)
    Dc = D[xs, ys]
    sxx = np.zeros(len(xs)); sxy = np.zeros(len(xs)); syy = np.zeros(len(xs)); bx = np.zeros(len(xs)); by = np.zeros(len(xs))
    for dx, dy in OFF8:
        nx, ny, inb = _nb(xs, ys, dx, dy)
        dD = D[nx, ny] - Dc
        lim = jump * 24.0 * np.hypot(dx, dy)
        use = inb & act[nx, ny] & np.isfinite(dD) & (np.abs(np.nan_to_num(dD, nan=1e9)) <= lim)
        ex, ey = 24.0 * dx, 24.0 * dy; w = use.astype(float); dDz = np.where(use, dD, 0.0)
        sxx += w * ex * ex; sxy += w * ex * ey; syy += w * ey * ey; bx += ex * dDz; by += ey * dDz
    det = sxx * syy - sxy * sxy
    ok = det > 1e-6; sd = np.where(ok, det, 1)
    gx = np.where(ok, (syy * bx - sxy * by) / sd, 0); gy = np.where(ok, (sxx * by - sxy * bx) / sd, 0)
    m = np.hypot(gx, gy); ok &= m > 1e-9; sm = np.where(ok, m, 1)
    return xs, ys, np.where(ok, -gx / sm, 0), np.where(ok, -gy / sm, 0), ok


def smooth_dir(fe, fn, mask, iters=2):
    xs, ys = np.nonzero(mask)
    for _ in range(iters):
        se = np.zeros(len(xs)); sn = np.zeros(len(xs))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                w = (2 - abs(dx)) * (2 - abs(dy))
                nx, ny, inb = _nb(xs, ys, dx, dy)
                use = inb & mask[nx, ny]
                se += np.where(use, w * fe[nx, ny], 0); sn += np.where(use, w * fn[nx, ny], 0)
        mag = np.hypot(se, sn); good = mag > 1e-6; sm = np.where(good, mag, 1)
        fe[xs[good], ys[good]] = (se / sm)[good]; fn[xs[good], ys[good]] = (sn / sm)[good]
    return fe, fn


def steepest_water_descent(H, wl, act):
    """For 'act' vertices: max drop (m) and slope to a lower water 8-neighbour + unit direction."""
    xs, ys = np.nonzero(act)
    best = np.zeros(len(xs)); drop = np.zeros(len(xs)); dvx = np.zeros(len(xs)); dvy = np.zeros(len(xs))
    for dx, dy in OFF8:
        nx, ny, inb = _nb(xs, ys, dx, dy)
        L = np.hypot(dx, dy)
        dh = np.where(inb & wl[nx, ny], H[xs, ys] - H[nx, ny], 0.0)
        slope = dh / (24.0 * L)
        better = slope > best
        best = np.where(better, slope, best); drop = np.where(better, dh, drop)
        dvx = np.where(better, dx / L, dvx); dvy = np.where(better, dy / L, dvy)
    return xs, ys, best, drop, dvx, dvy


# --------------------------------------------------------------------------- the bake
def real_fall(H, T, acc, still, corner, ux, uy, lx, ly):
    """A drop pair that is a waterfall (not a sea-coded slope / spike / test-zone artefact)."""
    dh = H[ux, uy] - H[lx, ly]
    if corner[ux, uy] or corner[lx, ly] or still[ux, uy]:
        return False
    if T[ux, uy] in SEA:
        return dh >= 15.0                              # sea-coded terraces need a real step
    return dh >= 10.0 or (dh >= DIRECT_DROP and (acc[ux, uy] >= 1 or T[ux, uy] in (16, 17, 22)))


def bake(H, T, anchors):
    t0 = time.time()
    wl = np.isin(T, WATERLIKE)
    sea = np.isin(T, SEA)
    run_ = T == RUN
    faux = T == FAUX
    edge = np.zeros((N, N), bool); edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    # ocean = the two big (>=100k) 4-connected sea-coded components at sea level
    slab, ns = label(sea, conn8=False)
    sz = np.bincount(slab.ravel())
    bigl = [i for i in range(1, ns + 1) if sz[i] >= 100000]
    ocean = np.isin(slab, bigl) & (H <= 0.5)
    del slab
    corner = np.zeros((N, N), bool)
    for (x0, x1, y0, y1) in CORNER_ZONES:
        corner[x0 * 8:x1 * 8 + 9, y0 * 8:y1 * 8 + 9] = True
    pairs = find_pairs(H, T)
    log(f"[pairs] {sum(1 for p in pairs if p[4] == 'direct')} direct, {sum(1 for p in pairs if p[4] == 'gap')} gap "
        f"({time.time() - t0:.1f}s)")
    # virtual channels: land cells on gap-fall segments are flooded as water
    vch = np.zeros((N, N), bool)
    for ux, uy, lx, ly, kind in pairs:
        if kind == "gap":
            px, py = line_pts(ux, uy, lx, ly)
            vch[px[1:-1], py[1:-1]] = True
    vch &= ~wl
    sink = ocean | edge
    Z = np.where(wl | vch, H, H + PENALTY)
    rec, D, order = priority_flood(Z, sink)
    del Z
    rec = rec.astype(np.int32)
    log(f"[flood] {len(order)} vertices routed ({time.time() - t0:.1f}s)")
    still_sink = sink & wl
    # sea-coded slivers/spikes (no equal-height 4-connected flat of >= 4 vertices) -> still
    seaN = sea & ~still_sink
    flat4 = np.zeros((N, N), bool)
    for h in np.unique(H[seaN]).tolist():
        lab_h, nh = label(seaN & (H == h))
        if nh:
            s = np.bincount(lab_h.ravel()); big = s >= 4; big[0] = False
            flat4 |= big[lab_h]
    lab_s, ns_ = label(seaN, conn8=True)
    keep = np.zeros(ns_ + 1, bool); keep[np.unique(lab_s[flat4])] = True; keep[0] = False
    still = still_sink | (seaN & ~keep[lab_s]) | (corner & wl)
    del lab_s, flat4
    # running-water accumulation along receivers (through-flow indicator)
    acc = array("d", np.where(run_ | faux, 1.0, 0.0).ravel().tobytes())
    recl = rec.ravel().tolist()
    for j in order[::-1].tolist():
        r = recl[j]
        if r >= 0:
            acc[r] += acc[j]
    del recl, order
    acc = np.frombuffer(acc, dtype=np.float64).astype(np.float32).reshape(N, N)   # integer counts
    act = wl & ~still
    xs, ys, ge, gn, gok = grad_dir(D, act)
    del D
    r = rec[xs, ys]; rok = r >= 0
    rx, ry = np.divmod(np.where(rok, r, 0), N)
    vx = (rx - xs).astype(float); vy = (ry - ys).astype(float); vm = np.hypot(vx, vy); vm[vm == 0] = 1
    fe = np.zeros((N, N)); fn = np.zeros((N, N))
    fe[xs, ys] = np.where(gok, ge, np.where(rok, vx / vm, 0)); fn[xs, ys] = np.where(gok, gn, np.where(rok, vy / vm, 0))
    have = np.zeros((N, N), bool); have[xs, ys] = gok | rok
    fe, fn = smooth_dir(fe, fn, have, 2)
    fe[~have] = 0; fn[~have] = 0
    sx, sy, slope_s, drop_s, dvx_s, dvy_s = steepest_water_descent(H, wl, have)
    st = drop_s >= DIRECT_DROP
    steep = np.zeros((N, N), bool); steep[sx[st], sy[st]] = True
    # drop counted for foam only where it lies downstream (steep override or flow agrees)
    agree = st | ((fe[sx, sy] * dvx_s + fn[sx, sy] * dvy_s) >= 0.3)
    dsp = np.where(agree, drop_s, 0.0)                                  # sparse downstream drop (m)
    fe[sx[st], sy[st]] = dvx_s[st]; fn[sx[st], sy[st]] = dvy_s[st]
    cls = np.zeros((N, N), np.uint8)
    cls[wl & ~run_ & ~faux & ~still & have] = CLS_LAKE
    cls[(run_ | faux) & have] = CLS_RIVER
    cls[steep | (faux & have)] = CLS_FALL
    cls[still] = CLS_STILL
    speed = np.zeros((N, N))
    speed[cls == CLS_RIVER] = 1.0
    fall_s = cls[sx, sy] == CLS_FALL
    fed_s = acc[sx, sy] >= 1
    speed[sx[fall_s & fed_s], sy[fall_s & fed_s]] = np.clip(1.0 + 3.0 * np.minimum(1.0, slope_s[fall_s & fed_s]), 1.0, 4.0)
    speed[sx[fall_s & ~fed_s], sy[fall_s & ~fed_s]] = 0.5
    # sparse source masks for foam (faces: real drops; rapids: 2..6 m on running water)
    face_s = (~still[sx, sy]) & (dsp >= FACE_DROP) & (np.isin(T[sx, sy], (16, 17, 22)) | (dsp >= 15.0))
    rap_s = (run_ | faux)[sx, sy] & (dsp >= RAPIDS_DROP) & (dsp < FACE_DROP)
    faces = np.zeros((N, N), bool); faces[sx[face_s], sy[face_s]] = True
    rapids = np.zeros((N, N), bool); rapids[sx[rap_s], sy[rap_s]] = True
    del slope_s, drop_s, dvx_s, dvy_s, dsp, agree
    # ---- fall feet: real terrain falls + DAT waterfall anchors at water level
    foot = np.zeros((N, N), bool); fdir = {}
    lip = np.zeros((N, N), bool); real_lip = np.zeros((N, N), bool)
    for ux, uy, lx, ly, kind in pairs:
        lip[ux, uy] = True
        if not real_fall(H, T, acc, still, corner, ux, uy, lx, ly):
            continue
        real_lip[ux, uy] = True
        v = np.array([lx - ux, ly - uy], float); v /= np.linalg.norm(v)
        foot[lx, ly] = True
        a0 = fdir.get((lx, ly), (0.0, 0.0)); fdir[(lx, ly)] = (a0[0] + v[0], a0[1] + v[1])
    # lake bodies (8-connected lake-class water) drift toward their outlet at 0.2 when they
    # carry through-flow (>= 3 running-water vertices drain through them) or feed a real
    # fall (contain a real lip); ramping to 0.6 at a real lip. Other pools stay still.
    lake = cls == CLS_LAKE
    blab, nbl = label(lake, conn8=True)
    accmax = np.zeros(nbl + 1); np.maximum.at(accmax, blab.ravel(), acc.ravel())
    has_lip = np.zeros(nbl + 1, bool); has_lip[np.unique(blab[real_lip & lake])] = True
    moving_body = (accmax >= 3) | has_lip; moving_body[0] = False
    feeder = moving_body[blab] & lake
    del blab
    d2lip, _a, _b, big = nearest_within(real_lip, 3.0)
    del _a, _b
    fx_s, fy_s = np.nonzero(feeder)
    d2f = d2lip[fx_s, fy_s]
    ramp = np.where(d2f != big, 0.6 * (1.0 - np.sqrt(d2f.astype(np.float64)) / 3.0), 0.0)
    speed[fx_s, fy_s] = np.maximum(speed[fx_s, fy_s], np.maximum(0.2, ramp))
    del d2lip, fx_s, fy_s, d2f, ramp
    # anchors: a fall's anchor setups run from lip to foot; only the bottom ones (within
    # 6 m of the lowest anchor within 200 m) mark the water they stand in / over as a foot
    afoot = np.zeros((N, N), bool)
    axy = np.array([(x, y, z) for _s, x, y, z in anchors], float).reshape(-1, 3)
    for k, (_sid, x, y, z) in enumerate(anchors):
        near_a = np.hypot(axy[:, 0] - x, axy[:, 1] - y) <= 200.0
        if z > axy[near_a, 2].min() + 6.0:
            continue
        cx, cy = x / CELL_M, y / CELL_M
        for gx in range(int(np.floor(cx - 1.5)), int(np.ceil(cx + 1.5)) + 1):
            for gy in range(int(np.floor(cy - 1.5)), int(np.ceil(cy + 1.5)) + 1):
                if 0 <= gx < N and 0 <= gy < N and wl[gx, gy] and not corner[gx, gy] \
                        and (gx - cx) ** 2 + (gy - cy) ** 2 <= 2.25 and H[gx, gy] <= z + 4.0:
                    afoot[gx, gy] = True
    foot |= afoot
    # ---- plunge: radial outflow from fall feet (skip approaches to another lip at the same level)
    d2, ix, iy, big = nearest_within(foot, PLUNGE_R)
    cx_, cy_ = np.nonzero((d2 != big) & wl & ~steep & ~corner)
    del d2
    l2, lxx, lyy, bigl2 = nearest_within(lip, 2.0)
    lx_c, ly_c = lxx[cx_, cy_].astype(np.int64), lyy[cx_, cy_].astype(np.int64)
    approach = (l2[cx_, cy_] != bigl2) & (np.abs(H[cx_, cy_] - H[np.maximum(lx_c, 0), np.maximum(ly_c, 0)]) <= 1.0)
    del l2, lxx, lyy
    fx_all, fy_all = ix[cx_, cy_].astype(np.int64), iy[cx_, cy_].astype(np.int64)
    del ix, iy
    keep_c = ~approach & (H[cx_, cy_] <= H[fx_all, fy_all] + 1.0)
    gxv, gyv, fx_, fy_ = cx_[keep_c], cy_[keep_c], fx_all[keep_c], fy_all[keep_c]
    rv = np.stack([gxv - fx_, gyv - fy_], 1).astype(float)
    rn = np.linalg.norm(rv, axis=1)
    dd = rn.copy()                                       # distance to the foot (vertices)
    for k in np.flatnonzero(rn < 1e-9).tolist():         # at the foot: summed fall direction
        a0 = fdir.get((int(fx_[k]), int(fy_[k])), (0.0, 0.0))
        m0 = float(np.hypot(a0[0], a0[1]))
        rv[k] = (a0[0] / m0, a0[1] / m0) if m0 > 0 else (0.0, 0.0)
    rn = np.linalg.norm(rv, axis=1)
    okr = rn > 1e-9
    gxv, gyv, rv, rn, dd = gxv[okr], gyv[okr], rv[okr], rn[okr], dd[okr]
    rv /= rn[:, None]
    in_still = still[gxv, gyv] | ~have[gxv, gyv]
    # moving water: blend toward radial (0.7 -> 0 over PLUNGE_R), speed up to 1.5
    w = 0.7 * (1.0 - dd / PLUNGE_R)
    be = np.where(in_still, rv[:, 0], (1 - w) * fe[gxv, gyv] + w * rv[:, 0])
    bn = np.where(in_still, rv[:, 1], (1 - w) * fn[gxv, gyv] + w * rv[:, 1])
    bm = np.hypot(be, bn); bm[bm == 0] = 1
    fe[gxv, gyv] = be / bm; fn[gxv, gyv] = bn / bm
    sp_moving = np.maximum(speed[gxv, gyv], 1.5 * (1.0 - dd / PLUNGE_R))
    # still water (ocean / sea-coded / unrouted pool) at a fall foot: modest radial 0.5
    sp_still = 0.5 * np.minimum(1.0, 1.5 * (1.0 - dd / PLUNGE_R))
    speed[gxv, gyv] = np.where(in_still, sp_still, sp_moving)
    plunge = np.zeros((N, N), bool); plunge[gxv, gyv] = True
    log(f"[flow] classes river {int((cls == CLS_RIVER).sum())} fall {int((cls == CLS_FALL).sum())} "
        f"lake {int((cls == CLS_LAKE).sum())} still {int((cls == CLS_STILL).sum())}; feet {int(foot.sum())} "
        f"(anchor {int(afoot.sum())}); plunge {int(plunge.sum())} ({time.time() - t0:.1f}s)")
    # ---- foam
    foam = foam_field(H, wl, fe, fn, speed, foot, faces, rapids, corner)
    log(f"[foam] {int((foam > 0).sum())} vertices > 0, {int((foam >= 200).sum())} >= 200 ({time.time() - t0:.1f}s)")
    return dict(fe=fe, fn=fn, speed=speed, foam=foam, cls=cls, pairs=pairs, rec=rec, wl=wl, still=still,
                ocean=ocean, acc=acc, foot=foot, afoot=afoot, plunge=plunge)


def foam_field(H, wl, fe, fn, speed, foot, faces, rapids, corner):
    """Foam 0..255: 255 on fall faces (real drops >= FACE_DROP to a lower water neighbour)
    and at fall feet, decaying linearly to 0 over 4 vertices (96 m) of downstream water
    travel; ~80 on rapids (2..6 m drops on running water), decaying over 2 vertices.
    Travel = Dijkstra over water 8-neighbours that never goes uphill (> 0.5 m) and never
    against the local flow (cos < -0.25 with the source vertex's flow, when it moves)."""
    out = np.zeros((N, N))
    faces = faces & ~corner
    rapids = rapids & ~corner
    for src, value, L in ((faces | (foot & ~corner), 255.0, 96.0), (rapids, 80.0, 48.0)):
        dist = {}
        heap = []
        for x, y in zip(*np.nonzero(src)):
            k = (int(x), int(y)); dist[k] = 0.0; heap.append((0.0, k))
        heapq.heapify(heap)
        while heap:
            dcur, (x, y) = heapq.heappop(heap)
            if dcur > dist.get((x, y), np.inf) or dcur >= L:
                continue
            ue, un, us = fe[x, y], fn[x, y], speed[x, y]
            for dx, dy in OFF8:
                nx, ny = x + dx, y + dy
                if not (0 <= nx < N and 0 <= ny < N) or not wl[nx, ny] or corner[nx, ny]:
                    continue
                if H[nx, ny] > H[x, y] + 0.5:
                    continue
                step = 24.0 * (1.4142135623730951 if dx and dy else 1.0)
                if us > 0 and (ue * dx + un * dy) / (1.4142135623730951 if dx and dy else 1.0) < -0.25:
                    continue
                nd = dcur + step
                if nd < L and nd < dist.get((nx, ny), np.inf):
                    dist[(nx, ny)] = nd
                    heapq.heappush(heap, (nd, (nx, ny)))
        for (x, y), dv in dist.items():
            v = value * (1.0 - dv / L)
            if v > out[x, y]:
                out[x, y] = v
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- encode / sites
def encode(fe, fn, speed, foam):
    """-> (keys uint16 sorted, blocks uint8 [n, 81, 3]) and the global byte grids."""
    ce = np.clip(np.rint(128.0 + 127.0 * fe * speed / FULL_SCALE), 1, 255).astype(np.uint8)
    cn = np.clip(np.rint(128.0 + 127.0 * fn * speed / FULL_SCALE), 1, 255).astype(np.uint8)
    nz = (ce != 128) | (cn != 128) | (foam != 0)
    keys = []; blocks = []
    for lx in range(NLB):
        for ly in range(NLB):
            sl = (slice(lx * 8, lx * 8 + 9), slice(ly * 8, ly * 8 + 9))
            if nz[sl].any():
                keys.append((lx << 8) | ly)
                blocks.append(np.stack([ce[sl], cn[sl], foam[sl]], -1).reshape(81, 3))
    return np.array(keys, np.uint16), (np.array(blocks, np.uint8) if blocks else np.zeros((0, 81, 3), np.uint8)), ce, cn


def write_bin(path, keys, blocks):
    head = b"HBWF" + struct.pack("<HHfI", FORMAT_VERSION, len(keys), FULL_SCALE, 0)
    body = keys.astype("<u2").tobytes()
    pad = (-(len(head) + len(body))) % 4
    data = head + body + b"\0" * pad + blocks.tobytes()
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return len(data)


def read_bin(path):
    b = open(path, "rb").read()
    if b[:4] != b"HBWF":
        raise ValueError("bad magic")
    ver, count, full, reserved = struct.unpack_from("<HHfI", b, 4)
    keys = np.frombuffer(b, "<u2", count, 16)
    off = 16 + 2 * count
    pad = (-off) % 4
    blocks_off = off + pad
    blocks = np.frombuffer(b, np.uint8, count * 243, blocks_off).reshape(count, 81, 3)
    return dict(version=ver, count=count, full_scale=full, reserved=reserved, keys=keys, blocks=blocks,
                pad_bytes=b[off:blocks_off], size=len(b), expected_size=blocks_off + count * 243)


def site_catalogue(H, T, res, anchors):
    """Merge terrain drops, code-22 faces, land-cliff gaps, spills over land and DAT anchors
    into sites. Global metres: x = 24*gx, y = 24*gy, z = terrain height."""
    pairs = res["pairs"]; rec = res["rec"].ravel(); wl = res["wl"]; still = res["still"]
    items = []          # (kind, (ux,uy,uz), (lx,ly,lz), drop)
    corner = np.zeros((N, N), bool)
    for (x0, x1, y0, y1) in CORNER_ZONES:
        corner[x0 * 8:x1 * 8 + 9, y0 * 8:y1 * 8 + 9] = True
    acc = res["acc"]
    edge = lambda x, y: x in (0, N - 1) or y in (0, N - 1)
    for ux, uy, lx, ly, kind in pairs:
        if edge(ux, uy) or edge(lx, ly) or not real_fall(H, T, acc, still, corner, ux, uy, lx, ly):
            continue
        dh = float(H[ux, uy] - H[lx, ly])
        k = "code-22 face" if (T[ux, uy] == FAUX or T[lx, ly] == FAUX) else (
            "terrain-water drop" if kind == "direct" else "land-cliff gap")
        items.append((k, (ux * 24.0, uy * 24.0, float(H[ux, uy])), (lx * 24.0, ly * 24.0, float(H[lx, ly])), dh))
    # spills: water bodies whose flood outlet crosses land with a cliff (>= 8 m step) and >= 10 m total
    blab, _ = label(wl & ~still, conn8=True)
    bl = blab.ravel(); Hf = H.ravel(); wlf = wl.ravel()
    seen = set()
    for i in np.flatnonzero(wlf & (bl > 0)).tolist():
        c = bl[i]; r = rec[i]
        if r < 0 or bl[r] == c:
            continue
        j = i; steps = 0; cliff = 0.0
        while True:
            r = rec[j]
            if r < 0:
                break
            cliff = max(cliff, Hf[j] - Hf[r]); steps += 1; j = r
            if wlf[j] or steps > 40:
                break
        if not wlf[j] or bl[j] == c:
            continue
        land_v = steps - 1
        dh = Hf[i] - Hf[j]
        ux, uy = divmod(i, N); lx, ly = divmod(j, N)
        if T[ux, uy] in SEA and dh < 15.0:
            continue                                   # sea-coded shelf spilling to the sea
        if 1 <= land_v <= 16 and dh >= 10.0 and cliff >= 8.0 and (c, int(bl[j])) not in seen:
            seen.add((c, int(bl[j])))
            if corner[ux, uy] or edge(ux, uy) or still[ux, uy]:
                continue
            items.append(("spill", (ux * 24.0, uy * 24.0, float(Hf[i])), (lx * 24.0, ly * 24.0, float(Hf[j])), float(dh)))
    for _sid, x, y, z in anchors:
        gx, gy = int(round(x / CELL_M)), int(round(y / CELL_M))
        if 0 <= gx < N and 0 <= gy < N and corner[gx, gy]:
            continue
        items.append(("anchor", (x, y, z), (x, y, z), 0.0))
    # cluster: items whose lip or foot lie within 4 vertices (96 m) of each other
    pts = []; owner = []
    for n_, (k, a, b, dh) in enumerate(items):
        pts.append((a[0], a[1])); owner.append(n_)
        pts.append((b[0], b[1])); owner.append(n_)
    roots = cluster_xy(pts, 96.0)
    # an item's lip and foot may fall in different point-clusters: join them
    par = {}

    def find(a):
        while par.get(a, a) != a:
            a = par[a]
        return a
    for n_ in range(len(items)):
        a, b = find(roots[2 * n_]), find(roots[2 * n_ + 1])
        if a != b:
            par[max(a, b)] = min(a, b)
    groups = {}
    for n_ in range(len(items)):
        groups.setdefault(find(roots[2 * n_]), []).append(items[n_])
    sites = []
    for g in groups.values():
        terr = [it for it in g if it[0] != "anchor"]
        anc = [it for it in g if it[0] == "anchor"]
        if terr:
            # headline: the strongest terrain evidence; spills only when nothing else
            prim = [it for it in terr if it[0] != "spill"] or terr
            best = max(prim, key=lambda it: (it[3], it[1], it[2]))
            lipp, footp, drop = best[1], best[2], best[3]
        else:
            hi = max(anc, key=lambda it: (it[1][2], it[1])); lo = min(anc, key=lambda it: (it[1][2], it[1]))
            lipp, footp, drop = hi[1], lo[1], hi[1][2] - lo[1][2]
        kinds = sorted({it[0] for it in g})
        cx = (lipp[0] + footp[0]) / 2.0; cy = (lipp[1] + footp[1]) / 2.0
        key = lb_key(int(cx // CELL_M), int(cy // CELL_M))
        v = np.array([footp[0] - lipp[0], footp[1] - lipp[1]]); nv = float(np.hypot(*v))
        name = KNOWN_NAMES.get(key)
        if name is None:
            for it in g:
                for p in (it[1], it[2]):
                    nm = KNOWN_NAMES.get(lb_key(int(p[0] // CELL_M), int(p[1] // CELL_M)))
                    if nm:
                        name = nm; break
                if name:
                    break
        ns_ = (cy / 240.0) - 101.95; ew = (cx / 240.0) - 101.95
        sites.append(dict(
            lb=f"0x{key:04X}", kind=kinds, drop=round(float(drop), 1),
            lip=[round(lipp[0], 1), round(lipp[1], 1), round(lipp[2], 1)],
            foot=[round(footp[0], 1), round(footp[1], 1), round(footp[2], 1)],
            dir=[round(float(v[0] / nv), 3), round(float(v[1] / nv), 3)] if nv > 1e-6 else [0.0, 0.0],
            anchors=len(anc), steps=len(terr),
            map=f"{abs(ns_):.1f}{'N' if ns_ >= 0 else 'S'} {abs(ew):.1f}{'E' if ew >= 0 else 'W'}",
            name=name))
    sites.sort(key=lambda s: (s["lb"], s["lip"], s["foot"]))
    for i, s in enumerate(sites):
        s["id"] = i
    return sites


def write_sites(path, sites, source):
    head = {"format": "holtburger water_flow_sites", "version": 1, "tool": TOOL_VERSION,
            "coords": "global metres x=east, y=north (x = lbX*192 + local), z = terrain/anchor height",
            "kinds": {"terrain-water drop": "adjacent water vertices >= 4 m apart",
                      "code-22 face": "drop involving FauxWaterRunning (retail fall-face paint)",
                      "land-cliff gap": "upper water -> lower water across <= 6 land vertices, >= 10 m",
                      "spill": "a water body's outlet crosses land with a >= 8 m cliff, >= 10 m total",
                      "anchor": "DAT static waterfall anchor setup(s) in the cluster"},
            "source": source, "count": len(sites)}
    lines = ["{"]
    for k, v in head.items():
        lines.append(f"  {json.dumps(k)}: {json.dumps(v, sort_keys=True)},")
    lines.append('  "sites": [')
    lines.append(",\n".join("    " + json.dumps(s, sort_keys=True) for s in sites))
    lines.append("  ]")
    lines.append("}")
    with open(path + ".tmp", "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(path + ".tmp", path)


# --------------------------------------------------------------------------- check mode
# Hand-labelled checkpoints (geography, not derived from the output):
#   (label, lbKey, gridX, gridY, expect)  expect: {"sector": (...)} | {"away_from": (gx, gy)} |
#   {"toward": (gx, gy)} | {"still": True} | {"absent": True}; optional "min_foam", "max_speed".
#   (gx, gy) are GLOBAL vertex coords; "sector" = 8-way compass of the decoded (east, north) vector.
CHECKPOINTS = [
    ("north river mid-stretch (downstream = ESE toward Cragstone Falls)", 0xA9B6, 4, 4, {"sector": ("E", "SE")}),
    ("north river 100 m above Cragstone Falls", 0xB5A4, 3, 2, {"sector": ("E", "SE")}),
    ("Cragstone Falls west face lip (28 m river -> 2 m lake)", 0xB6A3, 0, 3, {"sector": ("E",), "min_foam": 200}),
    ("Cragstone Falls north face lip", 0xB6A3, 4, 8, {"sector": ("S",), "min_foam": 200}),
    ("Cragstone plunge pool below the west face", 0xB6A3, 3, 2, {"away_from": (1457, 1307), "min_foam": 100}),
    ("Cragstone lake mid (slow drift to its south outlet)", 0xBF9C, 2, 2, {"toward": (1609, 1131), "max_speed": 0.5}),
    ("south river below Cragstone lake (lake drains south)", 0xCA89, 4, 4, {"sector": ("S", "SE")}),
    ("south river lower reach, turning WSW to the braids", 0xCE7A, 1, 4, {"sector": ("W", "SW")}),
    ("Marae Lassel main fall lip 0x1DB4 (28 m -> 0 m)", 0x1DB4, 1, 2, {"sector": ("S",), "min_foam": 200}),
    ("Marae Lassel plunge pool below the fall", 0x1DB4, 1, 0, {"away_from": (233, 1441), "min_foam": 100}),
    ("Blue Ghost upper pool (120 m) drains over the fall", 0xE43D, 1, 6, {"toward": (1827, 489)}),
    ("Blue Ghost lower pool (70 m) flows away from the fall", 0xE43D, 5, 0, {"away_from": (1827, 490), "min_foam": 60}),
    ("still side pond (no inflow) at the north river's upper reach", 0x9CC2, 1, 5, {"still": True}),
    ("SE river mouth runs out to sea", 0xE650, 5, 2, {"sector": ("E", "NE", "SE")}),
    ("open ocean east of Dereth", 0xFA40, 4, 4, {"absent": True}),
]
SECTORS = ("E", "NE", "N", "NW", "W", "SW", "S", "SE")


def sector(e, n):
    a = np.degrees(np.arctan2(n, e)) % 360.0
    return SECTORS[int(((a + 22.5) % 360.0) // 45.0)]


def check(path, verbose=True):
    t0 = time.time()
    r = read_bin(path)
    errors = []
    if r["version"] != FORMAT_VERSION: errors.append(f"version {r['version']}")
    if r["reserved"] != 0: errors.append("reserved != 0")
    if abs(r["full_scale"] - FULL_SCALE) > 1e-6: errors.append(f"fullScale {r['full_scale']}")
    if r["size"] != r["expected_size"]: errors.append(f"size {r['size']} != {r['expected_size']}")
    if any(r["pad_bytes"]): errors.append("non-zero pad")
    keys = r["keys"].astype(np.int64)
    if len(keys) and not (np.diff(keys) > 0).all(): errors.append("keys not strictly ascending")
    if len(keys) and (((keys >> 8) > 0xFE).any() or ((keys & 0xFF) > 0xFE).any()): errors.append("key out of range")
    blocks = r["blocks"].reshape(-1, 9, 9, 3)
    idx = {int(k): i for i, k in enumerate(keys.tolist())}
    seam_pairs = seam_bad = absent_edge_bad = 0
    still = np.array([128, 128, 0], np.uint8)
    for k, i in idx.items():
        lx, ly = k >> 8, k & 0xFF
        for (dx, dy) in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            nx_, ny_ = lx + dx, ly + dy
            if not (0 <= nx_ < NLB and 0 <= ny_ < NLB):
                continue
            mine = blocks[i][8, :] if dx == 1 else blocks[i][0, :] if dx == -1 else blocks[i][:, 8] if dy == 1 else blocks[i][:, 0]
            j = idx.get((nx_ << 8) | ny_)
            if j is None:
                if not (mine == still).all():
                    absent_edge_bad += 1
                continue
            theirs = blocks[j][0, :] if dx == 1 else blocks[j][8, :] if dx == -1 else blocks[j][:, 0] if dy == 1 else blocks[j][:, 8]
            seam_pairs += 1
            if not (mine == theirs).all():
                seam_bad += 1
    if seam_bad: errors.append(f"{seam_bad} seam mismatches")
    if absent_edge_bad: errors.append(f"{absent_edge_bad} non-still edges next to absent landblocks")
    e = blocks[..., 0].astype(int) - 128; n = blocks[..., 1].astype(int) - 128; f = blocks[..., 2]
    moving = (e != 0) | (n != 0)
    print(f"{path}: {r['size']} bytes, v{r['version']}, {r['count']} landblocks, fullScale {r['full_scale']}")
    print(f"  seams checked {seam_pairs} (bad {seam_bad}); edges next to absent LBs non-still: {absent_edge_bad}")
    print(f"  vertex slots {blocks.shape[0] * 81}: moving {int(moving.sum())}, foam>0 {int((f > 0).sum())}, "
          f"foam>=200 {int((f >= 200).sum())}; |flow| counts p50 {int(np.median(np.hypot(e, n)[moving])) if moving.any() else 0} "
          f"max {int(np.hypot(e, n).max()) if blocks.size else 0}")
    passed = 0
    for lab_, key, gxl, gyl, exp in CHECKPOINTS:
        gx, gy = (key >> 8) * 8 + gxl, (key & 0xFF) * 8 + gyl
        j = idx.get(key)
        if j is None:
            ok = bool(exp.get("absent") or exp.get("still"))
            print(f"  [{'PASS' if ok else 'FAIL'}] {lab_}: 0x{key:04X} ({gxl},{gyl}) absent")
            passed += ok
            if not ok: errors.append(f"checkpoint '{lab_}' absent")
            continue
        be, bn, bf = (int(v) for v in blocks[j][gxl, gyl])
        ve, vn = (be - 128) * FULL_SCALE / 127.0, (bn - 128) * FULL_SCALE / 127.0
        sp = float(np.hypot(ve, vn))
        sec = sector(ve, vn) if sp > 0 else "-"
        ok = True; why = []
        if exp.get("absent"):
            ok = False; why.append("expected absent")
        if exp.get("still"):
            ok &= (be, bn) == (128, 128); why.append("expect 128/128")
        if "sector" in exp:
            ok &= sp > 0 and sec in exp["sector"]; why.append(f"expect {'/'.join(exp['sector'])}")
        if "away_from" in exp:
            fx, fy = exp["away_from"]
            rx, ry = gx - fx, gy - fy
            ok &= sp > 0 and (ve * rx + vn * ry) > 0; why.append(f"expect away from ({fx},{fy})")
        if "toward" in exp:
            tx, ty = exp["toward"]
            ok &= sp > 0 and (ve * (tx - gx) + vn * (ty - gy)) > 0; why.append(f"expect toward ({tx},{ty})")
        if "max_speed" in exp:
            ok &= sp <= exp["max_speed"]; why.append(f"speed<={exp['max_speed']}")
        if "min_foam" in exp:
            ok &= bf >= exp["min_foam"]; why.append(f"foam>={exp['min_foam']}")
        passed += ok
        if not ok: errors.append(f"checkpoint '{lab_}'")
        if verbose:
            print(f"  [{'PASS' if ok else 'FAIL'}] {lab_}: 0x{key:04X} ({gxl},{gyl}) = global ({gx},{gy}) "
                  f"bytes E{be} N{bn} foam{bf} -> {sec} speed {sp:.2f}  ({'; '.join(why)})")
    print(f"  checkpoints {passed}/{len(CHECKPOINTS)} passed; {'OK' if not errors else 'ERRORS: ' + '; '.join(errors)} "
          f"({time.time() - t0:.2f}s)")
    return not errors


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cell", default=DEFAULT_CELL, help="client_cell_1.dat (default ~/ac_base_dats/)")
    ap.add_argument("--portal", default=DEFAULT_PORTAL, help="client_portal.dat (default ~/ac_base_dats/)")
    ap.add_argument("--allow-nonbase", action="store_true", help="accept DATs outside ~/ac_base_dats")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output .bin (default data/water_flow.bin)")
    ap.add_argument("--sites", default=DEFAULT_SITES, help="output sites JSON (default data/water_flow_sites.json)")
    ap.add_argument("--check", action="store_true", help="verify --out instead of baking")
    ap.add_argument("--debug-npz", default=None, help="also dump the full grids (FE, FN, SPEED, FOAM, CLASS) here")
    a = ap.parse_args()
    if a.check:
        sys.exit(0 if check(a.out) else 1)
    t0 = time.time()
    for p in (a.cell, a.portal):
        rp = os.path.realpath(p)
        if not os.path.isfile(rp):
            raise SystemExit(f"missing DAT {p}")
        if os.path.dirname(rp) != os.path.realpath(BASE_DATS) and not a.allow_nonbase:
            raise SystemExit(f"{p}: not in {BASE_DATS} (bake-base-dats-only); pass --allow-nonbase to override")
    H, T, anchors, rinfo = read_world(a.cell, a.portal)
    res = bake(H, T, anchors)
    keys, blocks, ce, cn = encode(res["fe"], res["fn"], res["speed"], res["foam"])
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    nbytes = write_bin(a.out, keys, blocks)
    log(f"[bin] {a.out}: {len(keys)} landblocks, {nbytes} bytes")
    sites = site_catalogue(H, T, res, anchors)
    source = {"cell": file_digest(a.cell), "portal": file_digest(a.portal),
              "region": {"name": rinfo["name"], "version": rinfo["version"]}}
    write_sites(a.sites, sites, source)
    log(f"[sites] {a.sites}: {len(sites)} sites")
    if a.debug_npz:
        np.savez_compressed(a.debug_npz, FE=res["fe"].astype(np.float32), FN=res["fn"].astype(np.float32),
                            SPEED=res["speed"].astype(np.float32), FOAM=res["foam"], CLASS=res["cls"],
                            CE=ce, CN=cn, H=H.astype(np.float32), T=T)
    log(f"[done] {time.time() - t0:.1f}s")
    ok = check(a.out)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
