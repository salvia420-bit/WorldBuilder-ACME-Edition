I have everything I need. Here is the implementation-ready build spec for my slice.

---

# Build Spec — Particle / Aura Slice (Visual-Behavior Suite)

**Slice owner:** synthesized client-only object-attached emitters (design doc §4.5 + §2.2 `particle.*` family). Archetypes 25–28 + the per-object aura effects (embers, dust, pollen/fireflies, leaves, splash, gem-sparkle, breath-fog, orbit-motes, drips).

**One-line thesis:** the entire emitter *runtime* is already shipped (`ParticleManager` / `ParticleEmitter` / `Particle`, the Sky-J P4 port). A synthesized emitter is **just a plain POJO fed to `ParticleManager.addEmitter()`** plus a **synthetic billboard gfxobj** that bypasses the DAT fetch. No new per-frame infrastructure is needed — we reuse RP6 cull, the E6 per-emitter cap, the A11-S4 degrade radius, and the owner-registry teardown.

---

## Goal

Spawn object-attached particle auras (`particle.embers`, `particle.dustMotes`, `particle.pollen`, `particle.leaves`, `particle.splash`, `particle.gemSparkle`, `particle.breathFog`, `particle.orbitMotes`, `particle.drip`) on classified DIDs **without any DAT `0x32` ParticleEmitterInfo record**. Deliverables:

1. A **`SynthEmitterInfo` POJO schema** that is field-compatible with `ParticleEmitterInfo`'s constructor so `new ParticleEmitterInfo(pojo)` consumes it directly (`particle_emitter_info.js:53–109`).
2. A **synthetic billboard gfxobj registry** (soft-dot / spark / smoke / droplet / leaf) that the `geometryFactory`/`materialFactory` resolve **without** `fetchBuildingPlacement`.
3. A **pure auto part-anchor selector** layered on `wind_rig.buildBboxRig` (`wind_rig.js:113`) that picks canopy / head / bowl / contact / tip / centroid part indices.
4. **Day / weather / region visibility gates** sampled at low cadence.
5. A **persistent-emitter cap + per-landblock eviction teardown**, reusing the existing caps + owner registry.

---

## Design

### A. The synthesized `SynthEmitterInfo` POJO schema

`ParticleEmitterInfo`'s constructor already accepts a plain POJO — the class comment says so explicitly ("*Either pass an object with the camelCase getters … OR pass a plain POJO with those same field names. Both work — tests use the POJO form*", `particle_emitter_info.js:43–52`), and it reads `wasmInfo.aX`, `wasmInfo.maxParticles`, etc. with `?? default` on every field (`:57–103`). So a synthesized emitter needs **no wasm round-trip** (`fetchParticleEmitter`) — we hand `addEmitter` an `emitterInfo` POJO and the manager does `new ParticleEmitterInfo(emitterInfo)` at `particle_manager.js:529–531`.

The schema mirrors the AC DAT `0x32` ParticleEmitterInfo field-for-field (Rust parse: `crates/holtburger-dat/src/file_type/particle_emitter.rs:1–105`; wasm getters: `src/lib.rs:42998–43066`), so a synthesized record is bit-for-bit substitutable for a baked one and uses the same runtime math (`GetRandomA/B/C/Offset/Lifespan/StartScale/FinalScale/StartTrans/FinalTrans`, `:122–251`).

