import os,struct,subprocess,json,sys,collections
DIST="dist"; PACKS=os.path.join(DIST,"packs")
GEOM,GEOMR,LBINFO=0x09,0x0C,0x02

def hdr(p):
    with open(p,"rb") as fh:
        h=fh.read(32)
        if len(h)<32 or h[:4]!=b"HBP1": return None
        pk=h[5]; origin=struct.unpack_from("<I",h,8)[0]
        nsec=struct.unpack_from("<H",h,12)[0]; nns=h[14]
        fh.seek(32+nns*32); tbl=fh.read(nsec*16)
    return pk,origin,{struct.unpack_from("<H",tbl,i*16)[0]:struct.unpack_from("<HBBIII",tbl,i*16)[3:] for i in range(nsec)}

def sec(p,ent):
    off,st,raw=ent
    with open(p,"rb") as fh: fh.seek(off); body=fh.read(st)
    if st==raw and body[:4]!=b"\x28\xb5\x2f\xfd": return body
    return subprocess.run(["zstd","-d","-c","-q"],input=body,stdout=subprocess.PIPE,check=True).stdout

def recs(pl):
    n=struct.unpack_from("<I",pl,0)[0]; idx=4; base=4+n*13; out={}
    for i in range(n):
        ns=pl[idx+13*i]; fid,off,size=struct.unpack_from("<III",pl,idx+13*i+1)
        out[fid]=pl[base+off:base+off+size]
    return out

def lbinfo(b):
    o=0
    _id,ncells,nobj=struct.unpack_from("<III",b,0); o=12
    objs=[]
    for _ in range(nobj):
        oid=struct.unpack_from("<I",b,o)[0]
        px,py,pz=struct.unpack_from("<3f",b,o+4)
        objs.append((oid,px,py,pz)); o+=32
    nb,pack_mask=struct.unpack_from("<HH",b,o); o+=4
    builds=[]
    for _ in range(nb):
        mid=struct.unpack_from("<I",b,o)[0]
        px,py,pz=struct.unpack_from("<3f",b,o+4)
        o+=4+28
        _leaves,nport=struct.unpack_from("<II",b,o); o+=8
        for _ in range(nport):
            _f,_oc,_op,nst=struct.unpack_from("<4H",b,o); o+=8+nst*2
            o+= (4-((8+nst*2)%4))%4
        builds.append((mid,px,py,pz))
    return objs,builds

# variant ids: everything in the dist
variants=set(int(m["id"],16) for m in json.load(open("/tmp/s12/relief-census.json"))["models"])

# setup -> parts, from every pack we can reach cheaply: meta-shared + tiles near Holtburg
idx=[(p,pk,origin,{int(k):tuple(v[1:]) for k,v in secs.items()})
     for p,pk,origin,secs in json.load(open("/tmp/s12/pack-index.json"))]

setups={}; parts=set()
targets=[]
for p,pk,origin,secs in idx:
    if pk==2 or (pk==0 and abs(((origin>>8)&0xFF)-0x54)<=3 and abs((origin&0xFF)-0x5A)<=3):
        targets.append((p,pk,origin,secs))
print("target packs",len(targets),file=sys.stderr)
for p,pk,origin,secs in targets:
    if GEOM in secs:
        gp=sec(p,secs[GEOM])
        n=struct.unpack_from("<I",gp,0)[0]
        for i in range(n):
            r=4+16*i
            fid,enc,_pd,off,size=struct.unpack_from("<IHHII",gp,r)
            pl=gp[off:off+size]
            if len(pl)<20 or pl[:4]!=b"HBG1": continue
            if pl[4]==1:
                cnt=struct.unpack_from("<H",pl,16)[0]
                setups.setdefault(fid,[struct.unpack_from("<I",pl,16+28+i2*72)[0] for i2 in range(cnt)])
            elif pl[4]==0: parts.add(fid)

def variant_parts(did):
    if did in variants: return [did]
    return [q for q in setups.get(did,[]) if q in variants]

rows=[]
for p,pk,origin,secs in targets:
    if pk!=0 or LBINFO not in secs: continue
    tx,ty=(origin>>8)&0xFF,origin&0xFF
    rec=recs(sec(p,secs[LBINFO]))
    for fid,b in rec.items():
        lb=(fid>>16)&0xFFFF
        try: objs,builds=lbinfo(b)
        except Exception as e:
            print("parse fail 0x%04X: %s"%(lb,e),file=sys.stderr); continue
        for kind,lst in (("object",objs),("building",builds)):
            for mid,px,py,pz in lst:
                vp=variant_parts(mid)
                rows.append({"lb":"0x%04X"%lb,"kind":kind,"did":"0x%08X"%mid,
                             "known_setup": mid in setups, "known_part": mid in parts,
                             "variant_parts":["0x%08X"%q for q in vp],
                             "world":[round(((lb>>8)&0xFF)*192.0+px,2),round((lb&0xFF)*192.0+py,2),round(pz,2)]})
json.dump(rows,open("/tmp/s12/holtburg-lbinfo.json","w"),indent=1)
tot=collections.Counter((r["kind"], bool(r["variant_parts"])) for r in rows)
print("LBINFO rows:",len(rows),dict(tot),file=sys.stderr)
res=collections.Counter((r["kind"], r["known_setup"], r["known_part"]) for r in rows)
print("resolvable:",dict(res),file=sys.stderr)
