// harness/test_pipeline_flags.mjs — scene3d/pipeline_flags.js: the re-engineered pipeline's
// stage flags behind ONE shared default (`PIPELINE_DEFAULT_ON`) and their kill cascade.
//
// Every grammar / cascade check runs under BOTH polarities (the reader's `defaultOn` argument),
// so the day the chain flips is one constant, not a test rewrite; one check pins what the
// constant is today.
//
//   PART 1 — grammar per polarity: default-on reads ON unless off / 0 / false / no; default-off
//            (DEV) reads ON only for on / 1 / true / yes; an unknown stage name throws.
//   PART 2 — cascade: packSource cuts every dependent; geomBundles cuts reliefBundles and
//            drawPools; texCompressedOnly / slotGrid cut drawPools only; frameWork is
//            independent; drawPools cuts nothing else.
//   PART 3 — no page, no pipeline; the omitted search reads window.location.search.
//   PART 4 — conflicts are reported only for an EXPLICIT `=on` stage whose prerequisite is off.
//   PART 5 — the slot grid's ring veto, and its agreement with residency.js.
//
// Run:  node harness/test_pipeline_flags.mjs        (exit 0/1)

import {
  PIPELINE_DEFAULT_ON,
  PIPELINE_PREREQS,
  PIPELINE_STAGES,
  pipelineFlagIsOff,
  pipelineOwnFlagOn,
  pipelineStageEnabled,
  pipelinePrereqConflicts,
  pipelineRingRadius,
  SLOT_GRID_RING_RADIUS,
} from "../scene3d/pipeline_flags.js";
import { R_LB } from "../scene3d/residency_grid.js";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

const ALL_ON = "?packSource=on&geomBundles=on&reliefBundles=on&texCompressedOnly=on&slotGrid=on&frameWork=on&drawPools=on";
const onSet = (search, d) => PIPELINE_STAGES.filter((s) => pipelineStageEnabled(s, search, d)).join(",");
const E = (stage, search, d) => pipelineStageEnabled(stage, search, d);

console.log(`PART 0: the shared default is ${PIPELINE_DEFAULT_ON ? "ON" : "OFF"} today`);
{
  check(typeof PIPELINE_DEFAULT_ON === "boolean", "PIPELINE_DEFAULT_ON is a boolean");
  // 2026-10-25: owner "Hold until parity" after the first 1070 A/B (chain −8 to −11 % fps); the
  // fixes brought it to parity the same day and the chain shipped ON. Change this pin together
  // with the constant and the url-flags rows.
  check(PIPELINE_DEFAULT_ON === true, "DEFAULT-ON since the chain reached parity (2026-10-25)");
  check(E("packSource", "") === E("packSource", "", PIPELINE_DEFAULT_ON), "the omitted defaultOn IS PIPELINE_DEFAULT_ON");
  check(PIPELINE_STAGES.join(",") === "packSource,geomBundles,reliefBundles,texCompressedOnly,slotGrid,frameWork,drawPools",
    `stage list (got ${PIPELINE_STAGES.join(",")})`);
}

