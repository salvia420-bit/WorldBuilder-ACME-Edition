I have everything I need — the full data path is confirmed in-tree. Writing the build spec.

---

# SLICE 06 — DRAW/CAST STATE PLUMBING (legacy-safe)

## Goal
Let the `procMotion.limbFlex` (bow), `procMotion.stringHinge` (bow string), and `emissive.castGlow` components read a normalized **draw/charge/cast progress** scalar (`drawAmount ∈ [0,1]`) for an entity, and **prove** that scalar is the *same* read-only client value the renderer already maintains for the charge-attack windup and the cast-gesture chain. Zero new wire traffic, zero server-replicated writes. Output: the data path (file:line), the legacy-safety proof, the exact read-only accessor, and a build checklist.

The headline result: **the client already knows draw/cast progress.** It is stored as render-side animation substate (`inst._swingHold` for held draws, `inst._castBusyUntilMs`/`_castSequenceToken` for casts) and is fully derivable from `THREE.AnimationAction.time` + `clip.duration`. No value on this path is sent to the server; it is a *consumer* of the server's authoritative motion broadcasts and of local input, never a producer.

---

## Design

### A. Where the client already knows DRAW/CHARGE progress

The "draw" of a bow is AC's **charge-attack hold-at-peak windup**. It is driven entirely by local input in `picking.js`, never by a wire write the client originates:

- **Draw START** — `picking.js:562 startCharge(...)` → `picking.js:586-587`:
  ```js
  if (em && localGuid !== 0 && cmd !== 0 && typeof em.setSwingMotion === "function") {
    em.setSwingMotion(localGuid, cmd, { holdAtPeak: true });   // ← begin windup hold
  }
  ```
- **Draw RELEASE (fire)** — `picking.js:298-299`:
  ```js
  if (em && localGuid !== 0 && typeof em.releaseSwingHold === "function") {
    em.releaseSwingHold(localGuid);
  }
  ```

`setSwingMotion(guid, motionCmd, { holdAtPeak:true })` (`entities.js:6156`) plays the swing clip and, at `entities.js:6310-6332`, **pauses the mixer at the peak frame** (`peakMs = round(dur*500)`, i.e. `dur*0.5`, `entities.js:6312`; `action.paused = true`, `entities.js:6319`) and records the hold:
```js
inst._swingHold = { swingKey, stance, action, peakTimerId, startedMs: performance.now() };  // entities.js:6326-6332
```
`releaseSwingHold` (`entities.js:5975`) already reads exactly the two numbers we need to derive progress — `entities.js:6007-6009`:
```js
const clipDuration = (action?.getClip?.()?.duration ?? 0);
const currentTime  = (action?.time ?? 0);
```

So **draw progress** = `clamp01(action.time / (clip.duration * 0.5))`:
- ramps `0 → 1` as the windup plays from frame 0 to the peak frame,
- pins at `1.0` while `action.paused === true` (held at full draw),
- drains back toward `0` as the post-release remainder plays (the strike), since `action.time` continues past the peak after `releaseSwingHold` un-pauses (`entities.js:5993 action.paused = false`).

`holding = (action.paused === true)` cleanly distinguishes "at full draw, waiting" from "mid-windup" or "loosing."

### B. Where the client already knows CAST progress

The cast windup chain is `playCastSequence(guid, spellId)` (`entities.js:5751`). Its client-local state:
- `inst._castBusyUntilMs` — wall-clock end of the windup window, set at `entities.js:5789/5795` to `nowMs + min(12000, estMs/CAST_SPEED)`.
- `inst._castSequenceToken` — monotonic in-flight token (`entities.js:5800-5801`); a bump cancels the chain (`cancelCastSequence`, `entities.js:5950`).
- Each gesture is played as a real mixer action via `setSwingMotion(g, motionU32, { speed })` (`entities.js:5834`), so `inst.currentAction`/`inst.currentActionKey` track the live windup clip.

For a 0→1 cast ramp we need a **start** stamp to pair with the existing **end** (`_castBusyUntilMs`). It does not exist yet, so we add one client-local wall-clock stamp `inst._castStartedMs` at the same site (one line, read-only thereafter). Then:
```
castAmount = clamp01((now - inst._castStartedMs) / (inst._castBusyUntilMs - inst._castStartedMs))
```

### C. A bow is a CHILD entity — resolve the wielder

