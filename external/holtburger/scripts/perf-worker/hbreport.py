#!/usr/bin/env python3
"""hbreport.py - harness v2 report: the round-3 decision rules applied to 1070 run data.

Round 3, step R3-0 (apps/holtburger-web/docs/2026-10-29-round3-gpu-driven.md section 3 R3-0 item 2,
section 5). Written 2026-10-30. Reads what hbbench.mjs / hbanatomy.mjs write (v1 and v2 run JSON),
the profile runs (hbsess.mjs boot logs, *.systems.txt from profile_systems.py, *-loaf.json from
loaf-stalls.eval.js), Chrome traces, and WebAC's measure-perf JSON (M1c). It changes nothing.

Rules implemented (text copied in docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json):
  V   validity per arm-rep: idle < 60 s in any box sample; gpu3d_other > 5 %; a non-test process at
      >= 1 core-equivalent (read as >= 0.95: CPU-time delta / wall time over a ~2 s window reads a
      process pegging one core at 0.96-1.0, so a literal >= 1.0 would miss bench 1's 0.998 Seagate
      Toolkit sample; the stricter side of the plan's [D] threshold); entity count off the
      reference arm by > 10 %; console errors > 0; dev wasm; wrong adapter; the run-JSON asserts (URL
      pins, DayGroup, the skytime read-back, the INNER window within 2 px of the arm's target) and
      EVERY entry of the driver's own `assertProblems` (lib/hb_v2.mjs runAssertProblems; a null
      assert is not applicable, so a --compat v1 rep with no window target / DayGroup / skytime pin is
      not INVALID for that alone); an arm.gate that read false (hbbench stops the rep: INVALID, never a
      loss); with --queue, an arm the queue gates (O-rigs: mode 'rigs' and cellsSkipped > 0;
      rustEntityWorld: projections === 1, an arm in `removedArms` since the flag was deleted
      2026-10-30, still gated for the stored runs) whose rep did not evaluate exactly that gate true (a rep
      from an older queue or a snapshot that predates the flag may be a silent A/A). Box samples = the run
      JSON's own (v2) PLUS the dir's boxwatch.log samples inside the rep's window (v1, and the
      `--compat v1` reps whose own samples sit only before launch and after the tour). Plus the manual
      BOX-EVENT list (a hog nobody sampled, e.g. bench 1's Seagate Toolkit): an arm-rep that overlaps
      a cpu-hog event is CONTAMINATED. INVALID / CONTAMINATED / INCOMPLETE reps are never averaged.
      Fallback (--noisy-box; plan: "accept 5 reps with a reported A/A noise in place of the idle
      gate"): an arm whose ONLY rule-V failure is the idle gate gets accepted when it has >= 5 such
      or valid reps and the A/A arm (--aa) is in the run, marked NOISY-BOX. gpu3d_other and every
      other reason still invalidate.
  R1  noise = max(|A - A'|, half of A's rep spread); a delta is real only if it exceeds
      max(2 x noise, 3 % of A for fps, 0.5 ms for ms metrics, 1 for frame counts).
  R2  scoring rows: still / moving / tour fps, p50 / p95, h100 / h250 / max / jank, the binding
      thread's ms when an anatomy exists; heading-binned draws next to multidraw ranges (v2).
  R3  keep only if (i) binding-thread ms moved >= 50 % of the prediction, (ii) one fps segment
      improved by a real delta and none regressed by one, (iii) hitch metrics not worse by a real
      delta, (iv) 0 console errors, (v) look gate passed; otherwise REVERT, INCONCLUSIVE when an
      input is missing. (i) reads `--anatomy DIR`: EVERY hbanatomy rep of the arm and of the ref arm,
      rule V per rep (an INVALID rep is never averaged; a queue-gated arm's rep must have evaluated
      its gate), the median over the valid reps, and the move must be real under R1 with the noise
      from those reps (A/A anatomy reps when present, else half the ref's rep spread). Predictions
      and gates come from the bench dirs' own queue item. The hitch-change reading of (i) / (ii) the
      plan's R3 gained on 2026-10-30 (first-turn max and h100, for R3-2's upload draw and worker-wait
      fixes) is NOT applied here: such an arm's (i) / (ii) are read by hand from the hitch rows.
  R5  routing: binding thread = the largest of main busy per frame, CrGpuMain per present, GPU ms.
  R6  a structural lane delivering < 50 % of its predicted ms at stage A stops.
  R8  `ceiling`: PROCEED only when V1 or V2 cuts BOTH main-thread world-render ms (the probe's render
      ms) AND CrGpuMain WEBGL ms per present (trace-split of its hbSC: windows) by >= 40 % against V0;
      RE-SCOPE when no variant can (a measured half below 40 %); INCONCLUSIVE when a variant passes the
      half that was measured and the other half is missing (no trace split, no V1/V2 windows).
  (R4 look, R7 tier presets, R9 WebGPU, R10 reference clients are owner / rc-eye / probe decisions,
  printed as reminders.)

Usage (python3 -I; every subcommand takes --json OUT for the machine-readable result):
  hbreport.py bench DIR [DIR ...] [--box-events FILE] [--ref ARM] [--aa ARM] [--local-tz=-02:30]
                                  [--noisy-box] [--queue FILE] [--look ARM=pass|fail ...] [--anatomy DIR]
      every DIR must have run the same queue item (its run.json `item` / `--item`, or none for all):
      dirs of different items are REFUSED (exit 2), since arm names such as A / A-AA repeat across
      items and their reps would pool into one arm
  hbreport.py profile DIR [--box-events FILE] [--local-tz=-02:30]
  hbreport.py trace-split TRACE [--marks PREFIX]
  hbreport.py anatomy FILE [FILE ...]          ledger v0 rows + R5 binding thread
  hbreport.py program-diff A.json B.json       anatomy (or program-key list) JSON -> key diff
  hbreport.py ceiling FILE [--trace-split FILE] structure-ceiling probe -> R8
  hbreport.py m1c --h DIR [--w FILE ...]       WebAC W vs our H arms (bounds only, rule R10)
--local-tz takes the laptop's offset with `=` (argparse reads a bare -02:30 as an option); default =
the system zone. boxwatch.log times are laptop-local wall clock.
The box-event file is a JSON list of {from, until, kind, what} or any JSON with a `boxEvents` list
(the M1 queue file carries the 10-29 Seagate Toolkit event).
"""
import argparse
import collections
import datetime as dt
import glob
import json
import math
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

SEGMENTS = ("firstTurn", "still", "moving", "tour")
FPS_SEGMENTS = ("still", "moving", "tour")
# metric -> kind: fps (higher better, 3 %), ms (lower better, 0.5 ms), count (lower better, 1)
METRIC_KIND = {"fps": "fps", "p50": "ms", "p95": "ms", "p99": "ms", "max": "ms", "jankMs": "ms",
               "h50": "count", "h100": "count", "h250": "count", "low1": "fps", "low01": "fps"}
HITCH_ROWS = (("firstTurn", "max"), ("firstTurn", "h100"), ("tour", "h100"), ("tour", "h250"),
              ("tour", "max"), ("tour", "jankMs"), ("still", "p99"), ("moving", "p99"))
IDLE_MIN_S = 60
GPU3D_OTHER_MAX = 5.0
CPU_HOG_CORES = 0.95  # ">= 1 core-equivalent", rounded over a ~2 s sample
ENTITY_DELTA_MAX = 0.10
WINDOW_TOLERANCE_PX = 2  # lib/hb_v2.mjs runAssertProblems: the INNER window may be off by 2 px
V_SOFT = ("idle",)  # the only reason the noisy-box fallback waives (plan section 5 V: "in place of the idle gate")
NOISY_BOX_MIN_REPS = 5
R8_CUT = 0.40  # rule R8: V1/V2 must cut BOTH main-thread world-render ms and CrGpuMain WEBGL ms by >= 40 %


# ------------------------------------------------------------------------------------------------
# small helpers
# ------------------------------------------------------------------------------------------------
def half_up(x, places=2):
    """Round half up on the decimal value (the plan's rounding; float round() is banker's/binary)."""
    if x is None:
        return None
    q = Decimal(1).scaleb(-places)
    return float(Decimal(str(x)).quantize(q, rounding=ROUND_HALF_UP))


