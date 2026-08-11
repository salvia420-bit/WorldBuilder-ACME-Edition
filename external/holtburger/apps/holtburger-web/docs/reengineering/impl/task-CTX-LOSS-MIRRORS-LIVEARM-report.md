# task-CTX-LOSS-MIRRORS-LIVEARM — the arm §-11 owed, run on the T4

Orchestrator session §-12, 2026-08-11 (late), branch `orch/s11-2026-08-11`
(stacked on `orch/s10-2026-08-11`, where the fix lives).

Charge: `ORCHESTRATOR-HANDOFF.md` §-11 §G item 1 — "the cheapest close on the
board". `queued/CTX-LOSS-MIRRORS-card.md` §5 is the recipe. The mechanism was
already proven in node by §-11; **only the live confirmation was owed.**

**Outcome: the arm ran, and the card is CLOSED.** It took two boots, because
the first one produced the number the card asks for while proving nothing —
see "The vacuous first arm" below, which is the most transferable thing in
this report.

---

## Shipped

| commit | contents |
|---|---|
| `639916e6` | `scene3d/webgl_context_recovery.js` — `__restoreContext()` could never restore. Found BY the arm, blocking it. |
| (this file) | the report |
| (card edit) | `queued/CTX-LOSS-MIRRORS-card.md` §5 now carries the live numbers instead of reading as owed |

No change to the CTX-LOSS-MIRRORS fix itself. It landed on s10 (`725609ee`)
and this session only measured it.

---

## THE VACUOUS FIRST ARM (read this before trusting any context-loss gate)

The first boot ran the card §5 recipe exactly and returned:

```
mirrors.release  restoreFailed 0        <- the number the card demands
rehydrate        passes 0  rehydrated 0 <- the pass NEVER RAN
scene            contextLost TRUE       <- 60 s after restore was issued
```

`restoreFailed: 0` was true and meaningless: nothing was attempted, so nothing
could fail. The card's own second clause caught it — the gate is
`restores === freed`, and restores read **0** against freed **15**. A reader
checking only the headline number would have closed the card on a boot where
the context never came back.

**Root cause, isolated in a standalone headless probe** with no ACE login and
no dist (`~/eyetest/probe-ctxrestore.mjs`, Chrome/ANGLE gl-egl, this T4):

```
getExtension("WEBGL_lose_context") BEFORE loseContext()  -> non-null
getExtension("WEBGL_lose_context") AFTER  loseContext()  -> null
restoreContext() on a handle captured BEFORE the loss    -> restores cleanly
        (events fire ["lost","restored"], isContextLost() -> false)
```

`window.__restoreContext()` re-fetched the extension off `renderer.getContext()`
— the LOST context — so it could only ever take its
`if (!ext) return "WEBGL_lose_context extension unavailable"` branch. **The one
call the entire verification cycle depends on was unreachable by construction.**
The client's recovery path was never at fault: `_onLost` does call
`e.preventDefault()`, so the context was always restorable; nothing was asking.

Fixed in `639916e6` by caching the handle while the context is alive and
re-taking it in `_onRestored` (a restore builds a new context, so a second
cycle in one session would otherwise drive a dead handle). The second boot then
drove the SHIPPED helper, not a bespoke workaround — which is the point.

> No harness suite covers `scene3d/webgl_context_recovery.js`. That is how a
> devtools helper sits broken through a whole eye session.

---

## The arm that counts (boot 2)

`?renderScale=1&packSource=on&texCompressedOnly=on&texWorkers=on&terrainT1024=on`
+ `nosw=1`, autoLogin `agentp07`, `bridge_url=ws://100.116.47.66:8080/`.
Settle to terrain plateau (121 LBs, stable), `__loseContext()` → 5 s →
`__restoreContext()` → poll to restored → 35 s settle → 25 s more.

**GPU proven INSIDE the live page, not from a string** — a drawn triangle read
back through `readPixels`:

```
renderer  ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)
pixel     [255, 0, 0, 255]      drawnRed true
```

ST5 armed proof (the flag-read global is not exposed, so the counters are the
evidence): `pvwHits 49`, `fullSwaps 48` — the compressed-only path is doing
real work on this boot.

### The gate

| read | before loss | after restore | card's demand |
|---|---|---|---|
| `mirrors.release.restoreFailed` | 0 | **0** | MUST be 0 ✅ |
| `mirrors.release.restores` | 0 | **15** | `=== freed` (see note) ✅ |
| `mirrors.release.freed` | 15 | 22 | |
| `rehydrate.passes` | 0 | **1** | the pass must actually run ✅ |
| `rehydrate.lastPass` | null | **attempted 15, rehydrated 15, failed 0, ms 3932** | ✅ |
| `tiers.fullFetchMisses` | 0 | **0** | 0 preferred ✅ |
| `tiers.lastFullFetchError` | null | **null** | names any miss ✅ |
| `tiers.fullFailed` | 0 | **0** | vs the T4 arm's 18 ✅ |
| `__hbFetch.forgotten` | 46 | **61** | > 0 ✅ |
| `byComponent.texFull.requests` | 46 | **61** | must EXCEED distinct rsIds ✅ |
| console "will render BLACK" | — | **0 lines** | zero ✅ |

**`restores === freed` — the honest reading.** 15 mirrors were released at the
moment of the loss and **all 15 were restored** (`attempted 15, rehydrated 15,
failed 0`). `freed` then kept climbing to 22 because ordinary eviction released
7 more AFTER the pass, and those 7 are registered (`registered 22`) for a future
restore, not lost. The equality holds over the pass; it is not a session-long
invariant, and a future session should read `lastPass.attempted` vs
`lastPass.rehydrated` rather than the two cumulative counters.

### The two numbers that settle the card