```jsonc
// SynthEmitterInfo — the canonical synthesized-emitter POJO.
// Field names + semantics mirror AC 0x32 ParticleEmitterInfo exactly so
// `new ParticleEmitterInfo(this)` consumes it (particle_emitter_info.js:57-103).
{
  // ── identity ──────────────────────────────────────────────────────────
  "id":               0x7F000001,  // synthetic namespace (see §B); used only
                                   //   for E6 warn-dedupe + diag, never a DAT key
  "emitterType":      1,           // 1=BirthratePerSec  2=BirthratePerMeter
                                   //   (EmitterType, particle_emitter_info.js:32-36)
  "particleType":     2,           // ParticleType enum (particle.js:63-76):
                                   //   1 Still · 2 LocalVelocity · 3 ParabolicLVGA
                                   //   · 5 Swarm · 12 GlobalVelocity
  // ── geometry / surface (NO texture field on 0x32 — lives on the gfxobj) ─
  "gfxObjId":         0,           // software-path gfxobj; leave 0
  "hwGfxObjId":       0x7E000000,  // SYNTHETIC billboard id (§B). MUST be
                                   //   non-zero or setInfo() returns false
                                   //   (particle_emitter.js:159-161)
  // ── emission rate / counts ────────────────────────────────────────────
  "birthrate":        0.25,        // seconds between spawns (BirthratePerSec)
  "maxParticles":     16,          // concurrent cap; ALSO clamped by the quality
                                   //   preset at setInfo (particle_emitter.js:179-196)
  "initialParticles": 0,           // t=0 burst count (initEnd, particle_emitter.js:425-433)
  "totalParticles":   0,           // 0 + totalSeconds 0  ⇒ PERSISTENT emitter
  "totalSeconds":     0,           //   (never auto-stops; particle_emitter.js:312-313)
  "lifespan":         1.6,         // per-particle seconds
  "lifespanRand":     0.4,         // additive jitter ±  (getRandomLifespan :167-171)
  // ── spawn offset (a disc/sphere around the anchor) ────────────────────
  "offsetDirX": 0, "offsetDirY": 0, "offsetDirZ": 1, // projection axis (Z-up)
  "minOffset":  0.0, "maxOffset": 0.15,              // metres (getRandomOffset :185-212)
  // ── velocity basis vectors A,B,C (AC Z-up, metres/sec) ────────────────
  "aX": 0, "aY": 0, "aZ": 0.4, "minA": 0.7, "maxA": 1.0, // A = primary velocity
  "bX": 0, "bY": 0, "bZ": 0.0, "minB": 1.0, "maxB": 1.0, // B = secondary (swarm/parab)
  "cX": 0, "cY": 0, "cZ": 0.0, "minC": 1.0, "maxC": 1.0, // C = tertiary
  // ── scale + translucency ramps (start→final over lifespan) ────────────
  "scaleRand":  0.2, "startScale": 0.12, "finalScale": 0.04,
  "transRand":  0.1, "startTrans": 0.2,  "finalTrans": 1.0, // trans=1 ⇒ fully fade out
  // ── frame ─────────────────────────────────────────────────────────────
  "isParentLocal": true            // true ⇒ re-anchor to part frame every tick
                                   //   (particle_emitter.js:377-386); false ⇒ snapshot
}
```

`sortingSphere.radius` is **derived** by `initEnd()` (`= max(maxOffset, maxA·lifespan)`, `particle_emitter_info.js:111–120`) — the synth record never sets it, and RP6 uses it for frustum culling (`particle_manager.js:336`). Keep `maxA·lifespan` small (≤ a few metres) so the emitter culls tightly.

**Important fidelity notes baked into the schema:**
- `trans` is **translucency**, not opacity: `setTranslucency(mesh, t) ⇒ opacity = 1 − t` (`particle.js:100–101, :20`). So `startTrans 0.2 → finalTrans 1.0` means "start near-opaque, fade to invisible".
- The 5 per-spawn jitters are **additive** (`r·rand + value`, retail-correct, `:134–171`); a `*Rand` of `0` collapses to the authored value (zero jitter), so a synth record with all `*Rand=0` renders deterministic stamped clones.
- Particles are **NOT camera-billboarded by the port** — `particle.js:397` orients each slot mesh to `parent.quaternion ⊗ emitter-quat` (inherits the anchor frame). For round soft-dot sprites this is invisible; for smoke/leaf it is not. See §B for the opt-in billboard.

#### Effect preset table (the `particle.*` catalog → SynthEmitterInfo deltas)

Each preset is a frozen POJO factory `makeSynth(kind, cfg)`; only the listed fields differ from the defaults above. `anchorKind` (§C) + `gate` (§D) are carried as **non-`0x32`** sidecar fields the manager ignores but the attach wrapper reads.

| Archetype (`particle.*`) | gfxobj (§B) | particleType | emit rate / counts | velocity A / B / C | anchorKind | gate (§D) |
|---|---|---|---|---|---|---|
| `embers` (brazier) | spark (additive) | 2 LocalVelocity | birthrate 0.06, max 24 | A=+Z 0.5–0.9, +XY jitter via offset | `bowl` | region-indoor-OR-outdoor; always |
| `smoke` (brazier) | smoke (alpha) | 2 LocalVelocity | birthrate 0.3, max 10, lifespan 3.0 | A=+Z 0.25–0.4 | `bowl` (offset +Z above embers) | always |
| `dustMotes` (indoor) | soft-dot (alpha) | 1 Still | birthrate 0.5, max 12 | A≈0 (drift via B swarm 0.02) | `centroid` | region=indoor only |
| `pollen` / `fireflies` (foliage) | soft-dot (additive) | 5 Swarm | birthrate 0.4, max 16 | swarm B=0.6, C=0.3 | `canopy` | fireflies: dusk/night only |
| `leaves` (falling) | leaf (alpha) | 3 ParabolicLVGA | birthrate 1.2, max 8, lifespan 4 | A=down+lateral, B=flutter | `canopy` | season≠winter |
| `splash` / `mist` (water) | droplet / smoke | 3 ParabolicLVGA / 1 Still | audit-driven anchor | A=+Z then gravity | `contact` (audit override) | always |
| `gemSparkle` | spark (additive) | 1 Still | birthrate 0.5, max 4 | A≈0 | `centroid` | always |
| `breathFog` (creature) | smoke (alpha) | 2 LocalVelocity | birthrate 0.5, max 6 | A=+forward 0.3 | `head` | cold region OR temperature_C<2 |
| `orbitMotes` (enchant) | soft-dot (additive) | 5 Swarm | birthrate 0.6, max 6 | circular A/B | `centroid` | item has spell DIDs |
| `drip` (overhang) | droplet (alpha) | 3 ParabolicLVGA | birthrate 2.0, max 2 | A=−Z (gravity) | `contact` (top) | weather wet OR cave region |

