#!/usr/bin/env python3
"""Synthesize the final Dereth town-tour plan.json from the research dossiers.

Reads research/town-*.json + roster.json + song/song.json, writes plan.json (and a build report JSON next to this
script). Pure offline: no WBT, no browser.
"""
import copy, itertools, json, math, os, re, sys, statistics, bisect

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from load import load_all, slug, R  # noqa: E402
from so_overrides import SO  # noqa: E402

PROJ = "/mnt/wbterminal2/film-projects/dereth-town-tour"
SONG = json.load(open(f"{PROJ}/song/song.json"))
ROSTER = json.load(open(R + "roster.json"))
FPS = 24
SONG_DUR = SONG["durationSec"]
DISSOLVE = 0.8

A, META = load_all()

# ---------------------------------------------------------------- technique classes
LAPSE = {"classic.time-lapse", "classic.hyperlapse", "drone.hyperlapse-orbit"}
PAN_TECH = {"classic.truck", "drone.parallax-slide"}
BIG = {
    # 3 = biggest moves (chorus / tutti)
    **{t: 3 for t in ["drone.flyover", "drone.pass-over", "drone.terrain-skim", "drone.canyon-run", "fpv.fpv-dive",
                      "fpv.fpv-proximity", "fpv.fpv-gap", "fpv.fpv-flip", "fpv.fpv-corridor", "drone.fly-by",
                      "drone.flythrough", "drone.boomerang", "drone.helix", "drone.spiral-descent", "drone.boom-rise",
                      "drone.rising-reveal", "drone.vertigo-drone", "drone.orbit-poi", "classic.whip-pan",
                      "classic.dolly-zoom", "drone.dronie", "drone.top-down-rise", "drone.hyperlapse-orbit"]},
    # 2 = medium
    **{t: 2 for t in ["drone.tilt-reveal", "drone.pano-360", "drone.top-down", "drone.parallax-slide", "classic.orbit",
                      "classic.arc", "classic.truck", "classic.pull-out-reveal", "classic.establishing",
                      "classic.crane", "classic.hyperlapse", "classic.push-in", "classic.dolly-in",
                      "classic.dolly-out", "classic.steadicam", "classic.handheld", "classic.pov", "classic.roll",
                      "classic.pedestal", "classic.reveal-from-occluder", "classic.time-lapse"]},
    # 1 = small / still
    **{t: 1 for t in ["classic.static", "classic.pan", "classic.tilt", "classic.zoom", "classic.rack-focus",
                      "classic.over-the-shoulder", "classic.two-shot", "classic.high-angle", "classic.low-angle",
                      "classic.birds-eye", "classic.worms-eye"]},
}

# ---------------------------------------------------------------- song grid (mirror of tools/film/plan/compile.mjs)
beats = SONG["beats"]
period = statistics.median([beats[i + 1] - beats[i] for i in range(len(beats) - 1)])
bar_starts = [b["start"] for b in SONG["bars"]]
bar_len = statistics.median([bar_starts[i + 1] - bar_starts[i] for i in range(len(bar_starts) - 1)])
sections = SONG["sections"]
sec_starts = [s["start"] for s in sections]
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
    """compile.mjs resolveEnd for {sec}."""
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
        return best, "section"
    t = nearest_beat(target)
    if t < min_t - 1e-9:
        t = ceil_beat(min_t)
    return t, "beat"


F = lambda t: round(t * FPS)  # noqa: E731


def mean_energy(t0, t1):
    a, b = int(t0 / HOP), max(int(t0 / HOP) + 1, int(t1 / HOP))
    v = energy[a:b]
    return sum(v) / len(v) if v else 0.0


# ---------------------------------------------------------------- units (tour order, one chapter per town)
order = ROSTER["tourOrder"]
units = []  # each: {town, entries:[{site, shot, idx}], fixedFirst, fixedLast, permutable(bool)}


def town_entries(sid, drop=()):
    shots = A[sid]["shots"]
    ents = [{"site": sid, "shot": copy.deepcopy(s), "idx": i} for i, s in enumerate(shots) if i not in drop]
    # sky continuity: a lapse advances the sky clock -> make it the town's last shot (hidden by the dissolve out)
    laps = [e for e in ents if e["shot"]["technique"] in LAPSE]
    if laps and ents[-1] is not laps[-1]:
        ents = [e for e in ents if e not in laps] + laps
    return ents


