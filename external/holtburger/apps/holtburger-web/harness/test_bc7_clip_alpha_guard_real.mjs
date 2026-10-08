// harness/test_bc7_clip_alpha_guard_real.mjs — the CLIP-ALPHA guard against
// REAL data: the retail portal DAT for the albedo truth and the served dist's
// actual tex-xu7 / tex-bc7 / tex-bc7-pre records, transcoded by the vendored
// basisu transcoder exactly as the client does.
//
// The reported defect, end to end: reed clumps (Surface 0x080000A1 ->
// SurfaceTexture 0x0500127E -> RenderSurface 0x0600385A, PFID_INDEX16 128x128,
// Base1ClipMap) rendered as opaque black quads on the 1070. The retail albedo
// clears 9,516 of 16,384 texels (palette index < 8, acclient.c:365907); the
// served tex-xu7 record never drops below alpha 240, so it passes the 100/255
// alpha test everywhere. The tex-bc7 twin keeps the cutout (16 x 9,516 texels
// under the test at 4x) and is what the guard swaps in instead.
//
// Synthetic mechanics live in test_bc7_clip_alpha_guard.mjs; this suite is
// registered with a `requires` on both fixtures (NO-FIXTURE where absent).
// Override the paths with HB_PORTAL_DAT / HB_CLIP_DIST.
//
// Run:  cd apps/holtburger-web && node harness/test_bc7_clip_alpha_guard_real.mjs

import fs from "node:fs";
import * as THREE from "three";
import {
  bc7AlphaFloor,
  bc7ClipAlphaGateFor,
  clipAlphaGuardStats,
  initBc7Source,
  upgradeMaterialToBc7,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  registerAtlasRefeed,
} from "../scene3d/bc7_textures.js";
import { MaterialCache } from "../scene3d/materials.js";
import {
  openPortalDat,
  openDistRecords,
  surfaceAlphaFacts,
  parsePayload,
  loadXu7Transcoder,
} from "../tools/clip-alpha-gate.mjs";

export const PORTAL_DAT = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
export const CLIP_DIST = process.env.HB_CLIP_DIST || "/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

for (const p of [PORTAL_DAT, `${CLIP_DIST}/manifest/holtburger-tex-xu7.bin`]) {
  if (!fs.existsSync(p)) {
    console.error(`FAIL: fixture missing: ${p} (external mount? set HB_PORTAL_DAT / HB_CLIP_DIST)`);
    process.exit(1);
  }
}

const REEDS = 0x080000a1;
const REEDS_RS = 0x0600385a;
const GRASS = 0x0800007d; // the grass tuft beside them in the screenshot (DXT5, renders right)
const GRASS_RS = 0x06003808;
const OPAQUE_CLIP = 0x08000078; // a Base1ClipMap INDEX16 surface with no index < 8 texel
const OPAQUE_CLIP_RS = 0x060037ff;

const dat = openPortalDat(PORTAL_DAT);
const read = (id) => dat.read(id);
const dist = openDistRecords(CLIP_DIST);
const lane = (ns) => (id) => {
  try {
    return dist.read(ns, id) || new Uint8Array(0);
  } catch (_) {
    return new Uint8Array(0);
  }
};

globalThis.window = { location: { search: "?xu7Budget=off&texWorkers=off" } };
const xu7 = await loadXu7Transcoder();
const basisModule = await xu7.xu7Transcoder();

// ===========================================================================
console.log("PART 1 — DAT truth (retail portal DAT, client decode rules)");
// ===========================================================================
const reeds = surfaceAlphaFacts(read, REEDS);
check("0x080000A1 is a pure Base1ClipMap over rs 0x0600385A",
  reeds && reeds.type === 0x4 && reeds.rs === REEDS_RS, JSON.stringify(reeds && { type: reeds.type, rs: reeds.rs }));
check("rs 0x0600385A is PFID_INDEX16 128x128 (paletted -> 100/255 alpha-test cut)",
  reeds && reeds.fmt === "INDEX16" && reeds.w === 128 && reeds.h === 128 && reeds.hasPalette && reeds.cut === 100);
