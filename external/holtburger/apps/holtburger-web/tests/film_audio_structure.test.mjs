// tests/film_audio_structure.test.mjs — film mode song analyser: sections (boundaries, repeat labels, roles), the
// analyzeSong pipeline end to end, and the ffmpeg decoder (with a fake ffmpeg child process).
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) plans a music video section by section — "cut wide on
// the first chorus, the bridge is the quiet aerial" — so `film.mjs song analyze` must find section boundaries on bar
// lines, give repeats the same label and name chorus/verse/bridge/intro/outro. The suite synthesises a deterministic
// 4/4 song at 120 BPM (intro 4 · A 8 · B 8 · A 8 · B 8 · C 8 · B 8 · outro 4 bars; every section with its own chord
// progression, harmonic timbre, noise colour and level, B loudest) and runs the REAL modules under
// tools/film/audio/ and tools/film/lib/decode_audio.mjs. No real ffmpeg, no real songs, no network.
//
// Run from apps/holtburger-web/: node tests/film_audio_structure.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignRoles,
  clusterSegments,
  cosineSsm,
  footeNovelty,
  labelName,
  pickBoundaries,
  SECTION_ROLES,
  segmentSimilarity,
} from "../tools/film/audio/structure.mjs";
import { analyzeSong, analyzeSongFile, formatSongSummary } from "../tools/film/audio/analyze.mjs";
import {
  decodeAudioFile,
  DEFAULT_FFMPEG,
  f32leToFloat32,
  ffmpegDecodeArgs,
  resolveFfmpeg,
} from "../tools/film/lib/decode_audio.mjs";

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  const done = (err) => {
    if (err) {
      failed++;
      console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
    } else {
      passed++;
      console.log(`  [PASS] ${name}`);
    }
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      const p = r.then(() => done(null), done);
      pending.push(p);
      return p;
    }
    done(null);
  } catch (e) {
    done(e);
  }
  return undefined;
}

const SR = 22050;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const CHORDS = {
  Am: [57, 60, 64], F: [53, 57, 60], C: [48, 52, 55, 60], G: [55, 59, 62], Dm: [50, 53, 57], Em: [52, 55, 59],
  Bb: [58, 62, 65], Eb: [51, 55, 58], Gm: [55, 58, 62], E: [52, 56, 59],
};
/** Per section kind: chord progression (1 chord per bar), harmonic weights, noise level/colour, gain, drums. */
const DEFS = {
  intro: { prog: ["Am", "Am", "F", "F"], harm: [1, 0.15, 0.05], noise: 0, noiseLp: 0.9, gain: 0.25, drums: false },
  A: { prog: ["Am", "F", "C", "G"], harm: [1, 0.5, 0.25, 0.12], noise: 0.01, noiseLp: 0.95, gain: 0.45, drums: true },
  B: { prog: ["C", "G", "Dm", "Em"], harm: [1, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3], noise: 0.04, noiseLp: 0, gain: 0.9, drums: true },
  C: { prog: ["Bb", "Eb", "Gm", "E"], harm: [1, 0, 0.6, 0, 0.4, 0, 0.25], noise: 0, noiseLp: 0.5, gain: 0.55, drums: true },
  P: { prog: ["Dm", "Dm", "G", "G"], harm: [1, 0.3, 0.5, 0.1, 0.3], noise: 0.02, noiseLp: 0.6, gain: 0.6, drums: true },
  outro: { prog: ["Am", "Am", "Am", "Am"], harm: [1, 0.15, 0.05], noise: 0, noiseLp: 0.9, gain: 0.25, drums: false, fade: true },
};
const FORM = [["intro", 4], ["A", 8], ["B", 8], ["A", 8], ["B", 8], ["C", 8], ["B", 8], ["outro", 4]];