A wielded bow is attached under the wielder's hand part: `entities.js:2066-2067`:
```js
this._attachedParentGuid = null;   // wielder guid when this entity is a held child (weapon/shield/bow)
this._attachedChildren  = null;    // Set of child guids when this entity is a wielder
```
The bow entity itself has **no** `_swingHold` (the hold is armed on the *wielder*, the player guid). So the bow-limb component must hop `bow.guid → bow._attachedParentGuid → wielder.inst` and read the wielder's draw state. The accessor does this hop internally so the component just passes the bow's guid.

### D. The read-only accessor (the deliverable)

One public, guid-keyed method on `EntityManager`, mirroring the existing `setPose(guid,…)`, `releaseSwingHold(guid)`, `clearCastBusy(guid)` surface. **Pure reads, zero writes.** Lazy (computes only when a component asks → no per-entity cost when no component is attached). Follows the `inst._motionSpeed` precedent (`entities.js:6648`) — a per-instance derived scalar that render code consumes read-only (read sites `entities.js:6135-6139`, `6261`).

```ts
/**
 * READ-ONLY. Current draw/charge/cast progress for `guid`, derived ENTIRELY
 * from client-local animation substate (mixer action time + clip duration +
 * the swing-hold / cast wall-clock stamps) and the client wall-clock. Writes
 * NOTHING. For a held child (bow/weapon), transparently resolves the wielder.
 *
 * @returns {{ mode:'draw'|'cast', amount:number, holding:boolean } | null}
 *          null when the entity has no active draw/cast.
 */
getDrawCastState(guid) {
  let inst = this.entityMap.get(guid >>> 0);
  if (!inst) return null;

  // Held child (bow) → hop to the wielder, which owns the windup substate.
  if (!inst._swingHold && !inst._castSequenceToken && inst._attachedParentGuid != null) {
    const w = this.entityMap.get(inst._attachedParentGuid >>> 0);
    if (w) inst = w;
  }

  // --- DRAW / CHARGE (hold-at-peak) ---
  const hold = inst._swingHold;
  if (hold && hold.action) {
    const action = hold.action;
    const clip = action.getClip?.();
    const dur  = clip ? +clip.duration : 0;
    if (dur > 0) {
      const peak = dur * 0.5;                              // hold pauses at dur*0.5 (entities.js:6312)
      const amount = Math.min(1, Math.max(0, (action.time ?? 0) / peak));
      return { mode: 'draw', amount, holding: action.paused === true };
    }
    // Degenerate clip: report binary held state, no divide-by-zero.
    return { mode: 'draw', amount: action.paused === true ? 1 : 0, holding: action.paused === true };
  }

  // --- CAST (windup chain) ---
  if (inst._castSequenceToken && inst._castBusyUntilMs) {
    const now = (typeof performance !== "undefined" ? performance.now() : 0);
    const start = inst._castStartedMs ?? 0;
    const end   = inst._castBusyUntilMs;
    if (now < end && end > start) {
      return { mode: 'cast', amount: Math.min(1, Math.max(0, (now - start) / (end - start))), holding: false };
    }
  }
  return null;
}

/** Convenience: scalar-only, 0 when idle. For simple uniform binding. */
getDrawAmount(guid) { const s = this.getDrawCastState(guid); return s ? s.amount : 0; }
```

**Remote-entity note (refinement, optional):** remote archers never arm `_swingHold` (that path is local-input-only via `picking.js startCharge`). Their bow draw is a server-echoed one-shot missile/aim clip playing through `inst.currentAction`. To animate remote bows, add a fallback branch: if `inst.currentActionKey?.startsWith("swing:")` and the resolved command is a missile/aim cmd (the `CYCLE_HELD_COMMANDS` aim set `entities.js:1351-1358` / missile fire), return `{ mode:'draw', amount: clamp01(currentAction.time / clip.duration), holding:false }`. Still a pure render-state read. Recommend shipping local-only first (P2), adding the remote fallback when the effect is validated.

### E. Consumption (how a component reads it without writing anything replicated)

The bow-limb-flex MECH-B material (slice 04/05) holds a per-entity **cloned** material with a `uDrawAmount` uniform. Once per frame, in the material/oscillator tick (slice 07; same cadence as the `uTime` push at `loop.js:827-828`), it does **read → write-own-uniform only**:
```js
const s = em.getDrawCastState(bowGuid);           // READ client render-state
const target = (s && s.mode === 'draw') ? s.amount : 0;
mat.uniforms.uDrawAmount.value += (target - mat.uniforms.uDrawAmount.value) * relaxK;  // WRITE cloned uniform only
```
`relaxK` (~0.25/frame) eases the limb back to rest when the draw ends or the entity despawns mid-draw. The uniform is read in `_chainBeforeCompile` at `begin_vertex` (MECH-B) — `uDrawAmount` *value* varies per-instance without changing the shader program, so `customProgramCacheKey` stays **one stable key per component-set**, not per-instance (no shader-link explosion).

