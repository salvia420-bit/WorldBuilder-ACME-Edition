"""audit_degrade_chain.py — F1: did the lanes replace every RenderSurface in each
SurfaceTexture's degrade chain, or only the high entry?

SurfaceTexture (0x05) records list one or more RenderSurfaces (0x06) — a
low->high degrade chain. The client can serve a lower entry at distance or at
reduced texture-quality, so an upscaled high entry with a retail low sibling
falls back to retail pixels in exactly those cases.

For every Surface (0x08) id in the r7 lane lists: resolve Surface ->
OrigTextureId (SurfaceTexture) -> textures[] against RETAIL, then check each
listed RS against the union of the r7 lane baked/ dirs.

usage: python3 audit_degrade_chain.py [--out report.json]
"""
import glob
import json
import os
import subprocess
import sys

WBT = '/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll'
DAT = '/home/wbterminal/ac_base_dats/client_portal.dat'
R7 = '/mnt/wbterminal2/dat-patch-r7'
RUN = ['/home/wbterminal/.local/bin/dotnet', WBT, '--stdin']


def wbt(cmds):
    env = dict(os.environ, DOTNET_ROLL_FORWARD='LatestMajor')
    inp = '\n'.join(json.dumps(c) for c in cmds) + '\n'
    p = subprocess.run(RUN, input=inp, capture_output=True, text=True, env=env,
                       timeout=3600)
    out = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def main():
    outp = None
    if '--out' in sys.argv:
        outp = sys.argv[sys.argv.index('--out') + 1]

    lanes = {}
    for f in glob.glob(f'{R7}/*/ids_r7.txt'):
        lane = f.split('/')[-2]
        lanes[lane] = [l.strip() for l in open(f) if l.strip()]

    baked = set()
    for d in glob.glob(f'{R7}/*/baked'):
        for p in os.listdir(d):
            if p.endswith('.png'):
                baked.add(int(p[:-4], 16))
    print(f'lanes: {{k: len(v) for k, v in lanes.items()}} -> '
          f'{ {k: len(v) for k, v in lanes.items()} }; baked union: {len(baked)}')

    all_sids = sorted({s for v in lanes.values() for s in v})
    res = wbt([{"command": "chorizite-parse-dat-record", "datPath": DAT,
                "idHex": s, "typeName": "Surface"} for s in all_sids])
    sid2st = {}
    for s, r in zip(all_sids, res):
        f = r.get('fields', {})
        ot = f.get('origTextureId')
        if isinstance(ot, dict) and ot.get('dataId'):
            sid2st[s] = ot['dataId']
    print(f'surfaces with a texture: {len(sid2st)}/{len(all_sids)}')

    sts = sorted(set(sid2st.values()))
    res = wbt([{"command": "chorizite-parse-dat-record", "datPath": DAT,
                "idHex": "0x%08X" % st, "typeName": "SurfaceTexture"} for st in sts])
    st2tex = {}
    for st, r in zip(sts, res):
        tex = [t['dataId'] if isinstance(t, dict) else t
               for t in r.get('fields', {}).get('textures', [])]
        st2tex[st] = tex

    per_lane = {}
    examples = []
    for lane, sids in lanes.items():
        full = partial = none = notex = 0
        for s in sids:
            st = sid2st.get(s)
            if st is None:
                notex += 1
                continue
            tex = st2tex.get(st, [])
            hit = [t for t in tex if t in baked]
            miss = [t for t in tex if t not in baked]
            if not hit:
                none += 1
            elif miss:
                partial += 1
                if len(examples) < 30:
                    examples.append(dict(lane=lane, surface=s,
                                         surfacetexture='0x%08X' % st,
                                         baked=['0x%08X' % t for t in hit],
                                         retail_left=['0x%08X' % t for t in miss]))
            else:
                full += 1
        per_lane[lane] = dict(ids=len(sids), full=full, partial=partial,
                              none_baked=none, no_texture=notex)
        print(lane, per_lane[lane])

    chains = {}
    for st, tex in st2tex.items():
        chains[len(tex)] = chains.get(len(tex), 0) + 1
    print('chain-length histogram (SurfaceTextures):', dict(sorted(chains.items())))

    if outp:
        json.dump(dict(per_lane=per_lane, chain_hist=chains,
                       examples=examples), open(outp, 'w'), indent=1)
        print('->', outp)


if __name__ == '__main__':
    main()
