// tests/rynth_vt_expr.test.mjs — rynth/vt/expr (W1-1 EXPR, PLAN §3.4).
//
// The shared VTank/UB expression language: grammar + precedence (D37 pins),
// the D14 whitespace rule (G:112-115), escapes and nested backticks, numbers,
// `;` / `$x=` / `$d{k}`, short-circuit and lazy iif, reference persistence of
// lists/dicts, the delayexec queue on a fake clock, budgets, error reporting
// (never truncation), the truthiness and equality tables, the .NET regex
// translator, and 40+ real expressions copied from the corpus metas
// (ColRings, BGAugGem, blodetetdict3, missingLegendaries) that must parse.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_expr.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPR_DIR = path.resolve(HERE, "../rynth/vt/expr");

const E = await import("../rynth/vt/expr/index.js");
const { parse, ExprRuntime, FunctionRegistry, VarStore, V, truthy, toStr, toNum, equals, typeName, isErr, translateRegex, getRegex, registerPureStdlib } = E;
const { lex } = await import("../rynth/vt/expr/lexer.js");
const { formatNumber } = await import("../rynth/vt/expr/values.js");

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

// A runtime with the pure library, an injected clock and a capturing log.
function makeRt({ mode = "meta", nodeBudget, maxDepth, resolveIdent } = {}) {
  const logs = [];
  const clock = { t: 1_000_000 };
  const functions = new FunctionRegistry({ log: (m) => logs.push(m) });
  registerPureStdlib(functions);
  const vars = new VarStore({ now: () => clock.t, log: (m) => logs.push(m) });
  const rt = new ExprRuntime({ functions, vars, mode, now: () => clock.t, log: (m) => logs.push(m), nodeBudget, maxDepth, resolveIdent });
  return { rt, functions, vars, clock, logs };
}

function ev(rt, src, opts) {
  return rt.evaluate(src, opts);
}

// ── precedence (D37 pins) ────────────────────────────────────────────────

await check("precedence: 1+2*3 = 7, a-b+c left-assoc, 13%3 = 1", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "1+2*3"), 7);
  assert.equal(ev(rt, "(1+2)*3"), 9);
  assert.equal(ev(rt, "9-4+2"), 7, "a-b+c = (a-b)+c");
  assert.equal(ev(rt, "13%3"), 1, "G:141 example");
});

await check("D37 pins: 10-2+3 = 11, 8/2*2 = 8, 7*5%3 = 2, 2+3#5 is true", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "10-2+3"), 11);
  assert.equal(ev(rt, "8/2*2"), 8);
  assert.equal(ev(rt, "7*5%3"), 2);
  assert.equal(ev(rt, "2+3#5"), true, '"5"#"5"');
});

await check("precedence: x#y+z binds as x#(y+z); # below + -, above comparisons", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "abcd#b+c"), true, "abcd # (b+c) = abcd # bc");
  assert.equal(ev(rt, "abd#b+c"), false);
  assert.equal(ev(rt, "abc#b==1"), true, "(abc#b)==1");
});

await check("precedence: 1<2==1 (comparisons one level, left-assoc); a&&b||c", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "1<2==1"), true);
  assert.equal(ev(rt, "3>2>1"), false, "(3>2)>1 = 1>1");
  assert.equal(ev(rt, "0&&1||1"), true, "(0&&1)||1");
  assert.equal(ev(rt, "1||0&&0"), true, "1||(0&&0)");
  assert.equal(ev(rt, "0&&1||0"), false);
});

await check("bitwise and shifts sit between && and comparisons; 64-bit masks stay positive", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "6|1"), 7);
  assert.equal(ev(rt, "7^3"), 4);
  assert.equal(ev(rt, "7&3"), 3);
  assert.equal(ev(rt, "~0"), -1);
  assert.equal(ev(rt, "1<<4"), 16);
  assert.equal(ev(rt, "16>>2"), 4);
  assert.equal(ev(rt, "1+1<<2"), 8, "<< below +");
  assert.equal(ev(rt, "6&3==3"), 0, "6 & (3==3 → 1) = 0: & is below comparisons (plan grammar)");
  assert.equal(ev(rt, "0xFFFFFFFF&0xF0000000"), 0xf0000000);
});

// ── whitespace rule (D14, G:112-115) ─────────────────────────────────────

await check("whitespace rule: the four G:112-115 monster examples with a fake resolveIdent", () => {
  const mob = (o) => (word) => (Object.prototype.hasOwnProperty.call(o, word) ? o[word] : undefined);
  const { rt } = makeRt({ mode: "monster" });
  const ravener = mob({ range: 10, species: "Drudge", name: "Drudge Ravener" });
  const skulker = mob({ range: 10, species: "Drudge", name: "Drudge Skulker" });
  const close = mob({ range: 3, species: "Drudge", name: "Drudge Skulker" });
  const moss = mob({ range: 10, species: "Mosswart", name: "Mosswart Mudstealer" });
  const ex = [
    "range>5",
    "range>5 && species==drudge",
    "range>5 && species==drudge",
    "range>5 && species==drudge && name!=drudge ravener",
  ];
  const run = (src, r) => rt.evaluate(parse(src, { mode: "monster" }), { resolveIdent: r });
  assert.equal(run(ex[0], skulker), true);
  assert.equal(run(ex[0], close), false);
  assert.equal(run(ex[1], skulker), true, "case-insensitive string compare (G:147)");
  assert.equal(run(ex[1], moss), false);
  assert.equal(run(ex[2], close), false);
  assert.equal(run(ex[3], skulker), true);
  assert.equal(run(ex[3], ravener), false, "'drudge ravener' kept its inner space");
  // unknown identifier = literal string (G:119)
  assert.equal(run("species==mosswart", moss), true);
  assert.equal(run("banana", moss), "banana");
});