---

## Integration seams (file:line)

| Seam | File:line | Role |
|---|---|---|
| Draw START (local input) | `scene3d/picking.js:586-587` | `setSwingMotion(localGuid, cmd, {holdAtPeak:true})` arms the windup hold |
| Draw RELEASE (fire) | `scene3d/picking.js:298-299` | `releaseSwingHold(localGuid)` |
| Hold record (the draw substate) | `scene3d/entities.js:6326-6332` | `inst._swingHold = { action, peakTimerId, startedMs, … }` |
| Peak = dur×0.5 / pause | `scene3d/entities.js:6310-6319` | `peakMs = round(dur*500)`; `action.paused = true` |
| Progress numbers already read | `scene3d/entities.js:6007-6009` | `action.getClip().duration`, `action.time` (in `releaseSwingHold`) |
| Cast window stamps | `scene3d/entities.js:5789, 5795` | `inst._castBusyUntilMs`; **add `inst._castStartedMs = nowMs;` here** |
| Cast in-flight token | `scene3d/entities.js:5800-5801` | `inst._castSequenceToken` |
| Cast teardown (zero the stamps) | `scene3d/entities.js:5940 clearCastBusy`, `5950 cancelCastSequence` | also set `_castStartedMs = 0` |
| Wielded-child → wielder map | `scene3d/entities.js:2066-2067` | `_attachedParentGuid` / `_attachedChildren` |
| **New accessor home** | `scene3d/entities.js` ~`5943` (next to `clearCastBusy`) | `getDrawCastState(guid)` + `getDrawAmount(guid)` |
| Read-only scalar precedent | `scene3d/entities.js:6648` (set), `6135-6139` (read) | `inst._motionSpeed` pattern to mirror |
| Per-frame consumer cadence | `scene3d/loop.js:827-828` (`uTime` push), `loop.js:1818` (`entityManager.tick(dt)`) | where the component's uniform update runs |
| Per-entity tick loop (if eager caching chosen) | `scene3d/entities.js:10171 tick(dt)`, loop body `:10220` | optional `inst._drawAmount01` cache site |

---

## Edge cases & legacy-safety check (per THE RULE)

**THE RULE — reads.** The accessor reads only: `action.time` (THREE render state, advanced by the wall-clock-driven `mixer.update(dt)`); `clip.duration` (DAT-derived, static); `action.paused`; `_swingHold` (client-local, built from local *input* in `picking.js`, never on the wire); `_castBusyUntilMs`/`_castStartedMs`/`_castSequenceToken` (client-local wall-clock timers); `performance.now()` (the allowed shared client clock); `_attachedParentGuid` (read-only lookup). **Every input is static/derived or the client clock — all allowed.** It reads **no** server-replicated *mutable* field as a source of truth for any write.

**THE RULE — writes.** `getDrawCastState` writes **nothing** (it is a pure getter). The only write is the *consumer* setting its own **cloned** `uDrawAmount` uniform — a render-time material value the server neither stores nor replicates. No wire field, no physics/collision state, no replicated transform is touched.

**Desync is structurally impossible (in-tree proof).** Server-authoritative heading is applied by `EntityInstance.setPose` (`entities.js:2161`) and the manager position path (`entities.js:4196`) via `inst.root.quaternion.copy(acQuatToThree(...))` — a `copy()` that **stomps** the orientation every position update. The shipped `SetOmega` spin is re-applied *after* that copy (`entities.js:4206-4207 premultiply(_omegaAccumQ)`) precisely because the copy resets the base — proving any render-time transform/uniform layered on top sits **downstream** of the authoritative stomp and can never leak upstream to the wire. Our `uDrawAmount` is even further removed: it is a fragment/vertex uniform, not even a transform.

**Light count / shader-link:** unaffected. `uDrawAmount` is a uniform *value*; the bow-limb component's `customProgramCacheKey` is one stable key per component-set, never per-instance → no relink, no link explosion.

