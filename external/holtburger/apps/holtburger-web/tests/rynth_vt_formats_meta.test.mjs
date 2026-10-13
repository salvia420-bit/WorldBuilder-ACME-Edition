// tests/rynth_vt_formats_meta.test.mjs — rynth/vt/formats meta_schema.js,
// met.js, af.js, view_xml.js (W1-3 FMT, PLAN §3.6, Appendix B, §2.9 X6-X7).
//
//   * the keyword tables (Appendix B numbering; bijection), rule ids,
//     emptyMeta / validateMeta / newCond / newAct;
//   * .met: a synthetic meta covering every CType/AType (ChatCapture 28 {p,c},
//     CallState {st,ret}, an EMPTY EmbedNav kept as navText "", Follow nav),
//     a hand-built VTank-layout file (BOM + CRLF, multi-byte `ba` names, the
//     CreateView XML running straight into the next line), the `_met`
//     format hints (non-canonical leaves stay byte-stable, edits re-encode),
//     unknown CType/AType, disabled rules, errors;
//   * fixture .met files (rynth/testdata/vt/meta, copies of CORPUS): U5 §6.1
//     rule counts and a byte-stable round trip, also after a JSON round trip;
//   * .af: every keyword with its metaf arguments, nesting ≥ 3, DoAll
//     nesting, comments, `~~ @disabled`, metaf `{{ }}` escapes + RynthAi raw
//     braces, tab/space indentation, `Not` both forms, BlockE both forms,
//     NAV sections (nav_file + vnd→5, tlk→7, flw→followTarget, NAVDATA:,
//     empty ⇒ ""), the writer (braced ChatMatch/Expr, state order kept), the
//     three fixture .af files and their equivalence with the .met originals;
//   * view XML: ColRings view ⇒ 3 buttons; <script>/onclick dropped.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_formats_meta.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const FIX = path.join(APP, "rynth", "testdata", "vt", "meta");

const F = await import("../rynth/vt/formats/index.js");
const { parseNav } = await import("../rynth/nav_file.js");
const {
  COND_KW,
  ACT_KW,
  condByMet,
  condByKw,
  actByMet,
  actByKw,
  newRuleId,
  emptyMeta,
  validateMeta,
  newCond,
  newAct,
  sameNode,
  parseMet,
  writeMet,
  parseAf,
  writeAf,
  parseViewXml,
  navTextInfo,
} = F;

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

const enc = new TextEncoder();
const dec = new TextDecoder();
const latin = (b) => Buffer.from(b).toString("latin1");
const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const readFix = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

// A meta with EmbedNav tags replaced by their route content (tags are naming,
// not semantics: .met tags come from display names, .af tags are authored).
function normMeta(meta) {
  const navOf = (tag) => {
    const n = F.findNav(meta.navs, String(tag));
    return n ? { rt: n.routeType, text: n.navText.replace(/\r\n/g, "\n"), ft: n.followTarget || null } : `MISSING:${tag}`;
  };
  const strip = (x) => {
    if (!x || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(strip);
    const o = {};
    for (const [k, v] of Object.entries(x)) if (k[0] !== "_" && k !== "id") o[k] = strip(v);
    if (o.t === "EmbedNav") {
      o.nav = navOf(x.tag);
      delete o.tag;
    }
    return o;
  };
  return meta.rules.map((r) => ({ state: r.state, enabled: r.enabled !== false, cond: strip(r.cond), act: strip(r.act) }));
}
function assertSameMeta(a, b, msg) {
  const A = normMeta(a);
  const B = normMeta(b);
  assert.equal(A.length, B.length, `${msg}: rule count`);
  for (let i = 0; i < A.length; i++) assert.deepEqual(B[i], A[i], `${msg}: rule #${i + 1}`);
}
function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const c of Array.isArray(node.children) ? node.children : []) walk(c, fn);
}
function allNodes(meta, part) {
  const out = [];
  for (const r of meta.rules) walk(r[part], (n) => out.push(n));
  return out;
}

// ── schema ─────────────────────────────────────────────────────────────────
console.log("meta_schema");

await check("Appendix B condition numbering (0-26, 28; 27 unused)", () => {
  const want = ["Never", "Always", "All", "Any", "ChatMatch", "MainSlotsLE", "SecsInStateGE", "NavEmpty", "Death", "VendorOpen", "VendorClosed", "ItemCountLE", "ItemCountGE", "MobsInDist_Name", "MobsInDist_Priority", "NeedToBuff", "NoMobsInDist", "BlockE", "CellE", "IntoPortal", "ExitPortal", "Not", "PSecsInStateGE", "SecsOnSpellGE", "BuPercentGE", "DistToRteGE", "Expr"];
  want.forEach((kw, n) => assert.equal(condByMet(n).kw, kw, `CType ${n}`));
  assert.equal(condByMet(27), null, "27 is unused (RynthAi B1)");
  assert.equal(condByMet(28).kw, "ChatCapture");
  assert.equal(COND_KW.length, 28);
  assert.equal(condByKw("ChatCapture").label, "Chat Message Capture");
  assert.equal(condByKw("mobsindist_name").kw, "MobsInDist_Name", "case-insensitive lookup");
});

await check("Appendix B action numbering (0-15)", () => {
  const want = ["None", "SetState", "Chat", "DoAll", "EmbedNav", "CallState", "Return", "DoExpr", "ChatExpr", "SetWatchdog", "ClearWatchdog", "GetOpt", "SetOpt", "CreateView", "DestroyView", "DestroyAllViews"];
  want.forEach((kw, n) => assert.equal(actByMet(n).kw, kw, `AType ${n}`));
  assert.equal(ACT_KW.length, 16);
  assert.equal(actByMet(16), null);
  assert.equal(actByKw("SetWatchdog").label, "Set Watchdog");
});

await check("keyword <-> number maps are bijections", () => {
  for (const r of COND_KW) assert.equal(condByMet(condByKw(r.kw).met), r);
  for (const r of ACT_KW) assert.equal(actByMet(actByKw(r.kw).met), r);
  assert.equal(new Set(COND_KW.map((r) => r.met)).size, COND_KW.length);
  assert.equal(new Set(ACT_KW.map((r) => r.met)).size, ACT_KW.length);
});

await check("newRuleId: r1.., highest + 1, never reuses a deleted id", () => {
  assert.equal(newRuleId(new Set()), "r1");
  assert.equal(newRuleId(new Set(["r1", "r2"])), "r3");
  assert.equal(newRuleId(["r1", "r5"]), "r6", "r2-r4 are not reused");
  assert.equal(newRuleId([{ id: "r9" }, { id: "x" }]), "r10");
  assert.equal(newRuleId(undefined), "r1");
});

await check("emptyMeta / newCond / newAct / validateMeta", () => {
  const m = emptyMeta("Test");
  assert.deepEqual(m, { v: 1, name: "Test", source: { kind: "json" }, rules: [], navs: {}, warnings: [] });
  assert.equal(validateMeta(m).ok, true);
  assert.deepEqual(newCond("MobsInDist_Name"), { t: "MobsInDist_Name", re: "", count: 0, dist: 0 });
  assert.deepEqual(newAct("DoAll"), { t: "DoAll", children: [] });
  assert.equal(newCond("Bogus"), null);
  m.rules.push({ id: "r1", state: "Default", enabled: true, cond: newCond("Always"), act: { t: "SetState", state: "Hunt" } });
  assert.equal(validateMeta(m).ok, true);
  const bad = {
    v: 1,
    name: "b",
    source: { kind: "json" },
    navs: {},
    rules: [
      { id: "r1", state: "", cond: { t: "Not", children: [] }, act: { t: "EmbedNav", tag: "nope", displayName: "" } },
      { id: "r1", state: "S", cond: { t: "ItemCountGE", name: 3, count: "x" }, act: { t: "Frob" } },
    ],
  };
  const v = validateMeta(bad);
  assert.equal(v.ok, false);
  const txt = v.errors.join("\n");
  for (const want of ["state must be a non-empty string", "Not needs exactly one child", "cites route \"nope\"", "duplicate id r1", "ItemCountGE.name must be a string", "ItemCountGE.count must be an integer", 'unknown action keyword "Frob"']) {
    assert.ok(txt.includes(want), `missing error: ${want}\n${txt}`);
  }
});