await check("whitespace rule: kept next to + - * / % # ; (\\/t +x keeps the space), trimmed at arg boundaries", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "\\/t +abc"), "/t abc");
  assert.equal(ev(rt, "Legendary +Strength"), "Legendary Strength");
  assert.equal(ev(rt, "strlen[  abc  ]"), 3, "function args trimmed");
  assert.equal(ev(rt, "setvar[ x , hello world ];getvar[x]"), "hello world");
  assert.equal(ev(rt, "abc == abc"), true, "trimmed next to ==");
  assert.equal(ev(rt, "$x = 5 ; $x * 2"), 10);
  assert.equal(ev(rt, "a\\ +b"), "a b", "an escaped space is content, never trimmed");
  assert.equal(ev(rt, "`abc` + `def`"), "abcdef", "whitespace-only tokens are never operands");
});

await check("whitespace rule: ColRings chatbox idiom produces the exact tell text", () => {
  const { rt, functions } = makeRt();
  const said = [];
  functions.define("chatbox", (a) => {
    said.push(toStr(a[0]));
    return true;
  });
  functions.define("getcharstringprop", () => "Bob");
  ev(rt, "chatbox[\\/t +getcharstringprop[1]+\\, Press Go to\\, uh\\, go\\.]");
  assert.deepStrictEqual(said, ["/t Bob, Press Go to, uh, go."]);
});

// ── escapes / backticks ─────────────────────────────────────────────────

await check("escapes: \\, \\/ \\. \\[ and the guide's \".\\*\"", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "a\\,b"), "a,b");
  assert.equal(ev(rt, "\\/vt echo"), "/vt echo");
  assert.equal(ev(rt, "go\\."), "go.");
  assert.equal(ev(rt, "\\[x\\]"), "[x]");
  assert.equal(ev(rt, ".\\*"), ".*", 'G:150: ".\\*" yields ".*" rather than multiplying');
  assert.equal(ev(rt, '".\\*"'), '".*"', "double quotes are ordinary characters");
  assert.equal(ev(rt, "a\\"), "a\\", "a trailing lone backslash is literal");
});

await check("nested backticks: \\` one level down, \\\\` two levels down (corpus convention)", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "`a\\`b`"), "a`b");
  assert.equal(ev(rt, "exec[`exec[\\`1+1\\`]`]"), 2);
  assert.equal(ev(rt, "exec[`exec[\\`exec[\\\\`2*3\\\\`]\\`]`]"), 6);
  assert.equal(ev(rt, "`neftet\\T'ing Setsuko`"), "neftet\\T'ing Setsuko", "backslash before a non-backtick is literal");
  assert.equal(ev(rt, "``"), "");
  assert.equal(ev(rt, "ifthen[1, `setvar[r,\\`yes\\`]`, `setvar[r,no]`];$r"), "yes");
});

// ── numbers ─────────────────────────────────────────────────────────────

await check("numbers: decimal, hex, negatives, .5, 5.", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "0x10+1"), 17);
  assert.equal(ev(rt, "0xff==255"), true);
  assert.equal(ev(rt, "-5+2"), -3);
  assert.equal(ev(rt, "-0x10"), -16);
  assert.equal(ev(rt, ".5+.5"), 1);
  assert.equal(ev(rt, "5.*2"), 10);
  assert.equal(ev(rt, "1.25*4"), 5);
  assert.equal(ev(rt, "3>-1"), true);
  assert.equal(ev(rt, "--3"), 3);
  assert.equal(typeName(ev(rt, "42")), "Number");
  assert.equal(typeName(ev(rt, "4 2")), "String", "a token with an inner space is text");
});

await check("number formatting follows .NET \"G\" (upper-case E, exponent outside 1e-5..1e15)", () => {
  assert.equal(formatNumber(0.1 + 0.2), "0.30000000000000004");
  assert.equal(formatNumber(1e15), "1E+15");
  assert.equal(formatNumber(123456789012345), "123456789012345");
  assert.equal(formatNumber(1e20), "1E+20");
  assert.equal(formatNumber(0.0001), "0.0001");
  assert.equal(formatNumber(0.00001), "1E-05");
  assert.equal(formatNumber(-2.5e-7), "-2.5E-07");
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(NaN), "NaN");
  assert.equal(toStr(true), "1");
  assert.equal(toStr(false), "0");
});

// ── ; $x= $d{k} ─────────────────────────────────────────────────────────

await check("`;` sequences (value = last; trailing ; allowed)", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "setvar[a,1];getvar[a]+1"), 2);
  assert.equal(ev(rt, "1;2;"), 2);
  assert.equal(ev(rt, "setvar[selltimer,stopwatchcreate[]];stopwatchstart[$selltimer]").t, "sw");
});

