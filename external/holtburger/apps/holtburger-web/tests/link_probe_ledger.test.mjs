// 2026-10-13 (test-tooling-5) — the `?linkProbe=on` program create/release
// ledger in scene3d/shader_prewarm.js installLinkProbe.
//
// three destroys a WebGLProgram when the last material holding its cache key
// is released and links it again for the next material with that key. Every
// other program count in the client is `renderer.info.programs.length`, which
// cannot see a release + create in the same window. The ledger diffs
// `renderer.info.programs` BY id and counts a create of a key it has seen
// before as a RELINK. After WebAC tools/hitch-probe.ts (AGPL-3.0).
//
// Fake renderer {getContext, info:{programs:[]}}; ticks are driven by hand
// (`ledgerMs: 0`) except in the timer case.
// Run:
//   cd apps/holtburger-web/
//   node tests/link_probe_ledger.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

globalThis.window = globalThis;
globalThis.location = { search: "" }; // ?linkProbe absent: only {force:true} installs
const origInfo = console.info;
console.info = () => {}; // the install banner, once per case

const SP = await import("../scene3d/shader_prewarm.js");
const { installLinkProbe, LINK_LEDGER_CAP, LINK_LEDGER_MS } = SP;

const fakeGl = () => ({ linkProgram() {}, getProgramParameter() { return true; } });
const prog = (id, cacheKey, name = "", type = "ShaderMaterial") => ({ id, cacheKey, name, type, usedTimes: 1 });
// `timer: true` keeps the default ledger timer; otherwise ticks are by hand.
function rig(initial = [], { timer = false } = {}) {
  const gl = fakeGl();
  const renderer = { getContext: () => gl, info: { programs: initial.slice() } };
  const probe = installLinkProbe(renderer, timer ? { force: true } : { force: true, ledgerMs: 0 });
  return { gl, renderer, probe, progs: () => renderer.info.programs };
}
// three's releaseProgram: swap-remove (programs[i] = last; pop()).
function release(arr, id) {
  const i = arr.findIndex((p) => p.id === id);
  if (i < 0) return;
  arr[i] = arr[arr.length - 1];
  arr.pop();
}
const ops = (led) => led.map((e) => `${e.op}${e.id}`).join(",");

// ── 0. gate ────────────────────────────────────────────────────────────────
{
  const gl = fakeGl();
  check("flag off, no force: installLinkProbe returns null", installLinkProbe({ getContext: () => gl, info: { programs: [] } }) === null);
  check("LINK_LEDGER_CAP is 2000", LINK_LEDGER_CAP === 2000);
  check("LINK_LEDGER_MS is 50 (the WebAC hitch-probe cadence)", LINK_LEDGER_MS === 50);
}

// ── 1. release then re-create of one key is a relink ──────────────────────
{
  const { probe, progs } = rig();
  check("probe installs with {force:true}", !!probe && typeof probe.ledger === "function");
  check("probe is published as window.__linkProbe", globalThis.__linkProbe === probe);
  progs().push(prog(1, "A", "matA"));
  probe.ledgerTick();
  release(progs(), 1);
  probe.ledgerTick();
  progs().push(prog(2, "A", "matA"));
  probe.ledgerTick();
  const led = probe.ledger();
  check("ledger is [+1, -1, +2]", ops(led) === "+1,-1,+2", ops(led));
  check("first create is not a relink", led[0].relink === false);
  check("second create of key A is a relink", led[2].relink === true);
  check("entries carry name/type/key", led[0].name === "matA" && led[0].type === "ShaderMaterial" && led[0].key === "A");
  check("entries carry a timestamp", typeof led[0].t === "number" && led[2].t >= led[0].t);
  const st = probe.ledgerStats();
  check("relinks=1", st.relinks === 1, JSON.stringify(st));
  check("distinctKeys=1", st.distinctKeys === 1);
  check("created=2 released=1 resident=1", st.created === 2 && st.released === 1 && st.resident === 1);
  check("stats.ledger mirrors the counters", probe.stats.ledger.relinks === 1 && probe.stats.ledger.created === 2);
  const rk = probe.relinkedKeys();
  check("relinkedKeys names key A once", rk.length === 1 && rk[0].key === "A" && rk[0].relinks === 1 && rk[0].name === "matA");
  const s = probe.summary();
  check("summary() carries relinks/distinctKeys/released", /relinks=1 distinctKeys=1 released=1/.test(s), s);
  check("summary() keeps the existing link buckets first", /^linkProgram=0 \| LINK_STATUS 0 reads/.test(s));
  check("a tick with no change logs nothing", probe.ledgerTick() === 0 && probe.ledger().length === 3);
}

