# P4 — importance-ranked per-draw light selection (2026-08-23)

Implements the Phase-4 item of `PLAN-2026-08-22-acmelights.md`: replace the retail per-draw
light chooser `Render::minimize_object_lighting` with an importance ranking, so the client can
track many sources and still light every draw with the best ones it can actually see.

Code: **`AcmeLights/Services/LightSelection.cs`** (the engine), one delimited block in
`Services/NativeHooks.cs` (the detour), P4 knobs at the end of `Lib/LightsConfig.cs`, and the
wiring/warm-up in `Services/LightManager.cs` + `AcmeLightsPlugin.cs`.

---

## 1. What retail does, and why it needed replacing

`Render::minimize_object_lighting` — shipped VA **0x0054E090** (acclient.map RVA `0014D090` +
image base `0x00401000`; ACBindings `Rendering/Render.cs` emits the same VA), decomp body at
`acclient.c:380659`, clean `void __cdecl()` with no arguments:

```c
void __cdecl Render::minimize_object_lighting() {
  int used = 0;
  Render::reset_active_lights_state();                                   // 0x0054CA10
  for (i = 0; i < world_lights.num_dynamic_lights; ++i)
    if (used >= 8 || remove_object_light(&sorted_dynamic_lights[i]->info))
         dynamic_light_used[i] = 0;
    else { dynamic_light_used[i] = 1; add_active_light(i, 2); ++used; }  // 0x0054CBC0
  for (j = 0; j < world_lights.num_static_lights; ++j)
    if (used < 8 && (sorted_static_lights[j]->info.type || <sphere overlap>))
         { static_light_used[j] = 1; add_active_light(j, 1); ++used; }
    else static_light_used[j] = 0;
  Render::enable_active_lights();                                        // 0x0054CC90
}
```

It is **first-8-overlap, dynamics first**. Two concrete failure modes:

* **Pool order is not importance order.** The `sorted_*` arrays are ordered by
  `Render::insert_light`'s insertion sort on squared distance **from the viewer**
  (`acclient.c:380524`). That says nothing about how much a light lights *this* object, so in a
  torch-lined corridor the first eight *nearest-to-you* lights win even when three of them are
  behind you contributing nothing to the wall in front of you.
* **Dynamics unconditionally pre-empt statics.** A held torch plus a couple of P3 spell lights
  can consume the whole budget and blank every wall torch in the room.

Callers (`acclient.c:456975`): `RenderDeviceD3D::DrawMeshInternal` calls it once per drawn mesh,
**and only when `!Render::useSunlight`** — i.e. this is an *indoor* path. Outdoors the sun path
runs and P4 is inert by design. That is why every validation step below is in a dungeon.

## 2. What we do instead

Same three native primitives, same output contract; only the *choice* changes.

### 2.1 Eligibility — retail's, bit for bit

A candidate is eligible iff

```
info.type != 0  ||  |L - objCenter|² < (falloff + objRadius)²
```

which is `Render::remove_object_light` (`acclient.c:379681`) inlined. **We never light an object
with a source retail would have rejected**, so no new out-of-range artefact is reachable — the
change is a strict re-ordering of retail's own candidate set. (ACBindings also exposes the native
`Render.remove_object_light` @0x0054CDC0; we inline it instead because a native call per light per
draw is exactly the cost P4 must not pay.)

### 2.2 Ranking — attenuated contribution at the lit object

Retail's own point attenuation (`calc_point_light`, `acclient.c:454579`; the term-for-term port is
`external/holtburger/apps/holtburger-web/src/vertex_bake.rs:71-104`), evaluated at the nearest
point of the object sphere with the best-case half-Lambert:

```
range = falloff * selrange                    // 1.5 = retail rangeAdjust (acclient.c:45742),
                                              //   the SAME multiplier config_hardware_light puts
                                              //   into D3DLIGHT9.Range (acclient.c:453178), so a
                                              //   score of 0 is exactly a light D3D would clip
d     = max(0, |L - objCenter| - objRadius)
atten = d² <= 1 ? 1 : 1/d²                    // retail's wrap/d vs wrap/(d²·d), with N·L̂ = 1
k     = min(1, atten * (1 - d/range) * intensity)   // (1-d/range) is retail's linear window;
                                              //   min(1,·) is its per-channel clamp to the
                                              //   light's own colour (acclient.c:454616)
score = k * luminance(color)                  // Rec.601 0.299/0.587/0.114
```

A strong distant lamp beats a weak near one exactly when the attenuated contribution says so.

Three deliberate choices worth stating:

* **Half-Lambert is evaluated at its best case (`N·L̂ = 1`, so `wrap = d`).** At selection time we
  have an object *sphere*, not vertex normals; over a sphere the wrap term averages out and
  contributes nothing to ranking, while best-case correctly answers the real question — "can this
  light meaningfully reach any vertex of this object?" A light grazing the back of a wall must not
  be dropped just because the sphere centre faces away.
