// tests/film_cli_session.test.mjs
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) drives the off-screen, muted test Chrome on the
// GTX-1070 box over CDP through tools/film/film.mjs. On the real box a mistake is expensive or harmful: a second
// login kicks the single-login film account, an unmuted page plays sound to the person using the machine, a
// teleport in the middle of a take records the portal tunnel, a dropped drain chunk corrupts the H.264 stream, a
// wrong IVF header makes the VP9 fallback unplayable, and a leaked password ends up in a report. This suite runs
// the REAL CLI `main(argv, deps)` against a fake `chromium.connectOverCDP` whose page EXECUTES every evaluated
// function (re-created from its source text, so a closure the real browser could not see fails here too) against
// a fake `window` with a `window.__film` state machine (SPEC §3):
//   S1 boot: viewport override and JEV broker BEFORE navigation, the exact film URL, gate progression
//      (not-in-world → in-world → ready → liveScene3d → __film), page mute through the AudioManager API,
//      clean(true) · own() · avatar(false) · @cloak on · @attackable off, password never printed
//   S2 boot failures: Account In Use (exit 1, wait 25–65 s), mute unverified → 2 unless --assume-muted,
//      --mute-audio absent → 2 always, second film tab → 2 unless --reuse, no password → 2, gate timeout names
//      the failing condition; SwiftShader fallback (mesh count after 90 s) in classifyBoot / waitForBoot
//   S3 go: teleport → portal space → world.ready polling (gazetteer site, @teleloc, timeline site), not ready → 1,
//      no film page → 2, the REAL heavy lock (HB_HEAVY_LOCK_DIR in a temp dir) held during and released after
//   S4 browser check: redacted page list, off-screen window, GPU string, on-screen window → 1
//   S5 shoot on a 2-site / 2-shot schedule: teleports only between sites, never inside a take; drained Annex-B
//      bytes concatenated exactly; documented ffmpeg argv; reports + shoot-log; fpv/indoor rehearsal; VP9 → exact
//      IVF header + frame headers; JPEG frames; retake swap; JEV broker end to end (page → broker → client →
//      fake fetch) with telemetry; heavy lock acquired and released
//   S6 scout (stills + metrics + --pick band) and rehearse (realised table + pilot telemetry)
//   S8 run <project>: the whole recipe against the fake page, and its stop-at-first-failure rule; S8b: no film
//      page → run boots it (exact URL), a never-ready site stops it at shoot, every lock hold released; S8c: the
//      song is routed — --song-analysis to plan validate/compile, --song-audio to assemble, --song refused
//   S9 status: __film.status() + the camera/avatar/canvas probe; --release → release · clean(false) ·
//      avatar(true) verified through status; FILM_BUSY and a still-hidden avatar → 1; --own --clean=on
//      --avatar=off re-owns; exclusive flags → 2; no film page → 2; the heavy lock held and released
//   S3d go prints map positions through units.js formatMap (S/W for southern/western sites, @teleloc outdoors)
//   S3e boot --password=… under the REAL heavy lock: owner.json gets a scrubbed cmd, never the password, and the
//      caller's process.argv comes back unchanged; S3f odd --width/--height → exit 2 (H.264 4:2:0)
//   S10 shootSchedule driven directly against a fake page whose takes can hang until __film.abort():
//      a: an incomplete/failing world.prewarm only warns (shoot-log row + report note), a site whose teleport
//         fails is a 'site' failure and the later sites still run; a page without prewarm → exit 2
//      b/c: a recorder.drain rejection / an ENOSPC sink write mid-take → abort + wait for idle, the next prepare
//         works, no teleport while a take runs; d: a page that never goes idle is never teleported ('busy');
//      e: a take left running before the first site is aborted before the teleport
//      f: the REAL broker — rehearsals always get the stepped decide limits, takes their capture mode's, and each
//         reports/<shot>.jev.jsonl holds only that shot's calls
//      g: a failing retake (mux or page) keeps the earlier attempt (report, keptAttempt, failedAttempts)
//      h: settlePage re-sends __film.abort() on every busy poll (an abort lost in index.js's take-start window,
//         busy='shoot' before the take player's run exists, is repeated) — bounded by count and time; end to end
//         a leftover take in that window is stopped before the teleport
//      i: the page's validation / flight-check issues and warnings (prepare, rehearse, take report; present,
//         absent or malformed) → one warning per issue per shot, `issues` in reports/<shot>.json, every
//         shoot-log row (also a failed attempt's), <shot>.rehearsal.json and the keepOrRetake input; never a failure
//      j: a flown run whose realised flight.tracking trailed the plan by more than FLIGHT_GAP_WARN_M → a
//         `tracking-gap` issue per run (rehearsal and take each warn once; threshold edges, malformed blocks);
//         the overspeed issue keeps the page's `durationHelps` and says 'a longer duration will not help' when false
//      k: the REAL page shapes (scene3d/film/runtime/take_player.js prepare(): an acceleration- and a speed-limited
//         move with a verified minimum duration, a prebuilt-trajectory take with an estimate) → the overspeed issue
//         keeps `limitedBy`, `minDurationVerified` (null kept: an estimate) and the dry-flown `maxGapM` through
//         pageIssuesOf / mergeIssues / judgeInput and shootSchedule's reports; the flight-block fallback words a
//         verified duration vs an estimate and an acceleration-limited move like the page; issueLine marks an
//         estimate; a flown carry rig's tracking-gap names the live subject's turn
//   S6b rehearse / shoot / scout through main(): the same issues and the scout warnings, printed and saved
//   S6c rehearse / shoot through main(): the tracking-gap warning and issue (none within the threshold), and an
//       overspeed with durationHelps false kept in reports/<shot>.json without a duplicated hint
//   S7 a final scan: no output stream and no written file holds the password or the key
// No browser, no network, no real ffmpeg (a temp node script records its argv).
//
// Run from apps/holtburger-web/: node tests/film_cli_session.test.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main, scrubbedArgv } from "../tools/film/film.mjs";
import { EXIT, FilmCliError } from "../tools/film/lib/args.mjs";
import { buildFilmUrl, classifyBoot, waitForBoot, SCENE_READY_FALLBACK_MS } from "../tools/film/lib/session.mjs";
import { IVF_HEADER_BYTES, createTakeSink, ivfFileHeader, ivfFrameHeader, sniffChunkKind } from "../tools/film/lib/drain.mjs";
import { muxArgv } from "../tools/film/lib/ffmpeg.mjs";
import { JEV_ENDPOINT, choiceQ } from "../tools/film/lib/jev.mjs";
import { createJevBroker } from "../tools/film/lib/jev_broker.mjs";
import { DECIDE_OPTIONS, FLIGHT_GAP_WARN_M, PAGE_ABORT_MAX, PAGE_IDLE_WAIT_MS, flightOf, issueLine, judgeInput, mergeIssues, pageIssuesOf, selectSchedule, settlePage, shootSchedule } from "../tools/film/lib/shoot.mjs";
import { compilePlan } from "../tools/film/plan/compile.mjs";
import { buildShot, createRegistry, defineTechnique } from "../scene3d/film/shots/index.js";
import { makeTrajectory } from "../scene3d/film/shots/trajectory.js";
import { createTakePlayer } from "../scene3d/film/runtime/take_player.js";
import { ensureFilmHooks } from "../scene3d/film/runtime/camera_owner.js";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e?.stack ?? e}`);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "film-cli-session-"));
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
const PASSWORD = "Pa55&word#film";
const PAGE_PW = "PAGEPW-in-url";
const KEY = "sk-or-v1-SESSIONKEY-9876543210";
const ALL_OUTPUT = [];
const PLAYER_GUID = 0x50000001;

const FAKE_FFMPEG_SRC = String.raw`
(function fakeFfmpeg() {
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "ffmpeg.argv.jsonl"), JSON.stringify(argv) + "\n");
const out = argv[argv.length - 1];
fs.mkdirSync(path.dirname(out), { recursive: true });
const i = argv.indexOf("-i");
fs.writeFileSync(out, "FAKE-FFMPEG " + (i >= 0 ? argv[i + 1] : "") + "\n");
process.exit(0);
})();
`;
const FF_DIR = path.join(TMP, "ffbin");
fs.mkdirSync(FF_DIR, { recursive: true });
const FFMPEG = path.join(FF_DIR, "ffmpeg");
fs.writeFileSync(FFMPEG, `#!${process.execPath}\n${FAKE_FFMPEG_SRC}`, { mode: 0o755 });
const ffCalls = () => {
  const f = path.join(FF_DIR, "ffmpeg.argv.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const ffReset = () => fs.rmSync(path.join(FF_DIR, "ffmpeg.argv.jsonl"), { force: true });

const GAZ = path.join(TMP, "gaz.jsonl");
fs.writeFileSync(GAZ, [
  { id: "holtburg", name: "Holtburg", kind: "town", cell: "0xA9B40019", lb: "0xA9B4", indoor: false, map: { ns: 42.1, ew: 33.6 }, teleport: { best: "@telepoi Holtburg" }, tags: ["town"] },
  { id: "holtburg-dungeon", name: "Holtburg Dungeon", kind: "dungeon", cell: "0x01F60289", lb: "0x01F6", indoor: true, map: null, teleport: { best: "@teleloc 0x01F60289 96.70 -10.00 0.00 1 0 0 0" }, tags: ["dungeon"] },
].map((s) => JSON.stringify(s)).join("\n") + "\n");

function capture() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

const lockCalls = [];
async function fakeLock(opts) {
  const rec = { label: opts.label, released: false };
  lockCalls.push(rec);
  return { dir: "/fake", bypassed: null, waitedMs: 0, release: () => { rec.released = true; } };
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
function makeFetch() {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization ?? null });
    if (String(url) !== JEV_ENDPOINT) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(opts.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: 0.97 };
      else {
        const first = Object.keys(q.criteria)[0];
        answers[id] = { type: "choice", choice: first, confidence: 0.9, probabilities: { [first]: 0.9 } };
      }
    }
    return jsonResponse(200, { id: "gen-s", model: "typesafe/jev-1.13", answers, usage: { input_tokens: 80, output_tokens: 0, cost: 0.0000034 } });
  };
  fn.calls = calls;
  return fn;
}

// ── the fake browser ─────────────────────────────────────────────────────────────────────────────────────

const FAKE_GL = {
  getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 } : null),
  getParameter: (p) => (p === 0x9246 ? "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)" : "Google Inc. (NVIDIA)"),
};

function makeAudioManager(world) {
  const calls = world.audioCalls;
  const ctx = {
    state: "running",
    destination: { id: "speakers" },
    suspend() {
      calls.push("ctx.suspend");
      this.state = "suspended";
      return Promise.resolve();
    },
    resume() {
      calls.push("ctx.resume(original)");
      this.state = "running";
      return Promise.resolve();
    },
  };
  return {
    _ctx: ctx,
    _master: { disconnect: (d) => calls.push(`master.disconnect:${d?.id}`) },
    _masterGainValue: 1,
    _effectGainValue: 1,
    _ambientGainValue: 1,
    setMasterGain(v) { calls.push(`master=${v}`); this._masterGainValue = v; },
    setEffectGain(v) { calls.push(`effect=${v}`); this._effectGainValue = v; },
    setAmbientGain(v) { calls.push(`ambient=${v}`); this._ambientGainValue = v; },
    pauseAll() { calls.push("pauseAll"); },
    _initContext() { calls.push("initContext"); },
  };
}

const BOOT_SCRIPTS = {
  happy: ["connecting", "char-list-ready", "spawning", "in-world", "liveScene3d", "ready", "film"],
  accountInUse: ["connecting", "kicking", "loginError"],
  neverFilm: ["connecting", "in-world", "liveScene3d", "ready"],
  swiftshader: ["connecting", "in-world", "liveScene3d", "film"],
};

function createWorld(opts = {}) {
  const world = {
    clock: 1_000_000,
    log: [],
    filmCalls: [],
    cdpCalls: [],
    audioCalls: [],
    gotoUrls: [],
    connects: [],
    teleports: [],
    takeLog: [],
    jevResponses: [],
    pages: [],
    cmdline: opts.cmdline === undefined ? ["--remote-debugging-port=9333", "--mute-audio", "--enable-automation", "--window-position=-32000,-32000"] : opts.cmdline,
    windowBounds: opts.windowBounds ?? { left: -32000, top: -32000, width: 1920, height: 1080, windowState: "normal" },
    bootScript: BOOT_SCRIPTS[opts.boot ?? "happy"],
    bootStep: -1,
    navigated: false,
    readyAfter: opts.readyAfter ?? 1,
    readyCalls: 0,
    portal: null,
    queue: [],
    recDone: true,
    attempt: 0,
    safetyByAttempt: opts.safetyByAttempt ?? [],
    callJev: Boolean(opts.callJev),
    scout: opts.scout ?? null,
    // page result extras (validation / flight / warnings) per call: prepare(take) → {…}, rehearse / shoot → {…}
    prepareExtra: opts.prepareExtra ?? null,
    rehearseExtra: opts.rehearseExtra ?? null,
    shootExtra: opts.shootExtra ?? null,
    evals: 0,
    snapshots: 0,
  };
  const media = { muted: false, pause() { this.paused = true; } };
  world.media = media;
  const win = { document: { querySelectorAll: (sel) => (sel === "audio,video" ? [media] : []) } };
  world.win = win;
  win.__isPortalSpaceActive = () => world.portal?.phase === "active";

  const step = (name) => {
    const hist = (win.__bootStateHistory ??= []);
    const push = (state, message = "") => {
      win.__bootState = state;
      hist.push({ state, message, ts: world.clock });
    };
    switch (name) {
      case "liveScene3d":
        win.liveScene3d = {
          audioManager: makeAudioManager(world),
          scene: { traverse: (cb) => { for (let i = 0; i < 150; i++) cb({ isMesh: true }); } },
          renderer: { getContext: () => FAKE_GL },
          cameraSwitcher: { mode: "orbit" },
          entityManager: {},
        };
        win.getLocalPlayerGuid = () => PLAYER_GUID;
        win.__renderScaleState = () => ({ drawingBuffer: [1920, 1080] });
        break;
      case "ready":
        push("ready", "atmosphere composer wired");
        win.__sceneReadyEverFired = true;
        break;
      case "film":
        win.__film = makeFilm(world);
        break;
      case "loginError":
        push("error", "connect failed after 1 attempts: kick");
        win.__lastCharacterError = { code: 1, name: "Logon", message: "Account in use", mode: "fatal" };
        break;
      default:
        push(name, `${name} …`);
    }
  };
  world.bootFully = () => {
    for (const s of BOOT_SCRIPTS.happy) step(s);
    world.navigated = false;
  };
  world.tick = () => {
    if (world.navigated && world.bootStep + 1 < world.bootScript.length) step(world.bootScript[++world.bootStep]);
    if (world.portal) {
      if (world.portal.phase === "pending") world.portal.phase = "active";
      else if (world.portal.phase === "active" && ++world.portal.ticks >= 2) world.portal.phase = "done";
    }
  };

  const page = {
    _url: opts.pageUrl ?? "about:blank",
    url: () => page._url,
    async goto(url) {
      world.log.push("goto");
      world.gotoUrls.push(url);
      page._url = url;
      world.navigated = true;
      world.bootStep = -1;
      return {};
    },
    async evaluate(fn, arg) {
      world.evals++;
      // Re-create the function from its source in the global scope, as Playwright does in the page: a closure
      // over module scope would throw a ReferenceError here exactly as it would in Chrome.
      const f = new Function(`return (${fn.toString()})`)();
      if (fn.name === "BOOT_SNAPSHOT_FN" || /__bootStateHistory/.test(fn.toString())) world.snapshots++;
      globalThis.window = win;
      globalThis.document = win.document;
      const r = await f(arg === undefined ? undefined : structuredClone(arg));
      return r === undefined ? undefined : structuredClone(r);
    },
    async exposeFunction(name, handler) {
      world.log.push(`expose:${name}`);
      win[name] = (json) => handler(json);
    },
  };
  world.page = page;
  const context = {
    pages: () => world.pages,
    async newPage() {
      world.log.push("newPage");
      world.pages.push(page);
      return page;
    },
    async newCDPSession() {
      return {
        async send(method, params) {
          world.cdpCalls.push({ method, params });
          world.log.push(`cdp:${method}`);
          if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: world.windowBounds };
          return {};
        },
        async detach() {},
      };
    },
  };
  const browser = {
    contexts: () => [context],
    version: () => "Chrome/140.0.7339.0",
    async newBrowserCDPSession() {
      return {
        async send(method) {
          if (method !== "Browser.getBrowserCommandLine") throw new Error(`unexpected ${method}`);
          if (world.cmdline === null) throw new Error("Command line not returned because --enable-automation not set and command line flag is not set");
          return { arguments: world.cmdline };
        },
        async detach() {},
      };
    },
    async close() {
      world.log.push("browser.close");
    },
  };
  world.chromium = {
    async connectOverCDP(url) {
      world.connects.push(url);
      return browser;
    },
  };
  if (opts.filmPageOpen) {
    page._url = `http://127.0.0.1:8765/apps/holtburger-web/index.html?filmMode=on&account=phase4demo&password=${PAGE_PW}`;
    world.pages.push(page);
    if (opts.booted !== false) world.bootFully();
    if (opts.viewport) win.__filmCliViewport = opts.viewport;
  }
  return world;
}

function chunkBytes(k, codec) {
  if (codec === "vp9") return Buffer.from([0x82, 0x49, 0x83, 0x42, k & 0xff, (k * 13) & 0xff, 0x11, ...Array(k % 4).fill(0x5a)]);
  if (codec === "frames") return Buffer.from([0xff, 0xd8, 0xff, 0xe0, k & 0xff, 0x22, 0x33, 0xff, 0xd9]);
  return Buffer.from([0, 0, 0, 1, k === 0 ? 0x65 : 0x41, k & 0xff, (k * 7) & 0xff, ...Array(k % 5).fill(0xab)]);
}

