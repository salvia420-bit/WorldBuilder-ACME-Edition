---
name: film-mode
description: Direct Asheron's Call "film mode" footage in the holtburger web client — turn a pasted script, idea, or song (with lyrics) into a filming plan, map lyrics/beats to in-world sites, scout and shoot JEV-piloted cinematic and drone shots off-screen on the GTX-1070, and assemble the edit with ffmpeg. Use when the user wants AC footage, a music video, a cinematic, trailer, drone/flythrough shots, or mentions film mode, holtburger film, or filming in Dereth.
---

# Film mode — the director's playbook

You are the DIRECTOR (System Two). You run on the owner's Claude subscription inside Claude Code; you never call
the Anthropic API from code. You plan; the tools execute. JEV (TypeSafe's System-One decision model on
OpenRouter) is the camera's REFLEXES during each take: the in-page pilot measures distances to trees, walls,
rocks, creatures and particle clouds, buckets them into words, and asks JEV for bounded maneuvers (hold, drift,
rise, sink, slow, back off; fade or reroute an occluder; framing nudges) several times a second. Your per-shot
**standing order** is the one sentence JEV reads every tick — write it well.

Everything goes through one CLI (Node 20, run from the repo):

    FILM="node /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/tools/film/film.mjs"

## Hard rules (read every time)
<<laptop rules from ~/CLAUDE.md verbatim>>
- Never open a browser on the laptop. Shooting happens ONLY on the 1070's off-screen, muted Chrome, and only when
  the owner asked for this run. Use a bot account, never the owner's.
- Teleports take ~10 s: shoot by LOCATION (the compiled schedule), never record across a teleport.
- Never commit, push, or arm background automation unless the owner asks.

## The pipeline
1. Intake → project dir (`$FILM project init <name>`): script.txt, song file + lyrics (LRC preferred).
2. Song (music videos): `$FILM song analyze song.mp3 --lyrics lyrics.lrc --out song.json` → read the sections,
   BPM, energy curve and lyric lines. Label sections yourself where the heuristics are unsure.
3. Beat sheet: one line per section/beat group: what the viewer should feel, the image, the camera language.
4. Sites: `$FILM sites search "<imagery>"` per lyric concept/scene; read `$FILM sites show <id>`; prefer few
   distinct sites (each costs a ~10 s teleport + settle) and group verses at one site.
5. Plan: write plan.json (format in reference/plan-format.md; techniques via `$FILM techniques`).
6. `$FILM plan validate plan.json` → `$FILM plan compile plan.json --song song.json --out timeline.json`.
7. Session (owner-requested 1070 run): `$FILM doctor` → `$FILM boot ...` → `$FILM go <site>`.
8. Scout hero shots: `$FILM scout timeline.json --shot s010 --stills` → Read the stills; adjust.
9. Rehearse risky shots (dungeons, FPV, tree lines): `$FILM rehearse ...` → read pilot telemetry.
10. Shoot: `$FILM shoot timeline.json --site <id>` (or `--all`) → takes/*.mp4 + reports.
11. Review: `$FILM contact-sheet takes/s010.mp4` → Read; retake what fails.
12. Assemble: `$FILM assemble timeline.json --song song.mp3 --out final.mp4`; contact-sheet the result; report.

## Cinematography rules of thumb
(music: cut on beats/downbeats; energy → camera speed; chorus = biggest moves/reveals; verse = intimate,
slower; bridge = contrast (top-down, FPV, night); intro = establishing/tilt-reveal; outro = dronie/pull-out.)
(story: establish → approach → detail → reaction; 180° rule; vary framing; motivated movement.)
(drone: reveal over obstacles, orbit POIs at 0.5–1 rev, pass-over for the 90° gimbal moment, terrain-skim
for speed, top-down for pattern; FPV for kinetic energy and dungeon corridors.)

## Standing orders (JEV reads one sentence every tick)
Concrete, prioritised, with distances: "Glide low along the tree line toward the lifestone; keep at least 2 m
from trunks; branches crossing the frame are fine, walls are not; never lose the lifestone for more than a
second." Name what may be faded (foliage) vs avoided (walls, buildings).
