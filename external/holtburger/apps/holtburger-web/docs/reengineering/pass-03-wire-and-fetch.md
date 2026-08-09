# Pass 03 — Wire and fetch: manifest consumption, fetch architecture, integrity, cache headers, progressive delivery, offline

Pass 3 of 12. Governed by `TRACKING.md`'s protocol header. This pass designs the client-side
fetch architecture that consumes pass 2's HBP1 packs and HBSI1 index: the runtime
manifest/index scheme that replaces the namespace catalogs, the fetch scheduler (granularity,
lanes, priorities, prefetch radius), the pack-level integrity model that replaces per-shard
sha256, the HTTP/CDN header contract, progressive (preview-first) delivery ordering, and the
service-worker/offline story. Source classes per R7: **[M]** measured (with doc/probe named),
**[D]** derived (arithmetic shown), **[A]** assumed-pending-measurement.

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all).
- `crates/holtburger-resource-http/src/manifest_source.rs` — lines 1–1053 (all):
  `prefetch_impl` steps A–E (534–839), urgent lane (389–394, 723–757), verify gate
  (108–118, 786–830), concurrency hook + split note (64–91), budget default
  `usize::MAX` (133–145), boot-pack sha256 at connect (500–507), `key_known_absent`
  (1000–1012), diag publish (862–897).
- `crates/holtburger-resource-http/src/concurrency.rs` — lines 1–178 (all):
  `DEFAULT_FETCH_CONCURRENCY = 32` (49), per-instance-split rationale (19–29).
- `crates/holtburger-resource-http/src/http.rs` — lines 1–151 (all): `FetchPriority`
  Auto/Low only (56–60), priority via `Reflect::set` on RequestInit (66–77).
- `crates/holtburger-resource-http/src/inflight.rs` — lines 1–120: dedup contract,
  error-entry removal invariant (32–34).
- `crates/holtburger-resource-http/src/shard_cache.rs` — lines 1–140: the 58+21 MB
  two-instance ratchet (8–11), eviction-soundness + round protection (18–69).
- `crates/holtburger-resource-http/src/recording.rs` — lines 1–92 (all): miss recording
  on both read paths.
- `apps/holtburger-web/src/prefetch.rs` — lines 1–515 (all): `run_walk_loop` ≤8 rounds
  (375), `PREFETCH_ROUND_TRIES = 3` (133), stall guard (383–394), per-round retry
  (400–437), urgent variants (225–234, 280–290).
- `crates/holtburger-dat/src/lib.rs` — lines 140–209: `ResourceSource` trait — **sync**
  `get_file_by_key`/`get_file_shared` (157–175), `key_known_absent` provability contract
  (185–195).
- `crates/holtburger-manifest/src/v2.rs` — lines 160–239: v2 fields, URL templates,
  `catalog_version` (204–208).
- `scripts/serve.py` — lines 1–731 (all): compression negotiation (339–405), KTX2
  identity sniff (394–404), Range-never-compressed (511), header tiers — shards
  immutable (615–616), no-cache revalidate tier (617–632), no-store tier (633–636),
  `Vary: Accept-Encoding` (606–607), HTTP/1.1 keep-alive rationale (461–467),
  `request_queue_size = 1024` (704–706).
- `scripts/proxy.cjs` — lines 55–99: production immutable-header precedent (73, 87).
- `apps/holtburger-web/service-worker.js` — lines 1–378 (all): `CONTENT_CACHE =
  "holtburger-content-v2"` (22), cache-key invariant block (130–165), `isContentAddressed`
  /`isBakeVersioned`/`isCacheable` (163–183), bake-identity gate (281–291), SWR for
  `/scene3d/assets/` (300–303), fetch handler scope (310–314), offline stale fallback
  (358–370), boot prefetch list (40–60).
- `apps/holtburger-web/index.html` — lines 2550–2619 (SW registration + `?nosw=1`
  unregister/reload path); grep-verified call sites 1456, 2632, 2686
  (`applyFetchConcurrencySplit` import + invocation).
- `apps/holtburger-web/scene3d/bake_worker_client.js` — lines 375–406
  (`applyFetchConcurrencySplit`), constants at 68–69 (`DEFAULT_FETCH_CONCURRENCY = 32`,
  `WORKER_FETCH_SHARE_FRACTION = 0.25` ⇒ default split main 24 / worker 8), worker init
  message fields (grep, 846–851).
- `apps/holtburger-web/scene3d/bake_worker.js` — grep-verified init-message consumption
  (70–83: `__hbFetchConcurrency`, `__hbVerifyShards`, `__hbShardBudgetBytes` set on
  worker global).
- `apps/holtburger-web/src/global_source.rs` — grep-verified: one thread-local
  `Arc<ManifestResourceSource>` per wasm instance (44, 60–63).

## Decisions

### D-03.1 — Runtime chain: manifest → pinned index → CAS packs; catalogs deleted; sessions pin a bake

The client's only mutable fetch is `manifest.json` (v3, pass 2 S7). It names the HBSI1
index by content hash (`world_index: {url, size, sha256_16}`); the index names every pack
by content hash; packs name shared packs by hash in REFS. Everything below the manifest is
immutable-by-name. At boot the client fetches manifest → index, verifies the index against
the manifest's `sha256_16`, and **pins the session to that index**: every subsequent fetch
for the session resolves through the pinned index, even if the server re-bakes mid-session.
A re-bake is picked up on next reload (or by an explicit future "world updated" prompt —
out of scope). The per-namespace catalogs (`manifest/eor-*.bin`, 16.9 MB [M, pass 2]) and
`boot.hba` are not fetched at all on the new path; `catalog_version` (v2.rs:204–208) has no
new-path consumer.