function makeFilm(world) {
  const win = world.win;
  const rec = (m, args) => {
    world.filmCalls.push({ m, args: structuredClone(args) });
    world.log.push(`film:${m}`);
  };
  const ok = (extra = {}) => ({ ok: true, ...extra });
  return {
    version: "film-1",
    status() {
      rec("status", []);
      return ok({ version: "film-1", active: Boolean(world.busy), busy: world.busy ?? null, cameraOwned: Boolean(world.owned), clean: Boolean(world.clean), take: { shotId: world.prepared?.shotId ?? null } });
    },
    release() {
      rec("release", []);
      if (world.busy) return { ok: false, error: { name: "FilmError", code: "FILM_BUSY", message: "release: a take is running" }, code: "FILM_BUSY" };
      const wasOwned = Boolean(world.owned);
      world.owned = false;
      const cs = win.liveScene3d?.cameraSwitcher;
      if (cs && world.savedMode) cs.mode = world.savedMode;
      return ok({ wasOwned, owned: false });
    },
    clean(on = true) {
      rec("clean", [on]);
      world.clean = on;
      return ok();
    },
    own() {
      rec("own", []);
      const cs = win.liveScene3d?.cameraSwitcher;
      if (cs && !world.owned) {
        world.savedMode = cs.mode;
        cs.mode = "follow";
      }
      world.owned = true;
      return ok();
    },
    world: {
      teleport(cmd) {
        rec("world.teleport", [cmd]);
        if (!/^@(cloak|attackable)/.test(cmd)) {
          world.teleports.push(cmd);
          world.portal = { phase: "pending", ticks: 0 };
          world.readyCalls = 0;
        }
        return ok();
      },
      async ready(o) {
        rec("world.ready", [o]);
        world.readyCalls++;
        const ready = world.readyCalls > world.readyAfter;
        return { ok: ready, checks: { portalInactive: world.portal?.phase !== "active", terrain: ready }, waitedMs: 5 };
      },
      async prewarm(o) {
        rec("world.prewarm", [o]);
        return ok({ landblocks: 1 });
      },
      avatar(v) {
        rec("world.avatar", [v]);
        const em = win.liveScene3d?.entityManager;
        if (em && !world.avatarBroken) {
          em._filmHiddenGuids ??= new Set();
          if (v === false) em._filmHiddenGuids.add(PLAYER_GUID);
          else em._filmHiddenGuids.delete(PLAYER_GUID);
        }
        return ok({ visible: v !== false });
      },
    },
    prepare(take) {
      rec("prepare", [take]);
      world.prepared = take;
      return ok({ duration: take?.spec?.duration ?? null, ...(world.prepareExtra?.(take) ?? {}) });
    },
    async rehearse(o) {
      rec("rehearse", [o]);
      return ok({ realisedTable: { fps: o.fps, frames: 2, rows: [[0, 1, 2, 3, 1, 0, 0, 0, 60, 0, 0], [0.125, 1, 2, 3, 1, 0, 0, 0, 60, 0, 0]] }, checksum: "deadbeef", pilotTelemetry: [{ seq: 1, source: "code" }, { seq: 2, source: "code" }], safetyEvents: [], ...(world.rehearseExtra?.(world.prepared) ?? {}) });
    },
    async shoot(o) {
      rec("shoot", [o]);
      world.log.push("shoot:start");
      const frames = Math.round(world.prepared.spec.duration * o.fps);
      const codec = o.codec;
      const entry = { shotId: world.prepared.shotId, codec, chunks: [], attempt: world.attempt };
      world.takeLog.push(entry);
      world.queue = [];
      world.recDone = false;
      world.codecString = codec === "vp9" ? "vp09.00.40.08" : codec === "frames" ? "frames" : "avc1.640033";
      if (world.callJev && typeof win.__filmJev === "function") {
        const resp = await win.__filmJev(JSON.stringify({
          state: { obstacles: { ahead: "near tree" } },
          questions: { maneuver: choiceQ("Pick a maneuver.", { hold_path: "keep flying the path", rise: "climb when the space above is open" }) },
          seq: 1,
        }));
        world.jevResponses.push(JSON.parse(resp));
      }
      for (let k = 0; k < frames; k++) {
        const bytes = chunkBytes(k, codec);
        entry.chunks.push(bytes);
        const b64 = bytes.toString("base64");
        world.queue.push({ seq: k, b64: codec === "frames" ? `data:image/jpeg;base64,${b64}` : b64, timestampUs: Math.round((k * 1e6) / o.fps), key: k === 0 });
        if (k % 3 === 0) await new Promise((r) => setImmediate(r));
      }
      world.recDone = true;
      world.log.push("shoot:end");
      const adjusted = world.safetyByAttempt[world.attempt] ?? 0;
      world.attempt++;
      return ok({ frames, durationSec: frames / o.fps, realisedChecksum: "cafe", pilot: { decisions: 1 }, safety: { adjustedFrames: adjusted }, obstruction: { minVisibleFrac: 1 }, ...(world.shootExtra?.(entry.shotId) ?? {}) });
    },
    recorder: {
      drain({ maxBytes }) {
        world.filmCalls.push({ m: "recorder.drain", args: [{ maxBytes }] });
        const chunks = [];
        let bytes = 0;
        while (world.queue.length && (chunks.length === 0 || bytes + world.queue[0].b64.length <= maxBytes)) {
          const c = world.queue.shift();
          bytes += c.b64.length;
          chunks.push(c);
        }
        const done = world.recDone && world.queue.length === 0;
        if (done) world.log.push("drain:done");
        return ok({ chunks, done, stats: { codec: world.codecString } });
      },
    },
    async scout(shot, o) {
      rec("scout", [shot, o]);
      return world.scout ?? ok({ candidates: [] });
    },
  };
}

async function run(world, argv, extra = {}) {
  const out = capture();
  const err = capture();
  const deps = {
    stdout: out,
    stderr: err,
    env: { HOME, ...(extra.env ?? {}) },
    cwd: TMP,
    chromium: world.chromium,
    now: () => world.clock,
    sleep: async (ms) => {
      world.clock += ms;
      world.tick();
      await new Promise((r) => setImmediate(r));
    },
    fetch: extra.fetch ?? makeFetch(),
    resolvePlaywright: () => "/fake/playwright-core",
    versions: { node: "20.20.2" },
  };
  if (!extra.realLock) deps.acquireHeavyLock = fakeLock;
  const code = await main(argv, deps);
  ALL_OUTPUT.push(out.text(), err.text());
  return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
}

const idx = (log, ev, from = 0) => log.indexOf(ev, from);
const filmSeq = (world, names) => world.filmCalls.filter((c) => names.includes(c.m)).map((c) => [c.m, ...c.args]);

// A project with a compiled 2-site / 2-shot timeline (s1 outdoors classic, s2 dungeon fpv).
function makeProject(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const plan = {
    version: 1,
    title: "session reel",
    format: { width: 64, height: 36, fps: 10, capture: "stepped" },
    sites: [
      { id: "holtburg", teleport: "@telepoi Holtburg", anchor: { cell: "0xA9B40019", local: [84, 7.1, 94] } },
      { id: "dungeon", indoor: true, cell: "0x01F60289", teleport: "@teleloc 0x01F60289 96.70 -10.00 0.00 1 0 0 0", anchor: { cell: "0x01F60289", local: [96.7, -10, 0] } },
    ],
    shots: [
      { id: "s1", site: "holtburg", technique: "classic.static", duration: { sec: 1 }, standingOrder: "Hold still; keep 3 m from roofs." },
      { id: "s2", site: "dungeon", technique: "fpv.fpv-corridor", duration: { sec: 1 }, route: { fromCell: "0x01F60289", toCell: "0x01F6027A" }, standingOrder: "Fly the corridor; walls stay 1 m away." },
    ],
  };
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const timeline = compilePlan(plan, {});
  const tl = path.join(dir, "timeline.json");
  fs.writeFileSync(tl, JSON.stringify(timeline));
  return { dir, tl, timeline };
}

// The page's flight check for an overspeeding drone move, as scene3d/film/runtime/take_player.js prepare() reports it.
const OVERSPEED_MSG = "the 8 s move peaks at 17.8 m/s over 120 m, but the 'cinema' drone flies ≤ 12 m/s: the flown camera falls behind the planned path and ends short of it; use duration ≥ 11.9 s (or pilot.flightPreset 'fpv')";
const OVERSPEED_FLIGHT = Object.freeze({ preset: "cinema", vmax: 12, peakSpeed: 17.8, lengthM: 120, overspeed: true, minDurationSec: 11.9 });
const overspeedValidation = () => ({ ok: false, counts: { overspeed: 1 }, issues: [{ code: "overspeed", t: null, message: OVERSPEED_MSG, preset: "cinema", vmax: 12, peakSpeed: 17.8, minDurationSec: 11.9 }] });

// ── S1/S2: boot ──────────────────────────────────────────────────────────────────────────────────────────

