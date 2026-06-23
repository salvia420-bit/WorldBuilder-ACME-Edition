# RESULTS — Shader-program link: the full cold-load map; largely addressed by two shipped fixes (2026-06-23)

The synchronous D3D11 shader-program LINK is the dominant cold-load cost on the real 1070 (headed
Chrome, `KHR_parallel_shader_compile maxThreads=null` → link is synchronous, not background). This maps
the **entire** cost from the goal1 72-program manifest and shows where it now stands after the fixes
shipped this cycle. **Bottom line: the two shipped fixes (light-pool trim + cloud-noise prebake) take
the `clouds=on` cold link from ~100 s → ~22 s. There is no cheap remaining lever.**

> Measurement note: the 1070 was **offline** when this was written, so this is a fresh *analysis* of the
> existing goal1 manifest (`shader-manifest-full.json`, real-1070 Chrome headless, synchronous link) +
> the per-program GLSL analysis (`all-analyses.json`), cross-referenced with this session's headless
> program-count verifies — not a new live capture. A confirming re-capture (manifest with both fixes
> active) is queued for when the box is back.

## The 100.2 s cold link (clouds=on), by category

| category | link time | programs | status |
|---|---:|---:|---|
| **Surface** — `MeshStandardMaterial` lit family (per-DID, light-BRDF unrolled over the pool) | **59.6 s** | 40 | **light-pool 8/2 shipped (`59544b35`) → ~14 s (−76%, measured)** |
| **Cloud noise bakes** — #0 LocalWeather 25.9 s + #1 turbulence/curl 6.1 s + #23 CloudShape/Detail 0.8 s | **~33 s** | 4 | **prebake shipped (`e3a791b1`) → 0** |
| **Cloud render** — `CloudsMaterial` 2.7 s + `CloudsResolveMaterial` 2.8 s (+shadow ~0.4) | ~6 s | 5 | unavoidable (the volumetric raymarch shaders) |
| terrain / sky / shadow / post / particle | 1.8 s | 23 | negligible (incl. all the logDepth-on-inert passes = Lever C, no-win) |

(One-time D3D11 fxc/driver init is folded into whichever program links first — a few seconds that
relocate rather than disappear; not a separate removable line.)

## What the two shipped fixes removed

- **Light-pool 8/2** (`lighting.js`, `59544b35`): the surface family's BRDF is unrolled over the fixed
  light pool; shrinking 32/8 → 8/2 cut the surface link **−76%** (4334 → 1058 ms on the heaviest
  surface; family 59.6 s → ~14.3 s). This was goal1's "#1 lever, the only one that matters" — shipped.
- **Cloud-noise prebake** (`cloud_overlay.js`, `e3a791b1`): `proceduralTextures=false` skips creating
  the 4 noise-bake `RawShaderMaterial`s (#0/#1/#23), so they never compile → **~33 s removed** on the
  `clouds=on` path. (This **corrects** `RESULTS-clouds-noise-prebake-2026-06-22.md`, which had
  understated it as ~6–13 s by wrongly calling #0 "driver warmup" — goal1's per-program GLSL analysis
  shows #0 is the LocalWeather Perlin/Worley bake itself, removed outright.)

Net cold shader-link:
- **`clouds=on`**: ~100 s → **~22 s** (~14 s surface + ~6 s cloud-render + ~2 s other).
- **`clouds=off` (default)**: ~62 s → **~16 s** (no cloud programs at all; ~14 s surface + ~2 s other).

## Is there a remaining lever? No cheap one.

- **Surface (~14 s):** already at the light-pool visual-parity floor (8/2, validated byte-identical).
  Going lower (4/1) risks dropping a visible light in dense dusk scenes — marginal + risky.
- **Surface program COUNT (40 programs):** the manifest's `collapse-axis` trims (make `lightClampRetail`
  / `csmEnabled` / `pomEnabled` / `USE_EMISSIVEMAP` cacheKey axes into runtime uniforms to merge
  variants) could in principle cut the count. But goal1 already judged these **marginal/invalid**
  (the lightClamp hoist is invalid — the per-light non-linear clamp can't be hoisted; POM-cap measured
  **zero**; sub-loop trims "vanished into noise"). Post-light-pool each surface program is only ~0.36 s,
  so merging saves ~0.36 s each, and `toUniform` makes each program *bigger* (both code paths) →
  partially self-cancelling. Not worth a speculative, unvalidatable change (box offline), and it cuts
  against the measure-first discipline that just retired Levers B and C as no-wins.
- **Cloud render (~6 s):** takram's core volumetric raymarch shaders; simplifying = visible quality
  loss. The handoff's "unavoidable remainder."
- **compileAsync / KHR background link:** dead on the real 1070 — `maxThreads=null` means ANGLE/D3D11
  links synchronously regardless, so `compileAsync` can't parallelize it. (It works headless, which is
  exactly why headless can't reproduce the stall.)

## Conclusion

The shader-program link — the dominant cold-load cost and the through-line behind Levers B and C being
no-wins — is **already largely taken** by the two fixes shipped this cycle (light-pool + cloud prebake):
~100 s → ~22 s on `clouds=on`. The residual (~14 s light-pool-floored surface + ~6 s unavoidable
cloud-render) has no cheap, low-risk lever; the remaining candidates are goal1-marginal and would need
1070 validation. **Recommend: stop here on cold-load shader work.** If a future need justifies it, the
one un-tried candidate is surface variant-collapse (lightClamp/csm/pom axes → uniforms), to be measured
on the 1070 first.

## Artifacts

`shader-link-landscape-2026-06-23/`: `shader-manifest-timings.json` (the 72-program manifest, real-1070
synchronous, per-program `queryMs` link block — timings only, GLSL source stripped to keep it small) +
`all-analyses.json` (the goal1 per-program GLSL analysis with per-program trims/unavoidable/compile-
drivers) + `shader-manifest.cjs` (the capture harness). Full-source manifest (10.7 MB) kept in scratch.
