// tests/rynth_vt_formats_af_xf.test.mjs — rynth/vt/formats/af.js metaf
// EmbedNav point transform (WebAC comparison item rynth-formats-expr-4).
//
// metaf (Navigation/Nav.cs ApplyXF, AEmbedNav.cs) lets one NAV serve a
// duplicated dungeon: `EmbedNav tag {name} {a b c d e f g}` moves every node
// to x' = a·x + b·y + e, y' = c·x + d·y + f, z' = z + g (and a ptl/tlk object
// position the same way; a jmp heading is not rotated). parseAf used to warn
// "not supported (ignored)" and embed the untransformed route.
//
//   (a) a 2-point NAV + a ptl cited plainly and with {1 0 0 1 0.8 -0.8 0}:
//       the transformed citation cites a derived NAV whose ew/ns (and the ptl
//       object position) are shifted by +0.8 / -0.8, z unchanged; the plain
//       citation keeps the original navText byte-identical; no warning;
//   (b) a full affine map with a z offset over every node type: positions
//       moved, trailers (pause, chat, recall, vendor, names, jmp heading)
//       kept;
//   (c) a 6-number, a non-numeric and an unbraced transform warn and are
//       ignored (the EmbedNav cites the original NAV);
//   (d) the same transform twice ⇒ one derived NAV; another transform and an
//       existing `<tag>_xf` NAV ⇒ unique tags; Follow / empty routes are left
//       as they are; a NAVDATA route is transformed too;
//   (e) writeMet(parseAf(…)) re-parses with the moved points; writeAf writes
//       the derived NAV as a plain section and reads back the same routes.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_formats_af_xf.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/vt/formats/index.js");
const { parseNav } = await import("../rynth/nav_file.js");
const { parseAf, writeAf, parseMet, writeMet, findNav, validateMeta } = F;

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

