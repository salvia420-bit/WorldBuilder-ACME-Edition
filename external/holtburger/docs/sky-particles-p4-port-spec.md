# P4 — JS Particle Runtime Port Spec (2026-05-12)

Drafted from `external/ACE/Source/ACE.Server/Physics/Particles/*.cs`
during the P1/P2 parser landing.

## Files to create

- `apps/holtburger-web/scene3d/particles/particle.js` (~120 LoC)
- `apps/holtburger-web/scene3d/particles/particle_emitter.js` (~180 LoC)
- `apps/holtburger-web/scene3d/particles/particle_manager.js` (~80 LoC)
- `apps/holtburger-web/scene3d/particles/index.js` (re-export barrel, ~10 LoC)

## ACE → JS type mapping

| ACE C# | JS port |
|---|---|
| `PhysicsObj` (parent anchor) | `{ position: Vector3, quaternion: Quaternion, partFrames?: Frame[] }` POJO |
| `PhysicsPart` (per-particle visual) | `THREE.Mesh` with shared `BufferGeometry` from `fetchBuildingPlacement(emitter.hwGfxObjId)` |
| `AFrame` | `THREE.Object3D` (position + quaternion) — use `localToWorld` for `LocalToGlobalVec` |
| `PhysicsTimer.CurrentTime` | `performance.now() / 1000.0` (seconds since page load) |
| `ThreadSafeRandom.Next(lo, hi)` | `Math.random() * (hi - lo) + lo` |
| `Vec.NormalizeCheckSmall(ref v)` | `v.lengthSq() < 1e-6 ? true : (v.normalize(), false)` |

## Particle struct (port of `Particle.cs`)

```js
class Particle {
  constructor() {
    this.lastUpdateTime = 0;
    this.birthtime = 0;
    this.lifespan = 0;
    this.lifetime = 0;
    this.startFrame = new THREE.Object3D(); // copy of parent at spawn time
    this.offset = new THREE.Vector3();
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
    this.c = new THREE.Vector3();
    this.startScale = 1; this.finalScale = 1;
    this.startTrans = 0; this.finalTrans = 1;
  }

  init(info, parent, partIdx, parentOffset, mesh, randomOffset, persistent, randomA, randomB, randomC) {
    const now = currentTime();
    this.lastUpdateTime = now;
    this.birthtime = now;
    this.lifetime = 0;
    this.lifespan = info.getRandomLifespan();
    // Snapshot parent transform (for IsParentLocal=false particles)
    if (partIdx === -1) this.startFrame.copy(parent);
    else this.startFrame.copy(parent.partFrames[partIdx]);
    // Offset = StartFrame.LocalToGlobalVec(parentOffset.origin + randomOffset)
    const localPt = parentOffset.position.clone().add(randomOffset);
    this.offset.copy(this.startFrame.localToWorld(localPt));
    // ParticleType branching — port the 12-case switch from Particle.cs:47-108
    switch (info.particleType) {
      case ParticleType.Swarm:
        this.a.copy(this.startFrame.localToWorld(randomA).sub(this.startFrame.position));
        this.b.copy(randomB);
        this.c.copy(randomC);
        break;
      // ... rest of the 11 other cases
    }
    this.startScale = info.startScale;
    this.finalScale = info.finalScale;
    this.startTrans = info.startTrans;
    this.finalTrans = info.finalTrans;
    mesh.scale.setScalar(this.startScale);
    setTranslucency(mesh, this.startTrans);
    this.update(info.particleType, persistent, mesh, parentOffset);
    return false;
  }

  update(particleType, persistent, mesh, parent) {
    const now = currentTime();
    const elapsed = now - this.lastUpdateTime;
    if (persistent) { this.lifetime += elapsed; this.lastUpdateTime = now; }
    else this.lifetime = elapsed;
    const lt = this.lifetime;
    switch (particleType) {
      case ParticleType.Swarm: {
        const sx = lt * this.a.x + this.c.x + parent.position.x + this.offset.x;
        const sy = lt * this.a.y + this.c.y + parent.position.y + this.offset.y;
        const sz = lt * this.a.z + this.c.z + parent.position.z + this.offset.z;
        mesh.position.set(
          Math.cos(lt * this.b.x) + sx,
          Math.sin(lt * this.b.y) + sy,
          Math.cos(lt * this.b.z) + sz,
        );
        break;
      }
      // ... rest
    }
    const interval = Math.min(this.lifetime / this.lifespan, 1.0);
    mesh.scale.setScalar(this.startScale + (this.finalScale - this.startScale) * interval);
    setTranslucency(mesh, this.startTrans + (this.finalTrans - this.startTrans) * interval);
  }
}
```

