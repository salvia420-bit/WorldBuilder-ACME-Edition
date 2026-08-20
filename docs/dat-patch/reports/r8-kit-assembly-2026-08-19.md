# r8 kit assembly + player-facing gates — 2026-08-19 (EOD4)

Executes HANDOFF-2026-08-19-EOD3 queue item 2 (kit assembly), on the owner's
r8 eye-review sign-off ("vistested it a lot on the 1070, it's good") and the
EOD3 recommendation for loud-fail mechanism B. Continues
reports/r8-hifi-split-2026-08-19.md — read that first for what the r8 pair is.

## The shape of the kit — and the one design change made here

EOD3 sketched the kit as "r8 portal + r8 highres + cell + **FMCAP exe** +
play.bat + kit-manifest.txt". Shipping the exe collides with our own
distribution note (community-norms.md): ACME packages carry **no client
executable** and no retail bytes — the player supplies their own install. r8 is
the first tier that genuinely needs a patched client (post-split, only a
patched client mounts client_highres.dat), so the kit now delivers the client
change as a **patcher** instead of a binary:

- `acme-patch-client.ps1` — the 8 shipped patches as signature-located byte
  deltas, applied to the player's OWN `acclient.exe`. Plain readable text
  (a player can audit every change), Windows PowerShell 5.1+, no other
  dependency.
- `patch-my-client.bat` — double-clickable wrapper, run once.
- `acme-patch-client.py` — the same table for **Linux / macOS / wine players**,
  who have no PowerShell. It also carries `--check-kit`, the play.bat check
  (dat sizes + exe patch state) for people who launch acclient.exe under wine
  directly. Without it the kit would have been Windows-only, which a large part
  of the emu community is not.

Same doctrine as the lane's `patch_client.py`: unique byte signature per site,
refuse on missing/ambiguous signature or unexpected file size, idempotent
re-run, PE checksum recomputed, backup kept as `acclient.exe.acme-orig.bak`.
Nothing is written unless all 8 sites resolve.

This forecloses nothing: if bypass-the-launcher ever proves common, mechanism A
(the in-client loud fail) is still available, and an exe could still be shipped
by a later owner decision.

## Kit contents (built by tools/dat-patch/kit/assemble_kit.sh)

| file | bytes | sha256 |
|---|---|---|
| client_portal.dat | 556,033,024 | `c0073025…` |
| client_highres.dat | 967,217,152 | `e7c82c33…` |
| client_cell_1.dat | 347,298,304 | `2eaf2a84…` |
| play.bat / patch-my-client.bat / acme-patch-client.ps1 / acme-patch-client.py | — | in SHA256SUMS.txt |
| kit-manifest.txt / SHA256SUMS.txt / README.txt | — | generated |

`assemble_kit.sh` sha256-verifies every copy as it lands, generates the
manifest from the copied files' actual sizes, writes README.txt (install /
UserPreferences.ini / server / rollback), then **self-gates**: it re-runs
play.bat's own name+size rule in bash and `sha256sum -c` over the kit before
it will package.

**Package**: `acme-r8.tgz` — 1,284,983,820 bytes (1.20 GiB), sha256
`539a8120f09f960eaf392957a6d3d14f9806e8ab9f6f2a93f11fa8a33183717e`.

## GATE 3 — the shipped tarball, verified end to end
Extracted into a clean directory and checked as a player receives it:
`.tgz.sha256` OK; all 9 `SHA256SUMS.txt` entries OK after extraction; all three
dats match `kit-manifest.txt`; **the shipped `acme-patch-client.py`, run inside
the extracted kit against a pristine retail exe, produces `6c3232ea…`** and then
`--check-kit` reports `KIT-OK`. Text files land as ASCII with CRLF (README,
manifest, both .bat) — no mojibake in a non-UTF-8 console or old Notepad.

## GATE 1 (laptop) — the patchers' tables and artifact parity
`tools/dat-patch/kit/check_ps1_table.py`, both green, covering BOTH patchers:
- **table parity**: each patcher's 8 entries are byte-identical (sig / needle_at
  / needle / replace) to `patch_client.py`'s enabled set, neither carries
  anything extra — a stray candidate in the kit would ship an ungated byte
  change to players — and the two tables agree with each other entry for entry.
- **artifact parity**: applying EACH patcher's OWN table to the pristine retail
  exe (`bca95bbe…`) reproduces the SHIPPING exe **byte-for-byte**, PE checksum
  included: sha256 `6c3232ea7496cb743f591a03f887d9e46b1f8260b1ee67770ee3adceadbd5f37`
  (= md5 `34b68dea…`, the exe that passed the FMCAP in-client gate and the r8
  mount/tour gate). The kit's exe delivery therefore inherits those gates
  rather than needing its own in-client arm.
  Sites resolve at 0x13EFFE / 0x13F19C / 0x13ED75 / 0x271C78 / 0x0FAFA9 /
  0x0FB051 / 0x06128D / 0x063D94 — matching the addresses quoted across the
  lane reports.

