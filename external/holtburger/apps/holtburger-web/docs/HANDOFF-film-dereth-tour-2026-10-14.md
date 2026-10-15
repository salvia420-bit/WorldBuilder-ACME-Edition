# HANDOFF — "Dereth Town Tour" film (2026-10-14, paused before the main shoot)

**Status:** research + plan DONE and validated; shooting PAUSED after the first town because a person started using
the GTX-1070 box. Nothing is running now (shoot driver and idle watcher stopped, the hidden test Chrome on the 1070
closed, the person's own Chrome never touched). Resume = the commands in §4.

## 1. What the film is (owner brief, binding)
- A complete tour of Dereth's **surface towns**, cut to **one long public-domain classical recording**, 1920×1080 @ 24 fps.
- Excluded: the Underground City, Xarabydun, Kor-Gursha (Bur), Crater Lake Village, Martine's Retreat, Mar'uun, anything
  underground/in a dungeon — **one owner exception: an FPV corridor run in the Egg Orchard** (dungeon 0x002B), placed
  right after Eastwatch.
- Must have: a drone shot **under the Rithwic bridge**; a **Lytelthorpe fortress showcase**; **clouds on**; **varied times
  of day with the sun out**; shots built around **water, flames and particle effects**; **full use of the technique
  catalog**; facade **pans ≈ 10 %** of the runtime; JEV cost under the key's remaining limit (≈ $1.90 of $2).
- Owner decisions during the session: JEV only on the plan's **8 hero shots** ("go with original plan"); wait for the
  1070 to be idle before shooting; clouds must be on.

## 2. Where everything is
| What | Where |
|---|---|
| Live project (takes, music, reports) | `/mnt/wbterminal2/film-projects/dereth-town-tour/` (external drive, NOT in git) |
| Plan + research + song analysis/license + scripts (preserved copy) | `docs/film-projects/dereth-town-tour/` in this repo |
| Plan | `plan.json` — 273 shots, 57 sites (54 towns + Sanamar Royal Hall + Egg Orchard portal + Egg Orchard), 3431.75 s, 82,362 frames; validate 0 errors / 0 warnings |
| Timeline | regenerate: `node tools/film/film.mjs plan compile <project>/plan.json --out=<project>/timeline.json` |
| Music | `song/music.mp3` (live dir only, 57:12): Beethoven — Egmont Overture + Symphony No. 3 "Eroica", Czech National Symphony Orchestra (Musopen 2012). **Composition and recording public domain**; `song/LICENSE.txt` has every source URL and the courtesy credit line |
| Research | `research/town-*.json` (dossiers with verified coordinates), `roster.json`, `final-plan-build/` (deterministic plan builder), `critic-fixes.py` (**re-run after any `build.py` rebuild**, it is not inside build.py), `egg-orchard/` (route + floor renders) |
| Scripts | `scripts/shoot-driver.sh` (per-site, resumable, CDP/JEV-budget guards, `STOP_AFTER_SITES`), `scripts/wait-and-resume.sh` (idle watcher → relaunch → boot → one review site), `scripts/film-run.sh` (CLI wrapper that reads the film account password at run time from the repo script that owns it — never copy it) |
| Takes so far | `takes/holtburg.01-02.mp4` (fair weather); `takes/overcast/holtburg.01-05`, `glenden-wood.01-05` (first, stormy-sky run — superseded) |
| Taste reel | `edit/Dereth-Tour-taste-Holtburg-GlendenWood.mp4` (the 10 overcast takes over the opening of the music; also Taildropped to the Redmi) |
| JEV key | `~/.config/holtburger-film/openrouter.key` (mode 600; the owner's key, $2 limit, expires ≈ 2026-10-15). Spend so far ≈ $0.05 (Heroic Age example) + $0.0003 (tour) |

## 3. What happened (so the next session doesn't repeat it)
1. **Research workflow** (16 agents): roster (54 surface towns, exclusions with acpedia evidence), public-domain music,
   town dossiers built from acpedia + WorldBuilder.Terminal (`describe-landblock`, `list-objects`, `get-height`) with
   every shot dry-built against real terrain, deep dives for the Rithwic underpass (camera passes ≈ 9.5 m above the
   river, deck soffit ≈ 18.6 m), Lytelthorpe (7 fortress shots) and the Egg Orchard corridor (16-cell route
   0x002B0134 → 0x002B010C, 75 m, two right angles), plan synthesis, completeness critic (ok; it fixed a Sanamar sky
   jump and moved the Eroica-finale cut onto its downbeat).
2. **Plan numbers:** facade pans 7.3 % of runtime; all 54 outdoor techniques used (max 3.7 % of shots); times of day
   0.30–0.82 (sun up), grades matched; JEV on 8 hero shots (≈ 105 s ≈ $0.11 expected).
3. **Overcast problem → fixed in the CLI:** the server's DayGroup was a storm, so with clouds on the client drew the
   storm deck + 10× haze (coverage 0.55). `film boot` now defaults to `--weather=fair` (`cloudWeather=off`, frozen
   fair-weather clouds) and `--clouds=on`. **Still grey-ish at coverage 0.5** in the two fair-weather Holtburg takes —
   the resume script boots with `cloudCoverage=0.3` (more sun) and shoots ONE site for review first.
4. `holtburg.03` (facade pan) had `heightAGL 5.5` while its research said 2.6–3.8 m → fixed to 3.0 in `plan.json`.
5. **The 1070 is shared:** someone opened their own Chrome at 21:28 and our hidden test Chrome closed ≈ 45 s later
   (no crash dump — probably closed from the taskbar). The driver stopped itself (CDP guard); per owner choice we wait
   for idle. A first version of the idle watcher had a bash arithmetic bug and relaunched the test Chrome for ≈ 2 min
   (it never logged in); fixed, dry-run tested (`DRY_LINES=<file> scripts/wait-and-resume.sh`).
6. Lessons: `pgrep -f '<pattern>'` matches its own shell when the pattern is in the command line — use
   `ps -eo args | grep -c '^bash ./shoot-driver.sh$'`; a rejected tool call can still have executed its first half —
   verify files after a rejection; workflow resume-by-cache only replays an in-order prefix.

## 4. How to resume
Pre-flight (laptop): ACE up (`ss -ulpn | grep -E ':900[01]'`), serve.py :8765 and the ws bridge :8080 up, ≥ 2.5 GB free.
Check the 1070 is idle (read-only): lock screen, the person's Chrome closed, Roblox not active.

**Option A — automatic (waits for idle, shoots Holtburg, pauses for review):**
```bash
P=/mnt/wbterminal2/film-projects/dereth-town-tour
cd $P && node /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/tools/film/film.mjs plan compile plan.json --out=timeline.json
setsid nohup ./wait-and-resume.sh >> idle-watch.log 2>&1 < /dev/null &
tail -f idle-watch.log driver.log        # "REVIEW: first site shot" when Holtburg is done
```
**Option B — manual, now:**
```bash
ssh young@100.127.215.75 "schtasks /run /tn FilmCdp"     # hidden, muted test Chrome (C:\Temp\launch-wls.bat)
ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
$P/film-run.sh boot --assume-muted --quality=high --width=1920 --height=1080 \
  --base="http://127.0.0.1:8765/apps/holtburger-web/index.html?cloudCoverage=0.3"
# widen the off-screen window to 1920 (see wait-and-resume.sh), then:
cd $P && STOP_AFTER_SITES=1 setsid nohup ./shoot-driver.sh >> driver.log 2>&1 < /dev/null &
```
**Review, then the full run:** build a per-town contact sheet (4 frames × each shot) and look at it; if the sky/sun is
right, `cd $P && setsid nohup ./shoot-driver.sh >> driver.log 2>&1 < /dev/null &` (it skips sites that already have
reports; ≈ 2–3 min per town on the 1070 → roughly 2.5–3 h for all 57 sites). Re-shoot a bad shot by moving its
`takes/<id>.*` and `reports/<id>.json` aside and re-running its site. Check the Egg Orchard corridor and Fort Tethana
first (critic: rehearse-worthy).
**Assemble + share:** `node tools/film/film.mjs assemble $P/timeline.json --edl --capped` → `edit/final.mp4`; make a
phone copy (`ffmpeg -i final.mp4 -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 192k share.mp4`) and
`tailscale file cp share.mp4 redmi-note-13-5g:`. Credit line (courtesy) is in `song/LICENSE.txt`.

## 5. Code changes this session (committed with this handoff)
- `tools/film/lib/session.mjs`, `tools/film/film.mjs`: `film boot --clouds=on|off` (default on) and `--weather=fair|live`
  (default fair → `cloudWeather=off`); `tests/film_cli.test.mjs` covers both; `.claude/skills/film-mode/reference/1070.md`
  boot-URL table updated.
