# AC retail Font records — inventory (2026-05-24)

49 Font records (DAT type `0x40`) live in `client_portal.dat`. Two
are wired in `holtburger-web` HUD today:

- `0x40000000` — UI body font (16×16, 1050 chars)
- `0x4000001C` — UI compact font (10×12, 1050 chars)

The remaining 47 are unused. This doc is a picker for which to
wire next: heading, chat-window, scrolling battle text, spell-effect
labels, Asian-language fallback, etc.

## Probe method

`/mnt/wbterminal1/tmp/claude-scratch/font-inventory/probe.sh` runs
`dat-tool export` for each `0x40……` record, then `od -An -tu4 -N16`
reads the four header u32s (id, max_char_height, max_char_width,
num_char_descs) per `crates/holtburger-dat/src/file_type/font.rs`.

Every record's `36 + 11 * num_char_descs` predicted size matches the
on-disk size exactly — header parse is sound.

## Family table (grouped by char-count, then by record-size)

| Family | n_chars | Records | Use hypothesis |
|---|---:|---:|---|
| **Tiny display** | 210 | 10 | Specialty Latin-only — score popups, damage numbers? |
| **Body UI** | 1050 | 8 | Standard UI font (incl. 0x40000000 + 0x4000001C) |
| **Mid Latin-extended** | 1258 | 7 | Chat / journal / extended UI |
| **Mid alt** | 1419 | 10 | Likely alternate-style mid charset |
| **Heading / bold** | 1912 | 9 | Per handoff hint — heading/title variants |
| **CJK** | 20609 | 5 | Asian-language fallback (Japanese / Chinese / Korean) |

## Per-record table (47 candidates)

Sorted by char family, then ascending cell height (`max_h × max_w`).

### Body UI (1050 chars) — same family as 0x40000000

| ID | Bytes | Cell (h×w) | Status |
|---|---:|---|---|
| 0x4000001C | 11586 | 10×12 | **In use (compact)** |
| 0x40000025 | 11586 | 11×13 | unused |
| 0x40000000 | 11586 | 16×16 | **In use (UI body)** |
| 0x40000001 | 11586 | 16×16 | unused |
| 0x40000002 | 11586 | 16×16 | unused |
| 0x40000004 | 11586 | 16×16 | unused (cell dim same as 0x40000000) |
| 0x40000005 | 11586 | 16×16 | unused |
| 0x40000006 | 11586 | 16×16 | unused |

The 6 unused 16×16 records (0x40000001–6) are most plausibly
weight/style variants (regular/bold/italic) sharing the same metrics
as 0x40000000. Worth previewing in-game before picking one for chat
versus heading.

### Mid Latin-extended (1258 chars)

| ID | Bytes | Cell (h×w) |
|---|---:|---|
| 0x4000001D | 13874 | 12×7  |
| 0x4000001E | 13874 | 14×8  |
| 0x4000001A | 13874 | 16×9  |
| 0x4000001F | 13874 | 18×11 |
| 0x40000030 | 13874 | 20×11 |
| 0x40000031 | 13874 | 22×13 |
| 0x40000020 | 13874 | 24×14 |

Narrow aspect ratio (height ≈ 2× width). Possibly fixed-width
monospaced or condensed serif. Candidate for scrolling battle text.

### Mid alt (1419 chars)

| ID | Bytes | Cell (h×w) |
|---|---:|---|
| 0x40000026 | 15645 | 14×12 |
| 0x4000002A | 15645 | 14×13 |
| 0x40000027 | 15645 | 16×15 |
| 0x4000002B | 15645 | 16×16 |
| 0x40000032 | 15645 | 17×17 |
| 0x40000028 | 15645 | 18×18 |
| 0x4000002C | 15645 | 20×20 |
| 0x4000002E | 15645 | 21×20 |
| 0x4000002D | 15645 | 22×22 |
| 0x4000002F | 15645 | 23×22 |

Near-square cells across the entire size ladder. Most likely the
canonical body/heading family — pick a small one (14×12, 16×15) for
chat-window dialogue, larger (20×20+) for headings.