> ParabolicLVGA "gravity" (particleType 3, `particle.js`) is the **particle's own render trajectory**, not object physics — it never touches the collision BSP. Legacy-safe (THE RULE, see below).

---

### B. Shared synthetic billboard gfxobjs

The real path resolves `hwGfxObjId → fetchBuildingPlacement → meshToGeometryGroups → {geometry, surfaceDid} → materialCache.getParticleUnlit(surfaceDid,…)` (`statics.js:3026–3073`, `materials.js:2637`). For synthesized emitters we **intercept by ID namespace before the wasm fetch**: real GfxObjs are `0x01xxxxxx`; we reserve **`0x7E000000–0x7E0000FF`** (never a real DAT key) for synthetic billboards.

New module **`scene3d/particles/synthetic_gfxobjs.js`**:

```js
import * as THREE from "three";

export const SYNTH_GFX = Object.freeze({
  SOFT_DOT: 0x7E000000,  // round radial alpha falloff — motes/pollen/sparkle
  SPARK:    0x7E000001,  // bright hot core, additive — embers/sparkle
  SMOKE:    0x7E000002,  // soft puff, alpha — smoke/breath/mist
  DROPLET:  0x7E000003,  // teardrop, alpha — splash/drip
  LEAF:     0x7E000004,  // leaf silhouette, alpha — falling leaves
});

export function isSyntheticGfxObj(id) {
  return ((id >>> 0) & 0xFFFFFF00) === 0x7E000000;
}

// ── ONE shared quad geometry across ALL synthetic particles ──────────────
// Unit quad in the part-local XY plane (AC Z-up: the quad faces +Z by
// default; particle.js orients it to the anchor frame). Shared + never
// disposed — like play_effect_vfx.js's _sharedGeometry pool (play_effect_vfx.js:480-494).
let _quad = null;
export function syntheticGeometry(/*id*/) {
  if (!_quad) _quad = new THREE.PlaneGeometry(1, 1); // sizing via mesh.scale
  return _quad;
}

// ── procedural canvas textures, one per kind, generated once ─────────────
const _texCache = new Map();
function _canvasTexture(id) {
  if (_texCache.has(id)) return _texCache.get(id);
  const S = 64, cv = (typeof document !== "undefined")
    ? document.createElement("canvas") : null;
  if (!cv) { _texCache.set(id, null); return null; } // SSR/test: no texture
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  switch (id) {
    case SYNTH_GFX.SOFT_DOT: {
      const g = ctx.createRadialGradient(S/2,S/2,0, S/2,S/2,S/2);
      g.addColorStop(0,"rgba(255,255,255,1)");
      g.addColorStop(0.5,"rgba(255,255,255,0.4)");
      g.addColorStop(1,"rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0,0,S,S); break;
    }
    case SYNTH_GFX.SPARK: {
      const g = ctx.createRadialGradient(S/2,S/2,0, S/2,S/2,S/2);
      g.addColorStop(0,"rgba(255,240,200,1)");
      g.addColorStop(0.25,"rgba(255,180,80,0.8)");
      g.addColorStop(1,"rgba(255,120,30,0)");
      ctx.fillStyle = g; ctx.fillRect(0,0,S,S); break;
    }
    case SYNTH_GFX.SMOKE:   /* soft low-contrast blob */
    case SYNTH_GFX.DROPLET: /* teardrop path */
    case SYNTH_GFX.LEAF:    /* leaf silhouette path */
    default: { /* …draw shape… */ }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData = { __cacheOwned: true }; // never disposed by emitter teardown
  _texCache.set(id, tex);
  return tex;
}

// Additive for SPARK/SOFT_DOT(firefly); alpha for SMOKE/DROPLET/LEAF.
const _ADDITIVE = new Set([SYNTH_GFX.SPARK, SYNTH_GFX.SOFT_DOT]);

export function syntheticMaterial(id) {
  const tex = _canvasTexture(id);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false,
    blending: _ADDITIVE.has(id) ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  // Mark for the manager's additive/alpha branch (particle_manager.js:553-564):
  // the per-slot CLONE inherits blending; surfaceTypeFlags is the fallback probe.
  mat.userData = { __cacheOwned: true,
    surfaceTypeFlags: _ADDITIVE.has(id) ? 0x10000 : 0 }; // 0x10000 = Additive
  mat.name = `synth-particle-0x${(id>>>0).toString(16)}`;
  return mat;
}
```

