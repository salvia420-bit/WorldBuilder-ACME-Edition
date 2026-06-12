# S4 / A8-M3 — kind-17 visibility re-home out of the 2D drain

Execution-grade spec. Sources: ROADMAP.md + RULINGS.md + agents/A8-cell-visibility-maint.md
(§3 row 6, §4 Stage M3) + agents/A15-dual-renderer-seam.md (rows 1/7/8) in
`apps/holtburger-web/docs/2026-06-11-unification-survey/`; retail truth
`/home/wbterminal/ac-headers/acclient.c` / `acclient.h`. All repo paths below are relative to
`external/holtburger/` unless absolute; `index.html`, `scene3d/*`, `src/lib.rs` live under
`apps/holtburger-web/`.

---

## 1. read-HEAD + W2 assumptions

- **read-HEAD:** `61bea82f` ("holtburger: W2/Batch-R2 buildbox dispatch manifest"),
  read 2026-06-11. All file:line cites in this spec were taken at this HEAD; a W2 commit may
  shift `src/lib.rs` line numbers (it is the hottest W2 file) — symbol names are given
  alongside every lib.rs cite for re-anchoring.
- **Landed and relied on (verified in `git log` at read time):**
  - A8-M1 `?worldLifecycle=on` (174fa1b4) and A8-M2 `?maintPrune=on` (b4e87213) — M3 is
    invariant to both (see §2, "emit sides converge").
  - A15-Q1 (2f50b269) and A15-Q2 (1396967c) — the only A15 stages landed. **A15-Q3 has NOT
    landed** at read-HEAD.
- **In-flight W2 items (A4-Q1, A3-D2, A2-P1, A7-R1/R2/R3/R6, A9-Stage1):** NONE touch the
  kind-17 path, `scene3d/loop.js` dispatch, the `index.html` game-event drain, or
  `entities.js` visibility. This spec assumes nothing from W2; it is safe whether or not any
  of them land first.