def dmean(values, places=2):
    """Mean of decimal-text-exact values, rounded half up."""
    vals = [Decimal(str(v)) for v in values if v is not None]
    if not vals:
        return None
    m = sum(vals) / Decimal(len(vals))
    return float(m.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def parse_tz(s):
    if s is None:
        return None
    m = re.match(r"^([+-])(\d{1,2}):?(\d{2})$", s.strip())
    if not m:
        raise ValueError("--local-tz wants +HH:MM / -HH:MM")
    sign = -1 if m.group(1) == "-" else 1
    return dt.timezone(sign * dt.timedelta(hours=int(m.group(2)), minutes=int(m.group(3))))


def local_tz(arg=None):
    tz = parse_tz(arg) if arg else None
    return tz or dt.datetime.now().astimezone().tzinfo


def from_epoch(ts, tz):
    return dt.datetime.fromtimestamp(ts, tz)


def parse_iso(s):
    if not s:
        return None
    s = str(s).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        raise ValueError("box-event / run times need an explicit offset: %s" % s)
    return d


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------------------------------------------
# box events and box samples
# ------------------------------------------------------------------------------------------------
def load_box_events(path):
    if not path:
        return []
    j = load_json(path)
    evs = j.get("boxEvents", []) if isinstance(j, dict) else j
    out = []
    for e in evs:
        out.append({"id": e.get("id"), "kind": e.get("kind", "cpu-hog"), "what": e.get("what", ""),
                    "from": parse_iso(e["from"]), "until": parse_iso(e["until"])})
    return out


def overlapping_events(events, start, end):
    return [e for e in events if e["from"] < end and start < e["until"]]


def parse_boxwatch(path, tz, anchor_date):
    """boxwatch.log: 'HH:MM:SS k=v ...' lines in laptop local time -> [(aware dt, {k: v})]."""
    out = []
    if not path or not os.path.exists(path):
        return out
    day = anchor_date
    prev = None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.match(r"^(\d\d):(\d\d):(\d\d)\s+(.*)$", line.strip())
            if not m:
                continue
            kv = {}
            for tok in m.group(4).split():
                if "=" in tok:
                    k, v = tok.split("=", 1)
                    try:
                        kv[k] = float(v)
                    except ValueError:
                        kv[k] = v
            if "idle" not in kv:
                continue
            t = dt.datetime(day.year, day.month, day.day, int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=tz)
            if prev is not None and t < prev - dt.timedelta(hours=12):
                day = day + dt.timedelta(days=1)
                t = t + dt.timedelta(days=1)
            prev = t
            out.append((t, kv))
    return out


# ------------------------------------------------------------------------------------------------
# bench runs
# ------------------------------------------------------------------------------------------------
def parse_hbbench_log(path):
    """[(arm, rep, start_s, end_s|None, status)] in run order from hbbench.log."""
    runs = []
    if not path or not os.path.exists(path):
        return runs
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.match(r"^\[(\d+)s\] run (\S+) r(\d+)", line)
            if m:
                runs.append([m.group(2), int(m.group(3)), int(m.group(1)), None, None])
                continue
            m = re.match(r"^\[(\d+)s\]\s+(ok|ERROR)", line)
            if m and runs and runs[-1][3] is None:
                runs[-1][3] = int(m.group(1))
                runs[-1][4] = m.group(2)
    return runs


def load_bench_dir(d, tz):
    """Every <arm>-r<rep>.json in a bench dir as an arm-rep record with a time window."""
    files = sorted(f for f in glob.glob(os.path.join(d, "*-r[0-9]*.json")) if re.search(r"-r\d+\.json$", f))
    reps = []
    for f in files:
        j = load_json(f)
        if not isinstance(j, dict) or "arm" not in j:
            continue
        r = {"dir": d, "file": f, "arm": j["arm"], "rep": int(j.get("rep", 1)), "raw": j,
             "schema": j.get("schema", "hbbench-run-v1"), "flags": j.get("flags", ""), "error": j.get("error"),
             "errors": j.get("errors") or [], "gpu": j.get("gpu"), "draws": j.get("draws")}
        for s in SEGMENTS:
            r[s] = j.get(s)
        st, en = parse_iso(j.get("startedAt")), parse_iso(j.get("endedAt"))
        if en is None:
            en = from_epoch(os.path.getmtime(f), tz)
        r["start"], r["end"] = st, en
        reps.append(r)
    # v1: windows from hbbench.log offsets anchored on the first completed JSON's mtime
    log = parse_hbbench_log(os.path.join(d, "hbbench.log"))
    if log:
        by = {(a, rp): (s, e) for a, rp, s, e, _ in log}
        anchor = None
        for r in reps:
            k = (r["arm"], r["rep"])
            if r["start"] is None and k in by and by[k][1] is not None:
                anchor = r["end"] - dt.timedelta(seconds=by[k][1])
                break
        for r in reps:
            k = (r["arm"], r["rep"])
            if r["start"] is None and anchor is not None and k in by:
                r["start"] = anchor + dt.timedelta(seconds=by[k][0])
    for r in reps:
        if r["start"] is None:
            r["start"] = r["end"] - dt.timedelta(seconds=300)
    reps.sort(key=lambda x: x["start"])
    return reps


def box_samples_of(rep, boxwatch):
    """The run JSON's own samples (v2) plus the dir's boxwatch.log samples inside the arm-rep's window
    (v1 runs have only those; `--compat v1` reps sample themselves only before launch and after the
    tour, so boxwatch covers the segments in between)."""
    raw = rep["raw"]
    out = []
    srcs = []
    if isinstance(raw.get("box"), list) and raw["box"]:
        for b in raw["box"]:
            out.append({"at": parse_iso(b.get("at")), "label": b.get("label"), "who": b.get("who"),
                        "top": b.get("top") or [], "error": b.get("error")})
        srcs.append("run-json")
    bw = [{"at": t, "label": "boxwatch", "who": kv, "top": None, "error": None} for t, kv in boxwatch if rep["start"] <= t <= rep["end"]]
    if bw:
        out.extend(bw)
        srcs.append("boxwatch")
    return out, ("+".join(srcs) if srcs else ("boxwatch" if boxwatch else "none"))


def pin_entities(raw):
    """The server-state pin's entity count: the settled census (v2), else the post-tour one (`--compat v1`)."""
    ss = raw.get("serverState") or {}
    for k in ("settled", "end"):
        e = (ss.get(k) or {}).get("entities")
        if isinstance(e, (int, float)) and not isinstance(e, bool):
            return e
    return None


def _js(v):
    """A value as a JS template literal prints it (null, true, 13 for 13.0), so the problems this
    report derives read the same as lib/hb_v2.mjs runAssertProblems's."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def window_sky_problems(a):
    """The window and skytime halves of lib/hb_v2.mjs runAssertProblems over a run JSON's `asserts`
    block, worded as it words them. A missing or null assert is NOT APPLICABLE, never a problem by
    itself: a `--compat v1` rep records window null (no target), dayGroup null and, for an arm without
    a skytime flag, skyTimePin null; a pre-v2 rep has no asserts block at all."""
    out = []
    sk = a.get("skyTimePin")
    if isinstance(sk, dict) and sk.get("wanted") is not None:
        h = sk.get("hours")
        if not (_num(h) and abs(h - sk["wanted"]) < 0.01):
            out.append("skytime %s (want %s)" % (_js(h), _js(sk["wanted"])))
    w = a.get("window")
    if isinstance(w, dict) and w.get("target") and w.get("inner"):
        (tw, th), (iw, ih) = w["target"], w["inner"]
        if abs(tw - iw) > WINDOW_TOLERANCE_PX or abs(th - ih) > WINDOW_TOLERANCE_PX:
            out.append("window inner %sx%s (want %sx%s)" % (_js(iw), _js(ih), _js(tw), _js(th)))
    return out


def rule_v(rep, boxwatch, events, ref_entities=None, queue_gate=None):
    """Rule V for one arm-rep -> (status, reasons[], info). `queue_gate` = the gate expression the
    queue gives this arm (report_bench --queue): the rep must have evaluated exactly it, true."""
    raw = rep["raw"]
    reasons = []
    info = {}
    if rep["error"]:
        if str(rep["error"]).startswith("gate failed"):  # arm.gate false (e.g. rustEntityWorld projections !== 1): invalid, not a loss
            return "INVALID", ["gate: %s" % str(rep["error"])[len("gate failed: "):][:160]], info
        return "INCOMPLETE", ["did not complete: %s" % str(rep["error"])[:120]], info
    ev = overlapping_events(events, rep["start"], rep["end"])
    samples, src = box_samples_of(rep, boxwatch)
    info["boxSource"] = src
    good = [s for s in samples if s["who"]]
    if not good:
        reasons.append("unverified: no box samples")
    idle = [s["who"].get("idle") for s in good if isinstance(s["who"].get("idle"), (int, float))]
    g3 = [s["who"].get("gpu3d_other") for s in good if isinstance(s["who"].get("gpu3d_other"), (int, float))]
    if idle:
        info["idleMin"], info["idleMax"] = min(idle), max(idle)
        if min(idle) < IDLE_MIN_S:
            reasons.append("idle: %gs < %ds in %d of %d samples" % (min(idle), IDLE_MIN_S, sum(1 for x in idle if x < IDLE_MIN_S), len(idle)))
    if g3:
        info["gpu3dOtherMax"] = max(g3)
        if max(g3) > GPU3D_OTHER_MAX:
            reasons.append("gpu3d_other: %g%% > %g%%" % (max(g3), GPU3D_OTHER_MAX))
    hogs = []
    for s in samples:
        for t in s.get("top") or []:
            if not t.get("ours") and float(t.get("cores", 0)) >= CPU_HOG_CORES:
                hogs.append("%s %.2f cores" % (t.get("name"), float(t.get("cores", 0))))
    if hogs:
        reasons.append("cpu: non-test process >= 1 core (%s)" % ", ".join(sorted(set(hogs))[:3]))
    ent = pin_entities(raw)
    if ref_entities and isinstance(ent, (int, float)):
        delta = abs(ent - ref_entities) / float(ref_entities)
        info["entityDelta"] = round(delta, 3)
        if delta > ENTITY_DELTA_MAX:
            reasons.append("server state: %d entities vs %d in the reference arm (%.0f%% > 10%%)" % (ent, ref_entities, 100 * delta))
    if rep["errors"]:
        reasons.append("console errors: %d" % len(rep["errors"]))
    if queue_gate:
        g = raw.get("gate") if isinstance(raw.get("gate"), dict) else None
        if not g or g.get("expr") != queue_gate:
            reasons.append("gate: the queue's gate was not evaluated (%s)" % ("rep ran with gate %s" % g.get("expr") if g else "no gate record")
                           + "; without it the arm may be an A/A (e.g. a snapshot that predates the flag)")
        elif g.get("ok") is not True:
            reasons.append("gate: %s -> %s" % (queue_gate[:120], json.dumps(g.get("value"))))
    # the run-JSON asserts (rule V's machine half; lib/hb_v2.mjs buildAsserts / runAssertProblems)
    a = raw.get("asserts")
    covered = set()  # problems already given as a reason, in runAssertProblems's words
    if a:
        w = (a.get("wasm") or {}).get("profile")
        if w != "release":
            reasons.append("wasm: %s" % w)
            covered.add("wasm %s" % (_js(w) if a.get("wasm") else "unknown"))
        for p in a.get("urlPinProblems") or []:
            reasons.append("url pin: %s" % p)
            covered.add("url: %s" % p)
        dg = a.get("dayGroup")
        if dg and dg.get("wanted") is not None and dg.get("index") != dg.get("wanted"):
            reasons.append("dayGroup %s (want %s)" % (dg.get("index"), dg.get("wanted")))
            covered.add("dayGroup %s (want %s)" % (_js(dg.get("index")), _js(dg.get("wanted"))))
        for p in window_sky_problems(a):
            reasons.append(p)
            covered.add(p)
    gpu = rep["gpu"] or (a or {}).get("adapter")
    if not gpu or "1070" not in str(gpu):
        reasons.append("adapter: %s" % gpu)
        covered.update(("adapter %s" % _js((a or {}).get("adapter")), "adapter not read"))
    # every problem the driver itself recorded counts too (hb_v2.mjs: "a problem here makes hbreport
    # mark the arm-rep INVALID"), whether or not this report re-derives it
    for p in raw.get("assertProblems") or []:
        if p not in covered:
            reasons.append("assert: %s" % p)
            covered.add(p)
    if ev:
        info["boxEvents"] = [e["id"] or e["what"] for e in ev]
        return "CONTAMINATED", ["box event: %s" % (e["what"] or e["id"]) for e in ev] + reasons, info
    return ("INVALID" if reasons else "VALID"), reasons, info


def assess(reps, boxwatch_by_dir, events, ref=None, noisy_box=False, aa=None, gates=None):
    """Rule V over every arm-rep; the noisy-box fallback per arm. Mutates reps (status/reasons).
    `gates` = {arm: gate expression} from the queue (queue_gates)."""
    ref = ref or (reps[0]["arm"] if reps else None)
    ref_ent = None
    for r in reps:
        if r["arm"] == ref and not r["error"]:
            e = pin_entities(r["raw"])
            if isinstance(e, (int, float)) and e > 0:
                ref_ent = e
                break
    for r in reps:
        st, why, info = rule_v(r, boxwatch_by_dir.get(r["dir"], []), events, ref_ent, queue_gate=(gates or {}).get(r["arm"]))
        r["status"], r["reasons"], r["vinfo"] = st, why, info
    if noisy_box:
        by = collections.defaultdict(list)
        for r in reps:
            by[r["arm"]].append(r)
        has_aa = aa is not None and aa in by
        for arm, rs in by.items():
            soft = [r for r in rs if r["status"] == "INVALID" and r["reasons"] and all(x.split(":")[0] in V_SOFT for x in r["reasons"])]
            if has_aa and len(soft) + sum(1 for r in rs if r["status"] == "VALID") >= NOISY_BOX_MIN_REPS:
                for r in soft:
                    r["status"] = "NOISY-BOX"
    return reps


def seg_value(rep, seg, metric):
    s = rep.get(seg)
    if not isinstance(s, dict):
        return None
    v = s.get(metric)
    return float(v) if isinstance(v, (int, float)) else None


def arm_stats(reps, arms, statuses):
    """{arm: {(seg, metric): {med, min, max, n, values}}} over reps whose status is in `statuses`."""
    out = {}
    for arm in arms:
        rs = [r for r in reps if r["arm"] == arm and r["status"] in statuses]
        row = {}
        for seg in SEGMENTS:
            for metric in METRIC_KIND:
                vals = [seg_value(r, seg, metric) for r in rs]
                vals = [v for v in vals if v is not None]
                if vals:
                    row[(seg, metric)] = {"med": median(vals), "min": min(vals), "max": max(vals), "n": len(vals), "values": vals}
        dv = [r["draws"] for r in rs if isinstance(r.get("draws"), (int, float))]
        if dv:
            row[("all", "draws")] = {"med": median(dv), "min": min(dv), "max": max(dv), "n": len(dv), "values": dv}
        out[arm] = row
    return out


def noise_of(stats, ref, aa, key):
    a = stats.get(ref, {}).get(key)
    if not a:
        return None
    half = (a["max"] - a["min"]) / 2.0
    if aa and stats.get(aa, {}).get(key):
        return max(abs(a["med"] - stats[aa][key]["med"]), half)
    return half


def real_threshold(kind, ref_value, noise):
    floor = {"fps": 0.03 * abs(ref_value or 0), "ms": 0.5, "count": 1.0}[kind]
    return max(2.0 * (noise or 0.0), floor)


def compare(stats, ref, aa, arm, seg, metric):
    """R1 comparison of arm vs ref on one metric -> dict or None."""
    key = (seg, metric)
    a, b = stats.get(ref, {}).get(key), stats.get(arm, {}).get(key)
    if not a or not b:
        return None
    kind = METRIC_KIND.get(metric, "ms")
    noise = noise_of(stats, ref, aa, key)
    thr = real_threshold(kind, a["med"], noise)
    delta = b["med"] - a["med"]
    better = delta > 0 if kind == "fps" else delta < 0
    real = abs(delta) > thr
    return {"ref": a["med"], "arm": b["med"], "delta": round(delta, 3), "noise": round(noise or 0.0, 3), "threshold": round(thr, 3),
            "real": real, "verdict": ("better" if better else "worse") if real else "within noise", "nRef": a["n"], "nArm": b["n"]}


def r3_keep(stats, ref, aa, arm, predict=None, measured_ms=None, errors=0, look=None, measured_real=None, measured_why=None):
    """Rule R3 for one arm -> (verdict, reasons[]). `measured_real` = rule R1 on the measured move
    (anatomy_move: False = within the noise of the anatomy reps, so not a measured move at all)."""
    reasons, missing = [], []
    # (i) binding-thread ms vs prediction
    if predict is None or measured_ms is None:
        missing.append(measured_why or "(i) no prediction or no binding-thread ms (run hbanatomy on both arms)")
    else:
        if predict == 0 or (measured_ms / predict) < 0.5:
            reasons.append("(i) binding-thread ms moved %.2f vs predicted %.2f (< 50%%)" % (measured_ms, predict))
        elif measured_real is False:
            reasons.append("(i) binding-thread ms moved %.2f (predicted %.2f) but within the R1 noise of the anatomy reps: not a real delta" % (measured_ms, predict))
    # (ii) fps segments
    cmp = {s: compare(stats, ref, aa, arm, s, "fps") for s in FPS_SEGMENTS}
    if not any(cmp.values()):
        missing.append("(ii) no fps data")
    else:
        if not any(c and c["real"] and c["verdict"] == "better" for c in cmp.values()):
            reasons.append("(ii) no fps segment improved by a real delta")
        worse = [s for s, c in cmp.items() if c and c["real"] and c["verdict"] == "worse"]
        if worse:
            reasons.append("(ii) regressed by a real delta: %s" % ", ".join(worse))
    # (iii) hitches
    hw = []
    for seg, metric in HITCH_ROWS:
        c = compare(stats, ref, aa, arm, seg, metric)
        if c and c["real"] and c["verdict"] == "worse":
            hw.append("%s %s %+g" % (seg, metric, c["delta"]))
    if hw:
        reasons.append("(iii) hitch metrics worse: %s" % "; ".join(hw))
    # (iv) errors
    if errors:
        reasons.append("(iv) %d console errors" % errors)
    # (v) look
    if look is None:
        missing.append("(v) look gate not recorded (--look %s=pass|fail)" % arm)
    elif look != "pass":
        reasons.append("(v) look gate failed")
    if reasons:
        return "REVERT", reasons + missing
    if missing:
        return "INCONCLUSIVE", missing
    return "KEEP", []


def r5_route(main_ms, crgpu_ms, gpu_ms, frame_ms=None):
    """Rule R5 -> (binding thread, lever group)."""
    vals = {"main": main_ms, "CrGpuMain": crgpu_ms, "GPU": gpu_ms}
    known = {k: v for k, v in vals.items() if isinstance(v, (int, float))}
    if not known:
        return None, "no anatomy"
    binding = max(known, key=known.get)
    if frame_ms and isinstance(gpu_ms, (int, float)) and gpu_ms >= 0.9 * frame_ms:
        return binding, "GPU levers first (GPU ms >= 0.9 x frame time)"
    if isinstance(crgpu_ms, (int, float)) and isinstance(main_ms, (int, float)) and crgpu_ms >= main_ms:
        return binding, "GL-command levers first (CrGpuMain >= main: batching, HUD raster)"
    return binding, "main-thread levers first"


def r6_stop(predicted_ms, delivered_ms):
    """Rule R6 -> 'STOP' when a structural lane delivers < 50 % of its predicted ms at stage A."""
    if not predicted_ms:
        return None
    return "STOP" if (delivered_ms or 0) / predicted_ms < 0.5 else "CONTINUE"


def probe_rows(reps, arms, statuses):
    """v2 heading-binned draws + ranges + renderJs per arm (median over valid reps)."""
    out = {}
    for arm in arms:
        rs = [r for r in reps if r["arm"] == arm and r["status"] in statuses and r["raw"].get("probe")]
        if not rs:
            continue
        row = {}
        for seg in SEGMENTS:
            ps = [r["raw"]["probe"].get(seg) for r in rs if r["raw"]["probe"].get(seg)]
            if not ps:
                continue
            g = lambda f: median([f(p) for p in ps])
            row[seg] = {
                "callsBinned": g(lambda p: (p.get("headingBins") or {}).get("sectorMean", {}).get("calls")),
                "realDrawsBinned": g(lambda p: (p.get("headingBins") or {}).get("sectorMean", {}).get("realDraws")),
                "issuedBinned": g(lambda p: (p.get("headingBins") or {}).get("sectorMean", {}).get("issued")),
                "subDrawsBinned": g(lambda p: (p.get("headingBins") or {}).get("sectorMean", {}).get("subDraws")),
                "terrainRanges": g(lambda p: ((p.get("ranges") or {}).get("terrain") or {}).get("mean")),
                "sectorsCovered": g(lambda p: (p.get("headingBins") or {}).get("covered")),
                "renderJsP50": g(lambda p: (p.get("renderJs") or {}).get("p50")),
                "walks": g(lambda p: (p.get("walks") or {}).get("mean")),
                "emptyWalks": g(lambda p: (p.get("emptyWalks") or {}).get("mean")),
                "usPerCall": g(lambda p: p.get("usPerCall")),
            }
        out[arm] = row
    return out


def item_arms(it):
    """A queue item's arms as a stored run may have run them: `arms` plus `removedArms` (2026-10-30: the
    arms of a deleted flag move there with a `removed` note; hbbench's loadArms runs `arms` only, so they
    never run again, but a run stored before the deletion keeps its gate and prediction here)."""
    return list(it.get("arms", []) or []) + list(it.get("removedArms", []) or [])


def queue_gates(queue, item=None):
    """{arm name: gate expression} the queue gives the arms a bench ran (removedArms included, see
    item_arms). `item` (hbbench's run.json `item`, or `--item` in its argv) picks the item; without it
    an arm name counts only when every queue arm of that name carries the same gate (arm names like
    A / A-AA repeat across items)."""
    out = {}
    if not queue:
        return out
    items = queue.get("items", []) or []
    if item:
        items = [it for it in items if it.get("id") == item]
    seen = collections.defaultdict(set)
    for it in items:
        for a in item_arms(it):
            if a.get("name"):
                seen[a["name"]].add(a.get("gate") or (it.get("armDefaults") or {}).get("gate") or None)
    for name, gs in seen.items():
        if len(gs) == 1:
            g = next(iter(gs))
            if g:
                out[name] = g
    return out


def queue_predicts(queue, item=None):
    """{arm name: predict} for the bench's queue item, resolved like queue_gates (removedArms included;
    without an item, an arm name counts only when every queue arm of that name carries the same
    prediction)."""
    out = {}
    if not queue:
        return out
    items = queue.get("items", []) or []
    if item:
        items = [it for it in items if it.get("id") == item]
    seen = collections.defaultdict(list)
    for it in items:
        for a in item_arms(it):
            if a.get("name"):
                seen[a["name"]].append(a.get("predict") or None)
    for name, ps in seen.items():
        if ps[0] and all(p == ps[0] for p in ps):
            out[name] = ps[0]
    return out


class MixedItems(ValueError):
    """hbreport bench over dirs that ran different queue items (refused: their arm names would pool)."""


def run_item(meta):
    """The queue item a bench dir ran (run.json `item`, else `--item` in its argv), or None."""
    if not meta:
        return None
    if meta.get("item"):
        return meta["item"]
    argv = meta.get("argv") or []
    for i, x in enumerate(argv[:-1]):
        if x == "--item":
            return argv[i + 1]
    return None


def report_bench(dirs, events, tz, ref=None, aa=None, noisy_box=False, queue=None, looks=None, anatomy=None):
    reps = []
    boxwatch_by_dir = {}
    for d in dirs:
        rs = load_bench_dir(d, tz)
        reps.extend(rs)
        anchor = min((r["start"] for r in rs), default=None)
        boxwatch_by_dir[d] = parse_boxwatch(os.path.join(d, "boxwatch.log"), tz, anchor.date() if anchor else dt.date.today())
    arms = []
    for r in reps:
        if r["arm"] not in arms:
            arms.append(r["arm"])
    # the queue item is resolved PER DIR from its own run.json (2026-10-30, lane H3: it was the first
    # dir's only, so a second item's dir got the first item's gates). Dirs of different items are
    # refused: arm names such as A / A-AA repeat across items and their reps would pool into one arm.
    metas = {}
    for d in dirs:
        m = os.path.join(d, "run.json")
        metas[d] = load_json(m) if os.path.exists(m) else None
    items = {d: run_item(metas[d]) for d in dirs}
    if len(set(items.values())) > 1:
        raise MixedItems("hbreport bench: the dirs ran different queue items (%s); arm names repeat across items, so their reps "
                         "would be pooled and held to the wrong gates. Report one item per run (M1-REPORT: one bench dir per item)."
                         % "; ".join("%s -> %s" % (d, items[d] or "no item") for d in dirs))
    item = items[dirs[0]] if dirs else None
    order_meta = next((metas[d] for d in dirs if metas[d]), None)
    if order_meta and order_meta.get("arms"):
        names = [a["name"] for a in order_meta["arms"]]
        arms = [a for a in names if a in arms] + [a for a in arms if a not in names]
    ref = ref or (order_meta or {}).get("ref") or (arms[0] if arms else None)
    gates = queue_gates(queue, item)
    assess(reps, boxwatch_by_dir, events, ref=ref, noisy_box=noisy_box, aa=aa, gates=gates)
    valid = ("VALID", "NOISY-BOX")
    res = {"ref": ref, "aa": aa, "item": item, "arms": arms, "reps": [], "asRun": {}, "valid": {}, "compare": {}, "verdicts": {}, "probe": {}}
    for r in reps:
        res["reps"].append({"arm": r["arm"], "rep": r["rep"], "status": r["status"], "reasons": r["reasons"], "info": r["vinfo"],
                            "start": r["start"].isoformat(), "end": r["end"].isoformat(), "schema": r["schema"]})
    as_run = arm_stats(reps, arms, ("VALID", "NOISY-BOX", "INVALID", "CONTAMINATED"))
    vstats = arm_stats(reps, arms, valid)
    res["asRun"] = {a: {"%s.%s" % k: v for k, v in row.items()} for a, row in as_run.items()}
    res["valid"] = {a: {"%s.%s" % k: v for k, v in row.items()} for a, row in vstats.items()}
    preds = queue_predicts(queue, item)
    an = load_anatomy_dir(anatomy) if anatomy else {}
    for arm in arms:
        if arm == ref:
            continue
        res["compare"][arm] = {}
        for seg in SEGMENTS:
            for metric in ("fps", "p50", "p95", "p99", "max", "h100", "h250", "jankMs"):
                c = compare(as_run, ref, aa, arm, seg, metric)
                cv = compare(vstats, ref, aa, arm, seg, metric)
                if c or cv:
                    res["compare"][arm]["%s.%s" % (seg, metric)] = {"asRun": c, "valid": cv}
        errs = sum(len(r["errors"]) for r in reps if r["arm"] == arm and r["status"] in valid)
        p = preds.get(arm) or {}
        move, measured_why = None, None
        if p.get("thread") and an:
            move = anatomy_move(an, ref, aa, arm, p["thread"], events, gates)
            if move["delta"] is None:
                measured_why = "(i) no binding-thread ms from hbanatomy: %s" % "; ".join(
                    "%s %d valid rep(s)%s" % (name, s["n"], (" (" + ", ".join("r%s %s" % (x["rep"], x["status"]) for x in s["excluded"]) + ")") if s["excluded"] else "")
                    for name, s in ((ref, move["ref"]), (arm, move["arm"])))
        nvalid = sum(1 for r in reps if r["arm"] == arm and r["status"] in valid)
        if nvalid == 0 or not vstats.get(ref):
            v, why = "NO-VALID-REPS", ["rule V: re-queue (never averaged); see the per-rep statuses"]
        else:
            v, why = r3_keep(vstats, ref, aa, arm, predict=p.get("ms"), measured_ms=move["delta"] if move else None, errors=errs,
                             look=(looks or {}).get(arm), measured_real=move["real"] if move else None, measured_why=measured_why)
        res["verdicts"][arm] = {"R3": v, "why": why, "validReps": nvalid, "anatomy": move}
    res["probe"] = probe_rows(reps, arms, ("VALID", "NOISY-BOX", "INVALID", "CONTAMINATED"))
    return res, reps


def print_bench(res):
    out = []
    out.append("== hbreport bench  (ref %s, A/A %s)" % (res["ref"], res["aa"] or "none: R1 noise = half of the ref arm's rep spread"))
    out.append("-- rule V per arm-rep")
    for r in res["reps"]:
        out.append("  %-28s r%d  %-12s %s" % (r["arm"], r["rep"], r["status"], "; ".join(r["reasons"])[:200]))
    out.append("-- as run (every completed rep, validity ignored) - median (min-max) n")
    hdr = "  %-28s %15s %9s %15s %15s %6s %9s %7s" % ("arm", "still fps", "still p99", "moving fps", "tour fps", "tour h100", "1st max", "draws")
    out.append(hdr)
    for arm in res["arms"]:
        row = res["asRun"].get(arm, {})
        f = lambda k: row.get(k)
        def mm(k):
            v = f(k)
            if not v:
                return "-"
            return "%g" % v["med"] if v["n"] == 1 else "%g (%g-%g) %d" % (v["med"], v["min"], v["max"], v["n"])
        out.append("  %-28s %15s %9s %15s %15s %6s %9s %7s" % (arm, mm("still.fps"), mm("still.p99"), mm("moving.fps"), mm("tour.fps"), mm("tour.h100"), mm("firstTurn.max"), mm("all.draws")))
    out.append("-- deltas vs %s (as run): still / moving / tour fps  [R1 verdict on VALID reps]" % res["ref"])
    for arm, c in res["compare"].items():
        parts, vparts = [], []
        for s in FPS_SEGMENTS:
            x = c.get("%s.fps" % s) or {}
            a, v = x.get("asRun"), x.get("valid")
            parts.append("%+.1f" % a["delta"] if a else "-")
            vparts.append(v["verdict"] if v else "no valid reps")
        out.append("  %-28s %s   [%s]  R3 %s" % (arm, " / ".join(parts), ", ".join(vparts), res["verdicts"].get(arm, {}).get("R3")))
    am = [(arm, v["anatomy"]) for arm, v in res["verdicts"].items() if v.get("anatomy")]
    if am:
        out.append("-- R3 (i) from hbanatomy: binding-thread ms, median over VALID reps (rule V per rep), R1 noise from the reps")
        for arm, m in am:
            side = lambda s: "%s ms n=%d" % (("%.2f" % s["med"]) if s["n"] else "-", s["n"])
            out.append("  %-28s %-9s ref %s  arm %s  delta %s  noise %s  threshold %s  %s" % (
                arm, m["thread"], side(m["ref"]), side(m["arm"]), m["delta"], m["noise"], m["threshold"],
                "real" if m["real"] else ("within noise" if m["real"] is False else "no data")))
    if res["probe"]:
        out.append("-- v2 probe (median over reps): heading-binned info.calls / real draws / issued ranges / terrain ranges / renderJs p50 / walks / empty walks / us per call")
        for arm, row in res["probe"].items():
            for seg, p in row.items():
                out.append("  %-28s %-9s %s / %s / %s / %s / %s ms / %s / %s / %s  (%s sectors)" % (arm, seg, p["callsBinned"], p["realDrawsBinned"], p["issuedBinned"], p["terrainRanges"], p["renderJsP50"], p["walks"], p["emptyWalks"], p["usPerCall"], p["sectorsCovered"]))
    out.append("-- reminders: R4 look (rc-eye + owner), R7 tier presets (owner OK at ultra), R10 reference clients are bounds only")
    return "\n".join(out)


# ------------------------------------------------------------------------------------------------
# profile runs (hbsess boot + profile_systems.py + loaf-stalls)
# ------------------------------------------------------------------------------------------------
PRICE_ROWS = (
    ("draw loop", "render: three draw loop (renderScene)", "ms"),
    ("three's JS", "render: three draw loop (renderScene)", "3js"),
    ("our JS", "render: three draw loop (renderScene)", "ourJS"),
    ("GL natives", "render: three draw loop (renderScene)", "GL"),
    ("(program)", "(program)", "ms"),
    ("projectObject", "render: three projectObject (cull+list)", "ms"),
    ("frustum cull", "game: frustum culling", "ms"),
    ("rig pose", "game: entity rig pose (motion)", "ms"),
    ("render-list sort", "render: three render-list sort", "ms"),
    ("material-variant sync", "game: material variant sync", "ms"),
    ("billboards", "game: statics billboards", "ms"),
    ("terrain VFX", "game: terrain VFX", "ms"),
    ("matrices", "render: scene graph matrices", "ms"),
    ("animated scenery", "game: animated scenery", "ms"),
    ("particles", "game: particles", "ms"),
)
SYS_COLS = ("ourJS", "3js", "3graph", "GL", "wasm", "other")


def parse_systems(path):
    """profile_systems.py text -> {'busy': ms/frame (str), 'rows': {system: {'ms': str, col: str}}}."""
    out = {"busy": None, "frames": None, "rows": {}}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.search(r"busy \(diag excluded\) (\d+) ms over ([\d.]+) frames = ([\d.]+) ms/frame", line)
            if m:
                out["busy"], out["frames"] = m.group(3), m.group(2)
                continue
            m = re.match(r"^\s{3}(\S.*?)\s{2,}([\d.]+)\s+([\d.]+)\s+\|\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$", line)
            if m:
                row = {"ms": m.group(2), "pct": m.group(3)}
                for i, c in enumerate(SYS_COLS):
                    row[c] = m.group(4 + i)
                out["rows"][m.group(1).strip()] = row
    return out


def load_profile_dir(d, tz):
    runs = {}
    for f in sorted(glob.glob(os.path.join(d, "*.systems.txt"))):
        m = re.match(r"^(.*)-r(\d+)\.systems\.txt$", os.path.basename(f))
        if not m:
            continue
        arm, rep = m.group(1), int(m.group(2))
        base = os.path.join(d, "%s-r%d" % (arm, rep))
        times = [os.path.getmtime(p) for p in (base + "-boot.log", base + ".cpuprofile", base + "-loaf.json") if os.path.exists(p)]
        start = from_epoch(min(times), tz) - dt.timedelta(seconds=120) if times else None
        end = from_epoch(max(times), tz) if times else None
        loaf = load_json(base + "-loaf.json") if os.path.exists(base + "-loaf.json") else {}
        runs[(arm, rep)] = {"arm": arm, "rep": rep, "systems": parse_systems(f), "loafFps": loaf.get("fps"), "loaf": loaf, "start": start, "end": end}
    return runs


def report_profile(d, events, tz, primary_pairs=None):
    runs = load_profile_dir(d, tz)
    arms = sorted({a for a, _ in runs}, key=lambda a: (a != "defaults", a))
    reps = sorted({r for _, r in runs})
    status = {}
    for k, r in runs.items():
        ev = overlapping_events(events, r["start"], r["end"]) if r["start"] else []
        status[k] = ("CONTAMINATED", [e["what"] or e["id"] for e in ev]) if ev else ("UNVERIFIED-IDLE", ["no box samples in a profile run"])
    clean = [rp for rp in reps if all(status.get((a, rp), ("",))[0] != "CONTAMINATED" for a in arms)]
    primary = primary_pairs or clean
    res = {"arms": arms, "reps": reps, "status": {"%s-r%d" % k: v for k, v in status.items()}, "primaryPairs": primary, "table": {}, "price": {}}

    def col(arm, rep, sysname, c):
        r = runs.get((arm, rep))
        if not r:
            return None
        row = r["systems"]["rows"].get(sysname)
        return row.get(c) if row else None

    for arm in arms:
        busy = {rp: runs[(arm, rp)]["systems"]["busy"] for rp in reps if (arm, rp) in runs}
        loaf = {rp: runs[(arm, rp)]["loafFps"] for rp in reps if (arm, rp) in runs}
        part = {rp: col(arm, rp, "game: particles", "ms") for rp in reps}
        res["table"][arm] = {
            "mainBusy": {"perRep": busy, "mean": dmean(busy.values()), "meanPrimary": dmean([busy[p] for p in primary if p in busy])},
            "loafFps": {"perRep": loaf, "mean": dmean(loaf.values(), 1), "meanPrimary": dmean([loaf[p] for p in primary if p in loaf], 2)},
            "particles": {"perRep": part, "mean": dmean(part.values()), "meanPrimary": dmean([part[p] for p in primary if part.get(p) is not None])},
        }
        res["price"][arm] = {}
        for label, sysname, c in PRICE_ROWS:
            vals = {rp: col(arm, rp, sysname, c) for rp in reps}
            res["price"][arm][label] = {"perRep": vals, "meanPrimary": dmean([vals[p] for p in primary if vals.get(p) is not None]),
                                        "caveated": {rp: vals[rp] for rp in reps if rp not in primary}}
    if len(arms) == 2:
        a, b = ("defaults", "alloff") if set(arms) == {"defaults", "alloff"} else (arms[0], arms[1])
        t = res["table"]
        res["deltas"] = {
            "mainBusyMean": half_up(t[a]["mainBusy"]["mean"] - t[b]["mainBusy"]["mean"]),
            "mainBusyPrimary": half_up(t[a]["mainBusy"]["meanPrimary"] - t[b]["mainBusy"]["meanPrimary"]),
            "loafFpsMean": half_up(float(dmean(t[a]["loafFps"]["perRep"].values(), 4)) - float(dmean(t[b]["loafFps"]["perRep"].values(), 4)), 1),
            "loafFpsPrimary": half_up(t[a]["loafFps"]["meanPrimary"] - t[b]["loafFps"]["meanPrimary"]),
            "particlesMean": half_up(t[a]["particles"]["mean"] - t[b]["particles"]["mean"]),
            "particlesPrimary": half_up(t[a]["particles"]["meanPrimary"] - t[b]["particles"]["meanPrimary"]),
        }
    return res


def print_profile(res):
    out = ["== hbreport profile  (primary pairs %s; the rest caveated)" % res["primaryPairs"]]
    for k, (st, why) in sorted(res["status"].items()):
        out.append("  %-14s %-16s %s" % (k, st, "; ".join(why)))
    for arm, t in res["table"].items():
        out.append("  %-9s main busy ms/frame %s mean %s primary %s | LoAF fps %s mean %s primary %s | particles %s mean %s primary %s" % (
            arm, t["mainBusy"]["perRep"], t["mainBusy"]["mean"], t["mainBusy"]["meanPrimary"], t["loafFps"]["perRep"], t["loafFps"]["mean"],
            t["loafFps"]["meanPrimary"], t["particles"]["perRep"], t["particles"]["mean"], t["particles"]["meanPrimary"]))
    if res.get("deltas"):
        out.append("  deltas: %s" % json.dumps(res["deltas"]))
    arms = list(res["price"])
    out.append("  price list, ms/frame, mean of the primary pairs [caveated pairs]: " + " vs ".join(arms))
    for label, _, _ in PRICE_ROWS:
        cells = []
        for arm in arms:
            p = res["price"][arm][label]
            cav = ",".join(str(v) for v in p["caveated"].values() if v is not None)
            cells.append("%s [%s]" % (p["meanPrimary"], cav))
        out.append("    %-22s %s" % (label, " vs ".join(cells)))
    return "\n".join(out)


# ------------------------------------------------------------------------------------------------
# traces
# ------------------------------------------------------------------------------------------------
def read_trace_events(path):
    """Chrome trace (one event per line, or one JSON document) -> (threads, X events, marks)."""
    threads, events, marks = {}, [], []

    def take(e):
        ph = e.get("ph")
        if ph == "M":
            if e.get("name") == "thread_name":
                threads[(e.get("pid"), e.get("tid"))] = (e.get("args") or {}).get("name")
            return
        cat = e.get("cat") or ""
        if "blink.user_timing" in cat and ph in ("R", "I", "i", "n", "b", "e", "X", "mark"):
            marks.append((e.get("ts", 0), e.get("name") or ""))
        if ph == "X":
            events.append((e.get("pid"), e.get("tid"), e.get("ts", 0), e.get("dur", 0), e.get("name") or ""))

    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line.endswith("]}"):  # the last event of a {"traceEvents":[ ... ]} file
                line = line[:-2]
            elif line.endswith("]"):
                line = line[:-1]
            line = line.rstrip(",")
            if not line.startswith("{"):
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if "traceEvents" in e and isinstance(e["traceEvents"], list):
                for x in e["traceEvents"]:
                    take(x)
                n += 1
                continue
            take(e)
            n += 1
    if n == 0:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            j = json.load(f)
        for x in (j.get("traceEvents") if isinstance(j, dict) else j) or []:
            take(x)
    return threads, events, marks


def _top_level(rows):
    rows = sorted(rows, key=lambda x: x[2])
    tops, stack = [], []
    for _pid, _tid, ts, dur, name in rows:
        while stack and stack[-1][0] + stack[-1][1] <= ts:
            stack.pop()
        if not stack:
            tops.append([ts, dur, name, collections.Counter()])
        else:
            tops[-1][3][name] += dur
        stack.append((ts, dur))
    return tops


def _classify_gpu(ch, name):
    if any(k.startswith("RasterDecoderImpl") for k in ch) or "RendererRasterWorker" in ch:
        return "RASTER"
    if "WebGL" in ch or name == "WebGL":
        return "WEBGL"
    if any("Present" in k for k in ch) or "Present" in name:
        return "PRESENT"
    return "other"


def split_windows(threads, events, windows):
    """Per window [t0, t1) in trace us: CrGpuMain busy by class per present, CrRendererMain busy, GC."""
    gpu = [x for x in events if threads.get((x[0], x[1])) == "CrGpuMain"]
    main = [x for x in events if threads.get((x[0], x[1])) == "CrRendererMain"]
    gtops = _top_level(gpu)
    mtops = _top_level(main)
    names = collections.Counter(x[4] for x in gpu)
    kind = next((k for k in ("DXGISwapChainImageBacking::Present", "DCompPresenter::Present", "SwapBuffers") if names[k]), None)
    out = []
    for label, t0, t1 in windows:
        cls = collections.Counter()
        busy = 0
        for ts, dur, name, ch in gtops:
            if t0 <= ts < t1:
                cls[_classify_gpu(ch, name)] += dur
                busy += dur
        presents = sum(1 for x in gpu if x[4] == kind and t0 <= x[2] < t1) if kind else 0
        mbusy = sum(d for ts, d, _n, _c in mtops if t0 <= ts < t1)
        gc = sum(x[3] for x in main if x[4] in ("MinorGC", "MajorGC") and t0 <= x[2] < t1)
        per = max(presents, 1)
        span_ms = (t1 - t0) / 1000.0
        out.append({"window": label, "spanMs": round(span_ms, 1), "presents": presents,
                    "crGpuMainBusyMs": round(busy / 1000.0, 1), "crGpuMainPerPresent": round(busy / 1000.0 / per, 2),
                    "webglPerPresent": round(cls["WEBGL"] / 1000.0 / per, 2), "rasterPerPresent": round(cls["RASTER"] / 1000.0 / per, 2),
                    "presentPerPresent": round(cls["PRESENT"] / 1000.0 / per, 2), "otherPerPresent": round(cls["other"] / 1000.0 / per, 2),
                    "mainBusyMs": round(mbusy / 1000.0, 1), "mainBusyPerPresent": round(mbusy / 1000.0 / per, 2),
                    "gcMs": round(gc / 1000.0, 2)})
    return out


def trace_split(path, prefix=None):
    threads, events, marks = read_trace_events(path)
    if prefix:
        ms = sorted((ts, n) for ts, n in marks if n.startswith(prefix))
        windows = []
        for i in range(len(ms) - 1):
            windows.append((ms[i][1], ms[i][0], ms[i + 1][0]))
    else:
        ts = [x[2] for x in events] or [0]
        windows = [("whole", min(ts), max(x[2] + x[3] for x in events) if events else 0)]
    return {"trace": path, "prefix": prefix, "marks": len(marks), "windows": split_windows(threads, events, windows)}


# ------------------------------------------------------------------------------------------------
# anatomy, ledger, program keys, structure ceiling, M1c
# ------------------------------------------------------------------------------------------------
def load_anatomy_dir(d):
    """{arm: [{"file", "rep", "json"}, ...]}: EVERY hbanatomy run under `d` (<OUT>/<arm>-r<rep>/anatomy.json
    at any depth, the -gauge boots included), per arm in rep order. 2026-10-30 (lane H3): this kept only
    the FIRST file per arm (setdefault, in glob order), so a 3-rep anatomy item fed R3 (i) from one rep;
    anatomy_arm aggregates them now."""
    out = {}
    if not d:
        return out
    for f in sorted(glob.glob(os.path.join(d, "**", "anatomy*.json"), recursive=True)):
        j = load_json(f)
        if isinstance(j, dict) and j.get("arm"):
            out.setdefault(j["arm"], []).append({"file": f, "rep": j.get("rep"), "json": j})
    for runs in out.values():
        runs.sort(key=lambda r: (r["rep"] if _num(r["rep"]) else float("inf"), r["file"]))
    return out


def anatomy_arm(runs, thread, events=None, queue_gate=None):
    """One arm's binding-thread ms over its hbanatomy reps (plan section 5): rule V per rep
    (anatomy_validity: box samples, asserts, errors, a failed gate; with `queue_gate` the rep must have
    evaluated exactly that gate true, as rule V holds a bench rep), INVALID / CONTAMINATED / INCOMPLETE
    reps never averaged; the median over the VALID reps that measured the thread (a -gauge boot has no
    trace and adds nothing). -> {thread, n, values, reps, excluded[], med, min, max}."""
    vals, used, excluded = [], [], []
    for r in runs or []:
        st, why, _ = anatomy_validity(r["json"], events, queue_gate=queue_gate)
        if st != "VALID":
            excluded.append({"file": r["file"], "rep": r["rep"], "status": st, "reasons": why})
            continue
        v = binding_ms(r["json"], thread)
        if not _num(v):
            excluded.append({"file": r["file"], "rep": r["rep"], "status": "NO-DATA", "reasons": ["no %s ms (no trace split in this run)" % thread]})
            continue
        vals.append(float(v))
        used.append(r["rep"])
    out = {"thread": thread, "n": len(vals), "values": vals, "reps": used, "excluded": excluded}
    if vals:
        out.update({"med": median(vals), "min": min(vals), "max": max(vals)})
    return out


def anatomy_move(an, ref, aa, arm, thread, events=None, gates=None):
    """R3 (i)'s measured move from hbanatomy reps: arm minus ref on the predicted thread, each the median
    over its VALID reps (anatomy_arm), judged by rule R1 with the noise taken from those reps:
    noise = max(|A - A'| (when the A/A arm has anatomy reps), half of A's rep spread); real only above
    max(2 x noise, 0.5 ms). -> dict with delta / noise / threshold / real (None when either side has no
    valid rep measuring the thread) and the per-arm aggregates."""
    g = gates or {}
    a = anatomy_arm(an.get(ref), thread, events, g.get(ref))
    b = anatomy_arm(an.get(arm), thread, events, g.get(arm))
    c = anatomy_arm(an.get(aa), thread, events, g.get(aa)) if aa and an.get(aa) else None
    out = {"thread": thread, "ref": a, "arm": b, "aa": c, "delta": None, "noise": None, "threshold": None, "real": None}
    if not a["n"] or not b["n"]:
        return out
    half = (a["max"] - a["min"]) / 2.0
    noise = max(abs(a["med"] - c["med"]), half) if c and c["n"] else half
    thr = real_threshold("ms", a["med"], noise)
    delta = b["med"] - a["med"]
    out.update({"delta": round(delta, 3), "noise": round(noise, 3), "threshold": round(thr, 3), "real": abs(delta) > thr})
    return out


def anatomy_threads(a, part="still"):
    """main busy per present, CrGpuMain per present (WEBGL share), GPU ms per frame from one hbanatomy
    JSON, over its `part` ("still" or "orbit") 5 s trace windows (gap windows and stubs < 1 s skipped)."""
    tr = (a.get("trace") or {}).get("split") or {}
    wins = [w for w in (tr.get("windows") or []) if re.search(r":%s:w\d+$" % part, w.get("window", "")) and (w.get("spanMs") or 0) >= 1000]
    main = median([w.get("mainBusyPerPresent") for w in wins]) if wins else None
    crg = median([w.get("crGpuMainPerPresent") for w in wins]) if wins else None
    webgl = median([w.get("webglPerPresent") for w in wins]) if wins else None
    gpu = (a.get("passes") or {}).get("gpuMsPerFrame")
    fw = ((a.get("trace") or {}).get(part) or {}).get("windows") or []
    fps = median([w.get("fps") for w in fw if w.get("frames", 0) >= 10])
    return {"main": main, "CrGpuMain": crg, "webgl": webgl, "GPU": gpu, "fps": fps, "frameMs": (1000.0 / fps) if fps else None}


def binding_ms(a, thread):
    t = anatomy_threads(a)
    return t.get({"main": "main", "crgpumain": "CrGpuMain", "webgl": "webgl", "gpu": "GPU"}.get(str(thread).lower(), thread))


def anatomy_validity(a, events=None, tz=None, queue_gate=None):
    """Rule V for an hbanatomy run (its own box samples, asserts, errors; `queue_gate` as rule_v's)."""
    tz = tz or dt.timezone.utc
    st, en = parse_iso(a.get("startedAt")), parse_iso(a.get("endedAt"))
    rep = {"raw": a, "error": a.get("error"), "errors": a.get("errors") or [], "gpu": a.get("gpu"),
           "start": st or dt.datetime.now(tz), "end": en or dt.datetime.now(tz)}
    return rule_v(rep, [], events or [], queue_gate=queue_gate)


def ledger(files, events=None):
    """Budget ledger v0 rows: per anatomy run, the three threads standing and orbiting, R5's binding
    thread and lever group, the dated calibration, and the run's rule-V status."""
    rows = []
    for f in files:
        a = load_json(f)
        status, reasons, _ = anatomy_validity(a, events)
        row = {"file": f, "arm": a.get("arm"), "rep": a.get("rep"), "quality": a.get("quality"), "flags": a.get("flags"),
               "window": ((a.get("pins") or {}).get("window") or {}).get("inner"), "status": status, "reasons": reasons}
        for part in ("still", "orbit"):
            t = anatomy_threads(a, part)
            b, lever = r5_route(t["main"], t["CrGpuMain"], t["GPU"], t["frameMs"])
            row[part] = dict(t, binding=b, lever=lever)
        calib = a.get("calibration") or {}
        row["usPerCallRenderJs"] = calib.get("usPerCallRenderJs")
        row["usPerRealDrawWebgl"] = calib.get("usPerRealDrawWebgl")
        rows.append(row)
    return rows


def program_keys_of(j):
    if isinstance(j, list):
        return j
    return j.get("programKeys") or []


def program_diff(a, b):
    ka = collections.Counter(p.get("cacheKey") for p in program_keys_of(a))
    kb = collections.Counter(p.get("cacheKey") for p in program_keys_of(b))
    only_a = sorted(k for k in ka if k not in kb)
    only_b = sorted(k for k in kb if k not in ka)
    fields = collections.Counter()
    for k in only_b:
        fb = k.split(",")
        best, bestn = None, -1
        for ok in only_a:
            fa = ok.split(",")
            if len(fa) != len(fb):
                continue
            same = sum(1 for x, y in zip(fa, fb) if x == y)
            if same > bestn:
                best, bestn = fa, same
        if best is not None:
            for i, (x, y) in enumerate(zip(best, fb)):
                if x != y:
                    fields["field %d: %s -> %s" % (i, x[:40], y[:40])] += 1
    return {"programsA": sum(ka.values()), "programsB": sum(kb.values()), "onlyA": len(only_a), "onlyB": len(only_b),
            "changedFields": fields.most_common(30)}


def r8_verdict(cuts):
    """Rule R8 over {variant: {"renderMs": cut|None, "webglPerPresent": cut|None}} (cut = 1 - V/V0)."""
    def passes(x):
        return x is not None and x >= R8_CUT
    if any(passes(c.get("renderMs")) and passes(c.get("webglPerPresent")) for c in cuts.values()):
        return "PROCEED (>= 40 % cut on both threads)"
    open_ = [k for k, c in cuts.items() if all(c.get(m) is None or passes(c.get(m)) for m in ("renderMs", "webglPerPresent"))]
    if open_ or not cuts:
        miss = sorted({m for k in open_ for m in ("renderMs", "webglPerPresent") if cuts[k].get(m) is None})
        return "INCONCLUSIVE (missing %s%s)" % (", ".join(miss) or "V1/V2 windows", " for " + "/".join(open_) if open_ else "")
    return "RE-SCOPE R3-4/R3-5 (rule R8)"


def ceiling(probe_json, split=None):
    """Structure-ceiling probe -> per-variant medians and rule R8 (V1/V2 cut >= 40 % vs V0 on BOTH
    main-thread world-render ms and CrGpuMain WEBGL ms per present)."""
    p = probe_json
    if isinstance(p.get("result"), dict) and "windows" not in p:  # hbanatomy.mjs --attach --eval wraps the page result
        p = p["result"]
    per = collections.defaultdict(lambda: {"renderMs": [], "gpuMs": [], "webgl": []})
    for w in p.get("windows", []):
        v = per[w["variant"]]
        if w.get("renderMs") is not None:
            v["renderMs"].append(w["renderMs"])
        if w.get("gpuMs") is not None:
            v["gpuMs"].append(w["gpuMs"])
    if split:
        for w in split.get("windows", []):
            m = re.match(r".*:(V\d):", w["window"] + ":")
            if m:
                per[m.group(1)]["webgl"].append(w.get("webglPerPresent"))
    rows = {k: {"renderMs": median(v["renderMs"]), "gpuMs": median(v["gpuMs"]), "webglPerPresent": median(v["webgl"])} for k, v in per.items()}
    r8 = None
    if "V0" in rows:
        base = rows["V0"]
        cuts = {}
        for k in ("V1", "V2"):
            if k in rows:
                cuts[k] = {m: (1 - rows[k][m] / base[m]) if base.get(m) and rows[k].get(m) is not None else None for m in ("renderMs", "webglPerPresent")}
        r8 = {"cuts": cuts, "verdict": r8_verdict(cuts),
              "webglMissing": any(c.get("webglPerPresent") is None for c in cuts.values())}
    return {"variants": rows, "R8": r8}


def m1c(h_dirs, w_files, tz):
    rows = []
    for d in h_dirs:
        for r in load_bench_dir(d, tz):
            p = (r["raw"].get("probe") or {}).get("still") or {}
            bins = (p.get("headingBins") or {}).get("sectorMean", {})
            rj = (p.get("renderJs") or {}).get("p50")
            calls = bins.get("calls") or (p.get("calls") or {}).get("mean")
            rows.append({"side": "H", "arm": r["arm"], "rep": r["rep"], "fps": seg_value(r, "still", "fps"), "draws": calls,
                         "realDraws": bins.get("realDraws"), "renderJsP50": rj, "usPerDraw": round(rj * 1000.0 / calls, 2) if rj and calls else None,
                         "window": ((r["raw"].get("asserts") or {}).get("window") or {}).get("inner"),
                         "dpr": ((r["raw"].get("asserts") or {}).get("window") or {}).get("dpr")})
    for f in w_files or []:
        j = load_json(f)
        idle = next((ph for ph in j.get("phases", []) if ph.get("phase") == "idle"), {})
        draws = ((j.get("render") or {}).get("idle") or {}).get("drawCalls")
        rj = ((j.get("renderJs") or {}).get("idle") or {}).get("p50Ms")
        rows.append({"side": "W", "arm": "W", "rep": os.path.basename(f), "fps": idle.get("avgFps"), "draws": draws, "realDraws": draws,
                     "renderJsP50": rj, "usPerDraw": round(rj * 1000.0 / draws, 2) if rj and draws else None,
                     "window": (j.get("viewport") or {}), "sampling": j.get("renderSampling")})
    return {"note": "rule R10: reference numbers are bounds, never targets or gates", "rows": rows}


# ------------------------------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bench")
    b.add_argument("dirs", nargs="+")
    b.add_argument("--box-events")
    b.add_argument("--ref")
    b.add_argument("--aa")
    b.add_argument("--local-tz")
    b.add_argument("--noisy-box", action="store_true")
    b.add_argument("--queue")
    b.add_argument("--look", action="append", default=[])
    b.add_argument("--anatomy")
    b.add_argument("--json")
    p = sub.add_parser("profile")
    p.add_argument("dir")
    p.add_argument("--box-events")
    p.add_argument("--local-tz")
    p.add_argument("--json")
    t = sub.add_parser("trace-split")
    t.add_argument("trace")
    t.add_argument("--marks")
    t.add_argument("--json")
    a = sub.add_parser("anatomy")
    a.add_argument("files", nargs="+")
    a.add_argument("--box-events")
    a.add_argument("--json")
    pd = sub.add_parser("program-diff")
    pd.add_argument("a")
    pd.add_argument("b")
    pd.add_argument("--json")
    c = sub.add_parser("ceiling")
    c.add_argument("file")
    c.add_argument("--trace-split")
    c.add_argument("--json")
    m = sub.add_parser("m1c")
    m.add_argument("--h", action="append", default=[])
    m.add_argument("--w", action="append", default=[])
    m.add_argument("--local-tz")
    m.add_argument("--json")
    args = ap.parse_args(argv)

    if args.cmd == "bench":
        tz = local_tz(args.local_tz)
        events = load_box_events(args.box_events)
        looks = dict(x.split("=", 1) for x in args.look)
        queue = load_json(args.queue) if args.queue else None
        try:
            res, _ = report_bench(args.dirs, events, tz, ref=args.ref, aa=args.aa, noisy_box=args.noisy_box, queue=queue, looks=looks, anatomy=args.anatomy)
        except MixedItems as e:
            print("REFUSED: %s" % e, file=sys.stderr)
            return 2
        text = print_bench(res)
    elif args.cmd == "profile":
        res = report_profile(args.dir, load_box_events(args.box_events), local_tz(args.local_tz))
        text = print_profile(res)
    elif args.cmd == "trace-split":
        res = trace_split(args.trace, args.marks)
        text = "\n".join("  %-16s span %7.1f ms presents %4d  CrGpuMain %6.2f ms/present (WEBGL %.2f RASTER %.2f PRESENT %.2f)  main %6.2f ms/present  GC %.1f ms" % (
            w["window"], w["spanMs"], w["presents"], w["crGpuMainPerPresent"], w["webglPerPresent"], w["rasterPerPresent"], w["presentPerPresent"],
            w["mainBusyPerPresent"], w["gcMs"]) for w in res["windows"])
    elif args.cmd == "anatomy":
        res = ledger(args.files, load_box_events(args.box_events))
        lines = []
        for r in res:
            for part in ("still", "orbit"):
                t = r[part]
                lines.append("  %-20s r%s %-6s %-12s %s main %s CrGpuMain %s (WEBGL %s) GPU %s fps %s -> binding %s; %s" % (
                    r["arm"], r["rep"], part, r["status"], r["window"], t["main"], t["CrGpuMain"], t["webgl"], t["GPU"], t["fps"], t["binding"], t["lever"]))
            lines.append("  %-20s calibration: %s us renderJs per info.call, %s us CrGpuMain WEBGL per real draw%s" % (
                r["arm"], r["usPerCallRenderJs"], r["usPerRealDrawWebgl"], ("  [" + "; ".join(r["reasons"]) + "]") if r["reasons"] else ""))
        text = "\n".join(lines)
    elif args.cmd == "program-diff":
        res = program_diff(load_json(args.a), load_json(args.b))
        text = json.dumps(res, indent=1)
    elif args.cmd == "ceiling":
        res = ceiling(load_json(args.file), load_json(args.trace_split) if args.trace_split else None)
        text = json.dumps(res, indent=1)
    else:
        res = m1c(args.h, args.w, local_tz(args.local_tz))
        text = "\n".join("  %s %-24s %-28s fps %s draws %s renderJs p50 %s ms -> %s us/draw" % (
            r["side"], r["arm"], r["rep"], r["fps"], r["draws"], r["renderJsP50"], r["usPerDraw"]) for r in res["rows"])
    print(text)
    if getattr(args, "json", None):
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
