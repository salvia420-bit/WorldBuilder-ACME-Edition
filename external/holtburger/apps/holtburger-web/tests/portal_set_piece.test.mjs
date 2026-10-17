// ?portalSetPiece (scene3d/vfx/fx_showcase.js, DEFAULT ON, `=off` escape) —
// every portal gets the purple portal's set piece (portal-space disc + ground
// ring), keyed on its SETUP (scene3d/vfx/portal_setups.js, generated from
// client_portal.dat by tools/particle-fx/portal_setups.py), not on the
// ObjectDescriptionFlags PORTAL bit:
//
//   A  the table: every portal kind is in it (disc / coloured / summoned
//      Gateway / pillar / destroyed / dark / static-only), the 22 disguised
//      Portal-weenie Setups are not; centres come from the DAT; the generated
//      module is not stale
//   B  a disguised portal (ODF bit, no portal art) gets nothing — unless a
//      portal swirl really burns there (the old rule, as a fallback)
//   C  a creature wearing a portal Setup (no ODF bit) and a static portal
//      anchor get a piece; a detached anchor is dropped
//   D  the destroyed portal's disc sits at its quad (1.6457 m), never on the
//      ground-level funnel; dead / dark kinds write their mood + intensities
//   E  fades: in over 0.6 s, with distance 48 → 60 m (no pop), out on leaving
//   F  the nearest 8 portals carry a piece; moving re-picks them with fades
//   G  `?portalSetPiece=off` restores the ODF-keyed rule byte for byte
//   H  the shader carries the moods; the flag reader
import * as THREE from "three";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const show = await import("../scene3d/vfx/fx_showcase.js");
const table = await import("../scene3d/vfx/portal_setups.js");
const reg = await import("../scene3d/vfx/portal_registry.js");
const dec = await import("../scene3d/vfx/fx_decals.js");
const dist = await import("../scene3d/vfx/fx_distort.js");
const gen = await import("../scripts/gen-portal-setups.mjs");
const lsfx = await import("../scene3d/vfx/lifestone_fx.js");
lsfx._setLifestoneFxForTest(true);

// ── A — the table ──────────────────────────────────────────────────────────
{
  const T = table.PORTAL_SETUPS;
  const row = (id) => T.get(id >>> 0);
  check("A: 52 portal Setups", T.size === 52, `${T.size}`);
  check("A: the purple town portal is a disc centred on its swirl (part 0 z 1.415 + 0.15)",
    row(0x020001b3)?.kind === "disc" && row(0x020001b3).quadPart === 0 && near(row(0x020001b3).centre[2], 1.565) &&
    row(0x020001b3).swirl === 0x320002cd);
  for (const [name, id] of [["red", 0x020005d5], ["green", 0x020005d3], ["yellow", 0x020005d6], ["orange", 0x020005d4], ["blue", 0x020005d2]]) {
    check(`A: the ${name} portal is a disc at the purple's height`, row(id)?.kind === "disc" && near(row(id).centre[2], 1.565));
  }
  check("A: the summoned Gateway (every summon spell / gem / NPC, wcid 1955) is a white disc",
    row(0x020006f4)?.kind === "disc" && Math.min(...row(0x020006f4).color) > 0.8);
  check("A: the 39 Destroyed Portals are 'dead', centred on their quad (part 8, z 1.6457)",
    row(0x020019e4)?.kind === "dead" && row(0x020019e4).quadPart === 8 && near(row(0x020019e4).centre[2], 1.6457));
  check("A: The Shadows / the Combat Arena are dead rigs too", row(0x02001a7c)?.kind === "dead" && row(0x020018c0)?.kind === "dead");
  check("A: pillar portals centre on the quad, not the ground-level funnel",
    [0x02001206, 0x02001698, 0x02001699, 0x0200169d, 0x0200169e, 0x0200169f].every((id) => row(id)?.kind === "pillar" && near(row(id).centre[2], 1.6457)));
  check("A: the shadow portals are 'dark'", [0x02001582, 0x020018c2, 0x020015a5].every((id) => row(id)?.kind === "dark"));
  check("A: static-only portal-space decorations are in (0x02000C18 green, 0x02000C1B orange, 0x02000C1F white)",
    [0x02000c18, 0x02000c1b, 0x02000c1f].every((id) => row(id)?.kind === "disc"));
  check("A: the low portal-space portals keep their low swirl (z −1 hook → 0.415 m)", near(row(0x02000c49)?.centre[2], 0.415));
  check("A: a two-tone portal takes its outer swirl, not the small heart", row(0x02000ef6)?.swirl === 0x32000734 && row(0x02000ef6).radius > 2);
  const disguised = [0x02000006, 0x02000041, 0x02000183, 0x0200025a, 0x02000638, 0x0200068f, 0x020007ca, 0x020008a2,
    0x02000aad, 0x02000b4f, 0x02000c56, 0x02000da8, 0x02000ead, 0x02000efc, 0x02000f96, 0x02001065, 0x02001144,
    0x02001541, 0x0200164f, 0x02001770, 0x020017b9, 0x02001b41];
  check("A: none of the 22 disguised Portal-weenie Setups is a portal (bookcases, statues, arches, the invisible Great Hall)",
    disguised.every((id) => !T.has(id)), disguised.filter((id) => T.has(id)).map((id) => id.toString(16)).join(" "));
  check("A: every row is well formed", [...T.values()].every((r) =>
    ["disc", "pillar", "dead", "dark"].includes(r.kind) && r.centre.length === 3 && r.radius >= 0.8 && r.radius <= 3.5 &&
    r.color.length === 3 && Math.max(...r.color) === 1));
  const doc = JSON.parse(readFileSync(new URL("../data/portal-setups.json", import.meta.url), "utf8"));
  const mod = readFileSync(new URL("../scene3d/vfx/portal_setups.js", import.meta.url), "utf8");
  check("A: scene3d/vfx/portal_setups.js is not stale (node scripts/gen-portal-setups.mjs)", gen.buildModule(doc) === mod);
}

