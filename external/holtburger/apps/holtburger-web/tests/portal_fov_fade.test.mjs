// cells-portals-3 (2026-10-13) — the portal-space fades as retail FOV zooms
// (scene3d/portal_space.js `?portalFovFade`, DEFAULT ON since 2026-10-19,
// flipped ahead of its 1070 teleport eye test, which is still owed;
// `=off|0|false|no` = the legacy tunnel far-plane shrink + black world quad).
//
// Retail's TUNNEL_FADEOUT / WORLD_FADEIN (gmSmartBoxUI::UseTime states 5/6,
// acclient.c:262497-262527) lerp the SmartBox view-plane distance between
// gameVDist = 1/tan(fovV/2) (GetOverrideFovDistance, 143080) and 0.001 along
// GetAnimLevel. RenderNormalMode (144891) and the tunnel's CreatureMode
// (UseSmartboxFOV, 143942) consume it only through Render::set_vdst (378875)
// -> SetFOVInternal (453039): fov = 2·atan(1/vdist), zfar untouched. So the
// tunnel zooms out to a point and the world zooms in from one; nothing goes
// black.
//
// Fails on the old code: portal_space.js had no viewDistFov / fovForViewDist /
// portalFovFadeEnabled, always shrank the tunnel camera's far plane, never
// touched the world camera and always drew the black quad.
//
// Run: node tests/portal_fov_fade.test.mjs   (from apps/holtburger-web/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Browser-ish globals before the import (portal_space reads flags at load).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html" };

const THREE = await import("three");
const ps = await import("../scene3d/portal_space.js");
const { TAS, createPortalSequencer, retailAnimLevel, portalFovFadeEnabled, fovForViewDist, viewDistForFov, PORTAL_FOV_MAX_DEG } = ps;
const csm = await import("../scene3d/csm.js");

const BASE = 60;

console.log("PART 1 — ?portalFovFade flag (default ON since 2026-10-19, =off escape)");
{
  check("absent ⇒ on (default)", portalFovFadeEnabled("") === true);
  check("other flags only ⇒ on (default)", portalFovFadeEnabled("?nosw=1&wireframe=1") === true);
  check("on ⇒ on (the old enable token still works)", portalFovFadeEnabled("?portalFovFade=on") === true);
  check("ON / ' on ' ⇒ on", portalFovFadeEnabled("?portalFovFade=ON") && portalFovFadeEnabled("?portalFovFade=%20on%20"));
  for (const v of ["1", "true", "yes", "banana", ""]) {
    check(`${JSON.stringify(v)} ⇒ on (only off/0/false/no opt out)`, portalFovFadeEnabled(`?portalFovFade=${v}`) === true);
  }
  for (const v of ["off", "0", "false", "no", "OFF", "False", "NO", "%20off%20"]) {
    check(`${JSON.stringify(v)} ⇒ off (the escape)`, portalFovFadeEnabled(`?portalFovFade=${v}`) === false);
  }
  // No search argument: the reader falls back to globalThis.location.
  const savedLoc = globalThis.location;
  globalThis.location = { search: "?portalFovFade=off" };
  check("location ?portalFovFade=off ⇒ off", portalFovFadeEnabled() === false);
  globalThis.location = { search: "" };
  check("location bare ⇒ on", portalFovFadeEnabled() === true);
  globalThis.location = undefined;
  check("no location (worker / node) ⇒ on (the default)", portalFovFadeEnabled() === true);
  globalThis.location = { get search() { throw new Error("blocked"); } };
  check("a throwing location ⇒ on (the catch returns the default)", portalFovFadeEnabled() === true);
  globalThis.location = savedLoc;
}

