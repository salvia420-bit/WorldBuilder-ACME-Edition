#!/usr/bin/env python3
"""Dereth Town Tour v2 (2026-10-15): double the shots in the same 57 minutes.

Owner brief: "double the number of shots, in areas we havent covered" (acpedia Category:Major POI) — "the quality of
our current shots cant be disturbed. e.g. cant be sped up just to cram more shots in the 57 minutes. they should
instead just be shorter, capturing the best part of the existant idea".

Every shot uses the plan field `trim: {takeSec, inSec}` (tools/film/plan): the move is flown as a take of takeSec —
for the 273 v1 shots exactly their v1 take (same ShotSpec duration, so every frame is identical to v1) — and the edit
is a window of it. The music fit only chooses window lengths and positions; it can never change a move's speed.

Inputs: research/final-plan-build/plan-v1-273shots.json + timeline-v1-273shots.json (the v1 plan as compiled),
research/windows/windows-*.json (best window per v1 shot), research/poi-*.json (Major POI dossiers), song/song.json.
Output: plan.json (v2; path = argv[1]) + research/final-plan-build/build2_report.json. Pure offline; deterministic.

Steps: curation (critic decisions, below) → quota of exactly 273 new shots → units in edit order (v1 site runs, POI
units inserted after the v1 site they follow on the route) → no technique twice across a cut → allocation pass 1 →
energy pass (POI unit order inside each route gap, shot order inside each POI unit, big moves onto loud music) →
allocation pass 2 → windows placed inside each take → plan + report.
Allocation: λ-scaled ideal window lengths clamped to [minSec, keep span − dissolve handles]; the movement starts split
the film into segments that the pinned opener sites start exactly; per unit a DP over the beat/section grid G (the
points a {sec} request lands on exactly in compile.mjs) picks the cuts.
"""
import bisect, copy, glob, itertools, json, math, os, statistics, sys
from collections import Counter, defaultdict

PROJ = "/mnt/wbterminal2/film-projects/dereth-town-tour"
R = f"{PROJ}/research"
HERE = os.path.dirname(os.path.abspath(__file__))
V1 = f"{HERE}/plan-v1-273shots.json"
V1TL = f"{HERE}/timeline-v1-273shots.json"
OUT = sys.argv[1] if len(sys.argv) > 1 else f"{PROJ}/plan.json"
NEW_QUOTA = 274  # 273 + 1: the two v1 Egg Orchard dungeon shots became ONE full run in the tail, so the film stays at 2 × 273 = 546
FPS = 24
DISSOLVE = 0.8
SONG = json.load(open(f"{PROJ}/song/song.json"))
SONG_DUR = SONG["durationSec"]

# ------------------------------------------------------------------ curation (the critic pass, 2026-10-15)
# Whole POI sites left out of the film, with the reason (the dossiers stay in research/ for later use).
EXCLUDE_SITES = {
    "poi-mount-dalt": "six look-alike 224 m Alphus-range mesas back to back; the Syliph pano already frames Dalt's summit and its only shot circles a runtime-only portal swirl",
    "poi-mount-gemm": "same mesa run; the Syliph pano frames Gemm",
    "poi-tumerok-outpost-90n-657w": "13 Tumerok-kit sites in the funeral march; a 3.58 s rack-focus whose pull began inside its dissolve",
    "poi-tumerok-outpost-19n-567w": "Tumerok-kit run (five kit sites within 50 s)",
    "poi-tumerok-fort-511s-820w": "back-to-back twin of Tumerok Fort 45.2S",
    "poi-south-yanshi-outpost": "same 28 m Empyrean outpost tower as North Yanshi 26 s earlier",
    "poi-west-al-arqas-outpost": "same 28 m Empyrean outpost tower as North Al-Arqas 38 s earlier",
    "poi-festival-stone-of-morningthaw": "third Festival Stone within 44 s of the Egmont coda (rank-3 arc)",
}
# Spare shots never used to refill the quota (repetitive), and spares refilled first (protected from the quota cut).
NEVER_SHOTS = {("poi-north-al-arqas-outpost", "classic.tilt"), ("poi-qalabar-festival-grounds", "classic.crane")}
PRIORITY_SHOTS = {("poi-inner-sea-port-ruins", "drone.hyperlapse-orbit"),
                  ("poi-asherons-castle", "classic.worms-eye"), ("poi-the-pit-of-heretics", "classic.worms-eye"),
                  ("poi-fort-witshire", "drone.fly-by"), ("poi-mount-lethe", "drone.fly-by"), ("poi-aun-settlement", "drone.top-down")}
# Route position fixes: keep v1's fiun-outpost.05 → silyun.01 cut (the push into the Portal to Silyun cuts to Silyun).
INSERT_OVERRIDE = {"poi-the-shadow-pass": "eastwatch" if not os.environ.get("BUILD2_KEEP_EO") else "egg-orchard", "poi-karluns-fort": "silyun"}
# v1 window overrides: the owner's Egg Orchard FPV corridor keeps all three right-angle turns (t≈2, 8, 9.3); the
# frozen-portal push-in gets a usable length between its two dissolves.
WINDOW_OVERRIDE = {"egg-orchard.01": {"keep": [0.79, 14.041667], "anchor": "end", "minSec": 12.0, "idealSec": 12.6},
                   "egg-orchard-portal.01": {"minSec": 4.5}}
