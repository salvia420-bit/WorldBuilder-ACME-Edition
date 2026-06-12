# SQ3 — A15-Q3: retire the dead 3D direct-drain arm (`scene3d/loop.js`)

Date: 2026-06-12 · Spec agent (laptop, read-only) · Item: A15 §4 Stage Q3 (agent report
`docs/2026-06-11-unification-survey/agents/A15-dual-renderer-seam.md:85-91`) · ROADMAP wave W3
(carried over — W3-RESULTS.md:50: "needs the A15-Q3 spec first").

**Why this spec exists:** A15-Q3 is the unspecced ROOT of the mandated `scene3d/loop.js`
serialization chain **A15-Q3 → A8-M3 (S4) → A15-Q4 (S3) → A1-O4 (S2) → A11-S3 (S12)**
(ROADMAP §3 loop.js row, ROADMAP.md:140; INDEX.md:39/49/67). Nothing in the W4+ JS-seam lane
can land until Q3 does.

**Retail-citation waiver (carried from the A15 agent report §1):** retail has ONE renderer;
this seam is holtburger-internal. Per the report, "dual-citation" for this item means citing
BOTH renderer paths (2D `index.html` arm / dead 3D arm / live 3D arm) — every behavioral
claim below is double-cited against those, not acclient.c.

---

## 0. Read-HEAD + landed state

