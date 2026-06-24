# Phase 3 Handoff — Visual-Behavior Suite (particle/aura bundle) — 2026-06-24

Current to HEAD `8fa4d49a` on `feat/tree-wind-sway-2026-06-23` (PUSHED). Supersedes the Phase-2
handoff (`docs/PHASE2-HANDOFF-2026-06-24.md`). Design doc:
`docs/visual-behavior-suite-design-2026-06-23.md` (§4.5 particle/aura catalog, §8 Phase 3, §9 item 9,
§5.3 cost classes). Repo-relative JS paths under `external/holtburger/apps/holtburger-web/`.

---

## 1. State of the world

The suite is a legacy-safe GPU-side visual-effects layer over AC objects. Phases 0, 1, and 2 are
**built, verified, committed, and pushed.** Phase 3 (particle/aura) is the next increment and is
**not started.**

| Phase | What | Status |
|---|---|---|
| **0** — substrate + tree-wind + classifier | `scene3d/vfx/{registry,frag_attach,frag_install,...}.js`, `vfx_catalog.js`, `lint_caps.js`, the C# classifier (`CommandEngine.Vfx.cs`), `getCachedVariant`, `?visual` flag family | ✅ DONE |
| **1** — emissive/material/frag bundle | 8 frag components (windBend/tarnish/wetness/frost/glint/magicGlow/enchantShimmer/flameFlicker) + itemAura | ✅ DONE |
| **2** — MECH-B deformation | `deformation.tipFlex` GPU vertex displacement at `#include <begin_vertex>`; one-program-per-combined-SET firewall; analytic normal-rotate | ✅ DONE + PUSHED `8fa4d49a`; **1070 real-GPU eye-test passed** (spear spawns with effect, ANGLE/NVIDIA, sway confirmed) |
| **3** — particle/aura | synthesized emitters: gem-sparkle, brazier embers+smoke, foliage pollen/fireflies/leaves, breath-fog | ⏳ **NEXT — this handoff** |
| 4 — texture/detail · 5 — classifier maturation | per §8 | later |

**Validated state (HEAD):** VFX harness all green (tipFlex 28/0, vertex_install 55/0, legacy-safety 18/0
[registry==TIER1, 11 components], flags 39/0, cost_model 62/0); full JS harness 39 pass / 6 fail (the 6
are pre-existing non-VFX). `dotnet build WorldBuilder.Terminal` 0 errors; `vfx gauge --ref holtburg`
STRUCTURAL-PASS. `pkg/` is gitignored.

---

## 2. THE KEY ENABLER — the particle render pipeline ALREADY EXISTS

Phase 3 does **not** build a particle engine. The full client particle pipeline is production-ready
(it renders the retail DAT `0x32` ParticleEmitter / CreateParticle effects and the Track-B 3D weapon
flame). Phase 3 = **SYNTHESIZE new emitters from a plain-JS POJO** (no DAT `0x32` replay) and attach
them to object parts, reusing this pipeline verbatim.

**The seam Phase 3 calls** — `scene3d/particles/particle_manager.js:469`:
```js
await particleManager.addEmitter({
  emitterInfo,          // a ParticleEmitterInfo OR a plain POJO (both accepted)
  parent,               // THREE.Object3D-ish {position, quaternion, partFrames?}
  partIndex = -1,       // -1/0xffffffff = root, or index into parent.partFrames
  parentOffset = null,  // {position, quaternion} static offset frame
  blocking = false,
});                     // -> Promise<emitterId>  (0 on failure)
```

**The `emitterInfo` POJO schema** (`scene3d/particles/particle_emitter_info.js:54-109`) — ~30 fields,
all camelCase, all that a synthesized emitter sets: `emitterType` (1=birthrate/sec, 2=/meter),
`particleType` (0-12 trajectory), `hwGfxObjId` (the sprite gfxobj), `birthrate`, `maxParticles`,
`initialParticles`, `totalParticles`/`totalSeconds` (0 = INFINITE → persistent ambient emitter),
`lifespan`(+`Rand`), `offsetDir`/`minOffset`/`maxOffset` (spawn volume), `a`/`b`/`c` (+min/max) velocity
& accel vectors, `startScale`/`finalScale`, `startTrans`/`finalTrans` (translucency), `sortingSphere`
(cull bound, auto from maxOffset+a·lifespan).

