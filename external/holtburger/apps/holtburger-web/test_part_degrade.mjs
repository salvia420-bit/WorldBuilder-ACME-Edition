// 2026-10-06 — `?partDegrade` (scene3d/part_degrade.js): retail per-part GfxObjDegradeInfo pick.
// Chains below are real portal.dat records (WorldBuilder.Terminal chorizite-parse-dat-record,
// 2026-10-06): 0x110006C6 = human male part 0 (GfxObj 0x0100004E), 0x110006C9 = part 3,
// 0x1100002E = the 2.5 cm attachment placeholder 0x010001EC (human Setup parts 17-33).
//
// Run:
//   cd apps/holtburger-web/
//   node test_part_degrade.mjs

import {
  selectDegradeLevel,
  parseDegradeInfo,
  setPartDegradeHidden,
  PartDegrade,
  DEGRADE_DISTANCE,
  partDegradeEnabled,
} from "./scene3d/part_degrade.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const FLT_MAX = 3.4028235e38;
const rec = (id, levels) => JSON.stringify({ id, degrades: levels.map(([gfx_obj_id, degrade_mode, min_dist, ideal_dist, max_dist]) => ({ gfx_obj_id, degrade_mode, min_dist, ideal_dist, max_dist })) });
const HUMAN_PART0 = rec(0x110006c6, [
  [0x01001887, 1, 0, 3, 7], [0x0100004e, 1, 0, 5, 10], [0x010001a2, 1, 3, 7, 18],
  [0x010001a0, 1, 10, 15, 30], [0x010001f1, 5, 84, 84, 84], [0, 1, FLT_MAX, FLT_MAX, FLT_MAX],
]);
const HUMAN_PART3 = rec(0x110006c9, [
  [0x01001889, 1, 0, 3, 6], [0x0100004c, 1, 2, 5, 8], [0x010001ad, 1, 4, 6, 16],
  [0x010001af, 1, 84, 84, 84], [0, 1, FLT_MAX, FLT_MAX, FLT_MAX],
]);
const PLACEHOLDER = rec(0x1100002e, [[0x010001ec, 1, 0, 0, 0], [0, 1, FLT_MAX, FLT_MAX, FLT_MAX]]);

console.log("selectDegradeLevel = acclient.c GfxObjDegradeInfo::get_degrade (deg_mul 0, s_rDegradeDistance 50)");
{
  const L = parseDegradeInfo(HUMAN_PART0);
  check("parse: 6 levels, terminal NULL", L.length === 6 && L[5].gfx === 0 && L[4].mode === 5);
  check("s_rDegradeDistance is retail's 50", DEGRADE_DISTANCE === 50);
  const at = (d) => selectDegradeLevel(L, d);
  check("0 m and 52.9 m -> level 0 (d' < ideal 3)", at(0) === 0 && at(52.9) === 0);
  check("53 m -> level 1", at(53) === 1);
  check("55 / 57 m -> levels 2 / 3", at(55) === 2 && at(57) === 3);
  check("64.9 m -> level 3, 65 m -> level 4", at(64.9) === 3 && at(65) === 4);
  check("133.9 m -> level 4 (drawn)", at(133.9) === 4 && L[at(133.9)].gfx !== 0);
  check("134 m and 5 km -> NULL level (not drawn)", L[at(134)].gfx === 0 && L[at(5000)].gfx === 0);
  check("negative distance uses |d| (retail fabs)", at(-60) === at(60));
  // deg_mul > 0 moves thresholds toward max_dist; < 0 toward min_dist
  check("deg_mul +1: level 0 holds until d' < max 7 (57 m)", selectDegradeLevel(L, 56.9, 1) === 0 && selectDegradeLevel(L, 57, 1) === 1);
  check("deg_mul -1: thresholds fall to min_dist (0, 0, 3, ...) -> level 2 at 0 m", selectDegradeLevel(L, 0, -1) === 2 && selectDegradeLevel(L, 52.9, -1) === 2 && selectDegradeLevel(L, 53, -1) === 3);
}
{
  const L = parseDegradeInfo(HUMAN_PART3);
  check("part 3 chain: NULL from 134 m too", L[selectDegradeLevel(L, 133.9)].gfx !== 0 && L[selectDegradeLevel(L, 134)].gfx === 0);
}
{
  const L = parseDegradeInfo(PLACEHOLDER);
  check("placeholder chain [0x010001EC ideal 0, NULL]: NULL at every distance", [0, 1, 49, 50, 51, 500].every((d) => L[selectDegradeLevel(L, d)].gfx === 0));
}
check("empty / malformed chains", selectDegradeLevel([], 10) === -1 && parseDegradeInfo("{}") === null && parseDegradeInfo("not json") === null && parseDegradeInfo({ degrades: [] }) === null);

