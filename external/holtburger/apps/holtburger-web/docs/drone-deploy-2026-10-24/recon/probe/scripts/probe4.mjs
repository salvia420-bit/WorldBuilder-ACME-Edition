import { connect, sleep } from "./lib.mjs";
const OUT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/drone-deploy-2026-10-24/recon/probe";
const { page } = await connect();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error" || /\[film/.test(m.text())) errors.push(m.type() + ": " + m.text().slice(0, 200)); });
const shot = async (name) => { await page.locator("#canvas").screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 82 }); console.log("  shot", name); };
const ev = (fn, arg) => page.evaluate(fn, arg);

// 1. ReadState entry/exit smoothness: left-grip height per frame.
const curve = (cmd, ms) => ev(async ({ cmd, ms }) => {
  const P = window.__droneProbe; const rows = []; const t0 = performance.now();
  P.motion(cmd);
  await new Promise((res) => { const step = () => { const t = performance.now() - t0; const f = P.rootWorld(), l = P.partWorld(12, [-0.026, 0.004, -0.075]);
    rows.push([Math.round(t), +(l.y - f.y).toFixed(2)]); if (t < ms) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  let maxJump = 0; for (let k = 1; k < rows.length; k += 1) maxJump = Math.max(maxJump, Math.abs(rows[k][1] - rows[k - 1][1]));
  return { first: rows[0], last: rows[rows.length - 1], maxStepM: +maxJump.toFixed(3), sample: rows.filter((_, k) => k % 6 === 0) };
}, { cmd, ms });
console.log("ReadState -> Ready:", JSON.stringify(await curve(0x41000003, 1500)));
console.log("Ready -> ReadState:", JSON.stringify(await curve(0x43000146, 1500)));

// 2. Film camera owner + flight model OUTSIDE film mode: a lift-off reveal from the drone's ground spot.
const setup = await ev(async () => {
  const P = window.__droneProbe;
  const base = new URL("scene3d/film/", location.href);
  const CO = await import(new URL("runtime/camera_owner.js", base).href);
  const FM = await import(new URL("drone/flight_model.js", base).href);
  P.CO = CO; P.FM = FM;
  const w = window.__cam.world(); const pp = window.__sessionHandle.getLocalPlayerPose(); const h = pp.heading; try { pp.free(); } catch (_) {}
  P.pilot = { x: w.x, y: w.y, z: w.z, h };
  const filmOn = new URLSearchParams(location.search).get("filmMode");
  return { filmMode: filmOn, createCameraOwner: typeof CO.createCameraOwner, createDrone: typeof FM.createDrone, presets: FM.DRONE_PRESET_NAMES, pilot: P.pilot };
});
console.log("film modules outside film mode:", JSON.stringify(setup));
const fly = (tFreeze) => ev(async (tFreeze) => {
  const P = window.__droneProbe;
  P.removeProp("droneGround"); // the craft is the camera now
  if (!P.owner) P.owner = P.CO.createCameraOwner({ liveScene3d: window.liveScene3d, THREE: P.THREE, sessionHandle: window.__sessionHandle, window });
  const own = P.owner.own();
  const { x, y, z, h } = P.pilot, s = Math.sin(h), c = Math.cos(h), DEG = Math.PI / 180;
  const hp = h + Math.PI;                                   // drone faces the pilot
  const start = { pos: [x + 0.72 * s, y + 0.72 * c, z + 0.25], h: hp, p: 14 * DEG, r: 0, fov: 85 };
  const end = { pos: [x + 3.4 * s, y + 3.4 * c, z + 1.7], h: hp, p: -6 * DEG, r: 0, fov: 85 };
  const drone = P.FM.createDrone("cinema");
  let pose = drone.reset({ ...start, t: 0 });
  P.owner.write(pose);
  const T = 2.2, t0 = performance.now(); let last = t0, frames = 0;
  await new Promise((res) => {
    const step = (now) => {
      const t = (now - t0) / 1000, dt = Math.max(0.001, (now - last) / 1000); last = now;
      const u = Math.min(1, Math.max(0, t / T)), e = u * u * (3 - 2 * u);
      const lerp = (a, b) => a + (b - a) * e;
      const target = { pos: [lerp(start.pos[0], end.pos[0]), lerp(start.pos[1], end.pos[1]), lerp(start.pos[2], end.pos[2])], h: hp, p: lerp(start.p, end.p), r: 0, fov: 85, t };
      if (t <= tFreeze) { pose = drone.step(target, dt); P.owner.write(pose); frames += 1; requestAnimationFrame(step); } else res();
    };
    requestAnimationFrame(step);
  });
  return { own, frames, pos: pose.pos.map((v) => +v.toFixed(2)), stats: P.owner.stats?.() };
}, tFreeze);
await ev(() => { const P = window.__droneProbe; P.addProp("goggles", 16, [0, -0.10, 0.085], [1, 0, 0, 0], [0.18, 0.07, 0.08], 0x00ff66);
  P.addProp("tablet", 12, [-0.105, -0.035, -0.143], [-0.509, 0.062, -0.685, 0.518], [0.24, 0.16, 0.012], [0xff8800, 0xff8800, 0xff8800, 0xff8800, 0x00e5ff, 0x333333]); });
await sleep(800);
console.log("fly 0.05 s:", JSON.stringify(await fly(0.05))); await sleep(300); await shot("09a-reveal-t0");
console.log("fly 1.1 s:", JSON.stringify(await fly(1.1))); await sleep(200); await shot("09b-reveal-t1");
console.log("fly 3.0 s:", JSON.stringify(await fly(3.0))); await sleep(300); await shot("09c-reveal-end");
const rel = await ev(() => { const P = window.__droneProbe; const r = P.owner.release(); return { released: !!r, owned: P.owner.stats?.() }; });
console.log("release:", JSON.stringify(rel));
console.log("errors:", errors.length, JSON.stringify(errors.slice(0, 6)));
process.exit(0);
