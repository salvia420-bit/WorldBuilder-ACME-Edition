#!/usr/bin/env python3
"""Catalog every retail ParticleEmitter (0x32) in client_portal.dat.

Walks the portal B-tree, parses 0x32 emitters, 0x33 PhysicsScripts (which
emitters they spawn), 0x34 PhysicsScriptTables (PlayScript type -> scripts),
0x02 Setups (DefaultScript + placement-frame hooks), and resolves each
emitter's hwGfxObj -> Surface -> SurfaceTexture -> RenderSurface to decode a
thumbnail + color stats. Field layouts follow ACE.DatLoader (ace-server).
"""
import json, mmap, os, struct, sys
from collections import defaultdict

DAT = os.environ.get("PFX_PORTAL_DAT", "/home/wbterminal/ac_base_dats/client_portal.dat")  # base DATs only (bake-base-dats-only)
OUT = sys.argv[1] if len(sys.argv) > 1 else (os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work"))
os.makedirs(OUT, exist_ok=True)


class Dat:
    def __init__(self, path):
        self.f = open(path, "rb")
        self.m = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
        h = struct.unpack_from("<11I", self.m, 0x140)
        self.bs = h[1]
        self.root = h[8]
        self.files = {}
        self._walk(self.root)

    def read(self, off, size):
        m, bs = self.m, self.bs
        out = bytearray()
        nxt = struct.unpack_from("<I", m, off)[0]
        pos = off + 4
        while size > 0:
            if nxt == 0:
                out += m[pos:pos + size]
                size = 0
            else:
                n = bs - 4
                out += m[pos:pos + n]
                size -= n
                pos = nxt + 4
                nxt = struct.unpack_from("<I", m, nxt)[0]
        return bytes(out[: len(out)])

    def _walk(self, off):
        d = self.read(off, 62 * 4 + 4 + 61 * 24)
        br = struct.unpack_from("<62I", d, 0)
        cnt = struct.unpack_from("<I", d, 248)[0]
        for i in range(cnt):
            _fl, oid, foff, fsz, _dt, _it = struct.unpack_from("<6I", d, 252 + 24 * i)
            self.files[oid] = (foff, fsz)
        if br[0] != 0:
            for i in range(cnt + 1):
                self._walk(br[i])

    def get(self, oid):
        e = self.files.get(oid)
        if not e:
            return None
        return self.read(e[0], e[1])

    def ids(self, hi):
        return sorted(k for k in self.files if (k >> 24) == hi)


class R:
    def __init__(self, b, p=0):
        self.b, self.p = b, p

    def u32(self):
        v = struct.unpack_from("<I", self.b, self.p)[0]; self.p += 4; return v

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.p)[0]; self.p += 4; return v

    def u16(self):
        v = struct.unpack_from("<H", self.b, self.p)[0]; self.p += 2; return v

    def u8(self):
        v = self.b[self.p]; self.p += 1; return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.p)[0]; self.p += 4; return v

    def f64(self):
        v = struct.unpack_from("<d", self.b, self.p)[0]; self.p += 8; return v

    def v3(self):
        v = struct.unpack_from("<3f", self.b, self.p); self.p += 12; return list(v)

    def frame(self):
        o = self.v3(); q = struct.unpack_from("<4f", self.b, self.p); self.p += 16
        return {"origin": o, "q": list(q)}  # q = (w, x, y, z)

    def cu32(self):
        b0 = self.u8()
        if not (b0 & 0x80):
            return b0
        b1 = self.u8()
        if not (b0 & 0x40):
            return ((b0 & 0x7F) << 8) | b1
        s = self.u16()
        return ((((b0 & 0x3F) << 8) | b1) << 16) | s


HOOK_NAMES = {0: "NoOp", 1: "Sound", 2: "SoundTable", 3: "Attack", 4: "AnimationDone", 5: "ReplaceObject",
              6: "Ethereal", 7: "TransparentPart", 8: "Luminous", 9: "LuminousPart", 10: "Diffuse",
              11: "DiffusePart", 12: "Scale", 13: "CreateParticle", 14: "DestroyParticle", 15: "StopParticle",
              16: "NoDraw", 17: "DefaultScript", 18: "DefaultScriptPart", 19: "CallPES", 20: "Transparent",
              21: "SoundTweaked", 22: "SetOmega", 23: "TextureVelocity", 24: "TextureVelocityPart",
              25: "SetLight", 26: "CreateBlockingParticle"}