**Factory patch** (the only wiring): in `_ensureStaticParticleManager` (`statics.js:3057–3073`) and the entity twin (`entities.js:_ensureWorldParticleManager`, near `:5584`), prepend a synthetic check:

```js
geometryFactory: async (hwGfxObjId) => {
  if (isSyntheticGfxObj(hwGfxObjId)) return syntheticGeometry(hwGfxObjId);
  /* …existing resolveGfxObj path… */
},
materialFactory: async (hwGfxObjId) => {
  if (isSyntheticGfxObj(hwGfxObjId)) return syntheticMaterial(hwGfxObjId);
  /* …existing getParticleUnlit path… */
},
```

The manager already clones the material per slot, sets `__disposable`/`__cacheOwned=false` on the clone (`particle_manager.js:602–612`), and disposes clones on teardown (`:786–792, :828–834`) — synthetic clones ride that path **for free**. The shared geometry + canvas textures are tagged `__cacheOwned` so they survive emitter teardown (matching `_noSurfaceParticleMat`, `:33–46`).

**Optional camera-billboard** (default OFF, `?particleBillboard=on`): since `particle.js:397` does not face the camera, add a one-line `mesh.onBeforeRender = (r,s,cam)=> mesh.quaternion.copy(cam.quaternion)` set once in the synthetic `meshFactory` branch. Cost: one quaternion copy per *visible* synthetic particle per frame (capped at `maxParticles`, see §E). Round SOFT_DOT/SPARK don't need it; LEAF/SMOKE/DROPLET benefit.

---

### C. Auto part-anchor selector (reuse `wind_rig.buildBboxRig`)

`buildBboxRig(partBoxes, hingeFrames)` (`wind_rig.js:113–137`) already returns, per part, `{pivot:{x,y,z}, weight, rest}` in **model space** plus `modelH`, and internally computes per-part model boxes via `_modelBox` (`:78–91`) and the trunk-suppression test via `swayAmp` (`:98–105`). We add a **pure** selector beside it that reuses that exact math and returns part indices that map 1:1 to `partFrames[i]` (`setup_rig.js:167`, the SetupModel part order). New export in `wind_rig.js`:

```js
/**
 * Pick anchor part indices for synthesized particle emitters from the SAME
 * per-part model boxes buildBboxRig uses. Pure + deterministic (no THREE,
 * no clock). Returns indices into the SetupModel part order (== partFrames).
 * Any kind with no sensible part falls back to -1 (= ROOT / whole-object,
 * particle_emitter.js:130-131).
 */
export function selectAnchorParts(partBoxes, hingeFrames) {
  const n = partBoxes.length;
  if (n === 0) return { canopy:-1, head:-1, bowl:-1, contact:-1, tip:-1, centroid:-1 };
  const rests = /* same rest derivation as buildBboxRig :114-121 */;
  const mb = partBoxes.map((lb,p)=>_modelBox(lb, rests[p]));
  let minZ=Infinity, maxZ=-Infinity;
  for (const b of mb){ if(b.minZ<minZ)minZ=b.minZ; if(b.maxZ>maxZ)maxZ=b.maxZ; }
  const H = Math.max(maxZ-minZ, 1e-3);
  const footprint = b => (/*XY area of mb[p]*/ );
  const spanFrac  = b => (b.maxZ-b.minZ)/H;
  const isTrunk   = b => spanFrac(b) > 0.7;        // reuse swayAmp's test (:102-103)

  // canopy: highest part center, excluding the full-height trunk.
  let canopy=-1, canopyZ=-Infinity;
  for (let p=0;p<n;p++){ if(isTrunk(mb[p]))continue; if(mb[p].cz>canopyZ){canopyZ=mb[p].cz;canopy=p;} }

  // head: highest COMPACT part (small footprint, near-cubic) — creatures.
  let head=-1, headZ=-Infinity;
  for (let p=0;p<n;p++){ if(footprint(mb[p])>0.25*footprintMax) continue;
    if(mb[p].cz>headZ){headZ=mb[p].cz;head=p;} }

  // bowl: top rim of the part with the largest footprint (brazier bowl/cup).
  let bowl=-1, bowlA=-Infinity;
  for (let p=0;p<n;p++){ const a=footprint(mb[p]); if(a>bowlA){bowlA=a;bowl=p;} }

  // contact: lowest part base (planted foot / water contact / ground).
  let contact=-1, cZ=Infinity;
  for (let p=0;p<n;p++){ if(mb[p].minZ<cZ){cZ=mb[p].minZ;contact=p;} }

  // tip: most distal SMALL part (max |center − modelCenter|, low span).
  let tip=-1, tipD=-Infinity;
  for (let p=0;p<n;p++){ if(spanFrac(mb[p])>0.5)continue;
    const d=/*dist from model centroid*/; if(d>tipD){tipD=d;tip=p;} }

  return { canopy, head, bowl, contact, tip, centroid:-1 }; // centroid = ROOT
}
```