console.log("\nPART 2 — set_vdst: fov = 2·atan(1/vdist), capped");
{
  for (const f of [30, 53.6, 60, 73, 90, 120]) {
    check(`identity at the default distance (fov ${f})`, near(fovForViewDist(viewDistForFov(f)), f, 1e-9),
      String(fovForViewDist(viewDistForFov(f))));
  }
  check("vdist 0.001 ⇒ capped at 179°", fovForViewDist(0.001) === PORTAL_FOV_MAX_DEG && PORTAL_FOV_MAX_DEG === 179);
  check("uncapped value is ~179.885° (the cap bites)", (2 * Math.atan(1000) * 180) / Math.PI > 179.8);
  check("vdist 1 ⇒ 90°", near(fovForViewDist(1), 90, 1e-9));
  check("smaller vdist ⇒ wider fov", fovForViewDist(0.5) > fovForViewDist(1) && fovForViewDist(0.1) > fovForViewDist(0.5));
  check("vdist <= 0 / NaN ⇒ the cap", fovForViewDist(0) === 179 && fovForViewDist(-1) === 179 && fovForViewDist(NaN) === 179);
}

// Drive a sequencer into TUNNEL_FADEOUT with t = 0 (begin opts: no CONTINUE floor/cap).
function intoFadeOut(fadeOut) {
  const seq = createPortalSequencer(() => 0.5);
  seq.begin({ minContinue: 0, maxContinue: 0, ...(fadeOut != null ? { fadeOut } : {}) });
  seq.tick(0.01, { worldReady: true }); // -> CONTINUE
  seq.tick(0, {}); // -> TUNNEL_FADEOUT, t = 0
  return seq;
}

