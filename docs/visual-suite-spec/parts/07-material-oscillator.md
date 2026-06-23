I now have everything I need. Writing the implementation-ready spec.

---

# BUILD SPEC — Slice 07: Material-Oscillator Layer

**Owner module (new):** `external/holtburger/apps/holtburger-web/scene3d/material_oscillators.js`
**Consumers:** every `emissive.*` / `weathering.*` / light-flicker component (slices 01, 08, 10). This slice owns the *time-varying scalar substrate* those components read; it does **not** own the GLSL that consumes the scalar.

## Goal

Give the suite a single, persistent, **once-per-frame** source of time-varying scalars (pulse, glint sweep, shimmer, flicker, decay envelopes) that:

1. updates **shared** material uniforms with **O(channel-count)** work per frame — *never* O(materials) and *never* O(instances);
2. binds to materials by **sharing the same `{value}` uniform object** across all materials on a channel, so one `.value` write/frame is seen by every bound material (zero per-material iteration on the write path);
3. costs **zero** when no component has registered a channel (byte-identical-to-today idle cost, mirroring the empty-registry no-op at `loop.js:818`, `materials.js:3310`);
4. never forces a shader relink and never makes `customProgramCacheKey` per-instance (THE RULE corollaries).

The existing terrain `uTime` push (`loop.js:817-831`) and animated-surface frame cycler (`materials.js:3309-3323`) are the two in-tree precedents this layer generalizes.

## Design

### Two binding modes (both required, both fed by this registry)

The registry exposes one canonical waveform vocabulary used in **two** ways:

| Mode | Where the waveform is evaluated | Per-object variation? | Uniform footprint | Use for |
|---|---|---|---|---|
| **Mode 1 — JS-broadcast channel** | JS, once/frame in `tick()` | No (all bound materials share one scalar; *unison* is the feature) | 1 shared `float` per channel, written 1×/frame | global wetness/frost ramp, "world-breathe" magic-glow ambient, synchronized pulse |
| **Mode 2 — in-shader oscillator** | GLSL fragment/vertex, per-fragment | Yes (per-instance static phase from `hash01`) | shared `uTime` (1 channel) + 1 **static** per-material `uOscPhase` (set once, never ticked) | per-object glint sweep, enchant shimmer, gem flicker |

Both modes draw from the **same waveform definitions** so JS and GLSL stay bit-for-bit consistent: JS evaluators for Mode 1, exported GLSL snippets (`OSC_GLSL`) for Mode 2. Mode 2 introduces **no new ticked uniform** — it only consumes the shared `uTime` channel plus a compile-time-static phase, so it is free on the tick path.

> **Why Mode 1 can share one `{value}` object across N materials:** three.js keeps a reference to the `shader.uniforms` object that `onBeforeCompile` mutated (`materialProperties.uniforms`) and re-reads `dict[name].value` on every `WebGLUniforms.upload`. If the *same nested* `{value}` object is assigned into every material's `shader.uniforms.uOscX`, mutating that one object's `.value` is observed by all of them. This is the same mechanism that lets the detail patch stash and later read `material.userData.detailShaderUniforms` (`materials.js:440`).

### Registry data structures (`material_oscillators.js`)

```js
// Channel config — pure static description, no runtime state except decay t0.
// { type, freqHz, phase, lo, hi, duty, tau, seed }
//   type:  'sine' | 'triangle' | 'saw' | 'pulse' | 'noise' | 'decay' | 'time'
//   freqHz: cycles/sec        phase: 0..1 cycle offset
//   lo,hi:  output range remap (default 0..1; sine maps -1..1 → lo..hi)
//   duty:   pulse high-fraction 0..1     tau: decay time-constant (s)
//   seed:   integer salt for 'noise' lattice (deterministic, Math.random-free)

class MaterialOscillatorRegistry {
  constructor() {
    this._chan = new Map();   // name -> { cfg, uniform:{value}, refs:int, t0:number|null }
    this._names = [];         // stable iteration order (array, no Map-iter alloc)
    this._tSec = 0;
  }

  /**
   * Idempotent. First call for `name` creates the channel + its ONE shared
   * THREE-style uniform object `{ value }`. Returns that uniform object so a
   * component installer can do `shader.uniforms.uOscX = reg.channel(...).uniform`.
   * Re-calling with the same name returns the existing channel (cfg of the
   * first registrant wins; later registrants just bump refcount + share it).
   */
  channel(name, cfg) {
    let c = this._chan.get(name);
    if (!c) {
      c = { cfg: { ...DEFAULT_CFG, ...cfg }, uniform: { value: cfg.lo ?? 0 }, refs: 0, t0: null };
      this._chan.set(name, c);
      this._names.push(name);
    }
    c.refs++;
    return c;                 // caller reads c.uniform
  }

  release(name) {             // on material dispose; channel reclaimed at refs==0
    const c = this._chan.get(name);
    if (c && --c.refs <= 0) { this._chan.delete(name); this._names = [...this._chan.keys()]; }
  }

  trigger(name, tSec) {       // arm a 'decay' channel (jiggle, shine-restore)
    const c = this._chan.get(name);
    if (c) c.t0 = (tSec ?? this._tSec);
  }

  /** O(channels). Zero allocation. Called once/frame from loop.js. */
  tick(tSec) {
    if (this._names.length === 0) return;          // empty-registry no-op
    this._tSec = tSec;
    for (let i = 0; i < this._names.length; i++) {
      const c = this._chan.get(this._names[i]);
      c.uniform.value = evalWave(c.cfg, tSec, c.t0); // single scalar write
    }
  }

  reset() { this._chan.clear(); this._names.length = 0; } // scene teardown
}

export const oscillators = new MaterialOscillatorRegistry(); // module singleton
```

