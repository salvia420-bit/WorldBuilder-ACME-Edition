# Driving the retail AC client headlessly on the 1070 (recipe, proven 2026-08-15)

The in-client gate + tour automation for patched dats. Everything runs OFF-SCREEN and
MUTED on a box a person uses — see MEMORY §fleet rules. Scripts live in `C:\Temp\`
(acdt-*.ps1/.bat) with scheduled tasks `acdtgate/acdtclick1/acdtdrive2/acdttour*`;
output in `C:\Temp\acdt\`; isolated client copy in `D:\ac-dat-test\`.

## The load-bearing facts

- **Dats resolve from the process CWD** (decomp: `CLCache::Init` → `LookFile::LookForFile`:
  cwd → env `PROJECT_DAT` → nothing else; there is NO DatFilesDirectory in the client) —
  so an isolated copy of the install with swapped dats Just Works. `-rodat` opens read-only.
- **Launch line**: `acclient.exe -h <ip> -p <port> -a <account> -v <password> -rodat`
  (full switch table in the 2026-08-15 session; `-u <char>` SHOULD auto-enter world but
  did not — char select needs the click loop below). Client must be launched via
  `schtasks /create ... /it` + `/run` (interactive session; GPU + window handles are
  invisible to plain ssh sessions).
- **UserPreferences.ini in the client dir wins** (cwd file beats Documents;
  `UserPreferences::FindDefaultFile`). Keys that matter: `[Display] FullScreen=False`
  (fullscreen would seize the user's display), `[Sound] SoundVolume=0.00
  AmbientSoundVolume=0.00 InterfaceSoundVolume=0.00` (+ the *Disabled bools; volumes are
  polarity-proof), `[Render] EnvironmentTextureDetail=VeryHigh LandscapeTextureDetail=VeryHigh`.
  ⚠ **THE OLD `=0` RECIPE WAS BACKWARDS (found 2026-08-16 PM):** numeric values on choice
  prefs are treated as a CHOICE INDEX, and the choice arrays run worst-first:
  names {VeryLow,Low,Medium,High,VeryHigh} ↔ values {4,3,2,1,0}
  (`Render_EnvironmentTextureDetail_Values` acclient.c:41518). So `=0` selected index 0 =
  **VeryLow = value 4** — the WORST detail, worse than the boot default 2/Medium. Every
  gate eyeball and tour video through tour9 ran with quarter-detail textures; the dossier's
  "defeat via 0" intent is spelled `VeryHigh`. Full showcase INI (deployed on the box +
  scratch UserPreferences.showcase.ini): both details VeryHigh, TextureFiltering=Anisotropic,
  Landscape/BuildingDetailTextures=True, LandscapeDrawDistance=VeryHigh (mid_radius 15 vs
  Medium's 8; `Render::SetOverallGraphicsQuality` acclient.c:378743 shows the bundles),
  SceneryDrawDistance=High, Resolution=1920x1080. The GraphicsPerformance float is DERIVED
  from the individual prefs (`DetermineOverallGraphicsQuality`) — set individuals, not it.
  The client saves prefs on clean exit — redeploy the INI before each fresh launch if the
  previous client exited cleanly.
- **RESOLUTION (solved 2026-08-16): `[Display] Resolution=1920x1080`** — choice prefs
  serialize by CHOICE NAME, never number ("WxH", `RefreshRate=Auto`,
  `EnvironmentTextureDetail=VeryLow`; a client-authored INI from a clean exit is the
  canonical reference, kept at scratch `UserPreferences.canonical.ini` and live on the box).
  The mode must be in the adapter's D3D9 fullscreen mode list even for windowed — on the
  1070's 1080p monitor 1600x1200 is NOT enumerated and gets silently dropped (falls back
  800x600). Login/char-select is ALWAYS 800x600 by design: `gmClient::Init` calls
  `Device::ForceDisplayResolution(1,800,600)`; the `gmGamePlayUI` ctor releases it at world
  entry, so the pref applies IN-WORLD ONLY — measure there (`acdtrect` task writes
  `C:\Temp\acdt\rect.txt`). Measured: client area 1920x1071 in-world (window clamped to the
  work area; effectively native). Resizing the window externally (acdtresize) is useless —
  WM_SIZE only handles minimize, no swap-chain reset, you get a stretched 800x600 buffer.
  Kit INI now ships 1920x1080.
- **Always Daylight Outdoors == `/day`** (decomp: `ClientCommunicationSystem::DoDay` sets
  the same `PersistentAtDay` character option as the options-panel checkbox; persists on
  the character). It overrides LIGHTING only (`CRegionDesc::GetLighting(0.5,…)` = noon,
  clamped to `min_ambient`); the SKY DOME stays on the game clock — no hidden full-daylight
  switch exists, the trailer still needs a real Dereth day window for the sky. ACE's
  `/config PersistentAtDay on` is the server-side twin (needs `player_config_command`
  bool, currently disabled in ace_shard.config_properties_boolean — moot).
- **Two input planes.** Keystone UI (chat text entry, char-select clicks, WM_CLOSE) is
  message-driven: `PostMessage` WM_KEYDOWN/WM_CHAR/WM_LBUTTON* works from an interactive
  task with a prior fake-activation (`WM_ACTIVATEAPP 1` + `WM_ACTIVATE 1` — wndproc calls
  Device::Activate which arms ICIDM). But **keymap ACTIONS (open-chat Enter, camera,
  PrintScreen-screenshot) ride DirectInput emulation** — posted messages never reach them;
  use `SendInput` while the (off-screen) window is FOREGROUND, guarded by
  `GetLastInputInfo` user-idle >5 min, and restore the previous foreground window after.
  Chat text via SendInput KEYEVENTF_UNICODE is rock-solid.
- **Char select**: dblclick the character list entries top-down at (150, 150/190/230/...)
  client coords until ACE logs "entered the world" (laptop feedback loop re-running the
  `acdtclick1` task with coords in `C:\Temp\acdt\clickpos.txt`). List order = last-login
  DESC, so the slot drifts.
- **Do NOT send Escape** to "clear" state — Escape toggles the Gameplay Options panel.
- **Capture**: PrintWindow/BitBlt of the fully off-screen window is BLACK (occluded D3D9
  present skips the redirection surface). Working: **OBS window-capture (WGC, method 2)**
  records occluded windows fine — profile+collection `acdt` deployed under
  `%APPDATA%\obs-studio\basic\` (window string
  `Asheron's Call:Turbine Device Class:acclient.exe`, mkv to `C:\Temp\acdt\video`).
  Launch `obs64 --profile acdt --collection acdt --startrecording --disable-shutdown-check
  --multi` from its bin dir, move ITS window off-screen too, WM_CLOSE (may need force-kill;
  mkv survives). The client's own `Device::SaveScreenshot` exists (writes
  ScreenShot%05d.jpg next to the prefs file) but its keybind never fired for us.
- **Crash forensics**: watcher records `EXITED code=...`; Windows keeps
  `Get-WinEvent Application/Application Error` records with fault offset (how the
  ConstructMesh sides_type=2/neg=-1 crash was pinned to 0x59e560 = d3dpolyrender.cpp:1242).
  The 2013-PDB cvdump in ~/ac-headers/acclient.txt maps the D:\ install exe's RVAs at
  +0x1000.
- **ACE side**: server must run the SAME patched dats or DDD boots the client
  ("Client has newer DATs than server"). Repoint `Config.js DatFilesDirectory`, restart via
  `echo stop-now > ~/ace_stdin.fifo`, relaunch per memory/ace-live.md. Console command
  output (e.g. `time` → "It is currently Night in game right now") lands in ACE_Log.txt.
  In-game daylight: 1 Dereth day = ~2.1 real hours; schedule showcase recordings by
  polling `time`.