### Heading / bold (1912 chars) — handoff hint at 0x40000007–18

| ID | Bytes | Cell (h×w) |
|---|---:|---|
| 0x40000007 | 21068 | 14×16 |
| 0x40000008 | 21068 | 14×15 |
| 0x40000009 | 21068 | 16×18 |
| 0x40000019 | 21068 | 21×22 |
| 0x4000000A | 21068 | 18×19 |
| 0x4000000B | 21068 | 20×21 |
| 0x4000000C | 21068 | 22×23 |
| 0x4000000D | 21068 | 24×26 |
| 0x4000001B | 21068 | 36×38 |

Largest single ladder. Spans tiny (14×16) to huge (36×38).
The handoff's "21×22 cell, 1912 glyphs" hint maps to 0x40000019.

### Tiny display (210 chars) — Latin only

| ID | Bytes | Cell (h×w) |
|---|---:|---|
| 0x40000016 | 2346 | 18×20 |
| 0x40000015 | 2346 | 20×23 |
| 0x4000000E | 2346 | 24×27 |
| 0x4000000F | 2346 | 30×34 |
| 0x40000010 | 2346 | 36×39 |
| 0x40000011 | 2346 | 38×42 |
| 0x40000012 | 2346 | 40×43 |
| 0x40000024 | 2346 | 42×46 |
| 0x40000013 | 2346 | 46×50 |
| 0x40000014 | 2346 | 48×53 |

210-char count rules out CJK or extended punctuation. Plausibly
floating damage numbers, level-up callouts, or in-world signage
where the size ladder makes sense for zoom-fading.

### CJK (20609 chars)

| ID | Bytes | Cell (h×w) |
|---|---:|---|
| 0x40000021 | 226735 | 12×12 |
| 0x40000017 | 226735 | 14×14 |
| 0x40000022 | 226735 | 16×18 |
| 0x40000018 | 226735 | 18×20 |
| 0x40000023 | 226735 | 24×26 |

Five sizes of the full CJK glyph set. Wire one of these as a
fallback for when a chat message contains non-Latin codepoints; the
current implementation just drops them.

## Picking next fonts to wire

**Chat window** — `0x40000027` (16×15, 1419 chars) or `0x4000002B`
(16×16, 1419 chars). Same height as the body font but with the
extended punctuation/symbol set that real chat will hit. Lazy-load
on first chat-line render or batch into `boot.hba`.

**Heading / panel titles** — `0x40000019` (21×22, 1912 chars). The
handoff's call-out — a true bold/heading face at a comfortable size.

**Scrolling battle text** — `0x40000031` (22×13, 1258 chars).
Narrow + tall = readable at a glance for damage tickers.

**Score / damage popups in 3D** — `0x4000000F` (30×34) or
`0x40000010` (36×39). Display-only 210-char set is fine for "+100".

**Asian fallback** — `0x40000017` (14×14, 20609 chars). Smallest
of the CJK set, matches body-font weight. Lazy-load only when a
chat line has high-codepoint chars.

## Wiring pattern

Per `apps/holtburger-web/src/lib.rs:5077`, `fetch_font(font_id)`
already handles any ID — no parser change required. JS-side:

```js
import { loadAcFont, setAcText, getAcFont } from "../ui/ac_font.js";

const CHAT_FONT_ID = 0x40000027;
await loadAcFont(CHAT_FONT_ID);   // lazy-load on first need
setAcText(el, line, { fontId: CHAT_FONT_ID, color: "#…" });
```

For boot inlining, add the ID to `BOOT_ESSENTIAL_PORTAL_IDS` in
`apps/holtburger-tools/src/dat_shard.rs` and re-bake.

## Raw artifacts

- CSV: `/mnt/wbterminal1/tmp/claude-scratch/font-inventory/font-inventory.csv`
- Per-record bins: `/mnt/wbterminal1/tmp/claude-scratch/font-inventory/raw/font_*.bin`
- Probe script: `/mnt/wbterminal1/tmp/claude-scratch/font-inventory/probe.sh`
