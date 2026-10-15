// tests/film_cli.test.mjs
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) is driven by a Claude Code director through the
// Node CLI tools/film/film.mjs. A wrong exit code makes the director retry a broken plan or skip a real failure; a
// leaked password or OpenRouter key in a log is a security incident; a wrong ffmpeg argv silently produces a bad
// cut. This suite runs the REAL CLI `main(argv, deps)` and the real lib modules with injected fakes for every
// subcommand that needs no browser:
//   A  args parser, numeric/boolean options, FilmCliError exit codes, redactUrl + the secret scrubber
//   B  buildFilmUrl: the exact boot query string, filmDof=on + filmProps=on always, quality ultra by default, the
//      effects-audit flags (stormScan=retail always, waterSheenFade=40,500 always, cloudCoverage 0.3 for fair-weather
//      clouds / --coverage), password encoding, missing password → 2
//   C  doctor: fake ffmpeg script (encoders/demuxers), fake CDP /json/version, JEV key source + redaction,
//      --ping through the real JEV client over a fake fetch, unsafe key file, --offline, missing ffmpeg, the
//      full three-forward tunnel hint (--host / FILM_1070_HOST)
//   D  project init tree + refuse overwrite; techniques (fixture registry + the real catalog)
//   E  plan validate / compile with a real small plan written to os.tmpdir() and a fixture technique registry
//      (createRegistry), SONG_REQUIRED, --song beat grid, estimateShootTime text
//   F  song analyze through a fake ffmpeg that emits f32le PCM (real analyzeSong), lyrics, decode failure → 1,
//      missing ffmpeg → 2
//   G  sites search / show / build on a fixture gazetteer; go-readiness targets for sites (interiorLb from the
//      destination cell, the same as @teleloc's) and @teleloc; map
//      coordinates printed through scene3d/film/core/units.js formatMap (southern/western sites read S/W)
//   H  jev ping / decide over a fake fetch (key and state never printed), dry run, invalid questions, auth → 2;
//      jev task pick / keep / site-fit / family with an injected fake client, the code verdict without a key,
//      the JEV-failure fallback and the exit codes
//   I  assemble: argv equals assemblyArgv(buildAssembly(...)) (the edl.mjs filter string), EDL file,
//      missing takes → 1 / --missing=black; a silent tail (edit.tail): --dry-run argv with apad=whole_dur and the
//      element-local fades, totalSec incl. the tail; contact-sheet argv (every-Nth math, frames from the take report);
//      take mux argv (frames / VP9 re-encodes crop to even dimensions)
//   J  --help / unknown command / --json envelopes; a final scan that no output or written file holds a secret
// No browser, no network, no real ffmpeg: ffmpeg is a temp node script that records its argv.
//
// Run from apps/holtburger-web/: node tests/film_cli.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main, exitCodeFor } from "../tools/film/film.mjs";
import {
  EXIT,
  FilmCliError,
  boolArg,
  createScrubber,
  numArg,
  parseArgs,
  redactUrl,
  strArg,
} from "../tools/film/lib/args.mjs";
import { DEFAULT_FAIR_COVERAGE, DEFAULT_QUALITY, FILM_EFFECT_FLAGS, buildFilmUrl, readyTargetsForCommand, readyTargetsForSite, lbKeyOfId } from "../tools/film/lib/session.mjs";
import { contactSheetArgv, everyNth } from "../tools/film/lib/contact_sheet.mjs";
import { EVEN_CROP_FILTER, muxArgv, parseFfmpegList } from "../tools/film/lib/ffmpeg.mjs";
import { JEV_ENDPOINT, JevError } from "../tools/film/lib/jev.mjs";
import { flightOf, issueLine, judgeInput, mergeIssues, pageIssuesOf } from "../tools/film/lib/shoot.mjs";
import { assemblyArgv, buildAssembly, toCmx3600 } from "../tools/film/plan/edl.mjs";
import { createRegistry, defineTechnique, listTechniques as realListTechniques } from "../scene3d/film/shots/index.js";
import { makeTrajectory } from "../scene3d/film/shots/trajectory.js";

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
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "film-cli-"));
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const KEY = "sk-or-v1-TESTKEY-0123456789abcdef";
const PASSWORD = "Hunter2&Secret#pw";
const STATE_MARKER = "STATE-MARKER-XYZZY";
const ALL_OUTPUT = [];

const FAKE_FFMPEG_SRC = String.raw`
(function fakeFfmpeg() {
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "ffmpeg.argv.jsonl"), JSON.stringify(argv) + "\n");
let mode = {};
try { mode = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8")); } catch (_) {}
if (argv.includes("-encoders")) {
  process.stdout.write("Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264              libx264 H.264 (codec h264)\n V....D libvpx-vp9           libvpx VP9 (codec vp9)\n A....D aac                  AAC (Advanced Audio Coding)\n");
  process.exit(0);
}
if (argv.includes("-demuxers")) {
  process.stdout.write("Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ---\n D   h264            raw H.264 video\n D   image2          image2 sequence\n D   ivf             On2 IVF\n D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\n");
  process.exit(0);
}
if (argv.includes("f32le")) {
  if (mode.decode === "fail") { process.stderr.write("Invalid data found when processing input\n"); process.exit(1); }
  if (mode.decode === "empty") process.exit(0);
  const sr = Number(argv[argv.indexOf("-ar") + 1]) || 22050;
  const secs = 16;
  const pcm = new Float32Array(sr * secs);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sr;
    const ph = t % 0.5;
    pcm[i] = 0.05 * Math.sin(2 * Math.PI * 220 * t) + (ph < 0.02 ? 0.8 * Math.sin(2 * Math.PI * 1000 * t) * (1 - ph / 0.02) : 0);
  }
  // exit only after the pipe drained: process.exit() right after a big write truncates it
  process.stdout.write(Buffer.from(pcm.buffer), () => process.exit(0));
  return;
}
if (mode.fail) { process.stderr.write("fake ffmpeg failure\n"); process.exit(1); }
const out = argv[argv.length - 1];
fs.mkdirSync(path.dirname(out), { recursive: true });
const i = argv.indexOf("-i");
fs.writeFileSync(out, "FAKE-FFMPEG " + (i >= 0 ? argv[i + 1] : "") + "\n");
process.exit(0);
})();
`;

function fakeFfmpeg(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ffmpeg");
  fs.writeFileSync(file, `#!${process.execPath}\n${FAKE_FFMPEG_SRC}`, { mode: 0o755 });
  const log = path.join(dir, "ffmpeg.argv.jsonl");
  return {
    file,
    setMode: (m) => fs.writeFileSync(path.join(dir, "mode.json"), JSON.stringify(m)),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    reset: () => fs.rmSync(log, { force: true }),
  };
}
const FF = fakeFfmpeg("ffbin");

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

