// tests/hb_v2.test.mjs — harness v2 (round 3 R3-0, 2026-10-30): the pure parts of hbbench.mjs /
// lib/hb_v2.mjs and the page instruments of lib/hb_page.mjs against fakes. No browser, no ssh.
//   node scripts/perf-worker/tests/hb_v2.test.mjs        (any cwd)
// Pins: v1-compat URL byte-identical to the pre-v2 hbbench URL for the existing arms files; the v2
// pins (skytime=13, renderScale=1, targetFps=0, adaptiveRes=off; the governor pin once its flag is documented) and arm overrides;
// the DayGroup LCG against retail's (values cross-checked in python); window plans; frameStats equal
// to the pre-v2 stats(); heading math + 12-sector bins; the box-sample script/parser; arms from a
// queue file (and every item of the M1 queue plans without error); the run-JSON asserts; the probe's
// per-frame counts, walks, empty passes, nesting and restore; whole-pass GPU timers never nested; the
// owner census distance buckets; the GL census; the pin read-back; the marked windows; the kill
// discipline of every launching tool (tools/webgpu_probe/run.mjs included; Ctrl-C kills BEFORE exit);
// the B0 snapshot check, with the queue's real reader patterns failing on the HEAD-95240def tree (git).
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PW = join(HERE, "..");

// NO BOX CONTACT, EVER: an `ssh` on PATH ahead of the real one that records the attempt and fails at
// once. The drivers' side effects are injected fakes in this suite; a path that still reaches
// lib/hb_box.mjs's ssh fails the last check instead of trying the 1070.
import { mkdtempSync as _mkdtemp, writeFileSync as _wf, chmodSync as _chmod } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
const SSH_GUARD = _mkdtemp(join(_tmpdir(), "hbv2-noss-"));
const SSH_LOG = join(SSH_GUARD, "ssh-attempts.log");
_wf(join(SSH_GUARD, "ssh"), `#!/bin/sh\necho "$@" >> '${SSH_LOG}'\necho "hb_v2.test: ssh blocked" >&2\nexit 255\n`);
_chmod(join(SSH_GUARD, "ssh"), 0o755);
process.env.PATH = `${SSH_GUARD}:${process.env.PATH}`;
{ // the guard itself: `ssh` now resolves to it, fails, and is logged (then the log starts empty)
  const { spawnSync } = await import("node:child_process");
  const g = spawnSync("ssh", ["hb-guard-selftest"], { encoding: "utf8" });
  if (g.status !== 255 || !/ssh blocked/.test(g.stderr || "")) { console.log("[FAIL] ssh guard not in effect: refusing to run the suite"); process.exit(1); }
  _wf(SSH_LOG, "");
}
const QUEUE = join(PW, "../../apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json");

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`[FAIL] ${name}\n       ${String(e && e.stack || e).split("\n").slice(0, 8).join("\n       ")}`); }
}

// Each module is imported on its own so a missing or side-effecting module fails ITS checks, not the
// file: the pre-v2 hbbench.mjs ran its whole bench at import (readFileSync(--arms) threw first).
const tryImport = async (rel) => { try { return { m: await import(join(PW, rel)) }; } catch (e) { return { err: e }; } };
const I = { v2: await tryImport("lib/hb_v2.mjs"), page: await tryImport("lib/hb_page.mjs"), bench: await tryImport("hbbench.mjs") };
const V2 = I.v2.m || {}, PAGE = I.page.m || {}, BENCH = I.bench.m || {};
const { uncappedBenchUrl } = await import(join(PW, "lib/bench-url.mjs"));

await check("modules import without side effects (hbbench.mjs runs nothing unless it is the entry point)", () => {
  for (const [k, r] of Object.entries(I)) assert.ok(!r.err, `${k}: ${r.err && r.err.message}`);
  for (const f of ["parseArgs", "planArm"]) assert.equal(typeof BENCH[f], "function", `hbbench.mjs exports ${f}`);
});

// ------------------------------------------------------------------------------------------
// URL building
// ------------------------------------------------------------------------------------------
const PORT = "8766";
const APP = `http://127.0.0.1:${PORT}/apps/holtburger-web/index.html`;
// The pre-v2 hbbench.mjs URL (git 95240def hbbench.mjs:78), verbatim.
const v1Url = (arm) => uncappedBenchUrl(`${APP}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=${arm.quality || "mid"}${arm.flags ? "&" + arm.flags : ""}`);

await check("compat v1: every arm of the existing arms files plans the pre-v2 URL byte for byte", () => {
  for (const f of ["arms-rc-rust-scene-core.json", "arms-rc-rust-scene-core-v2.json", "arms-rc-bisect.json"]) {
    const arms = V2.loadArms(JSON.parse(readFileSync(join(PW, f), "utf8")));
    for (const a of arms) {
      const p = BENCH.planArm(a, { port: PORT, compat: "v1" });
      assert.equal(p.url, v1Url(a), `${f} ${a.name}`);
      assert.deepEqual(p.window, { outer: "1280,720", target: null });
      assert.equal(p.orbitDegPerSec, 12);
      assert.equal(p.probe, false);
      assert.equal(p.dayGroup, null);
    }
  }
});

await check("v2: skytime=13, renderScale=1, targetFps=0, adaptiveRes=off pinned after the arm's flags (governor once documented)", () => {
  const p = BENCH.planArm({ name: "a", quality: "ultra", flags: "drawExec=off" }, { port: PORT });
  assert.equal(p.url, `${APP}?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=ultra&drawExec=off&skytime=13&renderScale=1&targetFps=0`);
  assert.deepEqual(V2.urlPinProblems(p.pins), []);
  // R3-11 lands: url-flags.md gets a gpuGovernor row -> every URL pins it off, and its absence is a problem
  const KEY = ["gpu", "Governor"].join("");
  assert.equal(V2.governorFlagDocumented("| `" + KEY + "` | off | ..."), true);
  assert.equal(V2.governorFlagDocumented("| `skytime` | ..."), false);
  const g = BENCH.planArm({ name: "a", quality: "ultra", flags: "drawExec=off" }, { port: PORT, governorFlag: true });
  assert.deepEqual(V2.urlParams(g.url).getAll(KEY), ["off"]);
  assert.ok(g.url.indexOf(KEY) < g.url.indexOf("targetFps"));
  assert.deepEqual(V2.urlPinProblems(g.pins, { governorFlag: true }), []);
  assert.ok(V2.urlPinProblems(p.pins, { governorFlag: true }).some((x) => x.startsWith(KEY)));
  assert.equal(typeof BENCH.detectGovernorFlag(), "boolean");
  assert.deepEqual(p.pins.armOverride, []);
  assert.equal(p.orbitDegPerSec, 18);
  assert.equal(p.probe, true);
});

await check("v2: an arm that names a pin keeps its own value, once, and the assert lists it as an override", () => {
  const p = BENCH.planArm({ name: "a", quality: "ultra", flags: ["skytime=22", "targetFps=30", ["gpu", "Governor=on"].join("")].join("&") }, { port: PORT });
  const q = V2.urlParams(p.url);
  assert.deepEqual(q.getAll("skytime"), ["22"]);
  assert.deepEqual(q.getAll("targetFps"), ["30"]);
  assert.deepEqual(q.getAll("gpuGovernor"), ["on"]);
  assert.deepEqual(p.pins.armOverride.sort(), ["gpuGovernor", "skytime", "targetFps"]);
  assert.deepEqual(V2.urlPinProblems(p.pins), []);
  const s = BENCH.planArm({ name: "b", quality: "ultra", flags: "", skytime: 22 }, { port: PORT });
  assert.deepEqual(V2.urlParams(s.url).getAll("skytime"), ["22"]);
  const cli = BENCH.planArm({ name: "c", quality: "ultra" }, { port: PORT, skytime: 8 });
  assert.deepEqual(V2.urlParams(cli.url).getAll("skytime"), ["8"]);
});

await check("urlPinProblems flags a v1 URL judged as v2, and a missing nosw", () => {
  const p = V2.urlPins(v1Url({ quality: "ultra", flags: "" }), { flags: "" });
  const bad = V2.urlPinProblems(p);
  assert.ok(bad.some((x) => /renderScale/.test(x)) && bad.some((x) => /skytime/.test(x)), bad.join("; "));
  assert.deepEqual(V2.urlPinProblems(p, { compat: "v1" }), []);
  const nos = V2.urlPins(`${APP}?targetFps=0&adaptiveRes=off`, {});
  assert.ok(V2.urlPinProblems(nos, { compat: "v1" }).some((x) => /nosw/.test(x)));
});

await check("redactUrl hides the password", () => {
  assert.equal(V2.redactUrl("http://x/i.html?account=a&password=secret&quality=ultra"), "http://x/i.html?account=a&password=***&quality=ultra");
});

// ------------------------------------------------------------------------------------------
// DayGroup
// ------------------------------------------------------------------------------------------
await check("calcPresentDayGroup = retail's LCG (u32 wrap; reference values from an independent python port)", () => {
  assert.equal(V2.calcPresentDayGroup(39, 10), 0);
  assert.equal(V2.calcPresentDayGroup(0, 0), 10);
  assert.equal(V2.calcPresentDayGroup(1, 10), 5);
  assert.equal(V2.calcPresentDayGroup(3, 10), 1);
  assert.equal(V2.calcPresentDayGroup(1, 2), 16);
  for (let d = 1; d <= 360; d++) { const i = V2.calcPresentDayGroup(d, 12); assert.ok(i >= 0 && i < 20); }
});

await check("dayYearForGroup finds a (day, year) for every DayGroup; the v2 default is index 0 'Sunny'", () => {
  for (let i = 0; i < 20; i++) { const r = V2.dayYearForGroup(i); assert.ok(r, `index ${i}`); assert.equal(V2.calcPresentDayGroup(r.day, r.year), i); }
  assert.deepEqual(V2.dayYearForGroup(0), { day: 39, year: 10, index: 0 });
  const p = BENCH.planArm({ name: "a", quality: "ultra" }, { port: PORT });
  assert.deepEqual(p.dayGroup, { day: 39, year: 10, index: 0, datName: "Sunny" });
  assert.equal(BENCH.planArm({ name: "a", dayGroup: "none" }, { port: PORT }).dayGroup, null);
  assert.throws(() => BENCH.planArm({ name: "a", dayGroup: 20 }, { port: PORT }));
});

// ------------------------------------------------------------------------------------------
// Window, args
// ------------------------------------------------------------------------------------------
await check("window: v2 default 1920x1080 INNER target, per-arm override, bad sizes rejected", () => {
  assert.deepEqual(BENCH.planArm({ name: "a" }, { port: PORT }).window, { outer: "1920,1080", target: { w: 1920, h: 1080 } });
  assert.deepEqual(BENCH.planArm({ name: "a", window: "1280,720" }, { port: PORT }).window, { outer: "1280,720", target: { w: 1280, h: 720 } });
  assert.deepEqual(BENCH.planArm({ name: "a" }, { port: PORT, window: "1600x900" }).window.target, { w: 1600, h: 900 });
  assert.throws(() => V2.parseWindow("1920,1080&calc"));
  assert.throws(() => V2.parseWindow("10,10"));
});

await check("parseArgs: defaults as before, --compat only v1", () => {
  const a = BENCH.parseArgs(["--arms", "x.json"]);
  assert.equal(a.reps, 2); assert.equal(a.port, "8766"); assert.equal(a.tour, "poi:Shoushi"); assert.equal(a.hold, 35000); assert.equal(a.compat, null);
  assert.equal(BENCH.parseArgs(["--compat", "v1"]).compat, "v1");
  assert.throws(() => BENCH.parseArgs(["--compat", "v3"]));
});

// ------------------------------------------------------------------------------------------
// frame stats
// ------------------------------------------------------------------------------------------
// The pre-v2 hbbench.mjs stats(), verbatim.
function oldStats(d) {
  if (!d || !d.length) return null;
  const s = [...d].sort((a, b) => a - b), n = s.length, sum = d.reduce((a, b) => a + b, 0);
  const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(1);
  const lowOf = (f) => { const w = s.slice(Math.floor(n * (1 - f))); return +(1000 / (w.reduce((a, b) => a + b, 0) / w.length)).toFixed(1); };
  return { n, fps: +(n / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[n - 1].toFixed(0), low1: lowOf(0.01), low01: lowOf(0.001),
    h50: d.filter((x) => x > 50).length, h100: d.filter((x) => x > 100).length, h250: d.filter((x) => x > 250).length,
    jankMs: Math.round(d.filter((x) => x > 50).reduce((a, x) => a + x - 33.3, 0)) };
}
await check("frameStats is the pre-v2 stats() (same fields, same rounding)", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 20; k++) {
    const d = Array.from({ length: 50 + k * 37 }, () => 8 + rnd() * 40 + (rnd() < 0.02 ? 300 : 0));
    assert.deepEqual(V2.frameStats(d), oldStats(d));
  }
  assert.equal(V2.frameStats([]), null);
});

// ------------------------------------------------------------------------------------------
// heading
// ------------------------------------------------------------------------------------------
// three Y-up; AC (x, y, z) -> three (x, z, -y). lookAt's matrixWorld column 2 = normalize(eye - target).
function camMatrix(eyeAc, targetAc) {
  const t = (p) => [p[0], p[2], -p[1]];
  const e = t(eyeAc), g = t(targetAc);
  const z = [e[0] - g[0], e[1] - g[1], e[2] - g[2]];
  const l = Math.hypot(...z);
  const m = new Array(16).fill(0); m[8] = z[0] / l; m[9] = z[1] / l; m[10] = z[2] / l;
  return m;
}
await check("headingFromMatrix: AC degrees clockwise from north; __cam.orbit(az) looks at az+180", () => {
  const near = (a, b) => Math.abs(((a - b + 540) % 360) - 180) < 1e-6;
  assert.ok(near(V2.headingFromMatrix(...[camMatrix([0, -10, 0], [0, 0, 0])].map((m) => [m[8], m[10]])[0]), 0)); // looking north
  assert.ok(near(V2.headingFromMatrix(...[camMatrix([-10, 0, 0], [0, 0, 0])].map((m) => [m[8], m[10]])[0]), 90)); // east
  for (const az of [0, 45, 90, 135, 200, 315]) {
    const r = (az * Math.PI) / 180, el = (22 * Math.PI) / 180, h = Math.cos(el) * 70;
    const m = camMatrix([h * Math.sin(r), h * Math.cos(r), Math.sin(el) * 70], [0, 0, 0]);
    assert.ok(near(V2.headingFromMatrix(m[8], m[10]), (az + 180) % 360), `az ${az}`);
  }
  assert.ok(Number.isNaN(V2.headingFromMatrix(0, 0)));
});

await check("binByHeading: 12 sectors, sector-mean weights every covered heading once, NaN yaw skipped", () => {
  const frames = [];
  for (let i = 0; i < 90; i++) frames.push({ yaw: 10, calls: 100 }); // sector 0, long dwell
  for (let i = 0; i < 10; i++) frames.push({ yaw: 95, calls: 300 }); // sector 3
  frames.push({ yaw: NaN, calls: 9999 });
  const b = V2.binByHeading(frames, ["calls"], 12);
  assert.equal(b.covered, 2); assert.equal(b.noYaw, 1); assert.equal(b.frames, 100);
  assert.equal(b.sectorMean.calls, 200); assert.equal(b.frameMean.calls, 120);
  assert.equal(b.sectors[0].calls, 100); assert.equal(b.sectors[3].calls, 300); assert.equal(b.sectors[5].frames, 0);
  assert.equal(V2.sectorOf(359.99), 11); assert.equal(V2.sectorOf(360), 0); assert.equal(V2.sectorOf(-30), 11);
});