console.log("\nmesh hide ownership");
const mesh = (name, visible = true) => ({ isMesh: true, name, visible, userData: {}, matrixWorldNeedsUpdate: false });
{
  const a = mesh("part_0_surface_8000419"), b = mesh("part_0_surface_8000015", false), fx = mesh("particle-x"), item = { isGroup: true, name: "item-root", visible: true, userData: {} };
  const pg = { children: [a, b, fx, item], userData: {} };
  check("hide touches only visible rig meshes", setPartDegradeHidden(pg, true) === 1 && !a.visible && !b.visible && fx.visible && item.visible);
  check("restore brings back only what it hid", setPartDegradeHidden(pg, false) === 1 && a.visible && !b.visible && a.matrixWorldNeedsUpdate === true);
  check("restore twice is a no-op", setPartDegradeHidden(pg, false) === 0);
}

console.log("\nPartDegrade.tick");
{
  const chains = { 0x110006c6: HUMAN_PART0, 0x1100002e: PLACEHOLDER };
  let fetches = 0;
  const pd = new PartDegrade({ fetchInfo: async (did) => { fetches++; return chains[did] ?? "{}"; } });
  const rig = (guid, x, scale = 1) => {
    const p0 = { children: [mesh("part_0_surface_1")], userData: { didDegrade: 0x110006c6 } };
    const p1 = { children: [mesh("part_1_surface_2")], userData: { didDegrade: 0 } };
    const p17 = { children: [mesh("part_17_surface_8000015")], userData: { didDegrade: 0x1100002e } };
    const e = new Array(16).fill(0); e[0] = scale; e[5] = scale; e[10] = scale; e[15] = 1; e[12] = x;
    return { guid, root: { matrixWorld: { elements: e } }, parts: [p0, p1, p17] };
  };
  const near = rig(1, 40), far = rig(2, 200), player = rig(3, 200), big = rig(4, 200, 2);
  const all = [near, far, player, big];
  const cam = { x: 0, y: 0, z: 0 };
  pd.tick(all, cam, 3);
  check("first tick: chains load asynchronously, nothing hidden yet", pd.stats.hiddenParts === 0 && near.parts[0].children[0].visible);
  await new Promise((r) => setTimeout(r, 0));
  pd.tick(all, cam, 3);
  check("each chain fetched once", fetches === 2, `${fetches}`);
  check("near rig (40 m): body part drawn, placeholder hidden", near.parts[0].children[0].visible && !near.parts[2].children[0].visible);
  check("far rig (200 m): body part hidden, chainless part drawn", !far.parts[0].children[0].visible && far.parts[1].children[0].visible);
  check("the player's own parts never degrade", player.parts.every((p) => p.children[0].visible));
  check("scale 2 halves the distance (200 m -> 100 m: drawn)", big.parts[0].children[0].visible);
  check("stats", pd.stats.rigs === 4 && pd.stats.hiddenParts === 4, JSON.stringify(pd.stats));
  far.root.matrixWorld.elements[12] = 30;
  pd.tick(all, cam, 3);
  check("walking back in restores the hidden body part", far.parts[0].children[0].visible && far.parts[0].userData.__degHidden === false);
  const changes = pd.stats.changedMeshes;
  pd.tick(all, cam, 3);
  check("steady state touches no meshes", pd.stats.changedMeshes === changes);
  far.root.matrixWorld.elements[12] = 200;
  pd.tick(all, cam, 3);
  check("(far again: hidden)", !far.parts[0].children[0].visible);
  pd.off = true;
  pd.tick(all, cam, 3);
  check("off: every hidden part is restored", all.every((r) => r.parts[0].children[0].visible) && pd.stats.hiddenParts === 0);
  pd.off = false;
  pd.tick(all, cam, 3);
  check("back on: the far body part hides again", !far.parts[0].children[0].visible);
}

console.log("\nflag");
{
  globalThis.window = { location: { search: "" } };
  check("default OFF (pending the 1070 look check)", partDegradeEnabled() === false);
  window.location.search = "?partDegrade=on";
  check("?partDegrade=on", partDegradeEnabled() === true);
  delete globalThis.window;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
