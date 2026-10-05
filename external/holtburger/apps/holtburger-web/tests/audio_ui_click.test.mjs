// audio_ui_click.test.mjs — HUD click chime = retail UI sound.
//
// Retail: UI element sounds -> SoundManager::PlaySoundFromCenter(stype,
// table) (acclient.c:383569-383589, MediaMachine::Update_Sound 162243) and
// the UI SoundTable is ClientUISystem::GetUISoundTable (401286:
// GetByEnum(0x10000003, 7)).
//
// Fails on the old code: plugins/ui_click_sounds.js resolved UI_ButtonPress
// against the PLAYER's SoundTable (0x20000001 fallback) and called
// audioManager.play() at the raw AC-frame player position with gain
// volume*0.5 — so no playFromCenter call, wrong table, wrong volume.
//
// Run: node tests/audio_ui_click.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";

const calls = [];
const resolved = [];
globalThis.window = globalThis;
window.getLocalPlayerGuid = () => 0x50000001;
window.liveScene3d = {
  audioManager: {
    play: async (...a) => { calls.push({ fn: "play", a }); return {}; },
    playFromCenter: async (wave, vol) => { calls.push({ fn: "center", wave, vol }); return {}; },
  },
  soundTableCache: {
    resolveSound: async (stb, st) => {
      resolved.push([stb >>> 0, st >>> 0]);
      return { waveDid: 0x0a000072, volume: 0.9, probability: 1, priority: 0 };
    },
  },
  entityManager: { entityMap: new Map([[0x50000001, { soundTableDid: 0x20000001, root: { position: { x: 5, y: 6, z: 7 } } }]]) },
  wasmExports: { resolveClientEnumDid: async (e, c) => (e === 0x10000003 && c === 7 ? 0x2000004b : 0) },
};

const { playUiClickSound } = await import("../plugins/ui_click_sounds.js");
await playUiClickSound();

assert.deepEqual(resolved, [[0x2000004b, 0x72]], `resolved ${JSON.stringify(resolved)}`);
assert.equal(calls.length, 1);
assert.equal(calls[0].fn, "center", "played from the centre, not positionally");
assert.equal(calls[0].vol, 0.9, "row volume, no made-up x0.5");
console.log("  ok  UI_ButtonPress: UI SoundTable via EnumIDMap, PlaySoundFromCenter, row volume");
console.log("\n1 passed");
