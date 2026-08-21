#!/usr/bin/env python3
"""
patch_client.py — the ACME EOR acclient.exe byte-patch lane.

Reproducible, byte-signature-located patcher for the retail End-of-Retail
(2015-06-12) `acclient.exe`.  Doctrine (client-headroom-dossier.md, MEMORY §):
every patch is located by a UNIQUE byte-signature (needle + surrounding
context), NEVER by a quoted address, because acclient.c / acclient.map / the
shipped exe are three different builds whose offsets disagree.  A patch that
cannot find its unique signature, or finds it more than once, REFUSES to apply.

Commands:
  apply   orig -> patched   (applies the enabled patch set, fixes PE checksum)
  verify  <file>            report which patches are present / absent
  list                      print the patch registry

Design invariants:
  * Idempotent: applying to an already-patched buffer is a no-op per patch
    (it verifies the replacement is already in place).
  * Fail-loud: wrong signature count, wrong original bytes, or an unexpected
    input size aborts with a nonzero exit and touches nothing.
  * PE checksum is recomputed by default (the correct on-disk artifact);
    --no-checksum reproduces a legacy patched file that left it stale.

Provenance of the shipped patch set is in PATCHES below and in PATCHES.md.
"""

import argparse
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The pristine EOR client this lane targets.  Guarded so we never patch the
# wrong binary (a different build's offsets/signatures would silently differ).
EXPECT_SIZE = 4841472
EXPECT_MD5 = "116d9a66a70b6af449dc3a28d82f2f6d"  # ac_base_dats/acclient.exe, EOR 2015-06-12


class Patch:
    """A single byte-signature-located patch.

    `sig` is a unique context window (hex) present in the PRISTINE binary.
    `needle` (hex) is the sub-slice of `sig`, at byte offset `needle_at`,
    that gets rewritten to `replace` (hex, same length).  Locating on the
    wider `sig` — not the bare needle — is what makes the site unambiguous.
    """

    def __init__(self, key, title, sig, needle_at, needle, replace, why, source,
                 enabled=True):
        self.key = key
        self.title = title
        self.sig = bytes.fromhex(sig)
        self.needle_at = needle_at
        self.needle = bytes.fromhex(needle)
        self.replace = bytes.fromhex(replace)
        self.why = why
        self.source = source
        self.enabled = enabled          # in the default `apply` set? (candidates: False)
        assert self.sig[needle_at:needle_at + len(self.needle)] == self.needle, \
            f"{key}: needle not at needle_at inside sig"
        assert len(self.needle) == len(self.replace), f"{key}: length change not allowed"

    def find(self, buf):
        """Return the unique file offset of this patch's needle, or raise.

        Located by the INVARIANT context (prefix + suffix) around the needle,
        so the same site resolves whether the buffer is still orig or already
        patched.  The middle slice must read as either the needle or its
        replacement; anything else is not this site.
        """
        prefix = self.sig[:self.needle_at]
        suffix = self.sig[self.needle_at + len(self.needle):]
        n = len(self.needle)
        hits = []
        i = -1
        while True:
            i = buf.find(prefix, i + 1)
            if i < 0:
                break
            mid_off = i + len(prefix)
            mid = buf[mid_off:mid_off + n]
            if mid not in (self.needle, self.replace):
                continue
            if buf[mid_off + n:mid_off + n + len(suffix)] != suffix:
                continue
            hits.append(mid_off)
        if not hits:
            raise LookupError(f"{self.key}: signature not found (wrong build?)")
        if len(hits) > 1:
            raise LookupError(f"{self.key}: signature is NOT unique — refusing")
        return hits[0]

    def state(self, buf):
        """'orig' | 'patched' | 'unknown' at the located site."""
        off = self.find(buf)
        cur = buf[off:off + len(self.needle)]
        if cur == self.needle:
            return "orig", off
        if cur == self.replace:
            return "patched", off
        return "unknown", off


