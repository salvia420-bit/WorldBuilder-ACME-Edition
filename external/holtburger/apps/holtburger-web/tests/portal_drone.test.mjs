// cells-portals-5 (2026-10-13) — the portal-space drone: the tunnel
// animation's Sound / SoundTweaked hooks (scene3d/portal_space.js,
// `?portalDrone`, default on, `=off` escape).
//
// Retail plays the tunnel object's animation as a normal CSequence
// (gmSmartBoxUI::UseTime -> set_sequence_animation(teleportObj, …, 1, 1, 40.0),
// acclient.c:262444), so CSequence::update_internal (340659) runs
// execute_hooks (339683) for every frame the playhead leaves. The retail clip
// 0x030005AC carries one hook: frame 2, SoundTweaked (Both), Wave 0x0A000316
// (3.01 s), prob 1, vol 0.3 — a continuous drone over the 2.975 s loop.
//
// Fails on the old code: portal_space.js ran no hooks (header "NOT PORTED:
// … the tunnel animation's hooks"), exported none of the helpers below, and
// played nothing between the enter and exit whooshes.
//
// Run: node tests/portal_drone.test.mjs   (from apps/holtburger-web/)

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await sleep(0); };

// Browser-ish globals before the import (portal_space reads flags at load).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html" };

const ps = await import("../scene3d/portal_space.js");
const { TAS, hooksCrossed, soundHookPlan, parseTunnelSoundHooks, portalDroneEnabled } = ps;

const DRONE_WAVE = 0x0a000316;
const N = 120; // the retail tunnel clip: 120 frames, played 1..119
const SPAN = N - 1;
const drone = { frame: 2, hookType: 21, direction: 0, volume: 0.3, probability: 1, wave: DRONE_WAVE };

console.log("PART 1 — ?portalDrone flag");
{
  check("absent ⇒ on (default)", portalDroneEnabled("") === true);
  check("on / 1 / unknown ⇒ on", ["on", "1", "banana"].every((v) => portalDroneEnabled(`?portalDrone=${v}`)));
  for (const v of ["off", "0", "false", "no", "OFF"]) check(`${v} ⇒ off`, portalDroneEnabled(`?portalDrone=${v}`) === false);
}

console.log("\nPART 2 — wasm hook arrays");
{
  const hooks = parseTunnelSoundHooks(
    new Uint32Array([2, 7]),
    new Uint32Array([DRONE_WAVE, 0x0a000245]),
    new Float32Array([21, 0, 0.3, 1, 1, -1, 1, 1]),
  );
  check("two hooks parsed", hooks.length === 2, JSON.stringify(hooks));
  check("wave id exact (u32 transport)", hooks[0].wave === DRONE_WAVE, hooks[0].wave.toString(16));
  check("why u32: a Float32Array rounds 0x0A000316", new Float32Array([DRONE_WAVE])[0] !== DRONE_WAVE);
  check("SoundTweaked fields", hooks[0].frame === 2 && hooks[0].hookType === 21 && hooks[0].direction === 0 &&
    Math.abs(hooks[0].volume - 0.3) < 1e-6 && hooks[0].probability === 1);
  check("Sound hook keeps its Backward direction", hooks[1].hookType === 1 && hooks[1].direction === -1);
  check("stale pkg (no getters) ⇒ no hooks", parseTunnelSoundHooks(undefined, undefined, undefined).length === 0);
  check("ragged arrays ⇒ no hooks",
    parseTunnelSoundHooks(new Uint32Array([2]), new Uint32Array([1, 2]), new Float32Array(8)).length === 0 &&
    parseTunnelSoundHooks(new Uint32Array([2]), new Uint32Array([DRONE_WAVE]), new Float32Array(3)).length === 0);
  check("zero wave dropped",
    parseTunnelSoundHooks(new Uint32Array([2]), new Uint32Array([0]), new Float32Array([21, 0, 1, 1])).length === 0);
}

