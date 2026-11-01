#!/usr/bin/env python3
"""frames_to_mp4.py — encode a vehicle-1070.mjs screencast (frames/*.jpg + frames.json [[file, timestamp]]) to an
H.264 MP4 at real-time pacing (each frame held until the next one's timestamp; gaps capped at 1 s).
  python3 frames_to_mp4.py <tour-dir> [out.mp4] [--start S] [--end S]   (S = seconds from the first frame)
Run inside capped-build (ffmpeg is CPU-heavy)."""
import json, os, subprocess, sys

def main():
    args = [a for a in sys.argv[1:]]
    def opt(k, d=None):
        if k in args:
            i = args.index(k); v = args[i + 1]; del args[i:i + 2]; return v
        return d
    start = float(opt("--start", "0")); end = float(opt("--end", "1e9"))
    d = args[0]
    out = args[1] if len(args) > 1 else os.path.join(d, "tour.mp4")
    frames = json.load(open(os.path.join(d, "frames.json")))
    if not frames:
        sys.exit("no frames")
    t0 = frames[0][1]
    sel = [(f, t - t0) for f, t in frames if start <= t - t0 <= end]
    lst = os.path.join(d, "frames.ffconcat")
    with open(lst, "w") as fh:
        fh.write("ffconcat version 1.0\n")
        for i, (f, t) in enumerate(sel):
            nxt = sel[i + 1][1] if i + 1 < len(sel) else t + 1 / 30
            fh.write(f"file 'frames/{f}'\nduration {min(1.0, max(0.001, nxt - t)):.4f}\n")
        fh.write(f"file 'frames/{sel[-1][0]}'\n")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
           "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True, cwd=d)
    dur = sel[-1][1] - sel[0][1]
    print(f"{out}: {len(sel)} frames over {dur:.1f} s ({len(sel) / max(dur, 1e-6):.1f} fps captured), {os.path.getsize(out) / 1e6:.1f} MB")

main()
