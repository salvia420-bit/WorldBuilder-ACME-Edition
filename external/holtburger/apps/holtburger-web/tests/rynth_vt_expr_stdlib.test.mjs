// tests/rynth_vt_expr_stdlib.test.mjs — rynth/vt/expr pure function library
// + VarStore (W1-1 EXPR, PLAN §3.4 stdlib_pure.js / vars.js).
//
// One or more cases for EVERY name in PURE_FUNCTION_NAMES (a coverage check
// fails when a registered name has no case), values from the RynthAi/UB
// reference docs where they exist (listfromrange[5,1], round[3.5] = 4,
// hexstr[255] = 0xFF, cstrf[3.14159,N3] = 3.142, coordinateparse[41.53N,
// 34.46E] …), plus VarStore p/g persistence and the throttled 2 s flush
// against a fake storage, and FunctionRegistry behaviour.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_expr_stdlib.test.mjs

import assert from "node:assert/strict";

const E = await import("../rynth/vt/expr/index.js");
const { ExprRuntime, FunctionRegistry, VarStore, V, toStr, typeName, isErr, registerPureStdlib, PURE_FUNCTION_NAMES } = E;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

// 2026-10-12 13:05:09.123 UTC
const T0 = Date.UTC(2026, 9, 12, 13, 5, 9, 123);

function fakeStorage({ failWrites = false } = {}) {
  const m = new Map();
  const writes = [];
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error("QuotaExceededError");
      writes.push([k, String(v)]);
      m.set(k, String(v));
    },
    removeItem: (k) => {
      writes.push([k, null]);
      m.delete(k);
    },
    _m: m,
    writes,
  };
}

function makeRt({ storage = null, scope = "1342177281" } = {}) {
  const clock = { t: T0 };
  const logs = [];
  const functions = new FunctionRegistry({ log: (m) => logs.push(m) });
  registerPureStdlib(functions);
  const vars = new VarStore({ storage, scope, now: () => clock.t, log: (m) => logs.push(m) });
  const rt = new ExprRuntime({ functions, vars, now: () => clock.t, log: (m) => logs.push(m) });
  return { rt, clock, vars, logs, functions };
}

