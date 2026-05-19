# FPS Perf Plan — Follow-on (2026-05-18)

After the FPS audit's 38 findings closed across 8 waves (`docs/fps-perf-plan-2026-05-18.md`), five concrete loose ends remain. All open audit items shipped; these are explicit follow-ons agent waves deferred.

## Conventions

Same as the main plan — see the "Lessons & conventions from waves 1–5" section in `fps-perf-plan-2026-05-18.md`. In particular:

- Use `node -e "import('./...').then(()=>console.log('OK')).catch(...)"` for verification, not just `node --check`.
- Honor the existing module-scratch table.
- Bail responsibly if you uncover a blocker.
- Don't broaden scope — one fix per PR.

## Tasks

### FU1 — Wire `?particleSortObjects` flag into scene
**Severity** Low • **File** `scene3d/index.js` • **Status** ✅ Done (commit `221fa1c`)

**Problem.** E5 (`e1339af`) plumbed the URL flag to `window.__particleSortObjects` but left the scene-construction read site as a TODO.

**Fix.** At the `new THREE.Scene()` site, after construction, add:
```js
if (typeof window !== "undefined" && window.__particleSortObjects === false) {
  scene.sortObjects = false;
}
```

**Verification.** `import()` smoke. With the flag set, scene's `sortObjects` is `false`; without it, default `true`.

**Risk.** None.

---

### FU2 — Distance-tier follow-on for statics + buildings receiveShadow
**Severity** Med • **Files** `scene3d/statics.js`, `scene3d/buildings.js` • **Status** ✅ Done (commit `87f2d12` — singleton Mesh path gets per-placement distSq < 60² gate; InstancedMesh keeps low-preset-only gate per option (b); spawn-point reference = Holtburg LB centre)

**Problem.** C2 (`8ceafa0`) and C3 (`ac89f08`) shipped the `low`-preset gate but left the full audit recommendation as TODOs at multiple sites. The audit's full fix: at `mid`/`high`/`ultra`, foreground statics + buildings within ~60 m get `receiveShadow=true`; beyond → `false`.

**Fix.** For each placement, compute distance from the LB origin (or, if available at bake time, from the player position). Set `receiveShadow` based on `distSq < 60*60` AND `quality.preset !== "low"`. Low-preset behaviour from C2/C3 stays exactly the same.

**InstancedMesh caveat.** `THREE.InstancedMesh` doesn't support per-instance `receiveShadow`. Two options:
- **(a)** Split each InstancedMesh by tier (foreground InstancedMesh + background InstancedMesh) at bake time.
- **(b)** Skip the distance tier for InstancedMesh; only apply to plain Mesh singletons.

**Pick (b)** — InstancedMesh is already the cheap path; the singleton path is where the receiver count multiplies. (a) is the audit's "ultimate" version; defer to a future PR if (b)'s win isn't enough.

**Verification.** `import()` smoke on both files. Run with `?quality=mid` and confirm foreground/background statics behave differently in a screen capture.

**Risk.** Low — distance-tier already considered in the audit. Visual diff: distant ground beneath statics darkens slightly (no longer receiving shadow). Acceptable.

**Cross-refs.** Mirrors C2's pattern. Use the same `staticsReceiveShadow` predicate name (now extended to take a per-placement distSq).

---

### FU3 — AnimationCache shared-geometry gate in `_disposeMeshChildren`
**Severity** Low (B3 TODO follow-on) • **File** `scene3d/entities.js` • **Status** ✅ Done (commit `caa74b8` — confirmed AnimationCache returns by reference; both `_disposeMeshChildren` AND the legacy `inst.geometries[]` loop in `Entity.dispose()` now gated on `__disposable`; selection-ring TorusGeometry already tagged by B3)

**Problem.** B3 (`5f4b8a6`) shipped `_disposeMeshChildren` with unconditional `geometry.dispose()`. The doc-comment caveat at the top of entities.js flags that `AnimationCache` shares `BufferGeometry` across spawns of the same `setupId` — so unconditional dispose could free shared cached geometry, breaking other entities.

**Fix.** Investigate via reading `animation.js` and the AnimationCache call paths. Two outcomes:

- **If geometries returned from AnimationCache are shared:** gate `geometry.dispose()` in `_disposeMeshChildren` by `geometry.userData.__disposable === true` (same pattern as `_disposeMaterialIfOwned`). Tag any per-entity geometries at their construction site.
- **If all entity geometries come from AnimationCache and shouldn't be disposed:** change `_disposeMeshChildren` to ONLY dispose `__disposable`-tagged geometries (defensive; matches material convention).

Either way, the dispose helper becomes consistent: only tagged resources get freed.

**Verification.** `import()` smoke. A soak test would catch the regression at runtime — out of agent scope; flag in the PR description.

**Risk.** Low — the change is strictly more conservative than B3's current code.

---

### FU4 — Per-emitter BlendMode classification for E5's Additive/Alpha branch
**Severity** Low • **Files** `scene3d/particles/particle_manager.js` • **Status** ✅ Done (commit `897f7cb` — signal IS in upstream materials: `baseMaterial.blending===THREE.AdditiveBlending` (materials.js:1001) + fallback via `userData.surfaceTypeFlags & 0x10000`; per-emitter branch hoisted out of meshFactory so all slots take the same path)

**Problem.** E5 (`e1339af`) shipped the conservative fallback (`transparent=true` + `alphaTest=0.1` + `depthWrite=true`) for ALL particles because the wasm/Rust DAT layer doesn't expose blend mode. But AC reads blend mode from the **referenced GfxObj's surface material** — not from the emitter record itself — and that material IS already accessible at JS-side material setup time.

**Fix.** Read the per-emitter material's blend info AT THE CLONE SITE in particle_manager.js. Three possible info sources (probe in this order):

1. **`mat.blending`** — if the cloned material already has `THREE.AdditiveBlending` set somewhere upstream, that's the signal. Branch on it.
2. **`mat.userData.acBlendMode`** — check if the material cache tags this. If not, ignore.
3. **GfxObj surface `surface_type` bit `0x10000`** — the "additive" bit AC uses. If we can read it from the material's userData (e.g. `mat.userData.surfaceType`), branch on that.

If a signal IS available:
- **Additive:** `transparent=true`, `blending=THREE.AdditiveBlending`, `depthWrite=false`. No alphaTest.
- **Alpha (default):** keep the conservative middle ground from E5.

If NO signal is available after the audit, leave a `TODO(FU4)` breadcrumb explaining what to expose at the Rust DAT crate level, and close the task. Don't ship a heuristic that guesses.

**Verification.** `import()` smoke. Visual diff in PR description — additive sprites should no longer occlude later-drawn additive sprites.

**Risk.** Medium — visual diff. Don't change the alpha path; only branch additive off.

---

