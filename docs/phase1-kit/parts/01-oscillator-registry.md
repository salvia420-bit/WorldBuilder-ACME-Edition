Everything is implemented, applied, and verified (31/31 test pass; both files `node --check` clean; windBend regression green). Here is the ready-to-integrate deliverable.

---

## Goal

The **single per-frame VFX tick** — slice `01-oscillator-registry`. A THREE-free leaf registry of named oscillators (`sine`/`triangle`/`smoothNoise`/`decay`) that write the shared `VFX_GLOBALS` `{value}` uniforms **once/frame, O(1), no per-instance work**. `VFX_GLOBALS.uTime` is the master clock and this tick is its **sole writer** (it was dormant at `0` in Phase 0 — `test_vfx_material_substrate.mjs` locks *"uTime starts at 0, driven by the Phase-1 oscillator tick"*). This is the foundation every emissive/weathering effect (slices 05–10) reads.

## Files

### NEW — `external/holtburger/apps/holtburger-web/scene3d/vfx/oscillators.js`
Full contents written & verified (see file). Key API surface:

| Export | Purpose |
|---|---|
| `WAVES` (frozen `{sine,triangle,smoothNoise,decay}`) | the pure waveform math, shared so effect slices don't fork a copy |
| `sampleWave(kind,t,config)` | pure sampler (tests / one-shots) |
| `setMasterClock(clockUniform)` | bind `VFX_GLOBALS.uTime` **by reference** (idempotent; keeps this leaf THREE-free) |
| `registerOscillator(name,{kind,config,target})` | register a channel writing one `{value}` uniform; rejects bad `kind` / non-`{value}` target |
| `updateOscillator` / `unregisterOscillator` / `getOscillator` / `listOscillators` / `_clearOscillators` | live-tune / teardown / test helpers |
| `tickOscillators(tSec,dt)` | THE tick: writes master clock, then each channel; fail-soft per channel; deterministic for fixed `t` |
| `OSCILLATOR_INFRA_MANIFEST` | audit-facing pseudo-manifest (`reads:["clock"]`, `writes:["materialUniform"]`, deterministic, `lightCountDelta:0`, `cacheKeyScope:"none"`) |

Waveforms are **stateless pure functions of absolute `t`** → phase-locked, frame-rate-independent, resume-safe. `smoothNoise` uses an integer xorshift-mul hash (`_noiseHash`), **never `Math.random`**. `decay` supports an optional `wobbleFreq` (the soft-item "decayWobble" jiggle primitive, queued for Phase-2 MECH-B).

### EDIT — `scene3d/loop.js` (3 insertions, applied & `node --check` clean)

