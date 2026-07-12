# WS10 — War/Void Projectile Visuals (bolt, streak, blast, volley, ring, wall)

Investigator packet. Date 2026-07-12. Buildbox (GCE, read-only repo).
Charter: projectile flight fidelity — spawn velocity, spawn transform, arc gravity,
trail VFX, impact, multi-projectile shapes. Improvement pass on a working system.

**Baseline confirmed working:** the F3-1 (2026-06-09) fix already makes projectiles
fly (velocity forwarded for MISSILE spawns, JS integrates ballistically). This packet
audits that path for *fidelity* against ACE ground truth and finds it **largely
correct** — the headline outcome is that the 2026-06-06 arc-gravity open question is
**RESOLVED in our favour**, plus a small set of low-risk correctness/cosmetic items.

Legend: ✅ = verified fact (source quoted). 🔶 = hypothesis / needs live capture.
Cites re-opened live this session; ACE checkout is partial (Spell class body / the
`ProjectileSpellType` enum body are not in the tree — the *launch logic* that consumes
them IS, and is quoted below).

---

## 0. TL;DR for the integrator

- **Nothing in the core flight path is broken.** Bolts fly flat, arcs arc, multi-shot
  spells render N objects, spawn height is at the caster's chest, impact hides + explodes.
  All of this matches ACE. Do **not** "fix" it away.
- **Arc-gravity open question (2026-06-06) = RESOLVED.** ACE applies gravity **server-side
  only for `ProjectileSpellType.Arc`** (`useGravity = spellType == Arc`), signalled to the
  client by the `PhysicsState::GRAVITY` (0x400) bit. Our client mirrors this exactly
  (`entityProjectileHasGravity` → `_ballisticGravity`, −9.8 m/s² = ACE `PhysicsGlobals.Gravity`).
  War/void **bolts carry no GRAVITY bit → fly flat, correct.** No change needed.
- **4 small items** worth landing (all minimal, reversible, flag-escaped):
  1. `setVelocity` never clears `_ballistic` → an arc husk keeps accumulating gravity for
     its 5 s pre-Destroy window (masked today by the NoDraw hide; defense-in-depth).
  2. `_groundClampZ` runs on projectile spawns (edge case: uphill/downhill shots could
     lift the launch point to terrain).
  3. `PROJECTILE_GRAVITY_ON`'s code comment says "Default OFF" but the code + url-flags are
     **default-ON** — stale comment.
  4. Streak-swirl **omega is parsed off the wire but dropped at the wasm→JS bridge**
     (`omega_z: 0.0` hardcoded). Real code gap, **negligible content impact** for war/void
     (RotationSpeed ≈ unused in LSD projectile weenies).

---

## 1. VERIFIED FINDINGS

### 1.1 Spawn velocity is guaranteed non-zero for war/void projectiles ✅

ACE computes launch velocity in `CalculateProjectileVelocity` and always returns a
non-zero vector for a real spell (speed = the projectile weenie's `MaximumVelocity`,
which is > 0):

- `external/ACE/.../WorldObject_Magic.cs:1699` `var speed = GetProjectileSpeed(spell);`
- `:1704-1708` — no target → `return Vector3.Transform(Vector3.UnitY, casterLoc.Rotation) * speed;` (forward × speed, non-zero).
- `:1756` — fallback → `return dir * speed;` (`dir = Normalize(endPos - startPos)`).
- `GetProjectileSpeed` (`:1898-1936`) returns `weenie.PropertiesFloat[MaximumVelocity]`
  (`:1912-1918`); the call from `CreateSpellProjectiles` passes no distance so it's the
  raw base speed (`:1521`, `:1926-1927`).

DAT/LSD ground truth: Lightning Bolt projectile weenie **20182** `floatStats` has
`{26: 8.0}` (PropertyFloat 26 = MaximumVelocity, per url-flags `launcherVelocityTable`
row) → non-zero. So `speed > 0` for real content.

ACE only serializes VELOCITY when it is non-zero — `WorldObject_Networking.cs:505-506`
`if (Velocity != Vector3.Zero) physicsDescriptionFlag |= PhysicsDescriptionFlag.Velocity;`
→ `:389-391 writer.Write(Velocity);`. Since launch velocity is always non-zero, the
VELOCITY field is **always present** in a war/void projectile ObjectCreate.

Our side parses it (`holtburger-protocol/.../description.rs:1052-1063`, world-frame
`Vector3`) and the wasm forwards it **only for MISSILE spawns**
(`src/lib.rs:39997-40006`):
```rust
let (spawn_vx, spawn_vy, spawn_vz) = if data.physics_state
    .contains(holtburger_common::properties::PhysicsState::MISSILE) {
    data.velocity.map(|v| (v.x, v.y, v.z)).unwrap_or((0.0, 0.0, 0.0))
} else { (0.0, 0.0, 0.0) };
```
`MISSILE = 0x40`, `GRAVITY = 0x400` (`holtburger-common/src/properties/object.rs:62,66`)
— match ACE / `acclient.h`. **Conclusion: velocity is guaranteed non-zero and correctly
forwarded.** No fix.

### 1.2 Spawn transform — the bolt leaves the caster's chest, not his feet ✅

The spawn *position* is server-authored and already offset to ~2/3 the caster's height
plus a forward push toward the target; our client renders at that wire position.

- `WorldObject_Magic.cs:1526` `public const float ProjHeight = 2.0f / 3.0f;`
  `:1690` `public const float ProjHeightArc = 5.0f / 6.0f;`
- `CalculatePreOffset` (`:1528-1563`): `startFactor = Arc ? 1.0f : ProjHeight` →
  `preOffset = new Vector3(0, 0, Height * startFactor)` — Z is 2/3 caster Height (bolt)
  or full Height (arc). Then aligns toward the target's chest
  (`endPos.Z += target.Height * endFactor`) and pushes forward by `radsum` (sum of physics
  radii).
- `CalculateProjectileOrigins` (`:1569-1668`): `baseOffset.Y += radsum;` (forward),
  `baseOffset += heightOffset;` (the 2/3-height Z).
- `LaunchSpellProjectiles` (`:1791-1792`):
  `sp.Location = new Position(casterLoc); sp.Location.Pos += Vector3.Transform(origin, rotate);`
  → the world spawn point = caster pos + (2/3-height + forward) rotated toward the target.
- Orientation set to the velocity heading (`:1805-1807 set_vector_heading(dir)`).

Client honors it (Explore trace, verified quotes):
- `entities.js:~3813-3822` sets root position from wire `x,y,z` via
  `_groundClampZ(...)` then `inst.setPose(wx, wy, wz, ...)`.
- AC→three transform preserves height: `adapter.js:1399-1401`
  `acToThree(ax, ay, az) => [ax, az, -ay]` (AC z-up → three y-up; a 1.2 m AC-Z becomes
  1.2 m three-Y — **not flattened**).
- No per-frame terrain re-anchor touches a projectile: the dead-reckon smoother explicitly
  skips `_ballistic` (`entities.js:11834 ... && !inst._ballistic && ...`) and
  `applyManagedPose` early-returns for `_ballistic` (`entities.js:4965 if (inst._ballistic) return;`).

