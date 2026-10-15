import json, sys, math
import numpy as np
sys.path.insert(0,'/tmp/claude-1000/-home-wbterminal/f87d60b8-65a2-447a-9582-b19fdc7eaafc/scratchpad/egg-orchard-dungeon/py')
import eograph as G
envs,raw=G.load()
n=G.build()
def cell_tris(cid):
    f=raw[cid]; cs=envs[f['environmentId']][str(f['cellStructure'])]
    verts={int(k):v['origin'] for k,v in cs['vertexArray']['vertices'].items()}
    o=f['position']['origin']; q=f['position']['orientation']
    W3=lambda p:( (lambda r:(o[0]+r[0], o[1]+r[1]+43*192, o[2]+r[2]))(G.qrot(q,p)) )
    portals=set(p['polygonId'] for p in f['cellPortals'])
    portals |= set(cs.get('portals') or [])
    tris=[]
    for pid,poly in cs['polygons'].items():
        if int(pid) in portals: continue
        pv=[W3(verts[i]) for i in poly['vertexIds']]
        for i in range(1,len(pv)-1): tris.append((pv[0],pv[i],pv[i+1]))
    return tris
def pt_tri(p,a,b,c):
    # Ericson closest point on triangle
    a,b,c,p=map(np.array,(a,b,c,p))
    ab=b-a; ac=c-a; ap=p-a
    d1=ab@ap; d2=ac@ap
    if d1<=0 and d2<=0: return np.linalg.norm(p-a)
    bp=p-b; d3=ab@bp; d4=ac@bp
    if d3>=0 and d4<=d3: return np.linalg.norm(p-b)
    vc=d1*d4-d3*d2
    if vc<=0 and d1>=0 and d3<=0:
        v=d1/(d1-d3); return np.linalg.norm(p-(a+v*ab))
    cp=p-c; d5=ab@cp; d6=ac@cp
    if d6>=0 and d5<=d6: return np.linalg.norm(p-c)
    vb=d5*d2-d1*d6
    if vb<=0 and d2>=0 and d6<=0:
        w=d2/(d2-d6); return np.linalg.norm(p-(a+w*ac))
    va=d3*d6-d5*d4
    if va<=0 and (d4-d3)>=0 and (d5-d6)>=0:
        w=(d4-d3)/((d4-d3)+(d5-d6)); return np.linalg.norm(p-(b+w*(c-b)))
    den=1/(va+vb+vc); v=vb*den; w=vc*den
    return np.linalg.norm(p-(a+ab*v+ac*w))
routes=json.load(open('/tmp/claude-1000/eo/routes.json'))
for key in sys.argv[1:]:
    rt=routes[key]
    cells=set(rt['cells'])
    # add neighbours of route cells
    near=set()
    for c in cells:
        cid=c&0xFFFF; near.add(cid); near.update(n[cid]['neighbors'])
    tris=[]
    for cid in near:
        if cid in n: tris+= [(cid,t) for t in cell_tris(cid)]
    worst=[]; mins=[]
    for smp in rt['samples'][::2]:
        p=smp['pos']
        best=1e9; bc=None
        for cid,t in tris:
            # quick reject
            if min(abs(p[0]-t[0][0]),abs(p[0]-t[1][0]),abs(p[0]-t[2][0]))>12 and min(abs(p[1]-t[0][1]),abs(p[1]-t[1][1]),abs(p[1]-t[2][1]))>12: continue
            dd=pt_tri(p,*t)
            if dd<best: best=dd; bc=cid
        mins.append((best,smp['t'],bc,p))
    mins.sort()
    print(key,'len',round(rt['length'],1),'min wall clearance:',[(round(m[0],2),round(m[1],2),hex(m[2]),[round(x,1) for x in m[3]]) for m in mins[:6]])
    # z clearance floor/ceiling summary
    print('  p10 clearance', round(mins[len(mins)//10][0],2), 'median', round(mins[len(mins)//2][0],2))
