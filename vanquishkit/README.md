# Vanquish Play Kit

This folder is a portable "play kit" so someone can host and play the Vanquish world on their own ACE setup without retail auto-update undoing the changes.

## What is included

- `files/dat/client_cell_1.dat`
  - Final Vanquish terrain/building DAT.
- `files/sql/01_town_instance_reseed.sql`
- `files/sql/02_building_remap_video_townflush.sql`
- `files/sql/03_outdoor_instance_remap.sql`
- `files/sql/04_portal_town_network_remap.sql`
- `files/sql/05_portal_remap_from_lb_remap.sql`
- `files/sql/06_reposition.sql`
  - DB patches for NPCs, interiors, portals, and terrain Z alignment.
- `files/metadata/lb_remap.json`
- `files/metadata/town_placements.json`
  - Reference metadata for town/world mapping.
- `install_vanquishkit.ps1`
  - Backs up your current setup, disables ACE auto-overwrite settings, copies DAT, applies SQL.
- `restore_vanquishkit.ps1`
  - Restores the last backup (or a specific backup folder).

## Prerequisites

- ACE server installed (default expected path: `C:\ACE`)
- AC client installed (default expected path: `C:\Asheron's Call`)
- MariaDB tools installed (default expected path: `C:\Program Files\MariaDB 12.2\bin`)
- SQL credentials for `ace_world` (defaults in scripts: `root` / `baltic`)
- Stop ACE server and AC client before install

## Install (recommended)

From a PowerShell window in this folder:

```powershell
.\install_vanquishkit.ps1
```

If your paths or DB credentials are different:

```powershell
.\install_vanquishkit.ps1 `
  -AceRoot "E:\ACE" `
  -ClientRoot "E:\Asheron's Call" `
  -MariaDbBin "C:\Program Files\MariaDB 12.2\bin" `
  -DbUser "root" `
  -DbPassword "your_password" `
  -DbName "ace_world"
```

If you do not want to overwrite client DAT automatically:

```powershell
.\install_vanquishkit.ps1 -SkipClientDat
```

## What install script does

1. Stops `acclient` and `ACE.Server` if running.
2. Creates backup folder:
   - `C:\ACE\vanquishkit_backups\<timestamp>\`
3. Backs up:
   - ACE `client_cell_1.dat`
   - AC client `client_cell_1.dat` (unless `-SkipClientDat`)
   - `C:\ACE\Server\Config.js`
   - DB tables: `landblock_instance`, `landblock_instance_link`, `weenie_properties_position`, `encounter`
4. Patches `Config.js`:
   - `"AutoUpdateWorldDatabase": false`
   - `"AutoApplyWorldCustomizations": false`
5. Copies Vanquish `client_cell_1.dat` to ACE (and client unless skipped).
6. Applies SQL payloads in numeric order.

## Important anti-overwrite note

ACE can auto-update or auto-apply world customizations and overwrite world state back toward retail defaults.

Keep these disabled in `Config.js`:

- `AutoUpdateWorldDatabase = false`
- `AutoApplyWorldCustomizations = false`

The installer enforces this, but do not turn them back on for this world.

## Restore retail backup

Restore most recent backup:

```powershell
.\restore_vanquishkit.ps1
```

Restore a specific backup folder:

```powershell
.\restore_vanquishkit.ps1 -BackupPath "C:\ACE\vanquishkit_backups\20260321_132500"
```

## Quick launch after install

```powershell
Start-Process -FilePath "C:\ACE\Server\start_server.bat" -WorkingDirectory "C:\ACE\Server"
Start-Process -FilePath "C:\Asheron's Call\acclient.exe" -ArgumentList "-a baltic -v baltic -h 127.0.0.1:9000" -WorkingDirectory "C:\Asheron's Call"
```

## Pack for sharing

Zip the entire `vanquishkit` folder and share that zip. Do not remove subfolders.
