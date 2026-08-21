#!/usr/bin/env python3
"""4.P4 full scale-out orchestrator — all route=candidate parts with tris>=31,
exposure-ranked, in sequential batches of 200 through the POC WBT project.
Per batch: tessellate (pn level 1) -> WBT batch obj-import+export -> verify POC
invariants vs BASE -> DatRecordInsert --overwrite into the r10 work
portal -> walk_check. Stops hard on any failure. Stamps in batches/NN/DONE make
reruns resume. Never serves or ships the export tree.

NEVER --compress GfxObj (or any server-read type) inserts: vanilla ACE has no
record decompression (ACE.DatLoader reads raw zlib bytes as the record ->
CVertexArray.Unpack NotImplementedException -> server dies at boot when any
compressed 0x01 is reachable as a landblock static). --compress is safe ONLY
for types the server never reads (0x06/0x05 texture family). Found 2026-08-21:
the first scale-out landed all 1,209 parts compressed and killed ACE seconds
after "World is now open"; fixed by re-inserting uncompressed (acefix).
"""
import json, os, subprocess, sys

TOOLS = '/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch'
sys.path.insert(0, TOOLS)
HERE = os.path.dirname(os.path.abspath(__file__))
POCDIR = '/mnt/wbterminal2/dat-patch-creature-subdiv'
BASE = '/home/wbterminal/ac_base_dats/client_portal.dat'
R9 = '/mnt/wbterminal2/fill-2026-08-20/r9/client_portal_r9.dat'
R10 = '/mnt/wbterminal2/fill-2026-08-20/r9/client_portal.r10work.dat'
EXPORT = POCDIR + '/export/client_portal.dat'
WBT_DLL = '/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll'
DRI_DLL = TOOLS + '/DatRecordInsert/bin/Release/net8.0/DatRecordInsert.dll'
DOTNET = '/home/wbterminal/.local/bin/dotnet'
BATCH = 200
MIN_TRIS = 31

os.environ.setdefault('DATPATCH_PORTAL', BASE)
os.environ['DOTNET_ROLL_FORWARD'] = 'LatestMajor'
import datlib, gfxlib
import creature_tranche

done_pilot = {i['id'].lower() for i in
              json.load(open(POCDIR + '/pilot20/land-insert.json'))['inserts']}


def all_cands():
    d = json.load(open(POCDIR + '/creature-candidates.json'))
    cands = [c for c in d['candidates']
             if c['route'] == 'candidate' and c['tris'] >= MIN_TRIS
             and c['gfxObj'].lower() not in done_pilot]
    cands.sort(key=lambda c: -c['exposure'])
    return cands


def sig(recbytes):
    r = gfxlib.parse_gfxobj(recbytes)
    drawn = sum(len(q['v']) - 2 for q in r['polys'] if not (q['stip'] & 0x4))
    physsig = [(p['n'], p['sides'], tuple(p['v'])) for p in r['phys']]
    return dict(id=r['id'], drawnTris=drawn, physSig=physsig, sort=r['sort'],
                degrade=r['degrade'], surfaces=list(r['surfaces']))


def run_batch(bi, cands):
    bd = os.path.join(HERE, 'batches', '%03d' % bi)
    if os.path.exists(os.path.join(bd, 'DONE')):
        print('[batch %03d] already DONE, skip' % bi); return
    os.makedirs(bd, exist_ok=True)
    base = datlib.Dat(BASE); r9 = datlib.Dat(R9)
    picked, skipped = [], []
    for c in cands:
        gid = int(c['gfxObj'], 16)
        if base.get(gid) != r9.get(gid):
            skipped.append((c['gfxObj'], 'r9-differs')); continue
        try:
            creature_tranche.build(gid, os.path.join(bd, 'run', c['gfxObj']),
                                   op='pn', level=1)
            picked.append(c['gfxObj'])
        except SystemExit as e:
            skipped.append((c['gfxObj'], str(e)[:80]))
    lines = []
    for g in picked:
        for ln in open(os.path.join(bd, 'run', g, 'imports.jsonl')):
            j = json.loads(ln)
            if j['command'] == 'obj-import':
                lines.append(json.dumps(j))
    lines.append(json.dumps({'command': 'export', 'directory': POCDIR + '/export'}))
    ip = os.path.join(bd, 'imports.jsonl')
    open(ip, 'w').write('\n'.join(lines) + '\n')
    print('[batch %03d] tess picked=%d skipped=%d' % (bi, len(picked), len(skipped)), flush=True)

    with open(ip) as fin, open(os.path.join(bd, 'wbt.log'), 'w') as flog:
        rc = subprocess.run([DOTNET, WBT_DLL, '--stdin', '--project',
                             POCDIR + '/proj/creature.wbproj'],
                            stdin=fin, stdout=flog, stderr=flog,
                            cwd=POCDIR, timeout=7200).returncode
    if rc != 0:
        raise SystemExit('[batch %03d] WBT exit=%d' % (bi, rc))
    log = open(os.path.join(bd, 'wbt.log')).read()
    if '"success":false' in log:
        raise SystemExit('[batch %03d] WBT reported a failed command' % bi)

    exp = datlib.Dat(EXPORT)
    bindir = os.path.join(bd, 'bins'); os.makedirs(bindir, exist_ok=True)
    inserts, fails = [], []
    for g in picked:
        gid = int(g, 16)
        b, e = base.get(gid), exp.get(gid)
        sb, se = sig(b), sig(e)
        ok = (sb['id'] == se['id'] == gid and se['drawnTris'] > sb['drawnTris']
              and sb['physSig'] == se['physSig'] and sb['sort'] == se['sort']
              and sb['degrade'] == se['degrade']
              and sb['surfaces'] == se['surfaces'] and b != e)
        if ok:
            p = os.path.join(bindir, '%s.bin' % g)
            open(p, 'wb').write(e)
            inserts.append({'id': g, 'path': p})
        else:
            fails.append(g)
    if fails:
        json.dump(fails, open(os.path.join(bd, 'fails.json'), 'w'))
        raise SystemExit('[batch %03d] %d invariant failures' % (bi, len(fails)))
    mp = os.path.join(bd, 'insert.json')
    json.dump({'inserts': inserts}, open(mp, 'w'))
    r = subprocess.run([DOTNET, DRI_DLL, R10, mp, '--overwrite'],
                       capture_output=True, text=True, timeout=1800)
    open(os.path.join(bd, 'insert.log'), 'w').write(r.stdout + r.stderr)
    if r.returncode != 0 or 'mismatch=0' not in r.stdout:
        raise SystemExit('[batch %03d] insert failed rc=%d' % (bi, r.returncode))
    w = subprocess.run(['python3', TOOLS + '/walk_check.py', R10],
                       capture_output=True, text=True)
    if 'OK' not in w.stdout:
        raise SystemExit('[batch %03d] walk_check FAILED: %s' % (bi, w.stdout))
    open(os.path.join(bd, 'DONE'), 'w').write('inserted=%d\n' % len(inserts))
    print('[batch %03d] DONE inserted=%d skipped=%d walk=%s'
          % (bi, len(inserts), len(skipped), w.stdout.strip()), flush=True)


def main():
    cands = all_cands()
    print('total candidates: %d in %d batches' % (len(cands), (len(cands)+BATCH-1)//BATCH), flush=True)
    for bi in range((len(cands) + BATCH - 1) // BATCH):
        run_batch(bi, cands[bi*BATCH:(bi+1)*BATCH])
    print('ALL BATCHES DONE', flush=True)


if __name__ == '__main__':
    main()