* **Distance is to the sphere surface, not the centre.** `d = |L - C| - R`, floored at 0. A big
  wall segment and a small vase get judged on how close the light is to their *geometry*.
* **`selrange` default 1.5 (D3D `Range`), not holtburger's 1.3 (`STATIC_LIGHT_FACTOR`).** 1.3 is
  the software vertex-bake constant; 1.5 is what the hardware pipeline P4 feeds actually clips at.
  Knob provided if the look argues otherwise.

Non-point lights (`type` 1 DISTANT / 2 SPOT) get a distance-free `min(1, intensity) * luminance`,
which reproduces retail's "never drop a non-point light" behaviour without a cone test.

### 2.3 Scoping — "around corners", but never through them

**No occlusion test exists in this file.** Not a ray, not a geometry query. A bench in front of a
torch does not dim the torch.

The "current cell + PVS-visible cells" scope holtburger builds by hand comes for free here:
`Render::world_lights` is filled during the client's own portal/PVS cell walk
(`CObjCell::add_static_to_global_lights` → `Render::add_static_light`), so the candidate pool
*already is* the `getRenderSet(1)` scope. A torch in the next visible room is in the pool; a torch
in an unseen room is not. We add **no** extra cell filter — filtering further could only remove
lights retail was already showing.

### 2.4 Reference point is the PLAYER, never the camera

Two independent guarantees:

1. Pool membership and its overflow cull are viewer-**position** based (`insert_light`'s
   `distancesq` against `stru_81EF50.m_fOrigin`), with no orientation term anywhere.
2. Our score is a light-to-**object** distance. Both `info.viewerspace_location` and
   `Render::local_object_center` live in the same viewer-local frame (`stru_81EF08`, applied in
   `UpdateLightsInternal` at `acclient.c:453398` and in `viewconeCheck` respectively), and a rigid
   change of frame preserves distances.

No camera vector appears in `LightSelection.cs`. Grep it.

### 2.5 Stability and hysteresis

The invariance in §2.4 is the headline stability result: **because the score depends only on
light-to-object geometry, walking, strafing and turning cannot reorder the set at all.** That is
strictly *better* than retail, whose first-8 is keyed on viewer distance and does reshuffle as you
walk. Stepping behind a pillar changes nothing, because nothing in the score knows the pillar
exists.

Residual churn has exactly two sources: pool membership changing as cells enter/leave the PVS, and
genuinely moving dynamic lights. For those we apply holtburger's Path-B mechanism
(`lighting.js:1775-1792`): a light selected anywhere in the previous frame is an **incumbent** and
has its score multiplied by `selhysteresis` (default **1.15**), so a challenger must beat it by
that margin to take the slot. Incumbency is per light and rolls once per frame, matching
holtburger — there is no per-object incumbency, because `minimize_object_lighting` receives no
object identity (only the sphere, which is expressed in a frame that moves with the player, so it
cannot key a cache).

Flicker is deliberately **not** in the score: we rank on `info.color * info.intensity`, never on the
flickered `d3dLight.Diffuse`. The flame waveform therefore cannot make a slot oscillate.

### 2.6 Budgets and pool sizes — both are ceilings, not choices

* **Per-draw budget 8.** `Render::curLightUsage` is an in-place 8 × 12-byte table
  (`{byte carryOver; int lightClass; int index;}`). Proven twice against the *shipped* map: the
  class column runs `0x84706C`..`0x8470CC`, where `Render::ymin` begins, and the index column
  `0x847070`..`0x8470D0`, where `Render::xmax` begins — and both `add_active_light` and
  `enable_active_lights` loop to exactly those bounds. A 9th slot corrupts `Render::ymin`.
  Per the brief we still read `D3DCAPS9.MaxActiveLights` once at runtime (`GetDeviceCaps`, vtable
  slot 7, caps offset 160) and log it; it can only clamp the budget **down**. `selcaps=0` skips it.
* **Tracked set 60 static + 10 dynamic.** `LightParms` is
  `RenderLight static_lights[60]; RenderLight *sorted_static_lights[60]; int num_dynamic_lights;
  RenderLight dynamic_lights[10]; ...` (`acclient.h:46623`) — a 61st static writes over
  `sorted_static_lights`. P1 already raised the caps to exactly that bound (retail ships 40/7;
  `SetDegradeLevelInternal` reaches 60/10 at `deg_mul` 1). **There is no headroom left to raise**,
  so "handle a lot of lights" is answered by making the best-8-of-70 choice good, which is this.

### 2.7 Static wall-torch flicker (the P2 debt this phase clears)

