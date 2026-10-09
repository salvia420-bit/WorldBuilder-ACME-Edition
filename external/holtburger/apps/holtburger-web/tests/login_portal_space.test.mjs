// 2026-10-09 — login portal space (?loginPortalSpace, default `quick`), the
// tunnel/overlay precompile (?portalSpacePrecompile) and the tunnel frame pace
// (?portalSpaceFps) in scene3d/portal_space.js, wired from app/client_events.js
// (first ENTERED_WORLD of a login scope).
//
// Retail: gmSmartBoxUI enters TAS_TUNNEL at login through the same
// SmartBox::teleport_in_progress edge as a teleport (acclient.c:143092-143095,
// :262420-262424); the client used to stand a new character in a black void
// for ~30 s while the full world rendered every frame.
//
// Real imports (portal_space.js + client_events.js) with minimal stubs.
// Run:
//   cd apps/holtburger-web/
//   node tests/login_portal_space.test.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await sleep(0); };

// Browser-ish globals (before the imports: portal_space reads flags at load).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.requestIdleCallback = () => {};
const noticeEls = [];
globalThis.document = {
  getElementById: () => null,
  createElement: () => { const el = { style: {}, setAttribute() {}, textContent: "" }; noticeEls.push(el); return el; },
  body: { appendChild() {} },
};

const ps = await import("../scene3d/portal_space.js");
const { TAS } = ps;
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

// A scene whose UI sounds are observable (enter 0x6a / exit 0x6b through the
// UI SoundTable — the audio_portal_sounds path).
function makeScene(extra = {}) {
  const sounds = [];
  const sc = {
    cellContainers3d: new Map(),
    terrainBakedLbs: new Set(),
    envCellBuildInFlight: new Set(),
    audioManager: { playFromCenter: async () => ({}) },
    soundTableCache: { resolveSound: async (stb, st) => { sounds.push(st >>> 0); return { waveDid: 0x0a000246, volume: 1, probability: 1 }; } },
    wasmExports: { resolveClientEnumDid: async () => 0x2000004b },
    ...extra,
  };
  sc.sounds = sounds;
  return sc;
}
const run = (sc, secs, dt = 0.05) => { for (let t = 0; t < secs - 1e-9; t += dt) ps.tickPortalSpace(sc, dt); };
const diag = () => globalThis.__portalSpace || {};
const reset = () => { ps.endPortalSpace(); location.search = ""; delete globalThis.__interiorBuildPending; delete globalThis.__sessionHandle; };
const warn0 = console.warn;
const quiet = () => { console.warn = () => {}; };
const loud = () => { console.warn = warn0; };

console.log("PART 1 — flag readers");
{
  const m = ps.loginPortalSpaceMode;
  check("absent ⇒ quick (default)", m("") === "quick");
  check("quick ⇒ quick", m("?loginPortalSpace=quick") === "quick");
  check("retail ⇒ retail", m("?loginPortalSpace=retail") === "retail");
  for (const v of ["off", "0", "false", "no", "OFF"]) check(`${v} ⇒ off`, m(`?loginPortalSpace=${v}`) === "off");
  check("unknown value ⇒ quick", m("?loginPortalSpace=banana") === "quick");
  const r = ps.loginPortalSpaceSkipReason;
  check("no skip on a plain URL", r("") === null && r("?autoLogin=1&account=a") === null);
  check("skip: flag off", r("?loginPortalSpace=off") === "flag");
  check("skip: portalSpace=off / 0 / false / no", ["off", "0", "false", "no"].every((v) => r(`?portalSpace=${v}`) === "portalSpace"));
  check("skip: nullRender=1", r("?nullRender=1") === "nullRender");
  check("skip: renderOnDemand=1", r("?renderOnDemand=1") === "renderOnDemand");
  check("skip: bot=1", r("?bot=1") === "bot");
  check("skip: agent=1", r("?agent=1") === "agent");
  check("skip: wireframe=1 / on", r("?wireframe=1") === "wireframe" && r("?wireframe=on") === "wireframe");
  check("a legacy numeric portalSpace still means on", r("?portalSpace=2") === null);
  const f = ps.portalSpaceFpsIntervalMs;
  check("portalSpaceFps absent ⇒ 30 fps", Math.abs(f("") - 1000 / 30) < 1e-9);
  check("portalSpaceFps off/0/false/no ⇒ 0 (uncapped)", ["off", "0", "false", "no"].every((v) => f(`?portalSpaceFps=${v}`) === 0));
  check("portalSpaceFps=60 ⇒ 16.7 ms", Math.abs(f("?portalSpaceFps=60") - 1000 / 60) < 1e-9);
  check("portalSpaceFps clamps to [10,120]", f("?portalSpaceFps=5") === 100 && Math.abs(f("?portalSpaceFps=500") - 1000 / 120) < 1e-9);
  check("portalSpaceFps garbage ⇒ 30", Math.abs(f("?portalSpaceFps=x") - 1000 / 30) < 1e-9);
}