/** Deterministic synthetic song; returns PCM at 22050 Hz and the true section layout. */
function synthSong({ bpm = 120, form = FORM, seed = 11, lead = 0.25, tail = 1.0 } = {}) {
  const r = rng(seed);
  const ibi = 60 / bpm;
  const barSec = 4 * ibi;
  const totalBars = form.reduce((s, [, b]) => s + b, 0);
  const n = Math.round((lead + totalBars * barSec + tail) * SR);
  const x = new Float32Array(n);
  const truth = { sections: [], boundaries: [], barSec };
  let bar = 0;
  let lp = 0;
  let hpPrev = 0;
  const addHit = (t, len, fn) => {
    const a0 = Math.round(t * SR);
    for (let i = 0; i < len && a0 + i < n; i++) x[a0 + i] += fn(i / SR);
  };
  for (const [name, nb] of form) {
    const d = DEFS[name];
    const sStart = lead + bar * barSec;
    truth.sections.push({ name, start: sStart, end: sStart + nb * barSec });
    if (bar > 0) truth.boundaries.push(sStart);
    for (let b = 0; b < nb; b++) {
      const t0 = lead + (bar + b) * barSec;
      const chord = CHORDS[d.prog[b % d.prog.length]];
      const g = d.gain * (d.fade ? 1 - (0.85 * b) / nb : 1);
      const s0 = Math.round(t0 * SR);
      const s1 = Math.min(n, Math.round((t0 + barSec) * SR));
      const len = s1 - s0;
      const acc = new Float64Array(len);
      for (const m of chord) {
        for (const oct of [-12, 0]) {
          const f0 = midiHz(m + oct);
          for (let h = 0; h < d.harm.length; h++) {
            const fh = f0 * (h + 1);
            if (fh > 5000 || d.harm[h] === 0) continue;
            const a = d.harm[h] * 0.12 * (oct ? 0.7 : 1);
            const c = Math.cos((2 * Math.PI * fh) / SR);
            const sn = Math.sin((2 * Math.PI * fh) / SR);
            let re = 1;
            let im = 0;
            for (let i = 0; i < len; i++) {
              acc[i] += a * im;
              const nr = re * c - im * sn;
              im = re * sn + im * c;
              re = nr;
            }
          }
        }
      }
      const fb = midiHz(chord[0] - 24 + (chord[0] < 52 ? 12 : 0));
      for (let i = 0; i < len; i++) {
        const tt = i / SR;
        const tb = tt % (2 * ibi);
        const env = Math.min(1, tb / 0.01) * (0.55 + 0.45 * Math.exp(-tb / 0.4));
        let v = g * env * acc[i];
        v += g * 0.35 * Math.min(1, tt / 0.005) * Math.exp(-tt / 1.2) * Math.sin(2 * Math.PI * fb * tt);
        if (d.noise > 0) {
          const w = r() * 2 - 1;
          lp = d.noiseLp * lp + (1 - d.noiseLp) * w;
          v += d.noise * (g / d.gain) * (d.noiseLp > 0 ? lp * 3 : w);
        }
        x[s0 + i] += v;
      }
      if (d.drums) {
        const kick = (t) => {
          let ph = 0;
          addHit(t, Math.round(0.3 * SR), (tt) => {
            ph += (2 * Math.PI * (50 + 100 * Math.exp(-tt / 0.03))) / SR;
            return 0.7 * g * Math.exp(-tt / 0.1) * Math.sin(ph);
          });
        };
        const snare = (t) => addHit(t, Math.round(0.2 * SR), (tt) => 0.45 * g * Math.exp(-tt / 0.05) * (r() * 2 - 1));
        const hat = (t, k) =>
          addHit(t, Math.round(0.05 * SR), (tt) => {
            const w = r() * 2 - 1;
            const v = w - hpPrev;
            hpPrev = w;
            return k * g * Math.exp(-tt / 0.012) * v;
          });
        kick(t0);
        kick(t0 + 2 * ibi);
        kick(t0 + 2.5 * ibi);
        snare(t0 + ibi);
        snare(t0 + 3 * ibi);
        for (let e = 0; e < 8; e++) hat(t0 + (e * ibi) / 2, e % 2 ? 0.08 : 0.14);
      }
    }
    bar += nb;
  }
  return { x, truth };
}

