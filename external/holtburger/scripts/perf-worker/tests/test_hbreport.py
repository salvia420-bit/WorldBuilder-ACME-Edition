#!/usr/bin/env python3
"""tests/test_hbreport.py - hbreport.py (round 3 R3-0, 2026-10-30).

    python3 -I scripts/perf-worker/tests/test_hbreport.py        (any cwd; exit 0 = all pass)

Part 1 reproduces the 10-29 numbers of docs/2026-10-29-round3-gpu-driven.md section 1 from the stored
runs in $RC = /mnt/wbterminal1/tmp/claude-scratch/perf/rc-rust-scene-core-2026-10-29 (skipped, and
said so, when that directory is absent): bench 1 CONTAMINATED from the manual box-event list (the
Seagate Toolkit hog in the M1 queue file), RC-BENCH v2 rep 1 INVALID under rule V's idle gate with
its as-run table equal to section 1.1, and the profile pairs equal to section 1.2's table and price
list (pair 1 caveated). Part 2 pins the rules on synthetic v2 run JSON: every rule-V reason (and the
CPU-hog threshold), boxwatch samples merged into a compat-v1 rep's own, the noisy-box fallback (5 reps,
an A/A arm, the idle gate only), R1 noise with and without an A/A arm (and the |A - A'| term deciding),
R3 KEEP / REVERT / INCONCLUSIVE, R5, R6, the trace window split, the program-key diff, the
structure-ceiling R8 (both threads, 40 %, INCONCLUSIVE on a missing half), M1c rows.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PW = os.path.dirname(HERE)
sys.path.insert(0, PW)
import hbreport as H  # noqa: E402

RC = "/mnt/wbterminal1/tmp/claude-scratch/perf/rc-rust-scene-core-2026-10-29"
QUEUE = os.path.join(PW, "..", "..", "apps", "holtburger-web", "docs", "reengineering", "queue-1070", "batch-R3-M1-2026-10-30.json")
NDT = H.parse_tz("-02:30")


def stored(sub):
    return os.path.isdir(os.path.join(RC, sub))


@unittest.skipUnless(stored("bench") and stored("bench2") and stored("profile"), "stored 10-29 runs not on this machine")
class StoredRuns(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.events = H.load_box_events(QUEUE)

    def test_box_event_list_is_the_seagate_hog(self):
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0]["kind"], "cpu-hog")
        self.assertEqual(self.events[0]["until"].isoformat(), "2026-10-29T23:00:00-02:30")

    def test_bench1_contaminated_and_as_run_numbers(self):
        res, reps = H.report_bench([os.path.join(RC, "bench")], self.events, NDT)
        self.assertEqual(len(reps), 8)
        for r in reps:
            self.assertEqual(r["status"], "CONTAMINATED", (r["arm"], r["reasons"]))
            self.assertTrue(any("Seagate Toolkit" in x for x in r["reasons"]))
        a = res["asRun"]
        self.assertEqual(a["rc-defaults-ultra"]["still.fps"]["med"], 34.6)
        self.assertEqual(a["rc-alloff-ultra"]["still.fps"]["med"], 41.5)
        # nothing valid to average
        self.assertEqual(res["valid"].get("rc-defaults-ultra"), {})

    def test_bench2_invalid_idle_gate_and_section_1_1_table(self):
        res, reps = H.report_bench([os.path.join(RC, "bench2")], self.events, NDT)
        by = {r["arm"]: r for r in reps}
        self.assertEqual(by["rc-terrainshared-ultra"]["status"], "INCOMPLETE")
        done = [r for r in reps if r["arm"] != "rc-terrainshared-ultra"]
        self.assertEqual(len(done), 5)
        for r in done:
            self.assertEqual(r["status"], "INVALID", r["arm"])
            self.assertTrue(any(x.startswith("idle:") for x in r["reasons"]), r["reasons"])
            self.assertFalse(any("box event" in x for x in r["reasons"]))
            self.assertLessEqual(r["vinfo"]["idleMax"], 22)
            self.assertLess(r["vinfo"]["idleMin"], 60)
        self.assertEqual(min(r["vinfo"]["idleMin"] for r in done), 0)  # plan: "idle 0-22 s in every sample"
        self.assertTrue(any(x.startswith("gpu3d_other:") for r in done for x in r["reasons"]))  # 11.8 % and 16 % samples
        # section 1.1: still fps / still p99 / moving fps / tour fps / tour h100 / first-turn max / draws
        want = {
            "rc-defaults-ultra": (45.1, 36.6, 45.7, 42.9, 21, 997, 1117),
            "rc-alloff-ultra": (37.1, 62.8, 36.5, 37.6, 34, 989, 1120),
            "rc-noparticles-ultra": (44.7, 37.1, 45.5, 45.9, 21, 1372, 1166),
            "rc-noexec-ultra": (38.8, 47.0, 39.9, 39.9, 33, 686, 1110),
            "rc-alias-ultra": (37.6, 48.8, 34.2, 39.6, 21, 1645, 1122),
        }
        a = res["asRun"]
        for arm, w in want.items():
            got = tuple(a[arm][k]["med"] for k in ("still.fps", "still.p99", "moving.fps", "tour.fps", "tour.h100", "firstTurn.max", "all.draws"))
            self.assertEqual(got, tuple(float(x) for x in w), arm)
        # conclusions: deltas vs defaults (still / moving / tour)
        d = lambda arm: tuple(round(res["compare"][arm]["%s.fps" % s]["asRun"]["delta"], 1) for s in ("still", "moving", "tour"))
        self.assertEqual(d("rc-alloff-ultra"), (-8.0, -9.2, -5.3))
        self.assertEqual(d("rc-noexec-ultra"), (-6.3, -5.8, -3.0))
        self.assertEqual(d("rc-alias-ultra"), (-7.5, -11.5, -3.3))
        self.assertEqual(d("rc-noparticles-ultra"), (-0.4, -0.2, 3.0))
        self.assertEqual(max(a[x]["tour.max"]["med"] for x in want), 504.0)
        # with the gate applied nothing is averaged and no R3 verdict can be KEEP
        for arm in want:
            if arm != "rc-defaults-ultra":
                self.assertEqual(res["verdicts"][arm]["validReps"], 0)
                self.assertEqual(res["verdicts"][arm]["R3"], "NO-VALID-REPS")

    def test_profile_section_1_2(self):
        res = H.report_profile(os.path.join(RC, "profile"), self.events, NDT)
        st = res["status"]
        self.assertEqual(st["defaults-r1"][0], "CONTAMINATED")
        self.assertEqual(st["alloff-r1"][0], "CONTAMINATED")
        for k in ("defaults-r2", "defaults-r3", "alloff-r2", "alloff-r3"):
            self.assertNotEqual(st[k][0], "CONTAMINATED", k)
        self.assertEqual(res["primaryPairs"], [2, 3])
        t = res["table"]
        self.assertEqual(t["defaults"]["mainBusy"]["perRep"], {1: "28.22", 2: "31.10", 3: "25.88"})
        self.assertEqual((t["defaults"]["mainBusy"]["mean"], t["defaults"]["mainBusy"]["meanPrimary"]), (28.40, 28.49))
        self.assertEqual((t["alloff"]["mainBusy"]["mean"], t["alloff"]["mainBusy"]["meanPrimary"]), (31.12, 31.07))
        self.assertEqual((t["defaults"]["loafFps"]["mean"], t["defaults"]["loafFps"]["meanPrimary"]), (34.5, 35.8))
        self.assertEqual((t["alloff"]["loafFps"]["mean"], t["alloff"]["loafFps"]["meanPrimary"]), (29.4, 30.45))
        self.assertEqual((t["defaults"]["particles"]["mean"], t["defaults"]["particles"]["meanPrimary"]), (2.44, 2.49))
        self.assertEqual((t["alloff"]["particles"]["mean"], t["alloff"]["particles"]["meanPrimary"]), (1.31, 1.35))
        self.assertEqual(res["deltas"], {"mainBusyMean": -2.72, "mainBusyPrimary": -2.58, "loafFpsMean": 5.2, "loafFpsPrimary": 5.35,
                                         "particlesMean": 1.13, "particlesPrimary": 1.14})
        # price list: defaults vs all-off, mean of pairs 2-3 [pair 1]
        want = {
            "draw loop": (12.98, 13.81, "12.74", "14.09"), "three's JS": (7.90, 9.64, "7.75", "9.75"), "our JS": (2.19, 1.26, "2.26", "1.18"),
            "GL natives": (2.72, 2.72, "2.54", "2.93"), "(program)": (3.62, 4.33, "3.74", "4.42"), "projectObject": (1.77, 1.82, "1.79", "1.88"),
            "frustum cull": (0.31, 0.60, "0.28", "0.60"), "rig pose": (0.20, 0.50, "0.20", "0.51"), "render-list sort": (0.55, 0.83, "0.55", "0.79"),
            "material-variant sync": (0.08, 0.26, "0.06", "0.26"), "billboards": (0.02, 0.16, "0.02", "0.15"), "terrain VFX": (0.54, 0.71, "0.55", "0.68"),
            "matrices": (0.87, 1.07, "0.95", "1.05"), "animated scenery": (0.19, 0.25, "0.21", "0.25"), "particles": (2.49, 1.35, "2.34", "1.23"),
        }
        p = res["price"]
        for label, (dp, ap, d1, a1) in want.items():
            self.assertEqual(p["defaults"][label]["meanPrimary"], dp, label)
            self.assertEqual(p["alloff"][label]["meanPrimary"], ap, label)
            self.assertEqual(p["defaults"][label]["caveated"], {1: d1}, label)
            self.assertEqual(p["alloff"][label]["caveated"], {1: a1}, label)
        self.assertEqual(round(p["defaults"]["draw loop"]["meanPrimary"] - p["alloff"]["draw loop"]["meanPrimary"], 2), -0.83)

    def test_cli_runs_on_the_stored_runs(self):
        tmp = tempfile.mkdtemp(prefix="hbreport-test-")
        try:
            out = os.path.join(tmp, "r.json")
            rc = H.main(["bench", os.path.join(RC, "bench2"), "--box-events", QUEUE, "--local-tz=-02:30", "--json", out])
            self.assertEqual(rc, 0)
            with open(out) as f:
                j = json.load(f)
            self.assertEqual(j["ref"], "rc-defaults-ultra")
            self.assertEqual(H.main(["profile", os.path.join(RC, "profile"), "--box-events", QUEUE, "--local-tz=-02:30"]), 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


D1_BENCH = "/mnt/wbterminal1/tmp/claude-scratch/perf/r3-d1/bench"
D1_QUEUE = os.path.join(os.path.dirname(QUEUE), "batch-R3-D1-2026-10-30.json")


@unittest.skipUnless(os.path.isdir(D1_BENCH), "stored D1 run not on this machine")
class StoredD1(unittest.TestCase):
    def test_stored_d1_run_reports_through_the_queue_after_the_deletions(self):
        # 2026-10-30 (lane DEL): the D1-BENCH reps of the arms whose flags were deleted (UWD-on, S-rustEntityWorld,
        # D-stack; now removedArms) are still held to their queue gates, and the run reads as recorded in the
        # queue's D1-BENCH result: 45/45 VALID; uploadWarmDraw tour -1.7 and rustEntityWorld tour -1.8, real, worse.
        import contextlib
        import io
        tmp = tempfile.mkdtemp(prefix="hbreport-d1-")
        try:
            out = os.path.join(tmp, "r.json")
            with contextlib.redirect_stdout(io.StringIO()):
                rc = H.main(["bench", D1_BENCH, "--box-events", D1_QUEUE, "--queue", D1_QUEUE, "--ref", "A", "--aa", "A-AA", "--json", out])
            self.assertEqual(rc, 0)
            with open(out) as f:
                j = json.load(f)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        self.assertEqual(j["item"], "D1-BENCH")
        self.assertEqual(len(j["reps"]), 45)
        self.assertEqual({r["status"] for r in j["reps"]}, {"VALID"})
        gates = H.queue_gates(H.load_json(D1_QUEUE), "D1-BENCH")
        for arm in ("UWD-on", "S-rustEntityWorld", "D-stack"):
            self.assertIn(arm, gates)
            self.assertEqual(sum(1 for r in j["reps"] if r["arm"] == arm), 3, arm)
        for arm, d in (("UWD-on", -1.7), ("S-rustEntityWorld", -1.8)):
            v = j["compare"][arm]["tour.fps"]["valid"]
            self.assertEqual((v["delta"], v["real"], v["verdict"]), (d, True, "worse"), arm)


# ------------------------------------------------------------------------------------------------
# synthetic v2 runs
# ------------------------------------------------------------------------------------------------
GPU = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001BE1) Direct3D11 vs_5_0 ps_5_0, D3D11)"


def seg(fps, p99=30.0, h100=0, max_=60, jank=0, p50=None, p95=None):
    return {"n": 900, "fps": fps, "p50": p50 or round(1000.0 / fps, 1), "p95": p95 or 30.0, "p99": p99, "max": max_, "low1": 20.0, "low01": 15.0,
            "h50": 0, "h100": h100, "h250": 0, "jankMs": jank}


def v2run(arm, rep, start, fps=(45.0, 45.0, 43.0), idle=600, g3=0.5, top=None, ent=100, errors=None, wasm="release", gpu=GPU, ft_max=900, dg=0):
    st = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(start)) + "+00:00"
    en = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(start + 280)) + "+00:00"
    box = []
    for i, lab in enumerate(("pre-launch", "pre-firstTurn", "pre-still", "still-moving", "post-moving", "post-tour")):
        at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(start + 10 + 40 * i)) + "+00:00"
        box.append({"label": lab, "at": at, "who": {"idle": idle, "hbage": 1, "browsers": 0, "gpu3d_other": g3},
                    "top": top if top is not None else [{"name": "chrome", "pid": 1, "cores": 1.5, "ours": True}]})
    return {"schema": "hbbench-run-v2", "arm": arm, "rep": rep, "flags": "", "quality": "ultra", "gpu": gpu, "startedAt": st, "endedAt": en,
            "firstTurn": seg(20.0, max_=ft_max), "still": seg(fps[0]), "moving": seg(fps[1]), "tour": seg(fps[2], h100=20, max_=250, jank=5000),
            "draws": 1100, "errors": errors or [], "box": box,
            "asserts": {"adapter": gpu, "wasm": {"profile": wasm}, "urlPinProblems": [], "dayGroup": {"wanted": 0, "index": dg}},
            "serverState": {"settled": {"entities": ent}}}


class Synthetic(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hbreport-test-")
        self.t0 = 1793330000  # 2026-10-30 ~

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, runs, meta=None):
        for r in runs:
            with open(os.path.join(self.dir, "%s-r%d.json" % (r["arm"], r["rep"])), "w") as f:
                json.dump(r, f)
        if meta:
            with open(os.path.join(self.dir, "run.json"), "w") as f:
                json.dump(meta, f)

    def bench(self, **kw):
        return H.report_bench([self.dir], kw.pop("events", []), dt_utc(), **kw)

    def test_rule_v_reasons(self):
        t = self.t0
        runs = [v2run("A", 1, t), v2run("B-idle", 1, t + 300, idle=59), v2run("C-gpu", 1, t + 600, g3=5.1),
                v2run("D-hog", 1, t + 900, top=[{"name": "SeagateToolkit", "pid": 9, "cores": 0.97, "ours": False}]),
                v2run("E-ent", 1, t + 1200, ent=111), v2run("F-err", 1, t + 1500, errors=["boom"]), v2run("G-dev", 1, t + 1800, wasm="DEV-WASM"),
                v2run("H-gpu", 1, t + 2100, gpu="ANGLE (Intel, HD 520)"), v2run("I-dg", 1, t + 2400, dg=3), v2run("J-ok", 1, t + 2700, ent=109,
                top=[{"name": "dwm", "pid": 3, "cores": 0.6, "ours": False}, {"name": "chrome", "pid": 1, "cores": 3.0, "ours": True}])]
        self.write(runs)
        res, reps = self.bench(ref="A")
        st = {r["arm"]: (r["status"], " | ".join(r["reasons"])) for r in reps}
        self.assertEqual(st["A"][0], "VALID")
        self.assertEqual(st["J-ok"][0], "VALID", st["J-ok"])
        for arm, frag in (("B-idle", "idle"), ("C-gpu", "gpu3d_other"), ("D-hog", "SeagateToolkit"), ("E-ent", "server state"),
                          ("F-err", "console errors"), ("G-dev", "wasm: DEV-WASM"), ("H-gpu", "adapter"), ("I-dg", "dayGroup 3")):
            self.assertEqual(st[arm][0], "INVALID", arm)
            self.assertIn(frag, st[arm][1], arm)

    def test_rule_v_reads_the_window_and_skytime_asserts(self):
        # 2026-10-30 lane H2: a v2 rep at the wrong INNER size, or with the sky clock not pinned, is
        # INVALID (plan section 4 pins); before, rule V read only wasm / url pins / DayGroup / adapter
        t = self.t0
        w = v2run("W-size", 1, t + 300)
        w["asserts"]["window"] = {"target": [1920, 1080], "inner": [1904, 961], "dpr": 1}
        w["asserts"]["skyTimePin"] = {"wanted": 13, "hours": 13}
        w["assertProblems"] = ["window inner 1904x961 (want 1920x1080)"]
        k = v2run("K-sky", 1, t + 600)
        k["asserts"]["window"] = {"target": [1920, 1080], "inner": [1920, 1080], "dpr": 1}
        k["asserts"]["skyTimePin"] = {"wanted": 13, "hours": None}
        k["assertProblems"] = ["skytime null (want 13)"]
        ok = v2run("OK", 1, t + 900)
        ok["asserts"]["window"] = {"target": [1920, 1080], "inner": [1922, 1078], "dpr": 1}  # within the 2 px tolerance
        ok["asserts"]["skyTimePin"] = {"wanted": 13, "hours": 13.004}
        ok["assertProblems"] = []
        w3 = v2run("W-3px", 1, t + 1200)  # 3 px off: outside the tolerance (asserts only, no problem list)
        w3["asserts"]["window"] = {"target": [1920, 1080], "inner": [1917, 1080], "dpr": 1}
        # 2026-10-30 (lane H3): the skytime tolerance is 0.01 h, as lib/hb_v2.mjs runAssertProblems
        # (13.05 h is 3 minutes of sky clock off: INVALID; 12.995 h is inside)
        s5 = v2run("S-1305", 1, t + 1500)
        s5["asserts"]["skyTimePin"] = {"wanted": 13, "hours": 13.05}
        s9 = v2run("S-12995", 1, t + 1800)
        s9["asserts"]["skyTimePin"] = {"wanted": 13, "hours": 12.995}
        self.write([v2run("A", 1, t), w, k, ok, w3, s5, s9])
        _, reps = self.bench(ref="A")
        st = {r["arm"]: (r["status"], r["reasons"]) for r in reps}
        self.assertEqual(st["W-size"], ("INVALID", ["window inner 1904x961 (want 1920x1080)"]))  # once, not twice
        self.assertEqual(st["K-sky"], ("INVALID", ["skytime null (want 13)"]))
        self.assertEqual(st["OK"][0], "VALID", st["OK"][1])
        self.assertEqual(st["W-3px"], ("INVALID", ["window inner 1917x1080 (want 1920x1080)"]))
        self.assertEqual(st["S-1305"], ("INVALID", ["skytime 13.05 (want 13)"]))
        self.assertEqual(st["S-12995"], ("VALID", []))
        self.assertEqual(H.WINDOW_TOLERANCE_PX, 2)
        self.assertEqual(st["A"][0], "VALID")
        # the asserts alone decide too (a rep whose driver recorded no assertProblems list)
        del w["assertProblems"], k["assertProblems"]
        self.write([w, k])
        _, reps = self.bench(ref="A")
        st = {r["arm"]: (r["status"], r["reasons"]) for r in reps}
        self.assertEqual(st["W-size"], ("INVALID", ["window inner 1904x961 (want 1920x1080)"]))
        self.assertEqual(st["K-sky"], ("INVALID", ["skytime null (want 13)"]))
        # an hbanatomy run (bootArm writes the same asserts) gets the same verdict in the ledger
        a = dict(w, schema="hbanatomy-v1")
        f = os.path.join(self.dir, "anatomy.json")
        with open(f, "w") as fh:
            json.dump(a, fh)
        row = H.ledger([f])[0]
        self.assertEqual((row["status"], row["reasons"]), ("INVALID", ["window inner 1904x961 (want 1920x1080)"]))

    def test_rule_v_counts_every_recorded_assert_problem(self):
        # whatever lib/hb_v2.mjs runAssertProblems recorded invalidates the rep, re-derived here or not
        t = self.t0
        r = v2run("B", 1, t + 300)
        r["assertProblems"] = ["renderScale 0.5 (want 1)"]
        g = v2run("C", 1, t + 600, wasm="DEV-WASM")
        g["assertProblems"] = ["wasm DEV-WASM", "url: nosw=null (want 1)"]
        g["asserts"]["urlPinProblems"] = ["nosw=null (want 1)"]
        self.write([v2run("A", 1, t), r, g])
        _, reps = self.bench(ref="A")
        st = {x["arm"]: (x["status"], x["reasons"]) for x in reps}
        self.assertEqual(st["B"], ("INVALID", ["assert: renderScale 0.5 (want 1)"]))
        # problems rule V re-derives are not listed twice
        self.assertEqual(st["C"], ("INVALID", ["wasm: DEV-WASM", "url pin: nosw=null (want 1)"]))

    def test_compat_v1_rep_without_v2_asserts_is_not_invalid_for_that(self):
        # `--compat v1` (RC-BENCH v2 reps 2-3): no window target, no DayGroup, no skytime pin -> null
        # asserts, and runAssertProblems records none; a pre-v2 rep has no asserts at all. Neither is
        # INVALID for a missing v2 assert (rule V reads null as not applicable).
        t = self.t0
        v1 = v2run("rc-defaults-ultra", 2, t + 300)
        v1.update({"compat": "v1", "assertProblems": []})
        v1["asserts"].update({"dayGroup": None, "skyTimePin": None, "window": None})
        bare = v2run("rc-alloff-ultra", 2, t + 600)
        bare["compat"] = "v1"
        for key in ("dayGroup",):
            del bare["asserts"][key]
        pre = v2run("rc-noexec-ultra", 1, t + 900)
        del pre["asserts"]
        pre["schema"] = "hbbench-run-v1"
        self.write([v2run("A", 1, t), v1, bare, pre])
        _, reps = self.bench(ref="A")
        st = {x["arm"]: (x["status"], x["reasons"]) for x in reps}
        for arm in ("rc-defaults-ultra", "rc-alloff-ultra", "rc-noexec-ultra"):
            self.assertEqual(st[arm], ("VALID", []), arm)

    def test_queue_gate_holds_o_rigs_to_mode_rigs_and_cells_skipped(self):
        # M1b-OCC: an O-rigs rep is valid only if it evaluated the queue's gate (mode 'rigs' AND
        # stats.cellsSkipped > 0) and it held; a rep from an older queue copy (no gate) may be a silent
        # A/A on a snapshot that predates the flag -> INVALID when the report reads --queue
        with open(QUEUE) as f:
            q = json.load(f)
        gate = H.queue_gates(q, "M1b-OCC")["O-rigs"]
        self.assertIn("mode === 'rigs'", gate)
        self.assertIn("cellsSkipped > 0", gate)
        self.assertEqual(H.queue_gates(q)["O-rigs"], gate)  # unique arm name: no item needed
        self.assertNotIn("A", H.queue_gates(q))
        # S-rustEntityWorld sits in M1b-STRUCTURE's removedArms since 2026-10-30 (flag deleted after D1): its gate stays
        self.assertEqual(H.queue_gates(q, "M1b-STRUCTURE"), {"S-rustEntityWorld": "window.__entityWorld && window.__entityWorld.stats().projections === 1"})
        self.assertEqual(H.run_item({"argv": ["--arms", "x.json", "--item", "M1b-OCC"]}), "M1b-OCC")
        t = self.t0
        good = v2run("O-rigs", 1, t + 300)
        good["gate"] = {"expr": gate, "value": True, "ok": True, "info": {"mode": "rigs", "stats": {"proxies": 4, "cellsSkipped": 37}}}
        old = v2run("O-rigs", 2, t + 600)  # ran from a queue copy without the gate
        other = v2run("O-rigs", 3, t + 900)
        other["gate"] = {"expr": "window.__occlusionCull", "value": True, "ok": True}
        failed = v2run("O-rigs", 4, t + 1200)
        failed["error"] = "gate failed: %s -> false" % gate
        self.write([v2run("A", 1, t), good, old, other, failed], meta={"schema": "hbbench-meta-v2", "item": "M1b-OCC", "argv": ["--item", "M1b-OCC"], "arms": [{"name": "A"}, {"name": "O-rigs"}]})
        res, reps = self.bench(ref="A", queue=q)
        st = {(x["arm"], x["rep"]): (x["status"], " | ".join(x["reasons"])) for x in reps}
        self.assertEqual(st[("A", 1)][0], "VALID")
        self.assertEqual(st[("O-rigs", 1)], ("VALID", ""))
        self.assertEqual(st[("O-rigs", 2)][0], "INVALID")
        self.assertIn("the queue's gate was not evaluated (no gate record)", st[("O-rigs", 2)][1])
        self.assertEqual(st[("O-rigs", 3)][0], "INVALID")
        self.assertIn("rep ran with gate window.__occlusionCull", st[("O-rigs", 3)][1])
        self.assertEqual(st[("O-rigs", 4)][0], "INVALID")
        self.assertEqual(res["verdicts"]["O-rigs"]["validReps"], 1)
        # the gate record that says false (never written by hbbench, which stops the rep) is INVALID too
        good["gate"] = dict(good["gate"], value=False, ok=False)
        self.write([good])
        _, reps = self.bench(ref="A", queue=q)
        self.assertEqual({(x["arm"], x["rep"]): x["status"] for x in reps}[("O-rigs", 1)], "INVALID")

    def test_removed_arms_keep_gate_and_predict_for_stored_runs(self):
        # 2026-10-30 (lane DEL): ?rustEntityWorld / ?uploadWarmDraw were deleted after D1; every arm that set
        # either moved from item.arms to item.removedArms with a `removed` note. hbbench's loadArms runs `arms`
        # only (tests/hb_v2.test.mjs pins that side); hbreport (item_arms) still resolves the removed arms'
        # gate and predict, so a run stored before the deletion keeps its gates and its R3 basis.
        with open(os.path.join(os.path.dirname(QUEUE), "batch-R3-D1-2026-10-30.json")) as f:
            q = json.load(f)
        it = next(x for x in q["items"] if x["id"] == "D1-BENCH")
        removed = [a["name"] for a in it["removedArms"]]
        self.assertEqual(removed, ["UWD-on", "S-rustEntityWorld", "D-stack"])
        self.assertTrue(all(a["removed"] == "2026-10-30, flag deleted after D1" for a in it["removedArms"]))
        self.assertFalse(any(a["name"] in removed for a in it["arms"]))
        self.assertEqual([a["name"] for a in H.item_arms(it)], [a["name"] for a in it["arms"]] + removed)
        gates = H.queue_gates(q, "D1-BENCH")
        for a in it["removedArms"]:
            self.assertEqual(gates[a["name"]], a["gate"], a["name"])
        self.assertEqual(H.queue_predicts(q, "D1-BENCH")["D-stack"]["ms"], -0.201)
        # synthetic: a removed arm's stored rep is held to its gate exactly as before
        qs = {"schema": "hb-1070-queue-v1", "items": [{"id": "Z", "arms": [{"name": "A", "flags": ""}], "removedArms": [
            {"name": "Z-del", "removed": "2026-10-30, flag deleted after D1", "flags": "gone=on", "gate": "window.__gone === true",
             "predict": {"thread": "main", "ms": -1.0}}]}]}
        self.assertEqual(H.queue_gates(qs, "Z"), {"Z-del": "window.__gone === true"})
        self.assertEqual(H.queue_predicts(qs, "Z"), {"Z-del": {"thread": "main", "ms": -1.0}})
        t = self.t0
        held = v2run("Z-del", 1, t + 300)
        held["gate"] = {"expr": "window.__gone === true", "value": True, "ok": True}
        skipped = v2run("Z-del", 2, t + 600)  # no gate record: may be a silent A/A
        self.write([v2run("A", 1, t), held, skipped], meta={"schema": "hbbench-meta-v2", "item": "Z", "argv": ["--item", "Z"], "arms": [{"name": "A"}, {"name": "Z-del"}]})
        _, reps = self.bench(ref="A", queue=qs)
        st = {(x["arm"], x["rep"]): x["status"] for x in reps}
        self.assertEqual(st[("Z-del", 1)], "VALID")
        self.assertEqual(st[("Z-del", 2)], "INVALID")

    def anat(self, root, arm, rep, main, start, idle=600, gauge=False, **kw):
        """An hbanatomy run (<root>/<arm>-r<rep>/anatomy.json) whose still windows read `main` ms main busy."""
        a = v2run(arm, rep, start, idle=idle, **kw)
        a.update({"schema": "hbanatomy-v1", "phases": ["gauge"] if gauge else ["trace"], "pins": {"window": {"inner": [1920, 1080]}}})
        if not gauge:
            a["trace"] = {"still": {"windows": [{"window": 0, "frames": 220, "fps": 44.0}]},
                          "split": {"windows": [{"window": "hbAnat:still:w%d" % i, "spanMs": 5000, "mainBusyPerPresent": main,
                                                 "crGpuMainPerPresent": 15.0, "webglPerPresent": 10.0} for i in range(2)]}}
        d = os.path.join(root, "%s-r%d%s" % (arm, rep, "-gauge" if gauge else ""))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "anatomy.json"), "w") as f:
            json.dump(a, f)
        return a

    def anatomy_bench(self, a_main, b_main, aa_main=None, extra=None):
        """A bench dir (A vs B, B a real fps win, look pass) + an anatomy dir with one run per value."""
        t = self.t0
        runs = []
        for rep in (1, 2, 3):
            runs += [v2run("A", rep, t, fps=(40.0, 40.0, 40.0)), v2run("A-AA", rep, t + 300, fps=(40.0, 40.0, 40.0)), v2run("B", rep, t + 600, fps=(45.0, 44.0, 40.2))]
            t += 900
        self.write(runs, meta={"schema": "hbbench-meta-v2", "item": "X", "arms": [{"name": "A"}, {"name": "A-AA"}, {"name": "B"}]})
        an = os.path.join(self.dir, "anatomy")
        if os.path.isdir(an):
            shutil.rmtree(an)
        for arm, vals in (("A", a_main), ("B", b_main), ("A-AA", aa_main or [])):
            for i, v in enumerate(vals, 1):
                self.anat(an, arm, i, v, self.t0 + 5000 + 300 * i)
        for f in extra or []:
            f(an)
        q = {"items": [{"id": "X", "arms": [{"name": "A"}, {"name": "A-AA"}, {"name": "B", "predict": {"thread": "main", "ms": -1.0}}]}]}
        res, _ = self.bench(ref="A", aa="A-AA" if aa_main else None, queue=q, looks={"B": "pass"}, anatomy=an)
        return res, an

    def test_anatomy_every_rep_feeds_r3_i(self):
        # 2026-10-30 (lane H3): load_anatomy_dir kept only the FIRST anatomy JSON per arm (setdefault), so
        # a 3-rep anatomy item fed R3 (i) from one rep. Now every rep loads, rule V per rep, the median
        # over the valid ones, and the move must be real under R1 with the noise from the reps.
        res, an = self.anatomy_bench([21.0, 21.2, 20.8], [20.0, 19.9, 20.1])
        reps = H.load_anatomy_dir(an)
        self.assertEqual(sorted((k, [r["rep"] for r in v]) for k, v in reps.items()), [("A", [1, 2, 3]), ("B", [1, 2, 3])])
        m = res["verdicts"]["B"]["anatomy"]
        self.assertEqual((m["ref"]["n"], m["ref"]["med"], m["ref"]["values"], m["arm"]["n"], m["arm"]["med"]), (3, 21.0, [21.0, 21.2, 20.8], 3, 20.0))
        self.assertEqual((m["delta"], m["noise"], m["threshold"], m["real"]), (-1.0, 0.2, 0.5, True))
        self.assertEqual(res["verdicts"]["B"]["R3"], "KEEP", res["verdicts"]["B"]["why"])
        # one outlier rep of the ref: the median moves 1.0 ms but the reps' spread says that is noise.
        # Whichever single rep the old loader kept (21 or 25), it read a >= 50 % move and printed KEEP.
        res, _ = self.anatomy_bench([21.0, 21.0, 25.0], [20.0, 20.0, 20.0])
        m = res["verdicts"]["B"]["anatomy"]
        self.assertEqual((m["ref"]["med"], m["delta"], m["noise"], m["threshold"], m["real"]), (21.0, -1.0, 2.0, 4.0, False))
        v = res["verdicts"]["B"]
        self.assertEqual(v["R3"], "REVERT", v["why"])
        self.assertTrue(any(x.startswith("(i)") and "within the R1 noise" in x for x in v["why"]), v["why"])
        # an A/A arm with anatomy reps sets the noise when |A - A'| exceeds half the spread
        res, _ = self.anatomy_bench([21.0, 21.2, 20.8], [20.0, 19.9, 20.1], aa_main=[22.5, 22.4, 22.6])
        m = res["verdicts"]["B"]["anatomy"]
        self.assertEqual((m["aa"]["med"], m["noise"], m["threshold"], m["real"]), (22.5, 1.5, 3.0, False))
        self.assertEqual((m["aa"]["n"], res["verdicts"]["B"]["R3"]), (3, "REVERT"))

    def test_anatomy_invalid_and_traceless_reps_are_not_averaged(self):
        # rule V per anatomy rep: an idle-gate failure (and a -gauge boot, which has no trace) is listed
        # as excluded and never enters the median; no valid rep on one side -> (i) INCONCLUSIVE, not a move
        add_bad = lambda an: self.anat(an, "B", 4, 99.0, self.t0 + 7000, idle=10)
        add_gauge = lambda an: self.anat(an, "A", 1, 0.0, self.t0 + 7300, gauge=True)
        res, an = self.anatomy_bench([21.0, 21.2, 20.8], [20.0, 19.9, 20.1], extra=[add_bad, add_gauge])
        self.assertEqual([r["rep"] for r in H.load_anatomy_dir(an)["A"]], [1, 1, 2, 3])  # the gauge boot is a run too
        m = res["verdicts"]["B"]["anatomy"]
        self.assertEqual((m["arm"]["n"], m["arm"]["med"], m["ref"]["n"], m["ref"]["med"]), (3, 20.0, 3, 21.0))
        self.assertEqual([(x["rep"], x["status"]) for x in m["arm"]["excluded"]], [(4, "INVALID")])
        self.assertTrue(m["arm"]["excluded"][0]["reasons"][0].startswith("idle:"), m["arm"]["excluded"])
        self.assertEqual([(x["rep"], x["status"]) for x in m["ref"]["excluded"]], [(1, "NO-DATA")])
        self.assertEqual(res["verdicts"]["B"]["R3"], "KEEP", res["verdicts"]["B"]["why"])
        # every B anatomy rep invalid: no measured move, (i) INCONCLUSIVE with the reason, never a KEEP
        res, _ = self.anatomy_bench([21.0, 21.2, 20.8], [], extra=[add_bad])
        v = res["verdicts"]["B"]
        self.assertIsNone(v["anatomy"]["delta"])
        self.assertEqual(v["R3"], "INCONCLUSIVE", v["why"])
        self.assertTrue(any("B 0 valid rep(s) (r4 INVALID)" in x for x in v["why"]), v["why"])
        # a queue-gated arm's anatomy rep must have evaluated that gate true, as its bench reps must
        gate = "window.__occlusionCull && window.__occlusionCull.mode === 'rigs'"
        ok = self.anat(self.dir, "O-rigs", 1, 20.0, self.t0 + 8000)
        ok["gate"] = {"expr": gate, "value": True, "ok": True}
        old = self.anat(self.dir, "O-rigs", 2, 30.0, self.t0 + 8300)  # from an older queue copy: no gate record
        runs = [{"file": "r1", "rep": 1, "json": ok}, {"file": "r2", "rep": 2, "json": old}]
        g = H.anatomy_arm(runs, "main", queue_gate=gate)
        self.assertEqual((g["n"], g["values"], [(x["rep"], x["status"]) for x in g["excluded"]]), (1, [20.0], [(2, "INVALID")]))
        self.assertIn("the queue's gate was not evaluated", g["excluded"][0]["reasons"][0])
        self.assertEqual(H.anatomy_arm(runs, "main")["n"], 2)  # no queue gate: both count

    def test_report_bench_resolves_the_item_per_dir_and_refuses_mixed_items(self):
        # 2026-10-30 (lane H3): report_bench took the queue item from the FIRST dir's run.json only, so a
        # report over dirs of two items held the second item's arms to the first item's gates (and pooled
        # its same-named arms). Each dir's own item is resolved now; dirs of different items are refused.
        q = {"items": [
            {"id": "Y", "arms": [{"name": "A"}, {"name": "G", "gate": "window.__y === 1"}, {"name": "B", "predict": {"thread": "main", "ms": -3.0}}]},
            {"id": "X", "arms": [{"name": "A"}, {"name": "G", "gate": "window.__x === 1"}, {"name": "B", "predict": {"thread": "main", "ms": -1.0}}]},
        ]}
        self.assertEqual(H.queue_predicts(q, "X"), {"B": {"thread": "main", "ms": -1.0}})
        self.assertEqual(H.queue_predicts(q, "Y"), {"B": {"thread": "main", "ms": -3.0}})
        self.assertEqual(H.queue_predicts(q), {})  # ambiguous without the item
        t = self.t0

        def bench_dir(name, item, start, gate_expr, rep=1):
            d = os.path.join(self.dir, name)
            os.makedirs(d)
            a, g = v2run("A", rep, start), v2run("G", rep, start + 300)
            g["gate"] = {"expr": gate_expr, "value": True, "ok": True}
            for r in (a, g):
                with open(os.path.join(d, "%s-r%d.json" % (r["arm"], r["rep"])), "w") as f:
                    json.dump(r, f)
            meta = {"schema": "hbbench-meta-v2", "arms": [{"name": "A"}, {"name": "G"}], "argv": ["--arms", "q.json"] + (["--item", item] if item else [])}
            with open(os.path.join(d, "run.json"), "w") as f:
                json.dump(meta, f)
            return d

        x1 = bench_dir("x1", "X", t, "window.__x === 1")
        x2 = bench_dir("x2", "X", t + 1000, "window.__x === 1", rep=2)  # a second window of item X
        y1 = bench_dir("y1", "Y", t + 2000, "window.__y === 1")
        none1 = bench_dir("n1", None, t + 3000, "window.__x === 1")
        res, reps = H.report_bench([x1, x2], [], dt_utc(), ref="A", queue=q)
        self.assertEqual(res["item"], "X")
        self.assertEqual({(r["arm"], r["rep"]): r["status"] for r in reps}, {("A", 1): "VALID", ("G", 1): "VALID", ("A", 2): "VALID", ("G", 2): "VALID"})
        res, reps = H.report_bench([y1], [], dt_utc(), ref="A", queue=q)
        self.assertEqual(({r["arm"]: r["status"] for r in reps}, res["item"]), ({"A": "VALID", "G": "VALID"}, "Y"))
        for dirs in ([x1, y1], [y1, x1], [x1, x2, y1], [x1, none1], [none1, x1]):
            with self.assertRaises(H.MixedItems) as cm:
                H.report_bench(dirs, [], dt_utc(), ref="A", queue=q)
            self.assertIn("different queue items", str(cm.exception))
            for d in dirs:
                self.assertIn(d, str(cm.exception))
        self.assertEqual(H.main(["bench", x1, y1, "--local-tz=+00:00"]), 2)  # loud: exit 2, nothing printed as a report
        # predictions come from the dir's item too (Y predicts -3.0 ms for B, X -1.0 ms)
        yb = os.path.join(self.dir, "yb")
        os.makedirs(yb)
        for rep in (1, 2, 3):
            for r in (v2run("A", rep, t + 4000 + 900 * rep, fps=(40.0, 40.0, 40.0)), v2run("B", rep, t + 4300 + 900 * rep, fps=(45.0, 44.0, 40.2))):
                with open(os.path.join(yb, "%s-r%d.json" % (r["arm"], r["rep"])), "w") as f:
                    json.dump(r, f)
        with open(os.path.join(yb, "run.json"), "w") as f:
            json.dump({"schema": "hbbench-meta-v2", "item": "Y", "arms": [{"name": "A"}, {"name": "B"}]}, f)
        an = os.path.join(self.dir, "an")
        for i, (va, vb) in enumerate(((21.0, 20.0), (21.1, 20.1), (20.9, 19.9)), 1):
            self.anat(an, "A", i, va, t + 9000 + 300 * i)
            self.anat(an, "B", i, vb, t + 9100 + 300 * i)
        res, _ = H.report_bench([yb], [], dt_utc(), ref="A", queue=q, looks={"B": "pass"}, anatomy=an)
        v = res["verdicts"]["B"]
        self.assertEqual(v["R3"], "REVERT", v["why"])  # moved -1.0 ms of Y's predicted -3.0 (< 50 %)
        self.assertTrue(any("predicted -3.00" in x for x in v["why"]), v["why"])

    def test_failed_gate_is_invalid_not_incomplete(self):
        t = self.t0
        g = v2run("S-rustEntityWorld", 1, t + 300)
        g["error"] = "gate failed: window.__entityWorld && window.__entityWorld.stats().projections === 1 -> false"
        x = v2run("X", 1, t + 600)
        x["error"] = "boot never ready"
        self.write([v2run("A", 1, t), g, x])
        _, reps = self.bench(ref="A")
        st = {r["arm"]: (r["status"], r["reasons"]) for r in reps}
        self.assertEqual(st["S-rustEntityWorld"][0], "INVALID")
        self.assertTrue(st["S-rustEntityWorld"][1][0].startswith("gate: window.__entityWorld"))
        self.assertEqual(st["X"][0], "INCOMPLETE")

    def test_box_event_marks_contaminated(self):
        t = self.t0
        self.write([v2run("A", 1, t), v2run("B", 1, t + 400)])
        ev = [{"id": "x", "kind": "cpu-hog", "what": "hog", "from": H.from_epoch(t + 350, dt_utc()), "until": H.from_epoch(t + 500, dt_utc())}]
        res, reps = self.bench(events=ev, ref="A")
        st = {r["arm"]: r["status"] for r in reps}
        self.assertEqual(st, {"A": "VALID", "B": "CONTAMINATED"})

    def test_no_samples_is_unverified(self):
        r = v2run("A", 1, self.t0)
        r["box"] = [{"label": "x", "at": r["startedAt"], "error": "ssh timeout"}]
        self.write([r])
        _, reps = self.bench(ref="A")
        self.assertEqual(reps[0]["status"], "INVALID")
        self.assertIn("unverified", reps[0]["reasons"][0])

    def test_noisy_box_fallback_needs_five_reps_and_an_aa_pair(self):
        runs = []
        t = self.t0
        for rep in range(1, 6):
            runs.append(v2run("A", rep, t, idle=10)); t += 300
            runs.append(v2run("AA", rep, t, idle=10)); t += 300
        self.write(runs)
        _, reps = self.bench(ref="A", aa="AA", noisy_box=True)
        self.assertTrue(all(r["status"] == "NOISY-BOX" for r in reps))
        _, reps = self.bench(ref="A", noisy_box=True)  # no A/A arm named: no fallback
        self.assertTrue(all(r["status"] == "INVALID" for r in reps))
        _, reps = self.bench(ref="A", aa="AA")  # fallback not asked for: the idle gate stands
        self.assertTrue(all(r["status"] == "INVALID" for r in reps))

    def test_noisy_box_fallback_four_reps_are_not_enough(self):
        runs = []
        t = self.t0
        for rep in range(1, 5):  # 4 reps (and 3 below): under the plan's 5
            runs.append(v2run("A", rep, t, idle=10)); t += 300
            runs.append(v2run("AA", rep, t, idle=10)); t += 300
        self.write(runs)
        _, reps = self.bench(ref="A", aa="AA", noisy_box=True)
        self.assertEqual({r["status"] for r in reps}, {"INVALID"})
        os.remove(os.path.join(self.dir, "A-r4.json")); os.remove(os.path.join(self.dir, "AA-r4.json"))
        _, reps = self.bench(ref="A", aa="AA", noisy_box=True)
        self.assertEqual({r["status"] for r in reps}, {"INVALID"})
        # 4 idle-failing reps + 1 valid rep = 5: accepted (valid reps count toward the 5)
        self.write([v2run("A", 4, self.t0 + 9000, idle=10), v2run("AA", 4, self.t0 + 9300, idle=10), v2run("A", 5, self.t0 + 9600), v2run("AA", 5, self.t0 + 9900)])
        _, reps = self.bench(ref="A", aa="AA", noisy_box=True)
        st = collections_counter(r["status"] for r in reps)
        self.assertEqual(st, {"NOISY-BOX": 8, "VALID": 2})

    def test_noisy_box_waives_only_the_idle_gate(self):
        runs = []
        t = self.t0
        for rep in range(1, 6):
            runs.append(v2run("A", rep, t, idle=10)); t += 300
            runs.append(v2run("AA", rep, t, idle=10)); t += 300
            runs.append(v2run("G", rep, t, idle=10, g3=6.0)); t += 300   # gpu3d_other > 5 %: not waived
            runs.append(v2run("E", rep, t, idle=10, errors=["boom"])); t += 300  # idle + console error: not waived
        self.write(runs)
        _, reps = self.bench(ref="A", aa="AA", noisy_box=True)
        st = {}
        for r in reps:
            st.setdefault(r["arm"], set()).add(r["status"])
        self.assertEqual(st, {"A": {"NOISY-BOX"}, "AA": {"NOISY-BOX"}, "G": {"INVALID"}, "E": {"INVALID"}})
        self.assertEqual(H.V_SOFT, ("idle",))

    def test_r1_noise_with_and_without_aa(self):
        t = self.t0
        runs = []
        for rep, (a, aa, b) in enumerate(((45.0, 44.0, 47.0), (46.0, 44.5, 47.5), (44.0, 45.0, 46.5)), 1):
            runs += [v2run("A", rep, t, fps=(a, a, a)), v2run("AA", rep, t + 300, fps=(aa, aa, aa)), v2run("B", rep, t + 600, fps=(b, b, b))]
            t += 900
        self.write(runs)
        res, _ = self.bench(ref="A", aa="AA")
        c = res["compare"]["B"]["still.fps"]["valid"]
        # A median 45, AA median 44.5, A spread 2 -> noise max(0.5, 1.0) = 1.0; threshold max(2.0, 1.35) = 2.0; delta 2.0 -> not real
        self.assertEqual((c["ref"], c["arm"], c["noise"], c["threshold"], c["real"]), (45.0, 47.0, 1.0, 2.0, False))
        res2, _ = self.bench(ref="A")
        c2 = res2["compare"]["B"]["still.fps"]["valid"]
        self.assertEqual((c2["noise"], c2["threshold"]), (1.0, 2.0))

    def test_r1_aa_term_decides_when_it_exceeds_half_the_spread(self):
        t = self.t0
        runs = []
        # A reps 45/46/44 (median 45, spread 2 -> half 1.0); A' reps 42/42.5/43 (median 42.5): |A - A'| = 2.5
        for rep, (a, aa, b) in enumerate(((45.0, 42.0, 48.5), (46.0, 42.5, 48.5), (44.0, 43.0, 48.5)), 1):
            runs += [v2run("A", rep, t, fps=(a, a, a)), v2run("AA", rep, t + 300, fps=(aa, aa, aa)), v2run("B", rep, t + 600, fps=(b, b, b))]
            t += 900
        self.write(runs)
        res, _ = self.bench(ref="A", aa="AA")
        c = res["compare"]["B"]["still.fps"]["valid"]
        # noise = max(2.5, 1.0) = 2.5 -> threshold max(5.0, 1.35) = 5.0; delta 3.5 is NOT real
        self.assertEqual((c["noise"], c["threshold"], c["delta"], c["real"], c["verdict"]), (2.5, 5.0, 3.5, False, "within noise"))
        # without the A/A arm the same delta clears half the spread: noise 1.0, threshold 2.0 -> real
        res2, _ = self.bench(ref="A")
        c2 = res2["compare"]["B"]["still.fps"]["valid"]
        self.assertEqual((c2["noise"], c2["threshold"], c2["real"], c2["verdict"]), (1.0, 2.0, True, "better"))
        self.assertEqual(H.noise_of(H.arm_stats(H.assess(H.load_bench_dir(self.dir, dt_utc()), {self.dir: []}, [], ref="A"), ["A", "AA"], ("VALID",)),
                                    "A", "AA", ("still", "fps")), 2.5)

    def test_rule_v_cpu_hog_threshold(self):
        t = self.t0
        self.write([v2run("A", 1, t), v2run("B", 1, t + 300, top=[{"name": "hog", "pid": 9, "cores": 0.95, "ours": False}]),
                    v2run("C", 1, t + 600, top=[{"name": "busy", "pid": 9, "cores": 0.94, "ours": False}]),
                    v2run("D", 1, t + 900, top=[{"name": "chrome", "pid": 9, "cores": 3.9, "ours": True}])])
        _, reps = self.bench(ref="A")
        st = {r["arm"]: r["status"] for r in reps}
        self.assertEqual(st, {"A": "VALID", "B": "INVALID", "C": "VALID", "D": "VALID"})

    def test_compat_v1_rep_reads_boxwatch_between_its_own_samples(self):
        # a --compat v1 rep samples itself only before launch and after the tour (both idle); the dir's
        # boxwatch.log saw the person mid-run: the rep is INVALID, from both sources together
        r = v2run("A", 1, self.t0)
        r["box"] = [b for b in r["box"] if b["label"] in ("pre-launch", "post-tour")]
        r["serverState"] = {"end": {"entities": 100}}
        self.write([r])
        mid = time.strftime("%H:%M:%S", time.gmtime(self.t0 + 140))
        with open(os.path.join(self.dir, "boxwatch.log"), "w") as f:
            f.write("%s idle=4 hbage=2 browsers=1 gpu3d_other=0.3\n" % mid)
        _, reps = self.bench(ref="A")
        self.assertEqual(reps[0]["status"], "INVALID", reps[0]["reasons"])
        self.assertTrue(any(x.startswith("idle: 4s") for x in reps[0]["reasons"]), reps[0]["reasons"])
        self.assertEqual(reps[0]["vinfo"]["boxSource"], "run-json+boxwatch")
        os.remove(os.path.join(self.dir, "boxwatch.log"))
        _, reps = self.bench(ref="A")
        self.assertEqual((reps[0]["status"], reps[0]["vinfo"]["boxSource"]), ("VALID", "run-json"))

    def test_server_pin_reads_the_post_tour_census_of_a_compat_v1_rep(self):
        t = self.t0
        a, b = v2run("A", 1, t), v2run("B", 1, t + 300)
        b["serverState"] = {"end": {"entities": 130}}  # compat v1: no settled census
        self.write([a, b])
        _, reps = self.bench(ref="A")
        st = {r["arm"]: (r["status"], " | ".join(r["reasons"])) for r in reps}
        self.assertEqual(st["B"][0], "INVALID")
        self.assertIn("130 entities vs 100", st["B"][1])
        self.assertEqual(H.real_threshold("ms", 30.0, 0.1), 0.5)
        self.assertEqual(H.real_threshold("fps", 40.0, 0.0), 1.2)
        self.assertEqual(H.real_threshold("count", 20, 0.2), 1.0)

    def test_r3_keep_revert_inconclusive(self):
        t = self.t0
        runs = []
        for rep in (1, 2, 3):
            runs += [v2run("A", rep, t, fps=(40.0, 40.0, 40.0)), v2run("WIN", rep, t + 300, fps=(45.0, 44.0, 40.2)),
                     v2run("LOSE", rep, t + 600, fps=(45.0, 35.0, 40.0)), v2run("HITCH", rep, t + 900, fps=(45.0, 44.0, 40.0), ft_max=2000)]
            t += 1200
        self.write(runs)
        stats = H.arm_stats(H.assess(H.load_bench_dir(self.dir, dt_utc()), {self.dir: []}, [], ref="A"), ["A", "WIN", "LOSE", "HITCH"], ("VALID",))
        self.assertEqual(H.r3_keep(stats, "A", None, "WIN", predict=-1.0, measured_ms=-0.8, errors=0, look="pass"), ("KEEP", []))
        v, why = H.r3_keep(stats, "A", None, "WIN", predict=-1.0, measured_ms=-0.4, errors=0, look="pass")
        self.assertEqual(v, "REVERT"); self.assertIn("(i)", why[0])
        v, why = H.r3_keep(stats, "A", None, "LOSE", predict=-1.0, measured_ms=-1.0, errors=0, look="pass")
        self.assertEqual(v, "REVERT"); self.assertTrue(any("regressed" in x and "moving" in x for x in why))
        v, why = H.r3_keep(stats, "A", None, "HITCH", predict=-1.0, measured_ms=-1.0, errors=0, look="pass")
        self.assertEqual(v, "REVERT"); self.assertTrue(any("(iii)" in x and "firstTurn max" in x for x in why))
        v, why = H.r3_keep(stats, "A", None, "WIN", predict=None, measured_ms=None, errors=0, look=None)
        self.assertEqual(v, "INCONCLUSIVE"); self.assertEqual(len(why), 2)
        self.assertEqual(H.r3_keep(stats, "A", None, "WIN", predict=-1.0, measured_ms=-1.0, errors=2, look="pass")[0], "REVERT")
        self.assertEqual(H.r3_keep(stats, "A", None, "WIN", predict=-1.0, measured_ms=-1.0, errors=0, look="fail")[0], "REVERT")

    def test_r5_r6(self):
        self.assertEqual(H.r5_route(22.0, 14.5, 15.0, 25.0), ("main", "main-thread levers first"))
        self.assertEqual(H.r5_route(12.0, 14.5, 10.0, 25.0)[1].split(" ")[0], "GL-command")
        self.assertEqual(H.r5_route(12.0, 10.0, 23.0, 25.0), ("GPU", "GPU levers first (GPU ms >= 0.9 x frame time)"))
        self.assertEqual(H.r5_route(None, None, None), (None, "no anatomy"))
        self.assertEqual(H.r6_stop(-1.4, -0.6), "STOP")
        self.assertEqual(H.r6_stop(-1.4, -0.8), "CONTINUE")
        self.assertIsNone(H.r6_stop(None, 1))

    def test_probe_rows_heading_binned(self):
        r = v2run("A", 1, self.t0)
        r["probe"] = {"still": {"headingBins": {"sectorMean": {"calls": 1079.0, "realDraws": 1500.0, "issued": 600.0, "subDraws": 1500.0}, "covered": 1},
                                "ranges": {"terrain": {"mean": 41.0}}, "renderJs": {"p50": 9.5}, "walks": {"mean": 9.0}, "emptyWalks": {"mean": 2.0}, "usPerCall": 8.8}}
        self.write([r])
        res, _ = self.bench(ref="A")
        p = res["probe"]["A"]["still"]
        self.assertEqual((p["callsBinned"], p["realDrawsBinned"], p["terrainRanges"], p["renderJsP50"], p["emptyWalks"]), (1079.0, 1500.0, 41.0, 9.5, 2.0))

    def test_trace_split_windows(self):
        path = os.path.join(self.dir, "t.json")
        ev = [
            {"ph": "M", "name": "thread_name", "pid": 1, "tid": 1, "args": {"name": "CrGpuMain"}},
            {"ph": "M", "name": "thread_name", "pid": 2, "tid": 7, "args": {"name": "CrRendererMain"}},
            {"ph": "R", "cat": "blink.user_timing", "name": "hbA:w0", "ts": 1000000, "pid": 2, "tid": 7},
            {"ph": "R", "cat": "blink.user_timing", "name": "hbA:w1", "ts": 2000000, "pid": 2, "tid": 7},
            {"ph": "R", "cat": "blink.user_timing", "name": "hbA:end", "ts": 3000000, "pid": 2, "tid": 7},
        ]
        for i in range(10):  # window 0: 10 presents, WebGL 8 ms + raster 2 ms each
            base = 1000000 + i * 100000
            ev += [{"ph": "X", "pid": 1, "tid": 1, "ts": base, "dur": 8000, "name": "GpuChannel::ExecuteDeferredRequest"},
                   {"ph": "X", "pid": 1, "tid": 1, "ts": base + 10, "dur": 7000, "name": "WebGL"},
                   {"ph": "X", "pid": 1, "tid": 1, "ts": base + 9000, "dur": 2000, "name": "Task"},
                   {"ph": "X", "pid": 1, "tid": 1, "ts": base + 9010, "dur": 1500, "name": "RasterDecoderImpl::DoEndRasterCHROMIUM"},
                   {"ph": "X", "pid": 1, "tid": 1, "ts": base + 12000, "dur": 500, "name": "DXGISwapChainImageBacking::Present"},
                   {"ph": "X", "pid": 2, "tid": 7, "ts": base, "dur": 20000, "name": "ThreadControllerImpl::RunTask"},
                   {"ph": "X", "pid": 2, "tid": 7, "ts": base + 100, "dur": 1000, "name": "MinorGC"}]
        with open(path, "w") as f:
            f.write('{"traceEvents":[\n' + ",\n".join(json.dumps(e) for e in ev) + "]}\n")
        r = H.trace_split(path, "hbA:")
        w0, w1 = r["windows"]
        self.assertEqual((w0["window"], w0["presents"], w0["webglPerPresent"], w0["rasterPerPresent"], w0["presentPerPresent"]), ("hbA:w0", 10, 8.0, 2.0, 0.5))
        self.assertEqual((w0["mainBusyPerPresent"], w0["gcMs"]), (20.0, 10.0))
        self.assertEqual((w1["presents"], w1["crGpuMainBusyMs"]), (0, 0.0))
        whole = H.trace_split(path)
        self.assertEqual(whole["windows"][0]["presents"], 10)

    def test_program_diff(self):
        a = {"programKeys": [{"cacheKey": "MeshStandardMaterial,1,0,numPointLights=4"}, {"cacheKey": "Basic,0"}]}
        b = {"programKeys": [{"cacheKey": "MeshStandardMaterial,1,0,numPointLights=6"}, {"cacheKey": "Basic,0"}]}
        d = H.program_diff(a, b)
        self.assertEqual((d["onlyA"], d["onlyB"]), (1, 1))
        self.assertIn("numPointLights=4 -> numPointLights=6", d["changedFields"][0][0])

    def test_ceiling_r8(self):
        probe = {"windows": [{"variant": "V0", "renderMs": 10.0, "gpuMs": 9.0}, {"variant": "V1", "renderMs": 5.0, "gpuMs": 8.0},
                             {"variant": "V2", "renderMs": 7.0, "gpuMs": 7.5}, {"variant": "V3", "renderMs": 13.0, "gpuMs": 14.0}]}
        split = {"windows": [{"window": "hbSC:V0:r1", "webglPerPresent": 10.0}, {"window": "hbSC:V1:r1", "webglPerPresent": 5.5},
                             {"window": "hbSC:gap", "webglPerPresent": 99.0}, {"window": "hbSC:V2:r1", "webglPerPresent": 8.0}]}
        r = H.ceiling(probe, split)
        self.assertEqual(r, H.ceiling({"schema": "hbanatomy-eval-v1", "result": probe}, split))  # the --attach --eval wrapper
        self.assertEqual(r["variants"]["V1"]["webglPerPresent"], 5.5)
        self.assertTrue(r["R8"]["verdict"].startswith("PROCEED"))
        probe["windows"][1]["renderMs"] = 8.0
        self.assertTrue(H.ceiling(probe, split)["R8"]["verdict"].startswith("RE-SCOPE"))

    def test_ceiling_r8_needs_both_threads(self):
        P = lambda v1, v2: {"windows": [{"variant": "V0", "renderMs": 10.0}, {"variant": "V1", "renderMs": v1}, {"variant": "V2", "renderMs": v2}]}
        S = lambda w1, w2: {"windows": [{"window": "hbSC:V0:r1", "webglPerPresent": 10.0}, {"window": "hbSC:V1:r1", "webglPerPresent": w1},
                                        {"window": "hbSC:V2:r1", "webglPerPresent": w2}]}
        v = lambda p, s=None: H.ceiling(p, s)["R8"]["verdict"].split(" ")[0]
        # main-thread cut 50 % but the CrGpuMain WEBGL cut only 30 %: the GL half decides -> re-scope
        self.assertEqual(v(P(5.0, 7.0), S(7.0, 8.0)), "RE-SCOPE")
        # WEBGL cut 45 % but main-thread cut 35 % / 30 %: below 40 % -> re-scope (a 0.3 threshold would proceed)
        self.assertEqual(v(P(6.5, 7.0), S(5.5, 5.5)), "RE-SCOPE")
        # main 50 % + WEBGL 35 %: re-scope; exactly 40 % on both: proceed (>=)
        self.assertEqual(v(P(5.0, 9.0), S(6.5, 9.0)), "RE-SCOPE")
        self.assertEqual(v(P(6.0, 9.0), S(6.0, 9.0)), "PROCEED")
        # V2 alone may carry it
        self.assertEqual(v(P(9.0, 5.0), S(9.0, 5.0)), "PROCEED")
        # no trace split: the WEBGL half is missing -> INCONCLUSIVE when the main half passes ...
        r = H.ceiling(P(5.0, 9.0))
        self.assertEqual(r["R8"]["verdict"].split(" ")[0], "INCONCLUSIVE")
        self.assertIn("webglPerPresent", r["R8"]["verdict"]); self.assertTrue(r["R8"]["webglMissing"])
        # ... and RE-SCOPE when the measured half already fails everywhere
        self.assertEqual(v(P(8.0, 9.0)), "RE-SCOPE")
        # no V1/V2 windows at all
        self.assertEqual(v({"windows": [{"variant": "V0", "renderMs": 10.0}]}), "INCONCLUSIVE")
        self.assertEqual(H.R8_CUT, 0.40)

    def test_m1c_rows(self):
        r = v2run("H-default", 1, self.t0)
        r["probe"] = {"still": {"headingBins": {"sectorMean": {"calls": 1000.0, "realDraws": 1400.0}}, "renderJs": {"p50": 10.0}}}
        r["asserts"]["window"] = {"inner": [1920, 1080], "dpr": 1}
        self.write([r])
        w = os.path.join(self.dir, "W-r1.json")
        with open(w, "w") as f:
            json.dump({"phases": [{"phase": "idle", "avgFps": 60.0}], "render": {"idle": {"drawCalls": 800}}, "renderJs": {"idle": {"p50Ms": 6.4}},
                       "viewport": {"width": 1920, "height": 1080}, "renderSampling": "frame-heading-binned"}, f)
        res = H.m1c([self.dir], [w], dt_utc())
        rows = {x["side"]: x for x in res["rows"]}
        self.assertEqual(rows["H"]["usPerDraw"], 10.0)
        self.assertEqual(rows["W"]["usPerDraw"], 8.0)

    def test_ledger_from_anatomy(self):
        a = v2run("A", 1, self.t0)
        a.update({"schema": "hbanatomy-v1", "pins": {"window": {"inner": [1920, 1080]}}, "passes": {"gpuMsPerFrame": 14.0},
                  "calibration": {"usPerCallRenderJs": 9.1, "usPerRealDrawWebgl": 6.2},
                  "trace": {"still": {"windows": [{"window": 0, "frames": 220, "fps": 44.0}, {"window": 1, "frames": 225, "fps": 45.0}]},
                            "orbit": {"windows": [{"window": 0, "frames": 200, "fps": 40.0}]},
                            "split": {"windows": [{"window": "hbAnat:still:w0", "spanMs": 5000, "mainBusyPerPresent": 21.0, "crGpuMainPerPresent": 15.0, "webglPerPresent": 10.0},
                                                  {"window": "hbAnat:still:w1", "spanMs": 5000, "mainBusyPerPresent": 22.0, "crGpuMainPerPresent": 16.0, "webglPerPresent": 11.0},
                                                  {"window": "hbAnat:still:w2", "spanMs": 4, "mainBusyPerPresent": 99.0, "crGpuMainPerPresent": 99.0, "webglPerPresent": 99.0},
                                                  {"window": "hbAnat:orbit:w0", "spanMs": 5000, "mainBusyPerPresent": 20.0, "crGpuMainPerPresent": 24.0, "webglPerPresent": 19.0}]}}})
        f = os.path.join(self.dir, "anatomy.json")
        with open(f, "w") as fh:
            json.dump(a, fh)
        row = H.ledger([f])[0]
        self.assertEqual(row["status"], "VALID", row["reasons"])
        self.assertEqual((row["still"]["main"], row["still"]["CrGpuMain"], row["still"]["webgl"], row["still"]["GPU"]), (21.5, 15.5, 10.5, 14.0))
        self.assertEqual((row["still"]["binding"], row["still"]["lever"]), ("main", "main-thread levers first"))
        self.assertEqual(row["orbit"]["binding"], "CrGpuMain")
        self.assertTrue(row["orbit"]["lever"].startswith("GL-command"))
        self.assertEqual((row["usPerCallRenderJs"], row["usPerRealDrawWebgl"]), (9.1, 6.2))
        self.assertEqual(H.binding_ms(a, "main"), 21.5)

    def test_half_up_and_dmean(self):
        self.assertEqual(H.dmean(["14.24", "11.71"]), 12.98)  # float round() would give 12.97
        self.assertEqual(H.half_up(2.675, 2), 2.68)
        self.assertEqual(H.dmean(["32.0", "35.5", "36.1"], 1), 34.5)


def dt_utc():
    return H.parse_tz("+00:00")


def collections_counter(it):
    out = {}
    for x in it:
        out[x] = out.get(x, 0) + 1
    return out


if __name__ == "__main__":
    res = unittest.main(exit=False, verbosity=2).result
    total = res.testsRun
    bad = len(res.failures) + len(res.errors)
    print("\nhbreport: %d passed, %d failed, %d skipped" % (total - bad - len(res.skipped), bad, len(res.skipped)))
    sys.exit(1 if bad else 0)
