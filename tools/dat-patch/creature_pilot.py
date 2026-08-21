#!/usr/bin/env python3
"""4.P4 pilot tranche driver — top-20 exposure candidates, POC parameters
(pn level 1), batched through the existing POC WBT project, verified
per-part with the POC invariants, landed into the r10 work portal via
DatRecordInsert (never shipping the export portal itself — it is only the
record-encoding intermediary; the 2026-08-21 eye-test session proved the
export tree must not be served).

Stages (rerunnable; each writes a stamp file):
  tess    — pick candidates, tessellate, write merged imports.jsonl
  (then run WBT manually / from the orchestrator)
  land    — verify invariants vs BASE per part, write bins + manifest
"""
import json, os, sys, subprocess

TOOLS = '/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch'
sys.path.insert(0, TOOLS)
HERE = os.path.dirname(os.path.abspath(__file__))
POCDIR = '/mnt/wbterminal2/dat-patch-creature-subdiv'
BASE = '/home/wbterminal/ac_base_dats/client_portal.dat'
R9 = '/mnt/wbterminal2/fill-2026-08-20/r9/client_portal_r9.dat'
EXPORT = POCDIR + '/export/client_portal.dat'
N = 20
MIN_TRIS = 31

os.environ.setdefault('DATPATCH_PORTAL', BASE)
import datlib, gfxlib
import creature_tranche


def pick():
    d = json.load(open(POCDIR + '/creature-candidates.json'))
    cands = [c for c in d['candidates']
             if c['route'] == 'candidate' and c['tris'] >= MIN_TRIS
             and c['gfxObj'].lower() != '0x01002c00']
    cands.sort(key=lambda c: -c['exposure'])
    return cands[:N]


def tess():
    base = datlib.Dat(BASE)
    r9 = datlib.Dat(R9)
    picked, skipped = [], []
    for c in pick():
        gid = int(c['gfxObj'], 16)
        if base.get(gid) != r9.get(gid):
            skipped.append((c['gfxObj'], 'r9 record differs from retail'))
            continue
        wd = os.path.join(HERE, 'run', c['gfxObj'])
        try:
            creature_tranche.build(gid, wd, op='pn', level=1)
            picked.append(c)
        except SystemExit as e:
            skipped.append((c['gfxObj'], str(e)))
    lines = []
    for c in picked:
        wd = os.path.join(HERE, 'run', c['gfxObj'])
        for ln in open(os.path.join(wd, 'imports.jsonl')):
            j = json.loads(ln)
            if j['command'] == 'obj-import':
                lines.append(json.dumps(j))
    lines.append(json.dumps({'command': 'export', 'directory': POCDIR + '/export'}))
    with open(os.path.join(HERE, 'imports.jsonl'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    json.dump({'picked': [c['gfxObj'] for c in picked], 'skipped': skipped},
              open(os.path.join(HERE, 'tess.json'), 'w'), indent=1)
    print('tessellated=%d skipped=%d -> imports.jsonl (%d obj-imports + export)'
          % (len(picked), len(skipped), len(lines) - 1))
    for s in skipped:
        print('  SKIP', s)


def sig(recbytes):
    r = gfxlib.parse_gfxobj(recbytes)
    drawn = sum(len(q['v']) - 2 for q in r['polys'] if not (q['stip'] & 0x4))
    physsig = [(p['n'], p['sides'], tuple(p['v'])) for p in r['phys']]
    return dict(id=r['id'], drawnTris=drawn,
                nPhys=len(r['phys']), physSig=physsig, sort=r['sort'],
                degrade=r['degrade'], surfaces=list(r['surfaces']))


def land():
    picked = json.load(open(os.path.join(HERE, 'tess.json')))['picked']
    base = datlib.Dat(BASE)
    exp = datlib.Dat(EXPORT)
    bindir = os.path.join(HERE, 'bins'); os.makedirs(bindir, exist_ok=True)
    inserts, fails = [], []
    for g in picked:
        gid = int(g, 16)
        b, e = base.get(gid), exp.get(gid)
        sb, se = sig(b), sig(e)
        checks = dict(
            id=(sb['id'] == se['id'] == gid),
            drawnIncreased=(se['drawnTris'] > sb['drawnTris']),
            physIdentical=(sb['physSig'] == se['physSig']),
            sort=(sb['sort'] == se['sort']),
            degrade=(sb['degrade'] == se['degrade']),
            surfaces=(sb['surfaces'] == se['surfaces']),
            changed=(b != e))
        if all(checks.values()):
            p = os.path.join(bindir, '%s.bin' % g)
            open(p, 'wb').write(e)
            inserts.append({'id': g, 'path': p,
                            'tris': '%d->%d' % (sb['drawnTris'], se['drawnTris'])})
        else:
            fails.append({'gid': g, 'checks': checks})
    # include the POC Banderling record (already eye-tested)
    inserts.append({'id': '0x01002C00', 'path': POCDIR + '/subdiv-01002C00.bin',
                    'tris': '78->312 (POC, eye-tested)'})
    json.dump({'inserts': [{'id': i['id'], 'path': i['path']} for i in inserts]},
              open(os.path.join(HERE, 'land-insert.json'), 'w'), indent=1)
    json.dump({'inserts': inserts, 'fails': fails},
              open(os.path.join(HERE, 'land.json'), 'w'), indent=1)
    print('verified=%d fails=%d -> land-insert.json' % (len(inserts), len(fails)))
    for f in fails:
        print('  FAIL', f['gid'], {k: v for k, v in f['checks'].items() if not v})


if __name__ == '__main__':
    {'tess': tess, 'land': land}[sys.argv[1]]()