// ── harness ────────────────────────────────────────────────────────────────
function world() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // worldRoot: AC z-up → THREE y-up
  scene.add(root);
  const statics = new THREE.Group();
  root.add(statics);
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  cam.position.set(0, 2, 0);
  cam.updateMatrixWorld(true);
  const map = new Map();
  const s3d = { entityManager: { entityMap: map }, scene, camera: cam, renderer: { toneMappingExposure: 5 } };
  return { scene, root, statics, cam, map, s3d };
}
function entity(w, guid, setupId, x, y, odf = 0) {
  const inst = { guid, root: new THREE.Group(), meta: { modelId: setupId, objDescFlags: odf } };
  inst.root.position.set(x, y, 0);
  w.root.add(inst.root);
  w.map.set(guid, inst);
  w.scene.updateMatrixWorld(true);
  return inst;
}
const meshOf = (w) => w.scene.children.find((o) => o.userData?.isFxShowcase);
function discs(w) {
  const m = meshOf(w);
  if (!m || !m.visible) return [];
  const a0 = m.geometry.attributes.aS0.array, a1 = m.geometry.attributes.aS1.array;
  const a2 = m.geometry.attributes.aS2.array, a3 = m.geometry.attributes.aS3.array;
  const out = [];
  for (let i = 0; i < m.geometry.instanceCount; i++) {
    if (a0[i * 4 + 3] !== show.FX_SHOWCASE_KIND.disc) continue;
    out.push({ x: a0[i * 4], y: a0[i * 4 + 1], z: a0[i * 4 + 2], fade: a1[i * 4 + 2], inten: a2[i * 4 + 3], mood: a3[i * 4 + 2] });
  }
  return out;
}
const rings = (t) => dec.collectFxDecals(null, [], t).filter((d) => d.persistent);
function settle(w, t0, steps = 4) {
  for (let i = 0; i < steps; i++) show.tickFxShowcase(w.s3d, t0 + i * 250);
  return t0 + (steps - 1) * 250;
}
function reset() {
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();
  dist._resetFxDistortForTest();
  show._setPortalSetPieceForTest(true);
}

// ── B — disguised portals ──────────────────────────────────────────────────
{
  reset();
  const w = world();
  entity(w, 1, 0x02000183, 5, 5, show.ODF_PORTAL); // the Bookcase portal
  entity(w, 2, 0x02001541, -5, 5, show.ODF_PORTAL); // a gauntlet stone arch
  settle(w, 1000);
  check("B: a bookcase / an arch carrying the PORTAL bit grows no disc and no ring", discs(w).length === 0 && rings(1750).length === 0);
  // a non-table Setup WITH a live portal swirl keeps the old rule
  const odd = entity(w, 3, 0x0200dead, 0, 10, show.ODF_PORTAL);
  dist.addFxDistortSource({ kind: 2, strength: 1, radius: 2.5, resolvePosition: (o) => { o.set(0, 1.5, -10); return true; } });
  settle(w, 3000);
  const d = discs(w);
  check("B: an unknown Portal Setup with a live swirl source still gets its disc (centre from the source)",
    d.length === 1 && near(d[0].y, 1.5) && near(d[0].z, -10));
  void odd;
}