// ------------------------------------------------------------------------------------------
// box sample
// ------------------------------------------------------------------------------------------
await check("box sample: encoded command fits cmd.exe, names hbwho.ps1 and the hbbench profile rule", () => {
  const s = V2.boxSampleScript();
  const b64 = V2.encodePowerShell(s);
  const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
  assert.ok(cmd.length < 7500, `length ${cmd.length}`);
  assert.equal(Buffer.from(b64, "base64").toString("utf16le"), s);
  assert.match(s, /D:\\Temp\\hbbench\\hbwho\.ps1/);
  assert.match(s, /\*D:\\Temp\\hbbench\\\*/);
  assert.match(s, /HBWHO/); assert.match(s, /HBTOP/);
  assert.ok(!/[\u0080-\uffff]/.test(s), "ASCII only");
});

await check("parseBoxSample: hbwho fields, top processes, ours marked, the worst other process", () => {
  const out = "junk\r\nHBWHO idle=1 hbage=1 locked=0 browsers=1 roblox=0 gpu3d_other=0.4 gpu3d_mine=29.7 ourchrome=10\r\n" +
    'HBTOP {"wallMs":2013,"cores":8,"top":[{"n":"chrome","p":11,"c":1.732,"o":1},{"n":"SeagateToolkit","p":42,"c":0.998,"o":0},{"n":"dwm","p":5,"c":0.1,"o":0}]}\r\n';
  const s = V2.parseBoxSample(out);
  assert.equal(s.who.idle, 1); assert.equal(s.who.gpu3d_other, 0.4); assert.equal(s.who.ourchrome, 10);
  assert.equal(s.top.length, 3); assert.equal(s.top[0].ours, true);
  assert.equal(s.maxOther.name, "SeagateToolkit"); assert.equal(s.maxOther.cores, 0.998);
  const one = V2.parseBoxSample('HBTOP {"wallMs":2000,"cores":8,"top":{"n":"x","p":1,"c":0.2,"o":0}}');
  assert.equal(one.top.length, 1);
  assert.deepEqual(V2.parseHbwho("22:06:34 idle=45 hbage=3"), { idle: 45, hbage: 3 });
});

// ------------------------------------------------------------------------------------------
// arms
// ------------------------------------------------------------------------------------------
await check("loadArms: arrays, queue items (with armDefaults), and refusals", () => {
  assert.equal(V2.loadArms([{ name: "a" }, { name: "b" }]).length, 2);
  const q = { schema: "hb-1070-queue-v1", items: [{ id: "X", armDefaults: { quality: "ultra" }, arms: [{ name: "a", flags: "" }, { name: "b", quality: "low" }] }] };
  assert.deepEqual(V2.loadArms(q, "X").map((a) => a.quality), ["ultra", "low"]);
  assert.throws(() => V2.loadArms(q));
  assert.throws(() => V2.loadArms(q, "Y"));
  assert.throws(() => V2.loadArms([{ name: "a" }, { name: "a" }]));
  assert.throws(() => V2.loadArms([{ name: "a b" }]));
  assert.deepEqual(V2.rotation([1, 2, 3], 2), [2, 3, 1]);
});

await check("the M1 queue file: schema, decision rules copied in, and every arms item plans without error", () => {
  assert.ok(existsSync(QUEUE), QUEUE);
  const q = JSON.parse(readFileSync(QUEUE, "utf8"));
  assert.equal(q.schema, "hb-1070-queue-v1");
  const rules = (q.decisionRules || []).map((r) => r.rule);
  for (const r of ["V", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"]) assert.ok(rules.includes(r), `rule ${r}`);
  let armsItems = 0;
  for (const it of q.items) {
    if (!Array.isArray(it.arms)) continue;
    armsItems++;
    const arms = V2.loadArms(q, it.id);
    for (const a of arms) BENCH.planArm(a, { port: PORT });
  }
  assert.ok(armsItems >= 2, `arms items ${armsItems}`);
  const all = q.items.flatMap((it) => (Array.isArray(it.arms) ? it.arms : []));
  const has = (re) => all.some((a) => re.test(a.flags || ""));
  for (const re of [/objRadius=1\b/, /objRadius=2\b/, /occlusionCull=rigs/, /cellStaticMerge=on/, /statArrayMerge=on/, /partDegrade=on/, /cloudResScale=0\.5/, /freezeWorldRoots=on/, /rustEntityWorld=on/, /batchedRuns=off/, /nullRender=1/, /hud=none/]) assert.ok(has(re), String(re));
  const ew = all.find((a) => /rustEntityWorld=on/.test(a.flags || ""));
  assert.match(ew.gate, /__entityWorld\.stats\(\)\.projections === 1/);
});

// ------------------------------------------------------------------------------------------
// asserts, retry, probe summary
// ------------------------------------------------------------------------------------------
await check("runAssertProblems: clean v2 result passes; dev wasm / adapter / DayGroup / window / pre-v2 are problems", () => {
  const good = { asserts: { adapter: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001BE1) Direct3D11 vs_5_0 ps_5_0, D3D11)", wasm: { profile: "release" }, urlPinProblems: [],
    dayGroup: { wanted: 0, index: 0 }, skyTimePin: { wanted: 13, hours: 13 }, window: { target: [1920, 1080], inner: [1920, 1080] } } };
  assert.deepEqual(V2.runAssertProblems(good), { ok: true, problems: [] });
  const bad = JSON.parse(JSON.stringify(good));
  bad.asserts.adapter = "ANGLE (Intel HD 520)"; bad.asserts.wasm.profile = "DEV-WASM"; bad.asserts.dayGroup.index = 3; bad.asserts.window.inner = [1904, 961];
  bad.asserts.skyTimePin.hours = 9.2;
  const p = V2.runAssertProblems(bad);
  assert.equal(p.ok, false); assert.equal(p.problems.length, 5, p.problems.join("; "));
  assert.equal(V2.runAssertProblems({}).ok, false);
});

await check("retry: retries then succeeds; rethrows the last error", async () => {
  let n = 0;
  assert.equal(await V2.retry(async () => { if (++n < 3) throw new Error("x" + n); return "ok"; }, { tries: 3, delays: [0, 0], sleep: async () => {} }), "ok");
  await assert.rejects(V2.retry(async (i) => { throw new Error("e" + i); }, { tries: 2, delays: [0], sleep: async () => {} }), /e1/);
});

await check("summarizeProbeSegment: real draws = calls - batched calls + issued ranges; per-pass table; heading bins", () => {
  const p = { n: 2, cols: { t: [0, 16], calls: [100, 110], tris: [1e5, 1e5], ms: [10, 12], walks: [9, 9], world: [3, 3], empty: [2, 1], yaw: [10, 200],
    bCalls: [20, 20], sub: [500, 520], issued: [80, 82], terr: [40, 40] }, passes: [{ key: "Scene#1|L3|screen", sceneChildren: 9, calls: 2, draws: 180, ms: 14, empty: 0 }], heap: [], heapEnd: 900, nested: 0, terrainMeshes: 1 };
  const s = V2.summarizeProbeSegment(p);
  assert.equal(s.realDraws.mean, (160 + 172) / 2);
  assert.equal(s.ranges.issued.mean, 81);
  assert.equal(s.usPerCall, +((11 * 1000) / 105).toFixed(2));
  assert.equal(s.passes[0].callsPerFrame, 1); assert.equal(s.passes[0].drawsPerCall, 90); assert.equal(s.passes[0].msPerFrame, 7);
  assert.equal(s.headingBins.covered, 2);
});

// ------------------------------------------------------------------------------------------
// page instruments against fakes
// ------------------------------------------------------------------------------------------
function makeFakePage() {
  const rafQ = [];
  let now = 0;
  const g = globalThis;
  const info = { autoReset: true, render: { calls: 0, triangles: 0, frame: 0 }, memory: { geometries: 5, textures: 7 }, programs: [{ name: "P1", cacheKey: "a,b,c", usedTimes: 3 }] };
  const camera = { isPerspectiveCamera: true, layers: { mask: 3 }, matrixWorld: { elements: camMatrix([0, -10, 0], [0, 0, 0]) } };
  const quadCam = { isOrthographicCamera: true, layers: { mask: 1 }, matrixWorld: { elements: new Array(16).fill(0) } };
  const world = { name: "World", type: "Scene", isScene: true, children: [1, 2, 3, 4, 5] };
  const quad = { name: "", type: "Scene", isScene: true, children: [1] };
  let rt = null;
  const renderer = {
    info,
    getRenderTarget() { return rt; },
    setRenderTarget(x) { rt = x; },
    render(scene, cam) {
      if (this.info.autoReset) { this.info.render.calls = 0; this.info.render.triangles = 0; }
      this.info.render.frame++;
      if (scene && scene.nest) this.render(quad, quadCam);
      const n = scene === world || (scene && scene.nest) ? 10 : scene === quad ? 1 : 0;
      this.info.render.calls += n; this.info.render.triangles += n * 100;
    },
    renderBufferDirect() { },
    getContext() { return null; },
    getPixelRatio() { return 1; },
    domElement: { width: 1920, height: 1080 },
  };
  const origRender = renderer.render;
  const L = { renderer, scene: world, terrainGroup: { children: [{ isBatchedMesh: true, _multiDrawCount: 37 }] } };
  g.window = { liveScene3d: L, __batchedRuns: { frame: () => ({ batchedCalls: 4, subDraws: 90, issued: 30 }) } };
  g.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  const frame = (fn) => { now += 16; const q = rafQ.splice(0); for (const cb of q) cb(now); if (fn) fn(); };
  return { L, renderer, origRender, world, quad, camera, quadCam, frame, rafQ, setRt: (x) => { rt = x; } };
}

await check("pageInstallProbe: per-frame calls / walks / world / empty / heading / ranges, pass table, nesting, restore", () => {
  const F = makeFakePage();
  const r = PAGE.pageInstallProbe({});
  assert.equal(r.installed, true);
  assert.notEqual(F.renderer.render, F.origRender);
  const emptyScene = { type: "Scene", children: [] };
  const halfRt = { width: 960, height: 540, texture: { name: "half" } };
  const appFrame = () => {
    F.renderer.render(F.world, F.camera);
    F.setRt(halfRt);
    F.renderer.render(F.quad, F.quadCam);
    F.setRt(null);
    F.renderer.render(emptyScene, F.quadCam); // an empty walk
  };
  F.renderer.render(F.world, F.camera); // before begin(): not counted
  window.__hbProbe.begin("still");
  F.frame(appFrame); // primes (no record)
  for (let i = 0; i < 5; i++) F.frame(appFrame);
  F.frame();
  const out = window.__hbProbe.end();
  assert.equal(out.label, "still");
  assert.equal(out.n, 6);
  assert.deepEqual(out.cols.calls.slice(0, 5), [11, 11, 11, 11, 11]);
  assert.deepEqual(out.cols.walks.slice(0, 5), [3, 3, 3, 3, 3]);
  assert.deepEqual(out.cols.world.slice(0, 5), [1, 1, 1, 1, 1]);
  assert.deepEqual(out.cols.empty.slice(0, 5), [1, 1, 1, 1, 1]);
  assert.equal(out.cols.yaw[0], 0);
  assert.equal(out.cols.issued[0], 30); assert.equal(out.cols.terr[0], 37);
  const keys = out.passes.map((p) => p.key).sort();
  assert.equal(keys.length, 3);
  assert.ok(keys.some((k) => /^World#\d+\|L3\|screen$/.test(k)), keys.join(","));
  assert.ok(keys.some((k) => /\|L1\|half#\d+$/.test(k)), keys.join(","));
  const w = out.passes.find((p) => p.key.startsWith("World"));
  assert.equal(w.calls, 6); assert.equal(w.draws, 60);
  assert.equal(out.n, 6);
  const s = V2.summarizeProbeSegment(out);
  assert.equal(s.calls.mean, 11); assert.equal(s.walks.mean, 3); assert.equal(s.emptyWalks.mean, 1);
  // a render() called from inside a render(): one walk, counted as nested, its draws inside the outer's
  window.__hbProbe.begin("n");
  F.frame();
  F.renderer.render({ name: "Nest", type: "Scene", children: [1, 2, 3, 4, 5], nest: true }, F.camera);
  F.frame();
  const o2 = window.__hbProbe.end();
  assert.equal(o2.cols.walks[0], 1); assert.equal(o2.nested, 1);
  // between segments the wrapper is a pass-through
  F.renderer.render(F.world, F.camera);
  const u = window.__hbProbe.uninstall();
  assert.equal(u.restored, true);
  assert.equal(F.renderer.render, F.origRender);
  assert.equal(window.__hbProbe, undefined);
});

await check("pageInstallProbe: autoReset=false (cumulative info) still counts each walk's own draws", () => {
  const F = makeFakePage();
  F.renderer.info.autoReset = false;
  PAGE.pageInstallProbe({});
  window.__hbProbe.begin("x");
  F.frame(() => { F.renderer.render(F.world, F.camera); F.renderer.render(F.quad, F.quadCam); });
  F.frame(() => { F.renderer.render(F.world, F.camera); F.renderer.render(F.quad, F.quadCam); });
  F.frame();
  const out = window.__hbProbe.end();
  assert.deepEqual(out.cols.calls.slice(0, 2), [11, 11]);
  window.__hbProbe.uninstall();
});

function fakeGl() {
  let active = null, nextQ = 1;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    createQuery() { return { id: nextQ++ }; },
    deleteQuery() {},
    beginQuery(t, q) { if (active) throw new Error("INVALID_OPERATION: nested TIME_ELAPSED"); active = q; },
    endQuery() { active = null; },
    getQueryParameter(q, p) { return p === 1 ? true : 2e6; },
    getParameter() { return false; },
    getExtension(n) { return n === "EXT_disjoint_timer_query_webgl2" ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb } : null; },
  };
  return gl;
}

await check("pageInstallPassTimers: one query per composer pass and per top-level render outside a pass, never nested; restore", async () => {
  const F = makeFakePage();
  const gl = fakeGl();
  F.renderer.getContext = () => gl;
  const passRender = (scene, cam) => function () { F.renderer.render(scene, cam); };
  const p0 = { name: "RenderPass", enabled: true, render: passRender(F.world, F.camera) };
  const p1 = { name: "EffectPass", enabled: true, effects: [{ name: "Bloom" }], render: passRender(F.quad, F.quadCam) };
  const p0r = p0.render, p1r = p1.render;
  F.L.atmospherePipeline = { composer: { passes: [p0, p1] } };
  globalThis.location = { search: "?quality=ultra" };
  const r = PAGE.pageInstallPassTimers({});
  assert.equal(r.installed, true); assert.equal(r.gpu, true);
  window.__hbPassTimers.begin();
  for (let i = 0; i < 4; i++) F.frame(() => { p0.render(); p1.render(); F.renderer.render(F.quad, F.quadCam); });
  F.frame();
  const out = await window.__hbPassTimers.end();
  const keys = out.passes.map((p) => p.key).sort();
  assert.deepEqual(keys.map((k) => k.replace(/#\d+/g, "#")), ["00:RenderPass", "01:EffectPass[Bloom]", "render:Scene#|L1|screen"].sort());
  for (const p of out.passes) { assert.equal(p.gpuMs.mean, 2); }
  assert.equal(out.gpuMsPerFrame > 0, true);
  window.__hbPassTimers.uninstall();
  assert.equal(p0.render, p0r); assert.equal(p1.render, p1r); assert.equal(F.renderer.render, F.origRender);
  globalThis.location = { search: "?vfxGauge=on" };
  const g2 = PAGE.pageInstallPassTimers({});
  assert.equal(g2.gpu, false); assert.match(g2.refused, /vfxGauge/);
  window.__hbPassTimers.uninstall();
  delete globalThis.location;
});

await check("pageOwnerCensus: owner rows with <300 / 300-600 / >=600 m buckets and batched draws; restores renderBufferDirect", async () => {
  const F = makeFakePage();
  const ent = { name: "entities", children: [] };
  const cells = { name: "cells", children: [] };
  F.L.entitiesGroup = ent; F.L.cellsGroup = cells;
  const mk = (name, parent, y, extra = {}) => ({ name, parent, isMesh: true, geometry: { boundingSphere: { center: { x: 0, y: 0, z: 0 } } }, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -y, 1] }, ...extra });
  const part = mk("part3", { name: "rig-0x5000", parent: ent }, 100);
  const far = mk("part1", { name: "rig-0x6000", parent: ent }, 700);
  const prop = mk("cellstatic-01d90100-0200071a", { name: "envcell-01d90100", parent: cells }, 400);
  const bm = { name: "static-batch-c-12", parent: null, isBatchedMesh: true, isMesh: true, geometry: {}, matrixWorld: { elements: new Array(16).fill(0) } };
  const cam = { isPerspectiveCamera: true, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } };
  const before = F.renderer.renderBufferDirect;
  globalThis.requestAnimationFrame = (cb) => setImmediate(() => { for (const o of [part, far, prop, bm]) F.renderer.renderBufferDirect(cam, F.world, o.geometry, {}, o, null); cb(0); });
  const c = await PAGE.pageOwnerCensus({ frames: 10 });
  assert.equal(F.renderer.renderBufferDirect, before);
  const row = (n) => c.owners.find((x) => x.owner === n);
  assert.ok(row("entity part-surfaces"), JSON.stringify(c.owners));
  assert.equal(row("entity part-surfaces").buckets["<300m"], 1);
  assert.equal(row("entity part-surfaces").buckets[">=600m"], 1);
  assert.equal(row("cell statics").buckets["300-600m"], 1);
  assert.equal(row("chunk buckets").buckets.batched, 1);
  assert.equal(c.drawsPerFrame, 4);
});

await check("pageGlCensus: calls per frame per method, multi-draw ranges, real draws; own properties restored", async () => {
  const F = makeFakePage();
  const proto = { drawElements() {}, uniform1f() {}, useProgram() {}, getError() {} };
  const gl = Object.create(proto);
  const md = { multiDrawElementsWEBGL() {} };
  gl.getExtension = (n) => (n === "WEBGL_multi_draw" ? md : null);
  const drawExecHook = function () { return proto.drawElements.apply(this, arguments); };
  gl.drawElements = drawExecHook; // an own-property hook already in place (draw_exec.js style)
  F.renderer.getContext = () => gl;
  globalThis.requestAnimationFrame = (cb) => setImmediate(() => { gl.drawElements(); gl.drawElements(); gl.uniform1f(); md.multiDrawElementsWEBGL(4, [], 0, 5123, [], 0, 25); cb(0); });
  const c = await PAGE.pageGlCensus({ frames: 5 });
  assert.equal(c.perFrame.drawElements, 2);
  assert.equal(c.perFrame.uniform1f, 1);
  assert.equal(c.rangesPerFrame["md.multiDrawElements"], 25);
  assert.equal(c.realDrawsPerFrame, 27);
  assert.equal(gl.drawElements, drawExecHook);
  assert.equal(Object.prototype.hasOwnProperty.call(gl, "uniform1f"), false);
  assert.equal(md.multiDrawElementsWEBGL.name, "multiDrawElementsWEBGL");
});

await check("pageApplyPins: DayGroup override retried until the SkyDesc answers, every pin read back", async () => {
  const F = makeFakePage();
  let calls = 0, freed = 0;
  window.__sessionHandle = {
    setGameDayOverride(d, y) { calls++; this.dy = [d, y]; return calls >= 2; },
    getSkyState() { return { dayGroupIndex: 0, timeOfDayNormalized: 13 / 24, free() { freed++; } }; },
  };
  window.__skyTimePin = 13 / 24;
  Object.assign(window, { innerWidth: 1920, innerHeight: 1080, outerWidth: 1936, outerHeight: 1168, devicePixelRatio: 1 });
  globalThis.document = { createElement: () => ({ getContext: () => ({ getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : null), getParameter: () => "ANGLE (NVIDIA GeForce GTX 1070 Direct3D11)" }) }) };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    const r = await PAGE.pageApplyPins({ dayGroup: { day: 39, year: 10, index: 0 }, adapter: true });
    assert.equal(r.dayGroup.applied, true); assert.equal(r.dayGroup.tries, 2); assert.equal(r.dayGroup.index, 0);
    assert.deepEqual(window.__sessionHandle.dy, [39, 10]);
    assert.equal(r.skyTimePin.hours, 13); assert.equal(r.timeOfDay.hours, 13);
    assert.deepEqual(r.window.inner, [1920, 1080]);
    assert.match(r.adapter, /1070/);
    assert.equal(freed, 1);
    assert.deepEqual(r.canvas, [1920, 1080]);
  } finally { globalThis.setTimeout = realSetTimeout; delete globalThis.document; }
});

