// tests/film_audio_lyrics.test.mjs — film mode song analyser: LRC + plain-lyrics parsing and lyric→section alignment.
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) lets the director cut a music video on the words
// ("the camera rises on 'hold the line'"), so `film.mjs song analyze --lyrics` must read LRC files exactly (multiple
// stamps, [mm:ss:xx], [offset:], metadata, enhanced word stamps) and map plain stanzas onto the analysed sections in
// order, with identical (chorus) stanzas on sections that share a label. Runs the REAL tools/film/audio/lyrics.mjs
// (and analyzeSong for the plumbing) on hand-made analyses and a short synthetic click track — no files, no network.
//
// Run from apps/holtburger-web/: node tests/film_audio_lyrics.test.mjs

import assert from "node:assert/strict";
import {
  alignLyrics,
  assignStanzas,
  detectLyricsFormat,
  groupStanzas,
  parseLrc,
  parseLrcDocument,
  parseLrcTimestamp,
  parseLyricHeader,
  parsePlainLyrics,
  sectionAt,
  sectionHintRole,
  stanzaSimilarity,
  timedLyricLines,
} from "../tools/film/audio/lyrics.mjs";
import { analyzeSong } from "../tools/film/audio/analyze.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message : e}`);
  }
}

console.log("film_audio_lyrics: LRC");

check("time tags: [mm:ss], .x, .xx, .xxx and [mm:ss:xx] all parse; minutes may exceed 59", () => {
  assert.equal(parseLrcTimestamp("01:02"), 62);
  assert.equal(parseLrcTimestamp("01:02.5"), 62.5);
  assert.equal(parseLrcTimestamp("01:02.50"), 62.5);
  assert.equal(parseLrcTimestamp("01:02.500"), 62.5);
  assert.equal(parseLrcTimestamp("01:02:50"), 62.5);
  assert.equal(parseLrcTimestamp("75:00.00"), 4500);
  assert.equal(parseLrcTimestamp("ar:Someone"), null);
  assert.equal(parseLrcTimestamp("Chorus"), null);
});

check("basic lines, sorted by time, text trimmed", () => {
  const lines = parseLrc("[00:12.34]  Hello there  \n[00:05.00]First line\n[00:30.10]Last");
  assert.deepEqual(lines, [
    { t: 5, text: "First line" },
    { t: 12.34, text: "Hello there" },
    { t: 30.1, text: "Last" },
  ]);
});

check("several stamps on one line give one entry each (and sort among the others)", () => {
  const lines = parseLrc("[00:10.00][01:10.00][02:10.00]Hold the line\n[00:40.00]Verse two");
  assert.deepEqual(
    lines.map((l) => [l.t, l.text]),
    [
      [10, "Hold the line"],
      [40, "Verse two"],
      [70, "Hold the line"],
      [130, "Hold the line"],
    ],
  );
});

check("[offset:+ms] makes lyrics earlier, [offset:-ms] later; clamped at 0", () => {
  assert.deepEqual(parseLrc("[offset:+500]\n[00:10.00]a\n[00:00.20]b").map((l) => l.t), [0, 9.5]);
  assert.deepEqual(parseLrc("[offset:-250]\n[00:10.00]a").map((l) => l.t), [10.25]);
  assert.deepEqual(parseLrc("[offset: +1000 ]\n[00:10.00]a").map((l) => l.t), [9]);
  assert.equal(parseLrcDocument("[offset:-250]\n[00:10.00]a").offsetMs, -250);
});

check("metadata tags are collected, never produce lines; untimed lines ignored", () => {
  const doc = parseLrcDocument("[ti:Song Title]\n[ar:Artist]\n[al:Album]\n[by:me]\n[length: 03:20]\n[re:tool]\n[ve:1.0]\n[Chorus]\nplain text\n[00:01.00]sung");
  assert.deepEqual(doc.lines, [{ t: 1, text: "sung" }]);
  assert.equal(doc.meta.ti, "Song Title");
  assert.equal(doc.meta.ar, "Artist");
  assert.equal(doc.meta.length, "03:20");
  assert.equal(doc.offsetMs, 0);
});

check("enhanced-LRC word stamps are stripped; brackets inside lyric text survive", () => {
  const lines = parseLrc("[00:12.00]<00:12.00>Hold <00:12.40>the <00:12.80>line\n[00:20.00]I said [yeah] twice");
  assert.equal(lines[0].text, "Hold the line");
  assert.equal(lines[1].text, "I said [yeah] twice");
});

