# s1_eval_report.py - scorer for the S1 queue's hbanatomy --eval runs (s1.eval.js route / indoor / diag / ctxloss).
# Lane Q wrote it inside the queue (batch-R3-S1-2026-10-30.json `evalScripts`); lane Q2 (2026-10-30) promoted it
# here: it skips browser traces (*.trace.json) and trace-split sidecars by NAME before any json load, reads the
# per-window GL upload bytes and the rigPoseSkip skip rate, lists every pass-condition problem s1.eval.js
# recorded, and checks the hbbench arms' gateInfo (`bench-checks`). Changes nothing; reads JSON only.
# From external/holtburger (tests/s1_queue.test.mjs runs it on synthetic runs):
#   python3 -I scripts/perf-worker/s1_eval_report.py --queue <queue.json> --item <ID> --ref <arm> [--aa <arm>]
#           [--noisy-box] [--json OUT] EVAL.json ...
#   python3 -I scripts/perf-worker/s1_eval_report.py bench-checks [--json OUT] <hbbench out dir> ...
# Rule V per arm-rep is hbreport.assess (box samples, run-JSON asserts, console errors, the server-state pin
# against --ref, the queue's gate for the arm, the queue's boxEvents); then per arm the median (min-max) over
# VALID / NOISY-BOX reps and hbreport.compare (rule R1: noise = max(|A - A'|, half of A's rep spread); real
# only beyond max(2 x noise, 3 % fps or 0.5 ms or 1 frame)) against --ref with --aa as the A/A.
# A trace split next to an eval JSON (<eval>.split.json = `hbreport.py trace-split <trace> --marks hbS1: --json
# <eval>.split.json`) adds mainBusyPerPresent / crGpuMainPerPresent / webglPerPresent per marked window.
# Driver problems (result.problems: a hop not arrived or not landed, a failed ctxloss / bakeFallbackWaves
# check) are listed per rep as pass-condition failures; they do not change the rule V status.
import argparse
import datetime as dt
import glob
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import hbreport as H  # noqa: E402

FRAME_METRICS = ("fps", "p50", "p95", "max", "h100", "h250", "jankMs")
SPLIT_METRICS = ("mainBusyPerPresent", "crGpuMainPerPresent", "webglPerPresent")
# never json-loaded: a browser trace (~75 s of trace events) and the trace-split sidecar of an eval JSON
SKIP_SUFFIXES = (".trace.json", ".split.json", ".frames.json")
RUN_JSON = re.compile(r"-r\d+\.json$")


def skipped_name(path):
    """Why a file given on the command line is not an eval run JSON (by name only), or None."""
    base = os.path.basename(path)
    for s in SKIP_SUFFIXES:
        if base.endswith(s):
            return "%s file" % s
    return None


def metrics_of(res, split):
    """{(window, metric): value} of one eval result (route or indoor)."""
    out = {}

    def put(win, d, keys=FRAME_METRICS):
        for k in keys:
            if isinstance(d, dict) and isinstance(d.get(k), (int, float)) and not isinstance(d.get(k), bool):
                out[(win, k)] = float(d[k])
    if not isinstance(res, dict):
        return out
    if res.get("mode") == "route":
        put("turn0", (res.get("turn0") or {}).get("frames"))
        route = res.get("route") or {}
        put("hops", route.get("hops"))
        put("hopTurns", route.get("hopTurns"))
        if isinstance(route.get("loafMaxMs"), (int, float)):
            out[("loaf", "max")] = float(route["loafMaxMs"])
        for k, m in (("contentMsMed", "p50"), ("contentMsMax", "max")):
            if isinstance(route.get(k), (int, float)):
                out[("content", m)] = float(route[k])
    elif res.get("mode") == "indoor":
        for win, w in (res.get("windows") or {}).items():
            put(win, (w or {}).get("frames"))
    for w in (split or {}).get("windows", []) or []:
        label = str(w.get("window", ""))
        if label.startswith("hbS1:") and label != "hbS1:gap":
            win = label[len("hbS1:"):]
            put(win, w, SPLIT_METRICS)
    return out


def upload_windows(res):
    """Buffer bytes (bufferData + bufferSubData) and all upload bytes per window of a countUploads route run,
    summed over the hops, plus the turn window's share of the hop buffer bytes; None without upload reads."""
    route = (res or {}).get("route") or {}
    u = route.get("uploads")
    if not isinstance(u, dict):
        return None
    out = {}
    for k in ("turn0", "arrive", "turn", "content"):
        w = u.get(k) or {}
        b = w.get("bytes") or {}
        out[k] = {"bufferBytes": int(b.get("bufferData", 0) + b.get("bufferSubData", 0)) if w else None,
                  "totalBytes": w.get("totalBytes")}
    tot = sum((out[k]["bufferBytes"] or 0) for k in ("arrive", "turn", "content"))
    out["turnShareOfBufferBytes"] = round((out["turn"]["bufferBytes"] or 0) / float(tot), 3) if tot else None
    return out