reorders = []
for town in order:
    sid = slug(town)
    drop = (1,) if sid == "rithwic" else ()  # Rithwic: second facade pan (square shop fronts) dropped
    ents = town_entries(sid, drop)
    orig_seq = [A[sid]["shots"][i]["technique"] for i in range(len(A[sid]["shots"])) if i not in drop]
    if [e["shot"]["technique"] for e in ents] != orig_seq:
        reorders.append(f"{sid}: lapse moved last ({' > '.join(e['shot']['technique'] for e in ents)})")
    perm_lo, perm_hi = 1, len(ents) - 1  # permutable slice [lo, hi)
    if sid == "sanamar":
        ents += town_entries("sanamar-royal-hall")
        perm_lo, perm_hi = 1, 1  # keep both sub-site blocks as researched
    if sid == "eastwatch":
        ents += [{"site": "egg-orchard-portal", "shot": copy.deepcopy(A["egg-orchard-portal"]["shots"][0]), "idx": 0}]
        perm_lo, perm_hi = 1, len(ents) - 1  # rising-reveal first, frozen-portal push-in last
    units.append({"town": town, "sid": sid, "entries": ents, "perm": (perm_lo, perm_hi)})
    if sid == "eastwatch":
        eo = A["egg-orchard"]["shots"]
        units.append({"town": "Egg Orchard", "sid": "egg-orchard",
                      "entries": [{"site": "egg-orchard", "shot": copy.deepcopy(eo[0]), "idx": 0},
                                  {"site": "egg-orchard", "shot": copy.deepcopy(eo[1]), "idx": 1}],
                      "perm": (1, 1)})

raw = lambda e: e["shot"]["duration"]["sec"]  # noqa: E731
RAW_TOTAL = sum(raw(e) for u in units for e in u["entries"])
SCALE = SONG_DUR / RAW_TOTAL

# ---------------------------------------------------------------- town boundaries on the music
cum = 0.0
bounds = []
for u in units:
    cum += sum(raw(e) for e in u["entries"]) * SCALE
    bounds.append(cum)


def boundary_cut(t):
    """Prefer a section start within 1.5 bars, else the nearest downbeat."""
    cands = [s for s in sec_starts if abs(s - t) <= 1.5 * bar_len]
    if cands:
        return min(cands, key=lambda s: abs(s - t))
    k = bisect.bisect_left(bar_starts, t)
    opts = [bar_starts[j] for j in (k - 1, k) if 0 <= j < len(bar_starts)]
    return min(opts, key=lambda s: abs(s - t))


cuts = [boundary_cut(b) for b in bounds[:-1]] + [SONG_DUR]

# ---------------------------------------------------------------- energy-aware order of the middle shots
perm_log = []
NO_PERM = {"Nanto"}  # keep its falls -> pool -> hilltop geography
t0 = 0.0
for u, t1 in zip(units, cuts):
    lo, hi = u["perm"]
    ents = u["entries"]
    if hi - lo >= 2 and u["town"] not in NO_PERM:
        def score(seq):
            tot = sum(raw(e) for e in seq)
            t, s = t0, 0.0
            for e in seq:
                d = (t1 - t0) * raw(e) / tot
                s += BIG.get(e["shot"]["technique"], 2) * mean_energy(t, t + d) * d
                t += d
            return s / (t1 - t0)
        base = score(ents)
        best, best_s = ents, base
        for p in itertools.permutations(ents[lo:hi]):
            seq = ents[:lo] + list(p) + ents[hi:]
            s = score(seq)
            if s > best_s + 1e-12:
                best, best_s = seq, s
        if best is not ents and best_s - base >= 0.03:
            perm_log.append({"town": u["town"], "gain": round(best_s - base, 3),
                             "from": [e["shot"]["technique"] for e in ents],
                             "to": [e["shot"]["technique"] for e in best]})
            u["entries"] = best
    t0 = t1

