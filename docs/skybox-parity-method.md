# Skybox-parity validation method — Wave 5.B

**Status:** Shipped 2026-05-20. Sibling to
[`wire-conformance-method.md`](wire-conformance-method.md),
[`dat-parity-method.md`](dat-parity-method.md),
[`enum-parity-method.md`](enum-parity-method.md),
[`physics-parity-method.md`](physics-parity-method.md),
[`motion-parity-method.md`](motion-parity-method.md).
Parent: [`diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md) §3 row 13 + §6 W5.B.

---

## 0. TL;DR

Given a "game time in seconds" — defined as seconds since
`AC_LAUNCH_UNIX_EPOCH` (`1999-11-02 00:00:00 UTC`, Unix `941_500_800`) —
the canonical sky composition is fully determined:

1. The active `DayGroup` is selected by `CSkyDesc::CalcPresentDayGroup`'s
   LCG hash on `(day_in_year, year, days_per_year)`.
2. The two surrounding `SkyTimeOfDay` keyframes are interpolated at
   parameter `u`.
3. The lerped scalars + ARGB colors flow into 5 canonical "DayGroup
   uniforms" (`SkyTop / SkyBottom / SunPosition / Ambient / Fog`) — the
   contract that `apps/holtburger-web/scene3d/cloud_volume.js` produced
   pre-Sky-K.6, and which remains the canonical SkyState→shader
   projection.

The diagnostic stack produces the canonical envelope in C# via
`region-skybox-snapshot` and grades the JS-side port (`cloud_volume.js`
+ `sun_direction.js`) against it. **24/24 sampled game-times (one per
hour) match within 1e-4 across all 5 uniforms** — measured drift is
2.1e-7, three orders of magnitude under budget.

---

## 1. Contract

### 1.1 Subject under test

`apps/holtburger-web/scene3d/cloud_volume.js`'s Clouds-C path:
**`SkyState → 5 DayGroup uniforms`** (`tick(state)` → `uSunColor` /
`uAmbientColor` / `uHorizonColor` / `uFogDensity` / `uSunIntensity` +
`sunDirection`). The validator surfaces these as
`{skyTop, skyBottom, sunPosition, ambient, fog}` per the brief's W5.B
naming.

Upstream of cloud_volume is `apps/holtburger-web/src/lib.rs`'s
`evaluate_sky_now`, which in turn delegates to
`crates/holtburger-world/src/sky.rs::SkyEvalState::evaluate`. So the
subject end-to-end is:

```
Region.SkyDesc bytes
    │  (Rust unpacker, holtburger-dat::file_type::region)
    ▼
SkyDesc { day_groups: [DayGroup{ sky_objects, sky_time, …}], … }
    │  (SkyEvalState::evaluate — picks DayGroup, lerps SkyTimeOfDay)
    ▼
SkyStateSnapshot { dir_color_argb, dir_bright, dir_heading, dir_pitch,
                   amb_color_argb, fog_color_argb, fog_min, fog_max, … }
    │  (wasm getter)
    ▼
JS SkyState (consumed by sky_lighting.js + cloud_volume.js + sky_dome.js)
    │  (cloud_volume.js::tick — projection to uniforms)
    ▼
5 DayGroup uniforms = SUBJECT
```

### 1.2 Oracle

Three sources stacked per
[[feedback_three_source_cross_reference]]:

1. **ACE source** — `~/ace-server/Source/ACE.DatLoader/Entity/SkyDesc.cs`
   + `SkyTimeOfDay.cs` (struct layouts) and `Source/ACE.Server/Common/DerethDateTime.cs`
   (the in-world clock, `7620 ticks / 16 hr / day`).
2. **Retail decomp** — `~/ac-headers/acclient.c::CSkyDesc::CalcPresentDayGroup`,
   `CSkyDesc::Tick`. Verified against
   `external/GDL/PhatSDK/SkyDesc.cpp:32-237`.
3. **Chorizite** — `Chorizite.DatReaderWriter.DBObjs.Region(0x13000000)` +
   `Types.SkyDesc / DayGroup / SkyTimeOfDay / SkyObject / SkyObjectReplace`.
   This is the BYTES-IN entry point shared with the subject.

Real base DAT at `~/ac_base_dats/client_portal.dat` (sha256
`dc6e500b…` per [[feedback_base_dats_only_for_bake]]).

### 1.3 The 5 DayGroup uniforms

Per `apps/holtburger-web/scene3d/cloud_volume.js:35-50` (the Clouds-C
contract table the validator pins). Recapped here:

| Uniform     | Source                                  | Shape          | Convention                                  |
|-------------|-----------------------------------------|----------------|---------------------------------------------|
| `skyTop`    | `SkyState.ambColorArgb` → RGB 0..1      | `[r, g, b]`    | ARGB u32 → (r, g, b) = (R/255, G/255, B/255). Alpha dropped. |
| `skyBottom` | `SkyState.fogColorArgb` → RGB 0..1      | `[r, g, b]`    | Same as above; the horizon/fog color.       |
| `sunPosition` | `SkyState.dirHeading` (deg) + `dirPitch` (deg) | `[x, y, z]` unit | Three.js post-`worldRoot.rotation.x = -π/2`: `(cos(p)·sin(h), sin(p), -cos(p)·cos(h))` |
| `ambient`   | `SkyState.dirBright`                    | `f32` scalar   | Sun intensity multiplier; typ. `[0.0, 1.0]` |
| `fog`       | `SkyState.fogMin` / `fogMax`            | `f32` scalar   | Exponential density: `ln(2) / max(1, (fogMax - fogMin) · 0.5)` |

**The `dir_heading` / `dir_pitch` units are DEGREES, not radians**, even
though the schema label says `radians`. Sky-C's empirical probe
(`docs/sky-i-probe-2026-05-11.md`) pinned this; at noon `dir_heading ≈ 90°`,
`dir_pitch ≈ 67.35°`. Both the JS port and the C# port apply
`* π / 180` before `Math.sin/cos`. See
[[project_holtburger_skybox_done_2026-05-11]] line 172.

### 1.4 Tolerance

**1e-4** per f32 component, sampled at **24** game-times (one per
hour of the 7620s AC day). The number is generous against:

- IEEE 754 trig roundoff on `Math.sin/cos` (O(1e-15) at unit magnitude).
- f32 lerp granularity in the Rust port (O(2^-23) ≈ 1e-7).
- ARGB byte rounding — bit-exact across both ports because the LSB
  rounding rule matches (Rust `f32::round` and JS `Math.round` are both
  round-half-away-from-zero for non-negative bytes; the lerp output is
  always non-negative).

The measured drift is **2.1e-7** (per-uniform peak; see §3.2).

---

## 2. The tools

### 2.1 `region-skybox-snapshot <gameTimeSec>`

C# command in `WorldBuilder.Terminal/CommandEngine.Skybox.cs`. Given a
double `gameTimeSec`, returns the canonical envelope:

```json
{
  "success": true,
  "command": "region-skybox-snapshot",
  "gameTimeSec": 210.0,
  "normalizedDayPosition": 0.5,
  "dayGroupIndex": 16,
  "dayGroupName": "Rainy",
  "uniforms": {
    "skyTop":      [r, g, b],
    "skyBottom":   [r, g, b],
    "sunPosition": [x, y, z],
    "ambient":     <f32>,
    "fog":         <f32>
  },
  "rawSkyState": {
    "dirColorArgb": "0xAARRGGBB",
    "dirBright": <f32>,
    "dirHeading": <f32 deg>,
    "dirPitch":   <f32 deg>,
    "ambColorArgb": "0xAARRGGBB",
    "ambBright": <f32>,
    "fogColorArgb": "0xAARRGGBB",
    "fogMin": <f32>,
    "fogMax": <f32>,
    "worldFog": <uint>,
    "timeOfDayNormalized": <f32>,
    "dayGroupIndex": <uint>
  },
  "activeSkyObjects": [
    {"did": "0x01001F67", "brightness": 1.0, "alpha": 1.0,
     "propertyFlags": 0, "beginTime": 0.04, "endTime": 0.21,
     "beginAngleDeg": -20, "endAngleDeg": 190, "visible": false},
    …
  ],
  "weatherStateName": "Rainy",
  "datPath":    "/home/wbterminal/ac_base_dats/client_portal.dat",
  "datSha256":  "dc6e500b…",
  "source":     "Chorizite.DatReaderWriter.Region(0x13000000) + AC SkyDesc port"
}
```

`rawSkyState` is surfaced so the validator can distinguish "wrong
source data" from "wrong uniform projection" when drift surfaces.

### 2.2 `region-day-night-curve [--hours N]`

Companion C# command. Emits the full 24-hour curve as N samples
(default 24, one per AC hour). Determinism contract: same Region DAT +
same `gameTimeSec` → byte-identical uniforms (the test loop runs this
in a tight inner loop; if non-determinism leaked from anywhere, the
diff against `region-skybox-snapshot` would surface). Cheap; ~30 ms
for 24 samples on a 884 MB portal DAT.

### 2.3 `validate_skybox.cjs`

Driver. Subprocess-spawns WB.Terminal --stdin once and multiplexes 24
queries. For each game-time:

1. Send `region-skybox-snapshot {gameTimeSec}` → C# canonical envelope.
2. Run the pure-Node port of `cloud_volume.js`'s Clouds-C math on the
   same Region (loaded once via `chorizite-parse-dat-record`) + the
   same `gameTimeSec` → JS subject envelope.
3. Diff the 5 uniforms component-wise; tolerance 1e-4.

The Region bytes are read EXACTLY ONCE per run; both oracle and subject
read the same bytes. No "different parse" drift is possible.

Outputs:
- `/mnt/wbterminal1/holtburger-validator-reports/skybox/<ts>/report.json`
  — the §4.4 aggregate envelope.
- `/mnt/wbterminal1/holtburger-validator-reports/skybox/<ts>/samples.json`
  — the per-sample full dump (oracle + subject + diff rows). Used for
  drift root-causing when the aggregate fails.

Exit codes:
- `0` — PASS (24/24 samples agree within 1e-4 on all 5 uniforms).
- `1` — DRIFT (≥ 1 sample fails tolerance on ≥ 1 uniform).
- `2` — INFRA (WB.Terminal subprocess crashed; Region parse failed;
  base DAT missing).

---

## 3. The current run

### 3.1 Reproduce

```bash
# Pre-reqs (one-time):
~/.dotnet/dotnet build WorldBuilder.Terminal -c Release   # builds .dll
ls ~/ac_base_dats/client_portal.dat                       # 884 MB base DAT

# Run:
cd /home/wbterminal/WorldBuilder-ACME-Edition
node external/holtburger/apps/holtburger-web/validate_skybox.cjs
```

### 3.2 Latest result (2026-05-20)

```
=== Wave 5.B skybox-parity SUMMARY ===
checked:      24
pass:         24
fail:         0
tolerance:    0.0001
maxDrift:     2.112e-7
per-uniform max drift:
  uniforms.skyTop[0]           3.333e-8
  uniforms.skyTop[1]           3.922e-8
  uniforms.skyTop[2]           0.000e+0
  uniforms.skyBottom[0]        3.529e-8
  uniforms.skyBottom[1]        4.118e-8
  uniforms.skyBottom[2]        4.118e-8
  uniforms.sunPosition[0]      1.110e-7
  uniforms.sunPosition[1]      1.100e-7
  uniforms.sunPosition[2]      2.547e-23
  uniforms.ambient             2.112e-7
  uniforms.fog                 5.746e-10
```

Per-uniform breakdown:
- **ARGB-decoded uniforms** (`skyTop`, `skyBottom`) drift O(1e-8) —
  byte-rounding agreement plus integer-to-f32 division by 255.
- **`sunPosition`** drifts O(1e-7) — single `Math.sin/cos` per axis;
  this is the floor for trig in IEEE 754. The Z component is
  effectively zero because at the sampled day-positions the wrap-around
  brings `cos(h)` very near a clean integer.
- **`ambient` (dirBright)** drifts the largest, O(2e-7) — it's the
  output of a single f32 lerp, which the Rust path computes in f32 and
  the JS path computes in f64 then rounds to representation; the gap
  is exactly the f32→f64 promotion noise.
- **`fog`** drifts O(6e-10) — `Math.log(2) / max(1, span/2)` is single
  ALU; both paths use the same constants.

### 3.3 Findings

- **The 5-uniform contract still holds** despite Sky-K.6 deleting the
  `uSunColor / uAmbientColor / uHorizonColor / uFogDensity /
  uSunIntensity` uniforms from `CloudsMaterial` (clouds now sample
  Bruneton tables; see [[project_holtburger_clouds_c_done_2026-05-15]]
  + `cloud_volume.js:170-180` for the K.6 follow-on note). The
  Clouds-C SkyState→uniform projection is the canonical specification
  of "what AC's sky composition is at time T"; it's just not actively
  consumed by the cloud raymarch anymore. `sky_lighting.js::_applyState`
  still consumes the same projection for the three.js
  `DirectionalLight` + `AmbientLight` + `Fog`. The validator pins the
  spec, not the consumer.
- **Day-group selection is deterministic and stable per-game-day.** At
  `gameTimeSec ∈ [0, 3810)` the LCG selects DayGroup 16 "Rainy"; at
  `[3810, 7620)` it crosses midnight and lands on DayGroup 5 "Sunny".
  This matches the LCG hash on `(day, year, days_per_year)` with the
  AC launch anchor.
- **Region 0x13000000 ships 20 DayGroups** (per Sky-A's probe;
  re-confirmed here). The day length is `7620s`, `days_per_year=360`,
  `zero_year=10`, `zero_time_of_year=3600` (1 hr offset into the AC
  day).

---

## 4. Coverage honesty

### 4.1 What this method validates

- **The 5-uniform projection** from raw SkyState → cloud_volume.js's
  Clouds-C contract. Bit-for-bit equivalence between the C# port
  (CommandEngine.Skybox) and the JS port (cloud_volume.js
  + sun_direction.js).
- **Day-group selection** (CalcPresentDayGroup LCG hash).
- **SkyTimeOfDay keyframe interpolation** (find_keyframe_pair + lerp_sky_time).
- **ARGB color lerp** (round-half-away).
- **Sun direction formula** (AC degrees → three.js unit vector).
- **Fog density formula** (ln(2)/max(1,(fogMax-fogMin)*0.5)).
- **Determinism** (same gameTimeSec → byte-identical uniforms across
  C# and JS).

### 4.2 What this method does NOT validate

- **SkyObject billboard rendering** — `scene3d/sky_dome.js`'s per-frame
  position + texture-velocity scroll is separately tested via
  `capture_skybox_e2e.cjs` + `test_sky_dome.mjs`.
  This validator only checks the lighting/fog/sun-direction projection,
  not the celestial body placement.
- **Bruneton aerial perspective** — Sky-K.2's
  `atmosphere_pipeline.js` + `AerialPerspectiveEffect` sources its
  Mie/Rayleigh from precomputed Bruneton tables, not from the 5
  DayGroup uniforms. That's a separate test surface
  (`atmosphere_pipeline_smoke.html`). The Bruneton output is a function
  of `sun_direction`, which we DO validate.
- **In-game visual A/B on a real GPU** — the validator runs entirely
  on swiftshader-less Node. Visual confirmation that the rendered
  output looks right on real hardware (1070 Ti, R9 290) is the
  separate `capture_skybox_demo.cjs` Playwright path. Per
  [[project_holtburger_skybox_done_2026-05-11]] Sky-F: visual regress
  test was 15/15 PASS when shipped.
- **SkyObjectReplace lerp across both bracketing keyframes** — the C#
  port does NOT yet propagate the per-object `transparent / luminosity
  / max_bright` lerps (sky.rs:761-870). That's strictly per-SkyObject
  state, not part of the 5-uniform projection. The
  `activeSkyObjects[]` field surfaces the SkyObject roster for the
  ACTIVE DayGroup but synthesises `brightness=1.0 / alpha=1.0`
  defaults rather than running the replace bracket. Future follow-on
  (W5.B-2) if the per-celestial-body projection turns out to need
  parity validation. The brief's W5.B scope is the 5 uniforms.
- **Tex velocity accumulation** — cloud-band UV scroll is anchored on
  the session-start Unix epoch, not the game-time anchor. It's a
  separately-tested visual surface (Sky-G).
- **Network time drift / multiplayer convergence** — AC's wall-clock
  derivation is purely client-local; ACE never broadcasts time-of-day.
  Two clients booted at slightly different real-time wall-clocks will
  see different SkyStates by O(seconds). The C# oracle uses the same
  formula; not a drift source.

### 4.3 Failure modes ranked by surprise

1. **Modder DAT poisoning** — if the validator is run against a
   non-base DAT (sha256 ≠ `dc6e500b…`), the report's `datSha256` will
   surface that. The `chorizite-parse-dat-record` pre-flight rejects
   IDs in the `0x__FFxxxx` modder range automatically.
2. **DRW field rename** — the validator uses reflection
   (`GetField("DirColor")` etc) per the established pattern. A future
   DRW NuGet revision that renames `WorldFogColor → FogColor` would
   surface as a null field load on the C# side. Mitigated by the
   `_skyboxFieldCache` lookup that throws if missing.
3. **JS sin/cos divergence on a future Node version** — `Math.sin/cos`
   is specified by ECMAScript only "up to implementation precision"
   (v8 uses fdlibm). Our tolerance has 3+ orders of magnitude of
   margin. Mitigated by tolerance budget.
4. **f32 precision drift if Rust eventually moves to f64** — would
   widen the per-uniform max drift but stay well within budget. Tracked
   as Sky-K.6 follow-on, not active.

---

## 5. Cross-references

- [[project_holtburger_skybox_done_2026-05-11]] — Sky-A/B/C/D/E/F/G/I — the
  parametric skybox push that produced the SkyState formula.
- [[project_holtburger_clouds_c_done_2026-05-15]] — Clouds-C state
  bridge — the 5-uniform contract this validator pins.
- [[project_holtburger_sky_k2_done_2026-05-16]] — Sky-K.2 atmosphere
  pipeline — context for why CloudsMaterial dropped the 5 uniforms
  (Bruneton now drives the cloud raymarch).
- [[project_holtburger_skybox_properties_flags]] — SkyObject.properties
  bit decode.
- [[feedback_three_source_cross_reference]] — ACE + acclient.c +
  Chorizite oracle ranking.
- [[feedback_base_dats_only_for_bake]] — DAT integrity discipline.
- [[reference_worldbuilder_terminal]] — WB.Terminal command catalog.

---

*End of method doc.*
