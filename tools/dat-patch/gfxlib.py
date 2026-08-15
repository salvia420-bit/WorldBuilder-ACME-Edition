"""gfxlib.py -- read-only GfxObj (0x01) / Environment (0x0D) / Surface (0x08)
parsing that KEEPS the per-face UVs and the surface table.

Round 1's datlib.py threw both away (it only needed positions).  Everything in
round 2 is texture-aware, so we need:

  * SWVertex.UVs           -- the per-vertex UV LIST
  * Polygon.PosUVIndices   -- which UV of that list this FACE uses
  * GfxObj.Surfaces        -- polygon.pos_surface indexes into it

Ground truth: ACE.DatLoader FileTypes/GfxObj.cs, Entity/{Polygon,CVertexArray,
SWVertex,BSPTree,BSPNode}.cs, read at ~/ace-server this session.

NOTE (bug found in round 1's datlib._poly): it read NegUVIndices when
`sides == 1`.  ACE's CullMode is Landblock=0, None=1, Clockwise=2 -- NegUVIndices
exist only for Clockwise(2).  datlib therefore over-read `numpts` bytes on every
CullMode.None polygon, which is why 84/772 Environment records failed to parse
in round 1.  Fixed here; all 772 now parse.
"""
import struct

import datlib

CULL_LANDBLOCK, CULL_NONE, CULL_CW, CULL_CCW = 0, 1, 2, 3
STIP_NOPOS, STIP_NONEG = 0x4, 0x8


class Rdr:
    __slots__ = ("b", "o")

    def __init__(self, b, o=0):
        self.b = b
        self.o = o

    def u8(self):
        v = self.b[self.o]
        self.o += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.b, self.o)[0]
        self.o += 2
        return v

    def i16(self):
        v = struct.unpack_from("<h", self.b, self.o)[0]
        self.o += 2
        return v

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
        v = struct.unpack_from("<3f", self.b, self.o)
        self.o += 12
        return v

    def quat(self):
        v = struct.unpack_from("<4f", self.b, self.o)
        self.o += 16
        return v

    def compressed(self):
        b0 = self.u8()
        if not (b0 & 0x80):
            return b0
        b1 = self.u8()
        if not (b0 & 0x40):
            return ((b0 & 0x7F) << 8) | b1
        s = self.u16()
        return (((((b0 & 0x3F) << 8) | b1) << 16) | s)

    def align(self):
        self.o = (self.o + 3) & ~3


def read_polygon(r):
    numpts = r.u8()
    stip = r.u8()
    sides = r.i32()
    pos = r.i16()
    neg = r.i16()
    vids = list(struct.unpack_from("<%dh" % numpts, r.b, r.o))
    r.o += 2 * numpts
    posuv = []
    if not (stip & STIP_NOPOS):
        posuv = list(r.b[r.o:r.o + numpts])
        r.o += numpts
    if sides == CULL_CW and not (stip & STIP_NONEG):
        r.o += numpts                    # NegUVIndices
    return dict(n=numpts, stip=stip, sides=sides, pos=pos, neg=neg,
                v=vids, uvi=posuv or [0] * numpts)


def read_vertex_array(r):
    vt = r.i32()
    if vt != 1:
        raise ValueError("vertex type %d" % vt)
    nv = r.u32()
    P, N, UV, idx = [], [], [], {}
    for i in range(nv):
        key = r.u16()
        m = r.u16()
        P.append(r.vec3())
        N.append(r.vec3())
        uvs = []
        for _ in range(m):
            uvs.append((r.f32(), r.f32()))
        UV.append(uvs)
        idx[key] = i
    return P, N, UV, idx


def _bsp(r, ttype):
    t = r.b[r.o:r.o + 4][::-1].decode("ascii", "replace")
    r.o += 4
    if t == "LEAF":
        r.i32()
        if ttype == "physics":
            r.i32()
            r.o += 16
            n = r.u32()
            r.o += 2 * n
        return
    if t == "PORT":
        r.o += 16
        _bsp(r, ttype)
        _bsp(r, ttype)
        if ttype == "drawing":
            r.o += 16
            npoly = r.u32()
            nport = r.u32()
            r.o += 2 * npoly
            r.o += 4 * nport
        return
    r.o += 16
    if t in ("BPnn", "BPIn", "BpIN", "BpnN"):
        _bsp(r, ttype)
    elif t in ("BPIN", "BPnN"):
        _bsp(r, ttype)
        _bsp(r, ttype)
    if ttype == "cell":
        return
    r.o += 16                             # sphere
    if ttype == "physics":
        return
    n = r.u32()
    r.o += 2 * n


