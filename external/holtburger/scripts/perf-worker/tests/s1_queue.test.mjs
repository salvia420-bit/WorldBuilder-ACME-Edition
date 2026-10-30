// tests/s1_queue.test.mjs — the round-3 S1 1070 queue (apps/holtburger-web/docs/reengineering/queue-1070/
// batch-R3-S1-2026-10-30.json), its page driver scripts/perf-worker/s1.eval.js, its scorer s1_eval_report.py and the
// S1-EYE shots in rc-eye.mjs (lane Q2, 2026-10-30). No browser, no ssh, no 1070: s1.eval.js runs against fake pages
// (route / indoor / diag / ctxloss), s1_eval_report.py and the S1-PRE one-liners run on synthetic files, the laptop
// CDP guard against a local fake /json/version server.
//   node scripts/perf-worker/tests/s1_queue.test.mjs        (any cwd; paths resolve from this file)
// Pins: the queue parses (schema, unique arm names, every arms item plans through hbbench planArm with clean URL pins);
// the section 5 rules are the live plan's text verbatim and no hitch-flag OPEN note remains; every arm flag has a
// reader in the tree, every window.__ global a gate or s1.eval.js reads is assigned in the app, every diag field a
// pass condition names exists in its module; evalScripts (sha256, opts, the S1-PRE extraction); ONE landing rule
// from the retail ground height; the laptop tab check names its CDP endpoint and its guard refuses :9333, other hosts
// and a Windows tab; the bakeFallbackWaves read (maxIds = the largest REQUEST; JS and python agree on fixtures); the
// per-window GL upload reads; the ctxloss flow against a fake GL with Chrome's lost / restore rules; the end-of-run
// rigPoseSkip skip rate; the report skips browser traces by name and the queue's globs never match one; rc-eye SHOTS.
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PW = join(HERE, "..");
const ROOT = join(PW, "..", "..");
const APP = join(ROOT, "apps/holtburger-web");
const QUEUE = join(APP, "docs/reengineering/queue-1070/batch-R3-S1-2026-10-30.json");
const PLAN = join(APP, "docs/2026-10-29-round3-gpu-driven.md");
const EVAL = join(PW, "s1.eval.js");
const REPORT = join(PW, "s1_eval_report.py");
const RCEYE = join(PW, "rc-eye.mjs");

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`[FAIL] ${name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n       ")}`); }
}
const Q = JSON.parse(readFileSync(QUEUE, "utf8"));
const QTEXT = readFileSync(QUEUE, "utf8");
const item = (id) => Q.items.find((i) => i.id === id);
const allArms = () => Q.items.flatMap((it) => (Array.isArray(it.arms) ? it.arms.map((a) => ({ ...(it.armDefaults || {}), ...a, _item: it.id })) : []));
const strings = (o, out = []) => { if (typeof o === "string") out.push(o); else if (Array.isArray(o)) o.forEach((v) => strings(v, out)); else if (o && typeof o === "object") Object.values(o).forEach((v) => strings(v, out)); return out; };
const walk = (dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (/\.(m?js)$/.test(n)) out.push(p); } return out; };
const APP_SRC = [...walk(join(APP, "scene3d")), join(APP, "index.html")].map((p) => readFileSync(p, "utf8")).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const EVAL_SRC = readFileSync(EVAL, "utf8");
const py = (args, opts = {}) => spawnSync("python3", ["-I", ...args], { encoding: "utf8", timeout: 120000, ...opts });
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36"; // the laptop tab
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36"; // the 1070 box
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

// The plan's section 5 rows, ASCII-normalised as in hb_v2.test.mjs (>= <= - ' for the plan's ≥ ≤ − ′; table \|).
const norm = (t) => t.replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/−/g, "-").replace(/′/g, "'").replace(/\\\|/g, "|").replace(/\s+/g, " ").trim();
const PLAN_RULES = (() => {
  const plan = readFileSync(PLAN, "utf8");
  const sec = plan.slice(plan.indexOf("## 5. Decision rules"), plan.indexOf("## 6. Risks"));
  const rows = [];
  for (const line of sec.split("\n")) { const m = /^\| \*\*(V|R\d+) \(([^)]*)\)\*\* \| (.*) \|\s*$/.exec(line); if (m) rows.push([m[1], norm(m[3])]); }
  return rows;
})();

// ==================================================================================================================
// the queue file
// ==================================================================================================================
const { loadArms, urlPinProblems, frameStats } = await import(join(PW, "lib/hb_v2.mjs"));
const { planArm } = await import(join(PW, "hbbench.mjs"));

await check("queue: parses, ASCII, hb-1070-queue-v1 / R3-S1, unique arm names, every arms item plans through hbbench planArm with clean URL pins (camDebug=on for s1.eval.js)", () => {
  assert.equal(Q.schema, "hb-1070-queue-v1"); assert.equal(Q.batch, "R3-S1");
  assert.ok(/^[\x00-\x7f]*$/.test(QTEXT), "the queue file is ASCII");
  const names = allArms().map((a) => a.name);
  assert.equal(new Set(names).size, names.length, "arm names are unique across the file (hbreport collects predict by name)");
  let items = 0;
  for (const it of Q.items) {
    if (!Array.isArray(it.arms)) continue;
    items++;
    for (const a of loadArms(Q, it.id)) {
      const plan = planArm(a, { port: "8766" });
      assert.deepEqual(urlPinProblems(plan.pins), [], `${it.id}/${a.name}`);
      assert.match(plan.url, /[?&]camDebug=on\b/, `${it.id}/${a.name}: s1.eval.js and hbbench drive window.__cam`);
      for (const k of ["gate", "gateInfo"]) if (a[k]) new Function(`return (${a[k]});`); // parses as an expression
    }
  }
  assert.ok(items >= 7, `arms items ${items}`);
});

await check("queue: decision rules = plan section 5 verbatim, in plan order (re-copied after R3's hitch sentence; while no item has a result)", () => {
  assert.equal(PLAN_RULES.length, 11);
  assert.deepEqual(Q.decisionRules.map((r) => r.rule), PLAN_RULES.map((r) => r[0]));
  if (Q.items.some((it) => it.result !== null && it.result !== undefined)) { console.log("       (results recorded: rules frozen at run time; text check skipped)"); return; }
  for (const [rule, text] of PLAN_RULES) assert.equal(Q.decisionRules.find((r) => r.rule === rule).text, text, `rule ${rule}`);
});