# The Egg Orchard leaves the music edit (owner, 2026-10-15): the frozen-portal push-in and a full JEV-piloted FPV run
# from the entrance drop to the exit portal are APPENDED after the music as a silent tail (plan.edit.tail).
TAIL_SITES = [] if os.environ.get("BUILD2_KEEP_EO") else ["egg-orchard-portal", "egg-orchard"]  # env: v2.1 comparison builds
RUN_DIR = f"{R}/egg-orchard-run"
TAIL = {"from": "egg-orchard-portal.01", "gapSec": 1.5, "fadeOutSec": 3}
PORTAL_TAIL = {"durationSec": 8.5, "inSec": 1.5, "fadeInSec": 2.0}  # 1.5–10.0 s of its unchanged 10.875 s take
# Movement starts (song/LICENSE.txt track map) and the site that opens each one. Eroica I starts in the silence after
# the Egmont's last chord (section start 539.809, before the two hammer chords at 542.1 / 543.3); the others on the
# first downbeat after the movement start. The Finale's fortissimo cuts in hard (no dissolve).
OPENERS = [("poi-obsidian-span", 539.809), ("plateau-village", None), ("samsur", None), ("poi-burun-fortress", None)]
MOVEMENTS = [541.897, 1453.377, 2379.517, 2728.857]
HARD_CUT_INTO = {"poi-burun-fortress"}
# Shot orders the critics set by hand (the energy pass leaves them alone).
PROTECT_ORDER = {"poi-renegade-fortress", "poi-deru-trees-of-marae-lassel", "poi-burun-ruuk-village"}

# ------------------------------------------------------------------ song grid (mirror of tools/film/plan/compile.mjs)
beats = SONG["beats"]
period = statistics.median([beats[i + 1] - beats[i] for i in range(len(beats) - 1)])
bar_starts = [b["start"] for b in SONG["bars"]]
bar_len = statistics.median([bar_starts[i + 1] - bar_starts[i] for i in range(len(bar_starts) - 1)])
sec_starts = [s["start"] for s in SONG["sections"]]
TOL = 0.5 * bar_len
energy = SONG["energy"]["values"]
HOP = SONG["energy"]["hopSec"]


def time_at(arr, step, pos):
    n = len(arr)
    if pos <= 0:
        return arr[0] + pos * step
    if pos >= n - 1:
        return arr[n - 1] + (pos - (n - 1)) * step
    k = math.floor(pos)
    return arr[k] + (pos - k) * (arr[k + 1] - arr[k])


def pos_at(arr, step, t):
    n = len(arr)
    if t <= arr[0]:
        return (t - arr[0]) / step
    if t >= arr[n - 1]:
        return n - 1 + (t - arr[n - 1]) / step
    lo = bisect.bisect_right(arr, t) - 1
    span = arr[lo + 1] - arr[lo]
    return lo + ((t - arr[lo]) / span if span > 0 else 0)


def nearest_beat(t):
    p = pos_at(beats, period, t)
    a = time_at(beats, period, math.floor(p))
    b = time_at(beats, period, math.ceil(p))
    return a if t - a <= b - t else b


def ceil_beat(t):
    k = math.ceil(pos_at(beats, period, t) - 1e-9)
    x = time_at(beats, period, k)
    while x < t - 1e-9:
        k += 1
        x = time_at(beats, period, k)
    return x


def resolve_end(in_t, dur):
    """compile.mjs resolveEnd for {sec}: a section start within half a bar wins, else the nearest beat."""
    min_t = in_t + 1 / FPS
    target = in_t + dur
    best = None
    for s in sec_starts:
        if s < min_t - 1e-9:
            continue
        d = abs(s - target)
        if d <= TOL + 1e-9 and (best is None or d < abs(best - target) - 1e-9):
            best = s
    if best is not None:
        return best
    t = nearest_beat(target)
    if t < min_t - 1e-9:
        t = ceil_beat(min_t)
    return t


F = lambda t: round(t * FPS)  # noqa: E731
FD = round(DISSOLVE * FPS)  # dissolve frames (compile: max(2, round(d·fps)))


def first_downbeat_after(t):
    return bar_starts[bisect.bisect_left(bar_starts, t - 1e-6)]


def snap_section(t):
    return min(sec_starts, key=lambda s: abs(s - t))


ANCHORS = [(site, snap_section(t) if t is not None else first_downbeat_after(m)) for (site, t), m in zip(OPENERS, MOVEMENTS)]

# grid of cut points: compile resolves a {sec} end to a section start within half a bar, else to the nearest beat, so
# requesting a point of G (a section start, or a beat with no section start within half a bar) lands exactly on it.
G = sorted({resolve_end(-1.0, b + 1.0) for b in beats if b > 0} | {s for s in sec_starts if s > 0})
G = [g for g in G if g < SONG_DUR - 1e-6] + [SONG_DUR]
Gf = [F(g) for g in G]
for _, A in ANCHORS:
    assert min(abs(g - A) for g in G) < 1e-6, f"movement anchor {A} is not a grid point"


def mean_energy(t0, t1):
    a = int(t0 / HOP)
    b = max(a + 1, int(t1 / HOP))
    v = energy[a:b]
    return sum(v) / len(v) if v else 0.0


# ------------------------------------------------------------------ v1 plan, its takes, the windows
v1 = json.load(open(V1))
tl1 = {i["shotId"]: i for i in json.load(open(V1TL))["items"]}
win = {}
for f in sorted(glob.glob(os.environ.get("BUILD2_WINDOWS", f"{R}/windows/windows-*.json"))):
    for w in json.load(open(f))["windows"]:
        win[w["id"]] = w
for sid, o in WINDOW_OVERRIDE.items():
    if sid in win:
        win[sid] = {**win[sid], **o, "reason": (win[sid].get("reason") or "") + f" [orchestrator override {o}]"}