**Already in place — reuse, do not reinvent** (the §5.3 caps the design mandates):
- **RP6 off-screen + 220 m cull** — `particle_manager.js:117-131` (`_RP6.maxDistance=220`, recheck every
  6 ticks), `_rp6ShouldCull` `:310`; conservative frustum test on `sortingSphere`.
- **`maxParticlesPerEmitter` per quality preset** 64/256/1024/2048 — `quality.js` + enforced at
  `particle_emitter.js:164-196` (E6 cap, reads `window.liveScene3d.quality.flags.maxParticlesPerEmitter`,
  one-time warn/DID on cap).
- **PlayEffect FIFO** (24 emitter-groups, critical IDs exempt) — `play_effect_vfx.js:1102,1119`.
- **Owner-scoped lifecycle/teardown** — `scene3d/particles/owner_registry.js` (`ParticleOwnerRegistry`,
  `destroyAllForOwner("static:<lb>")`) → landblock-eviction teardown is FREE.
- **Part-frame anchoring** — `particle_emitter.js:129-148 _resolveAnchorFrame` (⚠ `parent.partFrames[i]`
  is WORLD-space; converted to `_scene`-local via `worldToLocal` — the 2026-06-20 fix; do NOT
  double-apply the worldRoot −π/2 X rotation).
- **Sprite material** — unlit billboard, additive-or-alpha decided from
  `baseMaterial.userData.surfaceTypeFlags & 0x10000` (Additive bit), `particle_manager.js:554-601`;
  null-surface guard → invisible (no white-box), `:23-46`.
- **The existing entity attach path** — `play_effect_vfx.js:1306-1505` already calls
  `addEmitter({parent: inst.root, partIndex, parentOffset, blocking})` for CreateParticle hooks
  (13/26). Phase-3 entity emitters reuse this exact attach.

**The factories** that turn a `hwGfxObjId` into geometry+material are wired at `entities.js:9019-9073`
(`geometryFactory` / `materialFactory` → `materialCache.getParticleUnlit`). A synthesized POJO that
names an existing sprite `hwGfxObjId` renders with **zero wasm rebuild**.

---

## 3. The substrate Phase 3 builds on (verified file:line)

- **registry.js — `mech:"particle"` is ALREADY valid.** `MECHS` has `"particle"` (`registry.js:35`);
  `FAMILY_ORDER.particle = 9` (`:25`, runs LAST). A particle component declares `mech:"particle"`,
  `channel:"emitter"`, `linkVariant(){return ""}` (no shader, like MECH-A windBend), `cacheKeyScope`
  (`set`|`none`), `deterministic:true`, `lightCountDelta:0`, `reads:["geometry","clock","weather"]`,
  `writes:["emitter"]`. It has **no `inject()`** (frag) and **no `buildClip()`** (MECH-A); instead an
  **`emit(ctx)`/`attach`** hook that returns emitter spec(s).
- **lint_caps.js — the `"emitter"` WRITE cap exists** (`ALLOWED_WRITES`, `lint_caps.js:32`
  "synthesized particle emitter"). `ALLOWED_READS` covers `geometry`/`clock`/`weather`. `FORBIDDEN_SOURCE`
  bans `Math.random`/argless `Date.now`/`.visible=`/wire/collision/per-instance cache key — a particle
  component seeds variety from `hash01`+clock, NEVER `Math.random`.
- **The MECH-A divert PRECEDENT (the pattern to mirror)** — `statics.js:1637-1652` peels windBend
  placements out of the frozen instanced path (`hasWindBend(vfxDescriptorFor(did))`) and
  `statics.js:1903-1905 attachWindTrees(scene3d, windTrees, wasmExports)` diverts them to the
  animated_scenery player. **Phase 3 adds the sibling `attachParticleEmitters(scene3d,
  particlePlacements, wasmExports)`** — peel particle placements, synthesize+attach emitters, register
  under owner key `static:<lb>`.
