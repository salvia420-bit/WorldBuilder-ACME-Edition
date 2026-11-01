#!/usr/bin/env python3
"""summarize.py out.json in.json [...] — per-run summaries + census views (no per-second rows) from carry-runner results."""
import json, sys
out = {"schema": "hb-carry-summary-v1", "sources": [], "runs": [], "census": []}
for fn in sys.argv[2:]:
    d = json.load(open(fn))
    out["sources"].append({"file": fn, "url": d.get("url"), "render": d.get("render"), "viewport": d.get("viewport"), "startedAt": d.get("startedAt"), "errors": d.get("errors")})
    for s in d.get("steps", []):
        r = s.get("result") or {}
        rec = {"run": s.get("name"), "file": fn.split("/")[-1], "step": {k: v for k, v in (s.get("step") or {}).items() if k != "password"},
               "ace": s.get("ace"), "chrome": s.get("chrome"), "memAvailMB": s.get("memAvailMB"), "error": s.get("error"),
               "errors": r.get("errors"), "deploySec": r.get("deploySec"), "climbSec": r.get("climbSec"), "flySec": r.get("flySec")}
        if r.get("summary") and "cruiseKmhMed" in r["summary"]:
            rec["summary"] = r["summary"]
            rec["firstSeenSample"] = r.get("firstSeenSample")
            out["runs"].append(rec)
        for v in r.get("views") or []:
            out["census"].append({"file": fn.split("/")[-1], **{k: v.get(k) for k in ("label", "calls", "tris", "census", "ratio", "msPerFrame", "programs", "geometries", "textures", "agl", "eye", "camPitch", "frames", "p50", "p95", "max", "meanMs")}})
        if r.get("perSec"):
            out["glCensus"] = {"perSec": r["perSec"], "contexts": len(r.get("contexts") or [])}
json.dump(out, open(sys.argv[1], "w"), indent=1)
print(len(out["runs"]), "runs,", len(out["census"]), "census views ->", sys.argv[1])