console.log("\nPART 3 — sequencer viewDistFov (gmSmartBoxUI::UseTime states 5/6)");
{
  const seq = createPortalSequencer(() => 0.5);
  check("OFF ⇒ null", seq.viewDistFov(BASE) === null);
  seq.begin();
  check("TUNNEL ⇒ null", seq.state === TAS.TUNNEL && seq.viewDistFov(BASE) === null);
  seq.tick(0.01, { worldReady: true });
  check("CONTINUE ⇒ null", seq.state === TAS.CONTINUE && seq.viewDistFov(BASE) === null);

  const s5 = intoFadeOut();
  check("in TUNNEL_FADEOUT at t=0", s5.state === TAS.TUNNEL_FADEOUT && s5.t === 0);
  check("t=0 ⇒ the base fov (±1e-6)", near(s5.viewDistFov(BASE), BASE), String(s5.viewDistFov(BASE)));
  check("bad base fov ⇒ null", s5.viewDistFov(0) === null && s5.viewDistFov(180) === null && s5.viewDistFov(NaN) === null);
  const out = [];
  const dt = 0.01;
  while (s5.state === TAS.TUNNEL_FADEOUT) {
    out.push({ t: s5.t, f: s5.viewDistFov(BASE) });
    s5.tick(dt, {});
  }
  let mono = true;
  for (let i = 1; i < out.length; i++) if (out[i].f < out[i - 1].f - 1e-12) mono = false;
  check("TUNNEL_FADEOUT rises monotonically", mono);
  check("…strictly wider by the middle", out[Math.floor(out.length / 2)].f > BASE + 5, String(out[Math.floor(out.length / 2)].f));
  check("…to 179 at t=fade", out[out.length - 1].f === 179, `${out[out.length - 1].f} at t=${out[out.length - 1].t.toFixed(2)}`);
  {
    const mid = out.find((o) => near(o.t, 0.5, 1e-9));
    const g = viewDistForFov(BASE);
    const want = fovForViewDist(g + (0.001 - g) * (retailAnimLevel(0.5) / 1024));
    check("t=0.5 follows the retail curve (gameVDist + (0.001-gameVDist)·L)", mid && near(mid.f, want, 1e-9), mid ? `${mid.f} vs ${want}` : "no sample");
  }

  // WORLD_FADEIN — the mirror: 179° at t=0 back down to the base fov.
  check("FADEOUT -> WORLD_FADEIN", s5.state === TAS.WORLD_FADEIN && s5.t === 0);
  const inn = [];
  while (s5.state === TAS.WORLD_FADEIN) {
    inn.push({ t: s5.t, f: s5.viewDistFov(BASE) });
    s5.tick(dt, {});
  }
  check("WORLD_FADEIN t=0 ⇒ 179 (the world starts as a point)", inn[0].f === 179, String(inn[0].f));
  let monoDown = true;
  for (let i = 1; i < inn.length; i++) if (inn[i].f > inn[i - 1].f + 1e-12) monoDown = false;
  check("WORLD_FADEIN falls monotonically", monoDown);
  check("…to the base fov at the end", near(inn[inn.length - 1].f, BASE, 1e-6), String(inn[inn.length - 1].f));
  {
    const g = viewDistForFov(BASE);
    let curve = true;
    for (const o of inn) {
      const want = fovForViewDist(0.001 + (g - 0.001) * (retailAnimLevel(o.t / 1.0) / 1024));
      if (!near(o.f, want, 1e-9)) curve = false;
    }
    check("WORLD_FADEIN follows 0.001 + (gameVDist-0.001)·L (the mirror of state 5)", curve);
  }
  check("OFF after the fade-in ⇒ null", s5.state === TAS.OFF && s5.viewDistFov(BASE) === null);

  // Quick login fade-out: the curve runs over s.fadeOut (0.25 s), not 1 s.
  const q = intoFadeOut(0.25);
  q.tick(0.125, {});
  const g = viewDistForFov(BASE);
  const wantQ = fovForViewDist(g + (0.001 - g) * (retailAnimLevel(0.5) / 1024));
  const qMid = q.viewDistFov(BASE);
  check("quick fade uses s.fadeOut (t=0.125 of 0.25 = mid-curve)", near(qMid, wantQ, 1e-9), `${qMid} vs ${wantQ}`);
  const slow = intoFadeOut();
  slow.tick(0.125, {});
  check("…while the retail 1 s fade is still narrow at t=0.125", slow.viewDistFov(BASE) < qMid - 20, `${slow.viewDistFov(BASE)} vs ${qMid}`);
  q.tick(0.12, {}); // t = 0.245 of 0.25
  check("quick fade reaches 179 by its own end", q.state === TAS.TUNNEL_FADEOUT && q.viewDistFov(BASE) === 179, String(q.viewDistFov(BASE)));
  check("the legacy curves are untouched (tunnelFarFrac / worldOverlayAlpha)",
    slow.tunnelFarFrac() < 1 && slow.worldOverlayAlpha() === 0);
}

// ── module level ──────────────────────────────────────────────────────
function fakeRenderer() {
  const r = {
    autoClear: true,
    renders: [],
    target: null,
    getRenderTarget() { return this.target; },
    setRenderTarget(t) { this.target = t; },
    getClearColor(c) { return c; },
    getClearAlpha() { return 1; },
    setClearColor() {},
    clear() {},
    render(scene, cam) {
      const alpha = scene?.children?.[0]?.material?.uniforms?.alpha?.value;
      r.renders.push({ scene, fov: cam.fov, far: cam.far, isOverlay: !!cam.isOrthographicCamera, alpha });
    },
  };
  return r;
}
function fakeScene(cam) {
  // wasmExports {} = a tunnel build with no parts (empty scene, own camera).
  return { cellContainers3d: new Map(), terrainBakedLbs: new Set(), wasmExports: {}, cameraSwitcher: { activeCamera: cam } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await sleep(0); };

// Run a whole teleport: tunnel -> arrival -> continue -> fades -> OFF, a
// world/tunnel draw per tick the way scene3d/index.js orders them.
async function runTeleport({ search, cam, renderer, onTick }) {
  globalThis.location.search = search;
  const sc = fakeScene(cam);
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
  await flush(); // ensureTunnel (async) builds the empty tunnel scene
  ps.signalPortalArrived({ cellId: 0xa9b4001f });
  sc.terrainBakedLbs.add(0xa9b40000);
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 12 && ps.isPortalSpaceActive(); i++) {
    ps.tickPortalSpace(sc, dt);
    const state = globalThis.__portalSpace?.state;
    if (ps.portalSpaceOwnsFrame()) ps.renderPortalSpaceFrame(renderer, cam);
    else ps.renderPortalSpaceOverlay(renderer);
    onTick?.(state);
  }
  return sc;
}

