// Drone-plan probe on the local ACE character: retail motions, the JS-built goggles clip,
// placeholder props at the DAT-derived anchors. Local-only (no wire traffic). Screenshots → recon/probe/.
import { connect, sleep } from "./lib.mjs";
const OUT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/drone-deploy-2026-10-24/recon/probe";
const { page } = await connect();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
const shot = async (name) => { await page.locator("#canvas").screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 82 }); console.log("  shot", name); };
const ev = (fn, arg) => page.evaluate(fn, arg);

const init = await ev(async () => {
  const em = window.liveScene3d.entityManager;
  const g = window.getLocalPlayerGuid() >>> 0;
  const THREE = await import("three");
  const msUrl = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/pkg\/holtburger_web\.js/.test(n));
  const mod = await import(msUrl);
  const MS = mod.MotionSequence;
  const NC = 0x8000003D;
  const inst = () => em.entityMap.get(g);
  const props = new Map();
  const P = {
    THREE, MS, g, inst,
    frameFront(dist = 3.2, el = 8, dz = 1.0, azOff = 0) {
      const p = window.__sessionHandle.getLocalPlayerPose(); const h = p.heading; try { p.free(); } catch (_) {}
      const az = ((h * 180) / Math.PI + azOff + 720) % 360;
      return window.__cam.player(dist, az, el, dz);
    },
    motion(cmd, speed = 1) { return em.setMotion(g, cmd >>> 0, NC, speed); },
    async anim(did) {
      const a = await window.liveScene3d.wasmExports.fetchAnimation(did);
      const o = { numFrames: a.numFrames, numParts: a.numParts, frames: new Float32Array(a.frames) };
      try { a.free(); } catch (_) {}
      return o;
    },
    buildClip(a, plan, fps = 30) {
      const seq = [];
      for (const s of plan) {
        if (s.hold !== undefined) { for (let i = 0; i < s.frames; i += 1) seq.push(s.hold); continue; }
        const st = s.to >= s.from ? 1 : -1;
        for (let f = s.from; st > 0 ? f <= s.to : f >= s.to; f += st) seq.push(f);
      }
      const stride = a.numParts * 7, n = seq.length;
      const partFrames = new Float32Array(n * stride);
      seq.forEach((f, k) => partFrames.set(a.frames.subarray(f * stride, (f + 1) * stride), k * stride));
      const frameTimes = new Float32Array(n); for (let k = 0; k < n; k += 1) frameTimes[k] = k / fps;
      return { partCount: a.numParts, numFrames: n, framerate: fps, partFrames, frameTimes, duration: n / fps, posFrames: null,
        segmentStarts: new Uint32Array([0]), segmentCounts: new Uint32Array([n]), segmentFramerates: new Float32Array([fps]),
        segmentAnimIds: new Uint32Array([0]), rootFrames: null };
    },
    playClip(desc, holdFinal = false) {
      const i = inst();
      const seq = MS.fromDescriptor(desc.numFrames >>> 0, desc.framerate, desc.duration, desc.frameTimes, desc.segmentStarts, desc.segmentCounts, false);
      if (!seq) return false;
      if (i._unifiedSeq) { try { i._unifiedSeq.seq.free(); } catch (_) {} }
      if (typeof em._clearUnifiedQueue === "function") em._clearUnifiedQueue(i);
      i._unifiedSeq = { seq, desc, clearOnDone: !holdFinal, hooks: [], lastHookTime: -1, speed: 1 };
      return true;
    },
    // Placeholder prop: a box (or multi-colour box) parented to a rig part in AC part-local space.
    addProp(name, partIdx, pos, qWXYZ, size, colors) {
      P.removeProp(name);
      const mats = (Array.isArray(colors) ? colors : [colors]).map((c) => new THREE.MeshBasicMaterial({ color: c }));
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mats.length === 1 ? mats[0] : mats);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.quaternion.set(qWXYZ[1], qWXYZ[2], qWXYZ[3], qWXYZ[0]);
      mesh.frustumCulled = false;
      mesh.userData.__attachedChildOf = g;
      inst().parts[partIdx].add(mesh);
      props.set(name, mesh);
      return true;
    },
    addWorldBox(name, posThree, size, color, yawThree = 0) {
      P.removeProp(name);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshBasicMaterial({ color }));
      mesh.position.copy(posThree); mesh.rotation.y = yawThree; mesh.frustumCulled = false;
      window.liveScene3d.scene.add(mesh); props.set(name, mesh);
      return [mesh.position.x, mesh.position.y, mesh.position.z].map((v) => +v.toFixed(3));
    },
    removeProp(name) {
      const m = props.get(name); if (!m) return false;
      m.parent?.remove(m); m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      props.delete(name); return true;
    },
    clearProps() { for (const k of [...props.keys()]) P.removeProp(k); },
    partWorld(idx, local = [0, 0, 0]) { const v = new THREE.Vector3(local[0], local[1], local[2]); inst().parts[idx].localToWorld(v); return v; },
    rootWorld() { const v = new THREE.Vector3(); inst().root.getWorldPosition(v); return v; },
    // Live part transforms vs an animation's frames: the best-matching frame and its max error.
    matchAnim(a) {
      const parts = inst().parts, n = Math.min(parts.length, a.numParts);
      let best = { f: -1, posErr: Infinity, quatErr: Infinity };
      for (let f = 0; f < a.numFrames; f += 1) {
        let pe = 0, qe = 0;
        for (let p = 0; p < n; p += 1) {
          const b = (f * a.numParts + p) * 7, gp = parts[p];
          pe = Math.max(pe, Math.abs(gp.position.x - a.frames[b]), Math.abs(gp.position.y - a.frames[b + 1]), Math.abs(gp.position.z - a.frames[b + 2]));
          const dot = Math.abs(gp.quaternion.w * a.frames[b + 3] + gp.quaternion.x * a.frames[b + 4] + gp.quaternion.y * a.frames[b + 5] + gp.quaternion.z * a.frames[b + 6]);
          qe = Math.max(qe, 1 - Math.min(1, dot));
        }
        if (pe < best.posErr) best = { f, posErr: pe, quatErr: qe };
      }
      return { frame: best.f, posErr: +best.posErr.toExponential(2), quatErr: +best.quatErr.toExponential(2) };
    },
    wire() { try { const s = window.__diag?.wire?.summary?.(); return s ? JSON.parse(JSON.stringify(s)) : null; } catch (e) { return String(e); } },
  };
  window.__droneProbe = P;
  return { three: THREE.REVISION, msUrl: msUrl?.split("/").pop(), ms: typeof MS?.fromDescriptor, parts: inst().parts.length,
    setup: "0x" + (inst().meta.setupId >>> 0).toString(16), mt: "0x" + (inst().meta.mtableId >>> 0).toString(16) };
});
console.log("init", JSON.stringify(init));
const wire0 = await ev(() => window.__droneProbe.wire());