for (const d of [true, false]) {
  const tag = d ? "[default-on]" : "[default-off]";
  console.log(`PART 1: grammar ${tag}`);
  {
    check(PIPELINE_STAGES.every((s) => E(s, "", d) === d), `${tag} absent: every stage reads ${d}`);
    check(PIPELINE_STAGES.every((s) => E(s, ALL_ON, d) === true), `${tag} every stage explicitly on: ON`);
    for (const v of ["on", "1", "true", "yes", "ON", "True"]) {
      check(E("drawPools", ALL_ON.replace("drawPools=on", `drawPools=${v}`), d) === true, `${tag} drawPools=${v} reads ON`);
    }
    for (const v of ["off", "0", "false", "no", "OFF", "No"]) {
      check(pipelineFlagIsOff(v) === true, `${v} is an off spelling`);
      check(E("drawPools", ALL_ON.replace("drawPools=on", `drawPools=${v}`), d) === false, `${tag} drawPools=${v} reads OFF`);
    }
    for (const v of ["banana", ""]) {
      check(E("drawPools", ALL_ON.replace("drawPools=on", `drawPools=${v}`), d) === d, `${tag} drawPools=${JSON.stringify(v)} follows the default`);
    }
    check(pipelineOwnFlagOn("geomBundles", "?packSource=off", d) === d, `${tag} own flag ignores the cascade`);
    check(pipelineOwnFlagOn("geomBundles", "?geomBundles=on", d) === true, `${tag} own flag: explicit on`);
    check(pipelineOwnFlagOn("geomBundles", "?geomBundles=off", d) === false, `${tag} own flag: explicit off`);
  }
  console.log(`PART 2: cascade ${tag}`);
  {
    const cut = (flag) => ALL_ON.replace(`${flag}=on`, `${flag}=off`);
    check(onSet(cut("packSource"), d) === "frameWork", `${tag} packSource off leaves only frameWork (got ${onSet(cut("packSource"), d)})`);
    check(onSet(cut("geomBundles"), d) === "packSource,texCompressedOnly,slotGrid,frameWork", `${tag} geomBundles off cuts reliefBundles + drawPools`);
    check(onSet(cut("reliefBundles"), d) === "packSource,geomBundles,texCompressedOnly,slotGrid,frameWork,drawPools", `${tag} reliefBundles off cuts only itself`);
    check(onSet(cut("texCompressedOnly"), d) === "packSource,geomBundles,reliefBundles,slotGrid,frameWork", `${tag} texCompressedOnly off cuts drawPools`);
    check(onSet(cut("slotGrid"), d) === "packSource,geomBundles,reliefBundles,texCompressedOnly,frameWork", `${tag} slotGrid off cuts drawPools`);
    check(onSet(cut("frameWork"), d) === "packSource,geomBundles,reliefBundles,texCompressedOnly,slotGrid,drawPools", `${tag} frameWork off cuts only itself`);
    check(onSet(cut("drawPools"), d) === "packSource,geomBundles,reliefBundles,texCompressedOnly,slotGrid,frameWork", `${tag} drawPools off cuts only itself`);
    for (const [stage, pre] of Object.entries(PIPELINE_PREREQS)) {
      for (const p of pre) check(E(stage, cut(p), d) === false, `${tag} ${stage} needs ${p}`);
    }
  }
}
{
  let threw = false;
  try { pipelineStageEnabled("drawpools", ""); } catch (_) { threw = true; }
  check(threw, "unknown stage (case typo) throws instead of reading ON");
  check(E("drawPools", "?drawPools=on", false) === true,
    "[default-off] a bare opt-in reads ON as the old exact-match reader did — completeness stays with checkDrawPoolsPrereqs");
  check(E("drawPools", "?drawPools=on&packSource=off", false) === false, "[default-off] an EXPLICIT prerequisite escape still cuts");
  check(E("texCompressedOnly", "?texCompressedOnly=on", false) === true, "[default-off] ?texCompressedOnly=on alone reads ON (the controller leg gates it)");
  check(E("drawPools", "?drawPools=on", true) === true, "[default-on] the same url arms (prerequisites default on)");
  check(E("drawPools", "?drawPools=on&slotGrid=0", true) === false, "[default-on] …and a cut prerequisite takes it down");
}

console.log("PART 3: no page");
{
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const saved = globalThis.window;
  delete globalThis.window;
  check(PIPELINE_STAGES.every((s) => E(s, undefined, true) === false && E(s, undefined, false) === false),
    "no window, no search: every stage OFF under both polarities");
  check(E("packSource", "", true) === true, "no window but an explicit page search: the default applies");
  globalThis.window = { location: { search: "?packSource=off" } };
  check(E("packSource", undefined, true) === false && E("frameWork", undefined, true) === true,
    "omitted search reads window.location.search");
  globalThis.window = { location: { search: ALL_ON } };
  check(PIPELINE_STAGES.every((s) => E(s, undefined, false) === true), "a page with every stage on: ON (default-off)");
  if (hadWindow) globalThis.window = saved; else delete globalThis.window;
}

