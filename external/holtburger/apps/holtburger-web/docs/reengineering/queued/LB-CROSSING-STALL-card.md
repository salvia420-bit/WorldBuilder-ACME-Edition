# CARD — LB-CROSSING-STALL (filed 2026-08-11 by the §-11 orchestrator session)

**Status: OPEN. Not reproduced this session — no live capture was run. What
landed is the instrumentation that makes the prescribed first check
answerable, because it was not.**

Oracle open defect #3 (`impl/task-ORACLE-report.md` S3.7). `ORCHESTRATOR-HANDOFF.md`
§-10 C says it "deserves a card" and that the first check is the bake worker.
This is that card.

---

## 1. The observation (session 3, oracle rig)

A **~6.5 s main-thread park**, and the shape is what makes it interesting:

* **per-scenario, not per-session.** Session 2 recorded it once and read it as
  a one-shot. Session 3 measured it on **all three attempts of every capture**.
* **always after the `@teleloc`**, and
* **always within a few seconds of the run crossing into the next landblock**,
  `0x977B000C → 0x977B000D`.

Teleport-then-cross points at landblock streaming/bake rather than GC or a
buffer swap. On the oracle rig it is a capture nuisance; a 6.4 s main-thread
park on a landblock crossing is a client defect on its own terms.

---

## 2. Why the prescribed first check could not be made — and now can

§-10's instruction is *"first check should be whether the bake web worker fell
back to the main thread."* Reading `scene3d/bake_worker_client.js` this
session: **that question had no answer in the diag surface.**

Every fallback site does
`console.warn("[bake_worker_client] … main-thread fallback:", e)` and then runs
the decode on the main thread. Nothing counted it. And the counter you would
reach for — `__diag.bakeWorkerStats().byType[t].failed` — cannot stand in,
because the two paths that matter **never reach `_request` at all**, so
`byType[t].count` does not move either:

* `_ensureWorker()` **refuses to spawn inside the post-crash cooldown**
  (`_workerRetryAtMs`, doubling geometrically per consecutive crash — the F1
  backoff added 2026-08-03). The caller's `await this._ensureWorker()` rejects,
  its `catch` takes the main-thread path, and no statistic moves.
* a request **dropped before dispatch** (`settleUndispatched`, the F2 fix)
  rejects the same way.

So during a backoff window `bakeWorkerStats()` is indistinguishable from a
healthy worker that happens to be idle — while every per-LB bake is parking the
main thread. That is a very good candidate shape for a multi-second stall that
appears only after a teleport, and it was invisible.

**Landed this session** (`scene3d/bake_worker_client.js`, diagnostics only, no
behaviour change): `_noteMainThreadFallback(type, error)` at all four fallback
sites, surfaced as

```
__diag.bakeWorkerStats().fallbacks = { total, byType, lastError, lastAtMs }
```

`total > 0` means bake decode ran on the main thread; `lastError` names why
(`"bake worker: in crash backoff for another N ms"` is the shape to look for,
and `lastAtMs` timestamps it against the crossing).

> Note the existing comment at `bake_worker_client.js` `urlFlagEnabled`: the
> A/B that justified default-ON measured "**0 main-thread fallbacks** (worker
> fully engaged)". That claim was true when measured but was never
> re-checkable from a capture. Now it is.

---

## 3. Hypotheses, ranked, with the read that discriminates each

| # | hypothesis | the read |
|---|---|---|
| 1 | **Bake worker in crash backoff** — the worker died (a stale `pkg/` after a wasm rebuild is the documented usual cause, `bake_worker_client.js:1034`) and every subsequent per-LB bake runs main-thread. | `fallbacks.total > 0` and `fallbacks.lastError` naming the backoff. NEW this session. |
| 2 | **Worker alive but saturated** — the crossing enqueues a burst and the main thread blocks awaiting it. | `bakeWorkerStats().queue.maxQueuedLen`, `byLane[].maxQueueMs`, `byType.*.maxMs`, `maxPending`. All ALREADY instrumented. |
| 3 | **Not the bake lane at all** — pack/tile fetch, the slot grid's crossing lever, or terrain assembly. | `__hbFetch.wireWaitEvents` / `lanes.*.inflight`, `__diag.residency`, `__framePhase`. Already instrumented. |
| 4 | **`@teleloc`-specific**: the teleport puts residency in a state the crossing then pays for — the crossing alone may be innocent. | run the crossing WITHOUT a preceding teleport. The scenario driver can do this; nobody has. |

Hypothesis 4 is the cheapest and no one has tried it. It is also the one that
would most change the shape of the work: "teleport-then-cross" and "cross" may
be different defects.

---

## 4. What to run (no 1070 needed; the T4 or any box with the dist can do it)

1. `?moveTelemetry=1` capture with the oracle scenario driver, **plus** a
   `bakeWorkerStats()` snapshot taken BEFORE the `@teleloc` and again AFTER the
   crossing. The stall is ~6.5 s — a diff of two snapshots across it attributes
   it or exonerates the lane in one run.
2. The control arm hypothesis 4 asks for: same run, **no `@teleloc`**. Walk in.
3. If `fallbacks.total > 0`, the next question is why the worker died, and the
   first suspect is on record: a `pkg/` older than the last Rust-touching
   commit. `python3 scripts/serve.py --check` warns about exactly that.

**Do not** judge this from a `performance.now()` gap alone. A 6.5 s park has
many possible owners and this rig has instrumented most of them; read the
counters.

---

## 5. Explicitly NOT claimed

* Nothing here reproduces the stall. No capture was run this session.
* The crash-backoff hypothesis is **ranked first because it is cheap to check
  and was previously unobservable**, not because there is evidence for it.
  `fallbacks.total` may well read 0 on the first capture, and that is a
  perfectly good outcome — it deletes hypothesis 1 in one read, which is more
  than the last two sessions managed.