// ── .met synthetic: every CType / AType ────────────────────────────────────
console.log(".met");

const ALL_CONDS = [
  { t: "Never" },
  { t: "Always" },
  { t: "All", children: [{ t: "Always" }, { t: "Any", children: [{ t: "Expr", expr: "1" }, { t: "Not", children: [{ t: "All", children: [{ t: "Death" }] }] }] }] },
  { t: "Any", children: [] },
  { t: "ChatMatch", re: '^You say, "(?<x>.+)"$' },
  { t: "MainSlotsLE", n: 5 },
  { t: "SecsInStateGE", secs: 30 },
  { t: "NavEmpty" },
  { t: "Death" },
  { t: "VendorOpen" },
  { t: "VendorClosed" },
  { t: "ItemCountLE", name: "Mana Scarab", count: 3 },
  { t: "ItemCountGE", name: "Pyreal Sliver", count: 2 },
  { t: "MobsInDist_Name", re: "Drudge.*", count: 2, dist: 12.5 },
  { t: "MobsInDist_Priority", count: 3, dist: 20, priority: 2 },
  { t: "NeedToBuff" },
  { t: "NoMobsInDist", dist: 5 },
  { t: "BlockE", value: 0x8a020000 },
  { t: "CellE", value: 0x00560261 },
  { t: "IntoPortal" },
  { t: "ExitPortal" },
  { t: "Not", children: [{ t: "Death" }] },
  { t: "PSecsInStateGE", secs: 600 },
  { t: "SecsOnSpellGE", spellId: 2645, secs: 300 },
  { t: "BuPercentGE", pct: 110 },
  { t: "DistToRteGE", dist: 7.25 },
  { t: "Expr", expr: "getvar[a]==1&&testvar[b]" },
  { t: "ChatCapture", re: '^(?<who>.+) tells you, "xp"$', colors: "3;4" },
];
const FULL_NAV = "uTank2 NAV 1.2\r\n2\r\n2\r\n0\r\n10.5\r\n-20.25\r\n0.1\r\n0\r\n4\r\n10.5\r\n-20.25\r\n0.1\r\n0\r\n/vt echo hi\r\n";
const FOLLOW_NAV = "uTank2 NAV 1.2\r\n3\r\nLeader Guy\r\n1342177281\r\n";
const ALL_ACTS = [
  { t: "None" },
  { t: "SetState", state: "Hunt" },
  { t: "Chat", text: "/vt nav load hunt" },
  { t: "DoAll", children: [{ t: "DoExpr", expr: "setvar[a,1]" }, { t: "DoAll", children: [{ t: "ChatExpr", expr: "`/t me, `+$a" }, { t: "EmbedNav", tag: "full", displayName: "Ñavé ☃ route.nav" }] }] },
  { t: "EmbedNav", tag: "empty", displayName: "[None]" },
  { t: "CallState", state: "Sub", ret: "Back" },
  { t: "Return" },
  { t: "DoExpr", expr: "clearallvars[]" },
  { t: "ChatExpr", expr: "`hi`" },
  { t: "SetWatchdog", state: "Stuck", dist: 5, secs: 60 },
  { t: "ClearWatchdog" },
  { t: "GetOpt", opt: "EnableCombat", var: "ec" },
  { t: "SetOpt", opt: "EnableNav", expr: "false" },
  { t: "CreateView", view: "Panel", xml: '<view title="Ünïcode"><control type="button" name="b" text="Go" setstate="X"/></view>' },
  { t: "DestroyView", view: "Panel" },
  { t: "DestroyAllViews" },
  { t: "EmbedNav", tag: "follow", displayName: "[follow]" },
];
function synthMeta() {
  const n = Math.max(ALL_CONDS.length, ALL_ACTS.length);
  const rules = [];
  for (let i = 0; i < n; i++) {
    rules.push({ id: `r${i + 1}`, state: i % 3 === 0 ? "Default" : i % 3 === 1 ? "Zeta" : "Alpha", enabled: true, cond: structuredClone(ALL_CONDS[i % ALL_CONDS.length]), act: structuredClone(ALL_ACTS[i % ALL_ACTS.length]) });
  }
  return {
    v: 1,
    name: "synth",
    source: { kind: "json" },
    rules,
    navs: {
      full: { displayName: "Ñavé ☃ route.nav", routeType: 2, navText: FULL_NAV },
      empty: { displayName: "[None]", routeType: 1, navText: "" },
      follow: { displayName: "[follow]", routeType: 3, navText: FOLLOW_NAV, followTarget: { name: "Leader Guy", guid: 1342177281 } },
    },
    warnings: [],
  };
}