console.log("\nPART 3 — hooksCrossed (retail CSequence::update_internal)");
{
  // 30 fps ticks on the 40 fps clip: 1.33 frames per tick, frames skipped.
  const fireTimes = [];
  let t = 0, prev = 0;
  const dt = 1 / 30;
  const T = 30; // ~10 loops
  for (let i = 0; t < T - 1e-9; i++) {
    t += dt;
    const cur = Math.floor(t * 40);
    for (const h of hooksCrossed(prev, cur, N, [drone])) if (h === drone) fireTimes.push(t);
    prev = cur;
  }
  const finalAbs = prev;
  let expected = 0;
  for (let a = 0; a < finalAbs; a++) if (1 + (a % SPAN) === 2) expected++;
  check("30 fps ticks fire frame 2 exactly once per loop", fireTimes.length === expected && expected >= 10,
    `fires=${fireTimes.length} expected=${expected}`);
  check("first fire as the playhead leaves frame 2 (~0.05 s)", fireTimes[0] > 0.04 && fireTimes[0] < 0.1, String(fireTimes[0]));
  let gapsOk = true;
  for (let i = 1; i < fireTimes.length; i++) {
    const g = fireTimes[i] - fireTimes[i - 1];
    if (Math.abs(g - SPAN / 40) > dt + 1e-6) gapsOk = false;
  }
  check("fires every 119/40 = 2.975 s (± one tick)", gapsOk);

  // Odd frame rates / jittery ticks: still once per loop.
  for (const fps of [10, 24, 60, 144]) {
    let tt = 0, p = 0, n = 0;
    while (tt < 3 * SPAN / 40) {
      tt += (1 / fps) * (0.6 + 0.8 * ((n * 7919) % 13) / 12);
      const c = Math.floor(tt * 40);
      n += hooksCrossed(p, c, N, [drone]).length;
      p = c;
    }
    let exp = 0;
    for (let a = 0; a < p; a++) if (1 + (a % SPAN) === 2) exp++;
    check(`${fps} fps (jittered) fires once per loop`, n === exp, `n=${n} exp=${exp}`);
  }

  // Hidden-tab stall: 10 s in one step fires at most one loop.
  const other = { frame: 50, hookType: 21, direction: 1, volume: 1, probability: 1, wave: 0x0a000001 };
  const stall = hooksCrossed(0, 400, N, [drone, other]);
  check("10 s stall fires at most one loop (each hook once)",
    stall.filter((h) => h === drone).length <= 1 && stall.filter((h) => h === other).length <= 1,
    `n=${stall.length}`);
  check("…and still fires them (one loop)", stall.length === 2, `n=${stall.length}`);
  const bigStall = hooksCrossed(1000, 1000 + 40 * 60, N, [drone]);
  check("60 s stall: one fire", bigStall.length === 1, `n=${bigStall.length}`);

  // Direction: execute_hooks(frame, 1) skips Backward hooks (the shared
  // hook_windows.js gate: the UNKNOWN -2 sentinel, never on disk, fires).
  const mk = (direction) => ({ ...drone, direction });
  const fwd = mk(1), both = mk(0), back = mk(-1), unk = mk(-2);
  const fired = hooksCrossed(0, SPAN, N, [fwd, both, back, unk]);
  check("Forward + Both fire", fired.includes(fwd) && fired.includes(both));
  check("Backward hooks are skipped", !fired.includes(back));
  check("same gate as the entity drain (hookFiresInDirection)", fired.includes(unk));

  // Loop bounds: low frame 1 fires; the high frame (n-1) never does (retail
  // clamps to it and wraps via advance_to_next_animation without its hooks).
  const low = { ...drone, frame: 1 }, high = { ...drone, frame: SPAN }, before = { ...drone, frame: SPAN - 1 };
  const loops = hooksCrossed(0, 3 * SPAN, N, [low, high, before]);
  check("low frame 1 hooks fire", loops.includes(low));
  check("frame n-2 hooks fire", loops.includes(before));
  check("high frame n-1 hooks never fire", !loops.includes(high));

  check("no advance ⇒ nothing", hooksCrossed(5, 5, N, [drone]).length === 0 && hooksCrossed(9, 5, N, [drone]).length === 0);
  check("no hooks / degenerate clip ⇒ nothing", hooksCrossed(0, 50, N, []).length === 0 && hooksCrossed(0, 50, 1, [drone]).length === 0);
}

