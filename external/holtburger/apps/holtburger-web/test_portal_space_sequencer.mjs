// test_portal_space_sequencer.mjs — scene3d/portal_space.js, the retail
// gmSmartBoxUI teleport state machine (acclient.c:262415-262580) that
// replaced the loading-screen curtain + the overlay donut (2026-10-05).
//
// Pins: the GetAnimLevel table, TUNNEL holding until the world is ready (no
// timer exit), CONTINUE's 2 s floor / frame window / 5 s cap, the 1 s fades,
// the exit sound + done edges, camera-roll legs, destination-cells readiness,
// and the module-level start/arrive/tick/end wiring incl. the failsafes.

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

const ps = await import("./scene3d/portal_space.js");
const { TAS, createPortalSequencer, retailAnimLevel, destinationCellsReady } = ps;

console.log("=== GetAnimLevel table ===");
check("level(0) == 0", retailAnimLevel(0) === 0, String(retailAnimLevel(0)));
check("level(1) == 1024", retailAnimLevel(1) === 1024, String(retailAnimLevel(1)));
{
  let mono = true, prev = -1;
  for (let i = 0; i <= 100; i++) { const v = retailAnimLevel(i / 100); if (v < prev) mono = false; prev = v; }
  check("level is monotone non-decreasing", mono);
  const mid = retailAnimLevel(0.5);
  check("level(0.5) is an ease (~512)", mid > 450 && mid < 575, String(mid));
  check("clamped outside [0,1]", retailAnimLevel(-3) === 0 && retailAnimLevel(7) === 1024);
}

console.log("\n=== state machine ===");
const step = (seq, secs, opts, dt = 1 / 60) => {
  const evs = [];
  for (let t = 0; t < secs - 1e-9; t += dt) evs.push(...seq.tick(dt, opts));
  return evs;
};
{
  const seq = createPortalSequencer(() => 0.5);
  check("starts OFF", seq.state === TAS.OFF && !seq.isActive() && !seq.ownsFrame());
  seq.begin();
  check("begin -> TUNNEL, owns frame", seq.state === TAS.TUNNEL && seq.ownsFrame());
  const e1 = step(seq, 30, { worldReady: false });
  check("TUNNEL holds while the world is not ready (no timer exit)", seq.state === TAS.TUNNEL);
  check("camera roll legs post the retail notice", e1.filter((e) => e === "notice").length >= 15);
  const e2 = seq.tick(1 / 60, { worldReady: true });
  check("worldReady -> CONTINUE", seq.state === TAS.CONTINUE && e2.includes("continue"));
  step(seq, 1.9, { worldReady: true, frame: 120 - 48 }); // remaining 1.2 s: in window
  check("CONTINUE holds for the 2 s floor even inside the frame window", seq.state === TAS.CONTINUE);
  step(seq, 0.2, { worldReady: true, frame: 120 - 48 });
  check("CONTINUE exits at >=2 s when (120-frame)/40 in (1.1,1.3)", seq.state === TAS.TUNNEL_FADEOUT);
  check("tunnel far plane shrinks during TUNNEL_FADEOUT", (() => { seq.tick(0.5, {}); return seq.tunnelFarFrac() < 0.9; })());
  const e3 = step(seq, 0.6, {});
  check("FADEOUT -> WORLD_FADEIN after 1 s with the exit sound", seq.state === TAS.WORLD_FADEIN && e3.includes("exitSound"));
  check("world hidden only through FADEOUT; overlay fades during FADEIN", !seq.ownsFrame() && seq.worldOverlayAlpha() > 0.5);
  const e4 = step(seq, 1.05, {});
  check("WORLD_FADEIN -> OFF after 1 s with done", seq.state === TAS.OFF && e4.includes("done"));
}
{
  const seq = createPortalSequencer(() => 0.1);
  seq.begin();
  seq.tick(0.01, { worldReady: true });
  step(seq, 4.9, { worldReady: true, frame: 0 }); // remaining 3 s: never in window
  check("CONTINUE outside the frame window holds until 5 s", seq.state === TAS.CONTINUE);
  step(seq, 0.2, { worldReady: true, frame: 0 });
  check("CONTINUE force-exits at the 5 s cap", seq.state === TAS.TUNNEL_FADEOUT);
}
{
  const seq = createPortalSequencer(() => 0.75);
  seq.begin();
  const a0 = seq.angle;
  seq.tick(0.01, {}); // first leg: duration 0 -> pick a target
  step(seq, 0.5, {});
  check("camera roll moves toward a random target", seq.angle !== a0 && seq.angle > 0 && seq.angle <= 360, String(seq.angle));
}