await check("queue: no OPEN / owner-decision note on the hitch flags; each hitch arm quotes R3's hitch sentence and says r3_keep's printed verdict is not its verdict", () => {
  for (const bad of [/OPEN \(owner/, /OWNER DECISION NEEDED/, /owner rules on the OPEN/, /stays default OFF until the owner rules which reading/]) assert.ok(!bad.test(QTEXT), String(bad));
  const r3 = PLAN_RULES.find((r) => r[0] === "R3")[1];
  const hitch = r3.slice(r3.indexOf("For a hitch change"));
  assert.ok(hitch.length > 60, "the plan's R3 has its hitch sentence");
  for (const [it, name] of [["S1-BENCH", "UWD-on"], ["S1-ROUTE", "R-UWD"], ["S1-BW0", "BFW-on"], ["S1-ROUTE", "R-BFW"]]) {
    const a = item(it).arms.find((x) => x.name === name);
    assert.ok(a.decisionRule.includes(hitch), `${name} quotes the hitch sentence verbatim`);
    assert.match(a.decisionRule, /firstTurn\.max AND firstTurn\.h100/);
    assert.match(a.decisionRule, /printed R3 verdict is NOT the verdict/);
  }
});

await check("queue: every arm flag has a reader in the tree (a call whose first argument is the flag name, in scene3d/ or index.html)", () => {
  const flags = new Set();
  for (const a of allArms()) for (const kv of String(a.flags || "").split("&").filter(Boolean)) flags.add(kv.split("=")[0]);
  assert.ok(flags.size >= 9, [...flags].join(","));
  for (const f of flags) assert.ok(new RegExp(`[\\w$]\\(\\s*["']${f}["']\\s*[,)]`).test(APP_SRC), `no reader for ?${f}`);
});

await check("queue + s1.eval.js: every window.__ global a gate / gateInfo or the page driver reads is assigned in the app", () => {
  const names = new Set();
  for (const a of allArms()) for (const k of ["gate", "gateInfo"]) for (const m of String(a[k] || "").matchAll(/window\.(__\w+)/g)) names.add(m[1]);
  for (const m of EVAL_SRC.matchAll(/\bW\.(__\w+)/g)) if (m[1] !== "__hbEvalOpts") names.add(m[1]);
  assert.ok(names.size >= 12, [...names].join(","));
  for (const n of names) assert.ok(new RegExp(`(window|globalThis)\\.${n}\\s*=`).test(APP_SRC), `${n} is never assigned in scene3d/ or index.html`);
});

await check("queue: every diag read declares its fields, and every field exists in its module (rg-equivalent word match)", () => {
  const reads = [];
  for (const it of Q.items) {
    for (const d of it.diagReads || []) reads.push([it.id, d]);
    for (const a of it.arms || []) { for (const d of a.diagReads || []) reads.push([`${it.id}/${a.name}`, d]); if (a.reads) reads.push([`${it.id}/${a.name}`, a]); }
  }
  assert.ok(reads.length >= 20, `diag reads ${reads.length}`);
  for (const [where, d] of reads) {
    assert.ok(d.fields && typeof d.fields === "object", `${where}: no fields`);
    for (const [mod, names] of Object.entries(d.fields)) {
      const p = join(ROOT, mod);
      assert.ok(existsSync(p), `${where}: ${mod} missing`);
      const src = readFileSync(p, "utf8");
      for (const n of names) assert.ok(new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(src), `${where}: ${n} not in ${mod}`);
    }
  }
});

await check("evalScripts: the promoted files exist and match their sha256; every opts parses; every eval recipe uses scripts/perf-worker/s1.eval.js and opts that exist", () => {
  const e = Q.evalScripts;
  assert.deepEqual(Object.keys(e.files).sort(), ["s1.eval.js", "s1_eval_report.py"]);
  for (const [k, p] of Object.entries(e.files)) assert.equal(createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex"), e.sha256[k], `${k} sha256 (re-run the generator / re-review the queue)`);
  assert.ok(!("s1.eval.js" in (e.opts || {})), "no embedded script copies");
  for (const it of Q.items) for (const a of it.arms || []) if (a.opts) assert.ok(e.opts[a.opts], `${it.id}/${a.name}: opts ${a.opts} not in evalScripts.opts`);
  let evals = 0;
  for (const s of strings(Q.items)) {
    for (const m of s.matchAll(/--eval (\S+\.js)\b/g)) { evals++; assert.equal(m[1], "scripts/perf-worker/s1.eval.js", s.slice(0, 120)); }
    for (const m of s.matchAll(/\/opts\/([\w.-]+\.json)/g)) assert.ok(e.opts[m[1]], `${m[1]} named in a recipe but not in evalScripts.opts`);
  }
  assert.ok(evals >= 10, `--eval commands ${evals}`);
});

await check("S1-PRE: the opts extraction one-liner writes every opts file and refuses a script whose sha256 changed", () => {
  const line = item("S1-PRE").recipe.find((s) => s.startsWith("Scripts and opts"));
  const code = /python3 -I -c "(.*?)" apps\//.exec(line)[1];
  const T = mkdtempSync(join(tmpdir(), "s1q-x-"));
  try {
    const ok = py(["-c", code, QUEUE, join(T, "opts")], { cwd: ROOT });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^ok /);
    for (const [k, v] of Object.entries(Q.evalScripts.opts)) assert.deepEqual(JSON.parse(readFileSync(join(T, "opts", k), "utf8")), v);
    const q2 = JSON.parse(QTEXT); q2.evalScripts.sha256["s1.eval.js"] = "0".repeat(64);
    writeFileSync(join(T, "q.json"), JSON.stringify(q2));
    const bad = py(["-c", code, join(T, "q.json"), join(T, "opts2")], { cwd: ROOT });
    assert.equal(bad.status, 1); assert.match(bad.stdout, /MISMATCH \['s1\.eval\.js'\]/);
  } finally { rmSync(T, { recursive: true, force: true }); }
});

await check("hop route: ONE landing rule from the retail ground height; every stop and every route opts hop carries it; no other drop range anywhere", () => {
  const w = Q.hopRoutes.west4, tol = w.landing.tolM;
  assert.equal(tol, 1.0);
  for (const st of w.stops) {
    assert.equal(typeof st.groundZ, "number", st.label);
    assert.equal(st.expectedDropM, +(st.z - st.groundZ).toFixed(2), st.label);
    assert.ok(st.expectedDropM >= 0 && st.expectedDropM <= 7, `${st.label}: requested z within groundZ .. groundZ + 7 m`);
    assert.ok(st.nearestDatObjectM === null || st.nearestDatObjectM >= 9, `${st.label}: no DAT object within 9 m`);
  }
  // "well grounded" as the derivation defines it must hold for every stop it is claimed for
  const minSamples = /\(>= (\d+) samples/.exec(w.derivation);
  if (minSamples) for (const st of w.stops.filter((s) => s.groundSamples)) assert.ok(st.groundSamples.length >= +minSamples[1], `${st.label}: ${st.groundSamples.length} samples < ${minSamples[1]}`);
  const byLabel = Object.fromEntries(w.stops.map((s) => [s.label, s]));
  for (const [name, o] of Object.entries(Q.evalScripts.opts)) {
    if (o.mode !== "route") continue;
    assert.equal(o.landTolM, tol, `${name}: landTolM`);
    for (const h of o.hops) {
      assert.equal(typeof h.groundZ, "number", `${name}/${h.label}: groundZ`);
      if (byLabel[h.label]) for (const k of ["cmd", "lb", "z", "groundZ"]) assert.equal(h[k], byLabel[h.label][k], `${name}/${h.label}.${k}`);
    }
  }
  // drop ranges: only the landing rule states one
  const lo = Math.min(...w.stops.map((s) => s.expectedDropM)) - tol, hi = Math.max(...w.stops.map((s) => s.expectedDropM)) + tol;
  const ranges = [];
  for (const s of strings(Q)) if (/drop/i.test(s)) for (const m of s.matchAll(/(-?\d+(?:\.\d+)?)\s?\.{2,3}\s?(-?\d+(?:\.\d+)?)\s?m\b/g)) ranges.push(`${+m[1]}..${+m[2]}`);
  assert.deepEqual([...new Set(ranges)], [`${lo}..${+hi.toFixed(2)}`], "one drop range, the landing rule's");
});

// ==================================================================================================================
// the laptop tab check never reaches the 1070
// ==================================================================================================================
const LC = item("S1-PRE").laptopCheck;
// a preload that makes any network contact by the guard visible (and fail): a refusal must come before it
const NO_FETCH = join(mkdtempSync(join(tmpdir(), "s1q-nf-")), "no_fetch.cjs");
writeFileSync(NO_FETCH, "globalThis.fetch = () => { process.stderr.write('FETCH-ATTEMPTED '); return Promise.reject(new Error('blocked by the suite')); };\n");
const runGuard = (url, { noFetch = false } = {}) => new Promise((resolve) => {
  const js = /node -e "(.*)" "\$LAPTOP_CDP"/.exec(LC.commands[0])[1];
  const ch = spawn(process.execPath, [...(noFetch ? ["-r", NO_FETCH] : []), "-e", js, url], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => ch.kill(), 10000);
  ch.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
});

await check("S1-PRE laptop check: an explicit laptop CDP endpoint (never :9333), every attach command behind s1guard with HB_CDP=\"$LAPTOP_CDP\", laptopCheck opts", () => {
  const u = new URL(LC.cdp);
  assert.notEqual(u.port, "9333"); assert.equal(u.hostname, "127.0.0.1");
  assert.ok(LC.commands[0].startsWith(`LAPTOP_CDP=${LC.cdp}; s1guard() { node -e "`), LC.commands[0].slice(0, 80));
  let attach = 0;
  for (const c of LC.commands.slice(1)) {
    if (c.startsWith("#")) continue;
    if (!/^node |hbanatomy|hbsweep|cdp-eval/.test(c) && /^python3 /.test(c)) continue;
    assert.ok(c.startsWith('s1guard && HB_CDP="$LAPTOP_CDP" node scripts/perf-worker/hbanatomy.mjs --attach --no-box-samples '), c.slice(0, 100));
    attach++;
    const o = /\/opts\/([\w.-]+\.json)/.exec(c)[1];
    assert.equal(Q.evalScripts.opts[o].laptopCheck, true, `${o}: laptopCheck`);
  }
  assert.equal(attach, 5);
  assert.match(LC.tab, /wireframe=1&camDebug=on&nosw=1/);
  assert.match(LC.tab, /--remote-debugging-port=9444/);
  // anywhere in the queue: an attach-mode command names its endpoint (lib/hb_box.mjs defaults to :9333)
  for (const s of strings(Q)) for (const m of s.matchAll(/([^;&|]*)node scripts\/perf-worker\/(hbanatomy\.mjs --attach|hbsweep\.mjs|cdp-eval\.mjs)/g)) assert.match(m[1], /HB_CDP=/, s.slice(0, 160));
  assert.ok(item("S1-PRE").recipe.every((s) => !/hbanatomy\.mjs --attach/.test(s)), "the S1-PRE recipe points at laptopCheck.commands");
});

await check("S1-PRE laptop check: s1guard refuses :9333, a non-loopback host, an unset endpoint and a tab that answers as Windows; passes a Linux tab", async () => {
  const r1 = await runGuard("http://127.0.0.1:9333", { noFetch: true });
  assert.equal(r1.code, 1); assert.match(r1.out, /REFUSED: http:\/\/127\.0\.0\.1:9333\/ is the 1070 tunnel forward/); assert.ok(!/FETCH-ATTEMPTED/.test(r1.out), "refused before any contact");
  const r2 = await runGuard("http://100.127.215.75:9444", { noFetch: true });
  assert.equal(r2.code, 1); assert.match(r2.out, /REFUSED: .*loopback only/); assert.ok(!/FETCH-ATTEMPTED/.test(r2.out), "refused before any contact");
  const r3 = await runGuard("", { noFetch: true });
  assert.ok(!/FETCH-ATTEMPTED/.test(r3.out));
  assert.notEqual(r3.code, 0);
  let ua = WINDOWS_UA;
  const srv = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/json/version" ? { "User-Agent": ua, Browser: "x" } : {})); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const w = await runGuard(base);
    assert.equal(w.code, 1); assert.match(w.out, /REFUSED: .*Windows/);
    ua = LINUX_UA;
    const l = await runGuard(base);
    assert.equal(l.code, 0, l.out); assert.match(l.out, /laptop tab ok/);
  } finally { srv.close(); }
  const r4 = await runGuard("http://127.0.0.1:1");
  assert.equal(r4.code, 1); assert.match(r4.out, /REFUSED: no CDP answer/);
});

await check("S1-PRE laptop check: the closing one-liner passes five clean runs and fails a refused / problem / errored one", () => {
  const code = /python3 -I -c "(.*?)" \//.exec(LC.commands[LC.commands.length - 1])[1];
  const T = mkdtempSync(join(tmpdir(), "s1q-l-"));
  try {
    const files = ["route", "diag", "room", "indoor", "ctxloss"].map((n) => { const p = join(T, `${n}.json`); writeFileSync(p, JSON.stringify({ result: { mode: n, problems: [] } })); return p; });
    const ok = py(["-c", code, ...files]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /laptop check ok 5/);
    for (const bad of [{ result: { problems: ["hop 1 w1: landing: x"] } }, { result: { refused: "laptopCheck: Windows", problems: ["x"] } }, { error: "boom" }, {}]) {
      writeFileSync(files[0], JSON.stringify(bad));
      assert.equal(py(["-c", code, ...files]).status, 1, JSON.stringify(bad));
    }
  } finally { rmSync(T, { recursive: true, force: true }); }
});

// ==================================================================================================================
// s1.eval.js: helpers
// ==================================================================================================================
setGlobal("window", { __hbEvalOpts: { mode: "helpers" } });
let S1 = {}, S1_LOAD_ERROR = null; // a script without helpers mode fails the checks below one by one, not the file
try { S1 = (await new AsyncFunction(EVAL_SRC)()) || {}; } catch (e) { S1_LOAD_ERROR = e; }

const W14 = { cap: 16, calls: 2, split: 1, waves: 5, yields: 3, maxIds: 64, byType: {
  fetchModelMeshes: { calls: 1, split: 1, waves: 4, yields: 3, maxIds: 64 }, fetchSurfacesPixels: { calls: 1, split: 0, waves: 1, yields: 0, maxIds: 8 } } };
const BFW_FIXTURES = [
  [W14, 1], // tests/bake_fallback_waves.test.mjs W14: a 64-id request in 4 waves + an 8-id request
  [{ cap: 16, calls: 3, split: 2, waves: 9, yields: 6, maxIds: 70, byType: {
    fetchModelMeshes: { calls: 1, split: 1, waves: 5, yields: 4, maxIds: 70 }, fetchEntitySurfacesPixelsBatch: { calls: 2, split: 1, waves: 4, yields: 2, maxIds: 40 } } }, 1],
  [{ cap: 16, calls: 2, split: 0, waves: 2, yields: 0, maxIds: 64, byType: { fetchModelMeshes: { calls: 2, split: 0, waves: 2, yields: 0, maxIds: 64 } } }, 1], // not split
  [{ cap: 16, calls: 2, split: 1, waves: 5, yields: 3, maxIds: 12, byType: {} }, 1], // maxIds read as a wave size
  [{ cap: 16, calls: 0, split: 0, waves: 0, yields: 0, maxIds: 0, byType: {} }, 40], // worker on, inert
  [{ cap: 16, calls: 3, split: 1, waves: 6, yields: 3, maxIds: 64, byType: {} }, 40], // worker on, fell back
  [null, 1],
  [{ cap: 16, calls: 1 }, 1],
];

await check("s1.eval.js: parses as an async fn body; helpers mode returns the pure helpers and touches nothing else on the page", () => {
  assert.equal(S1_LOAD_ERROR, null, `helpers mode threw: ${S1_LOAD_ERROR}`);
  for (const k of ["fstats", "landing", "fallbackWavesCheck", "skipRate", "laptopRefusal", "ctxlossProblems", "uploadBytes", "sumUploads", "bufferBytes", "drainErrors"]) assert.equal(typeof S1[k], "function", k);
  assert.equal(S1.GL_INVALID_OPERATION, 0x0502); assert.equal(S1.GL_CONTEXT_LOST_WEBGL, 0x9242);
});

await check("s1.eval.js fstats == hb_v2 frameStats (a route window reads like an hbbench segment)", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 20; t++) { const d = Array.from({ length: 20 + t * 37 }, () => 8 + rnd() * (rnd() < 0.05 ? 400 : 20)); assert.deepEqual(S1.fstats(d), frameStats(d)); }
  assert.equal(S1.fstats([]), null);
});