missing_w = [s["id"] for s in v1["shots"] if s["id"] not in win]
if missing_w:
    sys.exit(f"windows missing for {len(missing_w)} v1 shots: {missing_w[:8]}")
v1_sites = {s["id"]: s for s in v1["sites"]}


def anchor_xy(site):
    a = site["anchor"]
    if isinstance(a, list):
        return a[:2]
    cell = int(a["cell"], 16)
    return [((cell >> 24) & 255) * 192 + a["local"][0], ((cell >> 16) & 255) * 192 + a["local"][1]]


# ------------------------------------------------------------------ POI dossiers
pois = []
excluded = []
for f in sorted(glob.glob(os.environ.get("BUILD2_POIS", f"{R}/poi-*.json"))):
    d = json.load(open(f))
    if not isinstance(d, dict) or "shots" not in d or "site" not in d:
        continue
    d["_file"] = f
    if d["site"]["id"] in EXCLUDE_SITES:
        excluded.append({"site": d["site"]["id"], "shots": len(d["shots"]), "why": EXCLUDE_SITES[d["site"]["id"]]})
        continue
    d["shots"] = [s for s in d["shots"] if (d["site"]["id"], s["technique"]) not in NEVER_SHOTS]
    if d["shots"]:
        pois.append(d)
site_ids = set(v1_sites)
for d in pois:
    sid = d["site"]["id"]
    assert sid.startswith("poi-") and sid not in site_ids, f"bad/duplicate POI site id {sid} ({d['_file']})"
    site_ids.add(sid)

# ------------------------------------------------------------------ quota: exactly NEW_QUOTA new shots
cand = [(d, k, s) for d in pois for k, s in enumerate(d["shots"])]
tech_count = Counter(s["technique"] for s in v1["shots"]) + Counter(s["technique"] for _, _, s in cand)
keep = {(id(d), k) for d, k, _ in cand}
per_poi = Counter(id(d) for d, _, _ in cand)
dropped = []
while len(keep) > NEW_QUOTA:
    best = None
    for d, k, s in cand:
        if (id(d), k) not in keep or per_poi[id(d)] <= 1 or (d["site"]["id"], s["technique"]) in PRIORITY_SHOTS:
            continue
        key = (s.get("rank", 2), per_poi[id(d)], tech_count[s["technique"]], k)
        if best is None or key > best[0]:
            best = (key, d, k, s)
    if best is None:
        break
    _, d, k, s = best
    keep.discard((id(d), k))
    per_poi[id(d)] -= 1
    tech_count[s["technique"]] -= 1
    dropped.append(f"{d['site']['id']} #{k + 1} {s['technique']} (rank {s.get('rank')})")
if len(keep) != NEW_QUOTA:
    sys.exit(f"{len(keep)} new shots available after curation, quota {NEW_QUOTA}")
for d in pois:
    d["_shots"] = [s for k, s in enumerate(d["shots"]) if (id(d), k) in keep]

# ------------------------------------------------------------------ units in edit order (v1 site runs + POI units)
runs = []
for s in v1["shots"]:
    if s["site"] in TAIL_SITES:
        continue
    if runs and runs[-1]["site"] == s["site"]:
        runs[-1]["shots"].append(s)
    else:
        runs.append({"site": s["site"], "shots": [s], "kind": "v1"})
run_sites = [r["site"] for r in runs]
REDIRECT = ({"eastwatch": "egg-orchard", "egg-orchard-portal": "egg-orchard"} if not TAIL_SITES else {"egg-orchard": "eastwatch", "egg-orchard-portal": "eastwatch"})
REDIRECT["sanamar"] = "sanamar-royal-hall"
by_after = defaultdict(list)
for d in pois:
    a = INSERT_OVERRIDE.get(d["site"]["id"]) or d.get("insertAfter") or ""
    a = REDIRECT.get(a, a)
    if a not in run_sites:
        a = min(run_sites, key=lambda s: math.dist(anchor_xy(v1_sites[s]), d["site"]["anchor"][:2]))
    d["_after"] = a
    by_after[a].append(d)
units = []
for i, r in enumerate(runs):
    r["gap"] = None
    units.append(r)
    ps = by_after.get(r["site"], [])
    if ps:
        A = anchor_xy(v1_sites[r["site"]])
        B = anchor_xy(v1_sites[runs[i + 1]["site"]]) if i + 1 < len(runs) else A
        ab = (B[0] - A[0], B[1] - A[1])
        L2 = ab[0] ** 2 + ab[1] ** 2 or 1.0
        ps.sort(key=lambda d: ((d["site"]["anchor"][0] - A[0]) * ab[0] + (d["site"]["anchor"][1] - A[1]) * ab[1]) / L2)
        for d in ps:
            units.append({"site": d["site"]["id"], "shots": list(d["_shots"]), "kind": "poi", "poi": d, "gap": r["site"]})
opener_sites = [s for s, _ in ANCHORS]
pos_of = {u["site"]: i for i, u in enumerate(units)}
assert all(s in pos_of for s in opener_sites), "an opener site is missing"
assert [pos_of[s] for s in opener_sites] == sorted(pos_of[s] for s in opener_sites), "openers out of order"

