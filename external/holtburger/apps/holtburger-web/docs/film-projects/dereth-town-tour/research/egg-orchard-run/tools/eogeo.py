#!/usr/bin/env python3
"""eogeo.py - offline geometry kit for the Egg Orchard (landblock 0x002B, Mid copy).

Built from the DAT parse (data/src/eo_parse_all.jsonl: 639 EnvCells + 50 Environments), the
static/creature meshes fetched by fetch_meshes.py (data/meshes.json) and the ACE spawns
(data/src/0x002B.spawns.jsonl). Pure numpy; no network, no browser.

Frames: WORLD = landblock-local + (0, 8256, 0) (lbX 0, lbY 43 -> 43*192); z identical; metres.

What it gives you (all world space):
  D = Dungeon()                      # loads everything once (~2 s)
  D.cells[cid]                       # Cell: env, cs, kind, region ('tunnel'|'room'), tris, portals, bbox
  D.point_cell(p) -> cid | None      # retail point-in-cell: walk the cellBSP pos chain (BSPNODE::point_inside_cell_bsp)
  D.wall(p) -> (d, closest, cls, cid) # nearest cell surface (portal polygons excluded); cls floor|ceiling|wall
  D.floor_ceil(p) -> (floorZ, ceilZ) # vertical rays against the cell surfaces (None when open)
  D.prop(p) -> (d, prop)             # nearest static mesh (vents, columns, big props, eggs, hive, ...)
  D.creature_clearance(p) -> list    # per creature within 12 m: cylinder (physics r,h) and oriented-box clearance
  D.seg_hits(a, b) -> bool           # does the segment pass through a cell surface or a prop
  D.region_of(cid)                   # 'tunnel' (0.9 m rule) | 'room' (1.2 m rule)
"""
import json, math, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
SRC = os.path.join(DATA, 'src')
LB_OFFSET = np.array([0.0, 43 * 192.0, 0.0])

# Environment ids whose cells are tunnels (5.33 x 3.75 m section): bends, X/T junctions, chamfered corners,
# straights, ramps, the exit stub. Burrow trenches (cs 0 of 0x01EC/0x01EE) and the chute are tunnel-like too.
TUNNEL_ENVS = {0x0125, 0x0126, 0x0128, 0x0129, 0x012A, 0x0183, 0x041C}
TRENCH_ENVS = {0x01EC, 0x01EE}
CHUTE_ENV = 0x01E7
# Env 0x01E7 is used by both the -12 hall centre cell with the floor hole (a room) and the chute under it (a
# 3.1 m tunnel-like slide).
REGION_OVERRIDES = {0x2C3: 'room', 0x2C2: 'tunnel'}

# Creature physics from the Setup parses (height/radius) x the weenie DefaultScale (LSD floatStat 39).
CREATURES = {
    31005: {'name': 'Olthoi Ripper', 'setup': '0x02000A36', 'scale': 0.8},
    31006: {'name': 'Olthoi Larvae', 'setup': '0x02000F3D', 'scale': 1.0},
    31007: {'name': 'Olthoi Slasher', 'setup': '0x02000AAC', 'scale': 1.0},
    31008: {'name': 'Olthoi Slayer', 'setup': '0x02000AAC', 'scale': 1.1},
}
# Generator-only spawns (absent at load; spawned when a Ripper dies) and non-creatures.
IGNORE_CREATURES = {34014}
GOAL_PORTAL = np.array([9.70408, -113.312 + 8256.0, -60.063])

PROP_KIND = {
    '0x0200028D': 'wall vent', '0x02000AB3': 'wall vent', '0x02000205': 'wall vent',
    '0x0200028F': 'vent column', '0x02000208': 'slim column', '0x02000209': 'vent column',
    '0x02000AC1': 'big prop', '0x02000AC3': 'big prop', '0x02000AC5': 'big prop', '0x02000AC6': 'big prop',
    '0x02000AE1': 'egg', '0x02000F97': 'hive', '0x0200113E': 'prop', '0x010009C7': 'prop', '0x02000C39': 'prop',
}