await check("bakeFallbackWaves read: maxIds is the largest REQUEST; W14's correct split passes, an unsplit run and a maxIds-as-wave misread fail; the worker-on control; the queue never bounds maxIds by the cap", () => {
  assert.deepEqual(S1.fallbackWavesCheck(W14, 1), { mode: "fallback", problems: [] });
  // the pre-Q2 pass condition ('split > 0 ... maxIds <= 16') rejected exactly this correct run
  assert.equal(W14.split > 0 && W14.maxIds <= 16, false);
  assert.deepEqual(S1.fallbackWavesCheck(BFW_FIXTURES[1][0], 1).problems, []);
  const unsplit = S1.fallbackWavesCheck(BFW_FIXTURES[2][0], 1).problems.join(" | ");
  assert.match(unsplit, /split 0/); assert.match(unsplit, /fetchModelMeshes: waves 2 < calls - 1 \+ ceil\(maxIds 64 \/ cap 16\) = 5/);
  assert.match(S1.fallbackWavesCheck(BFW_FIXTURES[3][0], 1).problems.join(" | "), /maxIds 12 <= cap 16/);
  assert.deepEqual(S1.fallbackWavesCheck(BFW_FIXTURES[4][0], 40), { mode: "worker", problems: [] });
  assert.match(S1.fallbackWavesCheck(BFW_FIXTURES[5][0], 40).problems[0], /worker served \(seq 40\) yet 3/);
  assert.deepEqual(S1.fallbackWavesCheck(null, 1), { mode: "off", problems: [] });
  const bfw = [item("S1-BW0").arms.find((a) => a.name === "BFW-on"), item("S1-ROUTE").arms.find((a) => a.name === "R-BFW")];
  for (const a of bfw) for (const d of a.diagReads) {
    assert.ok(!/maxIds\s*<=\s*(16|cap|the longest)/.test(d.pass), `${a.name}: ${d.pass.slice(0, 120)}`);
    assert.match(d.pass, /maxIds is the largest REQUEST/); assert.match(d.pass, /waves >= calls \+ split/); assert.match(d.pass, /yields <= waves - calls/);
  }
});

