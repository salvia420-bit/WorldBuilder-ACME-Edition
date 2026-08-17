# F1–F4 initial engineering research — 2026-08-17 (scoping only, nothing applied)

## F1 — degrade-chain audit: the "low sibling" theory was HALF right; the real story is client_highres.dat

**Audit run** (`tools/dat-patch/audit_degrade_chain.py`, results in scratchpad
`degrade-audit.json`): of the 2,227 r7-lane Surface ids, 2,226 resolve to a
SurfaceTexture. Chain-length histogram over their 2,191 unique SurfaceTextures:
**917 have 1 RenderSurface entry, 1,273 have 2**. Coverage against the union of
r7 baked/ dirs (2,192 RS):

| lane | ids | fully covered | partial (sibling not baked) |
|---|---|---|---|
| texture-remacri | 726 | 226 | **500** |
| dungeons | 473 | 118 | **355** |
| props | 434 | 253 | 180 |
| scenery | 340 | 211 | 128 |
| creatures | 195 | 144 | 51 |
| doors | 59 | 28 | 31 |

**But the unbaked siblings are NOT portal records.** Spot-checked with datlib
against the retail portal b-tree: in every 2-entry chain the entry we baked IS
the portal-resident record, and the other entry **does not exist in
client_portal.dat at all** (e.g. chain 0x0500278B = [0x06003E7D, 0x06003E7E]:
3E7E in portal at 256², 3E7D absent; same for 0x0600389F/38A0, 0x06004803/04).
They live in **client_highres.dat**: `CLCache::LoadHighResDat` (acclient.c:293658)
mounts `client_highres.dat` when present, gated by an options flag with an
"ID_Option_HighResChange" restart dialog (:215864). Entry[0] of each chain is
the highres id, entry[1] the standard portal id.

How the client consumes the chain (post-ToD RenderTexture path):
`RenderTexture::LoadLevelResources` (:136423) does a `DBObj::Get` on EVERY
entry; `RenderTexture::ConstructTexture` (:136496) then builds one D3D texture
whose level count = `m_SourceLevels.m_num`, entry[0] sized as the top level —
i.e. the chain is a mip/LOD *stack*, highres entry on top when resolvable.
`ImgTex::GetSubDataIDs` (:0053F3A0) gives entry[0] of multi-entry chains a
distinct QDID bucket (12 vs 8 — separate cache-pack/priority class).

**Consequence:** on a full EoR install with high-res textures enabled (the
common case), the client tops the stack with the **retail highres record** for
all 1,245 partially-covered surfaces — our 4× portal-record upscale sits BELOW
it in the stack or is ignored. Our gates likely passed because the isolated
kits/serving setups didn't mount client_highres.dat (wine box kit definitely
has no highres dat). The r7 package as-is under-delivers on stock installs.

**What the fix takes:** (1) obtain client_highres.dat (any EoR install /
emulator.ac download; we have none locally — ~/ac_base_dats lacks it); (2)
extend the lanes to bake the highres ids too — bonus: the highres record is the
BETTER upscale source (typically 2× the portal record → 4× from 512 instead of
256 = less hallucination, directly helps the Muggy squarish-artifact problem);
(3) import them into the portal (client resolves DIDs across mounted dats —
verify portal-vs-highres precedence for duplicate ids in `LookFile`/CLCache
before relying on portal-only shipping; shipping a patched client_highres.dat
is the fallback). Effort: one lane-scale rebake (~2.5 h bake + minutes import)
plus a day of source-plumbing and the precedence check. HIGH priority — this
gates how much of our work stock installs actually see.

**Open questions:** dat search order for ids present in both portal and
highres; whether the highres option is default-on in EoR; whether tex-reexport
(DATPATCH_TEX_BASE) needs regenerating from portal+highres union.

## F2 — DXVK on the wine box: two pieces missing, plan documented

Present already: wine 8.0 + wine32, 32-bit Vulkan loader (1.3.239) and mesa
Vulkan ICDs (lvp/radeon/intel), 64-bit NVIDIA 550.54.15 userland.
Missing: **32-bit NVIDIA GL/Vulkan libs** (no libGLX_nvidia i386 → DXVK would
fall back to llvmpipe software Vulkan) and the NVIDIA .run download never
completed (/tmp/nv550.run absent; /tmp/nv32.log has no DL_OK).