await check("S1 boot: viewport + broker before goto, exact URL, gate progression, mute via AudioManager, clean/own/hide/cloak", async () => {
  const world = createWorld();
  const r = await run(world, ["boot", "--cdp=http://127.0.0.1:9333"], { env: { FILM_PASSWORD: PASSWORD, OPENROUTER_API_KEY: KEY } });
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(world.connects, ["http://127.0.0.1:9333"]);
  const L = world.log;
  const iNew = idx(L, "newPage");
  const iVp = idx(L, "cdp:Emulation.setDeviceMetricsOverride");
  const iExp = idx(L, "expose:__filmJev");
  const iGoto = idx(L, "goto");
  assert.ok(iNew >= 0 && iNew < iVp && iVp < iExp && iExp < iGoto, `order ${L.slice(0, 8).join(", ")}`);
  assert.deepEqual(world.cdpCalls.find((c) => c.method === "Emulation.setDeviceMetricsOverride").params, { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(world.gotoUrls, [buildFilmUrl({ password: PASSWORD })]);
  assert.equal(new URL(world.gotoUrls[0]).searchParams.get("filmDof"), "on");
  // the gate waited for every step (7) before touching __film
  assert.ok(world.snapshots >= 8, `snapshots ${world.snapshots}`);
  const after = filmSeq(world, ["clean", "own", "world.avatar", "world.teleport"]);
  assert.deepEqual(after, [["clean", true], ["own"], ["world.avatar", false], ["world.teleport", "@cloak on"], ["world.teleport", "@attackable off"]]);
  assert.ok(idx(L, "film:clean") > iGoto);
  // page mute through the client's real audio API, re-applied on context creation, media muted
  for (const c of ["pauseAll", "master=0", "effect=0", "ambient=0", "master.disconnect:speakers", "ctx.suspend"]) assert.ok(world.audioCalls.includes(c), c);
  const am = world.win.liveScene3d.audioManager;
  assert.equal(am.__filmMuteWrapped, true);
  await am._ctx.resume();
  assert.equal(world.audioCalls.includes("ctx.resume(original)"), false, "resume must stay pinned");
  assert.equal(world.media.muted, true);
  assert.deepEqual(world.win.__filmCliViewport, { width: 1920, height: 1080 });
  assert.equal(typeof world.win.__filmJev, "function");
  assert.match(r.out, /booted .*password=\[redacted\]/);
  assert.ok(!(r.out + r.err).includes(PASSWORD) && !(r.out + r.err).includes(encodeURIComponent(PASSWORD)));
  assert.ok(!(r.out + r.err).includes(KEY));
  assert.ok(L.includes("browser.close"));
  assert.equal(lockCalls.at(-1).label, "film boot");
  assert.equal(lockCalls.at(-1).released, true);
});

await check("S2a boot: Account In Use before in-world → exit 1, tells the director to wait 25–65 s, no film calls", async () => {
  const world = createWorld({ boot: "accountInUse" });
  const r = await run(world, ["boot", "--json"], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 1);
  const env = r.json();
  assert.equal(env.error.code, "ACCOUNT_IN_USE");
  assert.match(env.error.message, /single-login.*wait ~25–65 s/);
  assert.match(r.err, /login failed before in-world/);
  assert.equal(world.filmCalls.length, 0);
  assert.ok(!(r.out + r.err).includes(PASSWORD));
});

await check("S2b boot: mute unverified → exit 2 before any tab/navigation; --assume-muted proceeds", async () => {
  let world = createWorld({ cmdline: null });
  let r = await run(world, ["boot"], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot verify that Chrome runs with --mute-audio.*--assume-muted/);
  assert.deepEqual([world.gotoUrls.length, world.log.includes("newPage")], [0, false]);
  world = createWorld({ cmdline: null });
  r = await run(world, ["boot", "--assume-muted"], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /--assume-muted/);
  assert.equal(world.gotoUrls.length, 1);
});

await check("S2c boot: --mute-audio verifiably absent → exit 2 even with --assume-muted", async () => {
  const world = createWorld({ cmdline: ["--remote-debugging-port=9333", "--enable-automation"] });
  const r = await run(world, ["boot", "--assume-muted"], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 2);
  assert.match(r.err, /WITHOUT --mute-audio/);
  assert.equal(world.gotoUrls.length, 0);
});

await check("S2d boot: a film tab already open → exit 2 (single-login) unless --reuse; --reuse on a booted tab skips login", async () => {
  let world = createWorld({ filmPageOpen: true });
  let r = await run(world, ["boot"], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 2);
  assert.match(r.err, /already open .*password=\[redacted\].*--reuse/);
  assert.ok(!r.err.includes(PAGE_PW));
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["boot", "--reuse"]); // no password needed: no navigation
  assert.equal(r.code, 0, r.err);
  assert.equal(world.gotoUrls.length, 0);
  assert.deepEqual(filmSeq(world, ["clean", "own"]), [["clean", true], ["own"]]);
  assert.ok(!(r.out + r.err).includes(PAGE_PW));
});

await check("S2e boot: no password → exit 2; gate timeout names the failing condition (exit 1)", async () => {
  let world = createWorld();
  let r = await run(world, ["boot"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no password: pass --password=… or set FILM_PASSWORD/);
  assert.equal(world.gotoUrls.length, 0);
  world = createWorld({ boot: "neverFilm" });
  r = await run(world, ["boot", "--boot-timeout=20", "--json", `--password=${PASSWORD}`]);
  assert.equal(r.code, 1);
  const e = r.json().error;
  assert.equal(e.code, "BOOT_FAILED");
  assert.match(e.message, /timed out after 20 s — waiting for film/);
  assert.deepEqual(e.details.failing, ["film"]);
  assert.ok(!(r.out + r.err).includes(PASSWORD));
});

await check("S2f classifyBoot / waitForBoot: 'ready' from history, error after in-world ignored, SwiftShader mesh fallback after 90 s", async () => {
  const base = { state: "in-world", history: [{ state: "ready" }, { state: "in-world" }], sceneReadyEverFired: true, liveScene3d: true, film: true };
  assert.equal(classifyBoot(base).action, "go"); // 'ready' before in-world still counts
  assert.equal(classifyBoot({ ...base, state: "error", history: [{ state: "in-world" }, { state: "error" }], sceneReadyEverFired: false }, { elapsedMs: 10_000 }).action, "wait");
  const late = classifyBoot({ ...base, state: "error", history: [{ state: "in-world" }, { state: "error" }], sceneReadyEverFired: false }, { elapsedMs: SCENE_READY_FALLBACK_MS, meshCount: 150 });
  assert.equal(late.action, "go");
  assert.match(late.reason, /> 100 meshes after 90 s/);
  assert.equal(classifyBoot({ state: "error", history: [{ state: "connecting" }, { state: "error", message: "connect: timeout" }] }).action, "fail");
  assert.deepEqual(classifyBoot({ state: "connecting", history: [] }).failing, ["inWorld", "ready", "sceneReady", "liveScene3d", "film"]);
  // end to end on the fake page: never 'ready', never scene-ready, 150 meshes → go after 90 s of fake time
  const world = createWorld({ boot: "swiftshader" });
  world.navigated = true;
  const res = await waitForBoot(world.page, { timeoutMs: 180_000, now: () => world.clock, sleep: async (ms) => { world.clock += ms; world.tick(); } });
  assert.equal(res.ok, true);
  assert.ok(res.elapsedMs >= SCENE_READY_FALLBACK_MS && res.meshCount === 150, JSON.stringify({ e: res.elapsedMs, m: res.meshCount }));
});

// ── S3: go ───────────────────────────────────────────────────────────────────────────────────────────────

await check("S3a go <site>: gazetteer teleport.best → portal space → world.ready polled until ok (lbKeys uint32)", async () => {
  const world = createWorld({ filmPageOpen: true, readyAfter: 2, viewport: { width: 1280, height: 720 } });
  const r = await run(world, ["go", "holtburg", `--gazetteer=${GAZ}`, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(world.teleports, ["@telepoi Holtburg"]);
  const readies = world.filmCalls.filter((c) => c.m === "world.ready").map((c) => c.args[0]);
  assert.equal(readies.length, 3);
  assert.deepEqual(readies[0].lbKeys, [0xa9b40000]);
  assert.equal(readies[0].interiorLb, null);
  assert.ok(readies[0].timeoutSec <= 90 && readies[0].timeoutSec >= 1);
  const res = r.json().result;
  assert.equal(res.ok, true);
  assert.equal(res.portal.sawActive, true);
  assert.deepEqual(res.ready.lbKeys, ["0xA9B40000"]);
  // teleport strictly before the readiness polls; viewport from the boot mark re-applied
  assert.ok(idx(world.log, "film:world.teleport") < idx(world.log, "film:world.ready"));
  assert.deepEqual(world.cdpCalls.find((c) => c.method === "Emulation.setDeviceMetricsOverride").params, { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
});

await check("S3b go @teleloc (dungeon) and go <timeline site>; never ready → exit 1; no film page → exit 2", async () => {
  let world = createWorld({ filmPageOpen: true });
  let r = await run(world, ["go", "@teleloc", "0x01F60289", "96.7", "-10", "0"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(world.teleports, ["@teleloc 0x01F60289 96.7 -10 0"]);
  const rd = world.filmCalls.find((c) => c.m === "world.ready").args[0];
  assert.deepEqual([rd.lbKeys, rd.interiorLb], [[0x01f60000], 0x01f60000]);
  const p = makeProject("go-proj");
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["go", "dungeon", `--timeline=${p.tl}`]);
  assert.equal(r.code, 0, r.err);
  assert.equal(world.filmCalls.find((c) => c.m === "world.ready").args[0].interiorLb, 0x01f60000);
  world = createWorld({ filmPageOpen: true, readyAfter: 1e9 });
  r = await run(world, ["go", "holtburg", `--gazetteer=${GAZ}`, "--timeout=5"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^NOT READY after/);
  world = createWorld();
  r = await run(world, ["go", "holtburg", `--gazetteer=${GAZ}`]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no film page .*film boot/);
});

await check("S3c go holds the REAL heavy lock (HB_HEAVY_LOCK_DIR in a temp dir) for the whole command and releases it", async () => {
  const lockDir = path.join(TMP, "heavy.lock");
  const world = createWorld({ filmPageOpen: true });
  const seen = [];
  const film = world.win.__film;
  const orig = film.world.teleport;
  film.world.teleport = (cmd) => {
    seen.push(fs.existsSync(path.join(lockDir, "owner.json")) ? JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).label : null);
    return orig(cmd);
  };
  const r = await run(world, ["go", "holtburg", `--gazetteer=${GAZ}`], { realLock: true, env: { HB_HEAVY_LOCK_DIR: lockDir, HB_MIN_FREE_MB: "0" } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen, ["film go"]);
  assert.equal(fs.existsSync(lockDir), false, "lock released");
});

await check("S3d go prints map positions through units.js formatMap: S/W for a south-western site, @teleloc outdoors, a timeline site", async () => {
  const gsw = path.join(TMP, "gaz-sw.jsonl");
  fs.writeFileSync(gsw, `${JSON.stringify({ id: "obsidian-rim", name: "Obsidian Rim", kind: "landmark", cell: "0x10200019", lb: "0x1020", indoor: false, map: { ns: -80.8, ew: -61.6 }, teleport: { best: "@tele 80.80S 61.60W" }, tags: ["landmark"] })}\n`);
  let world = createWorld({ filmPageOpen: true });
  let r = await run(world, ["go", "obsidian-rim", `--gazetteer=${gsw}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /go obsidian-rim \(Obsidian Rim, 80\.8S, 61\.6W\): @tele 80\.80S 61\.60W/);
  assert.match(r.out, /^ready after .* at 80\.8S, 61\.6W$/m);
  assert.equal(/-80\.8|-61\.6/.test(r.out + r.err), false, r.out + r.err);
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["go", "@teleloc", "0xA9B40019", "84", "7.1", "94", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().result.map, "42.1N, 33.6E");
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["go", "@teleloc", "0x01F60289", "96.7", "-10", "0", "--json"]);
  assert.equal(r.json().result.map, null, "a dungeon cell has no map position");
  const p = makeProject("go-map");
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["go", "holtburg", `--timeline=${p.tl}`, "--json"]);
  assert.equal(r.json().result.map, "42.1N, 33.6E");
});

// ── S4: browser check ────────────────────────────────────────────────────────────────────────────────────

await check("S4 browser check: redacted pages, film page booted, mute verified, off-screen window, GPU; on-screen → 1", async () => {
  let world = createWorld({ filmPageOpen: true });
  let r = await run(world, ["browser", "check", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  const res = r.json().result;
  assert.equal(res.pages.length, 1);
  assert.match(res.pages[0].url, /password=\[redacted\]/);
  assert.equal(res.filmPage.booted, true);
  assert.equal(res.mute.browser.state, "verified");
  assert.equal(res.mute.page.audioManager, true);
  assert.equal(res.window.offScreen, true);
  assert.match(res.gpu.renderer, /GTX 1070/);
  assert.ok(!r.out.includes(PAGE_PW));
  world = createWorld({ filmPageOpen: true, windowBounds: { left: 100, top: 80, width: 1920, height: 1080, windowState: "normal" } });
  r = await run(world, ["browser", "check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FINDING: the film window is ON SCREEN/);
  world = createWorld({ filmPageOpen: true, cmdline: ["--enable-automation"] });
  r = await run(world, ["browser", "check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /WITHOUT --mute-audio/);
});

// ── S5: shoot ────────────────────────────────────────────────────────────────────────────────────────────

await check("S5a shoot --all: teleports only between sites, exact Annex-B drain, documented mux argv, reports, rehearsal", async () => {
  const p = makeProject("shoot-avc");
  const world = createWorld({ filmPageOpen: true, viewport: { width: 64, height: 36 } });
  ffReset();
  const lc = lockCalls.length;
  const r = await run(world, ["shoot", p.tl, "--all", `--ffmpeg=${FFMPEG}`, "--retakes=0"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(world.teleports, ["@telepoi Holtburg", "@teleloc 0x01F60289 96.70 -10.00 0.00 1 0 0 0"]);
  // never record across a teleport: no teleport between a take's start and its final drain
  const L = world.log;
  const starts = L.map((e, i) => (e === "shoot:start" ? i : -1)).filter((i) => i >= 0);
  assert.equal(starts.length, 2);
  for (const s of starts) {
    const done = idx(L, "drain:done", s);
    assert.ok(done > s);
    assert.equal(L.slice(s, done).includes("film:world.teleport"), false, "teleport inside a take");
  }
  const tp = L.map((e, i) => (e === "film:world.teleport" ? i : -1)).filter((i) => i >= 0);
  assert.ok(tp[0] < starts[0] && idx(L, "drain:done", starts[0]) < tp[1] && tp[1] < starts[1]);
  // prewarm after readiness, before the take
  assert.ok(idx(L, "film:world.prewarm") < starts[0]);
  // drained bytes are exactly the concatenated chunks
  const takes = path.join(p.dir, "takes");
  for (const [i, shot] of [[0, "s1"], [1, "s2"]]) {
    assert.equal(world.takeLog[i].shotId, shot);
    assert.deepEqual(fs.readFileSync(path.join(takes, `${shot}.h264`)), Buffer.concat(world.takeLog[i].chunks));
  }
  assert.deepEqual(ffCalls(), [
    ["-hide_banner", "-y", "-r", "10", "-i", path.join(takes, "s1.h264"), "-c", "copy", "-movflags", "+faststart", path.join(takes, "s1.mp4")],
    ["-hide_banner", "-y", "-r", "10", "-i", path.join(takes, "s2.h264"), "-c", "copy", "-movflags", "+faststart", path.join(takes, "s2.mp4")],
  ]);
  assert.deepEqual(world.filmCalls.find((c) => c.m === "shoot").args[0], { fps: 10, width: 64, height: 36, codec: "avc", bitrate: 40000000, mode: "stepped", locked: false });
  // fpv in a dungeon is rehearsed, then prepared again; the classic outdoor shot is not
  const s2Calls = world.filmCalls.filter((c) => ["prepare", "rehearse", "shoot"].includes(c.m)).map((c) => (c.m === "prepare" ? `prepare:${c.args[0].shotId}` : c.m));
  assert.deepEqual(s2Calls, ["prepare:s1", "shoot", "prepare:s2", "rehearse", "prepare:s2", "shoot"]);
  const rep = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s1.json"), "utf8"));
  assert.deepEqual([rep.file, rep.frames, rep.fps, rep.expectedFrames, rep.raw.kind, rep.verdict.keep, rep.verdict.source], [path.join(takes, "s1.mp4"), 10, 10, 10, "avc", true, "code"]);
  assert.equal(rep.page.realisedChecksum, "cafe");
  assert.equal(fs.readFileSync(path.join(p.dir, "reports", "shoot-log.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.ok(fs.existsSync(path.join(p.dir, "reports", "s2.rehearsal.json")));
  assert.equal(fs.readFileSync(path.join(p.dir, "reports", "s2.pilot.jsonl"), "utf8").trim().split("\n").length, 2);
  // readiness targets straight from the schedule (uint32)
  assert.deepEqual(world.filmCalls.find((c) => c.m === "world.ready").args[0].lbKeys, [0xa9b40000]);
  // no key: no broker, and any stale __filmJev binding is removed
  assert.equal(world.log.includes("expose:__filmJev"), false);
  assert.equal(typeof world.win.__filmJev, "undefined");
  assert.equal(lockCalls.length, lc + 1);
  assert.deepEqual([lockCalls.at(-1).label, lockCalls.at(-1).released], ["film shoot", true]);
  assert.match(r.out, /shot 2 take\(s\) across 2 site\(s\)/);
});

await check("S5b shoot --codec=vp9: the IVF file is byte-exact (header, frame count, per-frame size + pts); mux re-encodes", async () => {
  const p = makeProject("shoot-vp9");
  const world = createWorld({ filmPageOpen: true });
  ffReset();
  const r = await run(world, ["shoot", p.tl, "--shot=s1", "--codec=vp9", `--ffmpeg=${FFMPEG}`, "--retakes=0"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(world.teleports, ["@telepoi Holtburg"]);
  const ivf = fs.readFileSync(path.join(p.dir, "takes", "s1.ivf"));
  const chunks = world.takeLog[0].chunks;
  assert.equal(ivf.subarray(0, 4).toString("ascii"), "DKIF");
  assert.deepEqual([ivf.readUInt16LE(4), ivf.readUInt16LE(6), ivf.subarray(8, 12).toString("ascii"), ivf.readUInt16LE(12), ivf.readUInt16LE(14), ivf.readUInt32LE(16), ivf.readUInt32LE(20), ivf.readUInt32LE(24), ivf.readUInt32LE(28)],
    [0, 32, "VP90", 64, 36, 10, 1, chunks.length, 0]);
  const expected = Buffer.concat([ivfFileHeader({ width: 64, height: 36, fps: 10, frames: chunks.length }), ...chunks.flatMap((c, k) => [ivfFrameHeader(c.length, k), c])]);
  assert.deepEqual(ivf, expected);
  let off = IVF_HEADER_BYTES;
  for (let k = 0; k < chunks.length; k++) {
    assert.equal(ivf.readUInt32LE(off), chunks[k].length);
    assert.equal(ivf.readBigUInt64LE(off + 4), BigInt(k));
    off += 12 + chunks[k].length;
  }
  assert.equal(off, ivf.length);
  assert.deepEqual(ffCalls(), [muxArgv({ kind: "vp9", input: path.join(p.dir, "takes", "s1.ivf"), output: path.join(p.dir, "takes", "s1.mp4"), fps: 10 })]);
});

await check("S5c shoot --codec=frames: one JPEG per chunk (data URLs decoded), frames argv; sink sniffing", async () => {
  const p = makeProject("shoot-frames");
  const world = createWorld({ filmPageOpen: true });
  ffReset();
  const r = await run(world, ["shoot", p.tl, "--shot=s1", "--codec=frames", `--ffmpeg=${FFMPEG}`, "--retakes=0"]);
  assert.equal(r.code, 0, r.err + r.out);
  const dir = path.join(p.dir, "takes", "s1.frames");
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, Array.from({ length: 10 }, (_, k) => `${String(k).padStart(6, "0")}.jpg`));
  files.forEach((f, k) => assert.deepEqual(fs.readFileSync(path.join(dir, f)), world.takeLog[0].chunks[k]));
  // the JPEG frames are re-encoded with an even top-left crop (an odd canvas must not break libx264 yuv420p)
  assert.deepEqual(ffCalls(), [["-hide_banner", "-y", "-framerate", "10", "-start_number", "0", "-i", path.join(dir, "%06d.jpg"), "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14", "-movflags", "+faststart", path.join(p.dir, "takes", "s1.mp4")]]);
  assert.deepEqual([sniffChunkKind(chunkBytes(0, "avc")), sniffChunkKind(chunkBytes(0, "vp9")), sniffChunkKind(chunkBytes(0, "frames"))], ["avc", "vp9", "frames"]);
  // a sink without a codec name follows the bytes; repeated seqs are dropped, gaps counted
  const sinkDir = path.join(TMP, "sinktest");
  const sink = createTakeSink({ dir: sinkDir, name: "x", codec: "auto", fps: 10, width: 64, height: 36 });
  sink.write([{ seq: 1, b64: chunkBytes(1, "avc").toString("base64") }, { seq: 0, b64: chunkBytes(0, "avc").toString("base64") }]);
  sink.write([{ seq: 1, b64: chunkBytes(1, "avc").toString("base64") }, { seq: 3, b64: chunkBytes(3, "avc").toString("base64") }]);
  const st = sink.close();
  assert.deepEqual([st.kind, st.frames, st.duplicates, st.seqGaps], ["avc", 3, 1, 1]);
  assert.deepEqual(fs.readFileSync(path.join(sinkDir, "x.h264")), Buffer.concat([chunkBytes(0, "avc"), chunkBytes(1, "avc"), chunkBytes(3, "avc")]));
});

await check("S5d shoot: a rejected take is retaken; the kept retake becomes takes/<shot>.mp4, the first moves to .retake0", async () => {
  const p = makeProject("shoot-retake");
  const world = createWorld({ filmPageOpen: true, safetyByAttempt: [10, 0] }); // attempt 0: safety 'many' → retake
  ffReset();
  const r = await run(world, ["shoot", p.tl, "--shot=s1", `--ffmpeg=${FFMPEG}`, "--retakes=1"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(world.takeLog.length, 2);
  assert.equal(world.teleports.length, 1, "a retake never teleports");
  const takes = path.join(p.dir, "takes");
  assert.equal(fs.readFileSync(path.join(takes, "s1.mp4"), "utf8").trim(), `FAKE-FFMPEG ${path.join(takes, "s1.retake1.h264")}`);
  assert.equal(fs.readFileSync(path.join(takes, "s1.retake0.mp4"), "utf8").trim(), `FAKE-FFMPEG ${path.join(takes, "s1.h264")}`);
  const rep = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s1.json"), "utf8"));
  assert.equal(rep.keptAttempt, 1);
  assert.equal(rep.file, path.join(takes, "s1.mp4"));
  assert.deepEqual(rep.attempts.map((a) => [a.attempt, a.keep, a.band]), [[0, false, "act"], [1, true, "act"]]);
  assert.match(rep.attempts[0].reasons[0], /safety_adjustments is 'many'/);
  assert.equal(fs.readFileSync(path.join(p.dir, "reports", "shoot-log.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.match(r.err, /retaking s1/);
});

await check("S5e shoot with a JEV key: broker installed, page → __filmJev → client → fetch, telemetry files, JEV verdict", async () => {
  const p = makeProject("shoot-jev");
  const world = createWorld({ filmPageOpen: true, callJev: true });
  const fetch = makeFetch();
  const r = await run(world, ["shoot", p.tl, "--shot=s1", `--ffmpeg=${FFMPEG}`, "--retakes=0"], { env: { OPENROUTER_API_KEY: KEY }, fetch });
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(world.log.indexOf("expose:__filmJev") < world.log.indexOf("shoot:start"));
  assert.equal(world.jevResponses.length, 1);
  assert.equal(world.jevResponses[0].answers.maneuver.choice, "hold_path");
  assert.equal(world.jevResponses[0].seq, 1);
  assert.ok(fetch.calls.length >= 2 && fetch.calls.every((c) => c.auth === `Bearer ${KEY}`));
  const tele = fs.readFileSync(path.join(p.dir, "reports", "s1.jev.jsonl"), "utf8").trim().split("\n");
  assert.equal(tele.length, 1);
  assert.equal(JSON.parse(tele[0]).outcome, "ok");
  const rep = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s1.json"), "utf8"));
  assert.deepEqual([rep.verdict.source, rep.verdict.keep, rep.verdict.band], ["jev", true, "act"]);
  const clientLog = fs.readFileSync(path.join(p.dir, "reports", "jev-client.jsonl"), "utf8");
  assert.match(clientLog, /"event":"jev"/);
  for (const text of [clientLog, tele.join("\n"), r.out, r.err]) {
    assert.ok(!text.includes(KEY), "key leaked");
    assert.ok(!text.includes("near tree"), "pilot state leaked into a log");
  }
});

await check("S5f shoot: --site / --shot / --all are exclusive (exit 2); unknown shot → 2; not-ready site → exit 1, no take", async () => {
  const p = makeProject("shoot-sel");
  let world = createWorld({ filmPageOpen: true });
  let r = await run(world, ["shoot", p.tl, "--all", "--site=holtburg"]);
  assert.equal(r.code, 2);
  r = await run(world, ["shoot", p.tl]);
  assert.equal(r.code, 2);
  r = await run(world, ["shoot", p.tl, "--shot=s9"]);
  assert.equal(r.code, 2);
  world = createWorld({ filmPageOpen: true, readyAfter: 1e9 });
  r = await run(world, ["shoot", p.tl, "--site=holtburg", `--ffmpeg=${FFMPEG}`, "--json"]);
  assert.equal(r.code, 1);
  assert.equal(world.takeLog.length, 0);
  const res = r.json().result;
  assert.deepEqual(res.failures.map((f) => [f.shotId, f.stage]), [["s1", "ready"]]);
});

// ── S6: scout + rehearse ─────────────────────────────────────────────────────────────────────────────────

await check("S6 scout saves stills + metrics and --pick prints the band; rehearse saves the realised table + telemetry", async () => {
  const p = makeProject("scout");
  const jpeg = (n) => `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, n, 0xff, 0xd9]).toString("base64")}`;
  const scout = {
    ok: true,
    intent: { framing: "MS", angle: "eye" },
    candidates: [
      { id: 0, words: "camera 6 m south at eye level; subject clear; nearest obstacle far", metrics: { clearance: 6 }, still: jpeg(1) },
      { id: 1, words: "camera 3 m west; subject partly hidden by a tree", metrics: { clearance: 3 }, still: jpeg(2) },
      { id: 2, description: "high angle from the roof", metrics: { clearance: 9 } },
    ],
  };
  let world = createWorld({ filmPageOpen: true, scout });
  let r = await run(world, ["scout", p.tl, "--shot=s1", "--count=3", "--stills", "--pick"]);
  assert.equal(r.code, 0, r.err + r.out);
  const sc = world.filmCalls.find((c) => c.m === "scout");
  assert.equal(sc.args[0].shotId, "s1");
  assert.deepEqual(sc.args[1], { count: 3, stills: true, width: 640 });
  const dir = path.join(p.dir, "stills", "s1");
  assert.deepEqual(fs.readFileSync(path.join(dir, "cand-0.jpg")), Buffer.from([0xff, 0xd8, 0xff, 1, 0xff, 0xd9]));
  assert.ok(fs.existsSync(path.join(dir, "cand-1.jpg")) && !fs.existsSync(path.join(dir, "cand-2.jpg")));
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  assert.equal(metrics.candidates[0].still, "cand-0.jpg");
  assert.match(r.out, /pick: 0 · band confirm · code/);
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["rehearse", p.tl, "--shot=s2", "--fps=8"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(world.filmCalls.filter((c) => ["prepare", "rehearse"].includes(c.m)).map((c) => c.m), ["prepare", "rehearse"]);
  assert.deepEqual(world.filmCalls.find((c) => c.m === "rehearse").args[0], { fps: 8 });
  const reh = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s2.rehearsal.json"), "utf8"));
  assert.equal(reh.realisedTable.frames, 2);
  assert.equal(reh.telemetryCount, 2);
  assert.equal(fs.readFileSync(path.join(p.dir, "reports", "s2.pilot.jsonl"), "utf8").trim().split("\n").length, 2);
  r = await run(world, ["rehearse", p.tl, "--shot=nope"]);
  assert.equal(r.code, 2);
});

await check("S6b (r2-cli, math-2) rehearse / shoot / scout surface the page's issues and warnings: one warning line each, saved in the reports, exit unchanged", async () => {
  const p = makeProject("issues");
  const prepareExtra = (take) => (take?.shotId === "s2" ? { fromTable: false, validation: overspeedValidation(), flight: { ...OVERSPEED_FLIGHT } } : {});
  // rehearse: the prepare summary's overspeed → one warning naming the minimum duration; rehearsal.json `issues`
  let world = createWorld({ filmPageOpen: true, prepareExtra });
  let r = await run(world, ["rehearse", p.tl, "--shot=s2", "--fps=8", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.err.match(/warning: shot s2: prepare issue overspeed: /g)?.length, 1, r.err);
  assert.ok(r.err.includes(`shot s2: prepare issue overspeed: ${OVERSPEED_MSG}`), r.err);
  let res = r.json().result;
  assert.deepEqual(res.issues.map((i) => [i.code, i.stages, i.minDurationSec]), [["overspeed", ["prepare"], 11.9]]);
  assert.deepEqual(res.flight, OVERSPEED_FLIGHT);
  const reh = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s2.rehearsal.json"), "utf8"));
  assert.deepEqual([reh.issues[0].code, reh.issues[0].minDurationSec, reh.flight.minDurationSec, reh.realisedTable.frames], ["overspeed", 11.9, 11.9, 2]);
  r = await run(world, ["rehearse", p.tl, "--shot=s2", "--fps=8"]);
  assert.match(r.out, /rehearsed s2 at 8 fps → .* · 1 page issue\(s\): overspeed \(see the warnings\)/);
  // shoot --all: s2 (fpv, rehearsed, prepared twice) warns ONCE; its report and shoot-log row carry the issue; s1 none
  world = createWorld({ filmPageOpen: true, prepareExtra, shootExtra: (id) => (id === "s2" ? { flight: { ...OVERSPEED_FLIGHT } } : {}) });
  r = await run(world, ["shoot", p.tl, "--all", `--ffmpeg=${FFMPEG}`, "--retakes=0"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.err.match(/shot s2: [a-z/]+ issue overspeed/g)?.length, 1, r.err);
  assert.equal(/shot s1: .* issue /.test(r.err), false, r.err);
  assert.match(r.out, /s2: s2\.mp4 · \d+ frames · kept \(act, code\) · page issue\(s\): overspeed \(min 11\.9 s\)/);
  const s2 = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s2.json"), "utf8"));
  // (this fake's rehearse result carries no checks, so the rehearsal stage is not listed)
  assert.deepEqual(s2.issues.map((i) => [i.code, i.stages, i.minDurationSec]), [["overspeed", ["prepare", "shoot"], 11.9]]);
  assert.deepEqual([s2.flight, s2.validation, s2.rehearsed], [OVERSPEED_FLIGHT, { ok: false, counts: { overspeed: 1 } }, true]);
  const s1 = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s1.json"), "utf8"));
  assert.deepEqual([s1.issues, s1.flight, s1.validation], [[], null, null]);
  const rows = fs.readFileSync(path.join(p.dir, "reports", "shoot-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.shotId, x.issues.map((i) => i.code)]), [["s1", []], ["s2", ["overspeed"]]]);
  // scout: the page's warnings print and go into metrics.json
  world = createWorld({ filmPageOpen: true, scout: { ok: true, intent: { framing: "MS" }, warnings: ['intent.light "golden" was ignored: no usable sun (night)'], candidates: [] } });
  r = await run(world, ["scout", p.tl, "--shot=s1", "--count=2", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.err, /warning: scout s1: intent\.light "golden" was ignored: no usable sun \(night\)/);
  res = r.json().result;
  assert.deepEqual(res.warnings, ['intent.light "golden" was ignored: no usable sun (night)']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, "stills", "s1", "metrics.json"), "utf8")).warnings, res.warnings);
});

await check("S6c (r3-small) rehearse / shoot surface the realised flight tracking gap above FLIGHT_GAP_WARN_M (the safety net for acceleration-limited moves the speed check passes) and keep durationHelps", async () => {
  assert.equal(FLIGHT_GAP_WARN_M, 2);
  const p = makeProject("gap");
  // An acceleration-limited move: the speed check passed (overspeed false), yet the craft trailed by 30 m.
  const trailing = { preset: "cinema", vmax: 12, peakSpeed: 11.5, overspeed: false, minDurationSec: null, durationHelps: null, tracking: { frames: 65, maxGapM: 30.94, maxGapT: 3.5, endGapM: 29.38 } };
  const tight = { ...trailing, tracking: { frames: 65, maxGapM: 0.62, maxGapT: 1.2, endGapM: 0.05 } };
  const { tracking: _noTracking, ...prepCheck } = trailing; // prepare's check has no realised tracking
  let world = createWorld({ filmPageOpen: true, rehearseExtra: (take) => (take?.shotId === "s2" ? { flight: structuredClone(trailing) } : {}) });
  let r = await run(world, ["rehearse", p.tl, "--shot=s2", "--fps=8", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  const gapLine = "shot s2: rehearse issue tracking-gap at t=3.5 s: the flown camera trailed its planned path by up to 30.9 m and ended 29.4 m from it (warned above 2 m): the move asks for more speed or acceleration than the 'cinema' drone has, so the shot is framed off the plan; use a longer duration, ease 'linear' or a shorter, straighter path (or pilot.flightPreset 'fpv')";
  assert.equal(r.err.match(/issue tracking-gap/g)?.length, 1, r.err);
  assert.ok(r.err.includes(`warning: ${gapLine}`), r.err);
  let res = r.json().result;
  assert.deepEqual(res.issues, [{ code: "tracking-gap", message: gapLine.replace(/^shot s2: rehearse issue tracking-gap at t=3\.5 s: /, ""), t: 3.5, stages: ["rehearse"], preset: "cinema", maxGapM: 30.94, endGapM: 29.38 }]);
  const reh = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s2.rehearsal.json"), "utf8"));
  assert.deepEqual([reh.issues.map((i) => i.code), reh.flight.tracking.maxGapM], [["tracking-gap"], 30.94]);
  r = await run(world, ["rehearse", p.tl, "--shot=s2", "--fps=8"]);
  assert.match(r.out, /rehearsed s2 at 8 fps → .* · 1 page issue\(s\): tracking-gap \(see the warnings\)/);
  // a flight that kept within the threshold: no warning, no issue
  world = createWorld({ filmPageOpen: true, rehearseExtra: (take) => (take?.shotId === "s2" ? { flight: structuredClone(tight) } : {}) });
  r = await run(world, ["rehearse", p.tl, "--shot=s2", "--fps=8", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(/tracking-gap/.test(r.err), false, r.err);
  assert.deepEqual(r.json().result.issues, []);
  // shoot: prepare's overspeed with durationHelps false (kept machine-readable) + the take's own trailing gap
  const noHelpMsg = "the 8 s move peaks at 30.0 m/s, but the 'cinema' drone flies ≤ 12 m/s: the flown camera falls behind the planned path and ends short of it; a longer duration does not slow this move (its speed comes from its params, its ease or the subject it follows): lower params.speed, use ease 'linear' or give a shorter path (or pilot.flightPreset 'fpv')";
  world = createWorld({
    filmPageOpen: true,
    prepareExtra: (take) => (take?.shotId === "s2" ? { validation: { ok: false, counts: { overspeed: 1 }, issues: [{ code: "overspeed", t: null, message: noHelpMsg, preset: "cinema", vmax: 12, peakSpeed: 30, minDurationSec: null, durationHelps: false }] }, flight: { ...prepCheck, overspeed: true, peakSpeed: 30, durationHelps: false } } : {}),
    shootExtra: (id) => (id === "s2" ? { flight: { ...trailing, tracking: { frames: 10, maxGapM: 12.25, maxGapT: 0.8, endGapM: 12.25 } } } : {}),
  });
  r = await run(world, ["shoot", p.tl, "--all", `--ffmpeg=${FFMPEG}`, "--retakes=0", "--rehearse=off"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.err.match(/shot s2: [a-z/]+ issue overspeed/g)?.length, 1, r.err);
  assert.ok(r.err.includes(`shot s2: prepare issue overspeed: ${noHelpMsg}\n`), "the page message already says it: no second 'will not help'");
  assert.match(r.err, /warning: shot s2: shoot issue tracking-gap at t=0\.8 s: the flown camera trailed its planned path by up to 12\.3 m and ended 12\.3 m from it \(warned above 2 m\)/);
  assert.equal(/shot s1: .* issue /.test(r.err), false, r.err);
  assert.match(r.out, /s2: s2\.mp4 · \d+ frames · kept \(act, code\) · page issue\(s\): overspeed, tracking-gap/);
  const s2 = JSON.parse(fs.readFileSync(path.join(p.dir, "reports", "s2.json"), "utf8"));
  assert.deepEqual(s2.issues.map((i) => [i.code, i.stages, i.durationHelps ?? null, i.maxGapM ?? null, i.endGapM ?? null]), [["overspeed", ["prepare"], false, null, null], ["tracking-gap", ["shoot"], null, 12.25, 12.25]]);
  assert.equal(s2.page.flight.tracking.maxGapM, 12.25, "the realised tracking stays in the page block");
  const rows = fs.readFileSync(path.join(p.dir, "reports", "shoot-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.shotId, x.issues.map((i) => i.code)]), [["s1", []], ["s2", ["overspeed", "tracking-gap"]]]);
});

// ── S8: run ──────────────────────────────────────────────────────────────────────────────────────────────

function fixtureRegistry() {
  const reg = createRegistry();
  const build = (spec, ctx) => makeTrajectory({
    id: spec.technique, technique: spec.technique, family: spec.technique.split(".")[0], duration: spec.duration,
    positionAt: () => (Array.isArray(ctx?.anchor) ? ctx.anchor : [0, 0, 0]).map(Number), orientAt: () => ({ h: 0, p: 0, r: 0 }),
  });
  reg.registerTechnique(defineTechnique({ id: "classic.static", name: "Static", description: "Locked-off camera.", whenToUse: "Calm beats.", build }));
  reg.registerTechnique(defineTechnique({ id: "fpv.fpv-corridor", name: "FPV corridor", description: "Fly a corridor.", whenToUse: "Dungeons.", needs: { indoor: true }, build }));
  return reg;
}

await check("S8 run <project>: validate → compile → boot-check → shoot --all → assemble (+EDL) → contact sheet; stops at the first failure", async () => {
  const p = makeProject("runproj");
  fs.rmSync(p.tl);
  const world = createWorld({ filmPageOpen: true, viewport: { width: 64, height: 36 } });
  ffReset();
  const registry = fixtureRegistry();
  const out = capture();
  const err = capture();
  const deps = {
    stdout: out, stderr: err, env: { HOME }, cwd: TMP, chromium: world.chromium, registry,
    now: () => world.clock,
    sleep: async (ms) => { world.clock += ms; world.tick(); await new Promise((r) => setImmediate(r)); },
    fetch: makeFetch(), acquireHeavyLock: fakeLock, resolvePlaywright: () => "/fake", versions: { node: "20.20.2" },
  };
  let code = await main(["run", p.dir, `--ffmpeg=${FFMPEG}`, "--retakes=0", "--json"], deps);
  ALL_OUTPUT.push(out.text(), err.text());
  assert.equal(code, 0, err.text() + out.text());
  const res = JSON.parse(out.text()).result;
  assert.deepEqual(res.steps.map((s) => [s.step, s.code]), [["plan validate", 0], ["plan compile", 0], ["boot-check", 0], ["shoot --all", 0], ["assemble", 0], ["contact-sheet", 0]]);
  assert.ok(fs.existsSync(path.join(p.dir, "timeline.json")));
  assert.ok(fs.existsSync(path.join(p.dir, "edit", "final.edl")));
  const calls = ffCalls();
  assert.equal(calls.length, 4); // 2 takes muxed, 1 assembly, 1 contact sheet
  assert.ok(calls[2].includes("-filter_complex") && calls[2].at(-1) === path.join(p.dir, "edit", "final.mp4"));
  assert.equal(calls[3].at(-1), path.join(p.dir, "edit", "final.contact.jpg"));
  assert.equal(world.gotoUrls.length, 0, "an already-booted film page is not logged in again");
  // a broken plan stops the recipe at step 1 with exit 1, before touching the browser
  const bad = makeProject("runbad");
  fs.writeFileSync(path.join(bad.dir, "plan.json"), JSON.stringify({ version: 1, title: "x", sites: [], shots: [{ id: "a", site: "nowhere" }] }));
  const w2 = createWorld({ filmPageOpen: true });
  const out2 = capture();
  code = await main(["run", bad.dir], { ...deps, stdout: out2, stderr: capture(), chromium: w2.chromium });
  ALL_OUTPUT.push(out2.text());
  assert.equal(code, 1);
  assert.match(out2.text(), /run stopped \(exit 1\): plan validate exit 1/);
  assert.equal(w2.connects.length, 0);
});

await check("S8b run with no film page boots it (exact URL, password from env only), then a never-ready site stops it at shoot (exit 1)", async () => {
  const p = makeProject("runboot");
  fs.rmSync(p.tl);
  const world = createWorld({ readyAfter: 1e9 });
  ffReset();
  const before = lockCalls.length;
  const out = capture();
  const err = capture();
  const deps = {
    stdout: out, stderr: err, env: { HOME, FILM_PASSWORD: PASSWORD }, cwd: TMP, chromium: world.chromium, registry: fixtureRegistry(),
    now: () => world.clock,
    sleep: async (ms) => { world.clock += ms; world.tick(); await new Promise((r) => setImmediate(r)); },
    fetch: makeFetch(), acquireHeavyLock: fakeLock, resolvePlaywright: () => "/fake", versions: { node: "20.20.2" },
  };
  const code = await main(["run", p.dir, `--ffmpeg=${FFMPEG}`, "--width=64", "--height=36", "--json"], deps);
  ALL_OUTPUT.push(out.text(), err.text());
  assert.equal(code, 1, err.text());
  const res = JSON.parse(out.text()).result;
  assert.deepEqual(res.steps.map((s) => [s.step, s.code]), [["plan validate", 0], ["plan compile", 0], ["boot-check", 0], ["boot", 0], ["shoot --all", 1]]);
  assert.deepEqual(world.gotoUrls, [buildFilmUrl({ password: PASSWORD })], "one login with the exact film URL");
  assert.deepEqual(world.cdpCalls.find((c) => c.method === "Emulation.setDeviceMetricsOverride").params, { width: 64, height: 36, deviceScaleFactor: 1, mobile: false });
  assert.equal(world.takeLog.length, 0, "nothing recorded at a site that never became ready");
  assert.equal(ffCalls().length, 0, "no mux, no assembly, no contact sheet after the failed step");
  assert.ok(!fs.existsSync(path.join(p.dir, "edit", "final.mp4")));
  const shootStep = res.steps.find((s) => s.step === "shoot --all");
  assert.deepEqual(shootStep.data.failures.map((f) => [f.shotId, f.stage]).slice(0, 1), [[p.timeline.schedule[0].shots[0], "ready"]]);
  // the run lock is held around the whole recipe; the nested commands re-enter it and every hold is released
  const holds = lockCalls.slice(before);
  assert.equal(holds[0].label, "film run");
  assert.deepEqual(holds.map((h) => h.label).slice(1), ["film browser check", "film boot", "film shoot"]);
  assert.ok(holds.every((h) => h.released));
  assert.ok(!(out.text() + err.text()).includes(PASSWORD));
});

// SongAnalysis v1 fixture at a given tempo (beats on the grid, 4/4 bars, two sections).
function songJson(bpm, durationSec = 32) {
  const spb = 60 / bpm;
  const beats = [];
  for (let i = 0; i * spb < durationSec; i++) beats.push(Math.round(i * spb * 1000) / 1000);
  const bars = [];
  for (let i = 0; i * 4 < beats.length; i++) bars.push({ i, start: beats[i * 4], end: beats[i * 4 + 4] ?? durationSec });
  const half = Math.floor(bars.length / 2);
  return {
    version: 1, durationSec, sampleRate: 22050, sourceSampleRate: 22050, tempo: { bpm, confidence: 0.9 }, beats,
    downbeats: bars.map((b) => b.start), bars,
    sections: [
      { i: 0, start: 0, end: bars[half].start, startBar: 0, endBar: half, label: "A", role: "verse", energy: 0.4, repeatOf: null },
      { i: 1, start: bars[half].start, end: durationSec, startBar: half, endBar: bars.length, label: "B", role: "chorus", energy: 0.9, repeatOf: null },
    ],
    energy: { hopSec: 0.5, values: [] },
  };
}

await check("S8c run routes the song: plan.song.analysis/timeline.song.file by default; --song-analysis → plan steps, --song-audio → assemble; --song refused", async () => {
  const dir = path.join(TMP, "runsong");
  fs.mkdirSync(path.join(dir, "song"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
    version: 1, title: "song reel", format: { width: 64, height: 36, fps: 10, capture: "stepped" },
    song: { file: "song/song.mp3", analysis: "song/song.json" },
    sites: [{ id: "holtburg", teleport: "@telepoi Holtburg", anchor: { cell: "0xA9B40019", local: [84, 7.1, 94] } }],
    shots: [{ id: "s1", site: "holtburg", technique: "classic.static", duration: { beats: 4 }, standingOrder: "Hold still; keep 3 m from roofs." }],
  }));
  fs.writeFileSync(path.join(dir, "song", "song.json"), JSON.stringify(songJson(120)));
  fs.writeFileSync(path.join(dir, "song", "song.mp3"), "the plan's song");
  fs.writeFileSync(path.join(dir, "song", "other.mp3"), "a project-relative alternative");
  const alt = path.join(TMP, "alt-song");
  fs.mkdirSync(alt, { recursive: true });
  fs.writeFileSync(path.join(alt, "slow.json"), JSON.stringify(songJson(60)));
  fs.writeFileSync(path.join(alt, "alt.mp3"), "the alternative audio");
  const runIt = async (argv) => {
    const world = createWorld({ filmPageOpen: true, viewport: { width: 64, height: 36 } });
    ffReset();
    const out = capture();
    const err = capture();
    const code = await main(["run", dir, `--ffmpeg=${FFMPEG}`, "--retakes=0", "--json", ...argv], {
      stdout: out, stderr: err, env: { HOME }, cwd: TMP, chromium: world.chromium, registry: fixtureRegistry(),
      now: () => world.clock,
      sleep: async (ms) => { world.clock += ms; world.tick(); await new Promise((r) => setImmediate(r)); },
      fetch: makeFetch(), acquireHeavyLock: fakeLock, resolvePlaywright: () => "/fake", versions: { node: "20.20.2" },
    });
    ALL_OUTPUT.push(out.text(), err.text());
    const assembleArgv = ffCalls().find((c) => c.includes("-filter_complex")) ?? null;
    const timeline = fs.existsSync(path.join(dir, "timeline.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8")) : null;
    return { code, out: out.text(), err: err.text(), world, assembleArgv, timeline };
  };
  // defaults: the plan's analysis (120 BPM → 4 beats = 2 s) and the timeline's audio
  let r = await runIt([]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.timeline.items[0].editDuration, 2);
  assert.ok(r.assembleArgv.includes(path.join(dir, "song", "song.mp3")), JSON.stringify(r.assembleArgv));
  // explicit: the 60 BPM analysis reaches validate + compile (4 beats = 4 s), the alt audio reaches assemble only
  r = await runIt([`--song-analysis=${path.join(alt, "slow.json")}`, `--song-audio=${path.join(alt, "alt.mp3")}`]);
  assert.equal(r.code, 0, r.err + r.out);
  const steps = JSON.parse(r.out).result.steps;
  assert.deepEqual(steps.map((s) => [s.step, s.code]), [["plan validate", 0], ["plan compile", 0], ["boot-check", 0], ["shoot --all", 0], ["assemble", 0], ["contact-sheet", 0]]);
  assert.equal(steps[0].data.compile.duration, 4, "plan validate compiled with --song-analysis");
  assert.equal(r.timeline.items[0].editDuration, 4);
  assert.equal(r.timeline.song.bpm, 60);
  assert.ok(r.assembleArgv.includes(path.join(alt, "alt.mp3")));
  assert.equal(r.assembleArgv.includes(path.join(dir, "song", "song.mp3")), false);
  assert.equal(steps[4].data.audio.file, path.join(alt, "alt.mp3"));
  // a relative --song-audio that exists only under the project resolves there
  r = await runIt(["--song-audio=song/other.mp3"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(r.assembleArgv.includes(path.join(dir, "song", "other.mp3")));
  // --song is ambiguous in run → 2 before any browser work; a missing explicit file → 2
  r = await runIt([`--song=${path.join(alt, "alt.mp3")}`]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--song-analysis=<song\.json> and\/or --song-audio=<audio>/);
  assert.equal(r.world.connects.length, 0);
  r = await runIt(["--song-audio=missing.mp3"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--song-audio: no such song audio file/);
  assert.equal(r.world.connects.length, 0);
});

// ── S9: status ───────────────────────────────────────────────────────────────────────────────────────────

// A film page in the state `boot` leaves: camera owned, frame clean, avatar film-hidden.
function bootedFilmWorld(opts = {}) {
  const world = createWorld({ filmPageOpen: true, ...opts });
  const film = world.win.__film;
  film.own();
  film.clean(true);
  film.world.avatar(false);
  world.filmCalls.length = 0;
  world.log.length = 0;
  return world;
}

await check("S9a status: __film.status() + the camera/avatar/canvas probe; nothing else called; heavy lock held and released", async () => {
  const world = bootedFilmWorld();
  const lc = lockCalls.length;
  let r = await run(world, ["status", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  const res = r.json().result;
  assert.deepEqual([res.status.cameraOwned, res.status.clean, res.restored, res.actions], [true, true, null, []]);
  assert.deepEqual(res.probe, { cameraMode: "follow", avatar: { guid: "0x50000001", filmHidden: true, visible: false, filmHiddenCount: 1 }, canvas: { width: 1920, height: 1080, source: "__renderScaleState" } });
  assert.deepEqual(world.filmCalls.map((c) => c.m), ["status"]);
  assert.equal(world.log.some((e) => e.startsWith("expose:") || e === "goto" || e === "newPage" || e === "cdp:Emulation.setDeviceMetricsOverride"), false, world.log.join(", "));
  assert.deepEqual([lockCalls.length, lockCalls.at(-1).label, lockCalls.at(-1).released], [lc + 1, "film status", true]);
  r = await run(world, ["status"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^film page: camera owned \(mode follow\) · frame clean · avatar film-hidden · canvas 1920×1080/);
  assert.match(r.out, /^status: \{\n {2}"ok": true,/m);
  assert.match(r.out, /"cameraOwned": true/);
  assert.ok(!(r.out + r.err).includes(PAGE_PW));
});

await check("S9b status --release: release() → clean(false) → world.avatar(true), verified via status; --own --clean=on --avatar=off re-owns", async () => {
  const world = bootedFilmWorld();
  let r = await run(world, ["status", "--release", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(filmSeq(world, ["release", "clean", "world.avatar", "status"]), [["release"], ["clean", false], ["world.avatar", true], ["status"]]);
  const res = r.json().result;
  assert.deepEqual(res.restored, { follow: true, frame: true, avatar: true });
  assert.deepEqual(res.actions.map((a) => a.call), ["release()", "clean(false)", "world.avatar(true)"]);
  assert.equal(res.actions[0].result.wasOwned, true);
  assert.deepEqual([res.status.cameraOwned, res.status.clean, res.probe.cameraMode, res.probe.avatar.visible], [false, false, "orbit", true]);
  world.filmCalls.length = 0;
  r = await run(world, ["status", "--own", "--clean=on", "--avatar=off", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(filmSeq(world, ["own", "clean", "world.avatar"]), [["own"], ["clean", true], ["world.avatar", false]]);
  const res2 = r.json().result;
  assert.deepEqual([res2.status.cameraOwned, res2.status.clean, res2.probe.avatar.filmHidden, res2.probe.cameraMode], [true, true, true, "follow"]);
  r = await run(world, ["status", "--release"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^release: follow restored yes · frame restored yes · avatar visible yes$/m);
});

await check("S9c status --release: a running take → FILM_BUSY exit 1, nothing after; avatar still hidden → exit 1; bad flags → 2; no film page → 2", async () => {
  let world = bootedFilmWorld();
  world.busy = "shoot";
  let r = await run(world, ["status", "--release", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.json().error.code, "FILM_BUSY");
  assert.deepEqual(world.filmCalls.map((c) => c.m), ["release"]);
  world = bootedFilmWorld();
  world.avatarBroken = true;
  r = await run(world, ["status", "--release"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /avatar visible NO/);
  assert.match(r.out, /FINDING: the avatar is still film-hidden after world\.avatar\(true\)/);
  for (const bad of [["--release", "--own"], ["--release", "--clean=on"], ["--release", "--avatar=off"], ["--clean=maybe"]]) {
    world.filmCalls.length = 0;
    r = await run(world, ["status", ...bad]);
    assert.equal(r.code, 2, bad.join(" "));
    assert.equal(world.filmCalls.length, 0, `${bad.join(" ")} touched the page`);
  }
  world = createWorld();
  r = await run(world, ["status"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no film page .*film boot/);
});

// ── S3e: the heavy-lock record never holds the password; odd viewport sizes are refused ─────────────────────

await check("S3e (tooling-4) boot --password=…: the REAL heavy-lock owner.json holds a scrubbed cmd, never the password; argv restored", async () => {
  const lockDir = path.join(TMP, "heavy-pw.lock");
  const world = createWorld();
  const seen = [];
  const orig = world.chromium.connectOverCDP;
  world.chromium.connectOverCDP = async (url) => {
    // runs INSIDE withLock: the lock is held and owner.json written
    seen.push(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    return orig(url);
  };
  const argv = ["boot", `--password=${PASSWORD}`, "--assume-muted"];
  const savedArgv = process.argv.slice();
  process.argv.splice(0, process.argv.length, savedArgv[0], "/opt/hb/tools/film/film.mjs", ...argv);
  const argvBefore = process.argv.slice();
  let r;
  let argvAfter;
  try {
    r = await run(world, argv, { realLock: true, env: { HB_HEAVY_LOCK_DIR: lockDir, HB_MIN_FREE_MB: "0" } });
    argvAfter = process.argv.slice();
  } finally {
    process.argv.splice(0, process.argv.length, ...savedArgv);
  }
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(seen.length, 1);
  const owner = JSON.parse(seen[0]);
  assert.ok(!seen[0].includes(PASSWORD) && !seen[0].includes(encodeURIComponent(PASSWORD)), `password in owner.json: ${seen[0]}`);
  assert.equal(owner.cmd, "film.mjs boot --password=[redacted] --assume-muted");
  assert.equal(owner.label, "film boot");
  assert.equal(fs.existsSync(lockDir), false, "lock released");
  // the CLI scrubbed process.argv only while acquiring: the caller's argv came back unchanged
  assert.deepEqual(argvAfter, argvBefore);
  // and the director is told to prefer FILM_PASSWORD (argv is visible in ps while the command runs)
  assert.match(r.err, /--password=… is visible to every local user .*prefer FILM_PASSWORD/);
  // scrubbedArgv: --password/--pw/--key/--token values and (through the CLI scrubber) registered secrets anywhere
  const io = { scrub: (t) => String(t).split(PASSWORD).join("[redacted]") };
  assert.deepEqual(scrubbedArgv({ io }, ["node", "film.mjs", "go", `--base=http://h/?password=${PASSWORD}`, "--pw=x", "--key=abc", "--token=t", "--keep=1"]),
    ["node", "film.mjs", "go", "--base=http://h/?password=[redacted]", "--pw=[redacted]", "--key=[redacted]", "--token=[redacted]", "--keep=1"]);
});

await check("S3f (tooling-7) boot / go refuse an odd --width or --height (exit 2, H.264 4:2:0) before touching the page", async () => {
  let world = createWorld();
  let r = await run(world, ["boot", "--width=1279", "--height=720", "--assume-muted"], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 2);
  assert.match(r.err, /--width must be even \(H\.264 4:2:0\)/);
  assert.equal(world.gotoUrls.length, 0);
  world = createWorld({ filmPageOpen: true });
  r = await run(world, ["go", "holtburg", `--gazetteer=${GAZ}`, "--width=1280", "--height=633"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--height must be even/);
  assert.equal(world.teleports.length, 0);
});

// ── S10: shootSchedule robustness (direct, against a fake page whose takes can hang until __film.abort()) ─────

const avcChunk = (k) => Buffer.from([0, 0, 0, 1, k === 0 ? 0x65 : 0x41, k & 0xff, 0x5c]);

/**
 * A fake film page for shootSchedule: a take produces its frames one per macrotask, then — when `hang(shotId,
 * nth)` says so — keeps running until __film.abort() (unless `ignoreAbort`). status() reports active/busy/
 * take.running like scene3d/film/index.js; prepare/shoot refuse with FILM_BUSY while a take runs; every teleport
 * records whether a take was running at that moment. Like take_player.abort(), an abort only stops a take whose
 * run has started: `beforeRun(id, nth)` (awaited after busy='shoot', before the run exists) models index.js's
 * ready() + clean-frame window, `onAbort(wasRunning)` sees every abort. `prepareExtra(take)`, `rehearseExtra(id)`
 * and `shootExtra(id, nth)` add fields (validation, flight, warnings…) to those results.
 */
function makeTakePage(opts = {}) {
  const st = { calls: [], teleports: [], busy: null, run: null, rec: null, prepared: null, aborts: 0, shootsBy: {}, endAll: null };
  const hangs = (id, nth) => (typeof opts.hang === "function" ? opts.hang(id, nth) : false);
  const film = {
    status() {
      st.calls.push("status");
      return { ok: true, version: "film-1", active: st.busy !== null || st.run !== null, busy: st.busy, take: { running: st.run ? { frames: st.run.k } : null } };
    },
    abort() {
      st.calls.push("abort");
      st.aborts++;
      const was = Boolean(st.run);
      if (st.run && !opts.ignoreAbort) {
        st.run.abort = true;
        st.run.wake?.();
      }
      opts.onAbort?.(was);
      return { ok: true, wasRunning: was };
    },
    world: {
      teleport(cmd) {
        st.calls.push(`teleport ${cmd}`);
        st.teleports.push({ cmd, takeRunning: st.run !== null || st.busy !== null });
        if (opts.teleportFails?.includes(cmd)) return { ok: false, error: { code: "FILM_COMMAND_FAILED", message: `${cmd} refused` }, code: "FILM_COMMAND_FAILED" };
        return { ok: true };
      },
      ready() {
        st.calls.push("ready");
        return { ok: true, checks: { terrain: true }, waitedMs: 1 };
      },
      ...(opts.noPrewarm ? {} : {
        prewarm(o) {
          st.calls.push("prewarm");
          return typeof opts.prewarm === "function" ? opts.prewarm(st.teleports.at(-1)?.cmd, o) : { ok: true, landblocks: 1 };
        },
      }),
      avatar() {
        return { ok: true };
      },
    },
    prepare(take) {
      st.calls.push(`prepare ${take.shotId}`);
      if (st.busy || st.run) return { ok: false, error: { name: "FilmError", code: "FILM_BUSY", message: `film is busy (${st.busy ?? "take"} is running)` }, code: "FILM_BUSY" };
      st.prepared = take;
      return { ok: true, ...(opts.prepareExtra?.(take) ?? {}) };
    },
    async rehearse(o) {
      const id = st.prepared.shotId;
      st.calls.push(`rehearse ${id}`);
      st.busy = "rehearse";
      try {
        await opts.onRehearse?.(id);
      } finally {
        st.busy = null;
      }
      return { ok: true, realisedTable: { fps: o.fps, frames: 1, rows: [[0, 1, 2, 3, 1, 0, 0, 0, 60, 0, 0]] }, pilotTelemetry: [{ seq: 1, source: "code" }], ...(opts.rehearseExtra?.(id) ?? {}) };
    },
    async shoot(o) {
      const id = st.prepared.shotId;
      st.calls.push(`shoot ${id}`);
      if (st.busy || st.run) return { ok: false, error: { code: "FILM_BUSY", message: "busy" }, code: "FILM_BUSY" };
      const nth = st.shootsBy[id] ?? 0;
      st.shootsBy[id] = nth + 1;
      st.busy = "shoot";
      const run = { id, nth, queue: [], done: false, abort: false, k: 0, drains: 0, wake: null };
      if (opts.beforeRun) await opts.beforeRun(id, nth);
      st.run = run;
      st.rec = run;
      try {
        await opts.onShoot?.(id, nth);
        const frames = Math.round(st.prepared.spec.duration * o.fps);
        for (let k = 0; k < frames && !run.abort; k++) {
          run.queue.push({ seq: k, b64: avcChunk(k).toString("base64"), timestampUs: Math.round((k * 1e6) / o.fps), key: k === 0 });
          run.k = k + 1;
          await new Promise((r) => setImmediate(r));
        }
        if (hangs(id, nth) && !run.abort) await new Promise((r) => { run.wake = r; });
      } finally {
        run.done = true;
        st.run = null;
        st.busy = null;
      }
      return run.abort ? { ok: false, error: { code: "FILM_ABORTED", message: "take aborted" }, code: "FILM_ABORTED" } : { ok: true, frames: run.k, safety: { adjustedFrames: 0 }, ...(opts.shootExtra?.(id, nth) ?? {}) };
    },
    recorder: {
      drain() {
        st.calls.push("drain");
        const run = st.rec;
        if (!run) return { ok: true, chunks: [], done: true };
        run.drains++;
        if (typeof opts.drainFails === "function" && opts.drainFails(run.id, run.nth, run.drains)) throw new Error("Target page, context or browser has been closed");
        return { ok: true, chunks: run.queue.splice(0), done: run.done && run.queue.length === 0, stats: { codec: "avc1.640033" } };
      },
    },
  };
  st.endAll = () => {
    if (st.run) {
      st.run.abort = true;
      st.run.wake?.();
    }
  };
  const win = { __film: film };
  st.film = film;
  st.page = {
    async evaluate(fn, arg) {
      globalThis.window = win;
      return fn(arg === undefined ? undefined : structuredClone(arg));
    },
  };
  return st;
}

function shootTimeline(sites) {
  const items = [];
  const schedule = [];
  for (const s of sites) {
    schedule.push({ siteId: s.id, teleport: `@telepoi ${s.id}`, ready: { lbKeys: [0xa9b40000], timeoutSec: 30 }, prewarm: { points: [[0, 0, 0]], radius: 96 }, shots: s.shots.map((x) => x.id) });
    for (const x of s.shots) {
      items.push({ shotId: x.id, siteId: s.id, technique: x.technique ?? "classic.static", family: x.family ?? "classic", captureMode: x.mode ?? "stepped", takeDuration: 0.5, takeFrames: 5, preRollSec: 0, take: { shotId: x.id, spec: { duration: 0.5 } } });
    }
  }
  return { fps: 10, width: 64, height: 36, items, schedule };
}

// A spawn that "muxes" by writing `MUX <input>` to the output; the n-th calls listed in failOn exit 1.
function fakeMuxSpawn({ failOn = [] } = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(args);
    const n = calls.length;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (failOn.includes(n)) {
        child.stderr.emit("data", Buffer.from("[libx264] Error while opening encoder\n"));
        child.emit("close", 1, null);
        return;
      }
      const out = args[args.length - 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `MUX ${args[args.indexOf("-i") + 1]}\n`);
      child.emit("close", 0, null);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function runSchedule(tp, timeline, extra = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, "sched-"));
  const paths = { dir, takes: path.join(dir, "takes"), reports: path.join(dir, "reports"), shootLog: path.join(dir, "reports", "shoot-log.jsonl") };
  const infos = [];
  const warns = [];
  let clock = 5_000_000;
  const spawn = extra.spawn ?? fakeMuxSpawn();
  let r;
  let error = null;
  try {
    r = await shootSchedule({
      page: tp.page,
      timeline,
      selection: selectSchedule(timeline, { all: true }),
      paths,
      codec: "avc",
      retakes: extra.retakes ?? 0,
      rehearse: extra.rehearse ?? "auto",
      ffmpeg: "/fake/ffmpeg",
      spawn,
      fs: extra.fs ?? fs,
      keepOrRetake: extra.keepOrRetake ?? (async () => ({ keep: true, band: "act", source: "code", reasons: [] })),
      jev: null,
      broker: extra.broker ?? null,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await new Promise((res) => setImmediate(res));
      },
      io: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)), scrub: (t) => String(t) },
      drainPollMs: 50,
    });
  } catch (e) {
    error = e;
  }
  return { r, error, paths, infos, warns, spawn, shootLog: () => readJsonl(paths.shootLog), elapsedMs: () => clock - 5_000_000 };
}

const failStages = (r) => r.failures.map((f) => [f.shotId, f.stage]);

await check("S10a (contracts-6/tooling-0) an incomplete or failing prewarm warns and shoots anyway; a site whose teleport fails is a failure, the rest still runs", async () => {
  const tp = makeTakePage({
    teleportFails: ["@telepoi C"],
    prewarm: (cmd) => {
      if (cmd === "@telepoi A") return { ok: false, timedOut: true, waitedMs: 30000, lbKeys: ["0xA9B40000", "0xA9B50000"], missing: { terrain: ["0xA9B50000"], statics: [], buildings: ["0xA9B50000"], envCells: [] } };
      if (cmd === "@telepoi B") throw new Error("prewarm exploded");
      return { ok: true };
    },
  });
  const tl = shootTimeline([{ id: "A", shots: [{ id: "a1" }, { id: "a2" }] }, { id: "B", shots: [{ id: "b1" }] }, { id: "C", shots: [{ id: "c1" }] }, { id: "D", shots: [{ id: "d1" }] }]);
  const res = await runSchedule(tp, tl);
  assert.equal(res.error, null, res.error?.stack);
  const { r } = res;
  // every site is visited, every shot of a reachable site is shot and kept
  assert.deepEqual(tp.teleports.map((t) => t.cmd), ["@telepoi A", "@telepoi B", "@telepoi C", "@telepoi D"]);
  assert.deepEqual(r.shots.map((s) => [s.shotId, s.kept]), [["a1", true], ["a2", true], ["b1", true], ["d1", true]]);
  assert.deepEqual(failStages(r), [["c1", "site"]]);
  assert.match(r.failures[0].message, /site C setup failed: __film\.world\.teleport failed: @telepoi C refused/);
  assert.equal(r.ok, false);
  // the warnings name the missing landblocks; the shoot-log and the site's take reports carry the note
  assert.ok(res.warns.some((w) => /site A: prewarm incomplete \(timed out after 30000 ms\) — missing terrain: 0xA9B50000; buildings: 0xA9B50000; shooting anyway/.test(w)), res.warns.join("\n"));
  assert.ok(res.warns.some((w) => /site B: prewarm incomplete \(prewarm exploded\)/.test(w)), res.warns.join("\n"));
  const rows = res.shootLog();
  const pw = rows.filter((x) => x.stage === "prewarm");
  assert.deepEqual(pw.map((x) => [x.siteId, x.timedOut]), [["A", true], ["B", false]]);
  assert.deepEqual(pw[0].missing.terrain, ["0xA9B50000"]);
  assert.ok(rows.some((x) => x.stage === "site" && x.siteId === "C" && x.ok === false));
  const a1 = JSON.parse(fs.readFileSync(path.join(res.paths.reports, "a1.json"), "utf8"));
  assert.deepEqual([a1.prewarm.ok, a1.prewarm.timedOut, a1.prewarm.waitedMs], [false, true, 30000]);
  const d1 = JSON.parse(fs.readFileSync(path.join(res.paths.reports, "d1.json"), "utf8"));
  assert.equal(d1.prewarm, undefined, "a complete prewarm adds no note");
  // a page without world.prewarm is a usage error (exit 2), not a silent skip
  const bare = makeTakePage({ noPrewarm: true });
  const res2 = await runSchedule(bare, shootTimeline([{ id: "A", shots: [{ id: "a1" }] }]));
  assert.ok(res2.error instanceof FilmCliError, String(res2.error));
  assert.deepEqual([res2.error.exitCode, res2.error.code], [EXIT.USAGE, "NO_METHOD"]);
});

// The page-side order of a failed take: the failing drain, then abort, then status until idle, then the next step.
// settlePage re-sends the abort on every poll that still finds the page busy: EVERY abort precedes the next step.
function assertAbortedBeforeNext(tp, nextCall) {
  const iAbort = tp.calls.indexOf("abort");
  const iLastAbort = tp.calls.lastIndexOf("abort");
  const iNext = tp.calls.indexOf(nextCall);
  assert.ok(iAbort >= 0, `no __film.abort() call: ${tp.calls.join(" | ")}`);
  assert.ok(iNext > iLastAbort, `${nextCall} before the last abort: ${tp.calls.join(" | ")}`);
  assert.ok(tp.calls.slice(iLastAbort, iNext).includes("status"), "status polled (idle) between the last abort and the next step");
}

// One failed take: at least one abort, never more than PAGE_ABORT_MAX, each answered by a status poll.
function assertAbortsBounded(tp) {
  assert.ok(tp.aborts >= 1 && tp.aborts <= PAGE_ABORT_MAX, `aborts ${tp.aborts}`);
}

await check("S10b (tooling-2) recorder.drain rejects mid-take: the page take is aborted and awaited, the next prepare works, no teleport while a take runs", async () => {
  const tp = makeTakePage({ hang: (id) => id === "a1", drainFails: (id, nth, d) => id === "a1" && d === 3 });
  const tl = shootTimeline([{ id: "A", shots: [{ id: "a1" }, { id: "a2" }] }, { id: "B", shots: [{ id: "b1" }] }]);
  const res = await runSchedule(tp, tl);
  assert.equal(res.error, null, res.error?.stack);
  const { r } = res;
  assert.deepEqual(failStages(r), [["a1", "take"]]);
  assert.match(r.failures[0].message, /__film\.recorder\.drain failed: Target page, context or browser has been closed/);
  assert.deepEqual(r.shots.map((s) => [s.shotId, s.kept]), [["a2", true], ["b1", true]]);
  assertAbortsBounded(tp);
  assertAbortedBeforeNext(tp, "prepare a2");
  assert.equal(tp.calls.filter((c) => c === "prepare a2").length, 1, "a2 prepared once, not refused as busy");
  assert.deepEqual(tp.teleports.map((t) => [t.cmd, t.takeRunning]), [["@telepoi A", false], ["@telepoi B", false]]);
  const row = res.shootLog().find((x) => x.shotId === "a1" && x.ok === false);
  assert.deepEqual([row.pageIdle.ok, row.pageIdle.aborted], [true, true]);
  assert.ok(res.warns.some((w) => /take a1 failed .*the page is idle again/.test(w)), res.warns.join("\n"));
  // the failed take's partial raw file stays; it was never muxed
  assert.ok(fs.existsSync(path.join(res.paths.takes, "a1.h264")));
  assert.equal(fs.existsSync(path.join(res.paths.takes, "a1.mp4")), false);
});

await check("S10c (tooling-2) the take sink's disk write throws (ENOSPC) mid-take: abort + wait for idle, then the schedule goes on", async () => {
  let writes = 0;
  const enospcFs = {
    ...fs,
    writeSync(fd, buf, ...rest) {
      if (++writes === 3) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      return fs.writeSync(fd, buf, ...rest);
    },
  };
  const tp = makeTakePage({ hang: (id) => id === "a1" });
  const tl = shootTimeline([{ id: "A", shots: [{ id: "a1" }, { id: "a2" }] }, { id: "B", shots: [{ id: "b1" }] }]);
  const res = await runSchedule(tp, tl, { fs: enospcFs });
  assert.equal(res.error, null, res.error?.stack);
  assert.deepEqual(failStages(res.r), [["a1", "take"]]);
  assert.match(res.r.failures[0].message, /ENOSPC/);
  assert.deepEqual(res.r.shots.map((s) => s.shotId), ["a2", "b1"]);
  assertAbortsBounded(tp);
  assertAbortedBeforeNext(tp, "prepare a2");
  assert.ok(tp.teleports.every((t) => t.takeRunning === false), JSON.stringify(tp.teleports));
});

await check("S10d (tooling-2) a page that will not go idle after abort is never teleported: the remaining shots fail at 'busy'", async () => {
  const tp = makeTakePage({ hang: (id) => id === "a1", ignoreAbort: true, drainFails: (id, nth, d) => id === "a1" && d === 2 });
  const tl = shootTimeline([{ id: "A", shots: [{ id: "a1" }, { id: "a2" }] }, { id: "B", shots: [{ id: "b1" }, { id: "b2" }] }]);
  const res = await runSchedule(tp, tl);
  assert.equal(res.error, null, res.error?.stack);
  assert.deepEqual(failStages(res.r), [["a1", "take"], ["a2", "busy"], ["b1", "busy"], ["b2", "busy"]]);
  assert.match(res.r.failures[1].message, /the page did not go idle within 90 s after __film\.abort\(\) \(still busy \(shoot\)\) — not teleporting/);
  assert.deepEqual(tp.teleports.map((t) => t.cmd), ["@telepoi A"], "no teleport while the take may still be recording");
  assert.equal(tp.calls.includes("prepare a2"), false);
  assert.ok(res.elapsedMs() >= PAGE_IDLE_WAIT_MS, `waited ${res.elapsedMs()} ms on the film clock`);
  assert.ok(res.shootLog().some((x) => x.stage === "busy" && x.siteId === "B"));
  tp.endAll();
});

await check("S10e (tooling-2) a take left running on the page (another process) is aborted BEFORE the first teleport", async () => {
  const tp = makeTakePage({ hang: (id) => id === "leftover" });
  tp.film.prepare({ shotId: "leftover", spec: { duration: 0.2 } });
  const leftover = tp.film.shoot({ fps: 10 });
  assert.equal(tp.film.status().active, true);
  tp.calls.length = 0;
  const res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "a1" }] }]));
  assert.equal(res.error, null, res.error?.stack);
  assert.equal(res.r.ok, true, JSON.stringify(res.r.failures));
  assert.deepEqual(tp.calls.slice(0, 2), ["status", "abort"]);
  assert.ok(tp.calls.indexOf("abort") < tp.calls.indexOf("teleport @telepoi A"));
  assert.deepEqual(tp.teleports, [{ cmd: "@telepoi A", takeRunning: false }]);
  assert.ok(res.warns.some((w) => /a take was still running on the page before site A: aborted it/.test(w)), res.warns.join("\n"));
  assert.equal((await leftover).code, "FILM_ABORTED");
  // settlePage on an idle page: one status read, no abort
  const idle = makeTakePage();
  const s = await settlePage(idle.page, { now: () => 0, sleep: async () => {} });
  assert.deepEqual([s.ok, s.aborted, s.polls, idle.calls], [true, false, 1, ["status"]]);
});