Negative-tested: a one-byte edit to a copy of the py table is reported as a
ps1/py mismatch AND fails artifact parity (rc 1).

The Python patcher was additionally gated on this laptop (6 arms, all pass):
patch pristine → `6c3232ea…` with PE checksum `0x004A1974`; idempotent re-run;
`--check-kit` OK on a complete stand-in kit; refuses a missing dat, a
wrong-sized dat, and an unpatched exe; refuses a foreign file without writing.

## GATE 2 (1070, headless) — 14 arms, ALL PASS
`tools/dat-patch/kit/kit-gate.ps1`, run over ssh in `C:\Temp\kitgate`. No
client launch, no display, no input: safe with a person at the box (idle probe
was 8.9 h and climbing 1:1 anyway).

Arm A — the patcher on real Windows PowerShell:
- A1 pristine retail exe → patched, sha256 == the gated shipping exe.
- A1b/A1c backup kept and byte-identical to the retail input.
- A2 re-run → "Already patched", rc 0, bytes unchanged (idempotent).
- A3 `-Verify` on pristine → rc 1; A3b `-Verify` on patched → rc 0.
- A4 a foreign/truncated file → REFUSED, rc 1, target untouched.

Arm B — play.bat (fresh-install loud-fail), stand-in dats so the rule is
exercised without moving 1.8 GB:
- B1 complete kit + patched exe → `KIT-OK`, rc 0.
- B2 a dat missing → LOUD-FAIL, rc 1, no launch.
- B3 a dat 1 byte short → LOUD-FAIL naming the actual vs expected size.
- B3b a dat oversized → LOUD-FAIL.
- B4 unpatched exe → LOUD-FAIL telling the player to run patch-my-client.bat.
- B5 re-patched → `KIT-OK` again (order-independent).

Arm C — the REAL artifacts, run in `D:\ac-dat-test` (the live r8 pair + the
FMCAP exe, 1.87 GB in place): `KIT-OK` on the real sizes, and LOUD-FAIL with
the real 967 MB highres renamed away, restored immediately after. **Launch cost
of the whole check on the real kit: 508 ms** (measured on the 1070), including
the PowerShell exe verify — the patcher's Add-Type compile is lazy precisely so
this path never pays for a csc invocation.

## ⚠ TWO DEFECTS THE GATE CAUGHT (both in the EOD3 play.bat, now fixed)
The first play.bat built its failure text inside an `if defined BAD ( … )`
block, from a string containing parentheses and caret-escaped parens:
1. **the wrong-size arm never fired** — the caret-escaped `^(` inside the
   nested for-body mangled the block, so a truncated dat passed as OK. Only
   the missing-file case had ever been gated (EOD3 tested exactly that one).
2. **the missing-file arm died with `'.' was unexpected at this time`** (rc
   255) instead of refusing — a `)` inside the expanded message closed the
   block early.
Rewritten: every file test lives in a `:checkone` subroutine, control flow uses
`goto` instead of nested blocks, and no message text contains parentheses. Both
arms now pass. Retained as a comment in play.bat so it is not reintroduced.

**Harness defect, same session**: kit-gate.ps1's first run wrote its stand-in
files through `[IO.File]::WriteAllBytes(".\…")`, which resolves against the
PROCESS current directory, not `Set-Location`'s — so arm B3 "passed" against a
file it had never shortened, and two junk files landed in the box's home
directory (removed; the person's files were never touched). Fixed by pinning
`[Environment]::CurrentDirectory`, and B3 now asserts the setup mutation before
asserting the refusal.

## What is NOT gated
- The **MessageBox** presentation of a loud fail (the interactive path). The
  message string was proven to reach PowerShell intact from the batch layer,
  and the one-liner is unchanged in shape from the EOD3 version that displayed
  correctly, but no dialog was rendered this session — that would put a window
  on the owner's screen. Ride it into the next interactive box session.
- A real `play.bat` → client launch on the assembled kit (the launch line is
  unchanged from the gated version; the dats and exe are byte-identical to the
  r8 arm that toured).

## Artifacts
- Kit: `/mnt/wbterminal2/dat-patch-r8/kit/acme-r8/` (+ `acme-r8.tgz`,
  `.sha256`), build log `/mnt/wbterminal2/dat-patch-r8/kit-assemble.log`,
  extract-verify log `kit-verify.log` (extraction under `kit-verify3/`;
  `kit-verify1/`, `kit-verify2/` are abandoned earlier extractions, ~5 GB, safe
  to delete).
- In repo: `tools/dat-patch/kit/{assemble_kit.sh, acme-patch-client.ps1,
  patch-my-client.bat, play.bat, kit-gate.ps1, check_ps1_table.py}`.
- Announce draft (NOT posted): `docs/dat-patch/ANNOUNCE-r8-DRAFT.md`.
- 1070: `C:\Temp\kitgate\` (gate dir, stand-in files only);
  `D:\ac-dat-test\` gained the new play.bat + patcher (old play.bat kept as
  `play.bat.prev-20260819.bak`); dats/exe untouched, no processes left.
