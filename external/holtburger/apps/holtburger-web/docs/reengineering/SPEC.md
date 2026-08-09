# SPEC — holtburger-web rendering/streaming pipeline re-engineering

**Unified architecture + implementation spec.** Produced by pass 12 of the 12-pass
effort recorded in `TRACKING.md` (2026-08-08).

---

## 0. Status

### 0.1 What this document is, and its authority

This is the single normative spec for re-engineering the pipeline (bake → wire →
Rust/wasm → JS → three.js → frame). **Where this document and a pass file differ, this
document wins.** The pass files (`pass-01` … `pass-11`) are design history: each section
below cites the pass that carries its full rationale, measurements, and rejected
alternatives. An implementing agent should be able to work from this document alone,
descending into a pass file only when the "why" matters.

Ground rules inherited unchanged and still binding on implementation:

- **The walls** (survey §6) are settled law: no draws×µs frame predictions; draw count
  is not a proxy; parked ≠ moving; resident ≠ drawn ≠ submitted; allocated ≠ used;
  never compare across boots; fresh Chrome per bench arm; structural render changes
  need an owner eye-test (pixel-diffs inadmissible, 16.9% same-arm noise floor); the
  frame is CPU-bound until re-measured; propagate verdicts to the docs agents read,
  same day.
- **Scale tags** (pass 10 S1) on every figure; **[M]** measured / **[D]** derived /
  **[A]** assumed-pending-measurement on every number.
- **Flag policy** (pass 9 D-09.3): every stage flag is DEV (`=on` opt-in) →
  VALIDATED → DEFAULT-ON (`flagIsOff`-family `*Enabled()` reader, `=off` escape) →
  RETIRED; url-flags row + lint/audit green in the landing commit.
- **The live client keeps working at every stage.** Every stage's OFF arm is today's
  code path until ST10.

### 0.2 The two blockers, resolved up front

1. **Converged terrain (F-11.1).** The old B4 (≤ 45 MB to `converged`) omitted the
   bare-default t1024 terrain tier (81 MB wire [M]); the honest number was ≈ 144 MB at
   q75. Resolution (pass 12 D-12.1, SUPERSEDES charter D-01.2/D-01.3): the tier ladder
   is **t128 at boot → `converged` stamps with terrain at t128 → t1024 streams
   post-converged, default-ON, non-budgeted, on idle lane T**. B4 splits: **B4a ≤ 65 MB
   gated** (expected ≈ 63 at q75 / ≈ 42 at rdo [D]) and **B4b ≈ 144 MB reported, never
   gated**. Owner escape recorded at ST6 (§3, task T16). The 2026-08-05 "t1024 by
   default" user direction is preserved — every session still ends at t1024; only its
   position in the T3 fetch order changes.
2. **App shell (F-11.2).** The shell is ~270 unbundled no-cache module requests
   (266 modulepreload links [M]) — the old B2 "~10 code" and B5 "1 request" were false.
   Resolution (pass 12 D-12.2): a **bundling stage (ST-SHELL)** is added — esbuild
   (no-npm single binary), entry points = main + 4 workers, content-hashed output on
   the immutable-CAS header tier, `index.html` a small no-cache loader, SW untouched.
   Cold shell ≈ 8 requests, warm ≈ 1; **B2 ≈ 52 ≤ 64 ✓, B5 ≈ 2 ≤ 5 ✓** [D]. Budgets
   bind on the deployed (bundled) artifact; the dev loop stays unbundled. Fallback if
   bundling is rejected: split-budget restatement, pre-specified in §5 R-02.

### 0.3 Pass-11 findings disposition (line-by-line, per charter A5)

| finding | sev | disposition |
|---|---|---|
| F-11.1 B4 terrain omission | BLOCKER | Resolved §0.2.1 / D-12.1: ladder end-state committed, B4a/B4b split, formal SUPERSEDES, owner escape at ST6 |
| F-11.2 app shell ~270 requests | BLOCKER | Resolved §0.2.2 / D-12.2: ST-SHELL stage; B2/B5 stand; fallback pre-specified (R-02) |
| F-11.3 missing flag edges | MAJOR | Applied §3/§4: `?drawPools` needs slotGrid+packSource+geomBundles+texCompressedOnly; kill-cascade rule; ST5→ST9 edge; parallelism claim corrected |
| F-11.4 ST7 adapter designed nowhere | MAJOR | Applied §1.4/§3 T20: ST7 requires `?packSource` (fetch adapter eliminated); grid→legacy-producer adapter spec'd with `gridLruDivergence = 0` acceptance |
| F-11.5 walk-widening unowned | MAJOR | Applied §3 T10/T12: ST1 emits MotionTable/PhysicsScript/SoundTable edges (K-tier sized, bytes reported by BAKE-CI), ST2 consumes; ST10 criterion reachable |
| F-11.6 t128 request count | MAJOR | Applied §1.5: t128 slice = ONE CAS file per channel (+2 requests, in the B2 table); t1024 keeps per-payload granularity on lane T |
| F-11.7 no budget×stage map | MAJOR | Applied §2.2: binding-stage column for all 25 IDs; earlier gates score comparative only |
| F-11.8 crypto.subtle premise | minor | Applied §1.1: loopback tunnel origin IS secure; wasm-sha fallback kept; P-SUBTLE = confirmation |
| F-11.9 count is 25 | minor | Applied: 25 budget IDs throughout |
| F-11.10 nullRender uploads | minor | Applied §1.6: under `?nullRender=1` W2 marks only, never calls `initTexture` |
| F-11.11 SW allowlist conflict | minor | Applied §1.1: one v3 spec; `shards/` allowlisted until ST10 |
| F-11.12 M3 instance wording | minor | Applied §2/§5: census must sum every instance that EXISTS in the run's configuration (supersedes pass 6 S5(d) wording) |
| F-11.13 CENSUS-CLASS late | minor | Applied §3 T00: CI arm is a pre-implementation spike |
| F-11.14 run-speed unowned | minor | Tracked §5 R-06 |
| F-11.15 debt-map gaps | minor | Tracked §5 R-09 (texchan), R-10 (hosting shape) |
| F-11.16 post-coverage ring bytes | minor | Applied: BAKE-CI ring re-score runs against POST-coverage corpus; slack on R-01 |
| F-11.17 ST5 re-home throwaway | minor | Applied §3 T15: conscious line item; `atlasRefeed` seam producer-agnostic |
| F-11.18 three #34054 fix | minor | Applied §3 T22 + §6: load-bearing dependency named; retirement condition registered |
| F-11.19 bake dispatch unowned | minor | Applied §1.6: P1 records, P4 dispatches (distance-ordered, concurrency 1, purge on vacate) |

Pass 11's walls audit found **zero violations** in passes 1–10; its read-verification
list (pass 11 "Read-verification results") lets this spec cite those mechanisms as
double-checked: three r184 BatchedMesh early-out / `setVisibleAt` semantics /
`initTexture`-handles-CompressedArrayTexture / `compile`'s scene-only walk; the
one-transferable exit contract; manifest field-presence routing; netWorker default-OFF;
fixed-grid partially-built; SwiftShader-BPTC-present; the dist byte facts.

### 0.4 Invariant coverage (charter A3)

