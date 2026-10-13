// tests/rynth_vt_formats_met_lf.test.mjs — rynth/vt/formats/met.js on bare-LF
// `.met` copies (WebAC comparison item rynth-formats-expr-1).
//
// VTank and metaf write a `ba` count as the CRLF character count (metaf
// AEmbedNav.ExportToMet sums `line.Length + 2`; ACreateView counts "2 chars
// for a newline"), and a git CRLF→LF copy keeps that count. parseMet used to
// consume it as raw bytes, over-read one byte per line break and swallow the
// next State ("unknown value type 'ault'" on an LF BGAugGem).
//
//   (a) BGAugGem (17 `ba`) converted to LF: 65 rules, the same navs (tags,
//       point counts, text) as the CRLF parse, byte-stable write (also after
//       JSON), eol "\n", no warnings;
//   (b) writeMet of an LF meta: the `ba` count is bytes + bare LFs and the file
//       re-reads; a CRLF inside an LF meta's XML counts 2, not 3; an LF `_met`
//       hint (non-canonical CreateView key order) stays byte-stable and an
//       edit re-encodes it;
//   (c) an LF file with raw byte counts (holtburger's older LF export) loads
//       through the raw-count retry with a warning; saving writes VTank's
//       counts;
//   (d) CRLF files keep raw byte counts (a bare LF inside a CRLF file's `ba`
//       still counts 1) and stay byte-identical; a count that lands inside a
//       line break or past the end is { ok:false }, never a throw.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_formats_met_lf.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const FIX = path.join(APP, "rynth", "testdata", "vt", "meta");

const F = await import("../rynth/vt/formats/index.js");
const { parseNav } = await import("../rynth/nav_file.js");
const { parseMet, writeMet, navTextInfo, findNav } = F;

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
const latin = (b) => Buffer.from(b).toString("latin1");
const fromLatin = (s) => new Uint8Array(Buffer.from(s, "latin1"));
const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const readFix = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const toLf = (b) => fromLatin(latin(b).replace(/\r\n/g, "\n"));
const lfCount = (s) => (s.match(/\n/g) || []).length;

