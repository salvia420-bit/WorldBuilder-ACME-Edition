# P5 — Sky integration plan (2026-05-12)

Drafted while P4 (JS particle runtime port) is in flight. P5 wires
the ported runtime into `sky_dome.js` so the moon's 3 crimson-star
particles (and any weather-DayGroup particles) actually render.

## Existing skip sites to remove

Two SetupModel skips, both intentional placeholders:

**1. `sky_dome.js:473-475`** — in `populateCelestialBodies()`:
```js
if ((skyObjectId >>> 24) === 0x02) {
  skippedSetupModel += 1;
  continue;  // <-- replace with PhysicsScript chain walk
}
```

**2. `sky_dome.js:648`** — in `tick()`:
```js
if ((skyObjectId >>> 24) === 0x02) {
  continue;  // <-- replace with ParticleManager.tickEmittersFor(skyObjectId)
}
```

## Schema gap to fix first

`crates/holtburger-world/src/sky.rs::SkyObjectSnapshot` exposes
`gfx_object_id` but **not `default_pes_object_id`**. The
PhysicsScript DID is in `SkyObject.default_pes_object_id`
(holtburger-dat::file_type::region::SkyObject) but not plumbed to JS.

**P5 prerequisite:** add `pes_object_id: u32` to `SkyObjectSnapshot`,
write it from `region.rs::SkyObject.default_pes_object_id` in
`evaluate_sky_object`, and expose it as a wasm getter (named
`pesObjectId`).

## Integration sketch

```js
// scene3d/sky_dome.js — at SkyDome construction
import { ParticleManager, ParticleType } from "./particles/index.js";

constructor(...) {
  // ... existing ...
  this.particleManager = new ParticleManager({
    scene: this.skyCell,  // particles parented to camera-anchored cell
    materialFactory: async (hwGfxObjId) => {
      // P5 fetches the GfxObj's surfaces, picks one (single-surface for
      // particle quads), pulls the material from MaterialCache.
      // Material already has AdditiveBlending if surface_type bit
      // 0x10000 is set (materials.js:169) — moon's 0x08000040 has it.
      const bake = await fetchBuildingPlacement(hwGfxObjId);
      const surfaceDid = bake.parts[0]?.groups[0]?.surfaceDid;
      return this.materialCache.get(surfaceDid);
    },
    geometryFactory: async (hwGfxObjId) => {
      // Particle billboards are typically single-quad GfxObjs (e.g.
      // 0x01001A62 = 1 part, 1 poly, 4 verts). Pull via the same
      // fetchBuildingPlacement path.
      const bake = await fetchBuildingPlacement(hwGfxObjId);
      return bake.parts[0]?.groups[0]?.geometry;
    },
  });
  this._particleChainsAttached = new Set();  // dedup
}

// scene3d/sky_dome.js — replacing the populateCelestialBodies skip
for (const [skyObjectId, bake] of skyAssets) {
  if ((skyObjectId >>> 24) === 0x02) {
    // SetupModel sky object — physics-script anchor. Walk its
    // PhysicsScript chain to spawn particles.
    await this._attachParticleChain(skyObjectId, bake);
    continue;
  }
  // ... existing GfxObj rotator-based path ...
}

async _attachParticleChain(setupModelId, bake) {
  // Find the SkyObject's pesObjectId via the state snapshot. The state
  // walker doesn't run until tick(); we either:
  //  (a) Have populateCelestialBodies take a `skyObjectStates` arg
  //      with the pesObjectId already plumbed, OR
  //  (b) Defer chain-attach to the first tick where states are
  //      available.
  // Option (b) is cleaner — sky_dome.js:642 already reads
  // session.getSkyObjectStates() per tick.
  // ... defer ...
}

// scene3d/sky_dome.js — in tick(), replacing the 0x02 skip
for (let i = 0; i < states.length; i += 1) {
  const s = states[i];
  const skyObjectId = (s.gfxObjectId >>> 0);
  if ((skyObjectId >>> 24) === 0x02) {
    const pesId = s.pesObjectId >>> 0;
    if (pesId !== 0 && !this._particleChainsAttached.has(skyObjectId)) {
      this._particleChainsAttached.add(skyObjectId);
      this._attachParticleChainFromState(skyObjectId, s);  // fire-and-forget
    }
    // Visibility flag drives whether the emitter is allowed to
    // spawn / advance. Pass through to ParticleManager:
    this.particleManager.setEmitterVisibilityForSkyObject(
      skyObjectId, s.visible
    );
    continue;
  }
  // ... existing per-tick pose updates for 0x01 GfxObjs ...
}

// after the for loop, before tick() returns:
this.particleManager.tick();

// scene3d/sky_dome.js — chain walk (async, runs once per skyObjectId)
async _attachParticleChainFromState(skyObjectId, state) {
  const pesId = state.pesObjectId >>> 0;
  const ps = await fetchPhysicsScript(pesId);
  const entries = ps.takeEntries();
  for (const e of entries) {
    if (e.hookType !== 13 && e.hookType !== 26) continue;
    const emitterId = e.createParticleEmitterId;
    if (emitterId === 0) continue;
    const emitterInfo = await fetchParticleEmitter(emitterId);
    // SkyObject SetupModel position becomes the emitter parent. Need
    // to compute the SetupModel's sky-cell position from skyObject's
    // current state — for retail moon at t=0.10 (when visible),
    // distance ~2700 from camera. P5 figures out exact placement via
    // the SkyObjectSnapshot's pose fields.
    await this.particleManager.addEmitter({
      emitterInfo,
      parent: this._skyObjectPosition(skyObjectId, state),
      partIndex: e.createParticlePartIndex,  // 0xFFFFFFFF for whole-object
      parentOffset: {
        position: new THREE.Vector3(
          e.createParticleOffsetX,
          e.createParticleOffsetY,
          e.createParticleOffsetZ,
        ),
        quaternion: new THREE.Quaternion(
          e.createParticleOffsetQX,
          e.createParticleOffsetQY,
          e.createParticleOffsetQZ,
          e.createParticleOffsetQW,
        ),
      },
      tag: skyObjectId,  // for visibility toggling in setEmitterVisibilityForSkyObject
    });
  }
}
```