def qrot(q, v):
    """Rotate v (3,) or (N,3) by quaternion q = (w, x, y, z)."""
    w, x, y, z = q
    v = np.asarray(v, dtype=float)
    u = np.array([x, y, z])
    t = 2.0 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def qinv(q):
    w, x, y, z = q
    return (w, -x, -y, -z)


def yaw_of(q):
    """Heading of the local +y axis (AC forward), degrees clockwise from north... returned as the world
    direction vector of local +y in xy."""
    f = qrot(q, [0.0, 1.0, 0.0])
    return f[:2] / (np.linalg.norm(f[:2]) or 1.0)


# ----------------------------------------------------------------------------------------------
# Vectorised closest point on triangles (Ericson, Real-Time Collision Detection 5.1.5)
# ----------------------------------------------------------------------------------------------
def closest_on_tris(p, A, B, C):
    """p (3,), A/B/C (M,3) -> closest points (M,3)."""
    ab = B - A; ac = C - A; ap = p - A
    d1 = np.einsum('ij,ij->i', ab, ap); d2 = np.einsum('ij,ij->i', ac, ap)
    bp = p - B
    d3 = np.einsum('ij,ij->i', ab, bp); d4 = np.einsum('ij,ij->i', ac, bp)
    cp = p - C
    d5 = np.einsum('ij,ij->i', ab, cp); d6 = np.einsum('ij,ij->i', ac, cp)
    va = d3 * d6 - d5 * d4; vb = d5 * d2 - d1 * d6; vc = d1 * d4 - d3 * d2
    out = np.empty_like(A)
    done = np.zeros(len(A), bool)

    def put(mask, val):
        nonlocal done
        m = mask & ~done
        if m.any():
            out[m] = val[m] if val.ndim == 2 else val
            done |= m

    put((d1 <= 0) & (d2 <= 0), A)
    put((d3 >= 0) & (d4 <= d3), B)
    with np.errstate(divide='ignore', invalid='ignore'):
        v = np.where(np.abs(d1 - d3) > 1e-12, d1 / (d1 - d3), 0.0)
        put((vc <= 0) & (d1 >= 0) & (d3 <= 0), A + v[:, None] * ab)
        put((d6 >= 0) & (d5 <= d6), C)
        w = np.where(np.abs(d2 - d6) > 1e-12, d2 / (d2 - d6), 0.0)
        put((vb <= 0) & (d2 >= 0) & (d6 <= 0), A + w[:, None] * ac)
        den = (d4 - d3) + (d5 - d6)
        w2 = np.where(np.abs(den) > 1e-12, (d4 - d3) / den, 0.0)
        put((va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0), B + w2[:, None] * (C - B))
        s = va + vb + vc
        s = np.where(np.abs(s) > 1e-12, s, 1e-12)
        vv = (vb / s)[:, None]; ww = (vc / s)[:, None]
    put(np.ones(len(A), bool), A + ab * vv + ac * ww)
    return out


def seg_tri_hit(a, b, A, B, C, eps=1e-9):
    """Segment a->b vs triangles (Moller-Trumbore). Returns bool (M,) hit with 0 < t < 1."""
    d = b - a
    e1 = B - A; e2 = C - A
    h = np.cross(d, e2)
    det = np.einsum('ij,ij->i', e1, h)
    ok = np.abs(det) > eps
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = a - A
    u = inv * np.einsum('ij,ij->i', s, h)
    q = np.cross(s, e1)
    v = inv * (q @ d)
    t = inv * np.einsum('ij,ij->i', e2, q)
    return ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t < 1 - 1e-6)


