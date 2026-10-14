# Music videos — song analysis, lyrics → sites, looks

Code: `tools/film/audio/` (`analyze.mjs` + `fft`, `features`, `onset`, `tempo`, `structure`, `lyrics`),
`tools/film/lib/decode_audio.mjs`, `tools/film/sites/{build,search,sources}.mjs`,
`tools/film/data/concept_lexicon.json`, `scene3d/film/runtime/look.js`.

## 1. Analyse the song

```bash
$FILM song analyze song/song.mp3 --lyrics=song/lyrics.lrc            # → song/song.json (next to the audio)
$FILM song analyze song/song.mp3 --lyrics=song/lyrics.txt --out=song/song.json
```

ffmpeg (`--ffmpeg`, `FILM_FFMPEG`, else `/home/wbterminal/bin/ffmpeg`) decodes to mono; the analysis is pure JS,
deterministic, ≈ 1 s per minute of audio, at 22050 Hz. A `.lrc` file is read as LRC; any other file is
auto-detected (LRC or plain text). Exit 2 = ffmpeg missing; exit 1 = decode failed.

**SongAnalysis v1** (`song.json`; times in seconds, energies 0…1):

| Field | Meaning |
|---|---|
| `durationSec`, `sampleRate` (22050), `sourceSampleRate` | |
| `tempo: {bpm, confidence}` | global tempo and how sure the tracker is (0…1) |
| `beats: [s]`, `downbeats: [s]` | the beat grid the compiler cuts on |
| `bars: [{i, start, end}]` | bars (4/4); `{bars}` durations and `start:{bar}` index these |
| `sections: [{i, start, end, startBar, endBar (exclusive), label, role, energy, repeatOf}]` | structure; `start:{section: i}` |
| `energy: {hopSec: 0.5, values: [0…1]}` | loudness curve every 0.5 s |
| `lyrics?: {format: "lrc"\|"plain", lines: [{t?, text, section?, stanza?, hint?}]}` | each line aligned to a section |

The CLI prints a summary you can read directly:

```
duration 3:41.2 · 128.0 BPM (confidence 0.83) · 472 beats · 118 bars · 9 sections
#0 0:00.0–0:15.0 bars 0–7 A intro energy 0.31
#1 0:15.0–0:45.0 bars 8–23 B verse energy 0.52  “the lanterns burn along the ember road”
#2 0:45.0–1:00.0 bars 24–31 C chorus energy 0.81  “carry me over”
#3 1:00.0–1:30.0 bars 32–47 B verse energy 0.55 (= #1)  “…”
…
lyrics (lrc): 38 line(s)
  #1 verse (6): “the lanterns burn …” / “…” / “…” …
```

(illustrative numbers; the format is `#i start–end bars a–b LABEL role energy E (= #first)  “first lyric”`.)

## 2. How to read it

- **Labels** A, B, C… are assigned by first appearance; `repeatOf` points at the first section with the same label
  (a repeat of the music, not necessarily the words).
- **Roles** are heuristics (`structure.mjs assignRoles`): `chorus` = the repeated label with the best count × energy
  rank (sung at least once when the lyrics are timed); `prechorus` = a short (≤ 8 bars) repeated label that sits
  between a verse and the chorus; `verse` = the repeated label that most often leads into the chorus;
  `instrumental` = a repeated section with no timed lyric inside; `bridge` = a one-off section in the second half
  that is neither first nor last; `intro`/`outro` = the first/last section when it is a one-off, quiet or fading;
  everything else `unknown`. You can overrule them — write your beat sheet from what you hear in the lyrics too.
- **Energy** (section mean, 0…1): map it to camera speed and scale. Low → static, slow dolly, push-in, rack focus;
  mid → arc, steadicam, orbit at ¼ revolution, parallax-slide; high → pass-over, terrain-skim, fly-by, fpv-dive,
  canyon-run, full orbits.
- **Tempo**: cuts land on `beats` (and bars on `downbeats`). Check that `bars × bar length ≈ duration` and that the
  BPM matches the feel; if the grid is off (low `confidence`, half/double time), use `{sec}` durations or
  `start:{sec}` around that passage — `{sec}` still snaps to the nearest beat when a song is given. A `{bars}` shot
  that starts on a downbeat, or within half a beat of one, counts from that downbeat. So `song.offsetSec` copied
  from the one-decimal section times `song analyze` prints still cuts on the intended bar lines. A shot that starts
  more than half a beat before the first downbeat (the pickup at edit 0 when the song's `bars[0]` is more than half a
  beat after it) counts its bars from that downbeat, so the pickup joins it and every following `{bars}` cut stays on
  a bar line.
  The same holds when `song.offsetSec` puts edit 0 more than half a beat inside a bar. A shot that starts mid-bar
  after a `{beats}`/`{sec}` shot keeps its length and cuts on the nearest beat.
- **Lyrics**: LRC lines carry `t` and land in the section containing their time. Plain lyrics are stanzas mapped
  onto sections in order (repeated stanzas onto repeated labels; `[Chorus]`-style headers become `hint`s). The
  `section` index of a line is what you write into `start:{section}` and `lyric`.

Beat-sheet rhythm that works: one shot per 2–4 bars in verses, 1–2 bars in choruses, change site or scale at each
section start (`start:{section: i}` on the first shot of the section), and give every repeat of the chorus a
different angle of the same idea.

## 3. Lyric imagery → concept → site