function makeFetch({ cdp = true, jev = "ok" } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization ?? null, body: opts.body ?? null });
    if (String(url).endsWith("/json/version")) {
      if (!cdp) {
        const e = new TypeError("fetch failed");
        e.cause = { code: "ECONNREFUSED" };
        throw e;
      }
      return jsonResponse(200, { Browser: "Chrome/140.0.7339.0", "Protocol-Version": "1.3" });
    }
    if (String(url) === JEV_ENDPOINT) {
      if (jev === "auth") return jsonResponse(401, { error: { code: 401, message: "No auth credentials found" } });
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.97 };
        else if (q.type === "score") answers[id] = { type: "score", score: 0.4, confidence: 0.7, probabilities: { 0: 0.6, 1: 0.4, 2: 0 } };
        else {
          const first = Object.keys(q.criteria)[0];
          answers[id] = { type: "choice", choice: first, confidence: 0.91, probabilities: { [first]: 0.91 } };
        }
      }
      return jsonResponse(200, { id: "gen-test-1", model: "typesafe/jev-1.13", answers, usage: { input_tokens: 64, output_tokens: 0, cost: 0.0000027 } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const lockCalls = [];
async function fakeLock(opts) {
  const rec = { label: opts.label, released: false };
  lockCalls.push(rec);
  return { dir: "/fake/lock", bypassed: null, waitedMs: 0, release: () => { rec.released = true; } };
}

function capture() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

async function run(argv, extra = {}) {
  const out = capture();
  const err = capture();
  const deps = {
    stdout: out,
    stderr: err,
    env: { HOME, ...(extra.env ?? {}) },
    cwd: TMP,
    now: () => NOW,
    sleep: async () => {},
    fetch: extra.fetch ?? makeFetch(),
    resolvePlaywright: () => "/fake/node_modules/playwright-core/index.js",
    versions: { node: "20.20.2" },
    acquireHeavyLock: fakeLock,
    ...(extra.deps ?? {}),
  };
  const code = await main(argv, deps);
  ALL_OUTPUT.push(out.text(), err.text());
  return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
}

// A fixture technique registry (the shipped one may still be empty while the technique lanes run).
function fixtureRegistry() {
  const reg = createRegistry();
  const build = (spec, ctx) => makeTrajectory({
    id: spec.technique,
    technique: spec.technique,
    family: spec.technique.split(".")[0],
    duration: spec.duration,
    positionAt: () => (Array.isArray(ctx?.anchor) ? ctx.anchor : [0, 0, 0]).map(Number),
    orientAt: () => ({ h: 0, p: 0, r: 0 }),
  });
  reg.registerTechnique(defineTechnique({ id: "classic.static", name: "Static", description: "Locked-off camera.", whenToUse: "Calm beats.", build }));
  reg.registerTechnique(defineTechnique({ id: "fpv.fpv-corridor", name: "FPV corridor", description: "Fly a corridor.", whenToUse: "Dungeons.", needs: { indoor: true }, build }));
  return reg;
}
const REG = fixtureRegistry();

function smallPlan(over = {}) {
  return {
    version: 1,
    title: "CLI test reel",
    format: { width: 64, height: 36, fps: 10, capture: "stepped" },
    sites: [
      { id: "holtburg", teleport: "@telepoi Holtburg", anchor: { cell: "0xA9B40019", local: [84, 7.1, 94] } },
      { id: "dungeon", indoor: true, cell: "0x01F60289", teleport: "@teleloc 0x01F60289 96.70 -10.00 0.00 1 0 0 0", anchor: { cell: "0x01F60289", local: [96.7, -10, 0] } },
    ],
    shots: [
      { id: "s1", site: "holtburg", technique: "classic.static", duration: { sec: 1 }, standingOrder: "Hold still and keep 3 m from walls." },
      { id: "s2", site: "dungeon", technique: "fpv.fpv-corridor", duration: { sec: 1 }, route: { fromCell: "0x01F60289", toCell: "0x01F6027A" }, standingOrder: "Fly the corridor, 1 m from walls." },
      { id: "s3", site: "holtburg", technique: "classic.static", duration: { sec: 1 }, transition: "dissolve", standingOrder: "Hold still again." },
    ],
    ...over,
  };
}

function songFixture() {
  const beats = [];
  for (let i = 0; i < 64; i++) beats.push(i * 0.5);
  const bars = [];
  for (let i = 0; i < 16; i++) bars.push({ i, start: i * 2, end: i * 2 + 2 });
  return {
    version: 1,
    durationSec: 32,
    sampleRate: 22050,
    sourceSampleRate: 22050,
    tempo: { bpm: 120, confidence: 0.9 },
    beats,
    downbeats: bars.map((b) => b.start),
    bars,
    sections: [
      { i: 0, start: 0, end: 16, startBar: 0, endBar: 8, label: "A", role: "verse", energy: 0.4, repeatOf: null },
      { i: 1, start: 16, end: 32, startBar: 8, endBar: 16, label: "B", role: "chorus", energy: 0.9, repeatOf: null },
    ],
    energy: { hopSec: 0.5, values: [] },
  };
}

const GAZ = path.join(TMP, "gaz", "film_gazetteer.jsonl");
fs.mkdirSync(path.dirname(GAZ), { recursive: true });
fs.writeFileSync(GAZ, [
  { id: "holtburg", name: "Holtburg", aliases: ["Holtburg Town"], kind: "town", cell: "0xA9B40019", lb: "0xA9B4", indoor: false, map: { ns: 42.1, ew: 33.6 }, teleport: { best: "@telepoi Holtburg", tele: "@tele 42.10N 33.60E" }, culture: "aluvian", biome: "grassland", terrain: ["grass", "road"], tags: ["town", "lifestone", "market"], sources: ["fixture"] },
  { id: "holtburg-dungeon", name: "Holtburg Dungeon", aliases: [], kind: "dungeon", cell: "0x01F60289", lb: "0x01F6", indoor: true, map: null, teleport: { best: "@teleloc 0x01F60289 96.70 -10.00 0.00 1 0 0 0" }, tags: ["dungeon", "undead", "crypt"], sources: ["fixture"] },
  { id: "glenden-wood", name: "Glenden Wood", aliases: [], kind: "town", cell: "0xA0A40025", lb: "0xA0A4", indoor: false, map: { ns: 30.0, ew: 26.0 }, teleport: { best: "@telepoi Glenden Wood" }, culture: "aluvian", biome: "forest", terrain: ["forest", "trees"], tags: ["town", "forest"], sources: ["fixture"] },
].map((s) => JSON.stringify(s)).join("\n") + "\n");

// ── A: args, errors, redaction ───────────────────────────────────────────────────────────────────────────

await check("A1 parseArgs: --key=value (value keeps '='), --flag, --no-flag, -h, positionals, -- rest", () => {
  const a = parseArgs(["shoot", "t.json", "--shot=s1", "--all", "--no-rehearse", "--q=a=b", "-h", "--", "--not-an-option", "x"]);
  assert.deepEqual(a._, ["shoot", "t.json", "--not-an-option", "x"]);
  assert.equal(a.shot, "s1");
  assert.equal(a.all, true);
  assert.equal(a.rehearse, false);
  assert.equal(a.q, "a=b");
  assert.equal(a.help, true);
  assert.throws(() => parseArgs(["--=x"]), (e) => e instanceof FilmCliError && e.exitCode === EXIT.USAGE);
});

await check("A2 numArg / boolArg / strArg validate and default; errors are usage (exit 2)", () => {
  const a = parseArgs(["--n=5", "--f=1.5", "--bad=abc", "--flag", "--yes=on", "--off=no", "--s=hi"]);
  assert.equal(numArg(a, "n", 1, { integer: true, min: 0, max: 9 }), 5);
  assert.equal(numArg(a, "missing", 7), 7);
  assert.throws(() => numArg(a, "f", 0, { integer: true }), /integer/);
  assert.throws(() => numArg(a, "bad", 0), /must be a number/);
  assert.throws(() => numArg(a, "flag", 0), /needs a value/);
  assert.throws(() => numArg(a, "n", 0, { max: 4 }), /≤ 4/);
  assert.equal(boolArg(a, "flag"), true);
  assert.equal(boolArg(a, "yes"), true);
  assert.equal(boolArg(a, "off"), false);
  assert.equal(boolArg(a, "absent"), false);
  assert.equal(boolArg(a, "absent", true), true);
  assert.throws(() => boolArg(a, "s"), /true or false/);
  assert.equal(strArg(a, "s"), "hi");
  assert.throws(() => strArg(a, "flag"), /needs a value/);
  try {
    numArg(a, "bad", 0);
  } catch (e) {
    assert.equal(exitCodeFor(e), EXIT.USAGE);
  }
});

await check("A3 redactUrl + scrubber remove password= values and literal (URL-encoded) secrets, longest first", () => {
  assert.equal(redactUrl("http://h/i.html?account=a&password=hunter2&x=1"), "http://h/i.html?account=a&password=[redacted]&x=1");
  assert.equal(redactUrl("x?password=abc"), "x?password=[redacted]");
  assert.equal(redactUrl("use --password=<pw>"), "use --password=<pw>"); // help text stays readable
  assert.equal(redactUrl("no secrets here"), "no secrets here");
  const s = createScrubber();
  s.add(PASSWORD);
  s.add(KEY);
  s.add("");
  const text = `pw ${PASSWORD} enc ${encodeURIComponent(PASSWORD)} key ${KEY} url ?password=${encodeURIComponent(PASSWORD)}&a=1`;
  const out = s.scrub(text);
  assert.ok(!out.includes(PASSWORD) && !out.includes(encodeURIComponent(PASSWORD)) && !out.includes(KEY), out);
  assert.match(out, /password=\[redacted\]&a=1/);
  assert.equal(s.size(), 3); // password, its encoding, key
});

await check("A4 exitCodeFor maps JevError config/auth → 2, other kinds → 1, FilmPlanError → 1, FilmShotError → 2", async () => {
  const { JevError } = await import("../tools/film/lib/jev.mjs");
  const { FilmPlanError, FilmShotError } = await import("../scene3d/film/core/errors.js");
  assert.equal(exitCodeFor(new JevError("config", "x")), 2);
  assert.equal(exitCodeFor(new JevError("auth", "x")), 2);
  assert.equal(exitCodeFor(new JevError("budget", "x")), 1);
  assert.equal(exitCodeFor(new FilmPlanError("x", "PLAN_INVALID")), 1);
  assert.equal(exitCodeFor(new FilmPlanError("x", "BAD_ARGUMENT")), 2);
  assert.equal(exitCodeFor(new FilmShotError("x")), 2);
  assert.equal(exitCodeFor(new FilmCliError("x", { exitCode: 1 })), 1);
  assert.equal(exitCodeFor(new Error("x")), 2);
});

// ── B: film URL ──────────────────────────────────────────────────────────────────────────────────────────

await check("B1 buildFilmUrl: the exact boot query, filmDof=on + filmProps=on always, password URL-encoded", () => {
  const url = buildFilmUrl({ base: "http://127.0.0.1:8765/apps/holtburger-web/index.html", account: "phase4demo", password: "pw", quality: "high" });
  assert.equal(url,
    "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&agent=1&hud=none&plugins=none&filmMode=on&filmDof=on&filmProps=on&autoLogin=1&account=phase4demo&password=pw&autoSpawn=first&quality=high&renderScale=1&adaptiveRes=off&radialFog=on&objRadius=off&fogRingCap=off&punchSidedness=on&particleClock=sim&frameBudget=off&maxTickDist=400&dynLod=off&clouds=on&cloudWeather=off&cloudCoverage=0.3&stormScan=retail&waterSheenFade=40,500");
  const def = buildFilmUrl({ password: PASSWORD });
  // clouds: on by default (owner 2026-10-14), off on request, anything else is a usage error
  assert.equal(new URL(def).searchParams.get("clouds"), "on");
  assert.equal(new URL(buildFilmUrl({ password: "x", clouds: "off" })).searchParams.has("clouds"), false);
  assert.throws(() => buildFilmUrl({ password: "x", clouds: "yes" }), (e) => e instanceof FilmCliError && e.exitCode === 2);
  // weather: fair (cloudWeather=off) by default with clouds on; live drops it; no clouds → no weather param
  assert.equal(new URL(def).searchParams.get("cloudWeather"), "off");
  assert.equal(new URL(buildFilmUrl({ password: "x", weather: "live" })).searchParams.has("cloudWeather"), false);
  assert.equal(new URL(buildFilmUrl({ password: "x", clouds: "off" })).searchParams.has("cloudWeather"), false);
  assert.throws(() => buildFilmUrl({ password: "x", weather: "sunny" }), (e) => e instanceof FilmCliError && e.exitCode === 2);
  assert.ok(def.startsWith("http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&agent=1&"), def);
  assert.match(def, /&account=phase4demo&/);
  assert.equal(new URL(def).searchParams.get("password"), PASSWORD);
  for (const quality of ["low", "mid", "high", "ultra"]) {
    const u = new URL(buildFilmUrl({ password: "x", quality }));
    assert.equal(u.searchParams.get("filmDof"), "on");
    // the lens overlay (FPV props) is armed on every film page; it draws only for shots with overlay.props
    assert.equal(u.searchParams.get("filmProps"), "on");
    assert.equal(u.searchParams.get("filmMode"), "on");
    assert.equal(u.searchParams.get("quality"), quality);
  }
  // a base that already has a query gets '&'
  assert.match(buildFilmUrl({ base: "http://h/i.html?bridge_url=ws://x", password: "x" }), /^http:\/\/h\/i\.html\?bridge_url=ws:\/\/x&nosw=1&agent=1/);
  assert.throws(() => buildFilmUrl({ password: "" }), (e) => e instanceof FilmCliError && e.exitCode === 2 && e.code === "NO_PASSWORD");
  assert.equal(redactUrl(def).includes(encodeURIComponent(PASSWORD)), false);
});

await check("B2 boot URL effects (audit 2026-10-15): quality ultra by default, stormScan=retail always, waterSheenFade=40,500 always, cloudCoverage 0.3 for fair clouds / explicit --coverage", () => {
  const P = (o = {}) => new URL(buildFilmUrl({ password: "x", ...o })).searchParams;
  // ultra by default (stepped capture is not real-time bound); --quality overrides
  assert.equal(DEFAULT_QUALITY, "ultra");
  assert.equal(P().get("quality"), "ultra");
  assert.equal(P({ quality: "mid" }).get("quality"), "mid");
  // retail's storm rule and the 500 m water sheen ride on EVERY boot (fair, live, clouds off), in that order, last
  assert.deepEqual(FILM_EFFECT_FLAGS.map((f) => [...f]), [["stormScan", "retail"], ["waterSheenFade", "40,500"]]);
  for (const o of [{}, { weather: "live" }, { clouds: "off" }, { clouds: "off", weather: "live" }, { coverage: 0.7 }]) {
    const u = buildFilmUrl({ password: "x", ...o });
    assert.ok(u.endsWith("&stormScan=retail&waterSheenFade=40,500"), `${JSON.stringify(o)}: ${u}`);
    assert.equal(new URL(u).searchParams.get("stormScan"), "retail");
    assert.equal(new URL(u).searchParams.get("waterSheenFade"), "40,500", "the comma stays literal");
    assert.equal(new URL(u).searchParams.get("filmProps"), "on");
  }
  // coverage: 0.3 with fair-weather clouds; none with live weather or no clouds; an explicit value always wins
  assert.equal(DEFAULT_FAIR_COVERAGE, 0.3);
  assert.equal(P().get("cloudCoverage"), "0.3");
  assert.equal(P({ weather: "live" }).has("cloudCoverage"), false);
  assert.equal(P({ clouds: "off" }).has("cloudCoverage"), false);
  assert.equal(P({ coverage: 0.55 }).get("cloudCoverage"), "0.55");
  assert.equal(P({ coverage: 0.8, weather: "live" }).get("cloudCoverage"), "0.8");
  assert.equal(P({ coverage: 0, clouds: "off" }).get("cloudCoverage"), "0");
  assert.equal(P({ coverage: "0.4" }).get("cloudCoverage"), "0.4");
  assert.match(buildFilmUrl({ password: "x" }), /&cloudWeather=off&cloudCoverage=0\.3&stormScan=retail/);
  for (const bad of [1.5, -0.1, "x", NaN, true]) {
    assert.throws(() => buildFilmUrl({ password: "x", coverage: bad }), (e) => e instanceof FilmCliError && e.exitCode === 2 && /--coverage must be a number in \[0, 1\]/.test(e.message), String(bad));
  }
});

// ── C: doctor ────────────────────────────────────────────────────────────────────────────────────────────

await check("C1 doctor: all required checks pass with a fake ffmpeg + CDP; key reported by source and redacted only", async () => {
  FF.reset();
  const fetch = makeFetch();
  const r = await run(["doctor", `--ffmpeg=${FF.file}`, `--gazetteer=${GAZ}`, `--root=${TMP}`, "--min-free-gb=0", "--json"], { fetch, env: { OPENROUTER_API_KEY: KEY } });
  assert.equal(r.code, 0, r.err + r.out);
  const res = r.json().result;
  const by = Object.fromEntries(res.checks.map((c) => [c.name, c]));
  for (const n of ["node", "ffmpeg", "ffmpeg encoder libx264", "ffmpeg encoder libvpx-vp9", "ffmpeg h264 demuxer (Annex-B takes)", "playwright-core", "CDP", "JEV key", "gazetteer", "disk"]) {
    assert.ok(by[n], `missing check ${n}`);
    assert.equal(by[n].ok, true, `${n}: ${by[n].detail}`);
  }
  assert.match(by.CDP.detail, /Chrome\/140.*protocol 1\.3/);
  assert.match(by["JEV key"].detail, /^env:OPENROUTER_API_KEY sk-or-…$/);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  assert.deepEqual(FF.calls().map((a) => a.slice(-1)[0]), ["-encoders", "-demuxers"]);
  assert.equal(fetch.calls[0].url, "http://127.0.0.1:9333/json/version");
  assert.equal(fetch.calls.some((c) => c.url === JEV_ENDPOINT), false, "no JEV call without --ping");
});

await check("C2 doctor --ping makes one JEV decision through the real client (fake fetch); the key never prints", async () => {
  const fetch = makeFetch();
  const r = await run(["doctor", `--ffmpeg=${FF.file}`, `--gazetteer=${GAZ}`, `--root=${TMP}`, "--min-free-gb=0", "--ping"], { fetch, env: { OPENROUTER_API_KEY: KEY } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /JEV ping\s+pYes 0\.970/);
  const jevCalls = fetch.calls.filter((c) => c.url === JEV_ENDPOINT);
  assert.equal(jevCalls.length, 1);
  assert.equal(jevCalls[0].auth, `Bearer ${KEY}`);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

await check("C3 doctor: CDP unreachable → exit 1 (required) unless --offline; missing ffmpeg → exit 1", async () => {
  const down = makeFetch({ cdp: false });
  let r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0"], { fetch: down });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL\s+CDP\s+.*unreachable.*ECONNREFUSED/);
  r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--offline", `--gazetteer=${path.join(TMP, "no-gaz.jsonl")}`], { fetch: down });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warn\s+CDP/);
  assert.match(r.out, /warn\s+gazetteer\s+.*film sites build/); // the gazetteer is optional
  r = await run(["doctor", "--ffmpeg=/nonexistent/dir/ffmpeg", `--root=${TMP}`, "--min-free-gb=0"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL\s+ffmpeg\s+.*not found — set FILM_FFMPEG or pass --ffmpeg/);
});

await check("C4 doctor: an unsafe key file (mode 644) is a required failure naming the chmod 600 fix; no key is fine", async () => {
  const home2 = path.join(TMP, "home-unsafe");
  const keyFile = path.join(home2, ".config", "holtburger-film", "openrouter.key");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o644 });
  fs.chmodSync(keyFile, 0o644);
  let r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--json"], { env: { HOME: home2 } });
  assert.equal(r.code, 1);
  const k = r.json().result.checks.find((c) => c.name === "JEV key");
  assert.equal(k.ok, false);
  assert.match(k.detail, /chmod 600/);
  assert.ok(!r.out.includes(KEY));
  r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--json"]);
  const none = r.json().result.checks.find((c) => c.name === "JEV key");
  assert.equal(none.ok, true);
  assert.equal(none.required, false);
  assert.match(none.detail, /none — the pilot flies its code policy/);
});

await check("C5 doctor: CDP unreachable prints the FULL film tunnel (-L 9333, -R 8765, -R 8080, ExitOnForwardFailure); host from --host / FILM_1070_HOST", async () => {
  const down = makeFetch({ cdp: false });
  const full = "ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75";
  let r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0"], { fetch: down });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(full), r.out);
  assert.match(r.out, /without -R 8080 the login dies with 'WsTransport ws handshake failed'/);
  assert.equal(/ssh -fN -L 9333:127\.0\.0\.1:9333 <1070>/.test(r.out), false, "the old one-forward hint is gone");
  r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--json"], { fetch: down });
  assert.equal(r.json().result.tunnel, full);
  // --host wins over the env; the env wins over the default; the -L port follows --cdp
  r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--host=film@10.0.0.7", "--json"], { fetch: down, env: { FILM_1070_HOST: "envuser@10.9.9.9" } });
  assert.equal(r.json().result.tunnel, full.replace("young@100.127.215.75", "film@10.0.0.7"));
  r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--cdp=http://127.0.0.1:9445", "--json"], { fetch: down, env: { FILM_1070_HOST: "envuser@10.9.9.9" } });
  assert.equal(r.json().result.tunnel, "ssh -o ExitOnForwardFailure=yes -fN -L 9445:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 envuser@10.9.9.9");
  // a reachable CDP prints no tunnel
  r = await run(["doctor", `--ffmpeg=${FF.file}`, `--root=${TMP}`, "--min-free-gb=0", "--json"]);
  assert.equal(r.json().result.tunnel, undefined);
  assert.equal(r.out.includes("ExitOnForwardFailure"), false);
});

// ── D: project init, techniques ──────────────────────────────────────────────────────────────────────────

await check("D1 project init: full tree + project.json + plan skeleton; refuses to overwrite (exit 2); bad name → 2", async () => {
  const root = path.join(TMP, "projects");
  let r = await run(["project", "init", "my-video", `--root=${root}`]);
  assert.equal(r.code, 0, r.err);
  const dir = path.join(root, "my-video");
  for (const sub of ["song", "takes", "stills", "reports", "edit"]) assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), sub);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")), { name: "my-video", created: new Date(NOW).toISOString(), version: 1 });
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  assert.equal(plan.version, 1);
  assert.equal(plan.title, "my-video");
  assert.deepEqual([plan.sites, plan.shots], [[], []]);
  assert.ok(fs.existsSync(path.join(dir, "script.txt")));
  fs.writeFileSync(path.join(dir, "script.txt"), "my precious script");
  r = await run(["project", "init", "my-video", `--root=${root}`]);
  assert.equal(r.code, 2);
  assert.match(r.err, /refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, "script.txt"), "utf8"), "my precious script");
  r = await run(["project", "init", "../escape", `--root=${root}`]);
  assert.equal(r.code, 2);
  r = await run(["project", "init", `--root=${root}`]);
  assert.equal(r.code, 2);
});

