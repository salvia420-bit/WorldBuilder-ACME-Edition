import { connect, sleep } from "./lib.mjs";
const OUT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/drone-deploy-2026-10-24/recon/probe";
const { page } = await connect();
const shot = async (name) => { await page.locator("#canvas").screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 82 }); console.log("  shot", name); };
const ev = (fn, arg) => page.evaluate(fn, arg);
// Reset to a clean standing pose.
await ev(() => { const P = window.__droneProbe; P.clearProps(); P.motion(0x41000003); });
await sleep(1500);
// (a) Real setMotion(Pickup): the full grip-height curve, to see how it gets back up.
const real = await ev(async () => {
  const P = window.__droneProbe; const rows = []; const t0 = performance.now();
  P.motion(0x40000018);
  await new Promise((res) => { const step = () => { const t = performance.now() - t0; const f = P.rootWorld(), r = P.partWorld(15, [0.025, 0, -0.076]);
    rows.push([Math.round(t), +(r.y - f.y).toFixed(2)]); if (t < 2000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  const i = P.inst(); return { rows: rows.filter((_, k) => k % 4 === 0), loco: i._locoCycleKey, seq: !!i._unifiedSeq };
});
console.log("setMotion(Pickup) grip height [ms, m]:", JSON.stringify(real.rows));
console.log("  after 2 s loco:", real.loco, "oneShot:", real.seq);
await ev(() => window.__droneProbe.motion(0x41000003)); await sleep(1500);
// (b) Pickup as a JS clip: frames 0..21, hold 21 for 3 s (capture), 21..0 — drone in hand, released at frame 18.
await ev(() => window.__droneProbe.addProp("droneHand", 15, [0.025, 0, -0.076], [0.707107, 0.707107, 0, 0], [0.30, 0.30, 0.06], 0xffa000));
const clipRun = await ev(async () => {
  const P = window.__droneProbe, THREE = P.THREE;
  const d = P.buildClip(P.A[0x03000247], [{ from: 0, to: 21 }, { hold: 21, frames: 90 }, { from: 21, to: 0 }]);
  P.playClip(d);
  await new Promise((r) => setTimeout(r, 600)); // ≈ frame 18
  const f = P.rootWorld(), r = P.partWorld(15, [0.025, 0, -0.076]);
  P.removeProp("droneHand");
  P.addWorldBox("droneGround", new THREE.Vector3(r.x, f.y + 0.03, r.z), [0.32, 0.06, 0.32], 0xffa000);
  return { frames: d.numFrames, gripY: +(r.y - f.y).toFixed(3), horiz: +Math.hypot(r.x - f.x, r.z - f.z).toFixed(3) };
});
console.log("Pickup clip release:", JSON.stringify(clipRun));
await ev(() => window.__droneProbe.frameFront(3.0, 12, 0.7, 30)); await sleep(500); await shot("08-pickup-clip-bottom");
const up = await ev(async () => {
  const P = window.__droneProbe; const rows = []; const t0 = performance.now();
  await new Promise((res) => { const step = () => { const t = performance.now() - t0; const f = P.rootWorld(), r = P.partWorld(15, [0.025, 0, -0.076]);
    rows.push([Math.round(t), +(r.y - f.y).toFixed(2)]); if (t < 3500) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  return rows.filter((_, k) => k % 6 === 0);
});
console.log("Pickup clip rest of curve [ms, m]:", JSON.stringify(up));
await shot("08b-pickup-clip-standing");
process.exit(0);