# --- The shipped patch set -------------------------------------------------
#
# Only patches that are community-proven AND validated in-client on real GPU
# hardware ship enabled.  trevis's DAT-decompression fix graduated 2026-08-16
# (1070 gate: compressed portal loaded, entered world, rendered decompressed
# textures — gate-shot13.png).  Pea's 4K-res unlock graduated 2026-08-18 by owner
# decision, in our CORRECTED variant (DECISIONS-2026-08-18 #2), and still owes the
# standard box gate before release inclusion.
# Shipped set as of 2026-08-18: palette-leak, palette-leak-2, dat-version-preserve,
# res-4k-unlock (corrected), res-4k-unlock-2.
# Candidates (enabled=False, `apply --only` reachable): mip-cap-16 (REJECTED),
# mip-min-flip + mip-min-floor (need far-pan motion QA), dat-decompress
# (superseded), highres-force-mount + highres-advertise-cap (a PAIR - ship both or
# neither; they need box gate arm D).
PATCHES = [
    Patch(
        key="palette-leak",
        title="notan's EOR palette-leak fix (2x 3-byte NOP)",
        # CImagePaletteData refcount bumps that leak; NOP the two `inc [reg+24h]`.
        sig="66feffff85c07403ff4024c3",  # ..; inc dword[eax+24h]; ret
        needle_at=8,
        needle="ff4024",
        replace="909090",
        why="Palette refcount leak; NOPping the two increments drops leak ~95%+.",
        source="github.com/eriknihlen/ac-eor-palette-leak-fix (file 0x0013EFFE)",
    ),
    Patch(
        key="palette-leak-2",
        title="notan's EOR palette-leak fix, site 2 (2x 3-byte NOP)",
        sig="85f6743cff46248b06538bce",  # ..; inc dword[esi+24h]; mov eax,[esi]..
        needle_at=4,
        needle="ff4624",
        replace="909090",
        why="Second leak site of the same fix (file 0x0013F19C). "
            "** SEE palette-double-free — MANDATORY COMPANION (2026-08-19). **",
        source="github.com/eriknihlen/ac-eor-palette-leak-fix (file 0x0013F19C)",
    ),
    Patch(
        key="palette-double-free",
        title="releasePalette: NOP the second deleting-destructor call "
              "(Mag-nus acclient-ai-re safe palette fix, site 3 of 3)",
        # ..call [eax+18] (first dtor, kept); mov edx,[esi]; push 1; mov ecx,esi;
        # call [edx+18] (the double free, NOPed); pop esi; ret; ..
        sig="066a018bceff50188b166a018bceff52185ec38b068bce5eff",
        needle_at=8,
        needle="8b166a018bceff5218",   # mov edx,[esi]; push 1; mov ecx,esi; call [edx+0x18]
        replace="909090909090909090",
        why="** THE MANDATORY THIRD SITE of the palette-leak fix — the 2-site "
            "community fix (palette-leak + palette-leak-2 alone) is UNSAFE. ** "
            "releasePalette calls the scalar deleting destructor TWICE where "
            "DBObj::Release calls it once; retail never reached it because "
            "makeModifiedPalette's over-reference kept refcounts >0 (the leak). "
            "Removing the two increments exposes the double free on appearance-"
            "reset / character-generation paths (= world entry, player model). "
            "CONVICTED IN-CLIENT 2026-08-19 (reports/f3-armd-gates-2026-08-19.md): "
            "every 2-site exe (ship + pre-res4k control) corrupted the heap at "
            "world entry with r7 (wild jumps at 0x3F80000x = 1.0f floats, player "
            "avatar stuck as pink per-joint particles) at BOTH 1920 and 2560; "
            "version-preserve-only arms were clean. NOPing the SECOND call (not "
            "the first) is right: the first runs with a live vptr; 9 NOPs are "
            "stack-neutral (the call's ret 4 pairs with the push 1). "
            "palette-leak/palette-leak-2 MUST NEVER ship without this entry.",
        source="github.com/Mag-nus/acclient-ai-re 2015-10 11.6096/docs/"
               "12-memory-leak-2015.md (safe patch: 15 bytes across 3 sites; "
               "exe sha256 bca95bbe… matches ours). File 0x0013ED75, VA "
               "0x0053ED75; sig verified unique 2026-08-19; in-client SAFEPAL "
               "gate pending.",
    ),
    Patch(
        key="allow-multiclient",
        title="Allow multiple acclient instances (Mag-ACClientPatcher), "
              "site 1: skip the already-running instance check",
        # ..mov eax,[esi]; add esp,4; mov ecx,esi; call [eax+80h]; test al,al; jnz +6C
        sig="008b0683c4048bceff908000000084c0756c",
        needle_at=8,
        needle="ff908000000084c0756c",
        replace="90909090909090909090",
        why="NOPs the instance-detection call + branch so a second acclient "
            "may start (fleet use: multi-account gate arms on one box; ACE "
            "allows concurrent accounts). CANDIDATE until box-gated with two "
            "simultaneous logins.",
        source="github.com/Mag-nus/Mag-ACClientPatcher ACClientExePatches.cs "
               "(build 6096, file 0x0121A2); bytes+sig verified unique "
               "2026-08-19.",
        enabled=False,
    ),
    Patch(
        key="allow-multiclient-2",
        title="Allow multiclient site 2: anonymize the global named object "
              "(push offset name -> push NULL)",
        sig="5e8be55dc20c005668305879006a016a006a008bf1",
        needle_at=8,
        needle="6830587900",           # push offset 0x795830 (the global name)
        replace="6a0090909090"[0:10],  # push 0; nop x3
        why="Companion site: the cross-process named object becomes anonymous "
            "so instance detection cannot rendezvous. Mag ships it as its own "
            "toggle ('without decal'); we gate the pair together. CANDIDATE.",
        source="github.com/Mag-nus/Mag-ACClientPatcher ACClientExePatches.cs "
               "(build 6096, file 0x0122A1); bytes+sig verified unique "
               "2026-08-19.",
        enabled=False,
    ),
    Patch(
        key="render-normal-bypass",
        title="Bypass RenderNormalMode (Mag): je->jmp, world never renders",
        sig="f0ffff8b465085c074078bcee859eeffff",
        needle_at=8,
        needle="74",
        replace="eb",
        why="Headless-bot arm tool: skips world rendering (big CPU cut, UI "
            "still runs). NOT for player kits. CANDIDATE for unattended "
            "protocol gates on the box.",
        source="github.com/Mag-nus/Mag-ACClientPatcher ACClientExePatches.cs "
               "(build 6096, file 0x054CDE); verified unique 2026-08-19.",
        enabled=False,
    ),
    Patch(
        key="usetime-disable-frame-draw",
        title="Client::UseTime: NOP StartFrame+Draw calls (Mag) — black "
              "screen, near-zero CPU/GPU after connect",
        sig="340400e895c60200e8a0c602008b8e20010000e8053604006a01e8bedc020083",
        needle_at=8,
        needle="e8a0c602008b8e20010000e805360400",
        replace="90909090909090909090909090909090",
        why="Strongest headless-bot arm: nothing renders after connect; "
            "input/net keep running. NOT for player kits. CANDIDATE.",
        source="github.com/Mag-nus/Mag-ACClientPatcher ACClientExePatches.cs "
               "(build 6096, file 0x011FFB); verified unique 2026-08-19.",
        enabled=False,
    ),
    # --- candidates: verifiable here, but NOT auto-applied (need in-client QA) ---
    Patch(
        key="mip-cap-16",
        title="ImgTex::CreateD3DTexture mip-count clamp 4 -> 16",
        # cmp edi,4; mov [esp+18h],edi; jbe +0xC; mov [esp+18h],4  <- bump the store imm
        sig="83ff04897c2418760cc744241804000000",
        needle_at=13,
        needle="04",
        replace="10",
        why="Retail clamps generated mip chains to 4 levels; a 1024/2048 texture "
            "stops at 256/512 -> distance shimmer. Raising the cap keeps the full "
            "chain. ** REJECTED 2026-08-16 far-pan QA **: A/B on the 1070 (NOMIP vs "
            "PHASE2 exe, only this byte differing, terrain-fixed r6 dats) -> with "
            "mip16 every large upscaled DXT world texture (dungeon walls/floors, "
            "town buildings, props) renders WHITE/untextured at ALL distances "
            "(detail-texture + vertex lighting only); characters/UI/terrain "
            "composite unaffected; no crash. Evidence mipqa/armA-nomip vs "
            "armB-mip16. DO NOT SHIP as a lone byte-flip; the texture-fill path "
            "needs its own RE before any retry.",
        source="client-headroom-dossier.md §8 (ImgTex::CreateD3DTexture); "
               "phase-2 PATCH-NOTES.md (file 0x0013FC2D)",
        enabled=False,
    ),
    Patch(
        key="mip-min-flip",
        title="mip chain: count levels from MIN(w,h), not MAX (ja -> jbe)",
        # cmp ebx,ebp; mov edi,1; mov [esp+18h],edi; mov eax,ebx; [ja +2]; mov eax,ebp
        sig="3bddbf01000000897c24188bc377028bc583f801761d",
        needle_at=13,
        needle="77",
        replace="76",
        why="Companion to mip-min-floor (apply BOTH). Retail counts the mip chain "
            "from max(w,h); for non-square DXT textures a full-ish chain drives the "
            "SMALLER dimension below 4px, which the D3DXFilterTexture DXT compressor "
            "rejects. Counting from min(w,h) makes floor-2 (see mip-min-floor) keep "
            "every level's min dimension >= 4.",
        source="mip-cap-16 far-pan QA RE 2026-08-16 (docs/dat-patch/"
               "mip-cap-16-farpan-QA-2026-08-16.md); EoR file 0x13FC0F, disasm-verified",
        enabled=False,
    ),
    Patch(
        key="mip-min-floor",
        title="mip chain: levels = max(count-2, 1) — stop at 4px (replaces the cap-4 clamp)",
        # cmp edi,4; mov [esp+18h],edi; jbe +C; mov [esp+18h],4; mov edi,[esp+18h]
        # -> sub edi,2; jg +5; mov edi,1; mov [esp+18h],edi; nop x7
        sig="83ff04897c2418760cc7442418040000008b7c2418",
        needle_at=0,
        needle="83ff04897c2418760cc7442418040000008b7c2418",
        replace="83ef027f05bf01000000897c241890909090909090",
        why="Companion to mip-min-flip (apply BOTH). Replaces retail's cap-4 mip "
            "clamp with 'full chain minus 2': the deepest chain whose smallest level "
            "still has min-dimension 4 - the exact constraint that made retail pick "
            "the constant 4 (32px textures force it; D3DXFilterTexture fails "
            "generating sub-4px DXT levels, which is why the naive mip-cap-16 raise "
            "whited out every big DXT texture). Reproduces retail behavior for 32px "
            "textures, gives 2048px textures a 10-level chain (smallest 4px). "
            "CANDIDATE: 1070 render QA PASSED 2026-08-16 (mipqa/armD-minmip: all "
            "textures intact, far floors cleaner, diffs in pose-drift range); "
            "still needs a far-pan MOTION QA (shimmer is temporal) before ship.",
        source="mip-cap-16 far-pan QA RE 2026-08-16; acclient.c 053EDB0 + 2013 bndb "
               "0053eec7 (levels = DXT ? clamped : 1); EoR file 0x13FC20, "
               "disasm-verified incl. edi liveness (mov edx,edi at +0x24)",
        enabled=False,
    ),
    Patch(
        key="dat-decompress",
        title="trevis's DAT zlib-decompression enable (SerializeFromCachePack version gate)",
        # add esp,4; cmp esi,edi; [je reject]; cmp eax,edi; je reject; push esi; mov [esp+10h],offset
        sig="83c4043bf774713bc7746d56c7442410",
        needle_at=5,            # 83[0]c4[1]04[2]3b[3]f7[4] -> 74[5]
        needle="7471",          # je 0x417B9B (reject when m_iVersion==0)
        replace="9090",         # nop nop -> version-0 (decompressed) packs proceed
        why="Compressed DAT records decompress OK but DiskController::Decompress zeroes "
            "Cache_Pack_t.m_iVersion; SerializeFromCachePack then rejects version-0 packs "
            "(GetCoreSDKPackVersionFromDBObjPackVersion is a const-2 stub, so only the "
            "m_iVersion!=0 test gates). NOP its je to accept decompressed records. "
            "~40-50% portal.dat saving. SHIPPED 2026-08-16: validated in-client on the "
            "1070 (compressed r6 portal loaded, entered world, rendered decompressed "
            "textures; on-disk bytes proven inflate-identical, realCorruption=0). "
            "paradox caveat stands for NON-texture records: version-0 unpack uses the "
            "default schema, so round-trip test before compressing anything but 0x06.",
        source="acclient.c:84396-84421 (gate) / 647393-647397 (zeroing); 2013 bndb "
               "0x41787c,0x41a2b0,0x670b36; EoR file 0x017B28 (VA 0x417B28); verified "
               "unique + disasm-confirmed 2026-08-16; in-client gate gate-shot13.png",
        # SUPERSEDED 2026-08-17 by dat-version-preserve (below). The bare guard-NOP
        # leaves Cache_Pack_t.m_iVersion==0, which crashes the EOR build IN-WORLD on
        # r7 (version-0 reaches version-gated schema parsing -> Archive::GetSizeLeft
        # unsigned underflow -> heap corruption ~30-45s in; box build tolerated it,
        # EOR did not). dat-version-preserve fixes the CAUSE and makes this NOP
        # redundant + removes paradox's version-0-schema caveat.
        enabled=False,
    ),
    Patch(
        key="dat-version-preserve",
        title="Preserve BTEntry version through DiskController::Decompress "
              "(trevis's version-preserve; the correct fix, replaces dat-decompress)",
        # LoadDataEx compressed-record success tail: two idempotent ReleaseMasterBuffer
        # calls on cpUncomp; the SECOND is dead. Reuse its 9 bytes to re-apply the real
        # version word (BTEntry+2) into buf_out->m_iVersion, which Decompress's
        # operator= copy-back had clobbered to 0.
        #   prefix e81853d9ff = first ReleaseMasterBuffer(&cpUncomp) call (kept)
        #   needle 8d4c2424e80f53d9ff = lea ecx,[esp+24]; call 406f90 (the dead dup)
        #   suffix 5f5e5d = pop edi; pop esi; pop ebp
        sig="e81853d9ff8d4c2424e80f53d9ff5f5e5d",
        needle_at=5,
        needle="8d4c2424e80f53d9ff",   # lea ecx,[esp+0x24]; call ReleaseMasterBuffer (dup)
        replace="0fb745028946049090",  # movzx eax,[ebp+2]; mov [esi+4],eax; nop; nop
        why="DiskController::Decompress zeroes Cache_Pack_t.m_iVersion on success "
            "(instead of copying the BTEntry version), so SerializeFromCachePack's "
            "m_iVersion!=0 gate rejects decompressed packs. Rather than NOP the gate "
            "(dat-decompress, which leaves version==0 and crashes the EOR build in-world "
            "on version-gated records), restore the real version in LoadDataEx AFTER the "
            "Decompress copy-back. esi=buf_out (m_iVersion@+4; proven at 0x671BC9), "
            "ebp=ent_out (BTEntry; version word at +2; proven at 0x671C35). Gate then "
            "passes legitimately; version-0-schema caveat gone. Community fix (trevis, "
            "utilitybelt 2024-11: 'manually set m_iVersion after LoadDataEx'). VALIDATED "
            "in-client 2026-08-17: EOR + this patch ONLY (no guard-NOP) + r7 booted "
            "compressed UI AND ran in-world crash-free, 4x textures (vm-vfix2-t240.png).",
        source="acclient.c DiskController::LoadDataEx 647426-647490 / Decompress "
               "647367-647408; EoR file 0x271C78 (VA 0x671C78), unique sig verified "
               "count=1; box-4837376 equivalent site 0x270CD8 (needle 8d4c2424e8af5fd9ff, "
               "distinct call rel32). Register liveness + disasm re-verified 2026-08-17; "
               "reports/eor-exe-divergence-2026-08-17.md.",
    ),
    # --- client_highres.dat force-mount (2026-08-18, plan 2.1 / DECISIONS-2026-08-18 #1)
    Patch(
        key="highres-force-mount",
        title="CLCache::OnServerInterrogation — mount client_highres.dat regardless "
              "of the server's DDD product bit 4",
        # CLCache::OnServerInterrogation(DDD_InterrogationMessage*) @EoR VA 0x4FAF80.
        # Retail gates the highres mount on the server-advertised product mask:
        #   mov  %edi,0x2f4(%esi)      ; m_EarlySaves.m_num = 0
        #   mov  %edi,0x2f8(%esi)      ; m_cbEarlySaves    = 0
        #   testb $0x4,0x10(%ebp)      ; pEvent->m_dwProductID & 4
        #   je   +5                    <-- the guard
        #   call CLCache::LoadHighResDat   (ecx still = this from `mov %ecx,%esi`)
        # NOP the je so the call is unconditional.  Vanilla ACE writes product 1u
        # (GameMessageDDDInterrogation), so without this the highres controller is
        # never initialised on an ACE shard.
        sig="89bef402000089bef8020000f6451004"   # prefix (invariant)
            "7405"                               # needle: je +5
            "e840feffff8b45088b16",              # suffix: call LoadHighResDat; mov 8(ebp),eax; mov (esi),edx
        needle_at=16,
        needle="7405",
        replace="9090",
        why="The HIFI split (r8) makes client_highres.dat LOAD-BEARING: the portal no "
            "longer carries a fallback copy of the superseded textures, so a client that "
            "fails to mount highres renders missing textures. Retail only mounts it when "
            "the server's DDD_InterrogationMessage advertises product bit 4; vanilla ACE "
            "sends 1u, so the mount never happens. NOPping the guard makes the mount "
            "unconditional and keeps ACE vanilla (the sanctioned mechanism per "
            "DECISIONS-2026-08-18 #1). "
            "** SAFE WHEN client_highres.dat IS ABSENT ** - proven by disassembly, not "
            "assumed: (1) CLCache::Init unconditionally allocates the slot-3 "
            "CThreadsafeDiskController (EoR 0x4FABC0 `mov %esi,0xc(%edx)`), so "
            "LoadHighResDat's `if (m_DatFiles.m_data[3])` outer guard (EoR 0x4FADF8-"
            "0x4FAE03) always passes and does NOT depend on the product bit; (2) the "
            "body is wrapped in `if (LookFile::LookForFile(...))` (EoR 0x4FAE70 call, "
            "`test %al,%al; je 0x4FAF44`), and the false arm skips the whole "
            "DiskConInitInfo construction + DiskController Init + "
            "m_DatFileByIDTable::add and falls straight into the LookFile destructor / "
            "return. With no client_highres.dat on disk the forced call is a no-op "
            "apart from one PString alloc/free - the graceful path is PRESERVED, not "
            "bypassed. "
            "NOTE the file must also be a genuine highres dat: the client Inits slot 3 "
            "with dataSet=PORTAL_DATFILE(1) / subSet=0x69466948 ('HiFi'), which the "
            "retail eor2013 file carries at header+0x14C/0x150 (verified 2026-08-18); a "
            "custom highres must reproduce both or the DiskController Init fails and the "
            "mount is silently skipped. "
            "** BLOCKER FOUND 2026-08-18 - THE PATCH ALONE IS NOT SHIPPABLE AGAINST "
            "VANILLA ACE. ** A mounted highres controller joins the DDD interrogation "
            "response like any other dat (acclient.c:293815-293823; the only membership "
            "test is IsInitialized()), tagged with GetDatFileID() = "
            "(data_set<<32)|data_subset. client_highres.dat carries dataSet=1="
            "PORTAL_DATFILE in its header, so its wire DatFileId is 1 - the SAME tag as "
            "client_portal.dat. Vanilla ACE switches on exactly that field "
            "(DDDHandler.cs:45 `case 1: // PORTAL`), so the highres entry overwrites "
            "clientPortalDatIntSet and its iteration COUNT (retail highres = 497) is "
            "compared against the server's portal iteration (live: 2073) -> "
            "clientIsMissingIterations -> with EnableDATPatching=false (the default) -> "
            "session.Terminate(DATsPatchingDisabled) at DDDHandler.cs:165-168, ungated by "
            "show_dat_warning. The client is booted at CHARACTER SELECT. This breaks with "
            "the RETAIL highres too, not just a custom one. Mitigation options (none "
            "built) are in PATCHES.md 'DDD iteration semantics'. "
            "SHIPPED 2026-08-19 after the 1070 FMCAP gate PASS (native EOR SAFEPAL+FMCAP arm, "
            "r7.2 portal + WBT-DXT r8 highres vs live vanilla ACE): client_highres.dat held "
            "EXCLUSIVELY LOCKED login through tour end, ACE DDD log shows EXACTLY 3 dats / "
            "no update required / session held, world entry vm 476MB->1.67GB, 7-stop tour "
            "clean, FAULTS=0 - reports/fmcap-1070-gate-2026-08-19.md. The chosen mitigation "
            "IS highres-advertise-cap (Option B) - MANDATORY PAIR. "
            "(pre-gate note: flips to True only after the box verification "
            "passes AND a mitigation is chosen and gated - see PATCHES.md "
            "'Box verification procedure'.",
        source="acclient.c CLCache::OnServerInterrogation 293785-293793 (the "
               "`if (v2->m_dwProductID & 4) CLCache::LoadHighResDat(this);` guard) / "
               "CLCache::LoadHighResDat 293658-293751 (LookForFile-gated body, "
               "0x69466948 at 293710); decomp+map VAs 0x4FA3E0 / 0x4FA250 = box build "
               "RVA 0xF93E0 / 0xF9250 (yonneh-acclient.map, VA=RVA+0x401000). "
               "EoR file 0x0FAFA9 (VA 0x4FAFA9) = OnServerInterrogation+0x29 "
               "(fn @0x4FAF80, LoadHighResDat @0x4FADF0); sig verified UNIQUE (count=1) "
               "in acclient.eor.orig.exe 2026-08-18 and disasm-confirmed with objdump. "
               "Box-4837376 equivalent site 0x0FA409 - this sig RELOCATES there "
               "unchanged (prefix/needle/suffix byte-identical, count=1), because the "
               "LoadHighResDat call rel32 happens to be e840feffff in both builds.",
        enabled=True,
    ),
    Patch(
        key="highres-advertise-cap",
        title="CLCache::OnServerInterrogation — cap the advertised dat list at slots 0-2 "
              "(don't report client_highres.dat to a server that never asked for it)",
        # Companion to highres-force-mount, REQUIRED to ship with it against vanilla ACE.
        # OnServerInterrogation walks m_DatFiles and adds an iteration list per
        # IsInitialized() controller.  A forced highres mount therefore advertises a 4th
        # entry tagged DatFileId = data_set = 1 = PORTAL_DATFILE (the same tag as
        # client_portal.dat), which vanilla ACE folds into its `case 1: // PORTAL` arm and
        # compares against the server's portal iteration -> boot at character select.
        # Capping the loop bound at 3 leaves slots 0/1/2 (portal, local, cell) advertised
        # exactly as retail and silently omits slot 3 (highres) -- while the mount, the
        # m_DatFileByIDTable registration and highres read-precedence all stay intact.
        #
        #   4fb04b: 84 c0              test %al,%al
        #   4fb04d: 75 02              jne  +2
        #   4fb04f: 32 db              xor  %bl,%bl
        #   4fb051: 8b 86 e8 01 00 00  mov  0x1e8(%esi),%eax   <- m_DatFiles.m_num  (NEEDLE)
        #   4fb057: 47                 inc  %edi
        #   4fb058: 3b f8              cmp  %eax,%edi
        #   4fb05a: 72 b5              jb   loop_body
        #
        # -> b8 03 00 00 00 90 = `mov $0x3,%eax; nop` (length-preserving, flag-neutral;
        #    `mov` and `b8` both leave EFLAGS alone, and eax is dead after the cmp).
        sig="84c0750232db"          # prefix: test al,al; jne +2; xor bl,bl
            "8b86e8010000"          # needle: mov eax,[esi+0x1e8]   (the LOOP BOUND read)
            "473bf872b5",           # suffix: inc edi; cmp edi,eax; jb loop_body
        needle_at=6,
        needle="8b86e8010000",
        replace="b80300000090",
        why="REQUIRED COMPANION TO highres-force-mount - do not ship force-mount without "
            "it on a vanilla-ACE shard. Forcing the highres mount makes the client "
            "advertise a 4th dat in its DDD_InterrogationResponse "
            "(acclient.c:293812-293824; the only membership test is IsInitialized()), "
            "tagged GetDatFileID() = (data_set<<32)|data_subset. client_highres.dat "
            "carries dataSet=1=PORTAL_DATFILE in its header, so its wire DatFileId is 1 - "
            "identical to client_portal.dat - and vanilla ACE's "
            "DDDHandler.DDD_InterrogationResponse switches on exactly that field "
            "(DDDHandler.cs:45 `case 1: // PORTAL`), overwrites clientPortalDatIntSet with "
            "the highres set and compares its iteration COUNT (retail highres = 497) "
            "against DatManager.PortalDat.Iteration (live server 2073) -> "
            "clientIsMissingIterations -> with EnableDATPatching=false (the default) -> "
            "session.Terminate(DATsPatchingDisabled) at DDDHandler.cs:165-168, ungated by "
            "show_dat_warning, at CHARACTER SELECT. Capping the advertised list at 3 "
            "removes the collision at the source and is also the semantically honest "
            "behaviour: a server that never set product bit 4 has no business being told "
            "about the highres dat. Works for the retail highres AND for any "
            "custom-iteration highres, and keeps our dat byte-shaped like retail's. "
            "** ONE SITE, DELIBERATELY, NOT TWO. ** OnServerInterrogation reads m_num "
            "twice: the entry guard (EoR 0x0FAFDB `mov eax,[esi+0x1e8]` / `test eax,eax` "
            "at 0x4FAFE1, consumed by the `jbe` at 0x4FB00F) and this loop bound "
            "(0x0FB051, re-read every iteration). Only the LOOP BOUND is patched. "
            "m_DatFiles.m_num is provably 0 or 4 and nothing else: CLCache::Init loads "
            "edi=4 (EoR 0x4FA8F9 `mov $0x4,%edi`), calls SmartArray::grow(&m_DatFiles,4) "
            "(0x4FA905) and stores `m_num = edi` (0x4FA931 `mov %edi,0x8(%esi)`, esi = "
            "this+0x1E0 = &m_DatFiles) ONLY on the success path - on grow failure the "
            "`je 0x4FA934` at 0x4FA90C skips the store and m_num keeps its constructed 0 "
            "(acclient.c:296171-296173). Leaving the ENTRY GUARD on the real m_num is what "
            "makes the cap safe in the m_num==0 state: the guard still skips the loop "
            "entirely. Patching the guard too would force `test 3,3` -> jbe not taken -> "
            "the do-while would run over a NULL m_data, i.e. it would INVENT a crash retail "
            "does not have. With m_num==4 both variants behave identically, so the "
            "one-site form is strictly safer at zero functional cost. "
            "SHIPPED 2026-08-19 with highres-force-mount after the 1070 FMCAP gate PASS "
            "(exactly 3 dats in ACE DDD interrogation log, no termination) - "
            "reports/fmcap-1070-gate-2026-08-19.md. MANDATORY PAIR. "
            "(pre-gate note: ships together with highres-force-mount, and only "
            "after box gate arm D - see PATCHES.md 'Box verification procedure'.",
        source="Owner decision 2026-08-18, DECISIONS-2026-08-18.md item 4 (Option B). "
               "acclient.c CLCache::OnServerInterrogation 293812-293824 (the advertise "
               "loop) / DiskConBase::GetDatFileID 291609-291614 / "
               "CAllIterationList::PTaggedIterationList::Serialize 654463-654464 "
               "(low dword = data_subset first); ACE (running tree "
               "/home/wbterminal/ace-server/Source, DDD code is NOT in external/ACE - "
               "partial checkout): DDDHandler.cs:45-61 + 165-168, "
               "PTaggedIterationList.cs:29-31, DatDatabaseType.cs:5, "
               "DDDConfiguration.cs:11. EoR file 0x0FB051 (VA 0x4FB051) = "
               "OnServerInterrogation+0xD1 (fn @0x4FAF80); sig verified UNIQUE (count=1) "
               "2026-08-18 (bare needle occurs 12x, prefix 46x - the context window is "
               "what makes it unambiguous) and disasm-confirmed with objdump. "
               "Box-4837376 equivalent site 0x0FA4B1 - this sig RELOCATES there unchanged "
               "(prefix/needle/suffix byte-identical incl. the `jb` rel8, count=1), and "
               "also resolves on the box-decompress/box-MINMIP test lineage.",
        enabled=True,
    ),
    # --- Pea's "4K Res Unlocked" (community patch, imported 2026-08-17, F3) -------
    # Provenance: Pea (author) -> Mag-nus/Mag-ACClientPatcher (distribution, "apply"
    # button) -> Yonneh's UtilityBelt C# patch table, posted verbatim in Discord
    # #utilitybelt msg 1294489188577841237, 2024-10-12 02:37:53 UTC (thread starts at
    # trevis msg 1294489064724238377 "i'm curious what the 4k patch looks like";
    # Yonneh msg 1294488898680127602 "hard patches for dual log, open shared, 4k res,
    # and 10-year logout timer").  The table's quoted file offsets 0x0006128D and
    # 0x00063D94 land EXACTLY on our pristine EOR acclient.exe -> Pea targeted the
    # EOR build; the needles are reproduced byte-for-byte below.
    # ** OWNER SIGN-OFF 2026-08-18 (DECISIONS-2026-08-18.md #2): ENABLE, in the
    #    CORRECTED variant - our one-byte fix for the esp re-base miss in Pea's site-1
    #    replacement.  Both entries are now enabled=True.  res-4k-unlock therefore no
    #    longer reproduces Mag's patcher output byte-for-byte (one byte differs); that
    #    is deliberate.  See PATCHES.md for the defect analysis. **
    Patch(
        key="res-4k-unlock",
        title="Pea 4K-res unlock 1/2 (ACME-CORRECTED): UIElement::MouseResizeElement — "
              "drop the MaxWidth/MaxHeight clamps on mouse drag-resize",
        # UIElement::MouseResizeElement (EoR VA 0x461210) queries four layout attrs via
        # UIElement::GetAttribute_Int(key, &out) -> bool (EoR VA 0x460B30):
        #   0x3C = MaxHeight, 0x3D = MaxWidth, 0x3E = MinHeight, 0x3F = MinWidth
        # (names proven from acclient.c UIElement::ResizeTo, decomp line 160202+).
        # Pea replaces the 0x3D and 0x3C queries with a literal store of the value
        # (3840 / 2160) AND clears their "attribute present" bools, so the two max
        # clamps in the border switch never fire.
        #   prefix 8bcb8944241c03f7e8a3f8ffff = mov ecx,ebx; mov [esp+1c],eax;
        #                                       add esi,edi; call GetAttribute_Int(0x3F)
        #   suffix 0f87b3020000               = ja default (border switch)
        sig="8bcb8944241c03f7e8a3f8ffff"
            "8d54242c526a3d8bcb88442440e891f8ffff884424118d442420506a3e8bcbe87ff8ffff"
            "8d4c2424516a3c8bcb8844243ce86df8ffff8b8b800400004983f9078ad088542412"
            "0f87b3020000",
        needle_at=13,
        needle="8d54242c526a3d8bcb88442440e891f8ffff884424118d442420506a3e8bcbe87ff8ffff"
               "8d4c2424516a3c8bcb8844243ce86df8ffff8b8b800400004983f9078ad088542412",
        # ** ACME-CORRECTED **: byte 48 of `replace` is 0x34, not Pea's 0x3c
        # (`mov %al,0x34(%esp)` instead of `mov %al,0x3c(%esp)`).  See `why`.
        replace="c744242c000f00009088442438c644241100909090908d442420506a3e8bcbe87ff8ffff"
                "c74424247008000090884424" "34" "c6442412008b8b800400004933c033d283f9079090",
        why="Retail clamps a UI element being drag-resized by its border to the layout's "
            "MaxWidth (attr 0x3D) / MaxHeight (attr 0x3C). Pea's patch writes max_width="
            "3840 (0x0F00) and max_height=2160 (0x0870) straight into the locals and sets "
            "has_max_width/has_max_height = 0, so the `if (has_max && ...)` clamp arms are "
            "dead (the literal 3840/2160 are then unread — self-documenting only). Min "
            "clamps (0x3E/0x3F) are left intact here. "
            "** DEFECT IN PEA'S BYTES (found 2026-08-17, re-verified by disassembly "
            "2026-08-18; NOT in any community write-up) — FIXED HERE. ** "
            "MouseResizeElement is `sub esp,0x20` + push ebx/ebp/esi/edi (0x461210, "
            "0x461213, 0x461248, 0x46124F, 0x461266) and returns `ret 8` (0x461659), so "
            "body_esp = entry_esp-0x30. GetAttribute_Int is also `ret 8` (callee-cleans), "
            "so the only transient esp delta is each call's own 2 pushes. Pea deletes "
            "both the 0x3D and the 0x3C push pairs, which moves the two `al` spills from "
            "esp=body-8 to esp=body. He re-based the first correctly "
            "(0x461296 `mov %al,0x40(%esp)` -> `mov %al,0x38(%esp)`; both resolve to "
            "body+0x38 = entry+0x08 = has_min_width, read at 0x4612E8 `mov 0x38(%esp),%al`) "
            "but left the second unchanged: 0x4612BA `mov %al,0x3c(%esp)`, which at "
            "esp=body resolves to body+0x3C = entry+0x0C instead of the intended "
            "body+0x34 = entry+0x04. Two consequences, both disasm-confirmed: "
            "(1) entry+0x0C is the CALLER's saved-ESI slot — UIElement::MouseMove "
            "(0x4633F0) does `sub esp,0x28; push ebx; push ebp; push esi` (0x4633FD), then "
            "`push ebp; push ebx; call MouseResizeElement` (0x463410-0x463414); the "
            "callee's `ret 8` lands esp exactly on that saved esi, which MouseMove pops at "
            "0x4634AC. So a 0/1 byte is scribbled into MouseMove's saved esi on every "
            "border drag. (2) The real has_min_height bool at body+0x34 (read at 0x461320 "
            "`mov 0x34(%esp),%al`) is never written; body+0x34 = entry+0x04 is the first "
            "stack argument slot, so the min-height clamp fires on the low byte of a mouse "
            "coordinate. "
            "** CORRECTION APPLIED (owner-approved, DECISIONS-2026-08-18 #2): replace[48] "
            "0x3c -> 0x34, i.e. `mov %al,0x34(%esp)`, which fixes both at once and matches "
            "the reader at 0x461320 exactly. This entry therefore ships the ACME-CORRECTED "
            "variant, NOT Mag's/Pea's verbatim bytes — one byte differs. **",
        source="Pea via Mag-nus/Mag-ACClientPatcher; bytes from Yonneh's UtilityBelt C# "
               "patch table, Discord #utilitybelt msg 1294489188577841237 (2024-10-12). "
               "EoR file 0x0006128D (VA 0x46128D) = UIElement::MouseResizeElement+0x7D "
               "(fn @0x461210); sig verified UNIQUE (count=1) in acclient.eor.orig.exe "
               "2026-08-17. Box-4837376 equivalent site 0x000611AD — this sig RELOCATES "
               "there unchanged (prefix/needle/suffix byte-identical, count=1). Semantics "
               "from acclient.c UIElement::MouseResizeElement (line 157857) + "
               "UIElement::ResizeTo (160202); symbol names via yonneh-acclient.map "
               "(= box build, RVA+0x401000): RVA 0x60130 UIElement::MouseResizeElement. "
               "CORRECTED VARIANT enabled 2026-08-18 per DECISIONS-2026-08-18 #2; defect "
               "+ fix re-verified by objdump on acclient.eor.orig.exe and on "
               "scratch-f3/acclient.eor.RES4K-TEST.exe (Pea-verbatim build) the same day.",
        enabled=True,
    ),
    Patch(
        key="res-4k-unlock-2",
        title="Pea 4K-res unlock 2/2: UIElement::ResizeTo — jmp over all four "
              "Min/Max Width/Height clamps",
        # UIElement::ResizeTo(int w, int h) @EoR VA 0x463D60. Four identical blocks:
        #   call GetAttribute_Int(key, &out); test al,al; je skip; <clamp>; skip:
        # for key 0x3C (MaxHeight), 0x3E (MinHeight), 0x3D (MaxWidth), 0x3F (MinWidth).
        # Pea flips each `je` (74) to `jmp` (EB) -> every clamp block is skipped
        # unconditionally and the requested size passes through verbatim.
        #   prefix 8bcee89ecdffff84c0 = mov ecx,esi; call GetAttribute_Int(0x3C);
        #                               test al,al   (the 0x3C call is NOT modified)
        #   suffix 0a8b4424183bd87d028bd8 = tail of the 4th block + its clamp body
        sig="8bcee89ecdffff84c0"
            "740a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0"
            "740a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0"
            "740c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0"
            "74"
            "0a8b4424183bd87d028bd8",
        needle_at=9,
        needle="740a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0"
               "740a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0"
               "740c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0"
               "74",
        replace="eb0a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0"
                "eb0a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0"
                "eb0c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0"
                "eb",
        why="This is the load-bearing half: UIElement::ResizeTo is the programmatic resize "
            "path every element goes through when the window/screen size changes, and "
            "retail clamps the requested size to the layout DAT's MaxHeight(0x3C)/"
            "MinHeight(0x3E)/MaxWidth(0x3D)/MinWidth(0x3F) attributes. Above the era's "
            "supported resolutions the max clamps pin elements (notably the 3D-view "
            "region) below the backbuffer, which is what 'unlocking 4K' actually means. "
            "4x `74`->`eb` makes every clamp block unconditionally skipped. NOTE this "
            "also kills the two MIN clamps, so any element whose layout declares a "
            "minimum can now be sized below it (undersize / zero-size risk on small "
            "windows) — a strictly larger behaviour change than the title implies. Only "
            "4 bytes change; instruction boundaries and stack accounting are untouched "
            "(unlike site 1). Yonneh's own field report 2024-12-16 (#general "
            "1318315149458669681): 'the 4k resolution is kinda poop — the 3d area won't "
            "resize to fill it', so this does NOT by itself make the 3D viewport fill a "
            "4K screen; treat 'unlocked' as 'no longer clamped', not 'correct layout'.",
        source="Pea via Mag-nus/Mag-ACClientPatcher; bytes from Yonneh's UtilityBelt C# "
               "patch table, Discord #utilitybelt msg 1294489188577841237 (2024-10-12). "
               "EoR file 0x00063D94 (VA 0x463D94) = UIElement::ResizeTo+0x34 "
               "(fn @0x463D60); sig verified UNIQUE (count=1) in acclient.eor.orig.exe "
               "2026-08-17. Box-4837376 equivalent site 0x00063C64 (= ResizeTo+0x34, "
               "map RVA 0x62C30) — this sig does NOT relocate there: the box build's "
               "three GetAttribute_Int call rel32s differ by 0x50 (e8d2cdffff / "
               "e8b6cdffff / e898cdffff vs EoR e882/e866/e848) and the prefix call is "
               "e8eecdffff. Box needle is unique (count=1) but must be a separate entry "
               "if the box build is ever targeted. Semantics from acclient.c "
               "UIElement::ResizeTo (line 160202), which names the four attribute keys. "
               "Enabled 2026-08-18 per DECISIONS-2026-08-18 #2 (unmodified — this half "
               "has no defect; only 4 `74`->`eb` bytes, no stack accounting involved).",
        enabled=True,
    ),
]


