#!/usr/bin/env python3
"""env_geo.py -- DUNGEON GEOMETRY pilot (lane 3, geometry sub-lane).

The wrinkle vs the building lane: CellStruct polygon surface indices resolve
through EACH EnvCell's OWN surface array -- the same prefab renders as stone in
one dungeon and ice in another.  Cell-weighted, only ~36% of slot usages have a
>=90%-dominant texture (env_idx census).  So this lane displaces ONLY dominant
slots: per (environment, cellStruct, surfaceIndex) with one texture on >=DOM_MIN
of its cells AND a wall relief class, displace with THAT texture's height field;
everything else (diverse slots, portal polys, NoPos fillers, double-sided) is
left untouched.  Minority cells (<10%) elsewhere wear the dominant texture's
relief under a different albedo -- accepted for the pilot, judged in-client.

Subcommands:
  plan   --root R [--lb 0x0189]   census + slot eligibility -> plan.json
  build  --root R                 displaced shell OBJs + imports.jsonl
  apply  --root R --patched DAT --wbt DLL   drive environment-append-geometry
"""
import argparse
import json
import os
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CELL_DAT = "/home/wbterminal/ac_base_dats/client_cell_1.dat"
PORTAL = "/home/wbterminal/ac_base_dats/client_portal.dat"
DOM_MIN = 0.90
MULT = 4.0
MAX_SEGMENTS = 12


def _cell_walk():
    import datlib
    dat = datlib.Dat(CELL_DAT)
    for oid in dat.files:
        if 0x100 <= (oid & 0xFFFF) <= 0xFFFD:
            raw = dat.get(oid)
            ns = raw[12]
            surfs = struct.unpack_from("<%dH" % ns, raw, 16)
            env, cs = struct.unpack_from("<2H", raw, 16 + 2 * ns)
            yield oid, env, cs, surfs


def plan(root, lb=None):
    """Slot census -> eligible (env, cs, idx) slots with their dominant sid."""
    import pipeline
    os.makedirs(root, exist_ok=True)
    peridx = {}
    lb_pairs = set()
    for oid, env, cs, surfs in _cell_walk():
        for i, s in enumerate(surfs):
            d = peridx.setdefault((env, cs, i), {})
            d[s] = d.get(s, 0) + 1
        if lb is not None and (oid >> 16) == lb:
            lb_pairs.add((env, cs))
    pairs = lb_pairs if lb is not None else {(e, c) for (e, c, _i) in peridx}
    plan = {}
    stats = dict(slots=0, dominant=0, wall=0)
    for (env, cs) in sorted(pairs):
        slots = {}
        for (e, c, i), d in peridx.items():
            if (e, c) != (env, cs):
                continue
            stats["slots"] += 1
            tot = sum(d.values())
            dom16, domn = max(d.items(), key=lambda kv: kv[1])
            if domn / tot < DOM_MIN:
                continue
            stats["dominant"] += 1
            sid = 0x08000000 | dom16
            m = pipeline.surface_meta({sid})[sid]
            if m["cls"] not in __import__("pilot").WALL_CLASSES or m.get("h") is None:
                continue
            stats["wall"] += 1
            slots[i] = dict(sid="0x%08X" % sid, cls=m["cls"],
                            cells=tot, frac=round(domn / tot, 3))
        if slots:
            plan["%04X:%d" % (env, cs)] = slots
    out = dict(lb=("0x%04X" % lb) if lb is not None else None,
               domMin=DOM_MIN, pairs=len(plan), stats=stats, slots=plan)
    json.dump(out, open(os.path.join(root, "plan.json"), "w"), indent=1)
    print("plan: %d (env,cs) pairs with eligible slots; %d/%d slots dominant, "
          "%d wall-class eligible -> %s/plan.json"
          % (len(plan), stats["dominant"], stats["slots"], stats["wall"], root))
    return out