await check("`$x=` assignment: returns its value, right-assoc, works inside args and after &&", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "$x=5;$x*2"), 10);
  assert.equal(ev(rt, "$y=$z=3;$y+$z"), 6);
  assert.equal(ev(rt, "strlen[$w=abcd]"), 4);
  assert.equal(ev(rt, "$w"), "abcd");
  assert.equal(ev(rt, "1&&$q=7"), true);
  assert.equal(ev(rt, "$q"), 7);
  assert.equal(ev(rt, "$missing"), 0, "missing $x is 0");
  assert.equal(ev(rt, "getvar[missing]"), 0, "getvar of a missing name is 0");
});

await check("`$d{key}` dict index, list{i}, string slices {a:b}", () => {
  const { rt } = makeRt();
  assert.equal(ev(rt, "$d=dictcreate[a,1,b,2];$d{b}"), 2);
  assert.equal(ev(rt, "$d{zz}"), null);
  assert.equal(ev(rt, "$l=listcreate[a,b,c];$l{1}"), "b");
  assert.equal(ev(rt, "$l{-1}"), "c");
  assert.equal(toStr(ev(rt, "$l{1:}")), "[b,c]");
  assert.equal(ev(rt, "`Legendary Strength`{10:}"), "Strength");
  assert.equal(ev(rt, "abcdef{1:3}"), "bc");
  assert.equal(ev(rt, "$k=b;$d{$k}"), 2);
});

// ── short-circuit / laziness / references ───────────────────────────────

await check("short-circuit: count!=0&&setvar[item,id] sets nothing when count is 0 (ColRings)", () => {
  const { rt, functions, vars } = makeRt();
  let count = 0;
  functions.define("getinventorycountbytemplatetype", () => count);
  ev(rt, "getinventorycountbytemplatetype[34704]!=0&&setvar[item,34704]");
  assert.equal(vars.has("session", "item"), false);
  count = 2;
  assert.equal(ev(rt, "getinventorycountbytemplatetype[34704]!=0&&setvar[item,34704]"), true);
  assert.equal(vars.get("session", "item"), 34704);
  ev(rt, "1||setvar[z,1]");
  assert.equal(vars.has("session", "z"), false, "|| short-circuits too");
  assert.equal(typeof ev(rt, "5&&abc"), "boolean", "&& yields Bool (plan §3.4)");
});

await check("lazy iif/if/ifthen: only the chosen branch runs", () => {
  const { rt, vars } = makeRt();
  assert.equal(ev(rt, "iif[1, setvar[a,yes], setvar[b,no]]"), "yes");
  assert.equal(vars.get("session", "a"), "yes");
  assert.equal(vars.has("session", "b"), false);
  assert.equal(ev(rt, "if[0, setvar[c,1]]"), "");
  assert.equal(vars.has("session", "c"), false);
  assert.equal(ev(rt, "iif[0,2,3]"), 3);
  assert.equal(ev(rt, "ifthen[0, `setvar[d,1]`, `setvar[d,2]`]"), 2);
});

await check("lists and dicts are references that survive across evaluate calls", () => {
  const { rt } = makeRt();
  ev(rt, "$l=listcreate[1]");
  ev(rt, "listadd[$l,2]");
  assert.equal(ev(rt, "listcount[$l]"), 2);
  // blodetetdict3: nested dict mutated through dictgetitem across rules
  ev(rt, "setvar[mobs,dictcreate[]]");
  ev(rt, "dictadditem[$mobs,Drudge,dictcreate[AP,0.5,Hit,0,Miss,0]]");
  ev(rt, "dictadditem[dictgetitem[$mobs,Drudge],Miss, dictgetitem[dictgetitem[$mobs,Drudge],Miss]+1]");
  ev(rt, "dictadditem[dictgetitem[$mobs,Drudge],Miss, dictgetitem[dictgetitem[$mobs,Drudge],Miss]+1]");
  assert.equal(ev(rt, "dictgetitem[dictgetitem[$mobs,Drudge],Miss]"), 2);
  // blodetetdict3: listadd on an iif-selected list, then listpop drains it
  ev(rt, "setvar[NPCs,listcreate[]]");
  ev(rt, "listadd[iif[1,$NPCs,listcreate[]],`neftet\\Setsuko`]");
  ev(rt, "listadd[iif[0,$NPCs,listcreate[]],`neftet\\Nobody`]");
  ev(rt, "listadd[iif[1,$NPCs,listcreate[]],`neftet\\Adarl`]");
  assert.equal(ev(rt, "listcount[$NPCs]"), 2);
  assert.equal(ev(rt, "`/vt nav load `+listpop[$NPCs]"), "/vt nav load neftet\\Adarl");
  assert.equal(ev(rt, "listcount[$NPCs]"), 1, "listpop removes (UB semantics)");
});

// ── delayexec ───────────────────────────────────────────────────────────