console.log("PART 2 — tunnel + overlay precompile (canvas bound, every program awaited)");
{
  // A renderer whose compile() hands back one tunnel material with TWO programs
  // (three's Back + Front for a transparent DoubleSide part), not ready yet.
  let readyFlag = false;
  const progs = new Map([["back", { isReady: () => readyFlag }], ["front", { isReady: () => true }]]);
  const fakeMat = {};
  const prevRT = { name: "composer-input" };
  let rt = prevRT;
  const compiledWith = [];
  const renders = [];
  const renderer = {
    autoClear: true,
    getRenderTarget: () => rt,
    setRenderTarget: (t) => { rt = t; },
    compile: (scene) => { compiledWith.push({ scene: scene.name || "overlay", rt }); return new Set([fakeMat]); },
    properties: { get: (m) => (m === fakeMat ? { programs: progs, currentProgram: progs.get("front") } : {}) },
    getClearColor: () => {}, getClearAlpha: () => 1, setClearColor: () => {}, clear: () => {},
    render: (scene) => { renders.push(scene.name || "overlay"); },
  };
  const sc = makeScene({ renderer, wasmExports: { resolveClientEnumDid: async () => 0x2000004b } });
  quiet();
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  await flush(20);
  loud();
  check("the tunnel scene and the overlay were compiled", compiledWith.length === 2, JSON.stringify(compiledWith));
  check("…with the CANVAS bound (null target), not the HalfFloat warm target", compiledWith.every((c) => c.rt === null));
  check("…and the previous target restored", rt === prevRT);
  ps.renderPortalSpaceFrame(renderer, { far: 1000, fov: 50, aspect: 1.5 });
  check("a non-current program still linking ⇒ the tunnel is NOT drawn (black)", !renders.includes("portalSpaceScene"), JSON.stringify(renders));
  check("diag tunnelReady=false", (ps.tickPortalSpace(sc, 0.01), diag().tunnelReady === false));
  readyFlag = true;
  ps.renderPortalSpaceFrame(renderer, { far: 1000, fov: 50, aspect: 1.5 });
  check("every program ready ⇒ the tunnel draws", renders.includes("portalSpaceScene"));
  reset();
}

console.log("PART 3 — warm path: spawn cell already resident ⇒ no tunnel, no sound");
{
  const sc = makeScene();
  sc.cellContainers3d.set(0x860201ad, {});
  check("request accepted (pending)", ps.requestLoginPortalSpace(sc, { cellId: 0x860201ad }) === true && diag().loginPending === true);
  check("nothing runs before the first tick", !ps.isPortalSpaceActive());
  ps.tickPortalSpace(sc, 1 / 60);
  await flush();
  check("first tick: resident ⇒ no tunnel", !ps.isPortalSpaceActive() && !ps.portalSpaceOwnsFrame());
  check("loginSkip = resident", diag().loginSkip === "resident", String(diag().loginSkip));
  check("no enter whoosh on the warm path", sc.sounds.length === 0, JSON.stringify(sc.sounds));
  reset();
}