# --- PE checksum ------------------------------------------------------------

def _pe_checksum_field_offset(buf):
    e_lfanew = struct.unpack_from("<I", buf, 0x3C)[0]
    if buf[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise ValueError("not a PE file")
    opt = e_lfanew + 4 + 20            # after COFF header
    return opt + 64                    # CheckSum field in the optional header


def compute_pe_checksum(buf):
    """Standard Microsoft PE image checksum (sum-of-words + file length)."""
    csum_off = _pe_checksum_field_offset(buf)
    total = 0
    limit = len(buf)
    i = 0
    while i + 1 < limit:
        if i == csum_off:            # the 4 checksum bytes are read as zero
            i += 4
            continue
        w = buf[i] | (buf[i + 1] << 8)
        total += w
        total = (total & 0xFFFF) + (total >> 16)
        i += 2
    if i < limit:                    # trailing odd byte
        total += buf[i]
        total = (total & 0xFFFF) + (total >> 16)
    total = (total & 0xFFFF) + (total >> 16)
    return (total + limit) & 0xFFFFFFFF


def set_pe_checksum(buf):
    off = _pe_checksum_field_offset(buf)
    struct.pack_into("<I", buf, off, 0)
    val = compute_pe_checksum(buf)
    struct.pack_into("<I", buf, off, val)
    return val


def read_pe_checksum(buf):
    return struct.unpack_from("<I", buf, _pe_checksum_field_offset(buf))[0]


# --- commands ---------------------------------------------------------------

def _md5(buf):
    import hashlib
    return hashlib.md5(buf).hexdigest()


def cmd_apply(args):
    src = Path(args.input)
    dst = Path(args.output)
    buf = bytearray(src.read_bytes())

    if len(buf) != EXPECT_SIZE and not args.force:
        sys.exit(f"ERROR: {src} is {len(buf)} bytes, expected {EXPECT_SIZE} "
                 f"(is this the EOR acclient.exe? pass --force for a known "
                 f"other build - signatures still locate per-build)")
    src_md5 = _md5(buf)
    if src_md5 != EXPECT_MD5 and not args.force:
        sys.exit(f"ERROR: {src} md5 {src_md5} != pristine {EXPECT_MD5}. "
                 f"Refusing (pass --force to patch a non-pristine input).")

    if args.only:                       # explicit set — may include candidates
        want = set(args.only.split(","))
        keys = {p.key for p in PATCHES}
        unknown = want - keys
        if unknown:
            sys.exit(f"ERROR: unknown patch key(s): {','.join(sorted(unknown))}")
        enabled = want
    else:                               # default: only the shipped (enabled) set
        enabled = {p.key for p in PATCHES if p.enabled}

    applied, already = [], []
    for p in PATCHES:
        if p.key not in enabled:
            continue
        st, off = p.state(buf)
        if st == "orig":
            buf[off:off + len(p.needle)] = p.replace
            applied.append((p, off))
        elif st == "patched":
            already.append((p, off))
        else:
            sys.exit(f"ERROR: {p.key} at 0x{off:X} has unexpected bytes "
                     f"{bytes(buf[off:off+len(p.needle)]).hex()} — refusing.")

    if args.no_checksum:
        chk_note = f"left stale (0x{read_pe_checksum(buf):08X})"
    else:
        val = set_pe_checksum(buf)
        chk_note = f"recomputed 0x{val:08X}"

    dst.write_bytes(buf)
    print(f"input   {src}  (md5 {src_md5})")
    print(f"output  {dst}  (md5 {_md5(buf)})")
    print(f"PE checksum: {chk_note}")
    for p, off in applied:
        print(f"  applied  {p.key:16s} @ 0x{off:06X}  "
              f"{p.needle.hex()} -> {p.replace.hex()}")
    for p, off in already:
        print(f"  present  {p.key:16s} @ 0x{off:06X}  (already patched)")
    if not applied and not already:
        print("  (no patches enabled?)")
    print(f"total code bytes changed: {sum(len(p.needle) for p,_ in applied)}")


def cmd_verify(args):
    buf = bytearray(Path(args.file).read_bytes())
    print(f"file    {args.file}")
    print(f"size    {len(buf)}  md5 {_md5(buf)}")
    stored = read_pe_checksum(buf)
    correct = compute_pe_checksum(buf)
    tag = "OK" if stored == correct else "STALE"
    print(f"PE checksum stored 0x{stored:08X}  correct 0x{correct:08X}  [{tag}]")
    bad = False
    for p in PATCHES:
        try:
            st, off = p.state(buf)
        except LookupError as e:
            print(f"  {p.key:16s} : SIGNATURE ERROR — {e}")
            bad = True
            continue
        print(f"  {p.key:16s} @ 0x{off:06X} : {st}")
        if st == "unknown":
            bad = True
    sys.exit(1 if bad else 0)


def cmd_list(args):
    for p in PATCHES:
        tag = "shipped" if p.enabled else "candidate (not auto-applied)"
        print(f"[{p.key}] {p.title}   <{tag}>")
        print(f"    sig     {p.sig.hex()}  (needle @ +{p.needle_at})")
        print(f"    change  {p.needle.hex()} -> {p.replace.hex()}")
        print(f"    why     {p.why}")
        print(f"    source  {p.source}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("apply", help="patch orig -> patched")
    a.add_argument("-i", "--input", default=str(HERE / "acclient.eor.orig.exe"))
    a.add_argument("-o", "--output", default=str(HERE / "acclient.eor.patched.exe"))
    a.add_argument("--only", help="comma-separated patch keys to apply")
    a.add_argument("--no-checksum", action="store_true",
                   help="leave the PE checksum stale (legacy byte-exact output)")
    a.add_argument("--force", action="store_true",
                   help="patch even if input md5 != pristine")
    a.set_defaults(func=cmd_apply)

    v = sub.add_parser("verify", help="report patch state of a file")
    v.add_argument("file", nargs="?", default=str(HERE / "acclient.eor.patched.exe"))
    v.set_defaults(func=cmd_verify)

    l = sub.add_parser("list", help="print the patch registry")
    l.set_defaults(func=cmd_list)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