await check("bakeFallbackWaves read: s1_eval_report.py fallback_waves_check (hbbench gateInfo) == s1.eval.js fallbackWavesCheck on every fixture", () => {
  const code = "import sys, json; sys.path.insert(0, sys.argv[1]); import s1_eval_report as R; print(json.dumps([R.fallback_waves_check(s, q) for s, q in json.loads(sys.argv[2])]))";
  const r = py(["-c", code, PW, JSON.stringify(BFW_FIXTURES)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), BFW_FIXTURES.map(([s, q]) => S1.fallbackWavesCheck(s, q)));
});

await check("landing: one rule (|stand z - groundZ| <= tol); a fall short of the ground, a roof and a missing groundZ fail", () => {
  assert.deepEqual(S1.landing({ z: 53.6, groundZ: 48.0 }, 48.3, 1), { dropM: 5.3, groundZ: 48.0, landErrM: 0.3, ok: true, problem: null });
  assert.equal(S1.landing({ z: 53.6, groundZ: 48.0 }, 46.5, 1).ok, false);
  assert.match(S1.landing({ z: 53.6, groundZ: 48.0 }, 51.2, 1).problem, /3\.2 m from the ground/);
  assert.match(S1.landing({ z: 53.6 }, 48.0, 1).problem, /no groundZ/);
});

await check("skipRate / laptopRefusal / upload byte helpers", () => {
  assert.deepEqual(S1.skipRate({ posed: 10, skipped: 5, probed: 5, routeChanged: 0 }, { enabled: true, posed: 40, skipped: 65, probed: 64, routeChanged: 0 }),
    { posed: 30, skipped: 60, probed: 59, routeChanged: 0, verified: null, violations: null, rate: 0.667, enabled: true, verify: false });
  assert.equal(S1.skipRate(null, { posed: 1, skipped: 1 }), null);
  assert.match(S1.laptopRefusal(WINDOWS_UA, "?wireframe=1"), /Windows/);
  assert.match(S1.laptopRefusal(LINUX_UA, "?quality=ultra"), /wireframe=1/);
  assert.match(S1.laptopRefusal(LINUX_UA, "?wireframe=10"), /wireframe=1/);
  assert.equal(S1.laptopRefusal(LINUX_UA, "?wireframe=1&camDebug=on"), null);
  assert.equal(S1.uploadBytes("bufferData", [34962, new Float32Array(10), 35044]), 40);
  assert.equal(S1.uploadBytes("bufferData", [34962, 4096, 35044]), 4096);
  assert.equal(S1.uploadBytes("bufferSubData", [34962, 0, new Uint8Array(100), 10, 20]), 20);
  assert.equal(S1.uploadBytes("copyTexSubImage3D", [0, 0, 0, 0, 0, 0, 0, 8, 4]), 128);
  assert.equal(S1.uploadBytes("texImage2D", [0, 0, 0, 0, 0, { width: 2, height: 3 }]), 24);
  const s = S1.sumUploads([{ calls: { bufferData: 1 }, bytes: { bufferData: 10 }, totalBytes: 10 }, null, { calls: { bufferSubData: 2 }, bytes: { bufferSubData: 5 }, totalBytes: 5 }]);
  assert.deepEqual(s, { calls: { bufferData: 1, bufferSubData: 2 }, bytes: { bufferData: 10, bufferSubData: 5 }, totalBytes: 15 });
  assert.equal(S1.bufferBytes(s), 15); assert.equal(S1.sumUploads([null]), null);
});

// ==================================================================================================================
// s1.eval.js against fake pages
// ==================================================================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setGlobal("requestAnimationFrame", (f) => setTimeout(() => f(performance.now()), 16));
const GROUND_OF = { "0xA8B40025": 48.0, "0xA9B40001": 80.0, "0xA9B40121": 66.0 };