await check("delayexec: FIFO by due time then insertion, pumped only by pump(now)", () => {
  const { rt, clock } = makeRt();
  ev(rt, "$order=listcreate[]");
  ev(rt, "delayexec[300,`listadd[$order,c]`]");
  ev(rt, "delayexec[100,`listadd[$order,a]`]");
  ev(rt, "delayexec[100,`listadd[$order,b]`]");
  assert.equal(rt.pendingDelayed, 3);
  assert.equal(toStr(ev(rt, "$order")), "[]", "nothing runs without pump");
  clock.t += 5000;
  assert.equal(toStr(ev(rt, "$order")), "[]", "the clock alone does nothing");
  assert.equal(rt.pump(1_000_050), 0);
  assert.equal(rt.pump(1_000_100), 2);
  assert.equal(toStr(ev(rt, "$order")), "[a,b]");
  assert.equal(rt.pump(1_000_300), 1);
  assert.equal(toStr(ev(rt, "$order")), "[a,b,c]");
  // an entry scheduled while pumping waits for the next pump
  const t0 = clock.t;
  ev(rt, "delayexec[0,`delayexec[0,\\`listadd[$order,d]\\`]`]");
  assert.equal(rt.pump(t0), 1);
  assert.equal(toStr(ev(rt, "$order")), "[a,b,c]");
  assert.equal(rt.pump(t0), 1);
  assert.equal(toStr(ev(rt, "$order")), "[a,b,c,d]");
  ev(rt, "delayexec[10,`listadd[$order,e]`]");
  rt.clearDelayed();
  assert.equal(rt.pump(t0 + 1000), 0);
});

// ── budgets / errors ────────────────────────────────────────────────────

await check("budgets: node visits, evaluation depth, bracket nesting", () => {
  const { rt } = makeRt();
  const big = ev(rt, "listmap[listfromrange[1,30000],`$1`]");
  assert.ok(isErr(big) && /budget/.test(big.msg), toStr(big));
  const deep = ev(rt, "$e=`exec[$e]`;exec[$e]");
  assert.ok(isErr(deep) && /depth/.test(deep.msg), toStr(deep));
  const small = makeRt({ nodeBudget: 10 }).rt;
  assert.ok(isErr(small.evaluate("1+1+1+1+1+1+1+1")));
  assert.equal(small.evaluate("1+1"), 2);
  const p300 = `${"(".repeat(300)}1${")".repeat(300)}`;
  assert.ok(isErr(ev(rt, p300)), "nesting deeper than 256 is an error");
  const p200 = `${"(".repeat(200)}1${")".repeat(200)}`;
  assert.equal(ev(rt, p200), 1);
});

await check("unknown function ⇒ Err (never silent \"\"), lastError recorded with the injected clock", () => {
  const { rt } = makeRt();
  const v = ev(rt, "nosuchfn[1]");
  assert.ok(isErr(v));
  assert.equal(v.msg, 'Call to unknown function "nosuchfn"');
  assert.deepStrictEqual(rt.lastError, { msg: v.msg, at: 1_000_000 });
  assert.ok(isErr(ev(rt, "1+nosuchfn[]")), "an error inside an operand fails the whole expression");
  assert.ok(isErr(ev(rt, "iif[]")), "arity errors are errors");
});

await check("dangling operator / unbalanced bracket ⇒ Err, no truncation", () => {
  const { rt } = makeRt();
  for (const bad of ["1+", "1 &&", "!", "getvar[x", "a]", "(1", "1)", "`abc", "$", "1+*2", "a(1)", "$d{}"]) {
    const p = parse(bad);
    assert.equal(p.ok, false, `parse(${JSON.stringify(bad)}) must fail`);
    assert.ok(Number.isInteger(p.pos));
    assert.ok(isErr(ev(rt, bad)), `evaluate(${JSON.stringify(bad)}) must be Err`);
  }
  // A real corpus line with a missing ']' (ColRings) is an error, not a truncated call.
  const colRingsBug = "actiontrygiveitem[wobjectfindininventorybytemplatetype[getvar[item]],wobjectfindnearestbytemplatetype[34441]";
  const p = parse(colRingsBug);
  assert.equal(p.ok, false);
  assert.match(p.error, /never closed/);
});

await check("evaluate never throws (fuzzed inputs, throwing impls, bad parsed objects)", () => {
  const { rt, functions } = makeRt();
  functions.define("boom", () => {
    throw new Error("kaboom");
  });
  functions.define("recurse", (_a, call) => call.rt.evaluate("recurse[]"));
  assert.ok(isErr(ev(rt, "boom[]")));
  assert.match(ev(rt, "boom[]").msg, /kaboom/);
  assert.ok(isErr(ev(rt, "recurse[]")));
  assert.ok(isErr(rt.evaluate({ ok: false, error: "x", pos: 3 })));
  assert.ok(isErr(rt.evaluate({})));
  const chars = "()[]{},;#+-*/%<>=!&|^~$`\\ ab1.:";
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 400; i++) {
    let s = "";
    const n = 1 + Math.floor(rnd() * 24);
    for (let j = 0; j < n; j++) s += chars[Math.floor(rnd() * chars.length)];
    rt.evaluate(s);
    rt.evaluate(parse(s, { mode: "monster" }));
  }
});

// ── truthiness / equality tables ────────────────────────────────────────

await check("truthiness table", () => {
  const falsy = [null, undefined, "", 0, -0, "0", "false", "FALSE", "False", false, V.list([]), V.err("x")];
  const truthyVals = ["abc", 1, -1, 0.5, "0.0", " 0", "true", true, V.list([0]), V.dict(), V.wobj(5, "x"), V.coords(1, 2, 0), V.sw()];
  for (const v of falsy) assert.equal(truthy(v), false, `truthy(${toStr(v)}) should be false`);
  for (const v of truthyVals) assert.equal(truthy(v), true, `truthy(${toStr(v)}) should be true`);
});

