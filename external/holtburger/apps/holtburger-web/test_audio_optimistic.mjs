// test_audio_optimistic.mjs — plugins/audio_optimistic.js
//
// This module shipped with NO test and no runner registration (2026-08-03
// round-9 review), which is why all three defects below survived: an
// identity-guard gap of exactly the class fixed at seven entities.js seams,
// a suppression claim never rolled back on the failure paths, and a
// slider-held latch whose documented recovery block was empty because a
// WeakSet cannot be iterated.
//
// The listeners are installed at module scope against `window`, so the fake
// window must exist BEFORE the dynamic import below.

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

// ── fake DOM/window ─────────────────────────────────────────────────────
const listeners = new Map();
const played = [];
let entityMap = new Map();

const makeInst = (guid, x, y, z) => ({
  guid, _disposed: false, soundTableDid: 0x2000_0001,
  root: { position: { x, y, z } },
});

let resolveSoundImpl = async () => ({ waveDid: 0x0A00_0001, volume: 1.0 });

globalThis.window = {
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  getLocalPlayerGuid: () => 0x5000_0001,
  liveScene3d: {
    audioManager: { play: async (waveDid, pos) => { played.push({ waveDid, pos: { ...pos } }); } },
    soundTableCache: { resolveSound: (...a) => resolveSoundImpl(...a) },
    get entityManager() { return { entityMap }; },
  },
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

const mod = await import("./plugins/audio_optimistic.js");
const { playOptimistic, shouldSuppressEcho, SOUND } = mod;
const LPG = 0x5000_0001;

const fire = (type, target) => {
  for (const fn of listeners.get(type) || []) fn({ target });
};
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("\n=== identity guard across the await ===");
{
  entityMap = new Map();
  const inst = makeInst(LPG, 10, 20, 30);
  entityMap.set(LPG, inst);
  // The despawn/respawn happens WHILE resolveSound is in flight — the exact
  // window a relog or portal transition occupies.
  resolveSoundImpl = async () => {
    const fresh = makeInst(LPG, 999, 999, 999);   // same guid, new object
    entityMap.set(LPG, fresh);
    inst._disposed = true;
    return { waveDid: 0x0A00_0001, volume: 1.0 };
  };
  played.length = 0;
  await playOptimistic(SOUND.WIELD, 0x1234);
  await tick();
  check("respawn during resolve ⇒ no cue at the stale position",
    !played.some((p) => p.pos.x === 10),
    `played=${JSON.stringify(played)}`);

  // NEGATIVE CONTROL: `entityMap.has(lpg)` would be TRUE here (the guid was
  // re-added), so a guard written that way passes this scenario while still
  // reading the dead object. Assert the map genuinely holds a DIFFERENT
  // object, which is what makes `.has()` the wrong test.
  check("negative control: same guid present but a different object",
    entityMap.has(LPG) && entityMap.get(LPG) !== inst,
    "the .has() form cannot distinguish these");
}

console.log("\n=== suppression claim is rolled back when nothing played ===");
{
  entityMap = new Map();
  entityMap.set(LPG, makeInst(LPG, 1, 2, 3));
  resolveSoundImpl = async () => null;            // resolution fails
  played.length = 0;
  await playOptimistic(SOUND.PICKUP, 0x1234);
  await tick();
  check("failed resolve plays nothing", played.length === 0);
  check("failed resolve does NOT suppress the server echo",
    shouldSuppressEcho(SOUND.PICKUP, LPG) === false,
    "the genuine 0xF750 would be dropped and the player hears silence");
}
{
  entityMap = new Map();
  const inst = makeInst(LPG, 1, 2, 3);
  inst.root = null;                               // no position
  entityMap.set(LPG, inst);
  resolveSoundImpl = async () => ({ waveDid: 1, volume: 1 });
  await playOptimistic(SOUND.DROP, 0x1234);
  await tick();
  check("missing position does NOT suppress the server echo",
    shouldSuppressEcho(SOUND.DROP, LPG) === false);
}
{
  entityMap = new Map();
  entityMap.set(LPG, makeInst(LPG, 1, 2, 3));
  resolveSoundImpl = async () => ({ waveDid: 0x0A00_0002, volume: 1.0 });
  played.length = 0;
  await playOptimistic(SOUND.WIELD, 0x1234);
  await tick();
  check("a cue that DID play still suppresses its echo",
    played.length === 1 && shouldSuppressEcho(SOUND.WIELD, LPG) === true);
  check("suppression is one-shot",
    shouldSuppressEcho(SOUND.WIELD, LPG) === false);
}
{
  // Ownership token: an earlier fire failing must not revoke a LATER fire's
  // claim on the same key. Without the `=== expiresAt` check the rollback
  // deletes whatever is there and the second cue double-plays.
  entityMap = new Map();
  entityMap.set(LPG, makeInst(LPG, 1, 2, 3));
  let gate;
  const held = new Promise((r) => { gate = r; });
  resolveSoundImpl = async () => { await held; return null; };   // slow + fails
  const slow = playOptimistic(SOUND.RECEIVE, 0x1);
  resolveSoundImpl = async () => ({ waveDid: 3, volume: 1 });     // fast + succeeds
  await playOptimistic(SOUND.RECEIVE, 0x2);
  gate(); await slow; await tick();
  check("a later successful claim survives an earlier fire's rollback",
    shouldSuppressEcho(SOUND.RECEIVE, LPG) === true,
    "the earlier failure revoked the later cue's suppression");
}

console.log("\n=== slider held-set does not latch ===");
{
  const slider = { tagName: "INPUT", type: "range" };
  const other = { tagName: "DIV" };
  entityMap = new Map();
  entityMap.set(LPG, makeInst(LPG, 1, 2, 3));
  resolveSoundImpl = async () => ({ waveDid: 0x0B00_0001, volume: 1.0 });

  played.length = 0;
  fire("pointerdown", slider);
  await tick();
  const grabs1 = played.length;
  check("first pointerdown fires a GRAB cue", grabs1 === 1, `played=${grabs1}`);

  // Pointer drifts off the thumb — this is the case the original comment
  // described and the empty `if (_slidersHeld instanceof WeakSet)` block
  // failed to handle.
  fire("pointerup", other);
  await tick();

  played.length = 0;
  fire("pointerdown", slider);
  await tick();
  check("GRAB still fires after a drift-off pointerup",
    played.length === 1,
    "the slider stayed in _slidersHeld, so its GRAB cue is disabled forever");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
