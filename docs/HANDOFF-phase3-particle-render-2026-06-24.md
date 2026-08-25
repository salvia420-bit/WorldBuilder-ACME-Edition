# Handoff — Phase 3 particle/aura: runtime render debug (2026-06-24)

**Phase 3 (particle/aura bundle) of the Visual-Behavior Suite** is implemented, green, and **shipped
DEFAULT-ON** to `origin/master` (salvia420-bit) — `f3942a95` (suite default-on) on top of the 8-commit
Phase-3 series. This handoff covers the **1070 eye-test of the shipped suite**, which found the runtime
particles attach + are counted but **don't render visible pixels**. Two bugs fixed, one open.

## The chain: handle ✓ → tick ✓ → draw ✗

### Bug 1 — diag handle (FIXED, pushed `20e2f165`)
`window.__diag.particles()` read `liveScene3dRef`, but `_staticParticleManager` is on
`scene3dForBuilders` (a different facade) → `staticEmitters` falsely read 0. Now reads the canonical object.

### Bug 2 — static manager never ticked (FIXED, this commit)
The self-managed rAF tick driver in `statics.js` read `window.liveScene3d._staticParticleManager`, but
that manager is stamped on `scene3dForBuilders` — a DIFFERENT object than the `window.liveScene3d` facade
(`index.js:2490` builds the facade, `:2925` assigns it to window). So the handle was always `undefined`
and `tick()` never ran → **every static particle (lifestone gemSparkle, tree foliage, AND retail
`default_script` statics) sat at `visible:0`** — 100% inert. Entity particles ticked (via the main loop)
so they advanced. Fix: `statics.js` keeps a module-level `_staticParticleMgrRef` set in
`_ensureStaticParticleManager`; the self-rAF + `tickStaticParticles` tick it, decoupled from the facade.
**Verified on the 1070: static `visible` 0 → 347** (world 25→44).

### Bug 3 — live particles draw NO pixels (ROOT-CAUSED + FIXED + ✅ 1070-VALIDATED 2026-06-25)

