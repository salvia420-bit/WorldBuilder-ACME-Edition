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

### Single-writer ownership of a dying body (2026-08-23)

A dying body must be animated by **exactly one** writer — the ragdoll armed at the death hit —
from the hit through topple, settle and the corpse handoff. Three writers used to fight it:

| Fighting writer | Enforcement |
| --- | --- |
| The live-motion flinch armed by the **killing blow's own splatter** (it adds spring/idle/gait offsets on top of the ragdoll pose for the whole fall) | `RagdollRegistry.IsDeathOwned(id)` — a lock-free published set of owned ids. `LiveMotionRegistry` consults it at the **arming door** (`OnPlayScriptType`) and the **write door** (`OnUpdateParts`, which retires the entry and logs `livemotion YIELD`). |
| The **canned Dead animation's root motion**, which keeps moving/rotating `m_position.frame` — the very frame `WriteParts` composes onto — for the whole death sequence (and again on the corpse) | The composition basis is **frozen** at the entry's first write (`ResolveBasis`) instead of re-read every frame. Origins are landblock-local (retail `LandDefs::get_block_offset`), so only a landblock change rebases it (192 yd/step). A corpse inherits the creature's frozen **orientation** through the handoff record (its own origin, so clustered corpses stay apart). |
| The **revive eviction** (`OnMotionDone`, non-Dead): any queued motion completing on a dying creature used to silently cancel the ragdoll mid-fall and drop its handoff record, so the corpse re-crumpled = a second death animation | Scoped to a genuinely-alive-again body: **locomotion-class motions only**, never a corpse, never while `Pending` or still falling, past a 6 s grace — and it now logs `ragdoll RELEASE`. |

Known, deliberate gaps (the canned pose still shows, briefly): `PENDING` frames before a corpse's
position turns valid, and seed-retry frames. No sim pose exists yet in either case.

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

## The live-motion layer (hit reactions on **living** creatures)

A second, completely separate layer that rides the **same** `UpdateParts` post-detour as the death
ragdoll. Where the death registry *replaces* a corpse's pose, this one **adds a small translation
offset on top of the pose the client just animated** — a flinch when a creature is hit, and nothing
else. It never touches quaternions, never touches players, and never touches a body that is not
currently reacting.

`RagdollRegistry` (dead) and `LiveMotionRegistry` (alive) each **vote** on whether the hot detour is
armed; `NativeHooks` ORs the votes, so the detour is enabled while either has work and disabled the
moment both go quiet.

### The two signals

Both are typed S2C messages off Chorizite's `NetworkParser` — **no new native detour**.

| # | Message | Carries | Role |
|---|---|---|---|
| H1 | `Effects_PlayScriptType` (`0xF755`) | `{ObjectId, ScriptType, Speed}` | **The hit.** `ScriptType` in `0x5B..0x66` is the `PS_Splatter*` block, and the value itself encodes the geometry: height band (Low/Mid/Up) and the attacker's quadrant relative to the target's facing. The only signal that names the object that was hit. |
| H2 | `Combat_HandleAttackerNotificationEvent` (GameEvent `0x01B1`) | `{DefenderName, DamagePercent, Damage, Critical, …}` | **The magnitude.** The only signal with damage and the crit flag — but it identifies its target **by name only**, so it can *enrich* a hit, never trigger one. |

Correlation is order-agnostic (they travel in different ACE queues): H1 publishes its impulse
immediately with `defaultdamagepercent` and looks back for an unmatched H2 within ±300 ms; H2 looks
back for an unmatched H1 and fills that exact impulse in place. A damage number that never finds its
splatter is dropped; **a splatter that never finds its damage still produces a visible reaction** —
which is the common case, since monster-vs-monster hits carry no damage number to us at all.

A third feed comes from the existing `DoInterpretedMotion` detour, which classifies each body's own
current motion into three latches: **attack-class** (the layer attenuates itself to
`attackattenuation` so the telegraph the player has to read stays readable under fire),
**idle-class** (the breath is legal) and **locomotion-class** (the gait overlay is legal). The three
command sets are transcribed verbatim from the run's semantic classifier
(`/mnt/wbterminal2/livemotion/motion_class.py`) and are disjoint by construction.

### What it does per frame

