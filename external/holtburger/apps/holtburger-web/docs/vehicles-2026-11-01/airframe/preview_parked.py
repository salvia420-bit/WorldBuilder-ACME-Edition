import json, sys, math
import numpy as np
from PIL import Image, ImageDraw
import acmodel
d = json.load(open(sys.argv[1]))
th = math.radians(d["gearPitch"]); my = d["mainY"]
qp = (math.cos(th/2), math.sin(th/2), 0, 0)   # nose up about +x
def tilt(off):
    y, z = off[1]-my, off[2]
    return [off[0], my + y*math.cos(th) - z*math.sin(th), y*math.sin(th) + z*math.cos(th)]
parts=[]
for p in d["parts"]:
    parts.append(dict(did=p["did"], offset=tilt(p["offset"]), rot=list(acmodel.qmul(qp, p["rot"])), scale=p["scale"]))
st = tilt(d["seat"])
parts.append(dict(did=0x02000001, offset=st, rot=[1,0,0,0], scale=1.0, tint=(0.9,0.2,0.2)))
# ground plane reference: a thin quad via the crystal panel lying flat? just print min z
V, F, C = acmodel.composite(parts)
print("parked min z %.3f  hub z %.2f" % (V[:,2].min(), tilt(d["hub"])[2]))
size=520
ims=[acmodel.render(V,F,C,v,size) for v in ("side","iso")]
W=Image.new("RGB",(size*2,size))
for i,im in enumerate(ims): W.paste(im,(i*size,0))
W.save(sys.argv[2])