// ── 2. same-tick swap: length unchanged, both logged ──────────────────────
{
  const { probe, progs } = rig();
  progs().push(prog(3, "B"));
  probe.ledgerTick();
  const len0 = progs().length;
  release(progs(), 3);
  progs().push(prog(4, "C"));
  check("swap leaves the length unchanged", progs().length === len0);
  check("the swap tick logs two entries", probe.ledgerTick() === 2);
  check("ledger is [+3, -3, +4] (release logged before create)", ops(probe.ledger()) === "+3,-3,+4", ops(probe.ledger()));
  check("a different key is not a relink", probe.ledgerStats().relinks === 0 && probe.ledger()[2].relink === false);
  // Same key swapped inside one tick: still a relink.
  release(progs(), 4);
  progs().push(prog(5, "C"));
  probe.ledgerTick();
  check("same-key swap in one tick is a relink", probe.ledgerStats().relinks === 1 && probe.ledger()[4].relink === true, ops(probe.ledger()));
  // Several creates in one tick land in id (= creation) order regardless of
  // the array's swap-remove order.
  progs().push(prog(9, "Z"), prog(7, "X"), prog(8, "Y"));
  probe.ledgerTick();
  check("creates in one tick are logged in id order", ops(probe.ledger().slice(-3)) === "+7,+8,+9", ops(probe.ledger()));
}

// ── 3. the ring caps at LINK_LEDGER_CAP, oldest dropped, order kept ───────
{
  const { probe, progs } = rig();
  for (let i = 0; i < 1500; i++) progs().push(prog(i, "k" + i));
  probe.ledgerTick();
  for (let i = 1500; i < 2100; i++) progs().push(prog(i, "k" + i));
  probe.ledgerTick();
  const led = probe.ledger();
  check("ring holds exactly 2000 entries", led.length === 2000, String(led.length));
  check("oldest 100 entries dropped", led[0].id === 100 && led[1999].id === 2099, `${led[0].id}..${led[1999].id}`);
  check("ledger() is chronological across the wrap", led.every((e, i) => i === 0 || e.id === led[i - 1].id + 1));
  check("dropped counter = 100", probe.ledgerStats().dropped === 100);
  check("counters are not capped by the ring", probe.ledgerStats().created === 2100);
}

// ── 4. fail-soft without renderer.info.programs ───────────────────────────
{
  const gl = fakeGl();
  const probe = installLinkProbe({ getContext: () => gl }, { force: true, ledgerMs: 0 });
  check("no info: probe still installs", !!probe);
  check("no info: ledgerTick() returns 0", probe.ledgerTick() === 0);
  check("no info: ledger() is empty", Array.isArray(probe.ledger()) && probe.ledger().length === 0);
  check("no info: ledgerStats().available === false", probe.ledgerStats().available === false);
  check("no info: summary() says n/a", /programs ledger n\/a/.test(probe.summary()));
  // stall_probe's own mock shape: programs is {length:1}, not an array.
  const gl2 = fakeGl();
  const p2 = installLinkProbe({ getContext: () => gl2, info: { programs: { length: 1 } } }, { force: true, ledgerMs: 0 });
  check("array-like programs: fail-soft", p2.ledgerTick() === 0 && p2.ledgerStats().available === false);
  // A throwing getter (lost context in a mock) never escapes.
  const gl3 = fakeGl();
  const r3 = { getContext: () => gl3, get info() { throw new Error("boom"); } };
  let threw = false;
  let p3 = null;
  try {
    p3 = installLinkProbe(r3, { force: true, ledgerMs: 0 });
    p3.ledgerTick(); p3.ledger(); p3.summary(); p3.ledgerStats(); p3.relinkedKeys();
  } catch (_) { threw = true; }
  check("throwing renderer.info: nothing throws", !threw && !!p3);
  // The GL wraps are untouched by the ledger.
  gl.linkProgram({});
  check("linkProgram still counted", probe.stats.linkProgramCalls === 1);
}