// Every EmbedNav (at any DoAll depth) with its route, tags included.
function navSummary(meta) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.t === "EmbedNav") {
      const nav = findNav(meta.navs, String(n.tag));
      const info = navTextInfo(nav ? nav.navText : "");
      out.push({ tag: n.tag, displayName: n.displayName, routeType: nav && nav.routeType, points: info.pointCount, follow: info.follow, text: nav ? nav.navText.replace(/\r\n/g, "\n") : null });
    }
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c);
  };
  for (const r of meta.rules) walk(r.act);
  return out;
}
// Model without format hints (`_met`) and ids.
function plain(meta) {
  const strip = (x) => {
    if (!x || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(strip);
    const o = {};
    for (const [k, v] of Object.entries(x)) if (k[0] !== "_" && k !== "id") o[k] = strip(v);
    return o;
  };
  return meta.rules.map((r) => ({ state: r.state, cond: strip(r.cond), act: strip(r.act) }));
}

// An LF file whose `ba` counts are rewritten as raw LF byte lengths — what
// holtburger's LF writer produced before it counted CRLF.
function toByteCounts(lfBytes) {
  const s = latin(lfBytes);
  let out = "";
  let p = 0;
  while (p < s.length) {
    const e = s.indexOf("\n", p);
    const next = e < 0 ? s.length : e + 1;
    const ln = s.slice(p, e < 0 ? s.length : e);
    out += s.slice(p, next);
    p = next;
    if (ln !== "ba") continue;
    const ce = s.indexOf("\n", p);
    const n = parseInt(s.slice(p, ce), 10);
    let i = ce + 1;
    let c = 0;
    while (c < n) c += s[i++] === "\n" ? 2 : 1;
    out += `${i - (ce + 1)}\n${s.slice(ce + 1, i)}`;
    p = i;
  }
  return fromLatin(out);
}

// Hand-built files (independent of writeMet).
function metFile(parts, eol) {
  return enc.encode(parts.map((p) => (typeof p === "string" ? `${p}${eol}` : p.raw)).join(""));
}
const lfFile = (parts) => metFile(parts, "\n");
const crlfFile = (parts) => metFile(parts, "\r\n");
// VTank's count (CRLF characters) of an LF body, and the raw byte count.
const baLf = (text) => ["ba", String(enc.encode(text).length + lfCount(text)), { raw: text }];
const baRaw = (text) => ["ba", String(enc.encode(text).length), { raw: text }];
const HEAD = (rows) => ["1", "CondAct", "5", "CType", "AType", "CData", "AData", "State", "n", "n", "n", "n", "n", String(rows)];
const KV = (n) => ["TABLE", "2", "k", "v", "n", "n", String(n)];

const BG = "BGAugGem-e4623d0c5858aa80.met";

console.log("rynth_vt_formats_met_lf");

await check("(a) BGAugGem as an LF copy: 65 rules, same navs as the CRLF parse, byte-stable, eol \\n", () => {
  const crlf = readFix(BG);
  const lf = toLf(crlf);
  assert.ok(!latin(lf).includes("\r"), "the LF copy has no CR");
  const a = parseMet(crlf, { fileName: BG });
  const r = parseMet(lf, { fileName: BG });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.rules.length, 65);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.meta.source.eol, "\n");
  const want = navSummary(a.meta);
  const got = navSummary(r.meta);
  assert.equal(want.length, 17, "17 EmbedNavs in BGAugGem");
  assert.deepEqual(got, want, "same nav tags, point counts and route text");
  assert.ok(got.some((n) => n.points > 0), "non-empty routes included");
  assert.deepEqual(plain(r.meta), plain(a.meta), "same rules as the CRLF parse");
  assert.ok(bytesEq(writeMet(r.meta), lf), "writeMet(parsed LF copy) === LF bytes");
  assert.ok(bytesEq(writeMet(JSON.parse(JSON.stringify(r.meta))), lf), "byte-stable after a JSON round trip");
  assert.ok(latin(lf).includes("ba\n1045\n [None].nav\n16\n"), "the CRLF count (1045) is kept on the LF copy");
});

await check("(b) writeMet of an LF meta: ba count = bytes + bare LFs (3-point EmbedNav, multi-line XML); re-reads byte-stable", () => {
  const navText = "uTank2 NAV 1.2\n2\n3\n" + "0\n1.5\n2.5\n0\n0\n" + "0\n3.5\n4.5\n0\n0\n" + "0\n5.5\n6.5\n0\n0\n";
  assert.equal(parseNav(navText).points.length, 3);
  const xml = '<view title="Ö">\n<control type="button" name="b" text="Go" setstate="X"/>\n</view>';
  const meta = {
    v: 1,
    name: "lf",
    source: { kind: "met", eol: "\n" },
    rules: [
      { id: "r1", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "EmbedNav", tag: "loop", displayName: "loop" } },
      { id: "r2", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "CreateView", view: "Panel", xml } },
    ],
    navs: { loop: { displayName: "loop", routeType: 2, navText } },
    warnings: [],
  };
  const bytes = writeMet(meta);
  const txt = latin(bytes);
  assert.ok(!txt.includes("\r"), "an LF meta is written LF");
  const body = `loop\n3\n${navText}`;
  assert.ok(txt.includes(`ba\n${enc.encode(body).length + lfCount(body)}\n${body}s\nDefault\n`), "EmbedNav count = bytes + LF count");
  assert.equal(enc.encode(body).length + lfCount(body), latin(enc.encode(body)).replace(/\n/g, "\r\n").length, "= the CRLF character count");
  assert.ok(txt.includes(`ba\n${enc.encode(xml).length + 2}\n${latin(enc.encode(xml))}s\nDefault\n`), "CreateView XML count = bytes + 2");
  const r = parseMet(bytes);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.meta.source.eol, "\n");
  assert.equal(findNav(r.meta.navs, r.meta.rules[0].act.tag).navText, navText);
  assert.equal(navTextInfo(navText).pointCount, 3);
  assert.equal(r.meta.rules[1].act.xml, xml);
  assert.ok(!r.meta.rules[0].act._met && !r.meta.rules[1].act._met, "canonical: no hints");
  assert.ok(bytesEq(writeMet(r.meta), bytes), "byte-stable");
});