**Caveat (see §2.2):** `_groundClampZ` (`entities.js:42-54`) runs on the *spawn* and lifts a
buried outdoor object up to +10 m onto terrain. A projectile spawned slightly below the
terrain at its `(wx,wy)` (e.g. firing across a rise) would be lifted, distorting launch
height. Bounded and rare, but projectiles should skip it. **No fix to the height itself —
it's server-correct; the clamp is the only risk.**

### 1.3 Arc gravity — ACE integrates gravity SERVER-side ONLY for Arc; client mirrors it ✅ (RESOLVES the 2026-06-06 open question)

`useGravity` is **exclusively** `spellType == ProjectileSpellType.Arc` in every relevant
site:

- `WorldObject_Magic.cs:1730` `var useGravity = spellType == ProjectileSpellType.Arc;` (velocity calc)
- `:1761` `var useGravity = spellType == ProjectileSpellType.Arc;` (launch)
- `SpellProjectile.cs:868-871` `SetProjectilePhysicsState(target, useGravity)` → `if (useGravity) GravityStatus = true;`

For an Arc, ACE solves a ballistic initial velocity with gravity baked in:
`WorldObject_Magic.cs:1734-1741` — `gravity = useGravity ? PhysicsGlobals.Gravity : 0.0f;`
→ `Trajectory.solve_ballistic_arc_lateral(startPos, speed, endPos, targetVelocity, gravity, ...)`.
For Bolt/Streak/Volley/Ring/Wall/Blast, `useGravity=false, gravity=0` → velocity is
`dir * speed` (straight line; the tracking case still uses gravity=0, pure lateral lead).

`PhysicsGlobals.Gravity = -9.8f` (`external/ACE/.../Physics/PhysicsGlobals.cs:13`).

`GetProjectileSpellType` (`SpellProjectile.cs:129-167`): a single non-tracking projectile
(`spell.NonTracking`) → `Arc`; a normal single projectile → `Bolt`; streak categories →
`Streak`; etc. So **only NonTracking single-projectile spells arc.**

Client parity is exact:
- `SetProjectilePhysicsState` sets `GravityStatus = true` → `PhysicsState::GRAVITY` (0x400)
  bit in the ObjectCreate.
- Wasm classifies: `src/lib.rs:27581-27588` — MISSILE → `projectile_index`; **+GRAVITY** →
  `PROJECTILE_GRAVITY_GUIDS` (thread_local). Read via
  `entity_projectile_has_gravity` (`lib.rs:29978-29979`).
- JS seeds it at spawn: `entities.js:4042-4043`
  `inst._ballisticGravity = PROJECTILE_GRAVITY_ON && this.projectileHasGravity(guid);`
- Integrator applies exactly −9.8: `entities.js:11582`
  `if (inst._ballisticGravity) lv.vz += PROJECTILE_GRAVITY_Z * step;` with
  `PROJECTILE_GRAVITY_Z = -9.8` (`entities.js:1009`).

**Conclusion: our client arcs Arc-type spells (gravity from the wire bit) and flies
bolts flat — byte-for-byte the ACE contract. The 2026-06-06 "do we fly linear while ACE
integrates gravity?" question is answered: NO mismatch. Both agree.** No fix.

> Note: ACE's initial arc velocity uses its *own* `solve_ballistic_arc_lateral`; our client
> re-derives the arc by applying −9.8 to the *seeded* velocity. These agree at launch and at
> the target endpoints (same g, same start/end); intermediate apex may differ by a few cm
> over a sub-second flight. Not worth matching the solver. 🔶 Confirm visually (eye-test).

### 1.4 Trail VFX — the "trail" is the glowing GfxObj + Launch script; there is NO DAT particle-trail for war/void bolts ✅ (DAT-proven)

I pulled three projectile setups from the DAT oracle (`client_portal.dat`):

| Spell projectile | wcid | Setup DID | `default_script` | `defaultScriptTable` | part GfxObj |
|---|---|---|---|---|---|
| Lightning Bolt | 20182 | `0x02000C52` | **0** | **0x0** | `0x010028CD` |
| Nether Bolt (void) | 43230 | `0x02001A28` | **0** | 0x0 | `0x010001EC` |
| Force Bolt | 7264 | `0x020003F3` | **0** | 0x0 | `0x01001125` (+defaultAnimation `0x03000C22`) |

So the projectile setups carry **no `default_script`** and **no `defaultScriptTable`**.
Therefore:
- Our `?setupDefaultScript` path (DEFAULT-ON; fetches `Setup.default_script_id`,
  `entities.js:~1240-1267`, `:4344-4374`) resolves **0 → attaches nothing.** Correct.
- ACE *does* set `sp.DefaultScriptId = PlayScript.ProjectileCollision` for
  Bolt/Streak/Arc/Volley/Blast (`SpellProjectile.cs:86-92`) and DOES serialize it
  (`WorldObject_Networking.cs:404-405, 514-515`). `PlayScript.ProjectileCollision = 0x5A`
  (`ACE.Entity/Enum/PlayScript.cs:95`). Our `?defaultScriptSpawn` path (DEFAULT-ON,
  `entities.js:~1201-1238`, `:4304-4329`) resolves this PScriptType **via the entity's
  PhysicsScriptTable** — but the projectile has **no** PhysicsScriptTable → resolves to
  0 → no-op. **This matches retail:** retail's `play_default_script` also no-ops with a
  null script table (`acclient.c:320335-320343`). So the wire DefaultScript is inert on
  both — not the trail.

**What actually produces the flight visual:**
1. The glowing **GfxObj part** (e.g. `0x010028CD`), rendered as the entity model. It is a
   child of `inst.root`, so it moves with the ballistic integration automatically — the
   streak/trail is the moving bright mesh itself. (Its brightness depends on the emissive/
   additive material — see `?luminousEmissiveMap`, cross-WS.)
