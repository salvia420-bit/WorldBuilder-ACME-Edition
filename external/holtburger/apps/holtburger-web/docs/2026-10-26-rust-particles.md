# Lane A — the particle system in Rust (`?rustParticles`, 2026-10-26)

Part of the Rust scene core (docs/2026-10-26-rust-scene-core.md — read its §3 contract first). Status: the first
build compiled clean, the 7 cargo parity tests pass (413,577 floats bit-exact), the node side-by-side passes through
the release wasm, and a laptop boot with `?rustParticles=on` put 740/740 instanced emitters on the kernel with 0
console errors. The 2026-10-26 review fixes (§8) are written and verified in node against the JS mirror of the
kernel but **not yet compiled** (lane agents may not run cargo / wasm-pack). Default OFF; `?rustParticles=on` opts in.

## 1. The cut

Every emitter that takes the **instanced** path (`?particleInstancing`, default ON — all static default-script
emitters and the instanced world/entity ones) is owned by the kernel; everything else stays exactly as it was.

| Moved to Rust (`crates/holtburger-scene/src/particles/`) | Stays in JS |
|---|---|
| Per-emitter info, slot + particle state (SoA-ish `Vec<Slot>`), emission bookkeeping | Emitter creation API (`addEmitter`), materials, factories |
| `Particle.init` / `update` for all 12 types + Unknown, the four legacy escapes | The InstancedMesh buckets, kids meshes, the shared alpha registry object |
| emit / kill / `stopEmitter` / `initEnd` burst / lazy slot growth (8 at a time, landing before the next tick, as the JS microtasks do) | The per-mesh (non-instanced) emitter path, untouched |
| RP6: the due re-check for **frozen** static anchors (cached sphere), transitions (thaw / freeze / re-show), the culled branch (virtual emit, force stop after 30 s, drain) | RP6 decisions of **dynamic** emitters (entity rigs, interior statics): `_rp6ShouldCull` on the JS shell, passed as a flag |
| Film / cell gates (decisions passed in), both billboard passes (sprite + retail modes 2–5) | `_resolveAnchorFrame` (three.js objects), the cell visibility lookup, the camera / frustum |
| `_appendInstances`: matrix compose, opacity, the FX channels (age, row + seed from the shared xorshift stream), `?fxMotion` velocity row, tier-1 kid records | Tier-1 lights / distortion, owner registry, film queries, diagnostics |
| Bucket routing (own vs shared alpha, sig / scene rejection), create / acquire / grow decisions as **ordered events** | Replaying those events with the real `_makeBucketIm` / `acquire` / `_growBucket` (same objects, same creation order) |
| The own alpha buckets' back-to-front sort (V8's typed-array merge sort, replicated) | `_finalizeInstBuckets` publish / park / reap; the shared buckets' sort runs through the kernel's sort helper |

Why RP6 is split: the sphere centre of a frozen static anchor is constant (frozen `matrixWorld` / frozen part
frames), so the kernel can own the whole re-check for the bulk of the static emitters and JS never touches them per
tick. A moving anchor's centre needs three.js reads anyway, so JS keeps deciding those with the unchanged
`_rp6ShouldCull` (zero risk of RP6 divergence) and the kernel applies the decision.

## 2. Data flow (one manager tick)

1. `_tickLatched` computes its context as before (frame, interval, stagger, camera + frustum, billboard camera,
   cell gate, sort cameras), then calls `RustParticles.tick(ctx)` **once**, before its JS loop.