await check("pageMarkedWindows: a mark per window edge, per-window frame stats and heap deltas", async () => {
  makeFakePage();
  const marks = [];
  const realMark = performance.mark.bind(performance);
  performance.mark = (n) => { marks.push(n); return realMark(n); };
  let t = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => t;
  globalThis.requestAnimationFrame = (cb) => setImmediate(() => { t += 20; cb(t); });
  try {
    const r = await PAGE.pageMarkedWindows({ ms: 1000, windowMs: 500, prefix: "hbT" });
    assert.deepEqual(marks, ["hbT:w0", "hbT:w1", "hbT:w2", "hbT:end"]);
    assert.ok(r.windows.length >= 2);
    assert.equal(r.windows[0].fps, 50);
  } finally { performance.mark = realMark; performance.now = realNow; }
});

await check("pageServerState / pageProgramKeys read the entity map, the part meshes and the program keys", () => {
  const F = makeFakePage();
  const meshes = [{ isMesh: true, visible: true, parent: null }, { isMesh: true, visible: false, parent: null }, { isMesh: false }];
  F.L.entitiesGroup = { visible: true, traverse(fn) { fn(this); for (const m of meshes) { m.parent = this; fn(m); } } };
  F.L.entityManager = { entityMap: new Map([[1, {}], [2, {}], [3, {}]]) };
  const s = PAGE.pageServerState();
  assert.equal(s.entities, 3); assert.equal(s.partMeshes, 2); assert.equal(s.partMeshesVisible, 1);
  assert.deepEqual(PAGE.pageProgramKeys(), [{ name: "P1", cacheKey: "a,b,c", usedTimes: 3 }]);
});

// ------------------------------------------------------------------------------------------
// hbanatomy / hbsweep pure parts, the two page probes' self-tests, the sweep step against fakes
// ------------------------------------------------------------------------------------------
const ANAT = (await tryImport("hbanatomy.mjs")).m || {};
const SWEEP = (await tryImport("hbsweep.mjs")).m || {};

await check("hbanatomy: phases, eval wrapper with injected options, the dated calibration", () => {
  assert.deepEqual(ANAT.parseArgs(["--arm", "A"]).phases, ["trace", "passes", "glcensus", "census", "programs", "loaf"]);
  assert.throws(() => ANAT.parseArgs(["--phases", "trace,bogus"]));
  assert.equal(ANAT.parseArgs(["--attach", "--no-box-samples"]).noBox, true); // laptop tab check: never ssh to the box
  assert.equal(ANAT.parseArgs([]).noBox, false);
  assert.equal(ANAT.wrapEval("return 1;", '{"a":2}'), '(async () => { window.__hbEvalOpts = {"a":2};\nreturn 1;\n })()');
  assert.equal(ANAT.wrapEval("return 1;"), "(async () => { return 1;\n })()");
  const c = ANAT.calibration({
    probeStill: { renderJs: { mean: 11 }, calls: { mean: 1100 }, realDraws: { mean: 1500 } },
    split: { windows: [{ window: "hbAnat:still:w0", spanMs: 5000, webglPerPresent: 9 }, { window: "hbAnat:still:w1", spanMs: 5000, webglPerPresent: 10 },
      { window: "hbAnat:still:w2", spanMs: 3, webglPerPresent: 99 }, { window: "hbAnat:orbit:w0", spanMs: 5000, webglPerPresent: 50 }] },
    gl: { realDrawsPerFrame: 2000 },
  });
  assert.equal(c.usPerCallRenderJs, 10); assert.equal(c.webglMsPerPresent, 10); assert.equal(c.usPerRealDrawWebgl, 5);
  assert.ok(ANAT.TRACE_CATEGORIES.includes("gpu.angle") && ANAT.TRACE_CATEGORIES.includes("devtools.timeline") && ANAT.TRACE_CATEGORIES.includes("blink.user_timing"));
});

await check("hbsweep: knobs, ABAB order, per-value medians and relink flags", () => {
  assert.deepEqual(SWEEP.parseArgs([]).knobs, ["renderScale", "cloudRes", "cloudQuality", "haze", "shafts", "ssao"]);
  assert.equal(SWEEP.parseArgs([]).winMs, 8000); assert.equal(SWEEP.parseArgs([]).reps, 3);
  assert.throws(() => SWEEP.parseArgs(["--knobs", "bloom"]));
  assert.throws(() => SWEEP.parseArgs(["--pose", "fly"]));
  assert.equal(SWEEP.parseArgs(["--no-box-samples"]).noBox, true);
  assert.deepEqual(SWEEP.sweepOrder([1, 0.5, 0.25], 3), [[1, 0.5, 0.25], [0.25, 0.5, 1], [1, 0.5, 0.25]]);
  const rows = [{ value: 1, fps: 40, p50: 25 }, { value: 0.5, fps: 50, p50: 20, relinked: true }, { value: 1, fps: 42, p50: 24 }, { value: 0.5, fps: 52, p50: 19 }];
  const s = SWEEP.summarizeKnob(rows, [1, 0.5]);
  assert.deepEqual(s.map((x) => [x.value, x.fps, x.fpsSpread, x.relinked, x.dFps]), [[1, 41, 2, false, 0], [0.5, 51, 2, true, 10]]);
});