console.log("PART 4 — cold path: holds with the teleport build-aware rule");
{
  const sc = makeScene();
  sc.envCellBuildInFlight.add(0x86020000);
  ps.requestLoginPortalSpace(sc, { cellId: 0x860201ad });
  ps.tickPortalSpace(sc, 1 / 60);
  check("cold: tunnel up, owns the frame", ps.isPortalSpaceActive() && ps.portalSpaceOwnsFrame());
  check("__portalSpace.login = true, mode quick", diag().login === true && diag().loginMode === "quick");
  run(sc, 0.2);
  await flush();
  check("no whoosh in the first 0.3 s (warm-path backstop window)", sc.sounds.length === 0);
  run(sc, 0.3);
  await flush();
  check("…the retail enter whoosh once it really holds", sc.sounds.filter((s) => s === 0x6a).length === 1, JSON.stringify(sc.sounds));
  check("…and the notice is shown", noticeEls.some((e) => e.style.display === "block"));
  run(sc, 8);
  check("past the 6 s cells wait, build in flight ⇒ still holding", ps.portalSpaceOwnsFrame() && diag().reason === "login-building", diag().reason);
  sc.envCellBuildInFlight.delete(0x86020000);
  globalThis.__interiorBuildPending = true;
  run(sc, 2);
  check("…and while __interiorBuildPending (queued / retry gap, not in flight)", ps.portalSpaceOwnsFrame() && diag().reason === "login-building");
  sc.cellContainers3d.set(0x860201ad, {});
  run(sc, 0.1);
  check("container appears ⇒ released (quick: fading)", !ps.portalSpaceOwnsFrame() || ps.portalSpaceOwnsFrame() && diag().state === TAS.TUNNEL_FADEOUT, String(diag().state));
  run(sc, 3);
  await flush();
  check("sequence completes", !ps.isPortalSpaceActive());
  check("exit whoosh played once", sc.sounds.filter((s) => s === 0x6b).length === 1, JSON.stringify(sc.sounds));
  reset();
}

console.log("PART 5 — failsafes");
{
  const sc = makeScene();
  sc.envCellBuildInFlight.add(0x86020000);
  ps.requestLoginPortalSpace(sc, { cellId: 0x860201ad });
  ps.tickPortalSpace(sc, 1 / 60);
  run(sc, 59, 0.25);
  check("still holding at 59 s while the build is in flight", ps.portalSpaceOwnsFrame());
  run(sc, 2, 0.25);
  // "released" = the tunnel left TUNNEL (quick mode then fades for 1 s).
  check("60 s hard cap releases", diag().state !== TAS.TUNNEL && diag().reason === "failsafe(build-wait)", `${diag().state} ${diag().reason}`);
  reset();
  const sc2 = makeScene();
  ps.requestLoginPortalSpace(sc2, { cellId: 0x860201ad }); // never resident, nothing building
  ps.tickPortalSpace(sc2, 1 / 60);
  run(sc2, 5.5);
  check("not building: holds up to the 6 s cells wait", ps.portalSpaceOwnsFrame());
  run(sc2, 1);
  check("…then the cells-wait failsafe releases", diag().state !== TAS.TUNNEL && diag().reason === "failsafe(cells-wait)", `${diag().state} ${diag().reason}`);
  reset();
  const sc3 = makeScene();
  ps.requestLoginPortalSpace(sc3, { cellId: 0xa9b4001f }); // outdoor, never baked
  ps.tickPortalSpace(sc3, 1 / 60);
  globalThis.__interiorBuildPending = true; // irrelevant outdoors
  run(sc3, 6.5);
  check("outdoor spawn: 6 s cap, never 'login-building'", diag().state !== TAS.TUNNEL && diag().reason === "failsafe(cells-wait)", `${diag().state} ${diag().reason}`);
  reset();
}

