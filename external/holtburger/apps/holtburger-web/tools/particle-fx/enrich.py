#!/usr/bin/env python3
"""Attach in-game context to every emitter in emitters.json.

Context sources: PlayScript enum names (ui/ac_play_script.js), LSD weenies
(setup DID, PhysicsEffectTable DID 22, default PhysicsScript DID 30/8019),
CallPES parent propagation. Writes emitters_ctx.json.
"""
import json, os, re, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)
HOLT = os.path.abspath(os.path.join(HERE, "..", ".."))
LSD = os.environ.get("PFX_LSD_WEENIES", os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", "LSD-Partial-2025-02-23_16-15", "weenies")))

ps_names = {}
for m in re.finditer(r"^\s*(\w+):\s*0x([0-9A-Fa-f]+)", open(os.path.join(HOLT, "ui/ac_play_script.js")).read(), re.M):
    ps_names[int(m.group(2), 16)] = m.group(1)

rows = json.load(open(os.path.join(WORK, "emitters.json")))
scripts = {int(k, 16): v for k, v in json.load(open(os.path.join(WORK, "scripts.json"))).items()}
tables = {int(k, 16): {int(kk): vv for kk, vv in v.items()} for k, v in json.load(open(os.path.join(WORK, "tables.json"))).items()}
setups = {int(k, 16): v for k, v in json.load(open(os.path.join(WORK, "setups_fx.json"))).items()}

setup_w = defaultdict(list); table_w = defaultdict(list); script_w = defaultdict(list)
for fn in os.listdir(LSD):
    if not fn.endswith(".json"):
        continue
    try:
        d = json.load(open(os.path.join(LSD, fn), encoding="utf-8-sig"))
    except Exception:
        continue
    name = next((s["value"] for s in d.get("stringStats") or [] if s.get("key") == 1), fn[:-5])
    dids = {s["key"]: s["value"] for s in d.get("didStats") or []}
    if dids.get(1):
        setup_w[dids[1]].append(name)
    if dids.get(22):
        table_w[dids[22]].append(name)
    for k in (30, 8019):
        if dids.get(k):
            script_w[dids[k]].append(name)

def top(names, n=4):
    seen = []
    for x in names:
        if x not in seen:
            seen.append(x)
    return seen[:n] + ([f"+{len(seen)-n}"] if len(seen) > n else [])

# script -> contexts
direct = defaultdict(set)
for tid, rws in tables.items():
    for k, lst in rws.items():
        wn = top(table_w.get(tid, []), 3)
        for mod, s in lst:
            direct[s].add(f"PlayScript {ps_names.get(k, hex(k))}" + (f" on [{', '.join(wn)}]" if wn else f" (table {tid:#x})"))
for sid, s in setups.items():
    ds = s.get("defaultScript")
    if ds:
        wn = top(setup_w.get(sid, []), 3)
        direct[ds].add(f"default script of setup {sid:#010x}" + (f" [{', '.join(wn)}]" if wn else " (static/scenery)"))
for s, names in script_w.items():
    direct[s].add(f"weenie default script [{', '.join(top(names, 3))}]")

parents = defaultdict(set)
for sid, hooks in scripts.items():
    for h in hooks:
        if h["type"] == "CallPES":
            parents[h["pes"]].add(sid)

def contexts(sid, depth=0, seen=None):
    seen = seen or set()
    if sid in seen or depth > 4:
        return set()
    seen.add(sid)
    out = set(direct.get(sid, ()))
    for p in parents.get(sid, ()):
        if p != sid:
            out |= {f"{c} (via CallPES {p:#x})" for c in contexts(p, depth + 1, seen)}
    return out

for e in rows:
    ctx = set()
    for s in e["scripts"]:
        ctx |= contexts(s)
    for st in e.get("setupsDirect") or []:
        wn = top(setup_w.get(st, []), 3)
        ctx.add(f"placement hook of setup {st:#010x}" + (f" [{', '.join(wn)}]" if wn else ""))
    ctx = sorted(ctx)
    e["ctx"] = ctx[:12] + ([f"... {len(ctx)-12} more"] if len(ctx) > 12 else [])
    e["nCtx"] = len(ctx)
    e.pop("uses", None)

json.dump(rows, open(os.path.join(WORK, "emitters_ctx.json"), "w"))
print("ps names", len(ps_names), "setups w/ weenies", len(setup_w), "tables w/ weenies", len(table_w), file=sys.stderr)
print("emitters with ctx", sum(1 for e in rows if e["nCtx"]), "/", len(rows), file=sys.stderr)
