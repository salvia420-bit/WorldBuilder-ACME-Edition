# RESULTS — MaterialCache falsifier reruns: the 3.6 GB step is NOT the cache's pixel bytes (2026-07-26)

> **⚠ PARTIAL RETRACTION (same night, later):** the "3,586 MB step" itself was an
> instrument artifact — unflagged `performance.memory` is quantized and cached for
> 20 minutes, and 3,586 MB exceeds this box's V8 heap limit. See
> `RETRACTION-jsheap-step-2026-07-26.md`. The INTERVENTION findings below stand
> (cache pinned at 64 MB, settle worsened, tracked bytes honest); every sentence
> about "the step" and its POI position is void.

Executes next-move 1's falsifier from `RESULTS-validation-battery-2026-07-25.md`
(bounded-cache armLong rerun) against the merged `feat/matcache-budget`
(`?matBudgetMB=N` byte-budget LRU, commit `207b0468`) + `feat/arc-surface-pixels`
(option E, `81ad4891`), release wasm 4.9 MB built 2026-07-26 00:55. Same armLong
rig: full 62-POI route, ONE unlimited session, `?nullRender=1&nosw=1`, park at
Samsur, no concurrent builds.
Raw: `/mnt/wbterminal2/matcache-falsifier-2026-07-26/` (`run1-1024/`, run 2 at top
level).

## Run 1 — `matBudgetMB=1024` (00:57–01:24)

| metric | armLong (unbounded, last night) | armLongMC=1024 |
|---|---:|---:|
| sessions/deaths | 1 / 0 | 1 / 0 |
| settleMed(work) | 17.1 s | 17.3 s |
| capped | 20 | 21 |
| maxMain / maxWkr | 679 / 234 | 680 / 232 |
| jsHeapPeak max | 3,586 MB | 3,586 MB |
| final mats | 1,802 | 1,807 |
| tracked cache bytes (`matMB`) | — (no instrument) | **355 MB, evictions 0** |

**The budget never bound.** Tracked LRU bytes (`Σ image.data.byteLength` per DID —
a direct measurement, not a model) reached only 355 MB at mats=1,807, ~196 KB/DID
average: this route/preset holds mostly small albedo-only textures (normal maps off
in the low preset ⇒ 1 plane, and most surfaces are ≤256², not the 512² 3-plane
2.25 MiB the §6 model assumed).

**And yet the heap stepped anyway, identically**: 54 MB flat → 3,586 MB at stop
~47 (mats=1,488, tracked cache = **261 MB** at that moment), and the settle
age-collapse persisted (caps per decade 1/3/1/4/5/5). The four bounded Maps held
an order of magnitude too few bytes to be the step.

### Reading

`RESULTS-validation-battery-2026-07-25.md` verdict 1 ("MaterialCache retainer:
CONFIRMED") conflated *correlation* (mats grows linearly with route progress; so
does every other route-cumulative quantity) with *identity of the retainer*. The
step detector fired at the same place while the cache's actual content was 261 MB.