/** A fake game page: teleports land on GROUND_OF (+ roofM for one cell), uploads in known windows, live diags. */
function fakePage({ ua = LINUX_UA, search = "?wireframe=1&camDebug=on", cam = true, roof = null, bfw = null, seq = null } = {}) {
  const W = {}; const timers = [];
  const P = { x: 0xa9 * 192 + 96, y: 0xb4 * 192 + 96, z: 80 };
  const sent = [], log = [];
  let tunnelUntil = 0, hop = null, inTurn = false;
  const GLProto = { bufferSubData() {}, texImage2D() {}, texSubImage2D() {}, texSubImage3D() {}, copyTexSubImage3D() {} };
  const gl = Object.assign(Object.create(GLProto), { bufferData() {}, isContextLost: () => false, getError: () => 0 }); // bufferData: an own patch, as another module may install
  const ORIG = { bufferData: gl.bufferData, bufferSubData: GLProto.bufferSubData };
  W.__sessionHandle = { sendChat(cmd) {
    sent.push(cmd);
    const m = /^@teleloc (0x[0-9A-Fa-f]{8}) ([-\d.]+) ([-\d.]+) ([-\d.]+)/.exec(cmd);
    if (!m) throw new Error("fake: bad cmd " + cmd);
    hop = { turned: false, turnUp: false, contentUp: false };
    timers.push(setTimeout(() => {
      const cell = parseInt(m[1], 16) >>> 0, key = m[1].toUpperCase().replace("0X", "0x");
      P.x = ((cell >>> 24) & 0xff) * 192 + +m[2]; P.y = ((cell >>> 16) & 0xff) * 192 + +m[3];
      P.z = (GROUND_OF[key] ?? +m[4] - 3) + (roof === key ? 3.5 : 0);
      tunnelUntil = performance.now() + 200;
      gl.bufferData(34962, new Float32Array(250), 35044); // arrival: 1000 B while the tunnel runs
    }, 120));
  } };
  W.__isPortalSpaceActive = () => performance.now() < tunnelUntil;
  W.__cam = cam ? {
    world: () => ({ ...P }),
    player: () => { inTurn = true; if (hop && !hop.turnUp) { hop.turnUp = true; gl.bufferData(34962, new Uint8Array(2000), 35044); } }, // the reveal: 2000 B in the turn
    release: () => { if (inTurn && hop) hop.turned = true; inTurn = false; return false; },
    set: () => {}, orbit: () => {},
  } : undefined;
  W.__landblockLru = { entries: { get size() { if (hop && hop.turned && !hop.contentUp) { hop.contentUp = true; gl.bufferSubData(34962, 0, new Uint8Array(500)); } return 100; } } };
  let posed = 0, skipped = 0;
  timers.push(setInterval(() => { posed += 1; skipped += 2; }, 16));
  W.__rigPoseSkip = { stats: () => ({ enabled: true, verify: false, posed, skipped, probed: skipped, routeChanged: 0, verified: 0, violations: 0 }), verify: () => false };
  if (bfw) W.__bakeFallbackWaves = { stats: () => bfw };
  if (seq !== null) W.__bakeWorkerSeq = () => seq;
  W.__animSceneryDiag = () => ({ batch: { byStatus: { active: 2 }, draws: 4, contextResets: 0, legacyReasons: {}, kit: { pages: { generation: 1 } } } });
  W.liveScene3d = { renderer: { getContext: () => gl, info: { programs: [], memory: { geometries: 500, textures: 9 } }, domElement: null }, terrainBakedLbs: new Set([1]) };
  setGlobal("window", W);
  setGlobal("navigator", { userAgent: ua });
  setGlobal("location", { search });
  return { W, gl, sent, log, ORIG, GLProto, stop: () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } } };
}
const runEval = (opts) => { window.__hbEvalOpts = opts; return new AsyncFunction(EVAL_SRC)(); };
const ROUTE_FAST = { turnMs: 250, telelocWaitMs: 3000, contentQuietMs: 250, contentMaxMs: 2500 };
const OPT_HOPS = (name) => Q.evalScripts.opts[name].hops;

await check("route mode (fake page): GL upload bytes read per window (arrive / turn / content), summed per route; GL methods restored; landing per hop", async () => {
  const f = fakePage();
  try {
    const r = await runEval({ mode: "route", ...ROUTE_FAST, countUploads: true, pollBatch: true, landTolM: 1, hops: OPT_HOPS("laptop-route.json") });
    assert.deepEqual(r.problems, []);
    assert.equal(r.hops.length, 2);
    for (const h of r.hops) {
      assert.equal(h.uploads.arrive.bytes.bufferData, 1000, `${h.label} arrive`);
      assert.equal(h.uploads.turn.bytes.bufferData, 2000, `${h.label} turn`);
      assert.equal(h.uploads.content.bytes.bufferSubData, 500, `${h.label} content`);
      assert.equal(h.uploads.arrive.bytes.bufferSubData, undefined); assert.equal(h.uploads.turn.bytes.bufferSubData, undefined);
      assert.equal(h.landed, true); assert.equal(h.landErrM, 0);
    }
    assert.deepEqual(r.route.uploads.bufferBytes, { turn0: 0, arrive: 2000, turn: 4000, content: 1000 });
    assert.equal(r.route.uploads.turnShareOfBufferBytes, 0.571);
    assert.equal(r.route.notArrived, 0); assert.equal(r.route.notLanded, 0);
    assert.equal(r.glRestored, true);
    assert.equal(f.gl.bufferData, f.ORIG.bufferData, "own patch put back");
    assert.ok(!Object.prototype.hasOwnProperty.call(f.gl, "bufferSubData") && f.gl.bufferSubData === f.ORIG.bufferSubData, "prototype method uncovered");
    assert.deepEqual(f.sent, OPT_HOPS("laptop-route.json").map((h) => h.cmd));
    assert.ok(r.rigPoseSkipRate && r.rigPoseSkipRate.rate > 0.6 && r.rigPoseSkipRate.rate < 0.7, JSON.stringify(r.rigPoseSkipRate));
  } finally { f.stop(); }
});

await check("route mode (fake page): a hop that lands on a roof is a landing problem (route.notLanded); bakeFallbackWaves stats are checked at the end", async () => {
  const f = fakePage({ roof: "0xA8B40025", bfw: BFW_FIXTURES[2][0], seq: 1 });
  try {
    const r = await runEval({ mode: "route", ...ROUTE_FAST, landTolM: 1, hops: OPT_HOPS("laptop-route.json") });
    assert.equal(r.route.notLanded, 1);
    assert.ok(r.problems.some((p) => /hop 1 w1: landing: stands 3\.5 m from the ground/.test(p)), r.problems.join(" | "));
    assert.equal(r.checks.bakeFallbackWaves.mode, "fallback");
    assert.ok(r.problems.some((p) => /bakeFallbackWaves \(fallback\): split 0/.test(p)), r.problems.join(" | "));
  } finally { f.stop(); }
  const g = fakePage({ bfw: W14, seq: 1 });
  try {
    const r = await runEval({ mode: "diag", holdMs: 50 });
    assert.deepEqual(r.checks.bakeFallbackWaves, { mode: "fallback", problems: [] }); assert.deepEqual(r.problems, []);
  } finally { g.stop(); }
});

await check("diag mode (fake page): the END-of-run rigPoseSkip read (start and end stats(), the skip rate over the run)", async () => {
  const f = fakePage();
  try {
    const r = await runEval({ mode: "diag", holdMs: 300 });
    assert.ok(r.start.rigPoseSkip && r.diag.rigPoseSkip, "stats() read at the start and the end");
    assert.ok(r.rigPoseSkipRate.posed > 5, JSON.stringify(r.rigPoseSkipRate));
    assert.equal(r.rigPoseSkipRate.skipped, 2 * r.rigPoseSkipRate.posed); assert.equal(r.rigPoseSkipRate.rate, 0.667);
    assert.equal(r.rigPoseSkipRate.routeChanged, 0);
  } finally { f.stop(); }
  const dg = item("S1-DIAG").arms.find((a) => a.name === "G-RPS-rate");
  assert.ok(dg && /rigPoseSkip=on/.test(dg.flags) && Q.evalScripts.opts[dg.opts].mode === "diag" && Q.evalScripts.opts[dg.opts].holdMs >= 20000, "S1-DIAG has an end-of-run rigPoseSkip arm");
});

