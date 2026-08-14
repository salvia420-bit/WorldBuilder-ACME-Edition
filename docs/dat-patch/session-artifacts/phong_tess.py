import numpy as np, sys
def parse(path):
    V=[];VN=[];VT=[];F=[];cur=None
    for ln in open(path):
        p=ln.split()
        if not p: continue
        if p[0]=='v': V.append([float(x) for x in p[1:4]])
        elif p[0]=='vn': VN.append([float(x) for x in p[1:4]])
        elif p[0]=='vt': VT.append([float(x) for x in p[1:3]])
        elif p[0]=='usemtl': cur=p[1]
        elif p[0]=='f':
            idx=[[int(y) for y in t.split('/')] for t in p[1:]]
            for k in range(1,len(idx)-1): F.append((cur,[idx[0],idx[k],idx[k+1]]))
    return np.array(V),np.array(VN),np.array(VT),F
def phong_point(p,pi,ni):  # project p onto tangent plane at (pi,ni)
    return p-np.dot(p-pi,ni)*ni
def tess(V,VN,VT,F,alpha=0.75,levels=1):
    for _ in range(levels):
        nV=list(map(list,V)); nN=list(map(list,VN)); nT=list(map(list,VT)); nF=[]
        cache={}
        def mid(a,b):  # a,b = (vi,vti,vni) 1-based
            key=tuple(sorted([(a[0],a[2]),(b[0],b[2])]))+tuple(sorted([a[1],b[1]]))
            if key in cache: return cache[key]
            pa,pb=V[a[0]-1],V[b[0]-1]; na,nb=VN[a[2]-1],VN[b[2]-1]
            m=(pa+pb)/2
            proj=(phong_point(m,pa,na/np.linalg.norm(na))+phong_point(m,pb,nb/np.linalg.norm(nb)))/2
            pos=(1-alpha)*m+alpha*proj
            nrm=na+nb; nrm=nrm/np.linalg.norm(nrm)
            uv=(VT[a[1]-1]+VT[b[1]-1])/2
            nV.append(list(pos)); nN.append(list(nrm)); nT.append(list(uv))
            r=(len(nV),len(nT),len(nN)); cache[key]=r; return r
        for mat,(A,B,C) in F:
            AB,BC,CA=mid(A,B),mid(B,C),mid(C,A)
            nF+= [(mat,[A,AB,CA]),(mat,[AB,B,BC]),(mat,[CA,BC,C]),(mat,[AB,BC,CA])]
        V=np.array(nV);VN=np.array(nN);VT=np.array(nT);F=nF
    return V,VN,VT,F
def write(path,V,VN,VT,F):
    with open(path,'w') as w:
        for v in V: w.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        for n in VN: w.write(f"vn {n[0]:.6f} {n[1]:.6f} {n[2]:.6f}\n")
        for t in VT: w.write(f"vt {t[0]:.6f} {t[1]:.6f}\n")
        cur=None
        for mat,tri in F:
            if mat!=cur: w.write(f"usemtl {mat}\n"); cur=mat
            w.write("f "+" ".join(f"{a}/{b}/{c}" for a,b,c in tri)+"\n")
V,VN,VT,F=parse(sys.argv[1])
lv=int(sys.argv[3]) if len(sys.argv)>3 else 2
V2,VN2,VT2,F2=tess(V,VN,VT,F,alpha=0.5,levels=lv)
write(sys.argv[2],V2,VN2,VT2,F2)
print(f"tris {len(F)} -> {len(F2)}, verts {len(V)} -> {len(V2)}")