check("BOM + CRLF input; empty timed line kept as a vocal gap; equal times keep input order", () => {
  const lines = parseLrc("﻿[00:01.00]one\r\n[00:02.00]\r\n[00:03.00]x\r\n[00:03.00]y\r\n");
  assert.deepEqual(lines, [
    { t: 1, text: "one" },
    { t: 2, text: "" },
    { t: 3, text: "x" },
    { t: 3, text: "y" },
  ]);
  assert.deepEqual(timedLyricLines({ text: "[00:01.00]one\n[00:02.00]\n", format: "lrc" }), [{ t: 1, text: "one" }]);
  assert.equal(timedLyricLines({ text: "one\ntwo", format: "plain" }), null);
  assert.equal(timedLyricLines(null), null);
});

check("format detection: any leading time tag → lrc, else plain", () => {
  assert.equal(detectLyricsFormat("[ar:x]\n[00:01.00]hi"), "lrc");
  assert.equal(detectLyricsFormat("[Chorus]\nhi there"), "plain");
  assert.equal(detectLyricsFormat(""), "plain");
});

console.log("film_audio_lyrics: plain stanzas");

check("stanzas split on blank lines (whitespace-only and repeated blanks too), CRLF ok", () => {
  const st = parsePlainLyrics("a one\na two\r\n\r\n   \n\nb one\n\tb two  \n\n\n");
  assert.deepEqual(st, [{ lines: ["a one", "a two"] }, { lines: ["b one", "b two"] }]);
});

check("[Chorus] / [Verse 2] / [Verse 1: Artist] / (Chorus) / Chorus: / bare 'Pre-Chorus' headers become hints", () => {
  const st = parsePlainLyrics(
    "[Verse 1: Somebody]\nv1\n\n[Chorus]\nc\n\n(Chorus)\nc\n\nChorus:\nc\n\nPre-Chorus\np\n\n[Verse 2]\nv2\n\n[Guitar Solo]\nla la",
  );
  assert.deepEqual(
    st.map((s) => [s.hint, s.hintRole, s.lines.join("|")]),
    [
      ["Verse 1: Somebody", "verse", "v1"],
      ["Chorus", "chorus", "c"],
      ["Chorus", "chorus", "c"],
      ["Chorus", "chorus", "c"],
      ["Pre-Chorus", "prechorus", "p"],
      ["Verse 2", "verse", "v2"],
      ["Guitar Solo", "instrumental", "la la"],
    ],
  );
});

check("a parenthesised lyric '(oh yeah)' stays a lyric line", () => {
  const st = parsePlainLyrics("(oh yeah)\nwe go on\n(oh yeah)");
  assert.deepEqual(st, [{ lines: ["(oh yeah)", "we go on", "(oh yeah)"] }]);
  assert.equal(parseLyricHeader("(oh yeah)"), null);
  assert.equal(parseLyricHeader("(Chorus)"), "Chorus");
  assert.equal(parseLyricHeader("Verse 2"), "Verse 2");
  assert.equal(parseLyricHeader("Verse two of my life"), null);
});

check("a header in the middle of a block starts a new stanza", () => {
  const st = parsePlainLyrics("v line 1\nv line 2\n[Chorus]\nc line 1\nc line 2");
  assert.deepEqual(st, [{ lines: ["v line 1", "v line 2"] }, { lines: ["c line 1", "c line 2"], hint: "Chorus", hintRole: "chorus" }]);
});

check("a header-only block attaches to the next unheaded block", () => {
  const st = parsePlainLyrics("[Bridge]\n\nfar away\nso far");
  assert.deepEqual(st, [{ lines: ["far away", "so far"], hint: "Bridge", hintRole: "bridge" }]);
});

check("a header-only repeat reference copies the earlier stanza (repeat: true); unknown references drop", () => {
  const st = parsePlainLyrics("[Chorus]\nhold the line\nall is fine\n\n[Verse 2]\nnew words\n\n[Chorus]\n\n[Outro]");
  assert.equal(st.length, 3, "the [Outro] reference has no source and is dropped");
  assert.deepEqual(st[2], { lines: ["hold the line", "all is fine"], hint: "Chorus", hintRole: "chorus", repeat: true });
  // "[Hook]" (chorus role, different hint) repeats the latest chorus-role stanza
  const st2 = parsePlainLyrics("[Chorus]\nhold the line\n\n[Verse 2]\nx\n\n[Hook]\n\n[Bridge]\ny");
  assert.deepEqual(st2.map((s) => s.lines[0]), ["hold the line", "x", "hold the line", "y"]);
});

check("hint → role vocabulary", () => {
  const cases = {
    Intro: "intro",
    "Verse 3": "verse",
    "Pre-Chorus": "prechorus",
    "Pre Chorus 2": "prechorus",
    Chorus: "chorus",
    Refrain: "chorus",
    Hook: "chorus",
    "Post-Chorus": null,
    Bridge: "bridge",
    "Middle 8": "bridge",
    "Guitar Solo": "instrumental",
    Interlude: "instrumental",
    Outro: "outro",
    Coda: "outro",
    "Chorus: Artist & Guest": "chorus",
    Something: null,
  };
  for (const [h, want] of Object.entries(cases)) assert.equal(sectionHintRole(h), want, h);
});

