#!/usr/bin/env python3
"""Render a GfxObj's SHIPPED bake bytes with relief OFF (GEOM) and ON (GEOMR).

Same model, same camera, same lighting: the only variable is which of the two
co-located HBG1 payloads is drawn. Decodes per crates/holtburger-dat/src/hbg1.rs
(Hbg1Mesh stream offsets: positions f32x3, normals snorm8x4, uvs f32x2,
indices u16/u32, subsets 16 B).

Software rasteriser (numpy) — no GPU, no browser, no wasm. Shading is flat
Lambert + ambient from a fixed key light so the GEOMETRY is what differs.
"""
import os, sys, json, struct, subprocess, math
import numpy as np
from PIL import Image

GEOM, GEOMR = 0x09, 0x0C

def sec(path, ent):
    cd, off, st, raw = ent
    with open(path, "rb") as fh:
        fh.seek(off); body = fh.read(st)
    if cd == 0: return body
    return subprocess.run(["zstd","-d","-c","-q"], input=body, stdout=subprocess.PIPE, check=True).stdout

def rows(pl):
    n = struct.unpack_from("<I", pl, 0)[0]; out = {}
    for i in range(n):
        r = 4 + 16*i
        fid, enc, _p, off, size = struct.unpack_from("<IHHII", pl, r)
        out[fid] = (off, size)
    return out

def decode_mesh(p):
    assert p[:4] == b"HBG1" and p[4] == 0, "not a kind-0 HBG1 mesh"
    flags = struct.unpack_from("<H", p, 6)[0]
    mh = 16
    vc, ic = struct.unpack_from("<II", p, mh)
    sc = struct.unpack_from("<H", p, mh+8)[0]
    stream = struct.unpack_from("<I", p, mh+36)[0]
    idx_u32 = bool(flags & 0x1)          # flags::IDX_U32
    baked   = bool(flags & 0x2)          # flags::BAKED_LIGHT
    pos_off = stream
    nrm_off = pos_off + 12*vc
    uv_off  = nrm_off + 4*vc
    idx_off = uv_off + 8*vc + (4*vc if baked else 0)
    isz     = 4 if idx_u32 else 2
    sub_off = idx_off + ((isz*ic + 3) & ~3)
    pos = np.frombuffer(p, dtype="<f4", count=3*vc, offset=pos_off).reshape(vc, 3).astype(np.float64)
    nrm_raw = np.frombuffer(p, dtype=np.int8, count=4*vc, offset=nrm_off).reshape(vc, 4)[:, :3]
    nrm = np.maximum(nrm_raw.astype(np.float64)/127.0, -1.0)
    idx = np.frombuffer(p, dtype=("<u4" if idx_u32 else "<u2"), count=ic, offset=idx_off).astype(np.int64)
    subs = []
    for s in range(sc):
        o = sub_off + s*16
        surf, = struct.unpack_from("<I", p, o)
        first, count = struct.unpack_from("<II", p, o+8)
        subs.append((surf, first, count))
    return dict(pos=pos, nrm=nrm, idx=idx, subs=subs, vc=vc, ic=ic)