const af = (lines) => lines.join("\r\n") + "\r\n";
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
function embeds(meta) {
  const out = [];
  const walk = (a) => {
    if (!a || typeof a !== "object") return;
    if (a.t === "EmbedNav") out.push(a);
    if (Array.isArray(a.children)) a.children.forEach(walk);
  };
  for (const r of meta.rules) walk(r.act);
  return out;
}
const byName = (meta, displayName) => embeds(meta).find((a) => a.displayName === displayName);
const pointsOf = (meta, displayName) => {
  const a = byName(meta, displayName);
  assert.ok(a, `EmbedNav {${displayName}}`);
  const nav = findNav(meta.navs, a.tag);
  assert.ok(nav, `nav ${a.tag}`);
  const p = parseNav(nav.navText);
  assert.equal(p.warning, null, `${displayName}: ${p.warning}`);
  return p.points;
};
const xfWarnings = (r) => r.warnings.filter((w) => /point transform|transform \{/.test(w));

const NAV_DNG = ["NAV: dng linear ~~ {", "\tpnt 10.5 -20.25 0.5", "\tpnt 11 -21 0.5", "\tptl 12 -22 0.5 13.5 -23.5 0.25 14 {Portal Out}", "~~ }"];
const SHIFT = af([
  "STATE: {Default} ~~ {",
  "\tIF:\tAlways",
  "\t\tDO:\tEmbedNav dng {Dungeon A}",
  "\tIF:\tNavEmpty",
  "\t\tDO:\tEmbedNav dng {Dungeon B} {1 0 0 1 0.8 -0.8 0}",
  "~~ }",
  ...NAV_DNG,
]);
const PLAIN_ONLY = af(["STATE: {Default} ~~ {", "\tIF:\tAlways", "\t\tDO:\tEmbedNav dng {Dungeon A}", "~~ }", ...NAV_DNG]);

console.log("EmbedNav point transform");

await check("(a) {1 0 0 1 0.8 -0.8 0}: derived nav shifted +0.8/-0.8, ptl target too, z kept, no warning", () => {
  const r = parseAf(SHIFT);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(xfWarnings(r), [], "no transform warning for a valid transform");
  assert.ok(!r.warnings.some((w) => /never used/.test(w)), `no unused-nav warning: ${r.warnings.join(" | ")}`);
  const plain = byName(r.meta, "Dungeon A");
  const moved = byName(r.meta, "Dungeon B");
  assert.equal(plain.tag, "dng");
  assert.equal(moved.tag, "dng_xf", "the transformed citation cites a derived tag");
  for (const a of embeds(r.meta)) assert.equal("_xf" in a, false, "no _xf left on the node");
  assert.equal(r.meta.navs.dng_xf.displayName, "Dungeon B");
  assert.equal(r.meta.navs.dng_xf.routeType, 2);
  const src = pointsOf(r.meta, "Dungeon A");
  const dst = pointsOf(r.meta, "Dungeon B");
  assert.equal(dst.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(dst[i].type, src[i].type);
    near(dst[i].ew, src[i].ew + 0.8, `pt ${i} ew`);
    near(dst[i].ns, src[i].ns - 0.8, `pt ${i} ns`);
    assert.equal(dst[i].z, src[i].z, `pt ${i} z unchanged`);
  }
  near(dst[2].exitEW, 13.5 + 0.8, "ptl exitEW");
  near(dst[2].exitNS, -23.5 - 0.8, "ptl exitNS");
  assert.equal(dst[2].exitZ, 0.25, "ptl exitZ unchanged");
  assert.equal(dst[2].name, "Portal Out");
  assert.equal(dst[2].objectClass, 14);
  assert.equal(dst[2].isTie, true);
  assert.ok(validateMeta(r.meta).ok, validateMeta(r.meta).errors.join("; "));
});

await check("(a) the plain citation's navText is byte-identical to a file without the transform", () => {
  const r = parseAf(SHIFT);
  const base = parseAf(PLAIN_ONLY);
  assert.equal(base.ok, true);
  assert.equal(r.meta.navs.dng.navText, base.meta.navs.dng.navText);
  assert.equal(r.meta.navs.dng.displayName, "Dungeon A");
  assert.deepEqual(Object.keys(base.meta.navs), ["dng"], "no derived nav without a transform");
});

await check("(b) full affine map + z offset over every node type; trailers and jmp heading kept", () => {
  const text = af([
    "STATE: {Default} ~~ {",
    "\tIF:\tAlways",
    "\t\tDO:\tEmbedNav all {Moved} {0 -1 1 0 10 20 0.5}",
    "~~ }",
    "NAV: all circular ~~ {",
    "\tpnt 1 2 3",
    "\trcl 1 2 3 {Lifestone Recall}",
    "\tpau 1 2 3 5000",
    "\tcht 1 2 3 {/vt echo hi}",
    "\tvnd 1 2 3 7A0B1234 {Vendor Bob}",
    "\tptl 1 2 3 4 5 6 14 {Portal to Town}",
    "\ttlk 1 2 3 7 8 9 37 {Town Crier}",
    "\tchk 1 2 3",
    "\tjmp 1 2 3 90 {True} 200",
    "\tprt 1 2 3 7A0B0001",
    "~~ }",
  ]);
  const r = parseAf(text);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(xfWarnings(r), []);
  const pts = pointsOf(r.meta, "Moved");
  assert.deepEqual(
    pts.map((p) => p.type),
    [0, 2, 3, 4, 5, 6, 7, 8, 9, 1],
  );
  // x' = -y + 10 = 8, y' = x + 20 = 21, z' = 3.5
  for (const p of pts) {
    assert.equal(p.ew, 8, `type ${p.type} ew`);
    assert.equal(p.ns, 21, `type ${p.type} ns`);
    assert.equal(p.z, 3.5, `type ${p.type} z`);
    assert.equal(p.flag, "0");
  }
  const t = (type) => pts.find((p) => p.type === type);
  assert.equal(t(2).spellId, 1635);
  assert.equal(t(3).pauseMs, 5000);
  assert.equal(t(4).chat, "/vt echo hi");
  assert.equal(t(5).vendorId, 0x7a0b1234);
  assert.equal(t(5).name, "Vendor Bob");
  assert.equal(t(1).guid, 0x7a0b0001);
  // ptl object (4,5,6) → (-5+10, 4+20, 6.5); tlk (7,8,9) → (2, 27, 9.5)
  assert.deepEqual([t(6).exitEW, t(6).exitNS, t(6).exitZ, t(6).name, t(6).objectClass], [5, 24, 6.5, "Portal to Town", 14]);
  assert.deepEqual([t(7).exitEW, t(7).exitNS, t(7).exitZ, t(7).name, t(7).objectClass], [2, 27, 9.5, "Town Crier", 37]);
  assert.equal(t(9).headingDeg, 90, "jmp heading not rotated (metaf)");
  assert.equal(t(9).holdShift, true);
  assert.equal(t(9).delayMs, 200);
  // The source NAV is still the untransformed route.
  const src = parseNav(r.meta.navs.all.navText).points;
  assert.ok(src.every((p) => p.ew === 1 && p.ns === 2 && p.z === 3));
});

await check("(c) a 6-number / non-numeric / unbraced transform warns and is ignored", () => {
  for (const [xf, label] of [
    ["{1 0 0 1 0.8 -0.8}", "6 numbers"],
    ["{1 0 0 1 a -0.8 0}", "non-numeric"],
    ["{1 0 0 1 0.8 -0.8 0 0}", "8 numbers"],
    ["{}", "empty"],
    ["1", "unbraced"],
  ]) {
    const r = parseAf(af(["STATE: {Default} ~~ {", "\tIF:\tAlways", `\t\tDO:\tEmbedNav dng {Dungeon B} ${xf}`, "~~ }", ...NAV_DNG]));
    assert.equal(r.ok, true, label);
    const w = xfWarnings(r);
    assert.equal(w.length, 1, `${label}: ${r.warnings.join(" | ")}`);
    assert.match(w[0], /^line 3: EmbedNav point transform \{.*\} is not seven numbers \{a b c d e f g\} \(ignored\)$/, label);
    assert.equal(byName(r.meta, "Dungeon B").tag, "dng", `${label}: cites the original`);
    assert.deepEqual(Object.keys(r.meta.navs), ["dng"], `${label}: no derived nav`);
    assert.equal("_xf" in byName(r.meta, "Dungeon B"), false);
  }
});

await check("(d) same transform twice ⇒ one derived nav; other transform / taken tag ⇒ unique tags", () => {
  const r = parseAf(
    af([
      "STATE: {Default} ~~ {",
      "\tIF:\tAlways",
      "\t\tDO:\tDoAll",
      "\t\t\tEmbedNav dng {B1} {1 0 0 1 0.8 -0.8 0}",
      "\t\t\tEmbedNav dng {B2} {1 0 0 1 0.8 -0.8 0}",
      "\t\t\tEmbedNav dng {C} {1 0 0 1 -1 1 0}",
      "\t\t\tEmbedNav dng_xf {Mine}",
      "~~ }",
      ...NAV_DNG,
      "NAV: dng_xf circular ~~ {",
      "\tpnt 0 0 0",
      "~~ }",
    ]),
  );
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(xfWarnings(r), []);
  assert.equal(byName(r.meta, "B1").tag, "dng_xf_2");
  assert.equal(byName(r.meta, "B2").tag, "dng_xf_2", "identical transform reuses the derived nav");
  assert.equal(byName(r.meta, "C").tag, "dng_xf_3");
  assert.equal(byName(r.meta, "Mine").tag, "dng_xf", "an authored dng_xf NAV is not shadowed");
  assert.deepEqual(Object.keys(r.meta.navs).sort(), ["dng", "dng_xf", "dng_xf_2", "dng_xf_3"]);
  near(pointsOf(r.meta, "C")[0].ew, 9.5, "C ew");
  near(pointsOf(r.meta, "C")[0].ns, -19.25, "C ns");
  assert.equal(pointsOf(r.meta, "Mine")[0].ew, 0);
});

await check("(d) Follow and empty routes are left as they are; a NAVDATA route is transformed", () => {
  const r = parseAf(
    af([
      "STATE: {Default} ~~ {",
      "\tIF:\tAlways",
      "\t\tDO:\tDoAll",
      "\t\t\tEmbedNav navF {F} {1 0 0 1 5 5 0}",
      "\t\t\tEmbedNav nav0 {E} {1 0 0 1 5 5 0}",
      "\t\t\tEmbedNav rnav {R} {1 0 0 1 5 5 1}",
      "~~ }",
      "NAV: navF follow ~~ {",
      "\tflw 50000001 {Leader Guy}",
      "~~ }",
      "NAV: nav0 circular ~~ {",
      "~~ }",
      "NAVDATA: rnav 8 ~~ {",
      "uTank2 NAV 1.2",
      "2",
      "1",
      "0",
      "1.25",
      "2.5",
      "0.75",
      "0",
      "~~ }",
    ]),
  );
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(xfWarnings(r), []);
  assert.equal(byName(r.meta, "F").tag, "navF");
  assert.equal(byName(r.meta, "E").tag, "nav0");
  assert.equal(byName(r.meta, "R").tag, "rnav_xf");
  const p = pointsOf(r.meta, "R");
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].ew, p[0].ns, p[0].z], [6.25, 7.5, 1.75]);
  assert.deepEqual(Object.keys(r.meta.navs).sort(), ["nav0", "navF", "rnav", "rnav_xf"]);
});