2. The bridge (scene3d/rust/particles.js) writes, through views on wasm memory: for each *dynamic* shell the RP6
   decision on its due ticks + the cell flag + its anchor frame — only when the kernel may read it. The kernel
   publishes per handle (after every tick, add, stop and field write) a `needs_anchor` bit set, the emit clock and a
   slot threshold (layout `NEED_*`):
   - `NEED_ALWAYS` — a parent-local emitter with live particles (its update reads the frame), drains included;
   - `NEED_IF_DUE` — a per-second emitter only once `now - lastEmitTime > birthrate` (the kernel's emit test,
     evaluated by JS with the same expression);
   - `NEED_IF_SLOT` — per-second and per-metre emitters only when a slot is free or a live particle can die by now
     (`now >= threshold - 1 ms`; threshold = −∞ below `maxParticles`, else the earliest `lastUpdateTime +
     lifespan` — `+ lifespan - lifetime` when persistent): a saturated emitter cannot emit, so its frame is unused;
   - `NEED_SKIP_IF_CULLED` — a persistent, not stopped emitter on a tick its RP6 flag is culled: its culled branch
     neither emits (no virtual emit for persistent emitters) nor drains, exactly like the JS path, which skips its
     `updateParticles`. A stop between ticks republishes the bits, so a stopped emitter drains with a fresh frame.

   All conservative (an unused frame may be resolved, a used one never skipped); the cargo test replays every
   fixture a second time with only the gated anchors written, which must stay bit-exact (it does through the JS
   mirror of the kernel; the Rust run awaits the next build). Measured on the review's moving
   rigs (tests/rust_particles_parity.test.mjs, scenario `culledDynamic`): culled persistent emitters and saturated
   per-second ones resolve as often as the JS path (0 while culled), saturated per-metre ones less often (the JS
   path computes the per-metre origin every tick). Residual: a culled **finite** parent-local emitter that is not
   stopped still resolves every culled tick (it may stop and drain mid-tick); finite effects are short-lived.
   Then the route table (key id + current alpha-material signature per live `(key, base material)` route), the
   bucket table (what exists now: own / shared, capacity, FX-ness, the shared bucket's start offset this frame),
   the globals block.
3. `SceneParticles.tick(globals)` runs every Rust emitter in table order — exactly `_tickLatched`'s per-emitter
   body — and packs instances per bucket (bucket-major), kid records per layer, finished handles, stats, the FX
   seed state.
4. The bridge replays the events in order (bucket create / acquire / grow, kids manager / layer), copies each
   bucket's instances with one `TypedArray.set`, bulk-pushes kid records, adds the counters, restores the FX seed
   state, and returns the finished shells; the manager merges them with the JS removals by insertion sequence and
   runs its normal removal path (owner registry callback, tier-1 release).
5. The JS loop then walks only `_jsTable` (per-mesh emitters); `_finalizeInstBuckets` skips the sort of own buckets
   the kernel filled (`_rustN`), and sorts shared buckets through the kernel's sort helper.

A Rust-owned emitter is a **shell**: the real `ParticleEmitter` object (parent, partIndex, parentOffset, info,
bucket keying, `_fxRow`, tier-1 light) with no slot meshes and no Particles. `setInfo` keeps the cap and the same
awaits (so concurrent `addEmitter` calls register in the same order) but only counts the initial slots; the kernel
runs `initEnd` at registration. Fields other code reads every frame (`numParticles` for tier-1 lights,
`totalEmitted`, `stopped`, `lastEmitTime`, `_createdSlots`, `_rp6Culled`, …) become own accessors that read the
kernel's published per-handle Q_* row (`state_out`, `stateOutPtr` — a view read, no wasm call; republished at stop /
field writes, so a stop between ticks reads back at once); `emitterState` remains for `convertToJs` and as the
fallback for a pkg without `stateOutPtr`. `filmHidden`, `degradeDistance`, `_forceDegrade`, `_bbMode` forward writes
to the kernel. Film mode samples kernel shells through `RustParticles.filmSample` (`filmSamples`: one kernel pass per
tick for every shell, live + visible + finite + above the opacity floor, no meshes); `parts` / `partStorage`
materialize carrier-shaped proxy meshes from `slotSnapshot` **only when read** (`__diag`, cached per tick). The
runtime toggle
`setInstancing(false)` hands a shell back to JS with its exact state (`convertToJs`: particles, slot transforms,
opacity, FX seeds / velocities / kid history, lazy-grow factory), after which it is an ordinary JS emitter.