2. **`PlayScript.Launch` (0x04)** at spawn — `LaunchSpellProjectiles:1833`
   `EnqueueBroadcast(new GameMessageScript(sp.Guid, PlayScript.Launch, ...))`. Handled by
   `play_effect_vfx.js:2035-2042` ("Small blue-cyan additive burst at the projectile's
   spawn position… retail's 'spell-projectile leaving caster'").
3. **`PlayScript.Explode` (0x05)** at impact (§1.5).

**Emitters attaching to a moving projectile DO follow it** (Explore trace, verified):
`_attachParticleChainForEntity` parents to `rig` (`entities.js:10790-10792
parent: rig`), the ParticleEmitter reads `this.parent.position` each update
(`particle_emitter.js:196`), part index −1 → returns the root
(`particle_emitter.js:164-165`). So *if* a projectile ever did carry a script trail, it
would track. It just doesn't for war/void bolts. **No fix; note the DAT reality so no one
"adds a missing trail" that retail never had.**

### 1.5 Impact — SetState(NoDraw) hides + Explode burst renders (world-anchored) + VectorUpdate stops + Destroy after 5 s ✅

ACE `SpellProjectile.ProjectileImpact` (`SpellProjectile.cs:209-244`), in order:
1. `:213-220` server-side sets `ReportCollisions=false; Ethereal=true; IgnoreCollisions=true; NoDraw=true; Cloaked=true;` + `PhysicsObj.set_active(false)`.
2. `:229` `EnqueueBroadcast(new GameMessageSetState(this, PhysicsObj.State));` → **NoDraw over the wire.**
3. `:230` `EnqueueBroadcast(new GameMessageScript(Guid, PlayScript.Explode, GetProjectileScriptIntensity(SpellType)));` → **impact VFX.**
4. `:237-238` `PhysicsObj.Velocity = Vector3.Zero; EnqueueBroadcast(new GameMessageVectorUpdate(this));` — the comment (`:232-236`) says this exists specifically to STOP the client's projectile from sailing through the target ("'ghost' projectile").
5. `:240-243` 5-second `ActionChain` → `Destroy()` → ObjectDelete.

Our client honors each:
- **SetState(NoDraw) → hide.** The world layer diffs `should_draw()` on every SetState and
  fires `EntityVisibilityChanged` — `mutations.rs:1472-1498` (`was_drawable` vs
  `is_drawable`) → `WorldEvent::EntityVisibilityChanged`; recv loop emits ClientEvent
  **kind=17** (`lib.rs:38306`, const at `:20889`), handled at `index.html:7925-7960`
  → `setVisibility(guid, false)` → `_setEntityStateVisible(inst, false)`
  (`entities.js:5172-5205`). `should_draw()` gates HIDDEN/NO_DRAW/CLOAKED
  (`entity.rs:1042`, tests `:1290-1296`). This is the **SetState message path**, not the
  worldLifecycle lifecycle family, so it fires regardless of `?worldLifecycle`.
- **Explode burst renders even though the husk is now hidden.** The burst is parented to
  `entitiesGroup` (the *sibling* group), NOT to the hidden projectile root:
  `play_effect_vfx.js:739-745`
  ```js
  return {
    position: inst.root.position,
    parent: ls.entitiesGroup ?? inst.root.parent ?? null,  // world group, not the rig
  };
  ```
  So NoDraw-hiding the projectile does not blank the explosion. `PLAY_SCRIPT.Explode`
  handled at `play_effect_vfx.js:2049-2051`; `ProjectileCollision (0x5A)` at `:2607-2609`.
- **VectorUpdate(zero) stops the projectile.** kind=4 → `setVelocity`
  (`entities.js:8450-8460`) sets `inst.lastVel = {0,0,0}`; the integrator then adds zero
  horizontal displacement.
- **Destroy after 5 s → ObjectDelete** → `maintain_bridge_indexes_on_delete`
  (`lib.rs:27826-27834`) prunes `projectile_index` + `PROJECTILE_GRAVITY_GUIDS`; JS
  KIND_REMOVE tears the rig.

**Ordering is correct** (hide+explode+stop together, delete 5 s later). One latent gap:
`setVelocity` does not clear `_ballistic`/`_ballisticGravity`, so an **arc** husk keeps
integrating gravity during the 5 s hidden window (§2.1). Invisible today (NoDraw), but a
race/`worldLifecycle`-edge could expose a sinking ghost. → PATCH 1.

### 1.6 Multi-projectile shapes (volley / ring / wall / blast) — server spawns N distinct objects; our client renders N ✅

There is **no client-side "shape" logic** and none is needed. ACE builds N `SpellProjectile`
WorldObjects, each with its own origin + velocity, each broadcast as its own ObjectCreate:

- `CreateSpellProjectiles:1519-1523` → `CalculateProjectileOrigins` (list of N local
  offsets) → `LaunchSpellProjectiles` loops `for (var i = 0; i < origins.Count; i++)`
  (`:1770`) creating one `SpellProjectile` per origin (`:1774`), each `LandblockManager.AddObject(sp)` (`:1824`) → one ObjectCreate each.
- Shape math (`CalculateProjectileOrigins:1569-1668`): `SpreadAngle==0` → grid via
  `DimsOriginX/Y/Z` + `Padding` + `CreateOffset` (volley / blast / wall rows);
  `SpreadAngle>0` → rotate each origin by `anglePerStep` (`GetSpreadAnglePerStep:1675-1686`)
  (ring/fan); `SpreadAngle==360` → radsum ×0.6 full ring (`:1592-1593`).
- Per-projectile velocity: base `velocity` for all (`:1794`); for `SpreadAngle>0` each is
  rotated to its own heading (`:1796-1802`).

Each becomes a distinct GUID → distinct `projectile_index` entry (HashSet, no wcid
collapse, `lib.rs:27582`) → distinct ballistic entity integrated independently
(`_tickBallisticProjectiles` walks the whole `entityMap`, `entities.js:11557`). N Launch
bursts, N flights, N impacts. **Our client already renders the full shape** as a natural
consequence of handling N simultaneous MISSILE ObjectCreates. No fix.

🔶 **Not eyeball-verified on this box** (no GPU/browser). Volley/ring/wall/blast spawn many
objects in one tick — worth a headless count assertion + a 1070 eye-test (§4, §5). No
code path caps or dedups them, so the risk is low.

### 1.7 Launch-time targeting parity ✅ (dev-lore item, foundation §4b)

The community "strafe-dodge at release" mechanic requires the projectile to aim at the
target's position at **release**, not windup. ACE computes velocity/heading at launch time
using the target's *current* `PhysicsObj.Position` (`CalculateProjectileVelocity:1710,1716`;
`spell.IsTracking ? target.CachedVelocity : Zero` at `:1728`) and ships it in the
ObjectCreate. Our client just integrates the shipped velocity — it inherits release-time
aim for free. No client work; no fix.

---

## 2. ROOT CAUSES / MECHANISMS (the fixable items)

### 2.1 Arc husk keeps falling after impact — `setVelocity` never clears `_ballistic`

Mechanism: on impact ACE sends VectorUpdate(0). `setVelocity` (`entities.js:8450-8460`)
replaces `inst.lastVel` with `{vx:0,vy:0,vz:0}` but leaves `_ballistic`/`_ballisticGravity`
set. `_tickBallisticProjectiles` (`entities.js:11582`) then still runs
`if (inst._ballisticGravity) lv.vz += PROJECTILE_GRAVITY_Z * step;` → `lv.vz` goes
negative → `pos.z += lv.vz*step` → the husk sinks (~½·9.8·5² ≈ 122 m over the 5 s window).
**Masked today** because kind=17 NoDraw-hides the husk first (§1.5), so it's invisible in
the normal path. It is a correctness/defense gap: any path where the hide is delayed or
absent (message reordering, a future `?worldLifecycle` change) would show a ghost plowing
into the ground. ACE sends **no in-flight VectorUpdate for a missile** (foundation §1.5;
`lib.rs:39977-39996` comment), so *any* VectorUpdate on a ballistic projectile is the
impact stop → safe to treat as "stop integrating".