await check("equality table: numeric strings, case-insensitive strings, bool vs number", () => {
  assert.equal(equals(5, "5.0"), true);
  assert.equal(equals(" 5 ", 5), true, "numeric after trim");
  assert.equal(equals("0x10", 16), true);
  assert.equal(equals("abc", "ABC"), true);
  assert.equal(equals("abc", "abd"), false);
  assert.equal(equals("abc ", "abc"), false, "string compare is not trimmed");
  assert.equal(equals(true, 1), true);
  assert.equal(equals(false, 0), true);
  assert.equal(equals(true, "true"), true);
  assert.equal(equals(true, 2), false);
  assert.equal(equals(null, ""), true);
  assert.equal(equals(V.wobj(7, "a"), V.wobj(7, "b")), true, "wobj by guid");
  assert.equal(equals(V.wobj(7, "a"), V.wobj(8, "a")), false);
  assert.equal(equals(V.wobj(7, "a"), 0), false);
  const { rt } = makeRt();
  assert.equal(ev(rt, "`5`==5.0"), true);
  assert.equal(ev(rt, "Drudge==DRUDGE"), true);
  assert.equal(ev(rt, "$t=1<2;$t==1"), true);
  assert.equal(ev(rt, "abc<5"), true, "non-numeric is 0 for < (0<5)");
  assert.equal(ev(rt, "abc+1"), "abc1", "+ concatenates when a side is not numeric");
  assert.equal(ev(rt, "`2`+`3`"), 5, "+ adds numeric strings");
  assert.equal(ev(rt, "5/0"), 0);
  assert.equal(ev(rt, "5%0"), 0);
  assert.equal(ev(rt, "-7%3"), -1);
  assert.equal(toNum("abc"), 0);
});

// ── modes / refs / dynamic ──────────────────────────────────────────────

await check("monster mode: refs, dynamic, setting_X case passed through, true/false built-ins", () => {
  const p = parse("range>5 && species==drudge", { mode: "monster" });
  assert.equal(p.ok, true);
  assert.equal(p.mode, "monster");
  assert.ok(p.refs.has("range") && p.refs.has("species") && p.refs.has("drudge"));
  assert.equal(p.dynamic, true);
  assert.equal(parse("species==drudge && maxhp<1000", { mode: "monster" }).dynamic, false);
  assert.equal(parse("setting_DoJiggle", { mode: "monster" }).dynamic, true);
  assert.equal(parse("metastate==hunt", { mode: "monster" }).dynamic, true);
  assert.equal(parse("hasshield", { mode: "monster" }).dynamic, true);
  assert.equal(parse("getvar[x]==1", { mode: "monster" }).dynamic, true, "calls are never cached as static");
  assert.ok(parse("getvar[x]").refs.has("getvar"), "called function names are refs");
  const seen = [];
  const { rt } = makeRt({ mode: "monster" });
  const v = rt.evaluate("setting_DoJiggle", {
    resolveIdent: (lower, orig) => {
      seen.push([lower, orig]);
      return lower === "setting_dojiggle" ? true : undefined;
    },
  });
  assert.equal(v, true);
  assert.deepStrictEqual(seen, [["setting_dojiggle", "setting_DoJiggle"]]);
  assert.equal(rt.evaluate("true&&!false"), true, "true/false are monster built-ins");
});

await check("meta mode: bare words stay literal strings (D34) even with a resolveIdent", () => {
  const { rt } = makeRt();
  const called = [];
  const v = rt.evaluate("metastate", { resolveIdent: (w) => (called.push(w), "Hunt") });
  assert.equal(v, "metastate");
  assert.deepStrictEqual(called, []);
  assert.equal(ev(rt, "range>5"), false, "literal 'range' is 0 for >");
  assert.equal(ev(rt, "true"), "true");
  assert.equal(ev(rt, "false||0"), false, '"false" is falsy');
});

await check("lexer: `:` is special only inside {…}; whitespace-only tokens dropped", () => {
  const t1 = lex("a:b").tokens;
  assert.equal(t1.length, 1);
  assert.equal(t1[0].text, "a:b");
  const t2 = lex("x{1:2}").tokens.map((t) => (t.type === "op" ? t.v : t.text));
  assert.deepStrictEqual(t2, ["x", "{", "1", ":", "2", "}"]);
  const t3 = lex("`a`  +  `b`").tokens.map((t) => t.type);
  assert.deepStrictEqual(t3, ["bt", "op", "bt"]);
});

// ── regex (.NET → JS) ───────────────────────────────────────────────────

await check(".NET regex: duplicate named groups renamed + merged (BuffOnTell7s corpus pattern)", () => {
  const pat = "(^(\\[[A-z]+?\\] |)((?<name>[You][^\\<]*))|.*\\<Tell:IIDString:.+:((?<name>[^\\<]*))\\>.+\\<\\\\Tell\\>) (?<saythink>(tells you|think)), \\\"(?<action>.*buf.*)\\\"$";
  const tr = translateRegex(pat);
  assert.equal(tr.ok, true, tr.warning);
  assert.deepStrictEqual(tr.groupMap, { name: ["name", "name__2"] });
  const rx = getRegex(pat);
  assert.ok(rx instanceof RegExp);
  const m = rx.exec('<Tell:IIDString:1342177280:Bob>Bob<\\Tell> tells you, "buff me please"\n');
  assert.ok(m, "matches the tell markup (trailing newline stripped)");
  assert.equal(m.groups.name, "Bob");
  assert.equal(m.groups.action, "buff me please");
  assert.equal("name__2" in m.groups, false, "renamed alias removed after merging");
});

