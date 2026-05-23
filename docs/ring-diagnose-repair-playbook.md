# Ring Diagnose + Repair Playbook

Operational playbook for diagnosing drift in the 169-LB Holtburg ring and repairing it through to a green CI gate. Pairs with [`world-completeness-method.md`](world-completeness-method.md), [`entity-completeness-method.md`](entity-completeness-method.md), [`event-completeness-method.md`](event-completeness-method.md), and [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md), which define the contracts this doc operates against.

Status: live 2026-05-23. Covers Waves 1–6 of the completeness toolset (10 build-side validators + 1 aggregator + the client-side `window.__diag` observation layer).

---

## 1. When to reach for this doc

Three triggers:

1. **`diag-run-all` reports `summary.requiredFailures > 0`** in CI. One or more build-side validators detected drift. The aggregate JSON tells you WHICH surface; this doc tells you what to do next.
2. **A live-play bug report**: "NPC X isn't visible in Holtburg", "this Door doesn't open", "drudge took damage but didn't play hurt animation". The `__diag` client-side layer is the first stop — it classifies the failure mode without re-baking anything.
3. **Pre-deploy sanity check**: before shipping a renderer or bake change, run `diag-run-all` + `__diag.runAll(lbId)` on a representative LB and confirm no drift.

---

## 2. The diagnostic decision tree

```
Symptom
  │
  ├─ "I get a vague 'something looks wrong' bug report"
  │     → Boot wire-agent, query __diag.runAll(0xA9B40000)
  │     → If any surface returns DRIFT, jump to §4
  │     → If all PASS but the bug persists, jump to §5 (build-side drill-down)
  │
  ├─ "Validator output says X surface FAIL"
  │     → §3 (build-side validator diagnostic by surface)
  │
  ├─ "Renderer renders a placement at the wrong position / not at all"
  │     → §4.1 (placements diff)
  │
  ├─ "Entity is classified Unknown / wrong class"
  │     → §4.2 (entityTypes coverage gaps)
  │
  ├─ "Audio doesn't play / wrong ambient sound"
  │     → §4.3 (events probe)
  │
  ├─ "Player rubberbands on movement"
  │     → §4.4 (physics drift)
  │
  ├─ "NPC stuck in idle when it should be attacking"
  │     → §4.5 (motion + wire correlation)
  │
  └─ "I think a bake artifact is corrupted / stale"
        → §4.6 (integrity verify)
```

---

## 3. Build-side validator diagnostic (by surface)

Each validator's report lands at `/mnt/wbterminal1/holtburger-validator-reports/<surface>/<timestamp>/report.json`.

### 3.1 Placements (`validate_landblock_completeness.cjs`)

**Contract**: `rendered_placements(lb) ≡ {LandblockInfo.objects[lb] ∪ scenery_bake[lb] ∪ landblock_instance[lb]}`. See [`world-completeness-method.md`](world-completeness-method.md).

**Invocation**:

```bash
cd external/holtburger/apps/holtburger-web
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node validate_landblock_completeness.cjs --ring 0xA3AE..0xAFBA --strict
```

Wall-clock: ~5–6 minutes for the 169-LB ring (boot + 240 s init + 20 s settle + 300 s spawn drain).

**Common failures + remediations**:

- **`missing-render` count > 0**: oracle has a placement, renderer didn't produce one. Causes: scenery-bake produced empty JSONL for the LB; renderer's `bakeStaticsForLandblock` errored on that LB; per-LB fetch ring missed it. **Repair**:
  1. Check the bake artifact exists: `ls /mnt/wbterminal1/holtburger-dist-v2/scenery/0xLLLL.scenery.jsonl`. Empty? Re-run scenery-bake for that LB.
  2. Check renderer console: `[step 3.7]` errors on `loadStaticsForLandblock`? Renderer bug — fix the loader.
  3. If neither: the renderer's fetch radius is too small. Bump `bakeStaticsRing(lbX, lbY, RADIUS, ...)`.

