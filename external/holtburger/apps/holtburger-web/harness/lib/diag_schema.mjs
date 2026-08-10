// harness/lib/diag_schema.mjs — the diagnostic-surface registry (SPEC §1.7 /
// pass-10 D-10.3 + S3). T01 deliverable.
//
// WHAT THIS IS
// ------------
// One declarative registry of every benchmark-facing diagnostic surface the
// client publishes (window.__diag.*, globalThis.__* functions/objects), each
// field declared with:
//
//   kind   'counter' — monotone session-cumulative accumulator. Diffable
//                      across frame edges (the stall-probe method,
//                      scene3d/stall_probe.js:26-56). Quoting the raw value
//                      folds in the boot + warm laps; only deltas describe an
//                      interval.
//          'level'   — absolute reading. Differencing is meaningless or
//                      misleading (per-frame renderer.info snapshots,
//                      high-water maxima, config values, strings).
//   unit   'ms' | 'bytes' | 'count' | 'string' | 'bool' | 'json' | 'enum'.
//          Units ride the field NAME where possible (`*Ms`, `*Bytes`) — the
//          stall probe's _MS_KEYS discipline (stall_probe.js:396-399)
//          generalized. ONLY unit-ms fields may carry `attribution: true`
//          (summable into an explainedMs-style attribution); counts are never
//          priced — that is the "six 2x+ overestimates" lesson.
//   scale  array of S1 tags (population / boot-milestone / motion-regime /
//          memory-home). MANDATORY for every bytes field: bytes without a
//          declared population is exactly the 2x-scale-error trap this
//          registry exists to close (pass-10 D-10.1).
//
// SURFACE STATUS
//   'current'  — read-verified in the code TODAY; `evidence` cites the
//                registration site file:line (the Tier-1 lint re-verifies the
//                name still appears near that line, so the registry cannot
//                silently rot).
//   'reserved' — a new-architecture surface from pass-10 S3. The NAME is
//                claimed now so no unrelated surface squats on it; the fields
//                are the normative schema its owning stage must publish.
//                `spec` cites the pass-10 section.
//
// SAME-NAME-SUCCESSOR RULE (pass-10 D-10.3.2, binding): when a legacy surface
// retires, its successor publishes the fields an instrument already samples
// under the SAME monotone-cumulative semantics, or the instrument's _sample is
// updated in the same commit. Encoded here as `retiresAt` (stage) +
// `successor` (registry name); the lint fails a retiring surface whose
// successor is not itself registered.
//
// GUARDED READS / ABSENCE (D-10.3.3-4): `availability` states when the surface
// exists ("boot" | "in-world" | "late" ≈35 s post-in-world | a flag gate |
// "reserved:STn"). Benches poll for presence; an absent surface is reported
// ABSENT by name, never read as zero. A gate scored while its instrument was
// absent is INVALID, not PASS.
//
// Tier-1 lint: harness/test_diag_schema.mjs (bare `node`, exit 0/1).
// Consumers: harness/lib/report.mjs imports the tag vocabulary so RESULTS-v2
// metric keys and this registry share ONE closed set.

// ---------------------------------------------------------------------------
// S1 scale-tag vocabulary (CLOSED — pass-10 S1; additions are a spec change)
// ---------------------------------------------------------------------------

export const SCALE_AXES = Object.freeze({
  population: Object.freeze([
    "resident", "parked", "staged", "drawn", "submitted", "wire",
    "cached", "allocated", "used", "pinned", "leased",
  ]),
  milestone: Object.freeze(["in-world", "preview-complete", "converged"]),
  regime: Object.freeze(["parked", "moving"]),
  home: Object.freeze(["heap", "wasmLinear", "cpuMirror", "vramEst"]),
});

/** Flat union of every legal @scale tag. ("parked" rides two axes by design.) */
export const SCALE_TAGS = Object.freeze([
  ...new Set(Object.values(SCALE_AXES).flat()),
]);

/** Legal keys inside a RESULTS-v2 stat object. A bare number where a latency
 *  stat belongs is an implicit p50 claim and is forbidden (S1). */
export const STAT_KEYS = Object.freeze(["p50", "p95", "p99", "mean", "max", "min", "n"]);

export const UNITS = Object.freeze(["ms", "bytes", "count", "string", "bool", "json", "enum"]);
export const KINDS = Object.freeze(["counter", "level"]);
export const STATUSES = Object.freeze(["current", "reserved"]);

// ---------------------------------------------------------------------------
// field helpers (terse constructors so the registry below stays readable)
// ---------------------------------------------------------------------------

const C = (unit, scale, extra) => ({ kind: "counter", unit, ...(scale ? { scale } : {}), ...(extra || {}) });
const L = (unit, scale, extra) => ({ kind: "level", unit, ...(scale ? { scale } : {}), ...(extra || {}) });

// ---------------------------------------------------------------------------
// THE REGISTRY
// ---------------------------------------------------------------------------
// Field paths are dot-joined; `*` is a wildcard segment for repeated row
// families (lanes.*, stores.*, byComponent.*). The unit-suffix rules apply to
// the LAST path segment.

