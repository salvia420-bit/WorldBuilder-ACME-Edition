// tests/selection_brackets_display_option.test.mjs — hud-ui-6 / charopt-5
// (2026-10-13): the VividTargetingIndicator character option (0x0E) gates the
// target brackets AND the off-screen arrow, as in retail.
//
// Retail `VividTargetIndicator::OnDraw` (acclient.c:289780) hides
// m_pOnScreen + m_pOffScreen and returns unless `m_bDisplayOn`;
// `UpdateDisplayState` (:289556), `RecvNotice_PlayerDescReceived` (:289580)
// and `RecvNotice_PlayerOptionChanged` (`i_eOption == 14`, :289604) set it from
// `PlayerModule::VividTargetingIndicator()`. Default ON (0x50C4A54A).
// Pins:
//   • `?vtiOptionGate` reader (off/0/false disable; anything else ON);
//   • setDisplayOn(false) + tick → all four corners and the arrow hidden, for
//     both the on-screen (status 1) and the off-screen (status 2) paths;
//     setDisplayOn(true) + tick → drawn again;
//   • the option poll: null (no session / stale pkg / throw) reads ON, a false
//     0x0E read hides, it is throttled to 250 ms, and it only acts on a CHANGE
//     (retail reacts to the notice, not every frame);
//   • Options → Character → Interface offers "Vivid targeting indicator"
//     (0x0E), reflects the server bit, and unticking it sends (0x0E, false)
//     and hides the brackets on the next poll;
//   • the stale `scene3d/target_ring.js` comment is gone.
//
// Run from apps/holtburger-web/:
//   node tests/selection_brackets_display_option.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { installFakeDom } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VTI = 0x0E;

const sb = await import("../scene3d/selection_brackets.js");
const { CHARACTER_OPTION } = await import("../ui/ac_character_options.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.stack || err.message}`); }
}

// ── fixtures ─────────────────────────────────────────────────────────────
const W = 800;
const H = 600;
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
camera.position.set(0, 0, 0); // looks down −Z
camera.updateMatrixWorld(true);

function makeLayer() {
  const domRoot = document.createElement("div");
  document.body.appendChild(domRoot);
  const layer = new sb.SelectionBracketLayer(domRoot, { clientWidth: W, clientHeight: H });
  return layer;
}
function rigAt(x, y, z) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.updateMatrixWorld(true);
  return o;
}
const SPHERE = () => ({ offset: new THREE.Vector3(0, 0, 0), radius: 1 });
const corners = (l) => [l._tl, l._tr, l._bl, l._br];
const shown = (el) => el.style.display === "block";
const allHidden = (l) => [...corners(l), l._arrow].every((el) => el.style.display === "none");

/** Force the next tick to re-read the option (skip the 250 ms throttle). */
const repoll = (l) => { l._displayOptAt = -Infinity; };

console.log("── hud-ui-6: VividTargetingIndicator (0x0E) gates the target indicator ──");

check("CHARACTER_OPTION.VividTargetingIndicator is the enum index 0x0E", () => {
  assert.equal(CHARACTER_OPTION.VividTargetingIndicator, VTI);
});

check("?vtiOptionGate reader: default ON; off/0/false (any case) disable", () => {
  assert.equal(sb.vtiOptionGateEnabled(""), true);
  assert.equal(sb.vtiOptionGateEnabled(undefined), true);
  assert.equal(sb.vtiOptionGateEnabled("?nosw=1"), true);
  assert.equal(sb.vtiOptionGateEnabled("?vtiOptionGate=on"), true);
  assert.equal(sb.vtiOptionGateEnabled("?vtiOptionGate=1"), true);
  assert.equal(sb.vtiOptionGateEnabled("?vtiOptionGate=off"), false);
  assert.equal(sb.vtiOptionGateEnabled("?vtiOptionGate=OFF"), false);
  assert.equal(sb.vtiOptionGateEnabled("?vtiOptionGate=0"), false);
  assert.equal(sb.vtiOptionGateEnabled("?a=b&vtiOptionGate=false"), false);
});

check("no session handle (pre-login) → option reads ON, on-screen target draws", () => {
  delete globalThis.__sessionHandle;
  const l = makeLayer();
  l.setTarget(0x50000001, rigAt(0, 0, -10), SPHERE());
  l.tick(camera);
  assert.equal(l._displayOn, true);
  assert.equal(l.lastStatus, 1, "status 1 = on-screen rect");
  assert.ok(corners(l).every(shown), "all four corners shown");
  assert.equal(l._arrow.style.display, "none");
});

check("setDisplayOn(false) + tick → corners and arrow all display:none (on-screen)", () => {
  const l = makeLayer();
  l.setTarget(0x50000001, rigAt(0, 0, -10), SPHERE());
  l.tick(camera);
  assert.ok(corners(l).every(shown));
  l.setDisplayOn(false);
  assert.ok(allHidden(l), "hidden at once (UpdateDisplayState)");
  l.tick(camera);
  l.tick(camera);
  assert.ok(allHidden(l), "stays hidden across ticks");
  assert.equal(l.lastStatus, 0);
  assert.equal(l.lastRect, null);
  l.setDisplayOn(true);
  l.tick(camera);
  assert.equal(l.lastStatus, 1);
  assert.ok(corners(l).every(shown), "the still-tracked target draws again");
});

