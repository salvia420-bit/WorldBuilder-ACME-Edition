# NOTE — the controller's session-long payload retention, measured

Orchestrator session §-12, 2026-08-11, branch `orch/s11-2026-08-11`.

`ORCHESTRATOR-HANDOFF.md` §-11 §G item 6, scoped by the session brief as
**INVESTIGATE-AND-WRITE-UP ONLY: characterise it, quantify it, recommend — do
not land a redesign.** Nothing was changed. This note is the deliverable.

---

## 1. The mechanism (read-verified, `scene3d/pack_fetch_controller.js`)

`settleSuccess` (:460) resolves the entry's promise and **never removes the
entry from `entries`**. The comment says so outright:

```js
// success entries stay in the map as a latch: a later need() for the
// same URL resolves immediately off the settled promise.
entry.resolve(buf);
```

The latch is deliberate and correct — it is what makes `need()` idempotent per
URL and gives the D-03.4 dedupe guarantee. But the settled promise retains its
resolution value, so **every payload the controller has ever successfully
fetched is pinned for the life of the session.** By contrast `settleFailure`
(:473) DOES `entries.delete(...)` so transients don't latch.

`forget(url)` (:563) is the §-11 escape hatch: it drops a settled latch (and
its residency), refusing queued/in-flight entries. It is **opt-in and only the
texFull consumer calls it.**

---

## 2. The measurement

Taken on the CTX-LOSS-MIRRORS live arm (boot 2), T4, v4 dist, flag chain
`packSource=on&texCompressedOnly=on&texWorkers=on&terrainT1024=on` — one
settled boot, **stationary**, terrain plateau at 121 landblocks. Read straight
off `__hbFetch`.

At terrain plateau, before the context loss:

| lane | done | bytes |
|---|---|---|
| U | 1 | 36,739 |
| B | 7 | 7,013,560 |
| R | 39 | 1,272,431 |
| **T** | **46** | **42,156,558** |
| **total** | | **50,479,288 (48.14 MiB)** |

At end of arm (after a context loss forced 15 re-fetches):

| component | requests | bytes | forgotten? |
|---|---|---|---|
| `texFull` | 61 | **59,975,664** | **YES — all 61** |
| `meta` | 4 | 3,894,276 | no |
| `pvw` | 2 | 1,725,960 | no |
| `terrainTier` | 2 | 1,270,680 | no |
| `tiles` | 36 | 618,801 | no |
| `manifestIndex` | 1 | 464,666 | no |
| `core` | 1 | 329,738 | no |
| `interior` | 1 | 18,609 | no |
| **total fetched** | | **68,298,394 (65.13 MiB)** | |

`__hbFetch.forgotten` read **61**, exactly equal to `texFull.requests`. Only
the texFull consumer calls `forget`, so every texFull payload was dropped.

### The two numbers that matter

* **Without `forget`, this boot would pin 65.13 MiB.**
* **As shipped, it pins 8,322,730 B = 7.94 MiB** (the seven non-texFull rows
  above sum to exactly that, which cross-checks the accounting).

**§-11's `forget` fix removes 87.8% of the retention by bytes.** The
"~1.3 MB × N against M4" it was worried about was real and is now paid: 57.2 MiB
of texFull payload on a single stationary boot.

---

## 3. The finding that matters more than the total

**The retained classes are the ones that grow with TRAVEL, and the released one
was the one that doesn't.**

This capture is one location with no movement. In that regime the residue is
7.94 MiB and it is dominated by fixed, once-per-session costs — `meta`
(3.89 MiB in 4 requests), `manifestIndex`, `core`. Those are bounded by
construction: there is one of each.

`tiles` and `interior` are not. They are keyed per tile/per cell, they are
fetched as the player traverses, **and nothing ever forgets them.** This boot
touched 36 tiles for 618,801 B — about **17.2 KB per tile** — while standing
still inside an already-settled 121-landblock neighbourhood.

So the retention curve is flat-ish in a stationary session and **monotonically
increasing in a travelling one**, with no eviction path at all. A session that
crosses a few thousand tiles carries every one of them. At the measured
17.2 KB/tile, 2,000 tiles is ~34 MiB and 5,000 is ~86 MiB — *extrapolated from
one boot's per-tile mean, not measured*, and the mean will move with tile
content.

That is the M4 question, and it is a different question from the one §-11
flagged. §-11 was worried about the biggest class; the biggest class is the one
already fixed. **The unbounded class is `tiles`.**

---

## 4. Recommendation (NOT landed)

1. **Do not generalise `forget` into "delete on settle".** The latch is load-
   bearing for D-03.4 dedupe and for genuine multi-consumer payloads
   (`meta`, `manifestIndex`, `core` are read by more than one consumer, and
   the texFull rehydrate proved a second reader can arrive arbitrarily late).
   A blanket delete re-introduces exactly the duplicate-fetch class the
   controller exists to prevent.

2. **Give the controller a residency policy for the traversal-keyed classes
   only** — `tiles` and `interior`. They already carry a `tileKey`, and the
   slot grid (`?slotGrid`) is already the residency authority for exactly this
   population: when the grid evicts a tile, the controller should `forget` its
   payload. That is a hook, not a redesign, and it reuses a decision the grid
   is already making rather than inventing a second eviction policy that can
   disagree with it.

3. **Count bytes, not entries.** `diag.forgotten` is a COUNT. This note had to
   infer the freed bytes from `forgotten === texFull.requests`, which happened
   to be a clean identity only because one consumer calls `forget`. A second
   caller makes that inference invalid. Add `diag.forgottenBytes` before
   anyone else adopts `forget`.

4. **Measure it while travelling before sizing anything.** Every number here is
   one stationary boot. The `tiles` slope is the whole question and this
   capture cannot see it. The LB-crossing arm in this same session is the
   natural place to add a `__hbFetch` read either side of a crossing.

---

## 5. Explicitly not claimed

* No change was made to `pack_fetch_controller.js` or any consumer.
* The 34 MiB / 86 MiB figures are **extrapolations from a single boot's
  per-tile mean**, offered to size the question, not as measurements.
* Retention is inferred as "fetched minus forgotten". Nothing here directly
  measured heap; `__diag.wasmMem` and the JS-heap half were not read on this
  arm. A payload's `ArrayBuffer` could in principle be released by a consumer
  dropping its own reference — but the controller's latch holds one
  independently, which is the entire point of the mechanism.