console.log("\nPART 4 — soundHookPlan (SoundHook / SoundTweakedHook::Execute)");
{
  const p1 = soundHookPlan(drone, () => 0.99);
  check("SoundTweaked prob 1 plays at its volume", p1.play && Math.abs(p1.volume - 0.3) < 1e-6 && !p1.sliderTwice);
  const half = { ...drone, probability: 0.5 };
  let rolls = 0;
  const rng = (v) => () => { rolls++; return v; };
  check("prob 0.5, rng 0.4 ⇒ plays", soundHookPlan(half, rng(0.4)).play === true);
  check("prob 0.5, rng 0.6 ⇒ skipped (probability)", soundHookPlan(half, rng(0.6)).reason === "probability");
  check("the injected rng was used", rolls === 2, String(rolls));
  check("volume 0 is silent", soundHookPlan({ ...drone, volume: 0 }, () => 0).play === false);
  const s = soundHookPlan({ frame: 2, hookType: 1, direction: 0, volume: 1, probability: 1, wave: 0x0a000245 }, () => 0.99);
  check("Sound hook: volume 1, effect slider twice", s.play && s.volume === 1 && s.sliderTwice === true);
  check("no wave ⇒ skipped", soundHookPlan({ ...drone, wave: 0 }).play === false);
  check("other hook types ⇒ skipped", soundHookPlan({ ...drone, hookType: 2 }).play === false);
}

console.log("\nPART 5 — module wiring (teleport tunnel)");
// A tunnel whose Animation carries the retail hook. The rig needs parts for
// ensureTunnel to fetch the Animation; meshes are empty.
const plays = [];
const voices = [];
function makeVoice() {
  const v = {
    stopped: false,
    faded: false,
    source: { stop() { v.stopped = true; }, addEventListener() {} },
    gain: { context: { currentTime: 0 }, gain: { setTargetAtTime() { v.faded = true; } } },
  };
  voices.push(v);
  return v;
}
function makeWasm(withHooks = true) {
  return {
    resolveClientEnumDid: async () => 0,
    fetchEntityAnimationKeyframes: async () => ({
      partCount: 2,
      takePartMeshes: () => [null, null],
      restOrigins: new Float32Array(6),
      restOrientations: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
      free() {},
    }),
    fetchAnimation: async () => {
      const a = { frames: new Float32Array(2 * N * 7), numParts: 2, numFrames: N, free() {} };
      if (withHooks) {
        a.soundHookFrames = new Uint32Array([2]);
        a.soundHookWaves = new Uint32Array([DRONE_WAVE]);
        a.soundHookMeta = new Float32Array([21, 0, 0.3, 1]);
      }
      return a;
    },
  };
}
function makeScene(wasm) {
  return {
    cellContainers3d: new Map(),
    terrainBakedLbs: new Set(),
    envCellBuildInFlight: new Set(),
    audioManager: {
      playFromCenter: async (wave, vol, opts) => { plays.push({ wave: wave >>> 0, vol, opts: opts || {} }); return makeVoice(); },
    },
    wasmExports: wasm,
  };
}
const dronePlays = () => plays.filter((p) => p.wave === DRONE_WAVE);
const run = (sc, secs, dt = 1 / 30) => { for (let t = 0; t < secs - 1e-9; t += dt) ps.tickPortalSpace(sc, dt); };
const diag = () => globalThis.__portalSpace || {};
const warn0 = console.warn;
console.warn = () => {};
{
  const sc = makeScene(makeWasm(true));
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  await flush();
  run(sc, 0.1);
  await flush();
  check("tunnel built with the DAT hook", diag().drone && diag().drone.hooks === 1, JSON.stringify(diag().drone));
  check("drone starts as the playhead leaves frame 2", dronePlays().length === 1, JSON.stringify(plays));
  const p0 = dronePlays()[0];
  check("…from the centre at the hook volume 0.3", p0 && Math.abs(p0.vol - 0.3) < 1e-6 && !p0.opts.sliderTwice && !p0.opts.loop);
  run(sc, 6.0);
  await flush();
  // fires at hook-clock (2 + 119k)/40 s: 0.05, 3.025, 6.0 → 3 in 6.1 s
  check("re-fires every loop while the tunnel holds", dronePlays().length === 3, `n=${dronePlays().length}`);
  check("diag counts the plays", diag().drone.fires === 3 && diag().drone.on === true, JSON.stringify(diag().drone));
  // Arrive at a resident outdoor cell → CONTINUE (≤5 s) → fade-out → exit.
  sc.terrainBakedLbs.add(0xa9b40000);
  ps.signalPortalArrived({ cellId: 0xa9b4001f });
  let firesAtExit = -1, guard = 0;
  while (diag().state !== TAS.WORLD_FADEIN && ps.isPortalSpaceActive() && guard++ < 30 * 10) {
    ps.tickPortalSpace(sc, 1 / 30);
    if (diag().state === TAS.WORLD_FADEIN) firesAtExit = dronePlays().length;
  }
  await flush();
  check("reached WORLD_FADEIN", diag().state === TAS.WORLD_FADEIN, String(diag().state));
  const live = voices.filter((v) => !v.stopped);
  check("exit edge fades out every drone voice", voices.length > 0 && live.length === 0 && voices.every((v) => v.faded),
    `voices=${voices.length} live=${live.length}`);
  run(sc, 0.9);
  await flush();
  check("no drone during the world fade-in", dronePlays().length === firesAtExit, `${dronePlays().length} vs ${firesAtExit}`);
  run(sc, 0.5);
  check("sequence over", !ps.isPortalSpaceActive());
}