await check(".NET regex: (?i) inline option, \\A \\Z anchors, case-sensitive by default", () => {
  assert.equal(translateRegex("(?i)hello").flags.includes("i"), true);
  assert.equal(getRegex("(?i)hello").test("say HELLO"), true);
  assert.equal(getRegex("hello").test("say HELLO"), false, "case-sensitive unless asked");
  assert.equal(getRegex("hello", "i").test("say HELLO"), true);
  assert.equal(getRegex("\\Aabc\\Z").test("abc\n"), true);
  assert.equal(getRegex("\\Aabc\\Z").test("xabc"), false);
  assert.equal(getRegex("(?'w'\\w+) end").exec("word end").groups.w, "word");
  const scoped = translateRegex("a(?i:b)c");
  assert.equal(scoped.ok, true);
  assert.equal(scoped.source, "a(?:b)c");
  assert.ok(scoped.warning, "scoped option approximation is reported");
  const { rt } = makeRt();
  assert.equal(ev(rt, "HELLO#hel"), true, "# is case-insensitive");
});

await check(".NET regex: bad / unsupported pattern ⇒ no match + exactly one warning per pattern", () => {
  const { rt, logs } = makeRt();
  const before = logs.length;
  assert.equal(ev(rt, "abc#`(unclosed`"), false);
  assert.equal(ev(rt, "abc#`(unclosed`"), false);
  assert.equal(getRegex("(unclosed"), null);
  const warns = logs.slice(before).filter((m) => m.includes("(unclosed"));
  assert.equal(warns.length, 1, JSON.stringify(logs));
  for (const bad of ["a++", "(?>atomic)", "a*+", "(?(x)y|z)", "[a-z-[aeiou]]", "\\Gx", "(?x) a b"]) {
    assert.equal(translateRegex(bad).ok, false, `${bad} must be rejected`);
  }
  assert.equal(translateRegex("a+?b*?c??").ok, true, "lazy quantifiers are fine");
  assert.equal(translateRegex("\\d{2}+").ok, false, "possessive after {n}");
});

await check(".NET regex: the translated-pattern cache is an LRU bounded at 2048 (RegexCache.MaxEntries)", async () => {
  const R = await import("../rynth/vt/expr/regex.js");
  assert.equal(R.REGEX_CACHE_MAX, 2048);
  const keep = getRegex("lru-keep-me");
  for (let i = 0; i < 2100; i++) {
    getRegex(`lru-fill-${i}`);
    if (i % 500 === 0) assert.equal(getRegex("lru-keep-me"), keep, "a recently used entry stays cached");
  }
  assert.ok(R.regexCacheSize() <= 2048, `cache size ${R.regexCacheSize()}`);
  assert.equal(getRegex("lru-keep-me"), keep);
});

// ── the corpus ──────────────────────────────────────────────────────────

