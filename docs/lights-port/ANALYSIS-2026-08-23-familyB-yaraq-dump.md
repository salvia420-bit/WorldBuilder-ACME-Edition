# ANALYSIS 2026-08-23 — family-B Yaraq crash, full-dump forensics (fork A)

Dump: `acclient.exe.12356.dmp` (full memory, 2.5 GB), pulled to `/mnt/wbterminal2/crashdump-12356/`.
Baseline comparisons: dump 1360 (early session) and 18236 (family A). Tooling: `va_census.py`,
`dump_stack.py` (session scratchpad; standalone, no deps).

## Verdict

**Address-space FRAGMENTATION, not raw exhaustion — and NOT a family-A relapse (the LFA fix was
live).** The process had ~1.35 GB of "free" VM by the counter, but the **largest contiguous free
block was 1.11 MB** and total free was **62 MB in sub-4 MB shards**. The low 2 GB was too
fragmented to satisfy allocations, so the heap sprawled **466 MB into the 2–2.6 GB high half
across 235 segments**. The crash is `RtlFreeHeap` coalescing during object teardown, walking into
a **decommitted interior page of a live heap segment** → read AV.

## Faulting stack (symbolized via acclient.map, VA = 0x401000 + RVA)

```
ntdll+0x87D4C   RtlFreeHeap/coalesce   (read AV @ 0x90F95FF8)
CSetup::`vector deleting destructor'+0x53   ← CPhysicsObj::~CPhysicsObj
ParticleEmitter::Destroy → ParticleManager::~ParticleManager → CPhysicsObj::Destroy
CObjectMaint::DeleteObject → CObjectMaint::UseTime → SmartBox::UseTime
Client::UseTime → Client::Run
```

Exception `0xC0000005` READ at `0x90F95FF8`; `ESI=0x02940000` (heap handle), `ECX=0x193D0`
(103 KB coalesce run). Object-maintenance teardown freeing a CPhysicsObj/ParticleEmitter/CSetup —
the crash is on the **free** side, not an allocation.

## Proof points

1. **LFA exe confirmed in-dump** (family A ≠ family B): scanning mapped `.text` for the align
   idiom — dump 12356 (Yaraq) = **0 original / 189 patched**; dump 18236 (family A) =
   189 original / 0 patched. Different bugs.
2. **Census at crash (12356, <4GB)**: committed image 353 MB, mapped 70 MB, **committed private
   1363 MB**, reserved 199 MB, **free 62 MB**. Free histogram `{1–4MB: 2, 64K–1MB: 118,
   <64K: 687}` — **largest free block 1.11 MB, no run ≥ 4 MB**. Baseline dump 1360 still had a
   73 MB largest-free and 287 MB free — fragmentation degraded to shards over the session.
3. **Fragmentation, not a wild pointer** — the fault region and its committed neighbor share one
   AllocationBase:
   ```
   base=0x90F7B000 allocbase=0x90160000 120KB  RESERVE prot=0 (NOACCESS)  ← fault @0x90F95FF8
   base=0x90F99000 allocbase=0x90160000 1220KB COMMIT  prot=0x4 (RW)
   ```
   One ~15 MB heap segment with a decommitted interior; the coalesce walked from the committed
   part into the segment's own uncommitted range. NT heap decommits interior free pages under
   pressure; a coalesce touching one is the terminal symptom of a heap both huge and fragmented.
4. **Top consumers**: dozens of **15.8 MB committed-private blocks** (dense-dat cache/mesh/texture
   residency buffers) dominate; GPU driver images pin ~180 MB low (nvd3dum/nvwgf2um/nvgpucomp32);
   **RTSSHooks.dll = 52.6 MB** (RivaTuner/Afterburner overlay — third-party, eats low-2GB space;
   recommend removing from any shipping player's box, and note it inflates the owner's box today).

## Why "1.35 GB free" still crashed

The VM counter measures reserve+commit, not contiguity. Largest free 1.11 MB → any >1.11 MB
allocation fails low → heap reserves high → 466 MB / 235-segment sprawl → coalesce hits a
decommitted high interior → AV. Classic 32-bit fragmentation death, triggering well below the
ceiling.

## Prescription

1. **Primary — footprint reduction (root)**: cut r9 dense-dat residency so the worst town's
   committed-private peaks under **~1.1–1.2 GB** and VM under **~1.9–2.0 GB**, keeping the heap
   out of the high half. The 15.8 MB cache blocks are the target (cap densification, evict
   distant models).
2. **Backstop — residency governor** (RESEARCH-2026-08-23-residency-governor.md): ⚠ VM is a
   *weak* trigger — the post-LFA tour survived priv=2344 MB in Holtburg while Yaraq died at
   priv=1363 MB; the killer is fragmentation *state*, not a clean line. The governor must cap
   footprint **proactively** (freelist budget caps), and any watermark should read
   **committed-private (~1.1 GB proxy)** and/or the **low-2GB largest-free-block** directly,
   not `ullAvailVirtual`.
3. **Cheap hardening candidate (not yet built)**: this fault is a coalesce reading a decommitted
   interior — raising the heap decommit threshold (`HeapDeCommitFreeBlockThreshold`, set at heap
   creation via registry / launcher environment) keeps free interiors committed, converting this
   AV into a benign in-bounds read. Costs working set, does not fix fragmentation; worth testing
   independently for the shipping player path while the content diet lands.

Confidence: high — four independent consistent facts (symbolized free-path stack; LFA-present
scan; 1.11 MB largest-free / 466 MB high-half sprawl; shared-AllocationBase decommitted interior).