def read_hook(r):
    t = r.u32(); _dir = r.i32()
    h = {"type": HOOK_NAMES.get(t, t)}
    if t in (13, 26):
        h["emitterInfo"] = r.u32(); h["part"] = r.i32(); h["offset"] = r.frame(); h["emitterId"] = r.u32()
    elif t == 3:
        r.p += 28
    elif t == 19:
        h["pes"] = r.u32(); h["pause"] = r.f32()
    elif t in (14, 15):
        h["emitterId"] = r.u32()
    elif t in (1, 2, 16, 18):
        h["id"] = r.u32()
    elif t in (8, 10, 20):
        h["start"] = r.f32(); h["end"] = r.f32(); h["time"] = r.f32()
    elif t in (7, 9, 11):
        h["part"] = r.u32(); h["start"] = r.f32(); h["end"] = r.f32(); h["time"] = r.f32()
    elif t == 5:
        r.p += 2  # ReplaceObjectHook: AnimationPartChange packed u16 (ACE reads u16)
    elif t == 6:
        r.p += 4
    elif t == 12:
        h["end"] = r.f32(); h["time"] = r.f32()
    elif t == 21:
        h["id"] = r.u32(); r.p += 12
    elif t == 22:
        h["omega"] = r.v3()
    elif t == 23:
        h["u"] = r.f32(); h["v"] = r.f32()
    elif t == 24:
        h["part"] = r.u32(); h["u"] = r.f32(); h["v"] = r.f32()
    elif t == 25:
        h["on"] = r.i32()
    elif t in (0, 4, 17):
        pass
    else:
        raise ValueError(f"unknown hook {t}")
    return h


def parse_emitter(b):
    r = R(b)
    e = {"id": r.u32()}
    r.u32()
    e["emitterType"] = r.i32(); e["particleType"] = r.i32()
    e["gfxObj"] = r.u32(); e["hwGfxObj"] = r.u32()
    e["birthrate"] = r.f64(); e["maxParticles"] = r.i32(); e["initialParticles"] = r.i32()
    e["totalParticles"] = r.i32(); e["totalSeconds"] = r.f64()
    e["lifespan"] = r.f64(); e["lifespanRand"] = r.f64()
    e["offsetDir"] = r.v3(); e["minOffset"] = r.f32(); e["maxOffset"] = r.f32()
    e["A"] = r.v3(); e["minA"] = r.f32(); e["maxA"] = r.f32()
    e["B"] = r.v3(); e["minB"] = r.f32(); e["maxB"] = r.f32()
    e["C"] = r.v3(); e["minC"] = r.f32(); e["maxC"] = r.f32()
    e["startScale"] = r.f32(); e["finalScale"] = r.f32(); e["scaleRand"] = r.f32()
    e["startTrans"] = r.f32(); e["finalTrans"] = r.f32(); e["transRand"] = r.f32()
    e["isParentLocal"] = r.i32()
    return e


def parse_script(b):
    r = R(b)
    sid = r.u32(); n = r.u32()
    out = []
    for _ in range(n):
        t = r.f64(); h = read_hook(r); h["t"] = round(t, 4); out.append(h)
    return sid, out


def parse_script_table(b):
    r = R(b)
    tid = r.u32(); n = r.u32(); rows = {}
    for _ in range(n):
        k = r.u32(); m = r.i32(); lst = []
        for _ in range(m):
            mod = r.f32(); s = r.u32(); lst.append((round(mod, 4), s))
        rows[k] = lst
    return tid, rows


def parse_setup(b):
    r = R(b)
    sid = r.u32(); fl = r.u32(); n = r.u32()
    parts = [r.u32() for _ in range(n)]
    if fl & 1: r.p += 4 * n
    if fl & 2: r.p += 12 * n
    for _ in range(2):  # holding locations, connection points
        c = r.i32()
        r.p += c * (4 + 4 + 28)
    hooks = []
    pc = r.i32()
    for _ in range(pc):
        r.i32(); r.p += 28 * n
        nh = r.u32()
        for _ in range(nh):
            hooks.append(read_hook(r))
    c = r.u32(); r.p += 20 * c
    c = r.u32(); r.p += 16 * c
    r.p += 16 + 32 + 4 * 0
    # Height, Radius, StepUp, StepDown already counted? (4 floats=16) then 2 spheres (32)
    c = r.i32(); r.p += c * (4 + 44)
    defAnim = r.u32(); defScript = r.u32(); defMT = r.u32(); defST = r.u32(); defSTab = r.u32()
    return sid, {"parts": parts, "hooks": hooks, "defaultScript": defScript, "defaultScriptTable": defSTab}


