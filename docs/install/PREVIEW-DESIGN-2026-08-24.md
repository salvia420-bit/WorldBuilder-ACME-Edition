# Live Knob-Change Preview for z-z patcher — design (2026-08-24)

Status: DESIGN ONLY — nothing here is built. Owner guidance: a **reasonable compromise** —
schematic/representative previews, not a game engine. This doc is grounded in the actual plugin
source; every claim about what a knob does cites the file that does it.

---

## 0. Executive summary

| Domain | Verdict | Tech | Effort |
|---|---|---|---|
| **Ragdoll** | Best value; build FIRST. The death fall **is** the plugin's own physics sim, and that sim is already a pure, dependency-free C# module — link the shipped source files into the launcher and the preview runs the *identical* equations. No MotionTable/DAT animations needed at runtime; only ~6 baked skeleton snapshots. | 2D projected stick-skeleton on one `DrawingVisual`, 30 fps `DispatcherTimer` | ~4–5 days |
| **Sky** | Tractable schematic: day/night gradient + noise-cloud layer + star field, CPU-drawn into a small `WriteableBitmap` (~240×135, ~10 fps). Quality/perf knobs (iters/res/steps/TAA) get an honest **cost meter**, not fake visuals. | `WriteableBitmap` | ~2–3 days |
| **Lighting** | ACViewer (MonoGame, GPL-3.0, standalone Game loop, old targets) is **too heavy to embed** — reference only. Hand-roll a 2.5-D "dungeon corridor" lightmap: per-pixel `intensity/d` with the retail hard Range clip, the real flicker waveform, and the real bloom bright-pass/knee/blur — all small enough to run on CPU in a `WriteableBitmap`. | `WriteableBitmap` (per-pixel lighting + bloom post) | ~3–4 days |

Shared: one `IKnobPreview` pane docked beside the Tune list, keyed off the knob's `Cfg`,
driven by the existing single write funnel (`WriteAndCache` in `Ui.BuildTune`). Zero new NuGet
dependencies; the self-contained single-file publish is unchanged. Preview pauses when hidden.

---

## 1. Context: the tool and the seam

- `AcmeLauncher/Ui.cs` builds the whole window in code (no XAML — see the csproj note about the
  Linux dev box). The Tune tab (`BuildTune`, Ui.cs:143–284) is one flat scrolling list of all
  152 knobs from `Knobs.Generated.cs`, grouped by `Plugin · Group` section headers.
- **The seam already exists**: every knob edit — slider, textbox, checkbox, reset, profile load —
  funnels through `WriteAndCache(k, val)` / `Cfgs.WriteKnob` (Ui.cs:153, Config.cs:86). One event
  raised there gives the preview every change, already parsed, with the `KnobDef` in hand.
- Knob metadata (type, min/max, default, cfg name) is generated from the plugin sources by
  `tools/gen_knobs.py` into `Knobs.Generated.cs`, so the preview's clamps can't silently drift
  from the plugins.
- The plugins re-read their cfgs at 1 Hz (`AcmeRagdoll/Lib/LiveMotionConfig.cs`,
  `AcmeSky/Services/LiveSky/SkyConfig.cs`, `AcmeLights/Lib/LightsConfig.cs`), so in-game and
  preview react on the same edit; the preview's job is to be useful when *no client is running*.

### 1.1 Shared architecture

```
Ui.BuildTune
 ├─ existing knob list (left column, unchanged)
 └─ PreviewHost (right column, GridSplitter, min ~340 px)
     ├─ header: [domain auto-follow] [Pause] [collapse ▸]
     └─ active IKnobPreview
          RagdollPreview | SkyPreview | LightsPreview
```

```csharp
interface IKnobPreview {
    UIElement View { get; }
    void SetKnobs(IReadOnlyDictionary<string,string> raw);  // full cfg dict, re-pushed on any change
    void Start();   // begin animating (tab visible, not paused)
    void Stop();    // MUST drop to zero timers/zero CPU
}
```

Rules (all serve "optional and lightweight"):

1. **Auto-follow**: touching a knob whose `k.Cfg` differs from the active preview switches the
   pane (with a manual override dropdown). No three-previews-at-once.