def fallback_waves_check(s, seq=None):
    """Python twin of s1.eval.js fallbackWavesCheck (tests/s1_queue.test.mjs pins both on the same fixtures).
    maxIds is the largest REQUEST (bake_worker_client.js _noteFallbackWaves), never a wave bound."""
    if s is None:
        return {"mode": "off", "problems": []}
    p = []
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)  # noqa: E731
    for k in ("cap", "calls", "split", "waves", "yields", "maxIds"):
        if not num(s.get(k)):
            p.append("stats().%s missing" % k)
    if p:
        return {"mode": "fallback", "problems": p}
    if num(seq) and seq > 1:
        if s["calls"] != 0:
            p.append("worker served (seq %s) yet %s main-thread request(s) ran armed (a crash window or a worker error reply)" % (seq, s["calls"]))
        return {"mode": "worker", "problems": p}
    if not s["cap"] >= 2:
        p.append("cap %s < 2: not armed" % s["cap"])
    if not s["calls"] > 0:
        p.append("calls 0: no main-thread request ran armed")
    if not s["split"] > 0:
        p.append("split 0: no request was longer than one wave")
    if s["waves"] < s["calls"] + s["split"]:
        p.append("waves %s < calls %s + split %s (a split request runs >= 2 waves)" % (s["waves"], s["calls"], s["split"]))
    if s["split"] > 0 and not s["maxIds"] > s["cap"]:
        p.append("split %s with maxIds %s <= cap %s (only a request longer than the cap splits)" % (s["split"], s["maxIds"], s["cap"]))
    if s["split"] > 0 and not s["yields"] > 0:
        p.append("yields 0: no later wave ran in its own task")
    if s["yields"] > s["waves"] - s["calls"]:
        p.append("yields %s > waves - calls = %s" % (s["yields"], s["waves"] - s["calls"]))
    for t, b in (s.get("byType") or {}).items():
        if not isinstance(b, dict) or not (b.get("calls") or 0) > 0:
            continue
        if b["waves"] < b["calls"] + b["split"]:
            p.append("%s: waves %s < calls %s + split %s" % (t, b["waves"], b["calls"], b["split"]))
        if t != "fetchEntitySurfacesPixelsBatch":
            need = b["calls"] - 1 + max(1, int(math.ceil(b["maxIds"] / float(s["cap"]))))
            if b["waves"] < need:
                p.append("%s: waves %s < calls - 1 + ceil(maxIds %s / cap %s) = %s (its largest request was not cut at the cap)"
                         % (t, b["waves"], b["maxIds"], s["cap"], need))
    return {"mode": "fallback", "problems": p}


def skip_rate(st):
    """rigPoseSkip skipped / (posed + skipped) of one stats() read (cumulative since boot); None without one."""
    if not isinstance(st, dict) or not all(isinstance(st.get(k), (int, float)) for k in ("posed", "skipped")):
        return None
    n = st["posed"] + st["skipped"]
    return round(st["skipped"] / float(n), 3) if n else None


def load_eval(files, now):
    reps, skipped = [], []
    for f in files:
        why = skipped_name(f)
        if why:
            skipped.append((f, why))
            continue  # a trace / sidecar: never json-loaded here (the split is read with its eval JSON)
        raw = H.load_json(f)
        if not isinstance(raw, dict) or raw.get("schema") != "hbanatomy-eval-v1":
            skipped.append((f, "not an hbanatomy --eval run JSON"))
            continue
        sp = f[:-5] + ".split.json" if f.endswith(".json") else None
        split = H.load_json(sp) if sp and os.path.exists(sp) else None
        res = raw.get("result") or {}
        reps.append({"file": f, "dir": os.path.dirname(f), "arm": raw.get("arm"), "rep": raw.get("rep"), "raw": raw,
                     "error": raw.get("error"), "errors": raw.get("errors") or [], "gpu": raw.get("gpu"),
                     "start": H.parse_iso(raw.get("startedAt")) or now, "end": H.parse_iso(raw.get("endedAt")) or now,
                     "m": metrics_of(res, split), "problems": res.get("problems") or [],
                     "uploads": upload_windows(res), "rpsRate": res.get("rigPoseSkipRate")})
    return reps, skipped