- **`invented-placement` count > 0**: renderer produced a placement the oracle doesn't have. Causes: stale `dist/` tree with old bake; renderer has a hardcoded placement somewhere; modder content snuck through. **Repair**:
  1. Verify `bake-source.sha256` matches expected DAT sha256s — if not, re-run scenery-bake on the canonical base DATs.
  2. If the rogue placement's `obj_id` is in the `0x__FFxxxx` modder range, the preflight failed silently — investigate.

- **Position drift > 0.05 m (XY) or 0.10 m (Z)**: renderer applied a wrong transform. Causes: `worldRoot.rotation.x = -π/2` got flipped; InstancedMesh `getMatrixAt` decompose has lossy precision. **Repair**: bisect via `__diag.placements.walk(lbId)` to find which mesh has the drift; fix in `scene3d/{statics,buildings,entities}.js`.

### 3.2 Events (`validate_event_completeness.cjs`)

**Contract**: per [`event-completeness-method.md`](event-completeness-method.md). Sound + particle events match the per-LB JSONL manifest within tolerance.

**Invocation**: `node validate_event_completeness.cjs --probe-s 60 --strict`

**Common failures**:

- **`OneOff matched=0` despite `expected≥1`**: `__playWave` synthetic injection failed. Check `liveScene3d._pushEventRecord` exists (requires `?eventLog=on` or `?diag=1`).
- **`GameMessageSound mismatch`**: `__synthGameMessageSound` resolution chain broke. Check `entityManager.entityMap.get(guid)` returns the test entity; check `soundTableCache.resolveSound(stbDid, soundEnum)` returns a valid entry.
- **`AmbientRuntime probabilistic obs=0` in 60s**: ambient timer not advancing. Check `ambientRuntime` is constructed (it isn't in `?wireframe=1` without `?diag=1`); check `AmbientRuntime.setClockForTest()` isn't pinning to a mocked clock.
- **`PhysicsScriptHook matched < dispatched`**: emitter chain stalled mid-walk. Check `entities.js` H2 chain logs `[entities/H2] chain walker entered`; if not, the `awaitParticleChainResolution` Promise never resolved.

### 3.3 Entity classification (`validate_entity_classification.cjs`)

**Contract**: per [`entity-completeness-method.md`](entity-completeness-method.md). 130 synthetic cases through `canonicalClassify`.

**Invocation**: `node validate_entity_classification.cjs` (no args, ~200 ms).

**Failure mode**: a case returns the wrong `ObjectClass`. Almost always means our JS port at `plugins/world-objects/canonical_classify.js` drifted from `ACPlugin/API/WorldObject.cs:344-411`. **Repair**: bisect via `scripts/cross_port_parity.cjs` (Phase E.E) to find the input tuple where JS ≠ C#; port the missing branch.

### 3.4 Wire conformance, DAT parity, enum parity, motion, physics, etc.

Each surface has its own method doc (`<surface>-parity-method.md`). The repair pattern is the same:

1. Validator's report identifies the failing case.
2. Compare runtime behavior against the surface's canonical oracle (acclient.c retail decomp, ACE source, or DRW schema as a last resort per [[feedback_dat_parser_mislabels]]).
3. Fix the runtime side — never adjust the validator to make it pass (per [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) §4).

---

## 4. Client-side `__diag` diagnostic (by surface)

The wire-agent's `window.__diag` is observation-only. Boot the wire-agent with:

```
http://127.0.0.1:8765/apps/holtburger-web/index.html?
  autoLogin=1&account=acadmp1ge522&password=acadmp1ge522&autoSpawn=first
  &renderer=3d&quality=low&kickDance=1&agentic=low
  &wireframe=1&hud=none&plugins=none&netDrainHz=30&diag=1
```

Then query from devtools (or via Playwright `page.evaluate`).

### 4.1 Placements diff

```js
await window.__diag.loadExpected("./oracles/0xA9B40000.json")
window.__diag.placements.diff(0xA9B40000)
```

Returns `{expected, observed, missing: [...], extra: [...], ok}`.

| Classification | Meaning | Repair direction |
|---|---|---|
| `building-not-rendered` | Oracle has a building modelId not in `buildingsGroup` | Re-bake scenery for that LB OR fix `bakeBuildingsForLandblock` |
| `building-misplaced` | Same modelId observed, > 2m off oracle origin | Investigate `worldRoot.rotation` / per-mesh transform |
| `npc-not-rendered` | Oracle has wcid not in `entitiesGroup` | Spawn event lost; check `__diag.spawns.diff(lbId)` for 5-mode classification |
| `scenery-not-rendered` | Oracle has bakedScenery obj_id not in `staticsGroup` | Re-bake; check `MaterialCache.preload` errors via `__diag.assets.materialErrors` |
| `scenery-misplaced` | Same obj_id, > 2m off | Bake bug in coord transform; verify against B5 parity report |

### 4.2 Entity classification coverage

```js
window.__diag.entityTypes.snapshot()
window.__diag.entityTypes.coverageByLb(0xA9B40000)
```

If `bySource.unknown > 0`, the canonical classifier hit a branch it doesn't recognize. The `unknownTuples` array has `{wcid, itemType, objDescFlags, weenieFlags, name}` for each — these are the wire-input combos to port from `ACPlugin/API/WorldObject.cs`.

### 4.3 Events probe

```js
await window.__diag.events.probe(15000)
window.__diag.events.summary()
window.__diag.events.diff(0xA9B40000)
```

If `summary.total = 0` despite `?diag=1`:
- Check `liveScene3d._pushEventRecord` exists (requires `?eventLog=on` OR `?diag=1`).
- Check audio chain constructed: `liveScene3d.audioManager`, `.soundTableCache`, `.ambientRuntime` all non-null. (Wire-mode without `?diag=1` skips construction; fix at scene3d/index.js `audioConstructable` per commit `49634b33`.)

### 4.4 Physics drift

```js
window.__diag.physics.summary()
window.__diag.physics.tail(10)
```

`hitchCount > 0` means the predicted-vs-server drift exceeded 5 m at some sample — a rubberband event. `maxDrift > 1 m` sustained → network desync or integrator bug. Drill into the wasm shadow with `sessionHandle.getLastClientPrediction()` vs `__lastEntityWorldPos.get(localGuid)`.

### 4.5 Motion + wire correlation

```js
window.__diag.motion.stuckEntities(3000)
window.__diag.motion.linkPlays.slice(-10)
window.__diag.wire.tail.filter(r => r.k === 19).slice(-10)
```

`stuckEntities` reports entities that haven't transitioned in N ms despite wire packets. Cross-reference `__diag.wire.tail` filtered to combat events (kind=19) — if the wire shows combat aimed at a stuck entity, the motion path didn't apply the hurt anim. Likely cause: `_tryPlayLink` for the hurt motion couldn't find the link (missing cache entry, wrong `setupId`).

### 4.6 Integrity verify

```js
await window.__diag.integrity.verifyManifests({
  landblocks: ["0xA9B4", "0xA9B3", "0xAAB4"],
})
```

For each result:

| Result | Meaning | Repair direction |
|---|---|---|
| `match: true` | Bytes intact | Nothing to do |
| `match: false` + sidecar exists | The JSONL bytes changed since the bake | Re-deploy from canonical bake dir; check CDN |
| `match: null` + info "sidecar 404" | LB has no bake for that type | Legitimate if LB has no scenery/spawns/events of that type (Holtburg = no scenery, etc.) |
| `error: ...` | Fetch failed | Check `python3 /tmp/nocache-server.py` is running; check disk + paths |

---

## 5. Repair flowchart

```
DRIFT FOUND
  │
  ├─ Bake artifact wrong (per-LB JSONL or sha mismatch)
  │     ├─ Input DATs match canonical?
  │     │     yes → re-run the corresponding bake CLI for that LB:
  │     │           cargo run --release --bin scenery-bake -- \
  │     │             --dat-dir ~/ac_base_dats \
  │     │             --landblocks 0xLLLL \
  │     │             --out /mnt/wbterminal1/holtburger-dist-v2/scenery/
  │     │     no  → restore canonical DATs first, then re-bake
  │     │
  │     └─ Re-verify with `__diag.integrity.verifyManifests`
  │
  ├─ Bake artifact RIGHT, scene-graph WRONG
  │     ├─ Renderer code bug (transform, fetch path, group structure)
  │     │     → fix in scene3d/{statics,buildings,entities,terrain,cells}.js
  │     │     → bump cache-bust query in index.html dynamic import
  │     │     → re-run validate_landblock_completeness.cjs
  │     │
  │     └─ wasm exports return wrong data
  │           → bisect in scripts/world-completeness/ harness
  │           → fix in crates/holtburger-{dat,scenery-bake,...}
  │
  ├─ Bake + scene-graph BOTH wrong, oracle ALSO wrong
  │     → canonical algorithm drift. Three-source cross-reference per
  │       [[feedback_three_source_cross_reference]]: ACE + acclient.c + DRW.
  │     → fix the canonical port (Rust/C# CommandEngine code), then
  │       re-bake + re-validate.
  │
  └─ Validator OUTPUT is wrong (rare)
        → the validator IS the source of truth. Don't change it to make
          a bug pass. Either the contract is incomplete (extend it +
          method doc) or the validator has a real bug — fix carefully.
```

---

## 6. End-to-end: "diagnose Holtburg from scratch"

A 20-minute sequence for the operator running a full check on a fresh ring:

```bash
# 1. Confirm services up (laptop, ~5 s)
ps -ef | grep -E '(ACE.Server|wsbridge|nocache)' | grep -v grep

# 2. Confirm dist tree integrity (~10 s; reads only)
ls /mnt/wbterminal1/holtburger-dist-v2/{scenery,events,spawns}/*.sha256 | wc -l
#   expected: 3 × 169 ≈ 510

# 3. Re-export Holtburg oracle from WB.T (one-shot; ~5 s)
echo '{"command":"dump-lb-expectations","lbX":169,"lbY":180,
       "out":"/home/wbterminal/.../oracles/0xA9B40000.json"}' \
  | dotnet WorldBuilder.Terminal.dll --stdin --project /path/to/RetailSmoke.wbproj

# 4. Run the build-side aggregator (~7 minutes for the 169-LB ring)
echo '{"command":"diag-run-all"}' | \
  dotnet WorldBuilder.Terminal.dll --stdin
#   reads /mnt/wbterminal1/holtburger-validator-reports/

# 5. Boot wire-agent for client-side observation (~15 s)
node /mnt/wbterminal1/tmp/claude-scratch/.../run-diag-wave1.mjs
#   queries __diag.runAll + integrity.verifyManifests({landblocks: [...]})

# 6. Synthesize: any FAIL → §3/§4 drill-down by surface
#                only PASS → ring is byte+observation clean, ship it
```

Expected output: 14 build-side surfaces PASS + 10 client-side surfaces report no drift. If anything else, follow the flowchart in §5.

---

## 7. What this playbook does NOT cover

- **Bake algorithm fixes** — when a divergence is the canonical algorithm being wrong (e.g. the B.5 collision-parity fix). See the per-surface method docs for the canonical contract.
- **New surface bring-up** — when a new diagnostic axis emerges (e.g. Wave-4 texture decode). See [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) §8 "How a future agent picks up the toolset".
- **Whole-Dereth expansion** — see [`ring-expansion-method.md`](ring-expansion-method.md).
- **Performance regressions** — see `scripts/perf-worker/README.md`. Perf is observation-only telemetry, orthogonal to correctness diagnosis.

---

## 8. Provenance

| Doc | Updated | Source-of-truth contract |
|---|---|---|
| `world-completeness-method.md` | 2026-05-23 | Placement three-source ∪ + Phase E validator + Phase F `__diag` |
| `entity-completeness-method.md` | 2026-05-23 | Canonical `GetObjectClass` + E.E cross-port + `__diag.entityTypes` |
| `event-completeness-method.md` | 2026-05-23 | F.A–F.E + F.D-fu1..4 + `__diag.events` + audio-under-wire contract |
| `diagnostic-toolset-method.md` | 2026-05-23 | 14 build-side + Wave-6 client-side surfaces; aggregator gate |
| `ring-diagnose-repair-playbook.md` | 2026-05-23 (this doc) | — |
| `ring-expansion-method.md` | 2026-05-23 | — |

**End of playbook.** When in doubt, the source contract wins; this doc only orchestrates the diagnostic + repair workflow.