# ------------------------------------------------------------------ move classes (energy pass, repeat checks)
BIG = {
    **{t: 3 for t in ["drone.flyover", "drone.pass-over", "drone.terrain-skim", "drone.canyon-run", "fpv.fpv-dive", "fpv.fpv-proximity",
                      "fpv.fpv-gap", "fpv.fpv-flip", "fpv.fpv-corridor", "drone.fly-by", "drone.flythrough", "drone.boomerang", "drone.helix",
                      "drone.spiral-descent", "drone.boom-rise", "drone.rising-reveal", "drone.vertigo-drone", "drone.orbit-poi", "classic.whip-pan",
                      "classic.dolly-zoom", "drone.dronie", "drone.top-down-rise", "drone.hyperlapse-orbit"]},
    **{t: 2 for t in ["drone.tilt-reveal", "drone.pano-360", "drone.top-down", "drone.parallax-slide", "classic.orbit", "classic.arc", "classic.truck",
                      "classic.pull-out-reveal", "classic.establishing", "classic.crane", "classic.hyperlapse", "classic.push-in", "classic.dolly-in",
                      "classic.dolly-out", "classic.steadicam", "classic.handheld", "classic.pov", "classic.roll", "classic.pedestal",
                      "classic.reveal-from-occluder", "classic.time-lapse"]},
    **{t: 1 for t in ["classic.static", "classic.pan", "classic.tilt", "classic.zoom", "classic.rack-focus", "classic.over-the-shoulder",
                      "classic.two-shot", "classic.high-angle", "classic.low-angle", "classic.birds-eye", "classic.worms-eye"]},
}
FAMILY = {}
for fam, ts in {"rise": ["drone.boom-rise", "drone.rising-reveal", "classic.pedestal", "classic.crane", "drone.top-down-rise"],
                "circle": ["drone.orbit-poi", "classic.orbit", "classic.arc", "drone.helix", "drone.hyperlapse-orbit", "drone.spiral-descent"],
                "pass": ["drone.flyover", "drone.pass-over", "drone.fly-by", "drone.terrain-skim", "drone.canyon-run"],
                "pull": ["drone.dronie", "classic.dolly-out", "classic.pull-out-reveal", "drone.boomerang"],
                "push": ["classic.push-in", "classic.dolly-in", "classic.zoom"]}.items():
    for t in ts:
        FAMILY[t] = fam
CLOSERS = {"drone.dronie", "drone.top-down-rise", "classic.pull-out-reveal", "classic.dolly-out", "drone.boomerang"}
OPENER_MOVES = {"classic.establishing", "drone.rising-reveal", "drone.tilt-reveal", "drone.boom-rise", "drone.flyover", "drone.terrain-skim", "drone.canyon-run"}


def order_ok(orig, q):
    """A POI unit's shot order keeps the designers' arc: an opening move that opened the unit stays first, a closing
    move that closed it stays last; no closing move moved to the front, no opening move to the end."""
    if orig[0]["technique"] in OPENER_MOVES and q[0] is not orig[0]:
        return False
    if len(orig) > 1 and orig[-1]["technique"] in CLOSERS and q[-1] is not orig[-1]:
        return False
    if q[0]["technique"] in CLOSERS and q[0] is not orig[0]:
        return False
    if len(q) > 1 and q[-1]["technique"] in OPENER_MOVES and q[-1] is not orig[-1]:
        return False
    return True


def repeats(ui):
    u = units[ui]
    a = ui > 0 and units[ui - 1]["shots"][-1]["technique"] == u["shots"][0]["technique"]
    b = ui + 1 < len(units) and units[ui + 1]["shots"][0]["technique"] == u["shots"][-1]["technique"]
    return a or b


def fix_repeats(log):
    """No technique twice across a cut: reorder a POI unit's shots (order_ok), else swap with the next POI unit of
    the same gap (never moving an opener site)."""
    for ui in range(len(units)):
        u = units[ui]
        if u["kind"] != "poi" or not repeats(ui):
            continue
        sh = u["shots"]
        fixed = False
        if u["site"] not in opener_sites:
            for perm in itertools.permutations(range(len(sh))):
                q = [sh[i] for i in perm]
                if perm == tuple(range(len(sh))) or not order_ok(sh, q):
                    continue
                u["shots"] = q
                if not repeats(ui):
                    log.append(f"{u['site']}: {[s['technique'] for s in sh]} -> {[s['technique'] for s in q]} (technique repeat across a cut)")
                    fixed = True
                    break
                u["shots"] = sh
        nxt = units[ui + 1] if ui + 1 < len(units) else None
        if not fixed and nxt and nxt["kind"] == "poi" and nxt.get("gap") == u.get("gap") and u["site"] not in opener_sites and nxt["site"] not in opener_sites:
            units[ui], units[ui + 1] = units[ui + 1], units[ui]
            if repeats(ui) or repeats(ui + 1):
                units[ui], units[ui + 1] = units[ui + 1], units[ui]
            else:
                log.append(f"swapped {units[ui + 1]['site']} after {units[ui]['site']} (technique repeat across a cut)")


reorders = []
fix_repeats(reorders)


