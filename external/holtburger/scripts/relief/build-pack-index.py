import os,struct,json,sys
PACKS="dist/packs"; out=[]
for root,_d,files in os.walk(PACKS):
    for f in files:
        if not f.endswith(".hbp"): continue
        p=os.path.join(root,f)
        with open(p,"rb") as fh:
            h=fh.read(32)
            if len(h)<32 or h[:4]!=b"HBP1": continue
            pk=h[5]; origin=struct.unpack_from("<I",h,8)[0]
            nsec=struct.unpack_from("<H",h,12)[0]; nns=h[14]
            fh.seek(32+nns*32); tbl=fh.read(nsec*16)
        secs={}
        for i in range(nsec):
            k,cd,_pd,off,st,raw=struct.unpack_from("<HBBIII",tbl,i*16)
            secs[k]=[cd,off,st,raw]
        out.append([p,pk,origin,secs])
json.dump(out,open("/tmp/s12/pack-index.json","w"))
print("indexed",len(out),file=sys.stderr)
