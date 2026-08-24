# HANDOFF 2026-08-24 (2) — mirror-diet design: research synthesis, hitch telemetry, A/B gauntlet

Continues: `HANDOFF-2026-08-24-rgba-mirror-diet.md` (the lane charter). Research quartet
(committed together, cross-checked, key anchors re-verified by hand):
`RESEARCH-2026-08-24-rgba-split-dump.md` · `RESEARCH-2026-08-24-imgtex-upload-path.md` ·
`RESEARCH-2026-08-24-device-loss.md` · `RESEARCH-2026-08-24-palette-exemptions.md`.

## What the research settled (the lane charter's model was wrong in mechanism, right in effect)

1. **No D3DPOOL_MANAGED anywhere.** The client hand-rolls its own manager: per texture a
   pinned **`ImgTex::m_pSystemMemTexture`** (D3DPOOL_SYSTEMMEM, allocated by d3d9.dll
   inside NT heap segments) is the permanent CPU mirror; `m_pRenderTexture` is
   DEFAULT-pool, thrashable, refilled from the mirror via `UpdateTexture`
   (`GetD3DTexture` :365416). Retail already frees DAT source bits and scratch staging
   post-upload — the mirror is the only layer it never frees.
2. **The dump quantifies the prize at ~556 MiB, not ~1 GiB** (the 1,008 figure
   over-attributed mixed regions; page-truth says 568 MiB): **~250 MB TexMerge terrain
   merges + ~240 MB clothing/object RGBA (INDEX16-variant + r9-upscale explosion) +
   ~40 MB sky**. All single-level (flat w·h·4), all NT-heap-embedded (hence family B
   presenting as fragmentation), **76.8 MB byte-identical duplicates** (ten copies of one
   2 MB desert merge — per-cell re-merge, no dedup).
3. **Everything is regenerable**: DAT-id textures re-read via
   `LoadLevelResources`/`ConstructTexture`; merged terrain re-merges
   (`TexMerge::RestoreSurface` :306241, `CSurface::RestoreLostSurface` :358369); combined
   clothing re-Combines from the INDEX16 source (which is CPU-only, DAT-cached, cheap).
   `Render::FlushGraphicsResources` (:380760) is retail's flush-and-rebuild-everything
   button, usable without a device reset. Exemption list: PFIDs **41/101/243/244** only.
4. **Windowed device loss is rare** (no loss on alt-tab; resolution change goes through
   the same purge/restore proactively; TDR is the realistic trigger) and the
   detect→purge→reset→restore chain is complete and lazy-self-healing.

## ⚠ The one hard constraint the implementation must respect (read-verified by hand)

`ImgTex::GetD3DTexture` (:365416) treats a NULL/lost mirror as "tear down": it
**releases the healthy `m_pRenderTexture`, nulls both, and returns NULL** (LABEL_20
path). So naively nulling `m_pSystemMemTexture` after upload breaks every subsequent
draw of that texture. The mirror-free therefore needs a native fast-path patch:

> in GetD3DTexture head: `if (!m_bIsLost && m_pSystemMemTexture == NULL &&
> m_pRenderTexture != NULL && !m_pRenderTexture->m_bIsLost) return
> Get2DTextureD3D(m_pRenderTexture);`

making "no mirror + healthy DEFAULT copy" a first-class state. On device reset,
`PurgeResources` marks the ImgTex lost → the existing `m_bIsLost` head-check runs
`RestoreResource` → DAT re-read / re-merge / re-Combine (machinery the research verified).
The function is called per-texture-per-draw — the stub must be pure asm (FASM, the same
infra NativeHooks already uses), never a managed transition.

### Implementation sketch (next session)

- **Patch**: FASM detour at `ImgTex::GetD3DTexture` head (map RVA 0013E310 → VA
  **0x0053E310**; `ImgTex::CreateD3DTexture` = 0x0053EB10) adding the fast-path above,
  else jmp original.
  Register as a patch_client.py entry (like `dat-align-lfa`) OR install at runtime from
  AcmeLights (runtime preferred: escape knob, no exe churn).
- **Sweep service** (`MirrorDiet.cs`): 1 Hz from the rendering callback, walk
  `ImgTex::texture_table` + `custom_texture_table` (+ CSurface-held merged textures);
  for entries with a live `m_pRenderTexture`, not lost, format ∉ {41,101,243,244}, and
  class enabled: `m_pSystemMemTexture->Release()`, null the field. Class knobs:
  `dietterrain` (merged, DEFAULT-ON candidate after gauntlet), `dietclothing`,
  `dietworld` (staged rollout in that order). Piggyback `m_TimeUsed`/`m_FrameUsed` if a
  hot-only variant is wanted (probably unnecessary — the DEFAULT copy stays).
- **Reset safety**: nothing extra needed in theory (m_bIsLost head-check), but gate (c)
  of the charter (alt-tab / resolution change / UAC survival) must be exercised on the
  1070 before default-ON.
- Expected effect: committed-private −~500 MB in towns; crit-hold becomes rare;
  freelisting stays ON → the hitch tax measured below goes away structurally.

