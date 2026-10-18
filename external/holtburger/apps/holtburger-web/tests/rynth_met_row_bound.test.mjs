// tests/rynth_met_row_bound.test.mjs — RYNTH-3 (2026-10-18 review): the
// .met reader rejects a TABLE row count the rest of the file cannot hold (and
// any rows in a zero-column TABLE) up front, instead of looping and
// allocating once per row (a ~30-byte file froze or OOM-killed the tab).
//
// Exercises the REAL rynth/vt/formats/met.js parseMet / writeMet.
//
// Run from apps/holtburger-web/:  node tests/rynth_met_row_bound.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { parseMet, writeMet } = await import("../rynth/vt/formats/met.js");

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

const timed = (bytes) => {
  const t0 = performance.now();
  const r = parseMet(bytes);
  return { r, ms: performance.now() - t0 };
};

// A modest count first: the unfixed reader loops it out (no hang) and fails
// on the column check instead, so the huge counts below only run once the
// row bound is known to be in place.
let bounded = false;
await check("a zero-column root TABLE with rows is a bad row count (not 'has 0 columns' after looping them)", () => {
  const { r } = timed("1\r\nCondAct\r\n0\r\n300000\r\n");
  assert.equal(r.ok, false);
  assert.match(r.error, /bad row count 300000/);
  bounded = true;
});

await check("the review's ~30-byte file (CRLF and bare-LF) fails at once", () => {
  assert.ok(bounded, "skipped: the row bound is missing (this would hang)");
  for (const text of ["1\r\nCondAct\r\n0\r\n999999999999\r\n", "1\nCondAct\n0\n999999999999\n"]) {
    const { r, ms } = timed(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.match(r.error, /bad row count/);
    assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
  }
});

await check("a row count past the end of the file is refused for a 5-column root too", () => {
  assert.ok(bounded, "skipped: the row bound is missing (this would hang)");
  const head = "1\r\nCondAct\r\n5\r\nCType\r\nAType\r\nCData\r\nAData\r\nState\r\nn\r\nn\r\nn\r\nn\r\nn\r\n";
  const { r, ms } = timed(`${head}999999999999\r\ni\r\n0\r\n`);
  assert.equal(r.ok, false);
  assert.match(r.error, /bad row count/);
  assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
});

await check("a nested zero-column TABLE with rows inside a valid meta is refused (was ok:true after 1 row per count)", () => {
  const ok = new TextDecoder().decode(writeMet({ v: 1, rules: [{ id: "r1", state: "Default", enabled: true, cond: { t: "Never" }, act: { t: "None" } }], navs: {} }));
  assert.equal(parseMet(ok).ok, true, "the template parses");
  // CData is the third "i / 0" value of the row.
  const parts = ok.split("i\r\n0\r\n");
  assert.equal(parts.length, 5);
  const nested = parts.slice(0, 3).join("i\r\n0\r\n") + "TABLE\r\n0\r\n200000\r\n" + parts.slice(3).join("i\r\n0\r\n");
  const r = parseMet(nested);
  assert.equal(r.ok, false);
  assert.match(r.error, /bad row count 200000/);
  // An EMPTY zero-column table is still readable.
  const empty = parts.slice(0, 3).join("i\r\n0\r\n") + "TABLE\r\n0\r\n0\r\n" + parts.slice(3).join("i\r\n0\r\n");
  assert.equal(parseMet(empty).ok, true, "TABLE 0 / 0 rows");
});

await check("the repo's real VTank .met fixtures still parse and round-trip byte-for-byte", () => {
  const dir = path.join(HERE, "../rynth/testdata/vt/meta");
  const files = readdirSync(dir).filter((f) => f.endsWith(".met"));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(path.join(dir, f)));
    const r = parseMet(bytes, { fileName: f });
    assert.equal(r.ok, true, `${f}: ${r.error}`);
    assert.deepEqual(writeMet(r.meta), bytes, `${f}: round trip`);
  }
});

console.log(fail === 0 ? `rynth_met_row_bound: all ${pass} checks passed` : `rynth_met_row_bound: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