export const REGISTRY = Object.freeze([

  // ── current surfaces (read-verified this session) ────────────────────────

  {
    name: "__bc7Stats",
    status: "current",
    reads: "function",
    evidence: "scene3d/bc7_textures.js:1220",
    availability: "in-world",
    note: "Module tally bc7Stats() (bc7_textures.js:767-779) + source residency. "
      + "Retained legacy surface; full-tier texture machinery re-homes at ST5.",
    fields: {
      fetches: C("count"), hits: C("count"), absent: C("count"),
      errors: C("count"), parseErrors: C("count"),
      lastError: L("string"),
      bytesFetched: C("bytes", ["wire"]),
      texturesBuilt: C("count"), atlasLayers: C("count"), atlasBuckets: C("count"),
      singletonUpgrades: C("count"), deferredNodes: C("count"),
      preFetches: C("count"), preHits: C("count"), preSwaps: C("count"),
      enabled: L("bool"), supported: L("bool"), support: L("string"),
      cached: L("count", ["cached"]), inflight: L("count"),
      records: L("json", null, { note: "recordCacheStats(); budget:-1 = disarmed (shardCacheBudget convention)" }),
    },
  },

  {
    name: "__xu7Stats",
    status: "current",
    reads: "function",
    evidence: "scene3d/bc7_textures.js:1221",
    availability: "in-world",
    note: "xu7Stats() in scene3d/xu7_textures.js:142-211 (budgeted-FIFO tally). "
      + "decodeMs is cumulative main-thread transcode ms but NOT attribution-"
      + "summable: quoting total transcode ms as a frame win is the exact "
      + "mistake the module tombstone documents; task-length fields "
      + "(maxDrainMs/maxBatch) are the pile-up metrics.",
    fields: {
      transcoderLoads: C("count"), transcoderFailed: L("string"),
      decodes: C("count"), decodeErrors: C("count"),
      decodeMs: C("ms", null, { attribution: false }),
      lastError: L("string"), notReadySkips: C("count"),
      maxRun: L("count"), runs: C("count"),
      queued: C("count"), drains: C("count"),
      maxBatch: L("count"), maxDrainMs: L("ms"),
      deferrals: C("count"), maxQueueDepth: L("count"),
      queueWaitMs: C("ms", null, { attribution: false }),
      maxQueueWaitMs: L("ms"),
      enabled: L("bool"), budgetEnabled: L("bool"),
      budgetMs: L("ms"), queueDepth: L("count"),
    },
  },

  {
    name: "__terrainBc7Stats",
    status: "current",
    reads: "function",
    evidence: "scene3d/terrain.js:3965",
    availability: "in-world",
    note: "terrainBc7Stats() in scene3d/terrain_bc7.js. Installed "
      + "unconditionally so ?terrainBc7=off asserts enabled:false instead of "
      + "probing a hole. The `ladder.*` rows are ST5's tier ladder "
      + "(`?terrainT1024`, T15R-TERRAIN): mode 'absent' + zeros is the "
      + "ABSENT-ladder legacy arm, not a failed one. tileSize/levels/"
      + "anisotropy describe what is LIVE, so they CHANGE on a promotion or "
      + "a pressure demote — level fields, never differenced.",
    fields: {
      manifest: L("json"), tileSize: L("count"), layers: L("count"),
      levels: L("count"),
      bytes: C("bytes", ["wire"]),
      payloads: C("count"), errors: C("count"), lastError: L("string"),
      built: L("enum", null, { note: '"color+nra" | "color" | null' }),
      anisotropy: L("count"), anisotropyBase: L("count"),
      enabled: L("bool"), bptc: L("bool"), support: L("string"),
      "ladder.mode": L("enum", null, { note: '"absent" | "defer" | "eager" | "off"' }),
      "ladder.armed": L("bool"),
      "ladder.tier": L("enum", null, { note: 'live tier: "t128" | the full tier | null' }),
      "ladder.fullTier": L("enum", null, { note: "promote target (manifest tier)" }),
      "ladder.sliceSource": L("enum", null, { note: '"pack" (D-12.6 slice) | null' }),
      "ladder.t128Ms": L("ms", ["converged"]),
      "ladder.t128Bytes": L("bytes", ["allocated"], { note: "2 arrays x 33 layers x chain(128^2)" }),
      "ladder.promoteStartMs": L("ms"),
      "ladder.terrainT1024CompleteMs": L("ms", null, { note: "SPEC B4b's named stamp" }),
      "ladder.promotions": C("count"),
      "ladder.demotions": C("count"),
      "ladder.promoteFailures": C("count"),
      "ladder.fallbacks": C("count", null, { note: "ladder could not arm -> legacy full-tier boot" }),
      "ladder.stageSplit": C("count", null, { note: "P-88MIB: promotions staged as 2 single-array uploads" }),
      "ladder.stageColorMs": L("ms"), "ladder.stageNraMs": L("ms"),
      "ladder.uploadWaitTimeouts": C("count"),
      "ladder.mirrorsReleased": C("count"),
      "ladder.mirrorBytesFreed": C("bytes", ["cpuMirror"]),
      "ladder.mirrorReleaseDeferred": C("count"),
      "ladder.mirrorRestores": C("count"),
      "ladder.mirrorRestoreFailed": C("count", null, { note: "MUST stay 0 — a missed restore is a black world" }),
      "ladder.colorUploaded": L("bool", null, { note: "three fired onUpdate on the albedo array" }),
      "ladder.nraUploaded": L("bool"),
      "ladder.colorVersion": L("count"),
      "ladder.colorReleaseArmed": L("bool", null, { note: "a mirror release is armed on the next upload" }),
      "ladder.lastError": L("string"),
    },
  },

  {
    name: "__atlasStats",
    status: "current",
    reads: "function",
    evidence: "scene3d/static_atlas.js:1027",
    availability: "in-world",
    retiresAt: "ST9",
    successor: "__diag.pools",
    note: "Module tally _atlasStats (static_atlas.js:975-999) + wrapper "
      + "aggregates. Atlas machinery is subsumed by draw pools at ST9; the "
      + "stall probe's reads swap to __diag.pools() in the same commit "
      + "(same-name-successor rule, pass-10 D-10.5).",
    fields: {
      feeds: C("count"), nodesIn: C("count"), atlased: C("count"),
      ptFiltered: C("count"), ptDeformed: C("count"), ptNoWH: C("count"),
      ptLayerFull: C("count"), ptNormFail: C("count"), ptGeomFail: C("count"),
      ptInstFail: C("count"), ptError: C("count"), ptErrorUnwound: C("count"),
      surfaceRefs: C("count"), layerAllocs: C("count"), layerHits: C("count"),
      layerRecycles: C("count"),
      layerGrows: C("count"), layerGrowUploads: C("count"), layerGrowFails: C("count"),
      nraLayersPacked: C("count"), nraWithNormal: C("count"), nraWithRough: C("count"),
      nraWithAo: C("count"), nraWithHeight: C("count"), nraResampled: C("count"),
      nraMetalDropped: C("count"), nraRepacked: C("count"), nraPendingDropped: C("count"),
      bc7Buckets: C("count"), bc7Layers: C("count"), ptBc7Deferred: C("count"),
      layerWriteZeroed: C("count"), ptLayerWriteFail: C("count"),
      allocLayers: L("count", ["allocated"]),
      capLayers: L("count", ["allocated"]),
      liveLayers: L("count", ["used"]),
      uniqueSurfacesEver: L("count"), dedupRatio: L("count"),
      growEnabled: L("bool"), nraEnabled: L("bool"),
      statPom: L("json"), nraPending: L("count"),
      bucketCount: L("count", ["resident"]),
      atlasBakedLbs: L("count", ["resident"]),
      buckets: L("json", null, { note: "per-bucket rows: alloc <= capacity (X7); allocated vs used per row" }),
    },
  },

  {
    name: "__diag.render",
    status: "current",
    reads: "object",
    evidence: "scene3d/index.js:543",
    availability: "in-world",
    note: "Per-frame renderer.info snapshot — every numeric here is a LEVEL "
      + "(PR-7: renderer.info.autoReset zeroes per frame; differencing a "
      + "per-frame counter is meaningless). Samplers wanting cumulative "
      + "draws must set info.autoReset=false themselves (bootab.mjs:50-63).",
    fields: {
      ts: L("ms"),
      calls: L("count", ["submitted"]),
      triangles: L("count", ["submitted"]),
      programs: L("count", ["resident"]),
      geometries: L("count", ["resident"]),
      textures: L("count", ["resident"]),
      sceneNodes: L("count", ["resident"]),
      meshNodes: L("count", ["resident"]),
    },
  },

  {
    name: "__diag.vfxGauge",
    status: "current",
    reads: "object",
    evidence: "scene3d/index.js:706",
    availability: "flag:?vfxGauge=on",
    note: "Half-B timing meter. tCpuMs/tGpuMs are LAST-FRAME levels; frames is "
      + "the only counter. tGpuMs=-1 when N/A; SwiftShader GPU clock is not "
      + "representative (the surface says so itself).",
    fields: {
      armed: L("bool"), gpuSource: L("enum"),
      tCpuMs: L("ms"), tGpuMs: L("ms"),
      frames: C("count"), note: L("string"),
    },
  },

  {
    name: "__diag.wasmMem",
    status: "current",
    reads: "async-function",
    evidence: "scene3d/index.js:4776",
    availability: "in-world",
    note: "Sums main + bake-worker hb_mem_census (src/lib.rs:11469-11593; "
      + "summarizeMemCensus in scene3d/mem_census.js:30-68). `missing` names "
      + "any half that cannot answer — UNKNOWN, never zero. Store rows: "
      + "surfacePixels/modelTri/shardRecords/surfaceHeight/sceneryRecords/"
      + "suiteArtifacts/sceneryAnim/negCache/texSwapAliases/scratchPool/"
      + "decodeDids, each {bytes, entries, budget}; budget:-1 = stated "
      + "structural bound, not unbounded-by-accident. allocTotal exists on "
      + "the halves only (cumulative; NOT summed into page). M3 sums every "
      + "instance that exists in the run's configuration or the run is "
      + "INVALID (F-11.12).",
    fields: {
      main: L("json"), worker: L("json"),
      "page.memoryBytes": L("bytes", ["wasmLinear", "allocated"]),
      "page.allocLive": L("bytes", ["wasmLinear", "used"]),
      "page.allocPeak": L("bytes", ["wasmLinear", "allocated"]),
      "page.storeBytes": L("bytes", ["wasmLinear", "used"]),
      "page.unattributed": L("bytes", ["wasmLinear", "used"]),
      "page.slackBytes": L("bytes", ["wasmLinear", "allocated"]),
      "page.decodePeakLiveBytes": L("bytes", ["wasmLinear"]),
      "page.stores.*.bytes": L("bytes", ["wasmLinear", "used"]),
      "page.stores.*.entries": L("count", ["resident"]),
      "page.top": L("json"),
      missing: L("json"), verdict: L("string"),
    },
  },

  {
    name: "__hbWasmMemory",
    status: "current",
    reads: "object",
    evidence: "index.html:2269",
    availability: "boot",
    note: "The MAIN instance's WebAssembly.Memory (also index.html:2291). "
      + "buffer.byteLength is the stall probe's wasmMemMB blind-spot closer "
      + "(pass-10 D-10.5): a delta > 0 across a long frame is memory.grow "
      + "evidence. WebAssembly.Memory never shrinks.",
    fields: {
      "buffer.byteLength": L("bytes", ["wasmLinear", "allocated"]),
    },
  },

  {
    name: "__linkProbe",
    status: "current",
    reads: "object",
    evidence: "scene3d/shader_prewarm.js:245",
    availability: "flag:?linkProbe=on",
    note: "GL link-probe state (installed at shader_prewarm.js:175-247; also "
      + "force-installable by callers). stats.linkStatus.ms is the "
      + "forced-wait bucket the stall probe sums as linkStatusMs — F5's "
      + "linkStatusMs=0 criterion reads it. Probe self-cost is priced by the "
      + "wrapper (PR-12).",
    fields: {
      "stats.linkProgramCalls": C("count"),
      "stats.linkStatus.calls": C("count"),
      "stats.linkStatus.ms": C("ms", null, { attribution: true }),
      "stats.linkStatus.worstMs": L("ms"),
      "stats.linkStatus.stallCalls": C("count"),
      "stats.completion.calls": C("count"),
      "stats.completion.ms": C("ms", null, { attribution: false }),
      "stats.other.calls": C("count"),
      "stats.other.ms": C("ms", null, { attribution: false }),
    },
  },

  {
    name: "__landblockLru.getStats",
    status: "current",
    reads: "function",
    evidence: "scene3d/index.js:6151",
    availability: "late",
    retiresAt: "ST7",
    successor: "__diag.residency",
    opaque: true,
    note: "LandblockLru.getStats() (scene3d/landblock_lru.js:2374+, ~40 "
      + "governor/park/reclaim fields). Registered OPAQUE: the surface "
      + "retires at ST7 when the slot grid becomes residency authority and "
      + "the governor is deleted — field-level schema work belongs to its "
      + "successor. Late-stamped ~35 s post-in-world (stall_probe.js:246); "
      + "poll for presence, never assume.",
    fields: {},
  },

  {
    name: "__diag.textures",
    status: "current",
    reads: "function",
    evidence: "scene3d/index.js:4806",
    availability: "flag:?texCensus=on",
    opaque: true,
    note: "WeakRef texture census (scene3d/texture_census.js). Returns null "
      + "unless ?texCensus=on armed the tracer. PR-11 contract: FORCE A GC "
      + "FIRST (CDP HeapProfiler.collectGarbage, >=2 calls, >=500 ms settle) "
      + "or everything dead reads alive (the 702 MB -> 28 MB retraction). "
      + "The tracer is itself retention: census runs are DEDICATED runs and "
      + "the flag rides the RESULTS taint list (D-10.4.4).",
    fields: {},
  },

  {
    name: "__diag.runAll",
    status: "current",
    reads: "function",
    evidence: "scene3d/diag.js:638",
    availability: "in-world",
    opaque: true,
    note: "Oracle-diff family (PASS|DRIFT|NO-ORACLE|INFRA + missingSurfaces "
      + "honesty rule, diag.js:660-664). Orthogonal correctness tooling — "
      + "retained untouched per pass-10 D-10.3.5; not a metrics surface.",
    fields: {},
  },

  {
    name: "__texWorkerStats",
    status: "current",
    reads: "function",
    evidence: "scene3d/xu7_textures.js:718",
    availability: "boot",
    retiresAt: "ST5",
    successor: "__texStats",
    note: "ST4 (`?texWorkers`, T14) texture-worker client tally — "
      + "texWorkerStats() in scene3d/xu7_textures.js. msTranscode/msAssemble "
      + "are OFF-THREAD worker time: reported, NEVER summed into explainedMs "
      + "(pass-10 S5) — only the sub-ms result integration lands in a frame. "
      + "fifoFallbacks/fallbackEngagements/pendingNulled/terrainFallbacks are "
      + "the T14 kill-criterion counters (a silent fallback = FAIL); on a "
      + "flag-OFF run everything reads 0 with enabled:false. Folds into "
      + "__texStats().worker at ST5 (same-name-successor rule).",
    fields: {
      jobs: C("count"), jobErrors: C("count"),
      msTranscode: C("ms", null, { attribution: false }),
      maxQueueDepth: L("count"),
      fifoFallbacks: C("count"), fallbackEngagements: C("count"),
      pendingNulled: C("count"), cancels: C("count"),
      terrainAssembles: C("count"),
      msAssemble: C("ms", null, { attribution: false }),
      terrainFallbacks: C("count"), nraDerives: C("count"),
      lastError: L("string"),
      enabled: L("bool"), requested: L("count"),
      state: L("enum", null, { note: '"off" | "loading" | "ready" | "dead"' }),
      queueDepth: L("count"), inflight: L("count"),
    },
  },

  {
    // Landed current at ST2 (T12, 2026-08-09): reserved field schema kept
    // verbatim; stage additions: `enabled` (armed state — flag ON +
    // world_index present), `quarantinedTotal` (cumulative terminal
    // quarantines, THE GATE-WIRE-BOOT counter; `quarantined` stays the
    // LIVE list), `packSource` (pack_source_stats() mirror from the wasm
    // seam). Published only on the `?packSource=on` arm; the object is
    // created at controller construction so an armed session always
    // carries it from boot.
    name: "__hbFetch",
    status: "current",
    reads: "object",
    evidence: "scene3d/pack_fetch_controller.js:835",
    spec: "pass-10 S3 (pass 3 S9 completed)",
    availability: "flag:?packSource=on",
    note: "PackFetchController surface. wireWaitEvents is THE C5 instrument "
      + "(0 = pass): frames where lane-U content the player occupies was not "
      + "resident at need. byComponent is the mandatory B1 attribution table "
      + "(components: code/manifestIndex/core/meta/tiles/interior/pvw/"
      + "terrainTier/texFull).",
    fields: {
      enabled: L("bool"),
      quarantinedTotal: C("count"),
      packSource: L("json", null, { note: "pack_source_stats() mirror; null until armed+inserted" }),
      "lanes.*.queued": L("count"),
      "lanes.*.inflight": L("count"),
      "lanes.*.done": C("count"),
      "lanes.*.failed": C("count"),
      "lanes.*.bytes": C("bytes", ["wire"]),
      "verify.engine": L("enum", null, { note: '"subtle" | "wasm"' }),
      "verify.ok": C("count"),
      "verify.mismatch": C("count"),
      "verify.msTotal": C("ms", null, { attribution: false, note: "async, not main-thread JS time (SPEC 1.1)" }),
      retries: C("count"),
      quarantined: L("json", null, { note: "tileId list; authoritative, never erased by residency" }),
      pinnedIndex: L("string"),
      "milestones.inWorldMs": L("ms", ["in-world"]),
      "milestones.previewCompleteMs": L("ms", ["preview-complete"]),
      "milestones.convergedMs": L("ms", ["converged"]),
      "byComponent.*.requests": C("count", ["wire"]),
      "byComponent.*.bytes": C("bytes", ["wire"]),
      wireWaitEvents: C("count"),
      taint: L("json"),
    },
  },

  // ── reserved surfaces (pass-10 S3 normative schemas; land with their stage) ─

  {
    // Landed current at ST7 (T20, 2026-08-09): reserved field schema kept
    // verbatim; stage additions: `gridLruDivergence` (the SPEC §1.4
    // assert-only diff counter — THE GATE-GRID criterion), `packSource`
    // (pack_source_stats mirror incl. pins/budget/floor/evictions) and the
    // opaque `adapter` row (feed/park/release/teleport/sealed counters).
    // Published only on the `?slotGrid=on` (+`?packSource=on`, D-12.4) arm;
    // `tex` stays null until ST5 lands __texStats; `leaseBytesPeak` reads 0
    // until worker leases exist (T20 report D1 — leases deferred to the
    // first pack-consuming worker job, T13).
    name: "__diag.residency",
    status: "current",
    reads: "function",
    evidence: "scene3d/index.js:6548",
    spec: "pass-10 S3 (pass 6 D-06.9.4 + additions)",
    availability: "flag:?slotGrid=on",
    note: "Slot-grid residency surface; successor of __landblockLru.getStats. "
      + "pinLeaks/shiftMismatches/slotDesyncs are zero-tolerance CENSUS-CI "
      + "gates; r4Engagements > 0 on a default run = FAIL; "
      + "gridLruDivergence must read 0 over the battery (GATE-GRID).",
    fields: {
      gridLruDivergence: C("count"),
      packSource: L("json", null, { note: "pack_source_stats() mirror (pins/budget/floor); null pre-arm" }),
      adapter: L("json", null, { note: "GridResidencyAdapter.getStats() — feeds/parks/releases/teleport/sealed counters" }),
      "grid.W": L("count"),
      "grid.anchor": L("json"),
      "grid.slots.live": L("count", ["resident"]),
      "grid.slots.parked": L("count", ["resident"]),
      "grid.slots.fetching": L("count", ["resident"]),
      "grid.slots.staged": L("count", ["resident"]),
      "grid.slots.quarantined": L("count", ["resident"]),
      "grid.shifts": C("count"),
      "grid.teleports": C("count"),
      "grid.shiftMismatches": C("count"),
      "grid.slotDesyncs": C("count"),
      "park.tiles": L("count", ["parked"]),
      "park.bytes": L("bytes", ["parked", "allocated"]),
      "park.usedBytes": L("bytes", ["parked", "used"]),
      "park.floorMs": L("ms"),
      "park.deferredCount": C("count"),
      "park.deferredBytes": C("bytes", ["parked"]),
      "park.reAdoptCancels": C("count"),
      "ladder.rung": L("count"),
      "ladder.r4Engagements": C("count"),
      "ladder.floorLowerings": C("count"),
      "wasm.perInstance": L("json"),
      "wasm.summedBytes": L("bytes", ["wasmLinear", "allocated"]),
      "wasm.instancesSummed": L("count"),
      tex: L("json", null, { note: "__texStats byClass vs budgets" }),
      "heap.usedJSHeapSize": L("bytes", ["heap", "used"]),
      pinLeaks: C("count"),
      leaseBytesPeak: L("bytes", ["leased"]),
    },
  },

  {
    name: "__diag.pools",
    status: "reserved",
    reads: "function",
    spec: "pass-10 S3 (pass 7 S7 + M6 pair)",
    availability: "reserved:ST9",
    note: "Draw-pool surface; successor of __atlasStats. classes.createdPostBoot "
      + "and parked-frame events.mutationsThisFrame are zero-tolerance gates. "
      + "draws.* sampled under PR-7 (autoReset off, cumulative, /frames).",
    fields: {
      "pools.count": L("count", ["resident"]),
      "pools.byClass": L("json"),
      "pools.byPass": L("json"),
      "classes.count": L("count"),
      "classes.createdPostBoot": C("count"),
      "nodes.scene": L("count", ["resident"]),
      "nodes.worldStatic": L("count", ["resident"]),
      "nodes.entity": L("count", ["resident"]),
      "geometry.allocatedBytes": L("bytes", ["allocated"]),
      "geometry.usedBytes": L("bytes", ["used"]),
      "geometry.dedupHits": C("count"),
      "events.feeds": C("count"),
      "events.parks": C("count"),
      "events.adopts": C("count"),
      "events.releases": C("count"),
      "events.bandSwaps": C("count"),
      "events.cellFlips": C("count"),
      "events.mutationsThisFrame": L("count"),
      "draws.submitted": L("count", ["submitted"]),
      "draws.switchRate": L("count", ["submitted"]),
      "draws.programSwitches": L("count", ["submitted"]),
    },
  },

  {
    name: "__framePhase",
    status: "current",
    reads: "object",
    evidence: "scene3d/frame_work.js:657",
    availability: "flag:?framePhase=on",
    note: "T21 (ST8 stage A) — the GATE-PHASE census instrument, stamped by "
      + "index.js via framePhaseBegin/Cut/Commit into the pass-08 S1 "
      + "taxonomy (p0 SIM, p1 residency-class LRU block, p2 world ticks, "
      + "p3 render, p4 stream slot). Phases publish BOTH last-frame "
      + "(p0..p4) and cumulative (p0Ms..p4Ms + frames) — a per-frame-only "
      + "vector cannot be differenced, which is the probe's entire method. "
      + "Cumulative phase sums are reported under a separate `phases` "
      + "section, NOT summed into explainedMs (they overlap the GL "
      + "buckets). Deliberately independent of ?frameWork: re-classing the "
      + "[A] budgets requires measuring the LEGACY arm, where p4 ≈ 0 and "
      + "the families' between-frames work is invisible to the vector. "
      + "Reduce with harness/frame-phase-census.mjs.",
    fields: {
      p0: L("ms"), p1: L("ms"), p2: L("ms"), p3: L("ms"), p4: L("ms"),
      p0Ms: C("ms", null, { attribution: false }),
      p1Ms: C("ms", null, { attribution: false }),
      p2Ms: C("ms", null, { attribution: false }),
      p3Ms: C("ms", null, { attribution: false }),
      p4Ms: C("ms", null, { attribution: false }),
      frames: C("count"),
    },
  },

  {
    name: "__frameWork",
    status: "current",
    reads: "object",
    evidence: "scene3d/frame_work.js:591",
    availability: "boot",
    note: "T21 (ST8 stage A) — FrameWorkScheduler surface, installed at "
      + "module scope so a flag-OFF run reads {enabled:false, zeros} instead "
      + "of probing a hole (__texWorkerStats convention). Class rows W1..W6 "
      + "(stage A: only W6 has producers — the legacy families; W1..W5 fill "
      + "at ST9). mode is a LEVEL — TELEPORT/BOOT-labeled long frames are "
      + "design-accepted (F6 excludes them); scoring only reads mode=NORMAL "
      + "frames. guardServices counts stale-guard slot services (no frame "
      + "driver ran P4 within 250 ms — boot/hidden-tab/renderOnDemand). "
      + "uploads.* is the stage-C shape, zeros until T22 lands staging.",
    fields: {
      "classes.*.ran": C("count"),
      "classes.*.deferredFrames": C("count"),
      "classes.*.forcedRuns": C("count"),
      "classes.*.maxItemMs": L("ms"),
      "classes.*.queueDepth": L("count"),
      "classes.*.itemsThisFrame": L("count"),
      mode: L("enum", null, { note: "NORMAL | BOOT | TELEPORT | EMERGENCY | CROSSING" }),
      enabled: L("bool"),
      budgetMs: L("ms"),
      teleports: C("count"),
      guardServices: C("count"),
      "uploads.stagedBytesByClass": C("bytes", ["staged"]),
      "uploads.initTextureCalls": C("count"),
      "uploads.exclusive": L("json", null, { note: "ring 16" }),
    },
  },

  {
    name: "__texStats",
    status: "current",
    reads: "function",
    evidence: "scene3d/bc7_textures.js:792",
    availability: "boot",
    note: "Texture tier/worker surface — LANDED at T15 (ST5, "
      + "`?texCompressedOnly`; texStats() in bc7_textures.js, window-installed "
      + "by initBc7Source; __texWorkerStats folds in as .worker per its "
      + "same-name-successor edge and stays installed through the migration "
      + "window). worker.msTranscode is reported but "
      + "NEVER summed into explainedMs — worker time is off-thread; only its "
      + "integration cost lands in a frame (pass-10 S5). "
      + "coverage.texrefMissingPvw MUST stay 0 once carriers are resident "
      + "(loud skew, never silent RGBA8; at T15 a not-yet-resident PVW "
      + "carrier legacy-routes and counts here — see the T15 report "
      + "deviation). arrays = the __atlasStats tally (window seam); "
      + "terrain/atlas-staging mirror rows stay on their own surfaces.",
    fields: {
      "tiers.pvwHits": C("count"),
      "tiers.fullSwaps": C("count"),
      "tiers.fullFailed": C("count"),
      "tiers.demotions": C("count"),
      "tiers.nraAttached": C("count"),
      "tiers.chainWriteRejects": C("count"),
      "worker.jobs": C("count"),
      "worker.msTranscode": C("ms", null, { attribution: false }),
      "worker.queueDepth": L("count"),
      "worker.maxQueueDepth": L("count"),
      "worker.fallbackArm": L("bool"),
      "mirrors.byClass": L("json", null, { note: "bytes by class @cpuMirror" }),
      // T15R — rehydrate v3 row 2 (D-05.7): the full-tier mirror release
      // seam. `restoreFailed` is the counter that must stay 0 (a released
      // mirror with no way back is a black surface after a context loss);
      // `releaseDeferred` counts evictions that found a not-yet-uploaded
      // texture and correctly kept its bytes.
      "mirrors.release.armed": L("count"),
      "mirrors.release.released": L("count"),
      "mirrors.release.freed": C("count"),
      "mirrors.release.bytesFreed": C("bytes", ["cpuMirror"]),
      "mirrors.release.releaseDeferred": C("count"),
      "mirrors.release.restores": C("count"),
      "mirrors.release.restoreFailed": C("count"),
      "arrays.alloc": L("bytes", ["allocated"]),
      "arrays.used": L("bytes", ["used"]),
      "arrays.mipBytes": L("bytes", ["allocated"]),
      rehydrate: L("json"),
      "coverage.texrefMissingPvw": L("count"),
    },
  },

  {
    name: "__diag.geometry",
    status: "current",
    reads: "object",
    evidence: "scene3d/geom_bundles.js:69",
    availability: "boot",
    note: "Geometry-bundle surface — LANDED at T13 (ST3, `?geomBundles`; "
      + "installed by geom_bundles.js on module load, live counters when "
      + "the flag arms). entityDecode counters gate the DORMANT "
      + "substitution cache (enable-threshold = owner call on this data, "
      + "DT-11) and read ZERO until the entity-path instrumentation lands "
      + "(named T13 remainder). bytesOut = wasm->JS boundary bytes of "
      + "assembled bundles; geomFallback counts models served by the "
      + "runtime decode under the armed flag (must trend to entity-only).",
    fields: {
      "bundles.assembled": C("count"),
      "bundles.bytesOut": C("bytes", ["staged"]),
      "bundles.msAssemble": C("ms", null, { attribution: false }),
      "entityDecode.count": C("count"),
      "entityDecode.msTotal": C("ms", null, { attribution: false }),
      "entityDecode.substKeyDupes": C("count"),
      "geomFallback.modelsServedByRuntimeDecode": C("count"),
      "relief.armed": L("bool", null, { note: "RELIEF-IN-BAKE: the baked relief VARIANT export is in use (`?reliefBundles=on` + gfxRelief resolved ON + subdivLevel 0)" }),
      "relief.variantRowsResident": L("count", null, { note: "GEOMR rows in the resident packs; 0 = this dist was baked without --geom-relief, so every model reads its relief-free default (warned at arm)" }),
      "relief.modelsAssembled": C("count"),
    },
  },

  {
    name: "__prewarmStats",
    status: "reserved",
    reads: "object",
    spec: "pass-10 S3 (pass 8 S5.4)",
    availability: "reserved:ST9",
    note: "Boot class-census prewarm cost (DT-45: BOOT-666/PARKED-REF read "
      + "msColor/msDepth). Post-boot class mint is a bug.",
    fields: {
      classes: L("count"),
      colorPrograms: L("count"),
      depthPrograms: L("count"),
      msColor: L("ms"),
      msDepth: L("ms"),
    },
  },
]);

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