# ------------------------------------------------------------------ allocation
def build_entries():
    ents = []
    for ui, u in enumerate(units):
        for k, s in enumerate(u["shots"]):
            e = {"unit": ui, "k": k, "kind": u["kind"], "shot": s, "site": u["site"]}
            if u["kind"] == "v1":
                w = win[s["id"]]
                T = tl1[s["id"]]["takeDuration"]
                a, b = max(0.0, float(w["keep"][0])), min(T, float(w["keep"][1]))
                e.update(T=T, a=a, b=b, anchor=w.get("anchor", "center"), mn=float(w["minSec"]), ideal=float(w["idealSec"]), reason=w.get("reason", ""))
            else:
                T = float(s["trim"]["takeSec"])
                wd = s.get("window") or {}
                kp = wd.get("keep") or [0.0, T]
                a, b = max(0.0, float(kp[0])), min(T, float(kp[1]))
                e.update(T=T, a=a, b=b, anchor=wd.get("anchor", "center"), mn=float(wd.get("minSec", 3.5)),
                         ideal=float(wd.get("idealSec", s["duration"]["sec"])), reason="")
            ents.append(e)
    for i, e in enumerate(ents):
        first = i > 0 and e["k"] == 0 and units[e["unit"]]["site"] not in HARD_CUT_INTO
        nxt_first = i + 1 < len(ents) and ents[i + 1]["k"] == 0 and units[ents[i + 1]["unit"]]["site"] not in HARD_CUT_INTO
        e["hin"] = FD / FPS if first else 0.0
        e["hout"] = FD / FPS if nxt_first else 0.0
        cap = (F(e["T"]) - (FD if e["hin"] else 0) - (FD if e["hout"] else 0)) / FPS
        # the window must stay inside keep AND leave the dissolve handles inside the take
        ka, kb = max(e["a"], (FD if e["hin"] else 0) / FPS), min(e["b"], (F(e["T"]) - (FD if e["hout"] else 0)) / FPS)
        e["mx"] = max(0.5, min(kb - ka, cap))
        if e["mx"] < e["mn"]:
            e["mx"] = max(e["mx"], min(cap, e["mn"]))
        e["mn"] = min(e["mn"], e["mx"])
        e["ideal"] = min(max(e["ideal"], e["mn"]), e["mx"])
    return ents


def unit_dp(es, i0, i1, slack=0.0):
    """Cut positions (indices into G) for the shots of one unit between G[i0] and G[i1]: every length within
    [mn − slack, mx], minimising Σ (L − want)². Returns the list of end indices or None."""
    n = len(es)
    cost = {i0: (0.0, None)}
    layers = []
    for k, e in enumerate(es):
        nxt = {}
        lo_f, hi_f = (e["mn"] - slack) * FPS - 1e-6, e["mx"] * FPS + 1e-6
        targets = [i1] if k == n - 1 else range(i0 + 1, i1)
        for j in targets:
            best = None
            for i, (cst, _) in cost.items():
                if i >= j:
                    continue
                Lf = Gf[j] - Gf[i]
                if not (lo_f <= Lf <= hi_f):
                    continue
                v = cst + (Lf / FPS - e["want"]) ** 2
                if best is None or v < best[0]:
                    best = (v, i)
            if best:
                nxt[j] = best
        layers.append(nxt)
        cost = nxt
        if not cost:
            return None
    if i1 not in cost:
        return None
    ends = [i1]
    for k in range(n - 1, 0, -1):
        ends.append(layers[k][ends[-1]][1])
    return ends[::-1]


def boundary_prefs(t):
    """Candidate unit end points, best first: a section start within 1.5 bars, the nearest downbeats, then any grid point."""
    near = sorted(range(len(G)), key=lambda i: abs(G[i] - t))[:60]
    secs = [i for i in near if any(abs(G[i] - s) < 1e-6 for s in sec_starts) and abs(G[i] - t) <= 1.5 * bar_len]
    downs = [i for i in near if any(abs(G[i] - b) < 1e-3 for b in bar_starts)]
    rest = [i for i in near if i not in secs and i not in downs]
    return secs + downs + rest