- **Hard ordering constraint (ROADMAP §3, not a functional dependency):** the `scene3d/loop.js`
  conflict-matrix row orders `A15-Q3 → A8-M3 → A15-Q4 → A1-O4 → A11-S3` ("each restructures
  dispatch the next depends on"), and the `index.html` row serializes `Q4/M3/O4`. M3 as specced
  here touches loop.js only additively (one install line inside `installSharedDrainHook`) and
  index.html only inside the `evt.kind === 17` arm, so it does not textually collide with Q3's
  dead-arm rewrite (loop.js:1729–2009) — but the ROADMAP serialization stands: **land after
  A15-Q3**. Verdict: READY-AFTER-A15-Q3.
- ROADMAP wave: W5, jointly with A15-Q4; M3 + Q4 are the two declared blockers of A1-O4
  (ROADMAP §2 "2D-path seam", §7.4).
- The A3-D1-amended `docs/2026-06-11-unified-movement-pipeline/DESIGN.md` contains no
  kind-17 / visibility / A8 content (grep at read-HEAD: 0 hits) — no interaction with the
  movement pipeline.

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail truth: one owner, no dispatch hop

- Wire SetState lands at `SmartBox::HandleSetState` (acclient.c:144395), which calls
  `SmartBox::DoSetState` (call at acclient.c:144423; body acclient.c:143396). The
  ObjectCreate/visual-desc path calls the same `DoSetState` at acclient.c:146067.
- `DoSetState` timestamp-gates and applies the state DIRECTLY to the physics object:
  `CPhysicsObj::set_state(object, state, 1)` (acclient.c:143414).
- `CPhysicsObj::set_state` (acclient.c:322172) XOR-diffs old vs new state and flips the two
  draw gates on the object itself: `NODRAW_PS` 0x20 → `CPhysicsObj::set_nodraw`
  (acclient.c:322197–322198), `HIDDEN_PS` 0x4000 → `CPhysicsObj::set_hidden`
  (acclient.c:322199–322200). Bit values from `enum PhysicsState`: `NODRAW_PS = 0x20`
  (acclient.h:2822), `HIDDEN_PS = 0x4000` (acclient.h:2831), `CLOAKED_PS = 0x100000`
  (acclient.h:2837).
- There is no renderer-dispatch layer in this chain: state bits live on the object and the
  render pipeline reads them (`set_hidden` mutates `this->state` and walks children/cell,
  acclient.c:322078+). **Retail parity target = visibility handling owned by the entity
  layer, zero cross-renderer hops.**

### 2.2 Ours: the emit side (Rust — already unified, NOT touched by M3)

- World crate emits `WorldEvent::EntityVisibilityChanged` from exactly three sites:
  - SetState draw-gate flip: `crates/holtburger-world/src/state/mutations.rs:1234-1247`
    (captures `was_drawable = entity.should_draw()`, applies `physics_state`, emits on
    `was_drawable != is_drawable`) — mirrors acclient.c:322172's XOR-diff semantics.
  - Spawn-hidden upsert (both Replaced and Inserted arms):
    `crates/holtburger-world/src/state/liveness.rs:412-419` (comment+gate),
    emits at `:437-440` and `:447-450`.
  - Gate predicate: `Entity::should_draw()` = HIDDEN|NO_DRAW|CLOAKED clear,
    `crates/holtburger-world/src/entity.rs:959-963` — same three bits as
    acclient.h:2822/2831/2837.
- `SetState` is routed to the world crate ALWAYS (un-gated arm of
  `should_route_message_to_world`, `src/lib.rs:22053` fn, `GameMessage::SetState` in the
  always-on matches block ~`:22169`).
- wasm bridge translates `WorldEvent::EntityVisibilityChanged` → `ClientEvent { kind: 17 }`
  at `src/lib.rs:31403-31412` (constant `CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED: u32 = 17`
  at `src/lib.rs:16463`); payload: `u32_payload` = guid, `u32_payload_2` = 1/0.
- Second (bespoke, legacy-ObjectCreate-arm) emit: spawn-hidden mirror at
  `src/lib.rs:33210-33225`, gated `spawn_hidden_state_on` which is hard-coded `true`
  (`src/lib.rs:30490`; url-flags.md:170 records it INTEGRATED always-on).
- **Emit sides converge:** with `?worldLifecycle=off` (default) the spawn-hidden kind-17 comes
  from lib.rs:33218; with `=on` it comes from the routed path
  (liveness.rs:437/447 → lib.rs:31405). Identical ClientEvent shape either way, so M3 (a pure
  consumer-side move) is invariant to A8-M1/M2 flag state.

### 2.3 Ours: the consume side (JS — the split-brain M3 fixes)

- The ONLY consumer of ClientEvent kind=17 is the 2D drain: `drainEvents()`
  (`index.html:9074`), `handle.poll_events()` at `:9090`, per-event loop at `:9091` (diag tap
  `:9092`), and the `evt.kind === 17` arm at **`index.html:10090-10115`**:
  decodes `visGuid = evt.u32Payload >>> 0`, `visible = (evt.u32Payload2 >>> 0) === 1`
  (`:10106-10107`), guards on `window.liveScene3d && .entityManager &&
  typeof .setVisibility === "function"` (`:10108-10112`), calls
  `entityManager.setVisibility(visGuid, visible)` (`:10113`).
- Target: `EntityManager.setVisibility` `scene3d/entities.js:3753-3778` → race-queue
  `_pendingVisibility` (`:3762`, init `:2268`, drained on spawn-commit `:3123-3127`, purged on
  remove `:7005`) → attached-child skip (`:3772`) → `_setEntityStateVisible`
  (`entities.js:1202-1206`) → composite single-writer `_applyEntityVisible`
  (`entities.js:1193`, `stateVisible && !renderCullHidden`).
- The 3D dispatch layer (`installSharedDrainHook`, `scene3d/loop.js:2011`; `dispatchOne`
  `:2025`; hook install `window.__scene3dEntityHook = …` `:2262`) handles ONLY EntityUpdate
  kinds 0–9 (`KIND_POSITION..KIND_TURN`, loop.js:76-100). It has **no kind-17 arm** — kind-17
  is a ClientEvent (poll_events stream), not an EntityUpdate (pollEntityUpdates stream,
  forwarded at `index.html:10641`, freed at `:10725`).
- Divergence class (A8 §3 row 6): SPLIT-BRAIN, 2 dispatch layers — a 3D-session correctness
  feature (hide/show: login bubble, @hide, NoDraw props, cloak) lives in the 2D page's drain
  arm. Retail has one owner (acclient.c:143414 → 322197-322200). This is one of the two
  declared blockers of A1-O4 (ROADMAP §7.4): the 2D rAF loop cannot be retired while kind-17
  correctness lives inside it.
- Game-event drain ownership note (A15 §3 row 8): evt.kind 0–55 has a SINGLE owner
  (index.html:8990+) and A15 rules "keep it that way". M3 therefore moves the HANDLER BODY to
  scene3d behind a consumed-hook, leaving the drain loop itself in index.html (a one-line
  forward) until A15-Q4 extracts the renderer-neutral drain wholesale. No second poller is
  created.

---

## 3. Staged implementation plan

**Classification: JS-live.** No Rust/wasm change, no `cargo`/`wasm-pack` rebuild, no
wasm-bridge getter additions ⇒ **no manifest bump** (the "manifest v2" convention,
url-flags.md:364/376, applies only to new SessionHandle getters; none added here).
Flag: **`?unifiedEntityDispatch=on`** (default-off; name fixed by A8 §4 Stage M3 — do not
rename). Off = byte-identical current behavior.

### Step 1 — new module `scene3d/client_event_dispatch.js` (new file)

Pure, dependency-free (no THREE, no DOM, no wasm imports — node-importable like
`scene3d/entity_update_clone.js`, the A15-Q2 precedent). Shape:

```js
// A8-M3 (2026-06-11 unification survey) — scene3d-owned dispatcher for
// rig-affecting ClientEvents (poll_events stream). Retail parity: visibility
// state bits are applied by the entity owner with no renderer dispatch hop
// (SmartBox::DoSetState acclient.c:143396 → CPhysicsObj::set_state
// :322172 → set_nodraw/set_hidden :322197-322200). Mirror of the wasm
// constant CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED (src/lib.rs:16463).
export const CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED = 17;

// Returns a hook fn(evt) -> boolean (true = consumed by scene3d; caller
// must then skip its legacy arm). `getEntityManager` is injected so this
// module stays pure and the manager can be late-bound.
export function createClientEventDispatcher({ getEntityManager }) {
  return function scene3dClientEventHook(evt) {
    if (!evt) return false;
    const kind = evt.kind | 0;
    if (kind !== CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED) return false;
    const em = getEntityManager?.();
    // Consumed even when the manager isn't ready: the legacy index.html
    // body would no-op behind the same guard (index.html:10108-10112), so
    // "consumed + no-op" is behavior-identical and keeps exactly one
    // handler authoritative per kind.
    if (em && typeof em.setVisibility === "function") {
      em.setVisibility(evt.u32Payload >>> 0, (evt.u32Payload2 >>> 0) === 1);
    }
    return true;
  };
}
```

Semantics copied EXACTLY from index.html:10106-10113: `>>> 0` coercions, `=== 1` test for
visible, silent no-op when no manager. Scope is kind-17 ONLY (see §6 Q2 for why kinds
15/30/55 stay put for now); the kind→consumed shape makes later migrations one-arm additions.

### Step 2 — install the hook in `scene3d/loop.js`

In `installSharedDrainHook(scene3d)` (loop.js:2011), immediately after the
`window.__scene3dEntityHook = …` assignment (loop.js:2262 block), add:

```js
// A8-M3: scene3d-owned ClientEvent dispatcher (kind=17 visibility). The
// 2D drainEvents forwards rig-affecting ClientEvents here under
// ?unifiedEntityDispatch=on; flag-off keeps the legacy index.html arm.
window.__scene3dClientEventHook = createClientEventDispatcher({
  getEntityManager: () => scene3d.entityManager,
});
```

plus the import at the top-of-file import block (loop.js:38-71 area):
`import { createClientEventDispatcher } from "./client_event_dispatch.js";`

Install is UNCONDITIONAL (like `__scene3dEntityHook`); the flag is read at the call site in
index.html so flag-off never invokes it. `installSharedDrainHook` early-returns when
`!scene3d?.entityManager` (loop.js:2012), and it only runs on the 3D init path — so in pure-2D
sessions `window.__scene3dClientEventHook` stays `undefined` and the legacy arm runs, exactly
as today (2D sessions: liveScene3d is null → guard no-op, index.html:10108).

Do NOT touch `drainEntityEvents3D` (loop.js:1729-2009): the dead-arm retirement is A15-Q3's
scope (A15 §4 Stage Q3) and lands BEFORE this item per the ROADMAP §3 ordering. M3 carries no
residual dead-arm work; the A8 §4 sentence "delete/quarantine the dead direct-drain KIND
arms" is satisfied by Q3 (its arms are EntityUpdate kinds; none is kind-17).

### Step 3 — delegate inside the `index.html` kind-17 arm

Add a flag reader next to the existing one-shot readers (pattern: `spawnDefer2dOnly`,
index.html:4476):

```js
const __unifiedEntityDispatchOn = (() => {
  try {
    return new URLSearchParams(window.location.search)
      .get("unifiedEntityDispatch")?.toLowerCase() === "on";
  } catch (_) { return false; }
})();
```

Rewrite ONLY the interior of the `evt.kind === 17` arm (index.html:10090-10115), keeping the
arm itself (the drain stays the single game-event owner per A15 row 8, and the event-object
lifetime/free semantics of the loop are untouched — no `continue`):

```js
} else if (evt.kind === 17) {
  // EntityVisibilityChanged — … (keep existing comment block :10091-10105)
  // A8-M3: under ?unifiedEntityDispatch=on the handler body lives in
  // scene3d/client_event_dispatch.js (one rig-affecting dispatcher);
  // flag-off runs the legacy inline body below, byte-identical.
  if (!(__unifiedEntityDispatchOn && window.__scene3dClientEventHook?.(evt))) {
    const visGuid = evt.u32Payload >>> 0;
    const visible = (evt.u32Payload2 >>> 0) === 1;
    if (
      window.liveScene3d
      && window.liveScene3d.entityManager
      && typeof window.liveScene3d.entityManager.setVisibility === "function"
    ) {
      window.liveScene3d.entityManager.setVisibility(visGuid, visible);
    }
  }
}
```

The legacy body is RETAINED until the flag graduates (A8 §4 M3 rollback clause: "index.html
handler retained until flag graduates"). "index.html (removal only)" is the graduation
end-state: at flip-to-default the inline body collapses to the hook call, and A15-Q4 then
moves the surrounding drain wholesale into its extracted renderer-neutral module.

### Step 4 — docs

- `docs/url-flags.md`: add a `unifiedEntityDispatch` row (style: the `unifiedClone` row,
  url-flags.md:194): A8-M3, default-off, JS-live, off = legacy inline kind-17 arm, headless
  test name, files touched.
- No other doc changes. No wasm rebuild ⇒ no rebuild-batch entry.

### Files touched (complete list)

| file | change |
|---|---|
| `apps/holtburger-web/scene3d/client_event_dispatch.js` | NEW — pure dispatcher module |
| `apps/holtburger-web/scene3d/loop.js` | +1 import; +hook install in `installSharedDrainHook` (after :2262 block) |
| `apps/holtburger-web/index.html` | flag reader; kind-17 arm interior delegation (:10090-10115) |
| `apps/holtburger-web/docs/url-flags.md` | flag row |
| `apps/holtburger-web/test_a8_m3_kind17_dispatch.mjs` | NEW — headless test (§4) |

Symbols added: `CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED` (JS mirror),
`createClientEventDispatcher`, `window.__scene3dClientEventHook`,
`__unifiedEntityDispatchOn`. No symbols removed or renamed; no Rust symbols touched.

---

## 4. Test plan

### Headless-now (buildbox, node, no browser, no build)

New `apps/holtburger-web/test_a8_m3_kind17_dispatch.mjs`, exact harness shape of
`test_a15_q1_entity_buffer_caps.mjs` (PART 1 behavioral / PART 2 static-text; plain node ESM,
`check()` pass/fail counter, exit code):

- PART 1 — behavioral (imports `scene3d/client_event_dispatch.js` directly; module is
  dependency-free by construction):
  1. kind-17 with `u32Payload2 = 1` → stub `em.setVisibility` called once with
     `(guid >>> 0, true)`; returns `true`.
  2. `u32Payload2 = 0` → `(guid, false)`; `u32Payload2 = 2` → `false` visible (the `=== 1`
     contract, mirroring lib.rs:31410's 1/0 emit); returns `true`.
  3. Guid coercion: payload `0xDEADBEEF` as signed-negative JS number → `>>> 0` round-trip.
  4. Non-17 kinds (0, 15, 30, 55) → returns `false`, stub never called (legacy arm keeps
     ownership).
  5. `getEntityManager()` returns null → returns `true` (consumed), no throw — matches the
     legacy guard no-op (index.html:10108-10112).
  6. Hook NOT installed in 2D sessions: assert `createClientEventDispatcher` has no
     module-scope side effects (importing it does not define `window.*`).
- PART 2 — static (read `index.html` + `scene3d/loop.js` as text):
  1. The kind-17 arm contains the `__scene3dClientEventHook` delegation gated on
     `unifiedEntityDispatch` AND still contains the legacy `setVisibility(visGuid, visible)`
     body (rollback path present).
  2. `loop.js` `installSharedDrainHook` assigns `window.__scene3dClientEventHook` via
     `createClientEventDispatcher`.
  3. `docs/url-flags.md` documents the flag.
- Regression suite (must stay green, unchanged): `test_a15_q1_entity_buffer_caps.mjs`,
  `test_a15_q2_entity_update_clone.mjs`, `test_phase7_4b_entity_pipeline.mjs`,
  `test_phase7_batch9_entity_lifecycle.mjs` (EntityUpdate stream untouched).
- NOTE for the implementing agent: running `node test_*.mjs` is permitted for the IMPLEMENTING
  wave, not this read-only spec wave; no test was executed while writing this spec.

### 1070-gated (parked; tags from A8 §4 M3)

With `?renderer=3d&unifiedEntityDispatch=on` vs `off` (A/B):
1. Login bubble: another character logs in nearby → rig hidden during bubble, revealed on
   SetState bubble-pop (exercises mutations.rs:1234-1247 → lib.rs:31405 → hook →
   entities.js:3753).
2. Admin `@hide` / cloak toggle on a visible creature → hide/show parity both flag states
   (retail gate acclient.c:322197-322200).
3. Spawn-hidden race (`?spawnHiddenState=on` appended, see §6 Q1): hidden spawn never renders
   a frame; `_pendingVisibility` drain on spawn-commit (entities.js:3123-3127) still fires.
4. 2D smoke (default URL, no `renderer=3d`): unchanged behavior — hook undefined, legacy arm
   no-ops exactly as today.
5. Doors / speech bubbles / play-effects unaffected (kinds 15/55/30 untouched).

---

## 5. Risks + rollback

- **Rollback:** flag off (default) = legacy inline arm, byte-identical; or revert the commit —
  no other item depends on M3's symbols until A15-Q4/A1-O4 (W5), both of which list M3 as a
  prerequisite, not a consumer of its internals.
- **Risk 1 — ordering vs A15-Q3/Q4 (process, not code):** ROADMAP §3 serializes Q3 → M3 → Q4
  in loop.js and Q4/M3/O4 in index.html. Mitigation: land after Q3 merges; the loop.js edit is
  a 5-line additive block inside `installSharedDrainHook`, trivially rebasable.
- **Risk 2 — double-handling:** if both the hook and the legacy body ran, a visibility toggle
  would be applied twice (idempotent for same value, but a wasted `_setEntityStateVisible`).
  Prevented structurally: the legacy body is the `else` of the consumed-hook test (§3 Step 3).
  The PART 2 static test pins this shape.
- **Risk 3 — hook installed but scene3d torn down:** `getEntityManager` late-binds through
  `scene3d.entityManager`; a null manager is a consumed no-op identical to the legacy guard.
  No stale-capture hazard.
- **Risk 4 — 2D sessions:** hook never installed (3D-only init path, loop.js:2011/2012);
  legacy arm already no-ops there (liveScene3d null). Zero 2D delta. Consistent with the
  RULINGS.md item 2 "2D stays supported" constraint.
- **Risk 5 — event-object lifetime:** poll_events ClientEvents are not `.free()`d in the
  events loop (only EntityUpdates are, index.html:10725); the hook reads `evt` synchronously
  inside the existing arm and stores nothing — no lifetime change. The dispatcher MUST NOT
  retain `evt` (pinned by review; payload fields are copied into primitives immediately).
- **Risk 6 — flag-name collision:** `unifiedEntityDispatch` vs A15-Q4's planned
  `unifiedDispatch` (A15 §4) are distinct flags by design (M3 = kind-17 handler home; Q4 =
  drain extraction). Graduation of M3 should precede Q4 so Q4 moves a one-line forward, not a
  handler body.
- **Blast radius:** kind-17 only; spawn/remove/position/motion streams untouched; Rust
  untouched; no rebuild.

---

## 6. OPEN QUESTIONS

1. **`spawnHiddenState` half-integration drift (found while speccing, single-owner claim —
   cannot dual-cite an intended state).** The wasm emit side is hard-coded ON
   (`spawn_hidden_state_on: bool = true`, src/lib.rs:30490; url-flags.md:170 says "INTEGRATED
   always-on") but the JS race-queue half still reads the URL flag with default OFF
   (`readSpawnHiddenStateFlag`, entities.js:49-57, gate at :3762). In a default 3D session
   today a spawn-hidden kind-17 that races the async rig build is silently dropped (the F16-5
   fix is OFF where it matters). M3 preserves this behavior bit-for-bit (it moves the caller,
   not `setVisibility`); but the implementing agent should ask whether to fold a one-line
   default-flip of the JS reader into M3 (it is the same eye-test surface) or file it
   separately. Recommendation: separate item — M3 stays a pure re-home so its A/B is clean.
2. **Which other ClientEvents count as "rig-affecting" for the A8 §4 phrase "(and any other
   rig-affecting ClientEvent)"?** Audited at read-HEAD: kind=15 DoorStateChanged rotates
   `inst.root` for 3D doors (index.html:10078-10084) but is half-2D (PIXI building-part
   rotation in the same arm) and is A6/door domain; kind=55 speech bubble already calls a
   clean manager API (`showSpeechBubble`, entities.js:3801+); kind=30 PlayEffect already
   bridges via the plugin bus (A15 row 8 pattern). Only kind-17 is a 3D-session CORRECTNESS
   dependency on the 2D drain (A8 §3 row 6 symptom column). This spec scopes M3 to kind-17
   and leaves 15/55/30 to A15-Q4's wholesale drain extraction. Confirm or extend at
   implementation review.
3. **Graduation criterion:** A8 §4 M3 lists the 1070 eye-test (login-bubble hide, door/cloak
   toggles) — 1070 is currently down (ROADMAP global gate). Land flag-off now (explicitly
   exempted from the Stage-1 gate, ROADMAP §2 exemption list includes A8-M3 via "A8-M1/M3");
   default-flip waits for W6 (1070 return). Who flips — this item or a W6 batch flip — is an
   orchestrator call.
4. **Retail single-cite caveat inherited from A8 §6:** the claim that retail's visible-list
   gate (acclient.c:309880-309883) is "cell-pointer + state-bit" is A8's struct-offset
   reading, not confirmed in acclient.h. Not load-bearing for M3 (M3 is about the DRAWN axis,
   fully dual-cited via set_state/set_hidden above); noted only so the citation chain is
   honest.
