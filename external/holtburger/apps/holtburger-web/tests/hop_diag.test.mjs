// tests/hop_diag.test.mjs — scene3d/diag/hop.js, the devtools surface over
// the wasm hop detector (holtburger_core::hop_diag). The wasm exports are
// faked with the exact JSON shape `read_json` emits.
//
// Run: node tests/hop_diag.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

const { attachHop, readHopRing, compactHop, HOP_KINDS, HOP_CAUSES } =
  await import("../scene3d/diag/hop.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// One incident as `push_incident` writes it (field order and spelling).
const CAUSE_OF = { liftOff: "leftGround", bounceLiftOff: "bounce", pop: "wade" };
function incident(seq, kind, extra = {}) {
  return {
    seq, atMs: 1000 * seq, kind, cause: CAUSE_OF[kind], dtMs: 16.7,
    rise: kind === "pop" ? 0.35 : 0.0,
    beginCell: 0xAAB5000A, begin: [31.0, 41.699, 27.555],
    endCell: 0xAAB5000A, end: [31.0, 42.0, 27.905], offset: [0.0, 0.301, 0.0],
    excessBegin: -0.445, excessEnd: kind === "pop" ? -0.095 : -0.445,
    transitionOk: true, moved: true, grounded: kind === "pop",
    contactNz: kind === "pop" ? 1.0 : null, contactCell: 0xAAB5000A,
    entryNz: 1.0, wallNz: null, terrainNzBegin: 1.0, terrainNzEnd: 1.0,
    depthBegin: 0.45, depthEnd: kind === "pop" ? 0.1 : 0.45, depthBeginDeep: 0.45,
    staticsBegin: 0, staticsEnd: 0, clampM: 0,
    framesStationaryFall: 0, bounceLift: kind === "bounceLiftOff", vz: 0.0,
    ...extra,
  };
}

let cleared = 0;
let ring = { count: 3, incidents: [incident(1, "liftOff"), incident(2, "bounceLiftOff"), incident(3, "pop")] };
function installWasm() {
  window.__hbWasm = {
    hopDiag: () => JSON.stringify(ring),
    hopDiagCount: () => ring.count,
    hopDiagClear: () => { cleared += 1; ring = { count: 0, incidents: [] }; },
  };
}

// ── absent exports (stale pkg/, pre-boot) ──
{
  delete window.__hbWasm;
  const diag = {};
  attachHop(diag);
  check("attaches the namespace", typeof diag.hop === "object");
  check("available() is false without the export", diag.hop.available() === false);
  check("count() is null without the export", diag.hop.count() === null);
  check("tail() is empty without the export", Array.isArray(diag.hop.tail()) && diag.hop.tail().length === 0);
  const s = diag.hop.summary();
  check("summary() names the missing export", s.available === false && /hopDiag/.test(s.error), JSON.stringify(s));
  check("clear() is false without the export", diag.hop.clear() === false);
  check("explain() with nothing recorded", diag.hop.explain() === "no hop recorded");
}

// ── the ring ──
{
  installWasm();
  const diag = {};
  attachHop(diag);
  check("available() with the export", diag.hop.available() === true);
  check("count() reads the wasm counter", diag.hop.count() === 3);
  const tail = diag.hop.tail(2);
  check("tail(2) is the last two, oldest first", tail.length === 2 && tail[0].seq === 2 && tail[1].seq === 3, JSON.stringify(tail.map((i) => i.seq)));
  check("tail(0) is empty", diag.hop.tail(0).length === 0);
  check("last() is the newest", diag.hop.last()?.seq === 3);
  const s = diag.hop.summary();
  check("summary counts kinds", s.byKind.liftOff === 1 && s.byKind.bounceLiftOff === 1 && s.byKind.pop === 1, JSON.stringify(s.byKind));
  check("summary counts causes", s.byCause.leftGround === 1 && s.byCause.bounce === 1 && s.byCause.wade === 1, JSON.stringify(s.byCause));
  check("summary count/kept", s.count === 3 && s.kept === 3);
  check("summary.last is compact with hex cells, cause and clamp",
    s.last.seq === 3 && s.last.rise === 0.35 && s.last.cause === "wade" && s.last.clampM === 0 &&
      s.last.cells[0] === "0xAAB5000A" && s.last.cells[1] === "0xAAB5000A" && !("offset" in s.last),
    JSON.stringify(s.last));
  check("explain() names the kind and the cause",
    /pop \(wade\)/.test(diag.hop.explain()) && /step-up/.test(diag.hop.explain()) && /calc_water_depth/.test(diag.hop.explain()),
    diag.hop.explain());
  check("explain(incident) for a lift-off", /begin_fall/.test(diag.hop.explain(diag.hop.tail(3)[0])) && /lost the ground/.test(diag.hop.explain(diag.hop.tail(3)[0])));
  check("explain() of an incident without a cause (older wasm)",
    /pop \(unknown\)/.test(diag.hop.explain(incident(9, "pop", { cause: undefined }))));
  check("every kind the Rust side emits has an explanation",
    ["liftOff", "bounceLiftOff", "pop"].every((k) => typeof HOP_KINDS[k] === "string"));
  check("every cause the Rust side emits has an explanation",
    ["unknown", "noTerrain", "leftGround", "bounce", "wade", "resurface", "object", "unexplained"]
      .every((c) => typeof HOP_CAUSES[c] === "string"));
  check("clear() forwards to the wasm", diag.hop.clear() === true && cleared === 1);
  check("after clear the ring is empty", diag.hop.count() === 0 && diag.hop.tail().length === 0 && diag.hop.last() === null);
}

// ── parsing edge cases ──
{
  check("readHopRing: bad JSON is null", readHopRing({ hopDiag: () => "{not json" }) === null);
  check("readHopRing: missing incidents is null", readHopRing({ hopDiag: () => "{\"count\":1}" }) === null);
  check("readHopRing: throwing export is null", readHopRing({ hopDiag: () => { throw new Error("x"); } }) === null);
  check("compactHop(null) is null", compactHop(null) === null);
}

// ── a wasm with only some of the exports (stale pkg/ mid-upgrade) ──
{
  window.__hbWasm = { hopDiag: () => JSON.stringify({ count: 1, incidents: [incident(1, "pop")] }) };
  const diag = {};
  attachHop(diag);
  check("partial exports: the ring still reads", diag.hop.available() === true && diag.hop.tail(1).length === 1);
  check("partial exports: count() is null without hopDiagCount", diag.hop.count() === null);
  check("partial exports: clear() is false without hopDiagClear", diag.hop.clear() === false);
}

// ── wiring, by source text ──
{
  const indexSrc = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  for (const name of ["hopDiag", "hopDiagCount", "hopDiagClear"]) {
    check(
      `index.html exposes ${name}, typeof-guarded on its own against a stale pkg/`,
      new RegExp(`typeof __hbWasmNs\\?\\.${name} === "function"\\s*\\?\\s*\\{ ${name}: \\(\\) => __hbWasmNs\\.${name}\\(\\)`).test(indexSrc),
    );
  }
  const diagSrc = fs.readFileSync(path.join(APP, "scene3d/diag.js"), "utf8");
  check(
    "scene3d/diag.js imports and registers the hop surface",
    /import \{ attachHop as _attachHop \} from "\.\/diag\/hop\.js";/.test(diagSrc) &&
      /\["hop",\s*_attachHop\]/.test(diagSrc),
  );
  const rs = fs.readFileSync(path.join(APP, "src/lib.rs"), "utf8");
  for (const [js, rust] of [["hopDiag", "hop_diag"], ["hopDiagCount", "hop_diag_count"], ["hopDiagClear", "hop_diag_clear"]]) {
    check(
      `src/lib.rs exports ${js} via #[wasm_bindgen]`,
      new RegExp(`#\\[wasm_bindgen\\(js_name = ${js}\\)\\]\\s*\\npub fn ${rust}\\(`).test(rs),
    );
  }
}

console.log(`\nhop_diag: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