# ---------------------------------------------------------------- per-shot cut times (beat / section grid)
alloc = []
in_t = 0.0
for ui, (u, t1) in enumerate(zip(units, cuts)):
    ents = u["entries"]
    town_t0 = in_t
    tot = sum(raw(e) for e in ents)
    acc = 0.0
    for k, e in enumerate(ents):
        acc += raw(e)
        last_in_unit = k == len(ents) - 1
        ideal_end = t1 if last_in_unit else town_t0 + (t1 - town_t0) * acc / tot
        if last_in_unit:
            cands = [t1]
        else:
            nb = nearest_beat(ideal_end)
            cands = sorted({time_at(beats, period, round(pos_at(beats, period, nb)) + j) for j in range(-4, 5)},
                           key=lambda c: abs(c - ideal_end))
        chosen = None
        for c in cands:
            out_t, snap = resolve_end(in_t, c - in_t)
            ed = (F(out_t) - F(in_t)) / FPS
            if 6.0 <= ed <= 18.0:
                chosen = (c, out_t, snap, ed)
                break
        if chosen is None:
            c = cands[0]
            out_t, snap = resolve_end(in_t, c - in_t)
            chosen = (c, out_t, snap, (F(out_t) - F(in_t)) / FPS)
        c, out_t, snap, ed = chosen
        # request exactly the grid point compile will land on (a section start or a beat)
        e["sec"] = round((SONG_DUR if (ui == len(units) - 1 and last_in_unit) else out_t) - in_t, 4)
        e["editIn"], e["editOut"], e["snap"], e["edit"] = in_t, out_t, snap, ed
        alloc.append(e)
        in_t = out_t

# exact total: the requested {sec} values telescope to the song length
sum_sec = sum(e["sec"] for e in alloc)
alloc[-1]["sec"] = round(alloc[-1]["sec"] + (SONG_DUR - sum_sec), 4)  # rounding residue only (< 1 ms)

# ---------------------------------------------------------------- JEV budget (<= 8 shots, <= 120 s)
JEV_ADD = {("eastwatch", "fpv.fpv-dive"), ("neydisa-castle", "fpv.fpv-gap")}

# ---------------------------------------------------------------- sites
site_ids_used = []
for u in units:
    for e in u["entries"]:
        if e["site"] not in site_ids_used:
            site_ids_used.append(e["site"])

LOOK_FIX = {"lin": {"grade": "warm"}}  # 0.64 = afternoon -> warm (owner rule)
SITE_LOOK_OVERRIDE = {
    "egg-orchard-portal": {"timeOfDay": 0.48, "grade": "neutral"},  # continuous with the Eastwatch sky
    "egg-orchard": {"timeOfDay": 0.48, "grade": "cool"},  # indoor; time kept for the plan-wide rule
}

sites = []
for sid in site_ids_used:
    s = A[sid]["site"]
    look = dict(s.get("look") or {})
    look.update(LOOK_FIX.get(sid, {}))
    if sid in SITE_LOOK_OVERRIDE:
        look = dict(SITE_LOOK_OVERRIDE[sid])
    site = {"id": sid, "name": s.get("name", sid), "gazetteerId": s.get("gazetteerId", sid),
            "teleport": s["teleport"], "anchor": s["anchor"]}
    for k in ("cell", "indoor", "lbKeys", "interiorLb"):
        if k in s:
            site[k] = s[k]
    site["settleSec"] = 2
    site["ready"] = {"settleSec": 8, "timeoutSec": 120}
    site["look"] = look
    town_name = next((u["town"] for u in units if u["sid"] == sid), None)
    if sid == "sanamar-royal-hall":
        site["notes"] = "Sanamar chapter sub-site (roster: Sanamar Palace merged into Sanamar as its climax)."
    elif sid == "egg-orchard-portal":
        site["notes"] = "Eastwatch chapter sub-site: the three red Egg Orchard portals in the glacier valley 1.8 km NW (owner exception)."
    elif sid == "egg-orchard":
        site["notes"] = "Owner exception: the only indoor site, inserted right after Eastwatch."
    sites.append(site)