await check("laptopCheck guard: on a Windows tab or a tab without ?wireframe=1 the script refuses before touching anything; route needs window.__cam", async () => {
  for (const [ua, search] of [[WINDOWS_UA, "?wireframe=1&camDebug=on"], [LINUX_UA, "?camDebug=on"]]) {
    const f = fakePage({ ua, search });
    try {
      const r = await runEval({ ...Q.evalScripts.opts["laptop-route.json"], ...ROUTE_FAST });
      assert.match(r.refused, /laptopCheck/); assert.equal(f.sent.length, 0, "no teleport sent");
      assert.equal(f.gl.bufferData, f.ORIG.bufferData); assert.ok(!Object.prototype.hasOwnProperty.call(f.gl, "texImage2D"), "no GL method wrapped");
    } finally { f.stop(); }
  }
  const g = fakePage({ cam: false });
  try {
    const r = await runEval({ mode: "route", ...ROUTE_FAST, hops: OPT_HOPS("laptop-route.json") });
    assert.match(r.problems[0], /camDebug=on/); assert.equal(g.sent.length, 0);
  } finally { g.stop(); }
});

await check("indoor mode (fake page): headings ranked by the landscape-skip share; still-wall / still-door / moving windows", async () => {
  const f = fakePage();
  let heading = 0, skipped = 0;
  f.W.__cam.set = (ex, ey, ez, tx, ty) => { heading = ((Math.atan2(tx - ex, ty - ey) * 180) / Math.PI + 360) % 360; };
  const tick = setInterval(() => { if (Math.abs(heading - 90) < 10) skipped++; }, 16);
  f.W.__indoorLandscapeGateDiag = () => ({ on: true, skippedFrames: skipped });
  f.W.__skipEmptyPasses = { stats: () => ({ installed: 1, skipped, renders: skipped, refusedHooks: 0 }) };
  try {
    const r = await runEval({ mode: "indoor", headingMs: 120, stillMs: 200, doorMs: 120, moveMs: 200 });
    assert.equal(r.headings.length, 12); assert.equal(r.wallDeg, 90); assert.deepEqual(r.problems, []);
    assert.ok(r.windows["still-wall"].gateShare > 0.5 && r.windows["still-door"].gateShare === 0, JSON.stringify(r.windows["still-door"]));
  } finally { clearInterval(tick); f.stop(); }
});

/**
 * A fake WebGL context with Chrome's context-loss rules (WebGLRenderingContextBase): loseContext() queues the lost
 * event as a task; restore is allowed only once that dispatch returned with its default prevented. Chrome sets
 * restore_allowed_ after HostDispatchEvent returns, and every microtask the listeners queued (and the ones those queue)
 * has run by then, so the whole dispatch task, microtasks included, sees the restore refused: here the refusal holds
 * until a setImmediate after the dispatch (after the task's microtasks, before any later timer). A refused restore is
 * INVALID_OPERATION in the lost-context error list, read back by getError() while lost; getExtension answers null
 * while lost. Plus a K2-like anim-scenery batch
 * (canvas listeners registered first, as K2's are) and webgl_context_recovery.js's pause / resume history.
 */
function fakeCtxPage({ allowRestore = true, k2HoldsLegacy = false, replanFrames = 6 } = {}) {
  const f = fakePage();
  const canvas = new EventTarget();
  let lost = false, restoreAllowed = false, inDispatchTask = false, gen = 1, resets = 0, active = 2, overlap = 0, taken = 6, paused = false, frames = -1;
  const lostErrors = [], hist = [];
  const ext = {
    loseContext() {
      lost = true; restoreAllowed = false; lostErrors.push(0x9242);
      setTimeout(() => {
        const ev = new Event("webglcontextlost", { cancelable: true });
        inDispatchTask = true;
        canvas.dispatchEvent(ev);
        restoreAllowed = allowRestore && ev.defaultPrevented;
        setImmediate(() => { inDispatchTask = false; }); // the dispatch task and all its microtasks are over
      }, 0);
    },
    restoreContext() {
      if (!lost) return;
      if (!restoreAllowed || inDispatchTask) { if (!lostErrors.includes(0x0502)) lostErrors.push(0x0502); return; }
      setTimeout(() => { lost = false; lostErrors.length = 0; canvas.dispatchEvent(new Event("webglcontextrestored")); }, 5);
    },
  };
  const gl = f.gl;
  gl.isContextLost = () => lost;
  gl.getError = () => (lostErrors.length ? lostErrors.shift() : 0);
  gl.getExtension = (n) => (n === "WEBGL_lose_context" && !lost ? ext : null);
  // three + webgl_context_recovery.js (prevent, pause, resume) and the K2 consumer, listening before the script
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); paused = true; hist.push({ state: "lost", ts: performance.now(), count: 1 });
    resets++; gen++; active = 0; overlap = 0; if (!k2HoldsLegacy) taken = 0; });
  canvas.addEventListener("webglcontextrestored", () => { hist.push({ state: "restored", ts: performance.now(), count: 1, rehydrated: 0 }); paused = false; frames = 0;
    resets++; gen++; });
  const tick = setInterval(() => { // the app's frame pump (paused while lost); the batch re-plans after replanFrames, overlaps 3, then activates
    if (paused || frames < 0) return;
    frames++;
    if (frames === replanFrames) overlap = 2;
    if (frames === replanFrames + 3) { overlap = 0; active = 2; taken = 6; }
  }, 16);
  f.W.liveScene3d.renderer.domElement = canvas;
  f.W.__webglContextRecoveryHistory = () => hist.slice();
  f.W.__animSceneryDiag = () => ({ batch: { byStatus: { active, overlap }, draws: active * 2, contextResets: resets, bucketsTaken: taken, legacyReasons: {}, kit: { pages: { generation: gen } } } });
  return { ...f, canvas, ext, isLost: () => lost, stop: () => { clearInterval(tick); f.stop(); } };
}
const CTX = { watchMs: 400, eventWaitMs: 1500, restoreDelayMs: 120 };

await check("fake GL self-test: a back-to-back loseContext(); restoreContext(), or a restore in the lost event's own microtasks, is refused (INVALID_OPERATION) and the canvas stays lost (the K2 handoff's arm)", async () => {
  const f = fakeCtxPage();
  try {
    f.ext.loseContext(); f.ext.restoreContext();
    assert.deepEqual([f.gl.getError(), f.gl.getError(), f.gl.getError()], [0x9242, 0x0502, 0]);
    await sleep(200); assert.equal(f.isLost(), true);
  } finally { f.stop(); }
  const g = fakeCtxPage();
  try { // a restore from a microtask chain started by the lost listener (no frame in between): refused as well
    const lostP = new Promise((res) => g.canvas.addEventListener("webglcontextlost", () => res(true), { once: true }));
    g.ext.loseContext();
    await Promise.race([lostP, sleep(500)]); await null; await null;
    g.ext.restoreContext();
    assert.deepEqual([g.gl.getError(), g.gl.getError()], [0x9242, 0x0502]);
    await sleep(100); assert.equal(g.isLost(), true);
  } finally { g.stop(); }
});