| invariant | disposition (charter D-01.7, kept-degrees verbatim) | implementing structures |
|---|---|---|
| I1 per-record HTTP + decode-as-discovery | BROKEN for world content; per-record legacy lane remains for equipment/other-player appearance/admin-spawned/no-BPTC fallback | HBP1 packs + HBSI1 index (§1.1), PackFetchController + PackSource (§1.1), per-pack hash verify |
| I2 runtime triangulation, de-indexed, clone-across-boundary | BROKEN for static world geometry; KEPT for substitution-bearing models (per-character, unbakeable) | HBG1 baked indexed geometry + GeometryBundle one-copy exit (§1.2); entity path keeps today's decode unmemoized (dormant cache designed, gated on measurement) |
| I3 RGBA8-first double-build | BROKEN; residual RGBA8 decode only as no-BPTC fallback + entity/palette-substituted surfaces | preview-born materials + XUBC7 sole full codec + texture worker (§1.3) |
| I4 per-LB rebuild residency | BROKEN | tile-granular 6×6 slot grid + refcounted budgeted Rust stores with never-zeroed floors (§1.4) |
| I5 per-(LB,surface) draws + per-placement nodes | BROKEN for statics/terrain/envcells; KEPT for entities (27 draws @ 12.7 µs [M] — not the cost); animated scenery stays on the landed instanced path | (sector, material-class) BatchedMesh pools + O(pools) scene graph (§1.5) |

---

## 1. Architecture overview (normative, condensed; amendments marked)

### 1.1 Packs, wire, fetch (source: pass 2, pass 3; amended by D-12.2/D-12.5/D-12.6, F-11.8/F-11.11)

**Dist format.** The world ships as `HBP1` sectioned packs (per-section zstd, served
identity, CRC32 footer, truncated-sha256-16 CAS names):

- **Tile packs** — one per 2×2-LB tile (15,847 non-empty [M]); carry terrain records
  (4 × 252 B), LandblockInfo, binary PLACEMENTS rows (44 B), SPAWNS/EVENTS (zstd JSONL
  v1), small EnvCell sets (≤ 32 KiB/LB), inline closure records (K ≤ 4 tiles), GEOM
  payloads, TEXREF rows, REFS edges to shared packs. p50 ~4 KB / p99 ~820 KB with
  geometry [M+D].
- **Interior packs** — per LB above the 32 KiB EnvCell threshold.
- **Shared packs** — META-COMMONS (records used by ≥ 64 tiles, 2.1 MB), META-REGIONAL
  (32×32-LB supergrid), ENV-COMMONS/-REGIONAL, PVW-COMMONS/-REGIONAL (preview
  payloads), CORE (boot essentials; replaces boot.hba).
- **Closure** is computed at bake (`--verify-closure` fails loud on any dangling REFS
  edge) and — per D-12.5 — the walk includes Setup→MotionTable/PhysicsScript/SoundTable
  and GfxObj→did_degrade edges, K-tier assigned (sounds expected commons-tier; sized
  bytes reported by BAKE-CI before absolutes bind).
- **Spatial index `HBSI1`** (~0.5 MB [D]): pack table + 128×128 tile grid + interior
  table + shared directory. Replaces the 16.9 MB blocking catalogs.
- **Full-tier textures** stay per-record CAS files (median 242 KB [M]) — never packed.
- **Terrain t128 boot slice** (D-12.6): ONE CAS file per channel
  (`terrain-t128-color`, `terrain-t128-nra`; 29 rsIds concatenated, 0.63 MB each [D]),
  listed in the HBSI1 shared directory. The t1024 pair keeps per-payload CAS files on
  lane T.
- **Determinism** (pass 2 D-02.6): sorted emission, fixed zstd level, no timestamps;
  re-bake of unchanged input is byte-identical (`--verify-deterministic`). One-record
  edit blast radius = 1 tile pack + index + manifest.

**Manifest chain.** `manifest.json` is the ONLY mutable data URL. During coexistence it
stays `version: 2` and gains the v3 fields additively (`world_index`,
`pack_url_template`); new clients route on **presence of `world_index`** (deployed
clients hard-fail on version ≠ 1,2 — read-verified UnsupportedVersion). Sessions pin
the index they booted; host retains N−1 bakes (CAS-cheap); sentinel flips to 3 at ST10.

**App shell (NEW — D-12.2).** Deployed artifact = esbuild bundle: entries {main app,
bake_worker, net_worker, texture_worker, keepalive_worker}, content-hashed filenames
under `shell/`, immutable+identity headers; `index.html` = small `no-cache` loader;
`service-worker.js` stays a stable-name root file. Dev serves the live unbundled tree.

**Fetch.** One `PackFetchController` (JS, main thread; `scene3d/pack_fetch.js`) is the
sole fetch authority — wasm instances never fetch packs. Four lanes (U urgent /
B boot-critical / R ring+lookahead / T full-tier textures), global in-flight cap 12
(+4 urgent reserve, T sub-cap 4, all [A] with `?fetchCap` escape), **promotion instead
of bypass**, one in-flight entry per URL (latch, never duplicate). Whole-pack fetch, no
Range in v1. Prefetch = resident ring at boot; +1 tile directional lookahead while
moving (≥ 4× worst-case C5 margin [D]).

**Integrity.** Hash-on-receipt for every CAS object via `crypto.subtle` (async, not
main-thread JS time), before admission; always-ON (`?packVerify=off` diagnostic escape
taints the run). Per-shard sha256 (71% of main thread in the r10 probe [M]) is deleted
with the per-record path. *Premise corrected per F-11.8:* the 1070's canonical origin
(`http://127.0.0.1:8765` via the reverse tunnel) IS a secure context; the worker-wasm
sha fallback remains for non-loopback origins; P-SUBTLE is a confirmation probe.
Mismatch ⇒ one `cache: "reload"` retry, then the failure matrix (pass 3 S7): index-
listed 404s are LOUD deploy skew, never "empty tile"; tile failures quarantine with
timed re-eligibility; quarantine bookkeeping is authoritative and never erased by
residency.

**HTTP contract.** Three header classes: mutable pointer (`manifest.json`, no-cache);
immutable CAS (`index/`, `packs/`, texture files, `shell/` — `public,
max-age=31536000, immutable, no-transform`, identity encoding); app-shell loader
(no-cache revalidate). CDN requirements: h2+, TLS, honor `no-transform`.

**Service worker v3** (unified per F-11.11): cache `holtburger-content-v3`; intercepts
ONLY CAS paths (`packs/`, `index/`, texture CAS, `/scene3d/assets/` SWR) **plus legacy
`shards/` until ST10** (dropped with the sentinel flip); NEVER intercepts
`manifest.json`/HTML/JS/wasm. The bake-identity gate is deleted (nothing bake-versioned
remains). Offline = controller-stashed last-known manifest + CAS cache; SW persistence
is never a correctness dependency. B5 is met without the SW.

**Legacy per-record lane** (permanent, small): equipment/clothing substitution records,
other-player appearance, admin-spawned content, no-BPTC texture fallback. Today's
machinery unchanged, concurrency share 8 under the global cap [A], per-shard verify
stays ON at this population.

**Rust consumption.** `PackSource : ResourceSource` (sync reads over resident packs;
`insert_pack` admits verified bytes; sections lazily decompressed into a refcounted
cache). `CompositeSource` = PackSource → legacy source. The walk loop never fires for
pack content (closure is bake-time); it retires with the legacy lane's world traffic.

### 1.2 Geometry (source: pass 4; unchanged by assembly)