class TriHash:
    """3-D bucket hash over triangle bounding boxes."""

    def __init__(self, A, B, C, cell=3.0):
        self.A, self.B, self.C, self.h = A, B, C, cell
        self.buckets = {}
        lo = np.minimum(np.minimum(A, B), C); hi = np.maximum(np.maximum(A, B), C)
        self.lo, self.hi = lo, hi
        il = np.floor(lo / cell).astype(int); ih = np.floor(hi / cell).astype(int)
        for i in range(len(A)):
            for x in range(il[i, 0], ih[i, 0] + 1):
                for y in range(il[i, 1], ih[i, 1] + 1):
                    for z in range(il[i, 2], ih[i, 2] + 1):
                        self.buckets.setdefault((x, y, z), []).append(i)
        self.cache = {}

    def near(self, p, r=1):
        k = tuple(np.floor(np.asarray(p) / self.h).astype(int))
        key = (k, r)
        got = self.cache.get(key)
        if got is not None:
            return got
        s = set()
        for x in range(k[0] - r, k[0] + r + 1):
            for y in range(k[1] - r, k[1] + r + 1):
                for z in range(k[2] - r, k[2] + r + 1):
                    b = self.buckets.get((x, y, z))
                    if b:
                        s.update(b)
        out = np.fromiter(s, int, len(s))
        if len(self.cache) < 200000:
            self.cache[key] = out
        return out

    def along(self, a, b):
        n = max(1, int(math.ceil(np.linalg.norm(np.asarray(b) - np.asarray(a)) / (self.h * 0.5))))
        s = set()
        for i in range(n + 1):
            s.update(self.near(np.asarray(a) + (np.asarray(b) - np.asarray(a)) * (i / n), 1).tolist())
        return np.fromiter(s, int, len(s))


class Cell:
    pass