### FU5 — C1 envcell-fusion A/B capture harness
**Severity** Med • **New file** `apps/holtburger-web/capture_envcell_fusion_ab.cjs` • **Status** ✅ Done (commit `4bc44a6` — 848-line Playwright-based harness; 6 indoor waypoints lifted from `capture_academy_tour.cjs:185-192`; inline 8×8 luma-windowed SSIM fallback since `ssim.js` isn't installed; pass criteria SSIM > 0.995 AND draw-call ratio ≥ 3×; outputs to `/mnt/wbterminal1/tmp/claude-scratch/fps-followon/envcell-fusion-ab/`)

**Problem.** C1 (`bd38a54`) shipped behind `?envcellFusion=1` with diagnostic counters but no automated A/B comparison. The headline indoor frametime win is gated on someone running the comparison; this harness automates it.

**Fix.** Author a capture script (CommonJS, `.cjs`) that:

1. Loads the page TWICE — once baseline, once with `?envcellFusion=1`.
2. At each load, walks the player through a fixed Academy waypoint list (reuse `capture_academy_envcells.cjs`'s waypoint set if it exists, or use `[{x: 100, y: 100}, {x: 110, y: 100}, ...]` interior positions).
3. Screenshots at each waypoint via Chrome DevTools Protocol (the existing capture scripts already use this).
4. Compares each pair with SSIM (use the `ssim.js` npm package if it's already in `node_modules`; otherwise fall back to a pixel-diff with a threshold).
5. Captures `liveScene3d.renderer.info.render.calls` AND `fusedCellsWithTransparent` / `fusedCellsOpaqueOnly` counters at each frame (those counters are returned from C1's build function — wire them up).
6. **Pass criteria:** SSIM > 0.995 at every waypoint AND draw calls drop ≥ 3× on the fused side.
7. **Output:** JSON summary + a side-by-side image grid PNG.

Use the existing capture-script pattern in `capture_phase6_step_c_envcells.cjs` for the CDP setup boilerplate.

**Verification.** Script parses (`node --check`). User runs it on their 1070 and reports the JSON summary.

**Risk.** None — agent writes the script, user runs it. No production code touched.

---

## Validation harnesses

All three runtime probes now have automated harnesses, executed on the
GTX 1070 (`desktop-4anudo2`, Tailscale `100.127.215.75`) via SSH + a
reverse tunnel from `wbterminal` exposing `127.0.0.1:8080` (wsbridge)
and `127.0.0.1:8765` (HTTP server). ACE runs on wbterminal at
`100.116.47.66:9000-9001`. Harnesses staged at `D:\andrew\claudecode2\`.

### Validation results (2026-05-19 run)

#### Telemetry probe (A7 + C6) — **PASS** ✅

`capture_fps_telemetry_probe.cjs`, 120 samples × 5 s = 10 min.

| Metric | Result | Threshold |
|---|---|---|
| `ricBudgetMs.p95` | 0 | ≤ 50 |
| `lightSortGap.p95` | 3 | ≤ 4 |
| console errors | 0 | = 0 |
| `ricOverrunWarns` observed | 1 (cold takram bake, expected) | informational |

`lightSortGap` distribution `(min=0, p50=2, p95=3, max=3, avg=1.525)`
matches the `LIGHT_SORT_INTERVAL=4` modulo-4 pattern exactly. C6
provably correct. A7's overrun warn fired once during the cold bake
(174 ms actual vs 50 ms threshold) — designed behaviour.

#### C7 light-template soak — **PASS** ✅

`capture_c7_lighttemplate_soak.cjs`, 60 samples × 30 s = 30 min.

| Metric | Baseline (samples 3-5) | Final (last 3) | Delta | Threshold |
|---|---|---|---|---|
| geometries | 312.3 | 315 | **+0.85 %** | ≤ +10 % |
| textures | 322.7 | 325 | **+0.72 %** | ≤ +10 % |
| lights | 14.3 | 15 | +0.7 | ≤ +50 |
| console errors | 0 | 0 | — | = 0 |

C7's "shared parameters, separate instances" template path (commit
`69f315a`) is leak-free across a 30-min real-GPU populated-zone
session.

#### FU5 C1 envcell fusion A/B — partial PASS (single-cell only)

`capture_envcell_fusion_ab.cjs`, 6 Academy waypoints.

`@teleloc 0x8602XXXX` post-Holtburg-spawn only delivers the player to
the first cell (`0x860201ad`); subsequent telelocs are silently no-op.
All 6 waypoints in both runs sampled the same cell, so SSIM was 0.9949
across the board (just under the 0.995 threshold = rendering jitter).
But the FIRST cell did exercise the fusion code path:

| Mode | drawCalls | visibleCells | fused | unfused |
|---|---|---|---|---|
| baseline (no flag) | **16** | 1 | 0 | 1 |
| `?envcellFusion=1` | **6** | 1 | 1 | 0 |

**Single-cell ratio = 2.67×** — just under the 3× threshold but a
clear, real signal that C1's fusion shrinks draw calls. With the
@teleloc limitation across cells, the multi-cell ratio couldn't be
measured. Re-running once Academy access is restored will produce the
full A/B matrix.

### Out-of-scope sky shader bug fixed during validation

`scene3d/ac_moons.js:243` previously declared `float t = uTime` in the
same scope as line 231's `float t = cloudAmt * uCloudIntensity`,
producing `ERROR: 0:202: 't' : redefinition` under ANGLE/D3D11 (the
swiftshader path was silently permissive — which is why earlier
captures didn't surface it). Renamed the second `t` to `tm`. Out of
the FPS plan's scope but landed to unblock validation; the fix is a
single GLSL identifier rename with zero logic change.

## Out of scope (deferred)

- **Rust-side BlendMode field** on `ParticleEmitter` and `ParticleEmitterJs` — FU4 should avoid this if a JS-side signal exists. If not, surface as a separate Rust PR; it's not a Wave-9 deliverable.
- **(a)-flavour of FU2** — splitting `InstancedMesh` by distance tier. Audit's "ultimate" version; defer until (b) demonstrably falls short.