- **Read-HEAD: `23a89569`** ("holtburger: W3 wave results + S15/S16 records + w3plus spec
  corpus"). All file:line cites in this spec were taken at this commit. Symbol names are
  given with every cite for re-anchoring.
- **Landed and relied on (verified at read-HEAD):**
  - A15-Q1 (`2f50b269`): `?spawnDefer2dOnly` + unconditional `ENTITY_BUFFER_CAP = 512`
    ring-caps on `deferredSpawns` / `__scene3dEntityBacklog` (url-flags.md:194;
    index.html:4465/4601).
  - A15-Q2 (`1396967c`): `?unifiedClone` + shared schema module
    `scene3d/entity_update_clone.js` (url-flags.md:195; imported at loop.js:59, wired into
    `toMeta` at loop.js:1705-1711). Headless test `test_a15_q2_entity_update_clone.mjs`.
  - All of W2 + W3/w3plus (W3-RESULTS.md, 9 commits `9568fc0a..08ad6563` + close-out):
    **manifest v4**; `?syncPhysicsTick` landed in `scene3d/index.js` + `index.html` (S1);
    `?remoteInterp` touched loop.js — `drainRemotePoses` call at loop.js:1633 inside the
    tickPerFrame entity block; `?hookDrain`/`?mtQueue` touched entities.js/index.html (S5).
    None of these touched the dispatch arms this spec rewrites.
- **NOT landed (verified by grep at read-HEAD, confirming S2 §1's same check):** zero hits in
  `apps/holtburger-web/` for `legacyDirectDrain`, `unifiedDispatch`, `unifiedEntityDispatch`,
  `dispatchParity`, `entity_dispatch.js`, `world_stream.js`. A15-Q3/Q4, A8-M3, A1-O4, A11-S3
  are all unstarted. This item is first in line.
- **Line-anchor drift notice:** S3/S4 were authored at an older HEAD and cite
  `drainEntityEvents3D` at loop.js:1729-2009 and `installSharedDrainHook` at :2011. At
  read-HEAD `23a89569` the true anchors are: `drainEntityEvents3D` **:1797-2062**
  (useSharedDrain early-return **:1810**), `installSharedDrainHook` **:2079**, `dispatchOne`
  **:2093-2302**, `_prewarmFromBatch` **:2313-2327**, `window.__scene3dEntityHook` assignment
  **:2330-2345**, backlog replay **:2377-2421**. loop.js is 2423 lines total.

---

## 1. Current-state map — the loop.js drain/dispatch seam

### 1.1 Three dispatch sites, one live

| site | where | live? |
|---|---|---|
| 2D arm (kinds 0-5) | index.html:10781-10726-area for-loop after `pollEntityUpdates()` (hook forward at :10780) | live in BOTH modes (owns `.free()`) |
| 3D dead direct arm | `drainEntityEvents3D` loop.js:1797-2062, called every tickPerFrame at loop.js:1624 | **dead in live mode** — `installSharedDrainHook` is called unconditionally from the 3D init path (`scene3d/index.js:3876`), which sets `scene3d.useSharedDrain = true` (loop.js:2081), so :1810 early-returns. Reachable only by a standalone host that builds a scene3d without `init3D`'s hook install (capture_phase7_4_entities.cjs merely *reports* `useSharedDrain`, :363). |
| 3D live arm | `dispatchOne` (closure inside `installSharedDrainHook`, loop.js:2093-2302), fed by `window.__scene3dEntityHook` (:2330) ← index.html:10780 passes the pre-`.free()` array | live whenever `?renderer=3d` |

### 1.2 Divergence inventory (the split-brain Q3 closes)

Features present ONLY in the **dead** arm — i.e. **dead code in every live 3D session**:

| # | feature | dead-arm cite | live-arm gap | consequence in live mode |
|---|---|---|---|---|
| D1 | `window.__diag?.wire?.onEntityUpdate?.(upd)` wire-diag tap | loop.js:1825 | absent from dispatchOne (no other call site exists — repo grep: only :1825) | `__diag.wire` entity-update counters never fire in live 3D sessions |
| D2 | FU-1 (`?wieldHandAttach=on`) login-wield nudge on KIND_SPAWN: `em._markWielderDirty?.(meta.guid)` under `em._wieldHandAttach` | loop.js:1834-1845 (method defined scene3d/index.js:2062, attached :2072) | dispatchOne SPAWN is bare `em.spawn(toMeta(upd))` (:2097-2098) | the FU-1 "login-time wielded items render dropped at feet" fix never runs for live spawns (only the other `markWielderDirty` call sites in index.js:2087/2095 fire) |
| D3 | F6-2 swing-echo dedup on KIND_MOTION_ACTION: `em.consumeLocalSwingEcho?.(actionGuid, actionCmd)` | loop.js:1991-1992 (consume side entities.js:5220-5226; note side `noteLocalSwingPrediction` is called on the DEFAULT live click path, picking.js:996) | dispatchOne MOTION_ACTION (:2241-2246) always `setMotion`s | the server's swing echo double-plays / restarts the optimistic local swing ~RTT later — **the F6-2 fix is currently inert in live mode** |
| D4 | FU-3 (`?serverSwing=on`) local shoulder pose for attack cmds `0x51..0x6E`: `em.setSwingPose?.()` | loop.js:1995-2006 (SERVER_SWING_ON const :223) | absent from dispatchOne | `?serverSwing=on` local visual never fires from the wire in live mode |
| D5 | explicit `KIND_META_REFRESH` (kind=3) no-op arm + comment | loop.js:2048-2051 | dispatchOne has no kind-3 arm (S3 §2.2 flags the same) | cosmetic; kind-3 silently falls through in both |
| D6 | owns the wasm-bindgen lifetime: `upd.free()` per iteration | loop.js:2056-2060 | by design — hook path observes, 2D loop frees (index.html:10770-10780 comment) | n/a (lifetime contract, preserved below) |

Features present ONLY in the **live** arm (the capture path silently lacks them today; Q3
gives them to it for free): `__lastEntityWorldPos` per-guid pos-slot + `ts` stash
(loop.js:2130-2139); F4-3 indoor-gated `getTerrainVisualZ` remote-Z reconcile (:2165-2168);
batch prewarm `_prewarmFromBatch` (:2313-2327, hook-level); backlog replay (:2377-2421,
hook-level). The dead arm's KIND_POSITION (:1854-1881) is a bare `setPose` with none of these.

This is exactly the A15 §3 row-1 SPLIT-BRAIN ("proven regression class": KIND_APPEARANCE
lived only in the dead arm until SG-D ported it, loop.js:2254-2281) — and rows D1-D4 show the
class has **already recurred four more times since SG-D**. Parity finding: kinds
APPEARANCE/ATTACH/TURN/MOTION (incl. SG-B `isAutonomous` + FORCE_MOTION_LOCAL gates, F3-4
sticky, F3-5 run-rate) are now field-equivalent between the two arms (dead :1891-2047 vs live
:2183-2297) — the remaining deltas are exactly D1-D5.

---

## 2. Staged implementation plan (all JS-live; no wasm rebuild; manifest stays v4)

One file rewritten: `apps/holtburger-web/scene3d/loop.js`. Plus `docs/url-flags.md` rows and
one new headless test. `index.html` is NOT touched (keeps Q3 textually disjoint from S4's
index.html edits and from the `index.html` conflict row, ROADMAP.md:143). Commit order
Q3.1 → Q3.2 → Q3.3, separately revertable.

### Q3.1 — hoist `dispatchOne` to module scope (pure refactor, no flag)

- New module-scope export in loop.js:
  `export function dispatchEntityUpdate(scene3d, em, upd)` — body = current dispatchOne
  (:2093-2302) verbatim. Every closure dependency is already module-scope
  (`_actionStamps` , `_velScratch`, `_sliceFromScratch`, `_getOrCreatePosSlot`, `_nowMs`,
  `isLocalPlayerGuid`, `FORCE_MOTION_LOCAL_ON`, `getTerrainVisualZ`, KIND_* consts
  loop.js:75-100) except `em`/`scene3d` — they become parameters.
- Inside `installSharedDrainHook`, replace the closure with
  `const dispatchOne = (upd) => dispatchEntityUpdate(scene3d, scene3d.entityManager, upd);`
  — **resolve `entityManager` at call time**, not capture-time (today's closure captures `em`
  once, :2090; late-binding is what S4's `getEntityManager: () => scene3d.entityManager`
  pattern already does for the same reason). The local name `dispatchOne` is kept so the
  `_prewarmFromBatch`/hook/backlog blocks (:2313-2421) and S4's textual anchor
  ("immediately after the `window.__scene3dEntityHook` assignment") are undisturbed.
- Contract (load-bearing for S3): `dispatchEntityUpdate` **never calls `upd.free()`**, never
  throws (internal try/catch retained), and accepts BOTH wasm-bindgen handles and plain-JS
  clones (the backlog-replay invariant documented at loop.js:2357-2362).
- Behavior: byte-identical. No flag.

### Q3.2 — parity-port the dead-arm-only features into the core (D1-D5)

Into `dispatchEntityUpdate`, in this order:

- **D1 `__diag` tap (unconditional):** first line of the function body:
  `try { window.__diag?.wire?.onEntityUpdate?.(upd); } catch (_) {}` (moved semantics: the
  tap now also counts backlog replays and capture-path updates — diag-only, accepted; note it
  in the code comment).
- **D2 FU-1 spawn nudge (rides existing `?wieldHandAttach`, default-off ⇒ inert):** port
  loop.js:1834-1845 verbatim into the KIND_SPAWN arm after `em.spawn(...)`. Requires the
  spawn arm to hold the meta: `const meta = toMeta(upd); em.spawn(meta);` (matches the dead
  arm's snapshot-before-async rationale, :1829-1832).
- **D4 FU-3 server-swing pose (rides existing `?serverSwing`, default-off ⇒ inert):** port
  loop.js:1995-2006 verbatim into the KIND_MOTION_ACTION arm.
- **D3 F6-2 echo dedup (NEW flag `?dispatchParity=on`, default-off):** in KIND_MOTION_ACTION,
  ```js
  if (DISPATCH_PARITY_ON && actionCmd !== 0 &&
      em.consumeLocalSwingEcho?.(actionGuid, actionCmd)) {
    // F6-2: optimistic local swing already played (picking.js noteLocalSwingPrediction);
    // swallow the server echo instead of double-playing it.
  } else if (actionCmd !== 0 && typeof em.setMotion === "function") { ...existing... }
  ```
  `DISPATCH_PARITY_ON` = one-shot URLSearchParams reader, exact `?unifiedClone` pattern
  (loop.js:206-214). D3 is the only port that changes DEFAULT-mode live behavior (the
  note side fires on the default click path, picking.js:996), hence the gate; on 1070
  eye-test PASS, integrate always-on and mark DONE in url-flags.md per the standing
  passed-flag workflow.
- **D5 kind-3 arm (unconditional no-op):** add the explicit `else if (kind ===
  KIND_META_REFRESH) { /* not yet consumed — see S3 OPEN QUESTIONS */ }` arm.
- `docs/url-flags.md`: add the `dispatchParity` row next to `unifiedClone` (:195 style).

### Q3.3 — retire the dead arm; `?legacyDirectDrain=on` escape hatch

Rewrite `drainEntityEvents3D(scene3d, sessionHandle)` (:1797-2062) as a thin wrapper:

```js
function drainEntityEvents3D(scene3d, sessionHandle) {
  if (!sessionHandle || typeof sessionHandle.pollEntityUpdates !== "function") return; // :1798 guard, verbatim
  if (scene3d.useSharedDrain) return;                                                  // :1810 guard, verbatim
  if (LEGACY_DIRECT_DRAIN_ON) return _legacyDirectDrainArm(scene3d, sessionHandle);    // rollback hatch
  let updates;
  try { updates = sessionHandle.pollEntityUpdates(); }
  catch (e) { /* :1814-1821 _drainWarned block, verbatim */ return; }
  if (!updates || updates.length === 0) return;
  const em = scene3d.entityManager;
  for (const upd of updates) {
    dispatchEntityUpdate(scene3d, em, upd);              // unified core (Q3.1+Q3.2)
    if (typeof upd.free === "function") { try { upd.free(); } catch (_) {} }  // :2056-2060 — wrapper OWNS the lifetime
  }
}
```

- `_legacyDirectDrainArm` = the current :1811-2061 body moved verbatim (private, not
  exported). `LEGACY_DIRECT_DRAIN_ON` = `?legacyDirectDrain=on` one-shot reader
  (default-off = unified). This matches the A15 §4 flag direction ("keeps the old arm
  reachable (default-off = unified)") — safe because **live 3D mode is unaffected in either
  state** (the :1810 early-return fires first; `installSharedDrainHook` is unconditional at
  scene3d/index.js:3876). The flag's blast radius is the standalone capture path only.
- Net capture-path behavior change (default): gains D-live features (pos-slot stash, F4-3
  Z-reconcile) and keeps D1-D5 via Q3.2 — i.e. capture now matches live exactly, the point
  of the item.
- `docs/url-flags.md`: add the `legacyDirectDrain` row.
- Net size: loop.js loses ~250 duplicated lines once the legacy arm is deleted at flag
  retirement (post-eye-test; NOT in this change).

---

## 3. RULING — flag-name assignment for Q3 / S4 / S3 (binding on implementers)

Verified collision (INDEX.md:72): **S3 (A15-Q4) prescribes `?unifiedDispatch`**
(S3:132, :295, :369) and **S4 (A8-M3) prescribes `?unifiedEntityDispatch`** (S4:125, :201-219).
Distinct flags by design (S4 Risk 6) but confusingly near-identical names, and S4's name is a
misnomer — kind-17 rides the **ClientEvent** stream (`poll_events`), not the EntityUpdate
stream. S3 OQ1's alternative (M3 rides `?unifiedDispatch`) is REJECTED: M3 lands BEFORE Q4 in
the mandated chain, so the flag would not exist yet, and it would couple kind-17 rollback to
the much larger Q4 extraction (violates independent revertability).

| item | final flag | change required |
|---|---|---|
| **Q3** (this spec) | `?legacyDirectDrain=on` (rollback hatch) + `?dispatchParity=on` (D3 port) | none — new names, zero repo/spec hits at read-HEAD |
| **S4 A8-M3** | **`?unifiedClientEvent=on`** (RENAMED from `?unifiedEntityDispatch`) | smallest-diff edits confined to S4: flag string, reader const `__unifiedEntityDispatchOn` → `__unifiedClientEventOn`, url-flags row text. S4:125's "name fixed by A8 §4 — do not rename" is overridden by this ruling. |
| **S3 A15-Q4** | `?unifiedDispatch=on` (UNCHANGED) | delete S3 OQ1; update S3:330's contingency sentence to the new S4 name |

Rationale: only one spec changes; the renamed flag says what it gates
(`client_event_dispatch.js` / `__scene3dClientEventHook`, S4 Step 1-2); `unifiedDispatch`
remains unambiguous for the entity-update + streaming extraction. INDEX.md:24 and the W4
dispatch prompt must use the new name.

---

## 4. Interface contract — what S4/S3/S2/S12 consume from Q3's landed shape

- **Exported, stable for S3:** `dispatchEntityUpdate(scene3d, em, upd) -> void` at loop.js
  module scope. Never frees `upd`; tolerant of plain-JS clones and wasm handles; internal
  try/catch (never throws). S3's Q4.2 lifts THIS function into `entity_dispatch.js` as the
  `dispatch3D` backend (S3 §2.2 item 3 "assumed reduced to a thin wrapper before Q4" — Q3.3
  delivers that wrapper; S3 should re-anchor its loop.js cites to post-Q3 lines).
- **Unchanged, relied on by S4:** `installSharedDrainHook(scene3d)` signature, its
  unconditional call site (scene3d/index.js:3876), the `window.__scene3dEntityHook`
  assignment block (S4 Step 2 inserts its one `window.__scene3dClientEventHook` install line
  immediately after it), and ALL of index.html (Q3 touches none of it). After Q3, loop.js
  churn in the 1797-2302 region is done — S4 can anchor safely.
- **Unchanged, relied on by S2:** the one-drainer-per-frame contract — `useSharedDrain=true`
  ⇒ `drainEntityEvents3D` no-ops and the hook (fed from the 2D drain, future `pumpNetFrame`)
  is the sole consumer; `.free()` stays with whoever polls (S2/S3 ".free() stays at the
  drain — dispatch NEVER frees", S3 §2.3 table).
- **For S12 (A11-S3):** loop.js textual stability only (last in the chain).
- **Flag namespace:** per §3; Q3 introduces `legacyDirectDrain` + `dispatchParity`, neither
  consumed downstream.

---

## 5. Test plan

Headless-now (laptop-safe, no builds beyond `node`):
- `node --check scene3d/loop.js` (syntax; loop.js is an ES module — use the repo's existing
  mjs-check pattern if `--check` balks at import syntax: `node -e "import('./scene3d/loop.js')"`
  is NOT safe (window refs); prefer the esbuild-less static check used by prior waves or
  simply run the suites below, which import loop.js).
- Existing suites must stay green: `test_phase7_4b_entity_pipeline.mjs`,
  `test_phase7_batch9_entity_lifecycle.mjs` (EntityManager pipeline; 4b references the direct
  arm only in comments — verified no source-regex assertion on `drainEntityEvents3D` exists
  in-repo), `test_a15_q2_entity_update_clone.mjs` (Q2 schema untouched).
- **New** `test_a15_q3_dispatch_parity.mjs` (the Q3 acceptance gate): mock `em` recording
  method calls; synthetic plain-JS updates for kinds 0,1,2,4,5,6,7,8,9 (+3) with every field
  set; assert (a) `dispatchEntityUpdate` produces the same call sequence as the legacy arm's
  expectations for the shared kinds, (b) D2/D4 fire only with their flags forced on
  (constructor-injectable or URL-stubbed, follow the `test_a15_q2` pattern), (c) D3 swallows
  the echo only when `consumeLocalSwingEcho` returns true AND `dispatchParity` is on,
  (d) the wrapper frees handles exactly once (mock `free()` counter) and the hook path never
  does.

Eye-tests — **BATCHED Lane-B, never a step** (1070 is OFF; ROADMAP §4 Lane B already lists
"A15-Q3/Q4 spot-checks"): (1) re-skin/attach spot-check (the SG-D regression class, A15 §4
Q3's own gate); (2) spam-click swing A/B `?dispatchParity` on/off — echo no longer
double-plays; (3) `?wieldHandAttach=on` login with wielded weapon — in-hand at spawn (D2);
(4) brief default-URL 3D smoke (flag-off = byte-identical claim).

## 6. Risks + rollback

| risk | sev | mitigation |
|---|---|---|
| Hoist captures stale `entityManager` across a re-init | LOW | call-time resolution in the hook lambda (Q3.1); wrapper reads `scene3d.entityManager` per call |
| D3 alters default live combat visuals | LOW-MED | gated `?dispatchParity` (default-off); A/B in the batched eye-test before any flip |
| Capture path silently depends on a dead-arm quirk (bare setPose without F4-3 raycast) | LOW | `?legacyDirectDrain=on` restores the verbatim old arm; capture scripts are in-repo and re-runnable headless |
| Same-file collision with in-flight S4/S3/S2/S12 | process | Q3 is FIRST in the ROADMAP §3 chain; nothing else may touch loop.js until it lands; commits hunk-selective per standing rule |
| `__diag` counts shift (backlog replays now tapped) | nil | diag-only; comment documents it |

Rollback: per-stage revert (three commits), or runtime: `?legacyDirectDrain=on` (capture
path) / `?dispatchParity` off (the only default-mode behavioral port). Q3.1 is a pure
refactor — revert-only.

## 7. OPEN QUESTIONS

1. **4b "smoke check asserts the regex"** (test_phase7_4b_entity_pipeline.mjs:35-36 comment):
   the asserting script was not found in-repo (grep over *.mjs/*.cjs/*.sh: only the comment).
   Implementer should confirm no out-of-repo capture harness greps `drainEntityEvents3D`'s
   body shape before relying on the wrapper rewrite (the symbol NAME is preserved either way).
2. **`?dispatchParity` flip timing:** F6-2's dedup was shipped (dead arm) without a flag —
   is the intended end-state unconditional? Recommend YES at eye-test PASS (it only fires
   within the 500 ms `noteLocalSwingPrediction` window, entities.js:5213-5226), but the flip
   is a 1070-gated decision, not the implementer's.
3. **kind-3 META_REFRESH consumer** stays unowned (dead arm says "Phase 7.5 will wire
   portal-destination updates", loop.js:2049-2050) — deliberately deferred to S3's OPEN
   QUESTIONS (S3 §2.2 flags the same gap); Q3 only adds the explicit no-op arm.