await check("synthetic meta with every CType/AType: write → parse → same model; second write byte-identical", () => {
  const m = synthMeta();
  assert.equal(validateMeta(m).ok, true, validateMeta(m).errors.join("; "));
  const bytes = writeMet(m);
  const r = parseMet(bytes, { fileName: "synth.met" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  assertSameMeta(m, r.meta, "met round trip");
  assert.equal(r.meta.name, "synth");
  assert.deepEqual(r.meta.source, { kind: "met", fileName: "synth.met" });
  assert.deepEqual(r.meta.rules.map((x) => x.id), m.rules.map((_, i) => `r${i + 1}`));
  assert.ok(bytesEq(writeMet(r.meta), bytes), "byte-stable");
  // every type number appears
  const cts = new Set(allNodes(r.meta, "cond").map((c) => condByKw(c.t).met));
  const ats = new Set(allNodes(r.meta, "act").map((a) => actByKw(a.t).met));
  for (const row of COND_KW) assert.ok(cts.has(row.met), `CType ${row.met}`);
  for (const row of ACT_KW) assert.ok(ats.has(row.met), `AType ${row.met}`);
});

await check("canonical VTank encodings: ChatCapture 28 {p,c}, CallState {st,ret}, empty EmbedNav, ClearWatchdog {}", () => {
  const txt = latin(writeMet(synthMeta()));
  assert.ok(txt.includes("i\r\n28\r\n"), "CType 28");
  assert.ok(!/\r\ni\r\n27\r\n/.test(txt), "never CType 27");
  assert.ok(txt.includes('TABLE\r\n2\r\nk\r\nv\r\nn\r\nn\r\n2\r\ns\r\np\r\ns\r\n^(?<who>.+) tells you, "xp"$\r\ns\r\nc\r\ns\r\n3;4\r\n'), "ChatCapture {p,c}");
  assert.ok(txt.includes("TABLE\r\n2\r\nk\r\nv\r\nn\r\nn\r\n2\r\ns\r\nst\r\ns\r\nSub\r\ns\r\nret\r\ns\r\nBack\r\n"), "CallState {st,ret}");
  assert.ok(txt.includes("ba\r\n33\r\n[None]\r\n0\r\nuTank2 NAV 1.2\r\n1\r\n0\r\n"), "empty EmbedNav = the [None] route VTank embeds");
  const cw = parseMet(writeMet(synthMeta())).meta.rules.find((x) => x.act.t === "ClearWatchdog");
  assert.ok(cw && !cw.act._met, "ClearWatchdog re-reads canonically");
  assert.ok(txt.includes("TABLE\r\n2\r\nk\r\nv\r\nn\r\nn\r\n0\r\n"), "ClearWatchdog / DestroyAllViews = empty TABLE (metaf)");
  assert.ok(txt.includes("s\r\nr\r\nd\r\n12.5\r\n"), "MobsInDist_Name r:d");
  assert.ok(txt.includes("i\r\n-1979580416\r\n"), "BlockE as signed Int32");
  assert.ok(txt.includes("s\r\ndist\r\nd\r\n7.25\r\n"), "DistToRteGE {dist:d} (metaf)");
  assert.ok(txt.includes("s\r\nsid\r\ni\r\n2645\r\ns\r\nsec\r\ni\r\n300\r\n"), "SecsOnSpellGE {sid,sec}");
  assert.ok(txt.includes("ba\r\n" + enc.encode("[follow]\r\n1\r\n" + FOLLOW_NAV).length + "\r\n[follow]\r\n1\r\nuTank2 NAV 1.2\r\n3\r\n"), "Follow route, count line 1");
});

await check("empty EmbedNav stays an empty route (navText \"\"), not pruned (RynthAi B3)", () => {
  const r = parseMet(writeMet(synthMeta()));
  const acts = allNodes(r.meta, "act").filter((a) => a.t === "EmbedNav" && a.displayName === "[None]");
  assert.ok(acts.length >= 1);
  for (const a of acts) {
    const nav = F.findNav(r.meta.navs, a.tag);
    assert.ok(nav, `nav ${a.tag}`);
    assert.equal(nav.navText, "");
    assert.equal(nav.routeType, 1);
    assert.equal(nav.displayName, "[None]");
  }
  const fol = allNodes(r.meta, "act").find((a) => a.t === "EmbedNav" && a.displayName === "[follow]");
  const fn = F.findNav(r.meta.navs, fol.tag);
  assert.equal(fn.routeType, 3);
  assert.deepEqual(fn.followTarget, { name: "Leader Guy", guid: 1342177281 });
  assert.equal(fn.navText, FOLLOW_NAV);
});

// A hand-built file in the exact VTank layout (independent of writeMet).
function metFile(parts, { bom = false } = {}) {
  const s = parts.map((p) => (typeof p === "string" ? `${p}\r\n` : p.raw)).join("");
  const b = enc.encode(s);
  return bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...b]) : b;
}
const ba = (text) => ["ba", String(enc.encode(text).length), { raw: text }];
const KV = (n) => ["TABLE", "2", "k", "v", "n", "n", String(n)];
const HAND_NAV = "Ünïcödé ☃\r\n1\r\nuTank2 NAV 1.2\r\n1\r\n1\r\n0\r\n1.5\r\n2.5\r\n0.01\r\n0\r\n";
const HAND_XML = '<?xml version="1.0"?><view width="80" height="40" title="Ö"><control type="layout"><control type="button" name="Go" left="5" top="5" width="70" height="30" text="Gö" setstate="TurnIn" actionexpr="" /></control></view>';
const HAND = [
  "1", "CondAct", "5", "CType", "AType", "CData", "AData", "State", "n", "n", "n", "n", "n", "4",
  // row 1: ChatCapture (28) → CallState (5)
  "i", "28", "i", "5", ...KV(2), "s", "p", "s", "^(?<name>.+) died\\.$", "s", "c", "s", "", ...KV(2), "s", "st", "s", "_pause", "s", "ret", "s", "combine", "s", "Default",
  // row 2: All[ Not[ NavEmpty ] ] → EmbedNav (multi-byte display name, 1-point route)
  "i", "2", "i", "4", "TABLE", "2", "K", "V", "n", "n", "1", "i", "21", "TABLE", "2", "K", "V", "n", "n", "1", "i", "7", "i", "0", ...ba(HAND_NAV), "s", "Ünïcödé state",
  // row 3: Always → CreateView whose XML runs straight into the next line (VTank)
  "i", "1", "i", "13", "i", "0", ...KV(2), "s", "n", "s", "Select", "s", "x", ...ba(HAND_XML), "s", "Default",
  // row 4: ItemCountGE → empty EmbedNav
  "i", "12", "i", "4", ...KV(2), "s", "n", "s", "Pyreal Sliver", "s", "c", "i", "2", ...ba("[None]\r\n0\r\nuTank2 NAV 1.2\r\n1\r\n0\r\n"), "s", "Default",
];