/** Detected section with the largest overlap with [a, b). */
function sectionFor(sections, a, b) {
  let best = null;
  let bestOv = -1;
  for (const s of sections) {
    const ov = Math.min(b, s.end) - Math.max(a, s.start);
    if (ov > bestOv) {
      bestOv = ov;
      best = s;
    }
  }
  return best;
}

console.log("film_audio_structure: helpers");

check("labelName: A…Z then A2, B2…", () => {
  assert.equal(labelName(0), "A");
  assert.equal(labelName(25), "Z");
  assert.equal(labelName(26), "A2");
  assert.equal(labelName(27), "B2");
});

check("Foote novelty on a block SSM peaks at the block edges; peak picking keeps ≥ 4-bar sections", () => {
  const blocks = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
  const vecs = blocks.map((b) => [b === 0 ? 1 : 0, b === 1 ? 1 : 0, b === 2 ? 1 : 0]);
  const S = cosineSsm(vecs, { center: false });
  const n = blocks.length;
  const N = footeNovelty(S, n);
  assert.equal(N.length, n + 1);
  assert.deepEqual(pickBoundaries(N, n), [8, 16]);
  assert.deepEqual(pickBoundaries(N, n, { minSectionBars: 9 }), [16]);
});

check("diagonal-stripe segment similarity: equal-length repeats ≈ 1, different material lower", () => {
  // bar pattern a b c d | e f g h | a b c d — chroma-like one-hot rows
  const pat = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3];
  const vecs = pat.map((p) => Array.from({ length: 8 }, (_, k) => (k === p ? 1 : 0)));
  const S = cosineSsm(vecs, { center: false });
  const same = segmentSimilarity(S, 12, [0, 4], [8, 12]);
  const diff = segmentSimilarity(S, 12, [0, 4], [4, 8]);
  assert.ok(same > 0.99, `same ${same}`);
  assert.ok(diff < 0.6, `diff ${diff}`);
});

check("agglomerative clustering labels by first appearance", () => {
  const sim = [
    [1, 0.2, 0.9, 0.1, 0.3],
    [0.2, 1, 0.3, 0.85, 0.2],
    [0.9, 0.3, 1, 0.2, 0.1],
    [0.1, 0.85, 0.2, 1, 0.3],
    [0.3, 0.2, 0.1, 0.3, 1],
  ];
  assert.deepEqual(clusterSegments(sim, 0.75), [0, 1, 0, 1, 2]);
  assert.deepEqual(clusterSegments(sim, 0.95), [0, 1, 2, 3, 4]);
});

const mk = (spec) => {
  let bar = 0;
  return spec.map(([label, bars, energy], i) => {
    const s = { i, start: bar * 2, end: (bar + bars) * 2, startBar: bar, endBar: bar + bars, label, energy };
    bar += bars;
    return s;
  });
};

check("assignRoles: intro, verse, chorus, bridge, outro on the classic form", () => {
  const secs = mk([["A", 4, 0.2], ["B", 8, 0.4], ["C", 8, 0.8], ["B", 8, 0.42], ["C", 8, 0.82], ["D", 8, 0.5], ["C", 8, 0.85], ["E", 4, 0.2]]);
  const roles = assignRoles(secs, { durationSec: secs[secs.length - 1].end });
  assert.deepEqual(roles, ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]);
  for (const r of roles) assert.ok(SECTION_ROLES.includes(r));
});

check("assignRoles: a short label between verse and chorus is the prechorus", () => {
  const secs = mk([["A", 4, 0.2], ["B", 8, 0.4], ["P", 4, 0.55], ["C", 8, 0.8], ["B", 8, 0.42], ["P", 4, 0.56], ["C", 8, 0.82], ["D", 8, 0.5], ["C", 8, 0.85], ["E", 4, 0.2]]);
  const roles = assignRoles(secs, { durationSec: secs[secs.length - 1].end });
  assert.deepEqual(roles, ["intro", "verse", "prechorus", "chorus", "verse", "prechorus", "chorus", "bridge", "chorus", "outro"]);
});