`bowl`/`splash` anchors additionally need a **+Z lift** above the rim (embers spawn above the coals, smoke above embers). That lift is the emitter's `parentOffset.position` (`addEmitter({parentOffset})`, `particle_manager.js:455–457`; applied at `particle.js:init`), computed as a fraction of the part's height — carried in the preset's `anchorOffset` sidecar field.

**Two consumption paths:**
- **Offline (preferred, design doc §6.2 `vfx anchor-parts <SetupDID>`):** the C# classifier ports this exact algorithm and bakes the chosen `partIndex` per archetype into `visual_descriptors.jsonl` (`config["particle.embers"].anchorPartIndex`). Runtime reads the integer — zero geometry work at attach.
- **Runtime fallback:** MECH-A archetypes already build per-part boxes for the shared mixer (`animated_scenery.js` / `tree_wind.js` via `partBBox`, `wind_rig.js:59`); when those boxes are in hand, call `selectAnchorParts` directly. Otherwise default to `-1` (ROOT anchor) — always safe (`particle_emitter.js:130–131`).

The returned index is passed straight through: `addEmitter({ emitterInfo, parent: rig, partIndex: anchorIdx, parentOffset })`. The manager resolves `parent.partFrames[partIndex]` in `_scene`-local space (`particle_emitter.js:129–148`), so a sway-animated tree's canopy anchor **follows the wind sway** because `partFrames` reads the live mixer pose (`setup_rig.js:185–190`).

---

### D. Day / weather / region visibility gates

Gates are **pure read-only predicates** over already-derived client state — never anything server-replicated. Sources in-tree:

| Gate | Source accessor (file:line) | Predicate |
|---|---|---|
| **weather: wet** | `weather_state.getWeatherState()` / `readWeatherFlags(out)` (`weather_state.js:225, :247`); class via `daygroup_weather.weatherForState` (`daygroup_weather.js:179`) | `is_storm || profile∈{light-rain,heavy-rain,foggy}` |
| **weather: cold/winter** | `getWeatherState().temperature_C`, `.season` (`weather_state.js:229,233`) | `temperature_C < 2 || season==='winter'` |
| **day/night (dusk gate)** | sun altitude via `skyState` + the moon-fade ramp pattern `ACMoons.moonBrightnessFactorFromSunAltitude(state)` (`ac_moons.js:361–372`) | `nightFrac > 0.5` (fireflies on at dusk/night) |
| **region: indoor** | the anchor's provenance — interior anchors come through `attachStaticDefaultScriptsWorld` (cell statics, `statics.js:3381`) vs outdoor `attachStaticDefaultScripts` (`:3288`); flag on `anchor.userData.isCellStaticScriptAnchor` (`:3418`) | dust motes indoor-only |

**Gate runtime** — a tiny registry ticked in the existing manager phase (`loop.js:1849–1878`, alongside `tickStaticParticles`), re-evaluated every ~30 frames (gates change on weather/time scale, not per-frame):

```js
// scene3d/particles/aura_gates.js
const _gated = new Map(); // emitterId → { manager, gateFn, lastOpen }
export function registerGatedEmitter(manager, id, gateFn) {
  _gated.set(id, { manager, gateFn, lastOpen: true });
}
export function tickAuraGates(/* every ~30 frames */) {
  for (const [id, g] of _gated) {
    const e = g.manager.particleTable.get(id);
    if (!e) { _gated.delete(id); continue; }           // already torn down
    const open = !!g.gateFn();                          // pure read
    if (open === g.lastOpen) continue;
    g.lastOpen = open;
    e.stopped = !open;   // CLOSE ⇒ stop emission, existing particles drain
                         // (particle_emitter.js:397-404); OPEN ⇒ resume.
  }
}
```

