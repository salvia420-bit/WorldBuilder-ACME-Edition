# RESEARCH 2026-08-23 — plugin-side residency governor for crash family B (heap exhaustion)

Fork-B deliverable. Every symbol, offset, and VA below was read-verified in the sources this
session (greps quoted inline). Decomp = `~/ac-headers/acclient.c/.h` (build ≠ shipped exe —
its inline addresses are NOT usable); PDB dump = `acclient.txt`; **runtime VAs come from the
chorizite link map** (`external/chorizite/Chorizite/Chorizite.Core/acclient.map`,
VA = 0x401000 + map RVA — rule re-verified this session: map `0010F7C0
CPhysicsObj::set_lights` → 0x5107C0, the exact VA the deployed AcmeLights TorchLights already
calls successfully; ditto `000520E0 SmartBox::SetWorldAmbientLight` → 0x4530E0).

## 1. The problem, restated with the machinery now known

The client DOES have a residency system: every DAT-derived object (`DBObj`) lives in a
per-DB_TYPE `DBOCache` with refcounting and a bounded LRU **freelist** of dead (refcount-0)
objects kept for reuse. What it does NOT have is any memory-pressure feedback: freelist
budgets are fixed counts tuned for 2005-sized assets, and the only background drain destroys
AT MOST ONE stale object per cache per tick. r9 assets are 3–4× meshes and ~4–16× texture
bytes, so the same *counts* now pin hundreds of MB of dead objects, and transient spikes
(portal into a dense town while the old town's objects are still freelisted) blow the 32-bit
address space. That is exactly the observed tour signature (VM 2.3→2.95 GB oscillation,
partial reclaim after each hop) and the Yaraq crash (heap alloc failure at 2.65 GB VM).

## 2. Retail machinery (verified)

### 2.1 DBObj — the cached object (PDB fieldlist 0x4e11)

```
@4  m_dataCategory   @8  m_bLoaded        @16 m_timeStamp (double)
@24 m_pNext          @28 m_pLast          @32 m_pMaintainer (DBOCache*)
@36 m_numLinks (REFCOUNT)  @40 m_DID      @44 m_AllowedInFreeList
```

### 2.2 DBOCache — one cache per DB_TYPE (PDB fieldlist 0x4e44)

```
@4   m_ObjTable (AutoGrowHashTable did→DBObj*)   @120 m_dbtype
@240 m_fCanKeepFreeObjs  @241 m_fKeepFreeObjs    @242 m_bFreelistActive
@244 m_freelistDef { @244 bRecycle, @245 bShrink, @248 nIdealSize, @252 nMaxSize }
@256 m_pOldestFree  @260 m_pYoungestFree  @264 m_nFree  @268 m_nTotalCount
@272 m_pfnAllocator
```

Mechanics (all read from `acclient.c` bodies, anchor-greppable by symbol):

- `DBOCache::FreeObject` — called when an object's last ref drops. If
  `m_fKeepFreeObjs && m_AllowedInFreeList` → `FreelistAdd`, else `DestroyObj` (real free).
- `DBOCache::FreelistAdd` — appends to the LRU list, stamps `m_timeStamp`;
  **if `m_nFree+1 > m_freelistDef.m_nMaxSize` it immediately destroys the oldest** —
  i.e. the freelist SELF-ENFORCES `nMaxSize`. This is the load-bearing fact for Tier 1
  below: shrink `nMaxSize` and the cache trims itself on every subsequent free, no code
  path changes at all.
- `DBOCache::UseTime` — the only background drain: destroys AT MOST ONE object per call,
  only if `m_nFree > nIdealSize` AND the oldest is >30 s stale
  (`v2->m_timeStamp + 30.0 < Timer::cur_time`). At 144–400 max entries this is a trickle.
- `DBOCache::FlushFreeObjects` — loop `FreelistRemoveOldest` + `DestroyObj` until
  `m_nFree == 0`. **Touches ONLY refcount-0 freelist members — in-use objects are
  structurally unreachable from it.** This is the safety property the whole design leans on.
- `DBOCache::KeepFreeObjects(bool)` — toggles freelisting; on true→false transition calls
  FlushFreeObjects.

### 2.3 DBCache statics — the process-wide levers (THE governor API)

All registered caches live in one hash (`stru_81760C` in the decomp, dbtype → DBOCache*).

| native | map RVA | **runtime VA** | convention | semantics |
|---|---|---|---|---|
| `DBCache::FlushFreeObjects(ulong db_type)` | 000134E0 | **0x4144E0** | __stdcall | db_type≠0: flush that cache; **db_type==0: flush EVERY cache** (verified: else-branch iterates the full hash) |
| `DBCache::KeepFreeObjects(bool, ulong)` | 00013620 | **0x414620** | __stdcall | same 0=all fan-out; false also disables refill. Retail itself calls `(false, 0)` in `ThreadedCache::SetShutdown` — the pattern is sanctioned |
| `DBCache::GetDBOCache(ulong dbtype)` | 00013590 | **0x414590** | __cdecl | returns `DBOCache*` or NULL — for budget writes + telemetry |
| `DBCache::UnloadCellData()` | 000133F0 | **0x4143F0** | (static, no args) | FlushFreeObjects on every cell-type cache (LAND_BLOCK/LBI/CELL…), returns bool "all empty" |
| `DBOCache::FlushFreeObjects()` | 00015B10 | 0x416B10 | __thiscall | per-instance variant (not needed if using the statics) |

### 2.4 Per-type freelist budgets (extracted from the MasterDBMap registration, acclient.c ~92064ff)

The r9-relevant caches (dbtype value → ideal/max free objects):

| DB_TYPE | # | ideal | max | r9 exposure |
|---|---|---|---|---|
| LAND_BLOCK | 1 | 21 | 144 | dense relief meshes |
| LBI | 2 | 21 | 144 | |
| CELL | 3 | 20 | 144 | dungeon EnvCells |
| GFXOBJ | 6 | 100 | 200 | **3–4× denser meshes** |
| SETUP | 7 | 25 | 100 | |
| ANIM | 8 | 20 | 80 | |
| PALETTE | 10 | 60 | 100 | |
| SURFACETEXTURE | 11 | 100 | **400** | **upscaled source bits** |
| RENDERSURFACE | 12 | 100 | **400** | **upscaled textures — the 0x06 bulk** |
| SURFACE | 13 | 50 | 200 | |
| ENVIRONMENT | 16 | 3 | 15 | |
| SCENE | 27 | 25 | 100 | |

(Full 50-row table extractable with the same script; the rest are ≤15 and irrelevant.)

`RenderSurface::~RenderSurface` / `::Destroy` (acclient.c) `operator delete[]`s
`sourceData.sourceBits` and `m_pSurfaceBits` — destroying a freelisted RenderSurface returns
real process heap immediately (plus the D3D handle chain via `GraphicsResource::~`). With r9
textures at 1–4 MB of source bits each, 400 freelisted RenderSurfaces + 400 SurfaceTextures
is plausibly **0.5–1.5 GB of dead pinned memory at peak** — the right order of magnitude for
the entire family-B gap.

### 2.5 What the degrade system does NOT do

`DegradeInfo` (DB_TYPE_DEGRADEINFO) is a per-GfxObj LOD table (`get_degrade`,
`get_max_degrade_distance`) — `AutomaticDegrades`/`DegradeDistance` choose cheaper DRAW
geometry; they never evict cache residency. There is no memory-watermark path anywhere in
the client (no GlobalMemoryStatus caller feeding the caches). The governor genuinely fills
a gap rather than duplicating retail.

### 2.6 Threading — why the rendering callback is a safe call site

The cache pump chain is `CLCache::UseTime → ThreadedCache::UseTime → DBCache::UseTime`
(read in acclient.c), driven from `Client::UseTime` on the main thread — the SAME
Client::UseTime that issues StartFrame/Draw (independently proven by the
`usetime-disable-frame-draw` patch in /mnt/wbterminal2/ac-eor-patch/PATCHES.md, which NOPs
those draw calls inside it). Sim, render, and cache maintenance share one thread, so calling
the statics from AcmeLights' proven `SmartBox::m_renderingCallback` site
(Services/RenderCallback.cs — fires every in-world frame, post-3D pre-UI) races nothing.
The ThreadedCache worker thread only pushes completed async loads through a lock-free queue
consumed by that same main-thread pump; it never touches freelists directly.

## 3. Governor design (implementable spec)

New `AcmeLights/Services/MemoryGovernor.cs`, driven from `RenderingCallbackImpl` at 1 Hz
(same throttle pattern as LightsConfig.MaybeReload). Cfg via LightsConfig, all hot-reload.

### 3.1 Watermark measurement

In-process `GlobalMemoryStatusEx` P/Invoke — `ullTotalVirtual/ullAvailVirtual` are THIS
process's 32-bit VA space (4 GB with LAA): free-VA headroom is exactly the resource that
runs out in family B. Cheap (µs) at 1 Hz. Optional diagnostic: a VirtualQuery walk for
largest-free-block, logged only when below watermark (fragmentation telemetry, not a trigger).

### 3.2 Three tiers

**Tier 1 — budget rightsizing (at init + on cfg change; the always-on fix).**
For each fat cache, `GetDBOCache(dbtype)` (cdecl, VA 0x414590), NULL-check, then write
`m_freelistDef.nIdealSize` (@248) / `nMaxSize` (@252). Proposed defaults (cfg-overridable):

```
RENDERSURFACE  400→64    SURFACETEXTURE 400→64    GFXOBJ 200→80
SURFACE       200→64    LAND_BLOCK/LBI 144→48    CELL  144→48    SCENE 100→40
```

FreelistAdd's own overflow check then destroys the oldest on every subsequent free — the
caches converge to the new caps organically, on retail's own code path. No flush needed for
steady state. (Writes are plain int stores to a live struct read on the same thread — safe
from the callback.) Keep `nIdealSize ≤ nMaxSize` and never touch `m_bFreelistActive`.

**Tier 2 — watermark trim.** If `availVA < memlowmb` (default 768 MB):
`DBCache::FlushFreeObjects(0)` (stdcall, VA 0x4144E0) — empties every freelist NOW.
Hysteresis: after firing, re-arm only when `availVA > memhighmb` (default 1024) or after
`memtrimcooldown` (default 15 s). Log one line per fire with before/after availVA.

**Tier 3 — emergency.** If `availVA < memcritmb` (default 384 MB): also
`DBCache::UnloadCellData()` (VA 0x4143F0) and hold `DBCache::KeepFreeObjects(false, 0)`
(freelisting disabled = every future free is an immediate destroy) until availVA recovers
past memhighmb, then `KeepFreeObjects(true, 0)`. This mirrors retail's own shutdown call
exactly, just temporarily.

### 3.3 Telemetry (drives tuning, proves the mechanism)

1 Hz heartbeat line: `memgov avail=NNNNMB` + per-cache `type:nFree/nTotal` from
`GetDBOCache` reads (@264/@268) for the 8 governed types. This directly answers "which
cache holds the r9 bulk" with live numbers on the very first run.

### 3.4 Plugin plumbing (matches deployed patterns)

- Address resolution: `AddressResolver.Resolve(name, sigPattern, vaFallback)` — VAs above
  are map-derived for the shipped exe (same provenance as the proven 0x5107C0); sig
  patterns can be added later per the existing PLACEHOLDER convention.
- Native calls: `Marshal.GetDelegateForFunctionPointer` with
  `[UnmanagedFunctionPointer(CallingConvention.StdCall)]` for the two statics,
  `CallingConvention.Cdecl` for GetDBOCache — the NativeHooks.cs delegate zoo already
  does exactly this for thiscall/cdecl mixes.
- Cfg knobs: `memgov` (0/1, default **1**), `memlowmb`, `memhighmb`, `memcritmb`,
  `memtrimcooldown`, `memcaps=...` (per-type overrides), `memlog`.
- Escape hatch: `memgov=0` at boot → no budgets written, no natives ever called (the
  P3b glowoutdoor pattern); live 1→0 restores the original budgets (save them at first
  write) and stops the watermark checks.

### 3.5 Interaction with the exe patch lane (checked)

The palette patches (palette-leak ×2 + palette-double-free) altered CImagePaletteData
refcount sites and releasePalette's double-delete. The governor only accelerates the
`FreeObject → freelist → DestroyObj` path that retail's own 30 s UseTime purge and
`nMaxSize` overflow already exercise continuously on the patched exe — no new code path is
introduced, only frequency changes. The safe-palette third site is precisely what makes
frequent palette destruction safe. `dat-align-lfa` is orthogonal (parser math).

## 4. Expected reclaim (order-of-magnitude, to be measured via §3.3 telemetry)

- Texture pair (11+12) capped 400→64: worst-case dead-pin drops from ~800 objects × 1–4 MB
  ≈ 0.8–3 GB *potential* to ~128 × 1–4 MB ≈ 130–500 MB — several hundred MB of headroom in
  dense-town transitions even at conservative per-object sizes.
- GFXOBJ 200→80 + LAND_BLOCK/LBI/CELL 144→48: tens to ~150 MB with r9 meshes.
- Tier 2 flush at watermark: bounds the transient spike (the portal-in double-residency
  window) — this is the piece that directly prevents the 2.65 GB Yaraq signature.

## 5. Risks

1. **Reload thrash** (freelist is also a disk-load cache): mitigated by Tier 1 keeping
   64–80 entries (not zero), Tier 2 hysteresis, Tier 3 rarity. Watch for hitching on
   camera spins in town; if seen, raise texture caps to 96–128.
2. **Wrong build / miscall** = instant crash: VAs are map-derived with the same provenance
   as already-proven calls; guard every call behind `memgov` and a one-time
   `GetDBOCache(6) != NULL && [m_dbtype @120] == 6` sanity probe at init — if that probe
   fails, disable the governor and log loudly rather than call anything else.
3. **Struct-offset drift**: fieldlist 0x4e44 offsets are from the shipped PDB dump — same
   source ACBindings trusts; the @120 probe above also validates the layout at runtime.
4. NOT fixed by this: genuine in-use working set exceeding ~3.5 GB (all objects actually
   referenced). Telemetry will show it if so → escalate to prefs floor + content diet.

## 6. Fallbacks

- **Prefs floor** (zero-risk, already partially applied): `LandscapeTextureDetail=Medium`,
  draw distances down — shrinks the *in-use* set, complements the governor (which shrinks
  the *dead* set). Keep the 0823 mitigations in place.
- **Content diet on r9** (root lever, out of scope here): cap relief densification +
  audit 0x06 upscales; the governor makes the current r9 shippable, the diet makes it
  comfortable.
