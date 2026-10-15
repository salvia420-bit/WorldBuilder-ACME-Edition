import json,glob,re
R='/mnt/wbterminal2/film-projects/dereth-town-tour/research/'
def slug(n): return re.sub(r'[^a-z0-9]+','-',n.lower().replace("'",'')).strip('-')
def load_all():
    A={}; meta={}
    for f in sorted(glob.glob(R+'town-*.json')):
        if f.endswith('.plan.json'): continue
        d=json.load(open(f))
        T=d['towns'] if 'towns' in d else [d]
        for t in T:
            sid=t['site']['id']
            if 'egg-orchard' in f and sid=='eastwatch':
                A['egg-eastwatch-extra']=t; continue
            A[sid]=t; meta[sid]=dict(file=f,lookNote=d.get('lookNote'))
    return A,meta