### 2.2 `_groundClampZ` lifts a projectile spawned below terrain

Mechanism: the spawn path (`entities.js:~3820`) calls
`_groundClampZ(wx, wy, meta.z, cellIdx)` (`entities.js:42-54`) for **all** outdoor
entities. It lifts anything buried by 0.1–10 m up to the surface. A war/void bolt spawns at
2/3 caster height + forward; if that forward point sits below the terrain there (firing
into a rise, or a Ring/Blast spawned tight to a slope), `buryDepth > 0.1` → the launch
point jumps to terrain height → the bolt appears to leave the hillside instead of the hand.
Projectiles are airborne by definition and should never be ground-clamped.

### 2.3 `PROJECTILE_GRAVITY_ON` comment contradicts the code

`entities.js:995-998` comment: *"Default OFF (motion-adjacent visual) pending a 1070 GPU
eye-test"* — but `entities.js:999-1008` is `...get("projectileGravity")?.toLowerCase() !== "off"`
(**default-ON**), and `docs/url-flags.md:554` lists it `off` (escape) / **on** (default),
and `:12` lists `projectileGravity` under "Now default-ON". The comment is stale and
misleads the next reader. Doc-only.

### 2.4 Streak-swirl `omega` is parsed off the wire but dropped at the bridge

ACE gives spin to `RotationSpeed` projectiles: `SpellProjectile.Setup:120-126`
`if ((RotationSpeed ?? 0) != 0) { AlignPath = false; PhysicsObj.Omega = new Vector3((float)(Math.PI*2*RotationSpeed), 0, 0); }`
("creates the nice swirling animation"), and ACE serializes Omega when non-zero —
`WorldObject_Networking.cs:511-512 if (Omega != Vector3.Zero) ...Omega;` → `:399-401 writer.Write(Omega);`.
Our protocol **parses** it — `description.rs:843 pub omega: Option<Vector3>`, `:1078-1083`.
But the wasm spawn EntityUpdate hardcodes `omega_z: 0.0` (`lib.rs:40064`) and never reads
`data.omega`, and the EntityUpdate's `omega_z` channel is yaw-only (turn-in-place,
`entities.js:418-423`) — it can't carry the projectile's roll-axis (X) spin. So swirl
projectiles don't spin in our client.

**Content impact is negligible for this charter:** across the LSD-Partial projectile
weenies, `RotationSpeed` appears on essentially none of them (a single melee spike, wcid
44371, carries it; Lightning Bolt 20182 floatStats = `{78:1.0, 79:0.0, 26:8.0}` — no
rotation term). So war/void **bolts** don't swirl in retail either. Keep this as a
documented low-priority follow-up, relevant only if swirl-streak content is added.

---

## 3. PATCH PLAN

All hunks quote **current** code as context. Per foundation §4: validated fixes ship
default-ON with an `=off` escape; risky/visual ship default-OFF pending 1070 eye-test.

### PATCH 1 — stop ballistic integration on the impact VectorUpdate (`entities.js`)
Fix §2.1. Default-ON with `?projectileImpactStop=off` escape. Pure-JS, no rebuild.

```diff
   setVelocity(upd) {
     const inst = this.entityMap.get((upd.guid >>> 0));
     if (!inst) return;
     inst.lastVel = {
       vx: upd.vx ?? 0,
       vy: upd.vy ?? 0,
       vz: upd.vz ?? 0,
       omegaZ: upd.omegaZ ?? 0,
     };
     inst.lastVelMs = typeof performance !== "undefined" ? performance.now() : 0;
+    // WS10 (2026-07-12): ACE streams NO in-flight UpdatePosition/VectorUpdate for a
+    // PhysicsState::MISSILE object — the ONLY VectorUpdate a projectile ever receives is
+    // the impact zero-velocity stop (SpellProjectile.ProjectileImpact →
+    // GameMessageVectorUpdate, SpellProjectile.cs:237-238). So any VectorUpdate on a
+    // ballistic projectile IS the impact: stop self-integrating, else _ballisticGravity
+    // keeps decaying vz and the (NoDraw'd) husk sinks through the world for its 5 s
+    // pre-Destroy window. Gated on the projectile classification so a normal remote-entity
+    // dead-reckon VectorUpdate is untouched. `?projectileImpactStop=off` restores the
+    // (masked-by-NoDraw) legacy behavior byte-identically.
+    if (PROJECTILE_IMPACT_STOP_ON && inst._ballistic && this.isProjectile(upd.guid >>> 0)) {
+      inst._ballistic = false;
+      inst._ballisticGravity = false;
+    }
   }
```
Add the flag constant near the other projectile flags (`entities.js:~1009`):
```diff
 const PROJECTILE_GRAVITY_Z = -9.8; // m/s^2, AC frame (z up)
+// WS10 (2026-07-12): `?projectileImpactStop` (DEFAULT-ON, `=off` escape) — a ballistic
+// projectile that receives a VectorUpdate has impacted (ACE sends none in-flight), so
+// stop self-integrating. Prevents an arc husk from accruing gravity during its 5 s
+// NoDraw pre-Destroy window. Off = legacy (masked by the NoDraw hide).
+const PROJECTILE_IMPACT_STOP_ON = (() => {
+  try {
+    if (typeof window === "undefined" || !window.location) return true;
+    return new URLSearchParams(window.location.search).get("projectileImpactStop")?.toLowerCase() !== "off";
+  } catch (_) { return true; }
+})();
```
`url-flags.md` row (drafted):
```
| `projectileImpactStop` | `off` (escape) | **on** | Stop client ballistic integration when a projectile receives a VectorUpdate (ACE only sends one at impact); prevents an arc husk from sinking during its 5 s NoDraw pre-Destroy window. | scene3d/entities.js |
```

### PATCH 2 — projectiles bypass the spawn ground-clamp (`entities.js`)
Fix §2.2. Minimal; reuse the existing `?groundClamp` flag (no new flag). Needs the spawn
call site — re-verify the exact line before editing (Explore reported `~3813-3822`):

```diff
-  const wz = _groundClampZ(wx, wy, meta.z ?? 0, inst._outdoorCellIdx);
+  // WS10 (2026-07-12): never ground-clamp a MISSILE projectile — it is airborne by
+  // definition and its launch Z is server-authored to ~2/3 caster height
+  // (WorldObject_Magic.CalculatePreOffset). Clamping a bolt spawned below the terrain at
+  // its (wx,wy) — e.g. firing across a rise — would jump the launch point onto the
+  // hillside. `?groundClamp=off` already disables clamp globally.
+  const wz = this.isProjectile(guid)
+    ? (meta.z ?? 0)
+    : _groundClampZ(wx, wy, meta.z ?? 0, inst._outdoorCellIdx);
```
No new flag / no url-flags row (rides existing `groundClamp`). Note: `guid` and
`this.isProjectile` must be in scope at that call site — verify (they are in `_spawnImpl`).

### PATCH 3 — fix the stale `PROJECTILE_GRAVITY_ON` comment (`entities.js:995-998`)
Fix §2.3. Doc-only, no behavior change.