`$FILM sites search "<words>"` ranks sites from the offline gazetteer
(`/mnt/wbterminal2/film-projects/_gazetteer/film_gazetteer.jsonl`, built once with `$FILM sites build`; `--spawns`
adds life stones, portals, statues and shrines from the ACE spawn dump). Query words expand through
`tools/film/data/concept_lexicon.json` — 73 concepts, each `{words, terrain, biome, tags, kinds, look,
techniques}` — so "lonely snowy mountain at dawn" also searches snow/ice/frozen terrain, mountain features and the
kinds those concepts prefer. Scoring is BM25F over name, aliases, kind, region, culture, biome, terrain, tags/notes
and lore, plus a boost for preferred kinds.

Concepts: ocean, shore, river, lake, waterfall, rain, storm, lightning, snow, winter, ice, desert, sun, forest,
mountain, hills, valley, cave, darkness, abyss, fire, volcano, hell, light, dawn, night, sunset, city, home, alone,
ruins, tower, castle, king, temple, grave, ghost, war, magic, portal, bridge, road, island, swamp, garden, falling,
flying, prison, treasure, love, rage, peace, mist, crystal, statue, ship, wind, shadow, maze, door, mirror, sadness,
joy, time, speed, dream, cliff, horizon, swarm, farm, monster, market, desolation.

```bash
$FILM sites search "snow on the mountain at dawn" --limit=10
$FILM sites search "dark halls below the town" --kind=dungeon --indoor
$FILM sites search "market square" --near=42.1,33.6,5          # ns, ew (map degrees, N/E positive), radius km
$FILM sites show town-holtburg                                    # paragraph, words, `film go …`, readiness landblocks
```

Each result line: `score  id  kind  name (ns N ew E) — why`; the last line lists the matched concepts with their
suggested `look` and `techniques` — a ready-made starting point for the shot. `sites show` prints the site's
teleport (`teleport.best`: `@telepoi` for ACE points of interest, an exact `@teleloc` for dungeons and known
positions, else `@tele <ns> <ew>`) — copy it into `sites[].teleport`, and the cell + local position into
`sites[].anchor` as `{cell, local}`. Site kinds: town, dungeon, poi, landmark, region, wilderness (wilderness
representatives are named like "Snowy highlands near Kryst"). The 2021 acpedia lore in the gazetteer is approved
background (owner decision).

Pick few sites: each one costs a teleport (≈ 10 s, estimated at 12 s + 5 s settle) and a readiness wait. Reuse a
site for every section that shares its mood; repeated choruses can return to the same site from a new angle.

## 4. Looks (`look` on defaults / site / shot)

| Key | Values | Effect (runtime/look.js) |
|---|---|---|
| `timeOfDay` | `night` 0.0 · `dawn` 0.21 · `morning` 0.33 · `noon` 0.5 · `golden` 0.82 · `dusk` 0.89, or 0…1 | `setSkyTimeOverride`; terrain re-lit at once |
| `dayGroup` | `{day, year}` | the AC weather/sky set (`setGameDayOverride`) |
| `fog` | `none` · `white` · `red` · `blue` · `green` · `black` | AdminEnvirons fog presets (white 0–30 m; black = dark fog with bright ambient). The retail fog rolls in over ≈ 20 s: the first take after a fog change waits for it (≤ 30 s) before recording, and a fog that changes between shots at one site pays that wait on every change — keep one fog per site where possible. Check `environ.settled` in the take report (`page.environ` in `reports/<shot>.json`) |
| `exposure` | 0 < x ≤ 16 | tone-map exposure |
| `grade` | `neutral` · `warm` (golden, lifted reds) · `cool` (steel blue) · `bleach` (bleach bypass: low saturation, hard contrast) · `night` (day-for-night: blue cast, crushed, desaturated) | colour grade (day and night sets) |
| `bloom` | number or `{intensity, threshold}` | only at quality ≥ mid |
| `vignette` | number or `{darkness, offset}` | only at quality ≥ high |
| `dof` | `{focusDistance, focusRange, bokehScale, enabled?}` | depth of field via `window.__dof` (needs `?filmDof=on` — the CLI boot always adds it). `classic.rack-focus` drives `focusDistance` from its focus channel every frame; `look.dof` sets range and bokeh. Defaults: focus 10 m, range 5, bokeh 1. Enabling recompiles one shader once (toggle between shots, never per frame). |

Mood presets (the lexicon's suggestions follow the same vocabulary):

| Mood | Look |
|---|---|
| warm nostalgia, home, love | `{timeOfDay: "golden", grade: "warm"}` |
| cold, lonely, winter | `{timeOfDay: "morning", fog: "white", grade: "cool"}` |
| dread, horror, dungeon | `{grade: "cool"}` indoors; outdoors `{timeOfDay: "night", fog: "black", grade: "night"}` |
| war, rage | `{timeOfDay: "dusk", fog: "red", grade: "bleach"}` |
| dream, magic | `{timeOfDay: "dawn", fog: "blue", grade: "cool"}` + shallow `dof` |
| intimate verse close-up | `{dof: {focusRange: 3, bokehScale: 2}}` with `classic.rack-focus` or a CU |

Merge order is `defaults.look` ← `sites[].look` ← `shots[].look` (shallow, later wins), and each take applies its
whole merged look — keys a previous take set and this one omits return to the boot values. Time-lapse techniques
(`classic.time-lapse`, `classic.hyperlapse`, `drone.hyperlapse-orbit`) advance the sky clock themselves: the classic
ones by `rate` game-days per film second (default 0.02 ≈ 29 game-minutes), `drone.hyperlapse-orbit` by `timeRate`
seconds of the live sky clock per film second (one Dereth day = 7620 s; default 150 ≈ 0.02 game-days ≈ 28
game-minutes per film second).

Caveat (DoF): the boot URL does not set `clouds=on`, so DoF runs in the legacy single post pass, where a fully
defocused far background is blurred before the aerial perspective (it can look un-hazed). In-focus pixels are exact.