// Pre-fetch the anims used for matching / the clip.
await ev(async () => { const P = window.__droneProbe; P.A = {}; for (const d of [0x030004F8, 0x030003BA, 0x03000247, 0x030003B7]) P.A[d] = await P.anim(d); return true; });

await ev(() => window.__droneProbe.frameFront(3.4, 6, 1.0, 0));
await sleep(800); await shot("00-ready-front");

// Beat 1-2: reach into the pack with the drone placeholder in the right hand (RightHand holding frame).
await ev(() => window.__droneProbe.addProp("droneHand", 15, [0.025, 0, -0.076], [0.707107, 0.707107, 0, 0], [0.30, 0.30, 0.06], 0xffa000));
await ev(() => window.__droneProbe.motion(0x40000019));
await sleep(1300); await shot("01-storeinbackpack-hold");
console.log("  match StoreInBackpack:", JSON.stringify(await ev(() => window.__droneProbe.matchAnim(window.__droneProbe.A[0x030003B7]))));
await ev(() => window.__droneProbe.motion(0x41000003));
await sleep(1100);

// Beat 3: kneel and place.
await ev(() => window.__droneProbe.motion(0x40000018));
await sleep(1300); await shot("02-pickup-hold");
console.log("  match Pickup:", JSON.stringify(await ev(() => window.__droneProbe.matchAnim(window.__droneProbe.A[0x03000247]))));
const placed = await ev(() => {
  const P = window.__droneProbe;
  const grip = P.partWorld(15, [0.025, 0, -0.076]); const feet = P.rootWorld();
  P.removeProp("droneHand");
  const pos = grip.clone(); pos.y = feet.y + 0.03;
  // local offset from the feet in the player's frame, for the report
  return { grip: [grip.x, grip.y, grip.z].map((v) => +v.toFixed(3)), feet: [feet.x, feet.y, feet.z].map((v) => +v.toFixed(3)),
    box: P.addWorldBox("droneGround", pos, [0.32, 0.06, 0.32], 0xffa000), horizDist: +Math.hypot(grip.x - feet.x, grip.z - feet.z).toFixed(3), gripAboveFeet: +(grip.y - feet.y).toFixed(3) };
});
console.log("  placed:", JSON.stringify(placed));
await sleep(300); await shot("02b-drone-placed");
await ev(() => window.__droneProbe.motion(0x41000003));
await sleep(1100);

