#!/usr/bin/env python3
"""film-smooth.py — rebuild the recorder's held frames in one window of a take by motion interpolation (2026-11-02).

Why: the in-page recorder samples the canvas on a fixed 30 fps grid. When the page renders a frame late, the grid
slot repeats the previous frame (a HOLD) and the next frame jumps ahead: a visible micro-stutter in a fast shot. The
encoder re-encodes the repeated frame, so the copy is near-identical rather than md5-identical (film-qa.py's
SOFT HOLDS). A re-encode alone cannot remove it; this tool rebuilds each held frame as a motion-compensated
in-between of the real frames around it (ffmpeg minterpolate, mci / aobmc / bidir / vsbmc). It feeds minterpolate
only the 4 frames around each gap (A-1, A, B, B+1), so a 10 s window costs ~1-2 min instead of ~8 for a full pass.

What is rebuilt: runs of <= --max-held held frames — near-identical (|luma diff| < --thresh at 480 px, film-qa's
measure), or a held slot coded as a keyframe (diff < 40 % of the local motion) — inside a MOVING window (film-qa's `motion` >= 0.5: the median diff of the real frames). A longer run is a real
freeze (the world stopped, then snapped): interpolating it would morph the snap, so it is left alone (and film-qa
calls it DEFECT). A parked camera or a slow canopy cannot tell a hold from stillness, so a still window passes
through untouched.

  python3 film-smooth.py <take.mp4> --from S --to S --out seg.mp4 [--max-held 5] [--max-jump 1.6] [--thresh 0.1] [--crf 12]
                         [--jobs 2] [--tmp DIR] [--dry-run]
Output: exactly the frames of [from, to) (the take's size, 30 fps, H.264 High CRF 12 yuv420p: an intermediate for
film-hellcat-assemble.py --smooth). Prints one JSON line: frames, runs found / rebuilt / skipped, motion, seconds.
"""
import json, math, os, statistics, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

FPS = 30
MARGIN = 0.25  # s of context decoded on each side, so a run at the window's edge still has its A and B frames


def arg(k, d=None):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


if len(sys.argv) < 2 or sys.argv[1].startswith("--") or "--from" not in sys.argv or "--to" not in sys.argv:
    print(__doc__); sys.exit(2)
SRC = sys.argv[1]
A, B = float(arg("--from")), float(arg("--to"))
OUT = arg("--out")
MAX_HELD = int(arg("--max-held", "5"))
MAX_JUMP = float(arg("--max-jump", "1.6"))  # A->B diff allowed, in multiples of (k+1) x the local per-frame motion
THRESH = float(arg("--thresh", "0.1"))
CRF = arg("--crf", "12")
JOBS = max(1, int(arg("--jobs", "2")))
DRY = "--dry-run" in sys.argv
TMP = arg("--tmp", os.path.join(os.path.dirname(os.path.abspath(OUT)) if OUT else tempfile.gettempdir(), ".smooth-tmp"))
if not OUT and not DRY:
    print("--out is required (or --dry-run)"); sys.exit(2)
t0 = time.time()

probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", SRC], capture_output=True, text=True, check=True).stdout.strip().split(",")
W, H = int(probe[0]), int(probe[1])
FS = W * H * 3 // 2  # one yuv420p frame

# ---- 1. decode the window (+ margins) once into a raw file on the scratch drive, memory-mapped
start = max(0.0, A - MARGIN)
end = B + MARGIN
os.makedirs(TMP, exist_ok=True)
raw = os.path.join(TMP, f"win-{os.getpid()}.yuv")
subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}",
                "-i", SRC, "-map", "0:v", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-y", raw], check=True)
n_dec = os.path.getsize(raw) // FS
frames = np.memmap(raw, dtype=np.uint8, mode="r", shape=(n_dec, FS))
i0 = int(round((A - start) * FPS))
N = int(math.ceil((B - A) * FPS - 1e-6))  # >= the assembler's segment length (b - a)
N = min(N, n_dec - i0)
if N <= 0:
    os.unlink(raw); print(json.dumps({"error": "empty window", "decoded": n_dec})); sys.exit(2)


def luma_small(i):
    y = frames[i, : W * H].reshape(H, W)
    h4, w4 = H // 4, W // 4
    return y[: h4 * 4, : w4 * 4].reshape(h4, 4, w4, 4).mean(axis=(1, 3), dtype=np.float32)


# ---- 2. per-frame difference to the previous frame (film-qa's measure: mean |luma diff| at ~480 px)
diffs = [None] * n_dec
prev = luma_small(0)
for i in range(1, n_dec):
    cur = luma_small(i)
    diffs[i] = float(np.abs(cur - prev).mean())
    prev = cur
