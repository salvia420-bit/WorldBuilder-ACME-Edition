# ACME Ragdoll

A Chorizite plugin that gives **runtime physics ragdoll deaths to every creature** in the
retail Asheron's Call client — humanoids included — by injecting into the client's own
per-part pose pipeline. No DAT edits, no MotionTable bake, no server/emote dependency: this is
the "works for every monster" answer the data-only Route A lane (baked death animations) can't
give.

It is the **Route B** design from
`docs/dat-patch/research/ragdoll-deaths-research.md`, built out. It composes with Route A
rather than replacing it: Route A raises the floor for all kit users; this is the ceiling for
plugin users, and only plugin users see it (cosmetic-local).

> **Status: compiles clean; NOT yet validated in a live client.** The hook wiring and the
> ported simulation are complete and build with zero warnings, but nothing here has run inside
> a 32-bit acclient. Validation is a 1070 injection session — see
> **[In-client test procedure](#in-client-test-procedure-1070)** and **[Risks](#top-risks--what-is-unverified)**.

---

## What it does (the mechanism)

The client re-applies every creature part's pose **every tick**. The last writer is
`CPartArray::UpdateParts` (decomp `acclient.c:326601`, shipped-exe VA `0x00519C20`):

```
for each part i:  Frame::combine(&parts[i]->pos.frame, objFrame, animframe->frame[i], &scale)
```

`CSequence::get_curr_animframe` never returns null (it falls back to the placement frame), so
the pose is re-asserted forever. Therefore the only durable way to move parts is a **post-hook
overwrite of `parts[i]->pos.frame` every frame** — exactly the "last-rig-writer slot" discipline
the web client uses. That is what this plugin does.

### Hook points

| Function | VA | Conv | Role |
|---|---|---|---|
| `CPhysicsObj::MotionDone(this, motion, success)` | `0x00510880` | thiscall | **Death signal.** Always active. Filters `motion == MotionCommand.Dead (0x40000011)` and arms a ragdoll for that object. |
| `CPartArray::UpdateParts(this, frame)` | `0x00519C20` | thiscall | **Per-part pose writer.** Hot; armed only while ≥1 ragdoll is live. Post-detour: forward the original, then overwrite the owned parts. |

Both are inline trampoline detours via **Reloaded.Hooks 4.3.3**, the same engine and the exact
pattern Chorizite's own bootstrapper uses (`external/chorizite/.../Hooks/ACClientHooks.cs`,
`HookBase.cs`): a `[Function(MicrosoftThiscall)]` delegate + an
`[UnmanagedCallersOnly(CallConvMemberFunction)]` static detour that chains through
`OriginalFunction(...)`. `CPartArray` has no vtable, so AcmeRedline's vtable-swap technique does
not apply here — inline detours are required.

### The per-frame pipeline (inside the `UpdateParts` post-detour)

1. `owner = partArray->owner`; look the object up in the registry by its stable id
   (`CPhysicsObj → LongHashData → HashBaseData.id`). Not ragdolling → return.