```diff
-// flight curves instead of flying constant-velocity. Default OFF
-// (motion-adjacent visual) pending a 1070 GPU eye-test; inert for any
-// pkg/ predating the `entityProjectileHasGravity` export (soft-guarded,
-// wasm manifest v2).
+// flight curves instead of flying constant-velocity. DEFAULT-ON
+// (flipped in the default-ON wave; url-flags.md row `projectileGravity`,
+// `=off` escape). Inert for any pkg/ predating the
+// `entityProjectileHasGravity` export (soft-guarded, wasm manifest v2).
```

### PATCH 4 (follow-up, NOT this pass) — forward projectile omega for swirl streaks
Fix §2.4. Default-OFF `?projectileOmega`, needs wasm rebuild + eye-test, negligible content
impact. Sketch only (do not land without a swirl-content test case):
- `lib.rs` spawn arm: add `omega_x/omega_y/omega_z` fields to the missile branch, sourced
  from `data.omega` (only for MISSILE), instead of the hardcoded `omega_z: 0.0`.
- `entities.js` spawn: if projectile + non-zero omega, seed `inst._spinOmega = {x,y,z}`.
- `_tickBallisticProjectiles`: integrate a roll quaternion per step (reuse the existing
  `_omegaAccumQ` premultiply at `entities.js:2487-2488`), and skip velocity-heading
  re-alignment (ACE sets `AlignPath=false` for these).
Defer until a swirl projectile is confirmed in live content.

**No other default-behavior changes.** The core flight path is intentionally left alone.

---

## 4. TESTS

### 4.1 New node test — impact-stop invariant (PATCH 1), pure JS, no browser
`test_ws10_projectile_impact_stop.mjs` — models the integrator + impact contract without
THREE. Asserts: (a) an arc projectile integrates gravity while flying; (b) after a
zero-velocity VectorUpdate on a projectile it stops falling; (c) flag-off preserves the
legacy fall.

```js
// node test_ws10_projectile_impact_stop.mjs
// Models entities.js _tickBallisticProjectiles + setVelocity impact-stop (PATCH 1).
const G = -9.8;
function makeInst() { return { _ballistic: true, _ballisticGravity: true,
  lastVel: { vx: 5, vy: 0, vz: 0 }, pos: { x: 0, y: 0, z: 100 } }; }
function tick(inst, step) {
  if (!inst._ballistic) return;
  const lv = inst.lastVel;
  if (inst._ballisticGravity) lv.vz += G * step;
  inst.pos.x += lv.vx * step; inst.pos.y += lv.vy * step; inst.pos.z += lv.vz * step;
}
function setVelocity(inst, upd, { impactStopOn, isProjectile }) {
  inst.lastVel = { vx: upd.vx ?? 0, vy: upd.vy ?? 0, vz: upd.vz ?? 0 };
  if (impactStopOn && inst._ballistic && isProjectile) {
    inst._ballistic = false; inst._ballisticGravity = false;
  }
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

// (a) arc falls while flying
let a = makeInst(); for (let i = 0; i < 10; i++) tick(a, 0.1);
ok(a.pos.z < 100, "(a) arc projectile drops under gravity while flying");

// (b) impact-stop (flag on, is projectile): no further fall
let b = makeInst(); for (let i = 0; i < 5; i++) tick(b, 0.1);
const zAtImpact = b.pos.z;
setVelocity(b, { vx: 0, vy: 0, vz: 0 }, { impactStopOn: true, isProjectile: true });
for (let i = 0; i < 50; i++) tick(b, 0.1); // 5 s husk window
ok(Math.abs(b.pos.z - zAtImpact) < 1e-9, "(b) impact-stop freezes z after VectorUpdate");
ok(b._ballistic === false, "(b) _ballistic cleared on impact");

// (c) flag off: legacy sink continues (VectorUpdate zeroes vz, so it restarts the
// fall from 0 velocity → ~125 m drop over the 5 s window from z≈98.5 to ≈-26).
let c = makeInst(); for (let i = 0; i < 5; i++) tick(c, 0.1);
const zAtImpactC = c.pos.z;
setVelocity(c, { vx: 0, vy: 0, vz: 0 }, { impactStopOn: false, isProjectile: true });
for (let i = 0; i < 50; i++) tick(c, 0.1);
ok(zAtImpactC - c.pos.z > 100, "(c) flag-off husk keeps sinking >100m (legacy, masked by NoDraw)");

console.log(`WS10 impact-stop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

### 4.2 Existing tests to keep green
`test_ac_spell_shape.mjs`, `test_ac_spell_cast_sequence.mjs`,
`test_ac_cast_over_locomotion.mjs` — none touch the projectile integrator; run them if the
spawn/velocity plumbing changes.

### 4.3 TODO-FOR-LAPTOP — position-over-time capture (headless bot)
No live ACE / browser on this box. On the laptop:

1. Serve: `python3 external/holtburger/scripts/serve.py` → :8765.
2. Headless bot URL (foundation §5):
   `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1`
   poll `window.__bootState==='in-world'`.
3. Instrument projectile flight (console):
```js
window.__ws10 = [];
const em = window.liveScene3d.entityManager;
const _spawn = em.isProjectile.bind(em);
const iv = setInterval(() => {
  for (const [g, inst] of em.entityMap) {
    if (em.isProjectile(g) && inst._ballistic && inst.root) {
      window.__ws10.push({ t: performance.now(), g,
        x: inst.root.position.x, y: inst.root.position.y, z: inst.root.position.z,
        grav: !!inst._ballisticGravity, vz: inst.lastVel?.vz });
    }
  }
}, 16);
```
4. Cast a war **bolt** (flat) and a **NonTracking/Arc** spell (see LSD ids below) at a
   target dummy: `window.__sessionHandle.castTargetedSpell(targetGuid, spellId)`.
5. Assert from `window.__ws10`:
   - **Bolt:** z stays within ~ε of the launch z across the flight (flat). Launch z ≈
     caster.z + 2/3·caster.height (≈ +1.2 m for a ~1.8 m humanoid), **not** ≈ caster.z
     (feet). `grav === false`.
   - **Arc:** z rises then falls (parabola); `grav === true`; impact z ≈ target chest.
   - **Both:** after impact, z stops changing (PATCH 1) within one frame of the VectorUpdate
     (`grep` `__diag.wire.summary()` for the incoming VectorUpdate; confirm the entity
     hides — `inst.root.visible === false` — right after).
6. **Multi-shot count:** cast a volley/ring/wall/blast; assert
   `[...em.entityMap].filter(([g]) => em.isProjectile(g)).length === expectedN`
   (expectedN = `spell.NumProjectiles`, read from ACE/`data/spell-shapes.json`).
7. Known-good test spells (LSD ids, foundation §5): war I bolts (low mana) for the flat
   case; for Arc, pick a **NonTracking** war/void spell (verify `spell.NonTracking` /
   category via `data/spell-shapes.json`); void needs a void-trained char
   (`playerKnownSpells()`).

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do NOT run here)