- **vfx_catalog.js `COMPONENT_MECH`** (`:40-49`) maps each component id → mech; add
  `"particle.<name>":"particle"`. `descriptorMechs(descriptor)` (`:130-140`) returns the mech Set;
  the statics/entities divert checks `descriptorMechs(d).has("particle")`.
- **components/index.js + `TIER1_COMPONENT_IDS`** — the legacy-safety audit asserts the live registry
  == this list EXACTLY (currently 11 ids). A new particle component MUST be added to BOTH the barrel
  export and the id array.
- **vfx_flags.js** — per-effect default-OFF flag pattern (`tipFlexEnabled` etc.) + `VFX_EFFECT_FLAGS`
  router; add `<effect>Enabled()` + the router entry.
- **Anchor-rig (reuse)** — `wind_rig.js partBBox (:59)` + `buildBboxRig (:113-137)` compute per-part
  bbox + pivot (centroid-XY, vertex-Zmin) + weight. The particle anchor-parts selector reuses this to
  pick the flame-bowl / canopy / head / gem part.
- **Gauge particle accounting** — `CommandEngine.Vfx.cs VfxGauge:361-397` sums per-unique-driver
  `DParticleEmitters` + `DCallsPerInstance`; cost_model.jsonl schema already has `dParticleEmitters` /
  `dCallsPerInstance` fields. **G2 (`:415-420`) currently asserts `drawcallsDelta==0`** — see §5.

---

## 4. Phase 3 work-list (ordered, each gated)

> Default-OFF behind a per-effect `?visual`-composed flag (e.g. `?gemSparkle`), byte-identical when off,
> integrate flag-OFF-safe locally, QUEUE the batched 1070 eye-test (emitter spawn, 220m cull, additive
> fill, flat program count are 1070-only). First slice = **`particle.gemSparkle`** (the minimal vertical
> slice, like tipFlex was for Phase 2): ONE persistent additive emitter, simplest anchor.

1. **P3.1 — particle mech contract + the install/attach path.** Add the `mech:"particle"` shape to the
   component contract (the `emit(ctx)→{emitterInfo POJO, partIndex, offset}[]` hook; NO shader). Build a
   sibling `scene3d/vfx/particle_attach.js` (mirror `frag_attach.js`): `particleEntriesForDescriptor` +
   `particlePlanForDid` filtering `mech==="particle"`, and an `attachParticleEmitters(scene3d, placements,
   wasmExports, ownerKey)` that calls `component.emit(ctx)` → `ParticleManager.addEmitter(...)` →
   registers under the owner key. Unit-test the plan + a stub emit (no THREE). `JS-ONLY`.
2. **P3.2 — shared billboard sprite palette.** Reuse EXISTING DAT particle sprite gfxobjs (additive
   soft-dot / spark / smoke / droplet / leaf) rather than authoring new ones — a `scene3d/vfx/particle_sprites.js`
   map `name→hwGfxObjId`, confirmed additive (`surfaceTypeFlags & 0x10000`). **DAT probe** (buildbox/VM,
   like the atlan-spear probe; cargo OOMs the laptop) to pick good sprite gfxobjs from the retail flame
   emitters (`0x3200026E`/`0x32000270` reference sprites) + confirm blend. `DAT-probe (VM)`.
3. **P3.3 — `particle.gemSparkle` component (FIRST slice).** A persistent standing emitter: 2-4 additive
   soft-dot sprites, `totalSeconds:0` (infinite), small spawn volume at the gem part (or root),
   `birthrate` low, `startScale/finalScale` shrink, deterministic phase from `hash01`. `reads:["geometry",
   "clock"]`, `writes:["emitter"]`. Register in `components/index.js` (+`TIER1_COMPONENT_IDS`),
   `COMPONENT_MECH`, and `vfx_flags.js` (`?gemSparkle`). `JS-ONLY`.
4. **P3.4 — wire the divert at BOTH seams.** statics (`statics.js` — peel particle placements next to the
   windTrees peel + call `attachParticleEmitters` next to `attachWindTrees`, owner `static:<lb>`) and
   entities (at spawn, if the descriptor has a particle mech, attach to `inst.root`+`partFrames` reusing
   the `play_effect_vfx` attach, owner per-guid). Gate `visualEnabled() && gemSparkleEnabled()`; off ⇒ no
   emitter ⇒ byte-identical. Owner-registry teardown on LB unload / entity despawn. `JS-ONLY`.
