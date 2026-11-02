#!/usr/bin/env python3
"""film-hellcat-assemble.py — cut the Hellcat film from its takes (film-hellcat-1070.mjs) into one YouTube master.

The edit list (edl.json in the project's edit/ dir) names segments by the take's beat events (take-X.json `videoEvents`,
seconds into that take's video): {"src": "A", "from": "boarded-1.5", "to": "takeoff+8", "join": "cut" | "dissolve",
"note": "..."}. `from` / `to` are "<event>[+-seconds]" or plain seconds. Joins: "cut" (a one-frame xfade) or "dissolve"
(0.6 s). The title card (PIL, DejaVu Serif) fades in over the first segment; the film fades to black at its end.
Output: edit/hellcat-youtube.mp4 — 1920x1080, 30 fps, H.264 High (libx264 CRF 17), yuv420p, +faststart.
--smooth (2026-11-02): first pass every segment through film-smooth.py (the recorder's held frames rebuilt by motion
interpolation; edit/smooth/<src>-<from>-<to>.mp4, CRF 12, reused while newer than its take; summary in
edit/smooth/summary.json), then cut from those files. A segment with "smooth": false is cut as recorded. --smooth-jobs N (default 3) = parallel interpolations.

  python3 film-hellcat-assemble.py /mnt/wbterminal2/film-projects/hellcat-2026-11-02 [--dry-run] [--smooth [--smooth-jobs N]]
"""
import json, os, re, subprocess, sys

PROJ = sys.argv[1]
DRY = "--dry-run" in sys.argv
SMOOTH = "--smooth" in sys.argv
SJOBS = sys.argv[sys.argv.index("--smooth-jobs") + 1] if "--smooth-jobs" in sys.argv else "3"
SMOOTH_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "film-smooth.py")
TAKES = os.path.join(PROJ, "takes")
EDIT = os.path.join(PROJ, "edit")
os.makedirs(EDIT, exist_ok=True)
FPS = 30
DISSOLVE = 0.6
CUT = 1.0 / FPS

def take(src):
    meta = json.load(open(os.path.join(TAKES, f"take-{src}.json")))
    evs = {}
    for e in meta.get("videoEvents") or []:
        if e.get("video") is not None and e["kind"] not in evs:
            evs[e["kind"]] = e["video"]
    return {"mp4": os.path.join(TAKES, f"take-{src}.mp4"), "events": evs}

def probe_dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(out.stdout.strip() or 0)

def at(expr, evs):
    if isinstance(expr, (int, float)): return float(expr)
    if re.fullmatch(r"\s*[0-9]+(\.[0-9]+)?\s*", expr): return float(expr)
    m = re.fullmatch(r"\s*([A-Za-z0-9_]+)\s*(?:([+-])\s*([0-9.]+))?\s*", expr)
    if not m: raise SystemExit(f"bad time expression {expr!r}")
    name, sign, off = m.groups()
    if re.fullmatch(r"[0-9.]+", name): base = float(name)
    elif name in evs: base = evs[name]
    else: raise SystemExit(f"no event {name!r} (have {sorted(evs)})")
    return base + (float(off) if off else 0.0) * (-1 if sign == "-" else 1)

def title_png(path):
    from PIL import Image, ImageDraw, ImageFont
    W, H = 1920, 1080
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    big = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", 92)
    small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 34) if os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf") else big
    t1, t2 = "THE HELLCAT", "Holtburg  →  the A'mun desert  ·  Asheron's Call, holtburger-web"
    w1 = d.textlength(t1, font=big); w2 = d.textlength(t2, font=small)
    y = int(H * 0.70)
    # soft shadow for legibility over sky / forest
    for dx, dy, a in ((3, 3, 150), (0, 0, 255)):
        col = (0, 0, 0, a) if a != 255 else (246, 238, 220, 255)
        d.text(((W - w1) / 2 + dx, y + dy), t1, font=big, fill=col)
    for dx, dy, a in ((2, 2, 150), (0, 0, 255)):
        col = (0, 0, 0, a) if a != 255 else (230, 222, 205, 255)
        d.text(((W - w2) / 2 + dx, y + 118 + dy), t2, font=small, fill=col)
    im.save(path)

edl = json.load(open(os.path.join(EDIT, "edl.json")))
srcs = {s: take(s) for s in sorted({seg["src"] for seg in edl["segments"]})}
segs = []
for seg in edl["segments"]:
    tk = srcs[seg["src"]]
    a, b = at(seg["from"], tk["events"]), at(seg["to"], tk["events"])
    a = max(0.0, a)
    if b <= a + 0.2: raise SystemExit(f"empty segment {seg}")
    segs.append({**seg, "a": round(a, 3), "b": round(b, 3), "d": round(b - a, 3)})