Closing a gate sets `emitter.stopped = true` (`particle_emitter.js:248`) — emission halts, live particles age out naturally, the emitter is **kept** (persistent emitters never auto-remove). Re-opening clears `stopped` and emission resumes next tick. This is the same flip the RP6 cull uses, so it composes cleanly (an off-screen *and* gated-closed emitter just stays drained). No reparent, no material churn, fully reversible — legacy-safe.

---

### E. Lifecycle: persistent-emitter cap + per-landblock eviction teardown

**Per-emitter particle cap (reused, no new code):** `setInfo()` clamps `maxParticles` to the quality preset's `maxParticlesPerEmitter` — **64 / 256 / 1024 / 2048** for low/mid/high/ultra (`quality.js:12,39,63,~85`), with a one-time per-DID warn (`particle_emitter.js:179–196`). Synth presets request 2–24, well under even `low`.

**Per-emitter distance/frustum cull (reused):** RP6 culls when the whole `sortingSphere` is outside the frustum or beyond **220 m** (`particle_manager.js:117–131, :310–390`); A11-S4 `?particleDegrade=retail` adds the authored radius (`:368–382`). Synth emitters get this automatically — but their `hwGfxObjId` is synthetic, so `fetch_particle_degrade_distance` returns null (stale-pkg soft-degrade, `:235`) ⇒ they fall back to the RP6 220 m superset, which is what we want.

**NEW: a global persistent-aura count cap.** The existing caps bound particles *per emitter* and cull *off-screen* emitters, but nothing bounds the *number of persistent aura emitters resident at once* across a dense ring. Add a soft cap mirroring `play_effect_vfx.js`'s `_MAX_ACTIVE_BURSTS`/`_enforceBurstCap` FIFO (`play_effect_vfx.js:593, :624–635`):

```js
// in the aura attach wrapper
const MAX_RESIDENT_AURAS = { low: 24, mid: 64, high: 160, ultra: 320 }[tier];
// before addEmitter: if residentAuraCount >= cap, skip the FARTHEST or
// LOWEST-priority pending aura (gem-sparkle/orbit are droppable; embers/
// breath are kept). Log the drop count (no silent truncation).
```

Sizing rationale (design doc §5.1): Holtburg radius-1 ref = **222 placements / 66 models**; only a fraction (braziers, foliage, fountains) carry auras, so a `high` cap of 160 covers the ref with headroom and keeps the suite under the 75%-GPU Dereth ceiling.

**Per-landblock eviction teardown.** Synth auras attach exactly like static default-scripts, so they reuse the owner-registry teardown (`owner_registry.js:302 destroyAllForOwner`), but with a **per-landblock owner key** instead of the per-anchor `static:<n>`:

```js
const ownerKey = `vfxaura:lb:${lbKey}`;          // one key per landblock
ownerRegistry.addEmitter(ownerKey, manager, req); // when particleOwnerOn()
// …else manager.addEmitter(req) and track id in a per-lb Set (legacy path)
```

Then hook the LRU's existing eviction callback (`LandblockLRU` exposes `onEvictLandblock`, `landblock_lru.js:67`; `evict()` at `:194`):

```js
new LandblockLRU({ …, onEvictLandblock: (lbKey) => {
  if (particleOwnerOn()) ownerRegistry.destroyAllForOwner(`vfxaura:lb:${lbKey}`);
  else for (const id of _auraIdsByLb.get(lbKey) ?? []) manager.destroyParticleEmitter(id);
  _auraIdsByLb.delete(lbKey);
}});
```

`destroyParticleEmitter` pulls every slot mesh from the scene and disposes the per-slot cloned materials (`particle_manager.js:806–836`); the shared synthetic geometry + textures are `__cacheOwned` and survive. The whole-table nuke `disposeStaticParticles` (`statics.js:3444–3481`) remains the scene-rebuild fallback. This closes the lifecycle: **attach on bake → cull off-screen → gate by weather/time → drain on gate-close → destroy on LB evict.**

---

## Integration seams (file:line)