class Dungeon:
    def __init__(self, parse=os.path.join(SRC, 'eo_parse_all.jsonl'), meshes=os.path.join(DATA, 'meshes.json'),
                 spawns=os.path.join(SRC, '0x002B.spawns.jsonl')):
        envs, raw = {}, {}
        for line in open(parse):
            d = json.loads(line)
            if d.get('command') != 'chorizite-parse-dat-record':
                continue
            if d['typeName'] == 'Environment':
                envs[d['id'] & 0xFFFF] = d['fields']['cells']
            elif d['typeName'] == 'EnvCell':
                raw[d['id'] & 0xFFFF] = d['fields']
        self.cells = {}
        TA, TB, TC, TOWN = [], [], [], []
        for cid, f in sorted(raw.items()):
            cs = envs[f['environmentId']][str(f['cellStructure'])]
            c = Cell()
            c.id = cid; c.env = f['environmentId']; c.cs = f['cellStructure']
            c.origin = np.array(f['position']['origin'], float); c.q = tuple(f['position']['orientation'])
            verts = {int(k): np.array(v['origin'], float) for k, v in cs['vertexArray']['vertices'].items()}
            W = lambda p, c=c: qrot(c.q, p) + c.origin + LB_OFFSET
            portal_polys = set(p['polygonId'] for p in f['cellPortals'])
            portal_polys |= set(cs.get('portals') or [])
            wv = np.array([W(v) for v in verts.values()])
            c.bbox = (wv.min(0), wv.max(0))
            c.portals = []
            for p in f['cellPortals']:
                pv = np.array([W(verts[i]) for i in cs['polygons'][str(p['polygonId'])]['vertexIds']])
                ctr = pv.mean(0)
                nrm = newell(pv)
                cc = (c.bbox[0] + c.bbox[1]) / 2
                if np.dot(ctr - cc, nrm) < 0:
                    nrm = -nrm
                c.portals.append({'other': p['otherCellId'], 'poly': pv, 'centre': ctr, 'normal': nrm,
                                  'zmin': pv[:, 2].min(), 'zmax': pv[:, 2].max()})
            c.neighbors = [p['otherCellId'] for p in f['cellPortals'] if p['otherCellId'] != 0xFFFF]
            ntri = 0
            for pid, poly in cs['polygons'].items():
                if int(pid) in portal_polys:
                    continue
                pv = [W(verts[i]) for i in poly['vertexIds']]
                for k in range(1, len(pv) - 1):
                    TA.append(pv[0]); TB.append(pv[k]); TC.append(pv[k + 1]); TOWN.append(cid); ntri += 1
            # retail point-in-cell: the cellBSP pos chain, planes in cell (environment) space
            planes = []
            node = (cs.get('cellBSP') or {}).get('root')
            while node:
                sp = node['splittingPlane']
                planes.append((np.array(sp['normal'], float), float(sp['d'])))
                node = node.get('posNode')
            c.planes = planes
            c.statics = f.get('staticObjects') or []
            c.region = self._region(c)
            c.floorZ = float(wv[:, 2].min())
            c.topZ = float(wv[:, 2].max())
            self.cells[cid] = c
        self.cids = np.array(sorted(self.cells))
        self.clo = np.array([self.cells[c].bbox[0] for c in self.cids]) - 0.05
        self.chi = np.array([self.cells[c].bbox[1] for c in self.cids]) + 0.05
        self.TA, self.TB, self.TC = np.array(TA), np.array(TB), np.array(TC)
        self.Towner = np.array(TOWN)
        n = np.cross(self.TB - self.TA, self.TC - self.TA)
        self.Tn = n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
        self.hash = TriHash(self.TA, self.TB, self.TC, 3.0)
        self._xyhash()
        self._load_props(meshes)
        self._load_creatures(spawns, meshes)

    # ------------------------------------------------------------------ classification
    @staticmethod
    def _region(c):
        if c.id in REGION_OVERRIDES:
            return REGION_OVERRIDES[c.id]
        if c.env in TUNNEL_ENVS:
            return 'tunnel'
        if c.env in TRENCH_ENVS and c.cs == 0:
            return 'tunnel'
        return 'room'

    def region_of(self, cid):
        return self.cells[cid].region if cid in self.cells else 'outside'

    # ------------------------------------------------------------------ cells
    def point_cell(self, p, prefer=None):
        p = np.asarray(p, float)
        m = np.all((p >= self.clo) & (p <= self.chi), axis=1)
        cands = [int(c) for c in self.cids[m]]
        if prefer is not None and prefer in cands:
            cands.remove(prefer); cands.insert(0, prefer)
        for cid in cands:
            if self.in_cell(p, cid):
                return cid
        return None

    def in_cell(self, p, cid):
        c = self.cells[cid]
        lp = qrot(qinv(c.q), np.asarray(p, float) - LB_OFFSET - c.origin)
        for n, d in c.planes:
            if float(np.dot(n, lp) + d) < -0.0002:
                return False
        return True

    # ------------------------------------------------------------------ distances
    def wall(self, p, r=1):
        p = np.asarray(p, float)
        idx = self.hash.near(p, r)
        if len(idx) == 0:
            return 99.0, None, 'none', None
        cp = closest_on_tris(p, self.TA[idx], self.TB[idx], self.TC[idx])
        d = np.linalg.norm(cp - p, axis=1)
        k = int(np.argmin(d))
        t = idx[k]
        nz = abs(self.Tn[t, 2])
        if nz > 0.7:
            cls = 'floor' if cp[k, 2] < p[2] else 'ceiling'
        else:
            cls = 'wall'
        return float(d[k]), cp[k], cls, int(self.Towner[t])

    def wall_by_class(self, p, r=1):
        """Nearest distance per class {floor, ceiling, wall} (99 when none within ~3-6 m)."""
        p = np.asarray(p, float)
        idx = self.hash.near(p, r)
        out = {'floor': 99.0, 'ceiling': 99.0, 'wall': 99.0}
        if len(idx) == 0:
            return out
        cp = closest_on_tris(p, self.TA[idx], self.TB[idx], self.TC[idx])
        d = np.linalg.norm(cp - p, axis=1)
        nz = np.abs(self.Tn[idx, 2])
        for k in range(len(idx)):
            if nz[k] > 0.7:
                cls = 'floor' if cp[k, 2] < p[2] - 1e-6 else 'ceiling'
            else:
                cls = 'wall'
            if d[k] < out[cls]:
                out[cls] = float(d[k])
        return out

    def _xyhash(self, h=2.0):
        self.xyh = h
        lo = np.minimum(np.minimum(self.TA, self.TB), self.TC); hi = np.maximum(np.maximum(self.TA, self.TB), self.TC)
        self.xyb = {}
        il = np.floor(lo[:, :2] / h).astype(int); ih = np.floor(hi[:, :2] / h).astype(int)
        for i in range(len(self.TA)):
            for x in range(il[i, 0], ih[i, 0] + 1):
                for y in range(il[i, 1], ih[i, 1] + 1):
                    self.xyb.setdefault((x, y), []).append(i)

    def floor_ceil(self, p):
        """Vertical rays from p: (floorZ below, ceilZ above) over cell surfaces; None when nothing is hit."""
        p = np.asarray(p, float)
        idx = self.xyb.get((int(math.floor(p[0] / self.xyh)), int(math.floor(p[1] / self.xyh))))
        if not idx:
            return None, None
        idx = np.array(idx)
        A, B, C = self.TA[idx], self.TB[idx], self.TC[idx]
        v0 = B[:, :2] - A[:, :2]; v1 = C[:, :2] - A[:, :2]; v2 = p[:2] - A[:, :2]
        den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
        ok = np.abs(den) > 1e-9
        den = np.where(ok, den, 1.0)
        b1 = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den
        b2 = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den
        inside = ok & (b1 >= -1e-6) & (b2 >= -1e-6) & (b1 + b2 <= 1 + 1e-6)
        z = A[:, 2] + b1 * (B[:, 2] - A[:, 2]) + b2 * (C[:, 2] - A[:, 2])
        z = z[inside]
        below = z[z <= p[2] + 1e-6]; above = z[z > p[2] + 1e-6]
        return (float(below.max()) if len(below) else None), (float(above.min()) if len(above) else None)

    def seg_hits(self, a, b, props=True):
        """True when the segment a->b passes through a cell surface (or a prop mesh when props=True)."""
        a = np.asarray(a, float); b = np.asarray(b, float)
        idx = self.hash.along(a, b)
        if len(idx) and seg_tri_hit(a, b, self.TA[idx], self.TB[idx], self.TC[idx]).any():
            return 'wall'
        if props:
            idx = self.phash.along(a, b)
            if len(idx) and seg_tri_hit(a, b, self.PA[idx], self.PB[idx], self.PC[idx]).any():
                return 'prop'
        return None

    # ------------------------------------------------------------------ props (static meshes)
    def _load_props(self, meshes_path):
        meshes = json.load(open(meshes_path))
        self.meshes = meshes
        self.props = []
        PA, PB, PC, PO = [], [], [], []
        for cid, c in self.cells.items():
            for s in c.statics:
                key = '0x%08X' % s['id']
                m = meshes.get(key)
                if not m:
                    continue
                size = np.array(m['max']) - np.array(m['min'])
                if size.max() < 0.2:
                    continue  # light / particle markers
                q = tuple(s['frame']['orientation']); o = np.array(s['frame']['origin'], float) + LB_OFFSET
                tris = np.array(m['tris'], float)
                wt = qrot(q, tris.reshape(-1, 3)).reshape(-1, 3, 3) + o
                pi = len(self.props)
                self.props.append({'i': pi, 'setup': key, 'kind': PROP_KIND.get(key, 'prop'), 'cell': cid, 'pos': o,
                                   'min': wt.reshape(-1, 3).min(0), 'max': wt.reshape(-1, 3).max(0), 'size': size})
                PA.extend(wt[:, 0]); PB.extend(wt[:, 1]); PC.extend(wt[:, 2]); PO.extend([pi] * len(wt))
        self.PA, self.PB, self.PC, self.Powner = np.array(PA), np.array(PB), np.array(PC), np.array(PO)
        self.phash = TriHash(self.PA, self.PB, self.PC, 3.0)

    def prop(self, p, r=1):
        p = np.asarray(p, float)
        idx = self.phash.near(p, r)
        if len(idx) == 0:
            return 99.0, None
        cp = closest_on_tris(p, self.PA[idx], self.PB[idx], self.PC[idx])
        d = np.linalg.norm(cp - p, axis=1)
        k = int(np.argmin(d))
        return float(d[k]), self.props[int(self.Powner[idx[k]])]

    # ------------------------------------------------------------------ creatures
    def _load_creatures(self, spawns_path, meshes_path):
        meshes = self.meshes
        self.creatures = []
        self.surface_portals = []
        for line in open(spawns_path):
            s = json.loads(line)
            pos = np.array([s['x'], s['y'], s['z']], float) + LB_OFFSET
            if s.get('wcid') == 30965:
                self.surface_portals.append({'cell': 0x2B0000 | s['cell'], 'pos': pos})
                continue
            if s.get('category') != 'Creature' or s.get('wcid') in IGNORE_CREATURES:
                continue
            spec = CREATURES.get(s['wcid'])
            if not spec:
                continue
            m = meshes[spec['setup']]
            sc = spec['scale']
            q = (s.get('qw', 1.0), s.get('qx', 0.0), s.get('qy', 0.0), s.get('qz', 0.0))
            if s.get('orientationIsIdentity'):
                q = (1.0, 0.0, 0.0, 0.0)
            ph = m['physics']
            r = float(ph['radius']) * sc; h = float(ph['height']) * sc
            bmin = np.array(m['min']) * sc; bmax = np.array(m['max']) * sc
            top = max(h, float(bmax[2]))
            self.creatures.append({
                'i': len(self.creatures), 'name': spec['name'], 'wcid': s['wcid'], 'cell': s['cell'],
                'cellHex': '0x%04X' % s['cell'], 'pos': pos, 'q': q, 'r': r, 'h': h, 'top': top,
                'boxMin': bmin, 'boxMax': bmax, 'forward': yaw_of(q),
                'sweptR': float(max(np.hypot(bmin[0], bmin[1]), np.hypot(bmax[0], bmax[1]),
                                    np.hypot(bmin[0], bmax[1]), np.hypot(bmax[0], bmin[1]))),
            })
        self.cpos = np.array([c['pos'] for c in self.creatures])

    def creature_clearance(self, p, within=12.0):
        """[(creature, cylClear, boxClear)] for creatures within `within` m (horizontal).
        cylClear = distance from p to the physics cylinder (radius r, base z .. z + top) - the rule is
        cylClear >= 0.8 (= radius + 0.8 from the axis); boxClear = distance to the oriented mesh box."""
        p = np.asarray(p, float)
        if not len(self.cpos):
            return []
        dh = np.hypot(self.cpos[:, 0] - p[0], self.cpos[:, 1] - p[1])
        out = []
        for i in np.nonzero(dh < within)[0]:
            c = self.creatures[i]
            out.append((c, cyl_clear(p, c), box_clear(p, c)))
        return out