Impulse → **energy pool** (hard-capped, wall-clock exponential decay; hits past the cap *refresh*
the decay instead of growing it, which is what stops a 10-attacker swarm exploding) → per-part
**PD spring** (`offset += vel*dt; vel += (-k*offset - c*vel)*dt`, substepped at 1/60 s) → offsets
added to the freshly-animated pose, with the visible amplitude a smoothstep of the pool so a
reaction *fades* rather than stops. Core parts are stiff, extremities loose (parent-chain depth, or
the authored per-part role weights when the body has them). Every offset is clamped to `ampfrac` of
the body's **own** radius, so a Golem and a Wisp flinch by the same fraction of themselves.

A quiet entry does **zero** part writes and zero `Frame::cache()` calls, and retires itself as soon
as it can no longer produce a visible offset — which drops its vote and disarms the hot detour.

### Idle micro-motion (breathing) — **post-combat linger, not world-wide ambient**

A second, much smaller oscillation that shares **everything** with the hit springs: the same per-part
offset budget, the same amplitude clamp, the same epsilon gate and the same single write loop. It is
summed with the spring offset per part and the **sum** is clamped once, so a creature being hit while
it breathes never exceeds the flinch budget — the breath just rides underneath.

The shape comes from the body's Tier-0 **archetype** and per-part **roles** in
`ragdoll_profiles.json`:

| Archetype | Idle motion |
|---|---|
| biped · quadruped · arthropod · avian · serpent · mixed | **Breathing** — one vertical sine at `idlehz` for the whole body, weighted by role: core 1.0, head 0.55, cloak/tentacle 0.45, tail 0.25, wing 0.20, limb 0.10. A part flagged `"ground": true` is **pinned** (weight 0), so feet stay planted. |
| floater | **Drift/bob** — every part rides one vertical sine (the body translates, it does not deform), *plus* a much slower horizontal sway (0.23× `idlehz`) on cloak/tentacle parts only, each with its own phase offset so streamers trail rather than march. |
| blob | **Pulse** — vertical, per part scaled by that part's looseness `w`, so the slack outer parts swell while the core holds. |
| prop | **Nothing.** A hard skip: not eligible, no buffers allocated, never lingers. All 221 prop bodies. |
| *(no profile)* | Breathing with `1 − looseness` as the weight — the structural way of saying the same thing. |

Every body's phase is hashed from its **object id**, so a camp of drudges does not breathe in unison,
and it is *carried* frame to frame rather than derived from a clock, so retuning `idlehz` live changes
the rate without teleporting the body.

Two gates decide whether a body breathes on a given frame: its **own current motion must be
idle-class** (the same `DoInterpretedMotion` latch the attack attenuation uses, extended with the
idle command set — a body that is walking, swinging or casting does not breathe on top of it), and its
`UpdateParts` must be firing (i.e. it is on screen). The latch starts **false**: a body whose motion we
have never observed does not breathe until it tells us it is idling, which for a creature you have
just fought is its first `Ready`/`Stop` after the swing. The idle command set is transcribed verbatim
from the run's semantic classifier (`/mnt/wbterminal2/livemotion/motion_class.py`) and verified
against it set-for-set.

> **What this is NOT: world-wide ambient idle motion.** Idle motion **never arms the hot `UpdateParts`
> detour by itself** — that would put every creature in the world on the hot path permanently. It only
> ever runs on a body the **hit layer** already created an entry for. To make it visible rather than
> theoretical, an entry whose springs have settled now **lingers for `idlelingersec` (default 30 s)
> after its last hit** instead of retiring immediately; retirement then requires quiet **and** linger
> expiry. So in practice: **you see a creature breathe for half a minute after you fight it**, then it
> goes quiet and the detour disarms. Making it world-wide is a **1070-measured decision for later** —
> the measurement is "what does an always-armed `UpdateParts` detour cost per frame with N creatures
> in view", and nothing in the code changes until that number exists.

With `idlemotion = 0` the layer is bit-identical to C3: no idle offset is computed, the combine
collapses to the pre-C4 multiply, and the linger term of the retirement test is false.

### Procedural tripod gait (`gait`) — **prototype, one body, default off**

A third oscillation, structurally identical to the breath: its own buffer, the same amplitude clamp,
summed into the same single write path. While the body's own motion is **locomotion-class**, its six
leg chains get an alternating-tripod lift/sweep cycle laid **on top of** the retail walk animation.
It is a **texture, not a replacement** — the retail animation still owns the pose.