# ---------------------------------------------------------------- shots
shots = []
per_site_n = {}
prev_unit = None
for ui, u in enumerate(units):
    for k, e in enumerate(u["entries"]):
        s = e["shot"]
        sid = e["site"]
        per_site_n[sid] = per_site_n.get(sid, 0) + 1
        sh = {"id": f"{sid}.{per_site_n[sid]:02d}", "site": sid, "technique": s["technique"],
              "duration": {"sec": e["sec"]}}
        if ui > 0 and k == 0:
            sh["transition"] = {"type": "dissolve", "durationSec": DISSOLVE}
        for key in ("framing", "fov", "ease", "subject", "path", "route", "cell", "params", "look"):
            if key in s:
                sh[key] = copy.deepcopy(s[key])
        so = SO.get((sid, e["idx"]), s["standingOrder"])
        sh["standingOrder"] = so
        mode = (s.get("pilot") or {}).get("mode", "code")
        if (sid, s["technique"]) in JEV_ADD:
            mode = "jev"
        sh["pilot"] = {"mode": mode}
        b = dict(s.get("bounds") or {})
        b["minSpeedScale"], b["maxSpeedScale"] = 1, 1
        sh["bounds"] = b
        sh["notes"] = (s.get("notes") or "").strip()
        shots.append(sh)

# per-shot fixes
for sh in shots:
    if sh["site"] == "sanamar-royal-hall" and sh["technique"] == "drone.hyperlapse-orbit":
        sh["params"]["timeRate"] = 68  # sun stays up through pre-roll + take (0.66 -> ~0.83)
        sh["notes"] += " [final plan: timeRate 80 -> 68 so the sky ends near 0.83 including pre-roll and the dissolve handle]"
    if sh["site"] == "zaikhal" and sh["technique"] == "classic.time-lapse":
        sh["params"]["rate"] = 0.0085  # 0.68 -> ~0.83 including pre-roll (was 0.01 -> 0.856)
        sh["notes"] += " [final plan: rate 0.01 -> 0.0085 so the sun stays above ~0.83 including pre-roll]"
    if sh["technique"] == "classic.rack-focus" and "look" not in sh:
        if sh["site"] == "sanamar":
            sh["look"] = {"dof": {"focusRange": 2, "bokehScale": 2.5}}
        elif sh["site"] == "candeth-keep":
            sh["look"] = {"dof": {"focusRange": 8, "bokehScale": 2}}

plan = {
    "version": 1,
    "title": "Dereth Town Tour",
    "kind": "music-video",
    "format": {"width": 1920, "height": 1080, "fps": FPS, "capture": "stepped"},
    "song": {"file": "song/music.mp3", "analysis": "song/song.json", "offsetSec": 0},
    "edit": {"fadeInSec": 2, "fadeOutSec": 4},
    "defaults": {"transition": "cut", "pilot": {"mode": "code"}, "look": {"timeOfDay": "golden", "grade": "warm"}},
    "sites": sites,
    "shots": shots,
    "meta": {
        "music": "Beethoven: Egmont Overture Op. 84 + Symphony No. 3 'Eroica' Op. 55 (Musopen Symphony / Czech National Symphony Orchestra, public domain); see song/LICENSE.txt",
        "creditLine": "Music: Ludwig van Beethoven - Egmont Overture, Op. 84 and Symphony No. 3 \"Eroica\", Op. 55. Performed by the Czech National Symphony Orchestra (Musopen Symphony), courtesy of Musopen (musopen.org). Public domain.",
        "boot": "film CLI boots with ?clouds=on (volumetric clouds + full DoF chain)",
        "generated": "2026-10-14 final synthesis from research/town-*.json",
    },
}

json.dump(plan, open(f"{PROJ}/plan.json", "w"), indent=1, ensure_ascii=False)

report = {"scale": SCALE, "rawTotal": RAW_TOTAL, "sumSec": sum(sh["duration"]["sec"] for sh in shots),
          "units": len(units), "shots": len(shots), "sites": len(sites), "reorders": reorders,
          "permutations": perm_log,
          "alloc": [{"id": sh["id"], "tech": sh["technique"], "sec": e["sec"], "in": round(e["editIn"], 3),
                     "out": round(e["editOut"], 3), "edit": round(e["edit"], 3), "snap": e["snap"]}
                    for sh, e in zip(shots, alloc)]}
json.dump(report, open(os.path.join(HERE, "build_report.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in report.items() if k != "alloc"}, indent=1))