def allocate(problems):
    ents = build_entries()

    def total(lam):
        return sum(min(max(lam * e["ideal"], e["mn"]), e["mx"]) for e in ents)

    lo, hi = 0.0, 10.0
    if total(hi) < SONG_DUR:
        sys.exit(f"cannot fill the song: Σmax {total(hi):.1f} s < {SONG_DUR:.1f} s")
    for _ in range(80):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if total(mid) < SONG_DUR else (lo, mid)
    lam = (lo + hi) / 2
    for e in ents:
        e["want"] = min(max(lam * e["ideal"], e["mn"]), e["mx"])
    ucount = len(units)
    ues = [[e for e in ents if e["unit"] == ui] for ui in range(ucount)]
    uwant = [sum(e["want"] for e in es) for es in ues]
    umin = [sum(e["mn"] for e in es) for es in ues]
    umax = [sum(e["mx"] for e in es) for es in ues]
    # segments: each pinned opener site starts exactly on its movement anchor
    pos = {u["site"]: i for i, u in enumerate(units)}
    seg_ends = [(pos[s] - 1, A) for s, A in ANCHORS] + [(ucount - 1, SONG_DUR)]
    cur = 0
    u0 = 0
    for (ju, seg_end) in seg_ends:
        seg_units = list(range(u0, ju + 1))
        seg_t0 = G[cur]
        lo_cap, hi_cap = sum(umin[u] for u in seg_units), sum(umax[u] for u in seg_units)
        if not (lo_cap - 0.01 <= seg_end - seg_t0 <= hi_cap + 0.01):
            sys.exit(f"segment {seg_t0:.2f}–{seg_end:.2f} s ({len(seg_units)} units) cannot be filled: Σmin {lo_cap:.1f} Σmax {hi_cap:.1f}")
        # λ per movement segment: an edit inside one movement never moves a cut in another
        seg_es = [e for u in seg_units for e in ues[u]]
        span = seg_end - seg_t0
        lo_l, hi_l = 0.0, 10.0
        for _ in range(80):
            mid = (lo_l + hi_l) / 2
            if sum(min(max(mid * e["ideal"], e["mn"]), e["mx"]) for e in seg_es) < span:
                lo_l = mid
            else:
                hi_l = mid
        for e in seg_es:
            e["want"] = min(max(hi_l * e["ideal"], e["mn"]), e["mx"])
        for u in seg_units:
            uwant[u] = sum(e["want"] for e in ues[u])
        seg_want = sum(uwant[u] for u in seg_units)
        scale = span / seg_want if seg_want > 0 else 1.0
        acc = 0.0
        for ui in seg_units:
            es = ues[ui]
            acc += uwant[ui] * scale
            target = seg_t0 + acc
            last_in_seg = ui == ju
            rest = seg_units[seg_units.index(ui) + 1:]
            lo_t = max(G[cur] + umin[ui], seg_end - sum(umax[u] for u in rest)) - 0.01
            hi_t = min(G[cur] + umax[ui], seg_end - sum(umin[u] for u in rest)) + 0.01
            target = min(max(target, lo_t + 0.5), hi_t - 0.5)
            plan_ends = None
            jend = min(range(len(G)), key=lambda i: abs(G[i] - seg_end))
            for slack, tol in ((0.0, 0.0), (0.0, 0.6), (0.5, 0.6), (1.0, 0.6)):
                prefs = [jend] if last_in_seg else boundary_prefs(target)
                for j in prefs:
                    if j <= cur or (not last_in_seg and not (lo_t + 0.01 - tol <= G[j] <= hi_t - 0.01 + tol)):
                        continue
                    plan_ends = unit_dp(es, cur, j, slack)
                    if plan_ends:
                        if slack:
                            problems.append(f"unit {units[ui]['site']}: minSec relaxed by {slack} s to fit")
                        break
                if plan_ends:
                    break
            if not plan_ends:
                sys.exit(f"unit {units[ui]['site']} cannot be fitted on the grid after {G[cur]:.2f} s (segment end {seg_end:.2f})")
            prev = cur
            for e, j in zip(es, plan_ends):
                e["in"], e["out"] = G[prev], G[j]
                e["L"] = (Gf[j] - Gf[prev]) / FPS
                e["req"] = round(G[j] - G[prev], 4)
                prev = j
            cur = plan_ends[-1]
        u0 = ju + 1
    return ents, lam


# ------------------------------------------------------------------ energy pass
def seq_score(items, t0):
    """items: [(technique, L)] in order from t0. Big moves on loud music, calm moves on quiet music; a technique or
    move family repeated back to back costs."""
    s, t, prev = 0.0, t0, None
    for tech, L in items:
        s += BIG.get(tech, 2) * mean_energy(t, t + L) * L
        if prev is not None:
            if prev == tech:
                s -= 5.0
            elif FAMILY.get(prev) and FAMILY.get(prev) == FAMILY.get(tech):
                s -= 0.6
        prev, t = tech, t + L
    return s


def energy_pass(ents, log):
    Ls = {id(e["shot"]): e["L"] for e in ents}
    t_in = {id(e["shot"]): e["in"] for e in ents}
    gain = 0.0
    # 1) shot order inside each multi-shot POI unit (an opener site keeps its first shot; critic orders stay)
    for u in units:
        if u["kind"] != "poi" or len(u["shots"]) < 2 or u["site"] in PROTECT_ORDER:
            continue
        sh = u["shots"]
        t0 = min(t_in[id(s)] for s in sh)
        base = seq_score([(s["technique"], Ls[id(s)]) for s in sh], t0)
        best = (base, sh)
        for perm in itertools.permutations(sh):
            q = list(perm)
            if q == sh or not order_ok(sh, q) or (u["site"] in opener_sites and q[0] is not sh[0]):
                continue
            v = seq_score([(s["technique"], Ls[id(s)]) for s in q], t0)
            if v > best[0] + 0.15:
                best = (v, q)
        if best[1] is not sh:
            log.append(f"energy: {u['site']} {[s['technique'] for s in sh]} -> {[s['technique'] for s in best[1]]} (+{best[0] - base:.2f})")
            gain += best[0] - base
            u["shots"] = best[1]
    # 2) POI unit order inside each route gap, hill-climbing on swaps of non-opener POI units (they may cross a pinned
    #    opener site, which keeps its index; each movement segment must still fit between its anchors)
    umn, umx = defaultdict(float), defaultdict(float)
    for e in ents:
        umn[e["site"]] += e["mn"]
        umx[e["site"]] += e["mx"]
    seg_of_anchor = {s: A for s, A in ANCHORS}

    def segments_fit():
        t0, acc_lo, acc_hi = 0.0, 0.0, 0.0
        bounds_ = [(A, s) for s, A in ANCHORS] + [(SONG_DUR, None)]
        k = 0
        for u in units:
            if k < len(ANCHORS) and u["site"] == bounds_[k][1]:
                span = bounds_[k][0] - t0
                if not (acc_lo + 0.5 <= span <= acc_hi - 0.5):
                    return False
                t0, acc_lo, acc_hi, k = bounds_[k][0], 0.0, 0.0, k + 1
            acc_lo += umn[u["site"]]
            acc_hi += umx[u["site"]]
        return acc_lo + 0.5 <= SONG_DUR - t0 <= acc_hi - 0.5

    i = 0
    while i < len(units):
        if units[i]["kind"] != "poi":
            i += 1
            continue
        j = i
        while j < len(units) and units[j]["kind"] == "poi" and units[j]["gap"] == units[i]["gap"]:
            j += 1
        idx = [k for k in range(i, j) if units[k]["site"] not in opener_sites]
        if len(idx) >= 2:
            ctx_prev = units[i - 1]["shots"][-1]["technique"] if i > 0 else None
            ctx_next = units[j]["shots"][0]["technique"] if j < len(units) else None
            t0 = min(t_in[id(s)] for u in units[i:j] for s in u["shots"])
            # an opener inside the gap starts at its anchor: score the stretch as it will be timed
            def sc():
                items, t, total = [], t0, 0.0
                prev = ctx_prev
                for u in units[i:j]:
                    if u["site"] in seg_of_anchor:
                        total += seq_score([(prev, 0.0)] + items if prev else items, t)
                        items, t, prev = [], seg_of_anchor[u["site"]], None
                    items += [(s["technique"], Ls[id(s)]) for s in u["shots"]]
                total += seq_score(([(prev, 0.0)] if prev else []) + items + ([(ctx_next, 0.0)] if ctx_next else []), t)
                return total

            before = [u["site"] for u in units[i:j]]
            cur_v = sc()
            base = cur_v
            improved = True
            while improved:
                improved = False
                for a in range(len(idx)):
                    for b in range(a + 1, len(idx)):
                        ka, kb = idx[a], idx[b]
                        units[ka], units[kb] = units[kb], units[ka]
                        v = sc()
                        if v > cur_v + 0.3 and segments_fit():
                            cur_v, improved = v, True
                        else:
                            units[ka], units[kb] = units[kb], units[ka]
            after = [u["site"] for u in units[i:j]]
            if after != before:
                log.append(f"energy: gap after {units[i]['gap']} order {before} -> {after} (+{cur_v - base:.2f})")
                gain += cur_v - base
        i = max(j, i + 1)
    return gain