// Copied verbatim (JSON-escaped) from CORPUS/*.met `e` records (Expr / DoExpr / ChatExpr).
const CORPUS_EXPRESSIONS = [
  // ColRings-c3986fd7f878c745.met
  "chatbox[\\/t +getcharstringprop[1]+\\, Press Go to\\, uh\\, go\\.]",
  "clearallvars[]",
  "wobjectfindnearestbytemplatetype[34441]==0",
  "chatbox[\\/t +getcharstringprop[1]+\\, I am not where I should be\\.]",
  "getinventorycountbytemplatetype[34704]+getinventorycountbytemplatetype[34705]+getinventorycountbytemplatetype[34706]+getinventorycountbytemplatetype[34707]+getinventorycountbytemplatetype[34708]==0",
  "chatbox[\\/t +getcharstringprop[1]+\\, Out of rings\\.]",
  "getinventorycountbytemplatetype[34704]!=0&&setvar[item,34704]",
  // BGAugGem-e4623d0c5858aa80.met
  "isfalse[getisspellknown[2931]]",
  "setvar[PortalBot, `Brycter's Tinker`]",
  "setvar[AugCount,getitemcountininventorybyname[Blank Augmentation Gem]]",
  "$GetAug==1&&$Flagged==1",
  "getitemcountininventorybyname[Blank Augmentation Gem]==$AugCount+1",
  "chatbox[`/ub opt set Vtank.PatchExpressionEngine True`]&&chatbox[`/ub delay 500 /ub mexec setvar[EngineSet,1]`]",
  "chatbox[`/vt settings loadchar Quest Profile`]&&chatbox[`/ub delay 500 /vt opt set EnableMeta True`]&&chatbox[`/ub delay 1000 /vt start`]",
  "chatbox[\\/t +getcharstringprop[1]+ \\, +`Grats on getting Aug, Bitch!`]",
  "wobjectgetopencontainer[]&&wobjectgetname[wobjectgetopencontainer[]]==Corpse of Sir Bellas",
  "getobjectinternaltype[wobjectfindnearestbynameandobjectclass[5, Sir Bellas]]==7&&coordinatedistancewithz[wobjectgetphysicscoordinates[wobjectfindnearestbynameandobjectclass[5, Sir Bellas]],getplayercoordinates[]]>=5",
  "setvar[TargetNS, round[coordinategetns[wobjectgetphysicscoordinates[wobjectfindnearestbynameandobjectclass[5, Sir Bellas]]]*1000]/1000]&&setvar[TargetWE, round[coordinategetwe[wobjectgetphysicscoordinates[wobjectfindnearestbynameandobjectclass[5, Sir Bellas]]]*1000]/1000]",
  "\\/ub delay 1000 \\/vt addnavpt +cstr[abs[$TargetNS]]+iif[$TargetNS>0, N, S]+\\,\\ +cstr[abs[$TargetWE]]+iif[$TargetWE>0, E, W]",
  "stopwatchstart[setvar[JawSearch, stopwatchcreate[]]]",
  "stopwatchstop[getvar[JawSearch]];clearvar[JawSearch]",
  "stopwatchelapsedseconds[getvar[JawSearch]]>=60",
  "istrue[getobjectinternaltype[wobjectfindnearestbynameandobjectclass[37,Fiun Rehlyun]]==7&&coordinatedistancewithz[wobjectgetphysicscoordinates[wobjectfindnearestbynameandobjectclass[37,Fiun Rehlyun]],getplayercoordinates[]]<=10]",
  "actiontrygiveitem[wobjectfindininventorybyname[Insatiable Eater Jaw],wobjectfindnearestbynameandobjectclass[37,`Fiun Rehlyun`]]",
  "chatbox[`/t `+getvar[PortalBot]+\\, Primary]",
  "$capturegroup_name==$PortalBot",
  "$PortalTimer!=0&&stopwatchelapsedseconds[$PortalTimer]>=24",
  // blodetetdict3-e18feafa04745cc5.met
  "$init",
  "wobjectgetselection[]!=0&&wobjectgetobjectclass[wobjectgetselection[]]==5&&wobjectgetid[wobjectgetselection[]]!=$target&&(dicthaskey[$mobs,setvar[mob,wobjectgetname[wobjectgetselection[]]]]||dictadditem[$mobs,$mob,dictcreate[AP,$AP,Hit,0,Miss,0]]==0)&&dictgetitem[dictgetitem[$mobs,$mob],AP]!=$AP",
  "`/vt setattackbar `+setvar[AP,dictgetitem[dictgetitem[$mobs,$mob],AP]]",
  "dictadditem[dictgetitem[$mobs,$mob],Miss, dictgetitem[dictgetitem[$mobs,$mob],Miss]+1]",
  "dictadditem[dictgetitem[$mobs,$mob],AP,iif[(dictgetitem[dictgetitem[$mobs,$mob],AP]/($hitrate+.02))>.9,.9,round[100*dictgetitem[dictgetitem[$mobs,$mob],AP]/($hitrate+.02)]/100]]",
  "iif[$lastAP!=setvar[AP,dictgetitem[dictgetitem[$mobs,$mob],AP]],`/vt setattackbar `+$AP,``]",
  "setvar[selltimer,stopwatchcreate[]];stopwatchstart[$selltimer]",
  "floor[stopwatchelapsedseconds[$selltimer]]>25",
  "isrefreshingquests[]||$refreshed",
  "listadd[iif[getqueststatus[DesertAreaCollectionBracersWait_0511]>0&&getitemcountininventorybyname[Engraved A'nekshay Bracers]>14,$NPCs,listcreate[]],`neftet\\T'ing Setsuko`]",
  "listadd[iif[(getquestktprogress[desertcactuskillcount]/getquestktrequired[desertcactuskillcount]==1)||(getqueststatus[desertcactuskilltask]==1&&getquestktrequired[desertcactuskillcount]==0),$NPCs,listcreate[]],`neftet\\Sir Unell bin Rakke`]",
  "listadd[iif[(getquestktprogress[killtaskdesertareamumiyah_0511]/getquestktrequired[killtaskdesertareamumiyah_0511]==1)||(getqueststatus[killtaskdesertareamumiyahwait_0511]==1&&getquestktrequired[ killtaskdesertareamumiyah_0511]==0),$NPCs,listcreate[]],`neftet\\Sir Adarl`]",
  "testvar[NPCs]&&listcount[$NPCs]>0",
  "`/vt nav load `+listpop[$NPCs]",
  "setvar[watcherErrors,iif[coordinatedistancewithz[$lastloc,$loc]<5,$watcherErrors+1,0]]",
  // missingLegendaries-6c83a20153239995.met
  "$EquipMask=dictcreate[HeadWear,0x00000001,Shirt,0x0000001A,HandWear,0x00000020,Pants,0x00000040,FootWear,0x00000100,ChestArmor,0x00000200,AbdomenArmor,0x00000400,UpperArmArmor,0x00000800,LowerArmArmor,0x00001000,UpperLegArmor,0x00002000,LowerLegArmor,0x00004000,NeckWear,0x00008000,WristWearLeft,0x00010000,WristWearRight,0x00020000,FingerWearLeft,0x00040000,FingerWearRight,0x00080000,HeldSlot,0x03500000,ShieldSlot,0x02200000,MissileAmmo,0x00800000,TrinketOne,0x04000000,Cloak,0x08000000,SigilOne,0x10000000,SigilTwo,0x20000000,SigilThree,0x40000000]",
  "$gear=dictcreate[];listmap[wobjectfindallinventory[],`ifthen[$s=wobjectgetintprop[$wo=$1,10],\\`dictadditem[$gear,listfilter[dictkeys[$EquipMask],\\\\`$EquipMask{$1}&$s>0\\\\`]{0},wobjectgetid[$wo]]\\`]`]",
  "$skillIDs=dictcreate[`6`,Invulnerability,`7`,Impregnability Defense,`14`,Arcane Prowess,`15`,Magic Resistance,`16`,Mana Conversion Prowess,`19`,Person Attunement,`20`,Deception Prowess,`21`,Healing Prowess,`22`,Jumping Prowess,`23`,Lockpicking Prowess,`24`,Sprint,`27`,Monster Attunment,`31`,Creature Enchantment Aptitude,`32`,Item Enchantment,`33`,Life Magic Aptitude,`34`,War Magic Aptitude,`35`,Leadership,`36`,Fealty,`37`,Fletching,`38`,Alchemical Prowess,`39`,Cooking Prowess,`40`,Salvaging Aptitude,`41`,Two Handed Combat Aptitude,`43`,Void Magic Aptitude,`44`,Heavy Weapon Aptitude,`45`,Light Weapon Aptitude,`46`,Finesse Weapon Aptitude,`47`,Missile Weapon Aptitude,`48`,Shield Aptitude,`49`,Dual Wield Aptitude,`50`,Recklessness Prowess,`51`,Sneak Attack Prowess,`52`,Dirty Fighting,`54`,Summoning]",
  "$desired=listfilter[listmap[dictkeys[$skillIDs],`getcharskill_traininglevel[cnumber[$1]]>1&&$skillIDs{$1}`],`$1`];listmap[listcreate[Strength,Endurance,Coordination,Quickness,Focus,Willpower,Armor,Acid Ward,Bludgeoning Ward,Flame Ward,Frost Ward,Storm Ward,Piercing Ward,Slashing Ward],`listadd[$desired,$1]`]",
  "$spells=listcreate[];listmap[dictvalues[$gear],`listmap[wobjectgetspellids[wobjectfindbyid[$1]],\\`spellname[$1]#Legendary&&listindexof[$desired,spellname[$1]{10:}]>-1&&listadd[$spells,spellname[$1]{10:}]\\`]`]",
  "$spellsMissing=listcopy[$desired];listmap[$spells,`listremove[$spellsMissing,$1]`]",
  "echo[`Missing Legendaries:`,13];listmap[$spellsMissing,`echo[Legendary +$1,13]`]",
];