def newell(pv):
    n = np.zeros(3)
    for i in range(len(pv)):
        a = pv[i]; b = pv[(i + 1) % len(pv)]
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1])
    l = np.linalg.norm(n)
    return n / l if l > 0 else n


def cyl_clear(p, c):
    base = c['pos'][2]; top = base + c['top']
    rh = math.hypot(p[0] - c['pos'][0], p[1] - c['pos'][1]) - c['r']
    if p[2] > top:
        dz = p[2] - top
    elif p[2] < base:
        dz = base - p[2]
    else:
        dz = 0.0
    if rh <= 0:
        return dz if dz > 0 else -min(-rh, min(abs(p[2] - top), abs(p[2] - base)))
    return math.hypot(rh, dz)


def box_clear(p, c):
    lp = qrot(qinv(c['q']), np.asarray(p, float) - c['pos'])
    lo = np.array(c['boxMin'], float).copy(); hi = np.array(c['boxMax'], float).copy()
    lo[2] = 0.0
    d = np.maximum(np.maximum(lo - lp, lp - hi), 0.0)
    return float(np.linalg.norm(d))


def load_traj(path):
    """Accepts [{t,pos}], {samples|rows|traj:[{t,pos}|{t,x,y,z}]}, a racing_line.json {points, s} or [[x,y,z]]."""
    d = json.load(open(path))
    rows = d
    if isinstance(d, dict):
        if 'points' in d:
            pts = d['points']; s = d.get('s') or list(range(len(pts)))
            return [{'t': None, 's': s[i], 'pos': pts[i]} for i in range(len(pts))]
        for k in ('samples', 'rows', 'traj', 'table'):
            if k in d:
                rows = d[k]; break
    out = []
    for i, r in enumerate(rows):
        if isinstance(r, (list, tuple)):
            out.append({'t': None, 'pos': list(r[:3])})
        elif 'pos' in r:
            out.append({'t': r.get('t'), 's': r.get('s'), 'pos': list(r['pos'])})
        else:
            out.append({'t': r.get('t'), 's': r.get('s'), 'pos': [r['x'], r['y'], r['z']]})
    return out
