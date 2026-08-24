# REPORT 2026-08-24 — wine ship gate: gauntlet PASS, no fps regression

Buildbox (T4, wine 8.0, WineD3D/GL, `VideoMemorySize=2048`), current canonical exe
(`acclient.eor.patched.exe` md5 061106ec…, includes dat-align-lfa — the stale pre-LFA
box copy was replaced, backup `.pre-lfa.bak`), box r10 dat pair (portal 08-23 /
highres 08-21), vanilla ACE on the laptop over tailscale.

## FPS triage (the "25-30 fps outdoors" concern) — NO regression
| where | fps |
|---|---|
| Holtburg spawn outdoor | 92–96 |
| Yaraq outdoor, right after teleport (streaming) | 52–54 |
| Yaraq outdoor, settled after 20 s run | 90–92 |
| Underground Passage indoor | 520–600 |

The known-good config is intact: NVIDIA compat32 GL present (32-bit hardware GL),
`HKCU\Software\Wine\Direct3D VideoMemorySize=2048` set (THE unlock — without it the
client's texture purge trigger thrashes; acclient.c:457974). The earlier 25–30 fps
sighting was environmental (fresh prefix missing the registry key, capture overhead,
or CPU contention), not a code regression. For install docs: ship the registry key +
note gate-enter.sh's `WINEDLLOVERRIDES=d3d9=n` (DXVK) as the alternate backend.

## Ship-gate gauntlet — PASS
7 towns × 2 loops, 20 s W-hold sprint per stop (same stress grade as the 1070 diet
gauntlet), plain client (no Chorizite/plugins — the wine ship posture):
**14/14 stops, zero faults (`Unhandled page fault` count 0), alive end-to-end.**
Per-town fps 62–295; VM stable 2.6–3.2 GB (LFA exe gets 4 GB VA under 64-bit wine —
comfortable headroom for the un-dieted footprint). End screenshot at the Yaraq wall
renders correctly. Timeline + shots were in /tmp/gaunt on the box (box powered off
after the run; artifacts summarized here).

## Ops notes
- Double-launch trap: a timed-out gcloud ssh may STILL have launched its detached
  payload — two triage instances fought over the account ("Cannot have two accounts
  logged on"). Always `pgrep` before relaunching.
- Self-kill trap (again): `pkill -f fps-triage` inside an ssh command whose own
  cmdline contains the pattern kills the ssh. Bracket-escape: `pkill -f "[f]ps-triage"`.
- Driver scripts staged on box: ~/fps-triage.sh, ~/wine-gauntlet.sh (xdotool enter-world
  coords 975,731 dblclick + 1222,903 Enter, from gate-enter.sh, still valid).