console.log("PART 6 — spawn cell resolution (pose reads 0 at EnteredWorld)");
{
  const sc = makeScene();
  sc.cellContainers3d.set(0x860201ad, {});
  let pose = 0, snap = 0;
  globalThis.__sessionHandle = {
    getLocalPlayerPose: () => ({ landblockId: pose, x: 0, y: 0, z: 0, free() {} }),
    getCurrentCellId: () => snap,
  };
  ps.requestLoginPortalSpace(sc, {});
  run(sc, 0.3);
  check("cell 0: the decision waits (up to 0.5 s)", diag().loginPending === true && !ps.isPortalSpaceActive());
  snap = 0x860201ad; // the cell-scene snapshot resolves first
  ps.tickPortalSpace(sc, 1 / 60);
  check("getCurrentCellId fallback resolves ⇒ resident ⇒ skipped", !ps.isPortalSpaceActive() && diag().loginSkip === "resident");
  reset();
  // Never resolves within 0.5 s ⇒ starts silently; the cell then resolves resident
  // on the first evaluations ⇒ the warm-path backstop ends it, no sound.
  const sc2 = makeScene();
  pose = 0; snap = 0;
  globalThis.__sessionHandle = {
    getLocalPlayerPose: () => ({ landblockId: pose, x: 0, y: 0, z: 0, free() {} }),
    getCurrentCellId: () => snap,
  };
  ps.requestLoginPortalSpace(sc2, {});
  run(sc2, 0.55);
  check("unresolved after 0.5 s ⇒ the tunnel starts (silently)", ps.isPortalSpaceActive() && sc2.sounds.length === 0);
  pose = 0x860201ad;
  sc2.cellContainers3d.set(0x860201ad, {});
  ps.tickPortalSpace(sc2, 1 / 60);
  await flush();
  check("backstop: resident on the first evaluations ⇒ ends at once, no fades", !ps.isPortalSpaceActive() && diag().loginSkip === "resident-late");
  check("…and no sound at all", sc2.sounds.length === 0, JSON.stringify(sc2.sounds));
  reset();
}

console.log("PART 7 — pending without a scene; teleports win");
{
  check("request with scene3d=null is kept pending", ps.requestLoginPortalSpace(null, { cellId: 0x860201ad }) === true && diag().loginPending === true);
  const sc = makeScene();
  ps.tickPortalSpace(sc, 1 / 60);
  check("…consumed by the first tick with a scene", ps.isPortalSpaceActive() && diag().login === true);
  reset();
  const sc2 = makeScene();
  ps.requestLoginPortalSpace(sc2, { cellId: 0x860201ad });
  ps.startPortalSpace(sc2, { enterDid: 0, exitDid: 0 }); // kind=33 before the first tick
  check("a teleport during the pending login drops the request", diag().loginPending === false && diag().login === false);
  ps.tickPortalSpace(sc2, 1 / 60);
  run(sc2, 2);
  check("…and keeps teleport semantics (waits for its arrival)", ps.portalSpaceOwnsFrame() && diag().arrived === false);
  reset();
  const sc3 = makeScene();
  ps.requestLoginPortalSpace(sc3, { cellId: 0x860201ad });
  ps.tickPortalSpace(sc3, 1 / 60);
  check("login tunnel running", diag().login === true);
  ps.startPortalSpace(sc3, { enterDid: 0, exitDid: 0 });
  check("a teleport during the login tunnel switches to teleport semantics", diag().login === false && diag().arrived === false);
  sc3.cellContainers3d.set(0x860201ad, {});
  run(sc3, 3);
  check("…so a resident spawn cell no longer releases it (needs kind=66)", ps.portalSpaceOwnsFrame());
  reset();
}