// [function names covered, expression, expected value | (value, ctx) => void, optional setup(ctx)]
const S = (v) => toStr(v);
const CASES = [
  // A. control / dynamic
  [["iif"], "iif[1,2,3]", 2],
  [["iif"], "iif[0,2,3]", 3],
  [["if"], "if[1,yes]", "yes"],
  [["if"], "if[0,yes]", ""],
  [["ifthen"], "ifthen[1, `1+1`, `2+2`]", 2],
  [["ifthen"], "ifthen[0, `1+1`]", ""],
  [["exec"], "exec[`1+1`]", 2],
  [["exec", "setvar"], "setvar[e, `getvar[x] + 1`];setvar[x,4];exec[getvar[e]]", 5],
  [
    ["delayexec"],
    "delayexec[1000, `setvar[d,1]`]",
    (v, c) => {
      assert.equal(v, 1);
      assert.equal(c.rt.pendingDelayed, 1);
      assert.equal(c.rt.pump(T0 + 999), 0);
      assert.equal(c.rt.pump(T0 + 1000), 1);
      assert.equal(c.vars.get("session", "d"), 1);
    },
  ],
  [["tostring"], "tostring[1+1]", (v) => assert.equal(v, "2")],
  [["cstr"], "cstr[2]", (v) => assert.equal(v, "2")],
  [["cstrf"], "cstrf[3.14159,N3]", "3.142"],
  [["cstrf"], "cstrf[2.5,F2]", "2.50"],
  [["cstrf"], "cstrf[1234.5,0.00]", "1234.50"],
  [["cstrf"], "cstrf[1234567.891,N2]", "1,234,567.89"],
  [["cstrf"], "cstrf[1234567.891,N0]", "1,234,568"],
  [["cstrf"], "cstrf[-3.14159,F2]", "-3.14"],
  [["cstrf"], "cstrf[0.125,F2]", "0.13"],
  [["cstrf"], "cstrf[3.14159,F0]", "3"],
  [["cstrf"], "cstrf[1.5,`#.##`]", "1.5", "# and , are specials: such formats need backticks"],
  [["cstrf"], "cstrf[1234567,`#,##0`]", "1,234,567"],
  [["cstrf"], "cstrf[0.5,`#.00`]", ".50"],
  [["cstrf"], "cstrf[0.256,P1]", "25.6 %"],
  [["cstrf"], "cstrf[7,unknown]", "7"],
  [["cstrf"], "setvar[fmt,F1];cstrf[2.25,$fmt]", "2.3"],
  [["cnumber"], "cnumber[3.14159]", 3.14159],
  [["cnumber"], "cnumber[abc]", 0],
  [["strlen"], "strlen[test]", 4],
  [["ord"], "ord[c]", 99],
  [["ord"], "ord[``]", 0],
  [["chr"], "chr[99]", "c"],
  [["chr"], "chr[70000]", ""],
  [["hexstr"], "hexstr[255]", "0xFF"],
  [["hexstr"], "hexstr[4096]", "0x1000"],
  [["hexstr"], "hexstr[]", "0x0"],
  [["hexstr"], "hexstr[-1]", "0xFFFFFFFFFFFFFFFF"],
  [["getregexmatch"], "getregexmatch[`test 123`, `\\d+`]", "123"],
  [["getregexmatch"], "getregexmatch[`hello world`, `\\w+`]", "hello"],
  [["getregexmatch"], "getregexmatch[`no digits here`, `\\d+`]", ""],
  [["getregexmatch"], "getregexmatch[`ABC`, `b`]", "B"],
  [["isfalse"], "isfalse[0]", true],
  [["isfalse"], "isfalse[1]", false],
  [["istrue"], "istrue[1]", true],
  [["istrue"], "istrue[0]", false],
  [["getobjectinternaltype"], "getobjectinternaltype[test]", 3],
  [["getobjectinternaltype"], "getobjectinternaltype[42]", 1],
  [["getobjectinternaltype"], "getobjectinternaltype[]", 0],
  [["getobjectinternaltype", "listcreate"], "getobjectinternaltype[listcreate[]]", 7],
  [["getobjectinternaltype", "stopwatchcreate"], "getobjectinternaltype[stopwatchcreate[]]", 7],
  [
    ["randint"],
    "listmap[listfromrange[1,60],`randint[0,2]`]",
    (v) => {
      for (const x of v.items) assert.ok(x === 0 || x === 1, `randint[0,2] gave ${x}`);
    },
  ],
  [["randint"], "randint[5,5]", 5],
  // B. math
  [["floor"], "floor[3.14159]", 3],
  [["floor"], "floor[-3.5]", -4],
  [["ceiling"], "ceiling[3.14159]", 4],
  [["round"], "round[3.5]", 4],
  [["round"], "round[-2.5]", -3],
  [["round"], "round[3.14159]", 3],
  [["abs"], "abs[-3.14159]", 3.14159],
  [["acos"], "acos[1]", 0],
  [["acos"], "acos[0]", (v) => assert.equal(S(v), "1.5707963267948966")],
  [["asin"], "asin[1]", Math.PI / 2],
  [["atan"], "atan[1]", (v) => assert.equal(S(v), "0.7853981633974483")],
  [["atan2"], "atan2[1, 1]", Math.PI / 4],
  [["atan2"], "atan2[0, 1]", 0],
  [["cos"], "cos[0]", 1],
  [["cosh"], "cosh[0]", 1],
  [["sin"], "sin[0]", 0],
  [["sinh"], "sinh[0]", 0],
  [["sqrt"], "sqrt[4]", 2],
  [["sqrt"], "sqrt[-1]", (v) => assert.equal(S(v), "NaN")],
  [["tan"], "tan[0]", 0],
  [["tanh"], "tanh[1]", (v) => assert.equal(S(v), "0.7615941559557649")],
  // C. session variables
  [["setvar"], "setvar[count,5]", 5],
  [["getvar", "setvar"], "setvar[Count,5];getvar[COUNT]", 5, "names are case-insensitive"],
  [["getvar"], "getvar[nothere]", 0],
  [["testvar"], "testvar[nothere]", false],
  [["testvar", "setvar"], "setvar[a,1];testvar[a]", true],
  [["touchvar"], "touchvar[t]", (v, c) => (assert.equal(v, false), assert.equal(c.vars.get("session", "t"), 0))],
  [["touchvar", "setvar"], "setvar[t,9];touchvar[t]", (v, c) => (assert.equal(v, true), assert.equal(c.vars.get("session", "t"), 9))],
  [["clearvar"], "setvar[a,1];clearvar[a]", (v, c) => (assert.equal(v, true), assert.equal(c.vars.has("session", "a"), false))],
  [["clearvar"], "clearvar[nothere]", false],
  [["clearallvars"], "setvar[a,1];setvar[b,2];clearallvars[]", (v, c) => (assert.equal(v, true), assert.deepStrictEqual(c.vars.names("session"), []))],
  // C. persistent / global variables (persistence itself is tested below)
  [["setpvar", "getpvar"], "setpvar[kills,3];getpvar[KILLS]", 3],
  [["getpvar"], "getpvar[none]", 0],
  [["testpvar", "setpvar"], "setpvar[k,1];testpvar[k]", true],
  [["touchpvar"], "touchpvar[k]", false],
  [["clearpvar", "setpvar"], "setpvar[k,1];clearpvar[k]", true],
  [["clearallpvars", "setpvar"], "setpvar[k,1];clearallpvars[]", (v, c) => (assert.equal(v, true), assert.deepStrictEqual(c.vars.names("p"), []))],
  [["setgvar", "getgvar"], "setgvar[serverKills,7];getgvar[serverkills]", 7],
  [["getgvar"], "getgvar[none]", 0],
  [["testgvar", "setgvar"], "setgvar[g,1];testgvar[g]", true],
  [["touchgvar"], "touchgvar[g]", false],
  [["cleargvar", "setgvar"], "setgvar[g,1];cleargvar[g]", true],
  [["clearallgvars", "setgvar"], "setgvar[g,1];clearallgvars[]", (v, c) => (assert.equal(v, true), assert.deepStrictEqual(c.vars.names("g"), []))],
  // D. lists (reference semantics)
  [["listcreate"], "listcreate[1,2,3]", (v) => assert.equal(S(v), "[1,2,3]")],
  [["listcreate"], "listcreate[]", (v) => (assert.equal(typeName(v), "List"), assert.equal(S(v), "[]"))],
  [["listadd"], "$l=listcreate[a,b];listadd[$l,`c`];$l", (v) => assert.equal(S(v), "[a,b,c]")],
  [["listinsert"], "listinsert[listcreate[a,b,c],`x`,1]", (v) => assert.equal(S(v), "[a,x,b,c]")],
  [["listinsert"], "listinsert[listcreate[a,b,c],`x`,9]", 0],
  [["listremove"], "listremove[listcreate[a,b,a],`a`]", (v) => assert.equal(S(v), "[b,a]")],
  [["listremove"], "listremove[listcreate[a,b,c],`x`]", (v) => assert.equal(S(v), "[a,b,c]")],
  [["listremoveat"], "listremoveat[listcreate[a,b,c],1]", (v) => assert.equal(S(v), "[a,c]")],
  [["listremoveat"], "listremoveat[listcreate[a,b,c],5]", 0],
  [["listgetitem"], "listgetitem[listcreate[a,b,c],2]", "c"],
  [["listgetitem"], "listgetitem[listcreate[a,b,c],3]", null],
  [["listcontains"], "listcontains[listcreate[a,b,c],`B`]", true],
  [["listcontains"], "listcontains[listcreate[a,b,c],`x`]", false],
  [["listindexof"], "listindexof[listcreate[a,b,c],`b`]", 1],
  [["listindexof"], "listindexof[listcreate[a,b,c],`x`]", -1],
  [["listlastindexof"], "listlastindexof[listcreate[a,b,a],`a`]", 2],
  [["listcopy"], "$o=listcreate[a];$c=listcopy[$o];listadd[$c,b];listcount[$o]*10+listcount[$c]", 12],
  [["listreverse"], "$o=listcreate[a,b,c];$r=listreverse[$o];listgetitem[$o,0]+listgetitem[$r,0]", "ac"],
  [["listpop"], "$p=listcreate[a,b,c];listpop[$p]+listcount[$p]", "c2"],
  [["listpop"], "listpop[listcreate[a,b,c],0]", "a"],
  [["listpop"], "listpop[listcreate[]]", null],
  [["listcount"], "listcount[listcreate[a,b,c]]", 3],
  [["listcount"], "listcount[notalist]", 0],
  [["listclear"], "$q=listcreate[a,b];listclear[$q];listcount[$q]", 0],
  [["listfromrange"], "listfromrange[5,1]", (v) => assert.equal(S(v), "[5,4,3,2,1]")],
  [["listfromrange"], "listfromrange[1,5]", (v) => assert.equal(S(v), "[1,2,3,4,5]")],
  [["listfilter"], "listfilter[listfromrange[1,5], `$1 > 2`]", (v) => assert.equal(S(v), "[3,4,5]")],
  [["listfilter"], "listfilter[listfromrange[1,5], `$0 > 2`]", (v) => assert.equal(S(v), "[4,5]")],
  [["listmap"], "listmap[listfromrange[1,3], `$1 * 2`]", (v) => assert.equal(S(v), "[2,4,6]")],
  [["listmap"], "listmap[listfromrange[1,3], `$1`];testvar[1]", false, "template bindings live in a child scope"],
  [["listreduce"], "listreduce[listfromrange[1,5], `$2 + $1`]", 15],
  [["listreduce"], "listreduce[listcreate[], `$2 + $1`]", 0],
  [["listsort"], "listsort[listfromrange[3,1], `$1 - $2`]", (v) => assert.equal(S(v), "[1,2,3]")],
  [["listsort"], "listsort[listfromrange[1,3], `$2 - $1`]", (v) => assert.equal(S(v), "[3,2,1]")],
  [["listsort"], "listsort[listcreate[10,9,100]]", (v) => assert.equal(S(v), "[9,10,100]")],
  // E. dictionaries
  [["dictcreate"], "dictcreate[a, 1, b, 2]", (v) => (assert.equal(typeName(v), "Dictionary"), assert.equal(S(v), "{a=>1,b=>2}"))],
  [["dictgetitem"], "dictgetitem[dictcreate[a,1],a]", 1],
  [["dictgetitem"], "dictgetitem[dictcreate[a,1],A]", null, "keys are case-sensitive"],
  [["dictadditem"], "$d=dictcreate[];dictadditem[$d,foo,42]", false],
  [["dictadditem"], "$d=dictcreate[foo,1];dictadditem[$d,foo,42];dictgetitem[$d,foo]", 42],
  [["dicthaskey"], "dicthaskey[dictcreate[foo,1],foo]", true],
  [["dictremovekey"], "$d=dictcreate[foo,1];dictremovekey[$d,foo]+dictsize[$d]", 1],
  [["dictkeys"], "dictkeys[dictcreate[a,1,b,2]]", (v) => assert.equal(S(v), "[a,b]")],
  [["dictvalues"], "dictvalues[dictcreate[a,1,b,2]]", (v) => assert.equal(S(v), "[1,2]")],
  [["dictsize"], "dictsize[dictcreate[a,1,b,2,c,3]]", 3],
  [["dictclear"], "$d=dictcreate[a,1];dictclear[$d];dictsize[$d]", 0],
  [["dictcopy"], "$d=dictcreate[a,1];$e=dictcopy[$d];dictadditem[$e,b,2];dictsize[$d]*10+dictsize[$e]", 12],
  // F. stopwatches (injected clock)
  [["stopwatchcreate"], "stopwatchcreate[]", (v) => (assert.equal(typeName(v), "Stopwatch"), assert.equal(v.startMs, null))],
  [
    ["stopwatchstart", "stopwatchstop", "stopwatchelapsedseconds"],
    "$sw=stopwatchcreate[];stopwatchstart[$sw]",
    (_v, c) => {
      c.clock.t += 1500;
      assert.equal(c.rt.evaluate("stopwatchelapsedseconds[$sw]"), 1.5);
      c.rt.evaluate("stopwatchstop[$sw]");
      c.clock.t += 10_000;
      assert.equal(c.rt.evaluate("stopwatchelapsedseconds[$sw]"), 1.5, "stopped watches do not run");
      c.rt.evaluate("stopwatchstart[$sw]");
      c.clock.t += 500;
      assert.equal(c.rt.evaluate("stopwatchelapsedseconds[$sw]"), 2);
      assert.equal(c.rt.evaluate("stopwatchelapsedseconds[nope]"), 0);
    },
  ],
  // G-T. time (injected clock)
  [["getunixtime"], "getunixtime[]", Math.floor(T0 / 1000)],
  [["getdatetimeutc"], "getdatetimeutc[`yyyy-MM-dd HH:mm:ss`]", "2026-10-12 13:05:09"],
  [["getdatetimeutc"], "getdatetimeutc[yyyy-MM-dd]", "2026-10-12", "an unbackticked format is taken literally"],
  [["getdatetimeutc"], "getdatetimeutc[`hh:mm:ss tt`]", "01:05:09 PM"],
  [["getdatetimeutc"], "getdatetimeutc[`dddd, MMMM d yyyy 'at' H\\h`]", "Monday, October 12 2026 at 13h"],
  [["getdatetimeutc"], "getdatetimeutc[`HH:mm:ss.fff`]", "13:05:09.123"],
  [
    ["getdatetimelocal"],
    "getdatetimelocal[`yyyy-MM-dd HH:mm`]",
    (v) => {
      const d = new Date(T0);
      const p = (n) => String(n).padStart(2, "0");
      assert.equal(v, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
    },
  ],
  // H-T. coordinates
  [["coordinateparse"], "coordinateparse[41.53N, 34.46E]", (v) => assert.deepStrictEqual(v, V.coords(41.53, 34.46, 0))],
  [["coordinateparse"], "coordinateparse[41.53N, 34.46E, 0.47Z]", (v) => assert.deepStrictEqual(v, V.coords(41.53, 34.46, 0.47))],
  [["coordinateparse"], "coordinateparse[12.5S 40.1W]", (v) => assert.deepStrictEqual(v, V.coords(-12.5, -40.1, 0))],
  [["coordinateparse"], "coordinateparse[`41.52994|34.46267|0.46669`]", (v) => assert.deepStrictEqual(v, V.coords(41.52994, 34.46267, 0.46669))],
  [["coordinateparse"], "coordinateparse[nowhere]", null],
  [["coordinategetns"], "coordinategetns[coordinateparse[41.53N, 34.46E]]", 41.53],
  [["coordinategetwe"], "coordinategetwe[coordinateparse[41.53N, 34.46W]]", -34.46],
  [["coordinategetz"], "coordinategetz[coordinateparse[41.53N, 34.46E, 0.47Z]]", 0.47],
  [["coordinatetostring"], "coordinatetostring[coordinateparse[41.53N, 34.46E, 0.47Z]]", "41.53N, 34.46E, 0.47Z"],
  [["coordinatetostring"], "coordinatetostring[coordinateparse[1.5S, 2.25W]]", "1.50S, 2.25W, 0.00Z"],
  [
    ["coordinatedistanceflat"],
    "coordinatedistanceflat[coordinateparse[1.2N, 3.4E], coordinateparse[1.2N, 3.5E]]",
    (v) => assert.ok(Math.abs(v - 24) < 1e-9, `0.1 map unit = 24 m, got ${v}`),
  ],
  [
    ["coordinatedistancewithz"],
    "coordinatedistancewithz[coordinateparse[1.2N, 3.4E, 0Z], coordinateparse[1.2N, 3.5E, 0.1Z]]",
    (v) => assert.ok(Math.abs(v - Math.sqrt(24 * 24 * 2)) < 1e-9, `got ${v}`),
  ],
  [["coordinatedistancewithz"], "coordinatedistancewithz[a,b]", 0],
];

await check(`coverage: every PURE_FUNCTION_NAMES entry (${PURE_FUNCTION_NAMES.length}) has at least one case`, () => {
  const covered = new Set(CASES.flatMap((c) => c[0]));
  const missing = PURE_FUNCTION_NAMES.filter((n) => !covered.has(n));
  assert.deepStrictEqual(missing, []);
  const unknown = [...covered].filter((n) => !PURE_FUNCTION_NAMES.includes(n));
  assert.deepStrictEqual(unknown, [], "cases name only registered functions");
});

for (const [names, src, expected, note] of CASES) {
  await check(`${names[0]}: ${src}${typeof note === "string" ? ` (${note})` : ""}`, () => {
    const ctx = makeRt();
    const v = ctx.rt.evaluate(src);
    assert.ok(!isErr(v), `unexpected error: ${toStr(v)}`);
    if (typeof expected === "function") expected(v, ctx);
    else assert.deepStrictEqual(v, expected, `${src} → ${typeName(v)} ${JSON.stringify(toStr(v))}`);
  });
}

// ── arity / misuse ──────────────────────────────────────────────────────

await check("arity misuse is an evaluation error (never silent garbage)", () => {
  const { rt } = makeRt();
  for (const src of ["iif[1]", "setvar[x]", "listadd[]", "dictadditem[a,b]", "atan2[1]", "delayexec[5]", "listinsert[a,b]", "stopwatchcreate[1]"]) {
    const v = rt.evaluate(src);
    assert.ok(isErr(v), `${src} should be an error, got ${toStr(v)}`);
    assert.match(v.msg, /expects at (least|most)/);
  }
  assert.ok(isErr(rt.evaluate("listfromrange[1,1000000]")), "listfromrange is size-capped");
});

// ── VarStore ────────────────────────────────────────────────────────────

await check("VarStore: p/g vars persist to rynth.vt.v1.pvars.<scope> / rynth.vt.v1.gvars", () => {
  const storage = fakeStorage();
  const a = makeRt({ storage, scope: "1342177281" });
  a.rt.evaluate("setpvar[Kills,3];setpvar[name,`Bob`];setgvar[server,7];setpvar[flag,1<2]");
  assert.equal(a.vars.flush(), true, "first flush writes at once");
  assert.deepStrictEqual(JSON.parse(storage.getItem("rynth.vt.v1.pvars.1342177281")), { Kills: 3, name: "Bob", flag: true });
  assert.deepStrictEqual(JSON.parse(storage.getItem("rynth.vt.v1.gvars")), { server: 7 });
  // a later page (new VarStore) reads them back; gvars are shared, pvars per scope
  const b = makeRt({ storage, scope: "1342177281" });
  assert.equal(b.rt.evaluate("getpvar[kills]"), 3);
  assert.equal(b.rt.evaluate("getgvar[SERVER]"), 7);
  const other = makeRt({ storage, scope: "1342177999" });
  assert.equal(other.rt.evaluate("getpvar[kills]"), 0, "another character has its own pvars");
  assert.equal(other.rt.evaluate("getgvar[server]"), 7, "gvars are origin-wide");
});

await check("VarStore: throttled flush (2 s) with an injected clock; force flushes", () => {
  const storage = fakeStorage();
  const { rt, vars, clock } = makeRt({ storage });
  rt.evaluate("setpvar[a,1]");
  assert.equal(vars.flush(), true);
  const n = storage.writes.length;
  rt.evaluate("setpvar[a,2]");
  clock.t += 1999;
  assert.equal(vars.flush(), false, "within 2 s of the last write");
  assert.equal(storage.writes.length, n);
  clock.t += 1;
  assert.equal(vars.flush(), true);
  assert.equal(JSON.parse(storage.getItem("rynth.vt.v1.pvars.1342177281")).a, 2);
  rt.evaluate("setpvar[a,3]");
  assert.equal(vars.flush({ force: true }), true, "force ignores the throttle");
  assert.equal(JSON.parse(storage.getItem("rynth.vt.v1.pvars.1342177281")).a, 3);
  assert.equal(vars.flush({ force: true }), false, "nothing dirty, nothing written");
  rt.evaluate("clearallpvars[]");
  vars.flush({ force: true });
  assert.equal(storage.getItem("rynth.vt.v1.pvars.1342177281"), null, "an empty map removes the key");
});

await check("VarStore: only scalars persist; lists/dicts/world objects are session-only", () => {
  const storage = fakeStorage();
  const { rt, vars } = makeRt({ storage });
  rt.evaluate("setpvar[l,listcreate[1,2]];setpvar[n,5]");
  assert.equal(toStr(rt.evaluate("getpvar[l]")), "[1,2]", "kept in memory for the session");
  vars.flush({ force: true });
  assert.deepStrictEqual(JSON.parse(storage.getItem("rynth.vt.v1.pvars.1342177281")), { n: 5 });
});

await check("VarStore: storage failures keep the in-memory value and log once; never throw", () => {
  const storage = fakeStorage({ failWrites: true });
  const { rt, vars, logs } = makeRt({ storage });
  rt.evaluate("setgvar[x,1]");
  vars.flush({ force: true });
  rt.evaluate("setgvar[x,2]");
  vars.flush({ force: true });
  assert.equal(rt.evaluate("getgvar[x]"), 2);
  assert.equal(logs.filter((m) => m.includes("cannot write rynth.vt.v1.gvars")).length, 1, JSON.stringify(logs));
  const broken = { getItem: () => "{not json", setItem() {}, removeItem() {} };
  const v2 = new VarStore({ storage: broken, log: () => {} });
  assert.equal(v2.get("p", "x"), undefined);
});

await check("VarStore: default storage is in-memory; setScope flushes the old character first", () => {
  const mem = new VarStore();
  mem.set("p", "a", 1);
  assert.equal(mem.flush({ force: true }), true);
  assert.equal(mem.get("p", "A"), 1);
  const storage = fakeStorage();
  const v = new VarStore({ storage, scope: "11", now: () => 0 });
  v.set("p", "k", 1);
  v.setScope("22");
  assert.deepStrictEqual(JSON.parse(storage.getItem("rynth.vt.v1.pvars.11")), { k: 1 });
  assert.equal(v.get("p", "k"), undefined, "the new character starts with its own pvars");
});

await check("VarStore: exportSession/importSession keep values by reference (page-level session, D6)", () => {
  const { rt, vars } = makeRt();
  rt.evaluate("$list=listcreate[a];$n=3");
  const snap = vars.exportSession();
  const { rt: rt2, vars: vars2 } = makeRt();
  vars2.importSession(snap);
  rt2.evaluate("listadd[$list,b]");
  assert.equal(rt2.evaluate("$n"), 3);
  assert.equal(toStr(rt.evaluate("$list")), "[a,b]", "same list object on both sides of the rebind");
  vars2.importSession(null);
  assert.deepStrictEqual(vars2.names("session"), []);
});

// ── FunctionRegistry ────────────────────────────────────────────────────

await check("FunctionRegistry: case-insensitive, re-define replaces and logs one warning", () => {
  const logs = [];
  const r = new FunctionRegistry({ log: (m) => logs.push(m) });
  assert.equal(r.define("MyFn", () => 1, { minArgs: 1, maxArgs: 2 }), true);
  assert.equal(r.has("myfn"), true);
  assert.deepStrictEqual(Object.keys(r.get("MYFN")).sort(), ["impl", "lazy", "maxArgs", "minArgs"]);
  assert.equal(r.get("myfn").minArgs, 1);
  assert.equal(r.get("nope"), null);
  r.define("myfn", () => 2);
  assert.equal(logs.filter((m) => m.includes('"myfn" redefined')).length, 1);
  const rt = new ExprRuntime({ functions: r, now: () => 0 });
  assert.equal(rt.evaluate("myFN[]"), 2, "the new definition wins");
  assert.deepStrictEqual(r.names(), ["myfn"]);
  assert.equal(r.define("", () => 1), false);
  // registerPureStdlib twice: every name re-defined once
  const r2 = new FunctionRegistry({ log: (m) => logs.push(m) });
  registerPureStdlib(r2);
  const before = logs.length;
  registerPureStdlib(r2);
  assert.equal(logs.length - before, PURE_FUNCTION_NAMES.length);
  assert.deepStrictEqual(r2.names(), [...PURE_FUNCTION_NAMES].sort());
});

await check("host functions plug in through the same registry (lazy + call.raw + evalText)", () => {
  const { rt, functions } = makeRt();
  const seen = [];
  functions.define(
    "rawprobe",
    (args, call) => {
      seen.push(call.raw.slice());
      return call.evalText("$1+1", { 1: 41 });
    },
    { lazy: true },
  );
  assert.equal(rt.evaluate("rawprobe[ a b , `c` ]"), 42);
  assert.deepStrictEqual(seen, [["a b", "`c`"]]);
  functions.define("errs", () => V.err("unsupported: errs"));
  const v = rt.evaluate("1+errs[]");
  assert.ok(isErr(v));
  assert.equal(v.msg, "unsupported: errs");
});

console.log(fail === 0 ? `rynth_vt_expr_stdlib: all ${pass} checks passed` : `rynth_vt_expr_stdlib: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