def total_score(ents):
    return sum(BIG.get(e["shot"]["technique"], 2) * mean_energy(e["in"], e["in"] + e["L"]) * e["L"] for e in ents)


problems = []
ents1, _ = allocate(problems)
score1 = total_score(ents1)
energy_log = []
gain = energy_pass(ents1, energy_log)
fix_repeats(reorders)
problems = []
entries, LAM = allocate(problems)
score2 = total_score(entries)

# ------------------------------------------------------------------ window placement inside each take
for e in entries:
    L, T = e["L"], e["T"]
    a, b = e["a"], e["b"]
    anc = e["anchor"]
    if anc == "end":
        x = b - L
    elif anc == "start":
        x = a
    elif isinstance(anc, (int, float)):
        x = float(anc) - L / 2
    else:
        x = (a + b) / 2 - L / 2
    x = min(max(x, a), max(a, b - L))
    lo_f = FD if e["hin"] > 0 else 0
    hi_f = F(T) - F(e["out"]) + F(e["in"]) - (FD if e["hout"] > 0 else 0)
    xf = min(max(round(x * FPS), lo_f), hi_f)
    if hi_f < lo_f:
        problems.append(f"{e['shot'].get('id') or e['site']}: edit {L:.2f} s + handles does not fit the {T:.2f} s take")
    e["inSec"] = round(xf / FPS, 6)
    e["inKeep"] = a - 1.0 / FPS <= xf / FPS and xf / FPS + L <= b + 1.0 / FPS  # one frame of rounding

# ------------------------------------------------------------------ sites + shots
sites = []
used = []
for e in entries:
    if e["site"] not in used:
        used.append(e["site"])
poi_by_site = {u["site"]: u["poi"] for u in units if u["kind"] == "poi"}
for sid in used:
    if sid in v1_sites:
        sites.append(copy.deepcopy(v1_sites[sid]))
        continue
    d = poi_by_site[sid]
    s = d["site"]
    site = {"id": sid, "name": s.get("name") or d["name"], "gazetteerId": s.get("gazetteerId") or sid, "teleport": s["teleport"],
            "anchor": s["anchor"], "settleSec": 2, "ready": {"settleSec": 8, "timeoutSec": 120},
            "look": {"timeOfDay": s["look"]["timeOfDay"], "grade": s["look"]["grade"]},
            "notes": f"Major POI (acpedia '{d.get('title') or d['name']}'): {d.get('summary', '')[:300]}"}
    sites.append(site)

shots = []
per_site = Counter()
SHOT_KEYS = ("framing", "fov", "roll", "ease", "subject", "path", "route", "cell", "params", "look", "actor", "capture", "seed")
for i, e in enumerate(entries):
    s = e["shot"]
    if e["kind"] == "v1":
        sh = copy.deepcopy(s)
        sh.pop("transition", None)
        sh["duration"] = {"sec": e["req"] if e["req"] <= e["T"] else round(e["T"], 4)}
        sh["trim"] = {"takeSec": round(e["T"], 6), "inSec": e["inSec"]}
        sh["notes"] = (sh.get("notes") or "") + f" [v2 window {e['inSec']:.2f}–{e['inSec'] + e['L']:.2f} s of the unchanged {e['T']:.2f} s take: {e['reason']}]"
    else:
        per_site[e["site"]] += 1
        sh = {"id": f"{e['site']}.{per_site[e['site']]:02d}", "site": e["site"], "technique": s["technique"],
              "duration": {"sec": e["req"] if e["req"] <= e["T"] else round(e["T"], 4)}}
        for k in SHOT_KEYS:
            if k in s:
                sh[k] = copy.deepcopy(s[k])
        sh["trim"] = {"takeSec": round(e["T"], 6), "inSec": e["inSec"]}
        sh["standingOrder"] = s["standingOrder"]
        sh["pilot"] = {"mode": "code"}
        b = dict(s.get("bounds") or {})
        b["minSpeedScale"], b["maxSpeedScale"] = 1, 1
        sh["bounds"] = b
        sh["notes"] = (s.get("notes") or "").strip() + f" [v2 window {e['inSec']:.2f}–{e['inSec'] + e['L']:.2f} s of the {e['T']:.2f} s take]"
    if i > 0 and e["k"] == 0 and e["site"] not in HARD_CUT_INTO:
        sh["transition"] = {"type": "dissolve", "durationSec": DISSOLVE}
    e["id"] = sh["id"]
    shots.append(sh)

