#!/usr/bin/env python3
"""env_geo.py -- DUNGEON GEOMETRY: pilot (lane 3) + environment-variant lane.

The wrinkle vs the building lane: CellStruct polygon surface indices resolve
through EACH EnvCell's OWN surface array -- the same prefab renders as stone in
one dungeon and ice in another.  Cell-weighted, only ~36% of slot usages have a
>=90%-dominant texture (env_idx census).

PILOT (plan/build/apply, r4-shipped): displace ONLY dominant slots in the
SHARED record -- honest but limited to the 7-shell subset.

VARIANT LANE (cluster/variant-build/variant-apply, per
docs/dat-patch/HANDOFF-env-variant-design-2026-08-16.md): mint variant
Environment records per texture-cluster and retarget each cluster's EnvCells
to the variant whose relief matches their textures.  Every variant is an exact
clone of its source (physics/portals/BSPs verbatim -- environment-clone) plus
an appended displaced shell built with THAT cluster's textures; EnvCells are
then re-pointed via envcell-retarget (in-place u16 rewrite).

Subcommands:
  plan          --root R [--lb 0x0189]   pilot: census -> plan.json
  build         --root R                 pilot: displaced shells + imports.jsonl
  apply         --root R --patched DAT --wbt DLL
  cluster       --root R [--top 300] [--min-cells 8]   -> variants.json
  variant-build --root R [--limit N]     -> obj/, variant_imports.jsonl,
                                            retargets.jsonl
  variant-apply --root R --patched-portal P --patched-cell C --wbt DLL
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


def _shell(pdat, src_env_id, cs, slot_sids, objp):
    """Shared displaced-shell path (pilot build + variant-build): parse the
    SOURCE env record, displace its eligible slots with slot_sids' textures,
    write the OBJ.  slot_sids = {int idx: '0x08......'}.  Returns a stats dict
    with ok True/False."""
    import datlib
    import pipeline
    import pilot
    import relief3d
    eid, cells = datlib.parse_environment(pdat.get(src_env_id), strict=True)
    if cs not in cells:
        return dict(ok=False, why="cellstruct absent")
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
        return dict(ok=False, why="no carveable polys")
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
    sid2idx = {int(v, 16): int(i) for i, v in slot_sids.items()}
    nf = _write_obj(objp, src_env_id, cs, res, src, sid2idx)
    if nf == 0:
        return dict(ok=False, why="no shell faces")
    return dict(ok=True, srcTris=n0, shellTris=nf, segments=segs)


def build(root):
    import datlib
    os.environ.setdefault("DATPATCH_PORTAL", PORTAL)
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
        slot_sids = {int(i): v["sid"] for i, v in slots.items()}
        objp = os.path.join(objd, "%08X_%d.obj" % (env_id, cs))
        r = _shell(pdat, env_id, cs, slot_sids, objp)
        r["pair"] = pair
        stats.append(r)
        if not r["ok"]:
            continue
        imports.append(dict(envIdHex="0x%08X" % env_id, cellStructIndex=cs,
                            objPath=objp))
        print("  %s: src %d tris -> shell %d" % (pair, r["srcTris"], r["shellTris"]))
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


def cluster(root, top=300, min_cells=8):
    """Variant lane step 1: group wall-cells of the --top (env,cs) pairs by
    their exact wall-slot surface tuple; every surviving cluster becomes one
    variant Environment to mint.  All-or-none per landblock: a LB ships only
    if EVERY wall-cell in it lands in a surviving cluster (else relief seams
    at cell boundaries -- handoff section 4).

    FUTURE OPT (not v1): within a pair the largest cluster could keep the
    ORIGINAL env id (relief onto the source record, no clone/retarget) -- but
    only when every OTHER user of that env world-wide is retargeted away,
    which needs global analysis.  v1 keeps it simple and safe: every cluster
    gets a fresh id; source records are never displaced."""
    from collections import Counter, defaultdict
    os.environ.setdefault("DATPATCH_PORTAL", PORTAL)
    import datlib
    import pipeline
    import pilot
    os.makedirs(root, exist_ok=True)

    # pass 1: distinct sid16s -> wall eligibility (cls + usable height field).
    # Memo off + one-at-a-time so ~800 height fields don't accumulate in RAM;
    # we only keep the boolean.
    sids16 = set()
    for _oid, _env, _cs, surfs in _cell_walk():
        sids16.update(surfs)
    saved_memo = pipeline.memo_enabled
    pipeline.memo_enabled = False
    wall16 = set()
    try:
        for s in sorted(sids16):
            m = pipeline.surface_meta({0x08000000 | s})[0x08000000 | s]
            if m["cls"] in pilot.WALL_CLASSES and m.get("h") is not None:
                wall16.add(s)
    finally:
        pipeline.memo_enabled = saved_memo
    print("cluster: %d/%d distinct cell surfaces wall-eligible"
          % (len(wall16), len(sids16)))

    # pass 1.5: carve-slot sets per (env16, cs) over ALL Environment records —
    # slot i carves iff some DRAWN, non-portal, non-NoPos polygon uses it as
    # its pos surface.  Signatures below only include carving slots, so a
    # slot that never carves can neither mint a variant ("no carveable
    # polys") nor block a landblock's all-or-none coverage.
    pdat = datlib.Dat(PORTAL)
    carve_slots = {}
    for eoid in pdat.files:
        if not (0x0D000000 <= eoid <= 0x0D00FFFF):
            continue
        _eid, ecells = datlib.parse_environment(pdat.get(eoid))
        for ecs, c in ecells.items():
            portal_keys = set(c["portals"])
            carve_slots[(eoid & 0xFFFF, ecs)] = {
                p["pos"] for p in c["polys"]
                if p["key"] not in portal_keys and not (p["stip"] & 0x4)
                and p["pos"] >= 0}
    print("cluster: carve slots computed for %d (env,cs) cellstructs"
          % len(carve_slots))

    # pass 2: per-cell wall signature (slot index, sid16) tuples, interned;
    # wall-eligible AND carving for this cell's (env,cs)
    sigs = {}
    sig_list = []
    wall_cells = []                     # (oid, env, cs, sig id)
    empty_carve = set()
    for oid, env, cs, surfs in _cell_walk():
        cset = carve_slots.get((env, cs), empty_carve)
        sig = tuple((i, s) for i, s in enumerate(surfs)
                    if s in wall16 and i in cset)
        if not sig:
            continue
        g = sigs.get(sig)
        if g is None:
            g = sigs[sig] = len(sig_list)
            sig_list.append(sig)
        wall_cells.append((oid, env, cs, g))

    pair_count = Counter((env, cs) for _o, env, cs, _g in wall_cells)
    selected = {p for p, _n in pair_count.most_common(top)}
    clusters = defaultdict(list)        # (env, cs, sigid) -> [oid]
    for oid, env, cs, g in wall_cells:
        if (env, cs) in selected:
            clusters[(env, cs, g)].append(oid)
    surviving = {k: v for k, v in clusters.items() if len(v) >= min_cells}

    covered = set()
    for v in surviving.values():
        covered.update(v)
    lb_ok = {}
    for oid, _env, _cs, _g in wall_cells:
        lb = oid >> 16
        if oid not in covered:
            lb_ok[lb] = False
        elif lb not in lb_ok:
            lb_ok[lb] = True

    variants = []
    retargets = 0
    for (env, cs, g), oids in sorted(surviving.items(),
                                     key=lambda kv: (-len(kv[1]), kv[0])):
        keep = [o for o in oids if lb_ok[o >> 16]]
        if keep:
            variants.append((env, cs, g, keep))
            retargets += len(keep)

    used = {oid & 0xFFFF for oid in pdat.files
            if 0x0D000000 <= oid <= 0x0D00FFFF}
    nxt = max(used) + 1
    out = []
    for env, cs, g, keep in variants:
        while nxt in used:
            nxt += 1
        if nxt > 0xFFFF:
            raise SystemExit("env id space exhausted (needed %d variants)"
                             % len(variants))
        out.append(dict(newEnvIdHex="0x%08X" % (0x0D000000 | nxt),
                        sourceEnvIdHex="0x%08X" % (0x0D000000 | env),
                        cs=cs,
                        slots={str(i): "0x%08X" % (0x08000000 | s)
                               for i, s in sig_list[g]},
                        cellCount=len(keep),
                        cells=["0x%08X" % o for o in sorted(keep)]))
        nxt += 1

    lbs_full = sum(1 for ok in lb_ok.values() if ok)
    stats = dict(wallCells=len(wall_cells), wallSids=len(wall16),
                 distinctSigs=len(sig_list), pairsSelected=len(selected),
                 clustersRaw=len(clusters), clustersSurviving=len(surviving),
                 coveredWallCells=len(covered),
                 lbsTouched=len(lb_ok), lbsFullyCovered=lbs_full,
                 variants=len(out), retargets=retargets)
    json.dump(dict(params=dict(top=top, minCells=min_cells),
                   stats=stats, variants=out),
              open(os.path.join(root, "variants.json"), "w"), indent=1)
    print("cluster: %d wall-cells, %d selected pairs -> %d clusters "
          "(>=%d cells) covering %d cells" % (len(wall_cells), len(selected),
                                              len(surviving), min_cells,
                                              len(covered)))
    print("  LB all-or-none: %d/%d LBs fully covered -> %d variants, "
          "%d retargets (%.0f%% of wall-cells) -> %s/variants.json"
          % (lbs_full, len(lb_ok), len(out), retargets,
             100.0 * retargets / max(1, len(wall_cells)), root))
    return stats


def variant_build(root, limit=None, shard=None):
    """Variant lane step 2: displaced shell per variant (source geometry +
    the CLUSTER's textures) -> obj/, variant_imports.jsonl, retargets.jsonl.
    --shard i/n takes every n-th variant starting at i and suffixes the three
    output files with .shard<i> (concatenate/merge after a fan-out); OBJs are
    keyed by variant id so shards never collide in obj/."""
    import datlib
    os.environ.setdefault("DATPATCH_PORTAL", PORTAL)
    pdat = datlib.Dat(PORTAL)
    vj = json.load(open(os.path.join(root, "variants.json")))
    objd = os.path.join(root, "obj")
    os.makedirs(objd, exist_ok=True)
    vs = vj["variants"]
    sfx = ""
    if shard:
        i, n = (int(x) for x in shard.split("/"))
        vs = vs[i::n]
        sfx = ".shard%d" % i
    if limit:
        vs = vs[:limit]
    imports = []
    stats = []
    n_ret = 0
    with open(os.path.join(root, "retargets.jsonl" + sfx), "w") as rf:
        for v in vs:
            src_id = int(v["sourceEnvIdHex"], 16)
            new_id = int(v["newEnvIdHex"], 16)
            cs = v["cs"]
            objp = os.path.join(objd, "%08X_%d.obj" % (new_id, cs))
            r = _shell(pdat, src_id, cs,
                       {int(i): sid for i, sid in v["slots"].items()}, objp)
            r["newEnvIdHex"] = v["newEnvIdHex"]
            r["sourceEnvIdHex"] = v["sourceEnvIdHex"]
            r["cs"] = cs
            r["cells"] = v["cellCount"]
            stats.append(r)
            if not r["ok"]:
                # no shell -> no clone/retarget; those cells keep the source
                # env (today's flat look, never a dangling reference)
                continue
            imports.append(dict(sourceIdHex=v["sourceEnvIdHex"],
                                newEnvIdHex=v["newEnvIdHex"],
                                cellStructIndex=cs, objPath=objp))
            env16 = "0x%04X" % (new_id & 0xFFFF)
            for c in v["cells"]:
                rf.write(json.dumps(dict(cellIdHex=c, environmentIdHex=env16))
                         + "\n")
                n_ret += 1
            print("  %s cs%d (%d cells): src %d tris -> shell %d"
                  % (v["newEnvIdHex"], cs, v["cellCount"], r["srcTris"],
                     r["shellTris"]))
    json.dump(stats, open(os.path.join(root, "variant_build_stats.json" + sfx),
                          "w"), indent=1)
    with open(os.path.join(root, "variant_imports.jsonl" + sfx), "w") as f:
        for i in imports:
            f.write(json.dumps(i) + "\n")
    ok = sum(1 for s in stats if s.get("ok"))
    print("variant-build: %d/%d variants -> OBJs; %d retargets; "
          "variant_imports.jsonl + retargets.jsonl written"
          % (ok, len(stats), n_ret))


def variant_apply(root, patched_portal, patched_cell, wbt):
    """Variant lane step 3: clone -> append -> retarget through WBT."""
    imports = [json.loads(l)
               for l in open(os.path.join(root, "variant_imports.jsonl"))]
    if not imports:
        raise SystemExit("no variant imports -- run variant-build first")
    cmds = [dict(command="environment-clone", datPath=patched_portal,
                 clones=[dict(sourceIdHex=i["sourceIdHex"],
                              newIdHex=i["newEnvIdHex"]) for i in imports])]
    # batch appends (one portal open per chunk -- a per-append open of the
    # 1.6 GB dat dominates a 4k-shell run)
    CHUNK = 500
    for c0 in range(0, len(imports), CHUNK):
        cmds.append(dict(command="environment-append-geometry",
                         datPath=patched_portal,
                         appends=[dict(envIdHex=i["newEnvIdHex"],
                                       cellStructIndex=i["cellStructIndex"],
                                       objPath=i["objPath"])
                                  for i in imports[c0:c0 + CHUNK]]))
    cmds.append(dict(command="envcell-retarget", datPath=patched_cell,
                     jsonlPath=os.path.join(root, "retargets.jsonl")))
    inp = "\n".join(json.dumps(c) for c in cmds) + "\n"
    p = subprocess.run("DOTNET_ROLL_FORWARD=LatestMajor dotnet %s --stdin" % wbt,
                       shell=True, input=inp.encode(), capture_output=True,
                       timeout=14400)
    per = {}
    fails = []
    for line in p.stdout.decode(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        cmd = o.get("command")
        if cmd not in ("environment-clone", "environment-append-geometry",
                       "envcell-retarget"):
            continue
        d = per.setdefault(cmd, dict(ok=0, fail=0))
        bad = (not o.get("success")) or o.get("failCount", 0) > 0
        d["fail" if bad else "ok"] += 1
        if bad:
            fails.append(o)
    for cmd, d in per.items():
        print("  %s: %d ok, %d fail" % (cmd, d["ok"], d["fail"]))
    for f_ in fails[:5]:
        print("  FAIL", json.dumps(f_)[:300])
    json.dump(dict(per=per, fails=fails[:20]),
              open(os.path.join(root, "variant_apply_results.json"), "w"),
              indent=1)
    total_fail = sum(d["fail"] for d in per.values())
    print("variant-apply: %s (%d command responses, %d with failures)"
          % ("OK" if total_fail == 0 else "FAILURES",
             sum(d["ok"] + d["fail"] for d in per.values()), total_fail))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "build", "apply", "cluster",
                                    "variant-build", "variant-apply"])
    ap.add_argument("--root", required=True)
    ap.add_argument("--lb", default=None)
    ap.add_argument("--patched")
    ap.add_argument("--wbt")
    ap.add_argument("--top", type=int, default=300)
    ap.add_argument("--min-cells", type=int, default=8)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--shard", default=None, help="i/n slice for fan-out")
    ap.add_argument("--patched-portal")
    ap.add_argument("--patched-cell")
    a = ap.parse_args()
    if a.cmd == "plan":
        plan(a.root, int(a.lb, 16) if a.lb else None)
    elif a.cmd == "build":
        build(a.root)
    elif a.cmd == "apply":
        assert a.patched and a.wbt
        apply(a.root, a.patched, a.wbt)
    elif a.cmd == "cluster":
        cluster(a.root, a.top, a.min_cells)
    elif a.cmd == "variant-build":
        variant_build(a.root, a.limit, a.shard)
    elif a.cmd == "variant-apply":
        assert a.patched_portal and a.patched_cell and a.wbt
        variant_apply(a.root, a.patched_portal, a.patched_cell, a.wbt)


if __name__ == "__main__":
    main()