**1. `3ms` → `3932ms`.** The card called `3ms` "the load-bearing number": six
CAS re-fetches plus six worker transcodes cannot finish in three milliseconds,
so nothing was being fetched. The console this time:

```
[tex-rehydrate] context-restore #1: re-supplying pixels for 15 released texture(s)
[tex-rehydrate] pass OK in 3932ms (rehydrated=15 skipped=0 gcd=0)
```

Fifteen re-fetches + transcodes in 3.93 s is the right order of magnitude for
real wire and real worker work. The pre-fix line was
`pass finished with 6 MISS(es) in 3ms (rehydrated=0 ...)`.

**2. `texFull.requests` 46 → 61, exactly +15.** The rehydrate re-fetched one
payload per released mirror, and `forgotten` moved 46 → 61 in lockstep — each
re-fetch also dropped its latch. The card predicted precisely this shape.

`__webglContextRecoveryHistory()`:

```
lost      count 1
restored  downMs 5162.6   rehydratePending 15
rehydrated ok 15  failed 0  ms 3932
```

Renderer recovered: `contextLost false`, terrain still 121 LBs.

### `fullFailed = 18` — settled, with a caveat

`fullFailed` read **0** on this boot, before AND after the loss, where the
pre-fix T4 arm read 18. That is consistent with §-11's prediction (a second
Surface DID sharing one RenderSurface was failing exactly this way, needing no
context loss). **Stated honestly: this is a strong corroboration, not a
controlled proof.** Nobody counted how many rsIds this boot shared versus the
T4 arm's, so "0 where 18 was" is the same arm on the same dist with the fix in
— not an A/B with the shared-rsId count held constant. The node reproduction
(`fullSwaps=1 fullFailed=1` on a shared rsId) remains the mechanism evidence.

---

## Spec conformance

Card §5's judgement clause: *"`restoreFailed === 0` with `restores === freed`
closes the card."* MET — with the pass-scoped reading of the equality recorded
above, and with `rehydrate.passes = 1` proving the pass ran, which is the
clause the first boot taught us to add.

No SPEC §3 row is claimed by this work. No flag default moved. No wasm rebuilt
(no Rust reaches this).

---

## Deviations

**D1 — the card's gate needs a liveness clause, and this report adds one.**
`restoreFailed === 0` is satisfiable by a boot in which the rehydrate never
runs. Any future reader of this gate must also assert `rehydrate.passes >= 1`
and `lastPass.attempted > 0`. Recorded in the card.

**D2 — one file outside the card's scope was edited** (`webgl_context_recovery.js`,
commit `639916e6`), minimally and unavoidably: the card's arm is not runnable
without it. Per I2 this is recorded rather than silent.

---

## Tests run

| command | result |
|---|---|
| `node harness/test_tex_compressed_only.mjs` | **115 passed / 0 failed** (§-11 baseline held) |
| `node harness/test_pack_fetch_controller.mjs` | **100 passed / 0 failed** (§-11 baseline held) |
| `node harness/test_diag_schema.mjs` | **69 passed / 0 failed** (was 63/6 — see `75ce04cc`) |
| `node --check scene3d/webgl_context_recovery.js` | clean |
| live arm boot 1 | VACUOUS — recorded above, not counted |
| live arm boot 2 | the table above; 0 console errors other than 3 known 404s |

The three 404s are `terrain_bc7/t1024`, `terrain_bc7/t512`, `pbr_terrain`
manifests — the tier the v4 dist does not carry. Same three the T4 session saw;
they are why the queue row's `__terrainBc7Stats.mirrorRestoreFailed` gate is
vacuous on this dist and why the real gate is `__texStats().mirrors.release`.

---

## Handoffs & risks

**H1 — A REAL DEFECT FOUND BY THIS ARM, NOT FIXED (deliberately).**
`[webgl-recovery] onPause threw: ReferenceError: _releaseFrameDriverClaim is
not defined`, on BOTH boots (so it predates every change this session).

* defined ONCE, at `scene3d/index.js:985`, inside `export async function preInit3D`
* called from `scene3d/index.js:3616` (`stop()`) and `:5110` (`onPause`), both
  inside `export async function init3D` — a DIFFERENT top-level function
* `preInitHandle` never exposes it (no `preInitHandle.` reference exists)
* `window.__scene3dFrameDriverActive` is set true at `:5114` and `:7201` and
  cleared ONLY at `:988`, inside the unreachable helper

So the frame-driver claim is never released on a context-loss pause or on
`stop()`, and the comment at `:5106` ("context-loss pause releases the
frame-pump claim") describes behaviour that does not happen. Recovery still
completes because the throw is caught and warned. Not fixed here: the repair is
a scope decision (move the helper, hang it off `preInitHandle`, or duplicate
it) in a file outside this card, and it deserves its own change with its own
verification rather than a late-session guess.

**H2 — the retention question (§-11 §G 6) now has live numbers.** Measured on
this same boot, no extra cost — see `impl/task-CONTROLLER-RETENTION-note.md`.

**H3 — `arm.mjs` gained two ops** (`key`, `crossUntil`) in `~/eyetest/`, outside
the repo. Additive; existing jobs unaffected.

**H4 — set `needsCam: false`** in any arm that does not use `__cam`, or pass
`camDebug=on`. Boot 1 burned 4 minutes waiting for a helper it never needed.

**H5 — the client defaults to `ws://127.0.0.1:8080/`.** ACE now lives on the
laptop's tailnet address, so every arm needs
`&bridge_url=ws%3A%2F%2F100.116.47.66%3A8080%2F` or it dies at
`connect failed after 1 attempts` having never sent a LoginRequest. There IS a
first-class URL param for this (`index.html:6270`), added for exactly this
tunnel workflow.
