#!/usr/bin/env node
// rynth_vt_corpus_test.cjs — the W1-3 FMT readers/writers against the real
// player-shared VTank files (PLAN §6 W1-3, R5; U5 §6.1, U7a §5.9).
//
// CORPUS = /mnt/wbterminal2/ac-discord-archive/export/media/ (outside this
// app; RYNTH_VT_CORPUS_DIR overrides — a non-existent dir exercises the
// absent path). When it exists:
//   * every `.met` (17 files) parses with 0 trailing bytes and the U5 §6.1
//     rule count, validates, and round-trips byte-for-byte (also after JSON);
//     the BOM-less ones without CRs inside strings also survive .met → .af → .met
//     byte-for-byte;
//   * every `.af` (3 files) parses with 0 warnings, validates, and re-reads
//     identically from writeAf;
//   * every `.utl` parses, validates, and round-trips byte-for-byte;
//   * every CreateView XML parses into a ViewModel.
// When it is absent the file prints "0 corpus checks" and exits 0 (no
// `// requires:` header — that would make the node runner skip it forever).
//
// Run:   node rynth_vt_corpus_test.cjs

"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = __dirname;
const CORPUS = process.env.RYNTH_VT_CORPUS_DIR || "/mnt/wbterminal2/ac-discord-archive/export/media";

// U5 §6.1 row counts, by file-name prefix (the corpus appends "-<hash>").
const MET_ROWS = {
  "4Hives": 58,
  BGAugGem: 65,
  "BuffOnTell7s_1.2": 10,
  CapNavPoints: 6,
  ChatCapWierdness: 6,
  ColRings: 7,
  FacilityHub_Expanded: 188,
  FellowSpells: 25,
  Pull_MFK: 28,
  abmain: 1,
  blodetetdict3: 38,
  comma: 1,
  lum: 33,
  missingLegendaries: 1,
  motefarm: 10,
  motefarm_super_special_version_for_nightma: 8,
};
const AF_ROWS = { BGAugGem0: 65, blodetetdict3: 38, CapNavPoints: 6 };
const prefixOf = (f) => f.replace(/-[0-9a-f]{16}\.(met|af|utl)$/i, "");

async function main() {
  let dirOk = false;
  try {
    dirOk = fs.statSync(CORPUS).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    console.log(`rynth_vt_corpus: 0 corpus checks (${CORPUS} not present)`);
    return 0;
  }
  const F = await import(pathToFileURL(path.join(APP, "rynth", "vt", "formats", "index.js")).href);
  const files = fs.readdirSync(CORPUS).sort();
  const mets = files.filter((f) => /\.met$/i.test(f));
  const afs = files.filter((f) => /\.af$/i.test(f));
  const utls = files.filter((f) => /\.utl$/i.test(f));
  let checks = 0;
  const failures = [];
  const ok = (cond, msg) => {
    checks++;
    if (!cond) failures.push(msg);
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const walk = (n, fn) => {
    if (!n || typeof n !== "object") return;
    fn(n);
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, fn);
  };
  let views = 0;

  for (const f of mets) {
    const b = new Uint8Array(fs.readFileSync(path.join(CORPUS, f)));
    const r = F.parseMet(b, { fileName: f });
    ok(r.ok, `${f}: ${r.error}`);
    if (!r.ok) continue;
    ok(!r.warnings.some((w) => /trailing byte/.test(w)), `${f}: trailing bytes`);
    ok(r.warnings.length === 0, `${f}: warnings ${r.warnings.join("; ")}`);
    const want = MET_ROWS[prefixOf(f)];
    ok(want !== undefined && r.meta.rules.length === want, `${f}: ${r.meta.rules.length} rules (U5 §6.1: ${want})`);
    const v = F.validateMeta(r.meta);
    ok(v.ok, `${f}: invalid ${v.errors.slice(0, 3).join("; ")}`);
    ok(same(F.writeMet(r.meta), b), `${f}: .met round trip not byte-stable`);
    ok(same(F.writeMet(JSON.parse(JSON.stringify(r.meta))), b), `${f}: not byte-stable after JSON`);
    const hasCr = JSON.stringify(r.meta.rules).includes("\\r");
    if (!r.meta.source.bom && !hasCr) {
      const back = F.parseAf(F.writeAf(r.meta));
      ok(back.ok && back.warnings.length === 0 && same(F.writeMet(back.meta), b), `${f}: .met → .af → .met not byte-stable`);
    }
    for (const rule of r.meta.rules) {
      walk(rule.act, (a) => {
        if (a.t !== "CreateView") return;
        views++;
        const pv = F.parseViewXml(a.xml);
        ok(pv.ok && pv.model.controls.length > 0, `${f}: CreateView ${a.view}: ${pv.error || "no controls"}`);
      });
    }
  }
  ok(mets.length === 17, `expected 17 .met files, found ${mets.length}`);

  for (const f of afs) {
    const r = F.parseAf(fs.readFileSync(path.join(CORPUS, f), "utf8"), { fileName: f });
    ok(r.ok, `${f}: ${r.error}`);
    if (!r.ok) continue;
    ok(r.warnings.length === 0, `${f}: warnings ${r.warnings.slice(0, 3).join("; ")}`);
    const want = AF_ROWS[prefixOf(f)];
    ok(want !== undefined && r.meta.rules.length === want, `${f}: ${r.meta.rules.length} rules (want ${want})`);
    ok(F.validateMeta(r.meta).ok, `${f}: invalid`);
    const again = F.parseAf(F.writeAf(r.meta));
    ok(again.ok && again.warnings.length === 0 && F.writeAf(again.meta) === F.writeAf(r.meta), `${f}: writeAf/parseAf not stable`);
  }
  ok(afs.length === 3, `expected 3 .af files, found ${afs.length}`);

  let utlRules = 0;
  for (const f of utls) {
    const t = fs.readFileSync(path.join(CORPUS, f), "utf8");
    const r = F.parseUtl(t);
    ok(r.ok, `${f}: ${r.error}`);
    if (!r.ok) continue;
    utlRules += r.profile.rules.length;
    const v = F.validateUtl(r.profile);
    ok(v.ok, `${f}: invalid ${v.errors.slice(0, 3).join("; ")}`);
    ok(F.writeUtl(r.profile) === t, `${f}: .utl round trip not byte-stable`);
    ok(F.writeUtl(JSON.parse(JSON.stringify(r.profile))) === t, `${f}: .utl not byte-stable after JSON`);
  }

  if (failures.length) {
    for (const m of failures) console.log(`  FAIL ${m}`);
    console.log(`rynth_vt_corpus: ${failures.length} of ${checks} corpus checks FAILED`);
    return 1;
  }
  console.log(`rynth_vt_corpus: ${checks} corpus checks passed (${mets.length} .met, ${afs.length} .af, ${utls.length} .utl with ${utlRules} rules, ${views} views)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.log(`rynth_vt_corpus: crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  },
);