- **HBG1 payloads** fill pack GEOM slots (encoding 0x0001): indexed (R = 1.13
  verts/tri corpus-weighted [M, 1,131 real GfxObjs]), 24 B/vertex (pos f32×3, normal
  snorm8×3+pad, uv f32×2; +4 B baked-light in ENV payloads), u16 indices (u32 flag),
  **subset tables replace per-tri metadata** (surface/sidedness/stipple flags = the
  geometry groups). 0.33× today's boundary bytes; ~3× smaller resident geometry [M+D].
- **Storage:** per-GfxObj-part payloads (kind 0); SETUP directories (kind 1: part DIDs,
  frames, hinges, fused bbox, bake-resolved did_degrade); ENV directories (kind 2:
  per-cellstruct meshes with slot-indexed subsets). Placement follows the pack K-tier
  of the owning record.
- **Terrain is NOT baked** (baked ≈ 265× the 252 B record [D]); the runtime subdiv path
  stays, gaining only the bundle-form export. **Collision is untouched** — render-only
  bake; full records remain in packs for the physics/BSP consumers.
- **Exit contract:** one bake unit → ONE JS-owned transferable `ArrayBuffer` + small
  descriptor (`GeometryBundle`); typed-array views, `setIndex` present, no wasm-bindgen
  handles, no `free()` on the world path. Worker transfer = one buffer.
- **LOD:** the two-level did_degrade policy kept, resolved at bake (both gids
  pool-resident; runtime re-fetch deleted). No decimation, no new tiers.