check("stanza similarity and grouping: case/punctuation-insensitive, ≥ 60 % shared lines, chorus hints group", () => {
  assert.equal(stanzaSimilarity(["Hold the line!", "It's fine"], ["hold the line", "its fine."]), 1);
  assert.equal(stanzaSimilarity(["a", "b", "c", "d"], ["a", "b", "c", "e"]), 0.6);
  const st = [
    { lines: ["v1 a", "v1 b"] },
    { lines: ["c a", "c b", "c c", "c d"] },
    { lines: ["v2 a", "v2 b"] },
    { lines: ["c a", "c b", "c c", "c CHANGED"] },
    { lines: ["totally", "different"], hint: "Chorus", hintRole: "chorus" },
    { lines: ["other", "words"], hint: "Chorus 2", hintRole: "chorus" },
  ];
  assert.deepEqual(groupStanzas(st), [0, 1, 2, 1, 3, 3]);
});

console.log("film_audio_lyrics: alignment");

/** Hand-made analysis: [label, role, bars] at 2 s per bar. */
function analysis(spec) {
  let bar = 0;
  const sections = spec.map(([label, role, bars], i) => {
    const s = { i, start: bar * 2, end: (bar + bars) * 2, startBar: bar, endBar: bar + bars, label, role, energy: 0.5, repeatOf: null };
    bar += bars;
    return s;
  });
  return { durationSec: bar * 2, sections };
}
const SONG = analysis([
  ["A", "intro", 4],
  ["B", "verse", 8],
  ["C", "chorus", 8],
  ["B", "verse", 8],
  ["C", "chorus", 8],
  ["D", "bridge", 8],
  ["C", "chorus", 8],
  ["E", "outro", 4],
]);
const V1 = "Walking down the empty road\nCarrying a heavy load";
const V2 = "Morning comes without a sound\nNothing lost and nothing found";
const CH = "Hold the line, hold the line\nEverything will be fine";
const BR = "Somewhere far away\nI hear the echoes stay";

/** stanza index → section index for a plain alignment. */
function stanzaSections(a, text) {
  const r = alignLyrics(a, { text, format: "plain" });
  assert.equal(r.format, "plain");
  const out = [];
  for (const l of r.lines) out[l.stanza] = l.section;
  return out;
}

check("LRC alignment by time: start-inclusive sections, the last section owns the end, far-past lines unassigned", () => {
  const lrc = "[00:00.50]intro talk\n[00:08.00]verse starts exactly here\n[00:23.99]still verse\n[00:24.00]chorus\n[01:52.00]at the very end\n[02:30.00]way past";
  const r = alignLyrics(SONG, { text: lrc });
  assert.equal(r.format, "lrc");
  assert.deepEqual(
    r.lines.map((l) => l.section),
    [0, 1, 1, 2, 7, undefined],
  );
  assert.equal(r.lines[5].t, 150);
  assert.equal(sectionAt(SONG.sections, 112.4, 112), 7);
  assert.equal(sectionAt(SONG.sections, 113, 112), -1);
});

check("plain with headers: verse, chorus, verse, chorus, bridge, chorus map onto sections 1..6 in order", () => {
  const text = `[Verse 1]\n${V1}\n\n[Chorus]\n${CH}\n\n[Verse 2]\n${V2}\n\n[Chorus]\n${CH}\n\n[Bridge]\n${BR}\n\n[Chorus]\n${CH}`;
  assert.deepEqual(stanzaSections(SONG, text), [1, 2, 3, 4, 5, 6]);
  const r = alignLyrics(SONG, { text, format: "plain" });
  assert.equal(r.lines[0].hint, "Verse 1");
  assert.equal(r.lines[0].t, undefined);
  assert.equal(r.lines.length, 12);
});

check("plain without headers: the identical chorus stanza lands on the three same-label (C) sections", () => {
  const text = `${V1}\n\n${CH}\n\n${V2}\n\n${CH}\n\n${BR}\n\n${CH}`;
  const map = stanzaSections(SONG, text);
  assert.deepEqual(map, [1, 2, 3, 4, 5, 6]);
  const labels = [1, 3, 5].map((k) => SONG.sections[map[k]].label);
  assert.deepEqual(labels, ["C", "C", "C"]);
});