console.log("\n=== destination cells ===");
{
  const s3 = { cellContainers3d: new Map([[0x01d90123, {}]]), terrainBakedLbs: new Set([0xa9b40000]) };
  check("indoor cell resident", destinationCellsReady(s3, 0x01d90123) === true);
  check("indoor cell not resident", destinationCellsReady(s3, 0x01d90124) === false);
  check("outdoor cell -> terrain bake of its landblock", destinationCellsReady(s3, 0xa9b4001f) === true);
  check("outdoor cell unbaked", destinationCellsReady(s3, 0xa9b5001f) === false);
  check("unknown cell is never ready", destinationCellsReady(s3, 0) === false);
  check("no registries (headless) reads ready", destinationCellsReady({}, 0x01d90123) === true);
}

console.log("\n=== module wiring ===");
{
  const scene3d = { cellContainers3d: new Map(), terrainBakedLbs: new Set() }; // no wasm: tunnel build no-ops
  let exits = 0;
  ps.startPortalSpace(scene3d, { enterDid: 0, exitDid: 0, onExit: () => { exits++; } });
  check("start -> active + owns frame", ps.isPortalSpaceActive() && ps.portalSpaceOwnsFrame());
  for (let i = 0; i < 120; i++) ps.tickPortalSpace(scene3d, 1 / 60);
  check("no arrival -> still in the tunnel after 2 s", ps.portalSpaceOwnsFrame());
  ps.signalPortalArrived({ cellId: 0x01d90123 });
  for (let i = 0; i < 60; i++) ps.tickPortalSpace(scene3d, 1 / 60);
  check("arrived but dungeon cell not resident -> still holding", ps.portalSpaceOwnsFrame());
  scene3d.cellContainers3d.set(0x01d90123, {});
  ps.tickPortalSpace(scene3d, 1 / 60);
  for (let i = 0; i < 60 * 10; i++) ps.tickPortalSpace(scene3d, 1 / 60);
  check("sequence completes (continue cap + fades)", !ps.isPortalSpaceActive());
  check("onExit fired exactly once", exits === 1, String(exits));

  // failsafe: arrival never signalled
  ps.startPortalSpace(scene3d, { enterDid: 0, exitDid: 0 });
  for (let i = 0; i < 4 * 30; i++) ps.tickPortalSpace(scene3d, 0.25); // 30 s
  check("no-arrival failsafe ends the sequence (<= 20 s hold + exit)", !ps.isPortalSpaceActive());

  // failsafe: arrived, cells never load
  ps.startPortalSpace(scene3d, { enterDid: 0, exitDid: 0 });
  ps.signalPortalArrived({ cellId: 0x7777_0200 });
  for (let i = 0; i < 4 * 16; i++) ps.tickPortalSpace(scene3d, 0.25); // 16 s
  check("cells-wait failsafe ends the sequence", !ps.isPortalSpaceActive());

  // re-teleport mid-continue re-opens the tunnel
  ps.startPortalSpace(scene3d, { enterDid: 0, exitDid: 0 });
  ps.signalPortalArrived({ cellId: 0 }); // unknown cell -> waits on the failsafe
  ps.startPortalSpace(scene3d, { enterDid: 0, exitDid: 0 });
  ps.tickPortalSpace(scene3d, 1 / 60);
  check("re-teleport resets arrival (stays in TUNNEL)", ps.portalSpaceOwnsFrame());
  ps.endPortalSpace();
  check("endPortalSpace tears down", !ps.isPortalSpaceActive() && !ps.portalSpaceOwnsFrame());

  check("renderPortalSpaceFrame declines when inactive", ps.renderPortalSpaceFrame({}, null) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
