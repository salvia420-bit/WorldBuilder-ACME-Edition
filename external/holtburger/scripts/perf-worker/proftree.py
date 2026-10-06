import json,sys
from collections import defaultdict
prof=json.load(open(sys.argv[1])); target=sys.argv[2]; depth=int(sys.argv[3]) if len(sys.argv)>3 else 1
nodes={n['id']:n for n in prof['nodes']}
parent={}
for n in prof['nodes']:
    for c in n.get('children',[]): parent[c]=n['id']
def key(n):
    cf=n['callFrame']; u=cf['url'].split('/')[-1].split('?')[0]
    return f"{cf['functionName'] or '(anon)'} {u}:{cf['lineNumber']+1}"
# sample time per node (self)
selft=defaultdict(float)
s=prof['samples']; td=prof['timeDeltas']
for i,sid in enumerate(s):
    selft[sid]+= (td[i+1] if i+1<len(td) else td[i])/1000
# inclusive per node
inc={}
def incl(nid):
    if nid in inc: return inc[nid]
    t=selft[nid]+sum(incl(c) for c in nodes[nid].get('children',[]))
    inc[nid]=t; return t
import sys; sys.setrecursionlimit(100000)
for nid in nodes: incl(nid)
# aggregate children of all nodes matching target, by child key, recursively to depth
def walk(ids, d, indent):
    agg=defaultdict(lambda:[0.0,[]])
    for nid in ids:
        for c in nodes[nid].get('children',[]):
            k=key(nodes[c]); agg[k][0]+=inc[c]; agg[k][1].append(c)
    for k,(t,cs) in sorted(agg.items(), key=lambda x:-x[1][0]):
        if t<float(sys.argv[4] if len(sys.argv)>4 else 20): continue
        print(f"{'  '*indent}{t:8.1f}  {k}")
        if d>1: walk(cs,d-1,indent+1)
roots=[nid for nid,n in nodes.items() if target in key(n)]
print('roots',len(roots), sum(inc[r] for r in roots if not any(target in key(nodes[p]) for p in [parent.get(r)] if p)))
walk(roots,depth,0)