await check("hand-built VTank .met: BOM + CRLF, ChatCapture 28, CallState {st,ret}, multi-byte ba, CreateView XML into the next line", () => {
  const bytes = metFile(HAND, { bom: true });
  const r = parseMet(bytes, { fileName: "hand.met" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  const m = r.meta;
  assert.equal(m.source.bom, true);
  assert.equal(m.rules.length, 4);
  assert.deepEqual(m.rules[0].cond, { t: "ChatCapture", re: "^(?<name>.+) died\\.$", colors: "" });
  assert.deepEqual(m.rules[0].act, { t: "CallState", state: "_pause", ret: "combine" });
  assert.deepEqual(m.rules[1].cond, { t: "All", children: [{ t: "Not", children: [{ t: "NavEmpty" }] }] });
  assert.equal(m.rules[1].state, "Ünïcödé state");
  const a1 = m.rules[1].act;
  assert.equal(a1.t, "EmbedNav");
  assert.equal(a1.displayName, "Ünïcödé ☃");
  const nav = m.navs[a1.tag];
  assert.equal(nav.routeType, 1);
  assert.equal(nav.navText, "uTank2 NAV 1.2\r\n1\r\n1\r\n0\r\n1.5\r\n2.5\r\n0.01\r\n0\r\n");
  assert.equal(parseNav(nav.navText).points.length, 1);
  assert.equal(m.rules[2].act.t, "CreateView");
  assert.equal(m.rules[2].act.view, "Select");
  assert.equal(m.rules[2].act.xml, HAND_XML);
  assert.equal(m.rules[2].state, "Default", "the State after the XML is read from the same line");
  assert.deepEqual(m.rules[3].cond, { t: "ItemCountGE", name: "Pyreal Sliver", count: 2 });
  assert.equal(m.navs[m.rules[3].act.tag].navText, "");
  assert.ok(bytesEq(writeMet(m), bytes), "byte-stable incl. BOM");
  assert.ok(bytesEq(writeMet(JSON.parse(JSON.stringify(m))), bytes), "byte-stable after a JSON round trip");
  // the generic tag rule: Route<n> for [None], cleaned+literal otherwise
  assert.equal(m.rules[3].act.tag, "Route0");
  assert.ok(F.isNavTag(a1.tag), a1.tag);
});

await check("_met hints: non-canonical leaves stay byte-stable; an edited node is re-encoded canonically", () => {
  // NoMobsInDist r written as "5.0", SetState with a trailing CR, keys in another order.
  const parts = [
    "1", "CondAct", "5", "CType", "AType", "CData", "AData", "State", "n", "n", "n", "n", "n", "2",
    "i", "16", "i", "1", ...KV(1), "s", "r", "d", "5.0", "s", "Hunt\r", "s", "Default",
    "i", "12", "i", "9", ...KV(2), "s", "c", "i", "7", "s", "n", "s", "Mana Scarab", ...KV(3), "s", "t", "d", "60", "s", "s", "s", "Stuck", "s", "r", "d", "5", "s", "Default",
  ];
  const bytes = metFile(parts);
  const r = parseMet(bytes);
  assert.equal(r.ok, true, r.error);
  const [r1, r2] = r.meta.rules;
  assert.deepEqual({ ...r1.cond, _met: undefined }, { t: "NoMobsInDist", dist: 5, _met: undefined });
  assert.ok(r1.cond._met, "non-canonical double keeps its bytes");
  assert.equal(r1.act.state, "Hunt\r");
  assert.ok(r2.cond._met && r2.act._met, "key order differs from VTank's");
  assert.deepEqual({ t: r2.act.t, state: r2.act.state, dist: r2.act.dist, secs: r2.act.secs }, { t: "SetWatchdog", state: "Stuck", dist: 5, secs: 60 });
  assert.ok(bytesEq(writeMet(r.meta), bytes), "byte-stable with hints");
  // edit: the hint no longer matches ⇒ canonical encoding of the NEW value
  r1.cond.dist = 7;
  r2.cond.count = 9;
  const txt = latin(writeMet(r.meta));
  assert.ok(txt.includes("s\r\nr\r\nd\r\n7\r\n") && !txt.includes("5.0"), "dist re-encoded");
  assert.ok(txt.includes("s\r\nn\r\ns\r\nMana Scarab\r\ns\r\nc\r\ni\r\n9\r\n"), "ItemCount re-encoded in VTank key order");
  assert.ok(txt.includes("s\r\nStuck\r\ns\r\nr\r\nd\r\n5\r\ns\r\nt\r\nd\r\n60\r\n") === false, "untouched watchdog keeps its original order");
  const back = parseMet(writeMet(r.meta)).meta;
  assert.equal(back.rules[0].cond.dist, 7);
  assert.equal(back.rules[1].cond.count, 9);
});

await check("unknown CType/AType ⇒ Never/None + warning, original bytes kept", () => {
  const parts = ["1", "CondAct", "5", "CType", "AType", "CData", "AData", "State", "n", "n", "n", "n", "n", "1", "i", "27", "i", "99", "s", "whatever", ...KV(1), "s", "q", "i", "3", "s", "Default"];
  const bytes = metFile(parts);
  const r = parseMet(bytes);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.rules[0].cond.t, "Never");
  assert.equal(r.meta.rules[0].cond.unknownKeyword, "CType 27");
  assert.equal(r.meta.rules[0].act.t, "None");
  assert.equal(r.meta.rules[0].act.unknownKeyword, "AType 99");
  assert.equal(r.warnings.length, 2);
  assert.ok(bytesEq(writeMet(r.meta), bytes));
  assert.equal(validateMeta(r.meta).ok, true);
});

await check("disabled rules are omitted from .met (VTank has no enabled flag)", () => {
  const m = synthMeta();
  m.rules[1].enabled = false;
  const r = parseMet(writeMet(m));
  assert.equal(r.meta.rules.length, m.rules.length - 1);
  assert.ok(r.meta.rules.every((x) => x.enabled === true));
});

await check("bad input ⇒ { ok:false, error } (never throws)", () => {
  for (const bad of [new Uint8Array(0), enc.encode("hello\r\nworld\r\n"), metFile(HAND).subarray(0, 300), metFile(["1", "CondAct", "5", "a", "b", "c", "d", "e", "n", "n", "n", "n", "n", "1", "x", "1"]), "not bytes", null]) {
    const r = parseMet(bad);
    assert.equal(r.ok, false, `accepted ${String(bad).slice(0, 30)}`);
    assert.equal(typeof r.error, "string");
  }
  const lf = parseMet(enc.encode("1\nCondAct\n5\nCType\nAType\nCData\nAData\nState\nn\nn\nn\nn\nn\n1\ni\n1\ni\n0\ni\n0\ni\n0\ns\nDefault\n"));
  assert.equal(lf.ok, true, lf.error);
  assert.equal(lf.meta.source.eol, "\n");
  assert.equal(dec.decode(writeMet(lf.meta)), "1\nCondAct\n5\nCType\nAType\nCData\nAData\nState\nn\nn\nn\nn\nn\n1\ni\n1\ni\n0\ni\n0\ni\n0\ns\nDefault\n", "bare-LF file stays LF");
});

// ── fixture .met files (CORPUS copies) ─────────────────────────────────────
const MET_FIXTURES = [
  ["BGAugGem-e4623d0c5858aa80.met", 65],
  ["ColRings-c3986fd7f878c745.met", 7],
  ["FellowSpells-736855f15e2d10f1.met", 25],
  ["motefarm-664a57bdd9ba3df4.met", 10],
];
const loadedMet = {};
await check("fixture metas load with the U5 §6.1 rule counts, no warnings, and validate", () => {
  for (const [file, n] of MET_FIXTURES) {
    const r = parseMet(readFix(file), { fileName: file });
    assert.equal(r.ok, true, `${file}: ${r.error}`);
    assert.equal(r.meta.rules.length, n, file);
    assert.deepEqual(r.warnings, [], file);
    assert.equal(validateMeta(r.meta).ok, true, `${file}: ${validateMeta(r.meta).errors.join("; ")}`);
    loadedMet[file] = r.meta;
  }
});

await check("every fixture .met round-trips byte-for-byte (also after JSON persistence)", () => {
  for (const [file] of MET_FIXTURES) {
    const b = readFix(file);
    const m = parseMet(b).meta;
    assert.ok(bytesEq(writeMet(m), b), `${file} byte-stable`);
    assert.ok(bytesEq(writeMet(JSON.parse(JSON.stringify(m))), b), `${file} byte-stable after JSON`);
  }
});

await check("fixture facts: BGAugGem empty EmbedNavs + ChatCapture 28, motefarm CallState {_pause, combine}, ColRings view", () => {
  const bg = loadedMet["BGAugGem-e4623d0c5858aa80.met"];
  const emb = allNodes(bg, "act").filter((a) => a.t === "EmbedNav");
  const empties = emb.filter((a) => bg.navs[a.tag].navText === "");
  assert.ok(empties.length >= 4, `empty EmbedNavs kept (${empties.length})`);
  assert.ok(emb.some((a) => a.displayName === "125 all jaws.nav" && parseNav(bg.navs[a.tag].navText).points.length === 95));
  const cap = allNodes(bg, "cond").filter((c) => c.t === "ChatCapture");
  assert.deepEqual(cap.map((c) => c.colors), ["2", "3"], "ChatCapture {p,c} with its colour ids");
  assert.ok(cap.every((c) => typeof c.re === "string" && c.re.includes("(?<name>")), "ChatCapture regex");
  const mf = loadedMet["motefarm-664a57bdd9ba3df4.met"];
  assert.ok(allNodes(mf, "act").some((a) => a.t === "CallState" && a.state === "_pause" && a.ret === "combine"), "CallState {st=_pause, ret=combine}");
  assert.equal(mf.rules[0].state, "_pause", "file order kept (VTank sorts by state; META starts in Default)");
  const cr = loadedMet["ColRings-c3986fd7f878c745.met"];
  const cv = allNodes(cr, "act").find((a) => a.t === "CreateView");
  assert.equal(cv.view, "Select");
  const v = parseViewXml(cv.xml);
  assert.equal(v.ok, true, v.error);
  assert.equal(v.model.controls.filter((c) => c.type === "button").length, 3);
  assert.ok(allNodes(cr, "act").some((a) => a.t === "DestroyAllViews"));
});

// ── .af ────────────────────────────────────────────────────────────────────
console.log(".af");

const AF_ALL = [
  "~~ synthetic metaf file: every keyword",
  "STATE: {Zeta} ~~ {",
  "\tIF:\tAlways",
  "\t\tDO:\tDoAll",
  "\t\t\t\tChatExpr {`hello`}",
  "\t\t\t\tDoAll",
  "\t\t\t\t\tSetState {Alpha}",
  "\t\t\t\t\tDoAll",
  "\t\t\t\t\t\tDoExpr {setvar[deep,1]}",
  "\t\t\t\tEmbedNav nav0 {[None]}",
  "~~ }",
  "STATE: {Alpha} ~~ {",
  "\t~~ @disabled",
  '\tIF:\tChatMatch {^You say, "a{{2}}b"$} ~~ trailing comment',
  "\t\tDO:\tChat {/vt opt set enablenav false}",
  "\tIF:\tAll",
  "\t\t\tAny",
  "\t\t\t\tNot All",
  "\t\t\t\t\tExpr {getvar[x]==1}",
  "\t\t\t\t\tNavEmpty",
  "\t\t\t\tDeath",
  "\t\t\tMainSlotsLE 4",
  "\t\tDO:\tCallState {Sub} {Alpha}",
  "\tIF:\tNever",
  "\t\tDO:\tNone",
  "\tIF:\tSecsInStateGE 30",
  "\t\tDO:\tReturn",
  "\tIF:\tVendorOpen",
  "\t\tDO:\tSetWatchdog 5.5 60 {Stuck}",
  "\tIF:\tVendorClosed",
  "\t\tDO:\tClearWatchdog",
  "\tIF:\tItemCountLE 3 {Mana Scarab}",
  "\t\tDO:\tGetOpt {EnableCombat} {ec}",
  "\tIF:\tItemCountGE 2 {Pyreal Sliver}",
  "\t\tDO:\tSetOpt {EnableNav} {false}",
  "\tIF:\tMobsInDist_Name 2 12.5 {Drudge.*}",
  '\t\tDO:\tCreateView {Panel} {<view title="x"><control type="button" name="b" text="Go" setstate="X"/></view>}',
  "\tIF:\tMobsInDist_Priority 3 20 2",
  "\t\tDO:\tDestroyView {Panel}",
  "\tIF:\tNeedToBuff",
  "\t\tDO:\tDestroyAllViews",
  "\tIF:\tNoMobsInDist 5",
  "\t\tDO:\tEmbedNav navAll {All Types}",
  "\tIF:\tBlockE 8A020000",
  "\t\tDO:\tEmbedNav navF {[follow]}",
  "\tIF:\tBlockE 8A02",
  "\t\tDO:\tEmbedNav rnav {rynth navdata}",
  "\tIF:\tCellE 00560261",
  "\t\tDO:\tDoExpr {a~~b}",
  "\tIF:\tIntoPortal",
  "\t\tDO:\tNone",
  "\tIF:\tExitPortal",
  "\t\tDO:\tNone",
  "\tIF:\tNot Expr {$init}",
  "\t\tDO:\tNone",
  "\tIF:\tPSecsInStateGE 600",
  "\t\tDO:\tNone",
  "\tIF:\tSecsOnSpellGE 300 2645",
  "\t\tDO:\tNone",
  "\tIF:\tBuPercentGE 110",
  "\t\tDO:\tNone",
  "\tIF:\tDistToRteGE 7.25",
  "\t\tDO:\tNone",
  "\tIF:\tExpr {getcharintprop[25]>=275}",
  "\t\tDO:\tNone",
  "\tIF:\tChatCapture {^(?<who>.+) tells you, \"xp\"$} {3;4}",
  "\t\tDO:\tNone",
  "~~ }",
  "",
  "NAV: nav0 circular ~~ {",
  "~~ }",
  "NAV: navAll linear ~~ {",
  "\tpnt 1.5 -2.25 2.08333134651184E-05",
  "\trcl 1 2 3 {Lifestone Recall}",
  "\tpau 1 2 3 5000",
  "\tcht 1 2 3 {/vt echo {{braced}}}",
  "\tvnd 1 2 3 7A0B1234 {Vendor Bob}",
  "\tptl 1 2 3 4 5 6 14 {Portal to Town}",
  "\ttlk 1 2 3 7 8 9 37 {Town Crier}",
  "\tchk 1 2 3",
  "\tjmp 1 2 3 90 {True} 200",
  "\tprt 1 2 3 7A0B0001",
  "~~ }",
  "NAV: navF follow ~~ {",
  "\tflw 50000001 {Leader Guy}",
  "~~ }",
  "NAVDATA: rnav 8 ~~ {",
  "uTank2 NAV 1.2",
  "4",
  "1",
  "0",
  "10.5",
  "20.5",
  "0.1",
  "0",
  "~~ }",
].join("\r\n");

let afAll = null;
await check("every keyword with its metaf arguments", () => {
  const r = parseAf(AF_ALL, { fileName: "all.af" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  afAll = r.meta;
  assert.equal(afAll.name, "all");
  assert.deepEqual(afAll.source, { kind: "af", fileName: "all.af" });
  const conds = afAll.rules.map((x) => x.cond);
  const acts = afAll.rules.map((x) => x.act);
  const byT = (arr, t) => arr.filter((n) => n.t === t);
  assert.deepEqual(byT(conds, "ChatMatch")[0], { t: "ChatMatch", re: '^You say, "a{2}b"$' }, "metaf {{ }} escapes");
  assert.deepEqual(byT(conds, "ItemCountLE")[0], { t: "ItemCountLE", name: "Mana Scarab", count: 3 });
  assert.deepEqual(byT(conds, "ItemCountGE")[0], { t: "ItemCountGE", name: "Pyreal Sliver", count: 2 });
  assert.deepEqual(byT(conds, "MobsInDist_Name")[0], { t: "MobsInDist_Name", re: "Drudge.*", count: 2, dist: 12.5 });
  assert.deepEqual(byT(conds, "MobsInDist_Priority")[0], { t: "MobsInDist_Priority", count: 3, dist: 20, priority: 2 });
  assert.deepEqual(byT(conds, "NoMobsInDist")[0], { t: "NoMobsInDist", dist: 5 });
  assert.deepEqual(byT(conds, "BlockE"), [{ t: "BlockE", value: 0x8a020000 }, { t: "BlockE", value: 0x8a020000 }], "XXXX0000 and XXXX");
  assert.deepEqual(byT(conds, "CellE")[0], { t: "CellE", value: 0x00560261 });
  assert.deepEqual(byT(conds, "SecsOnSpellGE")[0], { t: "SecsOnSpellGE", spellId: 2645, secs: 300 }, "metaf order: secs then spellId");
  assert.deepEqual(byT(conds, "PSecsInStateGE")[0], { t: "PSecsInStateGE", secs: 600 });
  assert.deepEqual(byT(conds, "BuPercentGE")[0], { t: "BuPercentGE", pct: 110 });
  assert.deepEqual(byT(conds, "DistToRteGE")[0], { t: "DistToRteGE", dist: 7.25 });
  assert.deepEqual(byT(conds, "ChatCapture")[0], { t: "ChatCapture", re: '^(?<who>.+) tells you, "xp"$', colors: "3;4" });
  assert.deepEqual(byT(conds, "Not")[0], { t: "Not", children: [{ t: "Expr", expr: "$init" }] }, "Not on one line");
  assert.deepEqual(byT(acts, "SetWatchdog")[0], { t: "SetWatchdog", state: "Stuck", dist: 5.5, secs: 60 });
  assert.deepEqual(byT(acts, "GetOpt")[0], { t: "GetOpt", opt: "EnableCombat", var: "ec" });
  assert.deepEqual(byT(acts, "SetOpt")[0], { t: "SetOpt", opt: "EnableNav", expr: "false" });
  assert.deepEqual(byT(acts, "CallState")[0], { t: "CallState", state: "Sub", ret: "Alpha" });
  assert.deepEqual(byT(acts, "DestroyView")[0], { t: "DestroyView", view: "Panel" });
  assert.equal(byT(acts, "CreateView")[0].xml, '<view title="x"><control type="button" name="b" text="Go" setstate="X"/></view>');
  assert.equal(byT(acts, "DoExpr").find((a) => a.expr.includes("~~")).expr, "a~~b", "~~ inside a {string} is not a comment");
  for (const t of ["Never", "SecsInStateGE", "VendorOpen", "VendorClosed", "NeedToBuff", "IntoPortal", "ExitPortal", "Expr", "Always", "All"]) assert.ok(byT(conds, t).length, t);
  for (const t of ["None", "Return", "ClearWatchdog", "DestroyAllViews", "Chat", "DoAll", "EmbedNav"]) assert.ok(byT(acts, t).length, t);
  assert.equal(validateMeta(afAll).ok, true, validateMeta(afAll).errors.join("; "));
});

await check("nesting ≥ 3 (All > Any > Not All > …), DoAll nesting, state order, @disabled", () => {
  const states = [...new Set(afAll.rules.map((x) => x.state))];
  assert.deepEqual(states, ["Zeta", "Alpha"], "authored order, not alphabetical");
  assert.equal(afAll.rules[0].enabled, true);
  assert.equal(afAll.rules[1].enabled, false, "~~ @disabled");
  assert.equal(afAll.rules[2].enabled, true, "the marker applies to one rule");
  assert.deepEqual(afAll.rules[2].cond, {
    t: "All",
    children: [
      { t: "Any", children: [{ t: "Not", children: [{ t: "All", children: [{ t: "Expr", expr: "getvar[x]==1" }, { t: "NavEmpty" }] }] }, { t: "Death" }] },
      { t: "MainSlotsLE", n: 4 },
    ],
  });
  assert.deepEqual(afAll.rules[0].act, {
    t: "DoAll",
    children: [
      { t: "ChatExpr", expr: "`hello`" },
      { t: "DoAll", children: [{ t: "SetState", state: "Alpha" }, { t: "DoAll", children: [{ t: "DoExpr", expr: "setvar[deep,1]" }] }] },
      { t: "EmbedNav", tag: "nav0", displayName: "[None]" },
    ],
  });
  assert.deepEqual(afAll.rules.map((x) => x.id).slice(0, 3), ["r1", "r2", "r3"]);
});

await check("NAV sections: nav_file points + vnd→5, tlk→7, flw→followTarget, NAVDATA, empty ⇒ \"\"", () => {
  const n = afAll.navs;
  assert.deepEqual(n.nav0, { displayName: "[None]", routeType: 1, navText: "" });
  const all = n.navAll;
  assert.equal(all.displayName, "All Types");
  assert.equal(all.routeType, 2);
  const p = parseNav(all.navText);
  assert.equal(p.warning, null);
  assert.deepEqual(p.points.map((x) => x.type), [0, 2, 3, 4, 5, 6, 7, 8, 9, 1]);
  assert.equal(p.points[0].raw[3], "2.08333134651184E-05", "number text kept as written");
  assert.equal(p.points[1].spellId, 1635, "rcl name → id through nav_file");
  assert.equal(p.points[2].pauseMs, 5000);
  assert.equal(p.points[3].chat, "/vt echo {braced}");
  assert.deepEqual([p.points[4].vendorId, p.points[4].name], [0x7a0b1234, "Vendor Bob"], "vnd: type 5 + hex guid");
  assert.deepEqual([p.points[5].name, p.points[5].objectClass, p.points[5].exitEW, p.points[5].exitNS, p.points[5].exitZ, p.points[5].isTie], ["Portal to Town", 14, 4, 5, 6, true]);
  assert.deepEqual([p.points[6].name, p.points[6].objectClass, p.points[6].exitEW, p.points[6].exitNS, p.points[6].exitZ], ["Town Crier", 37, 7, 8, 9], "tlk: type 7 + metaf object layout");
  assert.deepEqual([p.points[8].headingDeg, p.points[8].holdShift, p.points[8].delayMs], [90, true, 200]);
  assert.equal(p.points[9].guid, 0x7a0b0001, "prt: hex guid");
  assert.equal(n.navF.routeType, 3);
  assert.deepEqual(n.navF.followTarget, { guid: 0x50000001, name: "Leader Guy" });
  assert.equal(n.navF.navText, "uTank2 NAV 1.2\r\n3\r\nLeader Guy\r\n1342177281\r\n");
  assert.equal(n.rnav.routeType, 4);
  assert.equal(n.rnav.navText, "uTank2 NAV 1.2\r\n4\r\n1\r\n0\r\n10.5\r\n20.5\r\n0.1\r\n0\r\n");
  assert.equal(n.rnav.displayName, "rynth navdata");
});

await check("writer: braced string args (ChatMatch/Expr …), escapes, @disabled, state order; parse(write(m)) ≡ m", () => {
  const txt = writeAf(afAll);
  assert.ok(txt.includes('\tIF:\tChatMatch {^You say, "a{{2}}b"$}'), "ChatMatch braced + escaped");
  assert.ok(txt.includes("\tIF:\tExpr {getcharintprop[25]>=275}"), "Expr braced");
  assert.ok(txt.includes("\t\tDO:\tCallState {Sub} {Alpha}"));
  assert.ok(txt.includes("\tIF:\tSecsOnSpellGE 300 2645"));
  assert.ok(txt.includes("\tIF:\tBlockE 8A020000"));
  assert.ok(txt.includes("\t~~ @disabled\r\n\tIF:\tChatMatch"));
  assert.ok(txt.indexOf("STATE: {Zeta}") < txt.indexOf("STATE: {Alpha}"), "state order preserved");
  assert.ok(txt.includes("\tvnd 1 2 3 7A0B1234 {Vendor Bob}") && txt.includes("\ttlk 1 2 3 7 8 9 37 {Town Crier}") && txt.includes("\tflw 50000001 {Leader Guy}"));
  assert.ok(txt.includes("\tcht 1 2 3 {/vt echo {{braced}}}"));
  assert.ok(txt.includes("\t\t\t\tNot All\r\n\t\t\t\t\tExpr {getvar[x]==1}"), "Not shares its line (metaf)");
  const back = parseAf(txt);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.warnings, []);
  assertSameMeta(afAll, back.meta, "af round trip");
  assert.deepEqual(Object.keys(back.meta.navs).sort(), Object.keys(afAll.navs).sort());
});

await check("tabs and spaces nest the same (indent = column, tab = 4); RynthAi raw braces and Not + indented child", () => {
  const spaced = AF_ALL.replace(/^(\t+)/gm, (t) => " ".repeat(t.length * 4));
  const r = parseAf(spaced);
  assert.equal(r.ok, true, r.error);
  assertSameMeta(afAll, r.meta, "space-indented");
  const rynth = [
    "STATE: {Default} ~~ {",
    "\tIF:\tNot",
    "\t\t\t\tChatMatch {\\d{2} items}",
    "\t\tDO:\tChat {/vt echo {x}}",
    "\tIF:",
    "\t\t\tAlways",
    "\t\tDO:",
    "\t\t\t\tNone",
    "~~ }",
  ].join("\n");
  const q = parseAf(rynth);
  assert.equal(q.ok, true, q.error);
  assert.deepEqual(q.meta.rules[0].cond, { t: "Not", children: [{ t: "ChatMatch", re: "\\d{2} items" }] });
  assert.deepEqual(q.meta.rules[0].act, { t: "Chat", text: "/vt echo {x}" });
  assert.deepEqual([q.meta.rules[1].cond, q.meta.rules[1].act], [{ t: "Always" }, { t: "None" }], "op on the next line");
});

await check("~~ @disabled between rules applies to the next rule only (RynthAi writer form)", () => {
  const txt = ["STATE: {S} ~~ {", "\t~~ @disabled", "\tIF:\tAlways", "\t\tDO:\tDoAll", "\t\t\t\tNone", "", "\t~~ @disabled", "\tIF:\tNever", "\t\tDO:\tNone", "\tIF:\tDeath", "\t\tDO:\tNone", "~~ }"].join("\r\n");
  const r = parseAf(txt);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.meta.rules.map((x) => x.enabled), [false, false, true]);
  assert.deepEqual(r.meta.rules[0].act, { t: "DoAll", children: [{ t: "None" }] });
  assert.deepEqual(parseAf(writeAf(r.meta)).meta.rules.map((x) => x.enabled), [false, false, true]);
});

await check("unknown keywords, missing DO:, bad args ⇒ warnings (never silent); not-metaf ⇒ error", () => {
  const txt = ["STATE: {S}", "\tIF:\tSecsOnSpellLE 2645 30", "\t\tDO:\tFrobnicate {x}", "\tIF:\tMainSlotsLE abc", "\tIF:\tAlways", "\t\tDO:\tNone"].join("\n");
  const r = parseAf(txt);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.meta.rules[0].cond, { t: "Never", unknownKeyword: "SecsOnSpellLE", _af: "SecsOnSpellLE 2645 30" });
  assert.equal(r.meta.rules[0].act.t, "None");
  assert.equal(r.meta.rules[0].act.unknownKeyword, "Frobnicate");
  assert.deepEqual(r.meta.rules[1].cond, { t: "MainSlotsLE", n: 0 });
  assert.equal(r.meta.rules[1].act.t, "None");
  const w = r.warnings.join("\n");
  for (const want of ["unknown condition keyword \"SecsOnSpellLE\"", "unknown action keyword \"Frobnicate\"", "is not a valid i", "IF: without a DO:"]) assert.ok(w.includes(want), `${want}\n${w}`);
  assert.ok(writeAf(r.meta).includes("Never ~~ unknown condition: SecsOnSpellLE 2645 30"));
  assert.equal(parseAf("just some text\nnothing here").ok, false);
  assert.equal(parseAf(42).ok, false);
});