export function getSurface(name) {
  return REGISTRY.find((s) => s.name === name) || null;
}

export function listSurfaces(status) {
  return REGISTRY.filter((s) => !status || s.status === status).map((s) => s.name);
}

/** Reserved new-architecture names — nothing else may squat on them. */
export const RESERVED_NAMES = Object.freeze(listSurfaces("reserved"));

// ---------------------------------------------------------------------------
// validation (the Tier-1 lint body; test_diag_schema.mjs drives it)
// ---------------------------------------------------------------------------

const LAST_SEG = (path) => String(path).split(".").pop();

/**
 * Validate one field declaration. Returns an array of error strings
 * (empty = clean). Exported so the lint can also exercise it negatively.
 */
export function validateField(surfaceName, path, def) {
  const errs = [];
  const at = `${surfaceName}.${path}`;
  if (!def || typeof def !== "object") return [`${at}: field def must be an object`];
  if (!KINDS.includes(def.kind)) errs.push(`${at}: kind must be one of ${KINDS.join("|")}, got ${def.kind}`);
  if (!UNITS.includes(def.unit)) errs.push(`${at}: unit must be one of ${UNITS.join("|")}, got ${def.unit}`);
  const seg = LAST_SEG(path);
  // Unit rides the name: a *Ms / *Bytes suffix is a CLAIM the unit must honor.
  if (/Ms$/.test(seg) && def.unit !== "ms") errs.push(`${at}: name ends in Ms but unit is ${def.unit}`);
  if (/Bytes$/.test(seg) && def.unit !== "bytes") errs.push(`${at}: name ends in Bytes but unit is ${def.unit}`);
  // Only ms-denominated fields may enter an attribution sum. Counts are never
  // priced (D-10.1 point 2 — the "six 2x+ overestimates" lesson).
  if (def.attribution === true) {
    if (def.unit !== "ms") errs.push(`${at}: attribution:true on a non-ms field — counts are never priced`);
    if (!/(^ms$|Ms$)/.test(seg)) errs.push(`${at}: attribution:true but name lacks the Ms suffix (_MS_KEYS discipline)`);
  }
  // Bytes without a declared population/home is the 2x-scale-error trap.
  if (def.unit === "bytes") {
    if (!Array.isArray(def.scale) || def.scale.length === 0) {
      errs.push(`${at}: bytes field must declare at least one @scale tag`);
    }
  }
  if (def.scale != null) {
    if (!Array.isArray(def.scale)) {
      errs.push(`${at}: scale must be an array of S1 tags`);
    } else {
      for (const tag of def.scale) {
        if (!SCALE_TAGS.includes(tag)) errs.push(`${at}: unknown scale tag "${tag}" (closed vocabulary: ${SCALE_TAGS.join(", ")})`);
      }
    }
  }
  return errs;
}