5. **P3.5 — gauge particle BUDGET + cost rows (the gauge change).** Add cost_model rows
   (`particle.gemSparkle`: `dParticleEmitters:1`, `dCallsPerInstance:1`, `costClass:"medium"`/cheap). **Turn
   G2 from `drawcallsDelta==0` into a particle-aware BUDGET** (e.g. `particleEmitters ≤ Kpe` and
   `drawcallsDelta ≤ particle budget`; keep `==0` for the NON-particle subset). Update
   `test_vfx_cost_model.mjs` (non-particle rows stay 0-calls; particle rows get their own bound). `dotnet-build`.
6. **P3.6 — brazier embers+smoke + the `vfx anchor-parts` selector.** TWO emitters anchored to the
   flame-bowl part. Add `vfx anchor-parts <SetupDID> [partRole]` to `CommandEngine.Vfx.cs` (reuse
   `buildBboxRig` to pick bowl/top/head/gem → partIndex) + a `brazier` archetype rule. The component
   anchors via the resolved `partIndex`. `JS + dotnet`.
7. **P3.7 — foliage (pollen/fireflies/leaves) + breath-fog + archetype rules.** foliage-ambient
   (sphere-spread motes; firefly=additive + DUSK gate; leaves=canopy-part emitter, flutter velocity,
   fade before ground), breath-fog (creature HEAD part via live entity `partFrames`, COLD-region gate).
   Add the classifier archetype rules (none exist yet) + day/weather/region visibility gates. `JS + dotnet`.
8. **P3.8 — gauge STRUCTURAL-PASS + 1070 eye-test.** `vfx gauge --ref holtburg` PASS with the particle
   budget; batched 1070 (recipe in §7): emitters spawn on the worked references, cull past 220 m, additive
   fill stays in budget (CPU-bound headroom), **program count FLAT** (particles add draw calls, NOT
   programs/relinks), `=off` byte-identical.

---

## 5. Constraints (do not violate)

- **The legacy-safe firewall.** A particle component READS only static/derived inputs (DAT geometry,
  weenie props, server-authoritative pose/part-frames, deterministic `hash01`) + the client wall-clock +
  derived weather/season; WRITES only a **synthesized client-local emitter** (`ALLOWED_WRITES "emitter"`)
  — additive billboard sprites the server neither stores nor replicates, with NO collision; NEVER the wire
  value, physics/collision, or replicated state. Deterministic (`hash01`+clock, **no `Math.random`**). No
  light-COUNT change. The emitter is purely cosmetic and client-local — it cannot desync (mirrors the
  tipFlex/setPose argument: the server never sees it).
- **Particle is MEDIUM cost = ADDITIVE OVERDRAW** (§5.3): the budget axis is **fill, not particle count**.
  Reuse the existing caps (RP6 220 m + frustum cull, `maxParticlesPerEmitter` 64-2048/quality, FIFO,
  owner-eviction). Persistent emitters use `totalSeconds:0`; teardown via the owner registry on
  unload/despawn — never leak.
- **Particles are the FIRST effect that adds DRAW CALLS.** Phases 0-2 were all `dCallsPerInstance:0`
  (G2 `==0`). P3.5 MUST update the gauge or G2 fails the instant a particle row has `dCallsPerInstance>0`.
  Budget by unique-driver emitter count + visible-instance cap, not placement count.
- **SYNTHESIZE, don't replay DAT `0x32`.** Phase 3 builds POJO `emitterInfo` (it MAY reference existing
  sprite gfxobjs). Do NOT entangle with the retail `play_effect_vfx` CreateParticle path.
