# RETRACTION — the "3.6 GB JS-heap step" was an instrument artifact (2026-07-26)

A DAT-census investigation of the Town Network step (why would 205 cells cost
3.45 GB?) instead refuted the measurement itself, with four independent proofs.
This retires a chain of conclusions from the last three nights. Raw probes:
scratchpad `memprobe.mjs` / `heapprobe.mjs`; censuses `cells3.pkl`/`envs.pkl`.

## The proofs

1. **Quantized + cached.** The battery reads
   `performance.memory.usedJSHeapSize` (`battery-telepoi.mjs:364`), and our
   Chrome launches WITHOUT `--enable-precise-memory-info` (`harness/lib/boot.mjs:197-205`).
   Unflagged Blink quantizes onto a ~100-rung ladder AND caches the value for
   **20 minutes**. Every arm shows exactly TWO distinct `jsu` values per
   session — bit-identical for 48 consecutive samples over 18 minutes while
   `mats` grew 19→284 MB.
2. **The value is impossible.** 3,760,000,000 B = 3,586 MB is **1.67× this
   machine's V8 heap limit** (2,330,000,000 B, probe-verified). The tab would
   have died long before.
3. **The step tracks wall clock, not location.** armRecOn stepped at stop 52,
   armRecOff at stop 50, ~20 min into each session — the MemoryInfo cache
   expiring. This is why the step "moved" between Swank, Timaru, and Town
   Network across write-ups: it was never at a POI.
4. **Direct measurement.** CDP `Runtime.getHeapUsage` after
   `HeapProfiler.collectGarbage` (precise, uncached): **Town Network entry
   costs ~20.5 MB**; the client idles at ~50 MB V8 heap with 973 dungeon cells
   resident. Same page, same instant, `performance.memory` read a frozen
   468 MB.

## What is retired

- The "renderer OOM at 3,586 MB" narrative and every location attribution of
  the step (MaterialCache §6 H1, Swank museum, Town Network geometry). The
  falsifier runs' INTERVENTION results stand (bounding MaterialCache at 64 MB
  worsened settle; `?recolor=off` changed nothing about the artifact) — only
  their heap-step interpretation dies.
- `jsHeapPeakMedMB`/`MaxMB` columns in every battery to date: garbage. The S5
  "heap went 37× while wasm did not move" observation: the 37× was the
  quantization rung, not memory.
- The Town Network content hypothesis — the census kills it independently:
  TN is 15 distinct environments, 270 shared verts, 12 distinct surfaces,
  ~0.6 MB retail-resident, ~2.5 MB our-side predicted; Swank is strictly
  larger on every content axis (28× environment bytes) and was fine.

## What survives (measured by honest instruments)

- **All wasm numbers** (`wasmMemoryBytes` = `memory.buffer.byteLength`, exact):
  the 680 MB main-instance residency, the worker high-waters, the handle-fix
  scoring, the surface-budget 24:64 result. The real memory story was always
  wasm-side.
- **All byte-sum tallies** (`matMB`/`palMB`/`entMB` — direct
  `image.data.byteLength` sums): 323–431 MB of texture ArrayBuffers were
  genuinely live. ⚠ These are **invisible to BOTH heap instruments** —
  ArrayBuffer backing stores are V8-external. `getHeapUsage`'s ~50 MB is the
  V8 heap only, NOT the renderer's footprint.
- **Settle/age-collapse observations** (wall-clock medians): real, but their
  "GC pressure from a giant JS retained set" mechanism is now unsupported.
  With V8 heap at ~50 MB, the collapse driver hunt moves to wasm-side caches,
  eviction churn, and scene-graph growth.
- The paletted-cache thrash (`palEvict` 11,604) is a real churn/CPU/duplication
  defect and the byte budget is still the right fix — but its "1–2 GB retained"
  MB attribution came from the artifact and is withdrawn. True retained bytes
  now need the fixed instrument.
- Historical renderer deaths (pre handle-fix) were real; their driver was
  plausibly total process RSS (wasm 680 MB + ArrayBuffer externals + V8 +
  GPU-process share), not a 3.6 GB V8 heap.

## Instrument fix (next slice)

Replace the battery's `jsu` read with (a) CDP `Runtime.getHeapUsage`
(precise V8 heap) and (b) an externals measure — either
`performance.measureUserAgentSpecificMemory()` where cross-origin-isolation
allows, or process-level RSS via CDP `SystemInfo`/`Memory` — plus keep the
existing byte-sum tallies as the per-pool truth. Retire the old column name so
no future doc grafts onto `jsHeapPeakMB`.

## Trap for the permanent list

**Never trust `performance.memory` without `--enable-precise-memory-info`** —
it is a 20-minute-cached, order-of-magnitude-quantized step function whose
top rungs exceed the actual heap limit. A "step" in it is a clock, not an
allocation. And even precise V8-heap numbers exclude ArrayBuffer backing
stores — for a client whose payload lives in typed arrays, heap ≠ footprint.