2. **First frame after death (seed):** read the live part world poses + the object world frame
   (`frame`) + the part-array `scale`, convert each part to **model space** (the inverse of the
   client's scaled `combine`), read the skeleton from `CSetup::parent_index`, and build the sim.
3. **Each frame:** step the sim (or hold the settled pose), then for each part write the new
   world Frame:
   - `worldOrigin = objOrigin + Rotate(objQuat, scale ⊙ modelOrigin)`
   - `worldQuat   = objQuat · modelQuat`
   - write `qw..qz` and `m_fOrigin`, then call **`Frame::cache()`** (`0x00535B30`) to recompute
     the cached 3×3 `m_fl2gv` — *the draw path reads the matrix, not the quaternion*, so this
     recompute is mandatory (the `UpdateObjectInternal` discipline the research flags).

All part pointers are **re-resolved from the live `CPartArray` every frame and null-checked**;
no `CPhysicsPart*` is ever cached across frames (corpses despawn — the #1 lifetime trap).

### Why it's render-only-safe

Creature setups have **no per-part physics BSP** (`CSetup::has_physics_bsp == 0`, which the
plugin checks before arming), so collision uses the setup spheres, not the part frames. Writing
part frames is therefore render-only for creatures. `pos.objcell_id` is left untouched;
bounding-box/LOD read `pos`, which is acceptable.

---

## The ported simulation

`Sim/RagdollSim.cs` is a faithful C# port of the validated verlet ragdoll
`tools/dat-patch/ragdoll_bake.py` (the offline baker), which is itself the port of
`external/holtburger/apps/holtburger-web/scene3d/ragdoll.js` (default-ON in the web client since
2026-08-02). `Sim/QMath.cs` ports its quaternion helpers 1:1 (including the `mulberry32` PRNG,
bit-for-bit, for determinism).

**Ported (the core the brief asked for):**

- one verlet particle per Setup part;
- distance constraints along the parent + grandparent links of `ParentIndex` (bone + bend),
  plus offline-style **orphan "weld"** links so a multi-root skeleton (e.g. the Drudge's two
  free hip chains) doesn't free-fall apart;
- the per-joint randomized **give schedule** + spanning-anchor **rigidity braces**;
- a seeded **directional topple** impulse (ω×r) + twist + shove + jitter;
- **model-space gravity** (−Z; AC model space is +Z up) and a flat **ground plane** at foot level;
- the **penetration-tracking contact pass** + per-node **speed / up-speed caps** — the part that
  actually fixed ragdoll.js's "fly-away";
- the **bone-swing orientation** derivation (restDir → current bone dir; leaves inherit the
  parent's swing).

**Deliberately dropped for live v1** (per the brief): wall/env collision, the energy governor's
ratcheting cap, and — unlike the offline multi-variant baker — the shared-sprawl blend and the
variant fan. The live plugin runs **one** physics fall per death (~3 s at 30 fps) then holds the
settled pose until the corpse despawns or a hold cap elapses.

Determinism: each death seeds from the object id, so a given corpse falls the same way every
time, and the topple direction is a deterministic hash of the id.

---

## Files

```
AcmeRagdoll.csproj            build contract (mirrors AcmeRedline + Reloaded.Hooks 4.3.3)
manifest.json                 Chorizite plugin manifest (Client environment only)
AcmeRagdollPlugin.cs          IPluginCore entry: install hooks in the Client env, tear down on unload
Lib/AddressResolver.cs        managed sig-scanner + proven VA fallback; ClientFunctions VAs/patterns
Lib/RagdollSettings.cs        ISerializeSettings<T> + source-generated JsonContext (Enabled switch)
Services/NativeHooks.cs       Reloaded.Hooks detours on UpdateParts + MotionDone; dynamic arm/disarm
Services/RagdollRegistry.cs   per-object registry: seed / step / write parts / lifetime + prune
Sim/RagdollSim.cs             the ported verlet sim (model space, no per-step allocation)
Sim/QMath.cs                  quaternion/vector helpers + mulberry32 (ported 1:1)
```

Build: `DOTNET_ROLL_FORWARD=LatestMajor dotnet build AcmeRagdoll -c Release` (dotnet at
`~/.local/bin`). Output is just `AcmeRagdoll.dll` + `manifest.json`; no host assemblies are
copied (all framework refs are `ExcludeAssets="runtime"`).

---

## How addresses are resolved

`Lib/AddressResolver.cs` resolves each hooked function by, in order:

1. **A self-contained managed signature scan** of `acclient.exe`'s image (reads the main module
   bytes once, matches an IDA-style `AB ?? CD` pattern). This reimplements Chorizite's
   `SigScanner` idea without its native `SigScan.dll`, which isn't on a plugin's load path.
2. **A hard-coded VA fallback** — the address from **Chorizite.ACBindings**. Unlike the decomp
   line numbers, the ACBindings addresses are extracted *from the shipped acclient.exe* (every
   ACBindings thiscall thunk is a literal call through such a VA, and AcmeRedline reads client
   globals at literal VAs successfully). Chorizite's `ACClientHooks` likewise hooks by literal
   VA. So the VA is the **proven** address for the client build this kit ships.

> **Honest caveat:** the sig-scan *patterns* in `ClientFunctions` are `PLACEHOLDER`s — a real
> prologue signature has to be captured from a live client. Until then, `Resolve` skips the scan
> and returns the proven VA. If a future/third-party client build shifts addresses, drop a
> verified pattern into `ClientFunctions.UpdateParts_Sig` / `MotionDone_Sig` and the scanner
> takes over automatically.

## Reloaded.Hooks sharing

Reloaded.Hooks is referenced `ExcludeAssets="runtime"` so the plugin **compiles against** it but
**binds at runtime to the single copy the Chorizite bootstrapper already loaded**
(`Chorizite.NativeClientBootstrapper.csproj` → `Reloaded.Hooks 4.3.3`). Sharing that one
assembly identity keeps `ReloadedHooks.Instance` a single process-wide hooking engine instead of
a competing second one — the footgun AcmeRedline's `DeviceHooks` avoids by not using Reloaded at
all. **Unverified at runtime:** that the collectible plugin `AssemblyLoadContext` resolves
Reloaded.Hooks from the host context (it does so for the Chorizite/ACBindings project refs; the
same fallback should cover this package ref, but confirm in-client).

## Unload safety

Both hooks are `Disable()`d on plugin `Dispose()`, and the registry is marked down (its detours
then no-op). As with AcmeRedline's device hooks, a collectible-ALC **hot-unload while a
trampoline still points at our stub is inherently unsafe** — Reloaded's trampoline and our
`UnmanagedCallersOnly` stubs die with the ALC. The safe operational model is: unload only when
idle, and **restart the client rather than hot-reloading this plugin**. A fully unload-safe
design (RWX thunks whose jump target is rewritten on unload) is the same deferred work
AcmeRedline documents; it needs a live 32-bit client to validate and is out of scope for v1.

---

## In-client test procedure (1070)

This plugin **cannot be validated on this box** (headless laptop, no 32-bit acclient). It needs a
real client injection session on the 1070. Steps:

1. Build Release; copy the `AcmeRagdoll` output dir (dll + manifest.json) into the Chorizite
   plugins directory alongside the other plugins.
2. Launch the retail client through Chorizite; confirm the log line
   `ragdoll: hooks installed (MotionDone …, UpdateParts …)` and no install error.
3. Spawn / find a creature (start with a **Drudge** — the sim's reference species, ~13 parts,
   multi-root skeleton). Kill it.
4. **Expected:** at death the body topples and settles under physics into a slumped pose, then
   holds it as a corpse — distinct every species, and working on **humanoids** (the thing baked
   death anims can't generalize).
5. Repeat with: a large multi-part creature (Olthoi), a biped humanoid (Banderling/Drudge), and
   a small one; kill several at once to exercise the concurrent registry and the arm/disarm of
   the hot hook (watch for `LiveCount` crossing 0 → the UpdateParts detour should disable).
6. Kill something and walk >96 m away and back (object deactivates → `UpdateParts` stops → sim
   freezes at range; should resume/stay settled, not glitch).
7. Unload the plugin **only** with no ragdolls live; if the client crashes on unload, that's the
   documented unload-safety limitation — restart instead.

### What to watch / tune in-client

- **Death timing.** `MotionDone(Dead)` fires when the *Dead motion finishes*, so v1 seeds the
  ragdoll from the end-of-death pose (it follows, rather than replaces, the authored death anim).
  If you want the ragdoll to *replace* the death animation, move arming to where the Dead motion
  is *started* instead. This is the single most likely tuning change.
- **Model-space assumptions.** Seeding assumes part poses and the object frame share the object
  cell space and that model +Z is up. Confirm the body falls *down*, not sideways/through the
  floor; if gravity looks wrong, the model-space Z axis or the object-frame inverse is the place
  to look.

---

## Top risks / what is UNVERIFIED

Everything below is untested until the 1070 session:

1. **`m_fl2gv` correctness.** The draw reads the cached matrix. We write the quaternion + origin
   and call `Frame::cache()` to rebuild the matrix. If `cache()` isn't the right/complete
   recompute (or the draw reads `draw_pos` filled by `calc_draw_frame` from a *different* cached
   field), parts render at the wrong orientation. **Highest-value thing to verify first.**
2. **Part-pointer lifetime / crashes.** Corpses despawn and part arrays can be rebuilt. We
   re-resolve + null-check every frame and verify the captured `CPhysicsObj*`/`CPartArray*` still
   match the id, but a use-after-free here is a hard client crash rather than a visual glitch.
3. **Hot-path cost.** The `UpdateParts` detour runs per creature per frame while any ragdoll is
   live. It's armed only while needed and does no per-step allocation, but the sim + `cache()`
   call per part hasn't been profiled in-client.
4. **Reloaded.Hooks runtime binding** from the plugin ALC (see *Reloaded.Hooks sharing*).
5. **Unload while armed** (see *Unload safety*) — restart the client instead.
6. **Address validity.** VAs are the ACBindings/shipped-exe values (proven for this kit's build);
   a different exe build needs a real sig-scan pattern (placeholders today).
7. **Sim tuning.** Constants are ported from the web/offline sim; foot-plane, topple strength and
   fall duration may need per-scale tuning once seen on real creatures.
