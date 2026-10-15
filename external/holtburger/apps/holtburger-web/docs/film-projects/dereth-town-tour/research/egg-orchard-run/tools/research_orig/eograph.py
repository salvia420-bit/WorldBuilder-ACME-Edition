import json, math, heapq, collections
LBX, LBY = 0, 43
def qrot(q, v):
    w,x,y,z = q
    # rotate v by quaternion (w,x,y,z)
    vx,vy,vz = v
    # t = 2 * cross(q.xyz, v)
    tx = 2*(y*vz - z*vy); ty = 2*(z*vx - x*vz); tz = 2*(x*vy - y*vx)
    return (vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx))
def load():
    L=[json.loads(l) for l in open('/tmp/claude-1000/eo/parse_all.jsonl')]
    envs={}; cells={}
    for d in L:
        if d.get('command')!='chorizite-parse-dat-record': continue
        f=d['fields']
        if d['typeName']=='Environment':
            envs[d['id'] & 0xFFFF]=f['cells']
        else:
            cells[d['id'] & 0xFFFF]=f
    return envs, cells
def build():
    envs, raw = load()
    nodes={}
    for cid,f in raw.items():
        cs = envs[f['environmentId']][str(f['cellStructure'])]
        verts={int(k):v['origin'] for k,v in cs['vertexArray']['vertices'].items()}
        polys={int(k):v['vertexIds'] for k,v in cs['polygons'].items()}
        o=f['position']['origin']; q=f['position']['orientation']
        W=lambda p:( (lambda r:(o[0]+r[0]+LBX*192, o[1]+r[1]+LBY*192, o[2]+r[2]))(qrot(q,p)) )
        xs=[v[0] for v in verts.values()]; ys=[v[1] for v in verts.values()]; zs=[v[2] for v in verts.values()]
        bb=(min(xs),min(ys),min(zs),max(xs),max(ys),max(zs))
        pos=W(((bb[0]+bb[3])/2,(bb[1]+bb[4])/2,bb[2]))
        ctr=W(((bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2))
        # world corners of the bbox for footprint
        wv=[W(v) for v in verts.values()]
        doors=[]; nbs=[]
        for p in f['cellPortals']:
            other=p['otherCellId']
            if other==0xFFFF: continue
            nbs.append(other)
            pv=[W(verts[i]) for i in polys[p['polygonId']]]
            n=len(pv)
            c=[sum(a[i] for a in pv)/n for i in range(3)]
            # Newell normal
            nx=ny=nz=0
            for i in range(n):
                a=pv[i]; b=pv[(i+1)%n]
                nx+=(a[1]-b[1])*(a[2]+b[2]); ny+=(a[2]-b[2])*(a[0]+b[0]); nz+=(a[0]-b[0])*(a[1]+b[1])
            l=math.sqrt(nx*nx+ny*ny+nz*nz) or 1
            nrm=[nx/l,ny/l,nz/l]
            d=[c[i]-ctr[i] for i in range(3)]
            if sum(d[i]*nrm[i] for i in range(3))<0: nrm=[-x for x in nrm]
            zmin=min(a[2] for a in pv); zmax=max(a[2] for a in pv)
            # width = horizontal extent
            hx=max(a[0] for a in pv)-min(a[0] for a in pv); hy=max(a[1] for a in pv)-min(a[1] for a in pv)
            doors.append({'other':other,'at':c,'normal':nrm,'height':zmax-zmin,'bottom':zmin,'width':math.hypot(hx,hy)})
        nodes[cid]={'pos':pos,'ctr':ctr,'bb':bb,'env':f['environmentId'],'cs':f['cellStructure'],'origin':o,'q':q,
                    'neighbors':nbs,'doors':doors,'statics':f.get('staticObjects',[]),'wv':wv,'height':bb[5]-bb[2]}
    return nodes
def d3(a,b): return math.dist(a,b)
def astar(nodes, s, t):
    g={s:0}; came={}; pq=[(d3(nodes[s]['pos'],nodes[t]['pos']),0,s)]; seq=0; closed=set()
    while pq:
        f,_,u=heapq.heappop(pq)
        if u in closed: continue
        closed.add(u)
        if u==t:
            p=[u]
            while u in came: u=came[u]; p.append(u)
            return p[::-1]
        for v in nodes[u]['neighbors']:
            if v not in nodes or v in closed: continue
            c=d3(nodes[u]['pos'],nodes[v]['pos'])
            ds=[dd for dd in nodes[u]['doors'] if dd['other']==v]
            if ds and all(abs(dd['normal'][2])<=0.7 and dd['height']<1.83 for dd in ds): c+=6
            ng=g[u]+c
            if ng<g.get(v,1e18):
                g[v]=ng; came[v]=u; seq+=1; heapq.heappush(pq,(ng+d3(nodes[v]['pos'],nodes[t]['pos']),seq,v))
    return None
def pick_door(nodes,a,b):
    ds=[dict(x) for x in nodes[a]['doors'] if x['other']==b]
    if not ds:
        ds=[dict(x, other=b, normal=[-n for n in x['normal']]) for x in nodes[b]['doors'] if x['other']==a]
    if not ds: return None
    up=lambda d: abs(d['normal'][2])<=0.7
    for d in ds:
        if up(d) and d['height']>=1.83: return d
    for d in ds:
        if up(d): return d
    return ds[0]
def plan(nodes, cells, anchorH=1.5, frac=0.55, approach=1.2):
    start=list(nodes[cells[0]]['pos']); start[2]+=anchorH
    end=list(nodes[cells[-1]]['pos']); end[2]+=anchorH
    raw=[]
    for a,b in zip(cells,cells[1:]):
        d=pick_door(nodes,a,b)
        if d is None: raise Exception('no door %x %x'%(a,b))
        up=abs(d['normal'][2])<=0.7
        if up:
            h=math.hypot(d['normal'][0],d['normal'][1]); n=[d['normal'][0]/h,d['normal'][1]/h,0]
            c=[d['at'][0],d['at'][1],d['bottom']+frac*d['height'] if d['height']>0 else d['at'][2]]
        else:
            n=d['normal']; c=d['at']
        raw.append((a,b,c,n,up,d))
    pts=[start]
    for i,(a,b,c,n,up,d) in enumerate(raw):
        bef=aft=approach
        if i>0: bef=min(bef,d3(raw[i-1][2],c)/2)
        if i+1<len(raw): aft=min(aft,d3(c,raw[i+1][2])/2)
        if i==0:
            dep=sum((c[k]-start[k])*n[k] for k in range(3))
            if dep>0: bef=min(bef,dep/2)
        if i+1==len(raw):
            dep=sum((end[k]-c[k])*n[k] for k in range(3))
            if dep>0: aft=min(aft,dep/2)
        pts += [[c[k]-n[k]*bef for k in range(3)], c, [c[k]+n[k]*aft for k in range(3)]]
    pts.append(end)
    out=[]
    for p in pts:
        if not out or d3(out[-1],p)>1e-3: out.append(p)
    return out, raw
def polylen(p): return sum(d3(a,b) for a,b in zip(p,p[1:]))
def turns(p, minleg=0.3):
    # heading per leg (horizontal), list heading changes
    hs=[]
    for a,b in zip(p,p[1:]):
        dx,dy=b[0]-a[0],b[1]-a[1]
        if math.hypot(dx,dy)<minleg: continue
        hs.append((math.degrees(math.atan2(dx,dy))%360, math.hypot(dx,dy), b[2]-a[2]))
    return hs
