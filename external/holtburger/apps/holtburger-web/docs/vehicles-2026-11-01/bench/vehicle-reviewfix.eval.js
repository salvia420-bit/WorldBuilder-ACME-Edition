// vehicle-reviewfix.eval.js — pilot page: the 2026-11-02 server review fixes, live (decision 69).
//   1. seated + parked: a lifestone recall (TeleToLifestone) and melee mode (ChangeCombatMode 2) are refused — the body
//      stays in the seat, nothing teleports it;
//   2. exit, board again: accepted (the server never left NonCombat — a granted melee mode would refuse the board);
//   3. take off, climb, `@smite <pilot>`: the dead pilot is unseated on the world thread (seat released within seconds,
//      the server places the body on the ground), the aircraft goes derelict.
// window.__vehicleRun: {name: "+Probe 912", aglM: 90, maxSec: 180}
const R = window.__vehicleRun || {};
const V = window.__vehicles, h = window.__sessionHandle, em = window.liveScene3d.entityManager;
const out = { ok: false, checks: {}, notes: {} };
if (!V) return { ...out, fatal: "window.__vehicles missing" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const tSec = () => (performance.now() - t0) / 1000;
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const me = () => { const p = em.entityMap.get((window.getLocalPlayerGuid?.() ?? 0) >>> 0)?.root?.position; return p ? { x: p.x, y: p.y, z: p.z } : null; };
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null || !Number.isFinite(z) ? null : z; } catch (_) { return null; } };
const board = async () => {
  if (!V.nearest()) {
    const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
    if (v) {
      h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${Math.max(1, v.last.x - 4).toFixed(2)} ${v.last.y.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`);
      for (let i = 0; i < 40 && !V.nearest(); i++) await sleep(250);
      await sleep(1500);
    }
  }
  const refusals0 = V.status().stats.boardRefusals;
  V.board();
  for (let i = 0; i < 40 && !V.piloting && V.status().stats.boardRefusals === refusals0; i++) await sleep(250);
  return { piloting: V.piloting, refusal: V.status().stats.boardRefusals > refusals0 ? V.status().stats.lastRefusal : null };
};

// 1. seated + parked: recall and melee refused
const b1 = await board();
out.notes.board1 = b1;
if (!b1.piloting) return { ...out, fatal: "first board failed", status: V.status() };
await sleep(1500);
const seat0 = me();
try { h.teleToLifestone(); } catch (e) { out.notes.recallErr = String(e); }
try { h.setCombatMode(2); } catch (e) { out.notes.combatErr = String(e); }
await sleep(16000); // a lifestone recall would have teleported by now (~14 s of casting)
const seat1 = me();
out.checks.recallRefused = V.piloting && !!seat0 && !!seat1 && Math.hypot(seat1.x - seat0.x, seat1.y - seat0.y) < 3;
out.notes.seatMoveM = seat0 && seat1 ? r1(Math.hypot(seat1.x - seat0.x, seat1.y - seat0.y)) : null;

// 2. exit, board again: not refused for combat mode
V.exit(0);
for (let i = 0; i < 40 && V.piloting; i++) await sleep(250);
await sleep(2500);
const b2 = await board();
out.notes.board2 = b2;
out.checks.reboardAccepted = b2.piloting && b2.refusal == null;
if (!b2.piloting) return { ...out, fatal: "re-board failed", status: V.status() };

// 3. climb, then smite the pilot
V.setSticks({ throttle: 1 }, 60000);
for (let i = 0; i < 200; i++) { const s = V.status().pilot?.state; if (s && s.mode === 2) break; await sleep(100); }
V.setSticks({ throttle: 0.8, pitch: 0.5 }, 60000);
for (let i = 0; i < 300; i++) {
  const s = V.status().pilot?.state; if (!s) break;
  const g = ground(s.x, s.y);
  if (g != null && s.z - g > (R.aglM ?? 90)) break;
  await sleep(100);
}
V.setSticks({ throttle: 0.8, pitch: 0 }, 60000);
const sDeath = V.status().pilot?.state;
out.notes.deathAgl = sDeath ? r1(sDeath.z - (ground(sDeath.x, sDeath.y) ?? 0)) : null;
const ev0 = V.events().length;
const tSmite = tSec();
h.sendChat(`@smite ${R.name || "+Probe 912"}`);
for (let i = 0; i < 80 && V.piloting; i++) await sleep(100);
out.checks.unseatedOnDeath = !V.piloting;
out.notes.unseatSec = r1(tSec() - tSmite);
await sleep(3000);
out.notes.eventsAfterSmite = V.events().slice(ev0).map((e) => ({ name: e.name, subject: (e.subject >>> 0).toString(16), z: r1(e.z), cell: (e.cell >>> 0).toString(16) }));
const td = V.events().slice(ev0).find((e) => e.kind === 7);
out.checks.placedOnGround = !!td && td.cell !== 0;
out.notes.vehicleAfter = V.status().vehicles.map((v) => ({ guid: v.guid.toString(16), mode: v.mode }));
V.clearSticks();
await sleep(12000); // the death teleport to the lifestone
out.notes.after = me();
out.ok = true;
out.summary = { ...out.checks, unseatSec: out.notes.unseatSec, deathAgl: out.notes.deathAgl, seatMoveM: out.notes.seatMoveM };
return out;