await check("S10f (jev-3, jev-4/tooling-5) the REAL broker: rehearsals always get the stepped limits, takes their mode's; <shot>.jev.jsonl holds only that shot's calls", async () => {
  const decided = [];
  const client = {
    async decide(req) {
      decided.push({ tag: req.state.tag, timeoutMs: req.timeoutMs, maxRetries: req.maxRetries });
      return { answers: { maneuver: { type: "choice", choice: "hold_path", confidence: 0.9 } }, usage: { costUsd: 0.000004 }, id: `gen-${req.state.tag}`, model: "typesafe/jev-1.13" };
    },
  };
  const broker = createJevBroker({ client, maxInFlight: 4 });
  broker.setDecideOptions(DECIDE_OPTIONS.stepped); // what installBroker leaves
  const ask = async (tag) => {
    const out = JSON.parse(await broker.handler(JSON.stringify({ state: { tag }, questions: { maneuver: choiceQ("Pick a maneuver.", { hold_path: "keep flying the path", rise: "climb" }) }, seq: tag })));
    assert.equal(out.answers?.maneuver?.choice, "hold_path", JSON.stringify(out));
  };
  const tp = makeTakePage({ onRehearse: (id) => ask(`${id}:rehearse`), onShoot: (id) => ask(`${id}:shoot`) });
  const tl = shootTimeline([{ id: "A", shots: [
    { id: "s1", mode: "realtime" },
    { id: "s2", family: "fpv", technique: "fpv.fpv-corridor" },
    { id: "s3", mode: "realtime" },
    { id: "s4", mode: "realtime", family: "drone", technique: "drone.chase" },
  ] }]);
  const res = await runSchedule(tp, tl, { broker });
  assert.equal(res.error, null, res.error?.stack);
  assert.equal(res.r.ok, true, JSON.stringify(res.r.failures));
  const RT = { timeoutMs: 1200, maxRetries: 0 };
  const ST = { timeoutMs: 4000, maxRetries: 2 };
  assert.deepEqual(DECIDE_OPTIONS.realtime, RT);
  assert.deepEqual(DECIDE_OPTIONS.stepped, ST);
  assert.deepEqual(decided, [
    { tag: "s1:shoot", ...RT },
    { tag: "s2:rehearse", ...ST }, // after a realtime take: still the stepped limits (jev-4)
    { tag: "s2:shoot", ...ST },
    { tag: "s3:shoot", ...RT },
    { tag: "s4:rehearse", ...ST }, // a realtime, auto-rehearsed drone.chase: stepped rehearsal …
    { tag: "s4:shoot", ...RT }, // … realtime take
  ]);
  // jev-3: each shot's telemetry file holds only that shot's broker entries (its rehearsal + its takes)
  const seqs = (id) => readJsonl(path.join(res.paths.reports, `${id}.jev.jsonl`)).map((e) => e.seq);
  assert.deepEqual(seqs("s1"), ["s1:shoot"]);
  assert.deepEqual(seqs("s2"), ["s2:rehearse", "s2:shoot"]);
  assert.deepEqual(seqs("s3"), ["s3:shoot"]);
  assert.deepEqual(seqs("s4"), ["s4:rehearse", "s4:shoot"]);
  assert.equal(broker.telemetry().length, 6, "the broker ring itself keeps everything");
});

