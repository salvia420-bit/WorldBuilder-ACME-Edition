// tests/film_runtime_world.test.mjs
//
// WHY: AC Film Mode moves the hidden player (the streaming dolly) between
// sites, decides when the world around the camera is complete enough to roll,
// directs the player-as-actor and sets each shot's look. Wrong answers here
// cost whole takes: a readiness gate that passes during the portal tunnel or
// before the terrain mesh attaches records pop-in; one that never passes
// hangs the shoot; a '/'-prefixed teleport is SPOKEN aloud by ACE; an
// unresolved emote becomes an '@' admin command; a prewarm that calls
// loadTerrainRing shifts the player's fixed grid; a look that is not fully
// restored leaks fog, a grade or DoF into the next site (or into a person's
// later session). This suite EXECUTES runtime/look.js and runtime/world.js
// against fake engine seams driven by a fake clock:
//   L1  look.apply: named/numeric timeOfDay (+ terrain relight), dayGroup, fog as
//       environFogFor-shaped objects (pinned to the REAL environ_override.js),
//       fresh only when the fog changes — the same fog keeps its object, so the
//       REAL environ_override roll-in is not restarted on re-apply (review
//       contracts-5 / seams-3 / gate-1), exposure, grade presets through the REAL
//       color_grade.js ColorGradeEffect + __grade handle, bloom, vignette, DoF
//       (window.__dof; a reported no-op without it — owner decision: DoF ships);
//   L2  snapshot JSON-safe; a new look restores keys it omits (merge keeps them);
//       restore() puts back every original (the ?skytime pin, the server fog
//       object identity, DoF enabled last); bad values reported, never thrown;
//   W1  teleport/command validation ('@' only, single line, ≤200, refused verbs,
//       not-in-world), sendChat; a sent teleport parks the film viewer cell
//       (injected parkViewerCell — review seams-11);
//   W2  ready(): portal space active → not ready; terrain baked but not yet
//       attached / parked / guard keys in flight / PVS sweep incomplete → not
//       ready; scene settle + settleSec; every check reported; a pending
//       teleport waits for the portal; interiors (envCellLoadedLbs,
//       __interiorBuildPending); timeoutSec is never exceeded;
//   W3  prewarm(): landblocks around points, populate*ForLandblock deduped and
//       skipped in the player's ring, corridor.ensure, _runTerrainRingBatch ring
//       cover (never loadTerrainRing), statics/buildings/envcells refired until
//       baked, sealed dungeons, timeouts;
//   W4  avatar() via setFilmHidden (fallback opacity);
//   W5  actor(): DAT-resolved soul emotes via __routeSlashCommand (box freed;
//       unknown tokens refused), motions (held vs one-shot), face = −compass yaw,
//       moveTo via moveToPosition + pursuitStatus (arrived / failed / timeout).
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`); DoF additionally `?filmDof=on` (DEFAULT OFF).
// Run from apps/holtburger-web/: node tests/film_runtime_world.test.mjs

import assert from "node:assert/strict";

const LK = await import("../scene3d/film/runtime/look.js");
const WD = await import("../scene3d/film/runtime/world.js");
const ENV = await import("../scene3d/environ_override.js");
const CG = await import("../scene3d/color_grade.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);

const LB = 0xa9b40000;
const LBX = 0xa9 * 192;
const LBY = 0xb4 * 192;

// ---------------------------------------------------------------------------
// look fakes
// ---------------------------------------------------------------------------

/** A window.__dof stand-in with the seam's validation (SEAMS.md). */
function makeDof() {
  const st = { enabled: false, focusDistance: 10, focusRange: 5, bokehScale: 1, target: null, flips: 0 };
  return {
    st,
    get enabled() { return st.enabled; },
    set enabled(v) { if (!!v !== st.enabled) { st.enabled = !!v; st.flips += 1; } },
    get focusDistance() { return st.focusDistance; },
    set focusDistance(v) { if (!(Number.isFinite(v) && v >= 0)) throw new RangeError(`focusDistance ${v}`); st.focusDistance = v; },
    get focusRange() { return st.focusRange; },
    set focusRange(v) { if (!(Number.isFinite(v) && v > 0)) throw new RangeError(`focusRange ${v}`); st.focusRange = v; },
    get bokehScale() { return st.bokehScale; },
    set bokehScale(v) { if (!(Number.isFinite(v) && v >= 0)) throw new RangeError(`bokehScale ${v}`); st.bokehScale = v; },
    get target() { return st.target; },
    set target(v) { st.target = v; },
  };
}

/** Live + window with the index.js look setters (same bodies as scene3d/index.js) and the REAL grade handle. */
function makeLookEnv({ dof = true, bloom = true, vignette = true, pin = null } = {}) {
  const sh = {
    sky: [], days: [], opts: { 5: false },
    setSkyTimeOverride(t) { this.sky.push(t); return true; },
    setGameDayOverride(d, y) { this.days.push([d, y]); return true; },
    isCharacterOptionEnabled(o) { return !!this.opts[o]; },
  };
  const pipeline = {
    bloom: bloom ? { intensity: 1.0, luminanceMaterial: { threshold: 1.1 } } : null,
    vignette: vignette ? { darkness: 0.3, offset: 0.5 } : null,
  };
  const live = { renderer: { toneMappingExposure: 5 }, atmospherePipeline: pipeline, sessionHandle: sh };
  const relights = [];
  const serverFog = ENV.environFogFor(2); // a server AdminEnvirons BlueFog already active
  const win = {
    __skyTimePin: pin,
    __environFogOverride: serverFog,
    __setExposure: (v) => { live.renderer.toneMappingExposure = +v; return live.renderer.toneMappingExposure; },
    __setBloomIntensity: (v) => { if (!pipeline.bloom) return null; pipeline.bloom.intensity = +v; return pipeline.bloom.intensity; },
    __setBloomThreshold: (v) => { const b = pipeline.bloom; if (!b?.luminanceMaterial) return null; b.luminanceMaterial.threshold = +v; return b.luminanceMaterial.threshold; },
    __setVignetteDarkness: (v) => { if (!pipeline.vignette) return null; pipeline.vignette.darkness = +v; return pipeline.vignette.darkness; },
    __setVignetteOffset: (v) => { if (!pipeline.vignette) return null; pipeline.vignette.offset = +v; return pipeline.vignette.offset; },
    __terrainLightState: () => ({ scale: 0.55 }),
    __setTerrainLightScale: (v) => { relights.push(v); return v; },
  };
  if (dof) win.__dof = makeDof();
  // The REAL ColorGradeEffect + window.__grade handle.
  const prevWindow = globalThis.window;
  globalThis.window = win;
  const effect = new CG.ColorGradeEffect({ nightSource: () => 0.0 });
  CG.installColorGradeHandle(effect);
  if (prevWindow === undefined) delete globalThis.window;
  else globalThis.window = prevWindow;
  const look = LK.createLook({ liveScene3d: live, sessionHandle: sh, window: win });
  return { look, live, win, sh, pipeline, effect, relights, serverFog };
}

check("L1 apply(): every look key reaches its live handle; fog objects match environFogFor; grade drives the REAL effect", () => {
  const E = makeLookEnv();
  const r = E.look.apply({
    timeOfDay: "golden",
    dayGroup: { day: 3, year: 10 },
    fog: "white",
    exposure: 3.5,
    grade: "warm",
    bloom: { intensity: 0.8, threshold: 1.0 },
    vignette: { darkness: 0.5, offset: 0.3 },
    dof: { focusDistance: 12, focusRange: 4, bokehScale: 2 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(E.sh.sky, [0.82]);
  assert.ok(E.relights.length >= 1, "terrain re-light forced after the time jump");
  assert.deepEqual(E.sh.days, [[3, 10]]);
  // Fog: exactly the environFogFor shape; a fresh object only when the fog changes.
  assert.deepEqual(E.win.__environFogOverride, ENV.environFogFor(3));
  assert.equal(r.applied.fog.changed, true, "the server's BlueFog → WhiteFog is a change");
  for (const [name, opt] of Object.entries(LK.LOOK_FOG_OPTIONS)) assert.deepEqual(LK.lookFogOverride(name), ENV.environFogFor(opt), name);
  for (const opt of [1, 2, 3, 4, 5]) assert.deepEqual({ ...LK.LOOK_FOG_ROWS[opt] }, { ...ENV.ENVIRON_FOG[opt] }, `row ${opt} mirrors environ_override.js`);
  const f1 = E.win.__environFogOverride;
  const again = E.look.apply({ fog: "white" }, { merge: true });
  assert.equal(E.win.__environFogOverride, f1, "the same fog keeps its object (a fresh identity would restart the retail roll-in)");
  assert.equal(again.applied.fog.changed, false);
  assert.equal(E.live.renderer.toneMappingExposure, 3.5);
  // Grade: both day and night sets = the preset; the real effect's uniforms follow.
  assert.deepEqual(E.win.__grade.day, { ...LK.GRADE_PRESETS.warm, wb: [...LK.GRADE_PRESETS.warm.wb], tint: [...LK.GRADE_PRESETS.warm.tint], lift: [...LK.GRADE_PRESETS.warm.lift], gain: [...LK.GRADE_PRESETS.warm.gain], gamma: [...LK.GRADE_PRESETS.warm.gamma] });
  assert.deepEqual(E.win.__grade.night, E.win.__grade.day);
  E.effect.update(null, null, 0.016);
  const u = E.effect.uniforms;
  near(u.get("uWB").value.x, 1.08, 1e-6);
  near(u.get("uWB").value.z, 0.88, 1e-6);
  near(u.get("uContrast").value, 1.1, 1e-9);
  near(u.get("uSat").value, 1.08, 1e-9);
  assert.equal(u.get("uMix").value, 1);
  assert.equal(E.pipeline.bloom.intensity, 0.8);
  assert.equal(E.pipeline.bloom.luminanceMaterial.threshold, 1.0);
  assert.equal(E.pipeline.vignette.darkness, 0.5);
  assert.equal(E.pipeline.vignette.offset, 0.3);
  // DoF really driven (owner decision: ships in v1); enabled flipped once, after the values.
  assert.equal(E.win.__dof.focusDistance, 12);
  assert.equal(E.win.__dof.focusRange, 4);
  assert.equal(E.win.__dof.bokehScale, 2);
  assert.equal(E.win.__dof.enabled, true);
  assert.equal(E.win.__dof.st.flips, 1);
  assert.equal(E.look.activeTimeOfDay(), 0.82);
  // Named presets and every grade preset is a full param set.
  assert.deepEqual(LK.LOOK_TIME_PRESETS, { night: 0.0, dawn: 0.21, morning: 0.33, noon: 0.5, golden: 0.82, dusk: 0.89 });
  for (const [k, p] of Object.entries(LK.GRADE_PRESETS)) {
    assert.deepEqual(Object.keys(p).sort(), Object.keys(CG.GRADE_DAY).sort(), k);
  }
});

check("L2 snapshot / partial looks / restore(): originals back, ?skytime pin honoured, fog identity kept", () => {
  const E = makeLookEnv({ pin: 0.4 });
  const grade0 = JSON.parse(JSON.stringify(E.win.__grade.day));
  const night0 = JSON.parse(JSON.stringify(E.win.__grade.night));
  E.look.apply({ timeOfDay: 0.3, fog: "red", exposure: 2, grade: "bleach", dof: { focusRange: 2 } });
  const snap = E.look.snapshot();
  assert.equal(snap.active, true);
  assert.equal(snap.look.timeOfDay, 0.3);
  assert.equal(snap.look.fog, "RedFog");
  assert.equal(snap.saved.exposure.value, 5);
  assert.equal(snap.saved.fog.value, "BlueFog");
  assert.equal(snap.saved.timeOfDay.pin, 0.4);
  assert.doesNotThrow(() => JSON.stringify(snap));
  // A new (non-merge) look restores the keys it omits.
  E.look.apply({ fog: "none", vignette: 0.7 });
  assert.equal(E.win.__environFogOverride, null, "'none' clears the override for the take");
  assert.equal(E.live.renderer.toneMappingExposure, 5, "exposure back (omitted)");
  assert.deepEqual(E.win.__grade.day, grade0, "grade back (omitted)");
  near(E.sh.sky[E.sh.sky.length - 1], 0.4, 0, "time back to the ?skytime pin (omitted)");
  assert.equal(E.win.__dof.enabled, false, "DoF back off (omitted)");
  assert.equal(E.look.activeTimeOfDay(), null);
  assert.equal(E.pipeline.vignette.darkness, 0.7);
  // merge keeps earlier keys.
  E.look.apply({ exposure: 4 }, { merge: true });
  assert.equal(E.pipeline.vignette.darkness, 0.7);
  assert.equal(E.live.renderer.toneMappingExposure, 4);
  const r = E.look.restore();
  assert.deepEqual(r.restored.sort(), ["exposure", "fog", "vignette"].sort());
  assert.equal(E.win.__environFogOverride, E.serverFog, "the server's fog object identity is put back");
  assert.equal(E.live.renderer.toneMappingExposure, 5);
  assert.equal(E.pipeline.vignette.darkness, 0.3);
  assert.deepEqual(E.win.__grade.night, night0);
  assert.equal(E.look.snapshot().active, false);
  assert.deepEqual(E.look.restore().restored, [], "idempotent");
  // Without a pin the sky clears with NaN; dayGroup clears with the 0xFFFFFFFF pair.
  const F = makeLookEnv();
  F.look.apply({ timeOfDay: "night", dayGroup: { day: 1, year: 2 } });
  F.look.restore();
  assert.ok(Number.isNaN(F.sh.sky[F.sh.sky.length - 1]));
  assert.deepEqual(F.sh.days[F.sh.days.length - 1], [0xffffffff, 0xffffffff]);
});

check("L2 missing handles are clean, reported no-ops; bad values are errors, never throws", () => {
  const E = makeLookEnv({ dof: false, bloom: false, vignette: false });
  delete E.win.__grade;
  const r = E.look.apply({ dof: { focusDistance: 3 }, bloom: 0.5, vignette: { darkness: 0.4 }, grade: "cool", sparkle: true });
  assert.equal(r.ok, true);
  assert.equal(r.applied.dof.ok, false);
  assert.match(r.applied.dof.skipped, /filmDof=on/);
  assert.equal(r.applied.bloom.ok, false);
  assert.equal(r.applied.vignette.ok, false);
  assert.equal(r.applied.grade.ok, false);
  assert.ok(r.warnings.some((w) => w.key === "sparkle"));
  assert.equal(E.look.restore().ok, true);
  // Bad values.
  const G = makeLookEnv();
  const b = G.look.apply({ timeOfDay: "teatime", fog: "purple", grade: "sepia", exposure: -1, dayGroup: { day: 1.5, year: 2 }, dof: { focusRange: 0 } });
  assert.equal(b.ok, false);
  assert.deepEqual(b.errors.map((e) => e.key).sort(), ["dayGroup", "dof", "exposure", "fog", "grade", "timeOfDay"]);
  assert.equal(G.live.renderer.toneMappingExposure, 5, "nothing applied for a bad exposure");
  assert.equal(G.look.apply("noon").ok, false);
  G.look.restore();
  assert.equal(G.win.__environFogOverride, G.serverFog);
  // "Always daylight" fights the time override → warned.
  const H = makeLookEnv();
  H.sh.opts[5] = true;
  const w = H.look.apply({ timeOfDay: "dusk" });
  assert.ok(w.warnings.some((x) => /Always daylight/.test(x.message)));
  // Before the SkyDesc lands setSkyTimeOverride returns false: reported, but the
  // requested time stays active so the film clock keeps re-asserting it.
  const K = makeLookEnv();
  K.sh.setSkyTimeOverride = (t) => { K.sh.sky.push(t); return false; };
  const rk = K.look.apply({ timeOfDay: "dawn" });
  assert.equal(rk.applied.timeOfDay.ok, false);
  assert.match(rk.applied.timeOfDay.note, /not loaded/);
  assert.ok(rk.warnings.some((x) => x.key === "timeOfDay"));
  assert.equal(K.look.activeTimeOfDay(), 0.21);
  assert.throws(() => LK.lookFogOverride("mauve"), RangeError);
  assert.equal(LK.lookFogOverride("none"), null);
});

check("L1 fog re-apply is a no-op (review contracts-5 / seams-3 / gate-1): same object, the REAL environ_override roll-in is not restarted; a changed fog is fresh", () => {
  const E = makeLookEnv();
  // The REAL AdminEnvirons state machine on a fake wall clock, synced + fog-ticked every 100 ms frame as loop.js does.
  let ms = 0;
  const env = ENV.createEnvironOverride({ now: () => ms / 1000 });
  const runLoop = (sec) => {
    for (const end = ms + sec * 1000; ms < end; ms += 100) {
      env.sync(E.win.__environFogOverride);
      env.fogTick();
    }
  };
  const a = E.look.apply({ fog: "white", grade: "cool" });
  assert.equal(a.applied.fog.changed, true);
  const f1 = E.win.__environFogOverride;
  assert.deepEqual(f1, ENV.environFogFor(3));
  runLoop(25);
  assert.ok(env.transition >= 1 && env.fogT >= 1, `rolled in (transition ${env.transition}, fogT ${env.fogT})`);
  const sets = env.stats().sets;
  // Prepare again after the rehearsal / the next shot at the same site: the whole look re-applied.
  const b = E.look.apply({ fog: "white", grade: "cool" });
  assert.equal(b.ok, true);
  assert.equal(b.applied.fog.changed, false);
  assert.equal(b.applied.fog.value, "WhiteFog");
  assert.equal(E.win.__environFogOverride, f1, "same object identity");
  runLoop(1);
  assert.equal(env.stats().sets, sets, "no new AdminEnvirons message reached the override");
  assert.ok(env.fogT >= 1 && env.transition >= 1, "the fog stays fully in — not restarted at 0");
  E.look.apply({ fog: " WHITE " }, { merge: true });
  assert.equal(E.win.__environFogOverride, f1, "spelling / merge do not matter");
  assert.equal(E.look.snapshot().look.fog, "WhiteFog");
  // A changed fog is a fresh object: the roll-in restarts (the take player waits it out before recording).
  const c = E.look.apply({ fog: "red" });
  assert.equal(c.applied.fog.changed, true);
  assert.notEqual(E.win.__environFogOverride, f1);
  assert.deepEqual(E.win.__environFogOverride, ENV.environFogFor(1));
  runLoop(0.5);
  assert.equal(env.stats().sets, sets + 1);
  assert.ok(env.fogT < 0.1, `a real change starts the roll-in at 0 (fogT ${env.fogT})`);
  // 'none' clears once; again it is a no-op.
  assert.equal(E.look.apply({ fog: "none" }).applied.fog.changed, true);
  assert.equal(E.win.__environFogOverride, null);
  const n2 = E.look.apply({ fog: "none" });
  assert.equal(n2.applied.fog.changed, false);
  assert.equal(n2.applied.fog.value, "none");
  assert.equal(E.win.__environFogOverride, null);
  // restore() still puts the server's original object back.
  E.look.restore();
  assert.equal(E.win.__environFogOverride, E.serverFog);
  // The server's fog already showing the requested option keeps the SERVER's object (and restore is a no-op).
  const S = makeLookEnv();
  const s1 = S.look.apply({ fog: "blue" });
  assert.equal(s1.applied.fog.changed, false);
  assert.equal(S.win.__environFogOverride, S.serverFog);
  S.look.restore();
  assert.equal(S.win.__environFogOverride, S.serverFog);
  // Same fog = the same option AND row (BlackFog2 is not BlackFog; a doctored row is not WhiteFog).
  assert.equal(LK.sameFogOverride(ENV.environFogFor(6), LK.lookFogOverride("black")), false);
  assert.equal(LK.sameFogOverride({ ...ENV.environFogFor(3), fogMax: 31 }, LK.lookFogOverride("white")), false);
  assert.equal(LK.sameFogOverride(ENV.environFogFor(3), LK.lookFogOverride("white")), true);
  assert.equal(LK.sameFogOverride(undefined, null), true);
  assert.equal(LK.sameFogOverride({ option: 3 }, null), false);
});

// ---------------------------------------------------------------------------
// world fakes: a scene state machine driven by a fake clock
// ---------------------------------------------------------------------------

function makeWorldEnv(opts = {}) {
  let now = 0;
  const events = [];
  const live = {
    terrainBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainGroup: { children: [] },
    staticsGroup: { children: [] },
    cellContainers3d: new Map(),
    _streamGuardState: { inFlight: new Set() },
    _pvsSweepIncomplete: false,
    landblockLru: { parked: new Set(), isParked(k) { return this.parked.has(k >>> 0); } },
    entityManager: null,
  };
  const chat = [];
  const sh = {
    ready: true,
    playerCell: (LB | 0x0021) >>> 0,
    local: [95, 50, 10],
    freed: 0,
    isPlayerReady() { return this.ready; },
    sendChat(c) { chat.push(c); },
    getLocalPlayerPose() { const self = this; return { landblockId: this.playerCell, x: this.local[0], y: this.local[1], z: this.local[2], heading: 0, free() { self.freed += 1; } }; },
    getLocalPlayerPoseCellResolved() { return true; },
  };
  let portal = false;
  const win = {
    __isPortalSpaceActive: () => portal,
    __interiorBuildPending: false,
    getLocalPlayerGuid: () => 0x50000001,
  };
  /** Timeline of scene mutations keyed by time (ms). */
  const timeline = [];
  const at = (ms, fn) => timeline.push({ ms, fn, done: false });
  const advance = (ms) => {
    now += ms;
    for (const e of timeline) {
      if (!e.done && e.ms <= now) {
        e.done = true;
        e.fn();
      }
    }
  };
  const attach = (lb) => live.terrainGroup.children.push({ userData: { subdivLevel: 1, lbX: (lb >>> 24) & 0xff, lbY: (lb >>> 16) & 0xff } });
  const world = WD.createWorld({
    liveScene3d: live,
    sessionHandle: sh,
    window: win,
    now: () => now,
    sleep: async (ms) => advance(ms),
    log: (e) => events.push(e),
    ...opts,
  });
  return { world, live, sh, win, chat, at, advance, attach, setPortal: (v) => { portal = v; }, getNow: () => now, events };
}

check("W1 teleport()/command(): '@' only, single line, ≤ 200 chars, refused verbs, in-world gate", () => {
  const E = makeWorldEnv();
  assert.deepEqual(E.world.teleport("  @telepoi Holtburg "), { ok: true, cmd: "@telepoi Holtburg" });
  assert.deepEqual(E.chat, ["@telepoi Holtburg"]);
  const bad = ["/telepoi Holtburg", "telepoi x", "@tele 1n\n@morph x", "@" + "x".repeat(200), "@morph Drudge", "@portalstorm 2", "@nudge north 5", "@ShutDown", 42, "@"];
  for (const b of bad) {
    const r = E.world.teleport(b);
    assert.equal(r.ok, false, String(b).slice(0, 30));
    assert.equal(r.error.code, "FILM_BAD_COMMAND");
  }
  assert.equal(E.chat.length, 1, "nothing refused reached sendChat");
  assert.equal(E.world.command("@nudge").ok, true, "the bare @nudge cell fix is allowed");
  assert.equal(E.world.command("@cloak on").ok, true);
  assert.deepEqual(E.chat.slice(1), ["@nudge", "@cloak on"]);
  E.sh.ready = false;
  const r = E.world.teleport("@telepoi Holtburg");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "FILM_NOT_IN_WORLD");
  assert.equal(WD.validateAdminCommand("@teleloc 0xA9B4001C 84 7 94"), "@teleloc 0xA9B4001C 84 7 94");
  assert.throws(() => WD.validateAdminCommand("@createinst 123"), FilmError);
});

check("W1 teleport() parks the film viewer cell after a sent command (review seams-11); a refused / unsent one does not; a throwing parker never fails it", () => {
  const parks = [];
  let answer = true;
  const E = makeWorldEnv({ parkViewerCell: () => { parks.push(E.chat.length); if (answer instanceof Error) throw answer; return answer; } });
  assert.deepEqual(E.world.teleport("@telepoi Holtburg"), { ok: true, cmd: "@telepoi Holtburg", viewerParked: true });
  assert.deepEqual(parks, [1], "parked once, AFTER sendChat");
  answer = false;
  assert.equal(E.world.teleport("@telepoi Arwic").viewerParked, false, "nothing was carried");
  assert.equal(E.world.teleport("/telepoi Holtburg").ok, false);
  E.sh.ready = false;
  assert.equal(E.world.teleport("@telepoi Holtburg").ok, false);
  E.sh.ready = true;
  assert.equal(parks.length, 2, "a refused or unsent teleport parks nothing");
  assert.equal(E.world.command("@cloak on").ok, true);
  assert.equal(parks.length, 2, "command() is not a teleport");
  answer = new Error("owner gone");
  const r = E.world.teleport("@telepoi Holtburg");
  assert.deepEqual(r, { ok: true, cmd: "@telepoi Holtburg", viewerParked: false });
  assert.ok(E.events.some((e) => e.level === "warn" && /parkViewerCell threw: owner gone/.test(e.message)));
  // Without the dep the result keeps its old shape.
  assert.deepEqual(makeWorldEnv().world.teleport("@telepoi Holtburg"), { ok: true, cmd: "@telepoi Holtburg" });
});

check("W2 ready(): portal → baked-not-attached → guard in flight → PVS → settle → ok, every check reported", async () => {
  const E = makeWorldEnv();
  const lb = LB;
  E.setPortal(true);
  E.live._pvsSweepIncomplete = true;
  E.at(2000, () => E.setPortal(false));
  E.at(2500, () => { E.live.terrainBakedLbs.add(lb); E.live._streamGuardState.inFlight.add(`terrain:${lb}`); });
  E.at(3500, () => E.attach(lb));
  E.at(4000, () => { E.live._streamGuardState.inFlight.delete(`terrain:${lb}`); E.live._streamGuardState.inFlight.add(`statics:${lb}`); });
  E.at(5000, () => { E.live._streamGuardState.inFlight.clear(); E.live._streamGuardState.inFlight.add("ambient:1"); });
  E.at(6000, () => { E.live._pvsSweepIncomplete = false; E.live.staticsGroup.children.push({}, {}); });
  // Snapshot states along the way through checkReady().
  const c0 = E.world.checkReady({ lbKeys: [lb] });
  assert.equal(c0.ok, false);
  assert.equal(c0.checks.portalSpace.ok, false);
  assert.deepEqual(c0.checks.terrain.missing, ["0xA9B40000"]);
  assert.equal(c0.checks.pvsSweep.ok, false);
  const r = await E.world.ready({ lbKeys: [lb], settleSec: 3, timeoutSec: 90 });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.timedOut, false);
  for (const k of ["teleport", "portalSpace", "terrain", "streamInFlight", "pvsSweep", "interior", "player", "settle", "settleSec"]) {
    assert.equal(r.checks[k].ok, true, k);
  }
  // Last scene change at 6000 → 1500 ms settle → 3 s settleSec.
  assert.ok(r.waitedMs >= 6000 + 1500 + 3000, `waited ${r.waitedMs}`);
  assert.ok(r.waitedMs <= 6000 + 1500 + 3000 + 1000, `not much longer (${r.waitedMs})`);
  assert.deepEqual(r.checks.streamInFlight.keys, [], "non-terrain/statics/buildings guard keys do not block");
  // Mid-way probe: baked but not attached was a failure.
  const F = makeWorldEnv();
  F.live.terrainBakedLbs.add(lb);
  const cu = F.world.checkReady({ lbKeys: [lb] });
  assert.deepEqual(cu.checks.terrain.unattached, ["0xA9B40000"]);
  F.attach(lb);
  F.live.landblockLru.parked.add(lb);
  assert.deepEqual(F.world.checkReady({ lbKeys: [lb] }).checks.terrain.parked, ["0xA9B40000"]);
  F.live.landblockLru.parked.clear();
  assert.equal(F.world.checkReady({ lbKeys: ["0xA9B4001C"] }).ok, true, "cell ids / hex accepted as landblocks");
});

check("W2 ready(): a pending teleport waits for the portal; interiors; timeoutSec never exceeded", async () => {
  const E = makeWorldEnv();
  E.live.terrainBakedLbs.add(LB);
  E.attach(LB);
  E.world.teleport("@telepoi Holtburg");
  E.at(1500, () => E.setPortal(true));
  E.at(6500, () => E.setPortal(false));
  const r = await E.world.ready({ lbKeys: [LB], settleSec: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.checks.teleport.entered, true);
  assert.ok(r.waitedMs >= 6500 + 1000, `waited through the tunnel (${r.waitedMs})`);
  assert.equal(E.world.stats().pendingTeleport, null, "cleared after a pass");
  // No portal ever (portalSpace=off): the grace lets it through with a note.
  const G = makeWorldEnv();
  G.live.terrainBakedLbs.add(LB);
  G.attach(LB);
  G.world.teleport("@teleloc 0xA9B40021 95 50 10");
  const rg = await G.world.ready({ lbKeys: [LB], settleSec: 0, teleportGraceSec: 4 });
  assert.equal(rg.ok, true);
  assert.equal(rg.checks.teleport.entered, false);
  assert.match(rg.checks.teleport.note, /no portal entry/);
  assert.ok(rg.waitedMs >= 4000);
  // Interior: envCellLoadedLbs + __interiorBuildPending; terrain skipped for the interior lb.
  const I = makeWorldEnv();
  const dl = 0x01d90000;
  I.win.__interiorBuildPending = true;
  I.at(1000, () => I.live.envCellLoadedLbs.add(dl));
  I.at(2000, () => { I.win.__interiorBuildPending = false; I.live.cellContainers3d.set(1, {}); });
  const ri = await I.world.ready({ lbKeys: [dl], interiorLb: dl, settleSec: 0.5 });
  assert.equal(ri.ok, true, JSON.stringify(ri.checks));
  assert.deepEqual(ri.checks.terrain.skipped, ["0x01D90000"]);
  assert.equal(ri.checks.interior.envCellsLoaded, true);
  // Timeout: a portal that never ends.
  const T = makeWorldEnv();
  T.setPortal(true);
  const rt = await T.world.ready({ lbKeys: [], timeoutSec: 5, pollMs: 700 });
  assert.equal(rt.ok, false);
  assert.equal(rt.timedOut, true);
  assert.ok(rt.waitedMs <= 5000, `never past timeoutSec (${rt.waitedMs})`);
  assert.equal(rt.checks.portalSpace.active, true);
  // Default target = the player's landblock.
  const P = makeWorldEnv();
  const cp = P.world.checkReady({});
  assert.deepEqual(cp.checks.terrain.lbKeys, ["0xA9B40000"]);
  assert.ok(P.sh.freed >= 1, "LocalPlayerPose freed");
});

check("W3 prewarm(): populate (deduped, player ring skipped), corridor, ring-batched terrain, refire until baked", async () => {
  const pops = [];
  const wasmExports = {
    populateBuildingAabbsForLandblock: async (id) => { pops.push(["b", id]); return 1; },
    populateStaticsAabbsForLandblock: async (id) => { pops.push(["s", id]); return 1; },
    populateSceneryCollidersForLandblock: async (id) => { pops.push(["c", id]); return 0; },
  };
  const ensures = [];
  const corridor = { ensure: async (lbs) => { ensures.push([...lbs]); return { loaded: lbs.length, cached: 0, failed: [] }; } };
  const E = makeWorldEnv({ wasmExports, corridor });
  const L = E.live;
  const calls = { ring: [], statics: [], buildings: [], env: [], terrainRing: 0 };
  let ringFires = 0;
  L._runTerrainRingBatch = (cx, cy) => {
    calls.ring.push([cx, cy]);
    ringFires += 1;
    // The guard skips the first call (6 in flight); the refire bakes the ring.
    if (ringFires === 1) return Promise.resolve(null);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) L.terrainBakedLbs.add((((cx + dx) << 24) | ((cy + dy) << 16)) >>> 0);
    return Promise.resolve(null);
  };
  L.loadTerrainRing = () => { calls.terrainRing += 1; };
  L.loadStaticsForLandblock = (x, y) => { calls.statics.push([x, y]); L.staticsBakedLbs.add(((x << 24) | (y << 16)) >>> 0); return Promise.resolve(null); };
  L.loadBuildingsForLandblock = (x, y) => { calls.buildings.push([x, y]); return Promise.reject(new Error("guard cooldown")); };
  L.loadEnvCellsForLandblock = (id) => { calls.env.push(id); return Promise.resolve({}); };
  // A target two landblocks east of the player (0xA9B4): 0xABB4.
  const pt = [0xab * 192 + 96, LBY + 96, 40];
  E.at(1600, () => L.buildingsBakedLbs.add(0xabb40000)); // buildings land later (after a refire)
  const r = await E.world.prewarm({ points: [pt], radius: 20, timeoutSec: 10 });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  assert.deepEqual(r.lbKeys, ["0xABB40000"]);
  assert.equal(calls.terrainRing, 0, "NEVER loadTerrainRing");
  assert.ok(calls.ring.length >= 2, "terrain ring refired after the guard skip");
  assert.deepEqual(calls.ring[0], [0xab, 0xb4]);
  assert.ok(calls.buildings.length >= 2, "buildings refired until baked");
  assert.equal(calls.statics.length, 1, "statics baked on the first call, not refired");
  assert.deepEqual(calls.env, [0xabb40000]);
  assert.deepEqual(r.baked.terrain, ["0xABB40000"]);
  assert.deepEqual(r.baked.buildings, ["0xABB40000"]);
  assert.deepEqual(pops.map((p) => p[0]), ["b", "s", "c"]);
  assert.equal(pops[0][1], 0xabb40000);
  assert.deepEqual(r.populated.landblocks, ["0xABB40000"]);
  assert.deepEqual(ensures, [[0xabb40000]]);
  assert.equal(r.corridor.loaded, 1);
  // Second prewarm: collision not repopulated.
  await E.world.prewarm({ points: [pt], radius: 20, timeoutSec: 1 });
  assert.equal(pops.length, 3, "deduped");
  // The player's own 3×3 is left to the stream's populate.
  const r3 = await E.world.prewarm({ lbKeys: [LB, 0xaab50000], timeoutSec: 0 });
  assert.deepEqual(r3.populated.skipped.sort(), ["0xA9B40000", "0xAAB50000"]);
  // landblocksAround: disc ∩ landblock squares.
  assert.deepEqual(WD.landblocksAround([[LBX + 1, LBY + 1, 0]], 5), [((0xa8 << 24) | (0xb3 << 16)) >>> 0, ((0xa8 << 24) | (0xb4 << 16)) >>> 0, ((0xa9 << 24) | (0xb3 << 16)) >>> 0, LB].sort((a, b) => a - b));
  assert.deepEqual(WD.landblocksAround([[LBX + 96, LBY + 96, 0]], 0), [LB]);
  assert.deepEqual(WD.landblocksAround([[NaN, 0, 0], null], 50), []);
});

check("W3 prewarm(): timeout reports what is missing; sealed dungeon skips outdoor kinds; interior env cells", async () => {
  const E = makeWorldEnv();
  E.live._runTerrainRingBatch = () => Promise.resolve(null); // never bakes
  E.live.loadStaticsForLandblock = () => null;
  E.live.loadBuildingsForLandblock = () => null;
  const r = await E.world.prewarm({ lbKeys: [0xb0b00000], timeoutSec: 2, collision: false, corridor: false });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.missing.terrain, ["0xB0B00000"]);
  assert.ok(r.waitedMs <= 2000);
  const S = makeWorldEnv();
  S.live._sealedEvictLbKey = 0x01d90000;
  const env = [];
  S.live.loadEnvCellsForLandblock = (id) => { env.push(id); if (env.length >= 2) S.live.envCellLoadedLbs.add(id); };
  S.live._runTerrainRingBatch = () => { throw new Error("must not be called in a sealed dungeon"); };
  const rs = await S.world.prewarm({ lbKeys: [0x01d90000], interiorLb: 0x01d90000, timeoutSec: 5, collision: false });
  assert.equal(rs.ok, true, JSON.stringify(rs));
  assert.ok(rs.skipped.some((s) => /sealed dungeon/.test(s)));
  assert.deepEqual(rs.baked.envCells, ["0x01D90000"]);
  assert.equal(env.length, 2, "env cells refired until loaded");
  const N = WD.createWorld({ window: {}, now: () => 0, sleep: async () => {} });
  const rn = await N.prewarm({ lbKeys: [LB] });
  assert.equal(rn.ok, false);
  assert.equal(rn.error.code, "FILM_NO_SCENE");
});

check("W4 avatar(): film-hidden term (rig + shadow), fallback camera fade", () => {
  const E = makeWorldEnv();
  const hides = [];
  E.live.entityManager = { setFilmHidden(g, on) { hides.push([g, on]); return true; } };
  assert.deepEqual(E.world.avatar(false), { ok: true, guid: 0x50000001, visible: false, method: "filmHidden", rigPresent: true });
  assert.equal(E.world.avatar(true).visible, true);
  assert.deepEqual(hides, [[0x50000001, true], [0x50000001, false]]);
  const fades = [];
  E.live.entityManager = {};
  E.live.cameraSwitcher = { _applyCameraPlayerFade: (o) => fades.push(o) };
  const r = E.world.avatar(false);
  assert.equal(r.method, "opacity");
  assert.deepEqual(fades, [0]);
  E.live.cameraSwitcher = null;
  assert.equal(E.world.avatar(false).ok, false);
});

check("W5 actor(): DAT-resolved emotes only, motions held vs one-shot, face = −compass, moveTo + pursuitStatus", async () => {
  const E = makeWorldEnv();
  const routed = [];
  let freed = 0;
  E.sh.resolveSoulEmote = (tok) => (tok === "wave" || tok === "bow" ? { motionFull: 0x13000087, free() { freed += 1; } } : undefined);
  E.win.__routeSlashCommand = (h, line) => { routed.push([h === E.sh, line]); return { dispatched: true, echo: "You wave." }; };
  const motions = [];
  E.live.entityManager = {
    getStance: () => 0,
    setMotion: async (g, c, s, sp) => { motions.push(["held", g, c, s, sp]); },
    setSwingMotion: async (g, c) => { motions.push(["swing", g, c]); },
  };
  const turns = [];
  E.sh.turnToHeading = (y) => turns.push(y);
  const r1 = await E.world.actor({ emote: "/wave", motion: "SitState", face: Math.PI / 2, at: 0.5 });
  assert.equal(r1.ok, true, JSON.stringify(r1.parts));
  assert.deepEqual(routed, [[true, "/wave"]]);
  assert.equal(freed, 1, "SoulEmoteResolution freed");
  assert.deepEqual(motions[0], ["held", 0x50000001, 0x4300013d, WD.NONCOMBAT_STANCE, 1.0]);
  near(turns[0], -Math.PI / 2, 1e-12);
  assert.match(r1.parts.at.note, /take player/);
  // Unknown token: refused (never routed — it would become an @ admin command).
  const r2 = await E.world.actor({ emote: "/morph" });
  assert.equal(r2.ok, false);
  assert.equal(routed.length, 1);
  assert.equal((await E.world.actor({ emote: "/wave now" })).ok, false);
  // One-shot motion by name and by hex; unknown motion refused.
  await E.world.actor({ motion: "wave" });
  await E.world.actor({ motion: "0x4300013D" });
  assert.deepEqual(motions[1], ["swing", 0x50000001, 0x13000087]);
  assert.equal(motions[2][2], 0x4300013d);
  assert.equal((await E.world.actor({ motion: "Teleport" })).ok, false);
  // moveTo: landblock-local coords outdoors; status read-clear polled until arrived.
  const moves = [];
  const statuses = [2, 0, 1, 1, 2];
  E.sh.moveToPosition = (cell, x, y, z, run) => moves.push([cell, x, y, z, run]);
  E.sh.pursuitStatus = () => statuses.shift() ?? 0;
  const r3 = await E.world.actor({ moveTo: [LBX + 120.5, LBY + 30.25, 12], run: false });
  assert.equal(r3.ok, true, JSON.stringify(r3.parts));
  assert.equal(r3.parts.moveTo.status, "arrived");
  assert.equal(moves[0][0], (LB | (1 + 5 * 8 + 1)) >>> 0, "outdoor cell of the target");
  near(moves[0][1], 120.5, 1e-9);
  near(moves[0][2], 30.25, 1e-9);
  assert.equal(moves[0][4], false);
  // Failure carries the weenie error; indoors the player's cell frames the local coords.
  E.sh.playerCell = (LB | 0x0123) >>> 0;
  E.sh.pursuitStatus = (() => { const q = [0, (0x3d << 16) | 3]; return () => q.shift() ?? 0; })();
  const r4 = await E.world.actor({ moveTo: [LBX - 300, LBY + 10, -50] });
  assert.equal(r4.ok, false);
  assert.equal(r4.parts.moveTo.status, "failed");
  assert.equal(r4.parts.moveTo.weenieError, 0x3d);
  assert.equal(moves[1][0], (LB | 0x0123) >>> 0);
  near(moves[1][1], -300, 1e-9, "dungeon cells may sit outside the landblock square");
  // Timeout.
  E.sh.pursuitStatus = () => 1;
  const r5 = await E.world.actor({ moveTo: [LBX + 1, LBY + 1, 0], timeoutSec: 1 });
  assert.equal(r5.parts.moveTo.status, "active");
  assert.equal(r5.parts.moveTo.ok, false);
  assert.equal((await E.world.actor(null)).ok, false);
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`film_runtime_world: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