check("setDisplayOn(false) + tick → off-screen arrow hidden too (status-2 path)", () => {
  const l = makeLayer();
  l.setTarget(0x50000002, rigAt(0, 3, 10), SPHERE()); // behind the camera
  l.tick(camera);
  assert.equal(l.lastStatus, 2, "status 2 = off-screen arrow");
  assert.ok(shown(l._arrow));
  assert.ok(corners(l).every((el) => el.style.display === "none"));
  l.setDisplayOn(false);
  l.tick(camera);
  assert.ok(allHidden(l), "arrow hidden with the option off");
  assert.equal(l.lastStatus, 0);
  l.setDisplayOn(true);
  l.tick(camera);
  assert.equal(l.lastStatus, 2);
  assert.ok(shown(l._arrow));
});

check("the poll is edge-triggered: an unchanged ON read does not undo setDisplayOn(false)", () => {
  delete globalThis.__sessionHandle;
  const l = makeLayer();
  l.setTarget(0x50000001, rigAt(0, 0, -10), SPHERE());
  l.setDisplayOn(false);
  repoll(l);
  l.tick(camera);
  assert.ok(allHidden(l));
  assert.equal(l._displayOn, false);
});

const opts = new Map([[VTI, true]]);
const reads = [];
const sent = [];
globalThis.__sessionHandle = {
  isCharacterOptionEnabled: (i) => { reads.push(i >>> 0); return !!opts.get(i >>> 0); },
  setCharacterOption: (i, v) => { sent.push([i >>> 0, !!v]); opts.set(i >>> 0, !!v); },
};

check("a server-side 0x0E=false hides the brackets; flipping it back shows them", () => {
  const l = makeLayer();
  l.setTarget(0x50000001, rigAt(0, 0, -10), SPHERE());
  reads.length = 0;
  l.tick(camera);
  assert.deepEqual(reads, [VTI], "reads CharacterOption 0x0E");
  assert.equal(l.lastStatus, 1);
  opts.set(VTI, false);
  repoll(l);
  l.tick(camera);
  assert.ok(allHidden(l), "option off → nothing drawn");
  assert.equal(l._displayOn, false);
  opts.set(VTI, true);
  repoll(l);
  l.tick(camera);
  assert.equal(l._displayOn, true);
  assert.equal(l.lastStatus, 1);
  assert.ok(corners(l).every(shown));
});

check("the option read is throttled to one per 250 ms", () => {
  const l = makeLayer();
  reads.length = 0;
  l._pollDisplayOption(1000);
  l._pollDisplayOption(1100);
  l._pollDisplayOption(1249);
  assert.equal(reads.length, 1, "one read inside the window");
  l._pollDisplayOption(1250);
  assert.equal(reads.length, 2, "re-read once 250 ms have passed");
});

check("a stale pkg/ (no export) or a throwing export reads as ON", () => {
  const saved = globalThis.__sessionHandle;
  const warn = console.warn;
  try {
    console.warn = () => {};
    const l = makeLayer();
    l.setTarget(0x50000001, rigAt(0, 0, -10), SPHERE());
    globalThis.__sessionHandle = {};
    repoll(l);
    l.tick(camera);
    assert.equal(l._displayOn, true);
    assert.equal(l.lastStatus, 1);
    globalThis.__sessionHandle = { isCharacterOptionEnabled: () => { throw new Error("freed"); } };
    repoll(l);
    l.tick(camera);
    assert.equal(l._displayOn, true);
    assert.equal(l.lastStatus, 1);
  } finally {
    console.warn = warn;
    globalThis.__sessionHandle = saved;
  }
});

check("no target → no option read at all (nothing to gate)", () => {
  const l = makeLayer();
  reads.length = 0;
  l.tick(camera);
  assert.deepEqual(reads, []);
  assert.equal(l.lastStatus, 0);
});

// ── Options → Character → Interface row ──────────────────────────────────
globalThis.__mainPanel = { closeView: () => {} };
const panel = await import("../plugins/options-panel.js");
const host = document.createElement("div");
document.body.appendChild(host);
const cleanup = panel.view.mount(host, { tab: "character" });

function box(label) {
  const lbl = host.querySelectorAll("label").find((x) => x.textContent === label);
  assert.ok(lbl, `row "${label}" rendered`);
  const cb = lbl.parentNode.querySelector("input");
  assert.ok(cb, `checkbox for "${label}"`);
  return cb;
}

check("Options offers \"Vivid targeting indicator\", reflecting the server bit (ON)", () => {
  opts.set(VTI, true);
  const cb = box("Vivid targeting indicator");
  assert.equal(cb.checked, true);
});

check("unticking it sends (0x0E, false) and the brackets hide on the next poll", () => {
  const l = makeLayer();
  l.setTarget(0x50000001, rigAt(0, 0, -10), SPHERE());
  l.tick(camera);
  assert.equal(l.lastStatus, 1);
  sent.length = 0;
  box("Vivid targeting indicator").click();
  assert.deepEqual(sent, [[VTI, false]]);
  repoll(l);
  l.tick(camera);
  assert.ok(allHidden(l));
});

try { cleanup?.(); } catch (_) {}

check("options-panel.js: 0x0E row in the Interface group; stale target_ring.js comment gone", () => {
  const src = readFileSync(path.join(APP, "plugins", "options-panel.js"), "utf8");
  assert.match(src, /\{ idx: 0x0E, label: "Vivid targeting indicator" \}/);
  const iface = src.slice(src.indexOf('section: "Interface"'));
  const end = iface.indexOf("],");
  assert.ok(iface.slice(0, end).includes("idx: 0x0E"), "row sits in the Interface section");
  assert.ok(!src.includes("target_ring.js"), "no reference to the nonexistent target_ring.js");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