await check("S10g (tooling-6) a failing retake keeps the recorded attempt: report written, keptAttempt 0, failedAttempts, take untouched, exit-0 shape", async () => {
  // attempt 0 is a confirm-keep (→ retake); the retake's ffmpeg mux fails
  let tp = makeTakePage();
  const verdicts = [{ keep: true, band: "confirm", pKeep: 0.7, source: "code", reasons: ["borderline visibility"] }];
  let res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "s1" }] }]), {
    retakes: 1,
    spawn: fakeMuxSpawn({ failOn: [2] }),
    keepOrRetake: async () => verdicts.shift() ?? { keep: true, band: "act", source: "code", reasons: [] },
  });
  assert.equal(res.error, null, res.error?.stack);
  let { r } = res;
  assert.deepEqual([r.ok, r.failures.length, r.shots.length, r.shots[0].kept, r.shots[0].attempts], [true, 0, 1, true, 1]);
  assert.deepEqual(r.shots[0].failedAttempts.map((f) => [f.attempt, f.code]), [[1, "FFMPEG_FAILED"]]);
  const takes = res.paths.takes;
  let rep = JSON.parse(fs.readFileSync(path.join(res.paths.reports, "s1.json"), "utf8"));
  assert.deepEqual([rep.keptAttempt, rep.file, rep.verdict.band], [0, path.join(takes, "s1.mp4"), "confirm"]);
  assert.deepEqual(rep.attempts.map((a) => a.attempt), [0]);
  assert.deepEqual(rep.failedAttempts.map((f) => [f.attempt, f.code]), [[1, "FFMPEG_FAILED"]]);
  assert.match(rep.failedAttempts[0].message, /ffmpeg mux s1\.retake1 failed \(exit 1\)/);
  assert.equal(fs.readFileSync(path.join(takes, "s1.mp4"), "utf8"), `MUX ${path.join(takes, "s1.h264")}\n`);
  assert.equal(fs.existsSync(path.join(takes, "s1.retake0.mp4")), false, "keepRetake never ran");
  assert.ok(fs.existsSync(path.join(takes, "s1.retake1.h264")), "the failed retake's raw file stays");
  const rows = res.shootLog();
  assert.deepEqual(rows.map((x) => [x.attempt, x.ok === false ? "failed" : x.keep]), [[0, true], [1, "failed"]]);
  assert.ok(res.warns.some((w) => /retake 1 of s1 failed \(ffmpeg mux s1\.retake1 failed[\s\S]*\); keeping the 1 attempt\(s\) already recorded/.test(w)), res.warns.join("\n"));

  // the retake fails IN THE PAGE (its drain): abort + idle, the first attempt kept, the next shot still shot
  tp = makeTakePage({ hang: (id, nth) => id === "s1" && nth === 1, drainFails: (id, nth, d) => id === "s1" && nth === 1 && d === 2 });
  const v2 = [{ keep: true, band: "confirm", source: "code", reasons: [] }];
  res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "s1" }, { id: "s2" }] }]), {
    retakes: 2,
    keepOrRetake: async () => v2.shift() ?? { keep: true, band: "act", source: "code", reasons: [] },
  });
  assert.equal(res.error, null, res.error?.stack);
  r = res.r;
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.shots.map((s) => [s.shotId, s.kept, s.attempts, s.failedAttempts?.map((f) => f.attempt) ?? []]), [["s1", true, 1, [1]], ["s2", true, 1, []]]);
  assertAbortsBounded(tp);
  assertAbortedBeforeNext(tp, "prepare s2");
  assert.equal(tp.calls.filter((c) => c === "shoot s1").length, 2, "no third attempt after a failed retake");
  rep = JSON.parse(fs.readFileSync(path.join(res.paths.reports, "s1.json"), "utf8"));
  assert.deepEqual([rep.keptAttempt, rep.failedAttempts[0].attempt], [0, 1]);

  // a confirm-NOT-keep first attempt whose retake fails: the shot has no kept take → a verdict failure naming the retake
  tp = makeTakePage();
  res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "s1" }] }]), {
    retakes: 1,
    spawn: fakeMuxSpawn({ failOn: [2] }),
    keepOrRetake: async () => ({ keep: false, band: "act", source: "code", reasons: ["safety_adjustments is 'many'"] }),
  });
  assert.equal(res.error, null, res.error?.stack);
  assert.deepEqual(failStages(res.r), [["s1", "verdict"]]);
  assert.match(res.r.failures[0].message, /no attempt kept: safety_adjustments is 'many' \(retake 1 failed: ffmpeg mux s1\.retake1 failed/);
  assert.ok(fs.existsSync(path.join(res.paths.reports, "s1.json")));
});