await check("pageSweep: info / window / set against fakes (haze strength, SSAO off, render scale)", async () => {
  const F = makeFakePage();
  let scale = 1;
  window.__setRenderScale = (n) => { scale = n; F.renderer.getPixelRatio = () => n; };
  window.__layerHaze = { strength: 0.4 };
  window.__ssao = { off: false };
  window.devicePixelRatio = 1;
  window.__hbOrbit = { x: 0, y: 0, z: 0, dist: 70, az: 45, el: 22, degPerSec: 18 };
  window.__cam = { orbit() {}, player() {} };
  let t = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => t;
  globalThis.requestAnimationFrame = (cb) => setImmediate(() => { t += 25; cb(t); });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    const i = await PAGE.pageSweep({ op: "info", knob: "haze" });
    assert.deepEqual(i, { knob: "haze", avail: true, current: 0.4, values: ["on", 0] });
    const w = await PAGE.pageSweep({ op: "window", knob: "haze", value: 0, ms: 500, pose: "orbit", settleMs: 1 });
    assert.equal(window.__layerHaze.strength, 0); assert.equal(w.fps, 40); assert.equal(w.relinked, false);
    await PAGE.pageSweep({ op: "window", knob: "haze", value: "on", onValue: 0.4, ms: 100, pose: "still", settleMs: 1 });
    assert.equal(window.__layerHaze.strength, 0.4);
    await PAGE.pageSweep({ op: "window", knob: "ssao", value: "off", ms: 100, pose: "still", settleMs: 1 });
    assert.equal(window.__ssao.off, true);
    await PAGE.pageSweep({ op: "set", knob: "ssao", value: true, raw: true });
    assert.equal(window.__ssao.off, false);
    assert.equal((await PAGE.pageSweep({ op: "info", knob: "renderScale" })).current, 1);
    await PAGE.pageSweep({ op: "window", knob: "renderScale", value: 0.5, ms: 100, pose: "street", settleMs: 1 });
    assert.equal(scale, 0.5);
    assert.equal((await PAGE.pageSweep({ op: "info", knob: "cloudRes" })).avail, false);
    assert.match((await PAGE.pageSweep({ op: "window", knob: "cloudRes", value: 1, ms: 10 })).error, /not available/);
  } finally { performance.now = realNow; globalThis.setTimeout = realSetTimeout; }
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runEvalBody(file, opts) {
  globalThis.window = { __hbEvalOpts: opts };
  return new AsyncFunction(readFileSync(join(PW, file), "utf8"))();
}

await check("structure-ceiling.eval.js self-test: world-space merge, normal matrix, blend classes, refusals", async () => {
  const r = await runEvalBody("structure-ceiling.eval.js", { selfTest: true });
  assert.equal(r.schema, "hb-structure-ceiling-v1");
  assert.deepEqual(r.position, [10, 20, 30, 12, 20, 30, 10, 21, 30, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(r.normal, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(r.uv, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(r.index, [0, 1, 2, 3, 4, 5]);
  assert.equal(r.vertices, 6); assert.equal(r.triangles, 2);
  assert.deepEqual(r.rotNormal, [1, 0, 0]);
  assert.deepEqual(r.nmScale, [0.5, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(r.nmShear, [1, -1, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(r.classes, ["opaque", "alpha-test", "translucent", "additive"]);
  assert.deepEqual(r.refusals, ["InstancedMesh", "ShaderMaterial", null, "has visible children"]);
  assert.equal(r.sig, "normal:3,position:3,uv:2");
});

await check("structure-ceiling.eval.js refuses without ?renderOnDemand=1 and without a booted scene", async () => {
  globalThis.window = { liveScene3d: null };
  const a = await new AsyncFunction(readFileSync(join(PW, "structure-ceiling.eval.js"), "utf8"))();
  assert.match(a.error, /no liveScene3d/);
  globalThis.window = { liveScene3d: { renderer: {}, scene: {} } };
  globalThis.location = { search: "?quality=ultra" };
  const b = await new AsyncFunction(readFileSync(join(PW, "structure-ceiling.eval.js"), "utf8"))();
  assert.match(b.error, /renderOnDemand=1/);
  delete globalThis.location;
});

await check("layer-mip-probe.eval.js self-test: mip levels, level sizes, byte diff, size spread", async () => {
  const r = await runEvalBody("layer-mip-probe.eval.js", { selfTest: true });
  assert.equal(r.schema, "hb-layer-mip-probe-v1");
  assert.deepEqual(r.levels, [9, 9, 1, 9]);
  assert.deepEqual(r.sizes, [32, 1, 2]);
  assert.equal(r.equal, null);
  assert.deepEqual(r.diff, { at: 6, texel: 1, channel: 2, a: 7, b: 9, count: 1, maxAbs: 2 });
  assert.deepEqual(r.spread, [1, 6, 10]);
});

// ------------------------------------------------------------------------------------------
// lib/hb_session.mjs sizeWindow against a fake CDP session
// ------------------------------------------------------------------------------------------
const SESS = (await tryImport("lib/hb_session.mjs")).m || {};
function fakeWindow({ capH = Infinity } = {}) {
  const st = { ow: 1920, oh: 1080, deco: [16, 87], emulated: null, calls: [], detached: false };
  const inner = () => (st.emulated ? st.emulated : [st.ow - st.deco[0], st.oh - st.deco[1]]);
  const pg = { evaluate: async () => { const [iw, ih] = inner(); return { iw, ih, ow: st.ow, oh: st.oh, dpr: 1 }; } };
  const session = {
    async send(m, p) {
      st.calls.push(m);
      if (m === "Browser.getWindowForTarget") return { windowId: 7 };
      if (m === "Browser.setWindowBounds") { st.ow = p.bounds.width; st.oh = Math.min(p.bounds.height, capH); return {}; }
      if (m === "Emulation.setDeviceMetricsOverride") { st.emulated = [p.width, p.height]; return {}; }
      throw new Error(m);
    },
    async detach() { st.detached = true; },
  };
  return { st, pg, ctx: { newCDPSession: async () => session } };
}

await check("sizeWindow: window bounds until the INNER size is the target; viewport emulation when the window is capped", async () => {
  const a = fakeWindow();
  const r = await SESS.sizeWindow(a.ctx, a.pg, { w: 1920, h: 1080 });
  assert.equal(r.ok, true); assert.equal(r.emulated, false); assert.deepEqual(r.inner, [1920, 1080]); assert.deepEqual(r.outer, [1936, 1167]);
  assert.equal(a.st.detached, true);
  const b = fakeWindow({ capH: 1102 });
  const q = await SESS.sizeWindow(b.ctx, b.pg, { w: 1920, h: 1080 });
  assert.equal(q.ok, true); assert.equal(q.emulated, true); assert.deepEqual(q.inner, [1920, 1080]); assert.deepEqual(q.windowInner, [1920, 1015]);
  assert.equal(b.st.detached, false, "the emulating session stays attached");
  assert.ok(b.st.calls.includes("Emulation.setDeviceMetricsOverride"));
  assert.equal(JSON.parse(JSON.stringify(q))._session, undefined);
  const c = fakeWindow({ capH: 1102 });
  const n = await SESS.sizeWindow(c.ctx, c.pg, { w: 1920, h: 1080 }, { emulateFallback: false });
  assert.equal(n.ok, false); assert.equal(n.emulated, false);
});

// ------------------------------------------------------------------------------------------
// tools/webgpu_probe pure parts
// ------------------------------------------------------------------------------------------
const WGP = join(PW, "../../apps/holtburger-web/tools/webgpu_probe");
const PL = (await tryImport("../../apps/holtburger-web/tools/webgpu_probe/probe_lib.mjs")).m || {};
const PRUN = (await tryImport("../../apps/holtburger-web/tools/webgpu_probe/run.mjs")).m || {};

await check("webgpu probe: limits off prototype getters, features of interest, shaders, offsets, URL, Dawn categories", () => {
  class Lim { get maxTextureArrayLayers() { return 2048; } get maxStorageBufferBindingSize() { return 134217728; } get maxBindGroups() { return 4; } get somethingNew() { return 7; } }
  const l = PL.pickLimits(new Lim());
  assert.deepEqual(l.picked, { maxTextureArrayLayers: 2048, maxStorageBufferBindingSize: 134217728, maxBindGroups: 4 });
  assert.deepEqual(l.other, { somethingNew: 7 });
  const f = PL.featureReport(new Set(["timestamp-query", "texture-compression-bc", "core-features-and-limits"]));
  assert.equal(f.has["timestamp-query"], true); assert.equal(f.has["chromium-experimental-multi-draw-indirect"], false);
  assert.deepEqual(f.all, ["core-features-and-limits", "texture-compression-bc", "timestamp-query"]);
  const w = PL.terrainWgsl(16);
  assert.equal((w.match(/textureSample\(/g) || []).length, 16);
  assert.match(w, /@vertex fn vs/); assert.match(w, /@fragment fn fs/); assert.match(w, /texture_2d_array<f32>/);
  assert.match(PL.benchWgsl(), /var<uniform> u: U/);
  const c = PL.cube(); assert.equal(c.indices.length, 36); assert.ok(Math.max(...c.indices) < 8);
  const o = PL.drawOffsets(1000, 64); assert.equal(o.length, 64000); assert.ok(o[64 * 999] <= 0.9 && o[64 * 999 + 1] <= 0.9); assert.equal(o[3], 1);
  assert.deepEqual(PL.perDraw({ cpuMs: { p50: 2 }, gpuMs: { p50: 0.5 } }, 1000), { cpuUsPerDraw: 2, gpuUsPerDraw: 0.5 });
  assert.deepEqual(PL.statsMs([1, 2, 3, NaN]), { n: 3, mean: 2, p50: 2, p95: 3, max: 3 });
  const pu = new URL(PRUN.probeUrl("8766", { draws: 1000, sec: 5, rounds: 2 }));
  assert.equal(pu.origin + pu.pathname, "http://127.0.0.1:8766/apps/holtburger-web/tools/webgpu_probe/index.html");
  assert.deepEqual([...pu.searchParams.entries()], [["draws", "1000"], ["sec", "5"], ["rounds", "2"], ["nosw", "1"]]);
  assert.deepEqual(PRUN.dawnCategories(["gpu", "gpu.dawn", "disabled-by-default-gpu.dawn", "toplevel", "webgpu", "gpu.dawn"]), ["disabled-by-default-gpu.dawn", "gpu.dawn", "webgpu"]);
  assert.equal(PRUN.parseArgs([]).draws, 1000);
});

await check("webgpu probe runProbe: the box Chrome is closed and killed after a failed webgpu-probe.json write, a launch that never answered and a connect that threw; main() arms the Ctrl-C kill", async () => {
  // 2026-10-30 (lane H3): run.mjs wrote its result in the `finally` BEFORE close + kill, so a throwing
  // write left the test Chrome up on the person's 1070; and Ctrl-C ran no `finally` at all.
  assert.equal(typeof PRUN.runProbe, "function", "tools/webgpu_probe/run.mjs exports runProbe (injectable deps)");
  const fakeDeps = (log, over = {}) => ({
    killBench: () => log.push("kill"),
    prepareLaunch: async () => { log.push("prepare"); },
    boxSample: async (label) => { log.push(`box:${label}`); return { label }; },
    launchChrome: async () => { log.push("launch"); return true; },
    connectAtLaunch: async () => {
      log.push("connect");
      return { browser: { close: async () => { log.push("close"); }, newBrowserCDPSession: async () => ({ send: async () => ({ categories: ["gpu", "gpu.dawn", "toplevel"] }), detach: async () => {} }) },
        pg: { goto: async () => { log.push("goto"); }, evaluate: async (fn) => (String(fn).includes(".state") ? "done" : { modes: { webgl2: { fps: 60 } } }) } };
    },
    spawnSync: () => { throw new Error("no python in this check"); },
    sleep: async () => {}, mkdir: () => {}, exists: () => false, read: () => "",
    write: (_p, t) => { log.push("write"); written.push(JSON.parse(t)); },
    ...over,
  });
  const written = [];
  const o = PRUN.parseArgs(["--no-trace", "--out", "/nowhere/wgp"]);
  const L1 = [];
  const ok = await PRUN.runProbe(o, fakeDeps(L1));
  assert.equal(ok.error, undefined, ok.error);
  assert.deepEqual(L1, ["kill", "prepare", "box:pre-launch", "launch", "connect", "goto", "box:post-probe", "write", "close", "kill"]);
  assert.equal(written.length, 1); assert.deepEqual(written[0].probe, { modes: { webgl2: { fps: 60 } } }); assert.deepEqual(written[0].traceCategories.dawn, ["gpu.dawn"]);
  const L2 = []; // the result write fails (disk full): the error surfaces only AFTER close + kill
  await assert.rejects(PRUN.runProbe(o, fakeDeps(L2, { write: () => { L2.push("write"); throw new Error("ENOSPC: no space left on device"); } })), /ENOSPC/);
  assert.deepEqual(L2.slice(-3), ["write", "close", "kill"], L2.join(","));
  const L3 = []; // CDP never answered: nothing to close, still killed
  const r3 = await PRUN.runProbe(o, fakeDeps(L3, { launchChrome: async () => { L3.push("launch"); return false; } }));
  assert.match(r3.error, /never answered/); assert.deepEqual(L3.slice(-2), ["write", "kill"]); assert.ok(!L3.includes("close"), L3.join(","));
  const L4 = []; // the connect throws after the launch: still killed
  const r4 = await PRUN.runProbe(o, fakeDeps(L4, { connectAtLaunch: async () => { L4.push("connect"); throw new Error("connect: socket hang up"); } }));
  assert.match(r4.error, /socket hang up/); assert.deepEqual(L4.slice(-2), ["write", "kill"]);
  // main(): armed before the probe runs (it launches the box Chrome), never at import
  const src = readFileSync(join(WGP, "run.mjs"), "utf8");
  const main = src.slice(src.indexOf("async function main("));
  assert.ok(main.indexOf("armKillOnSignal();") > 0 && main.indexOf("armKillOnSignal();") < main.indexOf("runProbe("), "run.mjs main(): armKillOnSignal() before runProbe");
  assert.equal(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP"), 0, "importing run.mjs armed nothing");
});

// ------------------------------------------------------------------------------------------
// 2026-10-30 verifier fixes: queue-to-run plan fields, runOne / bootArm step sequences against a fake
// page, the page heading sign, the multidraw row alignment, sweep relinks and orbit refusal, the
// window tolerance, the asserts block, attached-session pins, the layer-mip control, the rules text.
// ------------------------------------------------------------------------------------------
const BOOT = (await tryImport("lib/hb_boot.mjs")).m || {};
const QJ = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, "utf8")) : null;
const qArm = (item, name) => V2.loadArms(QJ, item).find((a) => a.name === name);
const GTX = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001BE1) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const HOLT = "0xA9B40001 96 96 80";

await check("planArm carries the queue arm's spot / stillCam / readyWhen / gate / gateInfo (and the defaults when absent)", () => {
  const hill = BENCH.planArm(qArm("M1b-OBJRADIUS", "R1-hill"), { port: PORT });
  assert.equal(hill.spot, "0xA9B40019 84 7.1 94");
  assert.equal(BENCH.planArm(qArm("M1b-LINVAK", "LV-partDegrade"), { port: PORT }).spot, "0xA21E001A 83 38 560.4"); // via armDefaults
  const h = BENCH.planArm(qArm("M1c-WEBAC", "H-default"), { port: PORT });
  assert.deepEqual(h.stillCam, { dist: 8, az: 180, el: 12, dz: 1.5 });
  assert.equal(BENCH.planArm(qArm("M1a-BENCH", "L0-nullRender"), { port: PORT }).readyWhen, "live-scene");
  const ew = BENCH.planArm(qArm("M1b-STRUCTURE", "S-rustEntityWorld"), { port: PORT });
  assert.equal(ew.gate, "window.__entityWorld && window.__entityWorld.stats().projections === 1");
  assert.equal(ew.gateInfo, "window.__entityWorld ? window.__entityWorld.stats() : null");
  assert.match(BENCH.planArm(qArm("M1b-OCC", "O-rigs"), { port: PORT }).gateInfo, /__occlusionCull/);
  const a = BENCH.planArm({ name: "A", quality: "ultra" }, { port: PORT });
  assert.deepEqual([a.spot, a.stillCam, a.readyWhen, a.gate, a.gateInfo], [HOLT, null, "boot-ready", null, null]);
  assert.deepEqual(a.boxSampleAt, ["pre-launch", "pre-firstTurn", "pre-still", "still-moving", "post-moving", "post-tour"]);
  assert.deepEqual([a.pinsBeforeSegments, a.settledServerState, a.exposeOrbit], [true, true, true]);
  const v1 = BENCH.planArm({ name: "A", quality: "ultra" }, { port: PORT, compat: "v1" });
  assert.deepEqual(v1.boxSampleAt, ["pre-launch", "post-tour"]);
  assert.deepEqual([v1.pinsBeforeSegments, v1.settledServerState, v1.exposeOrbit], [false, false, false]);
  assert.deepEqual(BENCH.planArm({ name: "A" }, { port: PORT, noBoxSamples: true }).boxSampleAt, []);
});

/** A Playwright-shaped page that logs every step of runOne / bootArm (no browser). */
function driverFake({ gate = true, adapter = GTX, entities = 100, inner = [1920, 1080], dgIndex = 0, sky = 13 } = {}) {
  const log = [];
  const L = (x) => log.push(x);
  const fr = (n = 60) => Array.from({ length: n }, () => 16.7);
  const pins = () => ({ dayGroup: { index: dgIndex }, skyTimePin: sky == null ? null : { hours: sky }, window: { inner, dpr: 1 }, wasm: [], renderScale: 1, pixelRatio: 1 });
  const pg = {
    on() {},
    url: () => `http://127.0.0.1:${PORT}/apps/holtburger-web/index.html?skytime=13&renderScale=1&adaptiveRes=off&nosw=1&targetFps=0`,
    async goto(u) { L("goto"); pg.gotoUrl = u; },
    async evaluate(fn, arg) {
      if (typeof fn !== "function") { L("expr"); return 42; }
      if (fn === PAGE.pageApplyPins) { L(`pins${arg && arg.dayGroup ? ":dg" + arg.dayGroup.index : ""}${arg && arg.adapter ? ":adapter" : ""}`); return { ...pins(), ...(arg && arg.adapter ? { adapter } : {}) }; }
      if (fn === PAGE.pageServerState) { L("serverState"); return { entities }; }
      if (fn === PAGE.pageInstallProbe) { L("probeInstall"); return { installed: true }; }
      if (fn === PAGE.pageGateValue) { L(`gate:${arg}`); return gate; }
      if (fn === PAGE.pageGateInfo) { L("gateInfo"); return { projections: gate ? 1 : 0 }; }
      if (fn === PAGE.pageEnsureOrbit) { L("ensureOrbit"); return { source: "set", orbit: { az: 45, degPerSec: arg.degPerSec } }; }
      if (fn === PAGE.pageSweep) { L(`sweep:${arg.op}:${arg.knob}`); return arg.op === "info" ? { knob: arg.knob, avail: false } : {}; }
      const src = String(fn);
      if (src.includes("UNMASKED_RENDERER_WEBGL")) { L("adapter"); return adapter; }
      if (src.includes("wakeLock")) { L("wake"); return undefined; }
      if (src.includes("__hbProbe.begin")) { L(`probeBegin:${arg}`); return undefined; }
      if (src.includes("__hbProbe.end")) { L("probeEnd"); return null; }
      if (src.includes(".uninstall()")) { L("probeUninstall"); return { restored: true }; }
      if (src.includes("* 360, 12, 1.5")) { L("firstTurn"); return fr(); }
      if (src.includes("window.__cam.world()")) { L("camWorld"); return { x: 1, y: 2, z: 3 }; }
      if (src.includes("window.__hbOrbit = o2")) { L("exposeOrbit"); return undefined; }
      if (src.includes("new Promise((done)")) { L("warmup"); return undefined; }
      if (src.includes("orbit.degPerSec")) { L(`frames:${arg.ms}:${arg.orbit ? "orbit@" + arg.orbit.degPerSec : "still"}`); return fr(); }
      if (src.includes("__cam.player(s.dist")) { L(`stillCam:${JSON.stringify(arg)}`); return undefined; }
      if (src.includes("window.__cam.orbit(o2.x")) { L("park"); return undefined; }
      if (src.includes("r.info.autoReset = false")) { L("draws"); return 1000; }
      if (src.includes("window.__hbF = []")) { L("tourStart"); return undefined; }
      if (src.includes("sendChat")) { L(`chat:${arg}`); return undefined; }
      if (src.includes("window.__hbRec = false")) { L("tourEnd"); return Array.from({ length: 60 }, (_, i) => i * 16.7); }
      if (src.includes("asyncLink")) { L("extra"); return {}; }
      if (src.includes("location.search")) { L("pageInfo"); return { inner }; }
      L("other:" + src.slice(0, 60)); return null;
    },
  };
  const files = {};
  const deps = {
    waitAccountFree: async () => { L("accountFree"); return true; },
    killBench: () => L("kill"),
    prepareLaunch: async (p) => L(`prepare:${p.windowOuter}`),
    launchChrome: async () => { L("launch"); return true; },
    connectAtLaunch: async () => { L("connect"); return { browser: { close: async () => L("close") }, ctx: {}, pg }; },
    sizeWindow: async (_c, _p, t) => { L(`sizeWindow:${t.w}x${t.h}`); return { ok: true, emulated: false, inner: [t.w, t.h] }; },
    waitBootReady: async (_p, o) => { L(`boot:${o.readyWhen}`); return { ok: true, ms: 1 }; },
    teleportSettle: async (_p, spot) => { L(`settle:${spot}`); return { quiet: true }; },
    wasmProfileOf: async (u) => { L("wasm"); return { url: u, profile: "release" }; },
    boxSample: async (label) => { L(`box:${label}`); return { label, at: new Date().toISOString(), who: { idle: 600 }, top: [] }; },
    sleep: async (ms) => L(`sleep:${ms}`),
    writeFile: (path, text) => { files[path] = text; },
  };
  return { log, pg, deps, files };
}
const benchCtx = (o) => ({ o: { port: PORT, tour: "poi:Shoushi", hold: 35000, uncapped: true, ...o }, OUT: "/nowhere", log: () => {} });
const slice = (log, from, to) => log.slice(log.indexOf(from), log.indexOf(to) + 1);

// The pre-v2 hbbench.mjs (git 95240def) runOne, step for step from the navigation to the `extra` read
// (its teleport + settle loop is lib/hb_session.mjs teleportSettle, its boot loop waitBootReady).
const V1_STEPS = ["goto", "adapter", "wake", "boot:boot-ready", "sleep:5000", `settle:${HOLT}`, "firstTurn", "sleep:2000", "camWorld",
  "frames:25000:orbit@12", "park", "sleep:3000", "frames:20000:still", "frames:20000:orbit@12", "draws", "tourStart", "chat:@telepoi Shoushi",
  "sleep:35000", `chat:@teleloc ${HOLT}`, "sleep:35000", "tourEnd", "extra"];

await check("runOne --compat v1: the pre-v2 step sequence exactly (no box sample, pin read, census or probe between the settle and the tour's end)", async () => {
  assert.equal(typeof BENCH.runOne, "function", "hbbench.mjs exports runOne");
  for (const f of ["arms-rc-rust-scene-core-v2.json", "arms-rc-bisect.json"]) {
    for (const arm of V2.loadArms(JSON.parse(readFileSync(join(PW, f), "utf8")))) {
      const F = driverFake();
      const r = await BENCH.runOne(arm, 2, benchCtx({ compat: "v1" }), F.deps);
      assert.equal(r.error, undefined, `${f} ${arm.name}: ${r.error}`);
      assert.deepEqual(slice(F.log, "goto", "extra"), V1_STEPS, `${f} ${arm.name}`);
      const before = F.log.slice(0, F.log.indexOf("goto"));
      assert.deepEqual(before, ["accountFree", "kill", "prepare:1280,720", "box:pre-launch", "launch", "connect"]);
      const after = F.log.slice(F.log.indexOf("extra") + 1);
      assert.deepEqual(after.filter((x) => x.startsWith("box:")), ["box:post-tour"]);
      assert.ok(after.includes("pins") && after.includes("serverState"), after.join(","));
      assert.ok(!F.log.some((x) => /^pins:dg|probe|exposeOrbit|sizeWindow|gate/.test(x)), F.log.join(","));
      assert.equal(F.pg.gotoUrl, v1Url(arm));
      assert.equal(r.asserts.wasm.profile, "release"); assert.deepEqual(r.asserts.urlPinProblems, []);
      assert.equal(BENCH.pinEntities(r), 100);
    }
  }
});

await check("runOne v2: box samples around every segment, DayGroup + asserts before the segments, probe per segment, 18 deg/s orbit", async () => {
  const F = driverFake();
  const r = await BENCH.runOne({ name: "A", quality: "ultra", flags: "" }, 1, benchCtx({}), F.deps);
  assert.equal(r.error, undefined, r.error);
  const L = F.log;
  assert.deepEqual(L.filter((x) => x.startsWith("box:")), ["box:pre-launch", "box:pre-firstTurn", "box:pre-still", "box:still-moving", "box:post-moving", "box:post-tour"]);
  assert.ok(L.indexOf("sizeWindow:1920x1080") < L.indexOf("goto"));
  assert.equal(L.filter((x) => x === "pins:dg0").length, 2); // after boot, and again right before the segments
  assert.ok(L.lastIndexOf("pins:dg0") < L.indexOf("firstTurn"));
  assert.ok(L.indexOf("serverState") < L.indexOf("firstTurn"));
  assert.deepEqual(L.filter((x) => x.startsWith("probeBegin")), ["probeBegin:firstTurn", "probeBegin:still", "probeBegin:moving", "probeBegin:tour"]);
  assert.ok(L.includes("frames:20000:orbit@18") && L.includes("exposeOrbit"));
  assert.deepEqual(r.assertProblems, []);
  assert.deepEqual(r.asserts.window.target, [1920, 1080]);
  assert.deepEqual(r.asserts.dayGroup.wanted, 0);
  assert.equal(r.asserts.skyTimePin.wanted, 13);
});

await check("runOne v2 uses the queue arm's spot, readyWhen, stillCam and gate (a false gate stops the rep before any segment)", async () => {
  let F = driverFake();
  await BENCH.runOne(qArm("M1b-OBJRADIUS", "R1-hill"), 1, benchCtx({}), F.deps);
  assert.ok(F.log.includes("settle:0xA9B40019 84 7.1 94"), F.log.join(","));
  F = driverFake();
  await BENCH.runOne(qArm("M1a-BENCH", "L0-nullRender"), 1, benchCtx({}), F.deps);
  assert.ok(F.log.includes("boot:live-scene"));
  F = driverFake();
  await BENCH.runOne(qArm("M1c-WEBAC", "H-default"), 1, benchCtx({}), F.deps);
  const sc = F.log.indexOf('stillCam:{"dist":8,"az":180,"el":12,"dz":1.5}');
  assert.ok(sc > F.log.indexOf("frames:25000:orbit@18") && sc < F.log.indexOf("frames:20000:still"), F.log.join(","));
  assert.ok(!F.log.includes("park"));
  F = driverFake({ gate: true });
  const ok = await BENCH.runOne(qArm("M1b-STRUCTURE", "S-rustEntityWorld"), 1, benchCtx({}), F.deps);
  assert.ok(F.log.includes("gate:window.__entityWorld && window.__entityWorld.stats().projections === 1"));
  assert.deepEqual(ok.gate.info, { projections: 1 }); assert.equal(ok.gate.ok, true); assert.equal(ok.error, undefined);
  F = driverFake({ gate: false });
  const bad = await BENCH.runOne(qArm("M1b-STRUCTURE", "S-rustEntityWorld"), 1, benchCtx({}), F.deps);
  assert.match(bad.error, /^gate failed: /);
  assert.ok(!F.log.some((x) => x.startsWith("frames:") || x === "firstTurn"), F.log.join(","));
  assert.ok(F.log.includes("close") && F.log[F.log.length - 1] === "kill");
});

await check("bootArm (hbanatomy / hbsweep --boot): spot, readyWhen, gate, DayGroup, and asserts computed (URL pins, window, skytime), not hard-coded", async () => {
  assert.equal(typeof BOOT.bootArm, "function");
  const F = driverFake({ inner: [1920, 1080] });
  const res = { box: [], errors: [] };
  const b = await BOOT.bootArm(qArm("M1b-STRUCTURE", "S-rustEntityWorld"), { port: PORT, rep: 1 }, null, res, F.deps);
  assert.ok(F.log.includes(`settle:${HOLT}`) && F.log.includes("boot:boot-ready") && F.log.includes("pins:dg0") && F.log.some((x) => x.startsWith("gate:")));
  assert.deepEqual(res.asserts.urlPins, b.plan.pins);
  assert.deepEqual(res.asserts.urlPinProblems, V2.urlPinProblems(b.plan.pins, { compat: null, governorFlag: false }));
  assert.deepEqual(res.asserts.window.target, [1920, 1080]); assert.equal(res.asserts.skyTimePin.wanted, 13);
  assert.deepEqual(res.assertProblems, []);
  const G = driverFake({ inner: [1904, 961], sky: null });
  const r2 = { box: [], errors: [] };
  await BOOT.bootArm({ name: "A", quality: "ultra" }, { port: PORT }, null, r2, G.deps);
  assert.ok(r2.assertProblems.some((x) => /window inner 1904x961/.test(x)) && r2.assertProblems.some((x) => /skytime/.test(x)), r2.assertProblems.join("; "));
  // an arm that drops the skytime pin: the URL-pin problem reaches the asserts (the old hbanatomy wrote urlPinProblems: [])
  const N = driverFake();
  const r3 = { box: [], errors: [] };
  await BOOT.bootArm({ name: "A", quality: "ultra", skytime: "none" }, { port: PORT }, null, r3, N.deps);
  assert.deepEqual(r3.asserts.urlPinProblems, ["skytime not pinned"]);
  assert.ok(r3.assertProblems.includes("url: skytime not pinned"), r3.assertProblems.join("; "));
  const H = driverFake({ gate: false });
  await assert.rejects(BOOT.bootArm(qArm("M1b-STRUCTURE", "S-rustEntityWorld"), { port: PORT }, null, { box: [], errors: [] }, H.deps), /gate failed/);
  const M = driverFake();
  await BOOT.bootArm(qArm("M1b-OBJRADIUS", "R1-hill"), { port: PORT }, null, { box: [], errors: [] }, M.deps);
  assert.ok(M.log.includes("settle:0xA9B40019 84 7.1 94"));
});

await check("buildAsserts / runAssertProblems: the window tolerance is 2 px; skytime hours from either URL form", () => {
  const plan = BENCH.planArm({ name: "A", quality: "ultra" }, { port: PORT });
  const mk = (inner) => ({ asserts: V2.buildAsserts({ plan, gpu: GTX, pins: { dayGroup: { index: 0 }, skyTimePin: { hours: 13 }, window: { inner, dpr: 1 } }, wasm: [{ profile: "release" }] }) });
  assert.deepEqual(V2.runAssertProblems(mk([1922, 1078])).problems, []);
  assert.deepEqual(V2.runAssertProblems(mk([1923, 1080])).problems, ["window inner 1923x1080 (want 1920x1080)"]);
  assert.deepEqual(V2.runAssertProblems(mk([1920, 1077])).problems, ["window inner 1920x1077 (want 1920x1080)"]);
  // the skytime read-back tolerance is 0.01 h (36 s of sky clock), the same as hbreport.py window_sky_problems
  const sky = (hours) => V2.runAssertProblems({ asserts: V2.buildAsserts({ plan, gpu: GTX, pins: { dayGroup: { index: 0 }, skyTimePin: { hours }, window: { inner: [1920, 1080], dpr: 1 } }, wasm: [{ profile: "release" }] }) }).problems;
  assert.deepEqual([sky(13), sky(13.004), sky(12.995)], [[], [], []]);
  assert.deepEqual(sky(13.05), ["skytime 13.05 (want 13)"]);
  assert.deepEqual(sky(12.98), ["skytime 12.98 (want 13)"]);
  assert.equal(V2.skyHoursWanted("13"), 13); assert.equal(V2.skyHoursWanted("0.5"), 12); assert.equal(V2.skyHoursWanted("accel"), null);
  assert.equal(V2.wasmVerdict([{ profile: "release" }, { profile: "DEV-WASM" }]), "DEV-WASM"); assert.equal(V2.wasmVerdict([]), "unknown");
  const v1 = BENCH.planArm({ name: "A" }, { port: PORT, compat: "v1" });
  const a1 = V2.buildAsserts({ plan: v1, gpu: GTX, pins: {}, wasm: [{ profile: "release" }] });
  assert.deepEqual([a1.window, a1.dayGroup, a1.skyTimePin], [null, null, null]);
});

await check("pageInstallProbe heading = headingFromMatrix (sign included): a camera looking east reads 90, west 270", () => {
  for (const [eye, want] of [[[-10, 0, 0], 90], [[10, 0, 0], 270], [[0, 10, 0], 180], [[-7, -7, 0], 45]]) {
    const F = makeFakePage();
    const cam = { isPerspectiveCamera: true, layers: { mask: 1 }, matrixWorld: { elements: camMatrix(eye, [0, 0, 0]) } };
    PAGE.pageInstallProbe({});
    window.__hbProbe.begin("h");
    F.frame(() => F.renderer.render(F.world, cam));
    F.frame(() => F.renderer.render(F.world, cam));
    F.frame();
    const out = window.__hbProbe.end();
    window.__hbProbe.uninstall();
    const e = cam.matrixWorld.elements;
    assert.equal(out.cols.yaw[0], Math.round(V2.headingFromMatrix(e[8], e[10]) * 10) / 10);
    assert.ok(Math.abs(out.cols.yaw[0] - want) < 0.05, `eye ${eye}: ${out.cols.yaw[0]} want ${want}`);
  }
});

await check("pageInstallProbe: __batchedRuns ranges land on the row of the frame that drew them (frame() is the last COMPLETED frame)", () => {
  const F = makeFakePage();
  // batched_runs.js semantics: the totals roll into `last` at the first BatchedMesh draw of the NEXT display frame
  let last = { batchedCalls: 0, subDraws: 0, issued: 0 }, cur = null, frameCalls = 0;
  window.__batchedRuns = { frame: () => { frameCalls++; return { ...last }; } };
  const appFrame = (k) => () => { if (cur) last = cur; cur = { batchedCalls: k, subDraws: 10 * k, issued: 100 * k }; F.renderer.render(F.world, F.camera); };
  PAGE.pageInstallProbe({});
  window.__hbProbe.begin("b");
  F.frame(appFrame(1)); // primes
  for (let k = 2; k <= 5; k++) F.frame(appFrame(k));
  F.frame(); // a frame that renders nothing (no rollover): its row reads 0, the pending row waits
  F.frame(appFrame(6));
  F.frame();
  const out = window.__hbProbe.end();
  // rows: renders 1..5, the empty frame, render 6
  assert.deepEqual(out.cols.walks, [1, 1, 1, 1, 1, 0, 1]);
  assert.deepEqual(out.cols.bCalls, [1, 2, 3, 4, 5, 0, null]);
  assert.deepEqual(out.cols.issued, [100, 200, 300, 400, 500, 0, null]);
  assert.deepEqual(out.cols.sub, [10, 20, 30, 40, 50, 0, null]);
  const s = V2.summarizeProbeSegment(out);
  assert.equal(s.realDraws.n, 6); // the unknown last row is left out, not counted as 0
  assert.equal(s.ranges.issued.n, 6);
  assert.equal(s.headingBins.sectorMean.issued, 300); // renders 1-5: the empty frame has no heading, the last row no ranges
  assert.equal(s.ranges.issued.mean, 250); // the six known rows
  window.__hbProbe.uninstall();
  // no allocation path: frameInto(out) is preferred when batched_runs.js offers it
  const G = makeFakePage();
  let into = 0, copies = 0;
  window.__batchedRuns = { frame: () => { copies++; return { batchedCalls: 1, subDraws: 1, issued: 1 }; }, frameInto: (o) => { into++; o.batchedCalls = 2; o.subDraws = 3; o.issued = 4; return o; } };
  PAGE.pageInstallProbe({});
  window.__hbProbe.begin("i");
  for (let k = 0; k < 4; k++) G.frame(() => G.renderer.render(G.world, G.camera));
  G.frame();
  const o2 = window.__hbProbe.end();
  assert.deepEqual(o2.cols.issued.slice(0, 3), [4, 4, 4]); assert.equal(copies, 0); assert.ok(into >= 3);
  assert.equal(o2.rangesApi, "frameInto"); assert.equal(out.rangesApi, "frame"); assert.equal(s.rangesApi, "frame");
  window.__hbProbe.uninstall();
  assert.ok(frameCalls > 0);
});

await check("pageSweep: relinked / relinkedInSettle from programs and async links; an orbit window without __hbOrbit is refused, knob untouched", async () => {
  const F = makeFakePage();
  window.__layerHaze = { strength: 0.4 };
  window.__cam = { orbit() {}, player() {} };
  let t = 0, rafN = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => t;
  const realSetTimeout = globalThis.setTimeout;
  let onSettle = null, onWindow = null;
  globalThis.setTimeout = (fn) => realSetTimeout(() => { if (onSettle) onSettle(); fn(); }, 0);
  globalThis.requestAnimationFrame = (cb) => setImmediate(() => { t += 25; rafN++; if (onWindow && rafN === 3) onWindow(); cb(t); });
  const progs = F.renderer.info.programs;
  try {
    delete window.__hbOrbit;
    const refused = await PAGE.pageSweep({ op: "window", knob: "haze", value: 0, ms: 100, pose: "orbit", settleMs: 1 });
    assert.match(refused.error, /__hbOrbit/); assert.equal(window.__layerHaze.strength, 0.4);
    window.__hbOrbit = { x: 0, y: 0, z: 0, dist: 70, az: 45, el: 22, degPerSec: 18 };
    const w0 = await PAGE.pageSweep({ op: "window", knob: "haze", value: 0, ms: 100, pose: "orbit", settleMs: 1 });
    assert.deepEqual([w0.relinked, w0.relinkedInSettle], [false, false]); assert.deepEqual(w0.orbit, { az: 45, degPerSec: 18 });
    rafN = 0; onWindow = () => progs.push({ name: "P2", cacheKey: "x" });
    const w1 = await PAGE.pageSweep({ op: "window", knob: "haze", value: "on", onValue: 0.4, ms: 200, pose: "still", settleMs: 1 });
    assert.deepEqual([w1.relinked, w1.relinkedInSettle], [true, false]);
    onWindow = null; onSettle = () => { progs.push({ name: "P3", cacheKey: "y" }); onSettle = null; };
    const w2 = await PAGE.pageSweep({ op: "window", knob: "haze", value: 0, ms: 100, pose: "still", settleMs: 1 });
    assert.deepEqual([w2.relinked, w2.relinkedInSettle], [false, true]);
    window.__asyncLink = { stats: { compiled: 10 } };
    rafN = 0; onWindow = () => { window.__asyncLink.stats.compiled = 11; };
    const w3 = await PAGE.pageSweep({ op: "window", knob: "haze", value: "on", onValue: 0.4, ms: 200, pose: "still", settleMs: 1 });
    assert.deepEqual([w3.relinked, w3.relinkedInSettle], [true, false]);
    assert.deepEqual(w3.asyncCompiled, [10, 10, 11]);
  } finally { performance.now = realNow; globalThis.setTimeout = realSetTimeout; delete window.__asyncLink; }
});

await check("pageMarkedWindows refuses an orbit without __hbOrbit; pageEnsureOrbit keeps a booted orbit or sets hbbench's", async () => {
  makeFakePage();
  delete window.__hbOrbit;
  // frames that end the window at once, so a page that ignores the missing orbit still returns (and fails below)
  globalThis.requestAnimationFrame = (cb) => setImmediate(() => cb(performance.now() + 1000));
  const r = await PAGE.pageMarkedWindows({ ms: 100, orbit: true, prefix: "x" });
  assert.match(r.error, /__hbOrbit/);
  let parked = null;
  window.__cam = { world: () => ({ x: 1, y: 2, z: 3 }), orbit: (...a) => { parked = a; } };
  const s = PAGE.pageEnsureOrbit({ degPerSec: 18 });
  assert.equal(s.source, "set"); assert.deepEqual(s.orbit, { x: 1, y: 2, z: 4.5, dist: 70, az: 45, el: 22, degPerSec: 18 });
  assert.deepEqual(parked, [1, 2, 4.5, 70, 45, 22]);
  assert.equal(PAGE.pageEnsureOrbit({ degPerSec: 30 }).source, "page");
  assert.equal(window.__hbOrbit.degPerSec, 18);
  assert.equal(PAGE.pageGateValue("1 + 1 === 2"), true); assert.equal(PAGE.pageGateValue("0"), false); assert.match(PAGE.pageGateValue("nope.x"), /^throw: /);
  assert.deepEqual(PAGE.pageGateInfo("({a: 1})"), { a: 1 });
});

await check("pageApplyPins reads the adapter (a throw-away WebGL2 context) only when asked", async () => {
  makeFakePage();
  let made = 0;
  globalThis.document = { createElement: () => { made++; return { getContext: () => ({ getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : null), getParameter: () => GTX }) }; } };
  try {
    const a = await PAGE.pageApplyPins({});
    assert.equal(made, 0); assert.equal(a.adapter, undefined);
    const b = await PAGE.pageApplyPins({ adapter: true });
    assert.equal(made, 1); assert.equal(b.adapter, GTX);
  } finally { delete globalThis.document; }
});

await check("applySessionPins / sessionPinProblems: DayGroup 0 applied on an attached session; skytime, window, port, adapter, URL pins checked", async () => {
  assert.equal(typeof BOOT.applySessionPins, "function");
  const F = driverFake();
  const ok = await BOOT.applySessionPins({ pg: F.pg, ctx: {} }, { inner: { w: 1920, h: 1080 }, port: PORT }, F.deps);
  assert.ok(F.log.includes("pins:dg0:adapter") && F.log.includes("sizeWindow:1920x1080"), F.log.join(","));
  assert.deepEqual(ok.dayGroup, { day: 39, year: 10, index: 0, datName: "Sunny" });
  assert.deepEqual(ok.problems, []);
  const G = driverFake({ sky: null, dgIndex: 7, inner: [1904, 961], adapter: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))" });
  G.pg.url = () => "http://127.0.0.1:8765/apps/holtburger-web/index.html?quality=ultra&nosw=1";
  const bad = await BOOT.applySessionPins({ pg: G.pg, ctx: {} }, { inner: { w: 1920, h: 1080 }, port: "8766" }, G.deps);
  const txt = bad.problems.join(" | ");
  for (const re of [/dayGroup 7 \(want 0\)/, /window inner 1904x961/, /served from :8765, want :8766/, /SwiftShader/, /url: targetFps/, /url: skytime not pinned/, /url: renderScale/, /url: adaptiveRes/]) assert.match(txt, re);
  const none = await BOOT.applySessionPins({ pg: driverFake().pg, ctx: {} }, { dayGroup: "none" }, driverFake().deps);
  assert.equal(none.dayGroup, null);
  assert.throws(() => BOOT.dayGroupPin(20));
});

await check("hbsweep runSweep / hbanatomy runEval: attach pins + orbit ensured; --boot boots the queue arm through bootArm", async () => {
  const F = driverFake();
  let pinArgs = null;
  const sw = await SWEEP.runSweep({ ...SWEEP.parseArgs(["--pose", "orbit", "--knobs", "ssao", "--inner", "1920,1080", "--port", PORT, "--no-box-samples"]), out: "/nowhere/sw.json" },
    { attach: async () => ({ pg: F.pg, ctx: {}, browser: { isRaw: true, close: async () => F.log.push("socketClose") } }),
      applySessionPins: async (_c, o) => { pinArgs = o; return { problems: [] }; }, write: () => {}, killBench: () => F.log.push("kill") });
  assert.equal(sw.error, undefined, sw.error);
  assert.deepEqual(pinArgs.inner, { w: 1920, h: 1080 }); assert.equal(pinArgs.port, PORT);
  assert.deepEqual(sw.orbit, { source: "set", orbit: { az: 45, degPerSec: 18 } });
  assert.ok(F.log.indexOf("ensureOrbit") < F.log.indexOf("sweep:info:ssao"));
  assert.ok(!F.log.includes("kill"), "an attached session is never killed");
  let booted = null;
  const B = driverFake();
  const sb = await SWEEP.runSweep({ ...SWEEP.parseArgs(["--boot", "--arms", QUEUE, "--item", "M1a-SWEEP", "--arm", "SW", "--knobs", "ssao", "--pose", "street", "--no-box-samples"]), out: "/nowhere/sb.json" },
    { bootArm: async (arm, o, x, res) => { booted = { arm: arm.name, quality: arm.quality, window: arm.window, port: o.port }; return { c: { pg: B.pg, browser: { close: async () => B.log.push("close") } } }; },
      write: () => {}, killBench: () => B.log.push("kill") });
  assert.equal(sb.error, undefined, sb.error);
  assert.deepEqual(booted, { arm: "SW", quality: "ultra", window: "1920,1080", port: "8766" });
  assert.ok(B.log.includes("close") && B.log[B.log.length - 1] === "kill");
  assert.throws(() => SWEEP.parseArgs(["--boot"]));
  // hbanatomy --attach --eval: pins first; --arm --eval: bootArm
  const { writeFileSync: wf, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "hbv2-"));
  const evalFile = join(dir, "e.eval.js"); wf(evalFile, "return 42;");
  const E = driverFake();
  let pa = null;
  const ea = await ANAT.runEval({ ...ANAT.parseArgs(["--attach", "--eval", evalFile, "--inner", "1920,1080", "--no-box-samples"]), out: join(dir, "a.json") },
    { attach: async () => ({ pg: E.pg, ctx: {}, browser: { isRaw: true, close: async () => {} } }), applySessionPins: async (_c, o) => { pa = o; return { problems: ["x"] }; }, write: () => {} });
  assert.equal(ea.result, 42); assert.deepEqual(pa.inner, { w: 1920, h: 1080 }); assert.deepEqual(ea.session, { problems: ["x"] });
  let ba = null;
  const E2 = driverFake();
  const eb = await ANAT.runEval({ ...ANAT.parseArgs(["--arms", QUEUE, "--item", "M1a-CEILING", "--arm", "SC", "--eval", evalFile, "--no-box-samples"]), out: join(dir, "b.json") },
    { bootArm: async (arm, o, x, res) => { ba = arm; res.serverState = {}; return { c: { pg: E2.pg, browser: { close: async () => E2.log.push("close") } } }; }, write: () => {}, killBench: () => E2.log.push("kill") });
  assert.equal(eb.result, 42); assert.equal(ba.flags, "renderOnDemand=1&netDrainHz=30"); assert.equal(eb.mode, "boot");
  assert.ok(E2.log.includes("close") && E2.log.includes("kill"));
  // 2026-10-30 (lane H2): a bootArm that LAUNCHED the test Chrome and then threw (gate false, boot never
  // ready, not on the 1070, a settle error) returns no session; BOTH tools must still kill the box
  // Chrome, or it stays logged in, in world, on the person's 1070 (hbanatomy's `if (booted)` did not).
  const launchedThenThrew = (log) => async (_arm, _o, _x, res) => { log.push("launch"); res.serverState = {}; throw new Error("gate failed: window.__x -> false"); };
  const T1 = [];
  const st = await SWEEP.runSweep({ ...SWEEP.parseArgs(["--boot", "--arms", QUEUE, "--item", "M1a-SWEEP", "--arm", "SW", "--knobs", "ssao", "--no-box-samples"]), out: "/nowhere/st.json" },
    { bootArm: launchedThenThrew(T1), write: () => {}, killBench: () => T1.push("kill") });
  assert.match(st.error, /^gate failed/); assert.deepEqual(T1, ["launch", "kill"], "hbsweep --boot after a bootArm throw");
  const T2 = [];
  const et = await ANAT.runEval({ ...ANAT.parseArgs(["--arms", QUEUE, "--item", "M1a-CEILING", "--arm", "SC", "--eval", evalFile, "--no-box-samples"]), out: join(dir, "t.json") },
    { bootArm: launchedThenThrew(T2), write: () => {}, killBench: () => T2.push("kill") });
  assert.match(et.error, /^gate failed/); assert.deepEqual(T2, ["launch", "kill"], "hbanatomy --arm --eval after a bootArm throw");
  // ... and a result write that fails (disk full, out dir gone) must not skip the kill either; the
  // error still surfaces. An attached session is never killed, write or no write.
  const bootedFake = (log, F) => async (_arm, _o, _x, res) => { log.push("launch"); res.serverState = {}; return { c: { pg: F.pg, browser: { close: async () => log.push("close") } } }; };
  const full = () => { throw new Error("ENOSPC: no space left on device"); };
  const T3 = [];
  await assert.rejects(SWEEP.runSweep({ ...SWEEP.parseArgs(["--boot", "--arms", QUEUE, "--item", "M1a-SWEEP", "--arm", "SW", "--knobs", "ssao", "--no-box-samples"]), out: "/nowhere/sw3.json" },
    { bootArm: bootedFake(T3, driverFake()), write: full, killBench: () => T3.push("kill") }), /ENOSPC/);
  assert.deepEqual(T3.slice(-2), ["close", "kill"], "hbsweep --boot after a failed write: " + T3.join(","));
  const T4 = [];
  await assert.rejects(ANAT.runEval({ ...ANAT.parseArgs(["--arms", QUEUE, "--item", "M1a-CEILING", "--arm", "SC", "--eval", evalFile, "--no-box-samples"]), out: join(dir, "t4.json") },
    { bootArm: bootedFake(T4, driverFake()), write: full, killBench: () => T4.push("kill") }), /ENOSPC/);
  assert.deepEqual(T4.slice(-2), ["close", "kill"], "hbanatomy --arm --eval after a failed write: " + T4.join(","));
  const T5 = [];
  await assert.rejects(ANAT.runEval({ ...ANAT.parseArgs(["--attach", "--eval", evalFile, "--no-box-samples", "--no-pins"]), out: join(dir, "t5.json") },
    { attach: async () => ({ pg: driverFake().pg, ctx: {}, browser: { isRaw: true, close: async () => T5.push("socketClose") } }), write: full, killBench: () => T5.push("kill") }), /ENOSPC/);
  assert.deepEqual(T5, ["socketClose"], "an attached session is only disconnected, never killed");
  (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
});

await check("hbsweep: a post-sweep box sample that rejects is recorded as {label, error}, the result is still written and the box Chrome still killed (--boot); attach mode records it too and never kills", async () => {
  // 2026-10-30 (lane H3): pins hbsweep's try/catch around the post-sweep sample. Without it the
  // rejection skipped the write (the sweep's windows lost) and runSweep rejected.
  const failingPost = (log) => async (label) => { log.push(`box:${label}`); if (label === "post-sweep") throw new Error("ssh: connect to host box port 22: Connection timed out"); return { label, who: { idle: 600 }, top: [] }; };
  const L = [], written = [];
  const F = driverFake();
  const r = await SWEEP.runSweep({ ...SWEEP.parseArgs(["--boot", "--arms", QUEUE, "--item", "M1a-SWEEP", "--arm", "SW", "--knobs", "ssao", "--pose", "street"]), out: "/nowhere/ps.json" },
    { bootArm: async () => { L.push("launch"); return { c: { pg: F.pg, browser: { close: async () => L.push("close") } } }; }, boxSample: failingPost(L),
      write: (_p, t) => { L.push("write"); written.push(JSON.parse(t)); }, killBench: () => L.push("kill") });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(L, ["launch", "box:pre-sweep", "box:post-sweep", "write", "close", "kill"], L.join(","));
  assert.equal(written.length, 1);
  const post = written[0].box.find((b) => b.label === "post-sweep");
  assert.ok(post && /Connection timed out/.test(post.error), JSON.stringify(written[0].box));
  assert.deepEqual(written[0].box.map((b) => b.label), ["pre-sweep", "post-sweep"]);
  const A = [], wa = [];
  const G = driverFake();
  const ra = await SWEEP.runSweep({ ...SWEEP.parseArgs(["--knobs", "ssao", "--pose", "street", "--no-pins"]), out: "/nowhere/pa.json" },
    { attach: async () => ({ pg: G.pg, ctx: {}, browser: { isRaw: true, close: async () => A.push("socketClose") } }), boxSample: failingPost(A),
      write: (_p, t) => { A.push("write"); wa.push(JSON.parse(t)); }, killBench: () => A.push("kill") });
  assert.equal(ra.error, undefined, ra.error);
  assert.deepEqual(A, ["box:pre-sweep", "box:post-sweep", "write", "socketClose"], A.join(","));
  assert.match(wa[0].box.find((b) => b.label === "post-sweep").error, /Connection timed out/);
});

await check("hbanatomy runArm (arm mode): the box Chrome is killed after a bootArm throw and after a failed anatomy.json write", async () => {
  assert.equal(typeof ANAT.runArm, "function", "hbanatomy.mjs exports runArm (with injectable deps)");
  const base = () => ({ ...ANAT.parseArgs(["--arms", QUEUE, "--item", "M1a-BENCH", "--arm", "A", "--phases", "programs", "--no-box-samples"]), out: "/nowhere/anat" });
  const L1 = [];
  const r1 = await ANAT.runArm(base(), { bootArm: async () => { L1.push("launch"); throw new Error("boot never ready"); }, mkdir: () => {}, write: () => {}, killBench: () => L1.push("kill") });
  assert.equal(r1.error, "boot never ready"); assert.deepEqual(L1, ["launch", "kill"]);
  const F = driverFake();
  const ok = await ANAT.runArm(base(), { bootArm: async (_a, _o, _x, res) => { res.serverState = {}; return { c: { pg: F.pg, browser: { close: async () => F.log.push("close") } }, orbit: {} }; },
    mkdir: () => {}, write: () => {}, killBench: () => F.log.push("kill") });
  assert.equal(ok.error, undefined, ok.error); assert.deepEqual(F.log.slice(-2), ["close", "kill"]);
  const G = driverFake();
  await assert.rejects(ANAT.runArm(base(), { bootArm: async (_a, _o, _x, res) => { res.serverState = {}; return { c: { pg: G.pg, browser: { close: async () => G.log.push("close") } }, orbit: {} }; },
    mkdir: () => {}, write: () => { throw new Error("EROFS: read-only file system"); }, killBench: () => G.log.push("kill") }), /EROFS/);
  assert.deepEqual(G.log.slice(-2), ["close", "kill"], G.log.join(","));
});

await check("runOne: a failed run-JSON write still closes the browser and kills the box Chrome (and the error surfaces)", async () => {
  const F = driverFake();
  F.deps.writeFile = () => { throw new Error("ENOSPC: no space left on device"); };
  await assert.rejects(BENCH.runOne({ name: "A", quality: "ultra", flags: "" }, 1, benchCtx({}), F.deps), /ENOSPC/);
  assert.deepEqual(F.log.slice(-2), ["close", "kill"], F.log.slice(-5).join(","));
  const G = driverFake(); // a throw before the launch: still killed (as before), nothing to close
  G.deps.prepareLaunch = async () => { throw new Error("cmd metacharacters are not allowed (x&y)"); };
  const r = await BENCH.runOne({ name: "A", quality: "ultra", flags: "" }, 1, benchCtx({}), G.deps);
  assert.match(r.error, /metacharacters/); assert.equal(G.log[G.log.length - 1], "kill"); assert.ok(!G.log.includes("close"));
});

await check("bootArm: a throw after the connect closes that connection before it propagates (the caller kills the box Chrome)", async () => {
  const F = driverFake({ adapter: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))" });
  await assert.rejects(BOOT.bootArm({ name: "A", quality: "ultra" }, { port: PORT }, null, { box: [], errors: [] }, F.deps), /not on 1070/);
  assert.equal(F.log[F.log.length - 1], "close", F.log.join(","));
  const G = driverFake({ gate: false });
  await assert.rejects(BOOT.bootArm(qArm("M1b-STRUCTURE", "S-rustEntityWorld"), { port: PORT }, null, { box: [], errors: [] }, G.deps), /gate failed/);
  assert.equal(G.log[G.log.length - 1], "close", G.log.join(","));
  const H = driverFake(); // CDP never answered: no connection was made, nothing to close
  H.deps.launchChrome = async () => { H.log.push("launch"); return false; };
  await assert.rejects(BOOT.bootArm({ name: "A", quality: "ultra" }, { port: PORT }, null, { box: [], errors: [] }, H.deps), /never answered/);
  assert.ok(!H.log.includes("close") && !H.log.includes("connect"), H.log.join(","));
});

await check("armKillOnSignal: Ctrl-C / SIGTERM / SIGHUP kill the bench Chrome once, then exit 128+n; disarm; every launching main() arms it, attach paths do not, import does not", async () => {
  const BOX = (await tryImport("lib/hb_box.mjs")).m || {};
  assert.equal(typeof BOX.armKillOnSignal, "function", "lib/hb_box.mjs exports armKillOnSignal");
  assert.equal(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP"), 0, "importing the drivers arms nothing");
  const { EventEmitter } = await import("node:events");
  // 2026-10-30 (lane H3): the fake exit() records how many kills had run AT THE MOMENT it was called.
  // A real process.exit() never returns, so a handler that exits first never kills (the Chrome stays up).
  const mk = (killsSoFar) => { const p = new EventEmitter(); p.exits = []; p.exit = (c) => p.exits.push({ code: c, killsBefore: killsSoFar() }); return p; };
  const SIG = ["SIGINT", "SIGTERM", "SIGHUP"];
  const kills = [];
  const P = mk(() => kills.length);
  const disarm = BOX.armKillOnSignal({ kill: () => kills.push(1), proc: P, log: () => {} });
  assert.deepEqual(SIG.map((s) => P.listenerCount(s)), [1, 1, 1]);
  P.emit("SIGINT"); P.emit("SIGTERM");
  assert.deepEqual([kills.length, P.exits], [1, [{ code: 130, killsBefore: 1 }]], "one kill, BEFORE exit 130 (a second signal while exiting does nothing)");
  disarm();
  assert.deepEqual(SIG.map((s) => P.listenerCount(s)), [0, 0, 0]);
  let k = 0;
  const Q = mk(() => k);
  BOX.armKillOnSignal({ kill: () => { k++; throw new Error("ssh: box gone"); }, proc: Q, log: () => {} });
  Q.emit("SIGTERM");
  assert.deepEqual([k, Q.exits], [1, [{ code: 143, killsBefore: 1 }]], "a failing kill still exits, after the kill was tried");
  let r = 0;
  const R = mk(() => r);
  BOX.armKillOnSignal({ kill: () => { r++; }, proc: R, log: () => {} });
  R.emit("SIGHUP"); assert.deepEqual(R.exits, [{ code: 129, killsBefore: 1 }]);
  // an exit() that never returns (as process.exit): the kill must already have happened
  let x = 0;
  const X = new EventEmitter();
  X.exit = () => { throw new Error("exited"); };
  BOX.armKillOnSignal({ kill: () => { x++; }, proc: X, log: () => {} });
  assert.throws(() => X.emit("SIGINT"), /exited/);
  assert.equal(x, 1, "killed before the exit that never returns");
  const mainOf = (f) => { const src = readFileSync(join(PW, f), "utf8"); return src.slice(src.indexOf("async function main(")); };
  const hb = mainOf("hbbench.mjs");
  assert.ok(hb.indexOf("armKillOnSignal();") > hb.indexOf("process.exit(3)") && hb.indexOf("armKillOnSignal();") < hb.indexOf("await runOne("), "hbbench main: armed after the dev-wasm abort, before the first arm");
  assert.match(mainOf("hbanatomy.mjs"), /if \(!o\.attach\) armKillOnSignal\(\);/);
  assert.match(mainOf("hbsweep.mjs"), /if \(o\.boot\) armKillOnSignal\(\);/);
});

await check("runOne --compat v1 records no v2-only assert (window / DayGroup / skytime null) and no assert problem; a v2 rep records the wrong inner size and an unpinned sky (what hbreport rule V reads)", async () => {
  const F = driverFake();
  const r = await BENCH.runOne({ name: "rc-defaults-ultra", quality: "ultra", flags: "" }, 2, benchCtx({ compat: "v1" }), F.deps);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual([r.asserts.window, r.asserts.dayGroup, r.asserts.skyTimePin], [null, null, null]);
  assert.deepEqual(r.assertProblems, []);
  const G = driverFake({ inner: [1904, 961], sky: null });
  const r2 = await BENCH.runOne({ name: "A", quality: "ultra", flags: "" }, 1, benchCtx({}), G.deps);
  assert.deepEqual(r2.assertProblems, ["skytime null (want 13)", "window inner 1904x961 (want 1920x1080)"]);
});

await check("M1b-OCC: O-rigs is gated on mode 'rigs' AND cellsSkipped > 0 (an old snapshot, the default mode or no skipped cell fails); planArm / runOne carry the gate", async () => {
  const arm = qArm("M1b-OCC", "O-rigs");
  assert.match(arm.gate || "", /__occlusionCull\.mode === 'rigs'/); assert.match(arm.gate, /cellsSkipped > 0/);
  const plan = BENCH.planArm(arm, { port: PORT });
  assert.equal(plan.gate, arm.gate);
  makeFakePage();
  for (const [occ, want] of [
    [undefined, false],                                        // no culler facade at all
    [{ enabled: true, stats: { proxies: 3, hidden: 1 } }, false], // a snapshot that predates =rigs: no mode, no cellsSkipped
    [{ mode: "on", stats: { proxies: 3 } }, false],            // =rigs read as the default mode
    [{ mode: "rigs", stats: null }, false],
    [{ mode: "rigs", stats: { proxies: 1, cellsSkipped: 0 } }, false], // no cell candidate went proxy-less yet
    [{ mode: "rigs", stats: { proxies: 1, cellsSkipped: 12 } }, true],
  ]) {
    if (occ === undefined) delete window.__occlusionCull; else window.__occlusionCull = occ;
    assert.equal(PAGE.pageGateValue(plan.gate), want, JSON.stringify(occ));
  }
  delete window.__occlusionCull;
  const F = driverFake({ gate: false });
  const r = await BENCH.runOne(arm, 1, benchCtx({}), F.deps);
  assert.match(r.error, /^gate failed: window\.__occlusionCull/);
  assert.ok(F.log.includes("gateInfo") && !F.log.some((x) => x.startsWith("frames:")), F.log.join(","));
  const it = QJ.items.find((x) => x.id === "M1b-OCC");
  assert.match(it.precondition, /MERGED round-3 phase-A tree/); assert.match(it.precondition, /cellsSkipped > 0/);
  // 2026-10-30 (lane H3): `--queue <file>` must be ON THE COMMAND. The old /hbreport\.py bench .*--queue /
  // also matched the trailing note "(--queue is required ...)", so a command without it passed.
  assert.ok(it.recipe.some(reportPassesQueue), "the report step passes --queue <file> (rule V holds O-rigs to its gate): " + it.recipe.join(" || "));
  assert.equal(reportPassesQueue("python3 -I scripts/perf-worker/hbreport.py bench <that dir> --box-events <this file> --ref A --aa A-AA   (--queue is required: it holds every O-rigs rep to the gate above)"), false);
  assert.equal(reportPassesQueue("python3 -I scripts/perf-worker/hbreport.py bench <that dir> --queue <this file> --ref A"), true);
  // every item with a gated arm: its hbreport bench step passes --queue on the command
  for (const g of QJ.items.filter((x) => (x.arms || []).some((a) => a.gate))) {
    assert.ok((g.recipe || []).some(reportPassesQueue), `${g.id}: a gated item's report step passes --queue <file>`);
  }
});

/** An hbreport.py bench recipe line whose COMMAND (the trailing "(...)" note stripped) passes `--queue <file>`. */
function reportPassesQueue(line) {
  const cmd = String(line).replace(/\s+\([^()]*\)\s*$/, "");
  return /hbreport\.py bench /.test(cmd) && /\s--queue (<this file>|\S+\.json)(\s|$)/.test(cmd);
}

await check("B0 snapshot check: the queue's requiredReaders are read from the snapshot's OWN files (a symlink into the live tree, a reader-less older copy, a missing file or the live tree itself fails)", async () => {
  assert.equal(typeof V2.snapshotReaderProblems, "function"); assert.equal(typeof BENCH.checkSnapshot, "function");
  const spec = QJ.b0Snapshot;
  assert.ok(spec && Array.isArray(spec.requiredReaders), "queue b0Snapshot.requiredReaders");
  const flags = spec.requiredReaders.map((r) => r.flag);
  for (const f of ["occlusionCull=rigs", "rigPoseSkip", "skipEmptyPasses", "uploadWarmDraw", "animSceneryBatch", "bakeFallbackWaves"]) assert.ok(flags.includes(f), f);
  assert.match(QJ.sessionRulesInline.join(" "), /MERGED round-3 phase-A tree/);
  assert.ok(QJ.items.find((x) => x.id === "M1-PRE").recipe.some((x) => /--check-snapshot/.test(x) && /MERGED round-3 phase-A tree/.test(x)));
  // the live working tree: all six readers are found (bakeFallbackWaves merged 2026-10-30, lane W2; the
  // queue pins it to its file since lane H3), so only a missing or symlinked pkg wasm may be a problem here
  const bfw = spec.requiredReaders.find((r) => r.flag === "bakeFallbackWaves");
  assert.equal(bfw.file, "apps/holtburger-web/scene3d/bake_worker_client.js"); assert.equal(bfw.dir, undefined);
  assert.ok(bfw.patterns.some((p) => p.includes('\\.get\\("bakeFallbackWaves"\\)')), bfw.patterns.join(" + "));
  const LIVE = join(PW, "../..");
  const live = BENCH.checkSnapshot(LIVE, QJ, BENCH.SNAPSHOT_IO, { liveRoot: null });
  const foundLive = live.found.map((f) => f.flag);
  for (const f of ["occlusionCull=rigs", "rigPoseSkip", "skipEmptyPasses", "uploadWarmDraw", "animSceneryBatch", "bakeFallbackWaves"]) assert.ok(foundLive.includes(f), `${f}: ${live.problems.join("; ")}`);
  assert.deepEqual(live.found.find((f) => f.flag === "bakeFallbackWaves"), { flag: "bakeFallbackWaves", file: "apps/holtburger-web/scene3d/bake_worker_client.js" });
  assert.ok(live.problems.every((p) => /^release pkg/.test(p)), live.problems.join("; "));
  assert.ok(BENCH.checkSnapshot(LIVE, QJ, BENCH.SNAPSHOT_IO, { liveRoot: LIVE }).problems.some((p) => /is the live tree/.test(p)), "the live tree is refused as B0");
  // synthetic snapshots
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const T = fs.mkdtempSync(join(tmpdir(), "hbv2-snap-"));
  try {
    const put = (root, rel, text) => { fs.mkdirSync(dirname(join(root, rel)), { recursive: true }); fs.writeFileSync(join(root, rel), text); };
    const spec2 = { requiredReaders: [
      { flag: "occlusionCull=rigs", file: "apps/w/scene3d/occlusion_cull.js", patterns: ["if \\(v === \"rigs\"\\) return \"rigs\";", "cellsSkipped \\+= 1"] },
      { flag: "rigPoseSkip", file: "apps/w/scene3d/motion/motion_sequence.js", patterns: ["rustFlag\\(\"rigPoseSkip\", false\\)"] },
      { flag: "bakeFallbackWaves", dir: "apps/w/scene3d", patterns: ["(rustFlag\\(\\s*|\\.get\\(\\s*)[\"']bakeFallbackWaves[\"']"] },
      { flag: "pkg", file: "apps/w/pkg/x.wasm", patterns: [] },
    ] };
    const live2 = join(T, "live"), snap = join(T, "snap");
    const OCC = 'if (v === "rigs") return "rigs";\n this.stats.cellsSkipped += 1;\n';
    put(live2, "apps/w/scene3d/occlusion_cull.js", OCC);
    put(live2, "apps/w/scene3d/motion/motion_sequence.js", 'RIG = rustFlag("rigPoseSkip", false) === true;');
    put(live2, "apps/w/scene3d/bake/worker_client.js", 'const W = rustFlag("bakeFallbackWaves", false);');
    put(live2, "apps/w/pkg/x.wasm", "\0asm");
    // a good snapshot: real copies everywhere, the bakeFallbackWaves reader two levels down
    put(snap, "apps/w/scene3d/occlusion_cull.js", OCC);
    put(snap, "apps/w/scene3d/motion/motion_sequence.js", 'RIG = rustFlag("rigPoseSkip", false) === true;');
    put(snap, "apps/w/scene3d/bake/worker_client.js", 'const W = new URLSearchParams(location.search).get("bakeFallbackWaves");');
    put(snap, "apps/w/pkg/x.wasm", "\0asm");
    const good = V2.snapshotReaderProblems(snap, spec2, BENCH.SNAPSHOT_IO, { liveRoot: live2 });
    assert.deepEqual(good.problems, []); assert.equal(good.ok, true);
    assert.deepEqual(good.found.find((f) => f.flag === "bakeFallbackWaves"), { flag: "bakeFallbackWaves", file: "apps/w/scene3d/bake/worker_client.js" });
    // 2026-10-30 (lane H3): a symlinked .js FILE in a `dir` walk is skipped as well (lstat reports it as
    // a non-directory, so only the isSymlink test keeps the live tree's reader out of the snapshot)
    const snapF = join(T, "snapF");
    const specF = { requiredReaders: [{ flag: "bakeFallbackWaves", dir: "apps/w/scene3d", patterns: spec2.requiredReaders[2].patterns }] };
    put(snapF, "apps/w/scene3d/occlusion_cull.js", OCC);
    fs.symlinkSync(join(live2, "apps/w/scene3d/bake/worker_client.js"), join(snapF, "apps/w/scene3d/linked_client.js"));
    const sf = V2.snapshotReaderProblems(snapF, specF, BENCH.SNAPSHOT_IO, { liveRoot: live2 });
    assert.equal(sf.ok, false, JSON.stringify(sf.found));
    assert.deepEqual(sf.problems.map((p) => p.split(" (")[0]), ["bakeFallbackWaves: no reader under apps/w/scene3d"]);
    fs.rmSync(join(snapF, "apps/w/scene3d/linked_client.js")); // the same text as the snapshot's own copy is found
    put(snapF, "apps/w/scene3d/linked_client.js", fs.readFileSync(join(live2, "apps/w/scene3d/bake/worker_client.js"), "utf8"));
    assert.deepEqual(V2.snapshotReaderProblems(snapF, specF, BENCH.SNAPSHOT_IO, { liveRoot: live2 }).found, [{ flag: "bakeFallbackWaves", file: "apps/w/scene3d/linked_client.js" }]);
    // pkg symlinked into the live tree (hb-mksnap.sh's default) + an older occlusion_cull.js without =rigs
    fs.rmSync(join(snap, "apps/w/pkg"), { recursive: true }); fs.symlinkSync(join(live2, "apps/w/pkg"), join(snap, "apps/w/pkg"));
    put(snap, "apps/w/scene3d/occlusion_cull.js", "return !(v === \"off\" || v === \"0\");\n");
    // the bakeFallbackWaves reader only reachable through a symlinked dir: not the snapshot's own code
    fs.rmSync(join(snap, "apps/w/scene3d/bake"), { recursive: true }); fs.symlinkSync(join(live2, "apps/w/scene3d/bake"), join(snap, "apps/w/scene3d/bake"));
    const bad = V2.snapshotReaderProblems(snap, spec2, BENCH.SNAPSHOT_IO, { liveRoot: live2 });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.problems.map((p) => p.split(":")[0]).sort(), ["bakeFallbackWaves", "occlusionCull=rigs", "pkg"], bad.problems.join(" | "));
    assert.match(bad.problems.find((p) => p.startsWith("pkg")), /apps\/w\/pkg is a symlink/);
    assert.match(bad.problems.find((p) => p.startsWith("occlusionCull")), /reader not found/);
    // a whole scene3d dir symlinked into the live tree fails every requirement under it, even though the readers are there
    fs.rmSync(join(snap, "apps/w/scene3d"), { recursive: true }); fs.symlinkSync(join(live2, "apps/w/scene3d"), join(snap, "apps/w/scene3d"));
    const linked = V2.snapshotReaderProblems(snap, spec2, BENCH.SNAPSHOT_IO, { liveRoot: live2 });
    assert.equal(linked.problems.filter((p) => /scene3d is a symlink/.test(p)).length, 3, linked.problems.join(" | "));
    // missing files, the live tree as "snapshot", no requirements, no snapshot dir
    assert.ok(V2.snapshotReaderProblems(live2, spec2, BENCH.SNAPSHOT_IO, { liveRoot: live2 }).problems.some((p) => /is the live tree/.test(p)));
    const empty = join(T, "empty"); fs.mkdirSync(empty);
    assert.ok(V2.snapshotReaderProblems(empty, spec2, BENCH.SNAPSHOT_IO).problems.every((p) => /missing/.test(p)));
    assert.deepEqual(V2.snapshotReaderProblems(snap, {}, BENCH.SNAPSHOT_IO).problems, ["the queue has no b0Snapshot.requiredReaders"]);
    assert.equal(V2.snapshotReaderProblems(join(T, "nope"), spec2, BENCH.SNAPSHOT_IO).ok, false);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

// 2026-10-30 (lane H3): the REAL b0Snapshot patterns, negatively. The check above proves they find the
// merged readers; this one proves they are not so loose that a pre-round-3 tree passes too (a pattern
// weakened to `occlusion` would make an old snapshot look like B0 and every gated arm an A/A).
const HEAD_REV = "95240def"; // HEAD when round 3 phase A started: none of the six readers existed
await check(`B0: every real requiredReaders entry FAILS on a HEAD-${HEAD_REV}-shaped snapshot (each pattern on its own, against the file as it was), and each pattern matches only code lines of the merged reader`, async () => {
  const { spawnSync } = await import("node:child_process");
  const reqs = QJ.b0Snapshot.requiredReaders;
  // HB_GIT_ROOT: external/holtburger of a git checkout (for a copy of this suite outside the repo)
  const GIT_ROOT = process.env.HB_GIT_ROOT || join(PW, "../..");
  const git = (args, input) => spawnSync("git", ["-C", GIT_ROOT, ...args], { input, maxBuffer: 256 << 20 });
  const ls = git(["ls-tree", "-r", "-z", HEAD_REV, "--", ...new Set(reqs.map((q) => q.file || q.dir))]);
  assert.equal(ls.status, 0, `git ls-tree ${HEAD_REV} in ${GIT_ROOT}: this check needs the git object ${HEAD_REV} (${String(ls.stderr)})`);
  const entries = String(ls.stdout).split("\0").filter(Boolean).map((l) => { const [meta, path] = l.split("\t"); const [mode, type, sha] = meta.split(" "); return { mode, type, sha, path }; })
    .filter((e) => e.type === "blob" && (reqs.some((q) => q.file === e.path) || /\.m?js$/.test(e.path)));
  const files = new Map();
  if (entries.length) {
    const cat = git(["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n");
    assert.equal(cat.status, 0, String(cat.stderr));
    let at = 0;
    for (const e of entries) {
      const nl = cat.stdout.indexOf(10, at);
      const size = +cat.stdout.subarray(at, nl).toString().split(" ")[2];
      files.set(e.path, { text: cat.stdout.subarray(nl + 1, nl + 1 + size).toString("utf8"), symlink: e.mode === "120000" });
      at = nl + 1 + size + 1;
    }
  }
  // hb-mksnap.sh's shape: scene3d/ copied, pkg/ (gitignored, so not in the tree) a symlink into the live tree
  const ROOT = `/hb-snap/head-${HEAD_REV}`, LINKED = ["apps/holtburger-web/pkg", "apps/holtburger-web/docs"];
  const rel = (p) => (p === ROOT ? "" : p.slice(ROOT.length + 1));
  const io = {
    realpath: (p) => p,
    lstat: (p) => {
      const r = rel(p);
      if (LINKED.includes(r)) return { isSymlink: true, isDir: false };
      if (files.has(r)) return { isSymlink: files.get(r).symlink, isDir: false };
      return [...files.keys()].some((k) => k.startsWith(r + "/")) || LINKED.some((k) => k.startsWith(r + "/")) ? { isSymlink: false, isDir: true } : null;
    },
    readText: (p) => files.get(rel(p)).text,
    readdir: (p) => { const r = rel(p); return [...new Set([...files.keys()].filter((k) => k.startsWith(r + "/")).map((k) => k.slice(r.length + 1).split("/")[0]))]; },
  };
  const r = V2.snapshotReaderProblems(ROOT, QJ.b0Snapshot, io, { liveRoot: null });
  assert.equal(r.ok, false);
  assert.deepEqual(r.found, [], `found at ${HEAD_REV}: ${JSON.stringify(r.found)}`);
  assert.deepEqual(r.problems.map((p) => p.split(":")[0]), reqs.map((q) => q.flag), r.problems.join(" | "));
  let patternsChecked = 0;
  for (const q of reqs) {
    const prob = r.problems.find((p) => p.startsWith(`${q.flag}:`));
    const pats = q.patterns || [];
    if (!pats.length) { assert.match(prob, /is a symlink|missing/, prob); continue; } // the pkg copy requirement
    const texts = q.file ? (files.has(q.file) ? [files.get(q.file).text] : []) : [...files].filter(([k]) => k.startsWith(`${q.dir}/`)).map(([, v]) => v.text);
    if (!texts.length) { assert.match(prob, /missing/, prob); continue; } // a reader file round 3 added
    assert.match(prob, /reader not found|no reader under/, prob);
    for (const p of pats) {
      patternsChecked++;
      assert.ok(texts.every((t) => !new RegExp(p).test(t)), `${q.flag}: pattern ${p} already matches the ${HEAD_REV} tree`);
    }
  }
  assert.ok(patternsChecked >= 6, `patterns checked against ${HEAD_REV}: ${patternsChecked}`);
  // and in the merged live file each pattern hits code, never only a comment or doc line naming the flag
  for (const q of reqs.filter((x) => x.file && (x.patterns || []).length)) {
    const lines = readFileSync(join(PW, "../..", q.file), "utf8").split("\n");
    for (const p of q.patterns) {
      const hits = lines.filter((l) => new RegExp(p).test(l));
      assert.ok(hits.length >= 1, `${q.flag}: ${p} matches no single line of ${q.file}`);
      assert.ok(hits.every((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)), `${q.flag}: ${p} matches a comment line of ${q.file}: ${hits.find((l) => /^\s*(\/\/|\/\*|\*)/.test(l))}`);
    }
  }
});

await check("layer-mip control: dark RGB + one 1-LSB change per channel; a raw readback passes, an sRGB-decoding one fails (alpha alone could not tell)", async () => {
  const r = await runEvalBody("layer-mip-probe.eval.js", { selfTest: true });
  assert.ok(r.control, "selfTest reports the control");
  assert.deepEqual(r.control.at, [0, 5, 10, 15]);
  assert.ok(r.control.darkRgb.every((v) => v <= 6), "RGB bytes an sRGB decode maps to linear 0");
  assert.deepEqual(r.control.raw, { raw: true, sensitive: true, detected: true, diffAt: [0, 5, 10, 15] });
  assert.equal(r.control.decoded.detected, false); assert.equal(r.control.decoded.raw, false); assert.deepEqual(r.control.decoded.diffAt, [15]);
  assert.equal(r.control.alphaOnlyDecoded, true);
});

await check("the M1 queue's decision rules are the plan's section 5 text verbatim (while no item has a result)", () => {
  const plan = readFileSync(join(PW, "../../apps/holtburger-web/docs/2026-10-29-round3-gpu-driven.md"), "utf8");
  const sec = plan.slice(plan.indexOf("## 5. Decision rules"), plan.indexOf("## 6. Risks"));
  // the queue file is ASCII: >= <= - ' for the plan's ≥ ≤ − ′ (and the plan's table escapes |)
  const norm = (t) => t.replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/−/g, "-").replace(/′/g, "'").replace(/\\\|/g, "|").replace(/\s+/g, " ").trim();
  const rows = {};
  for (const line of sec.split("\n")) {
    const m = /^\| \*\*(V|R\d+) \([^)]*\)\*\* \| (.*) \|\s*$/.exec(line);
    if (m) rows[m[1]] = norm(m[2]);
  }
  assert.equal(Object.keys(rows).length, 11, Object.keys(rows).join(","));
  if (QJ.items.some((it) => it.result !== null && it.result !== undefined)) { console.log("       (results recorded: the rules were frozen at run time; text check skipped)"); return; }
  for (const r of QJ.decisionRules) assert.equal(norm(r.text), rows[r.rule], `rule ${r.rule}`);
});

await check("every lane module parses and imports without side effects (the import of lib/hb_session.mjs stands in for its `node --check`, which the oom-guard hook refuses)", () => {
  for (const [k, v] of Object.entries({ hb_session: SESS, hb_boot: BOOT, hbanatomy: ANAT, hbsweep: SWEEP })) assert.ok(Object.keys(v).length > 0, `${k} did not import`);
  assert.equal(typeof SESS.sizeWindow, "function"); assert.equal(typeof SESS.attach, "function");
});

await check("no check reached ssh (the 1070 is never contacted by this suite)", () => {
  assert.equal(existsSync(SSH_LOG) ? readFileSync(SSH_LOG, "utf8") : "", "");
});

(await import("node:fs")).rmSync(SSH_GUARD, { recursive: true, force: true });
console.log(`\nhb_v2: ${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILED: " + failures.join("; ")); process.exit(1); }
