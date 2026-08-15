"""rebuild_boards.py -- recompose the phone boards from the saved raw panels
(no re-render), with header/footer text that fits 1080 px."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image

import matlib
HERE = "/mnt/wbterminal2/dat-patch-legibility/"
matlib.CACHE = HERE + "hcache/"
matlib.DBCACHE = HERE + "dbcache/"
import legboards as LB
import legibility

CAP = {"hero": "a.  whole building, 3/4 view",
       "detail": "b.  close crop, window / door scale",
       "graze": "c.  grazing view down a wall"}

for gid in sys.argv[1:]:
    name = gid
    gs = "mid"
    G = legibility.GAINSETS[gs]
    pairs = []
    for f in ("hero", "detail", "graze"):
        A = Image.open(LB.OUT + "raw_%s_%s_%s_before.png" % (name, gs, f)).convert("RGB")
        B = Image.open(LB.OUT + "raw_%s_%s_%s_after.png" % (name, gs, f)).convert("RGB")
        pairs.append((CAP[f], A, B, LB.panel_lum(A, LB.SKY), LB.panel_lum(B, LB.SKY)))
    infos = json.load(open(LB.OUT + "lum_%s_%s.json" % (name, gs)))
    emb = [v for v in infos.values() if v["embossed"]]
    rat = sum(v["lum_after"] / v["lum_base"] for v in emb) / max(len(emb), 1)
    LB.board("board_%s_%s.png" % (name, gs),
             "%s   TODAY vs PATCHED" % name,
             "legibility bake  g_hi %.2f  g_lo %.2f  a0 %.2f   |   geometry 4x + "
             "sculpted normals" % (G["g_hi"], G["g_lo"], G["a0"]),
             pairs,
             "same camera, same daylight on both panels.  %d carved textures, "
             "%+.0f%% brighter than retail." % (len(emb), 100 * (rat - 1)))