await check("(b) a CRLF inside an LF meta's XML counts 2 (not 3) and re-reads", () => {
  const xml = "<view>\r\n<control type=\"button\" name=\"b\" text=\"Go\"/>\n</view>";
  const meta = { v: 1, name: "x", source: { kind: "met", eol: "\n" }, rules: [{ id: "r1", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "CreateView", view: "V", xml } }], navs: {}, warnings: [] };
  const bytes = writeMet(meta);
  assert.ok(latin(bytes).includes(`ba\n${enc.encode(xml).length + 1}\n`), "only the bare LF adds one");
  const r = parseMet(bytes);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.rules[0].act.xml, xml);
  assert.equal(r.meta.source.eol, "\n");
  assert.ok(bytesEq(writeMet(r.meta), bytes), "byte-stable");
});

await check("(b) LF _met hint: a non-canonical CreateView (x before n) stays byte-stable; an edit re-encodes it", () => {
  const xml = '<view title="a">\n<control type="button" name="b" text="Go"/>\n</view>';
  const bytes = lfFile([...HEAD(1), "i", "1", "i", "13", "i", "0", ...KV(2), "s", "x", ...baLf(xml), "s", "n", "s", "Panel", "s", "Default"]);
  const r = parseMet(bytes);
  assert.equal(r.ok, true, r.error);
  const act = r.meta.rules[0].act;
  assert.equal(act.xml, xml);
  assert.equal(act.view, "Panel");
  assert.ok(act._met, "key order differs from VTank's ⇒ hint");
  assert.ok(bytesEq(writeMet(r.meta), bytes), "hint re-read with CRLF counts ⇒ byte-stable");
  assert.ok(bytesEq(writeMet(JSON.parse(JSON.stringify(r.meta))), bytes), "byte-stable after JSON");
  act.view = "Other";
  const out = writeMet(r.meta);
  assert.ok(latin(out).includes(`s\nn\ns\nOther\ns\nx\nba\n${enc.encode(xml).length + 2}\n`), "edited ⇒ VTank key order, CRLF count");
  const back = parseMet(out);
  assert.equal(back.ok, true, back.error);
  assert.equal(back.meta.rules[0].act.view, "Other");
  assert.equal(back.meta.rules[0].act.xml, xml);
});

await check("(c) an LF file with raw byte counts (older LF export) loads via the retry; saving writes VTank's counts", () => {
  const lf = toLf(readFix(BG));
  const legacy = toByteCounts(lf);
  assert.ok(!bytesEq(legacy, lf), "counts rewritten");
  assert.ok(latin(legacy).includes("ba\n960\n [None].nav\n16\n"), "1045 - 85 line breaks");
  const r = parseMet(legacy, { fileName: BG });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.rules.length, 65);
  assert.equal(r.warnings.length, 1, r.warnings.join("; "));
  assert.match(r.warnings[0], /LF byte counts.*saving writes VTank's counts/);
  assert.deepEqual(r.meta.warnings, r.warnings);
  const a = parseMet(lf);
  assert.deepEqual(navSummary(r.meta), navSummary(a.meta), "same navs as the VTank-count copy");
  assert.deepEqual(plain(r.meta), plain(a.meta), "same rules");
  const out = writeMet(r.meta);
  assert.ok(bytesEq(out, lf), "saved with VTank's CRLF counts (no mixed counts)");
  assert.ok(bytesEq(writeMet(JSON.parse(JSON.stringify(r.meta))), lf), "also after JSON");
  const again = parseMet(out);
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(again.warnings, [], "the re-saved file needs no retry");
});