await check(`corpus: ${CORPUS_EXPRESSIONS.length} real meta expressions parse without error (≥ 30 required)`, () => {
  assert.ok(CORPUS_EXPRESSIONS.length >= 30);
  for (const src of CORPUS_EXPRESSIONS) {
    const p = parse(src);
    assert.equal(p.ok, true, `${src}\n  → ${p.error} @ ${p.pos}`);
  }
});

await check("corpus semantics: BGAugGem addnavpt chat line and the blodetetdict3 setattackbar line", () => {
  const { rt, vars } = makeRt();
  vars.set("session", "TargetNS", 41.5);
  vars.set("session", "TargetWE", -34.25);
  assert.equal(
    ev(rt, CORPUS_EXPRESSIONS.find((s) => s.startsWith("\\/ub delay 1000"))),
    "/ub delay 1000 /vt addnavpt 41.5N, 34.25W",
  );
  ev(rt, "setvar[mobs,dictcreate[]];setvar[mob,Drudge];dictadditem[$mobs,$mob,dictcreate[AP,0.5,Hit,0,Miss,0]]");
  assert.equal(ev(rt, "`/vt setattackbar `+setvar[AP,dictgetitem[dictgetitem[$mobs,$mob],AP]]"), "/vt setattackbar 0.5");
  vars.set("session", "lastAP", 0.5);
  assert.equal(ev(rt, "iif[$lastAP!=setvar[AP,dictgetitem[dictgetitem[$mobs,$mob],AP]],`/vt setattackbar `+$AP,``]"), "");
});

await check("acceptance: no import outside rynth/vt/expr/, no Date.now inside evaluate/stdlib bodies", () => {
  const files = ["lexer.js", "parser.js", "values.js", "evaluator.js", "regex.js", "vars.js", "stdlib_pure.js", "index.js"];
  for (const f of files) {
    const src = readFileSync(path.join(EXPR_DIR, f), "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(m[1].startsWith("./") && !m[1].includes("/../") && !m[1].slice(2).includes("/"), `${f} imports ${m[1]}`);
    }
    assert.equal(/setTimeout|setInterval|requestAnimationFrame/.test(src), false, `${f} uses a timer`);
    assert.equal(/CastSpell\(|WriteToChat\b|castTargetedSpell|castUntargetedSpell/.test(src), false, `${f} names a host action`);
  }
  for (const f of ["evaluator.js", "stdlib_pure.js"]) {
    const src = readFileSync(path.join(EXPR_DIR, f), "utf8");
    const code = src.replace(/\/\/.*$/gm, "");
    const uses = code.split("\n").filter((l) => l.includes("Date.now") && !/now = Date\.now,|\? now : Date\.now;/.test(l));
    assert.deepStrictEqual(uses, [], `${f}: Date.now outside the injected-clock default`);
  }
});

console.log(fail === 0 ? `rynth_vt_expr: all ${pass} checks passed` : `rynth_vt_expr: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