console.log("\nPART 6 — escapes and overrides");
{
  const sc = makeScene(makeWasm(true)); // the tunnel (and its hooks) is already built
  plays.length = 0;
  location.search = "?portalDrone=off";
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  run(sc, 4);
  await flush();
  check("?portalDrone=off ⇒ silent tunnel", dronePlays().length === 0 && diag().drone.on === false, JSON.stringify(plays));
  ps.endPortalSpace();
  location.search = "";

  plays.length = 0;
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0, loopDid: 0x0a000999 });
  run(sc, 4);
  await flush();
  check("?portalSoundLoop bed replaces the drone", dronePlays().length === 0 &&
    plays.some((p) => p.wave === 0x0a000999 && p.opts.loop === true), JSON.stringify(plays));
  ps.endPortalSpace();

  // Teardown mid-tunnel stops the drone; a voice that starts after it is
  // stopped at once (generation check).
  plays.length = 0;
  voices.length = 0;
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  run(sc, 0.1);
  ps.endPortalSpace(); // before the playFromCenter promise resolved
  await flush();
  check("a voice resolving after teardown is stopped", voices.length === 1 && voices[0].stopped, `voices=${voices.length}`);
  check("teardown leaves no live drone voice", diag().drone.voices === 0);

  // Re-teleport inside the tunnel keeps the running hook clock (no double fire).
  plays.length = 0;
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  run(sc, 0.1);
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  run(sc, 0.1);
  await flush();
  check("re-teleport inside the tunnel: still one fire this loop", dronePlays().length === 1, `n=${dronePlays().length}`);
  ps.endPortalSpace();
}

console.log("\nPART 7 — login tunnel stays silent until announced");
{
  const sc = makeScene(makeWasm(true));
  plays.length = 0;
  ps.requestLoginPortalSpace(sc, { cellId: 0x01d90123 }); // indoor, not resident
  run(sc, 0.2);
  await flush();
  check("login tunnel running", diag().login === true, JSON.stringify({ login: diag().login, skip: diag().loginSkip }));
  check("no drone before the login tunnel is announced", dronePlays().length === 0, `n=${dronePlays().length}`);
  run(sc, 0.3);
  await flush();
  check("drone starts once it really holds", dronePlays().length === 1, `n=${dronePlays().length}`);
  ps.endPortalSpace();
}
console.warn = warn0;

console.log("\nPART 8 — stale pkg (no soundHook getters) stays silent");
{
  const ps2 = await import("../scene3d/portal_space.js?stale-pkg");
  const sc = makeScene(makeWasm(false));
  plays.length = 0;
  console.warn = () => {};
  ps2.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  await flush();
  for (let t = 0; t < 4; t += 1 / 30) ps2.tickPortalSpace(sc, 1 / 30);
  await flush();
  console.warn = warn0;
  check("animated tunnel, no hooks, no drone", globalThis.__portalSpace.animated === true &&
    globalThis.__portalSpace.drone.hooks === 0 && dronePlays().length === 0, JSON.stringify(globalThis.__portalSpace.drone));
  ps2.endPortalSpace();
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
