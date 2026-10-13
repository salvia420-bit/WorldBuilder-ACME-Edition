import json,sys
data=json.load(open(sys.argv[1]))
idx=int(sys.argv[2]); part=sys.argv[3] if len(sys.argv)>3 else 'all'
d=data[idx]
if part in ('all','summary'):
    print('# '+d['area']); print(d['summary'])
if part in ('all','apis'):
    print('\n## APIS')
    for a in d['apis']: print(f"- {a['name']} [{a.get('file','')}:{a.get('line','')}] {'' if a.get('verified') else '(UNVERIFIED)'} sig={a.get('signature','')} :: {a['what']}")
if part in ('all','seams'):
    print('\n## SEAMS')
    for a in d['seams']: print(f"- [{a.get('file','')}:{a.get('line','')}] {a['what']} => {a['filmUse']}")
if part in ('all','hazards'):
    print('\n## HAZARDS')
    for a in d['hazards']: print(f"- [{a.get('file','')}:{a.get('line','')}] {a['what']} || mitig: {a.get('mitigation','')}")
if part in ('all','rest'):
    print('\n## DATA'); [print('-',x) for x in d.get('dataSources',[])]
    print('\n## RECS'); [print('-',x) for x in d.get('recommendations',[])]
    print('\n## OPENQ'); [print('-',x) for x in d.get('openQuestions',[])]
