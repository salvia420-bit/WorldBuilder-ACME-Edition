# Wave 3 — Agent G: memory-leak defect classes + index/PDB tooling

Sources mined:
- `2013-09-11.4186-v3/11-memory-leak-investigation.md` (26 H2/H3, incl. §8b corrections)
- `2015-10-11.6096-v3/12-memory-leak-2015.md` (15 H2/H3/H4)
- Job 2: `2013-09-11.4186-v3/{INDEX.md, class_index.tsv, func_index.tsv, struct_index.txt}` + README's
  PDB line-information claim.

Read first and **extended, not restated**: `mining/wave0-palette-leak-patch.md` (PAL-01..04),
`mining/VERIFICATION-LOG.md`, `memory/holtburger-perf.md`, wave2-D's DAT-06/DAT-07.

Every holtburger citation below was opened, not grepped. Every claimed ABSENCE was established by
exhausting the symbol's hit list, and the hit count is stated so the check is reproducible.

---

## 0. Two findings that change how this whole file should be read

**(a) A live, open holtburger leak investigation is running right now, and it re-derived retail's
defect classes independently.** `docs/rynth-integration/A15-rss-decision-2026-07-20.md` records a
reproducible **~2.8 GB RSS crash every ~30 min of roaming**, attributed to
`WebAssembly.Memory` never returning pages to the OS. That is *verbatim* retail §4 ("system RAM is
never reclaimable… it converts every other defect from transient to permanent"). Separately,
`scene3d/entities.js:15184` `dispose()` carries a comment describing a bug they already found and
fixed — "the old loop disposed each rig's subtree but LEAKED the manager-side bookkeeping `remove()`
owns" — which is *exactly* retail Defect 2 (`DestroyObjects` calls slot 0 only). Two of retail's
three defect classes have already bitten this client. That is the strongest possible evidence the
classes generalise, and it is the main analytical result of Job 1.

**(b) Every heap number in this repo older than 2026-07-26 is suspect, and the leak harnesses the
prompt named as precedent are among the casualties.**
`docs/rynth-integration/RETRACTION-jsheap-step-2026-07-26.md` proves `performance.memory
.usedJSHeapSize` is quantized onto a ~100-rung ladder **and cached for 20 minutes** without
`--enable-precise-memory-info`. The shared harness was fixed the same day
(`apps/holtburger-web/harness/lib/boot.mjs:212`), but two standalone launchers were not:
`apps/holtburger-web/capture_audio_leak.cjs:117-118` and `scripts/perf-worker/walk-west-driver.mjs`
each `chromium.launch()` their own browser with no such flag while reading `usedJSHeapSize`.
`capture_audio_leak.cjs` samples that field over a **120-second** sit and declares "no leak" below
1 MB/min — over a 120 s window a 20-minute-cached value is *constant by construction*, so that
harness cannot fail. Its verdict ("V8 JS-heap is flat across hostile stress") is **unproven, not
wrong** — and it is the reason LEAK-09 exists and gates LEAK-04.

Consequence for every VERIFY-LIVE row here: the acceptable instruments are (1) CDP
`Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`, (2) `wasm_memory_bytes()` /
`memory.buffer.byteLength`, (3) the per-pool byte-sum tallies `matMB`/`palMB`/`entMB`, (4) CDP
`HeapProfiler.takeHeapSnapshot` constructor counts (as `capture_audio_heap.cjs` already does
correctly). **Never `performance.memory` without the flag.**

---

## 1. COVERAGE LEDGER

41 document headings + 5 broken-out distinct claims inside §5 = **46 rows. Nothing skipped.**

| Disposition | Count |
|---|---|
| TASK (new, this file) | 17 |
| TASK (covered by an already-filed task: PAL-01..03, DAT-06/07) | 3 |
| PARITY-OK | 6 |
| VERIFY-LIVE | 4 |
| N/A-WEB | 9 |
| REF-ONLY | 7 |

(Rows can carry two dispositions where a section splits — e.g. §3 is PARITY-OK on the bulk-teardown
half and a TASK on the side-table half. Counts above assign each row to its *primary* disposition;
the table states both.)

### 1a. `11-memory-leak-investigation.md` (2013, 11.4186)

| § | Heading / claim | Disposition | Note |
|---|---|---|---|
| §0 | Verdict (3 leaks + amplifier, hypothesis half-right) | REF-ONLY | The ranking method — "which defect matches the reported symptom" — is the transferable part. |
| §1 | How item icons actually work (runtime composite → `IconData` → 2× 32² RenderSurface) | **TASK(LEAK-03)** | Our icon path is a per-iconId `Map` of base64 PNG data URLs with no cap and no clear: `ui/ac_icon_cache.js:29`. |
| §1 | The DAT-side freelist is properly bounded (type 12: ideal 100 / max 400, hard-capped at insertion) | **TASK(LEAK-03)** | This is the parity *target*. Retail's icon-resource ceiling is 400 shells; ours is 4,224 data URLs ≈ 30 MB, unbounded. |
| §1 | The property that reframes everything: "a Get-without-Release **pins** a DID; it does not allocate" | REF-ONLY (load-bearing) | Our recolor pool **inverts** it — per-wearer, not per-DID (`DESIGN-recolor-residency-2026-07-26.md` §1: "Fifty identically-dyed wearers = fifty composites" in retail, and we duplicate too once past the cache cap). So our leaks scale with execution count, not distinct DIDs. See the defect table §3. |
| §1 | Allocation cannot outpace eviction (cap enforced synchronously in `FreelistAdd`) | TASK(**PAL-01/PAL-02**, already filed) | Ours does **not**: `ByteBudgetLru::insert` has `None => break` (`apps/holtburger-web/src/lib.rs:9216`) — over-budget by design when nothing is evictable. Exactly wave0's gap. |
| §2 | Primary leak — `null_weenie_object_table` unreapable | **TASK(LEAK-01, LEAK-02)** | Re-verified in our decomp: `acclient.c:309986-309988` weenie half has no fallback (`if (!v4) goto LABEL_16` at `:309987`); removal at `:309999` sits inside the `if (v4)` hit branch opened at `:309995`. Doc is CORRECT. |
| §2 | What populates it (`GetNullWeenieObject` ← `QueueBlobForWeenieObject` ← two ordering-defer sites) | **TASK(LEAK-02)** | Our twin is `_pendingAttach`/`_pendingVisibility` (`entities.js:5584`, `:5504`) — parked for guids that have not spawned. |
| §2 | Why nothing collects it (2 escapes: promotion or world teardown; the 25 s timer fires into a no-op) | **TASK(LEAK-01, LEAK-02)** | Our 25 s expiry exists and is **default-OFF** (`?preCreateBuffer`, `entities.js:153-161`). |
| §2 | Secondary cost — permanent 20 s `SendForceObjdesc` re-request per stranded id | **N/A-WEB (ABSENT by choice)** | `docs/url-flags.md:885` states the nag is deliberately not implemented (ACE support unresolved). Do **not** implement it; it is the retail *symptom*, not the fix. |
| §3 | Secondary leak — `IconData` stranded on bulk teardown (`DestroyObjects` slot 0 only) | **PARITY-OK** + TASK(LEAK-01) | We already route both bulk paths through the per-entity hook: `entities.js:15184-15200` (`dispose()`) and `:15084-15099` (`clearWorldEntities()`), with a comment naming the exact bug retail has. Residual: neither bulk path clears the *unmapped-guid* side tables. |
| §3 | Trigger — `LogOnCharacter` → `SmartBox::Reset` → `DestroyObjects`; "relog without quitting" | **VERIFY-LIVE** | Our relog path is `clearWorldEntities()`. Named check in LEAK-01/02 validation. |
| §3 | Second-order symptom: stranded id collides with a new object → **stale icon after relog** | **TASK(LEAK-01)** | Directly applicable: ACE recycles dynamic GUIDs, and 9 of our per-guid maps are never pruned — so a recycled guid returns the *previous* object's appraisal/icon/inscription. This makes LEAK-01 a correctness bug, not only a memory bug. |
| §4 | Structural amplifier — system RAM never reclaimable (`m_bIsThrashable` = 0, 4 set-sites, both purge paths require it) | **TASK(LEAK-05)** | Our amplifier is `WebAssembly.Memory`: grow-only, never returns pages. Live-reproduced ~2.8 GB crash (`A15-rss-decision-2026-07-20.md`). |
| §4 | `IsAvailableVideoMemoryLow` never true on a modern card → purge never executes | **PARITY-OK** | Our reclaim gate has a **hard 10 s starvation timeout** (`scene3d/landblock_lru.js:257` `RECLAIM_GATE_MAX_HOLD_MS = 10_000`) — the exact escape retail lacked. |
| §5 | `object_inventory_table` conditional orphan (add on ViewObjectContents, remove on Stop; no delete-path prune) | **TASK(LEAK-01)** | Our exact twin: `latest_container_contents` (`src/lib.rs:29204`) — one insert path, **zero** removes, not in the delete fan-out. |
| §5 | Recycled UI widgets pin the last icon (bounded by grid slots; raises the floor) | **PARITY-OK** + TASK(LEAK-06) | Our warm-park pool keeps GL buffers on park by design (`landblock_lru.js:143-144`) but is governed (`MAX_LIVE_GEOM`, byte pressure, age floor). The *uninstrumented* version of this is paletted-texture eviction: bytes stay live via meshes — LEAK-06. |
| §5 | `ImgTex::temp_buffer_table` — no removal code anywhere; fixed high-water | **TASK(LEAK-07)** | Three of ours have the same shape: `_holdingLocCache`, `_placementFrameCache`, `_sortCenterCache` (`entities.js:5765`, `:5811`, `:10263`) — set + get, never delete, never cleared. |
| §5 | `lost_cell_table` — small session-lifetime accumulation | **PARITY-OK** | Our nearest twin `terrain_heights_shadow` (`src/lib.rs:29636`) is **wholesale replaced** every tick (`:49100`), so it tracks the resident LB set rather than accumulating. |
| §5 | Six confirmed Get/Release asymmetries (incl. #6, per-frame while charging) | **N/A-WEB** | Hand-rolled `m_numLinks`. Rust `Arc` + JS GC make the mechanism unrepresentable. The *bound* ("cost is distinct DIDs × size, not execution count") is the reusable idea — recorded in §3. |
| §5 | `m_PendingGets` never self-retires; entries survive completion **and** failure; `ReadyToUnhash` is dead code | **PARITY-OK** (retire) + **TASK(LEAK-08)** (timeout) | Ours retires correctly and TOCTOU-safely on both arms: `crates/holtburger-resource-http/src/inflight.rs:230-237`. But… |
| §5 | "No timeout on net-sourced gets — a dropped DDD reply hangs that get indefinitely" | **TASK(LEAK-08)** | Verified ABSENT in ours: zero hits for `timeout`/`AbortController`/`AbortSignal` across all 9 files of `crates/holtburger-resource-http/src/`. Worse than retail: our waiters latch the same `Shared` future, so a never-settling fetch poisons that URL for the session. |
| §6 | What is *not* leaking (17-row rule-out table) | REF-ONLY | The method (publish the negatives so the positives are credible) is adopted in §3's "can we violate it?" column. |
| §7 | How to confirm at runtime (3 experiments; network signature; separate looting from relogging) | **TASK(LEAK-09)** | "Separate the triggers before measuring" is the single most useful transferable rule and is baked into every validation below. |
| §8 | If you intend to patch (Fix 1/2/3 ranked; do NOT make the sysmem texture thrashable) | REF-ONLY | Fix 1 = restore symmetry; Fix 2 = route bulk through the hook; Fix 3 = clear on recycle. All three re-appear as LEAK-01/02, PARITY-OK(§3), LEAK-06. |
| §8b | PE facts (ImageBase, DYNAMICBASE clear, checksum, section mapping) | N/A-WEB | — |
| §8b | Two vtables; slot 1 means different things; call `0x0058E4D0` directly | N/A-WEB (REF-ONLY method) | Corroborated in our decomp: `acclient.c:437260-437282` writes both vptrs (`:437266-437268`) and the trailing comments name `7E3E88` **and** `7E3EA0`. The generalisable rule — *resolve a hook by address, never by "slot N of the class's vtable"* — maps onto our `#[wasm_bindgen]` boundary as "resolve by exported symbol, never by index". |
| §8b | The bug at instruction level (`je 50858c` at `0x0050857D`) | N/A-WEB | Now resolvable to original source — see TOOL-01: **`portal/client/src/objects/cobjmaint.cpp:652`**. |
| §8b | Fix 2's premise verified (two `call [edx]`, no `call [reg+4]` in 829 B) | N/A-WEB | — |
| §8b | Code caves — corrected (`DwExceptionFilter` 0x006B5820, 1292 B) | N/A-WEB | ANTI-TASK §5. |
| §8b | Recommended delivery: a DLL via the `ACPlugin` registry hook | N/A-WEB | ANTI-TASK §5. |
| §8b | Implement all three as additive hooks | N/A-WEB | — |
| §8b | Honest caveat: `QueryPluginList` makes the plugin server-visible | N/A-WEB | — |
| §9 | Provenance (verified-by-read vs reported vs resolved) | REF-ONLY | I re-read three of its "verified personally" claims; all three hold (§6 below). |
| §9 | Separate lead — possible **over-release** (`CObjCell::Get` returns a borrowed interior pointer that the sole caller releases) | REF-ONLY + **VERIFY-LIVE** | Rust/JS have no `Release`, but our analogue exists and *has already fired*: `scene3d/materials.js:4032-4039` documents a double-consume of an already-`free()`d `SurfacePixels` handle throwing "null pointer passed to rust" (the 100-error burst). Same class: a borrowed handle released twice. Covered by PAL-03. |
| §9 | Open questions (5) | REF-ONLY | Two are ACE-answerable and are lifted into §7. |

### 1b. `12-memory-leak-2015.md` (2015, 11.6096)

| § | Heading / claim | Disposition | Note |
|---|---|---|---|
| §0 | Verdict — all three defects present; 23 named functions byte-identical | REF-ONLY | Confirms the defects are era-independent. Nothing to port. |
| §1 | The three defects, restated | REF-ONLY | Superseded by 1a. |
| §1 | Byte-level confirmation in *this* binary (Defect 1 `je` at `0x0050904D`; Defect 2 two slot-0 calls; Defect 3 no `ClearImage`) | N/A-WEB | — |
| §2 | `CObjectMaint` table layout (+0x84/+0x9C/+0xB4/+0xCC/+0x1CC, uniform 0x18 stride; closes the 11.4186 gap) | N/A-WEB (REF-ONLY) | The *observation* is transferable: four sibling tables at a uniform stride, and the delete path handles two of the four. Our version is 10 sibling maps and a fan-out that handles 8 — LEAK-01. |
| §3 | The vtable question — and a correction to the 11.4186 report (labels inverted) | REF-ONLY | Correction verified as landed in the 2013 doc at `11-…md:528-531`. See §6. |
| §4.1 | Binary identity (size/MD5/linker date/PDB GUID; `DYNAMICBASE` clear) | N/A-WEB | Cross-ref: wave0's EoR binary is this size (4,841,472 B) — the palette patch targets the same build. |
| §4.2 | File offsets — and the correction that `file offset == RVA` fails past `.data` (−0xCF000) | N/A-WEB | Correction verified as landed in the 2013 doc at `11-…md:500`. |
| §4.3 | Address table (17 rows, 11.6096) | N/A-WEB | — |
| §4.4 | Recommended delivery: a DLL, not a modified EXE (`APIManager::Init` @ 0x0055AF00) | N/A-WEB | ANTI-TASK §5. |
| §4.5 | Implement all three as additive hooks | N/A-WEB | — |
| §4.6 | Code cave (`DwExceptionFilter` 0x006B6760, 1292 B; the never-taken `fInstallNow = 0` branch) | N/A-WEB | ANTI-TASK §5. |
| §5 | The one nearby function that changed (`ProcessNetBlobData`: +2 opcodes `0x317`/`0x318`, pivot `0x276`→`0x27A`) | REF-ONLY | Neither is an inventory opcode → the defer path that feeds the leak is unchanged. Cross-check for the protocol agents: do we handle `0x317`/`0x318`? Not in scope here. |
| §6 | Confirming at runtime (network signature for D1; working-set staircase across relogs for D2; stale-icon tell) | **TASK(LEAK-09)** + **VERIFY-LIVE** | The relog-staircase design is directly reusable — see LEAK-01/02 validation. |
| §7 | Provenance — relocation-exact body matching; **two methodological warnings** (byte-scanner phase desync; lockstep compare false-negatives); 11,081/11,127 identical | REF-ONLY (method, high value) | Four successive heuristics reported 2.7 / 3.5 / 40.2 / 0.84 % changed and *every one was wrong*. This is the strongest available argument for TOOL-01: derive the index from an authoritative record (the PDB dump), never from a byte/regex heuristic over the decompilation. |

---

## 2. TASKS

### LEAK-01 — Nine per-GUID bridge maps are never pruned; the delete fan-out prunes eight siblings and misses them (M)

**Source §:** 2013 §2 (asymmetric delete), §3 second-order stale-icon symptom, §5
`object_inventory_table`; 2015 §2 (four sibling tables, two handled).

**What retail did wrong.** `CObjectMaint::DeleteObject` searches `weenie_object_table` only and
returns 0 on a miss; the `null_weenie_object_table` removal sits inside the hit branch
(`acclient.c:309986-310002`, re-verified here by direct read). One function, two halves, one of them
missing a fallback the other has. Retail's cost per stranded entry: ~336 B + parked NetBlobs +
128 B stamper + ~8 KB `IconData`.

**Holtburger today — verified.** The bridge has one centralised cleanup,
`maintain_bridge_indexes_on_delete` (`apps/holtburger-web/src/lib.rs:28725`), called from
`apply_inventory_object_delete` (`:28793`) and the routed `?worldLifecycle` path. It prunes **eight**
per-guid stores (`:28740-28782`): `wielder_index`, `projectile_index`, `PROJECTILE_GRAVITY_GUIDS`,
`DEFAULT_SCRIPT_INDEX`, `UI_EFFECTS_INDEX`, `physics_script_table_index`,
`entity_enchantments_index`, `MOTION_ACTION_STAMPS`. **Nine more per-guid stores have zero
`remove`/`clear`/`retain` anywhere in the file** — established by exhausting each symbol's hit list:

| Store | Decl | Value | Hits / of which remove-clear-retain |
|---|---|---|---|
| `latest_appraisals` | `lib.rs:29232` | **`String`** — full appraisal JSON (property tables, profiles, spell book) | 11 / **0** |
| `latest_vendor_state` | `lib.rs:29193` | `VendorState` (a vendor's whole item list) | 10 / **0** |
| `latest_container_contents` | `lib.rs:29204` | `Vec<u32>` | 9 / **0** |
| `latest_inscriptions` | `lib.rs:29220` | `String` | 9 / **0** |
| `latest_object_icons` | `lib.rs:29210` | `u32` | 8 / **0** |
| `door_part_snapshot` | `lib.rs:29507` | `DoorPartSnapshot` | 8 / **0** |
| `rynth_id_times` | `lib.rs:29572` | `f64` | 9 / **0** |
| `identify_meta_index` | `lib.rs:35950` (recv-loop capture; insert `:39320`, read `:39809`) | `(bool, u32)` | 6 / **0** |
| `REMOTE_AIRBORNE_STATE` | `lib.rs:14973` | `bool` | 2 / **0** |

`latest_appraisals` is the expensive one: a KB-scale JSON string per distinct object ever examined,
retained for the whole session. `latest_vendor_state` is next. The rest are bytes-per-entry but
monotonic.

**Why this is retail's bug and not merely similar.** Retail's appraisal data lived *on the object*
(`CACQualities`, freed by `~ACCWeenieObject`, `acclient.c:437260-437282`), so teardown was
automatic. We detached it into side tables keyed by guid, which makes teardown **manual** — and
manual teardown missed 9 of 17 tables. Retail missed 1 of 2. Same failure mode, worse ratio.

**And it is a correctness bug too.** ACE recycles dynamic GUIDs. A recycled guid hitting any of
these maps returns the *previous* occupant's data — retail §3's predicted "stale icon after
relogging", except ours would surface as a stale appraisal panel, a stale vendor list, or a stale
inventory icon. That prediction is cheap to test and would confirm the mechanism outright.

**Proposed change.** (a) Move all nine into `maintain_bridge_indexes_on_delete` — it already takes
four `&Rc<RefCell<…>>` params, so extend the signature or (better) collect the guid-keyed stores
into one `BridgeIndexes` struct so the next one added cannot be forgotten. (b) Add a
session-teardown clear for all 17, so nothing survives a relog into a fresh guid space. (c) Add a
`bridge_index_sizes()` diag returning the size of each, so a soak can see growth.

**Payoff.** Kills an unbounded, session-monotonic retention class with a KB-scale entry; removes a
stale-data class; makes "one more side table" structurally safe.

**Effort:** M (mechanical, but 9 call-sites plus a struct refactor and a new diag).

**Validation.** Headless `?nullRender=1&autoLogin=1` bot: examine N distinct objects (a vendor
inventory walk gives ~50 in one stop), then `@telepoi` away so ACE deletes them, then read
`bridge_index_sizes()`. **Proof number: `latest_appraisals` must return to ≤ the count of currently
live examined entities — today it stays at N and never falls.** Stale-data check: examine object A,
force its delete, wait for guid reuse, examine the new object at the same guid and assert the panel
does not show A's properties.

---

### LEAK-02 — The retail-faithful placeholder expiry is written and default-OFF; the live default path has no expiry and survives a relog (S)

**Source §:** 2013 §2 "What populates it" / "Why nothing collects it"; 2015 §1 Defect 1.

**What retail did wrong.** A weenie parked in `null_weenie_object_table` for an object whose
`0xF745` never arrives survives the whole world session. `GetNullWeenieObject` *does* call
`AddObjectToBeDestroyed` (`acclient.c:310757`), but when the 25 s timer fires `DeleteObject` no-ops
and the `destruction_object_table` entry is consumed — it never retries.

**Holtburger today — verified.** Two bespoke park maps are the live default:
`_pendingAttach` (`entities.js:5584`) and `_pendingVisibility` (`:5504`). Their only removals are the
successful-attach path (`:5668`), `_detachChild` (`:5707`), and `remove()` at `:9970`/`:9973` — and
`remove()` **early-returns at `entities.js:9936-9937`** (`const inst = this.entityMap.get(g); if
(!inst) return;`) before reaching them. That early return is a line-for-line analogue of retail's
`je 50858c`: *a guid present only in the placeholder tables is unreachable from the delete path.*
Neither map is cleared by `clearWorldEntities()` (`:15084-15099`) or `dispose()` (`:15184-15200`),
which clear only `entityMap`/`_nameToGuid`/`spawnInFlight`/`_spawnGen` — so a park for a guid that
never spawned survives a session change into a **fresh guid space**, where it can never drain.

The fix already exists: `?preCreateBuffer=on` replaces both maps with one guid-keyed FIFO carrying
retail's 25 s expiry (`pre_create_buffer.js`; sweep at `entities.js:13213-13218`, despawn purge at
`:9980`, drain on spawn-commit). Flag reader `readPreCreateBufferFlag()` (`entities.js:153-161`) is a
strict `=== "on"` opt-in — **no second carrier** (single consumer, `_preCreateBufferOn` assigned once
at `:3224`), and `docs/url-flags.md:614` confirms default off. `docs/url-flags.md:885` records it as
**headless-verified, no eye-test required**, with an explicit acceptance criterion of
"no leak growth from never-spawned guids (25 s expiry)".

**Proposed change.** Promote `?preCreateBuffer` to default-ON with an `=off` escape (repo convention
per `default-on-no-eyetest-gate`); additionally clear `_preCreate` (and the legacy maps, while they
exist) in `clearWorldEntities()`.

**Payoff.** Closes retail Defect 1's *placeholder* half with code that is already written and
already headless-tested. Retail's own 25 s timer was the right design and merely fired into a broken
`DeleteObject`; ours works and is switched off.

**Effort:** S.

**Validation.** `?nullRender=1&autoLogin=1`, flag on vs off: burst spawns during a landblock stream,
then assert `this._preCreate.size()` returns to **0** within ~26 s of the last enqueue, and that
`_pendingAttach.size + _pendingVisibility.size` is 0 after a session reset. **Proof number: parked
count → 0 while flag-off leaves a non-zero residue across a reconnect.** Gate: bare-default boot
loads + spawns + zero console errors; wielded items still mount; login-bubble hide still applies.

---

### LEAK-03 — The UI icon cache is unbounded, unobservable, and latches transient failures forever (S/M)

**Source §:** 2013 §1 (the whole icon pipeline), §1 "the DAT-side freelist is properly bounded",
§3 (icon pixels are the leaked payload).

**What retail did right, and it is the parity target.** The report's headline correction is that
retail's *icon resource* cache is sound: type-12 `DB_TYPE_RENDERSURFACE` is registered with
`m_nIdealSize = 100`, `m_nMaxSize = 400`, hard-capped **at insertion** in `FreelistAdd`
(`acclient.c:83194-83200`), freelisted objects are payload-freed shells, and all 17 icon-DID
acquisitions are balanced. Retail's steady-state icon-resource ceiling is 400 emptied shells.

**Holtburger today — verified.** `apps/holtburger-web/ui/ac_icon_cache.js` (155 lines, read in
full):
- `const iconCache = new Map();` at **`:29`** — module-private, only four exports touch it.
- Values are `canvas.toDataURL("image/png")` strings (`:63`) — base64 PNG, per the module's own
  comment "4 KB to ~6 KB per icon, 4,224 icons in the v1 manifest" ≈ **30 MB** if fully populated.
- **No cap, no eviction, no `clear()`, no `delete`** — grep for `delete|clear|evict|MAX|cap|revokeObjectURL`
  over the file returns only the `iconCache = new Map()` line and an unrelated comment.
- **Failure is cached permanently:** `iconCache.set(iconId, false)` when wasm is missing (`:50`), and
  the async body returns `false` on any decode/fetch error (`:77`) which is then stored at `:82`.
  A transient failure silences that icon for the whole session.
- `iconCacheSize()` (`:153`) has **zero consumers** — the only other hit for that identifier is a
  *different* module's own local cache (`ui/ac_dye_preview.js:299`). So the pool is invisible to
  `__diag`.

This is the third independent occurrence in this codebase of *latch-a-transient-failure-as-truth*.
The surface path already learned it the hard way: `src/lib.rs:8901-8925` documents R-7/A07-F1, where
"a transient shard failure latched a surface grey for the whole session per wasm instance", and the
fix was to memoise absence **only** on a catalog-authoritative `key_known_absent` proof. The icon
cache and the audio cache (LEAK-04) both still make the original mistake.

**Proposed change.** (a) Split success from failure: keep resolved data URLs in a byte-budgeted LRU
(reuse the `?matBudgetMB`/`?palBudgetMB` pattern — `?iconBudgetMB`, default sized from the 4,224 ×
6 KB ceiling, e.g. 16 MiB) and hold failures in a *separate, TTL'd* negative map so a retry is
possible. (b) Store the decoded pixels or an `ImageBitmap` rather than a base64 string if any
consumer re-decodes it (base64 is ~1.33× the byte cost of the PNG and is re-parsed on every
`img.src` assignment). (c) Wire `iconCacheSize()` + a byte sum into `__diag` as `iconMB` — a fourth
byte-sum tally alongside `matMB`/`palMB`/`entMB`.

**Payoff.** Bounds the one pool that is literally the subject of the retail report; removes a
permanent-blank-icon class; adds the missing tally. Retail's ceiling was 400 shells — ours should
not be "everything you ever saw".

**Effort:** S for the instrument + negative-map split; M with the LRU and the pixel-format change.

**Validation.** Headless: open the inventory/vendor panels across several POIs with
`?preloadIcons=1` **off** (the live lazy path), sample `iconMB` and `iconCacheSize()` per stop.
**Proof number: `iconMB` must plateau at the budget instead of tracking distinct icons seen.**
Failure-latch check: block one icon DID's fetch once, then unblock, and assert the icon renders on a
later panel open (today it stays blank for the session).

---

### LEAK-04 — Decoded-audio cache: unbounded, and a failed decode poisons the sound for the session (M)

**Source §:** 2013 §5 (`temp_buffer_table` — "no removal code anywhere"), §1 (freelist caps as the
parity model), §6 (what a *sound* cache should look like).

**Retail's parity number.** `DB_TYPE_WAVE` is registered with `m_freelistDef.m_nIdealSize = 3`,
`m_nMaxSize = 15`, `m_bRecycle = 0`, `m_bShrink = 1` (`acclient.c:92467-92472`, read directly).
Fifteen released Wave shells is retail's entire idle residency for sound resources; anything
actively referenced is refcount-pinned and released on last drop.

**Holtburger today — verified.** `scene3d/audio/audio_manager.js`:
- `this._bufferCache = new Map()` at `:78`; the only mutations are `.set(key, promise)` at `:329`
  and `.clear()` at `:506`/`:511` (dispose). **No cap, no eviction, no per-entry delete** — grep for
  `budget|cap|MAX_|evict` over the file returns only `DEFAULT_MAX_DISTANCE` (a panner distance).
- Values are decoded `AudioBuffer`s (`:317` `decodeAudioData`) — PCM float data whose backing store
  is **native/external**: invisible to `Runtime.getHeapUsage` *and* to `performance.memory`. Only
  `HeapProfiler.takeHeapSnapshot` constructor counts see them, which is exactly what
  `capture_audio_heap.cjs` was built for.
- **Failure is cached forever:** the async body returns `null` on fetch failure (`:292`),
  `takeRiffBytes` failure (`:299`), empty bytes (`:302`) and `decodeAudioData` failure (`:326`), and
  the promise is installed unconditionally at `:329`. `_loadBuffer` short-circuits on
  `_bufferCache.has(key)` at `:270`, so a single transient miss silences that sound permanently.
  `SoundTableCache` next door gets this right — it clears `pending` on failure so a retry works
  (`sound_table_cache.js:26-30`, `:180`).

**Proposed change.** (a) Byte-budget the buffer cache (`buf.length * numberOfChannels * 4` is the
exact residency) with LRU eviction; sounds are cheap to re-decode. (b) Do **not** cache a
null-resolving promise — delete the key on the null arm so a retry is possible, mirroring
`SoundTableCache`. (c) Expose `audMB` + `audEntries` in `__diag` as the fourth byte-sum tally.

**Payoff.** Bounds the only asset pool with no budget after the July budget sweep
(`matBudgetMB`/`palBudgetMB`/`surfaceBudgetMB`/`MODEL_TRI` 64 MiB all landed), and it is the pool
*least* visible to every heap instrument. Removes a permanent-silence class.

**Effort:** M.

**Validation.** **Gated on LEAK-09** — `capture_audio_leak.cjs` cannot currently detect this. Use
`capture_audio_heap.cjs` (CDP snapshot + `collectGarbage`, already correct) with a hostile-audio
soak: **proof number is the `AudioBuffer` constructor count in the AFTER snapshot — it must plateau
at the budget instead of equalling distinct wave DIDs played.** Secondary: assert a sound whose
first fetch failed plays on a later trigger.

---

### LEAK-05 — wasm linear memory is our `m_bIsThrashable` (L, decision-gated)

**Source §:** 2013 §4 in full.

**What retail did wrong, precisely.** `m_bIsThrashable` defaults to 0 (`acclient.c:131482`), is set
at only four sites (all `D3DPOOL_DEFAULT` VRAM objects), and **both** purge paths require it
(`:131206`, `:131609`). So `PurgeOldGraphicsResources` is structurally incapable of freeing a byte of
system RAM; `PurgeResource` does not even destroy or unregister (`:131211-131214`). System-RAM
footprint comes back only when the owning `ImgTex`/`UISurface`/`CSurface` refcount hits zero.
Retail's conclusion: *this converts every other defect from transient to permanent.*

**Holtburger today — verified, and it is already the live top-priority memory problem.**
`docs/rynth-integration/A15-rss-decision-2026-07-20.md`: "The unbounded thing is
**`WebAssembly.Memory` itself** — it only ever grows and never returns pages to the OS. So the peak
concurrent decode/bake working set… sets a permanent RSS floor that ratchets up across a long
session until the ~2.8 GB crash. (Live-reproduced: the perf-loop soak crashes ~every 30 min of
roaming; `wasm_memory_bytes()` climbs while JS heap stays flat ~93 MB.)" It records three options
awaiting a user decision: (a) bound concurrent in-flight decode / add wasm-memory backpressure,
(b) reduce per-bake transient allocation in Rust, (c) periodically tear down + recreate the wasm
instance at quiet points. The retraction doc independently confirms the wasm numbers are the honest
ones and that the 680 MB main-instance residency is real.

**What retail contributes that is not already in the A15 doc — three things.**

1. **A precedent for option (b), with a mechanism.** Retail keeps a `D3DPOOL_SYSTEMMEM` mip master
   but **purges the staging RGBA at upload** (`acclient.c:366173-366176`, cited in
   `DESIGN-recolor-residency-2026-07-26.md` §1). We keep both copies: 12 B/px across wasm+JS vs
   retail's 4 B/px in one heap, ~2.2× host RAM on the 50-wearer arithmetic. "Free the staging plane
   the moment the consumer has its copy" is a retail-proven pattern and is the cheapest slice of (b).
2. **A warning against the tempting variant of (c).** Retail explicitly refuses to make the
   sysmem copy reclaimable because it is the device-loss restore source (§8 "not recommended without
   care"). Our exact twin is `webgl_context_recovery.js` + three.js `image.data`: the July analysis
   already rejected "drop `image.data` post-upload" partly because it "breaks context-loss"
   (`DESIGN-recolor-residency` §2 option #4). **Retail hit the same wall in 2001 and documented the
   same reason.** That convergence is worth recording so option (c) is scoped as *instance* teardown
   at a quiet point, not *per-texture* staging discard.
3. **The framing that makes prioritisation obvious.** Because the floor is a high-water mark, only
   the **peak** matters. Averages, budgets and eviction rates are all secondary; the metric to
   optimise is max concurrent transient bytes. That argues (a) before (b) before (c).

**Proposed change.** No autonomous patch (the A15 doc explicitly puts this in the user-decision
bucket, and I concur). Concrete deliverable *within* this task: add a peak-tracking instrument —
`wasmPeakBytes` alongside `wasmMemoryBytes`, plus a per-bake transient-bytes high-water — so the
option-(a)/(b) A/B has a number before either lands.

**Payoff.** Turns a crash class into a governed number. Retail could never do (c); we can, which is
the one axis on which a browser client beats the 32-bit retail client outright.

**Effort:** L (the fix); S (the peak instrument).

**Validation.** Existing perf-loop soak, which reproduces the crash. **Proof number:
`wasmPeakBytes` at 30 min of roaming must stop ratcheting — a flat peak across the second and third
15-minute windows is the pass, and a monotone rise is the current state.** Never use
`performance.memory` here (§0b); `memory.buffer.byteLength` is exact.

---

### LEAK-06 — Paletted-cache eviction produces bytes that no instrument can see (M)

**Source §:** 2013 §5 "Recycled UI widgets pin the last icon"; §1 pin-not-allocate (inverted).

**What retail did wrong.** `ItemList_DeleteItem` (`acclient.c:274174`) returns a widget to
`m_listUIItemCache` without `UIRegion::ClearImage`, so a recycled slot pins the previous item's ~4 KB
composited surface. Retail's saving grace: **bounded by grid slot count**. It raises the floor, it
does not grow.

**Holtburger today — verified, and ours is not bounded the same way.** `scene3d/materials.js`
eviction loop `:3000-3028`, with the code's own reading note at `:3006-3012`: *"this decrements the
LIVE byte count, which tracks what the CACHE holds, not what the heap holds: `oldTex.dispose()`
frees the GPU handle only, and any live mesh still pointing at `oldMat` keeps `image.data`
reachable."* So on eviction: `_palBytes -= evictedBytes` (`:3016`) while the bytes remain resident
via the mesh, and the next wearer with that signature mints a fresh full-size copy
(`palRemint`, `:3022-3026`). The `?palBudgetMB=N` byte budget landed 2026-07-26 (default 64 MiB,
`:1978`, `:2246-2256`; the legacy `PALETTED_CACHE_CAP = 256` count cap survives only as
`?palBudgetMB=off`, `:133`), which bounds the *cache* — **and therefore guarantees that `palMB`
understates true residency exactly when thrashing.**

The gap, stated precisely: bytes that have been evicted but are still mesh-reachable are counted by
**neither** `palMB` (decremented at eviction) **nor** `entMB` (`entity_owned_tally.js` counts only
textures explicitly passed to `registerTexture`, `:111-130` — a MaterialCache paletted texture is
never registered). `_palEvictedBytes` (`:3017`) is a cumulative upper bound, not a live figure.
This is the JS-side twin of wave0's PAL-01 (no pinned-entry counter on the Rust surface cache) and
should be built with it.

**Proposed change.** An **escaped-bytes** live counter: on eviction, register the evicted texture in
a `FinalizationRegistry` keyed by its charged bytes and add to `_palEscapedBytes`; decrement in the
finalizer. Report `palEscapedMB` through `__diag.palettedCache()`. This is the honest measure of
"evicted but still retained", it is O(1), and — following the deliberate design of
`entity_owned_tally.js:88-96` (WeakMap/WeakSet "so the tally itself can never be the retainer it is
hunting for") — a `FinalizationRegistry` holds no strong reference either.

**Payoff.** Makes the one number the July investigation could not produce measurable:
`palMB + palEscapedMB` is true paletted residency. Without it, "the budget is working" and "the
budget is converting shared entries into per-wearer duplicates" look identical.

**Effort:** M. Caveat to state in the code: finalizer timing is non-deterministic, so
`palEscapedMB` is an upper bound that decays — read it after a forced GC, exactly as the fixed
heap instrument does.

**Validation.** Museum-density stop (Hotel Swank is the known worst case) at
`?palBudgetMB=64` vs `=off`. **Proof numbers: `palRemint` > 0 with `palEscapedMB` near zero means
the budget is reclaiming correctly; `palRemint` > 0 with `palEscapedMB` climbing means the budget is
duplicating, and the byte budget needs raising or the composed-slim −50 % (`DESIGN-recolor-residency`
§2.1) needs landing first.**

---

### LEAK-07 — Three per-setup JS caches with no removal path (S)

**Source §:** 2013 §5 `ImgTex::temp_buffer_table` — "a cache with **no removal code anywhere**;
entries are pinned at refcount 1 forever… a fixed high-water cost rather than a runtime leak — but
it is genuinely never evicted".

**Holtburger today — verified.** Three `EntityManager` maps have set + get and no `delete`, no
`clear`, and no entry in any teardown path (hit lists exhausted):

| Map | Decl | Key | Written | Read | Removals |
|---|---|---|---|---|---|
| `_holdingLocCache` | `entities.js:3232` | setup id | `:5765` | `:5734` | **none** |
| `_placementFrameCache` | `entities.js:3239` | setup+placement | `:5811` | `:5788` | **none** |
| `_sortCenterCache` | `entities.js:3118` | setup id | `:10263` | `:10222` | **none** |

Bounded by distinct setup ids, so — exactly as retail says of `temp_buffer_table` — a fixed
high-water rather than a runtime leak, and it survives `dispose()` (which clears `entityMap`,
`_nameToGuid`, `spawnInFlight`, `_spawnGen` only, `:15184-15200`).

**Proposed change.** Clear all three in `dispose()`/`clearWorldEntities()`. Optionally cap them; a
cap is probably not worth it (setup-id cardinality is bounded by the DAT), and retail reached the
same conclusion about its own version.

**Payoff.** Small bytes; removes three "leak-shaped" objects from every future audit's suspect list,
which is most of the value — retail spent a whole §5 subsection ruling its version *in* as a
non-leak.

**Effort:** S.

**Validation.** Read the three `.size` values after two `clearWorldEntities()` cycles.
**Proof number: 0 after teardown; today they retain their high-water.**

---

### LEAK-08 — `InflightMap` has no timeout, and a never-settling fetch poisons the URL for the session (M)

**Source §:** 2013 §5 "A further candidate: `m_PendingGets` under sustained prefetch" and its
closing paragraph on the absence of any Cancel/Abort/Timeout API.

**What retail did wrong.** `m_PendingGets` entries are inserted by `HashAndEnqueue`
(`acclient.c:86743`) and removed only via `ReleaseContext` → `UnhashPendingGet` (`:86797`, `:86841`);
they survive both completion and failure. `ReadyToUnhash` occupies request-vtable slot 2 and is
never called anywhere in the binary — good evidence a self-retiring path was removed. And there is
**no timeout**: `OnAsyncGetFromOtherSourcesFailed` (`:85466`) is dead code, so a dropped DDD reply
hangs that get and its shared prefetch context indefinitely.

**Holtburger today — verified, half fixed and half identically broken.**
`crates/holtburger-resource-http/src/inflight.rs`:
- **Retire-on-both-arms: correct.** `cleanup_resolved` (`:230-237`) removes the entry after the
  `Shared` future resolves, `Ok` or `Err`, and guards against the TOCTOU race where a second caller
  has already installed a fresh future (`existing.peek().is_some()`, `:232-234`). The doc comment at
  `:150-160` states the dedup-not-cache contract explicitly. Retail's defect is absent.
- **Timeout: ABSENT.** Zero hits for `timeout`, `AbortController`, `AbortSignal` across all nine
  files of `crates/holtburger-resource-http/src/`. There is no cancellation path at all.
- **Consequence is worse than retail's.** Retail leaked a hash node + ~100 B request + one pinned
  `DBObj` per hung get. Ours latches every subsequent caller for that URL onto the same
  never-resolving `Shared` future — so the record is not merely leaked, it becomes **permanently
  unfetchable for the session**, with no error and no log. Combined with LEAK-03/LEAK-04's
  failure-latching, a stalled shard host produces silent permanent gaps.
- `in_flight_count()` exists (`:239-241`) but is `#[allow(dead_code)]` — no diag consumes it.

**Proposed change.** (a) Wrap the wasm fetch in an `AbortController` with a generous deadline
(30–60 s; the mean paletted round-trip is ~897 ms per `materials.js:2233`, so a deadline two orders
of magnitude above that is safe) and map the abort to the normal `Err` arm so `cleanup_resolved`
runs. (b) Expose `in_flight_count()` plus the oldest in-flight age through `dat_decode_diag()`, and
add a `stuck(thresholdMs)` reading — `materials.js` already ships that exact pattern for its JS-side
`pendingFetches` (`:2266-2272`), so the shape is settled.

**Payoff.** Converts a silent permanent-stall class into a retryable error. This is the one place
retail's report says outright is worth instrumenting on a live client — and its reasoning transfers
unchanged.

**Effort:** M.

**Validation.** Local harness against a shard URL that accepts the connection and never responds
(a `nc -l` blackhole, or serve.py with a deliberate hang). **Proof numbers: with the fix,
`inFlightCount` returns to 0 within the deadline and a subsequent request for the same DID
re-attempts; today it stays ≥1 forever and every retry silently awaits the dead future.**

---

### LEAK-09 — Retire the broken heap instrument from the two standalone leak harnesses; re-open the audio verdict (S)

**Source §:** 2013 §7 (all three runtime experiments), 2015 §6 (working-set staircase). The retail
reports rest on process working set, which was the right instrument for a 32-bit Win32 binary.
Ours is not.

**Holtburger today — verified.** `RETRACTION-jsheap-step-2026-07-26.md` proves
`performance.memory.usedJSHeapSize` without `--enable-precise-memory-info` is quantized and
**cached for 20 minutes**, with four independent proofs (bit-identical values across 48 samples /
18 minutes; a reported 3,586 MB against a probe-verified 2,330 MB heap limit; the "step" tracking
wall clock not location; direct CDP measurement showing 20.5 MB where `performance.memory` read a
frozen 468 MB). The shared harness now passes the flag (`harness/lib/boot.mjs:212`, with the
retraction cited in the comment). **Two standalone launchers still do not:**
`apps/holtburger-web/capture_audio_leak.cjs:117-118` and `scripts/perf-worker/walk-west-driver.mjs`
both `chromium.launch({args: [...]})` with no precise-memory flag while reading `usedJSHeapSize`.
Nine further scripts read the field but boot through the fixed shared harness.

`capture_audio_leak.cjs` is the one the prompt named as leak-harness precedent. Its pass criteria
(<1 MB/min over a 120 s sit) cannot be violated by a value that is constant for 20 minutes — the
harness is structurally incapable of failing, and its "no actionable leak" conclusion for the audio
chain is therefore **unproven**, which is exactly why LEAK-04's unbounded `_bufferCache` and
permanent null-latch survived to today.

**Proposed change.** (a) Route both standalone launchers through `harness/lib/boot.mjs`, or add the
flag locally. (b) Replace the growth-rate criterion with the two honest instruments:
`Runtime.getHeapUsage` after `collectGarbage` for the V8 heap, and — because `AudioBuffer` PCM is
V8-external — `HeapProfiler.takeHeapSnapshot` constructor counts, which `capture_audio_heap.cjs`
already implements correctly. (c) Delete or clearly retire the `jsHeapPeak*` columns wherever they
survive, per the retraction's own instruction ("retire the old column name so no future doc grafts
onto `jsHeapPeakMB`").

**Payoff.** Every VERIFY-LIVE row in this file and in waves 1–2 depends on a trustworthy heap
number. This is the cheapest task here and it gates LEAK-04 and half of LEAK-06.

**Effort:** S.

**Validation.** Self-validating: run the fixed harness twice in one 25-minute window and confirm the
sampled value **changes** between samples (today it does not) and that its magnitude is within the
probe-verified heap limit.

---

### LEAK-10 — `ByteBudgetLru::clear` bypasses the `evictable` predicate and zeroes the byte accountant while holders remain (S, latent)

**Source §:** 2013 §3 (a bulk path that skips the per-entry protocol the single path honours) —
the same shape as `DestroyObjects` vs `DeleteObject`.

**Holtburger today — verified.** `ByteBudgetLru::insert` refuses to break a live holder
(`apps/holtburger-web/src/lib.rs:9216`, `None => break`), which is the invariant wave0's PAL-01/02
are about. `ByteBudgetLru::clear` (`:9225-9231`) does not consult `evictable` at all: it clears the
map, sets `total_bytes = 0`, and does **not** increment `evictions`. In Rust that is memory-safe —
live `Arc` holders keep their data — but the accountant then believes zero bytes are resident while
the holders' bytes are still live, so the cache can immediately admit a further 96 MiB
(`SURFACE_CACHE_BUDGET_BYTES`, `:9240`) / 64 MiB (`MODEL_TRI_CACHE_BUDGET_BYTES`, `:8091`) **on top**
of the retained set, and the overshoot is invisible in `surfaceCacheBytes`.

**Scope, honestly.** Today this is **latent, not live**: the only callers are
`global_source.rs:77-80` on `init_resource_source` re-init, and `init_resource_source` is called once
at page init (`apps/holtburger-web/index.html:2337`), when both caches are empty. The code
anticipates re-init ("cleared N entries from prior source"), and a manifest/shard swap at runtime
would arm it.

**Proposed change.** Make `clear()` charge honestly: either retain non-evictable entries (a
`retain_pinned` variant) or keep a `leaked_bytes` accumulator for entries dropped while
`strong_count > 1`, exposed next to PAL-01's `surfacePinnedEntries`. Fold into PAL-01 — same struct,
same diag surface, one review.

**Payoff.** Prevents a 2× overshoot the instrument cannot see, the moment anyone adds a runtime
manifest swap. Cheap now, awkward later.

**Effort:** S (rides PAL-01).

**Validation.** Rust unit test alongside the existing `model_tri_cache_is_shared_across_threads`
(`lib.rs:57774`): insert an entry, hold a clone, `clear()`, assert the reported `bytes` accounts for
the retained entry (or that `leaked_bytes` is non-zero). **Proof number: reported bytes after clear
must equal retained bytes, not 0.**

---

### TOOL-01 — `symbols.tsv`: one generated cross-reference joining PDB symbols, original `file:line`, the four-layer split, and decomp lines (M)

**The asset, and a correction to the premise.** The prompt frames the index files as saving "an
expensive rg over a 31 MB file". Measured, that framing is wrong: warm-cache `rg -n
'CPhysicsObj::calc_friction' acclient.c` is **11 ms**, and `rg -aN` over the 82 MB `acclient.txt` is
**21 ms**. Ripgrep is not the bottleneck. The indexes are valuable for four *different* reasons, and
the spec should be justified on those:

1. **Body extents, exactly.** `func_index.tsv` is strictly ascending in line number (verified:
   0 out-of-order rows of 36,601), so the end of any body is `next_row.line − 1`. The
   currently-canonical recipe in `MEMORY.md` is `rg -n 'Foo::bar\(' acclient.c | rg -v ';'` then
   `sed -n 'N,+60p'` — and `CPhysicsObj::calc_friction` is **68 lines** (316091–316158), so the
   canonical recipe **silently truncates it by 8 lines**. Every agent using the +60 idiom on a
   medium function has been reading a truncated body. This alone justifies the tooling.
2. **Prototype/body/call-site disambiguation is free.** `func_index.tsv` contains bodies only, so
   the `| rg -v ';'` ritual (and its failure modes on multi-line signatures) disappears.
3. **Aggregations rg cannot express**: methods-per-class, body-range spans, "every function whose
   signature mentions `CSurface *`", "does a symbol exist at all" over a closed 36,601-row set.
4. **Joins rg cannot do at all** — which is where the real new capability is.

**The new capability, and the headline finding of Job 2.** The 2013 README says the PDB "carries
full line information — roughly 1.83 MB of C11 records and 1,460 distinct source paths — which
earlier drafts wrongly said it lacked. VA to `file:line` resolution is available and **has not yet
been exploited here**." Two facts, both verified:

- **`acclient.pdb` is NOT on this machine.** A filesystem-wide search of `/home/wbterminal`,
  `/mnt/wbterminal1`, `/mnt/wbterminal2` for `*.pdb` returns only .NET build artifacts. No
  `cvdump`, `llvm-pdbutil` or DIA path is available.
- **We do not need it.** Everything the README attributes to the PDB is **already inside the 82 MB
  `/home/wbterminal/ac-headers/acclient.txt`** that `MEMORY.md` already indexes:

| Record class in `acclient.txt` | Count (measured) | What it gives |
|---|---|---|
| `S_GPROC32` | **16,232** — exactly the README's "16,232 global function symbols" | name + `[0001:offset]` + `Cb` (byte length) + type id |
| `S_LPROC32` | **23,716** — exactly the README's static count | same, for statics |
| `** Module: "…obj" from "…lib"` | 12,001 lines / **1,091 distinct .obj** — exactly the README's module count | obj → lib attribution |
| lib buckets | `ENGINE` 2,616 · `PORTAL` 2,580 · `AC` 1,704 · `GAME` 1,572 | **the four-layer library split, directly** |
| `… (None), 0001:AAAA-BBBB, line/addr pairs = N` blocks | **27,568 blocks**, 1,327 distinct source paths (README says ~1,460; my extraction regex is approximate, so treat the delta as measurement noise, not a doc error) | **VA → original `file:line`** |
| source-tree roots under `d:\ac1_sep13\` | `src\engine` 380 · `portal\shared` 261 · `src\game` 228 · `ac\shared` 145 · `portal\client` 78 · `ac\client` 47 | the original build tree, client/shared split included |

**VA arithmetic, verified:** `VA = 0x401000 + section-1 offset`. Checks:
`ACCWeenieObject::ObjectBeingDeleted` `[0001:0018D4D0]` → `0x0058E4D0` ✓ (the doc's address);
`CObjectMaint::DeleteObject` `[0001:001074D0]`, `Cb: 0xFF` → `0x005084D0`, 255 bytes ✓ (the 2015
doc's address *and* its byte length).

**Worked proof that this produces facts the deep-dives do not have.** Resolving the three leak
functions through the line blocks:

| Function | VA | Original source | Original lines |
|---|---|---|---|
| `CObjectMaint::DeleteObject(unsigned int)` | `0x005084D0` | `d:\ac1_sep13\portal\client\src\objects\cobjmaint.cpp` | **627–672** |
| `CObjectMaint::DestroyObjects` | `0x00508C30` | same file | **345–394** |
| `ACCWeenieObject::ObjectBeingDeleted` | `0x0058E4D0` | `d:\ac1_sep13\ac\client\src\objects\accweenieobj.cpp` | **739–799** |

And the defect itself: the miss-jump `je 50858c` at VA `0x0050857D` → offset `0x10757D`, which falls
between the pairs `652 @ 0010755B` and `672 @ 0010757F` → **`cobjmaint.cpp:652`**. The
`ObjectBeingDeleted` call at `0x0050859E` → **line 657**. *Retail's primary memory leak is one
missing fallback at `portal/client/src/objects/cobjmaint.cpp:652`.* That statement did not exist
before this file.

**It also explains *why* the bug happened** — a causal account neither deep-dive offers.
`CObjectMaint` is **PORTAL**-layer (`portal/client/src/objects/cobjmaint.cpp`); the hook it must call
is **AC**-layer (`ac/client/src/objects/accweenieobj.cpp:739`). The virtual is declared in the
PORTAL base — `CWeenieObject::ObjectBeingDeleted` exists as its own symbol at `[0001:001085E0]`,
`Cb: 0x84` = 132 bytes of real work, not an empty stub. So the PORTAL-layer bulk sweep
(`DestroyObjects`, same file, 50 lines above its sibling) omits a virtual whose meaningful
implementation lives in a different library that the PORTAL author had no reason to read. **Defect 2
is a layer-boundary defect, not a typo.** That reframing is what makes it worth generalising to our
own wasm/JS boundary (see §3).

**Proposed change.** One generated TSV, `acclient-deep-dives/2013-09-11.4186-v3/symbols.tsv`,
produced by a single awk/python pass over `acclient.txt` joined to `func_index.tsv`:

```
va  size  layer  obj  src_file  src_first_line  src_last_line  decomp_line  decomp_end  name
```

Build notes for whoever implements it:
- Two passes over `acclient.txt`: (1) collect `S_GPROC32`/`S_LPROC32` → `(name, offset, Cb)`;
  (2) collect line blocks with their owning module + source file and their `(line, addr)` pairs.
- `layer` comes from the `from "…\output\lib\{ENGINE,PORTAL,AC,GAME}\…"` clause of the enclosing
  `** Module:` line, cross-checked against the source path root (`src\engine`, `src\game`,
  `portal\*`, `ac\*`).
- **Map VA → line by *containment*, not equality.** There are 25,393 distinct block starts against
  13,830 distinct section-1 `S_GPROC32` offsets, so blocks are finer-grained than functions (inline
  and template instantiations get their own blocks) and one function can span several. Function start
  == block start held in all three spot checks, but do not rely on it.
- Join to `func_index.tsv` on the demangled name. **Overloads collide** — `CObjectMaint::DeleteObject`
  appears twice with different type ids (`0x5A64`/`0x5A60`) and the PDB records carry no argument
  list. Disambiguate by `Cb` against the decomp body length, and mark unresolved rows rather than
  guessing. Expect ~700 such names (15,535 distinct names across 16,232 `S_GPROC32` records).
- Emit a `.sha256` of `acclient.txt` and `func_index.tsv` in a header comment so a stale index is
  detectable — same discipline as `bake-source.sha256`.

**Payoff.** Four lookups (decomp line, VA, byte size, original `file:line` + layer) collapse into one
row. It closes the README's own "not yet exploited", needs no PDB, and — per 2015 §7's four failed
heuristics — derives from the authoritative record instead of a byte scanner.

**Effort:** M (one script, ~150–250 lines; the format is regular and the whole input fits in page
cache — the two verification passes above took under a second each).

---

### TOOL-02 — A `decomp` lookup script (S)

Thin CLI over `symbols.tsv` + `func_index.tsv` + `acclient.c`:

- `decomp body 'CPhysicsObj::calc_friction'` → the **exact** body (uses derived extents; fixes the
  `+60` truncation).
- `decomp class CMotionInterp` → every method with decomp line, byte size, original file:line.
- `decomp at 0x0050857D` → function + original `file:line` (the query that produced
  `cobjmaint.cpp:652`).
- `decomp file 'cobjmaint.cpp'` → every function from that original source file, in original line
  order — the fix for the README's own complaint that COMDAT ordering scattered `CPhysicsObj`'s 230
  bodies across 200,000 decomp lines.
- `decomp layer AC --class 'ACC*'` → layer-filtered listing.

**Payoff:** the truncation bug goes away permanently, and "read this subsystem the way Turbine
organised it" becomes a one-liner. **Effort:** S. **Validation:** golden test — `decomp body` on
`calc_friction` must return 68 lines and end on the closing brace.

---

### TOOL-03 — Fold the index into `MEMORY.md`'s rapidgrep recalls, and fix the truncation footgun (S)

`MEMORY.md` §3 `retail-decomp` currently teaches `rg -n 'Namespace::Method\(' $DECOMP/acclient.c |
rg -v ';'` then `sed -n 'N,+60p'`, described as "THE workhorse". Two problems, both now measured:
the `+60` truncates any body over 60 lines (calc_friction is 68), and the `| rg -v ';'` filter is a
workaround for a distinction the index makes exact.

Proposed replacement recall block (user-approved edit; `MEMORY.md` is read-only per its own header,
and the file is near its ~24.4 KB budget so this should *replace* text, not add):

```
- find-function-body — awk -F'\t' over $DDIVE/func_index.tsv → exact start+end, then sed that range.
  Bodies only (no prototypes/call-sites); 36,601 rows, strictly ascending. NEVER `sed -n 'N,+60p'`
  (truncates: calc_friction is 68 lines).
- symbol→VA→original file:line — $DDIVE/symbols.tsv (TOOL-01): VA = 0x401000 + [0001:offset].
- original-source grouping / 4-layer split (PORTAL·ENGINE·GAME·AC) — symbols.tsv `layer`/`src_file`;
  raw source is `** Module:` + `line/addr pairs` records in $DECOMP/acclient.txt (rg -a).
```

Also worth adding: `DDIVE=$REPO/external/acclient-deep-dives/2013-09-11.4186-v3`.

**Payoff:** the indexes are currently used by **nothing** — a repo-wide grep for `func_index`,
`class_index`, `struct_index` outside the deep-dive directory returns one false positive (a
`per_token_class_index` function in an unrelated ML script). Assets nobody references have zero
value; a memory recall is the cheapest possible integration. **Effort:** S.

---

### TOOL-04 — Materialise the original source tree as a browsable map (M)

`symbols.tsv` makes this a projection: `src_file → [functions, original line order, decomp line
ranges, layer]`. Emit one markdown/TSV index per layer (1,139 project source files: ENGINE 380,
GAME 228, PORTAL 339, AC 192).

**Payoff.** Three things nothing else gives us: (1) reading a subsystem in the author's own file
order instead of COMDAT order; (2) the layer boundary as an explicit artifact — which is what turned
Defect 2 from "a typo" into "a cross-library omission" (TOOL-01), and which our own
wasm↔JS↔three.js boundary mirrors; (3) a completeness check for the deep-dives themselves — e.g.
"which `ac/client/src/ui/systems/*.cpp` files does no report cite?" is answerable, which is exactly
the kind of coverage question the mining waves keep having to guess at.

**Effort:** M (a projection script plus a decision about output granularity). **Validation:**
`cobjmaint.cpp` must list `DeleteObject` twice (two overloads), `DestroyObjects`, `GetNullWeenieObject`,
`UseTime`, `AddObjectToBeDestroyed`, `QueueBlobForWeenieObject`, `~CObjectMaint` with the ranges the
2015 doc's §0 table already publishes — a free cross-check against an independent source.

---

### TOOL-05 — Cross-reference retail symbols against ours (M/L)

Join `symbols.tsv` names against our symbol universe: `crates/**/*.rs` + `apps/holtburger-web/src/*.rs`
+ `scene3d/*.js` (we already cite `acclient.c:NNNN` in hundreds of comments), `external/ACE`,
`external/chorizite/ACBindings` (which already carries `Offset: 0x…` annotations per `MEMORY.md`),
and `DatReaderWriter`.

**Payoff.** A mechanical parity ledger: for each retail class/function, do we have a counterpart, and
does our comment cite a line inside its real body? That last check is worth the whole task — the
VERIFICATION-LOG records agents citing stale or wrong `acclient.c` lines, and a join can flag every
citation in our tree that falls outside the cited symbol's verified extent. That converts
"citations are hypotheses" (MEMORY's `verify-agent-leads` rule) into a build-time check.

**Effort:** M for the citation-validity check alone (parse `acclient.c:NNNN` from our comments,
resolve NNNN through `func_index.tsv`, report the enclosing function, diff against the symbol named
in the same comment). L for full name-level parity coverage. **Recommendation: build the citation
checker first** — it is the high-value half and it is nearly free once TOOL-01 exists.

---

### TOOL-06 — Field-offset/enum-value index for structs (M)

`struct_index.txt` carries only `line:declaration` (7,553 rows) — it locates a struct in
`acclient.h` but says nothing about byte offsets. The byte-offset truth lives in `acclient.txt`
(`LF_FIELDLIST`/`LF_MEMBER`/`LF_ENUMERATE`), and `MEMORY.md` §3 already documents a hand-rolled awk
recipe requiring a manual typeid hop (`class name = X, UDT` → fieldlist typeid → awk). That recipe
works but is two steps and easy to get wrong (the note "skip 0x0000 FWD REF" is exactly the trap).

Materialise it: `structs.tsv` = `type_name, field_name, byte_offset, type_id` and `enums.tsv` =
`enum_name, value, symbol`, generated once by the same pass as TOOL-01 (897 enums and 6,936 structs
per the README).

**Payoff.** Direct wire/DAT/layout parity checks against our Rust structs and DRW's `dats.xml`
without a per-lookup awk. This is the highest-frequency query class in the DAT and protocol work
(`MEMORY.md` documents four separate offset recipes for it), and it eliminates the fieldlist-hop
error mode. **Effort:** M. **Validation:** reproduce the four typeids already in `MEMORY.md`
(`11a19` CPhysicsObj, `15a69` ParticleEmitterInfo, `11fbf` CGfxObj, `15827` CSetup) and the four
enums (`4c09` PhysicsState, `4c05` PScriptType, `61d3` TerrainType, `4c5b` INVENTORY_LOC) exactly.

**On a WorldBuilder.Terminal command instead of a script — recommend against for v1.** WBT's 216
commands are about DAT/world/ACE data, the JSON-stdin protocol adds a build step and a rebuild-staleness
trap (`MEMORY.md` already documents "DLL stale? → rebuild"), and a decompilation index is
developer tooling with no project scope. Files + a script + a memory recall reach every agent with
zero build cost. Revisit only if TOOL-06's struct/enum lookup becomes routine enough that the
`worldbuilder-terminal` skill should surface it.

---

## 3. DEFECT-CLASS TABLE

The main analytical deliverable: each retail leak generalised past its binary-patch specifics, with
whether our object graph can violate the same invariant.

| # | Retail defect | Violated lifetime invariant | Can holtburger violate it? | Evidence |
|---|---|---|---|---|
| **D1** | `null_weenie_object_table` unreapable (`acclient.c:309986-310002`) | **Every container that can hold an object must be searched by the path that destroys it.** Retail searched 1 of 2. | **YES — live, in two independent places.** | (a) `maintain_bridge_indexes_on_delete` (`src/lib.rs:28725`) prunes 8 per-guid stores; **9 more have zero removals** (LEAK-01, hit lists exhausted). (b) `EntityManager.remove()` early-returns at `entities.js:9936-9937` when the guid is not in `entityMap`, before the block that purges `_pendingAttach`/`_pendingVisibility`/emitters/timers — the literal analogue of retail's `je` on a bucket miss (LEAK-02). |
| **D1′** | The placeholder's 25 s destruction timer fires into a no-op `DeleteObject` (`:310757`, `:310271`) | **A parked placeholder must expire even if its subject never arrives.** | **YES — and our working expiry is switched off.** | `?preCreateBuffer` implements retail's FIFO + 25 s expiry + despawn purge, is headless-verified, and is a strict `=== "on"` opt-in defaulting OFF (`entities.js:153-161`, `docs/url-flags.md:614`). The live default maps have no sweeper at all (LEAK-02). |
| **D2** | `IconData` stranded because `DestroyObjects` calls vtable slot 0 only (`:310619` vs `:309997`) | **A bulk teardown must run the same per-object protocol as the single teardown.** | **NO for entities — we hit this and fixed it. YES residually for unmapped guids and for the Rust caches.** | Fixed: `entities.js:15184-15200` `dispose()` routes every entity through `remove(g)` and its comment names the exact bug ("the old loop… LEAKED the manager-side bookkeeping `remove()` owns: particle emitters, pending Sound/SoundTable/CallPES timers, entity-attached lights"); `clearWorldEntities()` (`:15084-15099`) does the same. Residual: neither clears side tables for guids **not** in `entityMap` (LEAK-01/02), and `ByteBudgetLru::clear` (`src/lib.rs:9225`) bypasses the `evictable` predicate that `insert` (`:9216`) honours (LEAK-10). |
| **D2′** | Retail's cross-layer cause (new, from TOOL-01) | **A virtual hook implemented in a higher layer must be invoked by every lower-layer teardown path.** | **YES, and our boundary is worse-shaped.** | `CObjectMaint` is PORTAL (`portal/client/src/objects/cobjmaint.cpp:345-394`); the hook's real implementation is AC (`ac/client/src/objects/accweenieobj.cpp:739-799`); the PORTAL base's own `CWeenieObject::ObjectBeingDeleted` is 132 B of real work. Our equivalent boundary is wasm↔JS, where the hook is a `#[wasm_bindgen]` handle whose `free()` is the JS caller's duty — and we have already shipped a double-`free()` there (`materials.js:4032-4039`, the "null pointer passed to rust" burst). Covered by PAL-03. |
| **D3** | Recycled `ItemList` widget pins its last icon (`:274174`, `:273978`) | **A pooled slot must release its payload on return to the pool, not on reassignment.** | **NO in the governed pool; YES in the paletted cache, and it is unmeasurable.** | Warm-park deliberately keeps GL buffers on park (`landblock_lru.js:143-144`) **but is governed** — `MAX_LIVE_GEOM`, byte pressure, age floor, per-frame dispose budget, all born from a measured 22.6 s bulk-dispose stall. Paletted eviction, by contrast, disposes the GPU handle while a live mesh keeps `image.data` (`materials.js:3006-3012`) and the bytes are counted by **neither** `palMB` (decremented at eviction, `:3016`) **nor** `entMB` (`entity_owned_tally.js:111` only counts registered entity-owned textures) → LEAK-06. |
| **D4** | System RAM structurally unreclaimable (`m_bIsThrashable` = 0 default `:131482`, required by both purge paths `:131206`/`:131609`); purge gate never fires on modern VRAM | **A memory pool with no reclaim path converts every other defect from transient to permanent.** | **YES — this is our #1 live crash class.** | `WebAssembly.Memory` grows only. `A15-rss-decision-2026-07-20.md`: reproducible ~2.8 GB crash every ~30 min of roaming, `wasm_memory_bytes()` climbing while JS heap stays flat ~93 MB; three fix options awaiting a user decision. Our purge-gate equivalent is *better* than retail's — `RECLAIM_GATE_MAX_HOLD_MS = 10_000` (`landblock_lru.js:257`) is precisely the starvation escape retail lacked (LEAK-05). |
| **D5** | `m_PendingGets` survives completion **and** failure; `ReadyToUnhash` is dead code (`:84818`); **no timeout** anywhere in `AsyncCache`; `OnAsyncGetFromOtherSourcesFailed` dead (`:85466`) | **An in-flight-request registry must retire on every terminal outcome, including "never terminated".** | **Retire: NO (fixed). Timeout: YES, and our consequence is worse.** | `inflight.rs:230-237` retires TOCTOU-safely on `Ok` and `Err`. But zero hits for `timeout`/`AbortController`/`AbortSignal` across all 9 files of `crates/holtburger-resource-http/src/`, and waiters latch the same `Shared` future, so a never-settling fetch makes the URL permanently unfetchable — not merely leaked (LEAK-08). `in_flight_count()` exists but is `#[allow(dead_code)]`. |
| **D6** | `ImgTex::temp_buffer_table` — "no removal code anywhere" (`:45328`); `lost_cell_table` session-lifetime | **A cache with no removal path is a permanent floor even when it is not a leak.** | **YES ×3 (bounded), plus 2 clear negatives.** | Never-removed: `_holdingLocCache` (`entities.js:5765`), `_placementFrameCache` (`:5811`), `_sortCenterCache` (`:10263`) — LEAK-07. Clear negatives worth recording: `terrain_heights_shadow` is wholesale-replaced per tick (`src/lib.rs:49100`), and `MISSING_SURFACES` (`:8932`) is clearable and gated on a catalog absence proof (`:8901-8925`). |
| **D7** | Retail's *bounding* property: "a Get-without-Release **pins** a DID; it does not allocate" — cost = distinct DIDs × size, independent of execution frequency | **Sharing by key makes a leak's cost cardinality-bounded.** | **We break this in the recolor path — our per-wearer duplication makes cost scale with execution count.** | `DESIGN-recolor-residency-2026-07-26.md` §1: retail composites per wearer *but releases on despawn* (`CPhysicsPart::RestoreSurfaces` → `releaseCustomSurface` → `~ImgTex`, `acclient.c:314553-314580`); we share by `(did|palette|subs)` key **but never release**, and past the cache budget we degenerate into per-wearer duplication anyway (`materials.js:2203-2213`). 50 identically-dyed wearers: retail ≈17 MiB heap + 16.6 MiB VRAM; us ≈37.5 MiB heap. **So retail's reassuring bound does not transfer, and any of our leaks can be unbounded in execution count.** This is the single most important inversion in the table. |
| **D8** | Failure-as-truth (retail's own R-7-equivalent trap does **not** appear in these docs; the class is ours) | **A transient failure must never be memoised as a permanent fact.** | **YES ×2 live, after we already learned it once.** | Learned: `src/lib.rs:8901-8925` documents the R-7/A07-F1 grey-surface latch and the fix (memoise only on catalog-authoritative `key_known_absent`). Not applied: `ui/ac_icon_cache.js:50,:77→:82` caches `false` forever (LEAK-03); `audio/audio_manager.js:329` caches a null-resolving promise forever (LEAK-04). `sound_table_cache.js:180` gets it right, next door. |
| **D9** | Over-release: `CObjCell::Get` returns a borrowed interior pointer the sole caller unconditionally releases (`:346730` → `:307512`, caller `:146683`) | **Ownership of a returned pointer must be unambiguous.** | **YES in kind — already fired once.** | Rust has no `Release`, but the wasm-handle boundary reproduces it exactly: `materials.js:4032-4039` records a path that double-consumed an already-`free()`d `SurfacePixels`, whose `sp.width` getter threw "null pointer passed to rust" (the 100-error burst in the stutter diagnostic). Retail's version is a crash risk; ours was a caught error burst. Audit covered by PAL-03. |

---

## 4. INDEX-TOOLING SPEC — summary

Full detail in TOOL-01..06. The shape of the recommendation:

| Build | What | Size | Payoff |
|---|---|---|---|
| **1** | `symbols.tsv` — VA · size · layer · obj · original `file:line` · decomp extent · name, generated from `acclient.txt` + `func_index.tsv` | **M** | The join. Closes the README's "not yet exploited" with no PDB. Already produced `cobjmaint.cpp:652` and the D2′ layer-boundary insight. |
| **2** | `decomp` CLI (`body` / `class` / `at` / `file` / `layer`) | **S** | Kills the `sed +60` truncation permanently; makes original-source reading order a one-liner. |
| **3** | `MEMORY.md` recall-block replacement + `DDIVE` constant | **S** | Without it the indexes stay at their current usage: **zero references anywhere in the repo.** |
| **4** | Original-source-tree projection (1,139 files; ENGINE 380 / GAME 228 / PORTAL 339 / AC 192) | **M** | Author's file order; explicit layer boundaries; deep-dive coverage gaps become answerable. |
| **5** | Citation checker: every `acclient.c:NNNN` in our tree resolved to its enclosing function and diffed against the symbol the comment names | **M** | Turns MEMORY's `verify-agent-leads` rule into a mechanical check. Build this half of TOOL-05 first. |
| **6** | `structs.tsv` / `enums.tsv` field offsets + enum values (6,936 structs, 897 enums) | **M** | Removes the two-step fieldlist-typeid hop and its FWD-REF trap from the highest-frequency query class. |

**PDB line-information opportunity — assessed separately, as instructed.**

- **What it would give us that we lack:** VA → original `file:line`; grouping the 36,601 scattered
  decomp bodies by their 1,139 original source files; recovery of the four-layer
  `PORTAL`/`ENGINE`/`GAME`/`AC` split with its client/shared subdivision; exact byte lengths for
  every one of 39,948 functions (a free cross-check on any address claim); and — demonstrated above —
  the ability to state a defect's location in Turbine's own source coordinates.
- **How to extract it:** **not from the PDB.** `acclient.pdb` is absent from this machine (a
  filesystem-wide `*.pdb` search finds only .NET artifacts), and no PDB tooling is installed. It is
  unnecessary: the 82 MB `ac-headers/acclient.txt` dump — which `MEMORY.md` already treats as a
  first-class oracle — contains the complete symbol table (16,232 `S_GPROC32` + 23,716 `S_LPROC32`,
  matching the README's own counts exactly), all 1,091 module records with their lib attribution,
  and all 27,568 line/address blocks over 1,327 distinct source paths. One awk/python pass, ~150–250
  lines, seconds of runtime.
- **Caveats an implementer must respect:** blocks are finer-grained than functions (25,393 block
  starts vs 13,830 section-1 GPROC offsets) so VA→line must be a *containment* lookup; overload names
  collide because PDB records carry no argument list (disambiguate on `Cb`, flag the rest); and
  `VA = 0x401000 + [0001:offset]` holds for section 1 (verified on three known addresses) — do not
  extend that arithmetic to other sections, per the 2015 doc's `.data`-tail correction.
- **Bottom line:** the highest-leverage tooling item in this file, and it needs a file we already
  have.

---

## 5. ANTI-TASKS — binary-patch-era machinery not to port

1. **Code caves.** `DwExceptionFilter` (0x006B5820 / 0x006B6760, 1292 B) and the whole Watson-block
   xref analysis. No analogue; nothing to learn beyond "dead ≠ unreferenced", which is already a
   general rule.
2. **The `ACPlugin` registry DLL-injection delivery vehicle.** Elegant for retail, meaningless for
   us — and its own caveat (the server can enumerate loaded plugins via `QueryPluginList`) is a
   retail-server concern.
3. **PE arithmetic** (`file offset = VA − 0x400000`, checksum recomputation, `DYNAMICBASE`
   reasoning). Keep only as provenance for wave0's palette patch, which is already applied and
   verified.
4. **vtable-slot indexing as a calling convention.** Both docs correctly conclude "call the address
   directly". Do not build any holtburger machinery that resolves a hook by index; the transferable
   rule is *resolve by symbol* — which our `#[wasm_bindgen]` boundary already does.
5. **Retail's 20 s `SendForceObjdesc` re-request nag.** `docs/url-flags.md:885` deliberately omits
   it (ACE support unresolved). Do **not** implement it: it is the leak's *symptom* and its
   observable signature, not a mechanism worth reproducing. If a stranded-placeholder detector is
   ever wanted, count parked buckets — do not send packets.
6. **The `m_bIsThrashable` flip.** Both docs say don't, for a reason we independently rediscovered
   (device-loss/context-loss restore source). Recorded in D4 so nobody proposes the JS twin
   ("drop `image.data` after upload") a third time.
7. **Process-working-set measurement as the primary leak instrument.** Right for a 32-bit Win32
   binary, wrong for us — the 2026-07-26 retraction is the local proof. Use the four instruments in
   §0b.

---

## 6. DOC CORRECTIONS AND VERIFICATION RESULTS

**Three of the 2013 report's "verified personally by direct read" claims re-checked against
`/home/wbterminal/ac-headers/`. All three HOLD.**

1. **The `DeleteObject` asymmetry — CONFIRMED.** `acclient.c:309939-310007` read in full. The
   physics half searches `object_table`, falls back to `null_object_table`, and deletes either way;
   the weenie half searches `weenie_object_table` only, `goto LABEL_16` on a miss, and the
   `null_weenie_object_table` removal sits inside `if (v4)`. Exactly as documented.
   *One detail the docs do not mention:* on a weenie miss the function returns **0 even when the
   physics half succeeded** (`LABEL_16: result = 0` discards `retval`), so a caller reading the
   return value sees failure for a physics-only object. Harmless given the actual callers, but it
   would matter to anyone writing the Fix-1 detour, which is specified as "if it returns 0…".
2. **`~ACCWeenieObject` never touches icon or stamper state — CONFIRMED.** `acclient.c:437260-437282`
   read in full: `PlayerDesc::Cleanup` + `Release`, `~PublicWeenieDesc`, `~TSRecv`,
   `~NoticeRegistrar`, vptr rewrites, `hash_next`/`id` zeroing. No icon reference. The trailing
   Hex-Rays comments name **both** vtables (`7E3E88` and `7E3EA0`), consistent with §8b.
3. **Both in-place corrections landed.** The vtable-label inversion fix is present at
   `11-memory-leak-investigation.md:528-531`, and the section-mapping correction at `:500`. The
   README's claim that both were "corrected in place" is accurate.

**No factual errors found in either leak document.** That is unusual for this exercise and worth
recording: after three verification passes plus the 2015 byte-comparison pass, these two documents
appear to be clean. The two corrections the README advertises are real and are already applied.

**Corrections/adjustments to the framing rather than the facts:**

1. **The prompt's premise that the index files save "an expensive rg over a 31 MB file" is
   measurably wrong** (11 ms warm on `acclient.c`, 21 ms on the 82 MB `acclient.txt`). The real value
   is exactness (body extents, prototype/body separation), aggregation, and joins. TOOL-01 is
   justified on those grounds instead — see the four reasons there. Worth correcting so nobody
   evaluates the tooling against a benchmark it does not need to win.
2. **`MEMORY.md`'s canonical `sed -n 'N,+60p'` recipe silently truncates bodies.**
   `CPhysicsObj::calc_friction` — the recipe's own worked example — is 68 lines (316091–316158).
   Every agent that followed the recipe on that function read a truncated body. TOOL-03.
3. **Source-path count:** README says ~1,460 distinct source paths; my extraction measures 1,327. My
   regex is approximate (it anchors on two-space indentation and `(None)`), so this is measurement
   noise, **not** a doc error. Flagged only so the next person does not treat either number as exact.
4. **The 2015 doc's §7 methodology warnings deserve promotion out of a provenance section.** Four
   successive heuristics reported 2.7 / 3.5 / 40.2 / 0.84 % of functions changed and *every one was
   wrong*; only the relocation table was authoritative. That is the strongest available argument for
   deriving indexes from records rather than scanners, and it is currently buried at the end of a
   companion document.

---

## 7. OPEN QUESTIONS

**Leaks (each needs a run, not a read):**

1. **Which of LEAK-01's nine maps actually grows in a normal session?** All nine are structurally
   unpruned, but the *rate* depends on how often ACE deletes objects we have examined/opened. Retail
   asked exactly this question about its own primary leak ("how often the server references an object
   whose `0xF745` never arrives determines the rate; the analysis can only show it is unreapable")
   and could not answer it either. `bridge_index_sizes()` + one roam settles it.
2. **Does ACE recycle dynamic GUIDs within a single session?** If yes, LEAK-01 is a *correctness*
   bug (stale appraisal/icon/vendor data), not just a memory one — retail's §3 predicted precisely
   this symptom class. Answerable from ACE's guid allocator without any client work.
3. **Does the icon cache ever get near its 30 MB ceiling on the lazy path?** The 4,224-icon figure is
   the `?preloadIcons=1` bulk case; the lazy path's realistic cardinality is unknown. LEAK-03's
   instrument answers it in one session.
4. **Can a wasm-side fetch actually hang indefinitely in practice**, or does the browser always
   settle it? LEAK-08's blackhole test answers this directly, and the answer decides whether the
   AbortController is a fix or belt-and-braces.
5. **Is the ~2.8 GB RSS crash driven by peak *transient* bytes or by cache residency?** The A15 doc
   asserts transients; the peak instrument in LEAK-05 is what makes the assertion testable, and it
   decides between options (a) and (b).
6. **How much of the July settle/age-collapse observation survives the retraction?** The retraction
   keeps the wall-clock medians as real but withdraws their "GC pressure from a giant JS retained
   set" mechanism. With the V8 heap at ~50 MB, the driver hunt moves to wasm-side caches and eviction
   churn — which is where LEAK-05/06 point. Not this wave's scope, but it is the same investigation.

**Tooling:**

7. **Do we want `symbols.tsv` for the 2015 build too?** No PDB ships for 11.6096 (2015 §4.1), so its
   symbols exist only by the relocation-exact matching the 2015 doc performed. The 2013 index plus
   that doc's 23-row translation table may be sufficient; generating a 2015 twin would require
   redoing the matching, which is an XL.
8. **Should `struct_index.txt` be superseded or supplemented by TOOL-06?** Supplemented, probably —
   the line-in-`acclient.h` lookup is still the fastest route to a *declaration*, while `structs.tsv`
   answers *layout*. Worth deciding before both exist and diverge.
9. **Is the citation-checker (TOOL-05 first half) worth running against the deep-dives themselves,
   not only our code?** Every `acclient.c:NNNN` in the 11 reports could be resolved to its enclosing
   function and checked against the symbol the prose names. Given that these two documents came out
   clean under manual spot-checking, a mechanical pass over all eleven would be a genuinely
   informative test of both the corpus and the tool.
