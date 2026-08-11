# task-LB-CROSS-CONTROL — the arm nobody had run: cross WITHOUT a teleport

Orchestrator session §-12, 2026-08-11 (late), branch `orch/s11-2026-08-11`.

Charge: `ORCHESTRATOR-HANDOFF.md` §-11 §G item 3 / `queued/LB-CROSSING-STALL-card.md`
§3 hypothesis 4 — *"run the crossing WITHOUT a preceding teleport. The scenario
driver can do this; nobody has."* It is the read that separates
"teleport-then-cross" from "cross", which may be two different defects.

**Outcome: hypothesis 1 DELETED, no stall reproduced, hypothesis 4 promoted to
leading candidate — and the boundary-crossing proof is still owed for a reason
worth knowing about (a stale `pkg/`).**

---

## Shipped

Documentation and measurement only. No client code changed by this task.

| artefact | contents |
|---|---|
| `queued/LB-CROSSING-STALL-card.md` §6 | the live results, and the limits of the read |
| this report | method, numbers, what is and is not established |
| `~/eyetest/arm.mjs` | gained `key` and `crossUntil` ops (outside the repo; additive) |

---

## Method

T4, v4 dist, `agentp07`, **oracle flag set exactly** so the arm is comparable to
the captures that saw the stall:

```
?moveTelemetry=1&nosw=1&autoLogin=1&autoSpawn=first&agent=1
 &renderOnDemand=1&netDrainHz=30&bridge_url=ws://100.116.47.66:8080/
```

**No `@teleloc` was issued at any point** — that is the whole point of the arm.
The character spawned wherever it last logged out. Settle 65 s, then hold `w`
for 180 s, release, then hold `w` for a further 180 s.

**Instrument.** A 100 ms `setInterval` scheduling-lag watchdog installed in the
page, recording any fire delayed by >200 ms. Chosen over a `requestAnimationFrame`
probe deliberately: `renderOnDemand=1` stops rendering, so a rAF probe would
have measured nothing and reported it as calm. `bakeWorkerStats()` snapshots
were taken before, between and after.

---

## Results

| read | run 1 (180 s) | run 2 (180 s) |
|---|---|---|
| **max main-thread park** | **236 ms** (2 events: 232, 236) | **0 ms** (0 events) |
| `fallbacks.total` | **0** | **0** |
| `fallbacks.lastError` | null | null |
| `fetchSurfacesPixels.count` | 66 → 71 | flat |
| `fetchEntitySurfacesPixels.count` | 30 → 49 | flat |
| `fetchModelMeshes.count` | 125 | flat |
| `byType.*.failed` | all 0 | all 0 |
| `pendingNow` / `maxPending` | 0 / 32 | 0 / 32 |

### Hypothesis 1 — DELETED

`bakeWorkerStats().fallbacks.total` read **0** at all three snapshots. The bake
worker never fell back to the main thread; `lastError` never populated. The
crash-backoff shape §-11 ranked first — invisible until §-11 instrumented it,
and ranked first precisely *because* it was cheap to check — is not what is
happening on this arm.

This also re-validates a claim that had gone stale: the comment at
`bake_worker_client.js` `urlFlagEnabled` records that the A/B justifying
default-ON measured "0 main-thread fallbacks (worker fully engaged)". That was
true when measured and was never re-checkable from a capture. It is now, and it
re-checks green.

### Hypothesis 2 — not supported

`pendingNow` 0 and `failed` 0 at every snapshot, `maxPending` never above its
32 ceiling. No saturation signature.

### The stall did not reproduce

Six minutes of held running, with the bake lane demonstrably working, produced a
worst-case main-thread park of **236 ms** — against the ~6.5 s this card exists
for.

---

## What this does NOT establish (the honest limits)

**1. No landblock BOUNDARY crossing is proven.** The detector was to poll
`pos.lb` out of the movement telemetry ring. `window.__hbWasm.moveTelemetryDrain`
**does not exist on this box's deployed `pkg/`**:

```
moveTelemetryDrain    ABSENT from pkg/holtburger_web_bg.wasm
moveTelemetryStatus   ABSENT
aug_joat              ABSENT
castArbitrationDiag   PRESENT   (an older rider — so the wasm is simply old)
```

`index.html:2485` type-guards the whole rider ("typeof-guarded so a stale pkg/
yields `undefined`"), so the surface silently reads absent rather than throwing.
A precheck step caught it *before* the crossing step, which is why the run was
repurposed as a plain traverse instead of being discarded.

What IS established is that run 1 **streamed new content** —
`fetchEntitySurfacesPixels` +19 and `fetchSurfacesPixels` +5 — which does not
happen standing still in an already-resident neighbourhood. The avatar moved
through unloaded world. Whether it crossed a 192 m landblock edge is not
measured.

**2. Run 2 is weak evidence.** Every bake counter is flat and no lag fired, so
it most likely traversed nothing new (avatar against geometry, or back over
resident ground). Its 0 ms is not a second independent trial.

**3. This is not the paired experiment.** The clean read is the same arm twice,
differing ONLY in a preceding `@teleloc`. The teleport half needs Developer
(`tailnet1`) and was not run.

---

## Deviations

**D1 — the crossing detector could not run** (stale `pkg/`, above). Reported
rather than worked around; the arm's remaining reads are sound on their own
terms and are presented as such.

**D2 — `renderOnDemand=1` was kept** to match the oracle captures, which forced
the choice of a `setInterval` watchdog over a rAF probe. Recorded because a
future reader comparing lag numbers across arms needs to know which clock was
used.

---

## Tests run

| command | result |
|---|---|
| live arm `lbcross-control` | completed, `ok: true`, 0 pageErrors |
| console errors | 3 — the known `terrain_bc7/t1024`, `terrain_bc7/t512`, `pbr_terrain` manifest 404s (tier absent from the v4 dist) |

No node suite is exercised by this task.

---

## Handoffs & risks

**H1 — the next step is cheap and specified.** Once `pkg/` carries
`moveTelemetryDrain`: (a) re-run this exact arm with the `pos.lb` detector live
so real crossings can be timestamped against the lag series; (b) run the
teleport half on `tailnet1`; (c) diff. The job file
(`~/eyetest/job-lbcross.json`) already contains the detector expression and the
`crossUntil` op — only the wasm was missing.

**H2 — `pkg/` on this box was stale for the whole oracle surface**, not just for
§-11's new fields. Anything reading movement telemetry on this box before a
rebuild is reading nothing. That blocked oracle open #1 as well.

**H3 — hypothesis 4 is now the leading candidate**, and it changes the shape of
the work if it holds: the defect would belong to the teleport's residency
transition, not to landblock streaming.