await check("ctxloss fast + slow (fake GL): lost event awaited + a frame, restore allowed, restored event awaited; K2 diag read: contextResets up, generation bumped, legacy on screen meanwhile, active again, no GL error", async () => {
  for (const ctx of ["fast", "slow"]) {
    const f = fakeCtxPage();
    try {
      const r = await runEval({ mode: "ctxloss", ctx, ...CTX });
      assert.deepEqual(r.checks.ctxloss, [], `${ctx}: ${JSON.stringify(r.checks)}`);
      assert.deepEqual(r.problems, []);
      assert.equal(r.lostBeforeRestore, true);
      assert.deepEqual(r.preRestoreErrors, [0x9242]); assert.deepEqual(r.restoreErrors, []); assert.deepEqual(r.glErrorsAtEnd, []);
      assert.ok(r.events.restoreCalledMs > r.events.lostMs, "restore after the lost event");
      if (ctx === "slow") assert.ok(r.events.restoreCalledMs - r.events.lostMs >= CTX.restoreDelayMs, "slow waits restoreDelayMs");
      assert.ok(r.events.restoredMs > r.events.restoreCalledMs);
      assert.ok(r.contextResets.after > r.contextResets.before && r.contextResets.after > 0);
      assert.ok(r.generation.after > r.generation.before);
      assert.equal(r.legacyHeldFrames, 0);
      assert.ok(Number.isFinite(r.activeAgainMsAfterResume) && r.activeAgainMsAfterResume < 1000, String(r.activeAgainMsAfterResume));
      assert.equal(r.contextLostAtEnd, false);
      assert.ok(r.series.some((s) => s[1] === "restored"));
      if (ctx === "slow") assert.ok(r.series.some((s) => s[1] === "lost" && s[2] === 0 && s[6] === 0), "sampled while lost: no batch, no legacy bucket taken");
    } finally { f.stop(); }
  }
});

await check("ctxloss (fake GL): a refused restore and a K2 consumer that keeps legacy hidden are both pass-condition failures", async () => {
  const a = fakeCtxPage({ allowRestore: false });
  try {
    const r = await runEval({ mode: "ctxloss", ctx: "fast", ...CTX, eventWaitMs: 300 });
    assert.ok(r.restoreErrors.includes(0x0502));
    assert.ok(r.checks.ctxloss.some((p) => /refused \(INVALID_OPERATION\)/.test(p)), r.checks.ctxloss.join(" | "));
    assert.ok(r.checks.ctxloss.some((p) => /no webglcontextrestored/.test(p)));
  } finally { a.stop(); }
  const b = fakeCtxPage({ k2HoldsLegacy: true });
  try {
    const r = await runEval({ mode: "ctxloss", ctx: "fast", ...CTX });
    assert.ok(r.legacyHeldFrames > 0); assert.ok(r.checks.ctxloss.some((p) => /legacy not on screen/.test(p)), r.checks.ctxloss.join(" | "));
  } finally { b.stop(); }
});