## ParticleEmitter struct (port of `ParticleEmitter.cs`)

Key methods: `setInfo(info)`, `emitParticle()`, `killParticle(i)`,
`shouldEmitParticle()`, `stopEmitter()`, `updateParticles()`, `initEnd()`.

`emitParticle()` finds a free slot, calls `info.getRandomOffset/A/B/C`,
spawns a Particle. `updateParticles()` per-tick advances all live
particles, kills expired ones, and emits new ones via Birthrate gating.

For sky use case: per `Info.IsParentLocal`:
- `true`: particle position is parent-frame-relative each tick
  (orbits with the parent — used for moon stars A61, A63)
- `false`: particle stays at `startFrame` world position (used for
  A62 — the static centerpiece)

## ParticleManager (~80 LoC)

Holds a list of all active emitters. Per-tick calls `updateParticles()`
on each. Removes emitters that returned `false` (no particles left + stopped).

## Material setup

Each particle's mesh material is from `MaterialCache` (already used by
sky_dome.js). For additive emitters (per surface_type bit 0x10000):
- `material.blending = THREE.AdditiveBlending`
- `material.depthWrite = false`
- `material.transparent = true`

For alpha-test emitters (surface_type bit 0x100 = `Alpha`, no `Additive`):
- `material.alphaTest = 0.5`
- `material.transparent = true`

Investigate the rain-as-aRGB byte reinterpretation here if the
texture decode produces wrong-looking pixels.

## Open questions for P5 integration

1. **Sky cell anchoring**: emitter parent = SetupModel's sky-cell
   position (camera-anchored after sky-cell offset). Confirmed by
   PhatSDK GameSky.h:32-34's `before_sky_cell` / `after_sky_cell`.
2. **Billboard vs vertex orientation**: moon particles (0x01001A61/2/3)
   are flat quads with vertex normals (0, -1, 0). They're already
   facing AC -Y (player up). Either keep static or override with
   billboarding — eye-test.
3. **Frame.Origin units**: PhysicsScript CreateParticleHook's
   `Offset.Origin = (0, 0, 250)` — is 250 in AC world units (≈ 2.5
   meters)? At sky-cell radius ~1900, 250 is ~13% offset — plausible
   for a moon halo cluster.
4. **Time scaling**: should we feed real wall-clock time, or
   compress (e.g., 1 real sec = 10 AC sec) for visible motion during
   captures?

## Reference math sanity check (Swarm @ moon)

Emitter 0x32000456 has A=(0,0,0), B=(0.2,0.2,0.2), C=(300,300,300).
Lifespan 900s. At parent moon position (~1900 units from camera in
sky-cell space):

- At lifetime t=0: `swarm = (0 + 300, 0 + 300, 0 + 300) + parent + offset`
  → position is `(cos(0) + 1900+300, sin(0) + 0+300, cos(0) + 0+300)`
  → `(2201, 300, 301)` plus the random offset from emitter.MinOffset/MaxOffset
- At lifetime t=900: B*t = (180, 180, 180). cos/sin of 180 are
  arbitrary but bounded ±1. So particle drifts by ~1m in cos/sin
  envelope while staying near `(2200, 300, 300)`.

Conclusion: Swarm with these parameters produces 3 particles slowly
oscillating ±1m around a fixed centerpoint ~300 units offset from
moon. Visible only because of MaxOffset (700) spawn radius.

See also: `[[project_holtburger_sky_particles_probe_2026-05-12]]` for
the full chain probe.