- **EnvCell runtime residue:** slot→DID remap + vertex light bake per cell (indexed ⇒
  0.38× today's arithmetic [D]); offline light bake is the designed escape if measured
  necessary (P-LIGHTBAKE).
- **Equipment/entities:** today's runtime decode path bit-for-bit, never memoized into
  the static cache; a keyed substitution LRU is designed but DORMANT until entity-decode
  counters justify it.

### 1.3 Textures and tiers (source: pass 5; amended by D-12.1/D-12.6)

**Tier model per rsId:** PVW (raw HBC7, level-0 ≤ 128², full chains, in PVW packs —
the frame-1 source, zero transcode) → FULL (XUBC7 KTX2, 0.623× BC7 bytes [M], lane T,
worker transcode) → fallback (raw DAT records, legacy lane, no-BPTC GPUs + substituted
surfaces). `tex-bc7` leaves the wire; previews get bake-guaranteed coverage
(`texrefMissingPvw = 0` — every TEXREF'd rsId has a PVW row; missing = loud skew,
never silent RGBA8).

**Terrain ladder (amended, D-12.1):** t128 color (lane B tail, 1 CAS file) →
`preview-complete` → t128 nra (1 file) → **`converged` (terrain converges at t128)** →
t1024 pair on idle lane T, default-ON, non-budgeted, wholesale-swapped
(`?terrainT1024=eager|defer|off`, default `defer`). Assembly runs in the texture
worker; staging via ≤ 2 exclusive `initTexture` calls (44/44 MiB splittable).

**Lossy default:** the full-tier corpus bakes **q75 no-RDO** (38.2% of raw [M]) behind
the ST6 eye-gate; lossless until the gate passes. The rdo arm and the classifier-mixed
encode are the designed follow-ups.

**Frame-1 path:** materials are BORN compressed — scalars-only surface decode + sync
PVW read (`makeBc7Texture`, mips+aniso legal from frame 1); full tier upgrades async via
lane T → worker → existing swap machinery. The RGBA8 double-build, driver-mipgen first
pass, `__bc7Pre` race, and `__bc7Pending` hold-out (79% of props unbatched [M]) are all
deleted. NRA derives in the worker (half-res Sobel from transcoded albedo [A],
eye-gated); the offline nra corpus is reserved via a TEXREF tier bit.

**Texture worker** (`scene3d/texture_worker.js`, wasm-free, count 1): XU7→BC7
transcode (~31 MB/s output vs 83 KB/s wire — wire-bound by 2 orders cold [D]), terrain
assembly, NRA derive. One transferable in, one out (`parseHbc7`-shaped views). The
budgeted main-thread FIFO is the fallback arm (`?texWorkers=0`).

**Arrays:** full mip chains + aniso in every bucket (the level-0-only defect closed);
bucket identity from TEXREF-declared dims (stable across preview→full);
preview-commit + `atlasRefeed(rsId)` re-home (no verdict-wait hold-out); growth ×1.5
(M6-compliant). NRA arrays RGBA8 in v1.

**Mirrors/VRAM:** rehydrate v3 is source-keyed (terrain mirrors FREED post-upload
−88 MiB; full-tier mirror ≡ the 128 MB record-cache entry; previews pack-resident;
array staging kept for context-loss restore). Per-class allocated budgets ≈ 610 MiB
total [D/A]; **eviction demotes to preview** (pressure costs sharpness, never
blackness); dispose only with tile residency. M4 census ≈ 220–260 MB [D] vs ≤ 250.

### 1.4 Residency and the slot grid (source: pass 6; amended by D-12.4, F-11.12)

- **Grid:** tile-granular, ring-min anchor, **W_T = 6** (36 slots covering the 11×11-LB
  ring; 144 LBs allocated vs 121 used — 19% slack, stated). Shift-in-place, ±1 anchor
  per 2 LBs; teleport = anchor delta ≥ 6 (whole-grid invalidate, amortized drain,
  250 ms first burst). Lives in JS (`scene3d/residency_grid.js`, generalizing the
  proven `FixedSlotGrid` core + its integrity detectors); Rust holds bytes, JS holds
  policy. Event vocabulary: `onSeed/onShift/onTeleportPending/onTeleport/onSlotState/
  onSealedEnter/onSealedExit/onLadder`.
- **Slot states:** `EMPTY → FETCHING → STAGED → LIVE ⇄ PARKED → EMPTY` +
  `QUARANTINED`. Park = 2 s hysteresis, pointer re-adopt on return; true release only
  via pressure/teleport-ageout/teardown, amortized ≤ 1 tile/tick under 6 ms.
- **Rust stores** (all refcount-aware LRU, "no evictable victim ⇒ run over and record",
  **floors never zeroed** — R4 may lower 30 s → 5 s, never 0, loudly): PackStore
  96 MiB (pins: tile+interior+REFS-shared per slot; session pins for commons+index;
  PVW packs pinned while any slot of their region is LIVE/PARKED — keeps demotion
  sync-legal); PackSections 32; MODEL_TRI 64→16 at retirement; SURFACE_PIXEL 96→48
  summed; SUITE 16 (new bound); legacy shard cache unbounded during migration → 32 at
  retirement. All [A], re-classed by the first soak.
- **Pressure:** the geometry-count governor and its floor-zeroing are DELETED; three
  class-local byte loops (park pool ≤ 40 tiles / 128 MiB; Rust budgets at insert;
  texture demote-first) + a 4-rung ladder (R1 demote → R2 park release → R3 budget
  halve → R4 emergency floor-lower) triggered at 0.9×M1 / context loss / 0.94×M3.
  NEVER sheds: current tile + 3×3 LB, pinned packs, LIVE-slot previews, the index,
  quarantine records. `r4Engagements > 0` on a default run = FAIL.
- **Wasm topology:** TWO instances (main + bake worker), worker DE-STATED (no fetch, no
  pack residency beyond per-job leases ≤ 16 MiB, commons pin ≤ 8 MiB). M3 = 512 MiB
  summed (main ≤ 384 / worker ≤ 96 / net worker ≤ 32 **when armed** — netWorker is
  default-OFF [read-verified]; the census must sum **every instance that exists in the
  run's configuration** or the run is invalid [F-11.12, supersedes pass 6 S5(d)]).
- **Census:** every payload row budgeted or −1-with-stated-bound (CI: −1 row > 4 MiB
  fails); worker rows `packBytes: 0`, `shardRecords: 0` post-migration;
  `pinLeaks`/`shiftMismatches`/`slotDesyncs` must stay 0.
- **ST7 adapter (NEW — D-12.4).** ST7 requires `?packSource`; the fetch-side adapter
  does not exist. The residual **grid→legacy-producer adapter** (grid ON, pools OFF):

  | grid event | legacy action |
  |---|---|
  | admit(tile) (`onSeed`/`onShift`) | per-LB build kickoff through the existing statics/cells/buildings feed seams (the `tickPvsLoadExpansion` population, now event-driven); reads via CompositeSource; `pack_pin(tile)` |
  | vacate(tile) | 2 s hysteresis → `landblock_lru.park(lb)` per LB (existing park machinery) |
  | PARKED→EMPTY (pressure pass) | existing LRU dispose path, same amortized budget; `pack_unpin(tile)` |
  | QUARANTINED | tile's LBs never fed (pack content is loud-skew; legacy-lane misses stay catalog-gated silent-absent) |
  | teleport | grid drain replaces LRU sealed/teleport purges |

  During soak the legacy LRU runs **assert-only**: victim set computed, diffed against
  grid state, never acted on; `gridLruDivergence` MUST read 0 over the battery. The
  adapter retires at ST9 (pooled populations) and ST10 (rest).
- **Sealed interiors:** grid freeze + pinned return core (≤ 9 tiles inside the park
  budget); portal-destination hint pre-enqueues the destination tile.
- **Entities stay OUT of the grid** (reaper keep-zone > grid horizon; one-way seam).

### 1.5 Scene and draw pools (source: pass 7; amended by F-11.3/F-11.18)

- **Pools:** persistent `THREE.BatchedMesh` per (world-sector 2×2-tile, material-class);
  ≤ 16 resident sectors; statics + buildings + envcells collapse in; terrain batch and
  animated-scenery InstancedMesh paths KEPT; entities excluded (charter).
- **Class key** (produced only by `classKeyOf`): domain | renderState (`_stateKeyOf`
  axes + side) | programPatchSet (`_patchSetCacheKey` verbatim + VFX set#config) |
  textureArrayId (TEXREF dims+format) | shadowPair. Row 31 is unrepresentable by
  construction (every clone family is a distinct class by its existing bit). ONE
  material object per class ⇒ material.id sort adjacency ⇒ attacks the 71%
  switch-rate / 160-program-switch term at its own scale (no ms prediction — walls).
- **Culling/rebuild:** sector-level node culling; opaque pools set
  `perObjectFrustumCulled = false` + `sortObjects = false` ⇒ **three's own early-out on
  every settled frame, every camera, CSM included** (read-verified r184, double-checked
  by pass 11). Instance visibility = residency/PVS/LOD events only, never camera.
  Kills the 5.72 ms rebuild term structurally; statBatchMemo family OBSOLETE. Measured
  trade carried: −0.40 ms CPU / +tris bounded below the +81% worst case; ktris +
  GPU-boundedness re-check at GATE-POOLS.
- **Feed/release:** bake worker emits TilePlan (classKey, contentKey, precomposed world
  matrix, rsId, cellId, band gids per member) + GeometryBundle; STAGED→LIVE = dedup-hit
  or `addGeometry` + `addInstance` + ONE epoch bump per pool (P4 budget); park =
  `setVisibleAt(false)` batch — GPU-free; release = amortized deletes + lazy
  `optimize()` at > 30% dead. **No pool mutation without a triggering event**
  (`poolMutationsPerFrame = 0` on parked frames — CI gate).
- **Scene graph:** O(pools) + entities; world-static nodes ≤ ~250 [A, census-gated];
  transforms live in pool instance storage; every node-walker has a named home
  (pass 7 D-07.6 table) — per-cell PVS becomes per-cell instance ranges; LOD wrappers
  become a 2 Hz band tick over membership records; terrain data-carrier proxies
  retained v1 (~0.07 ms [D]).
- **Program population CLOSED at boot:** class set fixed by content statics; streaming
  mints zero materials/programs (`classesCreatedPostBoot = 0` gate); the class census
  IS the prewarm work list. Pass structure v1: opaque pools only; additive/translucent
  keep today's sorted semantics (additive-unsort reserved behind an eye-gate).
- **Load-bearing dependency (F-11.18):** `three_batchedmesh_colortexture_fix.js`
  (upstream r184 bug #34054 — per-frame getProgram per BatchedMesh; −3.35 ms renderCPU
  when fixed) must stay applied at pool scale; retirement = three bump past the
  upstream fix (§6 register).
- **Atlas:** subsumed wholesale — layer machinery/state-key axes/X7 arithmetic relocate
  into class materials; the defer gate and singleton-leftover class die.

### 1.6 Frame loop and scheduling (source: pass 8; amended by F-11.10/F-11.19)

- **Phase order:** P0 SIM (net pump + awaited `syncTickHop` — physics untouched, out of
  program scope) → P1 RESIDENCY (grid update, controller `setPlayerTile`, 1 Hz ladder
  sampler; events RECORD work, never execute) → P2 WORLD TICKS (`tickPerFrame` as
  built: CRITICAL phases + RP3-gated deferrables; band tick + PVS flips here) →
  P3 RENDER (composer unchanged; driver consumes previously staged uploads) →
  **P4 STREAM SLOT** — the `FrameWorkScheduler`.
- **FrameWorkScheduler** (`scene3d/frame_work.js`): ONE global budget (6 ms steady
  [A]; BOOT 50 ms; TELEPORT 250 ms one-shot; EMERGENCY reweights), classes W1 urgent /
  W2 uploads / W3 feeds / W4 release / W5 ladder / W6 legacy, budget checked between
  items, always-run-one, per-class max-defer 3 frames, shrink rule on heavy frames.
  The additive private-6 ms family collapses into it (W6 during migration). Sole caller
  of pool mutations and staged uploads. **Bake-job dispatch (F-11.19):** P1-recorded
  admits enqueue dispatch items — player tile/interior first, then Chebyshev distance;
  P4 posts the job (zero-cost, concurrency 1); vacate purges queued dispatches.
- **Uploads:** completions NEVER upload — arrival enqueues, P4 stages via
  `renderer.initTexture` (handles CompressedArrayTexture — read-verified; in-app
  layerUpdates behavior = P-INITTEX probe). A texture stages before the frame that
  first samples it; LIVE flip is last in a tile's feed order. Budgets: U-TEX ≤ 4 MiB +
  2 items / U-BUF ≤ 2 MiB / U-NRA ≤ 2 MiB / one exclusive item per frame (terrain
  pair, growth doublings, array allocations; grows chunk re-marks ≤ 2 layers/frame).
  **nullRender rule (F-11.10):** under `?nullRender=1`, W2 marks only
  (`needsUpdate`/layer marks, no `initTexture`) — nothing binds, nothing uploads.
- **Workers:** five page workers + SW, closed message vocabularies (pass 8 S3), wasm in
  exactly two; one job in flight per worker (texture worker FIFO depth-capped,
  cancellable); **no worker result touches the scene or GL from its arrival callback**.
- **Stall prevention:** boot class-census prewarm — color variants via
  `withWarmTarget(compile)`; **CSM depth variants via one off-screen shadow RENDER over
  per-class BatchedMesh proxies** (compile cannot reach them; plain-Mesh proxies would
  warm the wrong `batching` variant — both read-verified). Warm scenes parked for the
  session; re-warm on context restore / CSM preset flip. Post-boot class mint = bug.
- **Tail ledger** (F4 ≤ 60 / F5 ≤ 150 + `linkStatusMs = 0` / F6 ≤ 250 streaming):
  links → 0 steady walk (closed set + warm); transcode → worker; governor churn →
  deleted; atlas grow → ×1.5 + chunked; largest indivisible item = t1024 staging
  (88 MiB, once per session, splittable 44/44, unmeasured → P-88MIB); honest residue =
  GC/wasm-grow (probe-observed, `wasmMemMB` Δ evidence).
- **Observability:** `__framePhase` (last-frame + cumulative), `__frameWork`,
  `__prewarmStats`; the stall probe is retained as THE tail instrument, vector
  extended, same-name successor rule for retiring surfaces.

### 1.7 Instrumentation and validation (source: pass 10; amended by F-11.9/F-11.13/F-11.16)

Scale tags mechanical (RESULTS v2 `<name>@<scale>` keys; diag registry lint; report
writer throws on unsuffixed keys). Protocol classes PC-1…PC-8 with the effect-size
table (< 0.4 ms unresolvable; 0.4–1.5 PC-1 in-session ABAB; ≥ 1.5 PC-2 boot arms;
moving = PC-3 fixed-pose only; tail = PC-7 probe walk; cross-boot single shots valid
for nothing). Noise-floor kill rule: a regression kill fires iff delta >
max(2× same-run control spread, protocol floor). Console-error harness with an
evidence-cited allowlist. Run validity: release-wasm gate, bare-default gate, taint
list, judge/reject semantics (reject, never average). Bench suite: BOOT-666, BOOT-WARM,
CROSS-COL, DUNGEON, PARKED-REF, MOVE-FIX, TAIL-ULTRA, MEM-ROUTE, ULTRA-SOAK-30,
T2-BOT, CENSUS-CI, BAKE-CI + probes (P-SUBTLE confirm, P-INITTEX, P-88MIB, P-ASSEMBLE,
P-LIGHTBAKE, P-LADDER, P-HUBFLIP, CROWD-BURST, BENCH-ZIGZAG, BENCH-TELEPORT,
BENCH-CROSS-SETTLE, CENSUS-CLASS). Gates: GATE-BAKE, GATE-WIRE-BOOT, GATE-GEOM,
GATE-TEXWORKER, GATE-TEX, GATE-Q75, GATE-GRID, GATE-PHASE, GATE-POOLS, GATE-RETIRE.
1070 queue = JSON batch files (`queue-1070/`), verdicts written back; queue file is
authoritative for eye verdicts, RESULTS for measurements. BAKE-CI's ring preview
re-score runs against the POST-coverage preview corpus (F-11.16).

---

## 2. Budgets (all 25 IDs, post-supersession)

### 2.1 The budget table

Reference conditions: T1 = GTX 1070 daily driver (frame/memory targets; quality mid,
settled Nanto, ~1200×1013, renderScale 1); T2 = SwiftShader 8 GB laptop (functional
only); T3 = 666 kbps line (all wire targets). Bind on `--release` wasm, bare-default
URL, DEPLOYED (bundled) shell.

| ID | metric @scale | target | class | owning test | binds at |
|---|---|---|---|---|---|
| B1 | bytes@wire@preview-complete, cold, T3 | ≤ 12 MB (expected 11.6 / conservative 12.6 [D]) | D | BOOT-666 (per-component table mandatory) | ST5 (with ST2+ST3+ST-SHELL) |
| B2 | requests@preview-complete, cold | ≤ 64 (expected ≈ 52 [D]: shell 8 + manifest/index 2 + shared ~5 + 36 tiles + terrain slice 1) | D | BOOT-666 | ST5 (with ST-SHELL) |
| B3 | serial RTT depth to first render work | ≤ 4 | D | BOOT-666 waterfall | ST5 |
| B4a | bytes@wire@converged (terrain @ t128) | **≤ 65 MB** q75 (expected ≈ 63; rdo ≈ 42; lossless ≈ 95 [D]) — SUPERSEDES charter ≤ 45, see §0.2.1 | D | BOOT-666 converged tail (~10 min settle throttled [D]) | ST6 (+ owner election) |
| B4b | bytes@wire, t1024 end-state | reported only (≈ 144 q75 / 123 rdo / 176 lossless [D]); `terrainT1024CompleteMs` stamped | D | BOOT-666 (report row) | never gated |
| B5 | warm boot network | ≤ 1 MB / ≤ 5 req (expected ≈ 2 req [D]) | D | BOOT-WARM | ST-SHELL + ST2 |
| C1 | requests per new-LB column, unvisited | ≤ 12 (expected ≈ 9 [D]) | D | CROSS-COL | ST2 |
| C2 | bytes@wire/column → preview-complete | ≤ 1.5 MB (worst measured ≈ 0.70 with GEOM [M+D], margin 2.1×) | M+D | CROSS-COL | ST5 |
| C3 | crossing into cached territory | 0 network | D | CROSS-COL warm arm | ST2 |
| C4 | fresh dungeon → preview-complete | ≤ 2 MB (≈ 1.5 median [M+D]; cap fixes the max-preview caveat) | M+D | DUNGEON | ST5 |
| C5 | sustained walk, T3, preview tier | `__hbFetch.wireWaitEvents` = 0 over 20 columns | D | CROSS-COL throttled | ST7 |
| F1 | frameMs@parked p50, mid, Nanto ref | ≤ 16.7 ms (vs 20.2 [M]) | BR/A | PARKED-REF | ST9 |
| F2 | frameMs@parked p95, mid | ≤ 22 ms (vs 26.5 [M]) | BR | PARKED-REF | ST9 |
| F3 | frameMs@moving p50, mid | ≤ 1.25× same-session parked p50 | A | MOVE-FIX orbit (creates the baseline) | ST9 |
| F4 | frameMs@moving p99, mid | ≤ 60 ms | A | MOVE-FIX ≥ 1,800 fr / TAIL-ULTRA mid | ST9 |
| F5 | frameMs@moving p99, ultra + links | ≤ 150 ms AND linkStatusMs = 0 over 60 s walk | BR | TAIL-ULTRA | ST9 |
| F6 | streaming hitch ceiling | no frame > 250 ms streaming-attributed, mode = NORMAL | A | TAIL-ULTRA | ST9 |
| M1 | heap peak, six-town route | ≤ 1.6 GB (vs 2.7 pre / 2.0 post-fix [M]) | BR | MEM-ROUTE | ST7 |
| M2 | heap growth after 3rd town | ≤ 150 MB | D | MEM-ROUTE | ST7 |
| M3 | Σ wasmLinear, every existing instance | ≤ 512 MiB (384/96/32 split); ≤ 64 MiB warm growth | D | MEM-ROUTE | ST7 |
| M4 | cpuMirror bytes by class | ≤ 250 MB + guaranteed re-supply (census ≈ 220–260 [D]) | D | MEM-ROUTE texCensus arm | ST5 |
| M5 | context losses, 30-min ultra | 0 (vs 7 [M]) | BR | ULTRA-SOAK-30 | ST5 |
| M6 | allocated:used per array/pool | ≤ 1.5× (vs 17× pre-fix [M]) | BR | ULTRA-SOAK-30 + CENSUS-CI | ST5 |
| M7 | geometries after route | baseline ±10% (vs monotone +15k [M]) | BR | MEM-ROUTE | ST7 |
| M8 | T2 heap | ≤ 1.2 GB | A | T2-BOT | every stage |
| M9 | T2 nullRender boot | ≤ 120 s, 0 page errors | BR | T2-BOT | every stage |

Priority when targets conflict (charter S3, unchanged): correctness/fidelity gates >
C5+F5/F6 (lived experience) > M1/M3/M5 (don't crash) > B1/B2 (first session) > F1.

### 2.2 Budget×stage binding rule (F-11.7)

The "binds at" column names the earliest stage at which the ABSOLUTE target is
scoreable — before it, the texture path is still RGBA8-first with per-record texture
GETs (raw 0x06 records are deliberately unpacked), so absolute wire budgets CANNOT
pass and gates score the **comparative form only** (flag-on vs flag-off, same-session
interleaved arms, noise-floor rule). A pre-binding absolute reading is data, not
failure. F-series absolutes additionally require MOVE-FIX baselines to exist (created
at GATE-POOLS' first accepted run).

---

## 3. Implementation plan

17 tasks over 11 stages, two parallel tracks. Size classes are **estimates** (S ≤ ~3
files-touched/low risk; M = one subsystem; L = multi-module/structural). Every task's
flag follows the §0.1 lifecycle; every kill is a one-flag or one-repoint revert; kills
fire only on the noise-floor rule (§1.7), never cross-boot single shots.

### Phase 0 — spikes and foundations (all parallel, no dependencies)

**T00 — CENSUS-CLASS spike** *(S)* — [F-11.13] Run the class-cardinality census over
TODAY'S materials (CI arm, quality mid): classifier over live MaterialCache
populations at settled Nanto + Town Network. **Acceptance:** report published; classes
≤ ~48 / projected pools ≤ ~300, or pass 7's key design is re-examined BEFORE T22 sizes
anything. **Kill:** n/a (information). Feeds: T22 sizing, the prewarm list, R-03.

**T01 — Harness foundation** *(S)* — diag-schema registry + Tier-1 lint
(`harness/lib/diag_schema.mjs`, `test_diag_schema.mjs`), RESULTS-v2 report writer
(`harness/lib/report.mjs`), console-error allowlist (`console_allowlist.mjs`, seeded
with the QuickEmote entry + evidence rule). **Acceptance:** Tier-1 lints green;
moving-bench converted to the writer. **Kill:** n/a.

**T02 — Reader/caller sweeps** *(S)* — [pass 9 Q3, pass 11 Q3] `rg manifest.json` over
harness/tools/proxy for strict parsers (additive-fields risk); `rg "fetch\("
scene3d/` for private fetch callers outside the controller (the F-11.6 class beyond
terrain). **Acceptance:** findings filed as T12 inputs. **Kill:** n/a.

### Track W1 — wire/dist

**T10 — ST1: dual-emit bake + serve rules** *(L, no client flag)* — `dat-shard
--emit-packs --legacy-layers`: HBP1/HBSI1 emission (pass 2 S2–S5), **walk-widening**
(MotionTable/PhysicsScript/SoundTable + did_degrade edges, K-tier sized, per-tier byte
report [D-12.5]), preview coverage incl. non-square/xu7-only derivation, **t128
single-file slice per channel** [D-12.6], manifest v2+fields; serve.py packs/index
immutable rule + `--check`/`_health.json` extension; BAKE-CI (closure incl.
`texrefMissingPvw = 0`, determinism, byte-identity differ N ≥ 50 models + 10 envcells,
zstd ratio report → re-scores B1 slack, POST-coverage ring preview re-score
[F-11.16]). **Deps:** none. **Acceptance:** GATE-BAKE all green; legacy layers pass
unchanged checks; widened-commons bytes within B1's meta margin (else tiering
parameters adjusted before T12). **Kill:** K3 (a failing dist is never pointed at).

**T11 — ST-SHELL: bundle + hash the app shell** *(M, dist-level arm)* — [D-12.2]
esbuild build step (entries: main + 4 workers), content-hashed `shell/` output on the
immutable tier, `index.html` loader, `service-worker.js` untouched; deploy tooling +
serve.py header row; `__hbFetch.byComponent.code` wired to the CDP network log.
**Deps:** none (must land before B2/B5 absolutes bind). **Acceptance:** uniform floor
(T2 bot + 1070 headless boot, 0 console errors); BOOT-666 shell component ≈ 8 requests
cold / ≈ 1 warm. **Kill:** repoint to the unbundled tree (K3-class); fallback = §5
R-02 split-budget restatement.

**T12 — ST2: pack client** *(L, `?packSource`)* — PackFetchController (lanes,
promotion, latch, quarantine, diag), hash-on-receipt (subtle + worker-wasm fallback),
PackSource/CompositeSource behind `ResourceSource`, HBSI1 consumption, widened-closure
consumption (animated-scenery support records via packs), SW v3 (lands with the
default flip; `shards/` allowlisted until ST10 [F-11.11]), t128 slice fetch via lane
B. GEOM stays encoding 0x0000 (runtime decode — rendered world byte-identical).
**Deps:** T10 (+T01). **Acceptance:** GATE-WIRE-BOOT — 0 hash mismatches / 0 terminal
quarantines over the battery; comparative cold-boot bytes+requests vs legacy arm;
BOOT-WARM comparative; T2-BOT. **Kill:** K2 (+K4 if SW shipped): cold-boot regression
vs legacy arm, terminal quarantine on a healthy dist, or gameplay-visible equipment
starvation (R-07).

**T13 — ST3: GEOM bundles + consumer swap** *(L, `?geomBundles`, requires
`?packSource`)* — HBG1 emission (encoding 0x0001), `assemble_model_geometry` /
`assemble_envcell_geometry` exports, `bundleToGeometryGroups`; consumers swap in fixed
order (statics → buildings → animated-scenery decode-once → cells), one commit each so
defects bisect. **Deps:** T12. **Acceptance:** GATE-GEOM — differ green (mechanical
bake correctness), **E1 eye item CLEAN** (Batch A), P-ASSEMBLE sanity, parked-mid p50
non-regression (PC-2 interleaved arms). **Kill:** K2 — E1 dirty, p50 regression, or
starvation-class errors reappearing.

**T14 — ST4: texture worker** *(M, `?texWorkers`)* — `texture_worker.js` (transcode +
terrain assembly + NRA derive), results-enqueue-only integration, FIFO fallback arm
retained verbatim. **Deps:** none (independent). **Acceptance:** GATE-TEXWORKER —
TAIL-ULTRA worker-vs-FIFO arms (transcode bucket), BOOT-WARM queue depth; no eye item
(same transcoder, same output). **Kill:** K2 — worker-arm tail worse than FIFO arm, or
fallback failing to engage silently+counted.

**T15 — ST5: compressed-only texture path** *(L, `?texCompressedOnly`, requires
`?packSource`; uses `?texWorkers`)* — scalars-only surface decode, PVW frame-1
materials, lane-T upgrade, preview-commit + `atlasRefeed` re-home (**conscious
throwaway: the atlas-side re-home implementation retires at ST9; the `atlasRefeed(rsId)`
seam is producer-agnostic** [F-11.17]), full-chain+aniso arrays, ×1.5 growth,
worker-NRA, rehydrate v3 + mirror policy, terrain tier ladder wiring
(t128 → converged → deferred t1024 per §0.2.1), 128 MB record budget, demote-to-preview
primitive. **Deps:** T12 (+T14 soft). **Acceptance:** GATE-TEX — **E2 + E3 CLEAN**
(Batch B); M4/M5/M6 on route+soak; B1 absolute (first stage where it binds); C4;
frame-1-white zero-tolerance. **Kill:** K2 (+K3 for bake coverage defects) — E2/E3
dirty, M4/M5 worse than legacy arm, any frame-1 white material, parked p50 regression.
**Cascade [F-11.3]:** killing ST5 after ST9 forces `?drawPools` OFF in the same
session, loudly.

**T16 — ST6: q75 corpus + the two owner decisions** *(M, bake-side, no client flag)* —
re-encode full tier at q75 no-RDO (buildbox); **E4** (sheets + in-world painted/emblem
pass; owner: redmi); record IN WRITING: (1) q75 verdict (dirty ⇒ stay lossless,
classifier-mixed is the follow-up), (2) the **B4a election** (§0.2.1: accept default /
t1024-in-converged with B4a restated ≈ 144 / rdo arm ≈ 42). **Deps:** T10; Batch B.
**Acceptance:** GATE-Q75 + decisions recorded. **Kill:** K3 (manifest points at either
corpus; both are CAS).

### Track W2 — residency/draw (parallel with W1 from T12 onward)

**T20 — ST7: slot grid as residency authority** *(L, `?slotGrid`, requires
`?packSource` [D-12.4])* — `residency_grid.js` (W_T = 6, events, state machine,
integrity detectors carried over), PackStore + pin wiring, park scheduler, pressure
ladder (governor + floor-zeroing deleted), census deltas + net-worker relay
(flag-conditional), **the grid→legacy-producer adapter per §1.4's table**, legacy LRU
in assert-only mode. **Deps:** T12. **Acceptance:** GATE-GRID — **E5 CLEAN**
(Batch C, or B if ready); `gridLruDivergence = 0` over the battery;
`pinLeaks`/`shiftMismatches`/`slotDesyncs` = 0; M1/M2 vs legacy arm; BENCH-ZIGZAG
(`reAdoptCancels` absorbing) + BENCH-TELEPORT; TAIL-ULTRA governor bucket. **Kill:**
K2 — any nonzero integrity counter, M1/M2 regression, moving-tail regression.

**T21 — ST8: FrameWorkScheduler stage A** *(M, `?frameWork`)* — `frame_work.js`;
legacy 6 ms families register as W6 clients under the global cap (code unchanged).
**Deps:** none. **Acceptance:** GATE-PHASE — `__framePhase` census (re-classes the [A]
phase budgets); BENCH-CROSS-SETTLE fast-line AND 666 (the under-serving risk; named
lever = CROSSING elevated mode before killing). **Kill:** K2 — boot-to-in-world or
crossing-settle regression beyond noise on interleaved arms.

**T22 — ST9: draw pools + scheduler B/C + closed-class prewarm** *(L, `?drawPools`,
requires `?slotGrid` + `?packSource` + `?geomBundles` + `?texCompressedOnly`
[F-11.3]; `?frameWork` ON for stages B/C)* — `pool_registry.js`, class-key material
tier, TilePlan production in the bake worker, P4 relocation of eviction/feeds
(stage B), upload staging via `initTexture` (stage C — lands TOGETHER with the feed
path; shared LIVE-flip ordering invariant), bake-job dispatch items [F-11.19],
nullRender marking rule [F-11.10], boot prewarm incl. the CSM depth-variant warm
RENDER, **`three_batchedmesh_colortexture_fix.js` verified applied to pool-scale
populations** [F-11.18]. **Deps:** T13 + T15 + T20 + T21 (+T00's census). 
**Acceptance:** GATE-POOLS — **E6 CLEAN** (Batch C incl. the ClipMap item itself +
shadowed-town receiveShadow vantage); class census sane (`classesCreatedPostBoot = 0`,
pools ≤ ~300); parked `poolMutationsPerFrame = 0`; MOVE-FIX (creates F3/F4 baselines,
scores the kill); TAIL-ULTRA F5 `linkStatusMs = 0`; ktris + GPU-boundedness re-check.
**Kill:** K2 (one flag restores the whole legacy producer stack) — E6 dirty, moving
p50/p99 regression vs off-arm, post-boot class mint, or a boundedness flip (re-measure
before ANY further work — walls).

### Validation milestones (1070 queue batches, owner-gated; §5 R-05)

**T30 — Batch A** *(S)*: E1 + probes P-SUBTLE (confirm), P-INITTEX, P-88MIB,
P-ASSEMBLE, P-LIGHTBAKE (+ MOVE-FIX first baseline run if cadence allows — pass 10
H-10.2's scheduling note). **T31 — Batch B** *(S)*: E2 + E3 + E4 (+ E5 if ST7 ready).
**T32 — Batch C** *(S)*: E5 + E6. All items prepared as queue-file entries (URL pairs,
vantages, checklists); off-screen/headless; verdicts written back to the queue file.

### Retirement

**T40 — ST10: legacy retirement** *(M, no flag — deletes flags)* — fires only when:
legacy-lane worldload = 0 over the full battery (equipment/entity excepted — reachable
after T12's widened closure [D-12.5]); every stage flag DEFAULT-ON ≥ 2 bake + 2 bench
cycles with no K2; census reads the retirement shape; owner go. Then: sentinel 2→3,
legacy fields/layers dropped, the four deletion ledgers execute in dependency order
(fetch → LRU/governor → producers/atlas → frame leftovers), post-migration cache
budgets arm, SW allowlist drops `shards/`, flags → RETIRED. Each ledger execution is a
doc-propagation event (§6).

---

## 4. Task dependency graph

```
Phase 0:   T00, T01, T02          (parallel, no deps; T00 before T22 sizing)

W1:        T10 ─────► T12 ─────► T13 ─────────────┐
           T11 ──(binds B2/B5 scoring; no code dep)│
           T14 ──────────────────► (T15 soft dep)  │
           T12 ─────► T15 ────────────────────────►│──► T22 ─► T40
                      T15 ... T16 (bake-side; E4)  │
W2:        T12 ─────► T20 ────────────────────────►│
           T21 ───────────────────────────────────►│

Queue:     T30 gates T13 · T31 gates T15/T16 · T32 gates T20/T22
```

**Parallelizable:** {T00, T01, T02, T10, T11, T14, T21} can all start on day one.
T12 unlocks both tracks (T13/T15 and T20). T22 is the single convergence point
(needs T13 + T15 + T20 + T21). T16 is off the critical path (bake-side).
**Serialized by policy:** default flips (one at a time, one clean soak between —
pass 9 D-09.3.3); structural promotions quantized to the three 1070 batches.

**Kill-cascade edges (F-11.3):** OFF-forcing propagates along
packSource → {geomBundles, texCompressedOnly, slotGrid} → drawPools; a prerequisite
kill forces dependents OFF loudly in-session, and the dependent stage's kill log gets
a row.

---

## 5. Tracked-risk register

Every carried minor, every load-bearing [A], and every owner call. "Resolves by" names
the stage/gate at which the row must close or escalate.

| R | risk | owner / owning measurement | resolves by |
|---|---|---|---|
| R-01 | **B1 slack stack**: ring-preview cap figure (1.6 vs 2.5 MB), HBG1 zstd ratio (≥ 0.7 [A]), post-coverage preview adds (±0.4 MB [F-11.16]), widened-closure commons bytes [D-12.5]. Levers if breached: t64 slice (−0.47), PVW-regional deferral, tiering parameters | BAKE-CI ratio report + POST-coverage ring re-score (T10) | GATE-BAKE / GATE-WIRE-BOOT |
| R-02 | **ST-SHELL feasibility** (bundling an importmap-era no-npm tree). Pre-specified fallback: B2 → world-data ≤ 64 + shell budgeted separately at measured N; B5 likewise; SUPERSEDES of charter S2 network-layer wording lands with it | ST-SHELL task + owner call | before B2/B5 absolutes bind (ST5) |
| R-03 | **Class cardinality closed set** — pass 7's most load-bearing [A] (prewarm list, switch-rate attack, node budget all lean on it); VFX config tokens are the fragmentation vector | T00 spike (CI) + GATE-POOLS 1070 confirm | T00 (pre-implementation) |
| R-04 | **ST6 owner elections**: q75 verdict + the B4a terrain election (§0.2.1 arms priced) | redmi, recorded in writing at ST6 | GATE-Q75 |
| R-05 | **1070 batch cadence** — three owner sessions serialize the structural promotions; DEV soaking continues if cadence slips | scheduling reality; batches carry many items, probes piggyback | ongoing |
| R-06 | **Run-speed assumption under C5** (4–7 m/s [A]; margins safe to ~26 m/s but the measured margin is the assumption restated) [F-11.14] | one-shot live-ACE max-sustained-speed measurement; CROSS-COL cadence derives from it; velocity-adaptive lookahead = escape | before GATE-GRID scores C5 |
| R-07 | **Legacy-lane starvation** during equipment bursts (119-spawn class) under the shared cap | CROWD-BURST probe; ST2 kill row watches | GATE-WIRE-BOOT soak |
| R-08 | **[A] scheduler/upload/cap numbers**: global 6 ms, shrink rule, U-TEX/U-BUF caps, fetch caps 12/4/4, ladder thresholds, park/PackStore budgets, phase slots | GATE-PHASE census, BENCH-CROSS-SETTLE, MEM-ROUTE occupancy series, P-LADDER | GATE-PHASE / GATE-GRID |
| R-09 | **texchan sidecars** (5,475 files) — fold into the offline-nra corpus when it is sized [F-11.15/P5 Q7] | owner call, nra-corpus work item | post-v1 |
| R-10 | **Production hosting shape** (h2, CDN, origin split, TLS) [F-11.15/P3 Q4] | owner call; §1.1's requirements are the contract | before public deploy |
| R-11 | **three r184 #34054 fix module** load-bearing at pool scale; retirement = three bump past the upstream fix [F-11.18] | doc-propagation register (§6); pools task verifies applied | GATE-POOLS + on any three bump |
| R-12 | **Unmeasured single items**: 88 MiB t1024 staging vs F6 (splittable 44/44), initTexture+layerUpdates in-app, bundle-assembly µs, envcell light-bake µs (the dual-wasm keystone), prewarm boot cost | P-88MIB, P-INITTEX, P-ASSEMBLE, P-LIGHTBAKE (Batch A); `__prewarmStats` | Batch A |
| R-13 | **Noise floors are [A] as universal** (anchored in one week on one box); first gate runs publish their own spreads; floors move UP only | first execution of each gate | each gate's first run |
| R-14 | **no-BPTC population unknown** — fallback tier maintained blind; field counter (`bc7Available()=false` boots) + owner call on downgrade to banner-only | diag counter + owner | post-ST5 field data |
| R-15 | **Honest un-designed residue**: GC/wasm-grow tail (probe-observed via `wasmMemMB` Δ, unbounded in principle); water has no system in the tree and none is added | stall probe heap/wasm channels | permanent, observed |
| R-16 | **B4b lived experience on T3** — the t1024 tail is ≈ 29 min at 666 kbps; deferred-not-gated means slow lines simply live at t128 longer. If the owner deems t128 visually unacceptable as a converged state, R-04's election reopens | ST6 election + field feedback | GATE-Q75 |

**Eye-gate queue (owner-eye-only register):** E1 bundles/winding/normals (Batch A) ·
E2 preview world/re-home/mips (B) · E3 NRA parity (B) · E4 q75 sheets+in-world (B) ·
E5 grid seams/teleport/sealed (C) · E6 pooled world/pass membership/receiveShadow/
baked-light (C) · E7 additive-unsort (reserved, post-v1) · E8 f16 UVs (reserved,
post-v1). DIRTY ⇒ stage blocked, defect filed — never "ship and tune".

---

## 6. Doc-propagation obligations (inherited from pass 9; binding on every landing)

**Checklist on every default flip / kill / bake repoint** (pass 9 S7.1–S7.2): url-flags
row + both lint tools green in the landing commit; superseded measurement docs get
banners same-day; module headers rewritten in the same PR; instrument wiring renamed in
the same commit as the surface; serve.py `DEFAULT_ROOT` comment convention on repoints;
owner NOTIFIED of stale MEMORY.md pointers (agents never edit it unprompted).

**Stale-wording register** (each row clears at its stage, at implementation time —
R3 forbade spec passes editing the survey):

| stale text | truth | clears at |
|---|---|---|
| survey §4 I4 "designed …, never built" + PLAN-fixed-slot-grid framing | S15b/S15c grid IS live default-ON at terrain radius-1 (fixed_grid.js:55; url-flags 505–507) — read-verified twice (passes 6, 11) | ST7 landing (survey correction + plan-doc banner) |
| survey I4 restatement in SPEC-era docs: the 07-11 plan's end state (grid as authority, all layers, refcounted cache) is what ST7 builds; its S15b slice is adopted, not restarted | — | ST7 landing |
| p99 doc "SHADER_PREWARM default OFF" | flipped default-ON 2026-08-06 | standalone same-day fix (verdict exists now) |
| statics.js:2435 "default OFF" comment vs its default-ON reader | reader is truth | standalone same-day fix |
| bc7_textures.js header (level-0-only contract, 256 MB budget rationale) | ST5 fixes chains/aniso; transcode is worker-side; budget 128 MB | ST5 |
| url-flags texFreeCpu preconditions + texture_release.js preconditions | rehydrate v3 restructures them | ST5 |
| xu7_textures.js roadmap "(b) is a prerequisite for (a)" | (a) ships at ST4 | ST4 |
| static_batch_x.js memo/slack/sphere-cache headers; frame-cost §5/§5a memo/arrayMerge sections | family OBSOLETE at pools | ST9 (banners: "superseded by pools — historical") |
| landblock_lru.js header + governor doc rows | governor deleted; grid is authority | ST7/ST10 |
| statics geom-audit/starvation machinery docs | deleted with bundles | ST3 |
| url-flags rows 505–507 (fixedGrid family) | subsumed by `?slotGrid` | ST7 (superseded), ST10 (deleted) |
| MEMORY.md `?nosw` wording ("SW caches index.html … JS/HTML edits need nosw") | current SW does NOT intercept HTML/JS (read-verified, passes 3+11); the trap is the bake-versioned-URL class, deleted by SW v3 | owner notified at ST2 (never edited by agents) |
| pass 2 S7 `version: 3` sentinel wording | superseded by pass 9 D-09.1.2 (v2+fields during coexistence) | carried here; ST10 flips the sentinel |
| three #34054 fix module header | retirement condition = three bump past upstream fix | on any three bump (R-11) |

---

*End of SPEC. Assembly record and finding rationale: `pass-12-final-assembly.md`.
Full design rationale: passes 1–11 in this folder. Measurement law: pass 10.
Migration detail (stage cards, kill tables, flag lifecycle): pass 9 as amended by §0.3.*
