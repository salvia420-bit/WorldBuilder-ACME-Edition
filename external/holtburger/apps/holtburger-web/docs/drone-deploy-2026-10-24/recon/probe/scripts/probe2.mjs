import { connect, sleep } from "./lib.mjs";
const OUT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/drone-deploy-2026-10-24/recon/probe";
const { page } = await connect();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
const shot = async (name) => { await page.locator("#canvas").screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 82 }); console.log("  shot", name); };
const ev = (fn, arg) => page.evaluate(fn, arg);

// Outbound counter: AC packets ride WebSocket frames [port u16 BE][packet]; a game action is
// 0xF7B1 (LE) + u32 sequence + u32 opcode. Count every outbound frame and actions by opcode.
await ev(() => {
  if (window.__dpSend) return;
  const orig = WebSocket.prototype.send;
  const C = { frames: 0, actions: {} };
  window.__dpSend = { C, orig, reset() { C.frames = 0; C.actions = {}; } };
  WebSocket.prototype.send = function (data) {
    try {
      C.frames += 1;
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (u8) for (let i = 0; i + 12 <= u8.length; i += 1) {
        if (u8[i] === 0xB1 && u8[i + 1] === 0xF7 && u8[i + 2] === 0 && u8[i + 3] === 0) {
          const op = (u8[i + 8] | (u8[i + 9] << 8) | (u8[i + 10] << 16) | (u8[i + 11] << 24)) >>> 0;
          const k = "0x" + op.toString(16).toUpperCase();
          C.actions[k] = (C.actions[k] || 0) + 1; i += 11;
        }
      }
    } catch (_) {}
    return orig.call(this, data);
  };
});
const counts = () => ev(() => JSON.parse(JSON.stringify(window.__dpSend.C)));
await ev(() => window.__dpSend.reset());
await sleep(15000);
const idle = await counts();
console.log("idle 15 s outbound:", JSON.stringify(idle));

// Hide wielded children locally for the sequence (film seam: setFilmHidden).
const hidden = await ev(() => {
  const P = window.__droneProbe, em = window.liveScene3d.entityManager, i = P.inst();
  const kids = [...(i._attachedChildren || [])].map((g) => g >>> 0);
  for (const c of kids) em.setFilmHidden(c, true);
  P.hiddenKids = kids; return kids.map((g) => "0x" + g.toString(16));
});
console.log("hidden wielded:", JSON.stringify(hidden));
await ev(() => window.__dpSend.reset());

// Per-rAF sampler of the right grip / both grips relative to the feet and the head.
await ev(() => {
  const P = window.__droneProbe;
  P.sample = (ms, label) => new Promise((res) => {
    const rows = [], t0 = performance.now();
    const step = () => {
      const t = performance.now() - t0;
      const feet = P.rootWorld(), r = P.partWorld(15, [0.025, 0, -0.076]), l = P.partWorld(12, [-0.026, 0.004, -0.075]);
      const head = P.partWorld(16, [0, -0.10, 0.085]);
      rows.push({ t: Math.round(t), rY: +(r.y - feet.y).toFixed(3), rH: +Math.hypot(r.x - feet.x, r.z - feet.z).toFixed(3),
        lEye: +l.distanceTo(head).toFixed(3), rEye: +r.distanceTo(head).toFixed(3) });
      if (t < ms) requestAnimationFrame(step); else res({ label, rows });
    };
    requestAnimationFrame(step);
  });
});

// StoreInBackpack timeline (drone appears in hand at the top of the reach).
await ev(() => window.__droneProbe.addProp("droneHand", 15, [0.025, 0, -0.076], [0.707107, 0.707107, 0, 0], [0.30, 0.30, 0.06], 0xffa000));
const store = await ev(async () => { const P = window.__droneProbe; const s = P.sample(2200, "store"); P.motion(0x40000019); return s; });
const sRows = store.rows; const sMax = sRows.reduce((a, b) => (b.rY > a.rY ? b : a));
const sBack = sRows.findIndex((r, k) => k > sRows.indexOf(sMax) && Math.abs(r.rY - sRows[0].rY) < 0.03);
console.log("StoreInBackpack: start rY", sRows[0].rY, "peak rY", sMax.rY, "at", sMax.t, "ms; back to start at", sRows[sBack]?.t ?? "never", "ms; frames sampled", sRows.length);

