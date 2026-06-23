I have complete evidence. Writing the buildable spec for my slice.

---

# SLICE #14 — DAT-HOOK COEXISTENCE — Build Spec

**One-line:** A SetupModel whose `default_animation` (0x03) already keyframes parts or fires `SetOmega`(22)/`TextureVelocity`(23/24)/`CallPES`(19)/`CreateParticle`(13/26) is **DAT-self-animated**; the suite must never add a component that drives a channel the DAT already owns. Detection is offline C# (DatReaderWriter), baked into the descriptor as the **highest-confidence self-label**; the runtime enforces it at the same bake-peel seam that already routes `defaultAnimationId != 0` away from the frozen path.

## Goal

Prevent **double-animation**: a windmill that DAT-spins must not also receive the suite's `display-spin` omega; a lava pool that DAT-scrolls its texture (`TextureVelocity`) must not also get `texture.flowScroll`; a brazier whose `default_animation` fires `CreateParticle`/`CallPES` must not also get a synthesized ember emitter; a banner with a DAT keyframe clip must not also get a MECH-B `clothRipple`. Conversely, allow **orthogonal composition**: that same DAT-spun windmill *can* still take `weathering.rust` or `emissive.glint` (different channel, no conflict). The rule is **per-channel precedence: the DAT owns every channel its hooks/keyframes drive; the suite may only attach components on channels the DAT leaves free.**

This is a *gating* slice — it adds almost no runtime cost and is a **net GPU/CPU saving** (it suppresses redundant drivers). It is the codification of the corollary in design §1.2 / agenda item #14, and it generalizes the disjoint-peel that `statics.js` already does for tree-wind.

## Design

### A. The channel model (the precise unit of conflict)

A visual "channel" is a render output that exactly one driver may own per object. Map each DAT hook/keyframe and each suite component family to a channel:

| Channel | DAT owns it when default_animation has… | Suite component families on this channel |
|---|---|---|
| `transform` (per-part pos/quat) | ≥2 frames with non-identity per-part deltas (a real keyframe clip — what `buildSceneryAnimationClip` plays, `animated_scenery.js:127-158`) | `procMotion.windBend`, `tipFlex`, `clothRipple`, `limbFlex`, `signSwing`, `pendulum`, `breathScale`, `decayWobble` (MECH-A **and** MECH-B — both move the object's shape) |
| `omega` (root spin) | any hook `SetOmega` (22) | `procMotion.spin` / archetype `display-spin` |
| `uvScroll` (`map.offset` velocity) | any hook `TextureVelocity` (23) / `TextureVelocityPart` (24) | `texture.flowScroll` / archetype `flow-scroll` |
| `particle` (attached emitters) | any hook `CreateParticle` (13) / `CreateBlockingParticle` (26) / `CallPES` (19) | `particle.embers/smoke/motes/leaves/splash/sparkle/breath/orbit/drip` |
| `emissive` (luminous) | any hook `Luminous` (8) / `LuminousPart` (9) | `emissive.glow/pulse/runes/aura/glint/eyes/tint/sheen` |
| `diffuseRamp` | any hook `Diffuse` (10) / `DiffusePart` (11) / `Transparent` (7/20) | `weathering.*` *(rare overlap; usually free)* |
| `scale` | any hook `Scale` (12) | `procMotion.breathScale` |

`hash01`/wall-clock-only material channels that the DAT never touches (most `weathering.*` tarnish/rust/wetness/frost, `emissive.glint` view-sweep) are *always free* and compose unconditionally.

### B. The coexistence rule (verbatim, binding)

> **DAT self-animation wins, per channel.** For each candidate suite component `c` on DID `d`: let `owned = datSelfAnim(d).channels`. If `channel(c) ∈ owned`, **suppress** `c` (do not attach; record `suppressedBy:"dat"`). If `channel(c) ∉ owned`, attach `c` normally — it **composes** with the DAT animation. A component must **never** become a second driver of an owned channel, and must **never** mutate the DAT clip, the hook timeline, or `default_animation_id`.

Two consequences worth stating explicitly:
- **Defer ≠ delete.** The descriptor still records the suppressed component with its reason, so `vfx audit` can surface "would-be effects that the DAT already covers" — and so a future "honor-DAT-params" runtime (drive `display-spin` from the DAT's *own* `SetOmega.axis`) is a clean follow-on, not a re-classification.
- **The conservative Phase-0 guard is the whole-object form:** `defaultAnimationId != 0 ⇒ owned ⊇ {transform}` and the object is already on the `attachAnimatedScenery` path, so **all `procMotion.*` defer**; only always-free material channels compose. The channel-granular table above is the Phase-5 refinement that lets a windmill keep its rust.

### C. Why the precedence is *necessary* (not just tidy) — the gap

`buildSceneryAnimationClip` (`animated_scenery.js:127-158`) builds **only** `part{p}.position` / `part{p}.quaternion` keyframe tracks from the flat frames array. **It never reads `hooks`.** So a scenery `default_animation` that is *purely* a `SetOmega` or `TextureVelocity` hook (no per-part keyframes) currently renders **frozen** even on the animated path. That is exactly the kind of object the suite would be tempted to "fix" with a `display-spin`/`flow-scroll` component — and exactly where double-drive risk is highest if a future change starts honoring the DAT hook. Recording the DAT's owned channels now makes both outcomes safe: the suite defers, and a later scenery-omega player drives from the DAT's declared axis without the suite fighting it. (Contrast the **entity** path, which *does* consume the hooks: `animation.js:787-859` drains `takeHooks()`; `entities.js:_tickHookOmega 12368-12405` integrates `SetOmega`; `_fireCreateParticleHook 12429` fires `CreateParticle`/`CallPES`.)

### D. The "compose, don't double-drive" precedent already in-tree

`_tickHookOmega` already **sums** the `SetOmega`-hook omega and the authored cycle omega into one angular velocity rather than running two spinners (`entities.js:12374-12378`). That is the canonical shape: *one channel, one summed driver.* The suite's coexistence rule is the static-scenery analogue — except the suite's contribution to an owned channel is **zero**, not summed, because the suite has no server-authoritative reason to spin.

### E. Detection (offline C#, the self-label authority)

A new `DatHookScan(uint setupDid)` in `CommandEngine.Vfx.cs`, reusing facilities that already exist:

```csharp
// CommandEngine.Vfx.cs  (new partial; sibling of CommandEngine.SurfaceMaterials.cs)
public sealed record DatSelfAnim(
    uint AnimDid,                 // Setup.DefaultAnimation.DataId, or 0
    IReadOnlyList<int> Hooks,     // sorted distinct AnimationHookType ints present
    IReadOnlyList<string> Channels, // {"transform","omega","uvScroll","particle","emissive",...}
    bool HasKeyframeMotion);      // ≥2 frames w/ non-identity per-part delta

public DatSelfAnim DatHookScan(uint setupDid, string? datPath = null) {
    var dat = OpenPortal(datPath);                       // ResolveDatPath, MotionParity.cs:504-509
    if (!dat.TryGet<Setup>(setupDid, out var setup) || setup == null)
        return new DatSelfAnim(0, Array.Empty<int>(), Array.Empty<string>(), false);

    uint animDid = (setup.DefaultAnimation?.DataId ?? 0);  // ObjectSpriteGenerator.cs:943-944
    if (animDid == 0 || (animDid >> 24) != 0x03)
        return new DatSelfAnim(0, ..., false);
    if (!dat.TryGet<Animation>(animDid, out var anim) || anim?.PartFrames == null)
        return new DatSelfAnim(animDid, ..., false);

    var hookTypes = new SortedSet<int>();
    bool kf = HasNonIdentityPerPartMotion(anim);          // see below
    foreach (var frame in anim.PartFrames)                // MotionParity.cs:570-577
        foreach (var h in frame?.Hooks ?? Enumerable.Empty<AnimationHook>())
            hookTypes.Add((int)h.HookType);               // DRW enum (dats.xml:233-258)

    var channels = ChannelsFor(hookTypes, kf);            // table §A
    return new DatSelfAnim(animDid, hookTypes.ToList(), channels.ToList(), kf);
}
```

- `setup.DefaultAnimation.DataId` — the resolution path is already proven at `ObjectSpriteGenerator.cs:943-944`.
- `anim.PartFrames[i].Hooks` enumeration — proven at `CommandEngine.MotionParity.cs:566-577`; the hook-subtype → name/int mapping at `:633-668`.
- DRW generates `SetOmegaHook`/`TextureVelocityHook`/`TextureVelocityPartHook`/`CallPESHook` from `dats.xml:2696-2703`; the `AnimationHookType` enum ints are `CallPES=0x13`, `SetOmega=0x16`, `TextureVelocity=0x17`, `TextureVelocityPart=0x18` (`dats.xml:253-258`). Detect either by the generated subclass (`case SetOmegaHook:`) or by `h.HookType` int — both are available; prefer the int for a flat switch.
- `HasNonIdentityPerPartMotion`: `anim.PartFrames.Count >= 2` AND some part's Frame Origin/Orientation differs across frames beyond an epsilon. (Single-frame "animations" that exist only to carry a hook are *not* keyframe motion — that distinction is what lets a pure-`SetOmega` windmill report `channels=["omega"]`, not `["transform","omega"]`.)

The Rust crate corroborates the byte layout authoritatively if a DRW field is ever in doubt: hook taxonomy `setup_model_hooks.rs:285-294`, wire sizes `setup_model.rs:72-126`, `SetupModel.default_animation` `setup_model.rs:346`, `Animation.part_frames[].hooks` `animation.rs:22,50` + `setup_model.rs:277-280`.

### F. Classifier integration — the self-label highest-confidence path (design §3.2)

`DatHookScan` runs **first** in the classify pipeline, before any geometry/weenie heuristic:

```
classify(did):
  sa = DatHookScan(did)
  if sa.Channels is non-empty:
      archetype = selfLabelArchetype(sa)   # omega→display-spin, uvScroll→flow-scroll,
                                            # particle→(fire/water context), kf→<keyframe-animated>
      confidence = 1.0
      source = "dat-self-label"            # the highest-confidence rule (§3.2 priority #1)
  else:
      (archetype, confidence) = heuristic(weenie, geometry)   # WeaponType / shape / allowlist …
  # In BOTH branches, attach the union of candidate components for the archetype,
  # then SUPPRESS any component c with channel(c) ∈ sa.Channels.
  components = [ tag(c) for c in candidates(archetype)
                 if channel(c) not in sa.Channels
                 else tag(c, suppressedBy="dat") ]
  emit { did, archetype, confidence, source, components, datSelfAnim: sa }
```

This is the *single source of truth* for coexistence: the offline classifier records `datSelfAnim.channels` in `visual_descriptors.jsonl`, and the runtime never re-derives it.

### G. Descriptor schema addition (sibling `visual_descriptors.jsonl`)

```jsonc
{
  "did": 33555603,                 // 0x02000493 windmill (animated_scenery.js:9 example)
  "archetype": "display-spin",
  "confidence": 1.0,
  "source": "dat-self-label",
  "datSelfAnim": {                 // NEW — the coexistence record
    "animDid": 50334923,           // 0x03000... default_animation
    "hooks": [22],                 // SetOmega present
    "channels": ["omega"],         // DAT owns the omega channel
    "hasKeyframeMotion": false
  },
  "components": [
    { "name": "procMotion.spin",      "channel": "omega",    "suppressedBy": "dat" },  // deferred
    { "name": "weathering.rust",      "channel": "diffuseRamp", "config": { ... } },    // composes
    { "name": "emissive.glint",       "channel": "emissive",    "config": { ... } }     // composes
  ]
}
```

### H. Runtime enforcement (belt-and-suspenders; the descriptor already pre-suppressed)

The descriptor arrives already filtered, so the runtime's job is only to (1) honor it and (2) keep the *pre-existing* whole-object guard as a fallback for DIDs with no descriptor yet:

1. **Pre-existing guard (keep, it IS coexistence):** `statics.js:1584-1590` peels `defaultAnimationId != 0` to `attachAnimatedScenery` and the tree-wind peel at `:1594-1600` runs *after* and is disjoint. Make the disjointness explicit and general: the suite's component-attach hook (the new `getCachedVariant(did, effectName)` / `attachWindTrees`-style call in `bakeStaticsRing`) must run on the **frozen-and-not-DAT-animated** residual set only — i.e. after both peels, on the `statics` array that has already had `defaultAnimationId != 0` removed.
2. **Descriptor-driven attach:** when looking up a placement's descriptor in the bake loop (design §6.3), skip every component with `suppressedBy:"dat"`. Components on free channels attach as normal.
3. **Hard assert (legacy-safety lint hook, slice #13):** `attach(component, inst)` throws if `component.channel ∈ descriptor.datSelfAnim.channels` — guarantees no code path re-introduces a double-driver.

## Integration seams (file:line)

| Concern | Seam |
|---|---|
| DAT hook taxonomy (authoritative wire form) | `crates/holtburger-dat/src/file_type/setup_model_hooks.rs:285-294` (SetOmega 22 / TextureVelocity 23 / TextureVelocityPart 24 / CallPes 19 / CreateParticle 13 / CreateBlockingParticle 26); sizes `setup_model.rs:72-126` |
| `SetupModel.default_animation` field | `setup_model.rs:346`; `Animation.part_frames[].hooks` `animation.rs:22,50` + `setup_model.rs:277-280` |
| `defaultAnimationId` exposed to JS (live-resolved) | `src/lib.rs:1673-1675`, `:1756-1778`, `:2010-2014`, `:2554-2564` |
| **Existing whole-object coexistence peel (outdoor)** | `scene3d/statics.js:1579-1590` (anim peel) → `:1591-1600` (tree-wind peel, disjoint) ; mirror at `:2097-2110` |
| Existing coexistence peel (interior) | `scene3d/cells.js:744-756` |
| Scenery player consumes **keyframes only, not hooks** (the gap) | `scene3d/animated_scenery.js:127-158` (`buildSceneryAnimationClip`); entry `:316-362` (`attachAnimatedScenery`), comment `:307-311` "FILTERED out of the frozen path so they aren't double-rendered" |
| Entity path that **does** consume hooks (contrast) | `scene3d/animation.js:787-859` (`takeHooks` drain) ; `scene3d/entities.js:12368-12405` (`_tickHookOmega`), `:12429` (`_fireCreateParticleHook`) ; SetOmega persistence/desync-proof `entities.js:2171-2179`, `:4200-4206` |
| "Sum one channel, don't double-drive" precedent | `scene3d/entities.js:12374-12378` (hook-omega + cycle-omega summed) |
| **C# detection facility to reuse** | `CommandEngine.MotionParity.cs:566-577` (PartFrames→Hooks walk), `:633-668` (hook subtype switch), `:504-509` (DatDatabase open) ; `ObjectSpriteGenerator.cs:943-944` (`Setup.DefaultAnimation.DataId`) ; `Setup` load `MeshParity.cs:577` |
| DRW hook enum + subclasses | `external/DatReaderWriter/dats.xml:253-258` (enum ints), `:2696-2703` (SetOmega/TextureVelocity[Part] subclasses), `:2681` (CallPES) |
| New code home | `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (new partial) + registration in `TerminalRepl.cs` REPL dict + `JsonCommandProcessor.cs` JSON dict (two-tier per `CommandEngine.cs:26-28`) |
| Geometry inputs for the non-self-label branch | `WorldBuilder.Shared/Lib/OntologyEntry.cs:9-130` (PartCount/AspectRatio/Bounds…) |

## Edge cases & legacy-safety check (per THE RULE)

- **READS only static/derived + clock.** `DatHookScan` reads only DAT `Setup`/`Animation` records (static geometry); the runtime guard reads only `defaultAnimationId` (server-authoritative-derived, never mutated) and the baked descriptor. No server-replicated or mutable-by-server field is read. ✅
- **WRITES nothing the server owns.** The slice's *only* action is to **suppress** suite writes; it removes drivers, never adds them. It never touches the wire value, physics/collision BSP, `default_animation_id`, the DAT clip, or the hook timeline. ✅ It cannot desync — the desync-proof at `entities.js:2171-2179`/`4200-4206` (server `setPose.copy()` stomps any spin) holds regardless, and suppression makes it *more* conservative.
- **Light count:** untouched — the slice never adds/removes lights and explicitly *defers* to DAT `SetLight`(25); no relink risk. ✅
- **`customProgramCacheKey`:** untouched and not per-instance — suppression is a build-time gating decision, not a shader variant. ✅
- **Edge: `CallPES`(19) → PhysicsScript.** A `default_animation` firing `CallPES` may itself spawn `SetOmega`/`CreateParticle` from a 0x33 PhysicsScript. Conservative rule: treat `CallPES` as owning **both** `particle` and (if the PES is unscanned) `transform`+`omega`. Optionally recurse into the PES (`PhysicsScript`/`PhysicsScriptTable` parsing exists), but the safe default is "CallPES present ⇒ suppress all motion+particle components." ✅
- **Edge: per-part `TextureVelocityPart`(24).** Owns `uvScroll` for *that part only*. Phase-0 conservative form treats it as whole-object `uvScroll`-owned; Phase-5 may scope to the part index (carried in the hook payload, `setup_model_hooks.rs:289`). Document the coarsening so it isn't read as "fully part-scoped."
- **Edge: tree-wind allowlist vs DAT anim.** A tree DID that *also* carries `defaultAnimationId != 0` is peeled by the anim peel first (`statics.js:1585`), so the wind peel (`:1595`) never sees it — already correct; the descriptor must reflect this (a tree on the wind allowlist with `datSelfAnim.hasKeyframeMotion=true` ⇒ `procMotion.windBend` suppressed). ✅
- **Edge: single-frame hook-only animation.** Must report `hasKeyframeMotion=false` so it does *not* falsely claim the `transform` channel and block legitimate orthogonal components. Handled by the `≥2 frames, non-identity delta` test. ✅
- **Edge: classifier runs on ORIGINAL DAT.** `DatHookScan` opens `~/ac_base_dats` portal (per `feedback_base_dats_only_for_bake`), never an upscaled/modified DAT — consistent with the slice-16 rule that classification runs on original pixels. ✅
- **Failure mode:** any DAT read failure ⇒ empty `channels` ⇒ object is treated as *not* DAT-animated ⇒ heuristic path. This is the safe default (worst case: a heuristic component attaches to an object that turns out DAT-animated — caught by the runtime whole-object guard #1, since such objects have `defaultAnimationId != 0` and are already peeled to the animated path before the suite attach runs).

## GPU cost

**Effectively zero, and net-negative (a saving).** This slice adds no shader, no uniform, no draw call, no vertex work. At classify time it is one extra `TryGet<Animation>` per self-animating Setup (offline, amortized across the bake; trees and most props have `default_animation==0` so the `Setup`-only fast path returns immediately). At runtime it is a `Set.has(channel)` lookup per candidate component during the bake-peel — sub-microsecond, off the render path. By **suppressing** redundant `procMotion`/`flowScroll`/particle drivers it *removes* CPU mixer-copies, MECH-B vertex ALU, and additive particle overdraw that would otherwise stack on DAT-animated objects — so it strictly improves the §5 Holtburg-budget headroom rather than spending it.

## Build checklist (ordered)

1. **C# — `CommandEngine.Vfx.cs` (new partial):** add `DatSelfAnim` record + `DatHookScan(uint setupDid, string? datPath)` reusing `MotionParity.cs:566-577` (PartFrames→Hooks) and `ObjectSpriteGenerator.cs:943-944` (`Setup.DefaultAnimation.DataId`). Open the portal via the `ResolveDatPath` pattern (`MotionParity.cs:504-509`).
2. **C# — `ChannelsFor(hookTypes, hasKeyframe)`** helper implementing the §A table; switch on the `AnimationHookType` ints from `dats.xml:253-258` (22→omega, 23/24→uvScroll, 19/13/26→particle, 8/9→emissive, 10/11/7/20→diffuseRamp, 12→scale) plus `hasKeyframe→transform`.
3. **C# — `HasNonIdentityPerPartMotion(Animation)`**: `PartFrames.Count>=2` and any part Frame Origin/Orientation delta > epsilon across frames.
4. **C# — classifier wiring:** in the classify entry, call `DatHookScan` **first**; on non-empty `channels` set `source="dat-self-label"`, `confidence=1.0`, pick `selfLabelArchetype`. In *both* branches, suppress candidate components whose `channel ∈ sa.Channels` (mark `suppressedBy:"dat"`), and write `datSelfAnim` into the descriptor.
5. **C# — descriptor schema:** add the `datSelfAnim {animDid,hooks,channels,hasKeyframeMotion}` block and per-component `{channel, suppressedBy?}` fields to the `visual_descriptors.jsonl` writer; surface `DatHookScan` output in `vfx classify <DID>` `signals[]` (so an auditor sees "DAT owns omega" in the feature dump).
6. **C# — `vfx audit`:** add a `dat-self-animated` filter that lists DIDs with non-empty `channels` and any `suppressedBy:"dat"` component (the human-review surface for "DAT already covers this").
7. **JS runtime — attach guard:** at the suite component-attach hook in `statics.js bakeStaticsRing` (post-both-peels, operating on the frozen residual after `:1588`/`:1598`), read the placement's descriptor and skip components flagged `suppressedBy:"dat"`. Mirror in `cells.js` (interior, after `:756`).
8. **JS runtime — hard assert (links to slice #13 lint):** in the component `attach(component, inst, descriptor)` path, throw if `descriptor.datSelfAnim.channels.includes(component.channel)` — a build-time tripwire against any future double-driver.
9. **Tests — C#:** unit-test `DatHookScan` on the cited examples — `0x02000493` windmill (expect keyframe `transform`), a pure-`SetOmega` DID (expect `["omega"]`, `hasKeyframeMotion=false`), a `TextureVelocity` lava/water DID (`["uvScroll"]`), a `CreateParticle`/`CallPES` brazier (`["particle"]`); assert `confidence=1.0, source="dat-self-label"`.
10. **Tests — JS:** assert the attach guard suppresses `procMotion.spin` on a descriptor with `channels:["omega"]` but still attaches `weathering.rust`/`emissive.glint`; assert a tree DID with `defaultAnimationId!=0` never reaches the wind peel (already true via `statics.js:1585` order — add a regression test pinning the peel order).
11. **Round-trip proof (Phase-0 exit bar):** confirm `vfx classify` over the Holtburg ref reproduces today's behavior — every `defaultAnimationId!=0` placement is flagged self-animated and its motion components suppressed, and the tree-wind allowlist round-trips unchanged (design §8 Phase-0 exit bar).
