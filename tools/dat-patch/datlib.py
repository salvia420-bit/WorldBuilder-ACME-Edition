"""Minimal read-only AC .dat reader (port of ACE.DatLoader's DatReader/DatDirectory)
plus a Setup (0x02) parser sufficient to recover PlacementFrames."""
import struct


class Dat:
    def __init__(self, path):
        self.f = open(path, "rb")
        self.f.seek(0x140)
        h = struct.unpack("<13I", self.f.read(52))
        self.filetype, self.blocksize, self.filesize, self.dataset, self.subset = h[:5]
        self.freehead, self.freetail, self.freecount, self.btree = h[5:9]
        self.files = {}
        self._read_dir(self.btree)

    def read_raw(self, offset, size):
        buf = bytearray()
        bs = self.blocksize
        self.f.seek(offset)
        nxt = struct.unpack("<I", self.f.read(4))[0]
        remaining = size
        while remaining > 0:
            if nxt == 0:
                buf += self.f.read(remaining)
                remaining = 0
            else:
                buf += self.f.read(bs - 4)
                self.f.seek(nxt)
                nxt = struct.unpack("<I", self.f.read(4))[0]
                remaining -= (bs - 4)
        return bytes(buf[:size])

    def _read_dir(self, off):
        objsize = 4 * 0x3E + 4 + 24 * 0x3D
        b = self.read_raw(off, objsize)
        branches = struct.unpack_from("<62I", b, 0)
        cnt = struct.unpack_from("<I", b, 62 * 4)[0]
        base = 62 * 4 + 4
        entries = []
        for i in range(cnt):
            _bf, oid, foff, fsize, date, itr = struct.unpack_from("<6I", b, base + i * 24)
            entries.append((oid, foff, fsize, itr))
            self.files[oid] = (foff, fsize, itr)
        if branches[0] != 0:
            for i in range(cnt + 1):
                self._read_dir(branches[i])

    def get(self, oid):
        if oid not in self.files:
            return None
        off, size, _ = self.files[oid]
        return self.read_raw(off, size)


class R:
    def __init__(self, b):
        self.b = b
        self.o = 0

    def u32(self):
        v = struct.unpack_from("<I", self.b, self.o)[0]
        self.o += 4
        return v

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]
        self.o += 4
        return v

    def vec3(self):
        return (self.f32(), self.f32(), self.f32())

    def quat(self):
        return (self.f32(), self.f32(), self.f32(), self.f32())

    def align(self):
        self.o = (self.o + 3) & ~3


def _int_dict(r, valread):
    """ACE Dictionary<int,T>.Unpack: int32 count, then (int32 key, T value)*."""
    n = r.i32()
    out = {}
    for _ in range(n):
        k = r.i32()
        out[k] = valread(r)
    return out


def parse_setup(data):
    r = R(data)
    s = {}
    s["id"] = r.u32()
    flags = r.u32()
    s["flags"] = flags
    n = r.u32()
    s["parts"] = [r.u32() for _ in range(n)]
    if flags & 0x1:      # HasParent
        s["parent"] = [r.u32() for _ in range(n)]
    if flags & 0x2:      # HasDefaultScale
        s["scale"] = [r.vec3() for _ in range(n)]
    # HoldingLocations : Dictionary<int, LocationType{partId:u32, frame:Frame}>
    def loc(rr):
        return (rr.i32(), rr.vec3(), rr.quat())
    s["holding"] = _int_dict(r, loc)
    s["connections"] = _int_dict(r, loc)
    pc = r.i32()
    frames = {}
    for _ in range(pc):
        key = r.i32()
        fr = [(r.vec3(), r.quat()) for _ in range(n)]
        nh = r.u32()
        for _ in range(nh):
            # AnimationHook: read type then skip — we only need placement 0/0x65
            raise_if = None
            htype = r.u32()
            _ = htype
            # hooks in placement frames are effectively absent for statics/creatures
            raise RuntimeError("unexpected hook in placement frame")
        frames[key] = fr
    s["frames"] = frames
    return s


# ---------------------------------------------------------------- Environment
def _bsp(r, ttype):
    """ttype: 'cell' | 'physics' | 'drawing'. Advances r past the tree."""
    t = r.b[r.o:r.o + 4][::-1].decode('ascii', 'replace')
    r.o += 4
    if t == 'LEAF':
        r.i32()                      # leaf index
        if ttype == 'physics':
            r.i32()                  # solid
            r.o += 16                # sphere
            n = r.u32()
            r.o += 2 * n
        return
    if t == 'PORT':
        r.o += 16                    # plane
        _bsp(r, ttype); _bsp(r, ttype)
        if ttype == 'drawing':
            r.o += 16
            npoly = r.u32(); nport = r.u32()
            r.o += 2 * npoly
            for _ in range(nport):   # PortalPoly = 2 x ushort
                r.o += 4
        return
    r.o += 16                        # splitting plane
    if t in ('BPnn', 'BPIn'):
        _bsp(r, ttype)
    elif t in ('BpIN', 'BpnN'):
        _bsp(r, ttype)
    elif t in ('BPIN', 'BPnN'):
        _bsp(r, ttype); _bsp(r, ttype)
    if ttype == 'cell':
        return
    r.o += 16                        # sphere
    if ttype == 'physics':
        return
    n = r.u32()
    r.o += 2 * n