await check("D2 techniques: lists the injected registry (text + JSON), --family filter, unknown family → 2", async () => {
  let r = await run(["techniques"], { deps: { registry: REG } });
  assert.equal(r.code, 0);
  assert.match(r.out, /^2 technique\(s\)/);
  assert.match(r.out, /classic\.static\s+Static — Calm beats\./);
  r = await run(["techniques", "--family=fpv", "--json"], { deps: { registry: REG } });
  const res = r.json().result;
  assert.equal(res.count, 1);
  assert.equal(res.techniques[0].id, "fpv.fpv-corridor");
  assert.deepEqual(res.techniques[0].needs, { subject: false, path: false, indoor: true });
  r = await run(["techniques", "--family=submarine"], { deps: { registry: REG } });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown technique family/);
});

await check("D3 techniques with the shipped registry reports exactly scene3d/film/shots listTechniques()", async () => {
  const r = await run(["techniques", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.json().result.count, realListTechniques().length);
});

// ── E: plan validate / compile ───────────────────────────────────────────────────────────────────────────

const PLAN_DIR = path.join(TMP, "planproj");
fs.mkdirSync(PLAN_DIR, { recursive: true });
const PLAN = path.join(PLAN_DIR, "plan.json");
fs.writeFileSync(PLAN, JSON.stringify(smallPlan()));

await check("E1 plan validate: a valid plan → exit 0 with the injected registry; unknown technique → exit 1 with 'path: message'", async () => {
  let r = await run(["plan", "validate", PLAN], { deps: { registry: REG } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^valid: 0 error\(s\)/);
  const bad = path.join(PLAN_DIR, "bad.json");
  const p = smallPlan();
  p.shots[0].technique = "classic.statik";
  p.shots[1].site = "nowhere";
  fs.writeFileSync(bad, JSON.stringify(p));
  r = await run(["plan", "validate", bad, "--json"], { deps: { registry: REG } });
  assert.equal(r.code, 1);
  const res = r.json().result;
  assert.equal(res.ok, false);
  const paths = res.errors.map((e) => e.path);
  assert.ok(paths.includes("shots[0].technique"), JSON.stringify(res.errors));
  assert.ok(paths.includes("shots[1].site"), JSON.stringify(res.errors));
  r = await run(["plan", "validate", bad], { deps: { registry: REG } });
  assert.match(r.out, /shots\[0\]\.technique: .*classic\.static/);
  r = await run(["plan", "validate", path.join(PLAN_DIR, "missing.json")]);
  assert.equal(r.code, 2);
});

await check("E2 plan compile: writes timeline.json (schedule by site) and prints estimateShootTime", async () => {
  const r = await run(["plan", "compile", PLAN], { deps: { registry: REG } });
  assert.equal(r.code, 0, r.out + r.err);
  const t = JSON.parse(fs.readFileSync(path.join(PLAN_DIR, "timeline.json"), "utf8"));
  assert.equal(t.version, 1);
  assert.deepEqual(t.schedule.map((e) => [e.siteId, e.shots]), [["holtburg", ["s1", "s3"]], ["dungeon", ["s2"]]]);
  assert.match(r.out, /schedule: holtburg \[s1 s3\] → dungeon \[s2\]/);
  assert.match(r.out, /≈ .* wall-clock: 2 teleport\(s\)/);
});

await check("E3 plan compile: beats without a song → SONG_REQUIRED (exit 1); with --song → timeline on the beat grid", async () => {
  const p = smallPlan({ song: { file: "song/song.mp3", analysis: "song/song.json" } });
  p.shots[0].duration = { beats: 4 };
  p.shots[2].duration = { bars: 1 };
  const f = path.join(PLAN_DIR, "beats.json");
  fs.writeFileSync(f, JSON.stringify(p));
  let r = await run(["plan", "compile", f, `--out=${path.join(PLAN_DIR, "beats.timeline.json")}`], { deps: { registry: REG } });
  assert.equal(r.code, 1);
  assert.match(r.out, /SONG_REQUIRED/);
  assert.match(r.out, /shots needing the song: s1, s3/);
  const songFile = path.join(PLAN_DIR, "song.json");
  fs.writeFileSync(songFile, JSON.stringify(songFixture()));
  r = await run(["plan", "compile", f, `--song=${songFile}`, `--out=${path.join(PLAN_DIR, "beats.timeline.json")}`, "--json"], { deps: { registry: REG } });
  assert.equal(r.code, 0, r.out + r.err);
  const t = JSON.parse(fs.readFileSync(path.join(PLAN_DIR, "beats.timeline.json"), "utf8"));
  assert.equal(t.items[0].editDuration, 2); // 4 beats at 120 BPM
  r = await run(["plan", "validate", f, `--song=${songFile}`], { deps: { registry: REG } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compiles: 3 shot\(s\)/);
});

// ── F: song analyze ──────────────────────────────────────────────────────────────────────────────────────

await check("F1 song analyze: fake ffmpeg PCM → real analyzeSong → song.json + summary with BPM, sections, lyrics", async () => {
  FF.setMode({});
  const audio = path.join(TMP, "song", "track.mp3");
  fs.mkdirSync(path.dirname(audio), { recursive: true });
  fs.writeFileSync(audio, "not really audio");
  const lrc = path.join(TMP, "song", "track.lrc");
  fs.writeFileSync(lrc, "[00:01.00]lanterns over the hill\n[00:09.00]hold the line tonight\n");
  const r = await run(["song", "analyze", audio, `--lyrics=${lrc}`, `--ffmpeg=${FF.file}`]);
  assert.equal(r.code, 0, r.err);
  const a = JSON.parse(fs.readFileSync(path.join(TMP, "song", "song.json"), "utf8"));
  assert.equal(a.version, 1);
  assert.ok(Math.abs(a.tempo.bpm - 120) < 2, `bpm ${a.tempo.bpm}`);
  assert.equal(a.lyrics.lines.length, 2);
  assert.match(r.out, /120\.0 BPM/);
  assert.match(r.out, /lyrics \(lrc\): 2 line\(s\)/);
  assert.match(r.out, /“lanterns over the hill”/);
  const dec = FF.calls().find((c) => c.includes("f32le"));
  assert.deepEqual(dec.slice(0, 5), ["-nostdin", "-v", "error", "-i", audio]);
});

await check("F2 song analyze: decode failure → exit 1; missing ffmpeg → exit 2; no audio arg → 2", async () => {
  const audio = path.join(TMP, "song", "track.mp3");
  FF.setMode({ decode: "fail" });
  let r = await run(["song", "analyze", audio, `--ffmpeg=${FF.file}`, `--out=${path.join(TMP, "song", "x.json")}`]);
  assert.equal(r.code, 1);
  assert.match(r.err, /ffmpeg failed .*exit code 1.*Invalid data/);
  FF.setMode({ decode: "empty" });
  r = await run(["song", "analyze", audio, `--ffmpeg=${FF.file}`, `--out=${path.join(TMP, "song", "x.json")}`]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no audio decoded/);
  FF.setMode({});
  r = await run(["song", "analyze", audio, "--ffmpeg=/nonexistent/ffmpeg"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not found — set FILM_FFMPEG or pass --ffmpeg/);
  r = await run(["song", "analyze"]);
  assert.equal(r.code, 2);
});

// ── G: sites ─────────────────────────────────────────────────────────────────────────────────────────────

await check("G1 sites search: ranked fixture results, --kind / --indoor / --near filters, JSON rows", async () => {
  let r = await run(["sites", "search", "holtburg", `--gazetteer=${GAZ}`, "--json"]);
  assert.equal(r.code, 0, r.err);
  const res = r.json().result;
  assert.equal(res.results[0].id, "holtburg");
  assert.equal(res.results[0].teleport, "@telepoi Holtburg");
  r = await run(["sites", "search", "crypt", `--gazetteer=${GAZ}`, "--indoor", "--json"]);
  assert.deepEqual(r.json().result.results.map((x) => x.id), ["holtburg-dungeon"]);
  r = await run(["sites", "search", "town", `--gazetteer=${GAZ}`, "--kind=town", "--near=42,33.5,1", "--json"]);
  assert.deepEqual(r.json().result.results.map((x) => x.id), ["holtburg"]);
  r = await run(["sites", "search", "forest", `--gazetteer=${GAZ}`]);
  assert.match(r.out, /glenden-wood/);
  r = await run(["sites", "search", "x", `--gazetteer=${GAZ}`, "--near=north"]);
  assert.equal(r.code, 2);
  r = await run(["sites", "search", "x", `--gazetteer=${path.join(TMP, "nope.jsonl")}`]);
  assert.equal(r.code, 2);
  assert.match(r.err, /film sites build/);
});

await check("G2 sites show: words + teleport + readiness targets; unknown id → exit 1", async () => {
  let r = await run(["sites", "show", "holtburg-dungeon", `--gazetteer=${GAZ}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Teleport: @teleloc 0x01F60289/);
  assert.match(r.out, /ready: lbKeys 0x01F60000 interiorLb 0x01F60000/);
  r = await run(["sites", "show", "Holtburg Town", `--gazetteer=${GAZ}`, "--json"]);
  assert.equal(r.json().result.site.id, "holtburg");
  r = await run(["sites", "show", "atlantis", `--gazetteer=${GAZ}`]);
  assert.equal(r.code, 1);
});

await check("G3 readiness targets: site lb << 16 (>>> 0), interiorLb from the destination cell (EnvCell), not kind/map; @teleloc cell → landblock", () => {
  assert.deepEqual(readyTargetsForSite({ lb: "0xA9B4", indoor: false, map: { ns: 1, ew: 1 } }), { lbKeys: [0xa9b40000], interiorLb: null });
  assert.deepEqual(readyTargetsForSite({ lb: "0x01F6", indoor: true, map: null, kind: "dungeon" }), { lbKeys: [0x01f60000], interiorLb: 0x01f60000 });
  // tooling-8: no cell, indoor → the interior gate whatever the kind or map (an @teledungeon/@tele site)
  assert.deepEqual(readyTargetsForSite({ lb: "0xA9B4", indoor: true, map: { ns: 1, ew: 1 }, kind: "town" }), { lbKeys: [0xa9b40000], interiorLb: 0xa9b40000 });
  // tooling-8: a town whose exact @teleloc destination is an EnvCell (Kor-Gursha-shaped) keeps the interior gate
  const korGursha = { lb: "0x009C", cell: "0x009C0247", indoor: true, map: { ns: 67.4, ew: 30.5 }, kind: "town", teleport: { best: "@teleloc 0x009C0247 160 -70 -17.995 0.707107 0 0 -0.707107" } };
  assert.deepEqual(readyTargetsForSite(korGursha), { lbKeys: [0x009c0000], interiorLb: 0x009c0000 });
  // a building interior with a map position (EnvCell cell, @telepoi best) and a POI on an EnvCell
  assert.deepEqual(readyTargetsForSite({ lb: "0x9EE5", cell: "0x9EE50293", indoor: true, map: { ns: 10, ew: 20 }, kind: "town", teleport: { best: "@telepoi Northwatch Castle" } }), { lbKeys: [0x9ee50000], interiorLb: 0x9ee50000 });
  assert.deepEqual(readyTargetsForSite({ lb: "0x9EE5", cell: "0x9EE50293", indoor: true, map: { ns: 10, ew: 20 }, kind: "poi" }), { lbKeys: [0x9ee50000], interiorLb: 0x9ee50000 });
  // an outdoor cell is never an interior, even with a stray indoor flag
  assert.deepEqual(readyTargetsForSite({ lb: "0xA9B4", cell: "0xA9B40019", indoor: true, map: { ns: 1, ew: 1 }, kind: "town" }), { lbKeys: [0xa9b40000], interiorLb: null });
  // parity: for every @teleloc site the site targets equal the command's (the cell actually teleported to)
  for (const [cell, kind, map] of [["0x009C0247", "town", { ns: 1, ew: 1 }], ["0x01F60289", "dungeon", null], ["0xA9B40019", "town", { ns: 1, ew: 1 }], ["0x9EE50293", "poi", { ns: 2, ew: 2 }], ["0xC6A90102", "landmark", { ns: 3, ew: 3 }], ["0x7D6400FF", "wilderness", { ns: 4, ew: 4 }]]) {
    const best = `@teleloc ${cell} 1 2 3 1 0 0 0`;
    const site = { lb: cell.slice(0, 6), cell, indoor: (parseInt(cell, 16) & 0xffff) >= 0x100, map, kind, teleport: { best } };
    assert.deepEqual(readyTargetsForSite(site), readyTargetsForCommand(best), cell);
  }
  assert.deepEqual(readyTargetsForCommand("@teleloc 0x01F60289 96.7 -10 0"), { lbKeys: [0x01f60000], interiorLb: 0x01f60000 });
  assert.deepEqual(readyTargetsForCommand("@teleloc A9B40019 84 7 94 1 0 0 0"), { lbKeys: [0xa9b40000], interiorLb: null });
  assert.deepEqual(readyTargetsForCommand("@telepoi Holtburg"), { lbKeys: [], interiorLb: null });
  assert.equal(lbKeyOfId("0xA9B4"), 0xa9b40000);
  assert.equal(lbKeyOfId(0xa9b40019), 0xa9b40000);
});

await check("G4 sites build writes a JSONL gazetteer (+ .meta.json) from --paths (empty sources → 0 sites)", async () => {
  const pj = path.join(TMP, "paths.json");
  fs.writeFileSync(pj, "{}");
  const out = path.join(TMP, "gaz2", "g.jsonl");
  const r = await run(["sites", "build", `--paths=${pj}`, `--out=${out}`, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().result.count, 0);
  assert.ok(fs.existsSync(out) && fs.existsSync(`${out}.meta.json`));
  assert.match(r.err, /no path configured — source skipped/);
});

await check("G5 map coordinates use units.js formatMap: a south-western site reads '80.8S, 61.6W' in search and show (never '-80.8N')", async () => {
  const gsw = path.join(TMP, "gaz-sw", "g.jsonl");
  fs.mkdirSync(path.dirname(gsw), { recursive: true });
  fs.writeFileSync(gsw, [
    { id: "obsidian-rim", name: "Obsidian Rim", aliases: [], kind: "landmark", cell: "0x10200019", lb: "0x1020", indoor: false, map: { ns: -80.8, ew: -61.6 }, teleport: { best: "@tele 80.80S 61.60W" }, terrain: ["obsidian", "rock"], tags: ["landmark", "obsidian"], sources: ["fixture"] },
    { id: "holtburg", name: "Holtburg", aliases: [], kind: "town", cell: "0xA9B40019", lb: "0xA9B4", indoor: false, map: { ns: 42.1, ew: 33.6 }, teleport: { best: "@telepoi Holtburg" }, tags: ["town"], sources: ["fixture"] },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  let r = await run(["sites", "search", "obsidian", `--gazetteer=${gsw}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /obsidian-rim .*Obsidian Rim \(80\.8S, 61\.6W\)/);
  assert.equal(/-80\.8N|-61\.6E/.test(r.out), false, r.out);
  r = await run(["sites", "search", "holtburg", `--gazetteer=${gsw}`, "--json"]);
  assert.equal(r.json().result.results[0].mapText, "42.1N, 33.6E");
  r = await run(["sites", "show", "obsidian-rim", `--gazetteer=${gsw}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^map: 80\.8S, 61\.6W$/m);
  assert.equal(/-80\.8|-61\.6/.test(r.out), false, r.out);
  r = await run(["sites", "show", "obsidian-rim", `--gazetteer=${gsw}`, "--json"]);
  assert.equal(r.json().result.mapText, "80.8S, 61.6W");
});

// ── H: jev ping / decide ─────────────────────────────────────────────────────────────────────────────────

await check("H1 jev ping over a fake fetch: exit 0, pYes/model/cost printed, key never printed; no key → 2; 401 → 2", async () => {
  let r = await run(["jev", "ping"], { env: { OPENROUTER_API_KEY: KEY } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ok: pYes 0\.970 · typesafe\/jev-1\.13/);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  r = await run(["jev", "ping"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no JEV key/);
  r = await run(["jev", "ping"], { env: { OPENROUTER_API_KEY: KEY }, fetch: makeFetch({ jev: "auth" }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /JEV auth/);
});

await check("H2 jev decide: answers + usage printed, never the state or the key; --dry-run; invalid questions → 1", async () => {
  const questions = JSON.stringify({
    risk: { type: "score", instructions: "How close is the camera to hitting something?", criteria: ["open", "tight but manageable", "about to hit"] },
    maneuver: { type: "choice", instructions: "Pick a maneuver.", criteria: { hold_path: "keep flying the path", rise: "climb when the space above is open" } },
  });
  const state = JSON.stringify({ obstacles: { ahead: "near tree" }, marker: STATE_MARKER });
  const fetch = makeFetch();
  let r = await run(["jev", "decide", `--state=${state}`, `--questions=${questions}`], { env: { OPENROUTER_API_KEY: KEY }, fetch });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /risk: score 0\.400/);
  assert.match(r.out, /maneuver: hold_path/);
  assert.ok(!r.out.includes(STATE_MARKER) && !r.err.includes(STATE_MARKER), "state printed");
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  assert.ok(JSON.parse(fetch.calls.at(-1).body).state.marker === STATE_MARKER, "state sent to the API");
  const qf = path.join(TMP, "q.json");
  fs.writeFileSync(qf, questions);
  r = await run(["jev", "decide", "--questions=q.json", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /questions valid: risk, maneuver/);
  r = await run(["jev", "decide", '--questions={"x":{"type":"choice","instructions":"one option","criteria":{"a":"only"}}}', "--dry-run", "--json"]);
  assert.equal(r.code, 1);
  assert.ok(r.json().result.issues.length > 0);
  r = await run(["jev", "decide", "--dry-run"]);
  assert.equal(r.code, 2);
});

// A fake JEV client for `jev task` (deps.createJevClient): records every decide() and answers each question type;
// `mode` switches to a network or auth failure.
function fakeJevClientFactory() {
  const f = { created: [], decides: [], mode: "ok", closed: 0 };
  f.create = (opts) => {
    f.created.push({ keyOk: opts.apiKey === KEY, budget: opts.budget });
    return {
      async decide(req) {
        f.decides.push(structuredClone(req));
        if (f.mode === "network") throw new JevError("network", "network error: ECONNRESET");
        if (f.mode === "auth") throw new JevError("auth", "No auth credentials found");
        const answers = {};
        for (const [id, q] of Object.entries(req.questions)) {
          if (q.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
          else if (q.type === "score") answers[id] = { type: "score", score: 3.2, confidence: 0.85, probabilities: { 3: 0.85 } };
          else {
            const keys = Object.keys(q.criteria);
            const pick = keys[1] ?? keys[0]; // NOT the first option, so a JEV answer differs from the code default
            answers[id] = { type: "choice", choice: pick, confidence: 0.92, probabilities: { [pick]: 0.92 } };
          }
        }
        return { id: "gen-task", model: "typesafe/jev-1.13", ms: 12, usage: { costUsd: 0.000003 }, answers };
      },
      close() {
        f.closed++;
      },
    };
  };
  return f;
}

await check("H3 jev task pick / keep / site-fit / family: injected client decides; no key or --code → the code verdict (source 'code')", async () => {
  const f = fakeJevClientFactory();
  const withKey = { env: { OPENROUTER_API_KEY: KEY }, deps: { createJevClient: f.create } };
  const pickIn = JSON.stringify({ intent: { framing: "MS", angle: "eye" }, candidates: [{ id: "a", words: "camera 6 m south; subject clear" }, { id: "b", words: "camera 3 m west; subject partly hidden" }] });
  // pick with a key: JEV's choice + band; the code verdict rides along
  let r = await run(["jev", "task", "pick", `--input=${pickIn}`, "--json"], withKey);
  assert.equal(r.code, 0, r.err);
  let res = r.json().result;
  assert.deepEqual([res.task, res.source, res.result.choice, res.result.band, res.keySource], ["pick", "jev", "b", "act", "env:OPENROUTER_API_KEY"]);
  assert.deepEqual([res.code.choice, res.code.source, res.code.band], ["a", "code", "confirm"]);
  assert.equal(f.decides.length, 1);
  assert.deepEqual(Object.keys(f.decides[0].questions.candidate.criteria), ["a", "b"]);
  assert.match(f.decides[0].sessionId, /^film-task-pick-/);
  assert.ok(f.created[0].keyOk);
  // pick without a key: the code verdict, no client built
  r = await run(["jev", "task", "pick", `--input=${pickIn}`], { deps: { createJevClient: f.create } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pick: a · band confirm · code/);
  assert.equal(f.created.length, 1);
  // --code with a key: no API call
  r = await run(["jev", "task", "pick", `--input=${pickIn}`, "--code", "--json"], withKey);
  assert.equal(r.json().result.source, "code");
  assert.equal(f.decides.length, 1);
  // a scout metrics.json is worded as `scout --pick` words it (description, else flattened metrics); numeric ids
  // travel as positional option keys and come back as the candidate ids
  const metrics = path.join(TMP, "stills-metrics.json");
  fs.writeFileSync(metrics, JSON.stringify({ shotId: "s1", technique: "classic.static", count: 2, intent: { framing: "MS" }, candidates: [
    { index: 0, id: 0, description: "high angle from the roof", metrics: { clearance: 9 }, still: "cand-0.jpg" },
    { index: 1, id: 1, metrics: { clearance: 3 } },
  ] }));
  r = await run(["jev", "task", "pick", `--input=${metrics}`, "--json"], withKey);
  assert.equal(r.code, 0, r.err);
  res = r.json().result;
  assert.deepEqual([res.source, res.result.choice, res.code.choice], ["jev", "1", "0"]);
  assert.deepEqual(f.decides.at(-1).questions.candidate.criteria, { c1: "high angle from the roof", c2: "clearance: 3" });

  // keep: a saved CLI take report goes through shoot's judgeInput; RETAKE → exit 1
  const rep = path.join(TMP, "task-report.json");
  fs.writeFileSync(rep, JSON.stringify({ shotId: "s1", frames: 10, expectedFrames: 10, technique: "classic.static", page: { safety: { adjustedFrames: 10 }, obstruction: { minVisibleFrac: 1 } } }));
  r = await run(["jev", "task", "keep", `--input=${rep}`]);
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.out, /^RETAKE · pKeep 0\.000 · band act · code/);
  assert.match(r.out, /retake triggers: safety_adjustments is 'many'/);
  r = await run(["jev", "task", "keep", `--input=${rep}`, "--json"], withKey);
  assert.equal(r.code, 0, r.err);
  res = r.json().result;
  assert.deepEqual([res.source, res.result.keep, res.result.band, res.code.keep], ["jev", true, "act", false]);
  assert.equal(f.decides.at(-1).state.take.safety_adjustments, "many");
  // keep from bare facts
  r = await run(["jev", "task", "keep", '--input={"frames":300,"droppedFrames":0,"subjectMinVisibleFrac":0.95}', "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().result.result.keep, true);

  // site-fit: a gazetteer id becomes {name, kind, words}
  const fitIn = JSON.stringify({ line: "lanterns by the lifestone at the market", mood: "warm", site: "holtburg" });
  r = await run(["jev", "task", "site-fit", `--input=${fitIn}`, `--gazetteer=${GAZ}`, "--json"], withKey);
  assert.equal(r.code, 0, r.err);
  res = r.json().result;
  assert.deepEqual([res.source, res.result.level, res.result.band], ["jev", 3, "act"]);
  const st = f.decides.at(-1).state;
  assert.equal(st.site.name, "Holtburg");
  assert.match(st.site.look, /lifestone/);
  r = await run(["jev", "task", "site-fit", `--input=${fitIn}`, `--gazetteer=${GAZ}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^fit: level \d \(.*\) · score \d\.00 · band escalate · code \(lexical hint only\)/);
  r = await run(["jev", "task", "site-fit", '--input={"line":"x y z","site":"atlantis"}', `--gazetteer=${GAZ}`]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no site 'atlantis'/);

  // family: numbers become the words; code = the rule table, JEV = its choice
  const famIn = JSON.stringify({ role: "chorus", energy: 0.9, bpm: 150, lyric: "we fly over the walls" });
  r = await run(["jev", "task", "family", `--input=${famIn}`, "--json"]);
  res = r.json().result;
  assert.deepEqual([res.source, res.result.choice], ["code", "fpv-kinetic"]);
  r = await run(["jev", "task", "family", `--input=${famIn}`, "--json"], withKey);
  res = r.json().result;
  assert.deepEqual([res.source, res.result.choice, res.code.choice], ["jev", "tracking", "fpv-kinetic"]);
  assert.ok(res.result.techniques.includes("classic.tracking-follow"));
  assert.deepEqual(f.decides.at(-1).state.section, { role: "chorus", energy: "very high", tempo: "very fast", lyric: "we fly over the walls" });
  assert.ok(!(r.out + r.err).includes(KEY));
});

await check("H4 jev task: a JEV network failure falls back to the code verdict (warning + jevError); auth → 2; bad input / unknown task → 2", async () => {
  const f = fakeJevClientFactory();
  const withKey = { env: { OPENROUTER_API_KEY: KEY }, deps: { createJevClient: f.create } };
  const famIn = '--input={"role":"intro","energy":0.5,"bpm":100}';
  f.mode = "network";
  let r = await run(["jev", "task", "family", famIn, "--json"], withKey);
  assert.equal(r.code, 0, r.err);
  const res = r.json().result;
  assert.deepEqual([res.source, res.result.choice, res.jevError.kind], ["code", "drone-reveal", "network"]);
  assert.match(r.err, /family via JEV failed \(network: .*\); using the code verdict/);
  f.mode = "auth";
  r = await run(["jev", "task", "family", famIn], withKey);
  assert.equal(r.code, 2);
  assert.match(r.err, /JEV auth/);
  f.mode = "ok";
  const before = f.decides.length;
  r = await run(["jev", "task", "pick", '--input={"candidates":[]}'], withKey);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid pick input: candidates must be a non-empty array/);
  r = await run(["jev", "task", "site-fit", '--input={"line":"","site":{"name":"x"}}'], withKey);
  assert.equal(r.code, 2);
  assert.equal(f.decides.length, before, "invalid input never reaches the API");
  r = await run(["jev", "task", "pick", "--input=[1,2]"]);
  assert.equal(r.code, 2);
  r = await run(["jev", "task", "frobnicate", "--input={}"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /pick, keep, site-fit, family/);
  r = await run(["jev", "task", "pick"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--input=<file\|json> is required/);
});

// ── I: assemble + contact sheet ──────────────────────────────────────────────────────────────────────────

const AS_DIR = path.join(TMP, "asm");
fs.mkdirSync(AS_DIR, { recursive: true });
fs.writeFileSync(path.join(AS_DIR, "plan.json"), JSON.stringify(smallPlan()));
await run(["plan", "compile", path.join(AS_DIR, "plan.json")], { deps: { registry: REG } });
const AS_TL = JSON.parse(fs.readFileSync(path.join(AS_DIR, "timeline.json"), "utf8"));
const SONG_AUDIO = path.join(AS_DIR, "song", "song.mp3");
function writeTakes(skip = []) {
  const takes = {};
  for (const it of AS_TL.items) {
    if (skip.includes(it.shotId)) continue;
    const file = path.join(AS_DIR, "takes", `${it.shotId}.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "take");
    const rep = { shotId: it.shotId, file, fps: AS_TL.fps, frames: it.takeFrames, durationSec: it.takeFrames / AS_TL.fps };
    fs.mkdirSync(path.join(AS_DIR, "reports"), { recursive: true });
    fs.writeFileSync(path.join(AS_DIR, "reports", `${it.shotId}.json`), JSON.stringify(rep));
    takes[it.shotId] = { file, fps: rep.fps, frames: rep.frames, durationSec: rep.durationSec };
  }
  return takes;
}

// The page's prepare summary as scene3d/film/runtime/take_player.js builds it for an overspeeding drone move.
const OVERSPEED_MSG = "the 8 s move peaks at 17.8 m/s over 120 m, but the 'cinema' drone flies ≤ 12 m/s: the flown camera falls behind the planned path and ends short of it; use duration ≥ 11.9 s (or pilot.flightPreset 'fpv')";
const OVERSPEED_FLIGHT = { preset: "cinema", vmax: 12, peakSpeed: 17.8, lengthM: 120, overspeed: true, minDurationSec: 11.9 };
const OVERSPEED_PREP = {
  ok: true,
  fromTable: false,
  validation: { ok: false, counts: { overspeed: 1 }, issues: [{ code: "overspeed", t: null, message: OVERSPEED_MSG, preset: "cinema", vmax: 12, peakSpeed: 17.8, minDurationSec: 11.9 }] },
  flight: OVERSPEED_FLIGHT,
};

await check("H5 (r2-cli) page issues: pageIssuesOf reads validation / flight / warnings defensively; judgeInput hands them to keepOrRetake; jev task keep on a saved report", async () => {
  // absence / malformed blocks → no issue, never a throw
  for (const r of [undefined, null, 42, "x", [], { ok: true }, { validation: null, flight: "garbage", warnings: "nope", issues: 7 },
    { validation: { ok: true, counts: {}, issues: [] }, flight: { preset: "cinema", vmax: 12, overspeed: false } }]) {
    assert.deepEqual(pageIssuesOf(r, "prepare"), [], JSON.stringify(r));
  }
  // prepare's summary: the validation issue (page message kept), merged with its flight block (same overspeed)
  let issues = pageIssuesOf(OVERSPEED_PREP, "prepare");
  assert.deepEqual(issues, [{ code: "overspeed", message: OVERSPEED_MSG, t: null, stages: ["prepare"], preset: "cinema", vmax: 12, peakSpeed: 17.8, lengthM: 120, minDurationSec: 11.9 }]);
  assert.equal(issueLine("s1", issues[0]), `shot s1: prepare issue overspeed: ${OVERSPEED_MSG}`);
  // a take report with only the flight block: a synthesized overspeed naming the minimum duration
  const fromFlight = pageIssuesOf({ ok: true, frames: 80, flight: { ...OVERSPEED_FLIGHT, peakSpeed: null } }, "shoot");
  assert.equal(fromFlight.length, 1);
  assert.match(fromFlight[0].message, /the move is faster than the flight caps over 120 m, but the 'cinema' drone flies ≤ 12 m\/s: .*use duration ≥ 11\.9 s$/);
  assert.equal(fromFlight[0].minDurationSec, 11.9);
  // merged across stages: still one overspeed, every stage listed
  mergeIssues(issues, fromFlight);
  assert.deepEqual([issues.length, issues[0].stages, issues[0].message], [1, ["prepare", "shoot"], OVERSPEED_MSG]);
  // nested holders, t, validation error, ok:false with no listed issue, warnings (strings / objects / junk)
  assert.deepEqual(pageIssuesOf({ prepared: { validation: { ok: false, issues: [{ code: "speed", t: 1.25, message: "speed 90 m/s at 1.25 s" }, null, "loose text"] } } }, "rehearse").map((i) => [i.code, i.t, i.message, i.stages]),
    [["speed", 1.25, "speed 90 m/s at 1.25 s", ["rehearse"]], ["invalid", null, "loose text", ["rehearse"]]]);
  assert.deepEqual(pageIssuesOf({ validation: { ok: false, error: "sample threw" }, warnings: ["intent.light \"golden\" was ignored: no usable sun (night)", null, { message: "odd" }] }, "prepare").map((i) => [i.code, i.message]),
    [["validation-error", "the page could not validate the take: sample threw"], ["warning", "intent.light \"golden\" was ignored: no usable sun (night)"], ["warning", "odd"]]);
  assert.deepEqual(pageIssuesOf({ validation: { ok: false, counts: { jump: 2, nan: 0 }, issues: [] } }, "prepare").map((i) => i.message), ["the take failed validation (jump ×2)"]);
  assert.equal(issueLine("s2", { code: "speed", t: 1.25, message: "fast", stages: ["prepare", "shoot"], minDurationSec: 9 }), "shot s2: prepare/shoot issue speed at t=1.25 s: fast (minimum feasible duration 9 s)");
  assert.deepEqual(flightOf(null, { ok: true }, { preflight: { flight: OVERSPEED_FLIGHT } }), OVERSPEED_FLIGHT);
  assert.equal(flightOf({ ok: true }), null);

  // judgeInput: a CLI take report's issues + its page block's issues and flight reach the keepOrRetake input
  const rep = { shotId: "d1", frames: 80, expectedFrames: 80, technique: "drone.flythrough", issues: pageIssuesOf(OVERSPEED_PREP, "prepare"),
    page: { safety: { adjustedFrames: 0 }, obstruction: { minVisibleFrac: 1 }, flight: OVERSPEED_FLIGHT, warnings: ["fog still settling"] } };
  const inp = judgeInput(rep);
  assert.deepEqual(inp.issues.map((i) => [i.code, i.stages, i.minDurationSec ?? null]), [["overspeed", ["prepare", "shoot"], 11.9], ["warning", ["shoot"], null]]);
  assert.deepEqual(inp.flight, OVERSPEED_FLIGHT);
  assert.deepEqual([inp.frames, inp.droppedFrames, inp.safetyAdjustedFrames, inp.subjectMinVisibleFrac], [80, 0, 0, 1]);
  const plain = judgeInput({ frames: 10, expectedFrames: 10, page: {} });
  assert.deepEqual(["issues" in plain, "flight" in plain], [false, false], "no page issue → no keys");

  // `film jev task keep` on that saved report: the verdict is unchanged by plan issues (a retake cannot fix them),
  // and the JEV request carries only the fixed take words (never the issue text)
  const repFile = path.join(TMP, "issue-report.json");
  fs.writeFileSync(repFile, JSON.stringify(rep));
  let r = await run(["jev", "task", "keep", `--input=${repFile}`, "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  let res = r.json().result;
  assert.deepEqual([res.source, res.result.keep, res.result.band], ["code", true, "act"]);
  const f = fakeJevClientFactory();
  r = await run(["jev", "task", "keep", `--input=${repFile}`, "--json"], { env: { OPENROUTER_API_KEY: KEY }, deps: { createJevClient: f.create } });
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(Object.keys(f.decides.at(-1).state.take).sort(), ["dropped_frames", "pop_in", "safety_adjustments", "shot_kind", "subject_longest_unseen", "subject_min_visibility"]);
  assert.ok(!JSON.stringify(f.decides.at(-1)).includes("overspeed"), "issue text never goes to JEV");
});

await check("H6 jev task pass-plan is registered exactly when lib/jev_tasks.mjs exports PASS_PLAN_CLI (agent-D task; a missing export never breaks the CLI)", async () => {
  const mod = await import("../tools/film/lib/jev_tasks.mjs");
  const r = await run(["jev", "task", "--input={}"]);
  assert.equal(r.code, 2, r.err + r.out);
  const listed = /jev task needs one of pick, keep, site-fit, family(, pass-plan)?/.exec(r.err);
  assert.ok(listed, r.err);
  assert.equal(Boolean(listed[1]), Boolean(mod.PASS_PLAN_CLI && typeof mod.PASS_PLAN_CLI.run === "function"));
});

await check("I1 assemble: ffmpeg argv === assemblyArgv(buildAssembly(...)) (the edl.mjs filter graph), song mapped, EDL written", async () => {
  fs.mkdirSync(path.dirname(SONG_AUDIO), { recursive: true });
  fs.writeFileSync(SONG_AUDIO, "song");
  const takes = writeTakes();
  FF.reset();
  FF.setMode({});
  const lc = lockCalls.length;
  const r = await run(["assemble", path.join(AS_DIR, "timeline.json"), `--song=${SONG_AUDIO}`, "--edl", `--ffmpeg=${FF.file}`]);
  assert.equal(r.code, 0, r.err + r.out);
  const out = path.join(AS_DIR, "edit", "final.mp4");
  const expected = assemblyArgv(buildAssembly(AS_TL, takes, { audioFile: SONG_AUDIO, missing: "error" }), { out, crf: 16 });
  const calls = FF.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], expected);
  const fc = calls[0][calls[0].indexOf("-filter_complex") + 1];
  assert.match(fc, /xfade=transition=fade:duration=0\.5/); // s3 dissolves in
  // s1|s2 is a cut run: its concat output is re-timed to 1/fps so the xfade inputs share one time base (real
  // ffmpeg 7 rejects 1/1000000 vs 1/10 — the 2026-10-13 smoke); the CLI passes that graph through unchanged.
  assert.match(fc, /\[e0\]\[e1\]concat=n=2:v=1:a=0,settb=1\/10\[r0\];\[r0\]\[e2\]xfade=/);
  for (const flag of ["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest"]) assert.ok(calls[0].includes(flag), flag);
  assert.equal(fs.readFileSync(path.join(AS_DIR, "edit", "final.edl"), "utf8"), toCmx3600(AS_TL, takes, { title: AS_TL.title }));
  assert.ok(fs.existsSync(out));
  assert.equal(lockCalls.length, lc + 1);
  assert.equal(lockCalls.at(-1).label, "film assemble");
  assert.equal(lockCalls.at(-1).released, true);
});

await check("I2 assemble: a missing take → exit 1 (TAKES_MISSING); --missing=black fills; --dry-run runs nothing; --no-audio", async () => {
  fs.rmSync(path.join(AS_DIR, "takes"), { recursive: true, force: true });
  fs.rmSync(path.join(AS_DIR, "reports"), { recursive: true, force: true });
  const takes = writeTakes(["s2"]);
  FF.reset();
  let r = await run(["assemble", path.join(AS_DIR, "timeline.json"), `--ffmpeg=${FF.file}`, "--no-audio"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /s2/);
  assert.equal(FF.calls().length, 0);
  r = await run(["assemble", path.join(AS_DIR, "timeline.json"), `--ffmpeg=${FF.file}`, "--missing=black", "--no-audio", "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.err);
  const res = r.json().result;
  assert.equal(res.dryRun, true);
  assert.equal(FF.calls().length, 0);
  const noSong = { ...AS_TL, song: AS_TL.song ? { ...AS_TL.song, file: null } : null };
  const expected = assemblyArgv(buildAssembly(noSong, takes, { audioFile: null, missing: "black" }), { out: path.join(AS_DIR, "edit", "final.mp4"), crf: 16 });
  assert.deepEqual(res.argv.slice(1), expected);
  assert.ok(!expected.includes("-c:a"));
  assert.match(expected[expected.indexOf("-filter_complex") + 1], /color=c=black/);
  writeTakes();
});

await check("I2b plan compile + assemble --dry-run with a silent tail (edit.tail): the song is cut + faded at musicEnd and padded (apad=whole_dur), element-local fades, -shortest kept, totalSec includes the tail", async () => {
  const dir = path.join(TMP, "asm-tail");
  fs.mkdirSync(dir, { recursive: true });
  const plan = smallPlan({
    edit: { fadeOutSec: 1, tail: { from: "t1", gapSec: 1.5, fadeOutSec: 0.5 } },
    shots: [
      { id: "s1", site: "holtburg", technique: "classic.static", duration: { sec: 2 }, standingOrder: "Hold still and keep 3 m from walls." },
      { id: "s2", site: "holtburg", technique: "classic.static", duration: { sec: 2 }, transition: "dissolve", standingOrder: "Hold still again." },
      { id: "t1", site: "dungeon", technique: "fpv.fpv-corridor", duration: { sec: 3 }, transition: { type: "fade", durationSec: 1 }, route: { fromCell: "0x01F60289", toCell: "0x01F6027A" }, standingOrder: "Fly the corridor, 1 m from walls." },
      { id: "t2", site: "holtburg", technique: "classic.static", duration: { sec: 2 }, transition: "dissolve", standingOrder: "Hold still at the end." },
    ],
  });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  let r = await run(["plan", "compile", path.join(dir, "plan.json")], { deps: { registry: REG } });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /music part ends at 4\.00 s \(frame 40, fade-out 1 s\); silent tail 6\.50 s incl\. the black gap/);
  const tl = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8"));
  assert.deepEqual(tl.musicEnd, { sec: 4, frame: 40, fadeOutSec: 1 });
  assert.equal(tl.frames, 105, "40 music + 15 black + 30 + 20");
  const takes = {};
  for (const it of tl.items) {
    const file = path.join(dir, "takes", `${it.shotId}.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "take");
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reports", `${it.shotId}.json`), JSON.stringify({ shotId: it.shotId, file, fps: tl.fps, frames: it.takeFrames, durationSec: it.takeFrames / tl.fps }));
    takes[it.shotId] = { file, fps: tl.fps, frames: it.takeFrames, durationSec: it.takeFrames / tl.fps };
  }
  const song = path.join(dir, "song.mp3");
  fs.writeFileSync(song, "song");
  FF.reset();
  r = await run(["assemble", path.join(dir, "timeline.json"), `--song=${song}`, `--ffmpeg=${FF.file}`, "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(FF.calls().length, 0, "dry run");
  const res = r.json().result;
  assert.equal(res.totalSec, 10.5, "the program includes the gap and the tail");
  assert.equal(res.totalFrames, 105);
  assert.deepEqual(res.musicEnd, { sec: 4, frame: 40, fadeOutSec: 1, tailSec: 6.5 });
  const argv = res.argv.slice(1);
  assert.deepEqual(argv, assemblyArgv(buildAssembly(tl, takes, { audioFile: song, missing: "error" }), { out: path.join(dir, "edit", "final.mp4"), crf: 16 }));
  const fc = argv[argv.indexOf("-filter_complex") + 1];
  assert.match(fc, /\[4:a\]atrim=duration=4,asetpts=PTS-STARTPTS,afade=t=out:st=3:d=1,apad=whole_dur=10\.5\[aout\]$/);
  // element-local: the last music take fades out in its own chain (22 frames fed: 2 dissolve frames + 20 edit), the
  // first tail take fades in from black in its own chain; the black gap is its own filler (fps'd: the graph xfades)
  assert.match(fc, /\[1:v\]trim=start_frame=3:end_frame=25,setpts=PTS-STARTPTS,fps=10,scale=64:36:flags=lanczos,setsar=1,format=yuv420p,fade=t=out:start_frame=12:nb_frames=10:color=black\[e1\]/);
  assert.match(fc, /color=c=black:s=64x36:r=10,trim=end_frame=15,setpts=PTS-STARTPTS,fps=10,setsar=1,format=yuv420p\[e2\]/);
  assert.match(fc, /\[2:v\]trim=start_frame=0:end_frame=33,setpts=PTS-STARTPTS,fps=10,scale=64:36:flags=lanczos,setsar=1,format=yuv420p,fade=t=in:start_frame=0:nb_frames=10:color=black\[e3\]/);
  // the program fade-out is the tail's (0.5 s) on the very end; no global fade at the music end
  assert.match(fc, /fade=t=out:start_frame=100:nb_frames=5:color=black,format=yuv420p\[vout\]/);
  assert.equal((fc.match(/fade=t=out:start_frame=/g) || []).length, 2, "one element-local, one program fade-out");
  assert.ok(argv.includes("-shortest"), "the padded audio is as long as the picture, so -shortest cuts nothing");
  // the same timeline without --song: no audio chain at all
  r = await run(["assemble", path.join(dir, "timeline.json"), "--no-audio", `--ffmpeg=${FF.file}`, "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.json().result.argv.join(" ").includes("apad"));
  // the human summary names the music part and the silent tail
  r = await run(["assemble", path.join(dir, "timeline.json"), `--song=${song}`, `--ffmpeg=${FF.file}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /with song\) — music 4\.00 s, then 6\.50 s silent tail/);
});

await check("I3 contact-sheet: N = ⌊frames / tiles⌋; exact -vf; frames from --frames or the take report (no ffprobe)", async () => {
  assert.equal(everyNth(48, 4, 4), 3);
  assert.equal(everyNth(10, 4, 4), 1);
  assert.equal(everyNth(0, 4, 4), 1);
  const cs = contactSheetArgv({ input: "/p/takes/s1.mp4", frames: 160, cols: 4, rows: 4, width: 1920 });
  assert.deepEqual(cs.argv, ["-hide_banner", "-y", "-i", "/p/takes/s1.mp4", "-vf", "select='not(mod(n\\,10))',scale=480:-1,tile=4x4", "-frames:v", "1", "-q:v", "3", "/p/takes/s1.contact.jpg"]);
  assert.throws(() => contactSheetArgv({ input: "/x.mp4", frames: 1, cols: 0 }), /--cols/);
  FF.reset();
  const take = path.join(AS_DIR, "takes", "s1.mp4");
  let r = await run(["contact-sheet", take, `--ffmpeg=${FF.file}`, "--frames=48", "--cols=3", "--rows=2", "--width=960"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(FF.calls()[0], ["-hide_banner", "-y", "-i", take, "-vf", "select='not(mod(n\\,8))',scale=320:-1,tile=3x2", "-frames:v", "1", "-q:v", "3", path.join(AS_DIR, "takes", "s1.contact.jpg")]);
  FF.reset();
  r = await run(["contact-sheet", take, `--ffmpeg=${FF.file}`, "--json"]);
  assert.equal(r.code, 0, r.err);
  const res = r.json().result;
  assert.equal(res.framesFrom, "take report");
  assert.equal(res.frames, AS_TL.items[0].takeFrames);
  r = await run(["contact-sheet", path.join(TMP, "none.mp4"), `--ffmpeg=${FF.file}`]);
  assert.equal(r.code, 2);
});

await check("I4 muxArgv per take kind and parseFfmpegList separators (------ / --- / --)", () => {
  assert.deepEqual(muxArgv({ kind: "avc", input: "/t/s1.h264", output: "/t/s1.mp4", fps: 30 }), ["-hide_banner", "-y", "-r", "30", "-i", "/t/s1.h264", "-c", "copy", "-movflags", "+faststart", "/t/s1.mp4"]);
  assert.deepEqual(muxArgv({ kind: "vp9", input: "/t/s1.ivf", output: "/t/s1.webm", fps: 30, container: "webm" }), ["-hide_banner", "-y", "-i", "/t/s1.ivf", "-c", "copy", "/t/s1.webm"]);
  // tooling-7: every libx264 re-encode crops to even dimensions (top-left), so an odd canvas (1280×633) still muxes
  const EVEN = "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0";
  assert.equal(EVEN_CROP_FILTER, EVEN);
  assert.deepEqual(muxArgv({ kind: "vp9", input: "/t/s1.ivf", output: "/t/s1.mp4", fps: 30 }), ["-hide_banner", "-y", "-i", "/t/s1.ivf", "-vf", EVEN, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14", "-r", "30", "-movflags", "+faststart", "/t/s1.mp4"]);
  assert.deepEqual(muxArgv({ kind: "frames", input: "/t/s1.frames", output: "/t/s1.mp4", fps: 24 }), ["-hide_banner", "-y", "-framerate", "24", "-start_number", "0", "-i", "/t/s1.frames/%06d.jpg", "-vf", EVEN, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14", "-movflags", "+faststart", "/t/s1.mp4"]);
  // the crop sits after the input and before the encoder; stream-copy paths never filter
  for (const kind of ["frames", "vp9"]) {
    const a = muxArgv({ kind, input: "/t/in", output: "/t/o.mp4", fps: 30 });
    assert.ok(a.indexOf("-i") < a.indexOf("-vf") && a.indexOf("-vf") < a.indexOf("-c:v"), kind);
  }
  assert.equal(muxArgv({ kind: "avc", input: "/t/s1.h264", output: "/t/s1.mp4", fps: 30 }).includes("-vf"), false);
  assert.equal(muxArgv({ kind: "vp9", input: "/t/s1.ivf", output: "/t/s1.webm", fps: 30, container: "webm" }).includes("-vf"), false);
  // the filter expression itself: even sizes stay, odd ones lose their last row/column
  const evalCrop = (iw, ih) => EVEN.replace(/^crop=/, "").split(":").slice(0, 2).map((ex) => Function("iw", "ih", "trunc", `return ${ex};`)(iw, ih, Math.trunc));
  assert.deepEqual(evalCrop(1280, 633), [1280, 632]);
  assert.deepEqual(evalCrop(1280, 634), [1280, 634]);
  assert.deepEqual(evalCrop(65, 37), [64, 36]);
  assert.throws(() => muxArgv({ kind: "gif", input: "a", output: "b", fps: 1 }), /unknown take kind/);
  assert.deepEqual([...parseFfmpegList(" x\n --\n D  h264  raw\n DE mov,mp4 QT\n")], ["h264", "mov", "mp4"]);
});

// ── J: help, unknown command, JSON envelopes, secret scan ────────────────────────────────────────────────

await check("J1 --help (general and per command) → 0; unknown command → 2; --json error envelope", async () => {
  let r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: node tools\/film\/film\.mjs <command>/);
  for (const cmd of [["doctor"], ["project", "init"], ["techniques"], ["song", "analyze"], ["sites", "build"], ["sites", "search"], ["sites", "show"], ["plan", "validate"], ["plan", "compile"], ["jev", "ping"], ["jev", "decide"], ["jev", "task"], ["browser", "check"], ["boot"], ["status"], ["go"], ["scout"], ["rehearse"], ["shoot"], ["assemble"], ["contact-sheet"], ["run"]]) {
    r = await run([...cmd, "--help"]);
    assert.equal(r.code, 0, cmd.join(" "));
    assert.match(r.out, /usage: film /, cmd.join(" "));
  }
  r = await run(["frobnicate"]);
  assert.equal(r.code, 2);
  r = await run(["plan", "validate", "--json"]);
  assert.equal(r.code, 2);
  const env = r.json();
  assert.deepEqual([env.ok, env.command, env.exitCode], [false, "plan validate", 2]);
  r = await run(["boot", "--help", "--json"]);
  assert.equal(r.json().command, "boot");
});

await check("J2 no output stream and no file written under the temp tree contains the key, the password or the state", async () => {
  // Exercise the password path of an offline command too: an unknown --password must never echo.
  const r = await run(["plan", "validate", path.join(TMP, "nope.json"), `--password=${PASSWORD}`], { env: { FILM_PASSWORD: PASSWORD } });
  assert.equal(r.code, 2);
  const secrets = [KEY, PASSWORD, encodeURIComponent(PASSWORD), STATE_MARKER];
  for (const text of ALL_OUTPUT) for (const s of secrets) assert.ok(!text.includes(s), `secret in output: ${s}`);
  const skip = new Set([path.join(TMP, "home-unsafe", ".config", "holtburger-film", "openrouter.key")]);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!skip.has(p) && e.name !== "ffmpeg") {
        const text = fs.readFileSync(p, "latin1");
        for (const s of secrets) assert.ok(!text.includes(s), `secret in ${p}`);
      }
    }
  };
  walk(TMP);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nfilm cli: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