console.log("PART 8 — quick vs retail exit; t stamps");
{
  const runToReady = async (mode) => {
    location.search = mode ? `?loginPortalSpace=${mode}` : "";
    const sc = makeScene();
    ps.requestLoginPortalSpace(sc, { cellId: 0x860201ad });
    ps.tickPortalSpace(sc, 1 / 60);
    run(sc, 1);
    await sleep(3);
    sc.cellContainers3d.set(0x860201ad, {});
    ps.tickPortalSpace(sc, 1 / 60); // TUNNEL -> CONTINUE
    return sc;
  };
  let sc = await runToReady("");
  check("ready ⇒ CONTINUE", diag().state === TAS.CONTINUE);
  ps.tickPortalSpace(sc, 1 / 60);
  check("quick: TUNNEL_FADEOUT on the first tick after ready (no CONTINUE floor)", diag().state === TAS.TUNNEL_FADEOUT, String(diag().state));
  await sleep(3);
  run(sc, 1.05);
  await sleep(3);
  run(sc, 1.1);
  const t = diag().t;
  check("t.start < t.ready < t.reveal < t.done (login)", t.start > 0 && t.start < t.ready && t.ready < t.reveal && t.reveal < t.done, JSON.stringify(t));
  reset();
  sc = await runToReady("retail");
  run(sc, 1.9);
  check("retail: CONTINUE holds the 2 s floor", diag().state === TAS.CONTINUE);
  run(sc, 3.5);
  check("retail: then fades (5 s cap at the latest)", diag().state !== TAS.CONTINUE);
  reset();
  // Teleports stamp too.
  const tp = makeScene();
  let exits = 0;
  ps.startPortalSpace(tp, { enterDid: 0, exitDid: 0, onExit: () => { exits++; } });
  await sleep(3);
  ps.signalPortalArrived({ cellId: 0x01d90123 });
  tp.cellContainers3d.set(0x01d90123, {});
  ps.tickPortalSpace(tp, 1 / 60);
  await sleep(3);
  run(tp, 5.2);
  await sleep(3);
  run(tp, 1.2);
  await sleep(3);
  run(tp, 1.2);
  const tt = diag().t;
  check("t.start < t.ready < t.reveal < t.done (teleport)", tt.start < tt.ready && tt.ready < tt.reveal && tt.reveal < tt.done, JSON.stringify(tt));
  check("teleport onExit fired once", exits === 1);
  reset();
}

console.log("PART 9 — skip reasons on request");
{
  for (const [q, why] of [["?loginPortalSpace=off", "flag"], ["?portalSpace=off", "portalSpace"], ["?nullRender=1", "nullRender"],
    ["?renderOnDemand=1", "renderOnDemand"], ["?bot=1", "bot"], ["?agent=1", "agent"], ["?wireframe=1", "wireframe"]]) {
    location.search = q;
    const sc = makeScene();
    const r = ps.requestLoginPortalSpace(sc, { cellId: 0x860201ad });
    ps.tickPortalSpace(sc, 1 / 60);
    check(`${q} ⇒ no tunnel, loginSkip=${why}`, r === false && !ps.isPortalSpaceActive() && diag().loginSkip === why, String(diag().loginSkip));
    reset();
  }
}

console.log("PART 10 — loop pacing while the tunnel owns the frame");
{
  check("inactive: base interval unchanged (0 = rAF)", ps.portalSpaceFrameIntervalMs(0) === 0 && ps.portalSpaceFrameIntervalMs(100) === 100);
  const sc = makeScene();
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  check("owning: max(base, 33.3 ms)", Math.abs(ps.portalSpaceFrameIntervalMs(0) - 1000 / 30) < 1e-9 && ps.portalSpaceFrameIntervalMs(100) === 100);
  reset();
  check("ended: back to the base interval", ps.portalSpaceFrameIntervalMs(0) === 0);
  const src = (await import("node:fs")).readFileSync(new URL("../scene3d/index.js", import.meta.url), "utf8");
  check("index.js scheduleNext paces with portalSpaceFrameIntervalMs(_frameIntervalMs)",
    /const _ivl = portalSpaceFrameIntervalMs\(_frameIntervalMs\);\s*\n\s*if \(_ivl > 0\)/.test(src) && /pacerDelayMs\(_ivl, lastFrameTs, now\)/.test(src));
}

