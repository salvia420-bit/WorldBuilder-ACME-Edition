#!/usr/bin/env python3
"""Verify the v2 plan offline with poi-kit/check.mjs (Dereth tour expansion, 2026-10-15).

usage: python3 verify2.py [plan.json] [--only=new|v1|all]
Runs check.mjs --json on every shot (one node process, sequential) and applies the acceptance thresholds the POI
designers were given: over the FULL take (the whole take is flown) min AGL ≥ 1.5 m (≥ 0.5 m for ground-level classic
lenses), nearest drawn obstacle ≥ 2.0 m for drone/fpv (≥ 1.2 m for slow classic moves), flight tracking gap ≤ 1 m and
peak ≤ preset cap; in the EDIT window subject in frame ≥ 85 % and LOS blocked ≤ 20 % (reported, not failed, when the
notes say the subject is hidden by design). v1 shots keep their verified v1 moves, so for them only the edit-window
framing numbers are reported (a window that loses the subject is a window bug).
Writes verify2_report.json next to this script and prints the failures.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = "/mnt/wbterminal2/film-projects/dereth-town-tour"
KIT = f"{PROJ}/research/poi-kit"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
only = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--only=")), "all")
PLAN = args[0] if args else f"{PROJ}/plan.json"
plan = json.load(open(PLAN))
shots = {s["id"]: s for s in plan["shots"]}
ids = [s["id"] for s in plan["shots"] if only == "all" or (only == "new") == s["site"].startswith("poi-")]
GROUND = {"classic.low-angle", "classic.worms-eye", "classic.static", "classic.pov", "classic.over-the-shoulder", "classic.two-shot",
          "classic.rack-focus", "classic.handheld", "classic.steadicam", "classic.dolly-in", "classic.dolly-out", "classic.push-in",
          "classic.truck", "classic.pan", "classic.tilt", "classic.zoom", "classic.dolly-zoom", "classic.whip-pan", "classic.reveal-from-occluder",
          "classic.pedestal", "classic.time-lapse"}
def run(planfile, idlist):
    out_ = {}
    CH = 40
    for i in range(0, len(idlist), CH):
        part = idlist[i:i + CH]
        out = subprocess.run(["node", f"{KIT}/check.mjs", planfile, *part, "--json"], capture_output=True, text=True)
        for line in out.stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                r = json.loads(line)
                out_[r["shot"]] = r
            elif line:
                sid = line.split(" ")[0].rstrip(":")
                out_[sid] = {"shot": sid, "error": line}
        print(f"checked {min(i + CH, len(idlist))}/{len(idlist)} of {os.path.basename(planfile)}", file=sys.stderr)
    return out_


res = run(PLAN, ids)
# v1 baseline: the same shots with their v1 window (plan-baseline-trim.json = v1 plan + trim of the v1 takes)
BASE = f"{PROJ}/research/windows/plan-baseline-trim.json"
v1ids = [i for i in ids if not shots[i]["site"].startswith("poi-")]
base = run(BASE, v1ids) if v1ids and os.path.exists(BASE) else {}
fails, notes = [], []
for sid in ids:
    r = res.get(sid)
    s = shots[sid]
    new = s["site"].startswith("poi-")
    if not r or "error" in r:
        fails.append(f"{sid}: {r.get('error') if r else 'no result'}")
        continue
    tk, ed = r["take"], r.get("edit") or r["take"]
    tech = s["technique"]
    byDesign = any(k in (s.get("notes") or "").lower() for k in ("by design", "hidden", "reveal", "foreground"))
    msgs = []
    if new:
        aglMin = 0.5 if tech in GROUND else 1.5
        if not (tk["minAgl"] >= aglMin):
            msgs.append(f"min AGL {tk['minAgl']} m < {aglMin}")
        slow = tech.startswith("classic.") and tk["vmax"] <= 1.5
        obsMin = 1.2 if slow else 2.0
        if tk["nearest"]["d"] < obsMin:
            msgs.append(f"nearest {tk['nearest']['d']} m {tk['nearest']['kind']} {tk['nearest']['id']} @t{tk['nearest']['t']} < {obsMin}")
        fl = r.get("flight")
        if fl and not fl.get("error"):
            if fl["maxTrackingErrorM"] > 1.0:
                msgs.append(f"flight gap {fl['maxTrackingErrorM']} m > 1")
            if fl["maxSpeed"] > fl["vmaxCap"] * 1.02:
                msgs.append(f"peak {fl['maxSpeed']} m/s > cap {fl['vmaxCap']}")
    if new:
        if ed.get("subjectInFramePct") is not None and ed["subjectInFramePct"] < 85:
            (notes if byDesign else msgs).append(f"subject in frame {ed['subjectInFramePct']}% in the edit window")
        if ed.get("los") and ed["los"]["of"] and ed["los"]["blocked"] / ed["los"]["of"] > 0.2:
            (notes if byDesign else msgs).append(f"LOS blocked {ed['los']['blocked']}/{ed['los']['of']} in the edit window ({ed['los']['first']})")
    else:  # a v1 window must not frame its subject clearly worse than the v1 edit did
        b = (base.get(sid) or {}).get("edit")
        if b and ed.get("subjectInFramePct") is not None and b.get("subjectInFramePct") is not None and ed["subjectInFramePct"] < b["subjectInFramePct"] - 20:
            msgs.append(f"subject in frame {ed['subjectInFramePct']}% vs {b['subjectInFramePct']}% in the v1 edit")
        lb = lambda x: x["los"]["blocked"] / x["los"]["of"] if x and x.get("los") and x["los"]["of"] else 0.0  # noqa: E731
        if b and lb(ed) > lb(b) + 0.2:
            msgs.append(f"LOS blocked {ed['los']['blocked']}/{ed['los']['of']} vs {round(100 * lb(b))}% in the v1 edit ({ed['los']['first']})")
    if msgs:
        fails.append(f"{sid} [{'new' if new else 'v1'} {tech}]: " + "; ".join(msgs))
json.dump({"plan": PLAN, "checked": len(ids), "fails": fails, "byDesignNotes": notes, "results": res, "v1Baseline": base}, open(f"{HERE}/verify2_report.json", "w"), indent=1)
print(f"checked {len(ids)} shot(s): {len(fails)} failing")
for f in fails:
    print("  FAIL", f)