check("plain with a missing bridge stanza: the bridge section stays empty, the last chorus still hits C", () => {
  assert.deepEqual(stanzaSections(SONG, `${V1}\n\n${CH}\n\n${V2}\n\n${CH}\n\n${CH}`), [1, 2, 3, 4, 6]);
});

check("plain with '[Chorus]' repeat references aligns like the written-out text", () => {
  const text = `[Verse 1]\n${V1}\n\n[Chorus]\n${CH}\n\n[Verse 2]\n${V2}\n\n[Chorus]\n\n[Bridge]\n${BR}\n\n[Chorus]`;
  assert.deepEqual(stanzaSections(SONG, text), [1, 2, 3, 4, 5, 6]);
});

check("plain with more stanzas than sections: two verse stanzas share a verse, a repeated verse text keeps label B", () => {
  const text = `${V1}\n\n${V2}\n\n${CH}\n\n${V1}\n\n${CH}\n\n${BR}\n\n${CH}\n\n${CH}`;
  const map = stanzaSections(SONG, text);
  assert.deepEqual(map, [1, 1, 2, 3, 4, 5, 6, 6]);
  assert.equal(SONG.sections[map[0]].label, SONG.sections[map[3]].label);
});

check("plain with unknown roles: label repetition alone binds the repeated stanza to the repeated label", () => {
  const a = analysis([
    ["A", "unknown", 8],
    ["B", "unknown", 8],
    ["A", "unknown", 8],
    ["B", "unknown", 8],
    ["C", "unknown", 8],
    ["B", "unknown", 8],
  ]);
  const text = `${V1}\n\n${CH}\n\n${V2}\n\n${CH}\n\n${BR}\n\n${CH}`;
  const res = assignStanzas(parsePlainLyrics(text), a.sections);
  assert.deepEqual(res.assignment, [0, 1, 2, 3, 4, 5]);
  assert.equal(res.binding["1"], "B");
});

check("degenerate inputs: no sections → lines without section; empty lyrics → no lines", () => {
  const r = alignLyrics({ durationSec: 10, sections: [] }, { text: `${V1}\n\n${CH}`, format: "plain" });
  assert.equal(r.lines.length, 4);
  assert.ok(r.lines.every((l) => l.section === undefined));
  assert.deepEqual(alignLyrics(SONG, { text: "", format: "plain" }).lines, []);
  assert.deepEqual(alignLyrics(SONG, { text: "[ar:x]\n", format: "lrc" }).lines, []);
});

check("pathological lyrics (12 repeated stanza groups × 10 repeated labels) align quickly", () => {
  const stanzas = [];
  for (let k = 0; k < 36; k++) stanzas.push({ lines: [`la ${k % 12}`, `la la ${k % 12}`] });
  const a = analysis(Array.from({ length: 30 }, (_, k) => [String.fromCharCode(65 + (k % 10)), "unknown", 4]));
  const t0 = performance.now();
  const res = assignStanzas(stanzas, a.sections);
  const ms = performance.now() - t0;
  assert.equal(res.assignment.length, 36);
  for (let k = 1; k < 36; k++) assert.ok(res.assignment[k] >= res.assignment[k - 1], "monotone");
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

console.log("film_audio_lyrics: analyzeSong plumbing");

check("analyzeSong attaches aligned lyrics (format auto-detected) and stays deterministic", () => {
  const SR = 22050;
  const x = new Float32Array(SR * 24);
  for (let t = 0.25; t < 23.5; t += 0.5) {
    const s0 = Math.round(t * SR);
    const accent = Math.round((t - 0.25) / 0.5) % 4 === 0 ? 1 : 0.5;
    for (let i = 0; i < 900; i++) x[s0 + i] += accent * Math.exp(-i / 260) * Math.sin(i * 0.29);
  }
  const lrc = "[00:01.00]first\n[00:09.00]second\n[00:17.00]third";
  const a = analyzeSong(x, SR, { lyrics: { text: lrc } });
  assert.equal(a.lyrics.format, "lrc");
  assert.deepEqual(a.lyrics.lines.map((l) => l.text), ["first", "second", "third"]);
  for (const l of a.lyrics.lines) {
    const s = a.sections[l.section];
    assert.ok(s && l.t >= s.start && l.t < s.end + 1e-9, `line at ${l.t} → section ${l.section}`);
  }
  const p = analyzeSong(x, SR, { lyrics: { text: `${V1}\n\n${CH}`, format: "plain" } });
  assert.equal(p.lyrics.format, "plain");
  assert.equal(p.lyrics.lines.length, 4);
  assert.ok(p.lyrics.lines.every((l) => Number.isInteger(l.section) && l.section < p.sections.length));
  assert.equal(JSON.stringify(analyzeSong(x, SR, { lyrics: { text: lrc } })), JSON.stringify(a));
});

console.log(`film_audio_lyrics: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