// 9,516 = the bug2-clipmap-agent affected-rows count for this row, and the
// alpha-0 count of the corrected export /mnt/wbterminal2/tex-reexport-2026-07-30.
check("retail key clears exactly 9,516 of 16,384 texels (palette index < 8)", reeds && reeds.below === 9516, String(reeds && reeds.below));
const grass = surfaceAlphaFacts(read, GRASS);
check("grass tuft 0x0800007D: Base1ClipMap DXT5 256x256 over rs 0x06003808, keyed at the 200/255 cut",
  grass && grass.rs === GRASS_RS && grass.fmt === "DXT5" && grass.w === 256 && grass.cut === 200 && grass.keyed);
const opq = surfaceAlphaFacts(read, OPAQUE_CLIP);
check("control 0x08000078: ClipMap INDEX16 with NO texel under its cut",
  opq && opq.rs === OPAQUE_CLIP_RS && opq.clip && !opq.keyed);

// ===========================================================================
console.log("PART 2 — the served payloads (alpha floor = exact lower bound)");
// ===========================================================================
const xu7Reeds = await parsePayload(lane("holtburger/tex-xu7")(REEDS_RS), "xu7");
const bc7Reeds = await parsePayload(lane("holtburger/tex-bc7")(REEDS_RS), "hbc7");
const preReeds = await parsePayload(lane("holtburger/tex-bc7-pre")(REEDS_RS), "hbc7");
check("tex-xu7 0x0600385A: 512x512, alpha floor 240 — cannot drop a texel under 100 (THE BUG)",
  xu7Reeds && xu7Reeds.width === 512 && bc7AlphaFloor(xu7Reeds) === 240, String(xu7Reeds && bc7AlphaFloor(xu7Reeds)));
check("tex-bc7 twin 0x0600385A: 512x512, alpha floor 0 — keeps the cutout",
  bc7Reeds && bc7Reeds.width === 512 && bc7AlphaFloor(bc7Reeds) === 0);
check("tex-bc7-pre 0x0600385A: 128x128, alpha floor 0", preReeds && preReeds.width === 128 && bc7AlphaFloor(preReeds) === 0);
const xu7Grass = await parsePayload(lane("holtburger/tex-xu7")(GRASS_RS), "xu7");
check("tex-xu7 grass 0x06003808: alpha floor 0 (why the tuft renders right)", xu7Grass && bc7AlphaFloor(xu7Grass) === 0);

// ===========================================================================
console.log("PART 3 — end to end through MaterialCache, production record source");
// ===========================================================================
async function armSource(search) {
  _resetBc7ForTest();
  globalThis.window.location = { search: `?xu7Budget=off&texWorkers=off${search ? "&" + search : ""}` };
  // `texXu7Enabled()` memoises its first answer; re-read it per arm and hand
  // the already-initialised transcoder back (ensureXu7Transcoder -> ready).
  xu7._resetXu7ForTest();
  xu7._setXu7ModuleForTest(basisModule);
  await xu7.xu7Transcoder();
  _setBc7SupportForTest(true);
  initBc7Source({
    wasmExports: {
      xu7_blocks: lane("holtburger/tex-xu7"),
      bc7_blocks: lane("holtburger/tex-bc7"),
      bc7_pre_blocks: lane("holtburger/tex-bc7-pre"),
    },
  });
  registerAtlasRefeed(null);
}
/** The material `_materialFromFlags` builds for a pure ClipMap: alpha test at
 *  the per-format ref; map = an RGBA8 DataTexture carrying the DAT alpha. */
function materialFor(facts) {
  const px = new Uint8Array(facts.w * facts.h * 4);
  for (let i = 0; i < facts.w * facts.h; i += 1) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 128;
    px[i * 4 + 3] = facts.alpha[i];
  }
  const tex = new THREE.DataTexture(px, facts.w, facts.h, THREE.RGBAFormat);
  const mat = new THREE.MeshStandardMaterial({ alphaTest: facts.cut / 255, transparent: false });
  mat.map = tex;
  mat.userData = { surfaceTypeFlags: facts.type };
  return mat;
}
async function settled(mat) {
  for (let i = 0; i < 400; i += 1) {
    const ud = mat.userData || {};
    if (!ud.__bc7Pending && (ud.__bc7 || ud.__bc7Vetoed)) return true;
    await tick(10);
  }
  return false;
}
const mapFloor = (m) => (m && m.isCompressedTexture ? bc7AlphaFloor({ levels: m.mipmaps }) : null);

