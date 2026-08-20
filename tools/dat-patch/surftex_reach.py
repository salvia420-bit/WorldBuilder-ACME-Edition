#!/usr/bin/env python3
"""surftex_reach.py — the CPU-blit safety gate for highres 0x06 fills.

A 0x06 RenderSurface is safe to re-encode (DXT/upscale) ONLY if the client
consumes it through the GPU 3D pipeline, i.e. it is referenced by some 0x05
SurfaceTexture. Everything else (icons, char-gen portraits, banners, splash
and loading art, UI backgrounds) is CPU-blitted by SurfaceWindow::LegacyBlit,
which cannot decode DXT and overruns on resized records -> deterministic
0xC0000005 at fault offset 0x420a0 at char-select (the r9 crash, 2026-08-20,
twice: first the icon tiers, then the size-classified "world" tier's 493
UI-art records).

Size is NOT a safe classifier: 320x480 portraits and 1200x600 backgrounds
pass a ">=128^2 world surface" filter and still CPU-blit. Reachability is.

The one sanctioned exception: ids in the retail EoR client_highres.dat
(Turbine shipped those highres; the retail client mounts that dat natively),
even when not 0x05-reachable — r8 == that set and gated clean.

0x05 layout per ACE SurfaceTexture.cs (id u32, i32, u8, count u32, count*u32);
alternates are probed defensively and every parsed ref must be a 0x06/0x07 id.

usage: surftex_reach.py <fill.dat> [--portal base_portal.dat]
                        [--allow eor_highres.dat] [--out drops.txt]
prints the not-reachable ids; --out writes them 0x-hex one per line
(DatCompact --exclude format). Exit 1 if any drop is found.
"""
import argparse, struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datlib

ap = argparse.ArgumentParser()
ap.add_argument('fill_dat')
ap.add_argument('--portal', default=os.path.expanduser('~/ac_base_dats/client_portal.dat'))
ap.add_argument('--allow', help='dat whose 0x06 ids are exempt (retail EoR highres)')
ap.add_argument('--out', help='write drop ids here, 0x-hex one per line')
args = ap.parse_args()

p = datlib.Dat(args.portal)
stex = [i for i in p.files if (i >> 24) == 0x05]
S = set()
bad = []
for sid in stex:
    b = p.get(sid)
    for hdr in (9, 8, 12, 13):
        if len(b) < hdr + 4:
            continue
        (n,) = struct.unpack_from('<I', b, hdr)
        if 1 <= n <= 64 and hdr + 4 + 4 * n == len(b):
            ids = struct.unpack_from('<%dI' % n, b, hdr + 4)
            if all(0x06000000 <= t <= 0x07FFFFFF for t in ids):
                S.update(ids)
                break
    else:
        bad.append(sid)
if bad:
    print('WARNING: %d SurfaceTexture records failed to parse: %s' %
          (len(bad), ' '.join('%08x' % x for x in bad[:8])), file=sys.stderr)

allow = set()
if args.allow:
    allow = {i for i in datlib.Dat(args.allow).files if (i >> 24) == 0x06}

f = datlib.Dat(args.fill_dat)
fill = [i for i in f.files if (i >> 24) == 0x06]
drops = sorted(i for i in fill if i not in S and i not in allow)
print('surfacetextures=%d reachable=%d allow=%d fill=%d NOT_SAFE=%d'
      % (len(stex), len(S), len(allow), len(fill), len(drops)))
for i in drops:
    b = f.get(i)
    w, h, fmt = struct.unpack_from('<3I', b, 8)
    print('  0x%08X  %dx%d fmt=0x%X' % (i, w, h, fmt))
if args.out:
    with open(args.out, 'w') as fh:
        for i in drops:
            fh.write('0x%08X\n' % i)
sys.exit(1 if drops else 0)