/**
 * Validate a whole registry (defaults to THE registry). Returns
 * { ok, errors: string[] }. Rules enforced:
 *   - name/status/reads/availability present and legal;
 *   - current surfaces cite `evidence` (file:line), reserved cite `spec`;
 *   - no duplicate names; reserved names cannot collide with current names;
 *   - every field passes validateField (opaque surfaces may have {} fields
 *     but MUST say why in `note`);
 *   - same-name-successor rule: retiresAt requires a successor that is itself
 *     registered.
 */
export function validateRegistry(registry = REGISTRY) {
  const errors = [];
  const seen = new Map(); // name -> status
  for (const s of registry) {
    const name = s && s.name;
    if (!name || typeof name !== "string") { errors.push(`surface with missing/invalid name: ${JSON.stringify(s && s.name)}`); continue; }
    if (seen.has(name)) errors.push(`${name}: duplicate surface name (first was ${seen.get(name)})`);
    seen.set(name, s.status);
    if (!STATUSES.includes(s.status)) errors.push(`${name}: status must be ${STATUSES.join("|")}, got ${s.status}`);
    if (!["function", "object", "async-function"].includes(s.reads)) errors.push(`${name}: reads must be function|object|async-function`);
    if (!s.availability || typeof s.availability !== "string") errors.push(`${name}: availability is required (install-timing ledger, D-10.3.4)`);
    if (s.status === "current" && !/^\S+:\d+$/.test(String(s.evidence || ""))) {
      errors.push(`${name}: current surface must cite evidence as <path>:<line>, got ${JSON.stringify(s.evidence)}`);
    }
    if (s.status === "reserved" && !(typeof s.spec === "string" && s.spec.length > 0)) {
      errors.push(`${name}: reserved surface must cite its spec section`);
    }
    const fields = s.fields || {};
    const fieldNames = Object.keys(fields);
    if (fieldNames.length === 0 && s.opaque !== true) {
      errors.push(`${name}: no fields declared and not marked opaque`);
    }
    if (s.opaque === true && !(typeof s.note === "string" && s.note.length > 0)) {
      errors.push(`${name}: opaque surface must carry a note saying why`);
    }
    for (const [path, def] of Object.entries(fields)) errors.push(...validateField(name, path, def));
    if (s.retiresAt != null) {
      if (!s.successor) {
        errors.push(`${name}: retiresAt=${s.retiresAt} without a successor (same-name-successor rule, D-10.3.2)`);
      } else if (!registry.some((o) => o.name === s.successor)) {
        errors.push(`${name}: successor "${s.successor}" is not registered`);
      }
    }
  }
  // Reserved/current collision (same name in both states is a squat).
  for (const s of registry) {
    if (s.status !== "reserved") continue;
    const clash = registry.find((o) => o !== s && o.name === s.name && o.status === "current");
    if (clash) errors.push(`${s.name}: reserved name collides with a current surface`);
  }
  return { ok: errors.length === 0, errors };
}
