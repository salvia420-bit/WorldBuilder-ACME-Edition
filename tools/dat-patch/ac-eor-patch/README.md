# ac-eor-patch vault (2026-08-21)

Repo-tracked copy of the release-critical, previously single-copy patcher
sources from `/mnt/wbterminal2/ac-eor-patch/` (the 2026-08-21 docs audit
flagged this as the #1 kit-assembly risk: `assemble_kit.sh` and
`check_ps1_table.py` hard-depend on that directory, which had no second copy
anywhere).

- The DRIVE remains the working location — `assemble_kit.sh` /
  `check_ps1_table.py` default paths still point there. This vault is
  reference + disaster recovery; if you change `patch_client.py`/`PATCHES.md`
  on the drive, re-copy them here (and re-run the MANIFEST line below).
- Client EXECUTABLES are deliberately NOT in git (copyrighted game binary).
  Integrity anchors live in `MANIFEST.sha256`; full binary backups (orig,
  patched, all .bak generations) are at
  `/mnt/wbterminal1/ac-eor-patch-backup/` (rsynced 2026-08-21, 74 MB).
- `yonneh-acclient.map` is the link-map oracle for the shipped-exe build —
  irreplaceable, hence vaulted despite its size (3.9 MB text).

Refresh recipe:
```
V=tools/dat-patch/ac-eor-patch
cp /mnt/wbterminal2/ac-eor-patch/{patch_client.py,PATCHES.md,PATCH-NOTES.md,COMPRESSION-PATCH-FINDINGS.md,yonneh-acclient.map} $V/
(cd /mnt/wbterminal2/ac-eor-patch && sha256sum acclient.eor.orig.exe acclient.eor.patched.exe acclient.exe patch_client.py PATCHES.md PATCH-NOTES.md yonneh-acclient.map) > $V/MANIFEST.sha256
rsync -a --include='*.exe' --include='*.bak' --include='*.py' --include='*.md' --include='*.map' --include='*.sha256' --exclude='*' /mnt/wbterminal2/ac-eor-patch/ /mnt/wbterminal1/ac-eor-patch-backup/
```