console.log("PART 11 — client_events.js: first ENTERED_WORLD only");
{
  const state = { spawningCharId: null, spawnedPlayerGuid: null, enteredWorld: false, lastPredictionTime: 0 };
  const D = {
    loginStatus: { innerHTML: "" }, postSpawn: { hidden: true }, teleportBtn: { disabled: true },
    chatPanel: { hidden: true }, chatInput: { disabled: true }, chatSendBtn: { disabled: true },
    setBootState() {}, setLocalPlayerGuid() {}, getLocalPlayerGuid: () => state.spawnedPlayerGuid,
    populateSkyDescFromRegion: async () => 0, ensureTerrainAroundLandblock() {}, ensureBuildingAabbsAroundLandblock() {},
    ensureCellContainersForLandblock() {}, __resetEntDrainPending() {},
    EVT_GUARD_ON: true, CMD_INTERP_ON: false, CAST_MOVE_ON: false,
  };
  for (const k of Object.keys(state)) Object.defineProperty(D, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  const evt = () => { const e = { kind: ClientEventKind.ENTERED_WORLD, u32Payload: 0x50000001, u32Payload2: 0, stringPayload: "" }; e.free = () => {}; return e; };
  globalThis.__evtGuardStats = { catches: 0, byKind: {}, last: null };
  const log0 = console.log;
  quiet(); console.log = () => {};
  try { dispatchClientEvent(evt(), D); } finally { console.log = log0; }
  await flush(20);
  loud();
  check("login entry ⇒ a login portal space request", diag().loginPending === true && state.enteredWorld === true, JSON.stringify({ p: diag().loginPending, ew: state.enteredWorld }));
  ps.endPortalSpace(); // drops the pending request
  quiet(); console.log = () => {};
  try { dispatchClientEvent(evt(), D); } finally { console.log = log0; }
  await flush(20);
  loud();
  check("death respawn (enteredWorld already true) ⇒ no new request", diag().loginPending === false);
  const src = (await import("node:fs")).readFileSync(new URL("../app/client_events.js", import.meta.url), "utf8");
  const arm = src.slice(src.indexOf("evt.kind === ClientEventKind.ENTERED_WORLD"));
  check("isLoginEntry is read before the evtGuard flips enteredWorld",
    arm.indexOf("const isLoginEntry = !D.enteredWorld;") >= 0 && arm.indexOf("const isLoginEntry = !D.enteredWorld;") < arm.indexOf("D.enteredWorld = true;"));
  reset();
}

// PART F (2026-10-09 Phase 4): quick login mode fades the tunnel in 0.25 s (the retail 1 s fade ran on the
// frame-dt clock and stretched to 2.5-3.2 s under load); retail mode / teleports keep the 1 s fade.
{
  const { createPortalSequencer } = await import("../scene3d/portal_space.js");
  const run = (opts) => {
    const q = createPortalSequencer(() => 0.5);
    q.begin(opts);
    q.tick(0.05, { worldReady: true }); // TUNNEL -> CONTINUE
    let t = 0, guard = 0;
    while (q.state !== 6 && guard++ < 1000) { q.tick(0.05, { worldReady: true, frame: 0 }); t += 0.05; }
    return t; // seconds from CONTINUE to WORLD_FADEIN (exitSound)
  };
  const quick = run({ minContinue: 0, maxContinue: 0, fadeOut: 0.25 });
  const quickDefault = run({ minContinue: 0, maxContinue: 0 });
  check("PART F: quick fade-out reaches the world fade-in in ~0.3 s", quick < 0.45, `t=${quick.toFixed(2)}`);
  check("PART F: omitted fadeOut keeps the retail 1 s fade", quickDefault >= 1.0 && quickDefault < 1.2, `t=${quickDefault.toFixed(2)}`);
  const src = (await import("node:fs")).readFileSync(new URL("../scene3d/portal_space.js", import.meta.url), "utf8");
  check("PART F: login quick mode passes fadeOut: QUICK_FADE_OUT", /_seq\.begin\(\{ minContinue: 0, maxContinue: 0, fadeOut: QUICK_FADE_OUT \}\)/.test(src));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