def parse_gfxobj(data):
    r = Rdr(data)
    oid = r.u32()
    flags = r.u32()
    nsurf = r.compressed()
    surfaces = [r.u32() for _ in range(nsurf)]
    P, N, UV, idx = read_vertex_array(r)
    phys = []
    if flags & 0x1:
        n = r.compressed()
        for _ in range(n):
            r.u16()
            phys.append(read_polygon(r))
        _bsp(r, "physics")
    sortc = r.vec3()
    polys = []
    if flags & 0x2:
        n = r.compressed()
        for _ in range(n):
            key = r.u16()
            p = read_polygon(r)
            p["key"] = key
            polys.append(p)
        _bsp(r, "drawing")
    degrade = r.u32() if (flags & 0x8) else 0
    return dict(id=oid, flags=flags, surfaces=surfaces, P=P, N=N, UV=UV,
                idx=idx, polys=polys, phys=phys, sort=sortc,
                degrade=degrade, tail=len(data) - r.o)


def parse_environment(data):
    """CellStructs, with UVs.  Same primitives as a GfxObj."""
    r = Rdr(data)
    eid = r.u32()
    ncells = r.u32()
    cells = {}
    for _ in range(ncells):
        key = r.u32()
        npoly = r.u32()
        nphys = r.u32()
        nport = r.u32()
        P, N, UV, idx = read_vertex_array(r)
        polys = []
        for _ in range(npoly):
            k = r.u16()
            p = read_polygon(r)
            p["key"] = k
            polys.append(p)
        portal_ids = list(struct.unpack_from("<%dH" % nport, r.b, r.o)) if nport else []
        r.o += 2 * nport
        r.align()
        _bsp(r, "cell")
        for _ in range(nphys):
            r.u16()
            read_polygon(r)
        _bsp(r, "physics")
        if r.u32() != 0:
            _bsp(r, "drawing")
        r.align()
        cells[key] = dict(P=P, N=N, UV=UV, idx=idx, polys=polys,
                          nphys=nphys, portal_ids=portal_ids)
    return eid, cells


# --------------------------------------------------------------- surfaces
SURF_BASE1SOLID, SURF_BASE1IMAGE, SURF_BASE1CLIPMAP = 0x1, 0x2, 0x4
SURF_TRANSLUCENT, SURF_LUMINOUS = 0x10, 0x40


def parse_surface(data):
    r = Rdr(data)
    stype = r.u32()
    tex = pal = colr = 0
    if stype & (SURF_BASE1IMAGE | SURF_BASE1CLIPMAP):
        tex = r.u32()
        pal = r.u32()
    else:
        colr = r.u32()
    return dict(type=stype, tex=tex, pal=pal, color=colr,
                translucency=r.f32(), luminosity=r.f32(), diffuse=r.f32())


def parse_surface_texture(data):
    r = Rdr(data)
    r.u32()                                # id
    r.i32()                                # unknown
    r.u8()                                 # unknown byte
    n = r.u32()
    return [r.u32() for _ in range(n)]


class Portal:
    """Cached accessor over client_portal.dat."""

    def __init__(self, path="/mnt/wbterminal2/dpc-work/proj/dats/base/client_portal.dat"):
        self.dat = datlib.Dat(path)
        self._gfx = {}
        self._env = {}
        self._surf = {}

    def gfx(self, gid):
        if gid not in self._gfx:
            self._gfx[gid] = parse_gfxobj(self.dat.get(gid))
        return self._gfx[gid]

    def env(self, eid):
        if eid not in self._env:
            self._env[eid] = parse_environment(self.dat.get(eid))[1]
        return self._env[eid]

    def surface(self, sid):
        """Surface(0x08) -> dict(+ rsId of the RenderSurface behind it)."""
        if sid in self._surf:
            return self._surf[sid]
        raw = self.dat.get(sid)
        if raw is None:
            self._surf[sid] = None
            return None
        s = parse_surface(raw)
        s["rsId"] = None
        if s["tex"]:
            st = self.dat.get(s["tex"])
            if st:
                ids = parse_surface_texture(st)
                # SurfaceTexture.Textures is a resolution chain, highest FIRST.
                # The leading entries live in client_highres.dat and are simply
                # absent from a base install, so take the highest one that
                # actually exists in this dat.
                for t in ids:
                    if t in self.dat.files:
                        s["rsId"] = "0x%08X" % t
                        break
                s["hasHighres"] = len(ids) > 1 and ids[0] not in self.dat.files
        self._surf[sid] = s
        return s