**Edge cases:**
- Entity despawns mid-draw → `entityMap.get` returns undefined → accessor returns `null` → consumer relaxes `uDrawAmount → 0`. Safe.
- Held bow whose wielder despawns → `_attachedParentGuid` resolves to no inst → falls through to `null`. Safe.
- `action.getClip()` null (action disposed) / `dur === 0` → guarded; returns binary-held or `null`, no divide-by-zero.
- Cast with no `_castStartedMs` (legacy path / pre-patch) → `end > start` guard fails → returns `null` (treated as no active cast) rather than a bogus ramp. Safe default.
- Rapid re-fire replaces `_swingHold` (`entities.js:6304-6308`) → accessor always reads the *current* hold; no stale read.
- Multiple components on one bow read the same getter → all reads, no shared mutation, no ordering hazard.
- `holdAtPeak` silently downgraded to a normal swing when `dur` invalid (`entities.js:6310 peakUsable=false`) → no `_swingHold` set → accessor returns `null`; the limb simply doesn't flex that shot (graceful, never wrong).

---

## GPU cost

This slice adds **no GPU work of its own** — it is a CPU read accessor. Per frame the cost is `O(visible bows/casters with the component)` getter calls (a handful: a player + nearby archers), each ~5 field reads + one `clamp` + one uniform assignment. Negligible (sub-microsecond, well inside the CPU-bound ~20 fps frame; classified **cheap** in §5.3). It introduces **no** draw calls, **no** texture fetches, **no** relink. The actual limb-bend ALU is the MECH-B `begin_vertex` displacement budgeted under slice 04/05, not here. Lazy evaluation means **zero** cost when no draw/cast component is attached (default state for all non-bow entities).

---

## Build checklist (ordered, each step a concrete code change)

1. **Add the cast start stamp.** In `playCastSequence`, at `entities.js:5795` (immediately after `inst._castBusyUntilMs = …`), add `inst._castStartedMs = nowMs;`. In `clearCastBusy` (`entities.js:5942`) and `cancelCastSequence` (`entities.js:5954`), also set `inst._castStartedMs = 0;`. Read-only thereafter. *(Pure addition; cast feel unchanged.)*

2. **Add the read-only accessor.** Insert `getDrawCastState(guid)` and `getDrawAmount(guid)` (code above) as `EntityManager` methods next to `clearCastBusy` (~`entities.js:5943`). No writes; mirror the guid-keyed public-method convention.

3. **(Optional, P2) Remote-archer fallback.** Add the `inst.currentActionKey?.startsWith("swing:")` + missile/aim-command branch to `getDrawCastState` so remote bows derive a windup phase from `currentAction.time / clip.duration`. Gate behind the component config so local-only ships first.

4. **Consumer binding (in the bow-limb component, slice 04/05).** In the component's per-frame uniform update, call `em.getDrawCastState(bowGuid)`; ease `mat.uniforms.uDrawAmount.value` toward `s?.mode==='draw' ? s.amount : 0` with `relaxK≈0.25`. Run it in the material/oscillator tick at the `loop.js:827-828` cadence (after `entityManager.tick(dt)` at `loop.js:1818`, so `action.time` is current for the frame). Never write back to any `inst._*` field.

5. **Wielder resolution check.** Confirm the component is attached to the *bow* entity and passes the bow guid; the accessor's `_attachedParentGuid` hop (`entities.js:2066`) handles the wielder lookup. No change to `attachChildToParent` needed.

6. **Legacy-safety assertion (feeds slice 13 lint).** Add a unit test: snapshot an entity inst (deep-freeze or before/after field diff), call `getDrawCastState`, assert **no** `inst._*`, `action.*`, or `root.quaternion` field changed; and assert the declared read-set ⊆ the allowed-reads list (`_swingHold`, `action.time/clip.duration/paused`, `_cast*`, `performance.now`, `_attachedParentGuid`). Register the accessor's read/write manifest as `{reads:[…], writes:[]}`.

7. **Diag hook (feeds slice 11 `vfx gauge`).** In `diag.js`, expose `window.__diag.drawCast = { localAmount: em.getDrawAmount(localGuid), activeCasts }` so the budget harness can confirm the path is read-only and count active consumers.

8. **Smoke test.** Local player draws a bow (charge-attack) → `getDrawAmount(localGuid)` ramps `0→1`, pins at `1` while held (`holding:true`), drains on release; cast a spell → `mode:'cast'` ramps `0→1` over the windup; verify **zero** new outbound wire packets (network panel) and that toggling the bow-limb component off is byte-identical to today.
