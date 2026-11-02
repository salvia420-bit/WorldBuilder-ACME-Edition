// vehicle-crashsave.eval.js — the H2 test, part 1 (pilot page): board, climb to ~aglM above the ground and keep flying
// (sticks held for minutes) so the server's periodic save (player_save_interval, lowered for the test) stores the pilot
// at the seat in the sky with the AirborneSaveMark. The driver then SIGKILLs ACE (a crash: no logout path runs),
// restarts it and logs the character in again (vehicle-crashlogin.eval.js).
// window.__vehicleRun: {aglM: 150, holdSec: 30}
const R = window.__vehicleRun || {};
const V = window.__vehicles, h = window.__sessionHandle;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null || !Number.isFinite(z) ? null : z; } catch (_) { return null; } };
if (!V.nearest()) {
  const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
  if (v) { h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${Math.max(1, v.last.x - 4).toFixed(2)} ${v.last.y.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`); await sleep(4000); }
}
V.board();
for (let i = 0; i < 40 && !V.piloting; i++) await sleep(250);
if (!V.piloting) return { fatal: "board failed" };
V.setSticks({ throttle: 1 }, 600000);
for (let i = 0; i < 200; i++) { const s = V.status().pilot?.state; if (s && s.mode === 2) break; await sleep(100); }
V.setSticks({ throttle: 0.7, pitch: 0.5 }, 600000);
for (let i = 0; i < 400; i++) { const s = V.status().pilot?.state; const g = s ? ground(s.x, s.y) : null; if (s && g != null && s.z - g > (R.aglM ?? 150)) break; await sleep(100); }
// level, a gentle continuous turn (stays near the start), held for long after this eval returns
V.setSticks({ throttle: 0.7, pitch: 0.05, roll: 0.25 }, 600000);
await sleep((R.holdSec ?? 30) * 1000);
const s = V.status().pilot?.state;
const g = s ? ground(s.x, s.y) : null;
return { summary: { piloting: V.piloting, agl: s && g != null ? Math.round(s.z - g) : null, pos: s ? [Math.round(s.x), Math.round(s.y), Math.round(s.z)] : null } };