check("assignRoles: with timed lyrics a repeated section without lyrics is instrumental", () => {
  const secs = mk([["A", 4, 0.2], ["B", 8, 0.4], ["C", 8, 0.8], ["B", 8, 0.42], ["C", 8, 0.82], ["B", 8, 0.45], ["C", 8, 0.85], ["E", 4, 0.2]]);
  // lyrics in every B/C section except the third B (bars 36..43 = 72..88 s)
  const timed = [];
  for (const s of secs) if ((s.label === "B" || s.label === "C") && s.i !== 5) timed.push({ t: s.start + 1 }, { t: s.start + 6 });
  const roles = assignRoles(secs, { durationSec: secs[secs.length - 1].end, timedLyrics: timed });
  assert.equal(roles[5], "instrumental");
  assert.equal(roles[2], "chorus");
  assert.equal(roles[1], "verse");
});

console.log("film_audio_structure: synthetic song (120 BPM, 56 bars)");

const song = synthSong();
let main = null;
check("analyzeSong finds tempo and bars on the synthetic song", () => {
  main = analyzeSong(song.x, SR);
  assert.ok(Math.abs(main.tempo.bpm - 120) <= 1, `bpm ${main.tempo.bpm}`);
  assert.ok(main.bars.length >= 55 && main.bars.length <= 57, `bars ${main.bars.length}`);
});

check("≥ 80 % of the true section boundaries are found within ±1 bar, no over-segmentation", () => {
  const det = main.sections.slice(1).map((s) => s.start);
  const hit = song.truth.boundaries.filter((b) => det.some((d) => Math.abs(d - b) <= song.truth.barSec + 1e-6)).length;
  assert.ok(hit >= Math.ceil(0.8 * song.truth.boundaries.length), `${hit}/${song.truth.boundaries.length} boundaries (${det.map((d) => d.toFixed(2)).join(" ")})`);
  assert.ok(det.length <= song.truth.boundaries.length + 2, `${det.length} detected boundaries`);
  // boundaries are snapped to downbeats (bar starts)
  for (const s of main.sections.slice(1)) assert.equal(s.start, main.bars[s.startBar].start);
});

check("repeats share labels: both A sections one label, all three B one label, C unique", () => {
  const t = song.truth.sections;
  const lab = t.map((s) => sectionFor(main.sections, s.start, s.end).label);
  assert.equal(lab[1], lab[3], `verse labels ${lab[1]} / ${lab[3]}`);
  assert.equal(lab[2], lab[4]);
  assert.equal(lab[2], lab[6]);
  assert.notEqual(lab[1], lab[2]);
  assert.ok(lab.filter((l) => l === lab[5]).length === 1, `bridge label ${lab[5]} repeats: ${lab.join("")}`);
  const first = sectionFor(main.sections, t[2].start, t[2].end);
  const third = sectionFor(main.sections, t[6].start, t[6].end);
  assert.equal(third.repeatOf, first.i);
  assert.equal(first.repeatOf, null);
});

check("roles: chorus on B, verse on A, bridge on C, intro and outro at the ends", () => {
  const t = song.truth.sections;
  const role = t.map((s) => sectionFor(main.sections, s.start, s.end).role);
  assert.deepEqual(role, ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]);
});

check("section fields: contiguous, cover 0..duration, energy 0..1 with the chorus loudest", () => {
  const s = main.sections;
  assert.equal(s[0].start, 0);
  assert.equal(s[s.length - 1].end, main.durationSec);
  for (let k = 1; k < s.length; k++) {
    assert.equal(s[k].start, s[k - 1].end);
    assert.equal(s[k].startBar, s[k - 1].endBar);
    assert.equal(s[k].i, k);
  }
  for (const q of s) assert.ok(q.energy >= 0 && q.energy <= 1);
  const chorusE = Math.min(...s.filter((q) => q.role === "chorus").map((q) => q.energy));
  const otherE = Math.max(...s.filter((q) => q.role !== "chorus").map((q) => q.energy));
  assert.ok(chorusE > otherE, `chorus ${chorusE} vs ${otherE}`);
  const summary = formatSongSummary(main);
  assert.match(summary, /120\.0 BPM/);
  assert.match(summary, /chorus/);
});