def _poly(r):
    numpts = r.b[r.o]; stip = r.b[r.o + 1]; r.o += 2
    sides = r.i32()
    pos = struct.unpack_from('<h', r.b, r.o)[0]; r.o += 2
    neg = struct.unpack_from('<h', r.b, r.o)[0]; r.o += 2
    vids = list(struct.unpack_from('<%dh' % numpts, r.b, r.o)); r.o += 2 * numpts
    uvi = []
    if not (stip & 0x4):             # NoPos
        uvi = list(r.b[r.o:r.o + numpts]); r.o += numpts
    # NegUV presence: SidesType == CullMode.Clockwise (2) && !NoNeg — per ACE
    # Entity/Polygon.cs:41 (the original `sides == 1` here was wrong; CullMode
    # None = 1, Clockwise = 2).
    if sides == 2 and not (stip & 0x8):
        r.o += numpts
    return dict(n=numpts, stip=stip, sides=sides, pos=pos, neg=neg, v=vids,
                uvi=uvi or [0] * numpts)


def _vertex_array(r):
    vt = r.i32()
    nv = r.u32()
    P = []
    N = []
    UV = []
    idx = {}
    for i in range(nv):
        key = struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
        m = struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
        P.append(struct.unpack_from('<3f', r.b, r.o)); r.o += 12
        N.append(struct.unpack_from('<3f', r.b, r.o)); r.o += 12
        UV.append([struct.unpack_from('<2f', r.b, r.o + 8 * j) for j in range(m)])
        r.o += 8 * m
        idx[key] = i
    return P, N, UV, idx


def parse_environment(data, strict=False):
    r = R(data)
    eid = r.u32()
    ncells = r.u32()
    cells = {}
    for _ in range(ncells):
        key = r.u32()
        npoly = r.u32(); nphys = r.u32(); nport = r.u32()
        P, N, UV, idx = _vertex_array(r)
        polys = []
        for _ in range(npoly):
            pk = struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
            p = _poly(r)
            p['key'] = pk
            polys.append(p)
        portals = list(struct.unpack_from('<%dH' % nport, r.b, r.o)); r.o += 2 * nport
        r.align()
        _bsp(r, 'cell')
        phys = []
        for _ in range(nphys):
            pk = struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
            pp = _poly(r)
            pp['key'] = pk
            phys.append(pp)
        _bsp(r, 'physics')
        if r.u32() != 0:
            _bsp(r, 'drawing')
        r.align()
        cells[key] = dict(P=P, N=N, UV=UV, idx=idx, polys=polys, phys=phys,
                          portals=portals, nphys=nphys, nport=nport)
    if strict and len(data) - r.o != 0:
        raise ValueError("environment 0x%08X not fully consumed (tail=%d)"
                         % (eid, len(data) - r.o))
    return eid, cells


def parse_envcell(data):
    r = R(data)
    cid = r.u32()
    flags = r.u32()
    r.o += 4
    nsurf = r.b[r.o]; nport = r.b[r.o + 1]; r.o += 2
    nstab = struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
    surfs = []
    for _ in range(nsurf):
        surfs.append(0x08000000 | struct.unpack_from('<H', r.b, r.o)[0]); r.o += 2
    envid = 0x0D000000 | struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
    cstruct = struct.unpack_from('<H', r.b, r.o)[0]; r.o += 2
    origin = r.vec3(); orient = r.quat()
    portals = []
    for _ in range(nport):
        portals.append(struct.unpack_from('<4H', r.b, r.o)); r.o += 8
    vis = list(struct.unpack_from('<%dH' % nstab, r.b, r.o)) if nstab else []
    r.o += 2 * nstab
    stabs = []
    if flags & 0x2:      # HasStaticObjs
        n = r.u32()
        for _ in range(n):
            oid = r.u32(); o = r.vec3(); q = r.quat()
            stabs.append((oid, o, q))
    return dict(id=cid, flags=flags, surfaces=surfs, env=envid, cstruct=cstruct,
                origin=origin, orient=orient, portals=portals, visible=vis, stabs=stabs)
