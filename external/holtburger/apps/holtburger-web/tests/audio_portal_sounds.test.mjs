// audio_portal_sounds.test.mjs — portal whooshes = retail UI sounds.
//
// Retail gmSmartBoxUI: PlaySoundFromCenter(Sound_UI_EnterPortal,
// GetUISoundTable()) on entering portal space (acclient.c:261843-261845)
// and Sound_UI_ExitPortal on leaving (262560-262562); PlaySoundFromCenter
// (383569-383589) picks the row through the SoundTable, rolls its
// probability and uses its volume, with no position.
//
// Fails on the old code: scene3d/portal_space.js played the hard-coded wave
// 0x0A000246 via audioManager.play() at the camera position — no SoundTable
// lookup (resolveSound never called) and no playFromCenter.
//
// Run: node tests/audio_portal_sounds.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";

const calls = [];
const resolved = [];
const scene3d = {
  audioManager: {
    play: async (...a) => { calls.push({ fn: "play", a }); return {}; },
    playFromCenter: async (wave, vol, opts) => { calls.push({ fn: "center", wave, vol, opts }); return {}; },
  },
  soundTableCache: {
    resolveSound: async (stb, st) => {
      resolved.push([stb >>> 0, st >>> 0]);
      return { waveDid: st === 0x6a ? 0x0a000246 : 0x0a000245, volume: 0.8, probability: 1, priority: 0 };
    },
  },
  wasmExports: { resolveClientEnumDid: async (e, c) => (e === 0x10000003 && c === 7 ? 0x2000004b : 0) },
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const origWarn = console.warn;
console.warn = () => {}; // tunnel build needs a renderer; irrelevant here

const ps = await import("../scene3d/portal_space.js");
ps.startPortalSpace(scene3d, {});
for (let i = 0; i < 6; i++) await tick();
console.warn = origWarn;

assert.deepEqual(resolved[0], [0x2000004b, 0x6a], `resolved ${JSON.stringify(resolved)}`);
const enter = calls.find((c) => c.fn === "center");
assert.ok(enter, `calls ${JSON.stringify(calls)}`);
assert.equal(enter.wave, 0x0a000246);
assert.equal(enter.vol, 0.8);
assert.ok(!calls.some((c) => c.fn === "play"), "no positional play");
console.log("  ok  enter whoosh: UI SoundTable row via PlaySoundFromCenter");

// ?portalSound=<hex> override still plays that exact wave, from the centre.
ps.endPortalSpace?.();
calls.length = 0;
console.warn = () => {};
ps.startPortalSpace(scene3d, { enterDid: 0x0a000999 });
for (let i = 0; i < 6; i++) await tick();
console.warn = origWarn;
assert.ok(calls.some((c) => c.fn === "center" && c.wave === 0x0a000999 && c.vol === 1.0), JSON.stringify(calls));
console.log("  ok  explicit ?portalSound wave override plays from the centre");
console.log("\n2 passed");
process.exit(0);