Memory: no per-slot `THREE.Mesh` + `Particle` (~1–2 KB each in JS) for kernel emitters; a slot is ~350 B in Rust.

## 3. Exactness

- f64 in the JS operation order (three.js r184 via `math.rs` + `three_ext.rs`), f32 rounding exactly where the JS
  stores into a Float32Array (instance attributes, `_fxSeeds/_fxLives/_fxVel/_kidPrev`, kid records).
- RNG: one `Rng` per SceneParticles (seeded from `Math.random()` in production); draws in the JS order — offset
  (3, or 4 when the projected direction is large enough), A, B, C, start/final scale, start/final trans, lifespan
  inside init, Explode's two angles.
- The FX seed stream (particle_fx.js xorshift `_rng`) is shared across managers: its state goes in and out of each
  tick (`particleFxSeedState` / `setParticleFxSeedState`), so instances get the same seeds as on the JS path.
- Trig: Swarm, Explode init, Implode and the GR spins call sin/cos. On wasm32 Rust uses the `libm` crate (musl /
  FreeBSD msun, fdlibm-derived, like V8's ieee754) — expected bit-identical but not guaranteed; the parity tests
  allow 1 f32 ulp there and 1e-3 absolute for the finite-difference velocities derived from them.

Verified:
1. `tools/rust_parity/gen_particles.mjs` → 6 fixtures (types, facing, cull, dynamic, grow, legacy; 1–1.6 MB).
2. Orchestrator build (first review round): cargo parity 7/7 (413,577 floats bit-exact); the node side-by-side
   through the release wasm in `pkg/`; laptop boot 740/740 instanced emitters on the kernel, 0 errors.
3. Review fixes, in node: the scratch line-by-line JS mirror of the kernel replays all six fixtures bit-exact, also
   with only the gated anchors written (cull: 79 of 90 recorded anchors gated off, dynamic: 18 of 170); the real
   bridge + manager against the mirror (an injected stand-in for `SceneParticles`) — 10 scenarios identical to the
   flag-off run (the 5 + two managers, runtime toggle, same-id overwrite, culled / saturated moving rigs, film
   query) — and Part 3's regression checks; through the installed (pre-fix) release pkg the same pass, with the
   checks that need the new exports reported SKIP. Each Part 3 check fails with its fix reverted at runtime.
4. All 26 existing particle suites and the film suites pass with the flag off.

## 4. Known differences / left on the JS path (by design)

- **Add-time clock reads**: the JS path reads `performance.now()` up to 3N+3 times while building an emitter
  (constructor, initEnd, each burst particle's init + update + record); the kernel's initEnd uses one value read at
  registration. Microseconds apart in production; identical in the fixtures (a clock constant between ticks).
- **RNG streams**: kernel emitters draw from the kernel's own stream, so the JS `rng()` stream (statics CallPES
  scheduling, per-mesh emitters) no longer interleaves with particle draws. A film take (which installs a seeded
  `setRng`) is deterministic per page load but not identical to the flag-off take; shoot film takes with the flag
  off for frame-exact reproducibility.
- `emitter.parts` / `partStorage` on a kernel emitter are proxies built on read (once per tick at most; `__diag`
  and `convertToJs` only — film mode reads `filmSample`). `instancingDiag()` reports `rustEmitters` / `rustSlots`
  instead of slot carriers.
- Same-id creates that overlap (`?particleOwner=off` callers pass explicit ids): the second resolve overwrites the
  first's table entry in place. The JS path just never walks the orphan again; the bridge removes the orphan from the
  kernel and inserts the newcomer at its table position (`addEmitterAt`; a pkg without it appends — same draws,
  another order).
- Runtime toggle: OFF→ON leaves converted emitters on the JS instanced path (they do not go back to the kernel).
- A JS-instanced emitter can only exist next to kernel emitters after that toggle; its instances then follow the
  kernel's in a shared own bucket (JS re-sorts such a bucket).
- Not fixture-covered: the shared bucket's scene-rejection path (needs two managers with different transforms);
  covered by the same code as the material rejection, which is.
- Cached anchors assume `_scene`'s transform is static; the bridge compares `_scene.matrixWorld` each tick and
  re-sends cached anchors if it moves (and the cached RP6 spheres if `?rp6TrueSphere` / `?rp6TravelReach` flip).

## 5. Files

Rust: `crates/holtburger-scene/src/particles/{mod,layout,info,particle,emitter,fx,buckets,sort,billboard,three_ext}.rs`
(the placeholder `particles.rs` became this directory), `tests/particles_parity.rs`,
`tests/fixtures/particles_{types,facing,cull,dynamic,grow,legacy}.json`, `apps/holtburger-web/src/scene_wasm/particles.rs`.
JS: `scene3d/rust/particles.js` (bridge), `scene3d/particles/particle_manager.js` (integration),
`particle_emitter.js` (shell mode, `initEndBurst`), `particle.js` (`particleLegacyFlags`), `particle_fx.js` (seed
state, tier-2 latch query), `particle_fx_kids.js` (`pushRecords`), `scene3d/film/scene/particles_query.js` (kernel
shells sampled through `filmSample`), `tools/rust_parity/gen_particles.mjs`, `tests/rust_particles_parity.test.mjs`.

## 6. Verify

```
cargo test -p holtburger-scene particles          # capped-build; parity (plain + anchors gated) + unit tests
node tools/rust_parity/gen_particles.mjs          # regenerate fixtures (deterministic)
node tests/rust_particles_parity.test.mjs         # HB_PKG=<dir> for another pkg; Part 3 = review regressions
```

## 7. Risks a reviewer should check first

1. `particle_manager.js` `_tickLatched` / `addEmitter` / `_finalizeInstBuckets` diffs: every new line is behind
   `this._rust !== null`, `this._rustTickTap !== null` or `rustShell`.
2. The event replay order in `RustParticles._applyOutputs` (object creation order = three.js transparent sort ties).
3. `layout.rs` ↔ the bridge's `L` table (the node test checks all 185 constants).
4. Shell accessors and film mode (`filmHidden` own accessor; film restores via assignment).
5. On the 1070: `?rustParticles=on` vs off at Holtburg / Linvak (particle ms/frame, draws unchanged, no console
   errors, fountains / torches / waterfalls / portal swirl / cast trails look the same).
6. The anchor-need bits (§2): conservative by construction and by the gated cargo replay; a new kernel read of
   `e.anchor` must come with a matching bit.

## 8. Review fixes (2026-10-26, second round)

1. **Route table leak.** Routes are refcounted per `(bucket key, base material)`; at refs 0 the route is freed
   (its base material dropped, so one `?matBudgetMB` evicted and re-minted under a new uuid is collectable with its
   texture and pixels) and its id reused before the table grows; a rejected register releases its route. The
   alpha-signature intern map (strings) restarts past 4096 entries (ids are only compared within a tick).
2. **Same-id orphan.** `ParticleManager.addEmitter` reads the old entry before the in-place `set`; under the kernel
   it removes the orphan (shell: from the kernel; JS emitter: from `_jsTable`), gives the newcomer the orphan's
   removal sequence number and kernel position. Flag off: unchanged.
3. **Culled / saturated anchor resolves.** `NEED_SKIP_IF_CULLED` + `NEED_IF_SLOT` (§2).
4. **Film mode.** `particles_query.js` samples kernel shells through `filmSample` (no proxies) and reads `em.parts`
   once on other emitters; `materialize` is cached per tick.
5. **Tier-1 light round trips.** Q_* reads come from the published `state_out` row (no `emitterState` per read).

New wasm exports: `addEmitterAt`, `anchorSlotFreePtr/Len`, `stateOutPtr/Len`, `filmSamples`, `filmOutPtr/Len`
(the bridge feature-detects each; an older pkg keeps the previous behaviour). New layout constants:
`NEED_SKIP_IF_CULLED`, `NEED_IF_SLOT`, `NEED_SLOT_MARGIN_US`, `FS_X/FS_SCALE/FS_OP/FS_STRIDE`.