### Waveform evaluators (JS — Mode 1)

```js
const TAU = Math.PI * 2;
function evalWave(cfg, t, t0) {
  const lo = cfg.lo ?? 0, hi = cfg.hi ?? 1;
  const u = (cfg.freqHz ?? 0.5) * t + (cfg.phase ?? 0);     // phase in cycles
  switch (cfg.type) {
    case 'time':     return t;                                // raw clock (uTime channel)
    case 'sine':     return lo + (hi - lo) * 0.5 * (1 + Math.sin(TAU * u));
    case 'triangle': { const f = u - Math.floor(u); return lo + (hi - lo) * (1 - Math.abs(2*f - 1)); }
    case 'saw':      { const f = u - Math.floor(u); return lo + (hi - lo) * f; }            // glint sweep pos 0→1
    case 'pulse':    { const f = u - Math.floor(u); return f < (cfg.duty ?? 0.5) ? hi : lo; } // emissive blink
    case 'noise':    return lo + (hi - lo) * valueNoise1(u, cfg.seed ?? 0);                  // torch flicker
    case 'decay':    return t0 == null ? lo : lo + (hi - lo) * Math.exp(-(t - t0) / (cfg.tau ?? 0.5));
    default:         return lo;
  }
}
// Deterministic 1-D value noise: hashed integer lattice + smoothstep lerp.
// NO Math.random — RULE-compliant, reproducible across reloads & headless tests.
function valueNoise1(x, seed) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => { let s = (n * 374761393 + seed * 668265263) | 0;
                     s = (s ^ (s >>> 13)) * 1274126177 | 0; return ((s >>> 0) % 1000) / 1000; };
  const s = f * f * (3 - 2 * f);                  // smoothstep
  return h(i) * (1 - s) + h(i + 1) * s;
}
```

### Waveform library (GLSL — Mode 2), exported as strings

```js
export const OSC_GLSL = /* glsl */`
  #define OSC_TAU 6.2831853
  float osc_sine(float t,float f,float ph,float lo,float hi){
    return lo+(hi-lo)*0.5*(1.0+sin(OSC_TAU*(f*t+ph))); }
  float osc_saw(float t,float f,float ph){ return fract(f*t+ph); }
  float osc_tri(float t,float f,float ph){ float x=fract(f*t+ph); return 1.0-abs(2.0*x-1.0); }
  // glint sweep: bright band travels along view/UV axis once per cycle
  float osc_glint(float coord,float t,float f,float w){
    float pos=fract(f*t); return smoothstep(w,0.0,abs(coord-pos)); }
`;
```

Slice 01's `_chainBeforeCompile` composition is responsible for `#include`-ing `OSC_GLSL` **once** per material (guarded by a `userData.__oscGlsl` flag so multiple components on one material don't double-inject), and for binding `shader.uniforms.uTime = oscillators.channel('uTime',{type:'time'}).uniform`. The per-object phase is a separate static uniform set at clone time:

```js
shader.uniforms.uOscPhase = { value: hash01(guid) };  // wind_rig.js:199 — static, NEVER ticked
```

### The `uTime` channel is canonical channel #0

The suite's shared clock becomes a registry channel: `oscillators.channel('uTime', { type:'time' })`. Every Mode-2 material grabs that one shared `{value}` object instead of each pushing its own `uTime` (this is strictly cheaper than the per-material terrain loop at `loop.js:826-829`, which stays as-is for terrain `ShaderMaterial`s — terrain is a separate, pre-existing registry and out of scope here).

### Shared-uniform budget