def _env_rec(cells, cs, slot_sids):
    """Adapt one parsed CellStruct to the SourceMesh 'rec' shape.  Polys whose
    pos index is not an eligible slot are FORCED excluded by pointing them at
    surface 0 with no meta (SourceMesh gives them cls None/amp 0); portal polys
    are excluded the same way regardless of slot."""
    c = cells[cs]
    max_idx = max([p["pos"] for p in c["polys"]] + [0])
    surfaces = []
    for i in range(max_idx + 1):
        surfaces.append(int(slot_sids[i], 16) if i in slot_sids else 0)
    portal_keys = set(c["portals"])
    polys = []
    for p in c["polys"]:
        q = dict(p)
        if p["key"] in portal_keys:
            q["pos"] = -1          # out of range -> sid 0 -> no meta -> amp 0
        polys.append(q)
    return dict(P=c["P"], N=c["N"], UV=c["UV"], idx=c["idx"],
                surfaces=surfaces, polys=polys)


def build(root):
    import numpy as np
    import datlib
    import pipeline
    import pilot
    import relief3d
    os.environ.setdefault("DATPATCH_PORTAL", PORTAL)
    P = pipeline.P
    pdat = datlib.Dat(PORTAL)
    planj = json.load(open(os.path.join(root, "plan.json")))
    objd = os.path.join(root, "obj")
    os.makedirs(objd, exist_ok=True)
    imports = []
    stats = []
    for pair, slots in sorted(planj["slots"].items()):
        env16, cs = pair.split(":")
        env_id = 0x0D000000 | int(env16, 16)
        cs = int(cs)
        eid, cells = datlib.parse_environment(pdat.get(env_id), strict=True)
        if cs not in cells:
            stats.append(dict(pair=pair, ok=False, why="cellstruct absent"))
            continue
        slot_sids = {int(i): v["sid"] for i, v in slots.items()}
        rec = _env_rec(cells, cs, slot_sids)
        sids = {s for s in rec["surfaces"] if s}
        metas = pipeline.surface_meta(sids)
        for m in metas.values():
            if m["cls"] in pilot.WALL_CLASSES and m.get("h") is not None:
                m["amp"] = pilot.AMP_WALL
        src = relief3d.SourceMesh.from_record(rec, metas)
        n0 = src.tri_count()
        target = int(round(n0 * (MULT - 1.0)))
        pipeline.bandlimit(src, metas, target, verbose=False)
        carve_fans = sum(len(p["v"]) - 2 for p in src.polys
                         if p.get("h") is not None and p.get("amp", 0) > 0
                         and not p.get("excluded") and not p.get("invisible"))
        if carve_fans == 0:
            stats.append(dict(pair=pair, ok=False, why="no carveable polys"))
            continue
        segs = MAX_SEGMENTS
        while segs > 4 and carve_fans * segs * segs > pilot.FINE_BUDGET:
            segs -= 2
        old_max = relief3d.MAX_AMPLITUDE_M
        relief3d.MAX_AMPLITUDE_M = max(old_max, pilot.AMP_WALL)
        try:
            res = pipeline.run(src, segments=segs, mult=MULT, target_tris=target,
                               carved_only=True, floor_m=pilot.FLOOR_M,
                               verbose=False, normal_gain=pilot.NORMAL_GAIN)
        finally:
            relief3d.MAX_AMPLITUDE_M = old_max
        # emit OBJ grouped by surface INDEX (usemtl surfN, the append command's
        # contract) -- map each face's source poly back to its pos index.
        sid2idx = {int(v["sid"], 16): int(i) for i, v in slots.items()}
        objp = os.path.join(objd, "%08X_%d.obj" % (env_id, cs))
        nf = _write_obj(objp, env_id, cs, res, src, sid2idx)
        if nf == 0:
            stats.append(dict(pair=pair, ok=False, why="no shell faces"))
            continue
        imports.append(dict(envIdHex="0x%08X" % env_id, cellStructIndex=cs,
                            objPath=objp))
        stats.append(dict(pair=pair, ok=True, srcTris=n0, shellTris=nf,
                          segments=segs))
        print("  %s: src %d tris -> shell %d" % (pair, n0, nf))
    json.dump(stats, open(os.path.join(root, "build_stats.json"), "w"), indent=1)
    with open(os.path.join(root, "imports.jsonl"), "w") as f:
        for i in imports:
            f.write(json.dumps(i) + "\n")
    ok = sum(1 for s in stats if s.get("ok"))
    print("build: %d/%d pairs -> OBJs; imports.jsonl written" % (ok, len(stats)))