// ── 5. install baseline, reset(), long keys, context restore ──────────────
{
  const { probe, progs, renderer } = rig([prog(10, "S"), prog(11, "T")]);
  const st0 = probe.ledgerStats();
  check("programs resident at install are seeded, not logged", st0.seeded === 2 && probe.ledger().length === 0 && st0.created === 0);
  release(progs(), 10);
  progs().push(prog(12, "S"));
  probe.ledgerTick();
  check("re-creating a seeded key is a relink", probe.ledgerStats().relinks === 1, ops(probe.ledger()));

  probe.reset();
  check("reset() clears the ring and window counters", probe.ledger().length === 0 && probe.ledgerStats().relinks === 0 && probe.relinkedKeys().length === 0);
  release(progs(), 12);
  progs().push(prog(13, "S"));
  probe.ledgerTick();
  check("reset() keeps key memory: a later relink still counts", probe.ledgerStats().relinks === 1 && probe.ledgerStats().distinctKeys === 2);

  // Long keys: the ledger shows 400 chars, identity is the FULL key.
  const pre = "x".repeat(500);
  progs().push(prog(14, pre + "-one"));
  probe.ledgerTick();
  release(progs(), 14);
  progs().push(prog(15, pre + "-two"));
  probe.ledgerTick();
  const led = probe.ledger();
  const e14 = led.find((e) => e.id === 14);
  check("ledger key truncated to 400 chars + ellipsis", e14 && e14.key.length === 401 && e14.key.endsWith("…"));
  check("keys sharing a 400-char prefix are distinct (no false relink)", probe.ledgerStats().relinks === 1 && led.find((e) => e.id === 15).relink === false);

  // Context restore: three swaps in a fresh programs array.
  const before = probe.ledgerStats();
  renderer.info.programs = progs().map((p) => prog(p.id + 100, p.cacheKey));
  probe.ledgerTick();
  const after = probe.ledgerStats();
  check("context restore: every old program released", after.released - before.released === before.resident);
  check("context restore: every re-create is a relink", after.relinks - before.relinks === before.resident, `${before.resident} resident`);
}