## Coord-frame question (open for eye-test)

SkyObject SetupModel mesh has bounds maxDim=0.05m (5cm). It's a
position marker, not a visible mesh. The "parent" passed to the
ParticleManager should be:

- (a) the rotator group's world position (skyCell-relative), OR
- (b) the SetupModel's native vertex position (which is near origin
  for 0x02000714 per the Sky-I-A probe — sub-cm)

Per the Sky-I-A probe, the SetupModel proxy is at (0, 0, 0) in
sky-cell space. So the particle emitter parent is effectively at the
sky-cell origin, and the per-emitter `offset` (e.g. (0, 0, 250) for
the moon's three emitters) places them ~250 AC units above origin.

Combined with each emitter's MaxOffset (450-700), particles spawn at
~250+450 = 700 AC units above the camera-anchored cell origin. That
puts them roughly where the moon SHOULD be — adjacent to the moon
GfxObj 0x01001F6A which itself is at sky-cell coords ~(1990, 290, 0)
to (2143, 818, 259).

Hmm — but the moon's particle emitters' positions are NEAR the
sky-cell origin (250 + 450 = 700 units), while the moon mesh is at
(~2100, ~500). That's a ~1700-unit gap. Either:
- The SetupModel proxy should be positioned at the moon's mesh
  location, not the origin, OR
- The particles are NOT supposed to be at the moon — they're a
  separate "sky decoration" that happens nearby.

**Resolve via eye-test or further DAT probe.** A retail-screenshot
comparison would help. PhatSDK `GameSky::UseTime` is UNFINISHED so
no working reference exists.

## Other risks

1. **MaterialCache.get() needs to be sync after preload.** P4's
   materialFactory is async — first call awaits preload, subsequent
   calls are cached. The ParticleManager should preload all
   hwGfxObjId surfaces at addEmitter time so per-frame emit is fast.
2. **Particle billboard orientation.** Moon star GfxObjs 0x01001A61/
   A62/A63 are flat quads with vertex normals (0,-1,0). They'll be
   visible only when viewed from below. Either:
   - Bake them as billboards (look-at-camera each frame), OR
   - Trust the vertex normals + render two-sided.
   Eye-test will decide.
3. **MaxParticles=3 means 3 visible particles per moon emitter.**
   With 3 emitters, that's 9 particle quads total in the moon area.
   Performance impact negligible.
4. **`tick()` ordering.** ParticleManager.tick must run AFTER the
   per-SkyObject pose update (which moves the parent position).
   Current sky_dome.js tick: A anchor, B indoor check, C dome
   uniforms, D per-SkyObject. ParticleManager.tick fits after D.

## Validation plan

1. After landing P5, run `cargo test --workspace` (should still be
   1278+/0/1).
2. `wasm-pack build --target nodejs` — must succeed.
3. `node test_particles.mjs` (P4's tests) — still pass.
4. `node smoke_test.cjs` — confirms wasm boot still works.
5. Capture: extend `capture_skybox_e2e.cjs` with a "moon-particles
   visible at t=0.05 (foredawn, moon's visible window)" bullet.
   Assert at least one mesh under `liveScene3d.skyDome.skyCell` has
   `userData.particleEmitterTag === 0x02000714`.

## What this commit does NOT do

- Weather DayGroups (rain/snow). PhysicsScript 0x33000428 has a
  CallPESHook (recursive PES chain) — P5 doesn't implement
  recursion. Defer to P6.
- Per-particle blend mode override beyond what MaterialCache picks
  up from surface_type bits. The Alpha flag → ARGB byte
  reinterpretation question from the user's 2026-05-12 note is
  deferred to P6 if visible artifacts surface.
- PhysicsScriptTable (0x34) lookup. SkyObject.default_pes_object_id
  points directly at PhysicsScript (0x33), not Table (0x34). Table
  lookup would matter for in-world entity FX, not sky.

See also: `[[project_holtburger_sky_particles_probe_2026-05-12]]`,
`docs/sky-particles-p4-port-spec.md`.