total = 0.0
for i, s in enumerate(segs):
    tr = 0.0 if i == 0 else (DISSOLVE if s.get("join") == "dissolve" else CUT)
    s["tr"] = tr
    s["offset"] = round(total - tr, 3) if i else 0.0
    total = total - tr + s["d"]
print(f"{len(segs)} segments, {total:.1f} s")
for s in segs: print(f"  {s['src']} {s['a']:8.2f}-{s['b']:8.2f} ({s['d']:5.2f} s) join {s.get('join','-'):9s} {s.get('note','')}")
if DRY: sys.exit(0)

title = os.path.join(EDIT, "title.png")
title_png(title)
inputs = []
f = []
if SMOOTH:
    sdir = os.path.join(EDIT, "smooth")
    os.makedirs(sdir, exist_ok=True)
    summary = []
    for i, s in enumerate(segs):
        take_mp4 = srcs[s["src"]]["mp4"]
        out = os.path.join(sdir, f"{s['src']}-{s['a']:.3f}-{s['b']:.3f}.mp4")
        if s.get("smooth") is False:
            out = os.path.join(sdir, f"{s['src']}-{s['a']:.3f}-{s['b']:.3f}.raw.mp4")
        if os.path.exists(out) and os.path.getmtime(out) > max(os.path.getmtime(take_mp4), os.path.getmtime(SMOOTH_PY)):
            print(f"  smooth {i:2d} reuse {os.path.basename(out)}")
            summary.append({"seg": i, "src": s["src"], "a": s["a"], "b": s["b"], "out": out, "reused": True})
        else:
            extra = ["--max-held", "0"] if s.get("smooth") is False else []  # "smooth": false in the EDL = cut as recorded
            r = subprocess.run([sys.executable, SMOOTH_PY, take_mp4, "--from", str(s["a"]), "--to", str(s["b"]), "--out", out,
                                "--jobs", SJOBS, "--tmp", os.path.join(sdir, ".tmp"), *extra], capture_output=True, text=True)
            line = (r.stdout.strip().splitlines() or ["{}"])[-1]
            print(f"  smooth {i:2d} {line}")
            if r.returncode == 2 or not os.path.exists(out):
                raise SystemExit(f"film-smooth failed on segment {i}: {r.stderr[-400:]}")
            summary.append({"seg": i, **json.loads(line)})
        inputs += ["-i", out]
        f.append(f"[{i}:v]trim=start=0:end={s['d']},setpts=PTS-STARTPTS,fps={FPS},scale=1920:1080:flags=lanczos,format=yuv420p,setsar=1[s{i}]")
    json.dump(summary, open(os.path.join(sdir, "summary.json"), "w"), indent=1)
    ti = len(segs)
else:
    for src in srcs: inputs += ["-i", srcs[src]["mp4"]]
    idx = {src: i for i, src in enumerate(srcs)}
    ti = len(srcs)
    for i, s in enumerate(segs):
        f.append(f"[{idx[s['src']]}:v]trim=start={s['a']}:end={s['b']},setpts=PTS-STARTPTS,fps={FPS},scale=1920:1080:flags=lanczos,format=yuv420p,setsar=1[s{i}]")
inputs += ["-loop", "1", "-t", "7", "-i", title]
cur = "s0"
for i in range(1, len(segs)):
    s = segs[i]
    f.append(f"[{cur}][s{i}]xfade=transition=fade:duration={s['tr']:.3f}:offset={s['offset']:.3f}[x{i}]")
    cur = f"x{i}"
# the title over the opening: in at 1.0 s, out by 5.5 s
f.append(f"[{ti}:v]format=rgba,fade=t=in:st=1.0:d=1.0:alpha=1,fade=t=out:st=4.5:d=1.0:alpha=1,setpts=PTS-STARTPTS[tt]")
f.append(f"[{cur}][tt]overlay=0:0:eof_action=pass:format=auto[ov]")
f.append(f"[ov]fade=t=in:st=0:d=1.0,fade=t=out:st={max(0.0, total - 2.0):.3f}:d=2.0,format=yuv420p[out]")
out = os.path.join(EDIT, "hellcat-youtube.mp4")
cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", ";".join(f), "-map", "[out]",
       "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", str(FPS),
       "-g", str(FPS * 2), "-movflags", "+faststart", "-t", f"{total:.3f}", out]
open(os.path.join(EDIT, "assemble.cmd.txt"), "w").write(" ".join(cmd))
r = subprocess.run(cmd)
if r.returncode: raise SystemExit(r.returncode)
print("out", out, f"{probe_dur(out):.1f} s")
