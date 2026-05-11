# Handoff — 2026-05-11

Session was operational/ops, not feature work. **No commits were made.** The work was: disk-space triage, then diagnosing & restarting the local ACE server so the browser client could log in via wsbridge.

## What I did this session

1. **Disk triage.** `/` was at 100% (2.3 MB free of 117 GB). Verified `/mnt/wbterminal1` (6.8 TB free) and `/mnt/wbterminal2` (6.9 TB free) are fine.
2. **Identified consumers** on `/`:
   - 63 GB — `/home/wbterminal/WorldBuilder-ACME-Edition` (still there, **biggest remaining risk**)
   - 9.7 GB — `/tmp` (almost entirely `/tmp/ace.log` at 9.5 GB)
   - 6.9 GB — `/home/wbterminal/projects`
   - 8.7 GB — `/usr`; 2.2 GB — `avalon_scratch`; ~3 GB — ML bundles + `dist-fresh/` + `ac-updates.zip`
3. **Truncated `/tmp/ace.log`** (`lsof` was empty — no live writer). `/` went from 2.3 MB → 9.5 GB free (92% used). User declined moving any other dirs this session.
4. **Diagnosed connect hang** ("Connecting to wss://drainage-eden-ahead-herbal.trycloudflare.com/wsbridge … sending LoginRequest…"):
   - Browser → cloudflared (`--url http://127.0.0.1:7080`, node pid 884200) → wsbridge (`holtburger-wsbridge --listen 0.0.0.0:8080`, pid 881549) all working.
   - wsbridge log showed `ws→udp 76 bytes → 127.0.0.1:9000` forwarding into the void — **nothing listening on UDP 9000**. UDP doesn't error on no-receiver, so wsbridge happily forwards forever and the client just waits. Hypothesis: ACE crashed when its 9.5 GB log filled `/`.
5. **Restarted ACE.** Binary at `/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE.Server.dll`. `dotnet` is not on PATH — used `/home/wbterminal/.dotnet/dotnet` directly with `DOTNET_ROOT=/home/wbterminal/.dotnet`. Redirected log to `/mnt/wbterminal1/ace.log` and symlinked `/tmp/ace.log → /mnt/wbterminal1/ace.log` so anything still reading the old path keeps working.
6. **Verified.** ACE PID 888729 (or its child) bound UDP 0.0.0.0:9000. Log: "World started… auto-open when startup complete" → "ACEmulator command prompt ready."

User was about to retest the browser login when they asked for this handoff.

## Current operational state (verified this session)

| Component | Status | Detail |
|---|---|---|
| `/` disk | 92% (9.5 GB free) | Was 100%. **WorldBuilder-ACME-Edition (63 GB) is the next lever** if it tightens again. |
| ACE server | Running | UDP `0.0.0.0:9000`; logs to `/mnt/wbterminal1/ace.log`; `/tmp/ace.log` is a symlink to it. Stdin-less prompt loop spams `ACE >> ACE >>` into the log — harmless but it grows. Drive has 6.8 TB so it can spin for a long time. |
| wsbridge | Running | `holtburger-wsbridge --listen 0.0.0.0:8080`, pid 881549, logs `/tmp/wsbridge.log` (18 MB). Forwards WS → UDP `127.0.0.1:9000`. |
| cloudflared | Running | `--url http://127.0.0.1:7080`, pid 884231. Tunnel URL: `drainage-eden-ahead-herbal.trycloudflare.com`. |
| Web app | Running | Node listening on `127.0.0.1:7080`, pid 884200. |
| World status | Auto-opens at boot | If players can't log in even with ACE up, check `world open` from the ACE console. |

## Context from memory (NOT verified this session — treat as priors)

The memory index has a large `project_emit_dynamic_site` entry summarizing Phase 6 completion (buildings/interiors/Z-culling, smoke 121/0/1, cargo 181/0, manifest v2 fix freeing ~195 MB → 541 bytes, etc.), plus `docs/phase-5.2-manifest-fix.md` as-built. **These docs are likely stale** by the time you read this — the project moves fast and the memory entry hasn't been touched today. Before quoting numbers or claiming features exist:

- `git log --oneline -30` in `/home/wbterminal/WorldBuilder-ACME-Edition` and the holtburger subtree to see what actually shipped recently.
- Run the smoke suite to confirm pass counts before citing them.
- Check that named files/symbols from memory still exist (e.g. `holtburger_dat::file_type::env_cell::surface_did_for_envcell_index`, `populateBuildingAabbsForLandblock`) — memory records facts at write time, not now.