`enable_active_lights` (`acclient.c:379594`) skips the `SetLight` upload entirely when
`lightCacheing` is set **and** the slot's `carryOver` byte is 1, and `add_active_light` sets
`carryOver = 1` whenever the same `(class,index)` held the same slot on the previous draw — which
is the steady state for a wall torch. That is why P2's per-frame `d3dLight.Diffuse` edits reached
dynamic lights (wiped and refilled each `set_viewer`) but never statics.

Owning the selection lets us clear `carryOver` on **exactly the slots holding a flame light**,
after the `add_active_light` calls and before `enable_active_lights`. Those slots re-upload; every
other slot keeps retail's caching. We never poke the unverified `lightCacheing` global. Knob:
`selflicker` (default 1; also requires `flicker=1`).

The flame predicate now lives in one place — `LightSelection.IsFlameLight` (POINT + warm authored
colour: `r ≥ 0.30, r ≥ 0.92g, r > 1.25b`, holtburger `flameFlicker.isFlameLight`) — and
`LightManager.FlickerPool` calls it, so the set we flicker and the set we re-upload cannot drift.

### 2.8 Cost

Per draw: one snapshot-validity check (5 loads), a flat scan of a packed 48-byte-per-candidate
array (~3.3 KB, L1-resident) with an early `key <= worst` reject, then ≤ 8 `add_active_light`
calls — the same calls retail makes. Zero allocation, no LINQ, no dictionary, no managed arrays
(everything is `NativeMemory`), no logging on the hot path.