**One body.** Setup DataID **`0x02000F95`** (Olthoi Piercer / Lacerator / Needler) is hard-coded in
`Sim/GaitMotion.cs`. It is the textbook AC hexapod: six three-segment legs, all built from the same
femur gfxobj, tagged chain-and-side by the Tier-0 pass. Every other creature in the world is
completely untouched with `gait = 1` — not eligible, no buffer allocated, byte-identical writes.

| | |
|---|---|
| **The two tripods** | `{front-right, middle-left, rear-right}` and `{front-left, middle-right, rear-left}` — the two stable triangles an insect actually alternates. The leg table is ordered so *alternating index is alternating tripod*, so a leg's phase is just `phase + (leg & 1) * pi`: the opposition is structural, not a lookup. |
| **Lift** (object-local +Z) | `amp * max(0, sin(p))`. The half-wave is the point: a leg is either in **swing** (lifted) or in **stance** (flat). A full sine would push the feet through the floor for half the cycle. |
| **Sweep** (object-local +Y, the model's facing) | `amp * 0.6 * -cos(p)`. At `p = 0` the foot is rearmost and lifts; by `p = pi` it has been carried fully forward and plants; the stance half drags it back. |
| **Per part** | The chain's three parts are weighted `0.30 / 0.65 / 1.00` proximal→distal, so the leg articulates instead of translating rigidly. |
| **Cadence** | `gaitcadence` scaled by the body's **measured ground speed** — the `m_position` XY delta between frames, EMA-smoothed, scale clamped to 0.35×…2.5×. An AC object origin is **cell-local**, so a cell handoff reseeds the sampler and drops back to the bare knob for a frame rather than reading a 200 yd "jump" as speed. There is no other speed source: the client's velocity vector was not verified for this stage. |

Same two lifetime rules as the breath: it **never arms the hot detour by itself** (it only runs on
bodies the hit layer already tracks), and it deliberately does **not** extend `idlelingersec` — the
prototype cannot raise the layer's cost by one frame. So in practice you see it on an Olthoi you have
just fought, walking away, inside its linger window.

**Generalizing it** (a later lane, not this one): the only body-specific data is an 18-entry part-index
table, and that is mechanically derivable from the Tier-0 role data — group an arthropod's parts by
`chain == "leg"`, order each chain root-to-tip through the Setup's `ParentIndex` graph, sort front to
back alternating side. That needs two fields the shipped `ragdoll_profiles.json` does not currently
carry (`chain` and `side` exist in the run's `roles_merged.json` but are dropped by the profile
writer). Widening the profile schema is the work; none of the math changes.

With `gait = 0` the layer is bit-identical to C4: no gait offset is computed and the write-time sum
is the pre-C5 one, term for term.

### Live tuning: `ragdoll.cfg`

**The 1070 tuning loop is edit-the-file-and-watch — no rebuild, no reinject, no relog.** Every
number the layer's look depends on is read from a plain-text file, re-read **at most once per
second**, and applied to bodies that are *already mid-reaction*.

- **Where:** first existing of `%ACMERAGDOLL_CONFIG%` · `C:\Temp\acdt\ragdoll.cfg` ·
  `%USERPROFILE%\.acdt\ragdoll.cfg`. **No file = every default below**, which is the normal state on
  a machine nobody is tuning on.
- **Format:** `key = value`, one per line; `#` and `;` comment; keys case-insensitive; unknown keys
  ignored (so a cfg written for a later stage does not spam an earlier build).
- **Tolerance:** a value that does not parse keeps its **last good** value and logs **one** warning
  per key per session; out-of-range values are **clamped** silently; deleting a key reverts it to its
  default; a missing/locked/half-written file simply keeps the current tuning.
- **Cost:** the 1/s tick only **stats** the file — it is opened and parsed **only when it actually
  changed**, so the steady state is one stat per second and zero allocation. Booleans accept
  `1/0`, `true/false`, `on/off`, `yes/no`.
- A starter file with every key at its default is at
  `/mnt/wbterminal2/livemotion/out/ragdoll.cfg.sample`.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `livemotion` | `1` | 0/1 | **Master switch, DEFAULT ON.** 0 retires every reacting body, drops the detour vote and no-ops the hit handlers; 1 restarts from a clean slate. |
| `springk` | `320` | 1 … 5000 | Spring stiffness, 1/s². `omega_n = sqrt(k)` → ~0.35 s natural period. Higher = faster, tighter twitch. |
| `springdamp` | `9.0` | 0 … 200 | Spring damping, 1/s. `zeta = c/(2*sqrt(k))` ≈ 0.25 — a recoil, not a slide. Higher = deader. |
| `corestiffmul` | `2.2` | 0.01 … 20 | Stiffness multiplier for a core (looseness 0) part. |
| `edgestiffmul` | `0.55` | 0.01 … 20 | Stiffness multiplier for an extremity (looseness 1). 4× ratio = 2× frequency ratio. |
| `coreimpulsefrac` | `0.35` | 0 … 1 | Share of the impulse a perfectly stiff part still gets, so a hit moves the whole body a little. |
| `energyperdamagepercent` | `3.0` | 0 … 50 | Reaction energy per unit of `DamagePercent`. 3.0 → a hit taking ⅓ of health saturates `poolcap`. |
| `impulsevelperenergy` | `2.2` | 0 … 50 | Peak per-part velocity kick, yd/s, per unit of energy — sets how hard a **small** hit reads. |
| `poolcap` | `1.0` | 0.01 … 20 | Saturation cap on a body's reaction energy. Hits past it refresh the decay instead of growing it. |
| `poolhalflife` | `1.5` | 0.05 … 30 | Pool half-life, seconds, wall clock (frame-rate independent). |
| `poolgainknee` | `0.35` | 0.01 … 1 | Fraction of `poolcap` where the smoothstep visual gain reaches 1 — the fade-out shape. |
| `critmult` | `2.5` | 1 … 10 | Crit impulse multiplier. Only the *extra* is refractory-gated; a crit's base impulse always lands. |
| `critrefractoryms` | `1000` | 0 … 10000 | Per-body refractory on the crit extra, ms. |
| `settledown` | `0.35` | 0 … 4 | Downward share mixed into every impulse direction (~19° sag) before normalising. |
| `heightbias` | `0.45` | 0 … 1 | How much the splatter's height band biases which part rows move. |
| `ampfrac` | `0.05` | 0 … 0.25 | **The amplitude safety knob.** Max part offset as a fraction of the body's own radius. Also hard-bounded in code to 0.004 … 0.35 yd absolute, whatever the file says. |
| `attackattenuation` | `0.30` | 0 … 1 | Layer gain while the body's own motion is attack-class. |
| `defaultdamagepercent` | `0.10` | 0 … 1 | Impulse magnitude when a splatter never finds a damage number (the common case). |
| `idlemotion` | `1` | 0/1 | **Idle micro-motion master switch, DEFAULT ON.** 0 makes the layer bit-identical to the pre-C4 build (no idle offsets, no linger). |
| `idleamp` | `0.008` | 0 … 0.25 | Idle amplitude as a fraction of the body radius (same unit as `ampfrac`, ~6× smaller). Also clamped to `ampfrac`'s per-part maximum, so it can never exceed the flinch budget. |
| `idlehz` | `0.35` | 0 … 10 | Idle oscillation frequency, Hz (~3 s breath cycle). The floater sway runs at 0.23× this. Phase is carried per body, so retuning mid-breath changes the rate without moving the body. |
| `idlelingersec` | `30` | 0 … 600 | How long a body keeps its entry — and keeps breathing — after its **last hit**, once the springs settle. A **floor, not a timer** (a big hit already takes ~8 s to settle). 0 restores C3's "retire at settle". **This is the cost knob**: it decides how long bodies stay on the hot path. |
| `gait` | `0` | 0/1 | **C5 procedural-gait prototype, DEFAULT OFF.** 0 makes the layer bit-identical to the pre-C5 build. On, it affects exactly one body (see below). |
| `gaitamp` | `0.02` | 0 … 0.25 | Gait amplitude as a fraction of the body radius — between `idleamp` (0.008) and `ampfrac` (0.05) on purpose: a texture over the retail walk, not a replacement. Also clamped to `ampfrac`'s per-part maximum. |
| `gaitcadence` | `1.6` | 0 … 10 | Step frequency, Hz, **at the reference ground speed** (3 yd/s) — a ~0.6 s tripod cycle. Scaled live by the body's measured speed (0.35× … 2.5×); with no speed sample it is exactly this value. Phase is carried, so retuning mid-step does not jump the legs. |

**Two switches, two jobs.** The persisted plugin setting `liveMotion` is the **boot** switch: false
⇒ the layer is never constructed, never subscribed, and the hot detour dispatches to the death
registry alone (the C1 *bit-identical client behaviour* invariant), and `livemotion` in the cfg has
nothing to switch. With it true (the default), the cfg's `livemotion` is the **runtime** switch and
overrides it live, in both directions.

**Where the reload runs.** Nowhere new: there is no timer and no thread. The poll sits at the top of
`OnUpdateParts` (the `UpdateParts` detour tail — the only per-frame path this plugin owns, and
reached only when the layer already has work) and at the top of the two net handlers, which is what
keeps a cfg edit — including turning the layer back **on** — effective on an otherwise idle client:
the next incoming hit signal picks it up. All three share one 1 s throttle, the file read is
single-flight and never blocks, and every path in the reader is wrapped so an unreadable file cannot
unwind into a detour.

**How an edit reaches a body already mid-flinch.** A frame reads the tuning snapshot **once** and
threads that one immutable object through every method that needs a number, so an edit landing
mid-frame can never be half-applied (a new `springk` against the old `springdamp` would read as a
one-frame instability). `ampfrac` and `poolcap` are additionally re-derived per body per frame
rather than stamped at arm time, so those two retune bodies that are already reacting.

---

## Files

```
AcmeRagdoll.csproj            build contract (mirrors AcmeRedline + Reloaded.Hooks 4.3.3)
manifest.json                 Chorizite plugin manifest (Client environment only)
AcmeRagdollPlugin.cs          IPluginCore entry: install hooks in the Client env, tear down on unload
Lib/AddressResolver.cs        managed sig-scanner + proven VA fallback; ClientFunctions VAs/patterns
Lib/RagdollSettings.cs        ISerializeSettings<T> + source-generated JsonContext (Enabled switch)
Lib/RagdollProfiles.cs        setupDid -> RagdollParams table, parsed from ragdoll_profiles.json at init
Lib/LiveMotionConfig.cs       ragdoll.cfg reader + the immutable LiveMotionTuning snapshot (live knobs)
Services/NativeHooks.cs       Reloaded.Hooks detours on UpdateParts + MotionDone; dynamic arm/disarm
Services/RagdollRegistry.cs   per-object registry: seed / step / write parts / lifetime + prune
Services/LiveMotionRegistry.cs live-motion layer: hit signals, correlation, energy pool, springs
Sim/RagdollSim.cs             the ported verlet sim (model space, no per-step allocation)
Sim/RagdollParams.cs          per-body tuning (immutable value data); Default == the shipped constants
Sim/IdleMotion.cs             C4 idle micro-motion: archetype/role weights, oscillator, the shared
                              offset combine + amplitude clamp, and the linger predicate (pure math)
Sim/GaitMotion.cs             C5 procedural tripod gait: the one hard-coded hexapod's leg table, the
                              lift/sweep cycle and the speed->cadence map (pure math)
Sim/QMath.cs                  quaternion/vector helpers + mulberry32 (ported 1:1)
```

### Per-body profiles (`ragdoll_profiles.json`)

Drop a `ragdoll_profiles.json` next to `AcmeRagdoll.dll` to give individual creature bodies their
own fall:

```json
{ "profiles": { "0x02000E08": { "params": { "impulse": 2.6, "fallFrames": 105,
                                            "dirBiasDeg": 175.0, "dirBiasStrength": 0.45 } } } }
```

Keys are Setup DataIDs; any parameter left out keeps the shipped default, and a body with no
profile at all falls **bit-for-bit** as it did before (verified against the pre-parameterization
sim over 6 skeletons x 4 seeds x 120 frames). Fields other than `profiles`/`params` are ignored,
so a generated profile batch can be shipped verbatim. The file is read ONCE, on the managed plugin
thread in `Initialize()`; the seed path then only does a `Dictionary` lookup, which is what keeps
it legal inside the native detour (the 0x80131509 rule — see `WarmupAcBindings`). Missing or
corrupt file: one log line, zero profiles, defaults everywhere.

`dirBiasDeg` is model-space degrees with **0 = +Y (forward)**; the sim converts it to its own
`atan2` topple angle (`RagdollSim.DIR_BIAS_ZERO`). `dirBiasStrength` 0 leaves the seed-derived
direction untouched, 1 puts it exactly on the bias.

**The live-motion half of the same file** (Tier-0 data; the death sim reads none of it):

```json
{ "profiles": { "0x02000041": {
    "params": { … },
    "archetype": "floater",
    "parts": [ { "i": 0, "w": 0.15, "role": "core",  "ground": false },
               { "i": 2, "w": 1.0,  "role": "cloak", "ground": false } ] } } }
```

- `w` — 0…1 **looseness** (0 = core/stiff, 1 = extremity/whips). The hit springs read it; a body
  without it falls back to parent-chain depth. Parts the array does not name keep the heuristic.
- `archetype` — `biped · quadruped · arthropod · avian · serpent · floater · blob · prop · mixed`.
  Picks the **idle** oscillation shape (see *Idle micro-motion* above). Unknown/absent ⇒ breathing off
  the structural heuristic.
- `role` — `core · head · limb · wing · tail · cloak · tentacle · prop`, and `ground` — "this part
  rests on the floor". Together they weight the idle motion per part.

The shipped file carries all three for all **693** bodies (221 of them props, which never idle). The
two halves are parsed independently, so a body with roles but no weights (or the reverse) degrades on
that half alone.

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
- **Live motion (hit reactions).** Do **not** rebuild to tune this one — edit
  `C:\Temp\acdt\ragdoll.cfg` (start from `ragdoll.cfg.sample`) and the next hit uses the new
  numbers. Tune in this order: `springk` and `springdamp` (does one hit read as a flinch?), then
  `ampfrac` (is it a flinch or a wobble?), then the pool (`poolcap` / `poolhalflife` — spam a body
  with 6 attackers and check it saturates instead of escalating), then `critmult` and
  `attackattenuation` (is the attack telegraph still readable while the body is being hit?).
  `livemotion = 0` turns the whole layer off live, without a relog, if it ever misbehaves mid-test.
  Watch the log: `livemotion cfg: loaded …` confirms a reload, `livemotion HIT …` is one line per
  impulse (energy, pool, crit multiplier, correlation latency) and `livemotion REACT …` is the
  first frame a body actually writes parts.
- **Idle micro-motion.** Remember it is **post-combat**: hit a creature, stop, and watch it for the
  next 30 s (`livemotion IDLE …` logs archetype, amplitude and whether the body has sway). Check in
  this order: a **biped** (does the chest breathe while the feet stay planted?), a **floater** —
  Wisp/Zefir — (does it bob, and do the streamers trail out of phase?), a **blob**, and a **camp of
  three or more of the same creature** (they must be visibly out of phase with each other). Then hit
  one *while* it breathes: the flinch must dominate and the breath must not push the body past the
  usual flinch amplitude. `idleamp` and `idlehz` are the look; **`idlelingersec` is the cost** — it
  is how long bodies stay on the hot detour, so if the frame time suffers in a busy camp, drop it
  first. `idlemotion = 0` restores exactly the pre-C4 behaviour, live.
- **Procedural gait (prototype).** Off by default; set `gait = 1` in the cfg. Find an **Olthoi
  Piercer / Lacerator / Needler** (setup `0x02000F95`), hit it once so the layer tracks it, then let
  it walk while its entry lingers. `livemotion GAIT …` logs once per body with the resolved
  amplitude, the cadence and whether that cadence came from a measured speed or from the knob. What
  to judge, in order: (1) does the leg motion read as an **insect trot** — two alternating triangles,
  not six legs paddling in unison? (2) does it **fight** the retail walk animation, or sit under it?
  If it fights, drop `gaitamp` (it is the only look knob that matters); (3) does a **running** Olthoi
  visibly step faster than a walking one (the speed→cadence map)? (4) does anything happen to any
  *other* creature with the flag on — it must not. If the overlay does not read well at any
  amplitude, **this is the stage that gets cut**; nothing else depends on it.

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
   call per part hasn't been profiled in-client. **C4 raises this deliberately**: `idlelingersec`
   keeps a fought body writing parts every frame for 30 s after its last hit instead of retiring in
   ~8 s. Unmeasured. It is also the number that gates the "world-wide ambient idle motion" question —
   that would keep the detour armed permanently, and the decision needs a 1070 frame-time
   measurement, not an opinion.
4. **Reloaded.Hooks runtime binding** from the plugin ALC (see *Reloaded.Hooks sharing*).
5. **Unload while armed** (see *Unload safety*) — restart the client instead.
6. **Address validity.** VAs are the ACBindings/shipped-exe values (proven for this kit's build);
   a different exe build needs a real sig-scan pattern (placeholders today).
7. **Sim tuning.** Constants are ported from the web/offline sim; foot-plane, topple strength and
   fall duration may need per-scale tuning once seen on real creatures.
