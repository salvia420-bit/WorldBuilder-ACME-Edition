// audio_mp3_wave_bytes.test.mjs — audio-4: the one MP3 wave reaches
// decodeAudioData as its bare MPEG stream, byte for byte.
//
// The end-of-retail portal.dat has 786 waves. Only 0x0A000393 is MP3: format
// tag 0x55, a 30-byte MPEGLAYER3WAVEFORMAT header, and 5120 bytes of
// MPEG-2.5 Layer III frames (ACE Wave.cs ExportWave names it). fetchWave
// used to RIFF-wrap it with tag 0x55, which Firefox's WAV demuxer rejects; it
// now returns the frames unwrapped (Wave::to_browser_bytes in
// crates/holtburger-dat/src/file_type/wave.rs, pinned by the cargo tests
// to_browser_bytes_* and probe_retail_mp3_wave_0x0a000393).
//
// This test pins the JS half that fix relies on: AudioManager hands
// takeRiffBytes() to decodeAudioData unchanged and never sniffs for a RIFF
// header, so the bare MP3 stream and a PCM RIFF both decode and play.
//
// Run: node tests/audio_mp3_wave_bytes.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

const MP3_DID = 0x0a000393;
const PCM_DID = 0x0a000002;

// Leads with the real 0x0A000393 frame header (ff e3 30 c4: MPEG-2.5,
// Layer III, 11025 Hz, mono), then filler.
const MP3_STREAM = new Uint8Array([
  0xff, 0xe3, 0x30, 0xc4,
  ...Array.from({ length: 60 }, (_, i) => (i * 7) & 0xff),
]);

// A PCM RIFF laid out as Rust Wave::to_riff_wav builds it (18-byte fmt chunk).
function pcmRiff(samples) {
  const fmt = new Uint8Array(18);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, 1, true); // WAVE_FORMAT_PCM
  f.setUint16(2, 1, true); // mono
  f.setUint32(4, 22050, true);
  f.setUint32(8, 44100, true);
  f.setUint16(12, 2, true);
  f.setUint16(14, 16, true);
  f.setUint16(16, 0, true);
  const out = new Uint8Array(8 + 4 + 8 + fmt.length + 8 + samples.length);
  const v = new DataView(out.buffer);
  const tag = (off, s) => { for (let i = 0; i < 4; i++) out[off + i] = s.charCodeAt(i); };
  tag(0, "RIFF");
  v.setUint32(4, out.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  tag(38, "data");
  v.setUint32(42, samples.length, true);
  out.set(samples, 46);
  return out;
}
const PCM_RIFF = pcmRiff(Uint8Array.from({ length: 64 }, (_, i) => i));

const WAVES = new Map([
  [MP3_DID, { sampleRate: 11025, numChannels: 1, bitsPerSample: 0, bytes: MP3_STREAM }],
  [PCM_DID, { sampleRate: 22050, numChannels: 1, bitsPerSample: 16, bytes: PCM_RIFF }],
]);
const fetchWave = async (did) => {
  const w = WAVES.get(did);
  if (!w) throw new Error(`no wave 0x${did.toString(16)}`);
  return {
    id: did,
    sampleRate: w.sampleRate,
    numChannels: w.numChannels,
    bitsPerSample: w.bitsPerSample,
    riffByteLength: w.bytes.length,
    takeRiffBytes: () => w.bytes.slice(),
  };
};

const ascii4 = (u8) => String.fromCharCode(...u8.subarray(0, 4));

for (const hrtf of [true, false]) {
  const fake = installFakeAudio();
  const decoded = [];
  globalThis.window.AudioContext.prototype.decodeAudioData = async function (ab) {
    decoded.push(new Uint8Array(ab.slice(0)));
    return { duration: 0.5 };
  };
  const { AudioManager } = await import("../scene3d/audio/audio_manager.js");
  const am = new AudioManager({ fetchWave, hrtf });
  am.notifyUserGesture();
  am.setListener({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 });
  const mode = hrtf ? "HRTF default" : "?audioRetailPan=on";

  await am.playFromCenter(MP3_DID, 1.0);
  assert.equal(decoded.length, 1, "MP3 wave decoded once");
  assert.deepEqual(decoded[0], MP3_STREAM, "decodeAudioData got the bare MPEG stream");
  assert.notEqual(ascii4(decoded[0]), "RIFF");
  assert.equal(fake.started().length, 1, "MP3 wave starts a voice");
  assert.equal(am.lastError ?? null, null);
  ok(`AudioManager (${mode}): bare MP3 bytes pass to decodeAudioData unchanged and play`);

  await am.playFromCenter(PCM_DID, 1.0);
  assert.equal(decoded.length, 2, "PCM wave decoded once");
  assert.deepEqual(decoded[1], PCM_RIFF, "decodeAudioData got the PCM RIFF");
  assert.equal(ascii4(decoded[1]), "RIFF");
  assert.equal(fake.started().length, 2, "PCM wave starts a voice");
  ok(`AudioManager (${mode}): PCM RIFF bytes pass to decodeAudioData unchanged and play`);

  fake.uninstall();
}

console.log(`\n${passed} passed`);