Install plan (~15 min, needs Xorg restart):
1. `curl -fSL https://us.download.nvidia.com/tesla/550.54.15/NVIDIA-Linux-x86_64-550.54.15.run -o /tmp/nv550.run`
2. stop Xorg :1 → `sudo sh /tmp/nv550.run --silent --no-kernel-modules --install-compat32-libs --no-x-check` → restart Xorg, re-verify `glxinfo` says Tesla T4 and a 32-bit `vulkaninfo` sees the NVIDIA ICD.
3. DXVK release tar (doitsujin/dxvk 2.x; archive precedent: bosh ran 1.9.3-async fine): copy `x32/d3d9.dll` into `~/ac_client/`, launch with `WINEDLLOVERRIDES="d3d9=n"`.
4. `dxvk.conf` next to the exe: `d3d9.samplerAnisotropy = 16` (+ optional LOD-bias experiments); verify with `DXVK_LOG_LEVEL=info` (log must name Tesla T4, not llvmpipe) and `DXVK_HUD=devinfo`.
5. A/B: same login, ffmpeg x11grab captures + frame timing vs WineD3D-GL.
Not smoke-tested (missing compat32 → would have tested llvmpipe, pointless).

## F3 — Pea's "4K Res Unlocked" byte patch: needles VERIFIED against our EoR exe

Full needle/replacement bytes recovered from Yonneh's patch table (utilitybelt,
20241012, msg 1294489188577841237). **Both needles match
`acclient.eor.orig.exe` uniquely at exactly the claimed offsets** 0x0006128D and
0x00063D94. Semantics from the byte diff:
- Patch 1 replaces option-read results with immediates:
  `mov dword [esp+2C], 0xF00` (3840) and `mov dword [esp+24], 0x870` (2160) —
  hardcodes 3840×2160 into the resolution plumbing (the 0x3C/0x3D/0x3E option
  reads it NOPs are the width/height/refresh fetches).
- Patch 2 flips three `je` (0x74) to `jmp` (0xEB) in the mode-list validation —
  accepts the resolution even when the adapter's D3D9 mode list doesn't
  enumerate it. This is precisely the clamp documented in
  1070-acclient-driving.md (non-enumerated modes silently fall back to 800×600
  — `Device::ForceDisplayResolution` neighborhood).
Registry fit: drops straight into patch_client.py's offset+needle+replace
format as two entries under one `4k-res` patch id. Caveats: resolution is
HARDCODED 4K (other targets = edit the two immediates); on the wine box the
virtual display is 2560×1600, so either raise the Xorg virtual size or patch
the immediates to 2560×1600. Effort to adopt: an hour incl. a smoke gate.
Not applied anywhere.

## F4 — retail Olthoi tunnel UV bugs: no specific dungeons named; signature documented

The only statement in the archive is gmriggs (worldbuilder, 20260212 22:48):
"there are texture uvs at the end of the tunnels in many of the olthoi dungeons
that are bugged in retail" — the surrounding thread (22:03–22:48) is about
EnvCell surface-slot indexing and names no environments. Same thread confirms
per-poly UVs are 0→1 stretch-to-fit ("any resolution texture you put into that
slot would get fit to that poly" — OptimShi/gmriggs), so replacement resolution
does not disturb UVs.

Gate-reviewer guidance: at Olthoi tunnel END-CAPS (the curved terminus pieces),
misaligned/rotated/stretched texture flow that (a) reproduces on a RETAIL
client with RETAIL dats and (b) follows polygon boundaries is retail-original —
do not attribute to our lanes. A/B check: same stop, stock exe + stock dats.
Automated detection was skipped (timebox): "bugged UV" here means visually
wrong mapping, not out-of-range values — not detectable without rendering.
If we later want it: r5 variant machinery can rewrite Environment UV indices,
so a fix lane is possible once specific envs are cataloged in-client.

## Files
- tools/dat-patch/audit_degrade_chain.py (new, reusable)
- scratchpad degrade-audit.json (full per-surface results, 30 examples)
- Nothing committed; nothing applied; take-4 tree untouched.
