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

### Bug 3 — live particles draw NO pixels (OPEN)
After Bug 2 the particles are: live (347 static / 44 world `visible`), have **real materials** (zero
null-surface guards), and sit at **correct Holtburg world positions** (probe: ~`[32527, 102, -34604]`,
not flung off-world). Yet they render nothing — even the Life Stone (`0x020002EE`) cranked to 16×0.3 m
additive sparkles, perfectly framed, clear weather → no visible sparkle. Cause undetermined among:
billboard orientation / additive blend state / per-particle world scale / depth-test occlusion.

## To resume Bug 3
1. Bring up the stack: serve.py(8765) + wsbridge(8080) (nohup from `external/holtburger`); ACE via a
   `exec 3<>fifo; dotnet ACE.Server.dll <fifo` launcher (setsid-nohup) then `echo "world open" > fifo`;
   reverse tunnel `ssh -N -R 18765:127.0.0.1:8765 young@100.127.215.75`. DB creds `ace`/`ace`. ACE
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
