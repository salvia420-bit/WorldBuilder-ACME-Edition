# ACME r10 — announcement DRAFT (owner review before anything is posted)

Supersedes ANNOUNCE-r8-DRAFT.md (never posted; its sizes and its "no client
executable redistributed" phrasing no longer describe the archive). Sizes/hashes
marked ⟨…⟩ are filled by `assemble_kit.sh` at packaging — do not hand-edit them.
Nothing has been posted anywhere.

Norms this draft follows (community-norms.md): patch-over-your-own-install, no
retail files redistributed, back-up-first as the first instruction, package +
sha256 + rollback stated up front. The plugin pack paragraph states the
injection model and the bundled third-party runtime plainly — transparency over
omission, per THIRD-PARTY-PROVENANCE.md.

---

## Short form (Discord)

**ACME r10 — high-resolution Asheron's Call, for the retail client**

Upscaled, re-encoded textures — towns, dungeons, props, creatures, terrain —
derived from your own install's assets, plus sculpted dungeon-wall relief,
4× creature models, and an optional plugin pack (modern lighting, volumetric
sky, ragdoll deaths).

- Package: `acme-r10.tgz` / `.zip` — sha256 ⟨archive-sha⟩ (⟨archive-size⟩)
- Patches over: any retail install, or any earlier ACME state. Self-contained,
  not a delta.
- Needs: your own retail `acclient.exe` — the kit patches it for you, in place,
  keeping a backup. **No retail game files ship in the package.**
- Rollback: restore your backed-up dats + `acclient.exe.acme-orig.bak`; delete
  the plugin folder if you installed it. You're back to bone-stock retail.

Install: back up, copy in, run `patch-my-client.bat` once, start with
`play.bat`. Linux/Wine is a first-class citizen: see `INSTALL-LINUX-WINE.md`
(`python3 acme-patch-client.py`, then `--check-kit`; the pack's `zzpatcher`
tool automates the Wine-specific setup via `wine zzpatcher.exe --fix-wine`).
`play.bat` verifies the install before every launch and fails loudly rather
than quietly rendering untextured walls.

## Long form (forum / release notes)

**What it is.** A content and stability upgrade for retail Asheron's Call,
installed over your own files:

- **Textures**: every upscale is derived from content already in your install,
  re-encoded through the same DXT path the client uses. No third-party art.
- **Dungeon relief**: 3,924 sculpted wall-environment variants across 2,193
  landblocks — flat dungeon walls gain real displaced geometry.
- **Creatures**: 1,163 creature models re-meshed at 4× subdivision (with the
  proportions kept honest — the pass that bulged some heads was caught and
  reverted before ship).
- **Correctness**: this release also repairs 3,414 palettized texture records a
  build-pipeline bug had corrupted in earlier internal tiers (wrong palette
  rows = muddy NPC clothing). Nothing corrupted was ever publicly shipped.
- **Optional plugin pack**: modern lighting + bloom, a real volumetric sky,
  physics ragdoll deaths, an experimental in-game art-annotation tool, and the
  `zzpatcher` control panel (GUI + full command-line) that tunes all of it.

**What's in the package.**

| file | size | sha256 |
|---|---|---|
| `client_portal.dat` | 572,314,624 (546 MiB) | ⟨portal-sha⟩ |
| `client_highres.dat` | ⟨highres-size⟩ | ⟨highres-sha⟩ |
| `client_cell_1.dat` | 347,298,304 (331 MiB) | ⟨cell-sha⟩ |
| `play.bat`, `patch-my-client.bat`, `acme-patch-client.ps1`, `acme-patch-client.py`, `kit-manifest.txt`, `INSTALL-WINDOWS.md`, `INSTALL-LINUX-WINE.md`, `SHA256SUMS.txt`, `README.txt` | — | see `SHA256SUMS.txt` |
| `acme-plugins/` (optional; see below) | ~117 MB | see `SHA256SUMS.txt` |

**The split, and why the client patch is required.** Retail's portal dat is
capped at 2 GiB by its own format. Our high-res records live in
`client_highres.dat` — the same file retail's own high-res tier used — with the
superseded copies stripped from the portal. The retail client only mounts
`client_highres.dat` when a server tells it to, and silently carries on without
it, so the kit patches your client to mount it unconditionally. Two
consequences stated plainly: `client_highres.dat` is load-bearing (missing =
missing textures, which is why `play.bat` refuses to launch without it), and
the patched client does **not** advertise the extra dat — your server sees the
same three files retail does and answers "no update required".

**What the client patch changes** (9 logical patches, all listed with their
sources in `acme-patch-client.ps1`, which is plain readable text):

- the community palette-leak fix, plus the third site that makes it safe — the
  widely-circulated 2-site version corrupts the heap at world entry;
- a palette **double-free** fix (a real retail bug our dats tickle);
- DAT version-preserve, so compressed dat records load (trevis's fix);
- high-res mount + advertise cap (above);
- the 4K resolution unlock (UI resize clamps, 2 sites);
- DAT parser alignment (189 sites, one logical patch) — unaligned reads fixed
  so dat files past 2 GB parse correctly.

The patcher locates every site by a unique byte signature, refuses if a
signature is missing or ambiguous, is safe to run twice, and keeps
`acclient.exe.acme-orig.bak`. Windows players use the PowerShell version via
`patch-my-client.bat`; Linux/Wine players use `acme-patch-client.py`, which
carries the same nine deltas and a `--check-kit` install check.

**The plugin pack (optional, experimental-tier).** `acme-plugins/` is entirely
optional — skip the folder and nothing here touches you. It bundles the
open-source **Chorizite** plugin runtime (MIT; we ship our own build with two
published patches — provenance, licences, and per-file hashes are in
`THIRD-PARTY-PROVENANCE.md` and `NOTICES.txt` inside the folder). It works by
**injecting into the running client** — the same technique Decal and every AC
plugin loader use — so some antivirus may flag it; the dats never depend on it.
You launch AC however you always do (ThwargLauncher, a shortcut); `zzpatcher`
attaches the plugins to the running client, tunes 147 live-reload knobs across
lighting/sky/ragdoll with live previews, and everything it can do in the GUI it
can also do headless (`zzpatcher --help`; profiles are shareable text files, so
a good tuning travels as one small `.zzp`). No retail client bytes ship here
either: this half does no permanent patching at all — pull the folder and the
client is byte-stock.

**Server operators**: serve these same dats, or turn DDD off. The portal keeps
retail's iteration record, so a vanilla server answers "no update required".
See `server-ops.md`.

**Rollback**: restore your backed-up `client_portal.dat` / `client_cell_1.dat`,
delete `client_highres.dat`, restore `acclient.exe.acme-orig.bak`, delete
`acme-plugins/` if you copied it.

---

## Owner decisions still open before posting (carried from r8 + new)

1. Where does this get posted, and under what name/handle?
2. Hosting for a ~1.8 GB package.
3. `.zip` alongside `.tgz` — the assembler emits both; post both?
4. Anything to say about earlier internal tiers? (Nothing was publicly
   distributed; the palette bullet above says what happened without dates.)
5. Showcase video: post now with frames, or hold for the video? (The ragdoll
   preview video + r5 dungeon tour footage exist as raw material.)
6. NEW: the plugin pack's AV-flag risk — is the injection paragraph above
   blunt enough for your taste, or should it be stronger?