check("analyzeSong of a 70 s excerpt finishes in < 10 s", () => {
  const t0 = performance.now();
  const a = analyzeSong(song.x.subarray(0, 70 * SR), SR);
  const ms = performance.now() - t0;
  assert.ok(ms < 10000, `${ms.toFixed(0)} ms`);
  assert.ok(a.sections.length >= 3, `${a.sections.length} sections`);
  console.log(`    (70 s excerpt analysed in ${ms.toFixed(0)} ms)`);
});

check("LRC lyrics: lines land in their sections; a lyric-less third chorus reads instrumental", () => {
  const t = song.truth.sections;
  const stamp = (sec) => {
    const m = Math.floor(sec / 60);
    return `[${String(m).padStart(2, "0")}:${(sec - 60 * m).toFixed(2).padStart(5, "0")}]`;
  };
  const lrc = ["[ti:Synthetic]", "[ar:Test]"];
  for (const k of [1, 2, 3, 4, 5]) {
    lrc.push(`${stamp(t[k].start + 0.6)}line one of part ${k}`);
    lrc.push(`${stamp(t[k].start + 8.6)}line two of part ${k}`);
  }
  const a = analyzeSong(song.x, SR, { lyrics: { text: lrc.join("\n"), format: "lrc" } });
  assert.equal(a.lyrics.format, "lrc");
  assert.equal(a.lyrics.lines.length, 10);
  for (const l of a.lyrics.lines) {
    const k = Number(/part (\d)/.exec(l.text)[1]);
    const want = sectionFor(a.sections, t[k].start, t[k].end).i;
    assert.equal(l.section, want, `"${l.text}" at ${l.t}`);
  }
  const lastChorus = sectionFor(a.sections, t[6].start, t[6].end);
  assert.equal(lastChorus.role, "instrumental");
  assert.equal(sectionFor(a.sections, t[2].start, t[2].end).role, "chorus");
});

console.log("film_audio_structure: pre-chorus form");

check("intro A P B A P B C B outro → verse, prechorus, chorus, bridge", () => {
  const form = [["intro", 4], ["A", 8], ["P", 4], ["B", 8], ["A", 8], ["P", 4], ["B", 8], ["C", 8], ["B", 8], ["outro", 4]];
  const { x, truth } = synthSong({ form, seed: 21 });
  const a = analyzeSong(x, SR);
  const role = truth.sections.map((s) => sectionFor(a.sections, s.start, s.end).role);
  assert.deepEqual(role, ["intro", "verse", "prechorus", "chorus", "verse", "prechorus", "chorus", "bridge", "chorus", "outro"]);
});

console.log("film_audio_structure: decode_audio (fake ffmpeg child)");

// A stand-in ffmpeg: a real child process (node -e) that reads the ffmpeg argv and streams f32le PCM on stdout.
// Path names select behaviour: *missing* → stderr + exit 1; *empty* → no output; *clicks* → 20 s 120 BPM clicks;
// otherwise a 3 s deterministic sine (> 1 MB, so the decoder's buffer must grow).
const FAKE_FFMPEG = `
const a = process.argv.slice(1);
const get = (k) => a[a.indexOf(k) + 1];
const path = get('-i'); const sr = Number(get('-ar'));
if (get('-ac') !== '1' || get('-f') !== 'f32le' || a[a.length - 1] !== '-') { process.stderr.write('bad args ' + a.join(' ')); process.exit(2); }
if (path.includes('missing')) { process.stderr.write(path + ': No such file or directory\\n'); process.exit(1); }
if (path.includes('empty')) process.exit(0);
let x;
if (path.includes('clicks')) {
  x = new Float32Array(sr * 20);
  for (let t = 0.3; t < 19.8; t += 0.5) { const s0 = Math.round(t * sr); for (let i = 0; i < 800; i++) x[s0 + i] += Math.exp(-i / 250) * Math.sin(i * 0.3) * 0.8; }
} else {
  x = new Float32Array(sr * 3);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(i * 0.01);
}
process.stdout.write(Buffer.from(x.buffer, x.byteOffset, x.byteLength));
`;
const fakeSpawn = (cmd, args, opts) => spawn(process.execPath, ["-e", FAKE_FFMPEG, "--", ...args], opts);