await check("S1-CTX: the queue's pass conditions name the new reads; no back-to-back restore anywhere", () => {
  const cx = item("S1-CTX");
  const pass = cx.diagReads[0].pass;
  for (const k of ["restoreErrors", "legacyHeldFrames", "glErrorsAtEnd", "contextResets", "generation", "activeAgainMsAfterResume"]) assert.ok(pass.includes(k), k);
  assert.ok(!/back-to-back in one task/.test(QTEXT.replace(/the K2 handoff's 'back-to-back'/, "")), "no back-to-back restore advice");
  for (const a of cx.arms) assert.equal(Q.evalScripts.opts[a.opts].mode, "ctxloss");
});

// ==================================================================================================================
// s1_eval_report.py
// ==================================================================================================================
const evalRun = (arm, rep, result) => ({ schema: "hbanatomy-eval-v1", arm, rep, startedAt: "2026-10-31T10:00:00Z", endedAt: "2026-10-31T10:05:00Z",
  gpu: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11)", box: [], errors: [], result });

await check("s1_eval_report.py: skips *.trace.json / *.split.json by NAME (a browser trace is never json-loaded) and reads the split next to its run", () => {
  const T = mkdtempSync(join(tmpdir(), "s1q-r-"));
  try {
    const run = join(T, "D-off-r1.json");
    writeFileSync(run, JSON.stringify(evalRun("D-off", 1, { mode: "indoor", problems: [], windows: { "still-wall": { frames: { fps: 50, p50: 20, p95: 22, max: 30, h100: 0, h250: 0, jankMs: 0 } } } })));
    writeFileSync(join(T, "D-off-r1.trace.json"), "{ not json: a browser trace stand-in ");
    writeFileSync(join(T, "D-off-r1.split.json"), JSON.stringify({ windows: [{ window: "hbS1:still-wall", mainBusyPerPresent: 12.5 }] }));
    const r = py([REPORT, "--queue", QUEUE, "--item", "S1-INDOOR", "--ref", "D-off", "--json", join(T, "out.json"), run, join(T, "D-off-r1.trace.json"), join(T, "D-off-r1.split.json")], { cwd: ROOT });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skip .*D-off-r1\.trace\.json: \.trace\.json file/);
    const out = JSON.parse(readFileSync(join(T, "out.json"), "utf8"));
    assert.equal(out.reps.length, 1); assert.equal(out.skipped.length, 2);
  } finally { rmSync(T, { recursive: true, force: true }); }
});

await check("queue: every s1_eval_report glob matches the arm-rep runs and never a .trace.json / .split.json next to them", () => {
  const toRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
  let globs = 0;
  for (const s of strings(Q.items)) {
    if (!/s1_eval_report\.py --queue/.test(s)) continue;
    for (const g of s.split(/\s+/).filter((t) => /[*?]/.test(t) && t.endsWith(".json") && t.includes("/"))) {
      globs++;
      const re = toRe(g), dir = g.slice(0, g.lastIndexOf("/") + 1), stem = g.slice(dir.length).replace(/\*-r\?\.json$|-r\?\.json$|\*\.json$/, "").replace(/\*/g, "");
      const armName = stem.endsWith("-") ? stem + "off" : stem || "G-A-up";
      for (const bad of [".trace.json", ".split.json"]) assert.ok(!re.test(`${dir}${armName}-r1${bad}`), `${g} matches ${armName}-r1${bad}`);
      assert.ok(re.test(`${dir}${armName}-r1.json`), `${g} misses ${armName}-r1.json`);
    }
  }
  assert.ok(globs >= 10, `globs ${globs}`);
});

await check("s1_eval_report.py: per-window upload table, rigPoseSkip skip rate and the pass-condition problems per rep", () => {
  const T = mkdtempSync(join(tmpdir(), "s1q-u-"));
  try {
    const up = (b, s) => ({ calls: {}, bytes: { bufferData: b, bufferSubData: s }, totalBytes: b + s });
    const route = (turn) => ({ mode: "route", problems: turn > 3000 ? ["hop 2 w2: landing: stands 3.5 m from the ground (28.5), beyond +-1 m"] : [],
      rigPoseSkipRate: { posed: 10, skipped: 20, rate: 0.667, probed: 20, routeChanged: 0, violations: 0 },
      route: { uploads: { turn0: up(10, 0), arrive: up(1000, 0), turn: up(turn, 0), content: up(0, 500) } } });
    const a = join(T, "G-A-up-r1.json"), u = join(T, "G-UWD-up-r1.json");
    writeFileSync(a, JSON.stringify(evalRun("G-A-up", 1, route(4000)))); writeFileSync(u, JSON.stringify(evalRun("G-UWD-up", 1, route(1500))));
    const r = py([REPORT, "--queue", QUEUE, "--item", "S1-DIAG", "--ref", "G-A-up", "--json", join(T, "out.json"), a, u], { cwd: ROOT });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(readFileSync(join(T, "out.json"), "utf8"));
    const by = Object.fromEntries(out.reps.map((x) => [x.arm, x]));
    assert.equal(by["G-A-up"].uploads.turnShareOfBufferBytes, 0.727); assert.equal(by["G-UWD-up"].uploads.turnShareOfBufferBytes, 0.5);
    assert.equal(by["G-UWD-up"].uploads.arrive.bufferBytes, 1000);
    assert.equal(by["G-A-up"].rigPoseSkipRate.rate, 0.667);
    assert.match(by["G-A-up"].problems[0], /landing/);
    assert.match(r.stdout, /G-A-up\s+r1\s+FAIL hop 2 w2: landing/);
  } finally { rmSync(T, { recursive: true, force: true }); }
});

await check("s1_eval_report.py bench-checks: hbbench gateInfo of BFW-on (fallback_waves_check) and RPS-on (skip rate at the settle); run.json / frames ignored", () => {
  const T = mkdtempSync(join(tmpdir(), "s1q-b-"));
  try {
    const run = (arm, rep, info) => writeFileSync(join(T, `${arm}-r${rep}.json`), JSON.stringify({ schema: "hbbench-run-v2", arm, rep, gate: { expr: "x", value: true, info, ok: true } }));
    run("BFW-on", 1, { seq: 1, waves: W14 });
    run("RPS-on", 1, { enabled: true, posed: 100, skipped: 300, probed: 300, routeChanged: 0 });
    writeFileSync(join(T, "run.json"), JSON.stringify({ schema: "hbbench-meta-v2" }));
    writeFileSync(join(T, "BFW-on-r1.frames.json"), "{ not json");
    const ok = py([REPORT, "bench-checks", "--json", join(T, "c.json"), T], { cwd: ROOT });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const rows = JSON.parse(readFileSync(join(T, "c.json"), "utf8"));
    assert.deepEqual(rows.find((x) => x.arm === "BFW-on").bakeFallbackWaves, { mode: "fallback", problems: [] });
    assert.equal(rows.find((x) => x.arm === "RPS-on").rigPoseSkip.skipRateSinceBoot, 0.75);
    run("BFW-on", 2, { seq: 1, waves: BFW_FIXTURES[2][0] });
    const bad = py([REPORT, "bench-checks", T], { cwd: ROOT });
    assert.equal(bad.status, 1); assert.match(bad.stdout, /BFW-on\s+r2\s+bakeFallbackWaves fallback FAIL split 0/);
  } finally { rmSync(T, { recursive: true, force: true }); }
});

// ==================================================================================================================
// rc-eye.mjs SHOTS
// ==================================================================================================================
const ORIGINAL_SHOTS_SRC = `
const LB = (hex) => [((hex >> 8) & 0xff) * 192, (hex & 0xff) * 192];
const room = (name, lbHex, cell, cx, cy, gz) => {
  const [ox, oy] = LB(lbHex);
  return { name, tele: \`@teleloc 0x\${cell.toString(16)} \${(cx - ox).toFixed(1)} \${(cy - oy).toFixed(1)} \${(gz + 1).toFixed(1)}\`,
    cam: [cx - 2.5, cy - 2.5, gz + 2.4, cx + 1.5, cy + 1.5, gz] };
};
const HOLT = "@teleloc 0xA9B40001 96 96 80 0 0 0 1";
const SHOTS = [
  { name: "holtburg-chase", tele: HOLT },
  { name: "holtburg-orbit", tele: HOLT, orbit: [32544, 34656, 81.5, 70, 45, 22] },
  { name: "holtburg-street", tele: HOLT, player: [9, 200, 10, 1.5] },
  { name: "holtburg-street-2", tele: HOLT, player: [9, 20, 10, 1.5] },
  room("holtburg-room-a9b40121", 0xa9b4, 0xa9b40121, 32552.5, 34695.7, 66),
  { name: "road-verge", tele: "@tele 42.0n 33.6e", cam: [32532, 34538, 105, 32532, 34556, 95] },
  { name: "linvak-tukal", tele: "@teleloc 0xA21E001A 83 38 560.4", orbitPlayer: [45, 30, 25] },
  { name: "linvak-tukal-close", tele: "@teleloc 0xA21E001A 83 38 560.4", player: [10, 120, 15, 1.5] },
  { name: "holtburg-night-orbit", tele: HOLT, orbit: [32544, 34656, 81.5, 70, 45, 22], hour: 22 },
  { name: "holtburg-night-chase", tele: HOLT, hour: 22 },
];`;
const shotsOf = (src) => {
  const a = src.indexOf("const LB = "), b = src.indexOf("\n];", src.indexOf("const SHOTS = ["));
  return new Function(`${src.slice(a, b + 3)}\nreturn SHOTS;`)();
};

await check("rc-eye.mjs SHOTS: the RC-EYE shots unchanged; the S1-EYE shots appended (hop still, critters, TownNetwork, room a9b40121 at hour 22) with the queue's teleports", () => {
  const live = shotsOf(readFileSync(RCEYE, "utf8")), orig = shotsOf(ORIGINAL_SHOTS_SRC);
  assert.deepEqual(live.slice(0, orig.length), orig, "existing shots unchanged, in order");
  const by = Object.fromEntries(live.map((s) => [s.name, s]));
  const stop = Object.fromEntries(Q.hopRoutes.west4.stops.map((s) => [s.label, s]));
  const at = (lb, x, y) => [((lb >> 8) & 0xff) * 192 + x, (lb & 0xff) * 192 + y];
  assert.equal(by["west4-w1-hop"].tele, stop.w1.cmd);
  assert.equal(by["townnetwork-room"].tele, "@telepoi TownNetwork");
  for (const [name, tele, lb, x, y] of [["critter-insect-cloud-a7b4", stop.w2.cmd, 0xa7b4, 139.3, 124.7], ["critter-butterflies-a7b5", stop.w2.cmd, 0xa7b5, 78.9, 65.2],
    ["critter-seagulls-a6b3", stop.w3.cmd, 0xa6b3, 179.8, 108.1]]) {
    assert.equal(by[name].tele, tele, name);
    assert.deepEqual(by[name].orbit.slice(0, 2), at(lb, x, y), name);
  }
  const night = by["holtburg-room-a9b40121-night"], room = by["holtburg-room-a9b40121"];
  assert.equal(night.hour, 22); assert.equal(night.tele, room.tele); assert.deepEqual(night.cam, room.cam);
  for (const s of live.slice(orig.length)) { assert.ok(typeof s.hour === "number", `${s.name}: sets its sky hour`); assert.ok(s.tele, `${s.name}: tele`); }
  // every rc-eye shot name the queue cites exists
  for (const s of strings(Q)) for (const m of s.matchAll(/rc-eye\.mjs (?:shot )?([a-z0-9]+(?:-[a-z0-9]+)+)/g)) assert.ok(by[m[1]], `queue cites rc-eye.mjs ${m[1]}`);
});

try { rmSync(dirname(NO_FETCH), { recursive: true, force: true }); } catch (_) { /* tmp */ }
console.log(`\n${pass} passed, ${fail} failed${failures.length ? `\nFAILED: ${failures.join(" | ")}` : ""}`);
process.exit(fail === 0 ? 0 : 1);
