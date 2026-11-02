#!/usr/bin/env python3
"""film-qa.py — the freeze / stutter yardstick for the Hellcat film's takes and master (2026-11-02).

Two defects, measured separately over a time window of an mp4:
  * HOLDS — exact duplicate frames (identical decoded frames: the in-page recorder repeated a canvas frame because the
    page could not render on the 30 fps grid). Measured with ffmpeg framemd5.
  * FREEZES — the game world stopped while frames kept coming (near-zero frame-to-frame change, e.g. the aircraft held
    by prediction stalls). Measured as runs of >= 4 frames whose mean |luma difference| (480 px wide) is < 0.08.
    A slow scene (a canopy at 5 m/s) can also score low: check `median_diff` and look at the frames before calling a
    slow shot frozen; a flying shot (300-400 km/h) normally has median_diff > 0.5.
  * SOFT HOLDS (added 2026-11-02 after take A3) — near-identical consecutive frames (|luma diff| < 0.1): a held grid
    slot the encoder re-encoded, so it is NOT md5-identical and the HOLDS check misses it (the old take A's lift-off and
    forests windows, md5-CLEAN, were 41 % soft-held). Counted only in a MOVING window (median_diff >= 0.5), where every
    real new frame differs (`motion` = the median diff of the frames that are not near-identical, >= 0.5); a held slot
    coded as a keyframe differs more (an IDR re-encode), so a frame whose diff is < 40 % of the local motion (>= 1.0)
    counts too (`rel_held_frames`); a parked
    camera or a slow canopy cannot tell a hold from stillness.
Verdict per window: CLEAN when held % <= 2 and no hold > 4 frames and frozen total <= 0.3 s and no freeze > 0.2 s, and
(moving windows only) no soft hold > 6 frames and soft-held % <= 15 — runs of <= 5 held frames are what
film-smooth.py rebuilds by motion interpolation. --strict (for a smoothed master): soft-held % <= 2 and no soft hold
> 4 frames in a moving window.

  python3 film-qa.py <video.mp4> [--from S] [--to S] [--json] [--strict]
Exit 0 = CLEAN, 1 = DEFECT, 2 = usage / ffmpeg error.
"""
import json, re, statistics, subprocess, sys

def arg(k, d=None):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d

if len(sys.argv) < 2 or sys.argv[1].startswith("--"):
    print(__doc__); sys.exit(2)
SRC = sys.argv[1]
A = float(arg("--from", "0")); B = arg("--to")
win = ["-ss", f"{A}"] + (["-t", f"{float(B) - A}"] if B else [])
FPS = 30
try:
    md5 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", *win, "-i", SRC, "-map", "0:v", "-f", "framemd5", "-"],
                         capture_output=True, text=True, check=True).stdout
    diff = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", *win, "-i", SRC, "-vf",
                           "scale=480:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
                           "-f", "null", "-"], capture_output=True, text=True, check=True).stdout
except subprocess.CalledProcessError as e:
    print("ffmpeg failed:", e.stderr[-400:]); sys.exit(2)
h = [l.split(", ")[5].strip() for l in md5.splitlines() if l and not l.startswith("#")]
runs, cur = [], 1
for i in range(1, len(h)):
    if h[i] == h[i - 1]: cur += 1
    else: runs.append(cur); cur = 1
if h: runs.append(cur)
held = sum(r - 1 for r in runs)
holds = [r for r in runs if r >= 2]
vals = [float(m.group(1)) for m in re.finditer(r"YAVG=([0-9.]+)", diff)]
fr, run = [], 0
for v in vals:
    if v < 0.08: run += 1
    else:
        if run >= 4: fr.append(run)
        run = 0
if run >= 4: fr.append(run)
res = {
    "file": SRC, "from": A, "to": float(B) if B else None, "frames": len(h),
    "held_frames": held, "held_pct": round(100 * held / max(1, len(h)), 1), "holds": len(holds), "worst_hold_frames": max(holds, default=1),
    "freezes": len(fr), "frozen_s": round(sum(fr) / FPS, 2), "worst_freeze_s": round(max(fr, default=0) / FPS, 2),
    "median_diff": round(statistics.median(vals), 3) if vals else None,
}
# a held slot the encoder happened to code as a KEYFRAME is not near-identical (the IDR re-encode differs from the P
# copy before it: diff ~2 where the shot moves ~6), so it also counts when its diff is < 40 % of the local motion
# (the median diff of the real frames within +-15 frames, when that is >= 1.0)
flags = [v < 0.1 for v in vals]
rel = 0
for i, v in enumerate(vals):
    if flags[i]: continue
    loc = [x for x in vals[max(0, i - 15): i + 16] if x >= 0.1]
    if len(loc) >= 5:
        m = statistics.median(loc)
        if m >= 1.0 and v < 0.4 * m:
            flags[i] = True; rel += 1
sr, srun = [], 0
for f in flags:
    if f: srun += 1
    else:
        if srun: sr.append(srun)
        srun = 0
if srun: sr.append(srun)
res["soft_held_frames"] = sum(sr)
res["rel_held_frames"] = rel
res["soft_held_pct"] = round(100 * sum(sr) / max(1, len(h)), 1)
res["worst_soft_hold_frames"] = max(sr) + 1 if sr else 1
# MOVING = the window's real new frames change a lot: the median diff of the frames that are NOT near-identical (a
# window that is 40 % holds has a low overall median although every real frame moves — the old take A forests: 0.22)
real = [v for v in vals if v >= 0.1]
res["motion"] = round(statistics.median(real), 3) if len(real) >= max(3, len(vals) // 10) else 0.0
res["moving"] = res["motion"] >= 0.5
# a take window is usable when its soft holds are smoothable (film-smooth.py rebuilds runs of <= 5 held frames, i.e.
# <= 6 identical-looking frames, and the encode stays watchable at <= 15 %); --strict (a smoothed master): <= 2 % and
# no run longer than the md5 rule's 4 frames
if "--strict" in sys.argv:
    soft_ok = (not res["moving"]) or (res["worst_soft_hold_frames"] <= 4 and res["soft_held_pct"] <= 2)
else:
    soft_ok = (not res["moving"]) or (res["worst_soft_hold_frames"] <= 6 and res["soft_held_pct"] <= 15)
res["verdict"] = "CLEAN" if (res["held_pct"] <= 2 and res["worst_hold_frames"] <= 4 and res["frozen_s"] <= 0.3 and res["worst_freeze_s"] <= 0.2 and soft_ok) else "DEFECT"
if "--json" in sys.argv: print(json.dumps(res))
else: print(" ".join(f"{k}={v}" for k, v in res.items()))
sys.exit(0 if res["verdict"] == "CLEAN" else 1)