// A page in index.js's take-start window: busy='shoot' while take_player has no run yet (ready() + clean frame).
// Like take_player.abort(), an abort stops only an existing run (`wasRunning:false` otherwise: lost). The run starts
// during status poll `startOnPoll`; an aborted run stops by the next poll. `ignoreAll`: no abort ever lands.
function windowPage({ startOnPoll = 1, ignoreAll = false } = {}) {
  const st = { calls: [], busy: "shoot", run: null, polls: 0, landed: 0, wasRunning: [] };
  const film = {
    status() {
      st.calls.push("status");
      st.polls++;
      if (st.run?.abort) {
        st.run = null;
        st.busy = null;
      } else if (st.busy && !st.run && st.polls >= startOnPoll) {
        st.run = { abort: false };
      }
      return { ok: true, active: st.busy !== null || st.run !== null, busy: st.busy, take: { running: st.run ? { frames: 1 } : null } };
    },
    abort() {
      st.calls.push("abort");
      const was = Boolean(st.run);
      if (st.run && !ignoreAll) {
        st.run.abort = true;
        st.landed++;
      }
      st.wasRunning.push(was);
      return { ok: true, wasRunning: was };
    },
  };
  st.page = {
    async evaluate(fn, arg) {
      globalThis.window = { __film: film };
      return fn(arg === undefined ? undefined : structuredClone(arg));
    },
  };
  return st;
}