The expensive part — gathering colour/intensity/falloff out of the 220-byte `RenderLight` records
scattered behind the `sorted_*` pointer arrays — is hoisted into a **per-viewpoint snapshot**,
rebuilt only when the light set or the viewer transform actually changed (holtburger's "rebuild on
cell-set change only"). Invalidation comes from the existing `UpdateLightsInternal` post-detour —
the exact instant retail recomputes every `viewerspace_location` (`acclient.c:453398`) — with a
sentinel-position check as a belt-and-braces second path.

**The one honest overhead risk** is *not* our scan; it is `SetLight` traffic. `add_active_light`
reuses the slot a `(class,index)` held on the *previous draw*; retail's first-8 is nearly identical
for every object in a cell, so its hit rate is near 100 %, whereas a genuinely per-object set
changes more between adjacent draws. Worst case that is up to 8 extra `SetLight` calls per draw.
`selbudget` is the lever: drop it to 6 and the traffic and the scan both fall. See §4 for the
fps gate.

*(Correction to the 2026-08-22 handoff while we are here: `PrimD3DRender::UpdateLightsInternal` has
no dirty-flag early-out — `Render::update_viewpoint` calls it unconditionally
(`acclient.c:380395`). The observed "stall" was a cell whose whole 3D pass never ran, which also
means `minimize_object_lighting` did not run, so the two stay consistent.)*

---

## 3. Config knobs (`C:\Temp\acdt\lights.cfg`, re-read 1/s)

| key | default | range | meaning |
|---|---|---|---|
| `selection` | **1** | 0/1 | master. `0` at startup ⇒ the detour is never installed (zero footprint, bit-identical retail). `0` live ⇒ the installed detour chains straight to `OriginalFunction` (also bit-identical). |
| `selbudget` | 8 | 1..8 | HW lights per draw. 8 is structural (§2.6); lower it to trade quality for `SetLight` traffic. |
| `selhysteresis` | 1.15 | 1.0..2.0 | incumbent score margin. 1.0 disables hysteresis. |
| `selrange` | 1.5 | 0.5..4.0 | scoring range = `falloff × this`. 1.5 = retail `rangeAdjust`; 1.3 = the software-bake constant. |
| `selflicker` | 1 | 0/1 | clear the `carryOver` byte on flame slots so per-frame `Diffuse` edits reach D3D (static wall-torch flicker). Also needs `flicker=1`. |
| `selcaps` | 1 | 0/1 | read `D3DCAPS9.MaxActiveLights` once and clamp the budget down to it. |

Diagnostics ride the existing `loglights=1` line, once a second:

```
acmelights: frame#N static=S/60 dynamic=D/10 ambient=(...) headlamp=... flicker=1 indoorSun=0
            sel=1 seldraws=NNNN selcand=C selpick=P/B selbail=0
```

* `seldraws` — draws we selected for since the previous line. **0 outdoors is correct** (§1).
* `selcand` / `selpick` / `selbudget` — candidates considered, picked, and the budget.
* `selbail` — cumulative declines (null pools / impossible counts). Should stay **0**.

---

## 4. Live-validation script for the orchestrator

Deploy set and bring-up sequence are unchanged (`AcmeLights/README.md`, and the ~150 s
ACE-session-drop wait from `HANDOFF-2026-08-22-lighting-bloom-next.md`). Everything below is
indoors, because P4 only runs when `!Render::useSunlight`.

**Gate 0 — it installs and does not fault.** Start with the shipped defaults.
Expect in the log:
```
acmelights: hook installed  Render::minimize_object_lighting @ 0054E090 (P4 selection)
acmelights: P4 warmup ok (dry-run picked 8 of 70, slots=8, enable_active_lights@0054CC90)
acmelights: P4 D3DCAPS9.MaxActiveLights=8 ...      (0 = "unlimited" is also fine)
```
A missing `hook installed` line or a `hook FAILED` is a stop. Run 10 minutes outdoors first
(`seldraws=0`, zero crashes) before going in — that isolates "the detour itself is stable" from
"the selection is correct".

**Gate 1 — it actually runs and picks.** `@telepoi` into a torch-lit dungeon (Krau Li's Labyrinth
worked for the P0–P2 captures). Stand in a corridor with several wall torches in view. The 1/s line
must show `seldraws` in the hundreds-to-thousands, `selcand` ≈ the static+dynamic counts,
`selpick` = 8 (or whatever the budget is), and `selbail=0`.

**Gate 2 — the ranking is visibly better.** The A/B is a one-line cfg edit, live, no restart:
1. `selection=0` → wait 2 s → framedump (`dump=1`, `extrahooks=1`).
2. `selection=1` → wait 2 s → framedump.
Stand where **more than eight** lights are eligible — a torch-lined corridor, ideally with a lit
lantern (`@create 42227`, the P3 quick-win weenie) held or dropped nearby so a dynamic competes
with the statics. What to look for:
* `selection=1` should light the wall/floor **in front of you** more evenly; retail's arm tends to
  spend slots on lights behind the camera position.
* Carrying the lantern into the corridor must **not** black out the wall torches (retail's
  dynamics-first starvation). This is the single most legible difference — shoot it first.

**Gate 3 — stability, the "behind a bench" ask.** With `selection=1`, in the same corridor:
strafe left-right past a pillar/bench, and orbit the camera a full 360° in third person. **Nothing
in the lighting may pop, flicker or swap.** Expected by construction (§2.5) — if anything pops,
that is a real bug, not a tuning matter; capture it and set `selhysteresis=1.4` to see whether it
is boundary oscillation or something else.

**Gate 4 — static wall-torch flicker (the P2 debt).** `flicker=1 selflicker=1` (both default).
Stand still, first person (`.`), facing a wall torch, and take 4-6 framedumps ~250 ms apart. The
lit wall patch brightness must **vary frame to frame**. Control: `selflicker=0` → the same shots
must be frame-identical apart from the dynamic lights. This is the first time static-torch flicker
has been observable at all, so it is worth a taildrop pair.

**Gate 5 — fps floor (owner's 60).** The 1070 sits at ~65 fps. In the busiest lit indoor scene you
can reach, sample fps with `selection=1` vs `selection=0`. If `selection=1` costs more than ~2 fps,
step `selbudget` 8 → 6 and re-measure; report both numbers. Do not ship a configuration that
crosses 60.

**Rollback** is one line: `selection=0` in `lights.cfg`. No restart, no redeploy.

---

## 5. Known risks / not done

* **The shipped `minimize_object_lighting` body is modelled from the decomp, not disassembled from
  the shipped exe.** Its *signature* is confirmed shipped-correct (`acclient.map` demangles it as
  `(void)`, ACBindings emits `Cdecl<void>` at the same VA) and the 8-slot table is proven from
  shipped map addresses — but the sibling `minimize_envcell_lighting` DOES differ between builds
  (map says `(Position const&, float)`, decomp says `void()`), so a body difference is not
  impossible. `selection=0` is the escape hatch and Gate 0 is the tripwire.
* **`selection` is read at install time for the detour.** Booting with `selection=0` and then
  setting it to 1 needs a restart (we do not install/uninstall detours at runtime). Going 1 → 0
  live works immediately.
* **`minimize_envcell_lighting` is untouched.** It picks the first eight *dynamics* for a whole
  environment-cell mesh with no ranking at all — the same class of problem, one hook over. Out of
  P4's brief; a clean follow-up.
* **`config_hardware_light` post-hook (per-light specular + spot penumbra) was deliberately
  skipped.** The brief said "only if low-risk". It is a second detour on a function that runs per
  light *insert*, its benefit is invisible without an eye pass, and P4's own risk budget is better
  spent proving the selection. Left for a later phase.
* **Unload race.** `AcmeLightsPlugin.Dispose` disables the hook before freeing the selection
  buffers, but a detour already in flight during `Disable()` is the same pre-existing exposure the
  other three hooks carry. Unload only when idle.
* **`static_light_used[] / dynamic_light_used[]`** are written faithfully, but note that in the
  whole decomp they are only ever *written* (`minimize_object_lighting`, `restore_all_lighting`,
  `minimize_envcell_lighting`) and never read. They look vestigial; we keep them consistent anyway.
