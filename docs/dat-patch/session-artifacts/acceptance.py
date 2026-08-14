#!/usr/bin/env python3
"""Acceptance suite for relief-plan-apply (A: cottage reproduction, B: import proof,
C: generality on house 0x01002232, D: negative test)."""
import json, os, subprocess, sys, glob

SP = '/tmp/claude-1000/-home-wbterminal/94a02f09-ac53-481f-a837-f8637f0b22f9/scratchpad'
RG = SP + '/reliefgen'
DLL = '/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll'
PROJ = '/home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj'
SUM_COTTAGE = SP + '/regionsum/cottage_0100082E.json'
EXPORT_DIR = '/mnt/wbterminal2/dat-patch-reliefgen'

def run_terminal(cmds, label):
    inp = '\n'.join(json.dumps(c) for c in cmds) + '\n'
    env = dict(os.environ, DOTNET_ROLL_FORWARD='LatestMajor')
    p = subprocess.run(['dotnet', DLL, '--stdin'], input=inp, capture_output=True,
                       text=True, env=env, timeout=900)
    outs = []
    for ln in p.stdout.splitlines():
        ln = ln.strip()
        if ln.startswith('{'):
            try: outs.append(json.loads(ln))
            except json.JSONDecodeError: pass
    if len(outs) < len(cmds):
        print(f'[{label}] WARNING: {len(outs)} responses for {len(cmds)} commands; stderr tail:')
        print(p.stderr[-2000:])
    return outs

def show(label, r, keys):
    print(f'  [{label}] ' + ' '.join(f'{k}={r.get(k)}' for k in keys if k in r))

results = {}

# ══ A ══ cottage reproduction ════════════════════════════════════════
print('═══ A. cottage reproduction ═══')
outs = run_terminal([
    {'command': 'load', 'path': PROJ},
    {'command': 'obj-export', 'datId': '0x0100082E', 'outputPath': RG + '/cottage.obj'},
    {'command': 'relief-plan-apply', 'summaryPath': SUM_COTTAGE, 'planPath': RG + '/cottage_plan.json',
     'objPath': RG + '/cottage.obj', 'outObjPath': RG + '/cottage_relief.obj',
     'checksReport': RG + '/cottage_checks.json'},
], 'A')
apply_r = outs[-1]
show('apply', apply_r, ['success', 'addedTris', 'totalTris', 'checksPassed', 'checksFailed', 'error'])
checks = json.load(open(RG + '/cottage_checks.json'))
print('  gate checks:')
for c in checks['checks']:
    print(f"    {'PASS' if c['pass'] else 'FAIL'}  {c['name']:32s} {c['detail']}")
added = apply_r.get('addedTris', 0)
a_ok = (apply_r.get('success') is True
        and all(c['pass'] for c in checks['checks'])
        and abs(added - 102) <= 0.4 * 102)
print(f'  added tris: {added} (trial: 102, ±40% band 61..143) → {"OK" if a_ok else "OUT OF BAND"}')
# byte-prefix double check from this side too
orig = open(RG + '/cottage.obj', 'rb').read()
out = open(RG + '/cottage_relief.obj', 'rb').read()
a_ok = a_ok and out[:len(orig)] == orig
results['A'] = a_ok
print(f'A: {"PASS" if a_ok else "FAIL"}')

# ══ renders ══ (reference render.py, functions only)
print('─── renders (reference render.py) ───')
src = open(SP + '/render.py', encoding='utf-8').read()
render_fns = src.split("views=")[0]
ns = {}
exec(compile(render_fns, 'render.py', 'exec'), ns)
render = ns['render']
os.chdir(RG)
from PIL import Image
views = [('front-left', (-0.75, -1.0, 0.42)), ('right-chimney', (1.0, -0.55, 0.38)),
         ('back-right', (0.8, 0.85, 0.35))]
tiles = []
n_orig = 90
for name, eye in views:
    a = render('cottage.obj', eye)
    b = render('cottage_relief.obj', eye)
    c = render('cottage_relief.obj', eye, newfrom=n_orig)
    row = Image.new('RGB', (620 * 3 + 16, 620), (12, 14, 18))
    row.paste(a, (0, 0)); row.paste(b, (628, 0)); row.paste(c, (1256, 0))
    tiles.append(row)
outimg = Image.new('RGB', (620 * 3 + 16, 620 * 3 + 16), (12, 14, 18))
for k, t in enumerate(tiles):
    outimg.paste(t, (0, k * 628))
outimg.save(RG + '/cottage_relief_preview.png')
print('  wrote', RG + '/cottage_relief_preview.png',
      '(rows: front-left / right+chimney / back-right; cols: original | relief | new-faces-highlighted)')

# ══ B ══ import proof ════════════════════════════════════════════════
print('═══ B. import proof ═══')
outs = run_terminal([
    {'command': 'load', 'path': PROJ},
    {'command': 'relief-plan-apply', 'summaryPath': SUM_COTTAGE, 'planPath': RG + '/cottage_plan.json',
     'objPath': RG + '/cottage.obj', 'outObjPath': RG + '/cottage_relief_imported.obj',
     'checksReport': RG + '/cottage_checks_import.json', 'import': True},
    {'command': 'export', 'directory': EXPORT_DIR},
], 'B')
imp_r, exp_r = outs[-2], outs[-1]
show('apply+import', imp_r, ['success', 'imported', 'importTriCount', 'importPreservedPhysics', 'error'])
show('export', exp_r, ['success', 'error', 'directory', 'iteration'])
dats = sorted(glob.glob(EXPORT_DIR + '/**/client_portal.dat', recursive=True), key=os.path.getmtime)
b_ok = imp_r.get('success') is True and imp_r.get('imported') is True
if not dats:
    print('  no exported client_portal.dat found under', EXPORT_DIR); b_ok = False