// Pickup timeline + release at the lowest point (rAF watcher), drone placed on the ground there.
const pick = await ev(async () => {
  const P = window.__droneProbe, THREE = P.THREE;
  let prev = Infinity, released = null;
  const rows = [], t0 = performance.now();
  P.motion(0x40000018);
  await new Promise((res) => {
    const step = () => {
      const t = performance.now() - t0;
      const feet = P.rootWorld(), r = P.partWorld(15, [0.025, 0, -0.076]);
      const y = r.y - feet.y;
      rows.push({ t: Math.round(t), rY: +y.toFixed(3) });
      if (!released && t > 200 && y > prev + 0.002) {
        // first rising frame after the descent: release at the previous (lowest) position
        P.removeProp("droneHand");
        const pos = new THREE.Vector3(r.x, feet.y + 0.03, r.z);
        P.addWorldBox("droneGround", pos, [0.32, 0.06, 0.32], 0xffa000);
        released = { t: Math.round(t), lowestY: +prev.toFixed(3), horiz: +Math.hypot(r.x - feet.x, r.z - feet.z).toFixed(3) };
      }
      prev = Math.min(prev, y);
      if (t < 2400) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  const lo = rows.reduce((a, b) => (b.rY < a.rY ? b : a));
  const back = rows.findIndex((x, k) => k > rows.indexOf(lo) && Math.abs(x.rY - rows[0].rY) < 0.03);
  return { start: rows[0].rY, lowest: lo, backAt: rows[back]?.t ?? null, released, n: rows.length };
});
console.log("Pickup:", JSON.stringify(pick));
await ev(() => window.__droneProbe.frameFront(3.0, 10, 0.8, 25)); await sleep(400); await shot("06-drone-released-at-lowest");

// Goggles clip timeline (0->20->0 at 30 fps), goggles attach at frame 14.
const gog = await ev(async () => {
  const P = window.__droneProbe;
  const d = P.buildClip(P.A[0x030004F8], [{ from: 0, to: 20 }, { from: 20, to: 0 }]);
  const s = P.sample(1700, "goggles"); P.playClip(d);
  setTimeout(() => P.addProp("goggles", 16, [0, -0.10, 0.085], [1, 0, 0, 0], [0.18, 0.07, 0.08], 0x00ff66), 467);
  const r = await s; const best = r.rows.reduce((a, b) => (b.lEye + b.rEye < a.lEye + a.rEye ? b : a));
  return { frames: d.numFrames, closest: best, n: r.rows.length };
});
console.log("Goggles clip:", JSON.stringify(gog));

// Tablet + ReadState, weapons hidden; front and over-the-shoulder views.
await ev(() => window.__droneProbe.addProp("tablet", 12, [-0.105, -0.035, -0.143], [-0.509, 0.062, -0.685, 0.518], [0.24, 0.16, 0.012],
  [0xff8800, 0xff8800, 0xff8800, 0xff8800, 0x00e5ff, 0x333333]));
await ev(() => window.__droneProbe.motion(0x43000146));
await sleep(1500);
await ev(() => window.__droneProbe.frameFront(2.6, 10, 1.1, 20)); await sleep(400); await shot("07-tablet-goggles-front-noweapon");
await ev(() => window.__droneProbe.frameFront(1.2, 35, 1.55, 180)); await sleep(400); await shot("07b-over-shoulder-screen");
await ev(() => window.__droneProbe.frameFront(4.5, 12, 0.9, 35)); await sleep(400); await shot("07c-wide-with-drone");
await sleep(4000);
const during = await counts();
console.log("gesture run outbound:", JSON.stringify(during));
console.log("errors:", errors.length, JSON.stringify(errors.slice(0, 5)));
process.exit(0);