- **DAT-hook coexistence (§9 #14).** Do NOT double-animate an object whose SetupModel already fires
  CreateParticle / has a `default_script` (the Track-B flame). If a DID already emits via DAT, the suite
  particle for it is redundant — gate it out (the classifier should skip `default_script`-bearing DIDs).
- **WB.Terminal/classifier work is Opus-4.8-only.**

## 6. Done-when

Particle mech contract + `emit`/attach path; the install-firewall test green; `particle.gemSparkle`
renders a persistent additive sparkle on a worked-reference gem (allowlist seed) at BOTH the statics and
entity seams; `brazier` embers+smoke anchor to the flame-bowl part via the new `vfx anchor-parts`
selector; `=off` byte-identical; harness green (legacy-safety registry==TIER1 incl. the new particle
component(s), new particle-install test, cost-model); `vfx gauge --ref holtburg` PASS with the particle
BUDGET (not `==0` calls); **1070 eye-test PASSED** (emitters spawn + cull at 220 m + flat program count +
additive fill within budget + off=byte-identical). Then foliage / breath-fog, then Phase 4 (texture/detail).

---

## 7. Gotchas carried forward

- **The particle pipeline EXISTS — reuse `ParticleManager.addEmitter`.** Don't rebuild emitters,
  culling, caps, or anchoring. The first slice (gemSparkle, POJO + an existing sprite gfxobj) is
  **JS-ONLY, no wasm rebuild** (the POJO bypasses `fetchParticleEmitter`; the geometry/material factories
  already fetch sprite gfxobjs).
- **`partFrames` are WORLD-space** → convert to scene-local (`_resolveAnchorFrame`, the 2026-06-20 fix).
  Anchoring an emitter to a part naively double-applies the worldRoot −π/2 X rotation.
- **`maxParticlesPerEmitter` reads `window.liveScene3d.quality.flags`** — but `liveScene3d` is
  **module-scoped, NOT on `window`** (confirmed this session on the 1070); the emitter reads it
  internally, but a 1070 probe can't. Use `window.__diag` surfaces for the eye-test, not `liveScene3d`.
- **The gauge G2 will FAIL the moment a particle cost row lands** unless P3.5 changes it from `==0` to a
  particle budget. Sequence P3.5 before committing any particle cost row.
- **Sprite sourcing / white-box.** Use existing additive DAT sprite gfxobjs; confirm the Additive bit
  (`surfaceTypeFlags & 0x10000`); the null-surface guard renders invisible (not a white box) — verify the
  chosen `hwGfxObjId` actually resolves a surface.
- **Entity vs static.** Statics → `attachParticleEmitters` divert (owner `static:<lb>`). Entities → reuse
  the `play_effect_vfx` attach to `inst.root`/`partFrames` (owner per-guid). Both teardown via the owner
  registry; don't leak persistent emitters on despawn/unload.
- **1070 eye-test recipe (established this session, evidence `~/from-vm/phase2-kit-2026-06-24/1070-eyetest/`):**
  on-box chromium-1223, `npm install playwright-core` in `C:\Temp` first;
  `chromium.launch({executablePath:"...chromium-1223\\chrome-win64\\chrome.exe", headless:true,
  args:["--use-angle=d3d11","--use-gl=angle","--ignore-gpu-blocklist"]})` (headless still gets real NVIDIA
  GPU). Login `?renderer=3d&quality=low&clouds=off&autoLogin=1&account=phase4demo&password=phase4demo&
  autoSpawn=first&server_host=127.0.0.1&server_port=9000&bridge_url=ws://100.116.47.66:8080/&visual=on&<flag>=on`
  (quality=low — ultra blocks entity spawn; bridge_url MANDATORY). phase4demo has GM →
  `__sessionHandle.sendChat('@create <wcid>')`. Gate on `__diag.render.sceneNodes>80` + settle. ~40 s ACE
  grace between runs. Reverse tunnel `-R 18765:127.0.0.1:8765`; serve.py + wsbridge + ACE run on the laptop.
- **Worked-reference DIDs (pick via DAT probe, like the atlan spear):** a magic gem/crystal item for
  gemSparkle (the Holtburg Life Stone seen on the 1070 is a candidate); a brazier SetupModel with a
  flame-bowl part for the embers; a foliage SetupModel; a creature for breath-fog. Probe geometry +
  weenie props on the VM (`crates/holtburger-dat/examples/`), not the laptop.
- **Reusable DAT walker** for sprite/geometry hunts: `crates/holtburger-dat/examples/` (DatDatabase opens
  portal.dat once; Setup→GfxObj→Surface; the flame emitters `0x3200026E`/`0x32000270` from the Track-B
  work are the place to read good additive sprite gfxobjs).
```