await check("S10h (check:cli-shoot) settlePage re-sends __film.abort() while the page stays busy: an abort lost in the take-start window is repeated; bounded by count and time", async () => {
  let clock = 0;
  const timing = { now: () => clock, sleep: async (ms) => { clock += ms; } };
  // after a failed take (abortFirst): the first abort lands before the run exists and is lost; the poll re-aborts
  let wp = windowPage({ startOnPoll: 1 });
  let s = await settlePage(wp.page, { abortFirst: true, ...timing });
  assert.deepEqual([s.ok, s.aborted, s.aborts, s.polls, wp.wasRunning, wp.landed], [true, true, 2, 2, [false, true], 1]);
  assert.deepEqual(wp.calls, ["abort", "status", "abort", "status"]);
  // before a teleport: busy='shoot' with no run on the first poll (abort lost), the run starts, the next poll re-aborts
  clock = 0;
  wp = windowPage({ startOnPoll: 2 });
  s = await settlePage(wp.page, timing);
  assert.deepEqual([s.ok, s.aborts, s.polls, wp.wasRunning], [true, 2, 3, [false, true]]);
  assert.deepEqual(wp.calls, ["status", "abort", "status", "abort", "status"]);
  // bounded by count: a page that never stops gets maxAborts aborts, then the wait times out (never idle → ok:false)
  clock = 0;
  wp = windowPage({ ignoreAll: true });
  s = await settlePage(wp.page, { ...timing, timeoutMs: 10_000, pollMs: 1000, maxAborts: 4 });
  assert.deepEqual([s.ok, s.aborts, s.polls, s.busy, s.running], [false, 4, 11, "shoot", true]);
  clock = 0;
  wp = windowPage({ ignoreAll: true });
  s = await settlePage(wp.page, timing);
  assert.deepEqual([s.ok, s.aborts, s.polls, s.waitedMs], [false, PAGE_ABORT_MAX, PAGE_IDLE_WAIT_MS / 1000 + 1, PAGE_IDLE_WAIT_MS]);
  // bounded by time: no abort once timeoutMs has passed (polls at 0, 1, 2, 3 s → aborts at 0, 1, 2 s only)
  clock = 0;
  wp = windowPage({ ignoreAll: true });
  s = await settlePage(wp.page, { ...timing, timeoutMs: 3000, pollMs: 1000, maxAborts: 100 });
  assert.deepEqual([s.ok, s.aborts, s.polls], [false, 3, 4]);

  // shootSchedule end to end: a leftover take is still in its start window when the CLI arrives; the first abort
  // is lost, the take player then starts recording — the re-sent abort stops it BEFORE the teleport
  let release = null;
  const tp = makeTakePage({
    hang: (id) => id === "leftover",
    beforeRun: (id) => (id === "leftover" ? new Promise((r) => { release = r; }) : undefined),
    onAbort: (was) => {
      if (!was && release) release(); // ready() finished just after the lost abort
    },
  });
  try {
    tp.film.prepare({ shotId: "leftover", spec: { duration: 0.2 } });
    const leftover = tp.film.shoot({ fps: 10 });
    const st0 = tp.film.status();
    assert.deepEqual([st0.active, st0.busy, st0.take.running], [true, "shoot", null], "busy='shoot' with no run yet");
    tp.calls.length = 0;
    const res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "a1" }] }]));
    assert.equal(res.error, null, res.error?.stack);
    assert.equal(res.r.ok, true, JSON.stringify(res.r.failures));
    assert.deepEqual(tp.calls.slice(0, 5), ["status", "abort", "status", "abort", "status"]);
    assert.equal(tp.aborts, 2);
    assert.deepEqual(tp.teleports, [{ cmd: "@telepoi A", takeRunning: false }]);
    assert.equal((await leftover).code, "FILM_ABORTED");
    assert.ok(res.warns.some((w) => /a take was still running on the page before site A: aborted it/.test(w)), res.warns.join("\n"));
  } finally {
    tp.endAll();
  }
});

await check("S10i (r2-cli, math-2) page issues through shootSchedule: one warning per issue per shot; reports/<shot>.json, shoot-log, rehearsal file, failure rows and the keepOrRetake input carry them; absent/malformed blocks are harmless; never a failure or a retake", async () => {
  const tp = makeTakePage({
    hang: (id) => id === "d3",
    drainFails: (id, nth, d) => id === "d3" && d === 2,
    prepareExtra: (take) => {
      if (take.shotId === "d1") return { fromTable: false, validation: overspeedValidation(), flight: { ...OVERSPEED_FLIGHT } };
      if (take.shotId === "d2") {
        return { validation: { ok: false, error: "trajectory sample threw" }, warnings: ['intent.light "golden" was ignored: no usable sun (night)', null, { message: "odd" }], issues: "not-an-array", flight: { preset: "cinema", vmax: 12, overspeed: false } };
      }
      if (take.shotId === "d3") return { flight: { ...OVERSPEED_FLIGHT, peakSpeed: null } };
      return {}; // c1: none of the blocks
    },
    rehearseExtra: (id) => (id === "d1" ? { validation: overspeedValidation(), flight: { ...OVERSPEED_FLIGHT } } : {}),
    shootExtra: (id) => (id === "d1" ? { flight: { ...OVERSPEED_FLIGHT } } : id === "d2" ? { validation: null, flight: "garbage", warnings: 5 } : {}),
  });
  const inputs = [];
  const tl = shootTimeline([{ id: "A", shots: [
    { id: "d1", family: "drone", technique: "drone.flythrough" }, // auto-rehearsed
    { id: "c1" },
    { id: "d2", family: "drone", technique: "drone.orbit" },
    { id: "d3", family: "drone", technique: "drone.orbit" },
  ] }]);
  const res = await runSchedule(tp, tl, {
    retakes: 1,
    keepOrRetake: async (jev, input) => {
      inputs.push(structuredClone(input));
      // d1's first attempt is a confirm-keep → one retake; everything else keeps
      return inputs.length === 1 ? { keep: true, band: "confirm", source: "code", reasons: [] } : { keep: true, band: "act", source: "code", reasons: [] };
    },
  });
  assert.equal(res.error, null, res.error?.stack);
  const { r } = res;
  // issues never fail a take: only d3's drain failure does
  assert.deepEqual(failStages(r), [["d3", "take"]]);
  assert.deepEqual(r.shots.map((x) => [x.shotId, x.kept, x.attempts, x.issues.map((i) => i.code)]), [["d1", true, 2, ["overspeed"]], ["c1", true, 1, []], ["d2", true, 1, ["validation-error", "warning", "warning"]]]);
  // one warning line per issue per shot — d1 was prepared 3× (attempt 0 twice around its rehearsal, the retake once),
  // rehearsed and shot twice, yet warns once
  const issueWarns = (id) => res.warns.filter((w) => w.startsWith(`shot ${id}: `) && / issue /.test(w));
  assert.deepEqual(issueWarns("d1"), [`shot d1: prepare issue overspeed: ${OVERSPEED_MSG}`]);
  assert.deepEqual(issueWarns("c1"), []);
  assert.deepEqual(issueWarns("d2"), [
    "shot d2: prepare issue validation-error: the page could not validate the take: trajectory sample threw",
    'shot d2: prepare issue warning: intent.light "golden" was ignored: no usable sun (night)',
    "shot d2: prepare issue warning: odd",
  ]);
  assert.equal(issueWarns("d3").length, 1);
  assert.match(issueWarns("d3")[0], /^shot d3: prepare issue overspeed: the move is faster than the flight caps over 120 m, but the 'cinema' drone flies ≤ 12 m\/s: .*use duration ≥ 11\.9 s$/);
  // reports/<shot>.json
  const rep = (id) => JSON.parse(fs.readFileSync(path.join(res.paths.reports, `${id}.json`), "utf8"));
  const d1 = rep("d1");
  assert.equal(d1.keptAttempt, 1);
  assert.deepEqual(d1.issues, [{ code: "overspeed", message: OVERSPEED_MSG, t: null, stages: ["prepare", "rehearse", "shoot"], preset: "cinema", vmax: 12, peakSpeed: 17.8, lengthM: 120, minDurationSec: 11.9 }]);
  assert.deepEqual([d1.flight, d1.validation], [OVERSPEED_FLIGHT, { ok: false, counts: { overspeed: 1 } }]);
  assert.deepEqual([rep("c1").issues, rep("c1").flight, rep("c1").validation], [[], null, null]);
  const d2 = rep("d2");
  assert.deepEqual([d2.validation, d2.flight], [{ ok: false, counts: null, error: "trajectory sample threw" }, { preset: "cinema", vmax: 12, overspeed: false }]);
  // the rehearsal file (prepare + rehearse issues)
  const reh = JSON.parse(fs.readFileSync(path.join(res.paths.reports, "d1.rehearsal.json"), "utf8"));
  assert.deepEqual(reh.issues.map((i) => [i.code, i.stages, i.minDurationSec]), [["overspeed", ["prepare", "rehearse"], 11.9]]);
  // shoot-log: every attempt row has `issues`; the failed d3 row has the issue seen before the failure
  const rows = res.shootLog();
  assert.deepEqual(rows.filter((x) => x.shotId).map((x) => [x.shotId, x.attempt ?? null, x.ok === false ? "failed" : "ok", x.issues.map((i) => i.code)]), [
    ["d1", 0, "ok", ["overspeed"]], ["d1", 1, "ok", ["overspeed"]], ["c1", 0, "ok", []], ["d2", 0, "ok", ["validation-error", "warning", "warning"]], ["d3", null, "failed", ["overspeed"]],
  ]);
  assert.equal(rows.find((x) => x.shotId === "d3").issues[0].minDurationSec, 11.9);
  assert.deepEqual(r.failures[0].issues.map((i) => [i.code, i.minDurationSec]), [["overspeed", 11.9]]);
  // the keepOrRetake input (judgeInput): d1 ×2 with issues + flight; c1 has neither key; the verdict words are the same
  assert.equal(inputs.length, 4);
  assert.deepEqual([inputs[0].issues[0].code, inputs[0].issues[0].minDurationSec, inputs[0].flight.overspeed, inputs[1].issues.length], ["overspeed", 11.9, true, 1]);
  assert.deepEqual(["issues" in inputs[2], "flight" in inputs[2]], [false, false]);
  assert.deepEqual(inputs[3].issues.map((i) => i.code), ["validation-error", "warning", "warning"]);
  assert.deepEqual([inputs[0].frames, inputs[0].droppedFrames, inputs[0].safetyAdjustedFrames], [5, 0, 0]);
});

await check("S10j (r3-small) tracking-gap + durationHelps: threshold edges, the overspeed fallback text, issueLine, merge; through shootSchedule the rehearsal's and the take's gaps each warn once and reach the reports and the keepOrRetake input", async () => {
  const fl = (tracking, extra = {}) => ({ flight: { preset: "heavy", vmax: 7, overspeed: false, tracking, ...extra } });
  const gapOf = (r, stage = "rehearse") => pageIssuesOf(r, stage).filter((i) => i.code === "tracking-gap");
  // at or below the threshold, absent, null (a locked replay) or malformed → no issue
  for (const tr of [{ frames: 9, maxGapM: FLIGHT_GAP_WARN_M, maxGapT: 1, endGapM: 0.4 }, { frames: 9, maxGapM: 0.3, maxGapT: 1, endGapM: 0.1 }, null, undefined, "x", { maxGapM: NaN, endGapM: null }, { maxGapM: "40" }]) {
    assert.deepEqual(gapOf(fl(tr)), [], JSON.stringify(tr));
  }
  // just above: one issue at maxGapT with both distances; the end gap alone (max missing) still counts
  let g = gapOf(fl({ frames: 9, maxGapM: 2.01, maxGapT: 1.25, endGapM: 1.5 }));
  assert.deepEqual([g.length, g[0].t, g[0].maxGapM, g[0].endGapM, g[0].preset, g[0].stages], [1, 1.25, 2.01, 1.5, "heavy", ["rehearse"]]);
  assert.match(g[0].message, /^the flown camera trailed its planned path by up to 2\.0 m and ended 1\.5 m from it \(warned above 2 m\): .*the 'heavy' drone.* \(or pilot\.flightPreset 'fpv'\)$/);
  assert.equal(issueLine("x1", g[0]), `shot x1: rehearse issue tracking-gap at t=1.25 s: ${g[0].message}`);
  g = gapOf(fl({ frames: 9, maxGapM: null, maxGapT: null, endGapM: 5 }));
  assert.deepEqual([g.length, g[0].t, "maxGapM" in g[0], g[0].endGapM], [1, null, false, 5]);
  // nested under a holder; the fpv preset suggests no preset change; durationHelps false → "will not help"
  g = gapOf({ prepared: fl({ frames: 9, maxGapM: 9, maxGapT: 2, endGapM: 9 }, { preset: "fpv" }) }, "shoot");
  assert.equal(/flightPreset/.test(g[0].message), false, g[0].message);
  g = gapOf(fl({ frames: 9, maxGapM: 9, maxGapT: 2, endGapM: 9 }, { durationHelps: false }));
  assert.match(g[0].message, /; a longer duration will not help: lower params\.speed/);
  // the overspeed fallback (a flight block with no validation issue) honours durationHelps
  const os = pageIssuesOf({ flight: { preset: "cinema", vmax: 12, peakSpeed: 30, lengthM: 240, overspeed: true, minDurationSec: null, durationHelps: false } }, "shoot");
  assert.equal(os.length, 1);
  assert.equal(os[0].durationHelps, false);
  assert.match(os[0].message, /ends short of it; a longer duration will not help \(the move's speed comes from its params, its ease or the subject it follows\): lower params\.speed, use ease 'linear' or give a shorter path$/);
  assert.equal(/use a longer duration/.test(os[0].message), false, os[0].message);
  assert.equal(issueLine("x2", os[0]).endsWith("give a shorter path"), true, "no second 'will not help' when the message says it");
  const osYes = pageIssuesOf({ flight: { preset: "cinema", vmax: 12, overspeed: true, minDurationSec: null, durationHelps: true } }, "shoot")[0];
  assert.deepEqual([osYes.durationHelps, /use a longer duration or a shorter, straighter path$/.test(osYes.message)], [true, true]);
  // a page validation issue keeps durationHelps (ISSUE_FIELDS); issueLine adds the hint when its message lacks it
  const pv = pageIssuesOf({ validation: { ok: false, issues: [{ code: "overspeed", t: null, message: "too fast", preset: "cinema", minDurationSec: null, durationHelps: false }] } }, "prepare");
  assert.deepEqual([pv[0].durationHelps, pv[0].minDurationSec], [false, undefined]);
  assert.equal(issueLine("x3", pv[0]), "shot x3: prepare issue overspeed: too fast (a longer duration will not help)");
  const merged = mergeIssues([{ code: "overspeed", message: "m", t: null, stages: ["prepare"], preset: "cinema" }], pv);
  assert.deepEqual([merged.length, merged[0].durationHelps, merged[0].stages], [1, false, ["prepare"]]);

  // end to end: an auto-rehearsed drone shot whose rehearsal trailed 30.9 m and whose take trailed 12.3 m, and a
  // second drone shot that kept within the threshold
  const tp = makeTakePage({
    rehearseExtra: (id) => (id === "g1" ? fl({ frames: 4, maxGapM: 30.94, maxGapT: 0.4, endGapM: 29.38 }) : fl({ frames: 4, maxGapM: 0.5, maxGapT: 0.1, endGapM: 0.1 })),
    shootExtra: (id) => (id === "g1" ? fl({ frames: 5, maxGapM: 12.25, maxGapT: 0.3, endGapM: 12.25 }) : fl({ frames: 5, maxGapM: 1.99, maxGapT: 0.2, endGapM: 0.2 })),
  });
  const inputs = [];
  const res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "g1", family: "drone", technique: "drone.chase" }, { id: "g2", family: "drone", technique: "drone.chase" }] }]), {
    keepOrRetake: async (jev, input) => {
      inputs.push(structuredClone(input));
      return { keep: true, band: "act", source: "code", reasons: [] };
    },
  });
  assert.equal(res.error, null, res.error?.stack);
  assert.deepEqual(failStages(res.r), []);
  const gapWarns = (id) => res.warns.filter((w) => w.startsWith(`shot ${id}: `) && / issue tracking-gap/.test(w));
  assert.deepEqual(gapWarns("g1").map((w) => w.replace(/: the flown camera trailed its planned path by up to ([\d.]+) m and ended ([\d.]+) m from it .*$/, " $1/$2")), [
    "shot g1: rehearse issue tracking-gap at t=0.4 s 30.9/29.4",
    "shot g1: shoot issue tracking-gap at t=0.3 s 12.3/12.3",
  ]);
  assert.deepEqual(gapWarns("g2"), []);
  const rep = (id) => JSON.parse(fs.readFileSync(path.join(res.paths.reports, `${id}.json`), "utf8"));
  assert.deepEqual(rep("g1").issues.map((i) => [i.code, i.stages, i.maxGapM, i.endGapM, i.t]), [["tracking-gap", ["rehearse"], 30.94, 29.38, 0.4], ["tracking-gap", ["shoot"], 12.25, 12.25, 0.3]]);
  assert.deepEqual(rep("g2").issues, []);
  const reh = JSON.parse(fs.readFileSync(path.join(res.paths.reports, "g1.rehearsal.json"), "utf8"));
  assert.deepEqual(reh.issues.map((i) => [i.code, i.stages, i.maxGapM]), [["tracking-gap", ["rehearse"], 30.94]]);
  assert.deepEqual(res.shootLog().filter((x) => x.shotId).map((x) => [x.shotId, x.issues.map((i) => `${i.code}@${i.stages.join("/")}`)]), [["g1", ["tracking-gap@rehearse", "tracking-gap@shoot"]], ["g2", []]]);
  // the keepOrRetake input carries both gaps (judgeInput merges the take report's page gap into the same issue)
  assert.deepEqual(inputs[0].issues.map((i) => [i.code, i.stages, i.maxGapM]), [["tracking-gap", ["rehearse"], 30.94], ["tracking-gap", ["shoot"], 12.25]]);
  assert.equal("issues" in inputs[1], false);
});