Memory also lists known open follow-ons (still useful as a starting backlog, but reconfirm each):
- Integrator overshoot (cosmetic 25 m/s vs 4.5 m/s — possibly dt scaling or Playwright-headless rAF artifact)
- `caps_ok` regression root cause (watchdog at `bbf8aae` masks it)
- `biota_properties_position` lazy persist (server-side ACE; client workaround is to dump `PrivateUpdatePosition` events)
- Hinge-frame extraction from `SetupModel` for door rotation precision (deferred)

## Direction forward

1. **Verify the user's login works** with ACE now up. If it still hangs, the wsbridge↔ACE handshake is the next layer to inspect: tail `/mnt/wbterminal1/ace.log` while attempting login and confirm ACE sees the LoginRequest packet at all. If it doesn't, suspect the wsbridge UDP source-port routing (each WS client gets an ephemeral UDP socket — see `49496` in `ss -ulnp`).
2. **Don't let `/` refill.** Top priority if disk tightens: move `/home/wbterminal/WorldBuilder-ACME-Edition` (63 GB) to `/mnt/wbterminal1` and symlink the original path back. The repo is heavily referenced by memory and skills, so the path must stay identical.
3. **Resume Phase 6+ work** (or whatever the user names next). Use the memory `project_emit_dynamic_site` as a backlog hint, but reconfirm against the actual repo state.

## Grounding resources (do not skip)

- **`feedback_test_fixtures_real_data`**: prefer real `portal.dat` from the installer over synthetic fixtures.
- **`feedback_ground_in_real_wire_data`**: capture wire packets + parse real DAT bytes BEFORE shipping holtburger-web parser/networking changes. No speculative fixes.
- **`feedback_no_partial_demos`**: if you can't fully demonstrate something through the load-bearing path, say so. Don't bypass with a partial demo.
- **`reference_worldbuilder_terminal`**: for DAT/dungeon questions, use WorldBuilder.Terminal first; skill at `~/.claude/skills/worldbuilder-terminal/skill.md`. Cross-reference PhatSDK + ACE + real bytes.
- **`project_holtburger_bake_disk_trap`**: any bake (dat-shard ~4.7 GB) must symlink `dist/` to `/mnt/wbterminal{1,2}` — not `/`, not `/tmp`.
- **`project_holtburger_login_form_picker`**: capture scripts using `input[name="server_ip"]` are stale — use `input[name="server_host"]` (changed in commit `3954289`).
- **`project_holtburger_godmode_falldamage`**: persistent fall-damage bug in capture runs; workaround `/god` or `/godly`.
- **`project_holtburger_academy_landblock`**: player spawns at LB `0x8602` (Training Academy), not Holtburg. "Holtburg town hall" labels in capture scripts are stale.
- **Live-server stack** lives on Tailscale `100.116.47.66` (tailnet1/tailnet1, Developer-promoted). Tester is PK. Playwright lives at `/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules` — set `NODE_PATH` if running CJS scripts directly.
- **DAT bake artifacts (Phase 5.2 v2)**: `/mnt/wbterminal1/holtburger-dist-v2` (4.3 GB). v1 retained at `/mnt/wbterminal1/holtburger-dist` for rollback.

## Gotchas worth knowing

- `dotnet` is **not on PATH** in this shell. Use `/home/wbterminal/.dotnet/dotnet` and set `DOTNET_ROOT=/home/wbterminal/.dotnet`.
- ACE prints its prompt to stdout every loop with no tty — log file grows slowly even when idle. On `/mnt/wbterminal1` this is fine; if you ever re-point logs to `/`, **don't**.
- `nohup` without explicit stdin redirect closes stdin to `/dev/null` automatically — that's why the ACE prompt loop runs without input.
- Memory entries that name specific files/symbols/PRs are time-stamped facts, not current state. Verify before relying on them.

## What I did NOT do

- No code changes. No commits. No PRs. No tests run.
- Did not move `WorldBuilder-ACME-Edition` or any other big dir (user declined this session).
- Did not phone-validate live ACE on cellular (still pending PK per memory).
- Did not touch any emit-dynamic-site code or docs. `docs/phase-5.2-manifest-fix.md` and the `project_emit_dynamic_site` memory entry are unchanged but **likely stale** as time passes; reconfirm before quoting.