# ---- rasteriser -----------------------------------------------------------
def render(mesh, eye, target, up, fov_deg, W, H, palette):
    pos, idx = mesh["pos"], mesh["idx"]
    f = np.array(target, float) - np.array(eye, float)
    f /= np.linalg.norm(f)
    r = np.cross(f, np.array(up, float)); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    M = np.stack([r, u, -f])                       # world -> view
    V = (pos - np.array(eye, float)) @ M.T
    tanh = math.tan(math.radians(fov_deg)/2.0)
    aspect = W/float(H)
    zc = -V[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        sx = (V[:, 0]/(zc*tanh*aspect)*0.5 + 0.5)*W
        sy = (0.5 - V[:, 1]/(zc*tanh)*0.5)*H
    color = np.zeros((H, W, 3), np.float64)
    color[:, :] = (0.09, 0.10, 0.13)
    depth = np.full((H, W), np.inf)
    key = np.array([0.45, 0.62, 0.65]); key /= np.linalg.norm(key)

    surf_of_tri = np.zeros(len(idx)//3, np.int64)
    for si, (surf, first, count) in enumerate(mesh["subs"]):
        surf_of_tri[first//3:(first+count)//3] = si

    for t in range(len(idx)//3):
        a, b, c = idx[3*t], idx[3*t+1], idx[3*t+2]
        if zc[a] <= 0.05 or zc[b] <= 0.05 or zc[c] <= 0.05: continue
        x0, y0 = sx[a], sy[a]; x1, y1 = sx[b], sy[b]; x2, y2 = sx[c], sy[c]
        area = (x1-x0)*(y2-y0) - (x2-x0)*(y1-y0)
        if abs(area) < 1e-9: continue
        e0 = np.clip(int(math.floor(min(x0, x1, x2))), 0, W-1)
        e1 = np.clip(int(math.ceil (max(x0, x1, x2))), 0, W-1)
        e2 = np.clip(int(math.floor(min(y0, y1, y2))), 0, H-1)
        e3 = np.clip(int(math.ceil (max(y0, y1, y2))), 0, H-1)
        if e1 < e0 or e3 < e2: continue
        xs = np.arange(e0, e1+1); ys = np.arange(e2, e3+1)
        px, py = np.meshgrid(xs+0.5, ys+0.5)
        w0 = ((x1-x0)*(py-y0) - (px-x0)*(y1-y0))/area
        w1 = ((px-x0)*(y2-y0) - (x2-x0)*(py-y0))/area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any(): continue
        z = w2*zc[a] + w1*zc[b] + w0*zc[c]
        # geometric normal (rails inherit the parent surface but sit at their
        # own angle — that is the whole point of the pair)
        n = np.cross(pos[b]-pos[a], pos[c]-pos[a])
        ln = np.linalg.norm(n)
        n = n/ln if ln > 1e-12 else (mesh["nrm"][a])
        lam = abs(float(np.dot(n, key)))
        base = np.array(palette[surf_of_tri[t] % len(palette)], float)
        shade = base*(0.26 + 0.74*lam)
        sub = depth[e2:e3+1, e0:e1+1]
        m = inside & (z < sub)
        if not m.any(): continue
        sub[m] = z[m]
        cslice = color[e2:e3+1, e0:e1+1]
        cslice[m] = shade
    return np.clip(color, 0, 1), depth

PALETTE = [(0.74,0.68,0.58),(0.62,0.50,0.40),(0.55,0.58,0.62),(0.70,0.60,0.46),
           (0.48,0.52,0.45),(0.66,0.62,0.56),(0.58,0.46,0.38),(0.72,0.70,0.64),
           (0.50,0.55,0.58),(0.64,0.56,0.48),(0.60,0.64,0.56),(0.68,0.58,0.50),
           (0.52,0.48,0.44),(0.76,0.72,0.62),(0.56,0.60,0.64)]

def main():
    did = int(sys.argv[1], 16)
    outdir = sys.argv[2]
    W = int(os.environ.get("W", 1100)); H = int(os.environ.get("H", 800))
    idx = json.load(open("/tmp/s12/pack-index.json"))
    src = None
    for p, pk, origin, secs in idx:
        secs = {int(k): v for k, v in secs.items()}
        if GEOMR not in secs or GEOM not in secs: continue
        rr = rows(sec(p, secs[GEOMR][0:1]+secs[GEOMR][1:]))
        if did in rr:
            gg = rows(sec(p, secs[GEOM]))
            if did in gg:
                src = (p, secs, gg[did], rr[did]); break
    if not src:
        print("no co-located default+variant row for 0x%08X" % did); sys.exit(2)
    path, secs, (goff, gsize), (roff, rsize) = src
    gp = sec(path, secs[GEOM]); rp = sec(path, secs[GEOMR])
    flat = decode_mesh(gp[goff:goff+gsize])
    relf = decode_mesh(rp[roff:roff+rsize])
    print("0x%08X  pack=%s" % (did, os.path.basename(path)))
    print("  relief OFF: %d verts %d tris %d subsets" % (flat["vc"], flat["ic"]//3, len(flat["subs"])))
    print("  relief ON : %d verts %d tris %d subsets" % (relf["vc"], relf["ic"]//3, len(relf["subs"])))

    lo = flat["pos"].min(axis=0); hi = flat["pos"].max(axis=0)
    ctr = (lo+hi)/2.0; ext = hi-lo
    diag = float(np.linalg.norm(ext))
    # street-level three-quarter view, framed on the model
    dist = float(os.environ.get("DIST", diag*0.85))
    az = math.radians(float(os.environ.get("AZ", 38)))
    el = math.radians(float(os.environ.get("EL", 12)))
    eye = [ctr[0]+dist*math.cos(el)*math.cos(az),
           ctr[1]+dist*math.cos(el)*math.sin(az),
           ctr[2]+dist*math.sin(el)]
    fov = float(os.environ.get("FOV", 45))
    os.makedirs(outdir, exist_ok=True)
    imgs = {}
    for name, mesh in (("relief-off", flat), ("relief-on", relf)):
        col, _d = render(mesh, eye, list(ctr), [0,0,1], fov, W, H, PALETTE)
        imgs[name] = col
        Image.fromarray((col*255).astype(np.uint8)).save(
            os.path.join(outdir, "s12-gfxobj-%08X-%s.png" % (did, name)))
    d = np.abs(imgs["relief-on"] - imgs["relief-off"]).max(axis=2)
    changed = float((d > 8/255.0).mean()*100.0)
    heat = np.zeros_like(imgs["relief-on"])
    heat[..., 0] = np.clip(d*4, 0, 1)
    heat[..., 1] = np.clip(d*1.2, 0, 1)
    base = imgs["relief-off"]*0.35
    Image.fromarray((np.clip(base+heat, 0, 1)*255).astype(np.uint8)).save(
        os.path.join(outdir, "s12-gfxobj-%08X-diff.png" % did))
    print("  eye=%s  target=%s  fov=%g  dist=%.1f m" % ([round(v,2) for v in eye], [round(float(v),2) for v in ctr], fov, dist))
    print("  PIXELS DIFFERING > 8/255: %.2f %%" % changed)
    print("  wrote %s/s12-gfxobj-%08X-{relief-off,relief-on,diff}.png" % (outdir, did))

main()