// ── C — creature portals and static portal decorations ─────────────────────
{
  reset();
  const w = world();
  entity(w, 10, 0x02001945, 8, 0, 0); // a Mhoire Castle portal: a Creature on a pillar portal Setup
  const anchor = new THREE.Group();
  anchor.position.set(-8, 0, 0);
  w.statics.add(anchor);
  w.scene.updateMatrixWorld(true);
  check("C: a static portal anchor registers (and a non-portal Setup does not)",
    reg.registerStaticPortalAnchor(anchor, 0x02000c18) && !reg.registerStaticPortalAnchor(new THREE.Group(), 0x02000183));
  settle(w, 1000);
  const d = discs(w);
  check("C: the creature portal and the static decoration both get a disc", d.length === 2, `${d.length}`);
  check("C: ...and a ring each", rings(1750).length === 2);
  const st = d.find((x) => x.x < 0);
  check("C: the static disc sits at its swirl (1.565 m above the anchor)", st && near(st.y, 1.565));
  w.statics.remove(anchor);
  settle(w, 3000);
  settle(w, 4000);
  check("C: an evicted (detached) anchor is dropped and fades out", discs(w).length === 1 && !reg.staticPortalAnchors().has(anchor));
}

// ── D — the destroyed portal and the moods ─────────────────────────────────
{
  reset();
  const w = world();
  entity(w, 20, 0x020019e4, 0, 10, show.ODF_PORTAL); // a Destroyed Portal
  entity(w, 21, 0x020018c2, 10, 10, 0); // a shadow portal static-style setup on an entity
  entity(w, 22, 0x020001b3, -10, 10, show.ODF_PORTAL); // purple
  // the destroyed rig's ground-level funnel registers FIRST — the old centre
  dist.addFxDistortSource({ kind: 2, strength: 0.875, radius: 1.07, resolvePosition: (o) => { o.set(0, 0.0, -10); return true; } });
  settle(w, 1000);
  const d = discs(w);
  const dead = d.find((x) => near(x.x, 0)), dark = d.find((x) => near(x.x, 10)), live = d.find((x) => near(x.x, -10));
  check("D: the destroyed portal's disc is at its quad (1.6457 m), not on the ground funnel", dead && near(dead.y, 1.6457), dead && `${dead.y}`);
  check("D: dead mood 1, disc at 0.6 of a live portal's (k 1 purple)", dead && dead.mood === 1 && near(dead.inten, 0.9 * 0.6));
  check("D: dark mood 2, half intensity", dark && dark.mood === 2 && near(dark.inten, 0.9 * 0.5 * show.portalLumScale(table.PORTAL_SETUPS.get(0x020018c2).color)));
  check("D: the purple disc is live (mood 0, 0.9)", live && live.mood === 0 && near(live.inten, 0.9));
  const r = rings(1750);
  const ringAt = (x) => r.find((q) => near(q.x, x));
  check("D: the dead ring is faint (0.35 of a live one), the live ring full", near(ringAt(0)?.intensity, 0.9 * 0.35) && near(ringAt(-10)?.intensity, 0.9));
}