win = [d for d in diffs[i0 + 1 : i0 + N] if d is not None]
real = [d for d in win if d >= THRESH]
motion = round(statistics.median(real), 3) if len(real) >= max(3, len(win) // 10) else 0.0
moving = motion >= 0.5

# ---- 3. the held runs: frames i..j each a copy of their predecessor; A = i-1 repeats, B = j+1 is new. A copy is
# near-identical (diff < THRESH), or — a held slot the encoder coded as a KEYFRAME, which differs more from the P copy
# before it — a diff < 40 % of the local motion (the median real diff within +-15 frames, when that is >= 1.0); a
# false positive only swaps a real frame for an in-between of its neighbours, which looks the same.
held = [False] * n_dec
for i in range(1, n_dec):
    d = diffs[i]
    if d < THRESH:
        held[i] = True
        continue
    loc = [x for x in diffs[max(1, i - 15): i + 16] if x is not None and x >= THRESH]
    if len(loc) >= 5:
        m = statistics.median(loc)
        if m >= 1.0 and d < 0.4 * m:
            held[i] = True
runs = []
i = 1
while i < n_dec:
    if held[i]:
        j = i
        while j + 1 < n_dec and held[j + 1]:
            j += 1
        runs.append((i, j))
        i = j + 1
    else:
        i += 1
# only runs that touch the output window matter
runs = [(i, j) for (i, j) in runs if j >= i0 and i < i0 + N]
todo, skipped = [], []
for (i, j) in runs:
    k = j - i + 1
    a, b = i - 1, j + 1
    if not moving:
        skipped.append({"at": round(A + (i - i0) / FPS, 3), "held": k, "why": "still window"})
    elif k > MAX_HELD:
        skipped.append({"at": round(A + (i - i0) / FPS, 3), "held": k, "why": "freeze (longer than --max-held)"})
    elif a - 1 < 0 or b + 1 >= n_dec:
        skipped.append({"at": round(A + (i - i0) / FPS, 3), "held": k, "why": "no context at the decoded edge"})
    else:
        # A -> B must look like k+1 frames of the shot's own motion. Much more is a camera switch inside the take or a
        # move too fast for block motion search: an in-between there is a smeared double exposure (film master v2: a
        # flash frame across K's cockpit -> chase switch, doubled cacti / a torn basket in fast pitch). Leave the hold.
        ab = float(np.abs(luma_small(b) - luma_small(a)).mean())
        loc = [x for x in diffs[max(1, i - 15): j + 17] if x is not None and x >= THRESH]
        m = statistics.median(loc) if len(loc) >= 5 else motion
        if ab > MAX_JUMP * (k + 1) * max(m, 0.5):
            skipped.append({"at": round(A + (i - i0) / FPS, 3), "held": k, "why": f"A->B jump {ab:.1f} > {MAX_JUMP} x {k + 1} x local {m:.2f} (cut / too fast)"})
        else:
            todo.append((i, j))


# ---- 4. rebuild each run from its 4 neighbours (pts: A-1 = 0, A = 1, B = k+2, B+1 = k+3 -> in-betweens = out 2..k+1)
def rebuild(run):
    i, j = run
    k = j - i + 1
    a, b = i - 1, j + 1
    pts = f"if(eq(N,0),0,if(eq(N,1),1,if(eq(N,2),{k + 2},{k + 3})))"
    p = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p",
                        "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-vf",
                        f"setpts='{pts}/({FPS}*TB)',minterpolate=fps={FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none",
                        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"],
                       input=b"".join(bytes(frames[x]) for x in (a - 1, a, b, b + 1)), capture_output=True)
    if p.returncode:
        return run, None, p.stderr.decode(errors="replace")[-300:]
    out = p.stdout
    got = len(out) // FS
    if got < k + 2:
        return run, None, f"minterpolate gave {got} frames, wanted >= {k + 2}"
    return run, [out[(2 + m) * FS : (3 + m) * FS] for m in range(k)], None


rebuilt, failed = {}, []
if not DRY and todo:
    with ThreadPoolExecutor(max_workers=JOBS) as ex:
        for run, mids, err in ex.map(rebuild, todo):
            if mids is None:
                failed.append({"at": round(A + (run[0] - i0) / FPS, 3), "held": run[1] - run[0] + 1, "err": err})
            else:
                for m, buf in enumerate(mids):
                    rebuilt[run[0] + m] = buf

# ---- 5. encode exactly the window's frames, with the rebuilt ones swapped in
if not DRY:
    enc = subprocess.Popen(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p",
                            "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", CRF,
                            "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", str(FPS), "-movflags", "+faststart", "-y", OUT],
                           stdin=subprocess.PIPE)
    for x in range(i0, i0 + N):
        enc.stdin.write(rebuilt.get(x) or bytes(frames[x]))
    enc.stdin.close()
    if enc.wait():
        print(json.dumps({"error": "encode failed"})); sys.exit(2)
del frames
os.unlink(raw)
held_in_win = sum(min(j, i0 + N - 1) - max(i, i0) + 1 for (i, j) in runs)
print(json.dumps({
    "src": SRC, "from": A, "to": B, "out": OUT, "frames": N, "motion": motion, "moving": moving,
    "runs": len(runs), "held_frames": held_in_win, "rebuilt_runs": len(todo) - len(failed),
    "rebuilt_frames": len(rebuilt), "skipped": skipped, "failed": failed, "seconds": round(time.time() - t0, 1),
}))
sys.exit(0 if not failed else 1)