const AF_FIXTURES = [
  ["CapNavPoints-da9d97aa877df77a.af", 6],
  ["BGAugGem0-9cd985a25ba807e6.af", 65],
  ["blodetetdict3-5659606b49df7aff.af", 38],
];
await check("fixture .af files load (rule counts, 0 warnings, valid); NAV sections via nav_file", () => {
  for (const [file, n] of AF_FIXTURES) {
    const r = parseAf(fs.readFileSync(path.join(FIX, file), "utf8"), { fileName: file });
    assert.equal(r.ok, true, `${file}: ${r.error}`);
    assert.equal(r.meta.rules.length, n, file);
    assert.deepEqual(r.warnings, [], file);
    assert.equal(validateMeta(r.meta).ok, true, file);
    const rt = parseAf(writeAf(r.meta));
    assertSameMeta(r.meta, rt.meta, `${file} write/read`);
  }
  const bg = parseAf(fs.readFileSync(path.join(FIX, "BGAugGem0-9cd985a25ba807e6.af"), "utf8")).meta;
  assert.equal(Object.keys(bg.navs).length, 17);
  assert.equal(bg.navs.nav0.navText, "", "empty NAV body");
  assert.equal(parseNav(bg.navs.nav3.navText).points.length, 95);
  assert.equal(bg.navs.nav3.displayName, "125 all jaws.nav");
});