| Seam | Where | Action |
|---|---|---|
| POJO → runtime | `particle_emitter_info.js:53–109` (`new ParticleEmitterInfo(pojo)`) | **none** — POJO is consumed as-is |
| spawn API | `particle_manager.js:469 addEmitter({emitterInfo,parent,partIndex,parentOffset,emitterId,blocking})` | call with synth POJO + anchor |
| synthetic gfxobj intercept | `statics.js:3057–3073` factories; `entities.js:~5584` twin | prepend `isSyntheticGfxObj` branch |
| additive/alpha branch | `particle_manager.js:553–564` (reads `blending` + `userData.surfaceTypeFlags & 0x10000`) | set both on synth material |
| anchor selector | `wind_rig.js:113 buildBboxRig`, `:78 _modelBox`, `:98 swayAmp`, `:59 partBBox` | add `selectAnchorParts` export |
| anchor frame resolve | `particle_emitter.js:129–148 _resolveAnchorFrame`; `setup_rig.js:167 createPartFramesProxy` | `partIndex` flows through |
| gate tick | `loop.js:1849–1878` manager phase (`tickStaticParticles`) | add `tickAuraGates()` |
| weather reads | `weather_state.js:225,247`; `daygroup_weather.js:179` | pure-read gate predicates |
| day/night read | `ac_moons.js:361–372` sun-altitude ramp | dusk/night predicate |
| per-emitter cap | `particle_emitter.js:179–196`; `quality.js:12,39,63,~85` | **reused** |
| RP6/degrade cull | `particle_manager.js:117–131,310–390` | **reused** |
| resident-aura FIFO cap | new; pattern from `play_effect_vfx.js:593,624–635` | add |
| owner teardown | `owner_registry.js:302 destroyAllForOwner`; flag `particleOwnerOn()` | per-lb key |
| LB eviction hook | `landblock_lru.js:67 onEvictLandblock`, `:194 evict()` | wire teardown |
| scene-rebuild nuke | `statics.js:3444 disposeStaticParticles` | **reused** |

---

## Edge cases & legacy-safety check (THE RULE)

**READS** (all static/derived + client wall-clock, per THE RULE):
- DAT geometry only — per-part bbox (`wind_rig.partBBox`), the synthetic gfxobj is wholly client-authored (canvas).
- Server-authoritative anchor pose via `parent.position`/`partFrames[i]` (`setup_rig.js:185–190`) — read-only.
- Weather/season/temperature/sun-altitude are **client-derived** scene state (`weather_state.js`, `ac_moons.js`), not server-replicated wire fields.
- Wall-clock via `currentTime()` (`particles/time_rng.js`) + seeded `rng` — Math.random-free, deterministic.