// ── E — fades ──────────────────────────────────────────────────────────────
{
  reset();
  const w = world();
  entity(w, 30, 0x020001b3, 0, 20, show.ODF_PORTAL);
  show.tickFxShowcase(w.s3d, 1000);
  check("E: a new piece starts at fade 0 (no pop in)", discs(w)[0]?.fade === 0);
  show.tickFxShowcase(w.s3d, 1150);
  const f1 = discs(w)[0]?.fade;
  check("E: ...and fades in over 0.6 s", f1 > 0.2 && f1 < 0.3, `${f1}`);
  const t = settle(w, 1300);
  check("E: ...to 1", discs(w)[0]?.fade === 1);
  check("E: the distance fade: 1 inside 48 m, ~0.5 at 54 m, 0 at 60 m",
    show.portalDistanceFade(10) === 1 && near(show.portalDistanceFade(54), 0.5, 1e-6) && show.portalDistanceFade(60) === 0);
  // walk away: 50 m → 58 m → 70 m
  for (const [y, lo, hi] of [[50, 0.9, 1.0], [58, 0.0, 0.1]]) {
    w.cam.position.set(0, 2, -20 + y); // the portal is at THREE z −20
    w.cam.updateMatrixWorld(true);
    show.tickFxShowcase(w.s3d, t + 600);
    const f = discs(w)[0]?.fade;
    check(`E: at ${y} m from the camera the disc fades smoothly (${lo}..${hi})`, f >= lo && f <= hi, `${f}`);
  }
  w.cam.position.set(0, 2, -20 + 70);
  w.cam.updateMatrixWorld(true);
  settle(w, t + 2000, 6);
  check("E: past 66 m the piece leaves (faded out, ring released)", discs(w).length === 0 && rings(t + 4000).length === 0);
}

// ── F — the nearest 8 ──────────────────────────────────────────────────────
{
  reset();
  const w = world();
  for (let i = 0; i < 12; i++) entity(w, 100 + i, 0x020005d5, 3 * i, 0, show.ODF_PORTAL); // a row of red portals
  settle(w, 1000);
  let d = discs(w);
  check("F: at most 8 portals carry a piece", d.length === 8, `${d.length}`);
  check("F: the nearest 8 (x 0..21)", d.every((x) => x.x <= 21 + 1e-6));
  w.cam.position.set(33, 2, 0); // walk to the far end
  w.cam.updateMatrixWorld(true);
  show.tickFxShowcase(w.s3d, 2000);
  d = discs(w);
  check("F: moving re-picks: the new nearest fade in while the old ones fade out (no instant swap)",
    d.some((x) => x.x >= 24 && x.fade < 1) && d.some((x) => x.x <= 9 && x.fade > 0 && x.fade < 1));
  settle(w, 2250, 5);
  d = discs(w);
  check("F: ...then exactly the 8 nearest the new spot remain", d.length === 8 && d.every((x) => x.x >= 12 - 1e-6), d.map((x) => x.x).join(","));
}

// ── G — `?portalSetPiece=off` ──────────────────────────────────────────────
{
  reset();
  show._setPortalSetPieceForTest(false);
  const w = world();
  entity(w, 40, 0x02000183, 5, 5, show.ODF_PORTAL); // the bookcase
  show.tickFxShowcase(w.s3d, 1000);
  const d = discs(w);
  check("G: off — the old rule: the ODF bit alone, root + 1.6 m, violet (even on a bookcase)", d.length === 1 && near(d[0].y, 1.6) && d[0].mood === 0);
  const creature = entity(w, 41, 0x02001945, -5, 5, 0);
  show.tickFxShowcase(w.s3d, 1600);
  check("G: off — no ODF bit, no piece (the creature portal)", discs(w).length === 1);
  void creature;
  show._setPortalSetPieceForTest(true);
}

// ── H — shader + flag ──────────────────────────────────────────────────────
{
  const frag = show.FX_SHOWCASE_GLSL.fragment;
  check("H: the disc reads its mood and hollows dead / dark portal space",
    frag.includes("float mood = vAux.w;") && frag.includes("float hollow = max( dead, dark );") &&
    frag.includes("c *= mix( 1.0, smoothstep( 0.0, 0.45, r ), hollow * 0.8 );"));
  check("H: the nebula base line is unchanged (portal parity pins it)",
    frag.includes("vec3 deep = vCol.rgb * ( 0.12 + 0.04 * uShowDeepHue ) + vec3( 0.02, 0.0, 0.05 ) * ( 1.0 - uShowDeepHue );"));
  show._setPortalSetPieceForTest(null);
  check("H: absent → on", show.portalSetPieceEnabled() === true);
  globalThis.location.search = "?portalSetPiece=off";
  show._setPortalSetPieceForTest(null);
  check("H: =off → off", show.portalSetPieceEnabled() === false);
  globalThis.location.search = "";
  show._setPortalSetPieceForTest(null);
  const flags = readFileSync(new URL("../docs/url-flags.md", import.meta.url), "utf8");
  check("H: url-flags.md documents ?portalSetPiece", /\|\s*`portalSetPiece`/.test(flags));
}

reset();
console.log(`portal_set_piece: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