await check("(c) a small byte-count LF export: edited and unedited EmbedNavs are both saved with CRLF counts", () => {
  const nav = (name) => `${name}\n1\nuTank2 NAV 1.2\n2\n1\n0\n1\n2\n0\n0\n`;
  const parts = [...HEAD(2), "i", "1", "i", "4", "i", "0", ...baRaw(nav("a")), "s", "Default", "i", "1", "i", "3", "i", "0", "TABLE", "2", "K", "V", "n", "n", "1", "i", "4", ...baRaw(nav("b")), "s", "Default"];
  const r = parseMet(lfFile(parts));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.warnings.length, 1);
  const tagA = r.meta.rules[0].act.tag;
  const tagB = r.meta.rules[1].act.children[0].tag;
  r.meta.navs[tagA].navText = r.meta.navs[tagA].navText.replace("\n1\n2\n0\n0\n", "\n7\n8\n0\n0\n");
  const out = writeMet(r.meta);
  const txt = latin(out);
  assert.ok(txt.includes(`ba\n${enc.encode(nav("a")).length + lfCount(nav("a"))}\n`), "edited nav: CRLF count");
  assert.ok(txt.includes(`ba\n${enc.encode(nav("b")).length + lfCount(nav("b"))}\n`), "unedited nav (inside DoAll): CRLF count too");
  const back = parseMet(out);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.warnings, []);
  assert.ok(findNav(back.meta.navs, back.meta.rules[0].act.tag).navText.includes("\n7\n8\n"), "edit kept");
  assert.equal(findNav(back.meta.navs, back.meta.rules[1].act.children[0].tag).navText, findNav(r.meta.navs, tagB).navText);
});

await check("(d) CRLF files keep raw byte counts: a bare LF inside a CRLF file's ba counts 1; fixture stays byte-identical", () => {
  const xml = '<view title="a">\n<control type="button" name="b" text="Go"/></view>';
  const bytes = crlfFile([...HEAD(1), "i", "1", "i", "13", "i", "0", ...KV(2), "s", "n", "s", "Panel", "s", "x", ...baRaw(xml), "s", "Default"]);
  const r = parseMet(bytes);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.rules[0].act.xml, xml);
  assert.equal(r.meta.source.eol, undefined);
  assert.ok(bytesEq(writeMet(r.meta), bytes), "byte-stable, raw count");
  const crlf = readFix(BG);
  const m = parseMet(crlf).meta;
  assert.ok(bytesEq(writeMet(m), crlf), "CRLF fixture byte-identical");
  assert.ok(latin(writeMet(m)).includes("ba\r\n1045\r\n [None].nav\r\n16\r\n"));
});

await check("(d) a count inside a line break or past the end ⇒ { ok:false, error } (never throws)", () => {
  const inside = lfFile([...HEAD(1), "i", "1", "i", "13", "i", "0", ...KV(2), "s", "n", "s", "V", "s", "x", "ba", "3", { raw: "ab\ncd" }, "s", "Default"]);
  const r1 = parseMet(inside);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /inside a line break/);
  const past = lfFile([...HEAD(1), "i", "1", "i", "13", "i", "0", ...KV(2), "s", "n", "s", "V", "s", "x", "ba", "999", { raw: "ab\ncd" }, "s", "Default"]);
  const r2 = parseMet(past);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /past the end/);
  const neg = lfFile([...HEAD(1), "i", "1", "i", "13", "i", "0", ...KV(2), "s", "n", "s", "V", "s", "x", "ba", "-1", { raw: "" }, "s", "Default"]);
  assert.equal(parseMet(neg).ok, false);
});

console.log(fail === 0 ? `rynth_vt_formats_met_lf: all ${pass} checks passed` : `rynth_vt_formats_met_lf: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
