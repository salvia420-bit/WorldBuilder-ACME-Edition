I now have full ground-truth on the bloom pipeline, the light-pool relink discipline, and every per-frame tick seam. Here is the buildable spec for my slice.

---

# Build Spec — Slice 10: BLOOM + LIGHT BUDGET

**Scope:** how emissive visual-behavior components reach the bloom pass safely; the per-frame light-count discipline they must never violate; and a net-new **flame-flicker** effect (archetype #24) that modulates torch/brazier light **intensity only**. All three reconcile against the shipped relink-freeze fix (`project_spell_freeze_light_pool`).

---

## Goal

1. **Bloom strategy** — decide selective vs global bloom for the emissive families (`emissive.glow/pulse/runes/gemFire/glint`, particle embers), and state the real cost-scaling law so the suite knows "how many bloomers before it bites."
2. **Light-budget rules** — codify the hard invariant every emissive/light component obeys: **never change the per-type visible light COUNT** (the freeze), **never make a per-instance `customProgramCacheKey`** (link explosion). Emissive effects spend the *fragment* budget (emissive add + bloom), not the *light* budget.
3. **Flame-flicker (archetype #24)** — a dedicated "flame channel" that jitters intensity on torch/brazier source lights, deterministic + Math.random-free, riding the existing light-pool feed so it produces **zero** relinks.

---

## Design

### A. Bloom strategy — keep GLOBAL threshold bloom; do NOT add selective bloom

The shipped pipeline already has exactly the right primitive. `createAtmospherePipeline` wraps the world in a pmndrs `EffectComposer` with a **HalfFloat HDR** framebuffer (`atmosphere_pipeline.js:132-134`) and a single full-screen `BloomEffect` (`atmosphere_pipeline.js:292-300`):

```js
// atmosphere_pipeline.js:292
new BloomEffect({
  intensity: 1.0,
  luminanceThreshold: 0.85,   // HDR-linear; diffuse sky (~<0.85) stays flat, sun/lava/lit-windows bloom
  luminanceSmoothing: 0.1,
  mipmapBlur: true,           // reuse GPU mip chain → ~0.5ms @1440p on the 1070
  radius: 0.85,
})
```

It runs in HDR *before* `ToneMappingEffect(AGX)` in the EffectPass chain (`atmosphere_pipeline.js:314-322`), so it thresholds true radiance, and is exposed as `pipeline.bloom` (`atmosphere_pipeline.js:330`) with live setters `window.__setBloomIntensity` / `window.__setBloomThreshold` (→ `bloom.luminanceMaterial.threshold`, `index.js:3496-3512`). Gated by quality tier: OFF at low (`quality.js:47`), ON at medium/high/ultra (`quality.js:74,98,119`), built only when `quality.flags.bloom` (`index.js:3200-3204`).

**Decision: GLOBAL, threshold-driven. Reject `SelectiveBloomEffect`.**

| | Global threshold (shipped) | Selective (`SelectiveBloomEffect`) |
|---|---|---|
| Extra geometry pass | none — 1 full-screen mip pyramid | **yes** — re-renders the selected objects to a mask RT (extra draw calls, scales with bloomer count) |
| Cost vs emissive-object count | **constant** (full-screen, object-count-independent) | scales with selected objects → fights the CPU-bound ~20fps budget |
| Membership control | the object's own HDR luminance vs the 0.85 threshold | a `Selection` set the suite must maintain + sync to LRU/eviction |
| Legacy-safety | render-only, no per-object state | adds a parallel render path to babysit |

Selective bloom buys per-object on/off at the price of a second geometry pass — the exact CPU/drawcall cost the design's GPU-headroom rationale (§1.3) tells us to avoid. With global bloom, **membership is decided in the fragment shader**: a component "blooms" iff the surface emits HDR radiance above `0.85` after the emissive add. That is free and already wired.

**The emissive-budget contract (this is the lever every emissive component pulls):**

The suite reuses the resolved luminous path `applyFloatLumDiffuse` (`materials.js:1238-1247`), which sets `emissive=white`, `emissiveMap=diffuse`, and **clamps `emissiveIntensity = min(2.0, sfLuminosity)`** (`materials.js:1246`). That 2.0 ceiling is the bloom-budget governor. Define three **emissive tiers** keyed to the 0.85 HDR threshold:

| Tier | `emissiveIntensity` target (post tone-input) | Blooms? | Use |
|---|---|---|---|
| **sub-bloom** | ≤ 0.6 (peak texel radiance < 0.85) | no | `enchant-shimmer`, `value-tier sheen`, `holy/corrupt tint`, glint base — read as a lit sheen, no halo |
| **soft-bloom** | ~0.85–1.3 | mild halo | `magic-glow ambient`, `spell-school aura`, `glowing eyes` |
| **hard-bloom** | ~1.5–2.0 (capped at 2.0) | strong halo | `glowing-runes`, `gem inner-fire`, lava flow, torch flame core |

A component requests a tier; it never sets a raw intensity above the existing 2.0 cap, so no component can blow the frame to white. Components animate intensity via the shared `uTime` oscillator (slice 07) **within their tier band** — e.g. shimmer = `0.5·(1+0.2·sin)` stays sub-bloom; rune pulse = `1.6 + 0.4·sin` stays hard-bloom.

**"How many emissive objects before mip/bloom cost bites?"** — For the **bloom pass itself: never.** mipmapBlur is a fixed full-screen pyramid; its cost (~0.5 ms @1440p / ~1 ms @1080p, `atmosphere_pipeline.js:288-290`) is **independent of emissive-object count**. What actually scales:
- **Additive-particle fill/overdraw** (embers, gem sparkle): bright additive sprites cross 0.85 → bloom is "free" but the *overdraw* is the cost — governed by the existing particle caps (`maxParticlesPerEmitter`, 220m cull), not by bloom.
- **Visual wash**, not GPU: too many simultaneous hard-bloomers desaturate the frame. This is a *budget*, not a perf wall. Enforce it as a **screen-area cap**, not an object cap: hard-bloom tier is reserved for genuinely-rare objects (runes, gems, lava, flame cores); the classifier must not assign hard-bloom to a high-placement-count DID. `vfx gauge` (slice 11) measures blooming-fragment area on the Holtburg ref and FAILs if hard-bloom emissive coverage > ~5% of screen at the reference camera.

No bloom-pass code change is required — the strategy is "don't touch the pass; govern emissive intensity at the material." The only optional add is a per-archetype default-threshold note for `vfx gauge`.

### B. Light-budget rules (the invariant every light/emissive component obeys)

The freeze (`lighting.js:535-563`): three.js bakes the **count** of *visible* point/spot/dir lights into every lit material's program cache key. Any change to that count relinks **every** lit material — multi-second seize on the 1070's synchronous ANGLE/D3D11 backend. The shipped fix is a **fixed-count light pool** (`lighting.js:584-660`): N=8 point + M=2 spot lights, **always `.visible=true`, never added/removed/toggled, never `castShadow`** (shadow count is *also* in the key, `lighting.js:636`). Real per-part "source" lights stay **permanently `.visible=false`** (`lighting.js:1769`) and are pure position/color/intensity carriers; each frame the nearest sources are copied into the pool slots and unused slots driven to `intensity=0` (`feedSelectedIntoPool`, `lighting.js:699-739`).

**The four binding rules for any light/emissive component:**

1. **NEVER change visible light count.** No `.visible` toggle on a counted light, no `add`/`remove` of a `PointLight`/`SpotLight`/`DirectionalLight` to drive an effect. Modulate **`.intensity` and `.color` only** (uncounted). Drive a light "off" with `intensity=0`, never `.visible=false` (`lighting.js:665-670` `zeroLightPool` is the canonical pattern).
2. **NEVER toggle `castShadow`** on any pooled/counted light — shadow counts relink too.
3. **NEVER make `customProgramCacheKey` per-instance** (`materials.js _patchSetCacheKey`). Emissive effects reuse the existing surface program (`emissive`+`emissiveMap`+shared `uTime`); they ride one stable key per component-SET (slice 01), not per-object.
4. **Emissive effects spend the FRAGMENT budget, not the LIGHT budget.** A glowing rune is `emissive` radiance + bloom, **not** a new `PointLight`. The pool's 8 point slots are reserved for genuine world illuminants (lanterns/braziers/torches). A component MUST NOT consume a pool slot to "make something glow" — that both steals an illuminant slot and risks a count change. (Glowing eyes, gem fire, runes = emissive only; they cast no light.)

These rules are codified as the lint in slice 13; this slice supplies the light-specific forbidden list above.

### C. Flame-flicker design (archetype #24 — `flame-flicker`, `lightIntensityJitter`)

**Net-new effect** (retail had static lights — no flicker precedent; `dwFlickerFilter` in the decomp is a monitor field, not torch animation). A **dedicated flame channel** jitters the **intensity** of torch/brazier/candle source lights deterministically. It rides the pool feed so it inherits zero-relink for free.

**Why it's the cleanest possible integration:** the pool already re-copies `src.intensity → dst.intensity` every frame in `feedSelectedIntoPool` (`lighting.js:713`), even on sort-throttled frames (`lighting.js:1308`). So if the flame channel writes the **source** light's `.intensity` each frame, the pool propagates it automatically with no change to the feed; in legacy `?lightPool=off` mode the source IS the rendered light so it flickers directly. Either path: **intensity-only, no count change, no relink.**

**Data structures**

```js
// per flame source light, stamped at attach time (lighting.js attach loop ~1770):
light.userData.__flame = {
  base: safeIntensity,   // authored intensity (lighting.js:2013) — flicker oscillates AROUND this
  phase: hash01(key),    // deterministic per-instance phase (wind_rig.js:199 hash01), Math.random-free
  // params come from the descriptor config; defaults below
};
// registry on scene3d (subset of activeLights), built/spliced alongside activeLights:
scene3d.flameLights = [];          // push at attach (lighting.js:1770), splice on eviction (releaseLight)
```

`key` for `hash01`: stable + unique per placement — `(setupId * 2654435761 ^ quantize(worldOrigin) ^ partIndex) >>> 0`, using `setupLightOrigin` (`lighting.js:2105`) and the placement's lbKey. Reuses the exact `hash01` from `wind_rig.js:199` so phases are reproducible and audit-diffable, never `Math.random`.

**Detection (which lights are flames)** — priority, mirrors the classifier (slice 03):
1. **Descriptor (authoritative):** the setupId's `visual_descriptors.jsonl` entry carries `flame-flicker`/`fire-particle` → flag every light attached for that setupId. (The same fountain/brazier/torch set already detected for the ambient particle chain, `statics.js:542-543`.)
2. **Day-zero allowlist seed:** a `FLAME_FLICKER_DIDS` Set (mirror `tree_wind.js:64`), gated by `flameFlickerEnabled()` `?flameFlicker=on` (mirror `tree_wind.js:33`).
3. **Fallback heuristic (audit-only, behind `?flameFlickerAuto=on`):** warm color (`color.r > color.b`, decoded sRGB→linear per `lighting.js:2042`) + finite falloff. Never default-on (would catch warm non-flame lanterns).

**The flicker factor (JS — no GLSL; this modulates a light scalar, not a shader):**

```js
// Deterministic, seamless, bounded. amp default 0.18 (±18%), floor 0.55, ceil 1.25.
// Two incommensurate sines + a cheap value-noise wobble = organic, non-repeating-looking flame.
function flameFactor(tSec, f /* light.userData.__flame */) {
  const p = f.phase * 6.2831853;                     // phase in radians
  const a = f.amp ?? 0.18;
  // primary slow sway + faster shimmer (golden-ratio freq ratio → long beat period)
  let s = Math.sin(tSec * 7.0  + p)
        + 0.55 * Math.sin(tSec * 11.3 + p * 1.7)
        + 0.30 * Math.sin(tSec * 23.0 + p * 2.3);    // hiss/crackle
  s *= (1 / 1.85);                                   // normalize Σamp → ~[-1,1]
  const factor = 1.0 + a * s;
  return Math.min(f.ceil ?? 1.25, Math.max(f.floor ?? 0.55, factor));
}
```

`floor=0.55` guarantees the light **never reaches 0** — it never "turns off," so there is never any temptation to `.visible`-toggle and never a count change. Caller writes `src.intensity = f.base * flameFactor(tSec, f)`.

**The tick** — a new `tickFlameFlicker(scene3d)` called once/frame from `tickLightingForCellState` **immediately before** `capActiveLightsByDistance(scene3d)` (`lighting.js:985`), so whichever feed path runs that frame (full `:1364` or throttled `:1308`) reads the freshly-flickered source intensity:

```js
function tickFlameFlicker(scene3d) {
  const reg = scene3d?.flameLights;
  if (!reg || reg.length === 0) return;
  if (!flameFlickerEnabled()) return;           // ?flameFlicker gate (memoized, tree_wind.js:33 pattern)
  const tSec = scene3d.frameTime?.tsSec          // shared wall-clock (loop.js:817-825 / index.js:1775)
    ?? (typeof performance !== "undefined" ? performance.now() * 0.001 : 0);
  for (let i = 0; i < reg.length; i++) {
    const L = reg[i], f = L.userData?.__flame;
    if (!f) continue;
    L.intensity = f.base * flameFactor(tSec, f);  // INTENSITY ONLY — never .visible, .castShadow, count
  }
}
```

Cost bound: `flameLights` holds only flagged flames (dozens in a dense dungeon, ~0 outdoors). If a region ever exceeds a soft cap (e.g. 64), gate the modulation to the pool-selected sources only (the ≤8 `pool.selPoint`), since unselected sources aren't rendered anyway — `O(8)`/frame worst case. Reuses the same clock as `tickTerrainUTime` so we don't grow a clock zoo.

**Coupling to embers (archetype #25):** when a brazier carries both `flame-flicker` (light) and `fire-particle` (embers), they share `phase` so the light brightens as embers puff — but they're independent writes (light intensity vs particle emitter); no new coupling code.

---

## Integration seams (file:line)

| Seam | Location | What changes |
|---|---|---|
| Bloom config | `atmosphere_pipeline.js:292-300` | **no change** — global threshold bloom is the strategy |
| Bloom EffectPass order / HDR | `atmosphere_pipeline.js:132-134`, `:314-322` | unchanged; emissive components rely on bloom-before-tonemap |
| Bloom live tuning | `index.js:3496-3512` (`__setBloomIntensity`/`__setBloomThreshold`→`luminanceMaterial.threshold`) | reuse for `vfx gauge` A/B; no change |
| Emissive intensity cap (budget governor) | `materials.js:1246` (`min(2.0, sfLuminosity)`) | emissive components request a **tier** within this cap; cap stays 2.0 |
| Luminous emissive path | `materials.js:1238-1247` `applyFloatLumDiffuse` | reused by all emissive components (slice 07 drives `uTime`) |
| Light pool alloc / discipline | `lighting.js:584-660` | **no change** — components must obey the count rule |
| Pool feed (intensity copy) | `lighting.js:699-739` `feedSelectedIntoPool` | **no change** — flame flicker rides the existing `src.intensity → dst.intensity` copy (`:713`) |
| Pool throttled-frame feed | `lighting.js:1304-1310` | flame must update source intensity every frame so the throttled feed still flickers |
| Light attach loop (flag flames) | `lighting.js:1719-1771` (push to `activeLights` at `:1770`; pool forces `inst.visible=false` at `:1769`) | stamp `inst.userData.__flame` + push to `scene3d.flameLights` |
| Authored base intensity | `lighting.js:2013` `safeIntensity`; userData at `:2103-2112` | `__flame.base = safeIntensity` |
| Per-frame tick host | `lighting.js:805` `tickLightingForCellState`; call `capActiveLightsByDistance` at `:985` | insert `tickFlameFlicker(scene3d)` at `:984` (before cap) |
| Shared clock | `loop.js:817-825` (`frameTime.tsSec`), stamped `index.js:1773-1775` | reuse; no new clock |
| Flag pattern + allowlist seed | `tree_wind.js:33` (`treeWindEnabled`), `:64` (`TREE_WIND_DIDS`) | clone to `flameFlickerEnabled()` + `FLAME_FLICKER_DIDS` |
| hash01 (per-instance phase) | `wind_rig.js:199` | reuse verbatim for `__flame.phase` |
| Eviction splice | `lighting.js` `releaseLight`/`lightsByLbKey` path (~`:1389-1445`) | splice from `scene3d.flameLights` alongside `activeLights` |

---

## Edge cases & legacy-safety check (per THE RULE)

- **READS only static/derived + client clock.** Flame reads: `__flame.base` (the authored DAT `LightInfo.intensity`, static), `__flame.phase` (deterministic `hash01`, static), and `frameTime.tsSec` (client wall-clock). Bloom membership reads the surface's own HDR radiance. **No server-replicated or mutable-by-server input.** ✓
- **WRITES only render-time, non-replicated.** Flame writes `light.intensity` (a render-only THREE scalar the server never stores or replicates — there is no "light intensity" wire field; lights are pure client geometry from `client_portal.dat`). Emissive writes cloned-material `emissive`/`emissiveIntensity`. **Never wire/physics/collision/replicated transform.** ✓
- **Never changes light COUNT.** Flame floor=0.55 guarantees lights never drop to 0-and-toggle; modulation is intensity-only; `flameLights` are flagged at attach but **not** added/removed to drive the effect. Bloom adds no lights. ✓ (This is the whole point of `project_spell_freeze_light_pool`.)
- **Never `castShadow` toggle.** Flame touches only `.intensity`; pooled lights keep `castShadow=false` (`lighting.js:636`). ✓
- **Never per-instance cache key.** Emissive reuses the existing surface program + shared `uTime`; no `customProgramCacheKey` per flame/glow. ✓
- **Bloom degrades gracefully off the atmosphere path.** If the composer/bloom isn't built (low tier, `quality.js:47`, or legacy renderer), emissive surfaces still add radiance via the material — they just lack the halo. No crash, no missing-effect error. ✓
- **Indoor/outdoor flip safety.** Flame source lights are *carriers* (`.visible=false` in pool mode); the indoor sun-intensity-zero trick (`lighting.js:836-851`) is untouched. A flame inside a dungeon flickers via the pool exactly as a daylight brazier does. ✓
- **Throttled sort frames.** `capActiveLightsByDistance` may skip the re-sort but **always** re-feeds the pool (`lighting.js:1308`); since `tickFlameFlicker` runs *before* the cap and writes source intensity unconditionally, flicker is smooth even on throttled frames. ✓
- **DAT self-animated lights (slice 14).** A setup whose `default_animation` already drives its lights must NOT also get flame-flicker — the classifier defers (DAT self-label wins). Flame is allowlist/descriptor-gated, so this is a classifier rule, not a runtime collision. ✓
- **Don't double-bloom the sun.** Sun/sky already bloom via the same threshold; emissive tiers are tuned so suite glows read *below* the sun's HDR magnitude (sun is "many orders over diffuse," `atmosphere_pipeline.js:256-257`) — no component competes with or recolors the sun's halo. ✓

---

## GPU cost

- **Bloom pass:** **constant**, object-count-independent — ~0.5 ms @1440p, ~1 ms @1080p on the GTX 1070 (`atmosphere_pipeline.js:288-290`). Already paid today (default-on medium+). Adding emissive components adds **0 ms** of bloom-pass cost.
- **Emissive add per material:** negligible — the `emissive + emissiveMap` term is already compiled into the surface fragment; a shimmering `emissiveIntensity` is a uniform write (slice 07), not a relink. Cost class **cheap**.
- **Additive-particle bloom (embers/sparkle):** cost is the additive **overdraw/fill**, bounded by existing particle caps (220m cull, `maxParticlesPerEmitter`), not by bloom. Cost class **medium**.
- **Flame-flicker tick:** `O(num flames)` JS scalar writes/frame, ~dozens worst case (≤8 if gated to pool-selected). Sub-microsecond; **zero** GPU cost (it only changes an already-uploaded light uniform the pool re-uploads every frame regardless). Cost class **cheap**. Crucially: **zero relinks** — the entire point.
- **`vfx gauge` ceiling enforcement (slice 11):** FAIL if hard-bloom emissive screen-coverage > ~5% on the Holtburg 222-placement ref, or if any emissive component is found consuming a `PointLight`/`SpotLight` slot, or if program count changes across an A/B flame on/off (proves no relink).

---

## Build checklist

1. **(JS, no rebuild) Flag gate + allowlist seed.** In `tree_wind.js` (or a new `vfx_flags.js`), add `flameFlickerEnabled()` memoized off `?flameFlicker=on` mirroring `treeWindEnabled` (`tree_wind.js:33`), and a `FLAME_FLICKER_DIDS` Set seed mirroring `TREE_WIND_DIDS` (`tree_wind.js:64`). Add `?flameFlickerAuto=on` for the warm-color fallback.
2. **(JS) Flame detection + flag at attach.** In the attach loop `lighting.js:1737-1789`, after `scene3d.activeLights.push(inst)` (`:1770`), resolve the setupId against the descriptor (or `FLAME_FLICKER_DIDS`); if matched, set `inst.userData.__flame = { base: safeIntensity, phase: hash01(stableKey(setupId, setupLightOrigin, partIndex)), amp: cfg.amp ?? 0.18, floor: 0.55, ceil: 1.25 }` and push `inst` to `scene3d.flameLights` (init the array next to `activeLights` at `lighting.js:1500-1503`). Import `hash01` from `wind_rig.js:199`.
3. **(JS) Flame registry eviction.** In `releaseLight`/the `lightsByLbKey` eviction path (`lighting.js:~1389-1445`), splice the evicted light from `scene3d.flameLights` alongside `activeLights` (guard: no-op if absent).
4. **(JS) `tickFlameFlicker(scene3d)`.** Add the function (factor + tick from §C) in `lighting.js`; call it at `lighting.js:984`, immediately before `capActiveLightsByDistance(scene3d)`, inside `tickLightingForCellState`. Read `scene3d.frameTime.tsSec` (`loop.js:817-825` pattern). Soft-cap to pool-selected sources if `flameLights.length > 64`.
5. **(spec only) Emissive tier contract.** Document the three tiers (§A) in the component config schema (slice 01/02): each emissive component declares `bloomTier: 'sub'|'soft'|'hard'`; the runtime maps tier→target `emissiveIntensity` band, always ≤ the 2.0 cap at `materials.js:1246`. No code change to the cap.
6. **(spec only) Light-budget lint inputs.** Hand slice 13 the forbidden-write list: a component manifest is INVALID if it writes `light.visible`, `light.castShadow`, adds/removes any `Light`, mutates `pool.point/pool.spot` length, or sets a per-instance `customProgramCacheKey`. Provide the desync proof: `feedSelectedIntoPool` only ever writes `intensity`/`color`/`position` (`lighting.js:699-739`), never count.
7. **(gauge) A/B no-relink assertion.** In `vfx gauge` (slice 11), capture `renderer.info.programs.length` with `?flameFlicker=off` vs `on` over 600 frames on the Holtburg ref; **PASS iff program count is identical and flat** (proves intensity-only flicker triggers zero relinks). Add the hard-bloom screen-coverage check (FAIL > ~5%).
8. **(gauge) Bloom-cost confirmation.** Confirm bloom pass time is invariant as emissive-object count grows (sweep 0→all Holtburg emissives via `__setBloomIntensity`/`__setBloomThreshold`, `index.js:3496-3512`); record in the budget report so future archetypes know bloom is a flat cost.
9. **Exit bar.** `?flameFlicker=off` is byte-identical to today (flame tick early-returns); `?flameFlicker=on` flickers nearby torches with **0 shader relinks**, **0 light-count changes**, no console errors; bare-default load unaffected (default-OFF until graduated per the allowlist-first roadmap, §8 Phase 1).