await check("cross-format: BGAugGem0.af ≡ BGAugGem.met (metaf conversion of the same meta), routes included", () => {
  const met = loadedMet["BGAugGem-e4623d0c5858aa80.met"];
  const af = parseAf(fs.readFileSync(path.join(FIX, "BGAugGem0-9cd985a25ba807e6.af"), "utf8")).meta;
  // metaf lower-cases the "[None]" display name on export; compare it case-insensitively.
  const lower = (m) => {
    const c = JSON.parse(JSON.stringify(m));
    for (const r of c.rules) walk(r.act, (a) => a.t === "EmbedNav" && (a.displayName = a.displayName.toLowerCase()));
    return c;
  };
  assertSameMeta(lower(met), lower(af), "BGAugGem");
});

await check(".met → .af → .met is byte-identical for the BOM-less fixture metas", () => {
  for (const file of ["BGAugGem-e4623d0c5858aa80.met", "ColRings-c3986fd7f878c745.met", "motefarm-664a57bdd9ba3df4.met"]) {
    const b = readFix(file);
    const af = writeAf(parseMet(b).meta);
    const back = parseAf(af);
    assert.deepEqual(back.warnings, [], file);
    assert.ok(bytesEq(writeMet(back.meta), b), `${file} via .af`);
  }
});