def parse_gfxobj(b):
    r = R(b)
    gid = r.u32(); fl = r.u32()
    n = r.cu32(); surfs = [r.u32() for _ in range(n)]
    vt = r.i32(); nv = r.u32(); verts = []; uvs = []
    if vt == 1:
        for _ in range(nv):
            r.u16(); nuv = r.u16(); o = r.v3(); r.v3()
            for _k in range(nuv):
                uvs.append(struct.unpack_from("<2f", r.b, r.p)); r.p += 8
            verts.append(o)
    uvb = None
    if uvs:
        uvb = [round(min(u for u, v in uvs), 3), round(min(v for u, v in uvs), 3), round(max(u for u, v in uvs), 3), round(max(v for u, v in uvs), 3)]
    return {"surfaces": surfs, "verts": verts, "flags": fl, "uvBounds": uvb}


def parse_surface(b):
    r = R(b)
    t = r.u32(); s = {"type": t}
    if t & 6:
        s["tex"] = r.u32(); s["pal"] = r.u32()
    else:
        s["color"] = r.u32()
    s["translucency"] = r.f32(); s["luminosity"] = r.f32(); s["diffuse"] = r.f32()
    return s


def decode_dxt(data, w, h, kind):
    import numpy as np
    out = np.zeros((h, w, 4), np.uint8)
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    bsz = 8 if kind == 1 else 16
    p = 0
    for by in range(bh):
        for bx in range(bw):
            blk = data[p:p + bsz]; p += bsz
            if len(blk) < bsz: break
            alpha = None
            cb = blk
            if kind == 3:
                a = int.from_bytes(blk[0:8], "little")
                alpha = [((a >> (4 * i)) & 15) * 17 for i in range(16)]; cb = blk[8:]
            elif kind == 5:
                a0, a1 = blk[0], blk[1]
                bits = int.from_bytes(blk[2:8], "little")
                if a0 > a1:
                    pal = [a0, a1] + [((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)]
                else:
                    pal = [a0, a1] + [((5 - i) * a0 + i * a1) // 5 for i in range(1, 5)] + [0, 255]
                alpha = [pal[(bits >> (3 * i)) & 7] for i in range(16)]; cb = blk[8:]
            c0, c1 = struct.unpack_from("<HH", cb, 0)
            idx = int.from_bytes(cb[4:8], "little")

            def rgb(c):
                return [((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31]
            p0, p1 = rgb(c0), rgb(c1)
            if c0 > c1 or kind != 1:
                cols = [p0 + [255], p1 + [255], [(2 * a + b) // 3 for a, b in zip(p0, p1)] + [255],
                        [(a + 2 * b) // 3 for a, b in zip(p0, p1)] + [255]]
            else:
                cols = [p0 + [255], p1 + [255], [(a + b) // 2 for a, b in zip(p0, p1)] + [255], [0, 0, 0, 0]]
            for i in range(16):
                x, y = bx * 4 + (i & 3), by * 4 + (i >> 2)
                if x < w and y < h:
                    c = list(cols[(idx >> (2 * i)) & 3])
                    if alpha is not None: c[3] = alpha[i]
                    out[y, x] = c
    return out


def decode_texture(dat, tid, palid):
    import numpy as np
    b = dat.get(tid)
    if not b:
        return None, "missing"
    r = R(b)
    r.u32(); r.i32(); w = r.i32(); h = r.i32(); fmt = r.u32(); ln = r.i32()
    data = b[r.p:r.p + ln]; r.p += ln
    defpal = r.u32() if fmt in (41, 101) else None
    try:
        if fmt == 21:  # A8R8G8B8 stored BGRA
            a = np.frombuffer(data, np.uint8)[: w * h * 4].reshape(h, w, 4)
            img = a[:, :, [2, 1, 0, 3]].copy()
        elif fmt == 20:  # R8G8B8 stored BGR
            a = np.frombuffer(data, np.uint8)[: w * h * 3].reshape(h, w, 3)
            img = np.dstack([a[:, :, 2], a[:, :, 1], a[:, :, 0], np.full((h, w), 255, np.uint8)])
        elif fmt == 26:
            a = np.frombuffer(data, "<u2")[: w * h].reshape(h, w).astype(np.uint32)
            img = np.dstack([((a >> 8) & 15) * 17, ((a >> 4) & 15) * 17, (a & 15) * 17, ((a >> 12) & 15) * 17]).astype(np.uint8)
        elif fmt == 23:
            a = np.frombuffer(data, "<u2")[: w * h].reshape(h, w).astype(np.uint32)
            img = np.dstack([((a >> 11) & 31) * 255 // 31, ((a >> 5) & 63) * 255 // 63, (a & 31) * 255 // 31, np.full((h, w), 255)]).astype(np.uint8)
        elif fmt == 28:
            a = np.frombuffer(data, np.uint8)[: w * h].reshape(h, w)
            img = np.dstack([np.full((h, w), 255, np.uint8)] * 3 + [a])
        elif fmt in (41, 101):
            pid = palid or defpal
            pb = dat.get(pid) if pid else None
            if not pb:
                return None, "nopal"
            pr = R(pb); pr.u32(); n = pr.i32()
            pal = np.frombuffer(pb[pr.p:pr.p + 4 * n], "<u4")
            if fmt == 41:
                idx = np.frombuffer(data, np.uint8)[: w * h].reshape(h, w)
            else:
                idx = np.frombuffer(data, "<u2")[: w * h].reshape(h, w)
            c = pal[np.clip(idx, 0, n - 1)]
            img = np.dstack([(c >> 16) & 255, (c >> 8) & 255, c & 255, (c >> 24) & 255]).astype(np.uint8)
        elif fmt in (827611204, 861165636, 894720068):
            kind = {827611204: 1, 861165636: 3, 894720068: 5}[fmt]
            img = decode_dxt(data, w, h, kind)
        elif fmt == 500:
            import io
            from PIL import Image
            im = Image.open(io.BytesIO(data)).convert("RGBA")
            img = np.array(im)
        else:
            return None, f"fmt{fmt}"
    except Exception as ex:  # noqa
        return None, f"err:{ex}"
    return img, fmt


def main():
    import numpy as np
    from PIL import Image
    os.makedirs(os.path.join(OUT, "thumbs"), exist_ok=True)
    dat = Dat(DAT)
    emitters = {}
    for i in dat.ids(0x32):
        try:
            emitters[i] = parse_emitter(dat.get(i))
        except Exception as ex:
            print("emitter fail", hex(i), ex, file=sys.stderr)
    scripts = {}
    for i in dat.ids(0x33):
        try:
            _, sc = parse_script(dat.get(i)); scripts[i] = sc
        except Exception as ex:
            print("script fail", hex(i), ex, file=sys.stderr)
    tables = {}
    for i in dat.ids(0x34):
        try:
            _, t = parse_script_table(dat.get(i)); tables[i] = t
        except Exception as ex:
            print("table fail", hex(i), ex, file=sys.stderr)
    setups = {}
    bad = 0
    for i in dat.ids(0x02):
        try:
            _, s = parse_setup(dat.get(i)); setups[i] = s
        except Exception:
            bad += 1
    print(f"emitters={len(emitters)} scripts={len(scripts)} tables={len(tables)} setups={len(setups)} setupFail={bad}", file=sys.stderr)

    # reverse maps
    em_scripts = defaultdict(set)
    script_calls = defaultdict(set)  # script -> scripts it CallPES
    for sid, hooks in scripts.items():
        for h in hooks:
            if h["type"] in ("CreateParticle", "CreateBlockingParticle"):
                em_scripts[h["emitterInfo"]].add(sid)
            if h["type"] == "CallPES":
                script_calls[sid].add(h["pes"])
    script_tables = defaultdict(set)  # script -> {(table, playscriptType)}
    for tid, rows in tables.items():
        for k, lst in rows.items():
            for mod, s in lst:
                script_tables[s].add((tid, k))
    script_setups = defaultdict(set)
    em_setups_direct = defaultdict(set)
    table_setups = defaultdict(set)
    for sid, s in setups.items():
        if s["defaultScript"]:
            script_setups[s["defaultScript"]].add(sid)
        if s["defaultScriptTable"]:
            table_setups[s["defaultScriptTable"]].add(sid)
        for h in s["hooks"]:
            if h["type"] in ("CreateParticle", "CreateBlockingParticle"):
                em_setups_direct[h["emitterInfo"]].add(sid)
            if h["type"] == "DefaultScript" and s["defaultScript"]:
                pass

    gfx_cache = {}
    surf_cache = {}
    rows = []
    for eid, e in emitters.items():
        gid = e["hwGfxObj"] or e["gfxObj"]
        g = gfx_cache.get(gid)
        if g is None:
            gb = dat.get(gid)
            try:
                g = parse_gfxobj(gb) if gb else {"surfaces": [], "verts": []}
            except Exception:
                g = {"surfaces": [], "verts": []}
            gfx_cache[gid] = g
        surf = None
        tex_info = {}
        if g["surfaces"]:
            sidd = g["surfaces"][0]
            if sidd not in surf_cache:
                sb = dat.get(sidd)
                st = None
                if sb:
                    st = parse_surface(sb)
                    if "tex" in st:
                        tb = dat.get(st["tex"])
                        if tb:
                            tr = R(tb); tr.u32(); tr.i32(); tr.u8()
                            n = tr.i32(); txs = [tr.u32() for _ in range(n)]
                            st["textures"] = txs
                            if txs:
                                img, fmt = decode_texture(dat, txs[0], st.get("pal"))
                                st["fmt"] = fmt
                                if img is not None:
                                    st["w"], st["h"] = int(img.shape[1]), int(img.shape[0])
                                    a = img[:, :, 3].astype(np.float64) / 255.0
                                    rgb = img[:, :, :3].astype(np.float64)
                                    lum = (0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2])
                                    if a.sum() > 0:
                                        st["meanRGBa"] = [round(float((rgb[:, :, c] * a).sum() / a.sum()), 1) for c in range(3)]
                                    st["meanRGB"] = [round(float(rgb[:, :, c].mean()), 1) for c in range(3)]
                                    st["alphaCoverage"] = round(float(a.mean()), 3)
                                    st["meanLum"] = round(float(lum.mean()), 1)
                                    st["maxLum"] = round(float(lum.max()), 1)
                                    p = os.path.join(OUT, "thumbs", f"{sidd:08X}.png")
                                    if not os.path.exists(p):
                                        Image.fromarray(img, "RGBA").save(p)
                surf_cache[sidd] = st
            surf = surf_cache[sidd]
        vs = g.get("verts") or []
        size = None
        if vs:
            xs = [v[0] for v in vs]; ys = [v[1] for v in vs]; zs = [v[2] for v in vs]
            size = [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3), round(max(zs) - min(zs), 3)]
        scs = sorted(em_scripts.get(eid, ()))
        uses = []
        for s in scs:
            for (tid, k) in sorted(script_tables.get(s, ())):
                uses.append({"script": s, "table": tid, "playScript": k})
            for st in sorted(script_setups.get(s, ())):
                uses.append({"script": s, "setupDefault": st})
        e2 = dict(e)
        e2["gfx"] = {"id": gid, "nSurfaces": len(g["surfaces"]), "nVerts": len(vs), "size": size, "uvBounds": g.get("uvBounds"),
                     "surfaces": g["surfaces"][:4]}
        e2["surface"] = surf
        e2["scripts"] = scs
        e2["uses"] = uses[:40]
        e2["nUses"] = len(uses)
        e2["setupsDirect"] = sorted(em_setups_direct.get(eid, ()))[:20]
        rows.append(e2)

    with open(os.path.join(OUT, "emitters.json"), "w") as f:
        json.dump(rows, f)
    with open(os.path.join(OUT, "scripts.json"), "w") as f:
        json.dump({hex(k): v for k, v in scripts.items()}, f)
    with open(os.path.join(OUT, "tables.json"), "w") as f:
        json.dump({hex(k): {str(kk): vv for kk, vv in v.items()} for k, v in tables.items()}, f)
    with open(os.path.join(OUT, "setups_fx.json"), "w") as f:
        json.dump({hex(k): {"defaultScript": v["defaultScript"], "defaultScriptTable": v["defaultScriptTable"],
                            "hooks": [h for h in v["hooks"] if h["type"] in ("CreateParticle", "CreateBlockingParticle", "CallPES")]}
                   for k, v in setups.items()
                   if v["defaultScript"] or v["defaultScriptTable"] or any(h["type"] in ("CreateParticle", "CallPES") for h in v["hooks"])}, f)
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
