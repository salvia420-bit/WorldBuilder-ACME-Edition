#!/usr/bin/env python3
# Usage: python3 -I profile_systems.py PROFILE.cpuprofile FRAMES   (FRAMES = profile seconds x fps)
# Partitions a V8 .cpuprofile into per-frame system buckets (docs/2026-10-26-rust-scene-core.md section 1).
"""Partition main-thread time into systems (innermost listed entry frame wins),
then split each system by leaf kind (our JS / three.js JS / three graph / WebGL / wasm).
Reports ms per displayed frame given a frame count (from the run json)."""
import collections, json, sys
sys.path.insert(0, __import__("os").path.dirname(__file__))
from profile_bucket import load, leaf_kind, fname, furl

# (label, function name, file) ; file None = any. Innermost match wins.
ENTRIES = [
    ("diag (bench-only renderDiag)", "recordRenderDiag", "index.js"),
    ("render: world pass", "render", "msaa_world.js"),
    ("render: post/composer passes", "render", "atmosphere_pipeline.js"),
    ("render: shadow maps", "sm.render", "shadow_caster_list.js"),
    ("render: shadow maps", "render", "WebGLShadowMap"),
    ("render: scene graph matrices", "sceneProto.updateMatrixWorld", "skip_hidden_matrix.js"),
    ("render: three projectObject (cull+list)", "projectObject", "three.module.js"),
    ("render: three render-list sort", "sort", "three.module.js"),
    ("render: three draw loop (renderScene)", "renderScene", "three.module.js"),
    ("game: entities tick", "tick", "entities.js"),
    ("game: entity rig pose (motion)", "poseRigAt", "motion_sequence.js"),
    ("game: particles", "tick", "particle_manager.js"),
    ("game: statics per-frame loop (_spLoop)", "_spLoop", "statics.js"),
    ("game: statics billboards", "_bbLoop", "statics.js"),
    ("game: frustum culling", "tickFrustumCull", "culling.js"),
    ("game: terrain VFX", "terrainVfxTick", "terrain_vfx.js"),
    ("game: cell visibility/portals", "tickCellVisibility3D", "cells.js"),
    ("game: animated scenery", "loop", "animated_scenery.js"),
    ("game: camera", "tick", "camera.js"),
    ("game: net pump (JS side)", "pumpNetFrame", "index.html"),
    ("wasm callbacks (session/net)", "real", "holtburger_web.js"),
    ("hud: vitals orbs", "frame", "vitals-orbs.js"),
    ("hud: radar", "tick", "radar.js"),
    ("game: lighting", "tickLightingForCellState", "lighting.js"),
    ("game: fx lights/showcase/ribbons/weapon", "tickFxLights", "fx_lights.js"),
    ("game: fx lights/showcase/ribbons/weapon", "tickFxShowcase", "fx_showcase.js"),
    ("game: fx lights/showcase/ribbons/weapon", "tickFxRibbons", "fx_ribbons.js"),
    ("game: fx lights/showcase/ribbons/weapon", "tickWeaponFx", "weapon_fx.js"),
    ("game: material variant sync", "syncBatchMatVariants", "batched_material_variant.js"),
    ("game: other loop.js per-frame", "_tickPerFrameBody", "loop.js"),
    ("render: other index.js tick", "tick", "index.js"),
]


def match(n, fn, fl):
    f, u = fname(n), furl(n)
    if f != fn:
        return False
    if fl is None:
        return True
    return u == fl or (fl in u)


def main(prof, frames):
    p, nodes, parent = load(prof)
    sysms = collections.Counter()
    split = collections.defaultdict(collections.Counter)
    rest = collections.Counter()
    tot = 0.0
    for sid, dt in zip(p["samples"], p["timeDeltas"]):
        ms = dt / 1000.0
        st = []
        x = sid
        while x is not None:
            st.append(nodes[x])
            x = parent.get(x)
        lk = leaf_kind(st[0])
        if lk == "(idle)":
            continue
        label = None
        for n in st:  # leaf -> root: innermost first
            for lab, fn, fl in ENTRIES:
                if match(n, fn, fl):
                    label = lab
                    break
            if label:
                break
        if label is None:
            if lk in ("(program)", "(garbage collector)"):
                label = lk
            else:
                # outermost non-root frame's file
                outer = st[-2] if len(st) > 1 else st[0]
                label = "other: " + (furl(outer) or fname(outer))
                rest[label + " :: " + fname(outer)] += ms
        tot += ms
        sysms[label] += ms
        k = lk
        if k.startswith("our JS"):
            k = "ourJS"
        elif k.startswith("three.js scene"):
            k = "3graph"
        elif k.startswith("three.js"):
            k = "3js"
        elif k == "native: WebGL call":
            k = "GL"
        elif k.startswith("wasm"):
            k = "wasm"
        else:
            k = "other"
        split[label][k] += ms
    diag = sysms.get("diag (bench-only renderDiag)", 0)
    busy = tot - diag
    print(f"== {prof}: busy (diag excluded) {busy:.0f} ms over {frames} frames = {busy/frames:.2f} ms/frame")
    print(f"   {'system':44s} {'ms/fr':>6s} {'%':>5s} | {'ourJS':>6s} {'3js':>6s} {'3graph':>6s} {'GL':>6s} {'wasm':>6s} {'other':>6s}")
    for lab, v in sysms.most_common():
        if lab.startswith("diag"):
            continue
        s = split[lab]
        print(f"   {lab[:44]:44s} {v/frames:6.2f} {100*v/busy:5.1f} | "
              + " ".join(f"{s.get(k,0)/frames:6.2f}" for k in ("ourJS", "3js", "3graph", "GL", "wasm", "other")))
    print("   top 'other:' entries:")
    for k, v in rest.most_common(15):
        print(f"      {v/frames:6.3f} ms/fr  {k}")


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]))