- **1** broadcast `uTime` channel (Mode 2 backbone).
- **≤ 12** named Mode-1 channels (cap is a soft policy, enforced by `vfx gauge`, slice 11). Each is one `float` uniform slot *on the materials that declare it*.
- **0** new ticked uniforms for Mode 2 beyond `uTime`; its per-object `uOscPhase` is compile-time-static (set once, never in `tick()`).
- A material declares **only** the channels its component set uses (slice 01 appends the matching `uniform float uOscX;` lines), so per-program uniform-slot pressure is the count of *that* material's effects, not the global channel count. `gl_MaxFragmentUniformVectors` on the 1070 (≥1024) is never a constraint at ≤12 floats.
- **Tick cost:** ≤13 scalar evals/frame, zero allocation, independent of material & instance count. Negligible against the per-frame CPU budget (the world is already CPU-bound at ~20fps; this adds a fixed ~sub-µs constant).

If channel count ever exceeds ~16 (it should not — audit via `vfx gauge`), fall back to a single shared `uniform vec4 uOscBank[N]` array uniform (4 lanes/vec4) so many channels collapse into few uniform slots; the registry would then write into one shared `Float32Array`. Documented as the escape hatch, **not** the day-one design (individual floats are cheaper for the common "1–2 effects per material" case).

## Integration seams (file:line)

| Seam | File:line | What goes here |
|---|---|---|
| **Tick call** | `scene3d/loop.js:1812` — immediately after `scene3d?.materialCache?.tickAnimatedSurfaces?.(dt);` | add `tickMaterialOscillators(scene3d)` (new local fn, mirrors `tickTerrainUTime` try/catch+one-shot-warn at `loop.js:1604-1612`) |
| **Wall-clock source** | read `scene3d.frameTime?.tsSec` with the exact fallback used at `loop.js:821-825`; stamped at `index.js:1773-1777` | the tick's `tSec` argument |
| **Tick precedent to copy** | `loop.js:817-831` (`tickTerrainUTime`) — empty-registry early-return, single time source | structural template for `tickMaterialOscillators` |
| **Per-frame method precedent** | `materials.js:3309-3323` (`tickAnimatedSurfaces`) | the "loop a small map of registered things once/frame" pattern |
| **Uniform-injection + userData stash** | `materials.js:412-441` (`_installDetailShaderPatch`) | template for component installers that grab `oscillators.channel().uniform` and assign into `shader.uniforms` |
| **Cache-key composition** | `materials.js:262-304` (`_patchSetCacheKey` / `_installPatchSetCacheKey` / `_chainBeforeCompile`) | slice 01 adds an `|o<bitmask>` term reflecting *which channels* a material reads — never the channel *values*, never per-instance |
| **Per-instance static phase** | `wind_rig.js:199` (`hash01`, Math.random-free) | source of `uOscPhase` for Mode 2 |
| **Teardown** | `materials.js:3331` (`MaterialCache.dispose`) neighbor / scene rebuild path | call `oscillators.reset()` |
| **Flag pattern** | `tree_wind.js:17-30` (`_strFlag`/`_numFlag` memoized) | optional `?oscSpeed=` global rate multiplier; layer self-gates on refcount so no master flag is required |
| **Diag** | `diag.js:447` (`window.__diag = diag`) | expose `__diag.oscillators = () => ({ count, names, values })` for `vfx gauge` |

## Edge cases & legacy-safety check (per THE RULE)