// ── review regressions (W1-3 verifier) ─────────────────────────────────────
console.log("review regressions");

await check("Int32 fields: validateMeta rejects out-of-range integers; both writers clamp (VTank/metaf Int32.Parse)", () => {
  const m = emptyMeta("i32");
  m.rules.push({ id: "r1", state: "S", enabled: true, cond: { t: "SecsInStateGE", secs: 1e21 }, act: { t: "None" } });
  m.rules.push({ id: "r2", state: "S", enabled: true, cond: { t: "ItemCountGE", name: "x", count: -3e9 }, act: { t: "None" } });
  const v = validateMeta(m);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join("\n").includes("SecsInStateGE.secs must be an integer (Int32)"), v.errors.join("\n"));
  const txt = latin(writeMet(m));
  assert.ok(!/e\+/.test(txt), "no exponent text in an `i` value");
  const r = parseMet(writeMet(m));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.meta.rules[0].cond.secs, r.meta.rules[1].cond.count], [2147483647, -2147483648]);
  const a = writeAf(m);
  assert.ok(a.includes("\tIF:\tSecsInStateGE 2147483647") && a.includes("\tIF:\tItemCountGE -2147483648 {x}"), a);
  // in-range values (incl. the Int32 extremes) are untouched
  m.rules[0].cond.secs = 2147483647;
  m.rules[1].cond.count = -2147483648;
  assert.equal(validateMeta(m).ok, true, validateMeta(m).errors.join("; "));
});

await check("deep / cyclic trees: writeMet and writeAf never overflow; 64 levels round-trip, deeper is written inert and stays readable", () => {
  const chain = (n, leaf, wrap) => {
    let x = leaf;
    for (let i = 0; i < n; i++) x = wrap(x);
    return x;
  };
  const depthOf = (n) => {
    let d = 0;
    while (n && Array.isArray(n.children) && n.children.length) {
      n = n.children[0];
      d++;
    }
    return [d, n && n.t];
  };
  const build = (n) => {
    const m = emptyMeta("deep");
    m.rules.push({ id: "r1", state: "S", enabled: true, cond: chain(n, { t: "Always" }, (c) => ({ t: "Not", children: [c] })), act: chain(n, { t: "None" }, (a) => ({ t: "DoAll", children: [a] })) });
    return m;
  };
  const ok64 = build(64);
  assert.equal(validateMeta(ok64).ok, true);
  const b64 = writeMet(ok64);
  const r64 = parseMet(b64);
  assert.equal(r64.ok, true, r64.error);
  assert.deepEqual([depthOf(r64.meta.rules[0].cond), depthOf(r64.meta.rules[0].act)], [[64, "Always"], [64, "None"]]);
  assert.ok(bytesEq(writeMet(r64.meta), b64), "64 levels byte-stable");
  for (const n of [65, 5000]) {
    const m = build(n);
    assert.equal(validateMeta(m).ok, false, `${n} levels are invalid`);
    const r = parseMet(writeMet(m));
    assert.equal(r.ok, true, `${n}: ${r.error}`);
    assert.deepEqual(depthOf(r.meta.rules[0].cond), [65, "Never"], `${n}: inert past 64`);
    assert.deepEqual(depthOf(r.meta.rules[0].act), [65, "None"]);
    assert.equal(parseAf(writeAf(m)).ok, true);
  }
  const cyc = { t: "All", children: [] };
  cyc.children.push(cyc);
  const mc = emptyMeta("cyc");
  mc.rules.push({ id: "r1", state: "S", enabled: true, cond: cyc, act: { t: "None" } });
  assert.equal(validateMeta(mc).ok, false);
  assert.equal(parseMet(writeMet(mc)).ok, true, "a cyclic tree is written (inert past 64), not a stack overflow");
  assert.equal(typeof writeAf(mc), "string");
});

await check("writeAf NAV sections: route type from the navText header; a non-\"0\" flag line goes through NAVDATA losslessly", () => {
  const linear = "uTank2 NAV 1.2\r\n2\r\n1\r\n0\r\n1.5\r\n2.5\r\n0.01\r\n0\r\n";
  const m = emptyMeta("rt");
  m.navs.a = { displayName: "A", routeType: 1, navText: linear }; // stale MetaNav.routeType
  m.navs.b = { displayName: "B", routeType: 1, navText: "uTank2 NAV 1.2\r\n1\r\n1\r\n0\r\n1.5\r\n2.5\r\n0.01\r\n7\r\n" };
  m.rules.push({ id: "r1", state: "S", enabled: true, cond: { t: "Always" }, act: { t: "DoAll", children: [{ t: "EmbedNav", tag: "a", displayName: "A" }, { t: "EmbedNav", tag: "b", displayName: "B" }] } });
  const txt = writeAf(m);
  assert.ok(txt.includes("NAV: a linear ~~ {"), "the type NAV runs and writeMet embeds");
  assert.ok(txt.includes("NAVDATA: b 8 ~~ {"), "flag 7 cannot be metaf node syntax");
  const back = parseAf(txt);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.warnings, []);
  assert.equal(back.meta.navs.a.navText, linear);
  assert.equal(back.meta.navs.a.routeType, 2);
  assert.equal(back.meta.navs.b.navText, m.navs.b.navText, "flag line kept");
});

