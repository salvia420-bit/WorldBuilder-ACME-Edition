#!/usr/bin/env python3
"""
make_askytex.py -- convert a PNG (RGBA) into the AcmeSky raw-texture container (.askytex).

WHY A RAW CONTAINER: the AcmeSky plugin is injected into the retail acclient.exe, a
locked-down fixed-function D3D9 process. We do NOT want to drag a managed PNG decoder
(ImageSharp / System.Drawing) into that process just to upload a handful of sky textures.
So textures are pre-decoded here, offline, into a trivial byte layout the plugin can
memcpy straight into a D3DFMT_A8R8G8B8 LockRect. Zero runtime image dependency.

CONTAINER LAYOUT (little-endian):
    offset 0  : 8 bytes  magic  = "ASKYTEX1"
    offset 8  : uint32   width
    offset 12 : uint32   height
    offset 16 : uint32   format = 1  (1 = BGRA8, matches D3DFMT_A8R8G8B8 in-memory byte order)
    offset 20 : width*height*4 bytes, rows top-to-bottom, each pixel B,G,R,A

USAGE:
    make_askytex.py <in.png> <out.askytex> [--size WxH]
"""
import sys, struct
from PIL import Image

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = {a.split("=")[0]: (a.split("=")[1] if "=" in a else True)
            for a in sys.argv[1:] if a.startswith("--")}
    if len(args) < 2:
        print(__doc__); sys.exit(2)
    src, dst = args[0], args[1]

    im = Image.open(src).convert("RGBA")
    if "--size" in opts and opts["--size"] is not True:
        w, h = (int(x) for x in opts["--size"].lower().split("x"))
        im = im.resize((w, h), Image.LANCZOS)
    w, h = im.size

    # PIL gives R,G,B,A per pixel; D3DFMT_A8R8G8B8 wants B,G,R,A bytes.
    r, g, b, a = im.split()
    bgra = Image.merge("RGBA", (b, g, r, a))
    payload = bgra.tobytes()

    with open(dst, "wb") as f:
        f.write(b"ASKYTEX1")
        f.write(struct.pack("<III", w, h, 1))
        f.write(payload)
    print(f"wrote {dst}: {w}x{h} BGRA8 ({len(payload)} bytes payload)")

if __name__ == "__main__":
    main()