| # | Flag combo | Spell | Expected visual |
|---|---|---|---|
| E1 | bare default | war bolt (e.g. Lightning Bolt) at a dummy | Bolt leaves the caster's **hand/chest** (not feet), flies **flat**, glowing GfxObj streak, small Launch burst at muzzle, Explode splash at target, husk vanishes on impact (no bolt left hovering, no ghost sailing through). |
| E2 | bare default (`projectileGravity` default-ON) | a **NonTracking/Arc** war or void spell | Projectile **rises then falls** in a parabola; impact near target chest; no ground-plow on short shots. Bolts in E1 still flat (contrast). |
| E3 | bare default | **volley / ring / wall / blast** multi-shot | **N** distinct projectiles spawn in one cast, correct fan/grid/ring geometry, all N fly + impact independently; N Launch bursts. |
| E4 | `?projectileImpactStop=off` vs on | any arc spell, watch a **resisted/missed** shot that flies past | off: (if hide races) faint ghost may sink; on: clean stop. Confirm on = no regression, husk hidden either way. |
| E5 | `?projectileGravity=off` | Arc spell | Arc flies **flat** (regression sanity: proves the gravity path is what curves it). |
| E6 (later) | `?projectileOmega=on` (after PATCH 4 + rebuild) | a swirl-streak projectile IF such content exists | Projectile visibly **rolls/swirls** about its travel axis; `off` = no spin. Skip if no RotationSpeed content. |

---

## 6. RISKS + CROSS-WORKSTREAM INTERACTIONS

**Files I would touch (for integration ordering):**
- `apps/holtburger-web/scene3d/entities.js` — PATCH 1 (setVelocity + new flag const),
  PATCH 2 (spawn ground-clamp bypass), PATCH 3 (comment). **JS-only, no rebuild.**
- `apps/holtburger-web/docs/url-flags.md` — one new row (`projectileImpactStop`).
- (PATCH 4, deferred) `apps/holtburger-web/src/lib.rs` (spawn EntityUpdate omega fields)
  + `entities.js` — **needs the batched wasm rebuild**; not in this pass.

**`entities.js` contention (HIGH — coordinate merges):** this file is the shared surface
for WS covering cast animation, locomotion, hooks, VFX. My edits are localized:
`setVelocity` (~:8450), a new flag const (~:1009), the spawn-position call site (~:3820),
and a comment block (~:995). None touch the cast/locomotion/hook machinery. Land after the
larger `entities.js` animation waves to avoid churn, or hand these 4 small hunks to whoever
owns the `entities.js` merge.

**Risks:**
- PATCH 1 relies on the invariant "ACE sends no in-flight VectorUpdate for a missile"
  (foundation §1.5, verified against ACE). If a future server *did* send a mid-flight
  VectorUpdate to a MISSILE, this would freeze it early. Mitigation: gated on
  `isProjectile` + flag escape; the impact VectorUpdate is zero-velocity, so an optional
  extra guard on `|v|<ε` could be added if paranoid. LOW.
- PATCH 2 assumes `guid`/`isProjectile` are in scope at the spawn call site — **re-verify
  before editing** (Explore reported the site at `entities.js:~3813-3822`; my direct read
  covered `_groundClampZ` at `:42-54` but not the exact call line). LOW.
- Interaction with **VFX/particle WS**: the Explode/Launch bursts (`play_effect_vfx.js`)
  and the glowing-GfxObj material (`?luminousEmissiveMap`, default-ON) are the *appearance*
  of the projectile — out of my scope but adjacent. If a VFX WS changes burst anchoring,
  keep the `entitiesGroup` (world) parent for impact bursts (§1.5) so NoDraw'd husks don't
  blank the explosion.
- Interaction with **WS covering `?worldLifecycle`**: the impact NoDraw-hide (kind=17)
  rides the SetState message path (always on), independent of `worldLifecycle`. If that WS
  reroutes SetState, preserve the `should_draw()` diff → kind=17 emit
  (`mutations.rs:1472-1498`) or the husk stops hiding and PATCH 1 becomes visible-load-bearing.