await check("reserved tag __proto__ never reaches meta.navs; null options are accepted", () => {
  const route = "uTank2 NAV 1.2\r\n1\r\n1\r\n0\r\n1\r\n2\r\n3\r\n0\r\n";
  const m = emptyMeta("p");
  m.navs.x = { displayName: "__proto__", routeType: 1, navText: route };
  m.rules.push({ id: "r1", state: "S", enabled: true, cond: { t: "Always" }, act: { t: "EmbedNav", tag: "x", displayName: "__proto__" } });
  const r = parseMet(writeMet(m), null);
  assert.equal(r.ok, true, r.error);
  assert.notEqual(r.meta.rules[0].act.tag, "__proto__");
  assert.equal(Object.getPrototypeOf(r.meta.navs), Object.prototype);
  assert.equal(F.findNav(r.meta.navs, r.meta.rules[0].act.tag).navText, route);
  const a = parseAf("STATE: {S}\n\tIF:\tAlways\n\t\tDO:\tEmbedNav __proto__ {x}\nNAV: __proto__ circular\n\tpnt 1 2 3\n", null);
  assert.equal(a.ok, true, a.error);
  assert.equal(Object.getPrototypeOf(a.meta.navs), Object.prototype);
  assert.deepEqual(Object.keys(a.meta.navs), []);
  assert.ok(a.warnings.some((w) => w.includes("__proto__ is reserved")), a.warnings.join("\n"));
  // a JSON meta that does carry an own "__proto__" nav key is written under another tag
  const j = JSON.parse(`{"v":1,"name":"j","source":{"kind":"json"},"rules":[{"id":"r1","state":"S","enabled":true,"cond":{"t":"Always"},"act":{"t":"EmbedNav","tag":"__proto__","displayName":"d"}}],"navs":{"__proto__":{"displayName":"d","routeType":1,"navText":${JSON.stringify(route)}}},"warnings":[]}`);
  const back = parseAf(writeAf(j));
  assert.deepEqual(back.warnings, []);
  assert.equal(F.findNav(back.meta.navs, back.meta.rules[0].act.tag).navText, route);
});

await check("RynthAi-written .af: unbraced ChatMatch / Expr are read to the end of the line (with a warning)", () => {
  const txt = ["STATE: {Default} ~~ {", "\tIF:\tExpr testvar[a] && getvar[b]==1 ~~ note", "\t\tDO:\tNone", "\tIF:\tChatMatch ^You say, \"(?<x>.+)\"$", "\t\tDO:\tNone", "~~ }"].join("\r\n");
  const r = parseAf(txt);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.meta.rules[0].cond, { t: "Expr", expr: "testvar[a] && getvar[b]==1" });
  assert.deepEqual(r.meta.rules[1].cond, { t: "ChatMatch", re: '^You say, "(?<x>.+)"$' });
  assert.equal(r.warnings.filter((w) => w.includes("RynthAi form")).length, 2);
  // metaf (braced) is unaffected
  assert.deepEqual(parseAf("STATE: {S}\n\tIF:\tExpr {a b}\n\t\tDO:\tNone\n").meta.rules[0].cond, { t: "Expr", expr: "a b" });
});

// ── view XML ───────────────────────────────────────────────────────────────
console.log("view_xml");

await check("ColRings view ⇒ 3 buttons with setstate/actionexpr (layout flattened)", () => {
  const xml = allNodes(loadedMet["ColRings-c3986fd7f878c745.met"], "act").find((a) => a.t === "CreateView").xml;
  const r = parseViewXml(xml);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual({ title: r.model.title, width: r.model.width, height: r.model.height }, { title: "Turn In", width: 80, height: 120 });
  assert.deepEqual(r.model.controls, [
    { type: "button", name: "Go", left: 5, top: 5, width: 70, height: 30, text: "Go", setstate: "TurnIn", actionexpr: "" },
    { type: "button", name: "Cancel", left: 5, top: 45, width: 70, height: 30, text: "Cancel", setstate: "Default", actionexpr: "chatbox[\\/ub mexec clearallvars\\[\\]]" },
    { type: "button", name: "Select", left: 5, top: 85, width: 70, height: 30, text: "Exit", setstate: "Exit", actionexpr: "" },
  ]);
});

await check("hostile XML: <script> (with its body) and on* / unknown attributes dropped with warnings", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE v [<!ENTITY x "boom">]><view title="t &amp; &#x41;" onload="evil()"><script>if (a<b) alert(1)</script><control type="layout" left="10" top="20"><control type="button" name="b" left="1" top="2" text="&lt;b&gt;&x;" onclick="alert(1)" style="x"/><control type="checkbox" name="c" checked="true" text="Loot"/><control type="slider" name="s"/></control><iframe src="x"/></view>`;
  const r = parseViewXml(xml);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.model.title, "t & A");
  assert.deepEqual(r.model.controls[0], { type: "button", name: "b", left: 11, top: 22, width: 0, height: 0, text: "<b>&x;" });
  assert.deepEqual(r.model.controls[1], { type: "checkbox", name: "c", left: 10, top: 20, width: 0, height: 0, text: "Loot", checked: true });
  assert.deepEqual(r.model.controls[2], { type: "unsupported", name: "s", left: 10, top: 20, width: 0, height: 0, text: "", origType: "slider" });
  const w = r.warnings.join("\n");
  for (const want of ["element <script> dropped", "event attribute onclick", "event attribute onload", "attribute style", "element <iframe> dropped", "unknown entity &x;", "DOCTYPE skipped"]) assert.ok(w.includes(want), `${want}\n${w}`);
  const json = JSON.stringify(r.model);
  assert.ok(!/alert|evil|onclick|script/i.test(json), json);
  // raw-text end tags match case-insensitively on the original string, even
  // after a character whose lower case is longer ("İ" → "i̇")
  const odd = parseViewXml(`<view title="${"İ".repeat(40)}"><SCRIPT>x<control type="button" name="evil"/></Script><control type="button" name="ok" text="Go"/></view>`);
  assert.equal(odd.ok, true, odd.error);
  assert.deepEqual(odd.model.controls.map((c) => c.name), ["ok"]);
  // many raw-text elements stay linear (no per-element copy of the whole XML)
  const t0 = Date.now();
  assert.equal(parseViewXml(`<view>${"<script>x</script>".repeat(7000)}</view>`).ok, true);
  assert.ok(Date.now() - t0 < 1500, `slow: ${Date.now() - t0} ms`);
});

await check("malformed / no <view> / oversize ⇒ { ok:false, error } (never throws)", () => {
  for (const bad of ["", "<control type='button'/>", "<view title='x'><control type='button' name='a", "<view><!-- never closed", "x".repeat(200 * 1024), null]) {
    const r = parseViewXml(bad);
    assert.equal(r.ok, false, String(bad).slice(0, 40));
    assert.equal(typeof r.error, "string");
  }
  const loose = parseViewXml("<view title='x'><control type='button' name='a' text='A'></view>");
  assert.equal(loose.ok, true, "unclosed control tolerated with a warning");
  assert.equal(loose.model.controls.length, 1);
  assert.ok(loose.warnings.length >= 1);
});

console.log(fail === 0 ? `rynth_vt_formats_meta: all ${pass} checks passed` : `rynth_vt_formats_meta: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