**WRITES** (only render-time, server neither stores nor replicates):
- New `THREE.Mesh` particle slots added to `staticsGroup`/`entitiesGroup` (render-only children); per-slot **cloned** `MeshBasicMaterial` uniforms (opacity/scale).
- `emitter.stopped` flag — pure client emission gate.
- **Never** touches the wire value, physics/collision BSP, or any replicated transform. Particles are visual-only meshes the collision system never sees (same guarantee as tree-wind's non-rendered template, design doc §1.2 proof).

**Specific corollary checks:**
- **Gravity/collision OUT:** ParabolicLVGA (particleType 3) is the *particle's* render parabola in `particle.js`, not rigid-body dynamics; it reads no collision state and writes none. ✅
- **Light count unchanged:** particles add **zero** lights (additive billboards, not THREE.Lights). No MeshStandard relink. ✅
- **No per-instance `customProgramCacheKey`:** all synth particles share **one** `MeshBasicMaterial` per gfxobj-kind; the per-slot `.clone()` keeps the same program-cache key (color/opacity are uniforms, blending is render-state — confirmed by the play-effect pool reasoning, `play_effect_vfx.js:523–533`). No shader-link explosion. ✅

**Edge cases handled:**
- `hwGfxObjId === 0` → `setInfo` returns false, emitter discarded (`particle_emitter.js:159–161`) — synth always sets non-zero.
- Surface-less / null material → shared invisible material, no white box (`particle_manager.js:33–46, :620–624`).
- SSR / Node test (no `document`) → `_canvasTexture` returns null → invisible material; geometry still builds. Bake/classify runs headless.
- Gate closes mid-life → particles drain, emitter retained; reopen resumes (no leak, `aura_gates`).
- Anchor part index out of range / `0xFFFFFFFF` → root fallback (`particle_emitter.js:130–131, :386`).
- DAT-hook coexistence (slice 14): only attach a synth aura when the DID's SetupModel does **not** already fire a `0x32` chain (`defaultScriptId === 0`, the same filter `statics.js:3299–3301` uses) — never double-emit.
- Async liveness: `addEmitter` snapshots `parentOffset` by value before any await (`particle_manager.js:495–513`) — safe to reuse the scratch frame.

---

## GPU cost

Cost class **cheap–medium** (design doc §5.3). The synth particle is an **additive/alpha textured quad** — its cost is **overdraw (fill-rate)**, not draw calls or ALU (`MeshBasicMaterial`, no lighting). Per design doc §5.2 step 3: "*measure fill, not particle count*".

- **Per visible particle:** 2 triangles, 1 texture fetch, additive/alpha blend. Negligible ALU.
- **Per emitter steady-state:** CPU = `updateParticles()` walk over ≤ `maxParticles` slots (`particle_emitter.js:370–407`), only when on-screen (RP6 skips off-screen, `particle_manager.js:705–763`). Synth presets cap at 2–24 particles.
- **Fill budget:** N visible emitters × maxParticles × quad-pixel-coverage. Additive overdraw is the watch item. At the Holtburg ref (≤ ~30 aura-bearing placements in radius-1, most braziers/foliage), with `high` cap 160 resident and per-emitter ~16, worst-case ≈ a few thousand small additive quads — comfortably within the GPU's 30–50 % idle slice on the 1070. `vfx gauge --ref holtburg` (design doc §6.2) is the pass/fail gate; hard target < 75 % GPU at full Dereth.
- **Memory:** ONE shared `PlaneGeometry` + 5 canvas textures (64×64 RGBA ≈ 16 KB each) for the **entire** suite — flat, independent of placement count.
- **Billboard option** adds 1 quaternion-copy per visible particle per frame (CPU, capped by `maxParticles`) — default OFF.

Concurrency caps enforced: per-emitter `maxParticlesPerEmitter` (quality), 220 m + frustum RP6 cull, resident-aura FIFO cap, per-LB eviction. No silent truncation — log resident-cap drops.

---

## Build checklist

1. **`scene3d/particles/synthetic_gfxobjs.js`** — `SYNTH_GFX` enum, `isSyntheticGfxObj`, `syntheticGeometry` (shared quad), `_canvasTexture` (5 procedural textures), `syntheticMaterial` (additive/alpha + `surfaceTypeFlags`, `__cacheOwned`). Mirror the pool/tag conventions at `particle_manager.js:33–46` and `play_effect_vfx.js:480–494`.
2. **Patch `geometryFactory`/`materialFactory`** to prepend `isSyntheticGfxObj` branches: `statics.js:3057–3073` and the entity twin `entities.js:~5584` (`_ensureWorldParticleManager`).
3. **`wind_rig.js`** — add `export function selectAnchorParts(partBoxes, hingeFrames)` reusing `_modelBox` (`:78`), `swayAmp`'s trunk test (`:102–103`), `partBBox` (`:59`). Pure, no THREE/clock. Unit-test against the tree allowlist DIDs (canopy ≠ trunk).
4. **`scene3d/particles/aura_presets.js`** — `makeSynth(kind, cfg)` returning the §A POJO per the preset table, with sidecar `anchorKind` / `anchorOffset` / `gate` fields the manager ignores.
5. **`scene3d/particles/aura_attach.js`** — `attachAuraChain(scene3d, anchor, descriptor, wasmExports, lbKey)`: skip if `defaultScriptId !== 0` (DAT-hook coexistence); resolve `partIndex` from baked `anchorPartIndex` or runtime `selectAnchorParts`; build `parentOffset` from `anchorOffset`; enforce resident-aura FIFO cap (log drops); `addEmitter` via `ownerRegistry.addEmitter('vfxaura:lb:'+lbKey, manager, req)` when `particleOwnerOn()`, else `manager.addEmitter` + track id in `_auraIdsByLb`.
6. **`scene3d/particles/aura_gates.js`** — `registerGatedEmitter` + `tickAuraGates` (sets `emitter.stopped`), with the weather/day/region predicates reading `weather_state.js:225,247`, `daygroup_weather.js:179`, `ac_moons.js:361–372`, `anchor.userData.isCellStaticScriptAnchor`.
7. **Wire `tickAuraGates()`** into the manager phase at `loop.js:1849–1878` (every ~30 frames, after `tickStaticParticles`).
8. **Wire per-LB teardown** into `LandblockLRU`'s `onEvictLandblock` (`landblock_lru.js:67`): `destroyAllForOwner('vfxaura:lb:'+lbKey)` (or the legacy per-id Set drain).
9. **Flags** (design doc §6.3 `?visual=` family, memoized like `tree_wind.js:15–56`): `?particleAuras=on|off` master gate; `?particleBillboard=on`; per-effect `?embers=on` … defaulting OFF → batched 1070 eye-test → default-ON with `=off` escape.
10. **Tests** (extend `test_play_effect_resolver.mjs`'s recording-manager pattern, `:188–209`): (a) synth POJO → `ParticleEmitterInfo` round-trips every field; (b) `isSyntheticGfxObj` namespace; (c) `selectAnchorParts` picks canopy≠trunk on a tree, bowl on a wide-base, head on a creature; (d) gate-close sets `stopped`, gate-open clears; (e) `destroyAllForOwner('vfxaura:lb:…')` frees all of an LB's auras and disposes per-slot clones.
11. **`vfx gauge --ref holtburg`** (design doc §6.2): A/B auras-off vs auras-on on the 222-placement ref; assert < 75 % GPU at full Dereth; record per-effect fill delta. Exit bar: green gauge + bare-default loads with 0 errors.