await check("(e) writeMet(parseAf(…)) re-parses with the transformed points", () => {
  const r = parseAf(SHIFT);
  const bytes = writeMet(r.meta);
  const m = parseMet(bytes);
  assert.equal(m.ok, true, m.error);
  const src = pointsOf(m.meta, "Dungeon A");
  const dst = pointsOf(m.meta, "Dungeon B");
  assert.deepEqual(
    src.map((p) => [p.ew, p.ns, p.z]),
    [
      [10.5, -20.25, 0.5],
      [11, -21, 0.5],
      [12, -22, 0.5],
    ],
  );
  for (let i = 0; i < 3; i++) {
    near(dst[i].ew, src[i].ew + 0.8, `met pt ${i} ew`);
    near(dst[i].ns, src[i].ns - 0.8, `met pt ${i} ns`);
    assert.equal(dst[i].z, src[i].z);
  }
  near(dst[2].exitEW, 14.3, "met ptl exitEW");
  near(dst[2].exitNS, -24.3, "met ptl exitNS");
});

await check("(e) writeAf writes the derived NAV as a plain section and reads back the same routes", () => {
  const r = parseAf(SHIFT);
  const text = writeAf(r.meta);
  assert.ok(/EmbedNav dng_xf \{Dungeon B\}\r\n/.test(text), "no transform on the written EmbedNav");
  assert.ok(text.includes("NAV: dng_xf linear ~~ {"), "derived NAV section written");
  const back = parseAf(text);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(xfWarnings(back), []);
  for (const name of ["Dungeon A", "Dungeon B"]) {
    const a = pointsOf(r.meta, name).map((p) => [p.type, p.ew, p.ns, p.z, p.exitEW, p.exitNS, p.exitZ]);
    const b = pointsOf(back.meta, name).map((p) => [p.type, p.ew, p.ns, p.z, p.exitEW, p.exitNS, p.exitZ]);
    assert.deepEqual(b, a, name);
  }
});

console.log(fail === 0 ? `rynth_vt_formats_af_xf: all ${pass} checks passed` : `rynth_vt_formats_af_xf: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