> **1070 eye-test PASS (headless full-chrome, real `ANGLE NVIDIA GeForce GTX 1070 D3D11`).** A/B over the
> 869 synthesized billboard emitters via `__diag.probeBillboardParticles()` (face-angle vs direction-to-
> camera-POSITION): **billboard ON → faceAngleDeg min/median/max = 0/0/0** (every sprite quad faces the
> camera); **`?particleBillboard=off` → 1.5/35.9/43.3** (fixed orientations, scattered toward edge-on).
> Material confirmed additive (`blending:2`, `depthWrite:false`, `hasMap`). Screenshot `billboard-off`
> framed at a foliage cluster shows the bug literally — a field of **edge-on white slivers**; billboard-ON
> the cluster resolves + the Holtburg Life Stone glows. Runner/artifacts: laptop
> `…/scratchpad/phase3-billboard-eyetest.mjs`, 1070 `C:\Temp\phase3bb\{billboard-on,billboard-off}\`.
>
> **TWO follow-ups surfaced by the eye-test (NOT regressions):**
> 1. **gemSparkle isn't attaching to the Life Stone** `0x020002EE` — 0 emitters use sparkleStar
>    `0x010010F9` in-world (the 869 billboard emitters are foliage softGlowDot `0x01001062`). A descriptor/
>    classification/DID-match gap, ORTHOGONAL to the billboard fix (which was validated via the foliage
>    emitters — same engine path). The Life Stone's blue glow visible in-world is magicGlow (fragment), not
>    the gemSparkle twinkle. Investigate why `vfxDescriptorFor(0x020002EE)`→gemSparkle yields no emitter.
> 2. **Retail `default_script` 0x32 flat-sprite emitters** (torch/brazier flames) stay non-billboarded
>    (the remaining slivers) — by design (retail-faithful; acclient has no face-camera path), but they ARE
>    edge-on from some azimuths. Whether to billboard retail flat sprites too is a separate fidelity call.

**GENERALIZED FIX (2026-06-25):** the flat-quad+no-billboard cause is NOT gemSparkle-specific — EVERY
synthesized sprite component (foliage pollen/fireflies/leaves, brazier embers/smoke, breathFog) renders a
flat quad and was edge-on-prone. So billboard is now defaulted for the whole synthesized family at the
attach seam: `particle_attach.js` sets `emitterInfo.billboard = true` when undefined (a component can opt
out with `:false`). gemSparkle's explicit `billboard:true` is redundant-but-kept. Retail 0x32 replay uses
a different path (CallPES/static-script → `addEmitter` with a wasm ParticleEmitterJs that has no
`billboard` field) so it stays `false` = retail-faithful. Diagnostics added: `__diag.probeNearestParticle`
+ `__diag.probeBillboardParticles` (index.js). `?particleBillboard=off` is the engine kill/A-B escape.

#### Original code-side analysis (pre-1070):
After Bug 2 the particles are: live (347 static / 44 world `visible`), have **real materials** (zero
null-surface guards), and sit at **correct Holtburg world positions** (probe: ~`[32527, 102, -34604]`,
not flung off-world). Yet they render nothing — even the Life Stone (`0x020002EE`) cranked to 16×0.3 m
additive sparkles, perfectly framed, clear weather → no visible sparkle.

**ROOT CAUSE (DAT + decomp + code, 2026-06-24): flat quad + no billboard = edge-on.** Every particle
sprite GfxObj is a FLAT planar quad — DAT obj-export of `sparkleStar 0x010010F9` = 0.294 × 0.294 m with
a **zero-span (degenerate) Y axis** (`softGlowDot` same; `flameCore 0x01000FF4` = 1.1 × 1.1 m, also flat).
`Still`/`LocalVelocity` particles **never set the mesh quaternion** (particle.js leaves it identity), so
the quad keeps a *fixed* world orientation (worldRoot −π/2 X only). A fixed flat quad is **edge-on (≈0
projected pixels) from perpendicular camera azimuths** → invisible even when correctly sized/positioned.
Retail doesn't billboard either (no face-camera path in acclient — grep-confirmed), but our SYNTHESIZED
gemSparkle is explicitly designed as a *billboard* (its own header) and needs camera-facing to be seen.
The handoff's original NDC-only probe would have **missed this** (center projects on-screen, scale
non-zero → it would have falsely blamed blend); the enhanced probe now reports `faceAngleDeg`.

**Contributing cause: scale-as-multiplier confusion.** `mesh.scale.setScalar(startScale)` makes
`startScale` a *unitless multiplier* on the ~0.29 m native quad, NOT metres. gemSparkle's `0.06`/`0.012`
("metres" in the comments) both **clamp UP to the 0.1 floor** in `getRandomStartScale`/`FinalScale`
(`[0.1,10]`, particle_emitter_info.js) → a constant ~2.9 cm dot with the shrink-fade dead.

**FIX (4 files, JS-only, node-validated — `test_particle_billboard.mjs` 8/8 against the real
ParticleManager; existing particle harnesses still green):**
1. `particles/particle_emitter_info.js` — new opt-in `billboard` field (default false = retail-faithful;
   wasm ParticleEmitterJs has no such getter → DAT-replay byte-unchanged).
2. `particles/particle_manager.js` — `tick()` faces every live part of a `billboard:true` emitter at the
   camera after `updateParticles()` (aligns the quad's local face-normal to the part→camera dir in parent
   space; roll free; DoubleSide so normal sign is moot). `?particleBillboard=off` A/B escape.
3. `vfx/components/gemSparkle.js` — `billboard:true`; `startScale 0.45`/`finalScale 0.15` (clears the 0.1
   clamp, ~0.13 m → 0.044 m with a real shrink); corrected the "metres" comments.
4. `index.js` — `window.__diag.probeNearestParticle()` (NDC/onScreen + decomposed worldScale +
   **`faceAngleDeg` edge-on detector** + material blend/opacity/depth/colorWrite/hasMap).

**Still owed: the BATCHED 1070 eye-test** (per the batched-eye-test rule — not run piecemeal here). Bare
default `?gemSparkle` at the Holtburg lifestone (`0x020002EE`) should now sparkle visibly from ANY angle;
`?particleBillboard=off` should make it invisible from the edge-on azimuth (proves the cause). If a
residual remains after billboard, run `__diag.probeNearestParticle()` and read the verdict table below.

## To resume Bug 3
1. Bring up the stack: serve.py(8765) + wsbridge(8080) (nohup from `external/holtburger`); ACE via a
   `exec 3<>fifo; dotnet ACE.Server.dll <fifo` launcher (setsid-nohup) then `echo "world open" > fifo`;
   reverse tunnel `ssh -N -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip>`. DB creds `ace`/`ace`. ACE
   first-login races — the driver needs a login retry.
2. The diagnostic (was wired, reverted from the committed tree to keep it clean): add a
   `window.__diag.probeNearestParticle()` to the `__diag.particles` bridge that returns, for the visible
   particle nearest the camera (`scene3dForBuilders.cameraSwitcher.activeCamera`): NDC + `onScreen`,
   decomposed `worldScale`, and the material `{blending, opacity, depthTest, depthWrite, colorWrite,
   hasMap}`. (THREE is imported in index.js; blending enum 2=Additive, 5=Custom.)
3. Read the verdict: `onScreen:true` + non-zero scale but invisible → blend/opacity; off-screen →
   anchor; tiny scale → the per-particle scale (particle.js `mesh.scale.setScalar`). Then fix + confirm
   the Life Stone visibly sparkles (use STATIC targets — `@create`'d item *meshes* don't render in this
   setup, the known katar issue; only their nameplates show).

## Notes
- Eye-test driver: `~/from-vm/.../scratchpad/phase3-1070b.mjs` / `phase3-verify-fix.mjs`. Recipe:
  `~/from-vm/phase3-workflow-2026-06-24/PHASE3-EYETEST-RECIPE.md`.
- Eye-test catalog cranks (`0x02000179`, `0x020002EE`) are temp edits in `dist/vfx/visual_descriptors.jsonl`
  (`dist` → /mnt/wbterminal2/holtburger-dist, NOT git) — harmless, revert if desired.
- Material path: `materials.js getParticleUnlit` (AdditiveBlending / CustomBlending, depthWrite off).
- Suite is default-on (`?visual=off` master kill); Bug 3 only affects whether the cosmetic particles are
  visible — it does not break the world (off=byte-identical still holds).