def _write_obj(path, env_id, cs, res, src, sid2idx):
    import numpy as np
    V, F, UV, NR, poly = res["V"], res["F"], res["UV"], res["NR"], res["poly"]
    by_idx = {}
    vlines, tlines, nlines = [], [], []
    vmap, tmap, nmap = {}, {}, {}

    def _add(store, lines, row, fmtline):
        k = tuple(np.round(np.asarray(row, float), 6))
        if k not in store:
            store[k] = len(lines) + 1
            lines.append(fmtline % k)
        return store[k]

    for fi in range(len(F)):
        sp = src.polys[poly[fi]]
        sid = sp["surf"]
        if sid not in sid2idx:
            continue
        tri = []
        for c in range(3):
            vi = _add(vmap, vlines, V[F[fi][c]], "v %.6f %.6f %.6f")
            ti = _add(tmap, tlines, UV[fi][c], "vt %.6f %.6f")
            ni = _add(nmap, nlines, NR[fi][c], "vn %.6f %.6f %.6f")
            tri.append((vi, ti, ni))
        by_idx.setdefault(sid2idx[sid], []).append(tri)
    nf = sum(len(v) for v in by_idx.values())
    if nf == 0:
        return 0
    with open(path, "w") as f:
        f.write("# env_geo displaced shell env=0x%08X cs=%d\n" % (env_id, cs))
        f.write("\n".join(vlines) + "\n")
        f.write("\n".join(tlines) + "\n")
        f.write("\n".join(nlines) + "\n")
        for idx in sorted(by_idx):
            f.write("usemtl surf%d\n" % idx)
            for tri in by_idx[idx]:
                f.write("f %d/%d/%d %d/%d/%d %d/%d/%d\n"
                        % (tri[0] + tri[1] + tri[2]))
    return nf


def apply(root, patched, wbt):
    cmds = []
    for line in open(os.path.join(root, "imports.jsonl")):
        j = json.loads(line)
        cmds.append(dict(command="environment-append-geometry", datPath=patched,
                         envIdHex=j["envIdHex"], cellStructIndex=j["cellStructIndex"],
                         objPath=j["objPath"]))
    inp = "\n".join(json.dumps(c) for c in cmds) + "\n"
    p = subprocess.run("DOTNET_ROLL_FORWARD=LatestMajor dotnet %s --stdin" % wbt,
                       shell=True, input=inp.encode(), capture_output=True,
                       timeout=3600)
    ok = fail = 0
    fails = []
    for line in p.stdout.decode(errors="replace").splitlines():
        line = line.strip()
        if not (line.startswith("{") and '"environment-append-geometry"' in line):
            continue
        o = json.loads(line)
        if o.get("success"):
            ok += 1
        else:
            fail += 1
            fails.append(o)
    print("apply: %d ok, %d fail of %d" % (ok, fail, len(cmds)))
    for f_ in fails[:5]:
        print("  FAIL", f_.get("envId"), f_.get("error") or f_.get("errorMessage"))
    json.dump(dict(ok=ok, fail=fail, fails=fails[:20]),
              open(os.path.join(root, "apply_results.json"), "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "build", "apply"])
    ap.add_argument("--root", required=True)
    ap.add_argument("--lb", default=None)
    ap.add_argument("--patched")
    ap.add_argument("--wbt")
    a = ap.parse_args()
    if a.cmd == "plan":
        plan(a.root, int(a.lb, 16) if a.lb else None)
    elif a.cmd == "build":
        build(a.root)
    elif a.cmd == "apply":
        assert a.patched and a.wbt
        apply(a.root, a.patched, a.wbt)


if __name__ == "__main__":
    main()
