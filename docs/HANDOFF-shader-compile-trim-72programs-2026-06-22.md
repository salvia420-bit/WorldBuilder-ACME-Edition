# HANDOFF — Shader-compile trim: a 72-program workflow (2026-06-22)

> **Status:** scoped, not started. Follow-on to `docs/PLAN-goal1-drawdistance-streaming-throttle-2026-06-22.md`
> ("FINAL — option 2: trim shader compile cost"). Shipped baseline = `a1ec6c20` on
> `origin/master` (salvia420-bit).

## TL;DR

The r10 draw-distance cold-fill ceiling is **synchronous shader-program compilation by ANGLE's
D3D11 HLSL backend**: ~**72 distinct WebGL programs** × ~**1.4 s** compile+link each ≈ **~98 s**
of main-thread block (the ~61 % `getProgramParameter`/`getProgramInfoLog` cost the 1070 probe
measured). It's a *first-load* cost (warms via Chrome's on-disk program cache) and ~49 of the 72
are the radius-independent base set. `checkShaderErrors=false`, `compileAsync` prewarm, fetch
throttling, and the verify toggle all proved unable to move it — the link blocks in the driver.

The only code-side lever left is **reduce the cost of compiling those programs** — by (a)
**collapsing variant axes** (a `#define` that varies → a uniform branch → N programs become 1),
and (b) **trimming per-program feature complexity** (fewer branches/samples/loops → faster HLSL
compile). This handoff turns that into an **exhaustive, one-agent-per-program sweep over all 72
programs** + a cluster-dedup synthesis that ranks the trims by *(programs eliminated × compile-ms)
per fidelity-risk*.

**Why 72 agents:** exhaustive coverage — every program gets a dedicated analysis so nothing is
hand-waved. Most of the 72 are *variants of a few base shaders* (terrain ShaderMaterial; object/
building `MeshStandardMaterial` + `onBeforeCompile` patches; sky; atmosphere; UI; particles), so
the synthesis phase **clusters siblings and finds the global multiplier axes** — the single
changes (e.g. `logarithmicDepthBuffer`) that cut compile cost across *all* 72 at once. The sweep
exists to *prove* which axes those are with data, not to assume.

---

## Phase 0 — Enumerate + measure the 72 (PREREQUISITE; produces the work-list)

A 72-agent fan-out needs a stable, indexable manifest of the 72 programs. Programs are runtime
artifacts, so capture them on a real cold load. **Run on the 1070 headless (real GPU / ANGLE
D3D11), fresh profile, `?pvsRingRadius=10&quality=high` cold** (the same config the ceiling was
measured in — program set varies by quality preset, see `quality.js`).

Instrument shader-program creation to record, per program:

| field | how |
|---|---|
| `idx` | stable index 0..71 (sort by `linkMs` desc) |
| `cacheKey` | three.js `WebGLProgram.cacheKey` (encodes shader + all defines/params) |
| `name` | `program.name` / material `.type` (e.g. `MeshStandardMaterial`, terrain `ShaderMaterial`) |
| `defines` | the material `.defines` + `customProgramCacheKey` discriminators at creation |
| `glslLines` | vertex + fragment line counts (proxy for complexity) |
| `linkMs` | **measured compile+link time** — wrap the program's first `getProgramParameter(LINK_STATUS)` / `getProgramInfoLog` and time it (this is the gold prioritization metric) |
| `usedTimes` | `program.usedTimes` (how many materials share it) |

Capture mechanism (pick one): hook `THREE.WebGLRenderer`'s program path — either monkey-patch
`gl.linkProgram` / `gl.getProgramParameter` to stamp `performance.now()` deltas keyed by program,
or instrument three.js `WebGLPrograms.acquireProgram` + `WebGLProgram` link. Dump to
`shader-program-manifest.json` (72 rows). Reuse the probe harness at
`/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/` (the `goal1-probe.cjs` / `shader-diag.cjs`
scaffolding already logs in, reaches outdoor `0xA9B40019`, and reads `renderer.info.programs`).