else:
    dat = dats[-1]
    print('  exported portal dat:', dat)
    outs2 = run_terminal([
        {'command': 'chorizite-parse-dat-record', 'datPath': dat, 'idHex': '0x0100082E', 'typeName': 'GfxObj'},
    ], 'B-parse')
    pr = outs2[-1]
    ok = pr.get('success', False)
    rec = pr.get('fields') or {}
    phys = rec.get('physicsPolygons')
    polys = rec.get('polygons')
    n_phys = len(phys) if isinstance(phys, (list, dict)) else None
    n_poly = len(polys) if isinstance(polys, (list, dict)) else None
    print(f'  parse success={ok} renderPolys={n_poly} physicsPolys={n_phys} (physics must be 59)')
    b_ok = b_ok and ok and n_phys == 59 and (n_poly or 0) >= 150
results['B'] = b_ok
print(f'B: {"PASS" if b_ok else "FAIL"}')

# ══ C ══ generality: house 0x01002232, plinth only ═══════════════════
print('═══ C. generality (house 0x01002232) ═══')
outs = run_terminal([
    {'command': 'load', 'path': PROJ},
    {'command': 'gfxobj-region-summary', 'datId': '0x01002232', 'outputPath': RG + '/house_summary.json',
     'thumbnails': False},
    {'command': 'obj-export', 'datId': '0x01002232', 'outputPath': RG + '/house.obj'},
], 'C-prep')
hsum = json.load(open(RG + '/house_summary.json'))
zmin = hsum['bbox'][0][2]
ground_regions = []
for r in hsum['regions']:
    if r.get('loopsFailed') or not r.get('outer'): continue
    n = r['plane']['n']
    if abs(n[2]) > 0.2: continue
    if r['uvMap'].get('residual', 1) > 0.01: continue
    o, U, V = r['basis']['origin'], r['basis']['uAxis'], r['basis']['vAxis']
    zs = [o[2] + u * U[2] + v * V[2] for (u, v) in r['outer']]
    if min(zs) < zmin + 1e-3:
        ground_regions.append(r['id'])
print('  ground-storey wall regions:', ground_regions)
json.dump({'gfxObj': '0x01002232',
           'features': [{'op': 'plinth', 'regions': ground_regions, 'proud': 0.10,
                         'height': 0.35, 'material': 'inherit', 'breakAtGroundHoles': True}],
           'budget': {'maxTris': 200, 'maxOffset': 0.20}},
          open(RG + '/house_plan.json', 'w'), indent=1)
outs = run_terminal([
    {'command': 'relief-plan-apply', 'summaryPath': RG + '/house_summary.json',
     'planPath': RG + '/house_plan.json', 'objPath': RG + '/house.obj',
     'outObjPath': RG + '/house_relief.obj', 'checksReport': RG + '/house_checks.json'},
], 'C')
hr = outs[-1]
show('apply', hr, ['success', 'addedTris', 'checksPassed', 'checksFailed', 'error'])
if hr.get('success'):
    hc = json.load(open(RG + '/house_checks.json'))
    fails = [c['name'] for c in hc['checks'] if not c['pass']]
    c_ok = not fails
    print('  gate:', 'all pass' if c_ok else f'FAILED: {fails}')
else:
    # a clean refusal with diagnostics is acceptable — but it must be a refusal, not a crash
    pe = hr.get('planErrors') or []
    c_ok = bool(pe) or bool(hr.get('failedChecks'))
    print('  clean refusal diagnostics:', json.dumps(pe, indent=2)[:1500])
results['C'] = c_ok
print(f'C: {"PASS" if c_ok else "FAIL"}')

# ══ D ══ negative test ═══════════════════════════════════════════════
print('═══ D. negative test (bad plan) ═══')
if os.path.exists(RG + '/bad_out.obj'): os.remove(RG + '/bad_out.obj')
outs = run_terminal([
    {'command': 'relief-plan-apply', 'summaryPath': SUM_COTTAGE, 'planPath': RG + '/bad_plan.json',
     'objPath': RG + '/cottage.obj', 'outObjPath': RG + '/bad_out.obj',
     'checksReport': RG + '/bad_checks.json'},
], 'D')
dr = outs[-1]
show('apply', dr, ['success', 'error'])
pe = dr.get('planErrors') or []
print('  planErrors (artist-facing diagnostics):')
print(json.dumps(pe, indent=2))
d_ok = (dr.get('success') is False and len(pe) >= 2
        and not os.path.exists(RG + '/bad_out.obj')
        and os.path.exists(RG + '/bad_checks.json'))
results['D'] = d_ok
print(f'D: {"PASS" if d_ok else "FAIL"}')

print('\n═══ SUMMARY ═══')
for k in 'ABCD':
    print(f'  {k}: {"PASS" if results.get(k) else "FAIL"}')
sys.exit(0 if all(results.values()) else 1)