def main(argv):
    if argv and argv[0] == "bench-checks":
        return bench_checks(argv[1:])
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True)
    ap.add_argument("--item", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--aa")
    ap.add_argument("--noisy-box", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args(argv)
    queue = H.load_json(a.queue)
    events = H.load_box_events(a.queue)
    gates = H.queue_gates(queue, a.item)
    now = dt.datetime.now(dt.timezone.utc)
    reps, skipped = load_eval(a.files, now)
    for f, why in skipped:
        print("  skip %s: %s" % (f, why))
    H.assess(reps, {}, events, ref=a.ref, noisy_box=a.noisy_box, aa=a.aa, gates=gates)
    arms = []
    for r in reps:
        if r["arm"] not in arms:
            arms.append(r["arm"])
    stats = {}
    for arm in arms:
        rs = [r for r in reps if r["arm"] == arm and r["status"] in ("VALID", "NOISY-BOX")]
        row = {}
        for key in sorted({k for r in rs for k in r["m"]}):
            vals = [r["m"][key] for r in rs if key in r["m"]]
            row[key] = {"med": H.median(vals), "min": min(vals), "max": max(vals), "n": len(vals), "values": vals}
        stats[arm] = row
    out = {"item": a.item, "ref": a.ref, "aa": a.aa, "reps": [], "compare": {}, "skipped": [f for f, _ in skipped]}
    print("== S1 eval report  item %s  (ref %s, A/A %s)" % (a.item, a.ref, a.aa or "none: R1 noise = half of the ref's rep spread"))
    print("-- rule V per arm-rep")
    for r in reps:
        out["reps"].append({"file": r["file"], "arm": r["arm"], "rep": r["rep"], "status": r["status"], "reasons": r["reasons"],
                            "problems": r["problems"], "uploads": r["uploads"], "rigPoseSkipRate": r["rpsRate"]})
        print("  %-22s r%s  %-12s %s" % (r["arm"], r["rep"], r["status"], "; ".join(r["reasons"])[:160]))
    print("-- pass conditions (s1.eval.js result.problems; empty = every driver check passed)")
    for r in reps:
        print("  %-22s r%s  %s" % (r["arm"], r["rep"], ("FAIL " + "; ".join(r["problems"])[:240]) if r["problems"] else "ok"))
    if any(r["uploads"] for r in reps):
        print("-- GL upload bytes per window (countUploads runs; buffer = bufferData + bufferSubData, summed over the hops)")
        for r in reps:
            u = r["uploads"]
            if u:
                print("  %-22s r%s  turn0 %s  arrive %s  turn %s  content %s  turn share %s" % (
                    r["arm"], r["rep"], u["turn0"]["bufferBytes"], u["arrive"]["bufferBytes"], u["turn"]["bufferBytes"],
                    u["content"]["bufferBytes"], u["turnShareOfBufferBytes"]))
    if any(r["rpsRate"] for r in reps):
        print("-- rigPoseSkip over the run (end stats() minus start stats())")
        for r in reps:
            s = r["rpsRate"]
            if s:
                print("  %-22s r%s  posed %s skipped %s probed %s routeChanged %s violations %s  skip rate %s" % (
                    r["arm"], r["rep"], s.get("posed"), s.get("skipped"), s.get("probed"), s.get("routeChanged"), s.get("violations"), s.get("rate")))
    print("-- R1 vs %s (median over valid reps)" % a.ref)
    for arm in arms:
        if arm == a.ref:
            continue
        out["compare"][arm] = {}
        for key in sorted(set(stats.get(a.ref, {})) & set(stats.get(arm, {}))):
            c = H.compare(stats, a.ref, a.aa, arm, key[0], key[1])
            if c:
                out["compare"][arm]["%s.%s" % key] = c
                print("  %-16s %-34s ref %9.2f arm %9.2f delta %+9.2f thr %7.2f  %s" % (arm, "%s.%s" % key, c["ref"], c["arm"], c["delta"], c["threshold"], c["verdict"]))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=1)
    return 0


def bench_checks(argv):
    """The hbbench arms' gateInfo pass conditions (read after the settle): bakeFallbackWaves (S1-BW0 BFW-on,
    gateInfo {seq, waves}) and the rigPoseSkip skip rate since boot (S1-BENCH RPS-on, gateInfo = stats())."""
    ap = argparse.ArgumentParser(prog="s1_eval_report.py bench-checks")
    ap.add_argument("--json")
    ap.add_argument("dirs", nargs="+")
    a = ap.parse_args(argv)
    rows = []
    for d in a.dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.json"))):
            if skipped_name(f) or not RUN_JSON.search(os.path.basename(f)):
                continue  # run.json, *.frames.json, traces: not an arm-rep
            raw = H.load_json(f)
            gi = ((raw.get("gate") or {}).get("info")) if isinstance(raw, dict) else None
            if not isinstance(gi, dict):
                continue
            row = {"file": f, "arm": raw.get("arm"), "rep": raw.get("rep")}
            if "waves" in gi:
                row["bakeFallbackWaves"] = fallback_waves_check(gi.get("waves"), gi.get("seq"))
            if "posed" in gi and "skipped" in gi:
                row["rigPoseSkip"] = {"skipRateSinceBoot": skip_rate(gi), "routeChanged": gi.get("routeChanged"),
                                      "probed": gi.get("probed"), "skipped": gi.get("skipped")}
            if len(row) > 3:
                rows.append(row)
    print("== S1 bench gateInfo checks (after the settle)")
    for r in rows:
        bits = []
        if "bakeFallbackWaves" in r:
            c = r["bakeFallbackWaves"]
            bits.append("bakeFallbackWaves %s %s" % (c["mode"], ("FAIL " + "; ".join(c["problems"])) if c["problems"] else "ok"))
        if "rigPoseSkip" in r:
            bits.append("rigPoseSkip skip rate since boot %s" % r["rigPoseSkip"]["skipRateSinceBoot"])
        print("  %-14s r%s  %s" % (r["arm"], r["rep"], " | ".join(bits)))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=1)
    return 1 if any(r.get("bakeFallbackWaves", {}).get("problems") for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
