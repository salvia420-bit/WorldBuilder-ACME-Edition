# HANDOFF 2026-08-24 (second session) — previews complete (ragdoll + sky), lighting skipped

Continues HANDOFF-2026-08-24-zzpatcher.md. Owner decisions this session: **(1) spring layer
= the refactor path** (extract to `AcmeRagdoll/Sim/SpringMotion.cs`, transcription lives in
the plugin, zero drift); **(2) SKIP the lighting preview** — ship Ragdoll + Sky panes only
(design §4 stays on file if ever revisited). Team model held: Fable builders, Opus
adversarial review per feature, orchestrator fleet-tests. Commits `8faab0b3..8f1d02b1`.

## Landed (all Opus-reviewed, all findings fixed before commit)

- **SpringMotion extraction** (`651adbd1`): PD integrator, pool decay/smoothstep gain,
  per-impulse shaping + crit refractory moved verbatim into the pure static
  `Sim/SpringMotion.cs` (IdleMotion discipline). Registry feeds it a per-frame stack
  `Tuning`; the HIT log stays behind on `HitResult`. **Bit-identity verified twice**
  (orchestrator line-diff + independent Opus diff vs `git show HEAD:`). PreJit +
  RunClassConstructor coverage added for the UpdateParts-detour path.
- **Ragdoll preview complete**: mode strip `[Auto|Idle|Hit|Walk|Death]`, Hit mode through
  the real SpringMotion (normal+crit, energy-pool bar w/ knee marker, livemotion master
  switch), real IdleMotion idle consuming the baked roles/looseness/ground, GaitMotion Walk
  (Olthoi), death replay-same-seed only on death-knob change, framing auto-fit, skeleton
  validation, frozen draw resources.
- **All 7 archetype skeletons baked** (`8faab0b3`): Drudge/Reedshark/Olthoi(0x02000F95,
  the GaitMotion target)/Gromnie/Olthoi Grub/Wisp/K'nath, death anims resolved LSD
  didStats→MotionTable `[stance|Ready][Dead]` (K'nath's lives under stance 0x3C), snapshots
  carry per-part looseness/roles/ground with the plugin's −1 sentinel. **motionlib's hook
  walker rebuilt from ACE** (old table had wrong sizes for Attack/TransparentPart/Luminous,
  missing 0x09..0x1A incl. CreateParticle) and validated by parse+re-encode byte-identity
  over ALL retail portal animations (2066/2066) and MotionTables (436/436).
- **Sky preview + shared PreviewHost** (`8f1d02b1`): §1.1 pane (auto-follow, pin, pause,
  lifecycle gate, persisted expand state) + §3 sky (REAL `SkySunModel` csproj-linked,
  plugin-formula moon, NASA-noise clouds w/ transcribed weather resolution, cost meter,
  scrubber, 60s freeze, coalesced redraws + gamma LUT). Pre-existing Tune-tab bugs fixed
  in passing: per-knob reset bypassed WriteAndCache; toggle reread double-wrote.
- **License audit — NO BLOCKERS** (`087492db`, `19bebbe5`): Reloaded.* = **LGPL-3.0** (not
  GPL; ship texts + source pointers), ImageSharp 3.1.11 split-license → we qualify
  **Apache-2.0** (NOTICES must cite Apache-2.0 only, don't downgrade). Resolved with
  evidence: `acclient.map` → EXCLUDE (only reader is crash symbolication whose registration
  is commented out, Chorizite.cs:79); sky assets ship w/ credits (NASA Blue Marble PD, Yale
  BSC stars via takram MIT, Bruneton BSD-3). Verdict table + NOTICES file-set in
  `LICENSE-AUDIT-2026-08-24.md`; `THIRD-PARTY-PROVENANCE.md` rewritten (SDL rows removed —
  OpenGLSDLBackend doesn't ship).

## 1070 smoke test — PASSED (the refactor's gate)

Attach of the NEW plugin build into a fresh plain client: hooks in 217ms, all plugins
loaded, **`livemotion: types realised + handlers pre-JITed` = SpringMotion survives the
0x80131509 detour-path class-load rule**, layer armed, client stable; only the known
pre-existing PluginManagerUI failure. Test client killed + schtask deleted after.
**Residual (owed): an in-world hit pass** — the smoke client sat at login; bit-identical
math means only load/arming was at risk, but the fleet-video session should show real hits.

### Box state + deploys (1070)
- `C:\Games\Chorizite` = the rig. **Deployed this session (backups `*.bak-20260824`
  alongside): new `AcmeInject.exe/.dll` (the box copy was pre---list — unknown args made it
  SPAWN a client), new `AcmeRagdoll.dll`, and `ragdoll_profiles.json`** (the old rig ran
  0 profiles!). The deployed Chorizite runtime still predates the per-pid-log patch (logs
  go to shared `data/logs/log.txt`) — refresh it when convenient.
- **9 injected clients** (D:\ac-dat-test, `<account>`) launched 13:45–13:47 — the owner's
  burst, right as the session started; last human input 13:47. They carry the OLD
  AcmeRagdoll loaded at launch; idempotency (exit 23) protects them. One session sits at
  char select on `<account>`. Left untouched.
- ssh quirks (cost this session real time): cmd `dir`/compound `schtasks` chains silently
  fail over this ssh — **PowerShell for everything**; run `schtasks /run /tn acdtidle` as
  its own clean command, then read `C:\Temp\acdt\idle.txt`. `D:\Temp` recreated for scratch.

## Owed / next
1. **Fleet eyetest + video** (1070): ragdoll pane (all 7 bodies, Hit/Walk/pool bar) + sky
   pane §3.3 eyeball-vs-screenshots; batch as one session per the eyetest discipline.
   In-world hit pass for livemotion rides along.
2. **Packaging** (audit unblocked it): assemble archive (zzpatcher single-file publish is
   clean at 71.7MB) + `licenses/` + `NOTICES.txt` per audit §5, per-file SHA256SUMS,
   pinned Chorizite commit, re-validate the two chorizite patches, EXCLUDE acclient.map,
   strip Reloaded.Assembler.targets from plugin folders. Sky-asset credits per audit §7.
3. Chorizite runtime refresh on the 1070 (per-pid-log build) before the next multi-box run.
4. Preview polish backlog (explicitly deferred, small): Δ-ghost death overlay (§2.5),
   Lights-domain placeholder says "in-game only" — fine as shipped.

## Addendum (same session): Fix/Install tabs + Wine — DONE (`4835f994`)

Owner asked about the two under-loved tabs and Wine coverage. Both resolved:
- Tabs built out (common-errors panel, UserPreferences/log-tail fixes, platform gating);
  full detail in the commit message.
- **Wine verdict, tested on the wine gate box (T4, wine 8.0, fresh win64 prefix): the
  zzpatcher GUI does NOT run (WPF stack overflow at media-context init — do not re-tread);
  the headless CLI DOES.** Linux surface = `wine zzpatcher.exe --fix-wine [--apply]
  [--dxvk]` + `--tune`, sharing one `WineFixes` implementation with the GUI's Wine-only
  section (validated via ZZPATCHER_FAKE_WINE). Full check/apply/env-conflict/exit-0 matrix
  proven under real Wine. INSTALL-LINUX-WINE.md updated (incl. correcting the stale
  "baked sky is the default" line — live defaults ON).
- Box note: `~/zzwine` (win64 prefix) left on the buildbox for future zzpatcher wine runs;
  wine64 confirmed installed; box powered off after.
- Owed additions to the earlier list: FAKE_WINE GUI eyeball on the 1070 can join the
  batched eyetest session (item 1).