- No mana/damage/skill logic touched (that's `CalculateDamage`/`DamageTarget`, server-side).

**Deliberately NOT changed (guardrails):** arc-gravity behavior (it's correct), the flat
bolt flight, multi-projectile N-object rendering, the server-authored spawn height, the
inert wire DefaultScript (retail also no-ops it). This is an improvement pass — the flight
path was hard-won and is faithful; only the four small items above move.

---

## Appendix A — DAT oracle commands used (reproducible on this box)

```bash
# projectile setups (typeName is "Setup", NOT "SetupModel"); output is NDJSON,
# skip the first "ready" banner line:
echo '{"command":"chorizite-parse-dat-record","datPath":"/home/wbterminal/ac_base_dats/client_portal.dat","idHex":"0x02000C52","typeName":"Setup"}' \
 | DOTNET_ROLL_FORWARD=LatestMajor dotnet /home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
# → default_script=0, defaultScriptTable=0, one part GfxObj 0x010028CD (Lightning Bolt)
```
Projectile wcids/setups (LSD `weenie_summary.jsonl`, weenieType 33 = ProjectileSpell):
Lightning Bolt 20182 → `0x02000C52`; Nether Bolt 43230 → `0x02001A28`;
Force Bolt 7264 → `0x020003F3`. Lightning Bolt floatStats `{26:8.0 (MaxVelocity), 78:1.0, 79:0.0}`.

## Appendix B — key ACE cites (re-verified live 2026-07-12)
- `WorldObject_Magic.cs`: `CreateSpellProjectiles` 1509-1523; `CalculatePreOffset` 1528-1563;
  `CalculateProjectileOrigins` 1569-1668; `CalculateProjectileVelocity` 1695-1757
  (`useGravity` 1730); `LaunchSpellProjectiles` 1759-1845 (`useGravity` 1761, per-shot
  spawn 1770-1841); `GetProjectileSpeed` 1898-1936; consts `ProjHeight=2/3` 1526,
  `ProjHeightArc=5/6` 1690.
- `SpellProjectile.cs`: `Setup` 68-127 (`Missile=true` 77, `DefaultScriptId=ProjectileCollision`
  86-92, Omega/`AlignPath=false` 120-126); `GetProjectileSpellType` 129-167;
  `ProjectileImpact` 209-244; `SetProjectilePhysicsState` 868-893 (`useGravity`→GravityStatus 870-871).
- `WorldObject_Networking.cs`: Velocity flag 505-506/389-391; Omega flag 511-512/399-401;
  DefaultScript flag 514-515/404-405.
- `Physics/PhysicsGlobals.cs:13` Gravity=-9.8f. `PlayScript.cs`: Launch=0x04, Explode=0x05,
  ProjectileCollision=0x5A (9,10,95).

## Appendix C — key holtburger cites (re-verified live 2026-07-12)
- `src/lib.rs`: missile velocity forward 39997-40006; `omega_z:0.0` 40064; projectile
  classify (MISSILE→index, +GRAVITY) 27581-27588 / 27772-27777; `entity_is_projectile`
  29963, `entity_projectile_has_gravity` 29978-29979; delete prune 27826-27834; kind=17
  const 20889 + emit 38306.
- `scene3d/entities.js`: `_groundClampZ` 42-54; `PROJECTILE_GRAVITY_ON` 999-1008 +
  `PROJECTILE_GRAVITY_Z=-9.8` 1009; ballistic seed 4031-4045; `setVelocity` 8450-8460;
  `isProjectile` 6026-6036 / `projectileHasGravity` 6048-6058;
  `_tickBallisticProjectiles` 11554-11589 (gravity 11582).
- `crates/holtburger-protocol/.../description.rs`: velocity 1052-1063; omega 843/1078-1083.
- `crates/holtburger-common/src/properties/object.rs`: MISSILE 0x40 (62), GRAVITY 0x400 (66).
- `scene3d/play_effect_vfx.js`: burst anchored to entitiesGroup 739-745; Launch 2035-2042;
  Explode 2049-2051; ProjectileCollision(0x5A) 2607-2609.
- `docs/url-flags.md`: `projectileGravity` 554; `setupDefaultScript`/`defaultScriptSpawn`
  default-ON list 12.
```json
{"workstream":"WS10","title":"War/void projectile visuals (bolt, streak, blast, volley, ring, wall)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS10-projectiles.md","confidence":"high","keyFindings":["Core flight path is CORRECT vs ACE: spawn velocity guaranteed non-zero (MaximumVelocity weenie prop), spawn Z server-authored to 2/3 caster height (chest not feet) and honored by client, impact hides+explodes+stops in the right order.","RESOLVED 2026-06-06 open question: ACE integrates gravity server-side ONLY for ProjectileSpellType.Arc (useGravity==Arc), signalled via PhysicsState::GRAVITY 0x400; our client mirrors it exactly (entityProjectileHasGravity -> _ballisticGravity, -9.8 == ACE PhysicsGlobals.Gravity). War/void bolts carry no GRAVITY bit and fly flat. No mismatch.","Multi-projectile shapes (volley/ring/wall/blast) are server-authored as N separate SpellProjectile ObjectCreates; our client renders N automatically (no client shape logic, no cap/dedup). No fix.","Trail VFX is DAT-proven to be the glowing GfxObj part + Launch(0x04)/Explode(0x05) scripts: projectile setups carry default_script=0 AND defaultScriptTable=0 (Lightning Bolt 0x02000C52, Nether Bolt 0x02001A28, Force Bolt 0x020003F3), so setupDefaultScript/defaultScriptSpawn correctly attach nothing; retail's wire DefaultScript=ProjectileCollision(0x5A) also no-ops (no script table).","LATENT: setVelocity never clears _ballistic, so an arc husk keeps accruing gravity for its 5s NoDraw pre-Destroy window (masked today by the kind=17 NoDraw hide). PATCH 1, default-ON with escape.","EDGE: _groundClampZ runs on projectile spawns and could lift a below-terrain launch point onto a hillside. PATCH 2 (isProjectile bypass).","DOC: PROJECTILE_GRAVITY_ON comment says 'Default OFF' but code + url-flags are default-ON (stale comment). PATCH 3.","CODE GAP (negligible content impact): wire Omega for swirl streaks is parsed (description.rs:843) but dropped at the bridge (lib.rs:40064 omega_z:0.0); RotationSpeed is ~unused by war/void projectile weenies in LSD. PATCH 4 deferred, default-OFF."],"filesToChange":["apps/holtburger-web/scene3d/entities.js","apps/holtburger-web/docs/url-flags.md","apps/holtburger-web/src/lib.rs (PATCH 4, deferred, needs rebuild)"],"needsWasmRebuild":false,"newFlags":["projectileImpactStop","projectileOmega (deferred, PATCH 4)"],"risks":["entities.js is a high-contention shared file (cast/loco/hook/VFX WS) — 4 localized hunks, land after the big animation waves or hand to the entities.js merge owner","PATCH 1 relies on 'ACE sends no in-flight VectorUpdate for a missile' (verified); a future mid-flight VectorUpdate would freeze early — mitigated by isProjectile+flag escape","PATCH 2 assumes guid/isProjectile are in scope at the spawn call site (~entities.js:3820) — re-verify exact line before editing","impact NoDraw-hide (kind=17) rides the SetState message path independent of ?worldLifecycle; if a lifecycle WS reroutes SetState, preserve the should_draw diff or PATCH 1 becomes load-bearing","adjacent to VFX/particle WS: keep impact bursts anchored to entitiesGroup (world) so NoDraw'd husks don't blank the explosion; glowing-GfxObj brightness depends on ?luminousEmissiveMap (cross-WS)","PATCH 4 needs the batched wasm rebuild and a swirl-content test case; deferred"]}
```

---

## VERDICT (WS10-verify)

**Verdict: CONFIRMED — apply: true** (2 minor, non-blocking corrections). Adversarial
re-verification on the buildbox, 2026-07-12. Every load-bearing cite was re-opened in the
CURRENT tree, the ACE cites were re-read live, the §1.4 DAT claim was re-pulled from the
oracle, and the proposed node test was run. The packet's headline is correct: **the core
projectile flight path is faithful to ACE and must not be "fixed" away; only the 3 small
JS patches (+ 1 deferred wasm follow-up) move.**

### Load-bearing claims — ALL VERIFIED

| Claim | Cite (re-verified) | Status |
|---|---|---|
| Velocity forwarded ONLY for MISSILE spawns | `lib.rs:39997-40006` (exact) | ✅ |
| `omega_z:0.0` hardcoded at spawn, `data.omega` never read (PATCH 4 premise) | `lib.rs:40064` (exact) | ✅ |
| Projectile classify: MISSILE→`projectile_index`, +GRAVITY→`PROJECTILE_GRAVITY_GUIDS` | `lib.rs:27581-27588` (exact) | ✅ |
| `entity_projectile_has_gravity` accessor | `lib.rs:29978-29979` (exact) | ✅ |
| Delete-prune of both projectile indexes on ObjectDelete | `lib.rs:27826-27834` (exact) | ✅ |
| Protocol parses VELOCITY (12 bytes) + OMEGA (12 bytes) | `description.rs:1052-1063` / `1078-1089` | ✅ |
| `MISSILE=0x40`, `GRAVITY=0x400` | `object.rs:62` / `:66` | ✅ |
| ACE `ProjHeight=2/3`, `ProjHeightArc=5/6`, `startFactor = Arc?1:ProjHeight` | `WorldObject_Magic.cs:1526/1690/1531` | ✅ |
| ACE `useGravity = spellType == Arc` (velocity + launch), `Gravity=-9.8f` | `WorldObject_Magic.cs:1730/1761`, `PhysicsGlobals.cs:13` | ✅ |
| ACE impact ordering: NoDraw→SetState→Explode→VectorUpdate(0)→5 s Destroy | `SpellProjectile.cs:213-243` (exact) | ✅ |
| ACE `if(useGravity) GravityStatus=true` | `SpellProjectile.cs:870-871` | ✅ |
| Client seeds `_ballisticGravity = PROJECTILE_GRAVITY_ON && projectileHasGravity(guid)` | `entities.js:4042-4043` | ✅ |
| Client integrates `if(_ballisticGravity) lv.vz += -9.8*step` | `entities.js:11582` | ✅ |
| Impact burst parented to `entitiesGroup` (world), not the hidden rig | `play_effect_vfx.js:745` | ✅ |
| VectorUpdate(kind=4) → `em.setVelocity` (PATCH 1 is LIVE, not a dead no-op) | `loop.js:2525,2879` | ✅ |
| DAT: Lightning Bolt Setup `0x02000C52` has `defaultScript={dataId:0}`, `defaultScriptTable={dataId:0}` | oracle, re-pulled this session | ✅ |

### Patches — APPLICABLE against the current tree

- **PATCH 1 (`setVelocity` impact-stop)** — context (`entities.js:8450-8460`) is an
  **exact match**; the new flag const is well-formed and default-ON with `=off` escape;
  `isProjectile` exists (`entities.js:6026-6036`). Verified **live** (impact VectorUpdate
  routes kind=4→`setVelocity`). **No regression:** clearing `_ballistic` on impact does
  NOT re-enable any per-frame husk re-anchor, because both re-anchor paths
  (`applyManagedPose` `entities.js:4965`, dead-reckon smoother `:11834`) *additionally*
  gate on `inst._serverTargetPos`, which a MISSILE never receives — so the husk stays
  frozen-and-hidden, the intended outcome. For a FLAT bolt the patch is behavior-identical
  to legacy (both freeze the husk). The proposed node test **runs 4/4 PASS** and models the
  integrator + patch contract faithfully. Default-ON is justified (no-op in the happy path;
  the husk is NoDraw either way).
- **PATCH 2 (projectile ground-clamp bypass)** — context line
  `const wz = _groundClampZ(wx, wy, meta.z ?? 0, inst._outdoorCellIdx);` is an **exact
  match** and is the SOLE call site. `guid` is defined at `_spawnImpl` top
  (`entities.js:3095 const guid = meta.guid >>> 0;`) and `this.isProjectile` is a method —
  **both in scope.** ⚠ **Correction 1 (cite):** the actual call site is **`entities.js:3828`**,
  NOT the "~3813-3822" the packet cites (the packet already flagged this as needing
  re-verification — now resolved; use 3828). Only-spawn patching is sufficient: ACE sends
  no in-flight UpdatePosition for a missile, so there is no re-clamp path to also patch.
- **PATCH 3 (stale comment)** — the comment at `entities.js:995-998` **does** say
  "Default OFF"; the code (`:1003 !== "off"`) and `url-flags.md:12` + `:554` are
  **default-ON**. Doc-only fix confirmed correct.
- **PATCH 4 (omega)** — correctly deferred; `omega_z:0.0` and the parsed-but-dropped wire
  Omega are real (`lib.rs:40064`, `description.rs:1078-1089`); negligible war/void content
  impact. Fine to defer.

### Required / recommended corrections

1. **(cite, do before landing PATCH 2)** The PATCH 2 call site is **`entities.js:3828`**,
   not ~3813-3822. Apply the hunk there. Everything else about PATCH 2 is correct and in
   scope.
2. **(convention, low severity)** PATCH 2 gives projectiles an **unconditional** clamp
   bypass with **no isolated escape** — `?groundClamp=off` reverts it only by disabling
   ground-clamp for *every* entity, so there is no clean per-behavior revert as foundation
   §4.3 prefers ("validated fix → default-ON + `?flag=off` escape"). The change is
   correct-by-construction and fires only on the rare below-terrain projectile spawn, so
   this is not blocking, but the integrator should either (a) add a dedicated default-ON
   flag (e.g. `?projectileGroundClamp`, `=off` escape) with a url-flags.md row, or
   (b) explicitly document in the hunk that the bypass is unconditional. Recommend (a) for
   §4 compliance; (b) is acceptable given the improvement-pass "keep it minimal" law.

### Not blocking / noted

- PATCH 1's `projectileImpactStop` url-flags row is well-formed and matches the
  `| Flag | Values | Default | Effect | Where |` table shape (add a line number to the
  "Where" cell to match sibling rows).
- The §1.5 kind=17 NoDraw-hide path (the mask that makes PATCH 1 defense-in-depth rather
  than load-bearing) was accepted by reference to the well-established SetState→`should_draw`
  →visibility mechanism; not deep-traced this pass. If a `?worldLifecycle` WS reroutes
  SetState, PATCH 1 becomes visibly load-bearing (packet §6 already flags this).
- Multi-projectile independence (§1.6) is structurally sound: per-guid `HashSet`
  (`lib.rs:27582`) + `_tickBallisticProjectiles` walks `entityMap.values()`
  (`entities.js:11557`) → N distinct guids integrate independently. No client shape logic,
  no cap/dedup. Confirmed. (Still owed the headless N-count + 1070 eye-test per §4/§5.)
- The TODO-FOR-LAPTOP capture recipe (§4.3) and the 1070 eye-test queue (§5) are the right
  next steps; nothing on this box can substitute for them (no GPU/browser/live-ACE).

```json
{"workstream":"WS10","verdict":"CONFIRMED","apply":true,"mustFix":["PATCH 2 call site is entities.js:3828 (the sole _groundClampZ call site), NOT the ~3813-3822 the packet cites — apply the hunk there; guid (defined :3095) and this.isProjectile are both in scope, confirmed","PATCH 2 low-severity convention gap: the projectile ground-clamp bypass is unconditional with no isolated escape (riding ?groundClamp=off also un-clamps all other entities) — per foundation §4.3 add a dedicated default-ON flag (e.g. ?projectileGroundClamp) + url-flags row, OR explicitly document the unconditional bypass in the hunk (non-blocking)"],"notes":"All load-bearing cites re-verified exact against the current tree (lib.rs 39997-40006/40064/27581-27588/29978-29979/27826-27834; entities.js 42-54/995-1009/4042-4043/6026-6058/8450-8460/11554-11589; description.rs 1052-1089; object.rs 62/66; play_effect_vfx.js 745). ACE cites re-read live (WorldObject_Magic.cs ProjHeight 1526 / ProjHeightArc 1690 / useGravity==Arc 1730,1761; PhysicsGlobals.cs Gravity=-9.8 :13; SpellProjectile.cs ProjectileImpact 213-243 / GravityStatus 870-871). §1.4 DAT claim re-pulled from the oracle: Lightning Bolt Setup 0x02000C52 default_script=0 AND defaultScriptTable=0 — confirmed. PATCH 1 verified LIVE (kind=4 VectorUpdate→setVelocity at loop.js 2525/2879) and regression-free (clearing _ballistic can't re-anchor the husk — both re-anchor paths also require _serverTargetPos which a missile never gets). Proposed node test runs 4/4 PASS. Core flight path is faithful to ACE and must be left alone; only the 3 JS patches + deferred PATCH 4 move. Two corrections are cite/convention only — the mechanism and applicability of every patch hold."}
```
