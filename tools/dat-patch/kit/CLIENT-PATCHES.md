# What patch-my-client does to your acclient.exe — the complete list

Your `acclient.exe` is patched **in place, on your machine**, by
`acme-patch-client.ps1` (Windows) / `acme-patch-client.py` (Linux/wine). This
archive contains **no game executable and no retail bytes** — only the patch
deltas below, applied to the client you already own. The patcher keeps a backup
(`acclient.exe.acme-orig.bak`), targets only the 2015 End-of-Retail build
(4,841,472 bytes), and locates every site by a **unique byte-signature** — never
by a hardcoded address — so it aborts rather than patch the wrong bytes. Run
either patcher with `--verify` any time to see the state of every site.

Both patcher scripts are plain readable text: the full byte-level before/after
for every patch below is IN the scripts themselves, auditable with any editor.

## The 9 logical patches

| patch | sites | what / why |
|---|---|---|
| `palette-leak` ×2 | 2 | The community-known palette reference leak, both sites. Without it the client slowly leaks palette objects and degrades on long sessions. |
| `palette-double-free` | 1 | The third, mandatory companion site: fixes a genuine double-free the high-detail dats trigger at world entry (heap corruption → crash with pink/broken avatars). The 2-site fix alone is KNOWN-BROKEN against these dats. |
| `dat-version-preserve` | 1 | Lets the client read compressed dat records. Load-bearing at startup — an unpatched exe cannot boot these dats at all. |
| `highres-force-mount` | 1 | Mounts `client_highres.dat` (retail only mounts it when told to by a server). Without it the high-res textures are silently absent. |
| `highres-advertise-cap` | 1 | The client does NOT advertise the highres dat to servers that never asked for it: your server sees the same three dats retail does, so it won't try to "repair" your files. |
| `res-4k-unlock` ×2 | 2 | Removes the UI's resolution clamps so 4K (and anything else your GPU offers) is selectable. |
| `dat-align-lfa` | 189 | Fixes the client's unaligned DAT-parser reads (one logical patch, 189 identical idiom sites) so dat files past 2 GB parse correctly. Required for the large highres file. |

## Guarantees

- **Reproducible**: given a pristine retail exe, both patchers produce a
  byte-identical result — the release process gates on the `.ps1` and `.py`
  rebuilding the same artifact byte-for-byte before a kit ships. The shas of
  the pristine and the patched exe are printed in `README.txt`.
- **Refuses the unknown**: wrong size, wrong build, or an unrecognised byte
  pattern → the patcher stops and writes nothing.
- **Reversible**: `acclient.exe.acme-orig.bak` is your original; the Rollback
  section of README.txt (or `zzpatcher.exe --rollback`) restores it.