Skew rule: a 404 on an index-listed pack is **never** "doesn't exist" — the index
authoritatively lists it — it is deploy skew or corruption, handled per D-03.8. This kills
the 404-silent-skip class (today's convention-URL mode treats 404 as "no record",
manifest_source.rs:762–769 — correct for per-record probing, and exactly the mechanism
behind the silent-empty-world incidents when a layer went missing).

*Rationale:* pinning gives coherent worlds for free (mixed-bake rings are impossible by
construction) and makes the retention contract explicit (S6.4). *Rejected:* live re-index
mid-session (invalidates pass 6's residency assumptions and re-opens mixed-bake rendering);
keeping `catalog_version` polling (its only purpose was catalog staleness, and catalogs
are gone).

### D-03.2 — Granularity: whole-pack fetch, no Range requests in v1; full-tier textures stay per-record

Every pack is fetched whole. Rationale, in order of force: (1) integrity — the pack hash
is over the full file bytes (pass 2 S2), so a ranged read cannot be verified; (2) measured
sizes make ranges pointless — tile packs p50 ~4 KB / p90 ~50 KB / p99 ~600 KB [M, pass 2
S1.4], commons ≤2.1 MB; (3) Range interacts badly with caches and encodings (serve.py
already refuses to compress ranged responses, serve.py:511, and CDN range-caching is
inconsistent). HBP1's section offsets keep ranged section reads *possible* later; v1 does
not use them. Full-tier texture payloads remain per-record CAS files exactly as pass 2
D-02.1 fixed (median 242 KB [M]) and ride the fetch scheduler's lowest lane (S2).

*Rejected:* ranged section reads for preview-only tile-pack consumption (saves little at
p50 4 KB, breaks hash-on-receipt); per-section files (re-creates request fan-out I1 kills).

### D-03.3 — One fetch authority: a main-thread JS `PackFetchController`; wasm instances never fetch packs

All pack/index/texture-file fetches go through **one** JS module (`scene3d/pack_fetch.js`,
the `PackFetchController`), living on the main thread. Wasm instances consume bytes pushed
into them; they do not own fetch machinery for the new path. Consequences, against
read-verified current state:

- The per-instance semaphore split — 32 total divided 24 main / 8 worker
  (concurrency.rs:19–29, 49; bake_worker_client.js:68–69, 383–406) — is deleted with the
  legacy lane. One scheduler, one budget, no `applyFetchConcurrencySplit`, no
  `__hbFetchConcurrency*` forwarding through the worker init message (bake_worker.js:70–83).
- The duplicated resident state is deleted: today each instance holds its own parsed
  catalogs (~19 MB parsed for eor/cell alone per instance [M, survey §2]) and its own
  shard cache (measured ~58 MB main + ~21 MB worker over four towns, shard_cache.rs:8–11).
  New: pack bytes are resident **once**, owned by the main instance's Rust `PackStore`
  (residency budget and eviction are pass 6's; the distribution contract is mine — S1.3).
- The bake worker receives, per bake job, transferable copies of exactly the packs the job
  needs (tile + interior packs leased per job and dropped at job end), plus a small
  worker-resident commons set ({CORE, META-COMMONS, ENV-COMMONS, current-supergrid
  regionals} ≈ ≤6 MB class [D from pass 2 pack sizes]). Bounded duplication by
  construction, vs today's unbounded two-cache ratchet.

Why main-thread JS and not a fetch worker: `fetch()` issue/completion is cheap; the two
measured main-thread costs of the old path were per-shard wasm sha256 (71% of main thread
in the r10 probe [M, manifest_source.rs:98–99]) and per-record fan-out — both are gone
(D-03.5 moves hashing to `crypto.subtle`; packs are ~50 requests, not ~1,700). The
controller is written message-shaped (async, transferable-friendly) so it can relocate
into a worker without API change if pass 10's measurements show residual main-thread cost
[A, escape hatch named]. This does not pre-empt pass 6's single-vs-dual wasm decision
(charter H5): the contract is "one fetch authority + leases", which is valid for one or
two wasm instances.

*Rejected:* fetch in the bake worker (adds a mandatory hop for every main-instance record
read, and main's `ResourceSource` reads are sync — lib.rs:157–175 — so main must hold
resident bytes anyway); both-instances-fetch-disjoint-sets (keeps the split machinery and
duplicates in-flight bookkeeping; today's design is the evidence it breeds defect classes
— defects 3/4 in manifest_source.rs:70–78, 102–107 existed because two instances each ran
fetch state).

### D-03.4 — Scheduler: one priority queue, four lanes, promotion instead of bypass

The controller runs a single FIFO-within-lane priority queue with a global in-flight cap.
Lanes, highest first:

| lane | contents | browser `priority` | in-flight guarantee |
|---|---|---|---|
| U — urgent | player-blocking: current-tile pack, current-LB interior pack + its ENV deps | `high` | 4 reserved slots (cap may be exceeded up to +4 for U) |
| B — boot-critical | manifest, index, CORE, META-COMMONS, spawn tile packs, PVW-COMMONS (in S3 order) | `auto` | normal |
| R — ring prefetch | resident-ring tile/interior packs by tile distance, regional/preview-regional packs, movement lookahead | `low` | normal |
| T — texture full-tier | per-record full-tier texture files (pass 5's lazy path) | `low` | ≤4 of the cap |

Numbers: global in-flight cap **12**, urgent reserve **4**, T-lane sub-cap **4** — all
[A, assumed-pending-measurement], sized to the new request population: a whole cold boot
is ~53 requests and a crossing ~5–9 (S8), so a deep queue has nothing to hold; at T3 the
line is bandwidth-bound and >4-way parallelism buys only RTT overlap; on the dev server
HTTP/1.1's 6-connection cap binds anyway (serve.py:461–467). `?fetchCap=N` is the tuning
escape (host-side global, same pattern as today's hooks).

Urgent semantics change from **bypass** to **promotion**. Today urgent skips the semaphore
AND deduplicates under a distinct `urgent:{url}` key, accepting a duplicate fetch per
record (manifest_source.rs:723–757) — harmless at 261 B/record, unacceptable at 600 KB/pack.
New rules: (a) a queued request found needed-urgently is promoted to lane U in place
(possible because the queue is ours — today's failure was FIFO order inside the *browser's*
queue, which we no longer flood); (b) an already-in-flight request is latched, never
duplicated — at pack sizes the remaining transfer time is the fetch, a duplicate cannot
beat it; (c) an urgent request beyond the cap uses the 4 reserved slots. The starvation
this lane exists for — `fetchEnvCellsInLandblock` starved for minutes behind the ring
flood (manifest_source.rs:382–394) — was a symptom of 1,700-deep browser queues; with ≤12
in flight and ~50-request boots the structural cause is gone, and promotion covers the
residue.

*Rejected:* keeping semaphore-bypass + duplicate-fetch (cost now scales with pack size);
per-lane independent semaphores (re-creates the split-budget accounting this pass deletes);
relying on browser `fetchpriority` alone with no own queue (unordered within priority
class; promotion impossible — this is the current design's documented failure,
http.rs:50–55).

### D-03.5 — Integrity: hash-on-receipt per pack via `crypto.subtle`, off the critical thread; per-shard sha256 deleted

- **What verifies:** every CAS object on receipt — index (against the manifest's
  `sha256_16`), every pack, every full-tier texture file (against its name). The name IS
  the expected digest (truncated sha256-16, pass 2 D-02.3). HBP1's CRC32 footer is a
  decode-time corruption backstop, not the integrity gate.
- **When:** after body read, before the bytes are handed to any consumer or admitted to
  the PackStore. Verification is async and overlaps the next fetch; nothing renders from
  unverified bytes.
- **How:** `crypto.subtle.digest("SHA-256", buf)` — browser-native, asynchronous, not
  main-thread JS time. **Secure-context caveat** [verified constraint, not measured]:
  `crypto.subtle` exists only in secure contexts. `localhost` dev qualifies; the 1070
  driven over plain `http://` on a tailnet IP does NOT. Fallback: a wasm sha256 call in
  whichever worker context exists (bake worker today) — never on the main thread. The
  controller feature-detects once at boot and logs which engine it uses.
- **Cost class [D]:** boot ≈ 18 MB (pass 2 B1') hashed once ≈ tens of ms at native-hash
  throughput, overlapped with a 3.6-minute T3 download — ≥3 orders below the transfer
  itself. Crossing ≈ 0.11–0.56 MB/column [M, pass 2 S1.5] ⇒ sub-ms-to-few-ms class per
  column. Versus the deleted cost: per-shard verify measured at ~71% of main-thread time
  over ~25 MB/~2 k shards in the r10 probe [M, manifest_source.rs:94–101]. The win is
  structural (50 hashes off-thread vs 2,000 on-thread), not a tuning of the same cost.
- **Policy:** verify is ALWAYS ON — there is no `__hbVerifyShards`-style skip for packs,
  because the measured reason for that hook (main-thread fill CPU) no longer applies.
  `?packVerify=off` exists as a diagnostic escape only (house rule: default-ON with
  escape), and a session with it set taints its diag surface (S9).
- **On mismatch:** treated as fetch failure; one immediate retry with `cache: "reload"`
  (bypasses a truncated/corrupt HTTP-cache body without breaking the CAS URL), then lane's
  failure policy (D-03.8). Mismatch counters are published on the diag surface — a nonzero
  steady rate is a hosting bug, and it must be visible, not absorbed.

*Rejected:* trusting immutable-cache + TLS with no receipt hash (silent CDN truncation and
disk-cache corruption are real; the boot.hba connect-time verify exists for the same
reason, manifest_source.rs:500–507); verifying lazily at first decode (moves the failure
to a player-visible moment and inside pass 6's residency machinery); keeping per-record
hashes anywhere (pass 2 D-02.3 measured them worthless — 0.00 MB dedup — and deleted them).

### D-03.6 — HTTP contract: three header classes, identity encoding for CAS, `no-transform`; dev server gains one rule

Normative header table (S6). The three classes: **mutable pointer** (`manifest.json` —
`no-cache`, revalidated every load), **immutable CAS** (`index/`, `packs/`, texture files —
`public, max-age=31536000, immutable, no-transform`, served identity), **app shell**
(stable-name JS/wasm/HTML — `no-cache` revalidate, transport-compressed). This extends the
two precedents read this session — serve.py's shards-immutable rule (serve.py:615–616) and
proxy.cjs's identical production header (proxy.cjs:73, 87) — to the new CAS paths, and
adds `no-transform`, which today's rules lack: a CDN or middlebox that re-encodes a pack
breaks hash=bytes (the same invariant that made pass 2 reject `Content-Encoding` on packs,
D-02.2). The KTX2 identity sniff (serve.py:394–404) becomes unnecessary for the new path
by construction — packs are internally zstd-compressed and served identity; the sniff
stays only while legacy shards are served. CDN requirements beyond headers: HTTP/2+
(53-request boot on h1's 6 connections works but serializes; h2 removes the constraint),
TLS (also unlocks `crypto.subtle`, D-03.5), CORS + `Timing-Allow-Origin` if the CDN is a
separate origin, and honoring `no-transform`. serve.py needs exactly one addition for
migration: the `packs/`+`index/` immutable-identity rule (pass 9 lands it; R3 forbids me
touching it now).

*Rejected:* hashed-filename app shell in this pass (worthwhile, but it is a build-system
change, not wire spec — recorded as an open question); serving packs zstd
`Content-Encoding` (breaks hash=bytes and Range; pass 2 already rejected).

### D-03.7 — Progressive delivery: milestone-ordered waves, preview-first, previews after in-world

Boot fetch order (S3) is arranged so the charter's milestones land in sequence on a T3
line: everything needed for `in-world` (code, manifest+index, CORE, spawn-area tile packs,
META-COMMONS + regionals) is queued ahead of the preview packs; `preview-complete` gates
on PVW-COMMONS + PVW-regionals + ring tile packs; `converged` is lane-T background work.
Arithmetic (S8.1): in-world ≈ 8.4 MB ≈ 1.7 min at T3 [D], preview-complete ≈ 17.6 MB
(current preview tier) / ≈ 10.9 MB (pass-5 128² boot tier) [D, pass 2 S6.1] — the player
is walking a texture-preview world while the rest streams, instead of staring at a loading
screen for the full 22-minute current-path boot [M, charter]. Within a wave, tile packs
are queued by Chebyshev tile distance from the player (nearest first), so partial progress
is always the nearest-first prefix.

*Rejected:* previews before in-world (previews are radius-invariant commons-dominated
[M, pass 2 S1.2] — front-loading them delays playability by ~2 min at T3 for pixels the
player can't see yet); interleaving full-tier textures into boot (B4 is a background
budget; lane T exists so convergence can never displace playability).

### D-03.8 — Prefetch radius: resident ring at boot, +1 tile directional lookahead while moving

At boot: fetch exactly the resident ring's tiles (11×11 LB ⇒ 36 tile packs at 2×2), no
margin — B2 has no room for a speculative border (36 + margin-ring 28 = 81 > 64). While
moving: when the resident ring admits a new tile row/column (edge crossing), the
controller also enqueues (lane R) the **next** tile row/column beyond it in the movement
direction — a 1-tile (192 m) directional lookahead, adopting and refining pass 2 H-02.1's
proposed default. Arithmetic (S8.2): lookahead depth needed at T3 is worst-column transfer
time (0.56 MB ⇒ 6.7 s [M+D, pass 2 S1.5]) vs column traversal time (≥27 s at the charter's
assumed 4–7 m/s [A]) ⇒ one column of lookahead carries ≥4× margin worst-case, ≥20×
typical; C5 holds without velocity-adaptive machinery. Interior packs prefetch at ring
admission (lane R) and promote to lane U when the player's LB is the interior's LB.

*Rejected:* symmetric +1 ring always (≈2× the fetched frontier for direction the player
isn't going; bytes are cheap but T3 bandwidth is the C5 resource being budgeted);
velocity-scaled lookahead (complexity without a failing number to fix — revisit only if
pass 10's throttled walk bench breaks C5).

### D-03.9 — Offline/SW: the trap class is eliminated structurally; SW v3 caches only CAS URLs, never intercepts the manifest or app code

The documented trap ("SW serves stale content across restarts; only `?nosw=1` clears") is,
read against the current worker, a property of **bake-versioned URLs** — same URL,
different bytes across bakes (`boot.hba`, `manifest/*.bin`) — which required the
bake-identity gate (service-worker.js:130–165, 281–291) to make cache-first survivable.
The new chain has exactly ONE mutable URL, `manifest.json`, and the SW must simply never
serve it from cache (except as an explicit offline fallback, below). Spec for SW v3
(cache name `holtburger-content-v3`; the activate-step prefix GC,
service-worker.js:109–128, purges v2):

- Intercepts ONLY: `packs/`, `index/`, full-tier texture CAS paths, `/scene3d/assets/`
  (keeps today's SWR treatment, service-worker.js:300–303). Cache-first-forever for the
  CAS paths — sound by the same "path ⇒ bytes" invariant the current worker states for
  shards (service-worker.js:162–165).
- NEVER intercepts: `manifest.json`, HTML, JS, wasm — code freshness is the HTTP cache's
  revalidation contract (serve.py:617–632), so the "edited JS but SW served stale"
  failure cannot occur; `?nosw=1` (index.html:2565–2604) is retained as the hard bypass
  but the daily loop should not need it.
- The bake-identity gate machinery is DELETED, not ported — there are no bake-versioned
  URLs left to gate. This is the structural fix; the gate was compensation.
- Offline: network failure on `manifest.json` → the page may use a `last-known-manifest`
  copy the CONTROLLER (not the SW) stashes in Cache Storage after each successful boot,
  clearly flagged in the UI as "offline — world as of <generated_at>". Pinning (D-03.1)
  plus CAS caching means a previously-booted region is fully replayable offline. This
  mirrors the current worker's explicit offline stance (service-worker.js:358–370) but
  moves the decision out of the fetch interceptor into boot logic, where it can show UI.
- Quota/eviction: Cache Storage is a cache, not a store — eviction of a pack is identical
  to a cold miss (refetch). No correctness dependency on SW persistence, ever.

Warm-boot budget B5 is met **without** the SW: manifest revalidation (1 request, ~1 KB
304) + everything else immutable-HTTP-cached (0 requests) = 1 request [D] ≤ B5's ≤5 req /
≤1 MB. The SW's only jobs are offline and durability beyond HTTP-cache eviction.

*Rejected:* porting the bake-identity gate (dead weight — nothing left to gate); SW-caching
the app shell for offline app-start (reintroduces exactly the staleness class being
eliminated; offline *app* start is out of scope, offline *world* is in); no SW at all
(loses offline and long-horizon durability for zero simplification — the v3 worker is
~⅓ of the current one).

### D-03.10 — Failure/retry semantics per pack kind; legacy per-record lane retained for non-world content

Normative matrix in S7. Headlines: index-listed 404s are loud deploy-skew errors, never
silent skips (D-03.1); boot-critical failures after 3 retries are a boot error banner
(CORE/META) or a degraded-with-banner start (PVW — placeholder material + background
retry, honoring N1 by being visible, not silent); tile/interior failures quarantine the
tile with timed re-eligibility and proximity-triggered urgent retry; hash mismatches count
as failures with a `cache: "reload"` first retry. Retry counts: 3 attempts with 1 s/3 s
backoff — same count the walk loop uses today (`PREFETCH_ROUND_TRIES = 3`,
prefetch.rs:133), which the record shows sufficient for the tunnel-hiccup class
(prefetch.rs:400–410).

The **legacy per-record lane** (charter D-01.7/I1 "MAY remain") is retained during and
after migration for content the packs do not carry: equipment/clothing substitution
records (unbakeable per charter I2-kept), other-player appearance, admin-spawned content,
and — until pass 2 Q5's walk-widening lands — MotionTables/PhysicsScripts/sounds. It is
today's machinery unchanged (`ManifestResourceSource` + catalogs-on-demand + walk loop +
R-9 partial rounds), with two boundary rules: (a) its concurrency budget becomes a fixed
small share (8) UNDER the controller's global cap so the two systems cannot compound
floods [A]; (b) it remains per-instance during migration (the 24/8 split and worker
forwarding stay until the legacy lane is worldload-free, then shrink to main-only). Its
per-shard sha256 verify stays default-ON at this population (~equipment-sized, not
ring-sized — the 71% figure was a full-ring population [M]).

*Rejected:* deleting the legacy lane at cutover (equipment has no pack home by design —
charter D-01.7 keeps its runtime decode); widening packs to cover all dynamic content
(unbakeable per-character state; settled by charter I2).

## Spec

### S1 — Architecture: modules and data flow

```
                         ┌───────────────────────────────────────────────┐
   manifest.json ──────► │ PackFetchController (JS, main thread)         │
   index/{h}.bin  ─────► │  · session pin {manifest, index}              │
   packs/xx/{h}.hbp ───► │  · 4-lane priority queue, cap 12 (+4 U)       │
   tex CAS files ──────► │  · inflight latch/promote (no dup fetches)    │
                         │  · verify: crypto.subtle / worker-wasm sha    │
                         └───────┬───────────────────────┬───────────────┘
                                 │ verified ArrayBuffer  │ per-job lease (transfer/clone)
                                 ▼                       ▼
                  main wasm: PackStore            bake worker wasm:
                  (resident pack bytes, once;     commons-resident set (≤6 MB class)
                   budgets/eviction = pass 6)     + leased tile/interior packs
                                 │                 (dropped at job end)
                                 ▼
                  PackSource : ResourceSource  ──► existing fetch_* exports, sync reads
                  CompositeSource = PackSource → legacy ManifestResourceSource (fallback)
```

**S1.1 `PackFetchController` (new, `scene3d/pack_fetch.js`).** Owns: session pin, lane
queue, in-flight map (latch + promote), verification, retry/quarantine state, diag
surface (S9), the offline manifest stash (D-03.9). API shape (implementable contract):
`boot(manifestUrl) → {manifest, index}`; `need(packHash, lane) → Promise<ArrayBuffer>`
(idempotent; latches/promotes); `needTexture(rsId, sha) → Promise<ArrayBuffer>` (lane T);
`setPlayerTile(x, y, heading)` (drives D-03.8 ring/lookahead enqueues);
`leaseForJob(hashes[]) → Transferable[]` (worker job supply). All returns are verified
bytes or a typed error from the S7 matrix.

**S1.2 Index consumption.** HBSI1 (~0.5 MB [D, pass 2 S4]) is parsed once in JS (flat
typed-array views over the pack table + 128×128 u16 tile grid — O(1) tile→pack, binary
search interior→pack) and mirrored into each wasm instance once at init (a single ~0.5 MB
copy; three orders under M1). JS owns fetch decisions; wasm owns record resolution inside
resident packs.

**S1.3 `PackSource` (new, in `holtburger-resource-http` or sibling crate), behind
`ResourceSource` (lib.rs:157–196).** `insert_pack(bytes)` admits a verified pack;
`get_file_by_key` resolves (ns, file_id) → owning pack (tile grid / interior table /
REFS) → RECORDS/ENVCELLS section → record slice (sections lazily decompressed per pack,
decompressed-section cache refcounted — budget owned by pass 6). Reads stay sync, so
every existing `fetch_*` export works unchanged — the migration seam the survey requires
(§5). `key_known_absent` = true iff the owning pack is resident and lacks the record
(same provability contract as today, lib.rs:185–195; a non-resident pack proves nothing).
`CompositeSource` tries `PackSource` first, then the legacy source — world content served
from packs from day one of migration while equipment rides the legacy lane (D-03.10).

**S1.4 The walk loop's fate.** For pack-served content the discovery loop
(`run_walk_loop`, prefetch.rs:341–440) never fires: closure is bake-time (`--verify-closure`
guarantees REFS resolve, pass 2 S5.7), so by the time a bake job runs, every record it
can ask for is resident and reads are sync hits. The loop remains compiled and live for
the legacy lane only, and is deleted with it (S10).

### S2 — Scheduler rules (normative)

1. One global queue; dequeue order: U > B > R > T; FIFO within lane; T additionally
   sub-capped at 4 in flight.
2. In-flight cap 12; lane U may exceed to 16 (4 reserved urgent slots). All [A], with
   `?fetchCap=N` escape; pass 10 owns the tuning measurement.
3. Dedup: one in-flight entry per URL. A `need()` at higher lane **promotes** a queued
   entry; an in-flight entry is latched, never re-fetched (D-03.4). Error entries are
   removed on completion so transients don't latch (the inflight.rs:32–34 invariant,
   kept).
4. Browser `priority` member per lane (U/B `high`/`auto`, R/T `low`) — belt-and-braces
   under the browser's own connection scheduling, same mechanism as today
   (http.rs:66–77) but set from JS directly.
5. Backpressure: `setPlayerTile` re-sorts lane R by current tile distance; packs that
   left the ring before being fetched are dequeued (never fetched-then-dropped).

### S3 — Boot sequence (waves; serial depth 3, tail 4)

- **Wave 0** (parallel with code/wasm): `manifest.json` → `index/{h}.bin` (2 serial
  steps; index verified against manifest hash).
- **Wave 1** (lane B, parallel, ordered within lane): CORE → spawn tile pack (urgent-
  equivalent head of lane) → META-COMMONS → regional META packs for the ring's supergrid
  cells (computable from the index's shared directory + player position — no discovery
  round trip) → remaining ring tile packs by tile distance → interior pack for spawn LB
  if any.
  ⇒ `in-world` gate: spawn tile + CORE + its REFS-reachable meta resident.
- **Wave 2** (lane B tail): PVW-COMMONS → PVW-regional for the ring.
  ⇒ `preview-complete` gate (charter D-01.2 definition).
- **Wave 3** (lane T, background): full-tier textures for the ring per pass 5's policy.
  ⇒ `converged`.
- Depth-4 tail: a REFS edge naming a shared pack the wave-1 planner didn't predict (rare
  by construction — the planner enumerates regional packs from the index) fetches on
  discovery-at-parse: serial depth 4 = B3 budget, not exceeded.

### S4 — Crossing sequence

On resident-ring edge crossing (pass 6 owns the residency event; the controller subscribes):
new row/column tile packs (lane R, distance-sorted) + their interior packs (lane R) +
lookahead row/column (lane R, D-03.8) + any regional META/PVW packs for newly-touched
supergrid cells (lane R). Player enters an interior-bearing LB: that interior pack + ENV
deps promote to lane U. No per-crossing catalog, sidecar, or discovery traffic exists.

### S5 — Integrity summary (what verifies, when, cost class)

| object | verified against | when | engine | cost class |
|---|---|---|---|---|
| index | manifest `sha256_16` | on receipt, boot | subtle/worker-wasm | ~0.5 MB, sub-ms class [D] |
| pack (all kinds) | its CAS name | on receipt, pre-admission | subtle/worker-wasm | boot ≈18 MB ⇒ tens of ms off-thread, overlapped [D] |
| full-tier texture file | its CAS name | on receipt | subtle/worker-wasm | median 242 KB ⇒ sub-ms class [D] |
| pack sections | HBP1 CRC32 footer + zstd frame checks | at first section decompress | wasm decode path | decode-time backstop, not a gate |
| legacy shards | catalog trunc-sha16 | unchanged (manifest_source.rs:810–826) | wasm, in-instance | small population post-migration (D-03.10) |

Deleted: per-shard sha256 for world content (the 71%-main-thread cost [M]) and its
`__hbVerifyShards` escape hook.

### S6 — HTTP/CDN contract (normative)

**S6.1 Headers by path class:**

| path | Cache-Control | encoding | notes |
|---|---|---|---|
| `manifest.json` | `no-cache` | gzip/br negotiable | ETag/Last-Modified required; the ONLY mutable data URL |
| `index/{hash16}.bin` | `public, max-age=31536000, immutable, no-transform` | **identity** | hash-dominated, ≈incompressible [M, pass 2] |
| `packs/{p2}/{hash16}.hbp` | `public, max-age=31536000, immutable, no-transform` | **identity** | internal per-section zstd (pass 2 D-02.2) |
| full-tier texture CAS files | `public, max-age=31536000, immutable, no-transform` | **identity** | BC7/XU7 ≈ incompressible; KTX2 sniff obsolete here |
| app shell (HTML/JS/wasm, stable names) | `no-cache` | gzip/br | today's revalidate tier (serve.py:617–632) |
| legacy `shards/`, `manifest/*.bin`, `boot.hba` | unchanged | unchanged | until pass 9 retires them |

**S6.2 CDN requirements:** HTTP/2 or 3 (recommended; 53-request boot survives h1 but
serializes over 6 connections); TLS (required for `crypto.subtle`, D-03.5); MUST honor
`no-transform` (hash=bytes); `Vary: Accept-Encoding` only on negotiated types (serve.py
precedent, :606–607); if cross-origin: `Access-Control-Allow-Origin` for the app origin +
`Timing-Allow-Origin` (pass 10's wire benches need resource timing).

**S6.3 Dev server:** serve.py needs exactly one new rule (immutable+identity for
`packs/`+`index/`, mirroring its :615–616 shards rule); its Range-refusal (:511) and
compression negotiation (:339–405) are untouched. Pass 9 lands it (R3).

**S6.4 Retention:** the host MUST retain the previous bake's index + packs alongside the
current one (CAS: unchanged packs are shared bytes, cost ≈ one bake's churn). Guarantees
pinned sessions (D-03.1) survive a mid-session deploy. Bake tooling owns GC of
older-than-N−1 (pass 9 handoff).

### S7 — Failure/retry matrix (normative)

Common: "retry ×3" = attempts at 0 s/1 s/3 s; hash-mismatch first retry uses
`cache: "reload"`; every terminal failure increments a named diag counter (S9) and logs
one console error (not per-retry spam — the prefetch.rs:104–115 noise lesson).

| object | on failure after retries | 404 meaning | recovery trigger |
|---|---|---|---|
| manifest.json | boot: error banner (offline path per D-03.9). in-session refresh: keep pin, retry 60 s | hosting broken — error banner | timer |
| index | re-fetch manifest once (skew race), then boot error | deploy skew — loud | manifest re-fetch |
| CORE / META-COMMONS / regional META | boot error banner (world cannot render honestly) | deploy skew — loud | user reload |
| PVW packs | enter world DEGRADED: placeholder material + visible banner; background retry 30 s | deploy skew — loud | timer |
| tile pack | tile quarantined 60 s (not resident, not rendered-as-empty); re-eligible on timer or ring re-admission | deploy skew — loud (NEVER "empty tile" — the anti-"0 placements" rule) | timer / proximity |
| interior pack (player inside) | lane U retry 5 s loop + banner (player-blocking) | deploy skew — loud | timer |
| full-tier texture file | stay at preview tier; retry on next lane-T pass | deploy skew — loud, counted | lane-T revisit |
| legacy per-record shard | unchanged: R-9 partial rounds + 3-try walk rounds (manifest_source.rs:216–226; prefetch.rs:400–437) | record absent (catalog-gated, legitimately silent) | next walk |

### S8 — Budget arithmetic (charter traceability)

**S8.1 Boot (B-series, T3).** Requests [D]: 1 manifest + 1 index + ~10 code/wasm + 1 CORE
+ 1 META-COMMONS + ~2 regional + 36 ring tiles + 1 PVW-COMMONS + ~1 PVW-regional ≈ **54 ≤
B2 64** ✓ (pass 2 S6.1 concurs at 53; the delta is PVW-regional counting). Serial depth:
manifest → index → waves-in-parallel = **3**, REFS-miss tail 4 = **≤ B3 4** ✓. Bytes:
in-world ≈ 4.8 (code [M, charter]) + 0.5 (manifest+index [D, pass 2 S4]) + ~1.0 (CORE) +
~0.9 (ring tiles) + ~1.2 (meta) ≈ **8.4 MB ≈ 1.7 min at T3** [D]; preview-complete adds
9.2 MB previews ⇒ ≈ 17.6 MB now, ≈ 10.9 MB with pass 5's 128² boot tier — B1'/B1 exactly
as pass 2 restated (H1 honored; no new restatement needed). **B5** [D]: manifest
revalidate = 1 request ~1 KB; index + packs immutable-cached = 0 requests ⇒ **1 req /
~1 KB ≤ ≤5 req / ≤1 MB** ✓ — met with no SW (D-03.9).

**S8.2 Crossing (C-series).** C1 [D]: ~3 admitted tiles + ~3 lookahead tiles + ≤2
regional + ≤1 interior ≈ **9 ≤ 12** ✓. C2: mean 0.11 / max 0.56 MB per column [M, pass 2
S1.5] ≤ 1.5 MB ✓. C3 [D]: revisited territory = immutable HTTP cache hits ⇒ **0 network**
✓ (residency side is pass 6's C5-complement). C4: per pass 2 S6.2 (~1.5 MB median
first-ever) ✓ with the max-preview-dungeon caveat owned by pass 5. C5 [D]: worst measured
column 0.56 MB ⇒ 6.7 s at 83 KB/s vs ≥27 s/column travel, 1-column lookahead in front ⇒
≥4× worst-case margin ✓ (D-03.8).

**S8.3 Main-thread wire cost.** Deleted from the main thread: per-shard sha256 (~71% of
main thread in the r10 probe [M]), catalog parse (16.9 MB → 0), per-record fetch
bookkeeping at 1,700-request scale, walk-loop re-decodes (≤8 rounds × full decode,
prefetch.rs:375). Added: ~54 fetch completions + queue ops (hundreds-of-µs class per
event [A]) + hashing off-thread. Net direction is unambiguous; pass 10 measures the
residual (fetch-controller escape hatch named in D-03.3).

### S9 — Diag contract (minimal; pass 10 owns the full spec)

`globalThis.__hbFetch` (main thread, one object — replaces the per-instance
`__hbShardCache` publishing pattern for the new path): `{lane: {queued, inflight, done,
failed} × U/B/R/T, verify: {engine: "subtle"|"wasm", ok, mismatch}, retries, quarantined:
[tileIds], pinnedIndex: hash16, milestones: {inWorldMs, previewCompleteMs}, taint:
["packVerify=off", …]}`. Counters are cumulative per session; every S7 terminal failure
increments exactly one of them.

### S10 — Deletion ledger (what this pass removes, with its evidence anchor)

| deleted | anchor |
|---|---|
| namespace catalogs as a fetch/parse/residency cost (16.9 MB wire, ~19 MB parsed ×2 instances) | pass 2 [M]; survey §2 |
| per-shard sha256 + `__hbVerifyShards` hook (world content) | manifest_source.rs:94–118 |
| per-record GETs + walk-loop discovery for world content | prefetch.rs:341–440 |
| fetch-concurrency split (`applyFetchConcurrencySplit`, worker forwarding, per-instance semaphores) | concurrency.rs:19–29; bake_worker_client.js:383–406 |
| urgent semaphore-bypass + `urgent:{url}` duplicate fetches | manifest_source.rs:723–757 |
| duplicated per-instance shard caches (~58+21 MB ratchet) | shard_cache.rs:8–11 |
| `boot.hba` fetch + connect-time whole-pack verify | manifest_source.rs:496–509 |
| SW bake-identity gate (nothing bake-versioned left to gate) | service-worker.js:130–291 |

All deletions land at legacy-lane retirement (pass 9's staging); the legacy lane itself
persists for non-world content per D-03.10.

## Handoffs to later passes

- **H-03.1 (→ pass 4):** GEOM section consumption — pass 4's decode reads GEOM payloads
  from resident packs via `PackSource`-adjacent typed access (not `ResourceSource` record
  reads); the wasm→JS transferable contract for decoded geometry is pass 4's, but the
  "bytes are already resident and verified when decode runs" guarantee is established
  here (S1.4). Also: per-model bounds (pass 2 H-02.2) affect nothing in this pass.
- **H-03.2 (→ pass 5):** Lane-T policy: which full-tier textures to request, in what
  order, under what VRAM/byte budget — this pass provides only the lane (sub-cap 4, lowest
  priority) and the per-file CAS verify. The boot preview tier decision (B1 12 vs 18 MB)
  is unchanged from pass 2 H-02.3. PVW failure degradation (placeholder material) needs
  pass 5's material story to be concrete.
- **H-03.3 (→ pass 6):** PackStore residency: budgets, refcounts, eviction, and the
  ring-crossing events the controller subscribes to (S4). Proposed default: pack-resident
  bytes evict with their tiles (pass 2 H-02.4); the controller's quarantine state (S7)
  must be consulted so eviction doesn't erase failure bookkeeping. Also the
  worker-resident commons set (≤6 MB class) and per-job lease lifetimes (D-03.3) fold
  into M3 accounting; single-vs-dual wasm (charter H5) remains pass 6's call — this
  pass's contract is topology-neutral (D-03.3).
- **H-03.4 (→ pass 9):** Migration staging: CompositeSource fallback order flag; serve.py
  `packs/` header rule; SW v2→v3 swap timing; legacy-lane retirement criteria (worldload
  = 0 on the legacy lane for a full bench route); dist retention GC (S6.4); the
  `?nosw=1`-class doc updates (walls: verdicts must reach the files agents read).
- **H-03.5 (→ pass 10):** Emulated-666 kbps boot bench scoring S8.1's per-wave
  attribution (per-component, not totals — pass 2 H-02.6 concurs); fetch-cap tuning
  (cap 12 / reserve 4 / T-cap 4 are [A]); the S9 diag surface's full spec; a 5-minute
  `crypto.subtle` availability + throughput probe on the 1070 (secure-context question,
  D-03.5); main-thread residual cost of the controller (escape: relocate to worker).

## Self-check

- **Walls — scale confusion:** every count states its population (requests vs bytes vs
  packs vs records; resident vs leased vs transient in D-03.3). PASS.
- **Walls — draws×µs / draw-count proxy / 70 ns glue / GPU-on-CPU-bound / parked-vs-moving
  / allocated≠used:** no frame or draw figure appears in this pass; memory figures state
  resident-vs-transient. PASS (mostly N/A by scope).
- **Walls — boot variance:** no boot timing is claimed measured here; S8.1's minutes are
  derived bandwidth arithmetic labeled [D], and validation is explicitly pass 10's
  (H-03.5) with its interleaving rules. PASS.
- **Walls — flag-bit ≠ predicate:** the new flags defined here (`?fetchCap`,
  `?packVerify`) are speced with explicit-value semantics and a diag `taint` list (S9);
  no `!== "off"` inversion pattern. PASS.
- **R1:** read order followed; no prior-pass decision contradicted — D-03.8 refines pass 2
  H-02.1's *proposed default* (radius 1, directional), which is the mechanism handoffs
  exist for, not a supersede. B1 arithmetic inherited from pass 2 unchanged. PASS.
- **R2:** residency budgets/eviction (pass 6), texture tiers/lane-T policy (pass 5), GEOM
  decode (pass 4), migration staging (pass 9), bench mechanics (pass 10) all deferred
  with proposed defaults. PASS.
- **R3:** writes = this file + own TRACKING.md row. serve.py/SW changes are speced, not
  made. PASS.
- **R4:** every current-code claim carries file:line opened this session (see Inputs
  read); the wasm-crate trap avoided (global_source.rs cited from the real
  `apps/holtburger-web/src/`); the `?nosw` trap re-derived from the ACTUAL current worker
  rather than memory — notably the current SW does NOT intercept index.html/JS
  (service-worker.js:310–314), which narrows the trap to the bake-versioned-URL class
  D-03.9 eliminates. PASS.
- **R6:** six sections in order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** concrete module names, API shape, lane table, header table, failure matrix,
  numeric caps with [A] labels and escapes, budget arithmetic shown. PASS.
- **R8:** unsettled items (cap tuning, subtle-crypto on the 1070, controller residual
  cost, hashed app-shell names, h2 availability) declared below, not guessed. PASS.

## Open questions

- **Q1 — `crypto.subtle` on the 1070 rig.** Plain-http tailnet origins are not secure
  contexts; the fallback (worker-wasm sha256) is speced but unproven at pack sizes.
  Needs the 5-minute probe (H-03.5) before the fetch controller's verify engine choice
  is final. [Owner: 1070 batch queue.]
- **Q2 — Cap numbers are assumptions.** In-flight 12 / urgent reserve 4 / T-cap 4 are [A]
  sized to the new request population; pass 10's throttled bench tunes them. The failure
  mode if wrong is mild (latency, not correctness) — but C5's margin math assumes the
  lookahead fetch actually starts promptly; verify under throttle.
- **Q3 — Hashed-filename app shell.** Moving JS/wasm to content-hashed names would make
  the app shell CAS too (immutable headers, offline app start, B5→0 requests). It is a
  bundler/build change outside this pass's writable scope; flagged for pass 9 or an
  owner call.
- **Q4 — Production hosting shape.** h2 availability, CDN choice, and whether the app and
  dist share an origin are deployment facts nobody has fixed yet; S6.2 states the
  requirements but cannot verify them against a host that doesn't exist. [Owner call.]
- **Q5 — Interior prefetch trigger fidelity.** "Promote interior to U when the player's
  LB is the interior's LB" may be late for fast dungeon entries through portals
  (teleport-class arrival). If pass 6's residency events include portal-destination
  hints, the controller should pre-promote on portal use — needs pass 6's event
  vocabulary. Proposed default recorded here; not settleable now.
- **Q6 — Legacy-lane concurrency share under the global cap.** The "8 under the
  controller's cap" coupling (D-03.10) requires the legacy Rust semaphore and the JS
  controller to agree on a shared budget during migration; the cheapest implementation
  (set `__hbFetchConcurrencyTotal = 8` once the pack lane is primary) is proposed but
  its starvation behavior for equipment bursts (119-spawn class, inflight.rs:5–10) is
  unmeasured.