console.log("PART 4: conflicts");
{
  for (const d of [true, false]) {
    const tag = d ? "[default-on]" : "[default-off]";
    check(pipelinePrereqConflicts("slotGrid", "?packSource=off", d).length === 0, `${tag} a dependent that is not explicitly on: quiet`);
    check(pipelinePrereqConflicts("slotGrid", "?packSource=off&slotGrid=on", d).join(",") === "packSource",
      `${tag} explicit slotGrid=on with packSource off: named`);
    check(pipelinePrereqConflicts("drawPools", `${ALL_ON}&geomBundles=off&texCompressedOnly=0`.replace("geomBundles=on&", "").replace("texCompressedOnly=on&", ""), d).join(",") === "geomBundles,texCompressedOnly",
      `${tag} explicit drawPools=on names each cut prerequisite in order`);
    check(pipelinePrereqConflicts("drawPools", ALL_ON, d).length === 0, `${tag} explicit on with every prerequisite on: no conflict`);
    check(pipelinePrereqConflicts("frameWork", "?frameWork=on&packSource=off", d).length === 0, `${tag} frameWork has no prerequisites`);
  }
  check(pipelinePrereqConflicts("drawPools", "?drawPools=on", false).join(",") === "slotGrid,packSource,geomBundles,texCompressedOnly",
    "[default-off] a bare opt-in names every missing prerequisite (the old loud DISARM)");
  check(pipelinePrereqConflicts("drawPools", "?drawPools=on", true).length === 0,
    "[default-on] the same url conflicts with nothing");
}

console.log("PART 5: the slot grid's ring veto");
{
  for (const d of [true, false]) {
    const tag = d ? "[default-on]" : "[default-off]";
    check(E("slotGrid", `${ALL_ON}&agentic=low`, d) === false, `${tag} agentic=low (radius 1) keeps the legacy residency`);
    check(E("drawPools", `${ALL_ON}&agentic=low`, d) === false, `${tag} …and the pools stand down with the grid`);
    check(E("packSource", `${ALL_ON}&agentic=low`, d) === true && E("texCompressedOnly", `${ALL_ON}&agentic=low`, d) === true,
      `${tag} …while packs and compressed textures stay on`);
    check(E("slotGrid", `${ALL_ON}&pvsRingRadius=3`, d) === false, `${tag} pvsRingRadius=3 vetoes the grid`);
    check(E("slotGrid", `${ALL_ON}&pvsRingRadius=8`, d) === false, `${tag} pvsRingRadius=8 vetoes the grid`);
    check(E("slotGrid", `${ALL_ON}&pvsRingRadius=5`, d) === true, `${tag} pvsRingRadius=5 is the grid's own ring`);
    check(E("slotGrid", `${ALL_ON}&agentic=low&pvsRingRadius=5`, d) === true, `${tag} an explicit radius 5 wins over agentic=low`);
    check(E("slotGrid", `${ALL_ON}&pvsRingRadius=99`, d) === true, `${tag} an out-of-range radius falls back to 5 (residency.js grammar)`);
  }
  // The duplicated parse must agree with residency.js derivePvsRingRadius (one module instance per case).
  const cases = ["", "?agentic=low", "?pvsRingRadius=0", "?pvsRingRadius=1", "?pvsRingRadius=5", "?pvsRingRadius=12",
    "?pvsRingRadius=13", "?pvsRingRadius=-1", "?pvsRingRadius=abc", "?agentic=low&pvsRingRadius=7", "?agentic=high"];
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const saved = globalThis.window;
  for (let i = 0; i < cases.length; i++) {
    globalThis.window = { location: { search: cases[i] } };
    const mod = await import(new URL(`../scene3d/residency.js?pf=${i}`, import.meta.url).href);
    const mine = pipelineRingRadius(new URLSearchParams(cases[i]));
    check(mod.PVS_RING_RADIUS === mine, `ring radius agrees with residency.js for ${JSON.stringify(cases[i])} (${mod.PVS_RING_RADIUS} vs ${mine})`);
  }
  if (hadWindow) globalThis.window = saved; else delete globalThis.window;
  check(SLOT_GRID_RING_RADIUS === R_LB, `the veto's ring equals residency_grid.js R_LB (${R_LB})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "PIPELINE-FLAGS ✅" : "PIPELINE-FLAGS ❌");
process.exit(failed === 0 ? 0 : 1);
