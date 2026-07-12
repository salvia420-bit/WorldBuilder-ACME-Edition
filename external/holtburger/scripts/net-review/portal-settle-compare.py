#!/usr/bin/env python3
"""portal-settle-compare.py — tabulate portal-settle-probe JSONs side by side.

Usage: python3 portal-settle-compare.py run1.json run2.json ...
Prints one row per run: the stage metrics + blocker census + churn totals,
then a per-run long-task histogram (time since landing, 5 s bins).
"""
import json, sys, os

COLS = ["landToChatReadyMs", "landToFramesRecoveredMs", "landToCellsHalfMs",
        "landToCellsFullMs", "cellsMax", "landToSettleMs"]

def churn(d):
    tl = d.get("timeline") or []
    tland = (d.get("stages") or {}).get("tLandedMs")
    if tland is None:
        return None
    post = [b for b in tl if b["t"] >= tland and isinstance(b.get("lru"), dict)]
    if len(post) < 2:
        return None
    a, z = post[0]["lru"], post[-1]["lru"]
    def d2(k):
        va, vz = a.get(k), z.get(k)
        return (vz - va) if isinstance(va, (int, float)) and isinstance(vz, (int, float)) else None
    return {k: d2(k) for k in ("parked", "unparked", "evicted", "work")}

def main(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        s = d.get("stages") or {}
        lt = s.get("longTask") or {}
        rows.append({
            "run": os.path.basename(p).replace(".json", ""),
            "landed": d.get("ok"),
            **{c: s.get(c) for c in COLS},
            "blockers": s.get("settleBlockerCensus"),
            "lateFreezes": len(s.get("lateFreezes") or []),
            "lt_n": lt.get("n"), "lt_total": lt.get("totalMs"),
            "lt_max": lt.get("maxMs"), "lt_over500": lt.get("over500"),
            "gcDrops": s.get("gcDrops"),
            "netFail": len(d.get("netFailures") or []),
            "churn": churn(d),
            "_d": d,
        })
    hdr = ["run", "landed"] + COLS + ["lateFreezes", "lt_max", "lt_over500", "gcDrops", "netFail"]
    print("\t".join(hdr))
    for r in rows:
        print("\t".join(str(r.get(h)) for h in hdr))
    print()
    for r in rows:
        print(f"-- {r['run']}: blockers={r['blockers']} churn={r['churn']}")
        d = r["_d"]
        tland = (d.get("stages") or {}).get("tLandedMs") or 0
        hist = {}
        for e in d.get("longTasks") or []:
            if e["ms"] < 100:
                continue
            b = int((e["t"] - tland) // 5000) * 5
            hist[b] = hist.get(b, 0) + e["ms"]
        print("   longtask-ms by 5s-bin since land:",
              " ".join(f"{k}s:{v}" for k, v in sorted(hist.items())))

if __name__ == "__main__":
    main(sys.argv[1:])