**New lead suspect: entity-owned recolored textures.** `preloadBatch`'s
entity-owned leg (`_buildEntityOwnedFromPixels`, materials.js) deliberately does
NOT install into `this.materials` ("would collide with non-recoloured uses of the
same surface DID") — each entity registers its own texture via
`inst.registerOwnedTexture`/`registerOwnedMaterial`. Those textures are: outside
all four bounded Maps, uncounted by `matMB`, per-entity (not per-DID — a popular
recolored surface is duplicated per wearer), and cumulative with route progress
exactly like `mats`. A 62-town roam accumulates thousands of NPC/player/item
spawns.

## Run 2 — `matBudgetMB=64` (01:27–…, binding by construction)

Purpose: clean interventional kill. 64 MB < the 261 MB the cache held at run 1's
step, so evictions MUST fire (gate proof: `evict>0` in the relay). If the heap
still steps to ~3.6 GB and the 31+ bucket still caps while the cache is pinned at
64 MB, the MaterialCache mechanism is **refuted by intervention** and the hunt
moves to the entity-owned pool. If the step vanishes, the eviction of derived
clones/anim frames (which ARE dropped on evict but only partially charged) was
load-bearing after all.

RESULTS (01:27–01:57): **REFUTED, cleanly.** Gate proof: `mats` pinned at 64 MB
from ~stop 4 (`mats=496@64MB/64 evict=26` at Arwic), **5,723 evictions** over the
route, final mats 375. And:

| metric | armLong (unbounded) | run 1 (=1024, never bound) | run 2 (=64, bound) |
|---|---:|---:|---:|
| settleMed(work) | 17.1 s | 17.3 s | **23.8 s** |
| capped | 20 | 21 | **25** |
| jsHeapPeak max | 3,586 MB | 3,586 MB | **3,586 MB** |
| step position | ~Timaru | stop ~47 | **stop ~49 (Swank)** |
| maxMain / maxWkr | 679 / 234 | 680 / 232 | 681 / 237 |
| deaths | 0 | 0 | 0 |

1. **The heap step is untouched** — same magnitude, same route position — with the
   four maps holding 64 MB. The MaterialCache maps are not the 3.6 GB.
2. **Bounding the cache made settle WORSE** (23.8 s vs 17.1 s; caps per decade
   3/4/0/5/5/6): the churn (5,723 re-creates) is pure cost. The maps' content was
   earning its keep.
3. **The step is a route-position event, not a monotone threshold-crossing**: in
   all three runs it fires entering the *Swank* cluster (Storage → **Swank** →
   Timaru; last night's write-up said "from Timaru onward" — Swank is two stops
   earlier, same boundary). Hotel Swank is an item museum: a mass spawn of dyed
   items ⇒ a burst of entity-owned recolored textures, allocated at that stop and
   **retained through every later stop** (js stays 3,586 to route end). This is
   §6's H2 branch, which the mats-correlation had wrongly demoted.

## Option E cold-spike note (from run 1, weak single sample)

maxMain 680 MB — low end of the 678–986 lottery band; boot-town variance makes one
session uninformative. The designed instrument is `decodeAdmission.peakLiveBytes`
cold-boot A/B (option E analysis, commit `81ad4891` message + agent report): the
entity-batch accumulator now shares planes with the cache, predicted ≈ halving of
that path's peak. Not yet measured.

## Next moves, in order

1. **Instrument the entity-owned pool**: count + byte-sum textures/materials
   registered via `registerOwnedTexture`/`registerOwnedMaterial` (entities.js
   :2681/:2685) across live entity instances; add `entMB` to `__diag` + the
   relay. Discriminator: `entMB` stepping at Swank while `matMB` stays flat
   confirms; then a skip-Swank route control isolates the POI. Note entity
   teardown DOES `dispose()` owned textures (:2932-2938) but `Texture.dispose()`
   frees GPU handles only — the JS bytes free on unreachability, so the question
   is which holder keeps dead entity instances (or their textures) reachable
   after leaving town.
2. **Fix the entity-owned lifecycle** once instrumented: share recolors by
   `(did, palette-key)` instead of per-wearer, and/or make despawn actually
   unreachable the texture objects. Expected to retire the 3.6 GB step.
3. **The settle age-collapse is now un-explained again** — it persists under a
   bounded cache (worse) and an unbounded one (17.1 s). With the MaterialCache
   mechanism dead, GC pressure from the entity-owned pool is the remaining
   route-cumulative suspect; re-test after move 2.
4. `matBudgetMB` stays **armable-but-off** (correct, tested instrument; wrong
   address for the killer). Do NOT arm a default; the 64 MB run doubles as the
   grey-surface/churn cost datum (~+7 s settle at museum-density).
5. Cold spike: `decodeAdmission.peakLiveBytes` cold-boot A/B for option E on a
   boot-town-matched pair, plus extend `bakeBatchMax` to the two entity fetch
   paths it never covered (option E analysis, `81ad4891`).