// ── 5b. stage-keyed programs: relink identity is the linked GLSL ──────────
// A ShaderMaterial / RawShaderMaterial key starts with two WebGLShaderStage
// ids, and three mints NEW ids once the last material using that source is
// disposed — so a real relink arrives under a new key. The ledger matches
// those on gl.getShaderSource(vs/fs) + the key minus its two ids.
{
  const srcGl = () => {
    const gl = fakeGl();
    gl.sourceReads = 0;
    gl.getShaderSource = function (sh) { this.sourceReads += 1; return sh ? sh.src : null; };
    return gl;
  };
  const sprog = (id, cacheKey, vs, fs, name = "vfx") =>
    ({ ...prog(id, cacheKey, name), vertexShader: { src: vs }, fragmentShader: { src: fs } });
  function srig(initial = [], gl = srcGl()) {
    const renderer = { getContext: () => gl, info: { programs: initial.slice() } };
    const probe = installLinkProbe(renderer, { force: true, ledgerMs: 0 });
    return { gl, probe, progs: () => renderer.info.programs };
  }
  const TAIL = ",USE_FOG,true,highp,srgb,onBeforeCompile";

  {
    const { gl, probe, progs } = srig();
    progs().push(sprog(1, "3,4" + TAIL, "VS-A", "FS-A"));
    probe.ledgerTick();
    release(progs(), 1);
    // the stage was freed: the same GLSL comes back under re-minted ids 7,8
    progs().push(sprog(2, "7,8" + TAIL, "VS-A", "FS-A"));
    probe.ledgerTick();
    const led = probe.ledger();
    check("stage-keyed: re-minted ids, same GLSL + tail is a relink", led[2] && led[2].relink === true, ops(led));
    const st = probe.ledgerStats();
    check("stage-keyed: relinks=1, distinctKeys=1", st.relinks === 1 && st.distinctKeys === 1, JSON.stringify(st));
    check("stage-keyed: stageKeyed=2 noSource=0", st.stageKeyed === 2 && st.stageKeyedNoSource === 0);
    check("stage-keyed: probe.stats.ledger carries the counters", probe.stats.ledger.stageKeyed === 2 && probe.stats.ledger.stageKeyedNoSource === 0);
    check("stage-keyed: two source reads per create", gl.sourceReads === 4, String(gl.sourceReads));
    const rk = probe.relinkedKeys();
    check("stage-keyed: relinkedKeys flags it stage:true", rk.length === 1 && rk[0].stage === true && rk[0].name === "vfx");
    check("stage-keyed: summary() carries stageKeyed / noSource", /stageKeyed=2 noSource=0$/.test(probe.summary()), probe.summary());

    // Different GLSL under fresh ids: a first create.
    progs().push(sprog(3, "9,10" + TAIL, "VS-B", "FS-A"));
    probe.ledgerTick();
    check("stage-keyed: different vertex GLSL is not a relink", probe.ledger().at(-1).relink === false);
    // Same GLSL, different tail (defines / customProgramCacheKey): distinct.
    progs().push(sprog(4, "11,12,USE_FOG,false,highp,srgb,onBeforeCompile", "VS-A", "FS-A"));
    probe.ledgerTick();
    check("stage-keyed: same GLSL, different key tail is not a relink", probe.ledger().at(-1).relink === false);
    // Built-in keys keep full-key identity and read no GL.
    const reads0 = gl.sourceReads;
    progs().push(prog(5, "physical,USE_FOG,true"), prog(6, "12,physical,x"), prog(13, "14"));
    probe.ledgerTick();
    check("built-in / non-digit-pair / one-field keys read no shader source", gl.sourceReads === reads0, String(gl.sourceReads - reads0));
    check("built-in creates do not count as stage-keyed", probe.ledgerStats().stageKeyed === 4);
  }

  {
    // Seeded at install, freed, re-created under new ids: still a relink.
    const { probe, progs } = srig([sprog(20, "1,2" + TAIL, "VS-S", "FS-S")]);
    release(progs(), 20);
    progs().push(sprog(21, "5,6" + TAIL, "VS-S", "FS-S"));
    probe.ledgerTick();
    check("stage-keyed: a seeded program re-created under new ids is a relink", probe.ledgerStats().relinks === 1, ops(probe.ledger()));
  }

  {
    // No getShaderSource (mock) / unreadable source: full-key fallback,
    // counted as noSource — a re-minted relink is under-counted, never invented.
    const { probe, progs } = srig([], fakeGl());
    progs().push(sprog(30, "3,4" + TAIL, "VS-A", "FS-A"));
    probe.ledgerTick();
    release(progs(), 30);
    progs().push(sprog(31, "7,8" + TAIL, "VS-A", "FS-A"));
    probe.ledgerTick();
    const st = probe.ledgerStats();
    check("no getShaderSource: falls back to the key (relinks=0, noSource=2)", st.relinks === 0 && st.stageKeyed === 2 && st.stageKeyedNoSource === 2, JSON.stringify(st));

    const gl2 = srcGl();
    const { probe: p2, progs: pr2 } = srig([], gl2);
    pr2().push(sprog(40, "3,4" + TAIL, null, "FS-A"));
    let threw = false;
    try { p2.ledgerTick(); } catch (_) { threw = true; }
    check("null shader source (lost context): no throw, noSource=1", !threw && p2.ledgerStats().stageKeyedNoSource === 1);
    const gl3 = srcGl();
    gl3.getShaderSource = () => { throw new Error("lost"); };
    const { probe: p3, progs: pr3 } = srig([], gl3);
    pr3().push(sprog(41, "3,4" + TAIL, "VS-A", "FS-A"));
    threw = false;
    try { p3.ledgerTick(); } catch (_) { threw = true; }
    check("throwing getShaderSource: no throw, create still logged", !threw && p3.ledgerStats().created === 1 && p3.ledgerStats().stageKeyedNoSource === 1);
  }
}