check("ffmpeg resolution: option > env FILM_FFMPEG > default; argv decodes mono f32le", () => {
  assert.equal(DEFAULT_FFMPEG, "/home/wbterminal/bin/ffmpeg");
  assert.equal(resolveFfmpeg(undefined, {}), DEFAULT_FFMPEG);
  assert.equal(resolveFfmpeg(undefined, { FILM_FFMPEG: "/opt/ff" }), "/opt/ff");
  assert.equal(resolveFfmpeg("/x/ffmpeg", { FILM_FFMPEG: "/opt/ff" }), "/x/ffmpeg");
  const args = ffmpegDecodeArgs("song.mp3", 22050);
  assert.deepEqual(args.slice(-7), ["-ac", "1", "-ar", "22050", "-f", "f32le", "-"]);
  assert.ok(args[args.indexOf("-i") + 1].startsWith("/"), "input path is absolute");
  assert.ok(args.includes("-v") && args[args.indexOf("-v") + 1] === "error");
});

check("f32le bytes → Float32Array (trailing partial sample dropped)", () => {
  const src = Float32Array.of(0.25, -1, 3.5);
  const bytes = new Uint8Array(13);
  bytes.set(new Uint8Array(src.buffer));
  bytes[12] = 7;
  assert.deepEqual(Array.from(f32leToFloat32(bytes)), [0.25, -1, 3.5]);
});

await check("decodeAudioFile streams > 1 MB of PCM from the child into a growing buffer", async () => {
  const r = await decodeAudioFile("/music/sine.flac", { spawnImpl: fakeSpawn });
  assert.equal(r.sampleRate, 22050);
  assert.equal(r.pcm.length, 22050 * 3);
  assert.ok(Math.abs(r.durationSec - 3) < 1e-9);
  const want = new Float32Array(r.pcm.length);
  for (let i = 0; i < want.length; i++) want[i] = 0.5 * Math.sin(i * 0.01);
  assert.deepEqual(r.pcm, want);
});

await check("decodeAudioFile rejects with ffmpeg's stderr text on failure", async () => {
  await assert.rejects(decodeAudioFile("/music/missing.mp3", { spawnImpl: fakeSpawn }), /exit code 1.*No such file or directory/s);
});

await check("decodeAudioFile rejects when no audio is decoded", async () => {
  await assert.rejects(decodeAudioFile("/music/empty.mp3", { spawnImpl: fakeSpawn }), /no audio decoded/);
});

await check("decodeAudioFile reports a missing ffmpeg binary readably", async () => {
  await assert.rejects(
    decodeAudioFile("/music/x.mp3", { ffmpeg: "/nonexistent-film-test/ffmpeg", env: {} }),
    /not found — set FILM_FFMPEG or pass --ffmpeg/,
  );
  await assert.rejects(decodeAudioFile("", { spawnImpl: fakeSpawn }), /non-empty string/);
});

await check("analyzeSongFile: fake ffmpeg + .lrc lyrics file → 120 BPM analysis with aligned lyrics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "film-audio-test-"));
  try {
    const lrcPath = join(dir, "song.lrc");
    await writeFile(lrcPath, "[ar:Fake]\n[00:02.00]hello\n[00:10.50]world\n", "utf8");
    const a = await analyzeSongFile(join(dir, "clicks.mp3"), { lyricsPath: lrcPath, spawnImpl: fakeSpawn });
    assert.ok(Math.abs(a.tempo.bpm - 120) <= 1.5, `bpm ${a.tempo.bpm}`);
    assert.ok(Math.abs(a.durationSec - 20) < 1e-3);
    assert.equal(a.lyrics.format, "lrc");
    assert.deepEqual(
      a.lyrics.lines.map((l) => [l.t, l.text]),
      [
        [2, "hello"],
        [10.5, "world"],
      ],
    );
    for (const l of a.lyrics.lines) assert.ok(Number.isInteger(l.section));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await Promise.all(pending);
console.log(`film_audio_structure: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