// The REAL take player's prepare() (scene3d/film/runtime/take_player.js; the shot builders and the drone flight
// model it imports), JSON round-tripped the way CDP returns a page result.
const K_SUBJECT = Object.freeze({ pos: [30016, 32128, 50], height: 1.8, radius: 0.5, heading: 0.4 });
const K_CTX = Object.freeze({ subject: K_SUBJECT, aspect: 16 / 9 });
function realPrepare(take) {
  const live = { frameTime: { tsMs: 1000 } };
  const hooks = ensureFilmHooks(live);
  let last = null;
  const player = createTakePlayer({
    cameraOwner: { owned: true, write(p) { last = p; return true; }, currentPose: () => last, setCutCell: () => 0, viewerCell: () => 0, onPostRender: (fn) => hooks.addPostRender(fn) },
    clock: { begin: () => ({ ok: true }), step: async () => ({}), end: async () => ({ ok: true }), active: false, stats: () => ({}) },
    safety: { clamp: (p, d) => ({ pose: d, adjusted: false, hits: [] }), reset() {}, release: () => 0 },
    worldQuery: { groundZ: () => 50 },
    liveScene3d: live,
    window: {},
    pilot: () => null,
  });
  return JSON.parse(JSON.stringify(player.prepare(take)));
}

await check("S10k (r4-nits) the REAL page's overspeed (take_player prepare: acceleration / speed, verified / estimate) keeps limitedBy, minDurationVerified and the dry-flown maxGapM through pageIssuesOf, mergeIssues, judgeInput and shootSchedule; the flight-block fallback words verified vs estimate like the page; a live carry rig's tracking-gap names the subject's turn", async () => {
  // (a) the real prepare summaries: a boom-rise within vmax that the craft cannot follow (acceleration), a boomerang
  // above vmax (speed) — both searched and dry-flown at their minimum duration — and the same boom-rise handed over as
  // a prebuilt trajectory (no ShotSpec to rebuild: the duration stays an estimate)
  const accel = realPrepare({ shotId: "k1", spec: { technique: "drone.boom-rise", duration: 4 }, ctx: K_CTX, capture: { fps: 30 } });
  const speedy = realPrepare({ shotId: "k2", spec: { technique: "drone.boomerang", duration: 5 }, ctx: K_CTX, capture: { fps: 30 } });
  const noSpec = realPrepare({ shotId: "k3", trajectory: buildShot({ technique: "drone.boom-rise", duration: 4 }, { ...K_CTX, groundZ: () => 50 }), family: "drone", technique: "drone.boom-rise", capture: { fps: 30 } });
  const checkOf = (s) => [s.flight.limitedBy, s.flight.minDurationCheck, s.flight.minDurationVerified];
  assert.deepEqual([checkOf(accel), checkOf(speedy), checkOf(noSpec)], [["acceleration", "verified", true], ["speed", "verified", true], ["acceleration", "unverified", null]]);
  for (const [name, sum] of [["acceleration", accel], ["speed", speedy], ["no spec", noSpec]]) {
    const fl = sum.flight;
    const page = sum.validation.issues.find((i) => i.code === "overspeed");
    assert.ok(fl.dryFlight.maxGapM > 1 && Number.isFinite(fl.minDurationSec), `${name}: the dry flight failed (${fl.dryFlight.maxGapM} m) and a duration is named`);
    const issues = pageIssuesOf(sum, "prepare").filter((i) => i.code === "overspeed");
    assert.equal(issues.length, 1, name);
    const [i] = issues;
    assert.deepEqual([i.message, i.preset, i.limitedBy, i.minDurationSec, i.minDurationVerified, i.maxGapM, i.durationHelps],
      [page.message, fl.preset, fl.limitedBy, fl.minDurationSec, fl.minDurationVerified, fl.dryFlight.maxGapM, true], name);
    // the fallback from the flight block alone (a take report without the validation issue), worded like the page
    const fb = pageIssuesOf({ ok: true, flight: fl }, "shoot");
    assert.equal(fb.length, 1, name);
    assert.deepEqual([fb[0].preset, fb[0].vmax, fb[0].limitedBy, fb[0].minDurationSec, fb[0].minDurationVerified, fb[0].maxGapM],
      [fl.preset, fl.vmax, fl.limitedBy, fl.minDurationSec, fl.minDurationVerified, fl.dryFlight.maxGapM], name);
    const fix = `use duration ≥ ${fl.minDurationSec} s${fl.minDurationVerified === true ? " (dry-flown within 1 m there)" : " (an estimate: not dry-flown within the check's budget)"}`;
    assert.ok(page.message.includes(fix), `${name}: page: ${page.message}`);
    assert.ok(fb[0].message.endsWith(fix), `${name}: fallback: ${fb[0].message}`);
    assert.ok(fb[0].message.includes(`dry-flown, the craft trails the planned path by up to ${fl.dryFlight.maxGapM.toFixed(1)} m`), fb[0].message);
    if (fl.limitedBy === "acceleration") {
      assert.match(fb[0].message, /^the move peaks at [\d.]+ m\/s, within the 'cinema' drone's 12 m\/s, but turns or changes speed harder than it can follow \(≤ 4 m\/s²; the path asks for up to [\d.]+ m\/s²\): dry-flown, .* \(tolerance 1 m\); use duration/, name);
      assert.equal(/flies ≤/.test(fb[0].message), false, `${name}: an acceleration-limited move is within vmax`);
    } else {
      assert.match(fb[0].message, /^the move peaks at [\d.]+ m\/s, but the 'cinema' drone flies ≤ 12 m\/s: the flown camera falls behind the planned path and ends short of it \(dry-flown, /, name);
    }
    // merged with the page's issue (first): one issue, the page's message, the fields kept, both stages
    const merged = mergeIssues(pageIssuesOf(sum, "prepare").filter((x) => x.code === "overspeed"), fb);
    assert.deepEqual([merged.length, merged[0].message, merged[0].stages, merged[0].limitedBy, merged[0].minDurationVerified], [1, page.message, ["prepare", "shoot"], fl.limitedBy, fl.minDurationVerified], name);
    // the keepOrRetake input keeps them; issueLine prints the page's message as is (it names the duration)
    const inp = judgeInput({ frames: 5, expectedFrames: 5, issues, page: { flight: fl } });
    assert.deepEqual([inp.issues.length, inp.issues[0].limitedBy, inp.issues[0].minDurationVerified, inp.issues[0].maxGapM, inp.issues[0].stages],
      [1, fl.limitedBy, fl.minDurationVerified, fl.dryFlight.maxGapM, ["prepare", "shoot"]], name);
    assert.equal(issueLine("k", i), `shot k: prepare issue overspeed: ${page.message}`);
  }

  // (b) the fallback's edges: minDurationCheck alone says verified / estimate; an older or malformed block says neither
  const fbOf = (f) => pageIssuesOf({ flight: { preset: "heavy", vmax: 7, overspeed: true, ...f } }, "shoot")[0];
  let o = fbOf({ amax: 2.5, peakSpeed: 6.2, limitedBy: "acceleration", minDurationSec: 8.4, minDurationCheck: "verified", gapToleranceM: 1, dryFlight: { maxGapM: 3.24, peakAccel: 5.04 } });
  assert.equal(o.message, "the move peaks at 6.2 m/s, within the 'heavy' drone's 7 m/s, but turns or changes speed harder than it can follow (≤ 2.5 m/s²; the path asks for up to 5.0 m/s²): dry-flown, the craft trails the planned path by up to 3.2 m (tolerance 1 m); use duration ≥ 8.4 s (dry-flown within 1 m there)");
  assert.deepEqual([o.limitedBy, o.maxGapM, o.minDurationSec, "minDurationVerified" in o], ["acceleration", 3.24, 8.4, false]);
  o = fbOf({ vmax: undefined, limitedBy: "acceleration", minDurationSec: 9, minDurationCheck: "unverified" });
  assert.equal(o.message, "the move stays within the 'heavy' drone's top speed but turns or changes speed harder than it can follow: the flown camera falls behind the planned path; use duration ≥ 9 s (an estimate: not dry-flown within the check's budget)");
  o = fbOf({ peakSpeed: 9, limitedBy: "speed", minDurationSec: 13, minDurationVerified: true });
  assert.match(o.message, /^the move peaks at 9\.0 m\/s, but the 'heavy' drone flies ≤ 7 m\/s: .* ends short of it; use duration ≥ 13 s \(dry-flown within the check's tolerance there\)$/);
  assert.deepEqual([o.limitedBy, o.minDurationVerified], ["speed", true]);
  o = fbOf({ peakSpeed: 9, limitedBy: "speed", minDurationSec: null, minDurationVerified: false, minDurationCheck: "failed", durationHelps: false });
  assert.match(o.message, /; a longer duration will not help \(.*\): lower params\.speed, use ease 'linear' or give a shorter path$/);
  assert.deepEqual([o.minDurationVerified, o.durationHelps, "minDurationSec" in o], [false, false, false]);
  for (const f of [{ peakSpeed: 9, minDurationSec: 13 }, { peakSpeed: 9, minDurationSec: 13, minDurationVerified: "yes", limitedBy: "", dryFlight: { maxGapM: "far" } }]) {
    o = fbOf(f);
    assert.match(o.message, /ends short of it; use duration ≥ 13 s$/, JSON.stringify(f));
    assert.deepEqual(["minDurationVerified" in o, "limitedBy" in o, "maxGapM" in o], [false, false, false], JSON.stringify(f));
  }

  // (c) a page issue's explicit null minDurationVerified is kept (not verified); other nulls are dropped; a merge fills a
  // missing field but never overwrites the null
  const pv = pageIssuesOf({ validation: { ok: false, issues: [{ code: "overspeed", t: null, message: "too fast", preset: "cinema", limitedBy: null, minDurationSec: null, minDurationVerified: null, durationHelps: true }] } }, "prepare")[0];
  assert.deepEqual([pv.minDurationVerified, "limitedBy" in pv, "minDurationSec" in pv, pv.durationHelps], [null, false, false, true]);
  assert.equal("minDurationVerified" in pageIssuesOf({ validation: { ok: false, issues: [{ code: "speed", message: "x" }] } }, "prepare")[0], false);
  let m = mergeIssues([{ code: "overspeed", message: "m", t: null, stages: ["prepare"], preset: "cinema" }], [{ code: "overspeed", message: "f", t: null, stages: ["shoot"], preset: "cinema", limitedBy: "speed", minDurationVerified: true }]);
  assert.deepEqual([m.length, m[0].message, m[0].limitedBy, m[0].minDurationVerified, m[0].stages], [1, "m", "speed", true, ["prepare", "shoot"]]);
  m = mergeIssues([{ ...pv, stages: ["prepare"] }], [{ code: "overspeed", message: "f", t: null, stages: ["shoot"], preset: "cinema", minDurationVerified: true }]);
  assert.equal(m[0].minDurationVerified, null);

  // (d) issueLine's own duration hint marks an estimate
  const base = { code: "speed", t: null, message: "fast", stages: ["prepare"], minDurationSec: 9 };
  assert.equal(issueLine("k4", { ...base, minDurationVerified: null }), "shot k4: prepare issue speed: fast (minimum feasible duration 9 s, an estimate)");
  assert.equal(issueLine("k4", { ...base, minDurationVerified: true }), "shot k4: prepare issue speed: fast (minimum feasible duration 9 s)");

  // (e) a flown carry rig that followed a live subject: the tracking-gap names the subject's turn as a cause
  const uturn = { preset: "cinema", vmax: 12, overspeed: false, tracking: { frames: 180, maxGapM: 2.28, maxGapT: 3.1, endGapM: 1.2 } };
  const liveGap = (liveSubject) => pageIssuesOf({ ok: true, liveSubject, flight: structuredClone(uturn) }, "shoot").find((x) => x.code === "tracking-gap");
  const carry = liveGap({ mode: "carry", rotate: true, frames: 180 });
  assert.match(carry.message, /^the flown camera trailed its planned path by up to 2\.3 m and ended 1\.2 m from it \(warned above 2 m\): .*\(or pilot\.flightPreset 'fpv'\); it followed a live subject, and a turn sharper than the craft can swing round \(a U-turn at 90°\/s\) leaves it behind too: reshoot with a gentler subject move \(a slower or wider turn\)$/);
  assert.deepEqual([carry.maxGapM, carry.t], [2.28, 3.1]);
  for (const ls of [{ mode: "aim" }, { mode: "off" }, null, undefined, "carry"]) {
    assert.ok(liveGap(ls).message.endsWith("(or pilot.flightPreset 'fpv')"), JSON.stringify(ls ?? null));
  }

  // (f) end to end through shootSchedule: k1 = the real acceleration-limited prepare (+ its take report's flight block,
  // tracked within the threshold); k3 = only the take report's block of the prebuilt-trajectory take (an estimate)
  // from a live carry run that trailed 2.28 m
  const tp = makeTakePage({
    prepareExtra: (take) => (take.shotId === "k1" ? { validation: structuredClone(accel.validation), flight: structuredClone(accel.flight) } : {}),
    shootExtra: (id) => (id === "k1"
      ? { flight: { ...structuredClone(accel.flight), tracking: { frames: 5, maxGapM: 0.4, maxGapT: 0.2, endGapM: 0.1 } } }
      : { liveSubject: { mode: "carry", rotate: true }, flight: { ...structuredClone(noSpec.flight), tracking: { frames: 5, maxGapM: 2.28, maxGapT: 0.3, endGapM: 1.2 } } }),
  });
  const inputs = [];
  const res = await runSchedule(tp, shootTimeline([{ id: "A", shots: [{ id: "k1", family: "drone", technique: "drone.boom-rise" }, { id: "k3", family: "drone", technique: "drone.boom-rise" }] }]), {
    keepOrRetake: async (jev, input) => {
      inputs.push(structuredClone(input));
      return { keep: true, band: "act", source: "code", reasons: [] };
    },
  });
  assert.equal(res.error, null, res.error?.stack);
  assert.deepEqual(failStages(res.r), []);
  const k1Page = accel.validation.issues.find((i) => i.code === "overspeed");
  assert.deepEqual(res.warns.filter((w) => w.startsWith("shot k1: ") && / issue overspeed/.test(w)), [`shot k1: prepare issue overspeed: ${k1Page.message}`]);
  const k3Warns = res.warns.filter((w) => w.startsWith("shot k3: ") && / issue /.test(w));
  assert.equal(k3Warns.length, 2, k3Warns.join("\n"));
  assert.match(k3Warns[0], /^shot k3: shoot issue overspeed: the move peaks at [\d.]+ m\/s, within the 'cinema' drone's 12 m\/s, but .*; use duration ≥ [\d.]+ s \(an estimate: not dry-flown within the check's budget\)$/);
  assert.match(k3Warns[1], /^shot k3: shoot issue tracking-gap at t=0\.3 s: .*reshoot with a gentler subject move \(a slower or wider turn\)$/);
  const rep = (id) => JSON.parse(fs.readFileSync(path.join(res.paths.reports, `${id}.json`), "utf8"));
  const pick = (i) => [i.code, i.stages, i.limitedBy ?? "-", "minDurationVerified" in i ? i.minDurationVerified : "-", i.maxGapM];
  assert.deepEqual(rep("k1").issues.filter((i) => i.code === "overspeed").map(pick), [["overspeed", ["prepare", "shoot"], "acceleration", true, accel.flight.dryFlight.maxGapM]]);
  assert.equal(rep("k1").issues.find((i) => i.code === "overspeed").minDurationSec, accel.flight.minDurationSec);
  assert.deepEqual(rep("k3").issues.map(pick), [["overspeed", ["shoot"], "acceleration", null, noSpec.flight.dryFlight.maxGapM], ["tracking-gap", ["shoot"], "-", "-", 2.28]]);
  const overOf = (list) => list.filter((i) => i.code === "overspeed").map((i) => [i.limitedBy, i.minDurationVerified, i.maxGapM]);
  assert.deepEqual(res.shootLog().filter((x) => x.shotId).map((x) => [x.shotId, overOf(x.issues)]), [
    ["k1", [["acceleration", true, accel.flight.dryFlight.maxGapM]]], ["k3", [["acceleration", null, noSpec.flight.dryFlight.maxGapM]]],
  ]);
  assert.deepEqual(inputs.map((x) => overOf(x.issues)), [[["acceleration", true, accel.flight.dryFlight.maxGapM]], [["acceleration", null, noSpec.flight.dryFlight.maxGapM]]]);
});

// ── S7: secrets ──────────────────────────────────────────────────────────────────────────────────────────

await check("S7 no output stream and no file under the temp tree contains the password, the page password or the key", () => {
  const secrets = [PASSWORD, encodeURIComponent(PASSWORD), PAGE_PW, KEY];
  for (const text of ALL_OUTPUT) for (const s of secrets) assert.ok(!text.includes(s), `secret in output: ${s}`);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const text = fs.readFileSync(f, "latin1");
        for (const s of secrets) assert.ok(!text.includes(s), `secret in ${f}`);
      }
    }
  };
  walk(TMP);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nfilm cli session: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