**(1) Imports + master-clock bind — after line 85** (`wxUpdateFromDayGroup` import), now **lines 87–95**:
```js
import { VFX_GLOBALS } from "./materials.js";
import { tickOscillators, setMasterClock } from "./vfx/oscillators.js";
setMasterClock(VFX_GLOBALS.uTime);
```
`loop.js` already imports `three`, so adding the `materials.js` import costs nothing new and keeps the bind co-located with the call (the reviewer's eye). `oscillators.js` itself stays import-free.

**(2) The wrapper — after `tickTerrainUTime` (before `tickTerrainSunDir`), now lines 845–869** (`function tickVfxOscillators` at **857**). Mirrors `tickTerrainUTime`'s clock resolution exactly (`scene3d.frameTime.tsSec` with the `performance.now`/`Date.now` fallback) so the VFX clock and terrain water clock share one snapshot — no multi-clock drift.

**(3) The call — immediately after the `tickTerrainUTime` try/catch in `tickPerFrame`, now lines 1646–1664** (call at **1654**), wrapped in the same one-shot-warn try/catch. **Never budget-gated** (it is the clock; deferring it freezes every effect).

## GLSL

**None for this slice.** The oscillator registry is pure JS that drives the shared `{value}` uniforms; the GLSL `#include` seams that *read* `uTime` / `uWetness` / `uFrost` (after `<emissivemap_fragment>` / `<map_fragment>` / `<roughnessmap_fragment>`, composed under one `__vfxSetKey` by `FAMILY_ORDER`) are owned by the effect slices (05–10). Those slices' `declareUniforms` bind `VFX_GLOBALS.uTime` by reference into their `shader.uniforms`; this tick mutates that same object's `.value` once/frame.

## Manifest

**This is INFRA, not a `VisualComponent`** — it is not in `registry.js` (which governs only components). But it obeys THE RULE and exports an audit-facing pseudo-manifest that **passes `lint_caps.lintManifest`** (test asserts this):

```
reads: ["clock"]            // subset of ALLOWED_READS
writes: ["materialUniform"] // subset of ALLOWED_WRITES (cloned-material {value})
deterministic: true         // pure t; no Math.random / argless Date.now
lightCountDelta: 0          // never touches a light
cacheKeyScope: "none"       // never touches customProgramCacheKey
```
`lint_caps.lintSource` over `oscillators.js` returns **0 hits** (test-verified). The leaf reads no wall clock at all — `tSec` is injected by `loop.js` — so it is trivially deterministic and node-testable.

## Test

NEW — `test_vfx_oscillators.mjs`, `check()`/`process.exit(1)` style. **31/31 pass.** Covers: all four waveforms (range + `sine(0)=bias`, `triangle` peak, `smoothNoise` determinism + seed-decorrelation, `decay` dormant-before-`t0` / full-at-`t0` / damped wobble); the **master clock is uTime's sole writer**; channels write their shared `{value}` from the master clock; **phase-lock** (one `tSec` drives uTime + channel coherently); idempotent re-tick; O(1) clock-only floor with zero channels; register/update/unregister/reject paths; and the firewall checks — `OSCILLATOR_INFRA_MANIFEST` passes `lintManifest`, and `lintSource(oscillators.js)` is clean.

## Integration notes

- **Composition on the chain:** this slice does not touch `_chainBeforeCompile`. It produces the *uniform values* that the FAMILY_ORDER-composed frag patches consume. Effect slices read `VFX_GLOBALS` by reference; this tick is the only writer.
- **Sequencing (for slice 16):** lands **first** — slices 05–10 (emissive/weathering) and 07 (enchantShimmer "driven by an oscillator channel") depend on `registerOscillator`/`WAVES`; slice 12 (weather-inputs) ticks *alongside* this and may `registerOscillator` a `smoothNoise` gust channel or write `uWetness`/`uFrost` directly. No edits to `materials.js`/`statics.js`, so **zero conflict** with slices 02/13.
- **`?flag`:** none of its own — it's always-on infra (the clock). The registry stays **empty** until an effect (gated by its own `?glint`/`?tarnish`/… flag, slice 14) registers a channel, so render is **byte-identical when `?visual` is off**: one scalar write to a `uTime` uniform that no material binds until a frag variant is built.
- **Gauge cost row:** `infra.oscillators` — placement-independent, **0 draw calls, O(1)/frame** (one clock write + one write per registered channel; channels number in the single digits). Slice 15 should add it as a fixed structural row, not a per-DID cost.
- **Queued-for-1070:** `decay`'s `wobbleFreq` damped-oscillation is wired and tested but unused in Phase 1 (the soft-item jiggle is MECH-B, Phase 2); `dt` is threaded through `tickOscillators` for future integrator-style channels but the Phase-1 stateless waveforms ignore it.

## Risks

- **Import-graph:** `loop.js` now imports `materials.js`. `materials.js` is a lower-level module (imports `three`, not `loop.js`), so **no cycle**; verified `node --check` clean on both. If a reviewer prefers, the bind can move to `index.js` (which already imports `MaterialCache`) — but the slice spec says wire into `loop.js`, and co-locating the bind with the call reads better.
- **By-reference invariant:** correctness depends on nobody **reassigning** `VFX_GLOBALS.uTime` (only mutating `.value`). Phase-0 substrate only ever mutates `.value`; `getCachedVariant` binds the same object into shaders. If a future change clones the uniform object, the link breaks — worth an audit note for slice 16.
- **Node test vs CI:** the test runs in **bare node** (no `three` needed) because `oscillators.js` is a THREE-free leaf — deliberately, since `materials.js`-importing tests (`test_vfx_material_substrate.mjs`) currently fail under bare node. Slice 16's harness should register `test_vfx_oscillators.mjs` in the **TIER1 (no-three)** bucket alongside `test_vfx_windbend.mjs`.
