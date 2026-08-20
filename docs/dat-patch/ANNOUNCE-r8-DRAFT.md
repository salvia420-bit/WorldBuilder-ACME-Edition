# ACME r8 — announcement DRAFT (owner review before anything is posted)

Nothing here has been posted anywhere. Sizes/hashes are filled from the built
kit (reports/r8-kit-assembly-2026-08-19.md); re-check them against
`acme-r8.tgz.sha256` at posting time.

Norms this draft follows (community-norms.md): patch-over-your-own-install, no
retail files and **no client executable** redistributed, back-up-first as the
first instruction, package + sha256 + rollback stated up front.

---

## Short form (Discord)

**ACME r8 — high-resolution Asheron's Call dats**

Upscaled, re-encoded textures for the retail client — towns, dungeons,
props, creatures, terrain — derived from your own install's assets.

- Package: `acme-r8.tgz` — sha256 `<TGZ_SHA>` (`<TGZ_SIZE>`)
- Patches over: any retail install, or any earlier ACME release. Each release
  is self-contained, not a delta.
- Needs: your own retail `acclient.exe` (the kit patches it for you, in place,
  keeping a backup — no game binaries are redistributed).
- Rollback: restore your backed-up dats + `acclient.exe.acme-orig.bak`.

What's new in r8: the upgraded textures now live in `client_highres.dat`
instead of being stacked inside `client_portal.dat`. The portal drops from
1.43 GiB to 530 MiB, which puts it a long way clear of the format's 2 GiB
ceiling and leaves room for the next content passes. Your server still sees
the same three dats retail does, and answers "no update required".

Install: back up, copy in, run `patch-my-client.bat` once, start with
`play.bat`. `play.bat` checks the install before every launch and refuses to
start on a missing or truncated dat or an unpatched client — a half-installed
kit fails loudly instead of quietly rendering untextured walls.

## Long form (forum / release notes)

**What it is.** A texture patch for retail Asheron's Call: every upscale is
derived from content already in your install, re-encoded through the same DXT
path the client uses. No third-party assets are introduced, and the package
contains no retail files.

**What's in the package.**

| file | size | sha256 |
|---|---|---|
| `client_portal.dat` | `<PORTAL_SIZE>` | `<PORTAL_SHA>` |
| `client_highres.dat` | `<HIGHRES_SIZE>` | `<HIGHRES_SHA>` |
| `client_cell_1.dat` | `<CELL_SIZE>` | `<CELL_SHA>` |
| `play.bat`, `patch-my-client.bat`, `acme-patch-client.ps1`, `kit-manifest.txt`, `SHA256SUMS.txt`, `README.txt` | — | see `SHA256SUMS.txt` |

**The split, and why the client patch is required.** Retail's portal dat is
capped at 2 GiB by its own format. Stacking high-res copies on top of the
retail records was walking that ceiling. r8 moves ours into
`client_highres.dat` — the same file retail's own high-res tier used — and
strips the superseded copies out of the portal. The retail client only mounts
`client_highres.dat` when the server tells it to, and silently carries on
without it when it is missing, so the kit patches your client to mount it
unconditionally. Consequences worth stating plainly:

- `client_highres.dat` is now load-bearing. Without it you get missing
  textures, not an error — which is why `play.bat` refuses to launch without it.
- The patched client does **not** advertise the extra dat to servers. Your
  server sees the same three files retail does, so a vanilla server will not
  try to patch you.

**What the client patch changes** (8 sites, all listed with their sources in
`acme-patch-client.ps1`, which is plain readable text):

- the community palette-leak fix, plus the third site that makes it safe —
  the widely-circulated 2-site version corrupts the heap at world entry;
- DAT version-preserve, so compressed dat records load (trevis's fix);
- high-res mount + advertise cap (above);
- the 4K resolution unlock (UI resize clamps).

The patcher locates every site by a unique byte signature, refuses if a
signature is missing or ambiguous, is safe to run twice, and keeps
`acclient.exe.acme-orig.bak`. It does not touch anything else.

**Server operators**: serve these same dats, or turn DDD off. The portal keeps
retail's iteration record, so a vanilla server answers "no update required".
See `server-ops.md`.

**Rollback**: restore your backed-up `client_portal.dat` / `client_cell_1.dat`,
delete `client_highres.dat`, restore `acclient.exe.acme-orig.bak`.

---

## Owner decisions still open before posting

1. Where does this get posted, and under what name/handle?
2. Hosting for a ~1.3 GB package (the previous tiers were never publicly hosted).
3. Ship a `.zip` alongside the `.tgz`? Windows players will find tgz awkward.
4. Do we say anything about the earlier tiers that were rendered/toured with the
   known-broken 2-site palette exe (HANDOFF-2026-08-19-EOD)? Nothing was
   publicly distributed, so the honest answer is probably "nothing to say".
5. The showcase video (roadmap §6) is not shot yet — post now with frames, or
   hold for the video?