# ------------------------------------------------------------------ the silent tail: frozen portal → FPV run
tail_info = None
run_shot_f, run_site_f = f"{RUN_DIR}/run-shot.json", f"{RUN_DIR}/site.json"
if os.path.exists(run_shot_f) and os.path.exists(run_site_f):
    v1s = {s["id"]: s for s in v1["shots"]}
    portal = copy.deepcopy(v1s["egg-orchard-portal.01"])
    T = tl1["egg-orchard-portal.01"]["takeDuration"]
    portal["duration"] = {"sec": PORTAL_TAIL["durationSec"]}
    portal["trim"] = {"takeSec": round(T, 6), "inSec": PORTAL_TAIL["inSec"]}
    portal["transition"] = {"type": "fade", "durationSec": PORTAL_TAIL["fadeInSec"]}
    portal["notes"] = (portal.get("notes") or "") + f" [v2 tail: {PORTAL_TAIL['inSec']}–{PORTAL_TAIL['inSec'] + PORTAL_TAIL['durationSec']} s of the unchanged {T:.3f} s take, fading in from black after the music]"
    run = json.load(open(run_shot_f))
    run.setdefault("transition", {"type": "fadewhite", "durationSec": 0.8})
    run_site = {k: v for k, v in json.load(open(run_site_f)).items() if k != "validation"}  # validation = research record
    assert run["site"] == run_site["id"], "run-shot.json site must match site.json id"
    shots += [portal, run]
    if "egg-orchard-portal" not in [x["id"] for x in sites]:
        sites.append(copy.deepcopy(v1_sites["egg-orchard-portal"]))
    sites = [x for x in sites if x["id"] != run_site["id"]] + [run_site]
    tail_info = {"portal": portal["id"], "run": run["id"], "runSec": run["duration"].get("sec")}
else:
    problems.append("tail: research/egg-orchard-run/run-shot.json or site.json missing — plan built WITHOUT the Egg Orchard tail")

plan = copy.deepcopy({k: v for k, v in v1.items() if k not in ("sites", "shots")})
plan["sites"], plan["shots"] = sites, shots
if tail_info:
    plan["edit"] = {**plan.get("edit", {}), "tail": dict(TAIL)}
plan["meta"] = dict(v1.get("meta") or {})
plan["meta"]["generated"] = "2026-10-15 v2: 273 v1 shots as trimmed windows of their unchanged takes + 273 new shots at acpedia Major POIs (research/final-plan-build/build2.py)"
plan["meta"]["v1"] = "research/final-plan-build/plan-v1-273shots.json"
json.dump(plan, open(OUT, "w"), indent=1, ensure_ascii=False)

# ------------------------------------------------------------------ report
PAN = {"classic.truck", "drone.parallax-slide"}
old = [e for e in entries if e["kind"] == "v1"]
new = [e for e in entries if e["kind"] == "poi"]
rep = {
    "out": OUT, "shots": len(shots), "v1Shots": len(old), "newShots": len(new), "sites": len(sites), "newSites": len(sites) - len(v1_sites),
    "units": len(units), "lambda": round(LAM, 4), "sumEdit": round(sum(e["L"] for e in entries), 4), "song": SONG_DUR,
    "v1EditSec": round(sum(e["L"] for e in old), 1), "newEditSec": round(sum(e["L"] for e in new), 1),
    "meanLen": {"v1": round(sum(e["L"] for e in old) / max(1, len(old)), 2), "new": round(sum(e["L"] for e in new) / max(1, len(new)), 2)},
    "minLen": round(min(e["L"] for e in entries), 3), "maxLen": round(max(e["L"] for e in entries), 3),
    "panPct": round(100 * sum(e["L"] for e in entries if e["shot"]["technique"] in PAN) / SONG_DUR, 2),
    "energyScore": {"pass1": round(score1, 1), "final": round(score2, 1), "estimatedGain": round(gain, 1)},
    "windowsOutsideKeep": [e["id"] for e in entries if not e["inKeep"]],
    "anchors": {f"{A:.3f}": next((ent["id"] for ent in entries if abs(ent["in"] - A) < 0.5 / FPS), None) for _, A in ANCHORS},
    "tail": tail_info,
    "excludedSites": excluded, "droppedForQuota": dropped, "problems": problems, "reorders": reorders, "energyReorders": energy_log,
    "techniques": Counter(s["technique"] for s in shots).most_common(),
    "alloc": [{"id": e["id"], "kind": e["kind"], "in": round(e["in"], 3), "len": round(e["L"], 3), "inSec": e["inSec"], "T": round(e["T"], 3),
               "keep": [round(e["a"], 2), round(e["b"], 2)], "min": round(e["mn"], 2), "ideal": round(e["ideal"], 2)} for e in entries],
}
json.dump(rep, open(f"{HERE}/build2_report.json", "w"), indent=1)
print(json.dumps({k: v for k, v in rep.items() if k not in ("alloc", "techniques", "droppedForQuota", "energyReorders", "excludedSites")}, indent=1))