> Gotcha: `renderer.info.programs[i]` gives the live `WebGLProgram` but not its source defines
> directly — capture defines at *creation* time (hook), or decode the `cacheKey` string. The
> `customProgramCacheKey` note at `materials.js:256` is why object materials get distinct
> programs despite shared `onBeforeCompile` source — account for it.

**Output:** `shader-program-manifest.json` = the 72-row work-list, passed as the workflow `args`.

---

## Phase 1 — 72 per-program agents (the sweep)

One agent per manifest row. Each agent is given its row + the relevant shader source and answers
a fixed schema. **Read-only analysis — no edits in this phase.**

**Agent task (per program):**
1. **Identify the source.** Which material/subsystem creates this program? Map `name`/`cacheKey`
   to: terrain (`terrain.js:719` `TERRAIN_VERTEX_GLSL` / `:911` `TERRAIN_FRAGMENT_GLSL`,
   `ShaderMaterial`), object/building PBR (`materials.js` `MeshStandardMaterial` + the
   `onBeforeCompile` chain at `:287-299`), sky/atmosphere (`atmosphere_runtime.js` /
   `atmosphere_pipeline.js`), UI sprites, particles, or wire-mode (`MeshBasicMaterial`).
2. **Decompose the feature set** from `defines`/`cacheKey`: which axes are present —
   `logarithmicDepthBuffer` (log-z; set globally at `index.js:578`), CSM/shadows (`csmEnabled`),
   normal maps (`normalMapsEnabled`), POM (`pomEnabled`), fog, vertex colors, num-lights,
   triplanar/displacement/detail-normal/road/water-lava (terrain), `USE_*` toggles.
3. **Attribute compile cost.** Given `linkMs` + `glslLines`, what drives this program's compile
   time — texture-sample count, dynamic branches, unrolled loops, the log-z injection, the
   CSM cascade sampling, the terrain triplanar/displacement blocks?
4. **Propose trims**, each tagged with *fidelity impact* + *whether it MERGES this program with a
   sibling*:
   - **Collapse axis:** can a distinguishing `#define` become a *uniform* branch so this program
     and its siblings share ONE program? (Biggest lever — N→1.)
   - **Remove feature:** is a feature here unused/negligible at this LOD/distance (e.g. POM or
     detail-normal on a distant LB material) and safe to strip?
   - **Simplify:** fewer samples/branches/loop iters with no visible change.
5. **Verdict:** `estCompileMsSaved`, `estProgramsMerged` (if the collapse applies repo-wide),
   `fidelityRisk` (none/low/med/high), and a one-line concrete change.

**Per-agent output schema** (force via StructuredOutput):
```
{ idx, source, baseShader, features:[...], compileDrivers:[...],
  trims:[ { kind:"collapse-axis"|"remove-feature"|"simplify", define, toUniform:bool,
            estCompileMsSaved:number, estProgramsMerged:number,
            fidelityRisk:"none"|"low"|"med"|"high", change:"...", file, anchor } ],
  unavoidable:bool, notes }
```

---

## Phase 2 — Cluster + dedup synthesis (barrier)

Collect all 72 results, then:
1. **Cluster** by `baseShader` — the 72 collapse into ~5–8 base families × variant axes.
2. **Rank the global multiplier axes** by `Σ(estProgramsMerged × linkMs)`: a `#define` present on
   K of the 72 programs that could become a uniform eliminates ~K programs in one change. Expect
   `logarithmicDepthBuffer` and CSM/shadow-cascade and num-lights to be the top axes. **These
   single changes are the actual deliverable** — the per-program sweep exists to identify and
   size them with data.
3. **Per-family trims** that don't collapse axes (feature strips, simplifications), ranked by
   `estCompileMsSaved / fidelityRisk`.
4. **Flag unavoidable programs** (sky, UI) — no trim.

**Synthesis output:** a ranked table of changes, each with: programs eliminated, estimated cold
fillMs saved, files+anchors, fidelity risk, and effort.

