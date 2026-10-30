#!/usr/bin/env python3
"""timeline_split.py — where the renderer main thread's time goes, JS and NOT JS.

Reads a Chrome trace recorded with the devtools.timeline categories
(laptop-timeline-probe.mjs, or any trace with them) and prints, for the page's
CrRendererMain, SELF time per event name and per group: JS (FunctionCall,
EvaluateScript, V8 execution), style (UpdateLayoutTree), layout, paint and
compositing (PrePaint, Paint, Layerize, UpdateLayer, Commit…), GC, task and rAF
dispatch, GPU command-buffer flushes, and the remainder. The V8 CPU profile's
"(program)" bucket is roughly everything here that is not JS.

Usage: python3 -I timeline_split.py TRACE.json [--frames N]
  --frames N   divide by N displayed frames (laptop-timeline-probe.mjs run.json `frames`)
"""
import collections
import json
import sys

GROUPS = [
    ("JS", ("FunctionCall", "EvaluateScript", "v8.run", "v8.callFunction", "V8.Execute", "v8.compile",
            "V8.ScriptCompiler", "v8.produceCache", "CompileScript", "EventDispatch", "RunMicrotasks",
            "V8.RunMicrotasks", "v8.callModuleMethod", "v8.evaluateModule")),
    ("GC", ("MinorGC", "MajorGC", "V8.GC", "BlinkGC", "ThreadState::", "V8.GCScavenger", "V8.GCCompactor",
            "V8.GCFinalizeMC", "V8.GC_", "GCEvent")),
    ("style", ("UpdateLayoutTree", "RecalculateStyles", "ScheduleStyleRecalculation", "StyleRecalc",
               "ParseAuthorStyleSheet", "Document::recalcStyle")),
    ("layout", ("Layout", "UpdateLayout", "LocalFrameView::layout", "InvalidateLayout")),
    ("paint+composite", ("PrePaint", "Paint", "PaintImage", "Layerize", "UpdateLayer", "UpdateLayerTree",
                         "CompositeLayers", "Commit", "PaintArtifactCompositor", "LocalFrameView::RunPostLifecycleSteps",
                         "ProxyMain::BeginMainFrame", "LayerTreeHost::", "cc::", "Rasterize", "Decode Image",
                         "Draw LazyPixelRef", "ImageDecodeTask", "Canvas2DLayerBridge", "HitTest")),
    ("gpu flush", ("CommandBufferProxyImpl::", "CommandBufferHelper::", "GpuChannel", "CommandBuffer::",
                   "ImplementationBase::", "GLES2", "RasterImplementation", "WebGL", "SharedImage")),
    ("rAF/timer/task dispatch", ("FireAnimationFrame", "TimerFire", "RequestAnimationFrame", "ThreadControllerImpl::RunTask",
                                 "SequenceManager", "ThreadPool", "BlinkScheduler", "WidgetBase::", "PageAnimator",
                                 "Animation", "ScrollUpdate", "FrameScheduler", "MessageLoop", "Receive mojo",
                                 "SimpleWatcher", "MojoMessage", "PostTask", "RunTask")),
]


def group_of(name):
    for g, prefixes in GROUPS:
        for p in prefixes:
            if name == p or name.startswith(p):
                return g
    return "other"


def load_events(path):
    """Playwright writes {"traceEvents":[...]} with one event per line; fall back to json.load."""
    events, meta = [], {}
    ok_lines = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip().rstrip(",")
            if not line.startswith("{") or line.startswith('{"traceEvents"'):
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            ok_lines += 1
            events.append(e)
    if ok_lines < 10:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            d = json.load(f)
        events = d["traceEvents"] if isinstance(d, dict) else d
    for e in events:
        if e.get("ph") == "M" and e.get("name") == "thread_name":
            meta[(e.get("pid"), e.get("tid"))] = (e.get("args") or {}).get("name")
    return events, meta


def main():
    path = sys.argv[1]
    frames = None
    if "--frames" in sys.argv:
        frames = float(sys.argv[sys.argv.index("--frames") + 1])
    events, threads = load_events(path)
    # The busiest CrRendererMain is the page's.
    busy = collections.Counter()
    for e in events:
        if e.get("ph") == "X" and threads.get((e.get("pid"), e.get("tid"))) == "CrRendererMain":
            busy[(e.get("pid"), e.get("tid"))] += e.get("dur", 0)
    if not busy:
        print("no CrRendererMain X events")
        return
    key = busy.most_common(1)[0][0]
    rows = []
    open_b = collections.defaultdict(list)
    for e in events:
        if (e.get("pid"), e.get("tid")) != key:
            continue
        ph = e.get("ph")
        if ph == "X":
            rows.append((e["ts"], e.get("dur", 0), e.get("name", "")))
        elif ph == "B":
            open_b[e.get("name", "")].append(e["ts"])
        elif ph == "E":
            nm = e.get("name", "")
            if open_b.get(nm):
                ts = open_b[nm].pop()
                rows.append((ts, e["ts"] - ts, nm))
    rows.sort(key=lambda r: (r[0], -r[1]))
    t0 = rows[0][0]
    t1 = max(r[0] + r[1] for r in rows)
    span = (t1 - t0) / 1000.0
    selft = collections.Counter()
    stack = []  # [end, name, childsum, dur]
    top_busy = 0.0

    def pop_until(ts):
        while stack and stack[-1][0] <= ts:
            end, name, child, dur = stack.pop()
            selft[name] += max(0, dur - child) / 1000.0

    for ts, dur, name in rows:
        pop_until(ts)
        if stack:
            stack[-1][2] += dur
        else:
            top_busy += dur / 1000.0
        stack.append([ts + dur, name, 0, dur])
    pop_until(float("inf"))
    div = frames if frames else 1.0
    unit = "ms/frame" if frames else "ms"
    print(f"== {path}: CrRendererMain span {span:.0f} ms, top-level busy {top_busy:.0f} ms ({100*top_busy/span:.0f}%)"
          + (f", {frames:.0f} frames" if frames else ""))
    groups = collections.Counter()
    for n, v in selft.items():
        groups[group_of(n)] += v
    print(f"  by group ({unit}):")
    for g, v in groups.most_common():
        print(f"   {v/div:8.3f}  {100*v/top_busy:5.1f}%  {g}")
    print(f"  top self events ({unit}):")
    for n, v in selft.most_common(45):
        print(f"   {v/div:8.3f}  {100*v/top_busy:5.1f}%  [{group_of(n)}] {n}")


if __name__ == "__main__":
    main()