## Frame-time telemetry (SHIPPED, commit bec0e45f)

`FrameStats.cs`: 1 ms-bucket histogram on the rendering callback (no alloc, no syscall
on the frame path), 5 s line via AsyncLog: `frametime lb=0x.... n= avg= p99= max=
>33ms= >100ms= | cum ...`; ≥5 s intervals count as `gaps` (teleports), never frames.
`framelog` knob, default ON, independent of memgov so both A/B arms report.
MemoryGovernor's 5 s heartbeat also moved to AsyncLog (the sync ChoriziteLogger
open/append/close per line on the render thread was itself a hitch source).
Scorer: `score_frametime.py` (per-landblock aggregate) — copy in
`/mnt/wbterminal2/crashdump-12356/analysis-0824/`.

## 2026-08-24 gauntlet attempts (deployed AcmeLights.dll 109,568 B, `.bak-0824` kept)

- **Family B is now lethal on ~1.5 town-loops, not 14**: arm A attempt 1 died at the
  loop-1 Sawato teleport; attempt 2 completed loop 1 (7 towns) and died at the loop-2
  Cragstone teleport with priv=1939 MB at loop-2 Holtburg. Both sessions booted with
  lfree(low-2GB largest block) = **3 MB** and never left crit-hold — the governor's
  ceiling, not its failure; the diet is the structural fix. WER dumps captured
  (`C:\Temp\acdt\dumps\acclient.exe.12164.dmp` today; 12356 is Yaraq 08-23).
- **Arm A (memgov=1, crit-hold) loop-1 frame profile**: avg 19.4 ms, p99 ≈ 45 ms
  everywhere, 27.7 >33ms-hitches per kframe, 14 >100 ms hitches / 6,669 frames; worst
  town Zaikhal (77/kframe); teleport spikes to 766 ms. Calm block p99 = 20 ms — the gap
  between 45 and 20 is the crit-hold reload tax the owner feels as "1% lows need work".
- **Arm B (memgov=0)**: results appended below.
- Ops notes: 1070 staging = `D:\Temp` (owner). `cmd`'s `echo x=0>> file` eats the `0`
  (fd-redirect) — use PowerShell Add-Content for cfg appends. Char select =
  `acdtclick1` task (dblclick at `clickpos.txt`). Chorizite log rotates per session
  (`log.txt` → `log.prevclient.txt`).

## The A/B verdict (loop-1 per-town, `score_frametime.py` over the frametime lines)

| arm | survival | frames | avg | per-town p99 | >33ms/kframe | >100ms |
|---|---|---|---|---|---|---|
| A: memgov=1 (crit-hold whole run) | 7 towns + loop-2 Holtburg, died loop-2 Cragstone | 6,669 | 19.4 ms | **~45 ms every town** | **27.7** | 14 |
| B: memgov=0 (freelisting ON) | 4 towns, died loop-1 Shoushi | 4,715 | 18.9 ms | **20–36 ms** | **8.5** | 8 |

- **The handoff's hitch fear is CONFIRMED: crit-hold costs ~3.3× on >33 ms hitches and
  ~+20 ms of p99 in every town, while averages are identical (19 ms)** — a pure tail
  effect, i.e. precisely the owner's "fps avg fine; 1% lows need work".
- The governor buys survival with that tax (A: 8 towns; B: 4). The mirror diet retires
  the tradeoff: with ~500 MB of mirrors gone, neither crit-hold nor the crash cliff
  should engage at all.
- **Arm C (memcritfragmb=2, i.e. no crit-hold latch on the boot-state lfree=3MB):
  survived the FULL 14-stop tour, zero crashes** (priv peaked 1,934 MB loop-2 Holtburg;
  4 brief CRITICAL entries at the priv>1700 towns, recovered each time) — but its hitch
  profile is crit-hold-grade anyway: 6,400 frames, avg 20.9 ms, p99 ~45 ms, **31.7**
  >33ms/kframe. Cause: lfree=3MB sits permanently below memfragmb=16, so the tier-2 trim
  fires on every 15 s cooldown — a full freelist flush cycle is reload churn by another
  name.
- **Conclusion: no knob setting wins both survival and smoothness.** Best-survival knob
  until the diet ships = arm C's memcritfragmb=2 (kept OFF for now — owner cfg restored
  to memcritfragmb=5/memgov default-on after the runs; flip it if crashes bite before
  the diet lands). The structural fix is the mirror diet; expected to retire both the
  crash cliff and the ~45 ms p99 tax at once.
- One-run-per-arm caveat: single tour per arm, crashes truncate samples; directionally
  unambiguous (3.3×) but don't fine-tune knobs on these numbers.
- Boot-state mystery worth 10 minutes some session: all three arms booted with
  lfree(low-2GB)=3 MB — the Yaraq dump session started at 73 MB and DEGRADED. Something
  now eats low VA at boot (suspects: r10work dat pair, AcmeSky D3D11 assets, RTSSHooks
  52.6 MB). The diet shrinks the heap either way, but a 3 MB floor makes every
  frag-based trigger latch from frame one.
