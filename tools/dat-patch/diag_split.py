"""diag_split.py -- separate the geometry lane's luminance cost from the
texture lane's.  Four renders at ONE camera/light:
   G0T0 retail geo + retail tex        G0T1 retail geo + baked Remacri
   G1T0 arm-C geo  + retail tex        G1T1 arm-C geo  + baked Remacri
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np

import matlib
HERE = "/mnt/wbterminal2/dat-patch-legibility/"
matlib.CACHE = HERE + "hcache/"
matlib.DBCACHE = HERE + "dbcache/"

import legibility
import legboards as LB
import ladder
import pipeline
import relief3d

gid = int(sys.argv[1], 16)
gs = sys.argv[2] if len(sys.argv) > 2 else "mid"
G = legibility.GAINSETS[gs]
rec = pipeline.P.gfx(gid)
metasA, _ = ladder.build_metas(rec, "A")
srcA = relief3d.SourceMesh.from_record(rec, metasA)
texB, _ = pipeline.load_textures(metasA, remacri=False, max_side=1024)
before = pipeline.original(srcA)
keysB = pipeline.face_surface(srcA, before["poly"])

src, metas, h_full, res = ladder.build_arm(rec, "C")
texR, _ = pipeline.load_textures(metas, remacri=True, max_side=1024)
texA, infos = legibility.bake_all(texR, texB, metas, h_full,
                                  G["g_hi"], G["g_lo"], G["a0"])
keysA = pipeline.face_surface(src, res["poly"])
cams = LB.cameras(srcA)
os.makedirs(HERE + "diag/", exist_ok=True)
for cname in ("hero", "detail", "graze"):
    cam = cams[cname]
    size = (760, 520)
    combos = [("G0T0", before, keysB, texB), ("G0T1", before, keysB, texA),
              ("G1T0", res, keysA, texB), ("G1T1", res, keysA, texA)]
    ls = {}
    for tag, mesh, k, t in combos:
        im = LB.rend(mesh, k, t, cam, size)
        im.save(HERE + "diag/%s_%s_%s_%s.png" % ("0x%08X" % gid, gs, cname, tag))
        ls[tag] = LB.panel_lum(im, LB.SKY)
    print("%-7s  G0T0 %.4f | G0T1 %+.1f%% | G1T0 %+.1f%% | G1T1 %+.1f%%"
          % (cname, ls["G0T0"],
             100 * (ls["G0T1"] / ls["G0T0"] - 1),
             100 * (ls["G1T0"] / ls["G0T0"] - 1),
             100 * (ls["G1T1"] / ls["G0T0"] - 1)))