2. **Lifecycle**: `Start()` only while the Tune tab is loaded AND the pane is expanded AND the
   window is active; `Stop()` on `Unloaded` — the exact `DispatcherTimer` start/stop pattern the
   Plugins tab already uses (Ui.cs:126–129). Add `Window.Deactivated` → drop to a frozen frame.
3. **Budgets**: ragdoll ≤ 30 fps (sim-native rate), bitmap previews ≤ 10–12 fps at ≤ 240×135
   back-buffer scaled up by WPF. Target: < 3 % of one core while animating, 0 % stopped.
4. **No new dependencies.** Everything below is in-box WPF (`DrawingVisual`, `WriteableBitmap`,
   `DispatcherTimer`, `CompositionTarget`). Explicitly rejected: MonoGame, SkiaSharp, OpenTK,
   D3DImage interop, `ShaderEffect` (needs an fxc-compiled `.ps` at build time — breaks the
   "builds on the Linux dev box" property the csproj documents). If a preview ever feels slow,
   `ShaderEffect` is the escape hatch to revisit, not the starting point.
5. **Window**: 720×560 today (Ui.cs:27). When the pane is expanded, widen to ~1080; persist the
   expanded/collapsed choice in `Settings` (Config.cs:113).
6. **Fidelity labeling**: every preview carries a one-line caption — "representative preview —
   same math, simplified scene" — so nobody mistakes it for a screenshot predictor.

---

## 2. RAGDOLL preview (build first, deepest)

### 2.1 Ground truth in the plugin

Three motion layers, all tuned by ragdoll.cfg (28 knobs, `AcmeRagdoll/Lib/LiveMotionConfig.cs`):

| Layer | Where the math lives | Knobs |
|---|---|---|
| Death fall (verlet ragdoll) | `AcmeRagdoll/Sim/RagdollSim.cs` — pure C#, zero client deps ("No allocation happens per step… safe to run inside the UpdateParts native detour", header lines 5–34). Per-body params from `Sim/RagdollParams.cs` + `ragdoll_profiles.json` (693 bodies). Per-death variety from `Sim/DeathVariety.cs` + `Sim/DeathVarietyModel.cs` (PCA manifold). | `deathvariety`, `deathvarietystrength`, `deathorientgain` |
| Hit-reaction springs | `Services/LiveMotionRegistry.cs` — the PD spring `Integrate` (lines 1134–1171): `off += vel·h; vel += (−k·off − c·vel)·h`, `k = SpringK·kScale`, `c = SpringDamp·√kScale`, `kScale = CoreStiffMul + (EdgeStiffMul−CoreStiffMul)·looseness`; energy pool + smoothstep gain in `PoolGain` (1185–1192); impulse shaping (settledown/heightbias) in the pending-impulse pass (~1050–1105). | `springk`, `springdamp`, `corestiffmul`, `edgestiffmul`, `coreimpulsefrac`, `energyperdamagepercent`, `impulsevelperenergy`, `poolcap`, `poolhalflife`, `poolgainknee`, `critmult`, `critrefractoryms`, `settledown`, `heightbias`, `ampfrac`, `attackattenuation`, `defaultdamagepercent`, `livemotion` |
| Idle breath / gait | `Sim/IdleMotion.cs` and `Sim/GaitMotion.cs` — both **pure statics by explicit design** ("it is what lets the offline harness compile and drive THE SHIPPED SOURCE FILE rather than a transcription of it", IdleMotion.cs:22–27). | `idlemotion`, `idleamp`, `idlehz`, `idlelingersec`, `gait`, `gaitamp`, `gaitcadence` |

### 2.2 Key question (a): do we need the ~650 MotionTable/DAT death animations?