console.log("\nPART 4 — ?portalFovFade=off: the legacy tunnel far-plane shrink + black quad (byte-identical)");
{
  const cam = new THREE.PerspectiveCamera(BASE, 16 / 9, 0.1, 5000);
  const r = fakeRenderer();
  const fovs = new Set();
  let overlayDraws = 0, fade5 = [];
  await runTeleport({
    search: "?portalFovFade=off",
    cam,
    renderer: r,
    onTick: (state) => {
      fovs.add(cam.fov);
      if (state === TAS.WORLD_FADEIN) overlayDraws = r.renders.filter((x) => x.isOverlay).length;
    },
  });
  for (const d of r.renders) if (!d.isOverlay) fade5.push(d);
  check("sequence completed", !ps.isPortalSpaceActive());
  check("the world camera's fov is never touched", fovs.size === 1 && cam.fov === BASE);
  check("tunnel camera keeps the game fov", fade5.length > 0 && fade5.every((d) => d.fov === BASE));
  check("tunnel far plane shrinks during TUNNEL_FADEOUT", fade5.some((d) => d.far < 5000 * 0.5), String(Math.min(...fade5.map((d) => d.far))));
  check("WORLD_FADEIN draws the black quad", overlayDraws > 5, String(overlayDraws));
  check("diag: fovFade off", globalThis.__portalSpace?.fovFade?.on === false);
}

console.log("\nPART 5 — bare default (flag absent) = ON: tunnel zooms out, far plane fixed; world zooms in, one black reveal frame");
{
  const cam = new THREE.PerspectiveCamera(BASE, 16 / 9, 0.1, 5000);
  cam.updateProjectionMatrix();
  const baseP5 = cam.projectionMatrix.elements[5];
  const r = fakeRenderer();
  const worldFovs = [];
  let heldFitFov = true, projOk = true, quadDuringFade = 0;
  const quadByFadeTick = [];
  await runTeleport({
    search: "",
    cam,
    renderer: r,
    onTick: (state) => {
      if (state === TAS.WORLD_FADEIN) {
        quadByFadeTick.push(r.renders.filter((x) => x.isOverlay).length);
        worldFovs.push(cam.fov);
        if (cam.userData.csmFitFov !== BASE) heldFitFov = false;
        // updateProjectionMatrix ran: P[5] = 1/tan(fov/2).
        if (!near(cam.projectionMatrix.elements[5], 1 / Math.tan((cam.fov * Math.PI) / 360), 1e-9)) projOk = false;
        quadDuringFade = r.renders.filter((x) => x.isOverlay).length;
      }
    },
  });
  const tunnel = r.renders.filter((d) => !d.isOverlay);
  check("sequence completed", !ps.isPortalSpaceActive());
  check("tunnel far plane stays the game far (no shrink)", tunnel.length > 0 && tunnel.every((d) => d.far === 5000));
  check("tunnel fov widens toward 179 during TUNNEL_FADEOUT", Math.max(...tunnel.map((d) => d.fov)) === 179);
  check("tunnel fov starts at the game fov (TUNNEL/CONTINUE)", tunnel[0].fov === BASE);
  check("world camera zoomed during WORLD_FADEIN (first frame 179°)", worldFovs.length > 10 && worldFovs[0] === 179, `${worldFovs.length} frames, first ${worldFovs[0]}`);
  let down = true;
  for (let i = 1; i < worldFovs.length; i++) if (worldFovs[i] > worldFovs[i - 1]) down = false;
  check("…narrowing monotonically", down);
  check("…projection matrix updated each frame", projOk);
  check("…CSM fits the game fov (userData.csmFitFov) while held", heldFitFov);
  // V-cells-stream-R2: the reveal tick's culls (cell PVS, FCULL statics /
  // entities) ran at the game fov before the zoom was written, so that ONE
  // frame stays black; from the next tick on the culls see the wide frustum
  // and no quad is drawn.
  check("exactly one black quad under the flag (the reveal frame)", quadDuringFade === 1, String(quadDuringFade));
  check("…drawn on the first WORLD_FADEIN frame, none after",
    quadByFadeTick.length > 10 && quadByFadeTick[0] === 1 && quadByFadeTick.every((n) => n === 1), quadByFadeTick.slice(0, 4).join(","));
  const revealQuad = r.renders.find((x) => x.isOverlay);
  check("…fully black (alpha 1)", revealQuad?.alpha === 1, String(revealQuad?.alpha));
  check("OFF: world fov restored exactly", cam.fov === BASE, String(cam.fov));
  check("OFF: projection restored", near(cam.projectionMatrix.elements[5], baseP5, 1e-12));
  check("OFF: csmFitFov cleared", !("csmFitFov" in cam.userData));
  check("diag: fovFade on, not holding", globalThis.__portalSpace?.fovFade?.on === true && globalThis.__portalSpace.fovFade.world === 0);
}

