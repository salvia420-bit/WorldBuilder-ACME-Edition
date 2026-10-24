import { connect, sleep } from "./lib.mjs";
const { page } = await connect();
const ev = (fn, arg) => page.evaluate(fn, arg);
const r = await ev(async () => {
  const P = window.__droneProbe; const rows = []; const t0 = performance.now();
  const startMatch = P.matchAnim(P.A[0x030003BA]);
  P.motion(0x41000003);
  await new Promise((res) => { const step = () => { const t = performance.now() - t0; const f = P.rootWorld(), l = P.partWorld(12, [-0.026, 0.004, -0.075]);
    rows.push([Math.round(t), +(l.y - f.y).toFixed(2)]); if (t < 1500) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  let maxJump = 0; for (let k = 1; k < rows.length; k += 1) maxJump = Math.max(maxJump, Math.abs(rows[k][1] - rows[k - 1][1]));
  return { startMatch, first: rows[0], last: rows[rows.length - 1], maxStepM: +maxJump.toFixed(3), sample: rows.filter((_, k) => k % 6 === 0) };
});
console.log("ReadState -> Ready:", JSON.stringify(r));
process.exit(0);
