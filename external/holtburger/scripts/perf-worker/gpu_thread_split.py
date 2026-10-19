#!/usr/bin/env python3
"""gpu_thread_split.py — where Chrome's GPU-process main thread (CrGpuMain) spends a frame.

A WebGL frame has THREE places to stall: the renderer main thread (JS + three.js),
CrGpuMain (Chrome decoding the command buffer and ANGLE turning it into D3D11 —
plus the DOM/HUD raster, which runs on the same thread), and the GPU. The CPU
profile sees only the first; GPU timer queries see the third. This reads a
Chrome trace (one JSON event per line, as `gputrace.mjs` / playwright
`browser.startTracing` write it, categories at least `toplevel,gpu`; add
`gpu.angle` for ANGLE events) and splits CrGpuMain's busy time per presented
frame into WEBGL (command-buffer execution), RASTER (OOP-R: the DOM/HUD tiles and
2D canvases), PRESENT/DCOMP and other, next to CrRendererMain's busy time.

2026-10-06 first-turn trace (mid, 1280x633, lightLoops arm): CrGpuMain 79% busy,
WEBGL 15.2 ms + RASTER 4.7 ms per present, with CrRendererMain 98% busy.

Usage:  python3 -I gpu_thread_split.py TRACE.json [TRACE2.json ...]
Streams the file line by line (traces run to 100+ MB); memory stays small.
"""
import collections
import json
import sys


def split(path):
    threads = {}
    events = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip().rstrip(",")
            if not line.startswith("{"):
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            ph = e.get("ph")
            if ph == "M":
                if e.get("name") == "thread_name":
                    threads[(e.get("pid"), e.get("tid"))] = (e.get("args") or {}).get("name")
                continue
            if ph != "X":
                continue
            events.append((e.get("pid"), e.get("tid"), e.get("ts", 0), e.get("dur", 0), e.get("name") or ""))

    def top_level(rows):
        # (ts, dur, name, children-by-name) for events not nested in another on the same thread
        rows.sort(key=lambda x: x[2])
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

    gpu = [x for x in events if threads.get((x[0], x[1])) == "CrGpuMain"]
    if not gpu:
        print(f"{path}: no CrGpuMain events (trace categories need at least toplevel,gpu)")
        return
    t0 = min(x[2] for x in gpu)
    t1 = max(x[2] + x[3] for x in gpu)
    span_ms = (t1 - t0) / 1000.0
    tops = top_level(gpu)
    cls = collections.Counter()
    for _ts, dur, name, ch in tops:
        if any(k.startswith("RasterDecoderImpl") for k in ch) or "RendererRasterWorker" in ch:
            c = "RASTER (DOM/HUD, OOP-R)"
        elif "WebGL" in ch:
            c = "WEBGL"
        elif any("Present" in k for k in ch):
            c = "PRESENT/DCOMP"
        else:
            c = "other:" + (max(ch, key=ch.get) if ch else name)
        cls[c] += dur
    busy = sum(t[1] for t in tops)
    # One present event KIND per frame: the DComp presenter calls the swap chain's
    # Present, so counting both doubles the frame count (and halves every ms/frame).
    names = collections.Counter(x[4] for x in gpu)
    kind = next((k for k in ("DXGISwapChainImageBacking::Present", "DCompPresenter::Present", "SwapBuffers") if names[k]), None)
    presents = names[kind] if kind else 0
    per = max(presents, 1)
    print(f"== {path}")
    print(f"CrGpuMain span {span_ms:.0f} ms, busy {busy / 1000:.0f} ms ({100 * busy / 1000 / span_ms:.0f}%), "
          f"presents {presents} ({presents / (span_ms / 1000):.1f}/s)")
    for k, v in cls.most_common(10):
        print(f"  {v / 1000:9.1f} ms  {100 * v / max(busy, 1):5.1f}% of busy  {v / 1000 / per:6.2f} ms/present  {k}")
    main = [x for x in events if threads.get((x[0], x[1])) == "CrRendererMain"]
    if main:
        mt = top_level(main)
        mb = sum(t[1] for t in mt)
        print(f"CrRendererMain busy {mb / 1000:.0f} ms ({100 * mb / 1000 / span_ms:.0f}% of span), "
              f"{mb / 1000 / per:.2f} ms/present")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    for p in sys.argv[1:]:
        split(p)