console.log("\nPART 6 — flag ON (explicit =on, the old enable token): teardown paths give the fov back");
{
  globalThis.location.search = "?portalFovFade=on";
  const cam = new THREE.PerspectiveCamera(BASE, 16 / 9, 0.1, 5000);
  const sc = fakeScene(cam);
  const toFadeIn = async () => {
    ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 });
    await flush();
    ps.signalPortalArrived({ cellId: 0xa9b4001f });
    sc.terrainBakedLbs.add(0xa9b40000);
    for (let i = 0; i < 30 * 10 && globalThis.__portalSpace?.state !== TAS.WORLD_FADEIN; i++) ps.tickPortalSpace(sc, 1 / 30);
    ps.tickPortalSpace(sc, 1 / 30);
    return globalThis.__portalSpace?.state === TAS.WORLD_FADEIN && cam.fov > BASE;
  };
  check("reached a held WORLD_FADEIN", await toFadeIn(), String(cam.fov));
  ps.endPortalSpace();
  check("endPortalSpace mid-fade (forced teardown) ⇒ fov restored", cam.fov === BASE && !("csmFitFov" in cam.userData));

  check("reached a held WORLD_FADEIN again", await toFadeIn());
  ps.startPortalSpace(sc, { enterDid: 0, exitDid: 0 }); // re-teleport during the fade-in
  check("a new tunnel mid-fade ⇒ fov restored before the tunnel draws", cam.fov === BASE && ps.portalSpaceOwnsFrame());
  ps.endPortalSpace();

  // A resize / Field of View slider during the hold wins over the stored fov.
  check("held again", await toFadeIn());
  cam.fov = 75; // ?retailFov resize handler / __setGameFov
  ps.tickPortalSpace(sc, 1 / 30);
  check("the new game fov becomes the zoom's base", globalThis.__portalSpace?.fovFade?.base === 75 && cam.userData.csmFitFov === 75);
  for (let i = 0; i < 60 && ps.isPortalSpaceActive(); i++) ps.tickPortalSpace(sc, 1 / 30);
  check("…and is what OFF restores", !ps.isPortalSpaceActive() && cam.fov === 75, String(cam.fov));

  // V-cells-stream-R2: the black reveal frame belongs to the TICK the hold
  // began (its culls ran at the game fov), not to the first frame drawn.
  {
    const c1 = new THREE.PerspectiveCamera(BASE, 16 / 9, 0.1, 5000);
    const s1 = fakeScene(c1);
    ps.startPortalSpace(s1, { enterDid: 0, exitDid: 0 });
    await flush();
    ps.signalPortalArrived({ cellId: 0xa9b4001f });
    s1.terrainBakedLbs.add(0xa9b40000);
    for (let i = 0; i < 30 * 10 && globalThis.__portalSpace?.state !== TAS.WORLD_FADEIN; i++) ps.tickPortalSpace(s1, 1 / 30);
    const rv = fakeRenderer();
    // Culls of this (reveal) tick saw the game fov; the camera now holds 179°.
    check("reveal tick: camera widened past the fov its culls used", c1.fov === 179, String(c1.fov));
    ps.renderPortalSpaceOverlay(rv);
    ps.renderPortalSpaceOverlay(rv); // a second draw in the same tick: already consumed
    check("reveal tick ⇒ one fully black quad", rv.renders.length === 1 && rv.renders[0].alpha === 1,
      `${rv.renders.length} / ${rv.renders[0]?.alpha}`);
    ps.tickPortalSpace(s1, 1 / 30);
    ps.renderPortalSpaceOverlay(rv);
    check("next tick (culls saw the wide frustum) ⇒ no quad", rv.renders.length === 1, String(rv.renders.length));

    // A resize during the hold re-bases the zoom but starts no new hold: no
    // black flash mid-fade.
    c1.fov = 75;
    ps.tickPortalSpace(s1, 1 / 30);
    ps.renderPortalSpaceOverlay(rv);
    check("resize mid-hold ⇒ no quad", rv.renders.length === 1, String(rv.renders.length));

    // A camera switch mid-fade starts a hold on the new camera, whose culls
    // this tick were not at its zoomed fov ⇒ one black frame again.
    const c2 = new THREE.PerspectiveCamera(BASE, 16 / 9, 0.1, 5000);
    s1.cameraSwitcher.activeCamera = c2;
    ps.tickPortalSpace(s1, 1 / 30);
    ps.renderPortalSpaceOverlay(rv);
    check("camera switch mid-fade ⇒ one black quad, old camera restored",
      rv.renders.length === 2 && rv.renders[1].alpha === 1 && c1.fov === 75 && c2.fov > BASE,
      `${rv.renders.length} / ${c1.fov} / ${c2.fov}`);
    ps.tickPortalSpace(s1, 1 / 30);
    ps.renderPortalSpaceOverlay(rv);
    check("…and none after", rv.renders.length === 2, String(rv.renders.length));

    // Reveal tick with no render (nullRender / renderOnDemand): the pending
    // frame is dropped by the next tick, whose culls are already wide.
    ps.endPortalSpace();
    ps.startPortalSpace(s1, { enterDid: 0, exitDid: 0 });
    await flush();
    ps.signalPortalArrived({ cellId: 0xa9b4001f });
    for (let i = 0; i < 30 * 10 && globalThis.__portalSpace?.state !== TAS.WORLD_FADEIN; i++) ps.tickPortalSpace(s1, 1 / 30);
    ps.tickPortalSpace(s1, 1 / 30);
    const rs = fakeRenderer();
    ps.renderPortalSpaceOverlay(rs);
    check("reveal frame not rendered ⇒ the next frame draws no quad", rs.renders.length === 0 && c2.fov > BASE,
      `${rs.renders.length} / ${c2.fov}`);
    ps.endPortalSpace();
    check("teardown restores both cameras", c1.fov === 75 && c2.fov === BASE, `${c1.fov} / ${c2.fov}`);
  }

  // Top-down (orthographic) camera: no zoom — the black quad stands in.
  globalThis.location.search = "?portalFovFade=on";
  const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
  const so = fakeScene(ortho);
  ps.startPortalSpace(so, { enterDid: 0, exitDid: 0 });
  await flush();
  ps.signalPortalArrived({ cellId: 0xa9b4001f });
  so.terrainBakedLbs.add(0xa9b40000);
  for (let i = 0; i < 30 * 10 && globalThis.__portalSpace?.state !== TAS.WORLD_FADEIN; i++) ps.tickPortalSpace(so, 1 / 30);
  ps.tickPortalSpace(so, 1 / 30);
  const r = fakeRenderer();
  ps.renderPortalSpaceOverlay(r);
  check("ortho camera in WORLD_FADEIN ⇒ black quad fallback", globalThis.__portalSpace?.state === TAS.WORLD_FADEIN && r.renders.length === 1);
  ps.endPortalSpace();
  globalThis.location.search = "";
}

