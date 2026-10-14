// tools/film/audio/analyze.mjs — analyzeSong(): PCM → SongAnalysis (tempo, beats, downbeats, bars, sections,
// energy, lyrics) for film mode's music videos.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) lets a Claude Code director cut a music video to a song. The CLI
// (`film.mjs song analyze song.mp3 --lyrics song.lrc --out song.json`) decodes with lib/decode_audio.mjs and calls
// analyzeSong; the plan compiler snaps cuts to `beats`/`bars` and the director reads `sections` ("B = chorus, 3×,
// loudest"). Pure JS, deterministic, no dependencies, ~1 s per minute of audio on the laptop.
//
// Pipeline: resample to 22050 Hz when needed (features.mjs Kaiser-sinc) → one STFT pass (2048/512 Hann) giving
// log-mel 40, chroma 12, MFCC 13, RMS → onset envelope (onset.mjs) → tempo, beats, downbeats, bars (tempo.mjs) →
// 0.5 s energy curve → bar-synchronous structure (structure.mjs; LRC lyrics feed the vocal/instrumental roles) →
// lyric alignment (lyrics.mjs).
//
// SongAnalysis (version 1) — all times in seconds, rounded to 0.1 ms; energies 0..1 rounded to 1e-4:
//   { version:1, durationSec, sampleRate (analysis rate, 22050), sourceSampleRate (the caller's rate),
//     tempo:{bpm, confidence}, beats:[s], downbeats:[s], bars:[{i,start,end}],
//     sections:[{i,start,end,startBar,endBar(exclusive),label,role,energy,repeatOf}],
//     energy:{hopSec, values:[0..1]}, lyrics?:{format, lines:[{t?, text, section?, stanza?, hint?}]} }

import { readFile } from "node:fs/promises";
import { ANALYSIS_SAMPLE_RATE, computeFeatures, energyCurve, resample } from "./features.mjs";
import { onsetEnvelope } from "./onset.mjs";
import { analyzeRhythm } from "./tempo.mjs";
import { analyzeStructure } from "./structure.mjs";
import { alignLyrics, detectLyricsFormat, timedLyricLines } from "./lyrics.mjs";
import { decodeAudioFile } from "../lib/decode_audio.mjs";

/** SongAnalysis schema version. */
export const SONG_ANALYSIS_VERSION = 1;

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r3 = (v) => Math.round(v * 1e3) / 1e3;

/**
 * @typedef {object} SongSection
 * @property {number} i
 * @property {number} start
 * @property {number} end
 * @property {number} startBar
 * @property {number} endBar exclusive
 * @property {string} label A, B, C… by first appearance
 * @property {string} role intro|verse|prechorus|chorus|bridge|instrumental|outro|unknown
 * @property {number} energy mean of the 0..1 energy curve over the section
 * @property {number|null} repeatOf index of the first section with the same label
 */

/**
 * @typedef {object} SongAnalysis
 * @property {1} version
 * @property {number} durationSec
 * @property {number} sampleRate analysis rate (22050)
 * @property {number} sourceSampleRate rate of the PCM handed to analyzeSong
 * @property {{bpm:number, confidence:number}} tempo
 * @property {number[]} beats
 * @property {number[]} downbeats
 * @property {{i:number, start:number, end:number}[]} bars
 * @property {SongSection[]} sections
 * @property {{hopSec:number, values:number[]}} energy
 * @property {{format:'lrc'|'plain', lines:import("./lyrics.mjs").LyricLine[]}} [lyrics]
 */

/**
 * Analyses a mono song.
 * @param {Float32Array|ArrayLike<number>} pcm mono samples (any rate; resampled to 22050 Hz when different)
 * @param {number} sampleRate Hz
 * @param {{lyrics?:{text:string, format?:'lrc'|'plain'}|null, energyHopSec?:number,
 *   tempo?:Partial<typeof import("./tempo.mjs").TEMPO_DEFAULTS>,
 *   structure?:Partial<typeof import("./structure.mjs").STRUCTURE_DEFAULTS>}} [opts]
 * @returns {SongAnalysis}
 */
