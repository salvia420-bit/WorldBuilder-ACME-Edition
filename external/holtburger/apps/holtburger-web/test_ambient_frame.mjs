// test_ambient_frame.mjs — AmbientRuntime frame handling (2026-10-05 retail
// rewrite; replaces the Batch 6 / #15 loop-era version).
//
// Positional intermittent ambients (retail IntermitSound::GetSoundPos,
// acclient.c:384212-384257) are computed in the AC frame around the
// listener and must reach audioManager.play() in the three.js frame
// (acToThree: (x, y, z) -> (x, z, -y)); the event-log world_pos stays AC.
// Continuous beds play from the centre (playFromCenter), never as loops.
//
// Run: node test_ambient_frame.mjs   (from apps/holtburger-web/)

const { AmbientRuntime } = await import("./scene3d/audio/ambient_runtime.js");

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

const calls = [];
const records = [];
const PLAYER = { x: 0xa9 * 192 + 100, y: 0xb4 * 192 + 100, z: 50 };
const rt = new AmbientRuntime({
  soundTableCache: { async resolveSound() { return { waveDid: 0x0a000001, volume: 1, probability: 1 }; } },
  audioManager: {
    async play(did, pos, opts) { calls.push({ fn: "play", pos, opts }); return {}; },
    async playFromCenter(did, vol, opts) { calls.push({ fn: "center", vol, opts }); return {}; },
  },
  getPlayerPos: () => PLAYER,
  getRegion: () => ({}),
  getBakedAmbientTriggers: () => [{
    stbId: 0x20000001,
    vertexIndices: Array.from({ length: 81 }, (_, i) => i),
    ambientSounds: [{ sType: 0x47, volume: 0.5, baseChance: 1, minRate: 1, maxRate: 1, isContinuous: false }],
  }],
  // rolls: playNow 0 (<= chance), shell index 0, heading jitter mid, distance t=0
  rng: () => 0.0,
  pushEventRecord: (r) => records.push(r),
  clock: () => 0,
});
rt.tick(0);
await flush();

const p = calls.find((c) => c.fn === "play");
const rec = records[0]?.world_pos;
check("intermittent plays positionally", !!p, JSON.stringify(calls.map((c) => c.fn)));
if (p && rec) {
  check("play() position is the three.js mapping of the event's AC position",
    Math.abs(p.pos.x - rec[0]) < 1e-6 && Math.abs(p.pos.y - rec[2]) < 1e-6 && Math.abs(p.pos.z + rec[1]) < 1e-6,
    JSON.stringify({ three: p.pos, ac: rec }));
  check("event AC position keeps the listener Z", rec[2] === PLAYER.z, String(rec[2]));
  const d = Math.hypot(rec[0] - PLAYER.x, rec[1] - PLAYER.y);
  check("sound sits on a direction shell (4..130 m from the listener)", d >= 3.99 && d <= 130.1, d.toFixed(2));
  check("ambient category, slider twice, authored volume", p.opts.category === "ambient" && p.opts.sliderTwice === true && p.opts.gain === 0.5,
    JSON.stringify(p.opts));
  check("never a loop", !p.opts.loop);
}

console.log("=========================");
console.log(`ambient frame: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