- **READS** — only (a) `scene3d.frameTime.tsSec` (shared client wall-clock), (b) static channel config from the descriptor, (c) `hash01(guid)` (static per-instance, `wind_rig.js:199`). No server-replicated, mutable, or wire value is read. ✓
- **WRITES** — only `channel.uniform.value` on **cloned suite materials** (the cache-owned variant clones, sibling to `frontSideMaterials`/`floorBiasMaterials` at `materials.js:1597,1604`). Never a wire field, never physics/collision, never replicated state. ✓
- **Light count invariant** — the oscillator produces a *scalar only*. The torch-flicker consumer (slice 10) multiplies `light.intensity` by a `pulse`/`noise` channel; it must never touch `.visible` or add/remove lights (would force a MeshStandard relink — the spell-freeze light-pool history). This slice cannot violate that because it writes no lights. ✓
- **No relink / no per-instance cache key** — channel *values* never enter `customProgramCacheKey`; only the *set of channels read* (a small bitmask, per component-SET) does. Two swords of the same archetype share one program (`materials.js:282` reads `userData` lazily, value-independent). Mode-2 phase is a static uniform value, not a key input. ✓
- **Decay/trigger state** — `decay` channels hold a `t0` set by `trigger()`; the trigger is a **client-local** event (e.g. soft-item jiggle on local proximity, shine-restore client verb). It reads the same wall-clock, writes only a uniform. Never replicated. ✓
- **dt=0 / net-drain frames** — uses absolute `tSec` (phase-stable), not dt-integration, so the dt=0 freeze-band frames (`loop.js:1527`) and the net-drain double-pump produce identical correct values; a repeated tick with the same `tSec` is idempotent. ✓
- **Empty registry** — `tick()` returns at line 1 (`this._names.length === 0`); when no component registers a channel the layer is byte-identical-cost to today. ✓
- **Shadow/depth pass** — oscillator uniforms live on the lit material only; the depth/shadow `customDepthMaterial` must not receive the patch (slice 08's invariant). This slice adds nothing to the depth path. ✓
- **Scene rebuild** — `reset()` drops stale channel refs so the singleton never ticks dead channels; shared `{value}` objects are GC'd with their disposed materials. ✓

## GPU cost

- **Tick (CPU):** O(active channels) ≤ ~13 `Math` evals/frame, zero allocation. Sub-microsecond; far below the idle CPU slice even at 20fps.
- **Mode 1 (per material):** the shared `float` uniform is uploaded by three regardless; the *value compute* is amortized to once/frame for ALL bound materials. In-shader it is consumed by one existing op (`emissiveIntensity *= uOscX`) ≈ 1 MAD/fragment.
- **Mode 2 (per fragment):** `osc_sine` ≈ 1 `sin`; `osc_glint` ≈ 1 `smoothstep`+`fract`; `valueNoise`-equivalent ≈ 4–8 ALU. All "cheap" per the design-doc cost table (§5.3). No extra draw calls, no texture fetches, no VRAM.
- **No relink cost** — the layer adds uniforms to *existing* patch sets; cache key is value-independent so the cold-load shader-link count is unchanged (the project's #1 cold-load cost is untouched).

## Build checklist (ordered)

1. **Create `scene3d/material_oscillators.js`** — imports nothing from the scene graph (cycle-safe, like `wind_rig.js`). Export: `DEFAULT_CFG`, `evalWave`, `valueNoise1`, `OSC_GLSL` (string), `class MaterialOscillatorRegistry`, and the module singleton `export const oscillators`.
2. **Implement `channel/release/trigger/tick/reset`** exactly as above; register the canonical `'uTime'` channel lazily on first `tick`-needing consumer (or eagerly in the constructor — pick eager so Mode-2 materials always find it).
3. **Wire the tick in `loop.js`** — add a local `tickMaterialOscillators(scene3d)` that reads `scene3d.frameTime?.tsSec` (fallback per `loop.js:821-825`) and calls `oscillators.tick(tSec)`; wrap in try/catch + one-shot `scene3d._oscTickWarned` warn (copy the shape of `loop.js:1604-1612`). Call it at **`loop.js:1812`**, right after `tickAnimatedSurfaces`. Import `oscillators` at the top of `loop.js`.
4. **Teardown** — call `oscillators.reset()` from the scene-dispose path adjacent to `MaterialCache.dispose` (`materials.js:3331`) / scene rebuild in `index.js`.
5. **Component-binding helper (handoff to slice 01)** — add `bindOscillator(shader, glslName, channelName, cfg)` in `materials.js`: `shader.uniforms[glslName] = oscillators.channel(channelName, cfg).uniform;` and ensure `OSC_GLSL` is `#include`-d once (guard `material.userData.__oscGlsl`). Add the `|o<bitmask>` term to `_patchSetCacheKey` (`materials.js:262`) reflecting which channels the material reads.
6. **Per-object phase** — in the Mode-2 installer, set `shader.uniforms.uOscPhase = { value: hash01(guid) }` (import `hash01` from `wind_rig.js`); declare `uniform float uOscPhase;`.
7. **Diag** — in `diag.js` (near `:447`) add `diag.oscillators = () => ({ count: oscillators._names.length, names: [...oscillators._names], values: oscillators._names.map(n => oscillators._chan.get(n).uniform.value) });` for `vfx gauge`.
8. **Optional flag** — `?oscSpeed=<f>` global freq multiplier via the `tree_wind.js:17-30` memoized `_numFlag` pattern, applied in `evalWave` (`u = cfg.freqHz * oscSpeed * t + phase`). Layer needs no master enable flag (self-gates on refcount).
9. **Tests** (`scene3d/__tests__/material_oscillators.test.js`):
   - determinism — `evalWave`/`valueNoise1` reproducible, no `Math.random`;
   - **shared-object identity** — two materials grab the same channel; one `tick()` updates both `.value` (proves zero per-material write work);
   - empty-registry `tick()` is a no-op (no throw, no alloc);
   - `decay` returns `lo` until `trigger()`, then `e^{-…}` from `t0`;
   - `release()` reclaims a channel at refcount 0; `reset()` clears all;
   - cache-key invariance — changing a channel's `.value` does not change `_patchSetCacheKey`.
10. **Gauge** — run `vfx gauge --ref holtburg` (slice 11) with a 3-channel set (`pulse`, `glint`, `shimmer`) bound on the Holtburg 222-placement ref; confirm <75% GPU and tick cost flat vs channel count, not placement count.