---

## Phase 3 — Implementation plan + validation

- **Plan:** start with the highest-(programs×ms)/risk axis collapse (likely `logarithmicDepthBuffer`
  → evaluate per-fragment log-z need vs a cheaper depth strategy; it's at `index.js:578` and
  touches every program). Then the next axis, then per-family strips. Each behind a flag,
  default-ON only after a 1070 eye-test (per project convention — validated render features ship
  default-ON with a `=off` escape).
- **Validation (the success metric):** re-run the **3-arm cache-disambiguation probe**
  (`docs/PLAN-…md` methodology — **fresh Chrome profile per arm**, run-to-plateau, continuous
  profile) at r10 cold, baseline vs trimmed. Expect: **program count ↓**, `getProgram*` ↓ in the
  profile, **`fillMs` ↓**. Also confirm no visual regression vs baseline screenshots (the trims
  are a fidelity tradeoff — eye-test each on the 1070, batched/off-screen).
- **Caveat:** this only helps the *cold* (first-load) path; warm reloads already hit Chrome's
  program cache (~idle). Weigh whether cold-load r10 is worth the fidelity tradeoff vs simply
  accepting the one-time cost (PLAN-doc option 1).

---

## Workflow script shape (execution vehicle)

```js
export const meta = {
  name: 'shader-compile-trim-72',
  description: 'Per-program analysis of all 72 shader programs + cluster-dedup trim plan',
  phases: [{ title: 'Sweep' }, { title: 'Synthesize' }],
}
// args = the Phase-0 shader-program-manifest.json (72 rows). Fan out one agent per row.
const programs = args   // [{idx, cacheKey, name, defines, glslLines, linkMs, usedTimes}, ...]
phase('Sweep')
const analyses = await parallel(programs.map((p) => () =>
  agent(perProgramPrompt(p), { label: `prog:${p.idx}:${p.name}`, phase: 'Sweep', schema: TRIM_SCHEMA })
))
phase('Synthesize')
const plan = await agent(synthesisPrompt(analyses.filter(Boolean)), { label: 'synthesize' })
return { plan, analyses: analyses.filter(Boolean) }
```
Run via the **Workflow tool** (ultracode opt-in). The 16-wide concurrency cap means the 72 agents
run in ~5 waves; that's fine. **Phase 0 is NOT part of the workflow** — produce the manifest first
(it needs a real 1070 GPU load), then invoke the workflow with `args: <manifest>`.

---

## Anchors

- `index.js:575` renderer creation; `:578` `logarithmicDepthBuffer: true` (the prime global axis).
- `terrain.js:719` `TERRAIN_VERTEX_GLSL`, `:911` `TERRAIN_FRAGMENT_GLSL` (terrain ShaderMaterial).
- `materials.js:287-299` `onBeforeCompile` chain; `:256` `customProgramCacheKey` (why PBR variants
  fork programs).
- `quality.js` presets (`subdivLevel`, `antialias`, `normalMapsEnabled`, `pomEnabled`, csm) — the
  program set is quality-dependent; enumerate in the target preset.
- Probe scaffolding: `/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/{goal1-probe,shader-diag}.cjs`.

## Invariants / caveats (don't relearn these the hard way)

- **Fresh Chrome profile per arm** for any A/B — a shared persistent profile warms the on-disk GL
  program cache across arms and makes arm 2 spuriously fast (this confounded 5 prior A/Bs).
- **Continuous full-fill profile + run-to-plateau (equalized work)** — a 4 s phase-snapshot
  profiler is unreliable here (it reported "71 % manifest::catalog" once — a phase artifact).
- 1070 tests **headless / off-screen** only (a person uses that machine).
- Each trim is a **fidelity change** → eye-test on the 1070 before flipping default-on; keep a
  `=off` escape.
- `KHR_parallel_shader_compile` is *present* on the 1070 ANGLE/D3D11 context but `maxThreads=null`
  → it does NOT actually background compiles; do not assume parallel compile will save you.