// Beat 5: goggles clip (Cry 0->17, long hold for the capture, 17->0) built in JS and played on the playhead.
const clip = await ev(() => { const P = window.__droneProbe; const d = P.buildClip(P.A[0x030004F8], [{ from: 0, to: 17 }, { hold: 17, frames: 90 }, { from: 17, to: 0 }]); P.lastClip = d; return { frames: d.numFrames, ok: P.playClip(d) }; });
console.log("  goggles clip:", JSON.stringify(clip));
await sleep(1000); await shot("03-goggles-hands-at-face");
console.log("  match Cry during hold:", JSON.stringify(await ev(() => window.__droneProbe.matchAnim(window.__droneProbe.A[0x030004F8]))));
await ev(() => window.__droneProbe.addProp("goggles", 16, [0, -0.10, 0.085], [1, 0, 0, 0], [0.18, 0.07, 0.08], 0x00ff66));
await sleep(500); await shot("03b-goggles-attached-hold");
await sleep(3200);
await shot("03c-after-clip");
const afterClip = await ev(() => { const i = window.__droneProbe.inst(); return { seq: !!i._unifiedSeq, loco: i._locoCycleKey ?? null }; });
console.log("  after clip:", JSON.stringify(afterClip));

// Beat 6: tablet at the solved two-hand grip on the left hand, then ReadState.
await ev(() => window.__droneProbe.addProp("tablet", 12, [-0.105, -0.035, -0.143], [-0.509, 0.062, -0.685, 0.518], [0.24, 0.16, 0.012],
  [0xff8800, 0xff8800, 0xff8800, 0xff8800, 0x00e5ff, 0x333333]));
await ev(() => window.__droneProbe.motion(0x43000146));
await sleep(1500); await shot("04-readstate-tablet-front");
console.log("  match ReadState:", JSON.stringify(await ev(() => window.__droneProbe.matchAnim(window.__droneProbe.A[0x030003BA]))));
await ev(() => window.__droneProbe.frameFront(2.0, 18, 1.35, 35)); await sleep(500); await shot("04b-close-3q");
await ev(() => window.__droneProbe.frameFront(2.0, 5, 1.4, 90)); await sleep(500); await shot("04c-side");
await ev(() => window.__droneProbe.frameFront(1.6, 12, 1.5, 0)); await sleep(500); await shot("04d-face-close");

// A1 persistence: does anything stomp the held ReadState over 10 s with no input?
await sleep(10000);
console.log("  ReadState after 10 s:", JSON.stringify(await ev(() => window.__droneProbe.matchAnim(window.__droneProbe.A[0x030003BA]))));
await ev(() => window.__droneProbe.frameFront(3.0, 8, 1.1, 20)); await sleep(500); await shot("05-readstate-after-10s");

const wire1 = await ev(() => window.__droneProbe.wire());
console.log("wire before:", JSON.stringify(wire0)?.slice(0, 600));
console.log("wire after: ", JSON.stringify(wire1)?.slice(0, 600));
console.log("errors:", errors.length, JSON.stringify(errors.slice(0, 5)));
process.exit(0);