// ── 6. the 50 ms timer ticks on its own and stops ─────────────────────────
{
  const { probe, progs } = rig([], { timer: true });
  check("default install arms the timer at LINK_LEDGER_MS", probe.ledgerStats().timerMs === LINK_LEDGER_MS);
  progs().push(prog(20, "timer"));
  const created0 = probe.stats.ledger.created;
  await new Promise((r) => setTimeout(r, LINK_LEDGER_MS * 3));
  check("timer logged the create without a read", probe.stats.ledger.created === created0 + 1);
  probe.stopLedger();
  check("stopLedger() clears the timer", probe.ledgerStats().timerMs === 0);
  progs().push(prog(21, "late"));
  await new Promise((r) => setTimeout(r, LINK_LEDGER_MS * 3));
  check("stopped: no tick until a read", probe.stats.ledger.created === created0 + 1);
  check("stopped: a read still diffs", probe.ledger().some((e) => e.id === 21) && probe.stats.ledger.created === created0 + 2);
}

// ── 7. the three r184 facts the ledger stands on ─────────────────────────
{
  let src = "";
  try {
    src = readFileSync(joinPath(__dirname, "..", "node_modules", "three", "build", "three.module.js"), "utf8");
  } catch (_) { /* reported below */ }
  check("three: info.programs IS the program cache array", src.includes("info.programs = programCache.programs;"));
  check("three: program ids come from a never-reused counter", src.includes("this.id = programIdCount ++;"));
  check("three: releaseProgram destroys at usedTimes 0", /if \( -- program\.usedTimes === 0 \)[\s\S]{0,400}program\.destroy\(\);/.test(src));
  check("three: program carries cacheKey/name/type", src.includes("this.cacheKey = cacheKey;") && src.includes("this.name = parameters.shaderName;") && src.includes("this.type = parameters.shaderType;"));
  // Stage-keyed identity (5b): the key head is two stage ids, a freed stage's
  // id is re-minted, and the program keeps its (attached) shaders.
  check("three: a no-shaderID key starts with the two custom stage ids",
    /if \( parameters\.shaderID \) \{\s*array\.push\( parameters\.shaderID \);\s*\} else \{\s*array\.push\( parameters\.customVertexShaderID \);\s*array\.push\( parameters\.customFragmentShaderID \);/.test(src));
  check("three: a stage is dropped at usedTimes 0 and ids are minted fresh",
    src.includes("if ( shaderStage.usedTimes === 0 ) this.shaderCache.delete( shaderStage.code );") && src.includes("this.id = _id ++;"));
  check("three: program keeps vertexShader/fragmentShader and never detaches them",
    src.includes("this.vertexShader = glVertexShader;") && src.includes("this.fragmentShader = glFragmentShader;")
      && src.includes("// gl.detachShader( program, glVertexShader );"));
}

// ── 8. moving-bench: the shipped rig source reads the ledger per lap ──────
{
  const { movingRigSource } = await import("../harness/lib/moving_rig.mjs");
  const { toResultsV2 } = await import("../harness/moving-bench.mjs");
  const g = globalThis;
  const gl = fakeGl();
  const renderer = { getContext: () => gl, info: { autoReset: true, render: { calls: 0, triangles: 0 }, programs: [] } };
  const probe = installLinkProbe(renderer, { force: true, ledgerMs: 0 });
  const P = renderer.info.programs;
  let frame = 0;
  g.requestAnimationFrame = (cb) => { setTimeout(() => cb(0), 0); return 1; };
  g.__diag = { vfxGauge: { armed: true, frames: 0, tCpuMs: 1 } };
  g.__cam = { set() {} };
  g.__renderOnce = () => {
    // warm frame 0 links "warm"; measure frame 1 releases it and links it again
    // (a relink) plus one brand-new key.
    if (frame === 0) P.push(prog(500, "warm"));
    if (frame === 1) { release(P, 500); P.push(prog(501, "warm"), prog(502, "fresh")); }
    renderer.info.render.calls += 10;
    g.__diag.vfxGauge.frames += 1;
    frame += 1;
  };
  g.liveScene3d = { renderer, scene: { traverse() {} }, camera: { position: { x: 0, y: 0, z: 0 } }, terrainBakedLbs: new Map([[1, true]]) };
  const rows = [[0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0]];
  movingRigSource()();
  g.__mbench.install({ spec: {}, rows, events: [], warmFrames: 1, drive: "ondemand" });
  const r = await g.__mbench.run();
  check("rig: window.__linkProbe is the probe it reads", g.__linkProbe === probe);
  check("rig: measure-lap relinks = 1 (the warm-lap key linked again)", r.link && r.link.relinks === 1, JSON.stringify(r.link));
  check("rig: created/released are measure-lap deltas", r.link && r.link.created === 2 && r.link.released === 1);
  check("rig: programs = renderer.info.programs.length at lap end", r.link && r.link.programs === 2);

  const rep = {
    ts: "2026-10-13T00:00:00.000Z", arm: "(default)", url: "http://127.0.0.1:8765/x?nosw=1&linkProbe=on",
    verdict: "USABLE", rejectReasons: [], spec: { mode: "orbit" },
    pathChecksum: "aa", realisedChecksum: "aa",
    frames: { requested: 3, measured: 3, warm: 1 }, missedGauge: 0,
    rafMs: { n: 3, p50: 16 }, cpuMs: { n: 3, p50: 1 },
    workload: { draws: { n: 3, p50: 10 }, ktris: { n: 3, p50: 0 }, residentInstances: 0, batchedMeshes: 0, staticBatchC: 0 },
    lb: { churnFrames: 0 }, walkDelta: null, errors: [], reloginAttempts: 0, bootErrors: [],
    link: r.link,
  };
  const v2 = toResultsV2(rep, {});
  const m = v2.arms[0].metrics;
  check("RESULTS-v2: programsRelinked@moving from the ledger", m["programsRelinked@moving"] === 1, JSON.stringify(m));
  check("RESULTS-v2: programs@resident from renderer.info.programs", m["programs@resident"] === 2);
  check("RESULTS-v2: the ledger rides the taint list", Array.isArray(v2.taint) && v2.taint.includes("linkProbe"), JSON.stringify(v2.taint));
  check("RESULTS-v2: the per-lap link deltas ride the arm", v2.arms[0].link && v2.arms[0].link.released === 1);

  const v2Off = toResultsV2({ ...rep, link: null }, {});
  const mOff = v2Off.arms[0].metrics;
  check("RESULTS-v2 without the probe: neither key (absent, never 0)", !("programsRelinked@moving" in mOff) && !("programs@resident" in mOff));
  check("RESULTS-v2 without the probe: taint unchanged (empty)", Array.isArray(v2Off.taint) && v2Off.taint.length === 0 && !("link" in v2Off.arms[0]));

  // A page without the probe (or a stale build without the ledger) -> null.
  delete g.__linkProbe;
  frame = 0;
  movingRigSource()();
  g.__mbench.install({ spec: {}, rows, events: [], warmFrames: 0, drive: "ondemand" });
  const r2 = await g.__mbench.run();
  check("rig without __linkProbe: link is null", r2.link === null);
  g.__linkProbe = { ledgerStats: () => ({ available: false }) };
  movingRigSource()();
  g.__mbench.install({ spec: {}, rows, events: [], warmFrames: 0, drive: "ondemand" });
  const r3 = await g.__mbench.run();
  check("rig with a ledger that has no renderer.info.programs: link is null", r3.link === null);
}

console.info = origInfo;
console.log(`\nlink_probe_ledger: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