**No.** In the live plugin the death fall is *not* the retail death animation — it is one
physics fall computed by `RagdollSim`, seeded from the pose at the moment of death
(RagdollSim.cs header: "the live plugin runs ONE physics fall per death then holds the settled
pose"). Not a single ragdoll.cfg knob touches retail keyframes. The retail animations enter in
exactly two places, both of which are already baked into shippable data:

1. **The seed pose** — the offline baker seeds from a beat frame of the retail death anim
   (`tools/dat-patch/ragdoll_bake.py`, `_pose_from_frame(death["frames"][BEAT_FRAMES])`,
   line ~644). For the preview we bake that pose once per representative body.
2. **Per-body character** — already distilled into `ragdoll_profiles.json` (693 profiles:
   params + archetype + per-part `w`/`role`/`ground`), which ships with the plugin.

So the preview needs **the physics + a handful of skeletons**, not the DATs. That is precisely
why this domain is cheap and faithful at the same time.

### 2.3 Key question (b): can the sim be mirrored into WPF?

Better than mirrored — **compiled in unchanged**. The `Sim/` files are pure, `internal`, and
depend only on `System`:

```xml
<!-- AcmeLauncher.csproj -->
<ItemGroup>
  <Compile Include="..\AcmeRagdoll\Sim\RagdollSim.cs"      Link="Preview\Sim\RagdollSim.cs" />
  <Compile Include="..\AcmeRagdoll\Sim\RagdollParams.cs"   Link="Preview\Sim\RagdollParams.cs" />
  <Compile Include="..\AcmeRagdoll\Sim\QMath.cs"           Link="Preview\Sim\QMath.cs" />
  <Compile Include="..\AcmeRagdoll\Sim\IdleMotion.cs"      Link="Preview\Sim\IdleMotion.cs" />
  <Compile Include="..\AcmeRagdoll\Sim\GaitMotion.cs"      Link="Preview\Sim\GaitMotion.cs" />
  <Compile Include="..\AcmeRagdoll\Sim\DeathVariety.cs"    Link="Preview\Sim\DeathVariety.cs" />
  <Compile Include="..\AcmeRagdoll\Sim\DeathVarietyModel.cs" Link="Preview\Sim\DeathVarietyModel.cs" />
</ItemGroup>
```

This is the same "drive the shipped file, not a transcription" discipline the plugin's own
offline harness uses, so the preview's death fall is **bit-identical** to the plugin's for the
same seed/params/pose. Do **not** link `Lib/LiveMotionConfig.cs` (it pulls
Microsoft.Extensions.Logging); the preview builds its own tiny tuning snapshot from the raw knob
dict, clamped by the ranges in `Knobs.Generated.cs` (which are generated *from* that file).

The one part that must be **transcribed** (~120 lines) is the hit-spring layer, because
`Services/LiveMotionRegistry.cs` is welded to native pointers: `Integrate` (1134–1171),
`PoolGain`/`VisualGain` (1179–1192), the pool decay, and the impulse-shaping pass
(direction + `settledown` mix, `heightbias` row weighting, `coreimpulsefrac`, crit gating).
Two options:

- **Preferred (small plugin refactor)**: extract those pure pieces into a new
  `AcmeRagdoll/Sim/SpringMotion.cs` (same pattern as IdleMotion/GaitMotion), have
  LiveMotionRegistry call it, and link it into the launcher. Zero drift forever; the plugin
  gains testability. ~half a day, needs an in-game smoke test.
- **Fallback (no plugin change)**: transcribe into `AcmeLauncher/Preview/SpringMotionMirror.cs`
  with a header comment pinning the source lines. Acceptable — the equations are ~25 lines —
  but future plugin edits can drift.

### 2.4 Key question (c): representative skeletons

Bake **one skeleton snapshot per archetype** (archetype census of the 693 profiles:
biped 202 · floater 149 · blob 47 · quadruped 27 · arthropod 23 · avian 16 · serpent 7 ·
props 221 — props never animate, IdleMotion.cs:84):

| Archetype | Body (suggested) | Why |
|---|---|---|
| biped | Drudge (setup 0x020007DD — the baker's proven pilot species) | most-fought silhouette; multi-root skeleton exercises the orphan-weld path |
| quadruped | Cow / Reedshark | reads instantly as "four legs" |
| arthropod | Olthoi 0x02000F95 | **required** — it is the one body `GaitMotion` targets (GaitMotion.cs:`TargetSetupDid`) |
| avian | Moar/bird rig | wing roles |
| serpent | any of the 7 | long-chain fall looks distinct |
| floater | Wisp | exercises the bob+sway idle branch |
| blob | Slime/jelly | exercises the pulse idle branch |

Snapshot contents per body (a few KB each, embedded resource `preview_skeletons.json`):
`setupDid`, `parent[]` (Setup ParentIndex), `startPos[]` + `startQuats[]` (model-space pose at
the death-anim beat frame — exactly what `ragdoll_bake.py::load_species/_pose_from_frame`
already computes from `client_portal.dat`), plus `looseness[]`, `roles[]`, `ground[]`,
`archetype` copied out of `ragdoll_profiles.json`. Generator: a ~100-line
`AcmeLauncher/tools/gen_preview_skeletons.py` that imports the existing
`tools/dat-patch/datlib`/`motionlib` — no new DAT parsing is written, and the launcher never
reads a DAT at runtime. Regeneration note in the file header, same as `gen_knobs.py`.

### 2.5 The exact preview

**View**: a stick skeleton (one line per parent link — the same bone graph the sim constrains)
drawn via a single `DrawingVisual` re-rendered per tick; hand-rolled turntable projection of
model space (+Z up, documented in ragdoll_bake.py:26–31) — yaw slider / drag, fixed elevation,
ground line + per-part shadow dots. ~40 parts → ~40 lines + 40 dots; rendering cost is nil.
No `Viewport3D` — manual projection of line segments is simpler, and lines don't need lighting.

**Simulation clock**: 30 fps `DispatcherTimer` calling `RagdollSim.StepFrame()` (the sim is
natively 30 fps × 4 substeps, RagdollSim.cs:78–80) and the spring/idle/gait accumulators with
`dt = 1/30`. Offsets combine through the real `IdleMotion.Combine` clamp.

**Showcase loop** (default, per the owner's ask — "a looping skeleton that plays idle +
triggers a death-fall"), with a body picker and a mode strip `[Auto | Idle | Hit | Walk | Death]`:

1. **Idle** 3 s — breathing via `IdleMotion.Build/Accumulate` with live `idleamp`/`idlehz`
   (floater sways, blob pulses — the archetype picker makes these three branches visible).
2. **Hits** — two scripted hits (one normal at `defaultdamagepercent`, one crit) through the
   spring layer: flinch amplitude/ring shows `springk/springdamp/ampfrac/…`; an **energy-pool
   bar** under the skeleton shows `poolcap/poolhalflife/poolgainknee` decaying in real time
   (the pool is otherwise invisible).
3. **Death** — seed `RagdollSim` from the baked pose: `DeathVariety.Perturb` (statics pushed
   from the knob values exactly as `LiveMotionConfig.ReloadCore` does, LiveMotionConfig.cs:389–391)
   → varied params + azimuth + orientCommit → run `FallFramesParam` frames → hold 2 s → reset.
4. **Walk** (Olthoi only) — `GaitMotion.Accumulate` stepping in place; `gait/gaitamp/gaitcadence`.

**Live knob response**: on any ragdoll knob change, rebuild the tuning snapshot immediately (no
1 Hz wait). Spring/idle/gait knobs apply mid-motion (exactly like the live layer — phase is
carried, so retuning `idlehz` mid-breath changes rate without a jump, IdleMotion.cs:49–52).
Death knobs **replay the current death with the same seed**, so the before/after difference is
attributable to the knob, not the dice; a "🎲 new seed" button (and auto-advance in Auto mode)
shows variety spread. A "Δ ghost" option — faintly overdraw the previous settled pose — makes
`deathorientgain`/`deathvarietystrength` changes pop.

**Honest caveats shown in the caption**: in-game, springs/idle ride *on top of* retail
animations and deaths seed from the creature's actual mid-combat pose; the preview seeds from a
canonical pose. Same equations, canonical scene.

### 2.6 Build plan & effort (≈ 4–5 days)

1. (0.5 d) PreviewHost + IKnobPreview + Tune-tab column + lifecycle plumbing (shared with later domains).
2. (0.5 d) Link Sim/ sources; tuning-snapshot builder from the knob dict + Generated clamps.
3. (1 d) `gen_preview_skeletons.py` + embedded JSON + loader (verify Drudge fall settles like the baker's).
4. (1 d) Spring layer: SpringMotion extraction (preferred) or mirror; pool bar.
5. (1–1.5 d) DrawingVisual renderer, projection, mode strip, showcase loop, replay-same-seed, body picker.
6. (0.5 d) Idle/CPU discipline, caption, settings persistence.

Risks: spring transcription drift (mitigated by the extraction refactor); model-space
convention slips (mitigated: the bake doc pins +Z up and the Drudge settle is a known-good
reference); scope creep into "render the real mesh" (**rejected** — sticks are the compromise).

---

## 3. SKY preview (medium)

### 3.1 Ground truth

`AcmeSky/Services/LiveSky/SkyConfig.cs` (35 knobs). The real renderer
(`LiveSkyCompositor` + `CloudShader`/`AtmosphereShader`, D3D11 volumetric raymarch) is
explicitly **not** ported. Useful pure pieces: `SkySunModel.SunHeadingPitch`
(`elevation01 = sin(2π(t−0.25))`, SkySunModel.cs:13–15) and `NightFraction` — small enough to
link or transcribe.

### 3.2 What the preview shows (one `WriteableBitmap`, ~240×135 backing, ~10 fps while animating)

Layered, cheapest-first:

1. **Sky gradient** from sun elevation: `time`/`skytimeoverride`/`timeofs` → elevation via the
   real `SkySunModel` math → a small keyed palette (noon / golden hour / dusk / night), then
   `exposure` as a multiply + gamma before 8-bit write. A time **scrubber** under the preview
   (defaulting to a slow 24-h loop) — mirrors the plugin's own screenshot lever.
2. **Sun & moon discs** at their computed positions; angular size from `sunang`/`moonang`
   (drawn at ~4× true scale with a "×4" note — at real scale a 0.03 rad disc is 2 px), moon
   brightness from `lunar`.
3. **Stars**: hashed static star field, alpha = `stars` × the real `NightFraction` fade.
4. **Clouds**: 2–3 octave value noise (reuse the exact `SmoothNoise1/Hash01` pattern already in
   `AcmeLights/Services/LightManager.cs:161–170`), scrolled slowly, thresholded takram-style so
   `cloudcover` (and `cloudcoverstorm` under storm) remaps coverage 0→clear sky, 1→overcast;
   `cloudturb` toggles a domain-warp octave (visibly curlier edges); `cloudhaze` adds a
   horizon-band whitening; `storm`/`skyweatheroverride` switch to the dark base + storm cover +
   heavier haze (resolution order copied from `SkyConfig.ResolveWeatherClass`, lines 138–149).
5. **Cost meter, not fake fidelity**: `clouditers`, `cloudres`, `cloudminstep`,
   `cloudsunsteps`, `cloudgroundsteps`, `cloudaccurate`, `cloudtaa*` change *quality/GPU cost*,
   which a 2-D noise sketch cannot honestly depict. Show a labeled bar —
   `relative cost ≈ res² × iters/minstep × (1+sunsteps+groundsteps)` — plus one line ("higher =
   smoother clouds, more GPU"). This is the compromise stated out loud instead of faked.

**Excluded** (diagnostic/plumbing, no preview): `live`, `testgradient`, `diag`, `axis`,
`raymode`, `output`, `worldswizzle`, `lutflipv`, `wxmap`, `dump`, `campitch`. Listed in a
"not previewed" tooltip so their absence is deliberate.

Perf: 240×135 = 32 k px; 3-octave noise + gradient ≈ ~1–2 M flops/frame → trivial at 10 fps.
Freeze to a static frame when idle >60 s (clouds stop scrolling; knob changes still redraw once).

### 3.3 Build plan & effort (≈ 2–3 days)

1. (0.5 d) Bitmap preview base class (pixel loop, dirty-redraw, fps throttle) — shared with Lights.
2. (0.5 d) Gradient + sun/moon/stars + time scrubber (link/transcribe SkySunModel pieces).
3. (1 d) Cloud noise layer + storm/turb/haze mappings; eyeball against 1070 screenshots.
4. (0.5 d) Cost meter + captions + excluded-knob tooltip.

Risk: the temptation to chase the volumetric look. The bar is "cloudcover 0.2 vs 0.8 is
obviously different, storm is obviously stormy" — anything past that balloons.

---

## 4. LIGHTING preview (hardest)

### 4.1 ACViewer evaluation — reference, not a dependency

[ACViewer](https://github.com/ACEmulator/ACViewer): ACEmulator's DAT viewer. Findings:
**MonoGame** rendering, **GPL-3.0**, docs target .NET Core 2.1 / .NET Framework 4.7.2 era,
built as a standalone game-loop app over ACE.DatLoader.

- License: GPL-3.0 inside this AGPL-3.0 repo is legally combinable (GPLv3 §13 ↔ AGPLv3 §13),
  so license is *not* the blocker.
- Weight is: embedding means adopting MonoGame (framework + native DX runtime) inside a WPF
  window (fiddly interop), porting off its old targets, and feeding it real DATs through
  ACE.DatLoader at launcher runtime — for "a torch and a portal". It would multiply the
  self-contained single-file publish (`AcmeLauncher.csproj` pins that publish mode) for a
  preview that still wouldn't run the plugin's D3D9 bloom/selection code.
- **Verdict: too heavy. Hand-roll.** Keep ACViewer bookmarked as a visual cross-reference for
  what DAT-authored lights look like.

### 4.2 Why hand-rolling is honest here

`AcmeLights/Lib/LightsConfig.cs` documents the *entire* retail light model in one comment
(lines 105–118, from `PrimD3DRender::config_hardware_light`):
`Diffuse = color × intensity`, attenuation `1/d`, and a **hard clip** at
`Range = falloff × 1.5` — "EXACTLY ZERO beyond that — a hard clip, not a tail". That is a
five-line per-pixel function. The bloom post is likewise fully specified in
`Services/BloomShaders.cs` (bright-pass soft knee, lines 52–55: `soft = clamp((luma − threshold
+ knee)/(2·knee)); contrib = max(luma − threshold, soft²·knee)`, then separable blur passes =
`bloomradius`, additive composite) and the day/night lerp in LightsConfig.cs:63–76. The flame
flicker waveform is CPU value-noise already in `Services/LightManager.cs:147–170`. So a small
CPU renderer can run **the same formulas**, which beats any generic 3-D scene that runs
different ones. Recommendation: **2-D representative, not Viewport3D** — WPF's `Viewport3D` is
per-vertex-lit with its own attenuation model, and has no post-processing, so it can reproduce
neither the hard Range clip nor bloom — the two things the owner's own tuning notes say matter
most (glowrangegain "THE lever", LightsConfig.cs:122–124).

### 4.3 The scene (per the owner: "enough relevant examples… not millions")

One fixed side-view **dungeon corridor strip** (flat-shaded stone rectangles + floor — authored
as code, no assets) rendered into a ~256×144 `WriteableBitmap`, HDR float buffer → bloom →
tone-map, at ~10 fps (flicker/pulse animate). Five emitters + one ambient, chosen to cover the
knob families:

| Example | Emitter model | Knobs it demonstrates |
|---|---|---|
| Wall torch | warm point light, real flicker waveform (`FlickerPhase`/`SmoothNoise1` transcribed from LightManager.cs) | `flicker`, `flickeramp`, `torchlights` (torch on/off), `maxstatic`→(count caption) |
| Portal | purple point, breathing at `glowpulse`; authored i100 f6 (LightsConfig.cs:87) | `glowlights`, `glowportals`, `glowpulse`, `glowportalboost/range/color`, `glowgain`, `glowrangegain`, `glowintensity`, `glowfalloffscale` |
| Lifestone | blue point, i100 f4 (the file's own 6 m worked example) | `glowlifestones`, `glowlifestoneboost/range` — dragging `glowrangegain` visibly moves the hard light edge along the corridor, the exact phenomenon the 2026-08-23 owner note describes |
| Glowing creature (wisp blob) | soft-white point on a small silhouette | `glowcreatures`, `glowcreatureboost/range`, `glowsynthintensity/falloff`, `glowlift` |
| Player + headlamp | forward cone from a stick figure | `headlamp`, `headlampfalloff`, `headlampcolor` |
| Ambient | scene base level | `dungeonambient`, `dungeonambientcolor`, `ambientboost`, `ambientfix` (off = retail red-bias: scale `.r` only — instantly visible) |

Post: the real bloom chain on the HDR buffer — `bloom`, `bloomthreshold/knee/intensity/radius`,
plus a **day/night slider** that drives the LightsConfig day lerp (`bloomday`,
`bloomday*`, `bloomnightamb`/`bloomdayamb`) by re-lighting the strip as "outdoor at ambient X"
— schematic but runs the identical `lerp(night, day, day01)`.

Budget/selection: represent **only `selbudget`** (a counter "6/8 lights lit"; emitters past the
budget visibly drop out, importance-ordered). `selhysteresis/selrange/selflicker/selcaps`,
`glowmax/glowrange/glowscanhz/glowcontain/glowoutdoor*`, projectile/impact knobs
(`glowprojectile*`, `glowimpact*`, `glowschool`) and the whole Memory & stability group
(`mem*`, `diet`, logs/dumps/`extrahooks`) are **excluded** — runtime-pool, PVS and governor
behavior can't be honestly miniaturized. That still previews ~30 of the 84 lights knobs — the
ones players will actually drag — and the pane lists the rest as "in-game only".

Perf: 256×144 × 6 lights ≈ 220 k light-evals + a 4-pass blur on a 128×72 half-res bright
buffer ≈ well under a ms in C#; 10 fps is comfortable.

### 4.4 Build plan & effort (≈ 3–4 days)

1. (0.5 d) HDR float-buffer scene base on the shared bitmap preview class; corridor art-in-code.
2. (0.5 d) Point-light model (`intensity/d`, hard Range clip, `N·L`-lite via a per-surface normal) + ambient + red-bias toggle.
3. (0.5 d) Flicker + pulse waveforms (transcribe LightManager value-noise; deterministic phases).
4. (1 d) Bloom chain (bright-pass knee, separable blur passes, additive) + day/night slider + tone-map.
5. (0.5–1 d) Knob-mapping table (~30 knobs → emitter params), selbudget counter, captions, excluded list.

Risk: the knob-mapping long tail — timebox it to the table above; anything not in the table is
"in-game only" by design, not by omission.

---

## 5. Phasing, and what balloons

**Order: ragdoll → sky → lighting** (matches value density: ragdoll reuses shipped sim code for
near-perfect fidelity; sky is a clean schematic; lighting is the most mapping work per knob).
Total ≈ 9–12 focused days including the shared shell.

Ballooning traps, named so they stay closed:
- Rendering real creature meshes / DAT textures in any preview (sticks and rectangles are the compromise).
- Porting any raymarch/AgX/volumetric code from LiveSky (cost meter instead).
- Embedding MonoGame/ACViewer for lighting (§4.1 verdict).
- Previewing governor/selection/PVS/log knobs (excluded lists in §3.2/§4.3).
- A second physics implementation "close enough" to the plugin's (link the shipped sources; extract SpringMotion).

## 6. Sources read for this design

Plugin ground truth: `AcmeRagdoll/Sim/{RagdollSim,RagdollParams,IdleMotion,GaitMotion,DeathVariety,DeathVarietyModel,QMath}.cs`,
`AcmeRagdoll/Lib/{LiveMotionConfig,RagdollProfiles}.cs`, `AcmeRagdoll/Services/LiveMotionRegistry.cs` (spring/pool passes),
`AcmeRagdoll/ragdoll_profiles.json`, `AcmeRagdoll/AcmeRagdoll.csproj`, `tools/dat-patch/ragdoll_bake.py`;
`AcmeSky/Services/LiveSky/{SkyConfig,SkySunModel}.cs`; `AcmeLights/Lib/LightsConfig.cs`,
`AcmeLights/Services/{LightManager,BloomShaders,LightSelection}.cs`;
launcher: `AcmeLauncher/{Ui,Config,App,Knobs.Generated}.cs`, `AcmeLauncher.csproj`; ACViewer GitHub README.
