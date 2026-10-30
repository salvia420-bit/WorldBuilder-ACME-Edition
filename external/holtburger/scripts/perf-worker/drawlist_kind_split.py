#!/usr/bin/env python3
"""drawlist_kind_split.py — split a V8 .cpuprofile's draw time by draw KIND (2026-10-26, stage-3 draw list).

Pairs with drawlist-census.eval.js: its "install" phase leaves one distinctly NAMED renderBufferDirect wrapper
per kind (`rbd_pool_opaque`, `rbd_entity_part`, ...) outside every other wrapper, so in a CPU profile taken
meanwhile (`node hbsess.mjs profile 8 OUT.cpuprofile`) every sample inside a draw carries its kind. Per kind
this prints ms/frame and where it goes:
  setProgram (all of it) / upload (material-switch uniform walk) / refreshMaterialUniforms / bindingStates.setup /
  the draw dispatch (render, renderMultiDraw, renderInstances) / state.setMaterial / GL natives (self) /
  our per-draw wrappers (batched_runs, async_link_guard, skip_empty_multidraw, uniform_bind_patch, ...) / rest.
It also prints the world-pass totals around the draws (renderObject/onBeforeRender hooks are OUTSIDE the
tagged wrapper, so they are reported per hook file, not per kind).

Usage:  python3 -I drawlist_kind_split.py OUT.cpuprofile FPS
FPS = the fps of the profiled window (hbsess profile prints {frames, fps}); frames = profile seconds x FPS.
"""
import collections
import json
import sys

GL_NATIVE_HINT = ("bind", "uniform", "draw", "multiDraw", "useProgram", "activeTexture", "enable", "disable",
                  "depth", "blend", "stencil", "colorMask", "frontFace", "cullFace", "polygonOffset", "tex",
                  "buffer", "generateMipmap", "viewport", "scissor", "beginQuery", "endQuery", "pixelStorei")
OUR_FILES = ("batched_runs.js", "async_link_guard.js", "skip_empty_multidraw.js", "uniform_bind_patch.js",
             "batched_indirect_per_camera.js", "shader_logdepth.js", "static_batch_x.js", "draw_exec.js")
BUCKETS = (("setProgram", "setProgram"), ("upload", "upload"), ("refreshMaterialUniforms", "refreshMaterialUniforms"),
           ("setup", "bindingStates.setup"), ("render", "draw dispatch"), ("renderMultiDraw", "draw dispatch"),
           ("renderInstances", "draw dispatch"), ("setMaterial", "state.setMaterial"))


def main(path, fps):
    p = json.load(open(path))
    nodes = {n["id"]: n for n in p["nodes"]}
    parent = {}
    for n in p["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    secs = (p["endTime"] - p["startTime"]) / 1e6
    frames = max(1.0, secs * fps)
    kind_tot = collections.Counter()
    kind_cat = collections.defaultdict(collections.Counter)
    world = collections.Counter()
    hooks = collections.Counter()
    for sid, dt in zip(p["samples"], p["timeDeltas"]):
        ms = dt / 1000.0
        st = []
        x = sid
        while x is not None:
            st.append(nodes[x])
            x = parent.get(x)
        names = [s["callFrame"]["functionName"] for s in st]
        if "renderScene" not in names:
            continue
        world["renderScene (all passes)"] += ms
        kind = None
        kidx = None
        for i, nm in enumerate(names):  # leaf -> root: the innermost tag wins
            if nm.startswith("rbd_"):
                kind, kidx = nm[4:], i
                break
        leaf = st[0]["callFrame"]
        lfn, lurl = leaf["functionName"] or "(anon)", leaf["url"].split("/")[-1].split("?")[0]
        if kind is None:
            # inside renderScene but outside every draw: the loop, renderObject, onBeforeRender hooks
            f = next((s["callFrame"]["url"].split("/")[-1].split("?")[0] for s in st
                      if s["callFrame"]["url"].split("/")[-1].split("?")[0] in OUR_FILES), None)
            hooks[f or ("three: " + lfn)] += ms
            continue
        kind_tot[kind] += ms
        below = names[:kidx]  # frames between the leaf and the tag
        cat = None
        if lurl == "" and lfn.startswith(GL_NATIVE_HINT):
            cat = "GL natives (self)"
        elif lurl in OUR_FILES:
            cat = "our wrappers/patches: " + lurl
        else:
            label_of = dict(BUCKETS)
            for nm in below:  # leaf -> tag: the INNERMOST bucket function wins (upload inside setProgram = upload)
                if nm in label_of:
                    cat = label_of[nm]
                    break
            cat = cat or ("three other: " + lfn)
        kind_cat[kind][cat] += ms
    print(f"{path}: {secs:.1f} s x {fps} fps = {frames:.0f} frames")
    print(f"renderScene (all passes) {world['renderScene (all passes)'] / frames:.3f} ms/frame; tagged draws "
          f"{sum(kind_tot.values()) / frames:.3f} ms/frame")
    for k, v in kind_tot.most_common():
        print(f"  {k:18s} {v / frames:7.3f} ms/frame")
        for c, w in kind_cat[k].most_common(9):
            if w / frames >= 0.005:
                print(f"      {w / frames:7.3f}  {c}")
    print("  outside the tagged draws (loop, renderObject, onBeforeRender hooks), top:")
    for k, v in hooks.most_common(12):
        if v / frames >= 0.005:
            print(f"      {v / frames:7.3f}  {k}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], float(sys.argv[2]))