export function analyzeSong(pcm, sampleRate, opts = {}) {
  if (!pcm || typeof pcm.length !== "number") throw new TypeError("analyzeSong: pcm must be a Float32Array (mono)");
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new RangeError(`analyzeSong: bad sampleRate ${sampleRate}`);
  if (pcm.length === 0) throw new RangeError("analyzeSong: empty pcm");
  const { lyrics = null, energyHopSec = 0.5 } = opts;
  let x = sampleRate === ANALYSIS_SAMPLE_RATE ? pcm : resample(pcm, sampleRate, ANALYSIS_SAMPLE_RATE);
  x = sanitize(x);
  const features = computeFeatures(x, ANALYSIS_SAMPLE_RATE);
  const onset = onsetEnvelope(features);
  const rhythm = analyzeRhythm(features, onset, opts.tempo ?? {});
  const energy = energyCurve(x, ANALYSIS_SAMPLE_RATE, { hopSec: energyHopSec });
  const timedLyrics = timedLyricLines(lyrics);
  const structure = analyzeStructure(features, rhythm.bars, energy, { ...(opts.structure ?? {}), timedLyrics });
  const durationSec = features.durationSec;
  const sections = structure.sections.map((s) => ({
    i: s.i,
    start: r4(s.start),
    end: r4(s.end),
    startBar: s.startBar,
    endBar: s.endBar,
    label: s.label,
    role: s.role,
    energy: r4(s.energy),
    repeatOf: s.repeatOf,
  }));
  /** @type {SongAnalysis} */
  const out = {
    version: SONG_ANALYSIS_VERSION,
    durationSec: r4(durationSec),
    sampleRate: ANALYSIS_SAMPLE_RATE,
    sourceSampleRate: sampleRate,
    tempo: { bpm: r3(rhythm.bpm), confidence: r3(rhythm.confidence) },
    beats: rhythm.beats.map(r4),
    downbeats: rhythm.downbeats.map(r4),
    bars: rhythm.bars.map((b) => ({ i: b.i, start: r4(b.start), end: r4(b.end) })),
    sections,
    energy: { hopSec: energy.hopSec, values: Array.from(energy.values, r4) },
  };
  if (lyrics && typeof lyrics.text === "string") {
    out.lyrics = alignLyrics({ durationSec: out.durationSec, sections }, lyrics);
  }
  return out;
}

function sanitize(x) {
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) {
      const y = Float32Array.from(x);
      for (let j = i; j < y.length; j++) if (!Number.isFinite(y[j])) y[j] = 0;
      return y;
    }
  }
  return x;
}

/**
 * Decodes an audio file with ffmpeg and analyses it; lyrics come from `lyricsPath` (format from the .lrc extension,
 * else auto-detected) or an inline `lyrics` object.
 * @param {string} path
 * @param {{lyricsPath?:string, lyrics?:{text:string, format?:'lrc'|'plain'}, ffmpeg?:string, timeoutMs?:number,
 *   spawnImpl?:Function, env?:Record<string,string|undefined>, tempo?:object, structure?:object}} [opts]
 * @returns {Promise<SongAnalysis>}
 */
export async function analyzeSongFile(path, opts = {}) {
  const { pcm, sampleRate } = await decodeAudioFile(path, {
    ffmpeg: opts.ffmpeg,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    timeoutMs: opts.timeoutMs,
    spawnImpl: opts.spawnImpl,
    env: opts.env,
  });
  let lyrics = opts.lyrics ?? null;
  if (opts.lyricsPath) {
    const text = await readFile(opts.lyricsPath, "utf8");
    const format = /\.lrc$/i.test(opts.lyricsPath) ? "lrc" : detectLyricsFormat(text);
    lyrics = { text, format };
  }
  return analyzeSong(pcm, sampleRate, { lyrics, tempo: opts.tempo, structure: opts.structure });
}

function mmss(t) {
  const m = Math.floor(t / 60);
  const s = t - 60 * m;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * Compact human/agent-readable summary of a SongAnalysis (one line per section, plus the first lyric line of each).
 * @param {SongAnalysis} a
 * @returns {string}
 */
export function formatSongSummary(a) {
  const lines = [];
  lines.push(
    `duration ${mmss(a.durationSec)} · ${a.tempo.bpm.toFixed(1)} BPM (confidence ${a.tempo.confidence.toFixed(2)}) · ` +
      `${a.beats.length} beats · ${a.bars.length} bars · ${a.sections.length} sections`,
  );
  const firstLyric = new Map();
  for (const l of a.lyrics?.lines ?? []) if (l.section !== undefined && l.text && !firstLyric.has(l.section)) firstLyric.set(l.section, l.text);
  for (const s of a.sections) {
    const rep = s.repeatOf === null ? "" : ` (= #${s.repeatOf})`;
    const lyr = firstLyric.has(s.i) ? `  “${firstLyric.get(s.i)}”` : "";
    lines.push(
      `#${s.i} ${mmss(s.start)}–${mmss(s.end)} bars ${s.startBar}–${s.endBar - 1} ${s.label} ${s.role} energy ${s.energy.toFixed(2)}${rep}${lyr}`,
    );
  }
  return lines.join("\n");
}