let warns = [];
const realWarn = console.warn;
console.warn = (...a) => {
  const s = a.join(" ");
  if (s.includes("[materials/bc7] refused")) warns.push(s);
  else realWarn(...a);
};

{
  await armSource("");
  const mc = new MaterialCache();
  const mat = materialFor(reeds);
  mc.materials.set(REEDS, mat);
  mc._maybeUpgradeToBc7(REEDS, mat, REEDS_RS);
  check("default arm: verdict settles", await settled(mat));
  const s = globalThis.window.__bc7ClipGuard.surface(REEDS);
  check("default arm: the xu7 record was REFUSED (floor 240 >= cut 100)",
    s && s.checks.some((c) => c.lane === "xu7" && !c.admitted && c.floor === 240), JSON.stringify(s && s.checks));
  check("default arm: the tex-bc7 twin was swapped in instead (512x512, floor 0)",
    s && s.verdict === "swapped" && mat.map.isCompressedTexture && mat.map.image.width === 512 && mapFloor(mat.map) === 0,
    JSON.stringify(s && s.map));
  check("default arm: nothing pending, __bc7 stamped", mat.userData.__bc7Pending === undefined && mat.userData.__bc7 === true);
  check("default arm: one console line naming 0x080000A1", warns.length === 1 && warns[0].includes("0x080000A1"), warns.join(" | "));
  check("stats: one rescue", clipAlphaGuardStats().hbc7Rescued === 1 && clipAlphaGuardStats().keptAlbedo === 0);
}
{
  await armSource("bc7ClipAlphaGuard=off");
  warns = [];
  const mc = new MaterialCache();
  const mat = materialFor(reeds);
  mc.materials.set(REEDS, mat);
  mc._maybeUpgradeToBc7(REEDS, mat, REEDS_RS);
  check("=off arm: verdict settles", await settled(mat));
  check("=off arm: the opaque xu7 record is swapped in — the reported black quad, restored on purpose",
    mat.map.isCompressedTexture && mat.map.image.width === 512 && mapFloor(mat.map) === 240, String(mapFloor(mat.map)));
  check("=off arm: guard silent", warns.length === 0 && globalThis.window.__bc7ClipGuard.surface(REEDS) === null);
}
{
  await armSource("texXu7=off");
  const mat = materialFor(reeds);
  const r = await upgradeMaterialToBc7(mat, REEDS_RS, null, { gate: bc7ClipAlphaGateFor(mat, REEDS_RS, REEDS) });
  check("?texXu7=off (owner's immediate workaround): tex-bc7 admitted directly, no fallback",
    r && r.swapped === true && mapFloor(mat.map) === 0 && clipAlphaGuardStats().hbc7Fallbacks === 0);
}
{
  await armSource("");
  const mat = materialFor(grass);
  const r = await upgradeMaterialToBc7(mat, GRASS_RS, null, { gate: bc7ClipAlphaGateFor(mat, GRASS_RS, GRASS) });
  check("grass tuft: BC7 with alpha is admitted (no veto when the payload carries the cutout)",
    r && r.swapped === true && mapFloor(mat.map) === 0 && clipAlphaGuardStats().vetoedFull === 0);
}
{
  await armSource("");
  const mat = materialFor(opq);
  const gate = bc7ClipAlphaGateFor(mat, OPAQUE_CLIP_RS, OPAQUE_CLIP);
  check("opaque ClipMap albedo: no gate (opaque BC7 over opaque RGBA8 is fine)", gate === null);
  const r = await upgradeMaterialToBc7(mat, OPAQUE_CLIP_RS, null, gate ? { gate } : undefined);
  check("…and its (opaque, floor >= 240) xu7 record swaps in normally",
    r && r.swapped === true && mapFloor(mat.map) >= 240);
}

console.warn = realWarn;
_resetBc7ForTest();
dat.close();
console.log(`\nbc7 clip-alpha guard (real data): ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "BC7-CLIP-ALPHA-GUARD-REAL ✅" : "BC7-CLIP-ALPHA-GUARD-REAL ❌");
process.exit(failed === 0 ? 0 : 1);