console.log("\nPART 7 — csm.js fits userData.csmFitFov, not the zoomed camera.fov");
{
  const mk = () => {
    const c = new THREE.PerspectiveCamera(BASE, 16 / 9, 0.1, 5000);
    c.position.set(100, 50, -100);
    c.lookAt(150, 40, -150);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  const width = (st) => st.lights.map((l) => l.shadow.camera.right - l.shadow.camera.left);
  const sA = csm.setupCsm(new THREE.Scene(), { sunDir: { x: 60, y: 80, z: 30 } });
  csm.updateCsm(sA, mk());
  const wGame = width(sA);
  const sB = csm.setupCsm(new THREE.Scene(), { sunDir: { x: 60, y: 80, z: 30 } });
  const zoomed = mk();
  zoomed.fov = 170;
  zoomed.updateProjectionMatrix();
  csm.updateCsm(sB, zoomed);
  const wZoom = width(sB);
  check("a zoomed fov stretches the cascades (why the guard exists)", wZoom[0] > wGame[0] * 3, `${wZoom[0].toFixed(1)} vs ${wGame[0].toFixed(1)}`);
  const sC = csm.setupCsm(new THREE.Scene(), { sunDir: { x: 60, y: 80, z: 30 } });
  const held = mk();
  held.fov = 170;
  held.userData.csmFitFov = BASE;
  held.updateProjectionMatrix();
  csm.updateCsm(sC, held);
  const wHeld = width(sC);
  check("csmFitFov set ⇒ cascades fit the game fov exactly", wHeld.every((w, i) => near(w, wGame[i], 1e-9)), `${wHeld[0]} vs ${wGame[0]}`);
  csm.updateCsm(sC, held);
  check("…and the zoom alone does not force a refit next frame", sC.didRefitThisTick === false);
  held.fov = BASE;
  delete held.userData.csmFitFov;
  held.updateProjectionMatrix();
  csm.updateCsm(sC, held);
  check("release to the same game fov ⇒ no refit either", sC.didRefitThisTick === false);
  check("a camera without userData falls back to camera.fov", (() => {
    const c = mk();
    c.userData = undefined;
    const s = csm.setupCsm(new THREE.Scene(), { sunDir: { x: 60, y: 80, z: 30 } });
    csm.updateCsm(s, c);
    return width(s).every((w, i) => near(w, wGame[i], 1e-9));
  })());
}

console.log("\nPART 8 — static: the far-plane scale is flag-gated, not removed");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolvePath(here, "../scene3d/portal_space.js"), "utf8");
  const body = src.slice(src.indexOf("export function renderPortalSpaceFrame"), src.indexOf("export function renderPortalSpaceOverlay"));
  check("renderPortalSpaceFrame scales cam.far only when the flag is off",
    /cam\.far = Math\.max\(cam\.near \+ 1e-3, gameFar \* \(_fovFadeOn \? 1 : _seq\.tunnelFarFrac\(\)\)\)/.test(body));
  check("renderPortalSpaceFrame zooms the tunnel fov only under the flag", /if \(_fovFadeOn\) \{[\s\S]*?viewDistFov\(cam\.fov\)/.test(body));
  const endBody = src.slice(src.indexOf("export function endPortalSpace"));
  check("endPortalSpace releases the world camera's fov", /_releaseWorldFov\(\)/.test(endBody));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
